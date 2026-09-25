'use client'

import { Capacitor, registerPlugin } from '@capacitor/core'
import { logClient, nomeErrore } from '@/lib/logging/client'
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
  /** Presente nei plugin correnti; opzionale per non rompere shell native più vecchie. */
  deleteFile?(opzioni: { path: string; directory: string }): Promise<void>
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

function pluginDisponibile(nome: string = NOME_PLUGIN): boolean {
  try {
    return Capacitor.isPluginAvailable(nome)
  } catch {
    // IL SILENZIO È AMMESSO QUI, e va detto perché (§6 di AGENTS.md): se il
    // bridge non risponde, il plugin non c'è — e l'esito NON si perde. Il
    // `false` finisce sempre nel `motivo` del verdetto:
    //  - per Filesystem, in `scaricaSuNativo` diventa
    //    `ripiego(input, 'plugin-filesystem-assente')`, registrato da chi chiama
    //    `scarica()` (es. `gallery-scarico-ripiego-*: plugin-filesystem-assente`);
    //  - per Share, FileTransfer, Media e FileViewer diventa
    //    `plugin-assenti:<nome>` nel `motivo` degli helper 1.1 (`ripiego`,
    //    `pluginMancanti`, `documentoNativo`), e lo scrive `registraEsito`.
    // Loggare anche da qui sarebbe la stessa notizia due volte, e da un modulo
    // che non conosce la rotta in cui si trova.
    return false
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * Il verdetto
 * ════════════════════════════════════════════════════════════════════════════ */

export type EsitoScarico =
  /** Byte scritti sul dispositivo e consegnati al foglio di sistema. */
  | 'nativo-file'
  /** App 1.1: foto o video salvati DIRETTAMENTE in Galleria/Rullino (`scaricaMedia`). */
  | 'nativo-galleria'
  /** App 1.1: documento aperto nell'anteprima di sistema dentro l'app (`apriDocumento`). */
  | 'nativo-anteprima'
  /** Web: documento aperto in una scheda nuova (`apriDocumento`). */
  | 'web-scheda'
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
  /** Annulla fetch e impedisce write/share/ripieghi tardivi. Facoltativo per i chiamanti esistenti. */
  signal?: AbortSignal
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
  // IDEMPOTENTE: se il nome porta già la sua estensione, la si stacca PRIMA di
  // ripulire, si tronca la sola base e la si riattacca. Senza, un nome già passato
  // di qui (`<58 caratteri>.jpg`, 62 in tutto) al secondo giro perdeva la coda nel
  // taglio a `BASE_MAX` e diventava `<58>.j.jpg` — e `scaricaMedia` lo ripassa.
  const testo = didascalia ?? ''
  const suffisso = `.${estensione}`
  if (testo.length > suffisso.length && testo.toLowerCase().endsWith(suffisso)) {
    const base = ripulisciNome(testo.slice(0, -suffisso.length)) || predefinito
    return `${base}${testo.slice(-suffisso.length)}`
  }
  const base = ripulisciNome(didascalia) || predefinito
  return base.toLowerCase().endsWith(suffisso) ? base : `${base}${suffisso}`
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
  if (input.signal?.aborted) return annullato()
  return isNativeApp() ? scaricaSuNativo(input) : scaricaSuWeb(input)
}

async function scaricaSuNativo(input: ScaricoInput): Promise<RisultatoScarico> {
  if (!pluginDisponibile()) return ripiego(input, 'plugin-filesystem-assente')
  let fs: FilesystemMinimo | null = null
  let fileScritto = false
  try {
    const risposta = await fetchScarico(input)
    if (input.signal?.aborted) return annullato()
    if (!risposta.ok) return ripiego(input, `http-${risposta.status}`)

    const blob = await risposta.blob()
    if (input.signal?.aborted) return annullato()
    const dati = await blobInBase64(blob)
    if (input.signal?.aborted) return annullato()
    if (!dati) return ripiego(input, 'corpo-vuoto')

    fs = plugin()
    if (input.signal?.aborted) return annullato()
    const scritto = await fs.writeFile({
      path: input.nomeFile,
      data: dati,
      directory: DIRECTORY_CACHE,
      recursive: true,
    })
    fileScritto = true
    if (input.signal?.aborted) {
      await pulisciFileAnnullato(fs, input.nomeFile)
      return annullato()
    }
    // `writeFile` ritorna già l'uri su entrambe le piattaforme; `getUri` è la
    // seconda strada per le versioni del plugin che non lo fanno.
    const uri = scritto?.uri || (await fs.getUri({ path: input.nomeFile, directory: DIRECTORY_CACHE })).uri
    if (input.signal?.aborted) {
      await pulisciFileAnnullato(fs, input.nomeFile)
      return annullato()
    }
    if (!uri) return ripiego(input, 'uri-assente')

    // Ultimo cancello prima dell'unico effetto che non possiamo ritirare: il
    // foglio di sistema. Un abort durante writeFile/getUri non può oltrepassarlo.
    if (input.signal?.aborted) {
      await pulisciFileAnnullato(fs, input.nomeFile)
      return annullato()
    }
    // `foglioConFile` chiede prima a `isPluginAvailable` se Share c'è: un binario
    // col solo Filesystem non deve chiamare un plugin che non ha.
    const consegnato = await foglioConFile(uri, input.titolo, input.signal)
    if (input.signal?.aborted && !consegnato) {
      await pulisciFileAnnullato(fs, input.nomeFile)
      return annullato()
    }
    if (!consegnato) return ripiego(input, 'foglio-file-non-aperto')
    return { esito: 'nativo-file' }
  } catch (e) {
    if (input.signal?.aborted) {
      if (fileScritto && fs) await pulisciFileAnnullato(fs, input.nomeFile)
      return annullato()
    }
    return ripiego(input, nomeErrore(e))
  }
}

async function scaricaSuWeb(input: ScaricoInput): Promise<RisultatoScarico> {
  let indirizzoBlob: string | null = null
  try {
    const risposta = await fetchScarico(input)
    if (input.signal?.aborted) return annullato()
    if (!risposta.ok) return ripiego(input, `http-${risposta.status}`)

    const blob = await risposta.blob()
    if (input.signal?.aborted) return annullato()
    indirizzoBlob = URL.createObjectURL(blob)
    if (input.signal?.aborted) return annullato()
    cliccaAncora(indirizzoBlob, input.nomeFile)
    return { esito: 'web-blob' }
  } catch (e) {
    if (input.signal?.aborted) return annullato()
    return ripiego(input, nomeErrore(e))
  } finally {
    if (indirizzoBlob) revocaPiuTardi(indirizzoBlob, 30_000)
  }
}

/** L'ancora `download`, in un posto solo: la usano `scaricaSuWeb` e i documenti. */
function cliccaAncora(href: string, nomeFile: string): void {
  const ancora = document.createElement('a')
  ancora.href = href
  ancora.download = nomeFile
  ancora.rel = 'noopener'
  document.body.appendChild(ancora)
  ancora.click()
  ancora.remove()
}

/**
 * La revoca è RITARDATA di proposito: revocare nello stesso tick del click
 * annulla il salvataggio appena avviato su più di un browser. Il costo è tenere
 * il file in memoria per mezzo minuto, uno alla volta.
 */
function revocaPiuTardi(indirizzo: string, ms: number): void {
  setTimeout(() => URL.revokeObjectURL(indirizzo), ms)
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
  if (input.signal?.aborted) return annullato()
  // Nessun plugin senza `isPluginAvailable`: nell'app `condividiLink` apre il
  // foglio con `Share.share`, e un binario senza Share non ha nessun canale.
  // L'esito lo dice invece di chiamare un plugin assente.
  if (isNativeApp() && !pluginDisponibile(PLUGIN_SHARE)) {
    return { esito: 'non-riuscito', motivo: `${motivo}|${motivoPluginAssenti([PLUGIN_SHARE])}` }
  }
  try {
    const condivisione = {
      url: input.url,
      ...(input.titolo ? { title: input.titolo } : {}),
    }
    const esito = input.signal
      ? await condividiLink(condivisione, input.signal)
      : await condividiLink(condivisione)
    if (input.signal?.aborted) return annullato()
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
    if (input.signal?.aborted) return annullato()
    // `condividiLink()` non lancia; se lancia lo stesso, l'utente non ha ottenuto
    // NIENTE — ed è l'unico caso che merita un `error`.
    return { esito: 'non-riuscito', motivo: `${motivo}|${nomeErrore(e)}` }
  }
}

function annullato(): RisultatoScarico {
  return { esito: 'non-riuscito', motivo: 'annullato' }
}

/**
 * Il gesto è stato ritirato (segnale interrotto: tetto di tempo, smontaggio)?
 * Chi fonde il proprio motivo con quello di un passo interno DEVE chiederlo prima:
 * `plugin-assenti:…|annullato` non è più `annullato`, e `registraEsito` lo
 * scriverebbe come `error` — un guasto finto, e un avviso «aggiorna l'app» per
 * un'azione che l'utente non vuole più.
 */
function eAnnullato(risultato: RisultatoScarico): boolean {
  return risultato.esito === 'non-riuscito' && risultato.motivo === 'annullato'
}

/** Mantiene identica la chiamata storica a fetch quando il signal non è fornito. */
function fetchScarico(input: ScaricoInput): Promise<Response> {
  return input.signal ? fetch(input.url, { signal: input.signal }) : fetch(input.url)
}

/**
 * `writeFile` non è annullabile. Se il segnale arriva mentre il bridge sta
 * scrivendo, si aspetta il suo ritorno e si rimuove il file prima di liberare il
 * mutex del chiamante. Il path non entra mai nei log: può contenere una didascalia.
 */
async function pulisciFileAnnullato(fs: FilesystemMinimo, path: string): Promise<void> {
  if (!fs.deleteFile) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'scarico-nativo-pulizia-non-disponibile',
    })
    return
  }
  try {
    await fs.deleteFile({ path, directory: DIRECTORY_CACHE })
  } catch {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'scarico-nativo-pulizia-fallita',
    })
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

