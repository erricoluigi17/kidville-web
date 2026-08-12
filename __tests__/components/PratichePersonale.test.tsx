import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, fireEvent, createEvent, within, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'

expect.extend(toHaveNoViolations)

/**
 * IL COCKPIT DELLE PRATICHE DEL PERSONALE — collaudo del pannello di Segreteria.
 *
 * Le cose che questo file sorveglia, e perché ognuna è qui:
 *
 *  · L'ELENCO NON PORTA DATI PERSONALI. È la lezione di «Moduli ricevuti» (T11-F4):
 *    il payload completo di ogni domanda partiva verso il browser di ogni membro dello
 *    staff a ogni apertura della pagina. Qui il finto server rimanda APPOSTA codice
 *    fiscale ed email anche nell'elenco: se il componente li disegnasse, il test è
 *    rosso. La difesa non deve dipendere dalla generosità della proiezione del server.
 *
 *  · IL NOME È UN COLLEGAMENTO VERO. Una `<tr onClick>` non è raggiungibile da
 *    tastiera, non si apre in una scheda nuova e non si copia. E il collegamento deve
 *    FUNZIONARE: `?tab=personale&pratica=<id>` apre da solo quella pratica.
 *
 *  · IL TEMPO È CONGELATO. Il badge della scadenza dipende da «oggi»: con date fisse
 *    nel futuro questo file diventerebbe rosso DA SOLO il giorno in cui quella data
 *    arriva — è successo il 12/08 a `parent-attendance-elenco`, rosso su `main` senza
 *    che nessuno avesse toccato il codice.
 *
 *  · LE CREDENZIALI SI VEDONO UNA VOLTA. La password non è archiviata da nessuna
 *    parte: se il pannello la ridisegnasse dopo essere stato congedato, sarebbe perché
 *    qualcuno l'ha tenuta da qualche parte.
 *
 *  · DUE CLIC RAVVICINATI. Senza un gettone per richiesta vince la risposta che arriva
 *    per ULTIMA, non il clic fatto per ultimo: il pannello si rimpiazza da solo con la
 *    persona sbagliata mentre «Approva» agisce su un'altra. E l'esito scartato non
 *    sparisce: sul ramo «approva» quella password è l'unica copia che esista.
 *
 *  · MAI `alert()`. Gli errori si mostrano in pagina, in una regione `role="alert"`, e
 *    non fanno perdere quello che si stava scrivendo (il motivo del rifiuto è un testo
 *    libero: un `alert` che chiude tutto lo butterebbe via).
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

/** Il collegamento profondo è pilotabile: è l'unico modo di provare che funziona. */
let paramsCorrenti = new URLSearchParams('tab=personale')
vi.mock('next/navigation', () => ({
  useSearchParams: () => paramsCorrenti,
}))

let reFetchKeyCorrente = 'sc-alfa'
/**
 * IL CONTESTO DELLE SEDI È PILOTABILE, e serve a provare la quarta schermata dello
 * stato vuoto: con tre plessi reali e il selettore su uno, «Nessuna anagrafica
 * ricevuta» è un'affermazione FALSA su pratiche che esistono e che un'altra postazione
 * vede. Il caso predefinito resta quello di prima — UNA sede sola, cioè la segreteria
 * di un plesso — così nessun test esistente cambia significato.
 */
const SEDE_SOLA = [{ id: 'sc-alfa', nome: 'Kidville Alfa' }]
const TRE_SEDI = [
  { id: 'sc-alfa', nome: 'Kidville Alfa' },
  { id: 'sc-beta', nome: 'Kidville Beta' },
  { id: 'sc-gamma', nome: 'Kidville Gamma' },
]
let sediContesto: { id: string; nome: string }[] = SEDE_SOLA
let effettiveContesto: string[] = ['sc-alfa']
const tutteSpia = vi.fn()
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: sediContesto,
    selezionate: [],
    effettive: effettiveContesto,
    sedeCorrente: 'sc-alfa',
    reFetchKey: reFetchKeyCorrente,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: tutteSpia,
  }),
}))

const ID_ANNA = '11111111-1111-4111-8111-111111111111'
const ID_BRUNO = '22222222-2222-4222-8222-222222222222'

/**
 * L'elenco che il finto server manda porta ANCHE `email`, `fiscal_code` e
 * `documento_path`: la route vera non li proietta in lista, ma questo test non è lì
 * per collaudare la route — è lì per verificare che il PANNELLO non li disegni
 * comunque.
 */
const ELENCO = [
  {
    id: ID_ANNA,
    scuola_id: 'sc-alfa',
    stato: 'pending',
    nome: 'Anna',
    cognome: 'Bianchi',
    document_expiry: '2026-06-30',
    creata_il: '2026-08-11T09:00:00Z',
    email: 'recapito.da.non.mostrare@example.test',
    fiscal_code: 'BNCNNA90A41H501U',
    documento_path: 'documenti/aaaa/DA-NON-MOSTRARE.jpg',
  },
  {
    id: ID_BRUNO,
    scuola_id: 'sc-alfa',
    stato: 'rifiutata',
    nome: 'Bruno',
    cognome: 'Neri',
    document_expiry: '2031-01-01',
    creata_il: '2026-08-10T09:00:00Z',
  },
]

const DETTAGLIO_ANNA = {
  ...ELENCO[0],
  telefono: '+39 333 1234567',
  gender: 'F',
  birth_date: '1990-01-01',
  birth_place: 'Napoli',
  birth_province: 'NA',
  birth_nation: 'Italia',
  citizenship: 'Italiana',
  address: 'Via Esempio',
  residence_street_number: '12',
  residence_city: 'Giugliano in Campania',
  residence_province: 'NA',
  zip_code: '80014',
  document_type: 'CI',
  document_number: 'AB1234567',
  titolo_studio: 'laurea_magistrale',
  titolo_dettaglio: 'Scienze dell’educazione',
  gradi: ['infanzia', 'nido'],
  emergenza_nome: 'Giulia Rossi',
  emergenza_telefono: '+39 333 7654321',
  emergenza_relazione: 'sorella',
  consents_log: { versione_consensi: '2026-08-11', accettato_il: '2026-08-11T09:00:00Z', n_blocchi: 3 },
}

const fetchMock = vi.fn()

function ok(corpo: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => corpo })
}

/** Il CORPO di default: elenco, dettaglio su `?id=`, URL firmata su `?doc=`, sedi. */
function rispostaPredefinita(url: string) {
  const u = String(url)
  if (u.includes('/api/iscrizione/sedi')) {
    return {
      success: true,
      data: [
        { id: 'sc-alfa', nome: 'Kidville Alfa' },
        { id: 'sc-beta', nome: 'Kidville Beta' },
      ],
    }
  }
  if (u.includes('?doc=')) return { url: 'https://storage.example.test/firmata' }
  if (u.includes('id=')) return { data: DETTAGLIO_ANNA }
  return { data: ELENCO, total: ELENCO.length, limit: 50, offset: 0 }
}

function finestraFinta() {
  return { closed: false, opener: {}, close: vi.fn(), location: { replace: vi.fn() } }
}
let finestraAperta: ReturnType<typeof finestraFinta> | null = null

