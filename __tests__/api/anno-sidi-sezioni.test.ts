import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto, ErrorePostgrest, Riga } from '../fixtures/finto-supabase'

// =============================================================================
// Compito 4.3.7 · SIDI (struttura e frequentanti) dichiara le sezioni dell'anno ATTIVO.
//
// Fase A e frequentanti vanno al Ministero: una classe del 2027/28, creata in anticipo dalla segreteria, non deve
// comparire in una dichiarazione che riguarda l'anno in corso. Il finto client APPLICA i filtri (compreso
// `.or('and(scuola_id.eq.X,anno_id.eq.Y)')`), e si guarda il flusso trasmesso. Con lo schema dell'anno indietro
// (la CI) nessun filtro e nessun errore.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const A2 = 'a2222222-2222-4222-8222-222222222222' // 2026/27, attivo
const A3 = 'a3333333-3333-4333-8333-333333333333' // 2027/28, in preparazione
const S2 = 'b2222222-2222-4222-8222-aaaaaaaaaaaa'
const S3 = 'b3333333-3333-4333-8333-aaaaaaaaaaaa'
const SEZ_ATTIVA = '5ec00000-0000-4000-8000-00000000000a'
const SEZ_FUTURA = '5ec00000-0000-4000-8000-00000000000f'
const AL_1 = 'a1000000-0000-4000-8000-000000000001'
const AL_2 = 'a1000000-0000-4000-8000-000000000002'
const NOME_ATTIVA = 'CLASSE OGGI'
const NOME_FUTURA = 'CLASSE DOMANI'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, ErrorePostgrest>,
  trasmissioni: [] as { flusso: string; xml: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db as DBFinto, [], {
        errori: h.errori,
        rpc: { anno_attivo: () => ({ data: S2, error: null }) },
      }),
  }
})
vi.mock('@/lib/sidi/client', () => ({
  sidiTransmit: async (_config: unknown, flusso: string, xml: string) => {
    h.trasmissioni.push({ flusso, xml })
    return { ok: true, ricevuta: 'RIC-1' }
  },
}))

import { POST as FASE_A } from '@/app/api/admin/sidi/fase-a/route'
import { POST as FREQUENTANTI } from '@/app/api/admin/sidi/frequentanti/route'

const dbBase = (): Record<string, Riga[]> => ({
  utenti_scuole: [{ utente_id: ID_ADMIN, scuola_id: SEDE_A }],
  schools: [{ id: SEDE_A, nome: 'Sede A' }],
  anni_sede: [
    { id: S2, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
    { id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: false },
  ],
  sections: [
    { id: SEZ_ATTIVA, name: NOME_ATTIVA, school_type: 'infanzia', scuola_id: SEDE_A, anno_id: A2 },
    { id: SEZ_FUTURA, name: NOME_FUTURA, school_type: 'infanzia', scuola_id: SEDE_A, anno_id: A3 },
  ],
  alunni: [
    { id: AL_1, scuola_id: SEDE_A, section_id: SEZ_ATTIVA, codice_fiscale: 'AAAAAA10A01H501A', nome: 'Anna', cognome: 'Alfa', stato: 'iscritto' },
    { id: AL_2, scuola_id: SEDE_A, section_id: SEZ_FUTURA, codice_fiscale: 'BBBBBB10B02H501B', nome: 'Bruno', cognome: 'Beta', stato: 'iscritto' },
  ],
  tempo_scuola: [],
  admin_settings: [{ scuola_id: SEDE_A, sidi_config: { abilitato: true } }],
  sidi_sync_state: [{
    scuola_id: SEDE_A, fase_a_stato: 'inviato', frequentanti_stato: 'non_inviato', piattaforma_unica_stato: 'non_inviato',
  }],
})

function req(metodo: string): NextRequest {
  return {
    url: 'http://localhost/api/admin/sidi/x',
    method: metodo,
    headers: new Headers({ 'content-type': 'application/json' }),
    cookies: { get: () => undefined },
  } as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.errori = {}
  h.trasmissioni = []
  h.requireStaff.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('POST /api/admin/sidi/fase-a · la struttura è quella dell\'anno attivo', () => {
  it('nel flusso c\'è la classe dell\'anno attivo e NON quella del 2027/28', async () => {
    const res = await FASE_A(req('POST'))
    expect(res.status).toBe(200)
    expect(h.trasmissioni).toHaveLength(1)
    expect(h.trasmissioni[0].xml).toContain(NOME_ATTIVA)
    expect(h.trasmissioni[0].xml).not.toContain(NOME_FUTURA)
  })

  it('con lo schema dell\'anno indietro (anni_sede assente): nessun filtro e nessun errore', async () => {
    h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
    h.db.sections = h.db.sections.map((s) => {
      const copia = { ...s }
      delete copia.anno_id
      return copia
    })
    const res = await FASE_A(req('POST'))
    expect(res.status).toBe(200)
    expect(h.trasmissioni[0].xml).toContain(NOME_ATTIVA)
    expect(h.trasmissioni[0].xml).toContain(NOME_FUTURA)
  })
})

describe('POST /api/admin/sidi/frequentanti · i frequentanti sono quelli dell\'anno attivo', () => {
  it('nel flusso c\'è la classe dell\'anno attivo e NON quella del 2027/28', async () => {
    const res = await FREQUENTANTI(req('POST'))
    expect(res.status).toBe(200)
    expect(h.trasmissioni).toHaveLength(1)
    expect(h.trasmissioni[0].xml).toContain(NOME_ATTIVA)
    expect(h.trasmissioni[0].xml).not.toContain(NOME_FUTURA)
  })

  it('con lo schema dell\'anno indietro: nessun filtro e nessun errore', async () => {
    h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
    h.db.sections = h.db.sections.map((s) => {
      const copia = { ...s }
      delete copia.anno_id
      return copia
    })
    const res = await FREQUENTANTI(req('POST'))
    expect(res.status).toBe(200)
    expect(h.trasmissioni[0].xml).toContain(NOME_ATTIVA)
  })
})
