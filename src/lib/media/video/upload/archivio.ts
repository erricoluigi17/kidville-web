import type { CaricamentoVideoLocale } from './stato'
import type { ByteVideo } from './byte-video'

/**
 * L'ARCHIVIO DEI CARICAMENTI — l'interfaccia, non l'implementazione.
 *
 * Esiste come interfaccia per due ragioni, entrambe misurate:
 *
 *  1. **Il collaudo senza rete e senza motore.** In questo repo jsdom non ha
 *     IndexedDB e `fake-indexeddb` non è installato (né si può installare: un
 *     `npm install` qui ha già rotto la CI, perché npm 11 pota dal lock le voci
 *     che l'npm 10 della CI esige). Senza un'interfaccia, la logica di ripresa
 *     sarebbe collaudabile solo su un dispositivo vero — cioè in M12, cioè
 *     troppo tardi.
 *
 *  2. **Il ripiego quando IndexedDB non c'è.** Non è teorico: in navigazione
 *     privata su iOS l'apertura di un database può essere rifiutata, e una
 *     WebView con lo storage disabilitato la rifiuta sempre. Con un'interfaccia
 *     il caricamento continua a funzionare per la sessione in corso e si perde
 *     solo la durabilità; senza, esploderebbe alla prima scrittura.
 *
 * ─── I BYTE STANNO A PARTE, E NON È UNA RAFFINATEZZA ────────────────────────
 *
 * Un originale arriva a 2.000.000.000 byte. `elenca()` risponde alla domanda
 * «che cosa è rimasto a metà?», e deve poterlo fare senza tirare in memoria i
 * Blob di tre video: su un telefono, leggere due gigabyte per contare tre righe
 * non è lento, è un crash. Perciò due depositi e quattro metodi separati.
 */
export interface ArchivioCaricamentiVideo {
  leggi(jobId: string): Promise<CaricamentoVideoLocale | undefined>
  elenca(): Promise<CaricamentoVideoLocale[]>
  scrivi(riga: CaricamentoVideoLocale): Promise<void>
  /** Aggiorna i campi indicati. Una riga che non c'è NON viene inventata. */
  aggiorna(jobId: string, modifiche: Partial<CaricamentoVideoLocale>): Promise<void>
  /** Toglie la riga E i suoi byte: un deposito orfano è peso che nessuno trova. */
  elimina(jobId: string): Promise<void>

  leggiByte(jobId: string): Promise<ByteVideo | undefined>
  /**
   * Copia i byte sul dispositivo, perché la ripresa dopo la chiusura dell'app abbia
   * qualcosa da spedire.
   *
   * ─── IL SEGNALE, E PERCHÉ LA COPIA NON È PIÙ DOVUTA ──────────────────────────
   *
   * Dal 2026-10-02 la copia parte IN BACKGROUND, mentre il trasferimento è già in
   * corso (`caricamento.ts`): non è più il cancello d'ingresso del video, ed è
   * quindi un lavoro che può diventare inutile prima di finire. Succede in due modi
   * — il trasferimento arriva in fondo prima della copia (rete veloce, disco lento),
   * oppure la persona toglie il video — e in entrambi continuare vorrebbe dire
   * scrivere gigabyte che un attimo dopo si cancellano, su un telefono che magari
   * non ne ha.
   *
   * Un segnale già annullato, o annullato a metà, ferma la copia al confine del
   * blocco successivo, toglie ciò che questa copia aveva scritto e rigetta con
   * `ErroreByteVideo('VIDEO_COPIA_ANNULLATA')`: non è un guasto, e chi lo riceve non
   * lo scrive fra gli errori. Un deposito PRECEDENTE e intero resta com'era.
   */
  scriviByte(jobId: string, byte: Blob, segnale?: AbortSignal): Promise<void>
  /** Libera il peso lasciando la riga: è ciò che succede a caricamento finito. */
  eliminaByte(jobId: string): Promise<void>
  /**
   * Toglie i depositi di byte che nessuna riga nomina più (una scrittura interrotta
   * dalla chiusura dell'app). Facoltativo: l'archivio in memoria non ne lascia.
   */
  potaDepositiOrfani?(): Promise<number>
}
