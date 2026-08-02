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
    // an undefined three components deep.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond('{"ok":"yes"}', { status: 200 })));
    await expect(apiFetch("/api/admin/jobs", Body)).rejects.toThrow();
  });
});
