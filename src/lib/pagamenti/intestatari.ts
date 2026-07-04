import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// Risolutore intestatari fattura + ripartizione in quote (genitori separati).
//
// Contesto identità (verificato live):
//  · `alunni.intestatario_fatture.adult_id` = **parents.id** (registry PK);
//  · `alunni.retta_split_config.quote[].adult_id` e `pagamenti_quote.adult_id`
//    = **utenti.id** (== auth.uid per staff/genitori-demo);
//  · ponte canonico: `parents.auth_user_id == utenti.id`.
// `resolveParentRegistry` unifica i due spazi tornando SEMPRE una riga `parents`
// (che porta il codice fiscale, obbligatorio per la FatturaPA).
// =============================================================================

export interface ParentRegistry {
  id: string
  first_name: string | null
  last_name: string | null
  fiscal_code: string | null
  residence_address: string | null
  residence_city: string | null
  zip_code: string | null
}

const REG_COLS = 'id, first_name, last_name, fiscal_code, residence_address, residence_city, zip_code'

/**
 * Da un adultId (parents.id OPPURE utenti.id) alla riga `parents` fatturabile.
 * Prova prima parents.id (spazio intestatario_fatture), poi il ponte
 * parents.auth_user_id (spazio quote/utenti). `null` se non risolvibile.
 */
export async function resolveParentRegistry(
  supabase: SupabaseClient,
  adultId: string | null | undefined,
): Promise<ParentRegistry | null> {
  if (!adultId) return null
  const byId = await supabase.from('parents').select(REG_COLS).eq('id', adultId).maybeSingle()
  if (byId.data) return byId.data as ParentRegistry
  const byBridge = await supabase.from('parents').select(REG_COLS).eq('auth_user_id', adultId).maybeSingle()
  return (byBridge.data as ParentRegistry | null) ?? null
}

export interface Quota {
  adultId: string
  importo: number
  /** Etichetta leggibile (es. "Mamma", "Papà", nome) — vuota per quota unica. */
  label: string
}

interface Voce {
  adultId: string
  peso: number
  label: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Ripartisce `totale` fra le voci in proporzione ai pesi; arrotonda a 2 decimali
 * e assegna il resto (centesimi) alla PRIMA quota così che la somma sia esatta.
 */
export function ripartisci(voci: Voce[], totale: number): Quota[] {
  if (voci.length === 0) return []
  const sommaPesi = voci.reduce((s, v) => s + v.peso, 0)
  const base = sommaPesi > 0 ? voci.map((v) => (totale * v.peso) / sommaPesi) : voci.map(() => totale / voci.length)
  const arrot = base.map(round2)
  const resto = round2(totale - arrot.reduce((s, x) => s + x, 0))
  return voci.map((v, i) => ({
    adultId: v.adultId,
    importo: i === 0 ? round2(arrot[0] + resto) : arrot[i],
    label: v.label,
  }))
}

export interface PagamentoQuoteInput {
  id: string
  importo: number | string
}
export interface AlunnoQuoteInput {
  id?: string | null
  genitori_separati?: boolean | null
  retta_split_config?: { quote?: { adult_id: string; importo: number | string; etichetta?: string | null }[] } | null
  intestatario_fatture?: { adult_id?: string | null } | null
}

/**
 * Determina le quote di fatturazione di un pagamento. Priorità:
 *  1) ordine divise (`divise_ordini.pagamento_id`) → quota UNICA a chi ha ordinato;
 *  2) alunno con genitori separati →
 *     a) `pagamenti_quote` esplicite del pagamento, se presenti;
 *     b) proporzioni da `retta_split_config.quote` scalate sull'importo;
 *     c) 50/50 sui due tutori (`legame_genitori_alunni`);
 *  3) default → quota UNICA a `intestatario_fatture.adult_id`.
 * Somma sempre esatta (resto alla prima quota). `[]` se nessun intestatario.
 */
export async function determinaQuoteFatturazione(
  supabase: SupabaseClient,
  pagamento: PagamentoQuoteInput,
  alunno: AlunnoQuoteInput,
): Promise<Quota[]> {
  const totale = round2(Number(pagamento.importo))

  // 1) Ordine divise → quota unica all'ordinante.
  const { data: ordine } = await supabase
    .from('divise_ordini')
    .select('parent_id')
    .eq('pagamento_id', pagamento.id)
    .maybeSingle()
  if (ordine?.parent_id) {
    return [{ adultId: ordine.parent_id as string, importo: totale, label: 'Divise' }]
  }

  // 2) Genitori separati.
  if (alunno.genitori_separati) {
    // 2a) quote esplicite del pagamento (l'editor Segreteria le tiene = importo).
    const { data: quote } = await supabase
      .from('pagamenti_quote')
      .select('adult_id, importo, etichetta')
      .eq('pagamento_id', pagamento.id)
    if (quote && quote.length > 0) {
      return (quote as { adult_id: string; importo: number | string; etichetta: string | null }[]).map((q) => ({
        adultId: q.adult_id,
        importo: round2(Number(q.importo)),
        label: q.etichetta ?? '',
      }))
    }
    // 2b) proporzioni da retta_split_config scalate sull'importo del pagamento.
    const cfg = alunno.retta_split_config
    if (cfg?.quote && cfg.quote.length > 0) {
      return ripartisci(
        cfg.quote.map((q) => ({ adultId: q.adult_id, peso: Number(q.importo) || 0, label: q.etichetta ?? '' })),
        totale,
      )
    }
    // 2c) 50/50 sui due tutori noti.
    if (alunno.id) {
      const { data: tutori } = await supabase
        .from('legame_genitori_alunni')
        .select('genitore_id')
        .eq('alunno_id', alunno.id)
      const ids = (tutori ?? []).map((t) => t.genitore_id as string)
      if (ids.length >= 2) {
        return ripartisci(ids.slice(0, 2).map((id, i) => ({ adultId: id, peso: 1, label: i === 0 ? 'Genitore 1' : 'Genitore 2' })), totale)
      }
    }
  }

  // 3) Default → intestatario unico.
  const adultId = alunno.intestatario_fatture?.adult_id
  if (adultId) return [{ adultId, importo: totale, label: '' }]
  return []
}
