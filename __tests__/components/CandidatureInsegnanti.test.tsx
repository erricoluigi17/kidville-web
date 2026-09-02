import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'
import itAdminModulistica from '../../messages/it/adminModulistica.json'
import enAdminModulistica from '../../messages/en/adminModulistica.json'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'
import { INSEGNANTE_FIELDS, POSIZIONI_AMMESSE } from '@/lib/forms/insegnanti-template'

expect.extend(toHaveNoViolations)

/**
 * IL COCKPIT DELLE CANDIDATURE — collaudo del pannello di segreteria.
 *
 * Le cose che questo file sorveglia, e perché ognuna è qui:
 *
 *  · L'ELENCO NON PORTA RECAPITI. È la lezione di «Moduli ricevuti» (T11-F4):
 *    il payload completo di ogni domanda partiva verso il browser di ogni membro
 *    dello staff a ogni apertura della pagina. Qui il finto server rimanda
 *    apposta email e presentazione ANCHE nell'elenco: se il componente li
 *    disegnasse, il test è rosso. La difesa non deve dipendere dalla generosità
 *    della proiezione del server.
 *
 *  · LA CONFERMA NOMINA SEDE E FASCE. «Confermi?» da solo non dice a nessuno che
 *    sta per nascere un account docente su Aversa invece che su Giugliano.
 *
 *  · LE CREDENZIALI SI VEDONO UNA VOLTA. La password non è archiviata da nessuna
 *    parte: se il pannello la ridisegnasse dopo essere stato congedato, sarebbe
 *    perché qualcuno l'ha tenuta da qualche parte.
 *
 *  · L'EMAIL CHE NON PARTE SI DICE. L'account esiste comunque, e chi guarda deve
 *    saperlo: è il difetto storico di questo repo (403 loggato senza corpo, per
 *    mesi nessuna credenziale a destinazione) visto dal lato dell'interfaccia.
 *
 *  · LA SEGRETERIA VEDE PERCHÉ NON PUÒ. Il gate vero è sul server; scoprire il
 *    403 dopo il clic fa sembrare un guasto un divieto legittimo.
 *
 *  · DUE CLIC RAVVICINATI. Senza un gettone per richiesta vince la risposta che
 *    arriva per ultima, non il clic fatto per ultimo: il pannello si rimpiazza da
 *    solo con la persona sbagliata mentre «Approva» agisce su `selezionata.id`.
 *
 *  · LA CHIUSURA A METÀ HA PAROLE SUE. `stato: 'in_approvazione'` con
 *    `success: true` significa «account creato, riga non marcata»: intestare quel
 *    riquadro «Candidatura approvata» mentre il badge accanto dice «In
 *    approvazione» sono due frasi contraddittorie nello stesso pannello, e
 *    rimettere in mano «Rifiuta» manderebbe un'email di rifiuto a chi ha appena
 *    ricevuto le credenziali.
 *
 *  · L'ERRORE DELL'AZIONE VIENE DAL CATALOGO. La PATCH è l'unico posto da cui
 *    arrivano i cinque codici `CANDIDATURA_*`: finché il `codice` veniva buttato
 *    via, le loro traduzioni inglesi erano irraggiungibili e a schermo usciva
 *    l'italiano scritto a mano nella route.
 *
 *  · L'ELENCO DICE IL MESTIERE, NON LA FASCIA. Dal 2026-08-15 il modulo pubblico
 *    accoglie anche collaboratrici, cuoche, segretarie e un «altro» scritto a
 *    mano: in lista si leggono le POSIZIONI, e le fasce — che da quelle si
 *    DERIVANO (`gradiDallePosizioni`) — restano nel pannello. I `value` delle
 *    posizioni sono token con l'underscore (`insegnante_nido`), quindi il lock
 *    che vieta i token a schermo li copre insieme agli altri due enum.
 *
 *  · DOPO UN'APPROVAZIONE LE STORIE SONO TRE, NON DUE. `credentials: null`
 *    voleva dire una cosa sola — «esisteva già un accesso con questa email» — e
 *    su una candidatura non docente nessun account viene creato affatto
 *    (`approvaSenzaAccount`). Raccontarla con la frase vecchia manda la
 *    Segreteria a cercare un accesso che non esiste: la terza storia arriva dal
 *    server (`esitoAccount: 'nessuno'`) e non si deduce.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

/**
 * Le sedi attive sono PILOTABILI, come il ruolo: `reFetchKey` è la leva con cui
 * si simula un cambio di sede a metà di una lettura d'elenco già in volo. Senza
 * questa leva l'effetto `[reFetchKey]` non si rieseguiva mai in un test, e il
 * gettone dell'ELENCO restava un'invariante dichiarata e mai misurata (si poteva
 * togliere la riga di guardia da `carica` e la suite restava verde).
 */
let reFetchKeyCorrente = 'sc-giugliano,sc-aversa'
/** La sede scelta nel selettore in alto: è quella su cui si decide. */
let sedeCorrenteFinta: string | null = null
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [
      { id: 'sc-giugliano', nome: 'Kidville Giugliano' },
      { id: 'sc-aversa', nome: 'Kidville Aversa' },
    ],
    selezionate: [],
    effettive: reFetchKeyCorrente.split(','),
    sedeCorrente: sedeCorrenteFinta,
    reFetchKey: reFetchKeyCorrente,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

// Il ruolo è l'unica leva del gate lato client: lo si pilota per test.
let ruoloCorrente = 'admin'
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u-1', ruolo: ruoloCorrente, withUser: (h: string) => h }),
}))

/**
 * L'elenco che il finto server manda porta ANCHE `email` e `note`: la route vera
 * non li proietta in lista, ma questo test non è lì per collaudare la route — è
 * lì per verificare che il PANNELLO non li disegni comunque.
 */
const ELENCO = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    scuola_id: 'sc-aversa',
    stato: 'pending',
    nome: 'Anna',
    cognome: 'Bianchi',
    /**
     * DUE colonne, e non una ripetuta: `posizioni` è ciò che la persona ha
     * spuntato, `gradi` è ciò che il server ne ha DERIVATO
     * (`gradiDallePosizioni`) e ha scritto in tabella. Il pannello le stampa
     * tutte e due, l'elenco solo le posizioni. Anna è una candidatura docente:
     * due posizioni con il prefisso `insegnante_`, due fasce.
     */
    posizioni: ['insegnante_infanzia', 'insegnante_nido'],
    gradi: ['infanzia', 'nido'],
    creata_il: '2026-08-05T09:00:00Z',
    email: 'recapito.da.non.mostrare@example.test',
    note: 'PRESENTAZIONE-DA-NON-MOSTRARE-IN-ELENCO',
    /**
     * ⚠️ LA RIGA DI SEDE C'È, ANCHE IN ELENCO — e non è un di più.
     *
     * L'elenco si legge con `candidature_sedi!inner(scuola_id, stato)`: una
     * candidatura senza nemmeno una riga in scope non uscirebbe dalla query.
     * Fino al 2026-08-20 questo fixture non ce l'aveva, e ogni test di questo
     * file esercitava `statoDiRiga`/`mia` sul RAMO DI RIPIEGO — quello che serve
     * al database della CI, non migrato — invece che su quello vero.
     */
    candidature_sedi: [{ scuola_id: 'sc-aversa', stato: 'pending' }],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    scuola_id: 'sc-giugliano',
    stato: 'rifiutata',
    nome: 'Bruno',
    cognome: 'Neri',
    // Una candidatura NON docente, con `gradi` vuoto: dal 2026-08-15 è un valore
    // legittimo (una collaboratrice scolastica non ha una fascia d'età), non una
    // riga a metà.
    posizioni: ['collaboratrice'],
    gradi: [],
    creata_il: '2026-08-04T09:00:00Z',
    candidature_sedi: [{ scuola_id: 'sc-giugliano', stato: 'rifiutata' }],
  },
]

const DETTAGLIO = {
  ...ELENCO[0],
  telefono: '+39 000 0000000',
  residence_city: 'Aversa',
  residence_province: 'CE',
  titolo_studio: 'laurea_magistrale',
  titolo_dettaglio: 'Scienze dell’educazione',
  anni_esperienza: 4,
  disponibilita: 'tempo_pieno',
  cv_path: 'candidature/cv-anna.pdf',
  // La riga di sede arriva dallo spread di `ELENCO[0]`, con la nota che spiega
  // perché non può mancare: la scheda si legge con `!inner`.
}

/**
 * Una candidatura di SOLA CUOCA — cioè il caso che il modulo ha cominciato ad
 * accogliere il 2026-08-15, e che prima non era nemmeno esprimibile.
 *
 * Nessuna posizione col prefisso `insegnante_`, quindi: `gradi` vuoto,
 * `comprendeInsegnamento` falso, nessun account alla fine dell'approvazione.
 * `posizione_altro` è `null` perché «altro» non è fra le posizioni, e in tabella
 * un `CHECK` di coerenza lega le due colonne nei DUE versi (migrazione
 * `20260814225302`): questa riga è una riga che il database accetta.
 */
const CUOCA = {
  ...DETTAGLIO,
  id: '55555555-5555-4555-8555-555555555555',
  nome: 'Carmela',
  cognome: 'Esposito',
  posizioni: ['cuoca'],
  posizione_altro: null,
  gradi: [],
}

const fetchMock = vi.fn()

/**
 * La finta scheda che `window.open` restituisce quando il browser NON blocca.
 *
 * Serve una finestra vera (e non `undefined`) perché il componente apre la
 * scheda PRIMA della fetch — dentro il gesto dell'utente — e poi le assegna la
 * URL firmata: è l'unico modo in cui l'apertura sopravvive a Safari e alla
 * WebView Capacitor, che bloccano una `window.open` in continuazione di promise.
 */
function finestraFinta() {
  return { closed: false, opener: {}, close: vi.fn(), location: { replace: vi.fn() } }
}

type FinestraFinta = ReturnType<typeof finestraFinta>
let finestraAperta: FinestraFinta | null = null
const openMock = vi.fn((): FinestraFinta | null => {
  finestraAperta = finestraFinta()
  return finestraAperta
})

/** Il CORPO di default: elenco, dettaglio su `?id=`, URL firmata su `?doc=`. */
function rispostaPredefinita(url: string) {
  const u = String(url)
  if (u.includes('?doc=')) return { url: 'https://storage.example.test/firmata' }
  if (u.includes('id=')) return { data: DETTAGLIO }
  return { data: ELENCO, total: ELENCO.length, limit: 50, offset: 0 }
}

function ok(corpo: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => corpo })
}

beforeEach(() => {
  vi.clearAllMocks()
  ruoloCorrente = 'admin'
  reFetchKeyCorrente = 'sc-giugliano,sc-aversa'
  sedeCorrenteFinta = null
  fetchMock.mockImplementation((url: string) => ok(rispostaPredefinita(url)))
  vi.stubGlobal('fetch', fetchMock)
  finestraAperta = null
  openMock.mockImplementation(() => {
    finestraAperta = finestraFinta()
    return finestraAperta
  })
  vi.stubGlobal('open', openMock)
})

afterEach(() => {
  cleanup()
})

import { CandidatureInsegnanti, CHIAVE_DISPONIBILITA } from '@/components/features/admin/iscrizioni/CandidatureInsegnanti'

/**
 * IL VELO di caricamento del pannello, distinto dal conteggio della barra filtri.
 *
 * Dal 2026-09-01 questa schermata ha DUE `role="status"`: il velo del dettaglio
 * («Caricamento…») e la riga «12 risultati su 387» della barra, che è una
 * regione viva perché chi usa uno screen reader deve sentire quanti risultati
 * restano mentre filtra. `getByRole('status')` ne trova due e fallisce per una
 * ragione che non c'entra con i casi qui sotto.
 *
 * ⚠️ E non si può nemmeno restringere con `{ name: /caricamento/i }`: un
 * `role="status"` NON prende il nome accessibile dal proprio contenuto, quindi
 * quel filtro non troverebbe niente — misurato, ed è il motivo per cui qui c'è
 * una funzione invece di un'opzione.
 */
function veloDiCaricamento(): HTMLElement | null {
  return (
    screen
      .queryAllByRole('status')
      .find((el) => el.getAttribute('data-testid') !== 'conteggio-risultati') ?? null
  )
}

/** Apre il dettaglio della prima candidatura e aspetta che sia disegnato. */
async function apriPrima() {
  const utils = render(<CandidatureInsegnanti />)
  await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
  fireEvent.click(screen.getByText('Anna Bianchi'))
  await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
  return utils
}

/** Un finto server con UNA sola candidatura: elenco e dettaglio la stessa riga. */
function serverConUnaSola(riga: Record<string, unknown>, corpoPatch?: unknown) {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') return ok(corpoPatch ?? { success: true, stato: 'approvata', warnings: [] })
    const u = String(url)
    if (u.includes('id=')) return ok({ data: riga })
    return ok({ data: [riga], total: 1 })
  })
}

/**
 * Apre l'unica candidatura a schermo. Il segnale di «pannello aperto» è
 * l'INTESTAZIONE e non «Apri il curriculum», perché una candidatura senza
 * allegato quel comando non lo disegna affatto.
 *
 * ⚠️ E ce ne sono, anche dopo il 2026-08-24. Dal modulo pubblico il curriculum è
 * ora OBBLIGATORIO, ma questa scheda legge la TABELLA, dove quattro righe su dieci
 * hanno `cv_path` NULL (àncora `MISURA-CV`) — le candidature arrivate quando il
 * campo non c'era (prima del
 * 15/08) o era facoltativo (fino al 24/08). La colonna resta `nullable` proprio
 * per loro: legare questo aiutante al comando del curriculum lo renderebbe cieco
 * su quasi metà dell'archivio.
 */
