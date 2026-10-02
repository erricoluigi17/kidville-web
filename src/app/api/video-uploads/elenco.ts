import {
  codiceMessaggioVideo,
  codiceMostrabileDelJob,
  MAX_BAMBINI_PER_VIDEO,
  riprovaAutomaticaInCorso,
  schemaVoceVideo,
  type CodiceMostratoVideo,
  type FaseVoceVideo,
  type StatoJobVideo,
  type VoceVideo,
} from '@/lib/media/video/contratto'

/**
 * L'ELENCO DEI VIDEO DELL'INSEGNANTE — come un intento e il suo job diventano una `VoceVideo`.
 *
 * ─── PERCHÉ UN MODULO A SÉ ───────────────────────────────────────────────────────────────────
 * La traduzione «righe del database → una voce che una scheda sa leggere» è la parte che sbaglia
 * in silenzio: una fase detta male è un video «in coda» che in realtà non uscirà mai, o un
 * «Riprova» offerto quando non può funzionare. Sta in una funzione pura, senza database, così si
 * prova su una tabella di casi invece che attraverso un finto PostgREST. La route (`route.ts`,
 * `GET`) fa le due letture e ne chiama gli esiti.
 *
 * ─── LA VOCE SI COSTRUISCE A MANO, MAI DALLA RIGA ────────────────────────────────────────────
 * Le RPC esistenti restituiscono `to_jsonb(riga)`, e con le colonne della PR 2 quella riga porta
 * `tag_alunni` (identificativi di minori), l'hash del token di rinnovo e lo `sha256` dichiarato
 * (secondario #37). Qui si leggono SOLO le colonne chieste da `COLONNE_*_ELENCO`, una per una, e
 * dei bambini si conosce il numero (`n_tag`, che sopravvive alla minimizzazione). Lo schema
 * `schemaVoceVideo` rimisura il risultato: ciò che non rispetta le sue regole di coerenza non esce.
 *
 * ─── `updated_at` NON È «L'ULTIMA MODIFICA DEI DATI» (secondario #83) ────────────────────────
 * `video_intenti_minimizza` e `video_intent_oblio_alunno` svuotano `tag_alunni` senza toccare
 * `updated_at`: il campo dice quando l'intento ha cambiato STATO, non quando i suoi dati sono
 * cambiati. All'elenco basta così — ordina e mostra «aggiornato il …» per gli stati — ma niente
 * deve dedurne che i bambini siano gli stessi di prima: per questo `nBambini` viene da `n_tag` e
 * mai da `tag_alunni`, e questo modulo non legge quella colonna nemmeno per sbaglio.
 */

/**
 * Le colonne dell'intento che l'elenco chiede. ⚠️ MAI `tag_alunni`.
 *
 * Il filtro di proprietà e di sede sta nella query (`owner_id`, `scuola_id`), non nella colonna.
 */
export const COLONNE_INTENTO_ELENCO =
  'id, scuola_id, channel, status, created_at, updated_at, target_id, pubblicazione_automatica, broadcast, n_tag, trasporto, pubblicazione_errore, minimizzato_il'

/** Le colonne del job che l'elenco chiede. Né l'hash del token né lo `sha256`, né il percorso dell'originale. */
export const COLONNE_JOB_ELENCO =
  'id, intent_id, status, error_code, attempt, created_at, updated_at, byte_dichiarati, durata_dichiarata_s, verified_at, output_path, output_deleted_at, output_delete_after'

/** Gli stati dell'intento che non sono ancora arrivati alla fine: sempre in elenco, qualunque sia la loro età. */
export const STATI_INTENTO_NON_TERMINALI = ['pending', 'confirmed', 'action_required'] as const

/** Quanto resta in elenco un intento concluso: sette giorni. È anche la finestra in cui un «Riprova» è ancora possibile. */
export const GIORNI_ELENCO_CONCLUSI = 7
const MS_GIORNO = 24 * 60 * 60 * 1000

export type IntentoElenco = {
  id: string
  scuola_id: string | null
  channel: string
  status: string
  created_at: string
  updated_at: string
  target_id: string | null
  pubblicazione_automatica: boolean
  broadcast: boolean
  n_tag: number
  trasporto: string
  pubblicazione_errore: string | null
  minimizzato_il: string | null
}

