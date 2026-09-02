import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import { costruisciClient, type StatoFinto } from '../fixtures/pratiche-personale'

// =============================================================================
// IL GATE — chi entra, e da quale porta.
//
// ── PERCHÉ QUESTO FILE ESISTE, e perché il suo verdetto è diverso dal gemello ─
// Sul cockpit delle CANDIDATURE la `PATCH` è riservata alla Direzione: approvare crea
// un account docente, cioè un accesso all'anagrafica dei bambini, e chi si candida è
// una persona di cui la Scuola non sa ancora niente. Qui la linea si sposta di
// proposito — `/anagrafica-personale` è il modulo delle insegnanti GIÀ DIPENDENTI, e
// riconoscerle è mestiere di segreteria — quindi la `PATCH` ammette anche
// `segreteria`.
//
// Uno spostamento di linea è la cosa più facile da fare per sbaglio e la più difficile
// da vedere: un `requireStaff` scritto con l'elenco sbagliato non rompe niente e non
// avvisa nessuno. Le tre frasi che questo file rende misurabili:
//
//  1. anonimo ⇒ 401, su TUTTI e due gli export. Un elenco di pratiche del personale
//     letto senza sessione sarebbe una fuga di codici fiscali e residenze;
//  2. un ruolo che non è dello staff (docente, cuoca, genitore) ⇒ 403, sempre;
//  3. `segreteria` ⇒ passa, su GET E su PATCH. È la riga che, se qualcuno «allineasse»
//     questa route al gemello, diventerebbe rossa — ed è giusto che lo diventi, perché
//     quella modifica lascerebbe le pratiche in attesa per sempre: l'unica persona
//     capace di chiuderle sarebbe l'unica che non smista la posta.
//
// E il gate viene PRIMA di tutto: nessuna riga letta, nessun corpo consumato.
// =============================================================================

const PRATICA_ID = 'dddddddd-0000-4000-8000-00000000000a'

const h = vi.hoisted(() => ({
  state: {
    tabelle: {} as Record<string, Record<string, unknown>[]>,
    inserimenti: [] as { table: string; row: Record<string, unknown> }[],
    aggiornamenti: [] as { table: string; patch: Record<string, unknown>; filtri: { col: string; vals: unknown[] }[] }[],
    upserts: [] as { table: string; row: Record<string, unknown>; onConflict: string | null }[],
    authUsers: [] as { id: string; email: string }[],
    creazioniAuth: [] as { email: string; password?: string }[],
    cancellazioniAuth: [] as string[],
    erroriTabella: {} as Record<string, { code?: string; message: string }>,
    colonneAssenti: {} as Record<string, string[]>,
    erroreStorage: null as null | { message: string },
    urlFirmate: [] as { path: string; secondi: number }[],
    erroreCreazioneAuth: null as null | { message: string; status?: number },
  },
  /** Il ruolo dell'utente sotto test: è l'unica leva di questo file. */
  ruolo: 'segreteria' as string | null,
  ruoliVisti: [] as (string[] | undefined)[],
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// `restringiSedi` resta VERA: la sede chiesta col filtro deve intersecare davvero,
// e un finto che dicesse sempre di sì non proverebbe nessun diniego.
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE_A],
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => costruisciClient(h.state as unknown as StatoFinto),
  createClient: async () => costruisciClient(h.state as unknown as StatoFinto),
}))

import { GET, PATCH } from '@/app/api/admin/pratiche-personale/route'

const get = () => GET(new NextRequest('http://localhost/api/admin/pratiche-personale'))
const rifiuta = () =>
  PATCH(new NextRequest('http://localhost/api/admin/pratiche-personale', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: PRATICA_ID, action: 'rifiuta' }),
  }))

/** I ruoli che NON sono staff: nessuno di loro deve vedere una pratica. */
const FUORI = ['educator', 'cuoca', 'genitore', 'parent']

beforeEach(() => {
  vi.clearAllMocks()
  h.ruolo = 'segreteria'
  h.ruoliVisti = []
  Object.assign(h.state, {
    inserimenti: [], aggiornamenti: [], upserts: [], erroriTabella: {}, colonneAssenti: {},
    erroreStorage: null, urlFirmate: [],
  })
  h.state.tabelle = {
    pratiche_personale: [{
      id: PRATICA_ID, scuola_id: SEDE_A, stato: 'pending',
      nome: 'Prova', cognome: 'Cognome', email: 'maestra.prova@example.test',
      gradi: ['nido'], creata_il: '2026-08-11T08:00:00.000Z',
    }],
    schools: [{ id: SEDE_A, nome: 'Kidville Alfa' }],
    utenti: [], parents: [], anagrafica_personale: [],
  }
  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    h.ruoliVisti.push(allowed)
    if (h.ruolo === null) return { response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) }
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    if (!ammessi.includes(h.ruolo)) return { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
    return { user: { id: 'u-1', role: h.ruolo, scuola_id: SEDE_A } }
  })
})

describe('pratiche personale · gate', () => {
  it('anonimo: 401 su GET e su PATCH, e niente esce dal database', async () => {
    h.ruolo = null
    expect((await get()).status).toBe(401)
    expect((await rifiuta()).status).toBe(401)
    expect(h.state.aggiornamenti).toEqual([])
  })

  for (const ruolo of FUORI) {
    it(`ruolo «${ruolo}»: 403 su GET e su PATCH`, async () => {
      h.ruolo = ruolo
      expect((await get()).status).toBe(403)
      expect((await rifiuta()).status).toBe(403)
      expect(h.state.aggiornamenti).toEqual([])
    })
  }

  it('la SEGRETERIA legge l’elenco (è lei che smista la posta)', async () => {
    h.ruolo = 'segreteria'
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data).toHaveLength(1)
  })

  it('la SEGRETERIA può DECIDERE, e questa riga è la differenza col cockpit delle candidature', async () => {
    h.ruolo = 'segreteria'
    const res = await rifiuta()
    expect(
      res.status,
      'la PATCH è stata ristretta alla Direzione: le pratiche resterebbero in attesa per ' +
        'sempre, perché l’unica persona capace di chiuderle sarebbe l’unica che non smista la posta',
    ).toBe(200)
    expect(h.state.tabelle.pratiche_personale[0].stato).toBe('rifiutata')
  })

  it('la PATCH dichiara i tre ruoli invece di ereditare il default', async () => {
    // Non è pedanteria: il default di `requireStaff` può cambiare, e una scrittura che
    // non dichiara chi ammette segue quel cambiamento senza che nessuno lo decida.
    await rifiuta()
    expect(h.ruoliVisti.at(-1)).toEqual(['admin', 'coordinator', 'segreteria'])
  })

  for (const ruolo of ['admin', 'coordinator']) {
    it(`la Direzione (${ruolo}) resta ammessa`, async () => {
      h.ruolo = ruolo
      expect((await get()).status).toBe(200)
      expect((await rifiuta()).status).toBe(200)
    })
  }
})
