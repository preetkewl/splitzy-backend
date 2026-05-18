import { z } from 'zod';

export const registerTokenBodySchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ANDROID', 'IOS']),
});

export const removeTokenBodySchema = z.object({
  token: z.string().min(1),
});

export type RegisterTokenBody = z.infer<typeof registerTokenBodySchema>;
export type RemoveTokenBody = z.infer<typeof removeTokenBodySchema>;
