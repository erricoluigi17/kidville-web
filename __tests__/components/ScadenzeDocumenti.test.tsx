import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import itAdmin from '../../messages/it/adminStudents.json'
import enAdmin from '../../messages/en/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * IL CRUSCOTTO DELLE SCADENZE — quello che questo file impedisce.
 *
 *  1. **UNA LISTA VUOTA CHE NASCONDE UN GUASTO.** È il difetto più pericoloso
 *     che questa pagina possa avere: «Nessun documento in scadenza» si legge
 *     come «va tutto bene» ed è indistinguibile da «non abbiamo guardato». Il
 *     test manda la GET a 503 e pretende l'avviso in `role="alert"` E l'assenza
 *     della frase del vuoto.
 *  2. **LE DUE FRASI DEL VUOTO CONFUSE.** «Non c'è niente da fare» e «non c'è
 *     niente in QUESTO STATO» sono affermazioni diverse: dirne una per l'altra
 *     manda qualcuno a chiudere la pagina convinto di aver finito.
 *  3. **`giorni === 0` CONTATO COME SCADUTO.** Un documento d'identità è valido
 *     FINO AL giorno di scadenza compreso: chi scade oggi è «in scadenza», non
 *     «scaduto», e sbagliarlo manderebbe una persona in Comune un giorno prima
 *     del necessario — su un pannello che serve proprio a dirle quando andarci.
 *  4. **LO STATO LETTO DA UNA COLONNA.** Qui non ne esiste una: la route manda
 *     le date, e i quattro secchi li decide `sogliaRaggiunta` — la stessa
 *     funzione del cron notturno. Il test lo verifica sulle DATE, non su un
 *     campo `stato` che la risposta non contiene affatto.
 *  5. **IL FILTRO CHE NON ARRIVA DALLA NOTIFICA.** `statoIniziale` è il
 *     bersaglio di `?stato=scaduto`: se non filtra al primo render, la notifica
 *     atterra su una lista da rifiltrare a mano — cioè su una notifica che si
 *     impara a ignorare.
 *  6. **«In regola» TRASFORMATO IN RIQUADRO.** Un riquadro che nessuno clicca è
 *     rumore: il numero c'è, il pulsante no, e il test guarda proprio che non ci
 *     sia un `button` con quel nome.
 *  7. **«APRI DOCUMENTO» MARCATO `disabled` MENTRE LAVORA.** È l'azione
 *     principale del pannello, quella che si preme una volta per riga: Chrome
 *     sfoga il fuoco dell'elemento che diventa `disabled` e non glielo ridà alla
 *     riattivazione, quindi la coda di lavoro si percorre ritabulando
 *     dall'inizio del documento a ogni riga (WCAG 2.4.3).
 *  8. **UN AVVISO CHE SOPRAVVIVE AL FATTO CHE DESCRIVE.** «Il documento non si è
 *     aperto», in `role="alert"`, mentre il documento della riga dopo si apre
 *     benissimo — perché `setErrore` veniva solo valorizzato, mai azzerato.
 *  9. **LA COLONNA SEDE CHE AFFERMA INVECE DI TACERE.** «Sede non riconosciuta»
 *     su ogni riga finché l'elenco delle sedi non arriva — e per sempre se non
 *     arriva. Con tre plessi in produzione quella colonna è l'unica cosa che
 *     dice a chi appartiene il documento che si sta guardando.
 *
 * ⚠️ IL TEMPO È CONGELATO. Le soglie sono distanze fra date: con l'orologio vero
 * queste asserzioni diventerebbero rosse da sole il giorno in cui il calendario
 * raggiunge le date di prova. È già successo in questo repo.
 */

/**
 * `sediKey` è MUTABILE apposta: è la chiave da cui dipende la ri-lettura, e
 * cambiarla è il modo di riprodurre il gesto vero — la segretaria che cambia
 * plesso — senza passare da «Riprova». È il percorso su cui è stato misurato il
 * difetto della lettura fallita che cancellava una lista già a schermo.
 */
/**
 * `sedi` e `loadingSedi` sono MUTABILI per la stessa ragione di `sediKey`: la
 * colonna Sede dipende da un contesto che si carica per conto suo, e il difetto
 * misurato il 2026-08-12 vive proprio nella finestra in cui quell'elenco non è
 * ancora arrivato — o non arriverà mai, perché quella lettura è fallita.
 */
const h = vi.hoisted(() => ({
  logClient: vi.fn(),
  nomeErrore: () => 'TypeError',
  sediKey: '',
  sedi: [] as Array<{ id: string; nome: string }>,
  loadingSedi: false,
}))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: h.sedi,
    selezionate: [],
    effettive: h.sedi.map((s) => s.id),
    sedeCorrente: h.sedi.length === 1 ? h.sedi[0].id : null,
    reFetchKey: h.sediKey,
    epocaSede: 0,
    loading: h.loadingSedi,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

import { ScadenzeDocumenti, statoScadenza } from '@/components/features/admin/personale/ScadenzeDocumenti'

const OGGI = '2026-08-12'

const SCADUTA = 'dddddddd-0000-4000-8000-000000000001'
const SCADE_OGGI = 'dddddddd-0000-4000-8000-000000000002'
const FRA_24_GIORNI = 'dddddddd-0000-4000-8000-000000000003'
const FRA_79_GIORNI = 'dddddddd-0000-4000-8000-000000000004'
const SENZA_DOCUMENTO = 'dddddddd-0000-4000-8000-000000000005'

const RIGHE = [
  { utente_id: SCADUTA, nome: 'Anna', cognome: 'Alfa', ruolo: 'educator', scuola_id: SEDE_A, document_type: 'CI', document_expiry: '2026-08-01' },
  { utente_id: SCADE_OGGI, nome: 'Bruna', cognome: 'Beta', ruolo: 'educator', scuola_id: SEDE_A, document_type: 'CI', document_expiry: OGGI },
  { utente_id: FRA_24_GIORNI, nome: 'Carla', cognome: 'Gamma', ruolo: 'segreteria', scuola_id: SEDE_A, document_type: 'PP', document_expiry: '2026-09-05' },
  { utente_id: FRA_79_GIORNI, nome: 'Dina', cognome: 'Delta', ruolo: 'cuoca', scuola_id: SEDE_A, document_type: 'DL', document_expiry: '2026-10-30' },
  { utente_id: SENZA_DOCUMENTO, nome: 'Elsa', cognome: 'Epsilon', ruolo: 'educator', scuola_id: SEDE_A, document_type: null, document_expiry: null },
]

const fetchMock = vi.fn()

/** La risposta del cruscotto, con `oggi` del SERVER: è quello che governa i conti. */
function rispondi(righe: unknown[] = RIGHE, extra: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ data: righe, inRegola: 3, cessati: 0, oggi: OGGI, orizzonteGiorni: 90, totalePersonale: 9, limite: 500, ...extra }),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-12T09:00:00.000Z'))
  h.sediKey = SEDE_A
  h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }]
  h.loadingSedi = false
  fetchMock.mockReset()
  rispondi()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const riquadro = (nome: string) => screen.getByRole('button', { name: new RegExp(nome, 'i') })

