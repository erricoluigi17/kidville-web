import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'

import { SEDE_A } from '../fixtures/sedi'
import { calcolaCodiceFiscale } from '@/lib/fiscale/calcolo'
import itShared from '../../messages/it/shared.json'
import itAdminStudents from '../../messages/it/adminStudents.json'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Scheda di un alunno GIÀ IN ARCHIVIO — tre stati, e un campo che non si scrive
 * da solo.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Qui si aprono i record veri. Misura sul database di PRODUZIONE (11 agosto): su 33
 * alunni **18 non hanno il codice fiscale**, 18 non hanno il comune di nascita, 17
 * non hanno il sesso. Da questi numeri discendono le due decisioni che questo file
 * misura, e che sono l'opposto di quelle dei due moduli di NUOVA anagrafica:
 *
 *  · **il campo non si riempie da solo.** Nei moduli di inserimento il codice
 *    calcolato compare nel campo vuoto, e va bene: non c'è niente in archivio da
 *    contraddire. Qui no. Chi apre una scheda per cambiare un numero di telefono e
 *    preme «Salva» scriverebbe in archivio, su diciotto bambini e in silenzio, un
 *    codice fiscale che nessun documento ha mai confermato. Il calcolo PROPONE, dal
 *    badge, col suo «Usa questo» — che compila il campo e non salva niente;
 *
 *  · **tre stati, mai due.** `incoerente` (rosso: c'è un codice e contraddice) ·
 *    `non verificabile` (giallo: manca un dato per confrontare) · `da compilare`
 *    (niente: il codice non c'è, e non è un errore). Se il giallo e il rosso si
 *    confondessero, metà archivio sarebbe rossa il primo giorno e il pannello
 *    smetterebbe di essere guardato — comprese le poche righe con un errore vero.
 *
 * ⚠️ Nessun dato di persona (repository PUBBLICO): nomi di fantasia, toponimi e
 * codici catastali. Il codice fiscale atteso si CALCOLA con la funzione del
 * prodotto: nel sorgente non compare nessun codice con checksum valida.
 *
 * ⚠️ I TESTI SI IMPORTANO DAL CATALOGO, non si ricopiano. L'11 agosto alle 01:17 la
 * corsia del badge ha cambiato `cfMancaLuogoNascita` in `messages/it/shared.json` e
 * questo file — che la frase la teneva scritta a mano — è diventato rosso su un
 * apostrofo, con il prodotto sanissimo. Un test che ricopia il glossario misura il
 * glossario: qui si asserisce sulle CHIAVI.
 *
 * ⚠️ COSA QUESTO FILE **NON** MISURA, e dove sta il resto della catena. §3 («il
 * payload porta il codice catastale») e §4 («la chiave assente dal record esce
 * comunque nel payload, valorizzata a `null`») si fermano al CORPO DELLA RICHIESTA:
 * verificano ciò che il componente spedisce, non ciò che il server accetta. Fino
 * all'11 agosto le due cose divergevano — `POST`/`PATCH /api/admin/students`
 * scartavano `codice_belfiore_nascita` in silenzio, `postBodySchema` non essendo
 * strict — e questi due casi erano VERDI mentre in archivio non arrivava niente: la
 * suite che certifica metà catena. La rotta è riparata, e l'altra metà — il campo
 * che sopravvive fino alla riga scritta, su POST e su PATCH — si misura in
 * `__tests__/api/admin-students-belfiore.test.ts`. Le due insieme chiudono il giro;
 * nessuna delle due, da sola, autorizza a dire «il dato si salva».
 */

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => null }))
vi.mock('@/components/features/admin/StudentEconomicSection', () => ({
  StudentEconomicSection: () => null,
}))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

