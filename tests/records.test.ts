import { beforeEach, describe, expect, it } from "vitest";
import { createCollection } from "../src/services/collection.service";
import type { Collection } from "../src/services/collection.service";
import type { CollectionFieldInput } from "../src/lib/collection";
import { verifyPassword } from "../src/lib/hash";
import { api, setupTest, superApi, type TestContext } from "./setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

type RuleName =
  | "listRule"
  | "viewRule"
  | "createRule"
  | "updateRule"
  | "deleteRule";

const BASE_URL = "/api/collections/posts/records";
const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function postFields(): CollectionFieldInput[] {
  return [
    { name: "title", type: "text", required: true, min: 2, max: 100 },
    { name: "slug", type: "text", unique: true },
    { name: "views", type: "number", min: 0 },
    { name: "status", type: "select", values: ["draft", "published"], default: "draft" },
    { name: "featured", type: "bool", default: false },
    { name: "publishAt", type: "date" },
    { name: "meta", type: "json" },
    { name: "author", type: "relation", collectionId: ctx.usersId },
    { name: "secret", type: "text", hidden: true, default: "classified" },
  ];
}

// open ("") rules by default; individual rules can be overridden per test
async function makePosts(
  rules: Partial<Record<RuleName, string | null>> = {},
): Promise<Collection> {
  return createCollection(ctx.db, {
    name: "posts",
    fields: postFields(),
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    ...rules,
  });
}

const createPost = (body: unknown, token?: string | null) =>
  api(ctx, "POST", BASE_URL, { body, token });

const listPosts = (query = "", token?: string | null) =>
  api(ctx, "GET", `${BASE_URL}${query}`, { token });

const getPost = (id: string, token?: string | null) =>
  api(ctx, "GET", `${BASE_URL}/${id}`, { token });

const patchPost = (id: string, body: unknown, token?: string | null) =>
  api(ctx, "PATCH", `${BASE_URL}/${id}`, { body, token });

const deletePost = (id: string, token?: string | null) =>
  api(ctx, "DELETE", `${BASE_URL}/${id}`, { token });

