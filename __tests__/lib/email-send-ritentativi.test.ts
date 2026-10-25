// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * SESSIONE 9 (seconda serie di robustezza) — i ritentativi di `sendEmailDetailed`.
 *
 * Le regole, una per caso:
 *  · senza `ritentativi` niente cambia: una chiamata, l'esito di sempre, nessuna chiave nuova;
 *  · con `ritentativi`: al massimo 3 chiamate, attese 1 s e 3 s (o il `Retry-After`, se è più
 *    lungo e non supera 10 s), la STESSA chiave d'idempotenza a ogni tentativo;
 *  · `429` si ritenta sempre; `5xx` e rete giù / scadenza SOLO con la chiave (senza, un
 *    ritentativo sarebbe un doppione alla famiglia); un `4xx` definitivo mai;
 *  · un ritentativo che finirebbe oltre la `scadenza` del giro non parte;
 *  · la riga che chiude i ritentativi porta il corpo del provider SANIFICATO.
 *
 * Resend finto su `globalThis.fetch` (come `email-send-quota.test.ts`), orologio finto solo su
 * `setTimeout`: nessuna attesa vera. Indirizzi solo su `example.test`.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

import { sendEmailDetailed } from '@/lib/email/send'

/** `{ rete }`: l'errore di undici (`TypeError('fetch failed')`) con quel `code` sulla causa, o senza. */
type Risposta = Response | 'rete-giu' | 'scaduto' | { rete: string | null }

/** Resend finto: risponde in ordine con `risposte` (l'ultima si ripete) e annota le chiavi. */
function resendFinto(risposte: Array<() => Risposta>): (string | undefined)[] {
  const chiavi: (string | undefined)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      chiavi.push((init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'])
      const r = (risposte[chiavi.length - 1] ?? risposte[risposte.length - 1])()
      if (r === 'rete-giu') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
      if (r === 'scaduto') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      if (!(r instanceof Response)) {
        throw r.rete === null ? new TypeError('fetch failed') : Object.assign(new TypeError('fetch failed'), { cause: { code: r.rete } })
      }
      return r
    }),
  )
  return chiavi
}

const ok200 = (): Risposta => new Response(JSON.stringify({ id: 'msg-finto-1' }), { status: 200 })
const rifiuto = (status: number, corpo: Record<string, unknown>, headers?: Record<string, string>) => (): Risposta =>
  new Response(JSON.stringify(corpo), { status, headers })
const reteGiu = (): Risposta => 'rete-giu'
const scaduto = (): Risposta => 'scaduto'
const rete = (codice: string | null) => (): Risposta => ({ rete: codice })

async function finché(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('condizione mai verificata')
}

const params = { to: 'genitore.uno@example.test', subject: 'Promemoria', text: 'corpo' }
/** Una chiave come quella dei solleciti: solo uuid, livello e data. */
const CHIAVE = 'sollecito:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1:L1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2:2026-10-21'

const righe = (esito: string) =>
  log.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)
/** Le righe che `externalFetch` scrive per ogni tentativo: [livello, tentativo]. */
const tentativi = () =>
  log.logEvento.mock.calls
    .filter((c) => c[0] === 'email' && (c[2] as { provider?: string }).provider === 'resend'
      && (c[2] as { tentativo?: number }).tentativo !== undefined)
    .map((c) => [c[1], (c[2] as { tentativo: number }).tentativo])

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubEnv('RESEND_API_KEY', 'chiave-finta')
  log.logEvento.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('sendEmailDetailed — senza `ritentativi` una chiamata sola', () => {
  // Revisione del lotto 4: con la chiave partita, un 503 è INCERTO (la richiesta può essere
  // arrivata). Il resto resta com'era: una chiamata, niente `tentativi`, niente `tentativo`.
  it('503 con la chiave: una chiamata, niente `tentativi`, `incerto`, riga `error` senza `tentativo`', async () => {
    const chiavi = resendFinto([rifiuto(503, { name: 'application_error', message: 'Servizio non disponibile' })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r).toEqual({ ok: false, error: 'rifiutato dal provider email (503): Servizio non disponibile', incerto: true })
    expect(chiavi).toHaveLength(1)
    const riga = log.logEvento.mock.calls.filter((c) => c[0] === 'email' && (c[2] as { provider?: string }).provider === 'resend')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('error')
    expect((riga[0][2] as { tentativo?: number }).tentativo).toBeUndefined()
  })

  it('una chiamata SCADUTA senza risposta è `incerto`: Resend potrebbe averla presa', async () => {
    resendFinto([scaduto])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r).toMatchObject({ ok: false, incerto: true })
    expect(r.tentativi).toBeUndefined()
  })
})

