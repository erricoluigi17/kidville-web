import type { PluginListenerHandle } from '@capacitor/core'
import { z } from 'zod'

import { TETTO_GALLERIA_BYTE } from '@/lib/gallery/limiti'
import {
  schemaCoordinatePutVideo,
  schemaFileVideoDichiarato,
  schemaTokenRinnovoVideo,
} from '@/lib/media/video/contratto'
import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
import { SUPABASE_URL } from '@/lib/supabase/public-config'

/**
 * IL CONTRATTO FRA IL JAVASCRIPT E IL PLUGIN `KidvilleCaricamenti` — una fonte sola.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.1-§4.5, compito S1)
 *
 * ─── CHE COSA È ──────────────────────────────────────────────────────────────────────────────
 * Il plugin nativo (Swift in `ios/App/App/`, Java nel pacchetto `it.kidville.app.caricamenti`)
 * porta il video di un'insegnante dal telefono allo Storage anche a schermo bloccato. Questo
 * modulo è il suo confine dal lato JavaScript: il nome, l'elenco CHIUSO dei metodi, i vocabolari
 * (stati, codici, motivi di rifiuto, messaggi di log), le tabelle di §4.4, i tipi e gli SCHEMI zod
 * con cui ogni risposta del ponte viene riletta prima che il JS se ne fidi. Il ponte è un confine
 * come una route: un oggetto fuori forma non deve mai diventare una PUT, un `File` o un job.
 *
 * Chi lo usa: l'involucro (`caricamenti-nativi.ts`), il selettore e l'invio nella Galleria, i
 * test, e il lock `caricamenti-nativi-agganciati`, che confronta questi elenchi con i sorgenti
 * Swift e Java (nome del plugin, insiemi di metodi, messaggi di log). Per questo i nomi stanno
 * scritti per esteso e non si calcolano: un elenco che si deriva da un altro non può dire «manca».
 *
 * ─── COME È FATTO ────────────────────────────────────────────────────────────────────────────
 *  · SOLO CLIENT, senza effetti: niente rete, niente disco, niente log, niente `window`. Dal
 *    plugin importa solo un TIPO (`PluginListenerHandle`, cancellato in compilazione): il plugin
 *    vero lo prende l'involucro, una volta, con `registerPlugin`. Non lo importa il server.
 *  · I LIMITI NON SONO RISCRITTI: peso e durata del video vengono da `@/lib/media/video/limiti`,
 *    il tetto di una foto dal bucket (`@/lib/gallery/limiti`). Un test rifà girare questo modulo
 *    con altri valori di `limiti.ts` e guarda gli schemi seguirli: copiare un numero qui lo
 *    farebbe diventare rosso. Il tetto di elementi per scelta (`MAX_ELEMENTI_PER_SCELTA`) sta in
 *    `selettore-media.ts`, che importa il logger: lo applica il chiamante, e non lo si importa
 *    qui per non aprire un ciclo con chi, a sua volta, vorrà i tipi di questo modulo.
 *  · IL CONTRATTO VERO DELLA PR 2 VINCE SULLA SPEC. Dove il server ha già uno schema per lo stesso
 *    dato (l'URL di PUT, il `content-type`, il MIME dichiarato, il token di rinnovo) lo si
 *    RIUSA, non lo si copia: ciò che qui passa, passa anche all'apertura dell'intento.
 *  · OGGETTI NON STRETTI (`z.object`, non `z.strictObject`): un campo in più, scritto da un
 *    binario più nuovo, viene scartato e non rompe la lettura (il JS è uno solo per tutti i
 *    binari installati, e il binario 1.2 resta nei telefoni per anni). Un campo che MANCA, invece,
 *    è un rifiuto. Le rotture vere si dichiarano alzando `PROTOCOLLO_CARICAMENTI`.
 *  · NIENTE PERCORSI, NIENTE HASH NEI LOG: i campi che qui sono «solo per lo schermo» (`nome`) non
 *    si loggano mai; i messaggi di log nativi sono l'elenco chiuso `EVENTI_LOG_NATIVI` (§8.2).
 *
 * ─── DUE SCELTE CHE LA SPEC LASCIAVA APERTE ──────────────────────────────────────────────────
 *  1. `sha256` è in ESADECIMALE MINUSCOLO, 64 caratteri, e non si normalizza: il server lo
 *     accetta anche maiuscolo e lo riporta in minuscolo, ma qui il valore viaggia due volte (dalla
 *     scelta all'accodamento) e viene CONFRONTATO dal nativo con quello dell'elemento: due scritture
 *     dello stesso hash sarebbero un `ELEMENTO_DIVERSO` inventato. La spec scrive «minuscolo».
 *  2. LA FORMA DEBUG. Gli indirizzi di rinnovo e di registro si compongono dall'origine della
 *     pagina (`window.location.origin`, spec §7.4): in produzione `https://app.kidville.it`, ma nel
 *     collaudo dell'app vera (§11.2) la WebView apre `http://localhost:3101` (iOS) o
 *     `http://10.0.2.2:3101` (Android). Per quei DUE indirizzi si ammette quindi `http` verso
 *     `HOST_DEBUG_CARICAMENTI` (gli stessi host della politica nativa, §9), con qualunque porta.
 *     È una verifica di FORMA, non di sicurezza: la politica degli host (in Release solo il
 *     progetto Supabase di produzione per la PUT e `app.kidville.it` per il resto) è del nativo, che la
 *     prova e rifiuta con `HOST_NON_AMMESSO`; una pagina compromessa non passa da qui, chiama il plugin.
 *     L'URL della PUT NON ha la forma Debug: viene dallo Storage (`schemaCoordinatePutVideo`, solo
 *     `https`) in ogni ambiente. Dal 03/10 ha anche UN host solo (deciso dopo il critico di I2): quello del
 *     progetto Supabase di QUESTO sito (`AUTORITA_PUT_AMMESSA_CARICAMENTI`, da `public-config.ts`), che in
 *     produzione è il progetto di PRODUZIONE e nessun altro. Un URL di un altro progetto `*.supabase.co` è
 *     fuori forma già qui, e il nativo (che ha il progetto di produzione scritto per esteso) lo
 *     rifiuterebbe comunque. L'indirizzo di produzione NON si scrive in questo file: un lock
 *     (`nessun-bersaglio-di-produzione`, regola 6) lo vuole in UN file solo di `src/`.
 *
 * ─── CHE COSA NON C'È, E PERCHÉ ──────────────────────────────────────────────────────────────
 *  · `creaElementoDiProva`: esiste solo nelle build Debug (`#if DEBUG`, `BuildConfig.DEBUG`) e
 *    non sta nell'elenco dei metodi, che il lock confronta con i sorgenti di Release.
 *  · La politica della PUT e del rinnovo, le attese, gli host di Release: sono tabelle di decisione
 *    del nativo (§4.5, §9), provate riga per riga in Swift e in Java, non qui.
 *  · L'elenco dei nomi d'errore dello Storage (`Duplicate`, `InvalidJWT`, …): lo misura S0-c e lo
 *    scrive il nativo; al JS non arrivano mai (arriva solo `codice`).
 */

