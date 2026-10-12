import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { SettimanaMensaStaff } from '@/components/features/admin/mensa/SettimanaMensaStaff'

/**
 * La settimana mensa di un bambino vista dalla SEGRETERIA (2026-10-12): «Aggiungi» e
 * «Annulla» sempre attivi, anche oggi dopo l'orario limite e nei giorni passati —
 * dove il calendario del genitore mostra il lucchetto. Fixture FINTE.
 */

// Mercoledì 14/10/2026, 12:00 a Roma: oltre l'orario limite (09:30) di OGGI, e con
// lunedì e martedì già passati. Per il genitore sarebbero tutti con il lucchetto.
const ADESSO = new Date('2026-10-14T10:00:00Z')
const ALUNNO = { id: 'a1', nome: 'Bimbo', cognome: 'Uno' }

const menu = [
  { data: '2026-10-12', attivo: true, chiuso: false, portate: { primo: 'Pasta' } },
  { data: '2026-10-13', attivo: true, chiuso: false, portate: null },
  { data: '2026-10-14', attivo: true, chiuso: false, portate: { primo: 'Riso' } },
  { data: '2026-10-15', attivo: false, chiuso: true, portate: null, note: 'Gita' },
  { data: '2026-10-17', attivo: false, chiuso: false, portate: null },
]
const prenotazioni = { saldo: 0, prenotazioni: [{ data: '2026-10-12', stato: 'prenotato', origine: 'genitore' }], cutoffOra: '09:30' }
let fetchMock: ReturnType<typeof vi.fn>

const json = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
const metodo = (c: unknown[]) => (c[1] as RequestInit | undefined)?.method ?? 'GET'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ADESSO)
  fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const u = String(input)
    const m = init?.method ?? 'GET'
    if (u.startsWith('/api/mensa/menu')) return json({ success: true, data: menu })
    if (u.startsWith('/api/mensa/prenotazioni') && m === 'GET') return json({ success: true, data: prenotazioni })
    if (m === 'POST') return json({ success: true, data: { saldo: -1, esiti: [{ data: '2026-10-14', ok: true }] } })
    if (m === 'DELETE') return json({ success: true, data: { saldo: 1 } })
    return json({ success: false })
  })
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SettimanaMensaStaff — la segreteria non ha orario limite', () => {
  it('chiede la settimana del bambino, da lunedì a domenica', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    await screen.findAllByRole('button', { name: /^Aggiungi il pasto di/ })
    const urls = fetchMock.mock.calls.map(c => String(c[0]))
    for (const api of ['/api/mensa/menu', '/api/mensa/prenotazioni']) {
      expect(urls.some(u => u.startsWith(api) && u.includes('alunno_id=a1') && u.includes('from=2026-10-12') && u.includes('to=2026-10-18'))).toBe(true)
    }
  })

  it('oggi oltre l’orario e un giorno passato hanno «Aggiungi» ATTIVO; il prenotato ha «Annulla» attivo', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    const aggiungi = await screen.findAllByRole('button', { name: /^Aggiungi il pasto di/ })
    expect(aggiungi).toHaveLength(2) // martedì 13 (passato) e mercoledì 14 (oggi, oltre le 09:30)
    for (const b of aggiungi) expect((b as HTMLButtonElement).disabled).toBe(false)
    const annulla = screen.getAllByRole('button', { name: /^Annulla il pasto di/ })
    expect(annulla).toHaveLength(1)
    expect((annulla[0] as HTMLButtonElement).disabled).toBe(false)
    expect(annulla[0].getAttribute('aria-label')).toBe('Annulla il pasto di Lunedì 12 ottobre')
  })

  it('il giorno di mensa chiusa non ha pulsanti, e il giorno non attivo non compare', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    expect(await screen.findByText(/Mensa chiusa · Gita/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /il pasto di/ })).toHaveLength(3)
    expect(screen.queryByText(/Sabato 17 ottobre/)).toBeNull()
  })

  it('«Aggiungi» manda la POST del giorno giusto e mostra il nuovo saldo', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Aggiungi il pasto di Mercoledì 14 ottobre' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => metodo(c) === 'POST')).toHaveLength(1))
    const post = fetchMock.mock.calls.find(c => metodo(c) === 'POST')!
    expect(String(post[0])).toBe('/api/mensa/prenotazioni')
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ alunno_id: 'a1', date: ['2026-10-14'] })
    expect((await screen.findByRole('status')).textContent).toBe('Pasto aggiunto per Mercoledì 14 ottobre. Saldo ticket: -1.')
  })

  it('«Annulla» chiede conferma: «Lascia com’è» non chiama niente, «Annulla il pasto» manda la DELETE', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Annulla il pasto di/ }))
    expect(screen.getByText('Annullare il pasto di Lunedì 12 ottobre? Il ticket torna sul saldo di Bimbo Uno.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Lascia com’è' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchMock.mock.calls.some(c => metodo(c) === 'DELETE')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /^Annulla il pasto di/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Annulla il pasto' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => metodo(c) === 'DELETE')).toHaveLength(1))
    const del = fetchMock.mock.calls.find(c => metodo(c) === 'DELETE')!
    expect(String(del[0])).toBe('/api/mensa/prenotazioni?userId=seg-1&alunno_id=a1&data=2026-10-12')
    expect((await screen.findByRole('status')).textContent).toBe('Pasto annullato per Lunedì 12 ottobre, ticket restituito. Saldo ticket: 1.')
  })

  it('un rifiuto del server si mostra con il suo motivo', async () => {
    fetchMock.mockImplementation((input: unknown, init?: RequestInit) => {
      const u = String(input)
      const m = init?.method ?? 'GET'
      if (u.startsWith('/api/mensa/menu')) return json({ success: true, data: menu })
      if (m === 'GET') return json({ success: true, data: prenotazioni })
      return json({ success: true, data: { saldo: 0, esiti: [{ data: '2026-10-13', ok: false, motivo: 'Giorno non attivo o mensa chiusa' }] } })
    })
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Aggiungi il pasto di Martedì 13 ottobre' }))
    expect((await screen.findByRole('status')).textContent).toBe('Giorno non attivo o mensa chiusa')
  })

  it('con saldo a zero avvisa che aggiungendo si va in negativo', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    expect(await screen.findByText(/il saldo andrà in negativo/)).toBeTruthy()
  })

  it('◀ porta alla settimana prima', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    await screen.findAllByRole('button', { name: /^Aggiungi il pasto di/ })
    fireEvent.click(screen.getByRole('button', { name: 'Settimana precedente' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(c => String(c[0]).includes('from=2026-10-05') && String(c[0]).includes('to=2026-10-11'))).toBe(true))
  })

  it('i pulsanti hanno un touch target ≥44px', async () => {
    render(<SettimanaMensaStaff userId="seg-1" alunno={ALUNNO} />)
    for (const b of await screen.findAllByRole('button', { name: /il pasto di/ })) expect(b.className).toContain('min-h-[44px]')
    expect(screen.getByRole('button', { name: 'Settimana precedente' }).className).toContain('h-11')
  })
})
