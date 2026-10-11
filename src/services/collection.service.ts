
export interface Collection {
  id: string;
  name: string;
  system: boolean;
  type: 'auth' | 'base' | 'view';
  fields: Record<string, any>[];
  indexes: Record<string, any>[];
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
  options: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}


export async function getCollectionById(db: D1Database, collectionId: string): Promise<Collection | null> {
  const query = `
    SELECT id, name, type FROM _collections WHERE id = ?1
  `;
  const result = await db.prepare(query).bind(collectionId).first<Collection>();
  if (!result) {
    return null;
  }
  return result
}

export async function getAuthCollectionById(db: D1Database, collectionId: string): Promise<Collection | null> {
  const query = `
    SELECT id, name, type FROM _collections WHERE id = ?1 AND type = 'auth'
  `;
  const result = await db.prepare(query).bind(collectionId).first<Collection>();
  if (!result) {
    return null;
  }
  return result
}
