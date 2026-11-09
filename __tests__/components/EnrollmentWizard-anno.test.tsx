import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

/**
 * Compito 4.5.7 · il passo «anno» del modulo pubblico.
 *
 * Una volta nota la sede, il wizard chiede a `/api/iscrizione/anni` quali anni accettano domande:
 *  · due o più → un passo in più, dove la famiglia sceglie;
 *  · uno solo, o la lettura fallita, o il database in ritardo (E2E) → NESSUNA domanda in più, e il modulo si
 *    comporta come prima (il POST porta l'unico anno, o nessuno);
 *  · `chiuso` → lo si dice prima di far compilare.
 * Uuid e dati finti.
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

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { EnrollmentWizard } from '@/components/features/public/EnrollmentWizard'

const A_CORR = { anno_id: 'a2222222-2222-4222-8222-222222222222', etichetta_breve: '2026/27', ingresso: 'durante' as const }
const A_PROSS = { anno_id: 'a3333333-3333-4333-8333-333333333333', etichetta_breve: '2027/28', ingresso: 'inizio' as const }

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

type RispostaAnni =
  | { tipo: 'ok'; anni: unknown[]; scelta: boolean; chiuso?: boolean }
  | { tipo: 'http'; stato: number }
  | { tipo: 'rete' }
  | { tipo: 'corpo-strano' }

type Post = { stato: number; corpo: unknown }

const fetchMock = vi.fn()
const postBodies: Record<string, unknown>[] = []
let chiamateAnni: string[] = []

function mockFetch(opts: {
  sedi?: { id: string; nome: string }[]
  anni: RispostaAnni
  post?: Post
}) {
  const sedi = opts.sedi ?? [{ id: SEDE_A, nome: NOME_SEDE_A }]
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/iscrizione/model')) return Promise.resolve({ ok: true, json: async () => modelSchema })
    if (url.includes('/api/iscrizione/sedi')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: sedi }) })
    }
    if (url.includes('/api/iscrizione/anni')) {
      chiamateAnni.push(url)
      const r = opts.anni
      if (r.tipo === 'rete') return Promise.reject(new TypeError('Failed to fetch'))
      if (r.tipo === 'http') return Promise.resolve({ ok: false, status: r.stato, json: async () => ({ error: 'no' }) })
      if (r.tipo === 'corpo-strano') return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { anni: r.anni, scelta: r.scelta, chiuso: r.chiuso ?? false } }),
      })
    }
    if (url.includes('/api/iscrizione') && init?.method === 'POST') {
      postBodies.push(JSON.parse(String(init.body)))
      const p = opts.post ?? { stato: 201, corpo: { id: 'x' } }
      return Promise.resolve({ ok: p.stato < 400, status: p.stato, json: async () => p.corpo })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

async function passaDaiConsensi() {
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
  fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
}

/** Dal passo «bambino» fino al riepilogo, compilando il minimo. */
async function compilaFinoAlRiepilogo() {
  await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Tino' } })
  fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
  await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Nome adulto'), { target: { value: 'Ines' } })
  fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
  await passaDaiConsensi()
  await waitFor(() => expect(screen.getByText('Riepilogo')).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  postBodies.length = 0
  chiamateAnni = []
  vi.stubGlobal('fetch', fetchMock)
})

