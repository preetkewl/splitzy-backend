import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type {
  LogoutInput,
  RefreshInput,
  UpdateProfileInput,
  VerifyInput,
} from '../dto/index.js';
import type { AuthService, AuthServiceContext } from '../service/auth.service.js';
import type {
  LoginBody,
  LogoutBody,
  RefreshBody,
  UpdateProfileBody,
  VerifyBody,
} from '../validation/index.js';

type TypedRequest<TBody> = Request<Record<string, string>, unknown, TBody>;

/**
 * Thin HTTP layer. No validation (handled by `validateRequest` middleware),
 * no business logic — just calls into the service and shapes the response.
 */
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  login = asyncHandler(async (req: TypedRequest<LoginBody>, res: Response) => {
    const result = await this.auth.login({ phone: req.body.phone });
    return ApiResponse.ok(res, result);
  });

  verify = asyncHandler(async (req: TypedRequest<VerifyBody>, res: Response) => {
    const input: VerifyInput = {
      challengeToken: req.body.challengeToken,
      otp: req.body.otp,
    };
    const ctx = this.contextFromRequest(req);
    const session = await this.auth.verify(input, ctx);
    return ApiResponse.ok(res, session);
  });

  refresh = asyncHandler(async (req: TypedRequest<RefreshBody>, res: Response) => {
    const input: RefreshInput = { refreshToken: req.body.refreshToken };
    const ctx = this.contextFromRequest(req);
    const result = await this.auth.refresh(input, ctx);
    return ApiResponse.ok(res, result);
  });

  logout = asyncHandler(async (req: TypedRequest<LogoutBody>, res: Response) => {
    const input: LogoutInput = req.body.refreshToken !== undefined ? { refreshToken: req.body.refreshToken } : {};
    await this.auth.logout(input.refreshToken);
    return ApiResponse.noContent(res);
  });

  me = asyncHandler(async (req: Request, res: Response) => {
    const userId = this.requireUserId(req);
    const user = await this.auth.me(userId);
    return ApiResponse.ok(res, user);
  });

  updateProfile = asyncHandler(
    async (req: TypedRequest<UpdateProfileBody>, res: Response) => {
      const userId = this.requireUserId(req);
      const input: UpdateProfileInput = { ...req.body };
      const user = await this.auth.updateProfile(userId, input);
      return ApiResponse.ok(res, user);
    },
  );

  // ── helpers ───────────────────────────────────────────────────────────────

  private requireUserId(req: Request): string {
    if (req.user === undefined) {
      throw ApiError.unauthorized('Auth middleware did not run');
    }
    return req.user.id;
  }

  private contextFromRequest(req: Request): AuthServiceContext {
    return {
      userAgent: req.header('user-agent') ?? null,
      ipAddress: req.ip ?? null,
    };
  }
}
