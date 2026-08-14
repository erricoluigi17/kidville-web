import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import {
  INSEGNANTE_FIELDS, CONSENSI_INSEGNANTI_FIELDS, TITOLI_STUDIO, POSIZIONI_OPTIONS,
} from '@/lib/forms/insegnanti-template'
import { CV_PREFISSO } from '@/lib/candidature/percorso-cv'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import type { FormField } from '@/types/database.types'

/**
 * `/lavora-con-noi` — IL RIEPILOGO RIEPILOGA.
 *
 * ─── IL DIFETTO CHE QUESTO FILE IMPEDISCE ──────────────────────────────────
 *
 * Fino all'11/08/2026 l'ultimo passo del modulo diceva «Controlla e invia la
 * candidatura» e mostrava DUE fatti su tredici campi compilabili: la sede e le
 * fasce d'età. Misurato, non stimato: nome, cognome, EMAIL, telefono, comune,
 * provincia, titolo di studio, dettaglio del titolo, anni di esperienza,
 * disponibilità, presentazione e le due risposte sui consensi non comparivano
 * da nessuna parte.
 *
 * Non è un difetto estetico ed è la ragione per cui questo collaudo esiste: chi
 * arrivava lì non aveva niente da controllare, e soprattutto non rileggeva il
 * proprio indirizzo email — l'unico modo con cui la Scuola può rispondergli
 * (`candInviataCorpo`: «riceverai le credenziali di accesso via email»). Un
 * refuso nell'indirizzo, e la candidatura è persa in silenzio: la rotta risponde
 * 201 anche al duplicato, nessun rimbalzo torna indietro, e chi si è candidato
 * resta ad aspettare una risposta che è partita verso un indirizzo inesistente.
 *
 * ─── IL CONTRATTO ──────────────────────────────────────────────────────────
 *
 *  1. ogni campo RESO dal modulo ha la sua riga nel riepilogo — e il controllo è
 *     fatto sul TEMPLATE, non su un elenco ricopiato qui: un campo aggiunto
 *     domani a `INSEGNANTE_FIELDS` fa fallire questo file finché non compare
 *     anche nel riepilogo;
 *  2. il VALORE che si legge è quello che si è scritto, e per le scelte è
 *     l'etichetta letta scegliendo — mai il valore d'enum (`laurea_triennale`);
 *  3. i campi facoltativi lasciati vuoti NON spariscono: dicono «Non indicato».
 *     Omettere la riga renderebbe l'omissione invisibile proprio a chi deve
 *     accorgersene;
 *  4. i consensi non hanno «non indicato»: hanno «Sì» e «No», come nel payload;
 *  5. da ogni gruppo si torna al suo passo con «Modifica», e i dati restano.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const BETA = { id: SEDE_B, nome: NOME_SEDE_B }

const fetchMock = vi.fn()
const corpiInviati: unknown[] = []

/**
 * Il percorso che `POST /api/iscrizione/insegnanti/upload` restituisce.
 *
 * ⚠️ È la CHIAVE con cui si firma un oggetto di un bucket privato — lo stesso che
 * custodisce le carte d'identità dei genitori e le fotografie dei bambini
 * (`form_attachments`). Il prefisso è letto da `@/lib/candidature/percorso-cv` e
 * non ribattuto qui: è quello che il riepilogo NON deve stampare, e cercarlo con
 * una stringa scritta a mano vorrebbe dire cercare una cosa diversa da quella che
 * il prodotto produce.
 */
const PERCORSO_CV = `${CV_PREFISSO}11111111-2222-4333-8444-555555555555-cv.pdf`

/**
 * L'etichetta della posizione con quel `value`, LETTA dal template.
 *
 * Dal 2026-08-15 il passo «profilo» non chiede più le fasce d'età: chiede le
 * POSIZIONI, e le tre voci docenti portano la fascia nel nome — «Insegnante —
 * Infanzia (3-6)». ⚠️ Quel trattino è un EM DASH (U+2014): ribattuto a mano con un
 * trattino corto dà un selettore che non trova niente.
 */
