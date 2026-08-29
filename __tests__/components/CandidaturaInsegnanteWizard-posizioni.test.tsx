import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import itCampi from '../../messages/it/parentForms.json'
import {
  INSEGNANTE_FIELDS, GRADI_OPTIONS, POSIZIONI_OPTIONS, CANDIDATURA_LIMITI,
  gradiDallePosizioni,
} from '@/lib/forms/insegnanti-template'
import { campiVisibili } from '@/lib/forms/conditional'
import { MSG_SCEGLI_OPZIONE } from '@/lib/forms/validate-fields'
import { SEDE_A } from '../fixtures/sedi'

/**
 * `/lavora-con-noi` — LE POSIZIONI, e il fatto che siano PIÙ D'UNA.
 *
 * ─── QUESTO FILE SI CHIAMAVA `-gradi`, E PARLAVA DI UNA DOMANDA CHE NON C'È ──
 *
 * Fino al 2026-08-14 il modulo chiedeva «per quali fasce ti proponi» con tre
 * caselle obbligatorie. Quel campo non è stato reso facoltativo: è SPARITO —
 * `INSEGNANTE_FIELDS` non contiene più nessun `gradi` (lo verifica il collaudo
 * «`gradi` non compare più nel corpo del POST» qui sotto). Al suo posto c'è
 * `posizioni`, che le fasce le porta dentro spezzate una per una
 * («Insegnante — Nido (0-3)», …) insieme a collaboratrice, cuoca, segreteria e
 * un «Altro» scritto a mano; `gradi` la DERIVA il server da ciò che è stato
 * spuntato. I sette casi del file precedente sono stati tradotti sulla domanda
 * nuova, non rattoppati: un test che continuasse a nominare le fasce
 * verificherebbe una schermata che non esiste.
 *
 * ─── PERCHÉ È UN CAMPO SOLO, E PERCHÉ NON HA VALIDAZIONE PROPRIA ───────────
 *
 * `posizioni` è dichiarato nel template come `type: 'checkbox'` con
 * `required: true`, e quel tipo è GIÀ multi-valore: `FieldRenderer` lo rende con
 * un `Controller` il cui valore è un array (default `[]`), e `validateField` —
 * tramite `eVuoto()` — considera vuota una checkbox il cui valore non è un array
 * o è un array vuoto. Quindi «almeno una posizione» esiste già, sul client e sul
 * server, con la STESSA funzione. Una validazione scritta a mano qui sarebbe una
 * seconda regola per lo stesso vincolo: due regole per una cosa sola divergono,
 * ed è la lezione che questo repo ha già pagato.
 *
 * ─── PERCHÉ LA SCELTA È MULTIPLA ───────────────────────────────────────────
 *
 * Chi cerca lavoro in una scuola dell'infanzia si propone spesso per più cose
 * insieme («insegnante, ma anche in cucina»). Costringere a sceglierne una fa
 * perdere alla segreteria proprio l'informazione con cui smista la candidatura —
 * e non c'è modo di recuperarla dopo.
 *
 * ─── E L'ARRAY DEVE ARRIVARE FINO AL CORPO DEL POST ────────────────────────
 *
 * La casella spuntata sullo schermo non serve a niente se poi il payload non la
 * porta: è esattamente il difetto già pagato sui CONSENSI del wizard fratello,
 * dove ogni pezzo funzionava e il collegamento fra penultimo e ultimo passo no.
 * `POST /api/iscrizione/insegnanti` valida `data.posizioni` con uno `z.enum` su
 * `POSIZIONI_AMMESSE`: un array che non parte è un 400 su un modulo compilato
 * per intero — e da quell'array il server ricava anche `gradi`, quindi non
 * partendo si perde pure la fascia.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'
import { allegaCurriculumDiProva } from '../helpers/allega-curriculum'

/**
 * LE SETTE VOCI, ETICHETTA E VALORE, RIBATTUTE A MANO — l'unica lista di questo
 * file che lo è, e di proposito.
 *
 * L'etichetta è ciò che chi si candida LEGGE e il `value` è ciò che finisce in
 * `candidature_insegnanti.posizioni`, dove un `CHECK` di appartenenza lo aspetta:
 * derivarli qui da `POSIZIONI_OPTIONS` renderebbe il confronto una tautologia —
 * la stessa costante paragonata a se stessa — e una voce rinominata o un valore
 * cambiato passerebbero senza un rosso. Che le tre docenti si COSTRUISCANO da
 * `GRADI_OPTIONS` invece di essere ribattute nel prodotto è verificato a parte,
 * qui sotto.
 *
 * ⚠️ IL TRATTINO DELLE PRIME TRE È UN EM DASH (U+2014), non un trattino corto: a
 * schermo sono due glifi che si somigliano, per `getByRole({ name })` sono due
 * stringhe diverse. Il codice del carattere è asserito, così un file salvato con
 * il trattino sbagliato non passa per una svista di resa.
 */
