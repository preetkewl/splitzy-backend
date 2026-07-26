import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Correlation-id propagation for the subscription lifecycle.
 *
 * A single purchase is touched by many independent invocations — an HTTP verify,
 * one or more RTDN webhooks, an acknowledgement retry, a reconciliation sweep.
 * Each invocation runs under a correlation id so its logs group together; the
 * PURCHASE is tied across invocations by the token fingerprint (see redaction).
 *
 * The id is carried implicitly through `AsyncLocalStorage` so instrumentation
 * deep in the service layer can read it WITHOUT changing any business-logic
 * function signature (observability must not alter call shapes). Entry points
 * (HTTP middleware, RTDN handler, sweep item) establish the context; everything
 * awaited inside inherits it.
 */

interface CorrelationStore {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

/** Generate a fresh correlation id, optionally namespaced (e.g. `rtdn`, `sweep`). */
export function newCorrelationId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

/** Run `fn` with `correlationId` bound as the ambient correlation for its async tree. */
export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** The current ambient correlation id, or `undefined` outside any bound context. */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