export type JobElenco = {
  id: string
  intent_id: string
  status: string
  error_code: string | null
  attempt: number | null
  created_at: string
  updated_at: string
  byte_dichiarati: number | null
  durata_dichiarata_s: number | string | null
  verified_at: string | null
  output_path: string | null
  output_deleted_at: string | null
  output_delete_after: string | null
}

/** Il video è ancora in lavorazione o in attesa del server? Serve al polling, che si ferma quando non c'è più nulla di attivo. */
export const FASI_ATTIVE: readonly FaseVoceVideo[] = ['da-caricare', 'in-coda', 'in-conversione', 'in-riprova', 'pronto']

type FaseECodice = { fase: FaseVoceVideo; codice: CodiceMostratoVideo | null }

/**
 * LA FASE di un intento e del suo job.
 *
 * L'ordine delle regole è la decisione, e va letto dall'alto:
 *
 *  1. **`published`** è `pubblicato`, di qualunque flusso: una pubblicazione avvenuta resta tale.
 *  2. **Il flusso vecchio** (`pubblicazione_automatica` falso e non pubblicato) è `da-ricaricare`: dopo
 *     il rilascio nessun server pubblica da solo un intento che non ha i suoi bambini, quindi
 *     «in coda» o «pronto» sarebbero una bugia, e la sola cosa vera da dire è «va ricaricato». Vale
 *     anche per i non ancora revocati (un invio in volo al rilascio, i convertiti mai pubblicati):
 *     la purga li revoca al primo giro, e fino ad allora la scheda dice già la cosa giusta.
 *     `superseded` fa eccezione: è stato sostituito da un altro intento, ed è semplicemente `annullato`.
 *  3. **`cancelled`/`superseded`** è `annullato`: l'ha chiesto qualcuno, non si notifica e non ha un codice.
 *  4. **`action_required`** è `non-pubblicato`: il video è pronto e la pubblicazione NON è riuscita in modo
 *     definitivo (nessun bambino rimasto nella sede, oppure il guasto dopo 60 minuti). Il codice è quello
 *     della causa (`pubblicazione_errore`, SOLO un codice), tradotto in ciò che una persona legge.
 *  5. **Il resto** (`pending`, `confirmed`) dipende dal job: l'intento è vivo e il job dice a che punto è.
 *
 * Un job in uno stato che il contratto non conosce non ha una fase: `null`, e la route scarta la voce
 * con un log `error` invece di inventare una scheda.
 */
export function faseDi(intento: IntentoElenco, job: JobElenco): FaseECodice | null {
  if (intento.status === 'published') return { fase: 'pubblicato', codice: null }

  if (!intento.pubblicazione_automatica) {
    if (intento.status === 'superseded') return { fase: 'annullato', codice: null }
    return { fase: 'da-ricaricare', codice: null }
  }

  if (intento.status === 'cancelled' || intento.status === 'superseded') return { fase: 'annullato', codice: null }

  if (intento.status === 'action_required') {
    return { fase: 'non-pubblicato', codice: codiceMessaggioVideo(intento.pubblicazione_errore) }
  }

  const stato = job.status as StatoJobVideo
  switch (stato) {
    case 'awaiting_upload':
      return { fase: 'da-caricare', codice: null }
    case 'queued':
    case 'processing': {
      // `riprovaAutomaticaInCorso` è la funzione del contratto, non una copia: la stessa che dice «lo
      // stiamo riprovando» nello stato di `[id]`. Un guasto NOSTRO non è ancora un errore, è un'attesa.
      if (riprovaAutomaticaInCorso(stato, job.attempt)) return { fase: 'in-riprova', codice: null }
      return { fase: stato === 'queued' ? 'in-coda' : 'in-conversione', codice: null }
    }
    case 'ready':
      return { fase: 'pronto', codice: null }
    case 'failed':
    case 'rejected':
      // La regola del secondario #37: un job ritentato ed esaurito legge sempre «problema nostro».
      return { fase: 'fallito', codice: codiceMostrabileDelJob(job) ?? codiceMessaggioVideo(job.error_code) }
    case 'cancelled':
      return { fase: 'annullato', codice: null }
    default:
      return null
  }
}

