import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

/**
 * Compito 4.3.7 · il pre-flight dell'import massivo guarda le sezioni dell'anno ATTIVO.
 *
 * Una classe che esiste SOLO nel 2027/28 (creata in anticipo dalla segreteria) non è una classe di oggi: il trigger
 * `sync_alunno_section_id` non la risolve, quindi la domanda va in `da_controllare` e non si scrive niente. Le tabelle
 * `sections` e `anni_sede` sono quelle del finto che APPLICA i filtri; il resto è il finto piatto dell'altro file.
 * Con lo schema dell'anno indietro (la CI) nessun filtro: la stessa classe passa, senza errori.
 */
const A2 = 'a2222222-2222-4222-8222-222222222222'
const S2 = 'b2222222-2222-4222-8222-aaaaaaaaaaaa'
const A3 = 'a3333333-3333-4333-8333-333333333333'
const S3 = 'b3333333-3333-4333-8333-aaaaaaaaaaaa'

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...log, EVENTI_PERSISTITI: new Set(['iscrizione', 'cron']) }))

const db = vi.hoisted(() => {
  const state = {
    elenchi: [] as Array<Record<string, unknown>>,
    domande: [] as Array<Record<string, unknown>>,
    lotto: [] as string[],
    /** Le sezioni della sede, come le vede PostgREST. */
    sezioni: [] as Array<Record<string, unknown>>,
    sezioniError: null as unknown,
    dbFinto: {} as Record<string, Array<Record<string, unknown>>>,
    erroriFinto: {} as Record<string, { code: string; message?: string }>,
    /** Guasti finti: la lettura delle domande della sede, e la scrittura dello stato. */
    domandeError: null as unknown,
    sospendiError: null as unknown,
    rpc: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  }
  function client(): unknown {
    const finto = creaFintoSupabase(state.dbFinto as DBFinto, [], {
      errori: state.erroriFinto,
      rpc: { anno_attivo: () => ({ data: S2, error: null }) },
    })
    return {
      from(table: string) {
        if (table === 'sections' || table === 'anni_sede') return finto.from(table)
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not', 'is', 'lt', 'lte', 'gte', 'update', 'delete']) {
          b[m] = () => b
        }
        const risolvi = (): { data: unknown; error: unknown } => {
          if (table === 'iscrizioni_elenco_caricamenti') return { data: state.elenchi, error: null }
          if (table === 'enrollment_submissions') {
            return state.domandeError ? { data: null, error: state.domandeError } : { data: state.domande, error: null }
          }
          if (table === 'sections') return { data: state.sezioni, error: state.sezioniError }
          return { data: [], error: null }
        }
        b.maybeSingle = async () => risolvi()
        b.single = async () => risolvi()
        b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(ok, ko)
        return b
      },
      rpc(nome: string, args: Record<string, unknown>) {
        if (nome === 'anno_attivo') return finto.rpc(nome, args)
        state.rpc.push({ nome, args })
        const esito = nome === 'iscrizioni_prendi_in_carico'
          ? { data: state.lotto, error: null }
          : nome === 'iscrizioni_sospendi' && state.sospendiError
            ? { data: null, error: state.sospendiError }
            : { data: null, error: null }
        return { then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esito).then(ok, ko) }
      },
    }
  }
  return { state, client }
})
const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

