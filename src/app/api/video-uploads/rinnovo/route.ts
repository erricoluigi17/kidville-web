import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { logErrore } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import {
  BUCKET_ORIGINALI_VIDEO,
  type RispostaRinnovoVideo,
} from '@/lib/media/video/contratto'
import {
  FINESTRA_TETTO_RINNOVO_MS,
  TETTO_RINNOVO_PER_IP,
  TETTO_RINNOVO_PER_TOKEN,
  hashTokenRinnovoEsadecimale,
  hashTokenRinnovoPerPostgres,
  tokenRinnovoDaRichiesta,
} from '@/lib/media/video/token-rinnovo'
import { clientIp, rateLimit } from '@/lib/security/rate-limit'
import { createAdminClient } from '@/lib/supabase/server-client'

import { firmaPut, mimeDaEstensione } from '../firme'
import {
  logVideo,
  pipelineAssente,
  rispostaEsitoRpc,
  rispostaPipelineAssente,
  rispostaTroppeRichieste,
  rispostaVideo,
} from '../risposte'

// =============================================================================
// POST /api/video-uploads/rinnovo — un URL di caricamento NUOVO, per chi ha solo il token.
//
// NESSUNA SESSIONE. È l'unica porta di questa cartella senza `requireDocente`, ed è giusto così: la
// chiama l'app 1.2, che manda l'originale con una PUT sola dal sistema operativo anche ad app
// chiusa, e che quando l'URL firmato scade (due ore) o la PUT prende 400/403 non ha nessuna sessione
// da presentare — il sistema operativo la risveglia, non l'insegnante. Il gate è il TOKEN DI
// RINNOVO, nell'intestazione `x-kidville-rinnovo`, coniato all'apertura (`./token-rinnovo`).
//
// ─── COSA OTTIENE UN ANONIMO CHE PASSA ───────────────────────────────────────
// Se ha un token valido: UN URL di caricamento per QUEL percorso, e solo finché l'originale non è
// arrivato. Non legge niente (la risposta dice uno stato e al massimo un URL che lui stesso
// aveva già ricevuto all'apertura), non crea niente, non vede un'altra famiglia. Come si limita il
// danno di un token rubato:
//  · l'URL è firmato SENZA upsert: una seconda PUT sullo stesso percorso prende 409, e l'originale
//    già arrivato non si sovrascrive;
//  · il trigger d'arrivo rifiuta una dimensione diversa da quella dichiarata (`ORIGINALE_DIVERSO`) e
//    una riscrittura successiva diventa `ORIGINALE_SOSTITUITO`;
//  · lo `sha256` dichiarato all'apertura e riverificato nel Sandbox rende impossibile sostituire il
//    contenuto;
//  · un token revocato — il file è arrivato, o l'intento è stato ritirato — non dà MAI un URL: dà lo
//    stato (`arrivato`, `annullato`), che serve alla 1.2 per sapere che il file c'è (la sua seconda
//    PUT ha preso 409) e si ferma lì. Lo decide la RPC (`video_rinnovo_usa`), e qui un test lo tiene fermo.
//
// ─── COME SI DIFENDE UNA PORTA SENZA SESSIONE ────────────────────────────────
//  · INDOVINARLO: 256 bit, e 404 UNIFORME (`VIDEO_NON_TROVATO`) per token assente, malformato,
//    sconosciuto, scaduto o revocato-con-file-da-caricare. Distinguere i casi direbbe a chi prova che
//    quel token è esistito;
//  · MARTELLARLO: due tetti — 30 richieste ogni 10 minuti per IP, e 20 per impronta del token
//    (`./token-rinnovo`, accanto alla forma del token) — applicati a OGNI richiesta ben formata,
//    esista il token o no, così un 429 non dice nulla;
//  · LEGGERLO: il token si legge dall'intestazione PRIMA di qualunque altra cosa, e il corpo non si
//    legge MAI (la risposta non ne dipende: un corpo scelto da un anonimo non entra in questa porta);
//  · LOGGARLO: MAI. Né il token né il suo hash compaiono in un log, in nessun ramo — il logger lo
//    lascerebbe passare (un token ha la forma di un enumerato) — e un test esegue la route col
//    logger vero e cerca entrambi in ogni riga.
//
// Per i lock: `gate-coverage` (la voce di questa porta in `PUBBLICHE` dice tutto questo per esteso),
// `isolamento-sede-coverage` (la RPC non porta una sede: la sede è del job, e il token lo
// identifica), `upload-pubblico-con-tetto` (due tetti, importati da un modulo condiviso) e
// `corpo-letto-dopo-il-gate` (il token prima del corpo).
// =============================================================================