const COMUNI_NA = [
  { belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true },
  { belfiore: 'E054', nome: 'GIUGLIANO IN CAMPANIA', sigla: 'NA', attivo: true },
]

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname === '/api/anagrafiche/comuni') {
      return Promise.resolve({ ok: true, json: async () => ({ comuni: COMUNI_NA }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel'

/** Il codice che l'anagrafica di prova IMPLICA. */
const esitoAda = calcolaCodiceFiscale({
  nome: 'Ada',
  cognome: 'Verdi',
  sesso: 'F',
  dataNascita: '2019-03-07',
  codiceBelfiore: 'H501',
})
const CF_ADA = esitoAda.ok ? esitoAda.codice : ''

/** Il record come esce davvero da `GET /api/admin/students/[id]` oggi: colonna vuota. */
const ALUNNA = {
  id: 'al-1',
  nome: 'Ada',
  cognome: 'Verdi',
  gender: 'F',
  data_nascita: '2019-03-07',
  scuola_id: SEDE_A,
  birth_city: 'NAPOLI',
  birth_province: 'NA',
  birth_nation: 'Italia',
  codice_belfiore_nascita: null as string | null,
  codice_fiscale: null as string | null,
}

function montaPannello(alunno: Partial<typeof ALUNNA> = {}) {
  return montaRecord({ ...ALUNNA, ...alunno })
}

/**
 * Monta il record ESATTAMENTE com'è passato, senza fondere `ALUNNA`: serve per
 * misurare il caso in cui una chiave NON C'È — che è diverso da «vale `null`», ed è
 * l'unico modo per esercitare la riga che scrive `codice_belfiore_nascita` dopo lo
 * spread di `form`.
 */
function montaRecord(alunno: Record<string, unknown> & { id: string }) {
  const onSave = vi.fn()
  render(
    <StudentDetailPanel
      student={alunno}
      onClose={vi.fn()}
      onSave={onSave}
      onDelete={vi.fn()}
      variant="page"
    />,
  )
  return onSave
}

const campoCf = () => document.getElementById('dettaglio-codice-fiscale') as HTMLInputElement

function apriTendina(elemento: HTMLElement) {
  const contenitore = elemento.closest('div')?.parentElement as HTMLElement
  fireEvent.click(within(contenitore).getByRole('button', { name: itShared.anagCommutaElenco }))
}

async function scegliComune(nome = 'NAPOLI') {
  const comune = screen.getByRole('combobox', { name: itShared.anagComuneEtichetta })
  await waitFor(() => expect(comune).toBeEnabled())
  apriTendina(comune)
  fireEvent.click(screen.getByRole('option', { name: nome }))
}

describe('§1 · i tre stati, e nessuno di più', () => {
  it('senza codice fiscale il badge NON dipinge niente: sono 18 bambini su 33, non 18 errori', () => {
    montaPannello({ codice_fiscale: null })
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
    expect(screen.queryByText(itShared.cfNonVerificabileTitolo)).toBeNull()
  })

  it('codice presente ma comune di nascita assente ⇒ GIALLO «Non verificabile», non rosso', () => {
    montaPannello({ codice_fiscale: CF_ADA, birth_city: '', birth_province: '' })
    expect(screen.getByText(itShared.cfNonVerificabileTitolo)).toBeInTheDocument()
    expect(screen.getByText(itShared.cfMancaLuogoNascita)).toBeInTheDocument()
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
  })

  it('codice presente che contraddice l’anagrafica ⇒ ROSSO, con la ragione scritta', () => {
    montaPannello({ codice_fiscale: `ZZZ${CF_ADA.slice(3)}`, codice_belfiore_nascita: 'H501' })
    expect(screen.getByText(itShared.cfIncoerenteTitolo)).toBeInTheDocument()
  })

  it('codice coerente e tutto verificato ⇒ nessuna decorazione: «niente» è la risposta giusta', () => {
    montaPannello({ codice_fiscale: CF_ADA, codice_belfiore_nascita: 'H501' })
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
    expect(screen.queryByText(itShared.cfNonVerificabileTitolo)).toBeNull()
    expect(screen.queryByRole('button', { name: itShared.cfUsaQuesto })).toBeNull()
  })
})

describe('§2 · il codice si compone scegliendo il comune, e si applica a mano', () => {
  it('scelto il comune, il badge propone il codice calcolato e «Usa questo» riempie il campo', async () => {
    const onSave = montaPannello({ codice_fiscale: null })
    expect(campoCf().value).toBe('')

    await scegliComune()

    // Proposto, NON scritto: il codice si legge nel badge e il campo è vuoto.
    expect(screen.getByText(CF_ADA)).toBeInTheDocument()
    expect(campoCf().value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: itShared.cfUsaQuesto }))
    expect(campoCf().value).toBe(CF_ADA)

    // «Compila il campo e basta»: nessun salvataggio è partito.
    expect(onSave).not.toHaveBeenCalled()
  })

  it('il campo NON si riempie da solo: senza premere niente resta vuoto anche a comune scelto', async () => {
    montaPannello({ codice_fiscale: null })
    await scegliComune()
    expect(campoCf().value).toBe('')
  })

  it('quello digitato a mano non viene sovrascritto, nemmeno cambiando il comune', async () => {
    montaPannello({ codice_fiscale: 'ZZZQWE00L00M000K' })
    await scegliComune()
    expect(campoCf().value).toBe('ZZZQWE00L00M000K')

    await scegliComune('GIUGLIANO IN CAMPANIA')
    expect(campoCf().value).toBe('ZZZQWE00L00M000K')
  })
})

describe('§3 · il badge non blocca: si salva lo stesso', () => {
  it('col badge rosso «Salva Modifiche» funziona, e il payload porta il codice catastale', async () => {
    const onSave = montaPannello({ codice_fiscale: `ZZZ${CF_ADA.slice(3)}` })
    expect(screen.getByText(itShared.cfIncoerenteTitolo)).toBeInTheDocument()

    await scegliComune()
    fireEvent.click(screen.getByText(itAdminStudents.salvaModifiche))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toMatchObject({
      id: 'al-1',
      codice_fiscale: `ZZZ${CF_ADA.slice(3)}`,
      birth_city: 'NAPOLI',
      birth_province: 'NA',
      codice_belfiore_nascita: 'H501',
    })
  })

  it('senza codice catastale il payload lo porta a `null`: l’assenza si dichiara, non si tace', async () => {
    const onSave = montaPannello({ codice_fiscale: null })
    fireEvent.click(screen.getByText(itAdminStudents.salvaModifiche))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toHaveProperty('codice_belfiore_nascita', null)
  })

  /**
   * ⚠️ LA CHIAVE ASSENTE, che è un caso DIVERSO da «la chiave vale `null`» — e fino
   * all'11 agosto nessun test qui dentro lo esercitava: tutte le fixture dichiaravano
   * `codice_belfiore_nascita: null`, quindi `...form` la portava già e la riga che la
   * scrive esplicitamente si poteva cancellare col verde intatto (dimostrato per
   * mutazione da una revisione: 11 test su 11 restavano verdi).
   *
   * Il record senza la chiave è quello che arriva da un ambiente NON MIGRATO: la
   * `select *` non può restituire una colonna che non esiste (`42703` se la si
   * nomina), quindi la proprietà proprio non c'è. Per la rotta, una chiave assente
   * significa «non toccare» e non «azzera»: senza la riga esplicita, la scelta
   * «questo comune non lo riconosco» non verrebbe mai scritta.
   */
  it('la chiave ASSENTE dal record esce comunque nel payload, valorizzata a `null`', async () => {
    const senzaLaChiave: Record<string, unknown> & { id: string } = {
      id: 'al-2',
      nome: 'Ada',
      cognome: 'Verdi',
      gender: 'F',
      data_nascita: '2019-03-07',
      scuola_id: SEDE_A,
      birth_city: 'NAPOLI',
      birth_province: 'NA',
      birth_nation: 'Italia',
      codice_fiscale: null,
    }
    // La premessa del test, misurata e non supposta: la chiave NON c'è.
    expect(Object.prototype.hasOwnProperty.call(senzaLaChiave, 'codice_belfiore_nascita')).toBe(false)

    const onSave = montaRecord(senzaLaChiave)
    fireEvent.click(screen.getByText(itAdminStudents.salvaModifiche))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0][0] as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(payload, 'codice_belfiore_nascita')).toBe(true)
    expect(payload.codice_belfiore_nascita).toBeNull()
  })
})