/* ────────────────────────────────────────────────────────────────────────────
 * IL PLUGIN: nome, protocollo, metodi, eventi
 * ──────────────────────────────────────────────────────────────────────────── */

/** Il nome con cui il plugin si registra: identico in Swift (`jsName`), Java (`@CapacitorPlugin`) e qui. */
export const NOME_PLUGIN_CARICAMENTI = 'KidvilleCaricamenti'

/**
 * La versione del protocollo fra JS e nativo. Si alza solo quando una forma cambia in modo che un
 * binario vecchio e un JS nuovo (o il contrario) non si capiscano più; `info()` la restituisce e
 * l'involucro rifiuta un protocollo diverso (binario incompleto, errore nel log).
 */
export const PROTOCOLLO_CARICAMENTI = 1

/**
 * I metodi del plugin, e sono NOVE: la fonte che il lock di J4 confronta con `pluginMethods` (Swift) e
 * con i `@PluginMethod` (Java). `addListener` non è un metodo del plugin (lo porta la classe base di
 * Capacitor) e `creaElementoDiProva` esiste solo in Debug: nessuno dei due sta qui.
 */
export const METODI_PLUGIN_CARICAMENTI = [
  'info',
  'scegliMedia',
  'annullaScelta',
  'leggiFoto',
  'scartaScelti',
  'accodaVideo',
  'elenco',
  'annulla',
  'dimentica',
] as const
export type MetodoPluginCaricamenti = (typeof METODI_PLUGIN_CARICAMENTI)[number]

/** Gli eventi che il plugin manda al JS (`addListener`): l'avanzamento della preparazione e ogni cambio di una voce. */
export const EVENTI_PLUGIN_CARICAMENTI = ['preparazione', 'caricamento'] as const
export type EventoPluginCaricamenti = (typeof EVENTI_PLUGIN_CARICAMENTI)[number]

/* ────────────────────────────────────────────────────────────────────────────
 * I NUMERI
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Per quanto vale un URL di PUT firmato: due ore. È il valore di `VALIDITA_FIRMA_SECONDI`
 * (`src/app/api/video-uploads/firme.ts`), che è una route e non si importa in un modulo client: il
 * numero è scritto qui e un test lo confronta con l'originale. La risposta del rinnovo porta solo la
 * scadenza del TOKEN (48 ore): quella dell'URL la calcola il nativo, istante di ricezione + questo.
 */
export const VALIDITA_URL_PUT_SECONDI = 7200

/**
 * Oltre quest'età (secondi dalla firma) l'URL si rinnova PRIMA di creare, o ricreare, il trasferimento. S0 (spec §3) ha
 * misurato che lo Storage verifica la firma alla FINE della PUT: così ogni trasferimento ha davanti quasi due ore piene.
 * Prima di S0 la regola era «se ne restano meno di 15 minuti» (900 s), e non bastava.
 */
export const ETA_MASSIMA_URL_PRIMA_DELLA_PUT_SECONDI = 600

/** Lato massimo di una foto dopo la riduzione nativa, e qualità JPEG: le passa il JS, il nativo non le riscrive. */
export const LATO_MASSIMO_FOTO = 1920
export const QUALITA_FOTO = 0.85

/** Lato massimo della miniatura di un video (lato lungo, JPEG in data URL). */
export const LATO_MINIATURA_VIDEO = 320

/* ────────────────────────────────────────────────────────────────────────────
 * I VOCABOLARI CHIUSI
 * ──────────────────────────────────────────────────────────────────────────── */

/** Perché un elemento scelto non viene accettato (`rifiutato`). Sei, e la lingua è del JS: il nativo manda solo il motivo. */
export const MOTIVI_RIFIUTO = [
  'troppo-grande',
  'troppo-lungo',
  'formato-non-supportato',
  'illeggibile',
  'spazio-insufficiente',
  'icloud-non-disponibile',
] as const
export type MotivoRifiuto = (typeof MOTIVI_RIFIUTO)[number]

/** Gli stati di una voce della coda nativa (§4.4). */
export const STATI_NATIVI = [
  'in-coda',
  'in-invio',
  'in-attesa',
  'in-pausa',
  'inviato',
  'fallito',
  'annullato',
] as const
export type StatoNativo = (typeof STATI_NATIVI)[number]