const OPERAZIONE = 'video-uploads/rinnovo:POST'

/**
 * L'esito di `video_rinnovo_usa`, riletto con zod invece che con un cast.
 *
 * Ciò che torna da una RPC non è tipizzato, e questa è una porta senza sessione: un campo che manca o
 * un bucket diverso da quello atteso non devono diventare un URL firmato per «qualcosa». Lo schema è
 * quello che la RPC promette (la sua testata lo dice per esteso): `{ok:false, code}`, oppure
 * `{ok:true, stato:'arrivato'|'annullato'}`, oppure `da-caricare` con il percorso, il tipo e la scadenza
 * del token. Tutto il resto è un difetto nostro, e un 500 con un log — che dice QUALI campi non tornano,
 * mai i loro valori.
 */
const schemaEsitoRinnovoRpc = z.union([
  z.object({ ok: z.literal(false), code: z.string().max(80) }),
  z.object({ ok: z.literal(true), stato: z.literal('arrivato') }),
  z.object({ ok: z.literal(true), stato: z.literal('annullato') }),
  z.object({
    ok: z.literal(true),
    stato: z.literal('da-caricare'),
    job_id: z.guid(),
    intent_id: z.guid(),
    bucket: z.literal(BUCKET_ORIGINALI_VIDEO),
    percorso: z.string().min(1).max(1024),
    mime: z.string().max(255).nullable(),
    scade_il: z.string().refine((valore) => !Number.isNaN(Date.parse(valore)), { message: 'data non valida' }),
  }),
])

/** Una risposta di successo: mai in una cache (porta un URL firmato). */
const SENZA_CACHE = { headers: { 'Cache-Control': 'no-store' } }

