import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// IL GATE del cruscotto «Scadenze documenti» — chi entra, e che cosa può scrivere.
//
// Quattro difetti reali, e nessuno di questi fa rumore da nessun'altra parte:
//
//  1. UN ANONIMO CHE LEGGE. È il difetto misurato il 2026-08-02 su due route di
//     questo repo (`primaria/docenti-materie:GET` rispondeva **200** a chiunque):
//     una route senza gate non fallisce e non avvisa — risponde. Qui dietro ci
//     sono i documenti d'identità del personale.
//  2. LA SEGRETERIA ESCLUSA PER DISTRAZIONE. `requireStaff(request, ['admin',
//     'coordinator'])` si scrive senza accorgersene copiando da una route
//     vicina, e chiuderebbe fuori proprio chi sta al banco quando la maestra
//     arriva con il documento nuovo. Il test guarda gli ARGOMENTI della
//     chiamata, non l'esito: con l'elenco esplicito la segreteria prende 403 e
//     nessuna asserzione sul percorso felice se ne accorgerebbe.
//  3. `utente_id` SCRITTO DAL CORPO. Sarebbe una PATCH che risponde 200 e
//     attacca l'anagrafica — documento compreso — a un'ALTRA persona. Il gate di
//     sede non lo intercetta: la persona bersaglio può essere della stessa sede.
//  4. `documento_path` SCRITTO DAL CORPO. Il percorso è la chiave che `?doc=`
//     firma: chi potesse scriverlo punterebbe l'anagrafica di una collega a un
//     file qualunque del bucket e poi ne chiederebbe la firma passando dal gate,
//     che verificherebbe la SEDE e la troverebbe giusta.
// =============================================================================

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

const ADMIN = { id: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }
const MAESTRA = 'dddddddd-0000-4000-8000-00000000000a'

const h = vi.hoisted(() => {
  const state = {
    utente: null as { id: string; role: string; scuola_id: string } | null,
    scuole: [] as string[],
    tabelle: {} as Record<string, Riga[]>,
    letture: [] as { table: string; cols: string; filtri: Filtro[] }[],
    scritture: [] as { table: string; record: Riga }[],
    firme: [] as { bucket: string; path: string; secondi: number }[],
  }
  return {
    state,
    requireStaff: vi.fn(),
    logScrittura: vi.fn(),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    logOk: vi.fn(),
    assertUtenteInScope: vi.fn(async () => null as NextResponse | null),
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => h.state.scuole,
  assertUtenteInScope: h.assertUtenteInScope,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => finto(),
  createClient: async () => finto(),
}))

function proietta(r: Riga, cols: string): Riga {
  if (!cols || cols.trim() === '*') return { ...r }
  const fuori: Riga = {}
  for (const c of cols.split(',').map((s) => s.trim()).filter(Boolean)) if (c in r) fuori[c] = r[c]
  return fuori
}

function finto() {
  const righeDi = (t: string) => (h.state.tabelle[t] ??= [])
  return {
    from(table: string) {
      const filtri: Filtro[] = []
      let cols = '*'
      let daScrivere: Riga | null = null
      const corrisponde = (r: Riga) => filtri.every((f) => f.vals.some((v) => r[f.col] === v))
      const esegui = () => {
        if (daScrivere) {
          h.state.scritture.push({ table, record: { ...daScrivere } })
          const chiave = daScrivere.utente_id
          const esistente = righeDi(table).find((r) => r.utente_id === chiave)
          if (esistente) Object.assign(esistente, daScrivere)
          else righeDi(table).push({ ...daScrivere })
          const scritta = righeDi(table).find((r) => r.utente_id === chiave) as Riga
          return { data: [proietta(scritta, cols)], error: null }
        }
        const trovate = righeDi(table).filter(corrisponde)
        h.state.letture.push({ table, cols, filtri: filtri.map((f) => ({ ...f })) })
        return { data: trovate.map((r) => proietta(r, cols)), error: null }
      }
      const b: Record<string, unknown> = {}
      b.select = (c?: string) => { if (typeof c === 'string') cols = c; return b }
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.order = () => b
      b.limit = () => b
      b.upsert = (v: Riga) => { daScrivere = v; return b }
      b.maybeSingle = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.single = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
      return b
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, secondi: number) => {
          h.state.firme.push({ bucket, path, secondi })
          return { data: { signedUrl: `https://storage.test/${path}?token=finto` }, error: null }
        },
      }),
    },
  }
}

