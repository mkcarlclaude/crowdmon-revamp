import { beforeEach, describe, expect, it } from "vitest";
import { getAnonSessionId } from "../../src/api/anon-session";

describe("getAnonSessionId", () => {
  beforeEach(() => localStorage.clear());

  it("mints a fresh id and persists it", () => {
    const id = getAnonSessionId();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem("crowdmon-anon-session-id")).toBe(id);
  });

  it("returns the same id on a later call", () => {
    const first = getAnonSessionId();
    const second = getAnonSessionId();

    expect(second).toBe(first);
  });

  it("reads back whatever a previous visit already stored", () => {
    localStorage.setItem("crowdmon-anon-session-id", "existing-session-id");

    expect(getAnonSessionId()).toBe("existing-session-id");
  });
});
