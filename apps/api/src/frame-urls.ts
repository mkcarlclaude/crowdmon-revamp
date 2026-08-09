import { AwsClient } from "aws4fetch";
import type { Bindings } from "./bindings";
import { PRESIGN_TTL_SECONDS } from "./schemas";

/**
 * Where a labelling session fetches frame bytes from (M13.4).
 *
 * CONTEXT.md §Q25 settles this as **batched short-lived presigned URLs**: one
 * call returns N images and their signed URLs, and the browser fetches from R2
 * directly. The argument is posture and cost together — the bucket stays
 * private with nothing enumerable, and a couple of hundred images per sitting
 * is where keeping bytes off Worker CPU stops being theoretical. M12.2's
 * dry-run grid proxies instead, and that is not a contradiction: fifty frames
 * rendered once is inside the noise §Q25 itself computes.
 *
 * **Two modes, because the credential is the one thing this repo cannot
 * create.** Signing needs an R2 S3 access key, which only a human with the
 * Cloudflare dashboard can mint — the same gate M8's bucket-scoped worker
 * token sat behind. Rather than have the whole verification UI answer 503
 * until that happens, a deployment with no credential configured falls back to
 * the Access-gated `/api/admin/image` proxy this Worker already serves. The
 * posture is identical in both modes (private bucket, gated access, no
 * enumeration); what differs is who moves the bytes, and that difference is on
 * the wire as `url_mode` so the UI can tell an expiry from a lost session.
 *
 * Setting the credential is what switches the mode — no code change, no
 * redeploy of anything but the secret:
 *
 * ```sh
 * wrangler secret put R2_ACCESS_KEY_ID
 * wrangler secret put R2_SECRET_ACCESS_KEY
 * # and FRAMES_S3_BASE_URL in wrangler.toml [vars]
 * ```
 */

export type FrameUrlMode = "signed" | "proxy";

export interface FrameUrls {
  mode: FrameUrlMode;
  /** Unix seconds. In `proxy` mode this is when the batch *would* have expired — see `LabellingBatch`. */
  expiresAt: number;
  byKey: Map<string, string>;
}

/**
 * The proxy URL for one key.
 *
 * Relative, like every other path the SPA calls (`apiFetch`'s own comment):
 * the Worker serving this response is the Worker serving the SPA, so an
 * absolute URL would only be a hostname to get wrong.
 */
export const proxyUrl = (key: string) => `/api/admin/image?key=${encodeURIComponent(key)}`;

/**
 * Both halves of the credential, or neither.
 *
 * A deployment with one of the two set is a deployment somebody is halfway
 * through configuring, and signing with a missing secret produces URLs that
 * are syntactically fine and rejected by R2 — a failure that would surface as
 * broken images in the UI rather than as anything an operator could read.
 * Falling back to the proxy keeps that half-configured state working.
 */
function credential(env: Bindings): { accessKeyId: string; secretAccessKey: string } | null {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const base = env.FRAMES_S3_BASE_URL;

  if (!accessKeyId || !secretAccessKey || !base) return null;
  return { accessKeyId, secretAccessKey };
}

/** Which mode this deployment is in, without signing anything. */
export const frameUrlMode = (env: Bindings): FrameUrlMode =>
  credential(env) === null ? "proxy" : "signed";

/**
 * URLs for a batch of keys, signed if this deployment can sign.
 *
 * One `AwsClient` for the whole batch rather than one per key: aws4fetch
 * caches the derived signing key on the instance, so twenty frames share four
 * HMACs instead of repeating them twenty times.
 *
 * `region: "auto"` is R2's own — it has no regions, and the string is what its
 * S3 endpoint expects in the credential scope.
 */
export async function frameUrls(
  env: Bindings,
  keys: string[],
  ttlSeconds: number = PRESIGN_TTL_SECONDS,
): Promise<FrameUrls> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const creds = credential(env);

  if (creds === null) {
    return { mode: "proxy", expiresAt, byKey: new Map(keys.map((key) => [key, proxyUrl(key)])) };
  }

  const client = new AwsClient({ ...creds, service: "s3", region: "auto" });
  // Trailing slashes on the configured base would produce `//frames/…`, which
  // S3 signs and R2 then reads as a key with an empty first segment: a 404 on
  // every frame, from a stray character in a variable.
  const base = (env.FRAMES_S3_BASE_URL ?? "").replace(/\/+$/, "");

  const signed = await Promise.all(
    keys.map(async (key) => {
      // Each segment encoded separately: an R2 key contains slashes that are
      // path structure, not data (`frames/<video>/<timestamp>.jpg`), and
      // encoding the whole key would turn them into `%2F` and sign a request
      // for an object that does not exist.
      const path = key
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");

      const url = new URL(`${base}/${path}`);
      // Set before signing, deliberately: `X-Amz-Expires` is part of the
      // canonical query string, so adding it afterwards would invalidate the
      // signature it was meant to bound.
      url.searchParams.set("X-Amz-Expires", String(ttlSeconds));

      const request = await client.sign(url.toString(), {
        method: "GET",
        aws: { signQuery: true },
      });

      return [key, request.url] as const;
    }),
  );

  return { mode: "signed", expiresAt, byKey: new Map(signed) };
}
