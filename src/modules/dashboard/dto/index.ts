import type { TripSummaryDto } from '../../trip/dto/index.js';

/** A trip summary augmented with the requesting user's net for that trip. */
export interface DashboardTripDto extends TripSummaryDto {
  /** > 0: you're owed; < 0: you owe; 0: settled. Equals `/balances` net. */
  viewerNetMinor: number;
}

export interface DashboardOverallDto {
  /** owedMinor − oweMinor. */
  netMinor: number;
  /** Sum of positive per-trip nets. */
  owedMinor: number;
  /** Sum of |negative per-trip nets|. */
  oweMinor: number;
}

/**
 * App-bootstrap / dashboard payload for `GET /me/dashboard`. Collapses the old
 * Home fan-out (`/trips` + N×`/balances` + friend requests) into one response.
 */
export interface DashboardDto {
  trips: DashboardTripDto[];
  overall: DashboardOverallDto;
  friends: { incomingRequestCount: number };
  /** Placeholder for a future activity preview/count. Intentionally empty. */
  activity: Record<string, never>;
  /** Server timestamp (ISO) — for debugging and future client-side caching. */
  generatedAt: string;
}
