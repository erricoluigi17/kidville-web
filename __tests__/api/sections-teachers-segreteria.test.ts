import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, ErrorePostgrest, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// S27 — DECISIONE ORGANIZZATIVA del titolare (2026-08-01): gli insegnanti di
// riferimento di una sezione li gestisce ANCHE la segreteria, in lettura E in
// scrittura.
//
// Fino a oggi `admin/sections/[id]/teachers` passava `['admin','coordinator']`:
// la segreteria riceveva 403 sul GET e il dettaglio della sezione le mostrava
// una fascia rossa. Non è un fix di cortesia: sposta una responsabilità dalla
// Direzione alla segreteria, e va letto come tale nel PRD.
//
// ⚠️ IL PERMESSO NON È UN LASCIAPASSARE. Concedere un RUOLO non concede una
// SEDE: i due controlli negativi in fondo (segreteria di un altro plesso,
// educator) stanno qui apposta, e ogni asserzione negativa ha accanto il suo
// controllo positivo — altrimenti «non ha scritto» sarebbe vero anche con la
// route rotta.
//
// Qui il gate `requireStaff` è QUELLO VERO (non mockato): il punto sotto esame
// è proprio la lista dei ruoli ammessi, e un mock del gate la renderebbe
// invisibile. L'identità arriva dall'header `x-user-id`, il percorso legacy che
// `resolveIdentity` usa quando non c'è sessione (`createClient` qui lancia,
// come fuori da un contesto di richiesta).
// =============================================================================

const SEC_A1 = '11111111-1111-4111-8111-111111111111' // «2 ANNI» in SEDE_A
const SEC_B1 = '22222222-2222-4222-8222-222222222221' // «2 ANNI» in SEDE_B (omonima)
const DOC_A = '33333333-3333-4333-8333-333333333331'
const DOC_A2 = '33333333-3333-4333-8333-333333333333'
const DOC_B = '33333333-3333-4333-8333-333333333332'
const SEGR_A = '44444444-4444-4444-8444-44444444e6a1'
const SEGR_B = '44444444-4444-4444-8444-44444444e6b1'
const EDU_A = '55555555-5555-4555-8555-555555555551'

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, unknown>,
}))

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    // Nessun cookie: è il caso reale fuori da una richiesta Next, e manda
    // `resolveIdentity` sul percorso header/query.
    createClient: async () => {
      throw new Error('cookies() non disponibile')
    },
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as Scrittura[],
        errori: h.errori as Record<string, ErrorePostgrest>,
      }),
  }
})

import {
  GET as TEACHERS_GET,
  POST as TEACHERS_POST,
  DELETE as TEACHERS_DELETE,
} from '@/app/api/admin/sections/[id]/teachers/route'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const url = (id: string) => `http://localhost/api/admin/sections/${id}/teachers`

const richiesta = (metodo: string, corpo: unknown, id: string, chi: string) =>
  new NextRequest(url(id), {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'x-user-id': chi },
    body: JSON.stringify(corpo),
  })

const lettura = (id: string, chi: string) =>
  new NextRequest(url(id), { headers: { 'x-user-id': chi } })

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_A1, scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' },
    { id: SEC_B1, scuola_id: SEDE_B, name: '2 ANNI', school_type: 'infanzia' },
  ],
  utenti: [
    { id: DOC_A, nome: 'Maestra', cognome: 'Alfa', ruolo: 'educator', role: 'educator', scuola_id: SEDE_A },
    { id: DOC_A2, nome: 'Maestra', cognome: 'Delta', ruolo: 'educator', role: 'educator', scuola_id: SEDE_A },
    { id: DOC_B, nome: 'Maestra', cognome: 'Beta', ruolo: 'educator', role: 'educator', scuola_id: SEDE_B },
    { id: SEGR_A, nome: 'Sofia', cognome: 'Segre', ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_A },
    { id: SEGR_B, nome: 'Sara', cognome: 'Segre', ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_B },
    { id: EDU_A, nome: 'Enzo', cognome: 'Edu', ruolo: 'educator', role: 'educator', scuola_id: SEDE_A },
  ],
  utenti_scuole: [],
  utenti_sezioni: [{ utente_id: DOC_A, section_id: SEC_A1 }],
})

