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

  try {
    response = await fetch(path, {
      ...init,
      // Access issues an httpOnly cookie on this origin. Stated rather than
      // relied upon: `same-origin` is the default today, and an explicit value
      // survives the day someone moves the API back to another hostname.
      credentials: "same-origin",
      headers: { accept: "application/json", ...init?.headers },
    });
  } catch (cause) {
    // A followed redirect to a cross-origin login page has no CORS headers, so
    // fetch rejects rather than resolving. Same event as the HTML 200 below.
    if (cause instanceof TypeError) throw new SessionExpiredError();
    throw cause;
  }

  // A 3xx that reached us un-followed can only be Access.
  if (response.status >= 300 && response.status < 400) throw new SessionExpiredError();

  // The documented symptom: fetch followed the 302 and this is the login page
  // wearing a 200. Content-type, not body sniffing — the API answers
  // application/json on every path including its errors, so anything else on an
  // API route is not the API answering.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new SessionExpiredError();

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
