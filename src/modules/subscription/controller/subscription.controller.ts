import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { SubscriptionService } from '../service/subscription.service.js';
import type { VerifySubscriptionBody } from '../validation/index.js';

type TypedRequest<TBody> = Request<Record<string, string>, unknown, TBody>;

export class SubscriptionController {
  constructor(private readonly service: SubscriptionService) {}

  private requireUserId(req: Request): string {
    // `requireAuth` sets `req.user = { id }`. Read it there — NOT `req.userId`,
    // which nothing sets (that bug made every verify throw → 500, so no purchase
    // was ever bound to a user and premium could never be granted).
    if (req.user === undefined) throw ApiError.unauthorized('Auth middleware did not run');
    return req.user.id;
  }

  verify = asyncHandler(async (req: TypedRequest<VerifySubscriptionBody>, res: Response) => {
    const userId = this.requireUserId(req);
    // Only the purchaseToken is trusted. A client-sent productId (older builds
    // include it) is ignored — the authoritative product comes from Google.
    const result = await this.service.verify(userId, req.body.purchaseToken);
    return ApiResponse.ok(res, result);
  });
}