function posizione(valore: string): string {
  const o = POSIZIONI_OPTIONS.find((x) => x.value === valore)
  if (!o) throw new Error(`posizione «${valore}» assente da POSIZIONI_OPTIONS`)
  return String(o.label)
}

/** La posizione che `compilaTutto` spunta. */
const POSIZIONE_SCELTA = posizione('insegnante_infanzia')
/** Una posizione NON spuntata: serve a provare che il riepilogo non le stampa tutte. */
const POSIZIONE_NON_SCELTA = posizione('insegnante_nido')

function mockRete(sedi: { id: string; nome: string }[] = [ALFA]): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/iscrizione/sedi')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: sedi }) })
    }
    // La rotta di caricamento del curriculum: risponde con il percorso, che è ciò
    // che finisce nel valore del campo `cv_path`.
    if (url.includes('/api/iscrizione/insegnanti/upload')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ path: PERCORSO_CV }) })
    }
    if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
      corpiInviati.push(JSON.parse(String(init.body)))
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: null }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

/** Il campo del template con quell'id — così i selettori non sono ricopiati. */
function campo(id: string): FormField {
  const f = INSEGNANTE_FIELDS.find((x) => x.id === id)
  if (!f) throw new Error(`campo «${id}» assente dal template`)
  return f
}

/** Il segnaposto dichiarato dal template, che è il selettore di quel campo. */
function segnaposto(id: string): string {
  const p = campo(id).placeholder
  if (!p) throw new Error(`il campo «${id}» non dichiara un placeholder`)
  return p
}

function scrivi(id: string, valore: string): void {
  fireEvent.change(screen.getByPlaceholderText(segnaposto(id)), { target: { value: valore } })
}

const avanti = () => fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

/**
 * Il comando primario quando si è entrati in un passo dal riepilogo. È un
 * bottone DIVERSO da «Avanti» — stessa posizione, altra etichetta — e cercarlo
 * per nome è il punto: se il wizard tornasse a dire «Avanti» dopo un «Modifica»,
 * questa riga non troverebbe niente.
 */
const tornaAlRiepilogo = () =>
  fireEvent.click(screen.getByRole('button', { name: itPublic.candTornaAlRiepilogo }))

/** «Modifica» accanto al titolo di un gruppo del riepilogo. */
const modifica = (gruppo: string) =>
  fireEvent.click(
    screen.getByRole('button', { name: `${itPublic.candRiepilogoModifica} ${gruppo}` }),
  )

/** Si è sul riepilogo? Il primo fatto della schermata è la sede. */
const sulRiepilogo = () => screen.queryByText(itPublic.candRiepilogoSede) !== null

/** I valori compilati, uno per campo, tutti diversi fra loro. */
const SCRITTI: Record<string, string> = {
  nome: 'Ines',
  cognome: 'Di Prova',
  email: 'aspirante.collaudo@example.test',
  telefono: '+39 333 0000000',
  residence_city: 'Giugliano in Campania',
  residence_province: 'NA',
  titolo_dettaglio: 'Indirizzo socio-psico-pedagogico',
  anni_esperienza: '7',
  note: 'Ho lavorato tre anni al nido e due nella sezione primavera.',
}

/** Il titolo di studio scelto, con l'etichetta che si legge sceglierlo. */
const TITOLO = TITOLI_STUDIO[2] // «Laurea triennale»

/**
 * Allega un curriculum al campo `cv_path`, come lo farebbe chi sceglie un file.
 *
 * ⚠️ Il nome del file scelto qui NON sopravvive: la rotta di caricamento lo butta
 * via e restituisce `candidature/<uuid>-cv.<est>` (vedi `costruisciPercorsoCv`).
 * Perciò il nome qui sotto è un cognome finto e riconoscibile — è la forma vera
 * di quel nome in produzione, `cv-<cognome>.pdf` — e serve a provare che nemmeno
 * LUI compare nel riepilogo.
 */
const NOME_FILE_CV = 'cv-diprova.pdf'

