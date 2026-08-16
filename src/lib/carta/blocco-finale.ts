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
 * ─── E QUANTO CONTENUTO DEVE SCENDERE INSIEME AL BLOCCO ────────────────────────
 *
 * La regola qui sopra dice DOVE cade il blocco. Non dice quanto documento debba restargli
 * accanto, e per un giorno intero la risposta implicita è stata «una riga»: i tre motori
 * trascinavano sul foglio nuovo la sola ultima riga di contenuto. Formalmente la regola
 * teneva — nessun foglio portava la sola chiusura — ma una riga può essere due parole:
 * misurato su un documento protocollato di 21 righe, l'ultima pagina conteneva «larghezza
 * utile.», la data, «La Direzione», il tratto e «Pagina 2 di 2». Un foglio intero di carta
 * intestata — marchio, filigrana mascotte, ragione sociale, P.IVA e le tre sedi — con
 * sopra due parole e una firma.
 *
 * La motivazione scritta qui sotto non è «almeno una riga»: è che *chi separa quel foglio
 * dal fascicolo ha in mano una firma senza documento*. Con «larghezza utile.» sul foglio ce
 * l'ha ancora. La soglia sale quindi a `RIGHE_MINIME_IN_CODA`, che è il controllo
 * vedove/orfane tipografico consueto, e sta in un posto solo — `codaVuoleUnFoglioNuovo()` —
 * perché i motori la ereditino invece di riscoprirla ciascuno a modo suo.
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

/**
 * Quante righe di contenuto devono scendere sull'ultimo foglio insieme al blocco che lo
 * chiude — firma, totale di un ordine, nota di una ricevuta.
 *
 * **Tre**, che è il controllo vedove/orfane tipografico consueto. Non è un numero scelto
 * per simmetria: una riga sola può essere la coda spezzata di una frase («larghezza
 * utile.»), due possono esserlo entrambe; tre righe sono un paragrafo, cioè abbastanza
 * documento perché il foglio si sappia leggere anche staccato dal fascicolo.
 *
 * Se il contenuto è più corto di tre righe scendono tutte: non si può trascinare più di
 * quello che c'è.
 */
export const RIGHE_MINIME_IN_CODA = 3

export interface RichiestaCoda {
  /** La linea di scrittura a cui la riga che si sta per stampare cadrebbe. */
  quota: number
  /** Quante righe di contenuto restano da stampare, **questa compresa**. */
  righeRimaste: number
  /** Quante se ne vogliono in coda sull'ultimo foglio. Di norma `RIGHE_MINIME_IN_CODA`. */
  righeMinimeInCoda: number
  /** Il passo fra due righe di contenuto. */
  interlinea: number
  /**
   * Dove il contenuto ricomincia su un foglio nuovo. Non è sempre `contenutoInizio`: chi
   * ripete l'intestazione delle colonne in cima a ogni pagina riparte più in basso, e un
   * conto fatto da `contenutoInizio` promette uno spazio che sul foglio non c'è.
   */
  inizioPagina: number
  /**
   * `true` se, con l'ULTIMA riga di contenuto scritta a `quota`, il blocco finale resta su
   * quel foglio. Il conto lo fa il motore: qui non si sa se il blocco sia una firma alta
   * 14 mm o una nota di due righe.
   */
  bloccoRestaConLUltimaRigaA(quota: number): boolean
}

/**
 * `true` se conviene cambiare foglio **prima** di stampare questa riga, perché altrimenti
 * l'ultimo foglio porterebbe il blocco finale con meno righe di documento del dovuto.
 *
 * Si chiama a ogni riga di contenuto, e risponde `false` finché la coda non comincia.
 *
 * ─── LA RETE, CHE È LA META' DEL VALORE ────────────────────────────────────────
 *
 * Il salto anticipato si fa **solo se sul foglio nuovo la coda e il blocco ci starebbero
 * davvero**: con una nota di quaranta righe non ci starebbero comunque, e allora spostare
 * il contenuto costerebbe una pagina senza rimediare a niente.
 *
 * ─── E LA SOGLIA DEGRADA INVECE DI ARRENDERSI ──────────────────────────────────
 *
 * `righeRimaste` scende a ogni giro, e con lei la coda che si prova a trascinare: se tre
 * righe più il blocco non entrano su un foglio vuoto, al giro dopo se ne provano due, poi
 * una. Il risultato peggiore possibile è quindi il comportamento che i motori avevano
 * prima — la sola ultima riga — mai peggio.
 */
export function codaVuoleUnFoglioNuovo(richiesta: RichiestaCoda): boolean {
  const { quota, righeRimaste, interlinea, inizioPagina, bloccoRestaConLUltimaRigaA } = richiesta
  if (righeRimaste < 1) return false

  const inCoda = Math.min(Math.max(1, Math.floor(richiesta.righeMinimeInCoda)), righeRimaste)
  // Non siamo ancora nella coda: la riga corrente non è fra quelle che devono restare col
  // blocco, e anticipare il salto qui butterebbe via mezza pagina di documento.
  if (righeRimaste > inCoda) return false

  // Dove cadrebbe l'ULTIMA riga se la coda restasse tutta su questo foglio.
  if (bloccoRestaConLUltimaRigaA(quota + (righeRimaste - 1) * interlinea)) return false

  return bloccoRestaConLUltimaRigaA(inizioPagina + (inCoda - 1) * interlinea)
}
