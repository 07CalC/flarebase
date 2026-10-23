import {
  compileRuleSet,
  formatRuleErrors,
  ruleDependencies,
} from "../api-rules";
import type {
  CompiledRuleSet,
  CompileRuleSetOptions,
  RuleCollectionRef,
  RuleField,
} from "../api-rules";
import {
  assertValidCollectionName,
  isValidCollectionName,
  quoteIdent,
} from "../lib/collection-name";
import { AppError, ResponseCode } from "../lib/response"; import { mapD1Error } from "../lib/d1-error";
import { AUTH_REQUIRED_FIELDS } from "../lib/auth";
import { validateViewQuery } from "../lib/view-query";
import {
  assertIndexColumnsExist,
  buildColumnDef,
  buildCreateIndexStatement,
  SQL_NOW,
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

// ---------------------------------------------------------------------------
// rule compilation context: relation traversal and @collection.* need
// metadata for other collections. Everything is preloaded into an in-memory
// resolver so the compiler stays pure and synchronous.

interface RuleCollectionOverride {
  id: string;
  name: string;
  fields: RuleField[];
  /** views only address id/createdAt/updatedAt when the query selects them */
  implicitFields: boolean;
}

/** Internal list that also carries parsed compiledRules (dependency scans). */
async function listCompiledCollections(
  db: D1Database,
): Promise<CompiledCollection[]> {
  const results = await allRows(
    db,
    `SELECT ${COLLECTION_SELECT}, compiledRules FROM _collections ORDER BY createdAt ASC, name ASC`,
  );
  return results.map((row) => {
    const { compiledRules, ...rest } = row;
    return {
      ...parseCollectionRow(rest),
      compiledRules: parseJsonField<CompiledRuleSet>(
        compiledRules,
        {},
        "compiledRules",
      ),
    };
  });
}

/**
 * In-memory id/name resolver over preloaded metadata. `override` replaces the
 * collection being written with its pending name/fields; the previous name
 * stops resolving, so a rename breaks name-based `@collection.*` references
 * with a compile error (surfaced as 400) instead of going stale.
 */
function makeRuleResolver(
  collections: CompiledCollection[],
  override?: RuleCollectionOverride,
): (idOrName: string) => RuleCollectionRef | null {
  const refs = new Map<string, RuleCollectionRef>();
  const register = (source: {
    id: string;
    name: string;
    fields: RuleField[];
    implicitFields?: boolean;
  }): void => {
    const ref: RuleCollectionRef = {
      id: source.id,
      name: source.name,
      fields: source.fields,
      implicitFields: source.implicitFields,
    };
    refs.set(ref.id, ref);
    refs.set(ref.name, ref);
  };

  let replaced = false;
  for (const collection of collections) {
    if (override && collection.id === override.id) {
      replaced = true;
      register(override);
      continue;
    }
    register({
      id: collection.id,
      name: collection.name,
      fields: collection.fields,
      implicitFields: collection.type !== "view",
    });
  }
  if (override && !replaced) register(override);

  return (idOrName) => refs.get(idOrName) ?? null;
}

function ruleTextsOf(collection: Collection): RuleTexts {
  return {
    listRule: collection.listRule,
    viewRule: collection.viewRule,
    createRule: collection.createRule,
    updateRule: collection.updateRule,
    deleteRule: collection.deleteRule,
  };
}

/**
 * Cross-collection invalidation: every collection whose compiled artifacts
 * reference the changed collection is recompiled against the pending metadata.
 * A dependent that no longer compiles rejects the change (400) before anything
 * is written. Returns the compiledRules updates to append to the write batch.
 */
function prepareDependentStatements(
  db: D1Database,
  collections: CompiledCollection[],
  override: RuleCollectionOverride,
): D1PreparedStatement[] {
  const dependents = collections.filter(
    (collection) =>
      collection.id !== override.id &&
      ruleDependencies(collection.compiledRules).includes(override.id),
  );
  if (dependents.length === 0) return [];

  const resolveCollection = makeRuleResolver(collections, override);
  const statements: D1PreparedStatement[] = [];
  for (const dependent of dependents) {
    const { compiled, errors } = compileRuleSet(
      ruleTextsOf(dependent),
      dependent.fields,
      {
        implicitFields: dependent.type !== "view",
        sourceCollectionName: dependent.name,
        resolveCollection,
      },
    );
    if (errors.length > 0) {
      throw new AppError(
        `Cannot update collection "${override.name}": rules of collection "${dependent.name}" no longer compile: ${formatRuleErrors(errors)}`,
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    }
    statements.push(
      db
        .prepare(
          `UPDATE _collections SET compiledRules = ?1, updatedAt = ${SQL_NOW} WHERE id = ?2`,
        )
        .bind(JSON.stringify(compiled), dependent.id),
    );
  }
  return statements;
}

/** Refuses to delete a collection other collections' rules still reference. */
async function assertCollectionNotReferenced(
  db: D1Database,
  existing: Collection,
): Promise<void> {
  const collections = await listCompiledCollections(db);
  const dependents = collections.filter(
    (collection) =>
      collection.id !== existing.id &&
      ruleDependencies(collection.compiledRules).includes(existing.id),
  );
  if (dependents.length === 0) return;
  const names = dependents
    .map((collection) => `"${collection.name}"`)
    .join(", ");
  throw new AppError(
    `Cannot delete collection "${existing.name}": rules of ${names} reference it`,
    400,
    ResponseCode.VALIDATION_ERROR,
  );
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
function compileRulesOrThrow(
  rules: RuleTexts,
  fields: RuleField[],
  options: CompileRuleSetOptions = {},
): CompiledRuleSet {
  const { compiled, errors } = compileRuleSet(rules, fields, options);
  if (errors.length > 0) {
    throw new AppError(
      formatRuleErrors(errors),
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  return compiled;
}

function effectiveRuleTexts(
  existing: Collection,
  input: UpdateCollectionInput,
): RuleTexts {
  return {
    listRule: input.listRule !== undefined ? input.listRule : existing.listRule,
    viewRule: input.viewRule !== undefined ? input.viewRule : existing.viewRule,
    createRule:
      input.createRule !== undefined ? input.createRule : existing.createRule,
    updateRule:
      input.updateRule !== undefined ? input.updateRule : existing.updateRule,
    deleteRule:
      input.deleteRule !== undefined ? input.deleteRule : existing.deleteRule,
  };
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
  const fields = input.fields ?? [];

  if (type === "view") {
    return createViewCollection(db, input, indexes);
  }
  if (fields.length === 0) {
    throw new AppError("fields is required", 400, ResponseCode.VALIDATION_ERROR);
  }
  assertValidIndexes(indexes, fields);

  const id = generateCollectionId();
  const resolveCollection = makeRuleResolver(
    await listCompiledCollections(db),
    { id, name: input.name, fields, implicitFields: true },
  );
  const compiledRules = compileRulesOrThrow(
    {
      listRule: input.listRule,
      viewRule: input.viewRule,
      createRule: input.createRule,
      updateRule: input.updateRule,
      deleteRule: input.deleteRule,
    },
    fields,
    { sourceCollectionName: input.name, resolveCollection },
  );

  const fieldsJson = JSON.stringify(fields);
  const indexesJson = JSON.stringify(indexes);
  const optionsJson = JSON.stringify(input.options ?? {});

  const columnDefs = [
    `"id" TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(5))))`,
    ...fields.map((f) => buildColumnDef(f, false)),
    `"createdAt" TIMESTAMP NOT NULL DEFAULT ${SQL_NOW}`,
    `"updatedAt" TIMESTAMP NOT NULL DEFAULT ${SQL_NOW}`,
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

// ---------------------------------------------------------------------------
// view collections: a stored SELECT statement backing a virtual collection.
// Fields are never client-supplied; they are resolved from the real query
// result (PRAGMA table_info) right after the view is created.

function viewQueryError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err);
  return new AppError(
    `Invalid view query: ${message}`,
    400,
    ResponseCode.VALIDATION_ERROR,
  );
}

async function dropViewIfExists(db: D1Database, name: string): Promise<void> {
  try {
    await db.prepare(`DROP VIEW IF EXISTS ${quoteIdent(name)}`).run();
  } catch {
    // best-effort cleanup: the original failure is what surfaces
  }
}

// Restores the pre-update view after a failed rebuild (does nothing when the
// stored query itself is missing/corrupt). Best effort: the metadata row is
// still authoritative and a later successful update recreates the view.
async function restoreView(
  db: D1Database,
  existing: Collection,
  currentName: string,
): Promise<void> {
  const oldQuery = existing.options?.query;
  if (typeof oldQuery !== "string" || oldQuery.trim() === "") return;
  await dropViewIfExists(db, currentName);
  try {
    await db
      .prepare(`CREATE VIEW ${quoteIdent(existing.name)} AS ${oldQuery}`)
      .run();
  } catch {
    // ignored, see above
  }
}

function inferredFieldType(declaredType: string): string {
  const type = declaredType.toUpperCase();
  if (type.includes("BOOL")) return "bool";
  if (/INT|REAL|FLOA|DOUB|DEC|NUM/.test(type)) return "number";
  return "text";
}

// View fields are exactly the columns the query selects; `id` is required so
// records stay addressable (GET /:id, sort tiebreak, relation checks).
async function resolveViewFields(
  db: D1Database,
  name: string,
): Promise<Field[]> {
  const { results } = await db
    .prepare(`PRAGMA table_info(${quoteIdent(name)})`)
    .all<{ name: string; type: string | null }>();
  const columns = results ?? [];
  if (!columns.some((column) => column.name === "id")) {
    throw new AppError(
      'View queries must expose an "id" column',
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  const seen = new Set<string>();
  return columns.map((column) => {
    if (!isValidCollectionName(column.name)) {
      throw new AppError(
        `View column "${column.name}" is not a valid field name; alias it to a valid identifier`,
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    }
    if (seen.has(column.name)) {
      throw new AppError(
        `View query produces duplicate column "${column.name}"`,
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    }
    seen.add(column.name);
    return { name: column.name, type: inferredFieldType(column.type ?? "") };
  });
}

async function createViewCollection(
  db: D1Database,
  input: CreateCollectionInput,
  indexes: CollectionIndexInput[],
): Promise<Collection> {
  if (input.fields !== undefined && input.fields.length > 0) {
    throw new AppError(
      "View collection fields are derived from options.query; omit fields",
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  if (indexes.length > 0) {
    throw new AppError(
      "View collections do not support indexes",
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  // the view must exist before its columns can be resolved from the query
  const query = validateViewQuery(input.options?.query);
  try {
    await db.prepare(`CREATE VIEW ${quoteIdent(input.name)} AS ${query}`).run();
  } catch (err) {
    throw viewQueryError(err);
  }

  let fields: Field[];
  let compiledRules: CompiledRuleSet;
  const id = generateCollectionId();
  try {
    fields = await resolveViewFields(db, input.name);
    const resolveCollection = makeRuleResolver(
      await listCompiledCollections(db),
      { id, name: input.name, fields, implicitFields: false },
    );
    compiledRules = compileRulesOrThrow(
      {
        listRule: input.listRule,
        viewRule: input.viewRule,
        createRule: input.createRule,
        updateRule: input.updateRule,
        deleteRule: input.deleteRule,
      },
      fields,
      {
        implicitFields: false,
        sourceCollectionName: input.name,
        resolveCollection,
      },
    );
  } catch (err) {
    await dropViewIfExists(db, input.name);
    throw err instanceof AppError ? err : viewQueryError(err);
  }

  try {
    await runBatch(db, [
      db
        .prepare(
          `INSERT INTO _collections (id, name, system, type, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options, compiledRules)
           VALUES (?1, ?2, 0, 'view', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
        .bind(
          id,
          input.name,
          JSON.stringify(fields),
          JSON.stringify(indexes),
          input.listRule ?? null,
          input.viewRule ?? null,
          input.createRule ?? null,
          input.updateRule ?? null,
          input.deleteRule ?? null,
          JSON.stringify(input.options ?? {}),
          JSON.stringify(compiledRules),
        ),
    ]);
  } catch (err) {
    await dropViewIfExists(db, input.name);
    throw err;
  }

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

async function updateViewCollectionById(
  db: D1Database,
  existing: Collection,
  input: UpdateCollectionInput,
): Promise<Collection> {
  if (input.fields !== undefined) {
    throw new AppError(
      "View collection fields are derived from options.query and cannot be modified",
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  const nextIndexes = input.indexes ?? existing.indexes;
  if (nextIndexes.length > 0) {
    throw new AppError(
      "View collections do not support indexes",
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }

  let name = existing.name;
  if (input.name !== undefined && input.name !== existing.name) {
    assertValidCollectionName(input.name);
    const duplicate = await getCollectionByName(db, input.name);
    if (duplicate && duplicate.id !== existing.id) {
      throw new AppError("Collection already exists", 409, ResponseCode.CONFLICT);
    }
    name = input.name;
  }
  const nameChanged = name !== existing.name;

  const options = input.options !== undefined ? input.options : existing.options;
  const queryChanged =
    input.options !== undefined && options?.query !== existing.options?.query;

  // Rebuild only when the query or the name changes; rule-only patches leave
  // the SQLite view untouched.
  let fields = existing.fields;
  let rebuilt = false;
  if (nameChanged || queryChanged) {
    const query = validateViewQuery(options?.query);
    try {
      await db
        .prepare(`DROP VIEW IF EXISTS ${quoteIdent(existing.name)}`)
        .run();
      await db.prepare(`CREATE VIEW ${quoteIdent(name)} AS ${query}`).run();
      rebuilt = true;
      fields = await resolveViewFields(db, name);
    } catch (err) {
      await restoreView(db, existing, name);
      throw err instanceof AppError ? err : viewQueryError(err);
    }
  }

  const effectiveRules = effectiveRuleTexts(existing, input);
  const collections = await listCompiledCollections(db);
  const override: RuleCollectionOverride = {
    id: existing.id,
    name,
    fields,
    implicitFields: false,
  };
  const resolveCollection = makeRuleResolver(collections, override);
  let compiledRules: CompiledRuleSet;
  let dependentStatements: D1PreparedStatement[] = [];
  try {
    compiledRules = compileRulesOrThrow(effectiveRules, fields, {
      implicitFields: false,
      sourceCollectionName: name,
      resolveCollection,
    });
    if (nameChanged || queryChanged) {
      dependentStatements = prepareDependentStatements(db, collections, override);
    }
  } catch (err) {
    if (rebuilt) await restoreView(db, existing, name);
    throw err;
  }

  try {
    await runBatch(db, [
      db
        .prepare(
          `UPDATE _collections
           SET name = ?1, fields = ?2, indexes = ?3,
               listRule = ?4, viewRule = ?5, createRule = ?6, updateRule = ?7, deleteRule = ?8,
               options = ?9, compiledRules = ?10, updatedAt = ${SQL_NOW}
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
          JSON.stringify(options ?? {}),
          JSON.stringify(compiledRules),
          existing.id,
        ),
      ...dependentStatements,
    ]);
  } catch (err) {
    if (rebuilt) await restoreView(db, existing, name);
    throw err;
  }

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

  if (existing.type === "view") {
    return updateViewCollectionById(db, existing, input);
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
  const nameChanged = name !== existing.name;
  const fieldsChanged = input.fields !== undefined;
  const effectiveRules = effectiveRuleTexts(existing, input);
  const collections = await listCompiledCollections(db);
  const override: RuleCollectionOverride = {
    id: existing.id,
    name,
    fields,
    implicitFields: true,
  };
  const compiledRules = compileRulesOrThrow(effectiveRules, fields, {
    sourceCollectionName: name,
    resolveCollection: makeRuleResolver(collections, override),
  });

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
             options = ?9, compiledRules = ?10, updatedAt = ${SQL_NOW}
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

  // dependent artifacts embed the old table name / target fields, so recompile
  // them against the pending metadata in the same batch
  if (nameChanged || fieldsChanged) {
    statements.push(
      ...prepareDependentStatements(db, collections, override),
    );
  }

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
  await assertCollectionNotReferenced(db, existing);
  const dropStatement =
    existing.type === "view"
      ? `DROP VIEW IF EXISTS ${quoteIdent(existing.name)}`
      : `DROP TABLE IF EXISTS ${quoteIdent(existing.name)}`;
  await runBatch(db, [
    db.prepare(dropStatement),
    db.prepare(`DELETE FROM _sessions WHERE collectionId = ?1`).bind(existing.id),
    db.prepare(`DELETE FROM _collections WHERE id = ?1`).bind(existing.id),
  ]);
  return existing;
}
