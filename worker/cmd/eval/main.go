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
// exactly this command's input: the ground truth and predictions for every
// frozen-pool image marked exhaustively annotated for every active class.
// An image not yet marked that way is simply absent from the response, not
// scored as if it were empty — see that route's own doc comment for why
// the gate is per image rather than all-or-nothing across the pool (the
// production pool is 2,298 images; the plan's "95 images... in a single
// sitting" was the count of labelled images, not the pool). It refuses
// with 409 only when nothing has been marked at all, i.e. there would be
// nothing for this command to score. That route sits behind Cloudflare
// Access, the same gate every other `/api/admin/*` route does, and this
// command does not call it: there is no Access **service token** scoped to
// that application the way `otlp.mkcarl.com`'s is (CONTEXT.md §6's runbook
// is the pattern to follow if that changes), so a live fetch from an
// unattended home-box process has nowhere to put a credential today. Until
// that exists, an admin fetches the endpoint by hand from an authenticated
// browser session, saves the response, and hands it to -source.
// `evalSource` in source.go is a hand-written mirror of that endpoint's
// response shape rather than the generated client (`worker/internal/api`)
// for exactly that reason — there is no request being made for the
// generated client's request-building half to do any work on.
//
// # What it does
//
// Groups every prediction and every ground-truth box by class name and
// hands each class to `eval.Score`, then prints the report as JSON and
// optionally writes it to a file. The report also names exactly which
// image ids it was computed from (`report.ScoredImageIDs` below) — because
// the scored set can grow between two runs now that it is defined by
// whatever has been annotated, that is what lets a later run claim it
// scored the same set rather than assuming it. Plan §B3: no
// `model_versions` row — that table is M27's, once there is a version to
// register — so nothing here touches D1 at all.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/eval"
)

// report is the artifact this command prints and, with -out, writes to
// disk: `eval.Score`'s output plus which images it was computed from.
//
// **`ScoredImageIDs` and `ScoredImageCount` are not incidental metadata —
// they are what replaced the guarantee the old all-or-nothing gate at
// `GET /api/admin/eval-source` used to make for free.** That gate refused
// to run at all until the whole frozen pool was annotated, so any two runs
// that succeeded were, by construction, scored against the identical
// complete set — comparability was a precondition nobody had to check.
// The gate is per image now (this command's own doc comment above), which
// means the scored set can grow between one run and the next as more of
// the pool gets annotated. A later mAP number is only comparable to this
// one if both were computed from the same images, and the only way to
// know that is for both reports to say so. Recording the set here is what
// lets M27 — or a human — make that comparison rather than assume it.
type report struct {
	eval.Report
	ScoredImageIDs   []int `json:"scored_image_ids"`
	ScoredImageCount int   `json:"scored_image_count"`
}

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

	scored := scoredImageIDs(src)
	artifact := report{
		Report:           eval.Score(classSets(src)),
		ScoredImageIDs:   scored,
		ScoredImageCount: len(scored),
	}

	encoded, err := json.MarshalIndent(artifact, "", "  ")
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
