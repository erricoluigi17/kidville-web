/**
 * Rate-limiter in-memory a finestra scorrevole (sliding window).
 *
 * Adatto a deployment single-instance (P0). In multi-istanza va spostato su uno
 * store condiviso (Postgres/Upstash) — vedi nota "RINVIATO" nel piano P0.
 *
 * `now` è iniettabile per test deterministici.
 */
const store = new Map<string, number[]>();

export interface RateLimitOptions {
  /** Numero massimo di richieste nella finestra. */
  limit: number;
  /** Ampiezza della finestra in millisecondi. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function rateLimit(
  key: string,
  opts: RateLimitOptions,
  now: number = Date.now()
): RateLimitResult {
  const hits = (store.get(key) ?? []).filter((t) => now - t < opts.windowMs);
  if (hits.length >= opts.limit) {
    store.set(key, hits);
    const retryAfterMs = opts.windowMs - (now - hits[0]);
    return { ok: false, remaining: 0, retryAfterMs };
  }
  hits.push(now);
  store.set(key, hits);
  return { ok: true, remaining: opts.limit - hits.length, retryAfterMs: 0 };
}

/** Estrae l'IP client dagli header di proxy (best-effort). */
export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/** Solo per i test. */
export function resetRateLimit(): void {
  store.clear();
}
