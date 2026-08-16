/**
 * Far stare un testo dentro una larghezza — e dirlo, quando non ci sta.
 *
 * ─── PERCHÉ STA QUI E NON DENTRO UN MOTORE ─────────────────────────────────────
 *
 * Questa funzione è nata il 2026-08-16 dentro `presenze/registro-pdf.ts`, per la testata
 * del registro. Lo stesso giorno, sull'ordine al fornitore, il nome dell'articolo si
 * accorciava così:
 *
 * ```ts
 * doc.text(String(r.articolo).slice(0, 60), X_ARTICOLO, y)   // ← non misurava niente
 * ```
 *
 * Sessanta CARATTERI non sono una larghezza. Misurato su nomi da catalogo scolastico veri,
 * «GREMBIULE SCOLASTICO COTONE BIANCO RICAMATO LOGO KIDVILLE GI» arrivava a 149 mm su una
 * colonna che finisce a 128, cioè si stampava sopra la taglia; con sessanta caratteri tutti
 * maiuscoli larghi arrivava a 221 mm su un foglio largo 210, cioè usciva dal foglio. E il
 * taglio era MUTO: «…KIDVILLE GIUGLIANO» diventava «…KIDVILLE GI», che sembra il nome vero
 * dell'articolo — su un ordine d'acquisto, cioè sull'unico foglio di questo lotto che esce
 * dalla scuola verso un terzo.
 *
 * Due motori, lo stesso problema, una copia sola che misurava. Perciò la funzione vive
 * accanto a `quotaBloccoFinale()`: è la stessa ragione per cui `blocco-finale.ts` esiste —
 * il terzo motore che ne avrà bisogno la trova, invece di riscoprirla a metà.
 *
 * ─── NIENTE PDF-LIB, NIENTE ASSET ──────────────────────────────────────────────
 *
 * Questo modulo si importa come `@/lib/carta/testo`, mai da `@/lib/carta`: la superficie
 * pubblica del modulo porta dietro pdf-lib e 1,1 MB di carta intestata, e chi impagina non
 * ne ha bisogno. Il tipo del documento è **strutturale** (`{ getTextWidth }`) e non `jsPDF`:
 * così il lock lo può misurare senza costruire un PDF.
 *
 * Testato in `__tests__/lib/carta-testo.test.ts`.
 */

/** Il minimo che serve per misurare: `jsPDF` lo soddisfa, e anche un doppio nei test. */
export interface MisuraTesto {
  /** La larghezza del testo, in millimetri, col font e il corpo CORRENTI del documento. */
  getTextWidth(testo: string): number
}

/** Ciò che si stampa quando non ci sta nemmeno un carattere e i puntini. */
const PUNTINI = '...'

/**
 * Un testo che sta dentro `larghezzaMax`, coi puntini di sospensione se serve tagliare.
 *
 * ⚠️ **I puntini non sono decorazione: sono la differenza fra «accorciato» e «sbagliato».**
 * Un taglio netto — `slice(60)`, o l'`overflow: 'hidden'` di autoTable — consegna una
 * stringa che sembra il valore vero: su un registro è un bambino identificato a metà, su un
 * ordine d'acquisto è un articolo che il magazzino del fornitore deve indovinare. I puntini
 * dichiarano che manca qualcosa, ed è l'unica cosa onesta che un foglio possa fare quando
 * lo spazio non basta.
 *
 * ⚠️ **E `maxWidth` di jsPDF non è un'alternativa**: non taglia, manda a capo. Una riga in
 * più dove il motore ne ha previsto una sola finisce addosso a ciò che viene dopo — è il
 * difetto per cui il filetto del titolo, su un certificato protocollato, barrava la seconda
 * riga del titolo stesso.
 *
 * La misura la fa il documento col font e il corpo che ha **in quel momento**: chi chiama
 * imposta `setFont`/`setFontSize` prima, altrimenti misura un carattere e ne stampa un altro.
 */
export function accorcia(doc: MisuraTesto, testo: string, larghezzaMax: number): string {
  if (larghezzaMax <= 0) return ''
  if (doc.getTextWidth(testo) <= larghezzaMax) return testo
  let taglio = testo
  while (taglio.length > 0 && doc.getTextWidth(`${taglio}${PUNTINI}`) > larghezzaMax) {
    taglio = taglio.slice(0, -1)
  }
  // `trimEnd` perché «GREMBIULE ...» con lo spazio prima dei puntini si legge come un refuso.
  // Se non ci sta nemmeno un carattere restano i soli puntini: dire «qui c'era qualcosa e
  // non ci sta» è comunque più onesto di una cella vuota.
  return `${taglio.trimEnd()}${PUNTINI}`
}
