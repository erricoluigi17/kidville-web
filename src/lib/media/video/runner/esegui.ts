import {
  logEvento,
  type Livello,
  type OpzioniEvento,
  type Valore,
} from '@/lib/logging/logger'
import { MESSAGGIO_MAX, sanificaMessaggio } from '@/lib/logging/serialize'

import { BUCKET_BUILD_VIDEO, PERCORSO_FFMPEG_GZ, PERCORSO_FFPROBE_GZ } from '../build'
import { BUCKET_ORIGINALI_VIDEO } from '../contratto'
import { buildVideoEncodeArgs, type VideoEncodeOptions } from '../encode'
import { parseVideoProbe } from '../probe'
import { verifyVideoOutput } from '../verify'
import {
  SECONDI_LEASE_PRESA,
  TETTO_INVOCAZIONE_MS,
  TETTO_SANDBOX_MS,
  sorvegliaConversione,
} from './battito'
import type { CodiceRunnerVideo } from './codici'
import { codaDiagnostica } from './diagnosi'
import {
  ENV_URL_FFMPEG,
  ENV_URL_FFPROBE,
  mancanzeDellaBuild,
  nomeSandboxVideo,
  percorsoUscitaVideo,
} from './preparazione'
import {
  conShell,
  type ArchivioVideo,
  type CodaVideo,
  type ComandoInCorso,
  type JobVideo,
  type MacchinaSandbox,
  type Orologio,
  type SessioneSandbox,
} from './porte'
import {
  classeDaUscitaApparecchio,
  classeDaUscitaConversione,
  classeDelDownload,
  decidiRitentativo,
  httpDallaDiagnosi,
  type ClasseGuasto,
} from './ritentativi'
import {
  ENV_URL_INGRESSO,
  ENV_URL_USCITA,
  ENV_URL_WATERMARK,
  INGRESSO,
  USCITA,
  WATERMARK,
  codiceDaUscitaApparecchio,
  codiceDaUscitaConversione,
  comandoInterruzione,
  comandoMarcatore,
  comandoScritturaArgomenti,
  leggiApparecchio,
  leggiEsitoConversione,
  scriptApparecchio,
  scriptConversione,
} from './script'

/**
 * IL GIRO DEL WORKER — dalla coda all'esito, una volta.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COME GIRA, DETTO UNA VOLTA SOLA
 *
 * Questa funzione è pensata per essere chiamata da un cron, ogni cinque minuti, e per
 * fare **un pezzo** di lavoro e tornare. Non converte un video: porta avanti una
 * conversione finché ha tempo, e se non basta se ne va lasciandola accesa.
 *
 *   1. C'è un job ancora mio, rimasto a metà da un'invocazione precedente?
 *      Ha la precedenza. Si riprende con `video_job_claim` sullo STESSO
 *      `lease_owner`: con la lease ancora viva la RPC è idempotente e restituisce
 *      lo stesso `fence_epoch` — quindi lo stesso nome di Sandbox, quindi la stessa
 *      MicroVM, che nel frattempo ha continuato a convertire.
 *   2. Altrimenti si pesca dalla coda con `video_job_next`. Un job rimesso in coda da
 *      un guasto nostro (vedi sotto) non viene scelto finché non scade la sua attesa.
 *   3. Si aprono gli indirizzi firmati, POI la MicroVM (in quest'ordine: una
 *      MicroVM aperta per scoprire che lo Storage dice di no è un conto pagato per
 *      niente).
 *   4. Se la MicroVM è NUOVA si firmano i due `.gz` della build, si apparecchia e si
 *      avvia la conversione; se è stata riagganciata, la conversione sta già girando e
 *      non si tocca niente — nemmeno la build, che non si firma.
 *   5. Si sorveglia col battito finché non finisce, finché non si perde la lease,
 *      o finché non finisce il tempo di questa invocazione.
 *   6. Si verifica l'uscita e solo allora si scrive `video_job_ready`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LA REGOLA CHE ATTRAVERSA TUTTO: SE IL JOB NON È PIÙ MIO, NON SCRIVO
 *
 * Quando il battito viene rifiutato, il job appartiene a un altro worker: il
 * database ha già alzato il fence. Non si chiama `video_job_fail` «per pulizia» —
 * risponderebbe `FENCE_MISMATCH`, e provarci significa non aver capito di chi è il
 * job. Si spegne la MicroVM, si logga, e si torna indietro.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * UN GUASTO HA UNA CLASSE, E LA CLASSE DECIDE CHE COSA SI SCRIVE SUL JOB
 *
 * Fino al 2026-10-02 ogni guasto rendeva il job definitivo al primo colpo: il 29/09
 * l'archivio della build ha cominciato a rispondere 404 e 17 conversioni su 17 sono
 * finite `failed`, pagate dalle insegnanti per un guasto NOSTRO. Adesso ogni punto in cui
 * il runner può fallire dichiara di che guasto si tratta (`ClasseGuasto`, tabella al §4.5
 * della spec `docs/superpowers/specs/2026-10-02-video-pr1-hotfix-ffmpeg-design.md`) e
 * `chiudiPerGuasto` fa il resto:
 *
 *   · `file` — il filmato non va bene: `video_job_fail` con `rejected = true`;
 *   · `non-ritentabile` — non è provato che il file c'entri, ma non si riprova lo stesso:
 *     `video_job_fail` con `rejected = false`;
 *   · `infra-transitoria` / `infra-permanente` — guasto nostro: `video_job_retry` rimette il
 *     job in coda con un'attesa (5, 10, 15 minuti), fino a quattro tentativi in tutto; poi
 *     `video_job_fail`.
 *
 * Quanto aspettare e quando smettere lo dice `./ritentativi.ts`, che è fatto di funzioni
 * pure. Qui si orchestra, e si scrive nei log ciò che è successo — compresa la CODA
 * dell'errore (`erroreDiagnostico`), perché era l'inizio ciò che si salvava e l'inizio non
 * diceva niente.
 */

/** Dove vivono le uscite. `video_job_ready` impone comunque questo bucket. */
const BUCKET_LAVORAZIONE = 'video_processing'

/**
 * Quanto durano gli indirizzi firmati: due ore, come la validità che Supabase dà da
 * sé a un URL di scrittura. Devono sopravvivere a tutta la conversione — che con il
 * tetto della MicroVM è al massimo mezz'ora — e non un minuto di più del necessario.
 */
