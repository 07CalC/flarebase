import { beforeEach, describe, expect, it } from "vitest";
import { generateJWT } from "../src/lib/jwt";
import {
  createSession,
  revokeSession,
} from "../src/services/session.service";
import {
  api,
  indexNames,
  setupTest,
  superApi,
  tableInfo,
  tableNames,
  type TestContext,
} from "./setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

describe("collection authorization", () => {
  const guarded = [
    {
      method: "POST",
      path: "/api/collections",
      body: { name: "nope", fields: [{ name: "a", type: "text" }] },
    },
    { method: "GET", path: "/api/collections" },
    { method: "GET", path: "/api/collections/_superusers" },
    {
      method: "PATCH",
      path: "/api/collections/_superusers",
      body: { listRule: "" },
    },
    { method: "DELETE", path: "/api/collections/_superusers" },
  ];

  for (const route of guarded) {
    it(`${route.method} ${route.path} without token -> 403`, async () => {
      const res = await api(ctx, route.method, route.path, {
        body: route.body,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(res.body.data).toBeNull();
    });

    it(`${route.method} ${route.path} with garbage token -> 403`, async () => {
      const res = await api(ctx, route.method, route.path, {
        token: "not-a-real-token",
        body: route.body,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    });

    it(`${route.method} ${route.path} with non-superuser token -> 403`, async () => {
      const res = await api(ctx, route.method, route.path, {
        token: ctx.userToken,
        body: route.body,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    });
  }

  it("token for unknown session -> 403", async () => {
    const { token } = await generateJWT(
      { sub: "su1", collectionId: "_superusers" },
      "test-secret-for-collection-tests",
    );
    const res = await api(ctx, "GET", "/api/collections", { token });
    expect(res.status).toBe(403);
  });

  it("expired session token -> 403", async () => {
    const { token, jti } = await generateJWT(
      { sub: "su1", collectionId: "_superusers" },
      "test-secret-for-collection-tests",
    );
    await createSession(ctx.db, {
      collectionId: "_superusers",
      userId: "su1",
      jti,
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    });
    const res = await api(ctx, "GET", "/api/collections", { token });
    expect(res.status).toBe(403);
  });

  it("revoked session token -> 403", async () => {
    const { token, jti, exp } = await generateJWT(
      { sub: "su1", collectionId: "_superusers" },
      "test-secret-for-collection-tests",
    );
    await createSession(ctx.db, {
      collectionId: "_superusers",
      userId: "su1",
      jti,
      expiresAt: exp,
    });
    await revokeSession(ctx.db, jti);
    const res = await api(ctx, "GET", "/api/collections", { token });
    expect(res.status).toBe(403);
  });

  it("token signed with wrong secret -> 403", async () => {
    const { token, jti, exp } = await generateJWT(
      { sub: "su1", collectionId: "_superusers" },
      "wrong-secret",
    );
    await createSession(ctx.db, {
      collectionId: "_superusers",
      userId: "su1",
      jti,
      expiresAt: exp,
    });
    const res = await api(ctx, "GET", "/api/collections", { token });
    expect(res.status).toBe(403);
  });

  it("superuser token can list collections -> 200", async () => {
    const res = await superApi(ctx, "GET", "/api/collections");
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
  });
});

describe("POST /api/collections", () => {
  it("creates a base collection and returns 201 envelope", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "views", type: "number" },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe("CREATED");
    expect(res.body.error).toBeNull();
    const data = res.body.data;
    expect(data.name).toBe("posts");
    expect(data.type).toBe("base");
    expect(data.system).toBe(false);
    expect(data.id).toMatch(/^[0-9a-f]{10}$/);
    expect(Array.isArray(data.fields)).toBe(true);
    expect(data.fields).toHaveLength(2);
    expect(Array.isArray(data.indexes)).toBe(true);
    expect(data.listRule).toBeNull();
    expect(data.viewRule).toBeNull();
    expect(data.createRule).toBeNull();
    expect(data.updateRule).toBeNull();
    expect(data.deleteRule).toBeNull();
    expect(data.options).toEqual({});
  });

  it("creates the underlying table with mapped column types", async () => {
    await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "views", type: "number" },
          { name: "active", type: "bool" },
          { name: "meta", type: "json" },
        ],
      },
    });
    const cols = await tableInfo(ctx.db, "posts");
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName["id"].type).toBe("TEXT");
    expect(byName["id"].pk).toBe(1);
    expect(byName["title"].type).toBe("TEXT");
    expect(byName["title"].notnull).toBe(1);
    expect(byName["views"].type).toBe("REAL");
    expect(byName["views"].notnull).toBe(0);
    expect(byName["active"].type).toBe("INTEGER");
    expect(byName["meta"].type).toBe("TEXT");
    expect(byName["createdAt"].type).toBe("TIMESTAMP");
    expect(byName["updatedAt"].type).toBe("TIMESTAMP");
  });

  it("ignores system:true in the request body", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        system: true,
        fields: [{ name: "a", type: "text" }],
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.system).toBe(false);
  });

  it("stores rules, indexes and options", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [
          { name: "title", type: "text" },
          { name: "owner", type: "text" },
        ],
        indexes: [{ name: "idx_posts_title", on: "title" }],
        listRule: "",
        viewRule: "owner = @request.auth.id",
        options: { nested: { deep: [1, 2] } },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.listRule).toBe("");
    expect(res.body.data.viewRule).toBe("owner = @request.auth.id");
    expect(res.body.data.options).toEqual({ nested: { deep: [1, 2] } });
    expect(res.body.data.indexes).toEqual([
      { name: "idx_posts_title", on: "title" },
    ]);
    expect(await indexNames(ctx.db)).toContain("idx_posts_title");
  });

  it("creates unique indexes and enforces them", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [{ name: "slug", type: "text", unique: true }],
        indexes: [{ name: "idx_slug", on: "slug", unique: true }],
      },
    });
    expect(res.status).toBe(201);
    await ctx.db.prepare(`INSERT INTO "posts" (slug) VALUES ('a')`).run();
    await expect(
      ctx.db.prepare(`INSERT INTO "posts" (slug) VALUES ('a')`).run(),
    ).rejects.toThrow();
  });

  it("applies field defaults on insert", async () => {
    await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [
          { name: "title", type: "text" },
          { name: "views", type: "number", default: 5 },
          { name: "active", type: "bool", default: true },
          { name: "label", type: "text", default: "hi" },
        ],
      },
    });
    await ctx.db.prepare(`INSERT INTO "posts" (title) VALUES ('x')`).run();
    const row = (await ctx.db
      .prepare(`SELECT views, active, label FROM "posts"`)
      .first()) as any;
    expect(row.views).toBe(5);
    expect(row.active).toBe(1);
    expect(row.label).toBe("hi");
  });

  it("duplicate name -> 409", async () => {
    const body = {
      name: "posts",
      fields: [{ name: "a", type: "text" }],
    };
    expect((await superApi(ctx, "POST", "/api/collections", { body })).status).toBe(201);
    const res = await superApi(ctx, "POST", "/api/collections", { body });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
    expect(res.body.data).toBeNull();
  });

  it("system collection name is rejected as reserved before the duplicate check -> 400", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "_superusers", fields: [{ name: "a", type: "text" }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  const badNames = [
    "",
    "1abc",
    "has-dash",
    "has space",
    "dot.name",
    "semi;colon",
    "quote\"x",
    "a".repeat(65),
    "_hidden",
    "_superusers2",
    "sqlite_data",
    "SQLITE_x",
  ];
  for (const name of badNames) {
    it(`invalid name ${JSON.stringify(name)} -> 400`, async () => {
      const res = await superApi(ctx, "POST", "/api/collections", {
        body: { name, fields: [{ name: "a", type: "text" }] },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(await tableNames(ctx.db)).not.toContain(name);
    });
  }

  it("missing name / fields / empty fields / non-array fields -> 400", async () => {
    const bodies = [
      { fields: [{ name: "a", type: "text" }] },
      { name: "x" },
      { name: "x", fields: [] },
      { name: "x", fields: "nope" },
      { name: "x", fields: [{ name: "a" }] },
    ];
    for (const body of bodies) {
      const res = await superApi(ctx, "POST", "/api/collections", { body });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    }
  });

  it("more than 100 fields -> 400", async () => {
    const fields = Array.from({ length: 101 }, (_, i) => ({
      name: `f${i}`,
      type: "text",
    }));
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "big", fields },
    });
    expect(res.status).toBe(400);
  });

  it("duplicate field names -> 400", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "x",
        fields: [
          { name: "a", type: "text" },
          { name: "a", type: "number" },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("unknown field type -> 400", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "x", fields: [{ name: "a", type: "uuid" }] },
    });
    expect(res.status).toBe(400);
  });

  it("invalid field name -> 400", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "x", fields: [{ name: "bad-name", type: "text" }] },
    });
    expect(res.status).toBe(400);
  });

  it("auth collection without email -> 400", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "members",
        type: "auth",
        fields: [{ name: "password", type: "text" }],
      },
    });
    expect(res.status).toBe(400);
    expect(await tableNames(ctx.db)).not.toContain("members");
  });

  it("auth collection without password -> 400", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "members",
        type: "auth",
        fields: [{ name: "email", type: "email" }],
      },
    });
    expect(res.status).toBe(400);
  });

  it("auth collection with email+password -> 201", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "members",
        type: "auth",
        fields: [
          { name: "email", type: "email", required: true, unique: true },
          { name: "password", type: "text", required: true },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("auth");
    const cols = (await tableInfo(ctx.db, "members")).map((c) => c.name);
    expect(cols).toContain("email");
    expect(cols).toContain("password");
  });

  it("unknown collection type -> 400", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "x",
        type: "bogus",
        fields: [{ name: "a", type: "text" }],
      },
    });
    expect(res.status).toBe(400);
  });

  it("malformed JSON body -> 400 INVALID_REQUEST", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      rawBody: "{not json",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
  });

  it("index on unknown field -> 400", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "x",
        fields: [{ name: "a", type: "text" }],
        indexes: [{ name: "idx_bad", on: "missing" }],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(await tableNames(ctx.db)).not.toContain("x");
  });

  it("index on system column id is allowed", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "x",
        fields: [{ name: "a", type: "text" }],
        indexes: [{ name: "idx_x_id", on: "id" }],
      },
    });
    expect(res.status).toBe(201);
    expect(await indexNames(ctx.db)).toContain("idx_x_id");
  });

  it("pre-existing table with the same name -> 500, no metadata row", async () => {
    await ctx.db.prepare(`CREATE TABLE clash (id TEXT)`).run();
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "clash", fields: [{ name: "a", type: "text" }] },
    });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(await superApi(ctx, "GET", "/api/collections/clash")).toHaveProperty("status", 404);
  });

  it("hidden field is stored in metadata", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "x",
        fields: [{ name: "secret", type: "text", hidden: true }],
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.fields[0].hidden).toBe(true);
  });
});

