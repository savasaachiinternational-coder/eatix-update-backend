/**
 * Hot-read cache for list/feed endpoints.
 * Uses Redis when REDIS_URL is set and `ioredis` is installed; otherwise
 * an in-process TTL Map (safe for a single Nest instance).
 *
 * Optional: `yarn add ioredis` and set REDIS_URL=redis://localhost:6379
 */
type CacheEntry<T> = { value: T; expiresAt: number };

const store = new Map<string, CacheEntry<unknown>>();
const DEFAULT_MAX_ENTRIES = 500;
const KEY_PREFIX = 'eatix:';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redisClient: any = undefined;
let redisInitTried = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRedisSync(): any | null {
  if (redisInitTried) return redisClient ?? null;
  redisInitTried = true;
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    redisClient = null;
    return null;
  }
  try {
    // Optional dependency — not required for single-instance deploys.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Redis = require('ioredis');
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      retryStrategy: () => null,
    });
    client.on('error', () => {
      /* avoid unhandled; commands fall through to memory */
    });
    redisClient = client;
    return redisClient;
  } catch {
    redisClient = null;
    return null;
  }
}

function pruneIfNeeded() {
  if (store.size <= DEFAULT_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  if (store.size <= DEFAULT_MAX_ENTRIES) return;
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
  const redis = getRedisSync();
  if (!redis) return;
  try {
    const payload = JSON.stringify(value);
    const sec = Math.max(1, Math.ceil(ttlMs / 1000));
    redis.set(KEY_PREFIX + key, payload, 'EX', sec).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

export async function cacheGetOrSet<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const memHit = cacheGet<T>(key);
  if (memHit !== undefined) return memHit;

  const redis = getRedisSync();
  if (redis) {
    try {
      const raw = await redis.get(KEY_PREFIX + key);
      if (raw) {
        const parsed = JSON.parse(raw) as T;
        // Warm local map without re-writing Redis
        store.set(key, { value: parsed, expiresAt: Date.now() + ttlMs });
        pruneIfNeeded();
        return parsed;
      }
    } catch {
      /* fall through to loader */
    }
  }

  const value = await loader();
  cacheSet(key, value, ttlMs);
  return value;
}

export function cacheDelete(key: string): void {
  store.delete(key);
  const redis = getRedisSync();
  if (!redis) return;
  try {
    redis.del(KEY_PREFIX + key).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

export function cacheDeletePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
  const redis = getRedisSync();
  if (!redis) return;
  try {
    const stream = redis.scanStream({
      match: KEY_PREFIX + prefix + '*',
      count: 100,
    });
    const keys: string[] = [];
    stream.on('data', (batch: string[]) => keys.push(...batch));
    stream.on('end', () => {
      if (keys.length) redis.del(...keys).catch(() => undefined);
    });
    stream.on('error', () => undefined);
  } catch {
    /* ignore */
  }
}

/** Round coords for nearby cache buckets (~1.1km). */
export function roundCoordBucket(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return 'na';
  const f = 10 ** decimals;
  return String(Math.round(n * f) / f);
}
