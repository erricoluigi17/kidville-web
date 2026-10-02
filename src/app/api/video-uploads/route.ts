import { createHash } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { requireDocente } from '@/lib/auth/require-staff'
import { cancelliDestinatariGalleria, type DestinatariGalleria } from '@/lib/gallery/cancelli-destinatari'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import {
  BUCKET_ORIGINALI_VIDEO,
  codiceMessaggioVideo,
  MAX_VOCI_ELENCO_VIDEO,
  schemaAperturaIntentVideo,
  schemaQueryElencoVideo,
  type CanaleVideo,
  type FileVideoDichiarato,
  type RispostaAperturaVideo,
  type RinnovoVideo,
  type VoceVideo,
} from '@/lib/media/video/contratto'
import {
  generaTokenRinnovo,
  hashTokenRinnovoPerPostgres,
  scadenzaTokenRinnovo,
} from '@/lib/media/video/token-rinnovo'
import { resolveScuolaScrittura, scuoleDiUtente } from '@/lib/auth/scope'
import { rateLimit } from '@/lib/security/rate-limit'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseBody, parseQuery } from '@/lib/validation/http'

import { ambitoGlobaleNegato } from './cancello'
import {
  COLONNE_INTENTO_ELENCO,
  COLONNE_JOB_ELENCO,
  FASI_ATTIVE,
  GIORNI_ELENCO_CONCLUSI,
  STATI_INTENTO_NON_TERMINALI,
  costruisciVoce,
  type IntentoElenco,
  type JobElenco,
} from './elenco'
import { coordinateTus, estensioneVideoDaMime, firmaPut, firmaTus, scadenzaFirma } from './firme'
import {
  logVideo,
  pipelineAssente,
  rispostaEsitoRpc,
  rispostaPipelineAssente,
  rispostaTroppeRichieste,
  rispostaVideo,
  statoHttpVideo,
} from './risposte'

// =============================================================================
// POST /api/video-uploads — APRE un caricamento video. Non ne riceve un byte.
// GET  /api/video-uploads — l'ELENCO dei video dell'insegnante, da qualunque
//                           dispositivo li abbia caricati.
//
// ─── PERCHÉ IL FILE NON PASSA DI QUI ─────────────────────────────────────────
// Il corpo di una Function su Vercel si ferma intorno ai 4,5 MB, e il 413 lo
// scrive l'infrastruttura PRIMA che la funzione parta: nei log del server non
// resta niente. Misurato in produzione il 2026-09-07 su `gallery/upload`, sei
// volte in un giorno, per un video da 4.484.198 byte. Qui gli originali arrivano
// a 2.000.000.000 byte: farli passare di qui non è «lento», è impossibile.
//
// Perciò questa route fa tre cose e nessun'altra: attraversa i cancelli, registra
// l'intento e i job nel database, e conia le coordinate con cui il telefono
// spedirà i byte allo Storage — in TUS, da solo, e potendo riprendere da dove si è
// interrotto quando la rete mobile cade; oppure, dall'app 1.2, con una PUT sola su
// un URL firmato.
//
// ─── DAL 2026-10-02: I BAMBINI SI SCELGONO PRIMA, E IL SERVER PUBBLICA DA SOLO ─
// Fino alla PR 2 i bambini di un video vivevano nella memoria della pagina: il
// server non li conosceva, e la pubblicazione la faceva il browser quando il job
// era `ready`. Con la pagina chiusa il video restava convertito e mai pubblicato
// (11 casi misurati il 01/10). Adesso l'apertura di un video di GALLERIA porta i
// destinatari (`destinatari:{tagAlunni, broadcast, classi}`), attraversa gli STESSI
// quattro cancelli di `POST /api/gallery` (`cancelliDestinatariGalleria`: stesse
// risposte, parola per parola) e nasce confermata, con i bambini scritti
// sull'intento (`video_galleria_intent_apri`): quando la conversione finisce, è il
// server a pubblicare. Un'apertura di Galleria SENZA destinatari è un client col JS
// vecchio, e riceve 409 `VIDEO_APP_DA_AGGIORNARE`: scrivere un video che nessuno
// potrebbe più pubblicare non è un favore. Le News restano come prima.
//
// ─── PERCHÉ LA ROTTA TUS *FIRMATA* E NON QUELLA COL TOKEN DI SESSIONE ────────
// `storage.objects` ha RLS accesa e ZERO policy: un upload presentato con il JWT
// di sessione dell'utente prende 403 al primo byte. E quella policy le nostre
// migrazioni non potrebbero nemmeno scriverla — la tabella è di
// `supabase_storage_admin`, le migrazioni girano come `postgres`, che non ne è
// membro. La misura e le quattro risposte che la dimostrano stanno nella testata
// di `supabase/migrations/20260916190200_video_intent_lifecycle.sql`.
// La conseguenza di progetto è questa: **il browser non presenta MAI un token di
// sessione allo Storage**. La route conia la firma con la chiave di servizio, e
// il client la spedisce nell'intestazione `x-signature` su
// `/storage/v1/upload/resumable/sign`, che è registrata fuori da RLS. Le firme si
// coniano in `./firme`, uguali per questa route, per `[id]/firma` e per `rinnovo`.
//
// ─── `vercel.json`: PERCHÉ `dub1`, E PERCHÉ IL PERCHÉ STA QUI ────────────────
// `vercel.json` dichiara `"src/app/api/video-uploads/**": { "regions": ["dub1"] }`.
// Dublino perché è dove stanno le altre due metà di questa pipeline: il progetto
// Supabase è su `eu-west-1` e il Vercel Sandbox che converte gira su `dub1`.
// Tenere queste route altrove significherebbe far attraversare l'Atlantico a
// ogni chiamata RPC e a ogni firma, due volte per ciascuno dei dieci allegati di
// una News.
//
// ⚠️ E LA RAGIONE PER CUI QUESTA NOTA È IN UN FILE `.ts` E NON IN `vercel.json`:
// quel file resta JSON STRETTO, senza un solo commento. Un `vercel.json` che il
// parser rifiuta blocca OGNI deploy del progetto, compreso un hotfix su tutt'altro
// — ed è la stessa famiglia di guasto per cui quel file era stato tolto
// dall'albero il 2026-09-17: dichiarava questa cartella quando non esisteva, e un
// pattern `functions` senza nessun file che lo soddisfi fa fallire la build.
// Adesso la cartella esiste (questa, più `[id]`, `[id]/firma` e `rinnovo`), e il
// pattern ha file veri. ⚠️ Nessuna di queste due cose è verificabile in locale:
// `next build` non legge `vercel.json`. Si misura su un preview deploy, e non prima.
// =============================================================================

