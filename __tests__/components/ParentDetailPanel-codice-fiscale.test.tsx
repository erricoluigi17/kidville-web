import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import { ParentDetailPanel } from '@/components/features/admin/ParentDetailPanel'
import { eCfGenitoreDuplicato } from '@/lib/anagrafiche/errori-cf'

// =============================================================================
// La scheda di dettaglio del GENITORE — è qui che si vedono i record veri.
//
// I DUE NUMERI CHE DECIDONO COME DEVE COMPORTARSI QUESTA SCHERMATA, misurati in
// produzione l'11 agosto con una `SELECT` su `parents` (50 righe):
//
//   · **26 genitori hanno `fiscal_code` NULL, e UNO ha la stringa vuota.**
//     `parents.fiscal_code` è UNIQUE (`parents_fiscal_code_key`), e per un vincolo
//     UNIQUE `''` è un valore come tutti gli altri mentre `NULL` no. Quindi il
//     secondo genitore a cui questa scheda scrivesse `''` COLLIDE con quell'unico,
//     e l'operatore si vedrebbe dire «esiste già un genitore con questo codice
//     fiscale» a proposito di un codice che non esiste. §2 misura che il vuoto
//     esca come `null`.
//   · **27 su 50 non hanno nessun codice fiscale.** Se il campo mai compilato
//     accendesse un rosso — o anche solo un giallo — più della metà dell'archivio
//     sarebbe segnalata il primo giorno, e un pannello che segnala tutto smette di
//     essere guardato. §4 misura che il vuoto resti NEUTRO.
//
// E la correzione dell'11 agosto, che è la ragione per cui §1 e §2 sono scritte
// così: fino a poche ore fa l'`input` valeva `archivio || calcolato` e Salva
// inviava quel valore. Cioè il campo non si poteva svuotare, e aprire la scheda di
// uno dei 27 genitori senza codice e premere Salva gli SCRIVEVA un codice che
// nessuno aveva confermato — su una colonna UNIQUE.
//
// ⚠️ REPOSITORY PUBBLICO: nessuna persona e nessun codice fiscale con checksum
// valida in questo file. L'anagrafica è inventata; il codice che la cascata
// propone non viene mai scritto qui — se ne verificano forma e provenienza.
// =============================================================================

const logClientSpia = vi.fn()
vi.mock('@/lib/logging/client', () => ({
  logClient: (...a: unknown[]) => logClientSpia(...a),
  nomeErrore: () => 'Error',
}))

/** Toponimi e codici catastali: dati aperti dell'Agenzia, non dati di persone. */
const NAPOLI = {
  comuni: [
    { belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true },
    { belfiore: 'E054', nome: 'GIUGLIANO IN CAMPANIA', sigla: 'NA', attivo: true },
  ],
}

const ID_GENITORE = '00000000-0000-4000-8000-000000000001'

/** Il caso che pesa: anagrafica presente, codice fiscale MAI compilato. */
const SENZA_CODICE = {
  id: ID_GENITORE,
  first_name: 'Prova',
  last_name: 'Esempio',
  gender: 'F',
  birth_date: '1985-03-07',
  birth_city: '',
  birth_province: '',
  birth_nation: '',
  codice_belfiore_nascita: null,
  fiscal_code: '',
  emails: [],
  phone_numbers: [],
  residence_address: '',
  residence_city: '',
  zip_code: '',
}

function fintaRete(genitore: Record<string, unknown> = SENZA_CODICE) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/anagrafiche/comuni')) {
      return new Response(JSON.stringify(NAPOLI), { status: 200 })
    }
    if (url.includes('/api/admin/parents/')) {
      return new Response(JSON.stringify(genitore), { status: 200 })
    }
    return new Response('{"error":"non previsto"}', { status: 500 })
  })
}

function apri(campo: HTMLElement) {
  const contenitore = campo.closest('div')?.parentElement as HTMLElement
  fireEvent.click(within(contenitore).getByRole('button', { name: 'Mostra o nascondi l’elenco' }))
}

const campoCf = () => screen.getByLabelText(/Codice Fiscale/)
const campoSesso = () => screen.getByLabelText('Sesso')
const campoProvincia = () => screen.getByRole('combobox', { name: 'Provincia di nascita' })
const campoComune = () => screen.getByRole('combobox', { name: /Comune di nascita|Stato di nascita/ })
const salva = () => screen.getByRole('button', { name: /Salva Modifiche/i })
const usaQuesto = () => screen.getByRole('button', { name: 'Usa questo' })

