/**
 * Pulls the video id out of a YouTube URL.
 *
 * This is a server detail, not part of the wire contract: `SubmitVideoRequest`
 * accepts any URL, so what counts as a YouTube URL can change without that
 * being a breaking API change. Callers submit the link they have.
 *
 * The id is the primary key of `videos`, so getting it wrong is not a cosmetic
 * failure — a bad id becomes a row nothing can join to and a download job that
 * can only fail on the worker.
 */

// Eleven characters of the URL-safe base64 alphabet. YouTube has used this
// shape since 2007, and anchoring the match means `?v=tooshort` is rejected
// here rather than at yt-dlp, an hour later, on the home box.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const WATCH_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  // Serves the same watch URLs without the tracking parameters; people paste
  // it because that is what the share button offers.
  "music.youtube.com",
]);

export function youtubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const candidate = extractCandidate(parsed);

  return candidate && VIDEO_ID.test(candidate) ? candidate : null;
}

function extractCandidate(url: URL): string | null {
  // youtu.be/<id> — the whole path is the id.
  if (url.hostname === "youtu.be") {
    return url.pathname.slice(1).split("/")[0] ?? null;
  }

  if (!WATCH_HOSTS.has(url.hostname)) return null;

  // /shorts/<id> and /embed/<id> carry the id in the path; everything else
  // uses ?v=. Checked before ?v= so a shorts link with a stray query string
  // does not silently take the wrong one.
  const [, section, id] = url.pathname.split("/");
  if ((section === "shorts" || section === "embed") && id) return id;

  return url.searchParams.get("v");
}
