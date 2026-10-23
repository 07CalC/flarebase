import { beforeEach, describe, expect, it } from "vitest";
import {
  createCollection,
  updateCollectionById,
} from "../src/services/collection.service";
import { api, setupTest, superApi, type TestContext } from "./setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupTest();
});

// Fixture: teams -> members (self-relation manager) -> posts.
// members.manager is added after create because a self-relation needs the
// collection's own generated id.
interface Fixture {
  teamsId: string;
  membersId: string;
  postsId: string;
}

async function makeFixture(): Promise<Fixture> {
  const teams = await createCollection(ctx.db, {
    name: "teams",
    fields: [{ name: "name", type: "text" }],
  });
  const members = await createCollection(ctx.db, {
    name: "members",
    fields: [
      { name: "name", type: "text" },
      { name: "team", type: "relation", collectionId: teams.id },
    ],
  });
  await updateCollectionById(ctx.db, members.id, {
    fields: [
      { name: "name", type: "text" },
      { name: "team", type: "relation", collectionId: teams.id },
      { name: "manager", type: "relation", collectionId: members.id },
    ],
  });
  const posts = await createCollection(ctx.db, {
    name: "posts",
    fields: [
      { name: "title", type: "text" },
      { name: "author", type: "relation", collectionId: members.id },
      { name: "editor", type: "relation", collectionId: members.id },
    ],
  });
  return { teamsId: teams.id, membersId: members.id, postsId: posts.id };
}

// t1 Blue (m1 Alice, m2 Bob), t2 Red (m3 Carol, m2 Bob manager m3).
// Posts: p1 Alice, p2 Bob, p3 dangling author, p4 no author.
async function seedWorld(): Promise<void> {
  await ctx.db
    .prepare(`INSERT INTO teams (id, name) VALUES ('t1', 'Blue'), ('t2', 'Red')`)
    .run();
  await ctx.db
    .prepare(
      `INSERT INTO members (id, name, team, manager) VALUES
       ('m1', 'Alice', 't1', NULL),
       ('m2', 'Bob', 't2', 'm3'),
       ('m3', 'Carol', 't2', NULL),
       ('m4', 'Dave', 't1', NULL)`,
    )
    .run();
  await ctx.db
    .prepare(
      `INSERT INTO posts (id, title, author, editor) VALUES
       ('p1', 'hello', 'm1', 'm1'),
       ('p2', 'world', 'm2', 'm1'),
       ('p3', 'orphan', 'missing', NULL),
       ('p4', 'anon', NULL, NULL)`,
    )
    .run();
}

async function patchCollection(
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return superApi(ctx, "PATCH", `/api/collections/${name}`, { body });
}

async function storedRules(
  collectionName: string,
): Promise<Record<string, any>> {
  const row = await ctx.db
    .prepare(`SELECT compiledRules FROM _collections WHERE name = ?1`)
    .bind(collectionName)
    .first<{ compiledRules: string }>();
  if (!row) throw new Error(`collection "${collectionName}" not found`);
  return JSON.parse(row.compiledRules) as Record<string, any>;
}

function ids(res: { body: any }): string[] {
  return (res.body.data.items as Array<{ id: string }>)
    .map((item) => item.id)
    .sort();
}

const LIST = "/api/collections/posts/records";

