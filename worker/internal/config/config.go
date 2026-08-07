// Package config loads worker configuration from the environment.
//
// Nothing is read from flags or files: the worker runs as a container on the
// home box, so the environment is the only configuration surface it has.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// ServiceName is what this process calls itself in telemetry. A constant
// rather than an environment variable: two deployments of the same binary are
// told apart by Environment and WorkerID, and a service name that varied per
// host would split one service into several in Tempo.
const ServiceName = "crowdmon-worker"

// DefaultWorkDir is where source videos land. Under the container's home
// directory because the image runs as an unprivileged user that owns nothing
// else, and a path it cannot create is a worker that fails every download.
const DefaultWorkDir = "/home/worker/videos"

// DefaultSourceTTL is how long a downloaded video is kept.
//
// Six hours against a video that takes 10-20 minutes to drain its chunk jobs:
// long enough that nothing is ever pruned out from under work in flight, short
// enough that a day of submissions cannot fill the disk. The number is
// deliberately not tuned tighter — the failure it would cause (a chunk job
// whose source vanished) looks exactly like the affinity failure M7.4 exists
// to report, and the two would be indistinguishable in the dashboard.
const DefaultSourceTTL = 6 * time.Hour

// DefaultR2Bucket matches `${var.project_name}-frames` in infra/main.tf. The
// bucket name is the resource's identity there (infra/README.md: it survives
// a destroy/re-apply where the D1 database id does not), so it is safe to
// bake in as a default rather than force every deployment to restate it.
const DefaultR2Bucket = "crowdmon-frames"

// Config is the worker's runtime configuration.
type Config struct {
	// APIBaseURL is the Workers API the worker polls for jobs. Point this at
	// the custom domain rather than workers.dev — the Access application
	// covers the former only.
	APIBaseURL string
	// Environment names the deployment and is attached to every span.
	Environment string
	// WorkerID identifies this process to the queue. It is the lease holder:
	// heartbeat and complete are rejected unless it matches the claim, so two
	// workers sharing one value can close each other's jobs.
	WorkerID string
	// OTLPEndpoint is the collector's OTLP *HTTP* traces URL, path included.
	// Empty disables tracing.
	OTLPEndpoint string
	// OTLPLogsEndpoint is the collector's OTLP *HTTP* logs URL, path included.
	// Empty disables log export — the JSON stdout handler still runs either
	// way, so a worker with this unset behaves exactly as it did before Loki
	// wiring existed. Separate from OTLPEndpoint rather than one endpoint with
	// two paths appended in code: the collector fronts both at the same host
	// today, but nothing requires that, and a struct field is cheaper to keep
	// correct than a string-surgery assumption.
	OTLPLogsEndpoint string
	// AccessClientID and AccessClientSecret are the Access service token that
	// gets an export past the gate in front of the collector. Shared by
	// traces and logs — one token, one Access application, per CONTEXT.md §6.
	AccessClientID     string
	AccessClientSecret string
	// WorkDir is where downloaded source videos live (M7.1). Chunk jobs read
	// the file the download left there, so this directory *is* the affinity
	// constraint (CONTEXT.md §Q13): a second worker with its own copy of this
	// path would claim chunk jobs whose video it does not have.
	//
	// Inside the container by default, which means a video does not survive a
	// `docker compose up` unless the path is a volume — see
	// deploy/homebox/docker-compose.yml, where it is one.
	WorkDir string
	// SourceTTL is how long a downloaded video is kept. Source video is never
	// uploaded to R2 (CONTEXT.md §Q13) and is far larger than the frames taken
	// from it, so nothing else bounds the disk it sits on.
	//
	// Comfortably longer than a video's chunk jobs take to drain: pruning a
	// file out from under a pending chunk turns a working video into M7.4's
	// clean failure for no reason.
	SourceTTL time.Duration
	// R2AccountID selects the R2 S3-compatible endpoint: `https://<id>.r2.
	// cloudflarestorage.com` (M8.3). R2 has no region concept the way S3
	// does, so this — not a region string — is what actually routes an
	// upload to the right account.
	R2AccountID string
	// R2Bucket is the frames bucket (infra/main.tf's `cloudflare_r2_bucket.
	// frames`). Defaulted rather than required: every deployment names the
	// same bucket, and requiring it restated would just be one more place for
	// a typo to silently create a second bucket if it were ever mistyped as a
	// Terraform variable, R2 not rejecting an unknown name the way D1 would
	// reject an unknown database id.
	R2Bucket string
	// R2AccessKeyID and R2SecretAccessKey are the S3-compatible API token
	// minted by hand from the R2 dashboard (infra/README.md), scoped to
	// R2Bucket only. Not a Terraform resource, for the same reason the
	// state-bucket token isn't: Terraform would have to hold the secret that
	// authenticates it to itself.
	R2AccessKeyID     string
	R2SecretAccessKey string
	// DedupThreshold is passed straight through to frames.Config.
	// DedupThreshold. Zero means "let the frames package decide"
	// (frames.DefaultDedupThreshold) rather than a number restated here:
	// config deliberately does not import frames (that would risk a cycle
	// once frames needs anything from config), so the only way to avoid two
	// packages agreeing on 10 today and disagreeing after one of them is
	// edited tomorrow is to have exactly one of them own the number. This
	// package owns the environment variable name; frames owns the value.
	DedupThreshold int
}