/* ════════════════════════════════════════════════════════════════════════════
 * L'HELPER UNICO DELL'APP 1.1 — media in Galleria, file nel foglio, anteprima
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Tre gesti, un posto solo, e sul WEB lo stesso comportamento di prima:
 *
 *  • `scaricaMedia`     foto/video → nativo: `FileTransfer` in Cache (i byte non
 *                       passano dal bridge in base64) e salvataggio DIRETTO in
 *                       Galleria con il plugin `Media` — iOS nel Rullino col solo
 *                       permesso di AGGIUNTA (nessun `albumIdentifier`), Android
 *                       nell'album «Kidville», creato se manca.
 *  • `scaricaDocumento` PDF, XLSX, CSV… → nativo: file in Cache e foglio di
 *                       condivisione con il FILE («Salva su File»).
 *  • `apriDocumento`    nativo: file in Cache e ANTEPRIMA di sistema dentro l'app
 *                       (`FileViewer`); web: scheda nuova.
 *
 * ─── LA SORGENTE DI UN DOCUMENTO, e perché la strada dipende da lei ───────────
 *  - URL ASSOLUTO di un'altra origine (link firmato dello Storage): `FileTransfer`
 *    lo scarica nativamente, senza cookie — non gliene servono.
 *  - URL della STESSA origine (una nostra route): richiede i cookie di SESSIONE,
 *    che vivono nella WebView e non nel client HTTP nativo. Quindi `fetch` nella
 *    WebView e `Filesystem.writeFile`. E il suo LINK non si condivide MAI come
 *    ripiego: è relativo (nessuna app lo apre) e può portare `userId` in chiaro —
 *    vedi `urlFattura` in `src/lib/pagamenti/scarico-fattura.ts`.
 *  - `Blob` già pronto (XLSX, jsPDF) o funzione che lo produce: `writeFile`.
 *
 * ─── IL BINARIO 1.0 ─────────────────────────────────────────────────────────
 * I binari 1.0 non contengono né Filesystem né i plugin nuovi. NESSUN plugin si
 * chiama senza `Capacitor.isPluginAvailable`: se ne manca uno si ripiega ESATTAMENTE
 * come prima — `scarica()` qui sopra (Filesystem+Share se c'è, altrimenti il foglio
 * col link) — e il ripiego si registra: `motivo` porta `plugin-assenti:<nomi>` e il
 * risultato `binarioDaAggiornare: true`, che serve all'avviso «aggiorna l'app».
 *
 * ─── I LOG ──────────────────────────────────────────────────────────────────
 * A differenza di `scarica()`, questi tre LOGGANO DA SÉ l'esito, successo compreso,
 * con la forma già in uso in `app_log`: `<etichetta>-scarico-riuscito:<esito>`,
 * `<etichetta>-scarico-ripiego-condivisione: <motivo>`, `<etichetta>-scarico-non-
 * riuscito: <motivo>` (per l'apertura `-apertura-riuscita` / `-non-riuscita`).
 * Chi chiama NON rilogga. `etichetta` è un token (`gallery`, `fattura`, `pagella`…):
 * un valore fuori forma diventa quello predefinito, perché da qui si va dritti in
 * `app_log` — e nel log non entrano MAI URL, nome del file o testo dell'errore.
 */