describe("relation traversal: reads", () => {
  it("filters list rows through a single relation hop", async () => {
    await makeFixture();
    await seedWorld();
    const patch = await patchCollection("posts", {
      listRule: 'author.name = "Alice"',
    });
    expect(patch.status).toBe(200);

    const res = await api(ctx, "GET", LIST);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["p1"]);
  });

  it("filters through multi-hop chains", async () => {
    await makeFixture();
    await seedWorld();
    await patchCollection("posts", { listRule: 'author.team.name = "Red"' });

    // p2 (Bob in Red), p3 (dangling author -> false) and p4 (null -> false)
    const res = await api(ctx, "GET", LIST);
    expect(ids(res)).toEqual(["p2"]);
  });

  it("compares two traversals", async () => {
    await makeFixture();
    await seedWorld();
    await patchCollection("posts", { listRule: "author.name = editor.name" });

    const res = await api(ctx, "GET", LIST);
    expect(ids(res)).toEqual(["p1"]);
  });

  it("guards view/update/delete per row", async () => {
    await makeFixture();
    await seedWorld();
    await patchCollection("posts", {
      viewRule: 'author.name = "Alice"',
      updateRule: 'author.name = "Alice"',
      deleteRule: 'author.name = "Alice"',
    });

    expect((await api(ctx, "GET", `${LIST}/p1`)).status).toBe(200);
    expect((await api(ctx, "GET", `${LIST}/p2`)).status).toBe(404);
    expect((await api(ctx, "PATCH", `${LIST}/p2`, { body: { title: "x" } })).status).toBe(404);
    expect((await api(ctx, "PATCH", `${LIST}/p1`, { body: { title: "patched" } })).status).toBe(200);
    expect((await api(ctx, "DELETE", `${LIST}/p2`)).status).toBe(404);
    expect((await api(ctx, "DELETE", `${LIST}/p1`)).status).toBe(200);
  });

  it("treats dangling or empty relations as false (fail closed)", async () => {
    await makeFixture();
    await seedWorld();
    await patchCollection("posts", { listRule: 'author.name != "Alice"' });

    // "some author is not Alice": p3/p4 have no resolvable author -> excluded
    const res = await api(ctx, "GET", LIST);
    expect(ids(res)).toEqual(["p2"]);
  });

  it("checks the candidate relation on create", async () => {
    await makeFixture();
    await seedWorld();
    await patchCollection("posts", { createRule: 'author.name = "Alice"' });

    const ok = await api(ctx, "POST", LIST, {
      body: { title: "mine", author: "m1" },
    });
    expect(ok.status).toBe(201);

    const denied = await api(ctx, "POST", LIST, {
      body: { title: "nope", author: "m2" },
    });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toBe("Failed to create record");

    // omitted relation: the candidate value is null -> no row matches
    const omitted = await api(ctx, "POST", LIST, { body: { title: "nope" } });
    expect(omitted.status).toBe(400);
    expect(omitted.body.error).toBe("Failed to create record");

    // a dangling id never reaches the rule: relation validation rejects it
    const dangling = await api(ctx, "POST", LIST, {
      body: { title: "nope", author: "missing" },
    });
    expect(dangling.status).toBe(400);
    expect(dangling.body.error).toContain("does not exist");
  });

  it("stores referenced collection ids with the artifact", async () => {
    const fx = await makeFixture();
    await patchCollection("posts", { listRule: 'author.name = "Alice"' });
    const rules = await storedRules("posts");
    expect(rules.listRule.collections).toEqual([fx.membersId]);
  });
});

describe("@collection.* back-relations", () => {
  it("selects the records a relation points back to", async () => {
    await makeFixture();
    await seedWorld();
    const patch = await patchCollection("members", {
      listRule: "@collection.posts.author = id",
    });
    expect(patch.status).toBe(200);

    // m1 <- p1, m2 <- p2; m3/m4 have no posts
    const res = await api(ctx, "GET", "/api/collections/members/records");
    expect(ids(res)).toEqual(["m1", "m2"]);
  });

  it("composes with LIKE and other conditions", async () => {
    await makeFixture();
    await seedWorld();
    await patchCollection("members", {
      listRule: '@collection.posts.title ~ "ello" && name = "Alice"',
    });

    const res = await api(ctx, "GET", "/api/collections/members/records");
    expect(ids(res)).toEqual(["m1"]);
  });
});

