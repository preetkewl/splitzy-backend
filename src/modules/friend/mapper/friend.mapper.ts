import type { User } from '@prisma/client';
import type {
  FriendDto,
  FriendRequestDto,
  FriendUserPreviewDto,
} from '../dto/index.js';
import type {
  FriendRequestWithUsers,
  FriendshipWithUsers,
} from '../repository/friend.repository.js';

export function toFriendUserPreview(user: User): FriendUserPreviewDto {
  return {
    userId: user.id,
    name: user.name,
    handle: user.handle,
    avatarColor: user.avatarColor,
    avatarUrl: user.avatarUrl,
  };
}

/**
 * `Friendship` rows are stored canonically (userA < userB). The viewing
 * user is on one side of that pair — return the *other* user as the
 * "friend".
 */
export function toFriendDto(row: FriendshipWithUsers, viewerUserId: string): FriendDto {
  const other = row.userAId === viewerUserId ? row.userB : row.userA;
  return {
    ...toFriendUserPreview(other),
    since: row.since.toISOString(),
  };
}

export function toFriendRequestDto(
  row: FriendRequestWithUsers,
  viewerUserId: string,
): FriendRequestDto {
  const direction = row.toUserId === viewerUserId ? 'incoming' : 'outgoing';
  const counterparty = direction === 'incoming' ? row.fromUser : row.toUser;
  return {
    id: row.id,
    direction,
    status: row.status,
    counterparty: toFriendUserPreview(counterparty),
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
  };
}
