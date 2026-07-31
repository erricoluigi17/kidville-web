import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { sediReali } from '@/lib/scuole/reali'
import { logEvento } from '@/lib/logging/logger'
import { degradoSedeLecito } from '@/lib/forms/degrado-sede'

// =============================================================================
// `form_models.scuola_id`: UNA semantica, e vale sia in lettura sia in scrittura.
//
//   • valorizzata → il modello è di QUEL plesso. Chi non ce l'ha in scope riceve
//     **404**, non 403: un 403 direbbe «esiste, ma non è tuo», e sull'elenco dei
//     moduli di un'altra sede è già un'informazione.
//   • NULL → il modello è GLOBALE: vale per tutte le sedi, quindi si LEGGE da
//     tutte, ma si MODIFICA (e si pubblica, e si ritira) solo da chi ha in scope
//     TUTTE le sedi reali — cioè la Direzione. Qui la risposta è **403**:
//     l'esistenza del modello globale è già nota a chi chiede, e nascondergliela
//     non protegge niente mentre confondere «non tuo» con «non esiste» rende il
//     messaggio d'errore inutile.
//
// Il difetto che questo file chiude (audit 2026-07-31, R55): `admin/form-models`
// PATCH usava `z.object({id}).loose()` e passava `...updates` all'UPDATE. Ogni
// colonna era scrivibile — `scuola_id` compreso, cioè la chiave di tenancy: si
// ripuntava a un'altra sede, o si rendeva globale, il modello altrui. E la
// pubblicazione (`publish`) caricava il modello per solo `id`, quindi la
// segreteria di un plesso poteva RITIRARE il link pubblico d'iscrizione di un
// altro.
// =============================================================================

export interface ModelloConSede {
  scuola_id?: string | null
}

/**
 * True se l'utente ha in scope TUTTE le sedi reali del deployment.
 *
 * Fail-closed sull'errore: se `schools` non è leggibile non si sa quante sedi ci
 * siano, e «non lo so» non può valere «hai i permessi». Sul DB E2E della CI
 * l'elenco delle sedi reali è vuoto (l'unica scuola è quella finta): non c'è
 * niente da isolare, quindi il predicato è vero — ed è la stessa scelta di
 * `degradoSedeLecito`.
 */
export async function haScopePienoSuSediReali(
  supabase: SupabaseClient,
  user: AppUser,
  operazione: string,
): Promise<boolean> {
  const { reali, error } = await sediReali(supabase, operazione)
  if (error) {
    logEvento('modulistica', 'error', {
      operazione, esito: 'sedi-non-leggibili-scope-pieno-negato',
    }, error)
    return false
  }
  const mie = new Set(await scuoleDiUtente(supabase, user))
  return reali.every((s) => mie.has(s.id))
}

/**
 * Verifica di scope su un modello di modulistica GIÀ CARICATO.
 *
 * Ritorna la `NextResponse` da restituire (404/403/500), oppure `null` se
 * l'operazione è consentita. Prende la riga invece di ricaricarla perché le
 * route hanno proiezioni diverse (`select('*')` nel builder, i soli campi di
 * pubblicazione in `publish`) e una seconda lettura sarebbe solo un altro punto
 * dove sbagliare.
 *
 * @param perScrittura  false = lettura (i modelli globali passano), true =
 *   modifica/pubblicazione (i modelli globali esigono lo scope pieno).
 */
export async function esitoScopeModello(
  supabase: SupabaseClient,
  user: AppUser,
  modello: ModelloConSede | null | undefined,
  opzioni: { operazione: string; perScrittura: boolean },
): Promise<NextResponse | null> {
  const { operazione, perScrittura } = opzioni
  if (!modello) {
    return NextResponse.json({ error: 'Modello non trovato' }, { status: 404 })
  }

  // Colonna ASSENTE (DB E2E della CI, non migrato) ≠ colonna VUOTA. Nel primo
  // caso la chiave non esiste proprio nella riga: si prosegue solo se non c'è
  // niente da isolare, esattamente come per le compilazioni.
  if (!('scuola_id' in modello)) {
    if (!(await degradoSedeLecito(supabase, operazione))) {
      return NextResponse.json({ error: 'Isolamento per sede non disponibile' }, { status: 500 })
    }
    return null
  }

  const sede = modello.scuola_id ?? null

  if (sede === null) {
    if (!perScrittura) return null
    if (await haScopePienoSuSediReali(supabase, user, operazione)) return null
    logEvento('modulistica', 'warn', {
      operazione, esito: 'modello-globale-senza-scope-pieno',
      utente: user.id, ruolo: user.role,
    })
    return NextResponse.json(
      { error: 'Il modello vale per tutte le sedi: può modificarlo solo chi le ha tutte in gestione' },
      { status: 403 },
    )
  }

  const plessi = await scuoleDiUtente(supabase, user)
  if (!plessi.includes(sede)) {
    logEvento('modulistica', 'warn', {
      operazione, esito: 'modello-fuori-sede',
      utente: user.id, ruolo: user.role,
    })
    return NextResponse.json({ error: 'Modello non trovato' }, { status: 404 })
  }
  return null
}
