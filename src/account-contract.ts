import { z } from "zod";
export const accountUserIdSchema = z.string().regex(/^user_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export const accountProfileSchema = z.object({
  userId: accountUserIdSchema,
  displayName: z.string(),
  bio: z.string(),
  website: z.string(),
  avatarUrl: z.url().nullable(),
  updatedAt: z.string(),
  version: z.number().int().nonnegative(),
});
export const accountSchema = z.object({
  user: z.object({ id: accountUserIdSchema, email: z.email(), emailVerified: z.boolean() }),
  profile: accountProfileSchema,
});
export type Account = z.infer<typeof accountSchema>;
export type AccountProfile = z.infer<typeof accountProfileSchema>;
