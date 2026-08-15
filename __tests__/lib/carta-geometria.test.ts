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

  it('lascia aria anche fra il fondo del contenuto e le LETTERE della riga di servizio', () => {
    // ⚠️ Il difetto che questo test esiste per impedire, misurato il 2026-08-15 su pagina 2
    // di un certificato reale: il riquadro di verifica chiudeva a 266,00 mm e «Pagina 2 di
    // 2» cominciava a 266,73 — **0,73 mm**, cioè si toccavano a occhio. Sulla stampa di
    // sezione era peggio: il filetto dell'ultima riga di tabella a 265,5 e la riga
    // «Riservato — dati di minori · …» a 266,8, che sembrava una riga della tabella.
    //
    // La causa non era un errore di calcolo: `contenutoFine` valeva 266 e la testata di
    // questo file prometteva che i millimetri fra lui e il piede stampato bastassero
    // «perché dentro ci sta rigaServizio». Non bastavano: `rigaServizio` è la LINEA DI
    // SCRITTURA, e le maiuscole di 7 pt cominciano 2,47 mm più su. Un documento che
    // descrive una protezione che non c'è è la classe di difetto che questo progetto
    // chiama incidente.
    const ALTEZZA_MAIUSCOLA_7PT = 7 * 0.716 * (25.4 / 72) // ≈ 2,47 mm
    const cimaRigaServizio = CARTA.rigaServizio - ALTEZZA_MAIUSCOLA_7PT
    expect(cimaRigaServizio - CARTA.contenutoFine).toBeGreaterThanOrEqual(2)
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
