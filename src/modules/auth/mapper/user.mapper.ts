import type { User } from '@prisma/client';
import { MIN_NAME_LENGTH } from '../constants.js';
import type { UserDto } from '../dto/index.js';

export function isProfileComplete(user: Pick<User, 'name' | 'phone'>): boolean {
  return (
    user.name.trim().length >= MIN_NAME_LENGTH &&
    typeof user.phone === 'string' &&
    user.phone.trim().length > 0
  );
}

/** The group-allowance hint surfaced on the user object (effective cap + reward state). */
export interface GroupAllowanceDto {
  limit: number;
  rewardAvailable: boolean;
}

export function toUserDto(user: User, allowance?: GroupAllowanceDto): UserDto {
  return {
    id: user.id,
    firebaseUid: user.firebaseUid,
    email: user.email,
    name: user.name,
    handle: user.handle,
    avatarColor: user.avatarColor,
    avatarUrl: user.avatarUrl,
    phone: user.phone,
    upiId: user.upiId,
    profileComplete: isProfileComplete(user),
    isPremium: user.isPremium,
    ...(allowance
      ? { groupLimit: allowance.limit, groupRewardAvailable: allowance.rewardAvailable }
      : {}),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