beforeEach(() => {
  vi.clearAllMocks()
  // ⚠️ TEMPO CONGELATO: il badge della scadenza si calcola su «oggi». Anna ha il
  // documento scaduto (30/06/2026) e Bruno no (01/01/2031): senza congelare, questo
  // file diventerebbe rosso da solo il 01/01/2031 — e prima ancora cambierebbe
  // significato ogni giorno.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-12T09:00:00Z'))
  paramsCorrenti = new URLSearchParams('tab=personale')
  reFetchKeyCorrente = 'sc-alfa'
  sediContesto = SEDE_SOLA
  effettiveContesto = ['sc-alfa']
  fetchMock.mockImplementation((url: string) => ok(rispostaPredefinita(url)))
  vi.stubGlobal('fetch', fetchMock)
  finestraAperta = null
  vi.stubGlobal('open', vi.fn(() => { finestraAperta = finestraFinta(); return finestraAperta }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

import { PratichePersonale } from '@/components/features/admin/personale/PratichePersonale'

/** Apre la pratica di Anna e aspetta che il pannello sia disegnato. */
async function apriAnna() {
  const utils = render(<PratichePersonale />)
  await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
  fireEvent.click(screen.getByText('Anna Bianchi'))
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  await waitFor(() => expect(screen.getByText('BNCNNA90A41H501U')).toBeInTheDocument())
  return utils
}

/** Una pausa vera: serve a far ATTERRARE una risposta lenta e guardare cosa fa. */
const attendi = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('PratichePersonale — elenco', () => {
  it('elenco VUOTO: lo dice, e non lascia la pagina bianca', async () => {
    fetchMock.mockImplementation(() => ok({ data: [], total: 0 }))
    render(<PratichePersonale />)
    await waitFor(() => expect(screen.getByText(itAdminAltro.pratVuoto)).toBeInTheDocument())
  })

  it('🔴 VUOTO col FILTRO di sede: non dice «non ne è arrivata nessuna», dice DOVE ha guardato', async () => {
    /**
     * «Nessuna anagrafica del personale ricevuta» è un'AFFERMAZIONE, ed è esattamente
     * l'affermazione che il selettore delle sedi rende falsa. Con tre plessi reali e il
     * selettore su uno, quella frase nega l'esistenza di pratiche che ci sono e che
     * un'altra postazione vede: la stessa classe di bugia che questo file evita già fra
     * «vuoto» e «non letto», con una leva in più e senza nemmeno un avviso rosso
     * accanto a smentirla.
     */
    sediContesto = TRE_SEDI
    effettiveContesto = ['sc-alfa']
    fetchMock.mockImplementation(() => ok({ data: [], total: 0 }))
    render(<PratichePersonale />)

    await waitFor(() => expect(screen.getByText(itAdminAltro.pratVuotoFiltrato)).toBeInTheDocument())
    expect(screen.queryByText(itAdminAltro.pratVuoto)).not.toBeInTheDocument()
    // NOMINA la sede guardata: un uuid non dice niente a nessuno.
    expect(screen.getByText('Kidville Alfa')).toBeInTheDocument()
    expect(screen.getByText(itAdminAltro.pratVuotoFiltratoNota)).toBeInTheDocument()

    // …e porta con sé il rimedio, invece di lasciare che ci si accorga del selettore.
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratVuotoGuardaTutte }))
    expect(tutteSpia).toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO: con TUTTE le sedi selezionate «vuoto» torna a essere un fatto', async () => {
    // Il ramo nuovo non deve mangiarsi quello vecchio: senza filtro l'affermazione è
    // vera, e va detta com'era.
    sediContesto = TRE_SEDI
    effettiveContesto = ['sc-alfa', 'sc-beta', 'sc-gamma']
    fetchMock.mockImplementation(() => ok({ data: [], total: 0 }))
    render(<PratichePersonale />)
    await waitFor(() => expect(screen.getByText(itAdminAltro.pratVuoto)).toBeInTheDocument())
    expect(screen.queryByText(itAdminAltro.pratVuotoFiltrato)).not.toBeInTheDocument()
  })

  it('lettura FALLITA ≠ elenco vuoto: avviso role="alert", ritenta, e mai un alert()', async () => {
    // Con la GET a 503 il ramo «zero righe» disegnerebbe lo stesso riquadro
    // dell'archivio vuoto: due frasi che si contraddicono nella stessa schermata, e
    // una è un'AFFERMAZIONE DI FATTO falsa su una casella che riceve invii veri.
    const alertBrowser = vi.fn()
    vi.stubGlobal('alert', alertBrowser)
    fetchMock.mockImplementation(() => ok({ error: 'non consultabili', codice: 'PRATICHE_OPERAZIONE_NON_RIUSCITA' }, 503))

    render(<PratichePersonale />)
    await screen.findByRole('alert')
    expect(screen.queryByText(itAdminAltro.pratVuoto)).not.toBeInTheDocument()
    expect(screen.getByText(itAdminAltro.pratElencoNonLetto)).toBeInTheDocument()
    expect(alertBrowser).not.toHaveBeenCalled()

    // …e il ritenta è un ritenta vero.
    fetchMock.mockImplementation((url: string) => ok(rispostaPredefinita(url)))
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratElencoRiprova }))
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
  })

  it('🔴 l’elenco NON disegna codice fiscale, email né il percorso della scansione', async () => {
    render(<PratichePersonale />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    expect(screen.queryByText(/recapito\.da\.non\.mostrare/)).not.toBeInTheDocument()
    expect(screen.queryByText('BNCNNA90A41H501U')).not.toBeInTheDocument()
    expect(screen.queryByText(/DA-NON-MOSTRARE/)).not.toBeInTheDocument()
  })

  it('il nome è un `<a href>` VERO, e la riga non ha un `onClick`', async () => {
    const { container } = render(<PratichePersonale />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())

    const link = screen.getByRole('link', { name: 'Anna Bianchi' })
    expect(link.getAttribute('href')).toBe(`?tab=personale&pratica=${ID_ANNA}`)

    // Nessuna riga cliccabile: non è raggiungibile da tastiera e non si annuncia.
    for (const tr of Array.from(container.querySelectorAll('tbody tr'))) {
      expect(tr.getAttribute('onclick')).toBeNull()
    }

    // Il clic semplice apre il pannello SENZA navigare…
    fireEvent.click(link)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })

  it('un clic con Cmd/Ctrl NON viene intercettato: lo lascia fare al browser', async () => {
    render(<PratichePersonale />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    const link = screen.getByRole('link', { name: 'Anna Bianchi' })

    // Si misura `defaultPrevented` e non «si è aperto il pannello»: è la sola
    // differenza fra «il browser apre una scheda nuova» e «non succede niente», e in
    // jsdom la navigazione vera non avviene comunque.
    const conCmd = createEvent.click(link, { metaKey: true })
    fireEvent(link, conCmd)
    expect(conCmd.defaultPrevented, 'il Cmd-clic è stato intercettato: niente scheda nuova').toBe(false)
    await attendi(20)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // …e il clic semplice invece SÌ: apre il pannello senza ricaricare la pagina.
    const semplice = createEvent.click(link)
    fireEvent(link, semplice)
    expect(semplice.defaultPrevented).toBe(true)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })

  it('il collegamento profondo `?pratica=` apre da solo quella pratica', async () => {
    // Un link che non funziona quando lo si apre in una scheda nuova è un link che
    // mente: è anche l'indirizzo che si incolla in chat per dire «guarda questa».
    paramsCorrenti = new URLSearchParams(`tab=personale&pratica=${ID_ANNA}`)
    render(<PratichePersonale />)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('BNCNNA90A41H501U')).toBeInTheDocument())
  })

  it('la SCADENZA si vede senza aprire niente, e «scaduto» è uno stato a sé', async () => {
    render(<PratichePersonale />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    // Anna: 30/06/2026 contro un oggi congelato al 12/08/2026.
    expect(screen.getByText(itAdminAltro.pratDocScaduto)).toBeInTheDocument()
    // Bruno: 01/01/2031, nessun badge — solo la data.
    expect(screen.getByText('01/01/2031')).toBeInTheDocument()
  })

  it('una scadenza ASSENTE non si legge come «in regola»', async () => {
    // Dire «valido» su una data che non si è potuta leggere è la bugia più comoda
    // della schermata: sono proprio le righe su cui l'allarme non suonerà mai.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('id=')) return ok({ data: DETTAGLIO_ANNA })
      return ok({ data: [{ ...ELENCO[0], document_expiry: null }], total: 1 })
    })
    render(<PratichePersonale />)
    await waitFor(() => expect(screen.getByText('Anna Bianchi')).toBeInTheDocument())
    expect(screen.getByText(itAdminAltro.pratDocIgnoto)).toBeInTheDocument()
  })
})

