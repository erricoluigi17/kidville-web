'use client'

import { Capacitor, registerPlugin } from '@capacitor/core'
import { nomeErrore } from '@/lib/logging/client'
import { isNativeApp } from '@/lib/push/native-register'
import { condividiFileLocale, condividiLink } from './share'

/**
 * SCARICARE UN FILE DALL'APP — e perché non è un `<a download>`.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * IL DIFETTO CHE QUESTO MODULO VIENE A CHIUDERE
 *
 * Lato genitore, in galleria, «Condividi» funzionava e «Scarica» non faceva
 * niente. Il codice (duplicato in due punti di `MediaGrid`) faceva:
 *
 *     const blob = await (await fetch(url)).blob()
 *     a.href = URL.createObjectURL(blob); a.download = caption; a.click()
 *     … catch → window.open(url, '_blank')
 *
 * Tre cose, tutte silenziose:
 *
 *  1. NELLA WEBVIEW CAPACITOR `a.click()` SU UN `blob:` NON SCARICA E NON
 *     LANCIA. Android non ha un `DownloadListener` registrato, iOS/WKWebView
 *     ignora l'attributo. Il gesto non ha effetto e non ha errore: il `catch`
 *     resta chiuso e non c'è niente da loggare.
 *  2. IL RIPIEGO ERA MUTO A SUA VOLTA. `window.open(url,'_blank')` nella WebView
 *     non apre niente — `capacitor.config.ts` non abilita le finestre multiple —
 *     e `window.open` non lancia: ritorna `null`.
 *  3. IL NOME DEL FILE NON AVEVA ESTENSIONE: era `caption || 'scaricato-da-
 *     kidville'`, cioè testo scritto da un'insegnante. Su nativo quel testo
 *     diventa un PERCORSO, e una barra dentro la didascalia lo fa fallire.
 *
 * ─── LA PARTE MISURATA, che corregge la diagnosi ─────────────────────────────
 * «Il catch non scatta mai» è FALSO, e lo dice la produzione: il 2026-09-05 alle
 * 07:18:00.561 `app_log` ha una riga `gallery-download-diretto-fallito` (iOS) e
 * ALLO STESSO MILLESIMO una riga del patch di `fetch`:
 * `GET /storage/v1/object/sign/gallery/… — Load failed`, `stato_http = 0`.
 * Cioè in quel caso è morta la `fetch` PRIMA dell'ancora: l'indirizzo firmato di
 * Supabase è CROSS-ORIGIN, e in WebView una richiesta del genere può non partire
 * affatto. Il ramo d'errore esisteva; era inutile, perché ripiegava sul nulla e
 * perché la riga di log non portava il motivo (`contesto: {}`, `codice: null`) —
 * dice che qualcosa non è riuscito, non dice cosa.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * COME SI SCARICA, QUI
 *
 *  • NATIVO → i byte si scrivono in `Directory.Cache` con `@capacitor/filesystem`
 *    e il file si passa al foglio di sistema (`Share.share({ files })`). Sul
 *    telefono QUELLO è il gesto che l'utente riconosce come «salva»: da lì
 *    «Salva immagine», «Salva su File», WhatsApp. `Cache` e non `Documents`
 *    perché è la cartella che il sistema può ripulire da sé e non chiede
 *    permessi di archiviazione: il file serve il tempo di consegnarlo.
 *  • WEB → `<a download>` su un `blob:`, che è SAME-ORIGIN. È il contrario di un
 *    dettaglio: con l'href firmato di Supabase l'attributo `download` sarebbe
 *    ignorato per specifica (è fuori origine) e il browser navigherebbe.
 *  • QUANDO LA STRADA PRINCIPALE NON RIESCE si ripiega su `condividi({ url })`,
 *    che nella WebView è l'unico gesto che si è visto funzionare davvero, e sul
 *    web copia il link negli appunti. Non si ripiega MAI sul silenzio — e il
 *    verdetto dice PER QUALE DEI DUE si è passati (`ripiego-condivisione` contro
 *    `ripiego-appunti`), perché il foglio si vede e la copia no: senza quella
 *    distinzione il ramo degli appunti sarebbe un pulsante muto, cioè il difetto
 *    di partenza spostato più in là.
 *
 * NON LANCIA MAI: chi chiama riceve un verdetto e lo LOGGA — successo compreso.
 * Senza la riga del successo, «nessun log» non distingue «va tutto bene» da «non
 * è mai partito niente», che è precisamente il modo in cui questo guasto è
 * rimasto in piedi.
 *
 * ⚠️ IL PLUGIN LO FORNISCE IL NATIVO, non `package.json`. Dichiararlo fra le
 * dipendenze non basta: finché `npx cap sync` non l'ha registrato nei progetti,
 * `Capacitor.isPluginAvailable('Filesystem')` risponde `false`, `scaricaSuNativo`
 * esce alla prima riga e OGNI «Scarica» finisce sul ripiego — cioè apre il foglio
 * di condivisione col link, che è già quello che fa il pulsante «Condividi»
 * accanto. Non è un'ipotesi: il 2026-09-06 il pacchetto era in `package.json` e
 * in `node_modules`, e nei tre file nativi TRACCIATI `grep -i filesystem` dava
 * ZERO occorrenze, mentre share, camera, push, splash, status-bar, badge e
 * biometric-auth c'erano tutti. Ora c'è — sei righe fra
 * `android/capacitor.settings.gradle`, `android/app/capacitor.build.gradle` e
 * `ios/App/CapApp-SPM/Package.swift` — e a tenercelo c'è un lock:
 * `__tests__/architecture/plugin-capacitor-registrati.test.ts`. Si risincronizza
 * con `npm run rilascio:sync`, MAI con `npx cap sync android`: quello riscrive
 * una piattaforma sola e lascia l'altra indietro.
 *
 * Nessun `import` statico del pacchetto, di proposito — vedi `plugin()`.
 */

