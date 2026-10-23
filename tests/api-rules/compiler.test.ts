import { describe, expect, it } from "vitest";
import {
  compileRule,
  compileRuleSet,
  formatRuleErrors,
  resolveRule,
  ruleDependencies,
} from "../../src/api-rules";
import { RuleError } from "../../src/api-rules/errors";
import type {
  RuleCollectionRef,
  RuleField,
  RuleKey,
} from "../../src/api-rules/types";

const FIELDS: RuleField[] = [
  { name: "title", type: "text" },
  { name: "views", type: "number" },
  { name: "featured", type: "bool" },
  { name: "publishedAt", type: "date" },
  { name: "status", type: "select" },
  { name: "owner", type: "relation" },
  { name: "data", type: "json" },
  { name: "upload", type: "file" },
  { name: "secretNote", type: "text", hidden: true },
];

function compile(source: string, action: Parameters<typeof compileRule>[1] = "list") {
  return compileRule(source, action, FIELDS);
}

function compileError(
  source: string,
  action: Parameters<typeof compileRule>[1] = "list",
): RuleError {
  try {
    compileRule(source, action, FIELDS);
  } catch (err) {
    if (err instanceof RuleError) return err;
    throw err;
  }
  throw new Error("expected compileRule() to throw");
}

function compileSet(rules: Partial<Record<RuleKey, string | null | undefined>>) {
  return compileRuleSet(rules, FIELDS);
}

