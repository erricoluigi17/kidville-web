import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import itPublic from '../../messages/it/public.json'
import itShared from '../../messages/it/shared.json'
import { CONSENSI_PERSONALE_FIELDS } from '@/lib/forms/personale-template'
import {
  ALFA, OGGI, avanti, caricaScansione, compilaFinoAlRiepilogo, passoDati, passoDocumento,
  passoResidenza, passoSede, reteFinta,
} from '../fixtures/anagrafica-personale'

/**
 * `/anagrafica-personale` — L'ACCESSIBILITÀ, UN PASSO PER VOLTA.
 *
 * ─── PERCHÉ OGNI PASSO, E NON UN «passa axe» SULLA PRIMA SCHERMATA ──────────
 *
 * Perché è un passo per volta che si vede: un controllo sul solo primo pannello
 * lascerebbe fuori proprio il documento — quello con la data mascherata, il
 * caricamento del file e il riquadro della scadenza — e i consensi, che sono la
 * schermata con più testo e più caselle. Sul modulo fratello la catena di ternari
 * dei titoli non aveva il ramo dei consensi e cadeva su quello finale: la
 * schermata su cui si presta la presa visione si annunciava col titolo della
 * pagina successiva, e nessuna sonda automatica poteva vederlo.
 *
 * ─── LE COSE CHE `jest-axe` NON PUÒ VEDERE, E CHE QUI SI ASSERISCONO ────────
 *
 *  1. **un solo `<h1>`**, in OGNI stato, compresi i due in cui il modulo non
 *     comincia (sono quelli che sostituiscono l'intero corpo della pagina);
 *  2. **il titolo di ogni passo è un `h2`** e dice il nome di QUEL passo;
 *  3. **`fieldset`/`legend` sulla sede**: tre radio senza un gruppo dichiarato si
 *     annunciano come tre domande separate, e chi ascolta sente «Kidville
 *     Aversa, pulsante di opzione» senza sapere che cosa stia scegliendo;
 *  4. **il fuoco va sul primo campo non valido**: senza, chi usa la tastiera
 *     preme «Avanti», non succede niente di percepibile, e l'errore resta in un
 *     punto della pagina che non ha modo di trovare;
 *  5. **nessun `aria-describedby` punta al vuoto**, in nessun passo. È il difetto
 *     che il badge del codice fiscale e il riquadro della scadenza rendono facile:
 *     entrambi spariscono quando non hanno niente da dire, e un riferimento
 *     rimasto li segue verso il nulla in silenzio;
 *  6. **ogni gruppo di scelta ha un NOME.** MISURATO il 12/08/2026 al passo «I
 *     tuoi dati»: il `<div role="group">` delle tre caselle «Fasce d'età su cui
 *     lavori» — campo obbligatorio, e quello che decide quali funzioni la persona
 *     vedrà nell'app — aveva `aria-label: null` e `aria-labelledby: null`, mentre
 *     la sua etichetta visibile era una `<label>` senza `for` e senza controllo
 *     annidato, cioè legata a niente. Chi ascolta sentiva «Nido (0-3), casella di
 *     controllo» senza aver mai sentito la domanda. `jest-axe` NON lo vede — un
 *     `role="group"` senza nome non è una violazione axe — ed è la ragione per cui
 *     i controlli automatici di questo stesso file passavano lo stesso.
 */

expect.extend(toHaveNoViolations)

/**
 * Le regole a livello di DOCUMENTO non si applicano a un componente isolato in
 * jsdom, e `color-contrast` non è calcolabile senza layout (ha il suo lock
 * dedicato, `__tests__/a11y/contrasto-cascata.test.tsx`). Stesso insieme degli
 * altri file a11y di questo repo, così due file non divergono sulla stessa
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

import { AnagraficaPersonaleWizard } from '@/components/features/public/AnagraficaPersonaleWizard'

function monta(rete = reteFinta()) {
  vi.stubGlobal('fetch', rete.fetch)
  return render(<AnagraficaPersonaleWizard oggi={OGGI} />)
}

/**
 * I gruppi di scelta SENZA nome accessibile, descritti in modo leggibile.
 *
 * Il nome può arrivare da tre parti, e si guardano tutte e tre: `aria-label`,
 * `aria-labelledby` (che deve puntare a testo VERO, non a un nodo vuoto) e —
 * per un `<fieldset>` — la sua `<legend>`.
 */
