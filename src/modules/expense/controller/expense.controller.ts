import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
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
    const expense = await this.expenses.create(userId, {
      tripId: req.body.tripId,
      title: req.body.title,
      amountPaise: req.body.amountPaise,
      paidByUserId: req.body.paidByUserId,
      participantIds: req.body.participantIds,
      category: req.body.category,
      spentAt: req.body.spentAt,
    });
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
