import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'

/**
 * «ELENCO CLASSI» — la barra filtri sulle DIFFORMITÀ, che è l'unico elenco vero di questa
 * linguetta.
 *
 * ─── COSA SI FILTRA, E PERCHÉ NON SONO GLI ALUNNI ───────────────────────────────
 *
 * La schermata elenca CARICAMENTI — uno per sede — e dentro ciascuno le difformità del
 * foglio. Su 338 righe vere le difformità sono decine, e la domanda che la segreteria si fa
 * ogni mattina è sempre la stessa: «quali fermano un'iscrizione, e in quale classe». Le card
 * di sede restano invece SEMPRE tutte a schermo, anche quando il filtro non lascia passare
 * nessuna delle loro righe: portano il comando «Carica elenco», e un filtro che nasconde il
 * comando di caricamento toglie alla segreteria la cosa per cui è venuta.
 *
 * ─── 🔴 LA RICERCA NON FINISCE NELL’INDIRIZZO ───────────────────────────────────
 *
 * Il testo su cui si cerca comprende il NOME COM’È SCRITTO SUL FOGLIO, cioè il nome di un
 * bambino. Un indirizzo si copia, si incolla in una chat e resta nella cronologia del
 * browser: qui la barra si monta con `scriviUrl: false`, ed è l'unica delle quattro
 * linguette in cui succede. Questo file lo misura, perché è una scelta che si perde alla
 * prima riga cambiata.
 *
 * ⚠️ Nessun nome vero nei dati di prova: il repository è pubblico.
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

const ELENCHI = [
  {
    id: 'el-1',
    scuolaId: SEDE_A,
    nomeFile: 'classi.xlsx',
    righeTotali: 40,
    caricatoIl: '2026-08-30T09:00:00Z',
    perClasse: [
      { classe: 'PRIMAVERA A', alunni: 20 },
      { classe: 'INFANZIA B', alunni: 15 },
      // Una classe SENZA nemmeno una difformità: deve comunque comparire fra le scelte.
      { classe: 'INFANZIA C', alunni: 5 },
    ],
    anomalie: [
      { genere: 'nome-mancante', classe: 'PRIMAVERA A', rigaExcel: 4, nome: '', dettaglio: 'La cella del nome è vuota' },
      { genere: 'retta-fuori-scala', classe: 'PRIMAVERA A', rigaExcel: 7, nome: 'Prova Alfa', dettaglio: 'Retta 30 €: fuori scala' },
      { genere: 'nome-ripetuto', classe: 'INFANZIA B', rigaExcel: 12, nome: 'Prova Beta', dettaglio: 'Nome già presente alla riga 9' },
    ],
  },
  {
    id: 'el-2',
    scuolaId: SEDE_B,
    nomeFile: 'classi-cesa.xlsx',
    righeTotali: 18,
    caricatoIl: '2026-08-31T09:00:00Z',
    perClasse: [{ classe: 'NIDO A', alunni: 18 }],
    anomalie: [
      { genere: 'spazi-anomali', classe: 'NIDO A', rigaExcel: 3, nome: 'Prova  Gamma', dettaglio: 'Due spazi nel nome' },
    ],
  },
]

let elenchiDaServire: unknown[] = ELENCHI

function fetchFinto(input: RequestInfo | URL) {
  const url = String(input)
  if (url.includes('/api/admin/iscrizioni/elenco')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ elenchi: elenchiDaServire }) })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
}

beforeEach(() => {
  vi.clearAllMocks()
  elenchiDaServire = ELENCHI
  window.history.replaceState(null, '', '/admin/modulistica?tab=elenco-classi')
  vi.stubGlobal('fetch', vi.fn(fetchFinto))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

import { ElencoClassi } from '@/components/features/admin/iscrizioni/ElencoClassi'

async function montaEAspetta() {
  render(<ElencoClassi />)
  await waitFor(() => expect(screen.getByText('Kidville Giugliano')).toBeInTheDocument())
}

/** Le righe di difformità visibili, aperte tutte le tabelle che ci sono. */
function apriTutto() {
  for (const b of screen.queryAllByText(/\(mostra\)/)) fireEvent.click(b)
}

const dettagliVisibili = () =>
  screen.queryAllByRole('row').flatMap((r) => {
    const celle = within(r).queryAllByRole('cell')
    return celle.length === 3 ? [celle[2].textContent ?? ''] : []
  })

