import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { ChunkErrorBoundary } from '@/components/providers/ChunkErrorBoundary'

/**
 * T07-F2 — «quando un chunk non arriva, l'utente resta su Caricamento… per sempre».
 *
 * Il rilievo dice UNA cosa sola, e va provata come comportamento: al fallimento
 * di una risorsa sotto `/_next/static/` l'utente deve vedere un invito a
 * ricaricare, e il bottone deve ricaricare davvero.
 *
 * ─── PERCHÉ QUESTO TEST NON PUÒ ESSERE VERDE PER SBAGLIO ───────────────────
 * L'evento `error` di una risorsa NON fa bubbling: dispatcharlo su uno
 * `<script>` attaccato al documento raggiunge `window` solo attraverso la fase
 * di CATTURA. Il test lo spara così — su un elemento vero, senza forzare il
 * bersaglio — quindi vede esattamente ciò che vede il browser: se il gestore
 * fosse registrato senza `{ capture: true }` (cioè come lo era il listener
 * dell'osservabilità, riga 643 di `src/lib/logging/client.ts`), il pannello non
 * comparirebbe e questo file diventerebbe rosso. È la manomissione con cui è
 * stato validato.
 *
 * Il caso NEGATIVO conta quanto quello positivo: una risorsa qualunque che
 * fallisce (un'immagine, uno script di terze parti) NON è il programma che
 * manca, e coprire la pagina con un invito a ricaricare sarebbe un difetto
 * nuovo — più visibile di quello che si voleva chiudere.
 */

/** Uno `<script>` vero, attaccato al documento, che fallisce come nel browser. */
function scriptCheFallisce(src: string): void {
  const s = document.createElement('script')
  s.src = src
  document.body.appendChild(s)
  act(() => {
    // `bubbles: false` è la forma REALE dell'evento: se il componente non
    // ascoltasse in cattura, questo non arriverebbe mai a `window`.
    s.dispatchEvent(new Event('error', { bubbles: false }))
  })
  s.remove()
}

const PANNELLO = 'chunk-error'

describe('ChunkErrorBoundary — il chunk che non arriva', () => {
  beforeEach(() => {
    document.cookie = 'KV_LOCALE=; Max-Age=0; path=/'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('finché non fallisce niente, non dipinge nulla', () => {
    const { container } = render(<ChunkErrorBoundary />)
    expect(container).toBeEmptyDOMElement()
  })

  it('uno script del bundle che non arriva mostra l’invito a ricaricare', () => {
    render(<ChunkErrorBoundary />)
    expect(screen.queryByTestId(PANNELLO)).toBeNull()

    scriptCheFallisce('http://localhost:3000/_next/static/chunks/app/parent/page-9f2.js')

    const pannello = screen.getByTestId(PANNELLO)
    expect(pannello).toBeInTheDocument()
    // È un annuncio, non un riquadro decorativo: deve essere letto da subito.
    expect(pannello).toHaveAttribute('role', 'alertdialog')
    expect(screen.getByRole('button', { name: /ricarica la pagina/i })).toBeInTheDocument()
  })

  it('anche un CSS del bundle (link href) conta come programma mancante', () => {
    render(<ChunkErrorBoundary />)
    const l = document.createElement('link')
    l.rel = 'stylesheet'
    l.href = 'http://localhost:3000/_next/static/css/8ab.css'
    document.body.appendChild(l)
    act(() => {
      l.dispatchEvent(new Event('error', { bubbles: false }))
    })
    l.remove()

    expect(screen.getByTestId(PANNELLO)).toBeInTheDocument()
  })

  it('una risorsa che NON è del bundle non copre la pagina', () => {
    render(<ChunkErrorBoundary />)

    scriptCheFallisce('https://cdn.esterno.example/analytics.js')
    const img = document.createElement('img')
    img.src = 'http://localhost:3000/uploads/foto.jpg'
    document.body.appendChild(img)
    act(() => {
      img.dispatchEvent(new Event('error', { bubbles: false }))
    })
    img.remove()

    expect(screen.queryByTestId(PANNELLO)).toBeNull()
  })

  it('un import() dinamico fallito (ChunkLoadError) mostra lo stesso invito', () => {
    render(<ChunkErrorBoundary />)

    const errore = new Error('Loading chunk app/parent/pagamenti failed.')
    errore.name = 'ChunkLoadError'
    act(() => {
      // jsdom non costruisce `PromiseRejectionEvent`: si usa un `Event` con
      // `reason` agganciato, che è ciò che il gestore legge.
      const e = Object.assign(new Event('unhandledrejection'), { reason: errore })
      window.dispatchEvent(e)
    })

    expect(screen.getByTestId(PANNELLO)).toBeInTheDocument()
  })

  it('una promise rifiutata QUALUNQUE non fa comparire il pannello', () => {
    render(<ChunkErrorBoundary />)
    act(() => {
      const e = Object.assign(new Event('unhandledrejection'), {
        reason: new Error('Failed to fetch'),
      })
      window.dispatchEvent(e)
    })
    expect(screen.queryByTestId(PANNELLO)).toBeNull()
  })

  it('il bottone ricarica davvero la pagina', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload, pathname: '/parent' },
    })

    render(<ChunkErrorBoundary />)
    scriptCheFallisce('http://localhost:3000/_next/static/chunks/main-app.js')

    fireEvent.click(screen.getByRole('button', { name: /ricarica la pagina/i }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('col cookie KV_LOCALE=en il messaggio è in inglese', () => {
    document.cookie = 'KV_LOCALE=en; path=/'
    render(<ChunkErrorBoundary />)
    scriptCheFallisce('http://localhost:3000/_next/static/chunks/main-app.js')

    expect(screen.getByRole('button', { name: /reload the page/i })).toBeInTheDocument()
    expect(screen.getByTestId(PANNELLO)).toHaveAttribute('lang', 'en')
  })

  it('il focus finisce sul bottone: chi usa la tastiera non deve cercarlo', () => {
    render(<ChunkErrorBoundary />)
    scriptCheFallisce('http://localhost:3000/_next/static/chunks/main-app.js')

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /ricarica la pagina/i }))
  })

  it('una cascata di chunk mancanti resta UN solo pannello', () => {
    render(<ChunkErrorBoundary />)
    scriptCheFallisce('http://localhost:3000/_next/static/chunks/a.js')
    scriptCheFallisce('http://localhost:3000/_next/static/chunks/b.js')
    scriptCheFallisce('http://localhost:3000/_next/static/chunks/c.js')

    expect(screen.getAllByTestId(PANNELLO)).toHaveLength(1)
  })
})