/**
 * IL TEMPO MASSIMO DELLA FUNZIONE, DICHIARATO E NON EREDITATO.
 *
 * Una News porta fino a dieci allegati, e ciascuno costa una chiamata RPC più una
 * firma: una ventina di andate e ritorni verso Supabase, non una conversione.
 * Il numero non è una misura — non c'è ancora niente da misurare, le migrazioni
 * sono in coda — ed è scritto per la stessa ragione per cui l'import massivo lo
 * dichiara: un giro che apre un impegno verso una famiglia non può dipendere da
 * un default della piattaforma che nessuno ha scelto e che cambia col piano.
 * Se un giorno una di queste venti chiamate diventerà lenta, si vedrà qui.
 */
export const maxDuration = 60

/**
 * IL PERCORSO DELL'ORIGINALE, E PERCHÉ È DETERMINISTICO.
 *
 * Con un uuid a caso, un telefono che perde la rete e rispedisce la stessa
 * richiesta otterrebbe un percorso NUOVO — e `video_intent_open`, che ritrova il
 * job dalla chiave di idempotenza, risponderebbe `IDEMPOTENCY_CONFLICT` perché
 * «stessa chiave, altro originale». Cioè il ritentativo, che è la ragione per cui
 * la chiave esiste, fallirebbe sempre.
 *
 * Il prefisso è l'uuid di CHI CARICA: lo pretende `video_intent_open`
 * (`ORIGINAL_PATH_SCOPE`), e serve a rendere la pulizia per caricatore un `list`
 * per prefisso invece di una scansione del bucket. ⚠️ Non è l'indice dell'oblio
 * GDPR — quello cancella per bambino o per genitore, e qui il prefisso è di un
 * insegnante: la testata della migrazione degli intenti lo dice per esteso.
 *
 * Il resto è l'impronta della chiave del client, non la chiave: una chiave
 * scelta dal telefono può contenere qualunque cosa, compreso il nome del file.
 */
function percorsoOriginale(ownerId: string, canale: CanaleVideo, f: FileVideoDichiarato): string {
  const impronta = createHash('sha256').update(`${canale}:${f.chiaveIdempotenza}`).digest('hex').slice(0, 32)
  return `${ownerId}/${impronta}.${estensioneVideoDaMime(f.mime)}`
}

/**
 * Un job come esce dalla RPC: interessano l'id e il percorso, e il percorso serve
 * a verificare che la RPC abbia davvero preso quello che le si era passato.
 *
 * ⚠️ Le RPC restituiscono la riga del job e dell'intento. `video_galleria_intent_apri` le
 * ripulisce già (niente `tag_alunni`, niente hash del token, niente `sha256`), ma le altre
 * (`video_intent_open`, `video_intent_add_job`) no: ciò che arriva qui NON si inoltra al client
 * né si logga — si leggono i campi che servono, uno per uno.
 */
