/**
 * Zentrale Konfiguration.
 *
 * Alle Env-Zugriffe laufen über diese Datei und werden erst beim Aufruf
 * ausgewertet, nie beim Import. Das ist der Grund, warum `next build` ohne
 * DATABASE_URL und ohne OPENAI_API_KEY durchläuft: der Build importiert die
 * Route-Handler, ruft sie aber nicht auf.
 */

export const EMBEDDING_MODEL_ID = "text-embedding-3-small";
/** text-embedding-3-small liefert fest 1536 Dimensionen — siehe db/schema.sql. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Default für den Chat; überschreibbar über CHAT_MODEL. */
export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

/** DATABASE_URL, sonst ein Fehler mit Hinweis auf die README. */
export function databaseUrl(): string {
  const value = readEnv("DATABASE_URL");
  if (!value) {
    throw new Error(
      "DATABASE_URL ist nicht gesetzt. Kopiere .env.example nach .env.local und trage die Postgres-URL ein.",
    );
  }
  return value;
}

/** OpenRouter/OpenAI-Key; Fehler erst beim ersten echten LLM-Aufruf. */
export function openAiApiKey(): string {
  const value = readEnv("OPENAI_API_KEY");
  if (!value) {
    throw new Error(
      "OPENAI_API_KEY ist nicht gesetzt. Ohne Key können keine Embeddings und keine Antworten erzeugt werden.",
    );
  }
  return value;
}

export function chatModelId(): string {
  return readEnv("CHAT_MODEL") ?? DEFAULT_CHAT_MODEL;
}

/** Optionaler Pfad zu einer lokalen PDF-Datei für den Beleg-Sprung im UI. */
export function publicBaseUrl(): string {
  return readEnv("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3000";
}
