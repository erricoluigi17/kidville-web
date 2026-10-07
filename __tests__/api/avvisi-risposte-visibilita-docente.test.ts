import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// GET /api/avvisi/[id]/risposte — chi ha letto e chi ha risposto lo vede solo chi
// vede l'avviso in bacheca.
//
// Questa rotta restituisce i NOMI dei genitori e dei bambini che hanno letto o
// aderito. Fino al 2026-10-07 la consegnava a qualunque docente del plesso, per
// qualunque avviso: una maestra poteva leggere l'elenco delle famiglie di una
// classe non sua aprendo l'indirizzo dell'avviso. La bacheca ora le mostra solo
// gli avvisi che la riguardano, e questa strada dice la stessa cosa.
// =============================================================================

const DOCENTE = '11111111-1111-4111-8111-111111111111'
const SEGRETERIA = '33333333-3333-4333-8333-333333333333'
const AV_MIA_CLASSE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const AV_ALTRE_CLASSI = 'dddddddd-0000-4000-8000-00000000000d'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  scuoleDiUtente: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireUser: vi.fn(),
}))
vi.mock('@/lib/auth/scope', async (originale) => {
  const vero = await originale<typeof import('@/lib/auth/scope')>()
  return { ...vero, scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a) }
})
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: vi.fn() }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db) }
})

import { GET } from '@/app/api/avvisi/[id]/risposte/route'

const get = (id: string) =>
  GET(new NextRequest(`http://localhost/api/avvisi/${id}/risposte`), { params: Promise.resolve({ id }) })

const riga = (id: string, classi: string[]) => ({
  id,
  author_id: SEGRETERIA,
  target_scope: 'classe',
  target_classes: classi,
  scuola_id: SEDE_A,
})

const dbBase = (): DBFinto => ({
  avvisi: [riga(AV_MIA_CLASSE, ['Girasoli', 'Tulipani']), riga(AV_ALTRE_CLASSI, ['Tulipani', 'Papaveri'])],
  avvisi_risposte: [],
  utenti_sezioni: [
    { utente_id: DOCENTE, section_id: 'sec-gira', sections: { name: 'Girasoli', scuola_id: SEDE_A } },
  ],
  utenti: [],
  parents: [],
  alunni: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.logEvento.mockReset()
  h.scuoleDiUtente.mockResolvedValue([SEDE_A])
})

describe('GET /api/avvisi/[id]/risposte — la docente e gli avvisi altrui', () => {
  it('🔴 avviso di classi non sue ⇒ 403 AVVISO_FUORI_DALLE_TUE_CLASSI', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A } })
    const res = await get(AV_ALTRE_CLASSI)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('AVVISO_FUORI_DALLE_TUE_CLASSI')
  })

  it('CONTROLLO POSITIVO: avviso con una sua classe ⇒ 200', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A } })
    expect((await get(AV_MIA_CLASSE)).status).toBe(200)
  })

  it('CONTROLLO POSITIVO: la segreteria legge le risposte di ogni avviso della sede', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
    expect((await get(AV_ALTRE_CLASSI)).status).toBe(200)
  })
})
