// In-memory fixed-window limiter. Fine for a single instance; use the host's edge rate limiting
// or a shared store (e.g. Redis) once ForgeX runs on more than one server.
const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 10_000;

function evictExpired(now: number) {
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}

export function allowAttempt(key: string, limit = 10, windowMs = 15 * 60 * 1000): boolean {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) evictExpired(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}
