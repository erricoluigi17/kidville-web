import { describe, it, expect, vi, beforeEach } from 'vitest'

// T4 — la Segreteria può FORZARE prenotazione/disdetta dei pasti fuori orario
// (telefonate out-of-hours), con saldo che può andare in negativo. Qui si prova
// l'intera catena ticket a livello di route: saldo (ticket_mensa) ↔ prenotazione
// (mensa_prenotazioni) ↔ movimento di ledger (mensa_ticket_movimenti).

const ALUNNO = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const GENITORE = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2'
const SEGRETERIA = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  entroCutoff: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  logEvento: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  saldo: 5,
  existingPren: null as Record<string, unknown> | null,
  prenotazioniList: [] as Record<string, unknown>[],
  menu: { attivo: true, chiuso: false } as Record<string, unknown>,
  // Se impostato, la RPC transazionale ritorna questo errore. { code: 'PGRST202' }
  // simula la RPC ASSENTE (DB E2E CI non migrato) → il route degrada al fallback.
  rpcError: null as { code: string } | null,
  // catture delle scritture per verificare la catena
  saldoWrites: [] as number[],
  prenUpserts: [] as Record<string, unknown>[],
  prenUpdates: [] as Record<string, unknown>[],
  ledger: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/mensa/server', () => ({
  loadMensaConfig: async () => ({ cutoffOra: '09:30', giorniAttivi: [1, 2, 3, 4, 5], settimaneRotazione: 4, sogliaSaldoBasso: 5 }),
  loadResolveOptions: async () => ({}),
  resolveMenuConfigId: async () => null,
  entroCutoff: h.entroCutoff,
}))
vi.mock('@/lib/mensa/resolveMenu', () => ({ resolveMenuGiorno: () => h.menu }))
vi.mock('@/lib/mensa/notify', () => ({ notificaSaldoBasso: async () => {} }))
vi.mock('@/lib/mensa/allergie-check', () => ({ controllaAllergie: async () => {} }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: h.genitoreHasFiglio }))
// Appendice logging: si spia SOLO logEvento (il resto resta reale e silenzioso
// sotto VITEST). Gli eventi di dominio mensa hanno `evento` = 'mensa'; quelli di
// `withRoute` ('route') e del ledger ('db') si filtrano via.
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    // RPC transazionale: di default (rpcError=null) simula il SUCCESSO della
    // transazione atomica, replicando gli stessi side-effect delle 3 scritture
    // (saldo ↔ prenotazione ↔ ledger) così le asserzioni della catena reggono
    // sul percorso RPC. Con rpcError impostato ritorna l'errore → fallback.
    rpc: async (fn: string, params: Record<string, unknown>) => {
      if (h.rpcError) return { data: null, error: h.rpcError }
      if (fn === 'scala_ticket_e_prenota') {
        const nuovo = Number(h.saldo) - 1
        h.saldo = nuovo
        h.saldoWrites.push(nuovo)
        h.prenUpserts.push({
          alunno_id: params.p_alunno_id, scuola_id: params.p_scuola_id, data: params.p_data,
          stato: 'prenotato', origine: params.p_origine, ticket_scalato: 1, prenotato_da: params.p_utente_id,
        })
        h.ledger.push({
          alunno_id: params.p_alunno_id, scuola_id: params.p_scuola_id, tipo: 'consumo', delta: -1,
          saldo_dopo: nuovo, prenotazione_id: 'pr-1', origine: params.p_origine, data: params.p_data, creato_da: params.p_utente_id,
        })
        return { data: nuovo, error: null }
      }
      if (fn === 'riaccredita_ticket_e_disdici') {
        const ticket = Number(h.existingPren?.ticket_scalato ?? 1)
        const nuovo = Number(h.saldo) + ticket
        h.saldo = nuovo
        h.saldoWrites.push(nuovo)
        h.prenUpdates.push({ stato: 'disdetto', prenotato_da: params.p_utente_id })
        h.ledger.push({ tipo: 'disdetta', delta: ticket, saldo_dopo: nuovo, origine: 'disdetta' })
        return { data: nuovo, error: null }
      }
      return { data: null, error: null }
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.gte = chain; b.lte = chain
      // .order() è terminale nel route (GET: lista prenotazioni del range)
      b.order = async () => ({ data: h.prenotazioniList, error: null })
      b.maybeSingle = async () => {
        if (table === 'ticket_mensa') return { data: { saldo_ticket: h.saldo }, error: null }
        if (table === 'alunni') return { data: h.alunno, error: null }
        if (table === 'mensa_prenotazioni') return { data: h.existingPren, error: null }
        return { data: null, error: null }
      }
      b.upsert = (row: Record<string, unknown>) => {
        if (table === 'ticket_mensa') { h.saldoWrites.push(Number(row.saldo_ticket)); return Promise.resolve({ error: null }) }
        if (table === 'mensa_prenotazioni') {
          h.prenUpserts.push(row)
          return { select: () => ({ single: async () => ({ data: { id: 'pr-1' }, error: null }) }) }
        }
        return Promise.resolve({ error: null })
      }
      b.insert = async (row: Record<string, unknown>) => {
        if (table === 'mensa_ticket_movimenti') h.ledger.push(row)
        return { error: null }
      }
      b.update = (row: Record<string, unknown>) => {
        if (table === 'mensa_prenotazioni') h.prenUpdates.push(row)
        return { eq: async () => ({ error: null }) }
      }
      return b
    },
  }),
}))

