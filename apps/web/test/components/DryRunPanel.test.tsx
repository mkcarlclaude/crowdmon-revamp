import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DryRunPanel } from "../../src/components/DryRunPanel";

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// `frames_sampled`, `model_id` and `prelabelled_at` are M16 additions to
// `AdminVideo` (`/admin/detection`'s coverage table) — required on the wire
// because the real endpoint always computes them, so the fixture has to
// carry them too or `AdminVideoList.parse` rejects the response before
// `DryRunPanel` ever sees a video to pick.
const VIDEOS = {
  videos: [
    {
      id: "dQw4w9WgXcQ",
      title: "Archon quest",
      image_count: 2685,
      created_at: 1_754_099_000,
      frames_sampled: 200,
      model_id: "owlvit-base-patch32.onnx",
      prelabelled_at: 1_754_099_500,
    },
    {
      id: "empty000000",
      title: "Not extracted",
      image_count: 0,
      created_at: 1_754_099_000,
      frames_sampled: 0,
      model_id: null,
      prelabelled_at: null,
    },
  ],
};

const box = (r2_key: string, over: Partial<Record<string, number>> = {}) => ({
  r2_key,
  x_min: 0.1,
  y_min: 0.2,
  x_max: 0.5,
  y_max: 0.6,
  confidence: 0.41,
  ...over,
});

function dryRun(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    job_id: 42,
    class_id: 3,
    class_name: "Paimon",
    video_id: "dQw4w9WgXcQ",
    appearance_prompt: "a tiny floating companion",
    sample_size: 50,
    status: "done",
    failure_reason: null,
    model_id: "owlvit-base-patch32.onnx",
    boxes: [box("frames/dQw4w9WgXcQ/00000.000.jpg")],
    sampled_keys: ["frames/dQw4w9WgXcQ/00000.000.jpg", "frames/dQw4w9WgXcQ/00600.000.jpg"],
    requested_by: "admin@example.com",
    created_at: 1_754_099_000,
    reported_at: 1_754_099_400,
    ...over,
  };
}

/**
 * Waits for the video list to arrive before a test tries to pick from it —
 * the option is matched by the label an operator reads, not by the id.
 */
async function pickVideo(id: string, label: RegExp) {
  await screen.findByRole("option", { name: label });
  await userEvent.selectOptions(screen.getByLabelText(/try this wording against/i), id);
}

/**
 * Routes a stubbed fetch by path, so a test can say what each of the two GETs
 * answers without depending on the order the component happens to issue them
 * in.
 */
function stubApi(routes: { videos?: unknown; dryruns?: unknown; post?: () => Response }) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(
        routes.post?.() ?? json(dryRun({ boxes: null, status: "pending" }), 201),
      );
    }
    if (url.startsWith("/api/admin/videos")) return Promise.resolve(json(routes.videos ?? VIDEOS));
    if (url.includes("/dryruns")) return Promise.resolve(json(routes.dryruns ?? { dryruns: [] }));
    return Promise.resolve(json({ error: `unexpected ${url}` }, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("DryRunPanel", () => {
  it("posts the unsaved wording it was handed, not the class's stored prompt", async () => {
    // The whole ordering M12.2 exists for: text is tried before it is saved.
    const fetchMock = stubApi({});

    render(wrap(<DryRunPanel classId={3} prompt="  a candidate wording  " />));
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await userEvent.click(screen.getByRole("button", { name: /dry-run/i }));

    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    ) as [string, RequestInit];
    expect(post[0]).toBe("/api/admin/classes/3/dryrun");
    expect(JSON.parse(post[1].body as string)).toEqual({
      video_id: "dQw4w9WgXcQ",
      appearance_prompt: "a candidate wording",
    });
  });

  it("will not run against a video with no extracted frames", async () => {
    // The API refuses it; saying so before the click means the refusal is
    // visible rather than discovered.
    stubApi({});

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await pickVideo("empty000000", /Not extracted/);

    expect(screen.getByRole("button", { name: /dry-run/i })).toBeDisabled();
    expect(screen.getByText(/no frames extracted/i)).toBeInTheDocument();
  });

  it("draws each box over its own frame, positioned from the normalized coordinates", async () => {
    stubApi({ dryruns: { dryruns: [dryRun()] } });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));

    const frame = await screen.findByRole("img", { name: "frames/dQw4w9WgXcQ/00000.000.jpg" });
    expect(frame).toHaveAttribute(
      "src",
      "/api/admin/image?key=frames%2FdQw4w9WgXcQ%2F00000.000.jpg",
    );

    // Percentages straight off the [0, 1] coordinates — no image dimensions
    // involved, which is why migration 0003 stores them normalized.
    const figure = frame.closest("figure");
    const drawn = figure?.querySelector("span");
    expect(drawn).toHaveStyle({ left: "10%", top: "20%", width: "40%", height: "40%" });
  });

  it("counts the frames that matched against the frames that were looked at", async () => {
    stubApi({ dryruns: { dryruns: [dryRun()] } });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));

    // One box, on one of the two sampled frames.
    const summary = await screen.findByText(/boxes on/i);
    expect(summary).toHaveTextContent("1 boxes on 1 of 2 frames");
  });

  it("says a wording matched nothing rather than rendering an empty grid", async () => {
    // The most useful result a dry-run produces, and the one that must not
    // look like a page that failed to load.
    stubApi({ dryruns: { dryruns: [dryRun({ boxes: [] })] } });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));

    expect(await screen.findByText(/matched nothing on any sampled frame/i)).toBeInTheDocument();
  });

  it("distinguishes a run that has not reported from one that found nothing", async () => {
    // `boxes: null` versus `boxes: []`. Collapsing the two would show "found
    // nothing" for a job that is still running.
    stubApi({
      dryruns: { dryruns: [dryRun({ boxes: null, sampled_keys: null, status: "claimed" })] },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));

    expect(await screen.findByText(/running against 50 frames — claimed/i)).toBeInTheDocument();
    expect(screen.queryByText(/matched nothing/i)).not.toBeInTheDocument();
  });

  it("shows why a failed dry-run failed", async () => {
    stubApi({
      dryruns: {
        dryruns: [
          dryRun({ status: "failed", boxes: null, failure_reason: "the detector sidecar is down" }),
        ],
      },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));

    expect(await screen.findByRole("alert")).toHaveTextContent(/the detector sidecar is down/i);
  });

  it("surfaces the API's refusal to queue a run", async () => {
    stubApi({
      post: () => json({ error: "dQw4w9WgXcQ has no extracted frames to sample yet" }, 400),
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await userEvent.click(screen.getByRole("button", { name: /dry-run/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no extracted frames/i);
  });

  it("groups two boxes on one frame into one image", async () => {
    stubApi({
      dryruns: {
        dryruns: [
          dryRun({
            boxes: [
              box("frames/dQw4w9WgXcQ/00000.000.jpg"),
              box("frames/dQw4w9WgXcQ/00000.000.jpg", { x_min: 0.6, x_max: 0.9 }),
            ],
          }),
        ],
      },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));

    const frames = await screen.findAllByRole("img");
    expect(frames).toHaveLength(1);
    const figure = frames[0]?.closest("figure");
    expect(figure?.querySelectorAll("span")).toHaveLength(2);
    expect(within(figure as HTMLElement).getAllByTitle(/confidence 0.41/)).toHaveLength(2);
  });
});