describe("api-rules compiler: artifacts", () => {
  it("compiles a field/literal comparison (row variant)", () => {
    expect(compile('status = "draft"')).toEqual({
      sql: '("status" = ?)',
      slots: [{ kind: "literal", value: "draft" }],
    });
  });

  it("compiles auth macros and boolean composition left to right", () => {
    expect(compile('status = "draft" && owner = @request.auth.id')).toEqual({
      sql: '(("status" = ?) AND ("owner" = ?))',
      slots: [
        { kind: "literal", value: "draft" },
        { kind: "auth", path: "id" },
      ],
    });
  });

  it("compiles ! and ||", () => {
    expect(compile("!(views > 5 || featured = true)")).toEqual({
      sql: '(NOT (("views" > ?) OR ("featured" = 1)))',
      slots: [{ kind: "literal", value: 5 }],
    });
  });

  it("compiles field refs to record slots in create rules", () => {
    expect(compile("owner = @request.auth.id", "create")).toEqual({
      sql: "(? = ?)",
      slots: [
        { kind: "record", path: "owner" },
        { kind: "auth", path: "id" },
      ],
    });
    expect(compile("views > 10", "create")).toEqual({
      sql: "(? > ?)",
      slots: [
        { kind: "record", path: "views" },
        { kind: "literal", value: 10 },
      ],
    });
  });

  it("folds booleans to SQL constants without binding", () => {
    expect(compile("featured = true")).toEqual({
      sql: '("featured" = 1)',
      slots: [],
    });
    expect(compile("featured != false")).toEqual({
      sql: '("featured" != 0)',
      slots: [],
    });
  });

  it("special-cases null equality", () => {
    expect(compile("title = null")).toEqual({
      sql: '("title" IS NULL)',
      slots: [],
    });
    expect(compile("null != title")).toEqual({
      sql: '("title" IS NOT NULL)',
      slots: [],
    });
    expect(compile("null = null")).toEqual({ sql: "(1)", slots: [] });
    expect(compile("null != null")).toEqual({ sql: "(0)", slots: [] });
  });

  it("wraps LIKE patterns only when they lack %", () => {
    expect(compile('title ~ "lorem"')).toEqual({
      sql: '("title" LIKE ?)',
      slots: [{ kind: "literal", value: "%lorem%" }],
    });
    expect(compile('title ~ "Lorem%"')).toEqual({
      sql: '("title" LIKE ?)',
      slots: [{ kind: "literal", value: "Lorem%" }],
    });
    expect(compile('title !~ "x"')).toEqual({
      sql: '("title" NOT LIKE ?)',
      slots: [{ kind: "literal", value: "%x%" }],
    });
  });

  it("compiles @now against date operands and implicit fields", () => {
    expect(compile("publishedAt < @now")).toEqual({
      sql: '("publishedAt" < ?)',
      slots: [{ kind: "now" }],
    });
    expect(compile("createdAt > @now", "delete")).toEqual({
      sql: '("createdAt" > ?)',
      slots: [{ kind: "now" }],
    });
  });

  it("compiles @request.body macros in create/update", () => {
    expect(compile('@request.body.status != "archived"', "update")).toEqual({
      sql: "(? != ?)",
      slots: [
        { kind: "body", path: "status" },
        { kind: "literal", value: "archived" },
      ],
    });
  });

  it("compiles :isset", () => {
    expect(compile("@request.auth.id:isset")).toEqual({
      sql: "(?)",
      slots: [{ kind: "isset", source: "auth", path: "id" }],
    });
    expect(compile("@request.body.title:isset = false", "create")).toEqual({
      sql: "((?) = 0)",
      slots: [{ kind: "isset", source: "body", path: "title" }],
    });
  });

  it("compiles :changed to the NULL-safe expansion", () => {
    expect(compile("@request.body.status:changed = false", "update")).toEqual({
      sql: '((? AND ("status" IS NOT ?)) = 0)',
      slots: [
        { kind: "isset", source: "body", path: "status" },
        { kind: "body", path: "status" },
      ],
    });
    expect(compile("@request.body.status:changed", "update")).toEqual({
      sql: '(? AND ("status" IS NOT ?))',
      slots: [
        { kind: "isset", source: "body", path: "status" },
        { kind: "body", path: "status" },
      ],
    });
  });

  it("allows hidden fields in record refs", () => {
    expect(compile('secretNote = "x"')).toEqual({
      sql: '("secretNote" = ?)',
      slots: [{ kind: "literal", value: "x" }],
    });
  });

  it("is deterministic", () => {
    const rules = {
      listRule: 'title ~ "x" && views > 5',
      viewRule: "@request.auth.id != \"\"",
      createRule: "owner = @request.auth.id",
      updateRule: "@request.body.title:changed = false",
      deleteRule: "createdAt < @now",
    };
    expect(JSON.stringify(compileSet(rules).compiled)).toBe(
      JSON.stringify(compileSet(rules).compiled),
    );
  });

  it("emits exactly one bare ? per slot, in order", () => {
    const rule = compile(
      '(title ~ "x" || @request.body.status:changed = false) && views > @request.auth.maxViews',
      "update",
    );
    expect(rule.slots).toEqual([
      { kind: "literal", value: "%x%" },
      { kind: "isset", source: "body", path: "status" },
      { kind: "body", path: "status" },
      { kind: "auth", path: "maxViews" },
    ]);
    expect(rule.sql.split("?").length - 1).toBe(rule.slots.length);
  });
});

