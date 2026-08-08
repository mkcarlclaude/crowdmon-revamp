// Package queue is the worker's side of the job lifecycle: claim, heartbeat,
// complete.
//
// It wraps the generated client rather than replacing it. The generated code
// owns URL building, JSON marshalling and the request types, so a field
// renamed in the zod schemas breaks this package at compile time — which is
// the entire point of generating it (CONTEXT.md §Q24). What this adds is the
// part a generator cannot know: which status codes mean what.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
)

// ErrLeaseLost is returned when the API says this worker does not hold the
// job it is talking about — the reaper took it back, or it was never this
// worker's.
//
// Distinct from a transient failure because the responses are opposite:
// retrying a 500 is right, and retrying a lost lease is working on a job
// somebody else now owns.
var ErrLeaseLost = errors.New("the lease on this job is no longer held")

// ErrRejected is returned when the API refuses a request as invalid rather
// than failing to serve it — a video longer than the fan-out's ceiling, or a
// probe that came back with a resolution of zero.
//
// Distinct from a transient failure for the same reason ErrLeaseLost is: the
// answer will be identical on every attempt, so retrying costs another
// download and another attempt to arrive at the same 400.
var ErrRejected = errors.New("the API rejected this request")

// requestTimeout bounds a single call. Every endpoint here is a handful of
// D1 statements, so seconds is generous — and a claim that hangs past the
// idle interval would stack polls on top of each other.
const requestTimeout = 30 * time.Second

// maxFailureReason mirrors the contract's cap. Truncating here rather than
// letting the API reject the body: a failure whose *report* fails leaves the
// job claimed, and it is then reaped and retried until it runs out of
// attempts — turning one bad video into several wasted downloads.
const maxFailureReason = 1000

// Client talks to the job queue as one particular worker.
type Client struct {
	api      api.ClientInterface
	workerID string
}

// New builds a client for the API at baseURL, identifying as workerID.
//
// baseURL is expected to be an origin — `https://crowdmon.mkcarl.com` —
// with or without a trailing slash; the generated client resolves operation
// paths relatively, so both work, and a test pins that. A baseURL carrying a
// *path prefix* is the case to avoid: relative resolution drops the last
// segment of one that does not end in a slash, so `https://host/v1` would
// silently address `https://host/api/jobs/claim`.
func New(baseURL, workerID string) (*Client, error) {
	if workerID == "" {
		return nil, errors.New("a worker id is required: it is what the lease is held by")
	}

	client, err := api.NewClient(baseURL, api.WithHTTPClient(&http.Client{
		Timeout:   requestTimeout,
		Transport: tracingTransport{},
	}))
	if err != nil {
		return nil, fmt.Errorf("building the API client: %w", err)
	}

	return &Client{api: client, workerID: workerID}, nil
}

// tracingTransport injects the calling context's span onto every outbound
// request as a W3C `traceparent` header, which is the other half of M9.2's
// join: the fan-out call this produces arrives at the API already inside the
// download job's trace, so the chunk jobs it stamps a traceparent onto
// (jobs.ts's fanOutJobHandler) share that trace rather than starting new ones.
//
// A hand-rolled RoundTripper rather than otelhttp.NewTransport: the contrib
// package instruments the request with its own span and metrics, which this
// worker already gets one layer up — every call here runs inside a span
// `pipeline.go` opened with `tracer().Start` — so the only thing missing at
// this seam is the header, and injecting it is two lines against a dependency
// already in go.mod.
type tracingTransport struct{}

func (tracingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// A no-op when req.Context() carries no span: TraceContext.Inject checks
	// validity itself and leaves the header unset, which is exactly what a
	// worker running with tracing disabled needs — every request it sends
	// still goes out, just without the header a live trace would carry.
	otel.GetTextMapPropagator().Inject(req.Context(), propagation.HeaderCarrier(req.Header))

	return http.DefaultTransport.RoundTrip(req)
}

