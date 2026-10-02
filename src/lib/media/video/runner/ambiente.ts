import { logEvento } from '@/lib/logging/logger'
import { sanificaMessaggio } from '@/lib/logging/serialize'

import { codaDiagnostica } from './diagnosi'

/**
 * L'AMBIENTE PRONTO — da dove nasce la MicroVM che converte, e che cosa si fa se lo snapshot non c'è.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PERCHÉ ESISTE (PR 2, spec §10.1–§10.2)
 *
 * Fino alla PR 1 ogni conversione apriva una MicroVM `node22` (Amazon Linux) VUOTA, e per prima cosa
 * scaricava dal nostro bucket i due `.gz` di FFmpeg (~134 MB), li verificava e li decomprimeva: una
 * decina di secondi e un download a ogni conversione, per ottenere sempre gli stessi due file.
 * Funziona, è provato in produzione, e dipende da un runtime (`node22`) che Vercel ha dichiarato
 * deprecato. Dalla PR 2 c'è un'altra strada: uno SNAPSHOT del Sandbox, costruito UNA volta
 * (`scripts/video-sandbox-ambiente.mjs`) da un'immagine `node:24` con `curl` e con i due binari già
 * in `/opt/kv-ffmpeg`. Una MicroVM nata da lì li ha già: li verifica e parte.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * I TRE MODI DI AVERE UN AMBIENTE, e come si chiamano nei log
 *
 *  · `snapshot` — la MicroVM nasce dallo snapshot e i binari, verificati con `sha256sum`, tornano.
 *  · `ripiego-vm` — nasce dallo snapshot ma i binari mancano o non tornano: si ripiega NELLA STESSA
 *    MicroVM con la provvista dal bucket (lo snapshot ha `curl`) e si GRIDA. Lo decide `esegui.ts`,
 *    che è quello che esegue i comandi.
 *  · `ripiego-runtime` — lo snapshot non c'è (variabile assente o non valida, snapshot scaduto,
 *    mancante, in un'altra regione, o la creazione fallisce per QUALUNQUE motivo): si apre la
 *    MicroVM della PR 1, **invariata** (`runtime: 'node22'`, provvista dal bucket con la doppia
 *    impronta), e si grida. Lo decide `apriLaMicroVm`, qui sotto.
 *
 * ⚠️ IL RIPIEGO È LA STRADA GIÀ PROVATA, NON UN'ALTERNATIVA NUOVA. Non cambia di una virgola
 * rispetto alla PR 1, ed è il motivo per cui si può permettere che lo snapshot sparisca: i video
 * continuano a convertirsi, solo un po' più lenti, e il registro dice ogni volta che non si sta
 * usando ciò che si credeva di usare. Il rischio che resta, dichiarato: se Vercel togliesse il
 * runtime `node22` E lo snapshot mancasse, ogni apertura fallirebbe (`SANDBOX_UNAVAILABLE`, quattro
 * tentativi) e il battito del runner lo mostrerebbe.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PURO, SALVO UNA COSA: IL LOG
 *
 * Questo modulo non importa `@vercel/sandbox`: l'SDK gli arriva come un oggetto con due metodi
 * (`SdkMicroVm`), ed è il motivo per cui la scelta «snapshot, poi ripiego» si prova con un SDK finto
 * che lancia dove si vuole, invece di restare dentro un adattatore che in locale non si può eseguire
 * (`./adattatori.ts`, che qui è ridotto a cablare due righe). L'unico effetto è `logEvento`, che è
 * fail-open per costruzione (AGENTS, regola 9).
 * ═════════════════════════════════════════════════════════════════════════════
 */

/**
 * Il nome della variabile d'ambiente che dice quale snapshot usare (`snap_…`). Non è un segreto
 * (è l'identificativo di una risorsa del nostro progetto Vercel), ma senza di lei il runner non usa
 * lo snapshot: la configurazione mancante è un `error` (AGENTS, regola 4) anche se il ripiego fa
 * convertire lo stesso.
 */
export const ENV_SNAPSHOT_SANDBOX = 'VIDEO_SANDBOX_SNAPSHOT_ID'

/**
 * Il runtime della MicroVM di ripiego: **node22**, com'era nella PR 1 e finché Vercel lo concede.
 * È una costante e non un parametro perché cambiarla è decidere un'altra cosa: il ripiego deve
 * restare ESATTAMENTE il percorso già collaudato in produzione.
 */
