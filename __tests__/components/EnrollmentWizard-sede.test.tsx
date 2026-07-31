import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  SEDE_A,
  SEDE_B,
  SEDE_C,
  NOME_SEDE_A,
  NOME_SEDE_B,
  NOME_SEDE_C,
} from '../fixtures/sedi'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/**
 * Passo 0 del wizard pubblico: la scelta della SEDE.
 *
 * Da tre plessi in su un link unico non basta più — ma il passo deve comparire
 * SOLO quando serve. La non-regressione (una sola sede, oppure ?scuola= nel link
 * → flusso identico a prima) è la parte più importante di questo file.
 */

vi.mock('framer-motion', async () => {
  const React = await import('react')
  const strip = (props: Record<string, unknown>) => {
    const {
      initial, animate, exit, variants, transition, custom,
      whileHover, whileTap, layout, layoutId, ...rest
    } = props
    void initial; void animate; void exit; void variants; void transition
    void custom; void whileHover; void whileTap; void layout; void layoutId
    return rest
  }
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef(function M(
          { children, ...props }: { children?: React.ReactNode },
          ref: React.Ref<HTMLElement>,
        ) {
          return React.createElement(tag, { ...strip(props), ref }, children)
        }),
    },
  )
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  }
})

import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'


/**
 * Attraversa il passo CONSENSI, che sta fra l'ultimo adulto e il riepilogo.
 *
 * La presa visione dell'informativa è OBBLIGATORIA: senza spuntarla il wizard
 * non avanza — ed è esattamente il comportamento che si vuole, quindi qui va
 * eseguito come lo eseguirebbe un genitore, non aggirato.
 */
async function passaDaiConsensi() {
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
  fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
}

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const BETA = { id: SEDE_B, nome: NOME_SEDE_B }
const GAMMA = { id: SEDE_C, nome: NOME_SEDE_C }

const modelSchema = {
  schema: {
    version: '1',
    pages: [
      {
        id: 'bambino',
        title: 'Dati del bambino',
        fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true, placeholder: 'Nome bimbo' }],
      },
      {
        id: 'adulto',
        title: 'Adulto',
        fields: [{ id: 'first_name', type: 'text', label: 'Nome adulto', required: true, placeholder: 'Nome adulto' }],
      },
    ],
  },
}

const fetchMock = vi.fn()
const postBodies: unknown[] = []

/**
 * `sedi`: elenco restituito da /api/iscrizione/sedi.
 * `null` = la fetch va in eccezione (rete giù); `'http500'` = risposta non-ok.
 */
function mockFetch(sedi: { id: string; nome: string }[] | null | 'http500') {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/iscrizione/model')) {
      return Promise.resolve({ ok: true, json: async () => modelSchema })
    }
    if (url.includes('/api/iscrizione/sedi')) {
      if (sedi === null) return Promise.reject(new Error('rete giù'))
      if (sedi === 'http500') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: sedi }) })
    }
    if (url.includes('/api/iscrizione') && init?.method === 'POST') {
      postBodies.push(JSON.parse(String(init.body)))
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'x' }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  postBodies.length = 0
  vi.stubGlobal('fetch', fetchMock)
})

