import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
const h = vi.hoisted(() => ({ db: {} as DBFinto }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => creaFintoSupabase(h.db) }))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: async () => ({ user: { id: 'staff', role: 'segreteria', scuola_id: 'sede' } }) }))
vi.mock('@/lib/auth/scope', () => ({ assertSezioneInScope: async () => null }))
vi.mock('@/lib/primaria/obiettivi', () => ({ leggiObiettiviDisponibili: async () => ({ ok: true, righe: [] }) }))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
import { PATCH, DELETE } from '@/app/api/primaria/valutazioni/route'
const id = '11111111-1111-4111-8111-111111111111'
const alunno = '22222222-2222-4222-8222-222222222222'
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-10T10:00:00Z'))
  const base = { tipo: 'valutazione', entita_tipo: 'valutazione', entita_id: id, utente_id: 'genitore', push_inviata_il: null, giorno_competenza: null, politica_operazione: null, creato_il: '2026-09-09T21:55:00Z', invio_programmato_il: '2026-09-09T22:05:00Z' }
  h.db = {
    valutazioni: [{ id, storico_versione: 0, alunno_id: alunno, maestra_id: 'docente', section_id: 'classe', materia_id: 'materia', tipo: 'orale', modalita: 'sintetico', giudizio_sintetico: 'Buono', data_evento: '2026-09-09', creato_il: '2026-09-09T08:00:00Z', sections: { scuola_id: 'sede' } }],
    sections: [{ id: 'classe', scuola_id: 'sede' }], materie: [{ id: 'materia', nome: 'Materia fittizia', codice: 'materia', scuola_id: 'sede' }],
    legame_genitori_alunni: [{ alunno_id: alunno, genitore_id: 'genitore' }],
    notifiche: [
      { ...base, id: 'legacy-ieri' }, { ...base, id: 'metadata-ieri', giorno_competenza: '2026-09-09', creato_il: '2026-09-10T10:00:00Z' },
      { ...base, id: 'claim-ieri', push_inviata_il: '2026-09-10T09:00:00Z', push_presa_scade_il: '2026-09-10T09:10:00Z' },
      { ...base, id: 'finalizzata-ieri', push_inviata_il: '2026-09-10T09:00:00Z', push_presa_scade_il: null },
      { ...base, id: 'legacy-oggi', creato_il: '2026-09-10T08:00:00Z' },
      { ...base, id: 'metadata-oggi', giorno_competenza: '2026-09-10' },
      { ...base, id: 'politica-oggi', politica_operazione: { giornoCompetenza: '2026-09-10' } },
      { ...base, id: 'inviata', push_inviata_il: '2026-09-09T22:06:00Z' },
      { ...base, id: 'altro-destinatario', utente_id: 'altro-genitore' },
      { ...base, id: 'altra-entita', entita_id: 'altra' }, { ...base, id: 'altro-tipo', tipo: 'segreteria_scrittura' },
    ],
  }
})
afterEach(() => vi.useRealTimers())
describe('valutazioni — pending legacy e spostamento della competenza', () => {
  it.each(['PATCH', 'PATCH-data', 'DELETE'])('%s ritira soltanto la coda originale e i destinatari della fonte', async metodo => {
    const request = metodo === 'DELETE' ? new NextRequest(`http://test/api/primaria/valutazioni?id=${id}&versioneAttesa=0`, { method: 'DELETE' })
      : new NextRequest('http://test/api/primaria/valutazioni', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, versioneAttesa: 0, modalita: 'sintetico', giudizioSintetico: 'Ottimo', argomento: 'Argomento fittizio', ...(metodo === 'PATCH-data' ? { data: '2026-09-10' } : {}) }) })
    const response = await (metodo === 'DELETE' ? DELETE : PATCH)(request)
    expect(response.status).toBe(200)
    expect(h.db.notifiche.map(n => n.id)).toEqual(['finalizzata-ieri', 'legacy-oggi', 'metadata-oggi', 'politica-oggi', 'inviata', 'altro-destinatario', 'altra-entita', 'altro-tipo'])
  })
})
