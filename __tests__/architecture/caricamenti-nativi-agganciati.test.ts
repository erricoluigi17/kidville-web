// @vitest-environment node

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  EVENTI_LOG_NATIVI,
  EVENTI_PLUGIN_CARICAMENTI,
  METODI_PLUGIN_CARICAMENTI,
  NOME_PLUGIN_CARICAMENTI,
} from '@/lib/native/caricamenti-nativi-tipi'

/**
 * I CARICAMENTI NATIVI SONO AGGANCIATI — non «scritti»: agganciati.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.1, §5.2-§5.3, §5.8, §6.4-§6.5, §8, §9, §10 «il lock di J4»)
 *
 * ─── IL DIFETTO CHE QUESTO LOCK VIENE A CHIUDERE ────────────────────────────────────────────
 * La PR 3 scrive un plugin nostro, locale all'app, in tre linguaggi (Swift, Java, TypeScript) e un motore di invio che
 * vive a parte, nel sistema operativo. Un plugin del genere non fallisce quando non è agganciato: **non esiste**.
 * `Capacitor.isPluginAvailable('KidvilleCaricamenti')` risponde `false`, l'involucro JS ripiega sul TUS dalla pagina
 * (che su iOS muore a schermo bloccato) e l'app 1.2 si comporta come la 1.1: nessun errore, nessun test rosso, e tutto il
 * lavoro della PR 3 inutile. Lo stesso vale per un nome scritto in due modi, un metodo che manca da un lato, una
 * registrazione dopo un `guard` che esce, un file Swift che sta sul disco ma non nella fase Sources del progetto Xcode,
 * un `AppDelegate` che non riceve il risveglio della sessione in background. **La CI non compila il nativo** (spec §13,
 * rischio 13): nessun altro cancello vede questi guasti prima di un telefono.
 *
 * ─── LE REGOLE (una `it` ciascuna, col messaggio che dice il FILE e COSA MANCA) ──────────────
 *  1. il NOME del plugin è identico in Swift (`jsName`), Java (`@CapacitorPlugin`) e TS (`NOME_PLUGIN_CARICAMENTI`);
 *  2. gli INSIEMI DI METODI sono identici: Swift (`CAPPluginMethod`, e ognuno ha il suo `@objc func`), Java (`@PluginMethod`)
 *     e TS (`METODI_PLUGIN_CARICAMENTI`); `creaElementoDiProva` esiste solo dentro `#if DEBUG` (Swift) e dietro
 *     `BuildConfig.DEBUG` (Java), e le build Release non definiscono né `DEBUG` né `debuggable`; stessi EVENTI
 *     (`preparazione`, `caricamento`) nei tre linguaggi;
 *  3. la REGISTRAZIONE: in Swift dentro `capacitorDidLoad` PRIMA di ogni `guard`; in Java `registerPlugin` PRIMA di
 *     `super.onCreate`;
 *  4. i PUNTI D'INGRESSO del sistema: `AppDelegate` con `avvia()`, `handleEventsForBackgroundURLSession` (che passa
 *     identificativo e completamento al motore), `riprendiInPrimoPiano()` e `notificaSeFermo()`; `MainActivity.onResume` con
 *     `riprendiInPrimoPiano`;
 *  5. i PARAMETRI DELLA SESSIONE `URLSession`: identificativo, `sessionSendsLaunchEvents = true`, `isDiscretionary = false`,
 *     e le tre reti (cellulare, costosa, limitata) ammesse — decisione del titolare «qualunque rete»;
 *  6. ogni file Swift dell'app è nella fase SOURCES del target `App` del `project.pbxproj` (e ogni servizio Android del
 *     pacchetto è dichiarato nel manifest): un file che c'è e non compila è codice che non gira;
 *  7. il MANIFEST: permessi e servizi di §6.4 presenti, NESSUN permesso media (`READ_MEDIA_*`, `READ_EXTERNAL_STORAGE`, …) né
 *     nel manifest né nei sorgenti Java; nessun `UIBackgroundModes` in `Info.plist`; ogni Service/Receiver/Activity del pacchetto
 *     dei caricamenti è dichiarato nel manifest;
 *  8. le VERSIONI: `MARKETING_VERSION` 1.2 e `CURRENT_PROJECT_VERSION` 6 in tutte le configurazioni dell'app; `versionName`
 *     1.2 e `versionCode` 4; la dipendenza di WorkManager e la sua versione in `variables.gradle`, `BuildConfig` acceso;
 *  9. nessun `x-upsert`, `apikey`, `authorization`, `localizedDescription`, `absoluteString`, `suggestedName` o
 *     `lastPathComponent` (e, in Java, `getMessage`, `getLocalizedMessage`, `getLastPathSegment`) DENTRO una chiamata di log
 *     nativa: le funzioni di log si trovano nel codice (la «API di log» di `KVRegistroNativo`, i metodi `UUID` di
 *     `RegistroNativo`, i `Logger`/`Log.*` di sistema) e se ne leggono gli argomenti;
 * 10. i messaggi che il nativo può scrivere sono un SOTTOINSIEME di `EVENTI_LOG_NATIVI`;
 * 11. `src/lib/auth/logout.ts` NON nomina il modulo dei caricamenti nativi (l'invio continua all'uscita: decisione del titolare).
 *
 * ─── COSA NON SI DUPLICA: lo coprono questi lock, qui si leggono e si citano ─────────────────
 *  · `plugin-capacitor-registrati` — i plugin npm di `package.json` registrati in `Package.swift`, `capacitor.settings.gradle`
 *    e `capacitor.build.gradle`. Il nostro è LOCALE: non sta in `package.json`, quei tre file non cambiano e quel lock resta
 *    verde. Qui si prova l'altra metà: il plugin che non passa da lì.
 *  · `plugin-capacitor-mai-risolto-da-promise` — `'KidvilleCaricamenti'` in `PLUGIN_NOTI` (il lato JS: il plugin non si
 *    restituisce mai da una funzione `async`).
 *  · `cookie-sessione-persistito-android` — un solo `onPause` in `MainActivity`, una sola classe che estende `BridgeActivity`,
 *    nessuna menzione di `CookieManager` in tutti i sorgenti Java (`onCreate` e `onResume` sono qui; `onPause` è suo).
 *  · `native-privacy-lock` — `allowBackup`, regole di estrazione, `PrivacyInfo.xcprivacy`, `loggingBehavior`.
 *  · `ios-navigazione-annullata` — le condizioni del filtro di `KVBridgeViewController` (nel file è vietato `absoluteString`).
 *  · `gate-shell-nativa` — i `capacitor.config.json` gitignorati e il cancello di build (`npm run rilascio:verifica`).
 *
 * ─── COME SI LEGGE UN SORGENTE QUI, E PERCHÉ ─────────────────────────────────────────────────
 * Un lock che legge un file come TESTO legge anche i commenti, e si immunizza da solo: i commenti di questi file nominano
 * ogni cosa che il lock cerca (`BuildConfig.DEBUG`, `READ_MEDIA_*`, `absoluteString`, `guard`). Perciò OGNI analisi parte da
 * `ripulisci()`, che toglie i commenti (e, dove serve la struttura, anche il contenuto dei letterali) lasciando intatte
 * lunghezze e a capo: le posizioni restano quelle del file vero. Le analisi sono funzioni pure `testo → problemi[]`, ognuna
 * col nome del file nel messaggio, così girano identiche sui file veri e sulle fixture.
 *
 * ─── IL CONTROLLO POSITIVO (in fondo) ────────────────────────────────────────────────────────
 * Un lock che non ha mai visto un rosso non è un lock. Le stesse funzioni girano su `fixtures/caricamenti-nativi-agganciati/`:
 * la cartella `ok/` (verde per costruzione) e `ko/` (un plugin Swift con un metodo mancante, un Java con
 * `creaElementoDiProva` fuori da `BuildConfig.DEBUG`, un manifest con `READ_MEDIA_VIDEO`, una chiamata di log con
 * `absoluteString`), più mutazioni in memoria della cartella `ok/` e dei file VERI (una fixture generata resta una fixture:
 * la regola deve diventare rossa anche sulla forma che i sorgenti hanno davvero). Ogni mutazione si ancora a una stringa che
 * deve esistere: se un sorgente cambia forma e l'ancora sparisce, il test cade e dice quale.
 *
 * ─── LIMITE DICHIARATO ───────────────────────────────────────────────────────────────────────
 * È un'analisi TESTUALE: dice che l'aggancio C'È e ha la forma giusta, non che FUNZIONI. Il comportamento lo provano
 * l'harness iOS (`ios/prove/caricamenti/esegui.sh`), JUnit (`./gradlew :app:testDebugUnitTest`) e i collaudi C1/E1 sul
 * simulatore e sugli emulatori. Per esempio, il lock legge i parametri della sessione `URLSession` dove sono dichiarati, ma
 * non prova che la sessione vera sia creata con QUELLA configurazione (lo guarda `prove-componenti.swift`).
 *
 * Il manifest FUSO (quello che finisce nell'AAB, con le librerie dentro) non esiste in CI: lo guardano
 * `ManifestCaricamentiTest` in locale e `scripts/leggi-manifest-aab.py` sul bundle prima dell'invio, e il tipo `dataSync` sul
 * servizio lo si legge nel manifest fuso Release (`docs/store-submission.md`, §7.2). Qui si guarda ciò che c'è sempre: il
 * manifest sorgente e i sorgenti. Un permesso media che una libreria aggiungesse con la fusione NON si vedrebbe da qui: la cura
 * sarebbe un `tools:node="remove"` nel manifest sorgente (che questo lock, se un giorno comparisse, non scambia per una
 * dichiarazione).
 */

const RADICE = path.resolve(__dirname, '..', '..')
const CARTELLA_FIXTURE = path.join(__dirname, 'fixtures', 'caricamenti-nativi-agganciati')

/** Dove stanno i file veri. Il pacchetto Java e la cartella Swift sono quelli di §5.1 e §6.1. */
const IOS_APP = 'ios/App/App'
const JAVA_APP = 'android/app/src/main/java/it/kidville/app'
const FILE = {
  pluginSwift: `${IOS_APP}/KVCaricamentiPlugin.swift`,
  controllerSwift: `${IOS_APP}/KVBridgeViewController.swift`,
  appDelegate: `${IOS_APP}/AppDelegate.swift`,
  motoreSwift: `${IOS_APP}/KVMotoreCaricamenti.swift`,
  registroSwift: `${IOS_APP}/KVRegistroNativo.swift`,
  infoPlist: `${IOS_APP}/Info.plist`,
  pbxproj: 'ios/App/App.xcodeproj/project.pbxproj',
  pluginJava: `${JAVA_APP}/caricamenti/KidvilleCaricamentiPlugin.java`,
  registroJava: `${JAVA_APP}/caricamenti/RegistroNativo.java`,
  mainActivity: `${JAVA_APP}/MainActivity.java`,
  manifest: 'android/app/src/main/AndroidManifest.xml',
  gradle: 'android/app/build.gradle',
  variabiliGradle: 'android/variables.gradle',
  logout: 'src/lib/auth/logout.ts',
} as const

/**
 * Le versioni della 1.2 (spec §5.8, §6.4): iOS `1.2 (6)`, Android `1.2` / `versionCode 4`.
 *
 * ⚠️ Il `4` e il `6` sono il «primo libero SECONDO IL REPO»: l'orchestratore li conferma in sola lettura su Play Console e su App
 * Store Connect prima di costruire. Se uno dei due fosse già usato, si alza in un branch di correzione (mai forzato) e questo lock si
 * aggiorna NELLO STESSO COMMIT, con la ragione scritta accanto al numero: un numero che cambia qui senza una riga di spiegazione è
 * un lock che si è arreso, non uno che si è aggiornato.
 */
const VERSIONE = { marketing: '1.2', buildIos: '6', nome: '1.2', codice: '4' } as const

function esiste(rel: string): boolean {
  return fs.existsSync(path.join(RADICE, rel))
}

/** Legge un file vero. Se manca, lo dice per nome: un `ENOENT` nudo non spiega che cosa si stava cercando. */
function leggi(rel: string): string {
  if (!esiste(rel)) throw new Error(`${rel}: il file non esiste (il lock lo cerca per agganciare i caricamenti nativi)`)
  return fs.readFileSync(path.join(RADICE, rel), 'utf8')
}

function leggiFixture(rel: string): string {
  return fs.readFileSync(path.join(CARTELLA_FIXTURE, rel), 'utf8')
}

/** Ogni file con una data estensione, ricorsivamente. */
function fileSotto(cartella: string, estensioni: readonly string[]): string[] {
  const radice = path.join(RADICE, cartella)
  if (!fs.existsSync(radice)) return []
  const trovati: string[] = []
  const visita = (dir: string): void => {
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
      const pieno = path.join(dir, voce.name)
      if (voce.isDirectory()) visita(pieno)
      else if (estensioni.some((e) => voce.name.endsWith(e))) trovati.push(path.relative(RADICE, pieno).split(path.sep).join('/'))
    }
  }
  visita(radice)
  return trovati.sort()
}

/**
 * Gli `.swift` dell'app, anche in sottocartelle: chi un giorno ordina i file del plugin in una cartella non deve far sparire i
 * suoi sorgenti dal lock (la fase Sources e le chiamate di log si guarderebbero su meno file di quelli veri).
 */
function swiftDellApp(): string[] {
  return fileSotto(IOS_APP, ['.swift'])
}

type Problemi = string[]

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * 1. LEGGERE UN SORGENTE SENZA I COMMENTI
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

type Lingua = 'swift' | 'java' | 'xml' | 'ts'
type Letterali = 'tieni' | 'svuota'

/** Fine di una stringa Swift: indice DOPO il terminatore. Gestisce `#"…"#`, `"""…"""` e le interpolazioni `\( … )` annidate. */
function fineStringaSwift(s: string, aperta: number): { fine: number; apertura: number; chiusura: number } {
  let k = aperta
  let h = 0
  while (s[k] === '#') {
    h += 1
    k += 1
  }
  const q = s.startsWith('"""', k) ? 3 : 1
  const terminatore = '"'.repeat(q) + '#'.repeat(h)
  const escape = `\\${'#'.repeat(h)}`
  let j = k + q
  while (j < s.length) {
    if (s.startsWith(terminatore, j)) return { fine: j + terminatore.length, apertura: h + q, chiusura: terminatore.length }
    if (s.startsWith(escape, j)) {
      const dopo = j + escape.length
      j = s[dopo] === '(' ? fineInterpolazioneSwift(s, dopo) : dopo + 1
      continue
    }
    // Una stringa a riga singola non chiusa si ferma a fine riga: meglio un letterale spezzato che un file inghiottito.
    if (q === 1 && s[j] === '\n') return { fine: j, apertura: h + q, chiusura: 0 }
    j += 1
  }
  return { fine: s.length, apertura: h + q, chiusura: 0 }
}

function fineInterpolazioneSwift(s: string, apre: number): number {
  let profondita = 0
  let j = apre
  while (j < s.length) {
    const c = s[j]
    if (c === '(') profondita += 1
    else if (c === ')') {
      profondita -= 1
      if (profondita === 0) return j + 1
    } else if (c === '"') {
      j = fineStringaSwift(s, j).fine
      continue
    }
    j += 1
  }
  return s.length
}

/**
 * Sostituisce con spazi i COMMENTI (lunghezza e a capo intatti: le posizioni restano quelle del file vero) e, con `svuota`,
 * anche il CONTENUTO dei letterali (le virgolette restano). Serve a due cose diverse: `svuota` per contare le graffe e le
 * parentesi senza farsi ingannare da una `{` dentro una stringa; `tieni` per leggere i nomi che stanno proprio nelle stringhe
 * (`jsName`, i messaggi di log, gli argomenti delle chiamate di log).
 */
