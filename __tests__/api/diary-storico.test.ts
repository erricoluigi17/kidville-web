import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'

const h = vi.hoisted(() => ({ db: {} as DBFinto, opzioni: {} as OpzioniFinto, user: {} as AppUser, negato: false, parent: vi.fn(), staff: vi.fn(), riconcilia: vi.fn(), notificaReale: false }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => creaFintoSupabase(h.db, [], h.opzioni) }))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: async () => ({ user: h.user }) }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: async () => ({ user: h.user }) }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: async () => h.negato ? NextResponse.json({}, { status: 403 }) : null, resolveScuoleAttive: async () => h.negato ? [] : ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }))
vi.mock('@/lib/auth/sede-richiesta', () => ({ restringiASedeRichiesta: () => ({ plessi: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }) }))
vi.mock('@/lib/sezioni/risoluzione', () => ({ risolviSezione: async () => ({ sectionIds: ['classe'] }) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/primaria/notifiche', async originale => {
  const reale = await originale<typeof import('@/lib/primaria/notifiche')>()
  return { ...reale, enqueueDiarioGenitori: (...args: Parameters<typeof reale.enqueueDiarioGenitori>) => { h.parent(...args); return h.notificaReale ? reale.enqueueDiarioGenitori(...args) : undefined }, notificaTitolariScrittura: h.staff }
})
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: async () => ({}), leggiModuleConfig: async () => ({ ok: true, config: { routine_attive: ['umore', 'cambio'] } }) }))
vi.mock('@/lib/armadietto/richieste', () => ({ riconciliaRichieste: h.riconcilia }))
vi.mock('@/lib/logging/logger', async originale => ({ ...await originale<Record<string, unknown>>(), logEvento: vi.fn(), logErrore: vi.fn() }))

import { POST, DELETE, GET } from '@/app/api/diary/entries/route'

