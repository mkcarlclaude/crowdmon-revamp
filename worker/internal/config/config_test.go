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

// Logs mirror tracing exactly: optional, and off by default so a dev run has
// nothing to configure.
func TestLoadTreatsLogsAsOptional(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_OTLP_LOGS_ENDPOINT", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if cfg.LogsEnabled() {
		t.Error("LogsEnabled() = true with no OTLP logs endpoint configured")
	}
}

func TestLoadRejectsAnOTLPLogsEndpointWithNoAccessCredentials(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_OTLP_LOGS_ENDPOINT", "https://otlp.example.com/v1/logs")
	t.Setenv("CF_ACCESS_CLIENT_ID", "")
	t.Setenv("CF_ACCESS_CLIENT_SECRET", "")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error when an OTLP logs endpoint is set without Access credentials")
	}
}

// Traces and logs share one token (CONTEXT.md §6), so either one configured
// alone is enough to require it — not just both together.
func TestLoadRequiresAccessCredentialsForLogsEvenWithTracingDisabled(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_OTLP_ENDPOINT", "")
	t.Setenv("CROWDMON_OTLP_LOGS_ENDPOINT", "https://otlp.example.com/v1/logs")
	t.Setenv("CF_ACCESS_CLIENT_ID", "id.access")
	t.Setenv("CF_ACCESS_CLIENT_SECRET", "secret")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}
	if !cfg.LogsEnabled() {
		t.Error("LogsEnabled() = false with an OTLP logs endpoint configured")
	}
	if cfg.TracingEnabled() {
		t.Error("TracingEnabled() = true with no OTLP traces endpoint configured")
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

// R2Bucket defaults to the bucket infra/main.tf actually creates, and
// DedupThreshold defaults to zero — "let frames.Config decide" — rather than
// a number restated here (M8.3).
func TestLoadDefaultsR2BucketAndDedupThreshold(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_R2_BUCKET", "")
	t.Setenv("CROWDMON_DEDUP_THRESHOLD", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if cfg.R2Bucket != DefaultR2Bucket {
		t.Errorf("R2Bucket = %q, want %q", cfg.R2Bucket, DefaultR2Bucket)
	}
	if cfg.DedupThreshold != 0 {
		t.Errorf("DedupThreshold = %d, want 0 (frames.Config decides)", cfg.DedupThreshold)
	}
	if cfg.UploadsEnabled() {
		t.Error("UploadsEnabled() = true with no R2 credentials configured")
	}
}

// A malformed threshold has to fail loudly. Falling back to the zero value on
// a parse error would look identical to "unconfigured," and the two mean
// different things downstream once frames.Config.Threshold() is in the
// picture: this is a mistake to report now, not a dataset in a silently
// different dedup regime for M8.4 to puzzle over later.
func TestLoadRejectsAnUnparseableDedupThreshold(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_DEDUP_THRESHOLD", "not-a-number")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error for a non-integer CROWDMON_DEDUP_THRESHOLD")
	}
}

// Negative is rejected too: frames.Config.Threshold() treats <=0 as "use the
// default," so a negative value would silently collapse to the same default a
// typo'd zero would, and the operator would have no way to tell the two apart.
func TestLoadRejectsANegativeDedupThreshold(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_DEDUP_THRESHOLD", "-1")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error for a negative CROWDMON_DEDUP_THRESHOLD")
	}
}

func TestLoadReadsAPositiveDedupThreshold(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_DEDUP_THRESHOLD", "14")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}
	if cfg.DedupThreshold != 14 {
		t.Errorf("DedupThreshold = %d, want 14", cfg.DedupThreshold)
	}
}

// PrelabelSampleSize defaults to zero — "let sample.Sampler decide" — rather
// than a number restated here, the same idiom DedupThreshold uses for
// frames.Config (M11.3).
func TestLoadDefaultsPrelabelSampleSize(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_PRELABEL_SAMPLE_SIZE", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if cfg.PrelabelSampleSize != 0 {
		t.Errorf("PrelabelSampleSize = %d, want 0 (sample.Sampler decides)", cfg.PrelabelSampleSize)
	}
}

