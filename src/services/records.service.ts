import { mapD1Error } from "../lib/d1-error";
import { buildCreateRecordIfEmptyQuery, buildCreateRecordQuery } from "../lib/sql-query";
import { Collection, getNonHiddenCollectionField } from "./collection.service";


export async function getRecords(db: D1Database, collection: Collection) {
  const fields = getNonHiddenCollectionField(collection);
  const fieldsToSelect = fields.map(f => `"${f.name}"`).join(", ");
  const query = `
    SELECT ${fieldsToSelect} FROM "${collection.name}"
  `;
  const result = await db.prepare(query).all();
  return result.results;
}

export interface GetRecordOptions {
  // false (default): project only non-hidden fields
  // true: SELECT * — full row incl. hidden fields; callers must sanitize
  //       sensitive fields themselves before exposing the row
  includeHiddenFields?: boolean;
}

export async function getRecordById(
  db: D1Database,
  collection: Collection,
  recordId: string,
  options: GetRecordOptions = {},
) {
  if (options.includeHiddenFields) {
    const query = `
      SELECT * FROM "${collection.name}" WHERE id = ?1
    `;
    const result = await db.prepare(query).bind(recordId).first();
    return result || null;
  }

  const fields = getNonHiddenCollectionField(collection);
  const fieldsToSelect = fields.map(f => `"${f.name}"`).join(", ");
  const query = `
    SELECT ${fieldsToSelect} FROM "${collection.name}" WHERE id = ?1
  `;
  const result = await db.prepare(query).bind(recordId).first();
  return result || null;
}

export async function countRecords(db: D1Database, collection: Collection) {
  const query = `
    SELECT COUNT(*) as count FROM "${collection.name}"
  `;
  const result = await db.prepare(query).first<{ count: number }>();
  return result?.count || 0;
}

export async function createRecord(db: D1Database, collection: Collection, data: Record<string, any>) {
  try {
    const { query, values } = buildCreateRecordQuery(collection, data);
    const result = await db.prepare(query).bind(...values).first();
    return result || null;
  } catch (error) {
    mapD1Error(error);
  }
}

export async function createRecordOnlyIfEmpty(db: D1Database, collection: Collection, data: Record<string, any>) {
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

