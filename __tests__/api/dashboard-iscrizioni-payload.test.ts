import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import type { Proiezione } from '../fixtures/proiezione'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// F4 — `/api/admin/dashboard` consegnava il MODULO D'ISCRIZIONE INTERO.
//
// Il widget «iscrizioni in attesa» mostra «Richiesta N · da gestire» con una
// DATA. La riga che lo alimentava era però:
//
//     .select('id, data, status, created_at')
//     …
//     data: (e.data ?? e.created_at) as string | null
//
// dove `data` NON è una data: è la colonna JSONB `enrollment_submissions.data`,
// cioè l'intero modulo compilato dalla famiglia — 19 campi per adulto (tipo e
// NUMERO del documento d'identità, `documento_path`) e 17 per minore (CODICE
// FISCALE, data di nascita, residenza, `allergies`, `note_mediche`,
// `documento_path`). Il cast `as string | null` impediva a TypeScript di
// accorgersene, e ogni caricamento della dashboard restituiva per intero le 5
// domande pending più recenti.
//
// Dal 16 luglio il modulo pubblico è vivo: sono famiglie vere, e i minori sono
// veri. Qui si asserisce la FORMA ESATTA della risposta — quali chiavi ci sono
// e quali no — non lo status.
//
// ⚠️ METODO. Il finto client di `finto-supabase` NON emula la proiezione: le
// righe tornano intere, quindi un test sul corpo sarebbe verde anche con la
// select vecchia. Si usa `creaFintoSupabaseConProiezione`, che proietta come
// PostgREST: così «il codice fiscale del minore non esce» è una proprietà
// verificata, non asserita. La prova di validità (difetto rimesso ⇒ rosso) è
// nel report del ciclo.
// =============================================================================

const ADMIN = 'aaaa0000-0000-4000-8000-000000000001'
const INVIO = '11111111-1111-4111-8111-111111111111'
const CREATO_IL = '2026-07-30T09:15:00.000Z'

// Valori-sentinella: nessuno è un dato reale, ma ognuno sta al posto di un dato
// reale che nel database di produzione c'è davvero.
const CF_MINORE = 'CFMINORE00A01H501Z'
const ALLERGIA = 'ALLERGIA-SENTINELLA'
const NOTA_MEDICA = 'NOTA-MEDICA-SENTINELLA'
const DOC_ADULTO = 'DOCUMENTO-SENTINELLA'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  proiezioni: [] as { tabella: string; colonne: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabaseConProiezione } = await import('../fixtures/proiezione')
  return {
    createAdminClient: async () =>
      creaFintoSupabaseConProiezione(h.db, h.tabelle, {}, h.proiezioni as Proiezione[]),
  }
})

import { GET as DASHBOARD_GET } from '@/app/api/admin/dashboard/route'

const req = () => new NextRequest('http://localhost/api/admin/dashboard')

/** Il payload integrale di una domanda d'iscrizione, come sta in `data` JSONB. */
const moduloIntegrale = () => ({
  adults: [
    {
      first_name: 'Adulto', last_name: 'Sentinella', fiscal_code: 'CFADULTO00A01H501Z',
      document_type: 'carta_identita', document_number: DOC_ADULTO,
      documento_path: 'form_attachments/adulto.pdf',
      email: 'adulto@example.invalid', phone: '0000000000',
      address: 'Via Sentinella 1', residence_city: 'Città', zip_code: '00000',
    },
  ],
  children: [
    {
      first_name: 'Minore', last_name: 'Sentinella', fiscal_code: CF_MINORE,
      birth_date: '2022-01-01', residence_city: 'Città',
      allergies: ALLERGIA, note_mediche: NOTA_MEDICA,
      documento_path: 'form_attachments/minore.pdf',
    },
  ],
})

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  alunni: [],
  pagamenti: [],
  incassi: [],
  mensa_prenotazioni: [],
  form_submissions: [],
  enrollment_submissions: [
    {
      id: INVIO,
      scuola_id: SEDE_A,
      status: 'pending',
      created_at: CREATO_IL,
      updated_at: CREATO_IL,
      imported_at: null,
      assigned_classes: null,
      credentials: null,
      consents_log: null,
      data: moduloIntegrale(),
    },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.proiezioni = []
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('GET /api/admin/dashboard — il widget iscrizioni riceve una data, non un fascicolo', () => {
  it('ogni voce di `alert.iscrizioni` ha ESATTAMENTE le chiavi { id, data }', async () => {
    const res = await DASHBOARD_GET(req())
    expect(res.status).toBe(200)
    const j = (await res.json()) as { alert: { iscrizioni: Record<string, unknown>[] } }
    expect(j.alert.iscrizioni).toHaveLength(1)
    // La FORMA, non lo status: chiavi presenti e — soprattutto — chiavi assenti.
    expect(Object.keys(j.alert.iscrizioni[0]).sort()).toEqual(['data', 'id'])
  })

  it('`data` è la data di arrivo (`created_at`), non la colonna JSONB `data`', async () => {
    const res = await DASHBOARD_GET(req())
    const j = (await res.json()) as { alert: { iscrizioni: { id: string; data: unknown }[] } }
    const voce = j.alert.iscrizioni[0]
    expect(voce.id).toBe(INVIO)
    expect(voce.data).toBe(CREATO_IL)
    // Il widget fa `new Date(s.data)`: una data valida, non un oggetto.
    expect(typeof voce.data).toBe('string')
    expect(Number.isNaN(new Date(String(voce.data)).getTime())).toBe(false)
  })

  it('nel corpo della risposta non c\'è NIENTE del modulo: né CF del minore, né allergie, né note mediche, né documento', async () => {
    const res = await DASHBOARD_GET(req())
    const corpo = await res.text()
    expect(corpo).not.toContain(CF_MINORE)
    expect(corpo).not.toContain(ALLERGIA)
    expect(corpo).not.toContain(NOTA_MEDICA)
    expect(corpo).not.toContain(DOC_ADULTO)
    expect(corpo).not.toContain('documento_path')
  })

  it('la colonna JSONB `data` non viene nemmeno CHIESTA al database', async () => {
    await DASHBOARD_GET(req())
    const suInvii = h.proiezioni
      .filter((p) => p.tabella === 'enrollment_submissions')
      .map((p) => p.colonne)
    // Due query: il conteggio (`id`, head) e la lista per l'alert.
    expect(suInvii.length).toBeGreaterThan(0)
    for (const colonne of suInvii) {
      const chieste = colonne.split(',').map((c) => c.trim())
      expect(chieste).not.toContain('data')
      expect(chieste).not.toContain('*')
    }
  })

  it('il conteggio `iscrizioni.pending` resta quello di prima (nessuna informazione utile persa)', async () => {
    const res = await DASHBOARD_GET(req())
    const j = (await res.json()) as { iscrizioni: { pending: number } }
    expect(j.iscrizioni.pending).toBe(1)
  })
})
