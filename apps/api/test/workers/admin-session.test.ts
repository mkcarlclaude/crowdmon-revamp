import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { ADMIN_EMAIL, adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";

/**
 * `GET /api/admin/session` (M16, CONTEXT.md §Q19 amendment): the one check
 * `AdminLayout` runs before deciding between the sidebar shell and the
 * `/admin/login` gate screen.
 *
 * Nothing here is new machinery to test — `requireAccess` already has its own
 * suite (`access.test.ts`) — so what these pin is that this route adds no
 * check of its own past it, and that reaching the handler answers with the
 * identity `requireAccess` verified rather than an empty body.
 */
beforeAll(installAdminIdentity);
beforeEach(configureAccess);

describe("GET /api/admin/session", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/admin/session", {}, env);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing Access assertion" });
  });

  it("answers with the verified identity", async () => {
    const res = await app.request("/api/admin/session", { headers: await adminHeaders() }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ email: ADMIN_EMAIL });
  });
});
