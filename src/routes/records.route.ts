import { Context, Hono } from "hono";
import { HonoApp } from "../config";
import { AppError, error, ResponseCode, success } from "../lib/response";
import { readJsonBody } from "../lib/request";
import { formatZodIssues } from "../lib/collection";
import { quoteIdent } from "../lib/collection-name";
import { hashPassword } from "../lib/hash";
import {
  buildRecordCreateSchema,
  buildRecordUpdateSchema,
} from "../lib/record-schema";
import { assertRuleAllowsAction, buildRuleFilter } from "../lib/record-rules";
import {
  normalizeDateValue,
  normalizeWriteValues,
  presentRecord,
} from "../lib/record-values";
import type { SqlFilter, SortSpec } from "../lib/sql-query";
import * as collectionService from "../services/collection.service";
import * as recordService from "../services/records.service";
import type { CompiledCollection } from "../services/collection.service";

export const recordsRouter = new Hono<HonoApp>();

// Every record action resolves the collection through the internal getter so
// the raw rules and their compiled artifacts travel with the metadata
// (API_RULES.md §5.3); the public collection getters never load them.
recordsRouter.use("/*", async (c, next) => {
  const name = c.req.param("collectionName");
  if (!name) {
    return error(c, "Collection name is required", 400, ResponseCode.INVALID_REQUEST);
  }
  const collection = await collectionService.getCompiledCollectionByIdOrName(
    c.env.DB,
    name,
  );
  if (!collection) {
    // missing collection precedes all rule handling (API_RULES.md §2)
    return error(c, "Collection not found", 404, ResponseCode.NOT_FOUND);
  }
  c.set("compiledCollectionContext", collection);
  await next();
});

function recordCollection(c: Context<HonoApp>): CompiledCollection {
  const collection = c.get("compiledCollectionContext");
  if (!collection) {
    // set by the middleware above for every route in this router
    throw new AppError(
      "Collection context missing",
      500,
      ResponseCode.INTERNAL_SERVER_ERROR,
    );
  }
  return collection;
}

// view collections are read-only; their writes are rejected here, reads go
// through the normal rules path. The _collections metadata table can never be
// written through the records API because edits there would bypass rule
// compilation (metadata is managed via /api/collections only)
function assertWritable(collection: CompiledCollection): void {
  if (collection.type === "view") {
    throw new AppError(
      "View collections are read-only",
      400,
      ResponseCode.INVALID_REQUEST,
    );
  }
  if (collection.name === "_collections") {
    throw new AppError(
      "Collection metadata cannot be modified through the records API",
      400,
      ResponseCode.INVALID_REQUEST,
    );
  }
}

// ---------------------------------------------------------------------------
// list query parsing: page/perPage pagination, `sort=-field,field` and simple
// exact-match `field=value` filters (the full filter language is deferred,
// API_RULES.md §9)

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 500;
const RESERVED_LIST_PARAMS = new Set(["page", "perPage", "sort"]);

function parseIntParam(
  raw: string | undefined,
  name: string,
  fallback: number,
  max?: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  const valid =
    /^\d+$/.test(raw) &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    (max === undefined || value <= max);
  if (!valid) {
    const message =
      max !== undefined
        ? `"${name}" must be an integer between 1 and ${max}`
        : `"${name}" must be a positive integer`;
    throw new AppError(message, 400, ResponseCode.VALIDATION_ERROR);
  }
  return value;
}

interface RecordColumn {
  name: string;
  type: string;
}

// metadata fields plus the implicit id/createdAt/updatedAt columns; a view
// collection only has the columns its resolved metadata lists
function findRecordColumn(
  collection: CompiledCollection,
  name: string,
): RecordColumn | null {
  const field = collection.fields.find((f) => f.name === name);
  if (field) return { name: field.name, type: field.type };
  if (collection.type === "view") return null;
  if (name === "id") return { name: "id", type: "text" };
  if (name === "createdAt" || name === "updatedAt") {
    return { name, type: "date" };
  }
  return null;
}

