import { NextResponse, type NextRequest } from 'next/server'

import { requireStaff } from '@/lib/auth/require-staff'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { schemaCorpoRunnerVideo, type CorpoRunnerVideo } from '@/lib/media/video/contratto'
import { eseguiProssimoJobVideo } from '@/lib/media/video/runner'
import { TETTO_INVOCAZIONE_MS } from '@/lib/media/video/runner'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { parseData, validationError, type ParseResult } from '@/lib/validation/http'

/**
 * IL BATTITO CHE FA GIRARE LA CONVERSIONE DEI VIDEO.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Fino al 2026-09-18 la pipeline video aveva tutti i pezzi e nessuno che la
 * avviasse: `eseguiProssimoJobVideo` non aveva un solo chiamante fuori dal proprio
 * modulo, e `vercel.json` non dichiarava nessun cron. Un genitore avrebbe caricato
 * il video, l'upload sarebbe riuscito, il job sarebbe rimasto `queued` **per
 * sempre**, e nei log non sarebbe comparso un solo errore — perché non sbagliava
 * niente: semplicemente non partiva niente. È la forma di guasto peggiore che
 * questo repository conosca, ed è la stessa delle email che per mesi non sono
 * arrivate mentre nessun test era rosso.
 *
 * Questa route è l'unica cosa che manca fra «tutti i pezzi esistono» e «i video si
 * convertono».
 *
 * ─── PERCHÉ UNA ROUTE HTTP E NON UN LAVORO SQL ──────────────────────────────
 *
 * Perché la conversione non avviene nel database: avviene in una MicroVM Vercel
 * che va aperta, sorvegliata e richiusa. Da Postgres non ci si arriva. Il lavoro
 * periodico lo dà `pg_cron`, che chiama **questa** porta con `pg_net` — la stessa
 * forma dei quattro giri di conservazione già in produzione.
 *
 * ─── DUE MODI DI ESSERE CHIAMATA (PR 2, spec §9) ────────────────────────────
 *
 *  · SENZA corpo (o con `{}`) — il giro del cron, ogni cinque minuti: recupera gli arrivi che il
 *    trigger non ha visto, fa partire un'invocazione per ogni job che ha bisogno di sorveglianza
 *    (il ventaglio), e sorveglia a sua volta un job. È la RETE di sicurezza di tutto il resto.
 *  · CON `{ "job_id": "<uuid>" }` — un calcio (`video_runner_kick`): il trigger che ha visto arrivare
 *    l'originale, il `PATCH caricato` del web, il ventaglio. Il job parte SUBITO, senza aspettare il
 *    cron, e solo se questa è l'unica invocazione a sorvegliarlo.
 *
 * Il corpo si legge DOPO il gate (`request.text()`, e non `parseBody`, che risponderebbe 400 a un
 * corpo vuoto — ed è proprio il corpo del cron) e si valida con uno schema `.strict()`: un
 * `{ "jobId": … }` col refuso prende 400 invece di essere scartato in silenzio come `{}`, cioè di
 * far fare al runner il giro intero senza dire a nessuno che il calcio non aveva capito.
 *
 * ─── LA CADENZA, E PERCHÉ RESTA DI CINQUE MINUTI ────────────────────────────
 *
 * Fino alla PR 2 era anche un vincolo: con un cron al minuto il tick N+1 partiva mentre il tick N
 * stava ancora sorvegliando, entrambi si attaccavano allo stesso Sandbox, entrambi chiamavano
 * `video_job_ready`, e il secondo prendeva un `OUTPUT_CONFLICT` su una conversione **riuscita** —
 * un `error` su un successo, cioè un allarme falso, e un allarme che suona sempre viene spento.
 * Adesso due invocazioni sullo stesso job non si pestano più i piedi: la sorveglianza è ESCLUSIVA
 * (`video_job_sorveglianza_prendi`) e chi non la ottiene risponde `gia-sorvegliato`, un esito
 * tranquillo.
 *
 * La cadenza non cambia lo stesso (spec §9: «il cron ogni cinque minuti resta la rete e non si
 * tocca»): i job ora partono dai calci, il cron serve a chi i calci li ha persi — un'invocazione
 * morta, `pg_net` che non ha consegnato — e cinque minuti sono il tempo massimo che un video
 * aspetta in quel caso. ⚠️ Il numero giusto lo dirà la misura sul campo, non questo commento.
 *
 * ─── QUANTE CONVERSIONI INSIEME ─────────────────────────────────────────────
 *
 * Un'invocazione sorveglia al più UN job: prenderne due vorrebbe dire che il secondo eredita il
 * tempo avanzato dal primo, cioè una sorveglianza più corta del previsto proprio sul job che ha
 * aspettato di più. Il parallelismo si ottiene con più invocazioni — i calci e il ventaglio — fino a
 * `VIDEO_CONVERSIONI_PARALLELE` (3 se non impostata): il tetto lo conta il database
 * (`CAPACITA_PIENA`), e chi lo trova pieno risponde `capacita-piena`, un esito tranquillo.
 */