/**
 * Il badge, cercato per `id`: ogni `Combobox` porta la propria regione
 * `aria-live`, che è anch'essa `role="status"`. Chiedere il ruolo qui
 * significherebbe misurare una tendina al posto del verdetto sul codice.
 */
const badgeCf = () => {
  const id = campoCf().getAttribute('aria-describedby')
  return id ? document.getElementById(id) : null
}

/** Il codice PROPOSTO dal badge, letto dal `<code>` che lo contiene. */
const codiceProposto = () => badgeCf()?.querySelector('code')?.textContent ?? ''

/**
 * La spia sul salvataggio, TIPIZZATA sul parametro: senza il tipo esplicito
 * `vi.fn(async () => {})` deduce «nessun argomento», e `mock.calls[0][0]` non
 * compila. È l'unico modo di leggere davvero che cosa esce dalla scheda.
 */
const spiaSalvataggio = () => vi.fn(async (dati: Record<string, unknown>) => { void dati })

async function montaScheda(onSave = vi.fn()) {
  const reso = render(
    <ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={onSave} variant="page" />,
  )
  await waitFor(() => expect(campoCf()).toBeInTheDocument())
  return { ...reso, onSave }
}

async function scegliNapoli() {
  apri(campoProvincia())
  fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
  await waitFor(() => expect(campoComune()).toBeEnabled())
  apri(campoComune())
  fireEvent.click(screen.getByRole('option', { name: 'NAPOLI' }))
}

beforeEach(() => {
  logClientSpia.mockClear()
  vi.stubGlobal('fetch', fintaRete())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── §1 · IL CODICE MANCANTE SI PROPONE, NON SI ADOTTA ────────────────────────

describe('§1 · sul codice mancante la cascata PROPONE, e il gesto adotta', () => {
  it('scelto il comune, il campo resta vuoto e il badge offre il codice', async () => {
    await montaScheda()
    expect(campoCf()).toHaveValue('')

    await scegliNapoli()

    // ⚠️ Il campo NON si è compilato da solo: su una scheda che si apre su un
    // record vero, autocompilarlo significa proporre un dato inventato come se
    // fosse in archivio — e al primo Salva lo diventa.
    expect(campoCf()).toHaveValue('')

    const badge = badgeCf()
    expect(badge).not.toBeNull()
    expect(badge).toHaveTextContent('Codice calcolato dai dati')

    const codice = codiceProposto()
    expect(codice).toMatch(/^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$/)
    expect(codice.slice(0, 3)).toBe('SMP')
    // Il pezzo che prima non c'era: senza il codice CATASTALE non si calcola
    // nulla, e da una casella di testo libero non esce.
    expect(codice.slice(11, 15)).toBe('H501')

    fireEvent.click(usaQuesto())
    expect(campoCf()).toHaveValue(codice)
  })

  it('senza il SESSO non c’è niente da proporre, e non si inventa un valore predefinito', async () => {
    vi.stubGlobal('fetch', fintaRete({ ...SENZA_CODICE, gender: '' }))
    await montaScheda()
    expect(campoSesso()).toHaveValue('')

    await scegliNapoli()
    expect(campoCf()).toHaveValue('')
    expect(badgeCf()).toBeNull()

    // Scelto il sesso, la proposta compare: è quello il dato che mancava.
    fireEvent.change(campoSesso(), { target: { value: 'F' } })
    await waitFor(() => expect(codiceProposto()).not.toBe(''))
  })
})

// ── §2 · IL VUOTO SI PUÒ DIRE, E ARRIVA IN ARCHIVIO COME `null` ──────────────

describe('§2 · «questo genitore non ha un codice fiscale» arriva fino al PATCH', () => {
  it('cancellato il contenuto, il campo RESTA vuoto anche col codice calcolabile', async () => {
    await montaScheda()
    await scegliNapoli()
    fireEvent.click(usaQuesto())
    expect((campoCf() as HTMLInputElement).value).not.toBe('')

    fireEvent.change(campoCf(), { target: { value: '' } })

    // Con `value={archivio || calcolato}` qui ricompariva il codice calcolato.
    expect(campoCf()).toHaveValue('')
    expect(badgeCf()).toHaveTextContent('Codice calcolato dai dati')
  })

  it('il campo vuoto esce come `null` — mai la stringa vuota, che su UNIQUE è un valore', async () => {
    const onSave = spiaSalvataggio()
    await montaScheda(onSave)
    await scegliNapoli()

    fireEvent.click(salva())

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const inviato = onSave.mock.calls[0][0] as Record<string, unknown>
    // ⚠️ NON il codice proposto: nessuno l'ha confermato.
    expect(inviato.fiscal_code).toBeNull()
    // E il resto della cascata viaggia comunque.
    expect(inviato.codice_belfiore_nascita).toBe('H501')
    expect(inviato.birth_city).toBe('NAPOLI')
    expect(inviato.birth_province).toBe('NA')
    expect(inviato.birth_nation).toBe('Italia')
  })

  it('adottato il codice con «Usa questo», è QUELLO a partire', async () => {
    const onSave = spiaSalvataggio()
    await montaScheda(onSave)
    await scegliNapoli()
    fireEvent.click(usaQuesto())
    const adottato = (campoCf() as HTMLInputElement).value

    fireEvent.click(salva())

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as Record<string, unknown>).fiscal_code).toBe(adottato)
  })

  it('un codice fatto di soli spazi è un’assenza, non un valore', async () => {
    const onSave = spiaSalvataggio()
    vi.stubGlobal('fetch', fintaRete({ ...SENZA_CODICE, fiscal_code: '   ' }))
    await montaScheda(onSave)

    fireEvent.click(salva())

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as Record<string, unknown>).fiscal_code).toBeNull()
  })

  it('senza luogo di nascita il codice catastale parte `null`, non stringa vuota', async () => {
    const onSave = spiaSalvataggio()
    await montaScheda(onSave)

    fireEvent.click(salva())

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as Record<string, unknown>).codice_belfiore_nascita).toBeNull()
  })
})

