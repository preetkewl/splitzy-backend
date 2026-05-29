import type { PrismaClient, User } from '@prisma/client';
import { SettlementStatus } from '@prisma/client';

export interface CreateUserInput {
  firebaseUid: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
  handle: string;
  avatarColor: string;
}

export interface UpdateUserInput {
  name?: string;
  handle?: string;
  avatarColor?: string;
  upiId?: string | null;
  avatarUrl?: string | null;
  phone?: string | null;
}

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByFirebaseUid(firebaseUid: string): Promise<User | null>;
  findByHandle(handle: string): Promise<User | null>;
  findByPhone(phone: string): Promise<User | null>;
  create(input: CreateUserInput): Promise<User>;
  update(id: string, input: UpdateUserInput): Promise<User>;
  softDelete(id: string): Promise<User>;
  /**
   * Returns true if the user has any non-zero net balance across all their
   * trips (i.e. they either owe money or are owed money somewhere).
   * Used to guard account deletion.
   */
  hasOutstandingBalance(userId: string): Promise<boolean>;
}

export class UserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  findByFirebaseUid(firebaseUid: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { firebaseUid, deletedAt: null } });
  }

  findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { phone, deletedAt: null } });
  }

  findByHandle(handle: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { handle, deletedAt: null } });
  }

  create(input: CreateUserInput): Promise<User> {
    return this.prisma.user.create({ data: input });
  }

  update(id: string, input: UpdateUserInput): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: input });
  }

  softDelete(id: string): Promise<User> {
    // Derive a unique anonymous handle from the user's own UUID so the
    // NOT NULL + UNIQUE constraint on handle is never violated.
    const anonHandle = `deleted_${id.replace(/-/g, '').slice(0, 16)}`;
    return this.prisma.user.update({
      where: { id },
      data: {
        name: 'Deleted User',
        email: null,
        phone: null,
        avatarUrl: null,
        upiId: null,
        firebaseUid: null,
        handle: anonHandle,
        deletedAt: new Date(),
      },
    });
  }

  /**
   * Returns true if the user has a non-zero net balance in ANY single trip.
   *
   * Why per-trip instead of a global aggregate?
   * A global sum can reach zero even when real debts exist — e.g. if the
   * user owes ₹100 to Alice in Trip 1 and is owed ₹100 by Bob in Trip 2,
   * the totals cancel out globally but neither obligation has been settled.
   * Checking each trip independently prevents deletion in that case.
   *
   * Per-trip net formula (same as TripService.getMemberNetBalance):
   *   net = totalPaid − totalShare + settledOut − settledIn
   *
   * Runs 4 parallel aggregates per trip — acceptable for a rare,
   * user-triggered delete operation.
   */
  async hasOutstandingBalance(userId: string): Promise<boolean> {
    const memberships = await this.prisma.tripMember.findMany({
      where: { userId },
      select: { tripId: true },
    });

    for (const { tripId } of memberships) {
      const [paid, owed, settledOut, settledIn] = await Promise.all([
        // What the user contributed as a payer in this trip (payment dimension)
        this.prisma.expensePayment.aggregate({
          where: { userId, expense: { tripId, deletedAt: null } },
          _sum: { contributionMinor: true },
        }),
        // What the user owes as a participant in this trip (obligation dimension)
        this.prisma.expenseParticipant.aggregate({
          where: { userId, expense: { tripId, deletedAt: null } },
          _sum: { shareMinor: true },
        }),
        // Settlements the user sent in this trip (reduces debt)
        this.prisma.settlement.aggregate({
          where: { tripId, fromUserId: userId, status: SettlementStatus.COMPLETED },
          _sum: { amountMinor: true },
        }),
        // Settlements the user received in this trip (reduces credit)
        this.prisma.settlement.aggregate({
          where: { tripId, toUserId: userId, status: SettlementStatus.COMPLETED },
          _sum: { amountMinor: true },
        }),
      ]);

      const net =
        (paid._sum.contributionMinor ?? 0) -
        (owed._sum.shareMinor ?? 0) +
        (settledOut._sum.amountMinor ?? 0) -
        (settledIn._sum.amountMinor ?? 0);

      if (net !== 0) return true;
    }

    return false;
  }
}
