import { quoteIdent } from "../lib/collection-name";
import { RuleError, type RuleCompileError } from "./errors";
import { parseRule } from "./parser";
import {
  ACTION_BY_RULE,
  RULE_KEYS,
  type ComparisonExpr,
  type ComparisonOp,
  type CompiledRule,
  type CompiledRuleSet,
  type CompiledRuleSlot,
  type FieldRef,
  type MacroRef,
  type ModifierRef,
  type NodeBase,
  type RuleAction,
  type RuleCollectionRef,
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
  /** physical name of the owning collection; outer ref for relation traversal */
  sourceName?: string;
  /** preloaded metadata resolver: relation targets and `@collection.*` */
  resolveCollection?: (idOrName: string) => RuleCollectionRef | null;
  /** collection ids referenced by the rule currently being compiled */
  dependencies: Set<string>;
  /** deterministic subquery alias counter (per rule) */
  aliasSeq: number;
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
  node: NodeBase,
  op: ComparisonOp,
  left: OperandInfo,
  right: OperandInfo,
): RuleError {
  return new RuleError(
    `cannot compare ${left.describe} with ${right.describe} using "${op}"`,
    node.line,
    node.column,
  );
}

function invertComparisonOp(op: ComparisonOp): ComparisonOp {
  switch (op) {
    case ">":
      return "<";
    case ">=":
      return "<=";
    case "<":
      return ">";
    case "<=":
      return ">=";
    default:
      return op;
  }
}

/** Shared by plain comparisons and the inner comparison of `@collection.*`. */
function buildComparisonSql(
  op: ComparisonOp,
  left: OperandInfo,
  right: OperandInfo,
  node: NodeBase,
): string {
  if (op === "=" || op === "!=") {
    if (left.kind === "null" && right.kind === "null") {
      return op === "=" ? "(1)" : "(0)";
    }
    if (left.kind === "null" || right.kind === "null") {
      const other = left.kind === "null" ? right : left;
      return op === "="
        ? `(${other.sql} IS NULL)`
        : `(${other.sql} IS NOT NULL)`;
    }
    if (!classesIntersect(left.kind, right.kind)) {
      throw comparisonError(node, op, left, right);
    }
    return `(${left.sql} ${op} ${right.sql})`;
  }

  if (left.kind === "null" || right.kind === "null") {
    throw new RuleError(
      'null can only be compared with "=" or "!="',
      node.line,
      node.column,
    );
  }

  if (op === "~" || op === "!~") {
    if (!acceptsText(left.kind) || !acceptsText(right.kind)) {
      throw new RuleError(
        `"${op}" requires text operands, got ${left.describe} and ${right.describe}`,
        node.line,
        node.column,
      );
    }
    return `(${left.sql} ${op === "~" ? "LIKE" : "NOT LIKE"} ${right.sql})`;
  }

  if (!orderComparable(left.kind, right.kind)) {
    throw comparisonError(node, op, left, right);
  }
  return `(${left.sql} ${op} ${right.sql})`;
}

