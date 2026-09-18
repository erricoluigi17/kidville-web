import { NextResponse, type NextRequest } from 'next/server'

import { requireStaff } from '@/lib/auth/require-staff'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { eseguiProssimoJobVideo } from '@/lib/media/video/runner'
import { TETTO_INVOCAZIONE_MS } from '@/lib/media/video/runner'
import { segretoCronValido } from '@/lib/security/segreto-cron'

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
 * ─── LA CADENZA, E PERCHÉ NON È OGNI MINUTO ─────────────────────────────────
 *
 * Il runner tiene **un job alla volta** e un'invocazione lo sorveglia fino a
 * `TETTO_INVOCAZIONE_MS` (240 s), poi esce con `in-corso` lasciando la MicroVM
 * accesa: il tick successivo la riaggancia per nome. La cadenza del cron deve
 * quindi essere **più lunga del tetto dell'invocazione**, e non è una preferenza.
 *
 * Con un cron al minuto, il tick N+1 partirebbe mentre il tick N sta ancora
 * sorvegliando: `video_job_claim` con lo stesso owner è idempotente, quindi
 * entrambi si attaccherebbero **allo stesso Sandbox**, entrambi leggerebbero il
 * marcatore, ed entrambi chiamerebbero `video_job_ready`. Il primo vince; il
 * secondo riceve `OUTPUT_CONFLICT` e scrive una riga a livello `error` su una
 * conversione **riuscita**. Non si corrompe niente — le tre guardie del database e
 * il fence nel nome della MicroVM reggono — ma si riempie il registro di allarmi
 * falsi, e un allarme che suona sempre viene spento: il giorno in cui il guasto è
 * vero non se ne accorge nessuno.
 *
 * Cinque minuti contro 240 s di tetto lasciano ~50 s di margine. Il prezzo è
 * dichiarato: un video appena caricato aspetta fino a cinque minuti prima che la
 * conversione **cominci**, e una conversione lunga avanza a cicli di quattro minuti
 * su cinque. ⚠️ Il numero giusto lo dirà la misura sul campo (V15), non questo
 * commento: se le conversioni vere risultassero molto più corte del tetto,
 * accorciare la cadenza diventa sicuro e va fatto — ma allora va accorciato anche
 * `TETTO_INVOCAZIONE_MS`, perché è quello il vincolo, non il cron.
 *
 * ─── COSA NON FA ────────────────────────────────────────────────────────────
 *
 * Non converte più di un job per giro, e non è una svista: il runner è costruito
 * per tenerne uno, e prenderne due in una invocazione significherebbe che il
 * secondo eredita il tempo avanzato dal primo — cioè una sorveglianza più corta del
 * previsto proprio sul job che ha aspettato di più. Quando la coda avrà bisogno di
 * più cavalli, la strada è un secondo `VIDEO_RUNNER_OWNER_ID` con il suo schedule,
 * non un ciclo qui dentro: i job si distribuiscono da soli, perché
 * `video_job_next` usa `FOR UPDATE SKIP LOCKED`.
 */

/** Il nome del lavoro, in un posto solo: lo cercano il log, `/api/health` e il cron. */
const JOB = 'video-runner-tick'

/**
 * Il tetto della singola invocazione della piattaforma. Le route più pesanti del
 * repository dichiarano lo stesso numero. Il runner esce da solo a
 * `TETTO_INVOCAZIONE_MS` (240 s), quindi questo è il margine che gli resta per
 * chiudere, non il tempo che intende usare.
 */
export const maxDuration = 300

/**
 * Gli esiti del runner che NON sono un guasto, elencati invece di dedotti: la coda
 * vuota è la risposta normale nelle ore in cui nessuno carica niente, e `in-corso`
 * è il funzionamento previsto di una conversione lunga. Trattarli come errori
 * significherebbe un registro pieno di allarmi nelle ventiquattro ore in cui non
 * succede niente.
 */
const ESITI_TRANQUILLI = new Set(['coda-vuota', 'in-corso', 'pronto'])

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

      const esito = await eseguiProssimoJobVideo()
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

      if ('jobId' in esito) jobId = esito.jobId
      if ('codice' in esito) codice = esito.codice

      return NextResponse.json({ ok: true, esito: esito.esito }, { status: 200 })
    } finally {
      // IL BATTITO SI SCRIVE SEMPRE, anche quando non c'era niente da fare e anche
      // quando il giro è esploso. Con i soli errori, «nessun log» non distingue
      // «nessuno ha caricato video» da «il cron non chiama più»: sono due fatti
      // diversi e uno dei due è un guasto.
      logEvento('cron', ESITI_TRANQUILLI.has(esitoBattito) ? 'info' : 'error', {
        operazione: JOB,
        esito: esitoBattito,
        canale,
        ms: Date.now() - t0,
        tetto_invocazione_ms: TETTO_INVOCAZIONE_MS,
        ...(jobId ? { job_id: jobId } : {}),
        ...(codice ? { error_code: codice } : {}),
      })
    }
  },
)