const ALUNNO = '11111111-1111-4111-8111-111111111111'
const richiesta = (metodo: string, giorno: string, tipo = 'umore') => new NextRequest(`http://test/api/diary/entries?sectionId=22222222-2222-4222-8222-222222222222&date=${giorno}&scuola_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&alunno_id=${ALUNNO}&tipo_evento=${tipo}&versioniAttese=${encodeURIComponent(JSON.stringify(Object.fromEntries((h.db.eventi_diario ?? []).filter(r => r.tipo_evento === tipo && String(r.orario_inizio).startsWith(giorno)).map(r => [r.id, r.storico_versione]))))}`, {
  method: metodo, ...(metodo === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ alunno_id: ALUNNO, versioneAttesa: (h.db.eventi_diario ?? []).find(r => r.tipo_evento === tipo && String(r.orario_inizio).startsWith(giorno))?.storico_versione ?? null, tipo_evento: tipo, dettagli: tipo === 'bagno' ? { pipi: 1 } : { umore: 'felice' }, orario_inizio: '2026-10-15T10:30:00Z', silenzioso: false }]) } : {}),
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T10:30:00Z'))
  h.user = { id: 'operatore', role: 'segreteria' }
  h.negato = false
  h.notificaReale = false
  h.opzioni = {}
  h.db = {
    alunni: [{ id: ALUNNO, nome: 'Bambino fittizio', section_id: 'classe', scuola_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', usa_pannolino: true }],
    alunni_classi_storico: [{ id: 'membership', alunno_id: ALUNNO, scuola_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', section_id: '22222222-2222-4222-8222-222222222222', dal: '2000-01-01', al: null }],
    eventi_diario: [
      { id: 'ieri', storico_versione: 0, alunno_id: ALUNNO, tipo_evento: 'umore', orario_inizio: '2026-10-14T09:00:00Z', dettagli: { umore: 'sereno' } },
      { id: 'oggi', storico_versione: 0, alunno_id: ALUNNO, tipo_evento: 'umore', orario_inizio: '2026-10-15T09:00:00Z', dettagli: { umore: 'sereno' } },
    ], armadietto: [], storici_revisioni: [],
  }
})
afterEach(() => vi.useRealTimers())
const eventi = () => h.db.eventi_diario as Record<string, unknown>[]

describe('diario amministrativo nella giornata di competenza', () => {
  it.each(['POST','DELETE'])('%s storico ritira realmente le pending legacy del giorno, lasciando oggi e gli altri genitori', async metodo => {
    h.notificaReale = true
    h.db.legame_genitori_alunni = [{ alunno_id: ALUNNO, genitore_id: 'genitore' }]
    const base = { utente_id: 'genitore', tipo: 'diario', entita_tipo: 'diario', entita_id: ALUNNO, push_inviata_il: null, giorno_competenza: null, politica_operazione: null, creato_il: '2026-10-14T21:55:00Z', invio_programmato_il: '2026-10-14T22:05:00Z' }
    h.db.notifiche = [
      { ...base, id: 'legacy-ieri' }, { ...base, id: 'legacy-oggi', creato_il: '2026-10-15T09:55:00Z' },
      { ...base, id: 'meta-oggi', giorno_competenza: '2026-10-15' },
      { ...base, id: 'altro-genitore', utente_id: 'altro' }, { ...base, id: 'inviata', push_inviata_il: '2026-10-14T22:06:00Z' },
    ]
    expect((await (metodo === 'POST' ? POST : DELETE)(richiesta(metodo, '2026-10-14'))).status).toBe(200)
    expect(h.db.notifiche.map(n => n.id)).toEqual(['legacy-oggi', 'meta-oggi', 'altro-genitore', 'inviata'])
  })
  it('aggiorna ieri lasciando oggi invariato e trasmette la policy calcolata sul server', async () => {
    expect((await POST(richiesta('POST', '2026-10-14'))).status).toBe(200)
    expect(eventi().find(e => e.id === 'ieri')?.dettagli).toEqual({ umore: 'felice' })
    expect(eventi().find(e => e.id === 'oggi')?.dettagli).toEqual({ umore: 'sereno' })
    expect(h.parent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operazione: { giornoCompetenza: '2026-10-14', giornoOperazioneRoma: '2026-10-15', sopprimiGenitori: true } }))
    expect(h.staff).toHaveBeenCalled()
    expect(h.db.storici_revisioni).toEqual([expect.objectContaining({ modulo: 'diario', contenuto: expect.objectContaining({ riga: expect.objectContaining({ id: 'ieri', dettagli: { umore: 'sereno' }, orario_inizio: '2026-10-14T09:00:00Z' }) }) })])
  })
  it('una nuova voce storica porta un timestamp della data selezionata anche se il client manda oggi', async () => {
    expect((await POST(richiesta('POST', '2026-03-29'))).status).toBe(200)
    expect(eventi().find(e => !['oggi', 'ieri'].includes(String(e.id)))?.orario_inizio).toBe('2026-03-29T10:30:00.000Z')
  })
  it('il consumo pannolini usa la giornata storica e conserva la policy per il cron', async () => {
    expect((await POST(richiesta('POST', '2026-10-14', 'bagno'))).status).toBe(200)
    expect(h.db.armadietto).toEqual([expect.objectContaining({ date: '2026-10-14', politica_operazione: expect.objectContaining({ sopprimiGenitori: true }) })])
    expect(h.riconcilia).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ materiale: 'Pannolini', operazione: expect.objectContaining({ giornoCompetenza: '2026-10-14' }) }))
    await POST(richiesta('POST', '2026-10-14', 'bagno'))
    expect(h.db.armadietto).toHaveLength(1)
  })
  it('la DELETE storica cancella ieri lasciando oggi invariato senza nuove notifiche parent', async () => {
    expect((await DELETE(richiesta('DELETE', '2026-10-14'))).status).toBe(200)
    expect(eventi().map(e => e.id)).toEqual(['oggi'])
    expect(h.parent).not.toHaveBeenCalled()
    expect(h.staff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sectionId: '22222222-2222-4222-8222-222222222222', scuolaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', area: 'diario' }))
    expect(h.db.storici_revisioni).toEqual([expect.objectContaining({ contenuto: expect.objectContaining({ riga: expect.objectContaining({ id: 'ieri', dettagli: { umore: 'sereno' } }) }) })])
  })
  it.each(['POST', 'DELETE'])('%s storico con archivio indisponibile preserva il diario originale', async metodo => {
    h.opzioni.errori = { 'storici_revisioni:insert': { code: 'PGRST205', message: 'archivio fittizio assente' } }
    const route = metodo === 'POST' ? POST : DELETE
    expect((await route(richiesta(metodo, '2026-10-14'))).status).toBe(503)
    expect(eventi().find(e => e.id === 'ieri')?.dettagli).toEqual({ umore: 'sereno' })
    expect(eventi()).toHaveLength(2)
    expect(h.parent).not.toHaveBeenCalled()
    expect(h.staff).not.toHaveBeenCalled()
  })
  it('la GET di classe include le ore vicine a mezzanotte Roma, non quelle UTC di un altro giorno', async () => {
    h.db.eventi_diario.push({ id: 'mezzanotte', alunno_id: ALUNNO, tipo_evento: 'umore', orario_inizio: '2026-10-14T22:30:00Z' })
    const req = new NextRequest('http://test/api/diary/entries?sectionId=22222222-2222-4222-8222-222222222222&date=2026-10-15')
    const res = await GET(req)
    expect((await res.json()).map((e: { id: string }) => e.id)).toEqual(['oggi', 'mezzanotte'])
  })
  it('il docente non acquisisce la compilazione passata con data o flag client', async () => {
    h.user = { id: 'docente', role: 'educator' }
    expect((await POST(richiesta('POST', '2026-10-14'))).status).toBe(423)
    expect(eventi()).toHaveLength(2)
    expect(h.parent).not.toHaveBeenCalled()
  })
  it('la scrittura odierna conserva notifiche e comportamento docente', async () => {
    h.user = { id: 'docente', role: 'educator' }
    expect((await POST(richiesta('POST', '2026-10-15'))).status).toBe(200)
    expect(h.parent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operazione: expect.objectContaining({ sopprimiGenitori: false }) }))
  })
  it('staff fuori scope non scrive e non cancella lo storico', async () => {
    h.negato = true
    expect((await POST(richiesta('POST', '2026-10-14'))).status).toBe(403)
    expect((await DELETE(richiesta('DELETE', '2026-10-14'))).status).toBe(403)
    expect(eventi()).toHaveLength(2)
  })
  it.each(['POST','DELETE'])('%s di un form superato non modifica né cancella il diario aggiornato', async metodo => {
    const r = richiesta(metodo,'2026-10-14')
    h.db.eventi_diario[0].storico_versione = 1
    h.db.eventi_diario[0].nota_bambino = 'Contenuto fittizio nuovo'
    expect((await (metodo==='POST'?POST:DELETE)(r)).status).toBe(409)
    expect(h.db.eventi_diario[0]).toMatchObject({ nota_bambino: 'Contenuto fittizio nuovo', dettagli: {umore:'sereno'} })
    expect(h.db.storici_revisioni).toHaveLength(0)
  })

})
