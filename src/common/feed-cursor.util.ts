/**
 * Opaque keyset cursor for feed lists: the sort value of the last row (ISO date
 * string for "latest", number for "trending") plus its id as a tie-breaker.
 */
export interface FeedCursor {
  v: string | number;
  id: string;
}

export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Returns null for "start" or anything malformed → caller serves the first page. */
export function decodeFeedCursor(
  raw: string | undefined | null,
): FeedCursor | null {
  if (!raw || raw === 'start') return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.id !== 'string' || !parsed.id) return null;
    if (typeof parsed.v === 'number' && Number.isFinite(parsed.v)) {
      return { v: parsed.v, id: parsed.id };
    }
    if (typeof parsed.v === 'string' && !Number.isNaN(Date.parse(parsed.v))) {
      return { v: parsed.v, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}
