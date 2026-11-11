import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Scrittura } from '../../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../../fixtures/sedi'
import { INTEGRAZIONE_A, TOKEN_A, TOKEN_B, TOKEN_REVOCATO, accendiAi, integrazioniFinte, richiestaAi } from '../../../fixtures/crm-ai'
import { improntaToken } from '@/lib/crm/ai/token'

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
  scritture: [] as unknown[],
  tabelleToccate: [] as string[],
  limite: { ok: true, remaining: 59, retryAfterMs: 0 },
  rateLimit: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  aperturaClient: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    h.aperturaClient()
    const vero = creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori as Record<string, ErrorePostgrest>, scritture: h.scritture as Scrittura[] })
    return new Proxy(vero, {
      get(bersaglio, prop, ricevitore) {
        if (prop !== 'from') return Reflect.get(bersaglio, prop, ricevitore)
        return (tabella: string) => { h.tabelleToccate.push(tabella); return bersaglio.from(tabella) }
      },
    })
  },
}))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: (...a: unknown[]) => h.rateLimit(...a) }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: (...a: unknown[]) => h.logEvento(...a), logErrore: (...a: unknown[]) => h.logErrore(...a) }
})

import { LIMITE_CHIAMATE_AI, assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, rifiutoAi } from '@/lib/crm/ai/accesso'

const corpo = async (r: Response) => (await r.json()) as { error?: string; codice?: string }

