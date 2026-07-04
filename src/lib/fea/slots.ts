import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompletionPolicy, SignatureLog, SignerSlot } from './types'

/**
 * Ledger additivo degli slot firmatari (`fea_signatures`). Le colonne per-flusso
 * esistenti (pagella_ricezioni.firma, presenze.giustificazione_firma,
 * form_submissions.signature_log) restano source-of-truth del firmatario
 * primario; gli slot abilitano la firma congiunta (DL-007) senza riscrivere
 * lo storage dei consumatori.
 */

/** Valuta il completamento della firma documenti rispetto alla policy. */
export function isComplete(slots: SignerSlot[], policy: CompletionPolicy): boolean {
  if (slots.length === 0) return false
  if (policy === 'all-required') return slots.every((s) => s.stato === 'signed')
  return slots.some((s) => s.stato === 'signed')
}

export interface RecordSignerSlotInput {
  entitaTipo: string
  entitaId: string
  signerUserId: string | null
  slotIndex?: number
  completionPolicy?: CompletionPolicy
  signatureLog: SignatureLog
}

/**
 * Registra (upsert idempotente) la firma di uno slot. Best-effort: ritorna
 * `{ error }` senza lanciare, così il chiamante non blocca il flusso primario.
 */
export async function recordSignerSlot(
  supabase: SupabaseClient,
  input: RecordSignerSlotInput
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase
      .from('fea_signatures')
      .upsert(
        {
          entita_tipo: input.entitaTipo,
          entita_id: input.entitaId,
          slot_index: input.slotIndex ?? 0,
          signer_user_id: input.signerUserId,
          stato: 'signed',
          completion_policy: input.completionPolicy ?? 'any-one',
          signature_log: input.signatureLog,
          firmato_il: input.signatureLog.signed_at,
        },
        { onConflict: 'entita_tipo,entita_id,slot_index' }
      )
      .select()
      .maybeSingle()
    return { error: error ? error.message : null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'recordSignerSlot failed' }
  }
}

/** Tutti gli slot di un'entità, ordinati per slot_index. */
export async function getSlots(
  supabase: SupabaseClient,
  entitaTipo: string,
  entitaId: string
): Promise<SignerSlot[]> {
  const { data } = await supabase
    .from('fea_signatures')
    .select('*')
    .eq('entita_tipo', entitaTipo)
    .eq('entita_id', entitaId)
    .order('slot_index', { ascending: true })
  return (data as SignerSlot[] | null) ?? []
}