import { GET, PATCH } from '@/app/api/admin/anagrafica-personale/route'

const URL_ROUTE = 'http://localhost/api/admin/anagrafica-personale'
const get = (qs = '') => new NextRequest(`${URL_ROUTE}${qs}`)
const patch = (body: unknown) =>
  new NextRequest(URL_ROUTE, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  // ⚠️ IL TEMPO È CONGELATO. Senza, un test che asserisce «scaduto» su una data
  // fissa diventa rosso da solo il giorno in cui quella data arriva — è successo
  // in questo repo, su `parent-attendance-elenco`, e il rosso è comparso su
  // `main` senza che nessuno avesse toccato il codice.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-12T09:00:00.000Z'))
  h.state.utente = ADMIN
  h.state.scuole = [SEDE_A]
  h.state.letture = []
  h.state.scritture = []
  h.state.firme = []
  h.state.tabelle = {
    utenti: [{ id: MAESTRA, nome: 'Prova', cognome: 'Prova', ruolo: 'educator', scuola_id: SEDE_A, email: 'p@example.test' }],
    anagrafica_personale: [
      { utente_id: MAESTRA, document_type: 'CI', document_number: 'AB0000000', document_expiry: '2027-01-01', documento_path: 'documenti/mio.pdf', cessato_il: null },
    ],
  }
  h.assertUtenteInScope.mockImplementation(async () => null)
  h.requireStaff.mockImplementation(async () =>
    h.state.utente ? { user: h.state.utente } : { response: NextResponse.json({ error: 'x' }, { status: 401 }) },
  )
})

afterEach(() => { vi.useRealTimers() })