// TracingEnabled reports whether an exporter should be built. Config answers
// this rather than telemetry.Setup inspecting a bare string, so "tracing is
// off" is a stated condition rather than an accident of a typo.
func (c Config) TracingEnabled() bool { return c.OTLPEndpoint != "" }

// LogsEnabled reports whether the OTLP log exporter should be built. Mirrors
// TracingEnabled exactly, for the same reason.
func (c Config) LogsEnabled() bool { return c.OTLPLogsEndpoint != "" }

// UploadsEnabled reports whether a frames.Uploader should be built. Checking
// only R2AccountID, like TracingEnabled checks only its one endpoint, is
// enough: Load fails closed on a partially set R2 credential (below), so by
// the time a Config exists R2AccountID is either empty alongside the other
// two or set alongside them.
func (c Config) UploadsEnabled() bool { return c.R2AccountID != "" }

// Load reads configuration from the environment, applying defaults where a
// missing value is not an error. It returns an error rather than exiting so
// callers decide how a misconfigured worker should fail.
func Load() (Config, error) {
	cfg := Config{
		APIBaseURL:         os.Getenv("CROWDMON_API_BASE_URL"),
		Environment:        envOrDefault("CROWDMON_ENV", "development"),
		WorkerID:           os.Getenv("CROWDMON_WORKER_ID"),
		OTLPEndpoint:       os.Getenv("CROWDMON_OTLP_ENDPOINT"),
		OTLPLogsEndpoint:   os.Getenv("CROWDMON_OTLP_LOGS_ENDPOINT"),
		AccessClientID:     os.Getenv("CF_ACCESS_CLIENT_ID"),
		AccessClientSecret: os.Getenv("CF_ACCESS_CLIENT_SECRET"),
		WorkDir:            envOrDefault("CROWDMON_WORK_DIR", DefaultWorkDir),
		SourceTTL:          DefaultSourceTTL,
		R2AccountID:        os.Getenv("CROWDMON_R2_ACCOUNT_ID"),
		R2Bucket:           envOrDefault("CROWDMON_R2_BUCKET", DefaultR2Bucket),
		R2AccessKeyID:      os.Getenv("CROWDMON_R2_ACCESS_KEY_ID"),
		R2SecretAccessKey:  os.Getenv("CROWDMON_R2_SECRET_ACCESS_KEY"),
	}

	if cfg.APIBaseURL == "" {
		return Config{}, fmt.Errorf("CROWDMON_API_BASE_URL is required")
	}

	// Parsed rather than defaulted on error, for the same reason the reaper's
	// thresholds throw: "6" instead of "6h" would otherwise silently become a
	// TTL of six nanoseconds, and every chunk job would find its source video
	// already deleted — M7.4's clean failure firing on a healthy box.
	if raw := os.Getenv("CROWDMON_SOURCE_TTL"); raw != "" {
		ttl, err := time.ParseDuration(raw)
		if err != nil {
			return Config{}, fmt.Errorf("CROWDMON_SOURCE_TTL is not a duration: %w", err)
		}
		if ttl < 0 {
			return Config{}, fmt.Errorf("CROWDMON_SOURCE_TTL must not be negative, got %s", raw)
		}
		cfg.SourceTTL = ttl
	}

	// Parsed and range-checked rather than defaulted on error, for the same
	// reason CROWDMON_SOURCE_TTL is. It would be tempting to let a parse
	// failure fall back to the zero value here, since zero already means
	// "use frames.DefaultDedupThreshold" — but that makes CROWDMON_
	// DEDUP_THRESHOLD=banana behave identically to leaving it unset, and an
	// operator who set it to something never gets told their something was
	// wrong. A negative value is rejected for the mirror-image reason:
	// frames.Config.Threshold() treats <=0 as "use the default", so letting a
	// negative number through would make it collapse to the same default an
	// absent value produces, and the two mean different things — one is "I
	// didn't configure this," the other is "I configured this incorrectly."
	if raw := os.Getenv("CROWDMON_DEDUP_THRESHOLD"); raw != "" {
		threshold, err := strconv.Atoi(raw)
		if err != nil {
			return Config{}, fmt.Errorf("CROWDMON_DEDUP_THRESHOLD is not an integer: %w", err)
		}
		if threshold < 0 {
			return Config{}, fmt.Errorf("CROWDMON_DEDUP_THRESHOLD must not be negative, got %d", threshold)
		}
		cfg.DedupThreshold = threshold
	}

	// R2 is fail-closed on partial configuration, the same argument as the
	// Access credentials below: a chunk job that silently skipped its upload
	// because one of three required values was missing would report success
	// while writing nothing to R2, and that gap is invisible until someone
	// notices the bucket is short frames a job claimed to have produced.
	if cfg.R2AccountID != "" || cfg.R2AccessKeyID != "" || cfg.R2SecretAccessKey != "" {
		var missing []string
		if cfg.R2AccountID == "" {
			missing = append(missing, "CROWDMON_R2_ACCOUNT_ID")
		}
		if cfg.R2AccessKeyID == "" {
			missing = append(missing, "CROWDMON_R2_ACCESS_KEY_ID")
		}
		if cfg.R2SecretAccessKey == "" {
			missing = append(missing, "CROWDMON_R2_SECRET_ACCESS_KEY")
		}
		if len(missing) > 0 {
			return Config{}, fmt.Errorf("R2 is partially configured: missing %s", strings.Join(missing, ", "))
		}
	}

	// The hostname is the right default because a container's hostname is its
	// short container id: unique per replica, and new on every recreate, so a
	// lease held by a previous incarnation can never be mistaken for this
	// one's.
	if cfg.WorkerID == "" {
		hostname, err := os.Hostname()
		if err != nil {
			return Config{}, fmt.Errorf("CROWDMON_WORKER_ID is unset and the hostname is unreadable: %w", err)
		}
		cfg.WorkerID = hostname
	}

	// Fail closed rather than export without the headers. Access answers an
	// unauthenticated export with a redirect to its login page, which an OTLP
	// exporter reports as an ordinary HTTP failure — so the symptom of
	// omitting these is spans (or log records) that never arrive, noticed
	// days later.
	if (cfg.TracingEnabled() || cfg.LogsEnabled()) && (cfg.AccessClientID == "" || cfg.AccessClientSecret == "") {
		return Config{}, fmt.Errorf(
			"CROWDMON_OTLP_ENDPOINT or CROWDMON_OTLP_LOGS_ENDPOINT is set, so " +
				"CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required")
	}

	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