describe('sendEmailDetailed — con `ritentativi`', () => {
  it('500 poi 200, con la chiave: un ritentativo dopo 1 s ESATTO, con la STESSA chiave', async () => {
    const chiavi = resendFinto([rifiuto(500, { name: 'internal_server_error', message: 'errore temporaneo' }), ok200])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })

    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(999)
    expect(chiavi).toHaveLength(1) // non prima di 1 s
    await vi.advanceTimersByTimeAsync(1)
    await finché(() => chiavi.length === 2)

    expect(await p).toEqual({ ok: true, error: null, messageId: 'msg-finto-1', tentativi: 2 })
    expect(chiavi).toEqual([CHIAVE, CHIAVE])
    expect(tentativi()).toEqual([['warn', 1], ['info', 2]])
    const riuscita = righe('riuscita-dopo-ritentativo')
    expect(riuscita).toHaveLength(1)
    expect(riuscita[0][1]).toBe('info')
  })

  it('429 con `Retry-After: 2`, anche senza chiave: aspetta 2 s, non 1', async () => {
    const chiavi = resendFinto([rifiuto(429, { name: 'rate_limit_exceeded', message: 'Too many requests' }, { 'retry-after': '2' }), ok200])
    const p = sendEmailDetailed({ ...params, ritentativi: {} })

    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(chiavi).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await finché(() => chiavi.length === 2)

    expect(await p).toMatchObject({ ok: true, tentativi: 2 })
    expect(chiavi).toEqual([undefined, undefined])
  })

  it('500 tre volte: 1 s, 3 s, poi basta — riga `error` con il corpo SANIFICATO e il codice', async () => {
    const chiavi = resendFinto([rifiuto(500, { name: 'internal_server_error', message: 'Errore temporaneo per genitore.uno@example.test' })])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })

    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(chiavi).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await finché(() => chiavi.length === 3)

    const r = await p
    // Tre 500 con la chiave: nessuno dice che l'email NON è partita (revisione del lotto 4).
    expect(r).toMatchObject({ ok: false, tentativi: 3, incerto: true })
    expect(chiavi).toEqual([CHIAVE, CHIAVE, CHIAVE])
    expect(tentativi()).toEqual([['warn', 1], ['warn', 2], ['warn', 3]])
    const fine = righe('ritentativi-esauriti')
    expect(fine).toHaveLength(1)
    expect(fine[0][0]).toBe('email')
    expect(fine[0][1]).toBe('error')
    expect(fine[0][2]).toMatchObject({ operazione: 'sendEmail', provider: 'resend', stato: 500, tentativi: 3 })
    const err = fine[0][3] as Error & { code?: string }
    expect(err.name).toBe('ResendRitentativiFermati')
    expect(err.code).toBe('500')
    expect(err.message).toContain('[email]')
    expect(err.message).not.toContain('example.test')
  })

  it('rete giù poi 200, con la chiave: si ritenta e riesce', async () => {
    const chiavi = resendFinto([reteGiu, ok200])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2)
    expect(await p).toMatchObject({ ok: true, tentativi: 2 })
  })

  it('SENZA chiave, rete giù o 500 non si ritentano: un doppione costa più di un giorno di ritardo', async () => {
    let chiavi = resendFinto([reteGiu])
    expect(await sendEmailDetailed({ ...params, ritentativi: {} })).toMatchObject({ ok: false, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
    chiavi = resendFinto([rifiuto(500, { message: 'errore' })])
    expect(await sendEmailDetailed({ ...params, ritentativi: {} })).toMatchObject({ ok: false, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
  })

  it('422 (definitivo): una chiamata sola, riga `error`', async () => {
    const chiavi = resendFinto([rifiuto(422, { name: 'validation_error', message: 'Invalid `to` field' })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    expect(r).toMatchObject({ ok: false, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
    expect(tentativi()).toEqual([['error', 1]])
  })

  it('429 con `Retry-After: 60` (oltre 10 s): non si aspetta, rinviabile; il tentativo `warn`, la chiusura `error` col codice 429', async () => {
    const chiavi = resendFinto([rifiuto(429, { message: 'Too many requests' }, { 'retry-after': '60' })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    expect(r).toMatchObject({ ok: false, rinviabile: true, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
    expect(tentativi()).toEqual([['warn', 1]])
    const fine = righe('retry-after-oltre-il-tetto')
    expect(fine).toHaveLength(1)
    // L'email non partirà in questo giro: è un fallimento, e deve arrivare alla salute
    // (`contaEsitiFornitore` conta le sole righe `error`), anche se la causa è la quota.
    expect(fine[0][1]).toBe('error')
    expect(fine[0][2]).toMatchObject({ stato: 429, tentativi: 1, attesa_ms: 60_000 })
    expect((fine[0][3] as { code?: string }).code).toBe('429')
    // La riga di chiusura dice già tutto: niente `quota-esaurita` in più.
    expect(righe('quota-esaurita')).toHaveLength(0)
  })

  it('429 tre volte (`Retry-After: 2`): 2 s, 3 s, poi basta — tentativi `warn`, chiusura `error` col codice 429, rinviabile', async () => {
    const chiavi = resendFinto([rifiuto(429, { name: 'rate_limit_exceeded', message: 'Too many requests' }, { 'retry-after': '2' })])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })

    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(2_000) // il Retry-After (2 s) vince sulla scaletta (1 s)
    await finché(() => chiavi.length === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(3_000) // la scaletta (3 s) vince sul Retry-After (2 s)
    await finché(() => chiavi.length === 3)

    const r = await p
    expect(r).toMatchObject({ ok: false, rinviabile: true, tentativi: 3 })
    expect(r.incerto).toBeUndefined()
    expect(chiavi).toEqual([CHIAVE, CHIAVE, CHIAVE])
    expect(tentativi()).toEqual([['warn', 1], ['warn', 2], ['warn', 3]])
    const fine = righe('ritentativi-esauriti')
    expect(fine).toHaveLength(1)
    expect(fine[0][1]).toBe('error')
    expect(fine[0][2]).toMatchObject({ operazione: 'sendEmail', provider: 'resend', stato: 429, tentativi: 3 })
    const err = fine[0][3] as Error & { code?: string }
    expect(err.name).toBe('ResendRitentativiFermati')
    expect(err.code).toBe('429')
    expect(righe('quota-esaurita')).toHaveLength(0)
  })

  it('il ritentativo che finirebbe oltre la scadenza del giro non parte', async () => {
    const chiavi = resendFinto([rifiuto(500, { message: 'errore' })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: { scadenza: Date.now() + 5_000 } })
    expect(r).toMatchObject({ ok: false, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
    const fine = righe('ritentativo-oltre-la-scadenza')
    expect(fine).toHaveLength(1)
    expect(fine[0][1]).toBe('error')
    expect(fine[0][2]).toMatchObject({ stato: 500, tentativi: 1, attesa_ms: 1_000 })
  })

  it('409 concorrente: nessun ritentativo, rinviabile e INCERTO', async () => {
    const chiavi = resendFinto([rifiuto(409, { name: 'concurrent_idempotent_requests', message: 'in corso' })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    expect(r).toMatchObject({ ok: false, rinviabile: true, incerto: true, tentativi: 1 })
    expect(chiavi).toHaveLength(1)
  })

  it('tre scadenze di fila: `incerto`, e la riga di chiusura col codice `timeout`', async () => {
    const chiavi = resendFinto([scaduto])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(3_000)
    await finché(() => chiavi.length === 3)
    const r = await p
    expect(r).toMatchObject({ ok: false, incerto: true, tentativi: 3 })
    const fine = righe('ritentativi-esauriti')
    expect(fine).toHaveLength(1)
    expect((fine[0][3] as { code?: string }).code).toBe('timeout')
  })

  // Aggiunti nel lotto 4 dopo il mutation testing: togliere l'azzeramento di `scaduto` lasciava
  // verdi tutti i casi qui sopra. Stessa chiave ⇒ stesso esito: un 4xx definitivo dopo una
  // scadenza dice che la prima chiamata NON è partita; un 429 non dice niente.
  it('scadenza poi 422 (definitivo): la scadenza è SMENTITA, l’esito non è incerto', async () => {
    const chiavi = resendFinto([scaduto, rifiuto(422, { name: 'validation_error', message: 'Invalid `to` field' })])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2)
    const r = await p
    expect(r).toMatchObject({ ok: false, tentativi: 2 })
    expect(r.incerto).toBeUndefined()
    expect(chiavi).toEqual([CHIAVE, CHIAVE])
  })

  it('scadenza poi 429 due volte: il 429 non smentisce niente, l’esito resta incerto (e rinviabile)', async () => {
    const chiavi = resendFinto([scaduto, rifiuto(429, { message: 'Too many requests' })])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(3_000)
    await finché(() => chiavi.length === 3)
    const r = await p
    expect(r).toMatchObject({ ok: false, rinviabile: true, incerto: true, tentativi: 3 })
  })
})

/**
 * REVISIONE DEL LOTTO 4 — la ricevuta persa su un 5xx o su una connessione caduta.
 *
 * Fino a qui `incerto` valeva solo per la scadenza del tetto e per il 409 concorrente. Un 504 del
 * gateway o un `ECONNRESET` arrivati DOPO che Resend aveva preso il messaggio uscivano «certi»: i
 * solleciti annullavano la presa, il giorno dopo la chiave cambiava (la data) e l'email partiva
 * due volte. Ora, con la chiave inviata, li smentiscono solo un `ok` o un 4xx definitivo; gli
 * errori PRIMA della connessione restano certi, perché lì la richiesta non è mai partita.
 */
describe('sendEmailDetailed — esito incerto quando la richiesta può essere arrivata', () => {
  it('504 del gateway, con la chiave e senza ritentativi: incerto', async () => {
    resendFinto([() => new Response('<html>504 Gateway Time-out</html>', { status: 504 })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r).toMatchObject({ ok: false, incerto: true })
    expect(r.rinviabile).toBeUndefined()
  })

  it('connessione caduta (`ECONNRESET`), con la chiave: incerto', async () => {
    resendFinto([reteGiu])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r).toMatchObject({ ok: false, incerto: true })
  })

  it('errore di rete SENZA codice, con la chiave: incerto (nel dubbio la richiesta può essere partita)', async () => {
    resendFinto([rete(null)])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r).toMatchObject({ ok: false, incerto: true })
  })

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'])(
    'errore PRIMA della connessione (%s), con la chiave: esito certo, la richiesta non è mai partita',
    async (codice) => {
      resendFinto([rete(codice)])
      const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
      expect(r.ok).toBe(false)
      expect(r.error).toContain('errore di rete')
      expect(r.incerto).toBeUndefined()
    },
  )

  it('SENZA chiave, 503 e `ECONNRESET` restano l’esito di sempre: niente `incerto`', async () => {
    resendFinto([rifiuto(503, { name: 'application_error', message: 'Servizio non disponibile' })])
    expect(await sendEmailDetailed(params)).toEqual({ ok: false, error: 'rifiutato dal provider email (503): Servizio non disponibile' })
    resendFinto([reteGiu])
    expect((await sendEmailDetailed(params)).incerto).toBeUndefined()
  })

  it('500 poi 422, con i ritentativi: il 4xx definitivo SMENTISCE il 500, esito certo', async () => {
    const chiavi = resendFinto([rifiuto(500, { message: 'errore' }), rifiuto(422, { name: 'validation_error', message: 'Invalid `to` field' })])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2)
    const r = await p
    expect(r).toMatchObject({ ok: false, tentativi: 2 })
    expect(r.incerto).toBeUndefined()
  })

  it('500 poi due `ENOTFOUND`, con i ritentativi: l’errore prima della connessione NON smentisce il 500, resta incerto', async () => {
    const chiavi = resendFinto([rifiuto(500, { message: 'errore' }), rete('ENOTFOUND')])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(3_000)
    await finché(() => chiavi.length === 3)
    const r = await p
    expect(r).toMatchObject({ ok: false, tentativi: 3, incerto: true })
  })
})

/**
 * SECONDA REVISIONE DEL LOTTO 4.
 *
 * (3) L'elenco degli errori PRIMA della connessione era incompleto: un certificato scaduto
 *     (`CERT_HAS_EXPIRED`), un nome che non torna (`ERR_TLS_CERT_ALTNAME_INVALID`), una rete o un
 *     host irraggiungibili uscivano «incerti», e il sollecito slittava di una cadenza invece di
 *     riprovare il giorno dopo. Lì la richiesta HTTP non è mai partita: l'handshake è fallito prima.
 * (4) Qualunque 4xx smentiva un 5xx precedente, anche quello di un intermediario (il 403 HTML di
 *     un WAF, un 408, un 409 senza `name`): esito certo, presa annullata, doppione possibile il
 *     giorno dopo. Smentisce solo un rifiuto STRUTTURATO di Resend, cioè con un `name`.
 */
describe('sendEmailDetailed — seconda revisione del lotto 4', () => {
  it.each(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'errore PRIMA della richiesta (%s), con la chiave: esito certo',
    async (codice) => {
      resendFinto([rete(codice)])
      const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
      expect(r.ok).toBe(false)
      expect(r.error).toContain('errore di rete')
      expect(r.incerto).toBeUndefined()
    },
  )

  it.each(['ERR_TLS_RENEGOTIATION_DISABLED', 'UND_ERR_SOCKET', 'EPIPE'])(
    'errore a connessione APERTA (%s), con la chiave: resta incerto (la richiesta può essere partita)',
    async (codice) => {
      resendFinto([rete(codice)])
      const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
      expect(r).toMatchObject({ ok: false, incerto: true })
    },
  )

  /** 500, poi `secondo`: due chiamate (il 4xx ferma i ritentativi). */
  async function cinquecentoPoi(secondo: () => Risposta) {
    const chiavi = resendFinto([rifiuto(500, { message: 'errore' }), secondo])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2)
    return p
  }

  it.each([
    ['403 HTML di un WAF', () => new Response('<html><body>403 Forbidden</body></html>', { status: 403 })],
    ['408 di un proxy, senza corpo', () => new Response('', { status: 408 })],
    ['409 JSON senza `name`', rifiuto(409, { message: 'Conflict' })],
    ['400 JSON con un `name` vuoto', rifiuto(400, { name: '', message: 'Bad Request' })],
  ])('500 poi %s: NON smentisce il 500, l’esito resta incerto', async (_nome, secondo) => {
    const r = await cinquecentoPoi(secondo as () => Risposta)
    expect(r).toMatchObject({ ok: false, tentativi: 2, incerto: true })
  })

  it('500 poi 403 STRUTTURATO di Resend (`name`): smentisce il 500, esito certo', async () => {
    const r = await cinquecentoPoi(rifiuto(403, { statusCode: 403, name: 'validation_error', message: 'The domain is not verified' }))
    expect(r).toMatchObject({ ok: false, tentativi: 2 })
    expect(r.incerto).toBeUndefined()
    expect(r.error).toContain('The domain is not verified')
  })

  it('scadenza poi 403 HTML di un WAF: la scadenza NON è smentita, resta incerto', async () => {
    const chiavi = resendFinto([scaduto, () => new Response('<html>403 Forbidden</html>', { status: 403 })])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2)
    expect(await p).toMatchObject({ ok: false, tentativi: 2, incerto: true })
  })

  it('scadenza poi 429 STRUTTURATO di Resend (`rate_limit_exceeded`): anche con il `name`, un 429 non smentisce niente', async () => {
    const chiavi = resendFinto([scaduto, rifiuto(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' })])
    const p = sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE, ritentativi: {} })
    await finché(() => chiavi.length === 1 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(1_000)
    await finché(() => chiavi.length === 2 && vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(3_000)
    await finché(() => chiavi.length === 3)
    expect(await p).toMatchObject({ ok: false, rinviabile: true, incerto: true, tentativi: 3 })
  })

  it('un 403 HTML da solo (nessun dubbio prima): esito certo, come sempre', async () => {
    resendFinto([() => new Response('<html>403 Forbidden</html>', { status: 403 })])
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r.ok).toBe(false)
    expect(r.incerto).toBeUndefined()
  })
})