interface FileTransferMinimo {
  downloadFile(opzioni: { url: string; path: string; progress?: boolean }): Promise<{ path?: string }>
}

interface FileViewerMinimo {
  openDocumentFromLocalPath(opzioni: { path: string }): Promise<void>
}

interface OpzioniSalvataggioMedia {
  path: string
  albumIdentifier?: string
  fileName?: string
}

interface MediaMinimo {
  savePhoto(opzioni: OpzioniSalvataggioMedia): Promise<unknown>
  saveVideo(opzioni: OpzioniSalvataggioMedia): Promise<unknown>
  getAlbums(): Promise<{ albums?: { identifier?: string; name?: string }[] }>
  createAlbum(opzioni: { name: string }): Promise<void>
  getAlbumsPath(): Promise<{ path?: string }>
}

const PLUGIN_FILE_TRANSFER = 'FileTransfer'
const PLUGIN_FILE_VIEWER = 'FileViewer'
const PLUGIN_MEDIA = 'Media'
const PLUGIN_SHARE = 'Share'

/** L'album in cui finiscono foto e video su Android. Su iOS si va nel Rullino. */
export const ALBUM_KIDVILLE = 'Kidville'

/** Un proxy per nome, creato alla prima richiesta: vedi `plugin()` qui sopra. */
const proxyPlugin = new Map<string, unknown>()
function pluginNativo<T>(nome: string): T {
  if (nome === NOME_PLUGIN) return plugin() as unknown as T
  let proxy = proxyPlugin.get(nome)
  if (!proxy) {
    proxy = registerPlugin<T>(nome)
    proxyPlugin.set(nome, proxy)
  }
  return proxy as T
}

function pluginMancanti(nomi: readonly string[]): string[] {
  return nomi.filter((nome) => !pluginDisponibile(nome))
}

function motivoPluginAssenti(mancanti: readonly string[]): string {
  return `plugin-assenti:${mancanti.map((n) => n.toLowerCase()).join('+')}`
}

function unisciMotivi(...motivi: (string | undefined)[]): string | undefined {
  const presenti = motivi.filter((m): m is string => Boolean(m))
  return presenti.length ? presenti.join('|') : undefined
}

export interface RisultatoScaricoNativo extends RisultatoScarico {
  /**
   * `true` quando l'app installata non ha i plugin della 1.1 e si è ripiegato sulla
   * strada di prima. È il segnale per l'avviso «aggiorna l'app».
   */
  binarioDaAggiornare?: boolean
}

/** Gli esiti che lasciano DAVVERO il file (o l'anteprima) in mano a chi ha premuto. */
const ESITI_CONSEGNATI: ReadonlySet<EsitoScarico> = new Set<EsitoScarico>([
  'nativo-file',
  'nativo-galleria',
  'nativo-anteprima',
  'web-blob',
  'web-scheda',
])

