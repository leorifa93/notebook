import type { Database } from "@/lib/db";

/**
 * Fehler in der Form, wie `pg` und Node sie werfen: eine `Error` mit
 * `code` (SQLSTATE wie `28P01` oder Node-Code wie `ENOTFOUND`).
 */
export function dbError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

/** Datenbank, bei der jede Abfrage und jede Transaktion mit `error` scheitert. */
export function failingDatabase(error: Error): Database {
  return {
    query: async () => {
      throw error;
    },
    transaction: async () => {
      throw error;
    },
  };
}
