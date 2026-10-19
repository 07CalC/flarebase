import { quoteIdent } from "../lib/collection-name";
import { RuleError, type RuleCompileError } from "./errors";
import { parseRule } from "./parser";
import {
  ACTION_BY_RULE,
  RULE_KEYS,
  type ComparisonExpr,
  type CompiledRule,
  type CompiledRuleSet,
  type CompiledRuleSlot,
  type MacroRef,
  type ModifierRef,
  type NodeBase,
  type RuleAction,
  type RuleExpr,
  type RuleField,
  type RuleKey,
  type ValueExpr,
} from "./types";

const IMPLICIT_FIELDS: Record<string, string> = {
  id: "text",
  createdAt: "date",
  updatedAt: "date",
};

// Recognized but not implemented in v1 → "not supported yet" instead of
// "unknown macro".
const RESERVED_DATETIME_MACROS = new Set([
  "second",
  "minute",
  "hour",
  "weekday",
  "day",
  "month",
  "year",
  "yesterday",
  "tomorrow",
  "todayStart",
  "todayEnd",
  "monthStart",
  "monthEnd",
  "yearStart",
  "yearEnd",
]);

const UNSUPPORTED_FIELD_TYPES = new Set(["json", "file"]);

type KindClass = "string" | "number" | "boolean" | "date";

interface OperandInfo {
  /** SQL fragment: a quoted column, a folded constant, or "?" */
  sql: string;
  kind: Set<KindClass> | "dynamic" | "null";
  describe: string;
}

interface MacroTarget {
  namespace: "auth" | "body";
  path: string;
  kinds: Set<KindClass> | "dynamic";
  describe: string;
}

interface CompileState {
  action: RuleAction;
  fields: Map<string, RuleField>;
  slots: CompiledRuleSlot[];
  /** implicit id/createdAt/updatedAt columns are addressable */
  implicitFields: boolean;
}

function kindsForType(type: string): Set<KindClass> {
  switch (type) {
    case "text":
    case "email":
    case "url":
    case "select":
    case "relation":
      return new Set(["string"]);
    case "date":
      // date-class values are also string-compatible (lexicographic ISO order)
      return new Set(["string", "date"]);
    case "number":
      return new Set(["number"]);
    case "bool":
      return new Set(["boolean"]);
    default:
      return new Set();
  }
}

function resolveFieldType(
  state: CompileState,
  name: string,
): string | null {
  const field = state.fields.get(name);
  if (field) return field.type;
  return state.implicitFields ? (IMPLICIT_FIELDS[name] ?? null) : null;
}

function assertUsableFieldType(type: string, name: string, node: NodeBase): void {
  if (UNSUPPORTED_FIELD_TYPES.has(type) || kindsForType(type).size === 0) {
    throw new RuleError(
      `field "${name}" has type "${type}", which is not supported in rules yet`,
      node.line,
      node.column,
    );
  }
}

function assertNotPassword(name: string, node: NodeBase): void {
  if (name.toLowerCase() === "password") {
    throw new RuleError(
      'field "password" cannot be used in rules',
      node.line,
      node.column,
    );
  }
}

function likePattern(value: string): string {
  return value.includes("%") ? value : `%${value}%`;
}

function classesIntersect(
  a: Set<KindClass> | "dynamic",
  b: Set<KindClass> | "dynamic",
): boolean {
  if (a === "dynamic" || b === "dynamic") return true;
  for (const kind of a) {
    if (b.has(kind)) return true;
  }
  return false;
}

function orderComparable(
  a: Set<KindClass> | "dynamic",
  b: Set<KindClass> | "dynamic",
): boolean {
  if (a === "dynamic" || b === "dynamic") return true;
  for (const kind of ["number", "string", "date"] as const) {
    if (a.has(kind) && b.has(kind)) return true;
  }
  return false;
}

function acceptsText(kind: Set<KindClass> | "dynamic"): boolean {
  return kind === "dynamic" || kind.has("string");
}

function comparisonError(
  node: ComparisonExpr,
  left: OperandInfo,
  right: OperandInfo,
): RuleError {
  return new RuleError(
    `cannot compare ${left.describe} with ${right.describe} using "${node.op}"`,
    node.line,
    node.column,
  );
}

