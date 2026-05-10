/**
 * Cache module — singleton accessor + public types.
 *
 * Production switch to Redis is local to this file:
 *   1. `npm i ioredis`
 *   2. Implement `RedisCache implements ICache` in `redis-cache.ts`
 *   3. Replace the `new InMemoryCache()` line below with the Redis impl
 *      gated on `process.env.REDIS_URL`.
 *
 * No service or controller imports the impl directly — they all go
 * through `getCache()`, so no call site changes.
 */
import type { ICache } from './cache.js';
import { InMemoryCache } from './in-memory-cache.js';

let instance: ICache | null = null;

/** Lazy singleton. Tests can substitute via `setCache()`. */
export function getCache(): ICache {
  if (instance === null) {
    instance = new InMemoryCache();
  }
  return instance;
}

/** Test seam — replace the singleton. Not for production code. */
export function setCache(cache: ICache): void {
  instance = cache;
}

export type { ICache } from './cache.js';
export { InMemoryCache } from './in-memory-cache.js';