function ripulisci(sorgente: string, lingua: Lingua, letterali: Letterali = 'tieni'): string {
  const n = sorgente.length
  const uscita = new Array<string>(n)
  const copia = (da: number, a: number): void => {
    for (let k = da; k < a; k += 1) uscita[k] = sorgente[k]
  }
  const spazi = (da: number, a: number): void => {
    for (let k = da; k < a; k += 1) uscita[k] = sorgente[k] === '\n' ? '\n' : ' '
  }
  const contenuto = (da: number, a: number): void => (letterali === 'tieni' ? copia(da, a) : spazi(da, a))

  let i = 0
  if (lingua === 'xml') {
    while (i < n) {
      if (sorgente.startsWith('<!--', i)) {
        const fine = sorgente.indexOf('-->', i + 4)
        const stop = fine < 0 ? n : fine + 3
        spazi(i, stop)
        i = stop
      } else {
        uscita[i] = sorgente[i]
        i += 1
      }
    }
    return uscita.join('')
  }

  while (i < n) {
    if (sorgente.startsWith('//', i)) {
      const fine = sorgente.indexOf('\n', i)
      const stop = fine < 0 ? n : fine
      spazi(i, stop)
      i = stop
    } else if (sorgente.startsWith('/*', i)) {
      let stop: number
      if (lingua === 'swift') {
        // I commenti a blocco di Swift si annidano.
        let profondita = 1
        let j = i + 2
        while (j < n && profondita > 0) {
          if (sorgente.startsWith('/*', j)) {
            profondita += 1
            j += 2
          } else if (sorgente.startsWith('*/', j)) {
            profondita -= 1
            j += 2
          } else j += 1
        }
        stop = j
      } else {
        const fine = sorgente.indexOf('*/', i + 2)
        stop = fine < 0 ? n : fine + 2
      }
      spazi(i, stop)
      i = stop
    } else if (lingua === 'swift' && (sorgente[i] === '"' || (sorgente[i] === '#' && /^#+"/.test(sorgente.slice(i, i + 16))))) {
      const { fine, apertura, chiusura } = fineStringaSwift(sorgente, i)
      copia(i, i + apertura)
      contenuto(i + apertura, fine - chiusura)
      copia(fine - chiusura, fine)
      i = fine
    } else if (lingua !== 'swift' && sorgente.startsWith('"""', i)) {
      // Blocco di testo di Java (15+).
      let j = i + 3
      while (j < n && !sorgente.startsWith('"""', j)) j += sorgente[j] === '\\' ? 2 : 1
      const chiuso = j < n
      const stop = chiuso ? j + 3 : n
      copia(i, i + 3)
      contenuto(i + 3, chiuso ? j : n)
      copia(chiuso ? j : n, stop)
      i = stop
    } else if (lingua !== 'swift' && (sorgente[i] === '"' || sorgente[i] === "'" || (lingua === 'ts' && sorgente[i] === '`'))) {
      const apice = sorgente[i]
      let j = i + 1
      while (j < n && sorgente[j] !== apice) j += sorgente[j] === '\\' ? 2 : 1
      const chiuso = j < n
      const stop = chiuso ? j + 1 : n
      copia(i, i + 1)
      contenuto(i + 1, chiuso ? j : n)
      copia(chiuso ? j : n, stop)
      i = stop
    } else {
      uscita[i] = sorgente[i]
      i += 1
    }
  }
  return uscita.join('')
}

/** L'indice della parentesi che chiude quella aperta in `apre` (su un testo già `svuota`to: i letterali non contano). */
function trovaChiusa(s: string, apre: number, aperta = '{', chiusa = '}'): number {
  let profondita = 0
  for (let i = apre; i < s.length; i += 1) {
    if (s[i] === aperta) profondita += 1
    else if (s[i] === chiusa) {
      profondita -= 1
      if (profondita === 0) return i
    }
  }
  return -1
}

/** Il corpo `{…}` che si apre dopo la prima corrispondenza di `firma`: gli estremi, in posizioni del testo intero. */
function corpoDopo(strutturale: string, firma: RegExp, da = 0): { apre: number; chiude: number; corpo: string } | null {
  const trovata = new RegExp(firma.source, firma.flags.replace('g', '')).exec(strutturale.slice(da))
  if (!trovata) return null
  const apre = strutturale.indexOf('{', da + trovata.index + trovata[0].length)
  if (apre < 0) return null
  const chiude = trovaChiusa(strutturale, apre)
  if (chiude < 0) return null
  return { apre, chiude, corpo: strutturale.slice(apre + 1, chiude) }
}

/** Quante graffe restano aperte prima di `posizione` dentro `corpo`: 0 = istruzione diretta del corpo. */
function profonditaA(corpo: string, posizione: number): number {
  let profondita = 0
  for (let i = 0; i < posizione; i += 1) {
    if (corpo[i] === '{') profondita += 1
    else if (corpo[i] === '}') profondita -= 1
  }
  return profondita
}

/** `true` se in `posizione` comincia un'istruzione intera: fra l'ultimo confine (`;` `{` `}` e, in Swift, l'a capo) e lì c'è solo spazio. */
function istruzioneIntera(corpo: string, posizione: number, lingua: 'swift' | 'java', prefissoAmmesso = ''): boolean {
  const prima = corpo.slice(0, posizione)
  const confini = lingua === 'swift' ? [';', '{', '}', '\n'] : [';', '{', '}']
  const confine = Math.max(...confini.map((c) => prima.lastIndexOf(c)))
  const frammento = prima.slice(confine + 1).trim()
  return frammento === '' || (prefissoAmmesso !== '' && new RegExp(`^(?:${prefissoAmmesso})$`).test(frammento))
}

function numeroDiRiga(testo: string, posizione: number): number {
  return testo.slice(0, posizione).split('\n').length
}

/** Gli elementi di `a` che non stanno in `b`. */
function differenza(a: readonly string[], b: readonly string[]): string[] {
  const insieme = new Set(b)
  return [...new Set(a)].filter((x) => !insieme.has(x))
}

/* ── Le regioni `#if` di Swift: «questo punto è dentro `#if DEBUG`?» ─────────────────────────── */

/** Le condizioni di compilazione attive in ogni punto del file (testo già ripulito dai commenti). */
function condizioniSwift(strutturale: string): (posizione: number) => string[] {
  const punti: { da: number; pila: string[] }[] = [{ da: 0, pila: [] }]
  const pila: string[] = []
  for (const m of strutturale.matchAll(/^[ \t]*#(if|elseif|else|endif)\b([^\n]*)$/gm)) {
    const direttiva = m[1]
    const resto = m[2].trim()
    if (direttiva === 'if') pila.push(resto)
    else if (direttiva === 'elseif') pila[pila.length - 1] = `elseif ${resto}`
    else if (direttiva === 'else') pila[pila.length - 1] = `else di ${pila[pila.length - 1] ?? ''}`
    else pila.pop()
    punti.push({ da: (m.index ?? 0) + m[0].length, pila: [...pila] })
  }
  return (posizione) => {
    let attiva = punti[0].pila
    for (const p of punti) {
      if (p.da <= posizione) attiva = p.pila
      else break
    }
    return attiva
  }
}

/** `#if DEBUG` esatto, ramo positivo: l'unico modo ammesso di tenere una cosa fuori dalle build Release. */
const soloInDebug = (condizioni: readonly string[]): boolean => condizioni.includes('DEBUG')

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * 2. IL PLUGIN: NOME, METODI, EVENTI (regole 1 e 2)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

const METODO_DI_PROVA = 'creaElementoDiProva'

/**
 * Il lato TypeScript del contratto, come PARAMETRO delle analisi: i file veri ricevono quello vero (`CONTRATTO_TS`), il controllo
 * positivo ne passa uno spostato di una cosa (un metodo in meno, un nome diverso, un messaggio che manca) e guarda il lock diventare
 * rosso. Un lock che legge il TS solo da una costante importata non potrebbe mai accorgersi che è LUI a essere cambiato.
 */
interface ContrattoTs {
  nome: string
  metodi: readonly string[]
  eventiPlugin: readonly string[]
  eventiLog: readonly string[]
}

const CONTRATTO_TS: ContrattoTs = {
  nome: NOME_PLUGIN_CARICAMENTI,
  metodi: METODI_PLUGIN_CARICAMENTI,
  eventiPlugin: EVENTI_PLUGIN_CARICAMENTI,
  eventiLog: EVENTI_LOG_NATIVI,
}

interface PluginSwift {
  classe: string | null
  nomeJs: string | null
  elencati: string[]
  elencatiSoloDebug: string[]
  implementati: string[]
  implementatiSoloDebug: string[]
  eventi: string[]
}

function leggiPluginSwift(testo: string): PluginSwift {
  const netto = ripulisci(testo, 'swift', 'tieni')
  const struttura = ripulisci(testo, 'swift', 'svuota')
  const condizioni = condizioniSwift(struttura)
  const elencati: string[] = []
  const elencatiSoloDebug: string[] = []
  for (const m of netto.matchAll(/\bCAPPluginMethod\s*\(\s*name\s*:\s*"([^"]+)"/g)) {
    const lista = soloInDebug(condizioni(m.index ?? 0)) ? elencatiSoloDebug : elencati
    lista.push(m[1])
  }
  const implementati: string[] = []
  const implementatiSoloDebug: string[] = []
  for (const m of struttura.matchAll(/@objc\s+(?:public\s+)?func\s+(\w+)\s*\(\s*_\s+\w+\s*:\s*CAPPluginCall\s*\)/g)) {
    const lista = soloInDebug(condizioni(m.index ?? 0)) ? implementatiSoloDebug : implementati
    lista.push(m[1])
  }
  return {
    classe: /\bclass\s+(\w+)\s*:\s*CAPPlugin\b/.exec(struttura)?.[1] ?? null,
    nomeJs: /\bjsName\s*(?::\s*String)?\s*=\s*"([^"]*)"/.exec(netto)?.[1] ?? null,
    elencati,
    elencatiSoloDebug,
    implementati,
    implementatiSoloDebug,
    eventi: [...netto.matchAll(/\b(?:notifica|notifyListeners)\s*\(\s*"([^"]+)"/g)].map((m) => m[1]),
  }
}

interface PluginJava {
  classe: string | null
  nome: string | null
  metodi: string[]
  /** Il corpo (già ripulito, letterali svuotati) di `creaElementoDiProva`, se c'è. */
  corpoProva: string | null
  eventi: string[]
}

function leggiPluginJava(testo: string): PluginJava {
  const netto = ripulisci(testo, 'java', 'tieni')
  const struttura = ripulisci(testo, 'java', 'svuota')
  const annotazione = /@CapacitorPlugin\s*\(([^)]*)\)/.exec(netto)
  const metodi = [
    ...struttura.matchAll(
      /@PluginMethod\b(?:\s*\([^)]*\))?\s*(?:@\w+(?:\s*\([^)]*\))?\s*)*(?:public\s+|protected\s+|private\s+)?(?:final\s+)?void\s+(\w+)\s*\(\s*PluginCall\s+\w+\s*\)/g,
    ),
  ].map((m) => m[1])
  const prova = corpoDopo(struttura, new RegExp(`\\bvoid\\s+${METODO_DI_PROVA}\\s*\\(\\s*PluginCall\\s+\\w+\\s*\\)`))

  // Le costanti `static final String EVENTO_X = "…"` e il loro uso in `notifyListeners(EVENTO_X, …)`.
  const costanti = new Map<string, string>()
  for (const m of netto.matchAll(/\bString\s+(\w+)\s*=\s*"([^"]*)"\s*;/g)) costanti.set(m[1], m[2])
  const eventi: string[] = []
  for (const m of netto.matchAll(/\bnotifyListeners\s*\(\s*(?:"([^"]+)"|(\w+))\s*,/g)) {
    const valore = m[1] ?? costanti.get(m[2] ?? '')
    if (valore) eventi.push(valore)
  }
  return {
    classe: /\bclass\s+(\w+)\s+extends\s+Plugin\b/.exec(struttura)?.[1] ?? null,
    nome: annotazione ? (/\bname\s*=\s*"([^"]+)"/.exec(annotazione[1])?.[1] ?? null) : null,
    metodi,
    corpoProva: prova ? prova.corpo : null,
    eventi,
  }
}

/**
 * `creaElementoDiProva` di Java è un `@PluginMethod` come gli altri (Capacitor le scopre per annotazione, non per elenco): la
 * protezione è nel CORPO. Ammesse due forme: `if (!BuildConfig.DEBUG) { … return; }` come PRIMA istruzione, oppure l'intero
 * corpo dentro `if (BuildConfig.DEBUG) { … }` (con al più un `else`). Qualunque altra cosa lascia la prova raggiungibile in Release.
 */
