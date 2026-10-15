import { beforeEach, describe, it, expect, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { rettificaStoricaFinta } from '../fixtures/storici-rpc'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

const h = vi.hoisted(() => ({ db: {} as DBFinto, opzioni: {} as OpzioniFinto, user: {} as AppUser, fuoriScope: false, dopoArchivio: null as (() => void) | null }))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: async () => ['admin', 'coordinator', 'segreteria'].includes(h.user.role) ? { user: h.user } : { response: NextResponse.json({}, { status: 403 }) } }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: async () => h.fuoriScope ? [] : ['sede'], restringiSedi: (sedi: string[], scuola: string) => sedi.includes(scuola) ? [scuola] : null }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => creaFintoSupabase(h.db, [], { ...h.opzioni, rpc: { storici_applica_rettifica: args => { if (h.dopoArchivio) { h.dopoArchivio(); h.db.presenze[0].storico_versione = 1 } return rettificaStoricaFinta(h.db, args, h.opzioni) } } }) }))
vi.mock('@/lib/storici/revisioni', async originale => {
  const vero = await originale<typeof import('@/lib/storici/revisioni')>()
  return { conservaRevisione: async (...args: Parameters<typeof vero.conservaRevisione>) => { await vero.conservaRevisione(...args); h.dopoArchivio?.() } }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn() }))
vi.mock('@/lib/logging/logger', async originale => ({ ...await originale<Record<string, unknown>>(), logEvento: vi.fn() }))
import { DELETE } from '@/app/api/attendance/justification/route'
const ID = '11111111-1111-4111-8111-111111111111'
const FIRMA = '2026-09-10T08:30:00.123456+00:00'
const req = (firmaIl: string | null = FIRMA) => new NextRequest('http://test/api/attendance/justification', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presenzaId: ID, firmaIl, versioneAttesa: 0 }) })
const riga = () => h.db.presenze[0]!
beforeEach(() => {
  h.user = { id: 'staff', role: 'segreteria' }
  h.fuoriScope = false
  h.opzioni = {}
  h.dopoArchivio = null
  h.db = { presenze: [{ id: ID, storico_versione: 0, alunno_id: 'alunno', section_id: 'classe', scuola_id: 'sede', data: '2020-04-02', stato: 'assente', registrato_da: 'docente', giustificata: true, giustificata_il: FIRMA, giustificata_da: 'genitore', giustificazione_testo: 'Motivo fittizio', giustificazione_firma: { prova: 'firma fittizia' }, giust_vista_il: FIRMA, giust_vista_da: 'docente' }], storici_revisioni: [] }
})

describe('annullamento amministrativo della giustifica firmata', () => {
  it.each(['admin', 'coordinator', 'segreteria'] as const)('%s revoca anche una giustifica storica conservando testo e firma originali', async role => {
    h.user.role = role
    expect((await DELETE(req())).status).toBe(200)
    expect(riga()).toMatchObject({ stato: 'assente', registrato_da: 'docente', giustificata: false, giustificazione_firma: null, giustificazione_testo: null, giust_vista_il: null })
    expect(h.db.storici_revisioni).toEqual([expect.objectContaining({ modulo: 'giustifiche-presenza', giorno_competenza: '2020-04-02', contenuto: expect.objectContaining({ riga: expect.objectContaining({ giustificata: true, giustificazione_firma: { prova: 'firma fittizia' }, giustificazione_testo: 'Motivo fittizio' }) }) })])
  })
  it('il docente conserva i permessi precedenti', async () => {
    h.user.role = 'educator'
    expect((await DELETE(req())).status).toBe(403)
    expect(riga().giustificata).toBe(true)
  })
  it('staff fuori sede non modifica né archivia il contenuto', async () => {
    h.fuoriScope = true
    expect((await DELETE(req())).status).toBe(403)
    expect(riga().giustificata).toBe(true)
    expect(h.db.storici_revisioni).toHaveLength(0)
  })
  it('schema archivio non disponibile: nessuna perdita della firma', async () => {
    h.opzioni.errori = { 'storici_revisioni:insert': { code: 'PGRST205', message: 'schema non disponibile' } }
    expect((await DELETE(req())).status).toBe(503)
    expect(riga()).toMatchObject({ giustificata: true, giustificazione_testo: 'Motivo fittizio', giustificazione_firma: { prova: 'firma fittizia' } })
  })
  it('non annulla una firma nuova che differisce anche solo per microsecondi', async () => {
    expect((await DELETE(req('2026-09-10T08:30:00.123457+00:00'))).status).toBe(409)
    expect(riga().giustificata).toBe(true)
    expect(h.db.storici_revisioni).toHaveLength(0)
  })
  it('sede cambiata durante la conservazione: non modifica il dato fuori dal perimetro autorizzato', async () => {
    h.dopoArchivio = () => { riga().scuola_id = 'altra-sede' }
    expect((await DELETE(req())).status).toBe(409)
    expect(riga()).toMatchObject({ scuola_id: 'altra-sede', giustificata: true, giustificazione_firma: { prova: 'firma fittizia' } })
  })
  it('firma cambiata durante la conservazione: compare-and-set lascia la firma nuova intatta', async () => {
    h.dopoArchivio = () => { riga().giustificata_il = '2026-09-11T08:30:00Z' }
    expect((await DELETE(req())).status).toBe(409)
    expect(riga()).toMatchObject({ giustificata: true, giustificata_il: '2026-09-11T08:30:00Z' })
  })
})
