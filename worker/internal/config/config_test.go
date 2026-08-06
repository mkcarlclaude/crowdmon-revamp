package config

import (
	"os"
	"testing"
	"time"
)

func TestLoadRequiresAPIBaseURL(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error when CROWDMON_API_BASE_URL is unset")
	}
}

func TestLoadDefaultsWorkerIDToHostname(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_WORKER_ID", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	hostname, err := os.Hostname()
	if err != nil {
		t.Skipf("hostname unavailable on this machine: %v", err)
	}
	if cfg.WorkerID != hostname {
		t.Errorf("WorkerID = %q, want the hostname %q", cfg.WorkerID, hostname)
	}
}

func TestLoadTakesWorkerIDFromEnvironment(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_WORKER_ID", "carls-ubuntu-2")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if cfg.WorkerID != "carls-ubuntu-2" {
		t.Errorf("WorkerID = %q, want %q", cfg.WorkerID, "carls-ubuntu-2")
	}
}

// Tracing is optional so `go run ./cmd/worker` works with no collector in
// reach. The zero endpoint has to be distinguishable from a configured one,
// because the difference decides whether Setup exports or no-ops.
func TestLoadTreatsTracingAsOptional(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_OTLP_ENDPOINT", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if cfg.TracingEnabled() {
		t.Error("TracingEnabled() = true with no OTLP endpoint configured")
	}
}

// The Access headers are what gets the span past the gate on otlp.mkcarl.com
// (CONTEXT.md §6). Exporting without them reaches Access, not the collector,
// and the failure surfaces as spans that silently never arrive — so a
// configured endpoint with no credentials is rejected at startup instead.
func TestLoadRejectsAnOTLPEndpointWithNoAccessCredentials(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_OTLP_ENDPOINT", "https://otlp.example.com/v1/traces")
	t.Setenv("CF_ACCESS_CLIENT_ID", "")
	t.Setenv("CF_ACCESS_CLIENT_SECRET", "")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error when an OTLP endpoint is set without Access credentials")
	}
}

func TestLoadCarriesTheAccessCredentials(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_OTLP_ENDPOINT", "https://otlp.example.com/v1/traces")
	t.Setenv("CF_ACCESS_CLIENT_ID", "id.access")
	t.Setenv("CF_ACCESS_CLIENT_SECRET", "secret")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if !cfg.TracingEnabled() {
		t.Error("TracingEnabled() = false with an OTLP endpoint configured")
	}
	if cfg.AccessClientID != "id.access" || cfg.AccessClientSecret != "secret" {
		t.Errorf("Access credentials = %q/%q, want id.access/secret", cfg.AccessClientID, cfg.AccessClientSecret)
	}
}

func TestLoadDefaultsEnvironment(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_ENV", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if cfg.Environment != "development" {
		t.Errorf("Environment = %q, want %q", cfg.Environment, "development")
	}
	if cfg.APIBaseURL != "https://api.example.com" {
		t.Errorf("APIBaseURL = %q, want %q", cfg.APIBaseURL, "https://api.example.com")
	}
}

func TestLoadDefaultsTheWorkDirAndTTL(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_WORK_DIR", "")
	t.Setenv("CROWDMON_SOURCE_TTL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	// Defaulted rather than required: every deployment wants the same answer,
	// and a worker that refused to start without them would make the container
	// harder to run for no decision anybody has to make.
	if cfg.WorkDir != DefaultWorkDir {
		t.Errorf("WorkDir = %q, want %q", cfg.WorkDir, DefaultWorkDir)
	}
	if cfg.SourceTTL != DefaultSourceTTL {
		t.Errorf("SourceTTL = %v, want %v", cfg.SourceTTL, DefaultSourceTTL)
	}
}

func TestLoadReadsTheWorkDirAndTTL(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_WORK_DIR", "/mnt/videos")
	t.Setenv("CROWDMON_SOURCE_TTL", "90m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if cfg.WorkDir != "/mnt/videos" {
		t.Errorf("WorkDir = %q, want /mnt/videos", cfg.WorkDir)
	}
	if cfg.SourceTTL != 90*time.Minute {
		t.Errorf("SourceTTL = %v, want 90m", cfg.SourceTTL)
	}
}

// Fail rather than fall back to the default. "6" instead of "6h" parses as six
// nanoseconds, which would delete every source video the moment the next
// download pruned — and every chunk job would then report the affinity failure
// M7.4 exists to report about a genuinely misplaced file.
func TestLoadRejectsAnUnparseableSourceTTL(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_SOURCE_TTL", "6")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error for a duration with no unit")
	}
}
