import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto, type Scrittura } from '../fixtures/finto-supabase'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
const h = vi.hoisted(() => ({ db: {} as DBFinto, user: {} as AppUser, opzioni: {} as OpzioniFinto, scritture: [] as Scrittura[], fuoriScope: false, tracciato: true, dopoArchivio: null as (() => void) | null }))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: async () => ['admin', 'coordinator', 'segreteria'].includes(h.user.role) ? { user: h.user } : { response: NextResponse.json({}, { status: 403 }) } }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: async () => h.fuoriScope ? NextResponse.json({}, { status: 403 }) : null }))
vi.mock('@/lib/chat/vigilanza-audit', () => ({ registraAccessoVigilanza: async () => ({ tracciato: h.tracciato }) }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => creaFintoSupabase(h.db, [], { ...h.opzioni, scritture: h.scritture }) }))
vi.mock('@/lib/storici/revisioni', async originale => {
  const vero = await originale<typeof import('@/lib/storici/revisioni')>()
  return { conservaRevisione: async (...args: Parameters<typeof vero.conservaRevisione>) => { await vero.conservaRevisione(...args); h.dopoArchivio?.() } }
})
import { PATCH } from '@/app/api/admin/chat/rettifica/route'
const ID = '11111111-1111-4111-8111-111111111111'
const req = () => new NextRequest('http://test/api/admin/chat/rettifica', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ID, testo: 'Rettifica fittizia', versione: 0 }) })
beforeEach(() => {
  h.user = { id: 'staff', role: 'segreteria' }; h.opzioni = {}; h.scritture = []; h.fuoriScope = false; h.tracciato = true; h.dopoArchivio = null
  h.db = { chat_threads: [{ id: 'thread', student_id: 'alunno' }], alunni: [{ id: 'alunno', scuola_id: 'sede', section_id: 'classe' }], chat_messages: [{ id: ID, thread_id: 'thread', sender_id: 'genitore', content: 'Dichiarazione originale della famiglia', created_at: '2020-05-01T09:00:00Z', rettifica_staff: null, rettifica_versione: 0 }], storici_revisioni: [], notifiche: [] }
})
describe('rettifiche staff delle conversazioni', () => {
  it('conserva la dichiarazione originale e aggiunge una registrazione distinta e silenziosa', async () => {
    expect((await PATCH(req())).status).toBe(200)
    expect(h.db.chat_messages[0]).toMatchObject({ sender_id: 'genitore', content: 'Dichiarazione originale della famiglia', created_at: '2020-05-01T09:00:00Z', rettifica_staff: 'Rettifica fittizia', rettifica_versione: 1 })
    expect(h.db.storici_revisioni[0]).toMatchObject({ modulo: 'chat', giorno_competenza: '2020-05-01', contenuto: expect.objectContaining({ content: 'Dichiarazione originale della famiglia' }) })
    expect(h.scritture.map(r => r.tabella)).toEqual(['storici_revisioni', 'chat_messages'])
    expect(h.db.notifiche).toHaveLength(0)
  })
  it.each(['ruolo', 'sede', 'vigilanza'] as const)('nega la rettifica senza %s autorizzata', async caso => {
    if (caso === 'ruolo') h.user.role = 'educator'
    if (caso === 'sede') h.fuoriScope = true
    if (caso === 'vigilanza') h.tracciato = false
    expect((await PATCH(req())).status).toBeGreaterThanOrEqual(400)
    expect(h.scritture).toHaveLength(0)
  })
  it('non sovrascrive una correzione concorrente intervenuta durante la conservazione', async () => {
    h.dopoArchivio = () => { h.db.chat_messages[0].rettifica_versione = 1; h.db.chat_messages[0].rettifica_staff = 'Altra rettifica' }
    expect((await PATCH(req())).status).toBe(409)
    expect(h.db.chat_messages[0].rettifica_staff).toBe('Altra rettifica')
  })
  it('non modifica il messaggio se non riesce a conservare la versione originale', async () => {
    h.opzioni.errori = { 'storici_revisioni:insert': { code: 'PGRST205' } }
    expect((await PATCH(req())).status).toBe(503)
    expect(h.db.chat_messages[0].rettifica_versione).toBe(0)
  })
})