// A malformed size has to fail loudly, for the same reason a malformed
// CROWDMON_DEDUP_THRESHOLD does: falling back to zero on a parse error would
// look identical to "unconfigured," and the two mean different things once
// sample.Sampler.Budget is in the picture.
func TestLoadRejectsAnUnparseablePrelabelSampleSize(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_PRELABEL_SAMPLE_SIZE", "not-a-number")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error for a non-integer CROWDMON_PRELABEL_SAMPLE_SIZE")
	}
}

// Negative is rejected too: sample.Sampler.Budget would otherwise treat it
// the same as the default a typo'd zero produces, and the operator would have
// no way to tell "unconfigured" and "configured incorrectly" apart.
func TestLoadRejectsANegativePrelabelSampleSize(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_PRELABEL_SAMPLE_SIZE", "-1")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error for a negative CROWDMON_PRELABEL_SAMPLE_SIZE")
	}
}

func TestLoadReadsAPositivePrelabelSampleSize(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_PRELABEL_SAMPLE_SIZE", "500")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}
	if cfg.PrelabelSampleSize != 500 {
		t.Errorf("PrelabelSampleSize = %d, want 500", cfg.PrelabelSampleSize)
	}
}

// R2 is fail-closed on partial configuration (M8.3): a chunk job that
// silently skipped its upload because one of three required values was
// missing would report success while writing nothing to R2.
func TestLoadRejectsPartialR2Credentials(t *testing.T) {
	cases := []struct {
		name            string
		accountID       string
		accessKeyID     string
		secretAccessKey string
	}{
		{"only account id", "acct", "", ""},
		{"only access key", "", "key", ""},
		{"only secret", "", "", "secret"},
		{"missing secret", "acct", "key", ""},
		{"missing access key", "acct", "", "secret"},
		{"missing account id", "", "key", "secret"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
			t.Setenv("CROWDMON_R2_ACCOUNT_ID", tc.accountID)
			t.Setenv("CROWDMON_R2_ACCESS_KEY_ID", tc.accessKeyID)
			t.Setenv("CROWDMON_R2_SECRET_ACCESS_KEY", tc.secretAccessKey)

			if _, err := Load(); err == nil {
				t.Fatalf("expected an error for partial R2 credentials (%s)", tc.name)
			}
		})
	}
}

// The detector is optional exactly as tracing and R2 uploads are (M11.2): a
// worker with no CROWDMON_DETECTOR_BASE_URL still has to run download and
// chunk jobs, so an unset value must not be an error.
func TestLoadTreatsTheDetectorAsOptional(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_DETECTOR_BASE_URL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}
	if cfg.DetectorEnabled() {
		t.Error("DetectorEnabled() = true with no detector base url configured")
	}
}

func TestLoadCarriesTheDetectorBaseURL(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_DETECTOR_BASE_URL", "http://crowdmon-detector:8080")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}
	if !cfg.DetectorEnabled() {
		t.Error("DetectorEnabled() = false with a detector base url configured")
	}
	if cfg.DetectorBaseURL != "http://crowdmon-detector:8080" {
		t.Errorf("DetectorBaseURL = %q, want http://crowdmon-detector:8080", cfg.DetectorBaseURL)
	}
}

func TestLoadCarriesCompleteR2Credentials(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "https://api.example.com")
	t.Setenv("CROWDMON_R2_ACCOUNT_ID", "acct")
	t.Setenv("CROWDMON_R2_ACCESS_KEY_ID", "key")
	t.Setenv("CROWDMON_R2_SECRET_ACCESS_KEY", "secret")
	t.Setenv("CROWDMON_R2_BUCKET", "crowdmon-frames-test")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() returned an unexpected error: %v", err)
	}

	if !cfg.UploadsEnabled() {
		t.Error("UploadsEnabled() = false with complete R2 credentials configured")
	}
	if cfg.R2AccountID != "acct" || cfg.R2AccessKeyID != "key" || cfg.R2SecretAccessKey != "secret" {
		t.Errorf("R2 credentials = %q/%q/%q, want acct/key/secret", cfg.R2AccountID, cfg.R2AccessKeyID, cfg.R2SecretAccessKey)
	}
	if cfg.R2Bucket != "crowdmon-frames-test" {
		t.Errorf("R2Bucket = %q, want crowdmon-frames-test", cfg.R2Bucket)
	}
}
