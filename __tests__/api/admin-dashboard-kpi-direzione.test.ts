import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// I KPI ECONOMICI DELLA HOME SONO DELLA DIREZIONE (titolare, 2026-09-02).
//
// ─── COSA SI STA COLLAUDANDO, E PERCHÉ È DIVERSO DALLO SCADENZARIO ───────────
// In Contabilità i totali li somma il BROWSER, a partire da righe che la
// segreteria deve legittimamente vedere: lì nasconderli è mettere in ordine la
// vista, non costruire una barriera. Qui no: `scadutoImporto`, `incassatoMese` e
// `trend` li calcola il SERVER, e quindi il server può — e deve — non mandarli.
// Questo file collauda l'unica delle due cose che è una protezione vera.
//
// L'asserzione che conta è `not.toHaveProperty`, non «è zero»: uno zero sarebbe
// un'affermazione FALSA sui conti della scuola («non è entrato niente»), e
// sarebbe pure indistinguibile da un mese davvero senza incassi. La chiave non
// deve esistere. Stesso contratto della cassa (`cassa/movimenti`), stessa forma
// di test (`__tests__/cassa/movimenti-route.test.ts`).
//
// ─── COSA RESTA A TUTTI, E NON È UNA DIMENTICANZA ────────────────────────────
// `scadutoCount`, `fattureInAttesa` e `alert.scaduti`: sono la lista operativa
// con cui la segreteria sollecita. Decisione esplicita del titolare, coerente col
// fatto che in Contabilità gli importi riga per riga restano visibili.
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
import { dataCivile } from '@/i18n/config'

const OGGI = dataCivile()
const req = () => new NextRequest('http://localhost/api/admin/dashboard')

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  alunni: [{ id: 'al-a', classe_sezione: '2 ANNI', stato: 'iscritto', scuola_id: SEDE_A }],
  // Un pagamento scaduto e non saldato: alimenta insieme l'IMPORTO (riservato) e
  // il CONTEGGIO (che resta a tutti). Averli entrambi nella stessa fixture è il
  // punto: si deve poter vedere che uno sparisce e l'altro no.
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
  incassi: [{ id: 'inc-a', importo: 100, data_incasso: OGGI, pagamenti: { scuola_id: SEDE_A } }],
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

describe('GET /api/admin/dashboard — gli euro sono della Direzione', () => {
  it('SEGRETERIA: le tre chiavi economiche NON esistono nella risposta', async () => {
    comeUtente({ id: 'seg-1', role: 'segreteria' })
    const j = await (await DASHBOARD_GET(req())).json()

    expect(j.pagamenti).not.toHaveProperty('scadutoImporto')
    expect(j.pagamenti).not.toHaveProperty('incassatoMese')
    expect(j).not.toHaveProperty('trend')
  })

  it('SEGRETERIA: i conteggi e la lista degli scaduti restano — servono a sollecitare', async () => {
    comeUtente({ id: 'seg-1', role: 'segreteria' })
    const j = await (await DASHBOARD_GET(req())).json()

    expect(j.pagamenti.scadutoCount).toBe(1)
    expect(j.pagamenti).toHaveProperty('fattureInAttesa')
    expect(j.alert.scaduti).toHaveLength(1)
    // E il resto della dashboard non deve essersi rotto per un ramo di ruolo.
    expect(j.studenti.iscritti).toBe(1)
  })

  for (const ruolo of ['admin', 'coordinator'] as const) {
    it(`${ruolo.toUpperCase()}: le tre chiavi economiche ci sono, e coi numeri veri`, async () => {
      comeUtente({ id: 'dir-1', role: ruolo })
      const j = await (await DASHBOARD_GET(req())).json()

      expect(j.pagamenti.scadutoImporto).toBe(250)
      expect(j.pagamenti.incassatoMese).toBe(100)
      expect(Array.isArray(j.trend)).toBe(true)
    })
  }

  it('decide sui ruoli REALI, non sulla veste indossata adesso', async () => {
    // `user.role` è il ruolo ATTIVO, quello del cookie `kv-active-role`: una
    // coordinatrice che sta guardando l'app «come genitore» resta la Direzione.
    // Se questa route guardasse `role`, cambiare veste le toglierebbe i propri
    // numeri — e, girata al contrario, la stessa svista è come si regalano
    // permessi a chi indossa la veste giusta.
    comeUtente({ id: 'dir-2', role: 'genitore', ruoli: ['coordinator', 'genitore'] })
    const j = await (await DASHBOARD_GET(req())).json()

    expect(j.pagamenti.scadutoImporto).toBe(250)
  })
})
