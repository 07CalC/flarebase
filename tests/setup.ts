import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { generateJWT } from "../src/lib/jwt";
import { createSession } from "../src/services/session.service";
import { createCollection } from "../src/services/collection.service";
// the real entrypoint, so tests exercise the same middleware wiring as prod
// (global authMiddleware etc.) through the real worker.fetch contract
import app from "../src/index";
import { hashPassword } from "../src/lib/hash";
import { TEST_SECRET } from "./test-env";

export { TEST_SECRET };

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
export const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// seeded account passwords are stored as real PBKDF2 hashes (the literal
// "hashed-password" is the plaintext to use in login flows); computed lazily
// once per worker because PBKDF2 is deliberately slow
let testPasswordHash: Promise<string> | undefined;
function hashedTestPassword(): Promise<string> {
  testPasswordHash ??= hashPassword("hashed-password");
  return testPasswordHash;
}

// Tables that must survive the per-test reset: the migrated schema
// (_collections, _superusers, _sessions, _files, _migrations) plus migration
// bookkeeping tables (applyD1Migrations uses `migrations` per vitest.config
// / wrangler.jsonc; `d1_migrations` is its default name).
const PROTECTED_TABLES = new Set([
  "_collections",
  "_superusers",
  "_sessions",
  "_files",
  "_migrations",
  "migrations",
  "d1_migrations",
  "sqlite_sequence",
]);

// Test files share one isolated storage environment (storage isolation is per
// test file in the Workers Vitest integration), so every test starts from the
// same migrated + seeded baseline: drop whatever the previous tests left
// behind, clear system rows, and restore seed metadata.
async function resetDatabase(db: D1Database): Promise<void> {
  // user tables and views are dropped; a view must be dropped with DROP VIEW
  const { results } = await db
    .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view')`)
    .all<{ name: string; type: string }>();
  for (const { name, type } of results) {
    if (PROTECTED_TABLES.has(name)) continue;
    // D1-internal tables (_cf_*) and sqlite internals cannot be dropped (the
    // authorizer rejects it with SQLITE_AUTH) and must not be
    if (name.startsWith("_cf_") || name.startsWith("sqlite_")) continue;
    // names come from sqlite_master itself, never from request input
    const dropType = type === "view" ? "VIEW" : "TABLE";
    await db.prepare(`DROP ${dropType} IF EXISTS "${name}"`).run();
  }

  await db.prepare(`DELETE FROM _collections WHERE system = 0`).run();
  await db.prepare(`DELETE FROM _sessions`).run();
  await db.prepare(`DELETE FROM _superusers`).run();
  await db.prepare(`DELETE FROM _files`).run();
  // restore the seed state of system collections in case a test patched them
  await db
    .prepare(
      `UPDATE _collections
       SET listRule = NULL, viewRule = NULL, createRule = NULL,
           updateRule = NULL, deleteRule = NULL, compiledRules = '{}'
       WHERE system = 1`,
    )
    .run();
}

export interface TestContext {
  db: D1Database;
  superToken: string;
  userToken: string;
  usersId: string;
}

export async function setupTest(): Promise<TestContext> {
  const db = env.DB;
  await resetDatabase(db);

  const passwordHash = await hashedTestPassword();

  await db
    .prepare(
      `INSERT INTO _superusers (id, email, password) VALUES (?1, ?2, ?3)`,
    )
    .bind("su1", "admin@example.com", passwordHash)
    .run();

  const su = await generateJWT(
    { sub: "su1", collectionId: "_superusers" },
    TEST_SECRET,
  );
  await createSession(db, {
    collectionId: "_superusers",
    userId: "su1",
    jti: su.jti,
    expiresAt: su.exp,
  });

  const users = await createCollection(db, {
    name: "users",
    type: "auth",
    fields: [
      { name: "email", type: "email", required: true, unique: true },
      { name: "password", type: "text", required: true },
    ],
  });

  await db
    .prepare(`INSERT INTO "users" (id, email, password) VALUES (?1, ?2, ?3)`)
    .bind("u1", "user@example.com", passwordHash)
    .run();

  const u = await generateJWT({ sub: "u1", collectionId: users.id }, TEST_SECRET);
  await createSession(db, {
    collectionId: users.id,
    userId: "u1",
    jti: u.jti,
    expiresAt: u.exp,
  });

  return {
    db,
    superToken: su.token,
    userToken: u.token,
    usersId: users.id,
  };
}

export interface ApiOptions {
  token?: string | null;
  body?: unknown;
  rawBody?: string;
}

export interface ApiResult {
  status: number;
  body: any;
}

// Calls the worker exactly like the runtime does: worker.fetch(request, env,
// executionCtx). The ExecutionContext is a real one, so c.executionCtx
// .waitUntil() works as in production; waitOnExecutionContext() then drains
// the background work (opportunistic session sweeps) so assertions after the
// response observe a settled state.
export async function apiWithEnv(
  requestEnv: CloudflareBindings,
  method: string,
  path: string,
  opts: ApiOptions = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const request = new IncomingRequest(`http://flarebase.test${path}`, {
    method,
    headers,
    body,
  });
  const executionCtx = createExecutionContext();
  const res = await app.fetch(request, requestEnv, executionCtx);
  await waitOnExecutionContext(executionCtx);
  return { status: res.status, body: await res.json() };
}

export async function api(
  _ctx: TestContext,
  method: string,
  path: string,
  opts: ApiOptions = {},
): Promise<ApiResult> {
  return apiWithEnv(env, method, path, opts);
}

export const superApi = (
  ctx: TestContext,
  method: string,
  path: string,
  opts: { body?: unknown; rawBody?: string } = {},
) => api(ctx, method, path, { ...opts, token: ctx.superToken });

export async function tableNames(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function viewNames(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

export async function tableInfo(
  db: D1Database,
  table: string,
): Promise<ColumnInfo[]> {
  const { results } = await db
    .prepare(`PRAGMA table_info("${table}")`)
    .all<ColumnInfo>();
  return results;
}

export async function indexNames(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}