// ── §3 · IL CODICE IN ARCHIVIO NON SI SOVRASCRIVE ────────────────────────────

describe('§3 · quello che c’è in archivio (o è stato digitato) resta', () => {
  it('un codice già presente non viene toccato dalla cascata', async () => {
    // Codice inventato, senza checksum valida: sta al posto di un omocodico
    // vero, che è legittimo e per costruzione DIVERSO da quello calcolato.
    vi.stubGlobal('fetch', fintaRete({ ...SENZA_CODICE, fiscal_code: 'AAAAAA00A00A000A' }))
    await montaScheda()

    await scegliNapoli()

    expect(campoCf()).toHaveValue('AAAAAA00A00A000A')
  })

  it('quello digitato a mano vince sul suggerimento', async () => {
    await montaScheda()
    await scegliNapoli()

    fireEvent.change(campoCf(), { target: { value: 'bbbbbb00b00b000b' } })
    expect(campoCf()).toHaveValue('BBBBBB00B00B000B')
  })
})

// ── §4 · IL BADGE SI VEDE E IL SALVATAGGIO FUNZIONA ──────────────────────────

describe('§4 · il badge segnala, il salvataggio resta possibile', () => {
  it('codice che contraddice l’anagrafica → badge rosso, e il bottone Salva NON è disabilitato', async () => {
    await montaScheda()
    await scegliNapoli()
    fireEvent.change(campoCf(), { target: { value: 'BBBBBB00B00B000B' } })

    const badge = badgeCf()
    expect(badge).not.toBeNull()
    expect(badge).toHaveTextContent('Codice fiscale non coerente con i dati inseriti')
    expect(salva()).not.toBeDisabled()
  })

  it('scheda con codice assente e anagrafica incompleta: nessun badge, nessun rosso, nessun giallo', async () => {
    // Anagrafica volutamente incompleta, come lo è in archivio: niente comune,
    // niente codice catastale, niente sesso. Non c'è nemmeno un codice da proporre.
    vi.stubGlobal('fetch', fintaRete({ ...SENZA_CODICE, gender: '', birth_date: '' }))
    await montaScheda()

    expect(campoCf()).toHaveValue('')
    expect(badgeCf()).toBeNull()
    expect(screen.queryByText(/non coerente/)).toBeNull()
    expect(screen.queryByText('Non verificabile')).toBeNull()
  })
})

// ── §5 · IL VINCOLO UNIQUE DIVENTA UNA FRASE CHE SI CAPISCE ──────────────────

