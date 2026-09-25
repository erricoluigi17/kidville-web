import Dexie, { type EntityTable, type Table } from 'dexie'

import type { ArchivioCaricamentiVideo } from './archivio'
import type { CaricamentoVideoLocale } from './stato'
import {
  BLOCCO_VIDEO_LOCALE,
  ErroreByteVideo,
  LETTURA_VIDEO_MASSIMA,
  leggiBloccoBlob,
  type ByteVideo,
  type ByteVideoPersistenti,
} from './byte-video'
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
 * `caricamenti` porta i metadati e basta; `byte` porta il MANIFEST di ogni deposito
 * (e i Blob legacy delle versioni precedenti). `elenca()` deve poter rispondere a
 * «che cosa è rimasto a metà?» senza materializzare due gigabyte.
 *
 * ─── I BLOCCHI IN UN DATABASE PER JOB, SCRITTI A TRANSAZIONI BREVI ─────────
 *
 * WebKit rifiuta i Blob in IndexedDB (`UnknownError: Error preparing Blob/File
 * data to be stored in object store`): l'originale si salva in blocchi ArrayBuffer.
 * Tre misure del 2026-09-26, sul modulo vero in WebKit e Chromium, hanno deciso
 * come:
 *
 *  - **Una transazione per blocco, non una per video.** La transazione unica
 *    raddoppiava il disco su WebKit (il WAL cresce di 1× prima del checkpoint),
 *    teneva in memoria su Chromium tutto il video fino al commit (75 → 900 MB a
 *    800 MiB) e, abortita dall'esterno mentre `Dexie.waitFor` aspettava una fetta,
 *    restava appesa per sempre senza un log.
 *  - **Un database per job**, cancellato con `deleteDatabase` quando il deposito
 *    non serve più. Su WebKit IndexedDB è SQLite senza `auto_vacuum`: cancellare le
 *    righe lascia il file grande quanto il video più grosso mai salvato (420 MB
 *    dopo aver tolto un deposito da 400 MiB); cancellare il database lo riporta a
 *    272 KB.
 *  - **Il manifest si scrive per ultimo**, nel database principale, e sostituisce
 *    in un colpo solo il deposito precedente: finché non c'è, chi legge vede ancora
 *    la generazione vecchia, intera. Un'interruzione lascia al massimo blocchi di
 *    una generazione mai pubblicata, che la potatura trova e cancella.
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

/** Il database dei blocchi di UN job: `KidvilleVideoByte-<jobId>`. */
export const PREFISSO_DEPOSITO_VIDEO = 'KidvilleVideoByte-'

/**
 * Un deposito orfano più giovane di così non si tocca: potrebbe essere la scrittura
 * in corso di un'altra scheda dello stesso browser, che il manifest non l'ha ancora.
 */
export const ETA_MINIMA_ORFANO_MS = 60 * 60 * 1000

interface ManifestBlocchi {
  jobId: string
  formato: 'blocchi-v2'
  generazione: string
  size: number
  type: string
  dimensioneBlocco: number
}

type DepositoByte = { jobId: string; blob: Blob } | ManifestBlocchi

interface BloccoVideo {
  chiave: string
  buffer: ArrayBuffer
}

type DbCaricamenti = Dexie & {
  caricamenti: EntityTable<CaricamentoVideoLocale, 'jobId'>
  byte: Table<DepositoByte, string>
}

type DbDeposito = Dexie & { blocchi: Table<BloccoVideo, string> }

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

const depositiAperti = new Map<string, DbDeposito>()

/**
 * `autoOpen: false` di proposito: se un'altra scheda cancella il deposito, Dexie
 * chiude la connessione, e una scrittura in corso deve FALLIRE (e dirlo) invece di
 * ricreare in silenzio un database vuoto e continuare a scriverci dentro.
 */
async function apriDeposito(jobId: string): Promise<DbDeposito> {
  let deposito = depositiAperti.get(jobId)
  if (!deposito || !deposito.isOpen()) {
    deposito = new Dexie(`${PREFISSO_DEPOSITO_VIDEO}${jobId}`, { autoOpen: false }) as DbDeposito
    deposito.version(1).stores({ blocchi: 'chiave' })
    depositiAperti.set(jobId, deposito)
    await deposito.open()
  }
  return deposito
}

/**
 * Il deposito da cui LEGGERE: se la connessione non è aperta lo si riapre solo se
 * un manifest lo nomina ancora. Aprire un database che non c'è lo crea vuoto, e
 * un lettore rimasto indietro lascerebbe dietro di sé database fantasma.
 */
