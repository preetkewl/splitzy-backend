import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { LogoutInput, RefreshInput, UpdateProfileInput } from '../dto/index.js';
import type { AuthService, AuthServiceContext } from '../service/auth.service.js';
import type {
  GoogleSignInBody,
  LogoutBody,
  RefreshBody,
  UpdateProfileBody,
} from '../validation/index.js';

type TypedRequest<TBody> = Request<Record<string, string>, unknown, TBody>;

export class AuthController {
  constructor(private readonly auth: AuthService) {}

  googleSignIn = asyncHandler(async (req: TypedRequest<GoogleSignInBody>, res: Response) => {
    const ctx = this.contextFromRequest(req);
    const session = await this.auth.googleSignIn({ idToken: req.body.idToken }, ctx);
    return ApiResponse.ok(res, session);
  });

  refresh = asyncHandler(async (req: TypedRequest<RefreshBody>, res: Response) => {
    const input: RefreshInput = { refreshToken: req.body.refreshToken };
    const ctx = this.contextFromRequest(req);
    const result = await this.auth.refresh(input, ctx);
    return ApiResponse.ok(res, result);
  });

  logout = asyncHandler(async (req: TypedRequest<LogoutBody>, res: Response) => {
    const input: LogoutInput =
      req.body.refreshToken !== undefined ? { refreshToken: req.body.refreshToken } : {};
    await this.auth.logout(input.refreshToken);
    return ApiResponse.noContent(res);
  });

  me = asyncHandler(async (req: Request, res: Response) => {
    const userId = this.requireUserId(req);
    const user = await this.auth.me(userId);
    return ApiResponse.ok(res, user);
  });

  updateProfile = asyncHandler(async (req: TypedRequest<UpdateProfileBody>, res: Response) => {
    const userId = this.requireUserId(req);
    const input: UpdateProfileInput = { ...req.body };
    const user = await this.auth.updateProfile(userId, input);
    return ApiResponse.ok(res, user);
  });

  deleteAccount = asyncHandler(async (req: Request, res: Response) => {
    const userId = this.requireUserId(req);
    await this.auth.deleteAccount(userId);
    return ApiResponse.noContent(res);
  });

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
