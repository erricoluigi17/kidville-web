/**
 * IL CESTINO DEL REGISTRO DELLA PRIMARIA — i giorni di custodia, in un posto solo.
 *
 * Allegati del registro (`allegati_registro`) e documenti del fascicolo
 * (`student_documents`) non si cancellano subito: «Elimina» li mette nel cestino
 * (`eliminato_il`), si possono ripristinare per 7 giorni, poi la purga toglie riga
 * e file (spec 2026-09-24, «2 Primaria»). Lo stesso vale per il file SOSTITUITO e
 * per gli allegati di una lezione eliminata.
 *
 * ─── PERCHÉ UN MODULO PURO ──────────────────────────────────────────────────
 * Il numero lo leggono DUE lati: la purga (server, cron) che lo APPLICA e la
 * schermata del cestino (client) che lo PROMETTE («Restano 3 giorni»). Il
 * cestino della galleria ha dovuto ripeterlo in due file perché il suo modulo
 * importa il logger del server; qui niente import, così client e server leggono
 * la STESSA costante e non c'è niente da tenere allineato.
 *
 * ⚠️ Chi cambia questo numero cambia anche il cron della purga
 * (`…_cestino_registro_cron.sql`) se lo porta scritto: il lock della purga lo
 * confronta con questo.
 */
export const GIORNI_CESTINO_REGISTRO = 7

const GIORNO_MS = 24 * 60 * 60 * 1000

function istante(v: Date | string): number {
  return typeof v === 'string' ? Date.parse(v) : v.getTime()
}

/**
 * L'istante in cui una voce messa nel cestino a `eliminatoIl` diventa purgabile.
 * Sette giorni di 24 ore sull'istante, non sulla data: è lo stesso conto che fa
 * la purga (`eliminato_il < now() - interval '7 days'`), e un cambio d'ora non lo
 * sposta. `null` se l'istante non è leggibile.
 */
export function scadenzaCestino(eliminatoIl: Date | string): Date | null {
  const t = istante(eliminatoIl)
  if (Number.isNaN(t)) return null
  return new Date(t + GIORNI_CESTINO_REGISTRO * GIORNO_MS)
}

/**
 * I giorni INTERI che restano per ripristinare: arrotondati PER DIFETTO.
 *
 * La regola è una sola: la schermata non promette MAI più tempo di quello vero.
 * Chi legge «2 giorni» può tornare fra 40 ore; se ne restavano 30, al ritorno la
 * purga può aver già tolto riga e file, e non c'è un annulla. Promettere meno è
 * innocuo: si ripristina prima del necessario. Quindi a 30 ore si legge «1».
 *
 * Il prezzo, dichiarato: sotto le 24 ore il risultato è 0 anche se la voce è
 * ANCORA ripristinabile. Quel caso lo distingue la UI, non questa funzione:
 * `giorniResiduiCestino(…) === 0 && !cestinoScaduto(…)` vuol dire «meno di un
 * giorno», e va scritto così, mai «0 giorni» (che direbbe il falso nell'altro
 * verso: tutto perso quando invece si fa ancora in tempo).
 *
 * Da scaduto, o con un istante illeggibile, è 0.
 */
export function giorniResiduiCestino(eliminatoIl: Date | string, adesso: Date = new Date()): number {
  const scadenza = scadenzaCestino(eliminatoIl)
  if (!scadenza) return 0
  const restano = scadenza.getTime() - adesso.getTime()
  if (restano <= 0) return 0
  return Math.floor(restano / GIORNO_MS)
}

/** Vero se la voce nel cestino è oltre la custodia (purgabile, non più ripristinabile). */
export function cestinoScaduto(eliminatoIl: Date | string, adesso: Date = new Date()): boolean {
  const scadenza = scadenzaCestino(eliminatoIl)
  if (!scadenza) return false
  return adesso.getTime() >= scadenza.getTime()
}

/**
 * La soglia ISO della purga: si purgano le righe con `eliminato_il` PRIMA di
 * questo istante (`.lt('eliminato_il', sogliaPurgaCestinoRegistro())`).
 */
export function sogliaPurgaCestinoRegistro(adesso: Date = new Date()): string {
  return new Date(adesso.getTime() - GIORNI_CESTINO_REGISTRO * GIORNO_MS).toISOString()
}
