import { mapD1Error } from "../lib/d1-error";
import { AppError, ResponseCode } from "../lib/response";
import { quoteIdent } from "../lib/collection-name";
import {
  buildCreateRecordIfEmptyQuery,
  buildCreateRecordQuery,
  buildDeleteRecordQuery,
  buildGetRecordQuery,
  buildListRecordsQuery,
  buildUpdateRecordQuery,
  type ListRecordsOptions,
  type SqlFilter,
} from "../lib/sql-query";
import { Collection } from "./collection.service";

function generateRecordId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ListRecordsResult {
  items: Record<string, any>[];
  totalItems: number;
}

export async function getRecords(
  db: D1Database,
  collection: Collection,
  options: ListRecordsOptions,
): Promise<ListRecordsResult> {
  try {
    const { query, countQuery, filterValues, offset } = buildListRecordsQuery(
      collection,
      options,
    );
    const rows = await db
      .prepare(query)
      .bind(...filterValues, options.perPage, offset)
      .all<Record<string, any>>();
    const count = await db
      .prepare(countQuery)
      .bind(...filterValues)
      .first<{ count: number }>();
    return { items: rows.results ?? [], totalItems: count?.count ?? 0 };
  } catch (error) {
    mapD1Error(error);
  }
}

export interface GetRecordOptions {
  // false (default): project only non-hidden fields
  // true: SELECT * — full row incl. hidden fields; callers must sanitize
  //       sensitive fields themselves before exposing the row
  includeHiddenFields?: boolean;
  // compiled rule predicate; rows that fail it look like missing rows
  filter?: SqlFilter | null;
}

export async function getRecordById(
  db: D1Database,
  collection: Collection,
  recordId: string,
  options: GetRecordOptions = {},
) {
  try {
    const { query, values } = buildGetRecordQuery(collection, recordId, options);
    const result = await db.prepare(query).bind(...values).first();
    return result || null;
  } catch (error) {
    mapD1Error(error);
  }
}

export async function createRecord(
  db: D1Database,
  collection: Collection,
  data: Record<string, any>,
  filter?: SqlFilter | null,
) {
  try {
    // ids are generated app-side (like PocketBase) so the rule-guarded insert
    // always has at least one column to select into
    const row = { id: generateRecordId(), ...data };
    const { query, values } = buildCreateRecordQuery(collection, row, filter);
    const result = await db.prepare(query).bind(...values).first();
    // null = the create rule filtered the insert; the caller fails the write
    return result || null;
  } catch (error) {
    mapD1Error(error);
  }
}

export async function updateRecordById(
  db: D1Database,
  collection: Collection,
  recordId: string,
  data: Record<string, any>,
  filter?: SqlFilter | null,
) {
  try {
    const { query, values } = buildUpdateRecordQuery(
      collection,
      recordId,
      data,
      filter,
    );
    const result = await db.prepare(query).bind(...values).first();
    // null = no such row, or the update rule filtered it (both surface 404)
    return result || null;
  } catch (error) {
    mapD1Error(error);
  }
}

export async function deleteRecordById(
  db: D1Database,
  collection: Collection,
  recordId: string,
  filter?: SqlFilter | null,
) {
  try {
    const { query, values } = buildDeleteRecordQuery(
      collection,
      recordId,
      filter,
    );
    const result = await db.prepare(query).bind(...values).first();
    // null = no such row, or the delete rule filtered it (both surface 404)
    return result || null;
  } catch (error) {
    mapD1Error(error);
  }
}

/**
 * Delete for the `_superusers` system collection with an atomic
 * last-superuser guard. Emptying the table would silently reopen the public
 * bootstrap window (`createRecordOnlyIfEmpty`), so at least one row must
 * always remain. The count check and delete are one statement, so concurrent
 * deletes can never remove the final superuser.
 *
 * Returns `null` for a missing/filtered row (surface 404, no existence
 * oracle); an existing row blocked by the guard raises 409.
 */
export async function deleteSuperuserById(
  db: D1Database,
  collection: Collection,
  recordId: string,
  filter?: SqlFilter | null,
) {
  try {
    const values: unknown[] = [recordId];
    let where = "id = ?";
    if (filter) {
      where += ` AND (${filter.sql})`;
      values.push(...filter.values);
    }
    where += ` AND (SELECT COUNT(*) FROM ${quoteIdent(collection.name)}) > 1`;
    const result = await db
      .prepare(
        `DELETE FROM ${quoteIdent(collection.name)} WHERE ${where} RETURNING *`,
      )
      .bind(...values)
      .first();
    if (result) return result;
    // rule-filtered deletes keep the no-oracle 404 behavior
    if (filter) return null;
    if (await recordExists(db, collection, recordId)) {
      throw new AppError(
        "Cannot delete the last superuser",
        409,
        ResponseCode.CONFLICT,
      );
    }
    return null;
  } catch (error) {
    mapD1Error(error);
  }
}

// Existence probe for relation validation; never projects field values.
export async function recordExists(
  db: D1Database,
  collection: Collection,
  recordId: string,
): Promise<boolean> {
  try {
    const result = await db
      .prepare(`SELECT 1 FROM ${quoteIdent(collection.name)} WHERE id = ? LIMIT 1`)
      .bind(recordId)
      .first();
    return result !== null && result !== undefined;
  } catch (error) {
    mapD1Error(error);
  }
}

export async function createRecordOnlyIfEmpty(
  db: D1Database,
  collection: Collection,
  data: Record<string, any>,
) {
  try {
    const { query, values } = buildCreateRecordIfEmptyQuery(collection, data);
    const result = await db.prepare(query).bind(...values).first();
    // null means the table already has rows (or got one concurrently),
    // the caller decides how to surface that
    return result || null;
  } catch (error) {
    mapD1Error(error);
  }
}

export async function getRecordByField(
  db: D1Database,
  collection: Collection,
  fieldName: string,
  fieldValue: any,
) {
  const field = collection.fields.find((f) => f.name === fieldName);
  if (!field) {
    // callers only pass trusted metadata derived field names
    // a missing one means corrupt collection metadata, same category as schema drift
    throw new AppError(
      `Field "${fieldName}" does not exist in collection "${collection.name}"`,
      500,
      ResponseCode.INTERNAL_SERVER_ERROR,
    );
  }
  try {
    const query = `
      SELECT * FROM ${quoteIdent(collection.name)} WHERE ${quoteIdent(fieldName)} = ?1
    `;
    const result = await db.prepare(query).bind(fieldValue).first();
    return result || null;
  } catch (error) {
    mapD1Error(error);
  }
}
