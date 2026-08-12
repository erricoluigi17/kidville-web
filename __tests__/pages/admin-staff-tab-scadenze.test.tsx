import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itAdmin from '../../messages/it/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * `/admin/staff?tab=scadenze&stato=scaduto` — IL BERSAGLIO DELLA NOTIFICA.
 *
 * ⚠️ SE QUESTO TEST È ROSSO, LA NOTIFICA È ROTTA. Non «la pagina si apre sulla
 * linguetta sbagliata»: rotta. Il cron notturno avvisa la segreteria che il
 * documento di qualcuno è scaduto, e quel collegamento è l'unico gesto che
 * separa l'avviso dalla riga da correggere. Se atterra sull'elenco completo,
 * chi lo apre deve rifiltrare a mano — e una notifica che chiede di rifare a
 * mano il lavoro che aveva già fatto è una notifica che si impara a ignorare:
 * la prima volta si cerca la riga, la seconda si rimanda, la terza non si apre
 * più. A quel punto l'allarme esiste e non serve a niente, che è la forma di
 * guasto peggiore perché tutto sembra funzionare.
 *
 * Le tre cose che il file verifica, e perché ciascuna:
 *
 *  1. `?tab=scadenze` apre la LINGUETTA giusta (senza, si atterra su «Personale»);
 *  2. `?stato=scaduto` applica il FILTRO al primo render (senza, si atterra
 *     sulla lista intera — il difetto descritto qui sopra);
 *  3. uno `?stato=` INVENTATO non filtra niente invece di svuotare la tabella.
 *     È il caso di un collegamento vecchio o storpiato: una tabella vuota
 *     direbbe «non c'è nessun documento scaduto», cioè una cosa falsa, proprio
 *     a chi era stato chiamato lì da un allarme.
 *
 * `StaffPanel` è MOCKATO, ed è deliberato: non è ciò che si sta collaudando (ha
 * i suoi test), monta un pannello che chiama tre rotte sue, e un suo guasto
 * renderebbe rosso questo file per una ragione che non c'entra niente con la
 * notifica. Il pannello delle scadenze invece è quello VERO.
 *
 * ⚠️ Tempo congelato: gli stati sono distanze fra date.
 */

const h = vi.hoisted(() => ({ query: '', logClient: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'TypeError' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.query),
  useParams: () => ({}),
  usePathname: () => '/admin/staff',
}))
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', ready: true }),
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }],
    selezionate: [],
    effettive: [SEDE_A],
    sedeCorrente: SEDE_A,
    reFetchKey: SEDE_A,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))
vi.mock('@/components/features/admin/settings/StaffPanel', () => ({
  StaffPanel: () => <div data-testid="staff-panel">pannello personale</div>,
}))

const OGGI = '2026-08-12'
const SCADUTA = 'dddddddd-0000-4000-8000-000000000001'
const IN_PREAVVISO = 'dddddddd-0000-4000-8000-000000000004'

const RIGHE = [
  { utente_id: SCADUTA, nome: 'Anna', cognome: 'Alfa', ruolo: 'educator', scuola_id: SEDE_A, document_type: 'CI', document_expiry: '2026-08-01' },
  { utente_id: IN_PREAVVISO, nome: 'Dina', cognome: 'Delta', ruolo: 'cuoca', scuola_id: SEDE_A, document_type: 'DL', document_expiry: '2026-10-30' },
]

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-12T09:00:00.000Z'))
  h.query = ''
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ data: RIGHE, inRegola: 0, cessati: 0, oggi: OGGI, orizzonteGiorni: 90, totalePersonale: 2, limite: 500 }),
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

import AdminStaffPage from '@/app/(dashboard)/admin/staff/page'

