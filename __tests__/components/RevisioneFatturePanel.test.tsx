import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ElencoRevisioneFattureWire,
  FatturaRevisioneWire,
} from '@/lib/pagamenti/revisione-fatture'

const SEDE_A = '11000000-0000-4000-8000-000000000001'
const SEDE_B = '11000000-0000-4000-8000-000000000002'
const USER = '22000000-0000-4000-8000-000000000002'
const USER_B = '22000000-0000-4000-8000-000000000003'
const FATTURA_A = '33000000-0000-4000-8000-000000000003'
const FATTURA_B = '33000000-0000-4000-8000-000000000004'
const PAGAMENTO = '44000000-0000-4000-8000-000000000004'
const PARENT = '55000000-0000-4000-8000-000000000005'

const dipendenze = vi.hoisted(() => ({
  registraEsitoFattura: vi.fn(),
  logClient: vi.fn(),
}))

vi.mock('@/lib/pagamenti/esito-fattura', () => ({
  registraEsitoFattura: dipendenze.registraEsitoFattura,
}))
vi.mock('@/lib/logging/client', () => ({
  logClient: dipendenze.logClient,
  nomeErrore: (errore: unknown) => errore instanceof Error ? errore.name : 'ErroreSconosciuto',
}))
vi.mock('@/components/features/pagamenti/FatturaViewer', () => ({
  FatturaViewer: ({ open, onClose, onEsito, url }: {
    open: boolean
    onClose: () => void
    onEsito?: (esito: 'visualizzata' | 'annullata') => void
    url: string
  }) => open ? (
    <div role="dialog" aria-label="Anteprima fattura test">
      <span>{url}</span>
      <button onClick={() => onEsito?.('visualizzata')}>Segnala visualizzata</button>
      <button onClick={onClose}>Chiudi viewer</button>
    </div>
  ) : null,
}))

import { RevisioneFatturePanel } from '@/components/features/admin/pagamenti/RevisioneFatturePanel'

function riga(extra: Partial<FatturaRevisioneWire> = {}): FatturaRevisioneWire {
  return {
    id: FATTURA_A,
    pagamento_id: PAGAMENTO,
    scuola_id: SEDE_A,
    numero: 1948,
    anno: 2026,
    intestatario: 'Ada Uno',
    sdi_stato: 1,
    ha_pdf: true,
    stato: 'da_verificare',
    definitiva: false,
    parent_registry_id: null,
    verificata_il: null,
    verificata_da: null,
    candidati: [{
      id: PARENT,
      nome: 'Ada',
      cognome: 'Uno',
      codice_fiscale: 'UNOX',
      account_collegato: true,
    }],
    anomalia: null,
    ...extra,
  }
}

function elenco(extra: Partial<ElencoRevisioneFattureWire> = {}): ElencoRevisioneFattureWire {
  return {
    fatture: [riga()],
    pagina: 1,
    per_pagina: 25,
    totale: 1,
    attiva_il: null,
    da_verificare: 1,
    revisionate: 0,
    irrisolte: [],
    ...extra,
  }
}