/**
 * Il file è arrivato? Elenco CHIUSO dei consegnanti: un esito nuovo nasce «non
 * consegnato» e va dimostrato consegnante, non il contrario (la stessa regola di
 * `avvisoDa` in `scarico-fattura.ts`).
 */
export function fileConsegnato(risultato: RisultatoScarico): boolean {
  return ESITI_CONSEGNATI.has(risultato.esito)
}

/* ─── Etichetta e log ─────────────────────────────────────────────────────── */

const ETICHETTA_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function etichettaSicura(etichetta: string | undefined, predefinita: string): string {
  return typeof etichetta === 'string' && etichetta.length <= 40 && ETICHETTA_RX.test(etichetta)
    ? etichetta
    : predefinita
}

function piattaforma(): string {
  try {
    const p = Capacitor.getPlatform()
    return typeof p === 'string' && /^[a-z]{1,16}$/.test(p) ? p : 'sconosciuta'
  } catch {
    // Bridge assente o ostile: la piattaforma resta ignota, e il campo lo DICE
    // invece di sparire. Non è un guasto dello scarico.
    return 'sconosciuta'
  }
}

type Operazione = 'scarico' | 'apertura'

/**
 * UNA riga per gesto, successo compreso. `warn` per il successo non è un refuso:
 * `/api/logs` accetta solo `warn|error` (vedi `registraEsitoScarico` in
 * `MediaGrid`). `error` SOLO quando l'utente non ha ottenuto niente.
 */
function registraEsito(etichetta: string, operazione: Operazione, risultato: RisultatoScaricoNativo): void {
  const coda = risultato.motivo ? `: ${risultato.motivo}` : ''
  const campi = { esito: risultato.esito, operazione, piattaforma: piattaforma() }
  const femminile = operazione === 'apertura'
  if (fileConsegnato(risultato)) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `${etichetta}-${operazione}-${femminile ? 'riuscita' : 'riuscito'}:${risultato.esito}${coda}`,
      campi,
    })
    return
  }
  if (risultato.esito === 'ripiego-condivisione' || risultato.esito === 'ripiego-appunti') {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `${etichetta}-${operazione}-${risultato.esito}${coda}`, campi })
    return
  }
  if (risultato.motivo === 'annullato') {
    // Smontaggio o gesto ritirato da chi chiama: non è un guasto.
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `${etichetta}-${operazione}-${femminile ? 'annullata' : 'annullato'}`, campi })
    return
  }
  logClient({
    livello: 'error',
    evento: 'fetch',
    messaggio: `${etichetta}-${operazione}-${femminile ? 'non-riuscita' : 'non-riuscito'}${coda}`,
    campi,
  })
}

/**
 * Il motivo di un rifiuto dei plugin, come TOKEN: lo stato HTTP se c'è
 * (`FileTransfer` lo mette in `data.httpStatus`), altrimenti il codice del plugin
 * (`OS-PLUG-FLTR-0008`, `accessDenied`), altrimenti il `name`. Mai il `message`.
 */
function motivoErrorePlugin(e: unknown): string {
  try {
    const err = e as { code?: unknown; httpStatus?: unknown; data?: { httpStatus?: unknown } } | null
    const stato = err?.data?.httpStatus ?? err?.httpStatus
    if (typeof stato === 'number' && stato >= 100 && stato <= 599) return `http-${stato}`
    if (typeof err?.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(err.code)) return err.code
  } catch {
    // Getter ostile sull'errore: si ricade sul `name`, qui sotto.
    return nomeErrore(e)
  }
  return nomeErrore(e)
}

/* ─── Nomi ────────────────────────────────────────────────────────────────── */

const ESTENSIONI_DA_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/zip': 'zip',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
}

/**
 * Le estensioni che un nome di documento può portare e che si RICONOSCONO come
 * tali: quelle dei mime qui sopra più quelle dei media. Lista chiusa di proposito:
 * in «ricevuta n.12» il `12` dopo il punto non è un'estensione.
 */
const ESTENSIONI_DOCUMENTO: ReadonlySet<string> = new Set([
  ...Object.values(ESTENSIONI_DA_MIME),
  ...ESTENSIONI_NOTE,
])

/**
 * Il nome di un DOCUMENTO sul dispositivo: ripulito come quello dei media (niente
 * barre, niente `..`, niente file nascosti) e con un'estensione — senza, iOS non
 * sa che anteprima usare (`OS-PLUG-FLVW-0013`) e Android non sa con che app aprirlo.
 *
 * L'estensione si STACCA prima di ripulire: il taglio a `BASE_MAX` vale per la sola
 * base. Ripulire il nome intero troncava la coda — `<58 caratteri>.pdf` diventava
 * `<58>.p` — e un nome di pagella arriva facilmente a 60 caratteri.
 *
 * Se il nome porta già un'estensione riconosciuta, quella resta (minuscola) e il
 * `mime` non la cambia; il `mime` serve a dare l'estensione a chi non ne ha una.
 */
export function nomeFileDocumento(nomeFile: string | null | undefined, mime?: string | null): string {
  const testo = nomeFile ?? ''
  const punto = testo.lastIndexOf('.')
  const coda = punto >= 0 ? testo.slice(punto + 1).toLowerCase() : ''
  const riconosciuta = ESTENSIONI_DOCUMENTO.has(coda)
  const base = ripulisciNome(riconosciuta ? testo.slice(0, punto) : testo) || 'kidville-documento'
  if (riconosciuta) return `${base}.${coda}`
  const tipo = (mime ?? '').split(';')[0].trim().toLowerCase()
  const estensione = ESTENSIONI_DA_MIME[tipo]
  return estensione ? `${base}.${estensione}` : base
}

