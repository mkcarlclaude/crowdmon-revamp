// Package config loads worker configuration from the environment.
//
// Nothing is read from flags or files: the worker runs as a container on the
// home box, so the environment is the only configuration surface it has.
package config

import (
	"fmt"
	"os"
)

// Config is the worker's runtime configuration. It grows in M4.1; for now it
// carries only what a build-and-run smoke check needs.
type Config struct {
	// APIBaseURL is the Workers API the worker long-polls for jobs.
	APIBaseURL string
	// Environment names the deployment, and is attached to telemetry in M4.1.
	Environment string
}

// Load reads configuration from the environment, applying defaults where a
// missing value is not an error. It returns an error rather than exiting so
// callers decide how a misconfigured worker should fail.
func Load() (Config, error) {
	cfg := Config{
		APIBaseURL:  os.Getenv("CROWDMON_API_BASE_URL"),
		Environment: envOrDefault("CROWDMON_ENV", "development"),
	}

	if cfg.APIBaseURL == "" {
		return Config{}, fmt.Errorf("CROWDMON_API_BASE_URL is required")
	}

	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
