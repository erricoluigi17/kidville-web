// @vitest-environment node
/**
 * La scelta «stringo l'aria o apro un foglio nuovo?», misurata sui numeri veri dei due
 * motori che la compiono.
 *
 * Esiste perché fino al 2026-08-16 quella scelta stava scritta in due posti e i due
 * divergevano: `prestampati/impaginazione.ts` stringeva lo stacco prima di aprire una
 * pagina, `protocolli/documento-pdf.ts` no. Un lock sulla funzione comune è ciò che
 * impedisce alla terza copia di nascere.
 */
import { describe, it, expect } from 'vitest'
import { quotaBloccoFinale } from '@/lib/carta/blocco-finale'
import { CARTA } from '@/lib/carta/geometria'

/** I numeri del motore dei protocolli: stacco 18, minimo 5, mai sopra 150, blocco alto 14. */
const PROTOCOLLI = {
  stacco: 18,
  staccoMinimo: 5,
  quotaMinima: 150,
  tetto: CARTA.contenutoFine - 14,
}

describe('quotaBloccoFinale', () => {
  it('con aria in abbondanza usa lo stacco pieno', () => {
    expect(quotaBloccoFinale({ ...PROTOCOLLI, dopoIlContenuto: 100 })).toEqual({
      y: 150,
      paginaNuova: false,
    })
    expect(quotaBloccoFinale({ ...PROTOCOLLI, dopoIlContenuto: 180 })).toEqual({
      y: 198,
      paginaNuova: false,
    })
  })

  it("quando lo stacco pieno sfonda, stringe e si appoggia al tetto invece di aprire un foglio", () => {
    // Il caso misurato sul documento vero: corpo che chiude a 237.
    //   pieno    → max(237 + 18, 150) = 255 > 249,5  → non ci sta
    //   stretto  → max(237 +  5, 150) = 242 ≤ 249,5  → ci sta, e allora si scende al tetto
    const scelta = quotaBloccoFinale({ ...PROTOCOLLI, dopoIlContenuto: 237 })
    expect(scelta).toEqual({ y: PROTOCOLLI.tetto, paginaNuova: false })
    // E l'aria che resta è comunque ≥ dello stacco minimo: il blocco non risale MAI sopra
    // il contenuto per farcelo stare.
    expect(scelta.y - 237).toBeGreaterThanOrEqual(PROTOCOLLI.staccoMinimo)
  })

  it('apre la pagina nuova solo quando nemmeno lo stacco minimo basta', () => {
    // 245 + 5 = 250 > 249,5: qui il foglio nuovo è l'unica risposta onesta.
    expect(quotaBloccoFinale({ ...PROTOCOLLI, dopoIlContenuto: 245 })).toEqual({
      y: 150,
      paginaNuova: true,
    })
  })

  it('sulla pagina nuova non scende mai sotto il tetto né sale sopra l’inizio del foglio', () => {
    // Un blocco altissimo abbassa il tetto sopra `quotaMinima`: vince il tetto.
    const tettoAlto = quotaBloccoFinale({
      ...PROTOCOLLI,
      tetto: 120,
      dopoIlContenuto: 200,
    })
    expect(tettoAlto).toEqual({ y: 120, paginaNuova: true })

    // …ma mai sopra il punto in cui il foglio nuovo comincia a essere scrivibile.
    const tettoImpossibile = quotaBloccoFinale({
      ...PROTOCOLLI,
      tetto: 10,
      dopoIlContenuto: 200,
      inizioPagina: CARTA.contenutoInizio,
    })
    expect(tettoImpossibile).toEqual({ y: CARTA.contenutoInizio, paginaNuova: true })
  })

  it('rispetta un `inizioPagina` diverso da `contenutoInizio`', () => {
    // È il caso dei prestampati, che ristampano una testata compatta in cima a ogni foglio
    // e riprendono a scrivere più in basso.
    expect(
      quotaBloccoFinale({ ...PROTOCOLLI, tetto: 60, dopoIlContenuto: 240, inizioPagina: 72 })
    ).toEqual({ y: 72, paginaNuova: true })
  })

  it('uno stacco minimo più largo di quello pieno non peggiora la scelta', () => {
    // Sarebbe una svista di chi chiama: `staccoMinimo` più largo di `stacco` non deve
    // spingere il blocco più in basso di quanto farebbe senza «compressione» — cioè non
    // deve costare un foglio che l'aria piena non costava già.
    const invertito = quotaBloccoFinale({ ...PROTOCOLLI, staccoMinimo: 40, dopoIlContenuto: 237 })
    const pari = quotaBloccoFinale({
      ...PROTOCOLLI,
      staccoMinimo: PROTOCOLLI.stacco,
      dopoIlContenuto: 237,
    })
    expect(invertito).toEqual(pari)
  })
})
