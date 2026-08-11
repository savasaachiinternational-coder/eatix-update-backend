/**
 * Tiny process-local TTL cache for hot read endpoints.
 * No Redis required — safe for a single Nest instance (production today).
 */
type CacheEntry<T> = { value: T; expiresAt: number };

const store = new Map<string, CacheEntry<unknown>>();

const DEFAULT_MAX_ENTRIES = 500;

function pruneIfNeeded() {
  if (store.size <= DEFAULT_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  if (store.size <= DEFAULT_MAX_ENTRIES) return;
  // Drop oldest ~20% by expiry
  const sorted = [...store.entries()].sort(
    (a, b) => a[1].expiresAt - b[1].expiresAt,
  );
  const drop = Math.ceil(sorted.length * 0.2);
  for (let i = 0; i < drop; i++) store.delete(sorted[i][0]);
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + Math.max(0, ttlMs) });
  pruneIfNeeded();
}

export async function cacheGetOrSet<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  cacheSet(key, value, ttlMs);
  return value;
}

export function cacheDelete(key: string): void {
  store.delete(key);
}

export function cacheDeletePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Round coords for nearby cache buckets (~1.1km). */
export function roundCoordBucket(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return 'na';
  const f = 10 ** decimals;
  return String(Math.round(n * f) / f);
}
