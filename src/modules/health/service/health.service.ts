import { env } from '../../../config/env.js';
import { prisma } from '../../../database/prisma.js';

export interface HealthLiveness {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
  version: string;
  environment: string;
}

export interface HealthReadiness extends Omit<HealthLiveness, 'status'> {
  status: 'ok' | 'degraded';
  checks: {
    database: 'up' | 'down';
  };
}

/**
 * Read once at module load. Avoids reading package.json on every
 * `/health` hit. Falls back to "0.0.0" if the env var is missing —
 * containers can set this at build time via `ARG VERSION=...`.
 */
const VERSION =
  process.env['npm_package_version'] ??
  process.env['SERVICE_VERSION'] ??
  '0.0.0';

export class HealthService {
  /**
   * Liveness — process is up and responding. No dependencies checked.
   * Cheap; safe to call on a tight schedule from a load balancer.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/require-await
  async getLiveness(): Promise<HealthLiveness> {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      version: VERSION,
      environment: env.NODE_ENV,
    };
  }

  /**
   * Readiness — process is ready to serve real traffic. Pings the DB.
   * Use this for K8s readiness probes / blue-green flips so we don't
   * route traffic to a pod whose Prisma connection isn't up yet.
   */
  async getReadiness(): Promise<HealthReadiness> {
    const database = await this.pingDatabase();
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      version: VERSION,
      environment: env.NODE_ENV,
      checks: { database },
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private async pingDatabase(): Promise<'up' | 'down'> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }
}

export const healthService = new HealthService();
