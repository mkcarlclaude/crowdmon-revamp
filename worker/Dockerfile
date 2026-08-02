# The worker ships as one image containing three things it cannot work
# without: the binary, ffmpeg, and yt-dlp. Extraction does not exist until M7,
# but the tools are baked in now so that M4.5's deployment is the one that
# gets tested, rather than a smaller image that is replaced the moment there
# is real work to do.

# --- build ---------------------------------------------------------------
# 1.25 matches the go directive raised by the OTel SDK in M4.1. Pinned to a
# minor, not to `latest`: a toolchain that changes underneath a rebuild turns
# an unrelated deploy into a compiler upgrade.
FROM golang:1.25-bookworm AS build

WORKDIR /src

# Dependencies first, and separately. They change far less often than the
# code, so this layer survives most rebuilds.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO off makes the binary static, which is what lets it run on a runtime
# image that shares nothing with this one. Trimpath and -w -s drop build
# paths and DWARF: smaller, and reproducible from any checkout directory.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags='-w -s' -o /out/worker ./cmd/worker

# --- runtime -------------------------------------------------------------
FROM debian:bookworm-slim

# Pinned deliberately. CONTEXT.md §9.8: YouTube changes its player and yt-dlp
# ships fixes roughly weekly, so a pinned binary means extraction stops
# working silently at some point after the last rebuild. The alternative —
# updating on start — trades that for a container whose behaviour depends on
# when it happened to boot, which is worse to debug and impossible to roll
# back. The real fix is scheduled rebuilds plus a health check that tells "no
# jobs queued" apart from "every job failing at download"; neither exists yet,
# and this line is where that debt is visible.
ARG YT_DLP_VERSION=2026.07.04
ARG YT_DLP_SHA256=6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae

# ca-certificates is not optional: the worker talks to the API and the
# collector over TLS, and a slim image has no roots. curl is build-time only.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ADD --checksum=sha256:${YT_DLP_SHA256} \
    https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux \
    /usr/local/bin/yt-dlp
RUN chmod 0755 /usr/local/bin/yt-dlp

# Unprivileged, and with a home directory: yt-dlp writes a cache there, and
# without one it falls back to paths that do not exist in this image.
RUN useradd --create-home --shell /usr/sbin/nologin --uid 10001 worker
USER worker
WORKDIR /home/worker

COPY --from=build /out/worker /usr/local/bin/crowdmon-worker

# Tells GHCR which repository this image belongs to, which is what links the
# package to the repo and lets it inherit the repo's permissions.
LABEL org.opencontainers.image.source=https://github.com/mkcarlclaude/crowdmon-revamp
LABEL org.opencontainers.image.description="Crowdmon home-side extraction worker"
LABEL org.opencontainers.image.licenses=MIT

# No CMD arguments and no shell form: the process must be PID 1 so that
# `docker stop` delivers SIGTERM to the worker itself. A shell wrapper would
# swallow it and the container would be killed at the end of the grace period
# instead of shutting down cleanly.
ENTRYPOINT ["/usr/local/bin/crowdmon-worker"]
