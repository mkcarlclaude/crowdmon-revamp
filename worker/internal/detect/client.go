// Package detect is the production worker.Detector: an HTTP client for the
// Python sidecar that holds the open-vocabulary model (M11.2, CONTEXT.md
// §12). The sidecar is production's whole reason to exist as a separate
// process rather than an ONNX call inside this binary — open-vocabulary
// detection needs a CLIP-style tokenizer for the text prompts, and getting
// that right in Go is a worse bet than a well-exercised Python one (see
// deploy/detector/README.md).
//
// This package's job is the same one worker/internal/queue's Client already
// does for the jobs API: own the wire format and the one classification the
// caller cannot make for itself. Here that classification is
// worker.ErrObjectMissing versus everything else — see Detect.
package detect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

// requestTimeout bounds one HTTP round trip to the sidecar, for /model as
// much as /detect.
//
// Thirty seconds, not queue.requestTimeout's — that one is a handful of D1
// statements and this one is a CPU forward pass through an open-vocabulary
// model on two cores with no GPU (CONTEXT.md §12), on hardware this project
// deliberately did not buy a GPU for. The sidecar's own thread budget
// (deploy/detector/README.md) targets low single-digit seconds per image;
// this leaves several times that so a sidecar that is merely slow — sharing
// its two physical cores with the box's other containers, or serving a
// request while a previous one is still finishing — is not mistaken for a
// dead one. It still has to end somewhere: a wedged process must surface as
// a failure the job's own attempt ceiling can act on, rather than hang until
// something else notices.
const requestTimeout = 30 * time.Second

// Startup retry: how long New waits for the sidecar to answer /model before
// giving up.
//
// A var, not a const, so tests can shrink it and stay fast — production
// always runs with the numbers below. Five attempts doubling from two
// seconds caps at eight, a little under thirty seconds total: long enough to
// ride out the sidecar's own cold start (loading an ONNX model into memory
// on a spinning-up container), short enough that a worker whose sidecar is
// genuinely missing fails fast instead of looking hung.
//
// This is the *only* defence against that race, deliberately — compose
// deliberately does not gate the worker's start on the detector's health
// (deploy/homebox/docker-compose.yml explains why: detection is optional,
// and a detector container crash-looping on a missing credential must not
// be able to block chunk and download jobs too). So `docker compose up`
// starting both containers at once is the ordinary case this loop exists
// for, not an edge case: a fresh box is expected to have the worker win the
// race and retry through the wait.
var (
	startupAttempts  = 5
	startupRetryBase = 2 * time.Second
	startupRetryCap  = 8 * time.Second
)

// Per-request retry: how many times Detect retries one image before giving
// up on it.
//
// Three attempts doubling from one second, capping at four — deliberately
// smaller than the startup budget above, because this cost is paid inside a
// job that may run this loop over a couple hundred images (M11.3's sampling
// budget): a generous retry here multiplied by every image in a bad video
// would turn one flaky request into minutes. Three is enough to ride out a
// single dropped connection or a sidecar mid-restart without giving up on
// work the next attempt would have finished, and it is bounded because the
// pipeline's own retry — the whole prelabel job, up to the queue's attempt
// ceiling — is the backstop for anything this loop cannot fix.
var (
	detectAttempts  = 3
	detectRetryBase = 1 * time.Second
	detectRetryCap  = 4 * time.Second
)

// sleep is a var so tests can replace it with something that does not
// actually wait — the retry loops below call it between attempts, and a
// real time.Sleep would make `go test` pay for every backoff this package
// exercises.
var sleep = time.Sleep

// Client talks to the pre-labelling sidecar over HTTP, as one particular
// worker process. It satisfies worker.Detector.
type Client struct {
	baseURL    string
	httpClient *http.Client
	// modelID is fetched once, in New, and never again. See ModelID.
	modelID string
}

