import { SettlementMethod } from '@prisma/client';
import { z } from 'zod';
import {
  MAX_EXTERNAL_REF_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_SETTLEMENT_AMOUNT_MINOR,
  MIN_SETTLEMENT_AMOUNT_MINOR,
} from '../constants.js';

const uuid = z.string().uuid('Must be a valid UUID');

const amountMinorSchema = z
  .number()
  .int('amountMinor must be an integer (minor units, not whole currency)')
  .min(MIN_SETTLEMENT_AMOUNT_MINOR)
  .max(MAX_SETTLEMENT_AMOUNT_MINOR);

const methodSchema = z.nativeEnum(SettlementMethod);

export const tripIdParamSchema = z.object({ tripId: uuid });

export const createSettlementBodySchema = z.object({
  tripId: uuid,
  fromUserId: uuid,
  toUserId: uuid,
  amountMinor: amountMinorSchema,
  method: methodSchema.optional(),
  note: z.string().max(MAX_NOTE_LENGTH).nullable().optional(),
  externalRef: z.string().max(MAX_EXTERNAL_REF_LENGTH).nullable().optional(),
});

export const listSettlementsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type TripIdParam = z.infer<typeof tripIdParamSchema>;
export type CreateSettlementBody = z.infer<typeof createSettlementBodySchema>;
export type ListSettlementsQuery = z.infer<typeof listSettlementsQuerySchema>;