describe("api-rules compiler: validation", () => {
  it("rejects unknown fields", () => {
    expect(compileError("ownr = 1").message).toBe('unknown field "ownr"');
  });

  it("rejects password paths everywhere", () => {
    const message = 'field "password" cannot be used in rules';
    expect(compileError('password = "x"').message).toBe(message);
    expect(compileError("@request.auth.password:isset").message).toBe(message);
    expect(
      compileError("@request.body.password:isset", "create").message,
    ).toBe(message);
  });

  it("rejects json/file fields", () => {
    expect(compileError('data = "x"').message).toBe(
      'field "data" has type "json", which is not supported in rules yet',
    );
    expect(compileError("@request.body.upload = \"x\"", "update").message).toBe(
      'field "upload" has type "file", which is not supported in rules yet',
    );
    // presence checks on unsupported field types stay rejected too
    expect(compileError("@request.body.data:isset", "update").message).toBe(
      'field "data" has type "json", which is not supported in rules yet',
    );
  });

  it("rejects hidden @request.body fields", () => {
    expect(compileError('@request.body.secretNote = "x"', "update").message).toBe(
      'field "secretNote" is hidden and cannot be used in @request.body',
    );
  });

  it("rejects @request.body outside create/update", () => {
    expect(compileError('@request.body.title = "x"', "list").message).toBe(
      "@request.body is not available in list rules",
    );
    expect(compileError('@request.body.title:isset', "delete").message).toBe(
      "@request.body is not available in delete rules",
    );
  });

  it("rejects :changed outside the update rule or on auth fields", () => {
    expect(
      compileError("@request.body.status:changed", "create").message,
    ).toBe(":changed is only available in the update rule; use :isset");
    expect(
      compileError("@request.auth.status:changed", "update").message,
    ).toBe(":changed is only available on @request.body fields");
  });

  it("rejects reserved and unknown modifiers", () => {
    expect(
      compileError('@request.body.title:length = "x"', "update").message,
    ).toBe(":length is not supported yet");
    expect(
      compileError('@request.body.title:foo = "x"', "update").message,
    ).toBe('unknown modifier ":foo"');
  });

  it("rejects class mismatches without coercion", () => {
    expect(compileError('views > "5"').message).toBe(
      'cannot compare number field "views" with string literal using ">"',
    );
    expect(compileError("title = 5").message).toBe(
      'cannot compare text field "title" with number literal using "="',
    );
    expect(compileError("featured > false").message).toBe(
      'cannot compare bool field "featured" with boolean literal using ">"',
    );
    expect(compileError('views ~ "5"').message).toBe(
      '"~" requires text operands, got number field "views" and string literal',
    );
    expect(compileError("title < @now").message).toBe(
      'cannot compare text field "title" with @now (datetime) using "<"',
    );
    expect(
      compileError('@request.body.views > "5"', "update").message,
    ).toBe(
      'cannot compare @request.body.views (number) with string literal using ">"',
    );
  });

  it("allows dynamic comparisons against @request.auth.*", () => {
    expect(compile("views = @request.auth.maxViews")).toEqual({
      sql: '("views" = ?)',
      slots: [{ kind: "auth", path: "maxViews" }],
    });
    expect(compile('@request.auth.note ~ "x"')).toEqual({
      sql: "(? LIKE ?)",
      slots: [
        { kind: "auth", path: "note" },
        { kind: "literal", value: "%x%" },
      ],
    });
  });

  it("rejects null outside = and !=", () => {
    expect(compileError("title > null").message).toBe(
      'null can only be compared with "=" or "!="',
    );
  });

  it("rejects reserved macros with specific messages", () => {
    expect(compileError('@request.query.x = "1"').message).toBe(
      "@request.query is not supported yet",
    );
    expect(compileError("@todayStart > createdAt").message).toBe(
      "@todayStart is not supported yet (only @now is available)",
    );
    expect(compileError("@foo = 1").message).toBe('unknown macro "@foo"');
  });

  it("rejects malformed macro paths", () => {
    expect(compileError("@request = 1").message).toBe(
      '@request requires ".auth" or ".body", e.g. "@request.auth.id"',
    );
    expect(compileError("@request.auth = 1").message).toBe(
      '@request.auth requires a field, e.g. "@request.auth.id"',
    );
    expect(compileError("@request.auth.a.b = 1").message).toBe(
      "@request.auth paths cannot be nested",
    );
  });
});

