import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'
import itAdminModulistica from '../../messages/it/adminModulistica.json'
import enAdminModulistica from '../../messages/en/adminModulistica.json'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'
import { INSEGNANTE_FIELDS } from '@/lib/forms/insegnanti-template'

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
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [
      { id: 'sc-giugliano', nome: 'Kidville Giugliano' },
      { id: 'sc-aversa', nome: 'Kidville Aversa' },
    ],
    selezionate: [],
    effettive: reFetchKeyCorrente.split(','),
    sedeCorrente: null,
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
    gradi: ['infanzia', 'nido'],
    creata_il: '2026-08-05T09:00:00Z',
    email: 'recapito.da.non.mostrare@example.test',
    note: 'PRESENTAZIONE-DA-NON-MOSTRARE-IN-ELENCO',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    scuola_id: 'sc-giugliano',
    stato: 'rifiutata',
    nome: 'Bruno',
    cognome: 'Neri',
    gradi: [],
    creata_il: '2026-08-04T09:00:00Z',
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

import { CandidatureInsegnanti } from '@/components/features/admin/iscrizioni/CandidatureInsegnanti'

/** Apre il dettaglio della prima candidatura e aspetta che sia disegnato. */
async function apriPrima() {
  const utils = render(<CandidatureInsegnanti />)
  await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
  fireEvent.click(screen.getByText('Anna Bianchi'))
  await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
  return utils
}

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

  it('un GRADO fuori enum non sparisce: si legge grezzo in elenco e nel pannello', async () => {
    // La riga d'archivio che non sta nella tendina è proprio il caso per cui la
    // difesa esiste: nasconderla direbbe alla Direzione che quella candidatura
    // non ha fasce, mentre in tabella ce n'è una che il pannello Personale dovrà
    // sistemare. Senza questa fixture la riga che lo realizza si può cancellare
    // e il file resta verde (misurato: 21/21 col filtro tolto).
    const CON_FASCIA_IGNOTA = {
      ...ELENCO[0],
      gradi: ['sezione_primavera', 'infanzia'],
    }
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('id=')) return ok({ data: { ...DETTAGLIO, gradi: ['sezione_primavera', 'infanzia'] } })
      return ok({ data: [CON_FASCIA_IGNOTA], total: 1 })
    })

    render(<CandidatureInsegnanti />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    // In elenco: quella dell'enum tradotta, quella ignota grezza — e in coda,
    // perché l'ordine è quello del modulo pubblico.
    expect(screen.getByText('Infanzia (3-6)')).toBeInTheDocument()
    expect(screen.getByText('sezione_primavera')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Anna Bianchi'))
    await waitFor(() => expect(screen.getByText('Apri il curriculum')).toBeInTheDocument())
    expect(screen.getAllByText('sezione_primavera').length).toBe(2)
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
    fetchMock.mockImplementation((url: string, init?: { headers?: Record<string, string> }) => {
      const u = String(url)
      if (u.includes('id=')) return ok({ data: DETTAGLIO })
      if (init?.headers?.['x-sedi'] === 'sc-aversa') {
        return new Promise((risolvi) =>
          setTimeout(() => risolvi({ ok: true, status: 200, json: async () => ({ data: SOLO_AVERSA, total: 1 }) }), 100),
        )
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
    await attendi(50)
    expect(screen.getByRole('button', { name: 'Mostra altre candidature' })).toBeDisabled()

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
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('bruno@example.test')).not.toBeInTheDocument()

    await waitFor(() => expect(screen.getByText('anna@example.test')).toBeInTheDocument(), { timeout: 2000 })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('CandidatureInsegnanti — approvazione', () => {
  it('la conferma NOMINA sede, fasce e destinatario delle credenziali', async () => {
    await apriPrima()
    fireEvent.click(screen.getByRole('button', { name: 'Approva' }))

    const conferma = await screen.findByText(/Verrà creato un account docente per/)
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
  const BRUNO_IN_ATTESA = { ...ELENCO[1], stato: 'pending' }

  /**
   * La RIGA d'elenco di una persona, non la prima occorrenza del suo nome:
   * l'avviso dell'esito scartato nomina la persona, quindi `getAllByText(nome)[0]`
   * può pescare il testo dell'avviso — che non è cliccabile.
   */
  const rigaDi = (nome: string) =>
    screen.getAllByText(nome).map((n) => n.closest('button')).find(Boolean) as HTMLElement

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
        data: [approvata ? { ...ELENCO[0], stato: 'approvata' } : ELENCO[0], BRUNO_IN_ATTESA],
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
    const rigaAnna = rigaDi('Anna Bianchi')
    const rigaBruno = rigaDi('Bruno Neri')
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
    fireEvent.click(rigaDi('Anna Bianchi'))
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
    fireEvent.click(rigaDi('Anna Bianchi'))
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
    // Sono due dei tre campi da cui dipende la decisione, e si leggevano
    // `laurea_magistrale` e `tempo_pieno` — con l'underscore — mentre le fasce
    // accanto, nello stesso pannello, erano tradotte.
    const { container } = await apriPrima()

    expect(screen.getByText('Laurea magistrale')).toBeInTheDocument()
    expect(screen.getByText('Tempo pieno')).toBeInTheDocument()

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
    // E la disponibilità vuota resta un dato mancante, non un errore.
    expect(screen.getAllByText('Non indicato').length).toBeGreaterThan(0)
  })

  it('ogni valore dei DUE enum del modulo ha la sua etichetta in italiano e in inglese', () => {
    // Il perimetro si legge dal template, non si ricopia: una voce aggiunta lì e
    // dimenticata qui tornerebbe a schermo con l'underscore.
    const opzioni = (id: string) =>
      (INSEGNANTE_FIELDS.find((f) => f.id === id)?.options ?? []).map((o) => String(o.value))
    const attese: Record<string, string> = {
      diploma: 'candTitoloDiploma',
      magistrale: 'candTitoloMagistrale',
      laurea_triennale: 'candTitoloLaureaTriennale',
      laurea_magistrale: 'candTitoloLaureaMagistrale',
      formazione_primaria: 'candTitoloFormazionePrimaria',
      master: 'candTitoloMaster',
      altro: 'candTitoloAltro',
      tempo_pieno: 'candDispTempoPieno',
      part_time_mattina: 'candDispPartTimeMattina',
      part_time_pomeriggio: 'candDispPartTimePomeriggio',
      supplenze: 'candDispSupplenze',
      tirocinio: 'candDispTirocinio',
    }
    const valori = [...opzioni('titolo_studio'), ...opzioni('disponibilita')]
    expect(valori.length, 'il template non espone più le opzioni: il lock non guarda niente').toBe(12)
    for (const valore of valori) {
      const chiave = attese[valore]
      expect(chiave, `nessuna chiave i18n per «${valore}»`).toBeTruthy()
      expect(itAdminAltro, `it/adminAltro.json → ${chiave}`).toHaveProperty(chiave)
      expect(enAdminAltro, `en/adminAltro.json → ${chiave}`).toHaveProperty(chiave)
    }
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
    // …e il velo è annunciato, non è solo una rotella che gira.
    expect(screen.getByRole('status')).toHaveTextContent(/caricamento/i)

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
