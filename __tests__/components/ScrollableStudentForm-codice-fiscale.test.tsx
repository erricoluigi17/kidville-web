import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRef } from 'react'
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react'

import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'
import { calcolaCodiceFiscale } from '@/lib/fiscale/calcolo'
import itShared from '../../messages/it/shared.json'
import itAdminStudents from '../../messages/it/adminStudents.json'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * «Nuova anagrafica» — il codice fiscale si CALCOLA, non si chiede alla rete.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Fino al 2026-08-11 il campo era pilotato da un `useEffect` con 800 ms di debounce
 * attorno a `fetchFiscalCode` — una libreria da 425 KB in un chunk del browser — e
 * quell'effetto SOVRASCRIVEVA il campo: chi digitava il codice letto sul tesserino
 * se lo vedeva cambiare sotto le dita ottocento millisecondi dopo. Su un omocodico
 * (che l'Agenzia assegna quando due persone collidono, e che NESSUNA anagrafica può
 * calcolare) quel gesto sostituiva il codice vero di un bambino con uno inventato.
 *
 * Le quattro cose che qui si misurano, e che sono le quattro decisioni del lavoro:
 *
 *  1. il codice si compone scegliendo provincia → comune → data, senza rete e senza
 *     attese: `calcolaCodiceFiscale` è puro e sincrono, e il comune serve per il suo
 *     CODICE CATASTALE — «Napoli» scritto a mano non produce niente, `H501` sì;
 *  2. quello DIGITATO A MANO non si sovrascrive mai, nemmeno cambiando i dati da cui
 *     il calcolo dipende;
 *  3. il badge di coerenza compare, e il salvataggio funziona LO STESSO: segnala,
 *     non blocca. È una decisione del titolare, non un ripiego;
 *  4. il codice catastale scelto viaggia nel payload (`codice_belfiore_nascita`), e
 *     `null` quando non c'è: la colonna è nullable e il testo del comune resta.
 *
 * ⚠️ Nessun dato di persona in questo file (repository PUBBLICO): nomi di fantasia,
 * toponimi e codici catastali — dati aperti dell'Agenzia delle Entrate. I codici
 * fiscali attesi non sono scritti a mano: si CALCOLANO qui accanto con la stessa
 * funzione del prodotto, così nel sorgente non finisce nessun codice con checksum
 * valida.
 *
 * ⚠️ I TESTI SI IMPORTANO DAL CATALOGO, non si ricopiano. Non è pulizia: l'11 agosto
 * alle 01:17 la corsia del badge ha cambiato `cfMancaLuogoNascita` in
 * `messages/it/shared.json` e i file di collaudo di questa corsia — che quella frase
 * la tenevano scritta a mano — sono diventati rossi in modo deterministico, su un
 * apostrofo, mentre il prodotto era sanissimo. Un test che ricopia il glossario
 * misura il glossario, non il prodotto: qui si asserisce sulle CHIAVI.
 *
 * ⚠️ FIN DOVE ARRIVA IL PUNTO 4, detto con precisione. «Viaggia nel payload» vuol
 * dire esattamente questo: il corpo che il componente CONSEGNA. Non dice niente su
 * ciò che il server accetta, e fino all'11 agosto le due cose divergevano — la rotta
 * `POST`/`PATCH /api/admin/students` scartava `codice_belfiore_nascita` in silenzio
 * (`postBodySchema` non è strict, `allowedFields` non lo elencava) e questo caso
 * restava VERDE mentre in archivio non arrivava niente. La rotta è riparata; la metà
 * mancante — il campo che sopravvive fino alla riga scritta — si misura in
 * `__tests__/api/admin-students-belfiore.test.ts`. Un payload corretto contro una
 * rotta che lo scarta è verde in perpetuo: serve la misura sulla ROTTA, non solo
 * questa.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }],
    selezionate: [],
    effettive: [SEDE_A],
    sedeCorrente: SEDE_A,
    reFetchKey: SEDE_A,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

const COMUNI_NA = [
  { belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true },
  { belfiore: 'E054', nome: 'GIUGLIANO IN CAMPANIA', sigla: 'NA', attivo: true },
]

