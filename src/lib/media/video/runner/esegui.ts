import {
  logEvento,
  type Livello,
  type OpzioniEvento,
  type Valore,
} from '@/lib/logging/logger'
import { MESSAGGIO_MAX, sanificaMessaggio } from '@/lib/logging/serialize'

import {
  BUCKET_BUILD_VIDEO,
  CARTELLA_BINARI_NELLO_SNAPSHOT,
  PERCORSO_FFMPEG_GZ,
  PERCORSO_FFPROBE_GZ,
} from '../build'
import { BUCKET_ORIGINALI_VIDEO } from '../contratto'
import { buildVideoEncodeArgs, type VideoEncodeOptions } from '../encode'
import { parseVideoProbe, type VideoProbe } from '../probe'
import { diagnosiVerifica, verifyVideoOutput, type VideoOutputVerificationErrorCode } from '../verify'
import {
  MOTIVI_AMBIENTE_ASSENTE,
  erroreSanificatoPerIlLog,
  fattiDellErrore,
  type ModalitaAmbiente,
} from './ambiente'
import {
  SECONDI_LEASE_PRESA,
  TETTO_INVOCAZIONE_MS,
  TETTO_SANDBOX_MS,
  sorvegliaConversione,
} from './battito'
import type { CodiceRunnerVideo } from './codici'
import { codaDiagnostica } from './diagnosi'
import {
  CARTELLA_BUILD,
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
  type EsitoComando,
  type JobVideo,
  type MacchinaSandbox,
  type Orologio,
  type SessioneSandbox,
} from './porte'
import {
  ATTESE_FRA_TENTATIVI_S,
  TENTATIVI_MASSIMI_GUASTO_NOSTRO,
  classeDaUscitaApparecchio,
  classeDaUscitaConversione,
  classeDelDownload,
  decidiRitentativo,
  httpDallaDiagnosi,
  type ClasseGuasto,
} from './ritentativi'
import {
  ENV_SHA256_ATTESO,
  ENV_URL_INGRESSO,
  ENV_URL_USCITA,
  ENV_URL_WATERMARK,
  INGRESSO,
  USCITA,
  USCITE_APPARECCHIO,
  WATERMARK,
  codiceDaUscitaApparecchio,
  codiceDaUscitaConversione,
  comandoInterruzione,
  comandoMarcatore,
  comandoScritturaArgomenti,
  leggiApparecchio,
  leggiEsitoConversione,
  leggiSha256Dichiarato,
  scriptApparecchio,
  scriptConversione,
  type LetturaEsitoConversione,
} from './script'

/**
 * IL GIRO DEL WORKER — dalla coda all'esito, una volta.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COME GIRA, DETTO UNA VOLTA SOLA
 *
 * Questa funzione fa **un pezzo** di lavoro e torna. Non converte un video: porta avanti una
 * conversione finché ha tempo, e se non basta se ne va lasciandola accesa. Si chiama in due modi
 * (PR 2, spec `docs/superpowers/specs/2026-10-02-video-pr2-pubblicazione-server-design.md`, §9):
 *
 *  · CON un `job_id` — è un CALCIO: il trigger d'arrivo dell'originale, il `PATCH caricato`, o il
 *    ventaglio del giro qui sotto dicono «questo job ha bisogno di qualcuno». Parte subito, senza
 *    aspettare il cron.
 *  · SENZA — è il GIRO del cron, ogni cinque minuti, che resta la rete di sicurezza di tutto il
 *    resto (un calcio perso, un'invocazione morta).
 *
 * Il percorso CON `job_id`:
 *
 *   1. `video_job_sorveglianza_prendi`: una sola invocazione per job lo sorveglia. Chi non la ottiene
 *      risponde `gia-sorvegliato` — un esito TRANQUILLO — e se ne va. Due invocazioni sullo stesso
 *      Sandbox leggevano entrambe il marcatore e chiamavano entrambe `video_job_ready`: la seconda
 *      prendeva un `OUTPUT_CONFLICT` su una conversione riuscita, cioè un `error` su un successo.
 *   2. `video_job_prendi` (col tetto delle conversioni in parallelo, `CAPACITA_PIENA` se è pieno).
 *   3. Si lavora sul job (qui sotto).
 *   4. Nel `finally` si rilascia la sorveglianza, comunque sia andata: anche con `in-corso`, perché
 *      chi riaggancia la MicroVM dopo di noi non deve aspettare che la lease scada.
 *
 * Il GIRO (senza `job_id`), nell'ordine:
 *
 *   1. `video_arrivi_recupera`: la rete del trigger d'arrivo (job con l'originale già caricato che
 *      nessuno ha portato in coda);
 *   2. un job ancora mio, rimasto a metà da un'invocazione precedente e che nessuno sorveglia, ha la
 *      precedenza: se ne prende la sorveglianza SUBITO, prima del ventaglio, così il ventaglio non
 *      lo calcia (sarebbe un'invocazione sprecata);
 *   3. `video_runner_ventaglio`: un calcio per ogni altro job che ha bisogno di sorveglianza;
 *   4. IL PUNTO D'AGGANCIO DELLE PUBBLICAZIONI (`DipendenzeRunner.pubblicazioni`, di T7);
 *   5. si lavora sul job di cui al punto 2 (si riprende con `video_job_prendi` sullo STESSO
 *      `lease_owner`: con la lease ancora viva la RPC è idempotente e restituisce lo stesso
 *      `fence_epoch` — quindi lo stesso nome di Sandbox, quindi la stessa MicroVM, che nel
 *      frattempo ha continuato a convertire), oppure si pesca dalla coda con `video_job_prossimo`.
 *      Un job rimesso in coda da un guasto nostro (vedi sotto) non viene scelto finché non scade la
 *      sua attesa.
 *
 * Lavorare su un job, dopo la presa:
 *
 *   1. Si aprono gli indirizzi firmati, POI la MicroVM (in quest'ordine: una
 *      MicroVM aperta per scoprire che lo Storage dice di no è un conto pagato per
 *      niente).
 *   2. Se la MicroVM è NUOVA si firmano i due `.gz` della build, si apparecchia e si
 *      avvia la conversione; se è stata riagganciata, la conversione sta già girando e
 *      non si tocca niente — nemmeno la build, che non si firma.
 *   3. Si sorveglia col battito finché non finisce, finché non si perde la lease,
 *      o finché non finisce il tempo di QUESTA invocazione: `240 s` meno quello che ne è già stato
 *      speso (il giro prima, l'apertura della MicroVM e l'apparecchio poi).
 *   4. Si verifica l'uscita e solo allora si scrive `video_job_ready`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * L'AMBIENTE PRONTO, LO `sha256` DICHIARATO E LA DIAGNOSI (PR 2, compito T8)
 *
 *  · **Da dove nasce la MicroVM** (`./ambiente.ts`, spec §10.1). Se esiste uno SNAPSHOT (`VIDEO_SANDBOX_SNAPSHOT_ID`)
 *    la MicroVM nasce da lì, con `curl` e i due binari di FFmpeg già in `/opt/kv-ffmpeg`: l'apparecchio li VERIFICA con
 *    `sha256sum` (le impronte di `build.ts`, le stesse della provvista) invece di scaricarli, e NON si firma niente del
 *    bucket `video_build`. Se i binari non tornano (uscita 26) si ripiega NELLA STESSA MicroVM con la provvista dal bucket
 *    — `curl` c'è — e si grida (`ambiente-pronto-assente`, motivo `BINARI_NON_VERIFICATI`). Se lo snapshot non c'è si apre
 *    la MicroVM della PR 1, invariata, e a gridarlo è `apriLaMicroVm`. Il modo in cui l'ambiente è diventato pronto — `snapshot`,
 *    `ripiego-vm`, `ripiego-runtime` — e il suo tempo sono nel log `ambiente-pronto`.
 *  · **Lo `sha256` dichiarato** (caricamento nativo, spec §10.4). Se la riga del job porta un'impronta, la conversione la
 *    riceve nell'AMBIENTE e la verifica sull'originale scaricato PRIMA di convertire: se è diversa esce 35 e il job è
 *    `ORIGINALE_DIVERSO`, classe `file`, MAI ritentato. Un valore che non è un'impronta non si salta in silenzio: il job è
 *    rifiutato prima di aprire qualunque cosa. L'impronta non entra in nessun log.
 *  · **La diagnosi di una verifica fallita** (spec §10.5). Prima di chiudere il job si scrivono i NUMERI del rifiuto
 *    (`video_job_diagnosi`): se la scrittura non riesce si logga e il rifiuto resta com'è.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IL TESTIMONE: perché un'invocazione che se ne va con `in-corso` ne chiama un'altra
 *
 * Una conversione più lunga di un'invocazione passa di mano. Prima della PR 2 il passaggio era del
 * cron, e reggeva per costruzione: i tick partivano esattamente ogni 300 s, la sorveglianza durava
 * 240 s e la lease dura 300 s dall'ULTIMO battito, quindi il tick dopo trovava sempre la lease viva.
 * Con i calci la fase non è più quella del cron: una sorveglianza partita a un istante qualunque
 * finisce a un istante qualunque, e un tick che cade DURANTE la sorveglianza trova il job
 * sorvegliato e lo salta. Il tick dopo arriva fino a 300 s più tardi, e alla conversione ne restano
 * meno di 300 dall'ultimo battito: in una frazione dei passaggi (nell'ordine di uno su cinque) la
 * lease è già scaduta, e il job si rifà da capo — un tentativo bruciato, e il vecchio Sandbox acceso
 * a vuoto fino al suo tetto. Perciò, DOPO aver rilasciato la sorveglianza, un'invocazione che esce
 * con `in-corso` rifà il ventaglio: chi riaggancia parte nel secondo successivo invece che al
 * prossimo tick, e il cron torna ad essere la rete di sicurezza che deve essere.
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
 *     job in coda con un'attesa (5, 10, 15 minuti), fino a quattro tentativi in tutto. Anche
 *     all'ULTIMO tentativo si chiama `video_job_retry` (secondario #23, dal PR 2): è la RPC a
 *     riconoscere i tentativi finiti, ad annotare `last_error_code` col codice dell'ultimo guasto
 *     e a delegare a `video_job_fail`. Chiamando `video_job_fail` direttamente, `last_error_code`
 *     restava quello del ritentativo prima, e il commento della colonna dice il contrario.
 *
 * Quanto aspettare e quando smettere lo dice `./ritentativi.ts`, che è fatto di funzioni
 * pure. Qui si orchestra, e si scrive nei log ciò che è successo — compresa la CODA
 * dell'errore (`erroreDiagnostico`), perché era l'inizio ciò che si salvava e l'inizio non
 * diceva niente.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * UN'ECCEZIONE DELL'SDK DEL SANDBOX È UN GUASTO NOSTRO (secondario #33)
 *
 * `sessione.esegui` e `sessione.avvia` sono l'SDK di Vercel: possono lanciare (la MicroVM scaduta
 * o fermata da fuori, un'API che non risponde). Fino al PR 2 l'eccezione usciva da
 * `eseguiUnJobVideo`: il job restava `processing` fino alla scadenza della lease e veniva ripreso
 * con `attempt + 1` senza attesa né tetto. Adesso `senzaEccezioniDellSdk` le riconosce — e SOLO
 * quelle: un'eccezione di un altro punto resta un'eccezione — e le dichiara `infra-transitoria`,
 * quindi passano da `riprova` come ogni altro guasto nostro.
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

/**
 * Quanto dura la lease di SORVEGLIANZA di un job: 270 secondi.
 *
 * `TETTO_INVOCAZIONE_MS` (240 s) più 30 di margine: deve sopravvivere a tutta la sorveglianza di
 * QUESTA invocazione — che, contando anche il tempo speso prima, non supera i 240 s dal suo inizio
 * — e non molto di più, perché se l'invocazione muore senza rilasciarla (il processo ucciso a metà)
 * è la scadenza della lease a liberare il job per chi viene dopo. La RPC accetta da 1 a 900 secondi:
 * il test `video-runner-battito` rilegge quel limite dalla migrazione.
 */
