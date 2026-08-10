import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// CHI PUÒ FARE COSA sul cockpit delle candidature insegnanti.
//
// Due gate diversi nello stesso file, ed è tutto il punto:
//  · `GET`   → `requireStaff(request)` col default, cioè admin/coordinator/**segreteria**:
//              la segreteria smista la posta, quindi l'elenco lo deve vedere;
//  · `PATCH` → `requireStaff(request, ['admin','coordinator'])`, cioè **Direzione soltanto**.
//              Approvare una candidatura CREA UN ACCOUNT DOCENTE, e un account docente
//              legge l'anagrafica dei bambini: è la stessa linea che separa
//              `admin/staff:PATCH` e le credenziali staff di `regenerate-credentials`.
//
// Il finto `requireStaff` qui sotto NON risponde sempre la stessa cosa: legge la lista
// `allowed` che la route gli passa e il ruolo dell'utente di turno. Senza quello, un test
// che «passa il gate» sarebbe verde anche se la route chiamasse `requireStaff(request)`
// nudo nella PATCH — cioè proprio il difetto che questo file esiste per impedire.
// =============================================================================

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

const ADMIN = { id: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }
const COORD = { id: 'aaaaaaaa-1111-4000-8000-000000000002', role: 'coordinator', scuola_id: SEDE_A }
const SEGRETERIA = { id: 'aaaaaaaa-1111-4000-8000-000000000003', role: 'segreteria', scuola_id: SEDE_A }
const EDUCATOR = { id: 'aaaaaaaa-1111-4000-8000-000000000004', role: 'educator', scuola_id: SEDE_A }
const GENITORE = { id: 'aaaaaaaa-1111-4000-8000-000000000005', role: 'genitore', scuola_id: SEDE_A }

const CANDIDATURA_ID = 'dddddddd-0000-4000-8000-00000000000d'

const h = vi.hoisted(() => {
  const state = {
    utente: null as { id: string; role: string; scuola_id: string } | null,
    scuole: [] as string[],
    tabelle: {} as Record<string, Riga[]>,
    aggiornamenti: [] as { table: string; patch: Riga }[],
    inserimenti: [] as { table: string; row: Riga }[],
  }
  return {
    state,
    requireStaff: vi.fn(),
    logScrittura: vi.fn(),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    logOk: vi.fn(),
    sendEmail: vi.fn(),
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.state.scuole }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento,
  logErrore: h.logErrore,
  logOk: h.logOk,
}))
vi.mock('@/lib/email/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send')>()
  return { ...actual, sendEmailDetailed: h.sendEmail }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => finto(),
  createClient: async () => finto(),
}))

/** Proiezione: `select('a, b')` restituisce SOLO quelle chiavi. */
function proietta(r: Riga, cols: string): Riga {
  if (!cols || cols.trim() === '*') return { ...r }
  const fuori: Riga = {}
  for (const c of cols.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (c in r) fuori[c] = r[c]
  }
  return fuori
}

function finto() {
  const righeDi = (t: string) => (h.state.tabelle[t] ??= [])
  return {
    from(table: string) {
      const filtri: Filtro[] = []
      let patch: Riga | null = null
      let inserimento: Riga | null = null
      let cols = '*'
      let conteggio = false

      const corrisponde = (r: Riga) => filtri.every((f) => f.vals.some((v) => r[f.col] === v))
      const esegui = () => {
        if (inserimento) {
          const riga = { ...inserimento }
          righeDi(table).push(riga)
          h.state.inserimenti.push({ table, row: riga })
          return { data: [riga], error: null, count: null as number | null }
        }
        const trovate = righeDi(table).filter(corrisponde)
        if (patch) {
          for (const r of trovate) Object.assign(r, patch)
          h.state.aggiornamenti.push({ table, patch: { ...patch } })
          return { data: trovate.map((r) => proietta(r, cols)), error: null, count: null }
        }
        return {
          data: trovate.map((r) => proietta(r, cols)),
          error: null,
          count: conteggio ? trovate.length : null,
        }
      }

      const b: Record<string, unknown> = {}
      b.select = (c?: string, o?: { count?: string }) => {
        if (typeof c === 'string') cols = c
        if (o?.count === 'exact') conteggio = true
        return b
      }
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.order = () => b
      b.range = () => b
      b.limit = () => b
      b.update = (v: Riga) => { patch = v; return b }
      b.insert = (v: Riga) => { inserimento = v; return b }
      b.maybeSingle = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.single = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
      return b
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://x/y' }, error: null }) }) },
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        createUser: async () => ({ data: { user: { id: 'auth-nuovo' } }, error: null }),
      },
    },
  }
}

