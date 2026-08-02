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
// baseURL is expected to be an origin — `https://api.crowdmon.mkcarl.com` —
// with or without a trailing slash; the generated client resolves operation
// paths relatively, so both work, and a test pins that. A baseURL carrying a
// *path prefix* is the case to avoid: relative resolution drops the last
// segment of one that does not end in a slash, so `https://host/v1` would
// silently address `https://host/api/jobs/claim`.
func New(baseURL, workerID string) (*Client, error) {
	if workerID == "" {
		return nil, errors.New("a worker id is required: it is what the lease is held by")
	}

	client, err := api.NewClient(baseURL, api.WithHTTPClient(&http.Client{Timeout: requestTimeout}))
	if err != nil {
		return nil, fmt.Errorf("building the API client: %w", err)
	}

	return &Client{api: client, workerID: workerID}, nil
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
	body := api.CompleteJobJSONRequestBody{
		WorkerId: c.workerID,
		Status:   "done",
	}
	if cause != nil {
		reason := truncate(cause.Error(), maxFailureReason)
		body.Status = "failed"
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
