// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import type { DBFinto, OpzioniFinto, Riga } from '../fixtures/finto-supabase'

// =============================================================================
// `GET /api/pagamenti` — la voce ATTIVA della coda fatture sulla riga
// (consegna 2a della coda fatture, rilievo e).
//
// Ogni riga STAFF porta `coda_stato: 'in_coda' | 'in_invio' | 'errore' | null`; al
// genitore il campo non arriva, e la coda non si legge nemmeno.
//
// Il finto client FILTRA davvero (`__tests__/fixtures/finto-supabase.ts`): i due
// filtri della lettura — sede e stato — hanno ciascuno un caso che diventa rosso
// se lo si toglie. Un mock piatto resterebbe verde con e senza.
//
// `resolveScuoleAttive` è quello VERO, su `utenti_scuole` e sul cookie
// `sedi_attive`. Uuid e nomi sintetici: il repository è pubblico.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-0000000000d4'
const ID_GENITORE = '33333333-3333-4333-8333-333333333333'
const CF_FINTO = 'ABCDEF00A00A000A'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  figli: vi.fn(async () => [] as string[]),
  db: {} as DBFinto,
  tabelle: [] as string[],
  opzioni: {} as OpzioniFinto,
  logEvento: vi.fn(),
}))

// Il logger vero con la sola `logEvento` sostituita: si misurano le CHIAMATE.
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: (...a: unknown[]) => h.requireUser(...a),
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliDiGenitore: (...a: unknown[]) => h.figli(...(a as [])),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, h.opzioni) }
})

import { GET } from '@/app/api/pagamenti/route'

const pagamento = (id: string, scuolaId: string, stato = 'pagato'): Riga => ({
  id,
  alunno_id: `al-${id}`,
  scuola_id: scuolaId,
  descrizione: 'Retta Settembre 2026',
  importo: 200,
  importo_pagato: stato === 'pagato' ? 200 : 0,
  sconto: null,
  scadenza: '2026-09-10',
  stato,
  tipo: 'singolo',
  visibile_dal: null,
  periodo_competenza: '2026-09',
  payment_categories: { id: 'cat-retta', nome: 'Retta', slug: 'retta', colore: null, icona: null },
  // Anagrafica SINTETICA: repo pubblico, mai un minore reale.
  alunni: { id: `al-${id}`, nome: 'Mario', cognome: 'Rossi', codice_fiscale: CF_FINTO, classe_sezione: '2 ANNI', sospeso: false },
})

const voce = (pagamentoId: string, scuolaId: string, stato: string): Riga => ({
  id: `coda-${pagamentoId}-${stato}`,
  pagamento_id: pagamentoId,
  scuola_id: scuolaId,
  stato,
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
  pagamenti: [pagamento('pg-a', SEDE_A), pagamento('pg-b', SEDE_B), pagamento('pg-c', SEDE_A), pagamento('pg-d', SEDE_A)],
  fatture_coda: [],
})

