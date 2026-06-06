import type { Activity, Prisma, PrismaClient } from '@prisma/client';

/** A single row to insert into the fan-out feed. */
export interface ActivityCreateRow {
  userId: string;
  actorId: string;
  type: Activity['type'];
  entityType: Activity['entityType'];
  entityId: string | null;
  tripId: string | null;
  metadata: Prisma.InputJsonValue;
}

/** Opaque keyset cursor decoded from the request. */
export interface ActivityCursor {
  createdAt: Date;
  id: string;
}

export interface ActivityRepository {
  createMany(rows: ActivityCreateRow[]): Promise<number>;
  listForUser(userId: string, limit: number, cursor: ActivityCursor | null): Promise<Activity[]>;
}

export class PrismaActivityRepository implements ActivityRepository {
  constructor(private readonly db: PrismaClient) {}

  async createMany(rows: ActivityCreateRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await this.db.activity.createMany({ data: rows });
    return result.count;
  }

  /**
   * Reverse-chronological feed for one recipient, keyset-paginated on
   * (createdAt, id). Served entirely by the
   * `activities_user_id_created_at_id_idx` composite index.
   *
   * Returns up to `limit` rows. The caller passes `limit + 1` to detect
   * whether a next page exists.
   */
  listForUser(userId: string, limit: number, cursor: ActivityCursor | null): Promise<Activity[]> {
    return this.db.activity.findMany({
      where: {
        userId,
        ...(cursor
          ? {
              // Strictly older than the cursor: earlier timestamp, or same
              // timestamp with a smaller id (stable tiebreaker).
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }
}
