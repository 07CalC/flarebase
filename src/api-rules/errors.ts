import type { RuleKey } from "./types";

/**
 * A syntax or validation error raised while lexing, parsing or compiling a
 * rule. Carries the source position so collection save can aggregate readable
 * messages across all five rules.
 */
export class RuleError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = "RuleError";
  }
}

export interface RuleCompileError {
  rule: RuleKey;
  message: string;
  line: number;
  column: number;
}

/** `listRule: unknown field "ownr" (line 1, column 1); viewRule: …` */
export function formatRuleErrors(errors: RuleCompileError[]): string {
  return errors
    .map((e) => `${e.rule}: ${e.message} (line ${e.line}, column ${e.column})`)
    .join("; ");
}
