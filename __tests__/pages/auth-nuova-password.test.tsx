import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'

import itPassword from '../../messages/it/password.json'
import enPassword from '../../messages/en/password.json'

/**
 * L’INTERSTIZIALE DEL PRIMO ACCESSO — la schermata che chiude il cerchio con l’email
 * delle credenziali.
 *
 * ─── COSA DEVE FARE, E PERCHÉ OGNI PEZZO È MISURATO ─────────────────────────
 *
 *  1. **Dire perché è lì.** «Quella che hai ricevuto via email era temporanea» è la
 *     frase che l’email delle credenziali promette da mesi. Senza, la schermata è un
 *     ostacolo senza motivo fra una persona e la sua dashboard.
 *  2. **Chiamare il campo col nome che l’utente gli dà.** In quel momento la password
 *     temporanea ce l’ha ancora negli appunti: «password attuale» lo manderebbe a
 *     cercare una password che non ha mai scelto.
 *  3. **«Non ora» che funziona davvero.** È la valvola che rende impossibile chiudere
 *     fuori qualcuno: senza, un difetto qualsiasi di questa schermata diventerebbe un
 *     muro fra 560 account e il proprio registro. Chi la preme rivedrà l’invito al
 *     prossimo accesso, e il comando resta nel profilo.
 *  4. **Non fidarsi di `?next=`.** Arriva dalla barra degli indirizzi: si onora solo
 *     se è un percorso interno alle aree, altrimenti si va alla radice. Un `next`
 *     grezzo qui sarebbe un open redirect su una schermata che si apre appena dopo
 *     l’accesso — cioè nel momento in cui la persona è più disposta a fidarsi.
 */

const mockRouter = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }
let mockSearch = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
  usePathname: () => '/auth/nuova-password',
}))

vi.mock('@/lib/auth/logout', () => ({ doLogout: vi.fn(async () => {}) }))

import NuovaPasswordPage from '@/app/auth/nuova-password/page'

const P = itPassword as Record<string, string>
const EN_P = enPassword as Record<string, string>

function renderPagina(highContrast = false) {
  return render(
    <AccessibilityProvider initialHighContrast={highContrast}>
      <NuovaPasswordPage />
    </AccessibilityProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSearch = new URLSearchParams('next=/parent')
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, sessioniTerminate: true }) })))
  document.documentElement.setAttribute('lang', 'it')
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
})

