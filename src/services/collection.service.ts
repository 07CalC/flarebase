import { assertValidCollectionName } from "../lib/collection-name";

export interface Field {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  [key: string]: any;
}

export interface Collection {
  id: string;
  name: string;
  system: boolean;
  type: 'auth' | 'base' | 'view';
  fields: Field[];
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

const COLLECTION_SELECT = `id, name, system, type, fields, listRule, viewRule, createRule, updateRule, deleteRule, options, createdAt, updatedAt`;

export async function getCollectionById(db: D1Database, collectionId: string): Promise<Collection | null> {
  const query = `
    SELECT ${COLLECTION_SELECT} FROM _collections WHERE id = ?1
  `;
  const result = await db.prepare(query).bind(collectionId).first<Collection>();
  if (!result) {
    return null;
  }
  return result
}

export async function getCollectionByName(db: D1Database, name: string): Promise<Collection | null> {
  assertValidCollectionName(name);
  const query = `
    SELECT ${COLLECTION_SELECT} FROM _collections WHERE name = ?1
  `;
  const result = await db.prepare(query).bind(name).first<Collection>();
  if (!result) {
    return null;
  }
  return result
}

export async function getAuthCollectionById(db: D1Database, collectionId: string): Promise<Collection | null> {
  const query = `
    SELECT ${COLLECTION_SELECT} FROM _collections WHERE id = ?1 AND type = 'auth'
  `;
  const result = await db.prepare(query).bind(collectionId).first<Collection>();
  if (!result) {
    return null;
  }
  return result
}

export async function getAuthCollectionByName(db: D1Database, name: string): Promise<Collection | null> {
  assertValidCollectionName(name);
  const query = `
    SELECT ${COLLECTION_SELECT} FROM _collections WHERE name = ?1 AND type = 'auth'
  `;
  const result = await db.prepare(query).bind(name).first<Collection>();
  if (!result) {
    return null;
  }
  return result
}

export function getNonHiddenCollectionField(collection: Collection): Field[] {
  return collection.fields.filter((field) => !field.hidden);
}
