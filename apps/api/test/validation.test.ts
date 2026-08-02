import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const env = { ENVIRONMENT: "test" };

function post(path: string, body: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

type ErrorBody = { error: string; issues?: { path: string; message: string }[] };

describe("POST /api/admin/videos", () => {
  it("rejects a body with no url", async () => {
    const res = await post("/api/admin/videos", {});

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("invalid request");
  });

  it("names the offending field so a client can act on the failure", async () => {
    const res = await post("/api/admin/videos", { url: "not a url" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.issues?.map((i) => i.path)).toEqual(["url"]);
  });

  it("lets a well-formed body through to the handler", async () => {
    const res = await post("/api/admin/videos", {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    // 501 until M3.4 implements the handler. The point of the assertion is
    // that validation did not reject it — a 400 here would mean the schema
    // rejects input it must accept.
    expect(res.status).toBe(501);
  });
});

describe("POST /api/jobs/claim", () => {
  it("rejects a claim with no worker id", async () => {
    const res = await post("/api/jobs/claim", {});

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.issues?.map((i) => i.path)).toEqual(["worker_id"]);
  });
});

describe("POST /api/jobs/{id}/heartbeat", () => {
  it("rejects a job id that is not an integer", async () => {
    const res = await post("/api/jobs/abc/heartbeat", { worker_id: "w1" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.issues?.map((i) => i.path)).toEqual(["id"]);
  });
});

describe("POST /api/jobs/{id}/complete", () => {
  it("rejects a status outside the terminal set", async () => {
    const res = await post("/api/jobs/1/complete", {
      worker_id: "w1",
      status: "claimed",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.issues?.map((i) => i.path)).toEqual(["status"]);
  });
});
