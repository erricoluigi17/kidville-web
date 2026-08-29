import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import itPublic from '../../messages/it/public.json'
import enPublic from '../../messages/en/public.json'
import itParentForms from '../../messages/it/parentForms.json'
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
 * candidatura» e mostrava DUE fatti soli: la sede e le fasce d'età. Misurato,
 * non stimato: tutto il resto di ciò che era stato compilato non compariva da
 * nessuna parte — né il nome, né il telefono, né la residenza, né il titolo di
 * studio, né i consensi, e soprattutto NON L'EMAIL.
 *
 * ⚠️ Qui c'erano un NUMERO — «tredici campi compilabili» — e l'elenco CHIUSO dei
 * campi che mancavano, «disponibilità» compresa. Il numero non era falso, ed è
 * il guaio: i campi compilabili erano tredici l'11/08 e sono di
 * nuovo tredici dopo il 2026-08-24, ma non sono GLI STESSI (fuori `gradi` e `disponibilita`,
 * dentro `posizioni` e `posizione_altro`). Una cifra che torna uguale sopra un
 * insieme diverso si legge come lo stato di oggi ed è la fotografia di un altro
 * giorno — e l'elenco chiuso nominava un campo che il modulo non ha più. Qui la
 * lista vera è `INSEGNANTE_FIELDS`, e la rifà `campiVisibili` a ogni esecuzione.
 *
 * ⚠️ E LA FRASE VIVEVA IN PIÙ COPIE DI QUANTE SE NE RICORDASSE CHI L'HA
 * CORRETTA. Fino al 2026-08-25 questo blocco diceva «la stessa frase viveva in
 * DUE copie — qui e in testa al componente — e questo giro le ha corrette
 * entrambe»: era falso. Le copie ancora col numero erano due, in file diversi da
 * quelli nominati, e il conto era stato fatto a memoria invece che con un grep —
 * cioè proprio la trappola che questo repo documenta («un elenco scritto a mano
 * di tutti i posti da toccare mente»), applicata alla propria correzione.
 *
 * Il conto non si riscrive, perché al prossimo giro sarebbe falso allo stesso
 * modo. L'elenco si RIFÀ, e il comando è questo:
 *
 *     grep -rn tredici src __tests__
 *
 * ⚠️ E si cerca il NUMERO, non la frase. `grep -rn 'campi compilabili'` sembra
 * più mirato ed è la scelta sbagliata: MISURATO il 2026-08-25, una delle copie
 * porta «due su» a fine riga e «tredici» su quella dopo, quindi nessun grep di
 * RIGA la trova. Un rilevatore più stretto della cosa che cerca è il modo in cui
 * questo conto è arrivato a essere falso la prima volta.
 *
 * Chi lo esegue trova anche le copie che raccontano lo stesso difetto dal punto
 * di vista di ALTRI moduli — il riepilogo dell'anagrafica del personale lo cita
 * come «modulo fratello» — e parecchi «tredici» che non c'entrano niente (classi,
 * bucket, prefissi). Non sono state toccate, e questo blocco non dichiara di
 * averle contate: dichiara solo dove si guarda.
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
import { allegaCurriculumDiProva } from '../helpers/allega-curriculum'

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
 * ⚠️ Il nome del file NON sopravvive al PERCORSO: la rotta di caricamento lo butta
 * via e restituisce `candidature/<uuid>-cv.<est>` (vedi `costruisciPercorsoCv`).
 * Dal 25/08/2026 sopravvive però nella memoria della pagina — `nomiAllegati` nel
 * wizard — perché è ciò che il riepilogo mostra al posto della parola «Allegato».
 * Il nome qui sotto è un cognome finto e riconoscibile: è la forma vera di quel
 * nome in produzione, `cv-<cognome>.pdf`.
 */
const NOME_FILE_CV = 'cv-diprova.pdf'

/** Allega il curriculum al campo `cv_path`, come lo farebbe chi sceglie un file.
 *  La sonda vive in `__tests__/helpers/allega-curriculum`: erano SEI copie identiche,
 *  e il giorno in cui il riquadro ha cambiato impaginazione sono cadute tutte e sei. */
const allegaCurriculum = () => allegaCurriculumDiProva(NOME_FILE_CV)