/* ════════════════════════════════════════════════════════════════════════════
 * Il plugin, senza dipendere dal pacchetto npm
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Il ponte con il plugin nativo si apre con `registerPlugin` di
 * `@capacitor/core` — che è già installato — invece che importando
 * `@capacitor/filesystem`.
 *
 * NON è un'astuzia: è ciò che `@capacitor/filesystem` fa nel proprio `index.ts`,
 * e ciò che tiene VERDI build, `tsc` e la suite mentre il pacchetto non è ancora
 * in `node_modules`. Un `await import('@capacitor/filesystem')` dentro un
 * try/catch NON basterebbe: il bundler risolve i moduli a COMPILAZIONE, e un
 * modulo assente fa fallire `npm run build`, non il `catch`.
 *
 * La disponibilità vera si chiede a `Capacitor.isPluginAvailable`, che risponde
 * `true` solo se l'implementazione nativa è registrata sul dispositivo.
 */
interface FilesystemMinimo {
  writeFile(opzioni: {
    path: string
    data: string
    directory: string
    recursive?: boolean
  }): Promise<{ uri?: string }>
  getUri(opzioni: { path: string; directory: string }): Promise<{ uri?: string }>
}

/**
 * `Directory.Cache` dell'enum di `@capacitor/filesystem`, sul filo, è la stringa
 * `'CACHE'`. Sta scritta a mano perché il pacchetto non è importabile da qui
 * (vedi sopra): se un giorno lo diventasse, questa costante va sostituita
 * dall'enum vero, che è l'unica fonte che non può sbagliarsi.
 */
const DIRECTORY_CACHE = 'CACHE'

const NOME_PLUGIN = 'Filesystem'

/**
 * `registerPlugin` avvisa in console se lo stesso nome viene registrato due
 * volte, quindi si chiama una sola volta e si tiene il proxy. Pigra e non a
 * livello di modulo: i moduli client vengono valutati anche sul server durante
 * il prerender, e quello che tocca il bridge non deve girare lì.
 */
let proxyFilesystem: FilesystemMinimo | null = null
function plugin(): FilesystemMinimo {
  if (!proxyFilesystem) proxyFilesystem = registerPlugin<FilesystemMinimo>(NOME_PLUGIN)
  return proxyFilesystem
}

