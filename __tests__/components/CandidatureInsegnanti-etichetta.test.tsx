import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

// ⚠️ Le frasi si prendono dal CATALOGO, mai ricopiate qui: un testo congelato in
// un test rende rosso il giorno in cui qualcuno migliora una parola, e verde il
// giorno in cui la chiave sbagliata mostra la frase giusta per caso.
import itAdminAltro from '../../messages/it/adminAltro.json'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  L'ETICHETTA DI SELEZIONE, dal lato di chi la usa                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── PERCHÉ QUESTO FILE, E PERCHÉ IL FINTO SERVER DISTINGUE DUE URL ──────────
 *
 * Il pannello parla con DUE rotte diverse, e non per eleganza: l'elenco arriva
 * da `…/candidature-insegnanti`, le etichette da `…/candidature-insegnanti/etichetta`,
 * che è una rotta a sé perché di lì non si possa raggiungere un percorso d'invio
 * email (lock `etichetta-candidatura-senza-email.test.ts`).
 *
 * I 118 test già esistenti del pannello sono rimasti VERDI quando quella seconda
 * `fetch` è comparsa prima di ogni caricamento: i loro finti rispondono UGUALE a
 * qualunque URL cominci per `/api/admin/candidature-insegnanti`, quindi la
 * chiamata nuova è passata inosservata. È il «mock piatto» che in questo
 * repository ha già lasciato passare un difetto con 13.254 test verdi.
 *
 * Perciò qui il finto server SEPARA i due percorsi e li registra: se il pannello
 * chiedesse le etichette alla rotta dell'elenco (o viceversa), riceverebbe un
 * corpo che non c'entra e i test qui sotto lo vedrebbero — invece di passare
 * misurando la stessa risposta due volte. La prova che la separazione MORDE è
 * scritta nel primo test: la mappa che arriva è quella della rotta giusta, e
 * l'elenco NON contiene la colonna `etichetta`.
 *
 * ── COSA SI MISURA ─────────────────────────────────────────────────────────
 *
 *  · il menu di ogni riga nasce sul valore che la mappa dice (non su '');
 *  · dove la colonna NON esiste (database E2E della CI, non migrato) il menu
 *    SPARISCE: un menu che non salva niente è peggio di nessun menu;
 *  · scrivere un'etichetta passa dalla rotta dell'etichetta, con `null` per
 *    toglierla — e mai dalla rotta dell'elenco, che è quella che le email le
 *    manda davvero;
 *  · quando la mappa è TAGLIATA il filtro si spegne, perché un filtro su una
 *    mappa parziale mostra meno candidature di quante ce ne sono.
 *
 * ⚠️ Nomi e uuid inventati: il repository è pubblico.
 */

const SEDE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const API = '/api/admin/candidature-insegnanti'

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

const CON_ETICHETTA = '00000000-0000-4000-8000-00000000000a'
const SENZA = '00000000-0000-4000-8000-00000000000b'

/**
 * Le righe dell'ELENCO, e badate: NON portano la colonna `etichetta`.
 *
 * Non è una semplificazione del finto — è il contratto della rotta vera, che
 * quella colonna non la proietta. Se il pannello disegnasse il menu a partire
 * dalla riga invece che dalla mappa, qui sarebbe sempre vuoto.
 */
const RIGHE = [
  {
    id: CON_ETICHETTA,
    scuola_id: SEDE,
    stato: 'pending',
    nome: 'Prima',
    cognome: 'Candidata',
    posizioni: ['insegnante_infanzia'],
    gradi: ['infanzia'],
    creata_il: '2026-09-01T10:00:00.000Z',
    candidature_sedi: [{ scuola_id: SEDE, stato: 'pending' }],
  },
  {
    id: SENZA,
    scuola_id: SEDE,
    stato: 'pending',
    nome: 'Seconda',
    cognome: 'Candidata',
    posizioni: ['insegnante_nido'],
    gradi: ['nido'],
    creata_il: '2026-09-02T10:00:00.000Z',
    candidature_sedi: [{ scuola_id: SEDE, stato: 'pending' }],
  },
]

/** La risposta della rotta DELLE ETICHETTE, pilotabile test per test. */
let mappa: { data: { id: string; etichetta: string; etichetta_aggiornata_il: string }[]; total: number; colonnaAssente: boolean }
/** Ogni chiamata osservata, con il metodo e il corpo: è qui che si vede a CHI si è parlato. */
let chiamate: { url: string; metodo: string; corpo: unknown }[] = []