describe('ScadenzeDocumenti · lo stato si deriva dalle date', () => {
  it('la funzione pura mette ogni data nel suo secco, e «scade oggi» NON è scaduto', () => {
    expect(statoScadenza('2026-08-01', OGGI)).toBe('scaduto')
    expect(statoScadenza(OGGI, OGGI), 'un documento è valido fino al giorno di scadenza compreso').toBe('entro30')
    expect(statoScadenza('2026-08-19', OGGI)).toBe('entro30')
    expect(statoScadenza('2026-09-11', OGGI)).toBe('entro30')
    expect(statoScadenza('2026-09-12', OGGI)).toBe('entro90')
    expect(statoScadenza('2026-11-10', OGGI)).toBe('entro90')
    expect(statoScadenza('2026-11-11', OGGI)).toBe('regola')
    expect(statoScadenza(null, OGGI)).toBe('mancante')
    // Una data che non esiste finisce nella coda di lavoro, non fra chi è a posto.
    expect(statoScadenza('2026-02-30', OGGI)).toBe('mancante')
  })

  it('i quattro riquadri contano le righe, e i confini sono quelli della funzione pura', async () => {
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(riquadro(itAdmin.scadBoxScaduti)).toBeInTheDocument())

    expect(riquadro(itAdmin.scadBoxScaduti)).toHaveTextContent('1')
    // «scade oggi» + «fra 24 giorni» stanno insieme nel secco dei 30.
    expect(riquadro(itAdmin.scadBoxEntro30)).toHaveTextContent('2')
    expect(riquadro(itAdmin.scadBoxEntro90)).toHaveTextContent('1')
    expect(riquadro(itAdmin.scadBoxMancante)).toHaveTextContent('1')
  })

  it('«In regola» è una RIGA, non un riquadro: non esiste nessun pulsante con quel nome', async () => {
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(riquadro(itAdmin.scadBoxScaduti)).toBeInTheDocument())
    expect(
      screen.queryByRole('button', { name: new RegExp(itAdmin.scadStatoRegola, 'i') }),
      'un riquadro che nessuno clicca è rumore',
    ).not.toBeInTheDocument()
    // …ma il numero c'è: senza, i quattro riquadri non hanno scala.
    expect(screen.getByText(itAdmin.scadInRegola)).toBeInTheDocument()
  })

  it('un riquadro filtra l’elenco e si annuncia PREMUTO (`aria-pressed`)', async () => {
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    expect(screen.getByText('Epsilon Elsa')).toBeInTheDocument()

    const scaduti = riquadro(itAdmin.scadBoxScaduti)
    expect(scaduti).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(scaduti)
    expect(scaduti).toHaveAttribute('aria-pressed', 'true')

    expect(screen.getByText('Alfa Anna')).toBeInTheDocument()
    expect(screen.queryByText('Epsilon Elsa')).not.toBeInTheDocument()

    // Il secondo clic toglie il filtro: il riquadro è un interruttore.
    fireEvent.click(scaduti)
    expect(scaduti).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Epsilon Elsa')).toBeInTheDocument()
  })

  it('`statoIniziale` filtra GIÀ AL PRIMO RENDER: è il bersaglio della notifica', async () => {
    render(<ScadenzeDocumenti userId="u1" statoIniziale="scaduto" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    expect(screen.queryByText('Gamma Carla')).not.toBeInTheDocument()
    expect(riquadro(itAdmin.scadBoxScaduti)).toHaveAttribute('aria-pressed', 'true')
  })

  it('ogni riga porta un COLLEGAMENTO vero alla scheda del personale', async () => {
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    const link = screen.getByText('Alfa Anna').closest('a')
    expect(link).toHaveAttribute('href', `/admin/students/${SCADUTA}?kind=staff`)
  })

  it('lo stato di ogni riga è scritto, non solo colorato', async () => {
    render(<ScadenzeDocumenti userId="u1" statoIniziale="scaduto" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    // Il badge porta il TESTO: chi non distingue rosso e arancione legge lo stesso.
    expect(screen.getByText(itAdmin.scadStatoScaduto)).toBeInTheDocument()
  })

  it('la riga senza documento lo DICE, invece di lasciare una cella vuota', async () => {
    render(<ScadenzeDocumenti userId="u1" statoIniziale="mancante" />)
    await waitFor(() => expect(screen.getByText('Epsilon Elsa')).toBeInTheDocument())
    expect(screen.getByText(itAdmin.scadSenzaDocumento)).toBeInTheDocument()
    expect(screen.getByText(itAdmin.scadNonIndicato)).toBeInTheDocument()
  })
})

describe('ScadenzeDocumenti · i quattro stati della schermata', () => {
  it('CARICAMENTO: una regione `status` finché la risposta non arriva', async () => {
    let sblocca: (v: unknown) => void = () => {}
    fetchMock.mockImplementation(() => new Promise((res) => { sblocca = res }))
    render(<ScadenzeDocumenti userId="u1" />)

    const stato = screen.getByRole('status')
    expect(stato).toHaveAttribute('aria-live', 'polite')
    expect(stato).toHaveTextContent(itAdmin.scadCaricamento)

    sblocca({ ok: true, status: 200, json: async () => ({ data: RIGHE, inRegola: 0, cessati: 0, oggi: OGGI }) })
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('ERRORE: `role="alert"`, e MAI la frase del vuoto su una lettura fallita', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'giù', codice: 'ANAGRAFICA_PERSONALE_NON_DISPONIBILE' }) }),
    )
    render(<ScadenzeDocumenti userId="u1" />)

    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(
      screen.queryByText(itAdmin.scadVuoto),
      'una lista vuota sta nascondendo un guasto: «nessun documento in scadenza» qui è FALSO',
    ).not.toBeInTheDocument()
    // …e si può riprovare, invece di dover ricaricare la pagina.
    expect(screen.getByRole('button', { name: itAdmin.scadRiprova })).toBeInTheDocument()
    expect(h.logClient).toHaveBeenCalled()
  })

  it('un 200 con un corpo che NON è un elenco è una lettura fallita quanto un 503', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(screen.queryByText(itAdmin.scadVuoto)).not.toBeInTheDocument()
  })

  it('VUOTO VERO: l’elenco è stato letto e non c’è niente in scadenza', async () => {
    rispondi([])
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText(itAdmin.scadVuoto)).toBeInTheDocument())
    expect(screen.queryByText(itAdmin.scadVuotoFiltro)).not.toBeInTheDocument()
    // Nessun avviso: non c'è niente da riparare, e un `alert` qui direbbe il contrario.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('VUOTO DA FILTRO: frase DIVERSA da quella del vuoto vero, e il filtro si toglie con un gesto', async () => {
    // Un elenco senza righe scadute, aperto con il filtro «scaduto»: le righe
    // ci sono, ma non in QUESTO stato.
    rispondi(RIGHE.filter((r) => r.utente_id !== SCADUTA))
    render(<ScadenzeDocumenti userId="u1" statoIniziale="scaduto" />)

    await waitFor(() => expect(screen.getByText(itAdmin.scadVuotoFiltro)).toBeInTheDocument())
    expect(
      screen.queryByText(itAdmin.scadVuoto),
      'il vuoto DA FILTRO si sta annunciando come «non c’è niente da fare»',
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: itAdmin.scadTogliFiltro }))
    await waitFor(() => expect(screen.getByText('Beta Bruna')).toBeInTheDocument())
  })

  it('l’elenco troncato lo DICE: un cruscotto con meno persone non fa nessun errore', async () => {
    rispondi(RIGHE, { totalePersonale: 500, limite: 500 })
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText(itAdmin.scadElencoTroncato)).toBeInTheDocument())
  })
})

