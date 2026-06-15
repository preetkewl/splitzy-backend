import type { Router } from 'express';
import type { TokenService } from '../auth/service/token.service.js';
import type { RtdnService } from '../entitlement/service/rtdn.service.js';
import type { VerificationService } from '../entitlement/service/verification.service.js';
import { SubscriptionController } from './controller/subscription.controller.js';
import { createSubscriptionRouter } from './routes/subscription.routes.js';
import { RtdnController } from './rtdn/rtdn.controller.js';
import { SubscriptionService } from './service/subscription.service.js';

export interface SubscriptionModule {
  router: Router;
}

export function createSubscriptionModule(deps: {
  tokens: TokenService;
  verification: VerificationService;
  rtdn: RtdnService;
}): SubscriptionModule {
  const service = new SubscriptionService(deps.verification);
  const controller = new SubscriptionController(service);
  const rtdnController = new RtdnController(deps.rtdn);
  const router = createSubscriptionRouter({ controller, rtdnController, tokens: deps.tokens });
  return { router };
}