/**
 * I codici che accompagnano una voce (`CaricamentoNativo.codice`) e i messaggi di log: il PERCHÉ di un'attesa, di una
 * pausa o di un esito. Mai testo libero, mai il messaggio di un'eccezione.
 */
export const CODICI_NATIVI = [
  'RETE',
  'SERVER',
  'FIRMA_RIFIUTATA',
  'TOKEN_NON_VALIDO',
  'TOKEN_SCADUTO',
  'RINNOVO_CICLICO',
  'TROPPO_GRANDE',
  'FILE_ASSENTE',
  'PESO_DIVERSO',
  'ANNULLATO_DAL_SERVER',
  'CHIUSURA_FORZATA',
  'FGS_NON_AVVIABILE',
  'UIDT_NON_PROGRAMMABILE',
  'INTERNO',
] as const
export type CodiceNativo = (typeof CODICI_NATIVI)[number]

/**
 * I `code` con cui il ponte RIFIUTA una chiamata (colonna «Rifiuti» di §4.3; il messaggio che li
 * accompagna è una costante e al JS non interessa). È l'elenco chiuso in cui l'involucro traduce
 * un rifiuto: nei log finisce il codice, mai il messaggio.
 */
export const CODICI_RIFIUTO_PONTE = [
  'GIA_IN_CORSO',
  'SELETTORE_NON_DISPONIBILE',
  'PARAMETRI_NON_VALIDI',
  'ELEMENTO_ASSENTE',
  'ELEMENTO_DIVERSO',
  'HOST_NON_AMMESSO',
  'INTERNO',
] as const
export type CodiceRifiutoPonte = (typeof CODICI_RIFIUTO_PONTE)[number]

/**
 * I messaggi di log che il NATIVO può scrivere (§8.2): lo slug che apre il messaggio, prima di `: job=<uuid>` e
 * del codice. Swift e Java non ne usano altri: lo pretende il lock di J4. Gli eventi che scrive il JS (§8.3) non stanno
 * qui. Un messaggio nuovo si aggiunge qui, nella spec e nel PRD nello stesso lavoro, e mai con un testo libero.
 *
 * `put-oltre-scadenza` (aggiunto il 03/10, dopo S0 e l'ondata 2): un `400 InvalidJWT` arrivato DOPO il trasferimento è
 * la firma scaduta durante l'invio (spec §3, §4.5); la riga porta la durata del trasferimento (`durata_s`).
 * ⚠️ Niente commenti DENTRO l'elenco: l'harness iOS, JUnit e il server finto lo leggono come testo, e un apostrofo in un
 * commento diventa un messaggio in più.
 */
export const EVENTI_LOG_NATIVI = [
  'video-nativo-accodato',
  'video-nativo-inviato',
  'video-nativo-ritento',
  'video-nativo-rinnovo',
  'video-nativo-attesa-rete',
  'video-nativo-pausa',
  'video-nativo-ripreso-dopo-chiusura',
  'video-nativo-annullato',
  'video-nativo-fallito',
  'media-nativo-preparazione-fallita',
  'caricamenti-nativi-motore',
  'coda-nativa-corrotta',
  'registro-nativo-scartati',
  'notifica-locale-non-autorizzata',
  'put-oltre-scadenza',
] as const
export type EventoLogNativo = (typeof EVENTI_LOG_NATIVI)[number]

export const PIATTAFORME_CARICAMENTI = ['ios', 'android'] as const
export type PiattaformaCaricamenti = (typeof PIATTAFORME_CARICAMENTI)[number]

/** `urlsession` su iOS; su Android `uidt` da API 34 e `workmanager` da API 24 a 33 (§6.2). */
export const MOTORI_CARICAMENTI = ['urlsession', 'uidt', 'workmanager'] as const
export type MotoreCaricamenti = (typeof MOTORI_CARICAMENTI)[number]

/** Quale motore può stare su quale piattaforma: `info()` con una coppia diversa è fuori forma. */
export const MOTORI_PER_PIATTAFORMA = {
  ios: ['urlsession'],
  android: ['uidt', 'workmanager'],
} as const satisfies Record<PiattaformaCaricamenti, readonly MotoreCaricamenti[]>

/** Da dove si sceglie: la galleria del telefono (PHPicker / Photo Picker) o «Scegli da File» (UIDocumentPicker / SAF). */
export const SORGENTI_SCELTA = ['galleria', 'file'] as const
export type SorgenteScelta = (typeof SORGENTI_SCELTA)[number]

/**
 * Gli host verso cui, e SOLO nelle build Debug del nativo, si può parlare in chiaro (§9). Qui servono alla forma
 * Debug degli indirizzi di rinnovo e di registro (testata): la politica vera, con la distinzione fra Release e
 * Debug, è del nativo.
 */
export const HOST_DEBUG_CARICAMENTI = ['localhost', '127.0.0.1', '10.0.2.2'] as const

/* ────────────────────────────────────────────────────────────────────────────
 * GLI STATI E LE TRANSIZIONI (§4.4)
 *
 * È la tabella di §4.4 così com'è scritta, una riga per freccia. La politica ESEGUIBILE è quella del
 * nativo (`KVPoliticaCaricamento` e `PoliticaCaricamento`, provate riga per riga): qui sta come DATO,
 * perché lo si possa leggere e confrontare. Due avvertenze:
 *  · descrive i PASSI DELLA POLITICA, non le sequenze che il JS osserva: chi legge `elenco` ogni dieci
 *    secondi vede stati che distano più di un passo (da `in-attesa` a `inviato` senza vedere
 *    `in-invio`), e quella non è una violazione. Non serve a validare due istantanee consecutive;
 *  · l'ingresso (`—` → `in-coda`) non è una transizione fra stati: è `accodaVideo`.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Lo stato con cui nasce una voce quando `accodaVideo` riesce. */
