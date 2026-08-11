import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import { AdultRegistryForm } from '@/components/features/admin/AdultRegistryForm'

// =============================================================================
// La scheda di REGISTRAZIONE dell'adulto — la terza porta d'ingresso di un
// codice fiscale nell'archivio.
//
// ⚠️ TRE COSE DA SAPERE PRIMA DI LEGGERE, tutte MISURATE l'11 agosto e tutte
// scomode:
//
//  1. **QUESTA SCHEDA NON È MONTATA DA NESSUNA PAGINA.** `grep -rn
//     AdultRegistryForm src/` non trova nessun importatore che non sia il file
//     stesso: quello che si collauda qui, oggi, non ha nessun utente. Sta scritto
//     in testa al componente, e sta scritto qui, perché un test verde su codice
//     irraggiungibile è il modo più efficace di credere che una cosa funzioni.
//  2. Il campo «Sesso» qui NON esisteva, e `gender` nasceva a `'M'`. Cioè: un
//     dato di una persona vera, che nessuno aveva scelto, partiva col primo
//     salvataggio. Ora il campo c'è, nasce VUOTO, e senza di esso il codice
//     fiscale non si calcola — che è la verità, non un ripiego.
//  3. Il corpo della richiesta portava `email` al singolare, mentre
//     `POST /api/admin/adults` legge `emails[0]`: la rotta rispondeva SEMPRE
//     400 «Primary Email is required». §3 misura che ora il corpo sia quello che
//     la rotta si aspetta — se un giorno la scheda verrà montata.
//  4. `POST /api/admin/adults` scrive in `utenti`, e `utenti` non ha le colonne
//     `fiscal_code`/`gender`/`birth_*` (13 colonne misurate l'11 agosto su
//     `information_schema`): il suo zod le scarta prima ancora dell'handler. Il
//     collaudo qui sotto misura ciò che il FORM manda, non ciò che il server
//     conserva — e la differenza è una migrazione, non una riga.
//
// ⚠️ E la correzione dell'11 agosto, la stessa delle altre due schede: il codice
// calcolato si PROPONE col bottone «Usa questo», non si scrive da solo nel campo.
// Con l'autocompilazione il campo non si poteva svuotare e il calcolato si
// salvava senza che nessuno l'avesse confermato.
//
// ⚠️ REPOSITORY PUBBLICO: nessuna persona, nessun codice fiscale con checksum
// valida. Il codice che la cascata propone non compare mai in questo file.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

/** Toponimi e codici catastali: dati aperti dell'Agenzia, non dati di persone. */
const NAPOLI = {
  comuni: [
    { belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true },
    { belfiore: 'E054', nome: 'GIUGLIANO IN CAMPANIA', sigla: 'NA', attivo: true },
  ],
}

interface RispostaFinta { stato: number; corpo: unknown }

/** `postAdults` decide come risponde `POST /api/admin/adults`. */
function fintaRete(postAdults: RispostaFinta = { stato: 200, corpo: { success: true } }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/anagrafiche/comuni')) return new Response(JSON.stringify(NAPOLI), { status: 200 })
    if (url.includes('/api/admin/sedi')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
    if (url.includes('/api/admin/adults')) {
      return new Response(JSON.stringify(postAdults.corpo), { status: postAdults.stato })
    }
    return new Response('{"error":"non previsto"}', { status: 500 })
  })
}

function apri(campo: HTMLElement) {
  const contenitore = campo.closest('div')?.parentElement as HTMLElement
  fireEvent.click(within(contenitore).getByRole('button', { name: 'Mostra o nascondi l’elenco' }))
}

const campoNome = () => screen.getByLabelText('Nome')
const campoCognome = () => screen.getByLabelText('Cognome')
const campoEmail = () => screen.getByLabelText(/Email \(Genera Credenziali\)/)
const campoSesso = () => screen.getByLabelText('Sesso')
const campoData = () => screen.getByLabelText('Data di Nascita')
const campoCf = () => screen.getByLabelText(/Codice Fiscale/)
const campoProvincia = () => screen.getByRole('combobox', { name: 'Provincia di nascita' })
const campoComune = () => screen.getByRole('combobox', { name: /Comune di nascita|Stato di nascita/ })
const salva = () => screen.getByRole('button', { name: 'Salva Profilo' })
const usaQuesto = () => screen.getByRole('button', { name: 'Usa questo' })

/** Il badge per `id`: le tendine portano ciascuna una `role="status"` propria. */
const badgeCf = () => {
  const id = campoCf().getAttribute('aria-describedby')
  return id ? document.getElementById(id) : null
}

/** Il codice PROPOSTO dal badge, letto dal `<code>` che lo contiene. */
const codiceProposto = () => badgeCf()?.querySelector('code')?.textContent ?? ''

