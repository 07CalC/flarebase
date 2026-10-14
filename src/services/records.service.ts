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

export async function getRecordById(db: D1Database, collection: Collection, recordId: string) {
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
  const fields = getNonHiddenCollectionField(collection);
  const fieldNames = fields.map(f => `"${f.name}"`);
  const placeholders = fields.map((_, index) => `?${index + 1}`);
  const values = fields.map(f => data[f.name]);

  const query = `
    INSERT INTO "${collection.name}" (${fieldNames.join(", ")})
    VALUES (${placeholders.join(", ")})
    RETURNING *
  `;
  const result = await db.prepare(query).bind(...values).first();
  return result || null;
}

