import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseQuery } from '@/lib/validation/http'
import {
  arubaSignin,
  arubaGetByFilename,
  arubaGetNotifications,
  resolveArubaCredentials,
  PAUSA_FRA_PAGINE_MS,
  type ArubaConfig,
  type ArubaInvoiceStatus,
} from '@/lib/aruba/client'
import {
  mapStatoAruba,
  aggregaFatturaStato,
  etichettaStatoAruba,
  motivoScartoAruba,
  motivoDalleNotificheSdi,
  scartoSenzaDescrizione,
  type RigaFatturaAgg,
} from '@/lib/aruba/stato'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { segretoCronValido } from '@/lib/security/segreto-cron'

// POST /api/pagamenti/fattura/sync — polling stato SDI delle fatture in volo.
// SERVICE-TO-SERVICE: richiede header `x-cron-secret` (pattern push/dispatch).
// Lo invoca il cron pg_cron (vedi migrazione). Per ogni fattura non terminale
// interroga Aruba, mappa lo stato (DL-020) e, su scarto, notifica la Segreteria.
/**
 * Gli stati che il cron rinterroga. Lo `0` è la voce importante, ed è entrata il 2026-09-11.
 *
 * `0` è «non ancora interpretato» (vedi `CODICE_NON_INTERPRETATO` in `stato.ts`): non è uno
 * stato che Aruba abbia mai risposto, è ciò che scriviamo quando NON abbiamo capito la sua
 * risposta. Fino al 2026-09-11 il client leggeva lo stato dal posto sbagliato e scriveva `0`
 * ogni volta; `0` non era in questa lista, quindi ogni fattura veniva interrogata UNA volta
 * sola — la prima — e restava congelata per sempre. **153 righe** erano ferme così, e quattro
 * di quelle risultavano SCARTATE su Aruba: fatture NON emesse, da correggere e ritrasmettere,
 * che in Segreteria apparivano come tutte le altre.
 *
 * Corretta la lettura (client.ts), lo `0` nasce ormai solo da una dicitura che Aruba ha
 * risposto e che la nostra tabella non conosce — un caso raro e già gridato a livello `error`
 * dal client — quindi la coda non cresce senza controllo. Ma le righe storiche non
 * rientrerebbero da sole: è questa riga che le ripesca.
 */
const STATI_IN_VOLO = [0, 1, 3, 5]

const postQuerySchema = z.object({}) // nessun parametro in ingresso

// Battito cardiaco del cron: pg_net chiama in fire-and-forget con `EXCEPTION WHEN OTHERS
// THEN null`, quindi un job che non parte non lascia traccia — si sorveglia l'ASSENZA.
// `operazione` e non `job` (lista bianca di `redact`), e il nome nel `msg` perché
// `app_log` deduplica per (fingerprint, giorno) e il `contesto` NON è nell'impronta.
// La spiegazione per esteso è in `src/app/api/push/dispatch/route.ts`.
const JOB = 'fattura-sync'

/* ────────────────────────────────────────────────────────────────────────────
 * IL RITMO DEL GIRO. Aggiunto il 2026-09-11 insieme allo `0` in `STATI_IN_VOLO`.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ LO `0` IN CODA HA RIEMPITO UNA CODA CHE ERA VUOTA, e questo giro non era
 * dimensionato per una coda piena.
 *
 * Prima del 2026-09-11 `STATI_IN_VOLO` era `[1, 3, 5]` e in produzione trovava
 * **zero righe**: il ciclo non partiva mai, quindi nessuno si era accorto che
 * dentro non c'è **nessuna pausa** fra una chiamata ad Aruba e la successiva,
 * con un `.limit(200)`. Ammesso lo `0`, al primo giro dopo il rilascio
 * rientrano in coda le **153 righe** congelate — cioè fino a 200
 * `getByFilename` di fila, a raffica.
 *
 * Il tetto vero: SLA §3 di Aruba dà **12 richieste al minuto per IP** sulla
 * ricerca delle fatture inviate — **una ogni cinque secondi** — e «rifiuta
 * istantaneamente con HTTP 429» senza accodare (la citazione per esteso sta su
 * `PAUSA_FRA_PAGINE_MS`, in `client.ts`). Duecento richieste senza pause sono
 * due ordini di grandezza sopra, e i `429` non li prenderebbe solo questo giro:
 * il secchio è per IP, quindi si porterebbe via anche lo slot di chi in quel
 * momento sta emettendo dal pannello.
 *
 * La mitigazione è in tre pezzi, e sono tutti e tre necessari:
 *
 *  1. `TETTO_PER_GIRO` — quante righe al massimo si toccano in un tick;
 *  2. `PAUSA_FRA_PAGINE_MS` prima di OGNI `getByFilename` (la stessa costante
 *     che governa la paginazione, perché è lo stesso secchio);
 *  3. `TETTO_TEMPO_MS` — si smette prima che sia la piattaforma a interrompere
 *     a metà di una scrittura.
 *
 * ⏱️ IL CONTO, detto prima che qualcuno lo scopra: 30 righe × 5 s = 150 s di
 * sole attese, più il tempo di risposta e le scritture. Le 153 righe congelate
 * rientrano quindi in **~6 tick**, cioè circa tre ore con il cron ogni trenta
 * minuti. È lento di proposito: la coda si sta svuotando di un arretrato, non
 * inseguendo un evento.
 */
const TETTO_PER_GIRO = 30

/**
 * Quando si smette di prendere righe nuove, anche se il tetto qui sopra non è
 * stato raggiunto.
 *
 * `maxDuration` è 300 s: senza questo margine, un giro lento verrebbe
 * interrotto DALLA PIATTAFORMA in un punto qualunque — magari fra l'UPDATE di
 * `fatture_emesse` e quello di `pagamenti`, che è esattamente la divergenza
 * permanente fra le due tabelle contro cui questo file mette una guardia più
 * sotto. Sessanta secondi di margine coprono l'ultima iterazione (il tetto di
 * `externalFetch` per Aruba è 30 s per singola richiesta) e la sua coda di
 * scritture.
 */
const TETTO_TEMPO_MS = 240_000

/* ────────────────────────────────────────────────────────────────────────────
 * IL RIENTRO DEGLI SCARTI SENZA MOTIVO. Aggiunto il 2026-09-11, dopo un rilievo
 * che diceva — a ragione — che il lavoro non arrivava alle righe per cui era nato.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ IL RECUPERO DAL CANALE DELLE NOTIFICHE NON RAGGIUNGEVA NESSUNA DELLE RIGHE PER CUI
 * ERA STATO SCRITTO, e il motivo è geometrico, non concettuale.
 *
 * Quel codice vive DENTRO il ciclo del giro, dopo il `continue` che salta le righe il cui
 * stato non è cambiato: è raggiungibile solo nell'istante in cui una fattura PASSA a scarto.
 * Ma `STATI_IN_VOLO` non contiene gli stati di scarto — appena una fattura ci arriva ESCE
 * dalla coda e nessun giro la ripesca; e se anche la ripescasse, `stato.stato === f.sdi_stato`
 * la salterebbe, perché Aruba continua a rispondere «Scartata».
 *
 * Misurato in produzione il 2026-09-11: `sdi_stato = 4` su **4 righe, tutte e 4** con
 * «nessun motivo dal provider», e zero fatture di scarto in volo. Sarebbero rimaste così per
 * sempre — mentre la nuova scheda della Segreteria mostra un riquadro che promette una
 * spiegazione e renderebbe quella frase.
 *
 * ─── PERCHÉ NON BASTA METTERE IL `4` IN `STATI_IN_VOLO` ─────────────────────
 * Perché quello è un elenco di stati NON TERMINALI. Mettercelo rimetterebbe in coda ogni
 * fattura scartata a OGNI giro, per sempre, a due richieste Aruba ciascuna (stato +
 * notifiche) su un secchio da 12 al minuto **per IP** — che è anche di chi in quel momento
 * sta emettendo dal pannello. Un difetto di spreco al posto di un difetto di silenzio.
 *
 * La forma sana è una SECONDA query, con un tetto suo, che non chiede lo STATO (quella
 * fattura è terminale: lo stato non cambierà più) ma solo le NOTIFICHE, e che riscrive solo
 * `sdi_scarto_motivo`.
 */

