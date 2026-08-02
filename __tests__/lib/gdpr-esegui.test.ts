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
  consensi?: { id: string }[] // W5 — prove di consenso da cui togliere ip/user_agent
  // C5 — testo libero UGC bonificato dall'oblio.
  segnalazioni?: { id: string }[] // scrub a livello genitore (via .or su segnalante/segnalato)
  sospensioni?: { id: string }[] // scrub a livello genitore (via .or su sospesa_da/sospesa_verso)
  diario?: { id: string }[] // eventi_diario dell'alunno
  media?: { id: string }[] // galleria_media_v2 taggati all'alunno
  threads?: { id: string }[] // chat_threads dell'alunno
  segDiario?: { id: string }[] // segnalazioni su voci di diario dell'alunno
  segMedia?: { id: string }[] // segnalazioni su media taggati
  segChat?: { id: string }[] // segnalazioni su messaggi dei thread dell'alunno
  sospChat?: { id: string }[] // sospensioni dei thread dell'alunno
  // Errore per-tabella iniettabile (es. { segnalazioni: { code: 'PGRST205' } }).
  err?: Record<string, { code: string }>
}

interface QState {
  stato?: string
  neqStato?: string
  tipoOggetto?: string
  inThread?: boolean
}

function arrayFor(table: string, state: QState, cfg: Cfg) {
  if (table === 'news_visualizzazioni') return cfg.newsDel ?? []
  if (table === 'pagamenti') return cfg.pagamenti ?? []
  if (table === 'incassi') return cfg.incassi ?? []
  if (table === 'cassa_movimenti') return cfg.cassa ?? []
  if (table === 'consensi_accettazioni') return cfg.consensi ?? []
  if (table === 'eventi_diario') return cfg.diario ?? []
  if (table === 'galleria_media_v2') return cfg.media ?? []
  if (table === 'chat_threads') return cfg.threads ?? []
  if (table === 'segnalazioni') {
    if (state.tipoOggetto === 'voce_diario') return cfg.segDiario ?? []
    if (state.tipoOggetto === 'media_galleria') return cfg.segMedia ?? []
    if (state.tipoOggetto === 'messaggio_chat') return cfg.segChat ?? []
    return cfg.segnalazioni ?? [] // scrub a livello genitore (.or, senza tipo_oggetto)
  }
  if (table === 'conversazioni_sospensioni') {
    if (state.inThread) return cfg.sospChat ?? []
    return cfg.sospensioni ?? [] // scrub a livello genitore (.or, senza thread_id)
  }
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
  const orFilters: { table: string; filter: string }[] = []
  const newsFilter: { v: string[] | null } = { v: null }
  const client = {
    from(table: string) {
      const state: QState = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => {
        if (col === 'stato') state.stato = String(val)
        if (col === 'tipo_oggetto') state.tipoOggetto = String(val)
        return b
      }
      b.neq = (col: string, val: unknown) => { if (col === 'stato') state.neqStato = String(val); return b }
      b.not = () => b
      b.in = (col: string, vals: unknown) => {
        if (table === 'news_visualizzazioni' && col === 'utente_id') newsFilter.v = vals as string[]
        if (col === 'thread_id') state.inThread = true
        return b
      }
      b.is = () => b
      b.or = (filter: string) => { orFilters.push({ table, filter }); return b }
      b.ilike = () => b
      b.contains = () => b
      b.delete = () => { deletedTables.push(table); return b }
      b.update = (row: Record<string, unknown>) => { updates.push({ table, ...row }); return b }
      b.maybeSingle = async () => ({
        data: table === 'parents' ? { auth_user_id: cfg.parentAuth ?? null } : null,
        error: null,
      })
      b.then = (res: (v: unknown) => unknown) => {
        const error = cfg.err?.[table] ?? (table === 'news_visualizzazioni' ? (cfg.newsErr ?? null) : null)
        const data = error ? null : arrayFor(table, state, cfg)
        return Promise.resolve({ data, error }).then(res)
      }
      return b
    },
    // `list` c'è perché il bucket `credenziali` non ha nessuna tabella-indice:
    // l'unico modo di ritrovare il PDF di una famiglia — dentro c'è una password
    // in chiaro — è elencare il bucket. Un finto client senza `list` non è un
    // client Supabase.
    storage: { from: () => ({ remove: async () => ({ error: null }), list: async () => ({ data: [], error: null }) }) },
  }
  return { client, updates, deletedTables, orFilters, newsFilter }
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

  it('toglie ip e user_agent dalle prove di consenso, lasciando la prova (W5)', async () => {
    const f = makeFake({ parentAuth: 'auth-1', consensi: [{ id: 'c1' }, { id: 'c2' }] })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    const cUpd = f.updates.find((u) => u.table === 'consensi_accettazioni')
    expect(cUpd).toBeTruthy()
    expect(cUpd!.ip).toBeNull()
    expect(cUpd!.user_agent).toBeNull()
    // La prova resta: versione, tipo e data NON si toccano — servono all'art. 7
    // §1 GDPR e all'art. 1341 c.c. molto più dell'indirizzo IP.
    expect(Object.keys(cUpd!)).not.toContain('versione')
    expect(Object.keys(cUpd!)).not.toContain('accettato_il')
    expect(r.provaConsensiScrubbate).toBe(2)
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

  it('bonifica segnalazioni dove il genitore è segnalante O segnalato (motivo + note_gestione)', async () => {
    const f = makeFake({ parentAuth: 'auth-1', segnalazioni: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    const segUpd = f.updates.find((u) => u.table === 'segnalazioni')
    expect(segUpd).toBeTruthy()
    expect(segUpd!.motivo).toBeNull()
    expect(segUpd!.note_gestione).toBeNull()
    // Il filtro .or copre entrambi i ruoli del genitore, e lo fa con l'AUTH id:
    // `segnalazioni.segnalante_id/segnalato_id` sono scritte da
    // `api/segnalazioni/route.ts` con `auth.user.id` (spazio-id `utenti`), NON
    // con `parents.id`. Filtrare per parentId non trova mai nulla.
    const segFilter = f.orFilters.find((o) => o.table === 'segnalazioni')?.filter ?? ''
    expect(segFilter).toContain('segnalante_id.eq.auth-1')
    expect(segFilter).toContain('segnalato_id.eq.auth-1')
    expect(r.segnalazioniBonificate).toBe(3)
  })

  it('bonifica conversazioni_sospensioni dove il genitore è sospendente O sospeso (solo motivo)', async () => {
    const f = makeFake({ parentAuth: 'auth-1', sospensioni: [{ id: 'x1' }, { id: 'x2' }] })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    const sospUpd = f.updates.find((u) => u.table === 'conversazioni_sospensioni')
    expect(sospUpd).toBeTruthy()
    expect(sospUpd!.motivo).toBeNull()
    // Stesso spazio-id delle segnalazioni: `sospesa_da` è `auth.user.id`
    // (chat/threads/[id]/sospendi) e `sospesa_verso` è `chat_threads.parent_id`,
    // a sua volta confrontato con `auth.user.id` alla creazione del thread.
    const sospFilter = f.orFilters.find((o) => o.table === 'conversazioni_sospensioni')?.filter ?? ''
    expect(sospFilter).toContain('sospesa_da.eq.auth-1')
    expect(sospFilter).toContain('sospesa_verso.eq.auth-1')
    expect(r.sospensioniBonificate).toBe(2)
  })

  it('genitore senza auth_user_id → nessuna UPDATE su segnalazioni/sospensioni', async () => {
    // Senza il ponte `parents.auth_user_id` il genitore non è raggiungibile in
    // spazio-id `utenti`: lo scrub UGC si salta, esattamente come la DELETE news.
    // Meglio saltare che filtrare su un id che non comparirà mai in quelle colonne.
    const f = makeFake({ parentAuth: null, segnalazioni: [{ id: 's1' }], sospensioni: [{ id: 'x1' }] })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(f.updates.some((u) => u.table === 'segnalazioni')).toBe(false)
    expect(f.updates.some((u) => u.table === 'conversazioni_sospensioni')).toBe(false)
    expect(f.orFilters.some((o) => o.table === 'segnalazioni')).toBe(false)
    expect(f.orFilters.some((o) => o.table === 'conversazioni_sospensioni')).toBe(false)
    expect(r.segnalazioniBonificate).toBe(0)
    expect(r.sospensioniBonificate).toBe(0)
  })

  it('degrada in silenzio se lo schema C5 (segnalazioni/sospensioni) è assente', async () => {
    const f = makeFake({
      parentAuth: 'auth-1',
      segnalazioni: [{ id: 's1' }],
      sospensioni: [{ id: 'x1' }],
      err: { segnalazioni: { code: 'PGRST205' }, conversazioni_sospensioni: { code: 'PGRST205' } },
    })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(r.segnalazioniBonificate).toBe(0)
    expect(r.sospensioniBonificate).toBe(0)
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

  it('bonifica segnalazioni via voce di diario collegata all’alunno', async () => {
    const f = makeFake({ diario: [{ id: 'ev-1' }], segDiario: [{ id: 'seg-1' }] })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const segUpd = f.updates.find((u) => u.table === 'segnalazioni')
    expect(segUpd).toBeTruthy()
    expect(segUpd!.motivo).toBeNull()
    expect(segUpd!.note_gestione).toBeNull()
    expect(r.segnalazioniBonificate).toBe(1)
    expect(r.sospensioniBonificate).toBe(0)
  })

  it('bonifica segnalazioni via media di galleria taggato all’alunno', async () => {
    const f = makeFake({ media: [{ id: 'm-1' }], segMedia: [{ id: 's-1' }, { id: 's-2' }] })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(f.updates.some((u) => u.table === 'segnalazioni')).toBe(true)
    expect(r.segnalazioniBonificate).toBe(2)
  })

  it('bonifica segnalazioni (messaggio_chat) e sospensioni via thread di chat dell’alunno', async () => {
    const f = makeFake({
      threads: [{ id: 't-1' }],
      segChat: [{ id: 'sc-1' }],
      sospChat: [{ id: 'ss-1' }, { id: 'ss-2' }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(f.updates.some((u) => u.table === 'segnalazioni')).toBe(true)
    const sospUpd = f.updates.find((u) => u.table === 'conversazioni_sospensioni')
    expect(sospUpd).toBeTruthy()
    expect(sospUpd!.motivo).toBeNull()
    expect(r.segnalazioniBonificate).toBe(1)
    expect(r.sospensioniBonificate).toBe(2)
  })

  it('nessuna UPDATE su segnalazioni/sospensioni se le liste di id sono vuote', async () => {
    const f = makeFake({ segDiario: [{ id: 'x' }], segMedia: [{ id: 'y' }], segChat: [{ id: 'z' }], sospChat: [{ id: 'w' }] })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    // diario/media/threads assenti → nessun id → nessuna UPDATE, pur essendoci righe segnalazioni configurate.
    expect(f.updates.some((u) => u.table === 'segnalazioni')).toBe(false)
    expect(f.updates.some((u) => u.table === 'conversazioni_sospensioni')).toBe(false)
    expect(r.segnalazioniBonificate).toBe(0)
    expect(r.sospensioniBonificate).toBe(0)
  })

  it('degrada in silenzio se lo schema C5 è assente pur avendo diario/media/thread', async () => {
    const f = makeFake({
      diario: [{ id: 'ev-1' }],
      media: [{ id: 'm-1' }],
      threads: [{ id: 't-1' }],
      err: { segnalazioni: { code: 'PGRST205' }, conversazioni_sospensioni: { code: 'PGRST205' } },
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(r.segnalazioniBonificate).toBe(0)
    expect(r.sospensioniBonificate).toBe(0)
  })
})
