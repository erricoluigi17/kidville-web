import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { CampoSottoAppBar } from '@/components/features/shell/CampoSottoAppBar'

/**
 * LOCK · con la tastiera aperta il campo a fuoco non finisce sotto l'AppBar.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Misura CDP sulla WebView Android viva (2026-08-08), campo «Motivo
 * (facoltativo)» di /parent/attendance, subito dopo aver digitato «aaa»:
 *   {"scrollY":499,"taTop":0,"taBottom":112,"appbarBottom":82,
 *    "copertoPx":82,"altezzaCampo":112,"scrollMarginTop":"82px"}
 * cioè **82 px su 112 (73%) coperti**, ne restavano visibili 30, e il testo
 * digitato NON si vedeva affatto: compariva solo nella barra dei suggerimenti
 * della tastiera. È il campo che porta la nota di natura sanitaria del minore:
 * il genitore non poteva rileggere né correggere quello che stava scrivendo.
 *
 * La difesa scelta dall'app era `scroll-margin-top: var(--kv-appbar-h)` sui
 * campi della shell (globals.css). È applicata davvero — misurato,
 * `getComputedStyle(ta).scrollMarginTop === "82px"` — ma lo scorrimento che
 * Chromium esegue quando la tastiera riduce la viewport visuale (731 → 399 px
 * CSS) NON onora `scroll-margin`: porta `scrollY` esattamente all'offset di
 * documento del campo, cioè lo allinea a `top: 0`, che è sotto un header sticky
 * alto 82 px. La difesa viveva in una proprietà che quel percorso di
 * scorrimento ignora, e non c'era modo di accorgersene a occhio.
 *
 * Qui l'app compensa da sé, e si misura ciò che il collaudo misurava:
 * `getBoundingClientRect().top` del campo attivo contro il bordo inferiore
 * dell'AppBar.
 */

/** L'AppBar sticky, alta 82 px come sull'emulatore (58 + 24 di safe-area). */
const ALTEZZA_APPBAR = 82