const POSIZIONI_ATTESE: ReadonlyArray<readonly [string, string]> = [
  ['insegnante_nido', 'Insegnante — Nido (0-3)'],
  ['insegnante_infanzia', 'Insegnante — Infanzia (3-6)'],
  ['insegnante_primaria', 'Insegnante — Primaria (6-11)'],
  ['collaboratrice', 'Collaboratrice scolastica'],
  ['cuoca', 'Cuoca / aiuto cucina'],
  ['segreteria', 'Segreteria / amministrazione'],
  ['altro', 'Altro (specifica qui sotto)'],
]

const ETICHETTA = Object.fromEntries(POSIZIONI_ATTESE.map(([v, l]) => [v, l])) as Record<string, string>

/** Le due rotte, SCRITTE PER ESTESO: l'una è il prefisso dell'altra (vedi `mockRete`). */
const ROTTA_INVIO = '/api/iscrizione/insegnanti'
const ROTTA_CARICAMENTO_CV = '/api/iscrizione/insegnanti/upload'
/** Il ripiego di `FileField` quando `uploadEndpoint` non arriva: sta dietro `requireUser`. */
const ROTTA_RIPIEGO = '/api/forms/upload'

/** Il percorso che la rotta di caricamento restituisce: `candidature/<uuid>-cv.<est>`. */
const PERCORSO_CV = 'candidature/11111111-2222-4333-8444-555555555555-cv.pdf'

const fetchMock = vi.fn()
const corpiInviati: unknown[] = []
/** Ogni URL a cui è stato spedito un multipart: è il bersaglio del caricamento. */
const caricamenti: string[] = []

function mockRete(): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const dove = String(url)
    // ⚠️ IL CARICAMENTO SI RICONOSCE PER PRIMO, e con l'uguaglianza esatta:
    // `/api/iscrizione/insegnanti` è un PREFISSO di
    // `/api/iscrizione/insegnanti/upload`. Con un `includes` nell'ordine
    // opposto il multipart del curriculum verrebbe contato come una
    // candidatura inviata, e il collaudo dell'endpoint sarebbe verde su
    // qualunque rotta.
    if (dove === ROTTA_CARICAMENTO_CV && init?.method === 'POST') {
      caricamenti.push(dove)
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ path: PERCORSO_CV }),
      })
    }
    if (dove === ROTTA_INVIO && init?.method === 'POST') {
      corpiInviati.push(JSON.parse(String(init.body)))
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'c-1' }) })
    }
    // Qualunque altro multipart (in pratica: il ripiego) si registra comunque,
    // altrimenti un caricamento finito sulla porta sbagliata sarebbe solo un
    // caricamento «non riuscito» invece che un caricamento andato altrove.
    if (init?.method === 'POST') caricamenti.push(dove)
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

/** La casella di una posizione, cercata per l'etichetta che si legge a schermo. */
const casella = (valore: string): HTMLInputElement =>
  screen.getByRole('checkbox', { name: ETICHETTA[valore] }) as HTMLInputElement

const avanti = (): void => {
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
}

/** Compila il passo «I tuoi dati» e passa al profilo. Il link è già targato. */
async function vaiAlProfilo(): Promise<void> {
  await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
    target: { value: 'aspirante@example.test' },
  })
  avanti()
  await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'laurea_triennale' } })
  await allegaCurriculum()
}

