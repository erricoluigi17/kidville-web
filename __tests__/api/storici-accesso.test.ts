import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

const h = vi.hoisted(() => ({ db: {} as DBFinto, user: {} as AppUser, sedi: [] as string[], download: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: async () => {
  const { haUnRuolo } = await import('@/lib/auth/predicati-ruolo')
  return haUnRuolo(h.user, ['admin', 'coordinator', 'segreteria']) ? { user: h.user } : { response: NextResponse.json({}, { status: 403 }) }
}, loadAppUser: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: async () => h.sedi }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => {
  const db = creaFintoSupabase(h.db)
  db.storage.from = (() => ({ download: h.download })) as unknown as typeof db.storage.from
  return db
} }))
vi.mock('@/lib/storici/adattatori/scolastici', () => ({ raccogliScolastico: vi.fn() }))
vi.mock('@/lib/storici/adattatori/servizi', () => ({ raccogliServizio: vi.fn() }))
vi.mock('@/lib/storici/render', () => ({ creaExcelStorico: vi.fn(), creaPdfStorico: vi.fn() }))
import { GET } from '@/app/api/admin/storici/generazioni/[id]/file/route'

const SEDE = '11111111-1111-4111-8111-111111111111'
const ALUNNO = '22222222-2222-4222-8222-222222222222'
const JOB = '33333333-3333-4333-8333-333333333333'
const req = () => new NextRequest(`http://test/api/admin/storici/generazioni/${JOB}/file`)
const esegui = () => GET(req(), { params: Promise.resolve({ id: JOB }) })
beforeEach(() => {
  h.user = { id: 'staff', role: 'segreteria' }
  h.sedi = [SEDE]
  h.download.mockReset().mockResolvedValue({ data: new Blob(['%PDF prova']), error: null })
  h.db = {
    schools: [{ id: SEDE, nome: 'Scuola fittizia' }],
    alunni: [{ id: ALUNNO, scuola_id: SEDE, nome: 'Alunno', cognome: 'Fittizio', anonimizzato_il: null }],
    alunni_classi_storico: [],
    storici_generazioni: [{ id: JOB, scuola_id: SEDE, richiesto_da: 'staff', ruolo_richiedente: 'segreteria', alunni_ids: [ALUNNO], scade_il: '2099-01-01T00:00:00Z', stato: 'completato', file_path: `${SEDE}/${JOB}/storico.pdf`, richiesta: { scuolaId: SEDE, alunnoId: ALUNNO, dal: '2025-09-01', al: '2025-09-30', categorie: ['diario_note'], formato: 'pdf', raggruppamento: 'alunno' } }],
  }
})
describe('download autenticato dello storico', () => {
  it('la veste genitore non revoca il ruolo reale staff, ma il file mantiene gli stessi ruoli autorizzati', async () => {
    h.user = { id: 'staff', role: 'genitore', ruoli: ['segreteria', 'genitore'] }
    h.db.storici_generazioni[0].ruolo_richiedente = 'segreteria'
    expect((await esegui()).status).toBe(200)
    expect(h.download).toHaveBeenCalledOnce()
  })
  it('una revoca reale invalida il file anche quando il ruolo attivo non cambia', async () => {
    h.user = { id: 'staff', role: 'coordinator', ruoli: ['coordinator'] }
    h.db.storici_generazioni[0].ruolo_richiedente = 'coordinator,segreteria'
    expect((await esegui()).status).toBe(403)
    expect(h.download).not.toHaveBeenCalled()
  })
  it('ricontrolla il perimetro e consegna il file senza cache pubblica', async () => {
    const r = await esegui()
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('private, no-store')
    expect(await r.text()).toBe('%PDF prova')
    expect(h.download).toHaveBeenCalledWith(`${SEDE}/${JOB}/storico.pdf`)
  })
  it.each(['owner', 'sede', 'ruolo', 'anonimizzato', 'scaduto', 'percorso'] as const)('nega il file se cambia %s prima del download', async caso => {
    const job = h.db.storici_generazioni[0]
    if (caso === 'owner') job.richiesto_da = 'altro'
    if (caso === 'sede') h.sedi = []
    if (caso === 'ruolo') h.user.role = 'coordinator'
    if (caso === 'anonimizzato') h.db.alunni[0].anonimizzato_il = '2026-10-15'
    if (caso === 'scaduto') job.scade_il = '2020-01-01T00:00:00Z'
    if (caso === 'percorso') job.file_path = `${SEDE}/altro/documento.pdf`
    expect((await esegui()).status).toBeGreaterThanOrEqual(400)
    expect(h.download).not.toHaveBeenCalled()
  })
  it('nega ai genitori anche un UUID valido', async () => {
    h.user.role = 'genitore'
    expect((await esegui()).status).toBe(403)
    expect(h.download).not.toHaveBeenCalled()
  })
})
