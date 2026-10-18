import { compileRuleSet, formatRuleErrors } from "../api-rules";
import type { CompiledRuleSet, RuleField } from "../api-rules";
import { assertValidCollectionName, quoteIdent } from "../lib/collection-name";
import { AppError, ResponseCode } from "../lib/response"; import { mapD1Error } from "../lib/d1-error";
import { AUTH_REQUIRED_FIELDS } from "../lib/auth";
import {
  assertIndexColumnsExist,
  buildColumnDef,
  buildCreateIndexStatement,
  type CollectionFieldInput,
  type CollectionIndexInput,
  type CreateCollectionInput,
  type UpdateCollectionInput,
} from "../lib/collection";

export interface Field {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  hidden?: boolean;
  min?: number;
  max?: number;
  values?: string[];
  collectionId?: string;
  [key: string]: any;
}

export interface CollectionIndex {
  name: string;
  on: string | string[];
  unique?: boolean;
  [key: string]: any;
}

export interface Collection {
  id: string;
  name: string;
  system: boolean;
  type: 'auth' | 'base' | 'view';
  fields: Field[];
  indexes: CollectionIndex[];
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
  options: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const COLLECTION_SELECT = `id, name, system, type, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options, createdAt, updatedAt`;

function parseJsonField<T>(value: unknown, fallback: T, field: string): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new AppError(
      `Corrupt collection metadata (${field})`,
      500,
      ResponseCode.DATABASE_ERROR,
    );
  }
}

export function parseCollectionRow(row: Record<string, any>): Collection {
  return {
    ...row,
    system: Boolean(row.system),
    fields: parseJsonField<Field[]>(row.fields, [], "fields"),
    indexes: parseJsonField<CollectionIndex[]>(row.indexes, [], "indexes"),
    options: parseJsonField<Record<string, any>>(row.options, {}, "options"),
  } as Collection;
}

function generateCollectionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function firstRow(
  db: D1Database,
  query: string,
  ...params: unknown[]
): Promise<Record<string, any> | null> {
  try {
    return await db
      .prepare(query)
      .bind(...params)
      .first<Record<string, any>>();
  } catch (err) {
    mapD1Error(err);
  }
}

async function allRows(
  db: D1Database,
  query: string,
): Promise<Record<string, any>[]> {
  try {
    const result = await db.prepare(query).all<Record<string, any>>();
    return result.results ?? [];
  } catch (err) {
    mapD1Error(err);
  }
}

async function runBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  try {
    await db.batch(statements);
  } catch (err) {
    mapD1Error(err);
  }
}

export async function getCollectionById(db: D1Database, collectionId: string): Promise<Collection | null> {
  const query = `
    SELECT ${COLLECTION_SELECT} FROM _collections WHERE id = ?1
  `;
  const result = await firstRow(db, query, collectionId);
  if (!result) {
    return null;
  }
  return parseCollectionRow(result)
}

export async function getCollectionByName(db: D1Database, name: string): Promise<Collection | null> {
  assertValidCollectionName(name);
  const query = `
    SELECT ${COLLECTION_SELECT} FROM _collections WHERE name = ?1
  `;
  const result = await firstRow(db, query, name);
  if (!result) {
    return null;
  }
  return parseCollectionRow(result)
}

export async function getAuthCollectionById(db: D1Database, collectionId: string): Promise<Collection | null> {
  const query = `
    SELECT ${COLLECTION_SELECT} FROM _collections WHERE id = ?1 AND type = 'auth'
  `;
  const result = await firstRow(db, query, collectionId);
  if (!result) {
    return null;
  }
  return parseCollectionRow(result)
}

export async function getAuthCollectionByName(db: D1Database, name: string): Promise<Collection | null> {
  assertValidCollectionName(name);
  const query = `
    SELECT ${COLLECTION_SELECT} FROM _collections WHERE name = ?1 AND type = 'auth'
  `;
  const result = await firstRow(db, query, name);
  if (!result) {
    return null;
  }
  return parseCollectionRow(result)
}

export function getNonHiddenCollectionField(collection: Collection): Field[] {
  return collection.fields.filter((field) => !field.hidden);
}

export async function listCollections(db: D1Database): Promise<Collection[]> {
  const query = `
    SELECT ${COLLECTION_SELECT} FROM _collections ORDER BY createdAt ASC, name ASC
  `;
  const results = await allRows(db, query);
  return results.map(parseCollectionRow);
}

export async function getCollectionByIdOrName(
  db: D1Database,
  idOrName: string,
): Promise<Collection | null> {
  const byId = await getCollectionById(db, idOrName);
  if (byId) return byId;
  try {
    return await getCollectionByName(db, idOrName);
  } catch (err) {
    // only swallow "not a valid identifier"; real database errors must surface
    if (
      err instanceof AppError &&
      err.statusCode === 400 &&
      err.code === ResponseCode.INVALID_REQUEST
    ) {
      return null;
    }
    throw err;
  }
}

export interface CompiledCollection extends Collection {
  compiledRules: CompiledRuleSet;
}