function gruppiSenzaNome(): string[] {
  const senza: string[] = []
  const gruppi = Array.from(
    document.querySelectorAll('[role="group"], [role="radiogroup"], fieldset'),
  )
  for (const g of gruppi) {
    const etichetta = (g.getAttribute('aria-label') ?? '').trim()
    const da = (g.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => (document.getElementById(id)?.textContent ?? '').trim())
      .join(' ')
      .trim()
    const legenda =
      g.tagName.toLowerCase() === 'fieldset'
        ? (g.querySelector('legend')?.textContent ?? '').trim()
        : ''
    if (etichetta === '' && da === '' && legenda === '') {
      senza.push(`${g.tagName.toLowerCase()}[role=${g.getAttribute('role') ?? '—'}]`)
    }
  }
  return senza
}

/** Ogni `aria-describedby` della pagina punta a un elemento che ESISTE. */
function riferimentiInteri(): string[] {
  const rotti: string[] = []
  for (const nodo of Array.from(document.querySelectorAll('[aria-describedby]'))) {
    for (const id of (nodo.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
      if (document.getElementById(id) === null) {
        rotti.push(`${nodo.tagName.toLowerCase()}#${nodo.id || '(senza id)'} → «${id}»`)
      }
    }
  }
  return rotti
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('a11y · /anagrafica-personale — struttura e annunci', () => {
  it('c’è UN SOLO `h1`, ed è il titolo della pagina', async () => {
    monta()
    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))

    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1).toHaveLength(1)
    // L'icona è decorativa (`aria-hidden`): il nome dell'`h1` resta il titolo.
    expect(h1[0]).toHaveAccessibleName(itPublic.persTitolo)
  })

  it('l’`h1` resta uno solo anche nei due stati in cui il modulo non comincia', async () => {
    // Sono i rami che sostituiscono l'intero corpo della pagina: è lì che è più
    // facile perdere l'intestazione.
    for (const sedi of [
      [{ tipo: 'ok' as const, sedi: [] }],
      [{ tipo: 'http' as const, stato: 429 }],
    ]) {
      const { unmount } = monta(reteFinta({ sedi }))
      await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1))
      unmount()
      vi.unstubAllGlobals()
    }
  })

  it('il titolo di OGNI passo è un `h2` e dice il nome di QUEL passo', async () => {
    monta()
    const titoloDelPasso = () =>
      screen.getAllByRole('heading', { level: 2 }).map((n) => n.textContent)

    await passoSede(ALFA.id)
    await waitFor(() => expect(titoloDelPasso()).toContain(itPublic.persDati))
    await passoDati()
    await waitFor(() => expect(titoloDelPasso()).toContain(itPublic.persResidenza))
    await passoResidenza()
    await waitFor(() => expect(titoloDelPasso()).toContain(itPublic.persDocumento))
    await passoDocumento()
    // ⚠️ Il ramo dei consensi: sul modulo fratello mancava, e questa schermata si
    // annunciava «Riepilogo».
    await waitFor(() => expect(titoloDelPasso()).toContain(itPublic.persConsensiTitolo))
  })

  it('la scelta della sede è un gruppo dichiarato, con la sua `legend`', async () => {
    monta()
    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))

    const gruppo = screen.getByRole('group', { name: itPublic.persSedeLegenda })
    expect(gruppo.tagName.toLowerCase()).toBe('fieldset')
    // La `legend` è `sr-only`: a schermo il titolo del passo dice già la stessa
    // cosa, e ripeterla sarebbe rumore per chi guarda.
    expect(gruppo).toContainElement(screen.getAllByRole('radio')[0] as HTMLElement)
  })

  it('«Avanti» a vuoto porta il fuoco sul PRIMO campo non valido', async () => {
    monta()
    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    avanti()

    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText('Es. Maria')))
  })
})

describe('a11y · /anagrafica-personale — ogni gruppo di scelta ha un nome', () => {
  it('⚠️ «Fasce d’età su cui lavori» è il NOME del gruppo, non una didascalia orfana', async () => {
    monta()
    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    // Se il gruppo non avesse nome, questa ricerca per RUOLO + NOME non
    // troverebbe niente: è la stessa strada che percorre uno screen reader.
    const gruppo = screen.getByRole('group', { name: /Fasce d’età su cui lavori/ })
    expect(gruppo).toContainElement(screen.getByRole('checkbox', { name: 'Infanzia (3-6)' }))
  })

  it('in ogni passo, NESSUN gruppo resta senza nome', async () => {
    monta()

    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))
    expect(gruppiSenzaNome(), 'passo: sede').toEqual([])

    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(gruppiSenzaNome(), 'passo: dati').toEqual([])

    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/^Indirizzo di residenza/)).toBeInTheDocument())
    expect(gruppiSenzaNome(), 'passo: residenza').toEqual([])

    await passoResidenza()
    await waitFor(() => expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument())
    expect(gruppiSenzaNome(), 'passo: documento').toEqual([])

    await passoDocumento()
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    expect(gruppiSenzaNome(), 'passo: consensi').toEqual([])
  })
})

