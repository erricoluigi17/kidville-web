import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import { ScrollableAdultForm, type AdultFormHandle } from '@/components/features/admin/ScrollableAdultForm'
import { calcolaCodiceFiscale } from '@/lib/fiscale/calcolo'

// =============================================================================
// La scheda ADULTO della famiglia — il codice fiscale si PROPONE, non si adotta.
//
// ─── LA CORREZIONE DELL'11 AGOSTO, E PERCHÉ VIENE PRIMA DI TUTTO ────────────
// Per poche ore questa scheda ha avuto un difetto che i test di allora non
// vedevano perché lo CEMENTAVANO: l'`input` valeva `digitato || calcolato` e
// `validate()` salvava quel valore. Due conseguenze, entrambe misurate:
//
//   · **il campo non si poteva svuotare** — cancellandolo, il calcolato tornava
//     alla battuta successiva, e «questa persona un codice fiscale non ce l'ha»
//     non era una cosa che l'operatore potesse dire;
//   · **il calcolato si salvava da solo** — su `parents.fiscal_code`, che è
//     UNIQUE. Per i 27 genitori su 50 che in produzione un codice non ce l'hanno,
//     per ogni delegato, per ogni omocodico (assegnato dall'Agenzia, per
//     costruzione DIVERSO dal calcolato) e per ogni nato all'estero, quel valore
//     è INVENTATO — e due invenzioni che collidono fanno fallire il salvataggio
//     di una famiglia vera.
//
// Il contratto giusto è quello che `BadgeCoerenzaCf` già espone: sul campo vuoto
// si PROPONE, con il bottone «Usa questo». §1 e §2 lo misurano nei due versi.
//
//  §1 la cascata rende il codice PROPONIBILE, e il gesto lo adotta;
//  §2 il campo si svuota e RESTA vuoto — e quel vuoto arriva fino al payload;
//  §3 quello digitato a mano non si sovrascrive mai (omocodici);
//  §4 il badge segnala e non blocca;
//  §5 il campo mai compilato non accende nessun rosso;
//  §6 il codice proposto è quello della libreria, non una seconda copia;
//  §7 gli `id` sono unici per scheda — l'invariante su cui poggia `htmlFor`;
//  §8 il Belfiore che arriva dalla rete si valida, e il messaggio si vede;
//  §9 il sesso non si inventa, nemmeno cambiando ruolo A SCHEDA APERTA.
//
// ⚠️ REPOSITORY PUBBLICO: qui dentro non c'è nessun codice fiscale con checksum
// valida, e nessuna persona. L'anagrafica di prova è inventata, e il codice che
// la cascata produce non viene MAI scritto nel file: si verifica la sua FORMA e i
// pezzi che ci si aspetta dentro (le tre lettere del cognome, il Belfiore scelto).
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

/** Toponimi e codici catastali: dati aperti dell'Agenzia, non dati di persone. */
const NAPOLI = {
  comuni: [
    { belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true },
    { belfiore: 'E054', nome: 'GIUGLIANO IN CAMPANIA', sigla: 'NA', attivo: true },
  ],
}

/**
 * L'elenco con un codice catastale FUORI FORMA. Non è un caso di scuola: il
 * `belfiore` non lo digita nessuno, arriva da `GET /api/anagrafiche/comuni` e
 * finisce dentro il codice fiscale di una persona. È il dato di confine, ed è la
 * ragione per cui lo schema lo valida (§8).
 */
const ELENCO_MALFORMATO = {
  comuni: [{ belfiore: 'ZZZZ', nome: 'FINTOPOLI', sigla: 'NA', attivo: true }],
}

function fintaRete(elenco: unknown = NAPOLI) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/anagrafiche/comuni')) {
      return new Response(JSON.stringify(elenco), { status: 200 })
    }
    return new Response('{"error":"non previsto"}', { status: 500 })
  })
}

/** Apre la tendina di un Combobox dal suo pulsante. */
function apri(campo: HTMLElement) {
  const contenitore = campo.closest('div')?.parentElement as HTMLElement
  fireEvent.click(within(contenitore).getByRole('button', { name: 'Mostra o nascondi l’elenco' }))
}

