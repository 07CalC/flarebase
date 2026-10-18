import type { Field } from "../services/collection.service";
import type { AuthUser } from "../config";

export const SUPERUSERS_COLLECTION = "_superusers";

// every collection that is type='auth' must have these fields
// otherwise, auth with password won't work
export const AUTH_REQUIRED_FIELDS = ["email", "password"] as const;

export function isSuperusersCollection(name: string): boolean {
  return name === SUPERUSERS_COLLECTION;
}

// field names that are sensitive no matter what the metadata says
const ALWAYS_SENSITIVE_FIELDS = new Set(["password"]);

// an auth record is just any record which came from an auth collection, but we need to sanitize it before exposing it to the client or attaching it to req context, 
// sanitizeAuthRecord:
// - removes any fields that are marked as hidden in the collection metadata
// - removes any fields that are always sensitive (like password)
export function sanitizeAuthRecord(
  row: Record<string, unknown>,
  fields: Field[] = [],
): AuthUser {
  const hidden = new Set(
    fields.filter((f) => f.hidden).map((f) => f.name.toLowerCase()),
  );
  const sanitized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    const lower = name.toLowerCase();
    if (ALWAYS_SENSITIVE_FIELDS.has(lower) || hidden.has(lower)) {
      continue;
    }
    sanitized[name] = value;
  }
  return sanitized as unknown as AuthUser;
}
