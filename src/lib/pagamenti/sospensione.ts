/**
 * Sospensione account moroso (DL-021) — meccanismo soft per-alunno.
 *
 * Il flag `alunni.sospeso` è impostato manualmente dalla Direzione. La sospensione
 * **non blocca login né letture** (sicurezza del minore preservata): inibisce solo
 * le *azioni di servizio* del genitore tramite questi guard riusabili.
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

function negato(): NextResponse {
  return NextResponse.json(
    {
      error: 'Account sospeso per morosità: contatta la Segreteria per regolarizzare.',
      motivo: 'account_sospeso',
    },
    { status: 403 }
  )
}

/** True se l'alunno risulta sospeso. */
export async function alunnoSospeso(supabase: SupabaseClient, alunnoId: string): Promise<boolean> {
  const { data } = await supabase.from('alunni').select('sospeso').eq('id', alunnoId).maybeSingle()
  return data?.sospeso === true
}

/** 403 se l'alunno è sospeso, altrimenti null. */
export async function assertAlunnoNonSospeso(
  supabase: SupabaseClient,
  alunnoId: string
): Promise<NextResponse | null> {
  return (await alunnoSospeso(supabase, alunnoId)) ? negato() : null
}

/** 403 se ALMENO un figlio del genitore è sospeso, altrimenti null. */
export async function assertGenitoreNonSospeso(
  supabase: SupabaseClient,
  genitoreId: string
): Promise<NextResponse | null> {
  const { data } = await supabase
    .from('legame_genitori_alunni')
    .select('alunni:alunno_id ( sospeso )')
    .eq('genitore_id', genitoreId)
  const righe = (data ?? []) as { alunni?: { sospeso?: boolean } | { sospeso?: boolean }[] }[]
  const qualcunoSospeso = righe.some((r) => {
    const a = Array.isArray(r.alunni) ? r.alunni[0] : r.alunni
    return a?.sospeso === true
  })
  return qualcunoSospeso ? negato() : null
}
