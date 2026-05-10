import { randomUUID } from 'node:crypto';
import { isProd } from '../../../../config/env.js';
import type { OtpProvider, OtpStartResult } from './otp-provider.js';

/**
 * Development OTP provider. Always accepts "123456" and never sends SMS.
 *
 * Replace with a real provider in production by swapping the binding in
 * `src/modules/auth/index.ts`. The contract is identical.
 */
export class MockOtpProvider implements OtpProvider {
  readonly name = 'mock';

  /** Hardcoded OTP for dev. Documented in the README. */
  static readonly OTP = '123456';

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(_phone: string): Promise<OtpStartResult> {
    const result: OtpStartResult = { challengeId: randomUUID() };
    if (!isProd) result.devOtp = MockOtpProvider.OTP;
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async verify(_challengeId: string, _phone: string, otp: string): Promise<boolean> {
    return otp === MockOtpProvider.OTP;
  }
}
