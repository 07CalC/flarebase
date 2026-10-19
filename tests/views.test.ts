import { beforeEach, describe, expect, it } from "vitest";
import { createCollection } from "../src/services/collection.service";
import type { Collection } from "../src/services/collection.service";
import type { CollectionFieldInput } from "../src/lib/collection";
import {
  api,
  setupTest,
  superApi,
  tableNames,
  viewNames,
  type TestContext,
} from "./setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

const COLLECTIONS_URL = "/api/collections";
const RECORDS_URL = "/api/collections/post_overview/records";

function postFields(): CollectionFieldInput[] {
  return [
    { name: "title", type: "text", required: true },
    { name: "views", type: "number", min: 0 },
    {
      name: "status",
      type: "select",
      values: ["draft", "published"],
      default: "draft",
    },
    { name: "author", type: "relation", collectionId: ctx.usersId },
  ];
}

// open ("") rules by default so record reads work without extra setup; the
// view itself is created with null rules unless a test overrides them
async function makePosts(): Promise<Collection> {
  return createCollection(ctx.db, {
    name: "posts",
    fields: postFields(),
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
  });
}

const SELECTED_COLUMNS =
  "p.id AS id, p.title AS title, p.views AS views, p.status AS status, " +
  "u.email AS authorEmail, p.createdAt AS createdAt";

const VIEW_QUERY = `SELECT ${SELECTED_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author`;

const VIEW_QUERY_WITHOUT_VIEWS =
  "SELECT p.id AS id, p.title AS title, p.status AS status, " +
  "u.email AS authorEmail, p.createdAt AS createdAt " +
  "FROM posts p LEFT JOIN users u ON u.id = p.author";

function makeView(overrides: Record<string, unknown> = {}) {
  return superApi(ctx, "POST", COLLECTIONS_URL, {
    body: {
      name: "post_overview",
      type: "view",
      options: { query: VIEW_QUERY },
      ...overrides,
    },
  });
}

