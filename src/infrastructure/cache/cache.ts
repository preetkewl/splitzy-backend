/**
 * Cache abstraction.
 *
 * Why this exists at Step 7 even though no module uses it yet: when a
 * service eventually needs caching (the obvious candidate is the trip
 * balances endpoint), the abstraction is already in place so the call
 * sites don't have to be rewritten and the production switch from
 * `InMemoryCache` to `RedisCache` is one binding change in
 * `src/infrastructure/cache/index.ts`.
 *
 * Intentionally minimal — `get / set / del / delByPrefix`. No bulk-get,
 * no atomic counters, no pub/sub. Add only when a real call site needs
 * them.
 */
export interface ICache {
  /** Returns null on cache miss. Never throws on a missing key. */
  get<T>(key: string): Promise<T | null>;

  /**
   * Store a value. `ttlSeconds` of 0 or undefined = no expiry. Past
   * values for the same key are silently overwritten.
   */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /** Returns true if a key was deleted, false if it didn't exist. */
  del(key: string): Promise<boolean>;

  /**
   * Best-effort prefix delete. Returns the number of keys removed.
   * Used to invalidate everything under a namespace, e.g.
   * `delByPrefix("trip:abc:")` after an expense write.
   */
  delByPrefix(prefix: string): Promise<number>;

  /** For diagnostics. May be approximate (Redis SCAN cost). */
  size(): Promise<number>;
}
