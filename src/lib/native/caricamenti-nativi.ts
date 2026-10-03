import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { z } from 'zod'
import { conTettoDiTempo } from '@/lib/auth/errore-accesso'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { isNativeApp } from '@/lib/push/native-register'
import { confrontaVersioni } from '@/lib/native/aggiornamento-app'
import {
  CODICI_RIFIUTO_PONTE,
  METODI_PLUGIN_CARICAMENTI,
  NOME_PLUGIN_CARICAMENTI,
  PROTOCOLLO_CARICAMENTI,
  SCHEMI_METODI_CARICAMENTI,
  schemaCaricamentoNativo,
  schemaEventoPreparazione,
  schemaInfoCaricamenti,
  type CaricamentoNativo,
  type EsitoAnnulla,
  type EsitoAnnullaScelta,
  type EsitoDimentica,
  type EsitoElenco,
  type EsitoScartaScelti,
  type EsitoScelta,
  type EventoPreparazione,
  type FotoLetta,
  type InfoCaricamenti,
  type KidvilleCaricamentiPlugin,
  type OpzioniScegliMedia,
  type RichiestaAccodaVideo,
  type RichiestaAnnulla,
  type RichiestaDimentica,
  type RichiestaElenco,
  type RichiestaLeggiFoto,
  type RichiestaScartaScelti,
} from '@/lib/native/caricamenti-nativi-tipi'

/**
 * L'INVOLUCRO JS DEL PLUGIN `KidvilleCaricamenti` — e la RILEVAZIONE di chi ce l'ha (app 1.2, spec
 * 2026-10-03, §7.1).
 *
 * Il plugin è NOSTRO e locale all'app (Swift su iOS, Java su Android): c'è solo nei binari dalla 1.2
 * in poi. Sul web e nelle app 1.0/1.1 NON C'È, ed è il caso NORMALE, non un guasto: lì la Galleria
 * resta com'è (selettore del browser e TUS dalla pagina). Questo modulo risponde a due domande, e a
 * nient'altro:
 *
 *  1. `caricamentiNativiDisponibili()` — questo telefono ha il plugin, completo e del protocollo
 *     giusto, e l'interruttore d'emergenza è acceso? Una risposta per sessione, messa in memoria.
 *  2. le chiamate tipizzate (`scegliMedia`, `accodaVideo`, …) — ogni richiesta e ogni risposta del
 *     ponte si RILEGGONO con gli schemi zod di `caricamenti-nativi-tipi.ts` (il ponte è un confine come
 *     una route: un oggetto fuori forma non deve diventare una PUT), e ogni rifiuto si traduce in un
 *     CODICE dell'elenco chiuso, mai nel suo messaggio (il messaggio di un errore di sistema può
 *     contenere il nome di un file: un file di bambini).
 *
 * ─── IL PLUGIN È UN PROXY, E UNA PROMISE NON DEVE MAI RISOLVERSI CON LUI ──────────────────────
 * `registerPlugin` di `@capacitor/core` restituisce un `Proxy` che a OGNI proprietà risponde con un
 * metodo del bridge, `then` compreso. Una promise che si risolve con il plugin legge `.then`, lo
 * chiama, il bridge rifiuta con «X.then() is not implemented» e la promise di partenza resta appesa
 * per sempre: è il guasto che il 2026-09-25 ha rotto per cinque ore la push nativa di tutti (#166 →
 * #168, memoria `plugin_capacitor_mai_risolto_da_promise`). Qui il plugin:
 *  - si crea UNA volta, pigro, dietro `plugin()`, una funzione NON `async` (`registerPlugin` avvisa
 *    se lo stesso nome si registra due volte, e un modulo client si valuta anche sul server);
 *  - non esce MAI da una funzione `async`, non è mai il tipo di una `Promise<…>`, non si `await`a:
 *    si chiama un suo metodo e si tiene il RISULTATO (lock
 *    `__tests__/architecture/plugin-capacitor-mai-risolto-da-promise.test.ts`, dove
 *    `'KidvilleCaricamenti'` sta in `PLUGIN_NOTI`);
 *  - nei test è un finto fedele a quel Proxy, che risponde anche a `then`.
 *
 * ─── COSA SI SCRIVE NEI LOG, E COSA NO ────────────────────────────────────────────────────────
 * Tutto sotto l'evento `caricamento-nativo` (`client:caricamento-nativo`, la stessa colonna del
 * nativo), solo `warn`/`error` perché `/api/logs` non accetta `info`:
 *  - `caricamenti-nativi-disponibili: <piattaforma> <versione> <motore>` (warn): il SUCCESSO, una
 *    volta per sessione. La versione sta nel MESSAGGIO e non in un campo (lezione della #175:
 *    l'impronta di `app_log` non vede piattaforma né `campi`);
 *  - `caricamenti-nativi-incompleti: <motivo>` (error): un difetto di BUILD — un binario ≥ 1.2 senza il
 *    plugin, oppure col plugin ma con metodi che mancano, con `info()` che non risponde o fuori forma,
 *    o con un protocollo diverso (quando questa riga tace lo dice `segnalaIncompleto`);
 *  - `caricamenti-nativi-spenti` (warn): l'interruttore è spento su un binario che il plugin ce
 *    l'ha — spegnerlo è una scelta, e si deve vedere;
 *  - `evento-nativo-fuori-forma: <evento>` (warn): il nativo ha mandato un evento che gli schemi non
 *    riconoscono (un patto rotto fra le due metà), una volta per evento e per sessione.
 * L'ASSENZA del plugin su 1.0/1.1 NON scrive niente: è il caso normale di quasi tutti i telefoni.
 * Mai un nome di file, un percorso, un URL, un token o un hash: solo slug costanti, codici
 * dell'elenco chiuso e numeri. I rifiuti delle chiamate tipizzate NON si loggano qui: escono come
 * `ErroreCaricamentiNativi` col suo `codice`, e li scrive chi chiama, che sa di quale job parla.
 */