function req(cookie?: string, qs = ''): NextRequest {
  return {
    url: `http://localhost/api/pagamenti${qs ? `?${qs}` : ''}`,
    method: 'GET',
    headers: new Headers(),
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

type RigaRisposta = { id: string; coda_stato?: string | null }
const statoDi = (righe: RigaRisposta[]) => Object.fromEntries(righe.map((r) => [r.id, r.coda_stato]))
const esitoDi = (c: unknown) => (c as { esito?: string } | undefined)?.esito
const eventi = (esito: string) => h.logEvento.mock.calls.filter(([, , c]) => esitoDi(c) === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.opzioni = {}
  h.requireUser.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.requireStaff.mockResolvedValue({ user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.figli.mockResolvedValue([])
})

describe('GET /api/pagamenti — coda_stato sulle righe dello staff', () => {
  it('senza cookie: in_coda, errore, emessa → null, e senza voce → null', async () => {
    h.db.fatture_coda = [voce('pg-a', SEDE_A, 'in_coda'), voce('pg-b', SEDE_B, 'errore'), voce('pg-c', SEDE_A, 'emessa')]

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(statoDi(j.data)).toEqual({ 'pg-a': 'in_coda', 'pg-b': 'errore', 'pg-c': null, 'pg-d': null })
    // Il campo esce SEMPRE sulle righe dello staff, anche quando è null.
    for (const r of j.data as RigaRisposta[]) expect(r).toHaveProperty('coda_stato')
    expect(h.tabelle).toContain('fatture_coda')
  })

  it('prova del filtro di SEDE: cookie su A, voce di pg-a registrata su B → pg-a resta null', async () => {
    // Dato sintetico: isola il filtro `.in('scuola_id', scuolaIds)` della lettura.
    h.db.fatture_coda = [voce('pg-a', SEDE_B, 'in_invio')]

    const res = await GET(req(SEDE_A))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect((j.data as RigaRisposta[]).map((r) => r.id).sort()).toEqual(['pg-a', 'pg-c', 'pg-d'])
    expect(statoDi(j.data)['pg-a']).toBeNull()
    expect(h.tabelle).toContain('fatture_coda')
  })

  it('prova del filtro di STATO: 1000 emesse nella stessa sede non spingono fuori la voce attiva', async () => {
    // Lo storico (emesse, tolte) non scade mai. Senza `.in('stato', …)` qui arriverebbero
    // 1001 righe: in produzione PostgREST ne taglierebbe a 1000 in silenzio, e la voce
    // attiva potrebbe restare fuori. Il finto non tronca: il segnale è il warn.
    h.db.fatture_coda = [
      voce('pg-a', SEDE_A, 'in_coda'),
      ...Array.from({ length: 1000 }, (_, i) => voce(`pg-e-${i}`, SEDE_A, 'emessa')),
    ]

    const res = await GET(req(SEDE_A))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(statoDi(j.data)['pg-a']).toBe('in_coda')
    // L'assenza si guarda DOPO la presenza di `in_coda`: la lettura è già avvenuta.
    expect(h.logEvento.mock.calls.some(([, , c]) => esitoDi(c) === 'coda-badge-troncato')).toBe(false)
  })

  it('genitore: nessuna riga porta la chiave coda_stato, e fatture_coda non si legge', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ID_GENITORE, role: 'genitore' } })
    h.figli.mockResolvedValue(['al-pg-a', 'al-pg-b'])
    h.db.fatture_coda = [voce('pg-a', SEDE_A, 'in_coda'), voce('pg-b', SEDE_B, 'errore')]

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect((j.data as RigaRisposta[]).map((r) => r.id).sort()).toEqual(['pg-a', 'pg-b'])
    for (const r of j.data as RigaRisposta[]) expect(r).not.toHaveProperty('coda_stato')
    expect(h.tabelle).not.toContain('fatture_coda')
  })

  it('?solo_aperti=true: la coda non si legge (accoglie solo saldati), e le righe dicono null', async () => {
    h.db.pagamenti = [pagamento('pg-a', SEDE_A, 'da_pagare'), pagamento('pg-b', SEDE_B, 'da_pagare')]
    // Dato sintetico: una voce su un pagamento aperto non può esistere, e se la coda
    // venisse letta la riga direbbe «in_coda».
    h.db.fatture_coda = [voce('pg-a', SEDE_A, 'in_coda')]

    const res = await GET(req(undefined, 'solo_aperti=true'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(statoDi(j.data)).toEqual({ 'pg-a': null, 'pg-b': null })
    expect(h.tabelle).not.toContain('fatture_coda')
  })

  it('coda assente (PGRST205): 200, tutte null, e un info «coda-assente»', async () => {
    h.db.fatture_coda = []
    h.opzioni = { errori: { fatture_coda: { code: 'PGRST205', message: 'Could not find the table' } } }

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(Object.values(statoDi(j.data))).toEqual([null, null, null, null])
    const assente = eventi('coda-assente')
    expect(assente).toHaveLength(1)
    expect(assente[0][0]).toBe('fattura')
    expect(assente[0][1]).toBe('info')
    expect(assente[0][2]).toEqual({ operazione: 'pagamenti:GET', esito: 'coda-assente' })
  })

  it('guasto vero (08006): 200, tutte null, e un warn «coda-badge-non-letta»', async () => {
    h.db.fatture_coda = [voce('pg-a', SEDE_A, 'in_coda')]
    h.opzioni = { errori: { fatture_coda: { code: '08006', message: 'connection failure' } } }

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(Object.values(statoDi(j.data))).toEqual([null, null, null, null])
    const nonLetta = eventi('coda-badge-non-letta')
    expect(nonLetta).toHaveLength(1)
    expect(nonLetta[0][1]).toBe('warn')
    expect(eventi('coda-assente')).toHaveLength(0)
  })

  it('scope vuoto (cookie su una sede non accessibile): nessuna riga, e la coda non si legge', async () => {
    h.db.fatture_coda = [voce('pg-a', SEDE_A, 'in_coda')]

    const res = await GET(req(SEDE_C))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual([])
    expect(h.tabelle).not.toContain('fatture_coda')
  })
})
