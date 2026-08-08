# The pre-labelling sidecar

A small Python HTTP service in front of an open-vocabulary object detector.
It is what `worker/internal/detect.Client` talks to, and the production
implementation behind `worker.Detector` (`worker/internal/worker/pipeline.go`):
image key and prompts in, boxes with confidences and a model identifier out.
M11.2, `CONTEXT.md` §12.

## Why a sidecar and not in-process ONNX in the worker

The repo owner's call, not re-litigated here: open-vocabulary detection needs
a CLIP-style tokenizer to turn the class prompts into text embeddings, and
getting byte-pair encoding right by hand in Go is a worse bet than taking a
well-exercised Python one — the same argument
`worker/internal/frames/upload.go` makes for taking the AWS SDK's SigV4
signer instead of hand-rolling R2's. Go posts JSON over HTTP; this service
holds the model and does the preprocessing.

## Why OWL-ViT, and not YOLO-World

Both are named as the obvious candidates in issue #102. The deciding
argument is not benchmark accuracy — `CONTEXT.md` §12 already says accuracy
is an afterthought for this milestone — it is what actually deploys as an
open-vocabulary model on this hardware:

- **YOLO-World's standard ONNX export bakes the vocabulary in.**
  Ultralytics' `model.export(format="onnx")` for YOLO-World requires calling
  `set_classes()` first, and the resulting graph carries those class text
  embeddings as constants. Changing which classes get detected then means
  re-exporting and shipping a new image — exactly the redeploy-to-relabel
  cost an open-vocabulary model exists to avoid, and it directly conflicts
  with where this project is going: `classes` is already a table (M10), and
  `CONTEXT.md` §12 names "classes as data" as its own milestone (M11.2 is
  the one before it). A detector that needs a rebuild every time an admin
  edits a prompt is not meaningfully open-vocabulary in the way this
  pipeline needs it to be. Checked at the time this was written: no mature,
  widely-used ONNX export of YOLO-World keeps the text tower dynamic — the
  handful that exist on the Hugging Face Hub are single-digit-download
  personal uploads, not something to build production inference on.
- **OWL-ViT's ONNX deployment path keeps the text tower dynamic.** The
  community export this sidecar is built around (the same shape used by
  `transformers.js` for in-browser zero-shot detection) takes tokenized text
  as a runtime input, not a compile-time constant — a prompt change is a new
  request, not a new image.
