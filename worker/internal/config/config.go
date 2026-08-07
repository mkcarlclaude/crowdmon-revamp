// Package config loads worker configuration from the environment.
//
// Nothing is read from flags or files: the worker runs as a container on the
// home box, so the environment is the only configuration surface it has.
package config

import (
	"fmt"
	"os"
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
}

// TracingEnabled reports whether an exporter should be built. Config answers
// this rather than telemetry.Setup inspecting a bare string, so "tracing is
// off" is a stated condition rather than an accident of a typo.
func (c Config) TracingEnabled() bool { return c.OTLPEndpoint != "" }

// LogsEnabled reports whether the OTLP log exporter should be built. Mirrors
// TracingEnabled exactly, for the same reason.
func (c Config) LogsEnabled() bool { return c.OTLPLogsEndpoint != "" }

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
