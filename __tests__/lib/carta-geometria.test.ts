// @vitest-environment node
/**
 * Le misure della carta intestata, in un posto solo.
 *
 * Rilievo a 150 dpi sul rendering del PDF reale, non stimato a occhio: il marchio finisce
 * a 26,8 mm, il piede stampato comincia a 272,1 mm. Fra i due c'è tutto quello che l'app
 * può scrivere — e i due numeri che contano davvero sono quelli, perché un contenuto che
 * li supera non «sta un po' stretto»: cade SOPRA il logo della scuola o dentro l'elenco
 * delle tre sedi, e quello è il foglio che una famiglia porta a un ente.
 */
import { describe, it, expect } from 'vitest'
import { CARTA } from '@/lib/carta/geometria'

describe('geometria della carta intestata', () => {
  it('conosce dove sta il marchio e dove sta il piede', () => {
    expect(CARTA.brandInizio).toBeCloseTo(12.5, 1)
    expect(CARTA.brandFine).toBeCloseTo(26.8, 1)
    expect(CARTA.piedeInizio).toBeCloseTo(272.1, 1)
    expect(CARTA.piedeFine).toBeCloseTo(285.0, 1)
  })

  it("l'area libera non tocca né il marchio né il piede", () => {
    expect(CARTA.contenutoInizio).toBeGreaterThan(CARTA.brandFine)
    expect(CARTA.contenutoFine).toBeLessThan(CARTA.piedeInizio)
  })

  it('lascia almeno 5 mm di aria sopra il piede stampato', () => {
    expect(CARTA.piedeInizio - CARTA.contenutoFine).toBeGreaterThanOrEqual(5)
  })

  it('la riga di servizio sta fra il contenuto e il piede della carta, non dentro nessuno dei due', () => {
    // Il piede dell'app — «Riservato — dati di minori · data · nome» e «Pagina n di m» —
    // stava a y=287, cioè DENTRO il piede a quattro colonne della carta (272,1→285,0).
    expect(CARTA.rigaServizio).toBeGreaterThan(CARTA.contenutoFine)
    expect(CARTA.rigaServizio).toBeLessThan(CARTA.piedeInizio)
  })

  it('resta un foglio A4, e le misure stanno tutte dentro', () => {
    expect(CARTA.altezzaPagina).toBe(297)
    expect(CARTA.larghezzaPagina).toBe(210)
    expect(CARTA.piedeFine).toBeLessThan(CARTA.altezzaPagina)
    expect(CARTA.brandInizio).toBeGreaterThan(0)
  })
})
