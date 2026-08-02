import type { ResolveConfigFn } from "@microlabs/otel-cf-workers";
import type { Bindings } from "./bindings";

/**
 * Resolved per request, which is the only way to read `env` — a Worker has no
 * module-level access to its bindings, so the endpoint and the Access token
 * cannot be baked in at build time even if we wanted them to be.
 *
 * The exporter is OTLP over **HTTP**. gRPC is not an option here: the Workers
 * runtime has `fetch` and nothing else, so the collector's 4317 receiver is
 * unreachable from the edge no matter how it is configured.
 */
export const traceConfig: ResolveConfigFn<Bindings> = (env) => ({
  exporter: {
    url: env.OTLP_ENDPOINT,
    headers: {
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    },
  },
  service: {
    name: "crowdmon-api",
  },
});
