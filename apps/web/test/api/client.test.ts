import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiFetch } from "../../src/api/client";
import { ApiError, SessionExpiredError } from "../../src/api/session";

const Body = z.object({ ok: z.boolean() });

function respond(body: string, init: ResponseInit & { type?: string }) {
  return new Response(body, {
    ...init,
    headers: { "content-type": init.type ?? "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("apiFetch", () => {
  it("returns the parsed body on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond('{"ok":true}', { status: 200 })));
    await expect(apiFetch("/api/admin/jobs", Body)).resolves.toEqual({ ok: true });
  });

  it("treats an HTML 200 as an expired Access session", async () => {
    // The symptom CONTEXT.md §Q19 documents: fetch silently follows the 302 to
    // the login page and hands back the login HTML with a 200.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond("<!doctype html><title>Sign in</title>", {
          status: 200,
          type: "text/html; charset=utf-8",
        }),
      ),
    );
    await expect(apiFetch("/api/admin/jobs", Body)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("treats a fetch TypeError as an expired Access session", async () => {
    // The other face of the same event: when the login page is cross-origin,
    // the followed redirect has no CORS headers and fetch rejects outright.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(apiFetch("/api/admin/jobs", Body)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("treats a 302 that was not followed as an expired Access session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond("", { status: 302 })));
    await expect(apiFetch("/api/admin/jobs", Body)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("treats a non-JSON server error as a genuine failure, not an expired session", async () => {
    // apps/api/src/app.ts's onError rethrows anything that isn't a 400
    // HTTPException unwrapped, so an uncaught exception reaches the browser
    // as Cloudflare's own HTML error page — non-JSON, but on a non-2xx
    // status. That is the origin failing, not Access's login page: the login
    // page only ever arrives on a 2xx (a followed redirect) or the un-followed
    // 3xx covered above. This must surface as a real, actionable error.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond("<!doctype html><title>Internal Server Error</title>", {
          status: 500,
          type: "text/html; charset=utf-8",
        }),
      ),
    );

    const error = await apiFetch("/api/admin/jobs", Body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SessionExpiredError);
    expect((error as ApiError).status).toBe(500);
  });

  it("surfaces the API's error message and validation issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        respond('{"error":"invalid request","issues":[{"path":"url","message":"Invalid URL"}]}', {
          status: 400,
        }),
      ),
    );

    const error = await apiFetch("/api/admin/videos", Body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toBe("invalid request");
    expect((error as ApiError).issues).toEqual([{ path: "url", message: "Invalid URL" }]);
  });

  it("rejects a 200 whose body does not match the schema", async () => {
    // The contract is the schema, not the status code. A response that parses
    // as JSON but disagrees with the shape is a bug worth a loud failure, not
    // an undefined three components deep. Pinned to ZodError specifically —
    // a bare `.toThrow()` would still pass if the content-type branch above
    // regressed and threw SessionExpiredError instead, which is not the
    // failure this test is named for.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond('{"ok":"yes"}', { status: 200 })));
    await expect(apiFetch("/api/admin/jobs", Body)).rejects.toBeInstanceOf(z.ZodError);
  });

  it("merges caller headers regardless of HeadersInit shape", async () => {
    // RequestInit["headers"] admits a plain object, an array of pairs, or a
    // Headers instance. An object spread only understands the first and
    // silently drops the other two — this pins the fix for all three.
    const fetchMock = vi.fn().mockResolvedValue(respond('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/admin/jobs", Body, { headers: [["x-test", "1"]] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("x-test")).toBe("1");
    expect(headers.get("accept")).toBe("application/json");
  });
});