async function insertPost(
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const columns = ["id", ...Object.keys(fields)];
  const placeholders = columns.map(() => "?").join(", ");
  await ctx.db
    .prepare(
      `INSERT INTO "posts" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
    )
    .bind(id, ...Object.values(fields))
    .run();
}

async function seedPosts(): Promise<void> {
  await insertPost("p1", {
    title: "alpha",
    views: 5,
    status: "published",
    author: "u1",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await insertPost("p2", {
    title: "beta",
    views: 0,
    status: "draft",
    author: "u1",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  await insertPost("p3", {
    title: "gamma",
    views: 20,
    status: "published",
    createdAt: "2026-01-03T00:00:00.000Z",
  });
}

const listView = (query = "", token?: string | null) =>
  api(ctx, "GET", `${RECORDS_URL}${query}`, { token });

const getView = (id: string, token?: string | null) =>
  api(ctx, "GET", `${RECORDS_URL}/${id}`, { token });

describe("view collection lifecycle", () => {
  it("creates a view over joined collections and resolves its fields", async () => {
    await makePosts();
    await seedPosts();

    const res = await makeView();
    expect(res.status).toBe(201);
    expect(res.body.code).toBe("CREATED");
    const data = res.body.data;
    expect(data.type).toBe("view");
    expect(data.system).toBe(false);
    expect(data.options.query).toBe(VIEW_QUERY);
    expect(data.fields.map((f: any) => f.name)).toEqual([
      "id",
      "title",
      "views",
      "status",
      "authorEmail",
      "createdAt",
    ]);
    const typeByName = Object.fromEntries(
      data.fields.map((f: any) => [f.name, f.type]),
    );
    expect(typeByName.id).toBe("text");
    expect(typeByName.title).toBe("text");
    expect(typeByName.views).toBe("number");
    expect(typeByName.createdAt).toBe("text");
    expect(await viewNames(ctx.db)).toEqual(["post_overview"]);

    const fetched = await superApi(ctx, "GET", `${COLLECTIONS_URL}/${data.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.fields).toEqual(data.fields);
  });

  it("requires options.query and rejects client-supplied shape", async () => {
    for (const body of [
      { name: "v1", type: "view" },
      { name: "v1", type: "view", options: {} },
      { name: "v1", type: "view", options: { query: "   " } },
    ]) {
      const res = await superApi(ctx, "POST", COLLECTIONS_URL, { body });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    }

    const withFields = await superApi(ctx, "POST", COLLECTIONS_URL, {
      body: {
        name: "v1",
        type: "view",
        options: { query: "SELECT 1 AS id" },
        fields: [{ name: "id", type: "text" }],
      },
    });
    expect(withFields.status).toBe(400);
    expect(withFields.body.error).toContain("derived");

    const withIndexes = await superApi(ctx, "POST", COLLECTIONS_URL, {
      body: {
        name: "v1",
        type: "view",
        options: { query: "SELECT 1 AS id" },
        indexes: [{ name: "idx_v1", on: "id" }],
      },
    });
    expect(withIndexes.status).toBe(400);
    expect(withIndexes.body.error).toContain("indexes");

    expect(await viewNames(ctx.db)).toEqual([]);
  });

  it("rejects queries that are not a single SELECT over user collections", async () => {
    await makePosts();
    const cases: Array<[string, string]> = [
      ["DELETE FROM posts", "single SELECT statement"],
      ["SELECT id FROM posts; DROP TABLE posts", "exactly one statement"],
      ["SELECT id FROM _superusers", "reserved identifier"],
      ["SELECT id FROM sqlite_master", "reserved identifier"],
      ["SELECT id, password FROM users", "password"],
      ["SELECT title FROM posts", 'expose an "id" column'],
      ["SELECT nope FROM posts", "Invalid view query"],
      ['SELECT id, title AS "bad name" FROM posts', "valid field name"],
    ];
    for (const [query, fragment] of cases) {
      const res = await superApi(ctx, "POST", COLLECTIONS_URL, {
        body: { name: "v_bad", type: "view", options: { query } },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(fragment);
    }
    // nothing leaked out of the failed attempts
    expect(await viewNames(ctx.db)).toEqual([]);
    expect(await tableNames(ctx.db)).toContain("posts");
  });

  it("renames and deletes the underlying SQL view", async () => {
    await makePosts();
    await seedPosts();
    const created = await makeView({ listRule: "", viewRule: "" });
    const id = created.body.data.id;

    const renamed = await superApi(ctx, "PATCH", `${COLLECTIONS_URL}/${id}`, {
      body: { name: "overview" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe("overview");
    expect(await viewNames(ctx.db)).toEqual(["overview"]);
    expect((await listView()).status).toBe(404);

    const listed = await api(ctx, "GET", "/api/collections/overview/records");
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toHaveLength(3);

    const deleted = await superApi(ctx, "DELETE", `${COLLECTIONS_URL}/${id}`);
    expect(deleted.status).toBe(200);
    expect(await viewNames(ctx.db)).toEqual([]);
    expect(
      (await api(ctx, "GET", "/api/collections/overview/records")).status,
    ).toBe(404);
  });
});

describe("view record reads", () => {
  it("serves the joined rows and enforces the rule matrix", async () => {
    await makePosts();
    await seedPosts();
    await makeView({ listRule: "views > 10", viewRule: "views > 10" });

    const anon = await listView();
    expect(anon.status).toBe(200);
    expect(anon.body.data.items.map((i: any) => i.title)).toEqual(["gamma"]);
    expect(anon.body.data.totalItems).toBe(1);
    expect(anon.body.data.items[0].authorEmail).toBeNull();

    // rows the rule denies stay invisible: 404 like a missing record
    expect((await getView("p1")).status).toBe(404);
    const allowed = await getView("p3");
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.title).toBe("gamma");
    expect(allowed.body.data.views).toBe(20);
    expect((await getView("nope")).status).toBe(404);

    // superusers bypass the rule but still see only resolved columns
    const asSuper = await listView("", ctx.superToken);
    expect(asSuper.status).toBe(200);
    expect(asSuper.body.data.items).toHaveLength(3);
    expect(asSuper.body.data.items[0]).not.toHaveProperty("password");
  });

  it("locks the view to superusers when viewRule is null", async () => {
    await makePosts();
    await seedPosts();
    await makeView();

    for (const token of [undefined, ctx.userToken]) {
      const res = await listView("", token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    }
    const asSuper = await listView("", ctx.superToken);
    expect(asSuper.status).toBe(200);
    expect(asSuper.body.data.items).toHaveLength(3);
  });

  it("supports filters and sorting on resolved columns only", async () => {
    await makePosts();
    await seedPosts();
    await makeView({ listRule: "", viewRule: "" });

    const all = await listView();
    expect(all.body.data.items.map((i: any) => i.title)).toEqual([
      "gamma",
      "beta",
      "alpha",
    ]);

    const byViews = await listView("?views=5");
    expect(byViews.body.data.items.map((i: any) => i.title)).toEqual(["alpha"]);

    const byEmail = await listView("?authorEmail=user@example.com");
    expect(byEmail.body.data.items.map((i: any) => i.title)).toEqual([
      "beta",
      "alpha",
    ]);

    const sorted = await listView("?sort=-views");
    expect(sorted.body.data.items.map((i: any) => i.title)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);

    // implicit table columns do not exist on a view
    expect((await listView("?sort=updatedAt")).status).toBe(400);
    expect((await listView("?updatedAt=2026-01-01")).status).toBe(400);
    expect((await listView("?nope=1")).status).toBe(400);
  });

  it("keeps views read-only and their fields derived", async () => {
    await makePosts();
    await seedPosts();
    await makeView({ listRule: "", viewRule: "" });

    const create = await superApi(ctx, "POST", RECORDS_URL, {
      body: { title: "nope" },
    });
    expect(create.status).toBe(400);
    expect(create.body.error).toContain("read-only");

    const patchFields = await superApi(
      ctx,
      "PATCH",
      `${COLLECTIONS_URL}/post_overview`,
      { body: { fields: [{ name: "id", type: "text" }] } },
    );
    expect(patchFields.status).toBe(400);
    expect(patchFields.body.error).toContain("derived");
  });
});

describe("view updates", () => {
  it("rebuilds the view on query change and recompiles rules", async () => {
    await makePosts();
    await seedPosts();
    await makeView({ listRule: "views > 0", viewRule: "views > 0" });

    const initial = await listView();
    expect(initial.body.data.items.map((i: any) => i.title)).toEqual([
      "gamma",
      "alpha",
    ]);

    // dropping the column the stored rule references rejects the patch and
    // keeps the previous view serving
    const broken = await superApi(
      ctx,
      "PATCH",
      `${COLLECTIONS_URL}/post_overview`,
      { body: { options: { query: VIEW_QUERY_WITHOUT_VIEWS } } },
    );
    expect(broken.status).toBe(400);
    expect(broken.body.error).toContain("views");
    const stillOld = await listView();
    expect(stillOld.status).toBe(200);
    expect(stillOld.body.data.items.map((i: any) => i.title)).toEqual([
      "gamma",
      "alpha",
    ]);

    // the same patch plus a rule that fits the new columns succeeds
    const fixed = await superApi(
      ctx,
      "PATCH",
      `${COLLECTIONS_URL}/post_overview`,
      {
        body: {
          options: { query: VIEW_QUERY_WITHOUT_VIEWS },
          listRule: 'status = "published"',
          viewRule: 'status = "published"',
        },
      },
    );
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.fields.map((f: any) => f.name)).toEqual([
      "id",
      "title",
      "status",
      "authorEmail",
      "createdAt",
    ]);

    const reloaded = await listView();
    expect(reloaded.body.data.items.map((i: any) => i.title)).toEqual([
      "gamma",
      "alpha",
    ]);
  });

  it("compiles rules against resolved fields only (no implicit columns)", async () => {
    await makePosts();
    await seedPosts();

    const res = await makeView({ listRule: "updatedAt > @now" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('unknown field "updatedAt"');
    expect(await viewNames(ctx.db)).toEqual([]);
  });

  it("ignores an unchanged query and recompiles only the rules", async () => {
    await makePosts();
    await seedPosts();
    await makeView({ listRule: "", viewRule: "" });

    const res = await superApi(
      ctx,
      "PATCH",
      `${COLLECTIONS_URL}/post_overview`,
      {
        body: {
          options: { query: VIEW_QUERY },
          listRule: 'status = "draft"',
        },
      },
    );
    expect(res.status).toBe(200);

    const listed = await listView();
    expect(listed.body.data.items.map((i: any) => i.title)).toEqual(["beta"]);
  });
});