async function depositoPerLettura(jobId: string): Promise<DbDeposito | null> {
  const aperto = depositiAperti.get(jobId)
  if (aperto?.isOpen()) return aperto
  if (!eManifest(await apri().byte.get(jobId))) return null
  return apriDeposito(jobId)
}

async function cancellaDeposito(jobId: string): Promise<void> {
  const aperto = depositiAperti.get(jobId)
  depositiAperti.delete(jobId)
  aperto?.close()
  try {
    await Dexie.delete(`${PREFISSO_DEPOSITO_VIDEO}${jobId}`)
  } catch (err) {
    // Non si rilancia: la riga è già stata tolta, e un database rimasto lo ritrova
    // `potaDepositiOrfani`. Ma deve restarne traccia: è spazio sul telefono.
    segnalaDeposito('warn', 'video-upload-deposito-non-rimosso', jobId, { error_code: nomeErrore(err) })
  }
}

/**
 * Le scritture e le cancellazioni dello stesso job vanno in fila: un doppio tocco
 * che riaccoda mentre la prima copia è a metà cancellerebbe i blocchi dell'altra.
 */
const codaPerJob = new Map<string, Promise<unknown>>()
const scrittureInCorso = new Set<string>()

function inFila<T>(jobId: string, operazione: () => Promise<T>): Promise<T> {
  const precedente = codaPerJob.get(jobId) ?? Promise.resolve()
  // L'esito della precedente l'ha già ricevuto (e loggato) chi l'aveva chiesta:
  // qui serve solo sapere quando è finita.
  const risultato = precedente.then(operazione, operazione)
  const fine = risultato.then(() => undefined, () => undefined)
  codaPerJob.set(jobId, fine)
  void fine.then(() => {
    if (codaPerJob.get(jobId) === fine) codaPerJob.delete(jobId)
  })
  return risultato
}