function pluginDisponibile(): boolean {
  try {
    return Capacitor.isPluginAvailable(NOME_PLUGIN)
  } catch {
    // IL SILENZIO È AMMESSO QUI, e va detto perché (§6 di AGENTS.md): se il
    // bridge non risponde, il plugin non c'è — e l'esito NON si perde. Trenta
    // righe più giù `scaricaSuNativo` traduce questo `false` in
    // `ripiego(input, 'plugin-filesystem-assente')`, che diventa una riga
    // `gallery-scarico-ripiego-*: plugin-filesystem-assente` in `app_log`,
    // scritta da chi chiama. Loggare anche da qui sarebbe la stessa notizia due
    // volte, e da un modulo che non conosce la rotta in cui si trova.
    return false
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * Il verdetto
 * ════════════════════════════════════════════════════════════════════════════ */

export type EsitoScarico =
  /** Byte scritti sul dispositivo e consegnati al foglio di sistema. */
  | 'nativo-file'
  /** Ancora `download` su un `blob:` same-origin: la strada del browser vero. */
  | 'web-blob'
  /**
   * La strada principale non è riuscita e si è condiviso il link CON UN FOGLIO,
   * che l'utente VEDE. Il `motivo` dice perché ci si è arrivati.
   */
  | 'ripiego-condivisione'
  /**
   * Come sopra, ma il link è finito NEGLI APPUNTI — e la copia negli appunti è
   * MUTA. Distinto da `ripiego-condivisione` perché per l'utente i due casi non
   * si assomigliano affatto: col foglio vede qualcosa succedere, con gli appunti
   * ha premuto «Scarica», non ha il file, e sullo schermo non cambia niente —
   * cioè di nuovo il pulsante rotto da cui è nato tutto questo modulo. Chi chiama
   * deve AVVISARE su questo ramo; la condizione la decide `condividiLink`, che la
   * distingue già (`EsitoCondivisione`), e da oggi non si perde per strada.
   *
   * Dove capita, in concreto: web senza Web Share API (Firefox su desktop) con
   * l'indirizzo firmato scaduto. Su nativo NON capita — lì `condividiLink` apre
   * il foglio di Capacitor — quindi sul telefono il ripiego resta
   * `ripiego-condivisione`.
   */
  | 'ripiego-appunti'
  /** Nemmeno il ripiego: l'utente non ha ottenuto niente. È l'unico caso da `error`. */
  | 'non-riuscito'

export interface RisultatoScarico {
  esito: EsitoScarico
  /**
   * Il perché, in forma di TOKEN: `nomeErrore()` (solo il `name`), `http-<n>`, o
   * una causa nostra. Mai il messaggio dell'errore, mai l'URL, mai il nome del
   * file — la didascalia di una foto può contenere il nome di un bambino, e da
   * qui si va dritti in `app_log`.
   */
  motivo?: string
}

export interface ScaricoInput {
  /** L'indirizzo FIRMATO del media (cross-origin, a tempo). */
  url: string
  /** Il nome che il file avrà, estensione compresa: vedi `nomeFileScarico`. */
  nomeFile: string
  titolo?: string
}

/* ════════════════════════════════════════════════════════════════════════════
 * Il nome del file
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Le estensioni che ci si aspetta di trovare nel bucket. È una lista bianca, non
 * un filtro di comodo: dal percorso di un URL può uscire qualunque cosa, e
 * quella stringa finisce in un nome di file sul dispositivo di un genitore.
 */
const ESTENSIONI_NOTE = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'avif', 'bmp',
  'mp4', 'mov', 'm4v', 'webm', '3gp', 'mkv',
])

/**
 * L'estensione del file, dal percorso dell'indirizzo firmato; in mancanza, dal
 * tipo dichiarato dalla riga (`foto` / `video`).
 *
 * In produzione, misurato il 2026-09-05, le 301 righe di `galleria_media_v2`
 * sono TUTTE `.jpg` — quindi il percorso la porta sempre. Il ripiego serve alle
 * righe storiche e a un domani in cui il bucket riceva altro: un file senza
 * estensione, su Android, non lo apre nessuna galleria.
 */