import { GET, POST, DELETE } from '@/app/api/mensa/prenotazioni/route'

const getReq = (qs: string) => new Request(`http://localhost/api/mensa/prenotazioni?${qs}`)
const postReq = (body: unknown) =>
  new Request('http://localhost/api/mensa/prenotazioni', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
const delReq = (qs: string) => new Request(`http://localhost/api/mensa/prenotazioni?${qs}`, { method: 'DELETE' })

// Solo gli eventi di dominio mensa (via il rumore 'route'/'db' degli altri log).
const eventiMensa = () => h.logEvento.mock.calls.filter((c) => c[0] === 'mensa')

beforeEach(() => {
  vi.clearAllMocks()
  h.saldo = 5
  h.existingPren = null
  h.prenotazioniList = []
  h.menu = { attivo: true, chiuso: false }
  h.rpcError = null
  h.alunno = { id: ALUNNO, scuola_id: 'sc-1', nome: 'Mia', cognome: 'Rossi', classe_sezione: '1A', section_id: null, allergies: null, allergeni: null }
  h.saldoWrites = []; h.prenUpserts = []; h.prenUpdates = []; h.ledger = []
  h.requireUser.mockResolvedValue({ user: { id: GENITORE, role: 'genitore' } })
  h.entroCutoff.mockReturnValue(true)
  h.genitoreHasFiglio.mockResolvedValue(true)
})

describe('POST /api/mensa/prenotazioni', () => {
  it('genitore prenota con saldo 5 → 201: scala a 4, prenotazione+ledger coerenti', async () => {
    h.saldo = 5
    const res = await POST(postReq({ alunno_id: ALUNNO, date: '2026-07-20' }))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.data.esiti[0]).toEqual({ data: '2026-07-20', ok: true })
    expect(j.data.saldo).toBe(4)
    // saldo sceso di 1
    expect(h.saldoWrites).toEqual([4])
    // prenotazione: stato/origine/ticket
    expect(h.prenUpserts[0].stato).toBe('prenotato')
    expect(h.prenUpserts[0].origine).toBe('genitore')
    expect(h.prenUpserts[0].ticket_scalato).toBe(1)
    // ledger: consumo -1 con saldo_dopo 4
    expect(h.ledger[0]).toMatchObject({ tipo: 'consumo', delta: -1, saldo_dopo: 4, origine: 'genitore' })
    // Appendice logging: successo dell'evento critico (conteggi/saldo/origine); nessun saldo-negativo.
    const ev = eventiMensa()
    expect(ev).toHaveLength(1)
    expect(ev[0][2]).toMatchObject({ operazione: 'mensa/prenotazioni:POST', esito: 'prenotazione', esitiOk: 1, esitiKo: 0, saldoDopo: 4, origine: 'genitore' })
  })

  it('genitore con saldo 0 → esito bloccato "Saldo ticket esaurito", nessuna scrittura', async () => {
    h.saldo = 0
    const res = await POST(postReq({ alunno_id: ALUNNO, date: '2026-07-20' }))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.data.esiti[0].ok).toBe(false)
    expect(j.data.esiti[0].motivo).toBe('Saldo ticket esaurito')
    expect(j.data.saldo).toBe(0)
    expect(h.saldoWrites).toHaveLength(0)
    expect(h.prenUpserts).toHaveLength(0)
    expect(h.ledger).toHaveLength(0)
  })

  it('genitore con saldo 2 e TRE date (array come dalla UI) → 2 prenotate, terza bloccata a saldo esaurito', async () => {
    h.saldo = 2
    const res = await POST(postReq({ alunno_id: ALUNNO, date: ['2026-07-20', '2026-07-21', '2026-07-22'] }))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.data.saldo).toBe(0)
    expect(j.data.esiti).toHaveLength(3)
    expect(j.data.esiti[0]).toEqual({ data: '2026-07-20', ok: true })
    expect(j.data.esiti[1]).toEqual({ data: '2026-07-21', ok: true })
    expect(j.data.esiti[2]).toEqual({ data: '2026-07-22', ok: false, motivo: 'Saldo ticket esaurito' })
    // saldo scalato in sequenza 2 → 1 → 0; mai sotto zero per il genitore
    expect(h.saldoWrites).toEqual([1, 0])
    // solo 2 prenotazioni scritte (la terza data non tocca il DB)
    expect(h.prenUpserts).toHaveLength(2)
    expect(h.prenUpserts.map(p => p.data)).toEqual(['2026-07-20', '2026-07-21'])
    // 2 righe di ledger con saldo_dopo progressivo
    expect(h.ledger).toHaveLength(2)
    expect(h.ledger.map(m => m.saldo_dopo)).toEqual([1, 0])
    expect(h.ledger.every(m => m.tipo === 'consumo' && m.delta === -1)).toBe(true)
  })

  it('genitore oltre cutoff → esito bloccato "Oltre l\'orario limite (cutoff)", nessuna scrittura', async () => {
    h.entroCutoff.mockReturnValue(false)
    const res = await POST(postReq({ alunno_id: ALUNNO, date: '2026-07-20' }))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.data.esiti[0].ok).toBe(false)
    expect(j.data.esiti[0].motivo).toBe("Oltre l'orario limite (cutoff)")
    expect(h.saldoWrites).toHaveLength(0)
    expect(h.prenUpserts).toHaveLength(0)
    expect(h.ledger).toHaveLength(0)
  })

  it('genitore NON legato all\'alunno → 403', async () => {
    h.genitoreHasFiglio.mockResolvedValue(false)
    const res = await POST(postReq({ alunno_id: ALUNNO, date: '2026-07-20' }))
    expect(res.status).toBe(403)
  })

  it('SEGRETERIA oltre cutoff con saldo 0 → 201: forza (saldo va a −1), origine=segreteria, nessun errore trapelato', async () => {
    // Caso chiave: prima della modifica la Segreteria è esclusa da isStaff → 403/blocco.
    h.requireUser.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria' } })
    h.entroCutoff.mockReturnValue(false) // oltre l'orario limite
    h.genitoreHasFiglio.mockResolvedValue(false) // la Segreteria NON è genitore dell'alunno
    h.saldo = 0
    const res = await POST(postReq({ alunno_id: ALUNNO, date: '2026-07-20' }))
    expect(res.status).toBe(201)
    const j = await res.json()
    // nessun errore di cutoff/saldo trapelato: tutti gli esiti ok
    expect(j.data.esiti.every((e: { ok: boolean }) => e.ok)).toBe(true)
    expect(j.data.esiti[0].motivo).toBeUndefined()
    // saldo può andare negativo
    expect(j.data.saldo).toBe(-1)
    expect(h.saldoWrites).toEqual([-1])
    expect(h.prenUpserts[0].origine).toBe('segreteria')
    expect(h.prenUpserts[0].stato).toBe('prenotato')
    expect(h.prenUpserts[0].ticket_scalato).toBe(1)
    expect(h.ledger[0]).toMatchObject({ tipo: 'consumo', delta: -1, saldo_dopo: -1, origine: 'segreteria' })
    // Appendice logging: successo + segnale dedicato "saldo-negativo" (alunno confluisce nei morosi).
    const ev = eventiMensa()
    expect(ev.map((c) => (c[2] as { esito?: string; tipo?: string }).esito ?? (c[2] as { tipo?: string }).tipo))
      .toEqual(expect.arrayContaining(['prenotazione', 'saldo-negativo']))
    const neg = ev.find((c) => (c[2] as { tipo?: string }).tipo === 'saldo-negativo')
    expect(neg?.[2]).toMatchObject({ operazione: 'mensa/prenotazioni:POST', tipo: 'saldo-negativo', alunno_id: ALUNNO, saldo: -1, origine: 'segreteria' })
  })
})

