import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { useForm, type FieldValues } from 'react-hook-form'
import itPublic from '../../messages/it/public.json'
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
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

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
 * Dalla scelta della sede fino al riepilogo, compilando il minimo che i passi
 * pretendono. Il wizard dev'essere già reso e l'elenco già arrivato.
 */
async function compilaFinoAlRiepilogo(): Promise<void> {
  fireEvent.click(await screen.findByRole('radio', { name: NOME_SEDE_A }))
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
  fireEvent.click(screen.getByRole('checkbox', { name: 'Infanzia (3-6)' }))
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
    const primaSede = await screen.findByRole('radio', { name: NOME_SEDE_A })
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
    const prima = await screen.findByRole('radio', { name: NOME_SEDE_A })
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
    await screen.findByRole('radio', { name: NOME_SEDE_A })

    fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

    const errore = await screen.findByText(itPublic.candSedeErrore)
    const gruppo = container.querySelector('fieldset') as HTMLFieldSetElement
    const ultimaCard = screen.getByRole('radio', { name: NOME_SEDE_B }).closest('label') as Element

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
    await screen.findByRole('radio', { name: NOME_SEDE_A })

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
    await screen.findByRole('radio', { name: NOME_SEDE_A })

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

describe('CandidaturaInsegnanteWizard — il collegamento targato nomina la sede', () => {
  it('con ?sede= valido: il nome del plesso è sotto il titolo, dal primo passo', async () => {
    mockSedi({ ok: true, sedi: [ALFA, BETA] })
    render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)

    // Il primo passo è «I tuoi dati»: la sede non si sceglie.
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()

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
    await screen.findByRole('radio', { name: NOME_SEDE_A })

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
    fireEvent.click(await screen.findByRole('radio', { name: NOME_SEDE_A }))
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
    fireEvent.click(await screen.findByRole('radio', { name: NOME_SEDE_A }))
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
    await screen.findByRole('radio', { name: NOME_SEDE_A })

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
    const prima = await screen.findByRole('radio', { name: NOME_SEDE_A })

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
