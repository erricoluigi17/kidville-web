import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PAGINAZIONE + FILTRO SERVER — il rischio numero uno di tutto il lavoro  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * L'elenco delle candidature carica a pagine (`offset=righe.length`) e accoda
 * deduplicando per `id`. Con un filtro che vive sul SERVER, cambiare filtro
 * senza svuotare l'accumulo significa che «Mostra altre» chiede `offset=50`
 * contando righe del risultato VECCHIO e riceve la pagina 2 del risultato NUOVO:
 * due insiemi diversi fusi in una lista sola, con lo stesso aspetto, e un totale
 * che non torna con nessuno dei due. Nessun errore, nessun log: solo righe che
 * non c'entrano, in mezzo a righe che c'entrano.
 *
 * Il criterio di accettazione è questo, e si misura fino in fondo: con
 * «Rifiutata» selezionato e premendo «Mostra altre» finché il pulsante sparisce,
 * **nessuna riga a schermo appartiene a un altro stato**, e il totale annunciato
 * coincide con il numero di righe rese.
 *
 * Il finto server FILTRA e PAGINA davvero: se il componente smettesse di mandare
 * la chiave dei filtri, o mandasse l'offset sbagliato, le righe che arrivano
 * sarebbero altre — e il test lo vedrebbe.
 *
 * ⚠️ Nomi inventati: il repository è pubblico.
 */

const SEDE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const PAGINA = 50

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))
vi.mock('@/lib/context/admin-identity', () => ({ useAdminIdentity: () => ({ ruolo: 'admin' }) }))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE, nome: 'Kidville Alfa' }],
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
}))

interface Finta {
  id: string
  scuola_id: string
  stato: string
  nome: string
  cognome: string
  posizioni: string[]
  gradi: string[]
  creata_il: string
  candidature_sedi: { scuola_id: string; stato: string }[]
}

/**
 * 120 candidature: 70 RIFIUTATE e 50 in attesa, mescolate.
 *
 * ⚠️ I numeri sono scelti, non presi a caso. Le rifiutate devono essere PIÙ di
 * una pagina (70 > 50), altrimenti la pagina 0 le conterrebbe tutte, «Mostra
 * altre» non comparirebbe mai e il test passerebbe senza aver mai paginato —
 * cioè senza misurare la cosa per cui esiste. E le righe «in attesa» devono
 * essere abbastanza da riempire la pagina 0 dell'insieme NON filtrato: sono
 * quelle che resterebbero a schermo se l'accumulo non si azzerasse.
 */
const TUTTE: Finta[] = Array.from({ length: 120 }, (_, i) => {
  const rifiutata = i % 12 < 7 // 7 su 12 ⇒ 70 rifiutate su 120, cioè DUE pagine
  const stato = rifiutata ? 'rifiutata' : 'pending'
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    scuola_id: SEDE,
    stato,
    nome: rifiutata ? 'Respinta' : 'Attesa',
    cognome: `Numero${i}`,
    posizioni: ['insegnante_infanzia'],
    gradi: ['infanzia'],
    creata_il: '2026-08-20T10:00:00.000Z',
    candidature_sedi: [{ scuola_id: SEDE, stato }],
  }
})
const RIFIUTATE = TUTTE.filter((c) => c.stato === 'rifiutata')

/** Ogni URL d'elenco osservata: prova che la chiave dei filtri viaggia davvero. */
let urlChieste: string[] = []
/** Quando è vero, l'elenco risponde 503: serve al test del riazzeramento. */
let elencoInGuasto = false

