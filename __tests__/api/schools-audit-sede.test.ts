import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

// =============================================================================
// `/api/admin/schools` — L'AUDIT DEVE DIRE SU QUALE SEDE SI È SCRITTO
//
// Task 3.3 di W3 pretende che l'anagrafica delle tre sedi si compili DALLA UI e
// non con una `UPDATE`, perché «il percorso applicativo esercita
// `normalizzaAnagraficaSede`, il gate `requireStaff` e l'audit `logScrittura`».
// I primi due funzionavano. Il terzo no, e l'ha dimostrato proprio la scrittura
// fatta per provarlo.
//
// MISURATO IN PRODUZIONE (2026-08-16, `audit_scritture_docente`, entità
// `multi_sede`): su dodici righe, OTTO attribuiscono a Kidville Giugliano un
// salvataggio avvenuto su Aversa o su Cesa. Sono le righe lasciate dai tre
// `PATCH` di Task 3.3 — l'audit di un'operazione multi-sede non sa dire su quale
// sede si è scritto, e lo dice con l'aria di saperlo.
//
// LA CAUSA RADICE, e non è dentro `logScrittura`. Il registro accetta da sempre
// un `scuolaId` esplicito e ripiega su `attore.scuola_id` solo quando il
// chiamante tace (`src/lib/audit/scrittura.ts:112`). `admin/schools` taceva: per
// un `admin` multi-sede `attore.scuola_id` è la sua sede DI CASA, non quella che
// ha appena modificato, e le due coincidono per caso una volta su tre. È la
// regola di `AGENTS.md` — «ogni scrittura dichiara la sua sede» — non applicata
// alla scrittura che ha per oggetto una sede.
//
// PERCHÉ CONTA. Su `multi_sede` l'entità modificata È una sede, quindi
// l'informazione «quale plesso» non è un contorno del record: è il record. Un
// registro immodificabile che nomina il plesso sbagliato è peggio di un registro
// che tace, perché una verifica successiva gli crede.
//
// METODO. Non si misura «`logScrittura` è stato chiamato» — lo era anche prima,
// ed è esattamente ciò che ha fatto sembrare l'audit sano. Si misura il VALORE
// del campo `scuolaId`, e lo si confronta con `entitaId`: su un'entità che è la
// sede stessa i due devono coincidere sempre. Ogni asserzione ha accanto il caso
// in cui attore e bersaglio COINCIDONO, altrimenti «passa sempre la sede
// dell'attore» supererebbe il test tanto quanto la riparazione.
// =============================================================================

const ADMIN_DI_A_E_B = '11111111-1111-4111-8111-111111111111'

const INTOCCATO = '2026-07-10T12:14:48.157Z'
/** L'uuid che la RPC di provisioning restituisce per la sede appena creata. */
const SEDE_NUOVA = 'dddddddd-0000-4000-8000-00000000000d'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logErrore: h.logErrore, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as Scrittura[],
        rpc: { provisiona_sede: () => ({ data: SEDE_NUOVA, error: null }) },
      }),
  }
})

import { POST, PATCH } from '@/app/api/admin/schools/route'

const patch = (body: unknown) =>
  new Request('http://localhost/api/admin/schools', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const post = (body: unknown) =>
  new Request('http://localhost/api/admin/schools', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  scuole: [
    { id: SEDE_A, nome: NOME_SEDE_A, citta: 'Alfaville', indirizzo: null, attiva: true, config: {}, created_at: INTOCCATO, updated_at: INTOCCATO },
    { id: SEDE_B, nome: NOME_SEDE_B, citta: 'Betaville', indirizzo: null, attiva: true, config: {}, created_at: INTOCCATO, updated_at: INTOCCATO },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E, citta: 'Testville', indirizzo: null, attiva: true, config: {}, created_at: INTOCCATO, updated_at: INTOCCATO },
  ],
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E },
  ],
  utenti: [{ id: ADMIN_DI_A_E_B, ruolo: 'admin', scuola_id: SEDE_A }],
  // Il ponte multi-plesso: l'admin ha in scope A e B, ed è di CASA in A.
  utenti_scuole: [
    { utente_id: ADMIN_DI_A_E_B, scuola_id: SEDE_A },
    { utente_id: ADMIN_DI_A_E_B, scuola_id: SEDE_B },
  ],
  admin_settings: [],
})

/** L'ultima riga d'audit, letta come la scrive il chiamante. */
const audit = () => {
  const chiamate = h.logScrittura.mock.calls
  if (chiamate.length === 0) throw new Error('nessuna riga di audit registrata')
  return chiamate[chiamate.length - 1][1] as {
    scuolaId?: string | null
    entitaTipo: string
    entitaId: string
    azione: string
    attore: { id: string; scuola_id?: string | null }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  // L'admin di W3: tre sedi in scope, una sola sede «di casa».
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN_DI_A_E_B, role: 'admin', scuola_id: SEDE_A } })
})

describe("PATCH /api/admin/schools — l'audit nomina la sede modificata", () => {
  it('salvando su UN ALTRA sede, il registro non attribuisce la scrittura alla sede di casa', async () => {
    const res = await PATCH(patch({ id: SEDE_B, citta: 'Betaville', indirizzo: 'Via Beta 2' }))
    expect(res.status).toBe(200)

    // È la riga che in produzione diceva «Kidville Giugliano» per un salvataggio
    // su Aversa: il bersaglio è SEDE_B, l'attore è di casa in SEDE_A.
    expect(audit().scuolaId).toBe(SEDE_B)
    expect(audit().scuolaId).not.toBe(SEDE_A)
    expect(audit().attore.scuola_id).toBe(SEDE_A)
  })

  it("su un'entità `multi_sede` la sede dell'audit E l'entità sono lo stesso plesso", async () => {
    for (const bersaglio of [SEDE_A, SEDE_B]) {
      h.logScrittura.mockClear()
      const res = await PATCH(patch({ id: bersaglio, anagrafica: { cap: '80014' } }))
      expect(res.status).toBe(200)
      const riga = audit()
      expect(riga.entitaTipo).toBe('multi_sede')
      expect(riga.entitaId).toBe(bersaglio)
      // L'invariante, ed è ciò che rende il registro rileggibile: quando
      // l'entità È una sede, il campo `scuola_id` non può indicarne un'altra.
      expect(riga.scuolaId).toBe(riga.entitaId)
    }
  })

  it('CONTROLLO: sulla propria sede la riga resta corretta (non è «passa sempre l\'attore» al contrario)', async () => {
    const res = await PATCH(patch({ id: SEDE_A, citta: 'Alfaville' }))
    expect(res.status).toBe(200)
    expect(audit().scuolaId).toBe(SEDE_A)
  })
})

describe("POST /api/admin/schools — l'audit della sede appena creata", () => {
  it('la sede della riga è quella NUOVA, non quella di chi l\'ha creata', async () => {
    const res = await POST(post({ nome: 'Kidville Delta', citta: 'Deltaville', indirizzo: 'Via Delta 4' }))
    expect(res.status).toBe(201)

    const riga = audit()
    expect(riga.azione).toBe('insert')
    expect(riga.entitaId).toBe(SEDE_NUOVA)
    // Senza questa riga il registro direbbe che la sede nuova è nata dentro la
    // sede di casa dell'admin — l'unico plesso a cui NON appartiene.
    expect(riga.scuolaId).toBe(SEDE_NUOVA)
    expect(riga.scuolaId).not.toBe(SEDE_A)
  })
})