describe('POST /api/mensa/prenotazioni — morosità (B4/M4)', () => {
  it('genitore con figlio SOSPESO → 403 account_sospeso, nessuno scalo/prenotazione/ledger', async () => {
    // Prima della modifica la sospensione morosità non toccava la mensa: il
    // genitore sospeso prenotava lo stesso (findings M4, riprodotto LIVE → 201).
    h.alunno = { ...(h.alunno as Record<string, unknown>), sospeso: true }
    const res = await POST(postReq({ alunno_id: ALUNNO, date: '2026-07-20' }))
    expect(res.status).toBe(403)
    const j = await res.json()
    expect(j.motivo).toBe('account_sospeso')
    // il gate scatta PRIMA di qualunque scrittura
    expect(h.saldoWrites).toHaveLength(0)
    expect(h.prenUpserts).toHaveLength(0)
    expect(h.ledger).toHaveLength(0)
  })

  it('SEGRETERIA può forzare anche se l\'alunno è sospeso (azione di servizio dello sportello, non del genitore)', async () => {
    // La sospensione inibisce le azioni del GENITORE; lo staff che forza fuori
    // orario resta abilitato (gestione morosità allo sportello).
    h.requireUser.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria' } })
    h.genitoreHasFiglio.mockResolvedValue(false)
    h.alunno = { ...(h.alunno as Record<string, unknown>), sospeso: true }
    h.saldo = 0
    const res = await POST(postReq({ alunno_id: ALUNNO, date: '2026-07-20' }))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.data.esiti[0].ok).toBe(true)
  })
})

