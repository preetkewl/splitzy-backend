import { z } from 'zod';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
} from '../constants.js';

const uuid = z.string().uuid('Must be a valid UUID');

export const requestIdParamSchema = z.object({
  requestId: uuid,
});

export const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(SEARCH_QUERY_MIN_LENGTH, `Search must be at least ${SEARCH_QUERY_MIN_LENGTH} chars`)
    .max(SEARCH_QUERY_MAX_LENGTH),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(SEARCH_MAX_LIMIT)
    .default(SEARCH_DEFAULT_LIMIT)
    .optional(),
});

export const listFriendsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const sendRequestBodySchema = z.object({
  targetUserId: uuid,
  message: z.string().max(280).nullable().optional(),
});

export type RequestIdParam = z.infer<typeof requestIdParamSchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type ListFriendsQuery = z.infer<typeof listFriendsQuerySchema>;
export type SendRequestBody = z.infer<typeof sendRequestBodySchema>;
