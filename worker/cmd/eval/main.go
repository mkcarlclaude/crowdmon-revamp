// Command eval scores the zero-shot detector — or any later model — against
// the frozen evaluation pool's exhaustive ground truth (migration 0014,
// M26 #177). Plan: docs/superpowers/plans/2026-08-28-eval-harness.md §B.
//
// Run by hand, a few times a year, on the home box — not a `jobs.kind`.
// §Q21 puts training there and §Q17 makes promotion manual; evaluation sits
// on the same side of that line, and a job kind would need a migration, a
// `CHECK` widening and the claim-endpoint rollout ordering that has bitten
// this repo before (memory/crowdmon-new-job-kind-rollout-order), all to
// schedule something nobody runs unattended in v5.
//
// # Where the input comes from
//
// `GET /api/admin/eval-source` (apps/api/src/routes/admin-eval.ts) computes
// exactly this command's input — the frozen pool's ground truth and the
// predictions being measured against it — and refuses with 409 if any
// active class is not yet marked exhaustively annotated anywhere in the
// pool, so an incomplete labelling sitting cannot be silently scored. That
// route sits behind Cloudflare Access, the same gate every other
// `/api/admin/*` route does, and this command does not call it: there is no
// Access **service token** scoped to that application the way
// `otlp.mkcarl.com`'s is (CONTEXT.md §6's runbook is the pattern to follow
// if that changes), so a live fetch from an unattended home-box process has
// nowhere to put a credential today. Until that exists, an admin fetches
// the endpoint by hand from an authenticated browser session, saves the
// response, and hands it to -source. `evalSource` in source.go is a
// hand-written mirror of that endpoint's response shape rather than the
// generated client (`worker/internal/api`) for exactly that reason — there
// is no request being made for the generated client's request-building half
// to do any work on.
//
// # What it does
//
// Groups every prediction and every ground-truth box by class name and
// hands each class to `eval.Score`, then prints the report as JSON and
// optionally writes it to a file. Plan §B3: no `model_versions` row — that
// table is M27's, once there is a version to register — so nothing here
// touches D1 at all.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/eval"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "eval:", err)
		os.Exit(1)
	}
}

// run is separated from main the way `cmd/worker`'s is: everything that can
// fail returns an error instead of calling os.Exit directly, so a test can
// drive it without killing the test binary.
func run(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("eval", flag.ContinueOnError)
	source := fs.String("source", "", "path to a GET /api/admin/eval-source response saved to disk (required)")
	out := fs.String("out", "", "path to also write the report JSON (optional — it is always printed)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *source == "" {
		return fmt.Errorf("-source is required: a GET /api/admin/eval-source response, saved to disk (see this command's own doc comment)")
	}

	data, err := os.ReadFile(*source)
	if err != nil {
		return fmt.Errorf("reading %s: %w", *source, err)
	}

	var src evalSource
	if err := json.Unmarshal(data, &src); err != nil {
		return fmt.Errorf("parsing %s as an eval-source response: %w", *source, err)
	}

	report := eval.Score(classSets(src))

	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding the report: %w", err)
	}
	encoded = append(encoded, '\n')

	if _, err := stdout.Write(encoded); err != nil {
		return fmt.Errorf("writing the report to stdout: %w", err)
	}

	if *out != "" {
		// 0o644, not 0o600: this is a metrics summary with no annotator
		// identity in it (unlike `.d1-backups/`, CLAUDE.md's own warning),
		// meant to sit beside a snapshot and be read by whoever looks.
		if err := os.WriteFile(*out, encoded, 0o644); err != nil {
			return fmt.Errorf("writing %s: %w", *out, err)
		}
	}

	return nil
}
