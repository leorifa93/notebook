import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";

import { handleDeleteDocument, handleListDocuments } from "@/app/api/documents/handler";
import { handleIngest } from "@/app/api/ingest/handler";
import type { Database, Queryable } from "@/lib/db";
import {
  DuplicateDocumentError,
  insertDocumentWithChunks,
  type DocumentSummary,
} from "@/lib/documents";
import { toSqlVector } from "@/lib/embeddings";
import { ConfigError } from "@/lib/env";
import { DEFAULT_LIMITS, type IngestDeps } from "@/lib/ingest";
import { DEFAULT_NOTEBOOK_ID } from "@/lib/notebooks";
import { INGEST_RATE_LIMIT } from "@/lib/rate-limit";
import { HYBRID_SQL } from "@/lib/retrieval";

import { stubEmbed, stubEmbedding } from "../helpers/embeddings";
import { fileFrom, readFixture, uploadRequest } from "../helpers/fixtures";
import { createTestDatabase } from "../helpers/pglite";

/**
 * Ingest von der Anfrage bis zur Zeile in Postgres.
 *
 * Echt: Parser, Chunking, SQL, Transaktion, Cascade, Rate-Limit (PGlite mit
 * db/schema.sql). Gestubbt: nur die Embeddings, weil die CI keinen Key hat.
 */

let db: PGlite;
let deps: IngestDeps;

beforeAll(async () => {
  db = await createTestDatabase();
}, 30_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM documents; DELETE FROM rate_limit_events;");
  deps = { db, embed: stubEmbed };
});

async function count(table: "documents" | "chunks"): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]?.n ?? -1;
}

async function uploadMietvertrag(target: IngestDeps = deps): Promise<Response> {
  const bytes = await readFixture("muster-mietvertrag.pdf");
  return handleIngest(
    uploadRequest(fileFrom(bytes, "muster-mietvertrag.pdf", "application/pdf")),
    target,
  );
}

describe("POST /api/ingest: Erfolg", () => {
  it("speichert das Fixture-PDF mit 201, Seitenzahlen und Originaldatei", async () => {
    const response = await uploadMietvertrag();
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      title: string;
      sourceType: string;
      pageCount: number;
      chunkCount: number;
    };
    expect(body).toMatchObject({
      title: "muster-mietvertrag",
      sourceType: "pdf",
      pageCount: 6,
    });
    expect(body.chunkCount).toBeGreaterThanOrEqual(6);

    const { rows } = await db.query<{ size: number; mime_type: string; notebook_id: string }>(
      "SELECT octet_length(file_bytes) AS size, mime_type, notebook_id::text FROM documents WHERE id = $1",
      [body.id],
    );
    const original = await readFixture("muster-mietvertrag.pdf");
    expect(rows[0]).toEqual({
      size: original.byteLength,
      mime_type: "application/pdf",
      notebook_id: DEFAULT_NOTEBOOK_ID,
    });
  });

  it("schreibt jeden Chunk mit der Seite, auf der sein Text steht", async () => {
    await uploadMietvertrag();
    const { rows } = await db.query<{ page: number; content: string }>(
      "SELECT page, content FROM chunks ORDER BY chunk_index",
    );
    const pagesWith = (needle: string): number[] =>
      rows.filter((row) => row.content.includes(needle)).map((row) => row.page);
    expect(pagesWith("3.450 Euro")).toEqual([2]);
    expect(pagesWith("Gerichtsstand ist Köln")).toEqual([3]);
    expect(rows.every((row) => row.page >= 1 && row.page <= 6)).toBe(true);
  });

  it("nimmt Markdown an und speichert die Chunks ohne Seitenzahl", async () => {
    const response = await handleIngest(
      uploadRequest(fileFrom("# Notizen\n\nDie Kaution beträgt 3.450 Euro.", "notizen.md", "")),
      deps,
    );
    expect(response.status).toBe(201);
    const { rows } = await db.query<{ page: number | null; source_type: string; page_count: number }>(
      "SELECT c.page, d.source_type, d.page_count FROM chunks c JOIN documents d ON d.id = c.document_id",
    );
    expect(rows).toEqual([{ page: null, source_type: "markdown", page_count: 0 }]);
  });

  it("nimmt .txt an", async () => {
    const response = await handleIngest(
      uploadRequest(fileFrom("Kurzer Text.", "notiz.txt", "text/plain")),
      deps,
    );
    expect(response.status).toBe(201);
  });

  it("bettet Kontext-Header plus Inhalt ein, zitiert aber nur den Inhalt", async () => {
    const seen: string[] = [];
    await uploadMietvertrag({
      db,
      embed: async (texts) => {
        seen.push(...texts);
        return stubEmbed(texts);
      },
    });
    expect(seen[0]?.startsWith("muster-mietvertrag · Seite 1\n\n")).toBe(true);
    const { rows } = await db.query<{ content: string }>(
      "SELECT content FROM chunks WHERE chunk_index = 0",
    );
    expect(rows[0]?.content.startsWith("muster-mietvertrag")).toBe(false);
  });
});

