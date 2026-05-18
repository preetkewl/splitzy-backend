import type { DeviceToken, Platform, PrismaClient } from '@prisma/client';

export interface IDeviceTokenRepository {
  upsert(userId: string, token: string, platform: Platform): Promise<DeviceToken>;
  delete(token: string): Promise<void>;
  findByUserId(userId: string): Promise<DeviceToken[]>;
  findByUserIds(userIds: string[]): Promise<DeviceToken[]>;
  deleteMany(tokens: string[]): Promise<void>;
}

export class DeviceTokenRepository implements IDeviceTokenRepository {
  constructor(private readonly db: PrismaClient) {}

  upsert(userId: string, token: string, platform: Platform): Promise<DeviceToken> {
    return this.db.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
  }

  async delete(token: string): Promise<void> {
    await this.db.deviceToken.deleteMany({ where: { token } });
  }

  findByUserId(userId: string): Promise<DeviceToken[]> {
    return this.db.deviceToken.findMany({ where: { userId } });
  }

  findByUserIds(userIds: string[]): Promise<DeviceToken[]> {
    return this.db.deviceToken.findMany({ where: { userId: { in: userIds } } });
  }

  async deleteMany(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.db.deviceToken.deleteMany({ where: { token: { in: tokens } } });
  }
}
