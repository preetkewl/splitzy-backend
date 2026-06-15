# Monetization — Operations & Deployment Runbook

Operational reference for the subscription/entitlement stack (Phases 2–6).
Audience: whoever deploys and on-calls this service. Nothing here adds product
features; it wires + operates what already exists.

---

## 1. Environment variables

| Var | Required (prod) | Purpose | Failure mode if missing |
|---|---|---|---|
| `DATABASE_URL` | yes | Postgres (Supabase) | server won't boot |
| `GOOGLE_PLAY_PACKAGE_NAME` | yes | App id verified against Google | startup fails (if `MONETIZATION_REQUIRED`) |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | yes | Play Developer API auth (full SA JSON) | startup fails; else verify fails closed |
| `RTDN_VERIFICATION_TOKEN` | yes | Shared secret guarding `/subscriptions/rtdn` | startup fails; else webhook rejects all |
| `MONETIZATION_REQUIRED` | no | `true`/`false` override of the prod default | — |

**Startup behavior:** `validateMonetizationConfig()` runs first in `bootstrap()`.
It logs a `evt:"startup" component:"monetization"` readiness line every boot, and
**throws (process exits) when monetization is required but a secret is missing.**
Set `MONETIZATION_REQUIRED=false` for a non-billing staging API.

**Secrets handling:** store SA JSON + RTDN token in the platform secret store
(Render env group / GCP Secret Manager) — never in the repo. Rotate the RTDN
token by updating both the env var and the Pub/Sub push endpoint URL.

---

## 2. Play Console setup

1. Create the subscription product **`settlio_premium_monthly`** (must match
   `SETTLIO_PREMIUM_MONTHLY` and the Flutter `kPremiumMonthlyId`).
2. Create a **service account** (GCP) with the **Android Publisher** role; grant
   it in Play Console → Users & permissions → **View financial data, Manage orders**.
   Download the JSON → `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
3. Add **license testers** (Play Console → Setup → License testing) so test
   purchases don't charge real money.
4. Monetization setup → **Real-time developer notifications** → set the Cloud
   Pub/Sub topic name (see §3).

---

## 3. Pub/Sub + RTDN setup

1. Create topic `settlio-rtdn`; grant `google-play-developer-notifications@system.gserviceaccount.com`
   the **Pub/Sub Publisher** role on it (Play requires this).
2. Create a **push** subscription → endpoint:
   `https://<api-host>/api/v1/subscriptions/rtdn?token=<RTDN_VERIFICATION_TOKEN>`.
3. **Dead-letter:** create topic `settlio-rtdn-dlq`; on the push subscription set
   Dead-lettering → `settlio-rtdn-dlq`, **Max delivery attempts = 5**. Create a
   pull subscription on the DLQ for inspection + alerting on depth > 0.
4. Retry policy: exponential backoff (min 10s, max 600s).

**Webhook properties (already implemented):**
- Exempt from the per-IP rate limiter (`RATE_LIMIT_EXEMPT_PATHS`).
- Token-guarded (`x-rtdn-token` header or `?token=`); rejects in prod if unset.
- Idempotent on `messageId`; returns `2xx` once durably handled, `5xx` on
  transient failure (→ Pub/Sub retries → DLQ after 5).
- RTDN is a signal only — every event re-fetches `subscriptionsv2.get`.

**Local testing:** `MONETIZATION_REQUIRED=false`, omit the token (dev allows
unauthenticated with a warning), POST a base64 `DeveloperNotification` envelope
to `/api/v1/subscriptions/rtdn`. See `scripts/rtdn-smoke.ts` for payload shapes.

---

## 4. Scheduler (Cloud Scheduler / Render Cron)

Two idempotent jobs (safe to re-run; bounded by `--limit`):

| Job | Command | Interval | Why |
|---|---|---|---|
| Acknowledgment sweep | `npm run ops:ack-purchases` | **hourly** | Google auto-refunds unacknowledged purchases after **3 days** — this is the safety net for a failed inline ack. |
| Reconciliation sweep | `npm run ops:reconcile-subscriptions` | **daily** (off-peak) | Repairs drift from missed/dropped RTDN (renewals, cancels, lapses, refunds). |

Both accept `--limit=N` (default 200). For a large backlog run repeatedly until
`scanned < limit`.

