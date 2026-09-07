import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * GET /api/mensa/ticket-residui/storico — quando li ha comprati, quando li ha usati.
 *
 * Esiste già `GET /api/pagamenti/ticket/storico`, ed è la vista CONTABILE: gate
 * `requireStaff` (cuoca e insegnanti fuori) e dentro gli importi, il metodo di
 * pagamento e lo stato della ricevuta. Questa è la vista della CUCINA sullo stesso
 * ledger: chi apre la riga di un bambino vede le DATE — «+10 il 7 luglio»,
 * «−1 il 9 luglio» — e niente euro, perché alla cucina gli euro non servono e
 * `requireKitchenRead` fa entrare anche la cuoca e l'insegnante.
 *
 * Verificato in produzione il 2026-09-07: 11 prenotazioni e 11 movimenti di tipo
 * `consumo`, allineati 1:1 — il ledger è la fonte giusta per «quando ha mangiato».
 */

const SEGRETERIA = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'
const EDUCATOR = 'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5'
const ALUNNO = '11111111-1111-1111-1111-111111111111'

const h = vi.hoisted(() => ({
  utente: null as Record<string, unknown> | null,
  alunno: { id: '11111111-1111-1111-1111-111111111111', section_id: 'sec-a', scuola_id: 'sc-1' } as Record<string, unknown> | null,
  sedi: ['sc-1'] as string[],
  sezioniDocente: [] as string[],
  movimenti: [] as Record<string, unknown>[],
  movimentiErr: null as { message: string } | null,
  ticket: { saldo_ticket: 5, ultimo_carico: '2026-07-26T10:00:00Z' } as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.sedi }))
vi.mock('@/lib/sezioni/docenti', () => ({
  sezioniDiUtente: async () => h.sezioniDocente,
  nomiSezioniDiUtente: async () => [],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b; b.eq = () => b; b.in = () => b; b.order = () => b; b.limit = () => b
      b.single = async () => ({ data: h.utente, error: null })
      b.maybeSingle = async () => {
        if (table === 'alunni') return { data: h.alunno, error: null }
        if (table === 'ticket_mensa') return { data: h.ticket, error: null }
        return { data: h.utente, error: null }
      }
      b.then = (res: (v: unknown) => void) => {
        if (table === 'mensa_ticket_movimenti') return res({ data: h.movimenti, error: h.movimentiErr })
        return res({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/mensa/ticket-residui/storico/route'

const req = (userId: string, qs = `?alunno_id=${ALUNNO}`) =>
  new NextRequest(`http://localhost/api/mensa/ticket-residui/storico${qs}`, { headers: { 'x-user-id': userId } })

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { id: SEGRETERIA, ruolo: 'segreteria', role: 'segreteria', scuola_id: 'sc-1' }
  h.alunno = { id: ALUNNO, section_id: 'sec-a', scuola_id: 'sc-1' }
  h.sedi = ['sc-1']
  h.sezioniDocente = []
  h.movimenti = []
  h.movimentiErr = null
  h.ticket = { saldo_ticket: 5, ultimo_carico: '2026-07-26T10:00:00Z' }
})

describe('GET /api/mensa/ticket-residui/storico — acquisti e consumi con le loro date', () => {
  it('restituisce i movimenti con data, tipo e quantità, più il saldo corrente', async () => {
    h.movimenti = [
      { id: 'm2', tipo: 'consumo', delta: -1, saldo_dopo: 9, data: '2026-07-09', origine: 'prenotazione', creato_il: '2026-07-09T08:00:00Z' },
      { id: 'm1', tipo: 'ricarica', delta: 10, saldo_dopo: 10, data: '2026-07-07', origine: 'segreteria', creato_il: '2026-07-07T09:00:00Z' },
    ]
    const res = await GET(req(SEGRETERIA))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.saldo_ticket).toBe(5)
    expect(j.data.movimenti).toHaveLength(2)
    expect(j.data.movimenti[0]).toMatchObject({ tipo: 'consumo', delta: -1, data: '2026-07-09' })
    expect(j.data.movimenti[1]).toMatchObject({ tipo: 'ricarica', delta: 10, data: '2026-07-07' })
  })

  it('non fa uscire euro né metodi di pagamento: è la vista della cucina', async () => {
    h.movimenti = [{ id: 'm1', tipo: 'ricarica', delta: 10, saldo_dopo: 10, data: '2026-07-07', origine: 'segreteria', creato_il: '2026-07-07T09:00:00Z' }]
    const j = await (await GET(req(SEGRETERIA))).json()
    const testo = JSON.stringify(j)
    expect(testo).not.toMatch(/importo|metodo|incass/i)
    expect(Object.keys(j.data.movimenti[0]).sort()).toEqual(['data', 'delta', 'id', 'origine', 'saldo_dopo', 'tipo'])
  })

  it('ledger assente (CI non migrata) → 200 con elenco vuoto DICHIARATO, non un finto «mai usato»', async () => {
    h.movimentiErr = { message: 'PGRST205' }
    const res = await GET(req(SEGRETERIA))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.movimenti).toEqual([])
    expect(j.data.storico_non_disponibile).toBe(true)
  })

  it('senza alunno_id → 400', async () => {
    expect((await GET(req(SEGRETERIA, ''))).status).toBe(400)
  })
})

describe('GET /api/mensa/ticket-residui/storico — chi può aprire la riga di un bambino', () => {
  it('cuoca → 200 anche senza sezioni assegnate (assertAlunnoInScope la respingerebbe)', async () => {
    h.utente = { id: SEGRETERIA, ruolo: 'cuoca', role: 'cuoca', scuola_id: 'sc-1' }
    h.sezioniDocente = []
    expect((await GET(req(SEGRETERIA))).status).toBe(200)
  })

  it('alunno di un altro plesso → 403, anche per la segreteria', async () => {
    h.alunno = { id: ALUNNO, section_id: 'sec-a', scuola_id: 'sc-ALTRA' }
    expect((await GET(req(SEGRETERIA))).status).toBe(403)
  })

  it('educator: la propria classe passa, quella altrui no', async () => {
    h.utente = { id: EDUCATOR, ruolo: 'educator', role: 'educator', scuola_id: 'sc-1' }
    h.sezioniDocente = ['sec-a']
    expect((await GET(req(EDUCATOR))).status).toBe(200)
    h.sezioniDocente = ['sec-b']
    expect((await GET(req(EDUCATOR))).status).toBe(403)
  })

  it('genitore → 403: il gate di cucina non lo ammette', async () => {
    h.utente = { id: SEGRETERIA, ruolo: 'genitore', role: 'genitore', scuola_id: 'sc-1' }
    expect((await GET(req(SEGRETERIA))).status).toBe(403)
  })

  it('alunno inesistente → 404', async () => {
    h.alunno = null
    expect((await GET(req(SEGRETERIA))).status).toBe(404)
  })
})
