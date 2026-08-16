/**
 * La carta intestata della scuola — superficie pubblica del modulo.
 *
 * Un posto solo dove la carta si applica, e cinque motori PDF che lo chiamano
 * (prestampati, protocolli, ricevuta FEA, registro presenze, merch): due copie della
 * stessa testata divergono sempre, prima o poi, e la divergenza si scopre su un foglio
 * già consegnato.
 *
 * ⚠️ **Solo codice server.** L'asset pesa 1,1 MB: importare questo modulo da un
 * componente client vorrebbe dire 1,1 MB scaricati da ogni telefono. È il motivo per cui
 * il registro presenze — oggi generato nel browser — passa a una route.
 *
 * Chi impagina non importa `applicaCartaIntestata`: gli serve `CARTA`, per sapere dove
 * può scrivere. **Chi CONSEGNA importa la funzione, e deve chiamarla**: il motore dei
 * prestampati non disegna più né banda né logo né piede, quindi una rotta che restituisce
 * i suoi byte così com'escono manda alla famiglia un foglio più nudo di quello di prima.
 *
 * ⚠️ **E chi impagina su un formato che non sia l'A4 VERTICALE non legga `CARTA` a mano:
 * chieda a `fasceVietate(larghezza, altezza)`.** Sull'orizzontale la carta si gira di 90°,
 * e il marchio della scuola non è più una fascia in cima al foglio ma una colonna sul bordo
 * sinistro (12,5→27,05 mm), col piede stampato sul bordo destro. `CARTA.brandFine` è una
 * quota verticale: su un foglio girato non vuol dire più niente, e il registro presenze —
 * che è orizzontale — ci stampava sopra.
 *
 * ⚠️ **E il documento finito esce da UNA chiamata sola.** Questa riga, fino al 2026-08-15,
 * diceva di chiamare `applicaCartaIntestata()` «prima di `applicaSegnatura()`»: comporre
 * in quell'ordine dipinge una fascia verde sopra il marchio della scuola, ci mette un
 * secondo logo Kidville sopra il primo e riscala la carta di 0,924 staccando il piede a
 * quattro colonne dal fondo del foglio. La segnatura di protocollo si passa qui —
 * `applicaCartaIntestata(pdf, { segnatura: { righe } })` — con le stesse righe che produce
 * `righeSegnatura()`. `applicaSegnatura()` resta il timbro dei documenti **acquisiti**,
 * che arrivano su un foglio bianco.
 *
 * Il lock è in `__tests__/lib/carta-applica.test.ts`, e la sua prima versione era **vacua**
 * — vietava di importare le due funzioni insieme, cosa che nessun file faceva perché
 * nessun file importava la prima. Ora il predicato è invertito e verifica la cosa che
 * conta: **ogni `route.ts` che compone un prestampato importa `applicaCartaIntestata`**.
 *
 * ─── «CINQUE MOTORI» NON VUOL DIRE «TUTTI I MOTORI» ────────────────────────────
 *
 * ⚠️ I motori che chiamano `new jsPDF` in questo repository sono **quindici**, non cinque.
 * Quelli sulla carta sono i cinque della spec §1.5 — prestampati, protocolli, ricevuta FEA,
 * registro presenze, merch — e gli altri dieci **no**: alcuni perché la carta della scuola
 * non ha senso sotto una fattura elettronica o una stampa di servizio, **altri perché si
 * dipingono ancora la loro banda verde e nessuno li ha ancora riparati** (il certificato
 * delle competenze, la pagella, la ricevuta FES nel browser del genitore, l'export dei
 * moduli, il foglio delle credenziali).
 *
 * Chi legge questo file non deve dedurlo: l'elenco completo, uno per uno e con il motivo,
 * sta in **`__tests__/architecture/motori-pdf-perimetro-carta.test.ts`**, che è anche il
 * lock che impedisce a un motore nuovo di comparire senza che qualcuno abbia deciso da che
 * parte sta. Un'eccezione non dichiarata è quella che il prossimo lavoro ricopia — e qui i
 * file da cui copiare la cosa sbagliata sono la maggioranza.
 */

export { applicaCartaIntestata, type OpzioniCarta, type SegnaturaCarta } from './applica'
export { cartaIntestataBytes } from './asset'
export {
  RIGHE_MINIME_IN_CODA,
  codaVuoleUnFoglioNuovo,
  quotaBloccoFinale,
  type QuotaBloccoFinale,
  type RichiestaBloccoFinale,
  type RichiestaCoda,
} from './blocco-finale'
export { accorcia, type MisuraTesto } from './testo'
export {
  CARTA,
  fasceVietate,
  ingombroTesto,
  stesuraCarta,
  type GeometriaCarta,
  type IngombroTesto,
  type Rettangolo,
  type StesuraCarta,
} from './geometria'
