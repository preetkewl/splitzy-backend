import type { Request, Response } from 'express';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { SubscriptionService } from '../service/subscription.service.js';
import type { VerifySubscriptionBody } from '../validation/index.js';

type TypedRequest<TBody> = Request<Record<string, string>, unknown, TBody>;

export class SubscriptionController {
  constructor(private readonly service: SubscriptionService) {}

  private requireUserId(req: Request): string {
    const userId = (req as Request & { userId?: string }).userId;
    if (!userId) throw new Error('Unauthorized');
    return userId;
  }

  verify = asyncHandler(async (req: TypedRequest<VerifySubscriptionBody>, res: Response) => {
    const userId = this.requireUserId(req);
    // Only the purchaseToken is trusted. A client-sent productId (older builds
    // include it) is ignored — the authoritative product comes from Google.
    const result = await this.service.verify(userId, req.body.purchaseToken);
    return ApiResponse.ok(res, result);
  });
}
