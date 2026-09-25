import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react'

// =============================================================================
// «RIAPRI SCRUTINIO» ed «ELIMINA PAGELLA» — compito S3 della spec 2026-09-24.
//
// Fissa, per le due azioni distruttive dello scrutinio della primaria:
//  · si mostrano SOLO a Segreteria e Direzione (admin/coordinator/segreteria),
//    gli stessi ruoli dei gate di `scrutinio/riapri:POST` e `pagella:DELETE`;
//  · la conferma della riapertura SPIEGA le conseguenze: pubblicazione ritirata
//    (solo se c'era), pagelle PDF cancellate, firme di ricezione conservate;
//  · senza conferma non parte nessuna richiesta;
//  · la richiesta è ESATTAMENTE quella che la route accetta (metodo, URL, corpo);
//  · un rifiuto del server si legge a schermo dal CODICE (catalogo), si logga
//    senza il nome dell'alunno, e non chiama la callback di successo;
//  · la pagina dello scrutinio monta i due comandi per la Segreteria (che il
//    blocco «Dirigente» non vede) e non per la maestra;
//  · se la route dichiara `pagelleArchiviateNonLette`, la Segreteria legge un
//    avviso invece di un elenco vuoto indistinguibile da «nessuna pagella»;
//  · il ritorno dalla scheda di «Pagella PDF» ricarica UNA volta, lo scrutinio
//    del periodo selezionato ORA; niente listener con popup bloccato o a pagina
//    smontata.
//
// next-intl: override LOCALE del mock globale di test/setup.ts. Formatta allo
// stesso modo (catalogo italiano VERO, ICU solo quando arrivano valori), ma
// `useTranslations(ns)` restituisce SEMPRE la stessa funzione per namespace,
// come fa il vero next-intl finché lingua e messaggi non cambiano.
// Perché: il mock globale crea un `t` nuovo a ogni render; `loadScrutinio` ha
// `t` fra le dipendenze, cambia identità a ogni render e la pagina rilegge lo
// scrutinio DA SOLA, di continuo. Con quel `t` ogni asserzione «dopo l'azione
// parte una ricarica» era verde anche togliendo la ricarica dal codice (misurato
// dal critico al giro 3: `loadScrutinio()` tolto da `onRiaperto`, 20 su 20 verdi).
// Con il `t` stabile una GET dello scrutinio parte solo se la pagina la chiede.
// =============================================================================

vi.mock('next-intl', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { IntlMessageFormat } = await import('intl-messageformat')
  const cartella = join(process.cwd(), 'messages/it')
  const cataloghi: Record<string, Record<string, unknown>> = {}
  for (const file of readdirSync(cartella)) {
    if (file.endsWith('.json')) {
      cataloghi[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'))
    }
  }
  if (Object.keys(cataloghi).length === 0) throw new Error(`Nessun catalogo italiano in ${cartella}`)
  const risolvi = (ns: string | undefined, key: string): string => {
    const v = ns ? cataloghi[ns]?.[key] : undefined
    return typeof v === 'string' ? v : ns ? `${ns}.${key}` : key
  }
  const formatta = (messaggio: string, valori: Record<string, unknown>): string => {
    try {
      return String(new IntlMessageFormat(messaggio, 'it').format(valori))
    } catch {
      return messaggio
    }
  }
  // UNA funzione per namespace, memorizzata: è questo che rende stabile `t`.
  const perNamespace = new Map<string, unknown>()
  const useTranslations = (ns?: string) => {
    const chiave = ns ?? ''
    if (!perNamespace.has(chiave)) {
      const t = (key: string, valori?: Record<string, unknown>) =>
        valori === undefined ? risolvi(ns, key) : formatta(risolvi(ns, key), valori)
      perNamespace.set(
        chiave,
        Object.assign(t, {
          rich: (key: string) => risolvi(ns, key),
          markup: (key: string) => risolvi(ns, key),
          raw: (key: string) => risolvi(ns, key),
          has: () => true,
        }),
      )
    }
    return perNamespace.get(chiave)
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))

const nav = vi.hoisted(() => ({ params: { sectionId: '' }, search: new URLSearchParams() }))
vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useSearchParams: () => nav.search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/teacher/primaria/scrutinio',
}))

