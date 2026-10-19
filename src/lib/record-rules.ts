import { resolveRule } from "../api-rules";
import type { RuleAction, RuleKey } from "../api-rules";
import type { AuthContext } from "../config";
import type { CompiledCollection } from "../services/collection.service";
import { AppError, ResponseCode } from "./response";
import type { SqlFilter } from "./sql-query";

const RULE_KEY_BY_ACTION: Record<RuleAction, RuleKey> = {
  list: "listRule",
  view: "viewRule",
  create: "createRule",
  update: "updateRule",
  delete: "deleteRule",
};

// only superuser can access
function locked(): never {

  throw new AppError("Superuser access required", 403, ResponseCode.FORBIDDEN);
}

export function assertRuleAllowsAction(
  collection: CompiledCollection,
  action: RuleAction,
  auth: AuthContext | null,
): void {
  if (auth?.isSuperUser) return;
  if (collection[RULE_KEY_BY_ACTION[action]] == null) locked();
}

export interface RuleFilterContext {
  body?: Record<string, unknown> | null;
  record?: Record<string, unknown> | null;
  now?: string;
}

export function buildRuleFilter(
  collection: CompiledCollection,
  action: RuleAction,
  auth: AuthContext | null,
  context: RuleFilterContext = {},
): SqlFilter | null {
  if (auth?.isSuperUser) return null;

  const key = RULE_KEY_BY_ACTION[action];
  const rawRule = collection[key];
  if (rawRule == null) locked();
  if (rawRule === "") return null;

  const artifact = collection.compiledRules[key];
  if (!artifact) {
    throw new AppError(
      `Corrupt collection metadata (compiledRules.${key})`,
      500,
      ResponseCode.DATABASE_ERROR,
    );
  }

  return resolveRule(artifact, {
    auth: { user: auth?.user ?? null },
    body: context.body ?? null,
    record: context.record ?? null,
    now: context.now,
  });
}