type JobRpc = { id?: unknown; original_path?: unknown; status?: unknown }
type EsitoRpc = {
  ok?: unknown
  code?: unknown
  intent?: { id?: unknown; revision?: unknown; status?: unknown } | null
  job?: JobRpc | null
  /** Solo `video_galleria_intent_apri`: la richiesta era una ripetizione di una già fatta. */
  ripetuta?: unknown
  /** Solo `video_galleria_intent_apri`: il token è stato RUOTATO, cioè quello passato ora è l'unico valido. */
  token_ruotato?: unknown
}

/**
 * La risposta: il contratto, più la FIRMA.
 *
 * Il tipo è la risposta ESTESA (`schemaRispostaAperturaVideo`): `caricamento` può essere TUS o PUT
 * e, per il PUT, il job porta il `rinnovo`. Una risposta TUS passa anche con lo schema di prima
 * (`schemaEsitoAperturaIntentVideo`): è un sovrainsieme, e i client che non conoscono il PUT
 * continuano a leggerla.
 */
type JobAperto = RispostaAperturaVideo['job'][number]

/**
 * Il fatto che un intento sia «concluso»: per un job che aspetta ancora i byte di un intento già
 * pubblicato, ritirato o sostituito non si emette nessuna firma — non c'è più niente da scrivere.
 */
const INTENTI_CONCLUSI = ['published', 'cancelled', 'superseded']

