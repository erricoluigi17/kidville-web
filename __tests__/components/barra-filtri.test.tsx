import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import { createTranslator } from 'use-intl'

import type { CampoFiltro } from '@/lib/ui/filtri/tipi'
import { useFiltri } from '@/lib/ui/filtri/use-filtri'
import type { useTranslations } from 'next-intl'
import { BarraFiltri, testiBarraFiltri, type TestiBarraFiltri } from '@/components/ui/BarraFiltri'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'

expect.extend(toHaveNoViolations)

// =============================================================================
// LA BARRA FILTRI — e le tre cose che una barra filtri sbaglia sempre.
//
//  1. SPARISCE TUTTO A OGNI TASTO. Sostituire la tabella con uno spinner mentre
//     si digita è il difetto peggiore: si perde il posto in cui si era, e con
//     una connessione lenta la schermata lampeggia. Qui l'hook espone `inAttesa`
//     proprio perché le righe possano RESTARE, attenuate (§6).
//
//  2. IL COLORE DEL FILTRO NON È IL COLORE DEL DATO. Il chip «In attesa» della
//     barra e il badge «In attesa» della riga devono essere lo stesso arancione:
//     se si risceglie a occhio, la stessa parola ha due colori nella stessa
//     schermata e smette di voler dire qualcosa (§4).
//
//  3. «NESSUN RISULTATO» DETTO A UNA TABELLA VUOTA. Accusa i filtri di una colpa
//     che non hanno e manda a cercare un filtro che non esiste (§9).
//
// ── PERCHÉ QUI SI USA IL FORMATTATORE VERO ──────────────────────────────────
// Il mock di next-intl in `test/setup.ts` risolve le chiavi sui messaggi
// ITALIANI veri, ma questa barra non chiama `useTranslations` al proprio
// interno: riceve stringhe GIÀ RISOLTE (come `Combobox`), perché il plurale di
// «12 risultati» non si scrive con un ternario in TypeScript e perché una
// chiave costruita da un dato è vietata nel namespace tutelato. Quindi il banco
// fa la parte della pagina: costruisce i testi con `createTranslator` di
// `use-intl` — la libreria ICU vera che sta sotto next-intl — sul catalogo
// `messages/it/shared.json`. Se una chiave mancasse o un plurale fosse scritto
// male, si vedrebbe QUI, nel testo, e non solo in un lock.
//
// ⚠️ Nessun dato personale nei dati di prova (repository PUBBLICO).
// =============================================================================

const RADICE = process.cwd()
const CATALOGO_SHARED = JSON.parse(readFileSync(join(RADICE, 'messages/it/shared.json'), 'utf8')) as Record<string, string>

/** Il traduttore VERO del namespace `shared`, con ICU e plurali. */
const traduttore = createTranslator({
  locale: 'it',
  messages: { shared: CATALOGO_SHARED } as never,
  namespace: 'shared' as never,
  onError: (errore) => {
    throw errore
  },
}) as unknown as (chiave: string, valori?: Record<string, string | number>) => string

const TESTI: TestiBarraFiltri = testiBarraFiltri(traduttore)

// ── L'indirizzo del browser è parte del banco: la barra lo scrive e lo rilegge ─
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

interface Pratica {
  id: string
  oggetto: string
  stato: 'in_attesa' | 'approvata'
  sede: string
}

const PRATICHE: Pratica[] = [
  { id: '1', oggetto: 'Richiesta nulla osta', stato: 'in_attesa', sede: 'Cesa' },
  { id: '2', oggetto: 'Verbale del Consiglio', stato: 'approvata', sede: 'Aversa' },
  { id: '3', oggetto: 'Nulla osta al trasferimento', stato: 'in_attesa', sede: 'Giugliano' },
]