/** Oltre questo tempo `info()` (e `App.getInfo()`) senza risposta vale «il plugin non risponde». */
export const TIMEOUT_INFO_MS = 3000

/** La prima versione del binario che porta il plugin. */
const VERSIONE_CON_PLUGIN = '1.2'

/** La versione che si scrive in un log: solo numeri e punti, corta. Il resto non entra mai. */
const FORMA_VERSIONE = /^\d{1,4}(\.\d{1,4}){0,3}$/

/* ════════════════════════════════════════════════════════════════════════════
 * Gli errori: un elenco CHIUSO di codici, mai il messaggio del ponte
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * I codici che nascono QUI e non nel nativo: il plugin non c'è (web, 1.0/1.1, interruttore spento,
 * binario incompleto), la risposta del ponte è fuori forma, o il rifiuto non si riconosce.
 */
export const CODICI_INVOLUCRO = ['NON_DISPONIBILE', 'RISPOSTA_NON_VALIDA', 'SCONOSCIUTO'] as const

/** L'elenco chiuso di ciò che un rifiuto di queste funzioni può essere: i sette del nativo più i tre dell'involucro. */
export const CODICI_PONTE = [...CODICI_RIFIUTO_PONTE, ...CODICI_INVOLUCRO] as const
export type CodicePonte = (typeof CODICI_PONTE)[number]

/**
 * L'errore con cui escono le chiamate tipizzate. `message` è il CODICE, e basta: chi lo logga scrive
 * `e.codice` (o `nomeErrore(e)`), mai testo preso dal ponte.
 */
export class ErroreCaricamentiNativi extends Error {
  readonly codice: CodicePonte
  constructor(codice: CodicePonte) {
    super(codice)
    this.name = 'ErroreCaricamentiNativi'
    this.codice = codice
  }
}