export const STATO_INIZIALE_NATIVO = 'in-coda' satisfies StatoNativo

/** Stati da cui non si esce più: copia e segreti sono già cancellati, la voce aspetta solo `dimentica` o la pulizia. */
export const STATI_TERMINALI_NATIVI = ['inviato', 'fallito', 'annullato'] as const satisfies readonly StatoNativo[]
export type StatoTerminaleNativo = (typeof STATI_TERMINALI_NATIVI)[number]

/**
 * Da ogni stato, gli stati a cui può passare in UN passo:
 *  · `in-coda` → `in-invio` (trasferimento avviato);
 *  · `in-invio` → `in-attesa` (rete assente, task in attesa, backoff dopo un transitorio), `in-pausa` (Android 12-13:
 *    FGS non avviabile da background; Android ≥ 14: UIDT non programmabile), `inviato` (PUT 2xx, o rinnovo `arrivato`);
 *  · `in-attesa` e `in-pausa` → `in-invio` (rete tornata, app riaperta);
 *  · qualunque stato non terminale → `annullato` (rinnovo `annullato`, `annulla` dal JS) e → `fallito` (esito
 *    definitivo di §4.5, token scaduto).
 *
 * `in-coda` → `in-pausa` (deciso il 03/10 dopo l'ondata 2): §6.2 manda la voce in pausa anche quando UIDT non si riesce a
 * programmare già all'accodamento, o il FGS non parte con voci ancora in coda. Android la usa; su iOS la freccia esiste
 * ma nessun evento la percorre. Le tabelle di TS, Swift e Java sono la stessa (le confrontano l'harness e JUnit).
 */
export const TRANSIZIONI_STATO_NATIVO = {
  'in-coda': ['in-invio', 'in-pausa', 'annullato', 'fallito'],
  'in-invio': ['in-attesa', 'in-pausa', 'inviato', 'annullato', 'fallito'],
  'in-attesa': ['in-invio', 'annullato', 'fallito'],
  'in-pausa': ['in-invio', 'annullato', 'fallito'],
  inviato: [],
  fallito: [],
  annullato: [],
} as const satisfies Record<StatoNativo, readonly StatoNativo[]>

export function eStatoTerminaleNativo(stato: StatoNativo): boolean {
  return (STATI_TERMINALI_NATIVI as readonly StatoNativo[]).includes(stato)
}

/** Vero se la tabella di §4.4 prevede il passo `da` → `a`. Un passo da uno stato a se stesso non è una transizione. */
export function transizioneNativaAmmessa(da: StatoNativo, a: StatoNativo): boolean {
  return (TRANSIZIONI_STATO_NATIVO[da] as readonly StatoNativo[]).includes(a)
}

/* ────────────────────────────────────────────────────────────────────────────
 * I MATTONI DI VALIDAZIONE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Un uuid in minuscolo, forma 8-4-4-4-12 e basta (non lo strict RFC: gli id seedati in dev non hanno versione, come
 * dice `zUuid` in `validation/common.ts`, che qui non si importa per non trascinare un modulo di validazione nel
 * bundle). Minuscolo perché il nativo li confronta come stringhe (`elenco` filtra per `utenteId`, `annulla` cerca
 * per `jobId`): Postgres e Supabase li scrivono così, e una maiuscola vorrebbe dire una voce che non si ritrova.
 */
const schemaUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'uuid in minuscolo (8-4-4-4-12)')

/**
 * L'identificativo di un elemento scelto: lo conia il nativo e dà il nome al file preparato (`scelti/<id>.<ext>`), quindi è
 * un gettone senza separatori né punti — niente `/`, niente `..`, niente spazi. Un UUID sta dentro (36 caratteri).
 */
const schemaIdElemento = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'gettone da 1 a 64 caratteri, senza separatori')

/** L'impronta SHA-256 del contenuto, in esadecimale minuscolo (testata, scelta 1). */
const schemaSha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 in esadecimale minuscolo, 64 caratteri')

/**
 * Il nome da mostrare, e per i video quello dichiarato al server: stessa forma di `schemaFileVideoDichiarato`
 * (da 1 a 255 caratteri). Il nativo ha sempre qualcosa da dire (se il sistema non dà un nome, un ripiego suo):
 * un nome vuoto arriverebbe all'apertura dell'intento come 400.
 */
const schemaNome = z.string().min(1).max(255)

/** Un istante ISO 8601, con la `Z` o con l'offset: un superinsieme di ciò che dice il contratto del server. */
const schemaDataOra = z.string().datetime({ offset: true })

/** Un contatore: intero, non negativo. */
const schemaContatore = z.number().int().min(0)

/**
 * Il peso di un video: da 1 byte al tetto di `limiti.ts`. È la regola di `validateVideoInputSize` (che il server
 * riapplica al file arrivato) e di `schemaFileVideoDichiarato.byte`: ciò che passa qui passa all'apertura.
 */
const schemaByteVideo = z.number().int().min(1).max(MAX_VIDEO_INPUT_BYTES)

/** Un avanzamento di byte: da 0 al tetto. Non lo si confronta col totale: è un dato da mostrare, non un invariante da imporre. */
const schemaByteInviati = z.number().int().min(0).max(MAX_VIDEO_INPUT_BYTES)

/** La durata di un video: positiva, fino al tetto di `limiti.ts` (come `schemaFileVideoDichiarato.durataSecondi`). */
const schemaDurataVideo = z.number().positive().max(MAX_VIDEO_DURATION_SECONDS)

/** Il MIME dichiarato di un video: la forma PERMISSIVA del server (anche col suffisso dei codec), riusata. */
const schemaMimeVideo = schemaFileVideoDichiarato.shape.mime

