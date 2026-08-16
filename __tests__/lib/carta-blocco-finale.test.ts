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
import {
  RIGHE_MINIME_IN_CODA,
  codaVuoleUnFoglioNuovo,
  quotaBloccoFinale,
} from '@/lib/carta/blocco-finale'
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

describe('codaVuoleUnFoglioNuovo', () => {
  /**
   * ⚠️ **LA SOGLIA ERA UNA RIGA, E UNA RIGA PUÒ ESSERE DUE PAROLE (riparato il 2026-08-16).**
   *
   * I tre motori trascinavano sul foglio nuovo la sola ULTIMA riga di contenuto: formalmente
   * nessuna pagina portava «solo la chiusura», ma su un documento protocollato di 21 righe
   * l'ultima pagina conteneva «larghezza utile.», la data, «La Direzione», il tratto e
   * «Pagina 2 di 2». La motivazione scritta nel codice non è «almeno una riga»: è che chi
   * separa quel foglio dal fascicolo ha in mano **una firma senza documento** — e con due
   * parole sul foglio ce l'ha ancora.
   */
  /** Un blocco alto `altezza` che deve stare sopra `fondo`, come lo vede un motore. */
  const bloccoAlto = (altezza: number, fondo = CARTA.contenutoFine) => (quota: number) =>
    quota + altezza <= fondo

  const base = {
    righeMinimeInCoda: RIGHE_MINIME_IN_CODA,
    interlinea: 6.2,
    inizioPagina: CARTA.contenutoInizio,
    bloccoRestaConLUltimaRigaA: bloccoAlto(20),
  }

  it('la soglia è tre righe, non una', () => {
    expect(RIGHE_MINIME_IN_CODA).toBe(3)
  })

  it('non muove niente finché la coda non comincia', () => {
    // Quarantesima riga di un documento lungo: mancano ancora venti righe, e anticipare il
    // salto qui butterebbe via mezza pagina di documento.
    expect(codaVuoleUnFoglioNuovo({ ...base, quota: 240, righeRimaste: 20 })).toBe(false)
  })

  it('non muove niente quando la coda intera ci sta già su questo foglio', () => {
    expect(codaVuoleUnFoglioNuovo({ ...base, quota: 100, righeRimaste: 3 })).toBe(false)
  })

  it('trascina la coda quando sul foglio ci starebbe meno del dovuto', () => {
    // Con la coda a 240, l'ultima riga cadrebbe a 240 + 2×6,2 = 252,4 e il blocco a 272,4:
    // oltre il fondo. Le tre righe scendono insieme.
    expect(codaVuoleUnFoglioNuovo({ ...base, quota: 240, righeRimaste: 3 })).toBe(true)
    // …e sul foglio nuovo non si rifà il salto: 40 + 2×6,2 + 20 = 72,4, ci sta.
    expect(codaVuoleUnFoglioNuovo({ ...base, quota: 40, righeRimaste: 3 })).toBe(false)
  })

  it('non apre un foglio che non rimedierebbe a niente', () => {
    // Un blocco alto 230 mm non entra su un foglio vuoto insieme a tre righe: spostare il
    // contenuto costerebbe una pagina senza guadagnare nulla, e allora non si sposta.
    expect(
      codaVuoleUnFoglioNuovo({
        ...base,
        quota: 240,
        righeRimaste: 3,
        bloccoRestaConLUltimaRigaA: bloccoAlto(230),
      })
    ).toBe(false)
  })

  it('degrada da tre a due a una invece di arrendersi', () => {
    // Un blocco alto 210: tre righe (40 + 12,4 + 210 = 262,4) ci stanno per un pelo, due
    // (40 + 6,2 + 210 = 256,2) e una (250) anche. Con 215 le tre non entrano più e la coda
    // si accorcia da sola al giro dopo, invece di lasciare il blocco da solo.
    const stretto = { ...base, bloccoRestaConLUltimaRigaA: bloccoAlto(215) }
    expect(codaVuoleUnFoglioNuovo({ ...stretto, quota: 250, righeRimaste: 3 })).toBe(false)
    expect(codaVuoleUnFoglioNuovo({ ...stretto, quota: 256, righeRimaste: 2 })).toBe(true)
  })

  it('non trascina più righe di quante ne restino', () => {
    // Un documento di due righe in tutto: scendono tutte e due, e il conto sul foglio nuovo
    // si fa su due, non su tre — altrimenti un documento corto non si sposterebbe mai.
    const cortissimo = { ...base, bloccoRestaConLUltimaRigaA: bloccoAlto(215) }
    expect(codaVuoleUnFoglioNuovo({ ...cortissimo, quota: 250, righeRimaste: 2 })).toBe(true)
  })

  it('conta il foglio nuovo da dove il contenuto ricomincia davvero', () => {
    // Chi ripete l'intestazione delle colonne riparte più in basso: un conto fatto da
    // `contenutoInizio` prometterebbe uno spazio che sul foglio non c'è.
    const conTestata = { ...base, bloccoRestaConLUltimaRigaA: bloccoAlto(215) }
    expect(codaVuoleUnFoglioNuovo({ ...conTestata, quota: 250, righeRimaste: 3 })).toBe(false)
    expect(
      codaVuoleUnFoglioNuovo({
        ...conTestata,
        quota: 250,
        righeRimaste: 3,
        inizioPagina: CARTA.contenutoInizio - 4,
        bloccoRestaConLUltimaRigaA: bloccoAlto(211),
      })
    ).toBe(true)
  })

  it('non lancia su un elenco vuoto', () => {
    expect(codaVuoleUnFoglioNuovo({ ...base, quota: 240, righeRimaste: 0 })).toBe(false)
  })
})