**Render:** add two **Cron Jobs** running the npm scripts with the same env group.
**Cloud Scheduler:** schedule a job that triggers the container/command (or an
HTTP Cloud Run job) on the cron above.

**Failure behavior:** per-item failures are isolated (logged, counted in
`reconciled/expired/failed`); the job continues and exits 0 unless it throws at
the top level (exit 1 → scheduler marks the run failed). A `GooglePlayConfigError`
aborts the sweep early (nothing else would succeed). Each run emits metrics
(`monetization.reconcile.*`, `monetization.ack.backlog`) and **alerts** if the
post-sweep ack backlog is non-zero or any item failed.

---

## 5. Observability

**Metrics** (log-based; ship `evt:"metric"` lines → Prometheus/DataDog):
`monetization.verify.{success,failure}`, `monetization.rtdn.{processed,duplicate,failure}`,
`monetization.reconcile.{scanned,reconciled,expired,failed}`,
`monetization.ack.backlog`, `monetization.entitlement.{granted,revoked}`.

**Alerts** (`evt:"alert"` lines + recommended thresholds, see `constants/metrics.ts`):
| Alert | Condition | Severity |
|---|---|---|
| `ack_backlog_nonzero` | unacked entitling purchases remain after a sweep | critical |
| `sweep_item_failures` | any per-item failure in a sweep | warning |
| RTDN 5xx rate | > 5% over 5m (dashboard-computed) | critical |
| verify failure rate | > 10% over 15m (dashboard-computed) | warning |
| dead-letter depth | DLQ > 0 (Pub/Sub metric) | critical |

**Support debugging (SQL):** `purchase_audit_log` (every signal, by `purchaseToken`),
`entitlement_history` (premium on/off timeline, by `userId`), `subscription_purchases`
(current ledger), `user_entitlements` (current truth).

---

## 6. Rollback

The schema is additive; enforcement and verification are layered. Roll back in
this order (least to most invasive):
1. **Disable enforcement:** revert the trip-create `beforeCreate` hook (or deploy
   with the limit effectively disabled) — stops blocking free users without
   touching billing.
2. **Pause RTDN:** disable the Pub/Sub push subscription (events queue/retry).
3. **Disable verification:** set `MONETIZATION_REQUIRED=false` and remove Google
   creds → verify fails closed (no grants; **no fake fallback** — confirm this is
   acceptable before relying on it).
4. **Never** drop the entitlement tables while rows exist. The migration is
   additive; "rollback" = stop reading the new tables, not a destructive down-migration.

---

## 7. Disaster recovery

| Incident | Action |
|---|---|
| RTDN outage / DLQ filling | Events are not lost (DLQ + retries). Temporarily raise reconciliation frequency (`ops:reconcile-subscriptions` every 15–30m) to re-derive truth from Google. Drain DLQ after recovery. |
| Mass auto-refund risk (ack backlog) | Run `ops:ack-purchases --limit=all`; confirm `monetization.ack.backlog` → 0. Investigate why inline acks failed (Google API creds/quota). |
| Google API down | Verify fails closed (no new grants); existing entitlements keep serving from `user_entitlements`. Backlog drains via the sweep on recovery. |
| Entitlement drift / disputed access | `ops:reconcile-subscriptions` rebuilds state from Google truth; inspect `entitlement_history` for the timeline. |
| Refund not revoked | Check `voidedpurchases` RTDN was received (`purchase_audit_log` by token); if missed, reconciliation re-derives, or force via a one-off revoke. |
| Suspected fake-RTDN abuse | Rotate `RTDN_VERIFICATION_TOKEN` + push endpoint; reconciliation re-grants any wrongly-revoked legit subs from Google truth. |

---

## 8. Pre-launch gate (must be green)

- [ ] Migration applied to prod; `prisma migrate status` clean
- [ ] Grandfather backfill run for existing premium users
- [ ] SA + package + RTDN token set; startup readiness line shows `configured:true`
- [ ] Pub/Sub topic + push sub + **DLQ** configured
- [ ] Both sweeps scheduled and observed running (logs + metrics)
- [ ] One real test purchase → premium; `acknowledged=true` within minutes
- [ ] One cancel + one refund reflected end-to-end
- [ ] Metrics shipped + the 5 alerts wired
- [ ] UMP consent verified on an EEA-geography test device; real ads gated pre-consent