/** Lato di una foto già ridotta, e il suo peso (il tetto della porta delle foto del bucket). */
const schemaLatoFoto = z.number().int().min(1).max(LATO_MASSIMO_FOTO)
const schemaByteFoto = z.number().int().min(1).max(TETTO_GALLERIA_BYTE)

/** Base64 standard con il suo padding, senza spazi né a capo (Android: `Base64.NO_WRAP`). */
const FORMA_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * La miniatura di un video: un data URL JPEG in base64. Che il lato lungo non superi `LATO_MINIATURA_VIDEO` lo rispetta
 * il nativo: da una stringa non si vede, e qui non si decodifica un'immagine per misurarla.
 */
const schemaMiniatura = z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/, 'data URL image/jpeg in base64')

/** Un testo di notifica: non vuoto, non un muro. */
const schemaTestoNotifica = z.string().max(200).regex(/\S/, 'testo vuoto')

/**
 * La parte «utente@host:porta» di un indirizzo: ciò che sta fra `://` e il primo `/`, `?` o `#`. Non si usa `new URL`:
 * lancia sugli indirizzi malformati, e qui un `catch` che tace è vietato (AGENTS.md, regola 6); `URL.canParse`, che
 * eviterebbe il `catch`, non esiste sulle WebView di iOS 15 e 16.
 */
