import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import itParentForms from '../../messages/it/parentForms.json'
import { statoScadenza, SOGLIA_MAX } from '@/lib/anagrafica/scadenze'
import {
  ALFA, NOME_SCANSIONE, OGGI, PERCORSO_SCANSIONE, avanti, caricaScansione,
  compilaFinoAlRiepilogo, passoDati, passoResidenza, passoSede, reteFinta,
} from '../fixtures/anagrafica-personale'

/**
 * `/anagrafica-personale` — IL DOCUMENTO D'IDENTITÀ E LA SUA SCADENZA.
 *
 * ─── I TRE DIFETTI CHE QUESTO FILE IMPEDISCE ────────────────────────────────
 *
 * **1. Il selettore data NATIVO, cioè il mese e il giorno scambiati in silenzio.**
 * `document_expiry` è `type: 'date'` nel template, e la branca `date` di
 * `FieldRenderer` rende un `<input type="date">`: quel controllo mostra il
 * formato del LOCALE DI SISTEMA, `mm/dd/yyyy` su un telefono in inglese. Su
 * questo campo un giorno e un mese scambiati non producono un errore, producono
 * una data VALIDA e sbagliata — `12/06/2027` letto all'americana è il 6 dicembre
 * invece del 12 giugno, cioè sei mesi di scarto su una scadenza. È il difetto per
 * cui `DateField` esiste, e questo file verifica che il campo sia il suo.
 *
 * **2. Il documento scaduto che BLOCCA L'INVIO.** Sarebbe la conclusione più
 * naturale — «il documento non è valido, non si può accettare» — ed è quella che
 * rende il modulo inutile proprio dove serve: chi ha il documento scaduto è
 * esattamente la persona per cui questo modulo esiste (`personale-template.ts`,
 * righe 210-212). Respingerla lascia la Segreteria senza nemmeno il suo nome.
 * Perciò l'avviso è rosso, è `role="status"` e NON `role="alert"` (non c'è niente
 * da correggere prima di proseguire), e «Avanti» passa.
 *
 * **3. L'avviso che si legge una volta sola.** Il riquadro accanto al campo si
 * legge al quarto passo; il riepilogo è l'unico punto in cui si rilegge tutto
 * insieme prima di consegnare. Se l'avviso non ricomparisse lì, chi ha un
 * documento scaduto premerebbe «Invia» senza saperlo.
 *
 * ─── E IL TEMPO NON SI LEGGE MAI DALL'OROLOGIO ──────────────────────────────
 *
 * Il wizard riceve `oggi` come parametro e i collaudi lo INIETTANO: nessuna data
 * di questo file è relativa all'istante in cui gira, e nessuna «scade fra 89
 * giorni» costruita a mano può diventare rossa da sola quando quel giorno arriva
 * — che è precisamente ciò che è successo il 12/08 a `parent-attendance-elenco`.
 * L'unico collaudo che tocca l'orologio è quello sul RIPIEGO, e lo congela.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { AnagraficaPersonaleWizard } from '@/components/features/public/AnagraficaPersonaleWizard'

const campoScadenza = () => screen.getByLabelText(/^Scadenza del documento/) as HTMLInputElement
const riquadroScaduto = () => screen.queryByText(itPublic.persDocScaduto)
const riquadroInScadenza = () => screen.queryByText(itPublic.persDocInScadenza)

/** Arriva al passo del documento con tutto il resto compilato. */
async function finoAlDocumento(rete = reteFinta()): Promise<void> {
  vi.stubGlobal('fetch', rete.fetch)
  render(<AnagraficaPersonaleWizard oggi={OGGI} />)
  await passoSede(ALFA.id)
  await passoDati()
  await passoResidenza()
  await waitFor(() => expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze · `statoScadenza` — i quattro stati e i loro confini', () => {
  // I confini si asseriscono su STRINGHE, non su un orologio: è la ragione per
  // cui `oggi` è un parametro. Sono la regola che il riquadro rende visibile.
  const CASI: { scadenza: string; atteso: string; perche: string }[] = [
    { scadenza: '2026-08-11', atteso: 'scaduto', perche: 'ieri: il documento non è più valido' },
    { scadenza: '2026-08-12', atteso: 'in-scadenza', perche: 'scade OGGI, ed è ancora valido oggi' },
    { scadenza: '2026-11-09', atteso: 'in-scadenza', perche: '89 giorni: dentro la finestra' },
    { scadenza: '2026-11-10', atteso: 'in-scadenza', perche: '90 giorni: il confine è compreso' },
    { scadenza: '2026-11-11', atteso: 'valido', perche: '91 giorni: troppo presto per dire qualcosa' },
    { scadenza: '2036-08-12', atteso: 'valido', perche: 'una carta d’identità nuova dura dieci anni' },
  ]

  for (const { scadenza, atteso, perche } of CASI) {
    it(`${scadenza} → ${atteso} (${perche})`, () => {
      expect(statoScadenza(scadenza, OGGI).stato).toBe(atteso)
    })
  }

  it('la finestra è `SOGLIA_MAX`, non un «90» ribattuto qui', () => {
    // Se un giorno il preavviso più lontano cambiasse, il riquadro e il cron
    // devono cambiare insieme: due finestre indipendenti divergono, e a divergere
    // sarebbe ciò che una persona LEGGE rispetto a ciò per cui verrà avvisata.
    expect(SOGLIA_MAX).toBe(90)
  })

  it('data assente, incompleta o inesistente → `ignoto`, e NIENTE riquadro', () => {
    // Non è un errore da segnalare qui: il campo obbligatorio ha già il suo
    // messaggio, e un secondo riquadro rosso direbbe che i problemi sono due.
    for (const brutta of ['', '   ', '2026-02-30', '2026-13-01', '12/06/2027', null, undefined]) {
      expect(statoScadenza(brutta as string, OGGI).stato).toBe('ignoto')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('AnagraficaPersonaleWizard — la scadenza NON è un selettore nativo', () => {
  it('il campo è mascherato gg/mm/aaaa, non un `<input type="date">`', async () => {
    await finoAlDocumento()

    const campo = campoScadenza()
    // `type="date"` è il difetto: il browser mostrerebbe il formato del sistema.
    expect(campo).not.toHaveAttribute('type', 'date')
    expect(campo.type).toBe('text')
    expect(campo).toHaveAttribute('inputMode', 'numeric')
    // Il formato vive FUORI dal segnaposto — che sparisce al primo carattere —
    // ed è agganciato al campo come descrizione.
    const descritto = (campo.getAttribute('aria-describedby') ?? '').split(' ')
    const aiuto = descritto.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    expect(aiuto).toContain(itPublic.persDocScadenzaAiuto)
  })

  it('si digita all’italiana e resta all’italiana', async () => {
    await finoAlDocumento()
    fireEvent.change(campoScadenza(), { target: { value: '12/06/2027' } })
    // 12 giugno, non 6 dicembre: la maschera è deterministica e non consulta il
    // locale di sistema.
    expect(campoScadenza().value).toBe('12/06/2027')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('AnagraficaPersonaleWizard — il riquadro della scadenza', () => {
  it('SCADUTO: riquadro rosso, `role="status"` e non `alert`', async () => {
    await finoAlDocumento()
    fireEvent.change(campoScadenza(), { target: { value: '01/01/2020' } })

    await waitFor(() => expect(riquadroScaduto()).toBeInTheDocument())
    const riquadro = riquadroScaduto()?.closest('[role]') as HTMLElement
    // `alert` significa «correggi prima di proseguire», e qui non c'è niente da
    // correggere: il documento scaduto si consegna lo stesso.
    expect(riquadro).toHaveAttribute('role', 'status')
    expect(riquadro.className).toContain('bg-kidville-error-soft')
    expect(riquadroInScadenza()).not.toBeInTheDocument()
  })

  it('ENTRO 90 GIORNI: riquadro d’avviso, non d’errore', async () => {
    await finoAlDocumento()
    // 60 giorni esatti da `OGGI`, calcolati sul calendario e scritti qui: la data
    // è FISSA e non si sposta col passare del tempo, perché `oggi` è iniettato.
    fireEvent.change(campoScadenza(), { target: { value: '11/10/2026' } })

    await waitFor(() => expect(riquadroInScadenza()).toBeInTheDocument())
    const riquadro = riquadroInScadenza()?.closest('[role]') as HTMLElement
    expect(riquadro).toHaveAttribute('role', 'status')
    expect(riquadro.className).toContain('bg-kidville-warn-soft')
    expect(riquadroScaduto()).not.toBeInTheDocument()
  })

  it('OLTRE LA FINESTRA: NIENTE — un pannello che segnala tutto non segnala niente', async () => {
    await finoAlDocumento()
    fireEvent.change(campoScadenza(), { target: { value: '01/01/2030' } })

    await waitFor(() => expect(campoScadenza().value).toBe('01/01/2030'))
    expect(riquadroScaduto()).not.toBeInTheDocument()
    expect(riquadroInScadenza()).not.toBeInTheDocument()
  })

  it('il campo punta al riquadro SOLO quando c’è: un `aria-describedby` nel vuoto è un riferimento rotto', async () => {
    await finoAlDocumento()

    const descrittori = () => (campoScadenza().getAttribute('aria-describedby') ?? '').split(' ')
    const puntanoAQualcosa = () =>
      descrittori().every((id) => id === '' || document.getElementById(id) !== null)

    // Campo vuoto: nessun riquadro, e nessun riferimento che punti al nulla.
    expect(puntanoAQualcosa()).toBe(true)
    expect(descrittori()).not.toContain('pers-documento-avviso-scadenza')

    fireEvent.change(campoScadenza(), { target: { value: '01/01/2020' } })
    await waitFor(() => expect(riquadroScaduto()).toBeInTheDocument())
    expect(descrittori()).toContain('pers-documento-avviso-scadenza')
    expect(puntanoAQualcosa()).toBe(true)

    // Data lontana: il riquadro sparisce, e il riferimento con lui.
    fireEvent.change(campoScadenza(), { target: { value: '01/01/2030' } })
    await waitFor(() => expect(riquadroScaduto()).not.toBeInTheDocument())
    expect(descrittori()).not.toContain('pers-documento-avviso-scadenza')
    expect(puntanoAQualcosa()).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('AnagraficaPersonaleWizard — «tieni il documento a portata di mano»', () => {
  it('sta in testa dal primo passo e sparisce QUANDO il documento serve davvero', async () => {
    // È la riga che evita l'abbandono: chi scopre al quarto passo di doversi
    // alzare a cercare la carta d'identità chiude la scheda, e qui non c'è
    // nessuna bozza da riprendere. Al passo del documento diventa rumore.
    vi.stubGlobal('fetch', reteFinta().fetch)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)

    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))
    expect(screen.getByText(itPublic.persDocumentoAPortata)).toBeInTheDocument()

    await passoSede(ALFA.id)
    await passoDati()
    await waitFor(() => expect(screen.getByLabelText(/^Indirizzo di residenza/)).toBeInTheDocument())
    expect(screen.getByText(itPublic.persDocumentoAPortata)).toBeInTheDocument()

    await passoResidenza()
    await waitFor(() => expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument())
    expect(screen.queryByText(itPublic.persDocumentoAPortata)).not.toBeInTheDocument()
  })

  it('⚠️ e porta un TETTO di larghezza: senza, a 1024 px sono 122 caratteri su una riga', async () => {
    // MISURATO il 12/08/2026 sulla pagina viva (WebKit) con un `Range` carattere
    // per carattere: senza tetto le righe erano 44·44·34 a 360 px, 94/28 a 640,
    // 102/20 a 768 e **122 su UNA riga** a 1024, 1280 e 1440, col paragrafo largo
    // 678 px a 12 px di corpo. A quella lunghezza l'occhio perde il capo della
    // riga successiva, e questa è proprio la riga che deve essere letta.
    // Il numero del tetto è misurato DOPO, non sperato — la lezione di
    // `max-w-[60ch]`, che prometteva 60 caratteri e ne rendeva 87: provati sulla
    // stessa pagina 384 px → 70 · 400 → 70 · **416 → 75** · 432 → 78.
    vi.stubGlobal('fetch', reteFinta().fetch)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)
    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))

    const riga = screen.getByText(itPublic.persDocumentoAPortata)
    // 26rem = 416 px = 75 caratteri per riga, MISURATI. In `rem` e non in `ch`:
    // `ch` è la larghezza dello ZERO, che in Maven Pro è più largo della
    // minuscola media, e un vincolo in `ch` dichiara un numero e ne produce un
    // altro.
    expect(riga.className).toContain('max-w-[26rem]')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('AnagraficaPersonaleWizard — la scansione SI PUÒ RAGGIUNGERE', () => {
  /**
   * ⚠️ IL DIFETTO CHE QUESTO BLOCCO IMPEDISCE, ed era un muro.
   *
   * `FileField` rendeva `<input type="file" className="hidden">` — cioè
   * `display:none` — dentro una `<label>` senza `tabIndex`, senza `role` e senza
   * gestore di tastiera, e nessun altro comando apriva il selettore di file. Un
   * elemento a `display:none` non è focalizzabile, non entra nell'ordine di
   * tabulazione e NON ESISTE nell'albero di accessibilità.
   *
   * MISURATO il 12/08/2026 con pressioni di tasto vere (riquadro 360×740, passo
   * «Documento d'identità»): il giro del Tab faceva `#document_number` →
   * `#pers-documento-scadenza` → «INDIETRO» → «TORNA AL RIEPILOGO» → fine del
   * documento. **Zero fermate sul caricamento**, che è l'unico campo senza il
   * quale «Avanti» non passa. Chi compila con la sola tastiera — o con uno
   * screen reader, per cui quel campo semplicemente non c'era — riempiva tre
   * caselle, premeva «Avanti», leggeva «Campo obbligatorio» sotto una cosa
   * irraggiungibile e non aveva nessuna via d'uscita: non è un fastidio, è
   * l'impossibilità di consegnare la propria anagrafica.
   *
   * `jest-axe` dava 0 violazioni su quel passo, e continuerebbe a darne 0: non
   * esiste una regola per «una label che sembra un bottone e non lo è». Il
   * presidio è qui.
   */
  it('⚠️ il campo del file è un CONTROLLO vero: ha un `id`, un nome e sta nell’ordine di tabulazione', async () => {
    await finoAlDocumento()

    // Si trova per ETICHETTA, cioè per la strada che percorre uno screen reader:
    // se fosse fuori dall'albero di accessibilità, questa riga non troverebbe
    // niente.
    const input = screen.getByLabelText(/^Scansione o foto del documento/) as HTMLInputElement
    expect(input.type).toBe('file')
    expect(input.id).toBe('documento_path')
    // `sr-only` (fuori dalla vista, dentro l'albero e dentro il Tab) e MAI
    // `hidden`, che è `display:none` — cioè il difetto.
    expect(input.className).toContain('sr-only')
    expect(input.className).not.toContain('hidden')
    // Nessuno l'ha tolto dal giro del Tab per un'altra strada.
    expect(input).not.toHaveAttribute('tabindex')
    input.focus()
    expect(document.activeElement).toBe(input)
  })

  it('⚠️ «Avanti» con la SOLA scansione mancante porta il fuoco LÌ, non lo lascia dov’era', async () => {
    // MISURATO prima della correzione: dopo «Avanti» il fuoco restava su
    // `input#document_number` — un campo VALIDO — con `scrollY` 0. Il messaggio
    // «Campo obbligatorio» compariva sotto un controllo che il fuoco non poteva
    // raggiungere: `setFocus('documento_path')` era un no-op, perché il
    // `Controller` non passava nessun `ref` e il browser non può focalizzare un
    // elemento a `display:none`.
    await finoAlDocumento()
    fireEvent.change(screen.getByLabelText(/^Tipo di documento/), { target: { value: 'CI' } })
    fireEvent.change(screen.getByLabelText(/^Numero del documento/), { target: { value: 'AB1234567' } })
    fireEvent.change(campoScadenza(), { target: { value: '01/01/2030' } })

    avanti()

    const input = screen.getByLabelText(/^Scansione o foto del documento/)
    await waitFor(() => expect(document.activeElement).toBe(input))
    // E si resta al passo del documento: il campo mancante è qui.
    expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument()
  })

  it('⚠️ il caricamento FALLITO lo dice forte e lo ANNUNCIA', async () => {
    // Era l'unico testo della pagina sotto la soglia di contrasto — `error`
    // (#E53935) a peso 400 sul crema = **3,81:1** contro i 4,5:1 richiesti — e
    // l'unico messaggio d'errore del modulo senza `font-bold` e senza ruolo,
    // mentre due centimetri più sotto, sullo STESSO campo, quello di
    // `FieldRenderer` porta `error-strong` e `font-bold`. In Alto Contrasto il
    // colore sparisce del tutto (nero, come un'etichetta qualunque): il peso è
    // il SECONDO segnale, quello che sopravvive. E senza `role="alert"` chi usa
    // uno screen reader non sa nemmeno che il caricamento non è riuscito.
    const rete = reteFinta()
    const originale = rete.fetch
    const conGuasto = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/iscrizione/personale/upload')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: { get: () => 'application/json' },
          json: async () => ({}),
        })
      }
      return originale(input, init)
    })
    vi.stubGlobal('fetch', conGuasto)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)
    await passoSede(ALFA.id)
    await passoDati()
    await passoResidenza()
    await waitFor(() => expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText(/^Scansione o foto del documento/), {
      target: { files: [new File(['%PD'], 'documento.pdf', { type: 'application/pdf' })] },
    })

    const messaggio = await screen.findByText(itParentForms.caricamentoNonRiuscito)
    expect(messaggio).toHaveAttribute('role', 'alert')
    expect(messaggio.className).toContain('font-bold')
    expect(messaggio.className).toContain('text-kidville-error-strong')
    expect(messaggio.className).not.toMatch(/text-kidville-error(?![-\w])/)
  })

  it('⚠️ mentre carica il campo NON si disabilita: il fuoco resta dov’è', async () => {
    // Stessa famiglia del difetto chiuso sul comando primario: disabilitare un
    // elemento che ha il fuoco lo fa cadere su `<body>`. Qui colpirebbe proprio
    // chi ha appena scelto il file da tastiera — l'unico percorso che la
    // correzione del 12/08/2026 esiste per rendere possibile — e il fuoco
    // finirebbe all'inizio del documento mentre il caricamento è in volo.
    const rete = reteFinta()
    let sblocca: () => void = () => {}
    const inVolo = new Promise<void>((r) => {
      sblocca = r
    })
    const lenta = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/iscrizione/personale/upload')) {
        return inVolo.then(() => ({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ path: PERCORSO_SCANSIONE }),
        }))
      }
      return rete.fetch(input, init)
    })
    vi.stubGlobal('fetch', lenta)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)
    await passoSede(ALFA.id)
    await passoDati()
    await passoResidenza()
    await waitFor(() => expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument())

    const input = screen.getByLabelText(/^Scansione o foto del documento/) as HTMLInputElement
    input.focus()
    fireEvent.change(input, {
      target: { files: [new File(['%PD'], NOME_SCANSIONE, { type: 'application/pdf' })] },
    })

    await waitFor(() => expect(input).toHaveAttribute('aria-busy', 'true'))
    expect(input).not.toBeDisabled()
    expect(document.activeElement).toBe(input)

    sblocca()
    await waitFor(() => expect(screen.getByText(NOME_SCANSIONE)).toBeInTheDocument())
    expect(input).not.toHaveAttribute('aria-busy')
  })

  it('la riga che spiega cosa caricare porta il suo TETTO di larghezza', async () => {
    // MISURATA senza tetto: **92 caratteri per riga, costanti da 640 a 1440 px**.
    // 26rem = 416 px = 75 caratteri, la stessa misura del banner del documento.
    await finoAlDocumento()
    expect(screen.getByText(itPublic.persDocAllegatoNota).className).toContain('max-w-[26rem]')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('AnagraficaPersonaleWizard — la scansione: si dice che c’è, mai DOVE sta', () => {
  it('⚠️ dopo il caricamento in pagina c’è il NOME del file, non il percorso nel bucket', async () => {
    await finoAlDocumento()
    await caricaScansione()

    // Il nome del file è ciò che conferma davvero: dice se la foto è quella
    // giusta. Il percorso è `documenti/<uuid>/<uuid>.pdf` — 87 caratteri in
    // monospazio da 11 px, troncati a 48 in una scatola da 315 px a 360 px di
    // schermo: a chi compila non dice niente, e a schermo si fotografa, si legge
    // ad alta voce e finisce nelle segnalazioni di guasto. Lo stesso repo lo
    // redige nei log e si rifiuta di stamparlo nel riepilogo: stamparlo qui era
    // la terza risposta diversa alla stessa domanda.
    expect(screen.getByText(NOME_SCANSIONE)).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toContain(PERCORSO_SCANSIONE)
    expect(document.querySelector('.font-mono')).toBeNull()
  })

  it('…e il percorso arriva comunque al server: è nascosto agli occhi, non buttato', async () => {
    const rete = reteFinta()
    await finoAlDocumento(rete)

    fireEvent.change(screen.getByLabelText(/^Tipo di documento/), { target: { value: 'CI' } })
    fireEvent.change(screen.getByLabelText(/^Numero del documento/), { target: { value: 'AB1234567' } })
    fireEvent.change(campoScadenza(), { target: { value: '01/01/2030' } })
    await caricaScansione()

    avanti()
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

    const corpo = rete.inviati[0] as { data: Record<string, unknown> }
    expect(corpo.data.documento_path).toBe(PERCORSO_SCANSIONE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('AnagraficaPersonaleWizard — il documento scaduto NON blocca niente', () => {
  it('con la data passata si prosegue, si arriva al riepilogo e si invia', async () => {
    const rete = reteFinta()
    await finoAlDocumento(rete)

    fireEvent.change(screen.getByLabelText(/^Tipo di documento/), { target: { value: 'CI' } })
    fireEvent.change(screen.getByLabelText(/^Numero del documento/), { target: { value: 'AB1234567' } })
    fireEvent.change(campoScadenza(), { target: { value: '01/01/2020' } })
    await caricaScansione()

    avanti() // documento → consensi
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    for (const nome of [/informativa sulla privacy/i, /dati sono veri/i, /copia del documento/i]) {
      fireEvent.click(screen.getByRole('checkbox', { name: nome }))
    }
    avanti() // consensi → riepilogo

    await waitFor(() => expect(screen.getByText(itPublic.persRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.persInvia }))

    await waitFor(() => expect(screen.getByText(itPublic.persInviata)).toBeInTheDocument())
    // E la data scaduta è arrivata al server, in ISO: è il dato che il cron
    // interrogherà per chiedere il documento rinnovato.
    const corpo = rete.inviati[0] as { data: Record<string, unknown> }
    expect(corpo.data.document_expiry).toBe('2020-01-01')
  })

  it('⚠️ e il riepilogo RIPETE l’avviso, sopra il bottone d’invio', async () => {
    // È l'unico punto in cui si rilegge tutto prima di consegnare: chi arriva qui
    // con un documento scaduto deve saperlo NEL momento in cui preme «Invia».
    vi.stubGlobal('fetch', reteFinta().fetch)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)
    await compilaFinoAlRiepilogo({ scadenza: '01/01/2020' })

    const avviso = riquadroScaduto()
    expect(avviso).toBeInTheDocument()
    // Sopra il bottone, non sotto: il documento HTML è anche l'ordine in cui uno
    // screen reader legge, e un avvertimento dopo il comando arriva tardi.
    const bottone = screen.getByRole('button', { name: itPublic.persInvia })
    const dove = (avviso as HTMLElement).compareDocumentPosition(bottone)
    expect(dove & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('con un documento valido il riepilogo NON mostra nessun avviso', async () => {
    vi.stubGlobal('fetch', reteFinta().fetch)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)
    await compilaFinoAlRiepilogo({ scadenza: '01/01/2030' })

    expect(riquadroScaduto()).not.toBeInTheDocument()
    expect(riquadroInScadenza()).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('AnagraficaPersonaleWizard — il ripiego di «oggi»', () => {
  it('senza il parametro si usa il giorno civile ITALIANO, non quello UTC', async () => {
    // L'unico collaudo che tocca l'orologio, e lo CONGELA. L'istante scelto è
    // l'una di notte italiana del 13 agosto: in UTC è ancora il 12. Con un
    // documento che scade il 12/08/2026 la risposta cambia — «scaduto ieri» in
    // Europe/Rome, «scade oggi» a Greenwich — e il prodotto vive in Italia.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-12T23:30:00Z')) // = 13/08 01:30 a Roma

    vi.stubGlobal('fetch', reteFinta().fetch)
    render(<AnagraficaPersonaleWizard />)
    await passoSede(ALFA.id)
    await passoDati()
    await passoResidenza()
    await waitFor(() => expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument())

    fireEvent.change(campoScadenza(), { target: { value: '12/08/2026' } })
    await waitFor(() => expect(riquadroScaduto()).toBeInTheDocument())
    expect(riquadroInScadenza()).not.toBeInTheDocument()
  })
})