/**
 * Il rifiuto di una chiamata al ponte, ridotto a un codice dell'elenco chiuso. Si legge SOLO `code`
 * (una stringa che mettiamo noi nel nativo); `message` non si tocca: su un errore di sistema
 * riecheggia percorsi e nomi di file. Un `code` fuori elenco, o un rifiuto che non è un oggetto, vale
 * `SCONOSCIUTO`. `UNIMPLEMENTED`/`UNAVAILABLE` sono i codici di Capacitor stesso per «questo binario
 * non ha il metodo»: valgono `NON_DISPONIBILE`.
 */
export function codiceDelPonte(e: unknown): CodicePonte {
  if (e instanceof ErroreCaricamentiNativi) return e.codice
  let codice: unknown
  try {
    codice = (e as { code?: unknown } | null | undefined)?.code
  } catch {
    // Un getter ostile non è un codice: `SCONOSCIUTO` è un esito che chi chiama scrive nel log.
    return 'SCONOSCIUTO'
  }
  if (codice === 'UNIMPLEMENTED' || codice === 'UNAVAILABLE') return 'NON_DISPONIBILE'
  return (CODICI_PONTE as readonly unknown[]).includes(codice) ? (codice as CodicePonte) : 'SCONOSCIUTO'
}

/* ════════════════════════════════════════════════════════════════════════════
 * Il plugin, una volta, dietro una funzione non async
 * ════════════════════════════════════════════════════════════════════════════ */

const involucro: { plugin: KidvilleCaricamentiPlugin | null } = { plugin: null }

function plugin(): KidvilleCaricamentiPlugin {
  let proxy = involucro.plugin
  if (!proxy) {
    proxy = registerPlugin<KidvilleCaricamentiPlugin>(NOME_PLUGIN_CARICAMENTI)
    involucro.plugin = proxy
  }
  return proxy
}

/* ════════════════════════════════════════════════════════════════════════════
 * La rilevazione
 * ════════════════════════════════════════════════════════════════════════════ */

/** I motivi per cui un binario che DOVREBBE avere il plugin non lo ha, o non completo. */
type MotivoIncompleto =
  | 'plugin-assente'
  | 'intestazione-illeggibile'
  | 'metodi-mancanti'
  | 'info-timeout'
  | 'info-rifiutata'
  | 'info-fuori-forma'
  | 'protocollo-diverso'

type CampiRiga = Record<string, number | string | boolean>

/**
 * L'interruttore d'emergenza (spec §2.2): assente, o qualunque valore diverso da `0`, = acceso;
 * `0` = spento. Si legge come `process.env.NEXT_PUBLIC_CARICAMENTI_NATIVI` LETTERALE, e non per nome
 * in una variabile: Next cuce nel bundle solo l'espressione scritta per intero, e un accesso
 * dinamico funzionerebbe nei test e non sul telefono. Il `trim` è per una variabile incollata su
 * Vercel con uno spazio o un a-capo in coda: un interruttore che non scatta per uno spazio è un
 * interruttore che non c'è.
 */
function interruttoreSpento(): boolean {
  return process.env.NEXT_PUBLIC_CARICAMENTI_NATIVI?.trim() === '0'
}

/**
 * La versione del binario (`App.getInfo().version`), o `null` se non si legge. Non lancia mai.
 *
 * Serve a due cose: dire QUALE versione ha il telefono nella riga di successo, e distinguere un
 * binario ≥ 1.2 senza plugin (un difetto di build) da uno 1.0/1.1 (il caso normale). Un `null` qui
 * non si scrive nel log: `native-shell.ts` («versione dell'app illeggibile») e il pop-up
 * (`avviso-aggiorna-app-versione-illeggibile`) già lo fanno a ogni sessione, e ripeterlo da qui sulle
 * 1.0/1.1 sarebbe rumore.
 */
async function versioneDelBinario(): Promise<string | null> {
  try {
    if (!Capacitor.isPluginAvailable('App')) return null
    const { App } = await import('@capacitor/app')
    // Lo stesso tetto del repo di `aggiornamento-app.ts` (lock `logging-tetto`): il bridge non accetta
    // un `AbortSignal`, quindi la chiamata non si annulla, si ABBANDONA.
    const esito = await conTettoDiTempo(App.getInfo(), TIMEOUT_INFO_MS)
    if (esito.scaduto) return null
    const versione = esito.valore.version
    return typeof versione === 'string' && FORMA_VERSIONE.test(versione) ? versione : null
  } catch {
    // Vedi sopra: l'esito è `null`, che la riga di chi chiama dichiara («n-d») o tace.
    return null
  }
}