/** Validates a `@request.auth` / `@request.body` path without emitting a slot. */
function resolveMacro(node: MacroRef, state: CompileState): MacroTarget {
  const [first, second, third, ...rest] = node.segments;

  if (first !== "request") {
    if (first === "collection") {
      // intercepted by compileComparison; reaching here means the macro was
      // used outside a comparison
      throw new RuleError(
        "@collection.* must be compared with a field or value",
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

// ---------------------------------------------------------------------------
// relation traversal (`relationField.target.field` chains) and `@collection.*`

function isCollectionMacro(node: ValueExpr): node is MacroRef {
  return node.type === "macro" && node.segments[0] === "collection";
}

function nextAlias(state: CompileState): string {
  return `__rel${state.aliasSeq++}`;
}

/**
 * The owning collection as a `RuleCollectionRef`, including implicit fields
 * when they are addressable (so `id.name` reports "not a relation" instead of
 * "unknown field").
 */
function sourceCollectionRef(state: CompileState): RuleCollectionRef | null {
  if (!state.sourceName) return null;
  return {
    id: "",
    name: state.sourceName,
    fields: [...state.fields.values()],
    implicitFields: state.implicitFields,
  };
}

function findField(
  collection: RuleCollectionRef,
  name: string,
): RuleField | null {
  const field = collection.fields.find((f) => f.name === name);
  if (field) return field;
  if (collection.implicitFields === false) return null;
  const type = IMPLICIT_FIELDS[name];
  return type ? { name, type } : null;
}

function unknownFieldError(
  collection: RuleCollectionRef | null,
  name: string,
  node: NodeBase,
): RuleError {
  // the owning collection keeps the plain v1 message
  return collection
    ? new RuleError(
        `unknown field "${name}" on collection "${collection.name}"`,
        node.line,
        node.column,
      )
    : new RuleError(`unknown field "${name}"`, node.line, node.column);
}

interface TraversalHop {
  /** relation field on the previous collection pointing at `target` */
  field: RuleField;
  target: RuleCollectionRef;
}

/**
 * Compiles `root.seg.seg` into a nested scalar-subquery chain:
 *
 *   (SELECT __rel0."name" FROM "users" AS __rel0 WHERE __rel0."id" = "posts"."author")
 *
 * The outer reference is the owning collection's column for row actions and
 * the candidate value (`record` slot) for create rules, where the row does not
 * exist in the table yet. An empty/dangling relation makes every hop subquery
 * return NULL, so comparisons against it are false (fail closed).
 */
function compileFieldPath(node: FieldRef, state: CompileState): OperandInfo {
  const segments = [node.name, ...(node.path ?? [])];
  const fullName = segments.join(".");

  const source = sourceCollectionRef(state);
  if (!source || !state.resolveCollection) {
    throw new RuleError(
      `relation traversal "${fullName}" requires collection metadata`,
      node.line,
      node.column,
    );
  }

  const hops: TraversalHop[] = [];
  let current: RuleCollectionRef | null = null; // null = the owning collection
  for (let i = 0; i < segments.length - 1; i++) {
    const name = segments[i];
    assertNotPassword(name, node);
    const field = findField(current ?? source, name);
    if (!field) {
      throw unknownFieldError(current, name, node);
    }
    if (field.type !== "relation") {
      throw new RuleError(
        `cannot traverse "${fullName}": field "${name}" is not a relation`,
        node.line,
        node.column,
      );
    }
    if (!field.collectionId) {
      throw new RuleError(
        `relation field "${name}" has no target collection`,
        node.line,
        node.column,
      );
    }
    const target = state.resolveCollection(field.collectionId);
    if (!target) {
      throw new RuleError(
        `relation field "${name}" points to a collection that does not exist`,
        node.line,
        node.column,
      );
    }
    hops.push({ field, target });
    current = target;
  }

  const finalName = segments[segments.length - 1];
  assertNotPassword(finalName, node);
  const finalField = findField(current ?? source, finalName);
  if (!finalField) {
    throw unknownFieldError(current, finalName, node);
  }
  assertUsableFieldType(finalField.type, fullName, node);

  for (const hop of hops) state.dependencies.add(hop.target.id);

  // aliases are numbered outermost-first but emitted innermost-first, so the
  // same rule always yields the same SQL text
  const build = (level: number, outerRef: string): string => {
    const hop = hops[level];
    const alias = nextAlias(state);
    const inner =
      level === hops.length - 1
        ? `${alias}.${quoteIdent(finalName)}`
        : build(level + 1, `${alias}.${quoteIdent(hops[level + 1].field.name)}`);
    return `(SELECT ${inner} FROM ${quoteIdent(hop.target.name)} AS ${alias} WHERE ${alias}."id" = ${outerRef})`;
  };

  let sql: string;
  if (state.action === "create") {
    // candidate row: the first hop reads the submitted relation value
    state.slots.push({ kind: "record", path: hops[0].field.name });
    sql = build(0, "?");
  } else {
    sql = build(
      0,
      `${quoteIdent(source.name)}.${quoteIdent(hops[0].field.name)}`,
    );
  }
  return {
    sql,
    kind: kindsForType(finalField.type),
    describe: `${finalField.type} field "${fullName}"`,
  };
}

interface CollectionMacroTarget {
  collection: RuleCollectionRef;
  field: RuleField;
  describe: string;
}

function resolveCollectionMacro(
  node: MacroRef,
  state: CompileState,
): CollectionMacroTarget {
  const segments = node.segments;
  if (segments.length < 3) {
    throw new RuleError(
      '@collection requires a collection and a field, e.g. "@collection.posts.id"',
      node.line,
      node.column,
    );
  }
  if (segments.length > 3) {
    throw new RuleError(
      "@collection paths cannot be nested",
      node.line,
      node.column,
    );
  }
  if (!state.sourceName || !state.resolveCollection) {
    throw new RuleError(
      "@collection.* requires collection metadata",
      node.line,
      node.column,
    );
  }
  const [, collectionName, fieldName] = segments;
  const collection = state.resolveCollection(collectionName);
  if (!collection) {
    throw new RuleError(
      `unknown collection "${collectionName}"`,
      node.line,
      node.column,
    );
  }
  assertNotPassword(fieldName, node);
  const field = findField(collection, fieldName);
  if (!field) {
    throw new RuleError(
      `unknown field "${fieldName}" on collection "${collection.name}"`,
      node.line,
      node.column,
    );
  }
  assertUsableFieldType(field.type, fieldName, node);
  return {
    collection,
    field,
    describe: `@collection.${collection.name}.${fieldName} (${field.type})`,
  };
}

/**
 * `@collection.<name>.<field> OP value` compiles to
 *
 *   EXISTS (SELECT 1 FROM "<name>" AS __rel0 WHERE __rel0."<field>" OP value)
 *
 * i.e. "at least one row satisfies the comparison". With the macro on the
 * right the inner comparison is flipped (`outer > macro` ⇔ `field < outer`).
 * The non-macro operand is qualified with the owning table name so plain
 * field refs cannot rebind to the subquery's table.
 */
function compileCollectionComparison(
  node: ComparisonExpr,
  state: CompileState,
  leftMacro: boolean,
  rightMacro: boolean,
): string {
  if (leftMacro && rightMacro) {
    throw new RuleError(
      "cannot compare two @collection.* expressions",
      node.line,
      node.column,
    );
  }
  const macroNode = (leftMacro ? node.left : node.right) as MacroRef;
  const target = resolveCollectionMacro(macroNode, state);
  state.dependencies.add(target.collection.id);

  const alias = nextAlias(state);
  const macroOperand: OperandInfo = {
    sql: `${alias}.${quoteIdent(target.field.name)}`,
    kind: kindsForType(target.field.type),
    describe: target.describe,
  };

  let op = node.op;
  if (!leftMacro) {
    if (op === "~" || op === "!~") {
      throw new RuleError(
        `"${op}" is not supported with @collection.* on the right`,
        node.line,
        node.column,
      );
    }
    op = invertComparisonOp(op);
  }

  const like = op === "~" || op === "!~";
  const other = compileValue(leftMacro ? node.right : node.left, state, like, true);
  const comparison = buildComparisonSql(op, macroOperand, other, node);
  return `(EXISTS (SELECT 1 FROM ${quoteIdent(target.collection.name)} AS ${alias} WHERE ${comparison}))`;
}

function compileModifier(node: ModifierRef, state: CompileState): OperandInfo {
  const modifier = node.modifier;
  if (node.base.segments[0] === "collection") {
    throw new RuleError(
      "modifiers are not supported on @collection.*",
      node.line,
      node.column,
    );
  }
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
  qualifyFields = false,
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
      if (node.path && node.path.length > 0) {
        return compileFieldPath(node, state);
      }
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
      // inside a @collection.* EXISTS, plain field refs are qualified with the
      // owning table name so they cannot rebind to the subquery's table
      const sql =
        qualifyFields && state.sourceName
          ? `${quoteIdent(state.sourceName)}.${quoteIdent(node.name)}`
          : quoteIdent(node.name);
      return {
        sql,
        kind: kindsForType(type),
        describe: `${type} field "${node.name}"`,
      };
    }

    case "macro": {
      if (isCollectionMacro(node)) {
        // @collection.* is intercepted by compileComparison; reaching here
        // means it was used outside a comparison
        throw new RuleError(
          "@collection.* must be compared with a field or value",
          node.line,
          node.column,
        );
      }
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
  const leftMacro = isCollectionMacro(node.left);
  const rightMacro = isCollectionMacro(node.right);
  if (leftMacro || rightMacro) {
    return compileCollectionComparison(node, state, leftMacro, rightMacro);
  }

  const like = node.op === "~" || node.op === "!~";
  const left = compileValue(node.left, state);
  const right = compileValue(node.right, state, like);
  return buildComparisonSql(node.op, left, right, node);
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

export interface CompileRuleSetOptions {
  /** implicit id/createdAt/updatedAt columns are addressable (false for views) */
  implicitFields?: boolean;
  /**
   * Physical name of the collection owning the rules. Enables relation
   * traversal: correlated references qualify with this table name.
   */
  sourceCollectionName?: string;
  /**
   * Preloaded metadata resolver for relation targets and `@collection.*`
   * references (id or name). Keeps compilation pure and synchronous.
   */
  resolveCollection?: (idOrName: string) => RuleCollectionRef | null;
}

function newState(
  action: RuleAction,
  fields: Map<string, RuleField>,
  options: CompileRuleSetOptions,
): CompileState {
  return {
    action,
    fields,
    slots: [],
    implicitFields: options.implicitFields !== false,
    sourceName: options.sourceCollectionName,
    resolveCollection: options.resolveCollection,
    dependencies: new Set(),
    aliasSeq: 0,
  };
}

/** Attaches the referenced-collection list (only when non-empty). */
function finishArtifact(state: CompileState, sql: string): CompiledRule {
  const collections = [...state.dependencies].sort();
  return collections.length > 0
    ? { sql, slots: state.slots, collections }
    : { sql, slots: state.slots };
}

/** Compiles a single rule for one action; throws `RuleError` on any violation. */
export function compileRule(
  source: string,
  action: RuleAction,
  fields: RuleField[],
  options: CompileRuleSetOptions = {},
): CompiledRule {
  const ast = parseRule(source);
  const state = newState(action, fieldMapOf(fields), options);
  const sql = compileExpr(ast, state);
  return finishArtifact(state, sql);
}

/**
 * Collection ids referenced by a compiled rule set (relation traversals and
 * `@collection.*`), deduplicated and sorted. Used for cross-collection
 * invalidation on rename/field change/delete.
 */
export function ruleDependencies(compiled: CompiledRuleSet): string[] {
  const ids = new Set<string>();
  for (const key of RULE_KEYS) {
    for (const id of compiled[key]?.collections ?? []) ids.add(id);
  }
  return [...ids].sort();
}

export interface CompileRuleSetResult {
  compiled: CompiledRuleSet;
  errors: RuleCompileError[];
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
      const state = newState(ACTION_BY_RULE[key], fieldMap, options);
      compiled[key] = finishArtifact(state, compileExpr(ast, state));
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
