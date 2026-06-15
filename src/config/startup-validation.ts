import { env, isProd } from './env.js';
import { logger } from '../utils/logger.js';

/** Monetization-relevant config presence (no secret values are logged). */
interface MonetizationConfigStatus {
  required: boolean;
  configured: boolean;
  missing: string[];
  present: string[];
}

function inspectMonetizationConfig(): MonetizationConfigStatus {
  // Effective "required": explicit flag wins; otherwise required in production.
  const required = env.MONETIZATION_REQUIRED ?? isProd;

  const checks: Array<[name: string, present: boolean]> = [
    ['GOOGLE_PLAY_PACKAGE_NAME', Boolean(env.GOOGLE_PLAY_PACKAGE_NAME)],
    ['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', Boolean(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON)],
    ['RTDN_VERIFICATION_TOKEN', Boolean(env.RTDN_VERIFICATION_TOKEN)],
  ];

  const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
  const present = checks.filter(([, ok]) => ok).map(([name]) => name);
  return { required, configured: missing.length === 0, missing, present };
}

/**
 * Startup diagnostics + fail-fast for monetization config.
 *
 * Logs a single structured readiness line every boot. When monetization is
 * REQUIRED (prod by default, or `MONETIZATION_REQUIRED=true`) and any secret is
 * missing, THROWS so the process exits during bootstrap — a broken billing
 * surface never silently serves traffic. Set `MONETIZATION_REQUIRED=false` to
 * intentionally run without billing.
 *
 * Note: the service-account JSON is only checked for PRESENCE here; its
 * parseability is validated by the Google client at first use (logged, not
 * fatal — verify then fails closed rather than bricking the whole API).
 */
export function validateMonetizationConfig(): void {
  const status = inspectMonetizationConfig();

  logger.info(
    {
      evt: 'startup',
      component: 'monetization',
      required: status.required,
      configured: status.configured,
      missing: status.missing,
    },
    `monetization config: ${status.configured ? 'complete' : `missing ${String(status.missing.length)}`}`,
  );

  if (status.required && !status.configured) {
    throw new Error(
      `Monetization is required but missing: ${status.missing.join(', ')}. ` +
        'Provide the secrets, or set MONETIZATION_REQUIRED=false to run without billing.',
    );
  }

  if (!status.required && !status.configured) {
    logger.warn(
      { evt: 'startup', component: 'monetization', missing: status.missing },
      'monetization NOT fully configured — verify fails closed and RTDN is rejected. ' +
        'This is expected only for non-billing environments.',
    );
  }
}