/* ─── Sorgenti ────────────────────────────────────────────────────────────── */

export type SorgenteDocumento = string | Blob | (() => Blob | Promise<Blob>)

/**
 * `true` per un http(s) di un'ALTRA origine. Relativo, stessa origine, `blob:` e
 * `data:` → `false`: si leggono con la `fetch` della WebView, che ha i cookie.
 */
function urlAssoluto(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  const qui = typeof location !== 'undefined' ? location.origin : ''
  try {
    return new URL(url).origin !== qui
  } catch {
    // Assoluto ma malformato: resta «assoluto», e il rifiuto di `FileTransfer` (o
    // della `fetch` sul web) finisce nel verdetto e quindi nel log.
    return true
  }
}

type Passo<T> = { ok: true; valore: T } | { ok: false; motivo: string }

async function blobDaSorgente(
  sorgente: SorgenteDocumento,
  signal?: AbortSignal,
): Promise<Passo<Blob>> {
  if (typeof sorgente === 'string') {
    const risposta = await fetch(sorgente, signal
      ? { credentials: 'same-origin', signal }
      : { credentials: 'same-origin' })
    if (!risposta.ok) return { ok: false, motivo: `http-${risposta.status}` }
    return { ok: true, valore: await risposta.blob() }
  }
  const blob = typeof sorgente === 'function' ? await sorgente() : sorgente
  if (!(blob instanceof Blob)) return { ok: false, motivo: 'sorgente-non-blob' }
  return { ok: true, valore: blob }
}

/* ─── Nativo: il file in Cache ────────────────────────────────────────────── */

/**
 * Mette il file in `Directory.Cache` e ne ritorna l'uri `file://`.
 * URL assoluto → `FileTransfer` (i byte non attraversano il bridge); stessa origine
 * e Blob → `writeFile`. Chi chiama ha già verificato i plugin necessari.
 */
async function fileInCache(
  sorgente: SorgenteDocumento,
  nomeFile: string,
  signal?: AbortSignal,
): Promise<Passo<string>> {
  const fs = pluginNativo<FilesystemMinimo>(NOME_PLUGIN)
  try {
    if (typeof sorgente === 'string' && urlAssoluto(sorgente)) {
      const { uri } = await fs.getUri({ path: nomeFile, directory: DIRECTORY_CACHE })
      if (!uri) return { ok: false, motivo: 'uri-assente' }
      if (signal?.aborted) return { ok: false, motivo: 'annullato' }
      await pluginNativo<FileTransferMinimo>(PLUGIN_FILE_TRANSFER).downloadFile({ url: sorgente, path: uri })
      if (signal?.aborted) {
        await pulisciFileAnnullato(fs, nomeFile)
        return { ok: false, motivo: 'annullato' }
      }
      return { ok: true, valore: uri }
    }

    const blob = await blobDaSorgente(sorgente, signal)
    if (signal?.aborted) return { ok: false, motivo: 'annullato' }
    if (!blob.ok) return blob
    const dati = await blobInBase64(blob.valore)
    if (signal?.aborted) return { ok: false, motivo: 'annullato' }
    if (!dati) return { ok: false, motivo: 'corpo-vuoto' }
    const scritto = await fs.writeFile({ path: nomeFile, data: dati, directory: DIRECTORY_CACHE, recursive: true })
    const uri = scritto?.uri || (await fs.getUri({ path: nomeFile, directory: DIRECTORY_CACHE })).uri
    if (signal?.aborted) {
      await pulisciFileAnnullato(fs, nomeFile)
      return { ok: false, motivo: 'annullato' }
    }
    return uri ? { ok: true, valore: uri } : { ok: false, motivo: 'uri-assente' }
  } catch (e) {
    if (signal?.aborted) return { ok: false, motivo: 'annullato' }
    return { ok: false, motivo: motivoErrorePlugin(e) }
  }
}

/** Il file locale nel foglio di sistema, solo se il plugin Share c'è. */
async function foglioConFile(uri: string, titolo?: string, signal?: AbortSignal): Promise<boolean> {
  if (!pluginDisponibile(PLUGIN_SHARE)) return false
  return signal ? condividiFileLocale(uri, titolo, signal) : condividiFileLocale(uri, titolo)
}

/* ─── Media → Galleria ────────────────────────────────────────────────────── */

export type TipoMedia = 'foto' | 'video'

export interface ScaricaMediaInput {
  /** L'indirizzo FIRMATO del media (assoluto, a tempo). */
  url: string
  /** Nome con estensione: vedi `nomeFileScarico`. */
  nomeFile: string
  tipo: TipoMedia
  /** Titolo del foglio di sistema nei ripieghi. Mai un nome di persona. */
  titolo?: string
  /** Prefisso dei log (`gallery` se assente). */
  etichetta?: string
  signal?: AbortSignal
}

/**
 * L'identificatore dell'album «Kidville» su Android: è il PERCORSO della cartella
 * sotto `getAlbumsPath()`. Se non c'è si crea; un «esiste già» (due scarichi in
 * gara) si verifica rileggendo gli album invece di fallire.
 */