export const RUNTIME_DI_RIPIEGO = 'node22'

/**
 * Da dove è nata una MicroVM che il runner ha CREATO (una riagganciata non ha un'origine: la sua
 * conversione sta già girando e l'apparecchio non si rifà).
 *
 *  · `snapshot` — da `Sandbox.create({ source: { type: 'snapshot', … } })`;
 *  · `runtime` — da `Sandbox.create({ runtime: 'node22' })`, il percorso della PR 1.
 */
export type OrigineMicroVm = 'snapshot' | 'runtime'

/** Il modo in cui l'ambiente è diventato pronto: è il campo `ambiente` del log `ambiente-pronto`. */
export type ModalitaAmbiente = 'snapshot' | 'ripiego-vm' | 'ripiego-runtime'

/* ────────────────────────────────────────────────────────────────────────────
 * LA VARIABILE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Che cosa dice la variabile `VIDEO_SANDBOX_SNAPSHOT_ID`:
 *
 *  · `assente` — non impostata, o vuota (anche solo spazi: una variabile Vercel incollata con un a
 *    capo non è «impostata»);
 *  · `non-valido` — c'è qualcosa che non somiglia a un identificativo (spazi in mezzo, barre, virgolette:
 *    il segno tipico di un valore incollato male);
 *  · `ok` — `id` è l'identificativo, già senza spazi ai lati.
 */
export type LetturaSnapshot =
  | { stato: 'assente' }
  | { stato: 'non-valido' }
  | { stato: 'ok'; id: string }

/**
 * La forma di un identificativo di snapshot: lettere, cifre, `_` e `-`, da 6 a 128 caratteri. Larga di
 * proposito — non conosciamo il formato interno di Vercel (oggi `snap_…`) e una regola più stretta di
 * lui renderebbe «non valido» un id buono, cioè farebbe ripiegare per sempre sul percorso lento senza
 * che nessun guasto lo giustifichi. Non vuole difendere da niente: l'id non passa mai da una riga di
 * shell, va a un campo JSON dell'SDK. Vuole solo riconoscere il valore evidentemente sbagliato.
 */
const FORMA_ID_SNAPSHOT = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/