async function allegaCurriculum(): Promise<void> {
  const controllo = document.getElementById('cv_path') as HTMLInputElement | null
  expect(controllo, 'il campo del curriculum non è reso dal modulo').not.toBeNull()
  const file = new File(['%PDF-1.4 finto'], NOME_FILE_CV, { type: 'application/pdf' })
  fireEvent.change(controllo!, { target: { files: [file] } })
  // Il caricamento è asincrono: si aspetta che il campo abbia preso il percorso,
  // che è la sola prova che la rotta ha risposto e il valore è entrato nel modulo.
  await waitFor(() => expect(screen.getByText(NOME_FILE_CV)).toBeInTheDocument())
}

/**
 * Compila TUTTI i campi del modulo e si ferma sul riepilogo.
 * `vuoti` sono gli id da lasciare in bianco (per il collaudo del «Non indicato»);
 * `allegaCv` fa passare anche dal caricamento del curriculum.
 */
async function compilaTutto(vuoti: string[] = [], allegaCv = false): Promise<void> {
  await waitFor(() => expect(screen.getByPlaceholderText(segnaposto('nome'))).toBeInTheDocument())
  for (const [id, valore] of Object.entries(SCRITTI)) {
    if (vuoti.includes(id)) continue
    // I campi del passo «profilo» non esistono ancora: si scrivono dopo.
    if (['titolo_dettaglio', 'anni_esperienza', 'note'].includes(id)) continue
    scrivi(id, valore)
  }
  avanti()

  await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: TITOLO.value } })
  for (const id of ['titolo_dettaglio', 'anni_esperienza', 'note']) {
    if (vuoti.includes(id)) continue
    scrivi(id, SCRITTI[id])
  }
  fireEvent.click(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA }))
  if (!vuoti.includes('disponibilita')) {
    fireEvent.change(screen.getByLabelText(/Disponibilità/), { target: { value: 'part_time_mattina' } })
  }
  if (allegaCv) await allegaCurriculum()
  avanti()

  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
  avanti()

  await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
}

