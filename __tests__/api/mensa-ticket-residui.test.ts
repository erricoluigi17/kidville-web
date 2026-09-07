import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * GET /api/mensa/ticket-residui — quanti pasti restano a ogni bambino.
 *
 * IL FATTO CHE DETTA IL CONTRATTO, misurato in produzione il 2026-09-07:
 * `ticket_mensa` ha **18 righe** a fronte di **643 alunni iscritti** — Cesa 0,
 * Aversa 0, Giugliano 1. Chi non ha mai ricaricato NON HA la riga: un elenco
 * costruito partendo da `ticket_mensa` mostrerebbe 18 bambini su 643 e in due
 * sedi su tre sarebbe VUOTO, indistinguibile da una schermata rotta.
 * Per questo l'elenco parte dagli ALUNNI e i ticket sono un innesto opzionale:
 * niente riga ⇒ saldo 0, non «assente».
 */

const SEGRETERIA = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'
const EDUCATOR = 'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5'

const h = vi.hoisted(() => ({
  utente: null as Record<string, unknown> | null,
  alunni: [] as Record<string, unknown>[],
  alunniErr: null as { message: string } | null,
  ticket: [] as Record<string, unknown>[],
  ticketErr: null as { message: string } | null,
  sezioniDocente: [] as string[],
  sezioniDiNome: [] as string[],
  // ultimo filtro `in('section_id', …)` applicato alla query alunni
  filtroSezioni: null as string[] | null,
}))

vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
}))
vi.mock('@/lib/sezioni/docenti', () => ({
  nomiSezioniDiUtente: async () => h.sezioniDocente,
  sezioniDiUtente: async () => [],
}))
vi.mock('@/lib/sezioni/risoluzione', () => ({
  sezioniDiNome: async () => h.sezioniDiNome,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = (col: string, val: string[]) => {
        if (table === 'alunni' && col === 'section_id') h.filtroSezioni = val
        return b
      }
      b.order = () => b
      b.limit = () => b
      b.single = async () => ({ data: h.utente, error: null })
      b.maybeSingle = async () => ({ data: h.utente, error: null })
      b.then = (res: (v: unknown) => void) => {
        if (table === 'alunni') return res({ data: h.alunni, error: h.alunniErr })
        if (table === 'ticket_mensa') return res({ data: h.ticket, error: h.ticketErr })
        return res({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/mensa/ticket-residui/route'

const req = (userId: string, qs = '') =>
  new NextRequest(`http://localhost/api/mensa/ticket-residui${qs}`, { headers: { 'x-user-id': userId } })

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { id: SEGRETERIA, nome: 'Sara', cognome: 'Bianchi', ruolo: 'segreteria', role: 'segreteria', scuola_id: 'sc-1' }
  h.alunni = []
  h.alunniErr = null
  h.ticket = []
  h.ticketErr = null
  h.sezioniDocente = []
  h.sezioniDiNome = []
  h.filtroSezioni = null
})

describe('GET /api/mensa/ticket-residui — chi non ha mai ricaricato vale 0, non «assente»', () => {
  it('elenca TUTTI gli iscritti, anche quelli senza riga in ticket_mensa', async () => {
    h.alunni = [
      { id: 'al-1', nome: 'Anna', cognome: 'Rossi', classe_sezione: 'Sezione A', section_id: 'sec-a' },
      { id: 'al-2', nome: 'Bruno', cognome: 'Verdi', classe_sezione: 'Sezione B', section_id: 'sec-b' },
    ]
    // solo al-1 ha ricaricato: al-2 non compare affatto in ticket_mensa
    h.ticket = [{ alunno_id: 'al-1', saldo_ticket: 7, ultimo_carico: '2026-07-26T10:00:00Z' }]

    const res = await GET(req(SEGRETERIA))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.alunni).toHaveLength(2)
    expect(j.data.alunni[0]).toMatchObject({ alunno_id: 'al-1', saldo_ticket: 7 })
    // il bambino senza riga c'è, e vale zero
    expect(j.data.alunni[1]).toMatchObject({ alunno_id: 'al-2', saldo_ticket: 0, ultimo_carico: null })
  })

  it('ordina alfabeticamente per cognome e poi nome (accenti e maiuscole comprese)', async () => {
    h.alunni = [
      { id: 'al-3', nome: 'Zoe', cognome: 'Àbate', classe_sezione: 'Sezione A', section_id: 'sec-a' },
      { id: 'al-2', nome: 'Bruno', cognome: 'rossi', classe_sezione: 'Sezione A', section_id: 'sec-a' },
      { id: 'al-1', nome: 'Anna', cognome: 'Rossi', classe_sezione: 'Sezione A', section_id: 'sec-a' },
    ]
    const j = await (await GET(req(SEGRETERIA))).json()
    expect(j.data.alunni.map((a: { alunno_id: string }) => a.alunno_id)).toEqual(['al-3', 'al-1', 'al-2'])
  })

  it('espone le classi presenti, ordinate, per popolare il filtro', async () => {
    h.alunni = [
      { id: 'al-1', nome: 'Anna', cognome: 'Rossi', classe_sezione: 'Sezione B', section_id: 'sec-b' },
      { id: 'al-2', nome: 'Bruno', cognome: 'Verdi', classe_sezione: 'Sezione A', section_id: 'sec-a' },
      { id: 'al-3', nome: 'Carla', cognome: 'Neri', classe_sezione: null, section_id: null },
    ]
    const j = await (await GET(req(SEGRETERIA))).json()
    expect(j.data.classi).toEqual(['Sezione A', 'Sezione B'])
    // il bambino senza classe resta nell'elenco (5 iscritti reali sono così)
    expect(j.data.alunni).toHaveLength(3)
    expect(j.data.alunni.find((a: { alunno_id: string }) => a.alunno_id === 'al-3').classe).toBeNull()
  })

  it('somma i pasti residui della sede nel totale', async () => {
    h.alunni = [
      { id: 'al-1', nome: 'Anna', cognome: 'Rossi', classe_sezione: 'Sezione A', section_id: 'sec-a' },
      { id: 'al-2', nome: 'Bruno', cognome: 'Verdi', classe_sezione: 'Sezione A', section_id: 'sec-a' },
    ]
    h.ticket = [
      { alunno_id: 'al-1', saldo_ticket: 7, ultimo_carico: null },
      { alunno_id: 'al-2', saldo_ticket: 3, ultimo_carico: null },
    ]
    const j = await (await GET(req(SEGRETERIA))).json()
    expect(j.data.totale_residui).toBe(10)
    expect(j.data.senza_ticket).toBe(0)
  })

  it('conta quanti bambini sono a zero o sotto (chi va sollecitato)', async () => {
    h.alunni = [
      { id: 'al-1', nome: 'Anna', cognome: 'Rossi', classe_sezione: 'Sezione A', section_id: 'sec-a' },
      { id: 'al-2', nome: 'Bruno', cognome: 'Verdi', classe_sezione: 'Sezione A', section_id: 'sec-a' },
      { id: 'al-3', nome: 'Carla', cognome: 'Neri', classe_sezione: 'Sezione A', section_id: 'sec-a' },
    ]
    h.ticket = [
      { alunno_id: 'al-1', saldo_ticket: 7, ultimo_carico: null },
      { alunno_id: 'al-2', saldo_ticket: -2, ultimo_carico: null },
    ]
    const j = await (await GET(req(SEGRETERIA))).json()
    // al-2 (negativo) e al-3 (nessuna riga) sono entrambi «senza pasti disponibili»
    expect(j.data.senza_ticket).toBe(2)
  })
})

describe('GET /api/mensa/ticket-residui — filtro classe', () => {
  it('con ?classe= restringe per section_id (uuid), non per nome', async () => {
    h.sezioniDiNome = ['sec-a']
    h.alunni = [{ id: 'al-1', nome: 'Anna', cognome: 'Rossi', classe_sezione: 'Sezione A', section_id: 'sec-a' }]
    const j = await (await GET(req(SEGRETERIA, '?classe=Sezione%20A'))).json()
    expect(h.filtroSezioni).toEqual(['sec-a'])
    expect(j.data.alunni).toHaveLength(1)
  })

  it('senza ?classe= non applica nessun filtro di sezione', async () => {
    await GET(req(SEGRETERIA))
    expect(h.filtroSezioni).toBeNull()
  })
})

describe('GET /api/mensa/ticket-residui — gate e scoping', () => {
  it('cuoca → 200: è la schermata della cucina', async () => {
    h.utente = { ...h.utente, ruolo: 'cuoca', role: 'cuoca' }
    expect((await GET(req(SEGRETERIA))).status).toBe(200)
  })

  it('genitore → 403: i saldi dei compagni non sono affari suoi', async () => {
    h.utente = { ...h.utente, ruolo: 'genitore', role: 'genitore' }
    expect((await GET(req(SEGRETERIA))).status).toBe(403)
  })

  it('educator senza classe → 400: deve dichiarare la propria sezione', async () => {
    h.utente = { id: EDUCATOR, ruolo: 'educator', role: 'educator', scuola_id: 'sc-1' }
    expect((await GET(req(EDUCATOR))).status).toBe(400)
  })

  it('educator su una classe non sua → 403', async () => {
    h.utente = { id: EDUCATOR, ruolo: 'educator', role: 'educator', scuola_id: 'sc-1' }
    h.sezioniDocente = ['Sezione A']
    expect((await GET(req(EDUCATOR, '?classe=Sezione%20B'))).status).toBe(403)
  })

  it('educator sulla propria classe → 200', async () => {
    h.utente = { id: EDUCATOR, ruolo: 'educator', role: 'educator', scuola_id: 'sc-1' }
    h.sezioniDocente = ['Sezione A']
    h.sezioniDiNome = ['sec-a']
    expect((await GET(req(EDUCATOR, '?classe=Sezione%20A'))).status).toBe(200)
  })
})

describe('GET /api/mensa/ticket-residui — errori che non si travestono da elenco vuoto', () => {
  it('errore sugli alunni → 500, mai un 200 con elenco vuoto', async () => {
    h.alunniErr = { message: 'boom' }
    const res = await GET(req(SEGRETERIA))
    expect(res.status).toBe(500)
  })

  it('errore sui ticket → elenco comunque servito, saldi a 0 (degrado pulito)', async () => {
    // Il DB E2E della CI è un progetto separato e non migrato: la schermata deve
    // restare utile anche se `ticket_mensa` non risponde, dicendo la verità.
    h.alunni = [{ id: 'al-1', nome: 'Anna', cognome: 'Rossi', classe_sezione: 'Sezione A', section_id: 'sec-a' }]
    h.ticketErr = { message: 'PGRST205' }
    const res = await GET(req(SEGRETERIA))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.alunni[0].saldo_ticket).toBe(0)
    // …e lo DICHIARA, invece di far passare «tutti a zero» per un dato reale
    expect(j.data.saldi_non_disponibili).toBe(true)
  })
})
