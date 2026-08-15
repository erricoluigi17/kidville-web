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
 * può scrivere. Chi compone il documento finito importa la funzione.
 *
 * ⚠️ **E il documento finito esce da UNA chiamata sola.** Questa riga, fino al 2026-08-15,
 * diceva di chiamare `applicaCartaIntestata()` «prima di `applicaSegnatura()`»: comporre
 * in quell'ordine dipinge una fascia verde sopra il marchio della scuola, ci mette un
 * secondo logo Kidville sopra il primo e riscala la carta di 0,924 staccando il piede a
 * quattro colonne dal fondo del foglio. La segnatura di protocollo si passa qui —
 * `applicaCartaIntestata(pdf, { segnatura: { righe } })` — con le stesse righe che produce
 * `righeSegnatura()`. `applicaSegnatura()` resta il timbro dei documenti **acquisiti**,
 * che arrivano su un foglio bianco; il lock in `__tests__/lib/carta-applica.test.ts` vieta
 * a un modulo di importarle tutte e due.
 */

export { applicaCartaIntestata, type OpzioniCarta, type SegnaturaCarta } from './applica'
export { cartaIntestataBytes } from './asset'
export { CARTA, type GeometriaCarta } from './geometria'
