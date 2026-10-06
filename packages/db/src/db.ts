import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import postgres from "postgres";

export type Db = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a multi-statement script without params (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: "pglite" | "postgres";
};

/** Postgres via DATABASE_URL, else PGlite at PGLITE_DIR (default ./.pglite), or in-memory with `memory: true`. */
export async function createDb(opts: { memory?: boolean } = {}): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url && !opts.memory) {
    const sql = postgres(url, { onnotice: () => {} });
    return {
      kind: "postgres",
      query: async <T>(text: string, params: unknown[] = []) =>
        [...(await sql.unsafe(text, params as never[]))] as T[],
      exec: async (text) => {
        await sql.unsafe(text);
      },
      close: () => sql.end(),
    };
  }
  const pg = await PGlite.create(opts.memory ? "memory://" : (process.env.PGLITE_DIR ?? ".pglite"), {
    extensions: { vector },
  });
  return {
    kind: "pglite",
    query: async <T>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows,
    exec: async (text) => {
      await pg.exec(text);
    },
    close: () => pg.close(),
  };
}

/** Apply schema.sql. Idempotent (`if not exists` everywhere). */
export async function migrate(db: Db): Promise<void> {
  await db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
}