function compilaAnagrafica() {
  fireEvent.change(campoNome(), { target: { name: 'first_name', value: 'Prova' } })
  fireEvent.change(campoCognome(), { target: { name: 'last_name', value: 'Esempio' } })
  fireEvent.change(campoSesso(), { target: { name: 'gender', value: 'F' } })
  fireEvent.change(campoData(), { target: { name: 'birth_date', value: '1985-03-07' } })
}

async function scegliNapoli() {
  apri(campoProvincia())
  fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
  await waitFor(() => expect(campoComune()).toBeEnabled())
  apri(campoComune())
  fireEvent.click(screen.getByRole('option', { name: 'NAPOLI' }))
}

/** Il corpo dell'ultima POST verso `/api/admin/adults`, già decodificato. */
function ultimoCorpoInviato(): Record<string, unknown> {
  const chiamate = (fetch as unknown as { mock: { calls: [RequestInfo, RequestInit?][] } }).mock.calls
  const post = chiamate.filter((c) => String(c[0]).includes('/api/admin/adults')).at(-1)
  return JSON.parse(String(post?.[1]?.body ?? '{}'))
}

beforeEach(() => {
  vi.stubGlobal('fetch', fintaRete())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── §1 · LA CASCATA COMPILA IL CODICE ────────────────────────────────────────

describe('§1 · il codice fiscale si PROPONE dalla cascata', () => {
  it('scelti provincia e comune, il campo resta vuoto e il badge offre il codice', async () => {
    render(<AdultRegistryForm />)
    compilaAnagrafica()
    expect(campoCf()).toHaveValue('')

    await scegliNapoli()

    // Il campo NON si autocompila: il calcolato vive nella proposta.
    expect(campoCf()).toHaveValue('')
    const codice = codiceProposto()
    expect(codice).toMatch(/^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$/)
    expect(codice.slice(0, 3)).toBe('SMP')
    expect(codice.slice(11, 15)).toBe('H501')

    fireEvent.click(usaQuesto())
    expect(campoCf()).toHaveValue(codice)
  })

  it('cancellato il contenuto, il campo RESTA vuoto', async () => {
    render(<AdultRegistryForm />)
    compilaAnagrafica()
    await scegliNapoli()
    fireEvent.click(usaQuesto())
    expect((campoCf() as HTMLInputElement).value).not.toBe('')

    fireEvent.change(campoCf(), { target: { name: 'fiscal_code', value: '' } })
    expect(campoCf()).toHaveValue('')
  })

  it('il sesso nasce VUOTO e senza di esso non c’è niente da proporre', async () => {
    render(<AdultRegistryForm />)
    // Il difetto storico in una riga: qui c'era «Maschio» selezionato da nessuno.
    expect(campoSesso()).toHaveValue('')

    fireEvent.change(campoNome(), { target: { name: 'first_name', value: 'Prova' } })
    fireEvent.change(campoCognome(), { target: { name: 'last_name', value: 'Esempio' } })
    fireEvent.change(campoData(), { target: { name: 'birth_date', value: '1985-03-07' } })
    await scegliNapoli()

    expect(campoCf()).toHaveValue('')
    expect(badgeCf()).toBeNull()

    fireEvent.change(campoSesso(), { target: { name: 'gender', value: 'M' } })
    await waitFor(() => expect(codiceProposto()).not.toBe(''))
  })
})

// ── §2 · QUELLO DIGITATO A MANO VINCE ────────────────────────────────────────

describe('§2 · quello digitato a mano non viene sovrascritto', () => {
  it('il codice scritto prima della scelta del comune resta al suo posto', async () => {
    render(<AdultRegistryForm />)
    compilaAnagrafica()
    fireEvent.change(campoCf(), { target: { name: 'fiscal_code', value: 'AAAAAA00A00A000A' } })

    await scegliNapoli()

    expect(campoCf()).toHaveValue('AAAAAA00A00A000A')
  })
})

// ── §3 · IL BADGE SI VEDE, E IL SALVATAGGIO PARTE ────────────────────────────

describe('§3 · il badge segnala e il salvataggio funziona', () => {
  it('il corpo porta il codice ADOTTATO, il Belfiore e `emails` al PLURALE', async () => {
    render(<AdultRegistryForm />)
    compilaAnagrafica()
    fireEvent.change(campoEmail(), { target: { name: 'email', value: 'segreteria@example.test' } })
    await scegliNapoli()
    fireEvent.click(usaQuesto())
    const adottato = (campoCf() as HTMLInputElement).value

    fireEvent.click(salva())

    await waitFor(() => expect(ultimoCorpoInviato().first_name).toBe('Prova'))
    const corpo = ultimoCorpoInviato()
    expect(corpo.fiscal_code).toBe(adottato)
    expect(corpo.codice_belfiore_nascita).toBe('H501')
    expect(corpo.birth_place).toBe('NAPOLI')
    expect(corpo.birth_province).toBe('NA')
    // ⚠️ La chiave che la rotta legge davvero. Col solo `email` rispondeva 400.
    expect(corpo.emails).toEqual(['segreteria@example.test'])
    await waitFor(() => expect(screen.getByText(/Adulto salvato/)).toBeInTheDocument())
  })

  it('badge rosso su un codice incoerente, e il salvataggio parte lo stesso', async () => {
    render(<AdultRegistryForm />)
    compilaAnagrafica()
    await scegliNapoli()
    fireEvent.change(campoCf(), { target: { name: 'fiscal_code', value: 'BBBBBB00B00B000B' } })

    const badge = badgeCf()
    expect(badge).not.toBeNull()
    expect(badge).toHaveTextContent('Codice fiscale non coerente con i dati inseriti')
    expect(salva()).not.toBeDisabled()

    fireEvent.click(salva())
    await waitFor(() => expect(ultimoCorpoInviato().fiscal_code).toBe('BBBBBB00B00B000B'))
  })

  it('senza luogo di nascita il codice catastale parte `null`, non stringa vuota', async () => {
    render(<AdultRegistryForm />)
    compilaAnagrafica()

    fireEvent.click(salva())

    await waitFor(() => expect(ultimoCorpoInviato().last_name).toBe('Esempio'))
    expect(ultimoCorpoInviato().codice_belfiore_nascita).toBeNull()
  })

  it('il vincolo UNIQUE diventa una frase leggibile, annunciata come `alert`', async () => {
    vi.stubGlobal('fetch', fintaRete({
      stato: 500,
      corpo: { error: 'duplicate key value violates unique constraint "parents_fiscal_code_key"' },
    }))
    render(<AdultRegistryForm />)
    compilaAnagrafica()
    await scegliNapoli()
    fireEvent.click(usaQuesto())

    fireEvent.click(salva())

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent('Esiste già un genitore con questo codice fiscale')
    expect(avviso).not.toHaveTextContent('constraint')
    // I dati compilati sono ancora lì: si corregge e si riprova.
    expect(campoNome()).toHaveValue('Prova')
    expect((campoCf() as HTMLInputElement).value).not.toBe('')
  })

  it('il campo lasciato vuoto esce vuoto: nessun codice calcolato si intrufola nel corpo', async () => {
    render(<AdultRegistryForm />)
    compilaAnagrafica()
    await scegliNapoli()
    // Nessun clic su «Usa questo»: il codice è calcolabile ma nessuno l'ha adottato.
    expect(codiceProposto()).not.toBe('')

    fireEvent.click(salva())

    await waitFor(() => expect(ultimoCorpoInviato().first_name).toBe('Prova'))
    expect(ultimoCorpoInviato().fiscal_code).toBe('')
  })
})

// ── §4 · IL CAMPO MAI COMPILATO NON È UN ERRORE ──────────────────────────────

describe('§4 · nessun rosso su ciò che nessuno ha ancora scritto', () => {
  it('scheda appena aperta: nessun badge, nessun avviso', () => {
    render(<AdultRegistryForm />)
    expect(campoCf()).toHaveValue('')
    expect(badgeCf()).toBeNull()
    expect(screen.queryByText(/non coerente/)).toBeNull()
    expect(screen.queryByText('Non verificabile')).toBeNull()
  })

  it('anagrafica a metà, nessun codice: si resta neutri', () => {
    render(<AdultRegistryForm />)
    fireEvent.change(campoCognome(), { target: { name: 'last_name', value: 'Esempio' } })
    expect(badgeCf()).toBeNull()
    expect(screen.queryByText('Non verificabile')).toBeNull()
  })
})

// ── §5 · GLI `id` SONO UNICI PER SCHEDA ──────────────────────────────────────

describe('§5 · due schede nello stesso albero non si rubano il fuoco', () => {
  it('nessun `id` duplicato, e ogni `htmlFor` trova un campo solo', async () => {
    const { container } = render(
      <>
        <AdultRegistryForm />
        <AdultRegistryForm />
      </>,
    )
    await waitFor(() => expect(container.querySelectorAll('input[name="fiscal_code"]')).toHaveLength(2))

    const tuttiGliId = Array.from(container.querySelectorAll('[id]')).map((el) => el.id)
    expect(tuttiGliId.length).toBeGreaterThan(0)
    expect(new Set(tuttiGliId).size).toBe(tuttiGliId.length)

    for (const etichetta of Array.from(container.querySelectorAll('label[for]'))) {
      const bersaglio = etichetta.getAttribute('for')!
      expect(container.querySelectorAll(`[id="${CSS.escape(bersaglio)}"]`)).toHaveLength(1)
    }
  })
})
