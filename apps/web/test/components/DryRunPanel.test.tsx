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

function frame(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    r2_key: "frames/dQw4w9WgXcQ/00007.000.jpg",
    url: "https://frames.example/frames/dQw4w9WgXcQ/00007.000.jpg?X-Amz-Signature=abc",
    timestamp_seconds: 7,
    public_sample: false,
    predictions: 0,
    verdict_state: "no_predictions",
    // M17, plan §B: whether an earlier prelabel pass already claimed this
    // frame — required on `AdminVideoImage` since migration 0011, unused by
    // this picker.
    sampled: false,
    ...over,
  };
}

/** One page of `GET /api/admin/videos/{id}/images` — the frame picker grid. */
function framePage(over: Partial<Record<string, unknown>> = {}) {
  return {
    video_id: "dQw4w9WgXcQ",
    total: 1,
    images: [frame()],
    url_mode: "signed",
    expires_at: 1_786_461_918,
    ...over,
  };
}

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
    image_id: 7,
    appearance_prompt: "a tiny floating companion",
    sample_size: 1,
    status: "done",
    failure_reason: null,
    model_id: "owlvit-base-patch32.onnx",
    boxes: [box("frames/dQw4w9WgXcQ/00007.000.jpg")],
    sampled_keys: ["frames/dQw4w9WgXcQ/00007.000.jpg"],
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
  await userEvent.selectOptions(
    screen.getByLabelText(/pick a frame from|try this wording against/i),
    id,
  );
}

/**
 * Clicks a thumbnail in the picker grid, by the accessible name its `<img>`
 * gives the wrapping `<button>`.
 *
 * Not `screen.findByAltText(...)`: once a run has reported, the comparison
 * strip below draws the same frame through `BoxOverlay`, whose own `<img>`
 * carries the identical `alt` — two elements matching one alt text is
 * `BoxOverlay` reused correctly, not a bug, so the picker's thumbnail has to
 * be found by its more specific role instead.
 */
async function pickFrameThumbnail(name = "frames/dQw4w9WgXcQ/00007.000.jpg") {
  const button = await screen.findByRole("button", { name });
  await userEvent.click(button);
}

/**
 * Routes a stubbed fetch by path, so a test can say what each GET answers
 * without depending on the order the component happens to issue them in.
 */
function stubApi(routes: {
  videos?: unknown;
  videoImages?: unknown;
  dryruns?: unknown;
  post?: () => Response;
}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(
        routes.post?.() ?? json(dryRun({ boxes: null, status: "pending" }), 201),
      );
    }
    if (url.includes("/images?")) {
      return Promise.resolve(json(routes.videoImages ?? framePage()));
    }
    if (url.startsWith("/api/admin/videos")) return Promise.resolve(json(routes.videos ?? VIDEOS));
    if (url.includes("/dryruns")) return Promise.resolve(json(routes.dryruns ?? { dryruns: [] }));
    return Promise.resolve(json({ error: `unexpected ${url}` }, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>) {
  const post = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  ) as [string, RequestInit];
  return { url: post[0], body: JSON.parse(post[1].body as string) };
}

afterEach(() => vi.unstubAllGlobals());

