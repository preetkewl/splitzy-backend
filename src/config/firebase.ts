import * as admin from 'firebase-admin';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let _messaging: admin.messaging.Messaging | null = null;

if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as admin.ServiceAccount;
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    _messaging = admin.messaging();
    logger.info('Firebase Admin SDK initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Firebase Admin SDK — push notifications disabled');
  }
} else {
  logger.warn('FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled');
}

export const messaging = _messaging;
