import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import itShared from '../../messages/it/shared.json'
import { INSEGNANTE_FIELDS, POSIZIONI_OPTIONS } from '@/lib/forms/insegnanti-template'
import { SEDE_A } from '../fixtures/sedi'

/**
 * `/lavora-con-noi` — QUANDO L'INVIO FALLISCE.
 *
 * ─── QUATTRO REGOLE, TUTTE E QUATTRO GIÀ PAGATE ────────────────────────────
 *
 *  1. **Mai `alert()`.** Il pannello di sistema non dice cosa fare, non lascia
 *     traccia in pagina, non si ingrandisce con i caratteri, e nella WebView
 *     nativa è peggio ancora. Il messaggio sta accanto al bottone appena
 *     premuto, con `role="alert"`.
 *  2. **I dati non si perdono.** Chi ha compilato quattro passi deve poter
 *     ripremere «Invia candidatura», non ricominciare. La frase glielo dice,
 *     perché altrimenti non ha modo di saperlo.
 *  3. **`logClient` viene chiamato.** `withRoute` sta sul server e non vede
 *     niente di ciò che accade nel browser: se non si logga qui, non si logga da
 *     nessuna parte — ed è l'ambiguità («nessun log» = tutto bene, oppure = non
 *     parte niente) che ha nascosto per mesi il guasto delle email.
 *  4. **L'etichetta nel log è STABILE, non la prosa del server.** È la regola
 *     che si viola più facilmente: `throw new Error(json.error)` sembra utile, e
 *     `err.stack` comincia con il messaggio — quindi la frase del server ci
 *     finisce dentro tale e quale. Su un 400 quella frase nomina i campi
 *     respinti; su questa porta la scrive chi cerca lavoro. Lo status è un
 *     numero, e basta a capire quale ramo è stato preso.
 *
 * ─── E DUE CASI DEL SERVER CHE NON SONO ERRORI, MA CI SOMIGLIANO ───────────
 *
 *  · **503** — la Scuola non può ricevere candidature adesso. Non è «riprova
 *    fra qualche minuto»: riprovare non serve a niente, e la frase deve
 *    indirizzare altrove. Il codice `CANDIDATURE_NON_DISPONIBILI` esiste
 *    apposta, ed è tradotto sul client.
 *  · **201 con `{"id": null}`** — è la risposta del DOPPIO INVIO. La rotta
 *    risponde 201 come al primo invio di proposito: un 409 su un modulo anonimo
 *    direbbe a chiunque digiti l'indirizzo di una maestra che quella persona si
 *    è candidata (migrazione `20260810094610`, righe 60-71). Il corpo però non
 *    porta sempre un id: una schermata che leggesse `json.id` per decidere di
 *    aver finito mostrerebbe un errore a chi ha appena inviato con successo.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'

/** La prosa che il server manda, e che NON deve comparire né a schermo né nei log. */
const PROSA_DEL_SERVER = 'Non siamo riusciti a registrare la candidatura.'

/**
 * L'etichetta della posizione con quel `value`, LETTA dal template.
 *
 * Dal 2026-08-15 il passo «profilo» non chiede più le fasce d'età: chiede le
 * POSIZIONI, e la casella che questo file spunta per attraversare il modulo non
 * si chiama più «Nido (0-3)» ma «Insegnante — Nido (0-3)». ⚠️ Quel trattino è un
 * EM DASH (U+2014): ribattuto a mano con un trattino corto dà un selettore che
 * non trova niente.
 */
function posizione(valore: string): string {
  const o = POSIZIONI_OPTIONS.find((x) => x.value === valore)
  if (!o) throw new Error(`posizione «${valore}» assente da POSIZIONI_OPTIONS`)
  return String(o.label)
}

/** La posizione che si spunta per attraversare il passo «profilo». */
const POSIZIONE_SCELTA = posizione('insegnante_nido')

const fetchMock = vi.fn()

type EsitoPost =
  | { tipo: 'http'; stato: number; corpo: unknown }
  | { tipo: 'rete' }
  | { tipo: 'ok'; corpo: unknown }

function mockRete(esiti: EsitoPost[]): void {
  let n = 0
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
      const e = esiti[Math.min(n, esiti.length - 1)]
      n += 1
      if (e.tipo === 'rete') return Promise.reject(new TypeError('Failed to fetch'))
      if (e.tipo === 'ok') {
        return Promise.resolve({ ok: true, status: 201, json: async () => e.corpo })
      }
      return Promise.resolve({ ok: false, status: e.stato, json: async () => e.corpo })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

/** Compila tutto e si ferma sul riepilogo, senza premere «Invia candidatura». */
async function compilaFinoAlRiepilogo(): Promise<void> {
  await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
    target: { value: 'aspirante@example.test' },
  })
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'diploma' } })
  fireEvent.click(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA }))
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
}