/**
 * I controlli la cui etichetta porta l'ASTERISCO e che non dichiarano
 * `aria-required`: l'obbligo detto a chi guarda e taciuto a chi ascolta.
 *
 * ⚠️ L'ELENCO SI DERIVA DAL DOCUMENTO, NON SI SCRIVE. Un elenco di `id` scritto a
 * mano copre i campi che c'erano il giorno in cui è stato scritto: è esattamente
 * il modo in cui, il 25/08/2026, `aria-required` è arrivato su tutti i campi resi
 * da `FieldRenderer` e su NESSUNO dei due resi a mano in questo modulo (il codice
 * fiscale e la scadenza del documento) — dieci asterischi e otto dichiarazioni al
 * passo «I tuoi dati», cinque e quattro al passo «Documento». Qui la premessa è
 * l'asterisco che una persona VEDE, e la conseguenza è la proprietà che una
 * persona SENTE: il prossimo campo scritto a mano cade da solo.
 *
 * ⚠️ L'ECCEZIONE È UNA SOLA, ED È DICHIARATA: `role="group"` (le «Fasce d'età»).
 * ARIA 1.2 non ammette `aria-required` su quel ruolo, e l'obbligo di un gruppo
 * «almeno uno di N» non è dei suoi controlli — se lo portassero tutti direbbero
 * che vanno spuntati tutti. Il gruppo si riconosce dal fatto che è LUI a essere
 * nominato dall'etichetta (`aria-labelledby`), quindi non serve nominarlo qui.
 *
 * ⚠️ E UN'ETICHETTA COL GLIFO CHE NON PORTA A NESSUN CONTROLLO viene riportata
 * come mancanza, non saltata: sarebbe il modo silenzioso in cui questa sonda
 * smetterebbe di misurare.
 */
function obbligatoriSoloAVista(): string[] {
  const mancanti: string[] = []
  for (const label of [...document.querySelectorAll('label')]) {
    const haGlifo = [...label.querySelectorAll('span')].some(
      (s) => s.children.length === 0 && s.textContent?.trim() === '*',
    )
    if (!haGlifo) continue

    const per = label.getAttribute('for')
    const bersaglio: Element | null =
      (per ? document.getElementById(per) : null) ??
      label.querySelector('input, select, textarea') ??
      (label.id ? document.querySelector(`[aria-labelledby~="${label.id}"]`) : null)

    const nome = (label.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (bersaglio === null) {
      mancanti.push(`«${nome}»: etichetta con asterisco legata a nessun controllo`)
      continue
    }
    const ruolo = bersaglio.getAttribute('role')
    if (ruolo === 'group' || ruolo === 'radiogroup') continue
    if (bersaglio.getAttribute('aria-required') !== 'true') {
      mancanti.push(`«${nome}» → #${bersaglio.id || '(senza id)'}`)
    }
  }
  return mancanti
}

describe('a11y · /anagrafica-personale — l’obbligo si sente, non solo si vede', () => {
  it('in ogni passo, ogni etichetta con l’asterisco porta a un controllo che lo dichiara', async () => {
    monta()

    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))
    expect(obbligatoriSoloAVista(), 'passo: sede').toEqual([])

    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(obbligatoriSoloAVista(), 'passo: dati').toEqual([])

    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/^Indirizzo di residenza/)).toBeInTheDocument())
    expect(obbligatoriSoloAVista(), 'passo: residenza').toEqual([])

    await passoResidenza()
    await waitFor(() => expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument())
    expect(obbligatoriSoloAVista(), 'passo: documento').toEqual([])

    await passoDocumento()
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    expect(obbligatoriSoloAVista(), 'passo: consensi').toEqual([])
  })

  /**
   * IL CONTROLLO POSITIVO — senza, la sonda qui sopra sarebbe vera a vuoto il
   * giorno in cui gli asterischi sparissero dal modulo.
   */
  it('gli asterischi ci sono davvero, e sono più di uno', async () => {
    monta()
    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    const conGlifo = [...document.querySelectorAll('label')].filter((l) =>
      [...l.querySelectorAll('span')].some(
        (s) => s.children.length === 0 && s.textContent?.trim() === '*',
      ),
    )
    expect(conGlifo.length, 'nessun asterisco: la sonda non sta più misurando niente').toBeGreaterThan(1)
  })

  /**
   * E NON SU TUTTO: un campo facoltativo che si dichiarasse obbligatorio
   * renderebbe il segnale rumore. `titolo_dettaglio` sta nello stesso passo del
   * codice fiscale ed è `required: false` nel template.
   */
  it('un campo facoltativo NON si dichiara obbligatorio', async () => {
    monta()
    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(
      document.getElementById('titolo_dettaglio'),
      'un campo facoltativo si dichiara obbligatorio: «aria-required ovunque» non distingue niente',
    ).not.toHaveAttribute('aria-required')
  })
})

