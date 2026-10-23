import { describe, expect, it } from "vitest";
import { RuleError } from "../../src/api-rules/errors";
import { parseRule } from "../../src/api-rules/parser";
import type {
  BinaryExpr,
  ComparisonExpr,
  MacroRef,
  ModifierRef,
  RuleExpr,
  UnaryExpr,
  ValueExpr,
} from "../../src/api-rules/types";

type AnyExpr = RuleExpr | ValueExpr;

function binary(expr: AnyExpr): BinaryExpr {
  if (expr.type !== "binary") throw new Error(`expected binary, got ${expr.type}`);
  return expr;
}

function unary(expr: AnyExpr): UnaryExpr {
  if (expr.type !== "unary") throw new Error(`expected unary, got ${expr.type}`);
  return expr;
}

function comparison(expr: AnyExpr): ComparisonExpr {
  if (expr.type !== "comparison") {
    throw new Error(`expected comparison, got ${expr.type}`);
  }
  return expr;
}

function macro(expr: AnyExpr): MacroRef {
  if (expr.type !== "macro") throw new Error(`expected macro, got ${expr.type}`);
  return expr;
}

function modifier(expr: AnyExpr): ModifierRef {
  if (expr.type !== "modifier") {
    throw new Error(`expected modifier, got ${expr.type}`);
  }
  return expr;
}

function parseError(source: string): RuleError {
  try {
    parseRule(source);
  } catch (err) {
    if (err instanceof RuleError) return err;
    throw err;
  }
  throw new Error("expected parseRule() to throw");
}

describe("api-rules parser", () => {
  it("gives && higher precedence than ||", () => {
    const top = binary(parseRule("a = 1 || b = 2 && c = 3"));
    expect(top.op).toBe("||");
    expect(comparison(top.left).op).toBe("=");
    const right = binary(top.right);
    expect(right.op).toBe("&&");
    expect(comparison(right.left).op).toBe("=");
    expect(comparison(right.right).op).toBe("=");
  });

  it("honours parentheses", () => {
    const top = binary(parseRule('(a = 1 || b = 2) && c = "x"'));
    expect(top.op).toBe("&&");
    expect(binary(top.left).op).toBe("||");
  });

  it("parses unary !", () => {
    const expr = unary(parseRule("!(a = 1)"));
    expect(comparison(expr.operand).op).toBe("=");
    // ! binds to the whole comparison: !a = 1 reads as !(a = 1)
    const implicit = unary(parseRule("!a = 1"));
    expect(comparison(implicit.operand).op).toBe("=");
  });

  it("parses comparisons with all operator kinds", () => {
    const ops: Record<string, string> = {
      "a = 1": "=",
      "a != 1": "!=",
      "a > 1": ">",
      "a >= 1": ">=",
      "a < 1": "<",
      "a <= 1": "<=",
      'a ~ "x"': "~",
      'a !~ "x"': "!~",
    };
    for (const [source, op] of Object.entries(ops)) {
      expect(comparison(parseRule(source)).op).toBe(op);
    }
  });

  it("parses literals", () => {
    expect(comparison(parseRule("flag = true")).right).toMatchObject({
      type: "literal",
      value: true,
    });
    expect(comparison(parseRule('title = "x"')).right).toMatchObject({
      type: "literal",
      value: "x",
    });
    expect(comparison(parseRule("views = -1.5")).right).toMatchObject({
      type: "literal",
      value: -1.5,
    });
    expect(comparison(parseRule("title != null")).right).toMatchObject({
      type: "literal",
      value: null,
    });
  });

  it("parses @request macros", () => {
    const left = comparison(parseRule('@request.auth.id != ""')).left;
    expect(macro(left).segments).toEqual(["request", "auth", "id"]);
  });

  it("parses dotted field paths (relation traversal)", () => {
    const single = comparison(parseRule("author.name = 1")).left;
    expect(single).toMatchObject({ type: "field", name: "author", path: ["name"] });
    const chain = comparison(parseRule('author.team.name ~ "x"')).left;
    expect(chain).toMatchObject({
      type: "field",
      name: "author",
      path: ["team", "name"],
    });
    // plain fields keep the v1 shape (no `path` key)
    expect(comparison(parseRule("title = 1")).left).not.toHaveProperty("path");
  });

  it("parses @collection macros", () => {
    const left = comparison(parseRule("@collection.posts.author = id")).left;
    expect(macro(left).segments).toEqual(["collection", "posts", "author"]);
  });

  it("rejects a dangling dot in a field path", () => {
    expect(parseError("author. = 1").message).toBe(
      'expected a field name after ".", found "="',
    );
  });

  it("parses @now", () => {
    expect(comparison(parseRule("@now > createdAt")).left).toMatchObject({
      type: "now",
    });
  });

  it("parses modifiers as boolean primaries and comparison operands", () => {
    const standalone = parseRule("@request.auth.id:isset");
    expect(modifier(standalone).modifier).toBe("isset");

    const compared = comparison(
      parseRule("@request.body.status:changed = false"),
    );
    const left = modifier(compared.left);
    expect(left.modifier).toBe("changed");
    expect(left.base.segments).toEqual(["request", "body", "status"]);
  });

  it("parses bare booleans as rules", () => {
    expect(parseRule("true")).toMatchObject({ type: "literal", value: true });
  });

  it("tracks spans across lines", () => {
    const top = binary(parseRule("a = 1 ||\n  b = 2"));
    expect(top.line).toBe(1);
    expect(top.column).toBe(1);
    expect(top.right.line).toBe(2);
    expect(top.right.column).toBe(3);
  });

  it("rejects missing operands", () => {
    expect(parseError("a =").message).toBe(
      "expected an operand, found end of rule",
    );
    expect(parseError("= 1").message).toBe('expected an operand, found "="');
  });

  it("rejects chained comparisons with a position", () => {
    const err = parseError("a = 1 = 2");
    expect(err.message).toBe("comparisons cannot be chained");
    expect(err.column).toBe(7);
  });

  it("rejects bare non-boolean operands", () => {
    expect(parseError("title").message).toBe(
      'expected an operator after field "title", found end of rule',
    );
    expect(parseError("!title").message).toBe(
      'expected an operator after field "title", found end of rule',
    );
  });

  it("rejects unbalanced parentheses", () => {
    expect(parseError("(a = 1").message).toBe(
      'expected ")", found end of rule',
    );
    expect(parseError("a = 1)").message).toBe('unexpected ")"');
  });

  it("rejects trailing garbage", () => {
    expect(parseError("a = 1 b = 2").message).toBe(
      'unexpected identifier "b"',
    );
  });

  it("rejects modifiers on plain fields and literals", () => {
    expect(parseError("title:isset").message).toBe(
      "modifiers can only be attached to @request.* macros",
    );
    expect(parseError('"x":isset = true').message).toBe(
      "modifiers can only be attached to @request.* macros",
    );
    expect(parseError("@now:isset").message).toBe(
      "modifiers can only be attached to @request.* macros",
    );
  });

  it("rejects chained modifiers", () => {
    expect(parseError("@request.auth.id:changed:isset").message).toBe(
      "cannot chain modifiers",
    );
  });

  it("rejects reserved operators with a clear message", () => {
    expect(parseError("a ?~ b").message).toBe(
      'operator "?~" is not supported yet',
    );
  });
});
