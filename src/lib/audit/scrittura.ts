import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { logEvento } from '@/lib/logging/logger'
import { riduciValoreAudit } from './riassunto'

// =============================================================================
// Audit delle scritture sulle funzioni docente (diff prima/dopo).
//
// Ogni scrittura (docente o segreteria/direzione) registra autore, plesso,
// classe, entità, azione e il valore PRIMA/DOPO in `audit_scritture_docente`.
// È un log immodificabile (RLS: solo INSERT/SELECT). L'enforcement resta
// applicativo (client service-role), come nel resto della codebase.
//
// Best-effort: un errore di audit NON deve mai far fallire la scrittura
// principale → tutto incapsulato in try/catch silenzioso.
// =============================================================================

export type AzioneScrittura = 'insert' | 'update' | 'delete'

/** `audit_scritture_docente.entita_id` è una colonna **uuid**. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Alcune entità sono RELAZIONI e un uuid proprio non ce l'hanno: il legame
 * genitore↔figlio, l'assegnazione docente↔sezione. Sei punti della codebase
 * passavano una chiave composta (`"studentId:parentId"`), Postgres rifiutava
 * l'INSERT — e l'audit non veniva scritto **affatto**. Per quelle entità non è
 * mai esistita una riga di audit: su dati di minori, la tracciabilità di chi ha
 * collegato chi a chi non è un dettaglio.
 *
 * I chiamanti ora passano l'uuid primario, ma la rete resta: una chiave non-uuid
 * non fa più perdere la riga. Finisce nel valore — dove è comunque interrogabile —
 * e si vede nei log, invece di sparire.
 */
function normalizzaEntita(input: LogScritturaInput): {
  entitaId: string | null
  valorePrima: unknown
  valoreDopo: unknown
  chiaveNonUuid: string | null
} {
  const grezzo = input.entitaId ?? null
  if (grezzo === null || UUID.test(grezzo)) {
    return {
      entitaId: grezzo,
      valorePrima: input.valorePrima ?? null,
      valoreDopo: input.valoreDopo ?? null,
      chiaveNonUuid: null,
    }
  }
  const arricchisci = (v: unknown): unknown =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? { ...(v as Record<string, unknown>), entita_chiave: grezzo }
      : v
  const prima = input.valorePrima ?? null
  const dopo = input.valoreDopo ?? null
  // Se non c'è nessun valore in cui infilarla, la chiave si porta da sola.
  if (prima === null && dopo === null) {
    return { entitaId: null, valorePrima: null, valoreDopo: { entita_chiave: grezzo }, chiaveNonUuid: grezzo }
  }
  return {
    entitaId: null,
    valorePrima: arricchisci(prima),
    valoreDopo: arricchisci(dopo),
    chiaveNonUuid: grezzo,
  }
}

export interface LogScritturaInput {
  /** Chi sta scrivendo (da requireDocente: auth.user). */
  attore: AppUser
  /** Tipo entità: 'presenze' | 'registro' | 'valutazione' | 'nota' | 'scrutinio' | 'fascicolo' | 'diario' | 'armadietto' | 'task' | 'avviso' ... */
  entitaTipo: string
  entitaId?: string | null
  azione: AzioneScrittura
  scuolaId?: string | null
  sectionId?: string | null
  /** Stato precedente (null per insert). */
  valorePrima?: unknown
  /** Stato successivo (null per delete). */
  valoreDopo?: unknown
}

/**
 * Registra una scrittura nell'audit. Non lancia mai: in caso di errore logga e
 * prosegue, così l'operazione utente non viene compromessa.
 */
export async function logScrittura(
  supabase: SupabaseClient,
  input: LogScritturaInput,
): Promise<void> {
  // NB: il diff `valore_prima`/`valore_dopo` NON va mai a log — è il dato applicativo
  // (voti, note, diario). A log ci vanno solo i metadati: chi/cosa/che azione.
  try {
    // PostgREST NON lancia: ritorna `{ error }`. Il solo try/catch qui non
    // scattava mai, quindi un audit rifiutato (RLS, colonna mancante, vincolo)
    // spariva in silenzio — e questo è il registro immodificabile delle
    // scritture: se tace, non si distingue "nessuna scrittura" da "audit rotto".
    const n = normalizzaEntita(input)
    if (n.chiaveNonUuid !== null) {
      // Non è un errore fatale (la riga si scrive lo stesso), ma non è nemmeno
      // normale: significa che un chiamante non ha un uuid da dare. Va visto.
      logEvento('audit', 'warn', {
        operazione: 'logScrittura',
        entita_tipo: input.entitaTipo,
        azione: input.azione,
        esito: 'chiave-non-uuid',
      })
    }
    const res = await supabase.from('audit_scritture_docente').insert({
      attore_id: input.attore.id,
      attore_ruolo: input.attore.role ?? null,
      scuola_id: input.scuolaId ?? input.attore.scuola_id ?? null,
      section_id: input.sectionId ?? null,
      entita_tipo: input.entitaTipo,
      entita_id: n.entitaId,
      azione: input.azione,
      // La riduzione è QUI, nel punto di scrittura, non nei 147 chiamanti: una
      // regola che dipende dalla disciplina di chi la adotta è una regola che
      // fra sei mesi vale per metà del codice.
      valore_prima: riduciValoreAudit(n.valorePrima) as never,
      valore_dopo: riduciValoreAudit(n.valoreDopo) as never,
    })
    if (res?.error) {
      logEvento(
        'audit',
        'error',
        {
          operazione: 'logScrittura',
          entita_tipo: input.entitaTipo,
          azione: input.azione,
          esito: 'audit-non-registrato',
        },
        res.error,
      )
    }
  } catch (err) {
    logEvento(
      'audit',
      'error',
      {
        operazione: 'logScrittura',
        entita_tipo: input.entitaTipo,
        azione: input.azione,
        esito: 'audit-non-registrato',
      },
      err,
    )
  }
}