function eProtettoDaDebugJava(corpo: string): boolean {
  const nega = /^\s*if\s*\(\s*!\s*BuildConfig\s*\.\s*DEBUG\s*\)\s*/.exec(corpo)
  if (nega) {
    const dopo = corpo.slice(nega[0].length)
    if (dopo.startsWith('{')) {
      const chiude = trovaChiusa(dopo, 0)
      return chiude > 0 && /\breturn\b/.test(dopo.slice(1, chiude))
    }
    return /^[^;]*\breturn\b[^;]*;/.test(dopo)
  }
  const afferma = /^\s*if\s*\(\s*BuildConfig\s*\.\s*DEBUG\s*\)\s*\{/.exec(corpo)
  if (afferma) {
    const apre = afferma[0].length - 1
    const chiude = trovaChiusa(corpo, apre)
    if (chiude < 0) return false
    const resto = corpo.slice(chiude + 1).trim()
    return resto === '' || /^else\b/.test(resto)
  }
  return false
}

/** Regola 1 (nome) e regola 2 (metodi, `creaElementoDiProva`, eventi) per UN plugin Swift. */
function problemiPluginSwift(file: string, testo: string, c: ContrattoTs = CONTRATTO_TS): Problemi {
  const p = leggiPluginSwift(testo)
  const problemi: Problemi = []
  if (p.nomeJs === null) problemi.push(`${file}: nessun \`jsName\` letto: il plugin non ha un nome che il ponte possa registrare`)
  else if (p.nomeJs !== c.nome) {
    problemi.push(`${file}: jsName = "${p.nomeJs}" ma il nome del plugin è "${c.nome}" (NOME_PLUGIN_CARICAMENTI)`)
  }
  if (p.elencati.length === 0) problemi.push(`${file}: nessun \`CAPPluginMethod(name: …)\` fuori da #if DEBUG: \`pluginMethods\` è vuoto o non si legge più`)
  for (const m of differenza(c.metodi, p.elencati)) {
    problemi.push(`${file}: il metodo \`${m}\` è in METODI_PLUGIN_CARICAMENTI ma manca da \`pluginMethods\` (Swift): il JS lo chiamerebbe e il ponte risponderebbe «metodo non implementato»`)
  }
  for (const m of differenza(p.elencati, c.metodi)) {
    if (m === METODO_DI_PROVA) {
      problemi.push(`${file}: \`${METODO_DI_PROVA}\` è elencato in \`pluginMethods\` FUORI da #if DEBUG: esisterebbe nelle build Release`)
    } else {
      problemi.push(`${file}: il metodo \`${m}\` è in \`pluginMethods\` (Swift) ma non in METODI_PLUGIN_CARICAMENTI: il contratto TS non lo conosce`)
    }
  }
  for (const m of differenza(p.elencatiSoloDebug, [METODO_DI_PROVA])) {
    problemi.push(`${file}: il metodo \`${m}\` è elencato SOLO dentro #if DEBUG: nelle build Release il plugin non lo avrebbe`)
  }
  for (const m of differenza(p.elencati, p.implementati)) {
    problemi.push(`${file}: il metodo \`${m}\` è elencato in \`pluginMethods\` ma non ha un \`@objc func ${m}(_ call: CAPPluginCall)\``)
  }
  for (const m of differenza(p.implementati, p.elencati)) {
    problemi.push(`${file}: \`@objc func ${m}(_ call: CAPPluginCall)\` esiste ma non è elencato in \`pluginMethods\`: il JS non lo vedrebbe mai`)
  }
  if (p.implementati.includes(METODO_DI_PROVA)) {
    problemi.push(`${file}: \`@objc func ${METODO_DI_PROVA}\` è implementato FUORI da #if DEBUG`)
  }
  return problemi
}

/** Gli eventi emessi dal plugin (`addListener`) contro `EVENTI_PLUGIN_CARICAMENTI`. */
function problemiEventi(file: string, trovati: readonly string[], c: ContrattoTs = CONTRATTO_TS): Problemi {
  const problemi: Problemi = []
  for (const e of differenza(c.eventiPlugin, trovati)) {
    problemi.push(`${file}: l'evento \`${e}\` (EVENTI_PLUGIN_CARICAMENTI) non è mai emesso: il JS resterebbe ad aspettarlo e ripiegherebbe sul sondaggio ogni 10 secondi, in silenzio`)
  }
  for (const e of differenza(trovati, c.eventiPlugin)) {
    problemi.push(`${file}: emette l'evento \`${e}\`, che EVENTI_PLUGIN_CARICAMENTI non conosce: nessun ascoltatore lo prenderebbe`)
  }
  return problemi
}

function problemiPluginJava(file: string, testo: string, c: ContrattoTs = CONTRATTO_TS): Problemi {
  const p = leggiPluginJava(testo)
  const problemi: Problemi = []
  if (p.nome === null) problemi.push(`${file}: nessun \`@CapacitorPlugin(name = "…")\` letto: il plugin non ha un nome che il ponte possa registrare`)
  else if (p.nome !== c.nome) {
    problemi.push(`${file}: @CapacitorPlugin(name = "${p.nome}") ma il nome del plugin è "${c.nome}" (NOME_PLUGIN_CARICAMENTI)`)
  }
  const pubblici = p.metodi.filter((m) => m !== METODO_DI_PROVA)
  if (pubblici.length === 0) problemi.push(`${file}: nessun \`@PluginMethod\` letto: il plugin non espone niente`)
  for (const m of differenza(c.metodi, pubblici)) {
    problemi.push(`${file}: il metodo \`${m}\` è in METODI_PLUGIN_CARICAMENTI ma manca da Java (nessun \`@PluginMethod public void ${m}(PluginCall call)\`)`)
  }
  for (const m of differenza(pubblici, c.metodi)) {
    problemi.push(`${file}: \`@PluginMethod ${m}\` esiste ma non è in METODI_PLUGIN_CARICAMENTI: il contratto TS non lo conosce`)
  }
  if (p.metodi.includes(METODO_DI_PROVA)) {
    if (p.corpoProva === null || !eProtettoDaDebugJava(p.corpoProva)) {
      problemi.push(`${file}: \`${METODO_DI_PROVA}\` non è protetto da \`BuildConfig.DEBUG\` (serve \`if (!BuildConfig.DEBUG) { call.unimplemented(…); return; }\` come prima istruzione): nelle build Release un video di byte casuali sarebbe creabile dal JS`)
    }
  }
  return problemi
}

/** Il contratto TS non deve conoscere la prova: sta fuori da METODI_PLUGIN_CARICAMENTI per costruzione. */
function problemiContrattoTs(c: ContrattoTs): Problemi {
  return c.metodi.includes(METODO_DI_PROVA)
    ? [`caricamenti-nativi-tipi.ts: METODI_PLUGIN_CARICAMENTI contiene \`${METODO_DI_PROVA}\`, che esiste solo nelle build Debug`]
    : []
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * 3. LA REGISTRAZIONE (regola 3)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/** Le istruzioni che possono far USCIRE un metodo prima della fine: la registrazione deve stare prima di tutte. */
const USCITE_ANTICIPATE = /\b(?:guard|return|if|switch|while|for|throw|break|continue)\b/

/** `capacitorDidLoad` registra il plugin dopo `super.capacitorDidLoad()` e PRIMA di ogni `guard` che può uscire. */
function problemiRegistrazioneSwift(file: string, testo: string, classePlugin: string | null): Problemi {
  const struttura = ripulisci(testo, 'swift', 'svuota')
  const metodo = corpoDopo(struttura, /override\s+func\s+capacitorDidLoad\s*\(\s*\)/)
  if (!metodo) return [`${file}: nessun \`override func capacitorDidLoad()\`: è l'unico punto in cui il ponte è pronto a ricevere un plugin locale`]
  const corpo = metodo.corpo
  const netto = ripulisci(testo, 'swift', 'tieni').slice(metodo.apre + 1, metodo.chiude)
  const registra = /\bregisterPlugin(?:Instance|Type)\s*\(\s*(\w+)/.exec(netto)
  if (!registra) {
    return [`${file}: \`capacitorDidLoad\` non registra nessun plugin (\`bridge?.registerPluginInstance(${classePlugin ?? 'KVCaricamentiPlugin'}())\`): sul telefono \`isPluginAvailable\` risponderebbe false`]
  }
  const problemi: Problemi = []
  const posizione = registra.index
  if (classePlugin !== null && registra[1] !== classePlugin) {
    problemi.push(`${file}: \`capacitorDidLoad\` registra \`${registra[1]}\`, ma il plugin dei caricamenti è la classe \`${classePlugin}\``)
  }
  if (profonditaA(corpo, posizione) !== 0) {
    problemi.push(`${file}: la registrazione sta dentro un blocco (\`if\`, \`closure\`…) di \`capacitorDidLoad\`: può non eseguirsi mai`)
  }
  if (!istruzioneIntera(corpo, posizione, 'swift', '(?:self\\.)?bridge\\??\\.')) {
    problemi.push(`${file}: la registrazione non è un'istruzione intera di \`capacitorDidLoad\` (è dentro un'espressione o una condizione)`)
  }
  const prima = corpo.slice(0, posizione)
  const uscita = USCITE_ANTICIPATE.exec(prima)
  if (uscita) {
    problemi.push(`${file}: la registrazione sta DOPO un \`${uscita[0]}\` di \`capacitorDidLoad\` (riga ${numeroDiRiga(testo, metodo.apre + 1 + uscita.index)}): se quello esce, il filtro delle navigazioni spegne il plugin`)
  }
  return problemi
}

/** `MainActivity.onCreate` registra il plugin PRIMA di `super.onCreate(...)`: dopo, il ponte è già costruito senza. */
function problemiRegistrazioneJava(file: string, testo: string, classePlugin: string | null): Problemi {
  const struttura = ripulisci(testo, 'java', 'svuota')
  const metodo = corpoDopo(struttura, /\bvoid\s+onCreate\s*\(\s*Bundle\s+\w+\s*\)/)
  if (!metodo) return [`${file}: nessun \`onCreate(Bundle)\` in MainActivity: è lì che si registra un plugin locale`]
  const corpo = metodo.corpo
  const registra = /\bregisterPlugin\s*\(\s*(\w+)\s*\.\s*class\s*\)/.exec(corpo)
  if (!registra) {
    return [`${file}: \`onCreate\` non chiama \`registerPlugin(${classePlugin ?? 'KidvilleCaricamentiPlugin'}.class)\`: il plugin non esiste per il JavaScript`]
  }
  const problemi: Problemi = []
  const posizione = registra.index
  const sopra = /\bsuper\s*\.\s*onCreate\s*\(/.exec(corpo)
  if (!sopra) problemi.push(`${file}: \`onCreate\` non chiama \`super.onCreate(...)\``)
  else if (sopra.index < posizione) {
    problemi.push(`${file}: \`registerPlugin\` sta DOPO \`super.onCreate(...)\`: \`BridgeActivity\` ha già costruito il ponte con l'elenco dei plugin che aveva, e questo non esisterebbe`)
  }
  if (classePlugin !== null && registra[1] !== classePlugin) {
    problemi.push(`${file}: \`onCreate\` registra \`${registra[1]}.class\`, ma il plugin dei caricamenti è la classe \`${classePlugin}\``)
  }
  if (profonditaA(corpo, posizione) !== 0 || !istruzioneIntera(corpo, posizione, 'java', 'this\\s*\\.')) {
    problemi.push(`${file}: \`registerPlugin\` non è un'istruzione diretta e incondizionata di \`onCreate\``)
  }
  const uscita = USCITE_ANTICIPATE.exec(corpo.slice(0, posizione))
  if (uscita) problemi.push(`${file}: \`registerPlugin\` sta dopo un \`${uscita[0]}\` di \`onCreate\`: può non eseguirsi`)
  return problemi
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * 4. I PUNTI D'INGRESSO DEL SISTEMA (regola 4)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/** Una chiamata a `KVMotoreCaricamenti.condiviso.<metodo>(` DENTRO il corpo di una funzione dell'`AppDelegate`, non condizionata. */
function chiamataNelMetodo(
  struttura: string,
  firma: RegExp,
  chiamata: RegExp,
): { metodo: boolean; chiamata: boolean; incondizionata: boolean; argomenti: string } {
  const metodo = corpoDopo(struttura, firma)
  if (!metodo) return { metodo: false, chiamata: false, incondizionata: false, argomenti: '' }
  const dentro = chiamata.exec(metodo.corpo)
  if (!dentro) return { metodo: true, chiamata: false, incondizionata: false, argomenti: '' }
  const apre = metodo.corpo.indexOf('(', dentro.index + dentro[0].length - 1)
  const chiude = apre < 0 ? -1 : trovaChiusa(metodo.corpo, apre, '(', ')')
  const condizioni = condizioniSwift(struttura)(metodo.apre + 1 + dentro.index)
  return {
    metodo: true,
    chiamata: true,
    incondizionata:
      profonditaA(metodo.corpo, dentro.index) === 0 && condizioni.length === 0 && istruzioneIntera(metodo.corpo, dentro.index, 'swift'),
    argomenti: apre >= 0 && chiude > apre ? metodo.corpo.slice(apre + 1, chiude) : '',
  }
}

/** Regola 4, lato iOS: l'`AppDelegate` aggancia il motore, e il motore dichiara quei metodi. */
function problemiAppDelegate(fileDelegate: string, testoDelegate: string, fileMotore: string, testoMotore: string): Problemi {
  const struttura = ripulisci(testoDelegate, 'swift', 'svuota')
  const problemi: Problemi = []
  const motore = 'KVMotoreCaricamenti\\s*\\.\\s*condiviso\\s*\\.\\s*'
  const ingressi: { nome: string; firma: RegExp; chiamata: string; perche: string }[] = [
    {
      nome: 'application(_:didFinishLaunchingWithOptions:)',
      firma: /func\s+application\s*\(\s*_\s+\w+\s*:\s*UIApplication\s*,\s*didFinishLaunchingWithOptions\b/,
      chiamata: 'avvia',
      perche: 'senza, la sessione in background non si riaggancia e gli eventi in sospeso non si consegnano a un avvio da app terminata',
    },
    {
      nome: 'applicationDidBecomeActive',
      firma: /func\s+applicationDidBecomeActive\s*\(/,
      chiamata: 'riprendiInPrimoPiano',
      perche: 'senza, una voce senza task vivo, una chiusa a forza o una creata in background non ripartono mai alla riapertura',
    },
    {
      nome: 'applicationDidEnterBackground',
      firma: /func\s+applicationDidEnterBackground\s*\(/,
      chiamata: 'notificaSeFermo',
      perche: 'senza, la notifica locale «in attesa di rete» (decisione del titolare) non parte: a app sospesa nessun codice gira più',
    },
  ]
  for (const ingresso of ingressi) {
    const r = chiamataNelMetodo(struttura, ingresso.firma, new RegExp(`${motore}${ingresso.chiamata}\\s*\\(`))
    if (!r.metodo) problemi.push(`${fileDelegate}: manca \`${ingresso.nome}\``)
    else if (!r.chiamata) {
      problemi.push(`${fileDelegate}: \`${ingresso.nome}\` non chiama \`KVMotoreCaricamenti.condiviso.${ingresso.chiamata}()\`: ${ingresso.perche}`)
    } else if (!r.incondizionata) {
      problemi.push(`${fileDelegate}: \`${ingresso.nome}\` chiama \`${ingresso.chiamata}()\` dentro un blocco o una compilazione condizionale: non gira sempre`)
    }
  }
  const sessione = chiamataNelMetodo(
    struttura,
    /func\s+application\s*\(\s*_\s+\w+\s*:\s*UIApplication\s*,\s*handleEventsForBackgroundURLSession\b/,
    new RegExp(`${motore}ricollega\\s*\\(`),
  )
  if (!sessione.metodo) {
    problemi.push(`${fileDelegate}: manca \`application(_:handleEventsForBackgroundURLSession:completionHandler:)\`: iOS non può risvegliare l'app a trasferimento finito`)
  } else if (!sessione.chiamata) {
    problemi.push(`${fileDelegate}: \`handleEventsForBackgroundURLSession\` non chiama \`KVMotoreCaricamenti.condiviso.ricollega(...)\`: il completamento non verrebbe mai tenuto né chiamato`)
  } else if (!/\bidentifier\b/.test(sessione.argomenti) || !/\bcompletionHandler\b/.test(sessione.argomenti)) {
    problemi.push(`${fileDelegate}: \`ricollega(...)\` non riceve \`identifier\` e \`completionHandler\`: iOS aspetta il completamento e, se non arriva, penalizza l'app`)
  }

  // Il motore dichiara davvero ciò che l'AppDelegate chiama: la CI non compila Swift, un nome cambiato da una parte sola non si vedrebbe.
  const strutturaMotore = ripulisci(testoMotore, 'swift', 'svuota')
  const classe = corpoDopo(strutturaMotore, /\bclass\s+KVMotoreCaricamenti\b/)
  if (!classe) {
    problemi.push(`${fileMotore}: nessuna \`class KVMotoreCaricamenti\`: è il singolo che l'AppDelegate chiama`)
  } else {
    if (!/\bstatic\s+let\s+condiviso\b/.test(classe.corpo)) problemi.push(`${fileMotore}: \`KVMotoreCaricamenti\` non dichiara \`static let condiviso\``)
    for (const funzione of ['avvia', 'ricollega', 'riprendiInPrimoPiano', 'notificaSeFermo']) {
      if (!new RegExp(`\\bfunc\\s+${funzione}\\s*\\(`).test(classe.corpo)) {
        problemi.push(`${fileMotore}: \`KVMotoreCaricamenti\` non dichiara \`func ${funzione}(...)\`, che l'AppDelegate chiama`)
      }
    }
  }
  return problemi
}

/** Regola 4, lato Android: `onResume` richiama `riprendiInPrimoPiano` dopo `super.onResume()`, e un guasto non fa cadere l'Activity. */
function problemiOnResume(file: string, testo: string): Problemi {
  const struttura = ripulisci(testo, 'java', 'svuota')
  const metodo = corpoDopo(struttura, /\bvoid\s+onResume\s*\(\s*\)/)
  if (!metodo) return [`${file}: nessun \`onResume()\` in MainActivity: i caricamenti in pausa o in attesa non ripartirebbero alla riapertura dell'app`]
  const corpo = metodo.corpo
  const problemi: Problemi = []
  const sopra = /\bsuper\s*\.\s*onResume\s*\(\s*\)/.exec(corpo)
  const ripresa = /\bPianificatoreCaricamenti\s*\.\s*riprendiInPrimoPiano\s*\(/.exec(corpo)
  if (!sopra) problemi.push(`${file}: \`onResume\` non chiama \`super.onResume()\``)
  if (!ripresa) {
    problemi.push(`${file}: \`onResume\` non chiama \`PianificatoreCaricamenti.riprendiInPrimoPiano(this)\`: la pausa «tocca per riprendere» di Android 12-13 non si riprenderebbe mai`)
  } else {
    if (sopra && sopra.index > ripresa.index) problemi.push(`${file}: \`riprendiInPrimoPiano\` sta PRIMA di \`super.onResume()\``)
    const prova = /\btry\s*\{/.exec(corpo)
    const dentro = prova ? trovaChiusa(corpo, corpo.indexOf('{', prova.index)) : -1
    if (!prova || prova.index > ripresa.index || dentro < ripresa.index || !/\bcatch\s*\(\s*Throwable\b/.test(corpo.slice(dentro))) {
      problemi.push(`${file}: \`riprendiInPrimoPiano\` non sta in un \`try { … } catch (Throwable …)\`: un guasto del motore farebbe cadere l'Activity (spec §6.5)`)
    }
  }
  return problemi
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * 5. LA SESSIONE URLSession IN BACKGROUND (regola 5)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

const IDENTIFICATIVO_SESSIONE = 'it.kidville.app.caricamenti'

/** Il valore di una costante Swift, seguendo le catene `static let a = Tipo.b` fino a un letterale. */
function valoreCostanteSwift(espressione: string, testi: readonly string[], giri = 0): string | null {
  const letterale = /^\s*"([^"]*)"\s*$/.exec(espressione)
  if (letterale) return letterale[1]
  if (giri > 6) return null
  const nome = /(\w+)\s*$/.exec(espressione.trim())?.[1]
  if (!nome) return null
  // Prima le costanti `static` (è così che si dichiara un identificativo), poi qualunque `let`: una variabile locale omonima
  // di un altro file non deve poter nascondere quella vera.
  for (const dichiarazione of ['\\bstatic\\s+(?:let|var)', '\\b(?:let|var)']) {
    for (const testo of testi) {
      const m = new RegExp(`${dichiarazione}\\s+${nome}\\s*(?::\\s*String)?\\s*=\\s*("[^"\\n]*"|[\\w.]+)`).exec(testo)
      if (m) return valoreCostanteSwift(m[1], testi, giri + 1)
    }
  }
  return null
}

/** Le impostazioni che il titolare ha deciso («qualunque rete») e che la spec fissa in §5.2. */
const IMPOSTAZIONI_SESSIONE: Record<string, string> = {
  sessionSendsLaunchEvents: 'true',
  isDiscretionary: 'false',
  allowsCellularAccess: 'true',
  allowsExpensiveNetworkAccess: 'true',
  allowsConstrainedNetworkAccess: 'true',
  httpShouldSetCookies: 'false',
}

function problemiSessione(sorgenti: readonly { file: string; testo: string }[]): Problemi {
  const trovate: { file: string; variabile: string; identificativo: string; ambito: string }[] = []
  const nettiTutti = sorgenti.map((s) => ripulisci(s.testo, 'swift', 'tieni'))
  sorgenti.forEach((s, indice) => {
    const struttura = ripulisci(s.testo, 'swift', 'svuota')
    const netto = nettiTutti[indice]
    for (const m of struttura.matchAll(/\b(?:let|var)\s+(\w+)\s*=\s*URLSessionConfiguration\s*\.\s*background\s*\(\s*withIdentifier\s*:/g)) {
      // La `(` di `background(`: l'ultima del frammento trovato (non ce ne sono altre prima di `withIdentifier`).
      const apre = (m.index ?? 0) + m[0].lastIndexOf('(')
      const chiude = trovaChiusa(struttura, apre, '(', ')')
      // L'ambito è il resto del blocco in cui la configurazione è dichiarata.
      let prof = 0
      let fine = struttura.length
      for (let i = chiude + 1; i < struttura.length; i += 1) {
        if (struttura[i] === '{') prof += 1
        else if (struttura[i] === '}') {
          if (prof === 0) {
            fine = i
            break
          }
          prof -= 1
        }
      }
      trovate.push({
        file: s.file,
        variabile: m[1],
        identificativo: netto.slice(apre + 1, chiude).replace(/^\s*withIdentifier\s*:\s*/, '').trim(),
        ambito: netto.slice(chiude + 1, fine),
      })
    }
  })
  if (trovate.length === 0) {
    return [`ios/App/App/*.swift: nessuna \`URLSessionConfiguration.background(withIdentifier:)\`: senza una sessione in background l'invio muore con l'app (§5.2)`]
  }
  if (trovate.length > 1) {
    return [`${trovate.map((t) => t.file).join(', ')}: ${trovate.length} configurazioni \`background(withIdentifier:)\`: ne serve UNA, con l'identificativo che iOS usa per risvegliare l'app`]
  }
  const { file, variabile, identificativo, ambito } = trovate[0]
  const problemi: Problemi = []
  const valore = valoreCostanteSwift(identificativo, nettiTutti)
  if (valore !== IDENTIFICATIVO_SESSIONE) {
    problemi.push(`${file}: l'identificativo della sessione in background è ${valore === null ? `\`${identificativo}\` (non si risolve a un letterale)` : `"${valore}"`}, deve essere "${IDENTIFICATIVO_SESSIONE}" (§5.2)`)
  }
  const assegnate = new Map<string, string>()
  for (const m of ambito.matchAll(new RegExp(`\\b${variabile}\\s*\\.\\s*(\\w+)\\s*=\\s*([^\\n;]+)`, 'g'))) assegnate.set(m[1], m[2].trim())
  for (const [chiave, atteso] of Object.entries(IMPOSTAZIONI_SESSIONE)) {
    const trovato = assegnate.get(chiave)
    if (trovato === undefined) {
      problemi.push(`${file}: la sessione in background non imposta \`${chiave} = ${atteso}\` (§5.2${chiave.startsWith('allows') ? ': «qualunque rete», decisione del titolare' : ''})`)
    } else if (trovato !== atteso) {
      problemi.push(`${file}: la sessione in background ha \`${chiave} = ${trovato}\`, deve essere \`${atteso}\` (§5.2${chiave.startsWith('allows') ? ': «qualunque rete», decisione del titolare' : ''})`)
    }
  }
  return problemi
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * 6. IL PROGETTO XCODE E IL MANIFEST: «ESISTE» NON VUOL DIRE «COMPILA» (regole 6, 7, 8)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

interface OggettoPbx {
  id: string
  nome: string
  corpo: string
}

/** Gli oggetti di una sezione del `project.pbxproj` (formato di Xcode: un oggetto per riga o fra `\t\tID = {` e `\t\t};`). */
function oggettiPbx(testo: string, sezione: string): OggettoPbx[] {
  const inizio = testo.indexOf(`/* Begin ${sezione} section */`)
  const fine = testo.indexOf(`/* End ${sezione} section */`)
  if (inizio < 0 || fine < 0) return []
  const righe = testo.slice(inizio, fine).split('\n')
  const oggetti: OggettoPbx[] = []
  for (let r = 0; r < righe.length; r += 1) {
    const m = /^\t\t([0-9A-Za-z_]+)(?: \/\* (.*?) \*\/)? = \{(.*)$/.exec(righe[r])
    if (!m) continue
    let corpo = m[3]
    if (!/\};\s*$/.test(corpo)) {
      const pezzi = [corpo]
      while (r + 1 < righe.length && !/^\t\t\};\s*$/.test(righe[r + 1])) {
        r += 1
        pezzi.push(righe[r])
      }
      r += 1
      corpo = pezzi.join('\n')
    }
    oggetti.push({ id: m[1], nome: m[2] ?? '', corpo })
  }
  return oggetti
}

// Gli id di una lista `chiave = ( ID, … );` del pbxproj: ogni voce è l'id, poi il commento di Xcode col nome, poi la virgola.
function elencoPbx(corpo: string, chiave: string): string[] {
  const m = new RegExp(`\\b${chiave} = \\(([\\s\\S]*?)\\);`).exec(corpo)
  return m ? [...m[1].matchAll(/([0-9A-Za-z_]+)(?: \/\* .*? \*\/)?,/g)].map((x) => x[1]) : []
}

interface ProgettoXcode {
  target: OggettoPbx | null
  /** I nomi dei file nella fase Sources del target. */
  inSources: string[]
  configurazioni: { nome: string; corpo: string }[]
}

function leggiProgettoXcode(pbx: string): ProgettoXcode {
  const target = oggettiPbx(pbx, 'PBXNativeTarget').find((o) => /\bname = App;/.test(o.corpo) && /product-type\.application/.test(o.corpo)) ?? null
  if (!target) return { target: null, inSources: [], configurazioni: [] }
  const fasi = new Map(oggettiPbx(pbx, 'PBXSourcesBuildPhase').map((o) => [o.id, o]))
  const sources = elencoPbx(target.corpo, 'buildPhases').map((id) => fasi.get(id)).find((o) => o !== undefined)
  const buildFile = new Map(oggettiPbx(pbx, 'PBXBuildFile').map((o) => [o.id, /\bfileRef = ([0-9A-Za-z_]+)/.exec(o.corpo)?.[1] ?? '']))
  const riferimenti = new Map(
    oggettiPbx(pbx, 'PBXFileReference').map((o) => [o.id, /\bpath = "?([^";]+)"?;/.exec(o.corpo)?.[1] ?? o.nome]),
  )
  const inSources = (sources ? elencoPbx(sources.corpo, 'files') : [])
    .map((id) => riferimenti.get(buildFile.get(id) ?? '') ?? '')
    .filter((n) => n !== '')
  const idLista = /\bbuildConfigurationList = ([0-9A-Za-z_]+)/.exec(target.corpo)?.[1]
  const lista = oggettiPbx(pbx, 'XCConfigurationList').find((o) => o.id === idLista)
  const configurazioniPerId = new Map(oggettiPbx(pbx, 'XCBuildConfiguration').map((o) => [o.id, o]))
  const configurazioni = (lista ? elencoPbx(lista.corpo, 'buildConfigurations') : [])
    .map((id) => configurazioniPerId.get(id))
    .filter((o): o is OggettoPbx => o !== undefined)
    .map((o) => ({ nome: /\bname = (\w+);/.exec(o.corpo)?.[1] ?? o.nome, corpo: o.corpo }))
  return { target, inSources, configurazioni }
}

/** Regola 6: ogni `.swift` che sta in `ios/App/App` è compilato dal target `App`, e ogni voce di Sources esiste sul disco. */
function problemiSources(file: string, pbx: string, swiftSuDisco: readonly string[]): Problemi {
  const p = leggiProgettoXcode(pbx)
  if (!p.target) return [`${file}: nessun target \`App\` (applicazione) nel progetto: il lock non sa più dove guardare`]
  if (p.inSources.length === 0) return [`${file}: la fase Sources del target \`App\` è vuota o non si legge`]
  const problemi: Problemi = []
  const nomiSuDisco = swiftSuDisco.map((f) => path.posix.basename(f))
  for (const nome of differenza(nomiSuDisco, p.inSources)) {
    problemi.push(`${file}: \`${nome}\` sta sul disco (ios/App/App) ma NON nella fase Sources del target \`App\`: Xcode non lo compila, e il codice che lo chiama non si linka (o, peggio, non gira)`)
  }
  for (const nome of differenza(p.inSources.filter((n) => n.endsWith('.swift')), nomiSuDisco)) {
    problemi.push(`${file}: la fase Sources nomina \`${nome}\` ma il file non sta in ios/App/App: la build non trova il sorgente`)
  }
  return problemi
}

/** Regola 8 (iOS): `MARKETING_VERSION` e `CURRENT_PROJECT_VERSION` in TUTTE le configurazioni dell'app; e Release non è Debug. */
function problemiVersioniIos(file: string, pbx: string): Problemi {
  const p = leggiProgettoXcode(pbx)
  if (!p.target) return [`${file}: nessun target \`App\` (applicazione) nel progetto`]
  const problemi: Problemi = []
  if (p.configurazioni.length < 2) {
    problemi.push(`${file}: il target \`App\` ha ${p.configurazioni.length} configurazioni, ne servono almeno due (Debug e Release)`)
  }
  for (const c of p.configurazioni) {
    const marketing = /\bMARKETING_VERSION = "?([^";]+)"?;/.exec(c.corpo)?.[1]
    const build = /\bCURRENT_PROJECT_VERSION = "?([^";]+)"?;/.exec(c.corpo)?.[1]
    if (marketing !== VERSIONE.marketing) {
      problemi.push(`${file}: configurazione ${c.nome}: MARKETING_VERSION = ${marketing ?? '(assente)'}, deve essere ${VERSIONE.marketing} (la 1.2)`)
    }
    if (build !== VERSIONE.buildIos) {
      problemi.push(`${file}: configurazione ${c.nome}: CURRENT_PROJECT_VERSION = ${build ?? '(assente)'}, deve essere ${VERSIONE.buildIos} (la 1.2 (6))`)
    }
  }
  // Qualunque altra occorrenza nel file (una configurazione del progetto, un altro target) non deve smentire la 1.2.
  // Le configurazioni dell'app sono già giudicate sopra, col loro nome: qui si guarda solo ciò che sta FUORI da quelle.
  const altrove = p.configurazioni.reduce((testo, c) => testo.replace(c.corpo, ''), pbx)
  for (const m of altrove.matchAll(/\b(MARKETING_VERSION|CURRENT_PROJECT_VERSION) = "?([^";]+)"?;/g)) {
    const atteso = m[1] === 'MARKETING_VERSION' ? VERSIONE.marketing : VERSIONE.buildIos
    if (m[2] !== atteso) problemi.push(`${file}: in una configurazione o un target che non è l'app: ${m[1]} = ${m[2]}, deve essere ${atteso}`)
  }
  // `creaElementoDiProva` sta dietro `#if DEBUG`: ha senso solo se Release non definisce DEBUG.
  const release = p.configurazioni.find((c) => c.nome === 'Release')
  if (release) {
    const condizioni = /\bSWIFT_ACTIVE_COMPILATION_CONDITIONS = ("[^"]*"|[^;]*);/.exec(release.corpo)?.[1] ?? ''
    const flag = /\bOTHER_SWIFT_FLAGS = ("(?:[^"\\]|\\.)*"|[^;]*);/.exec(release.corpo)?.[1] ?? ''
    if (/\bDEBUG\b/.test(condizioni) || /DEBUG/.test(flag)) {
      problemi.push(`${file}: la configurazione Release definisce DEBUG: \`#if DEBUG\` (creaElementoDiProva, host di prova) esisterebbe nelle build per lo store`)
    }
  }
  return problemi
}

/** Regola 7 (iOS): l'invio in background di una `URLSession` non vuole `UIBackgroundModes` e dichiararlo è un motivo di rigetto (2.5.4). */
function problemiInfoPlist(file: string, plist: string): Problemi {
  return /<key>\s*UIBackgroundModes\s*<\/key>/.test(ripulisci(plist, 'xml'))
    ? [`${file}: contiene \`UIBackgroundModes\`: una sessione URLSession in background non lo richiede, e dichiarare un background mode non usato è un motivo di rigetto (App Review 2.5.4, spec §1.3)`]
    : []
}

/** Regola 8 (Android). */
function problemiGradle(file: string, gradle: string): Problemi {
  const netto = ripulisci(gradle, 'java', 'tieni')
  const problemi: Problemi = []
  const codice = /\bversionCode\s+(\d+)/.exec(netto)?.[1]
  const nome = /\bversionName\s+["']([^"']+)["']/.exec(netto)?.[1]
  if (codice !== VERSIONE.codice) problemi.push(`${file}: versionCode ${codice ?? '(assente)'}, deve essere ${VERSIONE.codice} (la 1.2: il 3 è la 1.1 già pubblicata)`)
  if (nome !== VERSIONE.nome) problemi.push(`${file}: versionName "${nome ?? '(assente)'}", deve essere "${VERSIONE.nome}"`)
  if (!/\bandroidx\.work:work-runtime:/.test(netto)) {
    problemi.push(`${file}: manca \`implementation "androidx.work:work-runtime:…"\`: è il motore di API 24-33 e porta il \`SystemForegroundService\` che il manifest dichiara`)
  }
  if (!/\bbuildFeatures\s*\{[^}]*\bbuildConfig\s+true\b/.test(netto)) {
    problemi.push(`${file}: manca \`buildFeatures { buildConfig true }\`: con AGP 8 \`BuildConfig\` non si genera da solo, e il plugin usa \`BuildConfig.DEBUG\` (non compilerebbe)`)
  }
  const struttura = ripulisci(gradle, 'java', 'svuota')
  const release = corpoDopo(struttura, /\bbuildTypes\s*\{[\s\S]*?\brelease\b/)
  if (release && /\bdebuggable\s*(?:=\s*)?true\b/.test(release.corpo)) {
    problemi.push(`${file}: il buildType release ha \`debuggable true\`: \`BuildConfig.DEBUG\` varrebbe true nelle build per lo store e \`creaElementoDiProva\` sarebbe raggiungibile`)
  }
  return problemi
}

/** `build.gradle` usa `$androidxWorkVersion`: se `variables.gradle` non la definisce, Gradle non configura nemmeno il modulo (e la CI non lo compila). */
function problemiVariabiliGradle(file: string, testo: string): Problemi {
  return /\bandroidxWorkVersion\s*=\s*['"]\d+\.\d+\.\d+['"]/.test(ripulisci(testo, 'java', 'tieni'))
    ? []
    : [`${file}: manca \`androidxWorkVersion = '<versione>'\`: build.gradle la usa per \`androidx.work:work-runtime\` e senza, Gradle non configura il modulo`]
}

interface ElementoManifest {
  tag: string
  attributi: Record<string, string>
}

/** I tag di apertura del manifest, senza commenti. */
function elementiManifest(xml: string): ElementoManifest[] {
  const netto = ripulisci(xml, 'xml')
  return [...netto.matchAll(/<([A-Za-z][\w:.-]*)\b([^<>]*?)\/?>/g)].map((m) => ({
    tag: m[1],
    attributi: Object.fromEntries([...m[2].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1], a[2]])),
  }))
}

/** I permessi che un'app con foto di bambini NON deve dichiarare (policy «Foto e video» di Google Play; spec §6.4). */
const PERMESSO_MEDIA = /(?:^|\.)(READ_MEDIA_[A-Z_]+|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|ACCESS_MEDIA_LOCATION|MANAGE_EXTERNAL_STORAGE)$/

const PERMESSI_RICHIESTI = [
  'android.permission.INTERNET',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.RUN_USER_INITIATED_JOBS',
] as const

/** Regola 7 (Android): permessi e servizi di §6.4, e nessun permesso media. `tools:node="remove"` NON è una dichiarazione: è la cura. */
function problemiManifest(file: string, xml: string, componentiDelPacchetto: readonly string[]): Problemi {
  const elementi = elementiManifest(xml)
  const problemi: Problemi = []
  const radice = elementi.find((e) => e.tag === 'manifest')
  if (!radice) return [`${file}: nessun elemento \`<manifest>\`: il file non si legge`]
  if (!radice.attributi['xmlns:tools']) problemi.push(`${file}: la radice non dichiara \`xmlns:tools\`: senza, \`tools:node="merge"\` sul servizio di WorkManager non si compila`)
  const permessi = elementi.filter((e) => /^uses-permission/.test(e.tag))
  const dichiarati = permessi.filter((e) => e.attributi['tools:node'] !== 'remove').map((e) => e.attributi['android:name'] ?? '')
  for (const richiesto of PERMESSI_RICHIESTI) {
    if (!dichiarati.includes(richiesto)) problemi.push(`${file}: manca \`<uses-permission android:name="${richiesto}"/>\` (§6.4)`)
  }
  for (const nome of dichiarati) {
    if (PERMESSO_MEDIA.test(nome)) {
      problemi.push(`${file}: dichiara ${nome}: un permesso media farebbe entrare un'app con foto di bambini nella policy «Foto e video» di Google Play (il Photo Picker e il SAF non ne hanno bisogno; docs/submission/C2-build-aab.md §7)`)
    }
  }
  const servizi = elementi.filter((e) => e.tag === 'service')
  const lavoro = servizi.find((e) => e.attributi['android:name'] === 'androidx.work.impl.foreground.SystemForegroundService')
  if (!lavoro) {
    problemi.push(`${file}: manca il \`<service android:name="androidx.work.impl.foreground.SystemForegroundService" android:foregroundServiceType="dataSync" tools:node="merge"/>\`: su Android 14 \`startForeground(…, dataSync)\` senza tipo dichiarato lancia \`InvalidForegroundServiceTypeException\``)
  } else {
    if (!/\bdataSync\b/.test(lavoro.attributi['android:foregroundServiceType'] ?? '')) {
      problemi.push(`${file}: \`SystemForegroundService\` non dichiara \`android:foregroundServiceType="dataSync"\``)
    }
    if (lavoro.attributi['tools:node'] !== 'merge') {
      problemi.push(`${file}: \`SystemForegroundService\` non ha \`tools:node="merge"\`: sostituirebbe la dichiarazione della libreria invece di aggiungerle il tipo`)
    }
  }
  const uidt = servizi.find((e) => /(?:^|\.)ServizioCaricamentiUidt$/.test(e.attributi['android:name'] ?? ''))
  if (!uidt) {
    problemi.push(`${file}: manca il \`<service android:name=".caricamenti.ServizioCaricamentiUidt" android:permission="android.permission.BIND_JOB_SERVICE" android:exported="false"/>\`: il motore di API 34+ non potrebbe essere legato dal sistema`)
  } else {
    if (uidt.attributi['android:permission'] !== 'android.permission.BIND_JOB_SERVICE') {
      problemi.push(`${file}: \`ServizioCaricamentiUidt\` senza \`android:permission="android.permission.BIND_JOB_SERVICE"\`: JobScheduler rifiuterebbe di legarlo`)
    }
    if (uidt.attributi['android:exported'] !== 'false') {
      problemi.push(`${file}: \`ServizioCaricamentiUidt\` non è \`android:exported="false"\`: da fuori non si deve poter aprire`)
    }
  }
  // Ogni componente (Service, Receiver, Activity, Provider) del pacchetto dei caricamenti è dichiarato: è l'equivalente Android di «sta in Sources».
  const nomiDichiarati = elementi
    .filter((e) => ['service', 'receiver', 'activity', 'provider'].includes(e.tag))
    .map((e) => (e.attributi['android:name'] ?? '').replace(/^\./, ''))
  for (const classe of componentiDelPacchetto) {
    if (!nomiDichiarati.some((n) => n === classe || n.endsWith(`.${classe}`))) {
      problemi.push(`${file}: la classe \`${classe}\` è un componente Android del pacchetto dei caricamenti ma non è dichiarata nel manifest: il sistema non potrebbe istanziarla`)
    }
  }
  return problemi
}

/** I componenti Android (Service, JobService, Receiver, Activity, Provider) dichiarati nei sorgenti: servono al manifest. */
function componentiAndroid(sorgenti: readonly { file: string; testo: string }[]): string[] {
  const componenti: string[] = []
  for (const s of sorgenti) {
    const struttura = ripulisci(s.testo, 'java', 'svuota')
    for (const m of struttura.matchAll(/\bclass\s+(\w+)\s+extends\s+(?:JobService|Service|IntentService|BroadcastReceiver|ContentProvider|Activity|AppCompatActivity|BridgeActivity)\b/g)) {
      componenti.push(m[1])
    }
  }
  return componenti
}

/** Nessun sorgente Java nomina un permesso media (`Manifest.permission.READ_MEDIA_IMAGES`, `requestPermissions` con quel nome…). */
function problemiPermessiNeiSorgenti(sorgenti: readonly { file: string; testo: string }[]): Problemi {
  const problemi: Problemi = []
  for (const s of sorgenti) {
    const netto = ripulisci(s.testo, 'java', 'tieni')
    for (const m of netto.matchAll(/\b(READ_MEDIA_[A-Z_]+|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|ACCESS_MEDIA_LOCATION|MANAGE_EXTERNAL_STORAGE)\b/g)) {
      problemi.push(`${s.file}: riga ${numeroDiRiga(netto, m.index ?? 0)}: nomina ${m[1]}: l'app non chiede permessi media (Photo Picker e SAF lavorano fuori dal processo)`)
    }
  }
  return problemi
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * 7. I LOG DEL NATIVO (regole 9 e 10)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/** Le cose che in un log di un'app di minori non devono mai comparire: credenziali, indirizzi, nomi di file, testi d'errore del sistema. */
const PROIBITI_NEI_LOG_COMUNI = [
  'x-upsert',
  'apikey',
  'authorization',
  'localizedDescription',
  'absoluteString',
  'suggestedName',
  'lastPathComponent',
] as const
/** Gli equivalenti Java: il testo di un'eccezione e il nome di un file sono le stesse cose con un altro nome (§8.1). */
const PROIBITI_NEI_LOG_JAVA = [...PROIBITI_NEI_LOG_COMUNI, 'getMessage', 'getLocalizedMessage', 'getLastPathSegment'] as const

function proibitiIn(argomenti: string, lingua: 'swift' | 'java'): string[] {
  const elenco = lingua === 'swift' ? PROIBITI_NEI_LOG_COMUNI : PROIBITI_NEI_LOG_JAVA
  return elenco.filter((t) => new RegExp(`(?<![A-Za-z0-9_])${t.replace(/[-]/g, '\\-')}(?![A-Za-z0-9_])`, 'i').test(argomenti))
}

interface ChiamataDiLog {
  riga: number
  chiamata: string
  argomenti: string
}

const LIVELLI_LOGGER_SWIFT = 'debug|info|notice|warning|error|fault|critical|trace|log'

interface FunzioneDiLog {
  nome: string
  /** Il testo dei parametri, fra le parentesi della dichiarazione. */
  parametri: string
}

/**
 * Le funzioni di log del registro nativo iOS, coi loro parametri: la regione «API di log» di `KVRegistroNativo` (qualunque cosa
 * ci sia dichiarata, anche con un parametro `String`: è proprio ciò che si vuole vedere) e, ovunque nel file, tutto ciò che si chiama
 * `registra…`. Le funzioni fuori dalla regione (`impostaDestinazione(_ testo: String)`) non sono di log.
 */
function funzioniDiLogSwift(testoRegistro: string): FunzioneDiLog[] {
  const struttura = ripulisci(testoRegistro, 'swift', 'svuota')
  const da = testoRegistro.indexOf('MARK: - API di log')
  const a = testoRegistro.indexOf('MARK: - Fine API di log')
  const trovate = new Map<string, FunzioneDiLog>()
  const raccogli = (regione: string, scarto: number, firma: RegExp): void => {
    for (const m of regione.matchAll(firma)) {
      const apre = scarto + (m.index ?? 0) + m[0].length - 1
      const chiude = trovaChiusa(struttura, apre, '(', ')')
      if (chiude > apre) trovate.set(m[1], { nome: m[1], parametri: struttura.slice(apre + 1, chiude) })
    }
  }
  if (da >= 0 && a > da) raccogli(struttura.slice(da, a), da, /\bfunc\s+(\w+)\s*\(/g)
  raccogli(struttura, 0, /\bfunc\s+(registra[A-Z]\w*)\s*\(/g)
  return [...trovate.values()].sort((x, y) => x.nome.localeCompare(y.nome))
}

/**
 * I metodi di log di `RegistroNativo` (Java), coi loro parametri: i metodi pubblici non statici della sezione «GLI EVENTI (§8.2)»
 * (fino alla sezione dopo) e, ovunque, `public void|boolean nome(UUID …)`. I metodi fuori dalla sezione (`svuota(String urlRegistro…)`)
 * non sono di log.
 */
function funzioniDiLogJava(testoRegistro: string): FunzioneDiLog[] {
  const struttura = ripulisci(testoRegistro, 'java', 'svuota')
  const da = testoRegistro.indexOf('GLI EVENTI (§8.2)')
  const finale = da >= 0 ? testoRegistro.indexOf('/* ─', da + 20) : -1
  const trovate = new Map<string, FunzioneDiLog>()
  const raccogli = (regione: string, scarto: number, firma: RegExp): void => {
    for (const m of regione.matchAll(firma)) {
      const apre = scarto + (m.index ?? 0) + m[0].length - 1
      const chiude = trovaChiusa(struttura, apre, '(', ')')
      if (chiude > apre) trovate.set(m[1], { nome: m[1], parametri: struttura.slice(apre + 1, chiude) })
    }
  }
  if (da >= 0 && finale > da) raccogli(struttura.slice(da, finale), da, /\bpublic\s+(?!static\b)(?:final\s+|synchronized\s+)*(?:void|boolean)\s+(\w+)\s*\(/g)
  raccogli(struttura, 0, /\bpublic\s+(?:void|boolean)\s+(\w+)\s*\((?=\s*UUID\s+\w+)/g)
  return [...trovate.values()].sort((x, y) => x.nome.localeCompare(y.nome))
}

/** I nomi delle funzioni del registro nativo iOS. */
const nomiRegistroSwift = (testoRegistro: string): string[] => funzioniDiLogSwift(testoRegistro).map((f) => f.nome)

/** I nomi dei metodi di log di `RegistroNativo` (Java). */
const nomiRegistroJava = (testoRegistro: string): string[] => funzioniDiLogJava(testoRegistro).map((f) => f.nome)

/** I tipi che possono portare TESTO LIBERO: un nome di file, un indirizzo, il messaggio di un errore. Un parametro così rompe la promessa «è il tipo a garantire la privacy». */
const TIPI_CON_TESTO_LIBERO_SWIFT = /\b(?:String|NSString|Substring|Character|URL|URLRequest|Data|Error|NSError|Any|AnyObject|Dictionary|Array|Set)\b|\[/
const TIPI_CON_TESTO_LIBERO_JAVA = /\b(?:String|CharSequence|Throwable|Exception|File|Path|Uri|Object|JSONObject|JSONArray|Map|List)\b|\[/

/**
 * Spec §8.1: «le API di `KVRegistroNativo` / `RegistroNativo` accettano solo enumerati e numeri (è il tipo a garantirlo, non la
 * disciplina)». Una funzione di log con un parametro `String`, `URL`, `Error`… sarebbe un varco: dal giorno dopo, qualcuno ci passa
 * un nome di file.
 */
function problemiFirmeDelRegistro(file: string, testoRegistro: string, lingua: 'swift' | 'java'): Problemi {
  const funzioni = lingua === 'swift' ? funzioniDiLogSwift(testoRegistro) : funzioniDiLogJava(testoRegistro)
  const vietati = lingua === 'swift' ? TIPI_CON_TESTO_LIBERO_SWIFT : TIPI_CON_TESTO_LIBERO_JAVA
  const problemi: Problemi = []
  for (const f of funzioni) {
    const tipo = vietati.exec(f.parametri)
    if (tipo) {
      problemi.push(`${file}: la funzione di log \`${f.nome}\` ha un parametro che può portare testo libero (\`${tipo[0]}\`): le API del registro accettano solo enumerati, numeri e UUID, così nel log non può entrare un nome di file, un indirizzo o il testo di un errore`)
    }
  }
  return problemi
}

function chiamateDiLogSwift(testo: string, nomiRegistro: readonly string[]): ChiamataDiLog[] {
  const struttura = ripulisci(testo, 'swift', 'svuota')
  const netto = ripulisci(testo, 'swift', 'tieni')
  const chiamate: ChiamataDiLog[] = []
  const prendi = (posizione: number, nome: string, apre: number): void => {
    const chiude = trovaChiusa(struttura, apre, '(', ')')
    if (chiude < 0) return
    chiamate.push({ riga: numeroDiRiga(testo, posizione), chiamata: nome, argomenti: netto.slice(apre + 1, chiude) })
  }
  const nomiLogger = new Set<string>()
  for (const m of struttura.matchAll(/\b(?:let|var)\s+(\w+)\s*(?::\s*(?:os\.)?Logger\b[^=\n]*)?=\s*(?:os\.)?Logger\s*\(/g)) nomiLogger.add(m[1])
  for (const m of struttura.matchAll(/\b(\w+)\s*:\s*(?:os\.)?Logger\b/g)) nomiLogger.add(m[1])
  const registro = nomiRegistro.length > 0 ? `|${nomiRegistro.join('|')}` : ''
  const generale = new RegExp(`(?<![.\\w])(?:NSLog|os_log|print|debugPrint|dump)\\s*\\(|\\b(?:registra[A-Z]\\w*${registro})\\s*\\(`, 'g')
  for (const m of struttura.matchAll(generale)) {
    // La DICHIARAZIONE di una funzione di log non è una chiamata.
    if (/\bfunc\s+$/.test(struttura.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0))) continue
    prendi(m.index ?? 0, m[0].replace(/\s*\($/, ''), (m.index ?? 0) + m[0].length - 1)
  }
  for (const nome of nomiLogger) {
    for (const m of struttura.matchAll(new RegExp(`\\b${nome}\\s*\\??\\s*\\.\\s*(?:${LIVELLI_LOGGER_SWIFT})\\s*\\(`, 'g'))) {
      prendi(m.index ?? 0, m[0].replace(/\s*\($/, ''), (m.index ?? 0) + m[0].length - 1)
    }
  }
  // `Logger(subsystem:category:)` seguito a capo da `.error(…)`: la forma inline di KVSelettoreMedia.
  for (const m of struttura.matchAll(/\b(?:os\.)?Logger\s*\(/g)) {
    const chiude = trovaChiusa(struttura, (m.index ?? 0) + m[0].length - 1, '(', ')')
    if (chiude < 0) continue
    const dopo = new RegExp(`^\\s*\\.\\s*(?:${LIVELLI_LOGGER_SWIFT})\\s*\\(`).exec(struttura.slice(chiude + 1))
    if (dopo) prendi(m.index ?? 0, 'Logger(…)', chiude + 1 + dopo[0].length - 1)
  }
  return chiamate
}

function chiamateDiLogJava(testo: string, nomiRegistro: readonly string[]): ChiamataDiLog[] {
  const struttura = ripulisci(testo, 'java', 'svuota')
  const netto = ripulisci(testo, 'java', 'tieni')
  const chiamate: ChiamataDiLog[] = []
  const alternative = [
    '\\bLog\\s*\\.\\s*(?:v|d|i|w|e|wtf)\\s*\\(',
    '\\bSystem\\s*\\.\\s*(?:out|err)\\s*\\.\\s*print(?:ln|f)?\\s*\\(',
    '\\.\\s*printStackTrace\\s*\\(',
  ]
  // I metodi del registro si chiamano sempre su un oggetto: `registro.videoFallito(...)`.
  if (nomiRegistro.length > 0) alternative.push(`\\.\\s*(?:${nomiRegistro.join('|')})\\s*\\(`)
  const generale = new RegExp(alternative.join('|'), 'g')
  for (const m of struttura.matchAll(generale)) {
    const apre = (m.index ?? 0) + m[0].length - 1
    const chiude = trovaChiusa(struttura, apre, '(', ')')
    if (chiude < 0) continue
    chiamate.push({ riga: numeroDiRiga(testo, m.index ?? 0), chiamata: m[0].replace(/\s*\($/, '').trim(), argomenti: netto.slice(apre + 1, chiude) })
  }
  return chiamate
}

function problemiDiLog(file: string, testo: string, lingua: 'swift' | 'java', nomiRegistro: readonly string[]): Problemi {
  const chiamate = lingua === 'swift' ? chiamateDiLogSwift(testo, nomiRegistro) : chiamateDiLogJava(testo, nomiRegistro)
  const problemi: Problemi = []
  for (const c of chiamate) {
    for (const vietato of proibitiIn(c.argomenti, lingua)) {
      problemi.push(`${file}: riga ${c.riga}: \`${vietato}\` dentro una chiamata di log (\`${c.chiamata}\`): nei log di un'app di minori non entrano credenziali, indirizzi, nomi di file né il testo di un errore (AGENTS.md regola 8, spec §8.1)`)
    }
  }
  return problemi
}

/** I messaggi del registro iOS (`enum KVMessaggioLog`) e Android (`enum Evento`). */
function messaggiSwift(testo: string): string[] | null {
  const struttura = ripulisci(testo, 'swift', 'svuota')
  const netto = ripulisci(testo, 'swift', 'tieni')
  const e = corpoDopo(struttura, /\benum\s+KVMessaggioLog\b/)
  if (!e) return null
  return [...netto.slice(e.apre + 1, e.chiude).matchAll(/\bcase\s+\w+\s*=\s*"([^"]+)"/g)].map((m) => m[1])
}

function messaggiJava(testo: string): string[] | null {
  const struttura = ripulisci(testo, 'java', 'svuota')
  const netto = ripulisci(testo, 'java', 'tieni')
  const e = corpoDopo(struttura, /\benum\s+Evento\b/)
  if (!e) return null
  return [...netto.slice(e.apre + 1, e.chiude).matchAll(/\b[A-Z][A-Z0-9_]*\s*\(\s*"([^"]+)"\s*,\s*Livello\./g)].map((m) => m[1])
}

function problemiMessaggi(file: string, trovati: readonly string[] | null, enumerato: string, c: ContrattoTs = CONTRATTO_TS): Problemi {
  if (trovati === null) return [`${file}: nessun \`${enumerato}\`: il lock non sa più dove sono i messaggi che il nativo può scrivere`]
  if (trovati.length === 0) return [`${file}: \`${enumerato}\` non ha nessun messaggio letto`]
  return differenza(trovati, c.eventiLog).map(
    (m) => `${file}: il messaggio \`${m}\` (${enumerato}) non è in EVENTI_LOG_NATIVI: il server finto e il lock lo segnalerebbero, e §8.2 non lo elenca`,
  )
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * 8. IL LOGOUT NON TOCCA I CARICAMENTI (regola 11)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

function problemiLogout(file: string, testo: string): Problemi {
  const netto = ripulisci(testo, 'ts', 'tieni')
  const problemi: Problemi = []
  for (const m of netto.matchAll(/caricamenti-nativi(?:-tipi)?|KidvilleCaricamenti|NOME_PLUGIN_CARICAMENTI/g)) {
    problemi.push(`${file}: riga ${numeroDiRiga(netto, m.index ?? 0)}: nomina \`${m[0]}\`: all'uscita dall'account l'invio CONTINUA (decisione del titolare, spec §7.7); chi esce non deve fermare, annullare né dimenticare i caricamenti nativi`)
  }
  return problemi
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * LE REGOLE, SUI FILE VERI
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

describe('caricamenti nativi agganciati — 1 e 2: il plugin è lo stesso nei tre linguaggi', () => {
  it('il contratto TS ha un nome e nove metodi, e la prova non ne fa parte (se questa cade, il lock si autoinganna)', () => {
    expect(NOME_PLUGIN_CARICAMENTI).toBe('KidvilleCaricamenti')
    expect(METODI_PLUGIN_CARICAMENTI).toHaveLength(9)
    expect(problemiContrattoTs(CONTRATTO_TS)).toEqual([])
  })

  it('1 · il nome del plugin è identico: Swift `jsName`, Java `@CapacitorPlugin(name)`, TS `NOME_PLUGIN_CARICAMENTI`', () => {
    const swift = leggiPluginSwift(leggi(FILE.pluginSwift))
    const java = leggiPluginJava(leggi(FILE.pluginJava))
    expect({ swift: swift.nomeJs, java: java.nome }, `nome del plugin: Swift ${FILE.pluginSwift}, Java ${FILE.pluginJava}`).toEqual({
      swift: NOME_PLUGIN_CARICAMENTI,
      java: NOME_PLUGIN_CARICAMENTI,
    })
  })

  it('2 · i metodi di Swift sono quelli del contratto, ognuno con il suo `@objc func`', () => {
    expect(problemiPluginSwift(FILE.pluginSwift, leggi(FILE.pluginSwift))).toEqual([])
  })

  it('2 · i metodi di Java sono quelli del contratto, e `creaElementoDiProva` sta dietro `BuildConfig.DEBUG`', () => {
    expect(problemiPluginJava(FILE.pluginJava, leggi(FILE.pluginJava))).toEqual([])
  })

  it('2 · `creaElementoDiProva` esiste davvero (Swift sotto `#if DEBUG`, Java dietro il guard): è la prova che C1 userà', () => {
    // Senza queste due righe il lock passerebbe anche se la prova sparisse: il confronto «identici» non dice che C1 ne ha bisogno.
    const swift = leggiPluginSwift(leggi(FILE.pluginSwift))
    expect(swift.elencatiSoloDebug, `${FILE.pluginSwift}: \`${METODO_DI_PROVA}\` dentro #if DEBUG`).toContain(METODO_DI_PROVA)
    expect(swift.implementatiSoloDebug, `${FILE.pluginSwift}: \`@objc func ${METODO_DI_PROVA}\` dentro #if DEBUG`).toContain(METODO_DI_PROVA)
    expect(leggiPluginJava(leggi(FILE.pluginJava)).metodi, `${FILE.pluginJava}: \`${METODO_DI_PROVA}\``).toContain(METODO_DI_PROVA)
  })

  it('2 · gli eventi che il plugin manda al JS (`preparazione`, `caricamento`) sono gli stessi in Swift, Java e TS', () => {
    expect(problemiEventi(FILE.pluginSwift, leggiPluginSwift(leggi(FILE.pluginSwift)).eventi)).toEqual([])
    expect(problemiEventi(FILE.pluginJava, leggiPluginJava(leggi(FILE.pluginJava)).eventi)).toEqual([])
  })
})

describe('caricamenti nativi agganciati — 3: la registrazione', () => {
  it('Swift · `capacitorDidLoad` registra il plugin subito, PRIMA di ogni `guard` che può uscire', () => {
    const classe = leggiPluginSwift(leggi(FILE.pluginSwift)).classe
    expect(classe, `${FILE.pluginSwift}: nessuna classe che estende CAPPlugin`).not.toBeNull()
    expect(problemiRegistrazioneSwift(FILE.controllerSwift, leggi(FILE.controllerSwift), classe)).toEqual([])
  })

  it('Java · `MainActivity.onCreate` chiama `registerPlugin` PRIMA di `super.onCreate`', () => {
    const classe = leggiPluginJava(leggi(FILE.pluginJava)).classe
    expect(classe, `${FILE.pluginJava}: nessuna classe che estende Plugin`).not.toBeNull()
    expect(problemiRegistrazioneJava(FILE.mainActivity, leggi(FILE.mainActivity), classe)).toEqual([])
  })
})

describe('caricamenti nativi agganciati — 4: i punti d\'ingresso del sistema', () => {
  it('iOS · l\'AppDelegate avvia il motore, gli passa la sessione in background, lo riprende in primo piano e notifica il fermo', () => {
    expect(problemiAppDelegate(FILE.appDelegate, leggi(FILE.appDelegate), FILE.motoreSwift, leggi(FILE.motoreSwift))).toEqual([])
  })

  it('Android · `MainActivity.onResume` riprende i caricamenti, dentro un `try` che non lascia cadere l\'Activity', () => {
    expect(problemiOnResume(FILE.mainActivity, leggi(FILE.mainActivity))).toEqual([])
  })
})

describe('caricamenti nativi agganciati — 5: la sessione URLSession in background', () => {
  it('ha l\'identificativo di §5.2 e le impostazioni decise dal titolare (qualunque rete, nessun task discrezionale)', () => {
    const sorgenti = swiftDellApp().map((file) => ({ file, testo: leggi(file) }))
    expect(sorgenti.length, 'nessun .swift in ios/App/App: il lock non guarda niente').toBeGreaterThan(5)
    expect(problemiSessione(sorgenti)).toEqual([])
  })
})

describe('caricamenti nativi agganciati — 6: «esiste» non vuol dire «compila»', () => {
  it('ogni file Swift di ios/App/App è nella fase Sources del target App', () => {
    expect(problemiSources(FILE.pbxproj, leggi(FILE.pbxproj), swiftDellApp())).toEqual([])
  })

  it('i file Swift del plugin (§5.1) esistono tutti: se il lock vedesse meno file di quelli attesi, passerebbe su una cartella vuota', () => {
    const attesi = [
      'KVPoliticaCaricamento',
      'KVCodaCaricamenti',
      'KVRegistroNativo',
      'KVSegretiCaricamenti',
      'KVRinnovoFirma',
      'KVMotoreCaricamenti',
      'KVNotificaAttesa',
      'KVSelettoreMedia',
      'KVElaborazioneFoto',
      'KVCaricamentiPlugin',
    ].map((n) => `${IOS_APP}/${n}.swift`)
    expect(differenza(attesi, swiftDellApp())).toEqual([])
    expect(leggiProgettoXcode(leggi(FILE.pbxproj)).inSources.length, 'la fase Sources è vuota').toBeGreaterThanOrEqual(attesi.length)
  })
})

describe('caricamenti nativi agganciati — 7: manifest e permessi', () => {
  it('Android · permessi e servizi di §6.4 presenti, nessun permesso media, ogni componente del pacchetto dichiarato', () => {
    const componenti = componentiAndroid(fileSotto(`${JAVA_APP}/caricamenti`, ['.java']).map((file) => ({ file, testo: leggi(file) })))
    expect(componenti, 'nessun componente Android trovato nel pacchetto: ServizioCaricamentiUidt dovrebbe esserci').toContain('ServizioCaricamentiUidt')
    expect(problemiManifest(FILE.manifest, leggi(FILE.manifest), componenti)).toEqual([])
  })

  it('Android · nessun sorgente Java nomina un permesso media', () => {
    const sorgenti = fileSotto(JAVA_APP, ['.java']).map((file) => ({ file, testo: leggi(file) }))
    expect(sorgenti.length, 'nessun sorgente Java trovato').toBeGreaterThan(10)
    expect(problemiPermessiNeiSorgenti(sorgenti)).toEqual([])
  })

  it('iOS · `Info.plist` non ha `UIBackgroundModes` (una sessione URLSession in background non lo richiede)', () => {
    expect(problemiInfoPlist(FILE.infoPlist, leggi(FILE.infoPlist))).toEqual([])
  })
})

describe('caricamenti nativi agganciati — 8: le versioni', () => {
  it('iOS · MARKETING_VERSION 1.2 e CURRENT_PROJECT_VERSION 6 in tutte le configurazioni; Release non definisce DEBUG', () => {
    expect(problemiVersioniIos(FILE.pbxproj, leggi(FILE.pbxproj))).toEqual([])
  })

  it('Android · versionName 1.2, versionCode 4, la dipendenza di WorkManager (e la sua versione) e `BuildConfig` acceso', () => {
    expect(problemiGradle(FILE.gradle, leggi(FILE.gradle))).toEqual([])
    expect(problemiVariabiliGradle(FILE.variabiliGradle, leggi(FILE.variabiliGradle))).toEqual([])
  })
})

describe('caricamenti nativi agganciati — 9 e 10: i log del nativo', () => {
  const registroSwift = (): string[] => nomiRegistroSwift(leggi(FILE.registroSwift))
  const registroJava = (): string[] => nomiRegistroJava(leggi(FILE.registroJava))

  it('le funzioni di log del registro nativo si trovano (se questa cade, il controllo qui sotto guarderebbe niente)', () => {
    // Misurato il 2026-10-03: tredici funzioni `registra…` in Swift (`video-nativo-pausa` è solo Android), quattordici metodi in Java.
    expect(registroSwift().length, `${FILE.registroSwift}: funzioni del registro iOS`).toBeGreaterThanOrEqual(10)
    expect(registroJava().length, `${FILE.registroJava}: metodi del registro Android`).toBeGreaterThanOrEqual(10)
    const sorgentiSwift = swiftDellApp()
    const chiamate = sorgentiSwift.flatMap((f) => chiamateDiLogSwift(leggi(f), registroSwift()))
    expect(chiamate.length, 'chiamate di log Swift trovate (registro e Logger di sistema)').toBeGreaterThan(20)
    const java = fileSotto(JAVA_APP, ['.java']).flatMap((f) => chiamateDiLogJava(leggi(f), registroJava()))
    expect(java.length, 'chiamate di log Java trovate (registro e Log.*)').toBeGreaterThan(20)
  })

  it('9 · Swift: nessuna credenziale, indirizzo, nome di file o testo d\'errore dentro una chiamata di log', () => {
    const nomi = registroSwift()
    expect(swiftDellApp().flatMap((f) => problemiDiLog(f, leggi(f), 'swift', nomi))).toEqual([])
  })

  it('9 · Java: nessuna credenziale, indirizzo, nome di file o testo d\'errore dentro una chiamata di log', () => {
    const nomi = registroJava()
    const sorgenti = [...fileSotto(JAVA_APP, ['.java'])]
    expect(sorgenti.flatMap((f) => problemiDiLog(f, leggi(f), 'java', nomi))).toEqual([])
  })

  it('9 · le funzioni di log del registro non hanno parametri che possano portare testo libero (solo enumerati, numeri e UUID)', () => {
    expect(problemiFirmeDelRegistro(FILE.registroSwift, leggi(FILE.registroSwift), 'swift')).toEqual([])
    expect(problemiFirmeDelRegistro(FILE.registroJava, leggi(FILE.registroJava), 'java')).toEqual([])
  })

  it('10 · i messaggi che iOS e Android possono scrivere sono un sottoinsieme di EVENTI_LOG_NATIVI', () => {
    expect(EVENTI_LOG_NATIVI.length).toBeGreaterThanOrEqual(15)
    expect(problemiMessaggi(FILE.registroSwift, messaggiSwift(leggi(FILE.registroSwift)), 'KVMessaggioLog')).toEqual([])
    expect(problemiMessaggi(FILE.registroJava, messaggiJava(leggi(FILE.registroJava)), 'RegistroNativo.Evento')).toEqual([])
  })
})

describe('caricamenti nativi agganciati — 11: l\'uscita dall\'account non tocca l\'invio', () => {
  it('`logout.ts` non nomina il modulo dei caricamenti nativi', () => {
    expect(leggi(FILE.logout).length, 'logout.ts è vuoto o non si legge').toBeGreaterThan(500)
    expect(problemiLogout(FILE.logout, leggi(FILE.logout))).toEqual([])
  })
})

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * IL CONTROLLO POSITIVO: UN LOCK CHE NON HA MAI VISTO UN ROSSO NON È UN LOCK
 *
 * Le stesse funzioni di analisi, su due «mondi» completi di sorgenti:
 *  · `mondoOk()` — la cartella `fixtures/caricamenti-nativi-agganciati/ok/`: la forma minima di tutto ciò che il lock pretende,
 *    VERDE per costruzione. Ogni caso rosso parte da lì, cambia UNA cosa e deve diventare rosso nominando QUELLA cosa;
 *  · `mondoVero()` — i file veri dell'app: gli stessi guasti sulla forma che i sorgenti hanno davvero, perché una fixture
 *    generata resta una fixture (misurato qui: una `jsName` mutata sul primo `"KidvilleCaricamenti"` del file coglieva il commento
 *    di testa e lasciava intatto il valore vero).
 * Più i casi che devono restare VERDI: le stesse parole proibite dentro un commento o fuori da una chiamata di log, un permesso
 * media con `tools:node="remove"` (che è la cura, non la malattia).
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

interface Fonte {
  file: string
  testo: string
}

/** Tutto ciò che le regole guardano, in un colpo solo. */
interface Mondo {
  swift: Fonte[]
  java: Fonte[]
  pbxproj: string
  manifest: string
  gradle: string
  variabili: string
  infoPlist: string
  logout: string
  contratto: ContrattoTs
}

const LOGOUT_OK = `import { getSupabase } from '@/lib/supabase/browser-client'
// Il logout non nomina i caricamenti-nativi né KidvilleCaricamenti: l'invio continua. Un commento non è un import.
export async function doLogout(): Promise<void> {
  await getSupabase().auth.signOut()
}
`

function mondoOk(): Mondo {
  const swift = ['AppDelegate', 'KVBridgeViewController', 'KVCaricamentiPlugin', 'KVMotoreCaricamenti', 'KVRegistroNativo'].map((n) => ({
    file: `${n}.swift`,
    testo: leggiFixture(`ok/${n}.swift`),
  }))
  const java = ['KidvilleCaricamentiPlugin', 'MainActivity', 'RegistroNativo'].map((n) => ({ file: `${n}.java`, testo: leggiFixture(`ok/${n}.java`) }))
  return {
    swift,
    java,
    pbxproj: leggiFixture('ok/project.pbxproj'),
    manifest: leggiFixture('ok/AndroidManifest.xml'),
    gradle: leggiFixture('ok/build.gradle'),
    variabili: leggiFixture('ok/variables.gradle'),
    infoPlist: leggiFixture('ok/Info.plist'),
    logout: LOGOUT_OK,
    contratto: CONTRATTO_TS,
  }
}

function mondoVero(): Mondo {
  return {
    swift: swiftDellApp().map((file) => ({ file, testo: leggi(file) })),
    java: fileSotto(JAVA_APP, ['.java']).map((file) => ({ file, testo: leggi(file) })),
    pbxproj: leggi(FILE.pbxproj),
    manifest: leggi(FILE.manifest),
    gradle: leggi(FILE.gradle),
    variabili: leggi(FILE.variabiliGradle),
    infoPlist: leggi(FILE.infoPlist),
    logout: leggi(FILE.logout),
    contratto: CONTRATTO_TS,
  }
}

function trova(fonti: readonly Fonte[], suffisso: string): Fonte {
  const f = fonti.find((x) => x.file.endsWith(suffisso))
  if (!f) throw new Error(`il mondo non ha nessun file ${suffisso}`)
  return f
}

/** Tutte le regole, su un mondo. Una lista vuota = tutto agganciato. */
function tutteLeRegole(m: Mondo): Problemi {
  const pluginSwift = trova(m.swift, 'KVCaricamentiPlugin.swift')
  const controller = trova(m.swift, 'KVBridgeViewController.swift')
  const delegato = trova(m.swift, 'AppDelegate.swift')
  const motore = trova(m.swift, 'KVMotoreCaricamenti.swift')
  const registroSwift = trova(m.swift, 'KVRegistroNativo.swift')
  const pluginJava = trova(m.java, 'KidvilleCaricamentiPlugin.java')
  const main = trova(m.java, 'MainActivity.java')
  const registroJava = trova(m.java, 'RegistroNativo.java')
  const nomiSwift = nomiRegistroSwift(registroSwift.testo)
  const nomiJava = nomiRegistroJava(registroJava.testo)
  return [
    ...problemiContrattoTs(m.contratto),
    ...problemiPluginSwift(pluginSwift.file, pluginSwift.testo, m.contratto),
    ...problemiEventi(pluginSwift.file, leggiPluginSwift(pluginSwift.testo).eventi, m.contratto),
    ...problemiPluginJava(pluginJava.file, pluginJava.testo, m.contratto),
    ...problemiEventi(pluginJava.file, leggiPluginJava(pluginJava.testo).eventi, m.contratto),
    ...problemiRegistrazioneSwift(controller.file, controller.testo, leggiPluginSwift(pluginSwift.testo).classe),
    ...problemiRegistrazioneJava(main.file, main.testo, leggiPluginJava(pluginJava.testo).classe),
    ...problemiAppDelegate(delegato.file, delegato.testo, motore.file, motore.testo),
    ...problemiOnResume(main.file, main.testo),
    ...problemiSessione(m.swift),
    ...problemiSources('project.pbxproj', m.pbxproj, m.swift.map((f) => f.file)),
    ...problemiVersioniIos('project.pbxproj', m.pbxproj),
    ...problemiInfoPlist('Info.plist', m.infoPlist),
    ...problemiManifest('AndroidManifest.xml', m.manifest, componentiAndroid(m.java)),
    ...problemiPermessiNeiSorgenti(m.java),
    ...problemiGradle('build.gradle', m.gradle),
    ...problemiVariabiliGradle('variables.gradle', m.variabili),
    ...m.swift.flatMap((f) => problemiDiLog(f.file, f.testo, 'swift', nomiSwift)),
    ...m.java.flatMap((f) => problemiDiLog(f.file, f.testo, 'java', nomiJava)),
    ...problemiFirmeDelRegistro(registroSwift.file, registroSwift.testo, 'swift'),
    ...problemiFirmeDelRegistro(registroJava.file, registroJava.testo, 'java'),
    ...problemiMessaggi(registroSwift.file, messaggiSwift(registroSwift.testo), 'KVMessaggioLog', m.contratto),
    ...problemiMessaggi(registroJava.file, messaggiJava(registroJava.testo), 'RegistroNativo.Evento', m.contratto),
    ...problemiLogout('logout.ts', m.logout),
  ]
}

/**
 * Sostituisce la PRIMA occorrenza di `da`. Se non c'è, CADE: una mutazione che non cambia niente sarebbe un caso rosso che
 * non è mai stato rosso, cioè esattamente l'autoinganno che questa sezione esiste per evitare. `a` può essere una funzione
 * (nessuna sequenza `$1`/`$&` interpretata per sbaglio).
 */
function muta(testo: string, da: string | RegExp, a: string | ((trovato: string, ...gruppi: string[]) => string)): string {
  const mutato = testo.replace(da, typeof a === 'function' ? (t: string, ...g: string[]) => a(t, ...g) : () => a)
  if (mutato === testo) throw new Error(`ancora assente: la mutazione non cambia niente (${String(da)}): il sorgente ha cambiato forma, aggiorna il caso`)
  return mutato
}

/** Cambia il testo di UN file del mondo; se nessun file corrisponde, cade (un errore di battitura non deve spegnere il caso). */
function nel(fonti: readonly Fonte[], suffisso: string, cambia: (testo: string) => string): Fonte[] {
  trova(fonti, suffisso)
  return fonti.map((f) => (f.file.endsWith(suffisso) ? { ...f, testo: cambia(f.testo) } : f))
}

interface Caso {
  regola: string
  caso: string
  /** Il mondo con UNA cosa cambiata. */
  muta: (m: Mondo) => Mondo
  /** Ciò che il messaggio di errore deve nominare: rosso sì, ma per il motivo giusto. */
  atteso: RegExp
}

const SWIFT_PLUGIN = 'KVCaricamentiPlugin.swift'
const JAVA_PLUGIN = 'KidvilleCaricamentiPlugin.java'

/* ── I casi rossi sul mondo ok: una fixture, una cosa cambiata ───────────────────────────────── */

const CASI_ROSSI_SU_FIXTURE: Caso[] = [
  // 1 · il nome
  { regola: '1 nome', caso: 'Swift: jsName diverso', atteso: /jsName = "KidvilleCaricamentiX"/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(t, 'public let jsName = "KidvilleCaricamenti"', 'public let jsName = "KidvilleCaricamentiX"')) }) },
  { regola: '1 nome', caso: 'Swift: nessun jsName', atteso: /nessun `jsName`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(t, /^[ \t]*public let jsName[^\n]*\n/m, '')) }) },
  { regola: '1 nome', caso: 'Java: @CapacitorPlugin con un altro nome', atteso: /@CapacitorPlugin\(name = "Caricamenti"\)/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, '@CapacitorPlugin(name = "KidvilleCaricamenti")', '@CapacitorPlugin(name = "Caricamenti")')) }) },
  // 2 · i metodi
  { regola: '2 metodi', caso: 'Swift: un plugin con un metodo mancante (fixture rossa su disco)', atteso: /`dimentica`.*manca da `pluginMethods`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, () => leggiFixture('ko/KVCaricamentiPlugin-metodo-mancante.swift')) }) },
  { regola: '2 metodi', caso: 'Swift: un metodo in più, che il contratto TS non conosce', atteso: /`annullaTutto`.*non in METODI_PLUGIN_CARICAMENTI/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(t, /(CAPPluginMethod\(name: "dimentica"[^\n]*\n)/, (x) => `${x}            CAPPluginMethod(name: "annullaTutto", returnType: CAPPluginReturnPromise),\n`)) }) },
  { regola: '2 metodi', caso: 'Swift: un metodo elencato senza il suo @objc func', atteso: /`elenco`.*non ha un `@objc func elenco/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(t, '@objc func elenco(', '@objc func elencoX(')) }) },
  { regola: '2 metodi', caso: 'Swift: creaElementoDiProva elencato FUORI da #if DEBUG', atteso: /creaElementoDiProva` è elencato in `pluginMethods` FUORI da #if DEBUG/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(muta(t, '        #if DEBUG\n        metodi.append(', '        metodi.append('), '))\n        #endif\n', '))\n')) }) },
  { regola: '2 metodi', caso: 'Swift: creaElementoDiProva implementato FUORI da #if DEBUG', atteso: /implementato FUORI da #if DEBUG/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(muta(t, '    #if DEBUG\n    @objc func creaElementoDiProva', '    @objc func creaElementoDiProva'), '{ call.resolve([:]) }\n    #endif\n', '{ call.resolve([:]) }\n')) }) },
  { regola: '2 metodi', caso: 'Swift: la prova solo nel ramo `#else` di #if DEBUG (cioè solo in Release)', atteso: /creaElementoDiProva` è elencato in `pluginMethods` FUORI da #if DEBUG/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(t, '        #if DEBUG\n        metodi.append(', '        #if DEBUG\n        #else\n        metodi.append(')) }) },
  { regola: '2 metodi', caso: 'Swift: un metodo vero (dimentica) nascosto dentro #if DEBUG: nelle build Release non ci sarebbe', atteso: /`dimentica` è elencato SOLO dentro #if DEBUG/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(muta(t, '            CAPPluginMethod(name: "dimentica", returnType: CAPPluginReturnPromise),\n', ''), '        #if DEBUG\n        metodi.append(', '        #if DEBUG\n        metodi.append(CAPPluginMethod(name: "dimentica", returnType: CAPPluginReturnPromise))\n        metodi.append(')) }) },
  { regola: '2 metodi', caso: 'Java: un @PluginMethod in meno', atteso: /`annulla`.*manca da Java/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, '    @PluginMethod\n    public void annulla(PluginCall call) {', '    public void annulla(PluginCall call) {')) }) },
  { regola: '2 metodi', caso: 'Java: un @PluginMethod in più, che il contratto TS non conosce', atteso: /`@PluginMethod svuotaTutto`/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, '    private void inoltra() {', '    @PluginMethod\n    public void svuotaTutto(PluginCall call) {\n        call.resolve();\n    }\n\n    private void inoltra() {')) }) },
  { regola: '2 metodi', caso: 'Java: un Java con creaElementoDiProva fuori da BuildConfig.DEBUG (fixture rossa su disco)', atteso: /creaElementoDiProva` non è protetto da `BuildConfig.DEBUG`/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, () => leggiFixture('ko/KidvilleCaricamentiPlugin-prova-fuori-da-debug.java')) }) },
  { regola: '2 metodi', caso: 'Java: il guard chiede altro che BuildConfig.DEBUG', atteso: /non è protetto da `BuildConfig.DEBUG`/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, 'if (!BuildConfig.DEBUG) {', 'if (BuildConfig.VERSION_CODE < 0) {')) }) },
  { regola: '2 metodi', caso: 'Java: il guard sta DOPO altro codice', atteso: /non è protetto da `BuildConfig.DEBUG`/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, '    public void creaElementoDiProva(PluginCall call) {\n', '    public void creaElementoDiProva(PluginCall call) {\n        inoltra();\n')) }) },
  { regola: '2 metodi', caso: 'Java: il guard non esce (manca il `return`)', atteso: /non è protetto da `BuildConfig.DEBUG`/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, '            return;\n        }\n        call.resolve();', '        }\n        call.resolve();')) }) },
  { regola: '2 metodi', caso: 'Java: il guard nella forma `if (BuildConfig.DEBUG) { … }` che lascia dopo altro codice', atteso: /non è protetto da `BuildConfig.DEBUG`/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, '        if (!BuildConfig.DEBUG) {\n            call.unimplemented("creaElementoDiProva esiste solo nelle build Debug");\n            return;\n        }\n        call.resolve();', '        if (BuildConfig.DEBUG) {\n            call.resolve();\n        }\n        call.resolve();')) }) },
  { regola: '2 metodi', caso: 'TS: METODI_PLUGIN_CARICAMENTI contiene la prova', atteso: /METODI_PLUGIN_CARICAMENTI contiene `creaElementoDiProva`/,
    muta: (m) => ({ ...m, contratto: { ...m.contratto, metodi: [...METODI_PLUGIN_CARICAMENTI, 'creaElementoDiProva'] } }) },
  { regola: '2 metodi', caso: 'TS: METODI_PLUGIN_CARICAMENTI non ha più `dimentica`, che il nativo ha ancora', atteso: /`dimentica`.*non in METODI_PLUGIN_CARICAMENTI|`@PluginMethod dimentica`/,
    muta: (m) => ({ ...m, contratto: { ...m.contratto, metodi: METODI_PLUGIN_CARICAMENTI.filter((x) => x !== 'dimentica') } }) },
  { regola: '2 metodi', caso: 'TS: METODI_PLUGIN_CARICAMENTI ha un metodo in più che il nativo non ha (Swift e Java)', atteso: /`sorpresa`.*manca da `pluginMethods` \(Swift\)[\s\S]*`sorpresa`.*manca da Java/,
    muta: (m) => ({ ...m, contratto: { ...m.contratto, metodi: [...METODI_PLUGIN_CARICAMENTI, 'sorpresa'] } }) },
  { regola: '1 nome', caso: 'TS: NOME_PLUGIN_CARICAMENTI è un altro', atteso: /jsName = "KidvilleCaricamenti" ma il nome del plugin è "Altro"/,
    muta: (m) => ({ ...m, contratto: { ...m.contratto, nome: 'Altro' } }) },
  { regola: '2 eventi', caso: 'TS: EVENTI_PLUGIN_CARICAMENTI ha un evento che nessuno emette', atteso: /evento `fantasma`.*non è mai emesso/,
    muta: (m) => ({ ...m, contratto: { ...m.contratto, eventiPlugin: [...EVENTI_PLUGIN_CARICAMENTI, 'fantasma'] } }) },
  { regola: '2 eventi', caso: 'Swift: l\'evento `caricamento` non è mai emesso', atteso: /evento `caricamento`.*non è mai emesso/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(t, '        notifica("caricamento", [:])\n', '')) }) },
  { regola: '2 eventi', caso: 'Swift: un evento che il TS non conosce', atteso: /emette l'evento `avanzamento`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(t, '        notifica("preparazione", [:])\n', '        notifica("preparazione", [:])\n        notifica("avanzamento", [:])\n')) }) },
  { regola: '2 eventi', caso: 'Java: l\'evento `preparazione` non è mai emesso', atteso: /evento `preparazione`.*non è mai emesso/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, '        notifyListeners(EVENTO_PREPARAZIONE, null);\n', '')) }) },
  // 3 · la registrazione
  { regola: '3 registrazione', caso: 'Swift: capacitorDidLoad non registra niente', atteso: /non registra nessun plugin/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVBridgeViewController.swift', (t) => muta(t, /^[ \t]*bridge\?\.registerPluginInstance\([^\n]*\n/m, '')) }) },
  { regola: '3 registrazione', caso: 'Swift: la registrazione sta DOPO un guard', atteso: /DOPO un `guard` di `capacitorDidLoad`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVBridgeViewController.swift', (t) => muta(t, '        bridge?.registerPluginInstance(KVCaricamentiPlugin())\n', '        guard bridge != nil else { return }\n        bridge?.registerPluginInstance(KVCaricamentiPlugin())\n')) }) },
  { regola: '3 registrazione', caso: 'Swift: la registrazione sta dentro un if', atteso: /dentro un blocco/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVBridgeViewController.swift', (t) => muta(t, '        bridge?.registerPluginInstance(KVCaricamentiPlugin())\n', '        if bridge != nil {\n            bridge?.registerPluginInstance(KVCaricamentiPlugin())\n        }\n')) }) },
  { regola: '3 registrazione', caso: 'Swift: registra un\'altra classe', atteso: /registra `KVAltroPlugin`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVBridgeViewController.swift', (t) => muta(t, 'registerPluginInstance(KVCaricamentiPlugin())', 'registerPluginInstance(KVAltroPlugin())')) }) },
  { regola: '3 registrazione', caso: 'Swift: manca capacitorDidLoad', atteso: /nessun `override func capacitorDidLoad\(\)`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVBridgeViewController.swift', (t) => muta(t, 'override func capacitorDidLoad()', 'func capacitorDidLoadAltrove()')) }) },
  { regola: '3 registrazione', caso: 'Java: registerPlugin DOPO super.onCreate', atteso: /`registerPlugin` sta DOPO `super.onCreate/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '        registerPlugin(KidvilleCaricamentiPlugin.class);\n        super.onCreate(savedInstanceState);\n', '        super.onCreate(savedInstanceState);\n        registerPlugin(KidvilleCaricamentiPlugin.class);\n')) }) },
  { regola: '3 registrazione', caso: 'Java: onCreate non registra niente', atteso: /non chiama `registerPlugin/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '        registerPlugin(KidvilleCaricamentiPlugin.class);\n', '')) }) },
  { regola: '3 registrazione', caso: 'Java: registerPlugin dentro un if', atteso: /non è un'istruzione diretta e incondizionata/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '        registerPlugin(KidvilleCaricamentiPlugin.class);\n', '        if (savedInstanceState == null) {\n            registerPlugin(KidvilleCaricamentiPlugin.class);\n        }\n')) }) },
  { regola: '3 registrazione', caso: 'Java: registerPlugin dentro un if SENZA graffe (stessa profondità, ma non un\'istruzione intera)', atteso: /non è un'istruzione diretta e incondizionata/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '        registerPlugin(KidvilleCaricamentiPlugin.class);\n', '        if (savedInstanceState == null) registerPlugin(KidvilleCaricamentiPlugin.class);\n')) }) },
  // 4 · i punti d'ingresso
  { regola: '4 ingressi', caso: 'AppDelegate senza handleEventsForBackgroundURLSession', atteso: /manca `application\(_:handleEventsForBackgroundURLSession/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, /    func application\(_ application: UIApplication, handleEventsForBackgroundURLSession[\s\S]*?\n    \}\n/, '')) }) },
  { regola: '4 ingressi', caso: 'AppDelegate: avvia() non chiamato', atteso: /non chiama `KVMotoreCaricamenti.condiviso.avvia\(\)`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, '        KVMotoreCaricamenti.condiviso.avvia()\n', '')) }) },
  { regola: '4 ingressi', caso: 'AppDelegate: avvia() dentro un if', atteso: /chiama `avvia\(\)` dentro un blocco/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, '        KVMotoreCaricamenti.condiviso.avvia()\n', '        if launchOptions == nil {\n            KVMotoreCaricamenti.condiviso.avvia()\n        }\n')) }) },
  { regola: '4 ingressi', caso: 'AppDelegate: avvia() dentro #if canImport(...)', atteso: /chiama `avvia\(\)` dentro un blocco/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, '        KVMotoreCaricamenti.condiviso.avvia()\n', '        #if canImport(FirebaseCore)\n        KVMotoreCaricamenti.condiviso.avvia()\n        #endif\n')) }) },
  { regola: '4 ingressi', caso: 'AppDelegate: riprendiInPrimoPiano() non chiamato', atteso: /`applicationDidBecomeActive` non chiama.*riprendiInPrimoPiano/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, '        KVMotoreCaricamenti.condiviso.riprendiInPrimoPiano()\n', '')) }) },
  { regola: '4 ingressi', caso: 'AppDelegate: notificaSeFermo() non chiamato', atteso: /`applicationDidEnterBackground` non chiama.*notificaSeFermo/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, '        KVMotoreCaricamenti.condiviso.notificaSeFermo()\n', '')) }) },
  { regola: '4 ingressi', caso: 'AppDelegate: ricollega non riceve il completamento', atteso: /non riceve `identifier` e `completionHandler`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, 'ricollega(identifier, completionHandler)', 'ricollega(identifier, {})')) }) },
  { regola: '4 ingressi', caso: 'AppDelegate: handleEvents non chiama ricollega', atteso: /`handleEventsForBackgroundURLSession` non chiama/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, '        KVMotoreCaricamenti.condiviso.ricollega(identifier, completionHandler)\n', '        completionHandler()\n')) }) },
  { regola: '4 ingressi', caso: 'il motore non dichiara più ricollega', atteso: /non dichiara `func ricollega/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'func ricollega(', 'func ricollegaAltro(')) }) },
  { regola: '4 ingressi', caso: 'il motore non ha più `static let condiviso`', atteso: /non dichiara `static let condiviso`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'static let condiviso = KVMotoreCaricamenti()\n', '')) }) },
  { regola: '4 ingressi', caso: 'MainActivity: nessun onResume', atteso: /nessun `onResume\(\)`/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, 'public void onResume()', 'public void onResumeAltrove()')) }) },
  { regola: '4 ingressi', caso: 'MainActivity: onResume non riprende i caricamenti', atteso: /non chiama `PianificatoreCaricamenti.riprendiInPrimoPiano/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '            PianificatoreCaricamenti.riprendiInPrimoPiano(this);\n', '            Log.i(TAG_CARICAMENTI, "ok");\n')) }) },
  { regola: '4 ingressi', caso: 'MainActivity: riprendiInPrimoPiano senza try/catch', atteso: /non sta in un `try \{ … \} catch \(Throwable/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, /        try \{\n(\s*PianificatoreCaricamenti\.riprendiInPrimoPiano\(this\);\n)\s*\} catch \(Throwable guasto\) \{[^}]*\}\n/, (_t, dentro) => dentro)) }) },
  { regola: '4 ingressi', caso: 'MainActivity: il catch prende solo Exception', atteso: /non sta in un `try \{ … \} catch \(Throwable/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, 'catch (Throwable guasto)', 'catch (Exception guasto)')) }) },
  { regola: '4 ingressi', caso: 'MainActivity: onResume non chiama super.onResume()', atteso: /`onResume` non chiama `super.onResume\(\)`/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '        super.onResume();\n', '')) }) },
  { regola: '4 ingressi', caso: 'MainActivity: riprendiInPrimoPiano PRIMA di super.onResume()', atteso: /sta PRIMA di `super.onResume\(\)`/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(muta(t, '        super.onResume();\n', ''), /(        \} catch \(Throwable guasto\) \{\n[^\n]*\n        \}\n)/, (_x, blocco) => `${blocco}        super.onResume();\n`)) }) },
  // 5 · la sessione
  { regola: '5 sessione', caso: 'isDiscretionary = true', atteso: /`isDiscretionary = true`, deve essere `false`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'isDiscretionary = false', 'isDiscretionary = true')) }) },
  { regola: '5 sessione', caso: 'sessionSendsLaunchEvents tolto', atteso: /non imposta `sessionSendsLaunchEvents = true`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, '        configurazione.sessionSendsLaunchEvents = true\n', '')) }) },
  { regola: '5 sessione', caso: 'sessionSendsLaunchEvents = false', atteso: /`sessionSendsLaunchEvents = false`, deve essere `true`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'sessionSendsLaunchEvents = true', 'sessionSendsLaunchEvents = false')) }) },
  { regola: '5 sessione', caso: 'la rete cellulare non è ammessa', atteso: /`allowsCellularAccess = false`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'allowsCellularAccess = true', 'allowsCellularAccess = false')) }) },
  { regola: '5 sessione', caso: 'la rete costosa non è ammessa', atteso: /`allowsExpensiveNetworkAccess = false`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'allowsExpensiveNetworkAccess = true', 'allowsExpensiveNetworkAccess = false')) }) },
  { regola: '5 sessione', caso: 'la rete limitata non è ammessa', atteso: /`allowsConstrainedNetworkAccess = false`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'allowsConstrainedNetworkAccess = true', 'allowsConstrainedNetworkAccess = false')) }) },
  { regola: '5 sessione', caso: 'la rete limitata non è impostata (il predefinito non basta: lo dice la spec)', atteso: /non imposta `allowsConstrainedNetworkAccess = true`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, '        configurazione.allowsConstrainedNetworkAccess = true\n', '')) }) },
  { regola: '5 sessione', caso: 'la sessione manda i cookie', atteso: /`httpShouldSetCookies = true`, deve essere `false`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'httpShouldSetCookies = false', 'httpShouldSetCookies = true')) }) },
  { regola: '5 sessione', caso: 'identificativo diverso (la costante)', atteso: /"it.kidville.app.altro", deve essere "it.kidville.app.caricamenti"/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'static let identificativoSessione = "it.kidville.app.caricamenti"', 'static let identificativoSessione = "it.kidville.app.altro"')) }) },
  { regola: '5 sessione', caso: 'identificativo diverso (un letterale nella chiamata)', atteso: /"it.kidville.app.altro"/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'background(withIdentifier: identificativo)', 'background(withIdentifier: "it.kidville.app.altro")')) }) },
  { regola: '5 sessione', caso: 'una sessione di default al posto di quella in background', atteso: /nessuna `URLSessionConfiguration.background/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'URLSessionConfiguration.background(withIdentifier: identificativo)', 'URLSessionConfiguration.default')) }) },
  { regola: '5 sessione', caso: 'due configurazioni in background', atteso: /2 configurazioni `background\(withIdentifier:\)`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVRegistroNativo.swift', (t) => `${t}\nfunc altra() -> URLSessionConfiguration {\n    let c = URLSessionConfiguration.background(withIdentifier: "it.kidville.app.caricamenti")\n    return c\n}\n`) }) },
  // 6 · «sta sul disco» non vuol dire «compila»
  { regola: '6 sources', caso: 'il plugin non è nella fase Sources', atteso: /`KVCaricamentiPlugin.swift` sta sul disco.*NON nella fase Sources/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, /^[ \t]*F00000000000000000000003 \/\* KVCaricamentiPlugin\.swift in Sources \*\/,\n/m, '') }) },
  { regola: '6 sources', caso: 'un file Swift nuovo sul disco che nessuno ha aggiunto al progetto', atteso: /`KVNuovo.swift` sta sul disco.*NON nella fase Sources/,
    muta: (m) => ({ ...m, swift: [...m.swift, { file: 'KVNuovo.swift', testo: 'import Foundation\nfinal class KVNuovo {}\n' }] }) },
  { regola: '6 sources', caso: 'Sources nomina un file che non esiste più', atteso: /nomina `KVFantasma.swift` ma il file non sta in ios\/App\/App/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, 'path = KVRegistroNativo.swift;', 'path = KVFantasma.swift;') }) },
  { regola: '6 sources', caso: 'un componente Android nuovo che il manifest non dichiara', atteso: /`ServizioAltro` è un componente Android del pacchetto dei caricamenti ma non è dichiarata/,
    muta: (m) => ({ ...m, java: [...m.java, { file: 'ServizioAltro.java', testo: 'package it.kidville.app.caricamenti;\npublic final class ServizioAltro extends JobService {}\n' }] }) },
  // 7 · permessi, servizi, background modes
  { regola: '7 manifest', caso: 'un manifest con READ_MEDIA_VIDEO (fixture rossa su disco)', atteso: /dichiara android.permission.READ_MEDIA_VIDEO/,
    muta: (m) => ({ ...m, manifest: leggiFixture('ko/AndroidManifest-read-media-video.xml') }) },
  { regola: '7 manifest', caso: 'READ_MEDIA_IMAGES', atteso: /dichiara android.permission.READ_MEDIA_IMAGES/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '</manifest>', '<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />\n</manifest>') }) },
  { regola: '7 manifest', caso: 'READ_MEDIA_VISUAL_USER_SELECTED', atteso: /READ_MEDIA_VISUAL_USER_SELECTED/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '</manifest>', '<uses-permission android:name="android.permission.READ_MEDIA_VISUAL_USER_SELECTED" />\n</manifest>') }) },
  { regola: '7 manifest', caso: 'READ_EXTERNAL_STORAGE', atteso: /dichiara android.permission.READ_EXTERNAL_STORAGE/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '</manifest>', '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />\n</manifest>') }) },
  { regola: '7 manifest', caso: 'WRITE_EXTERNAL_STORAGE, anche con maxSdkVersion', atteso: /dichiara android.permission.WRITE_EXTERNAL_STORAGE/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '</manifest>', '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />\n</manifest>') }) },
  { regola: '7 manifest', caso: 'ACCESS_MEDIA_LOCATION', atteso: /ACCESS_MEDIA_LOCATION/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '</manifest>', '<uses-permission android:name="android.permission.ACCESS_MEDIA_LOCATION" />\n</manifest>') }) },
  { regola: '7 manifest', caso: 'manca FOREGROUND_SERVICE_DATA_SYNC', atteso: /manca `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, /^[ \t]*<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" \/>\n/m, '') }) },
  { regola: '7 manifest', caso: 'manca RUN_USER_INITIATED_JOBS', atteso: /manca `<uses-permission android:name="android.permission.RUN_USER_INITIATED_JOBS"/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, /^[ \t]*<uses-permission android:name="android.permission.RUN_USER_INITIATED_JOBS" \/>\n/m, '') }) },
  { regola: '7 manifest', caso: 'manca FOREGROUND_SERVICE', atteso: /manca `<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, /^[ \t]*<uses-permission android:name="android.permission.FOREGROUND_SERVICE" \/>\n/m, '') }) },
  { regola: '7 manifest', caso: 'manca il servizio UIDT', atteso: /manca il `<service android:name="\.caricamenti\.ServizioCaricamentiUidt"/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, /<service\s+android:name="\.caricamenti\.ServizioCaricamentiUidt"[^>]*\/>/, '') }) },
  { regola: '7 manifest', caso: 'il servizio UIDT senza BIND_JOB_SERVICE', atteso: /senza `android:permission="android.permission.BIND_JOB_SERVICE"`/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '            android:permission="android.permission.BIND_JOB_SERVICE"\n', '') }) },
  { regola: '7 manifest', caso: 'il servizio UIDT esportato', atteso: /non è `android:exported="false"`/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, 'android:permission="android.permission.BIND_JOB_SERVICE"\n            android:exported="false"', 'android:permission="android.permission.BIND_JOB_SERVICE"\n            android:exported="true"') }) },
  { regola: '7 manifest', caso: 'SystemForegroundService senza il tipo dataSync', atteso: /non dichiara `android:foregroundServiceType="dataSync"`/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, 'android:foregroundServiceType="dataSync"', 'android:foregroundServiceType="location"') }) },
  { regola: '7 manifest', caso: 'SystemForegroundService senza tools:node="merge"', atteso: /non ha `tools:node="merge"`/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '            android:foregroundServiceType="dataSync"\n            tools:node="merge" />', '            android:foregroundServiceType="dataSync" />') }) },
  { regola: '7 manifest', caso: 'manca il servizio di WorkManager', atteso: /manca il `<service android:name="androidx.work.impl.foreground.SystemForegroundService"/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, /<service\s+android:name="androidx\.work\.impl\.foreground\.SystemForegroundService"[^>]*\/>/, '') }) },
  { regola: '7 manifest', caso: 'la radice non dichiara xmlns:tools', atteso: /non dichiara `xmlns:tools`/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '\n    xmlns:tools="http://schemas.android.com/tools"', '') }) },
  { regola: '7 manifest', caso: 'un sorgente Java che nomina READ_MEDIA_IMAGES', atteso: /nomina READ_MEDIA_IMAGES/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '    @Override\n    protected void onCreate', '    static final String PERMESSO = android.Manifest.permission.READ_MEDIA_IMAGES;\n\n    @Override\n    protected void onCreate')) }) },
  { regola: '7 manifest', caso: 'Info.plist con UIBackgroundModes', atteso: /contiene `UIBackgroundModes`/,
    muta: (m) => ({ ...m, infoPlist: muta(m.infoPlist, '\t<key>ITSAppUsesNonExemptEncryption</key>', '\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>fetch</string>\n\t</array>\n\t<key>ITSAppUsesNonExemptEncryption</key>') }) },
  // 8 · le versioni
  { regola: '8 versioni', caso: 'iOS: MARKETING_VERSION 1.1 nella Debug', atteso: /configurazione Debug: MARKETING_VERSION = 1.1, deve essere 1.2/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, 'MARKETING_VERSION = 1.2;', 'MARKETING_VERSION = 1.1;') }) },
  { regola: '8 versioni', caso: 'iOS: CURRENT_PROJECT_VERSION 5 nella Release', atteso: /configurazione Release: CURRENT_PROJECT_VERSION = 5, deve essere 6/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, /(F00000000000000000000312 \/\* Release \*\/ = \{[\s\S]*?CURRENT_PROJECT_VERSION = )6;/, (_t, prima) => `${prima}5;`) }) },
  { regola: '8 versioni', caso: 'iOS: una configurazione senza versione', atteso: /configurazione Release: MARKETING_VERSION = \(assente\)/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, /(F00000000000000000000312 \/\* Release \*\/ = \{[\s\S]*?)\t\t\t\tMARKETING_VERSION = 1\.2;\n/, (_t, prima) => prima) }) },
  { regola: '8 versioni', caso: 'iOS: Release definisce DEBUG', atteso: /la configurazione Release definisce DEBUG/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = "";', 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;') }) },
  { regola: '8 versioni', caso: 'iOS: Release con -DDEBUG fra i flag', atteso: /la configurazione Release definisce DEBUG/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, /(F00000000000000000000312 \/\* Release \*\/ = \{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = \{\n)/, (_t, testa) => `${testa}\t\t\t\tOTHER_SWIFT_FLAGS = "$(inherited) \\"-DDEBUG\\"";\n`) }) },
  { regola: '8 versioni', caso: 'iOS: una sola configurazione', atteso: /ha 1 configurazioni, ne servono almeno due/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, '\t\t\t\tF00000000000000000000312 /* Release */,\n', '') }) },
  { regola: '8 versioni', caso: 'iOS: una configurazione FUORI dal target App con la 1.1 (un altro target, o il progetto)', atteso: /in una configurazione o un target che non è l'app: MARKETING_VERSION = 1.1/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, '/* End XCBuildConfiguration section */', '\t\tF00000000000000000000313 /* Debug */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n\t\t\t\tMARKETING_VERSION = 1.1;\n\t\t\t};\n\t\t\tname = Debug;\n\t\t};\n/* End XCBuildConfiguration section */') }) },
  { regola: '8 versioni', caso: 'Android: versionCode 3', atteso: /versionCode 3, deve essere 4/,
    muta: (m) => ({ ...m, gradle: muta(m.gradle, /^( {8})versionCode 4$/m, (_t, rientro) => `${rientro}versionCode 3`) }) },
  { regola: '8 versioni', caso: 'Android: versionName 1.1', atteso: /versionName "1.1", deve essere "1.2"/,
    muta: (m) => ({ ...m, gradle: muta(m.gradle, 'versionName "1.2"', 'versionName "1.1"') }) },
  { regola: '8 versioni', caso: 'Android: manca la dipendenza di WorkManager', atteso: /manca `implementation "androidx.work:work-runtime/,
    muta: (m) => ({ ...m, gradle: muta(m.gradle, '    implementation "androidx.work:work-runtime:$androidxWorkVersion"\n', '') }) },
  { regola: '8 versioni', caso: 'Android: variables.gradle non definisce androidxWorkVersion', atteso: /manca `androidxWorkVersion = /,
    muta: (m) => ({ ...m, variabili: muta(m.variabili, /^\s*androidxWorkVersion = [^\n]*\n/m, '') }) },
  { regola: '8 versioni', caso: 'Android: BuildConfig spento', atteso: /manca `buildFeatures \{ buildConfig true \}`/,
    muta: (m) => ({ ...m, gradle: muta(m.gradle, '        buildConfig true\n', '') }) },
  { regola: '8 versioni', caso: 'Android: il buildType release è debuggable', atteso: /il buildType release ha `debuggable true`/,
    muta: (m) => ({ ...m, gradle: muta(m.gradle, '            minifyEnabled false\n', '            minifyEnabled false\n            debuggable true\n') }) },
  // 9 · i log
  { regola: '9 log', caso: 'una chiamata di log con absoluteString (fixture rossa su disco: registro, Logger, Logger inline, print)', atteso: /riga 13: `absoluteString` dentro una chiamata di log/,
    muta: (m) => ({ ...m, swift: [...m.swift, { file: 'KVRegistro-log-con-absoluteString.swift', testo: leggiFixture('ko/KVRegistro-log-con-absoluteString.swift') }] }) },
  { regola: '9 log', caso: 'Swift: Logger di sistema con un\'interpolazione di localizedDescription', atteso: /`localizedDescription` dentro una chiamata di log \(`diagnostica.error`\)/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'diagnostica.error("transizione non applicata: codice', 'diagnostica.error("\\(errore.localizedDescription) transizione non applicata: codice')) }) },
  { regola: '9 log', caso: 'Swift: NSLog', atteso: /`suggestedName` dentro una chiamata di log \(`NSLog`\)/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => `${t}\nfunc sbaglia(_ p: NSItemProvider) { NSLog("%@", p.suggestedName ?? "") }\n`) }) },
  { regola: '9 log', caso: 'Swift: il registro nativo con un nome di file', atteso: /`lastPathComponent` dentro una chiamata di log \(`registraAccodato`\)/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'registro.registraAccodato(job: job, utente: utente, byte: byte)', 'registro.registraAccodato(job: job, utente: utente, byte: byte, nome: url.lastPathComponent)')) }) },
  { regola: '9 log', caso: 'Swift: un log di una funzione di log DICHIARATA nella regione API del registro, chiamata con un\'intestazione', atteso: /`x-upsert` dentro una chiamata di log \(`registraFallito`\)/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, 'registro.registraAccodato(job: job, utente: utente, byte: byte)', 'registro.registraFallito(job: job, utente: utente, tentativi: 1, intestazione: "x-upsert")')) }) },
  { regola: '9 log', caso: 'Java: Log.e con getMessage()', atteso: /`getMessage` dentro una chiamata di log \(`Log.e`\)/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '"ripresa dei caricamenti non riuscita (" + guasto.getClass().getSimpleName() + ")"', '"ripresa non riuscita (" + guasto.getMessage() + ")"')) }) },
  { regola: '9 log', caso: 'Java: Log.w con getLastPathSegment()', atteso: /`getLastPathSegment` dentro una chiamata di log \(`Log.w`\)/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '    @Override\n    public void onResume() {\n', '    void ahi(android.net.Uri uri) {\n        Log.w(TAG_CARICAMENTI, "scelto " + uri.getLastPathSegment());\n    }\n\n    @Override\n    public void onResume() {\n')) }) },
  { regola: '9 log', caso: 'Java: il registro nativo con "Authorization"', atteso: /`authorization` dentro una chiamata di log \(`.videoFallito`\)/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '    @Override\n    public void onResume() {\n', '    void ahi(RegistroNativo registro, java.util.UUID job) {\n        registro.videoFallito(job, job, "Authorization");\n    }\n\n    @Override\n    public void onResume() {\n')) }) },
  { regola: '9 log', caso: 'Java: System.out.println con x-upsert', atteso: /`x-upsert` dentro una chiamata di log \(`System.out.println`\)/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '    @Override\n    public void onResume() {\n', '    void ahi() {\n        System.out.println("x-upsert: true");\n    }\n\n    @Override\n    public void onResume() {\n')) }) },
  { regola: '9 log', caso: 'Swift: una funzione di log del registro con un parametro String', atteso: /la funzione di log `registraNome` ha un parametro che può portare testo libero \(`String`\)/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVRegistroNativo.swift', (t) => muta(t, '    func registraCodaCorrotta(fileOrfani: Int) {}\n', '    func registraCodaCorrotta(fileOrfani: Int) {}\n    func registraNome(job: UUID, nome: String) {}\n')) }) },
  { regola: '9 log', caso: 'Swift: una funzione di log del registro con un URL (e SENZA il prefisso `registra`, ma dentro la regione API)', atteso: /la funzione di log `annotaIndirizzo` ha un parametro che può portare testo libero \(`URL`\)/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVRegistroNativo.swift', (t) => muta(t, '    func registraCodaCorrotta(fileOrfani: Int) {}\n', '    func registraCodaCorrotta(fileOrfani: Int) {}\n    func annotaIndirizzo(job: UUID, url: URL) {}\n')) }) },
  { regola: '9 log', caso: 'Swift: una funzione di log con un Error', atteso: /`registraGuasto` ha un parametro che può portare testo libero \(`Error`\)/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVRegistroNativo.swift', (t) => muta(t, '    func registraCodaCorrotta(fileOrfani: Int) {}\n', '    func registraCodaCorrotta(fileOrfani: Int) {}\n    func registraGuasto(job: UUID, errore: Error) {}\n')) }) },
  { regola: '9 log', caso: 'Java: un metodo di log del registro con un parametro String (non primo)', atteso: /la funzione di log `videoNome` ha un parametro che può portare testo libero \(`String`\)/,
    muta: (m) => ({ ...m, java: nel(m.java, 'RegistroNativo.java', (t) => muta(t, '    public void codaCorrotta(UUID utente, int fileOrfani) {\n    }\n', '    public void codaCorrotta(UUID utente, int fileOrfani) {\n    }\n\n    public void videoNome(UUID job, String nome) {\n    }\n')) }) },
  { regola: '9 log', caso: 'Java: un metodo di log con una String come PRIMO parametro (lo trova la sezione, non il primo UUID)', atteso: /la funzione di log `videoDettaglio` ha un parametro che può portare testo libero \(`String`\)/,
    muta: (m) => ({ ...m, java: nel(m.java, 'RegistroNativo.java', (t) => muta(t, '    public void codaCorrotta(UUID utente, int fileOrfani) {\n    }\n', '    public void codaCorrotta(UUID utente, int fileOrfani) {\n    }\n\n    public void videoDettaglio(String dettaglio) {\n    }\n')) }) },
  { regola: '9 log', caso: 'Java: un metodo di log con un Throwable', atteso: /`videoGuasto` ha un parametro che può portare testo libero \(`Throwable`\)/,
    muta: (m) => ({ ...m, java: nel(m.java, 'RegistroNativo.java', (t) => muta(t, '    public void codaCorrotta(UUID utente, int fileOrfani) {\n    }\n', '    public void codaCorrotta(UUID utente, int fileOrfani) {\n    }\n\n    public void videoGuasto(UUID job, Throwable errore) {\n    }\n')) }) },
  // 10 · i messaggi
  { regola: '10 messaggi', caso: 'Swift: un messaggio che EVENTI_LOG_NATIVI non conosce', atteso: /`video-nativo-nuovo` \(KVMessaggioLog\) non è in EVENTI_LOG_NATIVI/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVRegistroNativo.swift', (t) => muta(t, '    case putOltreScadenza = "put-oltre-scadenza"\n', '    case putOltreScadenza = "put-oltre-scadenza"\n    case nuovo = "video-nativo-nuovo"\n')) }) },
  { regola: '10 messaggi', caso: 'Java: un messaggio che EVENTI_LOG_NATIVI non conosce', atteso: /`video-nativo-nuovo` \(RegistroNativo.Evento\) non è in EVENTI_LOG_NATIVI/,
    muta: (m) => ({ ...m, java: nel(m.java, 'RegistroNativo.java', (t) => muta(t, 'PUT_OLTRE_SCADENZA("put-oltre-scadenza", Livello.WARN);', 'PUT_OLTRE_SCADENZA("put-oltre-scadenza", Livello.WARN),\n        NUOVO("video-nativo-nuovo", Livello.WARN);')) }) },
  { regola: '10 messaggi', caso: 'TS: EVENTI_LOG_NATIVI non ha più `put-oltre-scadenza`, che il nativo scrive ancora', atteso: /`put-oltre-scadenza` \(KVMessaggioLog\) non è in EVENTI_LOG_NATIVI/,
    muta: (m) => ({ ...m, contratto: { ...m.contratto, eventiLog: EVENTI_LOG_NATIVI.filter((x) => x !== 'put-oltre-scadenza') } }) },
  { regola: '10 messaggi', caso: 'Swift: l\'enum dei messaggi non si trova più', atteso: /nessun `KVMessaggioLog`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVRegistroNativo.swift', (t) => muta(t, 'enum KVMessaggioLog', 'enum KVMessaggiAltri')) }) },
  { regola: '10 messaggi', caso: 'Swift: l\'enum dei messaggi è vuoto (un lock che passa su una lista vuota non guarda niente)', atteso: /`KVMessaggioLog` non ha nessun messaggio letto/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVRegistroNativo.swift', (t) => muta(t, /^    case \w+ = "[^"]+"\n/gm, '')) }) },
  { regola: '10 messaggi', caso: 'Java: l\'enum dei messaggi non si trova più', atteso: /nessun `RegistroNativo.Evento`/,
    muta: (m) => ({ ...m, java: nel(m.java, 'RegistroNativo.java', (t) => muta(t, 'public enum Evento', 'public enum Eventi')) }) },
  // 11 · il logout
  { regola: '11 logout', caso: 'import statico del modulo', atteso: /nomina `caricamenti-nativi`/,
    muta: (m) => ({ ...m, logout: `import { annullaTutto } from '@/lib/native/caricamenti-nativi'\n${m.logout}` }) },
  { regola: '11 logout', caso: 'import del modulo dei tipi', atteso: /nomina `caricamenti-nativi-tipi`/,
    muta: (m) => ({ ...m, logout: `import type { CaricamentoNativo } from '@/lib/native/caricamenti-nativi-tipi'\n${m.logout}` }) },
  { regola: '11 logout', caso: 'import dinamico', atteso: /nomina `caricamenti-nativi`/,
    muta: (m) => ({ ...m, logout: `${m.logout}\nexport const ferma = async () => (await import('@/lib/native/caricamenti-nativi')).annulla()\n` }) },
  { regola: '11 logout', caso: 'import relativo', atteso: /nomina `caricamenti-nativi`/,
    muta: (m) => ({ ...m, logout: `import { elenco } from '../native/caricamenti-nativi'\n${m.logout}` }) },
  { regola: '11 logout', caso: 'il nome del plugin fra virgolette', atteso: /nomina `KidvilleCaricamenti`/,
    muta: (m) => ({ ...m, logout: `${m.logout}\nexport const plugin = registerPlugin('KidvilleCaricamenti')\n` }) },
  { regola: '11 logout', caso: 'la costante col nome del plugin', atteso: /nomina `NOME_PLUGIN_CARICAMENTI`/,
    muta: (m) => ({ ...m, logout: `${m.logout}\nexport const plugin = NOME_PLUGIN_CARICAMENTI\n` }) },
]

/* ── I casi rossi sui file VERI: la stessa regola, sulla forma che i sorgenti hanno davvero ─────── */

const CASI_ROSSI_SUI_FILE_VERI: Caso[] = [
  { regola: '1 nome', caso: 'Swift: jsName diverso', atteso: /jsName = "KidvilleCaricamentiX"/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(t, 'public let jsName = "KidvilleCaricamenti"', 'public let jsName = "KidvilleCaricamentiX"')) }) },
  { regola: '1 nome', caso: 'Java: @CapacitorPlugin con un altro nome', atteso: /@CapacitorPlugin\(name = "Caricamenti"\)/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, '@CapacitorPlugin(name = "KidvilleCaricamenti")', '@CapacitorPlugin(name = "Caricamenti")')) }) },
  { regola: '2 metodi', caso: 'Swift: manca dimentica da pluginMethods', atteso: /`dimentica`.*manca da `pluginMethods`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(t, /^[ \t]*CAPPluginMethod\(name: "dimentica"[^\n]*\n/m, '')) }) },
  { regola: '2 metodi', caso: 'Swift: creaElementoDiProva senza #if DEBUG', atteso: /FUORI da #if DEBUG/,
    muta: (m) => ({ ...m, swift: nel(m.swift, SWIFT_PLUGIN, (t) => muta(muta(t, /^[ \t]*#if DEBUG\n([ \t]*metodi\.append)/m, (_x, riga) => riga), /(metodi\.append\([^\n]*\n)[ \t]*#endif\n/, (_x, riga) => riga)) }) },
  { regola: '2 metodi', caso: 'Java: creaElementoDiProva senza il guard BuildConfig.DEBUG', atteso: /non è protetto da `BuildConfig.DEBUG`/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, /if \(\s*!\s*BuildConfig\.DEBUG\s*\)/, 'if (BuildConfig.VERSION_CODE < 0)')) }) },
  { regola: '2 metodi', caso: 'Java: tolto @PluginMethod da elenco', atteso: /`elenco`.*manca da Java/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, /@PluginMethod\s+public void elenco\(/, 'public void elenco(')) }) },
  { regola: '3 registrazione', caso: 'Swift: la registrazione dopo un guard', atteso: /DOPO un `guard` di `capacitorDidLoad`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVBridgeViewController.swift', (t) => muta(t, /^([ \t]*)bridge\?\.registerPluginInstance\(KVCaricamentiPlugin\(\)\)\n/m, (_x, rientro) => `${rientro}guard bridge != nil else { return }\n${rientro}bridge?.registerPluginInstance(KVCaricamentiPlugin())\n`)) }) },
  { regola: '3 registrazione', caso: 'Java: registerPlugin dopo super.onCreate', atteso: /`registerPlugin` sta DOPO `super.onCreate/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, /registerPlugin\(KidvilleCaricamentiPlugin\.class\);(\s*)super\.onCreate\(savedInstanceState\);/, (_x, spazio) => `super.onCreate(savedInstanceState);${spazio}registerPlugin(KidvilleCaricamentiPlugin.class);`)) }) },
  { regola: '4 ingressi', caso: 'AppDelegate senza handleEventsForBackgroundURLSession', atteso: /manca `application\(_:handleEventsForBackgroundURLSession/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, /    func application\(_ application: UIApplication, handleEventsForBackgroundURLSession[^\n]*\{\n[\s\S]*?\n    \}\n/, '')) }) },
  { regola: '4 ingressi', caso: 'AppDelegate senza avvia()', atteso: /non chiama `KVMotoreCaricamenti.condiviso.avvia\(\)`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, 'KVMotoreCaricamenti.condiviso.avvia()', '_ = 0')) }) },
  { regola: '4 ingressi', caso: 'AppDelegate senza riprendiInPrimoPiano()', atteso: /riprendiInPrimoPiano/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, 'KVMotoreCaricamenti.condiviso.riprendiInPrimoPiano()', '_ = 0')) }) },
  { regola: '4 ingressi', caso: 'MainActivity.onResume senza try/catch', atteso: /non sta in un `try \{ … \} catch \(Throwable/,
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, /try \{(\s*PianificatoreCaricamenti\.riprendiInPrimoPiano\(this\);\s*)\} catch \(Throwable [^)]*\) \{[^}]*\}/, (_x, dentro) => dentro)) }) },
  { regola: '5 sessione', caso: 'isDiscretionary = true', atteso: /`isDiscretionary = true`, deve essere `false`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, /configurazione\.isDiscretionary = false/, 'configurazione.isDiscretionary = true')) }) },
  { regola: '5 sessione', caso: 'allowsConstrainedNetworkAccess = false', atteso: /`allowsConstrainedNetworkAccess = false`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, /allowsConstrainedNetworkAccess = true/, 'allowsConstrainedNetworkAccess = false')) }) },
  { regola: '5 sessione', caso: 'sessionSendsLaunchEvents tolto', atteso: /non imposta `sessionSendsLaunchEvents = true`/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, /^[ \t]*configurazione\.sessionSendsLaunchEvents = true\n/m, '')) }) },
  { regola: '5 sessione', caso: 'identificativo diverso', atteso: /deve essere "it.kidville.app.caricamenti"/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, /static let identificativoSessione = "it\.kidville\.app\.caricamenti"/, 'static let identificativoSessione = "it.kidville.app.altro"')) }) },
  { regola: '6 sources', caso: 'il plugin non è nella fase Sources', atteso: /`KVCaricamentiPlugin.swift` sta sul disco.*NON nella fase Sources/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, /^\t\t\t\t\w+ \/\* KVCaricamentiPlugin\.swift in Sources \*\/,\n/m, '') }) },
  { regola: '6 sources', caso: 'il selettore non è nella fase Sources', atteso: /`KVSelettoreMedia.swift` sta sul disco.*NON nella fase Sources/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, /^\t\t\t\t\w+ \/\* KVSelettoreMedia\.swift in Sources \*\/,\n/m, '') }) },
  { regola: '7 manifest', caso: 'READ_MEDIA_VIDEO nel manifest', atteso: /dichiara android.permission.READ_MEDIA_VIDEO/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '</manifest>', '    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />\n</manifest>') }) },
  { regola: '7 manifest', caso: 'READ_EXTERNAL_STORAGE nel manifest', atteso: /dichiara android.permission.READ_EXTERNAL_STORAGE/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '</manifest>', '    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />\n</manifest>') }) },
  { regola: '7 manifest', caso: 'manca il servizio UIDT', atteso: /manca il `<service android:name="\.caricamenti\.ServizioCaricamentiUidt"/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, /<service\s+android:name="\.caricamenti\.ServizioCaricamentiUidt"[^>]*\/>/, '') }) },
  { regola: '7 manifest', caso: 'manca il tipo dataSync', atteso: /non dichiara `android:foregroundServiceType="dataSync"`/,
    muta: (m) => ({ ...m, manifest: muta(m.manifest, 'android:foregroundServiceType="dataSync"', 'android:foregroundServiceType="location"') }) },
  { regola: '8 versioni', caso: 'iOS: MARKETING_VERSION 1.1', atteso: /MARKETING_VERSION = 1.1, deve essere 1.2/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, /MARKETING_VERSION = 1\.2;/, 'MARKETING_VERSION = 1.1;') }) },
  { regola: '8 versioni', caso: 'iOS: CURRENT_PROJECT_VERSION 5', atteso: /CURRENT_PROJECT_VERSION = 5, deve essere 6/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, /CURRENT_PROJECT_VERSION = 6;/, 'CURRENT_PROJECT_VERSION = 5;') }) },
  { regola: '8 versioni', caso: 'iOS: la Release definisce DEBUG', atteso: /la configurazione Release definisce DEBUG/,
    muta: (m) => ({ ...m, pbxproj: muta(m.pbxproj, /SWIFT_ACTIVE_COMPILATION_CONDITIONS = "";/, 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;') }) },
  { regola: '8 versioni', caso: 'Android: versionCode 3', atteso: /versionCode 3, deve essere 4/,
    muta: (m) => ({ ...m, gradle: muta(m.gradle, /^( +)versionCode 4$/m, (_x, rientro) => `${rientro}versionCode 3`) }) },
  { regola: '8 versioni', caso: 'Android: versionName 1.1', atteso: /versionName "1.1", deve essere "1.2"/,
    muta: (m) => ({ ...m, gradle: muta(m.gradle, /versionName "1\.2"/, 'versionName "1.1"') }) },
  { regola: '8 versioni', caso: 'Android: variables.gradle senza androidxWorkVersion', atteso: /manca `androidxWorkVersion = /,
    muta: (m) => ({ ...m, variabili: muta(m.variabili, /^\s*androidxWorkVersion = [^\n]*\n/m, '') }) },
  { regola: '9 log', caso: 'Swift: absoluteString in un Logger del motore', atteso: /`absoluteString` dentro una chiamata di log \(`diagnostica.error`\)/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, /diagnostica\.error\("/, 'diagnostica.error("\\(url.absoluteString) ')) }) },
  { regola: '9 log', caso: 'Swift: lastPathComponent nel registro nativo', atteso: /`lastPathComponent` dentro una chiamata di log \(`registraAccodato`\)/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, /registro\.registraAccodato\(job: /, 'registro.registraAccodato(nome: url.lastPathComponent, job: ')) }) },
  { regola: '9 log', caso: 'Java: getMessage in un Log.e del plugin', atteso: /`getMessage` dentro una chiamata di log \(`Log.e`\)/,
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, /Log\.e\(TAG, "([^"]*)" \+ \w+\.getClass\(\)\.getSimpleName\(\) \+ "\)"\);/, (_x, testo) => `Log.e(TAG, "${testo}" + guasto.getMessage() + ")");`)) }) },
  { regola: '10 messaggi', caso: 'Swift: un messaggio fuori elenco', atteso: /`video-nativo-nuovo` \(KVMessaggioLog\) non è in EVENTI_LOG_NATIVI/,
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVRegistroNativo.swift', (t) => muta(t, /(    case putOltreScadenza = "put-oltre-scadenza"\n)/, (_x, riga) => `${riga}    case nuovo = "video-nativo-nuovo"\n`)) }) },
  { regola: '10 messaggi', caso: 'Java: un messaggio fuori elenco', atteso: /`video-nativo-nuovo` \(RegistroNativo.Evento\) non è in EVENTI_LOG_NATIVI/,
    muta: (m) => ({ ...m, java: nel(m.java, 'RegistroNativo.java', (t) => muta(t, /PUT_OLTRE_SCADENZA\("put-oltre-scadenza", Livello\.WARN\);/, 'PUT_OLTRE_SCADENZA("put-oltre-scadenza", Livello.WARN),\n        NUOVO("video-nativo-nuovo", Livello.WARN);')) }) },
  { regola: '11 logout', caso: 'logout.ts importa il modulo dei caricamenti', atteso: /nomina `caricamenti-nativi`/,
    muta: (m) => ({ ...m, logout: `import { annullaTutto } from '@/lib/native/caricamenti-nativi'\n${m.logout}` }) },
]

