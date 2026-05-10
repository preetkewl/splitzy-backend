/**
 * Expense-module constants. The validation bounds line up with the
 * frontend's add-expense screen + `database/constants` defensively.
 */
export {
  MAX_EXPENSE_AMOUNT_PAISE,
  MAX_EXPENSE_TITLE_LENGTH,
} from '../../database/constants.js';

export const MIN_EXPENSE_TITLE_LENGTH = 1;

/** Minimum positive amount we'll accept (1 paise). */
export const MIN_EXPENSE_AMOUNT_PAISE = 1;