describe("POST /api/ingest: Ablehnungen ohne Zeile in documents", () => {
  async function expectRejected(response: Response, status: number): Promise<void> {
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/\p{L}/u);
    expect(body.error).not.toMatch(/at \S+ \(/);
    expect(await count("documents")).toBe(0);
  }

  it("lehnt das Scan-Fixture mit 422 ab", async () => {
    const bytes = await readFixture("scan-beispiel.pdf");
    await expectRejected(
      await handleIngest(uploadRequest(fileFrom(bytes, "scan.pdf", "application/pdf")), deps),
      422,
    );
  });

  it("lehnt eine Textdatei ohne Inhalt mit 422 ab", async () => {
    await expectRejected(
      await handleIngest(uploadRequest(fileFrom("   \n\n ", "leer.txt", "text/plain")), deps),
      422,
    );
  });

  it("lehnt eine Datei über dem Größenlimit mit 413 ab", async () => {
    await expectRejected(
      await uploadMietvertrag({ ...deps, limits: { ...DEFAULT_LIMITS, maxFileBytes: 1024 } }),
      413,
    );
  });

  it("lehnt ein PDF über dem Seitenlimit mit 413 ab", async () => {
    await expectRejected(
      await uploadMietvertrag({ ...deps, limits: { ...DEFAULT_LIMITS, maxPdfPages: 5 } }),
      413,
    );
  });

  it("lehnt eine Quelle mit mehr Abschnitten als erlaubt mit 413 ab, ohne einzubetten", async () => {
    let embedCalls = 0;
    await expectRejected(
      await uploadMietvertrag({
        db,
        embed: async (texts) => {
          embedCalls += 1;
          return stubEmbed(texts);
        },
        limits: { ...DEFAULT_LIMITS, maxChunks: 3 },
      }),
      413,
    );
    expect(embedCalls).toBe(0);
  });

  it("begrenzt auch Textdateien: 4 MB Text überschreiten das Standardlimit", async () => {
    const paragraph = "Die Miete ist bis zum dritten Werktag des Monats zu zahlen. ".repeat(10);
    const text = `${paragraph}\n\n`.repeat(Math.floor((3.9 * 1024 * 1024) / (paragraph.length + 2)));
    await expectRejected(
      await handleIngest(uploadRequest(fileFrom(text, "gross.txt", "text/plain")), deps),
      413,
    );
  });

  it("lehnt Office-Dateien mit 415 ab", async () => {
    await expectRejected(
      await handleIngest(
        uploadRequest(fileFrom("x", "tabelle.xlsx", "application/vnd.ms-excel")),
        deps,
      ),
      415,
    );
  });

  it("lehnt eine kaputte PDF-Datei mit 400 ab", async () => {
    await expectRejected(
      await handleIngest(
        uploadRequest(fileFrom(new Uint8Array([37, 80, 68, 70]), "kaputt.pdf", "application/pdf")),
        deps,
      ),
      400,
    );
  });

  it("lehnt eine leere Datei mit 400 ab", async () => {
    await expectRejected(
      await handleIngest(uploadRequest(fileFrom("", "leer.pdf", "application/pdf")), deps),
      400,
    );
  });

  it("meldet einen Embedding-Ausfall als 502 und speichert nichts", async () => {
    await expectRejected(
      await uploadMietvertrag({
        db,
        embed: async () => {
          throw new Error("quota exceeded");
        },
      }),
      502,
    );
  });

  it("meldet einen fehlenden Key als 503, ohne zum erneuten Versuch zu raten (R8)", async () => {
    const response = await uploadMietvertrag({
      db,
      embed: async () => {
        throw new ConfigError("OPENAI_API_KEY ist nicht gesetzt.");
      },
    });
    const body = (await response.clone().json()) as { error?: string };
    expect(body.error).not.toMatch(/versuche es/i);
    expect(body.error).toContain("hilft nicht");
    expect(body.error).toContain("nicht vollständig eingerichtet");
    await expectRejected(response, 503);
  });
});