describe('EnrollmentWizard · il passo anno', () => {
  it('DUE anni offerti: il primo passo è la scelta dell\'anno, con le due righe', async () => {
    mockFetch({ anni: { tipo: 'ok', anni: [A_CORR, A_PROSS], scelta: true } })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)

    await waitFor(() => expect(screen.getByRole('radio', { name: /2026\/27/ })).toBeInTheDocument())
    expect(screen.getByRole('radio', { name: /2027\/28/ })).toBeInTheDocument()
    expect(screen.getByText('Entra subito, durante l’anno in corso')).toBeInTheDocument()
    expect(screen.getByText('Entra a inizio anno')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()
    // Cinque passi: anno, bambino, adulto, consensi, riepilogo.
    expect(screen.getByText('Passo 1 di 5')).toBeInTheDocument()
    expect(chiamateAnni).toHaveLength(1)
    expect(chiamateAnni[0]).toContain(`scuola_id=${SEDE_A}`)
  })

  it('«Avanti» senza aver scelto l\'anno non avanza e lo dice; scelto l\'anno, il POST lo porta', async () => {
    mockFetch({ anni: { tipo: 'ok', anni: [A_CORR, A_PROSS], scelta: true } })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: /2027\/28/ })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    expect(await screen.findByText('Scegli un anno scolastico per proseguire')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /2027\/28/ }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await compilaFinoAlRiepilogo()
    // Il riepilogo nomina l'anno scelto.
    expect(screen.getByText('Anno scolastico: 2027/28')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))
    await waitFor(() => expect(postBodies).toHaveLength(1))
    expect(postBodies[0].anno_id).toBe(A_PROSS.anno_id)
    expect(postBodies[0].scuola_id).toBe(SEDE_A)
  })

  it('UN solo anno: nessuna domanda in più (si parte dal bambino), e il POST porta quell\'anno', async () => {
    mockFetch({ anni: { tipo: 'ok', anni: [A_CORR], scelta: false } })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)

    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByText('Passo 1 di 4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /indietro/i })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Nome bimbo'), { target: { value: 'Tino' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Nome adulto'), { target: { value: 'Ines' } })
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await passaDaiConsensi()
    await waitFor(() => expect(screen.getByText('Riepilogo')).toBeInTheDocument())
    expect(screen.queryByText(/^Anno scolastico:/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))
    await waitFor(() => expect(postBodies).toHaveLength(1))
    expect(postBodies[0].anno_id).toBe(A_CORR.anno_id)
  })

  it.each([
    ['la lettura risponde 500', { tipo: 'http', stato: 500 } as RispostaAnni],
    ['il rate limit risponde 429', { tipo: 'http', stato: 429 } as RispostaAnni],
    ['la rete è giù', { tipo: 'rete' } as RispostaAnni],
    ['il corpo non contiene l\'elenco', { tipo: 'corpo-strano' } as RispostaAnni],
    ['il database è in ritardo (E2E): elenco vuoto, non chiuso', { tipo: 'ok', anni: [], scelta: false, chiuso: false } as RispostaAnni],
  ])('%s → il modulo parte dal bambino come prima, e il POST NON dichiara l\'anno', async (_nome, anni) => {
    mockFetch({ anni })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)

    await compilaFinoAlRiepilogo()
    expect(screen.getByText('Passo 4 di 4')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))
    await waitFor(() => expect(postBodies).toHaveLength(1))
    expect(postBodies[0]).not.toHaveProperty('anno_id')
    expect(postBodies[0].scuola_id).toBe(SEDE_A)
  })

  it('un guasto della lettura lascia una traccia nel log del client (un catch che non logga è un bug)', async () => {
    mockFetch({ anni: { tipo: 'http', stato: 500 } })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'warn', messaggio: 'iscrizione-anni-non-caricati', stato: 500 }),
    )
  })

  it('CHIUSO (sede sola o dal link): lo dice subito e non fa compilare niente', async () => {
    mockFetch({ anni: { tipo: 'ok', anni: [], scelta: false, chiuso: true } })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)

    await waitFor(() => expect(screen.getByText('Le iscrizioni sono chiuse')).toBeInTheDocument())
    expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /avanti/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /invia richiesta/i })).not.toBeInTheDocument()
  })

  it('PIÙ sedi: gli anni si chiedono solo dopo aver scelto la sede, e una sede chiusa non fa avanzare', async () => {
    mockFetch({
      sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }],
      anni: { tipo: 'ok', anni: [], scelta: false, chiuso: true },
    })
    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_B })).toBeInTheDocument())
    expect(chiamateAnni).toHaveLength(0)

    fireEvent.click(screen.getByRole('radio', { name: NOME_SEDE_B }))
    expect(await screen.findByText('Le iscrizioni sono chiuse')).toBeInTheDocument()
    expect(chiamateAnni).toHaveLength(1)
    expect(chiamateAnni[0]).toContain(`scuola_id=${SEDE_B}`)

    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    // Resta sul passo sede: le sedi sono ancora lì, e se ne può scegliere un'altra.
    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_A })).toBeInTheDocument())
    expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()
  })

  it('PIÙ sedi e due anni: sede, poi anno, poi il bambino (Avanti aspetta l\'elenco degli anni)', async () => {
    mockFetch({
      sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }],
      anni: { tipo: 'ok', anni: [A_CORR, A_PROSS], scelta: true },
    })
    render(<EnrollmentWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_A })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('radio', { name: NOME_SEDE_A }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /2026\/27/ })).toBeInTheDocument())
    expect(screen.getByText('Passo 2 di 6')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /2026\/27/ }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toBeInTheDocument())
  })

  it('il server risponde 409 ISCRIZIONI_CHIUSE all\'invio: lo dice in pagina e i dati restano', async () => {
    mockFetch({
      anni: { tipo: 'ok', anni: [A_CORR], scelta: false },
      post: { stato: 409, corpo: { error: 'x', codice: 'ISCRIZIONI_CHIUSE' } },
    })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await compilaFinoAlRiepilogo()
    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))

    expect(await screen.findByText('Le iscrizioni sono chiuse')).toBeInTheDocument()
    // Non è il guasto generico dell'invio.
    expect(screen.queryByText(/non è andato a buon fine|errore/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /invia richiesta/i })).toBeInTheDocument()
  })

  it('il server risponde 422 ANNO_NON_OFFERTO: torna a far scegliere l\'anno, con il messaggio', async () => {
    mockFetch({
      anni: { tipo: 'ok', anni: [A_CORR, A_PROSS], scelta: true },
      post: { stato: 422, corpo: { error: 'x', codice: 'ANNO_NON_OFFERTO' } },
    })
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: /2027\/28/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('radio', { name: /2027\/28/ }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await compilaFinoAlRiepilogo()
    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))

    // `waitFor` + `getBy` e non `findBy`: il mock di framer-motion crea un tipo nuovo a ogni render, quindi il
    // nodo trovato da `findBy` può essere già stato rimontato quando si asserisce.
    await waitFor(() => expect(screen.getByText('Quell’anno non accetta più domande')).toBeInTheDocument())
    expect(screen.getByRole('radio', { name: /2026\/27/ })).toBeInTheDocument()
    // La scelta di prima è caduta: bisogna sceglierne un'altra.
    expect(screen.getByRole('radio', { name: /2027\/28/ })).not.toBeChecked()
    // L'elenco è stato richiesto di nuovo.
    await waitFor(() => expect(chiamateAnni.length).toBeGreaterThanOrEqual(2))
  })
})
