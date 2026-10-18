import { AppError, ResponseCode } from "./response";
import type { Collection } from "../services/collection.service";

// column names for an insert must be actual collection fields; the request
// body is untrusted so its keys are never allowed straight into SQL
function assertInsertFields(collection: Collection, data: Record<string, any>): string[] {
  const known = new Set(collection.fields.map((f) => f.name));
  const unknown = Object.keys(data).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new AppError(
      `Unknown field(s): ${unknown.join(", ")}`,
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  return Object.keys(data);
}

function buildInsertParts(
  collection: Collection,
  data: Record<string, any>,
): { columns: string; placeholders: string; values: unknown[] } {
  const fieldNames = assertInsertFields(collection, data);
  return {
    columns: fieldNames.map((name) => `"${name}"`).join(", "),
    placeholders: fieldNames.map((_, index) => `?${index + 1}`).join(", "),
    values: fieldNames.map((name) => data[name]),
  };
}

export function buildCreateRecordQuery(
  collection: Collection,
  data: Record<string, any>,
): { query: string; values: unknown[] } {
  const { columns, placeholders, values } = buildInsertParts(collection, data);
  return {
    query: `
      INSERT INTO "${collection.name}" (${columns})
      VALUES (${placeholders})
      RETURNING *
    `,
    values,
  };
}

// Same insert, but only performed while the target table has no rows at all.
// Used by the "anyone can create the first superuser" bootstrap so two
// concurrent first-signups cannot both slip past a stale count check.
export function buildCreateRecordIfEmptyQuery(
  collection: Collection,
  data: Record<string, any>,
): { query: string; values: unknown[] } {
  const { columns, placeholders, values } = buildInsertParts(collection, data);
  return {
    query: `
      INSERT INTO "${collection.name}" (${columns})
      SELECT ${placeholders}
      WHERE NOT EXISTS (SELECT 1 FROM "${collection.name}")
      RETURNING *
    `,
    values,
  };
}