/**
 * Compila TUTTI i campi del modulo e si ferma sul riepilogo.
 * `vuoti` sono gli id da lasciare in bianco (per il collaudo del «Non indicato»).
 *
 * ⚠️ IL CURRICULUM SI ALLEGA SEMPRE, e dal 2026-08-24 non è più una scelta: il
 * campo è OBBLIGATORIO, quindi senza allegato il passo «profilo» non avanza e
 * ogni chiamata a questa funzione si fermerebbe lì — undici test che cadono in
 * timeout su `waitFor` e si leggono come «il wizard è rotto». Fino a ieri era il
 * parametro `allegaCv`, spento per difetto: un parametro che ha un solo valore
 * possibile è un parametro che mente sul fatto che ci sia una scelta.
 *
 * Il caso «senza curriculum» non si ottiene più da qui: ha il suo `describe`
 * dedicato, che si ferma al passo profilo proprio perché è lì che il modulo si
 * blocca.
 */
async function compilaTutto(vuoti: string[] = []): Promise<void> {
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
  await allegaCurriculum()
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
    // Il curriculum è obbligatorio dal 2026-08-24: questo caso non parla di lui,
    // ma senza allegato il passo «profilo» non avanza e il test non arriverebbe
    // mai al riepilogo di cui parla.
    await allegaCurriculum()
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
    // Le posizioni restano un elenco, una per riga, con l'etichetta spuntata —
    // che dal 2026-08-15 porta anche la fascia dentro il nome del mestiere.
    expect(screen.getByText(POSIZIONE_SCELTA)).toBeInTheDocument()
    expect(screen.queryByText(POSIZIONE_NON_SCELTA)).not.toBeInTheDocument()
  })

  it('i facoltativi lasciati VUOTI si vedono come «Non indicato»: l’omissione resta visibile', async () => {
    // ⚠️ QUESTO ELENCO HA PERSO DUE ID IN DUE GIORNI, PER DUE RAGIONI OPPOSTE, e
    // vale la pena tenerle distinte perché la seconda è quella che inganna.
    //  · `disponibilita` è uscito il 2026-08-24 insieme al CAMPO: un id che il
    //    template non ha più non è un facoltativo lasciato vuoto, è un id che
    //    `campo()` fa esplodere.
    //  · `cv_path` è uscito lo stesso giorno restando nel template: non è più
    //    FACOLTATIVO. Al riepilogo non ci si arriva più col curriculum vuoto —
    //    il passo «profilo» si ferma prima — quindi «Curriculum: Non indicato»
    //    è uno stato che l'invio non produce. Il ramo nel componente RESTA (è
    //    l'unica cosa che direbbe, in rosso e sul riepilogo, che il blocco a
    //    monte si è rotto), ma non è più questo test a esercitarlo.
    //
    // Il conteggio in coda è `vuoti.length`, cioè DERIVATO, quindi si riallinea
    // da solo — e un errore in questa lista si vede in due versi su tre.
    // Misurato rompendola apposta, non dedotto:
    //  · un id di TROPPO, non nel template → `campo(id)` LANCIA. ROSSO.
    //  · `cv_path` RIMESSO qui → `compilaTutto` lo allega comunque (è
    //    obbligatorio), a schermo la riga dice «Allegato» e non «Non indicato»:
    //    la prima asserzione del ciclo cade. ROSSO.
    //  · uno degli altri sei TOLTO da qui → `compilaTutto` glielo riempie, a
    //    schermo ne restano sei e `vuoti.length` è sei. **VERDE**, e la
    //    copertura di quel campo è sparita in silenzio.
    // È l'unico verso che resta scoperto, ed è il motivo per cui questi sei si
    // contano a mano prima di toccarli.
    const vuoti = ['telefono', 'residence_city', 'residence_province', 'titolo_dettaglio', 'anni_esperienza', 'note']
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

  /*
   * ── UN FILE NON SI «INDICA»: SI ALLEGA (25/08/2026, quarto giro) ───────────
   *
   * Il ramo `type: 'file'` del riepilogo ripiegava su `candRiepilogoNonIndicato`,
   * cioè sulla STESSA parola che le righe qui sopra usano per il telefono, il
   * comune e la provincia lasciati vuoti perché si poteva. Due difetti in una
   * riga sola: «Non indicato» è la parola sbagliata per un allegato, e — cosa che
   * pesa di più — rendeva quella riga indistinguibile da un facoltativo vuoto,
   * proprio mentre il commento accanto al ramo la dichiara «l'unico allarme che
   * resta se l'obbligo salta». Una rete di sicurezza che quando scatta si esprime
   * come un campo facoltativo vuoto non è una rete: è una riga in più.
   *
   * ⚠️ PERCHÉ IL PRESIDIO GUARDA IL SORGENTE E NON LA SCHERMATA. Lo stato non è
   * più raggiungibile dal wizard — il passo «profilo» si ferma prima, ed è il
   * motivo per cui `cv_path` è uscito dalla lista `vuoti` qui sopra. Renderlo
   * vorrebbe dire rompere apposta la validazione, cioè collaudare un componente
   * diverso da quello che va in produzione. Si difende quindi ciò che si può
   * difendere: che la chiave esista nelle due lingue, che sia DIVERSA da quella
   * dei facoltativi (senza questo, «Non allegato» potrebbe essere lo stesso testo
   * e l'allarme resterebbe muto), e che il ramo del file usi quella e non l'altra.
   */
  it('il riepilogo di un allegato mancante dice «Non allegato», non «Non indicato»', () => {
    expect(itPublic.candRiepilogoNonAllegato, 'manca la chiave italiana').toBeTruthy()
    expect(enPublic.candRiepilogoNonAllegato, 'manca la chiave inglese').toBeTruthy()
    expect(
      itPublic.candRiepilogoNonAllegato,
      'l’allarme dell’allegato dice la stessa parola dei facoltativi vuoti: non allarma nessuno',
    ).not.toBe(itPublic.candRiepilogoNonIndicato)
    expect(enPublic.candRiepilogoNonAllegato).not.toBe(enPublic.candRiepilogoNonIndicato)

    // …e il ramo del file usa quella. Commenti tolti prima di cercare: questo
    // stesso blocco cita entrambe le chiavi, e cercarle nel sorgente grezzo
    // renderebbe il test verde per colpa della propria spiegazione.
    const codice = fs
      .readFileSync(
        path.join(process.cwd(), 'src/components/features/public/CandidaturaInsegnanteWizard.tsx'),
        'utf8',
      )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const ramo = codice.slice(codice.indexOf("if (f.type === 'file')"))
    const fine = ramo.indexOf("if (f.type === 'checkbox')")
    expect(fine, 'il ramo del file ha cambiato forma: questo presidio non lo trova più').toBeGreaterThan(0)
    const soloFile = ramo.slice(0, fine)
    expect(soloFile, 'il ramo del file ripiega ancora sulla parola dei facoltativi').not.toContain(
      "t('candRiepilogoNonIndicato')",
    )
    expect(soloFile).toContain("t('candRiepilogoNonAllegato')")
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
   * ── E LA RIGA DICE IL NOME DEL FILE, NON PIÙ LA PAROLA «Allegato» (25/08/2026) ─
   *
   * Questo test pretendeva anche che il NOME del file non comparisse, con due
   * ragioni. La prima — «non sopravvive alla rotta di caricamento» — riguardava il
   * PERCORSO e resta vera: dal percorso il nome non si ricava, ed è per questo che
   * ora sale da `FileField` e lo tiene il wizard. La seconda — «quel nome è
   * `cv-<cognome>.pdf`, cioè il cognome di chi si è candidato, e le schermate si
   * fotografano» — non regge alla misura, ed è la misura che segue: su QUESTA
   * schermata il cognome è già stampato per esteso come valore del campo
   * «Cognome», due centimetri più su. Stampare `cv-diprova.pdf` non aggiunge
   * niente a una fotografia che contiene già «Di Prova» — e lo stesso nome il
   * prodotto lo mostra già nel riquadro del campo, un passo prima.
   *
   * Quel che invece costava: la riga del curriculum era l'UNICA del riepilogo a
   * non rimandare indietro ciò che la persona ha scelto, e lo era proprio sul solo
   * campo diventato obbligatorio. Da «Allegato» non si distingue il curriculum
   * dalla fotografia sbagliata scattata due minuti prima — che è esattamente
   * l'errore di chi compila dal telefono, cioè la gente che questo campo protegge.
   *
   * Il divieto sul PERCORSO — la chiave d'archivio del bucket privato — resta
   * intero, ed è l'unico che questo test è mai esistito per difendere davvero.
   */
  it('il curriculum si riepiloga col NOME DEL FILE, e il suo PERCORSO non compare da nessuna parte', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await compilaTutto()

    // 1 · La riga c'è, e dice QUALE file è arrivato — controllabile, come ogni
    //     altra riga del riepilogo.
    expect(sotto(String(campo('cv_path').label))).toBe(NOME_FILE_CV)
    expect(
      sotto(String(campo('cv_path').label)),
      'la riga è tornata alla parola generica: da lì non si controlla niente',
    ).not.toBe(itPublic.candRiepilogoCvAllegato)

    // 1bis · LA MISURA CHE HA CHIUSO L'OBIEZIONE «il nome contiene il cognome»:
    //        il cognome è GIÀ su questa schermata, come valore del campo che lo
    //        raccoglie. Se un giorno il riepilogo smettesse di mostrarlo, questa
    //        riga diventerebbe rossa e l'obiezione andrebbe ripesata da capo.
    expect(sotto(String(campo('cognome').label))).toBe(SCRITTI.cognome)

    // 2 · ⚠️ IL CONTROLLO CHE CONTA: nel testo della schermata non c'è né il
    //     percorso, né il prefisso del bucket, né l'uuid che lo compone.
    const testo = document.body.textContent ?? ''
    // Il controllo POSITIVO viene prima: una sonda che legge il documento
    // sbagliato — o un riepilogo che non è stato dipinto — supererebbe da sola
    // tutte le righe qui sotto senza guardare niente.
    expect(testo).toContain(NOME_FILE_CV)
    expect(testo).not.toContain(PERCORSO_CV)
    expect(testo).not.toContain(CV_PREFISSO)
    expect(testo).not.toContain('11111111-2222-4333-8444-555555555555')
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
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_A }))
    avanti()
    await compilaTutto()

    expect(sotto(itPublic.candRiepilogoSede)).toBe(NOME_SEDE_A)
    fireEvent.click(screen.getByRole('button', { name: nomeComando }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_B })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_B }))
    // Anche dal PRIMO passo il ritorno è uno solo, e scavalca tre passi già
    // compilati: `prosegui()` li rivalida tutti prima di lasciar passare, quindi
    // qui non c'è nessun controllo saltato — solo tre schermate risparmiate.
    tornaAlRiepilogo()
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    // ⚠️ ENTRAMBE, e la riga è cambiata il 2026-08-19 con la scelta multipla.
    // Fino a ieri erano radio e la seconda spunta SOSTITUIVA la prima: il
    // riepilogo diceva «Kidville Beta». Adesso sono caselle, spuntare la seconda
    // AGGIUNGE, e la candidatura è rivolta a due plessi. Il riepilogo deve dirlo
    // — è l'ultima schermata prima dell'invio, e chi ha spuntato due sedi
    // leggendone una sola concluderebbe che la seconda non ha preso.
    expect(sotto(itPublic.candRiepilogoSede)).toBe(`${NOME_SEDE_A}, ${NOME_SEDE_B}`)
    // E togliendo la prima resta la seconda: la casella si de-spunta davvero.
    fireEvent.click(screen.getByRole('button', { name: nomeComando }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_A }))
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
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_A }))
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
    const titolo = screen.getByText(itPublic.candRitornoInterrottoTitolo)
    // ⚠️ SI CERCA DENTRO IL RIQUADRO, non nella pagina intera.
    //
    // Fino al 2026-08-20 questa riga era `screen.getByText(/Il tuo profilo/i)` e
    // passava per la ragione sbagliata: il mock di `next-intl` ignorava i valori
    // di `t()`, quindi il corpo del riquadro mostrava letteralmente «il passo
    // «{passo}»» — con le graffe — e a soddisfare l'asserzione era il TITOLO
    // della schermata, che si chiama «Il tuo profilo» per conto suo. Il riquadro
    // non nominava un bel niente, e il test diceva che lo faceva.
    //
    // Ora il mock formatta quando arrivano dei valori, e la ricerca è ristretta
    // al riquadro: se il nome del passo sparisce dal corpo, questa riga cade.
    const riquadro = titolo.closest('div') as HTMLElement
    expect(riquadro).not.toBeNull()
    expect(
      within(riquadro).getByText(new RegExp(itPublic.candProfilo, 'i')),
      'il riquadro non nomina il passo rimasto indietro',
    ).toBeInTheDocument()
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
  it('sta SOTTO le sedi come ogni altro messaggio del modulo, con la sua icona e il fuoco sulla prima casella', async () => {
    mockRete([ALFA, BETA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())

    avanti()

    const errore = await screen.findByText(itPublic.candSedeErrore)
    // 1 · ha la forma degli altri errori del modulo: cerchio d'allarme, non
    //     una riga di testo nuda. Era l'unico errore della pagina senza icona.
    expect(errore.querySelector('svg')).not.toBeNull()
    // 2 · sta DENTRO il gruppo e DOPO l'ultima scelta.
    const gruppo = errore.closest('fieldset')
    expect(gruppo).not.toBeNull()
    const caselle = within(gruppo!).getAllByRole('checkbox')
    const ultima = caselle[caselle.length - 1]
    expect(
      ultima.compareDocumentPosition(errore) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // 3 · e il fuoco è sulla cosa da fare, non sul bottone che ha risposto di no.
    expect(document.activeElement).toBe(caselle[0])
  })
})

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * IL CURRICULUM È OBBLIGATORIO — e obbligatorio vuol dire CHE IL MODULO NON
 * AVANZA, non che il template lo dichiari.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Decisione del titolare del 2026-08-24: senza curriculum la candidatura non si
 * invia. Il prezzo è stato MISURATO prima di deciderlo — quattro candidature su
 * dieci (àncora `MISURA-CV`) oggi arrivano senza allegato, e sono
 * esattamente quelle che d'ora in poi si fermeranno — quindi il blocco deve
 * essere impeccabile: chiaro, sotto il campo giusto, e con il fuoco dove sta la
 * cosa da fare.
 *
 * ⚠️ PERCHÉ QUESTO `describe` ESISTE INVECE DI FIDARSI DEL `required: true`.
 * `required` sul template è una dichiarazione: vale quanto vale la catena che lo
 * legge. Fra il template e il bottone «Avanti» ci sono un `Controller`, le sue
 * `rules`, `validateField`, `trigger` e `setFocus`. Se UNO di quegli anelli non
 * arrivasse al ramo `field.type === 'file'` — è già successo su questo stesso
 * campo per il `ref`, che mancava e rendeva `setFocus` un comando senza
 * destinatario — il modulo avanzerebbe lo stesso e il rifiuto arriverebbe dal
 * server, dopo, su una schermata che non c'è più. Qui si misura il gesto, non
 * l'attributo.
 */