describe("Doppelter Upload", () => {
  it("lehnt dieselbe Datei im selben Notebook mit 409 ab, ohne erneut einzubetten", async () => {
    expect((await uploadMietvertrag()).status).toBe(201);
    let embedCalls = 0;
    const second = await uploadMietvertrag({
      db,
      embed: async (texts) => {
        embedCalls += 1;
        return stubEmbed(texts);
      },
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error?: string };
    expect(body.error).toContain("muster-mietvertrag");
    expect(embedCalls).toBe(0);
    expect(await count("documents")).toBe(1);
  });

  it("nimmt eine Datei mit anderem Namen, aber gleichem Inhalt nicht doppelt an", async () => {
    await handleIngest(uploadRequest(fileFrom("Gleicher Text.", "a.txt", "text/plain")), deps);
    const response = await handleIngest(
      uploadRequest(fileFrom("Gleicher Text.", "b.txt", "text/plain")),
      deps,
    );
    expect(response.status).toBe(409);
  });

  it("fängt den Wettlauf zweier gleichzeitiger Uploads über den eindeutigen Index ab", async () => {
    // Simuliert den Fall, dass beide Vorabprüfungen „frei" sahen: Das zweite
    // Insert mit gleichem Hash muss am Index scheitern, nicht still durchgehen.
    const document = {
      notebookId: DEFAULT_NOTEBOOK_ID,
      title: "x",
      sourceType: "text" as const,
      mimeType: "text/plain",
      pageCount: 0,
      fileBytes: new Uint8Array([1]),
      contentSha256: "a".repeat(64),
    };
    const chunk = { page: null, chunkIndex: 0, content: "x", tokenCount: 1, contextHeader: "x" };
    await insertDocumentWithChunks(db, document, [chunk], [stubEmbedding("x")]);
    await expect(
      insertDocumentWithChunks(db, document, [chunk], [stubEmbedding("x")]),
    ).rejects.toBeInstanceOf(DuplicateDocumentError);
    expect(await count("documents")).toBe(1);
  });
});

describe("Transaktion", () => {
  it("lässt kein Dokument ohne Chunks zurück, wenn das Chunk-Insert scheitert", async () => {
    // Echte Transaktion von PGlite, nur das Chunk-Insert schlägt fehl.
    const failingChunks: Database = {
      query: (text, params) => db.query(text, params),
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            query: <T extends QueryResultRow>(text: string, params?: unknown[]) => {
              if (text.includes("INSERT INTO chunks")) {
                return Promise.reject(new Error("simulierter Abbruch"));
              }
              return tx.query<T>(text, params);
            },
          } satisfies Queryable),
        ),
    };
    const response = await uploadMietvertrag({ db: failingChunks, embed: stubEmbed });
    expect(response.status).toBe(500);
    expect(await count("documents")).toBe(0);
    expect(await count("chunks")).toBe(0);
  });
});