/**
 * Gli stati che `stato.ts` marca `isScarto` — oggi `2`, `4`, `9`. **Derivati, non copiati**:
 * una lista scritta a mano qui divergerebbe in silenzio il giorno in cui la tabella cambia,
 * e il sintomo sarebbe una classe di fatture respinte che non rientra mai. Il range arriva a
 * 20 perché le diciture note stanno in `1..10` e restare stretti sul massimo di oggi è
 * esattamente il modo di non accorgersi di un undicesimo.
 */
let statiScartoCache: number[] | null = null
function statiDiScarto(): number[] {
  // ⚠️ PIGRA, e non per eleganza: calcolata a livello di modulo, questa lista viene costruita
  // all'IMPORT della route. `__tests__/api/cron-secret.test.ts` sostituisce `@/lib/aruba/stato`
  // con un mock parziale (`{ mapStatoAruba: vi.fn() }`, che ritorna `undefined`) e il file
  // esplodeva prima che un solo test partisse — con un errore che accusava questa riga e non
  // il mock. Un calcolo a tempo d'import che dipende dal comportamento di un altro modulo è
  // una dipendenza nascosta: rimandarlo alla prima chiamata la toglie.
  statiScartoCache ??= Array.from({ length: 21 }, (_, codice) => codice).filter((c) => mapStatoAruba(c).isScarto)
  return statiScartoCache
}

/**
 * 🔴 IL SEGNO CHE PER QUESTA RIGA IL RIENTRO HA GIÀ SPESO LA SUA RICHIESTA — cioè la
 * TERMINAZIONE, che è la parte difficile di tutto questo blocco.
 *
 * Senza, una fattura le cui notifiche non danno (e non daranno) nessun motivo tornerebbe in
 * coda a ogni tick, per sempre: un ciclo che consuma il budget Aruba in eterno è peggio del
 * difetto che sta chiudendo. Dopo UN tentativo la riga esce, e ci esce in modo VISIBILE.
 *
 * Sta dentro `sdi_scarto_motivo` e non in una colonna sua per due ragioni, la seconda più
 * importante della prima: non c'è una colonna per i tentativi e una migrazione non è in
 * perimetro; ma soprattutto quella è **la colonna che la Segreteria apre** per capire cosa
 * correggere prima di ritrasmettere, e «ci abbiamo provato, non c'era» è un'informazione
 * vera che lì dentro vale molto più del silenzio. Un marcatore in una colonna tecnica
 * l'avrebbe saputo solo chi legge il codice.
 *
 * ⚠️ Niente virgole, parentesi, `%` o `_`: questa stringa finisce dentro un pattern `ilike`
 * di PostgREST, dove `%`/`_` sono jolly e la punteggiatura complica il parsing del filtro.
 */
const MARCATORE_RIENTRO = 'notifiche SDI interrogate'

/**
 * Il frammento che `motivoScartoAruba` lascia nei suoi DUE rami difensivi — «nessun motivo
 * dal provider» e «nessuna descrizione dal provider». È il riconoscimento di un motivo
 * povero fatto sulla STRINGA, e va detto che è il punto debole del blocco: `stato.ts`
 * avverte, giustamente, che riconoscere quel ramo dal nostro testo italiano smette di
 * funzionare il giorno in cui qualcuno riscrive la frase.
 *
 * Qui non c'è alternativa — nel rientro i dettagli di Aruba non ci sono più, c'è solo la
 * riga a registro — quindi la divergenza non si previene, **si fa gridare**: un lock in
 * `__tests__/api/fattura-sync-notifiche.test.ts` chiama `motivoScartoAruba` con dettagli
 * vuoti e verifica che ciò che scrive contenga ancora questo frammento. Chi riscrive quella
 * frase trova un test rosso, non un rientro muto.
 */
const FRAMMENTO_MOTIVO_POVERO = 'dal provider'

/**
 * Quante righe il rientro ripara al massimo in un tick: una richiesta Aruba ciascuna, più
 * la pausa da cinque secondi che le separa.
 *
 * Deliberatamente piccolo. Il rientro è un ARRETRATO che si smaltisce, non un evento da
 * inseguire: con i quattro scarti misurati il 2026-09-11 si chiude in due tick, cioè
 * un'ora. Alzarlo comprerebbe un'ora e costerebbe slot a chi sta emettendo.
 */
const TETTO_RIENTRO_PER_GIRO = 2

/**
 * Quante righe si LEGGONO dal database per trovarne `TETTO_RIENTRO_PER_GIRO` da riparare.
 * È una query Postgres, non una richiesta ad Aruba: costa pochissimo, e un tetto largo
 * evita che un giorno le righe già tentate — che il filtro esclude in SQL — saturino la
 * finestra e nascondano quelle nuove.
 */
const TETTO_LETTURA_RIENTRO = 100

/**
 * `maxDuration` è la dichiarazione di quanto può durare la route, e con le pause
 * qui sopra questo giro dura minuti, non secondi. Senza, la piattaforma taglia
 * al default e la coda non si svuota mai.
 *
 * 300 è il valore già usato dalle altre tre route lunghe del repository
 * (`fattura`, `fattura/lotto`, `riconciliazione`): stesso limite, stessa ragione.
 */
export const maxDuration = 300

const attendi = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Query fallita → riga d'errore parlante + 500, e NESSUN battito «ok».
 *
 * PostgREST non lancia, ritorna `{ error }` (regola 7 di AGENTS.md): il `try/catch` di questo
 * handler non scatta mai su una query rotta. Qui il ramo non controllato è particolarmente
 * insidioso perché la route ha già una nozione legittima di «salto questa scuola»
 * (`credenziali-mancanti`): una lettura fallita ci si travestirebbe dentro, e il giro
 * chiuderebbe «ok» mentre uno scarto SDI resta invisibile. La spiegazione per esteso è in
 * `src/app/api/push/dispatch/route.ts`.
 */
function queryFallita(azione: string, error: unknown, t0: number, scuolaId?: string): NextResponse {
  // `scuola_id` è un uuid: `redact` lascia in chiaro i valori auto-descrittivi, quindi anche
  // nella riga persistita si legge QUALE scuola stava fallendo.
  logEvento(
    'cron',
    'error',
    {
      operazione: JOB,
      esito: 'query-fallita',
      azione,
      scuola_id: scuolaId,
      ms: Date.now() - t0,
      msg: `${JOB}: ${azione} fallita`,
    },
    error,
  )
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
}

