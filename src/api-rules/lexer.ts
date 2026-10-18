import { RuleError } from "./errors";
import type { Token, TokenKind } from "./types";

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

/**
 * Tokenizes a rule into a flat token stream ending with an `eof` token.
 * Positions are 1-based line/column pairs used for compile error reporting.
 * Reserved syntax (`?~`, `@collection.*`, …) is lexed normally and rejected
 * later with a "not supported yet" message, not a lexer error.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const peek = (offset = 0): string => source[index + offset] ?? "";
  const advance = (): string => {
    const ch = source[index++];
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    return ch;
  };

  while (index < source.length) {
    const start = index;
    const startLine = line;
    const startColumn = column;
    const ch = advance();

    const push = (kind: TokenKind, value?: string): void => {
      tokens.push({
        kind,
        text: source.slice(start, index),
        value,
        start,
        end: index,
        line: startLine,
        column: startColumn,
      });
    };
    const fail = (message: string): never => {
      throw new RuleError(message, startLine, startColumn);
    };

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") continue;

    if (ch === "/") {
      if (peek() === "/") {
        while (index < source.length && peek() !== "\n") advance();
        continue;
      }
      fail('unexpected character "/"');
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = "";
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (current === "\n") fail("unterminated string");
        if (current === "\\") {
          const escaped = peek(1);
          if (escaped === "\\" || escaped === "'" || escaped === '"') {
            value += escaped;
            advance();
            advance();
            continue;
          }
          throw new RuleError(
            `invalid escape sequence "\\${escaped}"`,
            line,
            column,
          );
        }
        if (current === quote) {
          advance();
          closed = true;
          break;
        }
        value += current;
        advance();
      }
      if (!closed) fail("unterminated string");
      push("string", value);
      continue;
    }

    if (DIGIT.test(ch) || (ch === "-" && DIGIT.test(peek()))) {
      while (DIGIT.test(peek())) advance();
      if (peek() === "." && DIGIT.test(peek(1))) {
        advance();
        while (DIGIT.test(peek())) advance();
      }
      if (IDENT_START.test(peek()) || peek() === ".") fail("invalid number literal");
      push("number");
      continue;
    }

    if (IDENT_START.test(ch)) {
      while (IDENT_PART.test(peek())) advance();
      const text = source.slice(start, index);
      const kind: TokenKind =
        text === "true"
          ? "true"
          : text === "false"
            ? "false"
            : text === "null"
              ? "null"
              : "ident";
      push(kind);
      continue;
    }

    if (ch === "@") {
      push("at");
      continue;
    }
    if (ch === ".") {
      push("dot");
      continue;
    }
    if (ch === ":") {
      push("colon");
      continue;
    }
    if (ch === "(") {
      push("lparen");
      continue;
    }
    if (ch === ")") {
      push("rparen");
      continue;
    }

    if (ch === "=") {
      if (peek() === "=") fail('unexpected "==", did you mean "="?');
      push("eq");
      continue;
    }

    if (ch === "!") {
      if (peek() === "=") {
        advance();
        push("neq");
      } else if (peek() === "~") {
        advance();
        push("notLike");
      } else {
        push("not");
      }
      continue;
    }

    if (ch === ">") {
      if (peek() === "=") {
        advance();
        push("gte");
      } else {
        push("gt");
      }
      continue;
    }

    if (ch === "<") {
      if (peek() === "=") {
        advance();
        push("lte");
      } else {
        push("lt");
      }
      continue;
    }

    if (ch === "~") {
      push("like");
      continue;
    }

    if (ch === "&") {
      if (peek() === "&") {
        advance();
        push("and");
      } else {
        fail('unexpected character "&", did you mean "&&"?');
      }
      continue;
    }

    if (ch === "|") {
      if (peek() === "|") {
        advance();
        push("or");
      } else {
        fail('unexpected character "|", did you mean "||"?');
      }
      continue;
    }

    if (ch === "?") {
      const next = peek();
      if (next === "=" || next === "~") {
        advance();
      } else if (next === ">") {
        advance();
        if (peek() === "=") advance();
      } else if (next === "<") {
        advance();
        if (peek() === "=") advance();
      } else if (next === "!") {
        advance();
        const after = peek();
        if (after === "=" || after === "~") advance();
        else fail('unexpected "?!", did you mean "?!=" or "?!~"?');
      } else {
        fail('unexpected character "?"');
      }
      push("anyOp");
      continue;
    }

    fail(`unexpected character "${ch}"`);
  }

  tokens.push({
    kind: "eof",
    text: "",
    start: index,
    end: index,
    line,
    column,
  });
  return tokens;
}
