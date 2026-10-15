import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

const MEDIA = '11000000-0000-4000-8000-000000000001'
const AUTORE = '22000000-0000-4000-8000-000000000002'
const STAFF = '33000000-0000-4000-8000-000000000003'
const h = vi.hoisted(() => ({ db: {} as DBFinto, scritture: [] as Scrittura[], rpc: vi.fn(), log: vi.fn(), cestinoConcorrente: false }))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: async () => ({ user: { id: STAFF, role: 'segreteria', scuola_id: SEDE_A } }) }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: async () => [SEDE_A] }))
vi.mock('@/lib/gallery/privacy', () => ({ alunniSenzaConsenso: async () => [] }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.log, logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => {
    const client = creaFintoSupabase(h.db, [], { scritture: h.scritture, rpc: { notifiche_galleria_ritira: h.rpc } })
    const from = client.from.bind(client)
    client.from = ((tabella: string) => {
      const query = from(tabella)
      if (tabella === 'galleria_media_v2') {
        const update = query.update.bind(query)
        query.update = ((valori: Record<string, unknown>) => {
          if (h.cestinoConcorrente) {
            h.cestinoConcorrente = false
            // L'altra richiesta vince dopo la lettura autorizzata e prima del CAS.
            h.db.galleria_media_v2[0].eliminato_il = '2026-01-13T10:00:00Z'
          }
          return update(valori)
        }) as typeof query.update
      }
      return query
    }) as typeof client.from
    return client
  } }
})

import { PATCH, DELETE } from '@/app/api/gallery/route'

beforeEach(() => {
  vi.clearAllMocks()
  h.scritture = []
  h.cestinoConcorrente = false
  h.db = {
    galleria_media_v2: [{ id: MEDIA, uploaded_by: AUTORE, scuola_id: SEDE_A, tag_students: [], target_classes: [], is_broadcast: false, eliminato_il: null, giorno_competenza: '2026-01-12', politica_operazione: { giornoCompetenza: '2026-01-12', giornoOperazioneRoma: '2026-01-12', sopprimiGenitori: false }, created_at: '2026-01-12T10:00:00Z' }],
    utenti: [{ id: STAFF, ruolo: 'segreteria', scuola_id: SEDE_A }],
    notifiche: [{ id: 'legacy', tipo: 'galleria', entita_id: AUTORE, utente_id: 'genitore', giorno_competenza: null, politica_operazione: null, creato_il: '2026-01-12T22:55:00Z', invio_programmato_il: '2026-01-12T23:05:00Z', push_inviata_il: null }],
    audit_scritture_docente: [],
  }
  h.rpc.mockImplementation(() => ({ data: 1, error: null }))
})

describe('galleria PATCH/DELETE storico — prima blocca i replay, poi ritira la sola origine', () => {
  it('PATCH persiste il silenzio nella sorgente prima della RPC e usa il giorno originale', async () => {
    h.rpc.mockImplementation(() => {
      expect(h.db.galleria_media_v2[0].politica_operazione).toMatchObject({ sopprimiGenitori: true, giornoOriginale: '2026-01-12' })
      return { data: 1, error: null }
    })
    const res = await PATCH(new Request('http://localhost/api/gallery', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: MEDIA, caption: 'Corretta' }) }))
    expect(res.status).toBe(200)
    expect(h.db.galleria_media_v2[0].caption).toBe('Corretta')
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({ p_scuola_id: SEDE_A, p_uploaded_by: AUTORE, p_media_id: MEDIA, p_giorno: '2026-01-12' })
    expect(h.db.notifiche.map(n => n.id)).toEqual(['legacy'])
    expect(h.scritture.filter(s => s.tabella === 'notifiche')).toHaveLength(0)
  })

  it('DELETE cestina prima della RPC e conserva i batch legacy privi di prova della provenienza', async () => {
    h.rpc.mockImplementation(() => {
      expect(h.db.galleria_media_v2[0].eliminato_il).toEqual(expect.any(String))
      return { data: 1, error: null }
    })
    const res = await DELETE(new Request(`http://localhost/api/gallery?id=${MEDIA}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({ p_scuola_id: SEDE_A, p_uploaded_by: AUTORE, p_media_id: MEDIA, p_giorno: '2026-01-12' })
    expect(h.db.notifiche.map(n => n.id)).toEqual(['legacy'])
    expect(h.db.galleria_media_v2).toHaveLength(1)
    expect(h.scritture.filter(s => s.tabella === 'galleria_media_v2' && s.operazione === 'delete')).toHaveLength(0)
  })

  it('retry DELETE recupera il ritiro fallito senza ripetere cestino o audit', async () => {
    h.db.notifiche.push({ id: 'moderna', tipo: 'galleria', entita_id: AUTORE, utente_id: 'genitore', giorno_competenza: '2026-01-12', politica_operazione: { giornoCompetenza: '2026-01-12', giornoOperazioneRoma: '2026-01-12', sopprimiGenitori: false, galleria: { scuolaId: SEDE_A, mediaIds: [MEDIA] } }, creato_il: '2026-01-12T10:00:00Z', invio_programmato_il: '2026-01-12T10:30:00Z', push_inviata_il: null })
    h.rpc.mockImplementationOnce(() => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }))
      .mockImplementation(() => {
        h.db.notifiche = h.db.notifiche.filter(n => n.id !== 'moderna')
        return { data: 1, error: null }
      })
    const richiesta = () => new Request(`http://localhost/api/gallery?id=${MEDIA}`, { method: 'DELETE' })
    expect((await DELETE(richiesta())).status).toBe(200)
    const cestinatoIl = h.db.galleria_media_v2[0].eliminato_il
    expect(cestinatoIl).toEqual(expect.any(String))
    expect(h.db.notifiche.map(n => n.id)).toContain('moderna')
    expect(h.log).toHaveBeenCalledWith('notifica', 'error', expect.objectContaining({ esito: 'galleria-ritiro-origine-fallito' }), expect.objectContaining({ code: '57014' }))
    const seconda = await DELETE(richiesta())
    expect(seconda.status).toBe(200)
    expect(await seconda.json()).toMatchObject({ esito: 'gia-eliminato' })
    expect(h.rpc).toHaveBeenCalledTimes(2)
    expect(h.rpc).toHaveBeenLastCalledWith({ p_scuola_id: SEDE_A, p_uploaded_by: AUTORE, p_media_id: MEDIA, p_giorno: '2026-01-12' })
    expect(h.db.notifiche.map(n => n.id)).toEqual(['legacy'])
    expect(h.db.galleria_media_v2[0].eliminato_il).toBe(cestinatoIl)
    expect(h.scritture.filter(s => s.tabella === 'galleria_media_v2')).toHaveLength(1)
    expect(h.db.audit_scritture_docente).toHaveLength(1)
  })

  it('cestino vinto da una richiesta concorrente: ritenta il ritiro della sola origine senza duplicare audit', async () => {
    h.cestinoConcorrente = true
    const res = await DELETE(new Request(`http://localhost/api/gallery?id=${MEDIA}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ esito: 'gia-eliminato' })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({ p_scuola_id: SEDE_A, p_uploaded_by: AUTORE, p_media_id: MEDIA, p_giorno: '2026-01-12' })
    expect(h.db.galleria_media_v2[0].eliminato_il).toBe('2026-01-13T10:00:00Z')
    expect(h.scritture.filter(s => s.tabella === 'galleria_media_v2').map(s => s.colpite)).toEqual([[]])
    expect(h.db.audit_scritture_docente).toHaveLength(0)
    expect(h.db.notifiche.map(n => n.id)).toEqual(['legacy'])
  })
})
