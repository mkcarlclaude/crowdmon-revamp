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
	// AccessClientID and AccessClientSecret are the Access service token that
	// gets an export past the gate in front of the collector.
	AccessClientID     string
	AccessClientSecret string
	// SimulatedWork makes a claimed job take this long instead of completing
	// immediately. Zero — the default, and the only value production should
	// ever run with — leaves Runner.Work nil.
	//
	// It exists for M6.4. Verifying that killing a worker mid-job produces a
	// reap and a retry needs a job with a middle to be killed in, and until
	// M7 lands extraction there is none: a job completes in about 90ms. The
	// alternative was seeding a stale `claimed` row straight into D1, which
	// tests the reaper but proves nothing about what a killed worker leaves
	// behind — and what it leaves behind is the whole question.
	//
	// M7 replaces this with real work and it goes away.
	SimulatedWork time.Duration
}

// TracingEnabled reports whether an exporter should be built. Config answers
// this rather than telemetry.Setup inspecting a bare string, so "tracing is
// off" is a stated condition rather than an accident of a typo.
func (c Config) TracingEnabled() bool { return c.OTLPEndpoint != "" }

// Load reads configuration from the environment, applying defaults where a
// missing value is not an error. It returns an error rather than exiting so
// callers decide how a misconfigured worker should fail.
func Load() (Config, error) {
	cfg := Config{
		APIBaseURL:         os.Getenv("CROWDMON_API_BASE_URL"),
		Environment:        envOrDefault("CROWDMON_ENV", "development"),
		WorkerID:           os.Getenv("CROWDMON_WORKER_ID"),
		OTLPEndpoint:       os.Getenv("CROWDMON_OTLP_ENDPOINT"),
		AccessClientID:     os.Getenv("CF_ACCESS_CLIENT_ID"),
		AccessClientSecret: os.Getenv("CF_ACCESS_CLIENT_SECRET"),
	}

	if cfg.APIBaseURL == "" {
		return Config{}, fmt.Errorf("CROWDMON_API_BASE_URL is required")
	}

	// Parsed rather than defaulted on error. "90" instead of "90s" would
	// otherwise leave the worker completing jobs instantly during an M6.4
	// verification run, and the run would report that the reaper never
	// fired — which is the very conclusion it exists to test.
	if raw := os.Getenv("CROWDMON_SIMULATED_WORK"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil {
			return Config{}, fmt.Errorf("CROWDMON_SIMULATED_WORK is not a duration: %w", err)
		}
		if d < 0 {
			return Config{}, fmt.Errorf("CROWDMON_SIMULATED_WORK must not be negative, got %s", raw)
		}
		cfg.SimulatedWork = d
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
	// omitting these is spans that never arrive, noticed days later.
	if cfg.TracingEnabled() && (cfg.AccessClientID == "" || cfg.AccessClientSecret == "") {
		return Config{}, fmt.Errorf(
			"CROWDMON_OTLP_ENDPOINT is set, so CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required")
	}

	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