describe('ScadenzeDocumenti · una lettura fallita non lascia in piedi la precedente', () => {
  /**
   * IL DIFETTO CHE QUESTO BLOCCO IMPEDISCE, misurato il 2026-08-12.
   *
   * Prima lettura riuscita: 2 righe in tabella e i quattro riquadri coi loro
   * numeri. Poi una SECONDA lettura fallisce — e non serve premere «Riprova»:
   * basta cambiare sede, che è il gesto più comune di questo cockpit. Risultato:
   * la tabella spariva, il pannello d'errore prendeva il suo posto, ma
   *   · i quattro riquadri RESTAVANO, coi conteggi della lettura precedente —
   *     cioè, dopo un cambio di sede, i conteggi di UN ALTRO PLESSO;
   *   · a schermo comparivano DUE frasi, e tutte e due dicevano «l'elenco che
   *     vedi potrebbe non essere completo» davanti a ZERO righe.
   *
   * Chi legge non capisce se il dato è sparito o non è mai stato letto — che è
   * esattamente l'ambiguità che questo pannello dichiara di esistere per
   * togliere. Perciò: una frase sola, nessun numero superstite.
   */

  /** Cambia le sedi attive facendo ricadere l'effetto: è il percorso senza «Riprova». */
  function rispostaCheFallisce() {
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: async () => ({ error: 'giù', codice: 'ANAGRAFICA_PERSONALE_NON_DISPONIBILE' }),
      }),
    )
  }

  it('la ri-lettura fallita non lascia i CONTEGGI della lettura di prima', async () => {
    const vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    expect(riquadro(itAdmin.scadBoxScaduti)).toHaveTextContent('1')

    // ⚠️ SI CAMBIA SEDE, non si preme «Riprova»: è il percorso vero, ed è quello
    // su cui il difetto era raggiungibile senza toccare niente di eccezionale.
    // I conteggi rimasti sarebbero stati quelli dell'ALTRO plesso.
    rispostaCheFallisce()
    h.sediKey = 'ffffffff-0000-4000-8000-0000000000ff'
    vista.rerender(<ScadenzeDocumenti userId="u1" />)

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: new RegExp(itAdmin.scadBoxScaduti, 'i') })).not.toBeInTheDocument(),
    )
    expect(
      vista.container.querySelectorAll('tbody tr').length,
      'ci sono ancora righe in tabella dopo una lettura fallita',
    ).toBe(0)
    // …e nessun numero superstite da nessuna parte: nemmeno «N in regola».
    expect(screen.queryByText(itAdmin.scadInRegola)).not.toBeInTheDocument()
  })

  it('UNA sola frase, e non afferma che a schermo ci sia un elenco parziale', async () => {
    rispostaCheFallisce()
    render(<ScadenzeDocumenti userId="u1" />)

    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(
      screen.getAllByRole('alert').length,
      'due avvisi per lo stesso guasto: uno diceva «l’elenco che vedi» davanti a zero righe',
    ).toBe(1)

    // La frase mostrata è quella del CODICE del server, e non contiene più la
    // promessa di un elenco visibile.
    const avviso = screen.getByRole('alert').textContent ?? ''
    expect(avviso).toContain('non sono consultabili')
    expect(
      /elenco che vedi|quello che vedi/i.test(avviso),
      'il messaggio afferma che un elenco (parziale) è a schermo, e le righe sono zero',
    ).toBe(false)
  })

  it('i primi numeri compaiono solo DOPO una lettura riuscita, mai durante l’attesa', async () => {
    let sblocca: (v: unknown) => void = () => {}
    fetchMock.mockImplementation(() => new Promise((res) => { sblocca = res }))
    render(<ScadenzeDocumenti userId="u1" />)

    // «0 scaduti» durante il primo caricamento non è un conteggio: è
    // un'affermazione, ed è falsa la metà delle volte.
    expect(screen.queryByRole('button', { name: new RegExp(itAdmin.scadBoxScaduti, 'i') })).not.toBeInTheDocument()
    sblocca({ ok: true, status: 200, json: async () => ({ data: RIGHE, inRegola: 3, cessati: 0, oggi: OGGI }) })
    await waitFor(() => expect(riquadro(itAdmin.scadBoxScaduti)).toHaveTextContent('1'))
  })
})

describe('ScadenzeDocumenti · il fuoco non cade su `<body>`', () => {
  /**
   * ⚠️ IL COMANDO PREMUTO SMONTA SÉ STESSO — ed è il caso in cui il fuoco si
   * perde senza che nessuno se ne accorga guardando lo schermo.
   *
   * «Riprova» e «Togli il filtro» stanno DENTRO il pannello che sparisce nel
   * momento in cui li si preme: chi lavora da tastiera si ritrova il fuoco su
   * `<body>` e deve ritabulare dall'inizio del documento, proprio quando la
   * schermata è appena cambiata (WCAG 2.4.3). Misurato al primo giro:
   * `document.activeElement.tagName === 'BODY'` in 2 casi su 2.
   *
   * Il rimedio è quello già costruito per «comunica un'assenza»: un ricovero
   * STABILE (`FUOCO_ESITO`, `tabIndex={-1}`) attorno ai quattro stati.
   */
  /**
   * Si punta al ricovero DELL'ELENCO per nome (`data-ricovero`), non alla prima
   * `.kv-fuoco-esito` del documento: da questo giro i ricoveri sono tre — quello
   * stabile attorno ai quattro stati e le due fasce d'esito, che stanno più in
   * alto e vincerebbero un `querySelector` di classe.
   */
  const ricovero = (c: HTMLElement) => c.querySelector('[data-ricovero="elenco"]')

  it('«Togli il filtro» posa il fuoco sul ricovero, non sul documento', async () => {
    rispondi(RIGHE.filter((r) => r.utente_id !== SCADUTA))
    const vista = render(<ScadenzeDocumenti userId="u1" statoIniziale="scaduto" />)
    await waitFor(() => expect(screen.getByText(itAdmin.scadVuotoFiltro)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: itAdmin.scadTogliFiltro }))
    await waitFor(() => expect(screen.getByText('Beta Bruna')).toBeInTheDocument())

    expect(document.activeElement, 'il fuoco è caduto su `<body>`').not.toBe(document.body)
    expect(document.activeElement).toBe(ricovero(vista.container))
  })

  it('«Riprova» posa il fuoco sul ricovero, non sul documento', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'giù' }) }),
    )
    const vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByRole('button', { name: itAdmin.scadRiprova })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: itAdmin.scadRiprova }))

    expect(document.activeElement, 'il fuoco è caduto su `<body>`').not.toBe(document.body)
    expect(document.activeElement).toBe(ricovero(vista.container))
  })

  it('il ricovero è STABILE e non entra nell’ordine di tabulazione', async () => {
    const vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    const nodo = ricovero(vista.container)
    expect(nodo, 'non esiste nessun ricovero del fuoco su cui posarsi').toBeTruthy()
    expect(nodo).toHaveAttribute('tabindex', '-1')

    // Stabile: dopo un cambio di stato è LO STESSO nodo del DOM — è ciò che
    // permette di chiamare `.focus()` dentro il gesto, senza rincorrere il render.
    fireEvent.click(riquadro(itAdmin.scadBoxScaduti))
    expect(ricovero(vista.container)).toBe(nodo)
  })
})

