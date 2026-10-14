import { Database } from "bun:sqlite";

export type { Database as RawDatabase };

function toPositional(sql: string): string {
  return sql.replace(/\?\d+/g, "?");
}

class BoundStatement {
  constructor(
    private db: Database,
    private sql: string,
    private params: unknown[],
  ) {}

  async first(): Promise<Record<string, unknown> | null> {
    const row = this.db.query(this.sql).get(...this.params) as Record<
      string,
      unknown
    > | null;
    return row ?? null;
  }

  async all(): Promise<{ results: Record<string, unknown>[] }> {
    const rows = this.db.query(this.sql).all(...this.params) as Record<
      string,
      unknown
    >[];
    return { results: rows };
  }

  async run(): Promise<{ success: boolean }> {
    this.db.query(this.sql).run(...this.params);
    return { success: true };
  }
}

class PreparedStatement {
  constructor(
    private db: Database,
    private sql: string,
  ) {}

  bind(...params: unknown[]): BoundStatement {
    return new BoundStatement(this.db, toPositional(this.sql), params);
  }

  first(): Promise<Record<string, unknown> | null> {
    return this.bind().first();
  }

  all(): Promise<{ results: Record<string, unknown>[] }> {
    return this.bind().all();
  }

  run(): Promise<{ success: boolean }> {
    return this.bind().run();
  }
}

export interface TestDb {
  db: D1Database;
  raw: Database;
}

// Structural D1Database replacement backed by in-memory SQLite.
// Supports the surface used by the services: prepare/bind/first/all/run/batch.
export function createTestDb(): TestDb {
  const raw = new Database(":memory:");
  const db = {
    prepare: (sql: string) => new PreparedStatement(raw, sql),
    batch: async (statements: BoundStatement[]) => {
      // D1 executes batches atomically; mirror that with a transaction so a
      // failing statement rolls back the whole batch.
      raw.exec("BEGIN");
      try {
        const results = [];
        for (const stmt of statements) {
          results.push(await stmt.run());
        }
        raw.exec("COMMIT");
        return results;
      } catch (err) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          // ignore rollback errors, the original error matters
        }
        throw err;
      }
    },
    exec: async (sql: string) => {
      raw.exec(sql);
    },
  };
  return { db: db as unknown as D1Database, raw };
}