async function apriLaSola(nome: string) {
  const utils = render(<CandidatureInsegnanti />)
  await waitFor(() => expect(screen.getByText(nome)).toBeInTheDocument())
  fireEvent.click(screen.getByText(nome))
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: nome, level: 2 })).toBeInTheDocument(),
  )
  return utils
}

/**
 * La RIGA d'elenco di una persona: il PULSANTE, non la prima occorrenza del nome.
 *
 * Il nome compare in più punti della stessa schermata — la riga, l'intestazione
 * del pannello, l'avviso dell'esito scartato che nomina la persona — e
 * `getAllByText(nome)[0]` può pescare il testo dell'avviso, che non è cliccabile.
 */
const rigaElencoDi = (nome: string) =>
  screen.getAllByText(nome).map((n) => n.closest('button')).find(Boolean) as HTMLElement

/** Una pausa vera: serve a far ATTERRARE una risposta lenta e guardare cosa fa. */
const attendi = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('CandidatureInsegnanti — elenco', () => {
  it('elenco VUOTO: lo dice, e non lascia la pagina bianca', async () => {
    fetchMock.mockImplementation(() => ok({ data: [], total: 0 }))
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Nessuna candidatura ricevuta.')).toBeInTheDocument())
  })

  it('elenco in ERRORE: avviso in pagina con role="alert", mai un alert() del browser', async () => {
    const alertBrowser = vi.fn()
    vi.stubGlobal('alert', alertBrowser)
    fetchMock.mockImplementation(() => ok({ error: 'Le candidature non sono consultabili in questo momento.' }, 503))

    render(<CandidatureInsegnanti />)
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(/non sono consultabili/i)
    expect(alertBrowser).not.toHaveBeenCalled()
  })

  it('lettura FALLITA ≠ archivio vuoto: non dice «Nessuna candidatura ricevuta», e offre il ritenta', async () => {
    // Il difetto: con la GET a 503 il ramo «zero righe» disegnava lo stesso
    // riquadro dell'archivio vuoto, e sulla stessa schermata convivevano due
    // frasi che si contraddicono — una in rosso («non è stato possibile
    // caricare») e una in inchiostro neutro, che è un'AFFERMAZIONE DI FATTO
    // falsa su una casella di reclutamento che riceve invii veri. «Non
    // verificabile» e «vuoto» sono due stati, e vanno detti con due frasi.
    fetchMock.mockImplementation(() => ok({ error: 'Le candidature non sono consultabili in questo momento.' }, 503))
    render(<CandidatureInsegnanti />)

    await screen.findByRole('alert')
    expect(screen.queryByText('Nessuna candidatura ricevuta.')).not.toBeInTheDocument()
    expect(screen.getByText(itAdminAltro.candElencoNonLetto)).toBeInTheDocument()

    // …e il ritenta è un ritenta vero: la lettura riuscita rimette l'elenco.
    fetchMock.mockImplementation((url: string) => ok(rispostaPredefinita(url)))
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    expect(screen.queryByText(itAdminAltro.candElencoNonLetto)).not.toBeInTheDocument()
  })

  it('un 200 con il corpo sbagliato NON si legge come archivio vuoto', async () => {
    // `{ data: null }` non entra in nessun ramo: prima l'elenco restava vuoto in
    // silenzio, cioè la stessa bugia del 503 ma senza nemmeno l'avviso rosso.
    fetchMock.mockImplementation(() => ok({ risultato: 'inatteso' }))
    render(<CandidatureInsegnanti />)

    await screen.findByRole('alert')
    expect(screen.queryByText('Nessuna candidatura ricevuta.')).not.toBeInTheDocument()
    expect(screen.getByText(itAdminAltro.candElencoNonLetto)).toBeInTheDocument()
  })

  it('il TOTALE viene dal conteggio del server, non da quante righe sono state caricate', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('id=')) return ok({ data: DETTAGLIO })
      return ok({ data: ELENCO, total: 7 })
    })
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    // 2 righe caricate su 7: il riquadro del totale dice 7…
    expect(screen.getByText('7')).toBeInTheDocument()
    // …e i tre riquadri per stato NON si mostrano affatto, perché conterebbero
    // solo le righe caricate: un conteggio parziale spacciato per totale.
    expect(screen.queryByText('Approvate')).not.toBeInTheDocument()
    expect(screen.queryByText('Rifiutate')).not.toBeInTheDocument()
  })

  it('un valore fuori elenco non sparisce: la POSIZIONE ignota in lista, la FASCIA ignota nel pannello', async () => {
    // La riga d'archivio che non sta nell'elenco chiuso è proprio il caso per cui
    // la difesa esiste: nasconderla direbbe alla Direzione che quella candidatura
    // non ha quel dato, mentre in tabella c'è un valore che qualcuno dovrà
    // sistemare. Senza questa fixture la riga che lo realizza si può cancellare e
    // il file resta verde (misurato: 21/21 col filtro tolto).
    //
    // Dal 2026-08-15 i due elenchi sono due: in lista si disegnano le POSIZIONI,
    // nel pannello le posizioni E le fasce. La regola è la stessa funzione
    // (`ordinatiComeIlModulo`), e questo test la esercita da entrambi i lati.
    const IGNOTI = {
      ...ELENCO[0],
      posizioni: ['psicomotricista', 'collaboratrice'],
      gradi: ['sezione_primavera', 'infanzia'],
    }
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('id=')) return ok({ data: { ...DETTAGLIO, ...IGNOTI } })
      return ok({ data: [IGNOTI], total: 1 })
    })

    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    // In elenco: quella dell'elenco chiuso tradotta, quella ignota grezza — e in
    // coda, perché l'ordine è quello del modulo pubblico e non quello d'arrivo.
    const riga = rigaElencoDi('Anna Bianchi')
    expect(within(riga).getByText('Collaboratrice scolastica')).toBeInTheDocument()
    expect(within(riga).getByText('psicomotricista')).toBeInTheDocument()
    const testoRiga = riga.textContent ?? ''
    expect(testoRiga.indexOf('Collaboratrice scolastica')).toBeLessThan(testoRiga.indexOf('psicomotricista'))

    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    // Nel pannello: la fascia dell'enum tradotta, quella ignota grezza…
    // ⚠️ `:not(option)`: dal 2026-09-01 la barra filtri offre le stesse fasce in
    // una tendina, quindi «Infanzia (3-6)» sta a schermo DUE volte — una come
    // voce di filtro, una come dato della candidatura. Qui si misura la seconda:
    // senza il selettore, `getByText` trova due elementi e fallisce per una
    // ragione che non c'entra con ciò che il caso sorveglia.
    expect(screen.getByText('Infanzia (3-6)', { selector: ':not(option)' })).toBeInTheDocument()
    expect(screen.getByText('sezione_primavera')).toBeInTheDocument()
    // …e la posizione ignota compare due volte, perché il pannello ristampa le
    // posizioni accanto alle fasce.
    expect(screen.getAllByText('psicomotricista').length).toBe(2)
  })

  it('PAGINAZIONE: «Mostra altre» chiede la pagina successiva con l’offset giusto e accoda', async () => {
    const secondaPagina = [{
      id: '33333333-3333-4333-8333-333333333333',
      scuola_id: 'sc-aversa',
      stato: 'approvata',
      nome: 'Carla',
      cognome: 'Verdi',
      gradi: ['primaria'],
      creata_il: '2026-08-03T09:00:00Z',
    }]
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('id=')) return ok({ data: DETTAGLIO })
      if (u.includes('offset=2')) return ok({ data: secondaPagina, total: 3 })
      return ok({ data: ELENCO, total: 3 })
    })

    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Mostra altre candidature'))

    await waitFor(() => expect(screen.getByText('Carla Verdi')).toBeInTheDocument())
    // Le prime restano: si accoda, non si sostituisce.
    expect(screen.getByText('Anna Bianchi')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('offset=2'),
      expect.objectContaining({ headers: { 'x-sedi': 'sc-giugliano,sc-aversa' } }),
    )
  })

  it('PAGINAZIONE: una riga che torna due volte NON diventa un doppione', async () => {
    // Il modulo pubblico riceve invii di continuo: se una candidatura arriva fra
    // la prima pagina e la seconda, l'offset conta le righe già viste e ne fa
    // ricomparire una — con la stessa `key` React, cioè un doppione a schermo
    // per la Direzione.
    const seconda = [
      ELENCO[1], // ⟵ la stessa riga della prima pagina, spinta giù di uno
      {
        id: '33333333-3333-4333-8333-333333333333',
        scuola_id: 'sc-aversa', stato: 'approvata', nome: 'Carla', cognome: 'Verdi',
        gradi: ['primaria'], creata_il: '2026-08-03T09:00:00Z',
      },
    ]
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('id=')) return ok({ data: DETTAGLIO })
      if (u.includes('offset=2')) return ok({ data: seconda, total: 3 })
      return ok({ data: ELENCO, total: 3 })
    })

    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Mostra altre candidature'))

    await waitFor(() => expect(screen.getByText('Carla Verdi')).toBeInTheDocument())
    expect(screen.getAllByText('Bruno Neri')).toHaveLength(1)
    expect(screen.getAllByText('Anna Bianchi')).toHaveLength(1)
  })

  it('PAGINAZIONE: una pagina più corta del limite SPEGNE «Mostra altre», anche senza `total`', async () => {
    // Con il solo `righe.length < totale`, un `total` rimasto vecchio (la pagina
    // 2 può non portarlo) lascia il pulsante acceso su un elenco che non cresce
    // più: si clicca, non succede niente, e non lo dice nessuno.
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('id=')) return ok({ data: DETTAGLIO })
      if (u.includes('offset=2')) return ok({ data: [] })
      return ok({ data: ELENCO, total: 100 })
    })

    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Mostra altre candidature'))

    await waitFor(() => expect(screen.queryByText('Mostra altre candidature')).not.toBeInTheDocument())
    // …e il totale del server resta quello che ha detto il server: non si inventa.
    expect(screen.getByText('100')).toBeInTheDocument()
  })

  it('l’elenco NON si rifà a ogni render: l’effetto dipende solo dalle sedi', async () => {
    // La deroga a `react-hooks/exhaustive-deps` è sparita passando da un `ref`.
    // Se qualcuno la sostituisse con un `useCallback([t])`, `t` non è stabile nel
    // banco di prova e la fetch ripartirebbe a ogni render: qui si conta.
    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Rifiuta' }))
    await screen.findByRole('checkbox')
    fireEvent.change(screen.getByLabelText('Motivo (facoltativo)'), { target: { value: 'tre render dopo' } })
    await attendi(30)

    const elenchi = fetchMock.mock.calls.filter((c) => String(c[0]).includes('offset=0'))
    expect(elenchi).toHaveLength(1)
  })

  it('l’ELENCO non contiene email né presentazione: arrivano solo col dettaglio', async () => {
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    expect(screen.queryByText(/recapito\.da\.non\.mostrare/)).not.toBeInTheDocument()
    expect(screen.queryByText(/PRESENTAZIONE-DA-NON-MOSTRARE/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText(/recapito\.da\.non\.mostrare/)).toBeInTheDocument())
    // …e il payload lo si è chiesto con `?id=`, cioè una candidatura alla volta.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`id=${ELENCO[0].id}`),
      expect.objectContaining({ headers: { 'x-sedi': 'sc-giugliano,sc-aversa' } }),
    )
  })

  it('il nome della sede è risolto: sulla riga si legge il plesso, non l’uuid', async () => {
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    expect(screen.getAllByText(/Kidville Aversa/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/sc-aversa/)).not.toBeInTheDocument()
  })

  it('le chip di RIGA dicono le POSIZIONI tradotte, e le fasce non sono più in elenco', async () => {
    // Dal 2026-08-15 la riga porta il MESTIERE: è l'unico dato che distingue a
    // colpo d'occhio una maestra da una cuoca, ed è una sostituzione e non
    // un'aggiunta — le fasce sono ormai derivate dalle posizioni, e mostrarle
    // accanto direbbe due volte la stessa cosa alle insegnanti e niente a tutti
    // gli altri.
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    const riga = rigaElencoDi('Anna Bianchi')
    expect(within(riga).getByText('Insegnante — Nido (0-3)')).toBeInTheDocument()
    expect(within(riga).getByText('Insegnante — Infanzia (3-6)')).toBeInTheDocument()
    // Il token della colonna non arriva a schermo: l'etichetta viene dal catalogo.
    expect(within(riga).queryByText('insegnante_nido')).not.toBeInTheDocument()
    // Le due chip delle FASCE non ci sono: «Nido (0-3)» da solo non è più in riga.
    expect(within(riga).queryByText('Nido (0-3)')).not.toBeInTheDocument()
    expect(within(riga).queryByText('Infanzia (3-6)')).not.toBeInTheDocument()
    // L'ordine è quello del modulo pubblico (nido, infanzia), non quello in cui
    // le posizioni sono arrivate dal database (infanzia, nido).
    const testoRiga = riga.textContent ?? ''
    expect(testoRiga.indexOf('Nido (0-3)')).toBeLessThan(testoRiga.indexOf('Infanzia (3-6)'))

    // E la riga di una candidatura NON docente porta il suo mestiere, non il vuoto.
    expect(within(rigaElencoDi('Bruno Neri')).getByText('Collaboratrice scolastica')).toBeInTheDocument()
  })
})

