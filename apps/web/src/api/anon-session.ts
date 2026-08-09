/**
 * The opaque session id CONTEXT.md §Q10 asks a public verdict to carry
 * (M14.2, M14.4): "an anonymous verdict is recorded with `source = 'anon'`
 * and an opaque session id."
 *
 * There is no Access assertion on the public page for the server to read an
 * identity off, so the browser mints one — once, on first use — and reuses it
 * for the life of the tab's `localStorage`. It carries no trust: the API
 * writes it verbatim as `verdicts.annotator_id` and nothing downstream
 * authenticates it (`apps/api/src/schemas.ts`'s `MAX_SESSION_ID_LENGTH`
 * comment). Its only job is letting one visitor's contributions be told apart
 * from another's later, so "excluding one bad actor does not mean discarding
 * every anonymous contribution" (ROADMAP M14.4) is something a later snapshot
 * policy can actually do.
 */

const STORAGE_KEY = "crowdmon-anon-session-id";

/**
 * The same id on every call for this browser; a fresh one only the first
 * time `localStorage` has none. Reads storage on every call rather than
 * caching in a module-level variable — the cost is one synchronous
 * `localStorage.getItem`, and a cache would be one more thing to get stale
 * wrong for no measurable gain.
 */
export function getAnonSessionId(): string {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const created = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, created);
  return created;
}