/** Quello che `GET /api/anagrafiche/comuni` risponde: §5 lo sostituisce. */
let comuniRisposta: { belfiore: string; nome: string; sigla: string; attivo: boolean }[] = COMUNI_NA

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  comuniRisposta = COMUNI_NA
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname === '/api/anagrafiche/comuni') {
      return Promise.resolve({ ok: true, json: async () => ({ comuni: comuniRisposta }) })
    }
    return Promise.resolve({ ok: true, json: async () => [] })
  })
  vi.stubGlobal('fetch', fetchMock)
})


import { ScrollableStudentForm, type StudentFormHandle } from '@/components/features/admin/ScrollableStudentForm'

/** L'anagrafica di prova, e il codice che IMPLICA. Nessun bambino vero. */
const ADA = { nome: 'Ada', cognome: 'Verdi', dataIso: '2022-01-01', dataIt: '01/01/2022' }
const esitoAda = calcolaCodiceFiscale({
  nome: ADA.nome,
  cognome: ADA.cognome,
  sesso: 'M',
  dataNascita: ADA.dataIso,
  codiceBelfiore: 'H501',
})
const CF_ADA = esitoAda.ok ? esitoAda.codice : ''

const campo = (nome: string) => document.querySelector(`input[name="${nome}"]`) as HTMLInputElement
const campoCf = () => campo('codice_fiscale')

function scrivi(nome: string, valore: string) {
  fireEvent.change(campo(nome), { target: { name: nome, value: valore } })
}

/** Apre la tendina di un Combobox dal suo pulsante «Mostra o nascondi l'elenco». */
function apriTendina(elemento: HTMLElement) {
  const contenitore = elemento.closest('div')?.parentElement as HTMLElement
  fireEvent.click(within(contenitore).getByRole('button', { name: itShared.anagCommutaElenco }))
}

async function scegliLuogoNascita(comune = 'NAPOLI') {
  apriTendina(screen.getByRole('combobox', { name: itShared.anagProvinciaEtichetta }))
  fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
  await waitFor(() => expect(screen.getByRole('combobox', { name: itShared.anagComuneEtichetta })).toBeEnabled())
  apriTendina(screen.getByRole('combobox', { name: itShared.anagComuneEtichetta }))
  fireEvent.click(screen.getByRole('option', { name: comune }))
}

function valida(ref: React.RefObject<StudentFormHandle | null>) {
  let esito: ReturnType<StudentFormHandle['validate']> | undefined
  act(() => {
    esito = ref.current!.validate()
  })
  return esito!
}

