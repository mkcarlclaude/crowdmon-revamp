// Package api holds the Go view of the wire contract: the types, and since
// M4.3 the client that speaks them.
//
// Everything in types.gen.go is generated from apps/api/openapi.json, which is
// itself generated from the zod schemas that validate requests at the edge.
// Nothing here is written by hand: the whole point (CONTEXT.md §Q24) is that
// the two runtimes cannot disagree about a field name, because only one of
// them defines it.
//
// One rule the generator imposes back on the contract: it owns the
// `<OperationId>Response` namespace, generating one such wrapper type per
// operation. A schema whose name collides with one — `SubmitVideoResponse`
// against the `submitVideo` operation — stops this package compiling, which
// is why the submit endpoint's response schema is named `VideoSubmission`.
//
// Regenerate after any contract change:
//
//	cd worker && go generate ./...
//
// CI runs the same command and fails if the result differs from what is
// committed, so a spec change that skips this step cannot merge.
package api

// The generator version is pinned in the directive rather than added to
// go.mod. `go run pkg@version` builds in its own module, so the code
// generator itself never becomes a dependency of the binary that ships to the
// home box. Its *runtime* package is a different matter and does ship — that
// is the price of the generated client, paid knowingly in M4.3.
//
//go:generate go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0 -config oapi-codegen.yaml ../../../apps/api/openapi.json