async function albumKidvilleAndroid(media: MediaMinimo): Promise<string> {
  const { path: radice } = await media.getAlbumsPath()
  if (!radice) throw Object.assign(new Error('album'), { code: 'album-radice-assente' })
  const atteso = `${radice.replace(/\/+$/, '')}/${ALBUM_KIDVILLE}`
  const presente = async () => ((await media.getAlbums()).albums ?? []).some((a) => a?.identifier === atteso)
  if (await presente()) return atteso
  try {
    await media.createAlbum({ name: ALBUM_KIDVILLE })
  } catch (e) {
    if (!(await presente())) throw e
  }
  return atteso
}

/** Il nome nell'album Android: senza estensione (la mette il plugin) e unico. */
function nomeNellAlbum(nomeFile: string): string {
  const senzaEstensione = nomeFile.replace(/\.[a-z0-9]{1,5}$/i, '') || 'kidville'
  return `${senzaEstensione}-${Date.now()}`
}

/**
 * Scarica una foto o un video. Nell'app 1.1 finisce DIRETTAMENTE in Galleria;
 * sul web e sul binario 1.0 fa esattamente quello che faceva `scarica()`.
 * Non lancia mai, e logga da sé l'esito.
 */
export async function scaricaMedia(input: ScaricaMediaInput): Promise<RisultatoScaricoNativo> {
  const etichetta = etichettaSicura(input.etichetta, 'gallery')
  const risultato = await scaricaMediaSenzaLog(input)
  registraEsito(etichetta, 'scarico', risultato)
  return risultato
}

