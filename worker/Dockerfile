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
#
# The debt came due on 2026-08-21, and not in the shape this comment expected.
ARG YT_DLP_VERSION=2026.08.19
ARG YT_DLP_SHA256=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a

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

# A JavaScript engine, and it is not optional any more.
#
# **This is what actually broke on 2026-08-21**, and the version bump above
# was not the fix — every `download` job was failing with
# `unable to download video data: HTTP Error 403: Forbidden`, and the pinned
# 2026.07.04 binary reproduced it just as faithfully as the newest release
# does without this.
#
# YouTube signs media URLs with an `n` parameter that has to be descrambled by
# running a function out of the player's own JavaScript. yt-dlp cannot do that
# with no engine to run it in, so it requests the stream with the scrambled
# value: YouTube serves the first chunk, then answers every subsequent range
# request with a 403. The failure therefore looks nothing like a signature
# error and everything like a transient network fault — the download starts,
# reports a real size and a healthy rate, and dies partway in. Measured on the
# home box against one real video, worker's exact flags, same binary, same
# minute: 403 at 0.6% of 1.65GiB without a runtime, 30.9% and still climbing
# with one.
#
# It is also why a `--test` run (10 KiB, one range request) succeeds against a
# broken image and proves nothing. Any check that this still works has to pull
# enough of a real video to need a second range request — see the smoke test
# in `deploy/homebox/README.md`.
#
# `COPY --from` a pinned upstream image rather than the release zip: Debian
# slim ships no `unzip`, and installing one to unpack a single binary means
# carrying it in the image or a second layer to drop it again. Digest-pinned
# because `bin-2.9.5` is a mutable tag, and a runtime that silently changes
# under a rebuild is exactly the class of surprise the yt-dlp pin exists to
# prevent.
COPY --from=denoland/deno:bin-2.9.5@sha256:0d1262facd139e815217c001945eb822c7a78584cf660142c34a6b53effec1aa \
     /deno /usr/local/bin/deno

# Unprivileged, and with a home directory: yt-dlp writes a cache there, and
# without one it falls back to paths that do not exist in this image.
RUN useradd --create-home --shell /usr/sbin/nologin --uid 10001 worker
USER worker
WORKDIR /home/worker

# Created here, as `worker`, and that is load-bearing rather than tidy: the
# compose file mounts a named volume over this path, and Docker seeds a fresh
# volume with the ownership of the directory it covers. Left absent from the
# image, the volume would be created root-owned, and the unprivileged process
# would fail every download with permission denied — on a box where the
# directory visibly exists.
RUN mkdir -p /home/worker/videos

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
