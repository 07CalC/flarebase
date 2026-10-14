import { z } from "zod";

export const SUPERUSERS_COLLECTION = "_superusers";

// every collection that is type='auth' must have these fields
// otherwise, auth with password won't work
export const AUTH_REQUIRED_FIELDS = ["email", "password"] as const;

export function isSuperusersCollection(name: string): boolean {
  return name === SUPERUSERS_COLLECTION;
}

export const authCreateSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(128),
});

export type AuthCreateInput = z.infer<typeof authCreateSchema>;

export function sanitizeAuthRecord<T extends Record<string, any>>(
  row: T,
): Omit<T, "password"> {
  const { password: _omitted, ...rest } = row;
  return rest;
}