describe('/admin/staff — le due linguette e il bersaglio della notifica', () => {
  it('senza parametri si apre su «Personale»', async () => {
    render(<AdminStaffPage />)
    await waitFor(() => expect(screen.getByTestId('staff-panel')).toBeInTheDocument())
    expect(screen.queryByText(itAdmin.scadIntro)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(itAdmin.scadTabPersonale, 'i') })).toHaveAttribute('aria-pressed', 'true')
  })

  it('`?tab=scadenze&stato=scaduto` apre la linguetta CON IL FILTRO GIÀ APPLICATO', async () => {
    h.query = 'tab=scadenze&stato=scaduto'
    render(<AdminStaffPage />)

    // La linguetta giusta…
    await waitFor(() => expect(screen.getByText(itAdmin.scadIntro)).toBeInTheDocument())
    expect(screen.queryByTestId('staff-panel')).not.toBeInTheDocument()

    // …e il filtro già premuto, con in tabella SOLO la riga scaduta.
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    expect(
      screen.getByRole('button', { name: new RegExp(itAdmin.scadBoxScaduti, 'i') }),
      'il riquadro «Scaduti» non risulta premuto: la notifica atterra su una lista da rifiltrare',
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.queryByText('Delta Dina'),
      'in tabella c’è anche chi NON è scaduto: il filtro della notifica non è stato applicato',
    ).not.toBeInTheDocument()
  })

  it('`?tab=scadenze` senza `stato` apre la linguetta SENZA filtri', async () => {
    h.query = 'tab=scadenze'
    render(<AdminStaffPage />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    expect(screen.getByText('Delta Dina')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(itAdmin.scadBoxScaduti, 'i') })).toHaveAttribute('aria-pressed', 'false')
  })

  it('uno `?stato=` INVENTATO non filtra niente: la tabella non si svuota in silenzio', async () => {
    h.query = 'tab=scadenze&stato=qualunque-cosa'
    render(<AdminStaffPage />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    expect(screen.getByText('Delta Dina')).toBeInTheDocument()
    expect(screen.queryByText(itAdmin.scadVuotoFiltro)).not.toBeInTheDocument()
  })

  it('la pagina ha una MAPPA di intestazioni, e dice quale linguetta si sta guardando', async () => {
    /**
     * IL DIFETTO, misurato il 2026-08-12 su questa pagina:
     * `document.querySelectorAll('h1,h2,h3').length` valeva **1** — il solo
     * `<h1>` «Gestione Staff» della testata — su TUTTE E DUE le linguette. Cioè:
     * chi naviga per intestazioni (il tasto H, il modo normale di orientarsi con
     * uno screen reader) arrivava al titolo della pagina e non aveva più niente,
     * e quel titolo non distingue nemmeno «Personale» da «Scadenze documenti».
     *
     * Qui si misura sulla pagina VERA, con l'`<h1>` al suo posto: la catena deve
     * scendere di un gradino per volta (h1 → h2 → h3), che è la condizione di
     * `heading-order` e insieme il modo in cui la mappa resta leggibile.
     * `StaffPanel` è mockato, quindi le intestazioni contate sono quelle della
     * testata di pagina più quelle del pannello delle scadenze.
     */
    h.query = 'tab=scadenze'
    const { container } = render(<AdminStaffPage />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    const catena = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    const livelli = catena.map((el) => Number(el.tagName.slice(1)))

    expect(livelli[0], 'la pagina non comincia con un `<h1>`').toBe(1)
    expect(
      livelli.filter((l) => l === 2).length,
      'nessun `<h2>`: la linguetta aperta non esiste nella mappa delle intestazioni',
    ).toBeGreaterThan(0)
    for (let i = 1; i < livelli.length; i += 1) {
      expect(
        livelli[i] - livelli[i - 1],
        `si passa da h${livelli[i - 1]} a h${livelli[i]}: un gradino saltato è un buco nella mappa`,
      ).toBeLessThanOrEqual(1)
    }

    // E l'`<h2>` dice DOVE si è: porta il nome della linguetta premuta.
    expect(catena.find((el) => el.tagName === 'H2')).toHaveTextContent(itAdmin.scadTabScadenze)
  })

  it('si passa da una linguetta all’altra con un clic, e il pannello cambia davvero', async () => {
    render(<AdminStaffPage />)
    await waitFor(() => expect(screen.getByTestId('staff-panel')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: new RegExp(itAdmin.scadTabScadenze, 'i') }))
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    expect(screen.queryByTestId('staff-panel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: new RegExp(itAdmin.scadTabPersonale, 'i') }))
    await waitFor(() => expect(screen.getByTestId('staff-panel')).toBeInTheDocument())
  })
})