describe('a11y · /anagrafica-personale — il consenso si annuncia col TITOLO', () => {
  /**
   * ⚠️ IL DIFETTO, MISURATO IL 12/08/2026 SULLA PAGINA VIVA.
   *
   * Al passo «Informativa e dichiarazioni», `label.textContent` sulle tre
   * caselle dava **564 · 292 · 379 caratteri**: la `<label>` avvolgeva titolo E
   * corpo dell'informativa, quindi tutto quel testo era il NOME ACCESSIBILE del
   * controllo, non una descrizione. `aria-describedby` era `null` su tutte e
   * tre, `id` vuoto su tutte e tre, e il titolo compariva DUE volte nel nome
   * («Ho letto l'informativa sulla privacy *Dichiaro di aver preso visione
   * dell'informativa sul…»).
   *
   * Chi usa uno screen reader, arrivando sulla casella, si sentiva leggere
   * l'informativa intera al posto di «Ho letto l'informativa sulla privacy,
   * casella di controllo, obbligatorio». Il nome è ciò che serve a DECIDERE, e
   * qui si decide su un consenso: è la parte del modulo dove la volontà deve
   * essere inequivocabile.
   *
   * La stessa misura sulla MIRA: la `<label>` era 328×373 / 328×211 / 328×279 px
   * contro una casella di 16×16 — fino a **477 volte** l'area del controllo — e
   * tutto cliccabile. Provare a selezionare una riga dell'informativa per
   * rileggerla SPUNTAVA il consenso.
   *
   * `jest-axe` non lo vede: un nome accessibile lunghissimo non è una
   * violazione axe, ed è la ragione per cui i 24 controlli automatici di questo
   * file passavano lo stesso.
   *
   * Il rimedio sta in `FieldRenderer` (componente CONDIVISO: valeva identico su
   * `/iscrizione` e `/lavora-con-noi`), e ha il suo lock lì — §4bis di
   * `__tests__/components/FieldRenderer-stati-visivi.test.tsx`. Qui si misura
   * dove il difetto è stato visto: sui tre consensi VERI di questo modulo.
   */
  async function aiConsensi(): Promise<void> {
    monta()
    await passoSede(ALFA.id)
    await passoDati()
    await passoResidenza()
    await passoDocumento()
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
  }

  /** Le tre caselle nell'ordine del template: la prova segue il contratto. */
  const caselle = () =>
    CONSENSI_PERSONALE_FIELDS.map((f) => ({
      campo: f,
      spunta: screen.getByRole('checkbox', { name: new RegExp(f.label.slice(0, 24), 'i') }),
    }))

  it('⚠️ il nome della casella è il titolo, non i 564 caratteri dell’informativa', async () => {
    await aiConsensi()

    for (const { campo, spunta } of caselle()) {
      const nome = (spunta.closest('label')?.textContent ?? '').trim()
      expect(nome, `consenso «${campo.id}»`).toContain(campo.label)
      // 564 · 292 · 379 erano le misure del difetto. Il più lungo dei tre titoli
      // ne fa 68, più l'asterisco: il tetto sta in mezzo e non è negoziabile.
      expect(nome.length, `nome accessibile di «${campo.id}» ancora lungo ${nome.length}`)
        .toBeLessThan(90)
      // ⚠️ Si guarda la CODA del corpo, non la testa: il terzo consenso comincia
      // con le stesse parole del suo titolo («Ho letto perché mi viene chiesta la
      // copia del documento…»), e una sonda sul prefisso direbbe «il corpo è
      // dentro il nome» anche a difetto chiuso. La coda no: quelle parole nel
      // titolo non ci sono mai state.
      expect(nome, `il corpo di «${campo.id}» è tornato dentro il nome`)
        .not.toContain(campo.text!.slice(-40))
    }
  })

  it('⚠️ il corpo è una DESCRIZIONE agganciata, e l’obbligatorietà è detta', async () => {
    await aiConsensi()

    for (const { campo, spunta } of caselle()) {
      const rif = spunta.getAttribute('aria-describedby')
      expect(rif, `«${campo.id}» non descrive niente`).toBeTruthy()
      const bersagli = rif!.split(/\s+/).map((id) => document.getElementById(id))
      expect(bersagli.every(Boolean), `«${campo.id}»: descrizione nel vuoto`).toBe(true)
      expect(bersagli.map((n) => n!.textContent).join(' ')).toContain(campo.text!.slice(0, 40))
      // Tutte e tre sono obbligatorie: l'asterisco è un segnale che si vede, e
      // questo è quello che si sente.
      expect(spunta, `«${campo.id}»`).toHaveAttribute('aria-required', 'true')
    }
  })

  it('⚠️ leggere l’informativa non la firma: il corpo non è più un bersaglio', async () => {
    await aiConsensi()

    for (const { campo } of caselle()) {
      const corpo = screen.getByText(campo.text!, { exact: false })
      expect(corpo.closest('label'), `«${campo.id}»: il corpo spunta ancora la casella`).toBeNull()
    }
    // Controllo POSITIVO: il titolo, invece, spunta — la label è ancora la label.
    const primo = CONSENSI_PERSONALE_FIELDS[0]
    fireEvent.click(screen.getByText(primo.label))
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeChecked(),
    )
  })
})

