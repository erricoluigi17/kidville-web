import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Lock a11y della Riconciliazione lato CSS (globals.css). Le regole di colore/focus
 * non sono testabili in DOM (jsdom non calcola il contrasto), ma la LORO PRESENZA sì:
 * qui si blocca la regressione dei findings A2 (testo «suggerito» invisibile in Alto
 * Contrasto) e A3 (anello di focus invisibile sui controlli a fondo pieno).
 */
const css = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8')

describe('globals.css — a11y Riconciliazione', () => {
  it('A2: in Alto Contrasto la riga «suggerito» schiarisce ESPLICITAMENTE il testo dei discendenti', () => {
    // Il box diventa nero: il testo `text-kidville-ink` (inlinato scuro da @theme inline)
    // va forzato a un colore chiaro, altrimenti sparisce sul fondo nero.
    expect(css).toMatch(
      /\[data-contrast="high"\][^{]*\.kv-recon-row--suggerito\s+\.text-kidville-ink\s*\{[^}]*color:\s*#(?:FFFFFF|FFF)\b/i,
    )
  })

  it('A3: il :focus-visible globale ha colore verde ESPLICITO (non solo var) e uno stacco visibile', () => {
    // La regola globale sta su una riga che inizia con `:focus-visible {`
    // (quella HC è `[data-contrast="high"] *:focus-visible`, esclusa dal match).
    const m = css.match(/\n:focus-visible\s*\{([\s\S]*?)\}/)
    expect(m, 'regola :focus-visible globale presente').toBeTruthy()
    const block = m![1]
    expect(block).toMatch(/#006A5F/i)
    expect(block).toMatch(/box-shadow/)
  })
})