beforeEach(() => {
  accendiAi([SEDE_A, SEDE_B])
  h.db = { crm_integrazioni: integrazioniFinte() }
  h.errori = {}
  h.scritture = []
  h.tabelleToccate = []
  h.limite = { ok: true, remaining: 59, retryAfterMs: 0 }
  h.rateLimit = vi.fn(async () => h.limite)
  h.logEvento = vi.fn()
  h.logErrore = vi.fn()
  h.aperturaClient = vi.fn()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('requireIntegrazioneAi', () => {
  it('R9 · a interruttore spento risponde 404 e non guarda né la chiave né il database', async () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    const richiesta = richiestaAi('/api/crm/ai/slot')
    const leggiHeader = vi.spyOn(richiesta.headers, 'get')
    const g = await requireIntegrazioneAi(richiesta, 'slot')
    expect('response' in g && g.response.status).toBe(404)
    expect('response' in g && (await corpo(g.response)).codice).toBe('CRM_AI_SPENTO')
    expect(h.tabelleToccate).toEqual([])
    expect(leggiHeader).not.toHaveBeenCalled()
    expect(h.aperturaClient).not.toHaveBeenCalled()
    expect(h.rateLimit).not.toHaveBeenCalled()
  })
  it.each([
    ['senza header', null],
    ['malformata', 'kvai_corta'],
    ['sconosciuta', 'kvai_' + 'Z'.repeat(43)],
    ['R7 · revocata', TOKEN_REVOCATO],
  ])('chiave %s → 401 TOKEN_NON_VALIDO', async (_nome, token) => {
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot', { token }), 'slot')
    expect('response' in g).toBe(true)
    if (!('response' in g)) return
    expect(g.response.status).toBe(401)
    expect((await corpo(g.response)).codice).toBe('TOKEN_NON_VALIDO')
    expect(g.response.headers.get('www-authenticate')).toBe('Bearer')
    expect(h.tabelleToccate).toEqual(token === null || token === 'kvai_corta' ? [] : ['crm_integrazioni'])
    expect(h.scritture).toEqual([])
    expect(h.rateLimit).not.toHaveBeenCalled()
  })
  it('una sede fuori dall’elenco delle ammesse → 403 SEDE_NON_AMMESSA', async () => {
    accendiAi([SEDE_B])
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('response' in g && g.response.status).toBe(403)
    expect('response' in g && (await corpo(g.response)).codice).toBe('SEDE_NON_AMMESSA')
    expect(h.rateLimit).not.toHaveBeenCalled()
    expect(h.scritture).toEqual([])
  })
  it('con l’elenco delle sedi vuoto lascia una riga di livello error: è configurazione mancante', async () => {
    accendiAi([])
    await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect(h.logEvento.mock.calls.some((c) => c[0] === 'crm' && c[1] === 'error' && c[2].esito === 'ai-sedi-ammesse-vuote')).toBe(true)
  })
  it('chiave buona: torna il contesto con la sede DELLA CHIAVE, e scrive l’ultimo uso', async () => {
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('ai' in g && g.ai).toMatchObject({ integrazioneId: INTEGRAZIONE_A, scuolaId: SEDE_A, operazione: 'slot' })
    expect(h.rateLimit).toHaveBeenCalledWith(`crm-ai:${INTEGRAZIONE_A}`, LIMITE_CHIAMATE_AI)
    expect(LIMITE_CHIAMATE_AI).toEqual({ limit: 60, windowMs: 60_000 })
    expect(h.tabelleToccate).toEqual(['crm_integrazioni', 'crm_integrazioni'])
    expect(h.scritture).toHaveLength(1)
    expect(h.scritture[0]).toMatchObject({
      tabella: 'crm_integrazioni',
      operazione: 'update',
      valori: [{ ultimo_uso_il: expect.any(String) }],
      colpite: [{ id: INTEGRAZIONE_A, scuola_id: SEDE_A }],
    })
  })
  it('la chiave della sede B dà la sede B', async () => {
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot', { token: TOKEN_B }), 'slot')
    expect('ai' in g && g.ai.scuolaId).toBe(SEDE_B)
  })
  it('oltre il limite → 429 TROPPE_RICHIESTE con Retry-After in secondi', async () => {
    h.limite = { ok: false, remaining: 0, retryAfterMs: 12_300 }
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('response' in g && g.response.status).toBe(429)
    expect('response' in g && g.response.headers.get('retry-after')).toBe('13')
    expect('response' in g && (await corpo(g.response)).codice).toBe('TROPPE_RICHIESTE')
    expect(h.scritture).toEqual([])
  })
  it.each(['PGRST205', '42P01'])('tabella chiavi assente (%s) → 503 CRM_NON_INSTALLATO', async (code) => {
    h.errori = { crm_integrazioni: { code, message: 'tabella assente' } }
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('response' in g && g.response.status).toBe(503)
    expect('response' in g && (await corpo(g.response)).codice).toBe('CRM_NON_INSTALLATO')
  })
  it('non mette token o impronta nei log, neanche se il database li rimanda in un errore', async () => {
    const segreti = [TOKEN_A, TOKEN_REVOCATO, improntaToken(TOKEN_A), improntaToken(TOKEN_REVOCATO)]
    await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot', { token: TOKEN_REVOCATO }), 'slot')
    h.errori = { crm_integrazioni: { code: 'XX000', message: segreti.join(' ') } }
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('response' in g && g.response.status).toBe(500)
    expect('response' in g && (await corpo(g.response)).codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    expect(h.logErrore).toHaveBeenCalledOnce()
    const tutto = JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls])
    for (const segreto of segreti) expect(tutto).not.toContain(segreto)
  })
  it('un errore nel salvare l’ultimo uso lascia un log senza dettagli grezzi e permette la chiamata', async () => {
    const impronta = improntaToken(TOKEN_A)
    h.errori = { 'crm_integrazioni:update': { code: 'XX000', message: impronta } }
    const g = await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    expect('ai' in g && g.ai.integrazioneId).toBe(INTEGRAZIONE_A)
    expect(h.db.crm_integrazioni[0].ultimo_uso_il).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'error', expect.objectContaining({
      esito: 'ai-ultimo-uso-non-scritto',
      integrazione_id: INTEGRAZIONE_A,
    }), { code: 'XX000' })
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain(impronta)
  })
  it('prima della chiave scrive al massimo un warn al minuto per istanza, anche fra operazioni diverse', async () => {
    const inizio = Date.now() + 120_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(inizio)
    vi.stubEnv('CRM_AI_ATTIVO', '')
    await requireIntegrazioneAi(richiestaAi('/api/crm/ai/slot'), 'slot')
    accendiAi([SEDE_A])
    vi.setSystemTime(inizio + 59_999)
    await requireIntegrazioneAi(richiestaAi('/api/crm/ai/contatti', { token: null }), 'contatto')
    expect(h.logEvento).toHaveBeenCalledTimes(1)
    vi.setSystemTime(inizio + 60_000)
    await requireIntegrazioneAi(richiestaAi('/api/crm/ai/contatti', { token: null }), 'contatto')
    expect(h.logEvento).toHaveBeenCalledTimes(2)
    expect(h.logEvento.mock.calls.map((c) => [c[1], c[2].esito, c[2].error_code])).toEqual([
      ['warn', 'ai-rifiutata', 'CRM_AI_SPENTO'],
      ['warn', 'ai-rifiutata', 'TOKEN_NON_VALIDO'],
    ])
  })
})

