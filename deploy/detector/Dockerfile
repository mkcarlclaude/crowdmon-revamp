# The pre-labelling sidecar (M11.2, CONTEXT.md §12): a small HTTP service in
# front of an open-vocabulary detector, so the Go worker can stay Go. See
# README.md for why this is a separate process rather than in-process ONNX
# in worker/, why OWL-ViT over YOLO-World, and why there is no GPU support
# anywhere in this file.
#
# Two stages. The first exports google/owlvit-base-patch32 (pinned revision,
# export_model.py) to ONNX plus a local tokenizer directory; the second is
# the runtime image, and never installs torch — see README.md's "Why torch
# never reaches the runtime image."

# --- export ----------------------------------------------------------------
FROM python:3.13-slim AS export

WORKDIR /build

# PyTorch's own CPU wheel index, not PyPI's default — see
# requirements-build.txt for why a plain `pip install torch` is the wrong
# call here.
COPY requirements-build.txt .
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        --extra-index-url https://pypi.org/simple \
        -r requirements-build.txt

COPY export_model.py .
RUN python export_model.py

# --- runtime -----------------------------------------------------------------
FROM python:3.13-slim AS runtime

# CPU-only, deliberately: no CUDA base image, no `nvidia` runtime, no GPU
# device reservation anywhere in this file or in
# deploy/homebox/docker-compose.yml. See README.md — the box's 940MX is
# Maxwell (compute capability 5.0), and CUDA 13's release notes say plainly
# that Maxwell support is gone, so a GPU path here would mean pinning to a
# dead CUDA branch for a card with 2GB of VRAM. Not worth it, and the
# one-method Detector interface (worker/internal/worker/pipeline.go) is what
# makes that reversible if the hardware ever changes.

RUN useradd --create-home --shell /usr/sbin/nologin --uid 10001 detector
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=export /out /opt/model
COPY app ./app

# Tells GHCR which repository this image belongs to, matching worker/
# Dockerfile's own labels — see deploy/homebox/README.md's "How updates
# reach the box" for how crowdmon-update.service's prune step filters on
# this exact label.
LABEL org.opencontainers.image.source=https://github.com/mkcarlclaude/crowdmon-revamp
LABEL org.opencontainers.image.description="Crowdmon pre-labelling sidecar: OWL-ViT behind an HTTP API"
LABEL org.opencontainers.image.licenses=MIT

USER detector

# One uvicorn worker, deliberately — see app/main.py's docstring: a second
# process would load a second copy of the ONNX session into memory for no
# throughput gain, since only one caller (the Go worker's single-job poll
# loop) ever exists at a time.
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
