// @vitest-environment node
/**
 * `GET /api/pagamenti` risponde anche COME SI PAGA: `sedi: [{ id, nome, iban, intestatario }]`.
 *
 * ─── PERCHÉ STA NELLA STESSA RISPOSTA ───────────────────────────────────────
 * La pagina del genitore mostra già la causale consigliata, che il GET compone
 * per ogni voce leggendo `causali_config` in un loop per sede. L'IBAN e
 * l'intestatario abitano la stessa riga di `admin_settings` e servono alla
 * stessa card: una seconda chiamata li leggerebbe di nuovo, e una famiglia con
 * figli in due plessi vedrebbe due card o — peggio — una sola con le coordinate
 * di uno dei due.
 *
 * ⚠️ IL PERIMETRO DELLE SEDI È QUELLO DELLE RIGHE, non «tutte le sedi». Le
 * righe sono già filtrate (`.in('scuola_id', sediAttive)` per lo staff,
 * `.in('alunno_id', figli)` per il genitore): da lì escono le sedi distinte e
 * nient'altro. Un elenco più largo direbbe a un genitore che esistono plessi
 * dove non ha figli.
 *
 * Il finto client APPLICA i filtri (`__tests__/fixtures/finto-supabase.ts`): se
 * la lettura di `fiscale_config` non filtrasse per sede, la sede B qui
 * riceverebbe le coordinate della sede A e il test sarebbe ROSSO. È la
 * differenza con un mock piatto, che risponde la stessa riga a ogni tabella e
 * resta verde con e senza il filtro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// IBAN SINTETICI: l'esempio pubblico della Banca d'Italia e una sua variante con
// una cifra cambiata. Nessuno dei due appartiene a un conto reale.
const IBAN_A = 'IT60X0542811101000000123456'
const IBAN_A_LEGGIBILE = 'IT60 X054 2811 1010 0000 0123 456'
const IBAN_STORTO = 'IT60X0542811101000000123457'
// CF SINTETICO — nessuna persona reale (repo pubblico, dati di minori mai reali).
const CF = 'ABCDEF00A00A000A'

const GENITORE = '33333333-3333-4333-8333-333333333333'
const STAFF = '11111111-1111-4111-8111-111111111111'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  sediAttive: vi.fn(async () => [] as string[]),
  figli: vi.fn(async () => [] as string[]),
  db: {} as DBFinto,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser, requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.sediAttive(...(a as [])),
  assertAlunnoInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliDiGenitore: (...a: unknown[]) => h.figli(...(a as [])),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) as never }
})

import { GET } from '@/app/api/pagamenti/route'

const url = (qs = '') =>
  new Request(`http://localhost/api/pagamenti?${qs}`) as unknown as import('next/server').NextRequest

const pagamento = (id: string, alunno: string, sede: string) => ({
  id,
  alunno_id: alunno,
  scuola_id: sede,
  descrizione: 'Retta Settembre 2026',
  importo: 150,
  importo_pagato: 0,
  scadenza: '2026-09-30',
  stato: 'da_pagare',
  tipo: 'singolo',
  periodo_competenza: '2026-09-01',
  visibile_dal: null,
  payment_categories: { id: 'c-1', nome: 'Rette', slug: 'rette', colore: null, icona: null },
  alunni: { id: alunno, nome: 'Mara', cognome: 'Bianchi', codice_fiscale: CF, classe_sezione: null, sospeso: false },
})

/** Due plessi: A con le coordinate compilate, B con l'IBAN sbagliato di una cifra. */
const dbDueSedi = (): DBFinto => ({
  pagamenti: [pagamento('pg-a', ALU_A, SEDE_A), pagamento('pg-b', ALU_B, SEDE_B)],
  scuole: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  admin_settings: [
    {
      scuola_id: SEDE_A,
      fiscale_config: { denominazione: 'Scuola La Favola soc. coop.', iban: IBAN_A },
      aruba_config: {},
      causali_config: {},
    },
    {
      scuola_id: SEDE_B,
      fiscale_config: { denominazione: 'Sede Beta', iban: IBAN_STORTO },
      aruba_config: {},
      causali_config: {},
    },
  ],
  pagamenti_quote: [],
})

