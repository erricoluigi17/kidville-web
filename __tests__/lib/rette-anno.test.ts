import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CHIAVI_IN_CHIARO } from '@/lib/logging/redact'

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({ logEvento: (...a: unknown[]) => logEvento(...a), logErrore: vi.fn(), logOk: vi.fn() }))

import { annoSedeDelPeriodo, leggiRetteDaGenerare, logRiepilogoRette, riepilogoRette, type RigaRetta } from '@/lib/pagamenti/rette-anno'

/**
 * COMPITO 4.6.3 · gli aiuti per le rette di un anno, con un client finto. Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const ANNO = '44444444-4444-4444-8444-444444444441'

afterEach(() => logEvento.mockReset())

/** Un builder di `anni_sede` che registra i filtri e risponde alla `limit`. */
function clientAnni(risposta: { data?: unknown; error?: unknown }) {
  const filtri: Array<[string, ...unknown[]]> = []
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'lte', 'gte']) q[m] = (...a: unknown[]) => { filtri.push([m, ...a]); return q }
  q.limit = () => Promise.resolve({ data: risposta.data ?? null, error: risposta.error ?? null })
  return { client: { from: () => q } as unknown as SupabaseClient, filtri }
}

/** `rpc` che serve le righe a blocchi, come PostgREST con `range`. */
function clientRpc(righe: unknown[], errore?: unknown) {
  const chiamate: Array<{ fn: string; args: Record<string, unknown> }> = []
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      chiamate.push({ fn, args })
      const q = {
        order: () => q,
        range: (da: number, a: number) => Promise.resolve(errore ? { data: null, error: errore } : { data: righe.slice(da, a + 1), error: null }),
      }
      return q
    },
  } as unknown as SupabaseClient
  return { client, chiamate }
}

const riga = (o: Partial<RigaRetta>): RigaRetta => ({
  periodo: '2027-09-01', alunno_id: 'a', frequenza_id: 'f', importo: 250, origine_importo: 'listino', esito: 'da_generare', gia_generato: false, posizione: 1, ...o,
})

describe('annoSedeDelPeriodo', () => {
  it('con anno: 2027 cerca l’anno nella sede data, mai in un’altra', async () => {
    const { client, filtri } = clientAnni({ data: [{ id: ANNO, stato: 'iscrizioni_aperte' }] })
    const r = await annoSedeDelPeriodo(client, SEDE, { anno: 2027 })
    expect(r).toEqual({ ok: true, annoSedeId: ANNO, stato: 'iscrizioni_aperte' })
    expect(filtri).toContainEqual(['eq', 'scuola_id', SEDE])
    expect(filtri).toContainEqual(['eq', 'anni_scolastici.anno_inizio', 2027])
  })

  it('con periodo risolve l’anno che lo contiene (il mese basta che tocchi l’anno)', async () => {
    const { client, filtri } = clientAnni({ data: [{ id: ANNO, stato: 'corrente' }] })
    await annoSedeDelPeriodo(client, SEDE, { periodo: '2026-10-01' })
    expect(filtri).toContainEqual(['lte', 'inizio', '2026-10-31'])
    expect(filtri).toContainEqual(['gte', 'fine', '2026-10-01'])
    expect(filtri).toContainEqual(['eq', 'scuola_id', SEDE])
  })

  it('con l’id dell’anno lo cerca sempre dentro la sede', async () => {
    const { client, filtri } = clientAnni({ data: [] })
    const r = await annoSedeDelPeriodo(client, SEDE, { annoSedeId: ANNO })
    expect(filtri).toContainEqual(['eq', 'scuola_id', SEDE])
    expect(filtri).toContainEqual(['eq', 'id', ANNO])
    expect(r).toEqual({ ok: false, codice: 'ANNO_NON_TROVATO' })
  })

  it('anno inesistente, o niente da cercare → ANNO_NON_TROVATO', async () => {
    expect(await annoSedeDelPeriodo(clientAnni({ data: [] }).client, SEDE, { anno: 2099 })).toEqual({ ok: false, codice: 'ANNO_NON_TROVATO' })
    expect(await annoSedeDelPeriodo(clientAnni({ data: [] }).client, SEDE, {})).toEqual({ ok: false, codice: 'ANNO_NON_TROVATO' })
    expect(await annoSedeDelPeriodo(clientAnni({ data: [] }).client, SEDE, { periodo: 'ottobre' })).toEqual({ ok: false, codice: 'ANNO_NON_TROVATO' })
  })

  it('schema indietro → codice dedicato e una riga info; un altro errore → errore, mai schema-indietro', async () => {
    for (const code of ['PGRST205', '42P01', '42703']) {
      expect(await annoSedeDelPeriodo(clientAnni({ error: { code } }).client, SEDE, { anno: 2027 })).toEqual({ ok: false, codice: 'schema-indietro' })
    }
    expect(logEvento).toHaveBeenCalledWith('pagamento', 'info', expect.objectContaining({ esito: 'rette-schema-indietro' }))
    const e = { code: '57014', message: 'timeout' }
    expect(await annoSedeDelPeriodo(clientAnni({ error: e }).client, SEDE, { anno: 2027 })).toEqual({ ok: false, codice: 'errore', errore: e })
  })
})

