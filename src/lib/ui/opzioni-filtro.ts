import { normalizzaTesto, rangoDiMatch } from '@/lib/ui/testo-ricerca'
import type { OpzioneFiltro } from '@/lib/ui/filtri/tipi'

/**
 * ─── I DUE COMPLEMENTI DEL MOTORE DEI FILTRI ─────────────────────────────────
 *
 * Il motore (`src/lib/ui/filtri/`) è finito e chiuso: decide che cosa è un filtro, che cosa
 * parte verso l'API e quali righe restano. Qui stanno due decisioni che il motore non deve
 * prendere — riguardano **come si presenta** una barra costruita sui dati — e che valgono
 * identiche per le quattro linguette di «Modulistica». Vivono in un file solo per la ragione
 * già pagata altrove in questo repo: una regola valida per più strade copiata in ognuna si
 * corregge in tutte tranne una.
 *
 * Modulo puro: niente React, niente DOM. Si prova senza montare niente
 * (`__tests__/lib/filtri-opzioni-admin.test.ts`).
 */

/**
 * Le opzioni DERIVATE dai dati, ma solo se ce n'è più di una.
 *
 * `nascondiSeVuoto` del motore nasconde un campo con zero opzioni; questa funzione porta a
 * zero anche il caso da UNA. Con una sola sede caricata, o una sola classe, o un solo genere
 * di difformità, il controllo esiste ma non può cambiare niente: qualunque cosa si prema, le
 * righe restano quelle. Non è però inerte — occupa la barra, entra nel conteggio della
 * pastiglia «Filtri» e fa premere qualcosa a vuoto, che è il modo in cui una barra filtri
 * smette di sembrare affidabile.
 *
 * L'elenco si restituisce com'è, senza copie e senza riordini: l'ordine lo ha già deciso
 * `opzioniDerivate`, e rifarlo qui vorrebbe dire due ordinamenti da tenere allineati.
 */
export function opzioniUtili(opzioni: readonly OpzioneFiltro[]): readonly OpzioneFiltro[] {
  return opzioni.length > 1 ? opzioni : []
}

/** Il rango peggiore possibile: chi non corrisponde va in fondo, ma non sparisce. */
const IN_FONDO = Number.MAX_SAFE_INTEGER

/**
 * Riordina un CATALOGO per qualità della corrispondenza — e non lo filtra.
 *
 * `filtraRighe` del motore tiene o scarta e non ordina, ed è giusto così: sull'elenco delle
 * pratiche l'ordine è quello della tabella, e rimescolarlo mentre si digita farebbe perdere
 * il posto. Un CATALOGO è l'altro caso: diciassette modelli in una griglia, dove chi scrive
 * «cert» si aspetta «Certificato di servizio» prima di «Richiesta di un certificato». Il
 * criterio non si inventa qui — è `rangoDiMatch`, lo stesso che ordina i 484 comuni del
 * `Combobox`: `0` in testa alla stringa, `1` a inizio di una parola, `2` dentro una parola.
 *
 * ⚠️ ORDINA, NON SCARTA. Chi non corrisponde finisce in fondo e resta: scartare qui
 * significherebbe avere due definizioni di «corrisponde» — una nel motore e una qui — e il
 * giorno in cui divergono l'elenco perderebbe righe senza che nessuno lo veda. A monte ha
 * già filtrato il campo di ricerca del motore.
 *
 * ⚠️ STABILE. `Array.prototype.sort` in ES2019 lo è per specifica, ma il confronto qui è
 * comunque scritto per non scambiare mai due voci di pari rango: a parità di corrispondenza
 * l'ordine di partenza è l'unico che qualcuno ha scelto, e senza di lui il catalogo «balla»
 * a ogni battuta di tasto.
 */
export function ordinaPerRicerca<R>(
  righe: readonly R[],
  query: string,
  etichettaDi: (riga: R) => string,
): R[] {
  const q = normalizzaTesto(query)
  // Query vuota: nessun criterio da applicare, e l'ordine di partenza resta intatto.
  if (q === '') return [...righe]
  const conRango = righe.map((riga, posizione) => ({
    riga,
    posizione,
    rango: rangoDiMatch(normalizzaTesto(etichettaDi(riga)), q) ?? IN_FONDO,
  }))
  conRango.sort((a, b) => a.rango - b.rango || a.posizione - b.posizione)
  return conRango.map((v) => v.riga)
}
