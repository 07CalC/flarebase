// Minimal ambient declarations so `tsc --noEmit` passes on the test harness.
// Runtime implementations are provided by bun itself.

declare module "bun:sqlite" {
  export class Database {
    constructor(filename?: string, options?: Record<string, unknown>);
    query(sql: string): Statement;
    run(sql: string, ...params: unknown[]): void;
    exec(sql: string): void;
  }
  export interface Statement {
    get(...params: unknown[]): Record<string, unknown> | null;
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): void;
  }
}

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  // biome-ignore lint/suspicious/noExplicitAny: matcher chains are intentionally untyped
  export function expect(actual: unknown): any;
}