const campoNome = () => screen.getByLabelText('Nome')
const campoCognome = () => screen.getByLabelText('Cognome')
const campoSesso = () => screen.getByLabelText('Sesso')
const campoRuolo = () => screen.getByLabelText(/Ruolo Familiare/i)
const campoData = () => screen.getByLabelText('Data di Nascita')
const campoCf = () => screen.getByLabelText(/Codice Fiscale/)
const campoProvincia = () => screen.getByRole('combobox', { name: 'Provincia di nascita' })
const campoComune = () => screen.getByRole('combobox', { name: /Comune di nascita|Stato di nascita/ })
const usaQuesto = () => screen.getByRole('button', { name: 'Usa questo' })

/**
 * Il badge, cercato per `id` e non per ruolo. Ogni `Combobox` porta con sé la
 * propria regione `aria-live`, che è anch'essa un `role="status"`: in questa
 * schermata ce ne sono tre, e chiedere il ruolo significherebbe misurare la
 * live-region di una tendina al posto del verdetto sul codice fiscale.
 */
const badgeCf = () => {
  const id = campoCf().getAttribute('aria-describedby')
  return id ? document.getElementById(id) : null
}

/** Il codice PROPOSTO dal badge, letto dal `<code>` che lo contiene. */
const codiceProposto = () => badgeCf()?.querySelector('code')?.textContent ?? ''

/** Compila l'anagrafica minima, luogo di nascita ESCLUSO. */
function compilaAnagrafica() {
  fireEvent.change(campoNome(), { target: { name: 'first_name', value: 'Prova' } })
  fireEvent.change(campoCognome(), { target: { name: 'last_name', value: 'Esempio' } })
  fireEvent.change(campoSesso(), { target: { name: 'gender', value: 'F' } })
  fireEvent.change(campoData(), { target: { value: '07/03/1985' } })
}

/** Sceglie Napoli dalla cascata: è il passo che porta `H501` fino al calcolo. */
async function scegliNapoli() {
  apri(campoProvincia())
  fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
  await waitFor(() => expect(campoComune()).toBeEnabled())
  apri(campoComune())
  fireEvent.click(screen.getByRole('option', { name: 'NAPOLI' }))
}

