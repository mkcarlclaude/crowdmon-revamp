import { instrument } from "@microlabs/otel-cf-workers";
import { app } from "./app";
import type { Bindings } from "./bindings";
import { scheduled } from "./scheduled";
import { traceConfig } from "./tracing";

export type { Bindings };
export { app };

/**
 * The Worker entry point. `instrument()` wraps both handlers so every request
 * and every cron tick opens a span, and installs the exporter that ships it.
 *
 * `scheduled` is inside the wrapper rather than exported beside it: the
 * reclaim spans M6.3 emits are children of the tick's span, and a handler
 * outside the instrumentation would produce orphans with nothing to export
 * them.
 *
 * This module is not importable outside workerd — see app.ts.
 */
export default instrument({ fetch: app.fetch, scheduled }, traceConfig);