describe("api-rules compiler: rule sets", () => {
  it("compiles all five rules and skips locked ones", () => {
    const { compiled, errors } = compileSet({
      listRule: 'title ~ "x"',
      viewRule: '@request.auth.id != ""',
      createRule: "owner = @request.auth.id",
      updateRule: "@request.body.title:changed = false",
      deleteRule: null,
    });
    expect(errors).toEqual([]);
    expect(Object.keys(compiled)).toEqual([
      "listRule",
      "viewRule",
      "createRule",
      "updateRule",
    ]);
    expect(compiled.deleteRule).toBeUndefined();
  });

  it("compiles the open/closed constants", () => {
    expect(compileSet({ listRule: "" }).compiled).toEqual({
      listRule: { sql: "1", slots: [] },
    });
    expect(compileSet({ listRule: "true" }).compiled).toEqual({
      listRule: { sql: "1", slots: [] },
    });
    expect(compileSet({ listRule: "false" }).compiled).toEqual({
      listRule: { sql: "0", slots: [] },
    });
  });

  it("aggregates all violations with rule names and positions", () => {
    const { compiled, errors } = compileSet({
      listRule: "ownr = 1",
      viewRule: 'views > "5"',
    });
    expect(compiled).toEqual({});
    expect(errors).toEqual([
      { rule: "listRule", message: 'unknown field "ownr"', line: 1, column: 1 },
      {
        rule: "viewRule",
        message: 'cannot compare number field "views" with string literal using ">"',
        line: 1,
        column: 1,
      },
    ]);
    expect(formatRuleErrors(errors)).toBe(
      'listRule: unknown field "ownr" (line 1, column 1); ' +
        'viewRule: cannot compare number field "views" with string literal using ">" (line 1, column 1)',
    );
  });

  it("rejects whitespace-only and comment-only rules", () => {
    const whitespace = compileSet({ listRule: "   " });
    expect(whitespace.compiled.listRule).toBeUndefined();
    expect(whitespace.errors[0].message).toContain("whitespace-only");

    const comment = compileSet({ listRule: "// only a comment" });
    expect(comment.errors).toEqual([
      {
        rule: "listRule",
        message: "expected an operand, found end of rule",
        line: 1,
        column: 18,
      },
    ]);
  });
});

