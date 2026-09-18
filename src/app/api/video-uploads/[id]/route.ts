import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { requireDocente } from '@/lib/auth/require-staff'
import { logErrore } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import {
  avanzamentoDaStatoVideo,
  CANALI_VIDEO,
  codiceMessaggioVideo,
  schemaStatoJobVideo,
  type CanaleVideo,
  type StatoJobVideo,
  type StatoJobVideoLetto,
} from '@/lib/media/video/contratto'
import { MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

import { sedeAncoraPropria } from '../cancello'
import { logVideo, pipelineAssente, rispostaEsitoRpc, rispostaPipelineAssente, rispostaVideo } from '../risposte'

// =============================================================================
// GET|PATCH /api/video-uploads/[id] — lo stato che il telefono interroga, e le
// azioni sull'intento.
//
// ─── PERCHÉ L'ID È QUELLO DELL'INTENTO E NON DI UN JOB ───────────────────────
// Una News porta fino a dieci allegati: dieci job sotto un solo impegno. Il
// telefono interroga UNO e riceve tutti gli stati insieme. Un id per job vorrebbe
// dire dieci richieste per ogni giro di polling, su rete mobile, con l'app
// aperta — ed è già successo: nel settembre 2026 il polling di questa
// applicazione produceva 2,23 milioni di richieste al giorno.
//
// ─── CHE COSA *NON* STA QUI ──────────────────────────────────────────────────
// La PUBBLICAZIONE. `video_intent_finalize` è l'unico punto in cui qualcosa
// diventa visibile a una famiglia, e pretende i gate del dominio — consenso foto,
// permessi correnti sul target, revisione del target. Esporlo qui come una quinta
// azione vorrebbe dire pubblicare aggirandoli. Sta in V08 (Galleria) e V09 (News),
// dove quei gate esistono.
// =============================================================================

const OPERAZIONE_GET = 'video-uploads/[id]:GET'
const OPERAZIONE_PATCH = 'video-uploads/[id]:PATCH'

interface ParametriRotta {
  params: Promise<{ id: string }>
}

/**
 * LE AZIONI, ESPLICITE E CHIUSE.
 *
 * `z.discriminatedUnion` e non un `azione: z.string()` con uno `switch`: un verbo
 * sconosciuto deve essere un 400 di validazione — prima del gate di sede, prima
 * del database — e non un ramo `default` che decide per conto suo. `pubblica` non
 * è fra questi, e il test lo verifica: la sua assenza è una decisione.
 */
const schemaAzioneVideo = z.discriminatedUnion('azione', [
  z.object({
    /** L'upload TUS è arrivato in fondo: il job entra in coda per la conversione. */
    azione: z.literal('caricato'),
    jobId: zUuid,
    /** Rimisurati sul file caricato: il client li DICHIARA, la RPC li confronta. */
    byte: z.number().int().min(1).max(MAX_VIDEO_INPUT_BYTES),
    mime: z.string().min(3).max(255),
  }),
  z.object({
    /** L'utente si impegna: da qui in poi può chiudere l'app. */
    azione: z.literal('conferma'),
    revisione: z.number().int().min(1),
  }),
  z.object({
    /** Ritiro dell'intento intero, con i job non ancora conclusi. */
    azione: z.literal('annulla'),
    revisione: z.number().int().min(1),
  }),
  z.object({
    /** Un allegato solo: la News resta, il video no. */
    azione: z.literal('annulla-job'),
    jobId: zUuid,
  }),
])

/** Le colonne che servono a raccontare lo stato, e nessuna di più. */
const COLONNE_INTENTO = 'id, owner_id, scuola_id, channel, revision, status, updated_at'
const COLONNE_JOB = 'id, intent_id, channel, status, error_code, updated_at, created_at'

type RigaIntento = {
  id: string
  owner_id: string
  scuola_id: string | null
  channel: string
  revision: number
  status: string
  updated_at: string
}

type RigaJob = {
  id: string
  intent_id: string
  channel: string
  status: string
  error_code: string | null
  updated_at: string
}

type Letto =
  | { intento: RigaIntento; job: RigaJob[]; response?: undefined }
  | { intento?: undefined; job?: undefined; response: NextResponse }

/**
 * Legge l'intento e i suoi job, applicando il cancello applicativo.
 *
 * ⚠️ IL FILTRO `owner_id` È DENTRO LA QUERY, non un confronto dopo. Così un
 * intento di un'altra persona risponde **404** invece di 403: gli uuid non si
 * indovinano, e un 403 direbbe a chi prova che quell'id esiste. Il 403 resta per
 * la SEDE, che è l'unico caso in cui la riga è davvero tua e il perimetro no.
 */
async function leggiIntento(
  supabase: SupabaseClient,
  user: AppUser,
  intentId: string,
  operazione: string,
): Promise<Letto> {
  const { data: intento, error: erroreIntento } = await supabase
    .from('video_intents')
    .select(COLONNE_INTENTO)
    .eq('id', intentId)
    .eq('owner_id', user.id)
    .maybeSingle()

  // PostgREST non lancia: l'errore è nel valore di ritorno, e un `try` attorno a
  // questa `await` non scatterebbe mai.
  if (erroreIntento) {
    if (pipelineAssente(erroreIntento)) {
      return { response: rispostaPipelineAssente(operazione, 'video_intents', erroreIntento) }
    }
    logErrore({ operazione, stato: 500, evento: 'db' }, erroreIntento)
    return { response: rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500) }
  }
  if (!intento) {
    return { response: rispostaVideo('VIDEO_NON_TROVATO', 404) }
  }

  const riga = intento as unknown as RigaIntento
  const canale = canaleDi(riga.channel)

  const sede = await sedeAncoraPropria({
    supabase,
    user,
    canale,
    scuolaIdIntento: riga.scuola_id,
    operazione,
  })
  if (sede.response) return { response: sede.response }

  const { data: job, error: erroreJob } = await supabase
    .from('video_jobs')
    .select(COLONNE_JOB)
    .eq('intent_id', intentId)
    .order('created_at', { ascending: true })

  if (erroreJob) {
    if (pipelineAssente(erroreJob)) {
      return { response: rispostaPipelineAssente(operazione, 'video_jobs', erroreJob) }
    }
    logErrore({ operazione, stato: 500, evento: 'db' }, erroreJob)
    return { response: rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500) }
  }

  return { intento: riga, job: (job ?? []) as unknown as RigaJob[] }
}