/** Compila tutto e preme «Invia candidatura». */
async function compilaEInvia(): Promise<void> {
  await compilaFinoAlRiepilogo()
  fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))
}

/** Quanti POST di candidatura sono davvero partiti. */
function postPartiti(): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url).includes('/api/iscrizione/insegnanti') &&
      (init as RequestInit | undefined)?.method === 'POST',
  ).length
}

/** Ogni stringa passata a `logClient`, in un solo posto da ispezionare. */
function testiFinitiNeiLog(): string {
  return h.logClient.mock.calls
    .map(([e]) => JSON.stringify(e ?? {}))
    .join(' | ')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
})

describe('CandidaturaInsegnanteWizard — l’invio fallisce', () => {
  it('500: il messaggio è IN PAGINA, annunciato, e nessun `alert()` di sistema compare', async () => {
    const alertFinto = vi.fn()
    vi.stubGlobal('alert', alertFinto)
    mockRete([{ tipo: 'http', stato: 500, corpo: { error: PROSA_DEL_SERVER, codice: 'CANDIDATURA_NON_INVIATA' } }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)

    await compilaEInvia()

    await waitFor(() => expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument())
    const pannello = screen
      .getAllByRole('alert')
      .find((n) => n.textContent?.includes(itPublic.candErroreInvioTitolo))
    expect(pannello, 'il pannello d’errore deve essere annunciato con role="alert"').toBeDefined()
    expect(alertFinto).not.toHaveBeenCalled()
  })

  it('i dati compilati restano, la frase lo dice, e si può ritentare senza ricompilare niente', async () => {
    // Primo tentativo rifiutato, secondo accettato: è il percorso vero di chi
    // riprova, e la prova che il modulo non si è svuotato per strada.
    mockRete([
      { tipo: 'http', stato: 500, corpo: { error: PROSA_DEL_SERVER, codice: 'CANDIDATURA_NON_INVIATA' } },
      { tipo: 'ok', corpo: { id: 'c-1' } },
    ])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaEInvia()
    await waitFor(() => expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument())

    expect(screen.getByText(itPublic.candErroreInvioDatiSalvi)).toBeInTheDocument()
    const invia = screen.getByRole('button', { name: itPublic.candInvia })
    expect(invia).toBeEnabled()

    fireEvent.click(invia)
    await waitFor(() => expect(screen.getByText(itPublic.candInviata)).toBeInTheDocument())
  })

  it('tornare indietro trova i campi ancora pieni, e spegne l’avviso d’errore', async () => {
    mockRete([{ tipo: 'http', stato: 500, corpo: { error: PROSA_DEL_SERVER, codice: 'CANDIDATURA_NON_INVIATA' } }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaEInvia()
    await waitFor(() => expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: itPublic.candIndietro }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeChecked(),
    )
    // Un avviso che resta acceso mentre si sta correggendo è un avviso che si
    // impara a ignorare.
    expect(screen.queryByText(itPublic.candErroreInvioTitolo)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: itPublic.candIndietro }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA })).toBeChecked())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candIndietro }))
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toHaveValue('Ines'))
    expect(screen.getByPlaceholderText('Es. mario.rossi@email.com')).toHaveValue('aspirante@example.test')
  })

  it('`logClient` è chiamato, e l’etichetta è STABILE: la prosa del server non entra nel log', async () => {
    mockRete([{ tipo: 'http', stato: 500, corpo: { error: PROSA_DEL_SERVER, codice: 'CANDIDATURA_NON_INVIATA' } }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaEInvia()
    await waitFor(() => expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument())

    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({
        livello: 'error',
        evento: 'fetch',
        messaggio: 'candidatura-invio-fallito',
        stato: 500,
      }),
    )
    // ⚠️ IL CONTROLLO CHE CONTA: nessuna parola del server è finita nel log — né
    // nel messaggio, né dentro uno `stack` costruito con `new Error(json.error)`.
    expect(testiFinitiNeiLog()).not.toContain(PROSA_DEL_SERVER)
    expect(testiFinitiNeiLog()).not.toContain('registrare la candidatura')
  })

  it('la prosa del server non compare nemmeno A SCHERMO: chi legge non è chi scrive i log', async () => {
    // Il server manda un `error` italiano, scritto dove il locale non esiste.
    // Mostrarlo a chi ha l’interfaccia in inglese è il difetto T10-F1.
    mockRete([{ tipo: 'http', stato: 500, corpo: { error: PROSA_DEL_SERVER, codice: 'CANDIDATURA_NON_INVIATA' } }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaEInvia()
    await waitFor(() => expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument())

    expect(screen.queryByText(PROSA_DEL_SERVER)).not.toBeInTheDocument()
    // Al suo posto c’è il testo del CODICE dichiarato, che esiste in due lingue.
    expect(screen.getByText(itShared.erroreCandidaturaNonInviata)).toBeInTheDocument()
  })

  it('503: «non possiamo riceverla adesso», e i dati restano in pagina', async () => {
    // `CANDIDATURE_NON_DISPONIBILI` non riusa la frase del guasto generico, che
    // invita a riprovare fra qualche minuto: qui riprovare non può riuscire, e
    // mandare qualcuno a ritentare ogni cinque minuti è peggio di non dire nulla.
    mockRete([
      {
        tipo: 'http',
        stato: 503,
        corpo: {
          error: 'In questo momento non possiamo ricevere candidature.',
          codice: 'CANDIDATURE_NON_DISPONIBILI',
        },
      },
    ])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaEInvia()

    await waitFor(() => expect(screen.getByText(itShared.erroreCandidatureNonDisponibili)).toBeInTheDocument())
    expect(screen.getByText(itPublic.candErroreInvioDatiSalvi)).toBeInTheDocument()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ stato: 503 }))

    fireEvent.click(screen.getByRole('button', { name: itPublic.candIndietro }))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeChecked(),
    )
  })

  it('rete giù (la fetch RIGETTA): pannello in pagina, log con l’etichetta stabile, nessun `alert()`', async () => {
    const alertFinto = vi.fn()
    vi.stubGlobal('alert', alertFinto)
    mockRete([{ tipo: 'rete' }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaEInvia()

    await waitFor(() => expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument())
    expect(screen.getByText(itPublic.candErroreInvioCorpo)).toBeInTheDocument()
    expect(alertFinto).not.toHaveBeenCalled()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({
        livello: 'error',
        evento: 'fetch',
        messaggio: 'candidatura-invio-fallito: TypeError',
      }),
    )
  })

  it('400 sui CAMPI: si torna al passo del campo respinto, con il messaggio sotto di esso', async () => {
    // La rotta risponde in forma PIATTA (`idCampo → messaggio`). Senza questa
    // mappatura si resterebbe sul riepilogo davanti a una frase generica, senza
    // sapere quale campo correggere.
    mockRete([
      {
        tipo: 'http',
        stato: 400,
        corpo: {
          error: 'Alcuni campi non sono validi. Controlla i dati e riprova.',
          codice: 'CANDIDATURA_NON_INVIATA',
          campi: { email: 'Inserisci un indirizzo email valido' },
        },
      },
    ])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaEInvia()

    await waitFor(() => expect(screen.getByText('Inserisci un indirizzo email valido')).toBeInTheDocument())
    expect(screen.getByPlaceholderText('Es. mario.rossi@email.com')).toBeInTheDocument()
    // Non si è finiti davanti al pannello generico: il rifiuto è azionabile.
    expect(screen.queryByText(itPublic.candErroreInvioTitolo)).not.toBeInTheDocument()
  })

  it('400 su un campo che questo modulo NON rende: non si resta muti, compare il pannello', async () => {
    /*
     * ⚠️ IL CAMPO DI QUESTO CASO È CAMBIATO IL 2026-08-15, E LA RAGIONE CONTA.
     *
     * Qui c'era `cv_path`, scelto perché il wizard non lo rendeva: nessuna rotta
     * di caricamento produceva il prefisso `candidature/` che il server pretende.
     * Quella premessa è decaduta — `POST /api/iscrizione/insegnanti/upload` esiste,
     * il campo è uscito da `IDS_NON_RESI` (che è VUOTO) e il curriculum si allega
     * dal passo «profilo». Con `cv_path` questo caso misurerebbe l'opposto di ciò
     * per cui è scritto: `mappaErroriServer` lo mapperebbe eccome, il messaggio
     * comparirebbe sotto il campo e il pannello generico non nascerebbe mai.
     *
     * `gradi` è il campo giusto adesso, e non è un espediente: era una domanda del
     * modulo fino al 14/08 e oggi il server lo DERIVA dalle posizioni. È
     * esattamente la forma del guasto che questo caso difende — un id che il server
     * conosce e che a schermo non ha nessun posto dove portare chi compila.
     */
    const IGNOTO = 'gradi'
    expect(
      INSEGNANTE_FIELDS.some((f) => f.id === IGNOTO),
      `«${IGNOTO}» è tornato nel template: questo caso non misura più un campo non reso`,
    ).toBe(false)

    mockRete([
      {
        tipo: 'http',
        stato: 400,
        corpo: {
          error: 'Alcuni campi non sono validi.',
          codice: 'CANDIDATURA_NON_INVIATA',
          campi: { [IGNOTO]: 'Indica almeno una fascia d’età.' },
        },
      },
    ])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaEInvia()

    await waitFor(() => expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument())
    expect(screen.getByText(itPublic.candErroreInvioDatiSalvi)).toBeInTheDocument()
  })

  it('201 con `{"id": null}` — il doppio invio — è un SUCCESSO, e si dice cosa succede adesso', async () => {
    // La rotta risponde 201 anche quando quell’indirizzo ha già una candidatura
    // viva: un 409 su un modulo anonimo sarebbe un oracolo di enumerazione sul
    // lavoro di qualcuno. Nessun ramo di questa schermata deve dipendere dall’id.
    mockRete([{ tipo: 'ok', corpo: { id: null } }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaEInvia()

    await waitFor(() => expect(screen.getByText(itPublic.candInviata)).toBeInTheDocument())
    // La conferma dice cosa succede ADESSO: chi la valuta, e come arrivano le
    // credenziali. «Inviata» e basta lascerebbe in attesa di niente.
    expect(screen.getByText(itPublic.candInviataCorpo)).toBeInTheDocument()
    expect(screen.queryByText(itPublic.candErroreInvioTitolo)).not.toBeInTheDocument()
  })

  it('201 con un corpo ILLEGGIBILE: resta un successo, e il corpo strano finisce in un log', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => {
            throw new SyntaxError('Unexpected token <')
          },
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaEInvia()

    await waitFor(() => expect(screen.getByText(itPublic.candInviata)).toBeInTheDocument())
    // Il `catch` che legge il corpo non tace: un catch muto è un bug.
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'warn', evento: 'fetch', stato: 201 }),
    )
  })

  /*
   * ─── IL DOPPIO TOCCO, CHE QUI NON COSTA UNA RIGA IN PIÙ MA UN'ORA DI ATTESA ─
   *
   * `disabled={inviando}` si arma DENTRO `invia()`, cioè dopo l'`await
   * trigger(...)` della validazione: fra il clic e l'aggiornamento dello stato
   * c'è un confine asincrono, e tre tocchi rapidi facevano partire tre POST
   * (misurato: 3). Il danno sui DATI è chiuso a valle — indice unico
   * `candidature_insegnanti_email_viva`, 23505 servito come 201 — ma il tetto
   * pubblico è di 3 richieste all'ora per IP: un solo doppio-tocco brucia
   * l'intera dotazione oraria di un indirizzo condiviso, cioè il NAT di una
   * scuola o il CGNAT di un operatore mobile — la stessa popolazione per cui
   * questo modulo teme il 429. Il guardiano dev'essere SINCRONO.
   */

  it('tre clic su «Invia candidatura» nella stessa finestra: parte UN SOLO POST', async () => {
    mockRete([{ tipo: 'ok', corpo: { id: 'c-1' } }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaFinoAlRiepilogo()

    const invia = screen.getByRole('button', { name: itPublic.candInvia })
    fireEvent.click(invia)
    fireEvent.click(invia)
    fireEvent.click(invia)

    await waitFor(() => expect(screen.getByText(itPublic.candInviata)).toBeInTheDocument())
    expect(postPartiti()).toBe(1)
  })

  it('due clic su «Avanti» nella stessa finestra: si avanza di UN passo, non di due', async () => {
    // Stessa corsa, altro sintomo: due `setIndice(i => i + 1)` nella stessa
    // finestra di render saltano il passo «profilo» — dove stanno il titolo di
    // studio e le fasce d'età — e il salto si scopre solo con un 400 del server,
    // che consuma un'altra delle tre richieste orarie.
    mockRete([{ tipo: 'ok', corpo: { id: 'c-1' } }])
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)

    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
    fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
    fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
      target: { value: 'aspirante@example.test' },
    })

    const avanti = screen.getByRole('button', { name: itPublic.candAvanti })
    fireEvent.click(avanti)
    fireEvent.click(avanti)

    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
    // Il passo «consensi» NON è stato scavalcato.
    expect(screen.queryByRole('checkbox', { name: /informativa sulla privacy/i })).not.toBeInTheDocument()
  })
})