describe('PratichePersonale — pannello', () => {
  it('apre il dettaglio e mostra ciò che serve a DECIDERE (e solo lì)', async () => {
    await apriAnna()
    const pannello = screen.getByRole('dialog')
    expect(within(pannello).getByText('BNCNNA90A41H501U')).toBeInTheDocument()
    expect(within(pannello).getByText('recapito.da.non.mostrare@example.test')).toBeInTheDocument()
    expect(within(pannello).getByText(/Via Esempio 12/)).toBeInTheDocument()
    // Il contatto d'emergenza è di un TERZO: si mostra qui, mai in elenco.
    expect(within(pannello).getByText('Giulia Rossi')).toBeInTheDocument()
    // Le fasce passano dal catalogo, non dal valore di database.
    expect(within(pannello).getByText('Nido (0-3)')).toBeInTheDocument()
    expect(within(pannello).getByText('Infanzia (3-6)')).toBeInTheDocument()
    // …e così il titolo di studio: `laurea_magistrale` con l'underscore non si legge.
    expect(within(pannello).getByText('Laurea magistrale')).toBeInTheDocument()
    expect(within(pannello).queryByText('laurea_magistrale')).not.toBeInTheDocument()
  })

  it('la conferma NOMINA la sede e l’email: «Confermi?» da solo non dice niente', async () => {
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    const pannello = screen.getByRole('dialog')
    const conferma = within(pannello).getByText(itAdminAltro.pratConfermaApprovaTitolo).parentElement!
    expect(conferma).toHaveTextContent('Kidville Alfa')
    expect(conferma).toHaveTextContent('recapito.da.non.mostrare@example.test')
    expect(conferma).toHaveTextContent('Anna Bianchi')
  })

  it('🔴 la conferma NOMINA le fasce dichiarate, e dice la regola che le governa', async () => {
    // `utenti.gradi` NON è una preferenza d'interfaccia: `loadGradoContext` lo legge
    // lato server e `api/primaria/classi/route.ts:34` nega l'accesso alle classi su
    // `!ctx.gradi.includes('primaria')`. Le fasce decidono a quali BAMBINI si arriva, e
    // arrivano da una casella di spunta di un modulo pubblico e ANONIMO.
    //
    // Fino al 2026-08-12 questo riquadro parlava delle fasce SOLO quando erano vuote:
    // nel caso pieno l'approvazione le scriveva sull'account e nessuna schermata lo
    // nominava. Chi confermava non aveva modo di accorgersi che stava per applicare una
    // spunta che non aveva letto. Adesso le fasce si LEGGONO prima di premere — e
    // accanto c'è la regola, perché «primaria» da solo non dice se verrà applicata.
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    const conferma = within(screen.getByRole('dialog'))
      .getByText(itAdminAltro.pratConfermaApprovaTitolo).parentElement!

    expect(conferma).toHaveTextContent(itAdminAltro.pratConfermaApprovaFasceDichiarate)
    // I NOMI dal catalogo, non i valori di database: «infanzia» non è ciò che la
    // segreteria ha visto scritto sul modulo.
    expect(conferma).toHaveTextContent('Nido (0-3)')
    expect(conferma).toHaveTextContent('Infanzia (3-6)')
    expect(conferma).toHaveTextContent(itAdminAltro.pratConfermaApprovaFasceRegola)
    // …e la regola esiste in ENTRAMBI i cataloghi: in inglese, senza, la riga
    // ricadrebbe sull'italiano con l'aria di essere tradotta.
    expect(typeof enAdminAltro.pratConfermaApprovaFasceRegola).toBe('string')
    expect(typeof enAdminAltro.pratConfermaApprovaFasceDichiarate).toBe('string')

    // Il riquadro non annuncia una fascia MANCANTE quando ce ne sono: sarebbero due
    // frasi contraddittorie nello stesso riquadro.
    expect(conferma).not.toHaveTextContent(itAdminAltro.pratConfermaApprovaFasceMancanti)
  })

  it('APPROVA: le credenziali si vedono UNA volta, e congedandole non tornano', async () => {
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') {
        return ok({
          success: true, stato: 'approvata', accountCreato: true,
          credentials: { email: 'anna@example.test', password: 'PasswordMonouso1!' },
          warnings: [],
        })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratConferma }))

    await waitFor(() => expect(screen.getByText('PasswordMonouso1!')).toBeInTheDocument())
    expect(screen.getByText(itAdminAltro.pratEsitoApprovata)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratHoPresoNota }))
    await waitFor(() => expect(screen.queryByText('PasswordMonouso1!')).not.toBeInTheDocument())
  })

  it('APPROVA a metà (`in_approvazione`): il riquadro NON dice «registrata»', async () => {
    // `success: true` con `stato: 'in_approvazione'` significa «anagrafica scritta,
    // pratica non marcata»: intestare quel riquadro come un successo pieno mentre il
    // badge accanto dice «In approvazione» sono due frasi contraddittorie.
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') {
        return ok({
          success: true, stato: 'in_approvazione', accountCreato: true, credentials: null,
          warnings: [{ codice: 'chiusuraParzialeNonLegata', parametri: { colonne: 'utente_id' } }],
        })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratConferma }))

    await waitFor(() => expect(screen.getByText(itAdminAltro.pratEsitoPresaInCarico)).toBeInTheDocument())
    expect(screen.queryByText(itAdminAltro.pratEsitoApprovata)).not.toBeInTheDocument()
    // Gli avvisi del server stanno FUORI dal riquadro congedabile: sono la sola
    // traccia di ciò che è stato scritto a metà. E arrivano dal CATALOGO: il server
    // manda un codice, non una frase — altrimenti in interfaccia inglese uscirebbe
    // l'italiano scritto a mano nella route, proprio sui messaggi che dicono «NON
    // ripremere Approva».
    //
    // ⚠️ Il testo atteso è quello GREZZO, con `{colonne}` dentro: il mock globale di
    // `next-intl` (`test/setup.ts`) risolve la chiave sui messaggi italiani veri ma NON
    // interpola i parametri. Che il parametro parta davvero è provato dall'altra parte,
    // sulla route (`pratiche-personale-approva`, `parametri(body)`): qui si prova la
    // cosa che riguarda questo file, cioè che dal CODICE si arrivi al CATALOGO.
    const attesoAvviso = itAdminAltro.pratAvvisoChiusuraParzialeNonLegata
    expect(screen.getByText(attesoAvviso)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratHoPresoNota }))
    await waitFor(() => expect(screen.queryByText(itAdminAltro.pratEsitoPresaInCarico)).not.toBeInTheDocument())
    expect(screen.getByText(attesoAvviso)).toBeInTheDocument()
  })

  it('l’ERRORE dell’azione passa dal CATALOGO, non dalla prosa del server', async () => {
    // Finché il `codice` veniva buttato via, le traduzioni inglesi erano
    // irraggiungibili e a schermo usciva l'italiano scritto a mano nella route.
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') {
        return ok({ error: 'PROSA ITALIANA DEL SERVER', codice: 'PRATICA_GIA_EVASA' }, 409)
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratConferma }))

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(/già stata valutata/i)
    expect(screen.queryByText('PROSA ITALIANA DEL SERVER')).not.toBeInTheDocument()
    // E il codice esiste in ENTRAMBI i cataloghi: senza, in inglese ricadrebbe sulla
    // prosa italiana con l'aria di essere tradotto.
    expect(typeof enAdminAltro.pratEsitoApprovata).toBe('string')
  })

  it('🔴 ALTO: l’errore dell’azione è DENTRO il dialogo modale, e prende il fuoco', async () => {
    /**
     * MISURATO IL 2026-08-12, prima di questa correzione: dopo un 409 sulla PATCH,
     * `dialog.contains(getByRole('alert'))` era **false** — l'avviso stava nel
     * frammento di pagina, cioè sotto il pannello. In browser a 500 px,
     * `document.elementFromPoint` su quattro punti della sua larghezza restituiva
     * quattro volte un `div` del drawer: l'errore c'era e non si vedeva. E per uno
     * screen reader `aria-modal="true"` esclude tutto ciò che sta fuori dal dialogo,
     * quindi non veniva nemmeno annunciato.
     *
     * Il caso è il più frequente di tutti — «già evasa» — e su quel ramo la route non
     * manda `warnings`: nel pannello non compariva NIENTE, e «Confermo» tornava
     * attivo. Chi premeva, ripremeva.
     */
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') {
        return ok({ error: 'x', codice: 'PRATICA_GIA_EVASA' }, 409)
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    const conferma = screen.getByRole('button', { name: itAdminAltro.pratConferma })
    conferma.focus()
    fireEvent.click(conferma)

    const avviso = await screen.findByRole('alert')
    const dialogo = screen.getByRole('dialog')
    expect(dialogo.contains(avviso), 'l’errore dell’azione è fuori dal dialogo modale').toBe(true)
    // …e il fuoco ci finisce sopra: il pulsante è ancora a schermo e riattivato, quindi
    // senza spostarlo nulla direbbe a chi non guarda che qualcosa è andato storto.
    await waitFor(() => expect(document.activeElement).toBe(avviso))
    // L'anello del fuoco viene da `FUOCO_ESITO`, non da classi scritte a mano:
    // `focus-visible:` NON scatta su un `tabIndex={-1}` messo a fuoco da CODICE, e
    // `kv-fuoco-esito` è l'aggancio che in Alto Contrasto lo ribalta a giallo — senza,
    // nella stessa pagina il fuoco sarebbe giallo ovunque e verde qui.
    expect(avviso.className).toContain('kv-fuoco-esito')
    expect(avviso.className).toContain('focus:ring-2')
    // E resta UNA copia sola: due avvisi identici verrebbero annunciati due volte.
    expect(screen.getAllByRole('alert').filter((a) => a.textContent?.includes('già stata valutata'))).toHaveLength(1)
  })

  it('🔴 l’ESITO prende il fuoco ed è una live-region: la password monouso si annuncia', async () => {
    /**
     * MISURATO: dopo la conferma, `document.activeElement` era `BODY` — il pulsante
     * premuto viene SMONTATO col riquadro di conferma, e il fuoco cade. Nel dialogo non
     * esisteva NESSUNA live-region (`LIVE-REGIONS-NEL-DIALOGO` = 0), quindi la comparsa
     * del riquadro d'esito non veniva annunciata.
     *
     * È l'unico posto della schermata in cui perdere l'annuncio costa una
     * reimpostazione obbligata delle credenziali: la password «si vede una volta sola»
     * e non è archiviata da nessuna parte.
     */
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') {
        return ok({
          success: true, stato: 'approvata', accountCreato: true,
          credentials: { email: 'anna@example.test', password: 'PasswordMonouso1!' },
          warnings: [],
        })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    const conferma = screen.getByRole('button', { name: itAdminAltro.pratConferma })
    conferma.focus()
    fireEvent.click(conferma)

    await waitFor(() => expect(screen.getByText('PasswordMonouso1!')).toBeInTheDocument())
    const riquadro = screen.getByText(itAdminAltro.pratEsitoApprovata).closest('[role="status"]')
    expect(riquadro, 'il riquadro d’esito non è una live-region').toBeTruthy()
    expect(riquadro).toHaveTextContent('PasswordMonouso1!')
    // Il fuoco ci è finito sopra: chi naviga da tastiera riparte da QUI, non
    // dall'inizio del pannello.
    await waitFor(() => expect(document.activeElement).toBe(riquadro))
    expect((riquadro as HTMLElement).className).toContain('kv-fuoco-esito')
    // …ed è dentro il dialogo, come tutto il resto del gesto.
    expect(screen.getByRole('dialog').contains(riquadro as Node)).toBe(true)
  })

  it('un avviso con un CODICE SCONOSCIUTO non sparisce', async () => {
    /**
     * Una pagina in cache e una route appena rilasciata sono la condizione normale nei
     * minuti dopo un deploy. Gli avvisi di questa schermata sono quelli che dicono
     * «l'accesso È STATO CREATO lo stesso» e «NON ripremere Approva»: uno perso vale un
     * secondo account o una pratica premuta due volte.
     *
     * ⚠️ Sotto il mock globale di `next-intl` (`test/setup.ts`) `t.has()` risponde
     * SEMPRE `true`, quindi il ramo di ripiego con `pratAvvisoSconosciuto` non è
     * raggiungibile da qui: ciò che questa prova tiene fermo è la proprietà che conta —
     * l'avviso non viene INGHIOTTITO — mentre l'esistenza della frase di ripiego in
     * entrambe le lingue è verificata dal lock di parità dei cataloghi.
     */
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') {
        return ok({
          success: true, stato: 'approvata', accountCreato: false, credentials: null,
          warnings: [{ codice: 'codiceCheQuestaPaginaNonConosce' }],
        })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratConferma }))

    await waitFor(() => expect(screen.getByText(itAdminAltro.pratAvvisi)).toBeInTheDocument())
    const lista = screen.getByText(itAdminAltro.pratAvvisi).closest('div')!
    const voci = lista.querySelectorAll('li')
    expect(voci, 'l’avviso con codice sconosciuto è stato inghiottito').toHaveLength(1)
    expect((voci[0].textContent ?? '').trim().length, 'la voce è vuota').toBeGreaterThan(0)
    // Entrambi i cataloghi hanno la frase di ripiego: senza, in inglese uscirebbe una
    // chiave grezza proprio sul messaggio che invita a chiamare l'assistenza.
    expect(typeof itAdminAltro.pratAvvisoSconosciuto).toBe('string')
    expect(typeof enAdminAltro.pratAvvisoSconosciuto).toBe('string')
  })

  it('🔴 il riquadro di conferma DICE che quell’email ha già un account, e con quale ruolo', async () => {
    /**
     * `/anagrafica-personale` è pubblico e ANONIMO, e gli indirizzi delle maestre sono
     * pubblici: chiunque può inviare una pratica con l'email di una collega o della
     * Direzione. Il patch stretto della route impedisce la promozione — quella difesa
     * regge, ed è misurata sulla route — ma nome, cognome, cellulare e l'INTERO
     * fascicolo (codice fiscale, residenza, documento) di chi esiste già cambiano dopo
     * UN clic.
     *
     * MISURATO il 2026-08-12: una pratica anonima con l'email di un account `admin`
     * ⇒ 200, `nome/cognome/cellulare` da «Direttrice Reale / +39 333 0000001» a
     * «Impostore Anonimo / +39 111 1111111». Il server la risposta ce l'aveva già
     * (`risolviAccountEsistente` gira prima del claim) e la buttava in un campo di log:
     * la GET `?id=` non portava nessun indizio, quindi il riquadro non poteva dirlo.
     */
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('id=') && !u.includes('doc=')) {
        return ok({
          data: DETTAGLIO_ANNA,
          account: { esiste: true, ruolo: 'admin', sede_gestita: true, sede_nome: 'Kidville Alfa' },
        })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))

    expect(screen.getByText(itAdminAltro.pratConfermaAccountEsiste)).toBeInTheDocument()
    expect(screen.getByText(itAdminAltro.pratConfermaAccountEffetto)).toBeInTheDocument()
    // E si dice PRIMA del clic: il riquadro di conferma è ancora aperto.
    expect(screen.getByRole('button', { name: itAdminAltro.pratConferma })).toBeInTheDocument()
  })

  it('l’account è in un plesso NON gestito: lo si dice PRIMA, invece di far scoprire un 403', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('id=') && !u.includes('doc=')) {
        return ok({
          data: DETTAGLIO_ANNA,
          account: { esiste: true, ruolo: null, sede_gestita: false, sede_nome: null },
        })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    expect(screen.getByText(itAdminAltro.pratConfermaAccountAltraSede)).toBeInTheDocument()
  })

  it('la verifica dell’account NON è riuscita: si dice, invece di lasciar credere «non c’è»', async () => {
    // Tre stati e non due: «non si è potuto verificare» non è «non esiste». Una route
    // più vecchia della pagina non manda affatto la chiave `account`, ed è lo stesso
    // fatto: si dichiara.
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    expect(screen.getByText(itAdminAltro.pratConfermaAccountIgnoto)).toBeInTheDocument()
  })

  it('nessun account con quell’email: il riquadro lo dice, e non tace', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('id=') && !u.includes('doc=')) {
        return ok({ data: DETTAGLIO_ANNA, account: { esiste: false, ruolo: null, sede_gestita: null, sede_nome: null } })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    expect(screen.getByText(itAdminAltro.pratConfermaAccountNuovo)).toBeInTheDocument()
  })

  it('OGNI comando dichiara i 44 px: si usa dal telefono', async () => {
    /**
     * MISURATO nel browser col CSS vero, prima della correzione: «Ho preso nota»
     * 108,9×30 · «Apri la scansione» 179,3×34 · «Confermo» 118,7×36 · «Annulla» 82,4×38
     * · «Approva» 145,4×40 · «Rifiuta» e «Sposta di sede» 100,8/149,8×42 · i
     * collegamenti col nome in tabella 29,2–40,1 di larghezza. Nessuno arrivava a 44 su
     * nessuno dei due assi, e i due più piccoli erano quello che CREA un accesso e
     * quello che CONGEDA l'unica copia di una password monouso.
     *
     * Il gemello nato sullo stesso branch (`ScadenzeDocumenti.tsx`) lo dichiarava già:
     * la stessa funzionalità si comportava in due modi a due linguette di distanza.
     *
     * jsdom non fa layout, quindi qui si asserisce la DICHIARAZIONE (`min-h-[44px]`),
     * che è ciò che il foglio di stile applicherà. Le altezze vere si misurano in
     * browser, e sono nel commento qui sopra.
     */
    await apriAnna()

    // I tre comandi dell'elenco delle azioni, e il comando che apre la scansione.
    // (Il riquadro di conferma SOSTITUISCE i primi tre: vanno guardati prima.)
    for (const nome of [
      itAdminAltro.pratApprova, itAdminAltro.pratRifiuta, itAdminAltro.pratSposta,
      itAdminAltro.pratApriDocumento,
    ]) {
      const el = screen.getAllByRole('button', { name: new RegExp(nome, 'i') })[0]
      expect(el.className, `«${nome}» non dichiara 44 px`).toContain('min-h-[44px]')
    }

    // …e i due del riquadro di conferma, che sono i più piccoli di tutti e i più
    // pesanti: «Confermo» crea un accesso.
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    for (const nome of [itAdminAltro.pratConferma, itAdminAltro.pratAnnulla]) {
      const el = screen.getAllByRole('button', { name: new RegExp(nome, 'i') })[0]
      expect(el.className, `«${nome}» non dichiara 44 px`).toContain('min-h-[44px]')
    }
    // E i collegamenti col nome in tabella, che sono il bersaglio più stretto di tutti.
    const link = screen.getAllByRole('link', { name: 'Bruno Neri' })[0]
    expect(link.className).toContain('min-h-[44px]')
    expect(link.className).toContain('min-w-[44px]')
  })

  it('🔴 due clic ravvicinati: l’esito NON atterra sul pannello sbagliato, e non si perde', async () => {
    // La PATCH dura secondi veri (scrive un fascicolo e può creare un account): la
    // finestra in cui si apre un'altra pratica è enorme. Senza gettone, la risposta
    // scriverebbe la password di Anna sotto il nome di Bruno.
    let risolviPatch: ((v: unknown) => void) | null = null
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') {
        return new Promise((res) => {
          risolviPatch = () => res({
            ok: true, status: 200,
            json: async () => ({
              success: true, stato: 'approvata', accountCreato: true,
              credentials: { email: 'anna@example.test', password: 'PasswordDiAnna1!' },
              warnings: [],
            }),
          })
        })
      }
      if (String(url).includes(`id=${ID_BRUNO}`)) {
        return ok({ data: { ...DETTAGLIO_ANNA, id: ID_BRUNO, nome: 'Bruno', cognome: 'Neri' } })
      }
      return ok(rispostaPredefinita(url))
    })

    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratConferma }))

    // Mentre la PATCH viaggia, si chiude il pannello e si apre Bruno.
    //
    // LA CHIUSURA NON È UN PASSAGGIO DI COMODO. Il pannello è uno slide-over con lo
    // scrim su tutta la finestra: nel browser il clic sull'elenco lo intercetta lo
    // scrim, quindi la sequenza vera è «chiudi, poi apri l'altra» — `fireEvent.click`
    // sul collegamento coperto scavalcherebbe una cosa che l'utente non può
    // scavalcare. Ed è anche la sequenza più severa: chiudere AVANZA il gettone,
    // quindi la risposta della PATCH torna su un pannello che non c'è più.
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('link', { name: 'Bruno Neri' }))
    await waitFor(() => expect(screen.getAllByText('Bruno Neri').length).toBeGreaterThan(0))

    risolviPatch!(null)

    // L'esito viene riportato in un avviso che NOMINA Anna — password compresa,
    // perché è monouso e non è archiviata da nessuna parte…
    await waitFor(() => expect(screen.getByText('PasswordDiAnna1!')).toBeInTheDocument())
    const avvisi = screen.getAllByRole('alert')
    const scartato = avvisi.find((a) => a.textContent?.includes('PasswordDiAnna1!'))!
    expect(scartato).toHaveTextContent('Anna Bianchi')

    /**
     * ⚠️ …ED È DENTRO IL DIALOGO, non fuori. Questa riga ha cambiato verso il
     * 2026-08-12: prima diceva `queryByText(...).not.toBeInTheDocument()` dentro il
     * `role="dialog"`, cioè pretendeva che l'unica copia esistente di una password
     * monouso stesse FUORI dal pannello — dove il pannello la copre (misurato in
     * browser: `elementFromPoint` restituisce un `div` del drawer su quattro punti su
     * quattro) e dove `aria-modal="true"` la esclude da ciò che uno screen reader può
     * raggiungere. Il pannello di Bruno è aperto per costruzione — è il gesto che
     * genera lo scarto — quindi «fuori dal pannello» qui vale «invisibile».
     *
     * Ciò che deve restare vero è l'altra cosa, e si asserisce qui sotto: l'avviso
     * NOMINA Anna, e il riquadro d'ESITO del pannello (quello che parlerebbe di Bruno)
     * NON contiene la password di Anna.
     */
    const dialogo = screen.getByRole('dialog')
    expect(dialogo.contains(scartato), 'l’unica copia della password è fuori dal dialogo modale').toBe(true)
    expect(within(dialogo).getByText('PasswordDiAnna1!')).toBeInTheDocument()
    expect(
      within(dialogo).queryByText(itAdminAltro.pratEsitoApprovata),
      'il riquadro d’esito del pannello di Bruno mostra l’approvazione di Anna',
    ).not.toBeInTheDocument()

    // Se ne va solo con un gesto: aprire un'altra pratica non è una presa d'atto.
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // A pannello chiuso l'avviso resta, e si legge in pagina: una copia sola, montata
    // dove è raggiungibile.
    expect(screen.getByText('PasswordDiAnna1!')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Anna Bianchi' }))
    await attendi(20)
    expect(screen.getByText('PasswordDiAnna1!')).toBeInTheDocument()
    // E il congedo si dà anche a pannello APERTO, perché adesso il comando sta dentro
    // il dialogo: prima andava premuto «attraverso» lo scrim, cosa che solo un test
    // può fare.
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratEsitoScartatoCongeda }))
    await waitFor(() => expect(screen.queryByText('PasswordDiAnna1!')).not.toBeInTheDocument())
  })

  it('SPOSTA DI SEDE: il menù si popola dall’elenco PUBBLICO, non dalle sedi della postazione', async () => {
    // È il punto: la segreteria che deve spostare è quella di UN plesso solo, e la
    // destinazione è un plesso che NON gestisce. Con l'elenco ristretto al contesto,
    // l'unica persona capace di rimediare sarebbe l'unica che non ne ha bisogno.
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratSposta }))
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument())
    await waitFor(() =>
      expect(within(screen.getByRole('combobox')).getByText('Kidville Beta')).toBeInTheDocument(),
    )
    // La sede in cui la pratica già sta non è una destinazione.
    expect(within(screen.getByRole('combobox')).queryByText('Kidville Alfa')).not.toBeInTheDocument()
  })

  it('SPOSTA DI SEDE: senza destinazione il pulsante resta spento', async () => {
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratSposta }))
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument())
    const conferma = screen.getByRole('button', { name: itAdminAltro.pratConferma })
    expect(conferma).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sc-beta' } })
    expect(screen.getByRole('button', { name: itAdminAltro.pratConferma })).not.toBeDisabled()
  })

  it('la SCANSIONE di una pratica APPROVATA non è persa: si dice dov’è andata', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('id=')) {
        return ok({ data: { ...DETTAGLIO_ANNA, stato: 'approvata', documento_path: null } })
      }
      return ok({ data: [{ ...ELENCO[0], stato: 'approvata' }], total: 1 })
    })
    await apriAnna()
    expect(screen.getByText(itAdminAltro.pratDocumentoAlFascicolo)).toBeInTheDocument()
    expect(screen.queryByText(itAdminAltro.pratNessunDocumento)).not.toBeInTheDocument()
  })

  it('la finestra della scansione bloccata dal browser NON è un pulsante muto', async () => {
    vi.stubGlobal('open', vi.fn(() => null))
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: /Apri la scansione/ }))
    await waitFor(() => expect(screen.getByText(itAdminAltro.pratDocApriManuale)).toBeInTheDocument())
    expect(screen.getByRole('link', { name: itAdminAltro.pratDocApriManuale }).getAttribute('href'))
      .toBe('https://storage.example.test/firmata')
  })

  it('🔴 APPROVATA: il pulsante della scansione SPARISCE, invece di rispondere 403', async () => {
    /**
     * All'approvazione la pratica RILASCIA `documento_path`: da lì in poi la scansione
     * è del fascicolo, e la riga della pratica non la nomina più (`route.ts`, punto 9 —
     * «un oggetto, un proprietario»). Il pannello però si aggiornava SOLO nello stato e
     * si teneva il percorso vecchio, quindi continuava a offrire «Apri la scansione»
     * invece della frase «è passata al fascicolo», che pure esiste ed è scritta apposta
     * per questo caso.
     *
     * Due danni, e nessuno dei due è estetico:
     *  · `assertDocumentoInScope` risolve il percorso sulle sole sedi attive e non trova
     *    più nessuna riga → 403. Chi ha appena approvato e vuole ricontrollare il
     *    documento che ha appena archiviato riceve un diniego di SEDE su una pratica
     *    SUA: sembra un problema di permessi che non c'è, cioè esattamente il «guasto
     *    travestito da diniego» che quella funzione dichiara di voler evitare;
     *  · ogni clic scrive un `multi_sede/warn` con esito `documento-non-risolto`. Quello
     *    è il registro di sorveglianza degli accessi alle scansioni dei documenti
     *    d'identità: riempirlo di falsi positivi generati dal percorso NORMALE è il modo
     *    in cui un allarme si impara a ignorare.
     */
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') {
        return ok({
          success: true, stato: 'approvata', accountCreato: false,
          documentoRilasciato: true, credentials: null, warnings: [],
        })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    // Prima: la pratica è `pending` e la scansione è ancora sua.
    expect(screen.getByRole('button', { name: /Apri la scansione/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratConferma }))
    await waitFor(() => expect(screen.getByText(itAdminAltro.pratEsitoApprovata)).toBeInTheDocument())

    expect(
      screen.queryByRole('button', { name: /Apri la scansione/ }),
      'il pulsante sopravvive all’approvazione: da adesso risponde 403 e sporca `multi_sede`',
    ).not.toBeInTheDocument()
    expect(screen.getByText(itAdminAltro.pratDocumentoAlFascicolo)).toBeInTheDocument()
    // …e non si scrive «nessun documento»: la scansione non è mancante, è altrove.
    expect(screen.queryByText(itAdminAltro.pratNessunDocumento)).not.toBeInTheDocument()
  })

  it('…ma se il server dice che NON l’ha rilasciata, il pulsante RESTA', async () => {
    // Il degrado su colonna assente (DB della CI non migrato) toglie `documento_path`
    // dall'upsert del fascicolo, e allora la pratica il percorso se lo TIENE: lì il
    // pulsante funziona ancora, e nasconderlo nasconderebbe l'unica copia raggiungibile
    // del documento. La sorgente è il server, non l'inferenza «stato = approvata».
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') {
        return ok({
          success: true, stato: 'approvata', accountCreato: false,
          documentoRilasciato: false, credentials: null,
          warnings: [{ codice: 'fascicoloParziale', parametri: { colonne: 'documento_path' } }],
        })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratConferma }))
    await waitFor(() => expect(screen.getByText(itAdminAltro.pratEsitoApprovata)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Apri la scansione/ })).toBeInTheDocument()
  })

  it('🔴 l’email è quella di un GENITORE: il riquadro dice che verrà RIFIUTATA, non «riscritta»', async () => {
    /**
     * In un nido è la collisione PIÙ probabile di tutte: una maestra è spessissimo
     * anche la mamma di un bambino iscritto, e sul modulo pubblico scrive l'email che
     * usa già.
     *
     * Il server su quel caso si ferma: `staff-identity.ts` → `riusaIdentitaEsistente`
     * tiene chiusa la porta del genitore ANCHE col riuso acceso (`email_gia_genitore`,
     * 409, nessuna scrittura). Il riquadro invece cadeva nell'ultimo ramo e prometteva
     * «nome, cognome, cellulare e l'intera anagrafica verranno RISCRITTI»: chi operava
     * leggeva una riscrittura, premeva, e riceveva un 409 che sembrava un guasto. È il
     * gemello esatto del caso già chiuso per «l'account è in un plesso non gestito».
     *
     * `'Genitore'` con la maiuscola non è un capriccio: `utenti.ruolo` non ha né `CHECK`
     * né enum, il server decide sul valore NORMALIZZATO, e un riquadro che normalizza in
     * un altro modo tornerebbe a prevedere l'esito sbagliato.
     */
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('id=') && !u.includes('doc=')) {
        return ok({
          data: DETTAGLIO_ANNA,
          account: { esiste: true, ruolo: 'Genitore', sede_gestita: true, sede_nome: 'Kidville Alfa' },
        })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))

    expect(screen.getByText(itAdminAltro.pratConfermaAccountGenitore)).toBeInTheDocument()
    expect(
      screen.queryByText(itAdminAltro.pratConfermaAccountEffetto),
      'il riquadro promette ancora una riscrittura che il server rifiuterà',
    ).not.toBeInTheDocument()
    // La frase esiste in ENTRAMBI i cataloghi: in interfaccia inglese uscirebbe una
    // chiave grezza proprio sulla previsione che evita un 409 preso per un guasto.
    expect(typeof itAdminAltro.pratConfermaAccountGenitore).toBe('string')
    expect(typeof enAdminAltro.pratConfermaAccountGenitore).toBe('string')
  })

  it('🔴 un’email istituzionale NORMALE non fa scorrere il dialogo di lato', async () => {
    /**
     * Email, codice fiscale e residenza sono stringhe SENZA SPAZI: per il browser sono
     * una parola sola, e una parola sola che non entra non va a capo — sporge. Il corpo
     * del `Drawer` è `overflow-y-auto` (`cockpit.tsx:468`), e per CSS Overflow §3 un
     * asse `auto` rende l'altro asse calcolato `auto` a sua volta: non si ottiene un
     * ritaglio, si ottiene una BARRA DI SCORRIMENTO LATERALE dentro il modale — cioè il
     * criterio «`scrollWidth === clientWidth` su ogni schermata» violato proprio nel
     * dialogo dove si preme «Confermo», sul gesto irreversibile. E lo scorrimento
     * laterale può spingere fuori vista la password monouso, che non è archiviata da
     * nessuna parte: per riaverla serve una reimpostazione.
     *
     * ── MISURATO IN CHROME COL CSS E I FONT VERI, 2026-08-12 ─────────────────────
     * A 360 px il pannello è largo 331,2 px (`Drawer` è `max-w-[92%]`) e la scatola di
     * contenuto 283,2 px (`px-6`). Con `coordinamento.didattico@kidvillegiugliano.it`
     * (44 caratteri), `scrollWidth − clientWidth` del corpo del dialogo:
     *   · riquadro di conferma  16 px → 0   (scatola 251,2 px, per il `p-4` del riquadro)
     *   · riga delle credenziali 34 px → 0  (scatola 261,2 px: l'icona e il `gap` ne
     *     tolgono 22, ed è per questo che è il punto che cede per primo)
     *   · voce del dettaglio      0 px      (scatola 283,2 px: cede da ~46 caratteri)
     *
     * ⚠️ E la soglia è più alta di quanto sembri: `segreteria.giugliano@kidville.it`
     * (32 caratteri, 193,7 px) NON traboccava da nessuna parte. Si comincia a sforare
     * intorno ai 37-40 caratteri. Su `Voce` `break-words` è quindi una difesa
     * PREVENTIVA, e resta perché la stessa voce disegna anche residenza e domicilio,
     * che sono più lunghi di un'email.
     *
     * jsdom non fa layout: qui si asserisce la DICHIARAZIONE, che è ciò che il foglio di
     * stile applicherà. E la coppia `min-w-0 break-words` sulle credenziali non è una
     * ridondanza: quello `span` è una voce di un contenitore FLEX, la sua larghezza
     * minima automatica vale il min-content — l'email intera come parola sola — e
     * `overflow-wrap: break-word` per specifica NON riduce il min-content. Senza
     * `min-w-0` la voce resta larga e sporge lo stesso.
     */
    const EMAIL_LUNGA = 'segreteria.giugliano@kidville.example.test'
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PATCH') {
        return ok({
          success: true, stato: 'approvata', accountCreato: true,
          documentoRilasciato: true,
          credentials: { email: EMAIL_LUNGA, password: 'PasswordMonouso1!' },
          warnings: [],
        })
      }
      if (String(url).includes('id=') && !String(url).includes('doc=')) {
        return ok({ data: { ...DETTAGLIO_ANNA, email: EMAIL_LUNGA } })
      }
      return ok(rispostaPredefinita(url))
    })
    await apriAnna()

    // 1. La voce del dettaglio (che è anche quella del codice fiscale e della residenza).
    const voce = screen.getByText(EMAIL_LUNGA)
    expect(voce.className, 'il valore di `Voce` non può andare a capo').toContain('break-words')

    // 2. Il riquadro di conferma, cioè il posto dove si preme «Confermo».
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    const nelRiquadro = screen.getAllByText(EMAIL_LUNGA).find((el) => el.tagName === 'STRONG')
    expect(nelRiquadro, 'l’email non compare nel riquadro di conferma').toBeTruthy()
    expect(nelRiquadro!.closest('p')!.className).toContain('break-words')

    // 3. Le credenziali: l'unica copia esistente di una password monouso.
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratConferma }))
    await waitFor(() => expect(screen.getByText('PasswordMonouso1!')).toBeInTheDocument())
    const riga = screen.getByText('PasswordMonouso1!').closest('span')!
    expect(riga.className).toContain('break-words')
    expect(riga.className, 'è una voce flex: senza `min-w-0` non scende sotto il min-content').toContain('min-w-0')
  })

  it('la schermata non ha violazioni di accessibilità note', async () => {
    const { container } = await apriAnna()
    expect(await axe(container)).toHaveNoViolations()
  })
})

