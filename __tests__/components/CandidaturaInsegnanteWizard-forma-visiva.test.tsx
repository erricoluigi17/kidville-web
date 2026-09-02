import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { useForm, type FieldValues } from 'react-hook-form'
import itPublic from '../../messages/it/public.json'
import { POSIZIONI_OPTIONS } from '@/lib/forms/insegnanti-template'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import type { FormField } from '@/types/database.types'

/**
 * `/lavora-con-noi` — LA FORMA, e le quattro cose che si misuravano nel browser
 * e non erano scritte da nessuna parte.
 *
 * ─── PERCHÉ QUESTO FILE ─────────────────────────────────────────────────────
 *
 * Il collaudo visivo dell'11/08/2026 ha rilevato che il modulo pone la STESSA
 * domanda («scegli una fra queste») con DUE grafiche diverse: le card della sede
 * (passo 1, scritte a mano nel wizard) e quelle delle fasce d'età e dei consensi
 * (passi 3 e 4, disegnate da `FieldRenderer`). Misure sulla pagina viva:
 *
 *   · contorno a riposo `rgb(239,231,220)` sulle sedi — 1,10:1 sul crema, cioè
 *     un contorno che non c'è — contro `rgb(138,149,143)` (2,79:1) sulle fasce;
 *   · testo `rgb(31,61,56)` sulle sedi contro `rgb(0,106,95)` sulle fasce;
 *   · il messaggio d'errore del gruppo SOPRA le sedi (y 267 con le card a 291) e
 *     SOTTO le fasce (y 535 con il gruppo che finisce a 518).
 *
 * Nessuna di queste tre cose poteva rompersi: erano due stringhe di classi in
 * due file, e nessun test le guardava. Qui si guardano — RENDENDO ENTRAMBE le
 * famiglie e confrontando ciò che esce, invece di ricopiare in un `expect` le
 * classi che si sperano.
 *
 * ⚠️ SU COSA SI PUÒ ASSERIRE IN jsdom. Non c'è né foglio di stile né layout:
 * `getComputedStyle` restituisce valori vuoti e ogni rettangolo è 0×0. Quindi
 * qui si asserisce sulle CLASSI e sull'ORDINE del DOM — che è esattamente ciò
 * che decide il colore (la classe) e l'impaginazione su telefono (l'ordine, dove
 * la griglia non c'è). Le misure in pixel e in rapporto di contrasto restano
 * quelle prese nel browser, e stanno scritte nei commenti del componente.
 */

/**
 * La legenda «* campo obbligatorio» come SI LEGGE. Oggi coincide col valore di
 * catalogo — il glifo è isolato in uno `<span>` per riceverne la tinta, ma il
 * testo non cambia — e resta una costante derivata perché è il `textContent`
 * dell'intero `<p>` che i due test qui sotto confrontano, non una sua metà.
 */
const LEGENDA_RESA = itPublic.wizardCampiObbligatori

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

/**
 * Il mock di `next-intl` di `test/setup.ts` ignora i VALORI: `t('chiave', {…})`
 * torna la stringa grezza, segnaposti compresi. Qui serve il contrario — la riga
 * «Candidatura per la sede …» esiste per NOMINARE il plesso, e un test che non
 * vede il nome non sta verificando la cosa per cui la riga è stata scritta.
 * Questo mock risolve sullo stesso catalogo italiano e in più sostituisce i
 * `{segnaposto}`, cioè si comporta come il formattatore vero sul caso semplice.
 */
vi.mock('next-intl', async () => {
  const cataloghi: Record<string, Record<string, string>> = {
    public: (await import('../../messages/it/public.json')).default,
    parentForms: (await import('../../messages/it/parentForms.json')).default,
    shared: (await import('../../messages/it/shared.json')).default,
    common: (await import('../../messages/it/common.json')).default,
  }
  const risolvi = (ns: string | undefined, chiave: string, valori?: Record<string, unknown>): string => {
    const gruppo = ns ? cataloghi[ns] : undefined
    const grezza = (gruppo && gruppo[chiave]) ?? (ns ? `${ns}.${chiave}` : chiave)
    if (!valori) return grezza
    return grezza.replace(/\{(\w+)\}/g, (intero, nome: string) =>
      nome in valori ? String(valori[nome]) : intero,
    )
  }
  const useTranslations = (ns?: string) => {
    const t = (chiave: string, valori?: Record<string, unknown>) => risolvi(ns, chiave, valori)
    return Object.assign(t, {
      rich: (chiave: string) => risolvi(ns, chiave),
      markup: (chiave: string) => risolvi(ns, chiave),
      raw: (chiave: string) => risolvi(ns, chiave),
      has: () => true,
    })
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import { allegaCurriculumDiProva } from '../helpers/allega-curriculum'

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const BETA = { id: SEDE_B, nome: NOME_SEDE_B }

const fetchMock = vi.fn()

/** Elenco sedi servito (o negato) come lo serve la rotta pubblica. */
function mockSedi(esito: { ok: true; sedi: { id: string; nome: string }[] } | { ok: false }): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/iscrizione/sedi')) {
      if (!esito.ok) return Promise.resolve({ ok: false, status: 429, json: async () => ({ error: 'no' }) })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: esito.sedi }) })
    }
    // ⚠️ IL CARICAMENTO DEL CURRICULUM, dal 2026-08-24: il campo è obbligatorio,
    // quindi `compilaFinoAlRiepilogo` ci passa. Senza questo ramo il ripiego qui
    // sotto risponde `{}`, il `path` è `undefined` e il campo non si riempie mai:
    // il passo «profilo» non avanza e il test cade in TIMEOUT sui consensi.
    if (url.includes('/api/iscrizione/insegnanti/upload')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ path: PERCORSO_CV }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

