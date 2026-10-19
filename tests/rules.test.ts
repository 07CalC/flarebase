import { beforeEach, describe, expect, it } from "vitest";
import { createCollection } from "../src/services/collection.service";
import type { Collection } from "../src/services/collection.service";
import type { CollectionFieldInput } from "../src/lib/collection";
import { api, setupTest, superApi, type TestContext } from "./setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

// Enforcement matrix per API_RULES.md §2: every action ×
// (superuser / authed matched / authed denied / anonymous).

const BASE = "/api/collections/articles/records";

const ARTICLE_FIELDS: CollectionFieldInput[] = [
  { name: "title", type: "text", required: true },
  { name: "owner", type: "text", required: true },
  { name: "status", type: "text", default: "draft" },
  { name: "publishAt", type: "date" },
];

interface ArticleRules {
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
}

// default fixture: every action scoped to the caller's own rows
async function makeArticles(
  rules: Partial<ArticleRules> = {},
): Promise<Collection> {
  return createCollection(ctx.db, {
    name: "articles",
    fields: ARTICLE_FIELDS,
    listRule: "owner = @request.auth.id",
    viewRule: "owner = @request.auth.id",
    createRule: "@request.body.owner = @request.auth.id",
    updateRule: "owner = @request.auth.id",
    deleteRule: "owner = @request.auth.id",
    ...rules,
  });
}

async function seedArticle(owner: string, title = "article"): Promise<string> {
  const id = `a${Math.random().toString(16).slice(2, 12)}`;
  await ctx.db
    .prepare(`INSERT INTO "articles" (id, title, owner) VALUES (?1, ?2, ?3)`)
    .bind(id, title, owner)
    .run();
  return id;
}

