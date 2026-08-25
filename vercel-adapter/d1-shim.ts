// D1-compatible shim over @libsql/client (Turso หรือ file: local)
// ครอบเฉพาะ API ที่โค้ดใน worker/ ใช้จริง: prepare().bind().first/all/run + db.batch()
import { createClient, type Client, type InArgs, type InStatement, type ResultSet } from "@libsql/client";

interface D1ResultLike<T = unknown> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number; duration: number };
}

function toResult<T>(rs: ResultSet): D1ResultLike<T> {
  return {
    results: rs.rows.map((row) => ({ ...row }) as T),
    success: true,
    meta: {
      changes: rs.rowsAffected,
      last_row_id: Number(rs.lastInsertRowid ?? 0),
      duration: 0,
    },
  };
}

class ShimStatement {
  constructor(
    private readonly client: Client,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): ShimStatement {
    return new ShimStatement(this.client, this.sql, args);
  }

  toInStatement(): InStatement {
    return { sql: this.sql, args: this.args as InArgs };
  }

  async run<T = unknown>(): Promise<D1ResultLike<T>> {
    return toResult<T>(await this.client.execute(this.toInStatement()));
  }

  async all<T = unknown>(): Promise<D1ResultLike<T>> {
    return this.run<T>();
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const rs = await this.client.execute(this.toInStatement());
    const row = rs.rows[0];
    if (row === undefined) return null;
    if (column !== undefined) {
      const value = (row as Record<string, unknown>)[column];
      return (value === undefined ? null : value) as T | null;
    }
    return { ...row } as T;
  }
}

export function createD1Shim(url: string, authToken?: string) {
  const client = createClient(authToken ? { url, authToken } : { url });
  return {
    prepare(sql: string) {
      return new ShimStatement(client, sql);
    },
    async batch(statements: ShimStatement[]) {
      const results = await client.batch(
        statements.map((statement) => statement.toInStatement()),
        "write",
      );
      return results.map((rs) => toResult(rs));
    },
    client,
  };
}

export type D1Shim = ReturnType<typeof createD1Shim>;
