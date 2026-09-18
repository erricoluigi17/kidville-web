import { logEvento, type Livello, type Valore } from '@/lib/logging/logger'

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
import {
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
  senzaUrl,
} from './script'

/**
 * IL GIRO DEL WORKER — dalla coda all'esito, una volta.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COME GIRA, DETTO UNA VOLTA SOLA
 *
 * Questa funzione è pensata per essere chiamata da un cron, ogni minuto, e per
 * fare **un pezzo** di lavoro e tornare. Non converte un video: porta avanti una
 * conversione finché ha tempo, e se non basta se ne va lasciandola accesa.
 *
 *   1. C'è un job ancora mio, rimasto a metà da un'invocazione precedente?
 *      Ha la precedenza. Si riprende con `video_job_claim` sullo STESSO
 *      `lease_owner`: con la lease ancora viva la RPC è idempotente e restituisce
 *      lo stesso `fence_epoch` — quindi lo stesso nome di Sandbox, quindi la stessa
 *      MicroVM, che nel frattempo ha continuato a convertire.
 *   2. Altrimenti si pesca dalla coda con `video_job_next`.
 *   3. Si aprono gli indirizzi firmati, POI la MicroVM (in quest'ordine: una
 *      MicroVM aperta per scoprire che lo Storage dice di no è un conto pagato per
 *      niente).
 *   4. Se la MicroVM è NUOVA si apparecchia e si avvia la conversione; se è stata
 *      riagganciata, la conversione sta già girando e non si tocca niente.
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
 */

/** Dove vivono le uscite. `video_job_ready` impone comunque questo bucket. */
const BUCKET_LAVORAZIONE = 'video_processing'

/**
 * Quanto durano gli indirizzi firmati: due ore, come la validità che Supabase dà da
 * sé a un URL di scrittura. Devono sopravvivere a tutta la conversione — che con il
 * tetto della MicroVM è al massimo mezz'ora — e non un minuto di più del necessario.
 */
const SECONDI_FIRMA = 7200

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
}

