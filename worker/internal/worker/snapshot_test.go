package worker_test

import (
	"context"
	"errors"
	"testing"

	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/api"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/queue"
	"github.com/mkcarlclaude/crowdmon-revamp/worker/internal/worker"
)

// The snapshot path (M15.1). Unlike every other kind, its job names no
// video — snapshotJob's own VideoId is nil — so these tests are also what
// proves the branch never dereferences it.

type fakeSnapshotFetcher struct {
	source queue.SnapshotSource
	err    error
	jobID  int
	calls  int
}

func (f *fakeSnapshotFetcher) SnapshotSource(_ context.Context, jobID int) (queue.SnapshotSource, error) {
	f.calls++
	f.jobID = jobID
	return f.source, f.err
}

type fakeSnapshotBuilder struct {
	artifact queue.SnapshotArtifact
	err      error
	prefix   string
	source   queue.SnapshotSource
	calls    int
}

func (b *fakeSnapshotBuilder) Build(
	_ context.Context, prefix string, source queue.SnapshotSource,
) (queue.SnapshotArtifact, error) {
	b.calls++
	b.prefix, b.source = prefix, source
	return b.artifact, b.err
}

type fakeSnapshotReporter struct {
	err      error
	jobID    int
	artifact queue.SnapshotArtifact
	calls    int
}

func (r *fakeSnapshotReporter) ReportSnapshot(
	_ context.Context, jobID int, artifact queue.SnapshotArtifact,
) error {
	r.calls++
	r.jobID, r.artifact = jobID, artifact
	return r.err
}

func snapshotJob() *api.Job {
	// VideoId and VideoUrl are deliberately left nil — migration 0008's own
	// invariant for this kind, and the whole reason the branch must never
	// dereference job.VideoId the way download/chunk/prelabel/dryrun do.
	return &api.Job{Id: 142, Kind: api.JobKindSnapshot}
}

func TestSnapshotFetchesBuildsAndReports(t *testing.T) {
	source := queue.SnapshotSource{
		Images: []queue.SnapshotImage{
			{Key: "frames/dQw4w9WgXcQ/00000.000.jpg", VideoID: "dQw4w9WgXcQ"},
		},
	}
	fetcher := &fakeSnapshotFetcher{source: source}
	builder := &fakeSnapshotBuilder{
		artifact: queue.SnapshotArtifact{R2Key: "snapshots/job-142", ImageCount: 1, LabelCount: 3},
	}
	reporter := &fakeSnapshotReporter{}

	p := worker.Pipeline{SnapshotSource: fetcher, SnapshotBuilder: builder, SnapshotReporter: reporter}

	if err := p.Work(context.Background(), snapshotJob()); err != nil {
		t.Fatalf("Work: %v", err)
	}

	if fetcher.calls != 1 || fetcher.jobID != 142 {
		t.Errorf("fetcher called %d times against job %d, want one call against 142", fetcher.calls, fetcher.jobID)
	}
	if builder.calls != 1 || builder.prefix != "snapshots/job-142" {
		t.Errorf("builder called %d times with prefix %q, want one call at snapshots/job-142",
			builder.calls, builder.prefix)
	}
	if len(builder.source.Images) != 1 {
		t.Errorf("builder saw %d images, want the fetcher's own", len(builder.source.Images))
	}
	if reporter.calls != 1 || reporter.jobID != 142 {
		t.Errorf("reporter called %d times against job %d, want one call against 142", reporter.calls, reporter.jobID)
	}
	if reporter.artifact.ImageCount != 1 || reporter.artifact.LabelCount != 3 {
		t.Errorf("reported artifact = %+v, want the builder's own counts", reporter.artifact)
	}
}

func TestSnapshotWithoutConfigurationIsRetryable(t *testing.T) {
	// A deployment that is wrong right now and may be right in a minute —
	// prelabel's and dry-run's own argument, unchanged.
	p := worker.Pipeline{}

	err := p.Work(context.Background(), snapshotJob())

	if err == nil {
		t.Fatal("Work: want an error for a worker with no snapshot building configured")
	}
	if worker.IsTerminal(err) {
		t.Errorf("error is terminal, want retryable: %v", err)
	}
}

func TestSnapshotFetchFailureIsNotReported(t *testing.T) {
	fetcher := &fakeSnapshotFetcher{err: errors.New("the API is down")}
	builder := &fakeSnapshotBuilder{}
	reporter := &fakeSnapshotReporter{}

	p := worker.Pipeline{SnapshotSource: fetcher, SnapshotBuilder: builder, SnapshotReporter: reporter}

	if err := p.Work(context.Background(), snapshotJob()); err == nil {
		t.Fatal("Work: want the fetcher's error")
	}

	if builder.calls != 0 {
		t.Errorf("builder called %d times, want none — there was nothing to build", builder.calls)
	}
	if reporter.calls != 0 {
		t.Errorf("reporter called %d times, want none — the build never ran", reporter.calls)
	}
}

func TestSnapshotBuildFailureIsNotReported(t *testing.T) {
	fetcher := &fakeSnapshotFetcher{}
	builder := &fakeSnapshotBuilder{err: errors.New("R2 is down")}
	reporter := &fakeSnapshotReporter{}

	p := worker.Pipeline{SnapshotSource: fetcher, SnapshotBuilder: builder, SnapshotReporter: reporter}

	if err := p.Work(context.Background(), snapshotJob()); err == nil {
		t.Fatal("Work: want the builder's error")
	}

	if reporter.calls != 0 {
		t.Errorf("reporter called %d times, want none — reporting a build that failed would claim a snapshot that isn't in R2", reporter.calls)
	}
}

func TestSnapshotRejectedByTheContractIsTerminal(t *testing.T) {
	// The contract refused the report — this worker's bug, identical on the
	// next attempt, so retrying only burns attempts. Matches every other
	// report-then-classify branch in this package.
	p := worker.Pipeline{
		SnapshotSource:   &fakeSnapshotFetcher{},
		SnapshotBuilder:  &fakeSnapshotBuilder{},
		SnapshotReporter: &fakeSnapshotReporter{err: queue.ErrRejected},
	}

	err := p.Work(context.Background(), snapshotJob())

	if err == nil {
		t.Fatal("Work: want the reporter's error")
	}
	if !worker.IsTerminal(err) {
		t.Errorf("error is retryable, want terminal: %v", err)
	}
}