/** Il testo scritto sotto un'etichetta del riepilogo. */
function sotto(etichetta: string): string {
  const riga = screen.getByText(etichetta).parentElement
  return riga?.textContent?.replace(etichetta, '').trim() ?? ''
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

describe('CandidaturaInsegnanteWizard — il riepilogo contiene ciò che si è scritto', () => {
  it('OGNI campo reso dal modulo ha la sua riga: il controllo è sul template, non su una lista ricopiata', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaTutto()

    /*
     * ⚠️ L'ELENCO DEI CAMPI ATTESI È CAMBIATO DUE VOLTE IL 2026-08-15, E VALE LA
     * PENA DIRE COME.
     *
     * 1. `cv_path` NON è più l'eccezione. Era escluso perché il modulo non lo
     *    rendeva (`IDS_NON_RESI`, che oggi è VUOTO): nessuna rotta di caricamento
     *    produceva il prefisso `candidature/` che il server pretende. Adesso quella
     *    rotta c'è, il campo si rende, e la riga del curriculum è pretesa qui come
     *    ogni altra — senza che nessuno abbia dovuto ricordarsene, perché
     *    `gruppiRiepilogo()` costruisce il riepilogo dalle stesse liste che
     *    disegnano i passi. Era la promessa scritta nel componente, ed è mantenuta.
     * 2. `posizione_altro` è il primo campo CONDIZIONALE del modulo: esiste solo
     *    con «Altro» spuntato, e qui non lo è. Va escluso dai campi attesi ed è
     *    l'unico — controllato qui sotto leggendo la `condition` dal template
     *    invece che ribattendo un id: un secondo campo condizionale aggiunto domani
     *    non passerebbe di nascosto.
     */
    const condizionali = INSEGNANTE_FIELDS.filter((f) => f.condition)
    expect(condizionali.map((f) => f.id)).toEqual(['posizione_altro'])

    const attesi = INSEGNANTE_FIELDS.filter((f) => !f.condition)
    const mancanti = [...attesi, ...CONSENSI_INSEGNANTI_FIELDS]
      // ⚠️ `posizioni` è l'unica etichetta riscritta: nel passo è una DOMANDA
      // («Per quali posizioni ti proponi»), e una domanda in un elenco di fatti si
      // legge male. La chiave esiste già ed è tradotta in entrambe le lingue.
      .map((f) => (f.id === 'posizioni' ? itPublic.candRiepilogoPosizioni : String(f.label)))
      .filter((etichetta) => screen.queryByText(etichetta) === null)

    expect(mancanti, `campi assenti dal riepilogo: ${mancanti.join(' · ')}`).toEqual([])
    // Il campo condizionale NON compare: chi non ha spuntato «Altro» leggerebbe
    // «Quale posizione: Non indicato» in rosso — un campo obbligatorio mancante,
    // per una domanda che non gli è mai stata fatta.
    for (const f of condizionali) {
      expect(screen.queryByText(String(f.label)), `«${f.id}» non doveva comparire`).toBeNull()
    }
    // E la sede, che non è un campo del template ma è il primo fatto della
    // schermata.
    expect(sotto(itPublic.candRiepilogoSede)).toBe(NOME_SEDE_A)
  })

  it('spuntando «Altro», la posizione scritta a mano ENTRA nel riepilogo', async () => {
    // L'altra metà della regola qui sopra: un campo condizionale che non si mostra
    // quando la sua condizione è vera sarebbe un dato raccolto e mai ricontrollato
    // — e questo va in una colonna che il database pretende coerente con
    // `posizioni` (il `CHECK` di `20260814225302`).
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await waitFor(() => expect(screen.getByPlaceholderText(segnaposto('nome'))).toBeInTheDocument())
    for (const id of ['nome', 'cognome', 'email']) scrivi(id, SCRITTI[id])
    avanti()

    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: TITOLO.value } })
    fireEvent.click(screen.getByRole('checkbox', { name: posizione('altro') }))
    await waitFor(() => expect(screen.getByPlaceholderText(segnaposto('posizione_altro'))).toBeInTheDocument())
    scrivi('posizione_altro', 'psicomotricista')
    avanti()

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
    avanti()

    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    expect(sotto(String(campo('posizione_altro').label))).toBe('psicomotricista')
    expect(screen.getByText(posizione('altro'))).toBeInTheDocument()
  })

  it('L’EMAIL SI RILEGGE — è il motivo per cui questo riepilogo esiste', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaTutto()

    // Non «c'è un campo email da qualche parte»: c'è ESATTAMENTE l'indirizzo
    // scritto, sotto l'etichetta con cui è stato chiesto. È l'unico recapito su
    // cui la Direzione può rispondere, e un refuso qui non torna indietro.
    expect(sotto(String(campo('email').label))).toBe(SCRITTI.email)
    expect(screen.getByText(SCRITTI.email)).toBeInTheDocument()
  })

  it('i valori sono quelli che si sono LETTI, non quelli d’enum', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaTutto()

    for (const id of ['nome', 'cognome', 'telefono', 'residence_city', 'residence_province', 'titolo_dettaglio', 'anni_esperienza', 'note']) {
      expect(sotto(String(campo(id).label)), `il campo «${id}»`).toBe(SCRITTI[id])
    }
    // Il titolo di studio si legge «Laurea triennale», non `laurea_triennale`:
    // il valore tecnico non l'ha mai visto nessuno, e chiedere di controllarlo
    // sarebbe chiedere di controllare una cosa mai scritta.
    expect(sotto(String(campo('titolo_studio').label))).toBe(String(TITOLO.label))
    expect(screen.queryByText(String(TITOLO.value))).not.toBeInTheDocument()
    expect(sotto(String(campo('disponibilita').label))).toBe('Part-time mattina')
    // Le posizioni restano un elenco, una per riga, con l'etichetta spuntata —
    // che dal 2026-08-15 porta anche la fascia dentro il nome del mestiere.
    expect(screen.getByText(POSIZIONE_SCELTA)).toBeInTheDocument()
    expect(screen.queryByText(POSIZIONE_NON_SCELTA)).not.toBeInTheDocument()
  })

  it('i facoltativi lasciati VUOTI si vedono come «Non indicato»: l’omissione resta visibile', async () => {
    // ⚠️ `cv_path` è in elenco dal 2026-08-15, e non perché `compilaTutto` lo
    // salti: non ha mai avuto un valore da scrivere. Il curriculum è facoltativo,
    // e senza questa riga il conteggio più sotto direbbe uno in meno di quello che
    // si legge a schermo — cioè misurerebbe l'omissione mentre la lascia passare.
    const vuoti = ['telefono', 'residence_city', 'residence_province', 'titolo_dettaglio', 'anni_esperienza', 'note', 'disponibilita', 'cv_path']
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaTutto(vuoti)

    for (const id of vuoti) {
      expect(sotto(String(campo(id).label)), `il campo vuoto «${id}»`).toBe(itPublic.candRiepilogoNonIndicato)
    }
    // «Telefono: non indicato» dice che la Scuola potrà scrivere solo via email,
    // e c'è ancora tempo per tornare indietro: una riga assente non direbbe
    // niente, e si leggerebbe come un dato mai chiesto.
    expect(screen.getAllByText(itPublic.candRiepilogoNonIndicato)).toHaveLength(vuoti.length)
    // I campi compilati restano compilati: il vuoto non ha contagiato niente.
    expect(sotto(String(campo('email').label))).toBe(SCRITTI.email)
  })

  it('i consensi si leggono «Sì» e «No», mai «non indicato»', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaTutto()

    const [obbligatorio, facoltativo] = CONSENSI_INSEGNANTI_FIELDS
    // La presa visione è stata spuntata; la conservazione no. «Non gliel'ho
    // chiesto» e «ha detto no» non sono la stessa cosa — è la stessa ragione per
    // cui il `false` viaggia nel payload invece di essere omesso.
    expect(sotto(String(obbligatorio.label))).toBe(itPublic.candRiepilogoSi)
    expect(sotto(String(facoltativo.label))).toBe(itPublic.candRiepilogoNo)

    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))
    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = (corpiInviati[0] as { data?: Record<string, unknown> }).data ?? {}
    // Ciò che si è letto nel riepilogo è ciò che è partito: se le due cose
    // divergessero, il riepilogo starebbe rassicurando su un invio diverso.
    expect(dati[obbligatorio.id]).toBe(true)
    expect(dati[facoltativo.id]).toBe(false)
    expect(dati.email).toBe(SCRITTI.email)
    expect(dati.titolo_studio).toBe(TITOLO.value)
  })

  it('«Modifica» riporta al passo giusto, con i dati ancora dentro', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaTutto()

    // Il nome accessibile porta il gruppo: quattro comandi chiamati tutti
    // «Modifica» sarebbero, per chi li ascolta in fila, quattro volte la stessa
    // cosa senza sapere quale gruppo si sta per aprire.
    fireEvent.click(
      screen.getByRole('button', { name: `${itPublic.candRiepilogoModifica} ${itPublic.candDati}` }),
    )

    await waitFor(() => expect(screen.getByPlaceholderText(segnaposto('email'))).toBeInTheDocument())
    expect(screen.getByPlaceholderText(segnaposto('email'))).toHaveValue(SCRITTI.email)
    expect(screen.getByRole('heading', { level: 2, name: itPublic.candDati })).toBeInTheDocument()

    // Corretto il refuso, si torna al riepilogo e lì c'è l'indirizzo NUOVO.
    // UNA pressione: il conto lo tiene il collaudo del viaggio di ritorno, qui
    // conta che il valore mostrato sia quello corretto.
    fireEvent.change(screen.getByPlaceholderText(segnaposto('email')), {
      target: { value: 'corretto@example.test' },
    })
    tornaAlRiepilogo()
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    expect(sotto(String(campo('email').label))).toBe('corretto@example.test')
  })

  /*
   * ─── IL CURRICULUM SI RIEPILOGA, IL SUO PERCORSO NO ────────────────────────
   *
   * `cv_path` vale `candidature/<uuid>-cv.pdf`, ed è la CHIAVE con cui si firma un
   * oggetto di `form_attachments` — il bucket privato che al 2026-08-15 custodisce
   * 1389 allegati delle domande d'iscrizione: carte d'identità di genitori e
   * fotografie di bambini. Una schermata si fotografa, si legge ad alta voce e
   * finisce dentro le segnalazioni di guasto: stampare lì una chiave d'archivio è
   * il difetto che questo repo ha già chiuso due volte — nel riquadro del campo di
   * `FieldRenderer` (12/08) e nel riepilogo del modulo del personale — e la terza
   * volta sarebbe su un modulo PUBBLICO, che chiunque apre senza account.
   *
   * La riga dice l'unica cosa che serve a chi controlla prima di inviare: allegato
   * oppure no. Nemmeno il NOME del file: in produzione quel nome è
   * `cv-<cognome>.pdf`, cioè il cognome di chi si è candidato, e comunque non
   * sopravvive alla rotta di caricamento.
   */
  it('il curriculum allegato si dice «Allegato», e il suo PERCORSO non compare da nessuna parte', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaTutto([], true)

    // 1 · La riga c'è, e dice che il curriculum è arrivato.
    expect(sotto(String(campo('cv_path').label))).toBe(itPublic.candRiepilogoCvAllegato)

    // 2 · ⚠️ IL CONTROLLO CHE CONTA: nel testo della schermata non c'è né il
    //     percorso, né il prefisso del bucket, né l'uuid che lo compone, né il
    //     nome del file scelto dal browser.
    const testo = document.body.textContent ?? ''
    // Il controllo POSITIVO viene prima: una sonda che legge il documento
    // sbagliato — o un riepilogo che non è stato dipinto — supererebbe da sola
    // tutte le righe qui sotto senza guardare niente.
    expect(testo).toContain(itPublic.candRiepilogoCvAllegato)
    expect(testo).not.toContain(PERCORSO_CV)
    expect(testo).not.toContain(CV_PREFISSO)
    expect(testo).not.toContain('11111111-2222-4333-8444-555555555555')
    expect(testo).not.toContain(NOME_FILE_CV)
    // …e nemmeno dentro un attributo (un `title`, un `value`, un `href` firmato).
    expect(document.body.innerHTML).not.toContain(PERCORSO_CV)

    // 3 · Il valore però è partito davvero: la riga «Allegato» non è un'etichetta
    //     scollegata dal dato. Senza questo, un `cv_path` buttato via prima
    //     dell'invio darebbe lo stesso riepilogo — ed è la forma esatta del difetto
    //     dei consensi sul wizard fratello.
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))
    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = (corpiInviati[0] as { data?: Record<string, unknown> }).data ?? {}
    expect(dati.cv_path).toBe(PERCORSO_CV)
  })

  it('il gruppo «Sede» ha il suo «Modifica» solo quando quel passo esiste davvero', async () => {
    // Col link targato la sede è decisa e il passo non c'è: un «Modifica» che
    // non porta da nessuna parte sarebbe peggio di nessun comando.
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaTutto()
    const nomeComando = `${itPublic.candRiepilogoModifica} ${itPublic.candSede}`
    expect(screen.queryByRole('button', { name: nomeComando })).not.toBeInTheDocument()
    cleanup()

    // Con due plessi il passo esiste, e da lì si può cambiare idea.
    mockRete([ALFA, BETA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_A })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('radio', { name: NOME_SEDE_A }))
    avanti()
    await compilaTutto()

    expect(sotto(itPublic.candRiepilogoSede)).toBe(NOME_SEDE_A)
    fireEvent.click(screen.getByRole('button', { name: nomeComando }))
    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_B })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('radio', { name: NOME_SEDE_B }))
    // Anche dal PRIMO passo il ritorno è uno solo, e scavalca tre passi già
    // compilati: `prosegui()` li rivalida tutti prima di lasciar passare, quindi
    // qui non c'è nessun controllo saltato — solo tre schermate risparmiate.
    tornaAlRiepilogo()
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    expect(sotto(itPublic.candRiepilogoSede)).toBe(NOME_SEDE_B)
    // E i dati compilati sono ancora lì: cambiare sede non è ricominciare.
    expect(sotto(String(campo('nome').label))).toBe(SCRITTI.nome)
  })
})