function shell(campo: 'textarea' | 'input' | 'fuori', classeBarra = 'kv-appbar') {
  const radice = document.createElement('div')
  radice.setAttribute('data-kv-shell', '')
  const barra = document.createElement('header')
  barra.className = classeBarra
  barra.getBoundingClientRect = () =>
    ({ top: 0, bottom: ALTEZZA_APPBAR, height: ALTEZZA_APPBAR, left: 0, right: 390, width: 390, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  radice.appendChild(barra)

  const el = document.createElement(campo === 'input' ? 'input' : 'textarea')
  if (campo === 'fuori') document.body.appendChild(el)
  else radice.appendChild(el)
  document.body.appendChild(radice)
  return { radice, el }
}

/** Fa credere al campo di stare a `top` px dal bordo alto della viewport. */
function posiziona(el: HTMLElement, top: number, altezza = 112) {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + altezza, height: altezza, left: 0, right: 390, width: 390, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
}

let scrollBy: ReturnType<typeof vi.fn>
let viewport: { addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void }
let ascoltatoriResize: Array<() => void>

beforeEach(() => {
  vi.useFakeTimers()
  scrollBy = vi.fn()
  vi.stubGlobal('scrollBy', scrollBy)
  ascoltatoriResize = []
  viewport = {
    addEventListener: (t, f) => { if (t === 'resize') ascoltatoriResize.push(f) },
    removeEventListener: (t, f) => { ascoltatoriResize = ascoltatoriResize.filter((x) => x !== f) },
  }
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true, writable: true })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** La tastiera si apre: fuoco sul campo, poi la viewport si accorcia. */
function apriTastiera(el: HTMLElement) {
  el.focus()
  fireEvent.focusIn(el)
  for (const f of ascoltatoriResize) f()
  vi.runAllTimers()
}

/**
 * LA SEQUENZA VERA DEL DITO, che è un'altra cosa (rilievo Q30).
 *
 * `apriTastiera` comprime tutto in un istante solo: fuoco, ridimensionamento e
 * timer. Sul telefono i tre momenti sono separati da centinaia di millisecondi,
 * e fra il primo e il secondo il timer del componente SCADE — con la tastiera
 * ancora chiusa e il campo ancora al suo posto. È lì che il difetto vive.
 *
 *  1. il dito tocca il campo → `focusin`, viewport ancora alta, campo a 223 px;
 *  2. passano più di RITARDO_MS: il componente misura, non trova niente da
 *     correggere;
 *  3. SOLO ADESSO la tastiera si apre, Chromium riallinea il campo a `top: 0` e
 *     `visualViewport` emette `resize` — l'unico momento in cui il difetto esiste;
 *  4. si aspetta di nuovo.
 */
function apriTastieraComeSulTelefono(el: HTMLElement, topPrima: number, topDopo: number) {
  posiziona(el, topPrima)
  el.focus()
  fireEvent.focusIn(el)
  vi.advanceTimersByTime(400)
  posiziona(el, topDopo)
  for (const f of ascoltatoriResize) f()
  vi.runAllTimers()
}

describe('la tastiera non nasconde il campo dietro l’AppBar', () => {
  it('CONTROLLO POSITIVO: un campo già sotto la barra non fa scorrere niente', () => {
    render(<CampoSottoAppBar />)
    const { el } = shell('textarea')
    posiziona(el, 232) // com'era col tap più in basso: `coperto: 0`
    apriTastiera(el)
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('il campo allineato a top:0 viene riportato SOTTO la barra', () => {
    render(<CampoSottoAppBar />)
    const { el } = shell('textarea')
    // La misura del collaudo: Chromium allinea il campo a `top: 0`, cioè 82 px
    // dentro l'AppBar — il 73% di un campo alto 112.
    posiziona(el, 0)
    apriTastiera(el)

    expect(
      scrollBy,
      '`scroll-margin-top` da solo non basta su Android WebView: lo scorrimento che Chromium ' +
        'esegue all’apertura della tastiera lo ignora, e il campo resta 82 px sotto la barra ' +
        'verde. Il testo che il genitore sta digitando non si vede affatto.',
    ).toHaveBeenCalledWith(0, -ALTEZZA_APPBAR)
  })

  it('scorre solo di quanto serve, non di un’altezza fissa', () => {
    render(<CampoSottoAppBar />)
    const { el } = shell('input')
    posiziona(el, 50, 50) // metà coperto
    apriTastiera(el)
    expect(scrollBy).toHaveBeenCalledWith(0, -32)
  })

  it('un campo FUORI dalla shell non viene toccato', () => {
    render(<CampoSottoAppBar />)
    const { el } = shell('fuori')
    posiziona(el, 0)
    apriTastiera(el)
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('senza AppBar in pagina non c’è niente da compensare', () => {
    render(<CampoSottoAppBar />)
    const radice = document.createElement('div')
    radice.setAttribute('data-kv-shell', '')
    const el = document.createElement('textarea')
    radice.appendChild(el)
    document.body.appendChild(radice)
    posiziona(el, 0)
    apriTastiera(el)
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('se nel frattempo il fuoco è andato altrove, non si scorre a sorpresa', () => {
    render(<CampoSottoAppBar />)
    const { el, radice } = shell('textarea')
    posiziona(el, 0)
    el.focus()
    fireEvent.focusIn(el)
    // L'utente chiude la tastiera / tocca altrove prima che la compensazione parta.
    const altro = document.createElement('button')
    radice.appendChild(altro)
    altro.focus()
    for (const f of ascoltatoriResize) f()
    vi.runAllTimers()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Q30 — LA SEQUENZA REALE, CHE È QUELLA CHE IL COMPONENTE SBAGLIAVA.
  //
  // Misura CDP sull'emulatore, subito dopo il tocco (3 volte su 3, identica):
  //   PRIMA : {"top":223,"bottom":335,"vvH":731}
  //   DOPO  : {"attivo":"TEXTAREA","top":0,"bottom":112,"vvH":399}
  //   stato : {"kvAppbarBottom":82,"scrollY":539,"scrollMaxY":649}
  // cioè 82 px su 112 coperti, con la pagina che POTEVA ancora scorrere: la
  // compensazione non è avvenuta. Il componente funzionava solo se il fuoco
  // arrivava a tastiera GIÀ aperta — cioè mai, nel gesto reale.
  // ───────────────────────────────────────────────────────────────────────────
  it('fuoco a tastiera CHIUSA, poi la tastiera si apre: la compensazione arriva lo stesso', () => {
    render(<CampoSottoAppBar />)
    const { el } = shell('textarea')
    apriTastieraComeSulTelefono(el, 223, 0)
    expect(
      scrollBy,
      'il ritardo scadeva con la tastiera ancora chiusa, il campo era a 223 ≥ 82 e non c’era ' +
        'niente da correggere: uscendo, il componente dimenticava il campo. Quando poi la ' +
        'tastiera si apriva e Chromium lo riallineava a top:0 — l’unico istante in cui il ' +
        'difetto esiste — non restava più niente da riportare in vista.',
    ).toHaveBeenCalledWith(0, -ALTEZZA_APPBAR)
  })

  it('e se la tastiera NON copre niente, non si scorre lo stesso', () => {
    // Controllo positivo della sequenza vera: senza questo, un componente che
    // scorre sempre passerebbe il test qui sopra.
    render(<CampoSottoAppBar />)
    const { el } = shell('textarea')
    apriTastieraComeSulTelefono(el, 223, 200)
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('più aperture di seguito: ogni volta si ricomincia a misurare', () => {
    render(<CampoSottoAppBar />)
    const { el } = shell('textarea')
    apriTastieraComeSulTelefono(el, 223, 0)
    scrollBy.mockClear()
    // La tastiera si richiude e si riapre senza che il fuoco cambi: è il caso
    // della rotazione e del suggeritore che si apre e chiude.
    posiziona(el, 0)
    for (const f of ascoltatoriResize) f()
    vi.runAllTimers()
    expect(scrollBy).toHaveBeenCalledWith(0, -ALTEZZA_APPBAR)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // LA STESSA FORMA SULLE ALTRE DUE STRADE.
  //
  // Il componente viveva sotto `features/parent` ed era montato SOLO nel layout
  // del genitore. Il suo stesso commento diceva «quando anche i layout docente e
  // cockpit lo adotteranno va spostato in features/shell» — cioè la lezione era
  // scritta in un commento invece che nel codice, che è la forma che questo
  // ciclo ha già pagato tre volte. Le tre shell hanno `[data-kv-shell]` e una
  // barra sticky in cima: docente e genitore la stessa (`.kv-appbar`,
  // `features/shell/AppBar`), il cockpit la sua (`.kv-appbar-admin`).
  // ───────────────────────────────────────────────────────────────────────────
  it('vale anche per la barra del cockpit, che ha una classe sua', () => {
    render(<CampoSottoAppBar />)
    const { el } = shell('textarea', 'kv-admin-topbar kv-appbar-admin')
    apriTastieraComeSulTelefono(el, 223, 0)
    expect(scrollBy).toHaveBeenCalledWith(0, -ALTEZZA_APPBAR)
  })

  it('con due barre in pagina vince la più BASSA: è quella che copre davvero', () => {
    render(<CampoSottoAppBar />)
    const { radice, el } = shell('textarea')
    const seconda = document.createElement('header')
    seconda.className = 'kv-appbar-admin'
    seconda.getBoundingClientRect = () =>
      ({ top: 0, bottom: 120, height: 120, left: 0, right: 390, width: 390, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    radice.insertBefore(seconda, radice.firstChild)
    apriTastieraComeSulTelefono(el, 223, 0)
    expect(scrollBy).toHaveBeenCalledWith(0, -120)
  })

  it('smontandosi non lascia ascoltatori appesi', () => {
    const { unmount } = render(<CampoSottoAppBar />)
    expect(ascoltatoriResize.length).toBeGreaterThan(0)
    unmount()
    expect(ascoltatoriResize.length).toBe(0)
  })
})

describe('LOCK · le shell che hanno la barra sticky lo montano tutte', () => {
  it('genitore, docente e cockpit: nessuna resta indietro', async () => {
    // Il difetto è stato misurato sul genitore e per un giorno il rimedio è
    // vissuto solo lì, con «quando anche i layout docente e cockpit lo
    // adotteranno» scritto in un commento. Un commento non monta un componente.
    const { readFileSync } = await import('node:fs')
    const shell = ['parent', 'teacher', 'admin']
    const senza = shell.filter(
      (area) => !readFileSync(`src/app/(dashboard)/${area}/layout.tsx`, 'utf8').includes('<CampoSottoAppBar />'),
    )
    expect(
      senza,
      'ogni shell con [data-kv-shell] ha una barra sticky in cima e i suoi moduli: ' +
        'la compensazione della tastiera vale per tutte e tre o per nessuna',
    ).toEqual([])
  })
})