/**
 * LA PRATICA APPESA — `in_approvazione` è uno stato REALE, e deve avere un'uscita.
 *
 * ─── IL DIFETTO ─────────────────────────────────────────────────────────────────
 * Fino al 2026-08-12 da `in_approvazione` i tre comandi erano spenti tutti e tre —
 * misurato in jsdom, 3 su 3 — mentre l'unica azione che la route accetta da lì è
 * proprio «Rifiuta» (`da: ['pending','in_approvazione']`, provato su
 * `pratiche-personale-rifiuta.test.ts`). Da quel punto la pratica restava ferma PER
 * SEMPRE: il modulo pubblico non ne crea una seconda, perché l'indice unico
 * `(lower(email)) where stato in ('pending','in_approvazione')` la considera VIVA e
 * risponde 201 come al primo invio — quindi né la maestra né la Segreteria avevano un
 * rimedio. Restava la cancellazione a 90 giorni della conservazione, con dentro un
 * codice fiscale e la scansione di un documento d'identità.
 *
 * E lo stato è raggiungibile: sono i due rami d'errore che la route stessa logga a
 * `error` — `rimettiPending` fallita e `chiusuraRiuscita` falsa.
 *
 * ─── COSA SORVEGLIA QUESTO BLOCCO ───────────────────────────────────────────────
 * Che l'uscita ci sia (Rifiuta acceso), che le altre due restino chiuse (la route le
 * respinge, e un 409 dopo il clic sembra un guasto), e che il riquadro dica PRIMA che
 * cosa lascia dietro di sé: rifiutare non cancella l'anagrafica né l'accesso.
 */
