import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'

// La sede dichiarata nel body è la STESSA che lo scope restituisce: dal 31/07 la
// route la valida (`sedeDichiarataFuoriScope`) invece di ripiegare in silenzio su
// un'altra, quindi un uuid scollegato dal mock darebbe 403 e questi casi — che
// parlano di shallow-merge JSONB, non di sedi — fallirebbero per il motivo sbagliato.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  upserted: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', async () => {
  const { SEDE_A: SEDE } = await import('../fixtures/sedi')
  return {
    resolveScuolaScrittura: async () => ({ scuolaId: SEDE }),
    resolveScuoleAttive: async () => [SEDE],
  }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: h.existing, error: null })
      b.upsert = (row: Record<string, unknown>) => {
        h.upserted = row
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) }
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/settings/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

describe('PATCH /api/admin/settings — fiscale_config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.upserted = null
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  })

  it('accetta fiscale_config e lo salva in shallow-merge con l\'esistente', async () => {
    h.existing = { fiscale_config: { denominazione: 'Kidville Giugliano' } }
    const res = await PATCH(req({ scuola_id: SEDE_A, fiscale_config: { piva: '01234567890' } }))
    expect(res.status).toBe(200)
    expect(h.upserted?.fiscale_config).toEqual({ denominazione: 'Kidville Giugliano', piva: '01234567890' })
  })

  it('accetta solleciti_config e lo salva in shallow-merge con l\'esistente', async () => {
    h.existing = { solleciti_config: { enabled: false } }
    const res = await PATCH(req({ scuola_id: SEDE_A, solleciti_config: { cadenza_min_giorni: 10 } }))
    expect(res.status).toBe(200)
    expect(h.upserted?.solleciti_config).toEqual({ enabled: false, cadenza_min_giorni: 10 })
  })

  it('accetta causali_config e lo salva in shallow-merge, preservando le altre chiavi/categorie', async () => {
    // JSONB flat per-slug: { default, <slug> }. Salvare una categoria NON deve
    // sovrascrivere il predefinito né le altre categorie già impostate.
    h.existing = { causali_config: { default: '{descrizione} - {sede}', gita: 'Quota {descrizione}' } }
    const res = await PATCH(req({
      scuola_id: SEDE_A,
      causali_config: { mensa: 'Mensa {mese} {anno}' },
    }))
    expect(res.status).toBe(200)
    expect(h.upserted?.causali_config).toEqual({
      default: '{descrizione} - {sede}',
      gita: 'Quota {descrizione}',
      mensa: 'Mensa {mese} {anno}',
    })
  })

  it('causali_config: una stringa VUOTA rimuove la chiave (reset al predefinito) e i valori non-stringa sono scartati', async () => {
    h.existing = { causali_config: { default: '{descrizione} - {sede}', retta: 'Retta {mese}', mensa: 'Mensa' } }
    const res = await PATCH(req({
      scuola_id: SEDE_A,
      // retta svuotata (reset), mensa aggiornata, un valore non-stringa da scartare
      causali_config: { retta: '', mensa: 'Mensa {anno}', divisa: 123 },
    }))
    expect(res.status).toBe(200)
    expect(h.upserted?.causali_config).toEqual({
      default: '{descrizione} - {sede}',
      mensa: 'Mensa {anno}',
    })
  })
})
