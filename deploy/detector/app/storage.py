"""R2 access for this sidecar's own scoped credential.

A second, small S3-compatible client rather than a shared library with
worker/internal/frames/upload.go — the two are different languages and this
one only ever reads, never writes, so there is no signer logic worth sharing
even in spirit; boto3 already carries SigV4 the same way the AWS SDK for Go
does, for the same reason upload.go gives for taking it as a dependency
rather than hand-rolling R2's signature.
"""

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from . import settings


class ObjectMissingError(Exception):
    """Raised when R2 answers with a genuine 404 for the requested key.

    The one classification this whole module exists to make. app.main maps
    this, and only this, onto the "object_missing" response body that
    worker/internal/detect.Client checks for before wrapping
    worker.ErrObjectMissing — every other failure below (a network error, a
    permissions error, a bucket that does not exist) is left as a plain
    exception, which app.main turns into a 502 instead. Getting the two
    confused is the expensive bug either direction: a live object reported
    missing burns a video that was never actually broken, and a missing
    object reported as a transient failure retries forever against a 404
    that will never change.
    """

    def __init__(self, key: str):
        super().__init__(f"object {key!r} is not in the bucket")
        self.key = key


class R2Store:
    """Fetches one object's bytes from the frames bucket."""

    def __init__(self, account_id: str, bucket: str, access_key_id: str, secret_access_key: str):
        self._bucket = bucket
        # region_name="auto": R2 has no region concept of its own, the same
        # fact worker/internal/frames/upload.go's NewClient documents for the
        # Go SDK. The endpoint, not a region, is what actually routes the
        # request to this account.
        self._client = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
            config=BotoConfig(retries={"max_attempts": 2, "mode": "standard"}),
        )

    def fetch(self, key: str) -> bytes:
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if _is_not_found(exc):
                raise ObjectMissingError(key) from exc
            raise
        return response["Body"].read()


def _is_not_found(exc: ClientError) -> bool:
    error = exc.response.get("Error", {})
    status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    # R2 answers a missing key with botocore's own NoSuchKey where it
    # recognises the shape, and with a bare 404 status where it does not
    # (R2's S3-compatible surface does not implement every AWS error code
    # exactly) — checked both ways so an R2 quirk in the error body does not
    # make a genuinely missing object look like an unclassified failure.
    return status == 404 or error.get("Code") in ("NoSuchKey", "404")
