// Command worker is the home-side extraction worker.
//
// It is a skeleton: the poll loop, OTel setup and the extraction pipeline land
// in M4. For now it loads configuration and exits, which is enough for CI to
// prove the Go toolchain builds and the container has something to run.
package main

import (
	"log"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("configuration error: %v", err)
	}

	log.Printf("crowdmon worker starting: env=%s api=%s", cfg.Environment, cfg.APIBaseURL)
	log.Print("no work to do yet — the poll loop lands in M4.2")
}
