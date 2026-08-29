import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import itCampi from '../../messages/it/parentForms.json'
import { CONSENSI_INSEGNANTI_FIELDS, INSEGNANTE_FIELDS, POSIZIONI_OPTIONS } from '@/lib/forms/insegnanti-template'
import { SEDE_A } from '../fixtures/sedi'

/**
 * `/lavora-con-noi` — I CONSENSI, E LA RIGA CHE IL WIZARD FRATELLO AVEVA
 * DIMENTICATO.
 *
 * ─── IL DIFETTO CHE QUESTO FILE ESISTE PER IMPEDIRE ────────────────────────
 *
 * Su `/iscrizione` ogni pezzo dei consensi funzionava: la casella si spuntava,
 * la validazione bloccava chi non l'aveva spuntata, il server archiviava la
 * prova. Quello che non funzionava era il COLLEGAMENTO fra il penultimo passo e
 * l'ultimo: `handleSubmit` costruiva il payload con i soli bambini e adulti, e
 * le spunte venivano raccolte e buttate via un istante prima dell'invio. Il
 * server rifiutava — giustamente — una domanda senza presa visione, e a schermo
 * arrivava un errore generico su un modulo che sembrava compilato.
 *
 * Nessun test di quel wizard poteva vederlo: guardavano tutti lo SCHERMO. Il
 * difetto è stato trovato dal percorso end-to-end, cioè tardi. Qui la casella si
 * spunta E si guarda il corpo della richiesta.
 *
 * ─── PERCHÉ I CONSENSI SONO DUE, E UNO SOLO È OBBLIGATORIO ─────────────────
 *
 * La base giuridica della valutazione è l'art. 6.1.b GDPR (misure
 * precontrattuali su richiesta dell'interessato): chiedere il permesso di fare
 * la cosa che la persona ci ha appena chiesto di fare sarebbe una domanda senza
 * risposta possibile, e un consenso che non si può negare non è libero. Quel che
 * serve, e che qui è obbligatorio, è la PRESA VISIONE dell'informativa
 * (art. 13). Il consenso vero — facoltativo e revocabile — è quello sulla
 * CONSERVAZIONE della candidatura oltre la selezione.
 *
 * ─── E ANCHE IL «NO» DEVE VIAGGIARE ────────────────────────────────────────
 *
 * Il consenso facoltativo non spuntato parte come `false`, non come assente:
 * dentro `consents_log` «non gliel'ho chiesto» e «ha detto no» sono due fatti
 * diversi, e il secondo è quello su cui si regge la cancellazione a valutazione
 * conclusa.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'
import { allegaCurriculumDiProva } from '../helpers/allega-curriculum'

const OBBLIGATORIO = /informativa sulla privacy/i
const FACOLTATIVO = /Conservate la mia candidatura/i

/**
 * L'etichetta della posizione con quel `value`, LETTA dal template.
 *
 * Dal 2026-08-15 il passo «profilo» non chiede più le fasce d'età: chiede le
 * POSIZIONI, e la casella che qui serve per proseguire non si chiama più «Nido
 * (0-3)» ma «Insegnante — Nido (0-3)». ⚠️ Quel trattino è un EM DASH (U+2014):
 * ribattuto a mano con un trattino corto dà un selettore che non trova niente, e
 * il rosso che ne esce parla del wizard invece che di questa riga.
 */
function posizione(valore: string): string {
  const o = POSIZIONI_OPTIONS.find((x) => x.value === valore)
  if (!o) throw new Error(`posizione «${valore}» assente da POSIZIONI_OPTIONS`)
  return String(o.label)
}

const fetchMock = vi.fn()
const corpiInviati: unknown[] = []

/** `rispostaPost` decide come si comporta l'invio. */
/**
 * Il percorso che `POST /api/iscrizione/insegnanti/upload` restituisce, e il nome
 * del file che si sceglie per ottenerlo.
 *
 * ⚠️ Servono dal 2026-08-24, quando il curriculum è diventato OBBLIGATORIO:
 * l'elicottero che attraversa il passo «Il tuo profilo» senza allegare niente non
 * arriva più ai consensi, e cadrebbe in TIMEOUT su `waitFor` — cioè con uno stack
 * che si legge come «il wizard è rotto» invece che «manca un allegato».
 */