describe('CandidatureInsegnanti — cambio di sede con una lettura già in volo', () => {
  const SOLO_AVERSA = [{
    id: '44444444-4444-4444-8444-444444444444',
    scuola_id: 'sc-aversa',
    stato: 'pending',
    nome: 'Dora',
    cognome: 'Rossi',
    gradi: ['nido'],
    creata_il: '2026-08-06T09:00:00Z',
  }]

  /** L'elenco della COPPIA di sedi è lento; quello della sola Aversa è immediato. */
  function serverConCoppiaLenta(ritardoMs: number) {
    fetchMock.mockImplementation((url: string, init?: { headers?: Record<string, string> }) => {
      const u = String(url)
      if (u.includes('id=')) return ok({ data: DETTAGLIO })
      if (init?.headers?.['x-sedi'] === 'sc-aversa') return ok({ data: SOLO_AVERSA, total: 1 })
      return new Promise((risolvi) =>
        setTimeout(
          () => risolvi({ ok: true, status: 200, json: async () => ({ data: ELENCO, total: 2 }) }),
          ritardoMs,
        ),
      )
    })
  }

  it('vince l’ULTIMA sede scelta, non la risposta che arriva per ultima', async () => {
    // Il gettone dell'elenco esisteva già, ma nessun test lo esercitava: si poteva
    // togliere la riga di guardia da `carica` e la suite restava verde. Qui la
    // lettura della coppia di sedi atterra DOPO quella della sola Aversa, ed è
    // esattamente il caso in cui a schermo comparirebbero le candidature del
    // plesso che non è più selezionato.
    serverConCoppiaLenta(120)
    const { rerender } = render(<CandidatureInsegnanti />)

    reFetchKeyCorrente = 'sc-aversa'
    rerender(<CandidatureInsegnanti />)

    await waitFor(() => expect(screen.getByText('Dora Rossi')).toBeInTheDocument())
    await attendi(220)
    expect(screen.getByText('Dora Rossi')).toBeInTheDocument()
    expect(screen.queryByText('Anna Bianchi')).not.toBeInTheDocument()
    expect(screen.queryByText('Bruno Neri')).not.toBeInTheDocument()
  })

  it('🔴 senza righe di sede (CI non migrata) i pulsanti sono SPENTI, e il badge no', async () => {
    // ⚠️ IL RIPIEGO ACCENDEVA DUE PULSANTI SU UN PERCORSO CHE NON PUÒ RIUSCIRE.
    //
    // Il ripiego `mia?.stato ?? cand.stato` era documentato come servizio
    // «all'ambiente non ancora migrato, dove le righe di sede non esistono». In
    // quell'ambiente il BADGE dice una cosa vera, anche se grossolana — e va
    // bene. Ma `cambiaStato` scrive su `candidature_sedi` e degrada solo sulla
    // COLONNA assente, non sulla TABELLA assente: ogni «Approva» prende
    // `42P01`/`PGRST205` e torna 503.
    //
    // È lo stesso difetto che il blocco su `mia` denuncia per l'aggregato — «un
    // ordine ineseguibile, dato all'infinito» — entrato da un'altra porta: là
    // era un 409, qui è un 503.
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      // Il dettaglio SENZA `candidature_sedi`: è il database della CI.
      if (u.includes('id=')) {
        const senzaRighe: Record<string, unknown> = { ...DETTAGLIO }
        delete senzaRighe.candidature_sedi
        return ok({ data: senzaRighe })
      }
      return ok({ data: ELENCO, total: 2 })
    })
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('+39 000 0000000')).toBeInTheDocument())

    const approva = screen.getByRole('button', { name: 'Approva' })
    expect(approva, 'un pulsante che non può riuscire, acceso').toBeDisabled()
    expect(screen.getByRole('button', { name: 'Rifiuta' })).toBeDisabled()
    // E il motivo è scritto, non solo il pulsante spento: un divieto legittimo
    // che si presenta come un guasto è l'anti-pattern che questo file evita.
    expect(approva.getAttribute('title')).toContain('non può riuscire')
    // Il badge invece ripiega e dice il vero: «In attesa», dall'aggregato.
    expect(screen.getAllByText('In attesa').length).toBeGreaterThan(0)
  })

  it('🔴 togliere una sede dal selettore CHIUDE il pannello aperto su quella sede', async () => {
    // ⚠️ IL PANNELLO SOPRAVVIVEVA AL PROPRIO SCOPE.
    //
    // L'effetto `[reFetchKey]` ricaricava l'elenco e basta: `selezionata` e
    // `sedeScelta` restavano. Aperta una candidatura e tolta la sua sede dal
    // selettore in alto, il pannello restava a schermo con email, telefono,
    // curriculum e note di sede di un plesso su cui chi guarda non ha più
    // titolo — e «Rifiuta» spediva una sede fuori scope, prendendo un 404 e
    // accendendo il warn `sede-fuori-scope`.
    //
    // Non è una fuga — quei dati erano stati letti quando il titolo c'era — ma è
    // una schermata che mostra ciò che il suo scope non copre più.
    fetchMock.mockImplementation((url: string, init?: { headers?: Record<string, string> }) => {
      const u = String(url)
      if (u.includes('id=')) return ok({ data: DETTAGLIO })
      // ⚠️ L'ELENCO NUOVO NON DEV'ESSERE VUOTO. Il pannello vive dentro il ramo
      // `righe.length > 0`: con zero righe sparirebbe da solo, e il test
      // resterebbe verde anche togliendo la chiusura. Misurato il 2026-08-20 —
      // la prima stesura di questo test non cadeva sul sabotaggio.
      if (init?.headers?.['x-sedi'] === 'sc-giugliano') return ok({ data: [ELENCO[1]], total: 1 })
      return ok({ data: ELENCO, total: 3 })
    })
    const { rerender } = render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Anna Bianchi'))
    // Il pannello è aperto: il telefono esce solo con `?id=`, quindi è la prova
    // che il dettaglio è a schermo e non solo la riga d'elenco.
    await waitFor(() => expect(screen.getByText('+39 000 0000000')).toBeInTheDocument())

    // Aversa esce dal selettore in alto: la candidatura aperta era sua.
    reFetchKeyCorrente = 'sc-giugliano'
    rerender(<CandidatureInsegnanti />)

    await waitFor(() =>
      expect(
        screen.queryByText('+39 000 0000000'),
        'il pannello è rimasto a schermo con i dati di una sede che non è più in scope',
      ).not.toBeInTheDocument(),
    )
  })

  it('«Mostra altre» è SPENTO mentre una lettura d’elenco è in volo: non si accoda a un elenco che sta per cambiare', async () => {
    // Il gettone è condiviso, e `caricaAltre` lo incrementava: un clic su «Mostra
    // altre» mentre la ricarica per cambio sede è in volo faceva SCARTARE la
    // ricarica e accodava la pagina della sede NUOVA (l'header `x-sedi` è già
    // quello nuovo) alle righe della sede VECCHIA, con l'offset calcolato sulla
    // lista vecchia. In un repo con tre sedi vere, un elenco che mescola plessi è
    // la classe di difetto già pagata dall'audit multi-sede.
    // Qui i ruoli sono invertiti rispetto al test di sopra: la prima pagina della
    // coppia arriva subito (e con `total: 3` accende «Mostra altre»), la ricarica
    // per la sola Aversa è quella lenta — cioè la finestra in cui il pulsante
    // sarebbe cliccabile.
    // ⚠️ LA FINESTRA «LETTURA IN VOLO» SI APRE CON UN INTERRUTTORE, NON CON UN
    // CRONOMETRO (corretto al giro 4 del 2026-08-25). Qui c'era un
    // `setTimeout(…, 100)` dentro il finto server contro un `await attendi(50)`
    // nel test: due timer REALI in gara, e la finestra che il test crede aperta
    // esisteva solo finché la macchina era abbastanza veloce. Con la suite intera
    // in parallelo i 50 ms sfondano i 100: la lettura di Aversa è già finita,
    // l'elenco è quello della sola Aversa (`total: 1`), «Mostra altre
    // candidature» non c'è PIÙ e `getByRole` lancia «unable to find» — cioè un
    // rosso che NON è il difetto che questo caso sorveglia. Visto il 2026-08-25
    // da due collaudatori diversi, e verde alla seconda esecuzione: un test che
    // passa solo al RETRY, che in questo repo non è un test.
    //
    // Adesso la lettura di Aversa finisce quando il test lo decide. La finestra è
    // aperta per COSTRUZIONE e non per fortuna, e il caso non dipende più dalla
    // velocità della macchina né dal carico delle altre 980 corsie.
    let sbloccaAversa!: () => void
    const aversaInVolo = new Promise<void>((risolvi) => { sbloccaAversa = risolvi })
    fetchMock.mockImplementation((url: string, init?: { headers?: Record<string, string> }) => {
      const u = String(url)
      if (u.includes('id=')) return ok({ data: DETTAGLIO })
      if (init?.headers?.['x-sedi'] === 'sc-aversa') {
        return aversaInVolo.then(() => ({ ok: true, status: 200, json: async () => ({ data: SOLO_AVERSA, total: 1 }) }))
      }
      return ok({ data: ELENCO, total: 3 })
    })

    const { rerender } = render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Mostra altre candidature' })).toBeEnabled()

    reFetchKeyCorrente = 'sc-aversa'
    rerender(<CandidatureInsegnanti />)
    expect(screen.getByRole('button', { name: 'Mostra altre candidature' })).toBeDisabled()
    // …e resta spento per tutta la durata della lettura, non solo per un istante.
    // Si cede il controllo a React più volte SENZA far avanzare la lettura: cinque
    // giri di coda bastano a far girare ogni effetto in sospeso, e nessuno di essi
    // può chiudere la finestra, perché a chiuderla è `sbloccaAversa()` qui sotto.
    for (let giro = 0; giro < 5; giro++) await attendi(0)
    expect(screen.getByRole('button', { name: 'Mostra altre candidature' })).toBeDisabled()

    sbloccaAversa()
    await waitFor(() => expect(screen.getByText('Dora Rossi')).toBeInTheDocument())
    // Nessuna accodatura è mai partita: l'offset dell'elenco vecchio non è stato
    // chiesto a nessuna delle due sedi.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('offset=2'))).toHaveLength(0)
    expect(screen.queryByText('Anna Bianchi')).not.toBeInTheDocument()
  })
})

describe('CandidatureInsegnanti — due aperture ravvicinate', () => {
  /** Anna arriva TARDI, Bruno subito: la gara è quella vera della segreteria. */
  function serverConAnnaLenta(ritardoMs: number) {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes(`id=${ELENCO[0].id}`)) {
        return new Promise((risolvi) =>
          setTimeout(
            () => risolvi({ ok: true, status: 200, json: async () => ({ data: { ...DETTAGLIO, email: 'anna@example.test' } }) }),
            ritardoMs,
          ),
        )
      }
      if (u.includes(`id=${ELENCO[1].id}`)) {
        return ok({ data: { ...ELENCO[1], email: 'bruno@example.test', telefono: null, cv_path: null } })
      }
      return ok(rispostaPredefinita(u))
    })
  }

  it('vince l’ULTIMO CLIC, non l’ultima risposta: Anna in ritardo non rimpiazza Bruno', async () => {
    serverConAnnaLenta(60)
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Anna Bianchi'))
    fireEvent.click(screen.getByText('Bruno Neri'))

    await waitFor(() => expect(screen.getByText('bruno@example.test')).toBeInTheDocument())
    // …e quando la risposta di Anna atterra, il pannello NON si rimpiazza da solo.
    await attendi(140)
    expect(screen.queryByText('anna@example.test')).not.toBeInTheDocument()
    expect(screen.getByText('bruno@example.test')).toBeInTheDocument()
  })

  it('il velo di caricamento non lo spegne la risposta di un’altra apertura', async () => {
    serverConAnnaLenta(80)
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    // Prima Bruno (risponde subito), poi Anna (risponde tardi): il velo di Anna
    // deve restare finché non arriva Anna, non spegnersi con la coda di Bruno.
    fireEvent.click(screen.getByText('Bruno Neri'))
    fireEvent.click(screen.getByText('Anna Bianchi'))

    await attendi(30)
    // Il velo, NON il conteggio della barra filtri: anche quello è un
    // `role="status"` (annuncia «12 risultati su 387» a chi usa uno screen
    // reader). Si nomina quello che si vuole misurare.
    expect(veloDiCaricamento()).not.toBeNull()
    expect(screen.queryByText('bruno@example.test')).not.toBeInTheDocument()

    await waitFor(() => expect(screen.getByText('anna@example.test')).toBeInTheDocument(), { timeout: 2000 })
    expect(veloDiCaricamento()).toBeNull()
  })
})

