import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app";
import { MAX_ACTIVE_CLASSES } from "../../src/schemas";
import { adminHeaders, configureAccess, installAdminIdentity } from "./admin-identity";

/**
 * Class management behind Access (M12.1): the endpoints that make a prompt
 * changeable without a deploy, which until now meant writing another migration
 * the way 0006 did.
 *
 * Two properties carry the milestone, and both are asserted here rather than
 * left to the UI: **nothing is ever deleted** (a retired prompt's predictions
 * keep their referent), and **rewording bumps the version** (two regimes inside
 * one class is the failure `predictions.prompt_version` exists to make
 * visible).
 */

beforeAll(installAdminIdentity);
beforeEach(configureAccess);

async function seedClass(
  name: string,
  overrides: { appearancePrompt?: string; promptVersion?: string; active?: 0 | 1 } = {},
): Promise<number> {
  const {
    appearancePrompt = "a small white-haired floating fairy companion",
    promptVersion = "2026-08-08-a",
    active = 1,
  } = overrides;

  const row = await env.DB.prepare(
    `INSERT INTO classes (name, appearance_prompt, prompt_version, active)
          VALUES (?, ?, ?, ?) RETURNING id`,
  )
    .bind(name, appearancePrompt, promptVersion, active)
    .first<{ id: number }>();

  if (!row) throw new Error(`seeding the class ${name} returned no row`);
  return row.id;
}

async function listClasses(headers?: Record<string, string>) {
  return app.request("/api/admin/classes", { headers: headers ?? (await adminHeaders()) }, env);
}