describe('/auth/nuova-password — dice perché è lì', () => {
  it('occhiello, titolo e la frase che chiude il cerchio con l’email', () => {
    renderPagina()
    expect(screen.getByText(P.interstizialeOcchiello)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(P.interstizialeTitolo)
    expect(screen.getByText(P.interstizialeIntro)).toBeInTheDocument()
    // Una frase sola: la schermata non spiega due volte la stessa cosa.
    expect(P.interstizialeIntro.split('. ').length).toBeLessThanOrEqual(2)
  })

  it('il campo «attuale» è pre-etichettato «La password ricevuta via email»', () => {
    renderPagina()
    expect(screen.getByLabelText(P.labelAttualeTemporanea)).toBeInTheDocument()
    // …e NON si chiama «password attuale»: chi arriva qui non ne ha mai scelta una.
    expect(screen.queryByLabelText(P.labelAttuale)).toBeNull()
  })

  it('il selettore di lingua c’è, come nella login: la si può cambiare PRIMA di capire cosa fare', () => {
    renderPagina()
    expect(screen.getByRole('group', { name: /lingua|language/i })).toBeInTheDocument()
  })

  it('la porta dichiarata al server è «primo-accesso»: senza, quel conteggio resta a zero', async () => {
    renderPagina()
    fireEvent.change(screen.getByLabelText(P.labelAttualeTemporanea), { target: { value: 'Adcf-hjk2-3n4p-5rt6' } })
    fireEvent.change(screen.getByLabelText(P.labelNuova), { target: { value: 'nonnarosa42' } })
    fireEvent.change(screen.getByLabelText(P.labelConferma), { target: { value: 'nonnarosa42' } })
    fireEvent.click(document.querySelector('button[type="submit"]') as HTMLButtonElement)
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    const [, init] = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(JSON.parse(String(init.body)).origine).toBe('primo-accesso')
  })
})

describe('/auth/nuova-password — «Non ora» è una valvola, non una debolezza', () => {
  const nonOra = () => screen.getByRole('button', { name: new RegExp(P.interstizialeNonOra, 'i') })

  it('porta a `next`, e con `replace`: tornare indietro non rimette il muro', () => {
    renderPagina()
    fireEvent.click(nonOra())
    expect(mockRouter.replace).toHaveBeenCalledWith('/parent')
    expect(mockRouter.replace).toHaveBeenCalledTimes(1)
  })

  it('un `next` che non è un percorso interno NON si segue: si va alla radice', () => {
    // Open redirect su una schermata che si apre appena dopo l'accesso, cioè nel
    // momento in cui la persona è più disposta a fidarsi di quello che vede.
    mockSearch = new URLSearchParams('next=https://esempio.invalido/rubapassword')
    renderPagina()
    fireEvent.click(nonOra())
    expect(mockRouter.replace).toHaveBeenCalledWith('/')
  })

  it('senza `next` si va alla radice, e le guardie server-side fanno il loro lavoro', () => {
    mockSearch = new URLSearchParams()
    renderPagina()
    fireEvent.click(nonOra())
    expect(mockRouter.replace).toHaveBeenCalledWith('/')
  })

  it('il bersaglio di «Non ora» è ≥44px: si preme col pollice, non col mouse', () => {
    renderPagina()
    // ⚠️ NON si misura più l'altezza di `ui/Btn`: «Non ora» non è più un bottone
    // pieno (vedi il blocco «pesa meno, e resta ovvio»). Il bersaglio lo dichiara
    // `min-h-[44px]`, che è il minimo di WCAG 2.5.8 e vale qualunque sia il testo.
    expect(nonOra().className).toMatch(/(?:^|\s)min-h-\[44px\](?:\s|$)/)
  })
})

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⚠️ IL BERSAGLIO ERA GIÀ A NORMA, E DUE CRITICI HANNO MISURATO IL CONTRARIO.
 * QUESTO È IL BLOCCO CHE SPIEGA PERCHÉ AVEVANO RAGIONE LO STESSO.
 *
 * Misurato il 2026-09-02 sulla pagina servita (`getBoundingClientRect`, non dedotto):
 *
 *   · il BERSAGLIO di «Non ora» …………… 84,5 × 44,0 px   → WCAG 2.5.8 già rispettato
 *   · l'INCHIOSTRO della scritta ……… 52,5 × 16,5 px   → è ciò che i critici hanno
 *                                                        letto («50×15» e «46×16»)
 *
 * I due numeri non si contraddicono: dicono due cose diverse. La norma misura
 * l'area PREMIBILE; una persona mira a quella VISIBILE. Con 32 dei 44px d'altezza e
 * 32 degli 84,5px di larghezza fatti di padding trasparente, il comando è a norma e
 * sembra una nota a piè di pagina — e la nota a piè di pagina è l'unica via d'uscita
 * della schermata.
 *
 * ⚠️ E IL LOCK PRECEDENTE ERA VERDE PER TUTTO IL TEMPO. Asseriva `min-h-[44px]`, che
 * era ed è vero. Un lock che legge la classe del bersaglio non sa niente di quanto
 * inchiostro si vede: è lo stesso genere di cecità del contorno da 1px nel blocco
 * della regola, e si chiude allo stesso modo — misurando la GEOMETRIA di ciò che si
 * vede, non il nome della classe che lo contiene.
 *
 * Il rimedio NON è ridargli il rango: nel giro precedente era un bottone pieno
 * 348×36 accanto a un primario da 54, cioè due primari, e l'obiettivo falliva in
 * silenzio. Si tiene l'aspetto subordinato e si riprende l'AREA: comando di testo,
 * senza riempimento e senza bordo, con il corpo del carattere portato a 16px (che è
 * anche la soglia sotto la quale iOS zooma) e il bersaglio dichiarato in entrambe le
 * direzioni.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
describe('/auth/nuova-password — l’unica via d’uscita si vede, non solo si preme', () => {
  const nonOra = () => screen.getByRole('button', { name: new RegExp(P.interstizialeNonOra, 'i') })

  /** La misura dichiarata da un'utility arbitraria nella forma `prefisso-[Npx]`. */
  const px = (classi: string, prefisso: string): number | null => {
    const m = new RegExp(`(?:^|\\s)${prefisso}-\\[(\\d+(?:\\.\\d+)?)px\\](?:\\s|$)`).exec(classi)
    return m ? Number(m[1]) : null
  }

  /** Il corpo del carattere dichiarato: la scala di Tailwind o la forma esplicita. */
  const corpo = (classi: string): number | null => {
    const esplicito = px(classi, 'text')
    if (esplicito !== null) return esplicito
    const scala: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20 }
    const m = /(?:^|\s)text-(xs|sm|base|lg|xl)(?:\s|$)/.exec(classi)
    return m ? scala[m[1]] : null
  }

  it('CONTROLLO POSITIVO — le due sonde leggono davvero, e sanno dire di no', () => {
    // Senza, i tre divieti qui sotto sarebbero verdi su una stringa vuota.
    expect(px('min-h-[44px] px-4', 'min-h')).toBe(44)
    expect(px('px-4 font-maven', 'min-w')).toBeNull()
    expect(corpo('text-sm font-semibold')).toBe(14)
    expect(corpo('text-[13px]')).toBe(13)
    expect(corpo('font-maven underline')).toBeNull()
  })

  it('il bersaglio è dichiarato in ENTRAMBE le direzioni: ≥44px in altezza, ≥120px in larghezza', () => {
    renderPagina()
    const classi = nonOra().className
    const h = px(classi, 'min-h')
    const w = px(classi, 'min-w')
    expect(h, 'il comando non dichiara più la propria altezza').not.toBeNull()
    expect(h as number).toBeGreaterThanOrEqual(44)
    expect(
      w,
      'il comando non dichiara una larghezza minima: misurato in pagina il bersaglio era ' +
      'largo 84,5px — a norma in altezza e stretto in larghezza, cioè premibile col mouse ' +
      'e non col pollice di chi tiene il telefono con una mano sola.',
    ).not.toBeNull()
    expect(w as number).toBeGreaterThanOrEqual(120)
  })

  it('l’INCHIOSTRO non è più un piè di pagina: il corpo del carattere è almeno 16px', () => {
    renderPagina()
    const c = corpo(nonOra().className)
    expect(
      c,
      `il comando scrive a ${c}px. A 14px l’inchiostro visibile misurava 52,5 × 16,5 px dentro ` +
      'un bersaglio di 84,5 × 44: i due critici hanno misurato quello, e hanno concluso — ' +
      'giustamente, dal punto di vista di chi guarda — che la via d’uscita era un bersaglio ' +
      'da 50×15. Sotto i 16px iOS zooma anche il resto della pagina.',
    ).toBeGreaterThanOrEqual(16)
  })

  it('…e resta subordinato: l’area cresce, il RANGO no', () => {
    // Il rimedio sbagliato sarebbe ridargli il riempimento: nel giro precedente era
    // un bottone pieno accanto a un primario, cioè due primari.
    renderPagina()
    const classi = nonOra().className
    expect(classi, '«Non ora» è tornato un bottone pieno').not.toMatch(/\bbg-kidville-/)
    expect(classi, '«Non ora» ha preso un bordo, e somiglia di nuovo a un comando').not.toMatch(/(?:^|\s)border(?:-|\s|$)/)
    expect(classi, '«Non ora» è tornato a piena larghezza').not.toMatch(/\bw-full\b/)
    expect(classi, '«Non ora» non è più sottolineato: resterebbe distinguibile dal solo colore').toMatch(/\bunderline\b/)
  })
})

