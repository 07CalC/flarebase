import { describe, expect, it } from "vitest";
import { RuleError } from "../../src/api-rules/errors";
import { tokenize } from "../../src/api-rules/lexer";
import type { TokenKind } from "../../src/api-rules/types";

function kinds(source: string): TokenKind[] {
  return tokenize(source).map((token) => token.kind);
}

function lexError(source: string): RuleError {
  try {
    tokenize(source);
  } catch (err) {
    if (err instanceof RuleError) return err;
    throw err;
  }
  throw new Error("expected tokenize() to throw");
}

describe("api-rules lexer", () => {
  it("tokenizes a simple rule", () => {
    expect(kinds("author = @request.auth.id")).toEqual([
      "ident",
      "eq",
      "at",
      "ident",
      "dot",
      "ident",
      "dot",
      "ident",
      "eof",
    ]);
  });

  it("recognizes boolean/null keywords", () => {
    expect(kinds("true false null")).toEqual([
      "true",
      "false",
      "null",
      "eof",
    ]);
  });

  it("tokenizes numbers including negatives and decimals", () => {
    const tokens = tokenize("views >= -12.5 && views < 0");
    expect(tokens.map((t) => t.kind)).toEqual([
      "ident",
      "gte",
      "number",
      "and",
      "ident",
      "lt",
      "number",
      "eof",
    ]);
    expect(tokens[2].text).toBe("-12.5");
    expect(tokens[6].text).toBe("0");
  });

  it("decodes string escapes for both quote styles", () => {
    const tokens = tokenize(`'a\\'b' "x\\"y\\\\z"`);
    expect(tokens[0].kind).toBe("string");
    expect(tokens[0].value).toBe("a'b");
    // raw text keeps quotes/escapes; value is decoded
    expect(tokens[0].text).toBe(`'a\\'b'`);
    expect(tokens[1].value).toBe('x"y\\z');
  });

  it("keeps string tokens unescaped byte-for-byte", () => {
    const tokens = tokenize(`title = "a b"`);
    expect(tokens[2].text).toBe('"a b"');
    expect(tokens[2].value).toBe("a b");
  });

  it("skips // comments and tracks lines", () => {
    const tokens = tokenize("a = 1 // comment\n&& b = 2");
    expect(tokens.map((t) => t.kind)).toEqual([
      "ident",
      "eq",
      "number",
      "and",
      "ident",
      "eq",
      "number",
      "eof",
    ]);
    expect(tokens[3].line).toBe(2);
    expect(tokens[3].column).toBe(1);
  });

  it("lexes all comparison operators", () => {
    expect(
      kinds(`a != b !~ c !d && e || f >= g <= h > i < j ~ k = l`),
    ).toEqual([
      "ident",
      "neq",
      "ident",
      "notLike",
      "ident",
      "not",
      "ident",
      "and",
      "ident",
      "or",
      "ident",
      "gte",
      "ident",
      "lte",
      "ident",
      "gt",
      "ident",
      "lt",
      "ident",
      "like",
      "ident",
      "eq",
      "ident",
      "eof",
    ]);
  });

  it("lexes reserved `?`-family operators as anyOp tokens", () => {
    const tokens = tokenize("a ?= b ?!= c ?> d ?>= e ?< f ?<= g ?~ h ?!~ i");
    const anyOps = tokens.filter((t) => t.kind === "anyOp");
    expect(anyOps.map((t) => t.text)).toEqual([
      "?=",
      "?!=",
      "?>",
      "?>=",
      "?<",
      "?<=",
      "?~",
      "?!~",
    ]);
  });

  it("records token positions", () => {
    const tokens = tokenize("a\n  = 1");
    const eq = tokens[1];
    expect(eq.kind).toBe("eq");
    expect(eq.line).toBe(2);
    expect(eq.column).toBe(3);
    expect(eq.start).toBe(4);
    expect(eq.end).toBe(5);
  });

  it("rejects unterminated strings", () => {
    const err = lexError('"abc');
    expect(err.message).toBe("unterminated string");
    expect(err.line).toBe(1);
    expect(err.column).toBe(1);
  });

  it("rejects raw newlines inside strings", () => {
    const err = lexError('"a\nb"');
    expect(err.message).toBe("unterminated string");
  });

  it("rejects invalid escapes with the backslash position", () => {
    const err = lexError("'a\\q'");
    expect(err.message).toBe('invalid escape sequence "\\q"');
    expect(err.column).toBe(3);
  });

  it("rejects single & / | with a hint", () => {
    expect(lexError("a & b").message).toBe(
      'unexpected character "&", did you mean "&&"?',
    );
    expect(lexError("a | b").message).toBe(
      'unexpected character "|", did you mean "||"?',
    );
  });

  it("rejects == with a hint", () => {
    expect(lexError("a == b").message).toBe(
      'unexpected "==", did you mean "="?',
    );
  });

  it("rejects malformed numbers and unknown characters", () => {
    expect(lexError("12abc").message).toBe("invalid number literal");
    expect(lexError("a # b").message).toBe('unexpected character "#"');
    expect(lexError("a / b").message).toBe('unexpected character "/"');
  });

  it("rejects malformed `?` operators", () => {
    expect(lexError("a ? b").message).toBe('unexpected character "?"');
    expect(lexError("a ?! b").message).toBe(
      'unexpected "?!", did you mean "?!=" or "?!~"?',
    );
  });
});