/** `true` se la versione è nota ed è ≥ 1.2, `false` se è nota ed è precedente, `null` se non si sa. */
function versioneConPlugin(versione: string | null): boolean | null {
  if (versione === null) return null
  const confronto = confrontaVersioni(versione, VERSIONE_CON_PLUGIN)
  return confronto === null ? null : confronto >= 0
}

/**
 * Un difetto del binario: o il plugin NON c'è su un binario che dovrebbe averlo, o c'è ma non è completo.
 * Restituisce sempre `null`: è la risposta di chi chiama. Due casi, e non sono simmetrici:
 *  - plugin ASSENTE (`pluginPresente: false`): è un difetto solo su un binario di versione NOTA e ≥ 1.2.
 *    Sulle 1.0 e 1.1 l'assenza è la normalità e non scrive niente, e con la versione illeggibile nel
 *    dubbio si tace (l'assenza è quasi sempre la normalità, e l'illeggibilità l'hanno già scritta
 *    `native-shell.ts` e il pop-up);
 *  - plugin PRESENTE ma rotto (`pluginPresente: true`): il plugin ce l'hanno solo i nostri binari, quindi
 *    non c'è niente da distinguere e si scrive anche con la versione illeggibile. Tace solo se la
 *    versione dice «1.0/1.1», che in un binario rilasciato non può succedere.
 * La versione arriva già in lettura (`versioneDelBinario()` non lancia mai): chi la avvia la fa correre
 * accanto al resto della rilevazione, perché la Galleria aspetta la risposta per disegnare l'area di
 * scelta e due attese in fila raddoppierebbero il caso peggiore.
 */
async function segnalaIncompleto(
  motivo: MotivoIncompleto,
  versione: Promise<string | null>,
  pluginPresente: boolean,
  campi?: CampiRiga,
): Promise<null> {
  const conPlugin = versioneConPlugin(await versione)
  if (pluginPresente ? conPlugin === false : conPlugin !== true) return null
  logClient({
    livello: 'error',
    evento: 'caricamento-nativo',
    messaggio: `caricamenti-nativi-incompleti: ${motivo}`,
    ...(campi ? { campi } : {}),
  })
  return null
}

/** La sola parte dell'intestazione che serve: i nomi dei metodi. Il resto (`rtype`) non ci riguarda. */
const schemaIntestazione = z.object({ methods: z.array(z.object({ name: z.string() })) })

/**
 * I metodi che il nativo DICHIARA per il nostro plugin, da `Capacitor.PluginHeaders`: l'elenco che il
 * bridge costruisce da `pluginMethods` (iOS) e dai `@PluginMethod` (Android). È un'API interna di
 * `@capacitor/core` (`definitions-internal.d.ts`), quindi si legge con difesa: ogni sorpresa vale
 * `null`, che chi chiama scrive come «incompleto». Si guarda solo l'intestazione del NOSTRO plugin:
 * quella degli altri non è affare nostro.
 */
function metodiDichiarati(): Set<string> | null {
  try {
    const intestazioni = (Capacitor as unknown as { PluginHeaders?: unknown }).PluginHeaders
    if (!Array.isArray(intestazioni)) return null
    const nostra = intestazioni.find(
      (voce: unknown) => (voce as { name?: unknown } | null | undefined)?.name === NOME_PLUGIN_CARICAMENTI,
    )
    const esito = schemaIntestazione.safeParse(nostra)
    return esito.success ? new Set(esito.data.methods.map((metodo) => metodo.name)) : null
  } catch {
    // Un getter che lancia vale «illeggibile»: chi chiama lo scrive come `intestazione-illeggibile`.
    return null
  }
}

