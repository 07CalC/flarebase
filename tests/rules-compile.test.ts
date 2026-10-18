import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../src/lib/response";
import { getCompiledCollectionByIdOrName } from "../src/services/collection.service";
import { setupTest, superApi, tableNames, type TestContext } from "./setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

async function storedRules(
  db: D1Database,
  collectionId: string,
): Promise<Record<string, unknown>> {
  const row = await db
    .prepare(`SELECT compiledRules FROM _collections WHERE id = ?1`)
    .bind(collectionId)
    .first<{ compiledRules: string }>();
  if (!row) throw new Error("collection not found");
  return JSON.parse(row.compiledRules) as Record<string, unknown>;
}

describe("rules compiled at collection save", () => {
  it("stores artifacts for valid rules and keeps them off the API response", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [
          { name: "title", type: "text" },
          { name: "owner", type: "text" },
        ],
        listRule: "owner = @request.auth.id",
        createRule: "@request.body.title:isset",
        viewRule: null,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.compiledRules).toBeUndefined();
    expect(res.body.data.listRule).toBe("owner = @request.auth.id");
    expect(await storedRules(ctx.db, res.body.data.id)).toEqual({
      listRule: {
        sql: '("owner" = ?)',
        slots: [{ kind: "auth", path: "id" }],
      },
      createRule: {
        sql: "(?)",
        slots: [{ kind: "isset", source: "body", path: "title" }],
      },
    });
  });

  it('compiles "" to the open constant', async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [{ name: "a", type: "text" }],
        listRule: "",
      },
    });
    expect(res.status).toBe(201);
    expect(await storedRules(ctx.db, res.body.data.id)).toEqual({
      listRule: { sql: "1", slots: [] },
    });
  });

  it("rejects an invalid rule and writes nothing", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [{ name: "title", type: "text" }],
        viewRule: "owner = @request.auth.id",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.data).toBeNull();
    expect(res.body.error).toContain(
      'viewRule: unknown field "owner" (line 1, column 1)',
    );
    expect(await tableNames(ctx.db)).not.toContain("posts");
    const lookup = await superApi(ctx, "GET", "/api/collections/posts");
    expect(lookup.status).toBe(404);
  });

  it("reports every broken rule in one message", async () => {
    const res = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [{ name: "views", type: "number" }],
        listRule: "ownr = 1",
        deleteRule: 'views > "5"',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(
      'listRule: unknown field "ownr" (line 1, column 1)',
    );
    expect(res.body.error).toContain(
      'deleteRule: cannot compare number field "views" with string literal using ">" (line 1, column 1)',
    );
  });

  it("recompiles rules on patch", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [{ name: "views", type: "number" }],
        listRule: "",
      },
    });
    const id = created.body.data.id;

    const res = await superApi(ctx, "PATCH", `/api/collections/${id}`, {
      body: { listRule: "views > 5" },
    });
    expect(res.status).toBe(200);
    expect(await storedRules(ctx.db, id)).toEqual({
      listRule: { sql: '("views" > ?)', slots: [{ kind: "literal", value: 5 }] },
    });
  });

  it("requires rules to be fixed when their field is removed in the same patch", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [
          { name: "views", type: "number" },
          { name: "title", type: "text" },
        ],
        listRule: "views > 5",
      },
    });
    const id = created.body.data.id;

    const broken = await superApi(ctx, "PATCH", `/api/collections/${id}`, {
      body: { fields: [{ name: "title", type: "text" }] },
    });
    expect(broken.status).toBe(400);
    expect(broken.body.code).toBe("VALIDATION_ERROR");
    expect(broken.body.error).toContain(
      'listRule: unknown field "views" (line 1, column 1)',
    );

    const fixed = await superApi(ctx, "PATCH", `/api/collections/${id}`, {
      body: { fields: [{ name: "title", type: "text" }], listRule: "" },
    });
    expect(fixed.status).toBe(200);
    expect(await storedRules(ctx.db, id)).toEqual({
      listRule: { sql: "1", slots: [] },
    });
  });

  it("drops the artifact when a rule is locked again", async () => {
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
    expect(await storedRules(ctx.db, id)).toEqual({});
  });

  it("compiles system collection rule patches without modifying fields", async () => {
    const res = await superApi(ctx, "PATCH", "/api/collections/_sessions", {
      body: { listRule: "" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.compiledRules).toBeUndefined();
    expect(await storedRules(ctx.db, "_sessions")).toEqual({
      listRule: { sql: "1", slots: [] },
    });
  });

  it("loads parsed artifacts through the internal getter (id and name)", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: {
        name: "posts",
        fields: [{ name: "owner", type: "text" }],
        listRule: "owner = @request.auth.id",
      },
    });
    const byId = await getCompiledCollectionByIdOrName(
      ctx.db,
      created.body.data.id,
    );
    const byName = await getCompiledCollectionByIdOrName(ctx.db, "posts");
    expect(byId?.compiledRules.listRule).toEqual({
      sql: '("owner" = ?)',
      slots: [{ kind: "auth", path: "id" }],
    });
    expect(byName?.id).toBe(created.body.data.id);
    expect(await getCompiledCollectionByIdOrName(ctx.db, "missing")).toBeNull();
  });

  it("fails closed on corrupt compiled artifacts", async () => {
    const created = await superApi(ctx, "POST", "/api/collections", {
      body: { name: "posts", fields: [{ name: "a", type: "text" }] },
    });
    await ctx.db
      .prepare(`UPDATE _collections SET compiledRules = 'not json' WHERE id = ?1`)
      .bind(created.body.data.id)
      .run();
    await expect(
      getCompiledCollectionByIdOrName(ctx.db, created.body.data.id),
    ).rejects.toBeInstanceOf(AppError);
  });
});