describe("DryRunPanel — single-frame mode (M17, plan §A, the default)", () => {
  it("posts image_id once a frame is picked from the grid", async () => {
    const fetchMock = stubApi({});

    render(wrap(<DryRunPanel classId={3} prompt="  a candidate wording  " />));
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await pickFrameThumbnail();
    await userEvent.click(screen.getByRole("button", { name: /dry-run/i }));

    const { url, body } = postedBody(fetchMock);
    expect(url).toBe("/api/admin/classes/3/dryrun");
    expect(body).toEqual({ image_id: 7, appearance_prompt: "a candidate wording" });
  });

  it("posts image_id once a frame id is pasted, with no grid pick needed", async () => {
    const fetchMock = stubApi({ videoImages: framePage({ images: [] }) });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);

    await userEvent.type(screen.getByLabelText(/paste a frame id/i), "99");
    await userEvent.click(screen.getByRole("button", { name: /^use$/i }));
    await userEvent.click(screen.getByRole("button", { name: /dry-run/i }));

    const { body } = postedBody(fetchMock);
    expect(body).toEqual({ image_id: 99, appearance_prompt: "a candidate wording" });
  });

  it("disables the button until a frame is chosen", async () => {
    stubApi({});

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await screen.findByAltText("frames/dQw4w9WgXcQ/00007.000.jpg");

    expect(screen.getByRole("button", { name: /dry-run/i })).toBeDisabled();
  });

  it("renders the comparison strip newest first, each labelled with its wording", async () => {
    stubApi({
      dryruns: {
        dryruns: [
          dryRun({
            id: 2,
            appearance_prompt: "wording two",
            boxes: [box("frames/dQw4w9WgXcQ/00007.000.jpg")],
          }),
          dryRun({ id: 1, appearance_prompt: "wording one", boxes: [] }),
        ],
      },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await pickFrameThumbnail();

    const wordings = await screen.findAllByText(/wording (one|two)/);
    expect(wordings[0]).toHaveTextContent("wording two");
    expect(wordings[1]).toHaveTextContent("wording one");

    // The empty result still gets its own card rather than nothing.
    expect(screen.getByText(/matched nothing on this frame/i)).toBeInTheDocument();
  });

  it("draws boxes over the frame via BoxOverlay, positioned from the normalized coordinates", async () => {
    stubApi({ dryruns: { dryruns: [dryRun()] } });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await pickFrameThumbnail();

    // BoxOverlay's own contract: `data-testid="box-${id}"`, and its `<img>`
    // is named by `alt`, which both call sites here pass the r2_key as.
    const images = await screen.findAllByRole("img", { name: "frames/dQw4w9WgXcQ/00007.000.jpg" });
    const overlayImage = images[images.length - 1] as HTMLImageElement;
    expect(overlayImage).toHaveAttribute(
      "src",
      "/api/admin/image?key=frames%2FdQw4w9WgXcQ%2F00007.000.jpg",
    );
    const overlay = overlayImage.closest("div");
    const drawnBox = overlay?.querySelector('[data-testid="box-0"]');
    expect(drawnBox).toHaveStyle({ left: "10%", top: "20%", width: "40%", height: "40%" });
  });

  it("shows a running placeholder rather than an image while a run is in flight", async () => {
    stubApi({
      dryruns: { dryruns: [dryRun({ boxes: null, sampled_keys: null, status: "claimed" })] },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await pickFrameThumbnail();

    expect(await screen.findByText(/running — claimed/i)).toBeInTheDocument();
  });

  it("shows why a failed iteration failed", async () => {
    stubApi({
      dryruns: {
        dryruns: [
          dryRun({ status: "failed", boxes: null, failure_reason: "the detector sidecar is down" }),
        ],
      },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await pickFrameThumbnail();

    expect(await screen.findByRole("alert")).toHaveTextContent(/the detector sidecar is down/i);
  });

  it("surfaces the API's refusal to queue a run", async () => {
    stubApi({ post: () => json({ error: "no image with id 7" }, 404) });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await pickFrameThumbnail();
    await userEvent.click(screen.getByRole("button", { name: /dry-run/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no image with id 7/i);
  });

  it("says to pick a frame before any run exists", async () => {
    stubApi({});

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));

    expect(screen.getByText(/pick a frame above/i)).toBeInTheDocument();
  });
});

describe("DryRunPanel — whole-video confirmation mode", () => {
  async function switchToVideoMode() {
    await userEvent.click(screen.getByRole("radio", { name: /whole video, confirm/i }));
  }

  it("posts video_id once a video is chosen", async () => {
    const fetchMock = stubApi({});

    render(wrap(<DryRunPanel classId={3} prompt="  a candidate wording  " />));
    await switchToVideoMode();
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await userEvent.click(screen.getByRole("button", { name: /dry-run/i }));

    const { url, body } = postedBody(fetchMock);
    expect(url).toBe("/api/admin/classes/3/dryrun");
    expect(body).toEqual({ video_id: "dQw4w9WgXcQ", appearance_prompt: "a candidate wording" });
  });

  it("will not run against a video with no extracted frames", async () => {
    stubApi({});

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await switchToVideoMode();
    await pickVideo("empty000000", /Not extracted/);

    expect(screen.getByRole("button", { name: /dry-run/i })).toBeDisabled();
    expect(screen.getByText(/no frames extracted/i)).toBeInTheDocument();
  });

  it("draws each box over its own frame via BoxOverlay", async () => {
    stubApi({
      dryruns: {
        dryruns: [
          dryRun({
            image_id: null,
            sample_size: 50,
            boxes: [box("frames/dQw4w9WgXcQ/00000.000.jpg")],
            sampled_keys: ["frames/dQw4w9WgXcQ/00000.000.jpg", "frames/dQw4w9WgXcQ/00600.000.jpg"],
          }),
        ],
      },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await switchToVideoMode();

    const overlayImage = await screen.findByRole("img", {
      name: "frames/dQw4w9WgXcQ/00000.000.jpg",
    });
    expect(overlayImage).toHaveAttribute(
      "src",
      "/api/admin/image?key=frames%2FdQw4w9WgXcQ%2F00000.000.jpg",
    );
    const overlay = overlayImage.closest("div");
    expect(overlay?.querySelector('[data-testid="box-0"]')).toHaveStyle({
      left: "10%",
      top: "20%",
    });
  });

  it("counts the frames that matched against the frames that were looked at", async () => {
    stubApi({
      dryruns: {
        dryruns: [
          dryRun({
            image_id: null,
            sample_size: 50,
            boxes: [box("frames/dQw4w9WgXcQ/00000.000.jpg")],
            sampled_keys: ["frames/dQw4w9WgXcQ/00000.000.jpg", "frames/dQw4w9WgXcQ/00600.000.jpg"],
          }),
        ],
      },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await switchToVideoMode();

    const summary = await screen.findByText(/boxes on/i);
    expect(summary).toHaveTextContent("1 boxes on 1 of 2 frames");
  });

  it("says a wording matched nothing rather than rendering an empty grid", async () => {
    stubApi({
      dryruns: { dryruns: [dryRun({ image_id: null, sample_size: 50, boxes: [] })] },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await switchToVideoMode();

    expect(await screen.findByText(/matched nothing on any sampled frame/i)).toBeInTheDocument();
  });

  it("distinguishes a run that has not reported from one that found nothing", async () => {
    stubApi({
      dryruns: {
        dryruns: [
          dryRun({
            image_id: null,
            sample_size: 50,
            boxes: null,
            sampled_keys: null,
            status: "claimed",
          }),
        ],
      },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await switchToVideoMode();

    expect(await screen.findByText(/running against 50 frames — claimed/i)).toBeInTheDocument();
    expect(screen.queryByText(/matched nothing/i)).not.toBeInTheDocument();
  });

  it("shows why a failed dry-run failed", async () => {
    stubApi({
      dryruns: {
        dryruns: [
          dryRun({
            image_id: null,
            sample_size: 50,
            status: "failed",
            boxes: null,
            failure_reason: "the detector sidecar is down",
          }),
        ],
      },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await switchToVideoMode();

    expect(await screen.findByRole("alert")).toHaveTextContent(/the detector sidecar is down/i);
  });

  it("surfaces the API's refusal to queue a run", async () => {
    stubApi({
      post: () => json({ error: "dQw4w9WgXcQ has no extracted frames to sample yet" }, 400),
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await switchToVideoMode();
    await pickVideo("dQw4w9WgXcQ", /Archon quest/);
    await userEvent.click(screen.getByRole("button", { name: /dry-run/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no extracted frames/i);
  });

  it("groups two boxes on one frame into one image", async () => {
    stubApi({
      dryruns: {
        dryruns: [
          dryRun({
            image_id: null,
            sample_size: 50,
            boxes: [
              box("frames/dQw4w9WgXcQ/00000.000.jpg"),
              box("frames/dQw4w9WgXcQ/00000.000.jpg", { x_min: 0.6, x_max: 0.9 }),
            ],
          }),
        ],
      },
    });

    render(wrap(<DryRunPanel classId={3} prompt="a candidate wording" />));
    await switchToVideoMode();

    const frameImg = await screen.findByRole("img", { name: "frames/dQw4w9WgXcQ/00000.000.jpg" });
    const overlay = frameImg.closest("div") as HTMLElement;
    expect(within(overlay).getByTestId("box-0")).toBeInTheDocument();
    expect(within(overlay).getByTestId("box-1")).toBeInTheDocument();
    expect(within(overlay).getAllByTitle(/confidence 0.41/)).toHaveLength(2);
  });
});
