import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import itPublic from '../../messages/it/public.json'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi'

/**
 * `/lavora-con-noi` — L'ACCESSIBILITÀ DEL MODULO PUBBLICO DI CANDIDATURA.
 *
 * ─── PERCHÉ QUESTE CINQUE COSE, E NON UN «passa axe» E BASTA ───────────────
 *
 * Perché nessuna delle cinque fa rumore da nessun'altra parte, e tutte e cinque
 * sono già arrivate in produzione su una schermata gemella:
 *
 *  1. **UN SOLO `<h1>`.** Il modulo pubblico d'iscrizione — su cui 251 famiglie
 *     hanno consegnato codici fiscali di minori, allergie e note mediche — non
 *     ne aveva NESSUNO fino al 2026-08-01: era un `div` con dentro uno `span`.
 *     Chi naviga per intestazioni con uno screen reader (il modo normale di
 *     orientarsi in una pagina lunga) non trovava né il nome della pagina né il
 *     punto da cui ricominciare dopo un errore.
 *  2. **Il titolo del passo dei CONSENSI è un `h2`, e dice il nome di QUEL
 *     passo.** Sul wizard fratello la catena di ternari non aveva il ramo dei
 *     consensi e cadeva su quello finale: la schermata su cui si presta il
 *     consenso al trattamento si annunciava «Riepilogo». Un'intestazione che
 *     dice il nome di un'altra pagina non è un dettaglio estetico — è la prima
 *     cosa che uno screen reader legge quando ci si arriva.
 *  3. **`fieldset`/`legend` sulla sede.** Tre radio senza un gruppo dichiarato
 *     si annunciano come tre domande separate: chi ascolta sente «Kidville
 *     Alfa, pulsante di opzione» senza sapere che cosa stia scegliendo.
 *  4. **Il fuoco va sul primo campo non valido.** Senza, chi usa la tastiera o
 *     uno screen reader preme «Avanti», non succede niente di percepibile, e
 *     l'errore resta in un punto della pagina che non ha modo di trovare.
 *  5. **`jest-axe` su OGNI passo.** Un passo per volta, perché è un passo per
 *     volta che si vede: un controllo sul solo primo pannello lascerebbe fuori
 *     proprio i consensi, che sono la schermata con più testo e più caselle.
 */

expect.extend(toHaveNoViolations)

/**
 * Le regole a livello di DOCUMENTO non si applicano a un componente isolato in
 * jsdom, e `color-contrast` non è calcolabile senza layout (il contrasto ha il
 * suo lock dedicato, `__tests__/a11y/contrasto-cascata.test.tsx`). Stesso
 * insieme di `smoke.axe.test.tsx`, così due file non divergono sulla stessa
 * decisione.
 */
const axeOpts = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
}

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { CandidaturaInsegnanteWizard } from '@/components/features/public/CandidaturaInsegnanteWizard'

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const BETA = { id: SEDE_B, nome: NOME_SEDE_B }
const GAMMA = { id: SEDE_C, nome: NOME_SEDE_C }

const fetchMock = vi.fn()

function mockSedi(sedi: { id: string; nome: string }[]): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/iscrizione/sedi')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: sedi }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

const avanti = () => fireEvent.click(screen.getByRole('button', { name: itPublic.candAvanti }))

/** Compila «I tuoi dati» e passa al profilo. */
async function passoDati(): Promise<void> {
  await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Di Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. mario.rossi@email.com'), {
    target: { value: 'aspirante@example.test' },
  })
  avanti()
}

/** Compila «Il tuo profilo» e passa ai consensi. */
async function passoProfilo(): Promise<void> {
  await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/Titolo di studio/), { target: { value: 'diploma' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Nido (0-3)' }))
  avanti()
}

/** Spunta la presa visione e passa al riepilogo. */
async function passoConsensi(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /informativa sulla privacy/i }))
  avanti()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
})

