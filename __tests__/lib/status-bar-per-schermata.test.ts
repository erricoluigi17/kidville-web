/**
 * Q31 — LA BARRA DI STATO ERA DECISA UNA VOLTA SOLA, ALL'AVVIO.
 *
 * `setupNativeShell` chiamava `StatusBar.setStyle({ style: Style.Dark })` —
 * «icone CHIARE» — e ci metteva sotto il verde con `setBackgroundColor`. Con
 * `targetSdk 36` Android impone l'edge-to-edge: `setOverlaysWebView({overlay:
 * false})` e `setBackgroundColor` non hanno effetto, e dietro la barra si vede
 * il fondo della PAGINA. Sulle schermate con l'AppBar verde il caso va bene per
 * coincidenza; sulla login, che è crema, le icone bianche spariscono.
 *
 * Misura sull'emulatore (KV-play-phone, 1080×1920, 2026-08-08):
 *   fondo barra di stato   (254, 241, 228)  ← #FEF1E4, il crema della pagina
 *   pixel più chiaro (ora) (255, 255, 255)
 *   contrasto              1,11:1
 * contro il 6,51:1 delle pagine interne, dove la barra è verde.
 *
 * ─── PERCHÉ UNA MISURA E NON UN ELENCO DI ROTTE ─────────────────────────────
 *
 * L'elenco delle schermate «chiare» invecchia al primo percorso nuovo, ed è la
 * forma esatta del difetto che questo ciclo continua a incontrare: la regola
 * scritta in un posto che nessuno aggiorna. Qui la domanda la si fa al DOM —
 * «c'è una barra di brand incollata in cima?» — che è la stessa condizione da
 * cui dipende il colore che si vede davvero.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { barraDiBrandInCima } from '@/lib/mobile/status-bar'

function barra(classe: string, top: number, bottom: number) {
  const el = document.createElement('header')
  el.className = classe
  el.getBoundingClientRect = () =>
    ({ top, bottom, height: bottom - top, left: 0, right: 390, width: 390, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('barraDiBrandInCima', () => {
  it('AppBar di genitore/docente incollata in cima → sì', () => {
    barra('kv-appbar sticky top-0 bg-kidville-green', 0, 82)
    expect(barraDiBrandInCima(document)).toBe(true)
  })

  it('topbar del cockpit → sì (è verde uguale, ha solo un’altra classe)', () => {
    barra('kv-admin-topbar kv-appbar-admin', 0, 74)
    expect(barraDiBrandInCima(document)).toBe(true)
  })

  it('login: nessuna barra → no, e le icone dovranno essere SCURE', () => {
    expect(barraDiBrandInCima(document)).toBe(false)
  })

  it('una barra che sta più in basso non copre la fascia di sistema', () => {
    // Una barra a metà pagina non è ciò che si vede dietro l'orologio.
    barra('kv-appbar', 200, 282)
    expect(barraDiBrandInCima(document)).toBe(false)
  })

  it('una barra già uscita dallo schermo non conta', () => {
    barra('kv-appbar', -90, -8)
    expect(barraDiBrandInCima(document)).toBe(false)
  })
})