describe('assertSedeDelToken', () => {
  const ai = { integrazioneId: INTEGRAZIONE_A, scuolaId: SEDE_A, operazione: 'slot' as const, inizioMs: 0 }
  it('la sede della chiave passa, anche scritta in maiuscolo', () => {
    expect(assertSedeDelToken(ai, SEDE_A)).toBeNull()
    expect(assertSedeDelToken(ai, SEDE_A.toUpperCase())).toBeNull()
  })
  it('R2 · un’altra sede → 403 SEDE_NON_ACCESSIBILE, con una riga warn', async () => {
    const r = assertSedeDelToken(ai, SEDE_B)
    expect(r?.status).toBe(403)
    expect((await corpo(r as Response)).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.logEvento.mock.calls.some((c) => c[1] === 'warn' && c[2].esito === 'ai-sede-diversa-dalla-chiave')).toBe(true)
  })
})

describe('chiudiChiamataAi e rifiutoAi', () => {
  const ai = { integrazioneId: INTEGRAZIONE_A, scuolaId: SEDE_A, operazione: 'prenota' as const, inizioMs: Date.now() }
  it('una riga per un rifiuto, con i soli campi ammessi', () => {
    const r = chiudiChiamataAi(ai, rifiutoAi('GIA_PRENOTATO', 409), { codice: 'GIA_PRENOTATO' })
    expect(r.status).toBe(409)
    const riga = h.logEvento.mock.calls.find((c) => c[2].esito === 'ai-chiamata')
    expect(riga?.[0]).toBe('crm')
    expect(riga?.[1]).toBe('warn')
    expect(Object.keys(riga?.[2] ?? {}).sort()).toEqual(['entita_id', 'error_code', 'esito', 'integrazione_id', 'ms', 'operazione', 'scuola_id', 'stato'])
    expect(riga?.[2]).toMatchObject({ operazione: 'crm/ai:prenota', stato: 409, error_code: 'GIA_PRENOTATO', scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A })
    expect(h.logEvento).toHaveBeenCalledOnce()
  })
  it.each([[201, 'info'], [503, 'error']])('registra una chiusura %i a livello %s e restituisce la stessa risposta', (stato, livello) => {
    const r = NextResponse.json({}, { status: stato })
    expect(chiudiChiamataAi(ai, r, { entitaId: SEDE_B })).toBe(r)
    expect(h.logEvento).toHaveBeenCalledOnce()
    expect(h.logEvento).toHaveBeenCalledWith('crm', livello, expect.objectContaining({
      stato,
      esito: 'ai-chiamata',
      error_code: null,
      entita_id: SEDE_B,
      ms: expect.any(Number),
    }))
  })
  it('rifiutoAi mette la frase del catalogo, il codice e gli extra', async () => {
    const r = rifiutoAi('GIA_PRENOTATO', 409, { inizio: '2026-11-17T08:00:00.000Z' })
    expect(await r.json()).toEqual({
      error: 'Questa famiglia ha già una visita in programma.',
      codice: 'GIA_PRENOTATO',
      inizio: '2026-11-17T08:00:00.000Z',
    })
  })
})
