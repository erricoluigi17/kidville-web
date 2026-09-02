import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'

import itAdminModulistica from '../../messages/it/adminModulistica.json'

/**
 * «MODULI PER I GENITORI ISCRITTI» — la barra filtri della linguetta che vive INLINE.
 *
 * ─── PERCHÉ QUESTA LINGUETTA È IL BANCO DI PROVA DEL VUOTO ──────────────────────
 *
 * `forms_templates` in produzione non ha nemmeno una riga. È quindi l'unico posto in cui la
 * distinzione fra «non è ancora stato creato nessun modulo» e «nessuno corrisponde ai filtri»
 * non è un caso limite ma lo stato NORMALE della schermata — e sbagliarla vuol dire mandare
 * la segreteria a cercare un filtro da togliere che nessuno ha messo. I due stati si misurano
 * qui, uno accanto all'altro.
 *
 * ⚠️ Le date si costruiscono RELATIVE all'orologio, non scritte a mano: un modulo «ancora
 * valido» fissato al 2026-12-31 diventa «scaduto» da solo il primo gennaio, e il test
 * comincerebbe a fallire senza che nessuno abbia toccato il codice. È la trappola già pagata
 * in questo repo da un test scaduto col calendario.
 */

const SEDE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const GIORNO = 24 * 60 * 60 * 1000

const h = vi.hoisted(() => ({ query: 'tab=moduli-genitori' }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/admin/modulistica',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE, nome: 'Kidville Giugliano' }],
    selezionate: [],
    effettive: [SEDE],
    sedeCorrente: SEDE,
    reFetchKey: SEDE,
    epocaSede: 0,
    errore: false,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: vi.fn(),
  }),
  SedeNotice: () => null,
}))

// I pannelli delle altre linguette non si montano con `?tab=moduli-genitori`, ma restano
// importati: si azzerano per non farli leggere nulla se un giorno la catena cambiasse.
vi.mock('@/components/features/admin/iscrizioni/ModuliInviabili', () => ({ ModuliInviabili: () => null }))
vi.mock('@/components/features/admin/iscrizioni/ModuliRicevuti', () => ({ ModuliRicevuti: () => null }))
vi.mock('@/components/features/admin/iscrizioni/ElencoClassi', () => ({ ElencoClassi: () => null }))
vi.mock('@/components/features/admin/iscrizioni/RinviaCredenziali', () => ({ RinviaCredenziali: () => null }))
vi.mock('@/components/features/admin/iscrizioni/CandidatureInsegnanti', () => ({ CandidatureInsegnanti: () => null }))
vi.mock('@/components/features/admin/personale/PratichePersonale', () => ({ PratichePersonale: () => null }))
vi.mock('@/components/features/prestampati/PrestampatiSegreteria', () => ({ PrestampatiSegreteria: () => null }))

const base = {
  fields: [],
  target_scope: 'class' as const,
}

const MODULI = [
  {
    ...base,
    id: 'a',
    title: 'Uscita didattica al museo',
    description: 'Serve il consenso di chi esercita la responsabilità genitoriale',
    form_type: 'autorizzazione',
    target_classes: ['PRIMAVERA A'],
    expiration_date: new Date(Date.now() + 30 * GIORNO).toISOString(),
    created_at: '2026-01-15T10:00:00Z',
    sempre_firmabile: true,
  },
  {
    ...base,
    id: 'b',
    title: 'Come è andato l’anno',
    description: 'Un giudizio sul servizio',
    form_type: 'gradimento',
    target_classes: ['INFANZIA B'],
    expiration_date: new Date(Date.now() - 30 * GIORNO).toISOString(),
    created_at: '2026-06-20T10:00:00Z',
    sempre_firmabile: false,
  },
  {
    ...base,
    id: 'c',
    title: 'Preferenze sul menu',
    description: '',
    form_type: 'sondaggio',
    target_classes: ['PRIMAVERA A', 'INFANZIA B'],
    expiration_date: null,
    created_at: '2026-03-10T10:00:00Z',
    sempre_firmabile: false,
  },
]

const SEZIONI = [
  { id: 's1', name: 'PRIMAVERA A' },
  { id: 's2', name: 'INFANZIA B' },
  // Una sezione su cui non è mai stato creato niente: deve comunque essere una scelta.
  { id: 's3', name: 'NIDO A' },
]

let moduliDaServire: unknown[] = MODULI

function fetchFinto(input: RequestInfo | URL) {
  const url = String(input)
  if (url.includes('/api/admin/forms')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => moduliDaServire })
  }
  if (url.includes('/api/admin/sections')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => SEZIONI })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.query = 'tab=moduli-genitori'
  moduliDaServire = MODULI
  window.history.replaceState(null, '', '/admin/modulistica?tab=moduli-genitori')
  vi.stubGlobal('fetch', vi.fn(fetchFinto))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

