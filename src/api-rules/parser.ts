import { RuleError } from "./errors";
import { tokenize } from "./lexer";
import type {
  BinaryExpr,
  ComparisonExpr,
  ComparisonOp,
  FieldRef,
  LiteralExpr,
  MacroRef,
  ModifierRef,
  NodeBase,
  NowRef,
  RuleExpr,
  Token,
  TokenKind,
  UnaryExpr,
  ValueExpr,
} from "./types";

const COMPARISON_OPS: Partial<Record<TokenKind, ComparisonOp>> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "~",
  notLike: "!~",
};

/**
 * Parses rule text into an AST.
 *
 * Grammar (see API_RULES.md §3.1), precedence lowest to highest:
 *   orExpr := andExpr ("||" andExpr)*
 *   andExpr := unary ("&&" unary)*
 *   unary := "!" unary | "(" orExpr ")" | comparison | boolean
 *   comparison := value op value
 *   boolean := "true" | "false" | modifier
 */
export function parseRule(source: string): RuleExpr {
  return new Parser(tokenize(source)).parse();
}

function withSpan<T extends NodeBase>(
  node: Omit<T, keyof NodeBase>,
  start: NodeBase,
  end: NodeBase,
): T {
  return {
    ...node,
    start: start.start,
    end: end.end,
    line: start.line,
    column: start.column,
  } as T;
}

function isBooleanExpr(
  node: ValueExpr,
): node is ModifierRef | LiteralExpr {
  return (
    node.type === "modifier" ||
    (node.type === "literal" && typeof node.value === "boolean")
  );
}

function describeToken(token: Token): string {
  switch (token.kind) {
    case "eof":
      return "end of rule";
    case "ident":
      return `identifier "${token.text}"`;
    case "string":
      return "string";
    case "number":
      return `number "${token.text}"`;
    case "true":
    case "false":
    case "null":
      return `"${token.text}"`;
    case "anyOp":
      return `"${token.text}"`;
    default:
      return `"${token.text}"`;
  }
}

function describeValue(node: ValueExpr): string {
  switch (node.type) {
    case "field":
      return `field "${node.name}"`;
    case "macro":
      return `"@${node.segments.join(".")}"`;
    case "now":
      return '"@now"';
    case "modifier":
      return `:${node.modifier} expression`;
    case "literal":
      if (node.value === null) return '"null"';
      if (typeof node.value === "string") return "string literal";
      if (typeof node.value === "number") return "number literal";
      return "boolean literal";
  }
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): RuleExpr {
    const expr = this.parseOr();
    const next = this.peek();
    if (next.kind !== "eof") {
      throw new RuleError(
        `unexpected ${describeToken(next)}`,
        next.line,
        next.column,
      );
    }
    return expr;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.index++];
  }

  private expect(kind: TokenKind, what: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new RuleError(
        `expected ${what}, found ${describeToken(token)}`,
        token.line,
        token.column,
      );
    }
    return this.next();
  }

  private parseOr(): RuleExpr {
    let left = this.parseAnd();
    while (this.peek().kind === "or") {
      this.next();
      const right = this.parseAnd();
      left = withSpan<BinaryExpr>(
        { type: "binary", op: "||", left, right },
        left,
        right,
      );
    }
    return left;
  }

  private parseAnd(): RuleExpr {
    let left = this.parseUnary();
    while (this.peek().kind === "and") {
      this.next();
      const right = this.parseUnary();
      left = withSpan<BinaryExpr>(
        { type: "binary", op: "&&", left, right },
        left,
        right,
      );
    }
    return left;
  }

  private parseUnary(): RuleExpr {
    const token = this.peek();
    if (token.kind === "not") {
      this.next();
      const operand = this.parseUnary();
      return withSpan<UnaryExpr>(
        { type: "unary", op: "!", operand },
        token,
        operand,
      );
    }
    if (token.kind === "lparen") {
      this.next();
      const inner = this.parseOr();
      this.expect("rparen", '")"');
      return inner;
    }
    return this.parsePredicate();
  }

  private parsePredicate(): RuleExpr {
    const left = this.parseValue();
    const token = this.peek();

    if (token.kind === "colon") {
      throw new RuleError(
        "modifiers can only be attached to @request.* macros",
        token.line,
        token.column,
      );
    }

    const op = COMPARISON_OPS[token.kind];
    if (op) {
      this.next();
      const right = this.parseValue();
      const trailing = this.peek();
      if (COMPARISON_OPS[trailing.kind] || trailing.kind === "anyOp") {
        throw new RuleError(
          "comparisons cannot be chained",
          trailing.line,
          trailing.column,
        );
      }
      return withSpan<ComparisonExpr>(
        { type: "comparison", op, left, right },
        left,
        right,
      );
    }

    if (token.kind === "anyOp") {
      throw new RuleError(
        `operator "${token.text}" is not supported yet`,
        token.line,
        token.column,
      );
    }

    if (isBooleanExpr(left)) return left;

    throw new RuleError(
      `expected an operator after ${describeValue(left)}, found ${describeToken(token)}`,
      token.line,
      token.column,
    );
  }

  private parseValue(): ValueExpr {
    const token = this.peek();
    switch (token.kind) {
      case "ident": {
        this.next();
        return withSpan<FieldRef>(
          { type: "field", name: token.text },
          token,
          token,
        );
      }
      case "string": {
        this.next();
        return withSpan<LiteralExpr>(
          { type: "literal", value: token.value ?? "" },
          token,
          token,
        );
      }
      case "number": {
        this.next();
        return withSpan<LiteralExpr>(
          { type: "literal", value: Number(token.text) },
          token,
          token,
        );
      }
      case "true":
      case "false": {
        this.next();
        return withSpan<LiteralExpr>(
          { type: "literal", value: token.kind === "true" },
          token,
          token,
        );
      }
      case "null": {
        this.next();
        return withSpan<LiteralExpr>(
          { type: "literal", value: null },
          token,
          token,
        );
      }
      case "at":
        return this.parseMacro();
      default:
        throw new RuleError(
          `expected an operand, found ${describeToken(token)}`,
          token.line,
          token.column,
        );
    }
  }

  private parseMacro(): ValueExpr {
    const at = this.expect("at", '"@"');
    const first = this.expect("ident", 'a macro name after "@"');
    const segments = [first.text];
    while (this.peek().kind === "dot") {
      this.next();
      segments.push(this.expect("ident", "a macro path segment").text);
    }

    const end = this.tokens[this.index - 1];
    let node: MacroRef | NowRef;
    if (segments.length === 1 && segments[0] === "now") {
      node = withSpan<NowRef>({ type: "now" }, at, end);
    } else {
      node = withSpan<MacroRef>({ type: "macro", segments }, at, end);
    }

    if (this.peek().kind === "colon") {
      const colon = this.next();
      const nameToken = this.expect("ident", 'a modifier name after ":"');
      if (node.type !== "macro") {
        throw new RuleError(
          "modifiers can only be attached to @request.* macros",
          colon.line,
          colon.column,
        );
      }
      if (this.peek().kind === "colon") {
        const extra = this.peek();
        throw new RuleError("cannot chain modifiers", extra.line, extra.column);
      }
      return withSpan<ModifierRef>(
        { type: "modifier", base: node, modifier: nameToken.text },
        at,
        nameToken,
      );
    }

    return node;
  }
}
