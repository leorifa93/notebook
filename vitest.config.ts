import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest für Logik und Datenbankpfad (Chunking, Prompt, Parser, Ingest).
 *
 * Bewusst ohne jsdom und ohne React-Testing: die Fehler, die still bleiben,
 * stecken in Parsing, Chunking und SQL, nicht in den Komponenten.
 * Datenbank-Tests laufen gegen PGlite (tests/helpers/pglite.ts), ohne Netz
 * und ohne Secrets.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // PGlite startet pro Testdatei ein WASM-Postgres; das dauert ein, zwei
    // Sekunden und ist auf langsamen CI-Runnern mehr als der Default.
    hookTimeout: 30_000,
  },
});
