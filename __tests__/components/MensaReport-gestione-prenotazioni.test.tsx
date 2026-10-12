import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MensaReport } from '@/components/features/admin/mensa/MensaReport'

/**
 * Report cucina con la gestione delle prenotazioni (2026-10-12): la segreteria annulla
 * il pasto di un prenotato (con conferma) e aggiunge un iscritto non prenotato, a
 * qualunque ora. Senza la prop — cuoca, docenti — il report resta com'era, e non chiede
 * nemmeno l'elenco degli iscritti. Fixture FINTE.
 *
 * Le fixture sono costanti di MODULO e il finto `fetch` restituisce sempre gli stessi
 * oggetti: `setReport` con lo stesso riferimento non ri-rende, e il ciclo
 * `load` → effetto (che dipende da `t`, nuovo a ogni render nel mock di next-intl) si ferma.
 */

const report = {
  data: '2026-10-14',
  totale: 1,
  perClasse: [{ classe: 'Girasoli', conteggio: 1, alunni: [{ id: 'a1', nome: 'Bimbo Uno', classe: 'Girasoli', allergeni: [], conflitti: [] }] }],
  allergie: [],
  alternative_automatiche: [],
}
const iscritti = [
  { id: 'a1', nome: 'Bimbo', cognome: 'Uno', classe_sezione: 'Girasoli' },
  { id: 'a2', nome: 'Bimba', cognome: 'Due', classe_sezione: 'Girasoli' },
  { id: 'a3', nome: 'Bimbo', cognome: 'Tre', classe_sezione: 'Tulipani' },
]
const alternative = { success: true, data: { alternative: [] } }
let fetchMock: ReturnType<typeof vi.fn>

const json = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) })
const chiamate = (metodo: string) =>
  fetchMock.mock.calls.filter(c => ((c[1] as RequestInit | undefined)?.method ?? 'GET') === metodo)

beforeEach(() => {
  fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const u = String(input)
    const m = init?.method ?? 'GET'
    if (u.startsWith('/api/mensa/report')) return json({ success: true, data: report })
    if (u.startsWith('/api/mensa/alternative')) return json(alternative)
    if (u.startsWith('/api/admin/students')) return json(iscritti)
    if (u.startsWith('/api/mensa/prenotazioni') && m === 'POST') return json({ success: true, data: { saldo: 3, esiti: [{ data: '2026-10-14', ok: true }] } })
    if (u.startsWith('/api/mensa/prenotazioni') && m === 'DELETE') return json({ success: true, data: { saldo: 5 } })
    return json({ success: false })
  })
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** La card di una classe: la trova dall'intestazione, non da un nome di bambino. */
const card = (classe: string) => screen.getByText(classe, { selector: 'span' }).closest('.kv-admin-rowcard') as HTMLElement

describe('MensaReport — la segreteria aggiunge e annulla dall’elenco del giorno', () => {
  it('senza gestionePrenotazioni (cuoca, docenti) nessun pulsante e nessuna chiamata agli iscritti', async () => {
    render(<MensaReport userId="cuoca-1" scuolaId="s1" />)
    await screen.findByText('Bimbo Uno')
    expect(screen.queryByRole('button', { name: /il pasto di/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Aggiungi un bambino' })).toBeNull()
    expect(fetchMock.mock.calls.some(c => String(c[0]).startsWith('/api/admin/students'))).toBe(false)
  })

  it('chiede solo gli iscritti della sede, con il tetto condiviso', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" gestionePrenotazioni />)
    await screen.findByText('Tulipani')
    const u = fetchMock.mock.calls.map(c => String(c[0])).find(x => x.startsWith('/api/admin/students'))!
    expect(u).toContain('stato=iscritto')
    expect(u).toContain('scuola_id=s1')
    expect(u).toMatch(/limit=\d+/)
  })

  it('compare anche la classe senza prenotati, con 0 pasti', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" gestionePrenotazioni />)
    await screen.findByText('Tulipani')
    expect(within(card('Tulipani')).getByText('0')).toBeTruthy()
  })

  it('«Annulla» chiede conferma e poi manda la DELETE del bambino e del giorno', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" gestionePrenotazioni />)
    fireEvent.click(await screen.findByRole('button', { name: 'Annulla il pasto di Bimbo Uno' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(chiamate('DELETE')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla il pasto' }))
    await waitFor(() => expect(chiamate('DELETE')).toHaveLength(1))
    expect(String(chiamate('DELETE')[0][0])).toMatch(/^\/api\/mensa\/prenotazioni\?userId=seg-1&alunno_id=a1&data=\d{4}-\d{2}-\d{2}$/)
    expect((await screen.findByRole('status')).textContent).toBe('Pasto annullato per Bimbo Uno, ticket restituito. Saldo ticket: 5.')
  })

  it('«Aggiungi un bambino» elenca solo i non prenotati della classe; «Aggiungi» manda la POST', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" gestionePrenotazioni />)
    await screen.findByText('Tulipani')
    const girasoli = card('Girasoli')
    expect(within(girasoli).queryByText('Bimba Due')).toBeNull()
    fireEvent.click(within(girasoli).getByRole('button', { name: 'Aggiungi un bambino' }))
    expect(within(girasoli).getByText('Bimba Due')).toBeTruthy()
    expect(within(girasoli).queryByRole('button', { name: 'Aggiungi il pasto di Bimbo Uno' })).toBeNull()
    expect(within(girasoli).queryByText('Bimbo Tre')).toBeNull()
    fireEvent.click(within(girasoli).getByRole('button', { name: 'Aggiungi il pasto di Bimba Due' }))
    await waitFor(() => expect(chiamate('POST')).toHaveLength(1))
    expect(String(chiamate('POST')[0][0])).toBe('/api/mensa/prenotazioni')
    const body = JSON.parse(String((chiamate('POST')[0][1] as RequestInit).body))
    expect(body.alunno_id).toBe('a2')
    expect(body.date).toHaveLength(1)
    expect((await screen.findByRole('status')).textContent).toBe('Pasto aggiunto per Bimba Due. Saldo ticket: 3.')
  })

  it('il filtro di sezione vale anche per i non prenotati', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" sezione="Girasoli" gestionePrenotazioni />)
    fireEvent.click(await screen.findByRole('button', { name: 'Aggiungi un bambino' }))
    // Una PRESENZA prima dell'assenza: «Bimba Due» c'è solo se gli iscritti sono arrivati.
    expect(await screen.findByText('Bimba Due')).toBeTruthy()
    expect(screen.queryByText('Tulipani')).toBeNull()
    expect(screen.queryByText('Bimbo Tre')).toBeNull()
  })

  it('i pulsanti nuovi hanno un touch target ≥44px', async () => {
    render(<MensaReport userId="seg-1" scuolaId="s1" gestionePrenotazioni />)
    const annulla = await screen.findByRole('button', { name: 'Annulla il pasto di Bimbo Uno' })
    expect(annulla.className).toContain('h-11')
    await screen.findByText('Tulipani')
    const apri = screen.getAllByRole('button', { name: 'Aggiungi un bambino' })
    expect(apri).toHaveLength(2)
    for (const b of apri) expect(b.className).toContain('min-h-[44px]')
  })
})