const scrittureSu = (t: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === t)
const legami = () => h.db.utenti_sezioni.map((r) => `${r.utente_id}@${r.section_id}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
})

describe('teachers — la segreteria della sede GESTISCE gli insegnanti di riferimento', () => {
  it('GET: 200, e l\'elenco arriva davvero (assegnati + assegnabili)', async () => {
    const res = await TEACHERS_GET(lettura(SEC_A1, SEGR_A), ctx(SEC_A1))
    const body = (await res.json()) as {
      assigned?: { id: string }[]
      available?: { id: string }[]
      error?: string
    }

    expect(res.status).toBe(200)
    // Il controllo POSITIVO: non basta «non è 403», serve che il riquadro abbia
    // i suoi dati — è quello che la segreteria non vedeva.
    expect(body.assigned?.map((u) => u.id)).toEqual([DOC_A])
    expect(body.available?.map((u) => u.id)).toContain(DOC_A2)
  })

  it('POST: 200 e il legame è NEL DATABASE (non solo uno status buono)', async () => {
    const res = await TEACHERS_POST(richiesta('POST', { utente_id: DOC_A2 }, SEC_A1, SEGR_A), ctx(SEC_A1))

    expect(res.status).toBe(200)
    expect(legami()).toContain(`${DOC_A2}@${SEC_A1}`)
  })

  it('DELETE: 200 e il legame è SPARITO dal database', async () => {
    expect(legami()).toContain(`${DOC_A}@${SEC_A1}`) // stato di partenza, verificato

    const res = await TEACHERS_DELETE(richiesta('DELETE', { utente_id: DOC_A }, SEC_A1, SEGR_A), ctx(SEC_A1))

    expect(res.status).toBe(200)
    expect(legami()).not.toContain(`${DOC_A}@${SEC_A1}`)
  })
})

describe('teachers — il permesso concesso alla segreteria NON attraversa la sede', () => {
  it('segreteria di un ALTRO plesso: 403 e `utenti_sezioni` intatta', async () => {
    const res = await TEACHERS_POST(richiesta('POST', { utente_id: DOC_A2 }, SEC_A1, SEGR_B), ctx(SEC_A1))

    expect(res.status).toBe(403)
    // ⚠️ QUALE controllo ha negato. Senza questa riga il test resterebbe verde
    // anche tornando indietro sul permesso: negherebbe il RUOLO e nessuno se ne
    // accorgerebbe. Qui il ruolo passa, ed è la SEDE a fermare la scrittura.
    expect((await res.json()).error).toBe('Accesso negato: classe fuori dal tuo plesso')
    expect(scrittureSu('utenti_sezioni')).toHaveLength(0)
    expect(legami()).toEqual([`${DOC_A}@${SEC_A1}`])
  })

  it('segreteria di un ALTRO plesso in lettura: 403, e il personale altrui non viene elencato', async () => {
    const res = await TEACHERS_GET(lettura(SEC_A1, SEGR_B), ctx(SEC_A1))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Accesso negato: classe fuori dal tuo plesso')
    // `staffScuola` non è mai partito: l'elenco del personale altrui non è
    // stato nemmeno costruito.
    expect(h.tabelle).not.toContain('utenti_scuole')
  })

  it('educator della sede: resta 403 — il permesso è di Direzione e segreteria, non di chiunque', async () => {
    const res = await TEACHERS_POST(richiesta('POST', { utente_id: DOC_A2 }, SEC_A1, EDU_A), ctx(SEC_A1))

    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Accesso negato: operazione riservata allo staff')
    expect(legami()).toEqual([`${DOC_A}@${SEC_A1}`])
  })
})