describe("api-rules compiler: relation traversal and @collection.*", () => {
  const USERS: RuleCollectionRef = {
    id: "col_users",
    name: "users",
    fields: [
      { name: "name", type: "text" },
      { name: "role", type: "select" },
      { name: "views", type: "number" },
      { name: "bornAt", type: "date" },
      { name: "manager", type: "relation", collectionId: "col_users" },
      { name: "data", type: "json" },
      { name: "password", type: "text" },
    ],
  };
  const POSTS: RuleCollectionRef = {
    id: "col_posts",
    name: "posts",
    fields: [
      { name: "title", type: "text" },
      { name: "views", type: "number" },
      { name: "author", type: "relation", collectionId: "col_users" },
      { name: "editor", type: "relation", collectionId: "col_users" },
      { name: "legacy", type: "relation" },
    ],
  };
  const COLLECTIONS = [USERS, POSTS];
  const resolveCollection = (idOrName: string) =>
    COLLECTIONS.find((c) => c.id === idOrName || c.name === idOrName) ?? null;
  const OPTIONS = {
    sourceCollectionName: "posts",
    resolveCollection,
  };

  function compileTraversal(
    source: string,
    action: Parameters<typeof compileRule>[1] = "list",
  ) {
    return compileRule(source, action, POSTS.fields, OPTIONS);
  }

  function compileUsers(
    source: string,
    action: Parameters<typeof compileRule>[1] = "list",
  ) {
    return compileRule(source, action, USERS.fields, {
      sourceCollectionName: "users",
      resolveCollection,
    });
  }

  function compileTraversalError(
    source: string,
    action: Parameters<typeof compileRule>[1] = "list",
  ): RuleError {
    try {
      compileTraversal(source, action);
    } catch (err) {
      if (err instanceof RuleError) return err;
      throw err;
    }
    throw new Error("expected compileRule() to throw");
  }

  function compileUsersError(
    source: string,
    action: Parameters<typeof compileRule>[1] = "list",
  ): RuleError {
    try {
      compileUsers(source, action);
    } catch (err) {
      if (err instanceof RuleError) return err;
      throw err;
    }
    throw new Error("expected compileRule() to throw");
  }

  it("compiles a single-hop traversal to a correlated scalar subquery", () => {
    expect(compileTraversal('author.name = "Alice"')).toEqual({
      sql: '((SELECT __rel0."name" FROM "users" AS __rel0 WHERE __rel0."id" = "posts"."author") = ?)',
      slots: [{ kind: "literal", value: "Alice" }],
      collections: ["col_users"],
    });
  });

  it("compiles multi-hop chains with nested subqueries", () => {
    expect(compileTraversal('author.manager.name = "Bob"')).toEqual({
      sql:
        '((SELECT (SELECT __rel1."name" FROM "users" AS __rel1 WHERE __rel1."id" = __rel0."manager")' +
        ' FROM "users" AS __rel0 WHERE __rel0."id" = "posts"."author") = ?)',
      slots: [{ kind: "literal", value: "Bob" }],
      collections: ["col_users"],
    });
  });

  it("compiles comparison between a traversal and another traversal", () => {
    expect(compileTraversal("author.name = editor.name")).toEqual({
      sql:
        '((SELECT __rel0."name" FROM "users" AS __rel0 WHERE __rel0."id" = "posts"."author")' +
        ' = (SELECT __rel1."name" FROM "users" AS __rel1 WHERE __rel1."id" = "posts"."editor"))',
      slots: [],
      collections: ["col_users"],
    });
  });

  it("compiles create traversals against the candidate relation value", () => {
    expect(compileTraversal('author.name = "Alice"', "create")).toEqual({
      sql: '((SELECT __rel0."name" FROM "users" AS __rel0 WHERE __rel0."id" = ?) = ?)',
      slots: [
        { kind: "record", path: "author" },
        { kind: "literal", value: "Alice" },
      ],
      collections: ["col_users"],
    });
  });

  it("supports LIKE and @now against traversed text/date fields", () => {
    expect(compileTraversal('author.name ~ "Ali"')).toEqual({
      sql: '((SELECT __rel0."name" FROM "users" AS __rel0 WHERE __rel0."id" = "posts"."author") LIKE ?)',
      slots: [{ kind: "literal", value: "%Ali%" }],
      collections: ["col_users"],
    });
    expect(compileTraversal("author.bornAt < @now")).toEqual({
      sql: '((SELECT __rel0."bornAt" FROM "users" AS __rel0 WHERE __rel0."id" = "posts"."author") < ?)',
      slots: [{ kind: "now" }],
      collections: ["col_users"],
    });
  });

  it("is deterministic including aliases and dependency lists", () => {
    const options = OPTIONS;
    const first = compileRule(
      'author.name = "a" || editor.name = "b"',
      "list",
      POSTS.fields,
      options,
    );
    const second = compileRule(
      'author.name = "a" || editor.name = "b"',
      "list",
      POSTS.fields,
      options,
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.collections).toEqual(["col_users"]);
    expect(first.sql).toContain("__rel1");
  });

  describe("@collection.*", () => {
    it("compiles a back-relation into an EXISTS subquery", () => {
      expect(compileUsers("@collection.posts.author = id")).toEqual({
        sql:
          '(EXISTS (SELECT 1 FROM "posts" AS __rel0 WHERE (__rel0."author" = "users"."id")))',
        slots: [],
        collections: ["col_posts"],
      });
    });

    it("keeps the SQL identical when the macro is on the right of =", () => {
      expect(compileUsers("id = @collection.posts.author")).toEqual(
        compileUsers("@collection.posts.author = id"),
      );
    });

    it("inverts ordered comparisons and qualifies outer fields", () => {
      expect(compileUsers("views > @collection.posts.views")).toEqual({
        sql:
          '(EXISTS (SELECT 1 FROM "posts" AS __rel0 WHERE (__rel0."views" < "users"."views")))',
        slots: [],
        collections: ["col_posts"],
      });
      expect(compileUsers("@collection.posts.views >= views")).toEqual({
        sql:
          '(EXISTS (SELECT 1 FROM "posts" AS __rel0 WHERE (__rel0."views" >= "users"."views")))',
        slots: [],
        collections: ["col_posts"],
      });
    });

    it("compares against request macros and literals", () => {
      expect(compileUsers("@collection.posts.author = @request.auth.id")).toEqual({
        sql: '(EXISTS (SELECT 1 FROM "posts" AS __rel0 WHERE (__rel0."author" = ?)))',
        slots: [{ kind: "auth", path: "id" }],
        collections: ["col_posts"],
      });
      expect(compileUsers('@collection.posts.title ~ "x"')).toEqual({
        sql: '(EXISTS (SELECT 1 FROM "posts" AS __rel0 WHERE (__rel0."title" LIKE ?)))',
        slots: [{ kind: "literal", value: "%x%" }],
        collections: ["col_posts"],
      });
    });

    it("can reference the owning collection itself", () => {
      expect(compileUsers("@collection.users.id = id")).toEqual({
        sql:
          '(EXISTS (SELECT 1 FROM "users" AS __rel0 WHERE (__rel0."id" = "users"."id")))',
        slots: [],
        collections: ["col_users"],
      });
    });
  });

  it("rejects malformed traversals and references", () => {
    expect(compileTraversalError("ownr.name = 1").message).toBe(
      'unknown field "ownr"',
    );
    expect(compileTraversalError("title.name = 1").message).toBe(
      'cannot traverse "title.name": field "title" is not a relation',
    );
    expect(compileTraversalError('legacy.name = "x"').message).toBe(
      'relation field "legacy" has no target collection',
    );
    expect(compileTraversalError("author.missing = 1").message).toBe(
      'unknown field "missing" on collection "users"',
    );
    expect(compileTraversalError("author.data = 1").message).toBe(
      'field "author.data" has type "json", which is not supported in rules yet',
    );
    expect(compileTraversalError('author.password = "x"').message).toBe(
      'field "password" cannot be used in rules',
    );
    expect(compileTraversalError("author.views = \"5\"").message).toBe(
      'cannot compare number field "author.views" with string literal using "="',
    );
  });

  it("rejects reserved @collection.* forms", () => {
    expect(compileUsersError("@collection.posts = id").message).toBe(
      '@collection requires a collection and a field, e.g. "@collection.posts.id"',
    );
    expect(compileUsersError("@collection.posts.author.name = id").message).toBe(
      "@collection paths cannot be nested",
    );
    expect(compileUsersError("@collection.news.author = id").message).toBe(
      'unknown collection "news"',
    );
    expect(compileUsersError("@collection.posts.missing = id").message).toBe(
      'unknown field "missing" on collection "posts"',
    );
    expect(compileUsersError("@collection.posts.password = id").message).toBe(
      'field "password" cannot be used in rules',
    );
    expect(
      compileUsersError('id ~ @collection.posts.title').message,
    ).toBe('"~" is not supported with @collection.* on the right');
    expect(
      compileUsersError("@collection.posts.title = @collection.posts.views")
        .message,
    ).toBe("cannot compare two @collection.* expressions");
    expect(
      compileUsersError("@collection.posts.title:isset = true").message,
    ).toBe("modifiers are not supported on @collection.*");
  });

  it("requires collection metadata for traversal and @collection.*", () => {
    expect(compileError('author.name = "x"').message).toBe(
      'relation traversal "author.name" requires collection metadata',
    );
    expect(compileError("@collection.posts.author = id").message).toBe(
      "@collection.* requires collection metadata",
    );
  });

  it("reports a relation pointing at a missing collection", () => {
    const broken: RuleCollectionRef = {
      id: "col_broken",
      name: "broken",
      fields: [{ name: "author", type: "relation", collectionId: "col_gone" }],
    };
    const err = (() => {
      try {
        compileRule('author.name = "x"', "list", broken.fields, {
          sourceCollectionName: "broken",
          resolveCollection,
        });
      } catch (e) {
        return e as RuleError;
      }
      throw new Error("expected compileRule() to throw");
    })();
    expect(err.message).toBe(
      'relation field "author" points to a collection that does not exist',
    );
  });

  it("aggregates dependencies across a rule set", () => {
    const { compiled, errors } = compileRuleSet(
      {
        listRule: 'author.name = "x"',
        viewRule: "@collection.posts.author = id",
        createRule: 'author.name = "y"',
        updateRule: null,
      },
      POSTS.fields,
      OPTIONS,
    );
    expect(errors).toEqual([]);
    expect(compiled.listRule?.collections).toEqual(["col_users"]);
    expect(compiled.viewRule?.collections).toEqual(["col_posts"]);
    expect(ruleDependencies(compiled)).toEqual(["col_posts", "col_users"]);
    // artifact without references keeps the v1 shape (no `collections` key)
    expect(compiled.updateRule).toBeUndefined();
    const plain = compileRuleSet({ listRule: 'title = "x"' }, POSTS.fields, OPTIONS);
    expect(plain.compiled.listRule).toEqual({
      sql: '("title" = ?)',
      slots: [{ kind: "literal", value: "x" }],
    });
  });

  it("resolves create-traversal record slots from the candidate row", () => {
    const rule = compileTraversal('author.name = "Alice"', "create");
    expect(
      resolveRule(rule, { record: { author: "u1" } }).values,
    ).toEqual(["u1", "Alice"]);
    expect(resolveRule(rule, {}).values).toEqual([null, "Alice"]);
  });
});

