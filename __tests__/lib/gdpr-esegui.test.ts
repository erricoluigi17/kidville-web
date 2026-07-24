import { describe, it, expect } from 'vitest'
import { anonimizzaParent, anonimizzaAlunno } from '@/lib/gdpr/esegui'

// Fake Supabase minimale: cattura gli update, registra le delete e restituisce
// i dati configurati per tabella. Modellato sul mock di gdpr-erase-route.test.ts,
// ridotto alle sole operazioni usate da esegui.ts.
interface Cfg {
  parentAuth?: string | null
  newsDel?: { post_id: string }[]
  newsErr?: { code: string } | null
  pagamenti?: { id: string }[]
  movConf?: { id: string; suggerimenti?: unknown }[]
  movNc?: { id: string; suggerimenti?: unknown }[]
  incassi?: { id: string }[]
  cassa?: { id: string }[]
}

function arrayFor(table: string, state: { stato?: string; neqStato?: string }, cfg: Cfg) {
  if (table === 'news_visualizzazioni') return cfg.newsDel ?? []
  if (table === 'pagamenti') return cfg.pagamenti ?? []
  if (table === 'incassi') return cfg.incassi ?? []
  if (table === 'cassa_movimenti') return cfg.cassa ?? []
  if (table === 'riconciliazione_movimenti') {
    if (state.stato === 'confermato') return cfg.movConf ?? []
    if (state.neqStato === 'confermato') return cfg.movNc ?? []
    return []
  }
  return []
}

function makeFake(cfg: Cfg) {
  const updates: Record<string, unknown>[] = []
  const deletedTables: string[] = []
  const newsFilter: { v: string[] | null } = { v: null }
  const client = {
    from(table: string) {
      const state: { stato?: string; neqStato?: string } = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => { if (col === 'stato') state.stato = String(val); return b }
      b.neq = (col: string, val: unknown) => { if (col === 'stato') state.neqStato = String(val); return b }
      b.in = (col: string, vals: unknown) => { if (table === 'news_visualizzazioni' && col === 'utente_id') newsFilter.v = vals as string[]; return b }
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.delete = () => { deletedTables.push(table); return b }
      b.update = (row: Record<string, unknown>) => { updates.push({ table, ...row }); return b }
      b.maybeSingle = async () => ({
        data: table === 'parents' ? { auth_user_id: cfg.parentAuth ?? null } : null,
        error: null,
      })
      b.then = (res: (v: unknown) => unknown) => {
        const error = table === 'news_visualizzazioni' ? (cfg.newsErr ?? null) : null
        const data = error ? null : arrayFor(table, state, cfg)
        return Promise.resolve({ data, error }).then(res)
      }
      return b
    },
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  }
  return { client, updates, deletedTables, newsFilter }
}

const AT = '2026-07-24T00:00:00Z'

describe('anonimizzaParent', () => {
  it('applica patchParent e cancella news_visualizzazioni per l’auth id raccolto', async () => {
    const f = makeFake({ parentAuth: 'auth-1', newsDel: [{ post_id: 'n1' }, { post_id: 'n2' }] })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    const pUpd = f.updates.find((u) => u.table === 'parents')
    expect(pUpd).toBeTruthy()
    expect((pUpd!.first_name as string).startsWith('CANCELLATO-')).toBe(true)
    expect(pUpd!.auth_user_id).toBeNull()
    expect(f.deletedTables).toContain('news_visualizzazioni')
    expect(f.newsFilter.v).toEqual(['auth-1'])
    expect(r.newsVisualizzazioniRimosse).toBe(2)
  })

  it('genitore senza auth_user_id → nessuna DELETE news', async () => {
    const f = makeFake({ parentAuth: null })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(f.deletedTables).not.toContain('news_visualizzazioni')
    expect(r.newsVisualizzazioniRimosse).toBe(0)
  })

  it('degrada in silenzio se lo schema news è assente', async () => {
    const f = makeFake({ parentAuth: 'auth-1', newsErr: { code: 'PGRST205' } })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(r.newsVisualizzazioniRimosse).toBe(0)
  })
})

describe('anonimizzaAlunno', () => {
  it('applica patchAlunno e bonifica i movimenti confermati collegati ai pagamenti', async () => {
    const f = makeFake({
      pagamenti: [{ id: 'pag-1' }],
      movConf: [{ id: 'mov-1', suggerimenti: [{ pagamento_id: 'pag-1', score: 1050, label: 'Marco Rossi' }] }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const aUpd = f.updates.find((u) => u.table === 'alunni')
    expect(aUpd).toBeTruthy()
    expect((aUpd!.nome as string).startsWith('CANCELLATO-')).toBe(true)
    const movUpd = f.updates.find((u) => u.table === 'riconciliazione_movimenti')
    expect(movUpd).toBeTruthy()
    expect(movUpd!.causale).toBeNull()
    const sugg = movUpd!.suggerimenti as Record<string, unknown>[]
    expect('label' in sugg[0]).toBe(false)
    expect(sugg[0]).toMatchObject({ pagamento_id: 'pag-1', score: 1050 })
    expect(r.riconciliazione).toBe(1)
  })

  it('senza pagamenti né CF non tocca riconciliazione/cassa', async () => {
    const f = makeFake({})
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(f.updates.some((u) => u.table === 'riconciliazione_movimenti')).toBe(false)
    expect(f.updates.some((u) => u.table === 'cassa_movimenti')).toBe(false)
    expect(r.riconciliazione).toBe(0)
    expect(r.cassa).toBe(0)
  })

  it('con CF bonifica il testo libero di cassa', async () => {
    const f = makeFake({ cassa: [{ id: 'cm-1' }, { id: 'cm-2' }] })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1', codice_fiscale: 'TSTTST00T00T000T' }, AT, 'test')
    const cassaUpd = f.updates.find((u) => u.table === 'cassa_movimenti')
    expect(cassaUpd).toBeTruthy()
    expect(cassaUpd!.descrizione).toBe('[rimosso]')
    expect(r.cassa).toBe(2)
  })
})
