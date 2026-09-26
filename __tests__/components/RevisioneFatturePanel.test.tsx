import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

/** Una sola sede: la pagina l'ha già scelta, il pannello non chiede niente. */
const SOLO_A = [{ id: SEDE_A, nome: 'Kidville Aversa' }]
const SOLO_B = [{ id: SEDE_B, nome: 'Kidville Cesa' }]
/** Più sedi selezionate: la sede su cui lavorare si sceglie DENTRO il pannello. */
const DUE_SEDI = [...SOLO_A, ...SOLO_B]

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

    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
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
    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
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
    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
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
    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
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
    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
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
    const vista = render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
    apri()
    vista.rerender(<RevisioneFatturePanel userId={USER} sedi={SOLO_B} sedeIniziale={SEDE_B} />)

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
      <StrictMode><RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} /></StrictMode>,
    )
    apri()
    await waitFor(() => expect(richieste).toHaveLength(1))

    vista.rerender(
      <StrictMode><RevisioneFatturePanel userId={USER_B} sedi={SOLO_B} sedeIniziale={SEDE_B} /></StrictMode>,
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

    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
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

    const vista = render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
    apri()
    const schedaA = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    fireEvent.click(within(schedaA).getByRole('button', { name: 'Apri PDF originale' }))
    expect(screen.getByRole('dialog', { name: 'Anteprima fattura test' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Attiva visibilità genitori' }))
    expect(screen.getByRole('dialog', { name: 'Conferma attivazione visibilità' })).toBeInTheDocument()

    vista.rerender(<RevisioneFatturePanel userId={USER} sedi={SOLO_B} sedeIniziale={SEDE_B} />)

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

    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
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

    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
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

    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
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
    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
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

/*
 * ─── SELETTORE DI SEDE INTERNO (P6, 2026-09-26) ───────────────────────────────────────────
 *
 * Con più sedi selezionate la pagina passa `scuolaId: null`: la revisione (e soprattutto
 * l'ATTIVAZIONE, che finalizza «per l'intera sede») non può indovinare il plesso. La sede si
 * sceglie dentro il pannello, e TUTTE le chiamate — GET dell'elenco, POST salva, POST attiva —
 * portano quella scelta. Con una sola sede il selettore non c'è.
 */
describe('RevisioneFatturePanel — selettore di sede interno', () => {
  function selettoreSede() {
    return screen.getByRole('combobox', { name: 'Sede' }) as HTMLSelectElement
  }

  it('con UNA sola sede non mostra il selettore e lavora su quella sede', async () => {
    const url: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
      url.push(String(u))
      return risposta(elenco())
    }))
    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
    apri()
    await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)

    expect(screen.queryByRole('combobox', { name: 'Sede' })).toBeNull()
    expect(url).toHaveLength(1)
    expect(new URL(url[0], 'http://x').searchParams.get('scuola_id')).toBe(SEDE_A)
  })

  it('con più sedi e nessuna iniziale NON carica finché non si sceglie; poi GET e POST usano la sede scelta', async () => {
    const get: string[] = []
    const corpi: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        corpi.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ success: true, data: {} }))
      }
      get.push(String(u))
      return risposta(elenco({ fatture: [riga({ id: FATTURA_B, scuola_id: SEDE_B, intestatario: 'Fattura di Cesa' })] }))
    }))
    render(<RevisioneFatturePanel userId={USER} sedi={DUE_SEDI} sedeIniziale={null} />)
    apri()

    // Presenza PRIMA dell'assenza: il messaggio che chiede la sede è a schermo…
    expect(screen.getByText(/Scegli la sede su cui lavorare/)).toBeInTheDocument()
    const sel = selettoreSede()
    expect(sel.value).toBe('')
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual([
      'Scegli la sede', 'Kidville Aversa', 'Kidville Cesa',
    ])
    // …e nessuna GET è partita (né con `scuola_id=null`, né senza).
    expect(get).toEqual([])

    fireEvent.change(sel, { target: { value: SEDE_B } })
    const scheda = await screen.findByTestId(`revisione-fattura-${FATTURA_B}`)
    expect(get).toHaveLength(1)
    expect(new URL(get[0], 'http://x').searchParams.get('scuola_id')).toBe(SEDE_B)
    expect(get[0]).not.toMatch(/null|undefined/)

    fireEvent.change(within(scheda).getByRole('combobox', { name: 'Modalità' }), {
      target: { value: 'ordinaria' },
    })
    fireEvent.click(within(scheda).getByRole('button', { name: 'Salva decisione' }))
    await waitFor(() => expect(corpi).toEqual([{
      azione: 'salva',
      scuola_id: SEDE_B,
      fattura_id: FATTURA_B,
      modalita: 'ordinaria',
      parent_registry_id: null,
    }]))
  })

  it('cambiare sede a pannello aperto ricarica, chiude la conferma, scarta la risposta vecchia e ATTIVA sulla nuova', async () => {
    let risolviA!: (response: Response) => void
    const attesaA = new Promise<Response>((resolve) => { risolviA = resolve })
    const get: string[] = []
    const corpi: unknown[] = []
    let primaA = true
    // Quante volte il pannello ha LETTO il corpo della risposta tardiva di Aversa: il finto ignora
    // l'abort (come un server che ha già risposto), così il ramo «scarta» viene davvero percorso.
    let lettureTardiveA = 0
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        corpi.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ success: true, data: {} }))
      }
      const testo = String(u)
      get.push(testo)
      const sedeB = testo.includes(SEDE_B)
      const corpo = elenco({
        fatture: [riga({
          id: sedeB ? FATTURA_B : FATTURA_A,
          scuola_id: sedeB ? SEDE_B : SEDE_A,
          intestatario: sedeB ? 'Riga di Cesa' : 'Riga di Aversa',
          stato: 'irrisolta',
        })],
        da_verificare: 0,
        revisionate: 1,
        irrisolte: [{ id: sedeB ? FATTURA_B : FATTURA_A, numero: 7, anno: 2026, intestatario: sedeB ? 'Riga di Cesa' : 'Riga di Aversa' }],
      })
      // La SECONDA GET di Aversa resta appesa: è la risposta «vecchia» da scartare.
      if (!sedeB && !primaA) {
        return attesaA.then(() => {
          const tardiva = risposta(corpo)
          const leggi = tardiva.json.bind(tardiva)
          tardiva.json = async () => {
            const letto: unknown = await leggi()
            lettureTardiveA += 1
            return letto
          }
          return tardiva
        })
      }
      primaA = false
      return risposta(corpo)
    }))

    render(<RevisioneFatturePanel userId={USER} sedi={DUE_SEDI} sedeIniziale={SEDE_A} />)
    apri()
    await screen.findByText('Riga di Aversa')
    expect(selettoreSede().value).toBe(SEDE_A)

    // Conferma aperta su Aversa, poi si passa a Cesa: la conferma NON deve sopravvivere.
    fireEvent.click(screen.getByRole('button', { name: 'Attiva visibilità genitori' }))
    const confermaA = screen.getByRole('dialog', { name: 'Conferma attivazione visibilità' })
    expect(within(confermaA).getByText('Sede: Kidville Aversa')).toBeInTheDocument()

    // Con la conferma aperta il resto della pagina è nascosto agli ausili (`hidden: true`): il
    // cambio qui è la difesa, non il percorso normale — ma una conferma nata su Aversa non deve
    // poter partire su Cesa in NESSUN caso.
    const sel = screen.getByRole('combobox', { name: 'Sede', hidden: true }) as HTMLSelectElement
    sel.focus()
    fireEvent.change(sel, { target: { value: SEDE_B } })
    expect(screen.queryByRole('dialog', { name: 'Conferma attivazione visibilità' })).toBeNull()
    expect(await screen.findByText('Riga di Cesa')).toBeInTheDocument()
    expect(screen.queryByText('Riga di Aversa')).toBeNull()
    // Il pannello NON si rimonta: il fuoco resta sul selettore appena usato.
    expect(document.activeElement).toBe(selettoreSede())

    // Torno ad Aversa (GET appesa) e subito di nuovo a Cesa: la risposta tardiva di Aversa si scarta.
    fireEvent.change(selettoreSede(), { target: { value: SEDE_A } })
    fireEvent.change(selettoreSede(), { target: { value: SEDE_B } })
    expect(await screen.findByText('Riga di Cesa')).toBeInTheDocument()
    risolviA(new Response(null))
    // Si aspetta che la risposta tardiva sia stata davvero CONSUMATA dal pannello, poi si svuota la
    // coda: da qui in avanti un `setCaricato` di Aversa sarebbe già avvenuto.
    await waitFor(() => expect(lettureTardiveA).toBe(1))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    // PRESENZA prima dell'assenza: l'elenco di Cesa è ancora a schermo (una risposta tardiva non
    // scartata sovrascriverebbe i dati caricati e lo farebbe sparire).
    expect(screen.getByText('Riga di Cesa')).toBeInTheDocument()
    expect(screen.queryByText('Riga di Aversa')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Attiva visibilità genitori' }))
    const confermaB = screen.getByRole('dialog', { name: 'Conferma attivazione visibilità' })
    expect(within(confermaB).getByText('Sede: Kidville Cesa')).toBeInTheDocument()
    fireEvent.click(within(confermaB).getByRole('button', { name: 'Conferma attivazione' }))
    await waitFor(() => expect(corpi).toEqual([{
      azione: 'attiva',
      scuola_id: SEDE_B,
      irrisolte_previste: [FATTURA_B],
    }]))
    expect(get.every((u) => !/null|undefined/.test(u))).toBe(true)
  })

  it('un salvataggio della sede di prima, fallito DOPO il cambio sede, non mostra il suo errore sotto la nuova', async () => {
    let risolviPost!: (response: Response) => void
    let postSignal: AbortSignal | null = null
    const postPendente = new Promise<Response>((resolve) => { risolviPost = resolve })
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postSignal = init.signal as AbortSignal
        return postPendente
      }
      const sedeB = String(u).includes(SEDE_B)
      return risposta(elenco({
        fatture: [riga(sedeB
          ? { id: FATTURA_B, scuola_id: SEDE_B, intestatario: 'Riga di Cesa' }
          : { intestatario: 'Riga di Aversa' })],
      }))
    }))
    render(<RevisioneFatturePanel userId={USER} sedi={DUE_SEDI} sedeIniziale={SEDE_A} />)
    apri()
    const schedaA = await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    fireEvent.change(within(schedaA).getByRole('combobox', { name: 'Modalità' }), {
      target: { value: 'ordinaria' },
    })
    fireEvent.click(within(schedaA).getByRole('button', { name: 'Salva decisione' }))
    await waitFor(() => expect(postSignal).not.toBeNull())

    fireEvent.change(selettoreSede(), { target: { value: SEDE_B } })
    expect(await screen.findByText('Riga di Cesa')).toBeInTheDocument()
    // Il POST di Aversa è stato annullato al cambio di sede…
    expect((postSignal as AbortSignal | null)?.aborted).toBe(true)

    // …e anche se il server rispondesse comunque con un errore, sotto Cesa non compare niente.
    risolviPost(new Response(JSON.stringify({ error: 'Errore di Aversa' }), { status: 500 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByText('Riga di Cesa')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(dipendenze.logClient).not.toHaveBeenCalled()
  })

  it('con una sola sede la conferma non aggiunge la riga «Sede:» (UI mono-sede invariata)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => risposta(elenco({
      fatture: [riga({ stato: 'irrisolta' })],
      da_verificare: 0,
      revisionate: 1,
    }))))
    render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
    apri()
    await screen.findByTestId(`revisione-fattura-${FATTURA_A}`)
    fireEvent.click(screen.getByRole('button', { name: 'Attiva visibilità genitori' }))
    const conferma = screen.getByRole('dialog', { name: 'Conferma attivazione visibilità' })
    expect(within(conferma).getByText(/L’attivazione finalizza/)).toBeInTheDocument()
    expect(within(conferma).queryByText(/^Sede:/)).toBeNull()
  })

  it('quando la PAGINA cambia sede la scelta interna si riallinea: A, poi B, poi più sedi senza iniziale = nessuna sede indovinata', async () => {
    const get: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
      const testo = String(u)
      get.push(testo)
      const sedeB = testo.includes(SEDE_B)
      return risposta(elenco({
        fatture: [riga(sedeB
          ? { id: FATTURA_B, scuola_id: SEDE_B, intestatario: 'Riga di Cesa' }
          : { intestatario: 'Riga di Aversa' })],
      }))
    }))
    const vista = render(<RevisioneFatturePanel userId={USER} sedi={SOLO_A} sedeIniziale={SEDE_A} />)
    apri()
    expect(await screen.findByText('Riga di Aversa')).toBeInTheDocument()

    // Il cockpit passa a Cesa: il pannello resta aperto e lavora su Cesa.
    vista.rerender(<RevisioneFatturePanel userId={USER} sedi={SOLO_B} sedeIniziale={SEDE_B} />)
    expect(await screen.findByText('Riga di Cesa')).toBeInTheDocument()
    expect(new URL(get.at(-1) ?? '', 'http://x').searchParams.get('scuola_id')).toBe(SEDE_B)

    // Il cockpit seleziona più sedi: la pagina non indica nessuna sede (null).
    const getPrima = get.length
    vista.rerender(<RevisioneFatturePanel userId={USER} sedi={DUE_SEDI} sedeIniziale={null} />)
    // Presenza PRIMA dell'assenza: il pannello chiede la sede…
    expect(screen.getByText(/Scegli la sede su cui lavorare/)).toBeInTheDocument()
    expect(selettoreSede().value).toBe('')
    // …e, svuotata la coda, nessuna GET è partita: né su Aversa (la prima sede vista), né su Cesa.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(get.slice(getPrima)).toEqual([])
    expect(screen.queryByText('Riga di Aversa')).toBeNull()
    expect(screen.queryByText('Riga di Cesa')).toBeNull()
  })

  it('durante l’attivazione il selettore di sede è bloccato, e torna libero a risposta arrivata', async () => {
    let risolviPost!: (response: Response) => void
    const postPendente = new Promise<Response>((resolve) => { risolviPost = resolve })
    const corpi: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        corpi.push(JSON.parse(String(init.body)))
        return postPendente
      }
      return risposta(elenco({
        fatture: [riga({ stato: 'irrisolta', intestatario: 'Riga di Aversa' })],
        da_verificare: 0,
        revisionate: 1,
      }))
    }))
    render(<RevisioneFatturePanel userId={USER} sedi={DUE_SEDI} sedeIniziale={SEDE_A} />)
    apri()
    await screen.findByText('Riga di Aversa')
    expect(selettoreSede()).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Attiva visibilità genitori' }))
    const conferma = screen.getByRole('dialog', { name: 'Conferma attivazione visibilità' })
    fireEvent.click(within(conferma).getByRole('button', { name: 'Conferma attivazione' }))
    await waitFor(() => expect(corpi).toEqual([{
      azione: 'attiva',
      scuola_id: SEDE_A,
      irrisolte_previste: [],
    }]))
    // POST appesa: l'attivazione «per l'intera sede» è in volo, la sede non si può cambiare.
    // (La conferma è ancora aperta: il resto della pagina è nascosto agli ausili, `hidden: true`.)
    const sel = screen.getByRole('combobox', { name: 'Sede', hidden: true })
    expect(sel).toBeDisabled()

    await act(async () => {
      risolviPost(new Response(JSON.stringify({ success: true, data: {} })))
    })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Sede' })).not.toBeDisabled())
  })

  it('senza sedi disponibili lo dice e non chiama il server', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<RevisioneFatturePanel userId={USER} sedi={[]} sedeIniziale={null} />)
    apri()
    expect(screen.getByText('Nessuna sede disponibile.')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