const PERCORSO_CV = 'candidature/11111111-2222-4333-8444-555555555555-cv.pdf'
const NOME_FILE_CV = 'cv-collaudo.pdf'

/**
 * Allega un curriculum al campo `cv_path`, come lo farebbe chi sceglie un file.
 *
 * ⚠️ L'ATTESA IN CODA NON È FACOLTATIVA: il caricamento è asincrono, e senza di
 * essa si preme «Avanti» prima che il campo abbia preso il percorso — cioè si
 * collauda esattamente il caso che si voleva evitare.
 */
/** Allega il curriculum al campo `cv_path`, come lo farebbe chi sceglie un file.
 *  La sonda vive in `__tests__/helpers/allega-curriculum`: erano SEI copie identiche,
 *  e il giorno in cui il riquadro ha cambiato impaginazione sono cadute tutte e sei. */
const allegaCurriculum = () => allegaCurriculumDiProva(NOME_FILE_CV)

function mockRete(rispostaPost?: { stato: number; corpo: unknown }): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    // ⚠️ IL CARICAMENTO SI RICONOSCE PER PRIMO, e l'ordine NON è cosmetico:
    // `/api/iscrizione/insegnanti` è un PREFISSO di
    // `/api/iscrizione/insegnanti/upload`, ed è un POST anche lui. Con il ramo
    // dell'invio davanti, il multipart del curriculum finirebbe fra i corpi
    // inviati e riceverebbe la risposta dell'invio invece del percorso: il
    // campo non si riempirebbe mai (timeout) e i conteggi degli invii
    // direbbero uno in più. È l'ordine che usa già `-riepilogo.test.tsx`.
    if (String(url).includes('/api/iscrizione/insegnanti/upload')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ path: PERCORSO_CV }) })
    }
    if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
      corpiInviati.push(JSON.parse(String(init.body)))
      if (rispostaPost) {
        return Promise.resolve({
          ok: false,
          status: rispostaPost.stato,
          json: async () => rispostaPost.corpo,
        })
      }
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'c-1' }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

/** Arriva al passo dei consensi compilando il minimo indispensabile. */
async function vaiAiConsensi(): Promise<void> {
  await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
    target: { value: 'aspirante@example.test' },
  })
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'diploma' } })
  fireEvent.click(screen.getByRole('checkbox', { name: posizione('insegnante_nido') }))
  await allegaCurriculum()
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByRole('checkbox', { name: OBBLIGATORIO })).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  corpiInviati.length = 0
  mockRete()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
})

