import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app";

/**
 * `GET /api/classes/active` (M11.5): what `worker.Pipeline`'s `Prompts` field
 * fetches instead of carrying a static, hand-typed copy of the same wording
 * migration 0006 seeds into D1. See the route's own comment
 * (apps/api/src/routes/classes.ts) for why this carries no `worker_id`.
 */

async function seedClass(
  name: string,
  overrides: { appearancePrompt?: string; promptVersion?: string; active?: 0 | 1 } = {},
): Promise<void> {
  const {
    appearancePrompt = "a small white-haired floating fairy companion",
    promptVersion = "2026-08-08-a",
    active = 1,
  } = overrides;

  await env.DB.prepare(
    `INSERT INTO classes (name, appearance_prompt, prompt_version, active)
          VALUES (?, ?, ?, ?)`,
  )
    .bind(name, appearancePrompt, promptVersion, active)
    .run();
}

function listActiveClasses() {
  return app.request("/api/classes/active", {}, env);
}

describe("GET /api/classes/active", () => {
  it("returns every active class's name, appearance prompt and version", async () => {
    await seedClass("Paimon", {
      appearancePrompt: "a small white-haired floating fairy companion with a dark crown",
      promptVersion: "2026-08-08-a",
    });
    await seedClass("Aether", {
      appearancePrompt: "a blond-haired young man with a single long braid",
      promptVersion: "2026-08-08-a",
    });

    const res = await listActiveClasses();

    expect(res.status).toBe(200);
    // Alphabetical, not insertion order: the handler's own ORDER BY name.
    expect(await res.json()).toEqual({
      classes: [
        {
          name: "Aether",
          appearance_prompt: "a blond-haired young man with a single long braid",
          prompt_version: "2026-08-08-a",
        },
        {
          name: "Paimon",
          appearance_prompt: "a small white-haired floating fairy companion with a dark crown",
          prompt_version: "2026-08-08-a",
        },
      ],
    });
  });

  it("excludes a deactivated class — the soft delete migration 0003 defines", async () => {
    await seedClass("Paimon");
    await seedClass("Retired Character", { active: 0 });

    const res = await listActiveClasses();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      classes: [
        {
          name: "Paimon",
          appearance_prompt: "a small white-haired floating fairy companion",
          prompt_version: "2026-08-08-a",
        },
      ],
    });
  });

  it("returns an empty list when nothing is seeded, not an error", async () => {
    const res = await listActiveClasses();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ classes: [] });
  });

  it("carries no Access assertion and needs no worker_id, matching /api/jobs/stats", async () => {
    // This sits beside jobStatsRoute in trust tier, not beside
    // listVideoImagesRoute: no per-caller or per-video scope exists for it to
    // check, so there is nothing here for a worker_id to gate.
    await seedClass("Paimon");

    const res = await listActiveClasses();

    expect(res.status).toBe(200);
  });

  it("distinguishes two classes seeded with different prompt versions", async () => {
    // The property the whole endpoint exists to carry through: two rows can
    // disagree on `prompt_version`, and the response must not collapse or
    // reorder that away.
    await seedClass("Paimon", { promptVersion: "2026-08-08-a" });
    await seedClass("Aether", { promptVersion: "2026-09-01-a" });

    const res = await listActiveClasses();

    expect(await res.json()).toEqual({
      classes: [
        {
          name: "Aether",
          appearance_prompt: "a small white-haired floating fairy companion",
          prompt_version: "2026-09-01-a",
        },
        {
          name: "Paimon",
          appearance_prompt: "a small white-haired floating fairy companion",
          prompt_version: "2026-08-08-a",
        },
      ],
    });
  });
});
