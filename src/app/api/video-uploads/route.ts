import { createHash } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { requireDocente } from '@/lib/auth/require-staff'
import { logErrore } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { mimeBase } from '@/lib/gallery/limiti'
import {
  BUCKET_ORIGINALI_VIDEO,
  schemaAperturaIntentVideo,
  type CanaleVideo,
  type CoordinateCaricamentoVideo,
  type EsitoAperturaIntentVideo,
  type FileVideoDichiarato,
} from '@/lib/media/video/contratto'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { rateLimit } from '@/lib/security/rate-limit'
import { createAdminClient } from '@/lib/supabase/server-client'
import { SUPABASE_URL } from '@/lib/supabase/public-config'
import { parseBody } from '@/lib/validation/http'

import { ambitoGlobaleNegato } from './cancello'
import { logVideo, pipelineAssente, rispostaEsitoRpc, rispostaPipelineAssente, rispostaVideo } from './risposte'

// =============================================================================
// POST /api/video-uploads — APRE un caricamento video. Non ne riceve un byte.
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
// spedirà i byte allo Storage in TUS, da solo, e potendo riprendere da dove si è
// interrotto quando la rete mobile cade.
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
// `/storage/v1/upload/resumable/sign`, che è registrata fuori da RLS.
//
// ─── `vercel.json`: PERCHÉ `dub1`, E PERCHÉ IL PERCHÉ STA QUI ────────────────
// `vercel.json` dichiara `"src/app/api/video-uploads/**": { "regions": ["dub1"] }`.
// Dublino perché è dove stanno le altre due metà di questa pipeline: il progetto
// Supabase è su `eu-west-1` e il Vercel Sandbox che converte gira su `dub1`.
// Tenere queste due route altrove significherebbe far attraversare l'Atlantico a
// ogni chiamata RPC e a ogni firma, due volte per ciascuno dei dieci allegati di
// una News.
//
// ⚠️ E LA RAGIONE PER CUI QUESTA NOTA È IN UN FILE `.ts` E NON IN `vercel.json`:
// quel file resta JSON STRETTO, senza un solo commento. Un `vercel.json` che il
// parser rifiuta blocca OGNI deploy del progetto, compreso un hotfix su tutt'altro
// — ed è la stessa famiglia di guasto per cui quel file era stato tolto
// dall'albero il 2026-09-17: dichiarava questa cartella quando non esisteva, e un
// pattern `functions` senza nessun file che lo soddisfi fa fallire la build.
// Adesso la cartella esiste (questa, più `[id]/route.ts`), e il pattern ha due
// file veri. ⚠️ Nessuna di queste due cose è verificabile in locale: `next build`
// non legge `vercel.json`. Si misura su un preview deploy, e non prima.
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
 * Il blocco TUS. 6 MiB è la taglia che il client Supabase usa per gli upload
 * resumable: sbagliarla significa upload che ripartono da capo su rete mobile.
 */
const BLOCCO_TUS_BYTE = 6 * 1024 * 1024

/**
 * Quanto valgono le coordinate. È la durata dichiarata dal servizio per una firma
 * di caricamento (due ore), **non una misura fatta qui**: serve al client per
 * sapere quando riaprire l'intento invece di insistere su una firma scaduta.
 */
const VALIDITA_FIRMA_SECONDI = 2 * 60 * 60

/** La rotta TUS che autentica con `x-signature`, cioè l'unica che non passa da RLS. */
const ENDPOINT_TUS = `${SUPABASE_URL}/storage/v1/upload/resumable/sign`

/**
 * L'estensione dal MIME **validato**, mai dal nome del file.
 *
 * Un video di galleria si chiama `recita-bambina-rossi.mov`: è anagrafica di un
 * minore, e finirebbe nella chiave dell'oggetto — quindi in `app_log` ogni volta
 * che qualcosa logga un percorso. Del nome serve solo l'estensione, e quella si
 * ricava dal tipo. L'elenco copre i contenitori di `@/lib/media/video/limiti`;
 * ciò che non si riconosce resta `bin`, perché l'autorità su che cosa sia davvero
 * il file è ffprobe e arriva dopo.
 */
