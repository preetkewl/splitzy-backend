// Balance engine — unchanged; always split-type-agnostic
export { BalanceEngine } from './balance-engine.js';
export type {
  ExpenseInput,
  NetBalance,
  ParticipantShare,
  SettlementTransfer,
} from './balance-engine.js';

// Split calculator strategy pattern
export type { RawParticipantInput, SplitCalculator, SplitResult } from './split-types.js';
export { SplitCalculatorRegistry, splitRegistry } from './split-registry.js';

// Individual calculators — exported so tests can instantiate them directly
// without going through the registry.
export { EqualSplitCalculator } from './calculators/equal.calculator.js';
export { ExactSplitCalculator } from './calculators/exact.calculator.js';
export { PercentSplitCalculator } from './calculators/percent.calculator.js';
export { SharesSplitCalculator } from './calculators/shares.calculator.js';
