import { Router } from 'express';
import { healthController } from '../controller/health.controller.js';

const router = Router();

router.get('/', healthController.liveness);
router.get('/ready', healthController.readiness);

export { router as healthRouter };