function estensioneVideoDaMime(mime: string): string {
  switch (mimeBase(mime)) {
    case 'video/mp4': return 'mp4'
    case 'video/quicktime': return 'mov'
    case 'video/x-m4v':
    case 'video/m4v': return 'm4v'
    case 'video/webm': return 'webm'
    case 'video/x-matroska': return 'mkv'
    case 'video/3gpp': return '3gp'
    case 'video/3gpp2': return '3g2'
    case 'video/x-msvideo': return 'avi'
    case 'video/x-ms-wmv':
    case 'video/x-ms-asf': return 'wmv'
    case 'video/mpeg': return 'mpg'
    case 'video/mp2t': return 'ts'
    case 'video/x-flv': return 'flv'
    case 'video/ogg': return 'ogv'
    case 'video/mj2': return 'mj2'
    default: return 'bin'
  }
}

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

/** Le coordinate con cui il client spedisce i byte di questo file. */
function coordinate(percorso: string, mime: string): CoordinateCaricamentoVideo {
  return {
    protocollo: 'tus',
    endpoint: ENDPOINT_TUS,
    bucket: BUCKET_ORIGINALI_VIDEO,
    percorso,
    contentType: mime,
    dimensioneBloccoByte: BLOCCO_TUS_BYTE,
  }
}

/**
 * Un job come esce dalla RPC: interessano l'id e il percorso, e il percorso serve
 * a verificare che la RPC abbia davvero preso quello che le si era passato.
 */
type JobRpc = { id?: unknown; original_path?: unknown }
type EsitoRpc = { ok?: unknown; code?: unknown; intent?: { id?: unknown; revision?: unknown } | null; job?: JobRpc | null }

/**
 * La risposta: il contratto, più la FIRMA.
 *
 * ⚠️ `schemaCoordinateCaricamentoVideo` non ha (ancora) un campo per il token
 * `x-signature`, e senza quel token il client ha un indirizzo e nessuna chiave.
 * Qui viaggia accanto alle coordinate invece che dentro: è un SOVRAINSIEME del
 * contratto — un client che legge con `schemaEsitoAperturaIntentVideo` continua a
 * funzionare, perché `z.object` scarta ciò che non conosce — e il campo va
 * riportato dentro il contratto insieme all'uploader di V10. Scritto qui e non
 * lasciato implicito, perché un'estensione taciuta è esattamente il modo in cui
 * due lati dello stesso confine cominciano a divergere.
 */
type JobAperto = EsitoAperturaIntentVideo['job'][number] & { firma: string }

