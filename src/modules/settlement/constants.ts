/**
 * Settlement-module constants. Bounds are deliberately mirrored from
 * the Expense module — a settlement is a money movement just like an
 * expense, with the same paise budget.
 */
export {
  MAX_EXPENSE_AMOUNT_PAISE as MAX_SETTLEMENT_AMOUNT_PAISE,
} from '../../database/constants.js';

export const MIN_SETTLEMENT_AMOUNT_PAISE = 1;
export const MAX_NOTE_LENGTH = 280;
export const MAX_EXTERNAL_REF_LENGTH = 120;
