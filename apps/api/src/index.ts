import { instrument } from "@microlabs/otel-cf-workers";
import { app } from "./app";
import type { Bindings } from "./bindings";
import { traceConfig } from "./tracing";

export type { Bindings };
export { app };

/**
 * The Worker entry point. `instrument()` wraps the fetch handler so every
 * request opens a span, and installs the exporter that ships it.
 *
 * This module is not importable outside workerd — see app.ts.
 */
export default instrument({ fetch: app.fetch }, traceConfig);