describe('CandidaturaInsegnanteWizard — i consensi', () => {
  it('il passo dei consensi ha il SUO titolo, e i due blocchi del template', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    // Il titolo del passo dice il nome di QUESTO passo. Sul wizard fratello la
    // catena di ternari non aveva il ramo dei consensi e cadeva su quello
    // finale: la schermata su cui si presta un consenso si annunciava
    // «Riepilogo», ed è la prima cosa che uno screen reader legge arrivandoci.
    expect(screen.getByRole('heading', { level: 2, name: itPublic.candConsensiTitolo })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: itPublic.candRiepilogo })).not.toBeInTheDocument()

    expect(CONSENSI_INSEGNANTI_FIELDS).toHaveLength(2)
    expect(screen.getByRole('checkbox', { name: OBBLIGATORIO })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: FACOLTATIVO })).toBeInTheDocument()
  })

  it('IL CONSENSO OBBLIGATORIO BLOCCA: senza la presa visione non si arriva al riepilogo', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    expect(await screen.findByText(itCampi.devAccettare)).toBeInTheDocument()
    expect(screen.queryByText(itPublic.candRiepilogoSede)).not.toBeInTheDocument()
    expect(corpiInviati).toHaveLength(0)
  })

  it('il consenso FACOLTATIVO non blocca: da solo, l’obbligatorio basta a proseguire', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('checkbox', { name: OBBLIGATORIO }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    expect(screen.queryByText(itCampi.devAccettare)).not.toBeInTheDocument()
  })

  it('I CONSENSI ENTRANO DAVVERO NEL PAYLOAD — ed è la riga che il wizard fratello aveva dimenticato', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('checkbox', { name: OBBLIGATORIO }))
    fireEvent.click(screen.getByRole('checkbox', { name: FACOLTATIVO }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = (corpiInviati[0] as { data?: Record<string, unknown> }).data ?? {}
    // Uno per uno, per id: un `expect` sul solo obbligatorio passerebbe anche
    // col facoltativo buttato via.
    for (const f of CONSENSI_INSEGNANTI_FIELDS) {
      expect(dati[f.id], `il consenso «${f.id}» non è arrivato nel corpo del POST`).toBe(true)
    }
  })

  it('il «no» viaggia come `false`, non come assente: nella prova è un fatto, non un silenzio', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('checkbox', { name: OBBLIGATORIO }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = (corpiInviati[0] as { data?: Record<string, unknown> }).data ?? {}
    expect(dati.presa_visione_informativa).toBe(true)
    expect(dati.consenso_conservazione_candidatura).toBe(false)
    expect(Object.hasOwn(dati, 'consenso_conservazione_candidatura')).toBe(true)
  })

  it('la spunta sopravvive al giro «Avanti → Indietro»: non si perde tornando a correggere', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('checkbox', { name: OBBLIGATORIO }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: itPublic.candIndietro }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: OBBLIGATORIO })).toBeChecked())
  })

  it('se il SERVER rifiuta per un consenso mancante, si torna al passo dei consensi e lo si vede', async () => {
    // La rotta risponde `400 { consensi: [id] }` senza un testo: il testo giusto
    // ce l'ha già il client, ed è lo stesso che comparirebbe se la spunta
    // mancasse qui — una seconda formulazione per lo stesso rifiuto sarebbe due
    // frasi da mantenere per una cosa sola.
    mockRete({
      stato: 400,
      corpo: {
        error: 'Per proseguire è necessario dichiarare di aver letto l’informativa sulla privacy.',
        codice: 'CANDIDATURA_NON_INVIATA',
        consensi: ['presa_visione_informativa'],
      },
    })
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAiConsensi()

    fireEvent.click(screen.getByRole('checkbox', { name: OBBLIGATORIO }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    // Si è tornati indietro di un passo, sul campo che il server ha respinto.
    await waitFor(() => expect(screen.getByRole('checkbox', { name: OBBLIGATORIO })).toBeInTheDocument())
    expect(screen.getByText(itCampi.devAccettare)).toBeInTheDocument()
    // E la prosa italiana del server non è finita a schermo.
    expect(screen.queryByText(/dichiarare di aver letto/)).not.toBeInTheDocument()
  })
})

/**
 * L'INFORMATIVA AL PUNTO DI RACCOLTA — art. 13 GDPR, e il buco che l'obbligo del
 * curriculum ha aperto il 2026-08-24.
 *
 * ─── IL DIFETTO, MISURATO ──────────────────────────────────────────────────
 *
 * Il curriculum NON viaggia con l'invio: parte nell'istante in cui si sceglie il
 * file. `FileField` chiama `POST /api/iscrizione/insegnanti/upload` dentro
 * `onChange`, e il documento atterra in `form_attachments/candidature/` due passi
 * prima che qualcuno prema «Invia». Lo dice anche la produzione, dove i due
 * numeri non coincidono: 226 eventi `curriculum-caricato` contro 136 righe con
 * `cv_path` e 36 oggetti orfani nel bucket (misurato il 2026-08-25) — cioè
 * curriculum di persone che non hanno mai finito, e che la schermata dei consensi
 * non l'hanno mai vista.
 *
 * Fino al 24/08 `cv_path` era `required: false` e una strada c'era: si saltava
 * l'allegato, si arrivava ai consensi, si leggeva l'informativa e SOLO DOPO si
 * tornava indietro ad allegare. La percorrevano quattro su dieci (àncora
 * `MISURA-CV`, con la sua ora). Rendendo il campo
 * obbligatorio quella strada è sparita: da oggi il passo «profilo» non avanza
 * senza caricamento, quindi NESSUNO può più leggere l'informativa prima di
 * consegnarci il proprio curriculum.
 *
 * ─── PERCHÉ IL RIMEDIO STA QUI E NON NELLA NOTA ────────────────────────────
 *
 * `candCvNota` dice già che senza allegato non si invia, ed è tradotta. Ma una
 * nota informa chi ha già deciso di compilare: l'art. 13 parla del momento in cui
 * i dati sono OTTENUTI, e per il curriculum quel momento è il caricamento. Serve
 * il documento, raggiungibile, prima del gesto — non una frase che lo riassume.
 *
 * Il collegamento è lo stesso oggetto che il blocco `consent` rende da sempre
 * (`field.link` → `CollegamentoInformativa`): una convenzione sola, un componente
 * solo, e — dal 2026-08-25 — anche la STESSA etichetta delle altre quattro
 * dichiarazioni `link: '/privacy'` del prodotto, «Leggi l'informativa completa».
 * Fino a stamattina il curriculum era l'unico punto dell'applicazione a cadere sul
 * ripiego generico del catalogo («Leggi l'informativa» / «Read the policy»), e per
 * giunta il solo in cui il collegamento non ha nessun contesto attorno: sui
 * consensi lo precede «Ho letto l'informativa sulla privacy», al passo del profilo
 * la parola «informativa» non compare da nessun'altra parte.
 *
 * ⚠️ QUESTO TEST GUARDA IL PASSO «PROFILO», NON I CONSENSI. Un `getByRole('link')`
 * fatto a modulo finito sarebbe verde anche col difetto in piedi, perché al passo
 * dei consensi il collegamento c'è sempre stato: la prova è che ci sia PRIMA, e
 * che nel frattempo nessun caricamento sia partito.
 */