/** La forma di una voce di `sedi`: è il contratto che la card «Come pagare» consuma. */
type VoceSede = { id: string; nome: string; iban: string | null; intestatario: string | null }

/** L'ordine di `sedi` segue quello delle righe: qui si confronta il CONTENUTO, non l'ordine. */
const perId = (sedi: VoceSede[]): VoceSede[] => [...sedi].sort((a, b) => a.id.localeCompare(b.id))

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle = []
  h.db = dbDueSedi()
  h.requireUser.mockResolvedValue({ user: { id: GENITORE, role: 'genitore' } })
  h.figli.mockResolvedValue([ALU_A, ALU_B])
  h.sediAttive.mockResolvedValue([SEDE_A, SEDE_B])
})

describe('GET /api/pagamenti — le coordinate del bonifico, una per sede', () => {
  it('genitore con figli in DUE sedi: due voci in `sedi`, ognuna con le PROPRIE coordinate', async () => {
    const res = await GET(url())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.sedi).toHaveLength(2)
    expect(perId(j.sedi)).toEqual([
      { id: SEDE_A, nome: NOME_SEDE_A, iban: IBAN_A_LEGGIBILE, intestatario: 'Scuola La Favola soc. coop.' },
      // L'IBAN della sede B ha una cifra sbagliata: non si mostra affatto.
      { id: SEDE_B, nome: NOME_SEDE_B, iban: null, intestatario: 'Sede Beta' },
    ])
  })

  it('sede senza riga di impostazioni → `iban` e `intestatario` a `null`, non spariti', async () => {
    h.db.admin_settings = []
    const j = await (await GET(url())).json()
    expect(perId(j.sedi)).toEqual([
      { id: SEDE_A, nome: NOME_SEDE_A, iban: null, intestatario: null },
      { id: SEDE_B, nome: NOME_SEDE_B, iban: null, intestatario: null },
    ])
  })

  it('sede senza nome in `scuole` → `nome` stringa vuota (la card resta, l’etichetta no)', async () => {
    h.db.scuole = [{ id: SEDE_A, nome: NOME_SEDE_A }]
    const j = await (await GET(url())).json()
    expect(perId(j.sedi).map((s) => s.nome)).toEqual([NOME_SEDE_A, ''])
  })

  it('staff con `?scuola_id=`: `sedi` porta SOLO quella sede, nessuna in più', async () => {
    h.requireUser.mockResolvedValue({ user: { id: STAFF, role: 'segreteria' } })
    const j = await (await GET(url(`scuola_id=${SEDE_A}`))).json()
    expect(j.data.map((r: { scuola_id: string }) => r.scuola_id)).toEqual([SEDE_A])
    expect(j.sedi).toEqual([
      { id: SEDE_A, nome: NOME_SEDE_A, iban: IBAN_A_LEGGIBILE, intestatario: 'Scuola La Favola soc. coop.' },
    ])
  })

  it('nessuna riga → `data: []` e `sedi: []` (la forma della risposta non cambia)', async () => {
    h.db.pagamenti = []
    const j = await (await GET(url())).json()
    expect(j).toMatchObject({ success: true, data: [], sedi: [] })
  })

  it('genitore SENZA figli: il ritorno anticipato porta comunque `sedi: []`', async () => {
    // Senza questo, la pagina riceverebbe `sedi` undefined proprio nel caso in
    // cui non ha niente da mostrare, e il componente andrebbe letto due volte.
    h.figli.mockResolvedValue([])
    const j = await (await GET(url())).json()
    expect(j).toEqual({ success: true, data: [], sedi: [] })
  })

  it('`data` resta quello di prima: causale consigliata e nome sede intatti', async () => {
    h.db.pagamenti = [pagamento('pg-a', ALU_A, SEDE_A)]
    h.figli.mockResolvedValue([ALU_A])
    const j = await (await GET(url())).json()
    expect(j.data).toHaveLength(1)
    expect(j.data[0]).toMatchObject({
      id: 'pg-a',
      scuola_nome: NOME_SEDE_A,
      causale_suggerita: `Retta Settembre 2026 - per il minore Mara Bianchi - ${CF} - ALFA`,
      residuo: 150,
    })
  })
})