// Claim takes the next pending job, or returns nil when there is none.
//
// An empty queue is the common case, not an error: the API answers 204 with
// no body precisely so the caller can branch on the status line.
func (c *Client) Claim(ctx context.Context) (*api.Job, error) {
	resp, err := c.api.ClaimJob(ctx, api.ClaimJobJSONRequestBody{WorkerId: c.workerID})
	if err != nil {
		return nil, fmt.Errorf("claiming a job: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusNoContent:
		return nil, nil
	case http.StatusOK:
		var job api.Job
		if err := json.NewDecoder(resp.Body).Decode(&job); err != nil {
			return nil, fmt.Errorf("decoding the claimed job: %w", err)
		}
		return &job, nil
	default:
		return nil, fmt.Errorf("claiming a job: %w", statusError(resp))
	}
}

// StatusCounts is one status's row count for each job kind, mirroring
// api.JobStatusCounts. A local type rather than the generated one reused
// directly, for the same reason Probed and Image are: the wire shape belongs
// to this package, and callers outside it — telemetry's queue.depth gauge,
// in particular — should not have to import the generated api package just
// to read a count off it.
type StatusCounts struct {
	Download int
	Chunk    int
	// Prelabel is M11.1's third kind. Named here rather than left out because
	// the generated struct already carries the field: a count the API zero-
	// fills and sends would otherwise be decoded and silently dropped, and
	// "the stats endpoint needs no special-casing to see the new kind" would
	// be true of the API and false of the gauge reading it.
	Prelabel int
	// Dryrun is M12.2's fourth kind, and it is here at the same time as the
	// field it mirrors rather than a milestone later — the gap between the API
	// gaining `prelabel` and this gauge reporting it (M11.1 to M11.4) is the
	// mistake this line exists not to repeat. A dry-run competes for the same
	// single worker as everything else, so a backlog of them is precisely what
	// queue depth is for.
	Dryrun int
}

// Stats is what the queue looked like the moment this was read: job counts
// by status and kind (M9.1). All four statuses are always populated — the
// API zero-fills them (apps/api/src/schemas.ts's JobStats comment explains
// why) — so a freshly-seeded or fully-drained queue answers with real zeros
// here, never with a status this struct happens not to mention.
type Stats struct {
	Pending, Claimed, Done, Failed StatusCounts
}

// Stats reads the queue's current job counts by status and kind. Its only
// caller is the queue.depth gauge's callback (telemetry.NewQueueDepthGauge),
// on the SDK's own export interval rather than the poll loop — this is a
// dashboard read, not a step in the job lifecycle, and the two are
// deliberately decoupled so a slow or failing stats call cannot back off
// PollOnce the way a failing Claim does.
func (c *Client) Stats(ctx context.Context) (Stats, error) {
	resp, err := c.api.JobStats(ctx)
	if err != nil {
		return Stats{}, fmt.Errorf("reading job stats: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return Stats{}, fmt.Errorf("reading job stats: %w", statusError(resp))
	}

	var stats api.JobStats
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		return Stats{}, fmt.Errorf("decoding job stats: %w", err)
	}

	counts := func(c api.JobStatusCounts) StatusCounts {
		return StatusCounts{
			Download: c.Download, Chunk: c.Chunk, Prelabel: c.Prelabel, Dryrun: c.Dryrun,
		}
	}

	return Stats{
		Pending: counts(stats.Pending),
		Claimed: counts(stats.Claimed),
		Done:    counts(stats.Done),
		Failed:  counts(stats.Failed),
	}, nil
}

// Heartbeat renews the lease on a held job.
func (c *Client) Heartbeat(ctx context.Context, jobID int) error {
	resp, err := c.api.HeartbeatJob(ctx, jobID, api.HeartbeatJobJSONRequestBody{WorkerId: c.workerID})
	if err != nil {
		return fmt.Errorf("renewing the lease on job %d: %w", jobID, err)
	}
	defer resp.Body.Close()

	if err := leaseOutcome(resp); err != nil {
		return fmt.Errorf("renewing the lease on job %d: %w", jobID, err)
	}
	return nil
}

// Complete reports a job as finished. A nil cause means it succeeded; a
// non-nil one fails it, carrying the message as the failure reason.
//
// One method rather than two, because the two outcomes are one request with
// one field different, and a worker that could report success without being
// able to report failure would be worse than useless.
func (c *Client) Complete(ctx context.Context, jobID int, cause error) error {
	// api.CompleteRequestStatusDone and api.CompleteRequestStatusFailed rather
	// than the strings they equal. The whole argument for a generated client is
	// that a change to the contract fails the Go build, and a bare "done" here
	// would survive the enum being renamed and fail in production instead.
	body := api.CompleteJobJSONRequestBody{
		WorkerId: c.workerID,
		Status:   api.CompleteRequestStatusDone,
	}
	if cause != nil {
		reason := truncate(cause.Error(), maxFailureReason)
		body.Status = api.CompleteRequestStatusFailed
		body.FailureReason = &reason
	}

	resp, err := c.api.CompleteJob(ctx, jobID, body)
	if err != nil {
		return fmt.Errorf("completing job %d: %w", jobID, err)
	}
	defer resp.Body.Close()

	if err := leaseOutcome(resp); err != nil {
		return fmt.Errorf("completing job %d: %w", jobID, err)
	}
	return nil
}

// Probed is what phase one learned about a video: ffprobe's measurements of
// the file that landed, and yt-dlp's title.
type Probed struct {
	DurationSeconds int
	Width           int
	Height          int
	// Empty when the download was skipped because the file was already on
	// disk. Sent as an absent field rather than an empty string, so the API's
	// COALESCE keeps whatever title it already had.
	Title string
}

// FanOutResult is what the API did with a Probed: how many segments the video
// has, and how many of their jobs this call created.
//
// The two differ whenever a fan-out re-runs after a reap (M7.3), and keeping
// them apart is what lets the worker log "already fanned out" rather than
// reporting work it did not do.
type FanOutResult struct {
	Segments int
	Created  int
}

// FanOut records what was probed and enqueues the video's chunk jobs.
//
// The enqueue is the API's to perform, not this worker's, because the job row
// and its `chunks` row have to be written in one transaction (CONTEXT.md §Q13)
// — which a client making one HTTP call per segment could not do.
func (c *Client) FanOut(ctx context.Context, jobID int, probed Probed) (FanOutResult, error) {
	body := api.FanOutJobJSONRequestBody{
		WorkerId:        c.workerID,
		DurationSeconds: probed.DurationSeconds,
		Width:           probed.Width,
		Height:          probed.Height,
	}
	if probed.Title != "" {
		body.Title = &probed.Title
	}

	resp, err := c.api.FanOutJob(ctx, jobID, body)
	if err != nil {
		return FanOutResult{}, fmt.Errorf("fanning out job %d: %w", jobID, err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		var result api.ChunkFanOut
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return FanOutResult{}, fmt.Errorf("decoding the fan-out of job %d: %w", jobID, err)
		}
		return FanOutResult{Segments: result.Segments, Created: result.Created}, nil
	case http.StatusNotFound:
		return FanOutResult{}, fmt.Errorf("fanning out job %d: %w", jobID, ErrLeaseLost)
	case http.StatusBadRequest:
		return FanOutResult{}, fmt.Errorf("fanning out job %d: %w: %s", jobID, ErrRejected, statusError(resp))
	default:
		return FanOutResult{}, fmt.Errorf("fanning out job %d: %w", jobID, statusError(resp))
	}
}

// Image is one deduplicated frame that reached R2, as the API records it.
//
// Deliberately primitives rather than a frames.Kept: this package is the wire,
// and importing the extraction package here would make the queue client depend
// on how frames happen to be produced. The mapping costs a loop at the one call
// site that has both types in hand.
type Image struct {
	// Key is the R2 object key the bytes were written to, and it is
	// deterministic in (video id, timestamp) — see frames.Key. The API stores
	// it verbatim.
	Key string
	// TimestampSeconds is the offset into the source video, which together with
	// the video id is the row's identity: a re-run after a reap updates that
	// row rather than adding a second one.
	TimestampSeconds float64
	// PHash is the 16-character hex rendering of the perceptual hash. The API
	// rejects anything else, so that the phash index means one thing.
	PHash string
}

// SampleCandidate is one row of `images` as ListVideoImages reads it back —
// the wire's VideoImage, renamed for the reason Image is (this package is the
// wire, and worker/internal/sample should not have to import the generated
// api package just to read a key and a timestamp off it).
type SampleCandidate struct {
	Key              string
	TimestampSeconds float64
}

// Images lists every row `images` holds for a video — the pool a prelabel
// job's sampler draws its bounded, timeline-spread subset from (M11.3).
//
// Scoped by video id rather than a job id the way every other call in this
// file is, because that is all worker.ImageSampler.Sample is ever handed
// (pipeline.go's own comment on the interface explains why: the sample is
// drawn once per video, not once per job). The API's lease check follows
// suit — see reportImagesRoute's sibling, listVideoImagesRoute, in
// apps/api/src/routes/jobs.ts for how it proves this worker holds *a*
// prelabel job for this video without a job id to check against.
func (c *Client) Images(ctx context.Context, videoID string) ([]SampleCandidate, error) {
	resp, err := c.api.ListVideoImages(ctx, videoID, &api.ListVideoImagesParams{WorkerId: c.workerID})
	if err != nil {
		return nil, fmt.Errorf("listing images for %s: %w", videoID, err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		var page api.VideoImages
		if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
			return nil, fmt.Errorf("decoding the image pool for %s: %w", videoID, err)
		}
		candidates := make([]SampleCandidate, len(page.Images))
		for i, image := range page.Images {
			candidates[i] = SampleCandidate{
				Key:              image.R2Key,
				TimestampSeconds: float64(image.TimestampSeconds),
			}
		}
		return candidates, nil
	case http.StatusNotFound:
		// No prelabel job for this video is held by this worker — the reaper
		// took it back, or Sample is being called for a video this worker was
		// never handed. Same vocabulary as every other lease-checked call:
		// the caller's response is to stop, not to retry against a lease it
		// does not hold.
		return nil, fmt.Errorf("listing images for %s: %w", videoID, ErrLeaseLost)
	default:
		return nil, fmt.Errorf("listing images for %s: %w", videoID, statusError(resp))
	}
}

// Extraction is everything a finished chunk has to report: the counts the
// dedup ratio is computed from, the rows themselves, and the provenance that
// makes both interpretable later.
type Extraction struct {
	Extracted int
	Kept      int
	// DedupThreshold is the threshold *in force for this run*, stamped onto
	// every row it produced (M8.4). Changing it later does not re-deduplicate
	// old videos, so a dataset without this recorded per row is an unrecorded
	// mixture of regimes and no dedup ratio drawn from it means anything.
	DedupThreshold int
	// ConfigVersion describes every setting that shaped this output, and lands
	// on the job rather than the rows — one job, one configuration.
	ConfigVersion string
	Images        []Image
}

// ReportImages records a chunk's output: the image rows, the frame counts on
// the `chunks` row, and the configuration that produced them.
//
// One call carrying everything rather than one per image, for the reason
// fan-out is one call: the API writes it as a single D1 batch, and rows that
// landed without the threshold that produced them are precisely the provenance
// gap M8.4 exists to close.
//
// Called before Complete, deliberately. Reporting on a lease this worker still
// holds is what makes the 404 meaningful — a chunk marked done and then found
// to have no rows would be indistinguishable from one that extracted nothing.
func (c *Client) ReportImages(ctx context.Context, jobID int, extraction Extraction) error {
	images := make([]api.ImageFrame, len(extraction.Images))
	for i, image := range extraction.Images {
		images[i] = api.ImageFrame{
			R2Key: image.Key,
			// float32 on the wire because the contract says `number` and
			// oapi-codegen renders that as the narrower type. Harmless here and
			// worth knowing why it is not: extraction is 1fps, so every
			// timestamp is a whole number of seconds well inside float32's
			// exactly-representable integer range, and the six-hour ceiling on
			// video length (schemas.ts) keeps it there.
			TimestampSeconds: float32(image.TimestampSeconds),
			Phash:            image.PHash,
		}
	}

	resp, err := c.api.ReportImages(ctx, jobID, api.ReportImagesJSONRequestBody{
		WorkerId:        c.workerID,
		FramesExtracted: extraction.Extracted,
		FramesKept:      extraction.Kept,
		DedupThreshold:  extraction.DedupThreshold,
		ConfigVersion:   extraction.ConfigVersion,
		Images:          images,
	})
	if err != nil {
		return fmt.Errorf("reporting the images for job %d: %w", jobID, err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("reporting the images for job %d: %w", jobID, ErrLeaseLost)
	case http.StatusBadRequest:
		// The contract refused the report — a phash that is not 16 hex
		// characters, counts that disagree, a timestamp outside the chunk's
		// window. Every one of those is this worker's bug and will be identical
		// on the next attempt, so it is classified alongside the fan-out's 400
		// rather than left for the reaper.
		return fmt.Errorf("reporting the images for job %d: %w: %s", jobID, ErrRejected, statusError(resp))
	default:
		return fmt.Errorf("reporting the images for job %d: %w", jobID, statusError(resp))
	}
}

// Box is one model-proposed detection, as the prelabel pipeline hands it to
// the API (M11.1's plumbing; M11.2 is what produces one).
//
// Coordinates are normalized to [0, 1], matching migration 0003's CHECK
// constraints and the detector's own output. Deliberately not pixels: the
// image rows carry no width or height, so a pixel box would only mean
// something alongside a frame this struct does not have.
type Box struct {
	// Key is the R2 object key of the image the box was found on — the same
	// handle Image.Key uses, and for the same reason. The worker knows the
	// object it ran the detector over; it has never been told the row id the
	// API assigned it.
	Key string
	// ClassName is classes.name, resolved to a class_id by the API. Same
	// reasoning as Key: no endpoint hands this worker a class_id.
	ClassName              string
	XMin, YMin, XMax, YMax float64
	Confidence             float64
	// PromptVersion is the wording in force for this box's class when the
	// detector ran. Per box, not per report, because one report spans classes
	// and each carries its own prompt version (migration 0003).
	PromptVersion string
}

// Detections is everything one finished prelabel job reports: the boxes, the
// model that proposed them, and every image the sample actually drew.
type Detections struct {
	// ModelID identifies the detector, stamped onto every row in the batch so
	// that swapping the model is visible in the data rather than inferred from
	// dates (M11.2). One report is one detector run, so it lives here rather
	// than on each box.
	ModelID string
	Boxes   []Box
	// SampledKeys is every image the sampler drew for this job (M11.3),
	// whether or not the detector found a box on it — a detector finding
	// nothing is a real outcome, so Boxes alone cannot say which frames were
	// even looked at. This is what the API stamps `images.selection_reason`
	// from (apps/api/src/routes/jobs.ts's reportPredictionsHandler explains
	// why that stamp is written here, with the report, rather than at the
	// moment Sample drew the frames).
	SampledKeys []string
}

// ReportPredictions records a prelabel job's boxes.
//
// One call carrying the whole video's detections rather than one per box, for
// the reason ReportImages is one call per chunk: the API writes them as a
// single D1 batch, and a partial write would leave rows whose provenance is
// only half-recorded.
//
// Called before Complete, deliberately — the same ordering ReportImages uses,
// and for the same reason: reporting on a lease this worker still holds is
// what makes the 404 meaningful.
func (c *Client) ReportPredictions(ctx context.Context, jobID int, detections Detections) error {
	boxes := make([]api.PredictionBox, len(detections.Boxes))
	for i, box := range detections.Boxes {
		boxes[i] = api.PredictionBox{
			R2Key:     box.Key,
			ClassName: box.ClassName,
			// float32 on the wire for the reason ImageFrame.TimestampSeconds
			// is: the contract says `number` and oapi-codegen renders that as
			// the narrower type. Harmless for a coordinate in [0, 1], where
			// float32 carries about seven significant digits — far past the
			// precision any detector's box is meaningful to.
			XMin:          float32(box.XMin),
			YMin:          float32(box.YMin),
			XMax:          float32(box.XMax),
			YMax:          float32(box.YMax),
			Confidence:    float32(box.Confidence),
			PromptVersion: box.PromptVersion,
		}
	}

	// Never nil on the wire, even for an empty sample: the contract declares
	// `sampled_images` required (schemas.ts's own comment on the field
	// explains why "I don't know what I sampled" is not a legitimate answer),
	// and a nil slice still marshals to `[]` via encoding/json, so this is
	// belt-and-braces rather than load-bearing — but SampledKeys being nil is
	// the common shape a zero-value Detections{} produces, and there is no
	// reason to depend on json.Marshal's nil-slice behaviour when naming the
	// intent costs one line.
	sampledKeys := detections.SampledKeys
	if sampledKeys == nil {
		sampledKeys = []string{}
	}

	resp, err := c.api.ReportPredictions(ctx, jobID, api.ReportPredictionsJSONRequestBody{
		WorkerId:      c.workerID,
		ModelId:       detections.ModelID,
		Predictions:   boxes,
		SampledImages: sampledKeys,
	})
	if err != nil {
		return fmt.Errorf("reporting the predictions for job %d: %w", jobID, err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("reporting the predictions for job %d: %w", jobID, ErrLeaseLost)
	case http.StatusBadRequest:
		// An r2_key or class_name the API could not resolve, a box outside
		// [0, 1], a batch past the per-job bound, or a job that is not a
		// prelabel job. Every one of those is this worker's bug and will be
		// identical on the next attempt, so it joins the fan-out's and the
		// image report's 400 rather than being left for the reaper.
		return fmt.Errorf("reporting the predictions for job %d: %w: %s", jobID, ErrRejected, statusError(resp))
	default:
		return fmt.Errorf("reporting the predictions for job %d: %w", jobID, statusError(resp))
	}
}

// ClassPrompt is one active class as the API returns it (migration 0003's
// `classes` table, filtered to `active = 1` by `GET /api/classes/active`,
// M11.5): the wording the detector should match on, and the version stamped
// onto every prediction it produces.
//
// A wire-shaped type of its own rather than worker.ClassPrompt, for the same
// reason Box, Image and SampleCandidate already are: this package is the
// wire, and worker already imports it (pipeline.go), so a method here
// returning a worker type would need the reverse import and create the
// cycle that direction is not allowed to have. worker.PromptSource's own
// comment is the fuller version of this argument, and worker.
// toClassPrompts is where the one conversion into worker.ClassPrompt
// actually happens.
type ClassPrompt struct {
	Name       string
	Appearance string
	Version    string
}

// ActiveClasses lists the classes a prelabel job's detector should currently
// run against: migration 0003's `classes` table, already filtered to
// `active = 1` on the API side (apps/api/src/routes/classes.ts) so a
// deactivated class stops being detected without this worker having to know
// what "deactivated" means.
//
// Scoped to nothing — no video id, no job id, no worker_id — because every
// prelabel job needs the identical answer (worker.PromptSource's own comment
// explains why that is also the reason the endpoint carries no worker_id).
// Called once per prelabel job (pipeline.go's prelabel branch) rather than
// cached at startup, so a class reworded or (de)activated between two jobs
// is visible on the very next one with no restart required.
func (c *Client) ActiveClasses(ctx context.Context) ([]ClassPrompt, error) {
	resp, err := c.api.ListActiveClasses(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing active classes: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("listing active classes: %w", statusError(resp))
	}

	var body api.ActiveClasses
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decoding active classes: %w", err)
	}

	prompts := make([]ClassPrompt, len(body.Classes))
	for i, class := range body.Classes {
		prompts[i] = ClassPrompt{
			Name:       class.Name,
			Appearance: class.AppearancePrompt,
			Version:    class.PromptVersion,
		}
	}
	return prompts, nil
}

// leaseOutcome reads the two lease-bearing endpoints' answers. 404 is the
// API's single answer for "no job with this id is held by this worker",
// deliberately not distinguishing a missing job from a reaped one — the
// worker's response is the same either way, which is to stop.
func leaseOutcome(resp *http.Response) error {
	switch resp.StatusCode {
	case http.StatusNoContent:
		return nil
	case http.StatusNotFound:
		return ErrLeaseLost
	default:
		return statusError(resp)
	}
}

// statusError turns an unexpected response into an error that says what the
// API said. The body is small and structured (ErrorResponse), and reading it
// is the difference between "the queue said no" and knowing why.
func statusError(resp *http.Response) error {
	var body api.ErrorResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err == nil && body.Error != "" {
		return fmt.Errorf("the API answered %s: %s", resp.Status, body.Error)
	}
	return fmt.Errorf("the API answered %s", resp.Status)
}

func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	return s[:limit]
}

// DryRunResult is everything one finished dry-run job reports (M12.2).
//
// Deliberately not Detections, although the two look alike. A dry-run's boxes
// carry no class name and no prompt version — one run is one candidate wording
// for one class, both already on the `dryruns` row — and, more importantly,
// they are not label data: nothing here becomes a `predictions` row, and a
// shared type would be the first step towards the two being handled by the
// same code that writes them.
type DryRunResult struct {
	ModelID string
	Boxes   []DryRunBox
	// SampledKeys is every frame the sampler drew, whether or not a box was
	// found on it. Same reason Detections.SampledKeys exists: without it, a
	// prompt that matched nothing cannot be told apart from a run that looked
	// at nothing.
	SampledKeys []string
}

// DryRunBox is one box a candidate wording proposed.
type DryRunBox struct {
	// Key is the R2 object key of the frame — filled in by the caller, not by
	// the Detector, exactly as Box.Key is.
	Key                    string
	XMin, YMin, XMax, YMax float64
	Confidence             float64
}

// ReportDryRun records what a candidate prompt found (M12.2).
//
// Called before Complete, the ordering every other report in this file uses:
// reporting on a lease this worker still holds is what makes the 404 mean
// something.
func (c *Client) ReportDryRun(ctx context.Context, jobID int, result DryRunResult) error {
	boxes := make([]api.DryRunBox, len(result.Boxes))
	for i, box := range result.Boxes {
		boxes[i] = api.DryRunBox{
			R2Key: box.Key,
			// float32 for ReportPredictions' reason: the contract says
			// `number`, oapi-codegen renders the narrower type, and float32's
			// seven significant digits are far past what a box in [0, 1]
			// means.
			XMin:       float32(box.XMin),
			YMin:       float32(box.YMin),
			XMax:       float32(box.XMax),
			YMax:       float32(box.YMax),
			Confidence: float32(box.Confidence),
		}
	}

	sampledKeys := result.SampledKeys
	if sampledKeys == nil {
		sampledKeys = []string{}
	}

	resp, err := c.api.ReportDryRun(ctx, jobID, api.ReportDryRunJSONRequestBody{
		WorkerId:      c.workerID,
		ModelId:       result.ModelID,
		Boxes:         boxes,
		SampledImages: sampledKeys,
	})
	if err != nil {
		return fmt.Errorf("reporting the dry-run for job %d: %w", jobID, err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("reporting the dry-run for job %d: %w", jobID, ErrLeaseLost)
	case http.StatusBadRequest:
		// A box outside [0, 1], a batch past the per-job bound, or a job that
		// is not a dry-run. This worker's bug, identical next attempt.
		return fmt.Errorf("reporting the dry-run for job %d: %w: %s", jobID, ErrRejected, statusError(resp))
	default:
		return fmt.Errorf("reporting the dry-run for job %d: %w", jobID, statusError(resp))
	}
}