/* ── I casi che devono restare VERDI: stesse parole, posti diversi ───────────────────────────── */

const CASI_VERDI: { caso: string; muta: (m: Mondo) => Mondo }[] = [
  { caso: 'Java: il guard di creaElementoDiProva nella forma `if (BuildConfig.DEBUG) { … } else { … }`',
    muta: (m) => ({ ...m, java: nel(m.java, JAVA_PLUGIN, (t) => muta(t, '        if (!BuildConfig.DEBUG) {\n            call.unimplemented("creaElementoDiProva esiste solo nelle build Debug");\n            return;\n        }\n        call.resolve();', '        if (BuildConfig.DEBUG) {\n            call.resolve();\n        } else {\n            call.unimplemented("creaElementoDiProva esiste solo nelle build Debug");\n        }')) }) },
  { caso: 'un permesso media con tools:node="remove" è la cura, non la malattia',
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '</manifest>', '<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" tools:node="remove" />\n</manifest>') }) },
  { caso: 'un permesso media nominato in un commento XML',
    muta: (m) => ({ ...m, manifest: muta(m.manifest, '</manifest>', '<!-- niente <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" /> -->\n</manifest>') }) },
  { caso: 'UIBackgroundModes in un commento del plist',
    muta: (m) => ({ ...m, infoPlist: muta(m.infoPlist, '<dict>', '<dict>\n\t<!-- niente <key>UIBackgroundModes</key> -->') }) },
  { caso: 'un permesso media nominato in un commento Java',
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '    @Override\n    protected void onCreate', '    // niente Manifest.permission.READ_MEDIA_IMAGES: il Photo Picker non ne ha bisogno\n    @Override\n    protected void onCreate')) }) },
  { caso: 'absoluteString e lastPathComponent FUORI da una chiamata di log',
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => `${t}\nfunc destinazione(_ url: URL) -> String { url.absoluteString + url.lastPathComponent }\n`) }) },
  { caso: 'authorizationStatus dentro un log (non è la credenziale `authorization`)',
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => `${t}\nfunc stato(_ s: UNNotificationSettings) { diagnostica.info("stato \\(s.authorizationStatus.rawValue, privacy: .public)") }\n`) }) },
  { caso: 'le parole vietate in un commento accanto a una chiamata di log',
    muta: (m) => ({ ...m, swift: nel(m.swift, 'KVMotoreCaricamenti.swift', (t) => muta(t, '        registro.registraAccodato(job: job, utente: utente, byte: byte)', '        // niente url.absoluteString, e.localizedDescription né x-upsert qui\n        registro.registraAccodato(job: job, utente: utente, byte: byte)')) }) },
  { caso: 'una funzione con un parametro String FUORI dalla sezione degli eventi (svuota, impostaDestinazione): non è di log',
    muta: (m) => ({
      ...m,
      swift: nel(m.swift, 'KVRegistroNativo.swift', (t) => muta(t, '    func stato() -> Int { 0 }\n', '    func stato() -> Int { 0 }\n    func impostaDestinazione(_ testo: String) -> Bool { !testo.isEmpty }\n')),
      java: nel(m.java, 'RegistroNativo.java', (t) => muta(t, '    /** Non è un metodo di log: il primo parametro non è un UUID. */', '    public int svuota(String urlRegistro, boolean debug) {\n        return urlRegistro.length();\n    }\n\n    /** Non è un metodo di log: il primo parametro non è un UUID. */')),
    }) },
  { caso: 'getMessage() FUORI da una chiamata di log (Java)',
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '    @Override\n    public void onResume() {\n', '    static String perLoSchermo(Throwable t) {\n        return t.getMessage();\n    }\n\n    @Override\n    public void onResume() {\n')) }) },
  { caso: 'una `{` e una `//` dentro una stringa non cambiano la lettura della struttura (Swift)',
    muta: (m) => ({ ...m, swift: nel(m.swift, 'AppDelegate.swift', (t) => muta(t, '        KVMotoreCaricamenti.condiviso.notificaSeFermo()\n', '        let _ = "http://esempio.invalid/{ // ["\n        KVMotoreCaricamenti.condiviso.notificaSeFermo()\n')) }) },
  { caso: 'una `}` dentro una stringa non chiude il metodo (Java)',
    muta: (m) => ({ ...m, java: nel(m.java, 'MainActivity.java', (t) => muta(t, '        registerPlugin(KidvilleCaricamentiPlugin.class);\n', '        Log.i(TAG_CARICAMENTI, "} // {");\n        registerPlugin(KidvilleCaricamentiPlugin.class);\n')) }) },
  { caso: 'logout.ts che nomina i caricamenti solo in un commento',
    muta: (m) => ({ ...m, logout: `// I caricamenti-nativi proseguono: KidvilleCaricamenti non si tocca all'uscita.\n${m.logout}` }) },
  { caso: 'un nuovo componente Android dichiarato nel manifest',
    muta: (m) => ({
      ...m,
      manifest: muta(m.manifest, '</application>', '<service android:name=".caricamenti.ServizioAltro" android:exported="false" />\n    </application>'),
      java: [...m.java, { file: 'ServizioAltro.java', testo: 'package it.kidville.app.caricamenti;\npublic final class ServizioAltro extends Service {}\n' }],
    }) },
  { caso: 'un nuovo file Swift, aggiunto anche alla fase Sources',
    muta: (m) => ({
      ...m,
      swift: [...m.swift, { file: 'KVNuovo.swift', testo: 'import Foundation\nfinal class KVNuovo {}\n' }],
      pbxproj: muta(muta(m.pbxproj, '/* End PBXBuildFile section */', '\t\tF00000000000000000000006 /* KVNuovo.swift in Sources */ = {isa = PBXBuildFile; fileRef = F00000000000000000000106 /* KVNuovo.swift */; };\n/* End PBXBuildFile section */'), '/* End PBXFileReference section */', '\t\tF00000000000000000000106 /* KVNuovo.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = KVNuovo.swift; sourceTree = "<group>"; };\n/* End PBXFileReference section */').replace(
        '\t\t\t\tF00000000000000000000005 /* KVRegistroNativo.swift in Sources */,\n',
        '\t\t\t\tF00000000000000000000005 /* KVRegistroNativo.swift in Sources */,\n\t\t\t\tF00000000000000000000006 /* KVNuovo.swift in Sources */,\n',
      ),
    }) },
]

