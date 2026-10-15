import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
const h = vi.hoisted(() => ({ db: {} as DBFinto, user: {} as AppUser }))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: async () => ({ user: h.user }) }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: async () => null }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => creaFintoSupabase(h.db) }))
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: async () => true }))
vi.mock('@/lib/notifiche/destinatari', () => ({ genitoriDiAlunni: async () => ['genitore'] }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/logging/logger', async originale => ({ ...await originale<Record<string, unknown>>(), logEvento: vi.fn(), logErrore: vi.fn() }))
import { POST, DELETE } from '@/app/api/attendance/daily/route'
const ALUNNO = '11111111-1111-4111-8111-111111111111'
const req = (metodo: string, giorno = '2026-10-14', stato = 'assente') => new NextRequest(`http://test/api/attendance/daily?alunno_id=${ALUNNO}&data=${giorno}&versioneAttesa=0`, { method: metodo, ...(metodo === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alunno_id: ALUNNO, versioneAttesa: 0, data: giorno, stato, orario_entrata: stato === 'assente' ? null : '2026-10-15T08:00:00Z' }) } : {}) })
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T10:00:00Z'))
  h.user = { id: 'staff', role: 'segreteria' }
  h.db = { alunni: [{ id: ALUNNO, nome: 'Fittizio', section_id: 'classe', scuola_id: 'sede' }], presenze: [{ id: 'presenza', storico_versione: 0, alunno_id: ALUNNO, scuola_id: 'sede', section_id: 'classe', data: '2026-10-14', stato: 'presente', registrato_da: 'docente', giustificata_da: null }], notifiche: [{ id: 'oggi', utente_id: 'genitore', tipo: 'assenza_non_comunicata', entita_id: ALUNNO, giorno_competenza: '2026-10-15', push_inviata_il: null }] }
})
afterEach(() => vi.useRealTimers())

describe('appello storico staff: timestamp e notifiche della giornata giusta', () => {
  it('assenza storica non crea campanella o push e non tocca la pending di oggi', async () => {
    expect((await POST(req('POST'))).status).toBe(200)
    expect(h.db.presenze[0]?.stato).toBe('assente')
    expect(h.db.notifiche.map(n => n.id)).toEqual(['oggi'])
  })
  it('correggere ieri assente→presente ritira solo l’avviso di ieri e data l’ingresso su ieri', async () => {
    h.db.presenze[0]!.stato = 'assente'
    h.db.notifiche.push({ id: 'ieri', utente_id: 'genitore', tipo: 'assenza_non_comunicata', entita_id: ALUNNO, giorno_competenza: '2026-10-14', push_inviata_il: null })
    expect((await POST(req('POST', '2026-10-14', 'presente'))).status).toBe(200)
    expect(h.db.notifiche.map(n => n.id)).toEqual(['oggi'])
    expect(h.db.presenze[0]?.orario_entrata).toBe('2026-10-14T08:00:00.000Z')
  })
  it('annullare presenza storica è consentito allo staff e conserva gli avvisi odierni', async () => {
    expect((await DELETE(req('DELETE'))).status).toBe(200)
    expect(h.db.presenze).toHaveLength(0)
    expect(h.db.notifiche.map(n => n.id)).toEqual(['oggi'])
  })
  it('annullare presenza storica resta vietato al docente', async () => {
    h.user.role = 'educator'
    expect((await DELETE(req('DELETE'))).status).toBe(409)
    expect(h.db.presenze).toHaveLength(1)
  })
  it('un form letto prima della modifica altrui viene rifiutato senza perdere firma o presenza', async () => {
    const richiesta = req('POST')
    h.db.presenze[0].storico_versione = 1
    h.db.presenze[0].giustificazione_firma = { fittizia: 'firma nuova' }
    expect((await POST(richiesta)).status).toBe(409)
    expect(h.db.presenze[0]).toMatchObject({ stato: 'presente', giustificazione_firma: { fittizia: 'firma nuova' } })
    expect(h.db.storici_revisioni ?? []).toHaveLength(0)
  })
  it('un vecchio client senza versione deve ricaricare, uno schema senza token è503', async () => {
    const r = new NextRequest('http://test/api/attendance/daily', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alunno_id: ALUNNO, data: '2026-10-14', stato: 'assente' }) })
    expect((await POST(r)).status).toBe(409)
    delete h.db.presenze[0].storico_versione
    expect((await POST(req('POST'))).status).toBe(503)
    expect(h.db.presenze[0].stato).toBe('presente')
  })

})