describe('cruscotto scadenze documenti · il gate', () => {
  it('un anonimo non legge NIENTE: 401, nessuna query, nessuna firma', async () => {
    h.state.utente = null
    const res = await GET(get())
    expect(res.status).toBe(401)
    expect(h.state.letture, 'una query è partita prima del gate').toEqual([])
    expect(h.state.firme).toEqual([])
  })

  it('un anonimo non scrive: 401 e nessuna riga toccata', async () => {
    h.state.utente = null
    const res = await PATCH(patch({ utenteId: MAESTRA, document_expiry: '2030-01-01' }))
    expect(res.status).toBe(401)
    expect(h.state.scritture).toEqual([])
  })

  it('la SEGRETERIA è ammessa: il gate non porta un elenco di ruoli ristretto', async () => {
    await GET(get())
    await PATCH(patch({ utenteId: MAESTRA, document_expiry: '2030-01-01' }))
    for (const chiamata of h.requireStaff.mock.calls) {
      expect(
        chiamata[1],
        'il gate restringe i ruoli: la segreteria — che è chi sta al banco — resterebbe fuori',
      ).toBeUndefined()
    }
  })

  it('`utente_id` nel CORPO non sposta l’anagrafica: si scrive quello VERIFICATO', async () => {
    const ALTRO = 'dddddddd-0000-4000-8000-0000000000ff'
    const res = await PATCH(patch({ utenteId: MAESTRA, utente_id: ALTRO, document_expiry: '2030-01-01' }))
    expect(res.status).toBe(200)
    const scrittura = h.state.scritture.at(-1)
    expect(scrittura?.table).toBe('anagrafica_personale')
    expect(
      scrittura?.record.utente_id,
      'il corpo ha spostato l’anagrafica su un’altra persona: documento compreso',
    ).toBe(MAESTRA)
  })

  it('`documento_path` nel CORPO non si scrive: è la chiave che `?doc=` firma', async () => {
    const res = await PATCH(patch({ utenteId: MAESTRA, documento_path: 'documenti/di-un-altra.pdf', document_expiry: '2030-01-01' }))
    expect(res.status).toBe(200)
    expect(h.state.scritture.at(-1)?.record).not.toHaveProperty('documento_path')
  })

  it('una PATCH senza nessun campo è 400, non un 200 che non ha fatto niente', async () => {
    const res = await PATCH(patch({ utenteId: MAESTRA }))
    expect(res.status).toBe(400)
    expect(h.state.scritture).toEqual([])
  })

  it('un tipo di documento fuori enum è 400: `CI`/`PP`/`DL` e basta', async () => {
    const res = await PATCH(patch({ utenteId: MAESTRA, document_type: 'TESSERA' }))
    expect(res.status).toBe(400)
    expect(h.state.scritture).toEqual([])
  })

  it('una data inesistente nel calendario è 400, non un 500 di Postgres', async () => {
    // `2026-02-30` supera una regex sul formato e muore in tabella con `22008`.
    const res = await PATCH(patch({ utenteId: MAESTRA, document_expiry: '2026-02-30' }))
    expect(res.status).toBe(400)
    expect(h.state.scritture).toEqual([])
  })

  it('la PATCH passa da `assertUtenteInScope` PRIMA di scrivere', async () => {
    h.assertUtenteInScope.mockImplementation(async () =>
      NextResponse.json({ error: 'Utente fuori dal tuo plesso' }, { status: 403 }),
    )
    const res = await PATCH(patch({ utenteId: MAESTRA, document_expiry: '2030-01-01' }))
    expect(res.status).toBe(403)
    expect(h.state.scritture, 'la scrittura è avvenuta prima del gate di sede').toEqual([])
  })

  it('il NUMERO del documento non finisce nell’audit, la scadenza sì', async () => {
    await PATCH(patch({ utenteId: MAESTRA, document_number: 'CA98765XY', document_expiry: '2030-06-30' }))
    const audit = h.logScrittura.mock.calls.at(-1)?.[1] as { valoreDopo?: Record<string, unknown> } | undefined
    const dopo = audit?.valoreDopo ?? {}
    expect(
      JSON.stringify(dopo),
      'il numero del documento è entrato nel registro IMMUTABILE delle scritture',
    ).not.toContain('CA98765XY')
    // …e ciò che serve a ricostruire chi ha spostato un allarme c'è.
    expect(dopo.document_expiry).toBe('2030-06-30')
    expect(dopo.campi).toEqual(['document_number', 'document_expiry'])
  })

  it('l’audit registra la sede della PERSONA CORRETTA, non quella di chi corregge', async () => {
    // Il caso reale: l'unico admin ha Giugliano come sede primaria e gestisce
    // tutti e tre i plessi. Scrivere la sede dell'attore archivierebbe a
    // Giugliano ogni correzione fatta ad Aversa — in un registro IMMUTABILE,
    // dove `scuola_id` è il modo in cui si filtra per plesso.
    h.state.tabelle.utenti = [
      { id: MAESTRA, nome: 'Prova', cognome: 'Prova', ruolo: 'educator', scuola_id: SEDE_B, email: 'p@example.test' },
    ]
    await PATCH(patch({ utenteId: MAESTRA, document_expiry: '2030-06-30' }))
    const audit = h.logScrittura.mock.calls.at(-1)?.[1] as { scuolaId?: string | null } | undefined
    expect(audit?.scuolaId, 'l’audit archivia la correzione nel plesso di chi l’ha fatta').toBe(SEDE_B)
    expect(audit?.scuolaId).not.toBe(ADMIN.scuola_id)
  })

  it('nessun log porta il numero del documento o il percorso della scansione', async () => {
    await PATCH(patch({ utenteId: MAESTRA, document_number: 'CA98765XY', document_expiry: '2030-06-30' }))
    await GET(get('?doc=documenti%2Fmio.pdf'))
    const scritto = JSON.stringify([...h.logEvento.mock.calls, ...h.logErrore.mock.calls])
    expect(scritto).not.toContain('CA98765XY')
    expect(scritto, 'il percorso è la chiave che apre un documento d’identità').not.toContain('documenti/mio.pdf')
  })

  it('il SUCCESSO della correzione lascia un battito: senza, «nessun log» non distingue niente', async () => {
    await PATCH(patch({ utenteId: MAESTRA, document_expiry: '2030-06-30' }))
    const battito = h.logEvento.mock.calls.find(
      (c) => c[0] === 'personale' && (c[2] as { esito?: string })?.esito === 'anagrafica-corretta',
    )
    expect(battito, 'la correzione riuscita non lascia nessuna riga in `app_log`').toBeTruthy()
    expect(battito?.[1]).toBe('info')
  })
})
