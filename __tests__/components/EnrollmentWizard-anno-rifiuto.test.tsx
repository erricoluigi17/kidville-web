import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SEDE_A } from '../fixtures/sedi'

/**
 * Compito 4.5.7-bis · il rifiuto 422 `ANNO_NON_OFFERTO` letto da chi NON ha il passo «anno».
 *
 * Con UN solo anno offerto il passo «anno» non esiste: la famiglia preme «Invia richiesta», il server risponde 422 e
 * prima non succedeva niente di visibile. Ora il messaggio sta nel punto in cui si trova, con i dati al loro posto, e
 * dice che cosa fare. Dopo il rifiuto l'elenco si ricarica e può tornare in più modi, TUTTI provati qui con una
 * `fetch` finta che risponde in modo diverso alla prima e alla seconda lettura (nessun mock piatto):
 *  · nessun anno (`chiuso`)            → le iscrizioni chiuse, come già esistente;
 *  · un anno diverso da prima          → «è cambiato, adesso parte X», e il secondo POST porta l'anno nuovo;
 *  · due anni (il passo «anno» nasce)  → la famiglia finisce SUL passo «anno», con il messaggio e i dati intatti;
 *  · due anni che diventano uno        → il passo «anno» sparisce: si torna al riepilogo, con il messaggio;
 *  · la ricarica fallisce              → l'elenco vecchio resta, il messaggio si legge lo stesso.
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
      { id: 'bambino', title: 'Dati del bambino', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true, placeholder: 'Nome bimbo' }] },
      { id: 'adulto', title: 'Adulto', fields: [{ id: 'first_name', type: 'text', label: 'Nome adulto', required: true, placeholder: 'Nome adulto' }] },
    ],
  },
}

type Lettura =
  | { tipo: 'ok'; anni: unknown[]; scelta: boolean; chiuso?: boolean }
  | { tipo: 'http'; stato: number }

const fetchMock = vi.fn()
let postBodies: { data: { children: { nome?: string }[] }; anno_id?: string; scuola_id?: string }[] = []
let letture: Lettura[] = []
let chiamateAnni = 0
let rispostePost: { stato: number; corpo: unknown }[] = []

/** La N-esima lettura degli anni risponde `letture[N]` (l'ultima si ripete); l'N-esimo POST risponde `rispostePost[N]`. */
function mockFetch() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/iscrizione/model')) return Promise.resolve({ ok: true, json: async () => modelSchema })
    if (url.includes('/api/iscrizione/sedi')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [{ id: SEDE_A, nome: 'Sede A' }] }) })
    }
    if (url.includes('/api/iscrizione/anni')) {
      const r = letture[Math.min(chiamateAnni, letture.length - 1)]
      chiamateAnni += 1
      if (r.tipo === 'http') return Promise.resolve({ ok: false, status: r.stato, json: async () => ({ error: 'no' }) })
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { anni: r.anni, scelta: r.scelta, chiuso: r.chiuso ?? false } }),
      })
    }
    if (url.includes('/api/iscrizione') && init?.method === 'POST') {
      const n = postBodies.length
      postBodies.push(JSON.parse(String(init.body)))
      const p = rispostePost[Math.min(n, rispostePost.length - 1)]
      return Promise.resolve({ ok: p.stato < 400, status: p.stato, json: async () => p.corpo })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

const RIFIUTO = { stato: 422, corpo: { error: 'x', codice: 'ANNO_NON_OFFERTO' } }
const OK = { stato: 201, corpo: { id: 'x' } }

async function compilaFinoAlRiepilogo() {
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
}

async function inviaECapitaIlRifiuto() {
  fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))
  await waitFor(() => expect(postBodies).toHaveLength(1))
  // La ricarica dell'elenco parte dopo il rifiuto: seconda lettura.
  await waitFor(() => expect(chiamateAnni).toBeGreaterThanOrEqual(2))
}

beforeEach(() => {
  vi.clearAllMocks()
  postBodies = []
  letture = []
  chiamateAnni = 0
  rispostePost = [RIFIUTO, OK]
  vi.stubGlobal('fetch', fetchMock)
  mockFetch()
})