/** Il percorso che la rotta di caricamento restituisce, e il nome del file scelto. */
const PERCORSO_CV = 'candidature/11111111-2222-4333-8444-555555555555-cv.pdf'
const NOME_FILE_CV = 'cv-collaudo.pdf'

/**
 * I token di COLORE di una card di scelta: contorno e riempimento allo stato in
 * cui la card si trova adesso. Le varianti (`hover:`, `focus-within:`) restano
 * fuori — descrivono altri stati, e non è di quelli che parla il rilievo.
 */
function pelle(elemento: Element): string[] {
  const classi = elemento.getAttribute('class') ?? ''
  return classi
    .split(/\s+/)
    .filter((c) => /^(border|bg)-kidville-/.test(c))
    .sort()
}

/** Il peso del testo di una card: `font-semibold` oppure niente. */
function pesoTesto(label: Element): string {
  const span = label.querySelector('span')
  const classi = span?.getAttribute('class') ?? ''
  return classi.split(/\s+/).find((c) => c.startsWith('font-')) ?? '(nessuno)'
}

/**
 * Gli stessi token, ma col PESO del contorno dentro: `border-[1.5px]` non
 * comincia per `border-kidville-` e `pelle()` lo lascerebbe fuori — proprio il
 * pezzo che distingue una card in errore da una a riposo. Le varianti (`hover:`,
 * `focus-within:`) restano fuori come sopra: descrivono altri stati.
 */
function pelleColPeso(elemento: Element): string[] {
  const classi = elemento.getAttribute('class') ?? ''
  return classi
    .split(/\s+/)
    .filter((c) => /^(border|bg)/.test(c) && !c.includes(':'))
    .sort()
}

/** Un `FieldRenderer` di tipo `radio` da solo: la famiglia di card da imitare. */
function CardDiFieldRenderer({ campo, errore }: { campo: FormField; errore?: boolean }) {
  const {
    register,
    control,
    formState: { errors },
  } = useForm<FieldValues>()
  return (
    <FieldRenderer
      field={campo}
      modelId="m"
      register={register}
      control={control}
      /* L'errore si passa già fatto invece di farlo nascere da una validazione:
         quello che si sta misurando è come si DIPINGE un gruppo non valido, non
         come ci si arriva. */
      error={errore ? { type: 'required', message: 'Campo obbligatorio' } : errors[campo.id]}
    />
  )
}

const CAMPO_RADIO: FormField = {
  id: 'fascia',
  type: 'radio',
  label: 'Fascia',
  required: true,
  options: [
    { value: 'a', label: 'Nido (0-3)' },
    { value: 'b', label: 'Infanzia (3-6)' },
  ],
}

/**
 * L'etichetta della posizione con quel `value`, LETTA dal template.
 *
 * Dal 2026-08-15 il passo «profilo» non chiede più le fasce d'età: chiede le
 * POSIZIONI, e la casella che questo file spunta per arrivare al riepilogo non si
 * chiama più «Infanzia (3-6)» ma «Insegnante — Infanzia (3-6)». ⚠️ Quel trattino
 * è un EM DASH (U+2014). `CAMPO_RADIO` qui sopra resta con le sue etichette
 * corte: è un campo INVENTATO per avere una card di `FieldRenderer` da
 * confrontare, e non ha niente a che vedere con il template.
 */
function posizione(valore: string): string {
  const o = POSIZIONI_OPTIONS.find((x) => x.value === valore)
  if (!o) throw new Error(`posizione «${valore}» assente da POSIZIONI_OPTIONS`)
  return String(o.label)
}

/** La posizione che si spunta per attraversare il passo «profilo». */
const POSIZIONE_SCELTA = posizione('insegnante_infanzia')

/**
 * Dalla scelta della sede fino al riepilogo, compilando il minimo che i passi
 * pretendono. Il wizard dev'essere già reso e l'elenco già arrivato.
 */
async function compilaFinoAlRiepilogo(): Promise<void> {
  fireEvent.click(await screen.findByRole('checkbox', { name: NOME_SEDE_A }))
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
    target: { value: 'aspirante@example.test' },
  })
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'laurea_triennale' } })
  fireEvent.click(screen.getByRole('checkbox', { name: POSIZIONE_SCELTA }))
  // Il curriculum è obbligatorio dal 2026-08-24: senza, il passo non avanza.
  // L'attesa non è facoltativa — il caricamento è asincrono, e la sonda vive in
  // `__tests__/helpers/allega-curriculum` (era la SETTIMA copia della stessa
  // sequenza: sono cadute tutte insieme il giorno in cui il riquadro ha cambiato
  // il modo di impaginare il nome).
  await allegaCurriculumDiProva(NOME_FILE_CV)
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
  fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

  await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => cleanup())