- **`base-patch32`, specifically, is the cost-conscious variant.** OWL-ViT's
  vision tower is a ViT operating on 32×32 patches over a 768×768 image —
  576 patches, the smallest token count any OWL-ViT variant produces
  (`patch16` would be four times that, and attention cost grows with the
  square of the token count). That token count, not model accuracy, is why
  this is the variant issue #102 names and the one this sidecar exports.
  Quantized (`int8`, via ONNX Runtime's dynamic quantization at export time)
  roughly halves the matmul cost again on a CPU with no GPU to fall back on.

The real cost is still real: a ViT forward pass on two CPU cores is seconds,
not milliseconds, per image. `CONTEXT.md` §12 already budgeted for that —
"open-vocabulary detection on that CPU is seconds per image; 200 frames is
minutes per video" — and that sentence was written with this exact model in
mind. **Not verified end-to-end** (below) is what qualifies this whole
section: nothing here has actually been timed on the box, because nothing
here has actually been deployed to it.

## Why CPU-only — the 940MX question is closed

The box's GeForce 940MX is Maxwell, compute capability 5.0, 2GB VRAM. CUDA
13's release notes say plainly: *"Removed support for Maxwell, Pascal, and
Volta GPUs, corresponding to compute capabilities earlier than Turing."*
Making it work would mean pinning this whole image to a CUDA 12.x base and
to wheels that still ship `sm_50` kernels — a dead branch to build a new
service on, for a card with less VRAM than this image's own runtime
footprint. There is no GPU support anywhere in this directory: no CUDA base
image, no `deploy.resources.reservations.devices` block, no
`runtime: nvidia`, and none should be added. `CONTEXT.md` §12 records this as
closed rather than "worth re-measuring" — the one-method `Detector`
interface is what makes that reversible if the hardware ever changes.

## Thread budget

The box is an i5-7200U — two physical cores, four logical with
hyperthreading — already running nine containers (the monitoring stack plus
the worker). This service and the worker's own ffmpeg extraction never
actually compete for those cores at the same instant: `worker/internal/worker`'s
poll loop (`runner.go`) claims and runs exactly one job at a time, so a chunk
job's ffmpeg and a prelabel job's `/detect` call cannot both be running in
this one worker process simultaneously. What *is* real contention is the
rest of the box — Loki, Tempo, Prometheus, Grafana, the otel-collector,
`node_exporter`, `dcgm_exporter`, `cloudflared`, and now this sidecar — none
of which is compute-heavy on its own, but all of which share the same two
physical cores.

- `intra_op_num_threads = 2` (`app/settings.py`) — matched to the box's
  *physical* core count, not the four logical ones. Matrix-multiply-bound
  ONNX Runtime work gets little from hyperthreading (both threads on a
  core share its execution units), so requesting four would mostly add
  scheduling overhead against a box that already has other containers
  wanting the same four logical threads.
- `inter_op_num_threads = 1` — there is exactly one op graph in flight per
  request (`onnx_model.OwlVitDetector` serializes calls behind a lock), so
  there is nothing for a second inter-op thread to run in parallel with.
- `docker-compose.yml`'s `deploy.resources.limits.cpus: "2.0"` caps the
  container at the box's physical core count for the same reason —
  onnxruntime's own thread pool is the only thing in this container that
  would ever try to use more.
- One uvicorn worker process (`Dockerfile`'s `CMD`), not several: a second
  process would load a second copy of the ONNX session into memory (roughly
  a hundred megabytes, quantized) for zero throughput gain, since there is
  never more than one caller.

## Getting bytes from R2

The sidecar fetches image bytes itself, with its own scoped credential
(`CROWDMON_DETECTOR_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`,
`deploy/homebox/.env.example`) — not the worker's, and not bytes the worker
sends over the wire. Weighed against the alternative (the worker reads the
object with the S3 client it already holds for uploads, and posts the bytes
to `/detect`):

- **The wire contract stays plain JSON.** `image_key` plus prompts in, boxes
  out — no multipart body, no base64 bloat, and the Go tests
  (`worker/internal/detect/client_test.go`) never need to construct fake
  image bytes to exercise the client.
- **Image ownership and image preprocessing belong together.** This service
  already has to hold the decoded image in memory to run the model; fetching
  it itself means Go never decodes bytes it has no other use for.
- **The `ErrObjectMissing` classification is sourced at the point of
  truth.** issue #102's requirement — *"a missing object is terminal and
  burns the video, a sidecar that is down must not be"* — is naturally this
  sidecar's own `GetObject` outcome, not something Go would have to
  re-derive from a relayed blob with no error attached.

The cost accepted deliberately: a second R2 token to mint by hand
(`CLAUDE.md` already documents this friction for the worker's own upload
token) and a second, smaller S3 client (`app/storage.py`) to maintain in a
second language. Scoped to **Object Read only** on `crowdmon-frames` — this
sidecar never writes to R2, and a compromised container with a read-only
token cannot touch or delete the frames the worker already uploaded.

### The 404 discrimination contract

`GET /detect` answers a missing object with **HTTP 404** and a JSON body
`{"error": "object_missing", "detail": "..."}` — both together, not the
status code alone. `worker/internal/detect.Client` only maps this exact
combination onto `worker.ErrObjectMissing`; a bare 404 (an unmatched route,
say, from a mistyped `CROWDMON_DETECTOR_BASE_URL`) is left as a plain
retryable error instead. Getting this wrong in either direction is the
expensive bug the issue calls out: a live object wrongly reported missing
burns a video that was never broken, and a genuinely missing object left
retryable retries forever against a 404 that will never change.

## Not verified end-to-end

This environment has no way to download the checkpoint (several hundred
megabytes), run the ONNX export, or run a real inference pass — so the
following are reasoned from OWL-ViT's documented architecture and
`preprocessor_config.json`, not confirmed by executing this code:

- **The ONNX output axis order** `app/onnx_model.py._decode` assumes
  (`logits` as `(batch, num_patches, num_queries)`, `pred_boxes` as
  `(batch, num_patches, 4)`) — asserted at runtime with a clear error rather
  than trusted silently, so a wrong assumption fails loudly on the first
  real request instead of producing plausible-looking garbage boxes.
- **The text sequence length (16)** OWL-ViT was trained against — taken from
  the original `OwlViTProcessor`'s default, not confirmed against the
  exported graph.
- **The actual per-image latency** on an i5-7200U, referenced above as
  "seconds" on the strength of `CONTEXT.md` §12's existing budget rather
  than a measurement taken for this change.

`export_model.py` and `app/onnx_model.py` are the pair to smoke-test
together first, against one real image, before this ever runs against a
prelabel job.

## Building and running

```sh
docker build -t crowdmon-detector deploy/detector
```

Two stages (`Dockerfile`): the first exports the pinned checkpoint to ONNX
(`export_model.py`, needs `torch` and network access to Hugging Face); the
second is the runtime image, and never installs `torch` — see
`requirements.txt`'s comment for why a plain `pip install transformers`
does not pull it in as a dependency.

Wired into `deploy/homebox/docker-compose.yml` as the `detector` service,
alongside the worker. `CROWDMON_DETECTOR_BASE_URL` in
`deploy/homebox/.env.example` is commented out by default — a box that
has not minted the sidecar's R2 token yet still runs download and chunk
jobs exactly as it always has (`worker/internal/config.DetectorEnabled()`).