type LetturaInfo = { ok: true; info: InfoCaricamenti } | { ok: false; motivo: MotivoIncompleto; campi?: CampiRiga }

/** `info()` sotto il tetto, riletta con zod, con il protocollo che il JS parla. */
async function leggiInfo(): Promise<LetturaInfo> {
  let grezza: unknown
  try {
    const esito = await conTettoDiTempo(plugin().info(), TIMEOUT_INFO_MS)
    if (esito.scaduto) return { ok: false, motivo: 'info-timeout' }
    grezza = esito.valore
  } catch (e) {
    return { ok: false, motivo: 'info-rifiutata', campi: { error_code: codiceDelPonte(e) } }
  }
  const riletta = schemaInfoCaricamenti.safeParse(grezza)
  if (!riletta.success) return { ok: false, motivo: 'info-fuori-forma' }
  if (riletta.data.protocollo !== PROTOCOLLO_CARICAMENTI) {
    return { ok: false, motivo: 'protocollo-diverso', campi: { protocollo: riletta.data.protocollo } }
  }
  return { ok: true, info: riletta.data }
}

async function rileva(): Promise<InfoCaricamenti | null> {
  try {
    // 1. Web, server, prerender: niente bridge.
    if (!isNativeApp()) return null
    // 2. Il bridge conosce il plugin? Sulle 1.0/1.1 NO, ed è il caso normale (nessun log).
    if (!Capacitor.isPluginAvailable(NOME_PLUGIN_CARICAMENTI)) {
      return await segnalaIncompleto('plugin-assente', versioneDelBinario(), false)
    }
    // 3. L'interruttore. Dopo il punto 2 di proposito: qui il plugin c'è, e spegnerlo è una scelta che
    //    si deve vedere; sulle 1.0/1.1 non c'è niente da spegnere e non si scrive niente.
    if (interruttoreSpento()) {
      logClient({ livello: 'warn', evento: 'caricamento-nativo', messaggio: 'caricamenti-nativi-spenti' })
      return null
    }
    // La versione si legge ADESSO e corre accanto a `info()`: serve a ogni uscita da qui in poi (la riga di
    // successo e il filtro dei difetti), e l'attesa massima resta una, non due in fila.
    const versione = versioneDelBinario()
    // 4. Il nativo dichiara TUTTI i metodi che il JS userà.
    const dichiarati = metodiDichiarati()
    if (dichiarati === null) return await segnalaIncompleto('intestazione-illeggibile', versione, true)
    const mancanti = METODI_PLUGIN_CARICAMENTI.filter((metodo) => !dichiarati.has(metodo))
    if (mancanti.length > 0) {
      return await segnalaIncompleto('metodi-mancanti', versione, true, { metodi_mancanti: mancanti.length })
    }
    // 5. `info()` risponde in tempo, con la forma giusta e il protocollo giusto.
    const lettura = await leggiInfo()
    if (!lettura.ok) return await segnalaIncompleto(lettura.motivo, versione, true, lettura.campi)

    logClient({
      livello: 'warn',
      evento: 'caricamento-nativo',
      messaggio: `caricamenti-nativi-disponibili: ${lettura.info.piattaforma} ${(await versione) ?? 'n-d'} ${lettura.info.motore}`,
    })
    return lettura.info
  } catch (e) {
    // Un'eccezione che nessun ramo sopra ha previsto è un difetto NOSTRO: si scrive sempre, senza il
    // filtro della versione, e la Galleria ripiega sul TUS come se il plugin non ci fosse.
    logClient({
      livello: 'error',
      evento: 'caricamento-nativo',
      messaggio: 'caricamenti-nativi-incompleti: errore-imprevisto',
      campi: { error_code: nomeErrore(e) },
    })
    return null
  }
}

let rilevazione: Promise<InfoCaricamenti | null> | null = null

/**
 * Questo telefono ha il plugin dei caricamenti nativi, completo, del protocollo giusto, e
 * l'interruttore è acceso? Le info del plugin, oppure `null`. UNA rilevazione per sessione, messa in
 * memoria: chiamarla di nuovo restituisce la stessa promise, e le righe di log escono una volta sola.
 * Non lancia mai, e non aspetta più di `TIMEOUT_INFO_MS` (`info()` e la lettura della versione corrono
 * insieme): la Galleria non disegna l'area di scelta finché non risponde.
 */