describe('ScadenzeDocumenti · le rifiniture che si vedono solo a schermo', () => {
  it('il fondo bianco della carta NON sta sullo scorritore (dove non produrrebbe colore)', async () => {
    /**
     * `.kv-table-scroll` dichiara la SCORCIATOIA `background: linear-gradient(…)`
     * fuori da ogni `@layer`: azzera `background-color` e batte le utility. Un
     * `bg-kidville-white` sullo stesso elemento è codice morto — misurato
     * `rgba(0, 0, 0, 0)` — e il lock `utility-kidville-esistenti` lo lascia
     * passare, perché la classe ESISTE: è inerte, non inesistente.
     */
    const vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    const scorritore = vista.container.querySelector('.kv-table-scroll')
    expect(scorritore).toBeTruthy()
    expect(
      /\bbg-/.test(scorritore!.className),
      'un fondo dichiarato sullo scorritore non produce NESSUN colore: va sul contenitore esterno',
    ).toBe(false)
    // …e il fondo c'è davvero, un gradino più fuori.
    expect(scorritore!.parentElement?.className).toContain('bg-kidville-white')
  })

  it('il paragrafo del pannello d’errore è centrato per davvero', async () => {
    // La misura della riga sta nel banco dedicato in fondo al file. Qui resta
    // solo il centraggio: un paragrafo con un tetto di misura ma senza `mx-auto`
    // ha il testo incollato a sinistra dentro una scatola centrata, e l'effetto
    // è peggiore che non avere nessun tetto.
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'giù' }) }))
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    const paragrafo = screen.getByRole('alert').querySelector('p')
    expect(paragrafo?.className, 'un paragrafo centrato senza `mx-auto` non è centrato').toContain('mx-auto')
  })
})

