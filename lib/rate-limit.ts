import type { Queryable } from "@/lib/db";

/**
 * Rate-Limit pro IP, gezählt in Postgres (Tabelle `rate_limit_events`).
 *
 * Die Demo hat keinen Login. Ohne Grenze kann jeder mit wiederholten Uploads
 * das Guthaben des Demo-Keys aufbrauchen. Ein externer Dienst (Upstash o. ä.)
 * wäre ein neuer Account und ein neuer Key; die Tabelle reicht für eine Demo.
 */

export interface RateLimitRule {
  /** Schlüssel in `rate_limit_events.endpoint`. */
  endpoint: string;
  limit: number;
  windowSeconds: number;
}

/** 8 Uploads pro 15 Minuten und IP. */
export const INGEST_RATE_LIMIT: RateLimitRule = {
  endpoint: "ingest",
  limit: 8,
  windowSeconds: 15 * 60,
};

/**
 * 20 Fragen pro 15 Minuten und IP. Eigenes Kontingent, damit Uploads in der
 * Demo nicht den Chat sperren. Eine Frage kostet ~0,001 $; auch bei
 * Dauerbeschuss bleibt das Guthaben des Demo-Keys damit über Tage stehen.
 */
export const CHAT_RATE_LIMIT: RateLimitRule = {
  endpoint: "chat",
  limit: 20,
  windowSeconds: 15 * 60,
};

export interface RateLimitResult {
  allowed: boolean;
  /** Sekunden bis zum nächsten freien Platz; 0, wenn erlaubt. */
  retryAfterSeconds: number;
}

interface ConsumeRow {
  inserted: number;
  retry_after_seconds: number | null;
}

/**
 * Zählt eine Anfrage, wenn im Fenster noch Platz ist.
 *
 * Zählen und Eintragen passieren in einem Statement. Abgewiesene Anfragen
 * werden nicht eingetragen, sonst würde ein Dauer-Klicker sein Fenster
 * immer weiter nach hinten schieben.
 */
export async function consumeRateLimit(
  db: Queryable,
  ip: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  // Alte Einträge dieser IP wegräumen; hält die Tabelle klein, ohne Cronjob.
  await db.query(
    `DELETE FROM rate_limit_events
     WHERE endpoint = $1 AND ip = $2
       AND created_at <= now() - make_interval(secs => $3)`,
    [rule.endpoint, ip, rule.windowSeconds],
  );

  const { rows } = await db.query<ConsumeRow>(
    `WITH recent AS (
       SELECT count(*)::int AS n, min(created_at) AS oldest
       FROM rate_limit_events
       WHERE endpoint = $1 AND ip = $2
         AND created_at > now() - make_interval(secs => $3)
     ),
     inserted AS (
       INSERT INTO rate_limit_events (endpoint, ip)
       SELECT $1, $2 FROM recent WHERE n < $4
       RETURNING 1
     )
     SELECT
       (SELECT count(*)::int FROM inserted) AS inserted,
       CASE WHEN recent.n >= $4 THEN
         GREATEST(1, ceil(extract(epoch FROM
           recent.oldest + make_interval(secs => $3) - now())))::int
       END AS retry_after_seconds
     FROM recent`,
    [rule.endpoint, ip, rule.windowSeconds, rule.limit],
  );

  const row = rows[0];
  if (row && Number(row.inserted) > 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Number(row?.retry_after_seconds ?? rule.windowSeconds),
  };
}

/**
 * Client-IP aus `x-forwarded-for`. Auf Vercel setzt die Plattform den
 * ersten Eintrag selbst; lokal fehlt der Header, dann zählen alle Anfragen
 * gemeinsam unter "unbekannt".
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return request.headers.get("x-real-ip")?.trim() || "unbekannt";
}