const SECONDI_FIRMA = 7200

/**
 * Quanto dura l'indirizzo firmato di UNO dei due `.gz` della build: quindici minuti.
 *
 * Molto meno di `SECONDI_FIRMA` e non per caso. Gli indirizzi dell'originale e dell'uscita
 * devono vivere quanto la conversione, perché la MicroVM li usa mentre il runner non c'è
 * più; questi due servono UNA volta, dentro l'apparecchio (tetto 120 secondi), e si
 * firmano a ogni MicroVM nuova. Aprono un bucket privato da ~134 MB: una finestra di
 * quindici minuti basta a un apparecchio lento o a un riavvio, e non lascia in giro per
 * due ore un indirizzo che chiunque lo veda può scaricare in ciclo contro la nostra quota
 * di traffico.
 */
export const SECONDI_FIRMA_BUILD = 900

/** Tetti dei passi sincroni. Corti per costruzione: qui dentro si blocca l'invocazione. */
const TETTO_APPARECCHIO_MS = 120_000
const TETTO_COMANDO_BREVE_MS = 30_000

export interface DipendenzeRunner {
  coda: CodaVideo
  archivio: ArchivioVideo
  macchina: MacchinaSandbox
  orologio: Orologio
  /**
   * L'identità del worker, **stabile fra un'invocazione e l'altra**.
   *
   * ⚠️ Non è un dettaglio: è ciò che permette al punto 1 di esistere. Con un uuid
   * nuovo a ogni invocazione, `miei()` non troverebbe mai niente, ogni conversione
   * più lunga di un'invocazione verrebbe abbandonata, e alla scadenza della lease
   * ricominciata da capo — per sempre, senza che nessun log dica perché.
   */
  leaseOwner: string
  regione: string
  vcpus: number
  /** L'indirizzo pubblico del watermark della Galleria. Non è firmato e non è un segreto. */
  urlWatermark: string
  tettoInvocazioneMs?: number
  /**
   * LA CONSEGNA DELL'USCITA NELL'AREA DI SOSTA DI NEWS, chiamata subito dopo che il
   * database ha accettato il `ready`. Iniettata come tutto il resto: il runner è un
   * modulo di media e non deve sapere che cosa sia una comunicazione: sa solo che per
   * il canale `news` c'è un passo in più, e chi glielo dà è `index.ts`.
   *
   * ⚠️ PERCHÉ ESISTE, e non è un abbellimento. Il percorso News è costruito perché il
   * video diventi un allegato di bozza ORDINARIO: l'editor scrive nell'articolo un
   * link a `news_bozze/uploads/<proprietario>/<job>.mp4` — deterministico, ricavato
   * senza chiedere niente a nessuno — e la promozione a pubblicato è quella che esiste
   * già, senza una riga nuova in `media-bozza.ts`.
   *
   * Se questa consegna non avviene, quel link punta a un file che NON C'È. E il guasto
   * non si ferma lì: `promuoviMediaBozza` legge il «not found» dello Storage come «già
   * promosso» e scrive nella riga dell'articolo l'indirizzo pubblico di un oggetto
   * inesistente. Risultato: un video rotto per le famiglie, scritto in silenzio, senza
   * un errore da nessuna parte. Fino al 2026-09-18 questa porta non esisteva e
   * `consegnaVideoInBozzaNews` non aveva NESSUN chiamante fuori dai test.
   *
   * Facoltativa perché un runner senza News resta un runner: se manca, il canale
   * `news` lo dice a voce alta invece di fingere.
   */
  consegnaNews?: (job: JobVideo, percorsoUscita: string, bucketUscita: string) => Promise<{ ok: boolean; codice?: string }>
}

export type EsitoRunnerVideo =
  | { esito: 'coda-vuota' }
  | { esito: 'presa-rifiutata'; codice: string }
  | { esito: 'in-corso'; jobId: string }
  | { esito: 'pronto'; jobId: string; byteUscita: number }
  | { esito: 'fallito'; jobId: string; codice: string; rifiutato: boolean }
  /**
   * Un guasto NOSTRO: il job è stato rimesso in coda e riparte da sé. `tentativo` è quello che
   * è appena fallito (conta da 1) e `attesaS` quanto aspetta prima del prossimo. Non è un
   * fallimento — e infatti la route lo scrive nel battito a livello `warn`, non `error`.
   */
  | { esito: 'in-riprova'; jobId: string; codice: string; tentativo: number; attesaS: number }
  | { esito: 'lease-persa'; jobId: string; codice: string }
  | { esito: 'esito-non-scritto'; jobId: string; codice: string }

export async function eseguiUnJobVideo(d: DipendenzeRunner): Promise<EsitoRunnerVideo> {
  const ripreso = await riprendiUnJobMio(d)
  if (ripreso) return lavoraSulJob(d, ripreso)

  const preso = await d.coda.prossimo(d.leaseOwner, SECONDI_LEASE_PRESA)
  if (!preso.ok) {
    if (preso.code === 'EMPTY_QUEUE') {
      // ⚠️ IL BATTITO DEL CRON, e non è rumore. Con i soli errori, «nessun log» non
      // distingue «coda tranquilla» da «il cron non è mai partito» — l'ambiguità che
      // in questo progetto ha tenuto nascosto per mesi il guasto delle email.
      logEvento('cron', 'info', { operazione: 'video-runner', esito: 'coda-vuota' })
      return { esito: 'coda-vuota' }
    }
    logEvento('cron', 'error', {
      operazione: 'video-runner',
      esito: 'presa-rifiutata',
      error_code: preso.code,
    })
    return { esito: 'presa-rifiutata', codice: preso.code }
  }

  return lavoraSulJob(d, preso.job)
}

/**
 * Il job rimasto a metà da un'invocazione precedente, se c'è.
 *
 * Uno per volta, e non è una semplificazione: aprire una seconda MicroVM mentre la
 * prima converte vorrebbe dire pagarne due e, con un'invocazione sola da spartirsi,
 * sorvegliarle entrambe male. Il tick successivo prende il prossimo.
 */