describe('controllo positivo — il lock dice ROSSO quando deve, e VERDE quando deve', () => {
  it('le fixture ok/ sono verdi per tutte le regole (senza questo, un rosso non prova niente)', () => {
    expect(tutteLeRegole(mondoOk())).toEqual([])
  })

  it('le tre fixture ko/ del compito esistono sul disco e sono rosse da sole', () => {
    // Il caso nominato dal compito: un plugin Swift con un metodo mancante, un Java con creaElementoDiProva fuori da BuildConfig.DEBUG,
    // un manifest con READ_MEDIA_VIDEO, una chiamata di log con absoluteString.
    const ok = mondoOk()
    const rosse: [string, Problemi][] = [
      ['ko/KVCaricamentiPlugin-metodo-mancante.swift', problemiPluginSwift('ko/KVCaricamentiPlugin-metodo-mancante.swift', leggiFixture('ko/KVCaricamentiPlugin-metodo-mancante.swift'))],
      ['ko/KidvilleCaricamentiPlugin-prova-fuori-da-debug.java', problemiPluginJava('ko/KidvilleCaricamentiPlugin-prova-fuori-da-debug.java', leggiFixture('ko/KidvilleCaricamentiPlugin-prova-fuori-da-debug.java'))],
      ['ko/AndroidManifest-read-media-video.xml', problemiManifest('ko/AndroidManifest-read-media-video.xml', leggiFixture('ko/AndroidManifest-read-media-video.xml'), [])],
      ['ko/KVRegistro-log-con-absoluteString.swift', problemiDiLog('ko/KVRegistro-log-con-absoluteString.swift', leggiFixture('ko/KVRegistro-log-con-absoluteString.swift'), 'swift', nomiRegistroSwift(trova(ok.swift, 'KVRegistroNativo.swift').testo))],
    ]
    for (const [file, problemi] of rosse) expect(problemi.length, `${file} dovrebbe essere rossa`).toBeGreaterThan(0)
    // La fixture del log dice rosso quattro volte: registro nativo, Logger di sistema, Logger inline, print.
    expect(rosse[3][1]).toHaveLength(4)
  })

  it.each(CASI_ROSSI_SU_FIXTURE)('fixture · $regola · $caso → ROSSO', ({ muta: cambia, atteso }) => {
    const problemi = tutteLeRegole(cambia(mondoOk()))
    expect(problemi.length, 'il caso dovrebbe diventare rosso').toBeGreaterThan(0)
    expect(problemi.join('\n')).toMatch(atteso)
  })

  it('i file veri sono verdi per tutte le regole (la base dei casi qui sotto: un rosso dipende dalla mutazione, non da un albero già rotto)', () => {
    expect(tutteLeRegole(mondoVero())).toEqual([])
  })

  it.each(CASI_ROSSI_SUI_FILE_VERI)('file veri · $regola · $caso → ROSSO', ({ muta: cambia, atteso }) => {
    const problemi = tutteLeRegole(cambia(mondoVero()))
    expect(problemi.length, 'il caso dovrebbe diventare rosso').toBeGreaterThan(0)
    expect(problemi.join('\n')).toMatch(atteso)
  })

  it.each(CASI_VERDI)('fixture · $caso → resta VERDE', ({ muta: cambia }) => {
    expect(tutteLeRegole(cambia(mondoOk()))).toEqual([])
  })

  it.each(PROIBITI_NEI_LOG_COMUNI)('ognuna delle parole vietate (`%s`) dentro un log scatta, in Swift e in Java', (parola) => {
    const swift = problemiDiLog('x.swift', `final class X {\n    let diagnostica = Logger(subsystem: "a", category: "b")\n    func f() { diagnostica.error("riga \\(${parola}) fine") }\n}\n`, 'swift', [])
    const java = problemiDiLog('X.java', `class X {\n    void f() {\n        Log.e(TAG, "riga " + ${parola.includes('-') ? `"${parola}"` : parola} + " fine");\n    }\n}\n`, 'java', [])
    expect(swift.join('\n'), `Swift, ${parola}`).toContain(`\`${parola}\``)
    expect(java.join('\n'), `Java, ${parola}`).toContain(`\`${parola}\``)
  })

  it('i casi rossi coprono ogni regola (se una regola non ha un caso, il controllo positivo non la vede)', () => {
    const regole = new Set([...CASI_ROSSI_SU_FIXTURE, ...CASI_ROSSI_SUI_FILE_VERI].map((c) => c.regola.split(' ')[0]))
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']) expect(regole.has(n), `nessun caso rosso per la regola ${n}`).toBe(true)
  })
})