describe('a11y · /anagrafica-personale — due tendine, due nomi', () => {
  it('⚠️ i comandi che aprono le due tendine NON si chiamano allo stesso modo', async () => {
    // MISURATO il 12/08/2026 al passo «I tuoi dati»: due `button` con lo stesso
    // identico nome accessibile, «Mostra o nascondi l'elenco», uno sotto
    // l'altro. Sono i due controlli che producono il codice catastale — cioè la
    // cosa che rende verificabile il codice fiscale — e il secondo è
    // DISABILITATO finché il primo non è stato scelto: due comandi
    // indistinguibili in fila, di cui uno spento per una ragione che il nome non
    // spiega, sono un vicolo cieco per chi non vede quale dei due sta toccando.
    // `axe` non lo vede: la regola sui nomi ripetuti copre i link, non i bottoni.
    monta()
    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    const nomi = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.trim() || b.getAttribute('aria-label') || '')
      .filter((n) => n.startsWith('Mostra o nascondi'))
    expect(nomi, 'le due tendine del luogo di nascita').toHaveLength(2)
    expect(new Set(nomi).size, `nomi ripetuti: ${nomi.join(' · ')}`).toBe(2)

    // E il nome dice QUALE elenco apre: «…delle province», «…dei comuni».
    expect(screen.getByRole('button', { name: itShared.anagCommutaElencoProvince })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itShared.anagCommutaElencoComuni })).toBeInTheDocument()
  })
})

describe('a11y · /anagrafica-personale — il rosso si spegne mentre si corregge', () => {
  /**
   * ⚠️ IL DIFETTO: dopo un «Avanti» fallito, correggere un campo NON spegneva il
   * suo rosso finché non se ne usciva.
   *
   * MISURATO il 12/08/2026 con interazione vera (clic del mouse e digitazione):
   * `#cognome` con dentro «Rossini» restava `aria-invalid="true"`, bordo
   * `rgb(229,57,53)` e «Campo obbligatorio» sotto, col cursore ANCORA dentro il
   * campo; solo il `blur` li spegneva. Sul menu `#gender` era peggio, perché lì
   * non c'è niente da digitare: si sceglie «Femmina» e il rosso resta lì.
   * Al primo «Avanti» a modulo vuoto i messaggi accesi sono NOVE sul solo passo
   * «I tuoi dati»: si smontano uno per uno davanti a un modulo che non risponde,
   * e `aria-invalid="true"` sopravvissuto alla correzione fa annunciare «non
   * valido» un campo appena sistemato.
   *
   * La causa: il modulo non usa `handleSubmit`, quindi `isSubmitted` resta
   * `false`, e in `mode: 'onTouched'` react-hook-form salta la rivalidazione su
   * `change` finché il campo non ha avuto un `blur`.
   */
  it('un campo di TESTO corretto smette di dirsi vuoto senza aspettare il blur', async () => {
    monta()
    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    avanti()
    const cognome = screen.getByPlaceholderText('Es. Rossi')
    await waitFor(() => expect(cognome).toHaveAttribute('aria-invalid', 'true'))

    // Si scrive e basta: nessun `blur`, nessun secondo «Avanti».
    fireEvent.change(cognome, { target: { value: 'Esempio' } })

    await waitFor(() => expect(cognome).not.toHaveAttribute('aria-invalid'))
    expect(cognome.className).not.toContain('border-kidville-error')
  })

  it('…e vale anche per il MENU, dove non c’è niente da digitare', async () => {
    monta()
    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    avanti()
    const sesso = screen.getByLabelText(/^Sesso/)
    await waitFor(() => expect(sesso).toHaveAttribute('aria-invalid', 'true'))

    fireEvent.change(sesso, { target: { value: 'F' } })

    await waitFor(() => expect(sesso).not.toHaveAttribute('aria-invalid'))
  })
})

