

export async function getRecods(db: D1Database, collectionName: string): Promise<Record<string, any>[]> {
  const query = `SELECT * FROM "${collectionName}"`;
  const result = await db.prepare(query).all();
  return result.results;
}

export async function getRecordById(db: D1Database, collectionName: string, id: string): Promise<Record<string, any> | null> {
  const query = `SELECT * FROM "${collectionName}" WHERE id = ?1`;
  const result = await db.prepare(query).bind(id).first();
  return result || null;
}

export async function sanitizeRecords(records: Record<string, any>[], hiddenFields: string[]): Promise<Record<string, any>[]> {
  return records.map(record => {
    const sanitizedRecord: Record<string, any> = {};
    for (const key in record) {
      if (!hiddenFields.includes(key)) {
        sanitizedRecord[key] = record[key];
      }
    }
    return sanitizedRecord;
  });
}