describe('CandidaturaInsegnanteWizard — senza curriculum il modulo non avanza', () => {
  /** Porta fino al passo «Il tuo profilo» compilato, MA senza allegare niente. */
  async function finoAlProfiloSenzaCv(): Promise<void> {
    await waitFor(() => expect(screen.getByPlaceholderText(segnaposto('nome'))).toBeInTheDocument())
    for (const id of ['nome', 'cognome', 'email', 'telefono', 'residence_city', 'residence_province']) {
      scrivi(id, SCRITTI[id])
    }
    avanti()
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: TITOLO.value } })
    fireEvent.click(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA }))
  }

  /*
   * ── MENTRE IL CURRICULUM SALE, IL MODULO NON DEVE DIRE CHE NON C'È ─────────
   *
   * Il caso: si sceglie il file, il caricamento parte, e prima che finisca si
   * preme «Avanti». Il riquadro del campo in quell'istante dice «Caricamento…» e
   * porta `aria-busy="true"`; il modulo, giustamente, non avanza — il percorso
   * non c'è ancora. Ma il MOTIVO che veniva scritto sotto il campo era «Campo
   * obbligatorio», cioè l'accusa di non aver allegato niente rivolta proprio a
   * chi ha appena scelto il file e sta aspettando.
   *
   * ⚠️ FINO AL 24/08 LA STESSA CORSA NON AVEVA CONSEGUENZE: il campo era
   * facoltativo, si passava oltre e basta. Da quando è obbligatorio quella frase
   * si legge come un rifiuto — e la legge, per prima, la popolazione che questa
   * modifica manda al caricatore: i quattro su dieci che oggi non allegano, cioè chi
   * fotografa il curriculum col telefono su rete mobile, dove il caricamento dura.
   *
   * ⚠️ LA REGOLA DI VALIDAZIONE NON SI TOCCA: `validateField` ha ragione, il
   * valore è vuoto. A essere sbagliato è il MESSAGGIO, che non sapeva del
   * caricamento in volo — l'informazione esisteva (`aria-busy` la stampa) e non
   * arrivava a chi decide cosa scrivere. Una seconda regola di validazione sarebbe
   * stata «la regola destinata a divergere».
   */
  it('mentre il curriculum si sta caricando il messaggio dice di ASPETTARE, non «Campo obbligatorio»', async () => {
    // Caricamento che non risponde MAI: è lo stato «in volo», tenuto fermo.
    let sbloccaCaricamento: (() => void) | null = null
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [ALFA, BETA] }) })
      }
      if (url.includes('/api/iscrizione/insegnanti/upload')) {
        return new Promise((risolvi) => {
          sbloccaCaricamento = () =>
            risolvi({ ok: true, status: 200, json: async () => ({ path: PERCORSO_CV }) })
        })
      }
      if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
        corpiInviati.push(JSON.parse(String(init.body)))
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: null }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await finoAlProfiloSenzaCv()

    const controllo = document.getElementById('cv_path') as HTMLInputElement
    fireEvent.change(controllo, {
      target: { files: [new File(['%PDF-1.4 finto'], NOME_FILE_CV, { type: 'application/pdf' })] },
    })
    // La premessa del caso, misurata e non data per scontata: il caricamento È in
    // volo — il riquadro lo dice e l'attributo lo dichiara.
    //
    // ⚠️ `caricamentoAllegato` E NON `caricamento`: sono due chiavi diverse, e
    // fino al 25/08/2026 avevano lo STESSO valore italiano — quindi questa riga
    // misurava la chiave sbagliata e passava per coincidenza. In inglese le due
    // erano già distinte («Loading…» contro «Uploading…»). Ora anche in italiano
    // («Caricamento del file…»), e la coincidenza è finita.
    //
    // ⚠️ LA RICERCA È RISTRETTA AL RIQUADRO, e non è pignoleria. Dal 2026-08-25
    // il testo dell'attesa sta in DUE posti: dentro la `<label>` (il riquadro, che è ciò
    // che questa riga vuole misurare) e dentro la regione viva `sr-only`
    // `role="status"` che annuncia lo stato a chi non vede la rotellina. Un
    // `screen.getByText` globale trovava due nodi e cadeva con «Found multiple
    // elements» — cioè per una ragione che non c'entra col comportamento difeso.
    // Il presidio della regione viva è un altro e sta in
    // `__tests__/a11y/candidatura-insegnante-a11y.test.tsx`; qui si misura il
    // riquadro, e restringere la ricerca è il modo di continuare a misurarlo.
    const riquadro = controllo.closest('label')!
    await waitFor(() =>
      expect(within(riquadro).getByText(itParentForms.caricamentoAllegato)).toBeInTheDocument(),
    )
    expect(controllo.getAttribute('aria-busy')).toBe('true')

    avanti()

    // 1 · Non si avanza: giusto, il percorso non c'è ancora.
    await waitFor(() => expect(document.getElementById('cv_path-error')).not.toBeNull())
    expect(
      screen.queryByRole('checkbox', { name: /informativa sulla privacy/i }),
      'il modulo è avanzato ai consensi con il caricamento ancora in volo',
    ).not.toBeInTheDocument()

    // 2 · …e il motivo detto è quello VERO.
    //     ⚠️ SI VIETANO ENTRAMBE LE FRASI DEL «VUOTO», e non solo quella vecchia:
    //     dal 25/08/2026 `validateField` sul campo di caricamento dice «Allega un
    //     file per proseguire» invece di «Campo obbligatorio». Lasciando il solo
    //     divieto della frase di ieri, questo controllo sarebbe diventato verde per
    //     costruzione — cioè avrebbe smesso di difendere qualcosa proprio mentre
    //     l'accusa sbagliata cambiava parole.
    expect(
      document.getElementById('cv_path-error')?.textContent,
      'al campo che sta caricando si dice che non è stato allegato niente',
    ).not.toContain(itParentForms.campoObbligatorio)
    expect(
      document.getElementById('cv_path-error')?.textContent,
      'al campo che sta caricando si chiede di allegare il file che sta già salendo',
    ).not.toContain('Allega un file')
    expect(document.getElementById('cv_path-error')?.textContent).toContain(
      itParentForms.attendiCaricamento,
    )

    // 3 · E finito il caricamento il modulo riparte: l'attesa era un'attesa, non
    //     un vicolo cieco.
    sbloccaCaricamento!()
    // Il nome vive in due `<span>` (troncamento centrale): si guarda il riquadro.
    await waitFor(() => expect(riquadro.textContent).toContain(NOME_FILE_CV))
    avanti()
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
  })

  it('«Avanti» non porta da nessuna parte, lo DICE sotto il campo e ci posa il fuoco', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await finoAlProfiloSenzaCv()

    // Tutto il resto del passo è a posto: l'unica cosa che manca è l'allegato.
    // È il caso che vale il 41% delle candidature di oggi, non un caso limite.
    avanti()

    // 1 · NON si è passati. Il modo di dirlo che non mente è cercare la schermata
    //     successiva: i consensi. Un `queryByText` sull'errore direbbe solo che
    //     un errore c'è, non che il passo si è fermato.
    await waitFor(() =>
      expect(screen.getByText(itPublic.candCvNota), 'il passo «profilo» è stato lasciato').toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('checkbox', { name: /informativa sulla privacy/i }),
      'il modulo è avanzato ai consensi senza il curriculum',
    ).not.toBeInTheDocument()

    // 2 · e lo dice DOVE si guarda: il messaggio è quello degli altri campi
    //     obbligatori del modulo — la stessa frase, dallo stesso motore
    //     (`validateField`) — dentro un `role="alert"` collegato al campo con
    //     `aria-describedby`. Non una formulazione nuova per lo stesso rifiuto.
    const cv = document.getElementById('cv_path') as HTMLInputElement
    expect(cv, 'il campo del curriculum non è reso').not.toBeNull()
    // ⚠️ L'ATTRIBUTO PORTA DUE ID DAL 25/08, e l'ORDINE È IL PUNTO. Fino a quel
    // giorno qui c'era `.toBe('cv_path-error')`: l'errore era l'unica descrizione
    // del campo, e la nota che spiega l'obbligo («va bene anche una fotografia…
    // senza allegato non si può inviare») non era agganciata a niente. Ora è
    // agganciata, e `aria-describedby` le legge in sequenza: **prima il
    // messaggio**, che è la cosa urgente, poi la nota. Un `toContain` da solo non
    // difenderebbe l'ordine, e un attributo che cominciasse dalla nota farebbe
    // sentire il consiglio prima del rifiuto.
    const descritto = (cv.getAttribute('aria-describedby') ?? '').split(/\s+/)
    expect(descritto, 'il campo in errore non è collegato al suo messaggio').toEqual([
      'cv_path-error',
      'cv_path-nota',
    ])
    const idErrore = descritto[0]
    const messaggio = document.getElementById(idErrore)
    expect(messaggio?.getAttribute('role'), 'il messaggio non viene annunciato').toBe('alert')
    // ⚠️ La frase è quella dei campi di CARICAMENTO, non quella generica: su un
    // riquadro «Campo obbligatorio» non dice cosa fare (25/08/2026).
    expect(messaggio?.textContent).toContain('Allega un file per proseguire')
    expect(cv.getAttribute('aria-invalid')).toBe('true')

    // 3 · e il fuoco sta sulla cosa da fare. Senza, chi usa la tastiera o uno
    //     screen reader resta sul bottone che ha appena detto di no, in fondo
    //     alla pagina, con un messaggio che non vede.
    //
    // ⚠️ `waitFor` E NON UN'ASSERZIONE SECCA, e non è pigrizia: `setFocus` di
    // react-hook-form mette il `focus()` dentro un `setTimeout`, quindi subito
    // dopo il clic il fuoco è ancora dov'era (qui l'`h2` del passo). MISURATO:
    // senza l'attesa questa riga fallisce dicendo «expected <h2> to be <input
    // id="cv_path">», cioè accusa il prodotto di un difetto che non ha. È lo
    // stesso `waitFor` che usa il test gemello dell'a11y sul primo campo di
    // testo non valido.
    await waitFor(() => expect(document.activeElement, 'il fuoco non è sul curriculum').toBe(cv))
  })

  it('allegare il curriculum sblocca lo stesso passo: il blocco è il CV, non un guasto del wizard', async () => {
    // ⚠️ IL CONTROLLO NEGATIVO, e non è cerimoniale: senza, il test qui sopra
    // resterebbe verde anche se il passo «profilo» fosse rotto per una qualunque
    // altra ragione — un titolo di studio che non si salva, una posizione che non
    // si spunta — e attribuirebbe al curriculum un blocco che non è suo.
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await finoAlProfiloSenzaCv()
    avanti()
    await waitFor(() =>
      expect(document.getElementById('cv_path')?.getAttribute('aria-invalid')).toBe('true'),
    )

    await allegaCurriculum()
    avanti()

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
  })

  /*
   * ── IL SALTO AL RIEPILOGO, che è la strada che `trigger` NON copre ─────────
   *
   * Il wizard permette di tornare dritti al riepilogo da un passo precedente, e
   * `prosegui()` valida i passi che quel salto scavalca — con `validateField` su
   * `getValues`, NON con `trigger`, che sui campi smontati risponde `true` a
   * qualunque cosa. Se il curriculum non entrasse in quel controllo, si
   * arriverebbe al riepilogo con un modulo che il server rifiuta: cioè
   * esattamente il difetto per cui `prosegui()` è stato scritto, spostato su un
   * campo nuovo.
   *
   * ⚠️ LO SCENARIO NON È COSTRUITO: è un CARICAMENTO FALLITO. `FileField`, quando
   * la rotta risponde male (un 429 del tetto per IP, un 500, la rete che cade),
   * chiama `onChange('')` — cioè SVUOTA il campo. A schermo resta il messaggio
   * rosso del caricamento, ma se in quel momento si preme «Indietro» e poi «Torna
   * al riepilogo», il passo «profilo» viene scavalcato con il curriculum vuoto.
   * È la sola strada per cui un modulo può arrivare al riepilogo senza allegato,
   * ed è per questo che si collauda questa e non un'altra.
   */
  it('il ritorno al riepilogo si ferma sul profilo se un caricamento fallito ha svuotato il curriculum', async () => {
    mockRete([ALFA, BETA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('checkbox', { name: NOME_SEDE_A })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: NOME_SEDE_A }))
    avanti()
    await compilaTutto()

    // Si torna sul profilo e si prova a sostituire l'allegato: il caricamento
    // fallisce, e il campo resta VUOTO senza che nessuno lo dica al riepilogo.
    modifica(itPublic.candProfilo)
    await waitFor(() => expect(document.getElementById('cv_path')).not.toBeNull())

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [ALFA, BETA] }) })
      }
      if (url.includes('/api/iscrizione/insegnanti/upload')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Caricamento non riuscito' }) })
      }
      if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
        corpiInviati.push(JSON.parse(String(init.body)))
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: null }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    const cv = document.getElementById('cv_path') as HTMLInputElement
    fireEvent.change(cv, {
      target: { files: [new File(['%PDF-1.4 finto'], 'cv-secondo-tentativo.pdf', { type: 'application/pdf' })] },
    })
    // Il campo è tornato vuoto: è la premessa di tutto il caso, e si misura
    // invece di darla per scontata. Il riquadro torna a dire «Seleziona un
    // file», che è ciò che `FileField` mostra quando `value` è vuoto — la sola
    // prova a schermo che `onChange('')` è passato.
    await waitFor(() =>
      expect(screen.getByText(itParentForms.selezionaFile)).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: itPublic.candIndietro }))
    await waitFor(() => expect(screen.getByPlaceholderText(segnaposto('nome'))).toBeInTheDocument())
    expect(screen.getByRole('button', { name: itPublic.candTornaAlRiepilogo })).toBeInTheDocument()

    tornaAlRiepilogo()

    // 1 · Il salto si è fermato sul profilo, e NON si è arrivati al riepilogo.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candProfilo })).toBeInTheDocument(),
    )
    expect(sulRiepilogo()).toBe(false)
    // 2 · e non in silenzio: il riquadro nomina il passo rimasto indietro.
    expect(screen.getByText(itPublic.candRitornoInterrottoTitolo)).toBeInTheDocument()
    // 3 · e il campo porta il suo messaggio, scritto a mano da `prosegui()`
    //     perché `trigger` non lo avrebbe visto.
    const cvOra = document.getElementById('cv_path') as HTMLInputElement
    expect(cvOra.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById('cv_path-error')?.textContent).toContain(
      'Allega un file per proseguire',
    )
  })
})