/** Validates a `@request.auth` / `@request.body` path without emitting a slot. */
function resolveMacro(node: MacroRef, state: CompileState): MacroTarget {
  const [first, second, third, ...rest] = node.segments;

  if (first !== "request") {
    if (first === "collection") {
      throw new RuleError(
        "@collection.* is not supported yet",
        node.line,
        node.column,
      );
    }
    if (node.segments.length === 1 && RESERVED_DATETIME_MACROS.has(first)) {
      throw new RuleError(
        `@${first} is not supported yet (only @now is available)`,
        node.line,
        node.column,
      );
    }
    throw new RuleError(
      `unknown macro "@${node.segments.join(".")}"`,
      node.line,
      node.column,
    );
  }

  if (second !== "auth" && second !== "body") {
    if (second === undefined) {
      throw new RuleError(
        '@request requires ".auth" or ".body", e.g. "@request.auth.id"',
        node.line,
        node.column,
      );
    }
    throw new RuleError(
      `@request.${second} is not supported yet`,
      node.line,
      node.column,
    );
  }

  if (third === undefined) {
    throw new RuleError(
      `@request.${second} requires a field, e.g. "@request.${second}.id"`,
      node.line,
      node.column,
    );
  }
  if (rest.length > 0) {
    throw new RuleError(
      `@request.${second} paths cannot be nested`,
      node.line,
      node.column,
    );
  }

  if (second === "body") {
    if (state.action !== "create" && state.action !== "update") {
      throw new RuleError(
        `@request.body is not available in ${state.action} rules`,
        node.line,
        node.column,
      );
    }
    assertNotPassword(third, node);
    const field = state.fields.get(third);
    if (!field) {
      throw new RuleError(`unknown field "${third}"`, node.line, node.column);
    }
    if (field.hidden) {
      throw new RuleError(
        `field "${third}" is hidden and cannot be used in @request.body`,
        node.line,
        node.column,
      );
    }
    assertUsableFieldType(field.type, third, node);
    return {
      namespace: "body",
      path: third,
      kinds: kindsForType(field.type),
      describe: `@request.body.${third} (${field.type})`,
    };
  }

  assertNotPassword(third, node);
  return {
    namespace: "auth",
    path: third,
    kinds: "dynamic",
    describe: `@request.auth.${third}`,
  };
}

function compileModifier(node: ModifierRef, state: CompileState): OperandInfo {
  const modifier = node.modifier;
  if (modifier !== "isset" && modifier !== "changed") {
    if (modifier === "length" || modifier === "lower") {
      throw new RuleError(
        `:${modifier} is not supported yet`,
        node.line,
        node.column,
      );
    }
    throw new RuleError(
      `unknown modifier ":${modifier}"`,
      node.line,
      node.column,
    );
  }

  const target = resolveMacro(node.base, state);

  if (modifier === "changed") {
    if (target.namespace !== "body") {
      throw new RuleError(
        ":changed is only available on @request.body fields",
        node.line,
        node.column,
      );
    }
    if (state.action !== "update") {
      throw new RuleError(
        ":changed is only available in the update rule; use :isset",
        node.line,
        node.column,
      );
    }
    state.slots.push({ kind: "isset", source: "body", path: target.path });
    state.slots.push({ kind: "body", path: target.path });
    return {
      sql: `(? AND (${quoteIdent(target.path)} IS NOT ?))`,
      kind: new Set(["boolean"]),
      describe: ":changed expression",
    };
  }

  state.slots.push({ kind: "isset", source: target.namespace, path: target.path });
  return {
    sql: "(?)",
    kind: new Set(["boolean"]),
    describe: ":isset expression",
  };
}

