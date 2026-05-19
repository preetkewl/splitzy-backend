import * as admin from 'firebase-admin';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let _initialized = false;
let _messaging: admin.messaging.Messaging | null = null;

if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as admin.ServiceAccount;
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    _initialized = true;
    _messaging = admin.messaging();
    logger.info('Firebase Admin SDK initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Firebase Admin SDK — Firebase features disabled');
  }
} else {
  logger.warn('FIREBASE_SERVICE_ACCOUNT_JSON not set — Firebase features disabled');
}

export const messaging = _messaging;

/**
 * Returns the Firebase Auth instance for ID token verification.
 * Throws if the Admin SDK was not initialized (FIREBASE_SERVICE_ACCOUNT_JSON missing).
 */
export function getFirebaseAuth(): admin.auth.Auth {
  if (!_initialized) {
    throw new Error('Firebase Admin SDK is not initialized — set FIREBASE_SERVICE_ACCOUNT_JSON');
  }
  return admin.auth();
}
