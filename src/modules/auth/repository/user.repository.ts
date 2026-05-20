import type { PrismaClient, User } from '@prisma/client';

export interface CreateUserInput {
  firebaseUid: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
  handle: string;
  avatarColor: string;
}

export interface UpdateUserInput {
  name?: string;
  handle?: string;
  avatarColor?: string;
  upiId?: string | null;
  avatarUrl?: string | null;
  phone?: string | null;
}

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByFirebaseUid(firebaseUid: string): Promise<User | null>;
  findByHandle(handle: string): Promise<User | null>;
  findByPhone(phone: string): Promise<User | null>;
  create(input: CreateUserInput): Promise<User>;
  update(id: string, input: UpdateUserInput): Promise<User>;
  softDelete(id: string): Promise<User>;
}

export class UserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  findByFirebaseUid(firebaseUid: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { firebaseUid, deletedAt: null } });
  }

  findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { phone, deletedAt: null } });
  }

  findByHandle(handle: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { handle, deletedAt: null } });
  }

  create(input: CreateUserInput): Promise<User> {
    return this.prisma.user.create({ data: input });
  }

  update(id: string, input: UpdateUserInput): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: input });
  }

  softDelete(id: string): Promise<User> {
    // Derive a unique anonymous handle from the user's own UUID so the
    // NOT NULL + UNIQUE constraint on handle is never violated.
    const anonHandle = `deleted_${id.replace(/-/g, '').slice(0, 16)}`;
    return this.prisma.user.update({
      where: { id },
      data: {
        name: 'Deleted User',
        email: null,
        phone: null,
        avatarUrl: null,
        upiId: null,
        firebaseUid: null,
        handle: anonHandle,
        deletedAt: new Date(),
      },
    });
  }
}
