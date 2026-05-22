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

export function toUserDto(user: User): UserDto {
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
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