describe('a11y · /lavora-con-noi — struttura e annunci', () => {
  it('c’è UN SOLO `h1`, ed è il titolo della pagina', async () => {
    mockSedi([ALFA, BETA, GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_A })).toBeInTheDocument())

    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1).toHaveLength(1)
    // L'icona è decorativa (`aria-hidden`): il nome dell'`h1` resta il titolo.
    expect(h1[0]).toHaveAccessibleName(itPublic.candTitolo)
  })

  it('l’`h1` resta uno solo in OGNI stato, compresi i due in cui il modulo non comincia', async () => {
    // I rami d'errore sono quelli in cui è più facile perdere l'intestazione:
    // sostituiscono l'intero corpo della pagina.
    for (const sedi of [[], [ALFA, BETA, GAMMA]]) {
      mockSedi(sedi)
      const { unmount } = render(<CandidaturaInsegnanteWizard />)
      await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1))
      unmount()
    }
  })

  it('il titolo di OGNI passo è un `h2`, COMPRESO quello dei consensi', async () => {
    mockSedi([ALFA, BETA, GAMMA])
    render(<CandidaturaInsegnanteWizard />)

    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_A })).toBeInTheDocument())
    expect(screen.getByRole('heading', { level: 2, name: itPublic.candSede })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: NOME_SEDE_A }))
    avanti()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candDati })).toBeInTheDocument(),
    )
    await passoDati()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candProfilo })).toBeInTheDocument(),
    )
    await passoProfilo()

    // ⚠️ IL PUNTO DI TUTTO IL FILE: il passo dei consensi ha il SUO titolo.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candConsensiTitolo })).toBeInTheDocument(),
    )
    // E non quello del passo successivo, che è il difetto già pagato.
    expect(screen.queryByRole('heading', { name: itPublic.candRiepilogo })).not.toBeInTheDocument()
    await passoConsensi()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: itPublic.candRiepilogo })).toBeInTheDocument(),
    )
    /*
     * NESSUN SALTO DI LIVELLO — e la sonda misura questo, non «zero `h3`».
     *
     * Fino all'11/08/2026 la riga qui era `queryAllByRole('heading', {level:3})`
     * a zero. Era la formulazione più stretta della regola giusta, e il
     * riepilogo completo l'ha resa falsa: ogni gruppo del riepilogo («Sede», «I
     * tuoi dati», «Il tuo profilo», «Consensi e informativa») ha la sua
     * intestazione, e sotto l'`h2` «Riepilogo» un `h3` NON è un salto — è la
     * gerarchia con cui uno screen reader salta da un gruppo all'altro invece
     * di scorrere venti righe di etichette una per una.
     *
     * Quello che non deve succedere è che un livello ne SCAVALCHI un altro
     * (h1 → h3 senza h2, h3 → h5). È ciò che si verifica qui riga per riga, ed
     * è anche ciò che controlla la regola axe `heading-order`, attiva in
     * `axeOpts` e già eseguita su questa stessa schermata più sotto.
     */
    const livelli = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)))
    expect(livelli[0], 'la prima intestazione della pagina è l’`h1`').toBe(1)
    for (let i = 1; i < livelli.length; i += 1) {
      expect(
        livelli[i],
        `salto di livello nel riepilogo: h${livelli[i - 1]} → h${livelli[i]}`,
      ).toBeLessThanOrEqual(livelli[i - 1] + 1)
    }
    // E il riepilogo ha davvero i suoi gruppi: se un giorno tornassero a essere
    // dei `<p>`, la sonda qui sopra resterebbe verde senza guardare più niente.
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0)
  })

  it('la scelta della sede è un `fieldset` con una `legend`, non tre radio sciolti', async () => {
    mockSedi([ALFA, BETA, GAMMA])
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_A })).toBeInTheDocument())

    const gruppo = container.querySelector('fieldset')
    expect(gruppo, 'le sedi devono stare in un fieldset: senza, sono tre domande separate').not.toBeNull()
    expect(gruppo?.querySelector('legend')?.textContent).toBe(itPublic.candSedeLegenda)
    // Il gruppo è annunciato con il suo nome, e contiene tutte e tre le sedi.
    expect(screen.getByRole('group', { name: itPublic.candSedeLegenda })).toBeInTheDocument()
    for (const nome of [NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C]) {
      expect(screen.getByRole('radio', { name: nome })).toBeInTheDocument()
    }
  })

  it('validazione fallita: il FUOCO va sul primo campo non valido', async () => {
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    // Il primo campo è vuoto, il secondo pieno: se il fuoco andasse «sul primo
    // campo» invece che «sul primo NON valido», questo test passerebbe lo stesso.
    // Perciò si riempie il primo e si lascia vuoto il SECONDO.
    fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Ines' } })
    avanti()

    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText('Es. Rossi')))
    // E il messaggio è testo, non solo un bordo colorato.
    expect(screen.getAllByText('Campo obbligatorio').length).toBeGreaterThan(0)
  })

  it('«candidatura inviata» è ANNUNCIATA, e il fuoco non cade su `<body>`', async () => {
    // ⚠️ IL MOMENTO PIÙ IMPORTANTE DEL MODULO. Il ramo della conferma SOSTITUISCE
    // l'intero blocco dei passi: il bottone «Invia candidatura» appena premuto
    // viene smontato, e il fuoco della tastiera cade sul documento. Senza un
    // annuncio, chi usa uno screen reader preme «Invia» e non sente NIENTE —
    // indistinguibile da una pagina che si è rotta, sull'unica schermata che dice
    // che la candidatura è partita.
    //
    // `jest-axe` non può vederlo (l'assenza di una regione live non è una
    // violazione axe) e infatti gli 11 controlli di questo file passavano lo
    // stesso: il presidio è questo test, non la sonda automatica.
    mockSedi([GAMMA])
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [GAMMA] }) })
      }
      if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'c-1' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<CandidaturaInsegnanteWizard />)

    await passoDati()
    await passoProfilo()
    await passoConsensi()
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    // 1 · È annunciata: il pannello è una regione live (`role="status"` implica
    //     `aria-live="polite"`), come già lo era l'attesa dell'elenco sedi.
    const conferma = await screen.findByRole('status')
    expect(conferma).toHaveTextContent(itPublic.candInviata)
    expect(conferma).toHaveTextContent(itPublic.candInviataCorpo)

    // 2 · E il fuoco è dentro il contenuto nuovo, non in cima al documento.
    const titolo = screen.getByRole('heading', { level: 2, name: itPublic.candInviata })
    await waitFor(() => expect(document.activeElement).toBe(titolo))
    expect(document.activeElement).not.toBe(document.body)
    // Il titolo si mette a fuoco da codice ma NON entra nell'ordine di
    // tabulazione: non è un comando, e trovarselo sotto il Tab sarebbe rumore.
    expect(titolo).toHaveAttribute('tabindex', '-1')
  })

  it('i campi dichiarano il loro SCOPO (`autocomplete`, WCAG 1.3.5)', async () => {
    // SC 1.3.5 «Identify Input Purpose», AA. Pesa proprio qui: modulo pubblico,
    // compilabile dal telefono, dove il riempimento automatico è la differenza
    // fra sei campi digitati e un tocco. Lo scopo si dichiara nel TEMPLATE e
    // arriva al controllo da `FieldRenderer`.
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    const atteso: [string, string][] = [
      ['nome', 'given-name'],
      ['cognome', 'family-name'],
      ['email', 'email'],
      ['telefono', 'tel'],
      ['residence_city', 'address-level2'],
      ['residence_province', 'address-level1'],
    ]
    for (const [id, scopo] of atteso) {
      const campo = document.getElementById(id)
      expect(campo, `il campo ${id} non è reso`).not.toBeNull()
      expect(campo, `${id}: scopo dichiarato`).toHaveAttribute('autocomplete', scopo)
    }
  })

  it('il campo in errore è marcato `aria-invalid` e collegato al proprio messaggio', async () => {
    mockSedi([GAMMA])
    render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    avanti()

    await waitFor(() =>
      expect(screen.getByPlaceholderText('Es. Maria')).toHaveAttribute('aria-invalid', 'true'),
    )
    const descritto = screen.getByPlaceholderText('Es. Maria').getAttribute('aria-describedby')
    expect(descritto).toBe('nome-error')
    expect(document.getElementById(String(descritto))?.textContent).toContain('Campo obbligatorio')
  })
})

