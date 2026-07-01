import { ExpenseSplitType } from '@prisma/client';
import type { Request, Response } from 'express';
import { ERROR_CODES } from '../../../constants/error-codes.js';
import { HTTP } from '../../../constants/http.js';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { CreateExpenseInput } from '../dto/index.js';
import type { ExpenseService } from '../service/expense.service.js';
import type {
  BalancesQuery,
  CreateExpenseBody,
  ExpenseIdParam,
  ListExpensesQuery,
  TripIdParam,
} from '../validation/index.js';

type WithBody<TBody> = Request<Record<string, string>, unknown, TBody>;
type WithParams<TParams extends Record<string, string>> = Request<TParams>;

export class ExpenseController {
  constructor(private readonly expenses: ExpenseService) {}

  create = asyncHandler(async (req: WithBody<CreateExpenseBody>, res: Response) => {
    const userId = this.requireUserId(req);
    const input = toCreateExpenseInput(req.body);
    const expense = await this.expenses.create(userId, input);
    return ApiResponse.created(res, expense);
  });

  listForTrip = asyncHandler(async (req: WithParams<TripIdParam>, res: Response) => {
    const userId = this.requireUserId(req);
    const query = req.query as unknown as ListExpensesQuery;
    const result = await this.expenses.list(userId, req.params.tripId, {
      page: query.page,
      pageSize: query.pageSize,
    });
    return ApiResponse.ok(res, result.items, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    });
  });

  balancesForTrip = asyncHandler(async (req: WithParams<TripIdParam>, res: Response) => {
    const userId = this.requireUserId(req);
    const query = req.query as unknown as BalancesQuery;
    const wantsSimplify = query.simplify === true;

    // Server-authoritative premium gate: the minimum-transfer view is a paid
    // feature. `req.entitlement` is attached by the resolveEntitlement
    // middleware on this route. Free callers requesting simplification get a
    // structured 403 the client turns into the paywall.
    if (wantsSimplify && req.entitlement?.premium !== true) {
      throw new ApiError(
        HTTP.FORBIDDEN,
        ERROR_CODES.PREMIUM_REQUIRED,
        'Simplified settle-up is a Settlio Premium feature.',
        { meta: { premium: false } },
      );
    }

    const summary = await this.expenses.balances(userId, req.params.tripId, {
      includeSimplified: wantsSimplify,
    });
    return ApiResponse.ok(res, summary);
  });

  remove = asyncHandler(async (req: WithParams<ExpenseIdParam>, res: Response) => {
    const userId = this.requireUserId(req);
    await this.expenses.softDelete(userId, req.params.expenseId);
    return ApiResponse.noContent(res);
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  private requireUserId(req: Request): string {
    if (req.user === undefined) {
      throw ApiError.unauthorized('Auth middleware did not run');
    }
    return req.user.id;
  }
}

/**
 * Convert the Zod-validated discriminated union body into the flat
 * CreateExpenseInput DTO the service consumes.
 *
 * The body type is a union of four shapes keyed on `splitType`. TypeScript
 * requires us to narrow the union before accessing split-specific fields
 * (participantIds / participants) to avoid compile errors. We do this with a
 * switch rather than casting so TypeScript can verify exhaustiveness.
 *
 * Phase 4: both `paidByUserId` (legacy) and `payments[]` (new) are passed
 * through to the service, which resolves the effective payment list from
 * whichever is present.
 */
function toCreateExpenseInput(body: CreateExpenseBody): CreateExpenseInput {
  // Common fields present on every union member.
  // paidByUserId and payments are both optional on the validated body; the
  // service resolveEffectivePayments() handles the either-or logic.
  const base = {
    tripId: body.tripId,
    title: body.title,
    amountMinor: body.amountMinor,
    paidByUserId: body.paidByUserId,
    payments: body.payments,
    category: body.category,
    spentAt: body.spentAt,
  } as const;

  switch (body.splitType) {
    case ExpenseSplitType.EQUAL:
      return {
        ...base,
        splitType: ExpenseSplitType.EQUAL,
        participantIds: body.participantIds,
      };

    case ExpenseSplitType.EXACT:
      return {
        ...base,
        splitType: ExpenseSplitType.EXACT,
        // body.participants is { userId, exactAmountMinor }[] which satisfies
        // RawParticipantInput (all non-userId fields are optional on that type).
        participants: body.participants,
      };

    case ExpenseSplitType.PERCENT:
      return {
        ...base,
        splitType: ExpenseSplitType.PERCENT,
        // body.participants is { userId, basisPoints }[]
        participants: body.participants,
      };

    case ExpenseSplitType.SHARES:
      return {
        ...base,
        splitType: ExpenseSplitType.SHARES,
        // body.participants is { userId, shareUnits }[]
        participants: body.participants,
      };
  }
}
