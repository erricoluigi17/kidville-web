import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { CampoSottoAppBar } from '@/components/features/parent/CampoSottoAppBar'

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

function shell(campo: 'textarea' | 'input' | 'fuori') {
  const radice = document.createElement('div')
  radice.setAttribute('data-kv-shell', '')
  const barra = document.createElement('header')
  barra.className = 'kv-appbar'
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

  it('smontandosi non lascia ascoltatori appesi', () => {
    const { unmount } = render(<CampoSottoAppBar />)
    expect(ascoltatoriResize.length).toBeGreaterThan(0)
    unmount()
    expect(ascoltatoriResize.length).toBe(0)
  })
})
