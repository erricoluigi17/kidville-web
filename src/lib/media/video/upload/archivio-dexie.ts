import Dexie, { type EntityTable, type Table } from 'dexie'

import type { ArchivioCaricamentiVideo } from './archivio'
import type { CaricamentoVideoLocale } from './stato'
import { BLOCCO_VIDEO_LOCALE, leggiBloccoBlob, type ByteVideo } from './byte-video'
import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * L'ARCHIVIO SU INDEXEDDB — ciò che rende vero «chiudi l'app e ritrovi il lavoro».
 *
 * ─── PERCHÉ DEXIE, E PERCHÉ UN DATABASE SUO ────────────────────────────────
 *
 * Dexie perché è già il meccanismo di persistenza del repo: `src/lib/offline/db.ts`
 * tiene in IndexedDB le code di scrittura della primaria, il diario, l'armadietto
 * e i media di galleria con byte o Blob legacy. Riusare la
 * stessa libreria significa riusare anche le lezioni che sono costate: gli stati
 * di una riga in coda, il quarto stato che NON si ripesca, il fatto che un campo
 * nuovo non indicizzato non richiede una versione nuova.
 *
 * Un database SUO, e non una v12 di `KidvilleOfflineDB`, per tre ragioni in ordine
 * di peso:
 *
 *  1. **Il peso.** Qui dentro finiscono originali da un gigabyte. `KidvilleOfflineDB`
 *     contiene la coda delle firme dei docenti: se la quota dell'origine si
 *     esaurisce, il browser può sfrattare il database INTERO, e uno sfratto
 *     causato da tre video si porterebbe via le firme del registro. Due database
 *     non rendono la quota più grande, ma rendono lo sfratto selettivo e la
 *     pulizia (`potatura`) indipendente.
 *  2. **La vita.** Le code della primaria vivono finché il server non le accetta;
 *     queste righe hanno un TTL di sette giorni, lo stesso della ritenzione degli
 *     originali sul server. Sono due politiche diverse sullo stesso disco.
 *  3. **Il perimetro di questo microtask.** `src/lib/offline/db.ts` non è un file
 *     di V10, e altri agenti lavorano nello stesso albero: aggiungere lì una v12
 *     sarebbe stato l'unico punto di collisione possibile fra due lavori
 *     paralleli. Se un giorno si deciderà di unificare, questo modulo espone
 *     l'interfaccia `ArchivioCaricamentiVideo` e l'implementazione si sostituisce
 *     senza toccare niente altro.
 *
 * ─── DUE STORE, NON UNO ────────────────────────────────────────────────────
 *
 * `caricamenti` porta i metadati e basta; `byte` porta manifest e blocchi ArrayBuffer,
 * oltre ai Blob legacy. `elenca()` deve
 * poter rispondere a «che cosa è rimasto a metà?» senza materializzare due
 * gigabyte: in un solo store, `toArray()` li leggerebbe tutti.
 */

/**
 * La dichiarazione degli store. È esportata perché sia verificabile: in Dexie una
 * `where('campo')` su un campo non dichiarato non torna vuota, **lancia**
 * `SchemaError` — e lo fa sul telefono di chi carica, mai in un test che non abbia
 * un motore IndexedDB sotto (jsdom non ce l'ha, e `fake-indexeddb` non è
 * installato in questo repo).
 *
 * `stato` e `aggiornatoIl` sono indicizzati perché sono i due campi su cui questo
 * modulo interroga davvero: il primo per ripescare ciò che è rimasto a metà, il
 * secondo per la potatura. Gli altri campi entrano e si rileggono senza essere
 * dichiarati: un object store conserva l'oggetto intero per clonazione
 * strutturata, e la dichiarazione descrive che cosa è INTERROGABILE.
 */
export const SCHEMA_ARCHIVIO_VIDEO = {
  caricamenti: 'jobId, stato, aggiornatoIl',
  byte: 'jobId',
} as const

/** Versione 1: è un database nuovo, non una versione in più di quello condiviso. */
export const VERSIONE_ARCHIVIO_VIDEO = 1

export const NOME_ARCHIVIO_VIDEO = 'KidvilleVideoUploadDB'

type DepositoByte =
  | { jobId: string; blob: Blob }
  | { jobId: string; formato: 'blocchi-v1'; generazione: string; size: number; type: string }
  | { jobId: string; buffer: ArrayBuffer }

type DbCaricamenti = Dexie & {
  caricamenti: EntityTable<CaricamentoVideoLocale, 'jobId'>
  byte: Table<DepositoByte, string>
}

/**
 * Il database si costruisce alla PRIMA chiamata, non all'import.
 *
 * I moduli client di questo repo vengono valutati anche sul server durante il
 * prerender (è la regola 1 di `src/lib/logging/client.ts`, scritta dopo che una
 * `window` a livello di modulo ha fatto fallire `npm run build`). Un `new Dexie()`
 * a livello di modulo non lancia, ma aprirebbe la porta a un `open()` implicito in
 * un posto dove IndexedDB non esiste.
 */
let db: DbCaricamenti | null = null

function apri(): DbCaricamenti {
  if (db) return db
  const creato = new Dexie(NOME_ARCHIVIO_VIDEO) as DbCaricamenti
  creato.version(VERSIONE_ARCHIVIO_VIDEO).stores(SCHEMA_ARCHIVIO_VIDEO)
  db = creato
  return creato
}