describe('mensa · transazione atomica RPC + fallback pulito (m6/D3)', () => {
  it('POST: RPC assente (PGRST202) → degrada alle 3 scritture con catena coerente + warn una volta', async () => {
    h.rpcError = { code: 'PGRST202' } // funzione non nel cache PostgREST (DB E2E non migrato)
    h.saldo = 5
    const res = await POST(postReq({ alunno_id: ALUNNO, date: '2026-07-20' }))
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.data.saldo).toBe(4)
    // stessa catena del percorso RPC: saldo↔prenotazione↔ledger coerenti
    expect(h.saldoWrites).toEqual([4])
    expect(h.prenUpserts[0].stato).toBe('prenotato')
    expect(h.ledger[0]).toMatchObject({ tipo: 'consumo', delta: -1, saldo_dopo: 4, origine: 'genitore' })
    // warn di degrado (RPC assente), a livello 'mensa'
    const warn = eventiMensa().filter((c) => c[1] === 'warn')
    expect(warn).toHaveLength(1)
    expect(warn[0][2]).toMatchObject({ operazione: 'mensa/prenotazioni:POST', esito: 'rpc-mensa-assente-fallback' })
  })

  it('DELETE: RPC assente (PGRST202) → riaccredito + disdetta + ledger via fallback + warn', async () => {
    h.rpcError = { code: 'PGRST202' }
    h.existingPren = { id: 'pr-1', stato: 'prenotato', ticket_scalato: 1 }
    h.saldo = 4
    const res = await DELETE(delReq(`alunno_id=${ALUNNO}&data=2026-07-20`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.saldo).toBe(5)
    expect(h.saldoWrites).toEqual([5])
    expect(h.prenUpdates[0].stato).toBe('disdetto')
    expect(h.ledger[0]).toMatchObject({ tipo: 'disdetta', delta: 1, saldo_dopo: 5, origine: 'disdetta' })
    const warn = eventiMensa().filter((c) => c[1] === 'warn')
    expect(warn).toHaveLength(1)
    expect(warn[0][2]).toMatchObject({ operazione: 'mensa/prenotazioni:DELETE', esito: 'rpc-mensa-assente-fallback' })
  })
})