/**
 * Allega il curriculum, che dal 2026-08-24 è OBBLIGATORIO.
 *
 * ⚠️ Sta dentro `vaiAlProfilo` di proposito, e non nei singoli test. Questo file
 * parla delle POSIZIONI: lasciare il curriculum vuoto vorrebbe dire misurare due
 * campi mancanti invece di uno, e i due casi che pretendono il rifiuto sotto
 * «posizioni» — `ALMENO UNA è obbligatoria` e `togliere la spunta all'unica
 * posizione` — cercano «Campo obbligatorio» a schermo: con anche il curriculum
 * vuoto ne trovano DUE e cadono con «Found multiple elements», cioè accusando il
 * campo sbagliato. MISURATO, non previsto.
 */
/** Allega il curriculum al campo `cv_path`, come lo farebbe chi sceglie un file.
 *  La sonda vive in `__tests__/helpers/allega-curriculum`: erano SEI copie identiche,
 *  e il giorno in cui il riquadro ha cambiato impaginazione sono cadute tutte e sei. */
const allegaCurriculum = () => allegaCurriculumDiProva('cv-collaudo.pdf')

/** Consensi → riepilogo, e ci si ferma lì. */
async function vaiAlRiepilogo(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
  avanti()
  await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
}

/** Consensi + riepilogo + invio. */
async function concludi(): Promise<void> {
  await vaiAlRiepilogo()
  fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))
}

/** I `data` della candidatura spedita. */
function datiInviati(): Record<string, unknown> {
  return (corpiInviati[0] as { data?: Record<string, unknown> }).data ?? {}
}

beforeEach(() => {
  vi.clearAllMocks()
  corpiInviati.length = 0
  caricamenti.length = 0
  mockRete()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
})

