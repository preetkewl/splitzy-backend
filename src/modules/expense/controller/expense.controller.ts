import { ExpenseSplitType } from '@prisma/client';
import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { CreateExpenseInput } from '../dto/index.js';
import type { ExpenseService } from '../service/expense.service.js';
import type {
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
    const summary = await this.expenses.balances(userId, req.params.tripId);
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
 */
function toCreateExpenseInput(body: CreateExpenseBody): CreateExpenseInput {
  // Common fields present on every union member.
  const base = {
    tripId: body.tripId,
    title: body.title,
    amountMinor: body.amountMinor,
    paidByUserId: body.paidByUserId,
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