describe('CandidatureInsegnanti — approvazione', () => {
  it('la conferma NOMINA persona, sede, fasce e recapito', async () => {
    // ⚠️ SI CERCA LA CHIAVE DEL CATALOGO, NON LA FRASE. Fino al 2026-08-20 qui
    // c'era `/Verrà creato un account docente per/` scritto a mano, e quella frase
    // era FALSA dal 15 agosto: approvare non crea nessun account (`approva()` fa
    // `return await approvaSenzaAccount(...)`, un solo percorso). Un test che
    // ricopia la copia la CONGELA: finché il testo restava sbagliato il test era
    // verde, e correggerlo lo faceva diventare rosso — cioè il test difendeva la
    // bugia. Con la chiave, il test dice QUALE RAMO si disegna e resta muto su
    // cosa c'è scritto dentro, che è il suo mestiere.
    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))

    const conferma = await screen.findByText(
      new RegExp(itAdminAltro.candConfermaApprovaAccount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
    const blocco = conferma.parentElement as HTMLElement
    expect(within(blocco).getByText('Anna Bianchi')).toBeInTheDocument()
    expect(within(blocco).getByText('Kidville Aversa')).toBeInTheDocument()
    // Le fasce nell'ordine del modulo pubblico, non in quello in cui sono arrivate.
    expect(within(blocco).getByText('Nido (0-3), Infanzia (3-6)')).toBeInTheDocument()
    expect(within(blocco).getByText('recapito.da.non.mostrare@example.test')).toBeInTheDocument()
  })

  it('le credenziali si vedono UNA volta sola: congedato il pannello, non tornano', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return ok({
          success: true,
          stato: 'approvata',
          credentials: { email: 'anna@example.test', password: 'Pw-di-prova-1' },
          credentialsEmailSent: true,
          warnings: [],
        })
      }
      return ok(rispostaPredefinita(url))
    })

    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))

    await waitFor(() => expect(screen.getByText('Pw-di-prova-1')).toBeInTheDocument())
    expect(screen.getByText(/Credenziali inviate via email/)).toBeInTheDocument()
    // La chiusura è RIUSCITA: qui, e solo qui, il riquadro è verde. È l'altra
    // metà dell'asserzione sulla tinta nel test della chiusura a metà: senza
    // entrambe, `esitoRiuscito` si può ridurre a `esito !== null` e nessun test
    // se ne accorge (misurato: mutazione sopravvissuta, 36/36 verdi).
    const riquadro = screen.getByText('Candidatura approvata').parentElement as HTMLElement
    expect(riquadro.className).toContain('bg-kidville-success-soft')
    expect(riquadro.className).not.toContain('bg-kidville-warn-soft')

    fireEvent.click(screen.getByRole('button', { name: 'Ho preso nota' }))
    await waitFor(() => expect(screen.queryByText('Pw-di-prova-1')).not.toBeInTheDocument())

    // E nemmeno riaprendo la candidatura: la password non è archiviata da nessuna parte.
    fireEvent.click(screen.getAllByText('Anna Bianchi')[0])
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    expect(screen.queryByText('Pw-di-prova-1')).not.toBeInTheDocument()
  })

  it('email delle credenziali NON partita: lo dice, e dice che l’account esiste lo stesso', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return ok({
          success: true,
          stato: 'approvata',
          credentials: { email: 'anna@example.test', password: 'Pw-di-prova-2' },
          credentialsEmailSent: false,
          warnings: ['Email delle credenziali NON inviata: the domain is not verified.'],
        })
      }
      return ok(rispostaPredefinita(url))
    })

    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))

    const avviso = await screen.findByText(/Email NON inviata/)
    expect(avviso).toHaveTextContent(/l’account esiste comunque/i)
    expect(avviso).toHaveTextContent(/manualmente/i)
    // La password resta comunque a schermo: è l'unico modo di comunicarla a voce.
    expect(screen.getByText('Pw-di-prova-2')).toBeInTheDocument()
    // E il motivo vero del provider non si perde.
    expect(screen.getByText(/the domain is not verified/)).toBeInTheDocument()
  })

  it('azione respinta dal server: lo dice in pagina e NON dichiara «fatto»', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return ok({ error: 'Questa candidatura è già stata valutata.', codice: 'CANDIDATURA_GIA_EVASA' }, 409)
      }
      return ok(rispostaPredefinita(url))
    })

    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))

    const avviso = await screen.findByRole('alert')
    // Il testo è quello del CATALOGO (`shared.erroreCandidaturaGiaEvasa`), non la
    // prosa del server: la coda «ricarica la pagina…» esiste solo nel catalogo.
    expect(avviso).toHaveTextContent(itShared.erroreCandidaturaGiaEvasa)
    expect(screen.queryByText('Candidatura approvata')).not.toBeInTheDocument()
  })

  it('il `codice` decide il testo: la prosa italiana del server NON arriva a schermo', async () => {
    // È il messaggio più utile del lotto — dice CHE COSA fare — e finché il
    // `codice` veniva buttato via usciva la frase scritta a mano nella route,
    // in italiano anche con l'interfaccia in inglese: le voci EN di
    // `messages/en/shared.json` erano irraggiungibili, perché la PATCH admin è
    // l'unico posto da cui questi cinque codici arrivano.
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return ok(
          { error: 'PROSA-DEL-SERVER-CHE-NON-DEVE-USCIRE', codice: 'CANDIDATURA_EMAIL_GIA_STAFF' },
          409,
        )
      }
      return ok(rispostaPredefinita(url))
    })

    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itShared.erroreCandidaturaEmailGiaStaff)
    expect(avviso).not.toHaveTextContent('PROSA-DEL-SERVER-CHE-NON-DEVE-USCIRE')
    // E la traduzione inglese di quel codice esiste per davvero: senza, il
    // catalogo cadrebbe sulla prosa e questo test sarebbe verde per caso.
    expect(String(enShared.erroreCandidaturaEmailGiaStaff).trim()).not.toBe('')
  })

  it('CHIUSURA A METÀ (`stato: in_approvazione`): non dice «approvata», e i pulsanti restano spenti', async () => {
    // La route risponde `success: true` con `stato: 'in_approvazione'` quando
    // l'account docente È STATO CREATO ma la riga non è stata marcata
    // (`route.ts:865`). Prima il pannello intestava lo stesso riquadro
    // «Candidatura approvata» — guardando `esito.azione`, non `json.stato` —
    // mentre il badge sopra diceva «In approvazione».
    const AVVISO_SERVER =
      'L’account È STATO CREATO ma la candidatura non risulta marcata come approvata: NON ripremere «Approva» — segnalarlo all’assistenza.'
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return ok({
          success: true,
          stato: 'in_approvazione',
          credentials: { email: 'anna@example.test', password: 'Pw-di-prova-3' },
          credentialsEmailSent: true,
          warnings: [AVVISO_SERVER],
        })
      }
      return ok(rispostaPredefinita(url))
    })

    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))

    const titoloEsito = await screen.findByText('Presa in carico: chiusura NON riuscita')
    expect(screen.queryByText('Candidatura approvata')).not.toBeInTheDocument()
    // La tinta dice la stessa cosa del titolo: warn, non verde. Il titolo da solo
    // non basta a proteggere `esitoRiuscito` — sostituirlo con `esito !== null`
    // lasciava la suite verde, e il riquadro di un'approvazione rimasta a metà
    // tornava a essere quello di un successo.
    const riquadro = titoloEsito.parentElement as HTMLElement
    expect(riquadro.className).toContain('bg-kidville-warn-soft')
    expect(riquadro.className).not.toContain('bg-kidville-success-soft')
    // Intestazione e badge dicono la STESSA cosa.
    expect(screen.getAllByText('In approvazione').length).toBeGreaterThan(0)
    expect(screen.getByText('Approvazione rimasta a metà')).toBeInTheDocument()

    // «Ho preso nota» congeda le credenziali — e SOLO quelle.
    fireEvent.click(screen.getByRole('button', { name: 'Ho preso nota' }))
    await waitFor(() => expect(screen.queryByText('Pw-di-prova-3')).not.toBeInTheDocument())
    expect(screen.getByText(AVVISO_SERVER)).toBeInTheDocument()
    expect(screen.getByText('Approvazione rimasta a metà')).toBeInTheDocument()

    // E i due pulsanti NON tornano in mano: «Rifiuta» è accettato dal server su
    // `in_approvazione` e manderebbe l'email di rifiuto a chi ha già le credenziali.
    const approva = screen.getByRole('button', { name: 'Approva' })
    const rifiuta = screen.getByRole('button', { name: 'Rifiuta' })
    expect(approva).toBeDisabled()
    expect(rifiuta).toBeDisabled()
    expect(screen.getByText(/Approva e Rifiuta restano spenti/)).toBeInTheDocument()
  })
})

/**
 * LA CANDIDATURA CHE NON È DI UN'INSEGNANTE.
 *
 * Dal 2026-08-15 il modulo pubblico accoglie anche collaboratrici, cuoche,
 * segretarie e un mestiere scritto a mano. Nella stessa schermata la Segreteria
 * legge tre cose diverse da prima, e qui si misurano una per una: che lavoro fa
 * (le posizioni, più il testo libero quando c'è «altro»), che fasce ha (nessuna,
 * ed è legittimo, non un dato mancante) e che cosa succede premendo «Approva»
 * (niente account, niente email, nessuna password — né prima nella conferma, né
 * dopo nel riquadro dell'esito).
 */
describe('CandidatureInsegnanti — le posizioni non docenti', () => {
  /** «Altro» spuntato e il mestiere scritto accanto: le due colonne insieme. */
  const ALTRO = {
    ...DETTAGLIO,
    id: '66666666-6666-4666-8666-666666666666',
    nome: 'Dina',
    cognome: 'Ferro',
    posizioni: ['altro'],
    posizione_altro: 'Psicomotricista',
    gradi: [],
  }

  it('il mestiere scritto a mano si legge nel dettaglio quando fra le posizioni c’è «altro»', async () => {
    // La chip dice «Altro», che da sola non dice niente: la voce accanto è
    // l'unico posto in cui la Direzione legge per quale lavoro questa persona si
    // è proposta. In tabella le due colonne sono legate da un `CHECK` di
    // coerenza nei DUE versi (`('altro' = any(posizioni)) = (posizione_altro is
    // not null)`, migrazione `20260814225302`): «altro» senza testo non entra, e
    // testo senza «altro» nemmeno.
    serverConUnaSola(ALTRO)
    const { container } = await apriLaSola('Dina Ferro')
    const pannello = container.querySelector('[aria-busy]') as HTMLElement

    expect(within(pannello).getByText('Altro')).toBeInTheDocument()
    expect(within(pannello).getByText(itAdminAltro.candPosizioneAltro)).toBeInTheDocument()
    expect(within(pannello).getByText('Psicomotricista')).toBeInTheDocument()
  })

  it('senza «altro» fra le posizioni, quella voce non compare affatto — nemmeno come dato mancante', async () => {
    // Una voce vuota si legge come un'omissione: «Posizione indicata: Non
    // indicato» direbbe che manca qualcosa a una candidatura che è completa.
    serverConUnaSola(CUOCA)
    const { container } = await apriLaSola('Carmela Esposito')
    const pannello = container.querySelector('[aria-busy]') as HTMLElement

    expect(within(pannello).getByText('Cuoca / aiuto cucina')).toBeInTheDocument()
    expect(screen.queryByText(itAdminAltro.candPosizioneAltro)).not.toBeInTheDocument()
  })

  it('fasce VUOTE: il pannello dice «Nessuna», non «Non indicato»', async () => {
    // «Non indicato» manderebbe la Direzione a cercare un'omissione che non c'è,
    // sulla schermata da cui si decide un'assunzione: una cuoca non ha una fascia
    // d'età, e `gradiDallePosizioni` ritorna `[]` di proposito.
    serverConUnaSola(CUOCA)
    await apriLaSola('Carmela Esposito')

    const bloccoFasce = screen.getByText(itAdminAltro.candFasce).parentElement as HTMLElement
    expect(within(bloccoFasce).getByText(itAdminAltro.candNessunaFascia)).toBeInTheDocument()
    expect(within(bloccoFasce).queryByText('Non indicato')).not.toBeInTheDocument()
  })

  it('la CONFERMA di una candidatura di sola cuoca descrive l’operazione che parte davvero', async () => {
    // La conferma è la frase su cui la Direzione preme «Confermo»: se descrive
    // un'operazione diversa da quella che parte, il consenso che raccoglie non
    // vale niente. Qui la PATCH andrà in `approvaSenzaAccount` — niente utenza,
    // niente email, `credentials: null` — e la conferma deve dirlo.
    serverConUnaSola(CUOCA)
    await apriLaSola('Carmela Esposito')
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))

    expect(await screen.findByText(itAdminAltro.candConfermaApprovaSenzaAccount)).toBeInTheDocument()
    expect(screen.queryByText(/Verrà creato un account docente per/)).not.toBeInTheDocument()
    // E NIENTE avviso «nessuna fascia»: qui l'elenco vuoto non è un'anomalia da
    // sistemare a mano, è ciò che ha una cuoca. Un allarme che grida sempre
    // smette di essere letto quando dice qualcosa di vero.
    expect(screen.queryByText(itAdminAltro.candConfermaApprovaFasceMancanti)).not.toBeInTheDocument()
    // L'approvazione senza account resta un'operazione vera: il pulsante c'è.
    expect(screen.getByRole('button', { name: 'Confermo' })).toBeEnabled()
  })

  it('l’avviso «fasce mancanti» è dell’ALTRO ramo: candidatura docente con `gradi` vuoto', async () => {
    // È la controprova del test qui sopra: senza, «non mostra l'avviso» resterebbe
    // verde anche se quell'avviso non fosse più disegnato da nessuna parte. Su una
    // candidatura docente `gradi` vuoto è una riga incoerente — la route le DERIVA
    // dalle posizioni — ed è esattamente ciò che l'avviso manda a sistemare a mano.
    serverConUnaSola({ ...DETTAGLIO, gradi: [] })
    await apriLaSola('Anna Bianchi')
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))

    // Stessa ragione del test sopra: la chiave, non la frase.
    expect(
      await screen.findByText(
        new RegExp(itAdminAltro.candConfermaApprovaAccount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(itAdminAltro.candConfermaApprovaFasceMancanti)).toBeInTheDocument()
  })

  it('`esitoAccount: nessuno`: il pannello non manda a cercare un accesso che non esiste', async () => {
    // `credentials: null` significava una cosa sola — «esisteva già un accesso
    // con questa email» — e dal 2026-08-15 ne può significare due. Con la frase
    // vecchia, dopo l'approvazione di una cuoca la Segreteria andrebbe a cercare
    // in `utenti` un account che non è mai stato creato.
    serverConUnaSola(CUOCA, {
      success: true,
      id: CUOCA.id,
      stato: 'approvata',
      credentials: null,
      credentialsEmailSent: false,
      esitoAccount: 'nessuno',
      warnings: [],
    })
    await apriLaSola('Carmela Esposito')
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))

    const riquadro = (await screen.findByText('Candidatura approvata')).parentElement as HTMLElement
    expect(within(riquadro).getByText(itAdminAltro.candEsitoApprovataSenzaAccount)).toBeInTheDocument()
    expect(within(riquadro).queryByText(itAdminAltro.candNessunaCredenziale)).not.toBeInTheDocument()
    // E nessuna credenziale a schermo: non ce n'è nessuna da consegnare.
    // ⚠️ Sul `textContent` e sul `code`, non su `queryByText`: l'etichetta
    // «Credenziali:» vive dentro lo stesso `span` di email e password, quindi
    // `queryByText('Credenziali:')` ritorna `null` ANCHE quando le credenziali
    // sono a schermo — misurato. Un'asserzione così sarebbe verde per costruzione.
    expect(riquadro.textContent ?? '').not.toContain(itAdminAltro.candCredenziali)
    expect(riquadro.querySelector('code')).toBeNull()
    expect(within(riquadro).queryByText(itAdminAltro.candCredNonInviate)).not.toBeInTheDocument()
  })
})

