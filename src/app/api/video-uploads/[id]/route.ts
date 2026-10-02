import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireDocente } from '@/lib/auth/require-staff'
import { logErrore } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import {
  avanzamentoDaStatoVideo,
  codiceMostrabileDelJob,
  riprovaAutomaticaInCorso,
  schemaAzioneRiprovaPubblicazioneVideo,
  schemaStatoJobVideo,
  type CanaleVideo,
  type StatoJobVideo,
  type StatoJobVideoLetto,
} from '@/lib/media/video/contratto'
import { MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

import { canaleDi, leggiIntento, type RigaIntento, type RigaJob } from '../cancello'
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
// azione vorrebbe dire pubblicare aggirandoli. Dal 2026-10-02 per la Galleria la
// fa il SERVER, da solo, appena la conversione finisce (`video_galleria_pubblica`,
// consumata dal runner); per le News resta all'editor (V09). Nessuna azione di
// questa route pubblica: l'unica che riguarda la pubblicazione, `riprova-pubblicazione`,
// la RIMETTE IN MOTO — e solo se l'autore la chiede e la RPC conferma che si può.
//
// ─── DOVE STA LA LETTURA DELL'INTENTO ────────────────────────────────────────
// In `../cancello`: `leggiIntento` (proprietà + sede) la usano anche `[id]/firma` e il
// cancello è uno solo. Un file di route non può esportare altro che i metodi HTTP.
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
 * è fra questi, e il test lo verifica: la sua assenza è una decisione. E non c'è
 * un'azione `destinatari`: i bambini si scelgono all'apertura e non si cambiano
 * dopo (cambiarli a video in volo vorrebbe dire pubblicare per qualcuno che
 * l'insegnante non ha scelto, o non pubblicare per chi sì).
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
  /**
   * Il «Riprova» di una pubblicazione fallita in modo definitivo (decisione del titolare, 02/10):
   * solo l'autore, solo se il video è ancora pronto e l'uscita c'è. Lo schema è quello del contratto.
   */
  schemaAzioneRiprovaPubblicazioneVideo,
])

/**
 * Lo stato di un job come lo legge il client.
 *
 * ⚠️ IL CODICE CHE ESCE È QUELLO MOSTRABILE. `OUTPUT_DURATION_MISMATCH` è il
 * verdetto di `verifyVideoOutput` e `LEASE_EXPIRED` racconta com'è fatto il
 * worker: mostrarli a un genitore vorrebbe dire mettergli davanti l'architettura.
 * E il codice esce SOLO se il job è fallito — una barra piena su un fallimento è
 * una bugia, un codice d'errore su un job vivo è un allarme falso. Lo pretende
 * anche `schemaStatoJobVideo`, che qui riverifica il risultato invece di fidarsi.
 *
 * Il codice lo decide `codiceMostrabileDelJob` del contratto (secondario #28, regola #37), la
 * STESSA funzione che usano l'elenco e le notifiche: un job `failed` che si è ritentato
 * (`attempt > 1`) è un guasto NOSTRO esaurito, e legge «problema nostro» qualunque fosse il
 * codice tecnico dell'ultimo giro — prima di questa regola «il file sembra rovinato» veniva
 * detto a chi aveva un telefono sano. Vale per Galleria e News: una copia della regola in questa
 * route mostrerebbe, al rientro di una News, un messaggio diverso da quello dell'elenco.
 *
 * `riprovaAutomatica` è la metà «non ancora un errore» della stessa regola: il job che
 * il runner ha rimesso in coda dopo un guasto nostro, o che sta girando un ritentativo,
 * dice «lo stiamo riprovando» invece di sembrare una coda ferma. Lo calcola
 * `riprovaAutomaticaInCorso` — la stessa funzione che il contratto esporta, non una
 * copia — e il codice della causa non esce: la persona legge solo che il problema è
 * nostro. Un job non in coda e non in lavorazione non lo porta mai.
 */