/**
 * ─── «MODIFICA» È UN VIAGGIO DI ANDATA **E RITORNO** ────────────────────────
 *
 * IL DIFETTO CHE QUESTO BLOCCO IMPEDISCE, misurato a 360×740 e a 1440×900:
 * dal riepilogo si premeva «Modifica» accanto a «I tuoi dati», si arrivava al
 * passo 2, si correggeva il refuso nell'email — il gesto per cui l'intero
 * riepilogo è stato scritto — e sotto al campo c'era «Avanti». Per rivedere ciò
 * che si era voluto controllare bisognava riattraversare il profilo, riguardare
 * le fasce d'età e ripassare sopra le due caselle dei consensi: TRE pressioni
 * per un carattere cambiato, e su telefono tre schermate da riscorrere.
 *
 * Il modello è quello che le pubbliche amministrazioni chiamano *check your
 * answers*: la correzione costa un tocco per andare e uno per tornare. Qui il
 * tocco di ritorno si CONTA, non si descrive.
 */
describe('CandidaturaInsegnanteWizard — dal riepilogo si torna al riepilogo', () => {
  it('UNA sola pressione riporta al riepilogo, e il valore mostrato è quello corretto', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaTutto()

    modifica(itPublic.candDati)
    await waitFor(() => expect(screen.getByPlaceholderText(segnaposto('email'))).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText(segnaposto('email')), {
      target: { value: 'refuso.corretto@example.test' },
    })

    // Il comando NON si chiama più «Avanti»: se si chiamasse, il viaggio sarebbe
    // di nuovo di sola andata e questa riga fallirebbe prima di contare niente.
    expect(screen.queryByRole('button', { name: itPublic.candAvanti })).not.toBeInTheDocument()
    expect(sulRiepilogo()).toBe(false)

    // ── IL CONTO ─────────────────────────────────────────────────────────────
    let pressioni = 0
    tornaAlRiepilogo()
    pressioni++
    await waitFor(() => expect(sulRiepilogo()).toBe(true))
    expect(pressioni).toBe(1)

    // …e ciò che si vede è la correzione, non il valore di prima.
    expect(sotto(String(campo('email').label))).toBe('refuso.corretto@example.test')
    expect(screen.queryByText(SCRITTI.email)).not.toBeInTheDocument()
    // Tornati al riepilogo il biglietto di ritorno è consumato: il comando è di
    // nuovo quello dell'ultimo passo.
    expect(screen.getByRole('button', { name: itPublic.candInvia })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: itPublic.candTornaAlRiepilogo }),
    ).not.toBeInTheDocument()
  })

  it('nel percorso NORMALE il comando resta «Avanti»: il ritorno esiste solo se si è arrivati dal riepilogo', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await waitFor(() => expect(screen.getByPlaceholderText(segnaposto('nome'))).toBeInTheDocument())

    // Prima volta al passo 1: nessun riepilogo è mai stato visto, promettere di
    // «tornare» a una schermata mai vista sarebbe una bugia.
    expect(screen.getByRole('button', { name: itPublic.candAvanti })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: itPublic.candTornaAlRiepilogo }),
    ).not.toBeInTheDocument()
  })

  it('se la modifica lascia incompleto un passo SCAVALCATO, il ritorno si ferma lì — e lo dice', async () => {
    // Il percorso è reale, non costruito: dal riepilogo si apre «Il tuo profilo»,
    // si toglie l'unica posizione selezionata (`posizioni` è obbligatorio, e
    // «nessuna posizione» è ciò che la rotta rifiuta — e con lei il `CHECK`
    // `cardinality(posizioni) >= 1` della tabella), si dà un'occhiata al passo
    // accanto con «Indietro» e da lì si preme il biglietto di ritorno. Il salto
    // scavalcherebbe il profilo, che nel frattempo è incompleto: il riepilogo
    // direbbe che va tutto bene su un modulo che il server rifiuterà.
    mockRete([ALFA, BETA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_A })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('radio', { name: NOME_SEDE_A }))
    avanti()
    await compilaTutto()

    modifica(itPublic.candProfilo)
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA }))
    expect(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA })).not.toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: itPublic.candIndietro }))
    await waitFor(() => expect(screen.getByPlaceholderText(segnaposto('nome'))).toBeInTheDocument())
    // «Indietro» porta al passo PRECEDENTE, non al riepilogo — e il biglietto di
    // ritorno non si è perso per strada.
    expect(screen.getByRole('heading', { level: 2, name: itPublic.candDati })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itPublic.candTornaAlRiepilogo })).toBeInTheDocument()

    tornaAlRiepilogo()

    // 1 · NON si è arrivati al riepilogo: il controllo saltato l'ha impedito.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candProfilo })).toBeInTheDocument(),
    )
    expect(sulRiepilogo()).toBe(false)
    // 2 · e non è successo in SILENZIO: il riquadro nomina il passo rimasto
    //     indietro, che è l'unica cosa che spiega perché la schermata non è
    //     quella promessa dal comando appena premuto.
    expect(screen.getByText(itPublic.candRitornoInterrottoTitolo)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(itPublic.candProfilo, 'i'))).toBeInTheDocument()
    // 3 · si è ricaduti nel percorso lineare: il comando torna «Avanti», perché
    //     una promessa appena mancata non si rifà mentre il modulo è incompleto.
    expect(screen.getByRole('button', { name: itPublic.candAvanti })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: itPublic.candTornaAlRiepilogo }),
    ).not.toBeInTheDocument()

    // Rimesso il dato, il percorso lineare arriva al riepilogo passo per passo —
    // e il riquadro si spegne alla prima pressione, comunque vada.
    fireEvent.click(screen.getByRole('checkbox', { name: POSIZIONE_NON_SCELTA }))
    avanti()
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    expect(screen.queryByText(itPublic.candRitornoInterrottoTitolo)).not.toBeInTheDocument()
    avanti()
    await waitFor(() => expect(sulRiepilogo()).toBe(true))
    expect(screen.getByText(POSIZIONE_NON_SCELTA)).toBeInTheDocument()
    expect(screen.queryByText(itPublic.candRiepilogoNessunaPosizione)).not.toBeInTheDocument()
  })
})

