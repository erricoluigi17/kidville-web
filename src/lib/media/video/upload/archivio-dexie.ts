import Dexie, { type EntityTable } from 'dexie'

import type { ArchivioCaricamentiVideo } from './archivio'
import type { CaricamentoVideoLocale } from './stato'

/**
 * L'ARCHIVIO SU INDEXEDDB — ciò che rende vero «chiudi l'app e ritrovi il lavoro».
 *
 * ─── PERCHÉ DEXIE, E PERCHÉ UN DATABASE SUO ────────────────────────────────
 *
 * Dexie perché è già il meccanismo di persistenza del repo: `src/lib/offline/db.ts`
 * tiene in IndexedDB le code di scrittura della primaria, il diario, l'armadietto
 * e — già oggi — i media di galleria con il loro `file_blob: Blob`. Riusare la
 * stessa libreria significa riusare anche le lezioni che sono costate: gli stati
 * di una riga in coda, il quarto stato che NON si ripesca, il fatto che un campo
 * nuovo non indicizzato non richiede una versione nuova.
 *
 * Un database SUO, e non una v12 di `KidvilleOfflineDB`, per tre ragioni in ordine
 * di peso:
 *
 *  1. **Il peso.** Qui dentro finiscono Blob da un gigabyte. `KidvilleOfflineDB`
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
 * `caricamenti` porta i metadati e basta; `byte` porta i Blob. `elenca()` deve
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

interface DepositoByte {
  jobId: string
  blob: Blob
}

type DbCaricamenti = Dexie & {
  caricamenti: EntityTable<CaricamentoVideoLocale, 'jobId'>
  byte: EntityTable<DepositoByte, 'jobId'>
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
      await d.byte.delete(jobId)
    })
  }

  async leggiByte(jobId: string): Promise<Blob | undefined> {
    const riga = await apri().byte.get(jobId)
    return riga?.blob
  }

  async scriviByte(jobId: string, byte: Blob): Promise<void> {
    await apri().byte.put({ jobId, blob: byte })
  }

  async eliminaByte(jobId: string): Promise<void> {
    await apri().byte.delete(jobId)
  }
}