describe('CandidaturaInsegnanteWizard — le posizioni per cui ci si propone', () => {
  it('le sette posizioni del template sono tutte offerte, come caselle a scelta multipla', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    // L'elenco è quello del `CHECK` di appartenenza della colonna `posizioni`
    // (migrazione `20260814225302`): una voce inventata qui prenderebbe `23514`
    // all'INSERT, cioè un 500 opaco davanti a chi si candida.
    expect(POSIZIONI_OPTIONS.map((o) => [String(o.value), String(o.label)])).toEqual(
      POSIZIONI_ATTESE.map(([v, l]) => [v, l]),
    )
    // Il trattino delle tre docenti è l'EM DASH, non il segno meno.
    expect(ETICHETTA.insegnante_nido).toContain('—')
    expect(ETICHETTA.insegnante_nido).not.toContain('- ')

    // Le tre docenti si COSTRUISCONO da `GRADI_OPTIONS` col prefisso
    // `insegnante_`: è ciò che permette a `gradiDallePosizioni` di riconoscerle
    // senza una seconda lista, e a una fascia aggiunta domani di diventare una
    // posizione da sola.
    for (const g of GRADI_OPTIONS) {
      const valore = `insegnante_${String(g.value)}`
      expect(ETICHETTA[valore]).toBe(`Insegnante — ${String(g.label)}`)
      expect(gradiDallePosizioni([valore])).toEqual([String(g.value)])
    }

    for (const [valore] of POSIZIONI_ATTESE) {
      const c = casella(valore)
      expect(c).toHaveAttribute('type', 'checkbox')
      expect(c).not.toBeChecked()
    }
  })

  it('ALMENO UNA è obbligatoria: senza, «Avanti» non passa e lo dice sotto il campo', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    avanti()

    // La frase è quella di `validateField`, la stessa che userebbe il server.
    // ⚠️ LA COSTANTE, NON LA STRINGA. Dal 25/08 un gruppo a spunta vuoto risponde
    // «Scegli almeno un'opzione per proseguire» — la cadenza di `candSedeErrore`,
    // che il modulo usa già al passo 1 per lo stesso predicato — invece del
    // «Campo obbligatorio» che è la risposta di un database. Ribattuta a mano,
    // questa riga chiedeva manutenzione a ogni ritocco della frase.
    expect(await screen.findByText(MSG_SCEGLI_OPZIONE)).toBeInTheDocument()
    // ED È UNA SOLA. `posizione_altro` è `required: true` con una `condition`:
    // finché «Altro» non è spuntato non è visibile, e ciò che non è visibile non
    // si valida — né qui né sul server, che applica `campiVisibili` prima di
    // `validatePage`. Due messaggi vorrebbero dire che il campo condizionale è
    // obbligatorio per tutti, cioè un modulo che non si può inviare.
    expect(screen.getAllByText(MSG_SCEGLI_OPZIONE)).toHaveLength(1)
    // E non si è passati oltre: i consensi non sono stati raggiunti.
    expect(screen.queryByRole('checkbox', { name: /informativa sulla privacy/i })).not.toBeInTheDocument()
    expect(casella('insegnante_nido')).toBeInTheDocument()
    // Nessun invio è partito: un modulo che non passa la validazione non chiama la rotta.
    expect(corpiInviati).toHaveLength(0)
  })

  it('spuntata una posizione si prosegue, e spuntandone due restano due', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(casella('insegnante_nido'))
    expect(casella('insegnante_nido')).toBeChecked()
    fireEvent.click(casella('cuoca'))

    expect(casella('insegnante_nido')).toBeChecked()
    expect(casella('cuoca')).toBeChecked()
    // Le altre non si sono spuntate da sole: è una scelta multipla, non un radio.
    expect(casella('insegnante_primaria')).not.toBeChecked()
    expect(casella('segreteria')).not.toBeChecked()
  })

  it('togliere la spunta all’unica posizione rimette il blocco: non resta una scelta fantasma', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(casella('collaboratrice'))
    fireEvent.click(casella('collaboratrice'))
    expect(casella('collaboratrice')).not.toBeChecked()

    avanti()
    expect(await screen.findByText(MSG_SCEGLI_OPZIONE)).toBeInTheDocument()
  })

  it('L’ARRAY ARRIVA NEL CORPO DEL POST, con tutte le posizioni spuntate e con i loro valori', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(casella('insegnante_nido'))
    fireEvent.click(casella('cuoca'))
    avanti()
    await concludi()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = datiInviati()
    expect(Array.isArray(dati.posizioni)).toBe(true)
    // I VALORI, non le etichette: è ciò che il `CHECK` della colonna confronta, e
    // «Cuoca / aiuto cucina» all'INSERT prenderebbe `23514`.
    expect(dati.posizioni).toEqual(['insegnante_nido', 'cuoca'])
    // E il resto del passo viaggia insieme, altrimenti il server rifiuta tutto.
    expect(dati.titolo_studio).toBe('laurea_triennale')
    expect(dati.nome).toBe('Ines')
  })

  it('il riepilogo mostra le posizioni scelte con l’etichetta che si è letta spuntandole', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(casella('segreteria'))
    avanti()
    await vaiAlRiepilogo()

    expect(screen.getByText(itPublic.candRiepilogoPosizioni)).toBeInTheDocument()
    expect(screen.getByText(ETICHETTA.segreteria)).toBeInTheDocument()
    expect(screen.queryByText(ETICHETTA.insegnante_nido)).not.toBeInTheDocument()
    expect(screen.queryByText(itPublic.candRiepilogoNessunaPosizione)).not.toBeInTheDocument()
  })

  /*
   * ╔══════════════════════════════════════════════════════════════════════════╗
   * ║  «ALTRO» E LA CASELLA CHE COMPARE SOLO QUANDO SERVE                      ║
   * ╚══════════════════════════════════════════════════════════════════════════╝
   *
   * È la PRIMA logica condizionale di questo modulo: `posizione_altro` è
   * `required: true` con `condition: { field_id: 'posizioni', operator:
   * 'contains', value: 'altro' }`. «Obbligatorio» qui non significa «sempre»,
   * significa «quando è visibile» — e chi valida deve perciò passare i campi
   * VISIBILI, sul client e sul server. Senza quel filtro il modulo rifiuterebbe
   * ogni candidatura che non ha spuntato «Altro», cioè quasi tutte.
   */
  it('spuntare «Altro» fa comparire «Quale posizione», toglierlo la fa sparire', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    expect(screen.queryByLabelText(/^Quale posizione/)).not.toBeInTheDocument()

    fireEvent.click(casella('altro'))
    expect(await screen.findByLabelText(/^Quale posizione/)).toBeInTheDocument()

    fireEvent.click(casella('altro'))
    await waitFor(() => expect(screen.queryByLabelText(/^Quale posizione/)).not.toBeInTheDocument())
  })

  it('con «Altro» spuntato e la casella vuota non si prosegue, e il rifiuto sta sotto quel campo', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(casella('altro'))
    const campo = await screen.findByLabelText(/^Quale posizione/)
    avanti()

    const messaggio = await screen.findByText(itCampi.campoObbligatorio)
    expect(messaggio).toBeInTheDocument()
    // Sotto QUEL campo, non davanti a una frase generica: è
    // `aria-describedby` a dirlo, cioè la stessa cosa che sente chi ascolta.
    expect(campo).toHaveAttribute('aria-describedby', 'posizione_altro-error')
    expect(messaggio).toHaveAttribute('id', 'posizione_altro-error')
    // Non si è passati oltre, e niente è partito.
    expect(screen.queryByRole('checkbox', { name: /informativa sulla privacy/i })).not.toBeInTheDocument()
    expect(corpiInviati).toHaveLength(0)
  })

  it('scritta una posizione libera e poi tolta la spunta ad «Altro», quel testo NON viaggia', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(casella('altro'))
    fireEvent.change(await screen.findByLabelText(/^Quale posizione/), {
      target: { value: 'psicomotricista' },
    })
    // Resta una posizione vera, altrimenti il passo non passerebbe per il vuoto
    // invece che per la ragione in esame.
    fireEvent.click(casella('cuoca'))
    fireEvent.click(casella('altro'))
    await waitFor(() => expect(screen.queryByLabelText(/^Quale posizione/)).not.toBeInTheDocument())

    avanti()
    await concludi()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = datiInviati()
    expect(dati.posizioni).toEqual(['cuoca'])
    // ⚠️ LA CHIAVE NON C'È AFFATTO, e non è pignoleria sulla forma del JSON: il
    // valore resta in react-hook-form (i campi smontati lo conservano,
    // `shouldUnregister` è false, ed è ciò che permette di tornare indietro senza
    // perdere quello che si è scritto). Spedirlo lo farebbe arrivare a una
    // tabella dove il `CHECK` di coerenza pretende che «altro» e il testo ci
    // siano o manchino INSIEME.
    expect('posizione_altro' in dati).toBe(false)
  })

  it('`gradi` NON compare più nel corpo del POST: la fascia la deriva il server', async () => {
    // Non c'è più nessun campo `gradi` nel template: il collaudo che segue
    // verifica che non ne sia rimasta traccia nemmeno nel payload.
    expect(INSEGNANTE_FIELDS.some((f) => f.id === 'gradi')).toBe(false)

    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(casella('insegnante_nido'))
    avanti()
    await concludi()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = datiInviati()
    expect('gradi' in dati).toBe(false)
    expect(dati.posizioni).toEqual(['insegnante_nido'])
    // La fascia esiste ancora, ma come CONSEGUENZA della posizione: è
    // `gradiDallePosizioni` (che la route applica ai valori già filtrati) a
    // ricavarla, e il client non ha più modo di dichiararne una qualunque.
    expect(gradiDallePosizioni(dati.posizioni)).toEqual(['nido'])
  })

  it('una candidatura di sola «cuoca» si invia: nessuna fascia d’età, e va bene così', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(casella('cuoca'))
    avanti()
    await concludi()

    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    const dati = datiInviati()
    expect(dati.posizioni).toEqual(['cuoca'])
    // ⚠️ FASCE ZERO, ED È LA PORTA ATTRAVERSO CUI PASSA UNA CUOCA: una fascia
    // d'età non ce l'ha. Prima del 2026-08-15 il modulo ne pretendeva una — un
    // campo obbligatorio che non la riguardava, cioè un modulo che non si poteva
    // inviare.
    expect(gradiDallePosizioni(dati.posizioni)).toEqual([])
    // Il 201 è arrivato fino a schermo: il pannello di conferma sostituisce i
    // passi, ed è l'unica cosa che dice a chi ha compilato che è finita.
    expect(await screen.findByText(itPublic.candInviata)).toBeInTheDocument()
  })

  /*
   * ── IL CURRICULUM (2026-08-15) ─────────────────────────────────────────────
   *
   * `cv_path` è uscito da `IDS_NON_RESI` del wizard — che adesso è VUOTO — il
   * giorno in cui è nata `POST /api/iscrizione/insegnanti/upload`. Fino a quel
   * giorno il campo esisteva nel template e non si rendeva: nessuna rotta
   * pubblica produceva il prefisso `candidature/` che l'invio pretende, e
   * offrirlo avrebbe voluto dire far caricare un curriculum per poi respingerlo.
   */
  it('il curriculum È RESO, con le estensioni e il tetto che il template dichiara', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    const campo = screen.getByLabelText(/^Curriculum/) as HTMLInputElement
    expect(campo).toHaveAttribute('type', 'file')
    // L'`id` è anche la colonna di destinazione: è da lì che il censimento
    // strutturale qui sotto riconosce il campo.
    expect(campo.id).toBe('cv_path')
    const dichiarato = INSEGNANTE_FIELDS.find((f) => f.id === 'cv_path')
    expect(campo.getAttribute('accept')).toBe(dichiarato?.accept)
    // Il tetto è quello della PIATTAFORMA, non un numero scritto a occhio: sopra
    // di esso la funzione non parte nemmeno e la risposta non è nostra.
    expect(dichiarato?.max_size_mb).toBe(CANDIDATURA_LIMITI.maxCvMb)
    // ⚠️ È OBBLIGATORIO DAL 2026-08-24, e qui c'era scritto il contrario («è
    // facoltativo: chi si candida dal telefono spesso il curriculum non ce l'ha
    // sottomano»). Quella ragione era vera e ha perso contro un'altra: senza
    // curriculum la segreteria non ha niente da valutare. Il prezzo è stato
    // misurato prima di deciderlo — quattro su dieci oggi arrivano senza
    // allegato, àncora `MISURA-CV` — e la contro-obiezione sopravvive
    // nella nota sotto il campo, che continua a dire che va bene anche una
    // fotografia.
    expect(dichiarato?.required).toBe(true)
    expect(screen.getByText(itPublic.candCvNota)).toBeInTheDocument()
  })

  it('il curriculum si carica sulla rotta delle CANDIDATURE, non sul ripiego dietro `requireUser`', async () => {
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await vaiAlProfilo()

    fireEvent.click(casella('collaboratrice'))
    // ⚠️ SI AZZERA IL REGISTRO PRIMA DI MISURARE. Dal 2026-08-24 `vaiAlProfilo`
    // allega già un curriculum (il campo è obbligatorio), quindi `caricamenti`
    // arriva qui con dentro un giro. Questo test guarda dove è andato QUESTO
    // multipart, non quanti ne sono partiti: senza l'azzeramento l'asserzione in
    // coda misurerebbe il conto invece della destinazione, e cadrebbe per una
    // ragione che non è la sua.
    caricamenti.length = 0
    fireEvent.change(screen.getByLabelText(/^Curriculum/), {
      target: { files: [new File(['%PDF'], 'curriculum-ines.pdf', { type: 'application/pdf' })] },
    })

    /*
     * ⚠️ IL BERSAGLIO SI MISURA SUL `fetch`, non su una prop.
     *
     * `FileField` ripiega su `/api/forms/upload` quando `uploadEndpoint` manca
     * (`FieldRenderer.tsx`: `endpoint: uploadEndpoint || '/api/forms/upload'`), e
     * quella rotta sta dietro `requireUser`: su un modulo che si compila SENZA
     * account risponde 401 a ogni caricamento. Nessun test di route lo
     * vedrebbe — la rotta pubblica funziona, è chi la chiama che non la chiama —
     * e a schermo il guasto arriva come «Caricamento non riuscito. Riprova.»,
     * cioè l'invito a rifare l'unica cosa che non può funzionare. Qui si guarda
     * dove il multipart è ANDATO: togliendo `uploadEndpoint` dal wizard questa
     * riga diventa rossa, mentre un controllo sulla prop resterebbe una promessa
     * fatta da chi la passa.
     */
    await waitFor(() => expect(caricamenti).toEqual([ROTTA_CARICAMENTO_CV]))
    expect(caricamenti).not.toContain(ROTTA_RIPIEGO)

    // …e il percorso restituito arriva fino al payload: il campo è collegato al
    // modulo, non solo disegnato accanto agli altri.
    avanti()
    await concludi()
    await waitFor(() => expect(corpiInviati).toHaveLength(1))
    expect(datiInviati().cv_path).toBe(PERCORSO_CV)
  })

  /**
   * ⚠️ IL CONTROLLO STRUTTURALE, e non è pignoleria.
   *
   * Il server valida il template con `validatePage`: un campo OBBLIGATORIO che il
   * modulo non rende è una candidatura rifiutata a ogni invio, da chiunque, per un
   * campo che nessuno può vedere — e nessun test di comportamento se ne
   * accorgerebbe, perché il rifiuto arriva dal server.
   *
   * ── LE DUE MISURE CHE HANNO RISCRITTO QUESTO CASO ────────────────────────────
   *
   * **1. `INSEGNANTE_FIELDS.filter(f => f.required)` NON È PIÙ L'ELENCO GIUSTO.**
   * Da quando esiste `posizione_altro` quel filtro comprende un campo `required`
   * ma CONDIZIONALE, e il censimento — che attraversa il modulo senza spuntare
   * «Altro» — lo trovava mancante: misurato, la versione precedente di questo file
   * falliva riportando `['posizione_altro']` su un modulo che funziona. L'elenco
   * degli obbligatori si calcola perciò con `campiVisibili`, cioè con LO STESSO
   * motore che applicano il wizard e la route: un elenco di eccezioni scritto a
   * mano sarebbe la seconda regola, quella che resta indietro alla condizione
   * successiva.
   *
   * **2. `IDS_NON_RESI` DEL WIZARD È VUOTO.** Qui c'era scritto che `cv_path` era
   * l'unica esclusione dichiarata, e non lo è più dal 2026-08-15: il campo si
   * rende. Perciò il censimento non verifica più un'eccezione, verifica che
   * eccezioni non ce ne siano — TUTTI i campi del template sono resi, obbligatori
   * e facoltativi.
   */
  it('ogni campo del template è davvero reso da qualche parte nel modulo', async () => {
    // I passi si smontano l'uno dopo l'altro (react-hook-form conserva i valori,
    // non il DOM): il censimento si fa passo per passo, mentre si attraversa.
    const visti = new Set<string>()
    const censisci = (): void => {
      for (const f of INSEGNANTE_FIELDS) {
        if (document.getElementById(f.id) !== null) visti.add(f.id)
        // I tipi a gruppo (checkbox multi-valore) non hanno un `id` sul
        // contenitore: si riconoscono dalle loro opzioni.
        else if ((f.options ?? []).some((o) => screen.queryByRole('checkbox', { name: String(o.label) }) !== null)) {
          visti.add(f.id)
        }
      }
    }
    /** Gli obbligatori VISIBILI dato ciò che è stato spuntato — il motore del prodotto. */
    const obbligatoriVisibili = (valori: Record<string, unknown>): string[] =>
      campiVisibili(INSEGNANTE_FIELDS, valori).filter((f) => f.required).map((f) => f.id)

    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    censisci()
    await vaiAlProfilo()
    censisci()

    // ── Senza «Altro»: la casella libera non è fra gli obbligatori, e infatti
    // non è a schermo. Il modulo si compila per intero senza mai vederla.
    const senzaAltro = obbligatoriVisibili({ posizioni: [] })
    expect(senzaAltro.length).toBeGreaterThan(0)
    expect(senzaAltro).not.toContain('posizione_altro')
    expect(
      senzaAltro.filter((id) => !visti.has(id)),
      'un campo obbligatorio non reso è un modulo che il server rifiuta a ogni invio, ' +
        'per un campo che chi compila non può nemmeno vedere',
    ).toEqual([])
    expect(screen.queryByLabelText(/^Quale posizione/)).not.toBeInTheDocument()

    // ── Con «Altro»: la casella entra fra gli obbligatori ED è resa. È lo stesso
    // controllo, sull'altro ramo della condizione: un campo che diventa
    // obbligatorio e non compare è un modulo che non si può più inviare.
    fireEvent.click(casella('altro'))
    await screen.findByLabelText(/^Quale posizione/)
    censisci()
    const conAltro = obbligatoriVisibili({ posizioni: ['altro'] })
    expect(conAltro).toContain('posizione_altro')
    expect(conAltro.filter((id) => !visti.has(id))).toEqual([])

    // Controllo positivo: il censimento vede davvero i campi (senza, le righe qui
    // sopra sarebbero verdi su un insieme vuoto per un errore di scansione).
    expect(visti.size).toBeGreaterThanOrEqual(conAltro.length)
    // E NESSUN campo del template resta fuori: `IDS_NON_RESI` è vuoto, quindi il
    // curriculum si rende come tutti gli altri.
    expect(INSEGNANTE_FIELDS.map((f) => f.id).filter((id) => !visti.has(id))).toEqual([])
    expect(visti.has('cv_path')).toBe(true)
  })
})