describe('CandidatureInsegnanti — la PATCH in volo mentre si apre un’altra candidatura', () => {
  /**
   * È la stessa gara delle due aperture, ma sul ramo che CREA UN ACCOUNT DOCENTE.
   *
   * La PATCH dura secondi veri (crea l'utenza e manda l'email): se in quei secondi
   * la segreteria apre un'altra candidatura, la risposta atterrava sul pannello
   * sbagliato — la password e l'email dell'account di Anna sotto il nome di Bruno,
   * il badge «Approvata» timbrato su una candidatura ancora in attesa, e i due
   * pulsanti di Bruno spariti perché `decisa` era diventato vero.
   */
  /**
   * ⚠️ SI SPOSTA ANCHE LA RIGA DI SEDE, non solo l'aggregato.
   *
   * Dal 2026-08-19 badge e pulsanti leggono `candidature_sedi[…].stato`, non
   * `stato`: un fixture che sposta solo l'aggregato descrive una candidatura che
   * il database non può produrre — il trigger `candidature_sedi_aggrega` calcola
   * l'aggregato DALLE righe, quindi i due non possono essere in disaccordo.
   */
  const BRUNO_IN_ATTESA = {
    ...ELENCO[1],
    stato: 'pending',
    candidature_sedi: [{ scuola_id: 'sc-giugliano', stato: 'pending' }],
  }

  function serverConPatchLenta(ritardoMs: number) {
    let approvata = false
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return new Promise((risolvi) =>
          setTimeout(() => {
            approvata = true
            risolvi({
              ok: true,
              status: 200,
              json: async () => ({
                success: true,
                stato: 'approvata',
                credentials: { email: 'anna@example.test', password: 'PW-DI-ANNA' },
                credentialsEmailSent: true,
                warnings: [],
              }),
            })
          }, ritardoMs),
        )
      }
      const u = String(url)
      if (u.includes(`id=${ELENCO[1].id}`)) {
        return ok({ data: { ...BRUNO_IN_ATTESA, email: 'bruno@example.test', telefono: null, cv_path: null } })
      }
      if (u.includes('id=')) return ok({ data: DETTAGLIO })
      // L'elenco ricaricato dopo la PATCH dice la verità: Anna è approvata.
      return ok({
        data: [
          approvata
            ? {
                ...ELENCO[0],
                stato: 'approvata',
                candidature_sedi: [{ scuola_id: 'sc-aversa', stato: 'approvata' }],
              }
            : ELENCO[0],
          BRUNO_IN_ATTESA,
        ],
        total: 2,
      })
    })
  }

  it('la risposta della PATCH non atterra sul pannello di un’altra candidatura', async () => {
    serverConPatchLenta(120)
    const { container } = render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))

    // Mentre la PATCH è in volo, la segreteria apre l'altra candidatura.
    fireEvent.click(screen.getByText('Bruno Neri'))
    await waitFor(() => expect(screen.getByText('bruno@example.test')).toBeInTheDocument())

    await attendi(220)
    // Le credenziali di Anna NON compaiono nel PANNELLO, cioè sotto il nome di
    // Bruno: è lì che stava il difetto, e il perimetro dell'asserzione è quello.
    // (Fuori dal pannello compaiono eccome, sotto il nome di Anna: la password è
    // monouso e buttarla costringe a una reimpostazione — lo misura il test
    // «l'esito che non si può mostrare si DICE».)
    const pannello = container.querySelector('[aria-busy]') as HTMLElement
    expect(within(pannello).queryByText('PW-DI-ANNA')).not.toBeInTheDocument()
    expect(within(pannello).queryByText('Candidatura approvata')).not.toBeInTheDocument()
    // …il pannello aperto è ancora quello di Bruno…
    expect(within(pannello).getByRole('heading', { name: 'Bruno Neri', level: 2 })).toBeInTheDocument()
    // …e la sua candidatura non è stata timbrata: i due pulsanti sono ancora lì.
    expect(screen.getByRole('button', { name: 'Approva' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Rifiuta' })).toBeEnabled()
  })

  it('l’esito che non si può mostrare si DICE, e l’elenco resta aggiornato', async () => {
    // Scartare in silenzio sarebbe l'altra metà dello stesso difetto: l'account
    // docente è stato creato davvero, e chi ha premuto «Confermo» deve sapere
    // dove andarne a leggere lo stato.
    serverConPatchLenta(120)
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))
    fireEvent.click(screen.getByText('Bruno Neri'))

    const avviso = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(avviso).toHaveTextContent('Anna Bianchi')
    expect(avviso).toHaveTextContent(itAdminAltro.candEsitoScartatoPost)

    // E la ricarica dell'elenco è avvenuta lo stesso: la riga di Anna dice il
    // suo stato NUOVO, quella di Bruno il suo di sempre.
    // Il nome compare due volte (nell'avviso e in elenco): qui serve la RIGA.
    const rigaAnna = rigaElencoDi('Anna Bianchi')
    const rigaBruno = rigaElencoDi('Bruno Neri')
    await waitFor(() => expect(within(rigaAnna).getByText('Approvata')).toBeInTheDocument())
    expect(within(rigaBruno).getByText('In attesa')).toBeInTheDocument()

    // E l'esito è riportato PER INTERO, credenziali comprese: la password è
    // monouso e non è archiviata da nessuna parte — buttarla qui vorrebbe dire
    // una reimpostazione obbligata su un account che esiste già.
    expect(within(avviso).getByText('PW-DI-ANNA')).toBeInTheDocument()
    expect(within(avviso).getByText(itAdminAltro.candScartatoAccountCreato)).toBeInTheDocument()
  })

  /**
   * «Indietro» è la stessa gara, sul gesto opposto: invece di aprire un'altra
   * candidatura si CHIUDE il pannello. Il gettone avanza lo stesso, e deve —
   * senza quella riga la risposta della PATCH si considera «attuale» e scrive
   * `esito` e `avvisi` dentro un pannello che non è più montato: a schermo non
   * resta NIENTE. Account docente creato, password persa, email mai partita, e
   * nessun avviso da nessuna parte. Fino al 2026-08-11 nessun test lo copriva:
   * togliendo `gettoneDettaglio.current += 1` da `chiudiDettaglio` la suite
   * restava 42/42 verde (misurato).
   */
  function serverConPatchLentaSenzaEmail(ritardoMs: number) {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return new Promise((risolvi) =>
          setTimeout(() => risolvi({
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              stato: 'approvata',
              credentials: { email: 'anna@example.test', password: 'PW-DI-ANNA' },
              credentialsEmailSent: false,
              warnings: ['Email delle credenziali NON inviata: the domain is not verified.'],
            }),
          }), ritardoMs),
        )
      }
      const u = String(url)
      if (u.includes(`id=${ELENCO[1].id}`)) {
        return ok({ data: { ...BRUNO_IN_ATTESA, email: 'bruno@example.test', telefono: null, cv_path: null } })
      }
      if (u.includes('id=')) return ok({ data: DETTAGLIO })
      return ok({ data: [ELENCO[0], BRUNO_IN_ATTESA], total: 2 })
    })
  }

  it('«INDIETRO» durante la PATCH: l’esito non si perde in silenzio, e il pannello non si riapre', async () => {
    serverConPatchLentaSenzaEmail(120)
    const { container } = render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))

    // Nessuna seconda apertura: si chiude e basta.
    fireEvent.click(screen.getByRole('button', { name: 'Indietro' }))
    await waitFor(() => expect(screen.getByText(itAdminAltro.candSelezionaDettagli)).toBeInTheDocument())

    const avviso = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(avviso).toHaveTextContent('Anna Bianchi')
    // Le tre cose che senza questo avviso sparivano tutte insieme.
    expect(within(avviso).getByText(itAdminAltro.candScartatoAccountCreato)).toBeInTheDocument()
    expect(within(avviso).getByText('PW-DI-ANNA')).toBeInTheDocument()
    expect(within(avviso).getByText(/the domain is not verified/)).toBeInTheDocument()
    expect(within(avviso).getByText(itAdminAltro.candCredNonInviate)).toBeInTheDocument()

    // …e il pannello NON si è riaperto da solo sotto le dita di chi l'ha chiuso.
    const pannello = container.querySelector('[aria-busy]') as HTMLElement
    expect(within(pannello).queryByRole('heading', { name: 'Anna Bianchi', level: 2 })).not.toBeInTheDocument()
  })

  it('il testo NON afferma un fatto che non è avvenuto: su «Indietro» nessuna candidatura è stata aperta', async () => {
    // Il testo precedente diceva «nel frattempo è stata aperta un'altra
    // candidatura»: su questo percorso è falso, e lo si leggeva comunque.
    serverConPatchLentaSenzaEmail(120)
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Indietro' }))

    const avviso = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(avviso).toHaveTextContent(itAdminAltro.candEsitoScartatoPost)
    // La frase copre ENTRAMBE le cause, e non ne afferma una sola.
    expect(itAdminAltro.candEsitoScartatoPost).toMatch(/chius/i)
    expect(enAdminAltro.candEsitoScartatoPost).toMatch(/clos/i)
  })

  it('l’avviso NON sparisce aprendo altre candidature: se ne va solo con il gesto', async () => {
    // Bastavano due clic: `apriDettaglio` azzerava l'unica traccia di un account
    // docente creato e di una password che non esiste da nessun'altra parte.
    serverConPatchLentaSenzaEmail(120)
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))
    fireEvent.click(screen.getByText('Bruno Neri'))

    const avviso = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(within(avviso).getByText('PW-DI-ANNA')).toBeInTheDocument()

    // Seconda apertura, e terza: l'avviso è ancora lì, con tutto quello che dice.
    fireEvent.click(rigaElencoDi('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Bruno Neri'))
    await waitFor(() => expect(screen.getByText('bruno@example.test')).toBeInTheDocument())
    expect(within(screen.getByRole('alert')).getByText('PW-DI-ANNA')).toBeInTheDocument()

    // Se ne va SOLO con il gesto esplicito.
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.candEsitoScartatoCongeda }))
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0))
    expect(screen.queryByText('PW-DI-ANNA')).not.toBeInTheDocument()
  })

  it('un’operazione RESPINTA non si racconta come un account creato', async () => {
    // Lo stesso avviso serve due esiti opposti: dire «l'account è stato creato»
    // su un 409 manderebbe la segreteria a cercare credenziali che non esistono.
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return new Promise((risolvi) =>
          setTimeout(() => risolvi({
            ok: false,
            status: 409,
            json: async () => ({ error: 'x', codice: 'CANDIDATURA_GIA_EVASA' }),
          }), 120),
        )
      }
      const u = String(url)
      if (u.includes(`id=${ELENCO[1].id}`)) {
        return ok({ data: { ...BRUNO_IN_ATTESA, email: 'bruno@example.test', telefono: null, cv_path: null } })
      }
      if (u.includes('id=')) return ok({ data: DETTAGLIO })
      return ok({ data: [ELENCO[0], BRUNO_IN_ATTESA], total: 2 })
    })

    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))
    fireEvent.click(screen.getByText('Bruno Neri'))

    const avviso = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(within(avviso).getByText(itAdminAltro.candScartatoRespinta)).toBeInTheDocument()
    expect(avviso).not.toHaveTextContent(itAdminAltro.candScartatoAccountCreato)
  })

  it('l’esito scartato di un’approvazione SENZA ACCOUNT non racconta un account creato', async () => {
    // Stesso avviso, terza storia. Qui è l'UNICA copia di ciò che è successo —
    // il pannello è stato chiuso e non c'è nessun posto in cui andare a
    // rileggere — quindi una frase sbagliata non la corregge nessuno: dire
    // «l'account docente È STATO CREATO» dopo l'approvazione di una cuoca
    // manderebbe la Segreteria a cercarlo in `utenti` per sempre.
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return new Promise((risolvi) => setTimeout(() => risolvi({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            id: CUOCA.id,
            stato: 'approvata',
            credentials: null,
            credentialsEmailSent: false,
            esitoAccount: 'nessuno',
            warnings: [],
          }),
        }), 120))
      }
      const u = String(url)
      if (u.includes('id=')) return ok({ data: CUOCA })
      return ok({ data: [CUOCA], total: 1 })
    })

    await apriLaSola('Carmela Esposito')
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Indietro' }))

    const avviso = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(avviso).toHaveTextContent('Carmela Esposito')
    expect(within(avviso).getByText(itAdminAltro.candEsitoApprovataSenzaAccount)).toBeInTheDocument()
    expect(avviso).not.toHaveTextContent(itAdminAltro.candScartatoAccountCreato)
    // E nemmeno «esisteva già un accesso con questa email», che è l'altra frase
    // che manda a cercare: `credentials === null` non basta più a scegliere.
    expect(within(avviso).queryByText(itAdminAltro.candNessunaCredenziale)).not.toBeInTheDocument()
  })

  it('durante la PATCH su Anna i pulsanti di BRUNO sono accesi; quelli di Anna spenti CON il motivo', async () => {
    // `lavorando` era condiviso: dentro la finestra della PATCH (secondi veri) il
    // pannello di Bruno aveva i due pulsanti spenti, senza `title` e senza una
    // riga che dicesse perché. Il test esistente guardava solo DOPO l'atterraggio,
    // cioè fuori dalla finestra in cui l'interfaccia sembrava rotta.
    serverConPatchLentaSenzaEmail(300)
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))

    // DENTRO la finestra: Bruno non risente dell'operazione su Anna.
    fireEvent.click(screen.getByText('Bruno Neri'))
    await waitFor(() => expect(screen.getByText('bruno@example.test')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Approva' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Rifiuta' })).toBeEnabled()
    expect(screen.queryByText(itAdminAltro.candAzioneInCorso)).not.toBeInTheDocument()

    // Riaprendo ANNA, invece, i pulsanti restano spenti — e adesso si legge
    // perché, a schermo e nel `title`: ripremerli farebbe partire due volte la
    // creazione dello stesso account.
    fireEvent.click(rigaElencoDi('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    const approva = screen.getByRole('button', { name: 'Approva' })
    expect(approva).toBeDisabled()
    expect(approva).toHaveAttribute('title', itAdminAltro.candAzioneInCorso)
    expect(screen.getByText(itAdminAltro.candAzioneInCorso)).toBeInTheDocument()

    // E quando la PATCH atterra, il motivo se ne va con lei.
    await waitFor(
      () => expect(screen.queryByText(itAdminAltro.candAzioneInCorso)).not.toBeInTheDocument(),
      { timeout: 2000 },
    )
  })
})

