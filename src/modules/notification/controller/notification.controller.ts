import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { NotificationService } from '../service/notification.service.js';
import type { RegisterTokenBody, RemoveTokenBody } from '../validation/index.js';

type WithBody<T> = Request<Record<string, string>, unknown, T>;

export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  registerToken = asyncHandler(async (req: WithBody<RegisterTokenBody>, res: Response) => {
    const userId = this.requireUserId(req);
    await this.notifications.registerToken(userId, req.body.token, req.body.platform);
    return ApiResponse.ok(res, { registered: true });
  });

  removeToken = asyncHandler(async (req: WithBody<RemoveTokenBody>, res: Response) => {
    await this.notifications.removeToken(req.body.token);
    return ApiResponse.ok(res, { removed: true });
  });

  private requireUserId(req: Request): string {
    if (req.user === undefined) throw ApiError.unauthorized('Auth middleware did not run');
    return req.user.id;
  }
}