async function articleCount(): Promise<number> {
  const row = await ctx.db
    .prepare(`SELECT COUNT(*) AS count FROM articles`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("rule enforcement: list", () => {
  it("superuser bypasses the rule and sees every row", async () => {
    await makeArticles();
    await seedArticle("u1", "mine");
    await seedArticle("u2", "theirs");
    const res = await api(ctx, "GET", BASE, { token: ctx.superToken });
    expect(res.status).toBe(200);
    expect(res.body.data.totalItems).toBe(2);
  });

  it("matched authenticated user sees only their rows (200 partial)", async () => {
    await makeArticles();
    await seedArticle("u1", "mine");
    await seedArticle("u2", "theirs");
    const res = await api(ctx, "GET", BASE, { token: ctx.userToken });
    expect(res.status).toBe(200);
    expect(res.body.data.totalItems).toBe(1);
    expect(res.body.data.items[0].title).toBe("mine");
  });

  it("denied authenticated user gets an empty 200, not 403", async () => {
    await makeArticles();
    await seedArticle("u2", "theirs");
    const res = await api(ctx, "GET", BASE, { token: ctx.userToken });
    expect(res.status).toBe(200);
    expect(res.body.data.totalItems).toBe(0);
    expect(res.body.data.totalPages).toBe(0);
  });

  it("anonymous gets an empty 200 (NULL predicate filters, no leak)", async () => {
    await makeArticles();
    await seedArticle("u1", "mine");
    const res = await api(ctx, "GET", BASE);
    expect(res.status).toBe(200);
    expect(res.body.data.totalItems).toBe(0);
  });

  it("supports the authenticated-only idiom @request.auth.id != ''", async () => {
    await makeArticles({ listRule: '@request.auth.id != ""' });
    await seedArticle("u1", "mine");
    await seedArticle("u2", "theirs");

    const anon = await api(ctx, "GET", BASE);
    expect(anon.status).toBe(200);
    expect(anon.body.data.totalItems).toBe(0);

    const authed = await api(ctx, "GET", BASE, { token: ctx.userToken });
    expect(authed.status).toBe(200);
    expect(authed.body.data.totalItems).toBe(2);
  });

  it("evaluates a false rule instead of locking it (no 403)", async () => {
    await makeArticles({ listRule: "false", viewRule: "false" });
    await seedArticle("u1", "mine");

    const list = await api(ctx, "GET", BASE, { token: ctx.userToken });
    expect(list.status).toBe(200);
    expect(list.body.data.totalItems).toBe(0);

    const view = await api(ctx, "GET", `${BASE}/${await seedArticle("u1")}`, {
      token: ctx.userToken,
    });
    expect(view.status).toBe(404);
  });
});

describe("rule enforcement: view", () => {
  async function fixture() {
    await makeArticles();
    return seedArticle("u1", "mine");
  }

  it("superuser reads any row", async () => {
    const id = await fixture();
    await seedArticle("u2", "theirs");
    expect((await api(ctx, "GET", `${BASE}/${id}`, { token: ctx.superToken })).status).toBe(200);
    const other = await seedArticle("u2", "other");
    expect((await api(ctx, "GET", `${BASE}/${other}`, { token: ctx.superToken })).body.data.title).toBe("other");
  });

  it("matched authenticated user reads their row", async () => {
    const id = await fixture();
    const res = await api(ctx, "GET", `${BASE}/${id}`, { token: ctx.userToken });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("mine");
  });

  it("denied authenticated user gets 404 (no existence oracle)", async () => {
    await makeArticles();
    const other = await seedArticle("u2", "theirs");
    const res = await api(ctx, "GET", `${BASE}/${other}`, { token: ctx.userToken });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("anonymous gets 404", async () => {
    const id = await fixture();
    const res = await api(ctx, "GET", `${BASE}/${id}`);
    expect(res.status).toBe(404);
  });
});

describe("rule enforcement: create", () => {
  it("superuser bypasses the create rule", async () => {
    await makeArticles();
    const res = await api(ctx, "POST", BASE, {
      token: ctx.superToken,
      body: { title: "super", owner: "someone-else" },
    });
    expect(res.status).toBe(201);
  });

  it("matched authenticated user creates their own row", async () => {
    await makeArticles();
    const res = await api(ctx, "POST", BASE, {
      token: ctx.userToken,
      body: { title: "mine", owner: "u1" },
    });
    expect(res.status).toBe(201);
    expect(await articleCount()).toBe(1);
  });

  it("denied authenticated user gets a generic 400 and nothing is inserted", async () => {
    await makeArticles();
    const res = await api(ctx, "POST", BASE, {
      token: ctx.userToken,
      body: { title: "not mine", owner: "u2" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.error).toBe("Failed to create record");
    expect(await articleCount()).toBe(0);
  });

  it("anonymous gets a generic 400 (NULL predicate)", async () => {
    await makeArticles();
    const res = await api(ctx, "POST", BASE, {
      body: { title: "anon", owner: "u1" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Failed to create record");
    expect(await articleCount()).toBe(0);
  });
});

describe("rule enforcement: update", () => {
  it("superuser updates any row", async () => {
    await makeArticles();
    const other = await seedArticle("u2", "theirs");
    const res = await api(ctx, "PATCH", `${BASE}/${other}`, {
      token: ctx.superToken,
      body: { title: "super patched" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("super patched");
  });

  it("matched authenticated user updates their row", async () => {
    await makeArticles();
    const id = await seedArticle("u1", "mine");
    const res = await api(ctx, "PATCH", `${BASE}/${id}`, {
      token: ctx.userToken,
      body: { title: "patched" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("patched");
  });

  it("denied authenticated user gets 404 and the row is untouched", async () => {
    await makeArticles();
    const other = await seedArticle("u2", "theirs");
    const res = await api(ctx, "PATCH", `${BASE}/${other}`, {
      token: ctx.userToken,
      body: { title: "hijacked" },
    });
    expect(res.status).toBe(404);
    const row = await ctx.db
      .prepare(`SELECT title FROM articles WHERE id = ?1`)
      .bind(other)
      .first<{ title: string }>();
    expect(row?.title).toBe("theirs");
  });

  it("anonymous gets 404", async () => {
    await makeArticles();
    const id = await seedArticle("u1", "mine");
    const res = await api(ctx, "PATCH", `${BASE}/${id}`, { body: { title: "x" } });
    expect(res.status).toBe(404);
  });

  it(":changed = false blocks status updates but allows other fields", async () => {
    await makeArticles({ updateRule: "@request.body.status:changed = false" });
    const id = await seedArticle("u1", "mine");

    const changed = await api(ctx, "PATCH", `${BASE}/${id}`, {
      token: ctx.userToken,
      body: { status: "published" },
    });
    expect(changed.status).toBe(404);

    const same = await api(ctx, "PATCH", `${BASE}/${id}`, {
      token: ctx.userToken,
      body: { status: "draft" },
    });
    expect(same.status).toBe(200);

    const other = await api(ctx, "PATCH", `${BASE}/${id}`, {
      token: ctx.userToken,
      body: { title: "renamed" },
    });
    expect(other.status).toBe(200);
  });
});

describe("rule enforcement: delete", () => {
  it("superuser deletes any row", async () => {
    await makeArticles();
    const other = await seedArticle("u2", "theirs");
    const res = await api(ctx, "DELETE", `${BASE}/${other}`, { token: ctx.superToken });
    expect(res.status).toBe(200);
    expect(await articleCount()).toBe(0);
  });

  it("matched authenticated user deletes their row", async () => {
    await makeArticles();
    const id = await seedArticle("u1", "mine");
    const res = await api(ctx, "DELETE", `${BASE}/${id}`, { token: ctx.userToken });
    expect(res.status).toBe(200);
    expect(await articleCount()).toBe(0);
  });

  it("denied authenticated user gets 404 and the row survives", async () => {
    await makeArticles();
    const other = await seedArticle("u2", "theirs");
    const res = await api(ctx, "DELETE", `${BASE}/${other}`, { token: ctx.userToken });
    expect(res.status).toBe(404);
    expect(await articleCount()).toBe(1);
  });

  it("anonymous gets 404", async () => {
    await makeArticles();
    const id = await seedArticle("u1", "mine");
    const res = await api(ctx, "DELETE", `${BASE}/${id}`);
    expect(res.status).toBe(404);
    expect(await articleCount()).toBe(1);
  });
});

describe("rule enforcement: @now and :isset", () => {
  it("@now rejects past dates and accepts future ones", async () => {
    await makeArticles({ createRule: "@request.body.publishAt >= @now" });

    const future = new Date(Date.now() + 60_000).toISOString();
    const ok = await api(ctx, "POST", BASE, {
      token: ctx.userToken,
      body: { title: "scheduled", owner: "u1", publishAt: future },
    });
    expect(ok.status).toBe(201);

    const past = await api(ctx, "POST", BASE, {
      token: ctx.userToken,
      body: { title: "late", owner: "u1", publishAt: "1990-01-01" },
    });
    expect(past.status).toBe(400);
    expect(past.body.error).toBe("Failed to create record");
  });

  it(":isset = false forbids submitting the field on create", async () => {
    await makeArticles({ createRule: "@request.body.status:isset = false" });

    const omitted = await api(ctx, "POST", BASE, {
      token: ctx.userToken,
      body: { title: "no status", owner: "u1" },
    });
    expect(omitted.status).toBe(201);

    const submitted = await api(ctx, "POST", BASE, {
      token: ctx.userToken,
      body: { title: "with status", owner: "u1", status: "draft" },
    });
    expect(submitted.status).toBe(400);
  });
});

describe("rule enforcement: hardening", () => {
  it("rejects SQL injection attempts at collection save time", async () => {
    let thrown: any;
    try {
      await createCollection(ctx.db, {
        name: "evil",
        fields: [{ name: "title", type: "text" }],
        listRule: `title = "x" OR 1=1; DROP TABLE users`,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.statusCode).toBe(400);
    expect(thrown?.code).toBe("VALIDATION_ERROR");
    expect(String(thrown?.message)).toContain("listRule");

    // the collection row must not exist either
    const row = await ctx.db
      .prepare(`SELECT id FROM _collections WHERE name = 'evil'`)
      .first();
    expect(row).toBeNull();
  });

  it("fails closed when a non-empty rule has no compiled artifact", async () => {
    const articles = await makeArticles();
    // simulate corrupt metadata: rule text without the compiled artifact
    await ctx.db
      .prepare(`UPDATE _collections SET compiledRules = '{}' WHERE id = ?1`)
      .bind(articles.id)
      .run();

    const res = await api(ctx, "GET", BASE, { token: ctx.userToken });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("DATABASE_ERROR");
  });

  it("supports superuser management of _superusers through the records API", async () => {
    const list = await superApi(ctx, "GET", "/api/collections/_superusers/records");
    expect(list.status).toBe(200);
    expect(list.body.data.totalItems).toBe(1);
    expect(list.body.data.items[0]).not.toHaveProperty("password");
  });
});
