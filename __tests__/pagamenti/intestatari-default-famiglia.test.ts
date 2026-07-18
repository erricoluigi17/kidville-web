import { describe, it, expect } from 'vitest'
import { determinaQuoteFatturazione } from '@/lib/pagamenti/intestatari'

// determinaQuoteFatturazione + DEFAULT FAMIGLIA (slice S4).
//  (h) l'eccezione per-figlio (intestatario_fatture) VINCE sul default famiglia;
//  in sua assenza si usa il parent con parents.intestatario_default = true;
//  colonna intestatario_default assente (42703) → fallback attuale ([]).

const A_FIGLIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B_DEFAULT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ALUNNO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

interface Cfg {
  defaultParent?: { data: unknown; error: unknown }
  studentParents?: unknown[]
}

function db(cfg: Cfg) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      b.maybeSingle = async () => {
        if (table === 'divise_ordini') return { data: null, error: null }
        if (table === 'parents') return cfg.defaultParent ?? { data: null, error: null }
        return { data: null, error: null }
      }
      // student_parents: await diretto sulla query (.select().eq())
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'student_parents') return resolve({ data: cfg.studentParents ?? [], error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
  }
}

describe('determinaQuoteFatturazione — default famiglia', () => {
  it('(h) intestatario_fatture per-figlio VINCE (default famiglia non consultato)', async () => {
    const quote = await determinaQuoteFatturazione(
      db({ defaultParent: { data: { id: B_DEFAULT }, error: null } }) as never,
      { id: 'pag-1', importo: 150 },
      { id: ALUNNO, intestatario_fatture: { adult_id: A_FIGLIO } },
    )
    expect(quote).toEqual([{ adultId: A_FIGLIO, importo: 150, label: '' }])
  })

  it('senza eccezione per-figlio → usa parents.intestatario_default', async () => {
    const quote = await determinaQuoteFatturazione(
      db({ studentParents: [{ parent_id: B_DEFAULT }], defaultParent: { data: { id: B_DEFAULT }, error: null } }) as never,
      { id: 'pag-1', importo: 150 },
      { id: ALUNNO, intestatario_fatture: null },
    )
    expect(quote).toEqual([{ adultId: B_DEFAULT, importo: 150, label: '' }])
  })

  it('nessun default e nessuna eccezione → []', async () => {
    const quote = await determinaQuoteFatturazione(
      db({ studentParents: [{ parent_id: B_DEFAULT }], defaultParent: { data: null, error: null } }) as never,
      { id: 'pag-1', importo: 150 },
      { id: ALUNNO, intestatario_fatture: null },
    )
    expect(quote).toEqual([])
  })

  it('colonna intestatario_default assente (42703) → fallback []', async () => {
    const quote = await determinaQuoteFatturazione(
      db({ studentParents: [{ parent_id: B_DEFAULT }], defaultParent: { data: null, error: { code: '42703' } } }) as never,
      { id: 'pag-1', importo: 150 },
      { id: ALUNNO, intestatario_fatture: null },
    )
    expect(quote).toEqual([])
  })
})
