import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { nomiSezioniDiUtente } from '@/lib/sezioni/docenti'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// Gate server sul TARGET di un avviso quando l'autore è un `educator`.
//
// Il buco è lato server: `requireDocente` verifica solo il RUOLO, non lo scope
// del destinatario. Senza questo gate un educator può pubblicare un avviso a
// tutto il plesso (scope 'globale') o a classi che non gli sono assegnate — la
// UI restringe, ma un POST/PUT diretto no.
//
// Regola: un educator scrive SOLO alle proprie sezioni (utenti_sezioni →
// sections.name). Staff/direzione/segreteria (admin/coordinator/segreteria) non
// sono limitati. `null` = target consentito; una NextResponse 403 = rifiutato.
// =============================================================================

export interface TargetAvviso {
  scope?: string | null
  classi?: unknown
}

export async function verificaTargetAvvisoDocente(
  supabase: SupabaseClient,
  user: AppUser,
  target: TargetAvviso,
): Promise<NextResponse | null> {
  // Solo l'educator è ristretto: gli altri ruoli docente/staff no.
  if (user.role !== 'educator') return null

  const scope = String(target.scope ?? 'globale')
  const classi = Array.isArray(target.classi)
    ? [
        ...new Set(
          (target.classi as unknown[]).filter(
            (c): c is string => typeof c === 'string' && c.trim() !== '',
          ),
        ),
      ]
    : []

  // Diniego: 403 pronto + riga `warn` (→ tabella) con SOLI metadati non
  // personali. I nomi sezione sono ammessi (chiave `sezione` in lista bianca di
  // redact, non sono dati di minori); MAI titolo/contenuto dell'avviso.
  const nega = (
    tipo: string,
    messaggio: string,
    extra: Record<string, string | number> = {},
  ): NextResponse => {
    logEvento('avvisi', 'warn', {
      operazione: 'avvisi:target-gate',
      esito: 'target-negato',
      tipo,
      ruolo: user.role,
      uid: user.id,
      n_classi: classi.length,
      ...extra,
    })
    return NextResponse.json({ error: messaggio }, { status: 403 })
  }

  // (a) scope diverso da 'classe' → niente avvisi di plesso per l'educator.
  if (scope !== 'classe') {
    return nega(
      'scope-non-classe',
      'Come docente puoi inviare avvisi solo alle tue classi, non a tutto il plesso.',
    )
  }

  // (b) 'classe' con array VUOTO: footgun reale — a valle (POST) `globale =
  // classiTarget.length === 0` lo farebbe degradare a globale.
  if (classi.length === 0) {
    return nega('classi-vuote', 'Seleziona almeno una delle tue classi.')
  }

  // (c) classi non incluse tra le proprie sezioni.
  const proprie = new Set(await nomiSezioniDiUtente(supabase, user.id))
  const estranee = classi.filter((c) => !proprie.has(c))
  if (estranee.length > 0) {
    return nega(
      'classi-non-proprie',
      'Puoi inviare avvisi solo alle classi che ti sono assegnate.',
      { sezione: estranee.join(',') },
    )
  }

  return null
}
