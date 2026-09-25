import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import { SEDE_A } from '../fixtures/sedi'
import catalogoIt from '../../messages/it/shared.json'

// =============================================================================
// O1 — Obiettivi della primaria: «Modifica» accanto ad «Aggiungi» ed «Elimina».
//
// Prima un obiettivo scritto male si correggeva solo eliminandolo e
// riscrivendolo da capo. Qui si misura ciò che l'utente fa e vede: la riga che
// diventa modificabile con i valori attuali, la PATCH con il corpo giusto (id,
// codice ripulito, descrizione), l'elenco ricaricato col testo nuovo; e sul
// rifiuto l'avviso che nomina la riga, con il testo modificato ancora nei campi.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import { ObiettiviManager } from '@/components/features/admin/primaria/ObiettiviManager'

const UTENTE = '11111111-1111-4111-8111-111111111111'
const OB_1 = '66666666-1111-4111-8111-aaaaaaaaaaaa'
const OB_2 = '66666666-2222-4222-8222-bbbbbbbbbbbb'

const risposta = (stato: number, corpo: unknown) => ({
  ok: stato >= 200 && stato < 300,
  status: stato,
  json: async () => corpo,
})

const fetchMock = vi.fn()
let elenco: Record<string, unknown>[] = []

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  elenco = [
    { id: OB_1, materia_codice: 'italiano', livello: 1, codice: 'ITA-1', descrizione: 'Ascolta e comprende', attivo: true },
    { id: OB_2, materia_codice: 'italiano', livello: 1, codice: null, descrizione: 'Scrive frasi semplici', attivo: true },
  ]
})

const patchChiamate = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')

const rigaDi = (testo: string) => screen.getByText(testo).closest('li') as HTMLElement

