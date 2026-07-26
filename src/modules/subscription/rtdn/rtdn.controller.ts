import type { Request, Response } from 'express';
import { METRICS } from '../../../constants/metrics.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import { ApiError } from '../../../core/api-error.js';
import { logger } from '../../../utils/logger.js';
import {
  elapsedMs,
  ERROR_CLASS,
  runWithCorrelation,
  startTimer,
  subLog,
  subMetric,
  SUB_EVENT,
  type SubEventName,
} from '../../entitlement/observability/index.js';
import { RtdnRetryableError, type RtdnService } from '../../entitlement/service/rtdn.service.js';
import type { PubSubPushBody } from '../../entitlement/google/rtdn-types.js';
import type { RtdnStatus } from '../../entitlement/service/rtdn.service.js';

/** Maps an RTDN outcome status to a canonical observability event. */
const RTDN_EVENT_BY_STATUS: Record<RtdnStatus, SubEventName> = {
  processed: SUB_EVENT.RTDN_PROCESSED,
  duplicate: SUB_EVENT.RTDN_DUPLICATE,
  unknown_purchase: SUB_EVENT.RTDN_UNKNOWN_TOKEN,
  ignored: SUB_EVENT.RTDN_RECEIVED,
  test: SUB_EVENT.RTDN_RECEIVED,
  malformed: SUB_EVENT.RTDN_RECEIVED,
};

/**
 * Pub/Sub push receiver for Google Play RTDN. Unauthenticated by user JWT
 * (it is Google, not a user) — guarded instead by the shared-secret token
 * middleware. Returns 2xx once the message is durably handled (so Pub/Sub stops
 * redelivering) and 5xx on a transient failure (so Pub/Sub retries).
 */
export class RtdnController {
  constructor(private readonly rtdn: RtdnService) {}

  handle = asyncHandler(async (req: Request<unknown, unknown, PubSubPushBody>, res: Response) => {
    const message = req.body?.message;
    const data = message?.data;
    const messageId = message?.messageId ?? message?.message_id;

    if (!data || !messageId) {
      // Malformed envelope — 400 (not retryable; a retry would be identical).
      throw ApiError.badRequest('Invalid Pub/Sub push message: missing data or messageId');
    }

    // Correlate all logs for this Pub/Sub message — including redeliveries, which
    // reuse the same messageId — under one id so a purchase's RTDN history lines
    // up end-to-end with its verify/ack/reconcile events (joined by token hash).
    return runWithCorrelation(`rtdn_${messageId}`, async () => {
      const started = startTimer();
      subLog('info', SUB_EVENT.RTDN_RECEIVED, { source: 'rtdn', outcome: 'received' });
      try {
        const outcome = await this.rtdn.processPushMessage({ data, messageId });
        const latencyMs = elapsedMs(started);
        subMetric(METRICS.rtdnLatencyMs, latencyMs, { status: outcome.status });
        subLog('info', RTDN_EVENT_BY_STATUS[outcome.status], {
          purchaseToken: outcome.purchaseToken ?? null,
          source: 'rtdn',
          latencyMs,
          outcome: outcome.status,
          extra: { notificationType: outcome.notificationType ?? 'unknown' },
        });
        return ApiResponse.ok(res, outcome);
      } catch (err) {
        const latencyMs = elapsedMs(started);
        if (err instanceof RtdnRetryableError) {
          // 5xx → Pub/Sub redelivers with backoff (idempotency makes this safe).
          subMetric(METRICS.rtdnLatencyMs, latencyMs, { status: 'retry' });
          subLog('error', SUB_EVENT.RTDN_FAILED, {
            source: 'rtdn',
            latencyMs,
            errorClass: ERROR_CLASS.UNEXPECTED,
            outcome: 'retry',
          });
          logger.error({ err, messageId }, 'rtdn transient failure — signaling retry');
          throw ApiError.internal('RTDN processing failed; please retry');
        }
        throw err;
      }
    });
  });
}
