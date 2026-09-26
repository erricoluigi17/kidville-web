import type { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// MODULO CASSA · lettura UNITA delle sedi (K3, 2026-09-26).
//
// Decisione del titolare: con più sedi selezionate la Cassa si LEGGE insieme,
// ma ogni sede resta un cassetto a sé (fondo, saldo, svuotamento). Le SCRITTURE
// restano per sede e continuano a passare da `resolveScuolaScrittura`: questo
// modulo serve SOLO alle GET.
//
// Prima le GET di saldo/chiusura/report/categorie usavano `resolveScuolaScrittura`,
// che con più sedi e nessuna indicata risponde 400: la Cassa di chi ha tre plessi
// non si apriva senza sceglierne uno.
// =============================================================================

/**
 * Le sedi su cui una GET della cassa legge.
 *
 * - senza `scuolaId`: tutte le sedi attive dell'utente (SedeSelector ∩ accessibili);
 * - con `scuolaId`: solo quella, se è fra le attive — altrimenti **403**
 *   (`restringiSedi` → `null`). Un uuid scritto a mano non allarga mai il perimetro.
 *
 * `sedi` vuoto è una risposta legittima («non hai plessi»): il chiamante risponde
 * con un elenco vuoto, non con un errore.
 *
 * Il 403 LOGGA qui: `rifiutoSede` per contratto non logga («il log lo fa chi
 * decide»), e chi decide è questa funzione. Prima del K3 queste GET passavano da
 * `resolveScuolaScrittura`, che su una sede fuori perimetro scrive un `warn`
 * persistito; senza questa riga il tentativo cross-sede resterebbe solo nella
 * riga `info` non persistita di `withRoute`. Schema fisso del repo per
 * `restringiSedi` → null: `multi_sede`/`warn`/`sede-filtro-fuori-scope`.
 */
export async function sediLetturaCassa(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  scuolaId: string | null | undefined,
  operazione: string,
): Promise<{ sedi: string[]; response?: undefined } | { sedi?: undefined; response: NextResponse }> {
  const attive = await resolveScuoleAttive(request, supabase, user)
  const sedi = restringiSedi(attive, scuolaId ?? null)
  if (!sedi) {
    logEvento('multi_sede', 'warn', {
      operazione,
      esito: 'sede-filtro-fuori-scope',
      utente: user.id,
      ruolo: user.role,
      sede_id: scuolaId ?? null,
      sedi_attive: attive.length,
    })
    return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') }
  }
  return { sedi }
}

/**
 * id → nome delle sedi, da `schools`. Il nome è un'etichetta per la colonna
 * «Sede»: se la lettura fallisce le righe escono con `scuola_nome: null` (la UI
 * ripiega sull'uuid) e il guasto resta in un `warn` — mai un 500 per un'etichetta.
 * PostgREST non lancia: si controlla `{ error }`.
 */
export async function nomiSediCassa(
  supabase: SupabaseClient,
  sedi: readonly string[],
  operazione: string,
): Promise<Map<string, string | null>> {
  const mappa = new Map<string, string | null>()
  if (sedi.length === 0) return mappa
  const { data, error } = await supabase.from('schools').select('id, nome').in('id', [...sedi])
  if (error) {
    logEvento('cassa', 'warn', { operazione, esito: 'nomi-sedi-non-letti', quantita: sedi.length }, error)
    return mappa
  }
  for (const r of (data ?? []) as { id: string; nome: string | null }[]) {
    const nome = typeof r.nome === 'string' && r.nome.trim() !== '' ? r.nome : null
    mappa.set(r.id, nome)
  }
  return mappa
}

/**
 * Primo e ultimo giorno del mese CORRENTE nel fuso Europe/Rome, come 'YYYY-MM-DD'.
 *
 * Il runtime gira in UTC: alle 00:30 del 1° del mese in Italia, in UTC è ancora
 * il mese prima. Il giorno si chiede al fuso (`toLocaleDateString` con timeZone),
 * non si deduce da `getUTCMonth()`.
 */
export function meseCorrenteRoma(adesso: Date = new Date()): { da: string; a: string } {
  const oggi = adesso.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })
  const [anno, mese] = oggi.split('-').map(Number)
  // Giorno 0 del mese successivo = ultimo giorno di questo (in UTC, senza fusi di mezzo).
  const ultimo = new Date(Date.UTC(anno, mese, 0)).getUTCDate()
  const mm = String(mese).padStart(2, '0')
  return { da: `${anno}-${mm}-01`, a: `${anno}-${mm}-${String(ultimo).padStart(2, '0')}` }
}
