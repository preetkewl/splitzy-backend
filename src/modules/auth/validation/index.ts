import { z } from 'zod';
import {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  HANDLE_PATTERN,
  HEX_COLOR_PATTERN,
  MAX_NAME_LENGTH,
  MIN_NAME_LENGTH,
  PHONE_PATTERN,
  UPI_PATTERN,
} from '../constants.js';

export const phoneSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, ''))
  .pipe(z.string().regex(PHONE_PATTERN, 'Phone must be in E.164 format (e.g. +919876512345)'));

export const handleSchema = z
  .string()
  .min(HANDLE_MIN_LENGTH)
  .max(HANDLE_MAX_LENGTH)
  .regex(HANDLE_PATTERN, 'Handle may only contain a-z, 0-9, and underscore');

export const nameSchema = z.string().trim().min(MIN_NAME_LENGTH).max(MAX_NAME_LENGTH);

export const avatarColorSchema = z
  .string()
  .regex(HEX_COLOR_PATTERN, 'avatarColor must be #RRGGBB hex');

export const upiSchema = z
  .string()
  .regex(UPI_PATTERN, 'UPI ID must look like name@provider')
  .or(z.literal(''));

export const avatarUrlSchema = z.string().url().max(2048);

export const handleCheckQuerySchema = z.object({
  handle: handleSchema,
});

// ── Endpoint schemas ─────────────────────────────────────────────────────────

export const googleSignInBodySchema = z.object({
  idToken: z.string().min(1, 'idToken is required'),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export const logoutBodySchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const updateProfileBodySchema = z
  .object({
    name: nameSchema.optional(),
    handle: handleSchema.optional(),
    avatarColor: avatarColorSchema.optional(),
    upiId: upiSchema.nullable().optional(),
    avatarUrl: avatarUrlSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one field is required',
  });

export type GoogleSignInBody = z.infer<typeof googleSignInBodySchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
export type LogoutBody = z.infer<typeof logoutBodySchema>;
export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;
export type HandleCheckQuery = z.infer<typeof handleCheckQuerySchema>;