function fetchFinto(input: RequestInfo | URL) {
  const url = String(input)
  if (!url.includes('/api/admin/candidature-insegnanti')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  }
  urlChieste.push(url)
  if (elencoInGuasto) {
    return Promise.resolve({
      ok: false,
      status: 503,
      json: async () => ({ error: 'non disponibile', codice: 'CANDIDATURE_OPERAZIONE_NON_RIUSCITA' }),
    })
  }
  const q = new URL(url, 'http://localhost').searchParams
  const stato = q.get('stato')
  const limit = Number(q.get('limit') ?? PAGINA)
  const offset = Number(q.get('offset') ?? 0)
  // Il filtro si applica sulla RIGA DI SEDE, come fa la rotta vera.
  const filtrate = stato
    ? TUTTE.filter((c) => c.candidature_sedi.some((s) => s.stato === stato))
    : TUTTE
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      data: filtrate.slice(offset, offset + limit),
      total: filtrate.length,
      totaleLinguetta: TUTTE.length,
      limit,
      offset,
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  urlChieste = []
  elencoInGuasto = false
  window.history.replaceState(null, '', '/admin/modulistica?tab=candidature')
  vi.stubGlobal('fetch', vi.fn(fetchFinto))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

import { CandidatureInsegnanti } from '@/components/features/admin/iscrizioni/CandidatureInsegnanti'

/** I cognomi delle righe a schermo: l'unico modo di sapere QUALI righe ci sono. */
const cognomiVisibili = () =>
  TUTTE.filter((c) => screen.queryByText(`${c.nome} ${c.cognome}`) !== null).map((c) => c.cognome)

async function caricaTutte() {
  // «Mostra altre» finché non sparisce: è il gesto che il criterio descrive.
  for (let giro = 0; giro < 10; giro++) {
    const bottone = screen.queryByRole('button', { name: 'Mostra altre candidature' })
    if (!bottone) return
    fireEvent.click(bottone)
    await waitFor(() => expect(screen.queryByRole('button', { name: /Mostra altre/ })).not.toBeDisabled(), {
      timeout: 8000,
    }).catch(() => undefined)
    await waitFor(() => expect(cognomiVisibili().length).toBeGreaterThan(0))
  }
  throw new Error('«Mostra altre» non è mai sparito: la paginazione non termina')
}

describe('CandidatureInsegnanti — filtro server e paginazione insieme', () => {
  it('all’apertura mostra la prima pagina e dichiara il totale della linguetta', async () => {
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(cognomiVisibili().length).toBe(PAGINA))
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('120 risultati su 120')
  })

  it('🔴 con «Rifiutata» e «Mostra altre» fino in fondo: nessuna riga di un altro stato', async () => {
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(cognomiVisibili().length).toBe(PAGINA))

    // La pastiglia di stato: è un `chip`, cioè un bottone `aria-pressed`.
    fireEvent.click(screen.getByRole('button', { name: 'Rifiutata' }))

    // ⚠️ SI ASPETTA IL CONTEGGIO ANNUNCIATO, non la lunghezza della pagina: le
    // righe sono cinquanta prima e dopo il filtro, quindi aspettare «cinquanta
    // righe» passerebbe oltre SUBITO, prima ancora che il debounce sia scaduto —
    // e il test misurerebbe l'elenco vecchio credendolo il nuovo.
    await waitFor(
      () =>
        expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent(
          `${RIFIUTATE.length} risultati su ${TUTTE.length}`,
        ),
      { timeout: 8000 },
    )
    await caricaTutte()

    const visti = cognomiVisibili()
    // 1. Tutte le rifiutate, e SOLO quelle.
    expect(new Set(visti)).toEqual(new Set(RIFIUTATE.map((c) => c.cognome)))
    expect(visti).toHaveLength(RIFIUTATE.length)
    // 2. Nessuna riga «in attesa» è sopravvissuta al cambio di filtro: è la
    //    fusione dei due insiemi che questo test esiste per escludere.
    expect(screen.queryByText(/^Attesa /)).toBeNull()
    // 3. Il totale annunciato coincide con le righe rese.
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent(
      `${RIFIUTATE.length} risultati su ${TUTTE.length}`,
    )
  })

  it('🔴 nei 300 ms di debounce «Mostra altre» è SPENTO: chiederebbe la pagina del filtro vecchio', async () => {
    // La finestra è stretta e reale: `chiaveServer` è attesa (300 ms), quindi
    // fra il clic sulla pastiglia e la partenza della richiesta il componente ha
    // ancora la chiave VECCHIA e cinquanta righe vecchie in memoria. Un clic su
    // «Mostra altre» lì dentro chiede `offset=50` SENZA il filtro e accoda il
    // risultato a un elenco che sta per essere sostituito.
    //
    // Misurato: senza la condizione `filtri.inAttesa` sul pulsante, in questo
    // punto parte davvero una richiesta con `offset=50` e senza `stato=`.
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(cognomiVisibili().length).toBe(PAGINA))
    expect(screen.getByRole('button', { name: 'Mostra altre candidature' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Rifiutata' }))
    expect(screen.getByRole('button', { name: 'Mostra altre candidature' })).toBeDisabled()

    // …e quando la richiesta è arrivata, il pulsante torna premibile.
    await waitFor(
      () =>
        expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent(
          `${RIFIUTATE.length} risultati su ${TUTTE.length}`,
        ),
      { timeout: 8000 },
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mostra altre candidature' })).not.toBeDisabled(),
    )
  })

  it('la chiave dei filtri viaggia in OGNI richiesta, pagine successive comprese', async () => {
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(cognomiVisibili().length).toBe(PAGINA))
    fireEvent.click(screen.getByRole('button', { name: 'Rifiutata' }))
    await waitFor(
      () =>
        expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent(
          `${RIFIUTATE.length} risultati su ${TUTTE.length}`,
        ),
      { timeout: 8000 },
    )
    await caricaTutte()

    const conFiltro = urlChieste.filter((u) => u.includes('stato=rifiutata'))
    // Almeno la pagina 0 e una pagina successiva.
    expect(conFiltro.length).toBeGreaterThanOrEqual(2)
    // …e almeno UNA di quelle è una pagina successiva: senza questa riga il test
    // resterebbe verde su un insieme che sta tutto nella prima pagina, cioè
    // senza aver mai paginato.
    expect(conFiltro.some((u) => /offset=(?!0\b)\d+/.test(u))).toBe(true)
    // ⚠️ E ogni richiesta con offset > 0 DEVE portarlo: una pagina successiva
    // senza filtro tornerebbe dall'insieme intero, e si accoderebbe a quello
    // filtrato senza che niente lo mostri.
    const conOffset = urlChieste.filter((u) => /offset=(?!0\b)\d+/.test(u))
    expect(conOffset.length).toBeGreaterThan(0)
    for (const u of conOffset) expect(u).toContain('stato=rifiutata')
  })

  it('🔴 se la lettura del NUOVO filtro fallisce, le righe del VECCHIO non restano a schermo', async () => {
    // È il caso che il riazzeramento esiste per coprire, e l'unico in cui il
    // pulsante disabilitato non basta: la pagina 0 del nuovo insieme non arriva
    // mai, quindi non c'è nessun `setRighe(...)` che sostituisca le vecchie.
    // Senza svuotare l'accumulo, a schermo resterebbero cinquanta righe «in
    // attesa» sotto una pastiglia «Rifiutata» accesa — e «Mostra altre»
    // chiederebbe `offset=50` sul risultato filtrato, accodando le rifiutate
    // alle righe di un altro insieme.
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(cognomiVisibili().length).toBe(PAGINA))
    expect(screen.queryAllByText(/^Attesa /).length).toBeGreaterThan(0)

    elencoInGuasto = true
    fireEvent.click(screen.getByRole('button', { name: 'Rifiutata' }))

    // ⚠️ ATTESA LARGA, e la ragione va scritta. Il debounce di `useFiltri` è un
    // `setTimeout` REALE di 300 ms: con la suite intera in parallelo su mille
    // corsie, quei 300 ms diventano molti di più, e un `timeout` stretto rende
    // rosso un componente sano — cioè un test che passa solo al retry, che in
    // questo repo non è un test. Qui l'attesa non nasconde niente: la condizione
    // misurata è definitiva (le righe vecchie non tornano più), quindi aspettare
    // di più non può far passare un difetto.
    await waitFor(() => expect(cognomiVisibili()).toHaveLength(0), { timeout: 8000 })
    // Nessuna riga del vecchio insieme è sopravvissuta a un filtro che non è
    // mai stato applicato.
    expect(screen.queryByText(/^Attesa /)).toBeNull()
    expect(screen.queryByText(/^Respinta /)).toBeNull()
  })

  it('togliendo il filtro l’elenco torna intero, senza doppioni', async () => {
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(cognomiVisibili().length).toBe(PAGINA))
    fireEvent.click(screen.getByRole('button', { name: 'Rifiutata' }))
    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent(
        `${RIFIUTATE.length} risultati su ${TUTTE.length}`,
      ),
    )

    // Ripremendo la pastiglia il filtro si revoca (non è un radio: si può togliere).
    fireEvent.click(screen.getByRole('button', { name: 'Rifiutata' }))
    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent(
        `${TUTTE.length} risultati su ${TUTTE.length}`,
      ),
    )
    const visti = cognomiVisibili()
    // Nessun doppione: la lista è ripartita da zero, non si è sommata alla precedente.
    expect(new Set(visti).size).toBe(visti.length)
    expect(visti).toHaveLength(PAGINA)
  })
})