import {
  EliminaPagella,
  RiapriScrutinio,
  puoEliminarePagella,
  puoRiaprireScrutinio,
} from '@/components/features/primaria/AzioniScrutinio'
import ScrutinioPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/scrutinio/page'

const SEZIONE = 'aaaa1111-0000-4000-8000-0000000000a1'
const SCRUTINIO = 'bbbb2222-0000-4000-8000-0000000000b2'
const PERIODO = 'cccc3333-0000-4000-8000-0000000000c3'
const ALUNNO = 'dddd4444-0000-4000-8000-0000000000d4'
const OPERATORE = 'eeee5555-0000-4000-8000-0000000000e5'
const NOME = 'Rossi Mario'
// Un secondo alunno SENZA pagella archiviata: su di lui «Elimina pagella» non deve esserci.
const ALUNNO_B = 'ffff6666-0000-4000-8000-0000000000f6'
const NOME_B = 'Bianchi Anna'
// Il secondo periodo del selettore: serve a provare che la ricarica al focus
// segue il periodo selezionato ORA, non quello del clic su «Pagella PDF».
const PERIODO_2 = 'cccc3333-0000-4000-8000-0000000000c4'

const fetchMock = vi.fn()

function risposta(status: number, corpo: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => corpo })
}

beforeEach(() => {
  fetchMock.mockReset()
  h.logClient.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('chi vede i comandi', () => {
  it('Segreteria e Direzione sì, la maestra e il ruolo ignoto no (fail-closed)', () => {
    for (const r of ['admin', 'coordinator', 'segreteria']) {
      expect(puoRiaprireScrutinio(r)).toBe(true)
      expect(puoEliminarePagella(r)).toBe(true)
    }
    for (const r of ['educator', 'parent', 'cuoca', '', null, undefined]) {
      expect(puoRiaprireScrutinio(r)).toBe(false)
      expect(puoEliminarePagella(r)).toBe(false)
    }
  })

  it('alla maestra non si rende né «Riapri scrutinio» né «Elimina pagella»', () => {
    render(
      <>
        <RiapriScrutinio scrutinioId={SCRUTINIO} userId={OPERATORE} ruolo="educator" pubblicato onRiaperto={vi.fn()} />
        <EliminaPagella scrutinioId={SCRUTINIO} alunnoId={ALUNNO} nomeAlunno={NOME} userId={OPERATORE} ruolo="educator" onEliminata={vi.fn()} />
      </>,
    )
    expect(screen.queryByRole('button', { name: /riapri scrutinio/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /elimina pagella/i })).toBeNull()
  })
})

describe('«Riapri scrutinio»', () => {
  function monta(pubblicato = true, ruolo = 'segreteria') {
    const onRiaperto = vi.fn()
    render(<RiapriScrutinio scrutinioId={SCRUTINIO} userId={OPERATORE} ruolo={ruolo} pubblicato={pubblicato} onRiaperto={onRiaperto} />)
    fireEvent.click(screen.getByRole('button', { name: 'Riapri scrutinio' }))
    return { onRiaperto, dialogo: screen.getByRole('dialog') }
  }

  it('la conferma elenca le tre conseguenze, e senza conferma non parte niente', () => {
    const { dialogo } = monta(true)
    const conseguenze = within(dialogo).getByTestId('riapri-conseguenze')
    expect(conseguenze.textContent).toContain('La pubblicazione ai genitori viene ritirata')
    expect(conseguenze.textContent).toContain('Le pagelle PDF già generate vengono cancellate')
    expect(conseguenze.textContent).toContain('Le firme di ricezione dei genitori restano registrate')

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Annulla' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('su uno scrutinio NON pubblicato non promette un ritiro che non c’è', () => {
    const { dialogo } = monta(false)
    const conseguenze = within(dialogo).getByTestId('riapri-conseguenze')
    expect(conseguenze.textContent).not.toContain('pubblicazione')
    expect(conseguenze.textContent).toContain('Le firme di ricezione dei genitori restano registrate')
  })

  it('conferma → POST /riapri con il solo scrutinioId, poi il messaggio col numero di pagelle cancellate', async () => {
    fetchMock.mockImplementation(() =>
      risposta(200, { success: true, pagelleEliminate: 3, fileEliminati: 3, avvisiRitirati: 1 }),
    )
    const { onRiaperto, dialogo } = monta(true, 'admin')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Riapri e cancella le pagelle' }))

    await waitFor(() => expect(onRiaperto).toHaveBeenCalledTimes(1))
    expect(onRiaperto).toHaveBeenCalledWith('Scrutinio riaperto, 3 pagelle PDF cancellate ✓')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/primaria/scrutinio/riapri?userId=${OPERATORE}`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ scrutinioId: SCRUTINIO })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('senza pagelle da cancellare il messaggio non parla di PDF', async () => {
    fetchMock.mockImplementation(() => risposta(200, { success: true, pagelleEliminate: 0 }))
    const { onRiaperto, dialogo } = monta(false, 'coordinator')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Riapri e cancella le pagelle' }))
    await waitFor(() => expect(onRiaperto).toHaveBeenCalledWith('Scrutinio riaperto ✓'))
  })

  it('409 «non chiuso»: il testo viene dal CODICE, il log ha lo stato, la callback non parte', async () => {
    fetchMock.mockImplementation(() =>
      risposta(409, { error: 'Lo scrutinio non è chiuso', codice: 'SCRUTINIO_RIAPERTURA_NON_CHIUSO' }),
    )
    const { onRiaperto, dialogo } = monta()
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Riapri e cancella le pagelle' }))

    const avviso = await within(dialogo).findByRole('alert')
    expect(avviso.textContent).toBe('Lo scrutinio è già aperto: non c’è niente da riaprire. Ricarica la pagina.')
    expect(onRiaperto).not.toHaveBeenCalled()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'riapertura-scrutinio-rifiutata', stato: 409 }),
    )
    // La modale resta aperta: l'operatore legge perché, invece di credere che sia andata.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('rete assente: avviso tradotto e log, niente successo', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
    const { onRiaperto, dialogo } = monta()
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Riapri e cancella le pagelle' }))

    const avviso = await within(dialogo).findByRole('alert')
    expect(avviso.textContent).toBe('Connessione assente: riprova quando sei online.')
    expect(onRiaperto).not.toHaveBeenCalled()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'riapertura-scrutinio-non-inviata: TypeError' }),
    )
  })
})

describe('«Elimina pagella»', () => {
  function monta(ruolo = 'segreteria') {
    const onEliminata = vi.fn()
    render(
      <EliminaPagella
        scrutinioId={SCRUTINIO}
        alunnoId={ALUNNO}
        nomeAlunno={NOME}
        userId={OPERATORE}
        ruolo={ruolo}
        onEliminata={onEliminata}
      />,
    )
    return { onEliminata }
  }

  it('il bottone nomina l’alunno, e la conferma dice che scrutinio e firme restano', () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: `Elimina pagella di ${NOME}` }))
    const spiegazione = screen.getByTestId('elimina-pagella-spiegazione').textContent ?? ''
    expect(spiegazione).toContain(`Si cancella il PDF archiviato della pagella di ${NOME}.`)
    expect(spiegazione).toContain('la firma di ricezione del genitore resta registrata')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('conferma → DELETE con scrutinioId e alunnoId in query, poi il messaggio di successo', async () => {
    fetchMock.mockImplementation(() => risposta(200, { success: true, rigaEliminata: true, fileEliminati: 1 }))
    const { onEliminata } = monta('admin')
    fireEvent.click(screen.getByRole('button', { name: `Elimina pagella di ${NOME}` }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Elimina' }))

    await waitFor(() => expect(onEliminata).toHaveBeenCalledWith(`Pagella eliminata: ${NOME} ✓`))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const u = new URL(url, 'http://localhost')
    expect(u.pathname).toBe('/api/primaria/pagella')
    expect(u.searchParams.get('scrutinioId')).toBe(SCRUTINIO)
    expect(u.searchParams.get('alunnoId')).toBe(ALUNNO)
    // Il DELETE non deve portarsi dietro il `persist` del GET: sarebbe un altro endpoint.
    expect(u.searchParams.has('persist')).toBe(false)
    expect(init.method).toBe('DELETE')
  })

  it('404 «non c’è più»: testo dal codice, e il nome dell’alunno NON finisce nel log', async () => {
    fetchMock.mockImplementation(() =>
      risposta(404, { error: 'Pagella inesistente', codice: 'PAGELLA_ELIMINAZIONE_NON_TROVATA' }),
    )
    const { onEliminata } = monta()
    fireEvent.click(screen.getByRole('button', { name: `Elimina pagella di ${NOME}` }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Elimina' }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toBe('Questa pagella non c’è più: forse è già stata eliminata. Ricarica la pagina.')
    expect(onEliminata).not.toHaveBeenCalled()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'eliminazione-pagella-rifiutata', stato: 404 }),
    )
    const tuttiILog = JSON.stringify(h.logClient.mock.calls)
    expect(tuttiILog).not.toContain('Rossi')
    expect(tuttiILog).not.toContain('Mario')
  })
})

describe('la pagina dello scrutinio monta i comandi', () => {
  type StatoFinto = {
    chiuso: boolean
    archiviate?: string[]
    alunni?: { id: string; nome: string; cognome: string }[]
    getSospese?: boolean
    nonLette?: boolean
    // Esito della POST `/api/primaria/pagella/batch` («Genera pagelle»), e le
    // pagelle che il server dichiarerà archiviate dalle GET successive.
    batch?: { status: number; archivia?: string[] }
    // Dopo la POST `/riapri` le GET dello scrutinio restano IN MANO AL TEST:
    // rispondono solo quando il test chiama `rilascia()`.
    trattieniDopoRiapri?: boolean
    rilascia?: () => void
  }

  // Le GET dello scrutinio (quelle col periodoId) mandate DOPO l'indice `da`.
  function getScrutinioDopo(da: number) {
    return fetchMock.mock.calls
      .slice(da)
      .map(([u]) => new URL(String(u), 'http://localhost'))
      .filter((u) => u.pathname === '/api/primaria/scrutinio' && u.searchParams.has('periodoId'))
  }

  // Indice della prima chiamata a `pathname` con quel metodo (-1 se non c'è).
  function indiceDi(pathname: string, metodo: string) {
    return fetchMock.mock.calls.findIndex(
      ([u, i]) =>
        new URL(String(u), 'http://localhost').pathname === pathname &&
        (i as RequestInit | undefined)?.method === metodo,
    )
  }

  function instradaFetch(ruolo: string, stato: StatoFinto) {
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      const u = new URL(input, 'http://localhost')
      if (u.pathname === '/api/primaria/pagella' && init?.method === 'DELETE') {
        const id = u.searchParams.get('alunnoId')
        stato.archiviate = (stato.archiviate ?? [ALUNNO]).filter((x) => x !== id)
        // Seconda cintura: anche se una GET partisse, dopo il DELETE resterebbe
        // in sospeso, e il bottone potrebbe sparire solo per la rimozione
        // locale di `onEliminata` (quella che il test vuole provare).
        stato.getSospese = true
        return risposta(200, { success: true, rigaEliminata: true, fileEliminati: 1 })
      }
      if (u.pathname === '/api/primaria/pagella/batch' && init?.method === 'POST') {
        const b = stato.batch ?? { status: 200 }
        if (b.archivia) stato.archiviate = b.archivia
        return b.status === 200
          ? risposta(200, { success: true, generate: 1, totale: 1 })
          : risposta(b.status, { error: 'Generazione non riuscita' })
      }
      if (u.pathname === '/api/primaria/me') {
        return risposta(200, {
          success: true,
          data: { ruolo, isDirigente: ruolo === 'admin' || ruolo === 'coordinator' },
        })
      }
      if (u.pathname === '/api/primaria/scrutinio/riapri' && init?.method === 'POST') {
        stato.chiuso = false
        stato.trattieniDopoRiapri = true
        return risposta(200, { success: true, pagelleEliminate: 2, fileEliminati: 2, avvisiRitirati: 0 })
      }
      if (u.pathname === '/api/primaria/scrutinio' && !u.searchParams.get('periodoId')) {
        return risposta(200, {
          success: true,
          data: {
            periodi: [
              { id: PERIODO, nome: 'Primo quadrimestre', anno_scolastico: '2025/26' },
              { id: PERIODO_2, nome: 'Secondo quadrimestre', anno_scolastico: '2025/26' },
            ],
          },
        })
      }
      if (u.pathname === '/api/primaria/scrutinio') {
        if (stato.getSospese) return new Promise(() => {})
        // Il corpo si calcola quando la risposta PARTE: una GET trattenuta porta
        // lo stato del momento in cui il test la rilascia.
        const corpo = () => ({
          success: true,
          data: {
            scrutinio: {
              id: SCRUTINIO,
              stato: stato.chiuso ? 'chiuso' : 'aperto',
              chiuso_il: stato.chiuso ? '2026-02-10T10:00:00Z' : null,
              pubblicato: stato.chiuso,
            },
            alunni: stato.alunni ?? [{ id: ALUNNO, nome: 'Mario', cognome: 'Rossi' }],
            materie: [],
            mieMaterieIds: [],
            scala: [],
            giudizi: [],
            comportamento: [],
            pagelleArchiviate: stato.chiuso ? (stato.archiviate ?? [ALUNNO]) : [],
            pagelleArchiviateNonLette: stato.nonLette === true,
          },
        })
        if (stato.trattieniDopoRiapri) {
          return new Promise((ok) => {
            stato.rilascia = () => ok({ ok: true, status: 200, json: async () => corpo() })
          })
        }
        return risposta(200, corpo())
      }
      return risposta(404, { error: 'rotta non prevista dal test' })
    })
  }

  beforeEach(() => {
    nav.params = { sectionId: SEZIONE }
    nav.search = new URLSearchParams(`userId=${OPERATORE}`)
  })

  it('la Segreteria vede «Riapri scrutinio» e «Elimina pagella»; la riapertura ricarica lo scrutinio aperto', async () => {
    const stato: StatoFinto = { chiuso: true }
    instradaFetch('segreteria', stato)
    render(<ScrutinioPage />)

    const riapri = await screen.findByRole('button', { name: 'Riapri scrutinio' })
    expect(screen.getByRole('button', { name: `Elimina pagella di ${NOME}` })).toBeTruthy()
    // Il blocco «Dirigente» (genera/pubblica) resta alla sola Direzione.
    expect(screen.queryByRole('button', { name: /pubblica/i })).toBeNull()
    // Con `t` stabile la pagina non rilegge da sola: finora UNA GET dello scrutinio.
    expect(getScrutinioDopo(0)).toHaveLength(1)

    fireEvent.click(riapri)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Riapri e cancella le pagelle' }))

    expect(await screen.findByText('Scrutinio riaperto, 2 pagelle PDF cancellate ✓')).toBeTruthy()
    // Dopo la POST parte UNA GET dello scrutinio, del periodo corrente: è la
    // ricarica di `onRiaperto`. Senza di lei non partirebbe niente.
    const iPost = indiceDi('/api/primaria/scrutinio/riapri', 'POST')
    expect(iPost).toBeGreaterThanOrEqual(0)
    await waitFor(() => expect(getScrutinioDopo(iPost)).toHaveLength(1))
    const ricarica = getScrutinioDopo(iPost)[0]
    expect(ricarica.searchParams.get('periodoId')).toBe(PERIODO)
    expect(ricarica.searchParams.get('sectionId')).toBe(SEZIONE)

    // Finché QUELLA risposta non arriva, a schermo lo scrutinio resta chiuso:
    // lo stato «Aperto» lo porta solo la ricarica, non il resto della pagina.
    expect(screen.getByText('Chiuso il', { exact: false })).toBeTruthy()
    expect(screen.queryByText('Aperto — proposta giudizi')).toBeNull()
    expect(stato.rilascia).toBeTypeOf('function')
    await act(async () => {
      stato.rilascia?.()
    })

    expect(await screen.findByText('Aperto — proposta giudizi')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Riapri scrutinio' })).toBeNull()
    expect(screen.queryByRole('button', { name: `Elimina pagella di ${NOME}` })).toBeNull()
    // Una sola ricarica: nessun ciclo di GET figlio dei render.
    expect(getScrutinioDopo(iPost)).toHaveLength(1)
  })

  it('Direzione: «Genera pagelle» riuscito ricarica, e compare «Elimina pagella» per la pagella appena archiviata', async () => {
    const stato: StatoFinto = { chiuso: true, archiviate: [], batch: { status: 200, archivia: [ALUNNO] } }
    instradaFetch('admin', stato)
    render(<ScrutinioPage />)

    const genera = await screen.findByRole('button', { name: /Genera pagelle/ })
    expect(screen.getByRole('button', { name: /Pagella PDF/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Elimina pagella/ })).toBeNull()
    expect(getScrutinioDopo(0)).toHaveLength(1)

    fireEvent.click(genera)

    expect(await screen.findByRole('button', { name: `Elimina pagella di ${NOME}` })).toBeTruthy()
    expect(screen.getByText('Generata 1/1 pagella ✓')).toBeTruthy()
    const iPost = indiceDi('/api/primaria/pagella/batch', 'POST')
    expect(iPost).toBeGreaterThanOrEqual(0)
    const [, initPost] = fetchMock.mock.calls[iPost] as [string, RequestInit]
    expect(JSON.parse(String(initPost.body))).toEqual({ scrutinioId: SCRUTINIO })
    const ricariche = getScrutinioDopo(iPost)
    expect(ricariche).toHaveLength(1)
    expect(ricariche[0].searchParams.get('periodoId')).toBe(PERIODO)
  })

  it('Direzione: «Genera pagelle» rifiutato non ricarica', async () => {
    // Il finto dichiarerebbe comunque archiviata la pagella: se la pagina
    // ricaricasse, «Elimina pagella» comparirebbe. Il conteggio delle GET lo dice.
    const stato: StatoFinto = { chiuso: true, archiviate: [], batch: { status: 500, archivia: [ALUNNO] } }
    instradaFetch('admin', stato)
    render(<ScrutinioPage />)

    fireEvent.click(await screen.findByRole('button', { name: /Genera pagelle/ }))

    // PRESENZA prima delle assenze: il messaggio d'errore è a schermo, e la
    // ricarica (se ci fosse) sarebbe partita nello stesso giro di `setMsg`.
    expect(await screen.findByText('Generazione non riuscita')).toBeTruthy()
    const iPost = indiceDi('/api/primaria/pagella/batch', 'POST')
    expect(iPost).toBeGreaterThanOrEqual(0)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(getScrutinioDopo(iPost)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Elimina pagella/ })).toBeNull()
  })

  it('«Elimina pagella» solo dove il PDF è archiviato, e sparisce dopo l’eliminazione', async () => {
    const stato = {
      chiuso: true,
      archiviate: [ALUNNO],
      alunni: [
        { id: ALUNNO, nome: 'Mario', cognome: 'Rossi' },
        { id: ALUNNO_B, nome: 'Anna', cognome: 'Bianchi' },
      ],
    }
    instradaFetch('segreteria', stato)
    render(<ScrutinioPage />)

    // PRESENZA prima delle assenze: le due righe «Pagella PDF» ci sono entrambe.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Pagella PDF/ })).toHaveLength(2))
    const elimina = await screen.findByRole('button', { name: `Elimina pagella di ${NOME}` })
    expect(screen.queryByRole('button', { name: `Elimina pagella di ${NOME_B}` })).toBeNull()

    fireEvent.click(elimina)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Elimina' }))

    expect(await screen.findByText(`Pagella eliminata: ${NOME} ✓`)).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // `hidden: true`: l'assenza deve essere vera, non un bottone solo nascosto
    // dall'inert della modale che si sta chiudendo.
    expect(screen.queryByRole('button', { name: `Elimina pagella di ${NOME}`, hidden: true })).toBeNull()
    // Le righe restano: si toglie il comando, non l'alunno.
    expect(screen.getAllByRole('button', { name: /Pagella PDF/ })).toHaveLength(2)
    const del = fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE')
    expect(del).toHaveLength(1)
    expect(new URL(String(del[0][0]), 'http://localhost').searchParams.get('alunnoId')).toBe(ALUNNO)
  })

  it('senza nessuna pagella archiviata non c’è nessun «Elimina pagella»', async () => {
    instradaFetch('segreteria', { chiuso: true, archiviate: [] })
    render(<ScrutinioPage />)
    expect(await screen.findByRole('button', { name: 'Riapri scrutinio' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Pagella PDF/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Elimina pagella/ })).toBeNull()
  })

  it('la maestra vede la pagella PDF ma non i due comandi', async () => {
    instradaFetch('educator', { chiuso: true })
    render(<ScrutinioPage />)

    // Si aspetta una PRESENZA (la riga della pagella) prima di contare le assenze.
    expect(await screen.findByRole('button', { name: /Pagella PDF/ })).toBeTruthy()
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/primaria/me'))).toBe(true),
    )
    expect(screen.queryByRole('button', { name: 'Riapri scrutinio' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Elimina pagella/ })).toBeNull()
  })

  it('lettura delle pagelle non riuscita: la Segreteria legge un avviso, non un elenco vuoto muto', async () => {
    instradaFetch('segreteria', { chiuso: true, archiviate: [], nonLette: true })
    render(<ScrutinioPage />)

    const avviso = await screen.findByText(
      'Non è stato possibile verificare quali pagelle sono archiviate: ricarica la pagina per poterle eliminare.',
    )
    expect(avviso.getAttribute('role')).toBe('status')
    expect(screen.getByRole('button', { name: /Pagella PDF/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Elimina pagella/ })).toBeNull()
  })

  it('l’avviso di lettura non riuscita non compare alla maestra, che non può eliminare', async () => {
    instradaFetch('educator', { chiuso: true, archiviate: [], nonLette: true })
    render(<ScrutinioPage />)
    expect(await screen.findByRole('button', { name: /Pagella PDF/ })).toBeTruthy()
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/primaria/me'))).toBe(true),
    )
    expect(screen.queryByText(/Non è stato possibile verificare quali pagelle/)).toBeNull()
  })
})

describe('«Pagella PDF»: la ricarica al ritorno sulla pagina', () => {
  // Le GET dello scrutinio (quelle col periodoId) mandate DOPO l'indice `da`.
  function getScrutinioDopo(da: number) {
    return fetchMock.mock.calls
      .slice(da)
      .map(([u]) => new URL(String(u), 'http://localhost'))
      .filter((u) => u.pathname === '/api/primaria/scrutinio' && u.searchParams.has('periodoId'))
  }

  // Monta la pagina su uno scrutinio chiuso, poi FERMA le GET. Col `t` stabile
  // dell'override in testa al file la pagina non rilegge più da sola; il fermo
  // resta come seconda cintura: ogni GET contata dopo è figlia dell'evento che
  // il test provoca, e nessuna risposta tardiva cambia la pagina sotto al test.
  async function montaEFerma(finestra: Window | null) {
    const stato: { chiuso: boolean; getSospese?: boolean } = { chiuso: true }
    // Stesso router della describe della pagina, riscritto qui in piccolo.
    fetchMock.mockImplementation((input: string) => {
      const u = new URL(input, 'http://localhost')
      if (u.pathname === '/api/primaria/me') {
        return risposta(200, { success: true, data: { ruolo: 'segreteria', isDirigente: false } })
      }
      if (u.pathname === '/api/primaria/scrutinio' && !u.searchParams.get('periodoId')) {
        return risposta(200, {
          success: true,
          data: {
            periodi: [
              { id: PERIODO, nome: 'Primo quadrimestre', anno_scolastico: '2025/26' },
              { id: PERIODO_2, nome: 'Secondo quadrimestre', anno_scolastico: '2025/26' },
            ],
          },
        })
      }
      if (u.pathname === '/api/primaria/scrutinio') {
        if (stato.getSospese) return new Promise(() => {})
        return risposta(200, {
          success: true,
          data: {
            scrutinio: { id: SCRUTINIO, stato: 'chiuso', chiuso_il: '2026-02-10T10:00:00Z', pubblicato: false },
            alunni: [{ id: ALUNNO, nome: 'Mario', cognome: 'Rossi' }],
            materie: [],
            mieMaterieIds: [],
            scala: [],
            giudizi: [],
            comportamento: [],
            pagelleArchiviate: [],
            pagelleArchiviateNonLette: false,
          },
        })
      }
      return risposta(404, { error: 'rotta non prevista dal test' })
    })
    const open = vi.fn<(url?: string | URL, target?: string) => Window | null>(() => finestra)
    vi.stubGlobal('open', open)
    const vista = render(<ScrutinioPage />)
    const pdf = await screen.findByRole('button', { name: /Pagella PDF/ })
    stato.getSospese = true
    // Lascia esaurire le GET già risolte (e i render che portano con sé).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    return { pdf, open, vista }
  }

  beforeEach(() => {
    nav.params = { sectionId: SEZIONE }
    nav.search = new URLSearchParams(`userId=${OPERATORE}`)
  })

  it('più clic, cambio di periodo, poi focus: UNA ricarica, e del periodo selezionato ORA', async () => {
    const { pdf, open } = await montaEFerma({} as Window)
    fireEvent.click(pdf)
    fireEvent.click(pdf)
    fireEvent.click(pdf)
    expect(open).toHaveBeenCalledTimes(3)
    expect(new URL(String(open.mock.calls[0][0]), 'http://localhost').searchParams.get('persist')).toBe('1')

    // L'operatore passa al secondo quadrimestre PRIMA di tornare sulla pagina.
    fireEvent.change(screen.getByDisplayValue('Primo quadrimestre (2025/26)'), { target: { value: PERIODO_2 } })
    await waitFor(() =>
      expect(getScrutinioDopo(0).some((u) => u.searchParams.get('periodoId') === PERIODO_2)).toBe(true),
    )

    const prima = fetchMock.mock.calls.length
    fireEvent.focus(window)
    const ricariche = getScrutinioDopo(prima)
    expect(ricariche).toHaveLength(1)
    expect(ricariche[0].searchParams.get('periodoId')).toBe(PERIODO_2)

    // Scattato una volta, il listener è disarmato: un secondo focus non ricarica.
    const dopo = fetchMock.mock.calls.length
    fireEvent.focus(window)
    expect(getScrutinioDopo(dopo)).toHaveLength(0)
  })

  it('popup bloccato (window.open → null): nessuna ricarica armata', async () => {
    const { pdf, open } = await montaEFerma(null)
    fireEvent.click(pdf)
    expect(open).toHaveBeenCalledTimes(1)
    const prima = fetchMock.mock.calls.length
    fireEvent.focus(window)
    expect(getScrutinioDopo(prima)).toHaveLength(0)
  })

  it('pagina smontata prima del ritorno: il listener se ne va con lei', async () => {
    const { pdf, vista } = await montaEFerma({} as Window)
    fireEvent.click(pdf)
    vista.unmount()
    const prima = fetchMock.mock.calls.length
    fireEvent.focus(window)
    expect(getScrutinioDopo(prima)).toHaveLength(0)
  })
})
