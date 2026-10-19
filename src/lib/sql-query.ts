import { AppError, ResponseCode } from "./response";
import { quoteIdent } from "./collection-name";
import { SQL_NOW } from "./collection";
import { getNonHiddenCollectionField, type Collection } from "../services/collection.service";

// A parameterized boolean fragment: `sql` uses bare `?` placeholders and
// `values` binds them in textual order. Both compiled rule predicates and the
// simple user filters share this shape (API_RULES.md §6.2).
export interface SqlFilter {
  sql: string;
  values: unknown[];
}

export interface SortSpec {
  column: string;
  direction: "ASC" | "DESC";
}

// id/createdAt/updatedAt are implicit on every collection table
const IMPLICIT_COLUMNS = ["id", "createdAt", "updatedAt"] as const;

function knownColumnNames(collection: Collection): Set<string> {
  const names = new Set<string>(IMPLICIT_COLUMNS);
  for (const field of collection.fields) names.add(field.name);
  return names;
}

function assertKnownColumn(collection: Collection, column: string): void {
  if (!knownColumnNames(collection).has(column)) {
    throw new AppError(
      `Unknown field "${column}"`,
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
}

// column names for an insert must be actual collection fields; the request
// body is untrusted so its keys are never allowed straight into SQL. `id` is
// special: the records service generates it, it is not part of field metadata.
function assertRecordFields(
  collection: Collection,
  data: Record<string, any>,
): string[] {
  const known = new Set(collection.fields.map((f) => f.name));
  known.add("id");
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

function whereClause(clauses: SqlFilter[]): {
  where: string;
  values: unknown[];
} {
  if (clauses.length === 0) return { where: "", values: [] };
  const values: unknown[] = [];
  for (const clause of clauses) values.push(...clause.values);
  return {
    where: ` WHERE ${clauses.map((clause) => `(${clause.sql})`).join(" AND ")}`,
    values,
  };
}

// non-hidden projection; the implicit id/createdAt/updatedAt columns are
// always part of a record (rules treat them as always allowed)
function visibleColumns(collection: Collection): string {
  const names = new Set<string>(IMPLICIT_COLUMNS);
  for (const field of getNonHiddenCollectionField(collection)) {
    names.add(field.name);
  }
  return [...names].map(quoteIdent).join(", ");
}

export interface GetRecordQueryOptions {
  // false (default): project only non-hidden fields
  // true: SELECT * — full row incl. hidden fields; callers must sanitize
  //       sensitive fields themselves before exposing the row
  includeHiddenFields?: boolean;
  // optional rule predicate (`id = ?` is always combined with AND)
  filter?: SqlFilter | null;
}

export function buildGetRecordQuery(
  collection: Collection,
  recordId: string,
  options: GetRecordQueryOptions = {},
): { query: string; values: unknown[] } {
  const columns = options.includeHiddenFields ? "*" : visibleColumns(collection);
  const clauses: SqlFilter[] = [{ sql: "id = ?", values: [recordId] }];
  if (options.filter) clauses.push(options.filter);
  const { where, values } = whereClause(clauses);
  return {
    query: `SELECT ${columns} FROM ${quoteIdent(collection.name)}${where}`,
    values,
  };
}

export function buildCreateRecordQuery(
  collection: Collection,
  data: Record<string, any>,
  filter?: SqlFilter | null,
): { query: string; values: unknown[] } {
  const fieldNames = assertRecordFields(collection, data);
  if (fieldNames.length === 0) {
    // defensive: the records service always supplies a generated id
    throw new AppError(
      "Cannot insert a record without fields",
      500,
      ResponseCode.INTERNAL_SERVER_ERROR,
    );
  }
  const table = quoteIdent(collection.name);
  const columns = fieldNames.map(quoteIdent).join(", ");
  const placeholders = fieldNames.map(() => "?").join(", ");
  const values = fieldNames.map((name) => data[name]);

  if (filter) {
    // the create rule is merged into the insert itself: check and write are
    // atomic, so a rule that fails inserts nothing (API_RULES.md §6.2)
    return {
      query: `INSERT INTO ${table} (${columns}) SELECT ${placeholders} WHERE (${filter.sql}) RETURNING *`,
      values: [...values, ...filter.values],
    };
  }
  return {
    query: `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`,
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
  const fieldNames = assertRecordFields(collection, data);
  const table = quoteIdent(collection.name);
  const columns = fieldNames.map(quoteIdent).join(", ");
  const placeholders = fieldNames.map(() => "?").join(", ");
  const values = fieldNames.map((name) => data[name]);
  return {
    query: `
      INSERT INTO ${table} (${columns})
      SELECT ${placeholders}
      WHERE NOT EXISTS (SELECT 1 FROM ${table})
      RETURNING *
    `,
    values,
  };
}

export interface ListRecordsOptions {
  filter?: SqlFilter | null;
  conditions?: SqlFilter[];
  sort?: SortSpec[];
  page: number;
  perPage: number;
}

export interface ListRecordsQuery {
  query: string;
  countQuery: string;
  /** binds for both queries; the rows query appends perPage/offset */
  filterValues: unknown[];
  offset: number;
}

const DEFAULT_SORT: SortSpec[] = [
  { column: "createdAt", direction: "DESC" },
  { column: "id", direction: "ASC" },
];

export function buildListRecordsQuery(
  collection: Collection,
  options: ListRecordsOptions,
): ListRecordsQuery {
  const clauses: SqlFilter[] = [];
  if (options.filter) clauses.push(options.filter);
  for (const condition of options.conditions ?? []) clauses.push(condition);
  const { where, values } = whereClause(clauses);

  const sort = options.sort && options.sort.length > 0 ? options.sort : DEFAULT_SORT;
  const orderBy = sort
    .map((spec) => {
      assertKnownColumn(collection, spec.column);
      return `${quoteIdent(spec.column)} ${spec.direction}`;
    })
    .join(", ");

  const table = quoteIdent(collection.name);
  return {
    query: `SELECT ${visibleColumns(collection)} FROM ${table}${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    // the count repeats the same WHERE so totalItems only ever reflects rows
    // the rule already allows
    countQuery: `SELECT COUNT(*) AS count FROM ${table}${where}`,
    filterValues: values,
    offset: (options.page - 1) * options.perPage,
  };
}

export function buildUpdateRecordQuery(
  collection: Collection,
  recordId: string,
  data: Record<string, any>,
  filter?: SqlFilter | null,
): { query: string; values: unknown[] } {
  const fieldNames = assertRecordFields(collection, data);
  if (fieldNames.length === 0) {
    throw new AppError(
      "No fields to update",
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }

  const assignments = fieldNames.map((name) => `${quoteIdent(name)} = ?`);
  assignments.push(`"updatedAt" = ${SQL_NOW}`);
  const values = fieldNames.map((name) => data[name]);
  values.push(recordId);

  let where = "id = ?";
  if (filter) {
    where += ` AND (${filter.sql})`;
    values.push(...filter.values);
  }
  return {
    query: `UPDATE ${quoteIdent(collection.name)} SET ${assignments.join(", ")} WHERE ${where} RETURNING *`,
    values,
  };
}

export function buildDeleteRecordQuery(
  collection: Collection,
  recordId: string,
  filter?: SqlFilter | null,
): { query: string; values: unknown[] } {
  const values: unknown[] = [recordId];
  let where = "id = ?";
  if (filter) {
    where += ` AND (${filter.sql})`;
    values.push(...filter.values);
  }
  return {
    query: `DELETE FROM ${quoteIdent(collection.name)} WHERE ${where} RETURNING *`,
    values,
  };
}
