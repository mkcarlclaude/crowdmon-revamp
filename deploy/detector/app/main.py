"""The sidecar's HTTP surface: GET /health, GET /model, POST /detect.

One process, one uvicorn worker (see the Dockerfile's CMD) — a second worker
process would load a second copy of the ONNX session into memory for no
throughput gain, since onnx_model.OwlVitDetector already serializes every
call behind one lock and there is only ever one caller (see that module's
docstring for why).
"""

from __future__ import annotations

import io
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse
from PIL import Image

from . import settings
from .onnx_model import OwlVitDetector
from .schemas import Box, DetectRequest, DetectResponse, ErrorResponse, ModelResponse
from .storage import ObjectMissingError, R2Store

logger = logging.getLogger("crowdmon.detector")


class State:
    """Holds the two things startup builds once: the model session and the
    R2 client. A plain mutable object rather than FastAPI's dependency
    injection — there is exactly one of each for the process's whole life,
    so DI would add indirection without adding a second implementation it
    ever needs to swap in."""

    detector: OwlVitDetector | None = None
    store: R2Store | None = None


state = State()


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.require_r2_credentials()
    state.store = R2Store(
        settings.R2_ACCOUNT_ID, settings.R2_BUCKET, settings.R2_ACCESS_KEY_ID, settings.R2_SECRET_ACCESS_KEY
    )
    # Loaded last, and this is the slow step — reading the ONNX graph off
    # disk and letting onnxruntime plan it. GET /health (below) only answers
    # 200 once this line returns, which is what makes
    # docker-compose.yml's `depends_on: condition: service_healthy` a real
    # guarantee rather than a formality: the worker container does not start
    # until a model is actually loaded and able to answer, not just until
    # this process exists.
    state.detector = OwlVitDetector()
    logger.info("model loaded: %s", settings.MODEL_ID)
    yield
    # Nothing to release on shutdown: the ONNX session and the boto3 client
    # both close with the process, and this sidecar holds no lease or
    # in-flight job state the way the Go worker does — a killed container
    # loses nothing worth flushing.


app = FastAPI(title="crowdmon-detector", lifespan=lifespan)


@app.get("/health")
def health() -> Response:
    if state.detector is None:
        return JSONResponse(status_code=503, content={"error": "not_ready", "detail": "model is still loading"})
    return Response(status_code=200)


@app.get("/model", response_model=ModelResponse)
def model_id() -> ModelResponse:
    # What worker/internal/detect.Client.ModelID() reports for every
    # prediction this sidecar produces (M11.2) — read once at worker startup
    # and cached there, never hardcoded on the Go side, so that swapping the
    # model here (an image rebuild, nothing in the Go repo) is visible in the
    # data instead of inferred from a deploy date.
    return ModelResponse(model_id=settings.MODEL_ID)


def _error(status: int, error: str, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status, content=ErrorResponse(error=error, detail=detail).model_dump())


@app.post("/detect", response_model=DetectResponse)
def detect(body: DetectRequest) -> Response:
    assert state.store is not None and state.detector is not None  # lifespan guarantees both before any request is routed

    try:
        raw = state.store.fetch(body.image_key)
    except ObjectMissingError as exc:
        # The one classification worker/internal/detect.Client is watching
        # for: "object_missing" at 404 is what it maps onto
        # worker.ErrObjectMissing, which pipeline.go's prelabel branch then
        # marks Terminal. Every other failure below is a plain 502 — always
        # retryable at the Go side, per terminal.go's default.
        return _error(404, "object_missing", str(exc))
    except Exception as exc:  # noqa: BLE001 - any other R2 failure is this sidecar's problem, not the caller's to diagnose
        logger.exception("fetching %s from R2 failed", body.image_key)
        return _error(502, "storage_error", str(exc))

    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except Exception as exc:  # noqa: BLE001
        logger.exception("decoding %s failed", body.image_key)
        return _error(502, "decode_error", str(exc))

    try:
        per_prompt = state.detector.detect(image, [p.appearance for p in body.prompts])
    except Exception as exc:  # noqa: BLE001 - a model failure is this sidecar's bug, not the image's — still retryable, never object_missing
        logger.exception("detecting on %s failed", body.image_key)
        return _error(502, "detect_error", str(exc))

    boxes = [
        Box(
            class_name=prompt.name,
            x_min=found.x_min,
            y_min=found.y_min,
            x_max=found.x_max,
            y_max=found.y_max,
            confidence=found.confidence,
            prompt_version=prompt.version,
        )
        for prompt, boxes_for_prompt in zip(body.prompts, per_prompt)
        for found in boxes_for_prompt
    ]
    return JSONResponse(status_code=200, content=DetectResponse(boxes=boxes).model_dump())