/** Il canale della riga, ricondotto al vocabolario chiuso del contratto. */
function canaleDi(valore: string): CanaleVideo {
  return (CANALI_VIDEO as readonly string[]).includes(valore) ? (valore as CanaleVideo) : 'gallery'
}

/**
 * Lo stato di un job come lo legge il client.
 *
 * ⚠️ IL CODICE CHE ESCE È QUELLO MOSTRABILE. `OUTPUT_DURATION_MISMATCH` è il
 * verdetto di `verifyVideoOutput` e `LEASE_EXPIRED` racconta com'è fatto il
 * worker: mostrarli a un genitore vorrebbe dire mettergli davanti l'architettura.
 * E il codice esce SOLO se il job è fallito — una barra piena su un fallimento è
 * una bugia, un codice d'errore su un job vivo è un allarme falso. Lo pretende
 * anche `schemaStatoJobVideo`, che qui riverifica il risultato invece di fidarsi.
 */
function statoJob(riga: RigaJob, intentId: string): StatoJobVideoLetto | null {
  const stato = riga.status as StatoJobVideo
  const fallito = stato === 'rejected' || stato === 'failed'
  const letto = {
    jobId: riga.id,
    intentId,
    canale: canaleDi(riga.channel),
    stato,
    avanzamento: avanzamentoDaStatoVideo(stato) ?? null,
    codice: fallito ? codiceMessaggioVideo(riga.error_code) : null,
    aggiornatoIl: new Date(riga.updated_at).toISOString(),
  }
  const esito = schemaStatoJobVideo.safeParse(letto)
  return esito.success ? esito.data : null
}

/** Il corpo che GET e PATCH restituiscono: uno solo, così il client ha un parser solo. */
function corpoStato(intento: RigaIntento, job: RigaJob[], operazione: string): NextResponse {
  const stati: StatoJobVideoLetto[] = []
  for (const riga of job) {
    const letto = statoJob(riga, intento.id)
    if (!letto) {
      // Uno stato che il contratto non riconosce è un difetto NOSTRO: mandarlo
      // comunque significherebbe far decidere al client che cosa farne.
      logErrore(
        { operazione, stato: 500, evento: 'db' },
        new Error(`stato di job fuori contratto: ${riga.status}`),
      )
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }
    stati.push(letto)
  }
  return NextResponse.json({
    intentId: intento.id,
    revisione: intento.revision,
    canale: canaleDi(intento.channel),
    statoIntent: intento.status,
    aggiornatoIl: new Date(intento.updated_at).toISOString(),
    job: stati,
  })
}

export const GET = withRoute('video-uploads/[id]:GET', async (request: NextRequest, { params }: ParametriRotta) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const supabase = await createAdminClient()
    const letto = await leggiIntento(supabase, auth.user, p.data, OPERAZIONE_GET)
    if (letto.response) return letto.response

    return corpoStato(letto.intento, letto.job, OPERAZIONE_GET)
  } catch (errore) {
    logErrore({ operazione: OPERAZIONE_GET, stato: 500 }, errore)
    return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
  }
})

