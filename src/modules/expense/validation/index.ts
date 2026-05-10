import { ExpenseCategory } from '@prisma/client';
import { z } from 'zod';
import {
  MAX_EXPENSE_AMOUNT_PAISE,
  MAX_EXPENSE_TITLE_LENGTH,
  MIN_EXPENSE_AMOUNT_PAISE,
  MIN_EXPENSE_TITLE_LENGTH,
} from '../constants.js';

const uuid = z.string().uuid('Must be a valid UUID');

const amountPaiseSchema = z
  .number()
  .int('amountPaise must be an integer (paise, not rupees)')
  .min(MIN_EXPENSE_AMOUNT_PAISE)
  .max(MAX_EXPENSE_AMOUNT_PAISE);

const titleSchema = z
  .string()
  .trim()
  .min(MIN_EXPENSE_TITLE_LENGTH)
  .max(MAX_EXPENSE_TITLE_LENGTH);

const categorySchema = z.nativeEnum(ExpenseCategory);

/**
 * spentAt accepts an ISO string OR a parsed Date. We `.transform()` to a
 * Date so service code never has to re-parse.
 */
const spentAtSchema = z
  .union([z.string().datetime({ offset: true }), z.date()])
  .transform((v) => (v instanceof Date ? v : new Date(v)));

// ── Endpoint schemas ─────────────────────────────────────────────────────────

export const tripIdParamSchema = z.object({
  tripId: uuid,
});

export const expenseIdParamSchema = z.object({
  expenseId: uuid,
});

export const createExpenseBodySchema = z.object({
  tripId: uuid,
  title: titleSchema,
  amountPaise: amountPaiseSchema,
  paidByUserId: uuid,
  participantIds: z.array(uuid).min(1).optional(),
  category: categorySchema.optional(),
  spentAt: spentAtSchema,
});

export const listExpensesQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type TripIdParam = z.infer<typeof tripIdParamSchema>;
export type ExpenseIdParam = z.infer<typeof expenseIdParamSchema>;
export type CreateExpenseBody = z.infer<typeof createExpenseBodySchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;