export function caricamentiNativiDisponibili(): Promise<InfoCaricamenti | null> {
  if (!rilevazione) rilevazione = rileva()
  return rilevazione
}

/* ════════════════════════════════════════════════════════════════════════════
 * Le chiamate tipizzate
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Una chiamata al ponte, in quattro passi che non si saltano:
 *  1. il plugin deve esserci (`caricamentiNativiDisponibili`): sul web, sulle 1.0/1.1, a interruttore
 *     spento o a binario incompleto la risposta è `NON_DISPONIBILE` e il plugin non si registra nemmeno;
 *  2. la RICHIESTA si rilegge con il suo schema: ciò che non torna è `PARAMETRI_NON_VALIDI` (lo stesso
 *     codice del nativo) e non parte; al ponte va la forma RILETTA, con i soli campi dichiarati;
 *  3. un rifiuto del ponte diventa un codice dell'elenco chiuso (`codiceDelPonte`);
 *  4. la RISPOSTA si rilegge con il suo schema: ciò che non torna è `RISPOSTA_NON_VALIDA`, mai un
 *     oggetto a metà passato a chi lo userebbe per spedire un video.
 *
 * `invia` riceve il plugin e ne chiama UN metodo: il plugin non esce da qui, esce il risultato.
 */
async function chiama<Q, R>(
  schemi: { richiesta: z.ZodType<Q, unknown>; risposta: z.ZodType<R, unknown> },
  richiesta: unknown,
  invia: (ponte: KidvilleCaricamentiPlugin, valida: Q) => Promise<unknown>,
): Promise<R> {
  if ((await caricamentiNativiDisponibili()) === null) throw new ErroreCaricamentiNativi('NON_DISPONIBILE')
  const valida = schemi.richiesta.safeParse(richiesta)
  if (!valida.success) throw new ErroreCaricamentiNativi('PARAMETRI_NON_VALIDI')
  let grezza: unknown
  try {
    grezza = await invia(plugin(), valida.data)
  } catch (e) {
    throw new ErroreCaricamentiNativi(codiceDelPonte(e))
  }
  const riletta = schemi.risposta.safeParse(grezza)
  if (!riletta.success) throw new ErroreCaricamentiNativi('RISPOSTA_NON_VALIDA')
  return riletta.data
}

/** Apre il selettore (galleria o «Scegli da File») e prepara gli elementi scelti prima di rispondere. */
export function scegliMedia(opzioni: OpzioniScegliMedia): Promise<EsitoScelta> {
  return chiama(SCHEMI_METODI_CARICAMENTI.scegliMedia, opzioni, (ponte, valide) => ponte.scegliMedia(valide))
}

/** Ferma la preparazione in corso: `scegliMedia` risolve con `annullato: true`. */
export function annullaScelta(): Promise<EsitoAnnullaScelta> {
  return chiama(SCHEMI_METODI_CARICAMENTI.annullaScelta, undefined, (ponte) => ponte.annullaScelta())
}

/** La foto preparata in base64: UNA lettura sola, il nativo la cancella. */
export function leggiFoto(richiesta: RichiestaLeggiFoto): Promise<FotoLetta> {
  return chiama(SCHEMI_METODI_CARICAMENTI.leggiFoto, richiesta, (ponte, valida) => ponte.leggiFoto(valida))
}

/** Cancella i preparati non inviati (anteprima tolta, «Annulla», smontaggio). */
export function scartaScelti(richiesta: RichiestaScartaScelti): Promise<EsitoScartaScelti> {
  return chiama(SCHEMI_METODI_CARICAMENTI.scartaScelti, richiesta, (ponte, valida) => ponte.scartaScelti(valida))
}

