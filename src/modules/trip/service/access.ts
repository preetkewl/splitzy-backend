import type { TripMember } from '@prisma/client';
import { ApiError } from '../../../core/api-error.js';
import type { ITripRepository } from '../repository/trip.repository.js';

/**
 * Reusable access guards for the Trip module.
 *
 * - `assertMember` — gate for any read of a trip the user is part of.
 * - `assertOwner`  — gate for mutations (update, delete, member changes).
 *
 * Both throw a 404 (not 403) when the user has *no* membership: leaking
 * trip existence to non-members would let an attacker enumerate IDs.
 * They throw 403 only once we've confirmed the caller is at least a
 * member but not the owner.
 */
export class TripAccess {
  constructor(private readonly trips: ITripRepository) {}

  async assertMember(tripId: string, userId: string): Promise<TripMember> {
    const membership = await this.trips.findMembership(tripId, userId);
    if (membership === null) {
      // Returning a 404 here also covers the case where the trip itself
      // is soft-deleted — same outward behavior, no enumeration leak.
      throw ApiError.notFound('Trip not found');
    }
    return membership;
  }

  async assertOwner(tripId: string, userId: string): Promise<TripMember> {
    const membership = await this.assertMember(tripId, userId);
    if (membership.role !== 'OWNER') {
      throw ApiError.forbidden('Only the trip owner can perform this action');
    }
    return membership;
  }
}