/** Il nome del lavoro, in un posto solo: lo cercano il log, `/api/health` e il cron. */
const JOB = 'video-runner-tick'

/**
 * Il tetto della singola invocazione della piattaforma. Le route più pesanti del
 * repository dichiarano lo stesso numero. Il runner smette di sorvegliare quando sono passati
 * `TETTO_INVOCAZIONE_MS` (240 s) dall'INIZIO dell'invocazione, quindi questo è il margine che gli
 * resta per chiudere, non il tempo che intende usare.
 */
export const maxDuration = 300

/**
 * Il corpo del cron è `{}` e quello di un calcio `{"job_id":"<uuid>"}`: poche decine di byte. Oltre
 * questo non è un corpo di questa route, e si respinge prima di deserializzarlo e di depositarlo nel
 * contesto della richiesta.
 */
const MAX_CORPO_CARATTERI = 1024

/**
 * Gli esiti del runner che NON sono un guasto, elencati invece di dedotti: la coda
 * vuota è la risposta normale nelle ore in cui nessuno carica niente, e `in-corso`
 * è il funzionamento previsto di una conversione lunga. Trattarli come errori
 * significherebbe un registro pieno di allarmi nelle ventiquattro ore in cui non
 * succede niente.
 *
 * `gia-sorvegliato` e `capacita-piena` (PR 2) sono due modi in cui il runner fa il suo mestiere:
 * il primo è il caso normale di due calci sullo stesso job (e se fosse un `error` tornerebbe il falso
 * allarme che la sorveglianza esclusiva esiste per togliere), il secondo è il tetto delle
 * conversioni in parallelo che regge.
 */
const ESITI_TRANQUILLI = new Set([
  'coda-vuota',
  'in-corso',
  'pronto',
  'gia-sorvegliato',
  'capacita-piena',
])

/**
 * `in-riprova` — un guasto NOSTRO che il runner ha già preso in carico: il job è stato
 * rimesso in coda e riparte da sé (5, 10, 15 minuti, quattro tentativi in tutto).
 *
 * Né «tranquillo» né un guasto da gridare. Non è tranquillo perché qualcosa non ha funzionato
 * e va visto — se la build non si scarica, ogni video in coda farà lo stesso, e il battito
 * deve poterlo mostrare — ma non è nemmeno un `error`: il job non è perso, il runner ha fatto
 * ciò che doveva, e un allarme che suona a ogni ritentativo viene spento. `warn`: la riga
 * resta in `app_log` per trenta giorni, e l'`error` si riserva a ciò che è definitivo
 * (`fallito`) o rotto (`lease-persa`, `esito-non-scritto`, `presa-rifiutata`).
 */
const ESITI_DA_SEGUIRE = new Set(['in-riprova'])

/**
 * Il battito si distingue per OPERAZIONE (`distingui`), ed è ciò che rende vera la correzione di
 * `/api/health`. `app_log` deduplica per `(impronta, giorno)` e la riga che sopravvive tiene il
 * `contesto` della PRIMA occorrenza; l'impronta contiene livello, messaggio (qui l'`esito`) e rotta, e
 * il runner scrive anche lui, durante la stessa richiesta, un `cron`/`info`/`coda-vuota` sulla stessa
 * rotta (`operazione: 'video-runner'`). Senza il bersaglio le due righe cadevano nell'impronta
 * stessa (il messaggio di una riga senza errore è l'`esito`, `coda-vuota` per entrambe), e il giorno
 * restava con quella arrivata per prima. MISURATO in `app_log` il 2026-10-02, solo conteggi: nei 15
 * giorni dal 18/09 al 02/10 la riga `coda-vuota` del giorno è sopravvissuta 8 volte come `video-runner`
 * e 7 come `video-runner-tick` — una moneta al giorno — e nei giorni dell'altra faccia il controllo di
 * salute non vedeva il battito di `video-runner-tick` anche con la lista degli esiti giusta. Con il
 * bersaglio (`operazione=video-runner-tick` nell'impronta) la riga del battito è sempre e solo sua.
 */
const DISTINGUI_PER_OPERAZIONE = { distingui: ['operazione'] } as const

/**
 * Il corpo, già letto (DOPO il gate: la lettura sta nell'handler, `request.text()`, perché è lì che il lock
 * `corpo-letto-dopo-il-gate` la vede). Vuoto è ammesso — è quello del cron, e `parseBody` risponderebbe 400 —;
 * non vuoto deve essere un oggetto JSON con al più un `job_id` uuid.
 */
function interpretaIlCorpo(testo: string): ParseResult<CorpoRunnerVideo> {
  if (testo.length > MAX_CORPO_CARATTERI) {
    return { response: validationError([{ path: [], message: 'Corpo troppo grande' }]) }
  }

  let grezzo: unknown = {}
  if (testo.trim() !== '') {
    try {
      grezzo = JSON.parse(testo)
    } catch (err) {
      logEvento('cron', 'warn', { operazione: JOB, esito: 'corpo-json-malformato' }, err)
      return { response: validationError([{ path: [], message: 'Corpo JSON malformato' }]) }
    }
  }
  return parseData(schemaCorpoRunnerVideo, grezzo)
}