export function estensioneMedia(url: string, fileType: string): string {
  const percorso = (url ?? '').split(/[?#]/)[0]
  const ultimo = percorso.slice(percorso.lastIndexOf('/') + 1)
  const punto = ultimo.lastIndexOf('.')
  if (punto > 0) {
    const estensione = ultimo.slice(punto + 1).toLowerCase()
    if (ESTENSIONI_NOTE.has(estensione)) return estensione
  }
  return (fileType ?? '').trim().toLowerCase() === 'video' ? 'mp4' : 'jpg'
}

/** Oltre questa lunghezza il nome si tronca: alcuni filesystem si fermano a 255 byte. */
const BASE_MAX = 60

/**
 * Il nome del file da consegnare al dispositivo.
 *
 * PRIMA era `item.caption || 'scaricato-da-kidville'`, cioè testo libero scritto
 * da un'insegnante, SENZA ESTENSIONE. Due guasti in una riga: un file `.jpg`
 * senza estensione non si apre da solo, e una didascalia con una barra (o un
 * `..`) su nativo non è un nome, è un PERCORSO — `writeFile` lo rifiuta, o
 * peggio lo interpreta.
 *
 * La didascalia si tiene: è ciò che rende riconoscibile la foto nel rullino di
 * chi la scarica. Si tiene RIPULITA.
 */
export function nomeFileScarico(
  didascalia: string | null | undefined,
  url: string,
  fileType: string,
): string {
  const estensione = estensioneMedia(url, fileType)
  const predefinito =
    (fileType ?? '').trim().toLowerCase() === 'video' ? 'kidville-video' : 'kidville-foto'
  const base = ripulisciNome(didascalia) || predefinito
  return base.toLowerCase().endsWith(`.${estensione}`) ? base : `${base}.${estensione}`
}

function ripulisciNome(valore: string | null | undefined): string {
  return (valore ?? '')
    .normalize('NFC')
    // Caratteri di controllo: in un nome di file non hanno senso e in un log
    // sarebbero un a-capo, cioè una riga falsa.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    // Separatori di percorso e caratteri che i filesystem rifiutano.
    .replace(/[\\/:*?"<>|]/g, ' ')
    // I PUNTI DOPPI, ovunque stiano, e non solo in testa. Togliendo le barre,
    // `../../etc/passwd` diventa `.. .. etc passwd`: le barre non ci sono più,
    // ma il token `..` sì — e un nome che contiene `..` è un nome che qualcuno,
    // un giorno, ricomporrà in un percorso. Il test lo ha trovato al primo giro.
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Un nome che comincia per punto è un file nascosto.
    .replace(/^[.\s]+/, '')
    .slice(0, BASE_MAX)
    .trim()
    // Windows non ammette punto o spazio finali; e un punto finale creerebbe
    // «nome..jpg» una riga più in là.
    .replace(/[. ]+$/, '')
}

/* ════════════════════════════════════════════════════════════════════════════
 * Lo scarico
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Scarica un media. NON LANCIA MAI e non è mai muta: ogni strada finisce in un
 * `RisultatoScarico` che chi chiama deve loggare.
 */
export async function scarica(input: ScaricoInput): Promise<RisultatoScarico> {
  return isNativeApp() ? scaricaSuNativo(input) : scaricaSuWeb(input)
}

async function scaricaSuNativo(input: ScaricoInput): Promise<RisultatoScarico> {
  if (!pluginDisponibile()) return ripiego(input, 'plugin-filesystem-assente')
  try {
    const risposta = await fetch(input.url)
    if (!risposta.ok) return ripiego(input, `http-${risposta.status}`)

    const dati = await blobInBase64(await risposta.blob())
    if (!dati) return ripiego(input, 'corpo-vuoto')

    const fs = plugin()
    const scritto = await fs.writeFile({
      path: input.nomeFile,
      data: dati,
      directory: DIRECTORY_CACHE,
      recursive: true,
    })
    // `writeFile` ritorna già l'uri su entrambe le piattaforme; `getUri` è la
    // seconda strada per le versioni del plugin che non lo fanno.
    const uri = scritto?.uri || (await fs.getUri({ path: input.nomeFile, directory: DIRECTORY_CACHE })).uri
    if (!uri) return ripiego(input, 'uri-assente')

    const consegnato = await condividiFileLocale(uri, input.titolo)
    if (!consegnato) return ripiego(input, 'foglio-file-non-aperto')
    return { esito: 'nativo-file' }
  } catch (e) {
    return ripiego(input, nomeErrore(e))
  }
}

async function scaricaSuWeb(input: ScaricoInput): Promise<RisultatoScarico> {
  let indirizzoBlob: string | null = null
  try {
    const risposta = await fetch(input.url)
    if (!risposta.ok) return ripiego(input, `http-${risposta.status}`)

    indirizzoBlob = URL.createObjectURL(await risposta.blob())
    const ancora = document.createElement('a')
    ancora.href = indirizzoBlob
    ancora.download = input.nomeFile
    ancora.rel = 'noopener'
    document.body.appendChild(ancora)
    ancora.click()
    ancora.remove()
    return { esito: 'web-blob' }
  } catch (e) {
    return ripiego(input, nomeErrore(e))
  } finally {
    // La revoca è RITARDATA di proposito: revocare nello stesso tick del click
    // annulla il salvataggio appena avviato su più di un browser. Il costo è
    // tenere la foto in memoria per mezzo minuto, una alla volta.
    if (indirizzoBlob) {
      const daRevocare = indirizzoBlob
      setTimeout(() => URL.revokeObjectURL(daRevocare), 30_000)
    }
  }
}

/**
 * L'ultima strada che resta: condividere il LINK.
 *
 * Nella WebView è l'unico gesto che si è visto funzionare davvero — è il motivo
 * per cui «Condividi» andava mentre «Scarica» no — e sul web copia il link negli
 * appunti. Non è uno scarico, e infatti non si chiama così: il verdetto dice
 * `ripiego-condivisione` (o `ripiego-appunti`) e porta il motivo, così in
 * `app_log` si legge quante volte la strada buona non è stata percorribile.
 */
async function ripiego(input: ScaricoInput, motivo: string): Promise<RisultatoScarico> {
  try {
    const esito = await condividiLink({
      url: input.url,
      ...(input.titolo ? { title: input.titolo } : {}),
    })
    // `condividiLink` dice se un canale c'è stato davvero: senza questo controllo
    // «ho ripiegato» significherebbe «ho chiamato una funzione», non «l'utente ha
    // ottenuto qualcosa» — che è la differenza fra un log utile e un log che
    // rassicura.
    if (esito === 'non-riuscita') {
      return { esito: 'non-riuscito', motivo: `${motivo}|condivisione-non-riuscita` }
    }
    // I DUE RAMI NON SI SCHIACCIANO IN UNO. `share.ts` distingue `foglio` da
    // `appunti` di proposito — «la copia negli appunti è MUTA», ci sta scritto —
    // e fino a ieri quella distinzione moriva qui: `RisultatoScarico` non la
    // portava, quindi chi chiama non aveva NIENTE con cui decidere se avvisare.
    // Era lo stesso difetto di partenza spostato di un ramo: l'utente preme
    // «Scarica», non ottiene il file, e non gli si dice niente.
    return { esito: esito === 'appunti' ? 'ripiego-appunti' : 'ripiego-condivisione', motivo }
  } catch (e) {
    // `condividiLink()` non lancia; se lancia lo stesso, l'utente non ha ottenuto
    // NIENTE — ed è l'unico caso che merita un `error`.
    return { esito: 'non-riuscito', motivo: `${motivo}|${nomeErrore(e)}` }
  }
}

/**
 * I byte in base64, come li vuole `Filesystem.writeFile`.
 *
 * `FileReader` e non un giro a mano su `ArrayBuffer`: su una foto da qualche
 * megabyte `String.fromCharCode(...bytes)` sfonda lo stack, e farlo a blocchi
 * significa riscrivere in JavaScript quello che il motore fa in nativo.
 */
function blobInBase64(blob: Blob): Promise<string> {
  return new Promise<string>((risolvi, rifiuta) => {
    const lettore = new FileReader()
    lettore.onerror = () => rifiuta(lettore.error ?? new Error('lettura-blob-non-riuscita'))
    lettore.onload = () => {
      const risultato = typeof lettore.result === 'string' ? lettore.result : ''
      const virgola = risultato.indexOf(',')
      // `readAsDataURL` produce `data:<mime>;base64,<dati>`: al plugin va solo
      // la coda, l'intestazione la rimetterebbe due volte.
      risolvi(virgola >= 0 ? risultato.slice(virgola + 1) : '')
    }
    lettore.readAsDataURL(blob)
  })
}