describe('a11y · /anagrafica-personale — nessun riferimento nel vuoto', () => {
  it('in ogni passo, ogni `aria-describedby` punta a qualcosa che esiste', async () => {
    monta()

    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))
    expect(riferimentiInteri(), 'passo: sede').toEqual([])

    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(riferimentiInteri(), 'passo: dati (campi vuoti, badge muto)').toEqual([])

    // …e anche con gli errori accesi, che è quando i descrittori si moltiplicano.
    avanti()
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(riferimentiInteri(), 'passo: dati in errore').toEqual([])

    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/^Indirizzo di residenza/)).toBeInTheDocument())
    expect(riferimentiInteri(), 'passo: residenza').toEqual([])

    await passoResidenza()
    await waitFor(() => expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument())
    expect(riferimentiInteri(), 'passo: documento (nessun avviso di scadenza)').toEqual([])

    fireEvent.change(screen.getByLabelText(/^Scadenza del documento/), { target: { value: '01/01/2020' } })
    // Un frammento, non la chiave grezza: `persDocScaduto` porta `{data}`.
    await waitFor(() =>
      expect(screen.getByText(/Questo documento risulta scaduto il /)).toBeInTheDocument(),
    )
    expect(riferimentiInteri(), 'passo: documento (avviso acceso)').toEqual([])
  })
})

describe('a11y · /anagrafica-personale — il comando che invia non perde il fuoco', () => {
  /**
   * ⚠️ IL DIFETTO, e il rimedio era già scritto in questo repo.
   *
   * Mentre l'invio è in volo il comando primario si metteva `disabled`, e Chrome
   * sfila il fuoco da un elemento che si disabilita: MISURATO col fuoco sul
   * bottone «INVIA L'ANAGRAFICA», clic, risposta ritardata di 2200 ms →
   * `document.activeElement === document.body`, e ci restava anche dopo il
   * rifiuto 503. Chi naviga da tastiera preme «Invia», il fuoco cade all'inizio
   * del documento, e per sapere se è successo qualcosa deve ritabulare l'intero
   * riepilogo — 5 «MODIFICA» e 33 righe.
   *
   * `src/components/ui/Btn.tsx` lo dice a parole da agosto: «`disabled` NON è il
   * modo di dire "sto lavorando"… per quel caso si usa `aria-disabled` più una
   * guardia nel gestore». Il guscio dei wizard non passa da `Btn` e non l'aveva
   * ereditato; il lock `btn-disabilitato-leggibile` legge solo `Btn`.
   *
   * Nello stesso gesto si misurava anche il secondo difetto: `disabled:opacity-50`
   * portava «INVIO…» — l'unico segnale visivo che il gesto sia partito — da un
   * nominale 4,78:1 a un **reale 2,02:1** una volta composto sul crema.
   */
  it('in volo: `aria-disabled`, non `disabled` — e il fuoco resta dov’era', async () => {
    const rete = reteFinta()
    let sblocca: () => void = () => {}
    const inVolo = new Promise<void>((r) => {
      sblocca = r
    })
    const lenta = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      // ⚠️ `/upload` è anch'esso un POST sotto lo stesso prefisso: senza questa
      // esclusione la scansione resterebbe appesa alla promessa dell'invio, e il
      // modulo non arriverebbe mai al riepilogo.
      const url = String(input)
      if (url.includes('/api/iscrizione/personale') && !url.includes('/upload') && init?.method === 'POST') {
        return inVolo.then(() => ({
          ok: false,
          status: 503,
          headers: { get: () => 'application/json' },
          json: async () => ({ error: 'no' }),
        }))
      }
      return rete.fetch(input, init)
    })
    vi.stubGlobal('fetch', lenta)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)
    await compilaFinoAlRiepilogo({ sede: ALFA.id })

    const bottone = screen.getByRole('button', { name: itPublic.persInvia })
    bottone.focus()
    expect(document.activeElement).toBe(bottone)

    fireEvent.click(bottone)

    // In volo: il comando dice che sta lavorando, e NON si spegne.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: itPublic.persInvioInCorso })).toBeInTheDocument(),
    )
    const inCorso = screen.getByRole('button', { name: itPublic.persInvioInCorso })
    expect(inCorso).not.toBeDisabled()
    expect(inCorso).toHaveAttribute('aria-disabled', 'true')
    expect(inCorso).toHaveAttribute('aria-busy', 'true')
    expect(document.activeElement).toBe(inCorso)
    // …e resta LEGGIBILE: verde pieno e inchiostro pieno, nessuna alfa addosso.
    expect(inCorso.className).toContain('bg-kidville-green')
    expect(inCorso.className).toContain('text-kidville-yellow-ink')
    expect(inCorso.className).not.toMatch(/opacity-\d/)

    sblocca()

    // Dopo il rifiuto il pannello parla, e il fuoco è ancora sul comando: chi ha
    // premuto sa di aver premuto.
    await waitFor(() =>
      expect(screen.getByText(itPublic.persErroreInvioTitolo)).toBeInTheDocument(),
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: itPublic.persInvia }))
  })

  it('lo stato spento si DIPINGE: niente `opacity`, nemmeno su «Avanti» senza sedi', async () => {
    // L'altro stato spento reale della pagina, e ci si arriva solo così: il
    // server rifiuta la sede al momento dell'invio, il modulo torna al passo
    // «sede» — con dentro tutto ciò che è stato compilato — e l'elenco che si sta
    // ricaricando non arriva. Lì «Avanti» non porta da nessuna parte, e
    // `disabled` è giusto (il comando è davvero inerte, e il fuoco è già stato
    // portato sul pannello che spiega cos'è successo). Ma `opacity-50` lo
    // portava a **2,02:1**: l'unica cosa che spiega perché non si può proseguire,
    // illeggibile.
    const rete = reteFinta({
      sedi: [{ tipo: 'ok', sedi: [ALFA] }, { tipo: 'http', stato: 429 }],
      invii: [
        {
          tipo: 'http',
          stato: 400,
          corpo: { error: 'Indicare la sede in cui si lavora.', codice: 'SEDE_DA_SPECIFICARE' },
        },
      ],
    })
    vi.stubGlobal('fetch', rete.fetch)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)
    await compilaFinoAlRiepilogo({ sede: ALFA.id })
    fireEvent.click(screen.getByRole('button', { name: itPublic.persInvia }))
    await waitFor(() => expect(screen.getByText(itPublic.persSedeRifiutataCorpo)).toBeInTheDocument())

    const avantiSpento = screen.getByRole('button', { name: itPublic.persAvanti })
    expect(avantiSpento).toBeDisabled()
    expect(avantiSpento).toHaveAttribute('aria-disabled', 'true')
    expect(avantiSpento.className).not.toMatch(/opacity-\d/)
    // La coppia è quella di `Btn`: `sub` #55615C su `neutral-soft` #F0F2F1 =
    // 5,75:1, col contorno `neutral` che dice ancora dove comincia il comando.
    expect(avantiSpento.className).toContain('bg-kidville-neutral-soft')
    expect(avantiSpento.className).toContain('text-kidville-sub')
    expect(avantiSpento.className).toContain('border-kidville-neutral')
  })
})

