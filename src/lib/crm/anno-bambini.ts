import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { annoDellaData, resolveAnnoScrittura } from '@/lib/auth/scope'
import type { AppUser } from '@/lib/auth/require-staff'
import { conAnno, type EsitoAnno } from '@/lib/anno/tipi'
import { erroreAnno } from '@/lib/anno/errori'
import { esitoSchemaIndietro, guastoAnno } from '@/lib/anno/lettura'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { addGiorni } from '@/lib/format/data'
import type { AnnoIngresso } from '@/lib/crm/tipi'

/**
 * CRM · L'ANNO DEI BAMBINI (Compito 3.5-2).
 *
 * `crm_bambini` è in modo `dichiarato`: la riga dice a quale anno appartiene, e ogni bambino ha il suo
 * `anno_ingresso`.
 *  · `in_corso` e `non_indicato` → l'anno di `resolveAnnoScrittura` SENZA `dichiarato` (il `corrente`);
 *  · `prossimo` → l'anno che comincia il giorno dopo la `fine` del `corrente`, trovato con
 *    `annoDellaData`. Mai con un `dichiarato`: la segreteria non sceglie un anno, dice «il prossimo».
 *
 * Si risolvono solo gli anni che servono. Senza un `corrente` (agosto) NESSUNO dei due tipi ha un anno:
 * 400 `ANNO_DA_SPECIFICARE`, e il chiamante non scrive niente. Sul database senza lo schema dell'anno
 * (CI) `conAnno` dà `{}` e la riga nasce come prima.
 *
 * `anno_ingresso` resta com'è: lo toglie la PR 5.
 */

export type AnniBambini = {
  /** L'anno dei bambini `in_corso` e `non_indicato`. */
  corrente?: EsitoAnno
  /** L'anno dei bambini `prossimo`. */
  prossimo?: EsitoAnno
  /**
   * Ciò che porta i gettoni di tutte le risoluzioni, da dare a `clientPerScrittura`: un solo
   * `insert` (una transazione) li presenta insieme.
   */
  scrittura: EsitoAnno
}

/** La `fine` dell'unico anno `corrente` della sede, oppure la risposta pronta / lo schema indietro. */
async function fineDelCorrente(
  supabase: SupabaseClient,
  scuolaId: string,
): Promise<{ fine: string } | { indietro: true } | { response: NextResponse }> {
  const azione = 'crm/anno-bambini:fineDelCorrente'
  const { data, error } = await supabase
    .from('anni_sede')
    .select('fine')
    .eq('scuola_id', scuolaId)
    .eq('stato', 'corrente')
  if (error) return schemaAnnoIndietro(error) ? { indietro: true } : { response: guastoAnno(azione, error) }
  const righe = Array.isArray(data) ? (data as { fine?: string | null }[]) : []
  const fine = righe.length === 1 ? righe[0].fine : null
  if (typeof fine !== 'string' || !fine) {
    return { response: erroreAnno({ message: 'ANNO_DA_SPECIFICARE' }, azione) as NextResponse }
  }
  return { fine: fine.slice(0, 10) }
}

export async function risolviAnniBambini(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  scuolaId: string,
  tipi: readonly AnnoIngresso[],
): Promise<AnniBambini | NextResponse> {
  const risultato: AnniBambini = { scrittura: { annoSedeId: null, annoId: null, stato: null } }
  const gettoni: string[] = []
  const raccogli = (e: EsitoAnno) => {
    if (e.gettoni) gettoni.push(...e.gettoni)
  }

  if (tipi.some((t) => t !== 'prossimo')) {
    const e = await resolveAnnoScrittura(request, supabase, user, scuolaId, { usi: 1 })
    if (e instanceof NextResponse) return e
    risultato.corrente = e
    raccogli(e)
  }

  if (tipi.includes('prossimo')) {
    const corrente = await fineDelCorrente(supabase, scuolaId)
    if ('response' in corrente) return corrente.response
    if ('indietro' in corrente) {
      risultato.prossimo = esitoSchemaIndietro('crm/anno-bambini')
    } else {
      const e = await annoDellaData(supabase, user, scuolaId, addGiorni(corrente.fine, 1), { usi: 1 })
      if (e instanceof NextResponse) return e
      risultato.prossimo = e
      raccogli(e)
    }
  }

  const primo = (risultato.corrente ?? risultato.prossimo) as EsitoAnno
  risultato.scrittura = { ...primo, gettone: gettoni[0], gettoni: gettoni.length > 0 ? gettoni : undefined }
  return risultato
}

/** Il pezzo di payload che dichiara l'anno di UN bambino: `{ anno_id }`, oppure `{}` sul database indietro. */
export function annoDelBambino(anni: AnniBambini, annoIngresso: AnnoIngresso): { anno_id?: string } {
  const esito = annoIngresso === 'prossimo' ? anni.prossimo : anni.corrente
  return esito ? conAnno(esito) : {}
}
