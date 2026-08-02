import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import { SEDE_A, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi'

/**
 * `/iscrizione` — QUANDO L'ELENCO DELLE SEDI NON ARRIVA.
 *
 * ─── IL DIFETTO, MISURATO IN COLLAUDO (2026-08-02) ──────────────────────────
 * `GET /api/iscrizione/sedi` → **429** («Troppe richieste», tetto 30 ogni 10
 * minuti per IP: dietro il NAT di una scuola o il CGNAT di un operatore mobile
 * lo condividono decine di famiglie). Il wizard registrava il guasto in un log
 * del client e poi proseguiva: `sedi` restava vuoto, e siccome il passo Sede si
 * decideva con `sedi.length > 1`, **un elenco vuoto per errore era
 * indistinguibile da «c'è una sede sola»**. Il modulo si apriva su «Passo 1 di
 * 4 — Bambino 1», senza il passo Sede e senza un avviso.
 *
 * Il genitore compilava tutto — anagrafica del minore, codice fiscale,
 * allergie, note mediche, documento d'identità — e all'invio riceveva il 400
 * «Specificare la scuola per l'iscrizione» dentro un `alert()` di sistema.
 * Lavoro buttato, nessuna spiegazione, e proprio a chi sta iscrivendo un figlio.
 * Nemmeno la guardia di ultima istanza scattava: era condizionata a `mostraSede`,
 * cioè alla stessa variabile falsa.
 *
 * ─── IL CONTRATTO CHE QUESTO FILE DIFENDE ───────────────────────────────────
 * Tre stati DISTINTI, non due: **caricamento**, **elenco non ottenuto**,
 * **elenco ottenuto** (che può essere legittimamente vuoto — è il DB della CI —
 * o di una sola sede). Solo il terzo fa partire il modulo. Il secondo lo DICE e
 * offre di riprovare, perché una domanda che non potrà essere inviata non deve
 * nemmeno cominciare.
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

// Il guasto va anche LOGGATO: «nessun log» non deve distinguere «tutto ok» da
// «l'elenco non è mai arrivato».
const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const GAMMA = { id: SEDE_C, nome: NOME_SEDE_C }
const TRE = [ALFA, { id: 'bbbbbbbb-0000-4000-8000-00000000000b', nome: NOME_SEDE_B }, GAMMA]

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

/** Risposta di `/api/iscrizione/sedi` per il tentativo n-esimo. */
type Risposta =
  | { tipo: 'ok'; sedi: { id: string; nome: string }[] }
  | { tipo: 'corpo-strano' }
  | { tipo: 'http'; stato: number }
  | { tipo: 'rete' }

/** `risposte[i]` = esito dell'i-esimo tentativo; l'ultima vale per tutti i successivi. */
function mockSedi(risposte: Risposta[], postFallisce = false) {
  let tentativo = 0
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/iscrizione/model')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => modelSchema })
    }
    if (url.includes('/api/iscrizione/sedi')) {
      const r = risposte[Math.min(tentativo, risposte.length - 1)]
      tentativo += 1
      if (r.tipo === 'rete') return Promise.reject(new TypeError('Failed to fetch'))
      if (r.tipo === 'http') {
        return Promise.resolve({
          ok: false,
          status: r.stato,
          json: async () => ({ error: 'no' }),
        })
      }
      if (r.tipo === 'corpo-strano') {
        // 200 con un corpo che NON contiene l'elenco: l'elenco non è stato
        // ottenuto, e non va confuso con «non c'è nessuna sede».
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: r.sedi }) })
    }
    if (url.includes('/api/iscrizione') && init?.method === 'POST') {
      postBodies.push(JSON.parse(String(init.body)))
      if (postFallisce) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
      }
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'x' }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

/** Il pannello d'errore c'è, ed è annunciato. */
async function attendiPannelloErrore() {
  await waitFor(() =>
    expect(screen.getByText(itPublic.wizardSediErroreTitolo)).toBeInTheDocument(),
  )
}

/** Nessuna parte della domanda è stata dipinta: non c'è niente da compilare. */
function nienteDaCompilare() {
  expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()
  expect(screen.queryByPlaceholderText('Nome adulto')).not.toBeInTheDocument()
  expect(screen.queryByText(/Passo \d+ di \d+/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /avanti/i })).not.toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
  postBodies.length = 0
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
})