describe('a11y · /anagrafica-personale — la prosa ha un tetto di larghezza', () => {
  /**
   * ⚠️ MISURATE con un `Range` sui nodi di testo, carattere per carattere, il
   * 12/08/2026 — non in unità `ch`, che è la larghezza dello ZERO e dichiara un
   * numero mentre ne produce un altro:
   *   · riquadro «Come funziona»: 96 · 101 · 98 a 640 px, 106 · 101 · 104 da 768
   *     a 1023 (a 1024 diventa una colonna da 256 px e rientra da sé);
   *   · «Rileggi il codice fiscale e la scadenza…»: 106 a 1440;
   *   · «Premi «Invia l'anagrafica» per trasmettere…»: 114 a 1440.
   * Sono righe da 12 px: a un centinaio di caratteri l'occhio perde il capo
   * della riga successiva. E non sono testi decorativi — dicono che il modulo non
   * crea nessun accesso, per quanto tempo si conserva la copia del documento
   * d'identità e che cosa succede premendo «Invia».
   * 26rem = 416 px = 75 caratteri: la misura è quella già fatta su questa stessa
   * pagina per il banner «Ti serve il documento d'identità» (384 → 70 · 400 → 70
   * · **416 → 75** · 432 → 78).
   */
  it('le voci di «Come funziona» e le due righe di chiusura del riepilogo', async () => {
    monta()
    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))

    for (const voce of [
      itPublic.persContestoApprovazione,
      itPublic.persContestoDocumento,
      itPublic.persContestoScadenza,
    ]) {
      expect(screen.getByText(voce).className, voce.slice(0, 30)).toContain('max-w-[26rem]')
    }

    await passoSede(ALFA.id)
    await passoDati()
    await passoResidenza()
    await passoDocumento()
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    for (const nome of [/informativa sulla privacy/i, /dati sono veri/i, /copia del documento/i]) {
      fireEvent.click(screen.getByRole('checkbox', { name: nome }))
    }
    avanti()
    await waitFor(() => expect(screen.getByText(itPublic.persRiepilogoSede)).toBeInTheDocument())

    expect(screen.getByText(itPublic.persRiepilogoControlla).className).toContain('max-w-[26rem]')
    expect(screen.getByText(itPublic.persRiepilogoNota).className).toContain('max-w-[26rem]')
  })

  it('…e il corpo del pannello che dice che l’invio è stato rifiutato', async () => {
    const rete = reteFinta({
      invii: [{ tipo: 'http', stato: 503, corpo: { error: 'no', codice: 'PRATICHE_NON_DISPONIBILI' } }],
    })
    vi.stubGlobal('fetch', rete.fetch)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)
    await compilaFinoAlRiepilogo({ sede: ALFA.id })
    fireEvent.click(screen.getByRole('button', { name: itPublic.persInvia }))

    await waitFor(() =>
      expect(screen.getByText(itPublic.persErroreInvioDatiSalvi)).toBeInTheDocument(),
    )
    expect(screen.getByText(itPublic.persErroreInvioDatiSalvi).className).toContain('max-w-[26rem]')
  })
})