import AdminModulisticaPage from '@/app/(dashboard)/admin/modulistica/page'

const titoliVisibili = () =>
  MODULI.filter((m) => screen.queryByRole('heading', { name: m.title }) !== null).map((m) => m.title)

async function monta() {
  render(<AdminModulisticaPage />)
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Uscita didattica al museo' })).toBeInTheDocument(),
  )
}

describe('Modulistica · moduli per i genitori — la barra filtri', () => {
  it('la barra c’è, e all’apertura non nasconde niente', async () => {
    await monta()
    expect(screen.getByLabelText(itAdminModulistica.filtriModuliRicerca)).toBeInTheDocument()
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('3 risultati su 3')
    expect(titoliVisibili()).toHaveLength(3)
  })

  it('il tipo di modulo usa le stesse parole della pastiglia di ogni riga', async () => {
    await monta()
    // «Gradimento» è la STESSA etichetta che la riga mostra nella sua pastiglia verde.
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(`^${itAdminModulistica.modFormTypeGradimento}`) }),
    )

    await waitFor(() => expect(titoliVisibili()).toEqual(['Come è andato l’anno']))
  })

  it('la scadenza distingue i TRE stati: senza scadenza non è «ancora valido»', async () => {
    await monta()
    const scadenza = screen.getByLabelText(itAdminModulistica.filtriModuliScadenza) as HTMLSelectElement

    fireEvent.change(scadenza, { target: { value: 'attivi' } })
    await waitFor(() => expect(titoliVisibili()).toEqual(['Uscita didattica al museo']))

    fireEvent.change(scadenza, { target: { value: 'scaduti' } })
    await waitFor(() => expect(titoliVisibili()).toEqual(['Come è andato l’anno']))

    fireEvent.change(scadenza, { target: { value: 'senza' } })
    await waitFor(() => expect(titoliVisibili()).toEqual(['Preferenze sul menu']))
  })

  it('fra le classi c’è anche la sezione su cui non è stato creato niente', async () => {
    await monta()
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    const gruppo = screen.getByRole('group', { name: 'Filtri' })

    // «NIDO A» non è nominata da nessun modulo: viene dalle sezioni della sede, e serve
    // proprio a rispondere «su questa sezione ho già mandato qualcosa?».
    const nidoA = within(gruppo).getByRole('button', { name: /^NIDO A/ })
    fireEvent.click(nidoA)
    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('0 risultati su 3'),
    )
    expect(screen.getByText('Nessun risultato con questi filtri')).toBeInTheDocument()
  })

  it('«Solo i moduli essenziali» tiene quello firmabile anche da un genitore sospeso', async () => {
    await monta()
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    fireEvent.click(
      screen.getByRole('switch', { name: itAdminModulistica.filtriModuliSoloEssenziali }),
    )

    await waitFor(() => expect(titoliVisibili()).toEqual(['Uscita didattica al museo']))
  })

  it('a ZERO moduli si dice «non ne è stato creato nessuno», non «nessun risultato»', async () => {
    moduliDaServire = []
    render(<AdminModulisticaPage />)

    await waitFor(() =>
      expect(screen.getByText(itAdminModulistica.modNessunModuloGenitori)).toBeInTheDocument(),
    )
    expect(screen.queryByText('Nessun risultato con questi filtri')).toBeNull()
    // E la barra non si disegna sopra il nulla.
    expect(screen.queryByLabelText(itAdminModulistica.filtriModuliRicerca)).toBeNull()
  })

  it('con dei moduli e un filtro che non trova nulla si dice «nessun risultato», e si pulisce', async () => {
    await monta()
    fireEvent.change(screen.getByLabelText(itAdminModulistica.filtriModuliRicerca), {
      target: { value: 'qwertyuiop-nessuna-corrispondenza' },
    })

    await waitFor(() =>
      expect(screen.getByText('Nessun risultato con questi filtri')).toBeInTheDocument(),
    )
    expect(screen.queryByText(itAdminModulistica.modNessunModuloGenitori)).toBeNull()

    fireEvent.click(
      within(screen.getByTestId('stato-moduli-genitori')).getByText('Pulisci filtri'),
    )
    await waitFor(() => expect(titoliVisibili()).toHaveLength(3))
  })

  it('i filtri finiscono nell’indirizzo senza portare via `?tab=`', async () => {
    await monta()
    fireEvent.change(screen.getByLabelText(itAdminModulistica.filtriModuliRicerca), {
      target: { value: 'museo' },
    })

    await waitFor(() => expect(window.location.search).toContain('q=museo'))
    // `?tab=` non è governato da questa barra: riscrivere l'indirizzo per intero
    // scollegherebbe la pagina dalla linguetta su cui si sta lavorando.
    expect(window.location.search).toContain('tab=moduli-genitori')
  })
})