describe("GET /api/collections", () => {
  it("lists seeded system collections with parsed JSON columns", async () => {
    const res = await superApi(ctx, "GET", "/api/collections");
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("SUCCESS");
    expect(res.body.error).toBeNull();
    const names = res.body.data.map((c: any) => c.name);
    expect(names).toContain("_superusers");
    expect(names).toContain("_sessions");
    expect(names).toContain("users");
    for (const col of res.body.data) {
      expect(Array.isArray(col.fields)).toBe(true);
      expect(Array.isArray(col.indexes)).toBe(true);
      expect(typeof col.options).toBe("object");
    }
  });

  it("includes newly created collections", async () => {
    await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const res = await superApi(ctx, "GET", "/api/collections");
    expect(res.body.data.map((c: any) => c.name)).toContain("posts");
    expect(res.body.data).toHaveLength(4);
  });
});

describe("GET /api/collections/:id", () => {
  it("gets a collection by id", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const res = await superApi(ctx, "GET", `/api/collections/${created.body.data.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("posts");
  });

  it("gets a collection by name", async () => {
    await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const res = await superApi(ctx, "GET", "/api/collections/posts");
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("posts");
  });

  it("missing collection -> 404", async () => {
    const res = await superApi(ctx, "GET", "/api/collections/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(res.body.data).toBeNull();
  });

  it("invalid identifier -> 404, not 500", async () => {
    const res = await superApi(ctx, "GET", "/api/collections/!!!");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/collections/:id", () => {
  it("updates a rule and persists it", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const id = created.body.data.id;
    const res = await superApi(ctx, "PATCH", `/api/collections/${id}`, {
      body: { listRule: "@request.auth.id != ''" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.listRule).toBe("@request.auth.id != ''");
    const again = await superApi(ctx, "GET", `/api/collections/${id}`);
    expect(again.body.data.listRule).toBe("@request.auth.id != ''");
  });

  it("explicit null rule is stored as null", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [{ name: "a", type: "text" }],
        listRule: "",
      },
    });
    const id = created.body.data.id;
    const res = await superApi(ctx, "PATCH", `/api/collections/${id}`, {
      body: { listRule: null },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.listRule).toBeNull();
  });

  it("replaces options", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [{ name: "a", type: "text" }],
        options: { old: true },
      },
    });
    const res = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: { options: { fresh: 1 } },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.options).toEqual({ fresh: 1 });
  });

  it("renames the collection and its table, preserving data", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "notes", fields: [{ name: "title", type: "text" }] },
    });
    const id = created.body.data.id;
    await ctx.db.prepare(`INSERT INTO "notes" (title) VALUES ('hello')`).run();
    const res = await superApi(ctx, "PATCH", `/api/collections/${id}`, {
      body: { name: "memos" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("memos");
    expect(res.body.data.id).toBe(id);
    expect(await tableNames(ctx.db)).toContain("memos");
    expect(await tableNames(ctx.db)).not.toContain("notes");
    const row = (await ctx.db
      .prepare(`SELECT title FROM "memos"`)
      .first()) as any;
    expect(row.title).toBe("hello");
    expect((await superApi(ctx, "GET", "/api/collections/notes")).status).toBe(404);
    expect((await superApi(ctx, "GET", "/api/collections/memos")).status).toBe(200);
  });

  it("renames by collection name, not just id", async () => {
    await superApi(ctx, "POST", "/api/collections", {
      body: { name: "notes", fields: [{ name: "a", type: "text" }] },
    });
    const res = await superApi(ctx, "PATCH", "/api/collections/notes", {
      body: { name: "memos" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("memos");
  });

  it("rename to a duplicate name -> 409", async () => {
    for (const name of ["aaa", "bbb"]) {
      await superApi(ctx, "POST", "/api/collections", {
        body: { name, fields: [{ name: "a", type: "text" }] },
      });
    }
    const res = await superApi(ctx, "PATCH", "/api/collections/aaa", {
      body: { name: "bbb" },
    });
    expect(res.status).toBe(409);
    expect((await superApi(ctx, "GET", "/api/collections/aaa")).status).toBe(200);
  });

  it("renaming a system collection -> 400", async () => {
    const res = await superApi(ctx, "PATCH", "/api/collections/_superusers", {
      body: { name: "renamed" },
    });
    expect(res.status).toBe(400);
    expect((await superApi(ctx, "GET", "/api/collections/_superusers")).status).toBe(200);
  });

  it("adds a new field as a real column with backfilled defaults", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "title", type: "text" }] },
    });
    await ctx.db.prepare(`INSERT INTO "posts" (title) VALUES ('old')`).run();
    const res = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: {
        fields: [
          { name: "title", type: "text" },
          { name: "views", type: "number", required: true },
          { name: "tag", type: "text", required: true },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.fields.map((f: any) => f.name)).toEqual(["title", "views", "tag"]);
    const cols = (await tableInfo(ctx.db, "posts")).map((c) => c.name);
    expect(cols).toContain("views");
    expect(cols).toContain("tag");
    const row = (await ctx.db
      .prepare(`SELECT views, tag FROM "posts"`)
      .first()) as any;
    expect(row.views).toBe(0);
    expect(row.tag).toBe("");
  });

  it("added unique field gets an enforced unique index", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "title", type: "text" }] },
    });
    const res = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: {
        fields: [
          { name: "title", type: "text" },
          { name: "slug", type: "text", unique: true },
        ],
      },
    });
    expect(res.status).toBe(200);
    await ctx.db
      .prepare(`INSERT INTO "posts" (title, slug) VALUES ('a', 's1')`)
      .run();
    await expect(
      ctx.db
        .prepare(`INSERT INTO "posts" (title, slug) VALUES ('b', 's1')`)
        .run(),
    ).rejects.toThrow();
  });

  it("removed fields leave the column in place but drop from metadata", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [
          { name: "title", type: "text" },
          { name: "gone", type: "text" },
        ],
      },
    });
    await ctx.db.prepare(`INSERT INTO "posts" (title, gone) VALUES ('t', 'g')`).run();
    const res = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: { fields: [{ name: "title", type: "text" }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.fields.map((f: any) => f.name)).toEqual(["title"]);
    expect((await tableInfo(ctx.db, "posts")).map((c) => c.name)).toContain("gone");
    const row = (await ctx.db
      .prepare(`SELECT gone FROM "posts"`)
      .first()) as any;
    expect(row.gone).toBe("g");
  });

  it("changing a field type -> 400 and metadata untouched", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "views", type: "number" }] },
    });
    const id = created.body.data.id;
    const res = await superApi(ctx, "PATCH", `/api/collections/${id}`, {
      body: { fields: [{ name: "views", type: "text" }] },
    });
    expect(res.status).toBe(400);
    const again = await superApi(ctx, "GET", `/api/collections/${id}`);
    expect(again.body.data.fields[0].type).toBe("number");
  });

  it("changing collection type is rejected", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const toAuth = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: { type: "auth" },
    });
    expect(toAuth.status).toBe(400);
    const authToBase = await superApi(ctx, "PATCH", `/api/collections/${ctx.usersId}`, {
      body: { type: "base" },
    });
    expect(authToBase.status).toBe(400);
  });

  it("sending the same type is a no-op success", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const res = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: { type: "base", listRule: "" },
    });
    expect(res.status).toBe(200);
  });

  it("modifying system collection fields -> 400, rules -> 200", async () => {
    const badFields = await superApi(ctx, "PATCH", "/api/collections/_sessions", {
      body: { fields: [{ name: "x", type: "text" }] },
    });
    expect(badFields.status).toBe(400);
    const okRules = await superApi(ctx, "PATCH", "/api/collections/_sessions", {
      body: { listRule: "" },
    });
    expect(okRules.status).toBe(200);
    expect(okRules.body.data.listRule).toBe("");
  });

  it("removing password from an auth collection -> 400", async () => {
    const res = await superApi(ctx, "PATCH", `/api/collections/${ctx.usersId}`, {
      body: { fields: [{ name: "email", type: "email" }] },
    });
    expect(res.status).toBe(400);
  });

  it("empty body -> 400", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const res = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it("malformed JSON -> 400", async () => {
    const res = await superApi(ctx, "PATCH", "/api/collections/users", {
      rawBody: "[broken",
    });
    expect(res.status).toBe(400);
  });

  it("missing collection -> 404", async () => {
    const res = await superApi(ctx, "PATCH", "/api/collections/nope", {
      body: { listRule: "" },
    });
    expect(res.status).toBe(404);
  });

  it("new indexes are created on update", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "title", type: "text" }] },
    });
    const res = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: { indexes: [{ name: "idx_posts_title", on: "title" }] },
    });
    expect(res.status).toBe(200);
    expect(await indexNames(ctx.db)).toContain("idx_posts_title");
  });

  it("rename plus new field in one request", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "notes", fields: [{ name: "title", type: "text" }] },
    });
    const res = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: {
        name: "memos",
        fields: [
          { name: "title", type: "text" },
          { name: "views", type: "number" },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("memos");
    expect((await tableInfo(ctx.db, "memos")).map((c) => c.name)).toContain("views");
  });

  it("invalid update payload (bad field type) -> 400", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const res = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: { fields: [{ name: "a", type: "nope" }] },
    });
    expect(res.status).toBe(400);
  });

  it("reserved rename target -> 400", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const res = await superApi(ctx, "PATCH", `/api/collections/${created.body.data.id}`, {
      body: { name: "_reserved" },
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/collections/:id", () => {
  it("deletes metadata and drops the table", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const id = created.body.data.id;
    const res = await superApi(ctx, "DELETE", `/api/collections/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.name).toBe("posts");
    expect((await superApi(ctx, "GET", `/api/collections/${id}`)).status).toBe(404);
    expect(await tableNames(ctx.db)).not.toContain("posts");
  });

  it("deletes by name as well as id", async () => {
    await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    const res = await superApi(ctx, "DELETE", "/api/collections/posts");
    expect(res.status).toBe(200);
    expect(await tableNames(ctx.db)).not.toContain("posts");
  });

  it("missing collection -> 404", async () => {
    const res = await superApi(ctx, "DELETE", "/api/collections/nope");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("system collection cannot be deleted", async () => {
    const res = await superApi(ctx, "DELETE", "/api/collections/_superusers");
    expect(res.status).toBe(400);
    expect((await superApi(ctx, "GET", "/api/collections/_superusers")).status).toBe(200);
    expect(await tableNames(ctx.db)).toContain("_superusers");
  });

  it("deleting an auth collection cleans up its sessions", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "members",
        type: "auth",
        fields: [
          { name: "email", type: "email" },
          { name: "password", type: "text" },
        ],
      },
    });
    const membersId = created.body.data.id;
    await ctx.db
      .prepare(`INSERT INTO "members" (id, email, password) VALUES (?1, ?2, ?3)`)
      .bind("m1", "m@example.com", "pw")
      .run();
    const { jti, exp } = await generateJWT(
      { sub: "m1", collectionId: membersId },
      "test-secret-for-collection-tests",
    );
    await createSession(ctx.db, {
      collectionId: membersId,
      userId: "m1",
      jti,
      expiresAt: exp,
    });

    const res = await superApi(ctx, "DELETE", `/api/collections/${membersId}`);
    expect(res.status).toBe(200);
    const leftover = (await ctx.db
      .prepare(`SELECT jti FROM _sessions WHERE collectionId = ?1`)
      .bind(membersId)
      .all()) as unknown as { results: unknown[] };
    expect(leftover.results).toHaveLength(0);
    // other sessions are untouched
    const suSessions = (await ctx.db
      .prepare(`SELECT jti FROM _sessions WHERE collectionId = ?1`)
      .bind("_superusers")
      .all()) as unknown as { results: unknown[] };
    expect(suSessions.results).toHaveLength(1);
  });

  it("name is reusable after delete", async () => {
    const first = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    expect((await superApi(ctx, "DELETE", `/api/collections/${first.body.data.id}`)).status).toBe(200);
    const second = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "b", type: "number" }] },
    });
    expect(second.status).toBe(201);
    expect((await tableInfo(ctx.db, "posts")).map((c) => c.name)).toContain("b");
  });
});