export const PATCH = withRoute('video-uploads/[id]:PATCH', async (request: NextRequest, { params }: ParametriRotta) => {
  try {
    // ── CANCELLO 1 · CHI SEI, prima del corpo.
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const b = await parseBody(request, schemaAzioneVideo)
    if ('response' in b) return b.response
    const azione = b.data

    const supabase = await createAdminClient()

    // ── CANCELLO 2 · È TUO, ED È ANCORA NELLA TUA SEDE. Lo stesso cancello del
    //    GET, chiamato dallo stesso posto: una copia qui dentro divergerebbe dal
    //    giorno in cui una delle due viene toccata.
    const prima = await leggiIntento(supabase, auth.user, p.data, OPERAZIONE_PATCH)
    if (prima.response) return prima.response
    const canale = canaleDi(prima.intento.channel)

    // Un job si tocca solo se è di QUESTO intento: `video_job_uploaded` e
    // `video_job_cancel` controllano il proprietario, non l'appartenenza — e un
    // job proprio ma di un altro intento è comunque una riga che questa richiesta
    // non nomina.
    if ('jobId' in azione && !prima.job.some((j) => j.id === azione.jobId)) {
      logVideo(canale, 'warn', {
        operazione: OPERAZIONE_PATCH,
        esito: 'job-fuori-intento',
        tipo: azione.azione,
        utente: auth.user.id,
        intento: prima.intento.id,
      })
      return rispostaVideo('VIDEO_NON_TROVATO', 404)
    }

    // ── IL CANCELLO TRANSAZIONALE. Un solo vincitore, revisione corrente, stato
    //    ammesso: cose che si sanno solo sotto lock, e che nessun controllo qui
    //    sopra può garantire — fra la lettura e la scrittura c'è una finestra.
    const { rpc, argomenti } = chiamata(azione, p.data, auth.user.id)
    const { data: esito, error: erroreRpc } = await supabase.rpc(rpc, argomenti)
    if (erroreRpc) {
      if (pipelineAssente(erroreRpc)) {
        return rispostaPipelineAssente(OPERAZIONE_PATCH, rpc, erroreRpc)
      }
      logErrore({ operazione: OPERAZIONE_PATCH, stato: 500, evento: 'rpc' }, erroreRpc)
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }

    const risposta = (esito ?? {}) as { ok?: unknown; code?: unknown }
    if (risposta.ok !== true) {
      return rispostaEsitoRpc(canale, OPERAZIONE_PATCH, rpc, typeof risposta.code === 'string' ? risposta.code : null, {
        utente: auth.user.id,
        azione: azione.azione,
      })
    }

    // IL SUCCESSO SI LOGGA: una conferma è l'istante in cui l'utente si impegna,
    // e un annullo è l'istante in cui qualcosa smette di esistere. Con i soli
    // errori, «nessuna riga» direbbe insieme «non succede mai» e «non funziona».
    logVideo(canale, 'info', {
      operazione: OPERAZIONE_PATCH,
      esito: 'azione-eseguita',
      azione: azione.azione,
      canale,
      utente: auth.user.id,
      sede: prima.intento.scuola_id ?? undefined,
      intento: prima.intento.id,
    })

    // Si rilegge: dopo `annulla` metà dei job cambia stato, e restituire ciò che
    // si era letto PRIMA manderebbe il client a mostrare una schermata già falsa.
    const dopo = await leggiIntento(supabase, auth.user, p.data, OPERAZIONE_PATCH)
    if (dopo.response) return dopo.response
    return corpoStato(dopo.intento, dopo.job, OPERAZIONE_PATCH)
  } catch (errore) {
    logErrore({ operazione: OPERAZIONE_PATCH, stato: 500 }, errore)
    return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
  }
})

/**
 * Da un'azione validata alla RPC che la esegue.
 *
 * Una funzione e non quattro rami dentro l'handler: il `switch` è esaustivo su
 * un'unione chiusa, quindi aggiungere un'azione domani senza dire quale RPC la
 * esegue non compila.
 *
 * ⚠️ Vive FUORI dagli handler anche per una ragione di forma: un file di route in
 * App Router può esportare i soli metodi HTTP e le costanti di segmento, quindi
 * qui dentro le funzioni d'appoggio restano private al modulo.
 */
function chiamata(
  azione: z.infer<typeof schemaAzioneVideo>,
  intentId: string,
  ownerId: string,
): { rpc: string; argomenti: Record<string, unknown> } {
  switch (azione.azione) {
    case 'caricato':
      return {
        rpc: 'video_job_uploaded',
        argomenti: {
          p_job_id: azione.jobId,
          p_owner_id: ownerId,
          p_source_size: azione.byte,
          p_source_mime: azione.mime,
        },
      }
    case 'conferma':
      return {
        rpc: 'video_intent_confirm',
        argomenti: { p_intent_id: intentId, p_owner_id: ownerId, p_revision: azione.revisione },
      }
    case 'annulla':
      return {
        rpc: 'video_intent_revoke',
        argomenti: { p_intent_id: intentId, p_owner_id: ownerId, p_revision: azione.revisione },
      }
    case 'annulla-job':
      return {
        rpc: 'video_job_cancel',
        argomenti: { p_job_id: azione.jobId, p_owner_id: ownerId },
      }
  }
}