async function createClass(body: unknown, headers?: Record<string, string>) {
  return app.request(
    "/api/admin/classes",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(headers ?? (await adminHeaders())),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function updateClass(id: number, body: unknown, headers?: Record<string, string>) {
  return app.request(
    `/api/admin/classes/${id}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(headers ?? (await adminHeaders())),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

function readClass(id: number) {
  return env.DB.prepare("SELECT * FROM classes WHERE id = ?").bind(id).first<{
    name: string;
    appearance_prompt: string;
    prompt_version: string;
    active: number;
    updated_at: number;
  }>();
}

describe("GET /api/admin/classes", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/admin/classes", {}, env);
    expect(res.status).toBe(401);
  });

  it("lists inactive classes too, unlike /api/classes/active", async () => {
    // The operator's view is the whole roster: a deactivated class is the one
    // an admin most needs to see, because reactivating it is the only way it
    // ever comes back.
    await seedClass("Paimon");
    await seedClass("Retired Character", { active: 0 });

    const res = await listClasses();
    const body = (await res.json()) as { classes: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(body.classes.map((c) => [c.name, c.active])).toEqual([
      ["Paimon", true],
      ["Retired Character", false],
    ]);
  });

  it("returns an empty roster rather than an error", async () => {
    const res = await listClasses();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ classes: [] });
  });
});

describe("POST /api/admin/classes", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request(
      "/api/admin/classes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Nahida", appearance_prompt: "a small green-haired girl" }),
      },
      env,
    );

    expect(res.status).toBe(401);
  });

  it("creates the class deactivated, so an untried prompt cannot pre-label anything", async () => {
    const res = await createClass({
      name: "Nahida",
      appearance_prompt: "a small girl with long white-and-green hair",
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "Nahida",
      appearance_prompt: "a small girl with long white-and-green hair",
      active: false,
    });

    // And the detector genuinely does not see it yet.
    const active = await app.request("/api/classes/active", {}, env);
    await expect(active.json()).resolves.toEqual({ classes: [] });
  });

  it("stamps a first prompt version rather than accepting one from the caller", async () => {
    const res = await createClass({
      name: "Nahida",
      appearance_prompt: "a small green-haired girl",
    });
    const body = (await res.json()) as { prompt_version: string };

    expect(body.prompt_version).toMatch(/^\d{4}-\d{2}-\d{2}-a$/);
  });

  it("refuses a duplicate name — migration 0003's UNIQUE, reported rather than thrown", async () => {
    await seedClass("Paimon");

    const res = await createClass({ name: "Paimon", appearance_prompt: "a different wording" });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("Paimon") });
  });

  it("rejects an empty name or prompt", async () => {
    expect((await createClass({ name: "", appearance_prompt: "something" })).status).toBe(400);
    expect((await createClass({ name: "Nahida", appearance_prompt: "" })).status).toBe(400);
  });
});

describe("PATCH /api/admin/classes/{id}", () => {
  it("rejects an unauthenticated request", async () => {
    const id = await seedClass("Paimon");
    const res = await app.request(
      `/api/admin/classes/${id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: false }),
      },
      env,
    );

    expect(res.status).toBe(401);
  });

  it("bumps the prompt version when the wording changes", async () => {
    const id = await seedClass("Paimon", {
      appearancePrompt: "a small white-haired floating fairy companion",
      promptVersion: "2026-08-08-a",
    });

    const res = await updateClass(id, {
      appearance_prompt: "a tiny white-haired floating companion with a dark crown",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompt_version: string; appearance_prompt: string };
    expect(body.appearance_prompt).toBe("a tiny white-haired floating companion with a dark crown");
    // A new tag, and specifically not the one the old boxes carry.
    expect(body.prompt_version).not.toBe("2026-08-08-a");
    expect(body.prompt_version).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z]+$/);
  });

  it("leaves the version alone when the wording is resubmitted unchanged", async () => {
    // A no-op save from the UI must not invent a regime boundary: the boxes
    // either side of it were produced by identical text, and a tag that says
    // otherwise is a lie in the one column that exists to tell them apart.
    const id = await seedClass("Paimon", {
      appearancePrompt: "a small white-haired floating fairy companion",
      promptVersion: "2026-08-08-a",
    });

    const res = await updateClass(id, {
      appearance_prompt: "a small white-haired floating fairy companion",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ prompt_version: "2026-08-08-a" });
  });

  it("does not bump the version merely for activating or deactivating", async () => {
    // Turning a class off changes nothing about the wording, so the boxes it
    // already produced belong to the same regime as any it produces after it
    // is turned back on.
    const id = await seedClass("Paimon", { promptVersion: "2026-08-08-a", active: 1 });

    await updateClass(id, { active: false });
    const res = await updateClass(id, { active: true });

    await expect(res.json()).resolves.toMatchObject({
      prompt_version: "2026-08-08-a",
      active: true,
    });
  });

  it("deactivates rather than deletes, so a retired prompt keeps its referent", async () => {
    const id = await seedClass("Paimon");

    const res = await updateClass(id, { active: false });

    expect(res.status).toBe(200);
    // The row is still there — the predictions that reference it still resolve.
    expect(await readClass(id)).toMatchObject({ name: "Paimon", active: 0 });
    // And the worker stops being told about it.
    const active = await app.request("/api/classes/active", {}, env);
    await expect(active.json()).resolves.toEqual({ classes: [] });
  });

  it("offers no way to delete a class at all", async () => {
    const id = await seedClass("Paimon");

    const res = await app.request(
      `/api/admin/classes/${id}`,
      { method: "DELETE", headers: await adminHeaders() },
      env,
    );

    expect(res.status).toBe(404);
    expect(await readClass(id)).not.toBeNull();
  });

  it("touches updated_at", async () => {
    const id = await seedClass("Paimon");
    await env.DB.prepare("UPDATE classes SET updated_at = 1 WHERE id = ?").bind(id).run();

    await updateClass(id, { active: false });

    const row = await readClass(id);
    expect(row?.updated_at).toBeGreaterThan(1_700_000_000);
  });

  it("answers 404 for a class that does not exist", async () => {
    const res = await updateClass(9_999, { active: false });
    expect(res.status).toBe(404);
  });

  it("rejects a request that asks for nothing", async () => {
    // An empty body is a caller bug, not a no-op: silently answering 200 would
    // let a UI that forgot to send its field look like it saved.
    const id = await seedClass("Paimon");

    const res = await updateClass(id, {});

    expect(res.status).toBe(400);
  });

  it("refuses to activate past the bound the worker's contract declares", async () => {
    // `ActiveClasses.classes` is capped at MAX_ACTIVE_CLASSES, and this is the
    // only endpoint that can push the count past it. Refusing here is what
    // keeps that bound a contract rather than a response the worker cannot
    // parse.
    for (let i = 0; i < MAX_ACTIVE_CLASSES; i++) {
      await seedClass(`Character ${i}`, { active: 1 });
    }
    const spare = await seedClass("One Too Many", { active: 0 });

    const res = await updateClass(spare, { active: true });

    expect(res.status).toBe(409);
    expect(await readClass(spare)).toMatchObject({ active: 0 });
  });

  it("lets an already-active class be reworded at the bound", async () => {
    // The count does not change, so the bound has nothing to say about it —
    // a check written as "are we at the limit" rather than "does this add one"
    // would lock every prompt the moment the roster filled up.
    for (let i = 0; i < MAX_ACTIVE_CLASSES - 1; i++) {
      await seedClass(`Character ${i}`, { active: 1 });
    }
    const id = await seedClass("Paimon", { active: 1 });

    const res = await updateClass(id, {
      appearance_prompt: "a reworded description",
      active: true,
    });

    expect(res.status).toBe(200);
  });
});