describe('a11y · /anagrafica-personale — `jest-axe` su OGNI passo', () => {
  it('sede', async () => {
    const { container } = monta()
    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('sede in ERRORE (le card rosse e il messaggio del gruppo)', async () => {
    const { container } = monta()
    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))
    avanti()
    await waitFor(() => expect(screen.getByText(itPublic.persSedeErrore)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('i tuoi dati (cascata del luogo di nascita e badge del codice fiscale)', async () => {
    const { container } = monta()
    await passoSede(ALFA.id)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('residenza e recapiti', async () => {
    const { container } = monta()
    await passoSede(ALFA.id)
    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/^Indirizzo di residenza/)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('documento, con l’avviso di scadenza acceso e la scansione caricata', async () => {
    const { container } = monta()
    await passoSede(ALFA.id)
    await passoDati()
    await passoResidenza()
    await waitFor(() => expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/^Scadenza del documento/), { target: { value: '01/01/2020' } })
    await caricaScansione()
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('informativa e dichiarazioni', async () => {
    const { container } = monta()
    await passoSede(ALFA.id)
    await passoDati()
    await passoResidenza()
    await passoDocumento()
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('riepilogo (cinque gruppi, cinque «Modifica» con nomi distinti)', async () => {
    const { container } = monta()
    await passoSede(ALFA.id)
    await passoDati()
    await passoResidenza()
    await passoDocumento()
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    for (const nome of [/informativa sulla privacy/i, /dati sono veri/i, /copia del documento/i]) {
      fireEvent.click(screen.getByRole('checkbox', { name: nome }))
    }
    avanti()
    await waitFor(() => expect(screen.getByText(itPublic.persRiepilogoSede)).toBeInTheDocument())

    // ⚠️ SI MISURA IL NOME CALCOLATO, non l'attributo. In fila, per chi li
    // ascolta, cinque «Modifica» sono cinque volte la stessa cosa; ed è l'ultima
    // schermata prima di un invio irreversibile, il cui unico compito è farsi
    // ricontrollare.
    // `getByRole(..., { name })` percorre l'algoritmo di accname (la stessa
    // libreria che usa `axe`): l'`aria-labelledby` di ogni comando punta a SÉ
    // STESSO e poi al titolo del suo gruppo, e il nome che ne esce è
    // «Modifica La tua sede», non «Modifica». Un rilievo del 12/08/2026
    // sosteneva il contrario, avendo letto `aria-label`/`aria-describedby` (che
    // sono `null`, ed è giusto) invece di `aria-labelledby`: queste cinque righe
    // sono la misura che lo smentisce, e il presidio perché resti vero.
    for (const gruppo of [
      itPublic.persSede,
      itPublic.persDati,
      itPublic.persResidenza,
      itPublic.persDocumento,
      itPublic.persConsensiTitolo,
    ]) {
      expect(
        screen.getByRole('button', { name: `${itPublic.persRiepilogoModifica} ${gruppo}` }),
        `il «Modifica» del gruppo «${gruppo}» deve chiamarsi come il gruppo`,
      ).toBeInTheDocument()
    }
    // …e NESSUNO si chiama soltanto «Modifica».
    expect(screen.queryAllByRole('button', { name: itPublic.persRiepilogoModifica })).toHaveLength(0)

    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('conferma d’invio', async () => {
    const { container } = monta()
    await passoSede(ALFA.id)
    await passoDati()
    await passoResidenza()
    await passoDocumento()
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    for (const nome of [/informativa sulla privacy/i, /dati sono veri/i, /copia del documento/i]) {
      fireEvent.click(screen.getByRole('checkbox', { name: nome }))
    }
    avanti()
    await waitFor(() => expect(screen.getByText(itPublic.persRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.persInvia }))
    await waitFor(() => expect(screen.getByText(itPublic.persInviata)).toBeInTheDocument())

    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('i due stati in cui il modulo non comincia', async () => {
    for (const sedi of [
      [{ tipo: 'ok' as const, sedi: [] }],
      [{ tipo: 'http' as const, stato: 429 }],
    ]) {
      const { container, unmount } = monta(reteFinta({ sedi }))
      await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
      expect(await axe(container, axeOpts)).toHaveNoViolations()
      unmount()
      vi.unstubAllGlobals()
    }
  })
})
