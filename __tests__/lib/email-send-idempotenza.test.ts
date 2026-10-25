import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * LA CHIAVE D'IDEMPOTENZA DI RESEND (fase 8 della roadmap di robustezza).
 *
 * Chi spedisce in giro (digest, solleciti) può ripartire dopo una Function troncata. Con la
 * chiave, Resend per 24 ore risponde «già fatto» invece di mandare un doppione alla famiglia.
 * Qui si prova il trasporto: l'header c'è solo quando il chiamante lo chiede, una chiave fuori
 * forma non ferma l'invio (ma si dice), e i due 409 dell'idempotenza non si confondono:
 *  · `concurrent_idempotent_requests` → rinviabile, come il 429;
 *  · `invalid_idempotent_request` → definitivo, e a livello `error` (è un errore del chiamante).
 *
 * Come gli altri test di `send.ts`: `globalThis.fetch` finto, spie sul logger. Indirizzi su
 * `.test`, mai veri.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

import { sendEmailDetailed } from '@/lib/email/send'

const realFetch = global.fetch
const realKey = process.env.RESEND_API_KEY

const params = { to: 'genitore.finto@example.test', subject: 'Promemoria', text: 'corpo' }
const CHIAVE = 'sollecito:6f1c2a9e-0000-4000-8000-000000000001:L1:2026-10-11'

let richieste: Request[] = []
function rispondiCon(stato: number, corpo: string) {
  richieste = []
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    richieste.push(new Request(input, init))
    return new Response(corpo, { status: stato })
  }) as typeof fetch
}
const header = () => richieste[0]?.headers.get('Idempotency-Key') ?? null
const righe = (livello: string, esito: string) =>
  log.logEvento.mock.calls.filter((c) => c[1] === livello && (c[2] as { esito?: string }).esito === esito)

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-key'
  log.logEvento.mockClear()
})
afterEach(() => {
  global.fetch = realFetch
  if (realKey === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = realKey
})

describe('sendEmailDetailed — Idempotency-Key', () => {
  it('con la chiave, l\'header parte con la chiave TALE E QUALE', async () => {
    rispondiCon(200, JSON.stringify({ id: 'msg-1' }))
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r).toMatchObject({ ok: true, messageId: 'msg-1' })
    expect(header()).toBe(CHIAVE)
  })

  it('senza chiave, nessun header: chi non la chiede si comporta come prima', async () => {
    rispondiCon(200, JSON.stringify({ id: 'msg-2' }))
    await sendEmailDetailed(params)
    expect(header()).toBeNull()
  })

  it('chiave fuori forma (un indirizzo dentro): si spedisce SENZA header, una riga `error` lo dice, e la chiave non finisce nel log', async () => {
    rispondiCon(200, JSON.stringify({ id: 'msg-3' }))
    const cattiva = `digest:${params.to}`
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: cattiva })
    expect(r.ok).toBe(true)
    expect(header()).toBeNull()
    const err = righe('error', 'chiave-idempotenza-non-valida')
    expect(err).toHaveLength(1)
    expect(JSON.stringify(err[0])).not.toContain(params.to)
  })

  it('chiave oltre i 256 caratteri: fuori forma anche lei', async () => {
    rispondiCon(200, JSON.stringify({ id: 'msg-4' }))
    await sendEmailDetailed({ ...params, chiaveIdempotenza: 'a'.repeat(257) })
    expect(header()).toBeNull()
    expect(righe('error', 'chiave-idempotenza-non-valida')).toHaveLength(1)
  })

  it('409 concurrent_idempotent_requests → rinviabile (l\'invio è ancora in corso) e incerto, riga `warn`', async () => {
    rispondiCon(409, JSON.stringify({ statusCode: 409, name: 'concurrent_idempotent_requests', message: 'Same idempotency key used while original request is still in progress.' }))
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r).toMatchObject({ ok: false, rinviabile: true, incerto: true })
    expect(righe('warn', 'idempotenza-concorrente')).toHaveLength(1)
  })

  // Revisione del lotto 4: la chiave è già arrivata a Resend con un altro messaggio. QUESTA
  // richiesta non parte, ma quella di prima con la stessa chiave può essere partita: chi tiene
  // una presa (i solleciti) non deve annullarla e rispedire il giorno dopo con una chiave nuova.
  it('🔴 409 invalid_idempotent_request → definitivo (NON rinviabile) ma INCERTO, riga `error`: il chiamante ha riusato la chiave', async () => {
    rispondiCon(409, JSON.stringify({ statusCode: 409, name: 'invalid_idempotent_request', message: 'Same idempotency key used with a different request payload.' }))
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r.ok).toBe(false)
    expect(r.rinviabile).toBeUndefined()
    expect(r.incerto).toBe(true)
    expect(r.error).toContain('different request payload')
    expect(righe('error', 'idempotenza-chiave-riusata')).toHaveLength(1)
  })

  it('un 409 qualunque, senza nome dell\'idempotenza, resta un rifiuto definitivo e CERTO come prima', async () => {
    rispondiCon(409, 'conflict')
    const r = await sendEmailDetailed({ ...params, chiaveIdempotenza: CHIAVE })
    expect(r).toMatchObject({ ok: false })
    expect(r.rinviabile).toBeUndefined()
    expect(r.incerto).toBeUndefined()
  })
})
