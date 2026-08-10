import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// «RIFIUTA»: il gesto che NON crea niente.
//
//  · nessun account, nessuna riga `utenti`: una candidatura rifiutata non deve
//    lasciare dietro di sé un accesso;
//  · il claim vale anche qui — chi arriva secondo prende 409, non sovrascrive in
//    silenzio la decisione di una collega;
//  · il MOTIVO è una nota interna: sta in tabella, NON nell'audit e NON nei log
//    (`redact` lo redigerebbe comunque, ma un testo libero non si spedisce a un
//    canale che si legge tutti i giorni);
//  · l'email di cortesia parte SOLO se l'operatore l'ha chiesto, e non riporta
//    nessuna motivazione: quello che si scrive in segreteria non è quello che si
//    dice alla persona.
// =============================================================================

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

const ADMIN = { id: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }
const CANDIDATURA_ID = 'dddddddd-0000-4000-8000-00000000000a'
const EMAIL = 'prova.candidata@example.test'
const MOTIVO = 'Nota interna di prova: profilo non adatto alla fascia richiesta'

const h = vi.hoisted(() => {
  const state = {
    utente: null as { id: string; role: string; scuola_id: string } | null,
    scuole: [] as string[],
    tabelle: {} as Record<string, Riga[]>,
    inserimenti: [] as { table: string; row: Riga }[],
    aggiornamenti: [] as { table: string; patch: Riga }[],
    creazioniAuth: [] as { email: string }[],
    /** Colonne che il DB (finto) dichiara assenti sull'UPDATE (CI non migrata). */
    colonneAssentiUpdate: [] as string[],
  }
  return { state, requireStaff: vi.fn(), logScrittura: vi.fn(), logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn(), sendEmail: vi.fn() }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.state.scuole }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
vi.mock('@/lib/email/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send')>()
  return { ...actual, sendEmailDetailed: h.sendEmail }
})
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
      let patch: Riga | null = null
      let inserimento: Riga | null = null
      const corrisponde = (r: Riga) => filtri.every((f) => f.vals.some((v) => r[f.col] === v))
      const esegui = () => {
        if (inserimento) {
          const riga = { ...inserimento }
          righeDi(table).push(riga)
          h.state.inserimenti.push({ table, row: riga })
          return { data: [riga], error: null, count: null as number | null }
        }
        if (patch) {
          const assente = h.state.colonneAssentiUpdate.find((c) => c in (patch as Riga))
          if (assente) {
            return {
              data: [] as Riga[],
              error: { code: 'PGRST204', message: `Could not find the '${assente}' column of '${table}' in the schema cache` },
              count: null as number | null,
            }
          }
        }
        const trovate = righeDi(table).filter(corrisponde)
        if (patch) {
          for (const r of trovate) Object.assign(r, patch)
          h.state.aggiornamenti.push({ table, patch: { ...patch } })
          return { data: trovate.map((r) => proietta(r, cols)), error: null, count: null }
        }
        return { data: trovate.map((r) => proietta(r, cols)), error: null, count: null }
      }
      const b: Record<string, unknown> = {}
      b.select = (c?: string) => { if (typeof c === 'string') cols = c; return b }
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
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://x' }, error: null }) }) },
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        createUser: async ({ email }: { email: string }) => {
          h.state.creazioniAuth.push({ email })
          return { data: { user: { id: 'auth-1' } }, error: null }
        },
      },
    },
  }
}

import { PATCH } from '@/app/api/admin/candidature-insegnanti/route'

const URL_ROUTE = 'http://localhost/api/admin/candidature-insegnanti'
const patch = (body: unknown) =>
  new NextRequest(URL_ROUTE, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const rifiuta = (extra: Riga = {}) => PATCH(patch({ id: CANDIDATURA_ID, action: 'rifiuta', ...extra }))

beforeEach(() => {
  vi.clearAllMocks()
  h.state.utente = ADMIN
  h.state.scuole = [SEDE_A, SEDE_B]
  h.state.inserimenti = []
  h.state.aggiornamenti = []
  h.state.creazioniAuth = []
  h.state.colonneAssentiUpdate = []
  h.state.tabelle = {
    candidature_insegnanti: [
      {
        id: CANDIDATURA_ID,
        scuola_id: SEDE_A,
        stato: 'pending',
        nome: 'Prova',
        cognome: 'Cognome',
        email: EMAIL,
        telefono: null,
        gradi: ['infanzia'],
        creata_il: '2026-08-10T08:00:00.000Z',
      },
    ],
    schools: [{ id: SEDE_A, nome: 'Kidville Sede di Prova' }],
    utenti: [],
    parents: [],
  }
  h.sendEmail.mockResolvedValue({ ok: true, error: null })
  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    const u = h.state.utente
    if (!u) return { response: NextResponse.json({ error: 'x' }, { status: 401 }) }
    if (!ammessi.includes(u.role)) return { response: NextResponse.json({ error: 'x' }, { status: 403 }) }
    return { user: u }
  })
})

