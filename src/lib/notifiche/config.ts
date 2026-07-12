import type { SupabaseClient } from '@supabase/supabase-js'
import { getModuleConfig } from '@/lib/settings/module-config'
import { tipoCanonico } from '@/lib/notifiche/tipi'

// =============================================================================
// Gate server-side dei toggle notifiche (admin_settings.notifiche_config).
// FAIL-OPEN: qualunque anomalia (scuola ignota, colonna mancante sul DB E2E
// mai migrato, errore transiente) → notifica ATTIVA, comportamento identico
// a prima dell'introduzione dei toggle.
// =============================================================================

// `type` (non `interface`): serve l'index signature implicita per soddisfare
// il vincolo `T extends Record<string, unknown>` di getModuleConfig.
export type NotificheConfig = {
  toggles?: Record<string, boolean>
}

const TTL_MS = 60_000
const cache = new Map<string, { toggles: Record<string, boolean>; ts: number }>()

/** Svuota la cache dei toggle (per i test e dopo un salvataggio impostazioni). */
export function invalidateNotificheConfigCache(): void {
  cache.clear()
}

/**
 * True se la notifica `tipo` è abilitata per la scuola. Toggle assente = attiva.
 * Gli alias (es. nota_firma) seguono il toggle del tipo canonico.
 */
export async function isNotificaAbilitata(
  supabase: SupabaseClient,
  tipo: string,
  scuolaId?: string | null,
): Promise<boolean> {
  if (!scuolaId) return true
  try {
    let hit = cache.get(scuolaId)
    if (!hit || Date.now() - hit.ts >= TTL_MS) {
      const cfg = await getModuleConfig<NotificheConfig>(supabase, 'notifiche_config', scuolaId)
      hit = { toggles: (cfg?.toggles ?? {}) as Record<string, boolean>, ts: Date.now() }
      cache.set(scuolaId, hit)
    }
    return hit.toggles[tipoCanonico(tipo)] !== false
  } catch (err) {
    console.error('[isNotificaAbilitata] lettura config fallita (fail-open):', err)
    return true
  }
}
