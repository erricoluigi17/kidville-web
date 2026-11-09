import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itAnno from '../../messages/it/annoListino.json'
import { AnnoConfigurazione } from '@/components/features/admin/settings/AnnoConfigurazione'

// =============================================================================
// PR 4.6 · compito 4.6.5 · LA SCHEDA «RETTE» dell'anno che si prepara.
// La segreteria scrive qui l'importo mensile (per fascia o per tutte) e i mesi in cui si genera. Le regole stanno nel
// database (`anno_listino_retta_imposta`) e nella route; qui si prova che la schermata DICA cosa vale (mesi veri dal
// database, la frase sulle fasce, la nota sul 150) e che mandi alla route ciò che la segreteria ha scelto, niente di più.
// Solo uuid finti e importi inventati.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'errore-di-rete' }))

const ANNO = '44444444-4444-4444-8444-444444444441'
const USER = '11111111-1111-4111-8111-111111111111'
const DIECI = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6]

type Lettura = { rette?: unknown[]; mesi?: number[]; fasce?: string[] }
const fetchMock = vi.fn()
let lettura: Lettura
let rispostaPut: { status: number; body: unknown }

const risposta = (r: { status: number; body: unknown }) => Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body })

beforeEach(() => {
  vi.clearAllMocks()
  lettura = {}
  rispostaPut = { status: 200, body: { success: true, data: { cambiato: true } } }
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const metodo = init?.method ?? 'GET'
    if (metodo === 'GET' && String(url).endsWith('/rette')) {
      return risposta({
        status: 200,
        body: { success: true, data: { rette: lettura.rette ?? [], mesi_effettivi: { retta: lettura.mesi ?? DIECI, servizio: DIECI }, fasce_in_uso: lettura.fasce ?? [] } },
      })
    }
    if (metodo === 'GET') return risposta({ status: 200, body: { success: true, data: { quote: [], moduli: [], posti: [], sezioni: [] } } })
    return risposta(rispostaPut)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')
const corpoPut = () => JSON.parse(String(puts()[puts().length - 1][1].body)) as Record<string, unknown>

async function apriRette() {
  render(<AnnoConfigurazione userId={USER} annoSedeId={ANNO} stato="in_preparazione" onCambiata={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: itAnno.schedaRette }))
  return screen.findByRole('group', { name: itAnno.retteTitolo })
}
const campoImporto = (g: HTMLElement) => within(g).getByLabelText(itAnno.etichettaImporto) as HTMLInputElement

describe('scheda Rette', () => {
  it('parte vuota: nessun importo predefinito, e i dieci mesi sono quelli che dice il database', async () => {
    const g = await apriRette()
    expect(campoImporto(g).value).toBe('')
    const spuntati = within(g).getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked)
    expect(spuntati).toHaveLength(10)
    expect(within(g).getByRole('checkbox', { name: /luglio/i })).not.toBeChecked()
    expect(within(g).getByRole('checkbox', { name: /settembre/i })).toBeChecked()
    expect(within(g).getByText(itAnno.retteNessuna)).toBeInTheDocument()
  })

  it('se i mesi del database sono altri, la scheda mostra quelli', async () => {
    lettura = { mesi: [9, 10, 11] }
    const g = await apriRette()
    expect(within(g).getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked)).toHaveLength(3)
    expect(within(g).getByRole('checkbox', { name: /giugno/i })).not.toBeChecked()
  })

  it('finché le sezioni non hanno una fascia lo dice; con una fascia in uso tace', async () => {
    const g = await apriRette()
    expect(within(g).getByText(itAnno.retteSenzaFasce)).toBeInTheDocument()
  })

  it('con una fascia in uso la frase sparisce', async () => {
    lettura = { fasce: ['infanzia'] }
    const g = await apriRette()
    expect(within(g).queryByText(itAnno.retteSenzaFasce)).toBeNull()
  })

  it('un importo di 150 è un’informazione neutra («controllalo»), non un errore; un altro importo no', async () => {
    lettura = { rette: [{ voce: 'retta', fascia: null, payment_category_id: null, importo: 150, mesi: null }] }
    const g = await apriRette()
    expect(within(g).getByText(itAnno.retteCopiata)).toBeInTheDocument()
    expect(within(g).queryByRole('alert')).toBeNull()
  })

  it('un importo diverso da 150 non porta la nota', async () => {
    lettura = { rette: [{ voce: 'retta', fascia: null, payment_category_id: null, importo: 275, mesi: null }] }
    const g = await apriRette()
    expect(within(g).queryByText(itAnno.retteCopiata)).toBeNull()
  })

  it('un importo non valido si rifiuta senza chiamare il server, e la bozza resta', async () => {
    const g = await apriRette()
    fireEvent.change(campoImporto(g), { target: { value: '0' } })
    fireEvent.click(within(g).getByRole('button', { name: itAnno.salva }))
    expect(await within(g).findByRole('alert')).toHaveTextContent(itAnno.importoNonValido)
    expect(campoImporto(g).value).toBe('0')
    expect(puts()).toHaveLength(0)
  })

  it('salva un NUMERO (la virgola vale il punto) senza toccare i mesi se non sono cambiati', async () => {
    const g = await apriRette()
    fireEvent.change(campoImporto(g), { target: { value: '312,50' } })
    fireEvent.click(within(g).getByRole('button', { name: itAnno.salva }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(String(puts()[0][0])).toBe(`/api/admin/anni/${ANNO}/rette`)
    expect(corpoPut()).toEqual({ voce: 'retta', fascia: null, importo: 312.5 })
    expect(await screen.findByText(itAnno.retteSalvata)).toBeInTheDocument()
  })

  it('se si cambiano i mesi, li manda ordinati', async () => {
    const g = await apriRette()
    fireEvent.click(within(g).getByRole('checkbox', { name: /giugno/i }))
    fireEvent.click(within(g).getByRole('checkbox', { name: /luglio/i }))
    fireEvent.change(campoImporto(g), { target: { value: '200' } })
    fireEvent.click(within(g).getByRole('button', { name: itAnno.salva }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(corpoPut()).toEqual({ voce: 'retta', fascia: null, importo: 200, mesi: [1, 2, 3, 4, 5, 7, 9, 10, 11, 12] })
  })

  it('senza nessun mese spuntato non chiama il server', async () => {
    const g = await apriRette()
    for (const c of within(g).getAllByRole('checkbox')) if ((c as HTMLInputElement).checked) fireEvent.click(c)
    fireEvent.change(campoImporto(g), { target: { value: '200' } })
    fireEvent.click(within(g).getByRole('button', { name: itAnno.salva }))
    expect(await within(g).findByRole('alert')).toHaveTextContent(itAnno.retteMesiVuoti)
    expect(puts()).toHaveLength(0)
  })

  it('per una fascia i mesi non si scelgono e non si mandano', async () => {
    const g = await apriRette()
    fireEvent.change(within(g).getByLabelText(itAnno.etichettaFascia), { target: { value: 'infanzia' } })
    expect(within(g).queryAllByRole('checkbox')).toHaveLength(0)
    fireEvent.change(campoImporto(g), { target: { value: '280' } })
    fireEvent.click(within(g).getByRole('button', { name: itAnno.salva }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(corpoPut()).toEqual({ voce: 'retta', fascia: 'infanzia', importo: 280 })
  })

  it('togliere una riga manda importo null per quella fascia', async () => {
    lettura = { rette: [{ voce: 'retta', fascia: 'nido_1', payment_category_id: null, importo: 400, mesi: null }] }
    const g = await apriRette()
    fireEvent.click(within(g).getByRole('button', { name: itAnno.togli }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(corpoPut()).toEqual({ voce: 'retta', fascia: 'nido_1', importo: null })
    expect(await screen.findByText(itAnno.retteTolta)).toBeInTheDocument()
  })

  it('un rifiuto del database si dice con le sue parole e non cancella la bozza', async () => {
    rispostaPut = { status: 409, body: { error: 'Questo anno scolastico non si può più modificare da qui.', codice: 'ANNO_NON_MODIFICABILE' } }
    const g = await apriRette()
    fireEvent.change(campoImporto(g), { target: { value: '200' } })
    fireEvent.click(within(g).getByRole('button', { name: itAnno.salva }))
    expect(await within(g).findByRole('alert')).toHaveTextContent('Questo anno scolastico non si può più modificare da qui.')
    expect(campoImporto(g).value).toBe('200')
  })

  it('la scheda delle quote non mostra più le righe di retta e servizio', async () => {
    render(<AnnoConfigurazione userId={USER} annoSedeId={ANNO} stato="in_preparazione" onCambiata={() => {}} />)
    await screen.findByRole('group', { name: itAnno.quotaConfermaTitolo })
    expect(screen.queryByText('Rette e servizi')).toBeNull()
  })
})