function assertNotPassword(name: string): void {
  if (name.toLowerCase() === "password") {
    throw new AppError(
      `Field "${name}" cannot be used in queries`,
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
}

function coerceFilterValue(column: RecordColumn, raw: string): unknown {
  switch (column.type) {
    case "number": {
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value)) {
        throw new AppError(
          `Field "${column.name}" expects a number`,
          400,
          ResponseCode.VALIDATION_ERROR,
        );
      }
      return value;
    }
    case "bool":
      if (raw === "true" || raw === "1") return 1;
      if (raw === "false" || raw === "0") return 0;
      throw new AppError(
        `Field "${column.name}" expects true or false`,
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    case "date":
      // same normalization as writes, so `?publishAt=1990-01-01` matches the
      // stored `1990-01-01T00:00:00.000Z`
      return normalizeDateValue(column.name, raw);
    case "json":
    case "file":
      throw new AppError(
        `Field "${column.name}" cannot be filtered`,
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    default:
      return raw;
  }
}

function buildFieldCondition(
  collection: CompiledCollection,
  name: string,
  raw: string,
): SqlFilter {
  assertNotPassword(name);
  const column = findRecordColumn(collection, name);
  if (!column) {
    throw new AppError(
      `Unknown field "${name}"`,
      400,
      ResponseCode.VALIDATION_ERROR,
    );
  }
  return {
    sql: `${quoteIdent(column.name)} = ?`,
    values: [coerceFilterValue(column, raw)],
  };
}

function parseSort(
  raw: string | undefined,
  collection: CompiledCollection,
): SortSpec[] {
  if (raw === undefined || raw === "") return [];
  return raw.split(",").map((part) => {
    const item = part.trim();
    const desc = item.startsWith("-");
    const name = desc ? item.slice(1) : item;
    assertNotPassword(name);
    const column = name ? findRecordColumn(collection, name) : null;
    if (!column) {
      throw new AppError(
        `Unknown field "${name}" in sort`,
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    }
    return { column: column.name, direction: desc ? "DESC" : "ASC" };
  });
}

function parseListQuery(c: Context<HonoApp>, collection: CompiledCollection) {
  const page = parseIntParam(c.req.query("page"), "page", 1);
  const perPage = parseIntParam(
    c.req.query("perPage"),
    "perPage",
    DEFAULT_PER_PAGE,
    MAX_PER_PAGE,
  );
  const sort = parseSort(c.req.query("sort"), collection);
  const conditions: SqlFilter[] = [];
  for (const [name, value] of Object.entries(c.req.query())) {
    if (RESERVED_LIST_PARAMS.has(name)) continue;
    conditions.push(buildFieldCondition(collection, name, value));
  }
  return { page, perPage, sort, conditions };
}

// ---------------------------------------------------------------------------
// write data preparation: validate relations, hash auth passwords and
// normalize values to their stored form (dates/json/bools)

async function assertRelationsExist(
  db: D1Database,
  collection: CompiledCollection,
  data: Record<string, unknown>,
): Promise<void> {
  for (const field of collection.fields) {
    if (field.type !== "relation" || !(field.name in data)) continue;
    const value = data[field.name];
    if (value === null || value === undefined) continue;
    const target = await collectionService.getCollectionByIdOrName(
      db,
      String(field.collectionId ?? ""),
    );
    if (!target) {
      // a deleted target collection leaves dangling relation metadata; treat
      // it as a validation failure instead of a 500
      throw new AppError(
        `Field "${field.name}" references a collection that no longer exists`,
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    }
    const exists = await recordService.recordExists(db, target, String(value));
    if (!exists) {
      throw new AppError(
        `Field "${field.name}" references a record that does not exist`,
        400,
        ResponseCode.VALIDATION_ERROR,
      );
    }
  }
}

async function prepareWriteData(
  c: Context<HonoApp>,
  collection: CompiledCollection,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const normalized = normalizeWriteValues(collection.fields, data);
  await assertRelationsExist(c.env.DB, collection, normalized);
  if (collection.type === "auth" && typeof normalized.password === "string") {
    normalized.password = await hashPassword(normalized.password);
  }
  return normalized;
}

// create rules evaluate against the candidate row: payload overlaid on
// metadata defaults, absent → null (API_RULES.md §4.1)
function buildCandidateRecord(
  collection: CompiledCollection,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = {};
  for (const field of collection.fields) {
    candidate[field.name] =
      field.name in data ? data[field.name] : (field.default ?? null);
  }
  return candidate;
}

function requestNow(): string {
  // one timestamp per request: every @now in the request resolves identically
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------

recordsRouter.get("/", async (c) => {
  const collection = recordCollection(c);
  const ruleFilter = buildRuleFilter(collection, "list", c.get("auth"), {
    now: requestNow(),
  });
  const { page, perPage, sort, conditions } = parseListQuery(c, collection);
  const { items, totalItems } = await recordService.getRecords(c.env.DB, collection, {
    filter: ruleFilter,
    conditions,
    sort,
    page,
    perPage,
  });
  return success(
    c,
    "Records retrieved",
    {
      page,
      perPage,
      totalItems,
      totalPages: Math.ceil(totalItems / perPage),
      items: items.map((row) => presentRecord(row, collection)),
    },
    200,
    ResponseCode.SUCCESS,
  );
});

recordsRouter.get("/:id", async (c) => {
  const collection = recordCollection(c);
  const ruleFilter = buildRuleFilter(collection, "view", c.get("auth"), {
    now: requestNow(),
  });
  const row = await recordService.getRecordById(
    c.env.DB,
    collection,
    c.req.param("id"),
    { filter: ruleFilter },
  );
  // a rule-filtered row is indistinguishable from a missing one (no oracle)
  if (!row) {
    return error(c, "Record not found", 404, ResponseCode.NOT_FOUND);
  }
  return success(
    c,
    "Record retrieved",
    presentRecord(row, collection),
    200,
    ResponseCode.SUCCESS,
  );
});

recordsRouter.post("/", async (c) => {
  const collection = recordCollection(c);
  // locked rules reject before the body is even parsed (API_RULES.md §6.1)
  assertRuleAllowsAction(collection, "create", c.get("auth"));
  assertWritable(collection);

  const body = await readJsonBody(c);
  const parsed = buildRecordCreateSchema(collection.fields).safeParse(body);
  if (!parsed.success) {
    return error(c, formatZodIssues(parsed.error), 400, ResponseCode.VALIDATION_ERROR);
  }
  const data = await prepareWriteData(
    c,
    collection,
    parsed.data as Record<string, unknown>,
  );
  const ruleFilter = buildRuleFilter(collection, "create", c.get("auth"), {
    body: data,
    record: buildCandidateRecord(collection, data),
    now: requestNow(),
  });
  const created = await recordService.createRecord(
    c.env.DB,
    collection,
    data,
    ruleFilter,
  );
  if (!created) {
    // atomic INSERT ... SELECT: no row means the create rule filtered it;
    // deliberately generic so the rule itself is not disclosed
    return error(c, "Failed to create record", 400, ResponseCode.VALIDATION_ERROR);
  }
  return success(
    c,
    "Record created",
    presentRecord(created, collection),
    201,
    ResponseCode.CREATED,
  );
});

recordsRouter.patch("/:id", async (c) => {
  const collection = recordCollection(c);
  assertRuleAllowsAction(collection, "update", c.get("auth"));
  assertWritable(collection);

  const body = await readJsonBody(c);
  const parsed = buildRecordUpdateSchema(collection.fields).safeParse(body);
  if (!parsed.success) {
    return error(c, formatZodIssues(parsed.error), 400, ResponseCode.VALIDATION_ERROR);
  }
  const data = await prepareWriteData(
    c,
    collection,
    parsed.data as Record<string, unknown>,
  );
  const ruleFilter = buildRuleFilter(collection, "update", c.get("auth"), {
    body: data,
    now: requestNow(),
  });
  const updated = await recordService.updateRecordById(
    c.env.DB,
    collection,
    c.req.param("id"),
    data,
    ruleFilter,
  );
  if (!updated) {
    return error(c, "Record not found", 404, ResponseCode.NOT_FOUND);
  }
  return success(
    c,
    "Record updated",
    presentRecord(updated, collection),
    200,
    ResponseCode.SUCCESS,
  );
});

recordsRouter.delete("/:id", async (c) => {
  const collection = recordCollection(c);
  assertRuleAllowsAction(collection, "delete", c.get("auth"));
  assertWritable(collection);

  const ruleFilter = buildRuleFilter(collection, "delete", c.get("auth"), {
    now: requestNow(),
  });
  const deleted = await recordService.deleteRecordById(
    c.env.DB,
    collection,
    c.req.param("id"),
    ruleFilter,
  );
  if (!deleted) {
    return error(c, "Record not found", 404, ResponseCode.NOT_FOUND);
  }
  return success(
    c,
    "Record deleted",
    presentRecord(deleted, collection),
    200,
    ResponseCode.SUCCESS,
  );
});