// New builds a Client, blocking on the sidecar's GET /model until it answers
// or the startup budget above is spent.
//
// The blocking is deliberate and is what makes ModelID() below able to be a
// plain synchronous getter: worker.Detector's ModelID takes no context and
// returns no error, because the pipeline calls it once per job after every
// Detect call has already succeeded (pipeline.go's prelabel), by which point
// an implementation that still had to ask the network for its own identity
// would be asking a question it should already know the answer to. Fetching
// it here, before the client is handed to the pipeline at all, is what keeps
// that method honest.
//
// Failing here rather than returning a Client that might never resolve its
// model id mirrors cmd/worker/main.go's existing argument for R2: a
// misconfigured or unreachable sidecar is worth discovering at startup, loud,
// rather than as a prelabel job burning its attempt ceiling one flaky poll at
// a time. It also means the "absent config leaves Detector nil" case
// (cmd/worker/main.go) and the "present but broken config" case never get
// confused with each other — only the former is allowed to produce a nil
// Detector.
func New(ctx context.Context, baseURL string) (*Client, error) {
	if baseURL == "" {
		return nil, errors.New("a detector base url is required")
	}

	c := &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{Timeout: requestTimeout},
	}

	var lastErr error
	wait := startupRetryBase
	for attempt := 1; attempt <= startupAttempts; attempt++ {
		modelID, err := c.fetchModelID(ctx)
		if err == nil {
			c.modelID = modelID
			return c, nil
		}
		lastErr = err

		if attempt == startupAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("building the detector client for %s: %w", c.baseURL, ctx.Err())
		default:
		}
		sleep(wait)
		wait = min(wait*2, startupRetryCap)
	}

	return nil, fmt.Errorf(
		"the detector sidecar at %s never answered /model after %d attempts: %w",
		c.baseURL, startupAttempts, lastErr)
}

// ModelID reports what the sidecar was running when New fetched it (M11.2).
// Fetched, not hardcoded, so that swapping the model on the sidecar side —
// changing an image tag, nothing in this repo — is visible in the
// predictions it writes rather than something an operator has to infer from
// a deploy date.
func (c *Client) ModelID() string { return c.modelID }

type modelResponse struct {
	ModelID string `json:"model_id"`
}

func (c *Client) fetchModelID(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/model", nil)
	if err != nil {
		return "", fmt.Errorf("building the /model request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("calling the detector's /model: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the detector's /model answered %s", resp.Status)
	}

	var body modelResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("decoding the detector's /model response: %w", err)
	}
	if body.ModelID == "" {
		return "", errors.New("the detector's /model response carried an empty model id")
	}
	return body.ModelID, nil
}

// detectPrompt and detectRequest are the wire shape /detect takes. Deliberate
// duplicates of worker.ClassPrompt rather than that type reused directly —
// the same argument queue.Box makes for not being frames.Kept: this is the
// wire, and the wire should not change shape just because a Go-internal type
// gained or lost a field for a reason that has nothing to do with the
// sidecar's contract.
type detectPrompt struct {
	Name       string `json:"name"`
	Appearance string `json:"appearance"`
	Version    string `json:"version"`
}

type detectRequest struct {
	// ImageKey is the R2 object key, not a local path or a byte payload —
	// the sidecar fetches the bytes itself, with its own scoped R2
	// credential, rather than the worker reading them and forwarding a
	// blob it has no other use for. See deploy/detector/README.md's
	// "Getting bytes from R2" for the full argument.
	ImageKey string         `json:"image_key"`
	Prompts  []detectPrompt `json:"prompts"`
}

// detectBox and detectResponse are /detect's success shape.
type detectBox struct {
	ClassName     string  `json:"class_name"`
	XMin          float64 `json:"x_min"`
	YMin          float64 `json:"y_min"`
	XMax          float64 `json:"x_max"`
	YMax          float64 `json:"y_max"`
	Confidence    float64 `json:"confidence"`
	PromptVersion string  `json:"prompt_version"`
}

type detectResponse struct {
	Boxes []detectBox `json:"boxes"`
}

// errorResponse is what the sidecar sends on any non-2xx. Error is the
// discriminator this package matches on; Detail is carried into the wrapped
// Go error purely for a human reading logs.
type errorResponse struct {
	Error  string `json:"error"`
	Detail string `json:"detail"`
}

