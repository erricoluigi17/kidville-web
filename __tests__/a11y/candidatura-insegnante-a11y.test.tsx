import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import itPublic from '../../messages/it/public.json'
import itParentForms from '../../messages/it/parentForms.json'
import { INSEGNANTE_FIELDS, POSIZIONI_OPTIONS } from '@/lib/forms/insegnanti-template'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi'

/**
 * `/lavora-con-noi` — L'ACCESSIBILITÀ DEL MODULO PUBBLICO DI CANDIDATURA.
 *
 * ─── PERCHÉ QUESTE CINQUE COSE, E NON UN «passa axe» E BASTA ───────────────
 *
 * Perché nessuna delle cinque fa rumore da nessun'altra parte, e tutte e cinque
 * sono già arrivate in produzione su una schermata gemella:
 *
 *  1. **UN SOLO `<h1>`.** Il modulo pubblico d'iscrizione — su cui 251 famiglie
 *     hanno consegnato codici fiscali di minori, allergie e note mediche — non
 *     ne aveva NESSUNO fino al 2026-08-01: era un `div` con dentro uno `span`.
 *     Chi naviga per intestazioni con uno screen reader (il modo normale di
 *     orientarsi in una pagina lunga) non trovava né il nome della pagina né il
 *     punto da cui ricominciare dopo un errore.
 *  2. **Il titolo del passo dei CONSENSI è un `h2`, e dice il nome di QUEL
 *     passo.** Sul wizard fratello la catena di ternari non aveva il ramo dei
 *     consensi e cadeva su quello finale: la schermata su cui si presta il
 *     consenso al trattamento si annunciava «Riepilogo». Un'intestazione che
 *     dice il nome di un'altra pagina non è un dettaglio estetico — è la prima
 *     cosa che uno screen reader legge quando ci si arriva.
 *  3. **`fieldset`/`legend` sulla sede.** Tre caselle senza un gruppo dichiarato
 *     si annunciano come tre domande separate: chi ascolta sente «Kidville
 *     Alfa, pulsante di opzione» senza sapere che cosa stia scegliendo.
 *  4. **Il fuoco va sul primo campo non valido.** Senza, chi usa la tastiera o
 *     uno screen reader preme «Avanti», non succede niente di percepibile, e
 *     l'errore resta in un punto della pagina che non ha modo di trovare.
 *  5. **`jest-axe` su OGNI passo.** Un passo per volta, perché è un passo per
 *     volta che si vede: un controllo sul solo primo pannello lascerebbe fuori
 *     proprio i consensi, che sono la schermata con più testo e più caselle.
 */

expect.extend(toHaveNoViolations)

/**
 * Le regole a livello di DOCUMENTO non si applicano a un componente isolato in
 * jsdom, e `color-contrast` non è calcolabile senza layout (il contrasto ha il
 * suo lock dedicato, `__tests__/a11y/contrasto-cascata.test.tsx`). Stesso
 * insieme di `smoke.axe.test.tsx`, così due file non divergono sulla stessa
 * decisione.
 */
const axeOpts = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
}

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'
import { allegaCurriculumDiProva } from '../helpers/allega-curriculum'

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const BETA = { id: SEDE_B, nome: NOME_SEDE_B }
const GAMMA = { id: SEDE_C, nome: NOME_SEDE_C }

const fetchMock = vi.fn()

function mockSedi(sedi: { id: string; nome: string }[]): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/iscrizione/sedi')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: sedi }) })
    }
    // ⚠️ IL CARICAMENTO DEL CURRICULUM SERVE ANCHE QUI, dal 2026-08-24: il campo
    // è obbligatorio, quindi ogni percorso che attraversa il passo «Il tuo
    // profilo» ci passa. Senza questo ramo il ripiego qui sotto risponde `{}`,
    // il `path` è `undefined`, il campo non si riempie mai e il test cade in
    // TIMEOUT — con uno stack che accusa il wizard invece dell'elicottero.
    if (url.includes('/api/iscrizione/insegnanti/upload')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ path: PERCORSO_CV }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

const avanti = () => fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

/**
 * L'etichetta della posizione con quel `value`, LETTA dal template.
 *
 * Dal 2026-08-15 il passo «profilo» non chiede più le fasce d'età: chiede le
 * POSIZIONI, e la casella che si spunta per attraversarlo non si chiama più «Nido
 * (0-3)» ma «Insegnante — Nido (0-3)». ⚠️ Quel trattino è un EM DASH (U+2014):
 * ribattuto a mano con un trattino corto dà un selettore che non trova niente.
 */
function posizione(valore: string): string {
  const o = POSIZIONI_OPTIONS.find((x) => x.value === valore)
  if (!o) throw new Error(`posizione «${valore}» assente da POSIZIONI_OPTIONS`)
  return String(o.label)
}

/** Compila «I tuoi dati» e passa al profilo. */
async function passoDati(): Promise<void> {
  await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
    target: { value: 'aspirante@example.test' },
  })
  avanti()
}

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

/** Compila «Il tuo profilo» e passa ai consensi. */
async function passoProfilo(): Promise<void> {
  await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'diploma' } })
  fireEvent.click(screen.getByRole('checkbox', { name: posizione('insegnante_nido') }))
  await allegaCurriculum()
  avanti()
}

/** Spunta la presa visione e passa al riepilogo. */
async function passoConsensi(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
  avanti()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
})

