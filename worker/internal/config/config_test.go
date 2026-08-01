package config

import "testing"

func TestLoadRequiresAPIBaseURL(t *testing.T) {
	t.Setenv("CROWDMON_API_BASE_URL", "")

	if _, err := Load(); err == nil {
		t.Fatal("expected an error when CROWDMON_API_BASE_URL is unset")
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