// objectMissingError is the discriminator the sidecar sends on a 404 that
// means "R2 does not have this object" (deploy/detector's storage module).
// Checked against errorResponse.Error rather than trusting the 404 status
// alone, because this service also answers 404 for an unmatched route — an
// operator's typo in CROWDMON_DETECTOR_BASE_URL must not be reported as a
// missing image and burn the video it happened to be checking (Terminal,
// per pipeline.go's prelabel branch).
const objectMissingError = "object_missing"

// Detect asks the sidecar for boxes on one image, retrying transient
// failures up to detectAttempts times before giving up.
//
// Returns worker.ErrObjectMissing, wrapped, exactly when the sidecar reports
// objectMissingError — never retried, because no number of attempts changes
// what R2 has. Every other failure — a connection refused, a timeout, a 5xx
// while the sidecar is mid-restart — is retried within the bound above and
// then returned unwrapped, which is what makes it retryable at the pipeline
// level too (terminal.go's default).
func (c *Client) Detect(
	ctx context.Context, image worker.SampledImage, prompts []worker.ClassPrompt,
) ([]queue.Box, error) {
	wirePrompts := make([]detectPrompt, len(prompts))
	for i, p := range prompts {
		wirePrompts[i] = detectPrompt{Name: p.Name, Appearance: p.Appearance, Version: p.Version}
	}
	body, err := json.Marshal(detectRequest{ImageKey: image.Key, Prompts: wirePrompts})
	if err != nil {
		return nil, fmt.Errorf("encoding the detect request for %s: %w", image.Key, err)
	}

	var lastErr error
	wait := detectRetryBase
	for attempt := 1; attempt <= detectAttempts; attempt++ {
		boxes, err := c.doDetect(ctx, image.Key, body)
		if err == nil {
			return boxes, nil
		}
		if errors.Is(err, worker.ErrObjectMissing) {
			return nil, err
		}
		lastErr = err

		if attempt == detectAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("detecting on %s: %w", image.Key, ctx.Err())
		default:
		}
		sleep(wait)
		wait = min(wait*2, detectRetryCap)
	}

	return nil, fmt.Errorf("detecting on %s after %d attempts: %w", image.Key, detectAttempts, lastErr)
}

func (c *Client) doDetect(ctx context.Context, key string, body []byte) ([]queue.Box, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/detect", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("building the detect request for %s: %w", key, err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		// Transport-level: connection refused, DNS failure, a timeout past
		// requestTimeout. Always retryable — this is exactly "the sidecar is
		// down," the case terminal.go's default exists for.
		return nil, fmt.Errorf("calling the detector for %s: %w", key, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		var out detectResponse
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			return nil, fmt.Errorf("decoding the detector's response for %s: %w", key, err)
		}
		boxes := make([]queue.Box, len(out.Boxes))
		for i, b := range out.Boxes {
			boxes[i] = queue.Box{
				// Key is deliberately left unset — pipeline.go's prelabel
				// branch fills it in from the SampledImage it already holds,
				// exactly as worker.Detector's doc comment requires, so an
				// implementation (this one included) cannot mislabel which
				// image a box came from.
				ClassName:     b.ClassName,
				XMin:          b.XMin,
				YMin:          b.YMin,
				XMax:          b.XMax,
				YMax:          b.YMax,
				Confidence:    b.Confidence,
				PromptVersion: b.PromptVersion,
			}
		}
		return boxes, nil
	}

	wireErr := decodeErrorResponse(resp.Body)

	if resp.StatusCode == http.StatusNotFound && wireErr.Error == objectMissingError {
		return nil, fmt.Errorf("the object %s is missing from storage: %w", key, worker.ErrObjectMissing)
	}

	detail := wireErr.Detail
	if detail == "" {
		detail = wireErr.Error
	}
	return nil, fmt.Errorf("the detector answered %s for %s: %s", resp.Status, key, detail)
}

func decodeErrorResponse(body io.Reader) errorResponse {
	var out errorResponse
	// Deliberately swallowed: a body that is not the expected JSON shape
	// (an upstream proxy's HTML error page, say) still leaves out.Error
	// empty, which doDetect's caller already treats as "no discriminator" —
	// the same fallback an absent body produces. There is nothing a second
	// error about the error body would tell the caller that the empty
	// Error field does not already say.
	_ = json.NewDecoder(body).Decode(&out)
	return out
}
