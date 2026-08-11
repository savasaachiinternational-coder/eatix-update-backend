/**
 * Mixkit retired `/videos/preview/...-large.mp4` (HTTP 403). Map to the
 * current public CDN path so App Review seed shorts still play.
 */
const MIXKIT_PREVIEW_RE =
  /^(https?:\/\/assets\.mixkit\.co\/videos\/preview\/)mixkit-.+-(\d+)(?:-large)?\.mp4(?:\?.*)?$/i;

export function normalizeShortVideoUrl(
  url: string | null | undefined,
): string {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const match = raw.match(MIXKIT_PREVIEW_RE);
  if (match) {
    const id = match[2];
    return `https://assets.mixkit.co/videos/${id}/${id}-720.mp4`;
  }
  return raw;
}

export function withNormalizedShortVideoUrl<T extends { videoUrl?: string | null }>(
  short: T,
): T {
  if (!short || short.videoUrl == null) return short;
  const next = normalizeShortVideoUrl(short.videoUrl);
  if (next === short.videoUrl) return short;
  return { ...short, videoUrl: next };
}