function risposta(data: ElencoRevisioneFattureWire, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function apri() {
  fireEvent.click(screen.getByRole('button', { name: 'Revisiona visibilità fatture' }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RevisioneFatturePanel', () => {
  it('carica solo all’apertura e salva una scelta ordinaria esplicita', async () => {
    const corpi: unknown[] = []
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        corpi.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ success: true, data: { finalizzata: false } }))
      }
      return risposta(elenco())
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    expect(fetchMock).not.toHaveBeenCalled()
    apri()

    const scheda = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    const modalita = within(scheda).getByRole('combobox', { name: 'Modalità' }) as HTMLSelectElement
    expect(modalita.value).toBe('')
    expect(within(scheda).getByRole('button', { name: 'Salva decisione' })).toBeDisabled()

    fireEvent.change(modalita, { target: { value: 'ordinaria' } })
    fireEvent.click(within(scheda).getByRole('button', { name: 'Salva decisione' }))
    await waitFor(() => expect(corpi).toEqual([{
      azione: 'salva',
      scuola_id: SEDE_A,
      fattura_id: FATTURA_A,
      modalita: 'ordinaria',
      parent_registry_id: null,
    }]))
  })

  it('rende obbligatorio un candidato verificato per quote separate e invia il suo parents.id', async () => {
    const corpi: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        corpi.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ success: true, data: {} }))
      }
      return risposta(elenco())
    }))
    render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()

    const scheda = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    fireEvent.change(within(scheda).getByRole('combobox', { name: 'Modalità' }), {
      target: { value: 'quote_separate' },
    })
    expect(within(scheda).getByText(/UNOX/)).toBeInTheDocument()
    expect(within(scheda).getByRole('button', { name: 'Salva decisione' })).toBeDisabled()

    fireEvent.change(within(scheda).getByRole('combobox', { name: 'Genitore intestatario' }), {
      target: { value: PARENT },
    })
    fireEvent.click(within(scheda).getByRole('button', { name: 'Salva decisione' }))
    await waitFor(() => expect(corpi[0]).toMatchObject({
      modalita: 'quote_separate',
      parent_registry_id: PARENT,
    }))
  })

  it('mantiene la bozza correggibile e rende lo snapshot definitivo in sola lettura', async () => {
    const bozza = riga({ stato: 'quote_separate', parent_registry_id: PARENT })
    const definitiva = riga({
      id: FATTURA_B,
      numero: 1949,
      stato: 'ordinaria',
      definitiva: true,
      parent_registry_id: null,
    })
    vi.stubGlobal('fetch', vi.fn(async () => risposta(elenco({
      fatture: [bozza, definitiva],
      totale: 2,
      da_verificare: 0,
      revisionate: 1,
    }))))
    render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()

    const schedaBozza = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    expect((within(schedaBozza).getByRole('combobox', { name: 'Modalità' }) as HTMLSelectElement).value)
      .toBe('quote_separate')
    expect(within(schedaBozza).getByRole('button', { name: 'Salva decisione' })).toBeEnabled()

    const schedaDefinitiva = screen.getByTestId(`revisione-fattura-${FATTURA_B}`)
    expect(within(schedaDefinitiva).getByText('Decisione definitiva')).toBeInTheDocument()
    expect(within(schedaDefinitiva).queryByRole('button', { name: 'Salva decisione' })).toBeNull()
  })

  it('blocca l’attivazione finché esistono fatture senza decisione', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => risposta(elenco({ da_verificare: 1 }))))
    render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()
    await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)

    expect(screen.getByRole('button', { name: 'Attiva visibilità genitori' })).toBeDisabled()
    expect(screen.getByText('Completa tutte le decisioni prima di attivare.')).toBeInTheDocument()
  })

  it('conferma sull’elenco completo delle irrisolte e su 409 ricarica senza ritentare', async () => {
    const irrisolte = [
      { id: FATTURA_A, numero: 1948, anno: 2026, intestatario: 'Ada Uno' },
      { id: FATTURA_B, numero: 1949, anno: 2026, intestatario: 'Bice Due' },
    ]
    const corpi: unknown[] = []
    let get = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        corpi.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({
          error: 'L’anteprima delle fatture irrisolte è cambiata: ricaricala prima di attivare.',
          codice: 'FATTURA_ANTEPRIMA_CAMBIATA',
        }), { status: 409 })
      }
      get += 1
      return risposta(elenco({
        fatture: [riga({ stato: 'irrisolta' })],
        da_verificare: 0,
        revisionate: 2,
        irrisolte,
      }))
    }))
    render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()
    await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)

    fireEvent.click(screen.getByRole('button', { name: 'Attiva visibilità genitori' }))
    const conferma = screen.getByRole('dialog', { name: 'Conferma attivazione visibilità' })
    expect(within(conferma).getByText(/Ada Uno/)).toBeInTheDocument()
    expect(within(conferma).getByText(/Bice Due/)).toBeInTheDocument()
    expect(within(conferma).getByText(/resteranno accessibili solo allo staff/i)).toBeInTheDocument()

    fireEvent.click(within(conferma).getByRole('button', { name: 'Conferma attivazione' }))
    await waitFor(() => expect(corpi).toEqual([{
      azione: 'attiva',
      scuola_id: SEDE_A,
      irrisolte_previste: [FATTURA_A, FATTURA_B],
    }]))
    await waitFor(() => expect(get).toBe(2))
    expect(screen.getByRole('alert')).toHaveTextContent(/anteprima.*cambiata/i)
    expect(corpi).toHaveLength(1)
  })

  it('scarta la risposta della sede precedente e non mostra righe stale', async () => {
    let risolviA!: (response: Response) => void
    const attesaA = new Promise<Response>((resolve) => { risolviA = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const testo = String(url)
      if (testo.includes(SEDE_A)) return attesaA
      return risposta(elenco({
        fatture: [riga({ id: FATTURA_B, scuola_id: SEDE_B, intestatario: 'Sede B' })],
      }))
    }))
    const vista = render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()
    vista.rerender(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_B} />)

    expect(await screen.findByText('Sede B')).toBeInTheDocument()
    risolviA(risposta(elenco({ fatture: [riga({ intestatario: 'Sede A vecchia' })] })))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('Sede A vecchia')).toBeNull()
  })

  it('in StrictMode completa il nuovo GET quando cambiano utente e sede a pannello aperto', async () => {
    let risolviA!: (response: Response) => void
    const attesaA = new Promise<Response>((resolve) => { risolviA = resolve })
    const richieste: Array<{ url: string; metodo: string; userId: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      richieste.push({
        url: String(url),
        metodo: init?.method ?? 'GET',
        userId: new Headers(init?.headers).get('x-user-id'),
      })
      if (String(url).includes(SEDE_A)) return attesaA
      return risposta(elenco({
        fatture: [riga({ id: FATTURA_B, scuola_id: SEDE_B, intestatario: 'Nuova sede caricata' })],
      }))
    }))

    const vista = render(
      <StrictMode><RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} /></StrictMode>,
    )
    apri()
    await waitFor(() => expect(richieste).toHaveLength(1))

    vista.rerender(
      <StrictMode><RevisioneFatturePanel userId={USER_B} scuolaId={SEDE_B} /></StrictMode>,
    )

    expect(await screen.findByText('Nuova sede caricata')).toBeInTheDocument()
    expect(screen.queryByText('Caricamento fatture…')).toBeNull()
    expect(richieste[0]).toEqual({
      url: expect.stringContaining(SEDE_A),
      metodo: 'GET',
      userId: USER,
    })
    expect(richieste.slice(1).length).toBeGreaterThan(0)
    expect(richieste.slice(1).every((richiesta) => (
      richiesta.url.includes(SEDE_B)
        && richiesta.metodo === 'GET'
        && richiesta.userId === USER_B
    ))).toBe(true)

    risolviA(risposta(elenco({ fatture: [riga({ intestatario: 'Risposta stale' })] })))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('Risposta stale')).toBeNull()
  })

  it('annulla il caricamento pendente quando il pannello viene chiuso', async () => {
    let signal: AbortSignal | null = null
    let risolvi!: (response: Response) => void
    const attesa = new Promise<Response>((resolve) => { risolvi = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal
      return attesa
    }))

    render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()
    await waitFor(() => expect(signal).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi revisione' }))

    await waitFor(() => expect(signal?.aborted).toBe(true))
    risolvi(risposta(elenco({ fatture: [riga({ intestatario: 'Risposta tardiva' })] })))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('Risposta tardiva')).toBeNull()
    expect(screen.getByRole('button', { name: 'Revisiona visibilità fatture' })).toBeInTheDocument()
  })

  it('invalida conferma e viewer al cambio sede senza attivare la nuova sede', async () => {
    const corpi: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        corpi.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ success: true, data: {} }))
      }
      const sedeB = String(url).includes(SEDE_B)
      return risposta(elenco({
        fatture: [riga({
          id: sedeB ? FATTURA_B : FATTURA_A,
          scuola_id: sedeB ? SEDE_B : SEDE_A,
          intestatario: sedeB ? 'Sede B' : 'Sede A',
          stato: 'irrisolta',
        })],
        da_verificare: 0,
        revisionate: 1,
        irrisolte: [{
          id: sedeB ? FATTURA_B : FATTURA_A,
          numero: sedeB ? 1949 : 1948,
          anno: 2026,
          intestatario: sedeB ? 'Sede B' : 'Sede A',
        }],
      }))
    }))

    const vista = render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()
    const schedaA = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    fireEvent.click(within(schedaA).getByRole('button', { name: 'Apri PDF originale' }))
    expect(screen.getByRole('dialog', { name: 'Anteprima fattura test' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Attiva visibilità genitori' }))
    expect(screen.getByRole('dialog', { name: 'Conferma attivazione visibilità' })).toBeInTheDocument()

    vista.rerender(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_B} />)

    expect(screen.queryByRole('dialog', { name: 'Anteprima fattura test' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Conferma attivazione visibilità' })).toBeNull()
    expect(await screen.findByText('Sede B')).toBeInTheDocument()
    expect(corpi).toEqual([])
  })

  it('ignora un vecchio errore POST dopo chiusura e riapertura', async () => {
    let risolviPost!: (response: Response) => void
    let postSignal: AbortSignal | null = null
    const leggiPostSignal = () => postSignal
    const postPendente = new Promise<Response>((resolve) => { risolviPost = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postSignal = init.signal as AbortSignal
        return postPendente
      }
      return risposta(elenco())
    }))

    render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()
    let scheda = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    fireEvent.change(within(scheda).getByRole('combobox', { name: 'Modalità' }), {
      target: { value: 'ordinaria' },
    })
    fireEvent.click(within(scheda).getByRole('button', { name: 'Salva decisione' }))
    await waitFor(() => expect(postSignal).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi revisione' }))
    expect(leggiPostSignal()?.aborted).toBe(true)
    apri()
    scheda = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    expect(within(scheda).getByRole('button', { name: 'Salva decisione' })).toBeDisabled()

    risolviPost(new Response(JSON.stringify({ error: 'Errore vecchio' }), { status: 500 }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(dipendenze.logClient).not.toHaveBeenCalled()
  })

  it('ignora successo e finally di un vecchio POST mentre il nuovo salvataggio è pendente', async () => {
    let risolviPrimo!: (response: Response) => void
    let risolviSecondo!: (response: Response) => void
    const primoPost = new Promise<Response>((resolve) => { risolviPrimo = resolve })
    const secondoPost = new Promise<Response>((resolve) => { risolviSecondo = resolve })
    let post = 0
    let get = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        post += 1
        return post === 1 ? primoPost : secondoPost
      }
      get += 1
      return risposta(elenco())
    }))

    render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()
    let scheda = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    fireEvent.change(within(scheda).getByRole('combobox', { name: 'Modalità' }), {
      target: { value: 'ordinaria' },
    })
    fireEvent.click(within(scheda).getByRole('button', { name: 'Salva decisione' }))
    await waitFor(() => expect(post).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi revisione' }))
    apri()
    scheda = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    fireEvent.change(within(scheda).getByRole('combobox', { name: 'Modalità' }), {
      target: { value: 'irrisolta' },
    })
    fireEvent.click(within(scheda).getByRole('button', { name: 'Salva decisione' }))
    await waitFor(() => expect(post).toBe(2))

    risolviPrimo(new Response(JSON.stringify({ success: true, data: {} })))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(get).toBe(2)
    expect(within(scheda).getByRole('button', { name: 'Salvataggio…' })).toBeDisabled()
    expect((within(scheda).getByRole('combobox', { name: 'Modalità' }) as HTMLSelectElement).value)
      .toBe('irrisolta')

    risolviSecondo(new Response(JSON.stringify({ success: true, data: {} })))
    await waitFor(() => expect(get).toBe(3))
  })

  it('su revisione diventata immutabile mostra errore e ricarica in sola lettura senza ritentare', async () => {
    let get = 0
    let post = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        post += 1
        return new Response(JSON.stringify({
          error: 'La revisione è già definitiva.',
          codice: 'FATTURA_REVISIONE_IMMUTABILE',
        }), { status: 409 })
      }
      get += 1
      return risposta(elenco({
        fatture: [riga(get === 1 ? {} : {
          stato: 'ordinaria',
          definitiva: true,
        })],
        da_verificare: get === 1 ? 1 : 0,
        revisionate: get === 1 ? 0 : 1,
      }))
    }))

    render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()
    let scheda = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    fireEvent.change(within(scheda).getByRole('combobox', { name: 'Modalità' }), {
      target: { value: 'ordinaria' },
    })
    fireEvent.click(within(scheda).getByRole('button', { name: 'Salva decisione' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/non è più modificabile/i)
    await waitFor(() => expect(get).toBe(2))
    scheda = screen.getByTestId(`revisione-fattura-${FATTURA_A}`)
    expect(within(scheda).getByText('Decisione definitiva')).toBeInTheDocument()
    expect(within(scheda).queryByRole('button', { name: 'Salva decisione' })).toBeNull()
    expect(post).toBe(1)
  })

  it('mostra errore e retry, impedisce l’apertura anomala e registra l’esito del viewer', async () => {
    let get = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      get += 1
      if (get === 1) return new Response(JSON.stringify({ error: 'ko' }), { status: 500 })
      return risposta(elenco({
        fatture: [
          riga({ anomalia: 'sede_pagamento_disallineata' }),
          riga({ id: FATTURA_B, numero: 1949, intestatario: 'Bice Due' }),
        ],
        totale: 2,
      }))
    }))
    render(<RevisioneFatturePanel userId={USER} scuolaId={SEDE_A} />)
    apri()
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossibile caricare le fatture.')
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))

    const anomala = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    expect(within(anomala).getByRole('button', { name: 'Apri PDF originale' })).toBeDisabled()
    expect(within(anomala).getByText(/sede del pagamento non coincide/i)).toBeInTheDocument()

    const valida = screen.getByTestId(`revisione-fattura-${FATTURA_B}`)
    fireEvent.click(within(valida).getByRole('button', { name: 'Apri PDF originale' }))
    fireEvent.click(screen.getByRole('button', { name: 'Segnala visualizzata' }))
    expect(dipendenze.registraEsitoFattura).toHaveBeenCalledWith({
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA_B,
      esito: 'visualizzata',
    })
  })
})
