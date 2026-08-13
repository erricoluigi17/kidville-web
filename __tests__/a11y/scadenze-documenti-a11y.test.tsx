import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import itAdmin from '../../messages/it/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'
import { TIPI_DOCUMENTO } from '@/lib/forms/personale-template'

/**
 * L'ACCESSIBILITÀ DEL CRUSCOTTO DELLE SCADENZE — sei cose, e non un «passa axe».
 *
 *  1. **LO STATO NON È SOLO UN COLORE.** Quattro pillole rosse, arancioni, blu e
 *     grigie senza testo sono quattro pillole identiche per circa un uomo su
 *     dodici — e qui la differenza fra due pillole è «ha tempo» e «sta lavorando
 *     senza un documento valido». Il test cerca il TESTO di ogni stato, e
 *     verifica che le icone siano `aria-hidden`: sono ridondanza visiva, non un
 *     secondo nome da far leggere due volte a uno screen reader.
 *  2. **I RIQUADRI DICONO SE SONO PREMUTI.** Senza `aria-pressed`, «filtro
 *     attivo» è un bordo colorato, cioè niente per chi non vede: si guarda una
 *     tabella corta senza sapere che è filtrata.
 *  3. **IL CARICAMENTO SI ANNUNCIA** (`role="status"` + `aria-live="polite"`) e
 *     **L'ERRORE INTERROMPE** (`role="alert"`). Sono due urgenze diverse e due
 *     ruoli diversi: un errore annunciato «con calma» arriva dopo che si è già
 *     letta la tabella vuota.
 *  4. **LA TABELLA HA UN NOME** (`<caption>`) e intestazioni con `scope="col"`:
 *     senza, è una griglia di celle in mezzo alla pagina, e ogni cella si legge
 *     senza sapere di che colonna sia.
 *  5. **LA PERSONA SI RAGGIUNGE CON TAB.** Il collegamento è un `<a href>` vero,
 *     non un `onClick` su una riga.
 *  6. **`jest-axe` su tutti e quattro gli stati** della schermata: caricamento,
 *     errore, vuoto ed elenco. Un controllo sul solo elenco lascerebbe fuori
 *     proprio i tre stati che si vedono quando qualcosa non va.
 *  7. **L'ESITO DI «APRI DOCUMENTO» È ANNUNCIATO, E I DUE ESITI SONO GEMELLI.**
 *     Al secondo giro la fascia «il browser ha bloccato la finestra» non aveva
 *     né `role` né `aria-live`, mentre quella d'errore — stesso gesto, stesso
 *     posto — aveva `role="alert"`. Muto proprio l'esito che CHIEDE un'azione,
 *     e a 1745 px dal comando premuto (25 righe a 1280 px): il clic non si
 *     vedeva e non si sentiva, indistinguibile da un pulsante rotto.
 *  8. **IL COMANDO CHE LAVORA NON SI MARCA `disabled`.** Chrome sfoga il fuoco
 *     dell'elemento che diventa `disabled` e non glielo restituisce (WCAG
 *     2.4.3): su una tabella da 500 righe è tutta la coda di lavoro da
 *     ritabulare, una riga alla volta.
 *  9. **IL PANNELLO ESISTE NELLA MAPPA DELLE INTESTAZIONI.** Al quarto giro la
 *     pagina intera aveva UN `<h1>` e ZERO `<h2>`: col tasto H si arrivava a
 *     «Gestione Staff» e poi al nulla, e nella schermata del vuoto il titolo —
 *     l'unico messaggio a schermo — era un `<p>` travestito da titolo.
 * 10. **UN SOLO ANELLO DI FUOCO, ANCHE IN ALTO CONTRASTO.** Sul ricovero del
 *     fuoco due regole di `globals.css` si sommavano e dipingevano DUE bande
 *     gialle dove ogni altro comando ne porta una.
 *
 * In coda, un LOCK sulle etichette: ogni tipo di documento dichiarato in
 * `TIPI_DOCUMENTO` deve avere la sua chiave di catalogo. Senza, a schermo esce
 * la sigla del database (`DL`) — in italiano come in inglese.
 */

expect.extend(toHaveNoViolations)

