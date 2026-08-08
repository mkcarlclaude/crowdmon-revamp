"""The HTTP wire shapes /detect and /model speak.

Field names are already the snake_case worker/internal/detect.Client's Go
struct tags expect (x_min, class_name, prompt_version, ...), so pydantic's
default serialization needs no alias generator to match the contract —
unlike apps/api's zod schemas, there is no shared-language codegen here (the
worker crosses a Go/Python boundary the way it crosses Go/TypeScript to reach
the jobs API), so this file and worker/internal/detect/client.go's structs
are the two hand-written halves of one contract and have to be changed
together.
"""

from __future__ import annotations

from pydantic import BaseModel


class Prompt(BaseModel):
    name: str
    appearance: str
    version: str


class DetectRequest(BaseModel):
    image_key: str
    prompts: list[Prompt]


class Box(BaseModel):
    class_name: str
    x_min: float
    y_min: float
    x_max: float
    y_max: float
    confidence: float
    prompt_version: str


class DetectResponse(BaseModel):
    boxes: list[Box]


class ModelResponse(BaseModel):
    model_id: str


class ErrorResponse(BaseModel):
    # error is the discriminator worker/internal/detect.Client checks —
    # "object_missing" is the one value that means anything to it today.
    # detail is for a human reading logs or curling the endpoint by hand and
    # is never matched on.
    error: str
    detail: str = ""