describe('CandidaturaInsegnanteWizard — un solo linguaggio per le card di scelta', () => {
  it('la card della SEDE e quella di FieldRenderer hanno gli stessi token, libere e prese', async () => {
    // 1 · La famiglia di riferimento: le card che disegna `FieldRenderer`.
    const { unmount } = render(<CardDiFieldRenderer campo={CAMPO_RADIO} />)
    const radioRif = screen.getAllByRole('radio')
    const rifLibera = pelle(radioRif[0].closest('label') as Element)
    const rifPesoLibera = pesoTesto(radioRif[0].closest('label') as Element)
    fireEvent.click(radioRif[0])
    await waitFor(() => expect(radioRif[0]).toBeChecked())
    const rifPresa = pelle(radioRif[0].closest('label') as Element)
    const rifPesoPresa = pesoTesto(radioRif[0].closest('label') as Element)
    unmount()

    // 2 · Le card della sede, dentro il wizard vero.
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    const primaSede = await screen.findByRole('checkbox', { name: NOME_SEDE_A })
    const sedeLibera = pelle(primaSede.closest('label') as Element)
    const sedePesoLibera = pesoTesto(primaSede.closest('label') as Element)
    fireEvent.click(primaSede)
    await waitFor(() => expect(primaSede).toBeChecked())
    const sedePresa = pelle(primaSede.closest('label') as Element)
    const sedePesoPresa = pesoTesto(primaSede.closest('label') as Element)

    // 3 · Il confronto. Il controllo positivo viene prima: se i due stati di
    //     riferimento fossero uguali fra loro, l'uguaglianza qui sotto sarebbe
    //     verde senza dire niente.
    expect(rifLibera).not.toEqual(rifPresa)
    expect(rifLibera).toEqual(['bg-kidville-white', 'border-kidville-neutral'])
    expect(rifPresa).toEqual(['bg-kidville-green-soft', 'border-kidville-green'])

    expect(sedeLibera).toEqual(rifLibera)
    expect(sedePresa).toEqual(rifPresa)
    expect(sedePesoLibera).toEqual(rifPesoLibera)
    expect(sedePesoPresa).toEqual(rifPesoPresa)
    expect(sedePesoPresa).toBe('font-semibold')
  })

  /*
   * IL GRUPPO IN ERRORE LO DICE ANCHE SULLE CARD, e non solo con la frase sotto.
   *
   * MISURATO l'11/08/2026 sulla pagina viva: premuto «Avanti» senza scegliere,
   * le tre card della sede restavano `border-top-color: rgb(138,149,143)` a 1 px
   * — esattamente lo stato di riposo — mentre un `input` obbligatorio vuoto,
   * qualche passo più avanti, mostrava `rgb(229,57,53)` a 1,5 px. Il messaggio
   * c'era, il contorno no: chi scorre la schermata con l'occhio vede una domanda
   * che sembra a posto e un rimprovero che sembra riferito a qualcos'altro.
   *
   * Il confronto è di nuovo fatto RENDENDO le due famiglie, non ricopiando le
   * classi che si sperano: se `FieldRenderer` cambia il rosso o il peso del
   * contorno, questo test lo dice invece di lasciar divergere le due grafiche.
   */
  it('la sede in errore prende gli stessi token di un gruppo non valido di FieldRenderer', async () => {
    // 1 · La famiglia di riferimento, in errore.
    const { unmount } = render(<CardDiFieldRenderer campo={CAMPO_RADIO} errore />)
    const rifNonValida = pelleColPeso(screen.getAllByRole('radio')[0].closest('label') as Element)
    unmount()

    // 2 · Le card della sede dopo un «Avanti» senza scelta.
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    const prima = await screen.findByRole('checkbox', { name: NOME_SEDE_A })
    const aRiposo = pelleColPeso(prima.closest('label') as Element)

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await screen.findByText(itPublic.candSedeErrore)

    const inErrore = prima.closest('label') as HTMLElement
    // 3 · Il controllo positivo prima di tutto: se riposo ed errore fossero la
    //     stessa cosa, l'uguaglianza qui sotto sarebbe verde senza dire niente.
    //     È letteralmente il difetto che si sta chiudendo.
    expect(pelleColPeso(inErrore)).not.toEqual(aRiposo)
    expect(rifNonValida).toEqual(['bg-kidville-white', 'border-[1.5px]', 'border-kidville-error'])
    expect(pelleColPeso(inErrore)).toEqual(rifNonValida)
    // In Alto Contrasto il rosso non esiste (`[class*="border-kidville-"]` porta
    // ogni contorno al nero): il secondo segnale è il bordo doppio, e si aggancia
    // a questo attributo. Senza, la card in errore torna indistinguibile.
    expect(inErrore.getAttribute('data-scelta-invalida')).toBe('true')

    // E la card SCELTA resta verde: l'errore riguarda il gruppo vuoto.
    fireEvent.click(prima)
    await waitFor(() => expect(prima).toBeChecked())
    expect(pelleColPeso(prima.closest('label') as Element)).toEqual([
      'bg-kidville-green-soft',
      'border',
      'border-kidville-green',
    ])
  })

  it('l’errore del gruppo sede sta SOTTO le card, e il gruppo lo dichiara con aria-describedby', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await screen.findByRole('checkbox', { name: NOME_SEDE_A })

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    const errore = await screen.findByText(itPublic.candSedeErrore)
    const gruppo = container.querySelector('fieldset') as HTMLFieldSetElement
    const ultimaCard = screen.getByRole('checkbox', { name: NOME_SEDE_B }).closest('label') as Element

    // `DOCUMENT_POSITION_FOLLOWING` = l'errore viene DOPO l'ultima card.
    expect(ultimaCard.compareDocumentPosition(errore) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(gruppo.getAttribute('aria-describedby')).toBe(errore.id)
    expect(errore.id).not.toBe('')
    // Lo stesso secondo segnale del messaggio di `FieldRenderer`: il peso, che
    // sopravvive all'Alto Contrasto dove ogni inchiostro converge sul nero.
    expect(errore.getAttribute('class')).toContain('font-bold')
  })

  it('i pallini dei passi ANCORA DA FARE hanno un anello, non solo un riempimento', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await screen.findByRole('checkbox', { name: NOME_SEDE_A })

    const pallini = [...container.querySelectorAll('span[aria-hidden="true"] > span')].filter((s) =>
      (s.getAttribute('class') ?? '').includes('rounded-pill'),
    )
    expect(pallini).toHaveLength(5)
    const daFare = pallini.slice(1)
    // In Alto Contrasto `bg-kidville-cream-dark` diventa bianco su bianco
    // (1,00:1, misurato): il riempimento non può essere l'unico segno.
    for (const p of daFare) {
      const classi = p.getAttribute('class') ?? ''
      expect(classi).toContain('bg-kidville-cream-dark')
      expect(classi).toContain('ring-1')
      expect(classi).toContain('ring-kidville-green')
    }
  })
})

