import { paginate } from '../../../database/helpers.js';
import { BalanceEngine } from '../../expense/engine/balance-engine.js';
import type { IExpenseRepository } from '../../expense/repository/expense.repository.js';
import type { IFriendRepository } from '../../friend/repository/friend.repository.js';
import type { ISettlementRepository } from '../../settlement/repository/settlement.repository.js';
import { toTripSummary } from '../../trip/mapper/trip.mapper.js';
import type { ITripRepository } from '../../trip/repository/trip.repository.js';
import type { DashboardDto, DashboardTripDto } from '../dto/index.js';

/// Upper bound on trips folded into one dashboard payload. Mobile users have
/// few trips; this is a safety cap, not real pagination.
const DASHBOARD_TRIP_LIMIT = 100;

/**
 * Builds the `GET /me/dashboard` payload with a CONSTANT number of queries
 * regardless of trip count — the whole point of the endpoint.
 *
 * Per-trip viewer net is computed via [BalanceEngine.userNet] from cheap
 * viewer-filtered aggregates, NOT the full member matrix. It is provably equal
 * to `/balances` net for the same user (see `dashboard-parity` smoke test),
 * so the two never drift.
 */
export class DashboardService {
  constructor(
    private readonly trips: ITripRepository,
    private readonly expenses: IExpenseRepository,
    private readonly settlements: ISettlementRepository,
    private readonly friends: IFriendRepository,
  ) {}

  async getDashboard(userId: string): Promise<DashboardDto> {
    // 1 query (+ its count) — reuses the existing trip-list aggregate that
    // already folds per-trip total + latestExpenseAt in one groupBy.
    const { rows } = await this.trips.listForUser(
      userId,
      paginate({ pageSize: DASHBOARD_TRIP_LIMIT }),
    );
    const tripIds = rows.map((r) => r.id);

    // Viewer aggregates: one query each, across ALL trips. Settlements are read
    // AFTER expenses (sequential) for the same read-skew guarantee `balances()`
    // relies on — never observe a settlement without its preceding expense.
    const expenseTotals = await this.expenses.findViewerTotalsByTrip(tripIds, userId);
    const settlementTotals = await this.settlements.findViewerTotalsByTrip(tripIds, userId);
    const incomingRequestCount = await this.friends.countPendingIncoming(userId);

    let owedMinor = 0;
    let oweMinor = 0;

    const trips: DashboardTripDto[] = rows.map((row) => {
      const e = expenseTotals.get(row.id) ?? { paidMinor: 0, shareMinor: 0 };
      const s = settlementTotals.get(row.id) ?? { settledOutMinor: 0, settledInMinor: 0 };
      const viewerNetMinor = BalanceEngine.userNet({
        paidMinor: e.paidMinor,
        shareMinor: e.shareMinor,
        settledOutMinor: s.settledOutMinor,
        settledInMinor: s.settledInMinor,
      });
      if (viewerNetMinor > 0) owedMinor += viewerNetMinor;
      else if (viewerNetMinor < 0) oweMinor += -viewerNetMinor;
      return { ...toTripSummary(row, userId), viewerNetMinor };
    });

    return {
      trips,
      overall: { netMinor: owedMinor - oweMinor, owedMinor, oweMinor },
      friends: { incomingRequestCount },
      activity: {},
      generatedAt: new Date().toISOString(),
    };
  }
}