/**
 * Internal getter for the records layer: same lookup semantics as
 * getCollectionByIdOrName (id wins over name) plus the parsed `compiledRules`
 * artifact. The public collection endpoints deliberately never select or
 * serialize it.
 */
export async function getCompiledCollectionByIdOrName(
  db: D1Database,
  idOrName: string,
): Promise<CompiledCollection | null> {
  const query = `
    SELECT ${COLLECTION_SELECT}, compiledRules FROM _collections
    WHERE id = ?1 OR name = ?2
    ORDER BY (id = ?1) DESC
    LIMIT 1
  `;
  const result = await firstRow(db, query, idOrName, idOrName);
  if (!result) return null;
  const { compiledRules, ...row } = result;
  return {
    ...parseCollectionRow(row),
    compiledRules: parseJsonField<CompiledRuleSet>(
      compiledRules,
      {},
      "compiledRules",
    ),
  };
}

function fieldNamesOf(fields: CollectionFieldInput[] | Field[]): Set<string> {
  return new Set(fields.map((f) => f.name));
}

interface RuleTexts {
  listRule?: string | null;
  viewRule?: string | null;
  createRule?: string | null;
  updateRule?: string | null;
  deleteRule?: string | null;
}

// Rules are compiled at save time against the effective field metadata, so an
// invalid rule (or a field change that breaks a stored rule) never persists.
function compileRulesOrThrow(rules: RuleTexts, fields: RuleField[]): CompiledRuleSet {
  const { compiled, errors } = compileRuleSet(rules, fields);
  if (errors.length > 0) {
    throw new AppError(
      formatRuleErrors(errors),
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  return compiled;
}

function assertValidIndexes(
  indexes: CollectionIndexInput[] | CollectionIndex[],
  fields: CollectionFieldInput[] | Field[],
): void {
  const names = fieldNamesOf(fields);
  for (const index of indexes) {
    try {
      assertIndexColumnsExist(index, names);
    } catch (err) {
      throw new AppError(
        err instanceof Error ? err.message : "Invalid index",
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    }
  }
}

export async function createCollection(
  db: D1Database,
  input: CreateCollectionInput,
): Promise<Collection> {
  assertValidCollectionName(input.name);
  const existing = await getCollectionByName(db, input.name);
  if (existing) {
    throw new AppError("Collection already exists", 409, ResponseCode.CONFLICT);
  }
  const indexes = input.indexes ?? [];
  const type = input.type ?? "base";
  assertValidIndexes(indexes, input.fields);

  const compiledRules = compileRulesOrThrow(
    {
      listRule: input.listRule,
      viewRule: input.viewRule,
      createRule: input.createRule,
      updateRule: input.updateRule,
      deleteRule: input.deleteRule,
    },
    input.fields,
  );

  const id = generateCollectionId();
  const fieldsJson = JSON.stringify(input.fields);
  const indexesJson = JSON.stringify(indexes);
  const optionsJson = JSON.stringify(input.options ?? {});

  const columnDefs = [
    `"id" TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(5))))`,
    ...input.fields.map((f) => buildColumnDef(f, false)),
    `"createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    `"updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  ];

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO _collections (id, name, system, type, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options, compiledRules)
         VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        id,
        input.name,
        type,
        fieldsJson,
        indexesJson,
        input.listRule ?? null,
        input.viewRule ?? null,
        input.createRule ?? null,
        input.updateRule ?? null,
        input.deleteRule ?? null,
        optionsJson,
        JSON.stringify(compiledRules),
      ),
    db.prepare(
      `CREATE TABLE ${quoteIdent(input.name)} (${columnDefs.join(", ")})`,
    ),
    ...indexes.map((index) =>
      db.prepare(buildCreateIndexStatement(input.name, index)),
    ),
  ];
  await runBatch(db, statements);

  const created = await getCollectionById(db, id);
  if (!created) {
    throw new AppError(
      "Failed to create collection",
      500,
      ResponseCode.INTERNAL_SERVER_ERROR,
    );
  }
  return created;
}

export async function updateCollectionById(
  db: D1Database,
  collectionId: string,
  input: UpdateCollectionInput,
): Promise<Collection> {
  const existing = await getCollectionByIdOrName(db, collectionId);
  if (!existing) {
    throw new AppError("Collection not found", 404, ResponseCode.NOT_FOUND);
  }
  if (Object.keys(input).length === 0) {
    throw new AppError("No fields to update", 400, ResponseCode.INVALID_REQUEST);
  }
  if (input.type !== undefined && input.type !== existing.type) {
    throw new AppError(
      "Changing collection type is not supported",
      400,
      ResponseCode.INVALID_REQUEST,
    );
  }

  const statements: D1PreparedStatement[] = [];
  let name = existing.name;

  if (input.name !== undefined && input.name !== existing.name) {
    if (existing.system) {
      throw new AppError(
        "System collections cannot be renamed",
        400,
        ResponseCode.INVALID_REQUEST,
      );
    }
    assertValidCollectionName(input.name);
    const duplicate = await getCollectionByName(db, input.name);
    if (duplicate && duplicate.id !== existing.id) {
      throw new AppError("Collection already exists", 409, ResponseCode.CONFLICT);
    }
    statements.push(
      db.prepare(
        `ALTER TABLE ${quoteIdent(existing.name)} RENAME TO ${quoteIdent(input.name)}`,
      ),
    );
    name = input.name;
  }

  let fields: Field[] = existing.fields;
  if (input.fields !== undefined) {
    if (existing.system) {
      throw new AppError(
        "System collection fields cannot be modified",
        400,
        ResponseCode.INVALID_REQUEST,
      );
    }
    const oldByName = new Map(existing.fields.map((f) => [f.name, f]));
    for (const field of input.fields) {
      const old = oldByName.get(field.name);
      if (old && old.type !== field.type) {
        throw new AppError(
          `Changing the type of field "${field.name}" is not supported`,
          400,
          ResponseCode.INVALID_REQUEST,
        );
      }
    }
    if (existing.type === "auth") {
      const names = fieldNamesOf(input.fields);
      for (const required of AUTH_REQUIRED_FIELDS) {
        if (!names.has(required)) {
          throw new AppError(
            `Auth collections require a "${required}" field`,
            400,
            ResponseCode.VALIDATION_ERROR,
          );
        }
      }
    }
    // Only additive schema changes are applied. Removed fields keep their
    // column in the table (data preserved); changed constraints other than
    // added UNIQUE indexes are metadata-only.
    for (const field of input.fields) {
      if (!oldByName.has(field.name)) {
        statements.push(
          db.prepare(
            `ALTER TABLE ${quoteIdent(name)} ADD COLUMN ${buildColumnDef(field, true)}`,
          ),
        );
        if (field.unique) {
          statements.push(
            db.prepare(
              `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(`idx_${name}_${field.name}`)} ON ${quoteIdent(name)} (${quoteIdent(field.name)})`,
            ),
          );
        }
      }
    }
    fields = input.fields as Field[];
  }

  // Any field change recompiles all five rules against the effective metadata,
  // and a patch may fix broken rules in the same write.
  const effectiveRules: RuleTexts = {
    listRule: input.listRule !== undefined ? input.listRule : existing.listRule,
    viewRule: input.viewRule !== undefined ? input.viewRule : existing.viewRule,
    createRule:
      input.createRule !== undefined ? input.createRule : existing.createRule,
    updateRule:
      input.updateRule !== undefined ? input.updateRule : existing.updateRule,
    deleteRule:
      input.deleteRule !== undefined ? input.deleteRule : existing.deleteRule,
  };
  const compiledRules = compileRulesOrThrow(effectiveRules, fields);

  const nextIndexes: Array<CollectionIndexInput | CollectionIndex> =
    input.indexes ?? existing.indexes;
  assertValidIndexes(nextIndexes, fields);
  const oldIndexNames = new Set(existing.indexes.map((i) => i.name));
  for (const index of nextIndexes) {
    if (!oldIndexNames.has(index.name)) {
      statements.push(db.prepare(buildCreateIndexStatement(name, index)));
    }
  }

  statements.push(
    db
      .prepare(
        `UPDATE _collections
         SET name = ?1, fields = ?2, indexes = ?3,
             listRule = ?4, viewRule = ?5, createRule = ?6, updateRule = ?7, deleteRule = ?8,
             options = ?9, compiledRules = ?10, updatedAt = CURRENT_TIMESTAMP
         WHERE id = ?11`,
      )
      .bind(
        name,
        JSON.stringify(fields),
        JSON.stringify(nextIndexes),
        effectiveRules.listRule,
        effectiveRules.viewRule,
        effectiveRules.createRule,
        effectiveRules.updateRule,
        effectiveRules.deleteRule,
        JSON.stringify(input.options !== undefined ? input.options : existing.options),
        JSON.stringify(compiledRules),
        existing.id,
      ),
  );
  await runBatch(db, statements);

  const updated = await getCollectionById(db, existing.id);
  if (!updated) {
    throw new AppError(
      "Failed to update collection",
      500,
      ResponseCode.INTERNAL_SERVER_ERROR,
    );
  }
  return updated;
}

export async function deleteCollectionById(
  db: D1Database,
  collectionId: string,
): Promise<Collection> {
  const existing = await getCollectionByIdOrName(db, collectionId);
  if (!existing) {
    throw new AppError("Collection not found", 404, ResponseCode.NOT_FOUND);
  }
  if (existing.system) {
    throw new AppError(
      "System collections cannot be deleted",
      400,
      ResponseCode.INVALID_REQUEST,
    );
  }
  await runBatch(db, [
    db.prepare(`DROP TABLE IF EXISTS ${quoteIdent(existing.name)}`),
    db.prepare(`DELETE FROM _sessions WHERE collectionId = ?1`).bind(existing.id),
    db.prepare(`DELETE FROM _collections WHERE id = ?1`).bind(existing.id),
  ]);
  return existing;
}
