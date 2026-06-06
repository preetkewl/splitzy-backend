import { z } from 'zod';
import { ACTIVITY_MAX_LIMIT } from '../service/activity.service.js';

export const listActivityQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(ACTIVITY_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
});

export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;
