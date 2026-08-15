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
 * può scrivere. Chi compone il documento finito importa la funzione, e la chiama **prima**
 * di `applicaSegnatura()`.
 */

export { applicaCartaIntestata } from './applica'
export { cartaIntestataBytes } from './asset'
export { CARTA, type GeometriaCarta } from './geometria'
