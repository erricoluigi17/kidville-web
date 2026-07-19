import { describe, it, expect, vi, beforeEach } from 'vitest'

// GET /api/pagamenti compone `causale_suggerita` PER PAGAMENTO col modello per-categoria
// (admin_settings.causali_config, indicizzato per slug) reso coi dati della voce.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  pagamenti: [] as Record<string, unknown>[],
  scuole: [] as Record<string, unknown>[],
  settingsRow: {} as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  assertAlunnoInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.or = () => b
      b.order = () => b
      b.gte = () => b
      b.lte = () => b
      b.maybeSingle = async () => ({ data: table === 'admin_settings' ? h.settingsRow : null, error: null })
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'pagamenti' ? h.pagamenti : table === 'scuole' ? h.scuole : [], error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/route'

const url = (qs = '') => new Request(`http://localhost/api/pagamenti?${qs}`) as unknown as import('next/server').NextRequest

// CF SINTETICO — nessuna persona reale (repo pubblico, dati di minori mai reali).
const CF = 'ABCDEF00A00A000A'

const pagRetta = () => ({
  id: 'pg-1', alunno_id: 'al-1', scuola_id: 'sc-1', descrizione: 'Retta Settembre 2026',
  importo: 150, importo_pagato: 0, scadenza: '2026-09-30', stato: 'da_pagare', tipo: 'singolo',
  periodo_competenza: '2026-09-01',
  payment_categories: { id: 'c-1', nome: 'Rette', slug: 'rette', colore: null, icona: null },
  alunni: { id: 'al-1', nome: 'Mara', cognome: 'Bianchi', codice_fiscale: CF, classe_sezione: null, sospeso: false },
})

describe('GET /api/pagamenti — causale_suggerita per categoria', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.pagamenti = [pagRetta()]
    h.scuole = [{ id: 'sc-1', nome: 'Kidville Giugliano' }]
    h.settingsRow = null
  })

  it('usa il MODELLO della categoria (slug) reso coi dati della voce (mese/anno/importo)', async () => {
    h.settingsRow = { causali_config: { rette: 'Retta {mese} {anno} - {nome_completo} - {codice_fiscale} - {sede} - {importo}' } }
    const res = await GET(url())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].causale_suggerita).toBe(`Retta settembre 2026 - Mara Bianchi - ${CF} - GIUGLIANO - € 150,00`)
  })

  it('config assente → ricade sul modello PREDEFINITO (formato storico)', async () => {
    h.settingsRow = null // nessuna riga impostazioni
    const res = await GET(url())
    const j = await res.json()
    expect(j.data[0].causale_suggerita).toBe(`Retta Settembre 2026 - per il minore Mara Bianchi - ${CF} - GIUGLIANO`)
  })

  it('categoria senza modello dedicato → usa il modello «default» della config', async () => {
    h.settingsRow = { causali_config: { default: 'BONIFICO {descrizione} / {sede}' } }
    const res = await GET(url())
    const j = await res.json()
    expect(j.data[0].causale_suggerita).toBe('BONIFICO Retta Settembre 2026 / GIUGLIANO')
  })

  it('periodo_competenza null → {mese}/{anno} spariscono con grazia (il resto del segmento resta)', async () => {
    h.settingsRow = { causali_config: { rette: '{descrizione} {mese} {anno} - {nome_completo}' } }
    h.pagamenti = [{ ...pagRetta(), periodo_competenza: null }]
    const res = await GET(url())
    const j = await res.json()
    // {mese}/{anno} vuoti collassano, ma {descrizione} tiene in vita il segmento.
    expect(j.data[0].causale_suggerita).toBe('Retta Settembre 2026 - Mara Bianchi')
  })
})
