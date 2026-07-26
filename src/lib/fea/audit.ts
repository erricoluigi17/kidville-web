import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// Audit immutabile degli eventi di firma FEA (DL-009).
//
// Tabella dedicata `fea_audit_log` (NON audit_scritture_docente, che è
// staff-scoped con enum azione/diff incompatibile con la firma genitore).
// Raccoglie l'evidenza FES (CAD Art. 20 / DPR 445/2000) di tutti i flussi di
// firma. Best-effort: non lancia mai, per non compromettere il flusso primario.
// =============================================================================

export type FeaEvento = 'otp_sent' | 'signed' | 'verify_failed'

export interface LogFeaEventInput {
  entitaTipo: string
  entitaId?: string | null
  signerUserId?: string | null
  email?: string | null
  evento: FeaEvento
  hash?: string | null
  ip?: string | null
  userAgent?: string | null
}

export async function logFeaEvent(supabase: SupabaseClient, input: LogFeaEventInput): Promise<void> {
  try {
    // PostgREST NON lancia: senza il controllo su `{ error }` la perdita
    // dell'evidenza di firma restava invisibile. Questa tabella è la prova
    // giuridica del consenso (CAD Art. 20): un buco qui va saputo subito.
    const res = await supabase.from('fea_audit_log').insert({
      entita_tipo: input.entitaTipo,
      entita_id: input.entitaId ?? null,
      signer_user_id: input.signerUserId ?? null,
      email: input.email ?? null,
      evento: input.evento,
      hash: input.hash ?? null,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
    })
    if (res?.error) segnalaFeaAuditFallito(input, res.error)
  } catch (err) {
    segnalaFeaAuditFallito(input, err)
  }
}

/**
 * A log solo i metadati dell'evidenza: tipo di evento e tipo di entità firmata.
 * Restano fuori `email` e `hash` della firma (il primo è un dato personale, il
 * secondo è fra le radici segrete della redazione) e ip/user-agent.
 */
function segnalaFeaAuditFallito(input: LogFeaEventInput, err: unknown): void {
  logEvento(
    'fea',
    'error',
    {
      operazione: 'logFeaEvent',
      tipo_evento: input.evento,
      entita_tipo: input.entitaTipo,
      esito: 'audit-non-registrato',
    },
    err,
  )
}
