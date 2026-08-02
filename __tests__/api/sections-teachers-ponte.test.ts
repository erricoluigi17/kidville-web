import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, ErrorePostgrest, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// `admin/sections/[id]/teachers:GET` — chi lavora in una sede non si trova con
// `utenti.scuola_id` (audit globale 2026-07-31, lock `destinatari-con-ponte`).
//
// L'elenco «insegnanti assegnabili a questa classe» usciva da
// `.eq('scuola_id', section.scuola_id)`: la sola sede PRIMARIA. Il personale
// agganciato alla sede dal ponte `utenti_scuole` — l'unica appartenenza che
// esista per chi lavora su più plessi, e nelle sedi aperte il 2026-07-29
// l'unica che ci fosse — non compariva. Nessun errore, nessun log: una tendina
// corta. È la stessa forma che aveva reso muti quattro canali di notifica
// (mensa/notify, panic-alert, locker/notify, fattura/sync).
//
// Qui si asserisce l'ELENCO, non lo stato HTTP: un 200 con la persona mancante
// è esattamente il difetto.
// =============================================================================

const SEC_A1 = '11111111-1111-4111-8111-111111111111' // «2 ANNI» in SEDE_A
const SEC_B1 = '22222222-2222-4222-8222-222222222221' // «2 ANNI» in SEDE_B (omonima)
const DOC_PRIMARIO = '33333333-3333-4333-8333-333333333331' // sede primaria = SEDE_A
const DOC_PONTE = '33333333-3333-4333-8333-333333333332' // primaria SEDE_B, ponte → SEDE_A
const DOC_ESTRANEO = '33333333-3333-4333-8333-333333333333' // solo SEDE_B
const GENITORE_A = '33333333-3333-4333-8333-333333333334' // in SEDE_A, ma è un genitore
const COORD_A = '44444444-4444-4444-8444-444444444441'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as Scrittura[],
        errori: h.errori as Record<string, ErrorePostgrest>,
      }),
  }
})

import { GET as TEACHERS_GET } from '@/app/api/admin/sections/[id]/teachers/route'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const url = (id: string) => `http://localhost/api/admin/sections/${id}/teachers`

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_A1, scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' },
    { id: SEC_B1, scuola_id: SEDE_B, name: '2 ANNI', school_type: 'infanzia' },
  ],
  utenti: [
    { id: DOC_PRIMARIO, nome: 'Maestra', cognome: 'Alfa', ruolo: 'educator', role: 'educator', scuola_id: SEDE_A },
    { id: DOC_PONTE, nome: 'Maestra', cognome: 'Beta', ruolo: 'maestra', role: 'maestra', scuola_id: SEDE_B },
    { id: DOC_ESTRANEO, nome: 'Maestra', cognome: 'Gamma', ruolo: 'educator', role: 'educator', scuola_id: SEDE_B },
    { id: GENITORE_A, nome: 'Papà', cognome: 'Delta', ruolo: 'genitore', role: 'genitore', scuola_id: SEDE_A },
  ],
  // L'appartenenza vera del personale multi-plesso: il ponte.
  utenti_scuole: [{ utente_id: DOC_PONTE, scuola_id: SEDE_A }],
  utenti_sezioni: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  // Coordinator di SEDE_A: `scuoleDiUtente` vale esattamente [SEDE_A].
  h.requireStaff.mockResolvedValue({ user: { id: COORD_A, role: 'coordinator', scuola_id: SEDE_A } })
})

const idsDisponibili = async (sectionId: string) => {
  const res = await TEACHERS_GET(new NextRequest(url(sectionId)), ctx(sectionId))
  const j = (await res.json()) as { available?: { id: string }[] }
  return { stato: res.status, ids: (j.available ?? []).map((u) => u.id) }
}

describe('GET /api/admin/sections/[id]/teachers — il personale della sede viene dal ponte', () => {
  it('elenca anche chi è agganciato alla sede dal solo `utenti_scuole`', async () => {
    const { stato, ids } = await idsDisponibili(SEC_A1)

    expect(stato).toBe(200)
    // DOC_PONTE ha `utenti.scuola_id = SEDE_B`: con la vecchia
    // `.eq('scuola_id', section.scuola_id)` era invisibile, e quindi NON
    // assegnabile alla classe di SEDE_A in cui lavora davvero.
    expect(ids).toContain(DOC_PONTE)
    expect(ids).toContain(DOC_PRIMARIO)
    // Il ponte è stato letto davvero: è la differenza fra le due implementazioni.
    expect(h.tabelle).toContain('utenti_scuole')
  })

  it('non elenca il personale di un\'altra sede né i genitori', async () => {
    const { ids } = await idsDisponibili(SEC_A1)

    expect(ids).not.toContain(DOC_ESTRANEO)
    expect(ids).not.toContain(GENITORE_A)
  })

  it('sezione di un\'altra sede: 403, e il personale non viene nemmeno letto', async () => {
    const res = await TEACHERS_GET(new NextRequest(url(SEC_B1)), ctx(SEC_B1))

    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('utenti')
  })

  it('lettura del personale fallita: 500 esplicito, mai una tendina vuota', async () => {
    // PostgREST non lancia: prima l'errore veniva scartato e la risposta era un
    // 200 con `available: []` — «nessun insegnante» invece di «non lo so».
    h.errori = { utenti: { code: '42501', message: 'permission denied' } }

    const res = await TEACHERS_GET(new NextRequest(url(SEC_A1)), ctx(SEC_A1))

    expect(res.status).toBe(500)
  })
})