describe('DELETE /api/mensa/prenotazioni', () => {
  it('genitore entro cutoff → 200: riaccredita (+1), stato disdetto, ledger disdetta', async () => {
    h.existingPren = { id: 'pr-1', stato: 'prenotato', ticket_scalato: 1 }
    h.saldo = 4
    const res = await DELETE(delReq(`alunno_id=${ALUNNO}&data=2026-07-20`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.saldo).toBe(5)
    expect(h.saldoWrites).toEqual([5])
    expect(h.prenUpdates[0].stato).toBe('disdetto')
    expect(h.ledger[0]).toMatchObject({ tipo: 'disdetta', delta: 1, saldo_dopo: 5, origine: 'disdetta' })
    // Appendice logging: successo della disdetta (saldo dopo riaccredito + origine).
    const ev = eventiMensa()
    expect(ev).toHaveLength(1)
    expect(ev[0][2]).toMatchObject({ operazione: 'mensa/prenotazioni:DELETE', esito: 'disdetta', saldoDopo: 5, origine: 'genitore' })
  })

  it('genitore oltre cutoff → 400, nessun riaccredito', async () => {
    h.entroCutoff.mockReturnValue(false)
    h.existingPren = { id: 'pr-1', stato: 'prenotato', ticket_scalato: 1 }
    const res = await DELETE(delReq(`alunno_id=${ALUNNO}&data=2026-07-20`))
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.error).toBe('Oltre l\'orario limite: disdetta non più possibile')
    expect(h.saldoWrites).toHaveLength(0)
    expect(h.prenUpdates).toHaveLength(0)
    expect(h.ledger).toHaveLength(0)
  })

  it('SEGRETERIA oltre cutoff → 200: rettifica con riaccredito (bypass cutoff, simmetrico al POST)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria' } })
    h.entroCutoff.mockReturnValue(false) // oltre l'orario limite
    h.genitoreHasFiglio.mockResolvedValue(false)
    h.existingPren = { id: 'pr-1', stato: 'prenotato', ticket_scalato: 1 }
    h.saldo = -1
    const res = await DELETE(delReq(`alunno_id=${ALUNNO}&data=2026-07-20`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.saldo).toBe(0)
    expect(h.saldoWrites).toEqual([0])
    expect(h.prenUpdates[0].stato).toBe('disdetto')
    expect(h.ledger[0]).toMatchObject({ tipo: 'disdetta', delta: 1, saldo_dopo: 0, origine: 'disdetta' })
  })
})

describe('GET /api/mensa/prenotazioni', () => {
  it('SEGRETERIA senza legame genitore → 200 con saldo (anche negativo) e prenotazioni', async () => {
    // Con isStaff senza segreteria la GET rispondeva 403 → saldo non mostrato in
    // PrenotazioneSegreteria. La modifica ripristina la lettura.
    h.requireUser.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria' } })
    h.genitoreHasFiglio.mockResolvedValue(false)
    h.saldo = -2
    h.prenotazioniList = [{ data: '2026-07-20', stato: 'prenotato', origine: 'segreteria' }]
    const res = await GET(getReq(`alunno_id=${ALUNNO}&from=2026-07-20&to=2026-07-20`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.saldo).toBe(-2)
    expect(j.data.prenotazioni).toHaveLength(1)
    expect(j.data.prenotazioni[0].origine).toBe('segreteria')
  })
})