describe('candidature insegnanti · rifiuto', () => {
  it('marca la candidatura come rifiutata e non crea NESSUN account', async () => {
    const res = await rifiuta({ motivo: MOTIVO })
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)

    const cand = h.state.tabelle.candidature_insegnanti[0]
    expect(cand.stato).toBe('rifiutata')
    expect(cand.evasa_da).toBe(ADMIN.id)
    expect(cand.evasa_il).toBeTruthy()
    expect(cand.motivo_rifiuto).toBe(MOTIVO)

    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti.filter((i) => i.table === 'utenti')).toEqual([])
    expect(h.state.tabelle.utenti).toEqual([])
  })

  it('il MOTIVO non finisce né nell’audit né nei log: solo il fatto che ci sia', async () => {
    await rifiuta({ motivo: MOTIVO })

    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const audit = JSON.stringify(h.logScrittura.mock.calls[0][1])
    expect(audit, 'il testo del motivo è finito in audit').not.toContain(MOTIVO)
    expect(audit).toContain('rifiutata')

    const log = JSON.stringify(h.logEvento.mock.calls)
    expect(log, 'il testo del motivo è finito nei log').not.toContain(MOTIVO)
    // …ma il rifiuto lascia comunque una riga: un'evasione muta non si distingue
    // da un'evasione mai avvenuta.
    expect(h.logEvento.mock.calls.some((c) => c[0] === 'candidatura')).toBe(true)
  })

  it('colonna `motivo_rifiuto` assente: l’audit non dichiara un motivo che non è stato scritto', async () => {
    // Stesso ramo di degrado dell'approvazione, stessa regola: il motivo cade dal
    // patch, l'UPDATE passa lo stesso (`stato` è protetto) e `motivo_presente`
    // continuerebbe a dire `true` per una nota che in tabella non c'è. È poco
    // rispetto a un legame con un account, ma è la stessa cosa: l'audit non
    // afferma ciò che non è stato scritto.
    h.state.colonneAssentiUpdate = ['motivo_rifiuto']
    const res = await rifiuta({ motivo: MOTIVO })
    expect(res.status).toBe(200)

    const cand = h.state.tabelle.candidature_insegnanti[0]
    expect(cand.stato).toBe('rifiutata')
    expect(cand.motivo_rifiuto, 'la colonna non esiste: non può esserci finito niente').toBeUndefined()

    const audit = h.logScrittura.mock.calls[0][1] as { valoreDopo: Record<string, unknown> }
    expect(audit.valoreDopo.stato).toBe('rifiutata')
    expect(audit.valoreDopo.motivo_presente).toBe(false)

    // …e chi ha scritto quella nota lo viene a sapere, con il nome della colonna.
    expect((await res.json()).warnings.join(' ')).toMatch(/motivo_rifiuto/)
  })

  it('senza `inviaEmailEsito` non parte nessuna email', async () => {
    await rifiuta({ motivo: MOTIVO })
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it('con `inviaEmailEsito: true` parte un’email neutra, SENZA la motivazione', async () => {
    const res = await rifiuta({ motivo: MOTIVO, inviaEmailEsito: true })
    expect(res.status).toBe(200)
    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    const invio = h.sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string }
    expect(invio.to).toBe(EMAIL)
    expect(invio.text).not.toContain(MOTIVO)
    expect(invio.text).not.toMatch(/password/i)
    expect(invio.text.length).toBeGreaterThan(20)
  })

  it('seconda evasione: 409, e la decisione della collega resta quella che era', async () => {
    expect((await rifiuta()).status).toBe(200)
    const res = await rifiuta({ motivo: 'un secondo motivo' })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CANDIDATURA_GIA_EVASA')
    expect(h.state.tabelle.candidature_insegnanti[0].motivo_rifiuto).toBeFalsy()
  })

  it('una candidatura GIÀ APPROVATA non si rifiuta: 409', async () => {
    h.state.tabelle.candidature_insegnanti[0].stato = 'approvata'
    const res = await rifiuta()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CANDIDATURA_GIA_EVASA')
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('approvata')
  })

  it('una candidatura di un’altra sede non si rifiuta: 404 e niente scritture', async () => {
    h.state.scuole = [SEDE_B]
    const res = await rifiuta()
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('CANDIDATURA_NON_TROVATA')
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
    expect(h.state.aggiornamenti).toEqual([])
  })
})
