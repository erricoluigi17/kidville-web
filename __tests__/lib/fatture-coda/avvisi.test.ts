// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * `spedisciAvvisiCoda` (consegna 2c, §4.4): prende i fatti con `fatture_coda_avvisi_prendi`,
 * compone i testi e accoda UNA notifica per destinatario, senza sede e senza buffer.
 *
 * Le promesse sotto prova: non lancia MAI (la chiamano due route a lavoro già fatto); una riga
 * di log per chiamata, anche quando non c'è niente da dire; gli admin si leggono solo quando
 * servono; un invio fallito non ferma gli altri. I testi veri (`avvisi-testi.ts`) NON sono
 * sostituiti: qui si guarda a chi va cosa, e la loro forma la prova il loro test.
 *
 * Gli uuid sono finti: il repository è pubblico.
 */

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  enqueueNotifiche: vi.fn(),
  staffScuola: vi.fn(),
  sediReali: vi.fn(),
}))
// Il logger vero con la sola `logEvento` sostituita.
vi.mock('@/lib/logging/logger', async (originale) => {
  const actual = await originale<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueueNotifiche }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: h.staffScuola }))
vi.mock('@/lib/scuole/reali', () => ({ sediReali: h.sediReali }))

import {
  spedisciAvvisiCoda,
  LIMITE_AVVISI_MS,
  ERRORI_PER_CHIAMATA,
  OPERAZIONE_AVVISI,
} from '@/lib/fatture-coda/avvisi'
import { LINK_CODA_FATTURE, type FattiCoda } from '@/lib/fatture-coda/avvisi-testi'
import { MAX_DURATION_BLOCCO_S } from '@/lib/pagamenti/lotto-fatture'

const U1 = '00000000-0000-4000-8000-000000000001'
const U2 = '00000000-0000-4000-8000-000000000002'
const A1 = '00000000-0000-4000-8000-0000000000a1'
const A2 = '00000000-0000-4000-8000-0000000000a2'
const S1 = '00000000-0000-4000-8000-000000000501'
const S2 = '00000000-0000-4000-8000-000000000502'
const G1 = '00000000-0000-4000-8000-000000000b01'
const G2 = '00000000-0000-4000-8000-000000000b02'

const AZIONE = 'fatture-coda-tick'

const vuoti = (): FattiCoda => ({ errori: [], fini: [], pausa: null, sospensione: null, in_attesa: [] })
const fineDiU1 = () => ({
  gruppo_id: G1,
  creato_da: U1,
  accodata_il: '2026-09-24T08:05:00Z',
  voci: 1,
  emesse: 1,
  tolte: 0,
  errori: {},
})

function client(risposta: { data?: unknown; error?: unknown } | (() => never)) {
  const rpc = vi.fn(async () => {
    if (typeof risposta === 'function') return risposta()
    return { data: risposta.data ?? null, error: risposta.error ?? null }
  })
  return { sb: { rpc } as unknown as SupabaseClient, rpc }
}

/** Due sedi reali: A1 in entrambe (un solo avviso), A2 nella seconda. */
function adminDiDueSedi() {
  h.sediReali.mockResolvedValue({
    tutte: [{ id: S1, nome: 'x' }, { id: S2, nome: 'y' }],
    reali: [{ id: S1, nome: 'x' }, { id: S2, nome: 'y' }],
    error: null,
    attivaDegradata: false,
  })
  h.staffScuola.mockImplementation(async (_sb: unknown, sede: string) => (sede === S1 ? [A1] : [A1, A2]))
}

const righe = () =>
  h.logEvento.mock.calls.map(([evento, livello, campi]) => ({
    evento,
    livello,
    campi: campi as Record<string, unknown>,
  }))
const esiti = () => righe().map((r) => [r.livello, r.campi.esito])
const destinatari = () => h.enqueueNotifiche.mock.calls.map(([, p]) => [(p as { tipo: string }).tipo, ...(p as { utenteIds: string[] }).utenteIds])

