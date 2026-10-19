import { describe, expect, it } from "vitest";
import { validateViewQuery } from "../src/lib/view-query";

describe("validateViewQuery", () => {
  it("accepts a plain select, with or without a trailing semicolon", () => {
    expect(validateViewQuery("SELECT id FROM posts")).toBe(
      "SELECT id FROM posts",
    );
    expect(validateViewQuery("SELECT id FROM posts;")).toBe(
      "SELECT id FROM posts;",
    );
    expect(validateViewQuery("  select id from posts  ")).toContain("select");
  });

  it("accepts leading comments and CTEs", () => {
    expect(() =>
      validateViewQuery("-- overview\nSELECT id FROM posts"),
    ).not.toThrow();
    expect(() =>
      validateViewQuery(
        "/* c */ WITH x AS (SELECT 1 AS id) SELECT id FROM x",
      ),
    ).not.toThrow();
  });

  it("does not flag separators or words inside strings and comments", () => {
    expect(() =>
      validateViewQuery("SELECT id FROM posts WHERE title = 'a;b'"),
    ).not.toThrow();
    expect(() =>
      validateViewQuery("SELECT id FROM posts -- trailing ;\n"),
    ).not.toThrow();
    expect(() =>
      validateViewQuery("SELECT id FROM posts WHERE title = 'password'"),
    ).not.toThrow();
    expect(() =>
      validateViewQuery("SELECT id FROM posts WHERE title = '_x'"),
    ).not.toThrow();
  });

  it("rejects anything that is not a single SELECT statement", () => {
    for (const query of [
      "",
      "   ",
      "DELETE FROM posts",
      "INSERT INTO posts (id) VALUES ('x')",
      "SELECT id FROM posts; DROP TABLE posts",
      "SELECT id FROM posts;;",
    ]) {
      expect(() => validateViewQuery(query), query).toThrow();
    }
  });

  it("rejects reserved and password identifiers, including quoted ones", () => {
    for (const query of [
      "SELECT id FROM _superusers",
      'SELECT id FROM "_superusers"',
      "SELECT id FROM `_secret`",
      "SELECT id FROM [sqlite_master]",
      "SELECT id, password FROM users",
      'SELECT id, "password" AS p FROM users',
      "SELECT id, hex(password) FROM users",
    ]) {
      expect(() => validateViewQuery(query), query).toThrow();
    }
    expect(() => validateViewQuery("SELECT id FROM posts")).not.toThrow();
  });

  it("rejects queries longer than the limit", () => {
    expect(() =>
      validateViewQuery(`SELECT '${"a".repeat(9000)}' AS id`),
    ).toThrow(/at most/);
  });
});