describe('CandidatureInsegnanti — rifiuto', () => {
  it('motivo facoltativo e «avvisa via email» SPENTA di default; il corpo li rispecchia', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') return ok({ success: true, stato: 'rifiutata', esitoEmailInviato: false, warnings: [] })
      return ok(rispostaPredefinita(url))
    })

    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Rifiuta' }))

    const spunta = await screen.findByRole('checkbox')
    expect(spunta).not.toBeChecked()

    fireEvent.change(screen.getByLabelText('Motivo (facoltativo)'), { target: { value: 'Profilo non in linea' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confermo' }))

    await waitFor(() => expect(screen.getByText('Candidatura rifiutata')).toBeInTheDocument())
    const patch = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH')
    const corpo = JSON.parse((patch?.[1] as { body: string }).body)
    expect(corpo).toMatchObject({ action: 'rifiuta', motivo: 'Profilo non in linea', inviaEmailEsito: false })
  })

  it('con la spunta accesa il corpo chiede l’email di esito', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') return ok({ success: true, stato: 'rifiutata', esitoEmailInviato: true, warnings: [] })
      return ok(rispostaPredefinita(url))
    })

    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Rifiuta' }))
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Confermo' }))

    await waitFor(() => expect(screen.getByText(/Email di esito inviata/)).toBeInTheDocument())
    const patch = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH')
    expect(JSON.parse((patch?.[1] as { body: string }).body)).toMatchObject({ inviaEmailEsito: true })
  })
})

describe('CandidatureInsegnanti — chi può decidere', () => {
  it('la SEGRETERIA vede i due pulsanti spenti, con il motivo scritto e nel title', async () => {
    ruoloCorrente = 'segreteria'
    await apriPrima()

    const approva = screen.getByRole('button', { name: 'Approva' })
    const rifiuta = screen.getByRole('button', { name: 'Rifiuta' })
    expect(approva).toBeDisabled()
    expect(rifiuta).toBeDisabled()
    expect(approva).toHaveAttribute('title', expect.stringMatching(/Solo la Direzione/))
    expect(rifiuta).toHaveAttribute('title', expect.stringMatching(/Solo la Direzione/))
    // Il motivo è anche VISIBILE: un `title` non compare su touch e non è
    // annunciato in modo uniforme su un elemento disabilitato.
    expect(screen.getByText(/Solo la Direzione può approvare o rifiutare/)).toBeInTheDocument()
  })

  it('finché il ruolo non è noto, il motivo dice che è una verifica in corso (non «non puoi»)', async () => {
    ruoloCorrente = ''
    await apriPrima()
    expect(screen.getByRole('button', { name: 'Approva' })).toBeDisabled()
    expect(screen.getByText(/Verifica del ruolo in corso/)).toBeInTheDocument()
    expect(screen.queryByText(/Solo la Direzione/)).not.toBeInTheDocument()
  })

  it('la DIREZIONE li ha accesi', async () => {
    ruoloCorrente = 'coordinator'
    await apriPrima()
    expect(screen.getByRole('button', { name: 'Approva' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Rifiuta' })).toBeEnabled()
  })
})

describe('CandidatureInsegnanti — curriculum', () => {
  it('la scheda si apre DENTRO il gesto, e la URL firmata ci viene assegnata dopo', async () => {
    // `window.open` dopo un `await` è fuori dal gesto dell'utente: Safari e la
    // WebView Capacitor (l'app è spedita nativa) la bloccano regolarmente. La
    // scheda si apre PRIMA della fetch, vuota, e poi le si assegna la URL.
    await apriPrima()
    fireEvent.click(screen.getByText('Apri il curriculum'))

    expect(openMock).toHaveBeenCalledWith('', '_blank')
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('doc=candidature%2Fcv-anna.pdf'),
        expect.objectContaining({ headers: { 'x-sedi': 'sc-giugliano,sc-aversa' } }),
      ),
    )
    await waitFor(() =>
      expect(finestraAperta?.location.replace).toHaveBeenCalledWith('https://storage.example.test/firmata'),
    )
    // Il percorso grezzo non finisce mai in una barra degli indirizzi.
    expect(openMock).not.toHaveBeenCalledWith(
      expect.stringContaining('candidature/cv-anna.pdf'),
      expect.anything(),
    )
  })

  it('finestra BLOCCATA dal browser: lo dice, e dà il link da aprire a mano', async () => {
    // Prima il valore di ritorno non lo guardava nessuno: il pulsante non faceva
    // niente e non diceva niente. In jsdom non si vedeva perché `open` è finto —
    // qui il finto restituisce `null`, che è ciò che fa un browser che blocca.
    openMock.mockImplementation(() => null)
    await apriPrima()
    fireEvent.click(screen.getByText('Apri il curriculum'))

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(/ha bloccato l’apertura del curriculum/i)
    const link = within(avviso).getByRole('link', { name: 'Aprilo a mano' })
    expect(link).toHaveAttribute('href', 'https://storage.example.test/firmata')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('firma non riuscita: avviso in pagina, e la scheda aperta a vuoto si richiude', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('?doc=')) return ok({ error: 'x', codice: 'CANDIDATURE_OPERAZIONE_NON_RIUSCITA' }, 503)
      return ok(rispostaPredefinita(url))
    })
    await apriPrima()
    fireEvent.click(screen.getByText('Apri il curriculum'))

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(/curriculum non è apribile/i)
    expect(finestraAperta?.location.replace).not.toHaveBeenCalled()
    expect(finestraAperta?.close).toHaveBeenCalled()
  })
})

