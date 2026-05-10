/**
 * Seed script — populates a development database with the same Goa-trip
 * fixture used by the Flutter client (`splitzy/lib/data/seed.dart`).
 *
 * Run with:
 *   npm run db:seed         # idempotent: wipes seed-owned tables, re-inserts
 *   npx prisma db seed      # called by `prisma migrate reset`
 *
 * Safe to run repeatedly. Drops every row from the seed-owned tables in
 * FK-safe order, then re-creates the fixture.
 */
import {
  ExpenseCategory,
  PrismaClient,
  TripMemberRole,
} from '@prisma/client';
import { canonicalFriendshipPair } from '../src/database/helpers.js';
import { TRIP_COVER_COLORS } from '../src/database/constants.js';
import { BalanceEngine } from '../src/modules/expense/engine/balance-engine.js';

const prisma = new PrismaClient();

// ──────────────────────────────────────────────────────────────────────────────
// Sample data — mirrored from splitzy/lib/data/seed.dart
// ──────────────────────────────────────────────────────────────────────────────

interface SeedUser {
  phone: string;
  handle: string;
  name: string;
  avatarColor: string;
  upiId?: string;
  email?: string;
}

const SEED_USERS: Record<'aarya' | 'aarav' | 'meera' | 'kabir', SeedUser> = {
  aarya: {
    phone: '+919876512345',
    handle: 'aarya',
    name: 'Aarya Sharma',
    avatarColor: '#1F8A5B',
    upiId: 'aarya@okhdfcbank',
    email: 'aarya@example.com',
  },
  aarav: {
    phone: '+919876543210',
    handle: 'aarav',
    name: 'Aarav',
    avatarColor: '#D4845A',
  },
  meera: {
    phone: '+918765432109',
    handle: 'meera',
    name: 'Meera',
    avatarColor: '#7B74D4',
  },
  kabir: {
    phone: '+917654321098',
    handle: 'kabir',
    name: 'Kabir',
    avatarColor: '#B4A848',
  },
};

const FRI = new Date('2024-12-06T10:00:00.000Z'); // Goa trip — Friday
const SAT = new Date('2024-12-07T10:00:00.000Z');

interface SeedExpense {
  title: string;
  amountPaise: number;
  payer: 'aarya' | 'aarav' | 'meera' | 'kabir';
  category: ExpenseCategory;
  spentAt: Date;
}

const SEED_EXPENSES: SeedExpense[] = [
  { title: 'Airbnb in Anjuna',   amountPaise: 1_240_000, payer: 'aarav', category: ExpenseCategory.STAY,   spentAt: FRI },
  { title: 'Petrol — scooter',   amountPaise:    80_000, payer: 'aarya', category: ExpenseCategory.TRAVEL, spentAt: FRI },
  { title: 'Dinner at Thalassa', amountPaise:   460_000, payer: 'meera', category: ExpenseCategory.FOOD,   spentAt: FRI },
  { title: 'Beach shack lunch',  amountPaise:   184_000, payer: 'kabir', category: ExpenseCategory.FOOD,   spentAt: SAT },
  { title: 'Dudhsagar cab',      amountPaise:   320_000, payer: 'aarya', category: ExpenseCategory.TRAVEL, spentAt: SAT },
  { title: 'Club entry',         amountPaise:   240_000, payer: 'aarav', category: ExpenseCategory.FUN,    spentAt: SAT },
];

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function clearAll(): Promise<void> {
  // FK-safe order: leaves first, parents last.
  await prisma.expenseParticipant.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.settlement.deleteMany();
  await prisma.tripMember.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.friendship.deleteMany();
  await prisma.friendRequest.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
}

// ──────────────────────────────────────────────────────────────────────────────
// Seed
// ──────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🌱 seeding database…');

  await clearAll();

  // ── Users ──────────────────────────────────────────────────────────────────
  const aarya = await prisma.user.create({ data: SEED_USERS.aarya });
  const aarav = await prisma.user.create({ data: SEED_USERS.aarav });
  const meera = await prisma.user.create({ data: SEED_USERS.meera });
  const kabir = await prisma.user.create({ data: SEED_USERS.kabir });

  const userByKey = { aarya, aarav, meera, kabir } as const;
  console.log(`  ✓ users: ${Object.keys(userByKey).length}`);

  // ── Friendships (Aarya is friends with the other three) ───────────────────
  for (const friend of [aarav, meera, kabir]) {
    const pair = canonicalFriendshipPair(aarya.id, friend.id);
    await prisma.friendship.create({ data: pair });
  }
  console.log('  ✓ friendships: 3');

  // ── Trip + members ─────────────────────────────────────────────────────────
  const trip = await prisma.trip.create({
    data: {
      name: 'Goa Long Weekend',
      emoji: '🌴',
      coverColor: TRIP_COVER_COLORS[0], // sand — matches frontend seed
      createdById: aarya.id,
      createdAt: FRI,
      members: {
        create: [
          { userId: aarya.id, role: TripMemberRole.OWNER, joinedAt: FRI },
          { userId: aarav.id, role: TripMemberRole.MEMBER, joinedAt: FRI },
          { userId: meera.id, role: TripMemberRole.MEMBER, joinedAt: FRI },
          { userId: kabir.id, role: TripMemberRole.MEMBER, joinedAt: FRI },
        ],
      },
    },
    include: { members: true },
  });
  console.log(`  ✓ trip: ${trip.name} (${trip.members.length} members)`);

  // ── Expenses + equal-split participants ───────────────────────────────────
  const memberIds = trip.members.map((m) => m.userId);

  for (const e of SEED_EXPENSES) {
    const payerId = userByKey[e.payer].id;
    const shares = BalanceEngine.splitEqual(e.amountPaise, memberIds, payerId);

    await prisma.expense.create({
      data: {
        tripId: trip.id,
        title: e.title,
        amountPaise: e.amountPaise,
        category: e.category,
        paidById: payerId,
        createdById: payerId,
        spentAt: e.spentAt,
        createdAt: e.spentAt,
        participants: {
          create: shares.map((s) => ({
            userId: s.userId,
            sharePaise: s.sharePaise,
          })),
        },
      },
    });
  }
  console.log(`  ✓ expenses: ${SEED_EXPENSES.length}`);

  const total = SEED_EXPENSES.reduce((s, e) => s + e.amountPaise, 0);
  console.log(`\n✅ seed complete — total trip spend: ₹${(total / 100).toFixed(2)}`);
}

main()
  .catch((err: unknown) => {
    console.error('❌ seed failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