describe('ElencoClassi — la barra filtri sulle difformità', () => {
  it('la barra c’è e conta tutte le difformità dei fogli caricati', async () => {
    await montaEAspetta()
    expect(screen.getByLabelText('Cerca fra le difformità')).toBeInTheDocument()
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('4 risultati su 4')
  })

  it('«Solo quelle da correggere» lascia passare le bloccanti e scarta quelle da guardare', async () => {
    await montaEAspetta()
    fireEvent.click(screen.getByRole('switch', { name: 'Solo quelle da correggere' }))

    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('2 risultati su 4'),
    )
    apriTutto()
    const dettagli = dettagliVisibili().join(' | ')
    expect(dettagli).toContain('La cella del nome è vuota')
    expect(dettagli).toContain('Nome già presente alla riga 9')
    expect(dettagli).not.toContain('fuori scala')
    expect(dettagli).not.toContain('Due spazi nel nome')
  })

  it('il genere è un filtro a più scelte, e le voci nascono dalle difformità che ci sono', async () => {
    await montaEAspetta()
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    // Quattro generi distinti fra le quattro righe: nessuno inventato, nessuno mancante.
    const gruppo = screen.getByRole('group', { name: 'Filtri' })
    for (const etichetta of ['Nome mancante', 'Retta fuori scala', 'Nome ripetuto', 'Spazi anomali']) {
      expect(within(gruppo).getByRole('button', { name: new RegExp(`^${etichetta}`) })).toBeInTheDocument()
    }
    // Un genere che nei dati non c'è non deve comparire fra le scelte.
    expect(within(gruppo).queryByRole('button', { name: /^Classe senza sezione/ })).toBeNull()

    fireEvent.click(within(gruppo).getByRole('button', { name: /^Spazi anomali/ }))
    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('1 risultato su 4'),
    )
  })

  it('le classi fra cui scegliere vengono dai fogli, non dalle difformità: c’è anche quella pulita', async () => {
    await montaEAspetta()
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    const classe = screen.getByLabelText('Classe') as HTMLSelectElement
    expect([...classe.options].map((o) => o.textContent)).toEqual([
      'Tutti',
      'INFANZIA B',
      // «INFANZIA C» non ha nemmeno una difformità, ed è proprio la scelta che serve a
      // rispondere «questa classe è a posto?» — che un elenco costruito sulle difformità
      // non saprebbe nemmeno offrire.
      'INFANZIA C',
      'NIDO A',
      'PRIMAVERA A',
    ])

    fireEvent.change(classe, { target: { value: 'INFANZIA C' } })
    await waitFor(() =>
      expect(screen.getByText('Nessun risultato con questi filtri')).toBeInTheDocument(),
    )
  })

  it('la sede filtra le righe ma NON nasconde le card: il comando di caricamento resta', async () => {
    await montaEAspetta()
    fireEvent.change(screen.getByLabelText('Sede'), { target: { value: SEDE_B } })

    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('1 risultato su 4'),
    )
    // Le due card di sede ci sono ancora, con i loro comandi. Si prendono per INTESTAZIONE:
    // il nome del plesso compare anche nel chip del filtro, e cercarlo come testo qualunque
    // renderebbe questa prova verde per il motivo sbagliato.
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Kidville Giugliano',
      'Kidville Cesa',
    ])
    expect(screen.getAllByText('Sostituisci elenco')).toHaveLength(2)
  })

  it('🔴 la ricerca NON finisce nell’indirizzo: quel testo contiene il nome di un bambino', async () => {
    await montaEAspetta()
    fireEvent.change(screen.getByLabelText('Cerca fra le difformità'), {
      target: { value: 'Prova Beta' },
    })

    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('1 risultato su 4'),
    )
    expect(window.location.search).not.toContain('Prova')
    expect(window.location.search).not.toContain('q=')
    // E il parametro della linguetta, che non è suo, resta dov'è.
    expect(window.location.search).toContain('tab=elenco-classi')
  })

  it('a ZERO difformità si dice «vuoto», non «nessun risultato»', async () => {
    elenchiDaServire = [{ ...ELENCHI[0], anomalie: [] }]
    render(<ElencoClassi />)
    await waitFor(() => expect(screen.getByText('Nessuna difformità da guardare')).toBeInTheDocument())
    expect(screen.queryByText('Nessun risultato con questi filtri')).toBeNull()
  })

  it('senza nemmeno un elenco caricato la barra non si disegna: non c’è niente da filtrare', async () => {
    elenchiDaServire = []
    render(<ElencoClassi />)
    await waitFor(() => expect(screen.getAllByText('Carica elenco')).toHaveLength(2))
    expect(screen.queryByLabelText('Cerca fra le difformità')).toBeNull()
    // E nemmeno lo stato dell'elenco: la frase «Nessun elenco caricato» la dice già la card.
    expect(screen.queryByText('Nessuna difformità da guardare')).toBeNull()
  })
})
