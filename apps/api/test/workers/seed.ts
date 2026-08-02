import { env } from "cloudflare:test";

/**
 * Rows written straight to D1 rather than through the API.
 *
 * Chunk jobs have no submit endpoint — M7.2's fan-out creates them — so a test
 * that wants one has to write it. Download jobs go through SQL here too, so
 * the queue tests are not also testing the submit handler.
 */

export async function seedVideo(id: string) {
  await env.DB.prepare("INSERT INTO videos (id, url) VALUES (?, ?)")
    .bind(id, `https://www.youtube.com/watch?v=${id}`)
    .run();
}

export async function seedDownloadJob(videoId: string) {
  await seedVideo(videoId);
  await env.DB.prepare("INSERT INTO jobs (kind, video_id) VALUES ('download', ?)")
    .bind(videoId)
    .run();
}