export const SECONDI_SORVEGLIANZA = 270

/**
 * Quanti arrivi mancati recupera `video_arrivi_recupera` per giro. La RPC accetta da 1 a 200; il
 * caso normale è ZERO (il trigger d'arrivo li ha già portati in coda), e a ogni giro se ne
 * guardano al più cinquanta, **dal più recente**.
 *
 * ⚠️ DAL PIÙ RECENTE, non dal più vecchio (secondario #71, ondata B, corretto in #128). Un candidato che il
 * giro non riesce a risolvere — metadati senza dimensione o senza mime, un file vuoto di una News, un'eccezione
 * sempre uguale — resta candidato a ogni giro finché l'abbandono (48 ore) non lo chiude. Dal più vecchio, una
 * fila di questi occuperebbe tutta la finestra di cinquanta posti e terrebbe FUORI proprio l'arrivo che il trigger
 * non ha visto, cioè quello per cui la rete esiste. Il costo, dichiarato dalla RPC: sotto un arretrato più lungo
 * di cinquanta i più vecchi aspettano il giro dopo. Il segno che il limite sta mordendo è un `non_risolti` alto e
 * stabile, ed è il numero che `recuperaGliArrivi` porta nel registro.
 */
const LIMITE_ARRIVI_PER_GIRO = 50

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
  /**
   * L'identità di QUESTA invocazione, un uuid NUOVO a ogni chiamata (`crypto.randomUUID()` in
   * `index.ts`): è l'esatto contrario del `leaseOwner`. Il `lease_owner` è uguale per tutte le
   * invocazioni, quindi non può dire chi sorveglia; la lease di sorveglianza porta questo, e solo
   * l'invocazione che l'ha presa può rilasciarla.
   */
  invocazione: string
  /**
   * Quante conversioni possono girare insieme (`VIDEO_CONVERSIONI_PARALLELE`, 3 se non impostata).
   * Viaggia fino al database come `p_tetto`, che è dove si conta: qui non si decide niente.
   */
  tettoConversioni: number
  regione: string
  vcpus: number
  /** L'indirizzo pubblico del watermark della Galleria. Non è firmato e non è un segreto. */
  urlWatermark: string
  tettoInvocazioneMs?: number
  /**
   * IL PUNTO D'AGGANCIO DELLE PUBBLICAZIONI (compito T7 della PR 2) — QUI NON SI FA NIENTE.
   *
   * Il runner sa solo QUANDO chiamarla; che cosa farci è di T7: consumare gli eventi
   * `gallery.auto_publish` dell'outbox (fino a cinque) e scansionare gli esiti da notificare
   * (`failed`/`rejected` senza la marca). Le due righe da aggiungere stanno in `index.ts`, dove si
   * costruiscono le dipendenze.
   *
   * Si chiama in due momenti, indicati da `quando`:
   *  · `giro` — nel giro SENZA `job_id`, dopo `video_arrivi_recupera` e dopo il ventaglio, PRIMA di
   *    sorvegliare un job (la sorveglianza dura minuti: le pubblicazioni non possono aspettarla);
   *  · `dopo-esito` — in qualunque invocazione, subito dopo che un job è diventato `ready` o è fallito
   *    in modo definitivo, a sorveglianza già rilasciata: l'evento `gallery.auto_publish` è nato nella
   *    stessa transazione del `ready`, e la notifica di un fallimento non deve aspettare il cron.
   *
   * `restanteMs` è ciò che resta del tempo dell'invocazione (`240 s` meno quello speso), mai negativo:
   * chi ha poco tempo può rimandare al giro dopo invece di farsi tagliare a metà una copia.
   *
   * ⚠️ NON DEVE MAI FERMARE IL RUNNER. Un'eccezione qui dentro si logga (`pubblicazioni-eccezione`) e
   * si prosegue: una pubblicazione che esplode non può costare una conversione. Facoltativa: senza,
   * nessuna delle due chiamate fa niente.
   */
  pubblicazioni?: (contesto: ContestoPubblicazioni) => Promise<void>

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

