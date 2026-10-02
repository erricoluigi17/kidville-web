import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logErrore } from '@/lib/logging/logger'
import { CANALI_VIDEO, type CanaleVideo } from '@/lib/media/video/contratto'

import { logVideo, pipelineAssente, rispostaPipelineAssente, rispostaVideo } from './risposte'

/**
 * IL CANCELLO APPLICATIVO DELLA PIPELINE VIDEO — chi sei, dove stai scrivendo,
 * con quale ambito. In TypeScript, in un posto solo, per TUTTI i verbi.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * I DUE CANCELLI, E DOVE PASSA IL CONFINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * · **Applicativo** (questo file): ruolo, sede, ambito. Riusa i presidi che il
 *   repository ha già — `requireDocente` nelle route, `resolveScuolaScrittura`
 *   e `scuoleDiUtente` qui — e NON esiste da nessun'altra parte. In particolare
 *   non esiste in SQL: le RPC girano a `service_role` e non sanno né chi sta
 *   chiamando né quali plessi gli appartengano. Riscrivere lì questa logica
 *   vorrebbe dire due verità che invecchiano separatamente.
 *
 * · **Transazionale** (le RPC `video_*`): un solo vincitore, revisione corrente,
 *   job pronti, target non cambiato, `fence_epoch`. Sono cose che si possono
 *   sapere SOLO sotto lock, e nessun controllo in TypeScript le può garantire:
 *   fra il `SELECT` della route e la sua scrittura c'è una finestra in cui un
 *   altro processo può aver già vinto.
 *
 * Il ponte fra i due è che la route attraversa il cancello applicativo e chiama
 * la RPC **nella stessa richiesta**; la RPC rifiuta se nel frattempo è cambiato
 * qualcosa. Nessuno dei due può fare il mestiere dell'altro.
 *
 * ⚠️ E il cancello applicativo è **uno solo**, chiamato da ogni handler. Il
 * difetto che questo file esiste per non ripetere è già costato in questo
 * repository: una copia del gate scritta dentro un handler proteggeva la `POST`
 * e lasciava scoperta la `PATCH` accanto — due strade, e su una non c'era
 * nessuno. `sedeAncoraPropria` è chiamata da un punto solo (`leggiIntento`) e
 * vale quindi per il `GET`, per tutte le azioni del `PATCH` e — dal 2026-10-02 —
 * per la `POST` che rinnova la firma (`[id]/firma`): `leggiIntento` vive QUI,
 * e non più dentro `[id]/route.ts`, proprio perché le strade che leggono
 * l'intento di una persona sono diventate tre, e una copia della lettura in una
 * delle tre sarebbe la prossima `PATCH` scoperta. (Un file di route può esportare
 * solo i metodi HTTP: una funzione condivisa fra due route sta in un modulo accanto.)
 *
 * ⚠️ CHE COSA *NON* STA QUI, e perché. La risoluzione della sede di una SCRITTURA
 * NUOVA (`resolveScuolaScrittura`) resta scritta dentro l'handler della `POST`.
 * Non è una svista ed è l'unico punto in cui questo file si ferma: quella
 * chiamata ha un solo chiamante — non c'è nessuna seconda copia da cui
 * divergere — e soprattutto `isolamento-sede-coverage.test.ts` la cerca per NOME
 * dentro il corpo dell'handler, perché una funzione `SECURITY DEFINER` non
 * riceve nessun filtro addosso. Nasconderla dietro un helper non renderebbe il
 * codice più sicuro: renderebbe cieco il lock che lo sorveglia — misurato, e non
 * dedotto: il primo giro l'ha segnalata come `rpc-senza-sede`.
 */

/** Chi può aprire un contenuto SENZA sede, cioè valido per tutti e tre i plessi. */
const RUOLI_AMBITO_GLOBALE = ['admin', 'coordinator'] as const

