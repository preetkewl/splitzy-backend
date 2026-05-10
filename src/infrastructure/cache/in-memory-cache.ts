import type { ICache } from './cache.js';

interface CacheEntry {
  value: unknown;
  /** Epoch ms expiry. Null = never expires. */
  expiresAt: number | null;
}

/**
 * In-process Map-backed cache. Default for MVP / single-instance
 * deployments. Lazy expiration on access — no background timers, so
 * shutdown is clean.
 *
 * Important: this does NOT survive process restarts and does NOT share
 * state across replicas. Once we run more than one API instance, swap
 * in a Redis-backed implementation behind the same `ICache` interface.
 */
export class InMemoryCache implements ICache {
  private readonly store = new Map<string, CacheEntry>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt =
      ttlSeconds === undefined || ttlSeconds <= 0 ? null : Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expiresAt });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async del(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delByPrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        n += 1;
      }
    }
    return n;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async size(): Promise<number> {
    return this.store.size;
  }

  /** Test helper — wipe everything. Not part of `ICache`. */
  clear(): void {
    this.store.clear();
  }
}