export const POST = withRoute('video-uploads:POST', async (request: NextRequest) => {
  const OPERAZIONE = 'video-uploads:POST'
  try {
    // ── CANCELLO 1 · CHI SEI. Prima del corpo, sempre: `parseBody` bufferizza e
    //    deposita nel contesto di log ciò che è arrivato, e farlo per un anonimo
    //    vuol dire lavorare per chi non ha ancora detto chi è.
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const rl = await rateLimit(`video-uploads:${auth.user.id}`, { limit: 30, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) return rispostaTroppeRichieste(rl.retryAfterMs)

    const b = await parseBody(request, schemaAperturaIntentVideo)
    if ('response' in b) return b.response
    const richiesta = b.data
    const canale = richiesta.canale

    // ── UN CLIENT COL JS VECCHIO. Una Galleria che apre un intento senza destinatari non
    //    sa dei bambini «prima»: una pagina rimasta aperta da prima del rilascio, o un client
    //    che non è stato ricaricato. Scriverle un video darebbe un intento che nessun server
    //    potrebbe più pubblicare — quindi 409, e un messaggio che dice di ricaricare. Dopo il
    //    gate di ruolo e lo schema, ma PRIMA di ogni lettura: la risposta non dipende da ciò
    //    che la sede o i cancelli direbbero, perché il client non può farci niente.
    //
    //    ⚠️ `warn` e non muto: il giorno del rilascio bisogna poter dire QUANTI client parlano
    //    ancora la lingua vecchia, altrimenti «non si è lamentato nessuno» vuol dire insieme
    //    «hanno aggiornato tutti» e «non lo sappiamo». Solo l'uuid di chi chiama, con `distingui`
    //    (`app_log` conserva il contesto della PRIMA occorrenza del giorno, e qui ogni utente è
    //    una storia a sé). Mai un nome di file.
    if (canale === 'gallery' && richiesta.destinatari === undefined) {
      logEvento(
        'galleria',
        'warn',
        {
          operazione: OPERAZIONE,
          esito: 'apertura-flusso-vecchio-rifiutata',
          error_code: 'CLIENT_UPDATE_REQUIRED',
          utente: auth.user.id,
        },
        undefined,
        { distingui: ['utente'] },
      )
      return rispostaVideo(codiceMessaggioVideo('CLIENT_UPDATE_REQUIRED'), statoHttpVideo('CLIENT_UPDATE_REQUIRED'))
    }

    // Un video di Galleria ha SEMPRE dei destinatari: almeno un bambino, oppure il broadcast
    // (che i cancelli ammettono solo alla Direzione). Una foto senza tag va a tutta la sede,
    // da sempre; un video no — e `{}` è un `destinatari` valido per lo schema, proprio perché è
    // questa route a dire `DESTINATARI_MANCANTI` con la sua frase. Non c'è ancora un cancello
    // da attraversare (senza bambini e senza broadcast nessuno rifiuterebbe niente): si risponde
    // qui, prima di leggere la sede.
    if (richiesta.destinatari !== undefined && richiesta.destinatari.tagAlunni.length === 0 && !richiesta.destinatari.broadcast) {
      logVideo(canale, 'warn', {
        operazione: OPERAZIONE,
        esito: 'destinatari-mancanti',
        error_code: 'DESTINATARI_MANCANTI',
        utente: auth.user.id,
      })
      return rispostaVideo(
        codiceMessaggioVideo('DESTINATARI_MANCANTI'),
        statoHttpVideo('DESTINATARI_MANCANTI'),
      )
    }

    const supabase = await createAdminClient()

    // ── CANCELLO 2 · DOVE STAI SCRIVENDO ─────────────────────────────────────
    // `resolveScuolaScrittura` risponde **403** a una sede dichiarata che non è
    // propria e **400** quando i plessi sono più d'uno e nessuno è indicato. È il
    // motivo per cui esiste: una route che «indovina» la sede archivia i dati nel
    // plesso sbagliato **in silenzio** — misurato il 2026-07-31 su un admin che
    // aveva scelto Aversa e si vedeva scrivere su Giugliano.
    //
    // ⚠️ STA QUI E NON DENTRO UN HELPER, ed è una scelta con una misura dietro:
    // `isolamento-sede-coverage.test.ts` cerca questo nome NEL CORPO dell'handler,
    // perché le RPC qui sotto sono `SECURITY DEFINER` e nessun filtro le
    // raggiunge. Spostandola in `./cancello` il lock l'ha segnalata come
    // `rpc-senza-sede` — giustamente: non poteva sapere che il presidio c'era.
    //
    // L'unica sede assente ammessa è l'ambito globale di una News, e quella
    // decisione sta in `./cancello` perché deve valere identica alla conferma.
    let scuolaId: string | null = null
    if (richiesta.ambitoGlobale) {
      const negato = ambitoGlobaleNegato(auth.user, canale, 'apertura-globale', OPERAZIONE)
      if (negato) return negato
    } else {
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, richiesta.scuolaId ?? undefined)
      if (sw.response) return sw.response
      scuolaId = sw.scuolaId as string
    }

    // ── CANCELLO 3 · A CHI VA, solo per la Galleria. Gli stessi quattro cancelli di
    //    `POST /api/gallery` — broadcast riservato alla Direzione, broadcast senza bambini,
    //    bambini della SEDE (quella appena risolta, mai l'elenco dei plessi di chi opera),
    //    liberatoria fotografica — da un modulo solo, quindi le stesse risposte parola per
    //    parola: 403 `TAG_FUORI_SEDE`, 403 broadcast, 400 broadcast con bambini, 422 con
    //    `nomi` e `ids`. Una seconda copia delle regole sarebbe la seconda occasione di
    //    correggerne una e dimenticare l'altra. Il 422 nomina dei minori e va SOLO al client
    //    di chi li ha scelti: nel log passano i conteggi (lo scrive il modulo).
    let destinatari: DestinatariGalleria | null = null
    if (richiesta.destinatari !== undefined) {
      const cancelli = await cancelliDestinatariGalleria(supabase, {
        ruolo: auth.user.role,
        sedeId: scuolaId as string,
        tagAlunni: richiesta.destinatari.tagAlunni,
        broadcast: richiesta.destinatari.broadcast,
        classi: richiesta.destinatari.classi,
        operazione: OPERAZIONE,
      })
      if (!cancelli.ok) return cancelli.response
      destinatari = cancelli.destinatari
    }

    // Il `payload` dell'intento dichiara l'ambito, ed è la metà che il database
    // legge: `video_intents_scuola_scope_chk` ammette la sede NULL solo se qui
    // dentro c'è `scope = 'global'`. Senza, il CHECK respinge con un 23514
    // anonimo — un 500 al posto di un rifiuto leggibile.
    const payload = { scope: richiesta.ambitoGlobale ? 'global' : 'sede' }

    const percorsi = richiesta.file.map((f) => percorsoOriginale(auth.user.id, canale, f))

    // ── IL TOKEN DI RINNOVO, per il trasporto nativo. Si conia PRIMA della RPC perché alla
    //    RPC va il suo hash, ma esce verso il client SOLO se la RPC l'ha davvero salvato (un
    //    intento nuovo, o una ripetizione che l'ha ruotato): un token che il database non
    //    conosce renderebbe il rinnovo impossibile senza che nessuno lo veda. Il token non
    //    entra MAI in un log, e nemmeno il suo hash.
    const nativo = richiesta.trasporto === 'put-nativo'
    const tokenRinnovo = nativo ? generaTokenRinnovo() : null
    const scadenzaToken = nativo ? scadenzaTokenRinnovo() : null

    // ── L'APERTURA. Il primo file nasce con l'intento; gli altri si aggiungono.
    //    PostgREST non lancia: l'esito della RPC sta in `data`, non in `error` —
    //    `error` qui significa soltanto «la funzione non c'è» o «il database non
    //    risponde».
    //
    //    Una Galleria apre e CONFERMA in un colpo solo (`video_galleria_intent_apri`: «Invia» è
    //    l'impegno, e da lì il video esce da solo); una News apre soltanto (`video_intent_open`),
    //    e la conferma la dà l'editor.
    const primo = richiesta.file[0]
    const rpcApertura = destinatari ? 'video_galleria_intent_apri' : 'video_intent_open'
    const { data: apertura, error: erroreApertura } = destinatari
      ? await supabase.rpc('video_galleria_intent_apri', {
          p_owner_id: auth.user.id,
          p_scuola_id: scuolaId,
          p_idempotency_key: primo.chiaveIdempotenza,
          p_original_path: percorsi[0],
          p_byte: primo.byte,
          p_mime: primo.mime,
          p_durata_s: primo.durataSecondi,
          p_tag_alunni: destinatari.tagAlunni,
          p_broadcast: destinatari.broadcast,
          p_classi: destinatari.classi,
          p_trasporto: richiesta.trasporto,
          // `bytea` per PostgREST: `\x<hex>`. Lo schema pretende lo `sha256` con il trasporto nativo.
          p_sha256: nativo && primo.sha256 ? `\\x${primo.sha256}` : null,
          p_token_hash: tokenRinnovo ? hashTokenRinnovoPerPostgres(tokenRinnovo) : null,
          p_token_scade_il: scadenzaToken ? scadenzaToken.toISOString() : null,
        })
      : await supabase.rpc('video_intent_open', {
          p_owner_id: auth.user.id,
          p_scuola_id: scuolaId,
          p_channel: canale,
          p_requested_action: richiesta.azione,
          p_payload: payload,
          p_idempotency_key: primo.chiaveIdempotenza,
          p_original_path: percorsi[0],
          p_target_id: richiesta.targetId,
          p_expected_target_version: richiesta.versioneTargetAttesa,
        })
    if (erroreApertura) {
      if (pipelineAssente(erroreApertura)) {
        return rispostaPipelineAssente(OPERAZIONE, rpcApertura, erroreApertura)
      }
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'rpc' }, erroreApertura)
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }

    const esitoApertura = (apertura ?? {}) as EsitoRpc
    if (esitoApertura.ok !== true) {
      return rispostaEsitoRpc(canale, OPERAZIONE, rpcApertura, typeof esitoApertura.code === 'string' ? esitoApertura.code : null, {
        utente: auth.user.id,
      })
    }

    const intentId = String(esitoApertura.intent?.id ?? '')
    const revisione = Number(esitoApertura.intent?.revision ?? 0)
    const primoJobId = String(esitoApertura.job?.id ?? '')
    if (!intentId || !primoJobId || !Number.isInteger(revisione) || revisione < 1) {
      // La RPC ha detto `ok` e non ha restituito ciò che promette: è un difetto
      // nostro, e vale la pena vederlo con lo stack invece che come un 200 rotto.
      logErrore(
        { operazione: OPERAZIONE, stato: 500, evento: 'rpc' },
        new Error(`${rpcApertura}: esito ok senza intent/job utilizzabili`),
      )
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }

    const jobIds: string[] = [primoJobId]
    const jobRpc: JobRpc[] = [esitoApertura.job!]
    const statoIntent = String(esitoApertura.intent?.status ?? 'pending')
    for (let i = 1; i < richiesta.file.length; i++) {
      const { data: aggiunta, error: erroreAggiunta } = await supabase.rpc('video_intent_add_job', {
        p_intent_id: intentId,
        p_owner_id: auth.user.id,
        p_revision: revisione,
        p_idempotency_key: richiesta.file[i].chiaveIdempotenza,
        p_original_path: percorsi[i],
      })
      if (erroreAggiunta) {
        if (pipelineAssente(erroreAggiunta)) {
          return rispostaPipelineAssente(OPERAZIONE, 'video_intent_add_job', erroreAggiunta)
        }
        logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'rpc' }, erroreAggiunta)
        return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
      }
      const esitoAggiunta = (aggiunta ?? {}) as EsitoRpc
      if (esitoAggiunta.ok !== true || !esitoAggiunta.job?.id) {
        // L'intento resta `pending` con i job che ce l'hanno fatta: NON si ritira.
        // Il ritentativo del client, con le stesse chiavi di idempotenza, ritrova
        // l'intento e i job già aperti e aggiunge solo quelli che mancano — che è
        // esattamente ciò per cui quelle chiavi esistono.
        return rispostaEsitoRpc(canale, OPERAZIONE, 'video_intent_add_job', typeof esitoAggiunta.code === 'string' ? esitoAggiunta.code : null, {
          utente: auth.user.id,
          aggiunti: jobIds.length,
          attesi: richiesta.file.length,
        })
      }
      jobIds.push(String(esitoAggiunta.job.id))
      jobRpc.push(esitoAggiunta.job)
    }

    // ── LE FIRME, dopo che il database ha detto di sì. Coniate prima, un rifiuto
    //    della RPC lascerebbe nel bucket il permesso di scrivere un oggetto che
    //    nessuna riga nomina.
    //
    //    Il token di rinnovo si restituisce solo se la RPC lo ha salvato: per un intento NUOVO
    //    sempre, per una ripetizione solo se l'ha ruotato (`token_ruotato`). Una ripetizione che
    //    non lo ha ruotato lascia valido il token di prima — che l'app ha già in mano.
    const tokenSalvato = esitoApertura.ripetuta !== true || esitoApertura.token_ruotato === true
    const job: JobAperto[] = []
    for (let i = 0; i < richiesta.file.length; i++) {
      const status = String(jobRpc[i].status ?? 'awaiting_upload') as JobAperto['status']
      let needsUpload = !INTENTI_CONCLUSI.includes(statoIntent) && status === 'awaiting_upload'
      let firma = ''
      let scadeFirma: string | null = null
      let caricamentoPut: Extract<JobAperto['caricamento'], { protocollo: 'put' }> | null = null
      let rinnovo: RinnovoVideo | null = null
      if (needsUpload) {
        const { data: originale, error: errInfo } = await supabase.storage.from(BUCKET_ORIGINALI_VIDEO).info(percorsi[i])
        const assente = String((errInfo as { statusCode?: string; status?: number } | null)?.statusCode ?? errInfo?.status) === '404'
        if (errInfo && !assente || !originale && !assente) {
          logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'storage' }, errInfo ?? new Error('Metadata originale mancanti'))
          return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
        }
        if (originale) {
          if (originale.size !== richiesta.file[i].byte) {
            logVideo(canale, 'warn', { operazione: OPERAZIONE, esito: 'originale-dimensione-diversa', job: jobIds[i] })
            return rispostaVideo('VIDEO_RIPROVA', 409)
          }
          needsUpload = false
        } else if (nativo) {
          if (!tokenRinnovo || !scadenzaToken || !tokenSalvato) {
            // Una PUT senza un token valido sarebbe un caricamento che nessuno può rinnovare, e il
            // telefono non lo saprebbe fino alla scadenza dell'URL: si rifiuta ora, col suo log.
            logVideo(canale, 'error', {
              operazione: OPERAZIONE,
              esito: 'token-rinnovo-non-salvato',
              job: jobIds[i],
              ripetuta: esitoApertura.ripetuta === true,
            })
            return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
          }
          const f = await firmaPut(supabase, percorsi[i], richiesta.file[i].mime)
          if (!f.ok) {
            logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'storage' }, f.errore)
            return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
          }
          caricamentoPut = f.caricamento
          scadeFirma = f.scadeIl
          rinnovo = { token: tokenRinnovo, scadeIl: scadenzaToken.toISOString() }
        } else {
          const f = await firmaTus(supabase, percorsi[i])
          if (!f.ok) {
            logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'storage' }, f.errore)
            return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
          }
          firma = f.firma
          scadeFirma = f.scadeIl
        }
      }
      job.push({
        jobId: jobIds[i],
        chiaveIdempotenza: richiesta.file[i].chiaveIdempotenza,
        // Con il PUT l'URL è già firmato; senza un URL da dare (il file è già arrivato, o l'intento è
        // concluso) le coordinate sono quelle TUS di sempre, `firma` vuota e `needs_upload` falso:
        // il client non le usa. Lo schema della risposta non ammette un `caricamento` assente.
        caricamento: caricamentoPut ?? coordinateTus(percorsi[i], richiesta.file[i].mime),
        firma,
        status,
        needs_upload: needsUpload,
        expires_at: scadeFirma,
        ...(rinnovo ? { rinnovo } : {}),
      })
    }

    // IL SUCCESSO SI LOGGA. Con i soli errori, «nessuna riga» non distingue «non
    // carica nessuno» da «la porta non risponde più» — ed è l'ambiguità che ha
    // nascosto per mesi il guasto delle email di credenziali.
    // Solo uuid, conteggi e metadati tecnici: niente nome del file, niente durata
    // di un filmato che riprende dei bambini, e dei bambini il NUMERO (`n_tag`) e
    // mai un identificativo. `tipo` è il trasporto: è una chiave della lista bianca di
    // `redact`, quindi sopravvive in tabella e si può contare («quanti caricamenti
    // nativi ieri?»).
    logVideo(canale, 'info', {
      operazione: OPERAZIONE,
      esito: 'intento-aperto',
      canale,
      utente: auth.user.id,
      sede: scuolaId ?? undefined,
      ambito: richiesta.ambitoGlobale ? 'globale' : 'sede',
      azione: richiesta.azione,
      tipo: richiesta.trasporto,
      video: job.length,
      byte_totali: richiesta.file.reduce((n, f) => n + f.byte, 0),
      n_tag: destinatari ? destinatari.tagAlunni.length : undefined,
      broadcast: destinatari ? destinatari.broadcast : undefined,
      ripetuta: esitoApertura.ripetuta === true ? true : undefined,
    })

    return NextResponse.json(
      {
        intentId,
        intent: { status: statoIntent },
        revisione,
        canale,
        scadenzaCaricamentoIl: scadenzaFirma(),
        job,
      },
      { status: 201 },
    )
  } catch (errore) {
    // `withRoute` non vede le eccezioni CATTURATE: senza questa riga resterebbe
    // una risposta 500 senza stack e senza causa.
    logErrore({ operazione: OPERAZIONE, stato: 500 }, errore)
    return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
  }
})