function campi(): CampoFiltro<Pratica>[] {
  return [
    { tipo: 'ricerca', chiave: 'q', etichetta: 'Cerca', dove: 'client', primario: true, testiDi: (r) => [r.oggetto] },
    {
      tipo: 'chip',
      chiave: 'stato',
      etichetta: 'Stato',
      dove: 'client',
      primario: true,
      valoreDi: (r) => r.stato,
      opzioni: [
        { valore: 'in_attesa', etichetta: 'In attesa', tono: 'warn' },
        { valore: 'approvata', etichetta: 'Approvata', tono: 'success' },
      ],
    },
    {
      tipo: 'multi',
      chiave: 'sede',
      etichetta: 'Sede',
      dove: 'client',
      valoriDi: (r) => [r.sede],
      opzioni: [
        { valore: 'Cesa', etichetta: 'Kidville Cesa' },
        { valore: 'Aversa', etichetta: 'Kidville Aversa' },
        { valore: 'Giugliano', etichetta: 'Kidville Giugliano' },
      ],
    },
    { tipo: 'periodo', chiave: 'data', etichetta: 'Periodo', dove: 'client', dataDi: () => '2026-01-01' },
    {
      tipo: 'scelta',
      chiave: 'anno',
      etichetta: 'Anno',
      dove: 'server',
      primario: true,
      obbligatorio: true,
      predefinito: '2026',
      opzioni: [
        { valore: '2026', etichetta: '2026' },
        { valore: '2025', etichetta: '2025' },
      ],
    },
    {
      tipo: 'scelta',
      chiave: 'tipo',
      etichetta: 'Tipo',
      dove: 'server',
      opzioni: [
        { valore: 'ingresso', etichetta: 'In ingresso' },
        { valore: 'uscita', etichetta: 'In uscita' },
      ],
    },
  ]
}