describe('CandidaturaInsegnanteWizard — dove stanno le cose', () => {
  /*
   * L'ORDINE È CAMBIATO L'11/08/2026, E LA MISURA CHE LO HA DECISO STA QUI.
   *
   * Questo stesso test, scritto poche ore prima, pretendeva l'OPPOSTO: che il
   * riquadro «Dopo l'invio» precedesse i comandi, perché contiene la frase
   * «controlla che l'email sia giusta prima di inviare» e un avvertimento non
   * può stare dopo il gesto che deve precedere.
   *
   * La misura successiva, a 360×740 sulla pagina viva, ha mostrato il prezzo di
   * quell'ordine: il riquadro è alto 262 px e stava fra i campi e i bottoni a
   * OGNI passo. Al primo — tre card di sede, cioè un tocco solo — docH 827,
   * riquadro da y 457 a y 719, «Avanti» a y 759: 19 px sotto la piega di una
   * finestra da 740, e molto di più su un telefono vero, dove la barra del
   * browser ne mangia 60-120. La prima schermata finiva con 262 px di
   * spiegazioni e nessun bottone.
   *
   * Le due esigenze non erano in conflitto: riguardavano cose diverse. La frase
   * sull'email è UNA riga e serve a UN passo, e adesso vive lì
   * (`candRiepilogoControllaEmail`, dentro il riepilogo, sopra i comandi). Il
   * resto del riquadro racconta cosa succede DOPO l'invio, e sta dopo i comandi.
   * I due test qui sotto tengono insieme le due metà: se un domani si riportasse
   * su il riquadro, o si togliesse la riga dal riepilogo, uno dei due si rompe.
   */
  it('la colonna «Dopo l’invio» viene DOPO i comandi sotto lg, ed è sticky da lg in su', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    await screen.findByRole('checkbox', { name: NOME_SEDE_A })

    const contesto = screen.getByText(itPublic.candContestoTitolo).parentElement as HTMLElement
    const avanti = screen.getByRole('button', { name: itPublic.candAvanti })

    // Sotto `lg` non c'è griglia: conta l'ordine del DOCUMENTO, che è anche
    // l'ordine in cui uno screen reader legge e il Tab si sposta. Lo spostamento
    // è quindi nel DOM e non con `order`: «Avanti» viene PRIMA del riquadro.
    expect(avanti.compareDocumentPosition(contesto) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Da `lg` in su la collocazione nella griglia è esplicita e non dipende
    // dall'ordine di scrittura: il riquadro torna nella seconda colonna, in
    // prima riga, accanto al modulo.
    expect(contesto.getAttribute('class')).toContain('lg:col-start-2')
    expect(contesto.getAttribute('class')).toContain('lg:row-start-1')
    // Da `lg` in su accompagna lo scorrimento invece di restare in cima a una
    // colonna vuota per 1022 px su 1362 (misurato al riepilogo, a 1456 px).
    expect(contesto.getAttribute('class')).toContain('lg:sticky')
  })

  /*
   * ─── LE DUE NOTE DEL PASSO «PROFILO» STANNO DOPO IL CAMPO CHE DESCRIVONO ────
   *
   * Dal 2026-08-15 il passo «profilo» porta due righe di aiuto che l'etichetta da
   * sola non può dire: che le posizioni si possono spuntare in più d'una, e che
   * del curriculum va bene anche una FOTOGRAFIA.
   *
   * ⚠️ La seconda nota diceva anche «ed è facoltativo», e dal 2026-08-24 non è
   * più vero: il curriculum è obbligatorio. La metà che resta pesa PIÙ di prima —
   * è ciò che tiene nel modulo chi compila dal telefono e non ha un PDF
   * sottomano, cioè proprio le persone che l'obbligo rischia di far abbandonare
   * (quattro su dieci oggi arrivano senza allegato: àncora `MISURA-CV`).
   * Questo test non guarda il TESTO della nota, guarda dove sta: resterebbe verde
   * qualunque cosa ci sia scritto, ed è il motivo per cui il testo va riletto a
   * mano quando cambia.
   *
   * ⚠️ QUESTO PARAGRAFO HA DETTO IL FALSO PER UN GIORNO, e la correzione vale più
   * della frase. Diceva che «`FieldRenderer` non accetta una descrizione
   * dall'esterno — il suo `aria-describedby` è già occupato dal messaggio
   * d'errore», e che l'unica mitigazione di quel debito fosse l'ordine nel
   * documento. Era vero fino al 24/08 e da allora non più: `FieldRenderer` prende
   * `notaId`, e il suo `aria-describedby` CONCATENA — prima l'errore (la cosa
   * urgente), poi la nota. Il debito era già chiuso dallo stesso commit che qui
   * lo dava per aperto.
   *
   * ⚠️ COME È SUCCESSO, perché è la parte riusabile: la frase viveva in DUE copie
   * nate da un copia-incolla — questo docblock e `NOTE_DEI_CAMPI` in
   * `CandidaturaInsegnanteWizard.tsx` — e ne è stata corretta una sola, perché
   * l'elenco dei posti da toccare era stato fatto a memoria. Un `grep` lo avrebbe
   * derivato in un secondo: `grep -rn "descrizione dall'esterno" --include="*.ts"
   * --include="*.tsx" .` ne trova due. È la stessa trappola che questo stesso
   * lavoro aveva denunciato quaranta righe più in là per il gemello «e SPESSO il
   * curriculum» — disciplina applicata a una coppia di frasi e non all'altra.
   *
   * COM'È OGGI: la nota è resa dal wizard (è tradotta col catalogo della pagina e
   * non sta nel template), porta `id="<campo>-nota"`, è passata a `FieldRenderer`
   * come `notaId` e finisce in `aria-describedby` DOPO l'errore. Chi percorre il
   * modulo campo per campo la sente insieme al campo che descrive.
   *
   * PERCHÉ QUESTO TEST RESTA, ora che il debito non c'è più: perché l'aggancio ARIA
   * e l'ORDINE NEL DOCUMENTO sono due cose diverse, e la seconda non la guarda
   * nessun altro. `aria-describedby` serve chi ascolta; l'ordine serve chi legge e
   * chi ingrandisce. Se un domani la nota finisse sopra il campo, o in fondo al
   * passo, la pagina resterebbe corretta per lo screen reader e sbagliata per tutti
   * gli altri, senza che nessun controllo lo dica.
   *
   * ⚠️ IL DEBITO RESIDUO NON È DI `FieldRenderer`, è di
   * `DocumentoIdentitaFields.tsx:383`, che rende `persDocAllegatoNota` in un `<p>`
   * senza `id` e senza passare `notaId`. Il meccanismo per agganciarla esiste già.
   */
  it('le note di «posizioni» e del curriculum vengono DOPO il loro campo, nella stessa scatola', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    fireEvent.click(await screen.findByRole('checkbox', { name: NOME_SEDE_A }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
    fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
    fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
      target: { value: 'aspirante@example.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())

    const coppie: [string, string][] = [
      // La prima casella del gruppo delle posizioni, e la nota che lo riguarda.
      [POSIZIONE_SCELTA, itPublic.candPosizioniAiuto],
      // Il controllo del curriculum, e la nota che dice che va bene una foto —
      // e che senza allegato non si invia (dal 2026-08-24).
      ['cv_path', itPublic.candCvNota],
    ]
    for (const [ancora, testoNota] of coppie) {
      const campo =
        ancora === 'cv_path'
          ? (document.getElementById('cv_path') as HTMLElement)
          : screen.getByRole('checkbox', { name: ancora })
      expect(campo, `il campo di «${ancora}» non è reso`).not.toBeNull()
      const nota = screen.getByText(testoNota)
      // 1 · DOPO il campo nell'ordine del documento, che è l'ordine in cui uno
      //     screen reader legge e in cui la pagina si scorre col dito.
      expect(
        campo.compareDocumentPosition(nota) & Node.DOCUMENT_POSITION_FOLLOWING,
        `la nota di «${ancora}» non viene dopo il suo campo`,
      ).toBeTruthy()
      // 2 · E nella STESSA scatola del campo — cioè il contenitore della nota
      //     contiene anche il controllo: non è appesa in fondo al passo, dove
      //     descriverebbe qualcosa che nel frattempo è scorso via.
      expect(
        nota.parentElement?.contains(campo),
        `la nota di «${ancora}» non sta nella stessa scatola del campo`,
      ).toBe(true)
      /*
       * 3 · E SUBITO DOPO, senza niente in mezzo. ⚠️ QUESTA È LA RIGA CHE MANCAVA,
       *     e le due qui sopra restavano verdi senza di lei. MISURATO nella pagina
       *     viva il 25/08/2026, a 900 px: fra il riquadro del curriculum e la sua
       *     nota c'erano **58 px** a riposo e **82** in errore (82 anche a 360 px),
       *     con dentro il collegamento «Leggi l'informativa» alto 44 — mentre il
       *     campo gemello «Per quali posizioni ti proponi», che la nota ce l'ha ma
       *     il link no, misurava **6 px**. Cioè: «dopo il campo» e «nella stessa
       *     scatola» erano entrambe vere CON un elemento estraneo interposto, e la
       *     frase che dice a chi compila dal telefono che può fotografare il foglio
       *     era spinta sotto un rimando legale che non aiuta a compilare.
       *     La causa era strutturale — il link lo rendeva `FieldRenderer`, la nota
       *     il wizard, sempre dopo — quindi ogni campo con `link` l'avrebbe
       *     ereditata. Ora la pila la possiede il renderer: campo → errore → nota →
       *     link.
       *     Si guarda il fratello PRECEDENTE e non i pixel: in jsdom le distanze
       *     non esistono, e la proprietà da difendere è l'adiacenza, non il numero.
       */
      const precedente = nota.previousElementSibling
      expect(precedente, `la nota di «${ancora}» non ha niente prima di sé`).not.toBeNull()
      expect(
        precedente!.contains(campo) || precedente!.getAttribute('role') === 'alert',
        `fra il campo di «${ancora}» e la sua nota si è infilato <${precedente!.tagName.toLowerCase()}>`,
      ).toBe(true)
    }
  })

  /*
   * ── E IL COLLEGAMENTO ALL'INFORMATIVA CHIUDE IL BLOCCO, NON LO SPEZZA ──────
   *
   * Il verso complementare del test qui sopra, sull'unico campo del modulo che ha
   * insieme una nota e un `link`. Senza, si potrebbe soddisfare l'adiacenza
   * togliendo il collegamento — che invece deve restare: dal 24/08 il curriculum
   * parte nell'istante in cui si sceglie il file, cioè due passi prima della
   * schermata dei consensi, e questa è l'unica via all'informativa da lì.
   */
  it('sotto il curriculum l’informativa viene DOPO la nota, non fra la nota e il campo', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
    fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
    fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
      target: { value: 'aspirante@example.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())

    const nota = screen.getByText(itPublic.candCvNota)
    const blocco = nota.parentElement!
    const collegamento = blocco.querySelector('a[href="/privacy"], [href="/privacy"]')
    expect(collegamento, 'il collegamento all’informativa non è più sotto il curriculum').not.toBeNull()
    expect(
      nota.compareDocumentPosition(collegamento!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'il collegamento all’informativa si è rimesso fra il campo e la sua nota',
    ).toBeTruthy()
  })

  it('i comandi «Modifica» del riepilogo sono alti quanto gli altri comandi della pagina', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    await compilaFinoAlRiepilogo()

    const modifiche = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.trim() === itPublic.candRiepilogoModifica)
    expect(modifiche.length).toBeGreaterThanOrEqual(3)
    // Misurato nel browser a 360 px: erano 66×32 px. `py-3.5` su un testo da
    // 12 px (riga 16) fa 44 px, la stessa altezza di «Indietro»/«Avanti» — e su
    // telefono questi sono l'unico modo di correggere prima di inviare.
    for (const b of modifiche) expect(b.getAttribute('class')).toContain('py-3.5')
  })
})

/**
 * ─── CHE COSA SIGNIFICA QUELL'ASTERISCO, DETTO UNA VOLTA (25/08/2026) ───────
 *
 * `FieldRenderer` stampa un `*` verde accanto a ogni etichetta obbligatoria, e
 * fino a oggi nessuna riga del modulo diceva che cosa fosse. MISURATO su tutti e
 * cinque i passi: la parola «obbligator*» compariva UNA volta sola in tutto il
 * wizard — nella nota del curriculum — cioè un campo su sei aveva l'obbligo
 * scritto a parole e gli altri cinque un glifo da indovinare. Era anche la
 * ragione per cui quella nota DOVEVA ripeterlo, dichiarata nel lock di
 * `candCvNota`: senza legenda, la nota era l'unico posto in cui la parola potesse
 * stare. La legenda è quindi la condizione che permette alla nota di tacere
 * sull'obbligo e di spendere la sua ultima frase per la conseguenza.
 *
 * Il lock di `insegnanti-template` difende la CHIAVE (esiste, in due lingue, e
 * nomina il carattere che spiega). Questi due difendono che sia RESA, e dove.
 */
describe('CandidaturaInsegnanteWizard — l’asterisco è spiegato una volta per passo', () => {
  it('la legenda compare in testa ai campi, e prima del primo asterisco', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    fireEvent.click(await screen.findByRole('checkbox', { name: NOME_SEDE_A }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
    fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
    fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
      target: { value: 'aspirante@example.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())

    const legenda = screen.getByText(
      (_, el) => el?.tagName === 'P' && el.textContent === LEGENDA_RESA,
    )
    expect(legenda).toBeInTheDocument()

    /*
     * ── E L'ASTERISCO DELLA LEGENDA È L'ASTERISCO CHE SPIEGA (25/08/2026) ────
     *
     * Rilievo del quarto giro, MISURATO nella pagina viva al passo «I tuoi dati»:
     *   · legenda      → 12 px / peso 400 / `rgb(85,97,92)`  (`text-kidville-sub`)
     *   · «Nome *», 24 px più sotto → 14 px / peso 500 / `rgb(0,106,95)`
     *     (`text-kidville-green`)
     * Stesso glifo, due taglie e due tinte, nella stessa schermata e a colpo
     * d'occhio. Una legenda è un dizionario: mostra il segno e poi lo traduce, e
     * se il segno mostrato non è quello che si incontra chiede al lettore il
     * passaggio in più che esiste per risparmiargli.
     *
     * La TAGLIA resta 12: la legenda è un paragrafo e deve pesare come un
     * paragrafo. È la TINTA a portare il riconoscimento, ed è la sola cosa che
     * questo test pretende — sullo stesso token del glifo che spiega, non su un
     * colore ribattuto a mano.
     */
    const astLegenda = legenda.querySelector('span')
    expect(astLegenda?.textContent, 'la legenda non isola più il glifo che spiega').toBe('*')
    expect(
      astLegenda?.getAttribute('class') ?? '',
      'l’asterisco della legenda non è quello dei campi',
    ).toContain('text-kidville-green')
    // PRIMA del campo che porta il primo asterisco: una legenda che arriva dopo
    // il glifo che spiega è una nota a piè di pagina, non una legenda.
    const primaEtichetta = screen.getByText('Per quali posizioni ti proponi')
    expect(
      legenda.compareDocumentPosition(primaEtichetta) & Node.DOCUMENT_POSITION_FOLLOWING,
      'la legenda arriva dopo il campo che dovrebbe spiegare',
    ).toBeTruthy()
  })

  it('…e NON compare dove non c’è nessun asterisco da spiegare', async () => {
    // Il controllo negativo: senza, la legenda potrebbe essere incondizionata e
    // comparire anche al riepilogo, dove non c'è un solo campo. La condizione è
    // derivata da `campiDelPasso`, non da un elenco di passi scritto a mano.
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    await screen.findByRole('checkbox', { name: NOME_SEDE_A })
    // ⚠️ SUL `textContent` DELLA PAGINA, non con `queryByText`. Provato per
    // mutazione: spostando la legenda dentro `ContatorePassi` — che è la proposta
    // letterale del rilievo, «accanto al contatore», e la mette su tutti e cinque
    // i passi — `queryByText(stringa)` restava NULL e questo test verde, perché
    // cerca un nodo il cui testo COINCIDA e là la frase è annegata in «Passo 1 di
    // 5 …». Un test che non cade quando il difetto c'è non difende niente.
    // ⚠️ SUL TESTO RESO. Oggi è lo stesso valore di catalogo, e va tenuto
    // distinto lo stesso: la strada «ovvia» per colorare il solo asterisco era
    // `t.rich` con un tag `<ast>`, e il mock di `next-intl` in `test/setup.ts`
    // implementa `rich` come `resolve(ns, key)` — restituisce il messaggio
    // GREZZO. Con quella strada la legenda in jsdom sarebbe uscita
    // «<ast>*</ast> campo obbligatorio» e questa riga sarebbe diventata un
    // controllo negativo che non può fallire, cioè approva tutto in silenzio.
    expect(
      document.body.textContent,
      'la legenda compare anche su un passo che non ha campi con asterisco',
    ).not.toContain(LEGENDA_RESA)
  })
})

describe('CandidaturaInsegnanteWizard — il collegamento targato nomina la sede', () => {
  it('con ?sede= valido: il nome del plesso è sotto il titolo, dal primo passo', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)

    // Il primo passo è «I tuoi dati»: la sede non si sceglie.
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(screen.queryByRole('checkbox', { name: NOME_SEDE_A })).not.toBeInTheDocument()

    const atteso = itPublic.candSedeDalLinkTitolo.replace('{sede}', NOME_SEDE_A)
    expect(screen.getByText(atteso)).toBeInTheDocument()
    // E l'aside non dice più «la sede che hai scelto», perché nessuna scelta c'è stata.
    expect(screen.getByText(itPublic.candContestoDirezioneDalLink)).toBeInTheDocument()
    expect(screen.queryByText(itPublic.candContestoDirezione)).not.toBeInTheDocument()
  })

  it('con ?sede= ma elenco NON ottenuto: nessun nome inventato e nessun uuid a schermo', async () => {
    mockSedi({ ok: false })
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)

    // Il modulo parte lo stesso — un guasto dell'elenco non impedisce una
    // candidatura — ma il nome del plesso non si conosce e non si finge.
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(screen.queryByText(new RegExp(SEDE_A))).not.toBeInTheDocument()
    expect(
      screen.queryByText(itPublic.candSedeDalLinkTitolo.replace('{sede}', NOME_SEDE_A)),
    ).not.toBeInTheDocument()
    // La frase dell'aside resta quella del collegamento: è vera comunque.
    expect(screen.getByText(itPublic.candContestoDirezioneDalLink)).toBeInTheDocument()
  })

  it('senza ?sede=, quando la sede la si sceglie, l’aside torna a dire «che hai scelto»', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    await screen.findByRole('checkbox', { name: NOME_SEDE_A })

    expect(screen.getByText(itPublic.candContestoDirezione)).toBeInTheDocument()
    expect(screen.queryByText(itPublic.candContestoDirezioneDalLink)).not.toBeInTheDocument()
  })
})