// ⚠️ Il nome della rotta è un LETTERALE e non `` `video/${JOB}:POST` ``, che sarebbe
// stato più asciutto. `logging-coverage` legge questo file come TESTO e confronta il
// nome con la posizione del file: un nome costruito da una variabile gli è invisibile,
// quindi passerebbe senza essere controllato — e il giorno in cui la cartella si
// sposta, il nome resterebbe quello vecchio senza che nulla lo segnali. Il nome della
// ROTTA (dov'è il file) e il nome del LAVORO (`JOB`, cosa cerca `/api/health`) sono due
// cose diverse e restano scritte separatamente.
export const POST = withRoute(
  'video/runner:POST',
  async (request: NextRequest): Promise<NextResponse> => {
    const t0 = Date.now()
    let esitoBattito = 'non-eseguito'
    let canale: 'cron' | 'manuale' = 'cron'
    let jobId: string | null = null
    let codice: string | null = null

    try {
      const secret = request.headers.get('x-cron-secret')
      if (!segretoCronValido(secret)) {
        // Si grida solo se l'intestazione c'è ma non torna: quello è un cron che
        // bussa con la chiave sbagliata, e sarebbe il guasto invisibile — la
        // conversione smette di partire e nessuno lo sa. Se manca del tutto è lo
        // staff che lancia il giro a mano, e il gate qui sotto è il suo.
        if (secret) {
          logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'secret-errato',
            msg: process.env.CRON_SECRET
              ? `${JOB}: x-cron-secret non corrispondente`
              : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
          })
        }
        const auth = await requireStaff(request)
        if (auth.response) {
          esitoBattito = 'non-autorizzato'
          return auth.response
        }
        canale = 'manuale'
      }

      // IL CORPO SI LEGGE QUI, E NON PRIMA: a un anonimo non si deserializza niente (lock
      // `corpo-letto-dopo-il-gate`, e la sua voce per questa route). `request.text()` sta QUI nell'handler e non
      // in un helper, e non è una questione di stile: il lock guarda il testo dell'handler, e una lettura
      // spostata in una funzione accanto gli sarebbe invisibile — verde perché non vede più niente.
      let testo: string
      try {
        testo = await request.text()
      } catch (err) {
        logEvento('cron', 'warn', { operazione: JOB, esito: 'corpo-illeggibile' }, err)
        esitoBattito = 'corpo-non-valido'
        return validationError([{ path: [], message: 'Corpo non leggibile' }])
      }
      const corpo = interpretaIlCorpo(testo)
      if ('response' in corpo) {
        esitoBattito = 'corpo-non-valido'
        return corpo.response
      }

      const esito = await eseguiProssimoJobVideo(
        corpo.data.job_id === undefined ? {} : { jobId: corpo.data.job_id },
      )
      esitoBattito = esito.esito

      if (esito.esito === 'non-configurato') {
        // Configurazione mancante = `error`, mai `info`. E qui vale doppio: senza
        // `VIDEO_RUNNER_OWNER_ID` il runner non parte affatto, quindi la coda si
        // riempie in silenzio — che è esattamente il guasto che questa route esiste
        // per impedire.
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: esitoBattito,
          canale,
          ms: Date.now() - t0,
          msg: `${JOB}: manca ${esito.variabile}, nessun video verra' convertito finche' non e' impostata`,
        })
        return NextResponse.json(
          { ok: false, codice: 'CONFIGURAZIONE_ASSENTE' },
          { status: 503 },
        )
      }

      if ('jobId' in esito && esito.jobId !== undefined) jobId = esito.jobId
      if ('codice' in esito) codice = esito.codice

      return NextResponse.json({ ok: true, esito: esito.esito }, { status: 200 })
    } finally {
      // IL BATTITO SI SCRIVE SEMPRE, anche quando non c'era niente da fare e anche
      // quando il giro è esploso. Con i soli errori, «nessun log» non distingue
      // «nessuno ha caricato video» da «il cron non chiama più»: sono due fatti
      // diversi e uno dei due è un guasto.
      const livello = ESITI_TRANQUILLI.has(esitoBattito)
        ? 'info'
        : ESITI_DA_SEGUIRE.has(esitoBattito)
          ? 'warn'
          : 'error'
      logEvento(
        'cron',
        livello,
        {
          operazione: JOB,
          esito: esitoBattito,
          canale,
          ms: Date.now() - t0,
          tetto_invocazione_ms: TETTO_INVOCAZIONE_MS,
          ...(jobId ? { job_id: jobId } : {}),
          ...(codice ? { error_code: codice } : {}),
        },
        undefined,
        DISTINGUI_PER_OPERAZIONE,
      )
    }
  },
)
