"""Build-time export: bakes google/owlvit-base-patch32 (pinned revision) into
an ONNX graph plus a local tokenizer directory, both copied into the runtime
image by the Dockerfile's second stage.

Runs once, inside the builder stage, which is the only place in this image
that ever imports torch or hits the network for a model file — see
README.md's "Why torch never reaches the runtime image." app/onnx_model.py
is this script's runtime counterpart and the two are written to agree on
input/output names and shapes; changing one without the other is the one way
to break this quietly, since nothing here re-validates the pair against a
real image (README.md's "Not verified end-to-end" says why that could not be
done in this environment).
"""

from __future__ import annotations

import pathlib

import torch
from transformers import CLIPTokenizerFast, OwlViTForObjectDetection

MODEL_REPO = "google/owlvit-base-patch32"

# The commit google/owlvit-base-patch32 pointed at when this was pinned
# (2026-08-08, confirmed against the HuggingFace Hub API). Any later commit —
# even a metadata-only one — is not this string, so `from_pretrained` with no
# revision would silently start pulling whatever the repo serves the next
# time this image is rebuilt. app/settings.py carries the same string for
# GET /model to report; the two are not read from one shared constant only
# because a build-time script and a runtime package importing from each
# other would tangle this image's two stages together for no benefit.
MODEL_REVISION = "cbc355fb364588351c5d51c7f74465e8e7ec6f72"

OUT_DIR = pathlib.Path("/out")

# OWL-ViT's trained text query length — see app/onnx_model.py's docstring.
TEXT_SEQ_LEN = 16
IMAGE_SIZE = 768


class ForwardOnly(torch.nn.Module):
    """torch.onnx.export traces whatever forward() returns, and OWL-ViT's own
    forward returns a dataclass the exporter cannot flatten into named ONNX
    outputs on its own. This wrapper is the seam that picks the two tensors
    app/onnx_model.py actually reads, in the fixed order this export names
    them."""

    def __init__(self, inner: OwlViTForObjectDetection):
        super().__init__()
        self.inner = inner

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor, pixel_values: torch.Tensor):
        out = self.inner(input_ids=input_ids, attention_mask=attention_mask, pixel_values=pixel_values)
        return out.logits, out.pred_boxes


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    model = OwlViTForObjectDetection.from_pretrained(MODEL_REPO, revision=MODEL_REVISION)
    model.eval()

    # Saved as a plain local directory rather than left in HuggingFace's
    # cache format, so the runtime stage can load it with no network access
    # and no dependency on the cache layout matching between build and run —
    # CLIPTokenizerFast.from_pretrained("/opt/model/tokenizer") reads exactly
    # the four files this writes (vocab.json, merges.txt, tokenizer_config.
    # json, special_tokens_map.json), nothing else.
    # The tokenizer directly, not via OwlViTProcessor.
    #
    # OwlViTProcessor bundles a tokenizer *and* an image processor, and
    # constructing one resolves both — which fails outright in this builder
    # stage, because an OWL-ViT image processor needs torchvision or Pillow
    # and neither is installed here:
    #
    #   ValueError: Could not load any image processor class for
    #   google/owlvit-base-patch32. Missing optional dependencies:
    #   torchvision, Pillow.
    #
    # Adding those to requirements-build.txt would fix the symptom and be the
    # wrong answer: nothing in this file preprocesses an image. The export
    # feeds torch.onnx.export a dummy pixel tensor it builds itself, below,
    # and the *runtime* does its own resizing with its own Pillow
    # (requirements.txt, app/onnx_model.py). The only thing wanted from the
    # repo here is the four tokenizer files, so asking for the tokenizer is
    # both what makes this work and what honestly describes the dependency.
    #
    # CLIPTokenizerFast specifically, rather than AutoTokenizer: the runtime
    # loads this directory back with exactly that class, and naming the same
    # one on both sides means the files written here cannot be a class the
    # reader cannot construct.
    tokenizer = CLIPTokenizerFast.from_pretrained(MODEL_REPO, revision=MODEL_REVISION)
    tokenizer.save_pretrained(OUT_DIR / "tokenizer")

    dummy_pixel_values = torch.zeros(1, 3, IMAGE_SIZE, IMAGE_SIZE, dtype=torch.float32)
    dummy_input_ids = torch.zeros(1, TEXT_SEQ_LEN, dtype=torch.int64)
    dummy_attention_mask = torch.ones(1, TEXT_SEQ_LEN, dtype=torch.int64)

    torch.onnx.export(
        ForwardOnly(model),
        (dummy_input_ids, dummy_attention_mask, dummy_pixel_values),
        str(OUT_DIR / "model.onnx"),
        input_names=["input_ids", "attention_mask", "pixel_values"],
        output_names=["logits", "pred_boxes"],
        # Only the prompt count stays dynamic. A fixed image size is not a
        # real constraint — every image this sidecar ever sees is resized to
        # IMAGE_SIZE before it reaches the graph (app/onnx_model.py) — but a
        # fixed prompt count would mean re-exporting this image every time
        # the active class count changes, which is exactly the
        # redeploy-to-relabel failure an open-vocabulary model was chosen to
        # avoid (CONTEXT.md §12).
        dynamic_axes={
            "input_ids": {0: "num_prompts"},
            "attention_mask": {0: "num_prompts"},
            "logits": {2: "num_prompts"},
        },
        opset_version=17,
    )


if __name__ == "__main__":
    main()
