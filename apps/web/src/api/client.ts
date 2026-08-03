import type { ZodType } from "zod";
import { ApiError, SessionExpiredError } from "./session";

/**
 * Every call to the API goes through here.
 *
 * One chokepoint, for one reason: expired-Access detection has to happen on
 * every request and is easy to get subtly wrong, so it exists exactly once.
 *
 * Paths are relative. The SPA is served by the same Worker that serves the API
 * (M5.1), so there is no base URL to configure and no CORS to negotiate — and
 * if that ever stops being true, this is the single line that has to change.
 */
export async function apiFetch<T>(
  path: string,
  schema: ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;

  // `Headers` understands all three `HeadersInit` shapes — a plain object, an
  // array of pairs, or another `Headers` instance — and normalizes them into
  // one. An object spread only understands the first, so it would silently
  // drop a caller's headers passed as either of the other two.
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");

  try {
    response = await fetch(path, {
      ...init,
      // Access issues an httpOnly cookie on this origin. Stated rather than
      // relied upon: `same-origin` is the default today, and an explicit value
      // survives the day someone moves the API back to another hostname.
      credentials: "same-origin",
      headers,
    });
  } catch (cause) {
    // A followed redirect to a cross-origin login page has no CORS headers, so
    // fetch rejects rather than resolving. Same event as the HTML 200 below.
    if (cause instanceof TypeError) throw new SessionExpiredError();
    throw cause;
  }

  // A 3xx that reached us un-followed can only be Access.
  if (response.status >= 300 && response.status < 400) throw new SessionExpiredError();

  // The API answers application/json on every *handled* path, success or
  // failure alike (apps/api/src/app.ts's defaultHook, and the 400 branch of
  // onError). But onError deliberately rethrows anything else as a bug rather
  // than dressing it up as JSON, so an uncaught exception reaches the browser
  // as Cloudflare's own HTML error page — non-JSON, but not a login page.
  //
  // Content-type alone can't tell those two non-JSON cases apart, but status
  // can: the login page is what a followed 302 lands on, so it only ever
  // arrives as a 2xx (an un-followed redirect is the 3xx handled above). A
  // non-JSON body on a non-2xx status is the origin failing, not Access
  // intercepting — that is a real error worth surfacing, not an expiry.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (response.ok) throw new SessionExpiredError();
    // No parseable body to build a real error message from. Naming the
    // status honestly beats inventing a message the response doesn't carry.
    throw new ApiError(response.status, `request failed with status ${response.status}`);
  }

  const body: unknown = await response.json();

  if (!response.ok) {
    const failure = body as { error?: string; issues?: Array<{ path: string; message: string }> };
    throw new ApiError(response.status, failure.error ?? "request failed", failure.issues);
  }

  // The contract is the schema. Parsing here means a drifted API surfaces at
  // the boundary with the field named, rather than as `undefined` inside a
  // component three levels down.
  return schema.parse(body);
}
