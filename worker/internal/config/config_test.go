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

// M6.4 needs a job that lasts long enough to kill the container in the middle
// of it. Until M7 lands extraction, Runner.Work is nil and a job completes in
// under 100ms, so there is no middle to interrupt.
func TestLoadTreatsSimulatedWorkAsOptional(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_SIMULATED_WORK", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if cfg.SimulatedWork != 0 {
		t.Errorf("SimulatedWork = %v, want the zero duration", cfg.SimulatedWork)
	}
}

func TestLoadReadsSimulatedWorkAsADuration(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_SIMULATED_WORK", "90s")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if cfg.SimulatedWork != 90*time.Second {
		t.Errorf("SimulatedWork = %v, want 90s", cfg.SimulatedWork)
	}
}

// Fail rather than fall back to zero. A verification run configured with
// "90" instead of "90s" would otherwise complete instantly and look like the
// reaper never fired, which is the exact conclusion the run exists to test.
func TestLoadRejectsAnUnparseableSimulatedWork(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_SIMULATED_WORK", "90")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error for a duration with no unit")
	}
}