function statoJob(riga: RigaJob, intentId: string): StatoJobVideoLetto | null {
  const stato = riga.status as StatoJobVideo
  const letto = {
    jobId: riga.id,
    intentId,
    canale: canaleDi(riga.channel),
    stato,
    avanzamento: avanzamentoDaStatoVideo(stato) ?? null,
    codice: codiceMostrabileDelJob(riga),
    riprovaAutomatica: riprovaAutomaticaInCorso(stato, riga.attempt),
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
    const { rpc, argomenti, dopo } = chiamata(azione, p.data, auth.user.id)
    const { data: esito, error: erroreRpc } = await supabase.rpc(rpc, argomenti)
    if (erroreRpc) {
      if (pipelineAssente(erroreRpc)) {
        return rispostaPipelineAssente(OPERAZIONE_PATCH, rpc, erroreRpc)
      }
      logErrore({ operazione: OPERAZIONE_PATCH, stato: 500, evento: 'rpc' }, erroreRpc)
      return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
    }

    const risposta = (esito ?? {}) as { ok?: unknown; code?: unknown; motivo?: unknown }
    let arrivoGiaRegistrato = false
    if (risposta.ok !== true) {
      // ── `SOURCE_CONFLICT` DOPO IL TRIGGER D'ARRIVO È UN SUCCESSO (secondario #69). Il trigger che
      //    vede il file arrivare porta il job in coda scrivendo il tipo che ha letto dallo Storage
      //    (o quello dichiarato all'apertura); il `caricato` del web, che arriva dopo, porta il
      //    `mime` del suo `File` — spesso con il suffisso dei codec, e comunque non lo stesso
      //    carattere per carattere — e la RPC lo rifiuta come «sorgente diversa» su un job che è già
      //    in coda. Ma il file C'È, e il server lo sa già da sé (`arrivato_il`): dirgli di riprovare
      //    manderebbe il client a ripetere un'azione che non può avere un altro esito. Si rilegge lo
      //    stato (la RPC non lo restituisce) e, se l'arrivo è registrato, si risponde come per
      //    un `caricato` riuscito. Un `SOURCE_CONFLICT` SENZA arrivo registrato resta un conflitto vero.
      if (azione.azione === 'caricato' && risposta.code === 'SOURCE_CONFLICT') {
        const attuale = await leggiIntento(supabase, auth.user, p.data, OPERAZIONE_PATCH)
        if (attuale.response) return attuale.response
        arrivoGiaRegistrato = attuale.job.some((j) => j.id === azione.jobId && j.arrivato_il !== null)
      }
      if (!arrivoGiaRegistrato) {
        return rispostaEsitoRpc(canale, OPERAZIONE_PATCH, rpc, typeof risposta.code === 'string' ? risposta.code : null, {
          utente: auth.user.id,
          azione: azione.azione,
          // Il motivo di un «Riprova» negato (un enumerato della RPC): serve a capire perché, e la RPC lo scrive anche in `app_log`.
          motivo: typeof risposta.motivo === 'string' ? risposta.motivo : undefined,
        })
      }
    }

    // ── IL CALCIO AL RUNNER. Dopo un `caricato` il job è in coda: si chiama subito il runner invece
    //    di aspettare il cron (e il trigger d'arrivo, che l'ha già fatto, è la strada principale —
    //    questa è la rete: idempotente, il runner risponde `gia-sorvegliato` se c'è già chi lavora).
    //    NON fa mai fallire la risposta: un calcio perso non deve costare un arrivo, il cron ogni
    //    cinque minuti è la rete della rete — e il motivo, se c'è, finisce in un log.
    const runner = dopo ? await calciaRunner(supabase, dopo, canale, azione.azione === 'caricato' ? azione.jobId : null) : undefined

    // IL SUCCESSO SI LOGGA: una conferma è l'istante in cui l'utente si impegna,
    // e un annullo è l'istante in cui qualcosa smette di esistere. Con i soli
    // errori, «nessuna riga» direbbe insieme «non succede mai» e «non funziona».
    // Il «Riprova» ha il suo esito: è l'istante in cui una pubblicazione fallita viene rimessa in moto.
    logVideo(canale, 'info', {
      operazione: OPERAZIONE_PATCH,
      esito: azione.azione === 'riprova-pubblicazione' ? 'pubblicazione-riprovata' : 'azione-eseguita',
      azione: azione.azione,
      canale,
      utente: auth.user.id,
      sede: prima.intento.scuola_id ?? undefined,
      intento: prima.intento.id,
      tipo: arrivoGiaRegistrato ? 'arrivo-gia-registrato' : undefined,
      runner,
    })

    // Si rilegge: dopo `annulla` metà dei job cambia stato, e restituire ciò che
    // si era letto PRIMA manderebbe il client a mostrare una schermata già falsa.
    const rilettura = await leggiIntento(supabase, auth.user, p.data, OPERAZIONE_PATCH)
    if (rilettura.response) return rilettura.response
    return corpoStato(rilettura.intento, rilettura.job, OPERAZIONE_PATCH)
  } catch (errore) {
    logErrore({ operazione: OPERAZIONE_PATCH, stato: 500 }, errore)
    return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 500)
  }
})

