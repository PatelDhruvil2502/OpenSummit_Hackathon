import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import * as schema from "./schema";

const DEFAULT_POOL_SIZE = 10;
const MIN_POOL_SIZE = 1;
const MAX_POOL_SIZE = 20;

type PoolGlobal = typeof globalThis & {
  __wageShieldPostgresPool?: Pool;
};

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "DATABASE_URL is required. Set it to the Render PostgreSQL internal connection URL.",
    );
  }
  if (!/^postgres(?:ql)?:\/\//i.test(value)) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
  }
  return value;
}

function poolSize(): number {
  const configured = Number.parseInt(process.env.DATABASE_POOL_MAX ?? "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_POOL_SIZE;
  return Math.min(MAX_POOL_SIZE, Math.max(MIN_POOL_SIZE, configured));
}

/**
 * Returns one process-wide pool. Keeping it on globalThis prevents Next.js
 * development reloads from opening a new set of connections on every edit.
 */
export function getPool(): Pool {
  const globalState = globalThis as PoolGlobal;
  if (!globalState.__wageShieldPostgresPool) {
    const pool = new Pool({
      connectionString: databaseUrl(),
      max: poolSize(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: false,
      application_name: "wageshield",
    });
    // node-postgres emits idle-client failures on the pool. Registering a
    // redacted handler prevents an unhandled EventEmitter error from exiting
    // the service while avoiding connection-string or query disclosure.
    pool.on("error", () => {
      console.error(JSON.stringify({ event: "postgres_idle_client_error" }));
    });
    globalState.__wageShieldPostgresPool = pool;
  }
  return globalState.__wageShieldPostgresPool;
}

/** Drizzle remains available for schema-aware queries and migrations. */
export function getDb() {
  return drizzle(getPool(), { schema });
}

export interface DatabaseExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  queryOne<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<Row | null>;
  execute(sql: string, parameters?: readonly unknown[]): Promise<number>;
}

function executor(target: Pool | PoolClient): DatabaseExecutor {
  return {
    async query<Row extends QueryResultRow = QueryResultRow>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      return target.query<Row>(sql, [...parameters]);
    },
    async queryOne<Row extends QueryResultRow = QueryResultRow>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row | null> {
      const result = await target.query<Row>(sql, [...parameters]);
      return result.rows[0] ?? null;
    },
    async execute(sql: string, parameters: readonly unknown[] = []): Promise<number> {
      const result = await target.query(sql, [...parameters]);
      return result.rowCount ?? 0;
    },
  };
}

export function query<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  parameters?: readonly unknown[],
): Promise<QueryResult<Row>> {
  return executor(getPool()).query<Row>(sql, parameters);
}

export function queryOne<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  parameters?: readonly unknown[],
): Promise<Row | null> {
  return executor(getPool()).queryOne<Row>(sql, parameters);
}

export function execute(sql: string, parameters?: readonly unknown[]): Promise<number> {
  return executor(getPool()).execute(sql, parameters);
}

/**
 * Runs all callback queries on one connection and commits them atomically.
 * Throwing from the callback rolls the transaction back before rethrowing.
 */
export async function transaction<Result>(
  callback: (database: DatabaseExecutor) => Promise<Result>,
): Promise<Result> {
  const client = await getPool().connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await callback(executor(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Preserve the application error that caused the rollback. A broken
      // connection is explicitly discarded when it is released below.
      releaseError =
        rollbackError instanceof Error ? rollbackError : new Error("PostgreSQL rollback failed");
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

/** Intended for migration commands and one-shot cron/test processes. */
export async function closePool(): Promise<void> {
  const globalState = globalThis as PoolGlobal;
  const pool = globalState.__wageShieldPostgresPool;
  if (!pool) return;
  delete globalState.__wageShieldPostgresPool;
  await pool.end();
}