export class ArchivioCaricamentiDexie implements ArchivioCaricamentiVideo {
  async leggi(jobId: string): Promise<CaricamentoVideoLocale | undefined> {
    return apri().caricamenti.get(jobId)
  }

  async elenca(): Promise<CaricamentoVideoLocale[]> {
    return apri().caricamenti.toArray()
  }

  async scrivi(riga: CaricamentoVideoLocale): Promise<void> {
    await apri().caricamenti.put(riga)
  }

  async aggiorna(jobId: string, modifiche: Partial<CaricamentoVideoLocale>): Promise<void> {
    // `update` NON crea la riga se non c'è: è la stessa semantica dell'archivio
    // in memoria, e serve che lo sia — una riga inventata da un aggiornamento
    // tardivo sarebbe un caricamento fantasma che nessuno potrà mai riprendere.
    await apri().caricamenti.update(jobId, modifiche)
  }

  async elimina(jobId: string): Promise<void> {
    const d = apri()
    // Una transazione sola: se il browser muore in mezzo, non resta un deposito
    // di byte senza la riga che lo nomina — cioè peso che nessuna potatura trova.
    await d.transaction('rw', d.caricamenti, d.byte, async () => {
      await d.caricamenti.delete(jobId)
      await eliminaDeposito(d, jobId)
    })
  }

  async leggiByte(jobId: string): Promise<ByteVideo | undefined> {
    const d = apri()
    const riga = await d.byte.get(jobId)
    if (!riga) return undefined
    if ('blob' in riga) return riga.blob // Compatibilità con i depositi già installati.
    if (!('formato' in riga) || riga.formato !== 'blocchi-v1') throw new Error('VIDEO_ARCHIVIO_NON_VALIDO')
    return {
      size: riga.size,
      type: riga.type,
      async leggiIntervallo(inizio, fine) {
        if (!Number.isSafeInteger(inizio) || !Number.isSafeInteger(fine)
          || inizio < 0 || fine < inizio || fine > riga.size || fine - inizio > BLOCCO_VIDEO_LOCALE) {
          throw new Error('VIDEO_INTERVALLO_NON_VALIDO')
        }
        const risultato = new Uint8Array(fine - inizio)
        // Si leggono al massimo due blocchi per un offset TUS non allineato.
        for (let offset = inizio; offset < fine;) {
          const indice = Math.floor(offset / BLOCCO_VIDEO_LOCALE)
          const blocco = await d.byte.get(chiaveBlocco(jobId, riga.generazione, indice))
          const attesi = Math.min(BLOCCO_VIDEO_LOCALE, riga.size - indice * BLOCCO_VIDEO_LOCALE)
          if (!blocco || !('buffer' in blocco) || blocco.buffer.byteLength !== attesi) {
            logClient({ livello: 'error', evento: 'offline', messaggio: 'video-upload-blocco-assente', campi: { job_id: jobId, indice } })
            throw new Error('VIDEO_BLOCCO_INCOMPLETO')
          }
          const interno = offset % BLOCCO_VIDEO_LOCALE
          const quanti = Math.min(fine - offset, attesi - interno)
          risultato.set(new Uint8Array(blocco.buffer, interno, quanti), offset - inizio)
          offset += quanti
        }
        return risultato
      },
    }
  }

  async scriviByte(jobId: string, byte: Blob): Promise<void> {
    const d = apri()
    const generazione = crypto.randomUUID()
    try {
      // Manifest e blocchi appartengono alla STESSA transazione: quota esaurita,
      // lettura fallita o chiusura dell'app annullano anche i blocchi parziali e
      // preservano l'eventuale deposito precedente. waitFor tiene viva la TX
      // durante la lettura asincrona della sola fetta (mai del file intero).
      await d.transaction('rw', d.byte, async () => {
        await eliminaDeposito(d, jobId)
        for (let offset = 0; offset < byte.size; offset += BLOCCO_VIDEO_LOCALE) {
          const fine = Math.min(offset + BLOCCO_VIDEO_LOCALE, byte.size)
          const buffer = await Dexie.waitFor(leggiBloccoBlob(byte.slice(offset, fine)))
          if (buffer.byteLength !== fine - offset) throw new Error('VIDEO_BLOCCO_INCOMPLETO')
          await d.byte.put({ jobId: chiaveBlocco(jobId, generazione, offset / BLOCCO_VIDEO_LOCALE), buffer })
        }
        await d.byte.put({ jobId, formato: 'blocchi-v1', generazione, size: byte.size, type: byte.type })
      })
    } catch (err) {
      logClient({ livello: 'error', evento: 'offline', messaggio: 'video-upload-persistenza-fallita', campi: { job_id: jobId, byte: byte.size, error_code: nomeErrore(err) } })
      throw err
    }
  }

  async eliminaByte(jobId: string): Promise<void> {
    const d = apri()
    await d.transaction('rw', d.byte, () => eliminaDeposito(d, jobId))
  }
}

function chiaveBlocco(jobId: string, generazione: string, indice: number): string {
  return `${jobId}:${generazione}:${indice}`
}

async function eliminaDeposito(d: DbCaricamenti, jobId: string): Promise<void> {
  await d.byte.where(':id').startsWith(`${jobId}:`).delete()
  await d.byte.delete(jobId)
}