describe('§3bis · il verdetto si può SENTIRE, non solo vedere', () => {
  /**
   * `role="status"` qui non promette nessun annuncio (il badge nasce insieme al
   * proprio contenuto): la via dichiarata è `aria-describedby` dal campo del codice
   * fiscale. Senza questo collegamento chi legge con uno screen reader torna sul
   * campo e non riceve il verdetto — e le tre schede alunno resterebbero incoerenti
   * con le tre schede adulto dello stesso prodotto, che lo collegano tutte.
   */
  it('il campo del codice fiscale punta al badge, e l’`id` risolve davvero a quell’elemento', () => {
    montaPannello({ codice_fiscale: CF_ADA, birth_city: '', birth_province: '' })

    const idDescrittore = campoCf().getAttribute('aria-describedby')
    expect(idDescrittore).toBeTruthy()

    const badge = document.getElementById(idDescrittore!)
    expect(badge).not.toBeNull()
    expect(badge).toHaveAttribute('role', 'status')
    expect(badge).toHaveTextContent(itShared.cfNonVerificabileTitolo)
  })

  it('l’`id` è proprio di QUESTA scheda, non il default condiviso da tutte', () => {
    montaPannello({ codice_fiscale: CF_ADA, birth_city: '', birth_province: '' })
    expect(campoCf().getAttribute('aria-describedby')).not.toBe('badge-coerenza-cf')
  })
})

describe('§4 · un comune che la tendina non riconosce conserva il testo in archivio', () => {
  /**
   * Il dataset è fermo al 2022 e in produzione ci sono righe scritte a mano da anni:
   * `UGGIATE CON RONAGO` è un comune del 2024 e semplicemente non c'è. Un campo che
   * azzera ciò che non riconosce cancella un dato vero PER IL SOLO FATTO DI ESSERE
   * APERTO — e chi salva la scheda per un altro motivo se lo porta via.
   */
  const FUORI_ELENCO = { birth_city: 'UGGIATE CON RONAGO', birth_province: 'CO', codice_belfiore_nascita: null }

  it('il testo resta a schermo, e resta identico nel payload di salvataggio', async () => {
    const onSave = montaPannello({ ...FUORI_ELENCO, codice_fiscale: null })

    const comune = screen.getByRole('combobox', { name: itShared.anagComuneEtichetta })
    await waitFor(() => expect(comune).toHaveValue('UGGIATE CON RONAGO'))

    fireEvent.click(screen.getByText(itAdminStudents.salvaModifiche))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toMatchObject({
      birth_city: 'UGGIATE CON RONAGO',
      birth_province: 'CO',
      codice_belfiore_nascita: null,
    })
  })

  it('con un codice fiscale in archivio il verdetto è GIALLO, non rosso: non si è dimostrato niente', async () => {
    montaPannello({ ...FUORI_ELENCO, codice_fiscale: CF_ADA })

    expect(screen.getByText(itShared.cfNonVerificabileTitolo)).toBeInTheDocument()
    expect(screen.getByText(itShared.cfMancaLuogoNascita)).toBeInTheDocument()
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
  })
})