/** Quando il runner chiama il punto d'aggancio delle pubblicazioni (`DipendenzeRunner.pubblicazioni`). */
export type QuandoPubblicare = 'giro' | 'dopo-esito'

export interface ContestoPubblicazioni {
  quando: QuandoPubblicare
  /** Ciò che resta dei 240 s di QUESTA invocazione (`TETTO_INVOCAZIONE_MS` meno il tempo speso), mai negativo. */
  restanteMs: number
}

/**
 * Con quale richiesta gira il runner. Un `jobId` è un CALCIO (`video_runner_kick`: il trigger d'arrivo,
 * il `PATCH caricato`, il ventaglio): «questo job ha bisogno di sorveglianza». Senza è il giro del cron.
 */
export interface RichiestaRunner {
  jobId?: string
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
  /**
   * Un'ALTRA invocazione sorveglia già questo job. Esito TRANQUILLO: è il caso normale di due calci
   * sullo stesso job (il trigger d'arrivo e il `PATCH caricato`, il ventaglio e il cron), e quella
   * che ha perso non ha niente da fare — né da scrivere: il job non è suo.
   */
  | { esito: 'gia-sorvegliato'; jobId: string }
  /**
   * I `processing` con la lease viva sono già `tettoConversioni`: il job resta in coda (o, se è
   * mio, resta com'è) e lo riprende il giro dopo. Esito TRANQUILLO: è il tetto che fa il suo mestiere.
   * `jobId` c'è solo quando il calcio nominava un job.
   */
  | { esito: 'capacita-piena'; jobId?: string }

/**
 * I rifiuti che dicono «per questo job non c'è più niente da fare ADESSO», e che quindi, in un CALCIO, non
 * sono guasti: il job è già finito, l'insegnante l'ha ritirato fra il calcio e la presa, o — `RETRY_NOT_DUE` —
 * aspetta il suo prossimo tentativo. Un `error` per ognuno riempirebbe il registro di allarmi per un
 * funzionamento normale.
 *
 * `RETRY_NOT_DUE` (secondario #101) è il rifiuto con cui `video_job_claim`, DELEGATO da `video_job_prendi`,
 * risponde a un calcio su un job che un guasto nostro ha rimesso in coda con la sua attesa (5, 10, 15 minuti):
 * il calcio arriva (un `PATCH caricato`, il ventaglio) ma il job non è ancora dovuto, e a riprenderlo ci pensa il
 * giro del cron quando scade l'attesa. Non è un'anomalia e non c'è niente da gridare: ma NON è nemmeno
 * «niente da fare» per sempre, ed è la differenza con `INVALID_STATE` — il job resta in coda e riparte.
 */
const NIENTE_DA_FARE = new Set(['INVALID_STATE', 'INTENT_INACTIVE', 'RETRY_NOT_DUE'])

export async function eseguiUnJobVideo(
  d: DipendenzeRunner,
  richiesta: RichiestaRunner = {},
): Promise<EsitoRunnerVideo> {
  // L'ORA DI INIZIO è ciò da cui si misura il tempo «già speso»: il budget della sorveglianza è
  // `240 s` meno quanto ne è passato da qui, e non `240 s` dal momento in cui comincia a sorvegliare.
  // Con la seconda misura una sorveglianza partita dopo un giro lungo (arrivi, ventaglio,
  // pubblicazioni, apertura della MicroVM, apparecchio) sforava i 300 s della piattaforma.
  const inizio = d.orologio.adesso()

  const esito =
    richiesta.jobId === undefined
      ? await giroSenzaJob(d, inizio)
      : await giroPerUnJob(d, richiesta.jobId, inizio)

  await dopoLEsito(d, esito, inizio)
  return esito
}

/**
 * Che cosa si fa DOPO, a sorveglianza già rilasciata (il rilascio sta nel `finally` dei due percorsi).
 *
 *  · `in-corso` — la conversione non è finita e questa invocazione se ne va: si passa il testimone
 *    (vedi «IL TESTIMONE» in testa al file);
 *  · `pronto` o `fallito` — un job è arrivato a un esito definitivo: le pubblicazioni non aspettano il cron.
 */
async function dopoLEsito(d: DipendenzeRunner, esito: EsitoRunnerVideo, inizio: number): Promise<void> {
  if (esito.esito === 'in-corso') {
    await passaIlTestimone(d)
    return
  }
  if (esito.esito === 'pronto' || esito.esito === 'fallito') {
    await agganciaLePubblicazioni(d, 'dopo-esito', inizio)
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL CALCIO: un'invocazione per UN job
 * ──────────────────────────────────────────────────────────────────────────── */

async function giroPerUnJob(
  d: DipendenzeRunner,
  jobId: string,
  inizio: number,
): Promise<EsitoRunnerVideo> {
  const sorveglianza = await d.coda.sorveglianzaPrendi(jobId, d.invocazione, SECONDI_SORVEGLIANZA)
  if (!sorveglianza.ok) return esitoSenzaSorveglianza(jobId, sorveglianza.code)

  try {
    const preso = await d.coda.prendi(jobId, d.leaseOwner, SECONDI_LEASE_PRESA, d.tettoConversioni)
    if (!preso.ok) {
      if (preso.code === 'CAPACITA_PIENA') return { esito: 'capacita-piena', jobId }
      if (NIENTE_DA_FARE.has(preso.code)) return { esito: 'coda-vuota' }
      logEvento('cron', 'error', {
        operazione: 'video-runner',
        esito: 'presa-rifiutata',
        error_code: preso.code,
        job_id: jobId,
      })
      return { esito: 'presa-rifiutata', codice: preso.code }
    }
    return await lavoraSulJob(d, preso.job, inizio)
  } finally {
    // Comunque sia andata, anche con `in-corso`: chi riaggancia la MicroVM dopo di noi non deve
    // aspettare che scada la lease di sorveglianza.
    await rilasciaLaSorveglianza(d, jobId)
  }
}

/**
 * Perché la sorveglianza non c'è stata, e che cosa risponde il runner.
 *
 * `GIA_SORVEGLIATO` è l'esito normale di due calci sullo stesso job; `INVALID_STATE` vuol dire che il
 * job non è né in coda né in lavorazione (è già finito, o ritirato): in tutti e due i casi non c'è
 * niente da fare, e non è un guasto. Ogni altro codice — `NOT_FOUND`, `BAD_INPUT`, `RPC_ERROR` — lo è.
 */
function esitoSenzaSorveglianza(jobId: string, code: string): EsitoRunnerVideo {
  if (code === 'GIA_SORVEGLIATO') return { esito: 'gia-sorvegliato', jobId }
  if (NIENTE_DA_FARE.has(code)) return { esito: 'coda-vuota' }
  logEvento('cron', 'error', {
    operazione: 'video-runner',
    esito: 'sorveglianza-rifiutata',
    error_code: code,
    job_id: jobId,
  })
  return { esito: 'presa-rifiutata', codice: code }
}

/**
 * Rilascia la lease di sorveglianza. Non solleva mai e non decide niente: se non riesce, la lease
 * scade da sé fra `SECONDI_SORVEGLIANZA` secondi e chi viene dopo aspetta quel tanto — peggio di un
 * rilascio riuscito, ma non un guasto: `warn`, non `error`.
 */
async function rilasciaLaSorveglianza(d: DipendenzeRunner, jobId: string): Promise<void> {
  try {
    const esito = await d.coda.sorveglianzaRilascia(jobId, d.invocazione)
    if (!esito.ok) {
      logEvento('cron', 'warn', {
        operazione: 'video-runner',
        esito: 'sorveglianza-non-rilasciata',
        error_code: esito.code,
        job_id: jobId,
      })
    }
  } catch (err) {
    logEvento(
      'cron',
      'warn',
      { operazione: 'video-runner', esito: 'sorveglianza-non-rilasciata', job_id: jobId },
      err,
    )
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL GIRO DEL CRON: senza `job_id`
 * ──────────────────────────────────────────────────────────────────────────── */

async function giroSenzaJob(d: DipendenzeRunner, inizio: number): Promise<EsitoRunnerVideo> {
  await recuperaGliArrivi(d)

  // La sorveglianza del job che questa invocazione riprenderà si prende QUI, prima del ventaglio, e
  // non dopo: il ventaglio calcia ogni job `processing` che nessuno sorveglia, compreso questo, e
  // un calcio a sé stessi è un'invocazione sprecata (che trova `gia-sorvegliato`, nel caso migliore).
  const mio = await sorvegliaUnoDeiMiei(d)

  await passaIlVentaglio(d, mio === null ? null : mio.id)
  await agganciaLePubblicazioni(d, 'giro', inizio)

  if (mio !== null) {
    const ripreso = await riprendiIlMio(d, mio, inizio)
    if (ripreso !== null) return ripreso
  }
  return await prendiUnJobNuovo(d, inizio)
}

/**
 * La rete del trigger d'arrivo. Non decide niente e non ferma niente: se non riesce, il giro va avanti
 * (al peggio un arrivo mancato aspetta il giro dopo, ed è la ragione per cui questa è una rete).
 * L'esito di ogni arrivo lo scrive il database (`video-arrivo-recuperato-dal-giro`, a `warn`: vuol dire
 * che il trigger non ha visto quell'arrivo), qui si vede solo ciò che il database non ha potuto dire.
 *
 * ─── I NUMERI NEL REGISTRO DEL RUNNER (secondario #128) ──────────────────────────────────────────
 *
 * La RPC risponde con quattro conteggi — `arrivati`, `diversi`, `non_risolti`, `errori` — e il database
 * li scrive anch'esso (`video-arrivi-recupera`, `info`). Ma `app_log` somma le occorrenze di una riga
 * uguale e tiene il contesto della PRIMA: il `non_risolti` di oggi, se cambia durante il giorno, non si
 * vede. Per questo il runner scrive i numeri a modo suo, e SOLO quando c'è qualcosa da vedere:
 *
 *  · tutto a zero è il funzionamento normale e non scrive niente (la riga del database c'è già a ogni
 *    giro, ed è ciò che distingue «niente da recuperare» da «la rete non gira più»);
 *  · `arrivati` > 0 vuol dire che il TRIGGER non sta vedendo gli arrivi (la rete li ha portati in coda al
 *    posto suo); `diversi` > 0 che un file è stato rifiutato per dimensione; `errori` > 0 che un candidato
 *    ha fatto esplodere il giro; `non_risolti` > 0 che dei candidati restano bloccati (metadati
 *    incompleti, un file vuoto) — e un `non_risolti` ALTO E STABILE è il segno che la finestra di cinquanta
 *    posti sta mordendo (vedi `LIMITE_ARRIVI_PER_GIRO`).
 *
 * Una riga a livello `warn`, con i quattro numeri nei campi e nell'impronta (`distingui`): lo stesso giorno
 * con `non_risolti` 2 e con `non_risolti` 9 sono due righe, non una che mente sul secondo.
 */
async function recuperaGliArrivi(d: DipendenzeRunner): Promise<void> {
  await senzaFermareIlGiro('arrivi-recupera-eccezione', async () => {
    const esito = await d.coda.arriviRecupera(LIMITE_ARRIVI_PER_GIRO)
    if (!esito.ok) {
      if (esito.code !== 'RPC_ERROR') {
        logEvento('cron', 'warn', {
          operazione: 'video-runner',
          esito: 'arrivi-recupera-rifiutata',
          error_code: esito.code,
        })
      }
      return
    }

    const candidati = esito.conteggi.candidati ?? 0
    const arrivati = esito.conteggi.arrivati ?? 0
    const diversi = esito.conteggi.diversi ?? 0
    const nonRisolti = esito.conteggi.non_risolti ?? 0
    const errori = esito.conteggi.errori ?? 0
    if (arrivati > 0 || diversi > 0 || nonRisolti > 0 || errori > 0) {
      logEvento(
        'cron',
        'warn',
        {
          operazione: 'video-runner',
          esito: 'arrivi-recuperati',
          candidati,
          arrivati,
          diversi,
          non_risolti: nonRisolti,
          errori,
        },
        undefined,
        { distingui: ['arrivati', 'diversi', 'non_risolti', 'errori'] },
      )
    }
  })
}

/**
 * Un calcio per ogni job che ha bisogno di sorveglianza, tranne `escludi` (un JOB: quello che questa
 * invocazione sorveglia già — secondario #39). Anche questo non ferma il giro.
 */
async function passaIlVentaglio(d: DipendenzeRunner, escludi: string | null): Promise<void> {
  await senzaFermareIlGiro('ventaglio-eccezione', async () => {
    const esito = await d.coda.ventaglio(d.tettoConversioni, escludi)
    if (!esito.ok && esito.code !== 'RPC_ERROR') {
      logEvento('cron', 'warn', {
        operazione: 'video-runner',
        esito: 'ventaglio-rifiutato',
        error_code: esito.code,
      })
    }
  })
}

/**
 * Il testimone: dopo aver rilasciato la sorveglianza di una conversione che continua, si rifà il
 * ventaglio SENZA escludere niente — il job che abbiamo appena lasciato è proprio quello da calciare.
 * Se nessun calcio parte (`pg_net` assente, URL del runner mancante) la catena torna al cron, e si
 * vede: `warn` invece di `info`.
 */
async function passaIlTestimone(d: DipendenzeRunner): Promise<void> {
  await senzaFermareIlGiro('testimone-eccezione', async () => {
    const esito = await d.coda.ventaglio(d.tettoConversioni, null)
    if (!esito.ok) {
      if (esito.code !== 'RPC_ERROR') {
        logEvento('cron', 'warn', {
          operazione: 'video-runner',
          esito: 'testimone-rifiutato',
          error_code: esito.code,
        })
      }
      return
    }
    const candidati = esito.conteggi.candidati ?? 0
    const calciati = esito.conteggi.calciati ?? 0
    logEvento('cron', candidati > 0 && calciati === 0 ? 'warn' : 'info', {
      operazione: 'video-runner',
      esito: 'testimone-passato',
      candidati,
      calciati,
    })
  })
}

/**
 * Il punto d'aggancio di T7 (`DipendenzeRunner.pubblicazioni`): il runner non sa che cosa ci sia
 * dietro, e non gli deve importare. Un'eccezione si logga e si ingoia — una pubblicazione che esplode
 * non può costare una conversione, né l'esito di un job già scritto.
 */
async function agganciaLePubblicazioni(
  d: DipendenzeRunner,
  quando: QuandoPubblicare,
  inizio: number,
): Promise<void> {
  const pubblicazioni = d.pubblicazioni
  if (!pubblicazioni) return
  try {
    await pubblicazioni({ quando, restanteMs: restanteDelBudget(d, inizio) })
  } catch (err) {
    logEvento(
      'cron',
      'error',
      { operazione: 'video-runner', esito: 'pubblicazioni-eccezione', azione: quando },
      err,
    )
  }
}

/** Esegue un lavoro di contorno e, se lancia, lo racconta e basta: il giro non si ferma per una rete di sicurezza. */
async function senzaFermareIlGiro(esito: string, lavoro: () => Promise<void>): Promise<void> {
  try {
    await lavoro()
  } catch (err) {
    logEvento('cron', 'error', { operazione: 'video-runner', esito }, err)
  }
}

/**
 * Ciò che resta dei `240 s` di questa invocazione, mai negativo. È il budget della sorveglianza:
 * `240 s` meno quanto ne è passato da quando l'invocazione è cominciata.
 */
function restanteDelBudget(d: DipendenzeRunner, inizio: number): number {
  const tetto = d.tettoInvocazioneMs ?? TETTO_INVOCAZIONE_MS
  return Math.max(0, tetto - (d.orologio.adesso() - inizio))
}

/**
 * Un job rimasto a metà da un'invocazione precedente, che nessuno sorveglia: se ne prende la
 * sorveglianza, e se ne torna uno solo.
 *
 * Uno per volta, e non è una semplificazione: aprire una seconda MicroVM mentre la prima converte
 * vorrebbe dire pagarne due e, con un'invocazione sola da spartirsi, sorvegliarle entrambe male. Gli
 * altri li prendono i calci del ventaglio, uno per invocazione.
 *
 * `miei()` non distingue i job sorvegliati da altre invocazioni — il `lease_owner` è uno solo — e a
 * distinguerli è la sorveglianza: `GIA_SORVEGLIATO` vuol dire «ci pensa un altro», `INVALID_STATE` che
 * nel frattempo è finito. Entrambi sono il caso normale e non si scrivono.
 */
async function sorvegliaUnoDeiMiei(d: DipendenzeRunner): Promise<JobVideo | null> {
  const miei = await d.coda.miei(d.leaseOwner)
  if (!miei.ok) {
    // Una lettura che non riesce non deve fermare la coda: si prosegue verso
    // `video_job_prossimo`, che al più non troverà niente. Ma si logga, perché finché
    // questa lettura non funziona OGNI conversione lunga viene rifatta da capo.
    logEvento('cron', 'error', {
      operazione: 'video-runner',
      esito: 'ripresa-non-interrogabile',
      error_code: miei.motivo,
    })
    return null
  }

  for (const candidato of miei.jobs) {
    const sorveglianza = await d.coda.sorveglianzaPrendi(candidato.id, d.invocazione, SECONDI_SORVEGLIANZA)
    if (sorveglianza.ok) return candidato
    if (sorveglianza.code !== 'GIA_SORVEGLIATO' && sorveglianza.code !== 'INVALID_STATE') {
      logEvento('cron', 'warn', {
        operazione: 'video-runner',
        esito: 'sorveglianza-non-presa',
        error_code: sorveglianza.code,
        job_id: candidato.id,
      })
    }
  }
  return null
}

/**
 * Riprende il job di cui si ha già la sorveglianza. `null` vuol dire «non era più riprendibile»: il
 * giro prosegue con un job nuovo. La sorveglianza si rilascia comunque, qui e non altrove: il giro
 * ha un solo job sorvegliato per volta, e questo è il suo.
 */
async function riprendiIlMio(
  d: DipendenzeRunner,
  mio: JobVideo,
  inizio: number,
): Promise<EsitoRunnerVideo | null> {
  try {
    const esito = await d.coda.prendi(mio.id, d.leaseOwner, SECONDI_LEASE_PRESA, d.tettoConversioni)
    if (esito.ok) return await lavoraSulJob(d, esito.job, inizio)
    if (esito.code === 'CAPACITA_PIENA') return { esito: 'capacita-piena', jobId: mio.id }

    // La lease è scaduta fra la lettura e la richiesta: il job tornerà in coda da sé,
    // con un fence nuovo. Non è un guasto, ma va visto: se succede spesso, il giro del
    // cron è più lento della lease.
    logEvento('cron', 'warn', {
      operazione: 'video-runner',
      esito: 'ripresa-rifiutata',
      error_code: esito.code,
      job_id: mio.id,
    })
    return null
  } finally {
    await rilasciaLaSorveglianza(d, mio.id)
  }
}

/** Pesca il prossimo job dovuto, ne prende la sorveglianza e lavora. */
async function prendiUnJobNuovo(d: DipendenzeRunner, inizio: number): Promise<EsitoRunnerVideo> {
  const preso = await d.coda.prossimo(d.leaseOwner, SECONDI_LEASE_PRESA, d.tettoConversioni)
  if (!preso.ok) {
    if (preso.code === 'EMPTY_QUEUE') {
      // ⚠️ IL BATTITO DEL CRON, e non è rumore. Con i soli errori, «nessun log» non
      // distingue «coda tranquilla» da «il cron non è mai partito» — l'ambiguità che
      // in questo progetto ha tenuto nascosto per mesi il guasto delle email.
      logEvento('cron', 'info', { operazione: 'video-runner', esito: 'coda-vuota' })
      return { esito: 'coda-vuota' }
    }
    if (preso.code === 'CAPACITA_PIENA') return { esito: 'capacita-piena' }
    logEvento('cron', 'error', {
      operazione: 'video-runner',
      esito: 'presa-rifiutata',
      error_code: preso.code,
    })
    return { esito: 'presa-rifiutata', codice: preso.code }
  }

  // Il job è già preso (`processing`, la nostra lease): la sorveglianza viene dopo perché solo la presa
  // dice QUALE job è. Se nel frattempo un calcio è arrivato prima di noi, la sorveglianza è sua, e il
  // suo `video_job_prendi` troverà il job già suo e vivo (idempotente): si lascia a lui.
  const sorveglianza = await d.coda.sorveglianzaPrendi(preso.job.id, d.invocazione, SECONDI_SORVEGLIANZA)
  if (!sorveglianza.ok) return esitoSenzaSorveglianza(preso.job.id, sorveglianza.code)

  try {
    return await lavoraSulJob(d, preso.job, inizio)
  } finally {
    await rilasciaLaSorveglianza(d, preso.job.id)
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL LAVORO SU UN JOB
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `inizio` è l'ora in cui è cominciata l'INVOCAZIONE (non questo lavoro): da lì si misura il tempo
 * speso, e il budget della sorveglianza è `240 s` meno quello.
 */
async function lavoraSulJob(d: DipendenzeRunner, job: JobVideo, inizio: number): Promise<EsitoRunnerVideo> {
  const percorsoUscita = percorsoUscitaVideo(job)

  // ⚠️ LO `sha256` DICHIARATO si legge PRIMA di firmare e di aprire qualunque cosa. Se c'è, la conversione lo
  // verifica dentro la MicroVM prima di convertire; se non c'è (web, TUS, News) il passo non esiste. Se c'è
  // QUALCOSA e non è un'impronta, la verifica che il database ha chiesto non si può fare, e un controllo di
  // integrità richiesto e non eseguibile NON passa in silenzio: il job è rifiutato (`ORIGINALE_DIVERSO`, `file`,
  // mai ritentato) e il log dice che il guaio è il valore, non il file. Non costa una MicroVM: si esce qui.
  // Il valore non entra mai nel log, nemmeno quando è quello sbagliato.
  const shaDichiarato = leggiSha256Dichiarato(job.sha256_dichiarato)
  if (shaDichiarato.stato === 'illeggibile') {
    loggaEsito(job, 'error', { esito: 'sha256-dichiarato-illeggibile' })
    return await chiudiPerGuasto(d, job, { codice: 'ORIGINALE_DIVERSO', classe: 'file', diagnosi: '' })
  }

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

  let aperta: SessioneSandbox
  const inizioApertura = d.orologio.adesso()
  try {
    aperta = await d.macchina.apri({
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
    // e il log ha già detto perché. (L'apertura prova già lo snapshot e poi il ripiego: se l'eccezione
    // arriva fin qui, sono falliti entrambi.)
    return await chiudiPerGuasto(d, job, {
      codice: 'SANDBOX_UNAVAILABLE',
      classe: 'infra-transitoria',
      diagnosi: '',
      causa: err,
      http: fattiDellErrore(err).http,
    })
  }
  const aperturaMs = d.orologio.adesso() - inizioApertura

  // Da qui la sessione è quella che lancia `EccezioneDellSdk` (secondario #33); lo spegnimento si
  // chiede alla sessione grezza, che è la stessa cosa ma non ha niente da incapsulare.
  const sessione = senzaEccezioniDellSdk(aperta)
  let spegni = true
  try {
    if (sessione.nuova) {
      const avvio = await apparecchiaEAvvia(d, job, sessione, ambiente, {
        aperturaMs,
        sha256: shaDichiarato.stato === 'ok' ? shaDichiarato.hex : null,
      })
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
      // `240 s` meno il tempo già speso da quando è cominciata l'invocazione (il giro, la presa, la
      // firma, l'apertura della MicroVM, l'apparecchio): la sorveglianza finisce a 240 s
      // dall'INIZIO, e i 60 s che restano dei 300 della piattaforma sono per l'esito.
      tettoInvocazioneMs: restanteDelBudget(d, inizio),
    })

    if (sorveglianza.esito === 'in-corso') {
      // ⚠️ La MicroVM resta accesa: è lì che sta girando la conversione, e chi sorveglia dopo di noi
      // (il testimone, o il tick) la riaggancia per nome.
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
  } catch (err) {
    // SOLO le eccezioni dell'SDK (`esegui`/`avvia`): un guasto NOSTRO, che passa da `riprova` con la
    // sua attesa e il suo tetto invece di lasciare il job `processing` fino alla scadenza della lease.
    // Qualunque altra eccezione — `pronto` che lancia, la consegna a News — NON è questo guasto:
    // classificarla così riproverebbe un job già `ready`.
    if (err instanceof EccezioneDellSdk) {
      return await chiudiPerGuasto(d, job, {
        codice: 'SANDBOX_UNAVAILABLE',
        classe: 'infra-transitoria',
        diagnosi: '',
        causa: err.causa,
        http: fattiDellErrore(err.causa).http,
        azione: err.azione,
      })
    }
    throw err
  } finally {
    if (spegni) await fermaSessione(job, aperta)
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
  contesto: { aperturaMs: number; sha256: string | null },
): Promise<EsitoRunnerVideo | null> {
  const inizioApparecchio = d.orologio.adesso()

  // ─── DOVE STANNO I BINARI (PR 2, `./ambiente.ts`) ───────────────────────────────────────────────
  //
  // Una MicroVM nata dallo SNAPSHOT li ha già in `/opt/kv-ffmpeg`: l'apparecchio li verifica con `sha256sum`
  // invece di scaricarli, e in questo caso NON si firma niente del bucket `video_build` — lo snapshot esiste
  // proprio perché a runtime il bucket non serva (e se il bucket fosse giù, una conversione sana non deve
  // fermarsi). Se i binari mancano o non tornano (uscita 26) si ripiega NELLA STESSA MicroVM con la provvista
  // dal bucket, che lo snapshot può fare perché ha `curl`: la MicroVM non si butta e non se ne apre un'altra.
  // Una MicroVM nata dal runtime (la PR 1, o un'origine non dichiarata) va sempre per la provvista.
  //
  // Il ripiego si GRIDA, a livello `error` (`ambiente-pronto-assente`, motivo `BINARI_NON_VERIFICATI`): che i
  // binari dello snapshot non tornino è un guasto da riparare (lo snapshot si ricostruisce), anche se il video
  // converte lo stesso. Cosa è tornato e cosa no lo dice la riga `FAILED` di `sha256sum` nello stderr.
  let modalita: ModalitaAmbiente = 'ripiego-runtime'
  let apparecchio: EsitoComando | null = null
  if (sessione.origine === 'snapshot') {
    apparecchio = await sessione.esegui({
      ...conShell(
        scriptApparecchio({ cartella: CARTELLA_BINARI_NELLO_SNAPSHOT, binariGiaPresenti: true }),
      ),
      // Senza gli indirizzi della build: non servono, e un segreto che non serve non entra nella MicroVM.
      env: ambiente,
      tettoMs: TETTO_APPARECCHIO_MS,
    })
    if (apparecchio.exitCode === USCITE_APPARECCHIO.binari) {
      loggaEsito(
        job,
        'error',
        {
          esito: 'ambiente-pronto-assente',
          error_code: MOTIVI_AMBIENTE_ASSENTE.binariNonVerificati,
          uscita: apparecchio.exitCode,
        },
        erroreDiagnostico(codiceDaUscitaApparecchio(apparecchio.exitCode) ?? 'BUILD_HASH_MISMATCH', apparecchio.stderr),
        DISTINGUI_PER_TENTATIVO,
      )
      apparecchio = null
      modalita = 'ripiego-vm'
    } else {
      modalita = 'snapshot'
    }
  }

  if (apparecchio === null) {
    // La provvista dal bucket: i due `.gz` si firmano SOLO qui (e solo se servono).
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

    apparecchio = await sessione.esegui({
      ...conShell(scriptApparecchio()),
      env: {
        ...ambiente,
        [ENV_URL_FFMPEG]: firmaFfmpeg.url,
        [ENV_URL_FFPROBE]: firmaFfprobe.url,
      },
      tettoMs: TETTO_APPARECCHIO_MS,
    })
  }

  // Dove stanno i binari che il comando ha appena verificato o portato: è la cartella con cui parte la
  // conversione staccata, e dopo non c'è modo di cambiare idea.
  const cartellaBuild = modalita === 'snapshot' ? CARTELLA_BINARI_NELLO_SNAPSHOT : CARTELLA_BUILD

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
  //
  // `build-pronta` dice che la provvista dal bucket è RIUSCITA: con i binari che uscivano dallo snapshot
  // non c'è stata nessuna provvista, e dirlo sarebbe una bugia. In quel caso c'è solo la riga qui sotto.
  const ms = d.orologio.adesso() - inizioApparecchio
  if (modalita !== 'snapshot') loggaEsito(job, 'info', { esito: 'build-pronta', ms })

  // ⚠️ `ambiente-pronto`: in quale dei tre modi l'ambiente è diventato pronto (`snapshot`, `ripiego-vm`,
  // `ripiego-runtime`) e in quanto. `ms` è lo stesso numero di `build-pronta` — apparecchio intero — e
  // `apertura_ms` il tempo di `apri` (la MicroVM che nasce, snapshot o runtime compresi): sono i due numeri
  // con cui T16 confronta «avvio da snapshot» e «ripiego». `distingui: ambiente` tiene una riga al giorno per
  // MODO, con il suo contatore: senza, il giorno avrebbe la riga del primo caso e basta, e il ripiego che
  // arriva dopo il primo `snapshot` del mattino sarebbe sommato ai primi.
  loggaEsito(
    job,
    'info',
    { esito: 'ambiente-pronto', ambiente: modalita, ms, apertura_ms: contesto.aperturaMs },
    undefined,
    { distingui: ['ambiente'] },
  )

  const probe = parseVideoProbe(letto.probeGrezzo, letto.byte ?? -1)
  if (!probe.ok) {
    // `rejected`: il file non va bene. Non è la nostra infrastruttura, e riprovare
    // darebbe lo stesso identico risultato.
    return await chiudiPerGuasto(d, job, { codice: probe.code, classe: 'file', diagnosi: '' })
  }

  // Le tracce audio che NON si convertono (secondario #10, spec §10.5): il codec che ffprobe non riconosce,
  // o una seconda traccia decodificabile. L'uscita ne ha UNA, la scelta, e il video esce lo stesso — ma
  // senza questa riga nessuno saprebbe che un filmato ha perso un audio, e «il video non ha la sua colonna
  // sonora» è esattamente la segnalazione che arriva da una famiglia e che nei log non ha un posto.
  // Solo un conteggio: nessun nome di traccia, nessun metadato. Una riga per job.
  const tracceIgnorate = probe.probe.ignoredAudioTracks ?? 0
  if (tracceIgnorate > 0) {
    loggaEsito(job, 'info', { esito: 'tracce-audio-ignorate', tracce_ignorate: tracceIgnorate }, undefined, {
      distingui: ['job_id'],
    })
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
      // ⚠️ SECONDARIO #9: senza questi tre numeri la sonda temporale non sa quanto c'è da decodificare
      // e parte col TETTO (900 s) invece del tempo che serve (qualche minuto per un Full HD di tre
      // minuti): due sonde in serie sono mezz'ora, cioè tutto `TETTO_SANDBOX_MS`, e un ffprobe
      // piantato si mangia la MicroVM. Sono quelli del probe dell'ORIGINALE, non dell'uscita: la
      // parte pesante è l'ingresso (l'uscita è al massimo Full HD), e il timeout è lo stesso per le due sonde.
      durationSeconds: probe.probe.durationSeconds,
      width: probe.probe.width,
      height: probe.probe.height,
      // I binari che l'apparecchio ha appena VERIFICATO: quelli dello snapshot o quelli portati dal bucket.
      cartellaBuild,
      // Lo `sha256` dichiarato (caricamento nativo): se c'è, la conversione lo confronta con l'originale
      // scaricato PRIMA di convertire. Se non c'è, nello script il passo non esiste.
      verificaSha256: contesto.sha256 !== null,
    })),
    // ⚠️ `ambiente` e non l'env dell'apparecchio: gli indirizzi della build non entrano qui. Lo `sha256`,
    // quando c'è, viaggia QUI e non negli argomenti, come gli URL firmati: mai in una riga di comando.
    env: contesto.sha256 === null ? ambiente : { ...ambiente, [ENV_SHA256_ATTESO]: contesto.sha256 },
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
    // I numeri del rifiuto, scritti sul job PRIMA di chiuderlo (secondario #10): `video_job_diagnosi` vuole un
    // job `processing`, e `chiudiPerGuasto` lo rende `rejected`.
    await scriviLaDiagnosi(d, job, probe.probe, esito, verifica.code)
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
    // `durationSeconds <= MAX_VIDEO_DURATION_SECONDS` (`../limiti`: il tetto non si riscrive
    // qui, si legge lì), che è il limite dell'INGRESSO; l'uscita AAC può
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

/**
 * Scrive su `video_jobs.diagnosi_verifica` i NUMERI di una verifica fallita (`diagnosiVerifica`, spec §10.5):
 * frame della sorgente e dell'uscita, coperture, ultimo campione, tolleranze, fps. È ciò che permette di
 * leggere un rifiuto — «`TERMINAL_COVERAGE_MISMATCH` su 264 frame con Δ 30 ms» — senza riaprire il video di
 * un bambino: il 28/09 un falso scarto si è capito soltanto rifacendo la misura dentro un Sandbox.
 *
 * ⚠️ NON CAMBIA L'ESITO, MAI. La diagnosi è un'informazione di contorno e il job è già rifiutato: se la RPC dice
 * di no (`FENCE_MISMATCH`, `BAD_INPUT`…), se la chiamata non arriva (`RPC_ERROR`), se un adattatore lancia o se
 * `diagnosiVerifica` stessa esplode, si LOGGA (`warn`, `diagnosi-non-scritta`) e si prosegue col fallimento. Un
 * catch che non logga è un bug (AGENTS, regola 6): qui il catch c'è, ed è il solo punto in cui un'eccezione si
 * ingoia, perché ciò che sta sopra — il rifiuto del file — non deve dipendere da lei.
 *
 * ⚠️ SOLO NUMERI ED ENUMERATI. La forma la costruisce `diagnosiVerifica` (venti chiavi chiuse, ogni numero
 * limitato, ogni stringa da un elenco) e la rifà verificare la RPC (forma chiusa, 2048 byte): da qui non esce un
 * nome di file, un percorso, un metadato. Nel log entra soltanto l'esito della scrittura, mai la diagnosi stessa.
 *
 * Non si scrive sul `ready`: la RPC vuole un job `processing`, e una diagnosi di un'accettazione non servirebbe a
 * niente. Il giro è: verifica fallita → diagnosi → `video_job_fail`.
 */
async function scriviLaDiagnosi(
  d: DipendenzeRunner,
  job: JobVideo,
  sorgente: VideoProbe,
  esito: LetturaEsitoConversione,
  codice: VideoOutputVerificationErrorCode,
): Promise<void> {
  try {
    const diagnosi = diagnosiVerifica(sorgente, esito.probeUscita, esito.prova, codice)
    const scritta = await d.coda.diagnosi({
      jobId: job.id,
      fenceEpoch: job.fence_epoch,
      leaseOwner: d.leaseOwner,
      diagnosi,
    })
    if (!scritta.ok) loggaEsito(job, 'warn', { esito: 'diagnosi-non-scritta', error_code: scritta.code })
  } catch (err) {
    loggaEsito(job, 'warn', { esito: 'diagnosi-non-scritta' }, erroreSanificatoPerIlLog(err))
  }
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
 * L'eccezione dell'SDK del Sandbox, riconoscibile. `causa` è l'errore originale (è lui che finisce
 * nel log, col suo messaggio e il suo stack); `azione` dice quale delle due chiamate è esplosa.
 * Non è esportata: nasce in `senzaEccezioniDellSdk` e muore in `lavoraSulJob`.
 */
class EccezioneDellSdk extends Error {
  readonly azione: 'esegui' | 'avvia'
  readonly causa: unknown

  constructor(azione: 'esegui' | 'avvia', causa: unknown) {
    super(`eccezione dell'SDK del Sandbox (${azione})`)
    this.name = 'EccezioneDellSdk'
    this.azione = azione
    this.causa = causa
  }
}

/**
 * La stessa sessione, con le sole due chiamate che possono lanciare incapsulate in
 * `EccezioneDellSdk` (secondario #33). `ferma` resta com'è: la chiama `fermaSessione`, che ha già il
 * suo `catch` e il suo log (`microvm-non-spenta`).
 *
 * ⚠️ È un incapsulamento, non una classificazione: scegliere che cosa se ne fa è di `lavoraSulJob`.
 * Sta qui, e non in `adattatori.ts`, perché gli adattatori non decidono niente (testata di quel file).
 */
function senzaEccezioniDellSdk(sessione: SessioneSandbox): SessioneSandbox {
  return {
    nuova: sessione.nuova,
    // L'origine è un fatto della sessione, non una sua chiamata: passa com'è. Perderla qui farebbe credere
    // al runner che ogni MicroVM venga dal runtime, cioè scaricherebbe la build anche dallo snapshot.
    ...(sessione.origine === undefined ? {} : { origine: sessione.origine }),
    esegui: async (comando) => {
      try {
        return await sessione.esegui(comando)
      } catch (err) {
        throw new EccezioneDellSdk('esegui', err)
      }
    },
    avvia: async (comando) => {
      try {
        await sessione.avvia(comando)
      } catch (err) {
        throw new EccezioneDellSdk('avvia', err)
      }
    },
    ferma: () => sessione.ferma(),
  }
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
 *    ciò da cui si decide (la classe è già dichiarata);
 *  · `azione` — quale chiamata dell'SDK del Sandbox è esplosa (`esegui`, `avvia`), per un guasto che
 *    è un'eccezione dell'SDK: dice dove guardare (l'apparecchio, l'avvio, la lettura del marcatore)
 *    senza dover leggere lo stack.
 */
interface Guasto {
  codice: CodiceRunnerVideo | string
  classe: ClasseGuasto
  diagnosi: string
  causa?: unknown
  http?: number | null
  azione?: string
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

/**
 * I campi di log che descrivono il guasto. `http` e `azione` solo se ci sono: un campo nullo non dice
 * niente. `azione` è in lista bianca di `redact` (una parola: `esegui`, `avvia`), `fase` non lo sarebbe.
 */
function campiDelGuasto(g: Guasto): Record<string, Valore> {
  const http = httpDelGuasto(g)
  return {
    error_code: g.codice,
    tipo: g.classe,
    ...(http !== null ? { http } : {}),
    ...(g.azione !== undefined ? { azione: g.azione } : {}),
  }
}

/**
 * L'errore che accompagna il log di un guasto: ciò che finisce in `app_log.messaggio`.
 *
 * Due origini, due trattamenti — ed è la ragione per cui un guasto non si passa mai al logger com'è:
 *
 *  · una DIAGNOSI (lo stderr di `curl` e `ffmpeg`): passa da `erroreDiagnostico`, che ne tiene la CODA,
 *    ripulita (URL, JWT, metadati dei filmati) e sanificata;
 *  · una CAUSA — un'eccezione: la MicroVM che non si apre, una chiamata dell'SDK che lancia, la geometria
 *    che `buildVideoEncodeArgs` rifiuta: passa da `erroreSanificatoPerIlLog` (`./ambiente.ts`), che ne tiene
 *    nome, stato HTTP e codice più il messaggio ripulito allo stesso modo (secondario #104).
 *
 * Fino alla PR 2 la causa entrava nel log COM'ERA, col suo messaggio e il suo stack: il logger toglie le email e i
 * codici fiscali ma non gli URL né i JWT, e l'eccezione di un SDK che fa richieste autenticate è proprio il
 * posto in cui un indirizzo con un token potrebbe comparire. Il testo resta leggibile («quota finita»,
 * «regione non disponibile»): sparisce ciò che nei log non deve stare.
 */
function erroreDelGuasto(g: Guasto): Error {
  return g.causa === undefined
    ? erroreDiagnostico(g.codice, g.diagnosi)
    : erroreSanificatoPerIlLog(g.causa)
}

/**
 * L'attesa che si passa a `video_job_retry` all'ULTIMO tentativo, dove non serve a niente: la RPC
 * guarda `attempt >= p_tentativi_massimi`, annota `last_error_code` e delega a `video_job_fail` senza
 * leggerla. Ma la RPC la VALIDA (da 1 a 86400 secondi), quindi un numero valido ci vuole: l'ultima
 * attesa della scala (15 minuti) è anche il valore meno dannoso se il database, contro ogni
 * previsione, riconoscesse un tentativo in più e rimettesse il job in coda.
 */
const ATTESA_DELL_ULTIMO_TENTATIVO_S = ATTESE_FRA_TENTATIVI_S[ATTESE_FRA_TENTATIVI_S.length - 1]

/**
 * Che cosa si fa di un job che non è riuscito, deciso dalla CLASSE del guasto.
 *
 *  · `file` → `video_job_fail` con `rejected = true`: il filmato non va bene, e la famiglia
 *    deve poterlo sapere;
 *  · `non-ritentabile` → `video_job_fail` con `rejected = false`;
 *  · `infra-*` → `decidiRitentativo`: se ne restano, `video_job_retry`; a tentativi esauriti
 *    (il quarto, `attempt >= 4`) si chiama `video_job_retry` ANCHE così (secondario #23): è la RPC a
 *    riconoscere i tentativi finiti, ad annotare `last_error_code` e a delegare a `video_job_fail`.
 *    Il log lo dice con `tentativi_esauriti`.
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
  if (decisione.ritenta) return await riprova(d, job, g, decisione)

  if (decisione.motivo === 'tentativi-esauriti') {
    return await riprova(
      d,
      job,
      g,
      {
        attesaSecondi: ATTESA_DELL_ULTIMO_TENTATIVO_S,
        tentativiMassimi: TENTATIVI_MASSIMI_GUASTO_NOSTRO,
      },
      { esauriti: true },
    )
  }

  // Un `attempt` illeggibile fallisce chiuso, direttamente e senza essere spacciato per «esauriti»
  // (vedi `decidiRitentativo`): non c'è un numero di tentativo su cui far decidere la RPC.
  return await fallisci(d, job, g, { rifiutato: false })
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
 *
 * `esauriti` dice che è l'ULTIMO tentativo: la risposta normale è `ok` con il job `failed` (la RPC ha
 * annotato `last_error_code` e delegato), e se la chiamata non arriva il ripiego su `video_job_fail`
 * conserva `tentativi_esauriti` nel log, che è ciò che dice di un fallimento definitivo per tentativi finiti.
 */
async function riprova(
  d: DipendenzeRunner,
  job: JobVideo,
  g: Guasto,
  decisione: { attesaSecondi: number; tentativiMassimi: number },
  opzioni: { esauriti?: boolean } = {},
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
      erroreDelGuasto(g),
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
    return await fallisci(d, job, g, {
      rifiutato: false,
      ...(opzioni.esauriti ? { tentativiEsauriti: true } : {}),
    })
  }

  // Un verdetto. La diagnosi di QUESTO tentativo non si butta: il job passa a un altro
  // worker, ma il motivo per cui questo è fallito resta l'unica traccia.
  loggaEsito(
    job,
    'warn',
    { esito: 'riprova-rifiutata', error_code: esito.code, tipo: g.classe },
    erroreDelGuasto(g),
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
    erroreDelGuasto(g),
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
    //
    // ⚠️ L'eccezione di `stop()` è un'eccezione dell'SDK come tutte le altre (secondario #163, che chiude
    // il #104): fa richieste autenticate, e il messaggio di un client HTTP che fallisce scrive volentieri
    // l'indirizzo che stava chiamando, token compreso. Il logger toglie le email e i codici fiscali, non gli
    // URL né i JWT: passa da `erroreSanificatoPerIlLog`, che ne tiene nome, stato, codice e il testo ripulito.
    loggaEsito(job, 'error', { esito: 'microvm-non-spenta' }, erroreSanificatoPerIlLog(err))
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