function compileValue(
  node: ValueExpr,
  state: CompileState,
  wrapLikePattern = false,
): OperandInfo {
  switch (node.type) {
    case "literal": {
      if (node.value === null) {
        return { sql: "", kind: "null", describe: "null" };
      }
      if (typeof node.value === "string") {
        state.slots.push({
          kind: "literal",
          value: wrapLikePattern ? likePattern(node.value) : node.value,
        });
        return { sql: "?", kind: new Set(["string"]), describe: "string literal" };
      }
      if (typeof node.value === "number") {
        state.slots.push({ kind: "literal", value: node.value });
        return { sql: "?", kind: new Set(["number"]), describe: "number literal" };
      }
      // booleans fold to SQL constants (1/0); no bind value needed
      return {
        sql: node.value ? "1" : "0",
        kind: new Set(["boolean"]),
        describe: "boolean literal",
      };
    }

    case "field": {
      assertNotPassword(node.name, node);
      const type = resolveFieldType(state, node.name);
      if (type === null) {
        throw new RuleError(
          `unknown field "${node.name}"`,
          node.line,
          node.column,
        );
      }
      assertUsableFieldType(type, node.name, node);
      // create rules run against the candidate row (validated payload +
      // metadata defaults), so field refs become record slots
      if (state.action === "create") {
        state.slots.push({ kind: "record", path: node.name });
        return {
          sql: "?",
          kind: kindsForType(type),
          describe: `${type} field "${node.name}"`,
        };
      }
      return {
        sql: quoteIdent(node.name),
        kind: kindsForType(type),
        describe: `${type} field "${node.name}"`,
      };
    }

    case "macro": {
      const target = resolveMacro(node, state);
      state.slots.push(
        target.namespace === "auth"
          ? { kind: "auth", path: target.path }
          : { kind: "body", path: target.path },
      );
      return { sql: "?", kind: target.kinds, describe: target.describe };
    }

    case "now": {
      state.slots.push({ kind: "now" });
      return {
        sql: "?",
        kind: new Set(["date"]),
        describe: "@now (datetime)",
      };
    }

    case "modifier":
      return compileModifier(node, state);
  }
}

function compileComparison(node: ComparisonExpr, state: CompileState): string {
  const like = node.op === "~" || node.op === "!~";
  const left = compileValue(node.left, state);
  const right = compileValue(node.right, state, like);

  if (node.op === "=" || node.op === "!=") {
    if (left.kind === "null" && right.kind === "null") {
      return node.op === "=" ? "(1)" : "(0)";
    }
    if (left.kind === "null" || right.kind === "null") {
      const other = left.kind === "null" ? right : left;
      if (other.kind === "null") return node.op === "=" ? "(1)" : "(0)";
      return node.op === "="
        ? `(${other.sql} IS NULL)`
        : `(${other.sql} IS NOT NULL)`;
    }
    if (!classesIntersect(left.kind, right.kind)) {
      throw comparisonError(node, left, right);
    }
    return `(${left.sql} ${node.op} ${right.sql})`;
  }

  if (left.kind === "null" || right.kind === "null") {
    throw new RuleError(
      'null can only be compared with "=" or "!="',
      node.line,
      node.column,
    );
  }

  if (like) {
    if (!acceptsText(left.kind) || !acceptsText(right.kind)) {
      throw new RuleError(
        `"${node.op}" requires text operands, got ${left.describe} and ${right.describe}`,
        node.line,
        node.column,
      );
    }
    return `(${left.sql} ${node.op === "~" ? "LIKE" : "NOT LIKE"} ${right.sql})`;
  }

  if (!orderComparable(left.kind, right.kind)) {
    throw comparisonError(node, left, right);
  }
  return `(${left.sql} ${node.op} ${right.sql})`;
}

function compileExpr(node: RuleExpr, state: CompileState): string {
  switch (node.type) {
    case "comparison":
      return compileComparison(node, state);
    case "binary": {
      const left = compileExpr(node.left, state);
      const right = compileExpr(node.right, state);
      return `(${left} ${node.op === "&&" ? "AND" : "OR"} ${right})`;
    }
    case "unary":
      return `(NOT ${compileExpr(node.operand, state)})`;
    case "literal":
      if (typeof node.value !== "boolean") {
        throw new RuleError(
          "expected a boolean expression",
          node.line,
          node.column,
        );
      }
      return node.value ? "1" : "0";
    case "modifier":
      return compileModifier(node, state).sql;
    default: {
      // parser guarantees only boolean expressions reach here
      const unexpected = node as NodeBase;
      throw new RuleError(
        "expected a boolean expression",
        unexpected.line,
        unexpected.column,
      );
    }
  }
}

