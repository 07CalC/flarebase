import { sanitizeAuthRecord } from "./auth";
import { AppError, ResponseCode } from "./response";
import type { Collection, Field } from "../services/collection.service";

export function normalizeWriteValues(
  fields: Field[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const normalized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) {
    const field = byName.get(name);
    if (!field || value === undefined) {
      normalized[name] = value;
      continue;
    }
    switch (field.type) {
      case "date":
        normalized[name] = normalizeDateValue(name, value);
        break;
      case "bool":
        normalized[name] = value ? 1 : 0;
        break;
      case "json":
        normalized[name] = JSON.stringify(value);
        break;
      case "file":
        // not implemented yet
        throw new AppError(
          `File uploads are not supported yet (field "${name}")`,
          400,
          ResponseCode.VALIDATION_ERROR,
        );
      default:
        normalized[name] = value;
    }
  }
  return normalized;
}

export function normalizeDateValue(name: string, value: unknown): string {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new AppError(
      `Field "${name}" must be a valid date`,
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  return new Date(ms).toISOString();
}

export function presentRecord(
  row: Record<string, unknown>,
  collection: Collection,
): Record<string, unknown> {
  const record = sanitizeAuthRecord(row, collection.fields) as Record<
    string,
    unknown
  >;
  for (const field of collection.fields) {
    if (!(field.name in record)) continue;
    const value = record[field.name];
    if (field.type === "json" && typeof value === "string") {
      try {
        record[field.name] = JSON.parse(value);
      } catch {
      }
    } else if (field.type === "bool" && value !== null) {
      record[field.name] = Boolean(value);
    }
  }
  return record;
}