describe('ScadenzeDocumenti · «Apri documento», il comando che si preme una volta per riga', () => {
  /**
   * ⚠️ TRE DIFETTI SULLO STESSO GESTO, misurati il 2026-08-12.
   *
   * Il giro precedente aveva costruito il ricovero del fuoco per «Riprova» e
   * «Togli il filtro» — due comandi che si premono una volta ogni tanto — e
   * aveva lasciato intatto quello che si preme UNA VOLTA PER RIGA, su una
   * tabella che il server ammette fino a 500 righe.
   *
   *  · `disabled` mentre la richiesta è in volo: `document.activeElement`
   *    diventa BODY nell'istante in cui React marca l'attributo, e NON torna
   *    quando il comando si riattiva (2 misure su 2 in Chrome). È la regola di
   *    casa scritta in `Btn.tsx`: «`disabled` non è il modo di dire "sto
   *    lavorando"».
   *  · l'esito compare 1745 px più in alto (25 righe a 1280 px, cioè 2,4
   *    schermate) e la fascia «finestra bloccata» non aveva né `role` né
   *    `aria-live`, mentre la gemella d'errore aveva `role="alert"`: due esiti
   *    dello stesso gesto, uno annunciato e uno muto — e muto proprio quello che
   *    CHIEDE di premere un collegamento.
   *  · `setErrore(null)`: zero occorrenze contro tre assegnazioni. L'avviso
   *    rosso della riga A restava a schermo mentre la riga B apriva il documento.
   */

  /** Una finestra finta: `window.open` in jsdom non apre niente. */
  function finestraFinta() {
    const w = {
      closed: false,
      opener: {} as unknown,
      location: { replace: vi.fn() },
      close: vi.fn(() => { w.closed = true }),
    }
    return w
  }

  /**
   * Instrada le TRE chiamate del pannello: elenco (`?userId=`), dettaglio
   * (`?utenteId=`), url firmata (`?doc=`). Senza, il mock unico risponderebbe
   * l'elenco anche alla richiesta del percorso nel bucket.
   */
  function instrada(rotte: { dettaglio?: (id: string) => unknown; firma?: () => unknown } = {}) {
    const elenco = { ok: true, status: 200, json: async () => ({ data: RIGHE, inRegola: 3, cessati: 0, oggi: OGGI }) }
    const dettaglioOk = (id: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { anagrafica: { documento_path: `personale/${id}/ci.pdf` } } }),
    })
    const firmaOk = () => ({ ok: true, status: 200, json: async () => ({ url: 'https://esempio.invalid/firmata' }) })
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url)
      if (u.includes('utenteId=')) {
        const id = decodeURIComponent(u.split('utenteId=')[1] ?? '')
        return Promise.resolve((rotte.dettaglio ?? dettaglioOk)(id))
      }
      if (u.includes('doc=')) return Promise.resolve((rotte.firma ?? firmaOk)())
      return Promise.resolve(elenco)
    })
  }

  const comandi = () => screen.getAllByRole('button', { name: new RegExp(itAdmin.scadApriDocumento, 'i') })

  /**
   * Il comando della riga di UNA persona, preso attraverso la riga.
   *
   * ⚠️ NON per nome accessibile: il mock globale di `next-intl` (`test/setup.ts`)
   * risolve la chiave ma IGNORA i valori, quindi qui dentro ogni `aria-label` è
   * letteralmente «Apri documento di {nome}». Che quel segnaposto sia riempito
   * per davvero — e che i comandi abbiano quindi nomi distinti — lo misura
   * `scadenze-documenti-a11y`, che rimocka `next-intl` apposta.
   */
  const comandoDi = (persona: string) =>
    within(screen.getByText(persona).closest('tr') as HTMLElement).getByRole('button')

  afterEach(() => { vi.unstubAllGlobals() })

  /**
   * ⚠️ COSA MISURA DAVVERO QUESTO TEST, E COSA NO.
   *
   * jsdom **non riproduce** lo sfogo del fuoco di Chrome: misurato qui il
   * 2026-08-12 su un `<button>` nudo, `document.activeElement` resta `BUTTON`
   * prima, durante e dopo `disabled` (3 misure su 3). Quindi l'asserzione che
   * porta il peso è quella sull'ATTRIBUTO — «non c'è `disabled`, c'è
   * `aria-disabled`» — che è la causa; quella su `document.activeElement` è una
   * guardia contro le ALTRE ragioni per cui il fuoco potrebbe andarsene (un
   * rimontaggio della riga, una chiave che cambia), e in jsdom quelle sì che si
   * vedono. Il comportamento di Chrome è misurato fuori di qui, col browser, ed
   * è quello che il commento nel prodotto cita.
   *
   * Dirlo per esteso è il punto: un test che sembra misurare il fuoco e invece
   * misura un attributo, se nessuno lo scrive, diventa la prova di una cosa che
   * non ha verificato.
   */
  it('mentre lavora NON si marca `disabled`, e il fuoco resta sul comando premuto', async () => {
    // Il dettaglio resta appeso: è l'istante in cui il difetto era misurabile.
    let sblocca: (v: unknown) => void = () => {}
    instrada({ dettaglio: () => new Promise((res) => { sblocca = res }) })
    vi.stubGlobal('open', vi.fn(() => finestraFinta()))

    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    const bottone = comandi()[0]
    bottone.focus()
    expect(document.activeElement, 'il test non sta misurando niente: il fuoco non era sul comando').toBe(bottone)

    fireEvent.click(bottone)
    await waitFor(() => expect(bottone).toHaveAttribute('aria-busy', 'true'))

    expect(
      bottone,
      '`disabled` mentre lavora: Chrome sfoga il fuoco su `<body>` e non lo restituisce',
    ).not.toBeDisabled()
    expect(bottone).toHaveAttribute('aria-disabled', 'true')
    expect(document.activeElement, 'il fuoco è caduto su `<body>` durante l’attesa').toBe(bottone)
    // …e lo stato non si dice sbiadendo: l'opacità toglierebbe proprio l'unico
    // segnale che il gesto è partito (`Btn.tsx`, stessa lezione).
    expect(/opacity-\d+/.test(bottone.className)).toBe(false)

    sblocca({ ok: true, status: 200, json: async () => ({ data: { anagrafica: { documento_path: 'p/ci.pdf' } } }) })
    await waitFor(() => expect(bottone).not.toHaveAttribute('aria-busy'))
    // Riattivato, il fuoco è ANCORA lì: era il secondo pezzo della misura.
    expect(document.activeElement).toBe(bottone)
  })

  it('il doppio clic sulla stessa riga non fa partire due richieste', async () => {
    // È la difesa vera, e `disabled` non la dava: passa dallo stato di React, e
    // il secondo clic dello stesso tick trova il bottone ancora attivo.
    instrada({ dettaglio: () => new Promise(() => {}) })
    vi.stubGlobal('open', vi.fn(() => finestraFinta()))
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    const bottone = comandi()[0]
    fetchMock.mockClear()
    fireEvent.click(bottone)
    fireEvent.click(bottone)
    await waitFor(() => expect(bottone).toHaveAttribute('aria-busy', 'true'))
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('utenteId=')).length).toBe(1)
  })

  it('«il browser ha bloccato la finestra» si ANNUNCIA e si prende il fuoco', async () => {
    /**
     * È l'esito che CHIEDE un'azione: senza `role` e senza fuoco, chi ha premuto
     * in fondo alla tabella non vede niente (la fascia è 1745 px più su), non
     * sente niente, e il collegamento da premere non sa nemmeno che esista.
     */
    instrada()
    vi.stubGlobal('open', vi.fn(() => null))
    const vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    fireEvent.click(comandoDi('Alfa Anna'))
    await waitFor(() => expect(screen.getByText(new RegExp(itAdmin.scadDocumentoBloccato))).toBeInTheDocument())

    const fascia = vista.container.querySelector('[data-ricovero="esito"]')
    expect(fascia, 'la fascia «finestra bloccata» non ha un ricovero del fuoco').toBeTruthy()
    expect(
      fascia,
      'l’esito che chiede un’azione è MUTO, mentre la sua gemella d’errore ha `role="alert"`',
    ).toHaveAttribute('role', 'alert')
    expect(fascia).toHaveAttribute('tabindex', '-1')
    // In Alto Contrasto l'anello del fuoco si ribalta solo con questa classe.
    expect(fascia!.className).toContain('kv-fuoco-esito')
    // Il fuoco arriva da un effetto: si aspetta il commit, non l'istante del clic.
    await waitFor(() =>
      expect(document.activeElement, 'l’esito non si è preso il fuoco: resta 1745 px più in alto').toBe(fascia),
    )

    // E il collegamento da premere è lì dentro, non altrove nella pagina.
    expect(fascia!.querySelector('a')).toHaveAttribute('href', 'https://esempio.invalid/firmata')
    expect(fascia!.querySelector('a')).toHaveAttribute('target', '_blank')
  })

  it('anche la fascia d’ERRORE si prende il fuoco: i due esiti sono simmetrici', async () => {
    instrada({ dettaglio: () => ({ ok: false, status: 503, json: async () => ({ error: 'giù' }) }) })
    vi.stubGlobal('open', vi.fn(() => finestraFinta()))
    const vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    fireEvent.click(comandoDi('Alfa Anna'))
    await waitFor(() => expect(screen.getByText(itAdmin.scadErroreDocumento)).toBeInTheDocument())

    const fascia = vista.container.querySelector('[data-ricovero="esito"]')
    expect(fascia).toHaveAttribute('role', 'alert')
    expect(fascia!.className).toContain('kv-fuoco-esito')
    await waitFor(() => expect(document.activeElement).toBe(fascia))
  })

  it('l’errore di una riga NON sopravvive all’apertura riuscita di un’altra', async () => {
    /**
     * IL DIFETTO: `setErrore(null)` non esisteva nel file — 0 occorrenze contro
     * 3 assegnazioni — mentre `setDocumentoBloccato(null)` c'era, nella stessa
     * riga in cui mancava il gemello. Risultato: «Il documento non si è aperto»,
     * in `role="alert"` e senza modo di chiuderlo, sotto gli occhi di chi il
     * documento lo aveva appena aperto.
     */
    // Una finestra NUOVA per ogni gesto, come fa il browser: riusarne una sola
    // la ritroverebbe `closed` dopo il fallimento della riga A.
    const finestre: Array<ReturnType<typeof finestraFinta>> = []
    vi.stubGlobal('open', vi.fn(() => { const w = finestraFinta(); finestre.push(w); return w }))
    // La riga A fallisce, tutte le altre no.
    instrada({
      dettaglio: (id) =>
        id === SCADUTA
          ? { ok: false, status: 503, json: async () => ({ error: 'giù' }) }
          : { ok: true, status: 200, json: async () => ({ data: { anagrafica: { documento_path: `p/${id}.pdf` } } }) },
    })
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    fireEvent.click(comandoDi('Alfa Anna'))
    await waitFor(() => expect(screen.getByText(itAdmin.scadErroreDocumento)).toBeInTheDocument())

    fireEvent.click(comandoDi('Beta Bruna'))
    await waitFor(() => expect(finestre.at(-1)!.location.replace).toHaveBeenCalledWith('https://esempio.invalid/firmata'))
    expect(
      screen.queryByText(itAdmin.scadErroreDocumento),
      'l’avviso «non si è aperto» è ancora a schermo davanti a un documento appena aperto',
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('ScadenzeDocumenti · la colonna Sede non afferma ciò che non sa', () => {
  /**
   * IL DIFETTO, misurato il 2026-08-12: `nomeSede` aveva due rami — trovata,
   * oppure «Sede non riconosciuta» — e il pannello non leggeva `loading` dal
   * contesto delle sedi. Finché l'elenco non arrivava (e PER SEMPRE se quella
   * lettura falliva: il contesto chiude comunque `loading` nel `finally`, con
   * l'elenco vuoto) OGNI riga dichiarava che la propria sede non si riconosce.
   *
   * Non è un segnaposto: è un'affermazione sul dato, la stessa forma che la
   * testata del pannello vieta («0 scaduti non è un conteggio, è
   * un'affermazione»). E dal 2026-07-29 le sedi di produzione sono tre: su
   * questo cruscotto quella colonna è l'unica cosa che dice a quale plesso
   * appartenga la persona di cui si sta guardando il documento d'identità.
   */

  it('finché le sedi non si sanno non si legge, e nessuna riga afferma niente', async () => {
    h.loadingSedi = true
    h.sedi = []
    h.sediKey = ''
    render(<ScadenzeDocumenti userId="u1" />)

    // `reFetchKey` parte da '' e il server, con scope vuoto, risponde con TUTTE
    // le righe accessibili: la lettura partiva e le righe si disegnavano mentre
    // `sedi` era ancora [].
    expect(fetchMock, 'la lettura è partita prima di sapere quali sedi').not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent(itAdmin.scadCaricamento)
    expect(screen.queryByText(itAdmin.scadSedeSconosciuta)).not.toBeInTheDocument()

    // Arrivate le sedi, si legge — e la colonna dice il nome del plesso.
    h.loadingSedi = false
    h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }]
    h.sediKey = SEDE_A
    cleanup()
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    expect(screen.getAllByText(NOME_SEDE_A).length).toBe(RIGHE.length)
  })

  it('se l’elenco delle sedi non c’è, la colonna dice che non si sa — non che la sede è ignota', async () => {
    // È il caso DUREVOLE: `/api/admin/sedi` fallisce, il contesto chiude
    // `loading` con l'elenco vuoto, e da lì in poi non cambia più niente.
    h.loadingSedi = false
    h.sedi = []
    h.sediKey = ''
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    expect(
      screen.queryAllByText(itAdmin.scadSedeSconosciuta).length,
      'la segreteria legge che tutte le sedi delle sue righe sono irriconoscibili',
    ).toBe(0)
    expect(screen.getAllByText(itAdmin.scadSedeNonDisponibile).length).toBe(RIGHE.length)
  })

  it('con l’elenco in mano, «Sede non riconosciuta» torna a voler dire qualcosa', async () => {
    // Il controllo POSITIVO: senza, questa correzione avrebbe potuto togliere la
    // frase invece di darle il suo caso — e un id fuori elenco (una sede chiusa,
    // un dato storico) è esattamente quando va detto.
    rispondi([
      { ...RIGHE[0], scuola_id: SEDE_A },
      { ...RIGHE[1], scuola_id: 'ffffffff-0000-4000-8000-00000000000e' },
      { ...RIGHE[2], scuola_id: null },
    ])
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    expect(screen.getAllByText(NOME_SEDE_A).length).toBe(1)
    expect(screen.getAllByText(itAdmin.scadSedeSconosciuta).length).toBe(1)
    // Riga senza sede: «non indicata» non è «non riconosciuta». Mancante non è
    // sbagliato — la colonna Tipo della stessa riga usa già la stessa frase.
    expect(screen.getAllByText(itAdmin.scadNonIndicato).length).toBeGreaterThan(0)
    expect(screen.queryAllByText(itAdmin.scadSedeNonDisponibile).length).toBe(0)
  })
})

/* ───────────────────────────────────────────────────────────────────────────
 * LA MISURA DELLA RIGA — qui le battute SI CONTANO.
 *
 * ⚠️ Il giro scorso questo controllo si chiamava «tetto di misura in CARATTERI»
 * e la sua unica asserzione era `/max-w-\[\d+ch\]/.test(p.className)`: `\d+`
 * accetta qualunque intero, quindi era verde per 52, per 60 e per 120 allo
 * stesso modo. Era verde MENTRE l'introduzione del pannello faceva 87 battute
 * per riga. La testata annunciava quattro misure e l'asserzione non ne eseguiva
 * nessuna: guardava una stringa di classe.
 *
 * La causa dell'equivoco è che `ch` NON è una battuta. `1ch` è l'avanzata della
 * cifra «0» — in Maven Pro 0,646 em — mentre la battuta media di questa prosa
 * ne misura 0,446: rapporto 1,45. `60ch` sono 87 caratteri, non 60.
 *
 * jsdom non impagina, quindi la riga si ricostruisce dalle AVANZATE VERE del
 * carattere e si conta. Non è una stima: il simulatore qui sotto è stato
 * confrontato con Chrome su 36 misure (9 frasi × 4 tetti, italiano e inglese,
 * Range sui nodi di testo della pagina vera) e le ha riprodotte tutte e 36
 * esattamente — crenatura compresa, che a questa risoluzione non sposta nulla.
 * Il test `taratura` qui sotto congela otto di quelle misure: se la tabella o
 * l'algoritmo derivano, casca quello per primo e dice che il metro è rotto,
 * invece di far cascare il prodotto.
 *
 * PROPRIETÀ CHE RENDE IL CONTO POSSIBILE SENZA IMPAGINAZIONE: il numero di
 * battute per riga NON dipende dal corpo. Scatola e glifi scalano insieme, e il
 * corpo si semplifica — misurato, non dedotto: la stessa frase con lo stesso
 * tetto fa `71/73/5` sia a 14 px sia a 16 px. Quindi al banco basta il numero
 * di `ch`, che è l'unica cosa che jsdom sa leggere.
 *
 * ⚠️ ED È PER QUESTO CHE QUI IL TETTO RESTA IN `ch` mentre `FieldRenderer.tsx` e
 * `StaffDetailPanel.tsx` — stesso difetto, stesso giorno — sono passati ai rem.
 * In rem il conto dipende dal corpo, e questo pannello ha prosa a 14 px e a
 * 16 px: il banco dovrebbe INDOVINARE il corpo da una classe Tailwind
 * (`text-sm` → 14, e `text-lg` → 16 sbagliato e silenzioso), cioè rimettere
 * dentro il lock esattamente il buco che il lock esiste per chiudere. Il lock
 * gemello di `FieldRenderer` difende infatti una STRINGA (`max-w-[29rem]`), non
 * una misura: resterebbe verde se cambiasse il carattere. Questo conta le
 * battute, e casca.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Avanzate di Maven Pro in MILLESIMI di em, nell'ordine di `ALFABETO_MAVEN`.
 * Provenienza: `canvas.measureText(c).width / 1000` con `font = '1000px "Maven
 * Pro"'`, eseguito il 2026-08-12 su una pagina vera di `localhost:3100` — cioè
 * sullo stesso file del carattere che `next/font` serve in produzione.
 * Si rigenera con quello snippet quando cambia il carattere; un carattere non
 * in tabella fa fallire la misura a voce alta, non la fa passare a zero.
 */
const ALFABETO_MAVEN =
  " !\"#%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]abcdefghijklmnopqrstuvwxyz{}" +
  'àáâäèéêëìíîïòóôöùúûüçñÀÈÉÌÒÙ' +
  '‘’“”–—·«»€°'
const AVANZATE_MILLESIMI =
  '290,372,381,591,761,640,249,345,345,411,551,313,464,260,404,646,451,581,583,591,566,583,574,582,587,391,285,660,638,649,485,913,643,628,622,667,581,539,687,669,242,453,613,523,785,722,719,613,719,631,555,583,692,623,976,589,598,609,383,381,554,569,492,569,547,375,569,575,240,268,511,232,883,569,569,569,569,377,456,363,578,566,796,532,540,455,373,368,554,554,554,554,547,547,547,547,270,270,270,270,569,569,569,569,578,578,578,578,492,569,643,581,581,242,719,692,255,255,391,387,560,891,311,553,553,679,387'
const AVANZATE = new Map<string, number>(
  [...ALFABETO_MAVEN].map((c, i) => [c, Number(AVANZATE_MILLESIMI.split(',')[i]) / 1000]),
)

/** Quante battute stanno su ogni riga quando `testo` è chiuso in un tetto di `ch`. */
function battutePerRiga(testo: string, ch: number): number[] {
  const larghezzaRiga = ch * AVANZATE.get('0')!
  const em = (s: string) =>
    [...s].reduce((somma, c) => {
      const avanzata = AVANZATE.get(c)
      if (avanzata === undefined) {
        throw new Error(`carattere non misurato: ${JSON.stringify(c)} — rigenera la tabella delle avanzate`)
      }
      return somma + avanzata
    }, 0)
  const spazio = AVANZATE.get(' ')!
  const righe: number[] = []
  let corrente = ''
  let larghezza = 0
  // Si va a capo solo sugli spazi. Chrome va a capo anche dopo un trattino o una
  // lineetta: modellarlo di meno produce righe più lunghe, cioè un metro
  // SEVERO — mai indulgente, che è il verso giusto in cui sbagliare.
  for (const parola of testo.split(' ')) {
    const largaParola = em(parola)
    if (corrente === '') {
      corrente = parola
      larghezza = largaParola
      continue
    }
    if (larghezza + spazio + largaParola <= larghezzaRiga) {
      corrente += ' ' + parola
      larghezza += spazio + largaParola
    } else {
      // `+1`: lo spazio dell'a capo resta in coda alla riga che si chiude, ed è
      // così che Chrome lo conta. Senza, il simulatore sbagliava di 1 battuta su
      // ogni riga non finale — verificato su tutte e 36 le misure.
      righe.push(corrente.length + 1)
      corrente = parola
      larghezza = largaParola
    }
  }
  righe.push(corrente.length)
  return righe
}

/**
 * Le otto misure di Chrome che tengono onesto il simulatore. Le frasi sono
 * COPIE congelate, non letture del catalogo: se domani una traduzione cambia,
 * a cascare dev'essere il prodotto (il test qui sotto), non il metro.
 */
const TARATURA: Array<{ nome: string; testo: string; ch: number; chrome: number[] }> = [
  { nome: 'introduzione IT a 60ch (il difetto: 87 battute)', ch: 60, chrome: [87, 80],
    testo: 'I documenti d’identità del personale, ordinati per urgenza. Lo stato è calcolato dalla data di scadenza: non esiste una casella da spuntare che possa restare indietro.' },
  { nome: 'introduzione IT a 52ch (la correzione)', ch: 52, chrome: [71, 73, 23],
    testo: 'I documenti d’identità del personale, ordinati per urgenza. Lo stato è calcolato dalla data di scadenza: non esiste una casella da spuntare che possa restare indietro.' },
  { nome: 'introduzione EN a 60ch', ch: 60, chrome: [83, 51],
    testo: 'Staff identity documents, sorted by urgency. The status is derived from the expiry date: there is no checkbox that can be left behind.' },
  { nome: 'introduzione EN a 52ch', ch: 52, chrome: [72, 62],
    testo: 'Staff identity documents, sorted by urgency. The status is derived from the expiry date: there is no checkbox that can be left behind.' },
  { nome: 'elenco troncato IT a 60ch (75 esatte: un caso fortunato, non un margine)', ch: 60, chrome: [75, 25],
    testo: 'L’elenco del personale è stato troncato: alcune persone non compaiono qui. Segnalalo all’assistenza.' },
  { nome: 'elenco troncato EN a 68ch', ch: 68, chrome: [91, 8],
    testo: 'The staff list was truncated: some people are missing from this table. Please report it to support.' },
  { nome: 'errore d’elenco IT a 52ch (tre righe)', ch: 52, chrome: [71, 73, 5],
    testo: 'Le scadenze dei documenti non sono state lette. Non è un elenco vuoto: la richiesta non è riuscita, e finché non riesce qui non compare nessuna riga.' },
  { nome: 'vuoto vero EN a 48ch (due righe corte)', ch: 48, chrome: [60, 8],
    testo: 'No staff document expires in the next 90 days, and none are missing.' },
]

/** Oltre questa soglia l'occhio perde il ritorno a capo e rilegge la riga sbagliata. */
const LIMITE_BATTUTE = 75

const IT = itAdmin as unknown as Record<string, string>
const EN = enAdmin as unknown as Record<string, string>

describe('ScadenzeDocumenti · la riga di prosa si misura in battute', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('il metro è tarato: riproduce Chrome su otto misure vere', () => {
    for (const { nome, testo, ch, chrome } of TARATURA) {
      expect(battutePerRiga(testo, ch), `il simulatore non riproduce più Chrome — ${nome}`).toEqual(chrome)
    }
    // E la proprietà su cui poggia tutto: 60ch NON sono 60 battute.
    expect(Math.max(...battutePerRiga(TARATURA[0].testo, 60))).toBeGreaterThan(60)
  })

  it('nessun paragrafo di prosa supera le 75 battute per riga, in italiano E in inglese', async () => {
    const misurate: Array<{ lingua: string; testo: string; ch: number; righe: number[] }> = []
    const tettiVisti = new Set<number>()

    function raccogli() {
      // ⚠️ Il selettore NON porta la parentesi quadra: `[class*="max-w-["]` in
      // jsdom trova 0 elementi dove Chrome ne trova 1 (misurato) — nwsapi si
      // perde sulla quadra dentro il valore. Si cerca il prefisso e si filtra
      // con l'espressione regolare, che è anche dove serve leggere il numero.
      for (const el of document.body.querySelectorAll<HTMLElement>('[class*="max-w-"]')) {
        const classe = el.getAttribute('class') ?? ''
        const tetto = /max-w-\[(\d+)ch\]/.exec(classe)
        if (!tetto) continue
        const ch = Number(tetto[1])
        tettiVisti.add(ch)
        // Solo i nodi di testo DIRETTI: dentro una fascia flex la frase e il
        // collegamento sono due elementi affiancati e vanno a capo per conto loro.
        const prosa = [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? '')
          .join('')
          .trim()
        if (prosa.length < 30) continue
        expect(
          classe,
          `la tabella delle avanzate è di Maven Pro: «${prosa.slice(0, 30)}…» è impaginato con un altro carattere`,
        ).toContain('font-maven')
        if (misurate.some((m) => m.testo === prosa)) continue
        misurate.push({ lingua: 'it', testo: prosa, ch, righe: battutePerRiga(prosa, ch) })
        // La gemella inglese, allo stesso tetto: una traduzione più lunga non
        // allunga la riga, ma una più DENSA sì — ed è il caso già misurato
        // (l'avviso di elenco troncato faceva 75 battute in italiano e 85 in inglese).
        const chiave = Object.keys(IT).find((k) => IT[k] === prosa)
        const inglese = chiave ? EN[chiave] : undefined
        if (inglese) misurate.push({ lingua: 'en', testo: inglese, ch, righe: battutePerRiga(inglese, ch) })
      }
    }

    // 1. elenco pieno, con l'avviso di troncamento: introduzione + troncato.
    rispondi(RIGHE, { totalePersonale: 500, limite: 500 })
    let vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText(IT.scadElencoTroncato)).toBeInTheDocument())
    raccogli()
    vista.unmount()

    // 2. lettura fallita: il paragrafo centrato del pannello d'errore.
    // ⚠️ Corpo VUOTO, non `{ error: 'giù' }`: con una prosa dal server
    // `messaggioErrore` la mostra tale e quale, e a schermo finirebbero tre
    // lettere — cioè il paragrafo più lungo del pannello (`scadErroreElenco`,
    // 149 battute in italiano) non verrebbe misurato mai. Il primo giro di
    // questo banco ne raccoglieva 12 invece di 14 proprio per questo.
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }))
    vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    raccogli()
    vista.unmount()

    // 3. vuoto DA FILTRO.
    rispondi(RIGHE.filter((r) => r.utente_id !== SCADUTA))
    vista = render(<ScadenzeDocumenti userId="u1" statoIniziale="scaduto" />)
    await waitFor(() => expect(screen.getByText(IT.scadVuotoFiltro)).toBeInTheDocument())
    raccogli()
    vista.unmount()

    // 4. vuoto VERO: titolo e sottotitolo.
    rispondi([])
    vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText(IT.scadVuotoSottotitolo)).toBeInTheDocument())
    raccogli()
    vista.unmount()

    // 5 e 6. LE DUE FASCE D'ESITO, che stanno a un tetto diverso (68ch) e non
    // comparirebbero in nessuno degli stati qui sopra: senza premere il comando
    // resterebbero l'unica prosa del pannello mai misurata.
    const percorso = { ok: true, status: 200, json: async () => ({ data: { anagrafica: { documento_path: 'personale/x/ci.pdf' } } }) }
    const instrada = (firma: unknown) =>
      fetchMock.mockImplementation((url: unknown) => {
        const u = String(url)
        if (u.includes('utenteId=')) return Promise.resolve(percorso)
        if (u.includes('doc=')) return Promise.resolve(firma)
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: RIGHE, inRegola: 3, cessati: 0, oggi: OGGI }) })
      })

    instrada({ ok: false, status: 503, json: async () => ({ error: 'giù' }) })
    vi.stubGlobal('open', vi.fn(() => ({ closed: false, opener: {}, location: { replace: vi.fn() }, close: vi.fn() })))
    vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    fireEvent.click(within(screen.getByText('Alfa Anna').closest('tr') as HTMLElement).getByRole('button'))
    await waitFor(() => expect(screen.getByText(IT.scadErroreDocumento)).toBeInTheDocument())
    raccogli()
    vista.unmount()

    instrada({ ok: true, status: 200, json: async () => ({ url: 'https://esempio.invalid/firmata' }) })
    vi.stubGlobal('open', vi.fn(() => null))
    vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    fireEvent.click(within(screen.getByText('Alfa Anna').closest('tr') as HTMLElement).getByRole('button'))
    await waitFor(() => expect(screen.getByText(new RegExp(IT.scadDocumentoBloccato))).toBeInTheDocument())
    raccogli()
    vista.unmount()

    // LA MISURA, una riga per volta, con il numero nel messaggio: un fallimento
    // deve dire QUANTE battute e su quale frase, non «false ≠ true».
    for (const { lingua, testo, ch, righe } of misurate) {
      expect(
        Math.max(...righe),
        `[${lingua}] «${testo.slice(0, 45)}…» a ${ch}ch fa righe da ${righe.join('/')} battute`,
      ).toBeLessThanOrEqual(LIMITE_BATTUTE)
    }

    // CONTROPROVA CHE QUESTO BANCO ABBIA DAVVERO GUARDATO QUALCOSA — ed è la
    // parte che al giro scorso mancava del tutto. Sono 14 misure: i SETTE
    // paragrafi di prosa del pannello (introduzione · elenco troncato · errore
    // d'elenco · vuoto da filtro · sottotitolo del vuoto vero · le due fasce
    // d'esito) per DUE lingue. Il numero è misurato, non sperato: se un
    // paragrafo sparisce, se una gemella inglese smette di risolversi (chiave
    // rinominata, catalogo disallineato) o se ne nasce uno che nessuno dei sei
    // stati qui sopra mette a schermo, questo conto casca prima della misura.
    expect(
      misurate.length,
      `misurati ${misurate.length} paragrafi invece di 14: ${misurate.map((m) => `${m.lingua}:${m.testo.slice(0, 20)}`).join(' | ')}`,
    ).toBe(14)
    expect([...tettiVisti].sort((a, b) => a - b), 'è comparso un tetto mai misurato').toEqual([52, 68])
  })
})
