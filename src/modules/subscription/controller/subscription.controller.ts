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
    const result = await this.service.verify(userId, {
      purchaseToken: req.body.purchaseToken,
      productId: req.body.productId,
    });
    return ApiResponse.ok(res, result);
  });
}
