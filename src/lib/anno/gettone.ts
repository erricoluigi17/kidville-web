import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClientConHeader } from '@/lib/supabase/server-client'
import { logEvento } from '@/lib/logging/logger'
import type { EsitoAnno } from '@/lib/anno/tipi'

/**
 * I GETTONI DI CORREZIONE dell'anno protetto (specifica §4.4.6, Ruling D8/D9).
 *
 * Una scrittura su una riga di un anno `in_chiusura` o `chiuso` passa dalla guardia solo se la
 * richiesta porta l'header `x-kidville-correzione: <uuid>[,<uuid>…]`, e ogni uuid è una riga viva
 * di `correzioni_anno_chiuso`. Un gettone vale UNA transazione: una route con tre scritture ne
 * chiede tre (`usi`).
 *
 * `creaGettoni` la chiama `resolveAnnoScrittura`, e solo per lo staff (Direzione e segreteria): un
 * docente non ottiene mai un gettone. `utente_id` è `AppUser.id`, che per lo staff coincide con
 * `utenti.id` e con `auth.users.id`.
 *
 * ⚠️ IL MOTIVO è testo libero: sta nella riga e basta. Mai in un log, mai in un messaggio
 * d'errore. Per questo un INSERT fallito si logga col solo codice di Postgres: il messaggio di
 * un CHECK fallito riporta la riga intera («Failing row contains …»), motivo compreso.
 */

export const USI_MASSIMI = 10

/** `usi` è un intero fra 1 e 10: ciò che non lo è diventa 1, ciò che sfora viene tagliato. */
export function usiSani(usi: unknown): number {
  if (typeof usi !== 'number' || !Number.isFinite(usi)) return 1
  return Math.min(USI_MASSIMI, Math.max(1, Math.floor(usi)))
}

export type RichiestaGettoni = {
  annoSedeId: string
  utenteId: string
  ruolo: string
  codice: 'agosto' | 'correzione'
  /** Obbligatorio con `correzione`; già ripulito dagli spazi dal chiamante. */
  motivo?: string
  usi?: number
}

/** Crea `usi` gettoni (righe distinte) e ne restituisce gli id; `null` se la scrittura è fallita. */
export async function creaGettoni(
  supabase: SupabaseClient,
  r: RichiestaGettoni,
): Promise<string[] | null> {
  const n = usiSani(r.usi)
  const riga: Record<string, unknown> = {
    utente_id: r.utenteId,
    ruolo: r.ruolo,
    anno_sede_id: r.annoSedeId,
    codice: r.codice,
  }
  if (r.codice === 'correzione') riga.motivo = r.motivo
  const righe = Array.from({ length: n }, () => ({ ...riga }))
  const { data, error } = await supabase.from('correzioni_anno_chiuso').insert(righe).select('id')
  const ids = Array.isArray(data) ? data.map((d) => String((d as { id: unknown }).id)) : []
  if (error || ids.length !== n) {
    // Solo il CODICE di Postgres: mai `error.message` (può riportare la riga, motivo compreso).
    logEvento('anno-scolastico', 'error', {
      tipo: 'gettone-non-creato',
      error_code: error?.code ?? 'righe-mancanti',
      codice_gettone: r.codice,
      usi: n,
    })
    return null
  }
  return ids
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Un client service-role che porta i gettoni nell'header `x-kidville-correzione`.
 * Un valore che non è un uuid fa lanciare PRIMA di creare il client: mai un header inventato.
 */
export async function conGettone(gettoni: string | string[]): Promise<SupabaseClient> {
  const lista = Array.isArray(gettoni) ? gettoni : [gettoni]
  if (lista.length === 0 || lista.some((g) => typeof g !== 'string' || !UUID.test(g))) {
    throw new Error('GETTONE_NON_VALIDO')
  }
  return (await createAdminClientConHeader({
    'x-kidville-correzione': lista.join(','),
  })) as unknown as SupabaseClient
}

/**
 * Il client con cui una route dello staff fa la SCRITTURA dell'anno (Ruling P37): con i gettoni
 * di `esito` nell'header se ce ne sono, altrimenti `supabase` invariato. Letture e log restano
 * sul client di prima. Un gettone che non è un uuid fa lanciare, come `conGettone`.
 */
export async function clientPerScrittura(
  supabase: SupabaseClient,
  esito: EsitoAnno,
): Promise<SupabaseClient> {
  return esito.gettoni && esito.gettoni.length > 0 ? conGettone(esito.gettoni) : supabase
}
