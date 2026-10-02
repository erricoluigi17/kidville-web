import { NextResponse, type NextRequest } from 'next/server'

import { requireDocente } from '@/lib/auth/require-staff'
import { logErrore } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { schemaCorpoFirmaVideo, type RispostaFirmaVideo } from '@/lib/media/video/contratto'
import { rateLimit } from '@/lib/security/rate-limit'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

import { canaleDi, leggiIntento } from '../../cancello'
import { coordinateTus, firmaTus, mimeDaEstensione } from '../../firme'
import { logVideo, rispostaTroppeRichieste, rispostaVideo } from '../../risposte'

// =============================================================================
// POST /api/video-uploads/[id]/firma — una firma TUS NUOVA per un job che aspetta ancora il suo file.
//
// `[id]` è l'INTENTO; il corpo nomina il job (`{ jobId }`).
//
// ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
// La firma di un caricamento vale due ore. Un video grosso su una rete mobile può metterci di più,
// e la ripresa automatica (la pagina che riprende da sola dopo un'interruzione) deve poter
// chiedere una firma fresca. Fino alla PR 2 l'unico modo era RIAPRIRE l'intento: la riapertura
// restituiva lo stesso job con una firma nuova, ma costava un'apertura intera — 190 aperture per
// 44 job, misurate prima di questa route — con i suoi cancelli, la sua RPC, il suo `info` sullo
// Storage. Qui si fa soltanto ciò che serve: si verifica che il job sia ancora in attesa, e si
// firma di nuovo il SUO percorso.
//
// ─── COSA RISPONDE, E QUANDO NO ──────────────────────────────────────────────
// Solo se il job è `awaiting_upload` e il suo intento non è concluso. Dopo l'arrivo del file (o se
// l'intento è stato ritirato, pubblicato, sostituito) non c'è più niente da firmare: 409
// `VIDEO_GIA_CONCLUSO`, e il client guarda lo stato (`GET [id]`). Un job che non è di QUESTO
// intento è 404, come un intento di un'altra persona: gli id non si indovinano, e un 403
// confermerebbe che esistono.
//
// ─── IL CANCELLO È QUELLO DELLE ALTRE STRADE ─────────────────────────────────
// `leggiIntento` (`../../cancello`): proprietà e sede dentro la query e nel confronto, per tutti i
// verbi. Una copia della lettura qui dentro sarebbe la prossima `PATCH` scoperta.
//
// ─── IL TETTO ────────────────────────────────────────────────────────────────
// 60 richieste ogni 10 minuti per utente: una ripresa con backoff (5, 15, 30, 60 s) ne consuma
// poche, e dieci video in coda con la rete che torna a intermittenza ne consumano qualcuna di più.
// =============================================================================

const OPERAZIONE = 'video-uploads/[id]/firma:POST'

interface ParametriRotta {
  params: Promise<{ id: string }>
}

/** Gli stati dell'intento oltre i quali non c'è più niente da firmare. */
const INTENTI_CONCLUSI = ['published', 'cancelled', 'superseded']

export const POST = withRoute('video-uploads/[id]/firma:POST', async (request: NextRequest, { params }: ParametriRotta) => {
  try {
    // ── CANCELLO 1 · CHI SEI, prima del corpo.
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const rl = await rateLimit(`video-uploads-firma:${auth.user.id}`, { limit: 60, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) return rispostaTroppeRichieste(rl.retryAfterMs)

    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const b = await parseBody(request, schemaCorpoFirmaVideo)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()

    // ── CANCELLO 2 · È TUO, ED È ANCORA NELLA TUA SEDE: lo stesso di GET e PATCH.
    const letto = await leggiIntento(supabase, auth.user, p.data, OPERAZIONE)
    if (letto.response) return letto.response
    const canale = canaleDi(letto.intento.channel)

    const negata = (motivo: string) =>
      // `warn`: una firma chiesta per un job che non è nostro, o non più in attesa, è un client che sbaglia
      // o qualcuno che prova. Solo uuid e un enumerato (`tipo` sopravvive in tabella).
      logVideo(canale, 'warn', {
        operazione: OPERAZIONE,
        esito: 'firma-negata',
        tipo: motivo,
        utente: auth.user.id,
        intento: letto.intento.id,
        job: b.data.jobId,
      })

    // Un job si firma solo se è di QUESTO intento: `[id]` e `jobId` arrivano dal client, e un job proprio ma
    // di un altro intento è comunque una riga che questa richiesta non nomina.
    const job = letto.job.find((j) => j.id === b.data.jobId)
    if (!job) {
      negata('job-fuori-intento')
      return rispostaVideo('VIDEO_NON_TROVATO', 404)
    }

    // Dopo l'arrivo del file, o a intento concluso, non c'è più niente da firmare.
    if (INTENTI_CONCLUSI.includes(letto.intento.status)) {
      negata('intento-concluso')
      return rispostaVideo('VIDEO_GIA_CONCLUSO', 409)
    }
    if (job.status !== 'awaiting_upload') {
      negata('job-non-in-attesa')
      return rispostaVideo('VIDEO_GIA_CONCLUSO', 409)
    }

    const firma = await firmaTus(supabase, job.original_path)
    if (!firma.ok) {
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'storage' }, firma.errore)
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }

    // Il tipo dichiarato all'apertura (lo scrivono solo i video di Galleria con destinatari); per gli altri
    // si ricava dall'estensione del percorso, che a sua volta veniva dal tipo validato.
    const risposta: RispostaFirmaVideo = {
      jobId: job.id,
      caricamento: coordinateTus(job.original_path, job.mime_dichiarato ?? mimeDaEstensione(job.original_path)),
      firma: firma.firma,
      scadeIl: firma.scadeIl,
    }

    // IL SUCCESSO SI LOGGA: senza, «nessuna riga» non distingue «la ripresa non ha mai bisogno di
    // rinnovare» da «la ripresa non arriva». Solo uuid: mai il percorso (porta l'uuid di chi carica)
    // e mai la firma.
    logVideo(canale, 'info', {
      operazione: OPERAZIONE,
      esito: 'firma-rinnovata',
      canale,
      utente: auth.user.id,
      sede: letto.intento.scuola_id ?? undefined,
      intento: letto.intento.id,
      job: job.id,
    })

    return NextResponse.json(risposta)
  } catch (errore) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, errore)
    return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
  }
})