describe('EnrollmentWizard — passo 0: scelta della sede', () => {
  it('TRE sedi e nessun ?scuola= → il primo passo è la scelta della sede', async () => {
    mockFetch([ALFA, BETA, GAMMA])
    render(<EnrollmentWizard />)

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Kidville Alfa' })).toBeInTheDocument())
    expect(screen.getByRole('radio', { name: 'Kidville Beta' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Kidville Gamma' })).toBeInTheDocument()
    // Non è ancora sui dati del bambino.
    expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()
    // «Indietro» disabilitato = la sede è davvero il PRIMO passo, non uno interposto.
    expect(screen.getByRole('button', { name: /indietro/i })).toBeDisabled()
  })

  it('"Avanti" senza aver scelto la sede → non avanza e lo dice', async () => {
    mockFetch([ALFA, BETA, GAMMA])
    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Kidville Alfa' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))

    expect(await screen.findByText('Scegli una sede per proseguire')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()
  })

  it('sede scelta → si prosegue col bambino e il POST porta lo scuola_id scelto', async () => {
    mockFetch([ALFA, BETA, GAMMA])
    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Kidville Beta' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('radio', { name: 'Kidville Beta' }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())

    // «Indietro» riporta alla sede e la scelta è conservata.
    fireEvent.click(screen.getByRole('button', { name: /indietro/i }))
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Kidville Beta' })).toBeChecked(),
    )
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Tino' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('Nome adulto'), { target: { value: 'Ines' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await passaDaiConsensi()
    await waitFor(() => expect(screen.getByText('Riepilogo')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))
    await waitFor(() => expect(postBodies).toHaveLength(1))
    expect((postBodies[0] as { scuola_id?: string }).scuola_id).toBe(BETA.id)

    // I CONSENSI devono essere NEL PAYLOAD, non solo spuntati sullo schermo.
    // Difetto reale trovato dal percorso end-to-end e non da qui: il wizard
    // raccoglieva le spunte e poi costruiva l'invio con i soli bambini e adulti,
    // buttandole via. Ogni pezzo funzionava, il collegamento no — e il server
    // rifiutava, giustamente, un invio senza presa visione.
    const inviato = postBodies[0] as { data?: Record<string, unknown> }
    expect(inviato.data?.presa_visione_informativa).toBe(true)
    // Anche i consensi NON spuntati viaggiano, come `false`: «non gliel'ho
    // chiesto» e «ha detto no» non sono la stessa cosa nella prova.
    expect(inviato.data?.consenso_foto_galleria).toBe(false)
  })

  /**
   * REGRESSIONE 2026-07-29 — il wizard si congelava sul bambino, in produzione.
   *
   * Col vecchio codice il primo render dipingeva SUBITO il bambino (sedi ancora
   * vuote → nessun passo sede). All'arrivo dell'elenco `steps` cambiava forma, e
   * con essa la `key` dentro `AnimatePresence mode="wait"`: l'uscita del pannello
   * vecchio non si completava mai e il genitore restava inchiodato sul bambino,
   * mentre il contatore dei passi — che sta FUORI dall'animazione — continuava ad
   * avanzare. Con tre sedi vere il modulo pubblico era inutilizzabile.
   *
   * Qui non si può assertare «il pannello cambia»: il mock di framer-motion
   * risolve tutto all'istante e passerebbe anche col bug. Si asserisce invece
   * l'INVARIANTE che rende il difetto impossibile: finché la forma dei passi non
   * è decisa, NESSUN passo viene dipinto.
   */
  it('REGRESSIONE — nessun passo è dipinto finché l\'elenco sedi non è risolto', async () => {
    let sbloccaSedi: (() => void) | null = null
    const attesa = new Promise<void>(r => { sbloccaSedi = r })
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/iscrizione/model')) {
        return Promise.resolve({ ok: true, json: async () => modelSchema })
      }
      if (url.includes('/api/iscrizione/sedi')) {
        return attesa.then(() => ({
          ok: true,
          json: async () => ({ success: true, data: [ALFA, BETA, GAMMA] }),
        }))
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    render(<EnrollmentWizard />)

    // Sedi ancora in volo: né bambino né contatore. Col bug, «Nome bimbo» era già lì.
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()
    expect(screen.queryByText(/Passo \d+ di \d+/)).not.toBeInTheDocument()

    sbloccaSedi!()

    // Risolto l'elenco, la forma è definitiva e il primo passo è la sede.
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Kidville Alfa' })).toBeInTheDocument(),
    )
    expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()
  })

  it('NON-REGRESSIONE — con ?scuola= nel link: nessun passo sede, si parte dal bambino', async () => {
    mockFetch([ALFA, BETA, GAMMA])
    render(<EnrollmentWizard scuolaId={ALFA.id} />)

    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(screen.queryByRole('radio', { name: 'Kidville Beta' })).not.toBeInTheDocument()
    // Il bambino è il PRIMO passo, come prima di questa modifica.
    expect(screen.getByRole('button', { name: /indietro/i })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Tino' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Nome adulto'), { target: { value: 'Ines' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await passaDaiConsensi()
    await waitFor(() => expect(screen.getByText('Riepilogo')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))

    await waitFor(() => expect(postBodies).toHaveLength(1))
    expect((postBodies[0] as { scuola_id?: string }).scuola_id).toBe(ALFA.id)
  })

  it('NON-REGRESSIONE — una sola sede reale: nessun passo sede, comportamento identico a oggi', async () => {
    mockFetch([GAMMA])
    render(<EnrollmentWizard />)

    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /indietro/i })).toBeDisabled()
  })

  it('NON-REGRESSIONE — elenco sedi vuoto (DB E2E della CI): nessun passo sede', async () => {
    mockFetch([])
    render(<EnrollmentWizard />)

    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('DEGRADO — se /api/iscrizione/sedi fallisce, il genitore non resta bloccato', async () => {
    mockFetch(null)
    render(<EnrollmentWizard />)

    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()

    // Il modulo resta compilabile e inviabile: sarà il 400 del server a parlare.
    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Tino' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())
  })

  it('?scuola= VUOTO nel link → vale come assente: si sceglie la sede e il POST la porta', async () => {
    // `/iscrizione?scuola=` produce la stringa vuota, non `null`: se il wizard la
    // trattasse come "sede già decisa", il genitore sceglierebbe un plesso e
    // l'invio partirebbe comunque senza sede.
    mockFetch([ALFA, BETA, GAMMA])
    render(<EnrollmentWizard scuolaId="" />)

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Kidville Alfa' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('radio', { name: 'Kidville Alfa' }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Tino' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Nome adulto'), { target: { value: 'Ines' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await passaDaiConsensi()
    await waitFor(() => expect(screen.getByText('Riepilogo')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))

    await waitFor(() => expect(postBodies).toHaveLength(1))
    expect((postBodies[0] as { scuola_id?: string }).scuola_id).toBe(ALFA.id)
  })

  it('DEGRADO — se /api/iscrizione/sedi risponde 500, il genitore non resta bloccato', async () => {
    // Una risposta non-ok NON è un\'eccezione: se il codice guardasse solo il
    // `catch`, questo caso passerebbe inosservato.
    mockFetch('http500')
    render(<EnrollmentWizard />)

    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('col passo sede in testa, «Aggiungi un altro figlio» apre la pagina del figlio 2', async () => {
    // Gli indici dei passi sono tutti spostati di 1 dalla sede: senza compensazione
    // il bottone porterebbe alla pagina sbagliata (l\'adulto, o il figlio 1).
    mockFetch([ALFA, BETA, GAMMA])
    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Kidville Beta' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('radio', { name: 'Kidville Beta' }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByText('Bambino 1')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /aggiungi un altro figlio/i }))

    await waitFor(() => expect(screen.getByText('Bambino 2')).toBeInTheDocument())
    expect(screen.queryByText('Bambino 1')).not.toBeInTheDocument()
  })

  it('col passo sede in testa, un 400 sull\'ADULTO riporta all\'adulto (non al bambino)', async () => {
    // `mappaErroriServer` calcola il passo dall\'indice del record: con la sede in
    // testa, senza offset manderebbe il genitore sulla pagina sbagliata — e i
    // messaggi d\'errore resterebbero invisibili.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/iscrizione/model')) {
        return Promise.resolve({ ok: true, json: async () => modelSchema })
      }
      if (url.includes('/api/iscrizione/sedi')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [ALFA, BETA, GAMMA] }) })
      }
      if (url.includes('/api/iscrizione') && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            error: 'Alcuni campi non sono validi.',
            campi: { adults: { '0': { first_name: 'Nome adulto rifiutato' } } },
          }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Kidville Beta' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('radio', { name: 'Kidville Beta' }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Tino' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Nome adulto'), { target: { value: 'Ines' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await passaDaiConsensi()
    await waitFor(() => expect(screen.getByText('Riepilogo')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))

    await waitFor(() => expect(screen.getByText('Nome adulto rifiutato')).toBeInTheDocument())
    expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()
  })

  it('accessibilità: ogni sede ha un radio collegato alla propria etichetta', async () => {
    mockFetch([ALFA, GAMMA])
    render(<EnrollmentWizard />)

    const radio = await screen.findByRole('radio', { name: 'Kidville Alfa' })
    expect(radio).toHaveAttribute('type', 'radio')
    // Stesso `name`: le frecce della tastiera scorrono il gruppo.
    const altro = screen.getByRole('radio', { name: 'Kidville Gamma' })
    expect((radio as HTMLInputElement).name).toBe((altro as HTMLInputElement).name)
    fireEvent.click(radio)
    expect((radio as HTMLInputElement).checked).toBe(true)
  })
})