/**
 * ─── IL PASSO NUOVO COMINCIA DAL SUO TITOLO ─────────────────────────────────
 *
 * Fino all'11/08/2026 cambiare passo cambiava soltanto un numero: il documento
 * restava all'altezza di scorrimento di prima, e il passo nuovo si apriva a
 * metà. MISURATO a 360×740 sulla pagina viva (banco di prova in un iframe da
 * 360 px, elenco delle sedi finto perché la chiave di `.env.local` non è quella
 * del progetto e la rotta risponde 500):
 *
 *   · dal fondo del passo «I tuoi dati» (scrollY 501 su docH 1241) si preme
 *     «Avanti»: «Il tuo profilo» si apre ancora a scrollY 501 su docH 1429, con
 *     l'`h2` a y 188 e il select «Titolo di studio» (obbligatorio) a y 279 —
 *     entrambi sopra il bordo superiore della finestra;
 *   · dal riepilogo scorso in fondo, «Modifica» accanto a «I tuoi dati» apriva
 *     il passo con Nome, Cognome ed Email tutti fuori dalla finestra: si chiede
 *     di correggere l'anagrafica e si vede tutto tranne l'anagrafica.
 *
 * Da tastiera il fuoco restava sul `<button>` che React riusa fra un passo e
 * l'altro — cioè su «Avanti» — e nessuno annunciava che la schermata era
 * cambiata.
 *
 * ⚠️ COSA SI PUÒ ASSERIRE QUI. jsdom non impagina: `scrollTop` è sempre 0 e ogni
 * rettangolo è 0×0. Quello che si può misurare è ciò che il componente FA — dove
 * posa il fuoco, e che chieda al documento di tornare in cima — ed è per questo
 * che `scrollTop` viene intercettato invece che letto. Le misure in pixel sono
 * quelle prese nel browser, qui sopra.
 */