const lotto = vi.hoisted(() => ({
  caricaElenco: vi.fn(async () => ({ righe: [{ id: 'r1', classe: 'RIGA', nome: 'RIGA UNICA', riga: 2, retta: 180, rettaTesto: null }], caricatoIl: null })),
  caricaDecisioni: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/iscrizioni/import/lotto', async (originale) => {
  const vero = await originale<typeof import('@/lib/iscrizioni/import/lotto')>()
  return { ...vero, caricaElenco: lotto.caricaElenco, caricaDecisioni: lotto.caricaDecisioni }
})

/** La classe assegnata è il perno di questi test: si pilota da qui. */
const analisi = vi.hoisted(() => ({
  classe: 'SEZIONE ESISTENTE',
  decidi: vi.fn(() => ({
    tipo: 'invia',
    assegnazioni: [{ indice: 0, nome: 'Bambina', cognome: 'Inventata', classe: analisi.classe, retta: 180, aCaricoDi: null }],
    referente: { nome: 'Genitore', cognome: 'Inventato', email: 'genitore@example.test', codiceFiscale: null, ruolo: 'madre' },
  })),
}))
vi.mock('@/lib/iscrizioni/import/analisi', async (originale) => {
  const vero = await originale<typeof import('@/lib/iscrizioni/import/analisi')>()
  return { ...vero, decidi: analisi.decidi }
})

const esegui = vi.hoisted(() => ({
  eseguiDomanda: vi.fn(async () => ({ esito: 'inviata', messageId: 'm-1', errore: null, emailSpedite: 1 })),
}))
vi.mock('@/lib/iscrizioni/import/esegui', () => esegui)

const inviti = vi.hoisted(() => ({
  invitiPrevisti: vi.fn(async () => 1),
  riprendiInvitiSospesi: vi.fn(async () => ({ spedite: 0, fallite: 0, rinviata: false })),
  emailSpediteOggi: vi.fn(async () => 0),
}))
vi.mock('@/lib/iscrizioni/import/inviti', () => inviti)

const mail = vi.hoisted(() => ({ sendEmailDetailed: vi.fn(async () => ({ ok: true, messageId: 'm-1' })) }))
vi.mock('@/lib/email/send', () => mail)
const contesto = vi.hoisted(() => ({ risolviContestoSede: vi.fn(async () => ({ email: 'segreteria@example.test', nome: 'Sede di prova' })) }))
vi.mock('@/lib/email/contesto', () => contesto)
vi.mock('@/lib/format/fiscal-date', () => ({ oggiFiscaleISO: () => '2026-08-25', annoFiscale: () => 2026 }))

import { POST } from '@/app/api/iscrizione/import-massivo/route'

const SEGRETO = 'segreto-di-prova'
const SEDE = '11111111-1111-1111-1111-111111111111'

function req(corpo: unknown): Request {
  return new Request('http://localhost/api/iscrizione/import-massivo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': SEGRETO },
    body: JSON.stringify(corpo),
  })
}

/** Una domanda inventata: nomi di fantasia e domini `.test`, il repo è pubblico. */
function domanda(id: string): Record<string, unknown> {
  return {
    id,
    scuola_id: SEDE,
    created_at: '2026-07-01T09:00:00Z',
    data: {
      children: [{ nome: 'Bambina', cognome: 'Inventata', data_nascita: '2022-04-05' }],
      adults: [{ first_name: 'Genitore', last_name: 'Inventato', email: 'genitore@example.test', ruolo: 'madre' }],
    },
  }
}

function sospensioni(): Array<Record<string, unknown>> {
  return db.state.rpc.filter((c) => c.nome === 'iscrizioni_sospendi').map((c) => c.args)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = SEGRETO
  supa.createAdminClient.mockImplementation(() => db.client())
  supa.createClient.mockImplementation(() => db.client())
  db.state.elenchi = [{ scuola_id: SEDE, attivo: true }]
  db.state.domande = [domanda('d-1')]
  db.state.lotto = ['d-1']
  db.state.sezioniError = null
  db.state.erroriFinto = {}
  db.state.dbFinto = {
    anni_sede: [
      { id: S2, scuola_id: SEDE, anno_id: A2, stato: 'corrente', domande_aperte: false },
      { id: S3, scuola_id: SEDE, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
    ],
    sections: [
      { id: 'sez-attiva', scuola_id: SEDE, name: 'CLASSE ATTIVA', anno_id: A2 },
      { id: 'sez-futura', scuola_id: SEDE, name: 'CLASSE FUTURA', anno_id: A3 },
    ],
  }
  db.state.domandeError = null
  db.state.sospendiError = null
  db.state.rpc = []
  analisi.classe = 'CLASSE ATTIVA'
})

describe('import massivo · il pre-flight guarda le sezioni dell\'anno attivo', () => {
  it('la classe dell\'anno ATTIVO passa: la domanda viene eseguita (controllo positivo)', async () => {
    analisi.classe = 'CLASSE ATTIVA'
    await POST(req({}))
    expect(esegui.eseguiDomanda).toHaveBeenCalledTimes(1)
    expect(sospensioni()).toHaveLength(0)
  })

  it('la classe che esiste SOLO nel 2027/28 non passa: da_controllare e nessuna scrittura', async () => {
    analisi.classe = 'CLASSE FUTURA'
    const res = await POST(req({}))
    const body = (await res.json()) as { daControllare?: number }
    expect(esegui.eseguiDomanda).not.toHaveBeenCalled()
    expect(body.daControllare).toBe(1)
    expect(sospensioni()[0].p_stato).toBe('da_controllare')
  })

  it('con lo schema dell\'anno indietro: nessun filtro, la stessa classe passa e non ci sono errori', async () => {
    db.state.erroriFinto = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
    db.state.dbFinto.sections = db.state.dbFinto.sections.map((s) => {
      const c = { ...s }
      delete c.anno_id
      return c
    })
    analisi.classe = 'CLASSE FUTURA'
    await POST(req({}))
    expect(esegui.eseguiDomanda).toHaveBeenCalledTimes(1)
    expect(sospensioni()).toHaveLength(0)
  })
})
