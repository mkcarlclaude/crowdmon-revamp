package frames

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// This file takes the worker's first dependency outside OTel: the AWS SDK,
// used only for its S3 client and SigV4 signer. R2's S3-compatible API is
// still SigV4, and hand-rolling that signature is exactly the kind of thing
// that compiles, passes a unit test against a canned request, and then fails
// against the real service on some header the test never exercised — a
// silent-until-production failure mode CONTEXT.md §Q13 is otherwise
// structured to avoid. Taking a well-exercised signer as a dependency is
// cheaper than being the one who finds R2's edge cases by hand.

// DefaultUploadConcurrency bounds how many PutObject calls Upload runs at
// once.
//
// 4, not higher: the home box (CONTEXT.md §Q13) has 2 physical cores and one
// residential uplink, so beyond a handful of in-flight requests the
// concurrency buys nothing but contention — the same argument the fan-out
// amendment already makes about ffmpeg threads, applied to network calls
// instead of CPU. It is a default, not a ceiling on Uploader.Concurrency,
// because a future box with more bandwidth should be free to raise it without
// a code change.
const DefaultUploadConcurrency = 4

// S3API is the subset of *s3.Client that Upload calls, declared on the
// consumer side so tests substitute a fake with no network — the same pattern
// Downloader, Prober and FanOuter use in worker/internal/worker/pipeline.go.
// Naming only PutObject keeps the interface honest about what this package
// actually does to the bucket.
type S3API interface {
	PutObject(ctx context.Context, params *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error)
}

// Uploader puts frames in the bucket.
type Uploader struct {
	Client      S3API
	Bucket      string
	Concurrency int // zero means DefaultUploadConcurrency
}

// Upload puts every kept frame at its deterministic key and returns the keys
// in the same order as kept.
//
// The key is frames.Key(videoID, frame.TimestampSeconds) — this function does
// not invent a second key format, because the whole of M8.3's idempotency
// argument is that extraction, dedup and upload agree on one. A re-run
// overwrites the same objects rather than adding near-duplicates under fresh
// names, which is also why nothing here does a HEAD before the PUT: checking
// whether the object already exists would double the request count on every
// call in order to avoid a write that is already harmless. See frames.Key and
// CONTEXT.md §Q14.
//
// Concurrency is bounded (Uploader.Concurrency, defaulting to
// DefaultUploadConcurrency) via a semaphore channel, and results are written
// into a preallocated slice by index rather than appended under a mutex — so
// the order of the returned keys matches kept regardless of which upload
// finishes first.
//
// The first error cancels every upload still in flight and is returned naming
// the key that failed. A partial upload is safe for the same reason a re-run
// is: the keys are deterministic, so the next attempt rewrites exactly the
// objects that did not make it, and nothing needs to know which those were.
func (u Uploader) Upload(ctx context.Context, videoID string, kept []Kept) ([]string, error) {
	if len(kept) == 0 {
		return nil, nil
	}

	concurrency := u.Concurrency
	if concurrency <= 0 {
		concurrency = DefaultUploadConcurrency
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	keys := make([]string, len(kept))
	sem := make(chan struct{}, concurrency)

	var (
		wg       sync.WaitGroup
		errOnce  sync.Once
		firstErr error
	)

	for i, k := range kept {
		key := Key(videoID, k.TimestampSeconds)
		keys[i] = key

		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			// A previous upload already failed, or the caller's own context
			// ended; either way, stop starting new ones rather than queueing
			// work behind a semaphore slot a cancelled upload will never
			// release. firstErr can still be nil here if nothing in flight
			// has reported its own failure yet, so ctx.Err() is the fallback.
			wg.Wait()
			if firstErr != nil {
				return nil, firstErr
			}
			return nil, ctx.Err()
		}

		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			if err := u.put(ctx, key, k); err != nil {
				errOnce.Do(func() {
					firstErr = fmt.Errorf("uploading %s: %w", key, err)
					cancel()
				})
			}
		}()
	}

	wg.Wait()

	if firstErr != nil {
		return nil, firstErr
	}
	return keys, nil
}

func (u Uploader) put(ctx context.Context, key string, k Kept) error {
	f, err := os.Open(k.Path)
	if err != nil {
		return fmt.Errorf("opening %s: %w", k.Path, err)
	}
	defer f.Close()

	_, err = u.Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(u.Bucket),
		Key:         aws.String(key),
		Body:        f,
		ContentType: aws.String("image/jpeg"),
	})
	return err
}

// NewClient builds the real S3 client for R2's S3-compatible API, so
// cmd/worker/main.go stays a wiring list rather than repeating SigV4 setup.
//
// accountID selects the endpoint — R2 has no separate region concept, so
// "auto" is the region the SDK is told and the account id is what actually
// routes the request (Cloudflare's R2 docs, not S3's). BaseEndpoint is set
// explicitly rather than left to the SDK's region-to-endpoint resolution,
// because that resolution only knows AWS's regions and would otherwise build
// an amazonaws.com URL that simply doesn't answer for this account.
//
// Credentials are static (credentials.NewStaticCredentialsProvider) rather
// than the SDK's default provider chain: the home box has no instance role,
// no shared credentials file and no metadata service for the chain to find,
// so the default chain would search several places that can never succeed
// before reaching the one that does — better to hand it the token directly.
func NewClient(ctx context.Context, accountID, accessKeyID, secretAccessKey string) (*s3.Client, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion("auto"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, "")),
	)
	if err != nil {
		return nil, fmt.Errorf("loading the R2 client config: %w", err)
	}

	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID)
	return s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
	}), nil
}
