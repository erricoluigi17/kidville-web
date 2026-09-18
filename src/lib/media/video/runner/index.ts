import { logEvento } from '@/lib/logging/logger'
import { appUrl } from '@/lib/email/tema'
import { createAdminClient } from '@/lib/supabase/server-client'
import { consegnaVideoInBozzaNews } from '@/lib/news/video-allegato'

import { archivioSupabase, codaSupabase, macchinaVercel } from './adattatori'
import { eseguiUnJobVideo, type EsitoRunnerVideo } from './esegui'

export { eseguiUnJobVideo } from './esegui'
export type { DipendenzeRunner, EsitoRunnerVideo } from './esegui'
export { CODICI_RUNNER_VIDEO, type CodiceRunnerVideo } from './codici'
export {
  BATTITI_TOLLERATI,
  PERIODO_BATTITO_MS,
  SECONDI_LEASE_BATTITO,
  SECONDI_LEASE_PRESA,
  TETTO_INVOCAZIONE_MS,
  TETTO_SANDBOX_MS,
} from './battito'
export { nomeSandboxVideo, percorsoUscitaVideo } from './preparazione'

/**
 * L'INGRESSO DEL RUNNER — quello che una route o un cron chiamano.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LE VARIABILI D'AMBIENTE, per NOME e mai con un valore
 *
 * ⚠️ NESSUNA DELLE TRE È ANCORA IN `docs/env.md`, e non le ha scritte questo
 * modulo: `docs/env.md` e `src/instrumentation.ts` sono fuori dal perimetro del
 * lavoro che ha prodotto il runner. Vanno aggiunte, e finché non lo sono il lock
 * `env-critiche-documentate` resta verde soltanto perché guarda il preflight, non i
 * `process.env` sparsi. Le righe da aggiungere stanno nella consegna.
 *
 *   · `VIDEO_RUNNER_OWNER_ID` — uuid del worker, **critica**. Senza, il runner non
 *     parte affatto: vedi `identitaDelWorker`.
 *   · `VIDEO_SANDBOX_REGION`  — regione della MicroVM. Assente ⇒ `dub1`, che è dove
 *     sta lo Storage (eu-west-1). Una regione diversa non rompe niente e paga
 *     traffico fra continenti per ogni video.
 *   · `VIDEO_SANDBOX_VCPUS`   — quanti core. Assente ⇒ 4. Misura del piano su
 *     `dub1`: a 2 vCPU il caso tipico sta fra 392 e 653 secondi, a 4 fra 212 e 353 —
 *     1,85 volte più veloce a costo praticamente identico (+8 %), perché la
 *     fatturazione è a `GB × ore` e il tempo si accorcia quanto i core aumentano.
 *
 * Le credenziali del Sandbox NON sono fra queste: `@vercel/sandbox` le ricava dal
 * token OIDC che la piattaforma inietta da sé. Se OIDC non è abilitato sul progetto,
 * `Sandbox.create` lancia e il job fallisce con `SANDBOX_UNAVAILABLE` — che è il
 * motivo per cui quel codice esiste separato dagli altri.
 * ═════════════════════════════════════════════════════════════════════════════
 */

export const ENV_OWNER_RUNNER = 'VIDEO_RUNNER_OWNER_ID'
export const ENV_REGIONE_SANDBOX = 'VIDEO_SANDBOX_REGION'
export const ENV_VCPUS_SANDBOX = 'VIDEO_SANDBOX_VCPUS'

/** Dublino: è dove sta il progetto Supabase (eu-west-1). Il video non attraversa oceani. */
const REGIONE_PREDEFINITA = 'dub1'

/** Quattro core: la misura del piano, non un numero tondo. Su Pro il massimo è 8. */
const VCPUS_PREDEFINITI = 4
const VCPUS_MASSIMI = 8

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * L'identità del worker: un uuid STABILE fra un'invocazione e l'altra.
 *
 * ⚠️ Perché non si genera qui, ed è la decisione meno ovvia di tutto il runner. Un
 * `crypto.randomUUID()` a ogni invocazione funzionerebbe benissimo… fino al primo
 * video che dura più di quattro minuti. Da lì in poi: l'invocazione se ne va
 * lasciando la conversione accesa, il tick successivo ha un'identità diversa,
 * `miei()` non trova niente, la lease scade, il job torna in coda con un fence nuovo
 * e la conversione ricomincia da capo — all'infinito, con i log che dicono soltanto
 * «in corso» ogni volta. Un guasto che non produce nessun errore e nessuna
 * conversione: la forma peggiore che questo repository conosca.
 *
 * ⚠️ CONFIGURAZIONE MANCANTE = LIVELLO `error` (AGENTS, regola 4). Non è una nota a
 * piè di pagina: senza questa variabile i video non escono, e nessuno riceve un
 * messaggio d'errore perché non c'è nessuna richiesta HTTP che aspetta.
 */