describe('§1 · il codice si compila scegliendo provincia → comune → data', () => {
  it('con nome, cognome, sesso, data e comune il campo mostra il codice calcolato — senza nessuna attesa', async () => {
    render(<ScrollableStudentForm />)

    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    // Finché il comune non è scelto NON c'è codice catastale, quindi niente codice:
    // meglio un campo vuoto che un codice costruito su un comune indovinato.
    expect(campoCf().value).toBe('')

    await scegliLuogoNascita()

    // Nessun `advanceTimersByTime`, nessun `waitFor` sul campo: il calcolo è
    // sincrono e il valore c'è già al render successivo alla scelta.
    expect(campoCf().value).toBe(CF_ADA)
    expect(CF_ADA).toHaveLength(16)
  })

  it('cambiare il sesso ricalcola il codice: sono i due caratteri del giorno', async () => {
    render(<ScrollableStudentForm />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    await scegliLuogoNascita()

    const alMaschile = campoCf().value
    fireEvent.change(document.querySelector('select[name="sesso"]')!, { target: { name: 'sesso', value: 'F' } })
    const alFemminile = campoCf().value

    expect(alFemminile).not.toBe(alMaschile)
    // 40 al giorno di nascita: 01 → 41. È l'unica differenza fra i due codici.
    expect(alFemminile.slice(0, 9)).toBe(alMaschile.slice(0, 9))
    expect(alFemminile.slice(9, 11)).toBe('41')
  })

  it('la rete NON viene mai interpellata per il codice fiscale: si chiedono solo i comuni', async () => {
    render(<ScrollableStudentForm />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    await scegliLuogoNascita()

    const chiamate = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(chiamate.every((u) => u.startsWith('/api/anagrafiche/comuni') || u.startsWith('/api/admin/sections'))).toBe(true)
  })
})

describe('§2 · quello digitato a mano NON viene sovrascritto', () => {
  it('il codice digitato resta anche cambiando la data di nascita', async () => {
    render(<ScrollableStudentForm />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    await scegliLuogoNascita()
    expect(campoCf().value).toBe(CF_ADA)

    // Il codice letto sul tesserino: un omocodico, che nessuna anagrafica calcola.
    const AMANO = 'ZZZQWE00L00M000K'
    scrivi('codice_fiscale', AMANO)
    expect(campoCf().value).toBe(AMANO)

    fireEvent.change(campo('data_nascita'), { target: { value: '02/02/2021' } })
    await waitFor(() => expect(campoCf().value).toBe(AMANO))

    // E nemmeno cambiando il comune, che è l'altra metà del calcolo.
    await scegliLuogoNascita('GIUGLIANO IN CAMPANIA')
    expect(campoCf().value).toBe(AMANO)
  })

  /**
   * ⚠️ QUI SI MISURA UNA DECISIONE DI PRODOTTO, non solo un comportamento del campo.
   * «Vuoto» e «svuotato apposta» in questo modulo non si distinguono — c'è un solo
   * stato, `formData.codice_fiscale === ''` — e `validate()` spedisce il codice
   * MOSTRATO. Conseguenza, scritta perché non venga scoperta per caso: **su
   * un'anagrafica nuova completa il codice fiscale calcolato si salva sempre, e non
   * esiste nessun gesto che permetta di salvare senza.** È accettato perché il record
   * è nuovo (niente in archivio da contraddire) e il codice è esatto per costruzione,
   * col comune preso dalla tendina. Sta all'opposto della scelta di
   * `StudentDetailPanel`, dove il calcolo propone e basta.
   */
  it('svuotare il campo restituisce il suggerimento: su un’anagrafica nuova il codice calcolato si salva sempre', async () => {
    render(<ScrollableStudentForm />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    await scegliLuogoNascita()

    scrivi('codice_fiscale', 'ZZZQWE00L00M000K')
    scrivi('codice_fiscale', '')
    expect(campoCf().value).toBe(CF_ADA)
  })

  /**
   * ⚠️ QUESTA È LA MISURA DELLA DECISIONE, e fino all'11 agosto NON C'ERA.
   *
   * Il test qui sopra guarda il CAMPO; questo guarda il PAYLOAD, ed è l'unico dei
   * due che tocca la riga che rende vera la decisione — `codice_fiscale:
   * codiceFiscaleMostrato` dentro `validate()`. Che mancasse non è un sospetto: una
   * revisione ha cancellato quella riga e i quattro file di collaudo della corsia
   * sono rimasti verdi, 46 su 46, ripetuto cinque volte e anche in isolamento —
   * misura riprodotta da chi scrive. Lo schema dichiara `codice_fiscale:
   * z.string().optional()`, quindi la stringa vuota passa la validazione senza un
   * rumore: senza quella riga ogni alunno inserito da questo modulo sarebbe entrato
   * in archivio SENZA codice fiscale, e nessun test l'avrebbe detto.
   *
   * La copertura era esattamente invertita rispetto alla raggiungibilità: la gemella
   * `StudentRegistryForm`, che nessuna pagina monta, quella mutazione la uccideva
   * (lì lo schema pretende `.length(16)`); questo modulo — l'unico vivo, montato in
   * `FamilyRegistryManager.tsx:294` — non aveva niente.
   *
   * Perciò qui NON si scrive mai nel campo del codice fiscale: si compila solo
   * l'anagrafica, e si pretende che nel payload ci sia il codice CALCOLATO. E si
   * asserisce anche `!== ''` in modo esplicito, perché la stringa vuota è
   * precisamente ciò che passerebbe in silenzio.
   */
  it('senza digitare NIENTE nel campo, il payload porta il codice calcolato — mai la stringa vuota', async () => {
    const ref = createRef<StudentFormHandle>()
    render(<ScrollableStudentForm ref={ref} />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    await scegliLuogoNascita()

    // La premessa, misurata e non supposta: nel campo non è stato digitato nulla,
    // e quello che si vede è il suggerimento del calcolo.
    expect(campoCf().value).toBe(CF_ADA)

    const esito = valida(ref)
    expect(esito.ok).toBe(true)
    expect(esito.ok && esito.data.codice_fiscale).toBe(CF_ADA)
    expect(esito.ok && esito.data.codice_fiscale).not.toBe('')
  })

  it('il codice digitato a mano è quello che finisce nel payload', async () => {
    const ref = createRef<StudentFormHandle>()
    render(<ScrollableStudentForm ref={ref} />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    await scegliLuogoNascita()
    scrivi('codice_fiscale', 'ZZZQWE00L00M000K')

    const esito = valida(ref)
    expect(esito.ok).toBe(true)
    expect(esito.ok && esito.data.codice_fiscale).toBe('ZZZQWE00L00M000K')
  })
})

describe('§3 · il badge appare, e il salvataggio funziona lo stesso', () => {
  it('un codice che contraddice l’anagrafica accende il badge E lascia passare il payload', async () => {
    const ref = createRef<StudentFormHandle>()
    render(<ScrollableStudentForm ref={ref} />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    await scegliLuogoNascita()

    // Stesso codice, prime tre lettere diverse: il carattere di controllo non
    // torna più. Costruito dal calcolato, così nel sorgente non c'è nessun codice
    // fiscale valido scritto a mano.
    const CF_SBAGLIATO = `ZZZ${CF_ADA.slice(3)}`
    scrivi('codice_fiscale', CF_SBAGLIATO)

    expect(await screen.findByText(itShared.cfIncoerenteTitolo)).toBeInTheDocument()

    const esito = valida(ref)
    expect(esito.ok).toBe(true)
    expect(esito.ok && esito.data.codice_fiscale).toBe(CF_SBAGLIATO)
  })

  it('senza codice fiscale il badge NON dipinge niente: un campo da compilare non è un errore', () => {
    render(<ScrollableStudentForm />)
    scrivi('nome', ADA.nome)

    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
    expect(screen.queryByText(itShared.cfNonVerificabileTitolo)).toBeNull()
  })

  /**
   * ⚠️ IL TERZO STATO, che qui mancava. §3 misurava il ROSSO e il NIENTE; il GIALLO —
   * «non verificabile» — era asserito solo in `StudentDetailPanel`, e la richiesta di
   * revisione chiede che i tre stati restino distinti IN OGNI SCHERMATA, non in una.
   *
   * Lo stato è raggiungibile con un gesto normale: si digita il codice letto sul
   * tesserino PRIMA di scegliere il comune. `codice_belfiore_nascita` è ancora vuoto,
   * quindi `verificaCoerenza` non può confrontare il luogo di nascita e restituisce
   * `nonVerificabili: ['luogo-nascita']` con `coerente: true`. Il codice qui è quello
   * che l'anagrafica implica davvero: tutto il resto torna, e ciò che manca è un dato
   * NOSTRO — non un errore di chi ha digitato. Se questa schermata dipingesse rosso
   * qui, dipingerebbe rosso metà archivio, che è l'esito contro cui esiste il giallo.
   */
  it('un codice digitato prima di scegliere il comune ⇒ GIALLO «non verificabile», non rosso', async () => {
    render(<ScrollableStudentForm />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    // Nessuna scelta nel luogo di nascita: è la premessa del caso.
    scrivi('codice_fiscale', CF_ADA)

    expect(await screen.findByText(itShared.cfNonVerificabileTitolo)).toBeInTheDocument()
    expect(screen.getByText(itShared.cfMancaLuogoNascita)).toBeInTheDocument()
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
  })
})

describe('§4 · il codice catastale nel payload, e il testo del comune che non si perde', () => {
  it('il comune scelto porta con sé il proprio codice catastale', async () => {
    const ref = createRef<StudentFormHandle>()
    render(<ScrollableStudentForm ref={ref} />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    await scegliLuogoNascita()

    const esito = valida(ref)
    expect(esito.ok).toBe(true)
    expect(esito.ok && esito.data).toMatchObject({
      comune_nascita: 'NAPOLI',
      provincia_nascita: 'NA',
      nazione_nascita: 'Italia',
      codice_belfiore_nascita: 'H501',
    })
  })

  /**
   * ⚠️ IL TITOLO DICE CIÒ CHE IL CORPO MISURA, e la storia va scritta: fino all'11
   * agosto questo test si chiamava «il codice catastale è `null`, non una stringa
   * vuota» e `null` non lo asseriva da nessuna parte. Una revisione l'ha dimostrato
   * per mutazione: sostituendo `formData.codice_belfiore_nascita || null` con la
   * stringa vuota nuda, i dieci test restavano verdi.
   *
   * Il `null` in questo modulo NON è osservabile nel payload: il payload non esce
   * proprio: `comune_nascita` e `codice_belfiore_nascita` si scrivono solo insieme
   * (`cambiaLuogoNascita`), quindi «comune valido» implica «belfiore valido» e in
   * ogni altro caso zod si ferma prima sul comune.
   *
   * Osservabile è invece il suo EFFETTO, ed è quello che conta per chi compila: senza
   * `|| null` la stringa vuota violerebbe `^[A-Z][0-9]{3}$` e comparirebbe un SECONDO
   * errore, sotto un campo che l'operatore non ha nemmeno toccato — «codice catastale
   * non valido» su una scheda in cui l'unica cosa che manca è il comune. Questa
   * asserzione muore se si toglie `|| null`: è la misura, non il titolo.
   */
  it('senza comune scelto il salvataggio si ferma SUL COMUNE, e non inventa un secondo errore sul codice catastale', async () => {
    const ref = createRef<StudentFormHandle>()
    render(<ScrollableStudentForm ref={ref} />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })

    // Solo la provincia: il comune non è stato scelto.
    apriTendina(screen.getByRole('combobox', { name: itShared.anagProvinciaEtichetta }))
    fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: itShared.anagComuneEtichetta })).toBeEnabled())

    const esito = valida(ref)
    expect(esito.ok).toBe(false)
    expect(screen.getByText(itAdminStudents.valComuneNonValido)).toBeInTheDocument()
    expect(screen.queryByText(itAdminStudents.valBelfioreNonValido)).toBeNull()
  })
})

describe('§5 · il codice catastale arriva dalla RETE, e per questo si valida', () => {
  /**
   * Nessuno digita `codice_belfiore_nascita`: lo scrive `cambiaLuogoNascita`, e il
   * valore è `opzione.valore`, cioè il campo `belfiore` di
   * `GET /api/anagrafiche/comuni`. Il `regex` dello schema è quindi un controllo di
   * CONFINE su un dato che non controlliamo — quattro caratteri che entrano nel
   * codice fiscale di un bambino e ci restano per tutta la vita della scheda.
   *
   * Questo test esiste perché una revisione aveva rilevato, correttamente, che la
   * chiave `valBelfioreNonValido` non era raggiunta da nessun test e sembrava una
   * traduzione per un messaggio che nessuno può leggere. Il percorso c'è, ed è
   * questo: si accende quando la rotta risponde con un codice fuori forma.
   */
  it('un `belfiore` malformato dalla rotta NON si salva: il salvataggio si ferma e lo span lo dice', async () => {
    comuniRisposta = [{ belfiore: 'XX99', nome: 'COMUNE MALFORMATO', sigla: 'NA', attivo: true }]

    const ref = createRef<StudentFormHandle>()
    render(<ScrollableStudentForm ref={ref} />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    await scegliLuogoNascita('COMUNE MALFORMATO')

    // Il comune c'è ed è valido per lo schema: l'unica cosa che non torna è il codice.
    const esito = valida(ref)
    expect(esito.ok).toBe(false)

    const avviso = await screen.findByText(itAdminStudents.valBelfioreNonValido)
    expect(avviso).toBeInTheDocument()
    expect(avviso).toHaveAttribute('role', 'alert')
    // Non è il comune ad essere in errore: quello l'operatore l'ha scelto.
    expect(screen.queryByText(itAdminStudents.valComuneNonValido)).toBeNull()
  })
})

describe('§6 · il verdetto si può SENTIRE, non solo vedere', () => {
  /**
   * `role="status"` non promette nessun annuncio (il badge nasce insieme al proprio
   * contenuto): la via dichiarata è `aria-describedby` dal campo del codice fiscale.
   * Le tre schede adulto lo fanno tutte; fino all'11 agosto nessuna delle tre schede
   * alunno lo faceva.
   */
  it('il campo del codice fiscale punta al badge, con un `id` proprio di questa scheda', async () => {
    render(<ScrollableStudentForm />)
    scrivi('nome', ADA.nome)
    scrivi('cognome', ADA.cognome)
    fireEvent.change(campo('data_nascita'), { target: { value: ADA.dataIt } })
    await scegliLuogoNascita()
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
