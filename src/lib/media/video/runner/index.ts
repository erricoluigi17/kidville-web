import { randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import { logEvento } from '@/lib/logging/logger'
import { appUrl } from '@/lib/email/tema'
import { createAdminClient } from '@/lib/supabase/server-client'
import { consegnaVideoInBozzaNews } from '@/lib/news/video-allegato'
import { scansionaEsitiDiConversione, type EsitoScansioneEsiti } from '@/lib/media/video/esiti'
import { consumaOutbox, TIPI_SOLO_DEL_RUNNER } from '@/lib/media/video/outbox'

import { archivioSupabase, codaSupabase, macchinaVercel } from './adattatori'
import {
  eseguiUnJobVideo,
  type ContestoPubblicazioni,
  type DipendenzeRunner,
  type EsitoRunnerVideo,
  type RichiestaRunner,
} from './esegui'

export { SECONDI_SORVEGLIANZA, eseguiUnJobVideo } from './esegui'
export type {
  ContestoPubblicazioni,
  DipendenzeRunner,
  EsitoRunnerVideo,
  QuandoPubblicare,
  RichiestaRunner,
} from './esegui'
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
 * Le prime tre sono in `docs/env.md`. La quarta, `VIDEO_CONVERSIONI_PARALLELE`, ce la scrive il compito
 * che documenta l'ambiente del runner in questa PR (T8, spec §10.1): questo modulo non tocca
 * `docs/env.md`, e il lock `env-critiche-documentate` guarda solo il preflight, non i `process.env`
 * sparsi — quindi nessun test diventerebbe rosso se la riga mancasse.
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
 *   · `VIDEO_CONVERSIONI_PARALLELE` — quante conversioni girano insieme (PR 2). Assente ⇒ 3, valida da
 *     1 a 10: picco misurato di 8 video in 15 minuti, p90 di 2. Il tetto lo conta il DATABASE
 *     (`video_job_prossimo` e `video_job_prendi` rispondono `CAPACITA_PIENA`), questa variabile è solo
 *     il numero che gli si passa. Il limite reale dei Sandbox concorrenti non è documentato da
 *     Vercel: lo misura T16 aprendone tre insieme.
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
export const ENV_CONVERSIONI_PARALLELE = 'VIDEO_CONVERSIONI_PARALLELE'

/** Dublino: è dove sta il progetto Supabase (eu-west-1). Il video non attraversa oceani. */
const REGIONE_PREDEFINITA = 'dub1'

/** Quattro core: la misura del piano, non un numero tondo. Su Pro il massimo è 8. */
const VCPUS_PREDEFINITI = 4
const VCPUS_MASSIMI = 8

/**
 * Tre conversioni insieme: il picco misurato è di 8 video in 15 minuti con p90 di 2 (T0, 2026-10-02).
 * Il massimo accettato qui è 10 (la RPC arriva a 50, ma più di 10 MicroVM insieme non sono una scelta
 * da fare per sbaglio con una cifra in più sulla variabile).
 */
export const CONVERSIONI_PARALLELE_PREDEFINITE = 3
export const CONVERSIONI_PARALLELE_MASSIME = 10

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
 * Quante conversioni girano insieme. Fuori intervallo (o non un intero) si torna al predefinito, ma la
 * riga resta: è configurazione sbagliata, e AGENTS (regola 4) la vuole a livello `error`, mai `info`.
 * Assente o vuota è invece il caso normale: nessuna riga.
 *
 * Esportata per i test: legge `process.env` e logga, quindi si prova con `vi.stubEnv` e il logger finto.
 */
export function conversioniParallele(): number {
  const valore = process.env[ENV_CONVERSIONI_PARALLELE]
  if (valore === undefined || valore === '') return CONVERSIONI_PARALLELE_PREDEFINITE
  const n = Number(valore)
  if (Number.isSafeInteger(n) && n >= 1 && n <= CONVERSIONI_PARALLELE_MASSIME) return n
  logEvento(
    'config',
    'error',
    { operazione: 'video-runner', esito: 'config-non-valida' },
    new Error(
      `${ENV_CONVERSIONI_PARALLELE}: atteso un intero fra 1 e ${CONVERSIONI_PARALLELE_MASSIME}`,
    ),
  )
  return CONVERSIONI_PARALLELE_PREDEFINITE
}

/* ────────────────────────────────────────────────────────────────────────────
 * LE PUBBLICAZIONI DEL RUNNER (spec §8.1 e §9, secondario #105)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Al massimo cinque pubblicazioni per chiamata (spec §9): il resto lo prende il giro dopo. */
export const PUBBLICAZIONI_PER_CHIAMATA = 5

/**
 * Quanto si stima che costi UNA pubblicazione — la copia dentro Storage (lato server, senza far passare i byte di qui), la RPC, le
 * notifiche —: sotto questo margine non se ne comincia un'altra. È una stima, non una misura (la prende T16 dai primi battiti), e
 * sbaglia dalla parte giusta: un'altra pubblicazione NON iniziata aspetta il giro dopo, una iniziata e tagliata a metà lascia una copia
 * orfana.
 */
export const STIMA_PUBBLICAZIONE_MS = 15_000

/** Quanto serve alla scansione degli esiti: due letture e, per ogni fallimento, una marca e una notifica. */
export const STIMA_SCANSIONE_ESITI_MS = 5_000

/**
 * Il tetto di quanto le pubblicazioni di UNA chiamata possono togliere alla sorveglianza (#105).
 *
 * Nel giro SENZA `job_id` le pubblicazioni girano PRIMA di riprendere il job che questa invocazione sorveglia, e mentre girano nessuno batte
 * per quel job: la sua lease dura 300 secondi dall'ultimo battito (`SECONDI_LEASE_BATTITO`), e quando l'invocazione precedente se n'è
 * andata ne restavano non meno di 240. Un minuto lascia alla lease il margine che le serve, anche se la RPC o lo Storage rallentano.
 */
export const TETTO_PUBBLICAZIONI_MS = 60_000

/** La lease di UN evento preso: una pubblicazione sta ampiamente in due minuti, e un evento che resta in lease torna prendibile da solo. */
export const LEASE_PUBBLICAZIONE_SECONDI = 120

/**
 * Il punto d'aggancio `DipendenzeRunner.pubblicazioni`: consuma le pubblicazioni accodate e scansiona gli esiti di conversione.
 *
 *  · IL CONSUMO è `consumaOutbox` coi soli `TIPI_SOLO_DEL_RUNNER` — il filtro sta nel claim, quindi il runner non prende mai un evento che
 *    spetta alla retention — e UN evento alla volta: il tempo di una pubblicazione dipende dalla copia, e prenderne cinque insieme vorrebbe
 *    dire tenerli tutti in lease mentre se ne consegna uno. Prima di ogni claim si guarda quanto tempo resta: se non basta per una
 *    pubblicazione non si comincia (nessun tentativo bruciato), e l'evento aspetta il giro dopo.
 *  · LA SCANSIONE (`scansionaEsitiDiConversione`) avvisa chi ha caricato un video la cui conversione è fallita: lo fa dopo ogni esito
 *    definitivo (`dopo-esito`) e a ogni giro, perché `video_job_fail` non accoda nessun evento.
 *
 * Il tempo è il MINORE fra `restanteMs` (ciò che resta dei 240 secondi di questa invocazione) e `TETTO_PUBBLICAZIONI_MS`: chi ha poco
 * tempo rimanda, invece di farsi tagliare. Non lancia (il wrapper del runner ingoia e logga comunque un'eccezione) e non decide niente:
 * il giro e la sorveglianza proseguono comunque.
 *
 * Esportata per i test: `adesso` è un parametro perché il tempo si fissa, non si congela.
 */
export async function eseguiLePubblicazioni(
  supabase: SupabaseClient,
  contesto: ContestoPubblicazioni,
  opzioni: { adesso?: () => number } = {},
): Promise<{ consumate: number; rimandate: boolean; scansione: EsitoScansioneEsiti | null }> {
  const adesso = opzioni.adesso ?? Date.now
  const scadenza = adesso() + Math.min(Math.max(0, contesto.restanteMs), TETTO_PUBBLICAZIONI_MS)

  let consumate = 0
  let rimandate = false
  while (consumate < PUBBLICAZIONI_PER_CHIAMATA) {
    if (scadenza - adesso() < STIMA_PUBBLICAZIONE_MS) {
      rimandate = true
      break
    }
    const esito = await consumaOutbox(supabase, {
      operazione: 'video-runner',
      limite: 1,
      tipi: TIPI_SOLO_DEL_RUNNER,
      leaseSecondi: LEASE_PUBBLICAZIONE_SECONDI,
    })
    // Coda vuota, o un claim che non è partito (già gridato dal motore): non c'è niente da ripetere.
    if (esito.presi === 0) break
    consumate += esito.presi
  }

  let scansione: EsitoScansioneEsiti | null = null
  if (scadenza - adesso() >= STIMA_SCANSIONE_ESITI_MS) {
    scansione = await scansionaEsitiDiConversione(supabase, { operazione: 'video-runner' })
  } else {
    rimandate = true
  }

  if (rimandate) {
    // Si dice che si è rimandato: un video che aspetta il giro dopo senza una riga che lo spieghi è un ritardo che nessuno sa leggere.
    logEvento('cron', 'info', {
      operazione: 'video-runner',
      esito: 'pubblicazioni-rimandate',
      azione: contesto.quando,
      n_pubblicazioni: consumate,
      restante_ms: Math.max(0, Math.round(contesto.restanteMs)),
    })
  }
  return { consumate, rimandate, scansione }
}

/**
 * Porta avanti un job della coda video. Non converte un video: fa un pezzo di lavoro
 * e torna. Si chiama in due modi (il disegno è scritto per intero nella testata di `./esegui.ts`,
 * compreso ciò che si fa di un guasto nostro: il job si rimette in coda e si ritenta, classi e
 * attese in `./ritentativi.ts`):
 *
 *  · CON `richiesta.jobId` — un calcio per UN job (`video_runner_kick`): parte subito, e solo se è
 *    l'unica invocazione a sorvegliarlo (`gia-sorvegliato` altrimenti);
 *  · SENZA — il giro del cron, ogni cinque minuti, che resta la rete di sicurezza di tutto.
 *
 * ⚠️ NON è una route: non c'è `withRoute` qui, e non ci va. Chi la espone su HTTP la
 * avvolge nella propria route, con il proprio gate e la propria validazione.
 */
export async function eseguiProssimoJobVideo(
  richiesta: RichiestaRunner = {},
): Promise<EsitoRunnerVideo | { esito: 'non-configurato'; variabile: string }> {
  const leaseOwner = identitaDelWorker()
  if (leaseOwner === null) return { esito: 'non-configurato', variabile: ENV_OWNER_RUNNER }

  const supabase = await createAdminClient()

  const dipendenze: DipendenzeRunner = {
    coda: codaSupabase(supabase),
    archivio: archivioSupabase(supabase),
    macchina: macchinaVercel(),
    orologio: {
      adesso: () => Date.now(),
      pausa: (ms) => new Promise((risolvi) => setTimeout(risolvi, ms)),
    },
    leaseOwner,
    // L'identità di QUESTA invocazione: un uuid nuovo a ogni chiamata, l'esatto contrario del
    // `leaseOwner` (stabile). È ciò con cui un'invocazione prende e rilascia la sorveglianza di un job.
    invocazione: randomUUID(),
    tettoConversioni: conversioniParallele(),
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
    // Le pubblicazioni dei video di galleria e gli avvisi di una conversione fallita (spec §8.1, §8.5, §9): il runner le chiama nel giro e
    // dopo ogni esito definitivo (`DipendenzeRunner.pubblicazioni` in `./esegui.ts`), e qui si decide che cosa significano. Dentro
    // `restanteMs` e in poco tempo — vedi `eseguiLePubblicazioni`.
    pubblicazioni: async (contesto) => {
      await eseguiLePubblicazioni(supabase, contesto)
    },
  }

  return eseguiUnJobVideo(dipendenze, richiesta)
}
