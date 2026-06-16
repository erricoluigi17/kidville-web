import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from './require-staff'

export type Grado = 'nido' | 'infanzia' | 'primaria'

/**
 * Gating funzioni Scuola Primaria/Infanzia.
 *
 * Modello (decisione di prodotto):
 * - Ogni docente ha un campo esplicito `utenti.gradi` (multi-valore): un docente
 *   può essere misto (es. infanzia + primaria).
 * - `admin_settings.funzioni_matrice` mappa grado→funzioni abilitate (preset+override),
 *   per scuola. Es: { "primaria": { "registro": true, ... }, "infanzia": { ... } }.
 *
 * Enforcement APPLICATIVO (RLS non attiva, auth app-level — vedi require-staff).
 */

export interface GradoContext {
  userId: string
  gradi: Grado[]
  scuolaId: string | null
  matrice: Record<string, Record<string, boolean>>
}

/** Carica i gradi del docente + la matrice funzioni della sua scuola. */
export async function loadGradoContext(userId: string): Promise<GradoContext | null> {
  const supabase = await createAdminClient()
  const { data: u, error } = await supabase
    .from('utenti')
    .select('id, gradi, scuola_id')
    .eq('id', userId)
    .single()
  if (error || !u) return null

  let matrice: Record<string, Record<string, boolean>> = {}
  if (u.scuola_id) {
    const { data: s } = await supabase
      .from('admin_settings')
      .select('funzioni_matrice')
      .eq('scuola_id', u.scuola_id)
      .single()
    matrice = (s?.funzioni_matrice as GradoContext['matrice']) ?? {}
  }

  return {
    userId: u.id,
    gradi: (u.gradi ?? []) as Grado[],
    scuolaId: u.scuola_id ?? null,
    matrice,
  }
}

/** True se per almeno un grado del docente la funzione è abilitata in matrice. */
export function isFunzioneAbilitata(ctx: GradoContext, funzione: string): boolean {
  return ctx.gradi.some((g) => ctx.matrice?.[g]?.[funzione] === true)
}

/**
 * Garantisce che la richiesta provenga da un docente abilitato a una funzione
 * del grado indicato (default 'primaria'). Restituisce il contesto o una
 * risposta 401/403 pronta.
 */
export async function requireFunzione(
  request: Request,
  funzione: string,
  grado: Grado = 'primaria'
): Promise<{ ctx: GradoContext; response?: undefined } | { ctx?: undefined; response: NextResponse }> {
  const userId = getRequestUserId(request)
  if (!userId) {
    return { response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }) }
  }
  const ctx = await loadGradoContext(userId)
  if (!ctx) {
    return { response: NextResponse.json({ error: 'Utente non trovato' }, { status: 401 }) }
  }
  if (!ctx.gradi.includes(grado) || !isFunzioneAbilitata(ctx, funzione)) {
    return {
      response: NextResponse.json(
        { error: `Accesso negato: funzione "${funzione}" non abilitata per il grado ${grado}` },
        { status: 403 }
      ),
    }
  }
  return { ctx }
}
