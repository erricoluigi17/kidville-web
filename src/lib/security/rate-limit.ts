/**
 * Rate-limiter in-memory a finestra scorrevole (sliding window).
 *
 * ⚠️ IL CONTATORE È PER ISTANZA, E IN PRODUZIONE LE ISTANZE SONO PIÙ D'UNA.
 *
 * Lo `store` qui sotto è una `Map` nello scope del modulo, cioè nella memoria di
 * UN processo Node. In produzione (Vercel) ogni lambda concorrente ha il proprio
 * modulo e quindi il proprio contatore: **il tetto effettivo è N × `limit`**, con
 * N il numero di istanze calde in quel momento. E un'istanza riciclata riparte da
 * zero: una finestra "di dieci minuti" può azzerarsi anche prima.
 *
 * Non è un dettaglio d'implementazione da tenere in un angolo: chi scrive
 * `limit: 5` sta dichiarando un numero che il sistema NON garantisce. Ogni
 * chiamante deve chiedersi se il proprio caso regge un tetto approssimato per
 * eccesso — vedi `@/lib/security/otp-rate-limit`, dove la domanda è posta per
 * esteso e ha una risposta precisa.
 *
 * Il tetto esatto richiede uno store condiviso (Postgres/Upstash). Resta da fare:
 * finché non c'è, questo modulo alza il costo di un abuso, non lo azzera.
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
