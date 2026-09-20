import { COLONNE_DOCUMENTO } from './percorso-documento'

/**
 * I PERCORSI CHE UNA RIGA NOMINA — fronte, retro, o nessuno dei due.
 *
 * ⚠️ PERCHÉ È UN MODULO E NON UNA FUNZIONE LOCALE. Questa regola vive dove si
 * cancellano documenti del personale, e i posti sono diventati due: il cron di
 * conservazione (`gdpr/retention-personale:POST`) e il comando «Elimina docente»
 * / «Trasforma in genitore». Una seconda copia è esattamente ciò che
 * `__tests__/architecture/colonne-documento-un-posto-solo.test.ts` esiste per
 * impedire — quel lock è nato dopo che una TERZA faccia del documento era
 * passata con 93 test su 93 verdi, perché l'elenco delle colonne era scritto a
 * mano in un posto e aggiornato in un altro.
 *
 * Il `Set` è igiene, e si dichiara per quello che è invece di farsi passare per
 * una difesa: nessuna delle due colonne è unica in tabella, e l'invariante «i
 * due percorsi non possono essere uguali» NON la impone il database — la impone
 * una riga sola di `iscrizione/personale:POST`, in un altro file.
 *
 * Oggi la duplicazione non farebbe danni a valle (`rimuoviEVerifica` deduplica a
 * sua volta, e `every` su due elementi uguali risponde come su uno), ma questo è
 * l'elenco che risponde alla domanda «quanti file nomina questa riga»:
 * lasciarcene due identici lo renderebbe una risposta falsa per il prossimo che
 * se ne servirà.
 */

/** Una riga che può portare le scansioni del documento d'identità. */
export type ConDocumento = {
  documento_fronte_path?: string | null
  documento_retro_path?: string | null
}

/** Stringa non vuota, ripulita; qualunque altra cosa → `null`. */
export function testoDelPercorso(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

export function percorsiDelDocumento(riga: ConDocumento): string[] {
  // ⚠️ LA LETTURA È PER CHIAVE DINAMICA, e il tipo largo vive QUI — su una riga
  // sola, dentro la funzione — invece di allargare `ConDocumento`.
  //
  // `COLONNE_DOCUMENTO` si legge da `PERSONALE_FIELDS` a runtime (è il punto del
  // modulo condiviso: il nome della colonna sta scritto in un posto solo), quindi
  // per TypeScript è `readonly string[]` e non l'unione delle due chiavi:
  // `riga[c]` su un tipo chiuso è `TS7053`, ed è stato un gate rosso il
  // 13/08/2026.
  //
  // Allargare `ConDocumento` a un tipo con index signature avrebbe tolto il rosso
  // in un modo che costa caro altrove: chi lo interseca perderebbe il controllo
  // sui propri campi, e `riga.origine_pratica_idX` compilerebbe restituendo
  // `undefined` per sempre. I tipi restano chiusi; è questa funzione a dichiarare
  // che sta leggendo per chiave calcolata.
  const campi: Record<string, unknown> = riga
  return [
    ...new Set(
      COLONNE_DOCUMENTO.map((c) => testoDelPercorso(campi[c])).filter(
        (p): p is string => p !== null,
      ),
    ),
  ]
}