/** Prende in carico un video preparato (idempotente su `jobId`). */
export function accodaVideo(richiesta: RichiestaAccodaVideo): Promise<CaricamentoNativo> {
  return chiama(SCHEMI_METODI_CARICAMENTI.accodaVideo, richiesta, (ponte, valida) => ponte.accodaVideo(valida))
}

/** Le voci di QUELL'utente, per data di creazione. */
export function elenco(richiesta: RichiestaElenco): Promise<EsitoElenco> {
  return chiama(SCHEMI_METODI_CARICAMENTI.elenco, richiesta, (ponte, valida) => ponte.elenco(valida))
}

/** Ferma il trasferimento e cancella copia e segreti. Non ritira l'intento: lo fa il JS. */
export function annulla(richiesta: RichiestaAnnulla): Promise<EsitoAnnulla> {
  return chiama(SCHEMI_METODI_CARICAMENTI.annulla, richiesta, (ponte, valida) => ponte.annulla(valida))
}

/** Toglie dalla coda le voci terminali indicate; le altre le ignora. */
export function dimentica(richiesta: RichiestaDimentica): Promise<EsitoDimentica> {
  return chiama(SCHEMI_METODI_CARICAMENTI.dimentica, richiesta, (ponte, valida) => ponte.dimentica(valida))
}

/* ════════════════════════════════════════════════════════════════════════════
 * Gli eventi
 * ════════════════════════════════════════════════════════════════════════════ */

/** Un evento fuori forma si scrive UNA volta per nome e per sessione: i `caricamento` arrivano a raffica. */
const eventiFuoriFormaVisti = new Set<string>()

/**
 * Mette in ascolto `callback` su un evento del plugin. Il payload si RILEGGE con zod prima di arrivare
 * a `callback`: un evento fuori forma non le arriva (e lascia una riga `warn`), perché l'elenco
 * (`elenco`) resta la fonte di verità e si rilegge comunque al ritorno in primo piano. Restituisce la
 * funzione che toglie l'ascolto: chi si smonta PRIMA che la promise risponda la chiama appena arriva,
 * altrimenti l'ascolto resta vivo. Con `addListener` il bridge risolve con `{ remove }`, un oggetto
 * semplice che una promise attraversa senza problemi (non è il plugin).
 */
async function ascolta<T>(
  evento: string,
  schema: z.ZodType<T, unknown>,
  callback: (dati: T) => void,
  aggancia: (ponte: KidvilleCaricamentiPlugin, ascoltatore: (grezzo: unknown) => void) => Promise<PluginListenerHandle>,
): Promise<() => Promise<void>> {
  if ((await caricamentiNativiDisponibili()) === null) throw new ErroreCaricamentiNativi('NON_DISPONIBILE')
  let maniglia: PluginListenerHandle
  try {
    maniglia = await aggancia(plugin(), (grezzo) => {
      const riletto = schema.safeParse(grezzo)
      if (riletto.success) {
        callback(riletto.data)
        return
      }
      if (eventiFuoriFormaVisti.has(evento)) return
      eventiFuoriFormaVisti.add(evento)
      logClient({
        livello: 'warn',
        evento: 'caricamento-nativo',
        messaggio: `evento-nativo-fuori-forma: ${evento}`,
      })
    })
  } catch (e) {
    throw new ErroreCaricamentiNativi(codiceDelPonte(e))
  }
  return () => maniglia.remove()
}

/** L'avanzamento della preparazione: quanti elementi pronti su quanti, e i byte copiati. */
export function ascoltaPreparazione(callback: (evento: EventoPreparazione) => void): Promise<() => Promise<void>> {
  return ascolta('preparazione', schemaEventoPreparazione, callback, (ponte, ascoltatore) =>
    ponte.addListener('preparazione', ascoltatore),
  )
}

/** Ogni cambio di una voce della coda nativa. */
export function ascoltaCaricamenti(callback: (caricamento: CaricamentoNativo) => void): Promise<() => Promise<void>> {
  return ascolta('caricamento', schemaCaricamentoNativo, callback, (ponte, ascoltatore) =>
    ponte.addListener('caricamento', ascoltatore),
  )
}