describe('CandidaturaInsegnanteWizard — l’informativa al punto di raccolta (art. 13)', () => {
  /**
   * L'etichetta del collegamento sotto il curriculum.
   *
   * ⚠️ ORA VIENE DAL CATALOGO, e la storia del perché vale le tre righe. Il campo
   * `cv_path` non dichiara più `link_label`: `FieldRenderer` ripiega su
   * `leggiInformativaCompleta`, che è la stessa frase delle altre tre
   * dichiarazioni `link: '/privacy'` del prodotto ma esiste in it e in en. La
   * versione di mezzogiorno del 25/08 la cablava in italiano nel template, e
   * MISURATO sulla pagina viva con `KV_LOCALE=en` compariva «Leggi l'informativa
   * completa» sotto una nota inglese.
   * L'intento del gruppo non cambia — il collegamento del curriculum deve
   * chiamarsi come gli altri, non cadere sul ripiego generico «Leggi
   * l'informativa» / «Read the policy» — cambia solo da dove si legge il metro.
   */
  const ETICHETTA_CV = itCampi.leggiInformativaCompleta

  /** Arriva al passo «profilo» SENZA allegare niente: è lì che si misura. */
  async function vaiAlProfilo(): Promise<void> {
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
    fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
    fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
      target: { value: 'aspirante@example.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  }

  /** Quante volte la rotta di CARICAMENTO è stata chiamata, non l'invio. */
  function caricamentiPartiti(): number {
    return fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/iscrizione/insegnanti/upload'),
    ).length
  }

  it('SI PUÒ LEGGERE PRIMA DI CONSEGNARE IL CURRICULUM: il collegamento è nel passo del profilo, con nessun caricamento ancora partito', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    // Il campo c'è, ed è quello che manderà il file al nostro server.
    expect(document.getElementById('cv_path'), 'il campo del curriculum non è reso').not.toBeNull()
    // Nessun byte è ancora uscito: siamo nell'istante che precede la raccolta.
    expect(caricamentiPartiti(), 'un caricamento è già partito: la misura non vale più').toBe(0)
    // E il passo dei consensi non è ancora comparso, quindi il collegamento che
    // segue NON può essere quello del blocco `consent`.
    expect(screen.queryByRole('checkbox', { name: OBBLIGATORIO })).not.toBeInTheDocument()

    const collegamento = screen.getByRole('link', { name: ETICHETTA_CV })
    expect(collegamento).toHaveAttribute('href', '/privacy')
  })

  /**
   * Le strade verso l'informativa presenti in QUESTO istante, contate per
   * destinazione e non per etichetta.
   *
   * ⚠️ PER `href`, ED È LA PARTE CHE HA FATTO ROSSO IL PRIMO TENTATIVO. La ragione
   * di allora era che i due collegamenti avevano nomi DIVERSI — «Leggi
   * l'informativa completa» sul consenso, «Leggi l'informativa» sul curriculum — e
   * contarli per nome esatto ne vedeva uno solo. Dal 2026-08-25 quella divergenza
   * non c'è più (il curriculum ha lo stesso `link_label` delle altre quattro
   * dichiarazioni del prodotto), ma il conteggio resta per `href`: adesso il
   * rischio è l'opposto, cioè che due nomi IDENTICI sulla stessa schermata si
   * confondano, e `getAllByRole` per nome direbbe «due» senza dire dove.
   */
  function stradeVersoInformativa(): HTMLAnchorElement[] {
    return Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href="/privacy"]'))
  }

  it('il collegamento del profilo è UNO SOLO e non ruba quello dei consensi: al passo dopo ce n’è ancora esattamente uno', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    // Uno al profilo, ed è quello nuovo del curriculum.
    expect(stradeVersoInformativa()).toHaveLength(1)
    expect(screen.getByRole('link', { name: ETICHETTA_CV })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'diploma' } })
    fireEvent.click(screen.getByRole('checkbox', { name: posizione('insegnante_nido') }))
    await allegaCurriculum()
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: OBBLIGATORIO })).toBeInTheDocument())

    // …e uno ai consensi, che è quello di sempre. Due collegamenti sulla stessa
    // schermata sarebbero la regressione dell'altro verso: il campo `file`
    // smontato che si porta dietro il proprio.
    expect(stradeVersoInformativa()).toHaveLength(1)
    // ⚠️ Il conteggio si fa per `href` e non per nome, perché dal 2026-08-25 i due
    // collegamenti si chiamano allo stesso modo: cercare il nome qui troverebbe
    // quello dei consensi e direbbe che il campo smontato ha lasciato il suo.
    expect(stradeVersoInformativa()[0].closest('label'), 'il collegamento dei consensi è tornato dentro la label').toBeNull()
  })

  /*
   * ── E SI CHIAMA COME GLI ALTRI QUATTRO (25/08/2026) ───────────────────────
   *
   * ⚠️ AGGIORNATO IL 25/08 (terzo giro): il ripiego generico `leggiInformativa`
   * NON esiste più. Era il ripiego del solo ramo `consent`, mentre il ramo di
   * campo ripiegava su `leggiInformativaCompleta`: due rami dello stesso
   * componente, due frasi per lo stesso collegamento. Finché i tre template
   * cablavano `link_label` in italiano la divergenza si vedeva solo in inglese —
   * passo 3 «Read the full privacy notice», passo 4 «Leggi l'informativa
   * completa», a un passo di distanza. Ora la sorgente è UNA: la chiave del
   * catalogo, per tutte e cinque le dichiarazioni `link: '/privacy'`, e i
   * `link_label` cablati non ci sono più in nessun template.
   */
  it('l’etichetta del collegamento è quella delle altre dichiarazioni, non il ripiego del catalogo', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    expect(ETICHETTA_CV, 'la chiave del catalogo è sparita').toBeTruthy()
    // La chiave morta è stata portata via col suo unico consumatore: se qualcuno
    // la rimettesse, tornerebbe con sé la seconda frase per lo stesso collegamento.
    expect('leggiInformativa' in itCampi, 'è tornato il ripiego generico').toBe(false)
    // …e NESSUNO dei template cabla più l'etichetta: né il curriculum né il
    // consenso. Senza queste due righe il test resterebbe verde anche se
    // `link_label` tornasse, in italiano, sopra un catalogo inglese.
    expect(
      INSEGNANTE_FIELDS.find((f) => f.id === 'cv_path')?.link_label,
      'il curriculum ha di nuovo un’etichetta cablata nel template',
    ).toBeUndefined()
    expect(
      CONSENSI_INSEGNANTI_FIELDS.find((f) => f.link)?.link_label,
      'il consenso ha di nuovo un’etichetta cablata nel template',
    ).toBeUndefined()
    expect(screen.getByRole('link', { name: ETICHETTA_CV })).toHaveAttribute('href', '/privacy')
  })
})