describe('ObiettiviManager · modifica in riga', () => {
  it('Modifica → campi precompilati → Salva: PATCH con id, codice e descrizione, e l\'elenco mostra il testo nuovo', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const b = JSON.parse(String(init.body))
        elenco = elenco.map((o) => (o.id === b.id ? { ...o, codice: b.codice, descrizione: b.descrizione } : o))
        return Promise.resolve(risposta(200, { success: true, data: elenco.find((o) => o.id === b.id) }))
      }
      return Promise.resolve(risposta(200, { success: true, data: elenco }))
    })

    render(<ObiettiviManager scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Scrive frasi semplici')

    fireEvent.click(within(rigaDi('Scrive frasi semplici')).getByLabelText('Modifica obiettivo'))

    const descrizione = screen.getByLabelText('Descrizione obiettivo') as HTMLInputElement
    const codice = screen.getByLabelText('Codice (opz.)') as HTMLInputElement
    expect(descrizione.value).toBe('Scrive frasi semplici')
    expect(codice.value).toBe('')

    fireEvent.change(codice, { target: { value: ' ITA-2 ' } })
    fireEvent.change(descrizione, { target: { value: 'Scrive frasi corrette' } })
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }))

    await screen.findByText('Scrive frasi corrette')
    const chiamate = patchChiamate()
    expect(chiamate).toHaveLength(1)
    const [url, init] = chiamate[0] as [string, RequestInit]
    expect(url).toContain('/api/admin/primaria/obiettivi')
    expect(JSON.parse(String(init.body))).toEqual({ id: OB_2, codice: 'ITA-2', descrizione: 'Scrive frasi corrette' })

    // La riga è tornata in sola lettura, e l'altra non è stata toccata.
    expect(screen.queryByLabelText('Descrizione obiettivo')).toBeNull()
    expect(screen.getByText('ITA-2')).toBeInTheDocument()
    expect(screen.getByText('Ascolta e comprende')).toBeInTheDocument()
  })

  it('codice svuotato ⇒ nel corpo va null, non la stringa vuota', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.resolve(risposta(200, { success: true, data: {} }))
      return Promise.resolve(risposta(200, { success: true, data: elenco }))
    })

    render(<ObiettiviManager scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Ascolta e comprende')
    fireEvent.click(within(rigaDi('Ascolta e comprende')).getByLabelText('Modifica obiettivo'))
    fireEvent.change(screen.getByLabelText('Codice (opz.)'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }))

    await waitFor(() => expect(patchChiamate()).toHaveLength(1))
    const [, init] = patchChiamate()[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ id: OB_1, codice: null, descrizione: 'Ascolta e comprende' })
  })

  it('rifiuto del server: l\'avviso nomina la riga e il testo modificato resta nei campi', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.resolve(risposta(403, { error: 'Sede non accessibile' }))
      return Promise.resolve(risposta(200, { success: true, data: elenco }))
    })

    render(<ObiettiviManager scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Ascolta e comprende')
    fireEvent.click(within(rigaDi('Ascolta e comprende')).getByLabelText('Modifica obiettivo'))
    fireEvent.change(screen.getByLabelText('Descrizione obiettivo'), { target: { value: 'Testo lungo riscritto' } })
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain('ITA-1')
    expect((screen.getByLabelText('Descrizione obiettivo') as HTMLInputElement).value).toBe('Testo lungo riscritto')
  })

  it('Annulla chiude la modifica senza scrivere', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(risposta(200, { success: true, data: elenco })))

    render(<ObiettiviManager scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Ascolta e comprende')
    fireEvent.click(within(rigaDi('Ascolta e comprende')).getByLabelText('Modifica obiettivo'))
    fireEvent.change(screen.getByLabelText('Descrizione obiettivo'), { target: { value: 'Da buttare' } })
    fireEvent.click(screen.getByRole('button', { name: /Annulla/ }))

    expect(screen.queryByLabelText('Descrizione obiettivo')).toBeNull()
    expect(screen.getByText('Ascolta e comprende')).toBeInTheDocument()
    expect(patchChiamate()).toHaveLength(0)
  })

  it('descrizione vuota: Salva è disabilitato e nessuna PATCH parte, nemmeno con Invio', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(risposta(200, { success: true, data: elenco })))

    render(<ObiettiviManager scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Ascolta e comprende')
    fireEvent.click(within(rigaDi('Ascolta e comprende')).getByLabelText('Modifica obiettivo'))
    const descrizione = screen.getByLabelText('Descrizione obiettivo')
    fireEvent.change(descrizione, { target: { value: '   ' } })

    expect(screen.getByRole('button', { name: /Salva/ })).toBeDisabled()
    fireEvent.keyDown(descrizione, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }))
    expect(patchChiamate()).toHaveLength(0)
  })

  it('Invio nella descrizione con un testo valido: UNA PATCH col corpo atteso, e la riga torna in sola lettura', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const b = JSON.parse(String(init.body))
        elenco = elenco.map((o) => (o.id === b.id ? { ...o, codice: b.codice, descrizione: b.descrizione } : o))
        return Promise.resolve(risposta(200, { success: true, data: elenco.find((o) => o.id === b.id) }))
      }
      return Promise.resolve(risposta(200, { success: true, data: elenco }))
    })

    render(<ObiettiviManager scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Ascolta e comprende')
    fireEvent.click(within(rigaDi('Ascolta e comprende')).getByLabelText('Modifica obiettivo'))
    const descrizione = screen.getByLabelText('Descrizione obiettivo')
    fireEvent.change(descrizione, { target: { value: 'Ascolta e riassume' } })
    fireEvent.keyDown(descrizione, { key: 'Enter' })

    // Presenza del testo nuovo in SOLA LETTURA (in modifica sta nel value di un input, non nel testo).
    await screen.findByText('Ascolta e riassume')
    expect(patchChiamate()).toHaveLength(1)
    const [, init] = patchChiamate()[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ id: OB_1, codice: 'ITA-1', descrizione: 'Ascolta e riassume' })
    expect(screen.queryByLabelText('Descrizione obiettivo')).toBeNull()
  })

  it('Invio anche dal campo codice salva la riga', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.resolve(risposta(200, { success: true, data: {} }))
      return Promise.resolve(risposta(200, { success: true, data: elenco }))
    })

    render(<ObiettiviManager scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Ascolta e comprende')
    fireEvent.click(within(rigaDi('Ascolta e comprende')).getByLabelText('Modifica obiettivo'))
    const codice = screen.getByLabelText('Codice (opz.)')
    fireEvent.change(codice, { target: { value: 'ITA-7' } })
    fireEvent.keyDown(codice, { key: 'Enter' })

    await waitFor(() => expect(patchChiamate()).toHaveLength(1))
    const [, init] = patchChiamate()[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ id: OB_1, codice: 'ITA-7', descrizione: 'Ascolta e comprende' })
  })

  it.each([
    ['descrizione', 'Descrizione obiettivo'],
    ['codice', 'Codice (opz.)'],
  ])('Esc dal campo %s chiude la modifica senza PATCH', async (_nome, etichetta) => {
    fetchMock.mockImplementation(() => Promise.resolve(risposta(200, { success: true, data: elenco })))

    render(<ObiettiviManager scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Ascolta e comprende')
    fireEvent.click(within(rigaDi('Ascolta e comprende')).getByLabelText('Modifica obiettivo'))
    const campo = screen.getByLabelText(etichetta)
    fireEvent.change(campo, { target: { value: 'Da buttare' } })
    fireEvent.keyDown(campo, { key: 'Escape' })

    // Il testo originale torna come TESTO della riga: la riga è di nuovo in sola lettura.
    expect(screen.getByText('Ascolta e comprende')).toBeInTheDocument()
    expect(screen.queryByLabelText('Descrizione obiettivo')).toBeNull()
    expect(patchChiamate()).toHaveLength(0)
  })

  it.each([
    ['materia', 0, 'matematica', 'italiano'],
    ['livello', 1, '2', '1'],
  ])('cambiare %s chiude la modifica aperta (tornando indietro la riga è in sola lettura)', async (_nome, indice, altro, originale) => {
    fetchMock.mockImplementation((url: string) => {
      const q = new URL(url, 'http://localhost').searchParams
      const altroElenco = q.get('materiaCodice') !== 'italiano' || q.get('livello') !== '1'
      const data = altroElenco
        ? [{ id: '66666666-3333-4333-8333-cccccccccccc', materia_codice: 'x', livello: 2, codice: null, descrizione: 'Elenco di un altro filtro', attivo: true }]
        : elenco
      return Promise.resolve(risposta(200, { success: true, data }))
    })

    render(<ObiettiviManager scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Ascolta e comprende')
    fireEvent.click(within(rigaDi('Ascolta e comprende')).getByLabelText('Modifica obiettivo'))
    expect(screen.getByLabelText('Descrizione obiettivo')).toBeInTheDocument()

    const select = screen.getAllByRole('combobox')[indice]
    fireEvent.change(select, { target: { value: altro } })
    await screen.findByText('Elenco di un altro filtro')
    fireEvent.change(select, { target: { value: originale } })

    // Si aspetta una PRESENZA: il testo della riga come testo, che c'è solo in sola lettura.
    await screen.findByText('Ascolta e comprende')
    expect(screen.queryByLabelText('Descrizione obiettivo')).toBeNull()
    expect(patchChiamate()).toHaveLength(0)
  })

  it('409 OBIETTIVO_CODICE_DUPLICATO: l\'avviso usa la frase tradotta, non la prosa di Postgres, e i campi restano compilati', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(
          risposta(409, {
            error: 'duplicate key value violates unique constraint "obiettivi_apprendimento_scuola_id_materia_codice_livello_co_key"',
            codice: 'OBIETTIVO_CODICE_DUPLICATO',
          }),
        )
      }
      return Promise.resolve(risposta(200, { success: true, data: elenco }))
    })

    render(<ObiettiviManager scuolaId={SEDE_A} userId={UTENTE} />)
    await screen.findByText('Scrive frasi semplici')
    fireEvent.click(within(rigaDi('Scrive frasi semplici')).getByLabelText('Modifica obiettivo'))
    fireEvent.change(screen.getByLabelText('Codice (opz.)'), { target: { value: 'ITA-1' } })
    fireEvent.change(screen.getByLabelText('Descrizione obiettivo'), { target: { value: 'Scrive frasi lunghe' } })
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain(catalogoIt.erroreObiettivoCodiceDuplicato)
    expect(avviso.textContent).not.toMatch(/duplicate key|constraint/)
    expect((screen.getByLabelText('Codice (opz.)') as HTMLInputElement).value).toBe('ITA-1')
    expect((screen.getByLabelText('Descrizione obiettivo') as HTMLInputElement).value).toBe('Scrive frasi lunghe')
  })
})