async function riprendiUnJobMio(d: DipendenzeRunner): Promise<JobVideo | null> {
  const miei = await d.coda.miei(d.leaseOwner)
  if (!miei.ok) {
    // Una lettura che non riesce non deve fermare la coda: si prosegue verso
    // `video_job_next`, che al più non troverà niente. Ma si logga, perché finché
    // questa lettura non funziona OGNI conversione lunga viene rifatta da capo.
    logEvento('cron', 'error', {
      operazione: 'video-runner',
      esito: 'ripresa-non-interrogabile',
      error_code: miei.motivo,
    })
    return null
  }
  const candidato = miei.jobs[0]
  if (!candidato) return null

  const esito = await d.coda.riprendi(candidato.id, d.leaseOwner, SECONDI_LEASE_PRESA)
  if (esito.ok) return esito.job

  // La lease è scaduta fra la lettura e la richiesta: il job tornerà in coda da sé,
  // con un fence nuovo. Non è un guasto, ma va visto: se succede spesso, il tick del
  // cron è più lento della lease.
  logEvento('cron', 'warn', {
    operazione: 'video-runner',
    esito: 'ripresa-rifiutata',
    error_code: esito.code,
    job_id: candidato.id,
  })
  return null
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL LAVORO SU UN JOB
 * ──────────────────────────────────────────────────────────────────────────── */

async function lavoraSulJob(d: DipendenzeRunner, job: JobVideo): Promise<EsitoRunnerVideo> {
  const percorsoUscita = percorsoUscitaVideo(job)

  const lettura = await d.archivio.urlLettura(
    job.original_bucket || BUCKET_ORIGINALI_VIDEO,
    job.original_path,
    SECONDI_FIRMA,
  )
  if (!lettura.ok) {
    // La firma dell'ORIGINALE. «Permanente» solo con 400 o 404 (lo Storage risponde 400, e non
    // 404, per un oggetto che non c'è: misurato il 2026-10-02) o con `NoSuchKey`; un 403, un
    // 429 o un guasto di rete passano da soli. `classeDelDownload` è la regola della BUILD, e
    // uno stato qualunque passato così com'è renderebbe «permanente» ciò che la tabella vuole
    // transitorio: per questo l'allineamento a 400/404 sta qui, dove si conosce il punto.
    // Tanto le due classi si ritentano entrambe: cambia il livello del log.
    const stato = lettura.stato === 400 || lettura.stato === 404 ? lettura.stato : null
    return await chiudiPerGuasto(d, job, {
      codice: 'SOURCE_DOWNLOAD_FAILED',
      classe: classeDelDownload(stato, lettura.codiceStorage),
      diagnosi: lettura.motivo,
      http: lettura.stato ?? null,
    })
  }
  const scrittura = await d.archivio.urlScrittura(BUCKET_LAVORAZIONE, percorsoUscita)
  if (!scrittura.ok) {
    return await chiudiPerGuasto(d, job, {
      codice: 'OUTPUT_UPLOAD_FAILED',
      classe: 'infra-transitoria',
      diagnosi: scrittura.motivo,
      http: scrittura.stato ?? null,
    })
  }

  const ambiente: Record<string, string> = {
    [ENV_URL_INGRESSO]: lettura.url,
    [ENV_URL_USCITA]: scrittura.url,
  }
  if (job.channel === 'gallery') ambiente[ENV_URL_WATERMARK] = d.urlWatermark

  let sessione: SessioneSandbox
  try {
    sessione = await d.macchina.apri({
      nome: nomeSandboxVideo(job.id, job.fence_epoch),
      regione: d.regione,
      vcpus: d.vcpus,
      tettoMs: TETTO_SANDBOX_MS,
    })
  } catch (err) {
    // Un catch che non logga è un bug, e qui il motivo è tutto: «non si apre» può
    // essere una quota finita, una regione giù o un OIDC non configurato, e sono
    // tre riparazioni diverse. Transitoria: se la piattaforma è inciampata, fra cinque
    // minuti si riapre; se è una quota o una configurazione, i quattro tentativi finiscono
    // e il log ha già detto perché.
    return await chiudiPerGuasto(d, job, {
      codice: 'SANDBOX_UNAVAILABLE',
      classe: 'infra-transitoria',
      diagnosi: '',
      causa: err,
    })
  }

  let spegni = true
  try {
    if (sessione.nuova) {
      const avvio = await apparecchiaEAvvia(d, job, sessione, ambiente)
      if (avvio) return avvio
    }

    const sorveglianza = await sorvegliaConversione({
      comando: marcatoreComeComando(sessione),
      battito: async () => {
        const esito = await d.coda.battito(job.id, job.fence_epoch, d.leaseOwner)
        return esito.ok ? { ok: true } : { ok: false, code: esito.code }
      },
      adesso: () => d.orologio.adesso(),
      pausa: (ms) => d.orologio.pausa(ms),
      tettoInvocazioneMs: d.tettoInvocazioneMs ?? TETTO_INVOCAZIONE_MS,
    })

    if (sorveglianza.esito === 'in-corso') {
      // ⚠️ La MicroVM resta accesa: è lì che sta girando la conversione, e il tick
      // successivo la riaggancia per nome.
      spegni = false
      loggaEsito(job, 'info', { esito: 'conversione-in-corso', battiti: sorveglianza.battiti })
      return { esito: 'in-corso', jobId: job.id }
    }

    if (sorveglianza.esito === 'lease-persa') {
      loggaEsito(job, 'warn', {
        esito: 'lease-persa',
        error_code: sorveglianza.codice,
        battiti: sorveglianza.battiti,
      })
      return { esito: 'lease-persa', jobId: job.id, codice: sorveglianza.codice }
    }

    return await concludi(d, job, sorveglianza.comando.stdout, percorsoUscita)
  } finally {
    if (spegni) await fermaSessione(job, sessione)
  }
}

/**
 * Firma la build, apparecchia la MicroVM e stacca la conversione. Restituisce un esito SOLO
 * se qualcosa è andato storto o se il job è stato rimesso in coda: `null` significa «la
 * conversione è partita».
 *
 * ─── LE FIRME DELLA BUILD: SOLO QUI, E SOLO NELL'ENV DELL'APPARECCHIO ────────────────────
 *
 * I due indirizzi firmati dei `.gz` (bucket privato `video_build`) si ottengono SOLO quando la
 * MicroVM è nuova, cioè qui dentro. Firmarli a ogni tick metterebbe un punto di rottura in
 * più sui riagganci delle conversioni lunghe, che la build non la usano più: il binario
 * c'è già e il comando sta girando.
 *
 * Entrano nell'`env` del comando dell'APPARECCHIO e in nessun altro posto. Non negli
 * argomenti di un processo (con un `ps` dentro la MicroVM si leggerebbero, e finirebbero
 * nella console di Vercel accanto al comando) e non nell'`env` della conversione staccata,
 * dove i binari ci sono già e un indirizzo firmato in più sarebbe soltanto un segreto in più
 * da tenere lontano dai log. Senza di loro lo script di preparazione esce subito
 * (`${KV_URL_FFMPEG:?}`): per questo la firma e lo script della build viaggiano nello stesso
 * rilascio, e una MicroVM nuova non può partire con l'uno e senza l'altra.
 */
async function apparecchiaEAvvia(
  d: DipendenzeRunner,
  job: JobVideo,
  sessione: SessioneSandbox,
  ambiente: Record<string, string>,
): Promise<EsitoRunnerVideo | null> {
  const firmaFfmpeg = await d.archivio.urlLettura(
    BUCKET_BUILD_VIDEO,
    PERCORSO_FFMPEG_GZ,
    SECONDI_FIRMA_BUILD,
  )
  if (!firmaFfmpeg.ok) return await guastoDellaFirmaDellaBuild(d, job, firmaFfmpeg)
  const firmaFfprobe = await d.archivio.urlLettura(
    BUCKET_BUILD_VIDEO,
    PERCORSO_FFPROBE_GZ,
    SECONDI_FIRMA_BUILD,
  )
  if (!firmaFfprobe.ok) return await guastoDellaFirmaDellaBuild(d, job, firmaFfprobe)

  const inizioApparecchio = d.orologio.adesso()
  const apparecchio = await sessione.esegui({
    ...conShell(scriptApparecchio()),
    env: {
      ...ambiente,
      [ENV_URL_FFMPEG]: firmaFfmpeg.url,
      [ENV_URL_FFPROBE]: firmaFfprobe.url,
    },
    tettoMs: TETTO_APPARECCHIO_MS,
  })

  const guasto = codiceDaUscitaApparecchio(apparecchio.exitCode)
  if (guasto) {
    // ⚠️ `BUILD_HASH_MISMATCH` finisce qui, e qui non si ESEGUE niente. Fino al 2026-10-02 non
    // si riprovava nemmeno: l'archivio veniva da una release pubblica che poteva cambiare sotto
    // i piedi. Adesso la fonte è nostra e non cambia, quindi un'impronta che non torna è un
    // trasferimento troncato o un guasto nostro (`infra-permanente`): il job si ritenta
    // riscaricando e riverificando, e un binario che non ha superato entrambe le impronte non
    // diventa mai eseguibile (lo garantisce lo script, `preparazione.ts`).
    return await chiudiPerGuasto(d, job, {
      codice: guasto,
      classe: classeDaUscitaApparecchio(apparecchio.exitCode, apparecchio.stderr) ?? 'infra-transitoria',
      diagnosi: apparecchio.stderr,
    })
  }

  const letto = leggiApparecchio(apparecchio.stdout)

  // La build è integra: resta da sapere se sa fare ciò che le chiediamo. Sono due
  // domande diverse — `brew install ffmpeg` passa la prima e non ha `zscale`.
  const mancanze = mancanzeDellaBuild(letto.inventario)
  if (mancanze.length > 0) {
    return await chiudiPerGuasto(d, job, {
      codice: 'BUILD_INCOMPLETE',
      classe: 'infra-permanente',
      diagnosi: `mancano: ${mancanze.join(', ')}`,
    })
  }

  // ⚠️ IL BATTITO DEL PERCORSO CHE SI ERA ROTTO. La provvista della build è ciò che il
  // 29/09/2026 ha smesso di funzionare, e con i soli errori «nessun log» non distingue «la
  // build arriva» da «non è mai partito niente». `galleria` e `news` sono in
  // `EVENTI_PERSISTITI`: questa riga finisce in `app_log`. `ms` è il tempo dell'apparecchio
  // intero (provvista, inventario, HEAD e probe: un solo comando sincrono), misurato col
  // tetto dei 120 secondi che il piano gli ha dato.
  loggaEsito(job, 'info', {
    esito: 'build-pronta',
    ms: d.orologio.adesso() - inizioApparecchio,
  })

  const probe = parseVideoProbe(letto.probeGrezzo, letto.byte ?? -1)
  if (!probe.ok) {
    // `rejected`: il file non va bene. Non è la nostra infrastruttura, e riprovare
    // darebbe lo stesso identico risultato.
    return await chiudiPerGuasto(d, job, { codice: probe.code, classe: 'file', diagnosi: '' })
  }

  let argomenti: string[]
  try {
    argomenti = buildVideoEncodeArgs(probe.probe, opzioniCodifica(job))
  } catch (err) {
    // `buildVideoEncodeArgs` lancia su una geometria impossibile (meno di 2 px una
    // volta rientrati nel Full HD). È un `TypeError`, non un guasto: il file non si
    // può convertire.
    return await chiudiPerGuasto(d, job, {
      codice: 'ENCODE_FAILED',
      classe: 'file',
      diagnosi: '',
      causa: err,
    })
  }

  const scritturaArgomenti = await sessione.esegui({
    ...comandoScritturaArgomenti(argomenti),
    tettoMs: TETTO_COMANDO_BREVE_MS,
  })
  if (scritturaArgomenti.exitCode !== 0) {
    // Scrivere un file di poche righe nella MicroVM che ci ha appena risposto non può
    // dipendere dal video: è la MicroVM (disco, permessi), cioè un guasto nostro.
    return await chiudiPerGuasto(d, job, {
      codice: 'ENCODE_FAILED',
      classe: 'infra-transitoria',
      diagnosi: scritturaArgomenti.stderr,
    })
  }

  await sessione.avvia({
    ...conShell(scriptConversione({
      conWatermark: job.channel === 'gallery',
      videoIndex: probe.probe.videoStreamIndex,
      audioIndex: probe.probe.audioStreamIndex,
      sourceFps: probe.probe.fps,
    })),
    // ⚠️ `ambiente` e non l'env dell'apparecchio: gli indirizzi della build non entrano qui.
    env: ambiente,
    // Il tetto lo fa rispettare la MicroVM, non questo processo: è l'unico che
    // sopravvive alla fine dell'invocazione.
    tettoMs: TETTO_SANDBOX_MS,
  })
  return null
}

/**
 * La firma di uno dei due `.gz` della build non è stata rilasciata. Il bucket è nostro e
 * privato: un oggetto che non c'è (`NoSuchKey`) o un 4xx è un guasto che non passa da solo
 * (`infra-permanente`, log a livello `error` con la causa leggibile); un 5xx o una rete
 * caduta passano (`infra-transitoria`). Si ritentano entrambi.
 */
async function guastoDellaFirmaDellaBuild(
  d: DipendenzeRunner,
  job: JobVideo,
  firma: { motivo: string; stato?: number; codiceStorage?: string },
): Promise<EsitoRunnerVideo> {
  return await chiudiPerGuasto(d, job, {
    codice: 'BUILD_DOWNLOAD_FAILED',
    classe: classeDelDownload(firma.stato, firma.codiceStorage),
    diagnosi: firma.motivo,
    http: firma.stato ?? null,
  })
}

/** Legge il marcatore, verifica l'uscita, e solo allora dichiara il job pronto. */
async function concludi(
  d: DipendenzeRunner,
  job: JobVideo,
  marcatore: string,
  percorsoUscita: string,
): Promise<EsitoRunnerVideo> {
  const esito = leggiEsitoConversione(marcatore)
  const guasto = codiceDaUscitaConversione(esito.uscita)
  if (guasto) {
    return await chiudiPerGuasto(d, job, {
      codice: guasto,
      // 31 e 34 (scarico e caricamento) sono guasti di rete: si ritentano. 32, 33 e qualunque
      // uscita che non conosciamo no: FFmpeg che non riesce a convertire un file non lo
      // converte al tentativo dopo (D3).
      classe: classeDaUscitaConversione(esito.uscita, esito.diagnosi) ?? 'non-ritentabile',
      diagnosi: esito.diagnosi,
    })
  }

  const probe = parseVideoProbe(esito.probeSorgente, esito.byteSorgente ?? -1)
  if (!probe.ok) {
    return await chiudiPerGuasto(d, job, { codice: probe.code, classe: 'file', diagnosi: esito.diagnosi })
  }

  const verifica = verifyVideoOutput(
    probe.probe,
    esito.probeUscita,
    esito.byteUscita ?? -1,
    // `null` qui vorrebbe dire «il marcatore non diceva com'è andata la decodifica»:
    // si passa la prova peggiore possibile, e `verifyVideoOutput` risponde di no.
    esito.prova ?? { exitCode: 1, decodedFrames: 0 },
  )
  if (!verifica.ok) {
    if (verifica.code === 'OUTPUT_FPS_INVALID') {
      loggaEsito(job, 'error', {
        esito: 'verifica-temporale-fallita',
        error_code: esito.prova?.temporal?.reason ?? 'INVALID_EVIDENCE',
      })
    }
    return await chiudiPerGuasto(d, job, {
      codice: verifica.code,
      classe: 'file',
      diagnosi: esito.diagnosi,
    })
  }

  const scritto = await d.coda.pronto({
    jobId: job.id,
    fenceEpoch: job.fence_epoch,
    leaseOwner: d.leaseOwner,
    percorsoUscita,
    byteUscita: verifica.output.bytes,
    // ⚠️ IL PROBE DELLA SORGENTE, NON QUELLO DELL'USCITA, e costa una conversione
    // intera sbagliarlo. `video_jobs_probe_chk` e `video_job_ready` pretendono
    // `durationSeconds <= 180`, che è il limite dell'INGRESSO; l'uscita AAC può
    // legittimamente superarlo di qualche millisecondo — lo dice `verifyVideoOutput`
    // nella sua testata. Mandare l'uscita farebbe rispondere `BAD_INPUT` **dopo**
    // aver pagato la codifica, e solo sui video lunghi: cioè in produzione.
    probe: probe.probe,
  })

  if (!scritto.ok) {
    loggaEsito(job, 'error', { esito: 'esito-non-scritto', error_code: scritto.code })
    return { esito: 'esito-non-scritto', jobId: job.id, codice: scritto.code }
  }

  // ── LA CONSEGNA A NEWS ───────────────────────────────────────────────────
  //
  // Dopo il `ready` e non prima: si copia solo ciò che il database ha già accettato
  // come pronto, altrimenti un fallimento della scrittura lascerebbe nell'area di
  // sosta l'uscita di un job che non è mai esistito.
  //
  // Un fallimento qui NON annulla il `ready`: la conversione è riuscita davvero, e
  // dichiararla fallita vorrebbe dire rifarla da capo per un guasto di una copia.
  // Si grida, e la riconciliazione della retention conta gli allegati mancanti.
  if (job.channel === 'news') {
    if (!d.consegnaNews) {
      loggaEsito(job, 'error', { esito: 'consegna-news-non-configurata' })
    } else {
      const consegna = await d.consegnaNews(job, percorsoUscita, BUCKET_LAVORAZIONE)
      if (!consegna.ok) {
        loggaEsito(job, 'error', {
          esito: 'consegna-news-fallita',
          ...(consegna.codice ? { error_code: consegna.codice } : {}),
        })
      }
    }
  }

  // ⚠️ IL SUCCESSO SI LOGGA (AGENTS, regola 5). `galleria` e `news` sono entrambi in
  // `EVENTI_PERSISTITI`, quindi questa riga arriva anche in `app_log`: è l'unica cosa
  // che permette di rispondere a «ieri i video sono usciti?» con una query invece che
  // con un'opinione. `ritentato` dice se ci sono voluti più tentativi: dopo un guasto
  // nostro il video esce lo stesso, e senza questo campo il ritentativo riuscito è
  // indistinguibile dal primo colpo. Il campo entra anche nell'impronta (`distingui`):
  // i due casi dello stesso giorno non si sommano in una riga sola.
  loggaEsito(
    job,
    'info',
    {
      esito: 'video-convertito',
      ritentato: job.attempt > 1,
      byte: verifica.output.bytes,
      durata_s: Math.round(verifica.output.durationSeconds),
      larghezza: verifica.output.width,
      altezza: verifica.output.height,
      frame: verifica.output.decodedFrames,
    },
    undefined,
    { distingui: ['ritentato'] },
  )
  return { esito: 'pronto', jobId: job.id, byteUscita: verifica.output.bytes }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Utilità
 * ──────────────────────────────────────────────────────────────────────────── */

function opzioniCodifica(job: JobVideo): VideoEncodeOptions {
  if (job.channel === 'gallery') {
    return {
      channel: 'gallery',
      inputPath: INGRESSO,
      outputPath: USCITA,
      watermarkPath: WATERMARK,
    }
  }
  return { channel: 'news', inputPath: INGRESSO, outputPath: USCITA }
}

/**
 * «Ha finito?» è una domanda che si fa al filesystem della MicroVM, non a un oggetto
 * in memoria: vedi `ComandoInCorso` in `./porte.ts`.
 */
function marcatoreComeComando(sessione: SessioneSandbox): ComandoInCorso {
  return {
    esito: async () => {
      const letto = await sessione.esegui({
        ...comandoMarcatore(),
        tettoMs: TETTO_COMANDO_BREVE_MS,
      })
      return letto.exitCode === 0 ? letto : null
    },
    termina: async () => {
      await sessione.esegui({ ...comandoInterruzione(), tettoMs: TETTO_COMANDO_BREVE_MS })
    },
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL GUASTO E LA SUA CLASSE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Un guasto, com'è dichiarato da chi lo incontra.
 *
 *  · `codice` — quello che finisce in `video_jobs.error_code` / `last_error_code`;
 *  · `classe` — di chi è il guasto e se vale la pena riprovare (`./ritentativi.ts`);
 *  · `diagnosi` — lo stderr di curl e di ffmpeg: va nel log (ripulito, per la CODA), mai nel job;
 *  · `causa` — l'errore lanciato, quando il guasto è un'eccezione (la MicroVM che non si apre);
 *  · `http` — lo stato HTTP, quando chi chiama lo sa (la firma di Storage). Se manca e il
 *    guasto è nostro, si legge dalla diagnosi: è un'informazione per chi guarda il log, non
 *    ciò da cui si decide (la classe è già dichiarata).
 */
interface Guasto {
  codice: CodiceRunnerVideo | string
  classe: ClasseGuasto
  diagnosi: string
  causa?: unknown
  http?: number | null
}

/**
 * `app_log` deduplica per `(impronta, giorno)` e `ON CONFLICT` somma le occorrenze SENZA
 * aggiornare il `contesto`: la riga che sopravvive racconta il PRIMO caso. Dieci job che
 * falliscono lo stesso giorno per la stessa causa darebbero una riga sola, con dentro il job
 * del primo e un contatore; un job che si ritenta quattro volte, una riga sola con
 * `attempt = 1`. `distingui` fa entrare il job e il tentativo nell'impronta: uno per riga.
 * Il costo in volume è dichiarato: una riga per tentativo FALLITO, che sono pochi — non per
 * ogni giro del cron.
 */
const DISTINGUI_PER_TENTATIVO: OpzioniEvento = { distingui: ['job_id', 'attempt'] }

/** Lo stato HTTP del guasto per il log: quello dichiarato, o — per un guasto nostro — quello letto dalla diagnosi. */
function httpDelGuasto(g: Guasto): number | null {
  if (g.http !== undefined) return g.http
  return g.classe === 'infra-transitoria' || g.classe === 'infra-permanente'
    ? httpDallaDiagnosi(g.diagnosi)
    : null
}

/** I campi di log che descrivono il guasto. `http` solo se c'è: un campo nullo non dice niente. */
function campiDelGuasto(g: Guasto): Record<string, Valore> {
  const http = httpDelGuasto(g)
  return { error_code: g.codice, tipo: g.classe, ...(http !== null ? { http } : {}) }
}

/**
 * Che cosa si fa di un job che non è riuscito, deciso dalla CLASSE del guasto.
 *
 *  · `file` → `video_job_fail` con `rejected = true`: il filmato non va bene, e la famiglia
 *    deve poterlo sapere;
 *  · `non-ritentabile` → `video_job_fail` con `rejected = false`;
 *  · `infra-*` → `decidiRitentativo`: se ne restano, `video_job_retry`; a tentativi esauriti
 *    (il quarto, `attempt >= 4`) `video_job_fail`, e il log lo dice con `tentativi_esauriti`.
 *
 * Il motivo vero sta nell'errore passato al log, non nei campi: vedi `erroreDiagnostico`.
 */
async function chiudiPerGuasto(
  d: DipendenzeRunner,
  job: JobVideo,
  g: Guasto,
): Promise<EsitoRunnerVideo> {
  if (g.classe === 'file') return await fallisci(d, job, g, { rifiutato: true })
  if (g.classe === 'non-ritentabile') return await fallisci(d, job, g, { rifiutato: false })

  const decisione = decidiRitentativo(job.attempt, g.classe)
  if (!decisione.ritenta) {
    return await fallisci(d, job, g, {
      rifiutato: false,
      // Solo se i tentativi sono davvero finiti: un `attempt` illeggibile fallisce chiuso
      // senza essere spacciato per «esauriti» (vedi `decidiRitentativo`).
      tentativiEsauriti: decisione.motivo === 'tentativi-esauriti',
    })
  }
  return await riprova(d, job, g, decisione)
}

/**
 * Rimette in coda il job per un guasto nostro, e legge la risposta del database per quello
 * che dice (vedi `CodaVideo.riprova`).
 *
 * Il log `conversione-da-riprovare` si scrive DOPO la risposta e solo se il job è davvero in
 * coda: dire «riprovo» di un job che il database non ha rimesso in coda sarebbe una bugia, e
 * il caso opposto — la chiamata non arrivata — ha i suoi log.
 *
 * ⚠️ IL RIPIEGO È SOLO PER `RPC_ERROR`, e non è una cautela generica. Quel codice vuol dire che
 * la richiesta non è andata a buon fine: trasporto, oppure la funzione non esiste perché la
 * migrazione non è applicata. Senza il ripiego il job resterebbe `processing` con la lease che
 * scade, e una MicroVM ripartirebbe ogni cinque minuti, per giorni, su un guasto che nessuno
 * ha scritto da nessuna parte. Con `video_job_fail` il job si chiude e l'insegnante lo sa.
 *
 * Qualunque altro codice (`FENCE_MISMATCH`, `LEASE_MISMATCH`, `LEASE_EXPIRED`,
 * `INVALID_STATE`…) è un VERDETTO: il database ha risposto, e ha detto che il job non è più
 * nostro. Scrivere un fallimento «per pulizia» vorrebbe dire non aver capito di chi è il job:
 * come per un battito rifiutato, si torna indietro con `lease-persa`.
 */
async function riprova(
  d: DipendenzeRunner,
  job: JobVideo,
  g: Guasto,
  decisione: { attesaSecondi: number; tentativiMassimi: number },
): Promise<EsitoRunnerVideo> {
  const esito = await d.coda.riprova({
    jobId: job.id,
    fenceEpoch: job.fence_epoch,
    leaseOwner: d.leaseOwner,
    codice: g.codice,
    tentativiMassimi: decisione.tentativiMassimi,
    attesaSecondi: decisione.attesaSecondi,
  })

  if (esito.ok && esito.job.status === 'queued') {
    // «Permanente» descrive la CAUSA, non la decisione: si ritenta lo stesso, ma una causa
    // che da sola non passa (un oggetto che manca, un'impronta che non torna) si grida.
    loggaEsito(
      job,
      g.classe === 'infra-permanente' ? 'error' : 'warn',
      {
        esito: 'conversione-da-riprovare',
        ...campiDelGuasto(g),
        tentativi_massimi: decisione.tentativiMassimi,
        attesa_s: decisione.attesaSecondi,
      },
      g.causa ?? erroreDiagnostico(g.codice, g.diagnosi),
      DISTINGUI_PER_TENTATIVO,
    )
    return {
      esito: 'in-riprova',
      jobId: job.id,
      codice: g.codice,
      tentativo: job.attempt,
      attesaS: decisione.attesaSecondi,
    }
  }

  if (esito.ok) {
    // Il database ha risposto `ok` ma il job NON è in coda: ha delegato a `video_job_fail`
    // (i tentativi per lui sono finiti, o il job era già chiuso). Il fallimento è già scritto
    // — richiamare `video_job_fail` darebbe `ERROR_CONFLICT` o un doppio — e si racconta come
    // definitivo, perché lo è.
    registraFallimento(job, g, { rifiutato: false, tentativiEsauriti: true })
    return { esito: 'fallito', jobId: job.id, codice: g.codice, rifiutato: false }
  }

  if (esito.code === 'RPC_ERROR') {
    loggaEsito(
      job,
      'error',
      { esito: 'riprova-non-scritta', error_code: esito.code, tipo: g.classe },
      undefined,
      DISTINGUI_PER_TENTATIVO,
    )
    return await fallisci(d, job, g, { rifiutato: false })
  }

  // Un verdetto. La diagnosi di QUESTO tentativo non si butta: il job passa a un altro
  // worker, ma il motivo per cui questo è fallito resta l'unica traccia.
  loggaEsito(
    job,
    'warn',
    { esito: 'riprova-rifiutata', error_code: esito.code, tipo: g.classe },
    g.causa ?? erroreDiagnostico(g.codice, g.diagnosi),
    DISTINGUI_PER_TENTATIVO,
  )
  return { esito: 'lease-persa', jobId: job.id, codice: esito.code }
}

/** Racconta un fallimento definitivo nei log. Il motivo vero sta nell'errore, non nei campi. */
function registraFallimento(
  job: JobVideo,
  g: Guasto,
  esito: { rifiutato: boolean; tentativiEsauriti?: boolean },
): void {
  loggaEsito(
    job,
    'error',
    {
      esito: 'conversione-fallita',
      ...campiDelGuasto(g),
      rifiutato: esito.rifiutato,
      ...(esito.tentativiEsauriti ? { tentativi_esauriti: true } : {}),
    },
    g.causa ?? erroreDiagnostico(g.codice, g.diagnosi),
    DISTINGUI_PER_TENTATIVO,
  )
}

/** Scrive il fallimento sul job (`video_job_fail`) e lo racconta. */
async function fallisci(
  d: DipendenzeRunner,
  job: JobVideo,
  g: Guasto,
  esito: { rifiutato: boolean; tentativiEsauriti?: boolean },
): Promise<EsitoRunnerVideo> {
  registraFallimento(job, g, esito)

  const scritto = await d.coda.fallito({
    jobId: job.id,
    fenceEpoch: job.fence_epoch,
    leaseOwner: d.leaseOwner,
    codice: g.codice,
    rifiutato: esito.rifiutato,
  })
  if (!scritto.ok) {
    loggaEsito(job, 'error', { esito: 'fallimento-non-scritto', error_code: scritto.code })
  }
  return { esito: 'fallito', jobId: job.id, codice: g.codice, rifiutato: esito.rifiutato }
}

async function fermaSessione(job: JobVideo, sessione: SessioneSandbox): Promise<void> {
  try {
    await sessione.ferma()
  } catch (err) {
    // Una MicroVM che non si spegne si paga a `GB × ore` finché il suo `timeout` non
    // scatta: è mezz'ora di conto che nessuno vedrebbe, se questa riga non ci fosse.
    loggaEsito(job, 'error', { esito: 'microvm-non-spenta' }, err)
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA CODA DELL'ERRORE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Il tetto di UNA riga prima che passi da `sanificaMessaggio`: `MESSAGGIO_MAX × 7/9`, cioè 388.
 *
 * Il peggio che la sanificazione sa fare a un testo è ALLUNGARLO, e di poco: la maschera
 * `"[valore]"` trasforma le 28 battute più corte di un `invalid input syntax for : ""` in 36
 * (il rapporto massimo, 9/7), e un'email di sei battute diventa `[email]`, di sette (7/6).
 * Una riga lunga al massimo 388 battute resta quindi sotto i 500 (`388 × 9/7 = 498,9`), e
 * `sanificaMessaggio` non ha mai niente da tagliare. Se un domani una maschera crescesse di
 * più, il test `video-runner-orchestrazione` lo scopre: misura il caso peggiore contro questo
 * tetto.
 */
const RIGA_MAX = Math.floor((MESSAGGIO_MAX * 7) / 9)

/**
 * Quanta diagnosi si guarda prima di sanificarla: quattro volte il budget del messaggio. Le
 * maschere RESTRINGONO quasi sempre (un codice fiscale di 16 battute diventa `[cf]`, di 4),
 * quindi si parte da più testo di quanto ne serva, perché dopo ne restino abbastanza per
 * riempire il messaggio; e dietro non si legge un megabyte di stderr.
 */
const FINESTRA_DIAGNOSI = MESSAGGIO_MAX * 4

/**
 * La CODA della diagnosi, ripulita e sanificata, con in fondo — INTATTO — l'ultimo testo che
 * lo strumento ha scritto: nel log di una riga dura al massimo `MESSAGGIO_MAX - 1` battute.
 *
 * ⚠️ L'ORDINE È LA SOSTANZA, e l'ha già pagato questo repository. `sanificaMessaggio`
 * (`serialize.ts`) TAGLIA TENENDO L'INIZIO: oltre 500 battute butta la fine. Ma maschera
 * anche — e mascherare ALLUNGA: `[email]` è una battuta più di un'email di sei, `"[valore]"` ne
 * aggiunge fino a otto. Una coda tagliata a 499 PRIMA della sanificazione, con qualche
 * email corta dentro, ne usciva più lunga di 500: e il taglio finale buttava la FINE — la riga
 * `curl: (22) … returned error: 404`, cioè proprio il motivo.
 *
 * Perciò qui si sanifica PRIMA e si prende la coda DOPO:
 *
 *  1. `codaDiagnostica` ripulisce (URL, JWT, metadati personali, coordinate, progresso) e
 *     tiene gli ultimi `FINESTRA_DIAGNOSI` caratteri;
 *  2. RIGA PER RIGA, `sanificaMessaggio` (email, codici fiscali, vincoli di Postgres) — una
 *     riga alla volta perché taglia dall'inizio, e una riga lunga più di `RIGA_MAX` si
 *     accorcia prima, tenendone la fine, così che non ci sia mai niente da tagliare;
 *  3. `codaDiagnostica(…, MESSAGGIO_MAX - 1)` prende le ultime battute del testo già
 *     sanificato, con l'ellissi davanti se ha tagliato.
 *
 * Il logger poi risanifica il messaggio per conto suo (è la sua rete di sicurezza). Su un
 * testo già sanificato non cambia niente — `sanificaMessaggio` è idempotente, e il test lo
 * misura su ogni forma che maschera — e dunque neppure il taglio ha più niente da togliere.
 */
function codaSanificata(diagnosi: string): string {
  const sanificata = codaDiagnostica(diagnosi, FINESTRA_DIAGNOSI)
    .split('\n')
    .map((riga) => sanificaMessaggio(riga.length > RIGA_MAX ? codaDiagnostica(riga, RIGA_MAX) : riga))
    .join('\n')
  return codaDiagnostica(sanificata, MESSAGGIO_MAX - 1)
}

/**
 * Il corpo dell'errore non si butta via.
 *
 * La diagnosi è lo stderr di `curl` e di `ffmpeg`, ed è l'unica cosa che dice
 * *perché*: «403» non è niente, «403 the domain is not verified» è la soluzione. Va
 * nel MESSAGGIO e non nei campi, per la stessa ragione di `externalFetch`: `redact`
 * è a lista bianca per chiave, e in `app_log` un campo `diagnosi` uscirebbe come
 * `[redatto:str/…]`, cioè illeggibile proprio dove serve. Passata come errore
 * diventa `app_log.messaggio`, in chiaro e sanificato.
 *
 * ⚠️ DELLO STDERR SI TIENE LA CODA, NON L'INIZIO. Fino al 2026-10-02 qui c'era un
 * `slice(0, 1000)`, e il 29/09 un `curl: (22) … returned error: 404` è rimasto in fondo
 * a una pagina di `dnf` mai letta da nessuno: 17 job falliti e nessun log che dicesse
 * perché. Gli strumenti scrivono ciò che è andato storto per ULTIMO. Come la coda si ripulisce
 * e come sopravvive al taglio del logger sta in `codaSanificata`.
 *
 * Gli URL, i JWT e i metadati del filmato (coordinate GPS comprese) spariscono prima, in
 * `codaDiagnostica`: portano un token che autorizza a leggere il video di un bambino o
 * dicono dove è stato ripreso, e `app_log` dura trenta giorni.
 *
 * Esportata per i test: il logger la vede solo come `Error`, e `rigaEvento` — la parte
 * decidibile del logging — è ciò che mostra che cosa finisce in `app_log.messaggio`.
 */
export function erroreDiagnostico(codice: string, diagnosi: string): Error {
  const testo = codaSanificata(diagnosi)
  const err = new Error(testo === '' ? codice : testo)
  err.name = 'VideoRunnerError'
  Object.assign(err, { code: codice })
  return err
}

/**
 * La riga di dominio del job.
 *
 * ⚠️ L'evento si scrive LETTERALE nei due rami invece che con una variabile, e non è
 * verbosità: il lock `__tests__/architecture/eventi-log.test.ts` estrae i nomi con
 * `logEvento\(\s*'([a-z_]+)'`. Un nome dinamico non è vietato — è **invisibile**, e
 * un evento che nessun lock guarda è esattamente come è nato il difetto che quel
 * lock esiste per impedire.
 *
 * Nei campi finiscono solo uuid, numeri, booleani e chiavi in lista bianca: il
 * percorso dello Storage, il nome del file e il MIME dichiarato non ci sono. Sono
 * video di bambini, e `app_log` è interrogabile in SQL per trenta giorni.
 *
 * `opzioni.distingui` fa entrare nell'impronta di `app_log` i campi che dichiara (vedi
 * `DISTINGUI_PER_TENTATIVO`), perché la deduplica per giorno non faccia sparire i casi dopo il
 * primo.
 */
function loggaEsito(
  job: JobVideo,
  livello: Livello,
  campi: Record<string, Valore>,
  err?: unknown,
  opzioni?: OpzioniEvento,
): void {
  const comuni: Record<string, Valore> = {
    operazione: 'video-runner',
    canale: job.channel,
    job_id: job.id,
    intent_id: job.intent_id,
    sede_id: job.scuola_id,
    attempt: job.attempt,
    fence_epoch: job.fence_epoch,
    ...campi,
  }
  if (job.channel === 'gallery') logEvento('galleria', livello, comuni, err, opzioni)
  else logEvento('news', livello, comuni, err, opzioni)
}
