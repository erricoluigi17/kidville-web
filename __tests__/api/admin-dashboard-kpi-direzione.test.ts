import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// NESSUN IMPORTO IN EURO ESCE DALLA DASHBOARD (titolare, 2026-10-07).
//
// Fino al 2026-10-06 la Direzione riceveva `scadutoImporto`, `incassatoMese` e
// `trend`, gli altri ruoli no. Il titolare ha tolto le cifre in euro dalla home:
// restano i conteggi. Gli importi si vedono in Contabilità, non qui.
//
// Le asserzioni che contano sono sulle CHIAVI (esattamente quelle attese) e sulla
// tabella `incassi`, che non deve nemmeno essere interrogata: uno zero sarebbe
// un'affermazione falsa sui conti, e una query inutile resta un'esposizione.
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) }
})

import { GET as DASHBOARD_GET } from '@/app/api/admin/dashboard/route'

const req = () => new NextRequest('http://localhost/api/admin/dashboard')

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  alunni: [{ id: 'al-a', classe_sezione: '2 ANNI', stato: 'iscritto', scuola_id: SEDE_A }],
  // Un pagamento scaduto e non saldato, con un importo vero nella fixture: il
  // conteggio deve uscire, l'importo no.
  pagamenti: [
    {
      id: 'pag-1',
      scuola_id: SEDE_A,
      // `tipo` serve davvero: la route esclude i contenitori rateali con
      // `.neq('tipo','padre')`, e il finto Supabase — giustamente severo — non fa
      // passare una riga in cui la colonna filtrata non esiste affatto.
      tipo: 'singolo',
      importo: 250,
      importo_pagato: 0,
      scadenza: '2026-01-10',
      stato: 'non_pagato',
      alunni: { nome: 'Prova', cognome: 'Collaudo' },
    },
  ],
  enrollment_submissions: [],
  mensa_prenotazioni: [],
  form_submissions: [],
  fatture_emesse: [],
  segnalazioni: [],
  audit_scritture_docente: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
})

const comeUtente = (user: Record<string, unknown>) => {
  h.requireStaff.mockResolvedValue({ user: { scuola_id: SEDE_A, ...user } })
}

describe('GET /api/admin/dashboard — nessun ruolo riceve importi', () => {
  const identita: [string, Record<string, unknown>][] = [
    ['SEGRETERIA', { id: 'seg-1', role: 'segreteria' }],
    ['ADMIN', { id: 'dir-1', role: 'admin' }],
    ['COORDINATOR', { id: 'dir-1', role: 'coordinator' }],
    // `role` è la veste indossata adesso; i ruoli reali sono in `ruoli`.
    ['COORDINATRICE in veste di genitore', { id: 'dir-2', role: 'genitore', ruoli: ['coordinator', 'genitore'] }],
  ]

  for (const [nome, user] of identita) {
    it(`${nome}: solo conteggi, nessuna chiave in euro, nessuna lettura di incassi`, async () => {
      comeUtente(user)
      const j = await (await DASHBOARD_GET(req())).json()

      expect(Object.keys(j.pagamenti).sort()).toEqual(['fattureInAttesa', 'scadutoCount'])
      expect(j.pagamenti.scadutoCount).toBe(1)
      expect(j).not.toHaveProperty('trend')
      expect(j.alert.scaduti).toHaveLength(1)
      expect(Object.keys(j.alert.scaduti[0]).sort()).toEqual(['alunno', 'id', 'scadenza'])
      expect(JSON.stringify(j)).not.toContain('250')
      expect(h.tabelle).not.toContain('incassi')
      // E il resto della dashboard non deve essersi rotto.
      expect(j.studenti.iscritti).toBe(1)
    })
  }
})