describe('CandidaturaInsegnanteWizard — cambiando passo si ricomincia dal titolo', () => {
  /** Ogni valore che il componente ha assegnato a `scrollTop` del documento. */
  let scorrimentiChiesti: number[] = []

  beforeEach(() => {
    scorrimentiChiesti = []
    Object.defineProperty(document.documentElement, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: (v: number) => {
        scorrimentiChiesti.push(v)
      },
    })
  })

  afterEach(() => {
    // Tolta la proprietà propria, torna quella del prototipo di jsdom.
    delete (document.documentElement as unknown as Record<string, unknown>).scrollTop
  })

  /** L'`h2` del passo corrente, cioè il bersaglio del fuoco. */
  function titoloDelPasso(): HTMLElement {
    return screen.getByRole('heading', { level: 2, name: itPublic.candDati })
  }

  it('«Avanti»: il fuoco va sull’`h2` del passo nuovo e il documento torna in cima', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    fireEvent.click(await screen.findByRole('checkbox', { name: NOME_SEDE_A }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(document.activeElement).toBe(titoloDelPasso())
    expect(scorrimentiChiesti).toContain(0)
    // Raggiungibile col FUOCO, non col Tab: il titolo non diventa una tappa in
    // più nella tabulazione di chi non ha chiesto niente.
    expect(titoloDelPasso().getAttribute('tabindex')).toBe('-1')
    // E chi ascolta sente anche DOVE si trova nella sequenza: la descrizione è
    // la riga «Passo N di M», che sta già a schermo.
    const contatore = document.getElementById(
      titoloDelPasso().getAttribute('aria-describedby') ?? '',
    )
    expect(contatore?.textContent).toContain('2')
  })

  it('«Indietro»: stessa cosa nell’altro verso', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    fireEvent.click(await screen.findByRole('checkbox', { name: NOME_SEDE_A }))
    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    scorrimentiChiesti = []
    fireEvent.click(screen.getByRole('button', { name: itPublic.candIndietro }))

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candSede })).toHaveFocus(),
    )
    expect(scorrimentiChiesti).toContain(0)
  })

  it('«Modifica» dal riepilogo: si apre il passo che si è chiesto di correggere, dal suo inizio', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    await compilaFinoAlRiepilogo()

    scorrimentiChiesti = []
    // Il nome accessibile del comando porta il gruppo: «Modifica I tuoi dati».
    fireEvent.click(
      screen.getByRole('button', {
        name: `${itPublic.candRiepilogoModifica} ${itPublic.candDati}`,
      }),
    )

    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(document.activeElement).toBe(titoloDelPasso())
    expect(scorrimentiChiesti).toContain(0)
    // Il dato che si è chiesto di correggere è ancora quello scritto: il fuoco
    // si sposta, i valori no.
    expect(screen.getByPlaceholderText('Es. Maria')).toHaveValue('Ines')
  })

  it('all’APERTURA il fuoco non si tocca: nessuno ha chiesto di essere spostato', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    await screen.findByRole('checkbox', { name: NOME_SEDE_A })

    // Rubare il fuoco al caricamento sarebbe il difetto opposto, e sarebbe peggio:
    // il passo non è «cambiato», la pagina è appena comparsa.
    expect(document.activeElement).toBe(document.body)
    expect(scorrimentiChiesti).toEqual([])
  })

  it('quando il fuoco è già stato posato di proposito, il cambio di passo non lo porta via', async () => {
    // «Avanti» senza scegliere la sede: l'indice NON cambia, ma il fuoco va sul
    // primo radio (l'effetto che esisteva già). Il caso gemello — il rifiuto
    // `SEDE_DA_SPECIFICARE`, che riporta all'indice 0 mentre il fuoco deve
    // restare sul pannello che spiega — è collaudato in
    // `CandidaturaInsegnanteWizard-sede.test.tsx`, e resta il presidio di quel
    // ramo: se l'effetto del cambio di passo glielo rubasse, quel test è rosso.
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    const prima = await screen.findByRole('checkbox', { name: NOME_SEDE_A })

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    await screen.findByText(itPublic.candSedeErrore)
    expect(document.activeElement).toBe(prima)
  })
})