describe("api-rules compiler: resolveRule", () => {
  it("resolves literals, auth and missing values", () => {
    const rule = compile(
      'status = "draft" && owner = @request.auth.id',
    );
    expect(resolveRule(rule, { auth: { user: { id: "u1" } } }).values).toEqual([
      "draft",
      "u1",
    ]);
    expect(resolveRule(rule, {}).values).toEqual(["draft", null]);
    expect(resolveRule(rule, { auth: null }).values).toEqual(["draft", null]);
  });

  it("resolves record slots (create candidate rows)", () => {
    const rule = compile("owner = @request.auth.id", "create");
    expect(
      resolveRule(rule, {
        record: { owner: "u1" },
        auth: { user: { id: "u1" } },
      }).values,
    ).toEqual(["u1", "u1"]);
    expect(resolveRule(rule, {}).values).toEqual([null, null]);
  });

  it("resolves body slots", () => {
    const rule = compile("@request.body.title:isset = true", "create");
    expect(resolveRule(rule, { body: { title: null } }).values).toEqual([1]);
    expect(resolveRule(rule, { body: {} }).values).toEqual([0]);
    expect(resolveRule(rule).values).toEqual([0]);
  });

  it("resolves isset against the sanitized auth context", () => {
    const rule = compile("@request.auth.id:isset", "view");
    expect(resolveRule(rule, { auth: { user: { id: "u1" } } }).values).toEqual([
      1,
    ]);
    expect(resolveRule(rule, { auth: { user: {} } }).values).toEqual([0]);
    expect(resolveRule(rule, { auth: null }).values).toEqual([0]);
  });

  it("resolves :changed as isset + submitted value", () => {
    const rule = compile("@request.body.status:changed", "update");
    expect(resolveRule(rule, { body: { status: "published" } }).values).toEqual([
      1,
      "published",
    ]);
    expect(resolveRule(rule, { body: {} }).values).toEqual([0, null]);
  });

  it("uses the provided request timestamp and fallbacks to now", () => {
    const rule = compile("publishedAt < @now");
    expect(
      resolveRule(rule, { now: "2026-10-18T12:00:00.000Z" }).values,
    ).toEqual(["2026-10-18T12:00:00.000Z"]);
    expect(resolveRule(rule).values[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("normalizes booleans to 1/0", () => {
    const rule = compile("featured = true", "create");
    expect(
      resolveRule(rule, { record: { featured: true } }).values,
    ).toEqual([1]);
    expect(
      resolveRule(rule, { record: { featured: false } }).values,
    ).toEqual([0]);
  });
});