beforeEach(() => {
  h.logEvento.mockReset()
  h.enqueueNotifiche.mockReset().mockResolvedValue(undefined)
  h.staffScuola.mockReset()
  h.sediReali.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('spedisciAvvisiCoda — la RPC che non risponde', () => {
  it.each(['PGRST202', '42883'])('%s (funzione assente) → warn avvisi-non-disponibili, nessun invio', async (code) => {
    const { sb, rpc } = client({ error: { code, message: 'assente' } })
    const r = await spedisciAvvisiCoda(sb, { operazione: AZIONE })
    expect(r).toEqual({ esito: 'non-disponibili', avvisi: 0, tentate: 0 })
    expect(rpc).toHaveBeenCalledWith('fatture_coda_avvisi_prendi', { p_limite: ERRORI_PER_CHIAMATA })
    expect(esiti()).toEqual([['warn', 'avvisi-non-disponibili']])
    expect(righe()[0].evento).toBe('fattura')
    expect(righe()[0].campi).toMatchObject({ operazione: OPERAZIONE_AVVISI, azione: AZIONE })
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
  })

  it('XX000 → error avvisi-non-letti', async () => {
    const { sb } = client({ error: { code: 'XX000', message: 'guasto' } })
    const r = await spedisciAvvisiCoda(sb, { operazione: AZIONE })
    expect(r.esito).toBe('non-letti')
    expect(esiti()).toEqual([['error', 'avvisi-non-letti']])
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
  })

  it('risposta malformata → error avvisi-illeggibili, nessun invio', async () => {
    const { sb } = client({ data: { errori: 'non un array' } })
    const r = await spedisciAvvisiCoda(sb, { operazione: AZIONE })
    expect(r.esito).toBe('illeggibili')
    expect(esiti()).toEqual([['error', 'avvisi-illeggibili']])
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
  })

  it('la RPC che LANCIA → error avvisi-eccezione, e la promessa si risolve', async () => {
    const { sb } = client(() => {
      throw new Error('rete')
    })
    await expect(spedisciAvvisiCoda(sb, { operazione: AZIONE })).resolves.toEqual({
      esito: 'eccezione',
      avvisi: 0,
      tentate: 0,
    })
    expect(esiti()).toEqual([['error', 'avvisi-eccezione']])
  })
})

describe('spedisciAvvisiCoda — tempo e silenzio', () => {
  // Il caso «oltre il limite» qui sotto calcola `inizioMs` DALLA costante: resta verde con
  // qualunque valore. Il margine di T6 (20 s prima del muro dei 300 s della route) lo misura
  // questo: un limite portato al muro, o oltre, lascerebbe segnare avvisi che la piattaforma
  // uccide prima dell'invio.
  it('LIMITE_AVVISI_MS sta 20 s prima di maxDuration (T6)', () => {
    expect(MAX_DURATION_BLOCCO_S * 1_000 - LIMITE_AVVISI_MS).toBe(20_000)
  })

  it('oltre LIMITE_AVVISI_MS dall’inizio della route: la RPC non è chiamata, info avvisi-rinviati', async () => {
    const { sb, rpc } = client({ data: vuoti() })
    const r = await spedisciAvvisiCoda(sb, { operazione: AZIONE, inizioMs: Date.now() - LIMITE_AVVISI_MS - 1_000 })
    expect(r.esito).toBe('rinviati')
    expect(rpc).not.toHaveBeenCalled()
    expect(esiti()).toEqual([['info', 'avvisi-rinviati']])
    expect(typeof righe()[0].campi.ms).toBe('number')
  })

  it('entro il limite la RPC è chiamata', async () => {
    const { sb, rpc } = client({ data: vuoti() })
    await spedisciAvvisiCoda(sb, { operazione: AZIONE, inizioMs: Date.now() - 1_000 })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('nessun fatto → info avvisi-nessuno, nessuna lettura di sedi, nessun invio', async () => {
    const { sb } = client({ data: vuoti() })
    const r = await spedisciAvvisiCoda(sb, { operazione: AZIONE })
    expect(r).toEqual({ esito: 'nessuno', avvisi: 0, tentate: 0 })
    expect(esiti()).toEqual([['info', 'avvisi-nessuno']])
    expect(h.sediReali).not.toHaveBeenCalled()
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
  })
})

describe('spedisciAvvisiCoda — a chi va cosa', () => {
  it('una fine di U1, un «da verificare» di U2, admin [A1, A2]: una chiamata per destinatario, senza sede', async () => {
    adminDiDueSedi()
    const fatti: FattiCoda = {
      ...vuoti(),
      fini: [fineDiU1()],
      errori: [{ gruppo_id: G2, creato_da: U2, codice: 'esito_incerto' }],
    }
    const { sb } = client({ data: fatti })
    const r = await spedisciAvvisiCoda(sb, { operazione: AZIONE })

    expect(r).toEqual({ esito: 'spediti', avvisi: 4, tentate: 4 })
    expect(destinatari()).toEqual([
      ['fattura_coda_fine', U1],
      ['fattura_coda_errori', U2],
      ['fattura_coda_da_verificare', A1],
      ['fattura_coda_da_verificare', A2],
    ])
    // Qui ogni avviso ha UN destinatario solo (fine, errori, «da verificare» per admin): la
    // lunghezza 1 non vede «una sola chiamata con tutti i destinatari». Quella rottura la prende
    // il caso della pausa (tre destinatari in UN avviso), e la ripresa.
    for (const [clientUsato, arg] of h.enqueueNotifiche.mock.calls) {
      expect(clientUsato).toBe(sb)
      expect(arg).toMatchObject({ bufferMin: 0, link: LINK_CODA_FATTURE })
      expect(arg).not.toHaveProperty('scuolaId')
    }
    expect(h.enqueueNotifiche.mock.calls[0][1]).toMatchObject({ entitaTipo: 'fattura_coda_gruppo', entitaId: G1 })

    expect(esiti()).toEqual([['info', 'avvisi-spediti']])
    const riga = righe()[0]
    expect(riga.evento).toBe('fattura')
    expect(riga.campi).toMatchObject({
      operazione: OPERAZIONE_AVVISI,
      azione: AZIONE,
      avvisi: 4,
      tentate: 4,
      admin: 2,
      errori: 1,
      fini: 1,
      pausa: false,
    })
    // Mai un testo nel log: le sole stringhe sono i nomi dell'operazione e dell'esito.
    const stringhe = Object.entries(riga.campi)
      .filter(([, v]) => typeof v === 'string')
      .map(([k]) => k)
      .sort()
    expect(stringhe).toEqual(['azione', 'esito', 'operazione'])
    expect(h.logEvento.mock.calls[0][4]).toEqual({ distingui: ['azione'] })
  })

  it('solo errori da correggere → gli admin non si leggono', async () => {
    const { sb } = client({ data: { ...vuoti(), errori: [{ gruppo_id: G2, creato_da: U1, codice: 'dati_mancanti' }] } })
    const r = await spedisciAvvisiCoda(sb, { operazione: AZIONE })
    expect(h.sediReali).not.toHaveBeenCalled()
    expect(h.staffScuola).not.toHaveBeenCalled()
    expect(destinatari()).toEqual([['fattura_coda_errori', U1]])
    expect(r).toEqual({ esito: 'spediti', avvisi: 1, tentate: 1 })
  })

  // Decisione 21: le anomalie vanno anche agli admin. La RPC ha già segnato il fatto: se il
  // predicato che decide di leggere gli admin le perdesse, il loro avviso non tornerebbe più.
  it('solo un’anomalia (partita_non_registrata) di chi non è admin → gli admin si leggono e la ricevono', async () => {
    adminDiDueSedi()
    const { sb } = client({
      data: { ...vuoti(), errori: [{ gruppo_id: G2, creato_da: U1, codice: 'partita_non_registrata' }] },
    })
    const r = await spedisciAvvisiCoda(sb, { operazione: AZIONE })
    expect(h.sediReali).toHaveBeenCalledTimes(1)
    expect(destinatari()).toEqual([
      ['fattura_coda_errori', U1],
      ['fattura_coda_da_verificare', A1],
      ['fattura_coda_da_verificare', A2],
    ])
    expect(r).toEqual({ esito: 'spediti', avvisi: 3, tentate: 3 })
  })

  it('solo una pausa, in_attesa [U1] → sedi lette una volta, la pausa a U1, A1, A2 in TRE chiamate', async () => {
    adminDiDueSedi()
    const { sb } = client({ data: { ...vuoti(), pausa: { fino_a: '2026-09-24T09:09:59Z' }, in_attesa: [U1] } })
    const r = await spedisciAvvisiCoda(sb, { operazione: AZIONE })
    expect(h.sediReali).toHaveBeenCalledTimes(1)
    expect(h.sediReali).toHaveBeenCalledWith(sb, OPERAZIONE_AVVISI)
    expect(h.staffScuola).toHaveBeenCalledWith(sb, S1, ['admin'])
    expect(destinatari()).toEqual([
      ['fattura_coda_pausa', U1],
      ['fattura_coda_pausa', A1],
      ['fattura_coda_pausa', A2],
    ])
    // UN avviso con tre destinatari: l'unico posto di questo blocco dove «una chiamata per
    // destinatario» si distingue da «una chiamata per avviso».
    expect(h.enqueueNotifiche).toHaveBeenCalledTimes(3)
    for (const [, arg] of h.enqueueNotifiche.mock.calls) {
      expect((arg as { utenteIds: string[] }).utenteIds).toHaveLength(1)
    }
    expect(r).toEqual({ esito: 'spediti', avvisi: 1, tentate: 3 })
    expect(righe().at(-1)!.campi).toMatchObject({ pausa: true, admin: 2 })
  })

  it('sedi non lette → warn admin-non-risolti, e l’avviso a chi ha accodato parte lo stesso', async () => {
    h.sediReali.mockResolvedValue({ tutte: [], reali: [], error: { message: 'giù', code: 'XX000' }, attivaDegradata: false })
    const { sb } = client({ data: { ...vuoti(), errori: [{ gruppo_id: G2, creato_da: U1, codice: 'esito_incerto' }] } })
    const r = await spedisciAvvisiCoda(sb, { operazione: AZIONE })
    expect(esiti()).toEqual([
      ['warn', 'admin-non-risolti'],
      ['info', 'avvisi-spediti'],
    ])
    expect(destinatari()).toEqual([['fattura_coda_errori', U1]])
    expect(r).toEqual({ esito: 'spediti', avvisi: 1, tentate: 1 })
  })

  it('una ripresa, attore A1, e il primo invio che lancia: gli altri partono, A1 mai', async () => {
    adminDiDueSedi()
    h.enqueueNotifiche.mockRejectedValueOnce(new Error('insert'))
    const { sb } = client({
      data: { ...vuoti(), sospensione: { evento: 'ripresa', il: null, da: null }, in_attesa: [U1, U2] },
    })
    const r = await spedisciAvvisiCoda(sb, { operazione: 'coda-sospensione:riprendi', attore: A1 })
    expect(destinatari()).toEqual([
      ['fattura_coda_ripresa', U1],
      ['fattura_coda_ripresa', U2],
      ['fattura_coda_ripresa', A2],
    ])
    expect(r).toEqual({ esito: 'spediti', avvisi: 1, tentate: 3 })
    expect(esiti()).toEqual([
      ['error', 'avviso-non-accodato'],
      ['info', 'avvisi-spediti'],
    ])
    expect(righe()[0].campi).toMatchObject({ tipo: 'fattura_coda_ripresa', azione: 'coda-sospensione:riprendi' })
    expect(righe()[1].campi).toMatchObject({ ripresa: true, sospesa: false })
  })
})
