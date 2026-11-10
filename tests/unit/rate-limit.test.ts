import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { clientIp, consumeRateLimit, type RateLimitRule } from "@/lib/rate-limit";

import { createTestDatabase } from "../helpers/pglite";

const RULE: RateLimitRule = { endpoint: "ingest", limit: 3, windowSeconds: 900 };

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
}, 30_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM rate_limit_events");
});

describe("consumeRateLimit", () => {
  it("lässt bis zum Limit durch und weist die nächste Anfrage ab", async () => {
    const results = [];
    for (let i = 0; i < RULE.limit + 1; i += 1) {
      results.push(await consumeRateLimit(db, "1.2.3.4", RULE));
    }
    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false]);
    const last = results.at(-1);
    expect(last?.retryAfterSeconds).toBeGreaterThan(0);
    expect(last?.retryAfterSeconds).toBeLessThanOrEqual(RULE.windowSeconds);
  });

  it("trägt abgewiesene Anfragen nicht ein", async () => {
    for (let i = 0; i < RULE.limit + 3; i += 1) {
      await consumeRateLimit(db, "1.2.3.4", RULE);
    }
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM rate_limit_events",
    );
    expect(rows[0]?.n).toBe(RULE.limit);
  });

  it("zählt IPs und Endpoints getrennt", async () => {
    for (let i = 0; i < RULE.limit; i += 1) {
      await consumeRateLimit(db, "1.2.3.4", RULE);
    }
    expect((await consumeRateLimit(db, "5.6.7.8", RULE)).allowed).toBe(true);
    expect((await consumeRateLimit(db, "1.2.3.4", { ...RULE, endpoint: "chat" })).allowed).toBe(
      true,
    );
  });

  it("gibt wieder frei, wenn alte Einträge aus dem Fenster fallen, und räumt sie weg", async () => {
    await db.query(
      `INSERT INTO rate_limit_events (endpoint, ip, created_at)
       SELECT 'ingest', '1.2.3.4', now() - interval '16 minutes' FROM generate_series(1, 3)`,
    );
    expect((await consumeRateLimit(db, "1.2.3.4", RULE)).allowed).toBe(true);
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM rate_limit_events",
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe("clientIp", () => {
  it("nimmt den ersten Eintrag aus x-forwarded-for", () => {
    const request = new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("fällt ohne Header auf einen festen Schlüssel zurück", () => {
    expect(clientIp(new Request("http://localhost"))).toBe("unbekannt");
  });
});
