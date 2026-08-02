// Package api holds the Go view of the wire contract.
//
// Every type in types.gen.go is generated from apps/api/openapi.json, which is
// itself generated from the zod schemas that validate requests at the edge.
// Nothing here is written by hand: the whole point (CONTEXT.md §Q24) is that
// the two runtimes cannot disagree about a field name, because only one of
// them defines it.
//
// Regenerate after any contract change:
//
//	cd worker && go generate ./...
//
// CI runs the same command and fails if the result differs from what is
// committed, so a spec change that skips this step cannot merge.
package api

// The generator version is pinned in the directive rather than added to
// go.mod. `go run pkg@version` builds in its own module, so a code-generation
// tool never becomes a dependency of the binary that ships to the home box —
// and the worker keeps no go.sum until it takes a real dependency in M4.
//
//go:generate go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0 -config oapi-codegen.yaml ../../../apps/api/openapi.json