describe('CandidatureInsegnanti — le etichette dei campi che decidono', () => {
  it('titolo di studio e disponibilità si leggono come ETICHETTE, mai come valori di database', async () => {
    // Sono due dei campi da cui dipende la decisione, e si leggevano
    // `laurea_magistrale` e `tempo_pieno` — con l'underscore — mentre le fasce
    // accanto, nello stesso pannello, erano tradotte. Erano tre fino al
    // 2026-08-24: la disponibilità non si chiede più, ma questo caso continua a
    // esercitarla perché `DETTAGLIO` è una candidatura STORICA, di quelle che
    // quel valore in tabella ce l'hanno.
    const { container } = await apriPrima()

    // `:not(option)`: il titolo di studio è anche una voce della tendina «Titolo
    // di studio» nella barra filtri. Qui si misura il DATO della candidatura.
    expect(screen.getByText('Laurea magistrale', { selector: ':not(option)' })).toBeInTheDocument()
    expect(screen.getByText('Tempo pieno')).toBeInTheDocument()

    // ⚠️ E anche l'ETICHETTA, non solo il valore (aggiunto al giro 4 del 2026-08-25).
    // Il caso qui sotto pretende che su una candidatura NUOVA la riga «Disponibilità»
    // non compaia; questo pretende che su una STORICA compaia. Senza questa riga il
    // verso positivo era scoperto per metà: `getByText('Tempo pieno')` non dice CHE
    // COSA sia «Tempo pieno», quindi sostituire `t('candDisponibilita')` con un'altra
    // chiave — `t('candAnni')`, per dire — avrebbe lasciato TUTTI i casi del file
    // verdi, con la scheda su cui si decide un'assunzione che chiama il dato con il
    // nome di un altro. La coppia etichetta+valore è ciò che rende leggibile la riga.
    expect(screen.getByText(itAdminAltro.candDisponibilita)).toBeInTheDocument()

    // Nessun token con underscore a schermo, in nessun punto del pannello.
    const conUnderscore = (container.textContent ?? '').match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []
    expect(conUnderscore, `token di database a schermo: ${conUnderscore.join(', ')}`).toEqual([])
  })

  it('un titolo FUORI enum resta grezzo invece di sparire', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('id=')) {
        return ok({ data: { ...DETTAGLIO, titolo_studio: 'dottorato_di_ricerca', disponibilita: null } })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriPrima()
    expect(screen.getByText('dottorato_di_ricerca')).toBeInTheDocument()
    // ⚠️ QUI C'ERA `getAllByText('Non indicato').length > 0`, col commento «e la
    // disponibilità vuota resta un dato mancante, non un errore». Era l'unico
    // «Non indicato» del pannello: `DETTAGLIO` ha tutti gli altri facoltativi
    // valorizzati, `note` compresa. Cioè quell'asserzione misurava ESATTAMENTE la
    // riga che la decisione del 2026-08-24 toglie, e affiancargliene una che ne
    // pretende l'assenza avrebbe reso il test insoddisfacibile. Sostituita, non
    // aggiunta. La REGOLA «vuoto → Non indicato» resta sorvegliata su ALTRI
    // componenti, dove è ancora vera: `StaffDetailPanel-anagrafica` e i due
    // riepiloghi dei wizard. Su QUESTA `Voce`, che è una funzione privata di
    // questo file e non la stessa, la sorveglianza la rimettono in piedi i due
    // casi qui sotto — ed è per questo che le due frasi non si contraddicono.
  })

  it('la candidatura NUOVA, senza disponibilità, non mostra la riga: né il valore né l’etichetta', async () => {
    // ⚠️ QUESTO CASO ESISTE PER AVERE UN NOME PROPRIO, e il nome è la metà del
    // presidio. Fino al 2026-08-25 questa asserzione viveva dentro «un titolo
    // FUORI enum resta grezzo»: funzionava — misurata, rimettendo la riga
    // incondizionata il test diventava rosso — ma difendeva una DECISIONE DEL
    // TITOLARE sotto il nome di un'altra cosa. Il giorno in cui qualcuno rifà il
    // caso del titolo di studio, quella guardia se ne va con lui e nessun nome
    // nel file avrà mai annunciato che stava lì.
    //
    // La decisione: dal 2026-08-24 la domanda non si fa più, quindi sulle
    // candidature che il valore non ce l'hanno la riga non compare AFFATTO.
    // «Disponibilità: Non indicato» accuserebbe chi si è candidato di
    // un'omissione su una domanda che non gli è mai stata fatta.
    //
    // Si NOMINA l'etichetta, non si conta il «Non indicato»: è ciò che distingue
    // «la riga non c'è» da «la riga c'è e dice Non indicato», che a occhio si
    // somigliano e sono la differenza fra un dato assente e un'accusa.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('id=')) {
        return ok({ data: { ...DETTAGLIO, disponibilita: null } })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriPrima()
    expect(
      screen.queryByText(itAdminAltro.candDisponibilita),
      'la riga «Disponibilità» compare su una candidatura a cui quella domanda non è ' +
        'mai stata fatta: se dice «Non indicato», accusa di un’omissione',
    ).not.toBeInTheDocument()
    // La controprova che il pannello si è davvero aperto: senza, un dettaglio
    // mai renderizzato soddisferebbe l'asserzione qui sopra per il motivo
    // sbagliato — è la forma più silenziosa di test verde.
    expect(screen.getByText(itAdminAltro.candTelefono)).toBeInTheDocument()
  })

  it('un facoltativo VUOTO si legge «Non indicato»: la riga resta, e a mancare è il dato', async () => {
    // ⚠️ QUESTA È LA GUARDIA CHE LA RIMOZIONE DELLA DISPONIBILITÀ HA LASCIATO
    // SCOPERTA, e va rimessa qui perché `Voce` è privata di QUESTO file.
    //
    // Fino al 2026-08-24 il ramo vuoto di `Voce` era esercitato dalla
    // disponibilità assente (vedi il test qui sopra). Oggi `DETTAGLIO` ha tutti
    // gli altri facoltativi valorizzati, quindi in questo pannello non compare
    // più nemmeno un «Non indicato» e nessun caso di questo file lo pretende:
    // estendere a `Voce` la regola «se è vuoto non stampare la riga» — che per
    // la disponibilità è la decisione giusta — farebbe sparire in silenzio anche
    // Email, Telefono e Residenza dalla scheda su cui si decide un'assunzione, e
    // la suite resterebbe verde.
    //
    // Il telefono è il campo giusto per dirlo: la domanda gliela si fa ancora,
    // quindi lasciarlo in bianco È un'omissione — ed è la differenza esatta con
    // la disponibilità, che invece nessuno chiede più.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('id=')) {
        return ok({ data: { ...DETTAGLIO, telefono: null } })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriPrima()
    expect(screen.getByText(itAdminAltro.candTelefono)).toBeInTheDocument()
    // `getAllByText` e non `getByText`: al singolare questo caso regge solo
    // finché `DETTAGLIO` tiene valorizzati TUTTI gli altri facoltativi. Il
    // giorno in cui qualcuno ne svuota un secondo, `getByText` esplode con
    // «found multiple elements» e il test diventa rosso per una ragione che non
    // c'entra niente col comportamento che difende — cioè rumore, non un
    // segnale. Ciò che si pretende è che il ramo vuoto di `Voce` stampi la riga,
    // e per quello basta che ce ne sia almeno uno.
    expect(
      screen.getAllByText(itAdminAltro.candNonIndicato).length,
      'un facoltativo vuoto non si legge più come dato mancante',
    ).toBeGreaterThan(0)
  })

  it('TUTTE le posizioni del modulo si leggono tradotte, non solo quelle delle fixture', async () => {
    // Il lock qui sotto verifica che il CATALOGO abbia una voce per ogni valore.
    // Questo verifica l'altro anello, che nessun catalogo può dare: che il
    // pannello sappia RISOLVERLA. Fra i due c'è la mappa interna del componente,
    // che non è esportata — una posizione aggiunta al template, tradotta nei due
    // cataloghi e dimenticata lì tornerebbe a schermo come `insegnante_nido`,
    // cioè il difetto corretto l'11/08/2026 per titolo di studio e disponibilità.
    //
    // Le sette si spuntano tutte insieme: `posizioni` è multi-valore, quindi una
    // candidatura sola le esercita tutte. `posizione_altro` è valorizzato perché
    // fra quelle c'è «altro» e il `CHECK` di coerenza in tabella lo pretende.
    serverConUnaSola({
      ...DETTAGLIO,
      posizioni: [...POSIZIONI_AMMESSE],
      posizione_altro: 'Psicomotricista',
    })
    const { container } = await apriLaSola('Anna Bianchi')

    const conUnderscore = (container.textContent ?? '').match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []
    expect(conUnderscore, `token di database a schermo: ${conUnderscore.join(', ')}`).toEqual([])

    // …e le sette sono disegnate davvero: un pannello che non ne mostrasse
    // NESSUNA passerebbe il controllo qui sopra senza dire niente.
    const bloccoPosizioni = screen.getByText(itAdminAltro.candPosizioni).parentElement as HTMLElement
    const chip = [...bloccoPosizioni.querySelectorAll('span')].map((s) => s.textContent ?? '')
    expect(chip).toHaveLength(POSIZIONI_AMMESSE.length)
    expect(chip.filter((testo) => POSIZIONI_AMMESSE.includes(testo))).toEqual([])
  })

  it('ogni valore dei DUE enum del modulo — e le cinque etichette storiche — ha la sua etichetta in italiano e in inglese', () => {
    // Il perimetro si legge dal template, non si ricopia: una voce aggiunta lì e
    // dimenticata qui tornerebbe a schermo con l'underscore.
    //
    // Dal 2026-08-15 gli enum del modulo erano TRE: `posizioni` è entrato con
    // sette valori che sono token di database (`insegnante_nido`), e a
    // differenza degli altri si legge anche in ELENCO, cioè sulla prima
    // schermata che la Segreteria apre.
    //
    // ⚠️ Dal 2026-08-24 sono DUE: la disponibilità è uscita dal modulo. Le sue
    // cinque etichette sopravvivono al campo perché sopravvivono i DATI — la
    // colonna resta piena per le candidature arrivate prima — e la loro
    // sorveglianza si è dovuta spostare, perché quella vecchia leggeva dal
    // template e col campo sarebbe morta in silenzio. Sta nel secondo blocco,
    // in coda a questo test.
    //
    // ⚠️ La mappa è per CAMPO e non per valore: `altro` sta in due enum diversi
    // («Altro titolo» e la posizione «Altro») e vuole due chiavi diverse. Con una
    // mappa piatta una delle due sparirebbe, e il lock guarderebbe l'altra
    // credendo di averle controllate entrambe.
    const opzioni = (id: string) =>
      (INSEGNANTE_FIELDS.find((f) => f.id === id)?.options ?? []).map((o) => String(o.value))
    const attese: Record<string, Record<string, string>> = {
      titolo_studio: {
        licenza_media: 'candTitoloLicenzaMedia',
        diploma: 'candTitoloDiploma',
        magistrale: 'candTitoloMagistrale',
        laurea_triennale: 'candTitoloLaureaTriennale',
        laurea_magistrale: 'candTitoloLaureaMagistrale',
        formazione_primaria: 'candTitoloFormazionePrimaria',
        master: 'candTitoloMaster',
        altro: 'candTitoloAltro',
      },
      posizioni: {
        insegnante_nido: 'candPosInsegnanteNido',
        insegnante_infanzia: 'candPosInsegnanteInfanzia',
        insegnante_primaria: 'candPosInsegnantePrimaria',
        collaboratrice: 'candPosCollaboratrice',
        cuoca: 'candPosCuoca',
        segreteria: 'candPosSegreteria',
        altro: 'candPosAltro',
      },
    }
    const campi = Object.keys(attese)
    const valori = campi.flatMap((campo) => opzioni(campo))
    expect(valori.length, 'il template non espone più le opzioni: il lock non guarda niente').toBe(15)
    // Le posizioni del CAMPO sono le stesse che la route filtra con lo `z.enum`:
    // se un giorno divergessero, questo lock sorveglierebbe una lista e a schermo
    // ne arriverebbe un'altra.
    expect(opzioni('posizioni')).toEqual(POSIZIONI_AMMESSE)

    for (const campo of campi) {
      for (const valore of opzioni(campo)) {
        const chiave = attese[campo][valore]
        expect(chiave, `nessuna chiave i18n per «${campo} → ${valore}»`).toBeTruthy()
        expect(itAdminAltro, `it/adminAltro.json → ${chiave}`).toHaveProperty(chiave)
        expect(enAdminAltro, `en/adminAltro.json → ${chiave}`).toHaveProperty(chiave)
      }
    }

    // ── LE CINQUE ETICHETTE STORICHE, e la loro fonte NON è più il template ────
    // Il campo «Disponibilità» è uscito dal modulo il 2026-08-24 (in Kidville si
    // lavora solo a tempo pieno). Le candidature che quel valore ce l'hanno in
    // tabella continuano però a leggersi in segreteria, e queste cinque chiavi
    // sono ciò che le traduce. La fonte è la mappa che le RISOLVE — non un
    // elenco ribattuto qui, che divergerebbe dalla mappa senza che nulla lo dica.
    //
    // ⚠️ È l'unica sorveglianza rimasta su `candDisp*`: `messaggi-chiavi-orfane`
    // ha sotto tutela il solo namespace `adminModulistica`, e la parità dei
    // cataloghi guarda le chiavi, non il loro uso.
    //
    // ⚠️ E l'esempio che lo dimostra è la rimozione SIMMETRICA, non quella da un
    // catalogo solo. Misurato: togliendo `candDispTirocinio` dal solo
    // `en/adminAltro.json` i rossi sono DUE — questo lock e `messaggi-parita-
    // cataloghi`, che confronta le chiavi namespace per namespace; togliendolo
    // da `it` E da `en` insieme la parità resta verde (i due cataloghi restano
    // identici) e il rosso è UNO SOLO, questo. Cioè il caso che qui era portato
    // ad esempio è l'unico dei due già coperto altrove, e citarlo faceva
    // sembrare vigilato dal lock sbagliato l'unico che questo lock vigila da
    // solo. Senza, la segreteria tornerebbe a leggere `tempo_pieno` con
    // l'underscore sulle candidature storiche: il difetto corretto l'11/08.
    expect(INSEGNANTE_FIELDS.find((f) => f.id === 'disponibilita'),
      'il campo è tornato nel template: le cinque voci vanno rimesse fra gli enum derivati',
    ).toBeUndefined()
    expect(Object.keys(CHIAVE_DISPONIBILITA)).toHaveLength(5)
    for (const [valore, chiave] of Object.entries(CHIAVE_DISPONIBILITA)) {
      expect(itAdminAltro, `it/adminAltro.json → ${chiave} (valore storico «${valore}»)`).toHaveProperty(chiave)
      expect(enAdminAltro, `en/adminAltro.json → ${chiave} (valore storico «${valore}»)`).toHaveProperty(chiave)
    }
    expect(itAdminAltro).toHaveProperty('candDisponibilita')
    expect(enAdminAltro).toHaveProperty('candDisponibilita')
  })
})

describe('CandidatureInsegnanti — accessibilità e cataloghi', () => {
  it('nessuna violazione jest-axe con il dettaglio e la conferma aperti', async () => {
    const { container } = render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Rifiuta' }))
    await screen.findByRole('checkbox')

    const esito = await axe(container, {
      rules: {
        region: { enabled: false },
        'landmark-one-main': { enabled: false },
        'page-has-heading-one': { enabled: false },
      },
    })
    expect(esito).toHaveNoViolations()
  })

  it('nessuna violazione jest-axe con l’avviso dell’esito scartato a schermo', async () => {
    // È markup nuovo, ed è una regione live che contiene un comando: se `axe`
    // non gira su un albero che lo comprende, l'altro test a11y è verde su una
    // schermata che non è quella in cui compare questo avviso.
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return new Promise((risolvi) =>
          setTimeout(() => risolvi({
            ok: true,
            status: 200,
            json: async () => ({
              success: true, stato: 'approvata',
              credentials: { email: 'anna@example.test', password: 'Pw-di-prova-9' },
              credentialsEmailSent: false,
              warnings: ['Email delle credenziali NON inviata: the domain is not verified.'],
            }),
          }), 60),
        )
      }
      return ok(rispostaPredefinita(url))
    })

    const { container } = await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Indietro' }))
    await screen.findByRole('alert', {}, { timeout: 2000 })

    const esito = await axe(container, {
      rules: {
        region: { enabled: false },
        'landmark-one-main': { enabled: false },
        'page-has-heading-one': { enabled: false },
      },
    })
    expect(esito).toHaveNoViolations()
  })

  it('il pannello ha punti di salto veri: titoli, non `p` vestiti da titolo', async () => {
    // Con uno screen reader un frammento senza nessun `h1`–`h6` non offre nessun
    // punto di salto: le tre regole spente qui sopra sono legittime per un
    // frammento, ma sono anche le tre che avrebbero potuto farlo notare.
    await apriPrima()
    expect(screen.getByRole('heading', { name: 'Candidature ricevute', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Anna Bianchi', level: 2 })).toBeInTheDocument()
    for (const titolo of ['Contatti', 'Profilo', 'Presentazione']) {
      expect(screen.getByRole('heading', { name: titolo, level: 3 })).toBeInTheDocument()
    }
  })

  it('aprire una candidatura porta il FUOCO sull’intestazione del pannello', async () => {
    // Su schermo stretto il pannello sostituisce la vista: chi naviga da tastiera
    // restava sul pulsante della riga, con il «torna indietro» irraggiungibile
    // senza riattraversare tutto l'elenco.
    await apriPrima()
    const intestazione = screen.getByRole('heading', { name: 'Anna Bianchi', level: 2 })
    expect(document.activeElement).toBe(intestazione)
  })

  it('il contenitore del dettaglio dichiara `aria-busy` mentre carica', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('id=')) {
        return new Promise((risolvi) =>
          setTimeout(() => risolvi({ ok: true, status: 200, json: async () => ({ data: DETTAGLIO }) }), 60),
        )
      }
      return ok(rispostaPredefinita(u))
    })
    const { container } = render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    const contenitore = container.querySelector('[aria-busy]') as HTMLElement
    expect(contenitore).toHaveAttribute('aria-busy', 'false')

    fireEvent.click(screen.getByText('Anna Bianchi'))
    expect(contenitore).toHaveAttribute('aria-busy', 'true')
    // …e il velo è annunciato, non è solo una rotella che gira. Si NOMINA,
    // perché la barra filtri ha un `role="status"` suo (il conteggio).
    expect(veloDiCaricamento()).toHaveTextContent(/caricamento/i)

    await waitFor(() => expect(contenitore).toHaveAttribute('aria-busy', 'false'), { timeout: 2000 })
  })

  it('nessuna chiave nuda a schermo: tutto risolve dal catalogo', async () => {
    await apriPrima()
    expect(screen.queryByText(/^adminAltro\./)).not.toBeInTheDocument()
  })

  it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
    const chiavi = [
      'inviabiliCandidatureTitolo', 'inviabiliCandidatureDesc', 'inviabiliCandidatureSediNota',
      'candIntro', 'candVuoto', 'candStatTotale', 'candMostrate', 'candMostraAltre',
      'candSede', 'candSedeSconosciuta', 'candApriCv', 'candApprova', 'candRifiuta',
      'candSoloDirezione', 'candRuoloInCorso', 'candConfermaApprovaSede', 'candConfermaApprovaFasce',
      'candConfermaApprovaCredenziali', 'candCredenziali', 'candCredenzialiAvviso',
      'candCredInviate', 'candCredNonInviate', 'candHoPresoNota',
      'candEsitoPresaInCarico', 'candSospesaTitolo', 'candSospesaTesto', 'candSospesaAzioniSpente',
      'candCvBloccato', 'candCvApriManuale',
    ]
    for (const k of chiavi) {
      expect(itAdminAltro, `it/adminAltro.json → ${k}`).toHaveProperty(k)
      expect(enAdminAltro, `en/adminAltro.json → ${k}`).toHaveProperty(k)
    }
    expect(itAdminModulistica).toHaveProperty('modTabCandidature')
    expect(enAdminModulistica).toHaveProperty('modTabCandidature')
  })

  it('adminAltro e adminModulistica: it ed en espongono lo stesso set di chiavi', () => {
    expect(Object.keys(itAdminAltro).sort()).toEqual(Object.keys(enAdminAltro).sort())
    expect(Object.keys(itAdminModulistica).sort()).toEqual(Object.keys(enAdminModulistica).sort())
  })
})

