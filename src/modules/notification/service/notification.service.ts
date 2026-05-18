import type { Platform } from '@prisma/client';
import { messaging } from '../../../config/firebase.js';
import { logger } from '../../../utils/logger.js';
import type { IDeviceTokenRepository } from '../repository/device-token.repository.js';

export type NotificationType =
  | 'FRIEND_REQUEST'
  | 'FRIEND_ACCEPTED'
  | 'EXPENSE_ADDED'
  | 'SETTLEMENT_RECEIVED';

export interface NotificationPayload {
  title: string;
  body: string;
  type: NotificationType;
  data?: {
    tripId?: string;
    userId?: string;
    requestId?: string;
    expenseId?: string;
    settlementId?: string;
  };
}

export class NotificationService {
  constructor(private readonly tokens: IDeviceTokenRepository) {}

  async registerToken(userId: string, token: string, platform: Platform): Promise<void> {
    await this.tokens.upsert(userId, token, platform);
  }

  async removeToken(token: string): Promise<void> {
    await this.tokens.delete(token);
  }

  async sendToUser(userId: string, payload: NotificationPayload): Promise<void> {
    return this.sendToUsers([userId], payload);
  }

  async sendToUsers(userIds: string[], payload: NotificationPayload): Promise<void> {
    if (!messaging) return; // FCM not configured

    const deviceTokens = await this.tokens.findByUserIds(userIds);
    if (deviceTokens.length === 0) return;

    const fcmTokens = deviceTokens.map((dt) => dt.token);
    const dataPayload: Record<string, string> = { type: payload.type };
    if (payload.data) {
      for (const [k, v] of Object.entries(payload.data)) {
        if (v !== undefined) dataPayload[k] = v;
      }
    }

    try {
      const response = await messaging.sendEachForMulticast({
        tokens: fcmTokens,
        notification: { title: payload.title, body: payload.body },
        data: dataPayload,
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      });

      // Collect invalid tokens for cleanup.
      const invalidTokens: string[] = [];
      response.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code ?? '';
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(fcmTokens[idx]);
          } else {
            logger.warn({ error: r.error?.message, token: fcmTokens[idx] }, 'FCM send failed');
          }
        }
      });

      if (invalidTokens.length > 0) {
        await this.tokens.deleteMany(invalidTokens);
        logger.info({ count: invalidTokens.length }, 'Removed invalid FCM tokens');
      }

      logger.info(
        { success: response.successCount, failure: response.failureCount, type: payload.type },
        'FCM multicast sent',
      );
    } catch (err) {
      // Never crash the caller on notification failure.
      logger.error({ err, type: payload.type }, 'FCM sendEachForMulticast threw');
    }
  }
}