describe('a11y · /lavora-con-noi — jest-axe su ogni schermata', () => {
  it('attesa dell’elenco sedi', async () => {
    let sblocca: (() => void) | null = null
    const attesa = new Promise<void>((r) => {
      sblocca = r
    })
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return attesa.then(() => ({ ok: true, status: 200, json: async () => ({ success: true, data: [GAMMA] }) }))
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())

    expect(await axe(container, axeOpts)).toHaveNoViolations()
    sblocca!()
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  })

  it('elenco sedi non ottenuto (il pannello con «Riprova»)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return Promise.resolve({ ok: false, status: 429, json: async () => ({ error: 'no' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByText(itPublic.candSediErroreTitolo)).toBeInTheDocument())

    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('nessuna sede disponibile (il pannello senza «Riprova»)', async () => {
    mockSedi([])
    const { container } = render(<CandidaturaInsegnanteWizard />)
    await waitFor(() => expect(screen.getByText(itPublic.candSediVuoteTitolo)).toBeInTheDocument())

    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('i quattro passi compilabili, uno per uno, più il riepilogo e la conferma', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/iscrizione/sedi')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [ALFA, BETA, GAMMA] }),
        })
      }
      if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'c-1' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    const { container } = render(<CandidaturaInsegnanteWizard />)

    // 1 · sede
    await waitFor(() => expect(screen.getByRole('radio', { name: NOME_SEDE_A })).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
    fireEvent.click(screen.getByRole('radio', { name: NOME_SEDE_B }))
    avanti()

    // 2 · dati
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
    await passoDati()

    // 3 · profilo
    await waitFor(() => expect(screen.getByLabelText(/Titolo di studio/)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
    await passoProfilo()

    // 4 · consensi
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
    )
    expect(await axe(container, axeOpts)).toHaveNoViolations()
    await passoConsensi()

    // 5 · riepilogo
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    // 6 · conferma
    await waitFor(() => expect(screen.getByText(itPublic.candInviata)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('il pannello d’errore d’invio', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: 'no', codice: 'CANDIDATURA_NON_INVIATA' }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    const { container } = render(<CandidaturaInsegnanteWizard sedeId={SEDE_A} />)

    await passoDati()
    await passoProfilo()
    await passoConsensi()
    await waitFor(() => expect(screen.getByText(itPublic.candRiepilogoSede)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: itPublic.candInvia }))

    await waitFor(() => expect(screen.getByText(itPublic.candErroreInvioTitolo)).toBeInTheDocument())
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })
})