async function insertPost(fields: Record<string, unknown>): Promise<string> {
  const id = `p${Math.random().toString(16).slice(2, 12)}`;
  const columns = ["id", ...Object.keys(fields)];
  const placeholders = columns.map(() => "?").join(", ");
  await ctx.db
    .prepare(
      `INSERT INTO "posts" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
    )
    .bind(id, ...Object.values(fields))
    .run();
  return id;
}

describe("records CRUD (open rules)", () => {
  it("returns 404 for an unknown collection before anything else", async () => {
    const res = await api(ctx, "GET", "/api/collections/ghost/records");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("creates a record with defaults, generated id and normalized timestamps", async () => {
    await makePosts();
    const res = await createPost({ title: "hello world" });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe("CREATED");
    expect(typeof res.body.data.id).toBe("string");
    expect(res.body.data.title).toBe("hello world");
    // metadata defaults applied by the column, surfaced as native types
    expect(res.body.data.status).toBe("draft");
    expect(res.body.data.featured).toBe(false);
    expect(res.body.data.createdAt).toMatch(RFC3339_MS);
    expect(res.body.data.updatedAt).toMatch(RFC3339_MS);
    // hidden fields never leave the server
    expect(res.body.data).not.toHaveProperty("secret");
    const stored = await ctx.db
      .prepare(`SELECT secret FROM posts WHERE id = ?1`)
      .bind(res.body.data.id)
      .first<{ secret: string }>();
    expect(stored?.secret).toBe("classified");
  });

  it("ignores unknown and hidden keys in the payload", async () => {
    await makePosts();
    const res = await createPost({
      title: "hello world",
      nope: 1,
      secret: "hacked",
    });
    expect(res.status).toBe(201);
    expect(res.body.data).not.toHaveProperty("nope");
    expect(res.body.data).not.toHaveProperty("secret");
    const stored = await ctx.db
      .prepare(`SELECT secret FROM posts WHERE id = ?1`)
      .bind(res.body.data.id)
      .first<{ secret: string }>();
    expect(stored?.secret).toBe("classified");
  });

  it("rejects invalid payloads with VALIDATION_ERROR", async () => {
    await makePosts();
    const missing = await createPost({ views: 1 });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VALIDATION_ERROR");
    expect(missing.body.error).toContain("title");

    const short = await createPost({ title: "x" });
    expect(short.status).toBe(400);
    expect(short.body.error).toContain("at least 2");

    const badSelect = await createPost({ title: "hello", status: "nope" });
    expect(badSelect.status).toBe(400);

    const badNumber = await createPost({ title: "hello", views: "many" });
    expect(badNumber.status).toBe(400);

    const badDate = await createPost({ title: "hello", publishAt: "not-a-date" });
    expect(badDate.status).toBe(400);
    expect(badDate.body.error).toContain("valid date");
  });

  it("returns 400 INVALID_REQUEST for malformed JSON", async () => {
    await makePosts();
    const res = await api(ctx, "POST", BASE_URL, { rawBody: "not json" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
  });

  it("round-trips dates, json and booleans in their native shapes", async () => {
    await makePosts();
    const created = await createPost({
      title: "typed",
      publishAt: "1990-01-01",
      meta: { tags: ["a", "b"], nested: { n: 1 } },
      featured: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.publishAt).toBe("1990-01-01T00:00:00.000Z");
    expect(created.body.data.meta).toEqual({ tags: ["a", "b"], nested: { n: 1 } });
    expect(created.body.data.featured).toBe(true);

    // stored canonical forms
    const stored = await ctx.db
      .prepare(`SELECT publishAt, meta, featured FROM posts WHERE id = ?1`)
      .bind(created.body.data.id)
      .first<any>();
    expect(stored.publishAt).toBe("1990-01-01T00:00:00.000Z");
    expect(JSON.parse(stored.meta)).toEqual({ tags: ["a", "b"], nested: { n: 1 } });
    expect(stored.featured).toBe(1);

    const got = await getPost(created.body.data.id);
    expect(got.body.data.publishAt).toBe("1990-01-01T00:00:00.000Z");
    expect(got.body.data.meta).toEqual({ tags: ["a", "b"], nested: { n: 1 } });
    expect(got.body.data.featured).toBe(true);
  });

  it("maps unique constraint violations to CONFLICT", async () => {
    await makePosts();
    const first = await createPost({ title: "one", slug: "same" });
    expect(first.status).toBe(201);
    const second = await createPost({ title: "two", slug: "same" });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("CONFLICT");
  });

  it("validates relation targets exist", async () => {
    await makePosts();
    const ok = await createPost({ title: "with author", author: "u1" });
    expect(ok.status).toBe(201);

    const missing = await createPost({ title: "with ghost", author: "nope" });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VALIDATION_ERROR");
    expect(missing.body.error).toContain("does not exist");
  });

  it("rejects relations pointing at a deleted collection", async () => {
    await createCollection(ctx.db, {
      name: "notes",
      fields: [{ name: "link", type: "relation", collectionId: "ghost-collection" }],
      createRule: "",
    });
    const res = await api(ctx, "POST", "/api/collections/notes/records", {
      body: { link: "abc" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no longer exists");
  });

  it("roundtrips list, view, update and delete", async () => {
    await makePosts();
    const created = await createPost({ title: "draft one", views: 1 });
    const id = created.body.data.id;

    const got = await getPost(id);
    expect(got.status).toBe(200);
    expect(got.body.data.title).toBe("draft one");

    const listed = await listPosts();
    expect(listed.status).toBe(200);
    expect(listed.body.data.totalItems).toBe(1);
    expect(listed.body.data.items[0].id).toBe(id);

    // give the clock a tick so the updatedAt bump is observable
    await new Promise((resolve) => setTimeout(resolve, 5));
    const patched = await patchPost(id, { title: "draft two", featured: true });
    expect(patched.status).toBe(200);
    expect(patched.body.data.title).toBe("draft two");
    expect(patched.body.data.featured).toBe(true);
    expect(patched.body.data.updatedAt).not.toBe(patched.body.data.createdAt);
    expect(patched.body.data.updatedAt > patched.body.data.createdAt).toBe(true);

    const deleted = await deletePost(id);
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.id).toBe(id);
    expect(deleted.body.data).not.toHaveProperty("secret");

    const gone = await getPost(id);
    expect(gone.status).toBe(404);
    expect((await listPosts()).body.data.totalItems).toBe(0);
  });

  it("rejects empty and hidden-only patches", async () => {
    await makePosts();
    const created = await createPost({ title: "patch me" });
    const id = created.body.data.id;

    const empty = await patchPost(id, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error).toContain("At least one field");

    const hiddenOnly = await patchPost(id, { secret: "changed" });
    expect(hiddenOnly.status).toBe(400);

    const unknownOnly = await patchPost(id, { nope: 1 });
    expect(unknownOnly.status).toBe(400);

    const stillThere = await getPost(id);
    expect(stillThere.status).toBe(200);
  });

  it("exposes pagination with page/perPage and total metadata", async () => {
    await makePosts();
    for (const title of ["one", "two", "three"]) {
      expect((await createPost({ title })).status).toBe(201);
    }

    const page1 = await listPosts("?page=1&perPage=2");
    expect(page1.status).toBe(200);
    expect(page1.body.data).toMatchObject({ page: 1, perPage: 2, totalItems: 3, totalPages: 2 });
    expect(page1.body.data.items).toHaveLength(2);

    const page2 = await listPosts("?page=2&perPage=2");
    expect(page2.body.data.items).toHaveLength(1);

    const defaults = await listPosts();
    expect(defaults.body.data).toMatchObject({ page: 1, perPage: 30, totalItems: 3, totalPages: 1 });
  });

  it("rejects invalid pagination values", async () => {
    await makePosts();
    for (const query of ["?page=0", "?page=abc", "?perPage=0", "?perPage=501", "?perPage=1.5"]) {
      const res = await listPosts(query);
      expect(res.status, query).toBe(400);
      expect(res.body.code, query).toBe("VALIDATION_ERROR");
    }
  });

  it("sorts by fields with - for descending", async () => {
    await makePosts();
    for (const [title, views] of [["aa", 5], ["bb", 1], ["cc", 3]] as const) {
      expect((await createPost({ title, views })).status).toBe(201);
    }

    const asc = await listPosts("?sort=views");
    expect(asc.body.data.items.map((i: any) => i.views)).toEqual([1, 3, 5]);

    const desc = await listPosts("?sort=-views");
    expect(desc.body.data.items.map((i: any) => i.views)).toEqual([5, 3, 1]);

    const unknown = await listPosts("?sort=nope");
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain("Unknown field");
  });

  it("filters with simple field=value params", async () => {
    await makePosts();
    expect((await createPost({ title: "pub", status: "published", views: 7, featured: true })).status).toBe(201);
    expect((await createPost({ title: "draft", views: 7, featured: false })).status).toBe(201);

    const published = await listPosts("?status=published");
    expect(published.body.data.totalItems).toBe(1);
    expect(published.body.data.items[0].title).toBe("pub");

    const views = await listPosts("?views=7");
    expect(views.body.data.totalItems).toBe(2);

    const featured = await listPosts("?featured=true");
    expect(featured.body.data.totalItems).toBe(1);
    expect(featured.body.data.items[0].title).toBe("pub");

    const unknownField = await listPosts("?nope=1");
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error).toContain("Unknown field");

    const badNumber = await listPosts("?views=lots");
    expect(badNumber.status).toBe(400);

    const badBool = await listPosts("?featured=maybe");
    expect(badBool.status).toBe(400);

    const jsonField = await listPosts("?meta=anything");
    expect(jsonField.status).toBe(400);
    expect(jsonField.body.error).toContain("cannot be filtered");
  });

  it("normalizes date filters so short ISO dates match stored values", async () => {
    await makePosts();
    expect((await createPost({ title: "dated", publishAt: "1990-01-01" })).status).toBe(201);
    const filtered = await listPosts("?publishAt=1990-01-01");
    expect(filtered.body.data.totalItems).toBe(1);
  });

  it("lets anonymous callers use every action on an open collection", async () => {
    await makePosts();
    const created = await createPost({ title: "anon made this" });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await getPost(id)).status).toBe(200);
    expect((await listPosts()).status).toBe(200);
    expect((await patchPost(id, { title: "anon patched" })).status).toBe(200);
    expect((await deletePost(id)).status).toBe(200);
  });
});

describe("records auth collections", () => {
  it("hashes passwords on create and never returns them", async () => {
    // users is a seeded auth collection whose rules are all null (locked), so
    // superusers reach it through the bypass
    const res = await superApi(ctx, "POST", "/api/collections/users/records", {
      body: { email: "new@example.com", password: "secret-password" },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe("new@example.com");
    expect(res.body.data).not.toHaveProperty("password");

    const stored = await ctx.db
      .prepare(`SELECT password FROM users WHERE id = ?1`)
      .bind(res.body.data.id)
      .first<{ password: string }>();
    expect(stored?.password.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword(stored!.password, "secret-password")).toBe(true);
  });

  it("rehashes passwords on update", async () => {
    const created = await superApi(ctx, "POST", "/api/collections/users/records", {
      body: { email: "rehash@example.com", password: "first-password" },
    });
    const id = created.body.data.id;
    const patched = await superApi(ctx, "PATCH", `/api/collections/users/records/${id}`, {
      body: { password: "second-password" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data).not.toHaveProperty("password");

    const stored = await ctx.db
      .prepare(`SELECT password FROM users WHERE id = ?1`)
      .bind(id)
      .first<{ password: string }>();
    expect(await verifyPassword(stored!.password, "second-password")).toBe(true);
    expect(await verifyPassword(stored!.password, "first-password")).toBe(false);
  });
});

describe("records rules: locked (null) vs open (empty)", () => {
  it("requires superuser for every action on a locked collection", async () => {
    await makePosts({
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
    });
    const id = await insertPost({ title: "locked row" });

    const attempts = await Promise.all([
      listPosts(),
      listPosts("", ctx.userToken),
      getPost(id),
      getPost(id, ctx.userToken),
      createPost({ title: "nope" }),
      createPost({ title: "nope" }, ctx.userToken),
      patchPost(id, { title: "nope" }),
      patchPost(id, { title: "nope" }, ctx.userToken),
      deletePost(id),
      deletePost(id, ctx.userToken),
    ]);
    for (const res of attempts) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(res.body.error).toBe("Superuser access required");
    }

    // superusers bypass locked rules entirely
    expect((await listPosts("", ctx.superToken)).status).toBe(200);
    expect((await getPost(id, ctx.superToken)).status).toBe(200);
    const created = await createPost({ title: "super row" }, ctx.superToken);
    expect(created.status).toBe(201);
    expect((await patchPost(id, { title: "super patch" }, ctx.superToken)).status).toBe(200);
    expect((await deletePost(id, ctx.superToken)).status).toBe(200);
  });

  it("rejects locked rules before looking at the body", async () => {
    await makePosts({ createRule: null, updateRule: null });
    const create = await api(ctx, "POST", BASE_URL, { rawBody: "not json" });
    expect(create.status).toBe(403);
    const patch = await api(ctx, "PATCH", `${BASE_URL}/some-id`, { rawBody: "not json" });
    expect(patch.status).toBe(403);
  });

  it("blocks writes to the _collections metadata table even for superusers", async () => {
    // _collections normally has no metadata row of its own (migrations only
    // seed _superusers/_sessions), so seed one to exercise the guard
    await ctx.db
      .prepare(
        `INSERT INTO _collections (id, name, system, type, fields, indexes, options)
         VALUES ('_collections', '_collections', 0, 'base', '[]', '[]', '{}')`,
      )
      .run();

    const res = await superApi(ctx, "POST", "/api/collections/_collections/records", {
      body: { name: "x" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
    expect(res.body.error).toContain("Collection metadata");
  });

  it("rejects writes on view collections but keeps reads available", async () => {
    const posts = await makePosts();
    await ctx.db
      .prepare(`UPDATE _collections SET type = 'view' WHERE id = ?1`)
      .bind(posts.id)
      .run();

    const write = await createPost({ title: "nope" });
    expect(write.status).toBe(400);
    expect(write.body.error).toContain("View collections are read-only");

    const read = await listPosts();
    expect(read.status).toBe(200);
  });
});
