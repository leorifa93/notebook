import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest für die reine Logik (Chunking, Prompt, Quellenerkennung).
 *
 * Bewusst ohne jsdom und ohne React-Testing: in Schritt 1 gibt es keine
 * Komponenten-Logik, die sich lohnt zu testen, aber viel Logik, die still
 * kaputtgehen kann. Datenbank-Tests folgen in Schritt 2 mit PGlite.
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
  },
});
