import { z } from 'zod';
import { MAX_TRIP_MEMBERS } from '../../../database/constants.js';
import { HEX_COLOR_PATTERN } from '../../auth/constants.js';
import {
  MAX_TRIP_DESCRIPTION_LENGTH,
  MAX_TRIP_EMOJI_LENGTH,
  MAX_TRIP_NAME_LENGTH,
  MIN_TRIP_NAME_LENGTH,
} from '../constants.js';

const uuid = z.string().uuid('Must be a valid UUID');

const tripNameSchema = z
  .string()
  .trim()
  .min(MIN_TRIP_NAME_LENGTH)
  .max(MAX_TRIP_NAME_LENGTH);

const tripEmojiSchema = z
  .string()
  .min(1)
  .max(MAX_TRIP_EMOJI_LENGTH);

const coverColorSchema = z.string().regex(HEX_COLOR_PATTERN, 'coverColor must be #RRGGBB hex');

const tripDescriptionSchema = z
  .string()
  .max(MAX_TRIP_DESCRIPTION_LENGTH)
  .nullable();

// ── Endpoint schemas ─────────────────────────────────────────────────────────

export const tripIdParamSchema = z.object({
  tripId: uuid,
});

export const tripMemberParamSchema = z.object({
  tripId: uuid,
  memberId: uuid,
});

export const createTripBodySchema = z.object({
  name: tripNameSchema,
  emoji: tripEmojiSchema,
  coverColor: coverColorSchema.optional(),
  description: tripDescriptionSchema.optional(),
  memberIds: z
    .array(uuid)
    .max(MAX_TRIP_MEMBERS, `A trip can have at most ${MAX_TRIP_MEMBERS} members`)
    .default([]),
});

export const updateTripBodySchema = z
  .object({
    name: tripNameSchema.optional(),
    emoji: tripEmojiSchema.optional(),
    coverColor: coverColorSchema.optional(),
    description: tripDescriptionSchema.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one field is required',
  });

export const addMembersBodySchema = z.object({
  userIds: z.array(uuid).min(1, 'At least one userId is required'),
});

export const listTripsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type TripIdParam = z.infer<typeof tripIdParamSchema>;
export type TripMemberParam = z.infer<typeof tripMemberParamSchema>;
export type CreateTripBody = z.infer<typeof createTripBodySchema>;
export type UpdateTripBody = z.infer<typeof updateTripBodySchema>;
export type AddMembersBody = z.infer<typeof addMembersBodySchema>;
export type ListTripsQuery = z.infer<typeof listTripsQuerySchema>;