describe('leggiRetteDaGenerare', () => {
  it('chiama la funzione con l’anno, il mese e i bambini, e legge a blocchi oltre i 1000', async () => {
    const tutte = Array.from({ length: 2500 }, (_, i) => riga({ frequenza_id: `f${i}`, periodo: '2027-09-01' }))
    const { client, chiamate } = clientRpc(tutte)
    const r = await leggiRetteDaGenerare(client, { annoSedeId: ANNO, periodo: '2027-09-01', alunnoIds: ['x'] })
    expect(r.ok && r.righe).toHaveLength(2500)
    expect(chiamate[0]).toEqual({ fn: 'rette_da_generare', args: { p_anno_sede: ANNO, p_periodo: '2027-09-01', p_alunno_ids: ['x'] } })
    expect(chiamate.length).toBeGreaterThanOrEqual(3)
  })

  it('senza mese né bambini passa NULL', async () => {
    const { client, chiamate } = clientRpc([])
    await leggiRetteDaGenerare(client, { annoSedeId: ANNO })
    expect(chiamate[0].args).toEqual({ p_anno_sede: ANNO, p_periodo: null, p_alunno_ids: null })
  })

  it('PGRST202 / 42883 / 42P01 → schemaIndietro, nessun errore', async () => {
    for (const code of ['PGRST202', '42883', '42P01']) {
      expect(await leggiRetteDaGenerare(clientRpc([], { code }).client, { annoSedeId: ANNO })).toEqual({ ok: false, schemaIndietro: true })
    }
  })

  it('un altro errore → errore, mai schemaIndietro (un anno non aperto non è un database indietro)', async () => {
    const e = { code: 'P0001', message: 'ANNO_NON_COERENTE' }
    const r = await leggiRetteDaGenerare(clientRpc([], e).client, { annoSedeId: ANNO })
    expect(r).toEqual({ ok: false, errore: e })
  })
})

describe('riepilogoRette', () => {
  it('conta esenti, senza importo, pagante assente e già generati; il totale somma solo i candidati non già fatti', () => {
    const r = riepilogoRette([
      riga({ importo: 250, origine_importo: 'listino' }),
      riga({ importo: 310.5, origine_importo: 'frequenza' }),
      riga({ importo: 280, origine_importo: 'listino_fascia' }),
      riga({ importo: 250, gia_generato: true }), // già fatta: non è un candidato né pesa nel totale
      riga({ esito: 'esente', importo: null, origine_importo: null }),
      riga({ esito: 'senza_importo', importo: null, origine_importo: null, alunno_id: 'bambino-1' }),
      riga({ esito: 'senza_importo', importo: null, origine_importo: null, alunno_id: 'bambino-2', periodo: '2026-09-01' }),
      riga({ esito: 'senza_importo', importo: null, origine_importo: null, alunno_id: 'bambino-2', periodo: '2026-10-01' }), // stesso bambino, altro mese: è UN bambino
      riga({ esito: 'senza_importo', importo: null, origine_importo: null, gia_generato: true }), // la voce c'è: nulla manca
      riga({ esito: 'pagante_assente', importo: null, origine_importo: null }),
    ])
    expect(r).toEqual({
      candidati: 3, esenti: 1, senzaImporto: 2, paganteAssente: 1, giaGenerati: 2, totale: 840.5,
      perOrigine: { listino: 1, frequenza: 1, listino_fascia: 1 },
    })
  })

  it('nessuna riga: tutto a zero', () => {
    expect(riepilogoRette([])).toEqual({ candidati: 0, esenti: 0, senzaImporto: 0, paganteAssente: 0, giaGenerati: 0, totale: 0, perOrigine: {} })
  })
})

describe('logRiepilogoRette', () => {
  const R = { candidati: 4, esenti: 1, senzaImporto: 2, paganteAssente: 1, giaGenerati: 0, totale: 1000, perOrigine: {} }

  it('un info sempre; un warn per i senza importo e uno per i paganti assenti', () => {
    logRiepilogoRette('pagamenti/genera-rette:POST', SEDE, ANNO, R)
    const chiamate = logEvento.mock.calls.map((c) => [c[1], (c[2] as Record<string, unknown>).esito, (c[2] as Record<string, unknown>).n])
    expect(chiamate).toEqual([['info', 'rette-riepilogo', 4], ['warn', 'rette-senza-importo', 2], ['warn', 'rette-pagante-assente', 1]])
  })

  it('niente warn quando non c’è niente da dire', () => {
    logRiepilogoRette('x', SEDE, ANNO, { ...R, senzaImporto: 0, paganteAssente: 0 })
    expect(logEvento).toHaveBeenCalledTimes(1)
  })

  it('il log contiene solo uuid e numeri, e chiavi che la lista bianca conosce: l’importo non esce', () => {
    logRiepilogoRette('pagamenti/genera-rette:POST', SEDE, ANNO, R)
    const consentite = new Set<string>([...CHIAVI_IN_CHIARO, 'scuola_id', 'entita_id', 'n'])
    for (const c of logEvento.mock.calls) {
      const campi = c[2] as Record<string, unknown>
      for (const [k, v] of Object.entries(campi)) {
        expect(consentite.has(k), `la chiave ${k}`).toBe(true)
        expect(typeof v === 'number' || /^[0-9a-f-]{36}$/.test(String(v)) || ['operazione', 'esito'].includes(k), `il valore di ${k}`).toBe(true)
      }
      expect(Object.keys(campi)).not.toContain('totale')
      expect(Object.keys(campi)).not.toContain('importo')
    }
  })
})