describe('PratichePersonale — la pratica APPESA (`in_approvazione`)', () => {
  /** Elenco, dettaglio e PATCH con Anna ferma nello stato che non aveva uscite. */
  function reteAppesa() {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      const u = String(url)
      if (init?.method === 'PATCH') return ok({ success: true, id: ID_ANNA, stato: 'rifiutata', warnings: [] })
      if (u.includes('/api/iscrizione/sedi')) return ok(rispostaPredefinita(u))
      if (u.includes('id=') && !u.includes('doc=')) {
        return ok({ data: { ...DETTAGLIO_ANNA, stato: 'in_approvazione' } })
      }
      return ok({ data: [{ ...ELENCO[0], stato: 'in_approvazione' }], total: 1 })
    })
  }

  it('🔴 ALTO: «Rifiuta» è ACCESO — è l’unica uscita, e senza la pratica resta ferma per sempre', async () => {
    reteAppesa()
    await apriAnna()

    expect(screen.getByRole('button', { name: itAdminAltro.pratApprova })).toBeDisabled()
    expect(screen.getByRole('button', { name: itAdminAltro.pratSposta })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: itAdminAltro.pratRifiuta }),
      'Rifiuta spento: la pratica non ha più nessuna uscita, e il server invece l’accetta',
    ).not.toBeDisabled()

    // Il motivo scritto a schermo non promette più un «finché» che nessuna azione può
    // far scadere: nomina i due comandi spenti e dice che cosa resta.
    expect(screen.getByText(itAdminAltro.pratSospesaAzioniSpente)).toBeInTheDocument()
  })

  it('🔴 il rifiuto di una pratica appesa DICE che cosa lascia dietro di sé, e arriva al server', async () => {
    reteAppesa()
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratRifiuta }))

    // Rifiutare da qui NON è rifiutare una pratica in attesa: l'anagrafica può essere
    // già stata scritta e l'accesso già creato, e restano dove sono.
    expect(screen.getByText(itAdminAltro.pratConfermaRifiutaSospesa)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratConferma }))
    await waitFor(() => expect(screen.getByText(itAdminAltro.pratEsitoRifiutata)).toBeInTheDocument())

    const patch = fetchMock.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH')
    expect(patch, 'nessuna PATCH è partita: il rifiuto si è fermato nell’interfaccia').toBeTruthy()
    expect(JSON.parse(String((patch![1] as { body: string }).body))).toMatchObject({
      id: ID_ANNA,
      action: 'rifiuta',
    })
  })

  it('CONTROLLO POSITIVO: su una pratica IN ATTESA nessuno dei tre comandi è spento', async () => {
    // Senza, il blocco qui sopra sarebbe verde anche se i pulsanti fossero spenti
    // dappertutto o accesi dappertutto.
    await apriAnna()
    for (const nome of [itAdminAltro.pratApprova, itAdminAltro.pratRifiuta, itAdminAltro.pratSposta]) {
      expect(screen.getByRole('button', { name: nome })).not.toBeDisabled()
    }
    expect(screen.queryByText(itAdminAltro.pratSospesaAzioniSpente)).not.toBeInTheDocument()
  })
})

