/**
 * Pluggable OTP provider. The architecture stays identical for mock,
 * Twilio Verify, MSG91, or AWS SNS — only `start` and `verify` change.
 *
 * `challengeId` is provider-specific opaque state. AuthService wraps it
 * in a signed JWT before returning it to the client, so the client can
 * round-trip it back at verify time without leaking server internals.
 */
export interface OtpProvider {
  /**
   * Initiate an OTP challenge. For real providers, this triggers SMS
   * delivery. Mock returns immediately.
   *
   * @param phone Normalized E.164 phone (e.g. +919876512345)
   * @returns provider-specific challenge id + optional debug otp (dev only)
   */
  start(phone: string): Promise<OtpStartResult>;

  /**
   * Verify a user-supplied OTP against an active challenge.
   *
   * @returns true if the OTP matches; false otherwise.
   */
  verify(challengeId: string, phone: string, otp: string): Promise<boolean>;

  /** Stable identifier (e.g. "mock", "twilio"). Useful in logs/metrics. */
  readonly name: string;
}

export interface OtpStartResult {
  challengeId: string;
  /**
   * Only set in non-production for the mock provider. Lets the dev
   * frontend autofill the OTP without an SMS round-trip.
   */
  devOtp?: string;
}