function fetchFinto(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input)
  const metodo = (init?.method ?? 'GET').toUpperCase()
  const corpo = init?.body ? JSON.parse(String(init.body)) : null
  chiamate.push({ url, metodo, corpo })

  // ⚠️ LA SEPARAZIONE. `…/etichetta` PRIMA di `…?limit=`: l'ordine conta, perché
  // le due URL condividono il prefisso ed è esattamente la coincidenza su cui un
  // finto piatto scivola.
  if (url.startsWith(`${API}/etichetta`)) {
    if (metodo === 'PATCH') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { id: (corpo as { id: string }).id } }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => mappa })
  }
  if (url.startsWith(API)) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ data: RIGHE, total: RIGHE.length, totaleLinguetta: RIGHE.length, limit: 50, offset: 0 }),
    })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
}

beforeEach(() => {
  vi.clearAllMocks()
  chiamate = []
  mappa = {
    data: [{ id: CON_ETICHETTA, etichetta: 'da_richiamare', etichetta_aggiornata_il: '2026-09-05T09:00:00.000Z' }],
    total: 1,
    colonnaAssente: false,
  }
  window.history.replaceState(null, '', '/admin/modulistica?tab=candidature')
  vi.stubGlobal('fetch', vi.fn(fetchFinto))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

import { CandidatureInsegnanti } from '@/components/features/admin/iscrizioni/CandidatureInsegnanti'

/**
 * I due controlli si CHIAMANO uguale a schermo — «Etichetta» il filtro,
 * «Etichetta» il menu di ogni riga — e uno filtra mentre l'altro SCRIVE. Cercarli
 * per etichetta visibile prenderebbe il primo dei due, cioè un test che passa
 * guardando il controllo sbagliato: si cercano per `id`, che nel markup è unico.
 */
const filtro = () => document.getElementById('filtro-etichetta') as HTMLSelectElement | null
const menuDi = (id: string) => document.getElementById(`etichetta-${id}`) as HTMLSelectElement | null

const attendiElenco = () => waitFor(() => expect(screen.getByText('Prima Candidata')).toBeInTheDocument())

const versoEtichetta = () => chiamate.filter((c) => c.url.startsWith(`${API}/etichetta`))
const versoElenco = () => chiamate.filter((c) => !c.url.startsWith(`${API}/etichetta`) && c.url.startsWith(API))

describe('CandidatureInsegnanti — l’etichetta di selezione', () => {
  it('🔴 chiede la mappa alla SUA rotta e ci disegna sopra il menu di ogni riga', async () => {
    render(<CandidatureInsegnanti />)
    await attendiElenco()

    // 1. Le due rotte sono state interrogate ENTRAMBE: se il finto fosse piatto,
    //    questa distinzione non esisterebbe e il test non proverebbe niente.
    expect(versoEtichetta().length).toBeGreaterThan(0)
    expect(versoElenco().length).toBeGreaterThan(0)
    expect(versoEtichetta()[0].metodo).toBe('GET')

    // 2. Il menu nasce sul valore della MAPPA, non su quello della riga (che la
    //    rotta dell'elenco non manda affatto).
    await waitFor(() => expect(menuDi(CON_ETICHETTA)?.value).toBe('da_richiamare'))
    expect(menuDi(SENZA)?.value).toBe('')

    // 3. E le cinque voci del vocabolario sono tutte selezionabili, con il loro
    //    nome italiano: un menu di token sarebbe un menu illeggibile.
    // L'ordine è quello di `ETICHETTE_CANDIDATURA` — il vocabolario che il lock
    // `etichetta-candidatura-vocabolario.test.ts` tiene uguale al CHECK del
    // database e allo `z.enum` della rotta — e non quello di `CHIAVE_ETICHETTA`,
    // che è una mappa di lettura e non decide niente a schermo.
    const voci = [...(menuDi(SENZA)?.options ?? [])].map((o) => o.textContent)
    expect(voci).toEqual([
      itAdminAltro.candEtichettaNessuna,
      itAdminAltro.candEtichettaGiaChiamata,
      itAdminAltro.candEtichettaNonIdonea,
      itAdminAltro.candEtichettaDaRichiamare,
      itAdminAltro.candEtichettaInValutazione,
      itAdminAltro.candEtichettaAssunta,
    ])
    // 4. Il filtro accanto alla barra c'è, ed è premibile.
    expect(filtro()).not.toBeNull()
    expect(filtro()?.disabled).toBe(false)
  })

  it('🔴 dove la colonna NON esiste (CI non migrata) il menu SPARISCE, e l’elenco resta', async () => {
    // `colonnaAssente: true` è il degrado dichiarato della rotta: là ogni PATCH
    // fallirebbe, quindi un menu a schermo prometterebbe un salvataggio che non
    // può avvenire. Sparisce il filtro e spariscono i menu di riga — ma le
    // candidature restano: il pannello non si svuota per una colonna assente.
    mappa = { data: [], total: 0, colonnaAssente: true }
    render(<CandidatureInsegnanti />)
    await attendiElenco()

    await waitFor(() => expect(menuDi(CON_ETICHETTA)).toBeNull())
    expect(menuDi(SENZA)).toBeNull()
    expect(filtro()).toBeNull()
    // L'elenco è vivo e completo: il degrado tocca l'etichetta, non le righe.
    expect(screen.getByText('Seconda Candidata')).toBeInTheDocument()
  })

  it('🔴 scegliere un’etichetta scrive sulla rotta DELL’ETICHETTA, mai su quella dell’elenco', async () => {
    render(<CandidatureInsegnanti />)
    await attendiElenco()
    await waitFor(() => expect(menuDi(SENZA)).not.toBeNull())

    fireEvent.change(menuDi(SENZA) as HTMLSelectElement, { target: { value: 'assunta' } })

    await waitFor(() => expect(versoEtichetta().some((c) => c.metodo === 'PATCH')).toBe(true))
    const scrittura = versoEtichetta().find((c) => c.metodo === 'PATCH')
    expect(scrittura?.corpo).toEqual({ id: SENZA, etichetta: 'assunta' })
    // ⚠️ La rotta dell'elenco è quella che manda l'email d'esito alla candidata:
    // nessuna PATCH deve finire là, per nessuna ragione.
    expect(versoElenco().filter((c) => c.metodo === 'PATCH')).toEqual([])
    // E il menu resta sul valore appena scelto: la mappa si aggiorna DOPO la
    // risposta, non prima (un ottimismo qui direbbe «assunta» su una riga a cui
    // il server ha appena risposto 404).
    await waitFor(() => expect(menuDi(SENZA)?.value).toBe('assunta'))
  })

  it('🔴 «Senza etichetta» manda `null`: toglierla è un gesto, non l’assenza di un gesto', async () => {
    render(<CandidatureInsegnanti />)
    await attendiElenco()
    await waitFor(() => expect(menuDi(CON_ETICHETTA)?.value).toBe('da_richiamare'))

    fireEvent.change(menuDi(CON_ETICHETTA) as HTMLSelectElement, { target: { value: '' } })

    await waitFor(() => expect(versoEtichetta().some((c) => c.metodo === 'PATCH')).toBe(true))
    // `null` e non `''`: lo schema della rotta accetta l'uno e rifiuta l'altro,
    // e senza il `null` esplicito l'unico modo di disfare un'etichetta sarebbe
    // una UPDATE a mano sul database di produzione.
    expect(versoEtichetta().find((c) => c.metodo === 'PATCH')?.corpo).toEqual({
      id: CON_ETICHETTA,
      etichetta: null,
    })
    await waitFor(() => expect(menuDi(CON_ETICHETTA)?.value).toBe(''))
  })

  it('🔴 mappa TAGLIATA (`total` > righe): il filtro si SPEGNE e lo dice', async () => {
    // Il server ha 40 righe etichettate e ne ha mandate 1: filtrare su una mappa
    // parziale mostrerebbe meno candidature di quante ne esistono, e nessuno
    // potrebbe accorgersene guardando lo schermo.
    mappa = { ...mappa, total: 40 }
    render(<CandidatureInsegnanti />)
    await attendiElenco()

    await waitFor(() => expect(filtro()?.disabled).toBe(true))
    expect(screen.getByText(itAdminAltro.candEtichetteTroncate)).toBeInTheDocument()
    // I menu di riga restano: scrivere un'etichetta funziona comunque, è solo il
    // FILTRO a non poter dire il vero.
    expect(menuDi(SENZA)).not.toBeNull()
  })
})