describe('EnrollmentWizard · 422 ANNO_NON_OFFERTO senza il passo «anno»', () => {
  it('UN anno diverso da prima: il messaggio dice quale parte adesso, i dati ci sono, il secondo POST porta l\'anno nuovo', async () => {
    letture = [
      { tipo: 'ok', anni: [A_CORR], scelta: false },
      { tipo: 'ok', anni: [A_PROSS], scelta: false },
    ]
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await compilaFinoAlRiepilogo()
    expect(screen.getByText('Passo 4 di 4')).toBeInTheDocument()
    await inviaECapitaIlRifiuto()

    // Il messaggio è SUL documento (una presenza: si aspetta questa, non un'assenza), nel punto in cui si trova.
    await waitFor(() => expect(screen.getByText('L’anno scolastico è cambiato')).toBeInTheDocument())
    expect(screen.getByText(/aperte per l’anno 2027\/28/)).toBeInTheDocument()
    expect(screen.getByText('Riepilogo')).toBeInTheDocument()
    expect(screen.getByText('Passo 4 di 4')).toBeInTheDocument()
    // Non è il guasto generico dell'invio.
    expect(screen.queryByText(/non è andato a buon fine/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))
    await waitFor(() => expect(postBodies).toHaveLength(2))
    expect(postBodies[0].anno_id).toBe(A_CORR.anno_id)
    expect(postBodies[1].anno_id).toBe(A_PROSS.anno_id)
    // I dati compilati non sono andati persi.
    expect(postBodies[1].data.children[0].nome).toBe('Tino')
    await waitFor(() => expect(screen.getByText(/inviata|grazie/i)).toBeInTheDocument())
  })

  it('NESSUN anno (chiuso): valgono le iscrizioni chiuse già esistenti', async () => {
    letture = [
      { tipo: 'ok', anni: [A_CORR], scelta: false },
      { tipo: 'ok', anni: [], scelta: false, chiuso: true },
    ]
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await compilaFinoAlRiepilogo()
    await inviaECapitaIlRifiuto()

    await waitFor(() => expect(screen.getByText('Le iscrizioni sono chiuse')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /invia richiesta/i })).not.toBeInTheDocument()
    expect(postBodies).toHaveLength(1)
  })

  it('DUE anni (nasce il passo «anno»): la famiglia finisce SUL passo «anno», col messaggio, e i dati restano', async () => {
    letture = [
      { tipo: 'ok', anni: [A_CORR], scelta: false },
      { tipo: 'ok', anni: [A_CORR, A_PROSS], scelta: true },
    ]
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await compilaFinoAlRiepilogo()
    await inviaECapitaIlRifiuto()

    // Gli indici dei passi si sono spostati di uno: non un passo a caso, ma il passo «anno» (il primo di cinque).
    await waitFor(() => expect(screen.getByRole('radio', { name: /2027\/28/ })).toBeInTheDocument())
    expect(screen.getByText('Quell’anno non accetta più domande')).toBeInTheDocument()
    expect(screen.getByText('Passo 1 di 5')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Nome bimbo')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /2027\/28/ })).not.toBeChecked()

    // Si sceglie, si riattraversa il modulo: il nome del bambino c'è ancora, e il POST porta l'anno scelto.
    fireEvent.click(screen.getByRole('radio', { name: /2027\/28/ }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome bimbo')).toHaveValue('Tino'))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByPlaceholderText('Nome adulto')).toHaveValue('Ines'))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    // Anche la presa visione data prima è rimasta: non va rifatta (cliccarla di nuovo la toglierebbe).
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await waitFor(() => expect(screen.getByText('Riepilogo')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))
    await waitFor(() => expect(postBodies).toHaveLength(2))
    expect(postBodies[1].anno_id).toBe(A_PROSS.anno_id)
    expect(postBodies[1].data.children[0].nome).toBe('Tino')
  })

  it('DUE anni che diventano UNO (il passo «anno» sparisce): si torna al riepilogo col messaggio, e si può inviare di nuovo', async () => {
    letture = [
      { tipo: 'ok', anni: [A_CORR, A_PROSS], scelta: true },
      { tipo: 'ok', anni: [A_CORR], scelta: false },
    ]
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: /2027\/28/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('radio', { name: /2027\/28/ }))
    fireEvent.click(screen.getByRole('button', { name: /avanti/i }))
    await compilaFinoAlRiepilogo()
    await inviaECapitaIlRifiuto()

    await waitFor(() => expect(screen.getByText('L’anno scolastico è cambiato')).toBeInTheDocument())
    expect(screen.getByText(/aperte per l’anno 2026\/27/)).toBeInTheDocument()
    // Il passo «anno» non c'è più, e il contatore non esce dai passi: quattro di quattro, sul riepilogo.
    expect(screen.getByText('Passo 4 di 4')).toBeInTheDocument()
    expect(screen.getByText('Riepilogo')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))
    await waitFor(() => expect(postBodies).toHaveLength(2))
    expect(postBodies[1].anno_id).toBe(A_CORR.anno_id)
  })

  it('la RICARICA fallisce (500): l\'elenco vecchio resta, il messaggio si legge lo stesso, e un nuovo invio lo decide il server', async () => {
    letture = [
      { tipo: 'ok', anni: [A_CORR], scelta: false },
      { tipo: 'http', stato: 500 },
    ]
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await compilaFinoAlRiepilogo()
    await inviaECapitaIlRifiuto()

    await waitFor(() => expect(screen.getByText('La domanda non è stata inviata')).toBeInTheDocument())
    expect(screen.getByText('Riepilogo')).toBeInTheDocument()
    expect(screen.getByText('Passo 4 di 4')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /invia richiesta/i }))
    await waitFor(() => expect(postBodies).toHaveLength(2))
    expect(postBodies[1].data.children[0].nome).toBe('Tino')
    expect(postBodies[1].anno_id).toBe(A_CORR.anno_id)
  })

  it('il messaggio non resta in pagina se la famiglia torna indietro a correggere', async () => {
    letture = [
      { tipo: 'ok', anni: [A_CORR], scelta: false },
      { tipo: 'ok', anni: [A_PROSS], scelta: false },
    ]
    render(<EnrollmentWizard scuolaId={SEDE_A} />)
    await compilaFinoAlRiepilogo()
    await inviaECapitaIlRifiuto()
    await waitFor(() => expect(screen.getByText('L’anno scolastico è cambiato')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /indietro/i }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument())
    expect(screen.queryByText('L’anno scolastico è cambiato')).not.toBeInTheDocument()
  })
})
