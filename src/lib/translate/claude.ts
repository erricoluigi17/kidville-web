import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { externalFetch } from '@/lib/logging/external'
import { logEvento, type Livello } from '@/lib/logging/logger'
import { msDaRetryAfter } from '@/lib/rete/retry-after'

// P4/DL-042 — Traduzione automatica chat (insegnante↔famiglie straniere) via Claude.
// Servizio gated su ANTHROPIC_API_KEY (dipendenza esterna, come Aruba): se la chiave
// manca, ritorna `disabled` e l'UI nasconde il pulsante "Traduci". Modello haiku
// (economico/veloce); nessun thinking/effort (non supportati/necessari).

const TRANSLATE_MODEL = 'claude-haiku-4-5'

/**
 * IL FORNITORE, CON I NUMERI SCRITTI (sessione 9 della seconda serie di robustezza).
 *
 * Prima: `new Anthropic({ apiKey })`, cioè i default dello SDK — 10 MINUTI di timeout per
 * tentativo e 2 ritentativi, con l'attesa che chiede il fornitore e nessun tetto. Una traduzione
 * appesa teneva aperta la Function di `chat/translate` fino al muro della piattaforma, e nessuna
 * riga diceva perché: la chiamata non passava da `externalFetch`.
 *
 * Ora: 20 s per tentativo, UN ritentativo, e un'attesa chiesta dal fornitore oltre i 5 s non si
 * aspetta (lo SDK riceve `x-should-retry: false`). Caso peggiore 20 + 5 + 20 = 45 s, dentro la
 * `maxDuration = 60` della route.
 */
export const TIMEOUT_TRADUZIONE_MS = 20_000
export const RITENTATIVI_TRADUZIONE = 1
export const ATTESA_MAX_TRADUZIONE_MS = 5_000

export interface TranslateResult {
  translated: string | null
  disabled?: boolean
}

// Interfaccia minima per dependency-injection nei test (no rete).
type Translator = {
  messages: {
    create: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

export function isTranslationEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

/** Ciò che lo SDK ritenta da sé (`shouldRetry`): 408, 409, 429, 5xx, e nessuna risposta. */
function ritentabileDallSdk(stato: number): boolean {
  return stato === 0 || stato === 408 || stato === 409 || stato === 429 || stato >= 500
}

function urlDi(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * Gli header che lo SDK legge per decidere se e quando ritentare. `retry-after-ms` vince su
 * `retry-after` ed è letto senza tetto: il tetto lo mettiamo qui.
 */
function intestazioniDelRifiuto(retryAfter: string | undefined): Record<string, string> {
  const ms = msDaRetryAfter(retryAfter)
  if (ms === undefined) return {}
  if (ms > ATTESA_MAX_TRADUZIONE_MS) return { 'x-should-retry': 'false' }
  return { 'retry-after-ms': String(ms) }
}

/**
 * Il `fetch` che lo SDK usa. Passa da `externalFetch`, quindi ogni tentativo lascia la sua riga
 * (`evento: 'traduzione'`, `provider: 'anthropic'`, lo stato, i millisecondi, il corpo del
 * rifiuto nel messaggio) e nessuno status resta nudo (AGENTS.md, regola 3).
 *
 * `externalFetch` non lancia mai; lo SDK invece si aspetta una Response o un'eccezione. Quindi:
 *  · successo → la Response vera, col corpo intatto;
 *  · rifiuto HTTP → una Response ricostruita con lo stesso status e lo stesso corpo, più gli
 *    header di `intestazioniDelRifiuto`;
 *  · nessuna risposta → un'eccezione: `AbortError` se lo SDK aveva interrotto (il suo tetto di
 *    20 s), un errore di connessione altrimenti. Lo SDK le riconosce e decide se ritentare.
 * Il segnale dello SDK passa intatto e vince sul tetto di `externalFetch`.
 */
export async function fetchOsservato(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const esito = await externalFetch('anthropic', urlDi(input), init, {
    evento: 'traduzione',
    campi: { operazione: 'messages:create' },
    gravita: (stato: number): Livello => (ritentabileDallSdk(stato) ? 'warn' : 'error'),
  })
  if (esito.ok && esito.res) return esito.res
  if (esito.stato === 0) {
    const errore = new Error(esito.corpo || 'nessuna risposta dal fornitore della traduzione')
    if (init?.signal?.aborted) errore.name = 'AbortError'
    throw errore
  }
  const stato = esito.stato >= 400 && esito.stato <= 599 ? esito.stato : 502
  return new Response(esito.corpo, { status: stato, headers: intestazioniDelRifiuto(esito.retryAfter) })
}

/** Le opzioni del client: esportate perché il test le confronti per intero. */
export function opzioniClientTraduzione(apiKey: string): ClientOptions {
  return { apiKey, timeout: TIMEOUT_TRADUZIONE_MS, maxRetries: RITENTATIVI_TRADUZIONE, fetch: fetchOsservato }
}

export async function translateText(
  text: string,
  targetLang: string,
  opts?: { apiKey?: string | undefined; client?: Translator },
): Promise<TranslateResult> {
  const apiKey = opts?.apiKey !== undefined ? opts.apiKey : process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { translated: null, disabled: true }

  const trimmed = (text ?? '').trim()
  if (!trimmed) return { translated: '' }

  const client: Translator = opts?.client ?? (new Anthropic(opzioniClientTraduzione(apiKey)) as unknown as Translator)
  try {
    const res = await client.messages.create({
      model: TRANSLATE_MODEL,
      max_tokens: 1024,
      system: `Sei un traduttore. Traduci il messaggio dell'utente nella lingua con codice "${targetLang}". Rispondi SOLO con la traduzione, senza preamboli, virgolette o note. Mantieni il tono colloquiale e gli eventuali emoji.`,
      messages: [{ role: 'user', content: trimmed }],
    })
    const out = res.content.find((b) => b.type === 'text')?.text?.trim() ?? null
    return { translated: out }
  } catch (e) {
    // Provider esterno: l'errore va conservato INTERO (l'SDK porta status e corpo
    // della risposta) — uno status nudo non distingue "chiave scaduta" da "rate
    // limit". Il TESTO da tradurre non va mai a log: è un messaggio di chat fra
    // una famiglia e un docente. A log restano la lingua di destinazione e la
    // lunghezza, che bastano a riprodurre il caso. Ogni tentativo ha già la sua
    // riga da `fetchOsservato`.
    logEvento(
      'traduzione',
      'error',
      {
        operazione: 'translateText',
        provider: 'anthropic',
        esito: 'traduzione-fallita',
        lingua: targetLang,
        caratteri: trimmed.length,
      },
      e,
    )
    return { translated: null }
  }
}