// =============================================================================
// GET /api/video-uploads?canale=gallery[&scuolaId=…] — l'elenco dei MIEI video.
//
// ─── A CHE COSA SERVE ────────────────────────────────────────────────────────
// Dal 2026-10-02 il video esce da solo, anche a pagina chiusa: chi lo ha caricato deve poter
// vedere dove sta, da qualunque dispositivo. La pagina fonde questo elenco con le sue righe
// locali (avanzamento e ripresa), mostra «In caricamento da un altro dispositivo» per ciò che
// non ha, offre «Riprova» sulle pubblicazioni fallite (`riprovaPossibile`) e dice «Questo video
// va ricaricato» per gli intenti del flusso vecchio. Il polling è ogni 10 secondi, solo con voci
// attive e la pagina visibile.
//
// ─── ISOLAMENTO ──────────────────────────────────────────────────────────────
// PROPRIETARIO e SEDE stanno dentro la query, non in un confronto dopo: `owner_id = utente` e
// `scuola_id IN (le sedi di chi chiama)` — o la sede chiesta, ma solo se è fra le proprie (403
// altrimenti, come ogni altra strada di questa cartella). Un intento di un collega non compare,
// e un video caricato in un plesso da cui ci si è spostati non compare più.
//
// ─── COSA SI LEGGE, E COSA NO ────────────────────────────────────────────────
// La voce si costruisce A MANO (`./elenco`), dalle sole colonne chieste: mai `tag_alunni`
// (identificativi di minori), mai l'hash del token né lo `sha256`, mai il percorso dell'originale.
// Dei bambini esce il numero. Il tetto di 50 voci, per `updated_at` decrescente, è una promessa:
// la query ha il suo `limit` e lo schema della risposta lo fa rispettare a chi legge.
// =============================================================================

