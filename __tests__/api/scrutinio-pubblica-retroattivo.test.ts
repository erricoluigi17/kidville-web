import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
const h = vi.hoisted(() => ({ db: {} as DBFinto }))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: async () => ({ user: { id: 'direzione', role: 'admin' } }) }))
vi.mock('@/lib/auth/scope', () => ({ assertSezioneInScope: async () => null }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => creaFintoSupabase(h.db) }))
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: async () => true }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getGenitoriDiAlunni: async () => new Map([['alunno', ['genitore']]]) }))
vi.mock('@/lib/logging/logger', async originale => ({ ...await originale<Record<string, unknown>>(), logEvento: vi.fn(), logErrore: vi.fn() }))
import { POST } from '@/app/api/primaria/scrutinio/pubblica/route'
const ID = '11111111-1111-4111-8111-111111111111'
const req = () => new NextRequest('http://test/api/primaria/scrutinio/pubblica', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scrutinioId: ID, pubblicato: true }) })
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T10:00:00Z'))
  h.db = { scrutini: [{ id: ID, section_id: 'classe', periodo_id: 'periodo', stato: 'chiuso', pubblicato: false }], scrutinio_periodi: [{ id: 'periodo', data_fine: '2026-06-30' }], alunni: [{ id: 'alunno', section_id: 'classe', scuola_id: 'sede' }], notifiche: [] }
})
afterEach(() => vi.useRealTimers())

describe('pubblicazione scrutinio sulla competenza di fine periodo', () => {
  it('lo scrutinio passato diventa visibile senza notifiche ai genitori', async () => {
    expect((await POST(req())).status).toBe(200)
    expect(h.db.scrutini[0]?.pubblicato).toBe(true)
    expect(h.db.notifiche).toHaveLength(0)
  })
  it('il periodo che termina oggi mantiene la notifica con politica persistita', async () => {
    h.db.scrutinio_periodi[0]!.data_fine = '2026-10-15'
    expect((await POST(req())).status).toBe(200)
    expect(h.db.notifiche).toEqual([expect.objectContaining({ tipo: 'pagella', giorno_competenza: '2026-10-15', politica_operazione: expect.objectContaining({ sopprimiGenitori: false }) })])
  })
  it('fine periodo sconosciuta: pubblicazione riuscita, notifica esplicitamente saltata', async () => {
    h.db.scrutinio_periodi[0]!.data_fine = null
    const res = await POST(req())
    expect((await res.json()).notifica_saltata).toBe(true)
    expect(h.db.notifiche).toHaveLength(0)
  })
})