describe('a11y · /lavora-con-noi — struttura e annunci', () => {
  it('c’è UN SOLO `h1`, ed è il titolo della pagina', async () => {
    mockSedi([ALFA, BETA, GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())

    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1).toHaveLength(1)
    // L'icona è decorativa (`aria-hidden`): il nome dell'`h1` resta il titolo.
    expect(h1[0]).toHaveAccessibleName(itPublic.candTitolo)
  })

  it('l’`h1` resta uno solo in OGNI stato, compresi i due in cui il modulo non comincia', async () => {
    // I rami d'errore sono quelli in cui è più facile perdere l'intestazione:
    // sostituiscono l'intero corpo della pagina.
    for (const sedi of [[], [ALFA, BETA, GAMMA]]) {
      mockSedi(sedi)
      const { unmount } = render(<CandidaturaInsegnanteWizard />)
      await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1))
      unmount()
    }
  })

  it('il titolo di OGNI passo è un `h2`, COMPRESO quello dei consensi', async () => {
    mockSedi([ALFA, BETA, GAMMA])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    expect(screen.getByRole('heading', { level: 2, name: itPublic.candSede })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_A }))
    avanti()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candDati })).toBeInTheDocument(),
    )
    await passoDati()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candProfilo })).toBeInTheDocument(),
    )
    await passoProfilo()

    // ⚠️ IL PUNTO DI TUTTO IL FILE: il passo dei consensi ha il SUO titolo.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candConsensiTitolo })).toBeInTheDocument(),
    )
    // E non quello del passo successivo, che è il difetto già pagato.
    expect(screen.queryByRole('heading', { name: itPublic.candRiepilogo })).not.toBeInTheDocument()
    await passoConsensi()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candRiepilogo })).toBeInTheDocument(),
    )
    /*
     * NESSUN SALTO DI LIVELLO — e la sonda misura questo, non «zero `h3`».
     *
     * Fino all'11/08/2026 la riga qui era `queryAllByRole('heading', {level:3})`
     * a zero. Era la formulazione più stretta della regola giusta, e il
     * riepilogo completo l'ha resa falsa: ogni gruppo del riepilogo («Sede», «I
     * tuoi dati», «Il tuo profilo», «Consensi e informativa») ha la sua
     * intestazione, e sotto l'`h2` «Riepilogo» un `h3` NON è un salto — è la
     * gerarchia con cui uno screen reader salta da un gruppo all'altro invece
     * di scorrere venti righe di etichette una per una.
     *
     * Quello che non deve succedere è che un livello ne SCAVALCHI un altro
     * (h1 → h3 senza h2, h3 → h5). È ciò che si verifica qui riga per riga, ed
     * è anche ciò che controlla la regola axe `heading-order`, attiva in
     * `axeOpts` e già eseguita su questa stessa schermata più sotto.
     */
    const livelli = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)))
    expect(livelli[0], 'la prima intestazione della pagina è l’`h1`').toBe(1)
    for (let i = 1; i < livelli.length; i += 1) {
      expect(
        livelli[i],
        `salto di livello nel riepilogo: h${livelli[i - 1]} → h${livelli[i]}`,
      ).toBeLessThanOrEqual(livelli[i - 1] + 1)
    }
    // E il riepilogo ha davvero i suoi gruppi: se un giorno tornassero a essere
    // dei `<p>`, la sonda qui sopra resterebbe verde senza guardare più niente.
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0)
  })

  it('la scelta della sede è un `fieldset` con una `legend`, non tre caselle sciolte', async () => {
    mockSedi([ALFA, BETA, GAMMA])
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())

    const gruppo = container.querySelector('fieldset')
    expect(gruppo, 'le sedi devono stare in un fieldset: senza, sono tre domande separate').not.toBeNull()
    expect(gruppo?.querySelector('legend')?.textContent).toBe(itPublic.candSedeLegenda)
    // Il gruppo è annunciato con il suo nome, e contiene tutte e tre le sedi.
    expect(screen.getByRole('group', { name: itPublic.candSedeLegenda })).toBeInTheDocument()
    for (const nome of [NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C]) {
      expect(screen.getByRole('checkbox', { name: nome })).toBeInTheDocument()
    }
  })

  it('validazione fallita: il FUOCO va sul primo campo non valido', async () => {
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    // Il primo campo è vuoto, il secondo pieno: se il fuoco andasse «sul primo
    // campo» invece che «sul primo NON valido», questo test passerebbe lo stesso.
    // Perciò si riempie il primo e si lascia vuoto il SECONDO.
    fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
    avanti()

    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText('Es. Rossi')))
    // E il messaggio è testo, non solo un bordo colorato.
    expect(screen.getAllByText(itParentForms.campoObbligatorio).length).toBeGreaterThan(0)
  })

  /*
   * IL PRIMO CLIC SU «AVANTI» NON DEVE ESSERE INGHIOTTITO.
   *
   * ⚠️ MISURATO IN CHROMIUM il 2026-08-25 su http://localhost:3100/lavora-con-noi,
   * passo «Il tuo profilo», curriculum non allegato, fuoco dentro `#cv_path`
   * (arrivato con Tab, oppure toccando il riquadro e annullando il selettore —
   * cioè il gesto di chi il curriculum sottomano non ce l'ha). Premendo «Avanti»
   * UNA volta con il mouse o col dito, il modulo NON FACEVA NIENTE. Il registro
   * degli eventi, alle coordinate del bottone:
   *     mousedown@bottone (y=642) → mouseup@DIV (y=666) → click@DIV
   * cioè `mousedown` sul bottone, `mouseup` VENTIQUATTRO PIXEL PIÙ IN BASSO su un
   * altro elemento, e quindi un `click` emesso sull'antenato comune — MAI sul
   * bottone. `onClick` non partiva: nessun avanzamento, nessun fuoco posato,
   * nessun messaggio nuovo. Serviva premere due volte.
   *
   * LA CAUSA non è il campo file e non è `setFocus`: è il MOVIMENTO. `useForm` gira
   * in `mode: 'onTouched'`; il `mousedown` sposta il fuoco sul bottone, il campo si
   * blura, la validazione scatta, il messaggio «Campo obbligatorio» viene INSERITO
   * nel flusso sopra i comandi e il bottone scende — fra la pressione e il rilascio.
   * Il bersaglio si sposta da sotto il dito mentre il dito è ancora giù.
   *
   * ⚠️ NON È UN DIFETTO DI QUESTO LAVORO, ed è stato misurato prima di dirlo: lo
   * stesso gesto sul passo «I tuoi dati», con `#email` vuota e mai toccata, dava
   * `click su HTML` e il fuoco su `<body>`. Vale per OGNI campo obbligatorio dei
   * due wizard pubblici, e valeva già quando il curriculum era facoltativo — solo
   * che allora il curriculum non produceva nessun errore, quindi il bottone non si
   * spostava mai da lì. Renderlo obbligatorio ha messo il difetto sull'ultimo campo
   * prima dei comandi, cioè sulla strada di tutti.
   *
   * IL RIMEDIO sta in `ComandiWizard`: `onMouseDown` con `preventDefault()`. Il
   * clic non sposta più il fuoco, quindi il campo non si blura, quindi la
   * validazione di `onTouched` non scatta, quindi niente si muove prima del
   * `mouseup`. La validazione la fa `passoAvanti()`, che è il posto che l'ha
   * sempre fatta.
   *
   * ⚠️ QUESTO TEST NON PUÒ VEDERE IL DIFETTO: jsdom non ha layout, il bottone non
   * si sposta e il clic arriva sempre. Asserisce l'unica cosa che jsdom sa
   * misurare — che il gesto di pressione sia neutralizzato — e serve a impedire
   * che quella riga sparisca in silenzio. La guardia che vede il difetto VERO sta
   * in `e2e/public-candidatura-insegnante.spec.ts`, in un browser con un layout.
   */
  it('il gesto di pressione sul comando primario non sposta il fuoco (il primo clic non si perde)', async () => {
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    const primario = screen.getByRole('button', { name: itPublic.candAvanti })
    const consumato = fireEvent.mouseDown(primario)
    expect(
      consumato,
      'il `mousedown` sul comando primario non è prevenuto: il fuoco cambia, il campo si blura, il messaggio compare e il bottone si sposta fra la pressione e il rilascio',
    ).toBe(false)

    // E il comando resta un comando: il clic vero continua a eseguirlo.
    fireEvent.click(primario)
    await waitFor(() => expect(screen.getAllByText(itParentForms.campoObbligatorio).length).toBeGreaterThan(0))
  })

  it('«candidatura inviata» è ANNUNCIATA, e il fuoco non cade su `<body>`', async () => {
    // ⚠️ IL MOMENTO PIÙ IMPORTANTE DEL MODULO. Il ramo della conferma SOSTITUISCE
    // l'intero blocco dei passi: il bottone «Invia candidatura» appena premuto
    // viene smontato, e il fuoco della tastiera cade sul documento. Senza un
    // annuncio, chi usa uno screen reader preme «Invia» e non sente NIENTE —
    // indistinguibile da una pagina che si è rotta, sull'unica schermata che dice
    // che la candidatura è partita.
    //
    // `jest-axe` non può vederlo (l'assenza di una regione live non è una
    // violazione axe) e infatti gli 11 controlli di questo file passavano lo
    // stesso: il presidio è questo test, non la sonda automatica.
    mockSedi([GAMMA])
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [GAMMA] }) })
      }
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
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'c-1' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<CandidaturaInsegnanteWizard />)

    await passoDati()
    await passoProfilo()
    await passoConsensi()
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    // 1 · È annunciata: il pannello è una regione live (`role="status"` implica
    //     `aria-live="polite"`), come già lo era l'attesa dell'elenco sedi.
    const conferma = await screen.findByRole('status')
    expect(conferma).toHaveTextContent(itPublic.candInviata)
    expect(conferma).toHaveTextContent(itPublic.candInviataCorpo)

    // 2 · E il fuoco è dentro il contenuto nuovo, non in cima al documento.
    const titolo = screen.getByRole('heading', { level: 2, name: itPublic.candInviata })
    await waitFor(() => expect(document.activeElement).toBe(titolo))
    expect(document.activeElement).not.toBe(document.body)
    // Il titolo si mette a fuoco da codice ma NON entra nell'ordine di
    // tabulazione: non è un comando, e trovarselo sotto il Tab sarebbe rumore.
    expect(titolo).toHaveAttribute('tabindex', '-1')
  })

  it('i campi dichiarano il loro SCOPO (`autocomplete`, WCAG 1.3.5)', async () => {
    // SC 1.3.5 «Identify Input Purpose», AA. Pesa proprio qui: modulo pubblico,
    // compilabile dal telefono, dove il riempimento automatico è la differenza
    // fra sei campi digitati e un tocco. Lo scopo si dichiara nel TEMPLATE e
    // arriva al controllo da `FieldRenderer`.
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    const atteso: [string, string][] = [
      ['nome', 'given-name'],
      ['cognome', 'family-name'],
      ['email', 'email'],
      ['telefono', 'tel'],
      ['residence_city', 'address-level2'],
      ['residence_province', 'address-level1'],
    ]
    for (const [id, scopo] of atteso) {
      const campo = document.getElementById(id)
      expect(campo, `il campo ${id} non è reso`).not.toBeNull()
      expect(campo, `${id}: scopo dichiarato`).toHaveAttribute('autocomplete', scopo)
    }
  })

  /*
   * ─── IL PASSO «PROFILO» È CAMBIATO IL 2026-08-15, E CON LUI CIÒ CHE SI ASCOLTA ─
   *
   * Le tre caselle delle fasce d'età sono diventate SETTE posizioni, ed è la
   * domanda principale del modulo; accanto è comparso il campo del curriculum, che
   * è un `<input type="file">`. Sono le due forme che un modulo di questo tipo
   * sbaglia più spesso: sette caselle senza un gruppo dichiarato si annunciano
   * come sette domande separate (chi ascolta sente «Cuoca / aiuto cucina, casella
   * di controllo» senza aver mai sentito la domanda), e un controllo di
   * caricamento nascosto con `display: none` esce dall'albero di accessibilità e
   * dall'ordine di tabulazione — cioè un allegato che si può consegnare solo col
   * mouse.
   *
   * I numeri qui sotto sono LETTI dal template, non ribattuti: se un domani si
   * aggiunge una posizione, questo caso continua a contarle tutte.
   */
  it('le SETTE posizioni sono un gruppo solo, e il curriculum resta raggiungibile da tastiera', async () => {
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())

    // 1 · Le posizioni sono un `group` con il suo nome, e le caselle stanno tutte
    //     lì dentro: la domanda si sente UNA volta, non sette.
    const gruppo = screen.getByRole('group', { name: /Per quali posizioni ti proponi/ })
    const caselle = within(gruppo).getAllByRole('checkbox')
    expect(caselle).toHaveLength(POSIZIONI_OPTIONS.length)
    expect(POSIZIONI_OPTIONS).toHaveLength(7)
    for (const o of POSIZIONI_OPTIONS) {
      expect(
        within(gruppo).getByRole('checkbox', { name: String(o.label) }),
        `la posizione «${o.value}» non ha una casella col suo nome`,
      ).toBeInTheDocument()
    }

    // 2 · Il curriculum: un `<input type="file">` vero, nell'albero e nel Tab.
    //     `sr-only` e non `hidden` — è la differenza fra «fuori dalla vista» e
    //     «fuori dall'interfaccia».
    const cv = document.getElementById('cv_path') as HTMLInputElement | null
    expect(cv, 'il campo del curriculum non è reso').not.toBeNull()
    expect(cv!.type).toBe('file')
    expect(cv!.hidden).toBe(false)
    expect(cv!.getAttribute('class') ?? '').toContain('sr-only')
    // Il nome accessibile porta l'etichetta del campo, non solo «Seleziona un
    // file»: due caricamenti sulla stessa schermata sarebbero altrimenti
    // indistinguibili.
    expect(cv).toHaveAccessibleName(/Curriculum/)

    // ── 3 · E CHE SIA OBBLIGATORIO SI DEVE SENTIRE, NON SOLO VEDERE ──────────
    //
    // Dal 2026-08-24 il curriculum è OBBLIGATORIO, e chi ascolta lo deve sapere
    // PRIMA di premere «Avanti»: scoprirlo dopo vuol dire tornare indietro su una
    // schermata che si era già data per finita. L'obbligo viaggia
    // nell'ASTERISCO, che `FieldRenderer` stampa dentro la <label> esterna —
    // cioè dentro il nome accessibile, che è la somma delle due <label> che
    // puntano l'input.
    //
    // ⚠️ E ANCHE IN `aria-required` — il 2026-08-25 questo commento diceva il
    // CONTRARIO, e la riga qui sotto non esisteva. Sosteneva che l'assenza fosse
    // «una decisione, non una dimenticanza», perché metterlo sul solo curriculum
    // sarebbe stata «una seconda regola applicata a un campo su sei». L'obiezione
    // era giusta e la conclusione no: la risposta non era togliere il segnale al
    // curriculum, era darlo a tutti e sei. `FieldRenderer` ora lo emette nel ramo
    // GENERICO, una riga sola, e vale per ogni campo `required` di ogni modulo che
    // lo usa.
    //
    // La dottrina il repo ce l'aveva già scritta in DUE posti, e questo file la
    // contraddiceva: `Combobox.tsx` («l'asterisco è l'UNICA convenzione con cui
    // questa pagina dice "questo è obbligatorio"… `aria-required` è il secondo
    // segnale, quello che non dipende da un carattere dentro l'etichetta») e lo
    // stesso `FieldRenderer` nel ramo `consent` («l'obbligatorietà detta anche a
    // chi non vede l'asterisco»). Un asterisco è punteggiatura: chi ascolta lo
    // sente come «asterisco» o non lo sente affatto, e in nessun punto della
    // pagina c'è una legenda che dica che cosa significhi.
    //
    // ⚠️ `jest-axe` NON VEDE NÉ L'UNO NÉ L'ALTRO: un input senza `aria-required`
    // non è una violazione axe, ed è la stessa classe di difetto raccontata in
    // `FieldRenderer` per il `role="group"` di `gradi`. Perciò le due asserzioni
    // stanno qui, scritte a mano, e non sono coperte dallo `toHaveNoViolations`
    // più sotto.
    //
    // ⚠️ E SU QUESTO CAMPO L'ATTRIBUTO NON BASTA, misurato e non dedotto: Chromium
    // espone l'`<input type="file">` come `role=button`, e su quel ruolo lascia
    // cadere la proprietà `required` (letto con `Accessibility.getPartialAXTree`
    // il 25/08: sui `textbox` obbligatori arriva `required=true`, qui NIENTE).
    // L'asserzione qui sotto difende comunque una cosa vera — l'attributo nel DOM,
    // che altri motori possono leggere — ma chi cerca la garanzia per QUESTO campo
    // la trovi negli altri due punti: l'asterisco dentro il nome accessibile
    // (asserito sopra) e la nota agganciata (asserita sotto), che nell'albero AX
    // arriva come `description` ed è la frase che dice che senza allegato non si
    // invia.
    expect(cv, 'l’obbligo del curriculum non arriva a chi ascolta').toHaveAccessibleName(/Curriculum\s*\*/)
    expect(cv, 'l’obbligo non è dichiarato con `aria-required`').toHaveAttribute('aria-required', 'true')

    // E non su TUTTO: un campo facoltativo che lo portasse renderebbe il segnale
    // rumore. `titolo_dettaglio` sta nello stesso passo ed è `required: false`.
    expect(
      document.getElementById('titolo_dettaglio'),
      'un campo facoltativo si dichiara obbligatorio: «aria-required ovunque» non distingue niente',
    ).not.toHaveAttribute('aria-required')

    // ── 4 · E LA FRASE CHE SPIEGA L'OBBLIGO DEV'ESSERE AGGANCIATA AL CAMPO ────
    //
    // `candCvNota` — la chiave, non la frase: ricopiarla qui la farebbe invecchiare,
    // e infatti la citazione che stava su queste due righe descriveva una stesura
    // che la nota ha smesso di avere lo stesso giorno — era un `<p>` nudo, senza
    // `id`, reso dal wizard SOTTO il campo. Chi legge la pagina in sequenza la
    // incontra; chi la percorre campo per campo (modalità moduli degli screen
    // reader, che è il modo in cui un modulo si compila davvero) non la sentiva
    // MAI. È la sola frase che dice a chi non ha un PDF sottomano che può
    // fotografare il foglio invece di abbandonare: la metà che tiene aperta la
    // porta ai quattro su dieci che oggi non allegano (àncora `MISURA-CV`).
    //
    // Si asserisce la catena intera — l'`id` esiste, `aria-describedby` lo nomina,
    // e il nodo che porta quell'id contiene davvero il testo del catalogo —
    // perché ognuno dei tre anelli da solo sarebbe vero anche con la catena rotta.
    const descritto = cv!.getAttribute('aria-describedby') ?? ''
    const idNota = descritto.split(/\s+/).find((x) => x.endsWith('-nota'))
    expect(idNota, 'la nota del curriculum non è agganciata al campo').toBeTruthy()
    expect(document.getElementById(String(idNota))?.textContent).toBe(itPublic.candCvNota)
  })

  /*
   * LA PRIMA LOGICA CONDIZIONALE DI QUESTO MODULO, dal lato di chi ascolta.
   *
   * Spuntando «Altro (specifica qui sotto)» compare una casella di testo
   * OBBLIGATORIA che un istante prima non esisteva. È lo stato del passo «profilo»
   * che nessun controllo automatico attraversava — `jest-axe` più sotto lo
   * esegue col campo NON visibile — ed è quello in cui un campo può nascere senza
   * etichetta o senza il suo messaggio d'errore agganciato.
   */
  it('spuntando «Altro» il campo che compare ha la sua etichetta, e la schermata regge ad axe', async () => {
    mockSedi([GAMMA])
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())

    const condizionato = INSEGNANTE_FIELDS.find((f) => f.id === 'posizione_altro')
    expect(condizionato, '«posizione_altro» è sparito dal template').toBeDefined()
    // Prima della spunta non esiste: una domanda che non è stata fatta non ha un
    // campo da riempire.
    expect(document.getElementById('posizione_altro')).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: posizione('altro') }))

    await waitFor(() => expect(document.getElementById('posizione_altro')).not.toBeNull())
    expect(screen.getByLabelText(new RegExp(String(condizionato!.label)))).toBeInTheDocument()
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })


  /*
   * L'OBBLIGO DI UN GRUPPO È DEL GRUPPO, NON DI OGNI CASELLA.
   *
   * ⚠️ REGRESSIONE MISURATA IL 2026-08-25, nata da questo stesso lavoro. Per dare
   * `aria-required` al curriculum l'attributo è stato messo nell'oggetto CONDIVISO
   * `ariaProps` di `FieldRenderer` — una riga sola, «vale per tutti i campi». Vale
   * davvero per tutti, e per i gruppi è SBAGLIATO: `ariaProps` viene sparso su ogni
   * `<input>` del `map` delle opzioni, quindi tutte e SETTE le caselle di «Per quali
   * posizioni ti proponi» dichiaravano `aria-required="true"`. Su `role="checkbox"`
   * quell'attributo significa «questa casella va spuntata»: il modulo diceva a chi
   * ascolta che vanno spuntate tutte e sette, mentre ne basta UNA.
   *
   * Misurato in Chromium su /lavora-con-noi, passo «Il tuo profilo»:
   *   [...document.querySelectorAll('[role=group] input[type=checkbox]')]
   *     .map(c => c.getAttribute('aria-required'))   → ["true", …sette volte…]
   *
   * ⚠️ E IL RIMEDIO NON È SPOSTARLO SUL CONTENITORE. `aria-required` non è fra le
   * proprietà che ARIA 1.2 ammette su `role="group"` (lo sono su `radiogroup`,
   * `checkbox`, `textbox`, `combobox`, `listbox`, `spinbutton`, `gridcell`, `tree` —
   * non su `group`): metterlo lì scambierebbe un difetto semantico con una
   * violazione formale, e `jest-axe` la vedrebbe come `aria-allowed-attr`. Per il
   * gruppo a spunta l'obbligo continua ad arrivare per le due strade che ha sempre
   * avuto: l'ASTERISCO dentro il nome del gruppo (`aria-labelledby` punta la <label>
   * che lo stampa) e il messaggio d'errore agganciato con `aria-describedby`.
   *
   * ⚠️ `jest-axe` NON VEDE IL DIFETTO: `aria-required` su `role="checkbox"` è
   * consentito, quindi lo `toHaveNoViolations` più sotto resta verde con o senza.
   * Per questo l'asserzione è scritta a mano, ed è nei DUE versi — il gruppo non lo
   * porta (sarebbe una violazione), le caselle non lo portano (sarebbe una bugia) —
   * mentre il campo singolo accanto (`cv_path`) lo porta eccome: senza il terzo
   * verso, «toglierlo a tutti» passerebbe questo test.
   */
  it('l’obbligo del gruppo NON si ripete su ogni casella (e non finisce sul `role="group"`)', async () => {
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())

    const gruppo = screen.getByRole('group', { name: /Per quali posizioni ti proponi/ })
    const caselle = within(gruppo).getAllByRole('checkbox')
    expect(caselle).toHaveLength(POSIZIONI_OPTIONS.length)

    for (const casella of caselle) {
      expect(
        casella,
        'una casella del gruppo si dichiara obbligatoria: a chi ascolta il modulo chiede di spuntarle TUTTE, mentre ne basta una',
      ).not.toHaveAttribute('aria-required')
    }
    expect(
      gruppo,
      '`aria-required` su `role="group"` non è ammesso da ARIA: l’obbligo del gruppo viaggia nell’asterisco del suo nome',
    ).not.toHaveAttribute('aria-required')

    // L'obbligo del gruppo si sente lo stesso: sta nel NOME, che è la <label>
    // esterna con l'asterisco che `FieldRenderer` stampa quando `required`.
    expect(gruppo).toHaveAccessibleName(/Per quali posizioni ti proponi\s*\*/)

    // E il terzo verso, che impedisce di far passare questo test cancellando la
    // riga: sul campo SINGOLO accanto l'attributo ci deve ancora essere.
    expect(
      document.getElementById('cv_path'),
      'l’attributo è sparito anche dai campi a controllo singolo: il rimedio ha buttato via il segnale invece di metterlo al posto giusto',
    ).toHaveAttribute('aria-required', 'true')
  })

  /*
   * ALLEGATO IL CURRICULUM, IL CAMPO SMETTE DI DIRSI SBAGLIATO.
   *
   * ⚠️ MISURATO IN CHROMIUM il 2026-08-25 su /lavora-con-noi: premuto «Avanti»
   * senza allegato (il campo va in errore, come deve), e POI scelto il file. Il
   * riquadro mostrava il nome del file e l'icona verde, ma il campo restava
   * `aria-invalid="true"` con il suo `<p role="alert">Campo obbligatorio</p>` e il
   * bordo rosso. Chi ascolta ha appena risolto il problema e sente che il campo è
   * ancora sbagliato — sull'unico campo bloccante del passo.
   *
   * LA CAUSA è `mode: 'onTouched'`. Un campo mandato in errore dal `trigger()` di
   * `passoAvanti()` senza essere mai stato «toccato» non viene rivalidato al cambio
   * di valore: l'errore sopravvive al valore che lo risolve. Sui campi di TESTO il
   * caso si chiude da solo — il gesto naturale è tabulare via, e quel blur segna
   * «toccato» — ma sul campo file quel blur non arriva MAI: il selettore di file
   * del sistema non sfoca l'input, e il `preventDefault` sul comando primario
   * (`ComandiWizard`, nato in questo stesso lavoro contro il primo clic perduto)
   * toglie l'ultimo blur rimasto. Prima del 2026-08-24 il caso era IRRAGGIUNGIBILE:
   * `cv_path` era `required: false` e non produceva errori.
   *
   * IL RIMEDIO sta in `FileField.processaFile`: al successo si chiama `onBlur()`
   * subito dopo `onChange(path)`, così react-hook-form segna il campo come toccato
   * e rivalida sul valore appena scritto.
   */
  it('allegato il curriculum, il campo NON resta marcato non valido', async () => {
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'diploma' } })
    fireEvent.click(screen.getByRole('checkbox', { name: posizione('insegnante_nido') }))

    // 1 · Senza allegato il passo non avanza, e il campo si dichiara non valido.
    avanti()
    const cv = () => document.getElementById('cv_path') as HTMLInputElement
    await waitFor(() => expect(cv()).toHaveAttribute('aria-invalid', 'true'))

    // 2 · Ora si allega davvero.
    await allegaCurriculum()

    // 3 · …e il campo smette di dirsi sbagliato: niente `aria-invalid`, niente
    //     messaggio, e `aria-describedby` torna alla sola nota.
    await waitFor(() =>
      expect(
        cv(),
        'il curriculum è allegato ma il campo si dichiara ancora non valido: chi ascolta sente un errore su un problema appena risolto',
      ).not.toHaveAttribute('aria-invalid'),
    )
    expect(
      document.getElementById('cv_path-error'),
      'il messaggio «Campo obbligatorio» sopravvive al file che lo risolve',
    ).toBeNull()
    expect(cv().getAttribute('aria-describedby')).toBe('cv_path-nota')
  })

  /**
   * LA FINE DELL'ATTESA VA ANNUNCIATA, NON SOLO IL SUO INIZIO — WCAG 2.1 SC 4.1.3.
   *
   * ⚠️ IL DIFETTO, MISURATO PRIMA DEL RIMEDIO (giro 3, 2026-08-25). Dal 24/08 chi
   * preme «Avanti» mentre il curriculum sta salendo si sente dire «Attendi la fine
   * del caricamento.» — un ORDINE di aspettare, dentro un `role="alert"`. La fine
   * di quell'attesa non arrivava a nessuno: `FileField` la comunicava solo con i
   * pixel (`Loader2` → `FileCheck2`, e il testo dentro la `<label>`) più
   * `aria-busy` sull'`input`. `aria-busy` è una PROPRIETÀ dell'elemento, non un
   * messaggio di stato: nessuno screen reader ne garantisce l'annuncio, e il
   * cambio del nome accessibile di un controllo già a fuoco è comportamento non
   * specificato. Chi ascolta restava a ripremere «Avanti» a tentativi, sull'unico
   * campo che da oggi BLOCCA il passo.
   *
   * ⚠️ IL TESTO NON PUÒ VIVERE DENTRO LA `<label>`: quella compone il NOME
   * accessibile dell'`input`, e una regione viva là dentro annuncerebbe il nome
   * del campo, non un messaggio. La regione sta FRATELLA della label, `sr-only`.
   *
   * La dottrina esiste già in questo stesso wizard — `CandidaturaInsegnanteWizard`
   * avvolge l'altra rotellina della pagina in `role="status" aria-live="polite"`
   * col commento «un'attesa muta è indistinguibile da una pagina rotta per chi non
   * vede la rotellina». Il campo del curriculum era l'attesa muta rimasta.
   *
   * ⚠️ PERCHÉ `polite` E NON `assertive`: non è un errore, è un lavoro finito. Un
   * `assertive` interromperebbe la lettura del messaggio che l'utente sta
   * ascoltando in quel momento — cioè proprio `attendiCaricamento`.
   * ⚠️ LA CHIAVE E NON LA FRASE: qui c'era scritto «Attendi la fine del
   * caricamento.», testo che quella chiave ha smesso di avere il 25/08 (ora dice
   * anche COSA FARE, «aspetta un istante e riprova», perché il passo non avanza da
   * solo a caricamento finito). Un commento che ricopia una stringa del catalogo
   * invecchia dentro il commit successivo.
   */
  it('la fine del caricamento del curriculum è ANNUNCIATA, non solo dipinta', async () => {
    // Caricamento tenuto in volo a mano: è l'unico modo di guardare i due stati.
    let sbloccaCaricamento: (() => void) | null = null
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [GAMMA] }),
        })
      }
      if (url.includes('/api/iscrizione/insegnanti/upload')) {
        return new Promise((risolvi) => {
          sbloccaCaricamento = () =>
            risolvi({ ok: true, status: 200, json: async () => ({ path: PERCORSO_CV }) })
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(<CandidaturaInsegnanteWizard />)
    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())

    const controllo = document.getElementById('cv_path') as HTMLInputElement
    fireEvent.change(controllo, {
      target: { files: [new File(['%PDF-1.4 finto'], NOME_FILE_CV, { type: 'application/pdf' })] },
    })

    // La regione viva dev'essere NEL DOCUMENTO GIÀ ORA, non comparire alla fine:
    // un `aria-live` inserito insieme al suo contenuto non viene annunciato —
    // le tecnologie assistive osservano le MUTAZIONI di una regione che c'era.
    const regione = () =>
      document.querySelector('#cv_path-stato[role="status"][aria-live="polite"]')
    await waitFor(() =>
      expect(
        regione(),
        'nessuna regione viva accanto al campo: la fine del caricamento non la sente nessuno',
      ).not.toBeNull(),
    )

    // 1 · Mentre sale, la regione dice che sta salendo.
    // ⚠️ `caricamentoAllegato` E NON `caricamento`: questa riga confrontava la
    // chiave GENERICA («Caricamento…», quella delle pagine che si popolano) e
    // passava per COINCIDENZA, perché fino al 25/08/2026 le due voci italiane
    // erano la stessa stringa. In inglese erano già diverse — «Loading…» contro
    // «Uploading…» — e nessuno se n'era accorto. Chiusa la coincidenza in
    // italiano («Caricamento del file…»), questa riga è caduta: era un test che
    // asseriva sulla chiave sbagliata.
    await waitFor(() => expect(regione()?.textContent).toBe(itParentForms.caricamentoAllegato))

    // 2 · Finito, la regione CAMBIA e dice che l'allegato c'è. È questo cambio —
    //     non l'icona, non `aria-busy` — la sola cosa che uno screen reader legge
    //     senza che l'utente vada a cercarla.
    sbloccaCaricamento!()
    // Il nome vive in due `<span>` (troncamento centrale): si guarda il riquadro.
    await waitFor(() =>
      expect(controllo.closest('label')!.textContent).toContain(NOME_FILE_CV),
    )
    await waitFor(() =>
      expect(
        regione()?.textContent,
        'il caricamento è finito e la regione viva non lo dice: chi ascolta resta ad aspettare un segnale che non arriva',
      ).toBe(itParentForms.allegatoCaricato),
    )

    // 3 · …e la regione NON entra nel NOME accessibile del campo. È la ragione per
    //     cui sta fratella della `<label>` e non dentro: là dentro il controllo si
    //     chiamerebbe «Curriculum * cv-collaudo.pdf Allegato caricato», cioè il suo
    //     nome cambierebbe due volte mentre lo si usa (WCAG 2.5.3).
    //     ⚠️ Il nome contiene «cv-collaudo.pdf» ed è GIUSTO che lo contenga: quel
    //     testo sta nella `<label>` e dice quale file è allegato. La misura che
    //     conta è l'assenza del testo della REGIONE.
    expect(
      document.getElementById('cv_path'),
      'la regione viva è finita dentro il nome accessibile del campo',
    ).not.toHaveAccessibleName(new RegExp(itParentForms.allegatoCaricato))
    expect(
      document.getElementById('cv_path'),
      'il nome accessibile ha perso l’etichetta del campo',
    ).toHaveAccessibleName(/Curriculum\s*\*/)
  })

  /*
   * ── IL NOME DEL FILE ARRIVA INTERO A CHI ASCOLTA ───────────────────────────
   *
   * MISURATO in Chromium via CDP (`Accessibility.getPartialAXTree`) il
   * 2026-08-25, subito dopo aver introdotto il troncamento CENTRALE del nome: il
   * controllo si chiamava **«Curriculum * cv-di-pr ova.pdf»**. Il calcolo del
   * nome accessibile inserisce uno SPAZIO fra due elementi inline adiacenti, e il
   * troncamento centrale spezza il nome in due `<span>` (radice `truncate` +
   * coda `shrink-0`) proprio per poter accorciare solo la parte di mezzo.
   *
   * ⚠️ Un rimedio VISIVO che rompe l'albero AX è un difetto scambiato con un
   * altro, e qui pesa più del solito: Chromium espone un `<input type="file">`
   * come `role="button"`, dove il nome è tutto ciò che si ha — non c'è un valore
   * da leggere accanto. Il nome del file è la sola conferma che l'allegato è
   * quello giusto, su un campo che dal 24/08 decide se la candidatura parte.
   *
   * Il rimedio: le due metà VISIBILI sono `aria-hidden`, e una copia `sr-only`
   * porta il nome intero in un nodo di testo solo.
   */
  it('il nome del file arriva INTERO a chi ascolta, anche se a schermo è troncato al centro', async () => {
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'diploma' } })
    fireEvent.click(screen.getByRole('checkbox', { name: posizione('insegnante_nido') }))
    await allegaCurriculum()

    const riquadro = document.getElementById('cv_path')!.closest('label')!
    // La RIGA di contenuto, non tutto il riquadro: fuori di qui c'è anche la
    // parola «Sostituisci», che è `aria-hidden` per un'altra ragione (è
    // un'istruzione visiva, non parte del nome del campo).
    const riga = riquadro.querySelector('span[title]')!
    const meta = [...riga.querySelectorAll('[aria-hidden="true"]')]

    // ⚠️ NON SI MISURA `toHaveAccessibleName`, ED È IL PUNTO DI QUESTO TEST.
    // Provato per mutazione il 25/08/2026: rimesse le due metà nude, senza
    // `aria-hidden` e senza la copia `sr-only`, questo file resta VERDE — perché
    // `dom-accessibility-api` (che jsdom usa) concatena i due `<span>` SENZA lo
    // spazio che Chromium ci mette. Il difetto vive nel browser vero e in jsdom
    // non esiste: un'asserzione sul nome accessibile qui sarebbe un guardiano che
    // parla e non guarda.
    // Si misura quindi la STRUTTURA che produce il nome giusto, che è ciò che
    // jsdom sa davvero vedere — e che va rossa sulla stessa mutazione.
    const perChiAscolta = riga.querySelector('.sr-only')
    expect(
      perChiAscolta?.textContent,
      'il nome intero non arriva più in un nodo solo: nel browser vero si spezza a metà',
    ).toBe(NOME_FILE_CV)
    expect(meta.length, 'le metà VISIBILI del nome non sono più nascoste all’albero AX').toBe(2)
    expect(meta.map((e) => e.textContent).join(''), 'le due metà non ricompongono il nome').toBe(NOME_FILE_CV)
  })

  it('il campo in errore è marcato `aria-invalid` e collegato al proprio messaggio', async () => {
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    avanti()

    await waitFor(() =>
      expect(screen.getByPlaceholderText('Es. Maria')).toHaveAttribute('aria-invalid', 'true'),
    )
    const descritto = screen.getByPlaceholderText('Es. Maria').getAttribute('aria-describedby')
    expect(descritto).toBe('nome-error')
    expect(document.getElementById(String(descritto))?.textContent).toContain(itParentForms.campoObbligatorio)
  })
})

