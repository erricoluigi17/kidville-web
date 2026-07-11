import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { determinaQuoteFatturazione } from '@/lib/pagamenti/intestatari'

// Regressione Merchandise: gli ordini creati dalla segreteria hanno
// divise_ordini.parent_id = NULL → intestatari.ts NON deve assegnare la quota
// unica "Divise", ma ricadere sullo split/intestatario standard dell'alunno.

function mockSupabase(opts: { ordine: { parent_id: string | null } | null; quote?: unknown[]; tutori?: { genitore_id: string }[] }): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({ data: table === 'divise_ordini' ? opts.ordine : null, error: null })
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'pagamenti_quote' ? (opts.quote ?? []) : table === 'legame_genitori_alunni' ? (opts.tutori ?? []) : [], error: null })
      return b
    },
  } as unknown as SupabaseClient
}

const pagamento = { id: 'pag-1', importo: 36 }

describe('determinaQuoteFatturazione — parent_id NULL (ordini segreteria)', () => {
  it('parent_id valorizzato → quota unica "Divise" all\'ordinante (comportamento legacy)', async () => {
    const sb = mockSupabase({ ordine: { parent_id: 'genitore-1' } })
    const quote = await determinaQuoteFatturazione(sb, pagamento, {})
    expect(quote).toEqual([{ adultId: 'genitore-1', importo: 36, label: 'Divise' }])
  })

  it('parent_id NULL → ricade sull\'intestatario dell\'alunno', async () => {
    const sb = mockSupabase({ ordine: { parent_id: null } })
    const quote = await determinaQuoteFatturazione(sb, pagamento, { intestatario_fatture: { adult_id: 'intestatario-1' } })
    expect(quote).toEqual([{ adultId: 'intestatario-1', importo: 36, label: '' }])
  })

  it('parent_id NULL + genitori separati → split 50/50 sui tutori', async () => {
    const sb = mockSupabase({ ordine: { parent_id: null }, tutori: [{ genitore_id: 'a' }, { genitore_id: 'b' }] })
    const quote = await determinaQuoteFatturazione(sb, pagamento, { id: 'al-1', genitori_separati: true })
    expect(quote).toHaveLength(2)
    expect(quote.reduce((s, q) => s + q.importo, 0)).toBe(36)
    expect(quote.map((q) => q.adultId)).toEqual(['a', 'b'])
  })

  it('nessun ordine (record assente) → intestatario standard', async () => {
    const sb = mockSupabase({ ordine: null })
    const quote = await determinaQuoteFatturazione(sb, pagamento, { intestatario_fatture: { adult_id: 'int-x' } })
    expect(quote).toEqual([{ adultId: 'int-x', importo: 36, label: '' }])
  })

  it('quote esplicite incongruenti → la differenza pareggia sulla prima (Σ == totale)', async () => {
    const sb = mockSupabase({
      ordine: { parent_id: null },
      quote: [{ adult_id: 'a', importo: 20, etichetta: 'Mamma' }, { adult_id: 'b', importo: 10, etichetta: 'Papà' }],
    })
    const quote = await determinaQuoteFatturazione(sb, pagamento, { id: 'al-1', genitori_separati: true })
    expect(quote.reduce((s, q) => s + q.importo, 0)).toBe(36) // non 30
    expect(quote[0]).toEqual({ adultId: 'a', importo: 26, label: 'Mamma' }) // 20 + differenza 6
    expect(quote[1]).toEqual({ adultId: 'b', importo: 10, label: 'Papà' })
  })
})