function autoritaDi(indirizzo: string): string {
  const inizio = indirizzo.indexOf('://')
  if (inizio < 0) return ''
  const resto = indirizzo.slice(inizio + 3)
  const fine = resto.search(/[/?#]/)
  return fine < 0 ? resto : resto.slice(0, fine)
}

/**
 * Nessuna credenziale incorporata: `https://x@host` è il travestimento classico di un indirizzo, e nessuno dei
 * nostri ne ha uno.
 */
function senzaCredenziali(indirizzo: string): boolean {
  return !autoritaDi(indirizzo).includes('@')
}

/**
 * L'indirizzo di rinnovo o di registro: `https` verso qualunque host, oppure — la forma Debug, testata scelta 2 —
 * `http` verso un host di `HOST_DEBUG_CARICAMENTI` con o senza porta. Maiuscole, spazi, credenziali, host che
 * ne contengono uno (`localhost.esempio.invalid`) o che ne cominciano con uno (`localhost@…`) sono rifiutati.
 */
function indirizzoApplicazioneAmmesso(indirizzo: string): boolean {
  if (/\s/.test(indirizzo)) return false
  const autorita = autoritaDi(indirizzo)
  if (autorita === '' || autorita.includes('@')) return false
  if (indirizzo.startsWith('https://')) return true
  if (!indirizzo.startsWith('http://')) return false
  const [host, porta, ...altro] = autorita.split(':')
  return (
    (HOST_DEBUG_CARICAMENTI as readonly string[]).includes(host) &&
    altro.length === 0 &&
    (porta === undefined || /^\d{1,5}$/.test(porta))
  )
}

/**
 * L'autorità (host e porta) ammessa per la PUT: quella del progetto Supabase di QUESTO sito, la stessa di `public-config.ts` da cui il server
 * firma gli URL (`firme.ts` importa la stessa costante). In produzione è il progetto di PRODUZIONE e nessun altro; in sviluppo, e sotto vitest, è
 * quello del banco locale. Fino al 03/10/2026 la PUT era ammessa verso qualunque `*.supabase.co`: una pagina compromessa avrebbe potuto far
 * spedire il video di un bambino al progetto Supabase di un altro (ne basta uno registrato da chiunque; decisione dell'orchestratore dopo il
 * critico di I2, rischio su dati di minori).
 *
 * Il progetto di produzione NON si scrive qui: un lock (`nessun-bersaglio-di-produzione`, regola 6) vuole il suo indirizzo in UN file solo di
 * `src/`, e il valore giusto, in produzione, è già questo. Il nativo invece lo ha scritto per esteso (`KVPoliticaCaricamento.hostPut`,
 * `PoliticaCaricamento.HOST_PUT`), ed è lui la difesa vera: qui è una verifica di forma che fa fallire presto, con un log, ciò che il nativo
 * rifiuterebbe.
 */
export const AUTORITA_PUT_AMMESSA_CARICAMENTI = autoritaDi(SUPABASE_URL)

/**
 * L'autorità della PUT è quella ammessa, con la porta assente o 443 come nella politica nativa di Release (§9). Uguaglianza sull'autorità
 * intera, mai per suffisso: `autoritaDi` include le credenziali e la porta, quindi `utente@host`, `host:8443` e `host.esempio.invalid` non passano,
 * e nemmeno l'autorità vuota di `https:///x` (che la forma del server lascia passare: secondario 6 di S1). Esportata per la prova, che le passa
 * il progetto di produzione senza dover rieseguire il modulo.
 */
export function indirizzoDellaPutAmmesso(indirizzo: string, autoritaAmmessa: string = AUTORITA_PUT_AMMESSA_CARICAMENTI): boolean {
  if (autoritaAmmessa === '') return false
  const autorita = autoritaDi(indirizzo)
  if (autorita === autoritaAmmessa) return true
  return !autoritaAmmessa.includes(':') && autorita === `${autoritaAmmessa}:443`
}

/**
 * L'URL della PUT: la forma che il server dichiara per un URL firmato (`https`, senza spazi, fino a 2048
 * caratteri: `schemaCoordinatePutVideo`), più il divieto di credenziali incorporate, più l'host (SOLO il progetto Supabase di questo sito:
 * in produzione, quello di produzione). Mai la forma Debug: neanche il loopback del collaudo passa di qui (la prova del motore col server finto
 * salta il JS e chiama il plugin).
 */
const schemaUrlPut = schemaCoordinatePutVideo.shape.url
  .refine(senzaCredenziali, { message: 'indirizzo con credenziali incorporate' })
  .refine((indirizzo) => indirizzoDellaPutAmmesso(indirizzo), { message: 'la PUT va solo allo Storage del progetto Supabase del sito' })

/** Il `content-type` della PUT: quello che il server mette nell'intestazione. */
const schemaContentTypePut = schemaCoordinatePutVideo.shape.intestazioni.shape['content-type']

/** L'indirizzo di rinnovo o di registro (`https`, o la forma Debug). */
const schemaUrlApplicazione = z
  .string()
  .min(1)
  .max(2048)
  .refine(indirizzoApplicazioneAmmesso, { message: 'indirizzo né https né loopback di Debug' })

/* ────────────────────────────────────────────────────────────────────────────
 * LE RISPOSTE DEL PONTE (si rileggono sempre con questi schemi)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `info()`: protocollo, piattaforma, motore. Il protocollo è un intero qualunque: che sia QUELLO
 * (`PROTOCOLLO_CARICAMENTI`) lo decide l'involucro, che deve poter dire «protocollo 2» invece di «risposta illeggibile».
 * La coppia piattaforma/motore invece deve esistere (`MOTORI_PER_PIATTAFORMA`): finisce nel log di disponibilità.
 */
export const schemaInfoCaricamenti = z
  .object({
    protocollo: z.number().int().min(1),
    piattaforma: z.enum(PIATTAFORME_CARICAMENTI),
    motore: z.enum(MOTORI_CARICAMENTI),
  })
  .refine((info) => (MOTORI_PER_PIATTAFORMA[info.piattaforma] as readonly string[]).includes(info.motore), {
    message: 'motore incompatibile con la piattaforma',
    path: ['motore'],
  })
export type InfoCaricamenti = z.infer<typeof schemaInfoCaricamenti>

/** Una foto scelta: già ridotta dal nativo (≤ `LATO_MASSIMO_FOTO`, senza EXIF né GPS), in attesa di `leggiFoto`. */
export const schemaElementoFoto = z.object({
  id: schemaIdElemento,
  tipo: z.literal('foto'),
  nome: schemaNome,
  larghezza: schemaLatoFoto,
  altezza: schemaLatoFoto,
  byte: schemaByteFoto,
})

/**
 * Un video scelto: copiato nella cartella persistente, con lo `sha256` dei byte che partiranno, la durata (`null` se il
 * sistema non la sa dire: la misura vera la fa il probe del server) e la miniatura (`null` se non si è potuta fare).
 * Tutto ciò che il server pretende dal file dichiarato (`byte`, `mime`, `durataSecondi`, `nome`) è già qui nella sua forma.
 */
export const schemaElementoVideo = z.object({
  id: schemaIdElemento,
  tipo: z.literal('video'),
  nome: schemaNome,
  byte: schemaByteVideo,
  mime: schemaMimeVideo,
  durataSecondi: schemaDurataVideo.nullable(),
  miniatura: schemaMiniatura.nullable(),
  sha256: schemaSha256,
})

/** Un elemento che non entra: il motivo (`MOTIVI_RIFIUTO`) lo traduce il JS, il nome si mostra e non si logga. */
export const schemaElementoRifiutato = z.object({
  id: schemaIdElemento,
  tipo: z.literal('rifiutato'),
  nome: schemaNome,
  origine: z.enum(['foto', 'video', 'altro']),
  motivo: z.enum(MOTIVI_RIFIUTO),
})

export const schemaElementoScelto = z.discriminatedUnion('tipo', [
  schemaElementoFoto,
  schemaElementoVideo,
  schemaElementoRifiutato,
])
export type ElementoScelto = z.infer<typeof schemaElementoScelto>
export type ElementoFotoScelta = Extract<ElementoScelto, { tipo: 'foto' }>
export type ElementoVideoScelto = Extract<ElementoScelto, { tipo: 'video' }>
export type ElementoRifiutato = Extract<ElementoScelto, { tipo: 'rifiutato' }>

/**
 * `scegliMedia()`: gli elementi, oppure `annullato`. Un annullamento non porta elementi: il nativo cancella le copie
 * parziali, e un elemento consegnato insieme a `annullato: true` sarebbe una copia che nessuno scarterà mai.
 */
export const schemaEsitoScelta = z
  .object({
    annullato: z.boolean(),
    elementi: z.array(schemaElementoScelto),
  })
  .refine((esito) => !esito.annullato || esito.elementi.length === 0, {
    message: 'una scelta annullata non porta elementi',
    path: ['elementi'],
  })
export type EsitoScelta = z.infer<typeof schemaEsitoScelta>

export const schemaEsitoAnnullaScelta = z.object({ annullata: z.boolean() })
export type EsitoAnnullaScelta = z.infer<typeof schemaEsitoAnnullaScelta>

/**
 * I byte che un base64 con padding rappresenta: tre quarti della lunghezza, meno i caratteri di padding. Se la lunghezza
 * non è un multiplo di quattro il risultato non è un intero e non coincide mai con un peso: una stringa troncata non passa.
 */
function byteDiUnBase64(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

/**
 * `leggiFoto()`: la foto ridotta in base64, che il JS trasforma in un `File`. I byte dichiarati devono essere ESATTAMENTE
 * quelli che il base64 rappresenta: una stringa troncata dal ponte, o un `byte` sbagliato, sarebbe una foto corrotta nella
 * galleria di un bambino, e `File.size` direbbe una cosa diversa da ciò che il nativo ha misurato.
 */
export const schemaFotoLetta = z
  .object({
    base64: z.string().min(4).regex(FORMA_BASE64, 'base64 senza spazi né a capo'),
    mime: z.literal('image/jpeg'),
    byte: schemaByteFoto,
    larghezza: schemaLatoFoto,
    altezza: schemaLatoFoto,
  })
  .refine((foto) => byteDiUnBase64(foto.base64) === foto.byte, {
    message: 'i byte dichiarati non sono quelli che il base64 rappresenta',
    path: ['byte'],
  })
export type FotoLetta = z.infer<typeof schemaFotoLetta>

export const schemaEsitoScartaScelti = z.object({ eliminati: schemaContatore })
export type EsitoScartaScelti = z.infer<typeof schemaEsitoScartaScelti>

/**
 * Una voce della coda nativa, com'è adesso. `nome` è solo per lo schermo (mai in un log); `codice` dice il perché di
 * un'attesa, di una pausa o di un esito (`null` finché non c'è niente da dire). Le date sono quelle del nativo.
 */
export const schemaCaricamentoNativo = z.object({
  jobId: schemaUuid,
  intentId: schemaUuid,
  utenteId: schemaUuid,
  scuolaId: schemaUuid,
  nome: schemaNome,
  mime: schemaMimeVideo,
  stato: z.enum(STATI_NATIVI),
  byteInviati: schemaByteInviati,
  byteTotali: schemaByteVideo,
  tentativi: schemaContatore,
  rinnovi: schemaContatore,
  codice: z.enum(CODICI_NATIVI).nullable(),
  creatoIl: schemaDataOra,
  aggiornatoIl: schemaDataOra,
})
export type CaricamentoNativo = z.infer<typeof schemaCaricamentoNativo>

export const schemaEsitoElenco = z.object({ caricamenti: z.array(schemaCaricamentoNativo) })
export type EsitoElenco = z.infer<typeof schemaEsitoElenco>

export const schemaEsitoAnnulla = z.object({ annullato: z.boolean() })
export type EsitoAnnulla = z.infer<typeof schemaEsitoAnnulla>

export const schemaEsitoDimentica = z.object({ dimenticati: schemaContatore })
export type EsitoDimentica = z.infer<typeof schemaEsitoDimentica>

/**
 * L'evento `preparazione`: quanti elementi sono pronti su quanti, e i byte copiati (il totale è `null` quando il
 * selettore non lo sa dire in anticipo).
 */
export const schemaEventoPreparazione = z.object({
  fatti: schemaContatore,
  totali: schemaContatore,
  byteCopiati: schemaContatore,
  byteTotali: schemaContatore.nullable(),
})
export type EventoPreparazione = z.infer<typeof schemaEventoPreparazione>

/* ────────────────────────────────────────────────────────────────────────────
 * LE RICHIESTE VERSO IL PONTE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Le opzioni di `scegliMedia()`. I limiti li passa il JS e il nativo non li riscrive: ognuno è compreso fra 1 e il suo
 * tetto di `limiti.ts` (o di questo modulo), così un numero sbagliato non può né allargare la scelta oltre il contratto
 * né, con uno zero, spalancarla (PHPicker legge `selectionLimit = 0` come «senza limite»). Il tetto di elementi per scelta
 * lo applica il chiamante (testata).
 */
export const schemaOpzioniScegliMedia = z.object({
  sorgente: z.enum(SORGENTI_SCELTA),
  massimoElementi: z.number().int().min(1),
  latoMassimoFoto: z.number().int().min(1).max(LATO_MASSIMO_FOTO),
  qualitaFoto: z.number().gt(0).max(1),
  byteMassimiVideo: z.number().int().min(1).max(MAX_VIDEO_INPUT_BYTES),
  durataMassimaVideoSecondi: z.number().int().min(1).max(MAX_VIDEO_DURATION_SECONDS),
})
export type OpzioniScegliMedia = z.infer<typeof schemaOpzioniScegliMedia>

/**
 * Le opzioni complete di una scelta, coi limiti presi dalle loro fonti. È l'unico posto in cui peso, durata, lato e
 * qualità diventano i campi di una chiamata: chi apre un selettore passa da qui e dice solo da dove e quanti posti restano.
 */
export function opzioniScegliMedia(sorgente: SorgenteScelta, massimoElementi: number): OpzioniScegliMedia {
  return {
    sorgente,
    massimoElementi,
    latoMassimoFoto: LATO_MASSIMO_FOTO,
    qualitaFoto: QUALITA_FOTO,
    byteMassimiVideo: MAX_VIDEO_INPUT_BYTES,
    durataMassimaVideoSecondi: MAX_VIDEO_DURATION_SECONDS,
  }
}

export const schemaRichiestaLeggiFoto = z.object({ id: schemaIdElemento })
export type RichiestaLeggiFoto = z.infer<typeof schemaRichiestaLeggiFoto>

export const schemaRichiestaScartaScelti = z.object({ ids: z.array(schemaIdElemento) })
export type RichiestaScartaScelti = z.infer<typeof schemaRichiestaScartaScelti>

export const schemaRichiestaElenco = z.object({ utenteId: schemaUuid })
export type RichiestaElenco = z.infer<typeof schemaRichiestaElenco>

export const schemaRichiestaAnnulla = z.object({ jobId: schemaUuid })
export type RichiestaAnnulla = z.infer<typeof schemaRichiestaAnnulla>

export const schemaRichiestaDimentica = z.object({ jobIds: z.array(schemaUuid) })
export type RichiestaDimentica = z.infer<typeof schemaRichiestaDimentica>

/**
 * I testi delle notifiche native (§2.2): li passa il JS a ogni `accodaVideo`, dai cataloghi it/en, e il nativo li
 * conserva nella coda (ha un ripiego italiano cablato). Senza nomi né miniature: la notifica di sistema è visibile
 * a telefono bloccato.
 */
export const schemaTestiNotificheCaricamento = z.object({
  titolo: schemaTestoNotifica,
  invio: schemaTestoNotifica,
  attesaRete: schemaTestoNotifica,
  pausa: schemaTestoNotifica,
})
export type TestiNotificheCaricamento = z.infer<typeof schemaTestiNotificheCaricamento>

/**
 * `accodaVideo()`: prende in carico un video preparato. Ogni pezzo viene dal contratto della PR 2:
 *  · `caricamento` è la `put` di `CoordinatePutVideo` (`url`, e `contentType` dalle sue intestazioni, che oggi sono la
 *    sola `content-type`) più `expires_at` del job (`scadeIl`, `null` se il server non lo dice);
 *  · `rinnovo.token` e `rinnovo.scadeIl` sono quelli di `schemaRinnovoVideo` (la scadenza del TOKEN, 48 ore). Il
 *    rinnovo NON porta un URL: lo compone il JS dall'origine della pagina (`${origin}/api/video-uploads/rinnovo`, §7.4);
 *  · `registro.url` è `${origin}/api/logs`.
 * Gli indirizzi di rinnovo e di registro hanno la forma Debug (testata); quello della PUT no.
 */
export const schemaRichiestaAccodaVideo = z.object({
  idElemento: schemaIdElemento,
  sha256: schemaSha256,
  byteAttesi: schemaByteVideo,
  jobId: schemaUuid,
  intentId: schemaUuid,
  utenteId: schemaUuid,
  scuolaId: schemaUuid,
  caricamento: z.object({
    url: schemaUrlPut,
    contentType: schemaContentTypePut,
    scadeIl: schemaDataOra.nullable(),
  }),
  rinnovo: z.object({
    url: schemaUrlApplicazione,
    token: schemaTokenRinnovoVideo,
    scadeIl: schemaDataOra,
  }),
  registro: z.object({ url: schemaUrlApplicazione }),
  testi: schemaTestiNotificheCaricamento,
})
export type RichiestaAccodaVideo = z.infer<typeof schemaRichiestaAccodaVideo>

/* ────────────────────────────────────────────────────────────────────────────
 * LA TABELLA DEI METODI, E L'INTERFACCIA DEL PLUGIN
 * ──────────────────────────────────────────────────────────────────────────── */

/** `info()` e `annullaScelta()` non hanno argomenti. */
const schemaNessunArgomento = z.undefined()

/**
 * Per ogni metodo, lo schema degli argomenti e quello della risposta. Il tipo `Record<Metodo, …>` obbliga ad avere una
 * riga per OGNI voce di `METODI_PLUGIN_CARICAMENTI` (un metodo nuovo senza schemi non compila) e un test lo ripete sui
 * valori. È ciò che permette all'involucro di rileggere ogni risposta senza dimenticarne una.
 */
export const SCHEMI_METODI_CARICAMENTI = {
  info: { richiesta: schemaNessunArgomento, risposta: schemaInfoCaricamenti },
  scegliMedia: { richiesta: schemaOpzioniScegliMedia, risposta: schemaEsitoScelta },
  annullaScelta: { richiesta: schemaNessunArgomento, risposta: schemaEsitoAnnullaScelta },
  leggiFoto: { richiesta: schemaRichiestaLeggiFoto, risposta: schemaFotoLetta },
  scartaScelti: { richiesta: schemaRichiestaScartaScelti, risposta: schemaEsitoScartaScelti },
  accodaVideo: { richiesta: schemaRichiestaAccodaVideo, risposta: schemaCaricamentoNativo },
  elenco: { richiesta: schemaRichiestaElenco, risposta: schemaEsitoElenco },
  annulla: { richiesta: schemaRichiestaAnnulla, risposta: schemaEsitoAnnulla },
  dimentica: { richiesta: schemaRichiestaDimentica, risposta: schemaEsitoDimentica },
} as const satisfies Record<MetodoPluginCaricamenti, { richiesta: z.ZodType; risposta: z.ZodType }>

/**
 * Il plugin com'è visto dal JS. Una volta registrato (`registerPlugin`, dentro una funzione non `async`: lock
 * `plugin-capacitor-mai-risolto-da-promise`) ogni chiamata passa dalle funzioni dell'involucro, che rileggono la risposta
 * con `SCHEMI_METODI_CARICAMENTI`: i valori che questa interfaccia promette sono quelli che gli schemi hanno già
 * lasciato passare. `addListener` è del plugin base di Capacitor e non è un metodo nostro (`METODI_PLUGIN_CARICAMENTI`).
 */
export interface KidvilleCaricamentiPlugin {
  info(): Promise<InfoCaricamenti>
  scegliMedia(opzioni: OpzioniScegliMedia): Promise<EsitoScelta>
  annullaScelta(): Promise<EsitoAnnullaScelta>
  leggiFoto(richiesta: RichiestaLeggiFoto): Promise<FotoLetta>
  scartaScelti(richiesta: RichiestaScartaScelti): Promise<EsitoScartaScelti>
  accodaVideo(richiesta: RichiestaAccodaVideo): Promise<CaricamentoNativo>
  elenco(richiesta: RichiestaElenco): Promise<EsitoElenco>
  annulla(richiesta: RichiestaAnnulla): Promise<EsitoAnnulla>
  dimentica(richiesta: RichiestaDimentica): Promise<EsitoDimentica>
  addListener(
    evento: 'preparazione',
    ascoltatore: (evento: EventoPreparazione) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    evento: 'caricamento',
    ascoltatore: (evento: CaricamentoNativo) => void,
  ): Promise<PluginListenerHandle>
}
