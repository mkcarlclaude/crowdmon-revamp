package config

import (
	"os"
	"strings"
	"testing"
)

// The work directory is named in four places: this package's default, the
// Dockerfile that creates it as the unprivileged user, the compose file that
// mounts a volume over it, and .env.example. Nothing at runtime notices when
// they disagree — the container starts, downloads land somewhere, and the
// symptom arrives on the next `docker compose up` as chunk jobs reporting
// M7.4's affinity failure on a box that downloaded the video perfectly.
//
// The same argument as `wrangler-config.test.ts` on the API side: a coupling
// that is only documented is a coupling that breaks quietly.

func TestTheImageCreatesTheDefaultWorkDir(t *testing.T) {
	dockerfile := readRepoFile(t, "../../Dockerfile")

	// Created in the image so that Docker seeds the named volume with the
	// `worker` user's ownership. Absent, the volume is created root-owned and
	// every download fails with permission denied.
	if !strings.Contains(dockerfile, "mkdir -p "+DefaultWorkDir) {
		t.Errorf("worker/Dockerfile does not create %s as the worker user", DefaultWorkDir)
	}
}

func TestTheComposeFileMountsTheDefaultWorkDir(t *testing.T) {
	compose := readRepoFile(t, "../../../deploy/homebox/docker-compose.yml")

	// Without a volume here, the update timer's four recreations a day throw
	// away every video whose chunk jobs have not run yet.
	if !strings.Contains(compose, ":"+DefaultWorkDir) {
		t.Errorf("deploy/homebox/docker-compose.yml mounts nothing at %s", DefaultWorkDir)
	}
}

func readRepoFile(t *testing.T, path string) string {
	t.Helper()

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(content)
}
