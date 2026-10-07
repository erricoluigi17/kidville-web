import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// /api/avvisi/[id] — l'avviso lo modifica o lo elimina SOLO chi l'ha scritto,
// oppure la segreteria e la direzione. E il dettaglio lo legge solo chi lo vede
// in bacheca.
//
// ── IL DIFETTO CHIUSO (2026-10-07) ──────────────────────────────────────────
//
// PUT e DELETE chiedevano soltanto `requireDocente` e la sede. Nessuno guardava
// CHI aveva scritto l'avviso: una docente poteva eliminare quello della segreteria
// (200), oppure «modificarlo» restringendolo alle sue classi — e le altre famiglie
// smettevano di vederlo senza che niente fosse rosso.
//
// La regola (titolare, 2026-10-07): un avviso della segreteria la docente lo
// LEGGE e basta; uno della collega idem. Si modifica solo il proprio.
//
// METODO. L'asserzione che conta è sulla MUTAZIONE, non sullo status: un 403 con
// l'UPDATE già partito sarebbe un falso verde. E ogni diniego ha accanto il suo
// CONTROLLO POSITIVO — un gate che nega a tutti passerebbe un file di soli 403.
//
// Il gate sul target delle classi (`verificaTargetAvvisoDocente`) è quello VERO:
// il body usa una classe che la docente HA, così l'unico motivo di un 403 è
// l'autore. È il caso che oggi passava.
// =============================================================================

const DOCENTE = '11111111-1111-4111-8111-111111111111'
const COLLEGA = '22222222-2222-4222-8222-222222222222'
const SEGRETERIA = '33333333-3333-4333-8333-333333333333'

const AV_SEGRETERIA = 'aaaaaaaa-0000-4000-8000-00000000000a'
const AV_COLLEGA = 'bbbbbbbb-0000-4000-8000-00000000000b'
const AV_MIO = 'cccccccc-0000-4000-8000-00000000000c'
const AV_ALTRE_CLASSI = 'dddddddd-0000-4000-8000-00000000000d'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertAvvisoInScope: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope-avvisi', () => ({
  assertAvvisoInScope: h.assertAvvisoInScope,
}))
vi.mock('@/lib/allegati/storage', () => ({
  firmaAllegatiAvvisi: async (_s: unknown, righe: unknown) => righe,
  normalizzaAllegatoAvviso: (v: unknown) => v ?? null,
}))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, [], { scritture: h.scritture as Scrittura[] }),
  }
})

import { GET, PUT, DELETE } from '@/app/api/avvisi/[id]/route'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const put = (id: string, body: unknown) =>
  PUT(
    new NextRequest(`http://localhost/api/avvisi/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx(id),
  )
const del = (id: string) =>
  DELETE(new NextRequest(`http://localhost/api/avvisi/${id}`, { method: 'DELETE' }), ctx(id))
const get = (id: string) =>
  GET(new NextRequest(`http://localhost/api/avvisi/${id}`), ctx(id))

const riga = (id: string, autore: string, classi: string[]) => ({
  id,
  author_id: autore,
  titolo: 'Uscita al parco',
  contenuto: 'Portare il cappellino.',
  tipo: 'presa_visione',
  target_scope: 'classe',
  target_classes: classi,
  scadenza: null,
  scadenza_avviso: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  scadenza_adesione: null,
  posti_totali: null,
  chiedi_numero: false,
  attachment_url: null,
  form_model_id: null,
  scuola_id: SEDE_A,
})

const dbBase = (): DBFinto => ({
  utenti: [
    { id: DOCENTE, ruolo: 'educator', role: 'educator', first_name: 'D', last_name: 'X', nome: null, cognome: null },
    { id: COLLEGA, ruolo: 'educator', role: 'educator', first_name: 'C', last_name: 'X', nome: null, cognome: null },
    { id: SEGRETERIA, ruolo: 'segreteria', role: 'segreteria', first_name: 'S', last_name: 'X', nome: null, cognome: null },
  ],
  sections: [
    { id: 'sec-gira', scuola_id: SEDE_A, name: 'Girasoli' },
    { id: 'sec-tuli', scuola_id: SEDE_A, name: 'Tulipani' },
  ],
  utenti_sezioni: [
    { utente_id: DOCENTE, section_id: 'sec-gira', sections: { name: 'Girasoli', scuola_id: SEDE_A } },
  ],
  avvisi: [
    // Della segreteria, e destinato ANCHE a una classe della docente.
    riga(AV_SEGRETERIA, SEGRETERIA, ['Girasoli', 'Tulipani']),
    riga(AV_COLLEGA, COLLEGA, ['Girasoli']),
    riga(AV_MIO, DOCENTE, ['Girasoli']),
    // Della segreteria, per classi che NON sono della docente.
    riga(AV_ALTRE_CLASSI, SEGRETERIA, ['Tulipani']),
  ],
  notifiche: [],
  audit_scritture_docente: [],
})

const corpo = {
  titolo: 'Uscita al parco (orario cambiato)',
  contenuto: 'Portare il cappellino.',
  tipo: 'presa_visione',
  target_scope: 'classe',
  target_classes: ['Girasoli'],
}

const scritture = (tabella: string, operazione: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)
const esitiWarn = () =>
  h.logEvento.mock.calls.filter((c) => c[1] === 'warn').map((c) => (c[2] as { esito?: string }).esito)

const comeDocente = () =>
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A } })
const comeSegreteria = () =>
  h.requireDocente.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.scritture = []
  h.logEvento.mockReset()
  h.assertAvvisoInScope.mockResolvedValue(null)
})