describe('CandidatureInsegnanti — una candidatura rivolta a PIÙ sedi', () => {
  /** Il dettaglio di una candidatura in valutazione a Giugliano E ad Aversa. */
  const DUE_SEDI = {
    ...DETTAGLIO,
    sedi: [
      { scuola_id: 'sc-giugliano', stato: 'pending' },
      { scuola_id: 'sc-aversa', stato: 'rifiutata' },
    ],
  }

  function serverConDueSedi(corpoPatch?: unknown) {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') return ok(corpoPatch ?? { success: true, esitoAccount: 'nessuno' })
      const u = String(url)
      if (u.includes('id=')) return ok({ data: DUE_SEDI })
      return ok({ data: ELENCO, total: ELENCO.length, limit: 50, offset: 0 })
    })
  }

  it('la scheda elenca TUTTE le sedi, con lo stato di ciascuna', async () => {
    // Anche quelle che non sono di chi guarda: se nessuna delle due segreterie
    // sa dell'altra, istruiscono la stessa pratica in parallelo e convocano la
    // persona due volte con parole diverse.
    serverConDueSedi()
    await apriPrima()
    // Il nome compare anche nel selettore in alto: si guarda DENTRO l'elenco
    // dei plessi della scheda, non in tutta la pagina.
    const elenco = screen.getByText(itAdminAltro.candSediMultiple).parentElement as HTMLElement
    expect(within(elenco).getByText('Kidville Giugliano')).toBeInTheDocument()
    expect(within(elenco).getByText('Kidville Aversa')).toBeInTheDocument()
    // Senza una sede scelta nel selettore in alto NON si evidenzia niente: con
    // due plessi e nessuna scelta, indicare «la tua» sarebbe inventarla.
    expect(screen.queryByTestId('sede-propria')).toBeNull()
  })

  it('la sede su cui si sta decidendo è distinguibile dalle altre', async () => {
    // Con tre plessi in elenco, «Approva» senza sapere quale riga si sta
    // chiudendo è il gesto da cui esce la decisione sbagliata.
    sedeCorrenteFinta = 'sc-aversa'
    serverConDueSedi()
    await apriPrima()
    const propria = await screen.findByTestId('sede-propria')
    expect(propria).toHaveTextContent('Kidville Aversa')
  })

  it('🔴 il PATCH DICHIARA la sede: senza, chi ha più sedi prende 400', async () => {
    sedeCorrenteFinta = 'sc-aversa'
    serverConDueSedi()
    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    // La conferma in due tempi resta: si preme, poi si conferma.
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => (c[1] as { method?: string })?.method === 'PATCH')
      expect(patch, 'nessun PATCH partito').toBeTruthy()
      const corpo = JSON.parse((patch![1] as { body: string }).body) as Record<string, unknown>
      expect(corpo.scuola_id).toBe('sc-aversa')
    })
  })

  it('con una sede sola la riga resta quella di prima: nessun elenco dove non serve', async () => {
    await apriPrima() // il dettaglio predefinito non ha `sedi`
    expect(screen.queryByTestId('sede-propria')).toBeNull()
  })

  it('🔴 badge e pulsanti seguono la PROPRIA sede, non l’aggregato', async () => {
    // Giugliano ha già approvato, Aversa sta ancora valutando: l'aggregato è
    // `pending`. Chi guarda da GIUGLIANO ha chiuso, e deve vederlo — altrimenti
    // ripreme «Approva», prende 409 «ricaricare la pagina», ricarica, e trova
    // tutto identico. Un ordine ineseguibile, dato all'infinito.
    sedeCorrenteFinta = 'sc-giugliano'
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') return ok({ success: true })
      const u = String(url)
      if (u.includes('id=')) {
        return ok({
          data: {
            ...DETTAGLIO,
            stato: 'pending', // l'aggregato
            sedi: [
              { scuola_id: 'sc-giugliano', stato: 'approvata' },
              { scuola_id: 'sc-aversa', stato: 'pending' },
            ],
            candidature_sedi: [{ scuola_id: 'sc-giugliano', stato: 'approvata', motivo_rifiuto: null }],
          },
        })
      }
      return ok({ data: ELENCO, total: ELENCO.length, limit: 50, offset: 0 })
    })
    await apriPrima()
    // Niente pulsanti: per questa sede la pratica è chiusa.
    expect(screen.queryByRole('button', { name: 'Approva' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rifiuta' })).toBeNull()
  })

  it('il MOTIVO mostrato è quello della propria sede, e arriva dall’embed filtrato', async () => {
    // `cand.motivo_rifiuto` non lo scrive più nessuno dal 2026-08-19: leggere
    // ancora quella colonna vorrebbe dire non mostrare mai più nessun motivo.
    sedeCorrenteFinta = 'sc-aversa'
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') return ok({ success: true })
      const u = String(url)
      if (u.includes('id=')) {
        return ok({
          data: {
            ...DETTAGLIO,
            stato: 'pending',
            motivo_rifiuto: null, // la colonna della candidatura è vuota, e resta vuota
            sedi: [
              { scuola_id: 'sc-giugliano', stato: 'pending' },
              { scuola_id: 'sc-aversa', stato: 'rifiutata' },
            ],
            candidature_sedi: [
              { scuola_id: 'sc-aversa', stato: 'rifiutata', motivo_rifiuto: 'Nota della mia sede.' },
            ],
          },
        })
      }
      return ok({ data: ELENCO, total: ELENCO.length, limit: 50, offset: 0 })
    })
    await apriPrima()
    expect(await screen.findByText('Nota della mia sede.')).toBeInTheDocument()
  })

  it('🔴 operatore su DUE sedi della stessa candidatura: può SCEGLIERE su quale decidere', async () => {
    // `sedeCorrente` è null appena l'operatore ha più di una sede attiva. Prima
    // di oggi il pannello non offriva nessuna via: il server rispondeva 400
    // `SEDE_DA_SPECIFICARE` e chi lavora su tutte e tre le sedi non poteva
    // chiudere niente, senza che una riga glielo spiegasse.
    sedeCorrenteFinta = null // due sedi attive nel selettore
    serverConDueSedi()
    await apriPrima()

    const scelte = await screen.findAllByRole('radio')
    expect(scelte.length, 'nessun modo di scegliere il plesso').toBe(2)
    expect(screen.getByText(itAdminAltro.candScegliSedeSuCuiDecidere)).toBeInTheDocument()

    fireEvent.click(scelte[1]) // Aversa
    await waitFor(() => expect(screen.getByTestId('sede-propria')).toHaveTextContent('Kidville Aversa'))

    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confermo' }))
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => (c[1] as { method?: string })?.method === 'PATCH')
      expect(JSON.parse((patch![1] as { body: string }).body).scuola_id).toBe('sc-aversa')
    })
  })

  it('con UNA sola sede in comune non si chiede niente: sarebbe una domanda con una risposta sola', async () => {
    sedeCorrenteFinta = null
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') return ok({ success: true })
      const u = String(url)
      if (u.includes('id=')) {
        return ok({
          data: {
            ...DETTAGLIO,
            // Rivolta anche a un plesso che NON è di chi guarda: l'intersezione
            // resta di uno, quindi non c'è niente da scegliere.
            sedi: [
              { scuola_id: 'sc-giugliano', stato: 'pending' },
              { scuola_id: 'sc-cesa', stato: 'pending' },
            ],
            candidature_sedi: [{ scuola_id: 'sc-giugliano', stato: 'pending' }],
          },
        })
      }
      return ok({ data: ELENCO, total: ELENCO.length, limit: 50, offset: 0 })
    })
    await apriPrima()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.getByTestId('sede-propria')).toHaveTextContent('Kidville Giugliano')
  })
})


describe('l’inoltro ai plessi delle copie mai partite', () => {
  /**
   * ─── PERCHÉ QUESTO PULSANTE HA BISOGNO DI GUARDIANI ─────────────────────────
   *
   * È l'unico modo, in tutta l'applicazione, per far partire decine di email con
   * dati personali di persone vere verso caselle vere. Non esiste un «annulla»
   * per un'email spedita: se questo pulsante si comporta male, il danno è già
   * fuori dal software quando qualcuno se ne accorge.
   *
   * Le tre cose che qui non possono rompersi: lo vede solo la Direzione, il primo
   * clic NON spedisce, e il resoconto NOMINA ciò che non è andato.
   */
  const APRI = 'Inoltra ai plessi le copie mai partite'

  /** Le chiamate POST all'inoltro, in ordine, col loro corpo. */
  function chiamateInoltro() {
    return fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/inoltro-arretrato'))
      .map((c) => JSON.parse(String((c[1] as { body?: string })?.body ?? '{}')))
  }

  function rispondiInoltro(corpo: unknown, status = 200) {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/inoltro-arretrato')
        ? ok(corpo, status)
        : ok(rispostaPredefinita(String(url))),
    )
  }

  it('la SEGRETERIA non lo vede nemmeno', async () => {
    // Il gate vero è nella route (`requireStaff(['admin','coordinator'])`): questo
    // serve a non far scoprire il divieto dopo il clic.
    ruoloCorrente = 'segreteria'
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    expect(screen.queryByText(APRI)).not.toBeInTheDocument()
  })

  it('la Direzione sì', async () => {
    ruoloCorrente = 'admin'
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText(APRI)).toBeInTheDocument())
  })

  it('IL PRIMO CLIC NON SPEDISCE: chiede `prova` e mostra il conteggio', async () => {
    // Se questo test cade perché il corpo non ha più `prova: true`, vuol dire che
    // il primo tocco è diventato un invio vero. È il difetto peggiore possibile
    // qui dentro, ed è per questo che l'asserzione è sul CORPO della richiesta e
    // non su ciò che appare a schermo.
    rispondiInoltro({ da_inviare: 7, senza_curriculum: 3, multi_sede: 1 })
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText(APRI)).toBeInTheDocument())
    fireEvent.click(screen.getByText(APRI))
    await waitFor(() => expect(screen.getByText('Sì, inoltra')).toBeInTheDocument())
    expect(chiamateInoltro()).toEqual([{ prova: true }])
    expect(screen.getByText(/7 candidature non sono mai arrivate/)).toBeInTheDocument()
  })

  it('il SECONDO clic spedisce, e solo allora', async () => {
    rispondiInoltro({ da_inviare: 2 })
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText(APRI)).toBeInTheDocument())
    fireEvent.click(screen.getByText(APRI))
    await waitFor(() => expect(screen.getByText('Sì, inoltra')).toBeInTheDocument())
    rispondiInoltro({ inviate: 2, fallite: 0, fermato: null })
    fireEvent.click(screen.getByText('Sì, inoltra'))
    await waitFor(() => expect(screen.getByText(/2 copie inviate/)).toBeInTheDocument())
    expect(chiamateInoltro()).toEqual([{ prova: true }, {}])
  })

  it('«Annulla» torna indietro senza aver spedito niente', async () => {
    rispondiInoltro({ da_inviare: 5 })
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText(APRI)).toBeInTheDocument())
    fireEvent.click(screen.getByText(APRI))
    await waitFor(() => expect(screen.getByText('Annulla')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Annulla'))
    await waitFor(() => expect(screen.getByText(APRI)).toBeInTheDocument())
    expect(chiamateInoltro()).toEqual([{ prova: true }])
  })

  it('niente da fare → lo dice, e non offre un pulsante che non serve', async () => {
    rispondiInoltro({ da_inviare: 0 })
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText(APRI)).toBeInTheDocument())
    fireEvent.click(screen.getByText(APRI))
    await waitFor(() => expect(screen.getByText(/Nessuna copia in sospeso/)).toBeInTheDocument())
    expect(screen.queryByText('Sì, inoltra')).not.toBeInTheDocument()
  })

  it('IL RESOCONTO NOMINA I FALLIMENTI: «inviate 3» che tace su 2 perse è un successo dichiarato su un guasto', async () => {
    rispondiInoltro({ da_inviare: 5 })
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText(APRI)).toBeInTheDocument())
    fireEvent.click(screen.getByText(APRI))
    await waitFor(() => expect(screen.getByText('Sì, inoltra')).toBeInTheDocument())
    rispondiInoltro({ inviate: 3, fallite: 2, fermato: null })
    fireEvent.click(screen.getByText('Sì, inoltra'))
    await waitFor(() => expect(screen.getByText(/2 non sono partite/)).toBeInTheDocument())
  })

  it('quota esaurita → dice che le restanti partiranno domani, invece di sembrare finito', async () => {
    rispondiInoltro({ da_inviare: 40 })
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText(APRI)).toBeInTheDocument())
    fireEvent.click(screen.getByText(APRI))
    await waitFor(() => expect(screen.getByText('Sì, inoltra')).toBeInTheDocument())
    rispondiInoltro({ inviate: 25, fallite: 0, fermato: 'quota-del-provider-esaurita' })
    fireEvent.click(screen.getByText('Sì, inoltra'))
    await waitFor(() => expect(screen.getByText(/esaurito la quota di oggi/)).toBeInTheDocument())
    expect(screen.getByText(/ripremendo il pulsante domani/)).toBeInTheDocument()
  })

  it('un rifiuto del server non lascia il pannello a metà', async () => {
    rispondiInoltro({ error: 'Non autorizzato.' }, 403)
    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText(APRI)).toBeInTheDocument())
    fireEvent.click(screen.getByText(APRI))
    await waitFor(() => expect(screen.getByText(APRI)).toBeInTheDocument())
    expect(screen.queryByText('Sì, inoltra')).not.toBeInTheDocument()
  })
})