describe("GET /api/documents und DELETE /api/documents/:id", () => {
  async function list(): Promise<DocumentSummary[]> {
    const response = await handleListDocuments(db);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      notebook: { id: string; title: string };
      documents: DocumentSummary[];
    };
    expect(body.notebook).toEqual({ id: DEFAULT_NOTEBOOK_ID, title: "Demo" });
    return body.documents;
  }

  it("listet hochgeladene Quellen mit Titel, Seiten- und Chunk-Anzahl", async () => {
    expect(await list()).toEqual([]);
    const created = (await (await uploadMietvertrag()).json()) as { id: string; chunkCount: number };
    const documents = await list();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      id: created.id,
      title: "muster-mietvertrag",
      sourceType: "pdf",
      pageCount: 6,
      chunkCount: created.chunkCount,
    });
    expect(Number.isNaN(Date.parse(documents[0]?.createdAt ?? ""))).toBe(false);
  });

  it("löscht eine Quelle samt Chunks (Cascade)", async () => {
    const created = (await (await uploadMietvertrag()).json()) as { id: string };
    expect(await count("chunks")).toBeGreaterThan(0);
    const response = await handleDeleteDocument(db, created.id);
    expect(response.status).toBe(200);
    expect(await count("documents")).toBe(0);
    expect(await count("chunks")).toBe(0);
    expect(await list()).toEqual([]);
  });

  it("antwortet 404 für eine unbekannte und 400 für eine ungültige ID", async () => {
    expect((await handleDeleteDocument(db, "00000000-0000-4000-8000-00000000abcd")).status).toBe(
      404,
    );
    expect((await handleDeleteDocument(db, "nicht-eine-uuid")).status).toBe(400);
  });
});

describe("Rate-Limit am Ingest", () => {
  it("weist die neunte Anfrage derselben IP innerhalb von 15 Minuten mit 429 ab", async () => {
    const headers = { "x-forwarded-for": "198.51.100.23" };
    const statuses: number[] = [];
    for (let i = 0; i < INGEST_RATE_LIMIT.limit + 1; i += 1) {
      const response = await handleIngest(
        uploadRequest(fileFrom(`Notiz ${i}`, `notiz-${i}.txt`, "text/plain"), headers),
        deps,
      );
      statuses.push(response.status);
      if (response.status === 429) {
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      }
    }
    expect(statuses).toEqual([...new Array<number>(INGEST_RATE_LIMIT.limit).fill(201), 429]);

    const other = await handleIngest(
      uploadRequest(fileFrom("Notiz", "notiz.txt", "text/plain"), {
        "x-forwarded-for": "198.51.100.99",
      }),
      deps,
    );
    expect(other.status).toBe(201);
  });
});

describe("Hybrid-SQL aus lib/retrieval.ts gegen gespeicherte Chunks", () => {
  it("findet die Kaution auf Seite 2 und respektiert die Quellenauswahl", async () => {
    const vertrag = (await (await uploadMietvertrag()).json()) as { id: string };
    const notiz = (await (
      await handleIngest(
        uploadRequest(fileFrom("Die Katze heißt Mimi.", "notiz.txt", "text/plain")),
        deps,
      )
    ).json()) as { id: string };

    const question = "Wie hoch ist die Kaution insgesamt?";
    const run = async (documentIds: string[]) =>
      (
        await db.query<{ document_id: string; page: number | null; content: string }>(HYBRID_SQL, [
          toSqlVector(stubEmbedding(question)),
          20,
          documentIds,
          question,
          60,
          5,
        ])
      ).rows;

    const all = await run([vertrag.id, notiz.id]);
    expect(all[0]?.page).toBe(2);
    expect(all[0]?.content).toContain("3.450 Euro");

    const onlyNote = await run([notiz.id]);
    expect(onlyNote.every((row) => row.document_id === notiz.id)).toBe(true);

    const onlyContract = await run([vertrag.id]);
    expect(onlyContract.every((row) => row.document_id === vertrag.id)).toBe(true);
  });
});