/** La pagina finta che monta l'hook e la barra, e mostra ciò che l'hook espone. */
function Banco({ variante = 'cockpit' as 'cockpit' | 'compatta', debounceMs }: { variante?: 'cockpit' | 'compatta'; debounceMs?: number }) {
  const [elenco] = useState(PRATICHE)
  const stato = useFiltri<Pratica>(campi(), debounceMs === undefined ? undefined : { debounceMs })
  const visibili = stato.filtra(elenco)
  return (
    <div>
      <BarraFiltri
        campi={campi()}
        stato={stato}
        testi={TESTI}
        totale={elenco.length}
        mostrati={visibili.length}
        variante={variante}
      />
      <output data-testid="chiave-server">{stato.chiaveServer}</output>
      <output data-testid="in-attesa">{String(stato.inAttesa)}</output>
      <ul aria-label="pratiche">
        {visibili.map((p) => (
          <li key={p.id}>{p.oggetto}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Il sorgente SENZA commenti, a righe e lunghezza invariate.
 *
 * ⚠️ Non è un dettaglio della sonda: è la sonda. Le tre verifiche qui sotto
 * cercano `router.replace`, `useRouter` e `setState` DENTRO un effetto — e
 * `use-filtri.ts` nomina tutti e tre nei propri commenti, proprio per spiegare
 * perché non li usa. Senza questo passaggio le tre sonde sarebbero rosse su un
 * file corretto, e la correzione «ovvia» sarebbe stata cancellare le
 * spiegazioni: un lock che si fa obbedire togliendo la documentazione.
 * (Stesso passo, e stessa ragione, di `utility-kidville-esistenti.test.ts`.)
 */
function senzaCommenti(sorgente: string): string {
  return sorgente
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (intero, prima: string) => prima + ' '.repeat(intero.length - prima.length))
}

function indirizzo(iniziale = '/admin/protocolli?userId=b3d1d697-0000-4000-8000-000000000000') {
  window.history.replaceState(null, '', iniziale)
}

beforeEach(() => indirizzo())
afterEach(() => vi.useRealTimers())

// ─────────────────────────────────────────────────────────────────────────────
describe('§1 · la geometria è quella del cockpit, non una seconda grammatica', () => {
  it('il campo di ricerca porta le quattro classi di geometria della Toolbar', () => {
    render(<Banco />)
    const campo = screen.getByRole('searchbox', { name: 'Cerca' })
    for (const classe of ['h-[42px]', 'rounded-input', 'border-[1.5px]', 'border-kidville-line']) {
      expect(campo.className, `manca ${classe}`).toContain(classe)
    }
    expect(campo.className).toContain('focus:ring-2')
    expect(campo.className).toContain('focus:ring-kidville-green/15')
  })

  it('e sono le stesse che `cockpit.tsx` usa davvero (se lì cambiano, qui si nota)', () => {
    // Non è una copia di stringhe: è il confronto col file che detta la
    // grammatica. Senza, «stessa geometria» resterebbe un'affermazione nel
    // commento di qualcuno.
    const cockpit = readFileSync(join(RADICE, 'src/components/ui/cockpit.tsx'), 'utf8')
    for (const classe of ['h-[42px]', 'rounded-input', 'border-[1.5px] border-kidville-line', 'focus:ring-kidville-green/15']) {
      expect(cockpit, `cockpit.tsx non usa più ${classe}`).toContain(classe)
    }
  })

  it('NIENTE `outline-none`: in Alto Contrasto l’anello verde non si ribalta, quello di sistema sì', () => {
    // La `Toolbar` del cockpit ha `outline-none` e l'anello `ring-kidville-green`
    // resta VERDE in Alto Contrasto (l'hex è inlinato da `@theme inline`). Qui
    // l'anello di sistema (`:focus-visible`, giallo in HC) resta sopra: stessa
    // geometria, un difetto in meno. È la lezione già scritta in `Combobox.tsx`.
    const { container } = render(<Banco />)
    const conOutlineNone = container.querySelectorAll('[class*="outline-none"]')
    expect(conOutlineNone.length).toBe(0)
  })

  it('nessun hex letterale nel markup reso', () => {
    const { container } = render(<Banco />)
    expect(container.innerHTML).not.toMatch(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§2 · le etichette sono VISIBILI, non solo un aria-label', () => {
  it('ogni controllo primario ha la sua etichetta a schermo, collegata al campo', () => {
    render(<Banco />)
    // `getByLabelText` risolve dalla `<label for>`: se l'etichetta fosse solo un
    // `aria-label` il testo non comparirebbe, e questo test non se ne accorgerebbe.
    for (const etichetta of ['Cerca', 'Stato', 'Anno']) {
      expect(screen.getByText(etichetta, { selector: 'label, legend' })).toBeInTheDocument()
    }
    expect(screen.getByRole('combobox', { name: 'Anno' })).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§3 · il pannello «Filtri»: un gruppo, non un menu', () => {
  it('`aria-expanded` + `aria-controls`, e il pannello puntato esiste davvero', () => {
    render(<Banco />)
    const bottone = screen.getByRole('button', { name: /Filtri/ })
    expect(bottone).toHaveAttribute('aria-expanded', 'false')
    const idPannello = bottone.getAttribute('aria-controls')
    expect(idPannello).toBeTruthy()
    expect(document.getElementById(idPannello!)).not.toBeNull()
    fireEvent.click(bottone)
    expect(bottone).toHaveAttribute('aria-expanded', 'true')
  })

  it('NIENTE `role="menu"` e niente `aria-haspopup`: le frecce qui non navigano', () => {
    // Un menu ARIA promette la navigazione con le frecce. Prometterla e non
    // darla è peggio che non prometterla: è la stessa motivazione già scritta
    // per il `SedeSelector` in `cockpit.tsx`.
    const { container } = render(<Banco />)
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(container.querySelector('[aria-haspopup]')).toBeNull()
  })

  it('Escape chiude e RIDÀ il fuoco al bottone che ha aperto', () => {
    render(<Banco />)
    const bottone = screen.getByRole('button', { name: /Filtri/ })
    fireEvent.click(bottone)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(bottone).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(bottone)
  })

  it('la pastiglia del conteggio è GIALLA su INCHIOSTRO, mai giallo su verde', () => {
    // #FDC400 su #006A5F vale 4,05:1: sotto AA per il testo normale, ed è
    // misurato e scritto in `globals.css`. Il conteggio è testo piccolo.
    render(<Banco />)
    fireEvent.click(screen.getByRole('button', { name: 'In attesa' }))
    const pastiglia = screen.getByTestId('conteggio-filtri')
    expect(pastiglia).toHaveTextContent('1')
    expect(pastiglia.className).toContain('bg-kidville-yellow')
    expect(pastiglia.className).toContain('text-kidville-ink')
    expect(pastiglia.className).not.toContain('text-kidville-green')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§4 · i chip attivi hanno il colore del dato', () => {
  it('«In attesa» filtro e «In attesa» badge sono lo stesso arancione', () => {
    // Il tono non si risceglie: il chip È un `Badge` col tono dell'opzione, e
    // quel tono è lo stesso che l'elenco dà alla riga.
    render(<Banco />)
    fireEvent.click(screen.getByRole('button', { name: 'In attesa' }))
    const chip = screen.getByTestId('chip-stato-in_attesa')
    expect(chip.className).toContain('bg-kidville-warn-soft')
    expect(chip.className).toContain('text-kidville-warn-strong')
  })

  it('il ✕ di un chip toglie SOLO quel valore, non tutto il campo', () => {
    render(<Banco />)
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Kidville Cesa' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kidville Aversa' }))
    expect(screen.getByTestId('chip-sede-Cesa')).toBeInTheDocument()
    expect(screen.getByTestId('chip-sede-Aversa')).toBeInTheDocument()

    fireEvent.click(within(screen.getByTestId('chip-sede-Cesa')).getByRole('button'))
    expect(screen.queryByTestId('chip-sede-Cesa')).toBeNull()
    expect(screen.getByTestId('chip-sede-Aversa')).toBeInTheDocument()
  })

  it('il ✕ si annuncia dicendo QUALE filtro toglie', () => {
    render(<Banco />)
    fireEvent.click(screen.getByRole('button', { name: 'In attesa' }))
    const chip = screen.getByTestId('chip-stato-in_attesa')
    expect(within(chip).getByRole('button')).toHaveAccessibleName('Togli il filtro Stato: In attesa')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§5 · la riga dei risultati si annuncia, e sa il plurale', () => {
  it('è una regione `status` con `aria-live="polite"`', () => {
    render(<Banco />)
    const regione = screen.getByTestId('conteggio-risultati')
    expect(regione).toHaveAttribute('role', 'status')
    expect(regione).toHaveAttribute('aria-live', 'polite')
  })

  it('«1 risultato su 3», non «1 risultati su 3»', () => {
    // Il difetto che il lock dei plurali è nato per chiudere, misurato qui sul
    // testo vero reso dal formattatore ICU.
    render(<Banco />)
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('3 risultati su 3')
    fireEvent.click(screen.getByRole('button', { name: 'Approvata' }))
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('1 risultato su 3')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§5bis · il ponte col catalogo accetta il traduttore VERO della pagina', () => {
  it('`testiBarraFiltri` prende il `t` di `useTranslations` senza nessun cast (prova di TIPO)', () => {
    // Questa riga non «gira»: COMPILA. Se un giorno la firma di `Traduttore`
    // smettesse di accettare il traduttore di next-intl, `tsc --noEmit`
    // diventerebbe rosso qui — e non tre settimane dopo, dentro la pagina di
    // qualcuno, sotto forma di un cast messo per far tacere l'errore.
    const conTraduttoreDiPagina: (t: ReturnType<typeof useTranslations>) => TestiBarraFiltri = testiBarraFiltri
    expect(conTraduttoreDiPagina).toBe(testiBarraFiltri)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§6 · il debounce, la chiave server e l’indirizzo', () => {
  it('un filtro CLIENT non tocca la chiave server e filtra subito', () => {
    render(<Banco />)
    const prima = screen.getByTestId('chiave-server').textContent
    fireEvent.change(screen.getByRole('searchbox', { name: 'Cerca' }), { target: { value: 'verbale' } })
    expect(screen.getByTestId('chiave-server').textContent).toBe(prima)
    const elenco = within(screen.getByRole('list', { name: 'pratiche' }))
    expect(elenco.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Verbale del Consiglio'])
  })

  it('un filtro SERVER aspetta 300 ms prima di cambiare la chiave', () => {
    vi.useFakeTimers()
    render(<Banco />)
    expect(screen.getByTestId('chiave-server').textContent).toBe('anno=2026')

    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Tipo' }), { target: { value: 'uscita' } })

    // Subito dopo: la chiave è ANCORA quella di prima, e l'hook lo dichiara.
    expect(screen.getByTestId('chiave-server').textContent).toBe('anno=2026')
    expect(screen.getByTestId('in-attesa').textContent).toBe('true')

    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(screen.getByTestId('chiave-server').textContent).toBe('anno=2026')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByTestId('chiave-server').textContent).toBe('anno=2026&tipo=uscita')
    expect(screen.getByTestId('in-attesa').textContent).toBe('false')
  })

  it('la chiave server è una STRINGA, non un `URLSearchParams`', () => {
    // Un `URLSearchParams` cambia identità a ogni render: metterlo nelle deps di
    // un `useEffect` è un ciclo di fetch infinito. È la stessa ragione per cui
    // `sede-context` espone `reFetchKey` come stringa.
    render(<Banco />)
    expect(typeof screen.getByTestId('chiave-server').textContent).toBe('string')
    const sorgente = senzaCommenti(readFileSync(join(RADICE, 'src/lib/ui/filtri/use-filtri.ts'), 'utf8'))
    expect(sorgente).toMatch(/chiaveServer:\s*string/)
  })

  it('l’URL si scrive con `history.replaceState` e CONSERVA i parametri altrui', () => {
    render(<Banco />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Cerca' }), { target: { value: 'verbale' } })
    const params = new URLSearchParams(window.location.search)
    expect(params.get('q')).toBe('verbale')
    // `?userId=` è il parametro che questa applicazione si porta dietro ovunque:
    // riscrivere la query buttandolo via scollegherebbe la pagina dall'utente.
    expect(params.get('userId')).toBe('b3d1d697-0000-4000-8000-000000000000')
    expect(window.location.pathname).toBe('/admin/protocolli')
  })

  it('mai `router.replace`: un round-trip RSC a ogni battuta di tasto', () => {
    const sorgente = senzaCommenti(readFileSync(join(RADICE, 'src/lib/ui/filtri/use-filtri.ts'), 'utf8'))
    expect(sorgente).toContain('history.replaceState')
    expect(sorgente).not.toContain('useRouter')
    expect(sorgente).not.toContain('router.replace')
  })

  it('nessun `setState` dentro un effetto: la regola è ERRORE nel gate, non warning', () => {
    const sorgente = senzaCommenti(readFileSync(join(RADICE, 'src/lib/ui/filtri/use-filtri.ts'), 'utf8'))
    // Il debounce parte dal gestore d'evento con `setTimeout`; l'unico effetto
    // con corpo aggiorna dei ref, e l'unico altro è il cleanup di smontaggio.
    const dentroEffetti = [...sorgente.matchAll(/useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}(?:,\s*\[[^\]]*\])?\)/g)].map((m) => m[1])
    expect(dentroEffetti.length, 'la sonda non ha trovato nessun effetto: guarderebbe il nulla').toBe(2)
    for (const corpo of dentroEffetti) {
      expect(corpo, 'un setState dentro un useEffect').not.toMatch(/\bset[A-Z]\w*\(/)
    }
  })

  it('l’indirizzo si ripulisce allo smontaggio, e solo sul proprio percorso', () => {
    const vista = render(<Banco />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Cerca' }), { target: { value: 'verbale' } })
    expect(new URLSearchParams(window.location.search).get('q')).toBe('verbale')
    vista.unmount()
    const dopo = new URLSearchParams(window.location.search)
    expect(dopo.get('q')).toBeNull()
    expect(dopo.get('userId')).toBe('b3d1d697-0000-4000-8000-000000000000')
  })

  it('lo stato di partenza si legge dall’indirizzo, una volta sola', () => {
    indirizzo('/admin/protocolli?userId=x&q=nulla&anno=2025')
    render(<Banco />)
    expect(screen.getByRole('searchbox', { name: 'Cerca' })).toHaveValue('nulla')
    expect(screen.getByRole('combobox', { name: 'Anno' })).toHaveValue('2025')
    expect(screen.getByTestId('chiave-server').textContent).toBe('anno=2025')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§7 · «Pulisci filtri»', () => {
  it('compare solo quando c’è qualcosa da pulire', () => {
    render(<Banco />)
    expect(screen.queryByRole('button', { name: 'Pulisci filtri' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'In attesa' }))
    expect(screen.getByRole('button', { name: 'Pulisci filtri' })).toBeInTheDocument()
  })

  it('azzera i filtri, NON tocca l’obbligatorio e RESTITUISCE il fuoco alla ricerca', () => {
    render(<Banco />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Anno' }), { target: { value: '2025' } })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Cerca' }), { target: { value: 'nulla' } })
    fireEvent.click(screen.getByRole('button', { name: 'In attesa' }))

    fireEvent.click(screen.getByRole('button', { name: 'Pulisci filtri' }))

    expect(screen.getByRole('searchbox', { name: 'Cerca' })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'In attesa' })).toHaveAttribute('aria-pressed', 'false')
    // L'anno è la CORNICE dell'elenco, non un filtro: riportarlo al corrente
    // farebbe perdere alla segreteria il punto in cui stava lavorando.
    expect(screen.getByRole('combobox', { name: 'Anno' })).toHaveValue('2025')
    // WCAG 2.4.3: il fuoco non può finire sul `<body>` dopo che il comando che
    // lo teneva è sparito da sotto le dita.
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Cerca' }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§8 · su telefono è un FOGLIO dal basso, non un cassetto laterale', () => {
  it('il foglio è un dialogo modale con un nome, e Escape lo chiude', () => {
    render(<Banco variante="compatta" />)
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    const foglio = screen.getByRole('dialog')
    expect(foglio).toHaveAttribute('aria-modal', 'true')
    expect(foglio).toHaveAccessibleName('Filtri')
    // Ancorato in BASSO e arrotondato in alto: è la forma del foglio del cockpit
    // (`AdminMenuSheet`), non quella del `Drawer` ancorato a destra.
    expect(foglio.className).toContain('bottom-0')
    expect(foglio.className).toContain('rounded-t-[26px]')
    expect(foglio.className).toContain('max-h-[70vh]')

    fireEvent.keyDown(foglio, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lo sfondo non scorre mentre il foglio è aperto, e torna a scorrere dopo', () => {
    render(<Banco variante="compatta" />)
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(document.body.style.overflow).toBe('')
  })

  it('il fuoco ENTRA nel foglio e alla chiusura TORNA al comando che l’ha aperto', () => {
    render(<Banco variante="compatta" />)
    const apri = screen.getByRole('button', { name: /Filtri/ })
    fireEvent.click(apri)
    const foglio = screen.getByRole('dialog')
    expect(foglio.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(foglio, { key: 'Escape' })
    expect(document.activeElement).toBe(apri)
  })

  it('la CTA dice quanti risultati mostrerà, e il numero CAMBIA mentre si tocca', () => {
    // È la micro-interazione di maggior valore del foglio: dice PRIMA di
    // chiudere se la selezione ha senso.
    render(<Banco variante="compatta" />)
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    expect(screen.getByTestId('foglio-mostra')).toHaveTextContent('Mostra 3 risultati')
    fireEvent.click(screen.getByRole('button', { name: 'Kidville Cesa' }))
    expect(screen.getByTestId('foglio-mostra')).toHaveTextContent('Mostra 1 risultato')
    fireEvent.click(screen.getByRole('button', { name: 'Kidville Aversa' }))
    expect(screen.getByTestId('foglio-mostra')).toHaveTextContent('Mostra 2 risultati')
  })

  it('i bersagli del foglio sono da toccare col pollice (≥44px)', () => {
    render(<Banco variante="compatta" />)
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    const foglio = screen.getByRole('dialog')
    const bottoni = within(foglio).getAllByRole('button')
    expect(bottoni.length).toBeGreaterThan(3)
    for (const b of bottoni) {
      expect(b.className, `bersaglio piccolo: «${b.textContent}»`).toMatch(/min-h-\[44px\]|h-11|h-\[44px\]/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§9 · StatoElenco — quattro stati, e la differenza fra due di loro', () => {
  const testi = testiStatoElenco(traduttore)

  it('«vuoto» NON nomina i filtri, e mostra il passo costruttivo', () => {
    render(
      <StatoElenco
        stato="vuoto"
        testi={{ ...testi, vuotoTitolo: 'Non c’è ancora nessun protocollo' }}
        azione={<button type="button">Protocolla un documento</button>}
      />,
    )
    expect(screen.getByText('Non c’è ancora nessun protocollo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Protocolla un documento' })).toBeInTheDocument()
    expect(screen.queryByText(/filtri/i)).toBeNull()
  })

  it('«senzaRisultati» nomina i filtri, li mostra e offre di toglierli', () => {
    const onPulisci = vi.fn()
    render(
      <StatoElenco
        stato="senzaRisultati"
        testi={testi}
        attivi={[{ chiave: 'stato', valore: 'in_attesa', etichetta: 'Stato', testo: 'In attesa', tono: 'warn' }]}
        onPulisci={onPulisci}
      />,
    )
    expect(screen.getByText('Nessun risultato con questi filtri')).toBeInTheDocument()
    expect(screen.getByText('In attesa')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pulisci filtri' }))
    expect(onPulisci).toHaveBeenCalledTimes(1)
  })

  it('«errore» dice che la lettura è fallita e offre «Riprova», non «togli i filtri»', () => {
    const onRiprova = vi.fn()
    render(<StatoElenco stato="errore" testi={testi} onRiprova={onRiprova} onPulisci={() => {}} attivi={[]} />)
    expect(screen.getByText('Non è stato possibile leggere l’elenco')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pulisci filtri' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(onRiprova).toHaveBeenCalledTimes(1)
  })

  it('«caricamento» si annuncia invece di girare in silenzio', () => {
    render(<StatoElenco stato="caricamento" testi={testi} />)
    expect(screen.getByRole('status')).toHaveTextContent('Caricamento in corso…')
  })

  it('«pronto» non rende niente: le righe sono già a schermo', () => {
    const { container } = render(<StatoElenco stato="pronto" testi={testi} />)
    expect(container).toBeEmptyDOMElement()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('§10 · accessibilità automatica', () => {
  it('barra chiusa e barra aperta: nessuna violazione axe', async () => {
    const { container } = render(<Banco />)
    expect(await axe(container)).toHaveNoViolations()
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    fireEvent.click(screen.getByRole('button', { name: 'In attesa' }))
    expect(await axe(container)).toHaveNoViolations()
  })

  it('il foglio dal basso: nessuna violazione axe', async () => {
    const { container } = render(<Banco variante="compatta" />)
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    expect(await axe(container)).toHaveNoViolations()
  })
})