describe('EnrollmentWizard — l\'elenco sedi non arriva', () => {
  it('429 (rate-limit): lo DICE in pagina e non fa cominciare la domanda', async () => {
    mockSedi([{ tipo: 'http', stato: 429 }])
    render(<EnrollmentWizard />)

    await attendiPannelloErrore()
    // Annunciato: chi usa uno screen reader lo sente senza andarlo a cercare.
    expect(screen.getByRole('alert')).toHaveTextContent(itPublic.wizardSediErroreTitolo)
    expect(screen.getByText(itPublic.wizardSediErroreCorpo)).toBeInTheDocument()
    // E si può fare qualcosa: non è un vicolo cieco.
    expect(screen.getByRole('button', { name: itPublic.wizardSediRiprova })).toBeInTheDocument()
    nienteDaCompilare()

    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 429 }),
    )
  })

  it('500: stesso trattamento del 429 — non è una risposta valida, è un guasto', async () => {
    mockSedi([{ tipo: 'http', stato: 500 }])
    render(<EnrollmentWizard />)

    await attendiPannelloErrore()
    nienteDaCompilare()
  })

  it('rete giù (la fetch RIGETTA): il modulo non parte alla cieca', async () => {
    mockSedi([{ tipo: 'rete' }])
    render(<EnrollmentWizard />)

    await attendiPannelloErrore()
    nienteDaCompilare()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', evento: 'fetch' }),
    )
  })

  it('200 con un corpo di forma inattesa: «elenco non ottenuto», non «nessuna sede»', async () => {
    mockSedi([{ tipo: 'corpo-strano' }])
    render(<EnrollmentWizard />)

    await attendiPannelloErrore()
    nienteDaCompilare()
  })

  it('«Riprova» ritenta davvero, e con l\'elenco in mano la domanda riparte dalla SEDE', async () => {
    mockSedi([{ tipo: 'http', stato: 429 }, { tipo: 'ok', sedi: TRE }])
    render(<EnrollmentWizard />)
    await attendiPannelloErrore()

    fireEvent.click(screen.getByRole('button', { name: itPublic.wizardSediRiprova }))

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: NOME_SEDE_A })).toBeInTheDocument(),
    )
    // L'errore sparisce quando è superato: un avviso che resta è un avviso che si impara a ignorare.
    expect(screen.queryByText(itPublic.wizardSediErroreTitolo)).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: NOME_SEDE_C })).toBeInTheDocument()
  })

  it('«Riprova» che fallisce di nuovo: si resta sull\'errore, ancora riprovabile', async () => {
    mockSedi([{ tipo: 'http', stato: 429 }])
    render(<EnrollmentWizard />)
    await attendiPannelloErrore()

    fireEvent.click(screen.getByRole('button', { name: itPublic.wizardSediRiprova }))

    await attendiPannelloErrore()
    nienteDaCompilare()
    expect(screen.getByRole('button', { name: itPublic.wizardSediRiprova })).toBeInTheDocument()
  })

  it('NON-REGRESSIONE — elenco VUOTO ma OTTENUTO (DB della CI): nessun errore, si compila', async () => {
    mockSedi([{ tipo: 'ok', sedi: [] }])
    render(<EnrollmentWizard />)

    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(screen.queryByText(itPublic.wizardSediErroreTitolo)).not.toBeInTheDocument()
  })

  it('NON-REGRESSIONE — una sola sede: nessun errore e nessun passo sede', async () => {
    mockSedi([{ tipo: 'ok', sedi: [GAMMA] }])
    render(<EnrollmentWizard />)

    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(screen.queryByText(itPublic.wizardSediErroreTitolo)).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('NON-REGRESSIONE — con ?scuola= nel link non si chiede nulla a /sedi: nessun errore possibile', async () => {
    mockSedi([{ tipo: 'http', stato: 500 }])
    render(<EnrollmentWizard scuolaId={SEDE_A} />)

    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(screen.queryByText(itPublic.wizardSediErroreTitolo)).not.toBeInTheDocument()
    const chiamate = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(chiamate.some((u) => u.includes('/api/iscrizione/sedi'))).toBe(false)
  })
})

describe('EnrollmentWizard — l\'invio fallisce', () => {
  it('il messaggio è IN PAGINA (niente alert di sistema) e i dati compilati restano', async () => {
    const alertFinto = vi.fn()
    vi.stubGlobal('alert', alertFinto)
    mockSedi([{ tipo: 'ok', sedi: [GAMMA] }], true)
    render(<EnrollmentWizard />)

    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Tino' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Nome adulto'), { target: { value: 'Ines' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByText('Riepilogo')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))

    await waitFor(() => expect(screen.getByText(itPublic.wizardErroreInvio)).toBeInTheDocument())
    expect(screen.getByText(itPublic.wizardErroreInvioDatiSalvi)).toBeInTheDocument()
    // Il pannello nativo del browser non dice cosa fare, non lascia traccia in
    // pagina e nella WebView dell'app è ancora peggio: non deve più comparire.
    expect(alertFinto).not.toHaveBeenCalled()
    // Si può ritentare, e i dati sono ancora quelli.
    expect(screen.getByRole('button', { name: /invia richiesta/i })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /indietro/i }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeChecked(),
    )
    fireEvent.click(screen.getByRole('button', { name: /indietro/i }))
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Nome adulto')).toHaveValue('Ines'),
    )
    fireEvent.click(screen.getByRole('button', { name: /indietro/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toHaveValue('Tino'))
  })
})
