/**
 * Lightweight Prisma selects for home/feed list cards.
 * Omits editor metadata, mime/file size, and other playback-only fields
 * that home carousels never need — smaller payloads + faster queries.
 */

export const MEDIA_USER_CARD_SELECT = {
  id: true,
  name: true,
  nickname: true,
  role: true,
  photos: true,
  latitude: true,
  longitude: true,
} as const;

export const VIDEO_CARD_SELECT = {
  id: true,
  userId: true,
  title: true,
  thumbnailUrl: true,
  videoUrl: true,
  duration: true,
  status: true,
  visibility: true,
  viewCount: true,
  likeCount: true,
  commentCount: true,
  shareCount: true,
  category: true,
  createdAt: true,
  publishedAt: true,
  scheduledPublishAt: true,
  user: { select: MEDIA_USER_CARD_SELECT },
  _count: {
    select: {
      likes: true,
      comments: true,
      views: true,
    },
  },
} as const;

export const SHORT_CARD_SELECT = {
  id: true,
  userId: true,
  title: true,
  thumbnailUrl: true,
  coverUrl: true,
  videoUrl: true,
  duration: true,
  status: true,
  visibility: true,
  viewCount: true,
  likeCount: true,
  commentCount: true,
  shareCount: true,
  category: true,
  isLive: true,
  createdAt: true,
  publishedAt: true,
  user: { select: MEDIA_USER_CARD_SELECT },
  _count: {
    select: {
      likes: true,
      comments: true,
      views: true,
    },
  },
} as const;

/** Clamp list page size for public feeds (prevents accidental huge pulls). */
export function clampListLimit(
  limit: number | undefined,
  fallback = 20,
  max = 50,
): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}
