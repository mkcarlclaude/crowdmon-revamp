/**
 * The document metadata, kept apart from the routes so the served spec and the
 * committed `openapi.json` are generated from one object. Two copies of this
 * config is how the file on disk and the endpoint quietly stop agreeing.
 */
export const openApiConfig = {
  // 3.0.3, not 3.1. oapi-codegen (M3.3) is a 3.0 generator; its 3.1 support is
  // partial, and the spec is only worth emitting if the Go side can consume it.
  // Nothing here needs a 3.1-only construct.
  openapi: "3.0.3",
  info: {
    version: "0.1.0",
    title: "Crowdmon API",
    description:
      "The contract between the edge Worker and the home Go worker. Generated from the " +
      "zod schemas that validate requests at runtime, so the spec cannot drift from " +
      "what the Worker actually accepts.",
  },
  servers: [{ url: "https://crowdmon-api.mkcarl-dev.workers.dev", description: "production" }],
  // Not `as const`: the generator's config type wants mutable arrays, and a
  // readonly `servers` fails to assign.
};