type ChiamataRpc = { rpc: string; argomenti: Record<string, unknown> }

/**
 * Da un'azione validata alla RPC che la esegue, e a quella che — se serve — va chiamata DOPO.
 *
 * Una funzione e non cinque rami dentro l'handler: il `switch` è esaustivo su
 * un'unione chiusa, quindi aggiungere un'azione domani senza dire quale RPC la
 * esegue non compila.
 *
 * `dopo` è il calcio al runner, e solo per `caricato`: ha la stessa forma della RPC principale
 * apposta, perché passa dallo stesso cancello (la lettura dell'intento con proprietà e sede viene
 * PRIMA di entrambe) e dal solo punto in cui l'handler chiama una RPC per nome variabile. Non è
 * un modo di nascondere una chiamata al lock dell'isolamento fra sedi: è che `video_runner_kick`
 * prende un job già verificato e non ha un parametro di sede da passare.
 *
 * ⚠️ Vive FUORI dagli handler anche per una ragione di forma: un file di route in
 * App Router può esportare i soli metodi HTTP e le costanti di segmento, quindi
 * qui dentro le funzioni d'appoggio restano private al modulo.
 */
function chiamata(
  azione: z.infer<typeof schemaAzioneVideo>,
  intentId: string,
  ownerId: string,
): ChiamataRpc & { dopo?: ChiamataRpc } {
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
        dopo: { rpc: 'video_runner_kick', argomenti: { p_job_id: azione.jobId } },
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
    case 'riprova-pubblicazione':
      return {
        rpc: 'video_intent_pubblicazione_riprova',
        argomenti: { p_intent_id: intentId, p_owner_id: ownerId },
      }
  }
}

/**
 * Il calcio al runner (`video_runner_kick`), a prova di errore: non solleva mai e non fa mai fallire
 * la richiesta che l'ha chiamato. Restituisce una parola per il log di successo: `calciato`,
 * `non-inviato` (la RPC dice che `pg_net` non c'è: la riga la scrive già lei) o `fallito`.
 *
 * Un fallimento è un LOG, non una risposta — e il livello dipende da che cosa è mancato: l'URL del
 * runner assente o la POST non accodata sono guasti (`error`: configurazione mancante non è mai
 * `info`), mentre il resto — una RPC che non risponde, un'eccezione — è un calcio perso che il cron
 * recupera (`warn`). Solo uuid del job e codici: mai un nome di file.
 */
async function calciaRunner(
  supabase: SupabaseClient,
  chiamataRunner: ChiamataRpc,
  canale: CanaleVideo,
  jobId: string | null,
): Promise<'calciato' | 'non-inviato' | 'fallito'> {
  try {
    const { data, error } = await supabase.rpc(chiamataRunner.rpc, chiamataRunner.argomenti)
    if (error) {
      logVideo(canale, 'warn', {
        operazione: OPERAZIONE_PATCH,
        esito: 'calcio-runner-non-riuscito',
        error_code: (error as { code?: string }).code ?? 'SENZA_CODICE',
        job: jobId ?? undefined,
      })
      return 'fallito'
    }
    const esito = (data ?? {}) as { ok?: unknown; code?: unknown; inviato?: unknown }
    if (esito.ok !== true) {
      const codice = typeof esito.code === 'string' ? esito.code : 'SENZA_CODICE'
      logVideo(canale, codice === 'URL_ASSENTE' || codice === 'POST_FALLITO' ? 'error' : 'warn', {
        operazione: OPERAZIONE_PATCH,
        esito: 'calcio-runner-non-riuscito',
        error_code: codice,
        job: jobId ?? undefined,
      })
      return 'fallito'
    }
    return esito.inviato === false ? 'non-inviato' : 'calciato'
  } catch (errore) {
    // Una rete che cade fra noi e Supabase: il job è già in coda e il cron lo ripesca. Si dice, non si lancia:
    // una riga aggregabile (`esito`) e quella con lo stack.
    logVideo(canale, 'warn', {
      operazione: OPERAZIONE_PATCH,
      esito: 'calcio-runner-non-riuscito',
      error_code: 'ECCEZIONE',
      job: jobId ?? undefined,
    })
    logErrore({ operazione: OPERAZIONE_PATCH, evento: 'rpc' }, errore)
    return 'fallito'
  }
}
