# Subscription Observability

End-to-end observability for the Google Play Billing lifecycle: structured logs,
metrics, correlation tracing, redaction, and alerting. **Observability only — no
billing behaviour depends on any of this.**

Implementation lives in `src/modules/entitlement/observability/` and is emitted
from the verify / RTDN / reconcile / Google-client code paths.

---

## 1. Correlation & tracing

Two keys let you trace a single purchase end-to-end:

| Key | Field | Scope | Source |
|-----|-------|-------|--------|
| **Correlation id** | `correlationId` | one invocation (request / webhook / sweep item) | HTTP: `X-Request-Id` (shared with the frontend). RTDN: `rtdn_<messageId>` (stable across Pub/Sub redeliveries). Sweep: `sweep-item_<uuid>` |
| **Purchase fingerprint** | `purchaseTokenHash` | the whole purchase lifetime | one-way SHA-256 of the purchase token (`pt_…`) |

- Filter **`purchaseTokenHash = pt_abc…`** → every verify, RTDN, ack, migration,
  reconcile, revoke/expire event for that one purchase across time.
- Filter **`correlationId = …`** → everything that happened in one request/job.

Correlation is carried through `AsyncLocalStorage`, so it reaches deep
service-layer logs without any business-logic signature change.

---

## 2. Redaction (sensitive data)

Purchase tokens and order ids are **bearer-grade secrets** and never appear raw.

| Raw | Emitted as | Helper |
|-----|-----------|--------|
| `purchaseToken` | `purchaseTokenHash` (`pt_` + 16 hex) | `hashPurchaseToken()` |
| `orderId` | `orderIdHash` (`oid_` + 12 hex) | `hashOrderId()` |
| `linkedPurchaseToken` | `linkedPurchaseTokenPresent` (boolean) | `linkedTokenPresent()` |

Defense-in-depth: the pino logger also redacts `*.purchaseToken`,
`*.linkedPurchaseToken`, `*.orderId`, `*.latestGoogleState` (and 2-deep variants)
to `[REDACTED]`, so even an accidental raw log is scrubbed before serialization.

---

## 3. Structured log events

All under `evt: "subscription"`, keyed by a canonical `event` name. Every line
carries the redacted context: `correlationId, userId, purchaseTokenHash,
productId, orderIdHash, subscriptionState, acknowledged,
linkedPurchaseTokenPresent, attempt, source, latencyMs, outcome, errorClass`.

| Event | When |
|-------|------|
| `subscription.verify.requested` | client `/verify` received |
| `subscription.verify.succeeded` | verify resolved (entitling or not) |
| `subscription.verify.failed` | verify failed (see `errorClass`) |
| `subscription.verify.ownership_conflict` | token owned by another account (409) |
| `subscription.entitlement.granted` | premium granted (fresh or migrated) |
| `subscription.entitlement.suspended` | non-entitling state → suspended |
| `subscription.entitlement.revoked` | refund / chargeback / RTDN revoke |
| `subscription.entitlement.expired` | Google dropped the token / lapse |
| `subscription.ack.succeeded` / `.failed` / `.skipped` | backend acknowledgement |
| `subscription.migration.applied` | linkedPurchaseToken chain migration |
| `subscription.rtdn.received` / `.processed` / `.duplicate` / `.unknown_token` / `.failed` | RTDN webhook |
| `subscription.reconcile.started` / `.completed` / `.item_failed` | sweeps |
| `subscription.google_api.call` | Google Developer API call (`op`, latency, outcome) |

`errorClass` ∈ `{ invalid_token, unknown_product, ownership_conflict,
not_configured, google_api, unattributable, unexpected }`.

---

## 4. Metrics

Log-based (`evt: "metric"`), low-cardinality tags only. Names in
`src/constants/metrics.ts`.

**Counters**
- `monetization.verify.success` / `.failure` (tag: `reason`/`entitling`)
- `monetization.ack.success` / `.failure`
- `monetization.rtdn.processed` / `.duplicate` / `.ignored` / `.failure`
- `monetization.reconcile.scanned` / `.reconciled` / `.expired` / `.failed`
- `monetization.entitlement.granted` / `.revoked`
- `monetization.google_api.call` (tags: `op`, `outcome`)
- `monetization.ownership.conflict` (tag: `source`)
- `monetization.migration.linked` (tag: `source`)
- `monetization.ack.retry_count` (ack-sweep reprocessed count)
- `monetization.subscription.expired`
- `monetization.restore.outcome` (tag: `outcome`)

