/**
 * Dove cade il blocco che chiude un documento — la firma, il totale di un ordine — e
 * quando quel blocco vale una pagina in più.
 *
 * ─── PERCHÉ È UNA FUNZIONE SOLA ────────────────────────────────────────────────
 *
 * `carta/geometria.ts` promette per iscritto che «i millimetri per far stare la firma nella
 * pagina si trovano nel motore — che stringe lo stacco prima di aprire un foglio nuovo».
 * Fino al 2026-08-16 quella promessa era mantenuta da **un motore su due**:
 * `prestampati/impaginazione.ts` stringeva davvero (`STACCO_FIRMA` 12 → `STACCO_FIRMA_MINIMO`
 * 5), `protocolli/documento-pdf.ts` aveva un `+18` fisso e apriva la pagina.
 *
 * Il conto, misurato: corpo che chiude a y≈237 → `max(237 + 18, 150) = 255`,
 * `255 + 14 = 269 > 263,5` → foglio nuovo. Con lo stacco stretto a 5: `242 + 14 = 256`, ci
 * stava. Il risultato del `+18` era un secondo foglio di **carta intestata** — marchio,
 * filigrana mascotte, ragione sociale, P.IVA, le tre sedi — con sopra soltanto «Giugliano
 * in Campania, 16/08/2026 — La Direzione — ______». Su un certificato protocollato diretto
 * a una famiglia o all'INPS, la pagina della firma non portava una sola parola dell'atto
 * che firma: chi la separa dal fascicolo ha in mano una firma senza documento.
 *
 * Era la stessa doppia manutenzione che questo lavoro è nato per finire — la testata è
 * stata unificata, la politica di salto pagina no. Ora la scelta la compie **questa**
 * funzione, e il terzo motore che nascerà non la ricopierà una terza volta.
 *
 * ─── LA REGOLA, IN TRE PASSI ───────────────────────────────────────────────────
 *
 *  1. si prova con l'aria piena (`stacco`), mai sopra `quotaMinima`;
 *  2. se non ci sta, si prova con l'aria stretta (`staccoMinimo`) — e se basta, il blocco
 *     si appoggia al `tetto`, cioè si prende TUTTA l'aria che il foglio concede invece del
 *     minimo: undici millimetri o cinque non li nota nessuno, una firma sola in mezzo al
 *     bianco la nota chiunque;
 *  3. solo se nemmeno l'aria stretta basta, si apre una pagina nuova.
 *
 * Testata in `__tests__/lib/carta-blocco-finale.test.ts`.
 */

import { CARTA } from './geometria'

export interface RichiestaBloccoFinale {
  /** La quota a cui il contenuto ha finito di scrivere (linea di scrittura). */
  dopoIlContenuto: number
  /** L'aria che si vorrebbe fra il contenuto e il blocco. */
  stacco: number
  /** L'aria minima accettabile prima di rassegnarsi a un foglio in più. */
  staccoMinimo: number
  /** La quota più ALTA a cui il blocco può cominciare, per estetica del documento. */
  quotaMinima: number
  /**
   * La quota più BASSA a cui il blocco può cominciare: è il fondo utile meno l'altezza del
   * blocco. Il calcolo resta al chiamante perché il fondo non è sempre `contenutoFine` —
   * sui certificati protocollati è il bordo alto del riquadro di verifica.
   */
  tetto: number
  /**
   * Dove il contenuto ricomincia su una pagina nuova. Non è sempre `contenutoInizio`: chi
   * ristampa una testata compatta in cima a ogni foglio riparte più in basso.
   */
  inizioPagina?: number
}

export interface QuotaBloccoFinale {
  /** La linea di scrittura a cui il blocco deve cominciare. */
  y: number
  /** `true` se il chiamante deve aprire una pagina nuova PRIMA di disegnare. */
  paginaNuova: boolean
}

export function quotaBloccoFinale(richiesta: RichiestaBloccoFinale): QuotaBloccoFinale {
  const { dopoIlContenuto, stacco, staccoMinimo, quotaMinima, tetto } = richiesta
  const inizioPagina = richiesta.inizioPagina ?? CARTA.contenutoInizio

  const distesa = Math.max(dopoIlContenuto + stacco, quotaMinima)
  if (distesa <= tetto) return { y: distesa, paginaNuova: false }

  // `Math.min` perché uno stacco minimo più largo di quello nominale sarebbe una svista di
  // chi chiama, e qui produrrebbe un salto di pagina invece di un errore visibile.
  const compressa = Math.max(dopoIlContenuto + Math.min(staccoMinimo, stacco), quotaMinima)
  if (compressa <= tetto) return { y: tetto, paginaNuova: false }

  // Sulla pagina nuova il contenuto non pesa più, ma il tetto sì: un blocco altissimo può
  // costringere la firma sopra `quotaMinima`, e fra le due regole vince quella che non fa
  // sfondare il piede stampato sulla carta — una firma un po' più in alto si legge, due
  // riquadri sovrapposti no.
  return { y: Math.max(Math.min(quotaMinima, tetto), inizioPagina), paginaNuova: true }
}
