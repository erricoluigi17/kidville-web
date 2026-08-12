import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'

import { calcolaCodiceFiscale } from '@/lib/fiscale/calcolo'
import itShared from '../../messages/it/shared.json'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * `StudentRegistryForm` — il codice fiscale calcolato, e il salvataggio che non
 * si rompe quando la colonna non c'è.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Questa scheda è la gemella di `ScrollableStudentForm` (che è quella montata dal
 * cockpit), e differisce in una cosa che qui conta: SPEDISCE DA SÉ. È quindi il solo
 * dei tre file in cui si può montare un ritento sulla risposta della rotta.
 *
 * ⚠️ DUE PREMESSE ONESTE, che valgono per tutto il file e in particolare per §4.
 *
 *  a. **`StudentRegistryForm` oggi non è montato da nessuna parte** — misurato con un
 *     grep su tutto `src`: l'unico riferimento è in questi test (lo dice anche la
 *     testata di `StudentRegistryForm-placeholder.test.tsx`). Quello che si misura qui
 *     è codice reale e sotto gate, ma nessun utente lo raggiunge.
 *  b. **Il ritento su `PGRST204` è un RAMO PREVENTIVO, non un degrado end-to-end.**
 *     Oggi quell'errore la rotta non può produrlo: `postBodySchema`
 *     (`src/app/api/admin/students/route.ts`, ≈riga 26) non dichiara
 *     `codice_belfiore_nascita`, e `z.object` scarta le chiavi che non conosce — il
 *     campo muore nel parse, l'INSERT non lo nomina, PostgREST non ha di che
 *     lamentarsi. Il test di §4 costruisce quindi a mano una risposta che la rotta
 *     VERA non restituisce: misura il RAMO, e va letto per quello. Diventerà una
 *     misura del degrado reale il giorno in cui la rotta nominerà la colonna — e da
 *     quel giorno, senza quel ramo, la creazione di un alunno si romperebbe sull'E2E
 *     della CI, il cui database non è migrato.
 *
 * La regola che il ramo implementa resta quella giusta: un codice catastale mancante
 * non può impedire l'iscrizione di un bambino. Si ritenta una volta senza quel campo,
 * si logga la colonna caduta NOMINANDOLA, e il resto si salva.
 *
 * ⚠️ Nessun dato di persona (repository PUBBLICO): nomi di fantasia, toponimi e
 * codici catastali. Il codice fiscale atteso si CALCOLA con la funzione del
 * prodotto, così nel sorgente non compare nessun codice con checksum valida.
 *
 * ⚠️ I TESTI DEL CATALOGO SI IMPORTANO, non si ricopiano: un test che ricopia il
 * glossario diventa rosso quando qualcun altro corregge un apostrofo, e misura il
 * glossario invece del prodotto (successo l'11 agosto alle 01:17, su
 * `cfMancaLuogoNascita`). Restano letterali — e devono — «Avanti», «Salva
 * Anagrafica» e «Anagrafica salvata con successo!»: in QUESTO componente non
 * passano da `next-intl`, sono scritte a mano nel sorgente
 * (`StudentRegistryForm.tsx`, righe ≈279 e ≈555-562), quindi non esiste una chiave
 * da importare. Importarle da un catalogo qualsiasi sarebbe la stessa copia, con
 * un passaggio in più a nasconderla.
 */

const logSpia = vi.fn()
vi.mock('@/lib/logging/client', () => ({
  logClient: (...a: unknown[]) => logSpia(...a),
  nomeErrore: () => 'TypeError',
}))

const COMUNI_NA = [
  { belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true },
  { belfiore: 'E054', nome: 'GIUGLIANO IN CAMPANIA', sigla: 'NA', attivo: true },
]

/** Le risposte di `POST /api/admin/students`, una per chiamata, in ordine. */
let risposteSalvataggio: { ok: boolean; corpo: unknown }[] = []
const corpiInviati: Record<string, unknown>[] = []

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  logSpia.mockClear()
  corpiInviati.length = 0
  risposteSalvataggio = [{ ok: true, corpo: { id: 'nuovo' } }]
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname === '/api/anagrafiche/comuni') {
      return Promise.resolve({ ok: true, json: async () => ({ comuni: COMUNI_NA }) })
    }
    if (u.pathname === '/api/admin/students') {
      corpiInviati.push(JSON.parse(String(init?.body ?? '{}')))
      const r = risposteSalvataggio.shift() ?? { ok: true, corpo: {} }
      return Promise.resolve({ ok: r.ok, status: r.ok ? 200 : 400, json: async () => r.corpo })
    }
    return Promise.resolve({ ok: true, json: async () => [] })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import { StudentRegistryForm } from '@/components/features/admin/StudentRegistryForm'

const ADA = { nome: 'Ada', cognome: 'Verdi', dataIt: '2022-01-01' }
const esitoAda = calcolaCodiceFiscale({
  nome: ADA.nome,
  cognome: ADA.cognome,
  sesso: 'M',
  dataNascita: ADA.dataIt,
  codiceBelfiore: 'H501',
})
const CF_ADA = esitoAda.ok ? esitoAda.codice : ''

