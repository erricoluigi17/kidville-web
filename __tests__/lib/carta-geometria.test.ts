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

  it('riserva alla segnatura di protocollo l’aria fra il marchio e il contenuto', () => {
    // La segnatura NON è una fascia in testa al foglio: quella cadrebbe sopra il marchio
    // della scuola, che è il difetto n. 1 della specifica. Sta nell'aria che
    // `contenutoInizio` già lascia sotto il logo — 26,8 → 40 — e nessun motore ci scrive
    // dentro, perché `contenutoInizio` è per definizione dove l'app comincia.
    expect(CARTA.segnaturaRiga).toBeGreaterThan(CARTA.brandFine)
    expect(CARTA.segnaturaRiga).toBeLessThan(CARTA.contenutoInizio)
    // Sopra la linea di scrittura ci va il corpo del carattere: 8 pt sono 2,8 mm.
    expect(CARTA.segnaturaRiga - CARTA.brandFine).toBeGreaterThanOrEqual(3)
  })

  it('i margini laterali stanno qui, e non in una seconda copia dentro ogni motore', () => {
    expect(CARTA.margineSx).toBeGreaterThan(0)
    expect(CARTA.margineDx).toBeLessThan(CARTA.larghezzaPagina)
    expect(CARTA.margineDx - CARTA.margineSx).toBe(166)
  })

  it('resta un foglio A4, e le misure stanno tutte dentro', () => {
    expect(CARTA.altezzaPagina).toBe(297)
    expect(CARTA.larghezzaPagina).toBe(210)
    expect(CARTA.piedeFine).toBeLessThan(CARTA.altezzaPagina)
    expect(CARTA.brandInizio).toBeGreaterThan(0)
  })
})