/**
 * ─── IL VALORE PIÙ IMPORTANTE DEL RIEPILOGO NON ESCE DALLA SUA SCATOLA ──────
 *
 * MISURATO a 360 px: la scatola di testo di un valore è larga 294 px e
 * «mariaconcetta.esposito@scuolainfanzialafavola.it» (48 caratteri, un indirizzo
 * di scuola ordinario) ne occupa 313 — il testo scavalcava il bordo della card e
 * le righine divisorie. Con una parte locale non spezzabile la pagina INTERA si
 * trascinava di lato di 22,5 px (`scrollWidth` 382 contro `clientWidth` 360).
 * È l'email, cioè il dato per cui il riepilogo è stato scritto.
 */
describe('CandidaturaInsegnanteWizard — il riepilogo non trabocca, e avverte prima del bottone', () => {
  it('ogni valore del riepilogo può andare a capo dentro una parola', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    await compilaFinoAlRiepilogo()

    const valore = screen.getByText('aspirante@example.test')
    expect(valore.getAttribute('class')).toContain('wrap-anywhere')
  })

  it('«controlla l’email» sta PRIMA di «Invia candidatura», dove il riquadro di contesto non arriva più', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard />)
    await compilaFinoAlRiepilogo()

    const avviso = screen.getByText(itPublic.candRiepilogoControllaEmail)
    const invia = screen.getByRole('button', { name: itPublic.candInvia })
    // L'avvertimento che riguarda un gesto da fare PRIMA di premere sta prima
    // del bottone: è la metà della vecchia colonna di contesto che non poteva
    // scendere sotto i comandi insieme al resto.
    expect(avviso.compareDocumentPosition(invia) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