/**
 * L'elenco esiste per la Galleria. Il contratto lascia `canale` aperto sui due valori — le News
 * hanno intenti con un altro ciclo di vita (nessuna pubblicazione automatica, nessun destinatario) — e
 * una fase che direbbe «va ricaricato» a una News sarebbe una bugia: finché non c'è un uso vero si
 * risponde 400 invece di inventare.
 */
const schemaQueryElencoGalleria = schemaQueryElencoVideo.refine((q) => q.canale === 'gallery', {
  path: ['canale'],
  message: 'l’elenco dei video esiste solo per la Galleria',
})

export const GET = withRoute('video-uploads:GET', async (request: NextRequest) => {
  const OPERAZIONE = 'video-uploads:GET'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    // 120 ogni 10 minuti per utente: due schede aperte che sondano ogni 10 secondi ne usano 120.
    const rl = await rateLimit(`video-uploads-elenco:${auth.user.id}`, { limit: 120, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) return rispostaTroppeRichieste(rl.retryAfterMs)

    const q = parseQuery(request, schemaQueryElencoGalleria)
    if ('response' in q) return q.response
    const canale = q.data.canale

    const supabase = await createAdminClient()

    // ── LE SEDI. Quelle di chi chiama, o la sede chiesta SE è fra le proprie. Il confronto
    //    è senza distinzione di maiuscole (in Postgres un uuid è un tipo, non una stringa).
    const proprie = await scuoleDiUtente(supabase, auth.user)
    let sedi = proprie
    if (q.data.scuolaId !== undefined) {
      const chiesta = q.data.scuolaId.trim().toLowerCase()
      const trovata = proprie.find((s) => s.trim().toLowerCase() === chiesta)
      if (trovata === undefined) {
        // `warn`: un accesso negato a dati di un'altra sede è un segnale di sicurezza. Solo uuid e conteggi.
        logVideo(canale, 'warn', {
          operazione: OPERAZIONE,
          esito: 'elenco-fuori-sede',
          utente: auth.user.id,
          ruolo: auth.user.role,
          sede_richiesta: q.data.scuolaId,
          accessibili: proprie.length,
        })
        return rispostaVideo('VIDEO_NON_AUTORIZZATO', 403)
      }
      sedi = [trovata]
    }

    // Nessuna sede = niente da vedere (e niente da isolare): un elenco vuoto, mai «tutto».
    if (sedi.length === 0) {
      logVideo(canale, 'info', { operazione: OPERAZIONE, esito: 'elenco-letto', utente: auth.user.id, sedi: 0, voci: 0, attive: 0, scartate: 0 })
      return NextResponse.json({ voci: [] })
    }

    const adesso = Date.now()
    // Gli intenti NON terminali, qualunque sia la loro età, più quelli terminali degli ultimi sette
    // giorni. L'indice `(owner_id, channel, updated_at DESC)` serve esattamente questa lettura.
    // Senza millisecondi: nella sintassi di `.or()` il punto separa colonna, operatore e valore.
    const soglia = new Date(adesso - GIORNI_ELENCO_CONCLUSI * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

    const { data: intenti, error: erroreIntenti } = await supabase
      .from('video_intents')
      .select(COLONNE_INTENTO_ELENCO)
      .eq('owner_id', auth.user.id)
      .eq('channel', canale)
      .in('scuola_id', sedi)
      .or(`status.in.(${STATI_INTENTO_NON_TERMINALI.join(',')}),updated_at.gte.${soglia}`)
      .order('updated_at', { ascending: false })
      .limit(MAX_VOCI_ELENCO_VIDEO)
    // PostgREST non lancia: l'errore è nel valore di ritorno.
    if (erroreIntenti) return rispostaErroreLettura(OPERAZIONE, 'video_intents', erroreIntenti)

    const righeIntenti = (intenti ?? []) as unknown as IntentoElenco[]
    const jobPerIntento = new Map<string, JobElenco>()
    if (righeIntenti.length > 0) {
      const { data: job, error: erroreJob } = await supabase
        .from('video_jobs')
        .select(COLONNE_JOB_ELENCO)
        .eq('owner_id', auth.user.id)
        .in('intent_id', righeIntenti.map((i) => i.id))
        .in('scuola_id', sedi)
        .order('created_at', { ascending: true })
      if (erroreJob) return rispostaErroreLettura(OPERAZIONE, 'video_jobs', erroreJob)
      // Un intento di Galleria ha un job solo (`SINGLE_JOB_CHANNEL`): se per un guasto ne avesse due,
      // vale il primo, che è il più vecchio.
      for (const riga of (job ?? []) as unknown as JobElenco[]) {
        if (!jobPerIntento.has(riga.intent_id)) jobPerIntento.set(riga.intent_id, riga)
      }
    }

    const voci: VoceVideo[] = []
    let scartate = 0
    for (const intento of righeIntenti) {
      const riga = jobPerIntento.get(intento.id)
      if (!riga) {
        // Un intento senza job non ha niente da raccontare, e non deve far cadere l'elenco: si scarta e si dice.
        scartate++
        logVideo(canale, 'error', { operazione: OPERAZIONE, esito: 'elenco-intento-senza-job', intento: intento.id })
        continue
      }
      const esito = costruisciVoce(intento, riga, adesso)
      if (!esito.ok) {
        // Un difetto NOSTRO (uno stato fuori contratto): una voce di meno, e la riga `error` che lo dice.
        // Solo l'uuid, il motivo e i PERCORSI dei campi: mai un valore.
        scartate++
        logVideo(canale, 'error', {
          operazione: OPERAZIONE,
          esito: 'elenco-voce-scartata',
          intento: intento.id,
          tipo: esito.motivo,
          campi: esito.percorsi?.join(',') || undefined,
        })
        continue
      }
      voci.push(esito.voce)
    }

    // Per `aggiornatoIl` decrescente, che è il più recente fra l'intento e il suo job: l'ordine della query è per
    // `updated_at` dell'intento, ma un job che avanza non lo tocca. (E `updated_at` non è «l'ultima modifica dei
    // dati»: la minimizzazione dei bambini non lo muove — vedi `./elenco`, secondario #83.)
    voci.sort((a, b) => Date.parse(b.aggiornatoIl) - Date.parse(a.aggiornatoIl))

    logVideo(canale, 'info', {
      operazione: OPERAZIONE,
      esito: 'elenco-letto',
      utente: auth.user.id,
      sede: sedi.length === 1 ? sedi[0] : undefined,
      sedi: sedi.length,
      voci: voci.length,
      attive: voci.filter((v) => FASI_ATTIVE.includes(v.fase)).length,
      scartate,
    })
    return NextResponse.json({ voci })
  } catch (errore) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, errore)
    return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
  }
})

/** Un errore di lettura: la pipeline che non c'è è un 503 pulito, il resto un 500 con lo stack. */
function rispostaErroreLettura(operazione: string, tabella: string, errore: { code?: string; message?: string }): NextResponse {
  if (pipelineAssente(errore)) return rispostaPipelineAssente(operazione, tabella, errore)
  logErrore({ operazione, stato: 500, evento: 'db' }, errore)
  return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
}
