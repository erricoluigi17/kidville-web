import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

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
 *
 * Fase 5 robustezza, sesto pezzo (2026-10-10):
 *   · le due righe del riporto (−X sulla rata, +X sulla successiva) si scrivono con
 *     UN insert di due righe, cioè una sola istruzione SQL: o tutte e due o nessuna.
 *     Prima erano due insert, e con il secondo fallito restava lo storno −X senza
 *     il +X — un importo incassato sparito dal piano, senza una riga di log;
 *   · ogni lettura e scrittura guarda `error`: un guasto ferma il riporto con una
 *     riga `error` invece di uscire dal ciclo come se non ci fosse altro da fare.
 * L'incasso che ha generato l'eccedenza è GIÀ registrato: chi chiama non risponde
 * 500 per un riporto mancato, e la riga di log è ciò che lo fa vedere.
 */
const OP = 'pagamenti/spill'
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
    const { data: pag, error: errPag } = await supabase
      .from('pagamenti')
      .select('id, importo, importo_pagato, parent_payment_id, scadenza')
      .eq('id', currentId)
      .maybeSingle()
    if (errPag) {
      logEvento('pagamento', 'error', { operazione: OP, esito: 'rata-non-letta', pagamento_id: currentId, riporti: spills.length }, errPag)
      break
    }
    if (!pag || !pag.parent_payment_id) break

    const eccedenza = Number(pag.importo_pagato) - Number(pag.importo)
    if (eccedenza <= 0.0001) break

    // trova la prossima rata dello stesso piano, non ancora saldata, con scadenza successiva
    const { data: next, error: errNext } = await supabase
      .from('pagamenti')
      .select('id, importo, importo_pagato, scadenza')
      .eq('parent_payment_id', pag.parent_payment_id)
      .neq('id', pag.id)
      .gt('scadenza', pag.scadenza)
      .order('scadenza', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (errNext) {
      logEvento('pagamento', 'error', { operazione: OP, esito: 'rata-successiva-non-letta', pagamento_id: pag.id, riporti: spills.length }, errNext)
      break
    }

    if (!next) break
    const mancante = Number(next.importo) - Number(next.importo_pagato)
    if (mancante <= 0) {
      // rata già saldata: prova a saltare oltre impostando current = next (continua a cercare)
      currentId = next.id
      continue
    }

    const importoRiporto = Math.min(eccedenza, mancante)

    // riduce l'eccedenza sulla rata corrente (storno del surplus) e la sposta sulla successiva:
    // UN insert, due righe — una sola istruzione, quindi tutte e due o nessuna.
    const { error: errRiporto } = await supabase.from('incassi').insert([
      {
        pagamento_id: pag.id,
        importo: -importoRiporto,
        metodo: 'altro',
        note: `Riporto su rata successiva (${next.scadenza})`,
        registrato_da: registratoDa ?? null,
      },
      {
        pagamento_id: next.id,
        importo: importoRiporto,
        metodo: 'altro',
        note: `Riporto da rata precedente (${pag.scadenza})`,
        registrato_da: registratoDa ?? null,
      },
    ])
    if (errRiporto) {
      logEvento('pagamento', 'error', { operazione: OP, esito: 'riporto-non-scritto', pagamento_id: pag.id, rata_id: next.id, importo: importoRiporto, riporti: spills.length }, errRiporto)
      break
    }

    spills.push({ rata_id: next.id, importo: importoRiporto })
    currentId = next.id // continua: l'eventuale ulteriore eccedenza scende ancora
  }

  return spills
}
