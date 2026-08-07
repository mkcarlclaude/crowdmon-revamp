import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GrafanaLink } from "../../src/components/GrafanaLink";

describe("GrafanaLink", () => {
  it("links out to the dashboard rather than embedding one", () => {
    // CONTEXT.md §7: "/admin shows [business data] and links out for [system
    // data]." A real <a> to the dashboard's fixed uid is the whole
    // requirement — there is no panel, iframe, or fetch to assert the
    // absence of, because none of those are ever rendered here.
    render(<GrafanaLink />);
    const link = screen.getByRole("link", { name: /system health/i });

    expect(link).toHaveAttribute("href", "https://grafana.mkcarl.com/d/crowdmon-v1/");
    // Leaving /admin should not lose the admin tab: this opens Grafana in a
    // new one instead of navigating the operator away from the job queue
    // they were just looking at.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });
});
