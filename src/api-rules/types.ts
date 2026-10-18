// Shared types for the api-rules language: tokens, AST and compiled artifacts.
// This module is dependency-free so the compiler can be unit-tested in
// isolation and imported by services without creating import cycles.

export type TokenKind =
  | "ident"
  | "string"
  | "number"
  | "true"
  | "false"
  | "null"
  | "at"
  | "dot"
  | "colon"
  | "lparen"
  | "rparen"
  | "and"
  | "or"
  | "not"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "notLike"
  | "anyOp"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** raw source slice (strings keep their quotes and escapes) */
  text: string;
  /** decoded value, string tokens only */
  value?: string;
  start: number;
  end: number;
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
}

export interface NodeBase {
  start: number;
  end: number;
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
}

export type RuleExpr =
  | BinaryExpr
  | UnaryExpr
  | ComparisonExpr
  | LiteralExpr
  | ModifierRef;

export interface BinaryExpr extends NodeBase {
  type: "binary";
  op: "&&" | "||";
  left: RuleExpr;
  right: RuleExpr;
}

export interface UnaryExpr extends NodeBase {
  type: "unary";
  op: "!";
  operand: RuleExpr;
}

export type ComparisonOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~";

export interface ComparisonExpr extends NodeBase {
  type: "comparison";
  op: ComparisonOp;
  left: ValueExpr;
  right: ValueExpr;
}

export type ValueExpr = FieldRef | MacroRef | NowRef | ModifierRef | LiteralExpr;

export interface FieldRef extends NodeBase {
  type: "field";
  name: string;
}

export interface MacroRef extends NodeBase {
  type: "macro";
  /** dotted path without the leading "@", e.g. ["request","auth","id"] */
  segments: string[];
}

export interface NowRef extends NodeBase {
  type: "now";
}

export interface ModifierRef extends NodeBase {
  type: "modifier";
  base: MacroRef;
  modifier: string;
}

export interface LiteralExpr extends NodeBase {
  type: "literal";
  value: string | number | boolean | null;
}

export const RULE_KEYS = [
  "listRule",
  "viewRule",
  "createRule",
  "updateRule",
  "deleteRule",
] as const;

export type RuleKey = (typeof RULE_KEYS)[number];

export type RuleAction = "list" | "view" | "create" | "update" | "delete";

export const ACTION_BY_RULE: Record<RuleKey, RuleAction> = {
  listRule: "list",
  viewRule: "view",
  createRule: "create",
  updateRule: "update",
  deleteRule: "delete",
};

export type CompiledRuleSlot =
  | { kind: "literal"; value: string | number | null }
  | { kind: "auth"; path: string }
  | { kind: "body"; path: string }
  | { kind: "record"; path: string }
  | { kind: "isset"; source: "auth" | "body"; path: string }
  | { kind: "now" };

export interface CompiledRule {
  /** fully parenthesized boolean expression with bare `?` in slots order */
  sql: string;
  slots: CompiledRuleSlot[];
}

/** Missing key = locked (superusers only). */
export type CompiledRuleSet = Partial<Record<RuleKey, CompiledRule>>;

/**
 * The subset of collection field metadata the compiler needs. Structurally
 * compatible with `Field` from collection.service so it can be passed directly
 * without importing the service (keeps the compiler dependency-free).
 */
export interface RuleField {
  name: string;
  type: string;
  hidden?: boolean;
}