function fieldMapOf(fields: RuleField[]): Map<string, RuleField> {
  return new Map(fields.map((field) => [field.name, field]));
}

/** Compiles a single rule for one action; throws `RuleError` on any violation. */
export function compileRule(
  source: string,
  action: RuleAction,
  fields: RuleField[],
): CompiledRule {
  const ast = parseRule(source);
  const state: CompileState = {
    action,
    fields: fieldMapOf(fields),
    slots: [],
    implicitFields: true,
  };
  const sql = compileExpr(ast, state);
  return { sql, slots: state.slots };
}

export interface CompileRuleSetResult {
  compiled: CompiledRuleSet;
  errors: RuleCompileError[];
}

export interface CompileRuleSetOptions {
  implicitFields?: boolean;
}

/**
 * Compiles all five rules in one pass, collecting every violation instead of
 * throwing at the first one. `null`/absent rules stay locked (no artifact
 * entry); `""` compiles to the open constant.
 */
export function compileRuleSet(
  rules: Partial<Record<RuleKey, string | null | undefined>>,
  fields: RuleField[],
  options: CompileRuleSetOptions = {},
): CompileRuleSetResult {
  const fieldMap = fieldMapOf(fields);
  const implicitFields = options.implicitFields !== false;
  const compiled: CompiledRuleSet = {};
  const errors: RuleCompileError[] = [];

  for (const key of RULE_KEYS) {
    const text = rules[key];
    if (text === null || text === undefined) continue;
    if (text === "") {
      compiled[key] = { sql: "1", slots: [] };
      continue;
    }
    if (text.trim() === "") {
      errors.push({
        rule: key,
        message: 'whitespace-only rule; use null (superusers only) or "" (public)',
        line: 1,
        column: 1,
      });
      continue;
    }
    try {
      const ast = parseRule(text);
      const state: CompileState = {
        action: ACTION_BY_RULE[key],
        fields: fieldMap,
        slots: [],
        implicitFields,
      };
      compiled[key] = { sql: compileExpr(ast, state), slots: state.slots };
    } catch (err) {
      if (err instanceof RuleError) {
        errors.push({
          rule: key,
          message: err.message,
          line: err.line,
          column: err.column,
        });
        continue;
      }
      throw err;
    }
  }

  return { compiled, errors };
}

export interface RuleContext {
  /** Sanitized auth context (the same shape routes expose as `auth`). */
  auth?: { user: Record<string, unknown> | null } | null;
  /** Validated (and normalized) create/update payload. */
  body?: Record<string, unknown> | null;
  /** Row variant: current row. Candidate variant: candidate row. */
  record?: Record<string, unknown> | null;
  /** Request timestamp (RFC 3339 with milliseconds); defaults to now. */
  now?: string;
}

function readPath(
  source: Record<string, unknown> | null | undefined,
  path: string,
): unknown {
  if (!source) return null;
  return source[path] === undefined ? null : source[path];
}

function hasPath(
  source: Record<string, unknown> | null | undefined,
  path: string,
): boolean {
  return !!source && Object.prototype.hasOwnProperty.call(source, path);
}

function normalizeBindValue(value: unknown): unknown {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

/**
 * Turns a compiled artifact into a concrete parameterized fragment:
 * `{ sql, values }` where `values[i]` binds the i-th `?` of `sql`.
 * Missing auth/body/record values resolve to `null`; `isset` resolves to 1/0.
 */
export function resolveRule(
  rule: CompiledRule,
  context: RuleContext = {},
): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  for (const slot of rule.slots) {
    switch (slot.kind) {
      case "literal":
        values.push(slot.value);
        break;
      case "auth":
        values.push(readPath(context.auth?.user, slot.path));
        break;
      case "body":
        values.push(readPath(context.body, slot.path));
        break;
      case "record":
        values.push(readPath(context.record, slot.path));
        break;
      case "isset": {
        const source = slot.source === "auth" ? context.auth?.user : context.body;
        values.push(hasPath(source, slot.path) ? 1 : 0);
        break;
      }
      case "now":
        values.push(context.now ?? new Date().toISOString());
        break;
    }
  }
  return { sql: rule.sql, values: values.map(normalizeBindValue) };
}
