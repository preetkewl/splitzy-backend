import { ApiError } from '../../../core/api-error.js';
import { paginate, type PaginationInput } from '../../../database/helpers.js';
import { TRIP_COVER_COLORS } from '../../../database/constants.js';
import { logger } from '../../../utils/logger.js';
import type { IExpenseRepository } from '../../expense/repository/expense.repository.js';
import type { ISettlementRepository } from '../../settlement/repository/settlement.repository.js';
import type {
  AddMembersInput,
  CreateTripInput,
  TripDetailDto,
  TripMemberDto,
  TripSummaryDto,
  UpdateTripInput,
} from '../dto/index.js';
import { toMember, toTripDetail, toTripSummary } from '../mapper/trip.mapper.js';
import type { ITripRepository } from '../repository/trip.repository.js';
import { TripAccess } from './access.js';

export interface ListTripsResult {
  items: TripSummaryDto[];
  page: number;
  pageSize: number;
  total: number;
}

export class TripService {
  private readonly access: TripAccess;

  constructor(
    private readonly trips: ITripRepository,
    private readonly expenseRepo: IExpenseRepository,
    private readonly settlementRepo: ISettlementRepository,
  ) {
    this.access = new TripAccess(trips);
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(userId: string, input: CreateTripInput): Promise<TripDetailDto> {
    const memberIds = Array.from(new Set(input.memberIds)).filter((id) => id !== userId);
    if (memberIds.length > 0) {
      const found = await this.trips.countActiveUsers(memberIds);
      if (found !== memberIds.length) {
        throw ApiError.badRequest('One or more memberIds reference users that do not exist');
      }
    }

    const trip = await this.trips.create({
      name: input.name,
      emoji: input.emoji,
      coverColor: input.coverColor ?? this.pickCoverColor(),
      description: input.description ?? null,
      createdById: userId,
      memberIds,
    });
    logger.info(
      { tripId: trip.id, ownerId: userId, memberCount: trip.members.length },
      'trip created',
    );
    return toTripDetail(trip, userId);
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async list(userId: string, input: PaginationInput): Promise<ListTripsResult> {
    const params = paginate(input);
    const { rows, total } = await this.trips.listForUser(userId, params);
    return {
      items: rows.map((row) => toTripSummary(row, userId)),
      page: params.page,
      pageSize: params.pageSize,
      total,
    };
  }

  // ── detail ────────────────────────────────────────────────────────────────

  async detail(userId: string, tripId: string): Promise<TripDetailDto> {
    await this.access.assertMember(tripId, userId);
    const detail = await this.trips.findDetail(tripId);
    if (detail === null) throw ApiError.notFound('Trip not found');
    return toTripDetail(detail, userId);
  }

  // ── update ────────────────────────────────────────────────────────────────

  async update(userId: string, tripId: string, input: UpdateTripInput): Promise<TripDetailDto> {
    await this.access.assertOwner(tripId, userId);
    await this.trips.update(tripId, input);
    const detail = await this.trips.findDetail(tripId);
    if (detail === null) throw ApiError.notFound('Trip not found');
    return toTripDetail(detail, userId);
  }

  // ── delete ────────────────────────────────────────────────────────────────

  async softDelete(userId: string, tripId: string): Promise<void> {
    await this.access.assertOwner(tripId, userId);
    await this.trips.softDelete(tripId);
    logger.info({ tripId, ownerId: userId }, 'trip soft-deleted');
  }

  // ── members ───────────────────────────────────────────────────────────────

  async addMembers(
    userId: string,
    tripId: string,
    input: AddMembersInput,
  ): Promise<TripMemberDto[]> {
    await this.access.assertOwner(tripId, userId);
    const targetIds = Array.from(new Set(input.userIds)).filter((id) => id !== userId);
    if (targetIds.length === 0) {
      throw ApiError.badRequest('No new members to add');
    }
    const found = await this.trips.countActiveUsers(targetIds);
    if (found !== targetIds.length) {
      throw ApiError.badRequest('One or more userIds reference users that do not exist');
    }
    const rows = await this.trips.addMembers(tripId, targetIds);
    return rows.map(toMember);
  }

  async removeMember(userId: string, tripId: string, targetUserId: string): Promise<void> {
    await this.access.assertOwner(tripId, userId);
    const target = await this.trips.findMembership(tripId, targetUserId);
    if (target === null) throw ApiError.notFound('Member not found in this trip');
    if (target.role === 'OWNER') {
      throw ApiError.forbidden('The trip owner cannot be removed');
    }
    const netMinor = await this.getMemberNetBalance(tripId, targetUserId);
    if (netMinor !== 0) {
      throw ApiError.badRequest('User has pending balances. Please settle first.');
    }
    await this.trips.removeMember(tripId, targetUserId);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Computes the net balance for a single member in a trip.
   * net = totalPaid − totalShare + settlementsOut − settlementsIn.
   * Returns 0 when the member has no activity.
   */
  private async getMemberNetBalance(tripId: string, userId: string): Promise<number> {
    const [expenseRows, settlementRows] = await Promise.all([
      this.expenseRepo.findForBalances(tripId),
      this.settlementRepo.findCompletedForBalances(tripId),
    ]);
    let net = 0;
    for (const e of expenseRows) {
      for (const payment of e.payments) {
        if (payment.userId === userId) net += payment.contributionMinor;
      }
      for (const p of e.participants) {
        if (p.userId === userId) net -= p.shareMinor;
      }
    }
    for (const s of settlementRows) {
      if (s.fromUserId === userId) net += s.amountMinor;
      if (s.toUserId === userId) net -= s.amountMinor;
    }
    return net;
  }


  /**
   * Stable rotation through the warm palette. Picks based on Date.now()
   * so consecutive calls don't collide. Predictability isn't required —
   * this is purely cosmetic.
   */
  private pickCoverColor(): string {
    const idx = Math.floor(Date.now() / 1000) % TRIP_COVER_COLORS.length;
    return TRIP_COVER_COLORS[idx] ?? TRIP_COVER_COLORS[0];
  }
}