describe('/auth/nuova-password — la card è più alta del viewport, e questo la rende raggiungibile', () => {
  it('il guscio CRESCE col contenuto: un’altezza fissa, con `overflow-hidden`, seppellirebbe la via d’uscita', () => {
    /**
     * ⚠️ NON È UNA PIGNOLERIA DI CLASSI: È LA MISURA. Il 2026-09-02 la pagina servita
     * chiedeva **975,6px** di altezza (dal bordo alto del logo al fondo della card, più
     * il respiro verticale) contro gli **801** del portatile su cui i critici l'hanno
     * guardata: 174px stanno sotto la piega, e lì dentro c'è «Non ora».
     *
     * Il guscio porta `overflow-hidden` — serve allo sfondo decorativo — e regge solo
     * perché l'altezza è un MINIMO: il contenitore cresce, e la pagina scorre. Con
     * `h-dvh` al posto di `min-h-dvh` la stessa riga di CSS taglierebbe quei 174px
     * SENZA barra di scorrimento: l'unica via d'uscita diventerebbe irraggiungibile, e
     * nessun test di contenuto se ne accorgerebbe perché il nodo nel DOM c'è.
     */
    const { container } = renderPagina()
    const guscio = container.querySelector('div.overflow-hidden') as HTMLElement
    expect(guscio, 'il guscio con `overflow-hidden` non esiste più: la sonda guarda la cosa sbagliata').toBeTruthy()
    expect(guscio.className, 'il guscio non dichiara più un’altezza MINIMA').toMatch(/\bmin-h-dvh\b/)
    expect(
      guscio.className,
      'il guscio ha un’altezza FISSA: con `overflow-hidden` i 174px che eccedono un ' +
      'portatile da 801px vengono tagliati via, e con loro «Non ora».',
    ).not.toMatch(/(?:^|\s)h-dvh(?:\s|$)/)
  })
})

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * I TRE RILIEVI DEL CONFRONTO CIECO che vivono in QUESTA pagina (2026-09-02).
 *
 * Due critici di design hanno esaminato la schermata separatamente, senza sapere
 * quale delle due del percorso fosse nuova, e sono arrivati agli stessi tre punti
 * misurando i pixel ognuno per conto suo.
 */