describe("cross-collection invalidation", () => {
  it("recompiles dependent artifacts when a referenced collection is renamed", async () => {
    const fx = await makeFixture();
    await seedWorld();
    await patchCollection("posts", {
      listRule: 'author.team.name = "Red"',
    });

    const rename = await patchCollection("teams", { name: "squads" });
    expect(rename.status).toBe(200);

    const rules = await storedRules("posts");
    expect(rules.listRule.sql).toContain('"squads"');
    expect(rules.listRule.sql).not.toContain('"teams"');
    expect(rules.listRule.collections).toEqual(
      expect.arrayContaining([fx.teamsId, fx.membersId]),
    );

    // enforcement still resolves after the rename
    const res = await api(ctx, "GET", LIST);
    expect(ids(res)).toEqual(["p2"]);
  });

  it("rejects renaming a collection referenced by name-based @collection.*", async () => {
    await makeFixture();
    await seedWorld();
    await patchCollection("members", {
      listRule: "@collection.posts.author = id",
    });

    const rename = await patchCollection("posts", { name: "articles" });
    expect(rename.status).toBe(400);
    expect(rename.body.code).toBe("VALIDATION_ERROR");
    expect(rename.body.error).toContain('rules of collection "members"');
    expect(rename.body.error).toContain('unknown collection "posts"');

    // the collection keeps its name; clear the rule, rename, re-add it
    expect((await superApi(ctx, "GET", "/api/collections/posts")).status).toBe(200);
    await patchCollection("members", { listRule: "" });
    expect((await patchCollection("posts", { name: "articles" })).status).toBe(200);
    const readd = await patchCollection("members", {
      listRule: "@collection.articles.author = id",
    });
    expect(readd.status).toBe(200);
    expect((await storedRules("members")).listRule.sql).toContain('"articles"');
  });

  it("rejects field removals that break dependent rules", async () => {
    const fx = await makeFixture();
    await patchCollection("posts", { listRule: 'author.team.name = "Red"' });

    const removal = await patchCollection("members", {
      fields: [
        { name: "name", type: "text" },
        { name: "manager", type: "relation", collectionId: fx.membersId },
      ],
    });
    expect(removal.status).toBe(400);
    expect(removal.body.code).toBe("VALIDATION_ERROR");
    expect(removal.body.error).toContain(
      'rules of collection "posts" no longer compile',
    );
    expect(removal.body.error).toContain(
      'unknown field "team" on collection "members"',
    );

    // the pending change was not applied
    const lookup = await superApi(ctx, "GET", "/api/collections/members");
    expect(lookup.body.data.fields.map((f: any) => f.name)).toEqual([
      "name",
      "team",
      "manager",
    ]);
  });

  it("recompiles dependents on field additions and keeps enforcement", async () => {
    const fx = await makeFixture();
    await seedWorld();
    await patchCollection("posts", { listRule: 'author.team.name = "Red"' });

    const add = await patchCollection("members", {
      fields: [
        { name: "name", type: "text" },
        { name: "team", type: "relation", collectionId: fx.teamsId },
        { name: "manager", type: "relation", collectionId: fx.membersId },
        { name: "nickname", type: "text" },
      ],
    });
    expect(add.status).toBe(200);

    const res = await api(ctx, "GET", LIST);
    expect(ids(res)).toEqual(["p2"]);
  });

  it("rejects deleting a referenced collection", async () => {
    await makeFixture();
    await patchCollection("posts", { listRule: 'author.team.name = "Red"' });

    const del = await superApi(ctx, "DELETE", "/api/collections/teams");
    expect(del.status).toBe(400);
    expect(del.body.code).toBe("VALIDATION_ERROR");
    expect(del.body.error).toContain('Cannot delete collection "teams"');
    expect(del.body.error).toContain('"posts"');

    await patchCollection("posts", { listRule: "" });
    const retry = await superApi(ctx, "DELETE", "/api/collections/teams");
    expect(retry.status).toBe(200);
  });

  it("rejects deleting a collection referenced through a chain", async () => {
    await makeFixture();
    await patchCollection("posts", { listRule: 'author.team.name = "Red"' });

    const del = await superApi(ctx, "DELETE", "/api/collections/members");
    expect(del.status).toBe(400);
    expect(del.body.error).toContain('"posts"');
  });
});
