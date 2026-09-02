import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'

/**
 * «MODULI INVIABILI» — la barra filtri sui modelli del costruttore.
 *
 * ─── LE DUE COSE CHE QUESTA LINGUETTA PUÒ SBAGLIARE ─────────────────────────────
 *
 *  1. **Dire «nessun risultato» a una tabella che non ha mai avuto una riga.** In produzione
 *     i modelli del costruttore sono sei; il giorno in cui saranno zero — o su una sede nuova
 *     — «Nessun risultato con questi filtri» accuserebbe i filtri di una colpa che non hanno,
 *     e manderebbe la segreteria a cercare un filtro che non esiste. Sono due stati diversi e
 *     qui si misurano tutti e due.
 *
 *  2. **Filtrare anche le tre card fisse.** Il modulo d'iscrizione standard, le candidature e
 *     l'anagrafica del personale NON sono modelli del costruttore: non si pubblicano, non si
 *     cercano, e devono restare a schermo qualunque cosa si scriva nel campo di ricerca.
 *     Farle sparire vorrebbe dire togliere alla segreteria i tre link che manda ogni giorno.
 *
 * ⚠️ Nessun dato personale nei dati di prova: il repository è pubblico.
 */

const SEDE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SEDE_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [
      { id: SEDE_A, nome: 'Kidville Giugliano' },
      { id: SEDE_B, nome: 'Kidville Cesa' },
    ],
    selezionate: [],
    effettive: [SEDE_A, SEDE_B],
    sedeCorrente: null,
    reFetchKey: `${SEDE_A},${SEDE_B}`,
    epocaSede: 0,
    errore: false,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: vi.fn(),
  }),
}))

/** Quattro modelli inventati, uno per ogni combinazione che i filtri devono separare. */
const MODELLI = [
  {
    id: 'm-1',
    title: 'Consenso alla gita al museo',
    is_active: true,
    is_enrollment_form: false,
    published_at: '2026-08-01T10:00:00Z',
    access_mode: 'public',
    requires_signature: true,
    scuola_id: null,
  },
  {
    id: 'm-2',
    title: 'Questionario di gradimento',
    is_active: true,
    is_enrollment_form: false,
    published_at: null,
    access_mode: 'authenticated',
    requires_signature: false,
    scuola_id: SEDE_A,
  },
  {
    id: 'm-3',
    title: 'Domanda di iscrizione al nido',
    is_active: false,
    is_enrollment_form: true,
    published_at: '2026-08-02T10:00:00Z',
    access_mode: 'public',
    requires_signature: false,
    scuola_id: SEDE_B,
  },
  {
    id: 'm-4',
    title: 'Rinnovo della delega al ritiro',
    is_active: true,
    is_enrollment_form: false,
    published_at: null,
    access_mode: 'public',
    requires_signature: true,
    scuola_id: SEDE_A,
  },
]

let modelliDaServire: unknown[] = MODELLI
/** Quando è valorizzato, la lettura dei modelli resta APPESA finché non lo si scioglie. */
let sospendiModelli: ((righe: unknown[]) => void) | null = null

