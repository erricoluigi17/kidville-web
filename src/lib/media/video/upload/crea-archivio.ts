import { logClient, nomeErrore } from '@/lib/logging/client'

import type { ArchivioCaricamentiVideo } from './archivio'
import { ArchivioCaricamentiDexie } from './archivio-dexie'
import { ArchivioCaricamentiInMemoria } from './archivio-memoria'

/**
 * SCEGLIE DOVE VIVE LO STATO DEI CARICAMENTI — e lo dice quando ripiega.
 *
 * ─── PERCHÉ È ASINCRONA, E PERCHÉ NON BASTA `typeof indexedDB` ──────────────
 *
 * «IndexedDB c'è» e «IndexedDB funziona» sono due domande diverse. In navigazione
 * privata su Safari l'oggetto `indexedDB` esiste e `open()` può essere rifiutato;
 * con lo storage di sito disabilitato in una WebView succede lo stesso; a quota
 * esaurita pure. Un controllo sul `typeof` risponderebbe «sì» e il primo
 * caricamento esploderebbe dentro Dexie, in un punto che di video non sa niente.
 *
 * Perciò si fa una prova vera — una lettura da zero righe — e si decide su quella.
 *
 * ─── IL DECLASSAMENTO NON PUÒ ESSERE MUTO ──────────────────────────────────
 *
 * Con l'archivio in memoria il caricamento funziona finché la pagina resta
 * aperta, e la ripresa dopo la chiusura dell'app non c'è più. È una capacità che
 * manca, cioè la regola 4 di AGENTS.md applicata a una capability invece che a
 * una variabile d'ambiente: senza questa riga, «a quel genitore i video non
 * riprendono mai» non avrebbe nessuna spiegazione da nessuna parte — e sarebbe
 * indistinguibile da un bug nostro.
 *
 * Livello `warn` e non `error` perché non è un guasto: è una condizione del
 * dispositivo, e `logClient` non ha `info` (`warn` è il pavimento, ed è
 * persistito e contabile).
 */
export async function creaArchivioCaricamenti(): Promise<ArchivioCaricamentiVideo> {
  const ripiega = (motivo: string): ArchivioCaricamentiVideo => {
    logClient({
      livello: 'warn',
      evento: 'offline',
      messaggio: 'video-upload-archivio-volatile',
      campi: { motivo },
    })
    return new ArchivioCaricamentiInMemoria()
  }

  if (typeof indexedDB === 'undefined') return ripiega('indexeddb_assente')

  const dexie = new ArchivioCaricamentiDexie()
  try {
    // La prova: se il database non si apre, qui si scopre — non al primo video.
    await dexie.elenca()
    return dexie
  } catch (err) {
    return ripiega(nomeErrore(err))
  }
}
