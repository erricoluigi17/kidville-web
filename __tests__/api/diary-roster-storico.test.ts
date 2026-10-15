import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
const h = vi.hoisted(() => ({ db: {} as DBFinto, user: {} as AppUser, genitori: vi.fn(), risolvi: vi.fn(), errori: {} as Record<string, {code:string}> }))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: async () => ({ user: h.user }) }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => [SEDE] }))
vi.mock('@/lib/sezioni/risoluzione', () => ({ risolviSezione: h.risolvi }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getGenitoriDiAlunni: h.genitori, getGenitoriDiAlunno: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => creaFintoSupabase(h.db, [], { errori: h.errori }) }))
import { GET } from '@/app/api/diary/students/route'
import { GET as entries } from '@/app/api/diary/entries/route'
const SEDE = '11111111-1111-4111-8111-111111111111', CLASSE = '22222222-2222-4222-8222-222222222222'
const req = () => new NextRequest(`http://test/api/diary/students?sectionId=${CLASSE}&scuola_id=${SEDE}&date=2020-10-15&onlyPresent=false`)
beforeEach(() => {
  h.user = { id: 'staff', role: 'segreteria' }; h.errori = {}; h.genitori.mockReset().mockResolvedValue(new Map())
  h.risolvi.mockReset().mockResolvedValue({ sectionIds: [CLASSE] })
  h.db = { alunni: [
    { id: 'archiviato', nome: 'Archiviato', cognome: 'Fittizio', scuola_id: SEDE, section_id: null, anonimizzato_il: null },
    { id: 'trasferito', nome: 'Trasferito', cognome: 'Fittizio', scuola_id: 'altra-sede', section_id: 'nuova', note_mediche: 'SANITARI ALTRA SEDE', allergies: 'ALLERGIE ALTRA SEDE', anonimizzato_il: null },
    { id: 'oggi', nome: 'Oggi', cognome: 'Fittizio', scuola_id: SEDE, section_id: CLASSE, anonimizzato_il: null },
  ], alunni_classi_storico: [
    { id: 'a', alunno_id: 'archiviato', scuola_id: SEDE, section_id: CLASSE, dal: '2020-09-01', al: '2021-07-01' },
    { id: 'b', alunno_id: 'trasferito', scuola_id: SEDE, section_id: CLASSE, dal: '2020-09-01', al: '2021-07-01' },
    { id: 'c', alunno_id: 'oggi', scuola_id: SEDE, section_id: CLASSE, dal: '2025-09-01', al: null },
    { id: 'd', alunno_id: 'fuori', scuola_id: 'altra-sede', section_id: CLASSE, dal: '2020-09-01', al: null },
  ] }
})
describe('roster del diario storico', () => {
  it('apre roster ed eventi della classe storica anche se la classe corrente non esiste più', async () => {
    h.risolvi.mockResolvedValue({ response: NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 }) })
    h.db.eventi_diario = [{ id: 'evento', alunno_id: 'archiviato', tipo_evento: 'umore', orario_inizio: '2020-10-15T10:00:00Z' }]
    const roster = await GET(req())
    const eventi = await entries(req())
    expect(roster.status).toBe(200)
    expect(eventi.status).toBe(200)
    expect((await roster.json()).map((a: {id:string}) => a.id).sort()).toEqual(['archiviato', 'trasferito'])
    expect((await eventi.json()).map((a: {id:string}) => a.id)).toEqual(['evento'])
    expect(h.risolvi).not.toHaveBeenCalled()
  })
  it('recupera archiviati e trasferiti, escludendo gli attuali che non appartenevano alla classe', async () => {
    const r = await GET(req())
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.map((a: {id:string}) => a.id).sort()).toEqual(['archiviato', 'trasferito'])
    expect(JSON.stringify(body)).not.toContain('SANITARI ALTRA SEDE')
    expect(JSON.stringify(body)).not.toContain('ALLERGIE ALTRA SEDE')
    expect(h.genitori.mock.calls[0][1]).toEqual(['archiviato'])
  })
  it('il docente mantiene l’elenco e lo scope ordinari', async () => {
    h.user.role = 'educator'
    const body = await (await GET(req())).json()
    expect(body.map((a: {id:string}) => a.id)).toEqual(['oggi'])
  })
  it('senza schema storico restituisce 503 senza inventare la vecchia classe', async () => {
    h.errori = { alunni_classi_storico: { code: 'PGRST205' } }
    expect((await GET(req())).status).toBe(503)
    expect(h.genitori).not.toHaveBeenCalled()
  })
})
