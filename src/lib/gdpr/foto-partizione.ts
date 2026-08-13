import { percorsoNelBucket } from '@/lib/gallery/storage'

// =============================================================================
// CHE FINE FA UNA FOTO DI GALLERIA QUANDO SI OBLIA UN BAMBINO — detto UNA volta.
//
// ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
//
// La regola stava scritta in due posti: `obliaFotoAlunno` (`esegui.ts`), che la
// applica, e `contaCosaDistrugge` (`cosa-distrugge.ts`), che la annuncia alla
// Direzione prima della conferma. Due copie della stessa regola divergono — in
// questo repo è già successo — e qui la divergenza era MISURATA il 2026-08-12,
// su due casi:
//
//  · `tag_students: [' al-1 ']` → l'annuncio diceva «foto solo sue: 1» (perché
//    normalizzava gli uuid) e l'esecuzione ne toglieva soltanto il tag, lasciando
//    la foto nell'archivio. Peggio del numero sbagliato: con un tag di scarto
//    (`'   '`) accanto al suo, la foto di un bambino SOPRAVVIVEVA al suo oblio.
//  · `file_url` che non si mappa su questo bucket → l'annuncio prometteva una
//    distruzione e l'esecuzione non cancellava né il file né la riga.
//
// «Una regola valida per due strade deve vivere in un posto solo, altrimenti
// diverge in silenzio.» Le strade erano due: da qui in avanti la regola è una.
//
// ⚠️ Qui NON si esegue e NON si legge niente: è aritmetica pura su una riga già
// letta. Chi cancella è `obliaFotoAlunno`; chi conta è `contaCosaDistrugge`.
// =============================================================================

/**
 * Gli uuid dichiarati in un array jsonb, senza vuoti, senza spazi e senza doppioni.
 *
 * Il `trim()` non è cosmesi: `'   '` è una stringa VERA per JavaScript, e senza
 * questa riga un tag di scarto contava come «c'è un altro bambino in questa
 * foto» — cioè teneva in archivio la foto di chi aveva chiesto l'oblio.
 */
export function uuidDichiarati(valore: unknown): string[] {
  if (!Array.isArray(valore)) return []
  return [
    ...new Set(valore.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0)),
  ]
}

/** La riga di galleria che serve alla decisione: nient'altro. */
export interface RigaMedia {
  id: string
  file_url?: string | null
  tag_students?: unknown
}

/**
 * Che cosa succede a QUESTA foto quando si oblia QUESTO bambino.
 *
 *  · `rimossa`   — è l'unico taggato: se ne vanno la riga e il file.
 *  · `sganciata` — dentro c'è l'immagine di altri bambini: il file RESTA e si
 *                  toglie soltanto il collegamento «questo è X». L'oblio di uno
 *                  non autorizza a cancellare il dato altrui.
 *  · `trattenuta`— è l'unico taggato ma l'indirizzo del file non è riconoscibile
 *                  in questo archivio: non si cancella niente (né file né riga),
 *                  perché una riga cancellata su una foto rimasta nell'archivio
 *                  è la foto di un bambino che nessuno può più ritrovare per
 *                  toglierla. È un oblio PARZIALE, e va detto — non contato fra
 *                  le distruzioni.
 */
export type SorteFoto =
  | { sorte: 'rimossa'; id: string; percorso: string | null }
  | { sorte: 'sganciata'; id: string; altri: string[] }
  | { sorte: 'trattenuta'; id: string }

export function sorteDellaFoto(riga: RigaMedia, alunnoId: string): SorteFoto {
  const id = (alunnoId ?? '').trim()
  const altri = uuidDichiarati(riga.tag_students).filter((t) => t !== id)
  if (altri.length > 0) return { sorte: 'sganciata', id: riga.id, altri }

  const testo = (riga.file_url ?? '').trim()
  // Riga senza indirizzo: non c'è file da togliere, la riga se ne va lo stesso.
  if (testo.length === 0) return { sorte: 'rimossa', id: riga.id, percorso: null }
  const percorso = percorsoNelBucket(testo)
  if (percorso === null) return { sorte: 'trattenuta', id: riga.id }
  return { sorte: 'rimossa', id: riga.id, percorso }
}