/**
 * IL FUOCO E L'ANNUNCIO DEL RIQUADRO DI CONFERMA.
 *
 * Premendo «Approva», «Rifiuta», «Sposta» o «Annulla» il comando che aveva il fuoco
 * viene SMONTATO e `document.activeElement` diventa `<body>` — misurato, tre
 * transizioni su tre. È lo stesso difetto che questo file chiude a mano per il riquadro
 * d'ESITO (`rifEsito`), lasciato aperto sul passo PRIMA: quello che porta l'avviso
 * «questa email HA GIÀ un accesso, ruolo Direzione, e l'approvazione verrà rifiutata».
 * Chi usa uno screen reader premeva «Approva» e non sentiva niente, e il Tab successivo
 * lo riportava in cima al pannello per via del ciclo del `Drawer`.
 */
describe('PratichePersonale — il fuoco del riquadro di conferma', () => {
  /** Il dettaglio con un account che ESISTE: è il caso in cui l'avviso ha un contenuto. */
  function reteConAccount(account: Record<string, unknown>) {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('id=') && !u.includes('doc=')) return ok({ data: DETTAGLIO_ANNA, account })
      return ok(rispostaPredefinita(u))
    })
  }

  it('🔴 «Approva» porta il fuoco SUL riquadro, che si annuncia col titolo e con l’avviso', async () => {
    reteConAccount({ esiste: true, ruolo: 'admin', sede_gestita: true, sede_nome: 'Kidville Alfa' })
    await apriAnna()

    const approva = screen.getByRole('button', { name: itAdminAltro.pratApprova })
    approva.focus()
    fireEvent.click(approva)

    const gruppo = screen.getByRole('group', { name: itAdminAltro.pratConfermaApprovaTitolo })
    expect(document.activeElement, 'il fuoco è caduto su <body>').toBe(gruppo)

    // …e ciò che il gruppo DESCRIVE contiene l'avviso di sicurezza: è così che arriva a
    // chi non guarda lo schermo, invece di restare una frase disegnata.
    const descrizione = (gruppo.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
    expect(descrizione).toContain(itAdminAltro.pratConfermaAccountEsiste)
    expect(descrizione).toContain(itAdminAltro.pratConfermaApprovaTesto)
  })

  it('🔴 «Annulla» RESTITUISCE il fuoco al comando di partenza, non a <body>', async () => {
    await apriAnna()
    const approva = screen.getByRole('button', { name: itAdminAltro.pratApprova })
    approva.focus()
    fireEvent.click(approva)
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratAnnulla }))

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: itAdminAltro.pratApprova })),
    )
  })

  it('vale per tutti e tre i riquadri: Rifiuta e Sposta di sede si annunciano allo stesso modo', async () => {
    await apriAnna()

    const rifiuta = screen.getByRole('button', { name: itAdminAltro.pratRifiuta })
    rifiuta.focus()
    fireEvent.click(rifiuta)
    expect(document.activeElement).toBe(screen.getByRole('group', { name: itAdminAltro.pratConfermaRifiutaTitolo }))
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratAnnulla }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: itAdminAltro.pratRifiuta })),
    )

    const sposta = screen.getByRole('button', { name: itAdminAltro.pratSposta })
    sposta.focus()
    fireEvent.click(sposta)
    const gruppo = screen.getByRole('group', { name: itAdminAltro.pratSpostaTitolo })
    expect(document.activeElement).toBe(gruppo)
    // La descrizione dello spostamento era già scritta e già identificata: si riusa,
    // invece di ribattere la frase in un attributo.
    expect(document.getElementById((gruppo.getAttribute('aria-describedby') ?? '').split(' ')[0])?.textContent)
      .toBe(itAdminAltro.pratSpostaTesto)
  })

  it('il riquadro di conferma APERTO non ha violazioni di accessibilità note', async () => {
    // Il ricovero del fuoco è un contenitore non interattivo con `tabIndex={-1}`, un
    // ruolo e due riferimenti: se uno degli `id` non esistesse — è il modo tipico in cui
    // questa costruzione si rompe — `aria-describedby` punterebbe nel vuoto.
    const { container } = await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    expect(await axe(container)).toHaveNoViolations()
  })

  it('l’ESITO vince sul ritorno del fuoco: la password monouso non se lo fa strappare', async () => {
    // Ad approvazione riuscita i comandi non esistono più e il fuoco è del riquadro
    // d'esito, che contiene la sola copia esistente di una password. Il ritorno del
    // fuoco «all'Annulla» non deve rincorrerlo.
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return ok({
          success: true, stato: 'approvata', accountCreato: true,
          credentials: { email: 'a@example.test', password: 'PasswordMonouso1!' },
        })
      }
      return ok(rispostaPredefinita(String(url)))
    })
    await apriAnna()
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratConferma }))

    await waitFor(() => expect(screen.getByText('PasswordMonouso1!')).toBeInTheDocument())
    // `waitFor` e non un `expect` secco: l'esito atterra in una promise, cioè FUORI da
    // `act`, e il fuoco lo prende l'effetto del commit successivo.
    const riquadro = screen.getByText(itAdminAltro.pratEsitoApprovata).closest('[role="status"]')
    await waitFor(() => expect(document.activeElement).toBe(riquadro))
  })
})