async function scaricaMediaSenzaLog(input: ScaricaMediaInput): Promise<RisultatoScaricoNativo> {
  // SEMPRE con estensione: su Android il plugin `Media` la ricava dal percorso in
  // Cache (`lastIndexOf('.')`), e un nome senza punto lo fa fallire.
  const nomeFile = nomeFileScarico(input.nomeFile, input.url, input.tipo)
  const base: ScaricoInput = {
    url: input.url,
    nomeFile,
    ...(input.titolo ? { titolo: input.titolo } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }
  if (input.signal?.aborted) return annullato()
  if (!isNativeApp()) return scarica(base)

  const mancanti = pluginMancanti([NOME_PLUGIN, PLUGIN_FILE_TRANSFER, PLUGIN_MEDIA])
  if (mancanti.length) {
    const vecchio = await scarica(base)
    // Annullato resta annullato: niente fusione del motivo, niente avviso.
    if (eAnnullato(vecchio)) return annullato()
    return { ...vecchio, motivo: unisciMotivi(motivoPluginAssenti(mancanti), vecchio.motivo), binarioDaAggiornare: true }
  }

  const file = await fileInCache(input.url, nomeFile, input.signal)
  if (!file.ok) return file.motivo === 'annullato' ? annullato() : ripiego(base, file.motivo)
  const uri = file.valore

  const media = pluginNativo<MediaMinimo>(PLUGIN_MEDIA)
  try {
    const opzioni: OpzioniSalvataggioMedia = { path: uri }
    if (piattaforma() === 'android') {
      opzioni.albumIdentifier = await albumKidvilleAndroid(media)
      opzioni.fileName = nomeNellAlbum(nomeFile)
    }
    // iOS: NESSUN album → il plugin chiede il solo permesso di AGGIUNTA al Rullino
    // (`NSPhotoLibraryAddUsageDescription`), non l'accesso alla libreria intera.
    if (input.signal?.aborted) {
      await pulisciFileAnnullato(pluginNativo<FilesystemMinimo>(NOME_PLUGIN), nomeFile)
      return annullato()
    }
    if (input.tipo === 'video') await media.saveVideo(opzioni)
    else await media.savePhoto(opzioni)
  } catch (e) {
    // La Galleria ha detto no (permesso negato, formato rifiutato): il file è già
    // sul telefono, e il foglio di sistema lo consegna lo stesso («Salva su File»).
    const motivo = `galleria-${motivoErrorePlugin(e)}`
    if (input.signal?.aborted) return annullato()
    if (await foglioConFile(uri, input.titolo, input.signal)) return { esito: 'nativo-file', motivo }
    return ripiego(base, motivo)
  }
  // La copia in Cache non serve più: quella vera sta in Galleria.
  await pulisciFileAnnullato(pluginNativo<FilesystemMinimo>(NOME_PLUGIN), nomeFile)
  return { esito: 'nativo-galleria' }
}

/* ─── Documenti → foglio o anteprima ──────────────────────────────────────── */

export interface DocumentoInput {
  /** URL assoluto firmato, URL della stessa origine, `Blob`, o funzione che lo produce. */
  sorgente: SorgenteDocumento
  /** Nome con cui il file arriva sul dispositivo; l'estensione, se manca, la dà `mime`. */
  nomeFile: string
  mime?: string
  /** Titolo del foglio di sistema. Mai un nome di persona. */
  titolo?: string
  /** Prefisso dei log (`documento` se assente): `fattura`, `pagella`, `ricevuta`… */
  etichetta?: string
  signal?: AbortSignal
}

/**
 * Salva un documento. Nell'app 1.1: file in Cache e foglio di condivisione con il
 * FILE. Sul web: fetch (coi cookie per la stessa origine) → controllo della
 * risposta → `<a download>` su un `blob:`, come facevano i punti che sostituisce.
 * Non lancia mai, e logga da sé l'esito.
 */
export async function scaricaDocumento(input: DocumentoInput): Promise<RisultatoScaricoNativo> {
  const etichetta = etichettaSicura(input.etichetta, 'documento')
  let risultato: RisultatoScaricoNativo
  try {
    risultato = await scaricaDocumentoSenzaLog(input)
  } catch (e) {
    // Rete di sicurezza: una sorgente-funzione che lancia fuori dai rami previsti.
    risultato = { esito: 'non-riuscito', motivo: nomeErrore(e) }
  }
  registraEsito(etichetta, 'scarico', risultato)
  return risultato
}

async function scaricaDocumentoSenzaLog(input: DocumentoInput): Promise<RisultatoScaricoNativo> {
  if (input.signal?.aborted) return annullato()
  const nomeFile = nomeFileDocumento(input.nomeFile, input.mime)
  return isNativeApp()
    ? documentoNativo(input, nomeFile, 'foglio')
    : scaricaDocumentoWeb(input, nomeFile)
}

/**
 * Apre un documento. Nell'app 1.1: file in Cache e anteprima di sistema DENTRO
 * l'app. Sul web: scheda nuova, aperta DENTRO il gesto (prima di ogni `await`,
 * vedi `apriDocumentoFirmato`) — va chiamata dal gestore del clic.
 * Non lancia mai, e logga da sé l'esito.
 */
export async function apriDocumento(input: DocumentoInput): Promise<RisultatoScaricoNativo> {
  const etichetta = etichettaSicura(input.etichetta, 'documento')
  let risultato: RisultatoScaricoNativo
  try {
    risultato = await apriDocumentoSenzaLog(input)
  } catch (e) {
    risultato = { esito: 'non-riuscito', motivo: nomeErrore(e) }
  }
  registraEsito(etichetta, 'apertura', risultato)
  return risultato
}

function apriDocumentoSenzaLog(input: DocumentoInput): Promise<RisultatoScaricoNativo> {
  if (input.signal?.aborted) return Promise.resolve(annullato())
  const nomeFile = nomeFileDocumento(input.nomeFile, input.mime)
  // NIENTE `async`/`await` prima di `apriDocumentoWeb`: la scheda va aperta nello
  // stesso task del clic, o Safari e la WebView la bloccano.
  return isNativeApp() ? documentoNativo(input, nomeFile, 'anteprima') : apriDocumentoWeb(input, nomeFile)
}

/**
 * Il ramo nativo di documento e apertura.
 *
 *  1. Mancano i plugin di base (Filesystem, e FileTransfer per un URL assoluto) →
 *     binario 1.0: URL assoluto → `scarica()` come prima; stessa origine e Blob →
 *     «non riuscito», SENZA condividere il link (relativo, e con `userId`).
 *  2. File in Cache.
 *  3. Anteprima (se richiesta e `FileViewer` c'è) → `nativo-anteprima`. Se manca o
 *     rifiuta (Android: nessuna app per aprirlo) si passa al foglio col file.
 *  4. Foglio col file → `nativo-file`; se non si apre, ripiego sul link solo per
 *     un URL assoluto.
 */
async function documentoNativo(
  input: DocumentoInput,
  nomeFile: string,
  modo: 'foglio' | 'anteprima',
): Promise<RisultatoScaricoNativo> {
  const { sorgente, signal } = input
  const assoluto = typeof sorgente === 'string' && urlAssoluto(sorgente)
  const base: ScaricoInput | null = assoluto
    ? {
        url: sorgente as string,
        nomeFile,
        ...(input.titolo ? { titolo: input.titolo } : {}),
        ...(signal ? { signal } : {}),
      }
    : null

  const mancantiBase = pluginMancanti(assoluto ? [NOME_PLUGIN, PLUGIN_FILE_TRANSFER] : [NOME_PLUGIN])
  if (mancantiBase.length) {
    const assenti = motivoPluginAssenti(mancantiBase)
    if (base) {
      const vecchio = await scarica(base)
      // Annullato resta annullato: niente fusione del motivo, niente avviso.
      if (eAnnullato(vecchio)) return annullato()
      return { ...vecchio, motivo: unisciMotivi(assenti, vecchio.motivo), binarioDaAggiornare: true }
    }
    return { esito: 'non-riuscito', motivo: `${assenti}|link-non-condivisibile`, binarioDaAggiornare: true }
  }

  const file = await fileInCache(sorgente, nomeFile, signal)
  if (!file.ok) {
    if (file.motivo === 'annullato') return annullato()
    return base ? ripiego(base, file.motivo) : { esito: 'non-riuscito', motivo: file.motivo }
  }
  const uri = file.valore

  let motivo: string | undefined
  let binarioDaAggiornare = false
  if (modo === 'anteprima') {
    if (pluginDisponibile(PLUGIN_FILE_VIEWER)) {
      try {
        if (signal?.aborted) return annullato()
        await pluginNativo<FileViewerMinimo>(PLUGIN_FILE_VIEWER).openDocumentFromLocalPath({ path: uri })
        return { esito: 'nativo-anteprima' }
      } catch (e) {
        motivo = `anteprima-${motivoErrorePlugin(e)}`
      }
    } else {
      motivo = motivoPluginAssenti([PLUGIN_FILE_VIEWER])
      binarioDaAggiornare = true
    }
  }

  if (signal?.aborted) return annullato()
  // Un gesto annullato non chiede di aggiornare l'app.
  const conFlag = (r: RisultatoScaricoNativo): RisultatoScaricoNativo =>
    binarioDaAggiornare && !eAnnullato(r) ? { ...r, binarioDaAggiornare: true } : r
  if (await foglioConFile(uri, input.titolo, signal)) {
    return conFlag(motivo ? { esito: 'nativo-file', motivo } : { esito: 'nativo-file' })
  }
  if (signal?.aborted) return annullato()
  const motivoFoglio = unisciMotivi(motivo, 'foglio-file-non-aperto') as string
  return conFlag(base ? await ripiego(base, motivoFoglio) : { esito: 'non-riuscito', motivo: motivoFoglio })
}

/* ─── Web ─────────────────────────────────────────────────────────────────── */

function scaricaBlobSuWeb(blob: Blob, nomeFile: string): RisultatoScaricoNativo {
  const indirizzo = URL.createObjectURL(blob)
  try {
    cliccaAncora(indirizzo, nomeFile)
  } finally {
    revocaPiuTardi(indirizzo, 30_000)
  }
  return { esito: 'web-blob' }
}

async function scaricaDocumentoWeb(input: DocumentoInput, nomeFile: string): Promise<RisultatoScaricoNativo> {
  const { sorgente, signal } = input
  if (typeof sorgente === 'string') {
    if (urlAssoluto(sorgente)) {
      // Fuori origine `download` è ignorato: fetch → `blob:` → ancora, come prima.
      return scarica({
        url: sorgente,
        nomeFile,
        ...(input.titolo ? { titolo: input.titolo } : {}),
        ...(signal ? { signal } : {}),
      })
    }
  }
  // Stessa origine, `Blob` o funzione: fetch nella pagina (coi cookie) → controllo
  // della risposta → `blob:` → ancora. NON un `<a download>` sull'indirizzo della
  // route: con un 401/403/500 il browser salverebbe il corpo d'errore come
  // «fattura.pdf» e il log direbbe successo senza aver visto la risposta. È anche
  // ciò che facevano i punti che questo helper sostituisce (fetch → `res.ok` →
  // blob → ancora).
  let blob: Passo<Blob>
  try {
    blob = await blobDaSorgente(sorgente, signal)
  } catch (e) {
    if (signal?.aborted) return annullato()
    return { esito: 'non-riuscito', motivo: nomeErrore(e) }
  }
  if (signal?.aborted) return annullato()
  if (!blob.ok) return { esito: 'non-riuscito', motivo: blob.motivo }
  return scaricaBlobSuWeb(blob.valore, nomeFile)
}

function staccaOpener(finestra: Window): void {
  try {
    finestra.opener = null
  } catch (e) {
    // Alcune WebView rendono `opener` non scrivibile: l'apertura vale comunque.
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `documento-opener-non-scrivibile:${nomeErrore(e)}` })
  }
}