/**
 * IL «RIPROVA» È POSSIBILE? — la stessa risposta che darebbe `video_intent_pubblicazione_riprova`.
 *
 * Si offre il pulsante solo se la RPC, premuto, direbbe di sì: un «Riprova» che risponde 409 è un
 * pulsante che mente. Le condizioni sono le sue, una per una: intento automatico in `action_required`
 * e non minimizzato (senza i bambini non si saprebbe a chi pubblicare), job `ready` verificato, uscita
 * ancora presente, e tutto entro i sette giorni dalla verifica (la scadenza dell'uscita non ancora passata).
 *
 * In più una condizione che la RPC non ha e che è del senso comune: **se la causa è `NESSUN_DESTINATARIO`
 * non si offre**. Nessuno dei bambini scelti è più nella sede: ripubblicare produrrebbe lo stesso
 * rifiuto, e il testo della notifica per questo caso (spec §7) non parla di «Riprova».
 */
export function riprovaPossibile(intento: IntentoElenco, job: JobElenco, adesso: number): boolean {
  if (!intento.pubblicazione_automatica || intento.status !== 'action_required') return false
  if (intento.minimizzato_il !== null) return false
  if (intento.pubblicazione_errore === 'NESSUN_DESTINATARIO') return false
  if (job.status !== 'ready' || job.verified_at === null) return false
  if (job.output_path === null || job.output_deleted_at !== null) return false
  const verificato = Date.parse(job.verified_at)
  if (!Number.isFinite(verificato) || verificato <= adesso - GIORNI_ELENCO_CONCLUSI * MS_GIORNO) return false
  if (job.output_delete_after !== null) {
    const scadenza = Date.parse(job.output_delete_after)
    if (!Number.isFinite(scadenza) || scadenza <= adesso) return false
  }
  return true
}

/** La durata dichiarata, solo se è un numero che il contratto accetta; altrimenti `null` (la misura vera la fa il probe). */
function durataDichiarata(valore: number | string | null): number | null {
  if (valore === null) return null
  const n = typeof valore === 'string' ? Number(valore) : valore
  return Number.isFinite(n) && n > 0 && n <= 300 ? n : null
}

function isoOppureNull(valore: string): string | null {
  const t = Date.parse(valore)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

export type EsitoVoce = { ok: true; voce: VoceVideo } | { ok: false; motivo: 'fase-sconosciuta' | 'fuori-contratto'; percorsi?: string[] }

/**
 * Una voce dell'elenco, a partire dall'intento e dal suo job.
 *
 * `adesso` è un parametro per la stessa ragione di ogni altra funzione che guarda l'orologio: il test
 * lo fissa, e non deve congelare il tempo del processo.
 */
export function costruisciVoce(intento: IntentoElenco, job: JobElenco, adesso: number = Date.now()): EsitoVoce {
  const decisa = faseDi(intento, job)
  if (!decisa) return { ok: false, motivo: 'fase-sconosciuta' }

  const creatoIl = isoOppureNull(intento.created_at)
  const aggiornatoIntento = Date.parse(intento.updated_at)
  const aggiornatoJob = Date.parse(job.updated_at)
  const ultimo = Math.max(Number.isFinite(aggiornatoIntento) ? aggiornatoIntento : 0, Number.isFinite(aggiornatoJob) ? aggiornatoJob : 0)

  const candidata = {
    intentId: intento.id,
    jobId: job.id,
    fase: decisa.fase,
    codice: decisa.codice,
    creatoIl,
    aggiornatoIl: ultimo > 0 ? new Date(ultimo).toISOString() : null,
    trasporto: intento.trasporto,
    byte: job.byte_dichiarati ?? null,
    durataS: durataDichiarata(job.durata_dichiarata_s),
    // Il NUMERO scelto, mai l'elenco: `n_tag` sopravvive alla minimizzazione, `tag_alunni` no. Un broadcast non ha bambini.
    nBambini: intento.broadcast ? 0 : Math.min(Math.max(0, Math.trunc(Number(intento.n_tag) || 0)), MAX_BAMBINI_PER_VIDEO),
    broadcast: intento.broadcast,
    mediaId: decisa.fase === 'pubblicato' ? intento.target_id : null,
    pubblicazioneAutomatica: intento.pubblicazione_automatica,
    riprovaPossibile: decisa.fase === 'non-pubblicato' && riprovaPossibile(intento, job, adesso),
  }

  const letta = schemaVoceVideo.safeParse(candidata)
  if (!letta.success) {
    // Solo i PERCORSI dei campi che non tornano, mai i valori: un valore potrebbe essere un identificativo.
    return { ok: false, motivo: 'fuori-contratto', percorsi: [...new Set(letta.error.issues.map((i) => i.path.join('.')))] }
  }
  return { ok: true, voce: letta.data }
}
