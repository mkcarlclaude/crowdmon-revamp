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
		return StatusCounts{Download: c.Download, Chunk: c.Chunk, Prelabel: c.Prelabel}
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

// Detections is everything one finished prelabel job reports: the boxes, and
// the model that proposed them.
type Detections struct {
	// ModelID identifies the detector, stamped onto every row in the batch so
	// that swapping the model is visible in the data rather than inferred from
	// dates (M11.2). One report is one detector run, so it lives here rather
	// than on each box.
	ModelID string
	Boxes   []Box
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

	resp, err := c.api.ReportPredictions(ctx, jobID, api.ReportPredictionsJSONRequestBody{
		WorkerId:    c.workerID,
		ModelId:     detections.ModelID,
		Predictions: boxes,
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
