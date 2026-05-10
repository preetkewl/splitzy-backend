import type { User } from '@prisma/client';
import { MIN_NAME_LENGTH } from '../constants.js';
import type { UserDto } from '../dto/index.js';

/**
 * A profile is "complete" once the user has set a real name. The handle
 * is auto-generated at user creation, so it's never empty. The frontend
 * router uses this exact rule (see splitzy/lib/routing/router.dart).
 */
export function isProfileComplete(user: Pick<User, 'name'>): boolean {
  return user.name.trim().length >= MIN_NAME_LENGTH;
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    phone: user.phone,
    handle: user.handle,
    name: user.name,
    avatarColor: user.avatarColor,
    avatarUrl: user.avatarUrl,
    upiId: user.upiId,
    email: user.email,
    profileComplete: isProfileComplete(user),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