describe('PUT — la docente modifica solo i propri avvisi', () => {
  it('🔴 avviso della SEGRETERIA ⇒ 403 AVVISO_NON_AUTORE, e la riga non cambia', async () => {
    comeDocente()
    const res = await put(AV_SEGRETERIA, corpo)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('AVVISO_NON_AUTORE')
    expect(scritture('avvisi', 'update'), 'nessun UPDATE deve partire').toHaveLength(0)
    expect(h.db.avvisi.find((a) => a.id === AV_SEGRETERIA)?.target_classes).toEqual(['Girasoli', 'Tulipani'])
    expect(esitiWarn()).toContain('modifica-negata-non-autore')
  })

  it('avviso di una COLLEGA ⇒ 403, e la riga non cambia', async () => {
    comeDocente()
    const res = await put(AV_COLLEGA, corpo)
    expect(res.status).toBe(403)
    expect(scritture('avvisi', 'update')).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: il PROPRIO avviso ⇒ 200 e la riga cambia davvero', async () => {
    comeDocente()
    const res = await put(AV_MIO, corpo)
    expect(res.status).toBe(200)
    expect(scritture('avvisi', 'update')).toHaveLength(1)
    expect(h.db.avvisi.find((a) => a.id === AV_MIO)?.titolo).toBe(corpo.titolo)
  })

  it('CONTROLLO POSITIVO: la segreteria modifica l’avviso di una docente', async () => {
    comeSegreteria()
    const res = await put(AV_MIO, corpo)
    expect(res.status).toBe(200)
    expect(scritture('avvisi', 'update')).toHaveLength(1)
  })
})

describe('DELETE — la docente elimina solo i propri avvisi', () => {
  it('🔴 avviso della SEGRETERIA ⇒ 403, e l’avviso resta', async () => {
    comeDocente()
    const res = await del(AV_SEGRETERIA)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('AVVISO_NON_AUTORE')
    expect(scritture('avvisi', 'delete'), 'nessun DELETE deve partire').toHaveLength(0)
    expect(h.db.avvisi.some((a) => a.id === AV_SEGRETERIA)).toBe(true)
  })

  it('anche in veste di GENITORE la docente resta docente: 403', async () => {
    h.requireDocente.mockResolvedValue({
      user: { id: DOCENTE, role: 'genitore', ruoli: ['educator', 'genitore'], scuola_id: SEDE_A },
    })
    const res = await del(AV_SEGRETERIA)
    expect(res.status).toBe(403)
    expect(scritture('avvisi', 'delete')).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: il PROPRIO avviso si elimina', async () => {
    comeDocente()
    const res = await del(AV_MIO)
    expect(res.status).toBe(200)
    expect(h.db.avvisi.some((a) => a.id === AV_MIO)).toBe(false)
  })

  it('CONTROLLO POSITIVO: la segreteria elimina l’avviso di una docente', async () => {
    comeSegreteria()
    const res = await del(AV_COLLEGA)
    expect(res.status).toBe(200)
    expect(h.db.avvisi.some((a) => a.id === AV_COLLEGA)).toBe(false)
  })
})

describe('GET — il dettaglio lo legge solo chi lo vede in bacheca', () => {
  it('avviso di classi non sue ⇒ 403 AVVISO_FUORI_DALLE_TUE_CLASSI', async () => {
    comeDocente()
    const res = await get(AV_ALTRE_CLASSI)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('AVVISO_FUORI_DALLE_TUE_CLASSI')
  })

  it('CONTROLLO POSITIVO: un avviso con una sua classe si legge', async () => {
    comeDocente()
    expect((await get(AV_SEGRETERIA)).status).toBe(200)
  })

  it('CONTROLLO POSITIVO: la segreteria legge tutto', async () => {
    comeSegreteria()
    expect((await get(AV_ALTRE_CLASSI)).status).toBe(200)
  })
})
