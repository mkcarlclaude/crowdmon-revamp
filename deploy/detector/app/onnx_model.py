"""Runs OWL-ViT (google/owlvit-base-patch32) through ONNX Runtime.

The forward pass — image and text queries in, box logits out — is the
model.onnx export_model.py produces at image-build time, and the only thing
here doing the actual arithmetic. Everything else in this file is
preprocessing and postprocessing around that one call:

- Image preprocessing (resize, normalize) is hand-written in numpy rather
  than routed through transformers' OwlViTImageProcessor, because the
  processor's own transform is simple enough to state exactly —
  preprocessor_config.json for this model resizes to a fixed 768x768 with no
  center crop and no padding, so the normalized [0, 1] box coordinates this
  module returns are already the original image's own coordinates with no
  unletterboxing step required (a resize to a fixed square with independent
  per-axis scaling preserves fractional position exactly: a box at 50% of
  the resized width is at 50% of the original width too, whatever the
  original aspect ratio was). That fact is specific to this preprocessor
  config, not general — if the model is ever swapped for one that pads
  instead of stretching, this reasoning breaks and the postprocessing has to
  change with it.
- Text tokenization goes through transformers.CLIPTokenizerFast, loaded from
  a local directory export_model.py saved rather than fetched over the
  network — a tokenizer is not something worth reimplementing by hand
  (byte-pair encoding has edge cases a hand-rolled version would get wrong
  silently), and CLIPTokenizerFast needs no torch/tensorflow backend to run,
  so it costs nothing to keep in the runtime image (see requirements.txt).

**Not verified end-to-end.** This environment has no way to download the
multi-hundred-megabyte checkpoint or run a real export and inference pass, so
the exact ONNX output axis order below (believed correct from OWL-ViT's
documented `OwlViTObjectDetectionOutput` shapes: logits as
(batch, num_patches, num_queries), pred_boxes as (batch, num_patches, 4)) and
the text sequence length OWL-ViT was trained on (16, per the original
OwlViTProcessor's default) are the two numbers to confirm first against a
real image before this goes anywhere near the box. `_decode` asserts its
shape assumptions rather than silently producing wrong boxes if they are off.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np
import onnxruntime as ort
from PIL import Image
from transformers import CLIPTokenizerFast

from . import settings

# CLIP's published normalization constants (preprocessor_config.json for
# google/owlvit-base-patch32) — the same numbers every CLIP-family model
# uses, not specific to OWL-ViT.
_IMAGE_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
_IMAGE_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
_IMAGE_SIZE = 768

# OWL-ViT's trained text query length (OwlViTProcessor.__call__ defaults
# max_length to 16 for this model, unlike CLIP's usual 77) — every prompt is
# padded or truncated to exactly this so the tokenizer output always matches
# the shape model.onnx was exported against.
_TEXT_SEQ_LEN = 16


@dataclass(frozen=True)
class DetectedBox:
    class_name: str
    x_min: float
    y_min: float
    x_max: float
    y_max: float
    confidence: float


class OwlVitDetector:
    """Loads the exported graph and the tokenizer once, at process startup,
    and answers every /detect call against the same InferenceSession."""

    def __init__(self, model_dir: str = settings.MODEL_DIR):
        options = ort.SessionOptions()
        # See README.md's "Thread budget": two intra-op threads matches the
        # box's two physical cores, one inter-op thread because a single
        # sequential graph has nothing to run in parallel with itself.
        options.intra_op_num_threads = settings.INTRA_OP_THREADS
        options.inter_op_num_threads = settings.INTER_OP_THREADS
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        self._session = ort.InferenceSession(
            f"{model_dir}/model.onnx", sess_options=options, providers=["CPUExecutionProvider"]
        )
        self._tokenizer = CLIPTokenizerFast.from_pretrained(f"{model_dir}/tokenizer")

        # Serializes every call into the session. Today exactly one worker
        # process ever calls this sidecar, and worker/internal/worker's poll
        # loop claims and runs one job at a time (runner.go), so there is
        # never more than one /detect in flight to begin with — this lock is
        # defence in depth for the day CONTEXT.md's affinity constraint gets
        # a second worker, so two concurrent inferences can never fight over
        # the same two physical cores at once. Cheap to hold: nothing else
        # in this process contends for it.
        self._lock = threading.Lock()

    def detect(self, image: Image.Image, prompts: list[str]) -> list[list[DetectedBox]]:
        """Returns one list of boxes per prompt, in prompt order."""

        pixel_values = _preprocess_image(image)
        tokens = self._tokenizer(
            prompts,
            padding="max_length",
            max_length=_TEXT_SEQ_LEN,
            truncation=True,
            return_tensors="np",
        )

        with self._lock:
            logits, pred_boxes = self._session.run(
                ["logits", "pred_boxes"],
                {
                    "input_ids": tokens["input_ids"].astype(np.int64),
                    "attention_mask": tokens["attention_mask"].astype(np.int64),
                    "pixel_values": pixel_values,
                },
            )

        return _decode(logits, pred_boxes, len(prompts))


def _preprocess_image(image: Image.Image) -> np.ndarray:
    resized = image.convert("RGB").resize((_IMAGE_SIZE, _IMAGE_SIZE), Image.BICUBIC)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    array = (array - _IMAGE_MEAN) / _IMAGE_STD
    array = array.transpose(2, 0, 1)  # HWC -> CHW
    return array[np.newaxis, ...].astype(np.float32)  # add the batch dimension


def _decode(logits: np.ndarray, pred_boxes: np.ndarray, num_prompts: int) -> list[list[DetectedBox]]:
    # (batch=1, num_patches, num_queries) and (batch=1, num_patches, 4) — see
    # this module's docstring for why these axes and not some other order.
    if logits.ndim != 3 or pred_boxes.ndim != 3:
        raise RuntimeError(
            f"unexpected ONNX output shapes: logits {logits.shape}, pred_boxes {pred_boxes.shape}"
        )
    logits, pred_boxes = logits[0], pred_boxes[0]  # drop the batch dimension: always 1 image per call
    if logits.shape[-1] != num_prompts:
        raise RuntimeError(
            f"logits' last axis is {logits.shape[-1]}, want num_prompts ({num_prompts}) "
            "— the model.onnx export's axis order no longer matches this decoder's assumption"
        )

    # OWL-ViT is a multi-label per-query classifier, not a softmax over
    # classes — each of the num_patches candidate boxes gets an independent
    # sigmoid score against every prompt, so a patch can plausibly match more
    # than one class at once (a Paimon standing next to a chest, say) and it
    # would be wrong to force a single winner among them the way an argmax
    # over classes would.
    scores = 1.0 / (1.0 + np.exp(-logits))

    cx, cy, w, h = pred_boxes[:, 0], pred_boxes[:, 1], pred_boxes[:, 2], pred_boxes[:, 3]
    x_min = np.clip(cx - w / 2, 0.0, 1.0)
    y_min = np.clip(cy - h / 2, 0.0, 1.0)
    x_max = np.clip(cx + w / 2, 0.0, 1.0)
    y_max = np.clip(cy + h / 2, 0.0, 1.0)

    per_prompt: list[list[DetectedBox]] = []
    for j in range(num_prompts):
        class_scores = scores[:, j]
        # Deliberately no non-max suppression. CONTEXT.md §12: "the platform
        # is the product; detector accuracy is an afterthought," and this
        # system's whole point is a human verifying every box — a handful of
        # overlapping candidates for one Paimon costs a verifier a few extra
        # rejects, while NMS tuned wrong (too aggressive) would silently
        # drop a correct box before anyone ever saw it, which is the failure
        # this codebase cannot detect from the data alone.
        order = np.argsort(-class_scores)
        boxes: list[DetectedBox] = []
        for i in order:
            if class_scores[i] < settings.CONFIDENCE_FLOOR:
                break
            if len(boxes) >= settings.MAX_BOXES_PER_CLASS:
                break
            boxes.append(
                DetectedBox(
                    class_name="",  # filled in by the caller, which knows the prompt's name
                    x_min=float(x_min[i]),
                    y_min=float(y_min[i]),
                    x_max=float(x_max[i]),
                    y_max=float(y_max[i]),
                    confidence=float(class_scores[i]),
                )
            )
        per_prompt.append(boxes)
    return per_prompt