describe('a11y · /lavora-con-noi — jest-axe su ogni schermata', () => {
  it('attesa dell’elenco sedi', async () => {
    let sblocca: (() => void) | null = null
    const attesa = new Promise<void>((r) => {
      sblocca = r
    })
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return attesa.then(() => ({ ok: true, status: 200, json: async () => ({ success: true, data: [GAMMA] }) }))
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())

    expect(await axe(container, axeOpts)).toHaveNoViolations()
    sblocca!()
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  })

  it('elenco sedi non ottenuto (il pannello con «Riprova»)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return Promise.resolve({ ok: false, status: 429, json: async () => ({ error: 'no' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByText(itPublic.candSediErroreTitolo)).toBeInTheDocument())

    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('nessuna sede disponibile (il pannello senza «Riprova»)', async () => {
    mockSedi([])
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByText(itPublic.candSediVuoteTitolo)).toBeInTheDocument())

    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('i quattro passi compilabili, uno per uno, più il riepilogo e la conferma', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [ALFA, BETA, GAMMA] }),
        })
      }
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
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'c-1' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    const { container } = render(<CandidaturaInsegnanteWizard />)

    // 1 · sede
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_B }))
    avanti()

    // 2 · dati
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
    await passoDati()

    // 3 · profilo
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
    await passoProfilo()

    // 4 · consensi
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    expect(await axe(container, axeOpts)).toHaveNoViolations()
    await passoConsensi()

    // 5 · riepilogo
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    // 6 · conferma
    await waitFor(() => expect(screen.getByText(itPublic.candInviata)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('il pannello d’errore d’invio', async () => {
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
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: 'no', codice: 'CANDIDATURA_NON_INVIATA' }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    const { container } = render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)

    await passoDati()
    await passoProfilo()
    await passoConsensi()
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    await waitFor(() => expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })
})