describe('/auth/nuova-password — il marchio, dove si digita un segreto', () => {
  it('il logo Kidville c’è, e sta SOPRA la card', () => {
    // «Il genitore arriva da un'email, con una password copiata da quell'email, e
    // la schermata che gliela chiede è l'unica senza il logo della scuola: è lo
    // schema esatto di una pagina di phishing.» L'àncora d'identità si toglie da
    // tutte le schermate o da nessuna — e comunque MAI da quella in cui si scrive
    // una password.
    const { container } = renderPagina()
    const logo = screen.getByAltText('Kidville') as HTMLImageElement
    expect(logo.getAttribute('src') ?? '', 'il logo non punta al file del marchio').toMatch(/logo-kidville/)

    const card = container.querySelector('main') as HTMLElement
    expect(card, 'la card non c’è più: la sonda guarda la cosa sbagliata').toBeTruthy()
    expect(logo.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('CONTROLLO POSITIVO — la sonda non scambia una decorazione per il marchio', () => {
    // Lo sfondo `SfondoAuth` è pieno di `<svg>` `aria-hidden`: se il rilevatore
    // guardasse «una qualunque immagine», sarebbe verde anche senza logo.
    const { container } = renderPagina()
    expect(container.querySelectorAll('img[alt="Kidville"]').length).toBe(1)
  })
})

describe('/auth/nuova-password — «Non ora» pesa meno, e resta ovvio', () => {
  const nonOra = () => screen.getByRole('button', { name: new RegExp(P.interstizialeNonOra, 'i') })

  it('non è un secondo primario: né a piena larghezza, né riempito di verde', () => {
    // Stessa larghezza e stessa altezza dell'azione richiesta significa DUE
    // primari: chi arriva confuso trova una via d'uscita larga quanto la cosa da
    // fare, e l'obiettivo fallisce in silenzio.
    renderPagina()
    const classi = nonOra().className
    expect(classi, '«Non ora» è ancora a piena larghezza').not.toMatch(/\bw-full\b/)
    expect(classi, '«Non ora» è ancora riempito col verde del primario').not.toMatch(/\bbg-kidville-green\b/)
    // …e resta ovvio: sottolineato (mai il solo colore, WCAG 1.4.1) e raggiungibile.
    expect(classi, '«Non ora» è distinguibile solo dal colore').toMatch(/\bunderline\b/)
    expect(nonOra()).toBeVisible()
  })

  it('l’azione richiesta resta la più pesante della schermata', () => {
    renderPagina()
    const salva = document.querySelector('button[type="submit"]') as HTMLButtonElement
    expect(salva.className, 'il comando di salvataggio non è più il bottone alto').toMatch(/(?:^|\s)h-\[54px\](?:\s|$)/)
    expect(nonOra().className, '«Non ora» ha ancora l’altezza di un bottone pieno').not.toMatch(/(?:^|\s)h-\[(?:46|54)px\](?:\s|$)/)
  })

  it('la nota PRECEDE il comando, e gli è legata da `aria-describedby`', () => {
    // Chi usa uno screen reader, con la nota dopo il bottone, ATTIVA il comando
    // prima di sentirne la conseguenza.
    renderPagina()
    const nota = screen.getByText(P.interstizialeNonOraNota)
    expect(
      nota.compareDocumentPosition(nonOra()) & Node.DOCUMENT_POSITION_FOLLOWING,
      'la nota sta ancora DOPO il bottone',
    ).toBeTruthy()
    const descritto = (nonOra().getAttribute('aria-describedby') ?? '').split(/\s+/)
    expect(descritto, 'il bottone non nomina la nota').toContain(nota.id)
    expect(nota.id, 'la nota non ha un id da nominare').toBeTruthy()
  })
})

describe('/auth/nuova-password — lo stesso linguaggio visivo della login', () => {
  it('lo sfondo decorativo c’è in contrasto normale…', () => {
    const { container } = renderPagina(false)
    expect(container.querySelector('[aria-hidden="true"] svg')).toBeTruthy()
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(3)
  })

  it('…e sparisce in Alto Contrasto, dove i colori pieni sarebbero rumore', () => {
    const { container } = renderPagina(true)
    const normale = renderPagina(false).container
    expect(container.querySelectorAll('svg').length).toBeLessThan(normale.querySelectorAll('svg').length)
  })
})

describe('/auth/nuova-password — i testi esistono in entrambe le lingue', () => {
  it('occhiello, titolo, intro e «Non ora» sono tradotti, e non copiati dall’italiano', () => {
    for (const chiave of [
      'interstizialeOcchiello',
      'interstizialeTitolo',
      'interstizialeIntro',
      'interstizialeNonOra',
      'labelAttualeTemporanea',
    ] as const) {
      expect(P[chiave]?.trim(), `manca ${chiave} in italiano`).toBeTruthy()
      expect(EN_P[chiave]?.trim(), `manca ${chiave} in inglese`).toBeTruthy()
      expect(EN_P[chiave], `${chiave}: l’inglese è un copia-incolla dell’italiano`).not.toBe(P[chiave])
    }
  })
})
