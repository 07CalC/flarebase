import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import type { HonoApp } from "../src/config";
import { generateJWT } from "../src/lib/jwt";
import { createSession } from "../src/services/session.service";
import { createCollection } from "../src/services/collection.service";
// the real entrypoint, so tests exercise the same middleware wiring as prod
// (global authMiddleware etc.)
import app from "../src/index";
import { createTestDb, type RawDatabase } from "./d1-shim";
import { hashPassword } from "../src/lib/hash";

export const TEST_SECRET = "test-secret-for-collection-tests";

// seeded account passwords are stored as real PBKDF2 hashes (the literal
// "hashed-password" is the plaintext to use in login flows)
const TEST_PASSWORD_HASH = await hashPassword("hashed-password");

const HERE = dirname(fileURLToPath(import.meta.url));

export interface TestContext {
  db: D1Database;
  raw: RawDatabase;
  app: Hono<HonoApp>;
  superToken: string;
  userToken: string;
  usersId: string;
}

export async function setupTest(): Promise<TestContext> {
  const { db, raw } = createTestDb();
  raw.exec(
    readFileSync(join(HERE, "..", "migrations", "001_init.sql"), "utf8"),
  );
  raw.exec(
    readFileSync(join(HERE, "..", "migrations", "002_sessions.sql"), "utf8"),
  );

  await db
    .prepare(
      `INSERT INTO _superusers (id, email, password) VALUES (?1, ?2, ?3)`,
    )
    .bind("su1", "admin@example.com", TEST_PASSWORD_HASH)
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
    .bind("u1", "user@example.com", TEST_PASSWORD_HASH)
    .run();

  const u = await generateJWT(
    { sub: "u1", collectionId: users.id },
    TEST_SECRET,
  );
  await createSession(db, {
    collectionId: users.id,
    userId: "u1",
    jti: u.jti,
    expiresAt: u.exp,
  });

  return {
    db,
    raw,
    app,
    superToken: su.token,
    userToken: u.token,
    usersId: users.id,
  };
}

export interface ApiResult {
  status: number;
  body: any;
}

export async function api(
  ctx: TestContext,
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; rawBody?: string } = {},
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
  const env = { DB: ctx.db, JWT_SECRET: TEST_SECRET } as unknown as CloudflareBindings;
  const res = await ctx.app.request(path, { method, headers, body }, env);
  return { status: res.status, body: await res.json() };
}

export const superApi = (
  ctx: TestContext,
  method: string,
  path: string,
  opts: { body?: unknown; rawBody?: string } = {},
) => api(ctx, method, path, { ...opts, token: ctx.superToken });

export function tableNames(raw: RawDatabase): string[] {
  const rows = raw
    .query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

export function tableInfo(raw: RawDatabase, table: string): ColumnInfo[] {
  return raw.query(`PRAGMA table_info("${table}")`).all() as unknown as ColumnInfo[];
}

export function indexNames(raw: RawDatabase): string[] {
  const rows = raw
    .query(`SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