**Latency (ms, one observation per emit → histogram/percentiles)**
- `monetization.verify.latency_ms` (tags: `outcome`, `errorClass`/`entitling`)
- `monetization.ack.latency_ms` (tag: `outcome`)
- `monetization.google_api.latency_ms` (tags: `op`, `outcome`)
- `monetization.rtdn.latency_ms` (tag: `status`)

**Gauges**
- `monetization.ack.backlog` / `monetization.ack.queue_depth` (unacknowledged entitling rows after a sweep — the 3-day-refund risk queue)

**Derived rates** (dashboard, from counters): verification success/failure rate,
RTDN processing rate, reconciliation rate, ownership-conflict rate, Google API
error rate, restore success rate.

---

## 5. Recommended dashboard (Grafana)

**Row 1 — Purchase funnel (health at a glance)**
1. Verify success rate `%` (stat) = `verify.success / (success+failure)` — 15m.
2. Verify throughput (timeseries) — success vs failure stacked, by `reason`.
3. Acknowledgement backlog (stat + timeseries) = `ack.queue_depth` — **must trend to 0**.
4. Entitlements granted vs revoked (timeseries).

**Row 2 — Latency (SLOs)**
5. Verify latency p50/p95/p99 (`verify.latency_ms`).
6. Google API latency p50/p95/p99 by `op` (`google_api.latency_ms`).
7. Acknowledgement latency p95 (`ack.latency_ms`).

**Row 3 — RTDN & reconciliation**
8. RTDN rate by `status` (processed/duplicate/unknown_token/failure).
9. RTDN latency p95 (`rtdn.latency_ms`).
10. Reconcile sweep: scanned / reconciled / expired / failed (bars per run).
11. `ack.retry_count` per ack sweep (recovery volume).

**Row 4 — Integrity & abuse**
12. Ownership conflicts (`ownership.conflict`) — should be ~0.
13. linkedPurchaseToken migrations (`migration.linked`).
14. Expired subscriptions (`subscription.expired`).
15. Google API error rate `%` (`google_api.call{outcome=error}`) — outage signal.

**Row 5 — Trace drill-down**
16. Logs panel filtered by `evt="subscription"`; template variables for
    `purchaseTokenHash` and `correlationId` to pivot from any panel into the full
    per-purchase / per-request timeline.

CloudWatch equivalent: metric filters on the `evt:"metric"` JSON lines →
CloudWatch metrics; Logs Insights saved queries on `evt="subscription"` with the
same two pivot fields.

---

## 6. Alert thresholds

Thresholds centralised in `ALERT_THRESHOLDS` (`src/constants/metrics.ts`). Sweep
alerts are emitted in-code as `evt:"alert"`; rate/percentile alerts are computed
at the dashboard layer.

| Alert | Condition | Severity |
|-------|-----------|----------|
| Acknowledgement backlog | `ack.queue_depth ≥ 1` after a sweep (`ack_backlog_nonzero`) | **critical** (refund risk) |
| Verification failures | verify failure rate `> 0.10` over 15m | critical |
| Acknowledgement failures | `ack.failure` rate `> 0` sustained 15m, or backlog not draining | critical |
| Retry backlog not draining | `ack.queue_depth` flat/rising across ≥ 2 sweeps | critical |
| Google API outage | `google_api.call{outcome=error}` rate `> 0.20` over 5m, or p95 `google_api.latency_ms > 3000` | critical |
| Abnormal ownership conflicts | `ownership.conflict` rate `> 0.02` over 15m | warning (abuse/bug) |
| Reconciliation failures | `reconcile.failed ≥ 1` in a run (`sweep_item_failures`) | warning |
| Verify latency SLO | p95 `verify.latency_ms > 4000` over 10m | warning |
| Pub/Sub dead-letter | dead-letter topic depth `≥ 1` | critical |

---

## 7. Runbook pointers

- **Backlog rising** → check `google_api.call{op=acknowledge,outcome=error}` and
  Google API latency; the ack sweep (`npm run ops:ack-purchases`) is the durable
  retry — confirm the cron is firing.
- **Verify failures spike** → break down `verify.failure` by `reason`;
  `not_configured` ⇒ missing `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` / package name;
  `invalid_token` ⇒ client/token issue; `google_api` ⇒ outage.
- **Ownership conflicts spike** → pivot by `purchaseTokenHash`; a single hash
  across many users ⇒ token sharing/abuse; many distinct ⇒ a client bug.
- **Trace one purchase** → filter logs by its `purchaseTokenHash` for the full
  verify → RTDN → ack → migration → reconcile timeline.