const campo = (nome: string) => document.querySelector(`input[name="${nome}"]`) as HTMLInputElement
const campoCf = () => campo('codice_fiscale')

function scrivi(nome: string, valore: string) {
  fireEvent.change(campo(nome), { target: { name: nome, value: valore } })
}

function apriTendina(elemento: HTMLElement) {
  const contenitore = elemento.closest('div')?.parentElement as HTMLElement
  fireEvent.click(within(contenitore).getByRole('button', { name: new RegExp('^' + itShared.anagCommutaElenco) }))
}

async function scegliLuogoNascita(comune = 'NAPOLI') {
  apriTendina(screen.getByRole('combobox', { name: itShared.anagProvinciaEtichetta }))
  fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
  await waitFor(() => expect(screen.getByRole('combobox', { name: itShared.anagComuneEtichetta })).toBeEnabled())
  apriTendina(screen.getByRole('combobox', { name: itShared.anagComuneEtichetta }))
  fireEvent.click(screen.getByRole('option', { name: comune }))
}

/** Il passo 1 completo: anagrafica + luogo di nascita dalla tendina. */
async function compilaPassoUno() {
  scrivi('nome', ADA.nome)
  scrivi('cognome', ADA.cognome)
  fireEvent.change(campo('data_nascita'), { target: { name: 'data_nascita', value: ADA.dataIt } })
  await scegliLuogoNascita()
}

/** Il passo 2: la residenza, che lo schema pretende per il salvataggio. */
function compilaResidenza() {
  fireEvent.click(screen.getByText('Avanti'))
  scrivi('indirizzo_residenza', 'Via delle Prove 10')
  scrivi('comune_residenza', 'Napoli')
  scrivi('cap', '80100')
}

function vaiAlPassoFinaleESalva() {
  fireEvent.click(screen.getByText('Avanti'))
  fireEvent.click(screen.getByText('Avanti'))
  fireEvent.click(screen.getByText('Salva Anagrafica'))
}

describe('§1 · provincia → comune → data compongono il codice, senza rete', () => {
  it('il campo mostra il codice calcolato appena il comune è scelto', async () => {
    render(<StudentRegistryForm />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { name: 'data_nascita', value: ADA.dataIt } })
    // Senza codice catastale non si indovina niente: il campo resta vuoto.
    expect(campoCf().value).toBe('')

    await scegliLuogoNascita()
    expect(campoCf().value).toBe(CF_ADA)
  })

  it('nessuna chiamata di rete per il codice fiscale: si chiedono solo i comuni', async () => {
    render(<StudentRegistryForm />)
    await compilaPassoUno()
    const chiamate = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(chiamate.every((u) => u.startsWith('/api/anagrafiche/comuni'))).toBe(true)
  })
})

describe('§2 · quello digitato a mano NON viene sovrascritto', () => {
  it('cambiando comune e data il codice digitato resta quello', async () => {
    render(<StudentRegistryForm />)
    await compilaPassoUno()

    const AMANO = 'ZZZQWE00L00M000K'
    scrivi('codice_fiscale', AMANO)
    fireEvent.change(campo('data_nascita'), { target: { name: 'data_nascita', value: '2021-02-02' } })
    await scegliLuogoNascita('GIUGLIANO IN CAMPANIA')

    expect(campoCf().value).toBe(AMANO)
  })

  it('è il codice digitato quello che parte verso il server', async () => {
    render(<StudentRegistryForm />)
    await compilaPassoUno()
    const AMANO = 'ZZZQWE00L00M000K'
    scrivi('codice_fiscale', AMANO)
    compilaResidenza()
    vaiAlPassoFinaleESalva()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect(corpiInviati[0].codice_fiscale).toBe(AMANO)
  })
})