describe('CandidaturaInsegnanteWizard — l’errore della sede sta dove serve', () => {
  /**
   * ⚠️ QUESTO TEST HA CAMBIATO IDEA, E VALE LA PENA DIRE PERCHÉ.
   *
   * Fino all'11/08/2026 pretendeva l'errore SOPRA le tre sedi, e la ragione
   * scritta qui era una misura vera: a 360 px la frase compariva a `top` 437
   * mentre «Avanti» — il dito che l'aveva prodotta — stava a 676, cioè 259 px
   * più in basso. Solo che quei 259 px non venivano dalla posizione della frase:
   * venivano dal `flex-1` sul guscio, che spingeva i comandi in fondo alla
   * finestra lasciando il vuoto in mezzo. Tolto il `flex-1` (stesso rilascio),
   * la causa non c'è più.
   *
   * Restava però una differenza che nessuna misura giustificava: il messaggio
   * del gruppo «sede» era l'UNICO della pagina a stare sopra ciò che descrive —
   * quello delle fasce d'età, quello dei consensi e ogni messaggio di campo di
   * `FieldRenderer` stanno sotto. Misurato dal collaudo visivo: sede a y=267 con
   * le card che cominciano a y=291, fasce a y=535 con il gruppo che finisce a
   * y=518. Adesso stanno tutti dalla stessa parte.
   */
  it('sta SOTTO le sedi come ogni altro messaggio del modulo, con la sua icona e il fuoco sul primo radio', async () => {
    mockRete([ALFA, BETA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_A })).toBeInTheDocument())

    avanti()

    const errore = await screen.findByText(itPublic.candSedeErrore)
    // 1 · ha la forma degli altri errori del modulo: cerchio d'allarme, non
    //     una riga di testo nuda. Era l'unico errore della pagina senza icona.
    expect(errore.querySelector('svg')).not.toBeNull()
    // 2 · sta DENTRO il gruppo e DOPO l'ultima scelta.
    const gruppo = errore.closest('fieldset')
    expect(gruppo).not.toBeNull()
    const radio = within(gruppo!).getAllByRole('radio')
    const ultima = radio[radio.length - 1]
    expect(
      ultima.compareDocumentPosition(errore) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // 3 · e il fuoco è sulla cosa da fare, non sul bottone che ha risposto di no.
    expect(document.activeElement).toBe(radio[0])
  })
})