/**
 * «CONFERMO» NON RESTA ACCESO SU UN'APPROVAZIONE CHE IL PANNELLO DÀ GIÀ PER PERSA.
 *
 * Il riquadro scriveva «l'approvazione verrà rifiutata e non verrà scritto niente» e
 * lasciava «Confermo» acceso sotto: due frasi opposte nello stesso riquadro, e quella
 * che si poteva premere era la sbagliata. Ed è la regola che questo file DICHIARA nella
 * sua testata come motivo per cui il gemello spegne i comandi — scoprire un 403 dopo il
 * clic fa sembrare un guasto un divieto legittimo.
 *
 * Sul ramo «altra sede» non è nemmeno un clic sprecato: il gesto CLAIMA la pratica
 * (`pending → in_approvazione`) e la riporta indietro con `rimettiPending`; se quel
 * ripristino fallisce si ottiene la pratica appesa del blocco qui sopra. L'unico clic
 * che l'interfaccia sapeva già che sarebbe fallito era anche l'unico che poteva
 * bloccare la pratica.
 */
describe('PratichePersonale — «Confermo» spento su un’approvazione già persa', () => {
  function apriConAccount(account: Record<string, unknown> | null) {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('id=') && !u.includes('doc=')) {
        return ok(account ? { data: DETTAGLIO_ANNA, account } : { data: DETTAGLIO_ANNA })
      }
      return ok(rispostaPredefinita(u))
    })
    return apriAnna()
  }

  it('🔴 account in un plesso NON gestito: «Confermo» è spento, col motivo scritto', async () => {
    await apriConAccount({ esiste: true, ruolo: null, sede_gestita: false, sede_nome: null })
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))

    expect(screen.getByText(itAdminAltro.pratConfermaAccountAltraSede)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: itAdminAltro.pratConferma }),
      'il pannello dice che verrà rifiutata e lascia premere: è il clic che può bloccare la pratica',
    ).toBeDisabled()
    // Spento CON un motivo: un pulsante grigio e muto si legge come un permesso mancante.
    expect(screen.getByText(itAdminAltro.pratConfermaSpentaMotivo)).toBeInTheDocument()
    // …e «Annulla» resta l'uscita, accesa.
    expect(screen.getByRole('button', { name: itAdminAltro.pratAnnulla })).not.toBeDisabled()
  })

  it('🔴 l’email è di un GENITORE: stessa frase, stesso pulsante spento', async () => {
    // In un nido la maestra è spessissimo anche la mamma di un bambino iscritto: è la
    // collisione più probabile di tutte, e il server si ferma su `email_gia_genitore`.
    await apriConAccount({ esiste: true, ruolo: 'Genitore ', sede_gestita: true, sede_nome: 'Kidville Alfa' })
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))

    expect(screen.getByText(itAdminAltro.pratConfermaAccountGenitore)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itAdminAltro.pratConferma })).toBeDisabled()
  })

  it('CONTROLLO POSITIVO: quando l’approvazione può riuscire, «Confermo» resta ACCESO', async () => {
    // Tre casi in cui il server scriverà davvero qualcosa. Se il pulsante si spegnesse
    // qui, la funzione non esisterebbe più.
    await apriConAccount({ esiste: true, ruolo: 'admin', sede_gestita: true, sede_nome: 'Kidville Alfa' })
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    expect(screen.getByRole('button', { name: itAdminAltro.pratConferma })).not.toBeDisabled()
    expect(screen.queryByText(itAdminAltro.pratConfermaSpentaMotivo)).not.toBeInTheDocument()
    cleanup()

    await apriConAccount({ esiste: false, ruolo: null, sede_gestita: null, sede_nome: null })
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    expect(screen.getByRole('button', { name: itAdminAltro.pratConferma })).not.toBeDisabled()
    cleanup()

    // «Non si è potuto verificare» NON è «fallirà»: spegnere su un'incertezza
    // toglierebbe l'unica strada a chi invece potrebbe approvare.
    await apriConAccount(null)
    fireEvent.click(screen.getByRole('button', { name: itAdminAltro.pratApprova }))
    expect(screen.getByText(itAdminAltro.pratConfermaAccountIgnoto)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itAdminAltro.pratConferma })).not.toBeDisabled()
  })
})

