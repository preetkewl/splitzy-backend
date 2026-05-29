/**
 * SplitCalculatorRegistry — strategy dispatcher for the split engine.
 *
 * Maps each ExpenseSplitType to its SplitCalculator implementation.
 * The service calls `splitRegistry.compute(...)` without needing to
 * know which calculator is invoked.
 *
 * Extensibility contract:
 *   To support a new split type:
 *     1. Implement SplitCalculator.
 *     2. Call `.register(new MyCalculator())` below.
 *   No other file needs to change for the dispatch to work.
 *
 * Error policy:
 *   Calling `.get()` or `.compute()` for an unregistered split type throws
 *   immediately. This surfaces deployment errors (enum value added without
 *   a corresponding calculator) at request time rather than silently
 *   producing wrong balances.
 */

import type { ExpenseSplitType } from '@prisma/client';
import { EqualSplitCalculator } from './calculators/equal.calculator.js';
import { ExactSplitCalculator } from './calculators/exact.calculator.js';
import { PercentSplitCalculator } from './calculators/percent.calculator.js';
import { SharesSplitCalculator } from './calculators/shares.calculator.js';
import type { RawParticipantInput, SplitCalculator, SplitResult } from './split-types.js';

export class SplitCalculatorRegistry {
  private readonly calculators = new Map<ExpenseSplitType, SplitCalculator>();

  /**
   * Register a calculator. Throws if a calculator for the same split type
   * is already registered (prevents accidental double-registration).
   */
  register(calculator: SplitCalculator): this {
    if (this.calculators.has(calculator.splitType)) {
      throw new Error(
        `SplitCalculatorRegistry: duplicate registration for '${calculator.splitType}'`,
      );
    }
    this.calculators.set(calculator.splitType, calculator);
    return this;
  }

  /**
   * Retrieve the calculator for a given split type.
   * Throws if no calculator is registered — this is always a programmer
   * error (new enum value without a matching implementation).
   */
  get(splitType: ExpenseSplitType): SplitCalculator {
    const calc = this.calculators.get(splitType);
    if (calc === undefined) {
      throw new Error(
        `SplitCalculatorRegistry: no calculator registered for split type '${splitType}'. ` +
          `Ensure a SplitCalculator is implemented and registered for every ExpenseSplitType enum value.`,
      );
    }
    return calc;
  }

  /**
   * Convenience: look up the right calculator and invoke it in one call.
   * This is the method the ExpenseService calls directly.
   *
   * @param splitType   Which strategy to use.
   * @param amountMinor Total expense amount; validated positive integer.
   * @param participants Raw per-participant inputs for this split type.
   * @param payerId     userId of the paying member; validated in participants.
   * @returns           SplitResult[] with SUM(shareMinor) === amountMinor.
   */
  compute(
    splitType: ExpenseSplitType,
    amountMinor: number,
    participants: readonly RawParticipantInput[],
    payerId: string,
  ): SplitResult[] {
    return this.get(splitType).calculate(amountMinor, participants, payerId);
  }
}

/**
 * Production registry with all four split calculators pre-registered.
 * Import this singleton from the service; do not construct a new registry
 * per request.
 *
 * Test suites that need to exercise an isolated calculator should
 * instantiate the calculator class directly, not via this registry.
 */
export const splitRegistry = new SplitCalculatorRegistry()
  .register(new EqualSplitCalculator())
  .register(new ExactSplitCalculator())
  .register(new PercentSplitCalculator())
  .register(new SharesSplitCalculator());
