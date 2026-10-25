/**
 * `Retry-After` in millisecondi (sessione 9 della seconda serie di robustezza).
 *
 * L'header ha due forme (RFC 9110, §10.2.3): un numero di secondi (`120`) oppure una data HTTP
 * (`Wed, 21 Oct 2026 07:28:00 GMT`). Una data già passata vale 0, mai un'attesa negativa.
 * Illeggibile, vuoto o assente → `undefined`: chi chiama usa la propria scaletta.
 *
 * Esiste in un posto solo perché lo leggono due fornitori, Resend (`src/lib/email/send.ts`) e
 * Anthropic (`src/lib/translate/claude.ts`). `native-push.ts` ne ha una copia privata più
 * vecchia, con lo stesso comportamento sui secondi interi e sulle date: resta dov'è.
 *
 * `adesso` è un parametro per i test; in produzione è l'orologio.
 */
export function msDaRetryAfter(valore: string | undefined, adesso: number = Date.now()): number | undefined {
  if (valore === undefined) return undefined
  const v = valore.trim()
  if (v === '') return undefined
  if (/^\d+$/.test(v)) return Number(v) * 1_000
  const quando = Date.parse(v)
  return Number.isFinite(quando) ? Math.max(0, quando - adesso) : undefined
}