/**
 * Le regole a livello di DOCUMENTO non si applicano a un componente isolato in
 * jsdom, e `color-contrast` non è calcolabile senza layout (ha il suo lock
 * dedicato). Stesso insieme di `smoke.axe.test.tsx`, così due file non divergono
 * sulla stessa decisione.
 */
const axeOpts = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
}

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'TypeError' }))

/**
 * ⚠️ QUI `next-intl` SI RIMOCKA, e non è pignoleria.
 *
 * Il mock globale di `test/setup.ts` risolve la chiave ma IGNORA i valori:
 * `t('scadApriDocumentoDi', { nome })` restituisce la stringa col segnaposto
 * `{nome}` ancora dentro. Su questo file sarebbe FATALE — il nome accessibile di
 * ogni riga risulterebbe identico a quello di tutte le altre, cioè esattamente il
 * difetto che il test esiste per misurare, qualunque cosa faccia il prodotto. Un
 * test verde su una misura incapace di distinguere i due casi non è un test: è
 * una rassicurazione.
 *
 * Si interpola il solo segnaposto SEMPLICE `{chiave}`; i plurali ICU restano
 * grezzi come nel mock globale, e nessuna asserzione di questo file li guarda.
 */
vi.mock('next-intl', async () => {
  const spazi: Record<string, Record<string, string>> = {
    adminStudents: (await import('../../messages/it/adminStudents.json')).default,
    etichette: (await import('../../messages/it/etichette.json')).default,
  }
  const risolvi = (ns: string | undefined, chiave: string, valori?: Record<string, unknown>): string => {
    const gruppo = ns ? spazi[ns] : undefined
    const testo = (gruppo && gruppo[chiave]) ?? (ns ? `${ns}.${chiave}` : chiave)
    if (!valori) return testo
    return testo.replace(/\{(\w+)\}/g, (intero, nome: string) => (nome in valori ? String(valori[nome]) : intero))
  }
  const useTranslations = (ns?: string) => {
    const t = (chiave: string, valori?: Record<string, unknown>) => risolvi(ns, chiave, valori)
    return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})
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

import { ScadenzeDocumenti } from '@/components/features/admin/personale/ScadenzeDocumenti'

const OGGI = '2026-08-12'
const SCADUTA = 'dddddddd-0000-4000-8000-000000000001'

const RIGHE = [
  { utente_id: SCADUTA, nome: 'Anna', cognome: 'Alfa', ruolo: 'educator', scuola_id: SEDE_A, document_type: 'CI', document_expiry: '2026-08-01' },
  { utente_id: 'dddddddd-0000-4000-8000-000000000002', nome: 'Bruna', cognome: 'Beta', ruolo: 'segreteria', scuola_id: SEDE_A, document_type: 'PP', document_expiry: '2026-09-05' },
  { utente_id: 'dddddddd-0000-4000-8000-000000000003', nome: 'Dina', cognome: 'Delta', ruolo: 'cuoca', scuola_id: SEDE_A, document_type: 'DL', document_expiry: '2026-10-30' },
  { utente_id: 'dddddddd-0000-4000-8000-000000000004', nome: 'Elsa', cognome: 'Epsilon', ruolo: 'educator', scuola_id: SEDE_A, document_type: null, document_expiry: null },
]

const fetchMock = vi.fn()

function rispondi(righe: unknown[] = RIGHE) {
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ data: righe, inRegola: 2, cessati: 1, oggi: OGGI, orizzonteGiorni: 90, totalePersonale: 7, limite: 500 }),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // ⚠️ Tempo congelato: gli stati sono distanze fra date, e senza questa riga il
  // test diventerebbe rosso da solo quando il calendario raggiunge il 2026-10-30.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-12T09:00:00.000Z'))
  fetchMock.mockReset()
  rispondi()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('a11y · cruscotto scadenze documenti', () => {
  it('lo stato di ogni riga è TESTO, e le icone non si fanno leggere due volte', async () => {
    const { container } = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    // I quattro stati presenti in tabella hanno il loro nome scritto.
    for (const testo of [itAdmin.scadStatoScaduto, itAdmin.scadStatoEntro30, itAdmin.scadStatoEntro90, itAdmin.scadStatoMancante]) {
      expect(screen.getAllByText(testo).length, `lo stato «${testo}» non è scritto da nessuna parte`).toBeGreaterThan(0)
    }
    // Nessuna icona `svg` senza `aria-hidden`: sarebbero nomi accessibili in più
    // su un contenuto che il testo accanto dice già.
    const svgParlanti = [...container.querySelectorAll('svg')].filter((s) => s.getAttribute('aria-hidden') !== 'true')
    expect(svgParlanti.length, 'un’icona decorativa si annuncia allo screen reader').toBe(0)
  })

  it('i riquadri sono interruttori che dichiarano il proprio stato', async () => {
    render(<ScadenzeDocumenti userId="u1" statoIniziale="scaduto" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    const premuti = screen.getAllByRole('button', { pressed: true })
    expect(premuti.length, 'nessun riquadro dichiara di essere il filtro attivo').toBe(1)
    expect(premuti[0]).toHaveTextContent(new RegExp(itAdmin.scadBoxScaduti, 'i'))
    // E gli altri tre dichiarano di NON esserlo: `aria-pressed` c'è su tutti.
    expect(screen.getAllByRole('button', { pressed: false }).length).toBeGreaterThanOrEqual(3)
  })

  it('la tabella ha un NOME e intestazioni di colonna dichiarate', async () => {
    const { container } = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    const caption = container.querySelector('table > caption')
    expect(caption, 'la tabella non ha un nome: è una griglia di celle in mezzo alla pagina').toBeTruthy()
    expect(caption).toHaveTextContent(itAdmin.scadTabScadenze)

    const intestazioni = [...container.querySelectorAll('th')]
    expect(intestazioni.length).toBe(7)
    for (const th of intestazioni) expect(th).toHaveAttribute('scope', 'col')
  })

  it('la persona si raggiunge con Tab: è un collegamento vero, non una riga cliccabile', async () => {
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    const link = screen.getByRole('link', { name: 'Alfa Anna' })
    expect(link).toHaveAttribute('href', `/admin/students/${SCADUTA}?kind=staff`)
  })

  it('caricamento ed errore usano DUE ruoli diversi: uno annuncia, l’altro interrompe', async () => {
    let sblocca: (v: unknown) => void = () => {}
    fetchMock.mockImplementation(() => new Promise((res) => { sblocca = res }))
    const vista = render(<ScadenzeDocumenti userId="u1" />)

    const stato = screen.getByRole('status')
    expect(stato).toHaveAttribute('aria-live', 'polite')
    expect(await axe(vista.container, axeOpts)).toHaveNoViolations()

    sblocca({ ok: false, status: 503, json: async () => ({ error: 'giù', codice: 'ANAGRAFICA_PERSONALE_NON_DISPONIBILE' }) })
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(await axe(vista.container, axeOpts)).toHaveNoViolations()
  })

  it('nessuna violazione axe con l’elenco pieno, né sul vuoto', async () => {
    const pieno = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    expect(await axe(pieno.container, axeOpts)).toHaveNoViolations()
    pieno.unmount()

    rispondi([])
    const vuoto = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText(itAdmin.scadVuoto)).toBeInTheDocument())
    expect(await axe(vuoto.container, axeOpts)).toHaveNoViolations()
  })

  it('ogni comando di riga DICE DI CHI È il documento che apre', async () => {
    /**
     * IL DIFETTO, misurato il 2026-08-12: tutti i comandi di riga avevano lo
     * stesso nome accessibile, «Apri documento», e nient'altro — l'icona è
     * `aria-hidden` (giusto), quindi non restava niente a distinguerli.
     * `getAllByRole('button', { name: /Apri documento/i })` tornava 2 su 2 righe,
     * con `textContent` identico.
     *
     * Chi naviga con lo screen reader per ELENCO DI COMANDI — la modalità normale
     * su una tabella — sente N volte «Apri documento, pulsante» e non ha modo di
     * sapere di chi sia il documento che sta per aprire. Su questo pannello quel
     * documento è la carta d'identità di una collega, e il secchio più grande —
     * lo dice il codice stesso — è quello che ha più righe.
     */
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    const comandi = screen.getAllByRole('button', { name: new RegExp(itAdmin.scadApriDocumento, 'i') })
    expect(comandi.length, 'nessun comando di riga: il test non sta guardando niente').toBe(RIGHE.length)

    const nomi = comandi.map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '')
    expect(new Set(nomi).size, `N comandi con lo stesso nome accessibile: ${JSON.stringify(nomi)}`).toBe(nomi.length)
    // E il nome della persona c'è davvero, non un indice o un uuid.
    expect(nomi.some((n) => n.includes('Alfa Anna'))).toBe(true)

    // ⚠️ WCAG 2.5.3 «Label in Name»: il nome accessibile CONTIENE il testo
    // visibile. Chi comanda a voce dice quello che LEGGE («apri documento»): un
    // `aria-label` che comincia diversamente rende il comando muto.
    for (const b of comandi) {
      const etichetta = b.getAttribute('aria-label') ?? ''
      expect(
        etichetta.toLowerCase().includes(itAdmin.scadApriDocumento.toLowerCase()),
        `«${etichetta}» non contiene il testo a schermo «${itAdmin.scadApriDocumento}»`,
      ).toBe(true)
    }
  })

  it('i comandi dichiarano un bersaglio da 44 px, e non lo affidano al `py-*`', async () => {
    /**
     * MISURATO al primo giro in un iframe vero a 1280 px: «Apri documento»
     * 120,7 × 31,3; «Riprova» 78 × 38; «Togli il filtro» 115,3 × 38; il
     * collegamento alla persona 29,2 × 43,5. Quattro comandi sotto i 44×44, e il
     * peggiore è quello che si preme UNA VOLTA PER RIGA.
     *
     * Il pannello lo usa la segreteria, spesso dal telefono (la shell admin ha
     * topbar e bottom-nav mobili apposta): un bersaglio da 31 px su una riga alta
     * 43 si sbaglia, e sbagliarlo qui vuol dire aprire la scansione del documento
     * d'identità della collega sbagliata.
     *
     * ⚠️ Si guarda `min-h-[44px]` e NON il `py-*`: in jsdom non c'è layout, ma
     * soprattutto il padding verticale non È un'altezza — dipende dalla riga di
     * testo che ci sta dentro, quindi una traduzione più corta o un corpo più
     * piccolo lo rimpiccioliscono da solo. È la stessa lezione di
     * `StaffDetailPanel`.
     */
    const conElenco = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

    for (const b of screen.getAllByRole('button', { name: new RegExp(itAdmin.scadApriDocumento, 'i') })) {
      expect(b.className, '«Apri documento» non dichiara un’altezza minima').toContain('min-h-[44px]')
    }
    // Il collegamento alla persona è un bersaglio in una riga di tabella, non una
    // parola dentro una frase: un nome corto arrivava a 29 px di larghezza.
    const link = screen.getByRole('link', { name: 'Alfa Anna' })
    expect(link.className).toContain('min-h-[44px]')
    expect(link.className).toContain('min-w-[44px]')
    conElenco.unmount()

    // «Togli il filtro» (vuoto da filtro) e «Riprova» (lettura fallita).
    rispondi([])
    const vuoto = render(<ScadenzeDocumenti userId="u1" statoIniziale="scaduto" />)
    await waitFor(() => expect(screen.getByRole('button', { name: itAdmin.scadTogliFiltro })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: itAdmin.scadTogliFiltro }).className).toContain('min-h-[44px]')
    vuoto.unmount()

    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'giù' }) }))
    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByRole('button', { name: itAdmin.scadRiprova })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: itAdmin.scadRiprova }).className).toContain('min-h-[44px]')
  })

  it('il ricovero del fuoco esiste, è fuori dalla tabulazione e porta l’aggancio dell’Alto Contrasto', async () => {
    /**
     * `.kv-fuoco-esito` non è decorazione: è la classe con cui `globals.css`
     * ribalta a GIALLO l'anello del fuoco in Alto Contrasto. `focus:ring-*` porta
     * l'hex inlinato da `@theme inline` e non partecipa al rimappaggio dei token,
     * quindi senza questa classe l'anello resterebbe VERDE mentre tutto il resto
     * della pagina è giallo — due linguaggi del fuoco nella stessa schermata, per
     * chi quella modalità la usa perché ne ha bisogno.
     */
    const vista = render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    // Si punta al ricovero DELL'ELENCO per nome: da questo giro ce ne sono tre —
    // questo, stabile, e le due fasce d'esito, che stanno più in alto e
    // vincerebbero un `querySelector` di classe.
    const ricovero = vista.container.querySelector('[data-ricovero="elenco"]')
    expect(ricovero, 'nessun ricovero del fuoco: al clic su «Riprova» il fuoco cade su `<body>`').toBeTruthy()
    expect(ricovero!.className).toContain('kv-fuoco-esito')
    expect(ricovero).toHaveAttribute('tabindex', '-1')
    // Fuori dalla tabulazione, ma raggiungibile da codice: nessun `role` che lo
    // faccia annunciare come un controllo che non è.
    expect(ricovero).not.toHaveAttribute('role')
  })

  describe('l’esito di «Apri documento» — il gesto che si ripete una volta per riga', () => {
    /** Una finestra finta, nuova a ogni gesto come fa il browser. */
    function finestraFinta() {
      const w = { closed: false, opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn(() => { w.closed = true }) }
      return w
    }

    /** Le tre chiamate del pannello: elenco, dettaglio (`?utenteId=`), firma (`?doc=`). */
    function instrada(dettaglio?: () => unknown) {
      fetchMock.mockImplementation((url: unknown) => {
        const u = String(url)
        if (u.includes('utenteId=')) {
          return Promise.resolve(
            dettaglio
              ? dettaglio()
              : { ok: true, status: 200, json: async () => ({ data: { anagrafica: { documento_fronte_path: 'personale/ci.pdf' } } }) },
          )
        }
        if (u.includes('doc=')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ url: 'https://esempio.invalid/firmata' }) })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: RIGHE, inRegola: 2, cessati: 1, oggi: OGGI, totalePersonale: 7, limite: 500 }),
        })
      })
    }

    const comandoDi = (persona: string) =>
      screen.getByRole('button', { name: itAdmin.scadApriDocumentoDi.replace('{nome}', persona) })

    afterEach(() => { vi.unstubAllGlobals() })

    // ⚠️ jsdom NON riproduce lo sfogo del fuoco di Chrome (misurato: `BUTTON`
    // prima, durante e dopo `disabled`): qui il peso lo porta l'ATTRIBUTO, che è
    // la causa. Vedi la nota estesa in `__tests__/components/ScadenzeDocumenti`.
    it('mentre lavora dichiara `aria-busy` e NON `disabled`: il fuoco resta sul comando', async () => {
      instrada(() => new Promise(() => {}))
      vi.stubGlobal('open', vi.fn(() => finestraFinta()))
      render(<ScadenzeDocumenti userId="u1" />)
      await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

      const bottone = comandoDi('Alfa Anna')
      bottone.focus()
      fireEvent.click(bottone)
      await waitFor(() => expect(bottone).toHaveAttribute('aria-busy', 'true'))

      expect(bottone, 'WCAG 2.4.3: `disabled` scarica il fuoco su `<body>` e non lo restituisce').not.toBeDisabled()
      expect(bottone).toHaveAttribute('aria-disabled', 'true')
      expect(document.activeElement).toBe(bottone)
      // ⚠️ Il NOME del comando non cambia mentre lavora: lo stato lo dice
      // `aria-busy`. Un'etichetta che diventa «Apertura…» rompe WCAG 2.5.3 per
      // chi comanda a voce, che continua a dire quello che LEGGEVA.
      expect(bottone.getAttribute('aria-label')).toContain(itAdmin.scadApriDocumento)
    })

    it('la finestra bloccata si ANNUNCIA come la gemella d’errore, e va a prendersi il fuoco', async () => {
      instrada()
      vi.stubGlobal('open', vi.fn(() => null))
      const vista = render(<ScadenzeDocumenti userId="u1" />)
      await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

      fireEvent.click(comandoDi('Alfa Anna'))
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

      const fascia = vista.container.querySelector('[data-ricovero="esito"]')
      expect(fascia, 'l’esito che chiede un’azione non ha un ricovero del fuoco').toBeTruthy()
      expect(fascia).toHaveAttribute('role', 'alert')
      expect(fascia).toHaveAttribute('tabindex', '-1')
      await waitFor(() => expect(document.activeElement).toBe(fascia))

      // Il collegamento di ripiego DICE DI CHI È il documento: «apri il
      // documento» ripetuto non distingue una riga dall'altra, e qui si sta per
      // aprire la carta d'identità di una persona vera.
      const link = within(fascia as HTMLElement).getByRole('link')
      expect(link).toHaveAccessibleName(itAdmin.scadApriDocumentoDi.replace('{nome}', 'Alfa Anna'))

      // …e lo stato d'esito non introduce violazioni: è una schermata come le altre.
      expect(await axe(vista.container, axeOpts)).toHaveNoViolations()
    })

    it('anche l’esito d’ERRORE è annunciato, riceve il fuoco e passa axe', async () => {
      instrada(() => ({ ok: false, status: 503, json: async () => ({ error: 'giù' }) }))
      vi.stubGlobal('open', vi.fn(() => finestraFinta()))
      const vista = render(<ScadenzeDocumenti userId="u1" />)
      await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

      fireEvent.click(comandoDi('Alfa Anna'))
      await waitFor(() => expect(screen.getByText(itAdmin.scadErroreDocumento)).toBeInTheDocument())

      const fascia = vista.container.querySelector('[data-ricovero="esito"]')
      expect(fascia).toHaveAttribute('role', 'alert')
      expect(fascia).toHaveAttribute('tabindex', '-1')
      await waitFor(() => expect(document.activeElement).toBe(fascia))
      expect(await axe(vista.container, axeOpts)).toHaveNoViolations()
    })
  })

  describe('le intestazioni — il pannello deve esistere nella mappa della pagina', () => {
    /**
     * IL DIFETTO, misurato il 2026-08-12 su `/admin/staff?tab=scadenze`:
     * `document.querySelectorAll('h2').length` era **0** sull'intera pagina, e
     * `[data-ricovero="elenco"] h1,h2,h3` era **0** in tutti e quattro gli stati.
     * L'unica intestazione era l'`<h1>` «Gestione Staff» della testata di pagina,
     * che è comune alle DUE linguette e quindi non dice nemmeno quale delle due
     * si sta guardando.
     *
     * La navigazione per intestazioni (il tasto H) è il modo normale di
     * orientarsi con uno screen reader: qui restituiva il titolo della pagina e
     * poi il nulla, senza nessun modo di saltare al cruscotto. E nella schermata
     * del VUOTO VERO il difetto si vedeva nella sua forma peggiore: quel titolo
     * era l'UNICO messaggio a schermo, portava la formula visiva di
     * un'intestazione (`font-barlow`, corpo maggiorato, maiuscolo, verde) — la
     * stessa che altrove nel repo sta su un `<h2>` — ed era un `<p>`. Un titolo
     * travestito: si vede, e per chi ascolta non esiste.
     */
    const LIVELLO = /^H([1-6])$/

    it('il pannello contribuisce la propria intestazione, col nome della linguetta', async () => {
      const { container } = render(<ScadenzeDocumenti userId="u1" />)
      await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())

      const intestazioni = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      expect(
        intestazioni.length,
        'il pannello non contribuisce nessuna intestazione: con il tasto H la pagina finisce sull’`<h1>` e non ha più niente',
      ).toBeGreaterThan(0)

      // Ed è un `<h2>`: la sezione sta sotto l'`<h1>` della pagina.
      const sezione = intestazioni[0]
      expect(sezione.tagName).toBe('H2')
      // Stessa stringa della linguetta premuta, non un sinonimo: chi ha appena
      // premuto «Scadenze documenti» deve ritrovare quel nome.
      expect(sezione).toHaveTextContent(itAdmin.scadTabScadenze)
      // Invisibile a schermo — la linguetta lo dice già a chi guarda — ma
      // presente per gli assistivi: `sr-only`, non `hidden` né `aria-hidden`.
      expect(sezione.className, 'l’intestazione di sezione ristampa a schermo il nome della linguetta').toContain('sr-only')
      expect(sezione).not.toHaveAttribute('aria-hidden')
    })

    it('il titolo del VUOTO VERO è un’intestazione vera, non un paragrafo travestito', async () => {
      rispondi([])
      const { container } = render(<ScadenzeDocumenti userId="u1" />)
      const titolo = await screen.findByText(itAdmin.scadVuoto)

      expect(
        titolo.tagName,
        'il titolo del vuoto è un `<p>` con la formula visiva di un titolo: si vede, e per chi ascolta non esiste',
      ).toMatch(LIVELLO)
      // Sta DENTRO il ricovero dell'elenco: è lì che si atterra e lì che, in
      // questo stato, non c'era niente a cui saltare.
      const ricovero = container.querySelector('[data-ricovero="elenco"]')!
      expect(ricovero.querySelectorAll('h1,h2,h3,h4,h5,h6').length).toBeGreaterThan(0)
      expect(ricovero.contains(titolo)).toBe(true)
    })

    it('nessun livello saltato, in tutti e quattro gli stati della schermata', async () => {
      /**
       * Non basta che le intestazioni ci siano: devono scendere di un gradino
       * per volta. `<h1>` → `<h3>` è una violazione axe (`heading-order`) e per
       * chi ascolta è un buco nella mappa — «manca una sezione, dove?».
       * L'`<h1>` della pagina qui non c'è (il pannello è montato da solo), quindi
       * si parte da 2 e si controlla la catena interna.
       */
      const livelli = (c: HTMLElement) =>
        [...c.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(LIVELLO.exec(h.tagName)![1]))

      const catenaSana = (l: number[], stato: string) => {
        expect(l[0], `${stato}: la prima intestazione del pannello non è un h2`).toBe(2)
        for (let i = 1; i < l.length; i += 1) {
          expect(l[i] - l[i - 1], `${stato}: si passa da h${l[i - 1]} a h${l[i]}, un gradino saltato`).toBeLessThanOrEqual(1)
        }
      }

      // 1. elenco pieno
      const pieno = render(<ScadenzeDocumenti userId="u1" />)
      await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
      catenaSana(livelli(pieno.container), 'elenco')
      pieno.unmount()

      // 2. vuoto vero
      rispondi([])
      const vuoto = render(<ScadenzeDocumenti userId="u1" />)
      await screen.findByText(itAdmin.scadVuoto)
      catenaSana(livelli(vuoto.container), 'vuoto vero')
      expect(livelli(vuoto.container)).toEqual([2, 3])
      vuoto.unmount()

      // 3. vuoto da filtro
      const filtrato = render(<ScadenzeDocumenti userId="u1" statoIniziale="scaduto" />)
      await screen.findByText(itAdmin.scadVuotoFiltro)
      catenaSana(livelli(filtrato.container), 'vuoto da filtro')
      filtrato.unmount()

      // 4. lettura fallita
      fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'giù' }) }))
      const rotto = render(<ScadenzeDocumenti userId="u1" />)
      await screen.findByRole('button', { name: itAdmin.scadRiprova })
      catenaSana(livelli(rotto.container), 'lettura fallita')
    })
  })

  describe('LOCK CSS — un solo anello di fuoco, anche in Alto Contrasto', () => {
    /**
     * IL DIFETTO, misurato il 2026-08-12 da tastiera con `data-contrast="high"`:
     * Tab fino a «Riprova», Invio. Il fuoco atterra sul ricovero
     * `[data-ricovero="elenco"]` — un `<div tabIndex={-1}>` — e lì `globals.css`
     * gli dipingeva DUE bande gialle di spessore diverso, mentre ogni altro
     * comando della stessa schermata (riquadri, collegamento alla persona,
     * «Apri documento») ne portava una sola.
     *
     * Le due regole non si escludevano perché toccano proprietà diverse:
     *   · `[data-contrast="high"] *:focus-visible`  → `outline: 3px solid #FFE500`
     *   · `[data-contrast="high"] .kv-fuoco-esito:focus` → `box-shadow: … #FFE500 …`
     * e la premessa scritta in `src/lib/ui/fuoco.ts` — «le euristiche di
     * `focus-visible` su un elemento non interattivo non lo mostrerebbero» — è
     * FALSA in Chrome: su un `div` con `tabIndex={-1}` messo a fuoco DA CODICE,
     * `matches(':focus-visible')` torna `true`. Quindi si applicavano entrambe.
     *
     * Perché è un difetto e non un dettaglio: un indicatore di fuoco di forma e
     * spessore diversi sui soli punti in cui il fuoco arriva da codice si legge
     * come «qualcosa è andato storto», e chi usa l'Alto Contrasto lo usa perché
     * ne ha bisogno. `fuoco.ts` è nato apposta per non avere due linguaggi del
     * fuoco nella stessa pagina.
     *
     * Il banco NON misura pixel (jsdom non fa cascata): rilegge le due regole dal
     * foglio vero e RISOLVE la cascata a mano — a parità di proprietà vince la
     * più specifica, (0,3,0) contro (0,2,0) — poi conta le bande gialle.
     */
    const CSS_GLOBALS = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8')
    /** Una regola citata in un commento non è una regola. */
    const CSS_VIVO = CSS_GLOBALS.replace(/\/\*[\s\S]*?\*\//g, '')

    function dichiarazioni(selettore: RegExp, nome: string): Record<string, string> {
      const blocco = CSS_VIVO.match(selettore)
      expect(blocco, `regola assente in globals.css: ${nome}`).not.toBeNull()
      const out: Record<string, string> = {}
      for (const riga of blocco![1].split(';')) {
        const i = riga.indexOf(':')
        if (i > 0) out[riga.slice(0, i).trim().toLowerCase()] = riga.slice(i + 1).trim()
      }
      return out
    }

    /** Quante bande GIALLE dipinge un insieme di dichiarazioni. */
    function bandeGialle(d: Record<string, string>): number {
      const nel = (v: string | undefined) => ((v ?? '').match(/#FFE500/gi) ?? []).length
      // L'outline è una banda sola per definizione; la box-shadow ne dipinge una
      // per ogni strato colorato.
      return (nel(d['outline']) > 0 ? 1 : 0) + nel(d['box-shadow'])
    }

    const universale = dichiarazioni(
      /\[data-contrast="high"\]\s*\*:focus-visible\s*\{([^}]*)\}/,
      '[data-contrast="high"] *:focus-visible',
    )
    const ricovero = dichiarazioni(
      /\[data-contrast="high"\]\s*\.kv-fuoco-esito:focus\s*\{([^}]*)\}/,
      '[data-contrast="high"] .kv-fuoco-esito:focus',
    )
    /** La cascata vera: `.kv-fuoco-esito:focus` (0,3,0) batte `*:focus-visible` (0,2,0). */
    const insieme = { ...universale, ...ricovero }

    it('il riferimento: ogni altro comando in Alto Contrasto porta UNA banda gialla', () => {
      expect(bandeGialle(universale)).toBe(1)
    })

    it('quando le due regole si applicano insieme, la banda gialla resta UNA', () => {
      expect(
        bandeGialle(insieme),
        'il ricovero del fuoco porta due anelli gialli mentre il resto della pagina ne ha uno',
      ).toBe(1)
    })

    it('ed è lo STESSO anello: stessa forma, stesso spessore, stesso distacco', () => {
      for (const prop of ['outline', 'outline-offset', 'box-shadow']) {
        expect(
          insieme[prop],
          `«${prop}» diverso dal fuoco di bottoni e link: due linguaggi del fuoco nella stessa schermata`,
        ).toBe(universale[prop])
      }
    })

    it('e da sola la regola del ricovero disegna comunque l’anello (niente fuoco invisibile)', () => {
      // Se un browser NON facesse scattare `:focus-visible` sul `div` messo a
      // fuoco da codice — che era la premessa originale — questa regola resta
      // l'unica a dipingere, e deve bastare.
      expect(bandeGialle(ricovero), 'il ricovero del fuoco resterebbe senza anello').toBe(1)
      expect(ricovero['outline']).toMatch(/#FFE500/i)
    })
  })

  it('LOCK — ogni tipo di documento dichiarato ha la sua etichetta nel catalogo', () => {
    // Senza questa riga un tipo aggiunto a `TIPI_DOCUMENTO` uscirebbe a schermo
    // come sigla di database, in italiano come in inglese, e nessun test lo
    // vedrebbe: il valore grezzo è un ripiego voluto per i dati storici, non per
    // i tipi che il prodotto dichiara di conoscere.
    const catalogo = itAdmin as unknown as Record<string, string>
    const senzaEtichetta = TIPI_DOCUMENTO
      .map((o) => String(o.value))
      .filter((v) => typeof catalogo[`scadTipo${v}`] !== 'string')
    expect(senzaEtichetta, 'tipi di documento senza etichetta: a schermo esce la sigla').toEqual([])
  })
})