/**
 * LOCK · in questa schermata lo stato SPENTO di un comando si dipinge, non si sbiadisce.
 *
 * ─── PERCHÉ ESISTE, visto che un lock così c'è già ───────────────────────────────
 * `__tests__/a11y/btn-disabilitato-leggibile.test.tsx` (2026-08-08) vieta
 * `disabled:opacity-*` perché l'alfa abbassa IN BLOCCO fondo e inchiostro e li
 * avvicina: misura di partenza, 1,20:1. Ma quel lock legge `btnClass`, cioè sorveglia
 * il COMPONENTE `Btn` — e questa schermata i suoi pulsanti se li scrive a mano, quindi
 * il lock non li vedeva. Fino al 2026-08-12 cinque comandi di questo file portavano
 * ancora `disabled:opacity-50`, misurati a 2,20:1: «Mostra altre», «Sposta di sede» e i
 * tre «Annulla». Il peggiore è il primo, ed è il terzo momento che il lock gemello
 * nomina: «Mostra altre» è spento MENTRE carica, con dentro lo spinner e la parola,
 * cioè l'unico segnale che il gesto sia partito.
 *
 * Qui si sorveglia il FILE, che è l'unità in cui il difetto è vissuto.
 */
describe('PratichePersonale — lock · nessun comando si spegne con un’alfa', () => {
  const SORGENTE = fs.readFileSync(
    path.join(process.cwd(), 'src/components/features/admin/personale/PratichePersonale.tsx'),
    'utf8',
  )
  const CSS = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')

  /** I token `--color-kidville-*` di `@theme inline`, cioè i colori veri. */
  const TOKEN: Record<string, string> = (() => {
    const blocco = CSS.slice(CSS.indexOf('@theme inline'))
    const out: Record<string, string> = {}
    for (const m of blocco.matchAll(/--color-kidville-([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g)) {
      if (!(m[1] in out)) out[m[1]] = m[2].toUpperCase()
    }
    return out
  })()

  // WCAG 2.x §1.4.3.
  const canale = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const luminanza = (hex: string) => {
    const h = hex.replace('#', '')
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
    return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b)
  }
  const contrasto = (a: string, b: string) => {
    const [x, y] = [luminanza(a), luminanza(b)]
    const [alto, basso] = x > y ? [x, y] : [y, x]
    return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100
  }
  /** Un colore con alfa COMPOSTO sul suo fondo: è ciò che l'occhio vede. */
  const composita = (fg: string, bg: string, alfa: number) => {
    const canali = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16))
    const [a, b] = [canali(fg), canali(bg)]
    return `#${[0, 1, 2]
      .map((i) => Math.round(a[i] * alfa + b[i] * (1 - alfa)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}`
  }

  it('CONTROLLO POSITIVO: la sonda ritrova il difetto di partenza (2,20:1)', () => {
    // «Mostra altre»: inchiostro verde su card bianca, spento con `opacity-50`. Senza
    // questo caso, il divieto qui sotto sarebbe verde su una sonda che non misura nulla.
    const misura = contrasto(composita(TOKEN.green, '#FFFFFF', 0.5), '#FFFFFF')
    expect(misura, 'la sonda non ritrova nemmeno il difetto misurato').toBeLessThan(4.5)
    expect(contrasto(TOKEN.green, '#FFFFFF'), 'e a riposo lo stesso comando è sano').toBeGreaterThanOrEqual(4.5)
  })

  it('nessun `disabled:opacity-*` in tutto il file', () => {
    const trovati = [...SORGENTE.matchAll(/className=[^\n]*?(disabled:opacity-\d+)/g)].map((m) => m[1])
    expect(
      trovati,
      'un comando si spegne con un’alfa: l’alfa abbassa insieme fondo e inchiostro. Lo stato ' +
        'spento va DIPINTO — una coppia fondo/inchiostro dichiarata — non sbiadito.',
    ).toEqual([])
  })

  it('la coppia dichiarata è UNA sola, e si legge (4,5:1)', () => {
    // Un solo posto in cui i tre token vivono: dieci stringhe di classi scritte a mano
    // divergono, ed è così che cinque comandi su dieci erano rimasti indietro.
    const riga = SORGENTE.match(/const SPENTO =\s*\n?\s*'([^']+)'/)
    expect(riga, '`SPENTO` non è più dichiarata in un posto solo').toBeTruthy()
    const classi = riga![1].split(/\s+/)
    const tokenDa = (prefisso: string) => {
      for (const c of classi) {
        const m = c.match(new RegExp(`^disabled:${prefisso}-kidville-([a-z0-9-]+)$`))
        if (m && TOKEN[m[1]]) return TOKEN[m[1]]
      }
      return null
    }
    const fondo = tokenDa('bg')
    const inchiostro = tokenDa('text')
    const bordo = tokenDa('border')
    expect(fondo, 'lo stato spento non dichiara un riempimento').not.toBeNull()
    expect(inchiostro, 'lo stato spento non dichiara un inchiostro').not.toBeNull()
    expect(bordo, 'lo stato spento non dichiara un contorno: non si vede più come pulsante').not.toBeNull()
    expect(
      contrasto(inchiostro!, fondo!),
      `lo stato spento resta illeggibile: ${inchiostro} su ${fondo}`,
    ).toBeGreaterThanOrEqual(4.5)
    // Nessuna alfa nella coppia: un fondo semitrasparente cambia con la superficie
    // sotto, ed è di nuovo il difetto di partenza sotto un altro nome.
    for (const c of classi) expect(c, `«${c}» porta un’alfa`).not.toMatch(/\/\d{1,3}$/)
  })

  it('TUTTI i comandi disabilitabili passano da quella costante', () => {
    // `disabled=` senza una dichiarazione di colore è un comando che si spegne per
    // omissione: resta identico ad acceso, oppure eredita l'alfa del prossimo che la
    // scriverà a mano.
    const conDisabled = [...SORGENTE.matchAll(/\n\s*disabled=\{[^\n]*\}\n(?:[^\n]*\n){0,6}?[^\n]*className=(\{`|")([^`"]*)/g)]
    expect(conDisabled.length, 'nessun comando disabilitabile trovato: la sonda non misura niente').toBeGreaterThanOrEqual(8)
    const senzaColore = conDisabled.filter((m) => !m[2].includes('${SPENTO}')).map((m) => m[2].slice(0, 60))
    expect(
      senzaColore,
      `questi comandi si spengono senza dichiarare un colore:\n  ${senzaColore.join('\n  ')}`,
    ).toEqual([])
  })
})