describe('il lettore dei sorgenti non si lascia ingannare dalla sintassi', () => {
  it('Swift: stringhe con `//`, interpolazioni annidate, stringhe raw e commenti a blocco annidati', () => {
    const sorgente = [
      'let a = "http://x.invalid/{" // commento con { e "virgolette',
      '/* blocco /* annidato con { */ ancora commento { */ let b = 1',
      'let c = "dentro \\(f("annidata }")) fuori"',
      'let d = #"raw con \\ e " dentro"# ; let e = 2',
      'let f = """',
      '   multi { riga // senza commento',
      '   """',
    ].join('\n')
    const struttura = ripulisci(sorgente, 'swift', 'svuota')
    expect(struttura.length).toBe(sorgente.length)
    expect(struttura).not.toMatch(/commento|annidato|annidata|multi|raw/)
    expect(struttura).toContain('let b = 1')
    expect(struttura).toContain('let e = 2')
    expect((struttura.match(/\{/g) ?? []).length).toBe(0)
    const tenute = ripulisci(sorgente, 'swift', 'tieni')
    expect(tenute).toContain('http://x.invalid/{')
    expect(tenute).not.toContain('commento con')
  })

  it('Java: commenti, stringhe, caratteri e blocchi di testo; le posizioni restano quelle del file', () => {
    const sorgente = [
      'class A { // commento con " dentro',
      '  /* blocco { */ char c = \'{\'; String s = "a // b { \\" c";',
      '  String t = """',
      '      blocco di testo { }',
      '      """;',
      '}',
    ].join('\n')
    const struttura = ripulisci(sorgente, 'java', 'svuota')
    expect(struttura.length).toBe(sorgente.length)
    expect((struttura.match(/\{/g) ?? []).length).toBe(1)
    expect((struttura.match(/\}/g) ?? []).length).toBe(1)
    expect(struttura.split('\n')).toHaveLength(sorgente.split('\n').length)
  })

  it('XML: i commenti spariscono, gli attributi no', () => {
    const netto = ripulisci('<a b="1"><!-- <c d="2"/> --><e f="3"/></a>', 'xml')
    expect(netto).toContain('<a b="1">')
    expect(netto).toContain('<e f="3"/>')
    expect(netto).not.toContain('d="2"')
  })

  it('`#if DEBUG` di Swift: il ramo positivo è Debug, `#else` no, e le direttive in un commento non contano', () => {
    const sorgente = ['#if canImport(X)', '  // #if DEBUG', '  let a = 1', '  #if DEBUG', '  let b = 2', '  #else', '  let c = 3', '  #endif', '  let d = 4', '#endif'].join('\n')
    const struttura = ripulisci(sorgente, 'swift', 'svuota')
    const condizioni = condizioniSwift(struttura)
    const dove = (s: string): string[] => condizioni(sorgente.indexOf(s))
    expect(dove('let a')).toEqual(['canImport(X)'])
    expect(dove('let b')).toEqual(['canImport(X)', 'DEBUG'])
    expect(dove('let c')).toEqual(['canImport(X)', 'else di DEBUG'])
    expect(dove('let d')).toEqual(['canImport(X)'])
    expect(soloInDebug(dove('let a'))).toBe(false)
    expect(soloInDebug(dove('let b'))).toBe(true)
    expect(soloInDebug(dove('let c'))).toBe(false)
    expect(soloInDebug(dove('let d'))).toBe(false)
  })
})
