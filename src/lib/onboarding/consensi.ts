// P4/DL-045 — Onboarding genitore: consensi GDPR obbligatori al primo accesso.
// C5 — aggiunto il consenso ai Termini di servizio (art. 1341 c.c.) e la guardia
// server-side che ne impedisce l'aggiramento prima di produrre UGC (chat).

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAssente } from '@/lib/news/schema-assente'
import { logEvento } from '@/lib/logging/logger'

/** Consensi che il genitore DEVE accettare per completare l'onboarding. */
export const CONSENSI_RICHIESTI = ['privacy', 'termini'] as const

/** Ritorna i consensi richiesti NON accettati (true = accettato). */
export function consensiMancanti(
  accepted: Record<string, boolean> | null | undefined,
  required: readonly string[],
): string[] {
  const a = accepted ?? {}
  return required.filter((k) => a[k] !== true)
}

function negatoTermini(): NextResponse {
  return NextResponse.json(
    {
      error: 'Per continuare devi accettare i Termini di servizio.',
      motivo: 'termini_non_accettati',
    },
    { status: 403 },
  )
}

/**
 * Gate Termini server-side (C5). 403 (motivo `termini_non_accettati`) se un
 * GENITORE non ha `consensi_gdpr.termini === true`; altrimenti `null`.
 *
 * TRASPARENTE PER LO STAFF: se il ruolo non è `genitore` ritorna `null` senza
 * nemmeno interrogare il DB — la chat è l'unica UGC che un genitore produce, e il
 * docente scrive solo alla propria sezione (gate a monte). Stesso principio del
 * guard morosità, che «su un docente è trasparente».
 *
 * DEGRADAZIONE: sul DB E2E non migrato la colonna/tabella può non esserci →
 * PostgREST ritorna `{ error }` (42703/PGRST205) e si degrada a `null` (non blocca).
 * PostgREST NON lancia: si controlla il valore di ritorno.
 *
 * Per un genitore, `senderId` (l'id applicativo dal gate, vedi `requireUser` /
 * `resolveAppIdFromAuthUid`) è l'id della riga `utenti` con `ruolo='genitore'`
 * — NON `parents.id`, che è una riga di anagrafica separata. Il ponte è
 * `parents.auth_user_id = senderId` (stesso pattern di `src/app/api/me/route.ts`
 * e di `getFigliDiGenitore`/`accountGenitoriDiAlunni` in `pagamenti/sospensione.ts`).
 * Verificato in produzione: 0 righe `parents` hanno `id` uguale a un `utenti.id`
 * di ruolo genitore — un `.eq('id', senderId)` qui non troverebbe MAI la riga
 * giusta e bloccherebbe ogni genitore, sempre. (`parent/onboarding` e
 * `parent/account/richiesta-cancellazione` avevano lo stesso refuso: corretto
 * insieme a questo file.)
 */
export async function assertTerminiAccettatiSeGenitore(
  supabase: SupabaseClient,
  senderId: string,
  role: string | null | undefined,
): Promise<NextResponse | null> {
  if (role !== 'genitore') return null

  const { data, error } = await supabase
    .from('parents')
    .select('consensi_gdpr')
    .eq('auth_user_id', senderId)
    .maybeSingle()

  if (error) {
    // Colonna/tabella assente (DB E2E non migrato): non si blocca la chat.
    if (schemaAssente(error)) return null
    // Errore vero di lettura: fail-open (non si blocca la chat su un guasto), ma
    // loggato — solo uuid (senderId), mai PII. PostgREST non lancia → { error }.
    logEvento(
      'chat',
      'error',
      { operazione: 'assertTerminiAccettatiSeGenitore', esito: 'lettura-parents-fallita', senderId },
      error,
    )
    return null
  }

  const consensi = ((data as { consensi_gdpr?: Record<string, unknown> } | null)?.consensi_gdpr ??
    {}) as Record<string, unknown>
  return consensi.termini === true ? null : negatoTermini()
}