/** Confronto fra uuid senza distinzione di maiuscole, come fa `@/lib/auth/scope`. */
function stessaSede(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * L'AMBITO GLOBALE — l'unica sede assente ammessa, e chi può dichiararla.
 *
 * Non è un'omissione: è una dichiarazione. Lo pretende anche il database
 * (`video_intents_scuola_scope_chk` ammette `scuola_id IS NULL` solo con
 * `payload->>'scope' = 'global'`); qui si aggiunge la parte che il database non
 * può conoscere, cioè CHI può prenderla.
 *
 * ⚠️ Perché la Direzione e non chi insegna: un contenuto senza sede esce su tutti
 * e tre i plessi. È la stessa regola del broadcast della Galleria, dove la
 * comunicazione a un'intera sede è riservata ad admin e coordinatore, e nasce
 * dallo stesso rilievo: una regola di perimetro applicata dal client non è una
 * regola. V09 potrà stringerla ancora (la pubblicazione ha gate suoi), non
 * allargarla.
 *
 * Vive qui, e non nei due handler, perché il ruolo ammesso deve essere lo stesso
 * quando l'intento si APRE e quando lo si CONFERMA: due elenchi divergerebbero, e
 * il secondo è quello che decide se una cosa viene pubblicata.
 */
export function ambitoGlobaleNegato(
  user: AppUser,
  canale: CanaleVideo,
  tipo: string,
  operazione: string,
): NextResponse | null {
  if ((RUOLI_AMBITO_GLOBALE as readonly string[]).includes(user.role)) return null
  logVideo(canale, 'warn', {
    operazione,
    esito: 'ambito-globale-negato',
    tipo,
    utente: user.id,
    ruolo: user.role,
  })
  return rispostaVideo('VIDEO_NON_AUTORIZZATO', 403)
}

/**
 * LA SEDE DI UN INTENTO GIÀ APERTO È ANCORA FRA LE MIE?
 *
 * Il piano lo chiede per esteso: «pubblicazione solo pronta e già confermata, con
 * **riverifica dei permessi correnti**». I permessi si valutano quando si apre
 * l'intento, ma fra quel momento e la conferma passano minuti — e in questo
 * repository lo spostamento di sede di un membro del personale è un'operazione
 * reale (`admin/staff:PATCH`, 2026-09-04). Un'insegnante uscita da un plesso non
 * deve poter concludere né seguire un caricamento rimasto lì dentro.
 *
 * La proprietà della riga la verifica la RPC (`OWNER_MISMATCH`), e la lettura la
 * filtra già per `owner_id`: qui si verifica la SEDE, che la RPC non può
 * conoscere.
 */
export async function sedeAncoraPropria(opzioni: {
  supabase: SupabaseClient
  user: AppUser
  canale: CanaleVideo
  scuolaIdIntento: string | null
  operazione: string
}): Promise<{ response?: NextResponse }> {
  const { supabase, user, canale, scuolaIdIntento, operazione } = opzioni

  if (scuolaIdIntento === null) {
    // Ambito globale: non c'è una sede da confrontare, c'è un ruolo — ed è lo
    // stesso elenco con cui l'intento era stato aperto.
    const negato = ambitoGlobaleNegato(user, canale, 'intento-globale', operazione)
    return negato ? { response: negato } : {}
  }

  const proprie = await scuoleDiUtente(supabase, user)
  if (proprie.some((id) => stessaSede(id, scuolaIdIntento))) return {}

  // `warn` e non `info`: è un accesso negato a dati di un'altra sede, cioè un
  // segnale di sicurezza. Solo uuid, ruolo e conteggi — mai un nome.
  logVideo(canale, 'warn', {
    operazione,
    esito: 'intento-fuori-sede',
    tipo: 'sede-intento-non-accessibile',
    utente: user.id,
    ruolo: user.role,
    sede_richiesta: scuolaIdIntento,
    accessibili: proprie.length,
  })
  return { response: rispostaVideo('VIDEO_NON_AUTORIZZATO', 403) }
}

/**
 * Le colonne che servono a raccontare lo stato di un intento, e nessuna di più.
 *
 * ⚠️ MAI `tag_alunni`. Sono identificativi di minori: servono al pubblicatore (il server, quando il
 * video è pronto), non a chi legge lo stato — che dei bambini conosce il numero (`n_tag`, che
 * sopravvive alla minimizzazione) e basta.
 */
const COLONNE_INTENTO = 'id, owner_id, scuola_id, channel, revision, status, updated_at'

/**
 * Le colonne dei job.
 *
 * `attempt` c'è perché da solo — con lo stato — dice se il job si sta ritentando
 * (`riprovaAutomaticaInCorso`). Senza questa colonna PostgREST non la restituirebbe e
 * la scheda non direbbe mai «lo stiamo riprovando», senza nessun errore da nessuna
 * parte: il test legge la lista delle colonne chieste, non solo il corpo che torna.
 * `last_error_code` NON c'è, e non deve esserci: è il nome interno della causa.
 *
 * Le tre in coda (PR 2, 2026-10-02) servono alle azioni, non al corpo: `original_path` e
 * `mime_dichiarato` alla firma nuova (`[id]/firma`: il percorso del job e il tipo che l'apertura
 * aveva dichiarato), `arrivato_il` al `PATCH caricato` (un `SOURCE_CONFLICT` su un job che il
 * trigger d'arrivo ha già portato in coda vale un successo). Il corpo di GET e PATCH si costruisce
 * A MANO da `statoJob` — mai restituendo la riga — quindi chiederle non le fa uscire, e un test
 * lo tiene fermo (il percorso di un originale porta l'uuid di chi l'ha caricato).
 */
const COLONNE_JOB =
  'id, intent_id, channel, status, error_code, attempt, updated_at, created_at, original_path, mime_dichiarato, arrivato_il'

export type RigaIntento = {
  id: string
  owner_id: string
  scuola_id: string | null
  channel: string
  revision: number
  status: string
  updated_at: string
}

export type RigaJob = {
  id: string
  intent_id: string
  channel: string
  status: string
  error_code: string | null
  /** Il numero del tentativo: 0 prima della prima presa in carico, +1 a ogni `video_job_claim`. */
  attempt: number
  updated_at: string
  created_at: string
  /** Dove sta l'originale nel bucket privato: serve a firmare di nuovo, e non esce mai verso il client. */
  original_path: string
  /** Il tipo dichiarato all'apertura (solo i video di Galleria con destinatari lo scrivono). */
  mime_dichiarato: string | null
  /** Quando il file è arrivato (lo scrive il trigger d'arrivo): `null` finché non è arrivato. */
  arrivato_il: string | null
}

export type Letto =
  | { intento: RigaIntento; job: RigaJob[]; response?: undefined }
  | { intento?: undefined; job?: undefined; response: NextResponse }

/** Il canale della riga, ricondotto al vocabolario chiuso del contratto. */
export function canaleDi(valore: string): CanaleVideo {
  return (CANALI_VIDEO as readonly string[]).includes(valore) ? (valore as CanaleVideo) : 'gallery'
}

/**
 * Legge l'intento e i suoi job, applicando il cancello applicativo.
 *
 * Lo chiamano il `GET` e il `PATCH` di `[id]` e la `POST` di `[id]/firma`: tre strade, un cancello.
 *
 * ⚠️ IL FILTRO `owner_id` È DENTRO LA QUERY, non un confronto dopo. Così un
 * intento di un'altra persona risponde **404** invece di 403: gli uuid non si
 * indovinano, e un 403 direbbe a chi prova che quell'id esiste. Il 403 resta per
 * la SEDE, che è l'unico caso in cui la riga è davvero tua e il perimetro no.
 */
export async function leggiIntento(
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