export const POST = withRoute('video-uploads/rinnovo:POST', async (request: NextRequest) => {
  try {
    // ── 1 · IL TETTO PER INDIRIZZO. Prima di tutto, anche prima di guardare il token: chi sonda a
    //    raffica si ferma qui, senza costare una lettura. Il soggetto (l'IP) non entra nel log.
    const perIp = await rateLimit(`video-rinnovo-ip:${clientIp(request)}`, {
      limit: TETTO_RINNOVO_PER_IP,
      windowMs: FINESTRA_TETTO_RINNOVO_MS,
    })
    if (!perIp.ok) {
      logVideo('gallery', 'warn', { operazione: OPERAZIONE, esito: 'rinnovo-negato', tipo: 'tetto-per-ip' })
      return rispostaTroppeRichieste(perIp.retryAfterMs)
    }

    // ── 2 · IL TOKEN, dall'intestazione e da nessun altro posto. Assente o malformato è lo stesso 404
    //    di uno sconosciuto: nessun modo di sapere, da fuori, in quale dei casi si è finiti. Nel log
    //    c'è il MOTIVO (un enumerato), mai il valore.
    const letto = tokenRinnovoDaRichiesta(request)
    if (letto.esito !== 'ok') {
      logVideo('gallery', 'warn', { operazione: OPERAZIONE, esito: 'rinnovo-negato', tipo: `token-${letto.esito}` })
      return rispostaVideo('VIDEO_NON_TROVATO', 404)
    }
    const token = letto.token

    // ── 3 · IL TETTO PER TOKEN, sull'impronta. Vale per ogni token ben formato — esistente o no — e per
    //    questo un 429 qui non rivela niente. L'impronta sta nella chiave del tetto (una tabella con RLS,
    //    mai un log: `rate-limit` ne registra il solo GRUPPO).
    const perToken = await rateLimit(`video-rinnovo-token:${hashTokenRinnovoEsadecimale(token)}`, {
      limit: TETTO_RINNOVO_PER_TOKEN,
      windowMs: FINESTRA_TETTO_RINNOVO_MS,
    })
    if (!perToken.ok) {
      logVideo('gallery', 'warn', { operazione: OPERAZIONE, esito: 'rinnovo-negato', tipo: 'tetto-per-token' })
      return rispostaTroppeRichieste(perToken.retryAfterMs)
    }

    // ── 4 · LA RPC. Si passa lo SHA-256, mai il token. PostgREST non lancia: l'esito sta in `data`.
    const supabase = await createAdminClient()
    const { data, error } = await supabase.rpc('video_rinnovo_usa', { p_hash: hashTokenRinnovoPerPostgres(token) })
    if (error) {
      if (pipelineAssente(error)) {
        return rispostaPipelineAssente(OPERAZIONE, 'video_rinnovo_usa', error)
      }
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'rpc' }, error)
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }

    // L'esito si rilegge con lo schema: ciò che non lo rispetta non diventa mai un URL firmato.
    const letta = schemaEsitoRinnovoRpc.safeParse(data ?? {})
    if (!letta.success) {
      // Un difetto nostro (la RPC non promette questa forma): un errore con lo stack. Dei campi che non tornano
      // si dicono i PERCORSI, mai i valori.
      logErrore(
        { operazione: OPERAZIONE, stato: 500, evento: 'rpc' },
        new Error(
          `video_rinnovo_usa: esito fuori forma (${[...new Set(letta.error.issues.map((i) => i.path.join('.') || 'esito'))].join(', ')})`,
        ),
      )
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }
    const esito = letta.data

    if (!esito.ok) {
      if (esito.code === 'TOKEN_NON_VALIDO') {
        // Sconosciuto, scaduto, ruotato, o revocato mentre il file è ancora da caricare: per fuori è sempre
        // e solo «non esiste». La RPC scrive il motivo preciso nel suo log, che non ha l'hash.
        logVideo('gallery', 'warn', { operazione: OPERAZIONE, esito: 'rinnovo-negato', tipo: 'token-non-valido' })
        return rispostaVideo('VIDEO_NON_TROVATO', 404)
      }
      // Qualunque altro rifiuto non l'ha causato chi chiama: la RPC non ha altro da dire a un token.
      return rispostaEsitoRpc('gallery', OPERAZIONE, 'video_rinnovo_usa', esito.code)
    }

    // ── 5 · LO STATO. `arrivato` e `annullato` non portano un URL: dopo l'arrivo del file, o dopo il
    //    ritiro del video, un URL di caricamento non si ottiene più — è la proprietà che regge il token.
    if (esito.stato === 'arrivato' || esito.stato === 'annullato') {
      logVideo('gallery', 'info', {
        operazione: OPERAZIONE,
        esito: esito.stato === 'arrivato' ? 'rinnovo-arrivato' : 'rinnovo-annullato',
      })
      const risposta: RispostaRinnovoVideo = { stato: esito.stato }
      return NextResponse.json(risposta, SENZA_CACHE)
    }

    // ── 6 · DA CARICARE: un URL nuovo, firmato senza upsert, per il percorso di QUEL job. Bucket e
    //    percorso sono quelli che lo schema ha già verificato (il bucket è QUELLO degli originali).
    const mime = esito.mime !== null && esito.mime !== '' ? esito.mime : mimeDaEstensione(esito.percorso)
    const firma = await firmaPut(supabase, esito.percorso, mime)
    if (!firma.ok) {
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'storage' }, firma.errore)
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }

    // IL SUCCESSO SI LOGGA. Solo uuid del job e dell'intento (la RPC li restituisce nel solo caso
    // `da-caricare`): mai il token, mai il suo hash, mai il percorso o l'URL firmato.
    logVideo('gallery', 'info', {
      operazione: OPERAZIONE,
      esito: 'rinnovo-emesso',
      job: esito.job_id,
      intento: esito.intent_id,
    })

    // `scadeIl` è quella del TOKEN (immutata dal rinnovo: serve all'app per smettere di insistere), non quella
    // dell'URL. Normalizzata in UTC: PostgREST la restituisce con l'offset, e il contratto vuole la `Z`.
    const risposta: RispostaRinnovoVideo = {
      stato: 'da-caricare',
      caricamento: firma.caricamento,
      scadeIl: new Date(esito.scade_il).toISOString(),
    }
    return NextResponse.json(risposta, SENZA_CACHE)
  } catch (errore) {
    // Un'eccezione qui dentro non deve MAI portare con sé la richiesta: `logErrore` registra l'errore, non la
    // richiesta — e nessun campo di questa route nomina il token.
    logErrore({ operazione: OPERAZIONE, stato: 500 }, errore)
    return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
  }
})