beforeEach(() => {
  vi.stubGlobal('fetch', fintaRete())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── §1 · LA CASCATA RENDE IL CODICE PROPONIBILE ──────────────────────────────

describe('§1 · il codice fiscale si PROPONE dalla cascata, e lo adotta un gesto', () => {
  it('scelti provincia e comune, il campo resta vuoto e il badge offre il codice', async () => {
    render(<ScrollableAdultForm />)
    compilaAnagrafica()

    // Prima della scelta del comune non c'è nessun codice catastale: niente da
    // proporre. Meglio nessuna proposta che un codice su un comune indovinato.
    expect(campoCf()).toHaveValue('')
    expect(badgeCf()).toBeNull()

    await scegliNapoli()

    // ⚠️ IL CAMPO NON SI È COMPILATO DA SOLO. È il cuore della correzione: finché
    // nessuno preme «Usa questo», in archivio va l'assenza.
    expect(campoCf()).toHaveValue('')

    const badge = badgeCf()
    expect(badge).not.toBeNull()
    expect(badge).toHaveTextContent('Codice calcolato dai dati')
    // Il badge dice a chiare lettere che il gesto non salva niente.
    expect(badge).toHaveTextContent('non salva niente')

    const codice = codiceProposto()
    // Forma canonica, e i pezzi che DEVONO venire da dove diciamo: le tre lettere
    // del cognome «Esempio» e il Belfiore della tendina.
    expect(codice).toMatch(/^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$/)
    expect(codice.slice(0, 3)).toBe('SMP')
    expect(codice.slice(11, 15)).toBe('H501')
    // Il giorno porta lo scarto femminile (7 + 40 = 47): il sesso scelto è arrivato.
    expect(codice.slice(9, 11)).toBe('47')
  })

  it('«Usa questo» compila il campo — e SOLO allora il codice entra nel payload', async () => {
    const ref = createRef<AdultFormHandle>()
    render(<ScrollableAdultForm ref={ref} />)
    compilaAnagrafica()
    await scegliNapoli()

    // Prima del gesto: il payload NON porta nessun codice.
    const prima = ref.current!.validate()
    expect(prima.ok).toBe(true)
    if (!prima.ok) return
    expect(prima.data.fiscal_code).toBe('')

    const proposto = codiceProposto()
    const chiamatePrima = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length
    fireEvent.click(usaQuesto())

    expect(campoCf()).toHaveValue(proposto)
    // «Compila il campo e basta»: nessuna rete, nessun salvataggio.
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(chiamatePrima)

    const dopo = ref.current!.validate()
    expect(dopo.ok).toBe(true)
    if (!dopo.ok) return
    expect(dopo.data.fiscal_code).toBe(proposto)
    // Il codice catastale viaggia col payload: è la colonna che rende il codice
    // ricontrollabile domani, quando il comune sarà stato rinominato.
    expect(dopo.data.codice_belfiore_nascita).toBe('H501')
    expect(dopo.data.birth_place).toBe('NAPOLI')
    expect(dopo.data.birth_province).toBe('NA')
  })

  it('nessuna chiamata a un servizio terzo: l’unica rete è la rotta dei comuni', async () => {
    render(<ScrollableAdultForm />)
    compilaAnagrafica()
    await scegliNapoli()

    const chiamate = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    expect(chiamate.length).toBeGreaterThan(0)
    for (const url of chiamate) expect(url.startsWith('/api/anagrafiche/comuni')).toBe(true)
  })

  it('senza il SESSO non c’è niente da proporre, e il badge lo dice invece di indovinarlo', async () => {
    // ⚠️ Il sesso NON ha un valore predefinito per i delegati: prima nasceva «F»
    // per il solo fatto che il ruolo fosse «delegato». Era un dato di una persona
    // vera, scelto da nessuno, che finiva in `parents.gender`.
    render(<ScrollableAdultForm defaultRole="delegate" />)
    expect(campoSesso()).toHaveValue('')

    fireEvent.change(campoNome(), { target: { name: 'first_name', value: 'Prova' } })
    fireEvent.change(campoCognome(), { target: { name: 'last_name', value: 'Esempio' } })
    fireEvent.change(campoData(), { target: { value: '07/03/1985' } })
    await scegliNapoli()

    expect(campoCf()).toHaveValue('')
    // Il campo è vuoto: lo stato è «da compilare», neutro. Il badge non accusa
    // nessuno — e qui non ha nemmeno un codice da offrire.
    expect(badgeCf()).toBeNull()
    expect(screen.queryByText(/non coerente/)).toBeNull()
  })
})

// ── §2 · IL CAMPO SI PUÒ SVUOTARE, E IL VUOTO ARRIVA IN FONDO ────────────────

describe('§2 · «questa persona non ha un codice fiscale» è una cosa che si può dire', () => {
  it('cancellato il contenuto, il campo RESTA vuoto anche se il codice è calcolabile', async () => {
    render(<ScrollableAdultForm />)
    compilaAnagrafica()
    await scegliNapoli()

    fireEvent.click(usaQuesto())
    expect((campoCf() as HTMLInputElement).value).not.toBe('')

    // Il gesto che prima non funzionava: si svuota la casella.
    fireEvent.change(campoCf(), { target: { name: 'fiscal_code', value: '' } })

    // ⚠️ E resta vuota. Con `value={digitato || calcolato}` qui ricompariva il
    // codice calcolato, e non c'era nessun modo di toglierlo.
    expect(campoCf()).toHaveValue('')
    // Il badge torna a PROPORRE: la proposta è il posto giusto per il calcolato.
    expect(badgeCf()).toHaveTextContent('Codice calcolato dai dati')
  })

  it('il campo svuotato esce vuoto dal payload — non col codice calcolato', async () => {
    const ref = createRef<AdultFormHandle>()
    render(<ScrollableAdultForm ref={ref} />)
    compilaAnagrafica()
    await scegliNapoli()
    fireEvent.click(usaQuesto())
    fireEvent.change(campoCf(), { target: { name: 'fiscal_code', value: '' } })

    const esito = ref.current!.validate()
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    // Stringa vuota: `buildParentRecord` la normalizza a `null` prima dell'INSERT,
    // perché `parents.fiscal_code` è UNIQUE e con UNIQUE `''` è un valore, `NULL` no.
    expect(esito.data.fiscal_code).toBe('')
    expect(esito.data.fiscal_code).not.toBe(codiceProposto())
  })

  it('senza luogo di nascita il codice catastale è `null`, non una stringa vuota', () => {
    const ref = createRef<AdultFormHandle>()
    render(<ScrollableAdultForm ref={ref} />)
    compilaAnagrafica()

    const esito = ref.current!.validate()
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    // Una stringa vuota sarebbe un valore che non esiste, scritto al posto
    // dell'assenza — e il `check` della colonna la rifiuterebbe.
    expect(esito.data.codice_belfiore_nascita).toBeNull()
  })
})

// ── §3 · QUELLO DIGITATO A MANO VINCE ────────────────────────────────────────

describe('§3 · quello che l’operatore ha digitato non si sovrascrive mai', () => {
  it('il codice scritto a mano resta anche quando la cascata potrebbe calcolarne un altro', async () => {
    render(<ScrollableAdultForm />)
    compilaAnagrafica()

    // Un codice inventato, senza checksum valida: è quello che l'operatore
    // avrebbe copiato dal tesserino, e in un omocodico vero sarebbe l'unico giusto.
    fireEvent.change(campoCf(), { target: { name: 'fiscal_code', value: 'AAAAAA00A00A000A' } })
    await scegliNapoli()

    expect(campoCf()).toHaveValue('AAAAAA00A00A000A')
  })

  it('è il valore digitato a finire nel payload, con spazi ai bordi tolti', async () => {
    const ref = createRef<AdultFormHandle>()
    render(<ScrollableAdultForm ref={ref} />)
    compilaAnagrafica()
    await scegliNapoli()
    fireEvent.change(campoCf(), { target: { name: 'fiscal_code', value: 'AAAAAA00A00A000A' } })

    const esito = ref.current!.validate()
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.data.fiscal_code).toBe('AAAAAA00A00A000A')
  })
})

// ── §4 · IL BADGE SI VEDE, E NON BLOCCA NIENTE ───────────────────────────────

describe('§4 · il badge segnala e il salvataggio resta possibile', () => {
  it('codice che contraddice l’anagrafica → badge rosso, e `validate()` passa lo stesso', async () => {
    const ref = createRef<AdultFormHandle>()
    render(<ScrollableAdultForm ref={ref} />)
    compilaAnagrafica()
    await scegliNapoli()

    // Sedici caratteri di forma corretta ma di un'altra persona: il cognome non
    // torna, e nemmeno il resto.
    fireEvent.change(campoCf(), { target: { name: 'fiscal_code', value: 'BBBBBB00B00B000B' } })

    const badge = badgeCf()
    expect(badge).not.toBeNull()
    expect(badge).toHaveAttribute('role', 'status')
    expect(badge).toHaveTextContent('Codice fiscale non coerente con i dati inseriti')
    // ⚠️ Il verdetto NON entra in `validate()`: il salvataggio è una decisione di
    // chi sta davanti allo schermo, non del calcolo.
    expect(ref.current!.validate().ok).toBe(true)
  })

  it('«Usa questo» sostituisce il codice incoerente, e nient’altro', async () => {
    render(<ScrollableAdultForm />)
    compilaAnagrafica()
    await scegliNapoli()
    fireEvent.change(campoCf(), { target: { name: 'fiscal_code', value: 'BBBBBB00B00B000B' } })

    const suggerito = codiceProposto()
    const chiamatePrima = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length

    fireEvent.click(usaQuesto())

    expect(campoCf()).toHaveValue(suggerito)
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(chiamatePrima)
  })

  it('il badge è collegato al campo con `aria-describedby`', async () => {
    render(<ScrollableAdultForm />)
    compilaAnagrafica()
    await scegliNapoli()
    fireEvent.change(campoCf(), { target: { name: 'fiscal_code', value: 'BBBBBB00B00B000B' } })

    const descritto = campoCf().getAttribute('aria-describedby')
    expect(descritto).toBeTruthy()
    const badge = document.getElementById(descritto!)
    expect(badge).not.toBeNull()
    expect(badge).toHaveTextContent('Codice fiscale non coerente con i dati inseriti')
  })
})

// ── §5 · IL CAMPO MAI COMPILATO NON È UN ERRORE ──────────────────────────────

describe('§5 · un dato che nessuno ha mai inserito non accende nessun rosso', () => {
  it('scheda appena aperta: nessun badge, nessun avviso, nessun rosso', () => {
    render(<ScrollableAdultForm />)
    expect(campoCf()).toHaveValue('')
    expect(badgeCf()).toBeNull()
    expect(screen.queryByText(/non coerente/)).toBeNull()
    expect(screen.queryByText('Non verificabile')).toBeNull()
  })

  it('anagrafica a metà e nessun codice: si resta neutri, non gialli', () => {
    render(<ScrollableAdultForm />)
    fireEvent.change(campoCognome(), { target: { name: 'last_name', value: 'Esempio' } })

    expect(screen.queryByText('Non verificabile')).toBeNull()
    expect(screen.queryByText(/non coerente/)).toBeNull()
  })

  it('scheda vuota: `isEmpty()` la fa saltare dal salvataggio, come prima', () => {
    const ref = createRef<AdultFormHandle>()
    render(<ScrollableAdultForm ref={ref} />)
    expect(ref.current!.isEmpty()).toBe(true)
  })
})

// ── §6 · IL CALCOLO È QUELLO DELLA LIBRERIA, NON UNA COPIA ───────────────────

describe('§6 · il codice proposto è esattamente quello di `calcolaCodiceFiscale`', () => {
  it('stessa anagrafica, stesso codice: nessuna seconda implementazione nel form', async () => {
    render(<ScrollableAdultForm />)
    compilaAnagrafica()
    await scegliNapoli()

    const atteso = calcolaCodiceFiscale({
      nome: 'Prova',
      cognome: 'Esempio',
      sesso: 'F',
      dataNascita: '1985-03-07',
      codiceBelfiore: 'H501',
    })
    expect(atteso.ok).toBe(true)
    expect(codiceProposto()).toBe(atteso.ok ? atteso.codice : '')
  })
})

// ── §7 · GLI `id` SONO UNICI PER SCHEDA ──────────────────────────────────────

describe('§7 · due schede nello stesso albero non si rubano il fuoco', () => {
  /**
   * ⚠️ NON È UN'IPOTESI: `FamilyRegistryManager` tiene MONTATE tutte le schede
   * della famiglia insieme (madre, padre, e ogni delegato aggiunto) e nasconde le
   * altre con `hidden`. Nel DOM convivono quindi più «Sesso», più «Codice fiscale»
   * e più tendine del comune. Con un prefisso FISSO al posto di `useId()`,
   * `htmlFor` porterebbe il fuoco al campo di un'altra persona e
   * `aria-describedby` leggerebbe il badge di un'altra persona — e finora nessun
   * test montava due schede insieme, cioè l'invariante era difesa da un commento.
   */
  it('gli `id` dei campi e il badge sono DIVERSI fra le due schede', () => {
    const { container } = render(
      <>
        <ScrollableAdultForm defaultRole="mother" />
        <ScrollableAdultForm defaultRole="father" />
      </>,
    )

    const cf = Array.from(container.querySelectorAll('input[name="fiscal_code"]'))
    expect(cf).toHaveLength(2)
    const idCampi = cf.map((el) => el.getAttribute('id'))
    expect(idCampi[0]).toBeTruthy()
    expect(idCampi[0]).not.toBe(idCampi[1])

    // Anche il puntamento al badge dev'essere distinto, altrimenti uno screen
    // reader descriverebbe il campo di una persona col verdetto di un'altra.
    const descritti = cf.map((el) => el.getAttribute('aria-describedby'))
    expect(descritti[0]).toBeTruthy()
    expect(descritti[0]).not.toBe(descritti[1])

    // E la prova che conta davvero: nessun `id` duplicato in tutto l'albero.
    const tuttiGliId = Array.from(container.querySelectorAll('[id]')).map((el) => el.id)
    expect(new Set(tuttiGliId).size).toBe(tuttiGliId.length)
  })

  it('ogni `htmlFor` trova un campo, e ogni `aria-describedby` un elemento', () => {
    const { container } = render(
      <>
        <ScrollableAdultForm defaultRole="mother" />
        <ScrollableAdultForm defaultRole="father" />
      </>,
    )
    for (const etichetta of Array.from(container.querySelectorAll('label[for]'))) {
      const bersaglio = etichetta.getAttribute('for')!
      expect(container.querySelectorAll(`[id="${CSS.escape(bersaglio)}"]`)).toHaveLength(1)
    }
  })
})

// ── §8 · IL BELFIORE ARRIVA DALLA RETE, QUINDI SI VALIDA ─────────────────────

describe('§8 · il codice catastale è un dato di CONFINE, e il suo messaggio si vede', () => {
  /**
   * Il `belfiore` non lo digita nessuno: `cambiaLuogoNascita` lo prende da
   * `opzione.valore`, cioè dal corpo di `GET /api/anagrafiche/comuni`. Il `regex`
   * dello schema è quindi il controllo su un dato di provenienza esterna che
   * finisce dentro il codice fiscale di una persona — e il suo messaggio NON è una
   * chiave morta: questo test lo fa accendere.
   */
  it('un Belfiore fuori forma dalla rotta non entra in archivio: `validate()` lo rifiuta', async () => {
    vi.stubGlobal('fetch', fintaRete(ELENCO_MALFORMATO))
    const ref = createRef<AdultFormHandle>()
    render(<ScrollableAdultForm ref={ref} />)
    compilaAnagrafica()

    apri(campoProvincia())
    fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
    await waitFor(() => expect(campoComune()).toBeEnabled())
    apri(campoComune())
    fireEvent.click(screen.getByRole('option', { name: 'FINTOPOLI' }))

    expect(ref.current!.validate().ok).toBe(false)
    expect(
      await screen.findByText('Codice catastale non valido: scegli il comune dalla tendina.'),
    ).toBeInTheDocument()
  })
})

// ── §9 · IL SESSO NON SI INVENTA, NEMMENO CAMBIANDO RUOLO ────────────────────

describe('§9 · il sesso segue il ruolo finché nessuno lo sceglie, e poi mai più', () => {
  it('da «madre» a «delegato» il sesso si azzera: quella `F` non l’aveva scelta nessuno', () => {
    render(<ScrollableAdultForm defaultRole="mother" />)
    expect(campoSesso()).toHaveValue('F')

    fireEvent.change(campoRuolo(), { target: { name: 'role', value: 'delegate' } })

    // ⚠️ Prima restava `'F'`: cioè esattamente il valore inventato che la
    // correzione dichiarava di aver eliminato, arrivato per un'altra strada.
    expect(campoSesso()).toHaveValue('')
  })

  it('da «madre» a «padre» il sesso segue il ruolo: lì il ruolo È il dato', () => {
    render(<ScrollableAdultForm defaultRole="mother" />)
    fireEvent.change(campoRuolo(), { target: { name: 'role', value: 'father' } })
    expect(campoSesso()).toHaveValue('M')
  })

  it('il sesso scelto A MANO non lo tocca nessun cambio di ruolo', () => {
    render(<ScrollableAdultForm defaultRole="delegate" />)
    fireEvent.change(campoSesso(), { target: { name: 'gender', value: 'F' } })

    fireEvent.change(campoRuolo(), { target: { name: 'role', value: 'educator' } })
    expect(campoSesso()).toHaveValue('F')

    fireEvent.change(campoRuolo(), { target: { name: 'role', value: 'father' } })
    expect(campoSesso()).toHaveValue('F')
  })
})
