import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Overpayment spill-over.
 *
 * Quando su una RATA viene registrato un incasso che porta la somma oltre
 * l'importo dovuto, l'eccedenza viene "riportata" automaticamente sulla rata
 * successiva (per scadenza) dello stesso piano (`parent_payment_id`), creando
 * una riga `incassi` con nota di riporto. Si itera finché c'è eccedenza o
 * finiscono le rate.
 *
 * Gestito a livello applicativo (non nel trigger) per restare testabile e
 * auditabile. Ritorna l'elenco dei riporti effettuati.
 */
export interface SpillResult {
  rata_id: string
  importo: number
}

export async function applyOverpaymentSpill(
  supabase: SupabaseClient,
  pagamentoId: string,
  registratoDa?: string | null
): Promise<SpillResult[]> {
  const spills: SpillResult[] = []
  let currentId = pagamentoId
  // guardia anti-loop: al massimo tante iterazioni quante le rate del piano
  let guard = 0

  while (guard++ < 60) {
    const { data: pag } = await supabase
      .from('pagamenti')
      .select('id, importo, importo_pagato, parent_payment_id, scadenza')
      .eq('id', currentId)
      .single()
    if (!pag || !pag.parent_payment_id) break

    const eccedenza = Number(pag.importo_pagato) - Number(pag.importo)
    if (eccedenza <= 0.0001) break

    // trova la prossima rata dello stesso piano, non ancora saldata, con scadenza successiva
    const { data: next } = await supabase
      .from('pagamenti')
      .select('id, importo, importo_pagato, scadenza')
      .eq('parent_payment_id', pag.parent_payment_id)
      .neq('id', pag.id)
      .gt('scadenza', pag.scadenza)
      .order('scadenza', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (!next) break
    const mancante = Number(next.importo) - Number(next.importo_pagato)
    if (mancante <= 0) {
      // rata già saldata: prova a saltare oltre impostando current = next (continua a cercare)
      currentId = next.id
      continue
    }

    const importoRiporto = Math.min(eccedenza, mancante)

    // riduce l'eccedenza sulla rata corrente (storno del surplus) e la sposta sulla successiva
    const { error: e1 } = await supabase.from('incassi').insert({
      pagamento_id: pag.id,
      importo: -importoRiporto,
      metodo: 'altro',
      note: `Riporto su rata successiva (${next.scadenza})`,
      registrato_da: registratoDa ?? null,
    })
    if (e1) break

    const { error: e2 } = await supabase.from('incassi').insert({
      pagamento_id: next.id,
      importo: importoRiporto,
      metodo: 'altro',
      note: `Riporto da rata precedente (${pag.scadenza})`,
      registrato_da: registratoDa ?? null,
    })
    if (e2) break

    spills.push({ rata_id: next.id, importo: importoRiporto })
    currentId = next.id // continua: l'eventuale ulteriore eccedenza scende ancora
  }

  return spills
}