export const POST = withRoute('pagamenti/fattura/sync:POST', async (request: Request) => {
  const t0 = Date.now()
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!segretoCronValido(secret)) {
      // Si grida SOLO se l'header c'è ma non torna: quello è un cron che bussa con la chiave
      // sbagliata, ed è il guasto invisibile (se questo giro non parte, le fatture restano «in
      // volo» per sempre e nessuno si accorge di uno scarto SDI). Sul POST ANONIMO si tace: la
      // route è pubblica e senza rate-limit, e una riga `error` per ogni `curl` fabbricherebbe
      // dal nulla proprio il segnale «il cron è rotto» che questa riga serve a portare.
      // Il messaggio separa i due incidenti veri (secret sbagliato nel Vault del DB;
      // `CRON_SECRET` assente su Vercel — quest'ultimo già gridato dal preflight di
      // `src/instrumentation.ts`).
      if (secret) {
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'secret-errato',
          msg: process.env.CRON_SECRET
            ? `${JOB}: x-cron-secret non corrispondente`
            : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
        })
      }
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
    }
    logEvento('cron', 'info', { operazione: JOB, esito: 'avviato', msg: `${JOB}: avviato` })

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const { data: pendenti, error: errPendenti } = await supabase
      .from('fatture_emesse')
      .select('id, pagamento_id, scuola_id, numero, aruba_filename, sdi_stato')
      .in('sdi_stato', STATI_IN_VOLO)
      .not('aruba_filename', 'is', null)
      // Era 200. Vedi `TETTO_PER_GIRO`: con lo `0` in `STATI_IN_VOLO` questa query
      // ha smesso di tornare vuota, e duecento chiamate ad Aruba senza pause sono
      // ~17 volte il limite dichiarato di 12/min.
      .limit(TETTO_PER_GIRO)
    // Senza questo controllo «la query è fallita» e «nessuna fattura in volo» sono lo stesso
    // ramo — e il secondo chiude con un «ok».
    if (errPendenti) return queryFallita('lettura fatture_emesse', errPendenti, t0)

    const righe = (pendenti ?? []) as {
      id: string
      pagamento_id: string
      scuola_id: string
      numero: number
      aruba_filename: string
      sdi_stato: number
    }[]
    // ⚠️ QUI C'ERA UNA USCITA ANTICIPATA su `righe.length === 0`, ed è stata tolta il
    // 2026-09-11. Scriveva il battito «ok» e tornava: perfetto finché il giro aveva una cosa
    // sola da fare. Col rientro ne ha due, e «nessuna fattura in volo» è il caso NORMALE in
    // produzione (al 2026-09-11: zero scarti in volo, quattro scarti fermi da riparare):
    // uscire lì significava non ripescare mai niente — cioè lasciare intatto il difetto che
    // il rientro esiste per chiudere. Il battito «ok» non si perde: lo scrive la chiusura in
    // fondo, con gli stessi `esito` e `msg` e qualche contatore in più.
    const configCache = new Map<string, ArubaConfig | null>()
    /**
     * ⚠️ LA CHIAVE È L'UTENZA ARUBA, NON LA SCUOLA, e la differenza vale dei `429`.
     *
     * Era `scuola_id`, e su tre sedi produceva **tre `signin` di fila** — mentre Aruba
     * ne concede **uno al minuto per IP**. Il secondo e il terzo prendevano `429` da
     * soli, e il giro si portava via anche lo slot di chiunque altro stesse emettendo:
     * il 2026-09-07 un `signin` del lotto ha preso `429` con novanta secondi di
     * intervallo, e questo cron gira ogni trenta minuti.
     *
     * Le tre sedi usano **una sola utenza** (`aruba_config->>'username'` distinto = 1
     * su 3, misurato): chiavare sull'utenza fa un accesso solo e non aspetta niente.
     * Se un giorno le utenze diventassero davvero tre, la chiave le distinguerebbe da
     * sé — ed è il motivo per cui non è semplicemente una variabile fuori dal ciclo.
     */
    const tokenCache = new Map<string, string>()
    const chiaveUtenza = (ambiente: string | undefined, username: string) => `${ambiente ?? 'demo'}|${username}`
    // Scuole saltate per gating credenziali: MAI in silenzio (M2.4) — contate,
    // loggate e riportate nella risposta con il motivo.
    const scuoleSkipped = new Set<string>()
    let processate = 0
    let scartate = 0
    let esaminate = 0
    /** Vero se si è usciti dal ciclo per tempo, non per esaurimento delle righe. */
    let interrottoPerTempo = false
    /** Quante volte si sono interrogate le NOTIFICHE: una richiesta ad Aruba ciascuna. */
    let lettureNotifiche = 0
    /** Quante righe il RIENTRO ha riparato in questo giro. */
    let rientri = 0
    /**
     * Le fatture che il ciclo ha già toccato in QUESTO giro. Serve al rientro: una riga
     * appena portata a scarto ha già pagato la sua richiesta di notifiche qui dentro, e
     * ri-chiedergliele dieci righe più sotto sarebbero due richieste per una riga sola,
     * nello stesso minuto, sullo stesso secchio da 12.
     */
    const esaminateIds = new Set<string>()

    /**
     * LE CREDENZIALI E IL TOKEN DI UNA SCUOLA, in un posto solo.
     *
     * Estratto dal ciclo il 2026-09-11 perché il RIENTRO ha bisogno esattamente delle stesse
     * tre cose — config, gate sulle credenziali, token riusato — e una seconda copia sarebbe
     * divergere: basta che una delle due dimentichi la cache dell'utenza per fare un `signin`
     * in più, e Aruba ne concede **uno al minuto per IP**.
     *
     * Ritorna un esito a tre valori invece di lanciare: «errore» porta con sé la risposta 500
     * già formata (una query fallita chiude il giro, non lo fa proseguire con dati finti),
     * «salta» è la scuola senza Aruba, che è la normalità e va solo contata.
     */
    type EsitoToken =
      | { esito: 'ok'; token: string; ambiente: string | undefined }
      | { esito: 'salta' }
      | { esito: 'errore'; response: NextResponse }

    const tokenPerScuola = async (scuolaId: string): Promise<EsitoToken> => {
      if (!configCache.has(scuolaId)) {
        const { data: settings, error } = await supabase
          .from('admin_settings')
          .select('aruba_config')
          .eq('scuola_id', scuolaId)
          .maybeSingle()
        // Una lettura fallita darebbe `cfg = null` → la scuola verrebbe saltata con il `warn`
        // `credenziali-mancanti`, cioè con una DIAGNOSI SBAGLIATA: chi legge quella riga va a
        // configurare Aruba per una scuola che Aruba ce l'ha già. Un log che accusa il posto
        // sbagliato fa perdere più tempo di un log che manca.
        if (error) {
          return { esito: 'errore', response: queryFallita('lettura admin_settings', error, t0, scuolaId) }
        }
        configCache.set(scuolaId, (settings?.aruba_config ?? null) as ArubaConfig | null)
      }
      const cfg = configCache.get(scuolaId)
      const creds = cfg ? resolveArubaCredentials(cfg) : null
      if (!cfg?.abilitato || !creds) {
        if (!scuoleSkipped.has(scuolaId)) {
          scuoleSkipped.add(scuolaId)
          // `warn` e non `error`: una scuola con Aruba deliberatamente spento è la
          // normalità, non un incidente. Ma non può sparire in silenzio (M2.4) — le sue
          // fatture restano in volo per sempre e il giro chiude comunque «ok».
          // `scuola_id` è un uuid: `redact` lascia in chiaro i valori auto-descrittivi,
          // quindi si legge QUALE scuola anche nella riga persistita.
          logEvento('cron', 'warn', {
            operazione: JOB,
            esito: 'credenziali-mancanti',
            scuola_id: scuolaId,
            abilitato: Boolean(cfg?.abilitato),
            msg: `${JOB}: scuola saltata, credenziali Aruba non configurate`,
          })
        }
        return { esito: 'salta' }
      }

      const chiave = chiaveUtenza(cfg.ambiente, creds.username)
      const inCache = tokenCache.get(chiave)
      if (inCache) return { esito: 'ok', token: inCache, ambiente: cfg.ambiente }
      try {
        const token = (await arubaSignin(cfg.ambiente, creds)).accessToken
        tokenCache.set(chiave, token)
        return { esito: 'ok', token, ambiente: cfg.ambiente }
      } catch (e) {
        // Era un `catch { continue }` MUTO, ed è il divieto n° 6 di AGENTS.md: se il
        // login ad Aruba fallisce (password ruotata, ambiente sbagliato, SDI giù) le
        // fatture di questa scuola non vengono più interrogate — e la route risponde
        // 200 con `processate: 0`, che si legge come «niente da fare».
        logEvento('cron', 'error', { operazione: JOB, esito: 'aruba-signin-fallita', scuola_id: scuolaId }, e)
        return { esito: 'salta' }
      }
    }

    /**
     * IL PERCHÉ DI UNO SCARTO, quando `getByFilename` non l'ha dato.
     *
     * ─── IL FATTO, 2026-09-11 ───────────────────────────────────────────────────
     * La prima fattura respinta dopo la correzione della lettura di stato è emersa alle
     * 10:31Z e a registro è finito «Aruba: «Scartata» — nessun motivo dal provider»:
     * `statusDescription`, `errorCode` ed `errorDescription` erano TUTTI VUOTI. Non è una
     * risposta arrivata tardi, e aspettare il tick dopo non serve: **su quel canale il
     * motivo non c'è**. Lo SdI il perché lo scrive in una NOTIFICA (`NS`), che ha un
     * endpoint suo.
     *
     * ─── LE QUATTRO REGOLE DI QUESTA CHIAMATA, tutte necessarie ─────────────────
     *  1. SOLO sugli scarti senza descrizione. Sono 4 righe su 153, e Aruba concede 12
     *     ricerche al minuto PER IP: una richiesta in più su ogni fattura regolare
     *     raddoppierebbe il consumo di un secchio che è anche di chi sta emettendo.
     *  2. LA STESSA PAUSA del resto del giro (`PAUSA_FRA_PAGINE_MS`), perché è lo stesso
     *     secchio — e il tetto di tempo va controllato PRIMA di spenderla, o la si paga
     *     per poi farsi tagliare da `maxDuration` a metà di una scrittura.
     *  3. IL TOKEN DEL GIRO, mai un signin nuovo: di quelli Aruba ne concede UNO AL MINUTO.
     *  4. FAIL-OPEN. Qualunque cosa vada storta qui — `429`, timeout, forma ignota — lo
     *     stato SDI si scrive lo stesso, col motivo povero. Un errore su una chiamata
     *     accessoria degrada l'informazione; non può far perdere il lavoro del giro.
     *
     * ─── 🔴 E LA REGOLA DI PRIVACY, che vale più delle quattro ──────────────────
     * Il corpo di una notifica SDI contiene i dati di FATTURAZIONE di una famiglia:
     * denominazione, codice fiscale, partita IVA dell'intestatario. Non si logga mai il
     * corpo, e non si loggano mai i valori — nemmeno il motivo, che pure è ciò che stiamo
     * cercando. Il motivo va in `sdi_scarto_motivo`, che è una COLONNA: è lì che la
     * Segreteria lo legge per correggere e ritrasmettere, e lì ci deve stare. Nel log
     * finiscono i NOMI dei campi e la loro forma (tipo, lunghezza, conteggi), che è ciò che
     * serve a capire la struttura alla prima notifica vera e non espone nessuno. Vedi
     * `descriviForma` in `stato.ts`.
     */
    /**
     * ─── L'ESITO, E PERCHÉ NON BASTA `string | null` ───────────────────────────
     * Il rientro deve distinguere «ho chiesto e non c'era niente» da «non sono riuscito a
     * chiedere» da «non ho nemmeno provato, era finito il tempo»: sono tre cose diverse, e
     * solo le prime due consumano il tentativo. Con un `null` solo, un tetto di tempo
     * marcherebbe la riga come già tentata e le toglierebbe l'unica occasione che ha.
     */
    type EsitoNotifiche = {
      motivo: string | null
      esito: 'trovato' | 'nessun-motivo' | 'fallita' | 'tetto-tempo'
    }

    const motivoDalleNotifiche = async (
      ambiente: string | undefined,
      accessToken: string,
      // `riga` e non `f`: dentro il ciclo `f` esiste già, e due nomi uguali a un livello di
      // distanza sono il modo di leggere la fattura sbagliata senza che niente protesti.
      riga: { id: string; scuola_id: string; numero: number; aruba_filename: string },
    ): Promise<EsitoNotifiche> => {
      // Il tetto di tempo si controlla PRIMA di spendere la pausa, e comprende la pausa:
      // una scrittura tagliata a metà da `maxDuration` lascerebbe `fatture_emesse` e
      // `pagamenti` divergenti per sempre.
      if (Date.now() - t0 + PAUSA_FRA_PAGINE_MS > TETTO_TEMPO_MS) {
        // ⚠️ QUI IL COMMENTO DICEVA IL FALSO, ed è stato corretto il 2026-09-11.
        // Sosteneva che «le righe rimaste tornano al giro successivo»: vero per le righe che
        // il ciclo non ha ESAMINATO, falso proprio per questa. Sul percorso principale lo
        // stato terminale viene scritto lo stesso (ed è giusto: è un dato con conseguenza
        // fiscale, e ritardarlo per una frase sarebbe il compromesso sbagliato), quindi la
        // riga esce da `STATI_IN_VOLO` e quella coda non la ripesca mai più.
        //
        // Adesso la frase torna vera, ma per un'altra strada: la riga resta uno scarto col
        // motivo povero e senza marcatore, cioè **esattamente ciò che il rientro cerca**. È
        // la seconda query a riprenderla, non la prima — e per questo `warn` è il livello
        // giusto: non è un guasto né una perdita, è la rinuncia deliberata a spendere uno
        // slot del secchio quando il giro sta per chiudere.
        logEvento('cron', 'warn', {
          operazione: JOB,
          esito: 'notifiche-saltate-tempo',
          scuola_id: riga.scuola_id,
          fattura_id: riga.id,
          numero: riga.numero,
          msg: `${JOB}: tetto di tempo, il motivo lo riprende il rientro al giro successivo`,
        })
        return { motivo: null, esito: 'tetto-tempo' }
      }
      await attendi(PAUSA_FRA_PAGINE_MS)
      lettureNotifiche++
      let risposta: unknown
      try {
        risposta = await arubaGetNotifications(ambiente, accessToken, riga.aruba_filename)
      } catch (e) {
        // Il corpo del provider viaggia come `cause` (AGENTS.md, regola 3): un `429` (nove
        // l'08/09) e un `404` si sistemano in due modi opposti, e `notifiche-fallite` da
        // solo non li distingue.
        logEvento(
          'cron',
          'error',
          {
            operazione: JOB,
            esito: 'notifiche-fallite',
            scuola_id: riga.scuola_id,
            fattura_id: riga.id,
            numero: riga.numero,
            msg: `${JOB}: notifiche SDI non lette, lo scarto resta senza motivo`,
          },
          e,
        )
        return { motivo: null, esito: 'fallita' }
      }

      const lettura = motivoDalleNotificheSdi(risposta)
      if (lettura.motivo === null) {
        // ⚠️ LA RIGA PIÙ IMPORTANTE DI QUESTO BLOCCO, e la ragione è che la forma della
        // risposta NON È STATA MISURATA contro l'API vera: interrogarla per scoprirla
        // avrebbe consumato lo stesso budget che il cron sta usando adesso. È questa riga
        // che, alla prima notifica reale, porterà in `app_log` com'è fatta davvero — e
        // permetterà di sostituire le euristiche di `motivoDalleNotificheSdi` con una misura.
        //
        // `error` e non `warn`: una forma che non si riconosce è il segnale che l'estrattore
        // è cieco su una risposta vera, e resta da guardare anche adesso che il rientro dà
        // alla riga una seconda occasione. (Il commento diceva «il motivo non è rimandato, è
        // perso»: col rientro non è più vero al primo passaggio, ed è stato corretto il
        // 2026-09-11. Dopo il tentativo del rientro, però, quello sì che è definitivo.)
        //
        // 🔴 La forma sta nel `msg` e non nei campi per due ragioni, entrambe vere:
        // `app_log` deduplica per `(fingerprint, giorno)` e il `contesto` conserva quello
        // della PRIMA occorrenza, quindi nei campi una forma nuova resterebbe invisibile;
        // e un array di stringhe sotto una chiave non in lista bianca uscirebbe comunque
        // `[redatto]`. È lo stesso posto in cui `client.ts` scrive già le chiavi del primo
        // elemento quando non riconosce un'etichetta.
        //
        // ⚠️⚠️ E IL PREFISSO È CORTO APPOSTA — 35 caratteri, non 117 come fino al
        // 2026-09-11. `sanificaMessaggio` (`src/lib/logging/serialize.ts`) taglia OGNI
        // messaggio a 500 caratteri, e taglia la CODA: con la spiegazione per esteso qui
        // dentro («nessun motivo riconoscibile nelle notifiche SDI — forma della risposta
        // (nomi dei campi, mai i valori): »), della forma ne arrivavano ~382 e a morire
        // erano proprio i nomi dei campi d'ERRORE — che stanno in fondo — mentre
        // sopravviveva il blocco dell'intestatario, che non serve a nessuno. Una riga
        // diagnostica troncata dove serve non è una riga diagnostica.
        //
        // Il posto della spiegazione è questo commento, non il messaggio: il messaggio è il
        // budget della DIAGNOSI, e ogni carattere speso a raccontare è un carattere tolto
        // alla forma. Chi è tentato di riallungarlo legga prima
        // `__tests__/api/fattura-sync-notifiche.test.ts`, che asserisce sul messaggio DOPO
        // `sanificaMessaggio` proprio per rendere il taglio visibile.
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'notifiche-forma-ignota',
          scuola_id: riga.scuola_id,
          fattura_id: riga.id,
          numero: riga.numero,
          notifiche: lettura.notifiche,
          msg: `${JOB}: forma notifiche SDI: ${lettura.forma}`,
        })
        return { motivo: null, esito: 'nessun-motivo' }
      }

      // Il SUCCESSO si logga (AGENTS.md, regola 5): con i soli errori, «nessun log» non
      // distingue «il motivo è stato recuperato» da «non ci ha provato nessuno».
      logEvento('cron', 'info', {
        operazione: JOB,
        esito: 'motivo-da-notifiche',
        scuola_id: riga.scuola_id,
        fattura_id: riga.id,
        numero: riga.numero,
        // `tipo` ha la forma di un enumerato (`NS`, `RC`…): `redact` lo lascia in chiaro
        // solo per quello, e `motivoDalleNotificheSdi` annulla tutto ciò che non ce l'ha.
        tipo: lettura.tipo ?? undefined,
        notifiche: lettura.notifiche,
        // 🔴 LA LUNGHEZZA, NON IL TESTO. Il motivo è testo del provider su una fattura di
        // una famiglia: va in `sdi_scarto_motivo`, non in una riga che resta trenta giorni
        // in una tabella interrogabile. Il numero basta a dire che è arrivato qualcosa.
        caratteri: lettura.motivo.length,
        msg: `${JOB}: motivo dello scarto recuperato dalle notifiche SDI`,
      })
      return { motivo: lettura.motivo, esito: 'trovato' }
    }

    for (const f of righe) {
      // ── SI SMETTE PRIMA CHE SIA LA PIATTAFORMA A INTERROMPERE ────────────────
      // `maxDuration` tagliato a metà di una riga lascerebbe `fatture_emesse`
      // aggiornata e `pagamenti` no: la divergenza permanente contro cui questo
      // file mette una guardia esplicita duecento righe più sotto. Le righe non
      // toccate NON si perdono — restano in `STATI_IN_VOLO` e il tick successivo
      // le ripesca — ma il fatto di aver smesso va detto, altrimenti un giro
      // parziale si legge come un giro completo.
      if (Date.now() - t0 > TETTO_TEMPO_MS) {
        interrottoPerTempo = true
        break
      }
      // config + credenziali + token della scuola, in un posto solo (lo usa anche il rientro).
      const accesso = await tokenPerScuola(f.scuola_id)
      if (accesso.esito === 'errore') return accesso.response
      if (accesso.esito === 'salta') continue
      const { token, ambiente } = accesso

      // stato Aruba
      // Il tipo del client, non una copia locale: la copia era ferma a `{ stato, pdfBase64 }` e
      // avrebbe fatto sparire in silenzio la dicitura di Aruba appena aggiunta.
      let stato: ArubaInvoiceStatus
      // ── UNA OGNI CINQUE SECONDI, PERCHÉ IL SECCHIO È PER IP ─────────────────
      // SLA §3: 12 ricerche al minuto per IP, rifiuto istantaneo con `429`, nessun
      // accodamento. Qui non c'era nessuna pausa, e non si vedeva perché la coda era
      // vuota: con lo `0` ammesso in `STATI_IN_VOLO` il ciclo gira davvero, e al primo
      // tick dopo il rilascio ci sono 153 righe che rientrano.
      //
      // FRA una chiamata e l'altra, non PRIMA della prima: è la stessa forma di
      // `arubaUltimiNumeriFattura` (`client.ts`, `if (!primaRichiesta) await attendi(…)`).
      // La pausa serve a distanziare due richieste consecutive; davanti alla prima non c'è
      // niente da distanziare dentro questa invocazione, e il tick precedente è a trenta
      // minuti di distanza. Il `signin` appena fatto porta il burst a due richieste in
      // tutto — la misura del 2026-09-02 vedeva il `429` alla NONA. Cinque secondi
      // spesi lì non comprerebbero niente e li pagherebbe ogni giro, anche quello che
      // trova una riga sola.
      if (esaminate > 0) await attendi(PAUSA_FRA_PAGINE_MS)
      esaminate++
      // La riga ha pagato la sua richiesta in questo giro: il rientro non ci torna sopra.
      esaminateIds.add(f.id)
      try {
        stato = await arubaGetByFilename(ambiente, token, f.aruba_filename, { includePdf: true })
      } catch (e) {
        // Stesso argomento del signin: senza questa riga, una fattura che Aruba non sa più
        // rileggere resta in volo all'infinito senza che nessuno sappia perché.
        logEvento('cron', 'error', { operazione: JOB, esito: 'aruba-stato-fallito', scuola_id: f.scuola_id }, e)
        continue
      }
      if (stato.stato === f.sdi_stato) continue // nessun cambiamento

      const m = mapStatoAruba(stato.stato)
      // LA PAROLA DI ARUBA ARRIVA FINO AL REGISTRO. `m.label` è la NOSTRA traduzione; quando
      // diverge dalla dicitura del provider si scrivono tutte e due — «Recapito impossibile
      // (depositata) — Aruba: «Non consegnata»». Il corpo del provider non si butta via
      // (AGENTS.md, regola 3): una traduzione che cancella l'originale toglie l'unico modo di
      // accorgersi che è sbagliata — ed è appunto il difetto che si sta chiudendo.
      //
      // ⚠️ NON PER IL WORM, e la precisazione serve perché qui c'era scritto il contrario.
      // Una versione di questo commento sosteneva che `sdi_stato_label` e `sdi_scarto_motivo`
      // fossero immutabili «dove ciò che si scrive non si corregge più». È falso:
      // `supabase/migrations/20260711150000_worm_registri_fiscali.sql` elenca le colonne che il
      // trigger blocca (numero, anno, importo, scuola_id, pagamento_id, xml_inviato,
      // quota_adult_id, progressivo_invio, intestatario, bollo_virtuale, creato_il) e queste due
      // NON ci sono — l'intestazione della migrazione dice l'opposto esatto, che lo stato SDI
      // «resta modificabile, aggiornato dal polling/sync». È questa route a riscriverle a ogni
      // tick, e non potrebbe funzionare altrimenti. Il WORM vieta il DELETE della RIGA e il
      // cambio dei campi FISCALI: è una protezione vera, e attribuirle una copertura che non ha
      // è il modo in cui poi qualcuno si fida della protezione sbagliata.
      const etichetta = etichettaStatoAruba(m, stato.statoAruba)
      // IL MOTIVO DELLO SCARTO È UN CAMPO A PARTE, e non è una copia dell'etichetta.
      // Fino al 2026-09-11 qui andava `m.isScarto ? etichetta : null`, cioè «Scartata dallo SDI
      // — Aruba: «Scartata»»: la stessa frase già presente in `sdi_stato_label`, e zero
      // informazione su PERCHÉ. Per le quattro fatture che al 2026-09-11 risultano scartate su
      // Aruba quel campo è il dato con cui la Segreteria le corregge e le ritrasmette.
      // `emissione.ts:2166` scrive già `errorDescription` in questa stessa colonna sul percorso
      // di upload: qui il polling smette di essere incoerente col proprio file.
      const dettagliAruba = {
        descrizioneAruba: stato.descrizioneAruba,
        errorCode: stato.errorCode,
        errorDescription: stato.errorDescription,
      }
      let motivo = motivoScartoAruba(m, stato.statoAruba, dettagliAruba)
      // ── E SE IL MOTIVO È POVERO, IL PERCHÉ SI VA A CHIEDERE ALLE NOTIFICHE ────
      // `scartoSenzaDescrizione` guarda gli STESSI pezzi che `motivoScartoAruba` ha appena
      // guardato, non la frase che ha scritto: riconoscere il ramo difensivo cercando
      // «nessun motivo dal provider» dentro il nostro testo italiano funzionerebbe fino al
      // giorno in cui qualcuno riscrive quella frase, e da lì smetterebbe in silenzio.
      //
      // La condizione è doppia di proposito: `isScarto` tiene la chiamata in più lontana
      // dalle fatture regolari (che sono il 97%), la seconda metà la tiene lontana dagli
      // scarti che un motivo ce l'hanno già.
      if (m.isScarto && scartoSenzaDescrizione(dettagliAruba)) {
        // `?? motivo`: FAIL-OPEN. Quando le notifiche non danno niente si tiene quello che
        // c'era, che è povero ma vero. Non si scrive mai `null` su uno scarto — `null` in
        // quella colonna significa «non è uno scarto», e farebbe sembrare regolare una
        // fattura respinta.
        motivo = (await motivoDalleNotifiche(ambiente, token, f)).motivo ?? motivo
      }
      const nowIso = new Date().toISOString()

      // copia di cortesia PDF (best-effort) su stato valido. Chiave PER RIGA
      // (${pagamento}-${numero}.pdf): con più quote la 2ª non sovrascrive la 1ª.
      let pdfPath: string | null = null
      // ── TRE CAUSE DIVERSE, TRE RIGHE DIVERSE ───────────────────────────────────
      // Le prime due versioni del blocco qui sotto scrivevano `esito` e `msg` IDENTICI su
      // due rami diversi, ed era un difetto per conto suo: `messaggio` entra nell'impronta
      // di `app_log` e il `contesto` NO (vedi `logger.ts`), quindi le due cause collassavano
      // in una sola riga `(fingerprint, giorno)` — che conserva contesto ed errore della
      // PRIMA occorrenza. Un bucket che rifiuta la chiave e un base64 corrotto diventavano
      // indistinguibili, e la riga superstite attribuiva l'accaduto alla causa sbagliata.
      //
      // La funzione sta FUORI dal `try` perché la usa anche il `catch`: dichiarata dentro,
      // nel ramo d'eccezione non esisterebbe.
      //
      // `evento: 'cron'` e non `'storage'`: queste righe appartengono al giro del job, e chi
      // sorveglia il job interroga `where evento = 'cron'`. Spostarle altrove le toglierebbe
      // proprio dalla query in cui servono.
      //
      // ⚠️ `numero` e `fattura_id` stanno nei CAMPI e non nel `msg`, ed è deliberato: nel
      // messaggio renderebbero ogni fattura un'impronta a sé — cioè la fine della deduplica,
      // che esiste per non farsi sommergere. Nei campi si legge la PRIMA occorrenza del
      // giorno, col contatore `occorrenze` accanto. È lo stesso compromesso già preso dal log
      // `scarto-senza-destinatari` più sotto. Sono un intero e un uuid: `redact` li lascia in
      // chiaro anche nella riga persistita, ed è ciò che rende la riga azionabile — senza,
      // dice solo «in questa sede una fattura è senza PDF».
      const pdfNonCaricato = (esitoLog: string, testo: string, errore?: unknown) => {
        pdfPath = null
        logEvento(
          'cron',
          'error',
          {
            operazione: JOB,
            esito: esitoLog,
            scuola_id: f.scuola_id,
            fattura_id: f.id,
            numero: f.numero,
            bucket: 'fatture',
            msg: `${JOB}: ${testo}`,
          },
          errore,
        )
      }
      if (!m.isScarto && stato.pdfBase64) {
        pdfPath = `${f.pagamento_id}-${f.numero}.pdf` // chiave relativa al bucket "fatture"
        try {
          const storage = (
            supabase as {
              storage?: {
                from: (b: string) => {
                  upload: (
                    p: string,
                    d: Buffer,
                    o?: unknown,
                  ) => Promise<{ error?: unknown } | null | undefined>
                }
              }
            }
          ).storage
          const esitoUpload = await storage?.from('fatture').upload(
            pdfPath,
            Buffer.from(stato.pdfBase64, 'base64'),
            { contentType: 'application/pdf', upsert: true },
          )
          // ⚠️ `supabase-storage-js` NON LANCIA: `upload` ritorna `{ data, error }`, esattamente
          // come PostgREST (AGENTS.md, regola 7). Il valore di ritorno era SCARTATO, quindi il
          // `catch` qui sotto — che azzera `pdfPath` e scrive `pdf-copia-fallita` — non scattava
          // MAI per un errore dello Storage: bucket pieno, chiave rifiutata, permesso negato
          // uscivano tutti da questo blocco come un successo, `pdf_path` finiva a registro, e
          // `/api/pagamenti/fattura` andava poi a cercare un file che non c'era. Nessun log.
          // È lo STESSO difetto che `fattura/route.ts` dichiara già corretto sul `download`
          // (vedi il commento di `scaricaPdf`): era rimasto in piedi sull'`upload`.
          //
          // Un esito ASSENTE conta come fallimento: se `storage` non c'è, `storage?.` corto-
          // circuita e l'upload non è mai partito — scrivere `pdf_path` sarebbe una bugia.
          //
          // Livello `error` e non più `warn`, per la stessa ragione di `scaricaPdf`: non è un
          // risultato degradato, è un risultato ASSENTE. Il genitore apre la fattura e non
          // ottiene niente, e lo stato SDI (che intanto viene salvato lo stesso, ed è giusto
          // così) non basta a fargliela avere.
          if (!esitoUpload) {
            // Il client dello Storage non c'è: `storage?.` ha corto-circuitato e l'upload
            // non è MAI PARTITO. Non è un rifiuto del bucket, è una forma inattesa del
            // client Supabase — diagnosi opposta, e mandarci dietro chi legge a
            // controllare i permessi del bucket è tempo buttato.
            pdfNonCaricato(
              'pdf-storage-assente',
              'client Storage non disponibile, upload del PDF mai partito',
            )
          } else if (esitoUpload.error) {
            // Lo Storage ha risposto e ha detto di no: bucket pieno, chiave rifiutata,
            // permesso negato. Il corpo dell'errore del provider viaggia come `cause`
            // (AGENTS.md, regola 3): senza, resterebbe «non caricato» e basta.
            pdfNonCaricato(
              'pdf-copia-rifiutata',
              'lo Storage ha rifiutato il PDF, la fattura resta senza copia',
              esitoUpload.error,
            )
          }
        } catch (e) {
          // Resta a coprire ciò che può lanciare davvero: `Buffer.from` su un base64 corrotto,
          // o un guasto di trasporto sotto il client dello Storage. `esito` e `msg` diversi da
          // quelli dei due rami qui sopra: è un'altra causa, e deve restare un'altra riga.
          pdfNonCaricato(
            'pdf-copia-eccezione',
            'eccezione durante la copia del PDF, la fattura resta senza copia',
            e,
          )
        }
      }

      const { error: errUpdFattura } = await supabase
        .from('fatture_emesse')
        .update({
          sdi_stato: stato.stato,
          sdi_stato_label: etichetta,
          sdi_scarto_motivo: motivo,
          ...(pdfPath ? { pdf_path: pdfPath } : {}),
          aggiornata_il: nowIso,
        })
        .eq('id', f.id)
      // Se questa UPDATE salta in silenzio, la fattura resta «in volo» e il giro dopo la
      // ripesca: si ripete all'infinito senza che nessuno sappia perché.
      if (errUpdFattura) return queryFallita('aggiornamento fatture_emesse', errUpdFattura, t0, f.scuola_id)

      // Stato aggregato del pagamento dalle sue quote. Rileggo tutte le righe e
      // sostituisco in memoria quella appena aggiornata (la SELECT potrebbe non
      // riflettere ancora l'update appena fatto).
      const { data: tutte, error: errTutte } = await supabase
        .from('fatture_emesse')
        .select('id, numero, sdi_stato, quota_adult_id, pdf_path')
        .eq('pagamento_id', f.pagamento_id)
      // LA LETTURA PIÙ VELENOSA DEL FILE, perché il suo fallimento non si limita a tacere: SCRIVE
      // IL FALSO. Con `tutte` a `null`, `righeAgg` è `[]` → `aggregaFatturaStato([])` vale
      // `in_attesa` → il pagamento verrebbe riscritto «in attesa» anche per una fattura appena
      // CONSEGNATA o SCARTATA, con una conseguenza fiscale. Un aggregato calcolato su una lettura
      // fallita non è un aggregato: è un'invenzione. Si esce prima di scrivere.
      if (errTutte) return queryFallita('rilettura quote fattura', errTutte, t0, f.scuola_id)
      const righeAgg = ((tutte ?? []) as (RigaFatturaAgg & { id: string; pdf_path: string | null })[]).map((r) =>
        r.id === f.id ? { ...r, sdi_stato: stato.stato, pdf_path: pdfPath ?? r.pdf_path } : r
      )
      const statoAgg = aggregaFatturaStato(righeAgg)
      // fattura_pdf_path resta sul pagamento SOLO per fattura singola (compat legacy);
      // con più quote il download è per-fattura (vedi /api/pagamenti/fattura?fattura_id=).
      const pdfSingola = righeAgg.length <= 1 ? righeAgg[0]?.pdf_path ?? null : null

      const { error: errUpdPagamento } = await supabase
        .from('pagamenti')
        .update({ fattura_stato: statoAgg, ...(pdfSingola ? { fattura_pdf_path: pdfSingola } : {}) })
        .eq('id', f.pagamento_id)
      // La fattura è già stata marcata terminale qui sopra: se questa UPDATE salta e tace, il
      // pagamento resta «in attesa» per sempre — e il giro successivo NON lo ripesca (la fattura
      // non è più in volo). Divergenza permanente fra le due tabelle, e nessuno lo saprebbe.
      if (errUpdPagamento) return queryFallita('aggiornamento pagamenti', errUpdPagamento, t0, f.scuola_id)
      processate++

      if (m.isScarto) {
        scartate++
        // L'APPARTENENZA A UNA SEDE NON È `utenti.scuola_id`: è l'unione fra quella colonna e
        // il ponte `utenti_scuole`. Qui c'era la query nuda, e per una fattura delle sedi
        // aperte il 2026-07-29 tornava zero righe: `enqueueNotifiche` esce muto sulla lista
        // vuota (enqueue.ts:42) e il battito chiudeva «ok, scartate: 1». `staffScuola` guarda
        // il ponte, controlla `{ error }` da sé (PostgREST non lancia) e logga i suoi degradi.
        const utenteIds = await staffScuola(supabase, f.scuola_id, ['admin', 'coordinator', 'segreteria'])
        if (utenteIds.length === 0) {
          // `error`, e qui più che altrove: lo stato terminale della fattura è GIÀ stato
          // scritto qui sopra, quindi la riga esce da `STATI_IN_VOLO` e il giro successivo
          // non la ripesca. Non è un avviso rimandato: è un avviso perso per sempre, su un
          // dato con conseguenza fiscale. `scuola_id` è un uuid: resta in chiaro anche in tabella.
          logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'scarto-senza-destinatari',
            scuola_id: f.scuola_id,
            numero: f.numero,
            msg: `${JOB}: fattura scartata e nessuno da avvisare`,
          })
          continue
        }
        await enqueueNotifiche(supabase, {
          utenteIds,
          tipo: 'fattura_scartata',
          titolo: 'Fattura scartata dallo SDI',
          // `m.label` e non `etichetta`: nella notifica la dicitura di Aruba («Scartata»)
          // ripeterebbe la nostra («Scartata dallo SDI») senza aggiungere niente, e una push
          // si legge in due secondi. La parola esatta del provider resta a registro
          // (`sdi_stato_label`, `sdi_scarto_motivo`), che è dove si va a guardare per
          // ritrasmettere — ed è il posto che questo link apre.
          corpo: `Fattura n. ${f.numero}: ${m.label}. Verifica i dati e reinvia.`,
          link: '/admin/pagamenti',
          entitaTipo: 'fattura',
          entitaId: f.id,
          scuolaId: f.scuola_id,
        })
      }
    }

    /* ══════════════════════════════════════════════════════════════════════════
     * IL RIENTRO — gli scarti già terminali a cui manca il perché.
     *
     * Non è il ciclo qui sopra con un filtro diverso: è un mestiere diverso. Là si chiede lo
     * STATO di una fattura che può ancora cambiare; qui lo stato è terminale e non cambierà
     * più — si chiede solo la NOTIFICA, e si riscrive una frase.
     *
     * Le cinque regole, tutte necessarie:
     *  1. TETTO PICCOLO (`TETTO_RIENTRO_PER_GIRO`): è un arretrato che si smaltisce.
     *  2. LA PAUSA e IL TETTO DI TEMPO sono quelli del giro — la pausa la paga
     *     `motivoDalleNotifiche`, che controlla il tempo PRIMA di spenderla.
     *  3. IL TOKEN DEL GIRO, mai un `signin` nuovo: `tokenPerScuola` è la stessa funzione
     *     del ciclo e la stessa cache.
     *  4. FAIL-OPEN, e qui vuol dire una cosa precisa: si tocca SOLO `sdi_scarto_motivo`.
     *     Niente `sdi_stato`, niente `sdi_stato_label`, niente `pagamenti`, nessuna push —
     *     la Segreteria è già stata avvisata quando la fattura è stata scartata. Se il
     *     rientro sbaglia, ha sbagliato una frase; non può spostare un esito fiscale.
     *  5. DEVE TERMINARE. Vedi `MARCATORE_RIENTRO`: dopo UN tentativo la riga esce, e ci
     *     esce lasciando scritto che ci si è provati.
     * ═══════════════════════════════════════════════════════════════════════════ */
    if (!interrottoPerTempo) {
      const { data: arretrate, error: errArretrate } = await supabase
        .from('fatture_emesse')
        .select('id, scuola_id, numero, aruba_filename, sdi_scarto_motivo')
        // Gli stati di scarto — 2, 4 e 9 — e NON `STATI_IN_VOLO`: sono due code diverse
        // con due tetti diversi, ed è tutto il punto di questo blocco.
        .in('sdi_stato', statiDiScarto())
        .not('aruba_filename', 'is', null)
        // ⚠️ IL FILTRO CHE FA TERMINARE IL CICLO, e va lasciato in SQL: in memoria
        // basterebbe che un giorno le righe già tentate superassero `TETTO_LETTURA_RIENTRO`
        // perché saturino la finestra e nascondano quelle nuove per sempre.
        //
        // Nota su NULL: in SQL `NOT (NULL ILIKE '…')` vale NULL, cioè la riga NON passa —
        // quindi uno scarto con `sdi_scarto_motivo` a `null` qui non entra. È voluto: su uno
        // scarto `motivoScartoAruba` non ritorna MAI `null` (lì `null` significa «non è uno
        // scarto»), quindi una riga così è un difetto d'altro tipo, e non è questo blocco a
        // doverlo indovinare.
        .not('sdi_scarto_motivo', 'ilike', `%${MARCATORE_RIENTRO}%`)
        .limit(TETTO_LETTURA_RIENTRO)
      // PostgREST non lancia (AGENTS.md, regola 7): senza questo controllo «la query è
      // fallita» e «non c'è nessuno scarto da riparare» sono lo stesso ramo, e il secondo
      // chiude con un «ok».
      if (errArretrate) return queryFallita('lettura scarti senza motivo', errArretrate, t0)

      const daRiparare = ((arretrate ?? []) as {
        id: string
        scuola_id: string
        numero: number
        aruba_filename: string
        sdi_scarto_motivo: string | null
      }[])
        .filter((r) => {
          // Il marcatore l'ha già escluso il filtro SQL; qui si riconosce il motivo POVERO,
          // che in SQL non si può cercare senza inchiodare la query al nostro testo italiano
          // (vedi `FRAMMENTO_MOTIVO_POVERO`). Il `!includes(MARCATORE)` resta come cintura:
          // il filtro SQL è le bretelle, e le due si controllano a vicenda.
          const m = r.sdi_scarto_motivo
          if (typeof m !== 'string') return false
          return m.includes(FRAMMENTO_MOTIVO_POVERO) && !m.includes(MARCATORE_RIENTRO)
        })
        .filter((r) => !esaminateIds.has(r.id))

      // ⚠️ IL TETTO SI PAGA IN RICHIESTE SPESE, NON IN RIGHE LETTE — e la differenza non è
      // teorica.
      //
      // Fino al 2026-09-11 qui c'era uno `.slice(0, TETTO_RIENTRO_PER_GIRO)`, cioè il taglio
      // PRIMA del gate della sede. Ma il ramo `salta` qui sotto (Aruba disattivato per quella
      // sede, o credenziali non risolvibili) non spende nessuna richiesta ad Aruba: se le
      // prime due righe della finestra appartengono a una sede in quello stato, il rientro
      // consuma entrambi i posti senza fare NIENTE — e li riconsuma identici al tick dopo,
      // perché la query non ha `ORDER BY` e l'ordine fisico non cambia. Le righe riparabili
      // delle altre sedi non verrebbero raggiunte MAI, e il battito finale certificherebbe
      // `rientri: 0` come se non ci fosse niente da fare.
      //
      // È l'unico modo in cui questo blocco può morire in silenzio dichiarandosi sano. Perciò
      // il contatore si incrementa DOPO la chiamata, e a fermare il ciclo è lui.
      let spesi = 0

      for (const r of daRiparare) {
        if (spesi >= TETTO_RIENTRO_PER_GIRO) break

        const accesso = await tokenPerScuola(r.scuola_id)
        if (accesso.esito === 'errore') return accesso.response
        if (accesso.esito === 'salta') continue

        const esito = await motivoDalleNotifiche(accesso.ambiente, accesso.token, r)
        if (esito.esito === 'tetto-tempo') {
          // Nessuna richiesta spesa, nessun marcatore scritto: la riga resta com'è e il
          // giro successivo la riprende. È l'unico dei quattro esiti che NON consuma il
          // tentativo, e deve restare tale — un tetto di tempo è una condizione passeggera,
          // marcarci sopra toglierebbe alla riga la sua unica occasione.
          interrottoPerTempo = true
          break
        }

        // Da qui in giù la richiesta ad Aruba è PARTITA — riuscita o fallita che sia, lo slot
        // sul secchio da 12/minuto è consumato. È questo che il tetto conta, non le righe lette.
        spesi += 1

        // 🔴 IL MARCATORE SI SCRIVE ANCHE QUANDO LA CHIAMATA È FALLITA, ed è la decisione
        // più discutibile di questo blocco, quindi è scritta per esteso.
        //
        // Un `429` è transitorio e un `404` no, ma da qui non si distinguono: entrambi
        // arrivano come un'eccezione, e l'unico modo di trattarli diversamente sarebbe
        // ritentare — cioè costruire proprio il ciclo senza fine che questo marcatore esiste
        // per impedire. Fra «perdere l'occasione su un 429» e «consumare due richieste ogni
        // mezz'ora per sempre su una riga che non risponderà mai», il secondo è il danno più
        // grande e quello che cresce da solo. Il testo però NON mente: dice «lettura non
        // riuscita», che è un'altra cosa da «nessun motivo», e chi legge la colonna sa che
        // quella riga merita un secondo tentativo a mano.
        //
        // Rimetterla in coda costa un `UPDATE` che toglie il marcatore, ed è una riga di SQL.
        const oggi = new Date().toISOString().slice(0, 10)
        const motivoNuovo =
          esito.motivo ??
          `${r.sdi_scarto_motivo} · ${MARCATORE_RIENTRO} il ${oggi}: ` +
            (esito.esito === 'fallita' ? 'lettura non riuscita' : 'nessun motivo')

        const { error: errMotivo } = await supabase
          .from('fatture_emesse')
          // SOLO questa colonna. `aggiornata_il` non si tocca di proposito: è il timestamp
          // del polling di STATO, e muoverlo per una frase falserebbe la lettura di quando
          // quella fattura è stata davvero riesaminata.
          .update({ sdi_scarto_motivo: motivoNuovo })
          .eq('id', r.id)
        // Se questa UPDATE salta in silenzio, il marcatore non viene scritto e la riga torna
        // al giro dopo: una richiesta Aruba bruciata a ogni tick, per sempre, senza che
        // nessuno sappia perché. È lo stesso argomento dell'UPDATE del ciclo qui sopra.
        if (errMotivo) return queryFallita('aggiornamento motivo scarto', errMotivo, t0, r.scuola_id)

        rientri++
        // Il successo si logga (AGENTS.md, regola 5): senza, «nessun log» non distingue «il
        // rientro ha riparato la riga» da «il rientro non è mai partito» — che è la stessa
        // ambiguità per cui il difetto è rimasto invisibile fino al 2026-09-11.
        // 🔴 Il TESTO no: quello è testo del provider su una fattura di una famiglia, e va
        // nella colonna. Qui basta sapere che è arrivato qualcosa, e quanto.
        logEvento('cron', 'info', {
          operazione: JOB,
          esito: 'rientro-scarto',
          scuola_id: r.scuola_id,
          fattura_id: r.id,
          numero: r.numero,
          recuperato: esito.esito === 'trovato',
          caratteri: motivoNuovo.length,
          msg:
            esito.esito === 'trovato'
              ? `${JOB}: motivo ritrovato su uno scarto già a registro`
              : `${JOB}: scarto senza motivo neanche dalle notifiche, non sarà richiesto di nuovo`,
        })
      }
    }

    // I contatori sono NUMERI: passano in chiaro anche in tabella. `scartate` soprattutto —
    // è l'unico numero di questo giro che ha una conseguenza fiscale.
    //
    // ⚠️ `esaminate` conta le fatture per cui si è DAVVERO chiamato Aruba, non le righe lette
    // dalla query: le due divergono appena una scuola viene saltata per credenziali o appena
    // il tetto di tempo interrompe il ciclo. Contare le righe lette farebbe sembrare
    // interrogate anche quelle che nessuno ha toccato.
    //
    // Un giro interrotto per tempo NON è un giro completo, e ha un `esito` suo: le righe
    // rimaste sono ancora in coda e il tick dopo le riprende, ma chi legge `esito: 'ok'` con
    // `processate: 3` su una coda da 153 deve poter distinguere «non c'era altro da fare» da
    // «non ho fatto in tempo». Il `msg` è diverso perché entra nell'impronta di `app_log`:
    // con lo stesso messaggio i due esiti finirebbero nella stessa riga del giorno.
    logEvento('cron', 'info', {
      operazione: JOB,
      esito: interrottoPerTempo ? 'ok-parziale' : 'ok',
      ms: Date.now() - t0,
      lette: righe.length,
      esaminate,
      processate,
      scartate,
      // ⚠️ Le richieste ad Aruba di questo giro non sono più `esaminate`: ogni scarto senza
      // motivo ne aggiunge una. Contarle qui è ciò che rende MISURABILE il costo della
      // chiamata in più su un secchio da 12/min per IP, invece che deducibile — se un
      // giorno questo numero si avvicinasse a `esaminate`, la condizione che la accende si
      // è rotta e il cron sta raddoppiando il proprio consumo.
      letture_notifiche: lettureNotifiche,
      // ⚠️ IL COSTO DEL RIENTRO, misurabile e non deducibile. È il numero da guardare se un
      // giorno si sospetta che il cron stia sfondando il secchio di Aruba: deve restare
      // basso e, soprattutto, deve ANDARE A ZERO quando l'arretrato è finito. Se non ci va,
      // il marcatore non sta funzionando e il giro sta ripescando le stesse righe per sempre.
      rientri,
      skipped: scuoleSkipped.size,
      msg: interrottoPerTempo
        ? `${JOB}: tetto di tempo raggiunto, le fatture restanti tornano al giro successivo`
        : `${JOB}: ok`,
    })
    return NextResponse.json({
      success: true,
      data: {
        processate,
        scartate,
        skipped: scuoleSkipped.size,
        esaminate,
        rientri,
        ...(interrottoPerTempo ? { interrotto: 'tetto_tempo' } : {}),
        ...(scuoleSkipped.size > 0 ? { motivo: 'credenziali_non_configurate' } : {}),
      },
    })
  } catch (err) {
    // `evento: 'cron'`: il fallimento totale del job resta nello stesso flusso dei battiti
    // (`where evento = 'cron'`). `logErrore` emette anche l'Error nativo con lo stack VERO.
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