export const POST = withRoute('video-uploads:POST', async (request: NextRequest) => {
  const OPERAZIONE = 'video-uploads:POST'
  try {
    // ── CANCELLO 1 · CHI SEI. Prima del corpo, sempre: `parseBody` bufferizza e
    //    deposita nel contesto di log ciò che è arrivato, e farlo per un anonimo
    //    vuol dire lavorare per chi non ha ancora detto chi è.
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const rl = await rateLimit(`video-uploads:${auth.user.id}`, { limit: 30, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppi caricamenti. Riprova tra qualche minuto.', codice: 'TROPPE_RICHIESTE' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
      )
    }

    const b = await parseBody(request, schemaAperturaIntentVideo)
    if ('response' in b) return b.response
    const richiesta = b.data
    const canale = richiesta.canale

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

    // Il `payload` dell'intento dichiara l'ambito, ed è la metà che il database
    // legge: `video_intents_scuola_scope_chk` ammette la sede NULL solo se qui
    // dentro c'è `scope = 'global'`. Senza, il CHECK respinge con un 23514
    // anonimo — un 500 al posto di un rifiuto leggibile.
    const payload = { scope: richiesta.ambitoGlobale ? 'global' : 'sede' }

    const percorsi = richiesta.file.map((f) => percorsoOriginale(auth.user.id, canale, f))

    // ── L'APERTURA. Il primo file nasce con l'intento; gli altri si aggiungono.
    //    PostgREST non lancia: l'esito della RPC sta in `data`, non in `error` —
    //    `error` qui significa soltanto «la funzione non c'è» o «il database non
    //    risponde».
    const { data: apertura, error: erroreApertura } = await supabase.rpc('video_intent_open', {
      p_owner_id: auth.user.id,
      p_scuola_id: scuolaId,
      p_channel: canale,
      p_requested_action: richiesta.azione,
      p_payload: payload,
      p_idempotency_key: richiesta.file[0].chiaveIdempotenza,
      p_original_path: percorsi[0],
      p_target_id: richiesta.targetId,
      p_expected_target_version: richiesta.versioneTargetAttesa,
    })
    if (erroreApertura) {
      if (pipelineAssente(erroreApertura)) {
        return rispostaPipelineAssente(OPERAZIONE, 'video_intent_open', erroreApertura)
      }
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'rpc' }, erroreApertura)
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }

    const esitoApertura = (apertura ?? {}) as EsitoRpc
    if (esitoApertura.ok !== true) {
      return rispostaEsitoRpc(canale, OPERAZIONE, 'video_intent_open', typeof esitoApertura.code === 'string' ? esitoApertura.code : null, {
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
        new Error('video_intent_open: esito ok senza intent/job utilizzabili'),
      )
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }

    const jobIds: string[] = [primoJobId]
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
    }

    // ── LE FIRME, dopo che il database ha detto di sì. Coniate prima, un rifiuto
    //    della RPC lascerebbe nel bucket il permesso di scrivere un oggetto che
    //    nessuna riga nomina.
    const job: JobAperto[] = []
    for (let i = 0; i < richiesta.file.length; i++) {
      const { data: firma, error: erroreFirma } = await supabase.storage
        .from(BUCKET_ORIGINALI_VIDEO)
        .createSignedUploadUrl(percorsi[i])
      if (erroreFirma || !firma?.token) {
        // Il corpo dell'errore del fornitore resta nel LOG e non torna al client:
        // «Bucket not found: video_originals» non è una frase da mostrare a
        // un'insegnante, e porta fuori il nome del bucket.
        logErrore(
          { operazione: OPERAZIONE, stato: 500, evento: 'storage' },
          erroreFirma ?? new Error('createSignedUploadUrl senza token'),
        )
        return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
      }
      job.push({
        jobId: jobIds[i],
        chiaveIdempotenza: richiesta.file[i].chiaveIdempotenza,
        caricamento: coordinate(percorsi[i], richiesta.file[i].mime),
        firma: firma.token,
      })
    }

    // IL SUCCESSO SI LOGGA. Con i soli errori, «nessuna riga» non distingue «non
    // carica nessuno» da «la porta non risponde più» — ed è l'ambiguità che ha
    // nascosto per mesi il guasto delle email di credenziali.
    // Solo uuid, conteggi e metadati tecnici: niente nome del file, niente durata
    // di un filmato che riprende dei bambini.
    logVideo(canale, 'info', {
      operazione: OPERAZIONE,
      esito: 'intento-aperto',
      canale,
      utente: auth.user.id,
      sede: scuolaId ?? undefined,
      ambito: richiesta.ambitoGlobale ? 'globale' : 'sede',
      azione: richiesta.azione,
      video: job.length,
      byte_totali: richiesta.file.reduce((n, f) => n + f.byte, 0),
    })

    return NextResponse.json(
      {
        intentId,
        revisione,
        canale,
        scadenzaCaricamentoIl: new Date(Date.now() + VALIDITA_FIRMA_SECONDI * 1000).toISOString(),
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