describe('§3 · il badge appare, e il salvataggio funziona lo stesso', () => {
  it('con un codice che contraddice l’anagrafica il badge si accende E il POST parte', async () => {
    render(<StudentRegistryForm />)
    await compilaPassoUno()

    const CF_SBAGLIATO = `ZZZ${CF_ADA.slice(3)}`
    scrivi('codice_fiscale', CF_SBAGLIATO)
    expect(await screen.findByText(itShared.cfIncoerenteTitolo)).toBeInTheDocument()

    compilaResidenza()
    vaiAlPassoFinaleESalva()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect(corpiInviati[0].codice_fiscale).toBe(CF_SBAGLIATO)
  })

  it('senza codice fiscale non compare nessun badge: un campo da compilare non è un errore', () => {
    render(<StudentRegistryForm />)
    scrivi('nome', ADA.nome)
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
    expect(screen.queryByText(itShared.cfNonVerificabileTitolo)).toBeNull()
  })

  /**
   * ⚠️ IL TERZO STATO, che qui mancava: §3 misurava il ROSSO e il NIENTE, e il
   * GIALLO era asserito solo in `StudentDetailPanel`. I tre stati devono restare
   * distinti IN OGNI SCHERMATA — se in una il giallo cade nel rosso, quella
   * schermata dipinge di rosso metà archivio e si smette di guardarla.
   *
   * Si arriva al giallo con un gesto normale: digitare il codice letto sul
   * tesserino prima di aver scelto il comune. `codice_belfiore_nascita` è vuoto,
   * `verificaCoerenza` non può confrontare il luogo e risponde `coerente: true`
   * con `nonVerificabili: ['luogo-nascita']`. Manca un dato NOSTRO, non c'è nessun
   * errore di chi ha digitato.
   */
  it('un codice digitato prima di scegliere il comune ⇒ GIALLO «non verificabile», non rosso', async () => {
    render(<StudentRegistryForm />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { name: 'data_nascita', value: ADA.dataIt } })
    // Nessuna scelta nel luogo di nascita: è la premessa del caso.
    scrivi('codice_fiscale', CF_ADA)

    expect(await screen.findByText(itShared.cfNonVerificabileTitolo)).toBeInTheDocument()
    expect(screen.getByText(itShared.cfMancaLuogoNascita)).toBeInTheDocument()
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
  })

  /**
   * `role="status"` non promette nessun annuncio (il badge nasce insieme al proprio
   * contenuto): la via dichiarata per SENTIRE il verdetto è `aria-describedby` dal
   * campo del codice fiscale, come già fanno le tre schede adulto.
   */
  it('il campo del codice fiscale punta al badge, con un `id` proprio di questa scheda', async () => {
    render(<StudentRegistryForm />)
    await compilaPassoUno()
    scrivi('codice_fiscale', `ZZZ${CF_ADA.slice(3)}`)

    const idDescrittore = campoCf().getAttribute('aria-describedby')
    expect(idDescrittore).toBeTruthy()
    expect(idDescrittore).not.toBe('badge-coerenza-cf')

    const badge = document.getElementById(idDescrittore!)
    expect(badge).not.toBeNull()
    expect(badge).toHaveAttribute('role', 'status')
    expect(badge).toHaveTextContent(itShared.cfIncoerenteTitolo)
  })
})

describe('§4 · il codice catastale nel payload, e la colonna che potrebbe non esserci', () => {
  it('il comune scelto porta con sé il proprio codice catastale, e il testo del comune resta', async () => {
    render(<StudentRegistryForm />)
    await compilaPassoUno()
    compilaResidenza()
    vaiAlPassoFinaleESalva()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect(corpiInviati[0]).toMatchObject({
      comune_nascita: 'NAPOLI',
      provincia_nascita: 'NA',
      codice_belfiore_nascita: 'H501',
    })
  })

  /**
   * ⚠️ PROVA DEL RAMO, non del degrado end-to-end: la risposta `PGRST204` qui sotto è
   * costruita a mano, e la rotta vera oggi non la produce (vedi la premessa `b` in
   * cima al file). Etichettato nel titolo perché non venga letto per ciò che non è.
   */
  it('«PGRST204» (risposta costruita a mano): il RAMO ritenta senza la colonna, salva e logga il nome', async () => {
    risposteSalvataggio = [
      { ok: false, corpo: { code: 'PGRST204', message: "Could not find the 'codice_belfiore_nascita' column of 'alunni' in the schema cache" } },
      { ok: true, corpo: { id: 'nuovo' } },
    ]
    render(<StudentRegistryForm />)
    await compilaPassoUno()
    compilaResidenza()
    vaiAlPassoFinaleESalva()

    await waitFor(() => expect(corpiInviati).toHaveLength(2))
    // Primo tentativo: col codice catastale. Secondo: senza, e con tutto il resto.
    expect(corpiInviati[0].codice_belfiore_nascita).toBe('H501')
    expect(corpiInviati[1]).not.toHaveProperty('codice_belfiore_nascita')
    expect(corpiInviati[1]).toMatchObject({ comune_nascita: 'NAPOLI', codice_fiscale: CF_ADA })

    // Nessun errore a schermo: per l'operatore non è successo niente.
    expect(await screen.findByText('Anagrafica salvata con successo!')).toBeInTheDocument()

    // Il log nomina la colonna: «qualcosa è caduto» non si interroga alle tre di notte.
    const messaggi = logSpia.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio)
    expect(messaggi.some((m) => m.includes('colonna-assente:codice_belfiore_nascita'))).toBe(true)
  })

  it('un errore VERO del server resta un errore: si mostra in pagina, con `role="alert"`, e si logga', async () => {
    risposteSalvataggio = [{ ok: false, corpo: { error: 'Sede non consentita' } }]
    render(<StudentRegistryForm />)
    await compilaPassoUno()
    compilaResidenza()
    vaiAlPassoFinaleESalva()

    // Un solo tentativo: non è la colonna mancante, non si ritenta.
    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent('Sede non consentita')

    const messaggi = logSpia.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio)
    expect(messaggi.some((m) => m.includes('alunno-salvataggio-fallito'))).toBe(true)
  })
})
