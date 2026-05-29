import { SettlementMethod } from '@prisma/client';
import { ApiError } from '../../../core/api-error.js';
import { paginate, type PaginationInput } from '../../../database/helpers.js';
import { logger } from '../../../utils/logger.js';
import type { NotificationService } from '../../notification/service/notification.service.js';
import type { ITripRepository } from '../../trip/repository/trip.repository.js';
import { TripAccess } from '../../trip/service/access.js';
import type { CreateSettlementInput, SettlementDto } from '../dto/index.js';
import { toSettlementDto } from '../mapper/settlement.mapper.js';
import type { ISettlementRepository } from '../repository/settlement.repository.js';

export interface ListSettlementsResult {
  items: SettlementDto[];
  page: number;
  pageSize: number;
  total: number;
}

export class SettlementService {
  private readonly access: TripAccess;

  constructor(
    private readonly settlements: ISettlementRepository,
    private readonly trips: ITripRepository,
    private readonly notifications: NotificationService,
  ) {
    this.access = new TripAccess(trips);
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(userId: string, input: CreateSettlementInput): Promise<SettlementDto> {
    if (input.fromUserId === input.toUserId) {
      throw ApiError.badRequest('fromUserId and toUserId must differ');
    }
    if (input.amountMinor <= 0) {
      throw ApiError.badRequest('amountMinor must be positive');
    }

    // Caller must be a trip member.
    await this.access.assertMember(input.tripId, userId);

    // Both parties must be current trip members. We pull the detail row
    // once and reuse it for both checks — no per-id round trips.
    const trip = await this.trips.findDetail(input.tripId);
    if (trip === null) throw ApiError.notFound('Trip not found');
    const memberIds = new Set(trip.members.map((m) => m.userId));
    if (!memberIds.has(input.fromUserId)) {
      throw ApiError.badRequest('fromUserId is not a member of this trip');
    }
    if (!memberIds.has(input.toUserId)) {
      throw ApiError.badRequest('toUserId is not a member of this trip');
    }

    const created = await this.settlements.create({
      tripId: input.tripId,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      amountMinor: input.amountMinor,
      method: input.method ?? SettlementMethod.UPI,
      note: input.note ?? null,
      externalRef: input.externalRef ?? null,
      createdById: userId,
    });

    logger.info(
      {
        settlementId: created.id,
        tripId: input.tripId,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        amountMinor: input.amountMinor,
        method: created.method,
      },
      'settlement recorded',
    );

    // Notify the recipient that they received a payment.
    void this.notifications.sendToUser(input.toUserId, {
      title: 'Payment received',
      body: `${created.fromUser.name} settled up with you`,
      type: 'SETTLEMENT_RECEIVED',
      data: { tripId: input.tripId, settlementId: created.id },
    });

    return toSettlementDto(created);
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async list(
    userId: string,
    tripId: string,
    pagination: PaginationInput,
  ): Promise<ListSettlementsResult> {
    await this.access.assertMember(tripId, userId);
    const params = paginate(pagination);
    const { rows, total } = await this.settlements.listByTrip(tripId, params);
    return {
      items: rows.map((r) => toSettlementDto(r)),
      page: params.page,
      pageSize: params.pageSize,
      total,
    };
  }
}
