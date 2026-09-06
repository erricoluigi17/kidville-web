import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'
import { sedeCausale } from '@/lib/pagamenti/causale'

// =============================================================================
// X3 — `pagamenti:GET` (ramo staff): il filtro di sede è INCONDIZIONATO.
//
// PERCHÉ QUESTO TEST ESISTE. La scansione «fail-open» ha segnalato la riga 211
// di questa route, `if (scuolaIds.length > 0)`. Riletta: NON è un filtro di
// tenancy. `scuolaIds` sono le sedi ESTRATTE dalle righe già filtrate, e la
// query che segue (`scuole` `.in('id', scuolaIds)`) serve solo a tradurre quegli
// uuid nel nome da mettere nella causale del bonifico; togliendo il guard il
// risultato sarebbe identico (`.in('id', [])` ⇒ nessuna riga). Il guard evita
// una query inutile, non nasconde un perimetro.
//
// Il perimetro vero è `.in('scuola_id', sediAttive)` (riga 133), ed è sempre
// applicato. Ma finora nessun test lo PROVAVA: i tre test esistenti su questa
// route usano mock che non filtrano e asseriscono che `.in` sia stato CHIAMATO
// — verdi anche con l'insieme sbagliato. Qui il finto client filtra davvero,
// quindi «scope vuoto ⇒ nessun pagamento» è una proprietà verificata: se
// qualcuno rendesse condizionale quel filtro, questo file diventa rosso.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-0000000000d4'
const CF_FINTO = 'ABCDEF00A00A000A'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: (...a: unknown[]) => h.requireUser(...a),
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) }
})

import { GET } from '@/app/api/pagamenti/route'

const pagamento = (id: string, scuolaId: string, nome: string) => ({
  id,
  alunno_id: `al-${id}`,
  scuola_id: scuolaId,
  descrizione: 'Retta Settembre 2026',
  importo: 200,
  importo_pagato: 0,
  sconto: null,
  scadenza: '2026-09-10',
  stato: 'da_pagare',
  tipo: 'singolo',
  periodo_competenza: '2026-09',
  payment_categories: { id: 'cat-retta', nome: 'Retta', slug: 'retta', colore: null, icona: null },
  // Anagrafica SINTETICA: repo pubblico, mai un minore reale.
  alunni: { id: `al-${id}`, nome, cognome: 'Prova', codice_fiscale: CF_FINTO, classe_sezione: '2 ANNI', sospeso: false },
})

const dbBase = (): DBFinto => ({
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  scuole: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  admin_settings: [],
  pagamenti: [pagamento('pg-a', SEDE_A, 'Alfa'), pagamento('pg-b', SEDE_B, 'Beta')],
})

function req(cookie?: string): NextRequest {
  return {
    url: 'http://localhost/api/pagamenti',
    method: 'GET',
    headers: new Headers(),
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireUser.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.requireStaff.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('GET /api/pagamenti — perimetro di sede del ramo staff', () => {
  it('senza cookie: tutte le sedi accessibili, ciascuna col proprio nome in causale', async () => {
    const res = await GET(req())

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.map((p: { id: string; scuola_nome: string }) => [p.id, p.scuola_nome])).toEqual([
      ['pg-a', NOME_SEDE_A],
      ['pg-b', NOME_SEDE_B],
    ])
  })

  it('cookie su UNA sede: solo i suoi pagamenti, e il nome dell\'altra sede non viene nemmeno risolto', async () => {
    const res = await GET(req(SEDE_A))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.map((p: { id: string }) => p.id)).toEqual(['pg-a'])
    expect(j.data[0].scuola_nome).toBe(NOME_SEDE_A)
    // La causale del bonifico porta la sede (senza il prefisso «Kidville»): è la
    // chiave con cui la riconciliazione abbina l'incasso al plesso giusto.
    expect(j.data[0].causale_suggerita).toContain(sedeCausale(NOME_SEDE_A))
    const corpo = JSON.stringify(j)
    expect(corpo).not.toContain(NOME_SEDE_B)
    expect(corpo).not.toContain(sedeCausale(NOME_SEDE_B))
  })

  it('scope VUOTO (cookie su sede non accessibile) ⇒ nessun pagamento, non «tutti»', async () => {
    const res = await GET(req(SEDE_C))

    expect(res.status).toBe(200)
    const j = await res.json()
    // `sedi: []` fa parte dell'invariante, non è un campo in più da tollerare:
    // le coordinate del bonifico escono UNA per sede delle righe restituite, e
    // con lo scope vuoto non c'è nessuna riga — quindi nemmeno una sede da
    // nominare. Un elenco non vuoto qui direbbe a chi non può vedere niente
    // quali plessi esistono.
    expect(j).toEqual({ success: true, data: [], sedi: [] })
  })
})
