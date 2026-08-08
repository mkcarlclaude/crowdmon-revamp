"""Runtime configuration, read from the environment exactly once at import.

Mirrors worker/internal/config's own argument for reading everything from the
environment rather than flags or files: this process also runs as a
container on the home box, so the environment is its only configuration
surface. Unlike that package, this one does not need a Load() with
constructor injection for tests — there is no Go-style table of
environment-parsing unit tests here, because the values below are either
baked into the image at build time (the model, the tokenizer — see
export_model.py) or plain required strings with no parsing to get wrong.
"""

import os

# The model this image ships. Pinned in export_model.py, repeated here only
# as the human-readable half of what GET /model reports — the ONNX graph and
# the tokenizer directory both come from the same build step, so there is
# nothing to keep in sync by hand.
MODEL_REPO = "google/owlvit-base-patch32"
MODEL_REVISION = "cbc355fb364588351c5d51c7f74465e8e7ec6f72"
MODEL_ID = f"owlvit-base-patch32@{MODEL_REVISION[:7]}"

MODEL_DIR = os.environ.get("DETECTOR_MODEL_DIR", "/opt/model")

# Cloudflare's account id and the frames bucket are not secrets and are the
# same values worker/internal/config.Config.R2AccountID / R2Bucket carry —
# reused by name rather than given a DETECTOR_-prefixed twin, because there
# is only one account and one bucket and restating them would just be a
# second place for a typo to point this sidecar at the wrong one.
R2_ACCOUNT_ID = os.environ.get("CROWDMON_R2_ACCOUNT_ID", "")
R2_BUCKET = os.environ.get("CROWDMON_R2_BUCKET", "crowdmon-frames")

# The sidecar's own R2 token, scoped Object Read only on CROWDMON_R2_BUCKET —
# deliberately not the worker's upload token. See README.md's "Getting bytes
# from R2" for why this sidecar holds a credential at all rather than having
# the worker forward bytes, and why that credential is its own rather than
# the worker's reused.
R2_ACCESS_KEY_ID = os.environ.get("CROWDMON_DETECTOR_R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("CROWDMON_DETECTOR_R2_SECRET_ACCESS_KEY", "")

# Thread budget for onnxruntime's CPU execution provider. Not exposed as
# environment variables the way CROWDMON_DEDUP_THRESHOLD is — these are a
# property of the box this service runs on (an i5-7200U, two physical cores,
# CONTEXT.md §2), not a per-deployment preference, and there is exactly one
# deployment. See README.md's "Thread budget" for the numbers' justification.
INTRA_OP_THREADS = 2
INTER_OP_THREADS = 1

# A confidence floor and a per-class cap, both applied after the sigmoid in
# onnx_model.py. Neither is a modelling decision worth making configurable
# here: CONTEXT.md §12 is explicit that "detector accuracy is an
# afterthought" for this milestone, and M12 ("classes as data") is where a
# per-class threshold becomes something an admin tunes without a deploy —
# adding a knob for it now would be building that milestone's surface early
# with no UI behind it.
CONFIDENCE_FLOOR = 0.1
MAX_BOXES_PER_CLASS = 10


def require_r2_credentials() -> None:
    """Fails loudly at startup rather than on the first /detect call.

    The same argument cmd/worker/main.go's UploadsEnabled() check makes for
    R2: a sidecar that came up without a working credential would fail every
    request it received, and discovering that from inside a prelabel job's
    retry loop is a worse first symptom than a container that never reports
    healthy in the first place — which is what makes docker-compose.yml's
    `depends_on: condition: service_healthy` refuse to start the worker at
    all.
    """
    missing = [
        name
        for name, value in (
            ("CROWDMON_R2_ACCOUNT_ID", R2_ACCOUNT_ID),
            ("CROWDMON_DETECTOR_R2_ACCESS_KEY_ID", R2_ACCESS_KEY_ID),
            ("CROWDMON_DETECTOR_R2_SECRET_ACCESS_KEY", R2_SECRET_ACCESS_KEY),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            "the detector cannot reach R2 without " + ", ".join(missing)
        )