describe('§5 · `parents.fiscal_code` è UNIQUE: il 23505 si legge, e non fa perdere niente', () => {
  it('riconosce il vincolo dal messaggio di Postgres, in tutte le forme in cui arriva', () => {
    expect(eCfGenitoreDuplicato('duplicate key value violates unique constraint "parents_fiscal_code_key"')).toBe(true)
    expect(eCfGenitoreDuplicato('23505: duplicate key on fiscal_code')).toBe(true)
    // Un altro vincolo NON deve travestirsi da codice fiscale duplicato.
    expect(eCfGenitoreDuplicato('duplicate key value violates unique constraint "utenti_email_key"')).toBe(false)
    expect(eCfGenitoreDuplicato(undefined)).toBe(false)
    expect(eCfGenitoreDuplicato(500)).toBe(false)
  })

  it('il contenitore riporta il rifiuto → messaggio leggibile in pagina, dati INTATTI', async () => {
    const onSave = vi.fn(async () => ({
      ok: false,
      errore: 'duplicate key value violates unique constraint "parents_fiscal_code_key"',
    }))
    await montaScheda(onSave)
    fireEvent.change(campoCf(), { target: { value: 'BBBBBB00B00B000B' } })

    fireEvent.click(salva())

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent('Esiste già un genitore con questo codice fiscale')
    // ⚠️ Nessuna riga di Postgres a schermo: quella non dice niente a chi lavora.
    expect(avviso).not.toHaveTextContent('constraint')
    // ⚠️ E soprattutto: quello che l'operatore aveva appena scritto è ancora lì.
    expect(campoCf()).toHaveValue('BBBBBB00B00B000B')
    // Il bottone torna utilizzabile: si corregge e si riprova.
    expect(salva()).not.toBeDisabled()
  })

  it('un errore qualunque non diventa «codice duplicato», e non mostra il testo grezzo', async () => {
    const onSave = vi.fn(async () => ({ ok: false, errore: 'null value in column "x" violates not-null constraint' }))
    await montaScheda(onSave)

    fireEvent.click(salva())

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent('Errore nel salvataggio')
    expect(avviso).not.toHaveTextContent('not-null')
  })

  it('se `onSave` lancia, l’errore si vede E si logga: un catch muto è un bug', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('duplicate key value violates unique constraint "parents_fiscal_code_key"')
    })
    await montaScheda(onSave)

    fireEvent.click(salva())

    expect(await screen.findByRole('alert')).toHaveTextContent('Esiste già un genitore con questo codice fiscale')
    await waitFor(() => expect(logClientSpia).toHaveBeenCalled())
    const riga = logClientSpia.mock.calls.at(-1)![0] as { livello: string; messaggio: string }
    expect(riga.livello).toBe('error')
    expect(riga.messaggio).toContain('salvataggio-genitore-fallito')
    // Nessun dato di persona nel log: né il codice fiscale né il nome.
    expect(riga.messaggio).not.toContain('BBBBBB')
  })

  it('un contenitore che non restituisce niente continua a funzionare come prima', async () => {
    const onSave = spiaSalvataggio()
    await montaScheda(onSave)

    fireEvent.click(salva())

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// ── §6 · GLI `id` SONO UNICI PER SCHEDA ──────────────────────────────────────

describe('§6 · due schede nello stesso albero non si rubano il fuoco', () => {
  /**
   * Questa scheda vive sia come pannello laterale sia a tutta pagina, e in
   * entrambi i casi convive con la barra di ricerca del cockpit. Un `id` fisso qui
   * dentro sarebbe un `htmlFor` che punta al campo di un'ALTRA persona il giorno in
   * cui due pannelli si aprono insieme — e finora l'invariante era difesa da un
   * commento, non da una misura.
   */
  it('gli `id` dei campi e il badge sono DIVERSI fra le due schede', async () => {
    const { container } = render(
      <>
        <ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={vi.fn()} variant="page" />
        <ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={vi.fn()} variant="page" />
      </>,
    )
    await waitFor(() => expect(container.querySelectorAll('input[type="date"]')).toHaveLength(2))

    const tuttiGliId = Array.from(container.querySelectorAll('[id]')).map((el) => el.id)
    expect(tuttiGliId.length).toBeGreaterThan(0)
    expect(new Set(tuttiGliId).size).toBe(tuttiGliId.length)

    for (const etichetta of Array.from(container.querySelectorAll('label[for]'))) {
      const bersaglio = etichetta.getAttribute('for')!
      expect(container.querySelectorAll(`[id="${CSS.escape(bersaglio)}"]`)).toHaveLength(1)
    }
  })
})