export type EsitoRunnerVideo =
  | { esito: 'coda-vuota' }
  | { esito: 'presa-rifiutata'; codice: string }
  | { esito: 'in-corso'; jobId: string }
  | { esito: 'pronto'; jobId: string; byteUscita: number }
  | { esito: 'fallito'; jobId: string; codice: string; rifiutato: boolean }
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
    return await fallisci(d, job, 'SOURCE_DOWNLOAD_FAILED', false, lettura.motivo)
  }
  const scrittura = await d.archivio.urlScrittura(BUCKET_LAVORAZIONE, percorsoUscita)
  if (!scrittura.ok) {
    return await fallisci(d, job, 'OUTPUT_UPLOAD_FAILED', false, scrittura.motivo)
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
    // tre riparazioni diverse.
    return await fallisci(d, job, 'SANDBOX_UNAVAILABLE', false, '', err)
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
 * Apparecchia la MicroVM e stacca la conversione. Restituisce un esito SOLO se
 * qualcosa è andato storto: `null` significa «la conversione è partita».
 */
async function apparecchiaEAvvia(
  d: DipendenzeRunner,
  job: JobVideo,
  sessione: SessioneSandbox,
  ambiente: Record<string, string>,
): Promise<EsitoRunnerVideo | null> {
  const apparecchio = await sessione.esegui({
    ...conShell(scriptApparecchio()),
    env: ambiente,
    tettoMs: TETTO_APPARECCHIO_MS,
  })

  const guasto = codiceDaUscitaApparecchio(apparecchio.exitCode)
  if (guasto) {
    // ⚠️ `BUILD_HASH_MISMATCH` finisce qui, e qui si ferma. Non c'è nessun ramo che
    // riprovi lo scarico: se l'archivio che è arrivato non è quello misurato, o la
    // release è cambiata sotto i piedi o qualcuno sta servendo altro. In entrambi i
    // casi la riparazione è che una persona guardi, non che una macchina insista.
    return await fallisci(d, job, guasto, false, apparecchio.stderr)
  }

  const letto = leggiApparecchio(apparecchio.stdout)

  // La build è integra: resta da sapere se sa fare ciò che le chiediamo. Sono due
  // domande diverse — `brew install ffmpeg` passa la prima e non ha `zscale`.
  const mancanze = mancanzeDellaBuild(letto.inventario)
  if (mancanze.length > 0) {
    return await fallisci(d, job, 'BUILD_INCOMPLETE', false, `mancano: ${mancanze.join(', ')}`)
  }

  const probe = parseVideoProbe(letto.probeGrezzo, letto.byte ?? -1)
  if (!probe.ok) {
    // `rejected`: il file non va bene. Non è la nostra infrastruttura, e riprovare
    // darebbe lo stesso identico risultato.
    return await fallisci(d, job, probe.code, true, '')
  }

  let argomenti: string[]
  try {
    argomenti = buildVideoEncodeArgs(probe.probe, opzioniCodifica(job))
  } catch (err) {
    // `buildVideoEncodeArgs` lancia su una geometria impossibile (meno di 2 px una
    // volta rientrati nel Full HD). È un `TypeError`, non un guasto: il file non si
    // può convertire.
    return await fallisci(d, job, 'ENCODE_FAILED', true, '', err)
  }

  const scritturaArgomenti = await sessione.esegui({
    ...comandoScritturaArgomenti(argomenti),
    tettoMs: TETTO_COMANDO_BREVE_MS,
  })
  if (scritturaArgomenti.exitCode !== 0) {
    return await fallisci(d, job, 'ENCODE_FAILED', false, scritturaArgomenti.stderr)
  }

  await sessione.avvia({
    ...conShell(scriptConversione({ conWatermark: job.channel === 'gallery' })),
    env: ambiente,
    // Il tetto lo fa rispettare la MicroVM, non questo processo: è l'unico che
    // sopravvive alla fine dell'invocazione.
    tettoMs: TETTO_SANDBOX_MS,
  })
  return null
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
  if (guasto) return await fallisci(d, job, guasto, false, esito.diagnosi)

  const probe = parseVideoProbe(esito.probeSorgente, esito.byteSorgente ?? -1)
  if (!probe.ok) return await fallisci(d, job, probe.code, true, esito.diagnosi)

  const verifica = verifyVideoOutput(
    probe.probe,
    esito.probeUscita,
    esito.byteUscita ?? -1,
    // `null` qui vorrebbe dire «il marcatore non diceva com'è andata la decodifica»:
    // si passa la prova peggiore possibile, e `verifyVideoOutput` risponde di no.
    esito.prova ?? { exitCode: 1, decodedFrames: 0 },
  )
  if (!verifica.ok) return await fallisci(d, job, verifica.code, true, esito.diagnosi)

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

  // ⚠️ IL SUCCESSO SI LOGGA (AGENTS, regola 5). `galleria` e `news` sono entrambi in
  // `EVENTI_PERSISTITI`, quindi questa riga arriva anche in `app_log`: è l'unica cosa
  // che permette di rispondere a «ieri i video sono usciti?» con una query invece che
  // con un'opinione.
  loggaEsito(job, 'info', {
    esito: 'video-convertito',
    byte: verifica.output.bytes,
    durata_s: Math.round(verifica.output.durationSeconds),
    larghezza: verifica.output.width,
    altezza: verifica.output.height,
  })
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

/** Scrive il fallimento sul job e lo racconta. Il motivo vero sta nell'errore, non nei campi. */
async function fallisci(
  d: DipendenzeRunner,
  job: JobVideo,
  codice: CodiceRunnerVideo | string,
  rifiutato: boolean,
  diagnosi: string,
  causa?: unknown,
): Promise<EsitoRunnerVideo> {
  loggaEsito(job, 'error', { esito: 'conversione-fallita', error_code: codice, rifiutato }, causa ?? erroreDiagnostico(codice, diagnosi))

  const scritto = await d.coda.fallito({
    jobId: job.id,
    fenceEpoch: job.fence_epoch,
    leaseOwner: d.leaseOwner,
    codice,
    rifiutato,
  })
  if (!scritto.ok) {
    loggaEsito(job, 'error', { esito: 'fallimento-non-scritto', error_code: scritto.code })
  }
  return { esito: 'fallito', jobId: job.id, codice, rifiutato }
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
 * Gli URL spariscono prima (`senzaUrl`): portano un token che autorizza a leggere il
 * video di un bambino, e `app_log` dura trenta giorni.
 */
function erroreDiagnostico(codice: string, diagnosi: string): Error {
  const testo = senzaUrl(diagnosi).trim().slice(0, 1000)
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
 */
function loggaEsito(
  job: JobVideo,
  livello: Livello,
  campi: Record<string, Valore>,
  err?: unknown,
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
  if (job.channel === 'gallery') logEvento('galleria', livello, comuni, err)
  else logEvento('news', livello, comuni, err)
}