function identitaDelWorker(): string | null {
  const valore = process.env[ENV_OWNER_RUNNER]
  if (typeof valore === 'string' && UUID.test(valore)) return valore
  // ⚠️ IL NOME DELLA VARIABILE VIAGGIA NEL MESSAGGIO, NON IN UN CAMPO. `redact` è a
  // lista bianca per chiave e per forma: una chiave `variabile` non è in lista, e
  // `VIDEO_RUNNER_OWNER_ID` non passa nemmeno la forma dell'enumerato (che non
  // ammette l'underscore). In `app_log` uscirebbe `[redatto:str/21]`, cioè una riga
  // che dice «manca una variabile» senza dire quale. Passato come errore diventa
  // `app_log.messaggio`, in chiaro — la stessa scelta di `externalFetch` per il
  // corpo del provider. Il NOME non è un segreto; il valore non lo si tocca.
  logEvento(
    'config',
    'error',
    { operazione: 'video-runner', esito: valore ? 'config-non-valida' : 'config-mancante' },
    new Error(`${ENV_OWNER_RUNNER}: ${valore ? 'non è un uuid' : 'non impostata'}`),
  )
  return null
}

/** La regione. Un valore che non somiglia a una regione Vercel è un errore, non un default. */
function regioneDelSandbox(): string {
  const valore = process.env[ENV_REGIONE_SANDBOX]
  if (valore === undefined || valore === '') return REGIONE_PREDEFINITA
  if (/^[a-z]{3}[0-9]$/.test(valore)) return valore
  logEvento(
    'config',
    'error',
    { operazione: 'video-runner', esito: 'config-non-valida' },
    new Error(`${ENV_REGIONE_SANDBOX}: non è una regione Vercel`),
  )
  return REGIONE_PREDEFINITA
}

/** I core. Fuori intervallo si torna al default, ma la riga resta: è configurazione sbagliata. */
function coreDelSandbox(): number {
  const valore = process.env[ENV_VCPUS_SANDBOX]
  if (valore === undefined || valore === '') return VCPUS_PREDEFINITI
  const n = Number(valore)
  if (Number.isSafeInteger(n) && n >= 1 && n <= VCPUS_MASSIMI) return n
  logEvento(
    'config',
    'error',
    { operazione: 'video-runner', esito: 'config-non-valida' },
    new Error(`${ENV_VCPUS_SANDBOX}: atteso un intero fra 1 e ${VCPUS_MASSIMI}`),
  )
  return VCPUS_PREDEFINITI
}

/**
 * Porta avanti un job della coda video. Non converte un video: fa un pezzo di lavoro
 * e torna. Va chiamata a ripetizione — il cron ogni minuto — e il disegno è scritto
 * per intero nella testata di `./esegui.ts`.
 *
 * ⚠️ NON è una route: non c'è `withRoute` qui, e non ci va. Chi la espone su HTTP la
 * avvolge nella propria route, con il proprio gate e la propria validazione.
 */
export async function eseguiProssimoJobVideo(): Promise<
  EsitoRunnerVideo | { esito: 'non-configurato'; variabile: string }
> {
  const leaseOwner = identitaDelWorker()
  if (leaseOwner === null) return { esito: 'non-configurato', variabile: ENV_OWNER_RUNNER }

  const supabase = await createAdminClient()

  return eseguiUnJobVideo({
    coda: codaSupabase(supabase),
    archivio: archivioSupabase(supabase),
    macchina: macchinaVercel(),
    orologio: {
      adesso: () => Date.now(),
      pausa: (ms) => new Promise((risolvi) => setTimeout(risolvi, ms)),
    },
    leaseOwner,
    regione: regioneDelSandbox(),
    vcpus: coreDelSandbox(),
    // Il watermark della Galleria: un file pubblico del nostro stesso dominio, non
    // un indirizzo firmato. `appUrl()` è la definizione unica di quell'indirizzo —
    // riscriverla qui vorrebbe dire due sorgenti di verità per lo stesso URL.
    urlWatermark: `${appUrl().replace(/\/+$/, '')}/watermark.png`,
    // Il passo in più del canale `news`: l'uscita viene copiata nell'area di sosta
    // delle bozze, dove diventa un allegato ORDINARIO. È qui che il runner incontra
    // le comunicazioni, e in nessun altro punto — `esegui.ts` sa solo che per quel
    // canale c'è una porta da chiamare.
    consegnaNews: async (job, percorsoUscita, bucketUscita) => {
      const esito = await consegnaVideoInBozzaNews(
        supabase,
        {
          id: job.id,
          ownerId: job.owner_id,
          bucketUscita,
          percorsoUscita,
        },
        'video-runner',
      )
      return esito.ok ? { ok: true } : { ok: false, codice: esito.codice }
    },
  })
}