import { GET, PATCH } from '@/app/api/admin/candidature-insegnanti/route'

const URL_ROUTE = 'http://localhost/api/admin/candidature-insegnanti'
const get = (qs = '') => new NextRequest(`${URL_ROUTE}${qs}`)
const patch = (body: unknown) =>
  new NextRequest(URL_ROUTE, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.state.utente = null
  h.state.scuole = [SEDE_A]
  h.state.aggiornamenti = []
  h.state.inserimenti = []
  h.state.tabelle = {
    candidature_insegnanti: [
      {
        id: CANDIDATURA_ID,
        scuola_id: SEDE_A,
        stato: 'pending',
        nome: 'Prova',
        cognome: 'Prova',
        email: 'prova.candidata@example.test',
        telefono: null,
        gradi: ['infanzia'],
        titolo_studio: 'diploma',
        note: 'testo di prova',
        cv_path: 'candidature/cv-prova.pdf',
        creata_il: '2026-08-10T08:00:00.000Z',
      },
    ],
    schools: [{ id: SEDE_A, nome: 'Sede di Prova' }],
    utenti: [],
    parents: [],
  }
  h.sendEmail.mockResolvedValue({ ok: true, error: null })
  // Il gate FINTO che si comporta come quello vero: default = staff di gestione
  // (segreteria compresa), lista esplicita = solo chi ci sta dentro.
  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    const u = h.state.utente
    if (!u) return { response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }) }
    if (!ammessi.includes(u.role)) return { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
    return { user: u }
  })
})

describe('candidature insegnanti · gate di ruolo', () => {
  it('senza identità: 401 sia in lettura sia in scrittura', async () => {
    expect((await GET(get())).status).toBe(401)
    expect((await PATCH(patch({ id: CANDIDATURA_ID, action: 'approva' }))).status).toBe(401)
  })

  it('la SEGRETERIA legge l’elenco (200)', async () => {
    h.state.utente = SEGRETERIA
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data).toHaveLength(1)
  })

  it('la Direzione (admin e coordinator) legge l’elenco (200)', async () => {
    for (const u of [ADMIN, COORD]) {
      h.state.utente = u
      expect((await GET(get())).status).toBe(200)
    }
  })

  it('docente e genitore non leggono niente (403)', async () => {
    for (const u of [EDUCATOR, GENITORE]) {
      h.state.utente = u
      expect((await GET(get())).status).toBe(403)
    }
  })

  it('la SEGRETERIA non può approvare né rifiutare (403), e non scrive NIENTE', async () => {
    h.state.utente = SEGRETERIA
    for (const action of ['approva', 'rifiuta']) {
      const res = await PATCH(patch({ id: CANDIDATURA_ID, action }))
      expect(res.status, `azione ${action}`).toBe(403)
    }
    expect(h.state.aggiornamenti, 'la segreteria ha scritto sulla candidatura').toEqual([])
    expect(h.state.inserimenti, 'la segreteria ha creato righe').toEqual([])
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
  })

  it('la Direzione supera il gate della PATCH (niente 401/403)', async () => {
    for (const u of [ADMIN, COORD]) {
      h.state.utente = u
      h.state.tabelle.candidature_insegnanti[0].stato = 'pending'
      const res = await PATCH(patch({ id: CANDIDATURA_ID, action: 'rifiuta' }))
      expect([401, 403]).not.toContain(res.status)
    }
  })

  it('il body della PATCH è validato con zod: azione sconosciuta ⇒ 400', async () => {
    h.state.utente = ADMIN
    expect((await PATCH(patch({ id: CANDIDATURA_ID, action: 'cancella' }))).status).toBe(400)
    expect((await PATCH(patch({ id: 'non-un-uuid', action: 'approva' }))).status).toBe(400)
    expect(h.state.aggiornamenti).toEqual([])
  })
})