function nuovaGenerazione(): string {
  // Il tempo in testa serve alla potatura degli orfani (`ETA_MINIMA_ORFANO_MS`).
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`
}

function etaGenerazione(generazione: string): number {
  const nata = parseInt(generazione.split('-')[0] ?? '', 36)
  return Number.isFinite(nata) ? Date.now() - nata : Number.POSITIVE_INFINITY
}

function chiaveBlocco(generazione: string, indice: number): string {
  return `${generazione}:${indice}`
}

function eManifest(riga: DepositoByte | undefined): riga is ManifestBlocchi {
  return !!riga && 'formato' in riga && riga.formato === 'blocchi-v2'
    && typeof riga.generazione === 'string' && Number.isSafeInteger(riga.size) && riga.size >= 0
    && Number.isSafeInteger(riga.dimensioneBlocco) && riga.dimensioneBlocco > 0
}

/** Il `jobId` sta nel messaggio: la deduplica di `logClient` ignora i campi. */
function segnalaDeposito(
  livello: 'warn' | 'error',
  messaggio: string,
  jobId: string,
  campi: Record<string, string | number | boolean>,
): void {
  logClient({ livello, evento: 'offline', messaggio: `${messaggio}: job=${jobId}`, campi })
}

/** Dexie avvolge un abort nella causa vera (`inner`): è quella che dice «quota». */
function causaInterna(err: unknown): string | null {
  const interno = (err as { inner?: unknown } | null | undefined)?.inner
  return interno ? nomeErrore(interno) : null
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
    await inFila(jobId, async () => {
      const d = apri()
      // Riga e manifest insieme: se il browser muore in mezzo non resta un
      // manifest senza la riga che lo nomina. I blocchi vanno via dopo, con il
      // loro database; se non ci riescono li ritrova la potatura degli orfani.
      await d.transaction('rw', d.caricamenti, d.byte, async () => {
        await d.caricamenti.delete(jobId)
        await d.byte.delete(jobId)
      })
      await cancellaDeposito(jobId)
    })
  }

  async leggiByte(jobId: string): Promise<ByteVideo | undefined> {
    const riga = await apri().byte.get(jobId)
    if (!riga) return undefined
    if ('blob' in riga) return riga.blob // Compatibilità con i depositi già installati.
    if (!eManifest(riga)) {
      segnalaDeposito('error', 'video-upload-archivio-non-valido', jobId, {})
      throw new ErroreByteVideo('VIDEO_ARCHIVIO_NON_VALIDO')
    }
    return sorgenteDeposito(jobId, riga)
  }

  async scriviByte(jobId: string, byte: Blob): Promise<void> {
    await inFila(jobId, async () => {
      scrittureInCorso.add(jobId)
      let generazione: string | null = null
      let deposito: DbDeposito | null = null
      let precedente: DepositoByte | undefined
      try {
        generazione = nuovaGenerazione()
        precedente = await apri().byte.get(jobId)
        // Prima di copiare si toglie ciò che nessun manifest nomina: i blocchi di
        // una copia interrotta dalla chiusura dell'app. Lasciati lì, si sommerebbero
        // alla copia nuova proprio sul telefono che ha poco spazio.
        if (!eManifest(precedente)) await cancellaDeposito(jobId)
        deposito = await apriDeposito(jobId)
        if (eManifest(precedente)) await rimuoviAltreGenerazioni(jobId, deposito, precedente.generazione)
        // Una fetta alla volta, ciascuna nella propria transazione: in memoria c'è
        // al massimo un blocco, e ogni commit libera ciò che ha scritto.
        for (let indice = 0, offset = 0; offset < byte.size; indice++, offset += BLOCCO_VIDEO_LOCALE) {
          const fine = Math.min(offset + BLOCCO_VIDEO_LOCALE, byte.size)
          const buffer = await leggiBloccoBlob(byte.slice(offset, fine))
          if (buffer.byteLength !== fine - offset) throw new ErroreByteVideo('VIDEO_BLOCCO_INCOMPLETO')
          await deposito.blocchi.put({ chiave: chiaveBlocco(generazione, indice), buffer })
        }
        const manifest: ManifestBlocchi = {
          jobId, formato: 'blocchi-v2', generazione, size: byte.size, type: byte.type, dimensioneBlocco: BLOCCO_VIDEO_LOCALE,
        }
        // Il momento in cui il deposito nuovo esiste: prima di qui, chi legge vede
        // ancora quello vecchio, intero.
        await apri().byte.put(manifest)
      } catch (err) {
        segnalaDeposito('error', 'video-upload-persistenza-fallita', jobId, {
          byte: byte.size,
          error_code: nomeErrore(err),
          ...(causaInterna(err) ? { causa: causaInterna(err)! } : {}),
        })
        // Senza un deposito precedente da conservare il database del job se ne va
        // INTERO: su WebKit togliere le righe non libera il disco, e con il telefono
        // pieno anche la riga del caricamento — che in memoria non ci sta — non
        // si scriverebbe più (misurato: 774 MB rimasti, 16 MB liberi).
        if (!eManifest(precedente)) await cancellaDeposito(jobId)
        else if (deposito && generazione) await rimuoviGenerazione(jobId, deposito, generazione)
        throw err
      } finally {
        scrittureInCorso.delete(jobId)
      }
      // Le generazioni precedenti non le legge più nessuno di nuovo. Un lettore già
      // partito su una di quelle rilegge il manifest e passa a questa.
      await rimuoviAltreGenerazioni(jobId, deposito, generazione)
    })
  }

  async eliminaByte(jobId: string): Promise<void> {
    await inFila(jobId, async () => {
      await apri().byte.delete(jobId)
      await cancellaDeposito(jobId)
    })
  }

  /**
   * I database di blocchi che nessun manifest nomina — una scrittura interrotta
   * dalla chiusura dell'app, o un `deleteDatabase` che non è riuscito. Solo se
   * vecchi abbastanza da non poter essere la scrittura in corso di un'altra scheda.
   */
  async potaDepositiOrfani(): Promise<number> {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return 0
    const d = apri()
    const nomi = (await indexedDB.databases())
      .map((info) => info.name ?? '')
      .filter((nome) => nome.startsWith(PREFISSO_DEPOSITO_VIDEO))
    let rimossi = 0
    for (const nome of nomi) {
      const jobId = nome.slice(PREFISSO_DEPOSITO_VIDEO.length)
      if (scrittureInCorso.has(jobId)) continue
      // La decisione si prende DENTRO la fila del job: presa fuori, una copia
      // conclusa nel frattempo verrebbe cancellata sulla base di una foto vecchia.
      const rimosso = await inFila(jobId, async () => {
        const [manifest, riga] = await Promise.all([d.byte.get(jobId), d.caricamenti.get(jobId)])
        if (eManifest(manifest) && riga) return false
        if (eManifest(manifest) && etaGenerazione(manifest.generazione) < ETA_MINIMA_ORFANO_MS) return false
        if (!eManifest(manifest) && (await generazionePiuGiovane(jobId)) < ETA_MINIMA_ORFANO_MS) return false
        if (eManifest(manifest)) await d.byte.delete(jobId)
        await cancellaDeposito(jobId)
        return true
      })
      if (rimosso) rimossi++
    }
    return rimossi
  }
}

/** L'età della scrittura più recente in un deposito senza manifest. */
async function generazionePiuGiovane(jobId: string): Promise<number> {
  const deposito = await apriDeposito(jobId)
  const chiavi = (await deposito.blocchi.toCollection().primaryKeys()) as string[]
  if (chiavi.length === 0) return Number.POSITIVE_INFINITY
  return Math.min(...chiavi.map((chiave) => etaGenerazione(chiave.split(':')[0] ?? '')))
}

async function rimuoviGenerazione(jobId: string, deposito: DbDeposito, generazione: string): Promise<void> {
  try {
    await deposito.blocchi.where('chiave').between(`${generazione}:`, `${generazione}:￿`, true, true).delete()
  } catch (err) {
    segnalaDeposito('warn', 'video-upload-blocchi-parziali-rimasti', jobId, { error_code: nomeErrore(err) })
  }
}

async function rimuoviAltreGenerazioni(jobId: string, deposito: DbDeposito | null, generazione: string | null): Promise<void> {
  if (!deposito || !generazione) return
  try {
    await deposito.transaction('rw', deposito.blocchi, async () => {
      await deposito.blocchi.where('chiave').below(`${generazione}:`).delete()
      await deposito.blocchi.where('chiave').above(`${generazione}:￿`).delete()
    })
  } catch (err) {
    // Il deposito nuovo è già valido: i blocchi vecchi rimasti se ne vanno con il
    // database a caricamento finito.
    segnalaDeposito('warn', 'video-upload-generazione-vecchia-rimasta', jobId, { error_code: nomeErrore(err) })
  }
}

function sorgenteDeposito(jobId: string, iniziale: ManifestBlocchi): ByteVideoPersistenti {
  let manifest = iniziale
  return {
    size: iniziale.size,
    type: iniziale.type,
    async leggiIntervallo(inizio, fine) {
      if (!Number.isSafeInteger(inizio) || !Number.isSafeInteger(fine)
        || inizio < 0 || fine < inizio || fine > manifest.size || fine - inizio > LETTURA_VIDEO_MASSIMA) {
        segnalaDeposito('error', 'video-upload-intervallo-non-valido', jobId, { inizio, fine, byte: manifest.size })
        throw new ErroreByteVideo('VIDEO_INTERVALLO_NON_VALIDO')
      }
      const risultato = new Uint8Array(fine - inizio)
      let riletto = false
      for (let offset = inizio; offset < fine;) {
        const dimensione = manifest.dimensioneBlocco
        const indice = Math.floor(offset / dimensione)
        const attesi = Math.min(dimensione, manifest.size - indice * dimensione)
        let blocco: BloccoVideo | undefined
        try {
          const deposito = await depositoPerLettura(jobId)
          blocco = deposito ? await deposito.blocchi.get(chiaveBlocco(manifest.generazione, indice)) : undefined
        } catch (err) {
          // Transitorio (su iOS: «Connection to Indexed Database server lost» dopo
          // una sospensione): chi carica riprova più tardi, i byte sono ancora lì.
          segnalaDeposito('error', 'video-upload-lettura-deposito-fallita', jobId, { indice, error_code: nomeErrore(err) })
          throw err
        }
        if (!blocco || blocco.buffer.byteLength !== attesi) {
          // Una riscrittura dello stesso video (doppia selezione) può aver sostituito
          // la generazione sotto questo lettore: se il manifest nuovo descrive lo
          // stesso file, si prosegue su quello.
          const attuale = await apri().byte.get(jobId)
          if (!riletto) {
            riletto = true
            if (eManifest(attuale) && attuale.generazione !== manifest.generazione
              && attuale.size === manifest.size && attuale.type === manifest.type) {
              manifest = attuale
              continue
            }
          }
          if (!eManifest(attuale)) {
            // Non è un guasto dei byte: il deposito è stato tolto (caricamento
            // annullato o concluso altrove). Il lettore si ferma e basta.
            segnalaDeposito('warn', 'video-upload-deposito-rimosso', jobId, { indice })
          } else {
            segnalaDeposito('error', 'video-upload-blocco-assente', jobId, { indice })
          }
          throw new ErroreByteVideo('VIDEO_BLOCCO_INCOMPLETO')
        }
        const interno = offset - indice * dimensione
        const quanti = Math.min(fine - offset, attesi - interno)
        risultato.set(new Uint8Array(blocco.buffer, interno, quanti), offset - inizio)
        offset += quanti
      }
      return risultato
    },
  }
}