function fetchFinto(input: RequestInfo | URL) {
  const url = String(input)
  if (url.includes('/api/admin/forms/models')) {
    if (sospendiModelli === null) {
      return Promise.resolve({ ok: true, status: 200, json: async () => modelliDaServire })
    }
    return new Promise((risolvi) => {
      sospendiModelli = (righe: unknown[]) =>
        risolvi({ ok: true, status: 200, json: async () => righe })
    })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
}

beforeEach(() => {
  vi.clearAllMocks()
  modelliDaServire = MODELLI
  sospendiModelli = null
  window.history.replaceState(null, '', '/admin/modulistica?tab=inviabili')
  vi.stubGlobal('fetch', vi.fn(fetchFinto))
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

import { ModuliInviabili } from '@/components/features/admin/iscrizioni/ModuliInviabili'

/** L'elenco dei modelli del costruttore, che è ciò che la barra governa. */
const elenco = () => screen.getByTestId('elenco-modelli-inviabili')
const titoliVisibili = () =>
  MODELLI.filter((m) => within(elenco()).queryByText(m.title) !== null).map((m) => m.title)

async function montaEAspetta() {
  render(<ModuliInviabili />)
  await waitFor(() => expect(screen.getByText('Consenso alla gita al museo')).toBeInTheDocument())
}

describe('ModuliInviabili — la barra filtri', () => {
  it('la barra c’è, e all’apertura non nasconde niente', async () => {
    await montaEAspetta()
    expect(screen.getByLabelText('Cerca un modulo')).toBeInTheDocument()
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('4 risultati su 4')
    expect(titoliVisibili()).toHaveLength(4)
    // Nessun filtro attivo ⇒ nessuna pastiglia col conteggio.
    expect(screen.queryByTestId('conteggio-filtri')).toBeNull()
  })

  // L'ordine dell'elenco resta quello della route (`.order('title')`): qui la ricerca TIENE
  // o SCARTA e basta. Riordinare per qualità della corrispondenza è una scelta da catalogo —
  // la fa il pannello dei prestampati, dove le voci sono diciassette e stanno in una griglia.
  it('la ricerca tiene solo i titoli che corrispondono', async () => {
    await montaEAspetta()
    fireEvent.change(screen.getByLabelText('Cerca un modulo'), { target: { value: 'delega' } })

    await waitFor(() => expect(titoliVisibili()).toEqual(['Rinnovo della delega al ritiro']))
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('1 risultato su 4')
  })

  it('le tre card fisse non sono modelli del costruttore: la ricerca non le tocca', async () => {
    await montaEAspetta()
    fireEvent.change(screen.getByLabelText('Cerca un modulo'), {
      target: { value: 'qwertyuiop-nessuna-corrispondenza' },
    })

    await waitFor(() => expect(titoliVisibili()).toHaveLength(0))
    // I tre link che la segreteria manda ogni giorno restano dove sono.
    expect(screen.getByText('Modulo d’iscrizione standard')).toBeInTheDocument()
    expect(screen.getByText('Candidature insegnanti')).toBeInTheDocument()
    expect(screen.getByText('Anagrafica del personale')).toBeInTheDocument()
  })

  it('il chip «Bozze» tiene solo i modelli non pubblicati, e si conta come UN filtro', async () => {
    await montaEAspetta()
    fireEvent.click(screen.getByRole('button', { name: /^Bozze/ }))

    await waitFor(() =>
      expect(titoliVisibili().sort()).toEqual(
        ['Questionario di gradimento', 'Rinnovo della delega al ritiro'].sort(),
      ),
    )
    expect(screen.getByTestId('conteggio-filtri')).toHaveTextContent('1')
    // Il chip removibile porta l'etichetta leggibile, non il valore grezzo.
    expect(screen.getByTestId('chip-stato-bozze')).toHaveTextContent('Bozze')
  })

  it('«Solo quelli che chiedono la firma» tiene i due che la chiedono', async () => {
    await montaEAspetta()
    // I campi non primari vivono nel pannello «Filtri»: prima si apre.
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    fireEvent.click(screen.getByRole('switch', { name: 'Solo quelli che chiedono la firma' }))

    await waitFor(() =>
      expect(titoliVisibili().sort()).toEqual(
        ['Consenso alla gita al museo', 'Rinnovo della delega al ritiro'].sort(),
      ),
    )
  })

  it('la sede è una scelta sola quando le sedi in gioco sono due, e dice «tutte» per i modelli globali', async () => {
    await montaEAspetta()
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    const sede = screen.getByLabelText('Sede') as HTMLSelectElement
    // Tre valori distinti fra i quattro modelli: globale, Giugliano, Cesa.
    expect([...sede.options].map((o) => o.textContent)).toEqual([
      'Tutti',
      'Kidville Cesa (1)',
      'Kidville Giugliano (2)',
      'Vale per tutte le sedi (1)',
    ])

    fireEvent.change(sede, { target: { value: SEDE_A } })
    await waitFor(() =>
      expect(titoliVisibili().sort()).toEqual(
        ['Questionario di gradimento', 'Rinnovo della delega al ritiro'].sort(),
      ),
    )
  })

  it('a ZERO modelli si dice «vuoto», non «nessun risultato»', async () => {
    // È il vincolo che vale per tutte le linguette di questa schermata: cinque su tredici
    // hanno zero righe in produzione, ed è il caso normale, non il caso limite.
    modelliDaServire = []
    render(<ModuliInviabili />)

    await waitFor(() =>
      expect(
        screen.getByText('Nessun modulo personalizzato. Creane uno con «Nuovo modulo».'),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByText('Nessun risultato con questi filtri')).toBeNull()
    // E la barra non si disegna sopra il nulla: non c'è niente da filtrare.
    expect(screen.queryByLabelText('Cerca un modulo')).toBeNull()
  })

  it('con dei modelli e un filtro che non trova nulla si dice «nessun risultato», e si può pulire', async () => {
    await montaEAspetta()
    fireEvent.change(screen.getByLabelText('Cerca un modulo'), {
      target: { value: 'qwertyuiop-nessuna-corrispondenza' },
    })

    await waitFor(() =>
      expect(screen.getByText('Nessun risultato con questi filtri')).toBeInTheDocument(),
    )
    expect(
      screen.queryByText('Nessun modulo personalizzato. Creane uno con «Nuovo modulo».'),
    ).toBeNull()

    // «Pulisci filtri» dello stato vuoto riporta l'elenco intero.
    fireEvent.click(within(screen.getByTestId('stato-elenco-inviabili')).getByText('Pulisci filtri'))
    await waitFor(() => expect(titoliVisibili()).toHaveLength(4))
  })

  it('durante un ricaricamento le righe RESTANO, attenuate e dichiarate occupate', async () => {
    await montaEAspetta()
    // Da qui in poi la lettura dei modelli resta appesa: è il ricaricamento in corso.
    sospendiModelli = () => {}
    fireEvent.click(screen.getAllByText('Pubblica')[0])

    await waitFor(() => expect(elenco()).toHaveAttribute('aria-busy', 'true'))
    // Le righe di prima sono ancora lì: nessuno spinner al loro posto.
    expect(titoliVisibili()).toHaveLength(4)
    expect(elenco().className).toContain('opacity-60')
    expect(elenco().className).toContain('pointer-events-none')

    sospendiModelli?.(MODELLI)
    await waitFor(() => expect(elenco()).toHaveAttribute('aria-busy', 'false'))
    expect(titoliVisibili()).toHaveLength(4)
  })

  it('la ricerca finisce nell’indirizzo, così la schermata si rialza identica', async () => {
    await montaEAspetta()
    fireEvent.change(screen.getByLabelText('Cerca un modulo'), { target: { value: 'delega' } })

    await waitFor(() => expect(window.location.search).toContain('q=delega'))
    // E il parametro della linguetta, che non è suo, non lo tocca.
    expect(window.location.search).toContain('tab=inviabili')
  })
})
