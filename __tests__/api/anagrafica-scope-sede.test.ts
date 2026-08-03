import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Isolamento per sede sull'ANAGRAFICA — l'insieme di PII più ampio del sistema.
//
//  · admin/students/[id]      — `select *` dell'alunno (codice fiscale, note
//    mediche) + `parents (*)` (CF, numero e percorso del documento d'identità,
//    indirizzo, telefoni) + `delegates (*)` (documento di chi ritira). Una sola
//    route, un'intera famiglia.
//  · admin/parents GET/PATCH  — anagrafica dei genitori delle tre sedi, in
//    lettura e in scrittura.
//  · admin/parents/[id]       — fascicolo del genitore, coi figli e i co-genitori.
//  · admin/regenerate-credentials — reset password + invio credenziali per email
//    a un genitore (o a un collega) di un'altra sede.
//
// `parents` NON ha `scuola_id` e non deve averlo: un genitore può avere figli in
// due sedi. Lo scope passa dai FIGLI (`assertParentInScope`).
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const PAR_A = 'c1c1c1c1-1111-4111-8111-cccccccccccc'
const PAR_B = 'c2c2c2c2-2222-4222-8222-dddddddddddd'
const STAFF_B = 'd2d2d2d2-2222-4222-8222-eeeeeeeeeeee'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})
// `admin/students/[id]` e `regenerate-credentials` costruiscono il client da
// `@supabase/supabase-js` invece che dal wrapper: va finto anche quello, o
// girerebbero contro il vero client (e il test proverebbe nulla).
vi.mock('@supabase/supabase-js', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createClient: () => creaFintoSupabase(h.db, h.tabelle) }
})

import { GET as STUDENT_ID } from '@/app/api/admin/students/[id]/route'
import { GET as PARENTS, PATCH as PARENTS_PATCH } from '@/app/api/admin/parents/route'
import { GET as PARENT_ID } from '@/app/api/admin/parents/[id]/route'

const req = (url: string) => new NextRequest(`http://localhost${url}`)
const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/parents', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: '2 ANNI' },
    { id: 'sec-b', scuola_id: SEDE_B, name: '2 ANNI' },
  ],
  utenti_scuole: [],
  utenti_sezioni: [],
  utenti: [{ id: STAFF_B, nome: 'Collega', cognome: 'Sede-B', scuola_id: SEDE_B }],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', codice_fiscale: 'CF-ALFA-A', classe_sezione: '2 ANNI', section_id: 'sec-a', scuola_id: SEDE_A },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', codice_fiscale: 'CF-BETA-B', classe_sezione: '2 ANNI', section_id: 'sec-b', scuola_id: SEDE_B },
  ],
  parents: [
    { id: PAR_A, first_name: 'Genitore', last_name: 'DiAlfa', fiscal_code: 'CF-GEN-A', document_number: 'DOC-A' },
    { id: PAR_B, first_name: 'Genitore', last_name: 'DiBeta', fiscal_code: 'CF-GEN-B', document_number: 'DOC-B' },
  ],
  student_parents: [
    { student_id: ALU_A, parent_id: PAR_A, alunni: { scuola_id: SEDE_A } },
    { student_id: ALU_B, parent_id: PAR_B, alunni: { scuola_id: SEDE_B } },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  // `admin/students/[id]` fa `requireEnv` prima di tutto: senza queste due
  // risponde 503 e il test proverebbe la configurazione, non l'isolamento.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'chiave-di-prova')
  h.db = dbBase()
  h.tabelle = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('GET /api/admin/students/[id] — il fascicolo dell\'alunno', () => {
  it('403 su un minore di un\'altra sede, e nessun codice fiscale in risposta', async () => {
    const res = await STUDENT_ID(req(`/api/admin/students/${ALU_B}`), ctx(ALU_B))
    expect(res.status).toBe(403)
    const corpo = await res.text()
    expect(corpo).not.toContain('CF-BETA-B')
    expect(corpo).not.toContain('Beta')
  })

  it('200 su un minore della propria sede', async () => {
    const res = await STUDENT_ID(req(`/api/admin/students/${ALU_A}`), ctx(ALU_A))
    expect(res.status).toBe(200)
  })

  it('senza `SUPABASE_SERVICE_ROLE_KEY` risponde 503 «configurazione mancante», NON 403', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // È UN CAMBIO DI COMPORTAMENTO DICHIARATO (2026-08-03), e non aveva nessun test
    // in nessuno dei due versi. Prima, se la chiave di servizio mancava, la route si
    // costruiva il client con la chiave ANON: la RLS entrava in gioco,
    // `assertAlunnoInScope` leggeva zero righe, e la risposta era **403 «alunno di
    // un'altra sede»**. Cioè un guasto di CONFIGURAZIONE travestito da esito
    // applicativo — la regola 4 di AGENTS.md esiste per questo: chi legge quel 403 va
    // a cercare i permessi, e la chiave manca da un'altra parte.
    //
    // Il ripiego è caduto col passaggio al factory strumentato. Qui si àncora la
    // differenza fra i due stati, perché è precisamente ciò che distingue il
    // miglioramento dalla regressione: **503**, e il nome della variabile nel corpo.
    // ─────────────────────────────────────────────────────────────────────────
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')

    const res = await STUDENT_ID(req(`/api/admin/students/${ALU_A}`), ctx(ALU_A))

    expect(res.status, 'una configurazione mancante non deve travestirsi da 403').toBe(503)
    expect(await res.text()).toContain('SUPABASE_SERVICE_ROLE_KEY')
    // E non ha letto niente: la mancanza di configurazione si scopre PRIMA di toccare
    // l'anagrafica di un minore.
    expect(h.tabelle).toHaveLength(0)
  })
})

describe('GET /api/admin/parents — elenco genitori', () => {
  it('nessun genitore dell\'altra sede, né il suo documento', async () => {
    const res = await PARENTS(req('/api/admin/parents'))
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('DiAlfa')
    expect(corpo).not.toContain('DiBeta')
    expect(corpo).not.toContain('DOC-B')
    expect(corpo).not.toContain('CF-GEN-B')
  })

  it('?student_id di un\'altra sede: 403, e i genitori non vengono nemmeno letti', async () => {
    const res = await PARENTS(req(`/api/admin/parents?student_id=${ALU_B}`))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('parents')
  })
})

describe('GET /api/admin/parents/[id] — fascicolo del genitore', () => {
  it('403 su un genitore dell\'altra sede', async () => {
    const res = await PARENT_ID(req(`/api/admin/parents/${PAR_B}`), ctx(PAR_B))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('DiBeta')
  })

  it('200 su un genitore della propria sede', async () => {
    const res = await PARENT_ID(req(`/api/admin/parents/${PAR_A}`), ctx(PAR_A))
    expect(res.status).toBe(200)
  })
})

describe('PATCH /api/admin/parents — scrittura sull\'anagrafica', () => {
  it('403 sul genitore di un\'altra sede', async () => {
    const res = await PARENTS_PATCH(patch({ id: PAR_B, first_name: 'Manomesso' }))
    expect(res.status).toBe(403)
  })
})

describe('assertParentInScope — un genitore senza figli non è di nessuno', () => {
  it('403: senza legami non c\'è modo di stabilire il plesso, quindi si nega', async () => {
    h.db.student_parents = []
    const res = await PARENT_ID(req(`/api/admin/parents/${PAR_A}`), ctx(PAR_A))
    expect(res.status).toBe(403)
  })
})