/**
 * La scheda si apre SUBITO, prima di ogni `await`: per un URL o un `Blob` già
 * pronto direttamente sul documento, per una sorgente-funzione VUOTA e riempita
 * dopo con `location.replace`. Scheda bloccata → si scarica invece di tacere.
 */
function apriDocumentoWeb(input: DocumentoInput, nomeFile: string): Promise<RisultatoScaricoNativo> {
  const { sorgente } = input
  const bloccata = async (): Promise<RisultatoScaricoNativo> => {
    const scaricato = await scaricaDocumentoWeb(input, nomeFile)
    // Annullato resta annullato: `finestra-bloccata|annullato` finirebbe fra gli `error`.
    if (eAnnullato(scaricato)) return annullato()
    return { ...scaricato, motivo: unisciMotivi('finestra-bloccata', scaricato.motivo) }
  }

  if (typeof sorgente === 'string') {
    const finestra = window.open(sorgente, '_blank')
    if (!finestra) return bloccata()
    staccaOpener(finestra)
    return Promise.resolve({ esito: 'web-scheda' })
  }

  if (sorgente instanceof Blob) {
    const indirizzo = URL.createObjectURL(sorgente)
    const finestra = window.open(indirizzo, '_blank')
    if (!finestra) {
      URL.revokeObjectURL(indirizzo)
      return bloccata()
    }
    staccaOpener(finestra)
    // La scheda nuova ha bisogno dell'indirizzo finché non ha caricato.
    revocaPiuTardi(indirizzo, 60_000)
    return Promise.resolve({ esito: 'web-scheda' })
  }

  const finestra = window.open('', '_blank')
  return (async (): Promise<RisultatoScaricoNativo> => {
    let blob: Passo<Blob>
    try {
      blob = await blobDaSorgente(sorgente)
    } catch (e) {
      finestra?.close()
      // Un gesto ritirato mentre la sorgente lavorava non è un guasto.
      if (input.signal?.aborted) return annullato()
      return { esito: 'non-riuscito', motivo: nomeErrore(e) }
    }
    if (input.signal?.aborted) {
      finestra?.close()
      return annullato()
    }
    if (!blob.ok) {
      finestra?.close()
      return { esito: 'non-riuscito', motivo: blob.motivo }
    }
    if (!finestra || finestra.closed) {
      const scaricato = scaricaBlobSuWeb(blob.valore, nomeFile)
      return { ...scaricato, motivo: 'finestra-bloccata' }
    }
    const indirizzo = URL.createObjectURL(blob.valore)
    staccaOpener(finestra)
    finestra.location.replace(indirizzo)
    revocaPiuTardi(indirizzo, 60_000)
    return { esito: 'web-scheda' }
  })()
}