export function leggiSnapshotConfigurato(valore: string | undefined): LetturaSnapshot {
  const id = typeof valore === 'string' ? valore.trim() : ''
  if (id === '') return { stato: 'assente' }
  return FORMA_ID_SNAPSHOT.test(id) ? { stato: 'ok', id } : { stato: 'non-valido' }
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'ERRORE DELL'SDK, IN UNA FORMA CHE PUÒ ENTRARE IN UN LOG
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * I fatti di un'eccezione che il log può avere, senza il testo grezzo:
 *
 *  · `nome` — il nome della classe (`APIError`, `TypeError`…), se ha la forma di un identificativo;
 *  · `http` — lo stato della risposta (`APIError.response.status`), o `status`/`statusCode` di un errore
 *    di un altro client; `null` se non c'è o non è uno stato HTTP;
 *  · `codice` — il codice SENZA spazi che l'errore porta: `json.error.code` dell'API del Sandbox
 *    (`snapshot_not_found`, `sandbox_stopping`…) o il `code` di Node (`ECONNRESET`, …), anche dentro
 *    `cause` (undici scrive lì il motivo vero di un `fetch failed`); `null` se non c'è.
 *
 * Ogni valore passa per una forma chiusa (identificativo di al più 64 caratteri, intero fra 100 e 599):
 * un testo libero non entra mai da qui, nemmeno se un'API rispondesse con un `code` di mezza pagina.
 */
export interface FattiDellErrore {
  nome: string | null
  http: number | null
  codice: string | null
}

/** Un identificativo tecnico: parte da una lettera, poi lettere, cifre e `_`. Al più 64 caratteri. */
const FORMA_IDENTIFICATIVO = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

type Opaco = Record<string, unknown>

function comeOggetto(valore: unknown): Opaco | null {
  return valore !== null && typeof valore === 'object' ? (valore as Opaco) : null
}

function identificativo(valore: unknown): string | null {
  return typeof valore === 'string' && FORMA_IDENTIFICATIVO.test(valore) ? valore : null
}

function statoHttp(valore: unknown): number | null {
  return typeof valore === 'number' && Number.isInteger(valore) && valore >= 100 && valore <= 599
    ? valore
    : null
}

/** Legge una proprietà senza fidarsi dell'oggetto: un getter ostile non deve far fallire il log di un fallimento. */
function leggi(oggetto: Opaco | null, chiave: string): unknown {
  if (oggetto === null) return undefined
  try {
    return oggetto[chiave]
  } catch {
    return undefined
  }
}

export function fattiDellErrore(err: unknown): FattiDellErrore {
  const e = comeOggetto(err)
  const risposta = comeOggetto(leggi(e, 'response'))
  const json = comeOggetto(leggi(e, 'json'))
  const dentroJson = comeOggetto(leggi(json, 'error'))
  const causa = comeOggetto(leggi(e, 'cause'))
  return {
    nome: identificativo(leggi(e, 'name')),
    http:
      statoHttp(leggi(risposta, 'status')) ??
      statoHttp(leggi(e, 'status')) ??
      statoHttp(leggi(e, 'statusCode')),
    codice:
      identificativo(leggi(dentroJson, 'code')) ??
      identificativo(leggi(e, 'code')) ??
      identificativo(leggi(causa, 'code')),
  }
}

/**
 * Quanto del testo grezzo si guarda, prima di ripulirlo: il messaggio di un errore dell'SDK è una riga
 * o due, e quello che serve sta nell'inizio. Il resto non aggiunge diagnosi e allunga soltanto ciò che
 * poi deve passare dalle maschere.
 */
const MESSAGGIO_ERRORE_MAX = 260

function messaggioGrezzo(err: unknown): string {
  try {
    if (err instanceof Error) return err.message
    return typeof err === 'string' ? err : ''
  } catch {
    return ''
  }
}

/**
 * Un'eccezione qualunque — dell'SDK del Sandbox, soprattutto — in una forma che può entrare in un log
 * (secondario #104 della PR 2).
 *
 * ⚠️ PERCHÉ NON SI PASSA L'ECCEZIONE COM'È. Il logger sanifica il messaggio (email, codici fiscali, vincoli
 * di Postgres) ma NON toglie gli URL né i JWT, e un'eccezione dell'SDK può portarli dentro: l'SDK di Vercel
 * fa richieste con un token nell'intestazione e un client HTTP che fallisce scrive volentieri l'indirizzo
 * che stava chiamando. `app_log` dura trenta giorni ed è interrogabile in SQL. Oggi nessuno degli errori
 * visti ne porta uno — ma «oggi non succede» è una misura, non una garanzia, e il punto è proprio quello
 * in cui il runner passa gli URL firmati di un bucket privato ai comandi della MicroVM.
 *
 * Perciò ciò che entra nel log è: nome, stato HTTP e codice (campi chiusi, vedi `fattiDellErrore`) più il
 * MESSAGGIO ripulito da `codaDiagnostica` (via URL, JWT, `token=…`, metadati dei filmati) e poi riga per
 * riga da `sanificaMessaggio`. Il testo resta leggibile — «quota finita» e «regione non disponibile» sono due
 * riparazioni diverse — e sparisce solo ciò che nei log non deve stare. Lo stack no: è di
 * un SDK, non dice niente che il nome e il codice non dicano, e non c'è modo di ripulirlo con
 * la stessa sicurezza.
 *
 * Non lancia mai: gira sul percorso di un guasto e non deve mascherarlo con un secondo.
 */
export function erroreSanificatoPerIlLog(err: unknown): Error {
  const { nome, http, codice } = fattiDellErrore(err)
  // «Error» non dice niente che non si sappia già: un messaggio che comincia con quel nome è solo più lungo. `APIError`,
  // `TypeError`, `AbortError` — i nomi che distinguono qualcosa — restano.
  const nomeUtile = nome === 'Error' ? null : nome
  const intestazione = [nomeUtile, http === null ? null : `HTTP ${http}`, codice].filter((p) => p !== null).join(' ')
  const corpo = codaDiagnostica(messaggioGrezzo(err), MESSAGGIO_ERRORE_MAX)
    .split('\n')
    .map((riga) => sanificaMessaggio(riga))
    .join('\n')
    .trim()
  const testo = [intestazione, corpo].filter((p) => p !== '').join(': ')
  const risultato = new Error(testo === '' ? 'errore non descrivibile' : testo)
  risultato.name = 'VideoSandboxError'
  if (codice !== null) Object.assign(risultato, { code: codice })
  return risultato
}

/* ────────────────────────────────────────────────────────────────────────────
 * APRIRE LA MICROVM: riaggancio, snapshot, ripiego
 * ──────────────────────────────────────────────────────────────────────────── */

/** I parametri con cui si chiede una MicroVM nuova. Gli stessi in ogni modo, tranne da dove nasce. */
export interface RichiestaApertura {
  nome: string
  regione: string
  vcpus: number
  tettoMs: number
}

/**
 * I parametri di `Sandbox.create`, nelle due forme che il runner usa: dallo snapshot, o dal runtime
 * (la PR 1). `persistent: false` in entrambe: la MicroVM è un lavoro, non uno spazio di lavoro.
 *
 * Le due forme sono ESCLUSIVE, come nell'SDK (`runtime?: never` accanto a `source`): un oggetto che le
 * avesse entrambe non compila. Il compilatore lo vieta qui prima che lo faccia l'SDK a runtime.
 */
export type ParametriCreazione = {
  name: string
  region: string
  resources: { vcpus: number }
  timeout: number
  persistent: false
} & (
  | { source: { type: 'snapshot'; snapshotId: string }; runtime?: never }
  | { runtime: typeof RUNTIME_DI_RIPIEGO; source?: never }
)

/**
 * Le due chiamate dell'SDK che aprono una MicroVM, nella forma che un test può sostituire. `S` è il
 * tipo del Sandbox: qui non si guarda dentro, si passa soltanto.
 */
export interface SdkMicroVm<S> {
  /** `Sandbox.get({ name, resume: true })`: riaggancia la MicroVM che ha questo nome. Lancia se non c'è. */
  riaggancia(nome: string): Promise<S>
  /** `Sandbox.create(parametri)`. Lancia se la MicroVM non nasce. */
  crea(parametri: ParametriCreazione): Promise<S>
}

export interface MicroVmAperta<S> {
  sandbox: S
  /** Falso se è stata riagganciata (la sua conversione sta già girando). */
  nuova: boolean
  /** Solo per una MicroVM nuova: da dove è nata. */
  origine: OrigineMicroVm | undefined
}

/**
 * Perché lo snapshot non è stato usato, nei log: l'`error_code` di `ambiente-pronto-assente`.
 * Nomi in MAIUSCOLO per i motivi che sono nostri (la variabile, i binari); quelli dell'SDK arrivano
 * com'è l'API li scrive (`snapshot_not_found`) o, se non ne ha uno, `HTTP_<stato>` o `ERRORE_SDK`.
 */
export const MOTIVI_AMBIENTE_ASSENTE = {
  variabileAssente: 'VARIABILE_ASSENTE',
  variabileNonValida: 'VARIABILE_NON_VALIDA',
  binariNonVerificati: 'BINARI_NON_VERIFICATI',
  erroreSdk: 'ERRORE_SDK',
} as const

/** Il codice con cui un fallimento dell'SDK entra in `error_code`: il suo, o lo stato HTTP, o un nome generico. */
function codiceDelFallimentoSdk(fatti: FattiDellErrore): string {
  if (fatti.codice !== null) return fatti.codice
  if (fatti.http !== null) return `HTTP_${fatti.http}`
  return MOTIVI_AMBIENTE_ASSENTE.erroreSdk
}

/**
 * LA RIGA CHE DICE «L'AMBIENTE PRONTO NON C'ERA»: `config`, livello `error`, sempre.
 *
 * AGENTS, regola 4: una configurazione mancante o inutilizzabile in produzione è un incidente, non
 * una nota a piè di pagina — anche se il ripiego fa convertire lo stesso. Il ripiego è LENTO e
 * dipende da un runtime deprecato: se lo snapshot scade e nessuno se ne accorge, il giorno in cui
 * Vercel toglie `node22` si scopre di colpo. Con questa riga a ogni apertura (deduplicata per giorno da
 * `app_log`, che somma le occorrenze) il numero di ripiegamenti si legge in una query.
 *
 * Nei campi stanno solo il motivo (`error_code`, un identificativo) e lo stato HTTP (un numero). Il
 * resto — il nome della variabile, il testo ripulito dell'errore dell'SDK — viaggia nel MESSAGGIO,
 * perché `redact` è a lista bianca per chiave e un campo `variabile` uscirebbe `[redatto:str/…]`.
 */
function segnalaAmbienteProntoAssente(motivo: string, http: number | null, perche: Error): void {
  logEvento(
    'config',
    'error',
    {
      operazione: 'video-runner',
      esito: 'ambiente-pronto-assente',
      error_code: motivo,
      ...(http === null ? {} : { http }),
    },
    perche,
  )
}

/**
 * Apre la MicroVM che converterà un job: la riaggancia se c'è, altrimenti la crea dallo snapshot, e se lo
 * snapshot non c'è o non va la crea come nella PR 1.
 *
 *  1. **Riaggancio** (`riaggancia`) — è il cuore della durevolezza: la MicroVM che sta convertendo ha questo
 *     nome, e un'altra invocazione la ritrova per nome. Non è un guasto se non c'è (il caso normale è
 *     «non c'è ancora»): si logga a `info`, perché senza questa riga «creata» e «riagganciata» sarebbero
 *     indistinguibili e non si potrebbe misurare se la ripresa funziona.
 *  2. **Snapshot** — solo se la variabile dice un id valido. Se la creazione LANCIA, per qualunque
 *     motivo, si ripiega: snapshot mancante o scaduto (`snapshot_not_found`), in un'altra regione, quota,
 *     piattaforma in difficoltà, rete. Non si prova a distinguere i casi per ritentare lo snapshot: il
 *     tentativo dopo è un altro job con un'altra MicroVM, e se anche questa volta è andata male la
 *     conversione di QUESTO job non deve aspettare.
 *  3. **Ripiego** — il percorso della PR 1, invariato. Se lancia anche lui, l'eccezione ESCE: è il guasto
 *     che `esegui.ts` classifica `SANDBOX_UNAVAILABLE` e ritenta con le sue attese.
 *
 * ⚠️ NON SI ASPETTA E NON SI RITENTA LA CREAZIONE DALLO SNAPSHOT. Un'apertura dura qualche secondo e il
 * tetto di un'invocazione è 240 s: due aperture in serie costano poco, tre o quattro no, e il ripiego è
 * già «il secondo tentativo» che ha un'altra probabilità di riuscire (non dipende dallo snapshot).
 */
export async function apriLaMicroVm<S>(
  sdk: SdkMicroVm<S>,
  richiesta: RichiestaApertura,
  snapshot: LetturaSnapshot,
): Promise<MicroVmAperta<S>> {
  try {
    return { sandbox: await sdk.riaggancia(richiesta.nome), nuova: false, origine: undefined }
  } catch (err) {
    logEvento(
      'cron',
      'info',
      { operazione: 'video-runner:sandbox', esito: 'riaggancio-non-riuscito' },
      erroreSanificatoPerIlLog(err),
    )
  }

  const comuni = {
    name: richiesta.nome,
    region: richiesta.regione,
    resources: { vcpus: richiesta.vcpus },
    timeout: richiesta.tettoMs,
    persistent: false as const,
  }

  if (snapshot.stato === 'ok') {
    try {
      const sandbox = await sdk.crea({
        ...comuni,
        source: { type: 'snapshot', snapshotId: snapshot.id },
      })
      return { sandbox, nuova: true, origine: 'snapshot' }
    } catch (err) {
      const fatti = fattiDellErrore(err)
      segnalaAmbienteProntoAssente(codiceDelFallimentoSdk(fatti), fatti.http, erroreSanificatoPerIlLog(err))
    }
  } else {
    segnalaAmbienteProntoAssente(
      snapshot.stato === 'assente'
        ? MOTIVI_AMBIENTE_ASSENTE.variabileAssente
        : MOTIVI_AMBIENTE_ASSENTE.variabileNonValida,
      null,
      new Error(
        `${ENV_SNAPSHOT_SANDBOX}: ${
          snapshot.stato === 'assente' ? 'non impostata' : 'non è un identificativo di snapshot'
        }, la MicroVM nasce dal runtime ${RUNTIME_DI_RIPIEGO} e porta FFmpeg dal bucket`,
      ),
    )
  }

  // Il percorso della PR 1, parola per parola: `runtime`, nome, regione, risorse, tetto, non persistente.
  const sandbox = await sdk.crea({ ...comuni, runtime: RUNTIME_DI_RIPIEGO })
  return { sandbox, nuova: true, origine: 'runtime' }
}
