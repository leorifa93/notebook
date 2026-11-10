import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import { databaseUrl } from "@/lib/env";

/**
 * Datenbankzugriff.
 *
 * Bewusst der einzige Ort im Repo, der `pg` importiert. Alles andere ruft
 * `query()` oder `withTransaction()` auf. Kein ORM: die Abfragen in
 * lib/retrieval.ts nutzen pgvector-Operatoren (`<=>`, `ts_rank_cd`), die ein
 * ORM nur umständlich durchreichen würde.
 *
 * Lazy statt Modul-Scope: `new Pool()` wird erst beim ersten Query erzeugt.
 * So baut `next build` ohne DATABASE_URL durch, statt beim Import zu
 * scheitern.
 */

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      // Serverless-freundlich: wenige Verbindungen pro Instanz. Die URL zeigt
      // bei Supabase auf den Pooler (Port 6543), nicht auf 5432: Vercel
      // Functions sind kurzlebig, der PgBouncer davor hält die Verbindungen.
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Ein Pooler oder Supabase trennt ruhende Verbindungen irgendwann. `pg`
    // meldet das als 'error' am Pool; ohne Listener wird daraus eine
    // uncaughtException, die die ganze Instanz reißen kann. Der Pool ersetzt
    // die Verbindung beim nächsten Query selbst, hier wird nur protokolliert.
    pool.on("error", (error) => {
      console.error("[db] idle client error", { error: error.message });
    });
  }
  return pool;
}

/**
 * Typsicherer Wrapper um `pool.query`.
 *
 * `pg` gibt `any`-Zeilen zurück; der generische Parameter ist die einzige
 * Stelle, an der wir dem Aufrufer vertrauen. Deshalb immer mit einem
 * expliziten Zeilentyp aufrufen, nie ohne.
 *
 * TODO(Schritt 2): Query-Logging mit Dauer ergänzen, sobald echte Last da ist.
 */
export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  const startedAt = Date.now();
  try {
    return await getPool().query<T>(text, params as unknown[]);
  } catch (error) {
    // Fehler mit Kontext anreichern, ohne das SQL-Log vollzuschreiben.
    console.error("[db] query failed", {
      durationMs: Date.now() - startedAt,
      statement: text.slice(0, 120).replace(/\s+/g, " "),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Kurzform für "genau eine Zeile oder null". */
export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

/**
 * Transaktion für mehrstufige Schreibvorgänge (Dokument + Chunks).
 *
 * Der Ingest schreibt erst das Dokument, dann alle Chunks. Bricht das
 * Chunk-Insert ab, darf kein Dokument ohne Chunks zurückbleiben — sonst
 * erscheint es als Quelle, die nichts beantworten kann.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Schmaler Query-Executor für die Schreib- und Listenfunktionen.
 *
 * Produktion verdrahtet `getDatabase()` (pg gegen den Supabase-Pooler), die
 * Tests eine PGlite-Instanz, die dieselbe Form hat. So laufen Insert,
 * Transaktion und Cascade in der CI gegen echtes Postgres, ohne dass Code
 * außerhalb dieser Datei `pg` kennt.
 */
export interface Queryable {
  query<T extends QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface Database extends Queryable {
  /** Commit bei Erfolg, Rollback bei jedem Fehler in `fn`. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Produktionsdatenbank; der Pool entsteht erst beim ersten Query. */
export function getDatabase(): Database {
  return {
    query: <T extends QueryResultRow>(text: string, params: unknown[] = []) =>
      query<T>(text, params),
    transaction: <T>(fn: (tx: Queryable) => Promise<T>) =>
      withTransaction((client) =>
        fn({
          query: <R extends QueryResultRow>(text: string, params: unknown[] = []) =>
            client.query<R>(text, params),
        }),
      ),
  };
}

/** Für Health-Checks und Skripte; schließt den Pool sauber. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
