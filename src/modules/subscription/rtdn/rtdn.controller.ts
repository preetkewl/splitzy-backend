import type { Request, Response } from 'express';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import { ApiError } from '../../../core/api-error.js';
import { logger } from '../../../utils/logger.js';
import { RtdnRetryableError, type RtdnService } from '../../entitlement/service/rtdn.service.js';
import type { PubSubPushBody } from '../../entitlement/google/rtdn-types.js';

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

    try {
      const outcome = await this.rtdn.processPushMessage({ data, messageId });
      return ApiResponse.ok(res, outcome);
    } catch (err) {
      if (err instanceof RtdnRetryableError) {
        // 5xx → Pub/Sub redelivers with backoff (idempotency makes this safe).
        logger.error({ err, messageId }, 'rtdn transient failure — signaling retry');
        throw ApiError.internal('RTDN processing failed; please retry');
      }
      throw err;
    }
  });
}
