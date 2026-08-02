import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from './finto-supabase'

// =============================================================================
// Il test del finto client. Sembra un test «del mock», ed è invece il test più
// importante della famiglia isolamento-per-sede: se il finto client accetta un
// filtro e non lo applica, OGNI test d'isolamento che passa da quel filtro è
// verde con e senza la correzione nella route — cioè non prova niente.
//
// È già successo (audit 2026-07-31): `.or()`, `.neq()` e `.not()` erano
// `() => b`, e `.or('scuola_id.in.(A),scuola_id.is.null')` restituiva anche le
// righe della sede B. Sette route filtrano la sede proprio così.
//
// Regola che questo file protegge: **un operatore che il finto client non sa
// applicare deve LANCIARE**, non restituire il builder. Un mock che tace è
// peggio di un mock che manca.
// =============================================================================

const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'bbbbbbbb-0000-4000-8000-00000000000b'

/** Tre righe: una della sede A, una della sede B, una «globale» (scuola_id NULL). */
const dbBase = (): DBFinto => ({
  news: [
    { id: 'a', scuola_id: A, titolo: 'Sede A', pubblicato_il: '2026-03-01' },
    { id: 'b', scuola_id: B, titolo: 'Sede B', pubblicato_il: '2026-03-02' },
    { id: 'g', scuola_id: null, titolo: 'Globale', pubblicato_il: '2026-03-03' },
  ],
})

const ids = (righe: unknown): string[] =>
  ((righe ?? []) as { id: string }[]).map((r) => r.id).sort()

describe('finto-supabase — i filtri di lettura si applicano davvero', () => {
  it('.eq() tiene solo le righe della colonna richiesta', async () => {
    const s = creaFintoSupabase(dbBase())
    const { data } = await s.from('news').select('*').eq('scuola_id', A)
    expect(ids(data)).toEqual(['a'])
  })

  it('.in() tiene solo le righe elencate; con elenco vuoto non tiene niente', async () => {
    const s = creaFintoSupabase(dbBase())
    expect(ids((await s.from('news').select('*').in('scuola_id', [A, B])).data)).toEqual(['a', 'b'])
    expect(ids((await s.from('news').select('*').in('scuola_id', [])).data)).toEqual([])
  })

  it('.or("scuola_id.is.null,scuola_id.in.(A)") = globali + sede A, MAI la sede B', async () => {
    const s = creaFintoSupabase(dbBase())
    const { data } = await s.from('news').select('*').or(`scuola_id.is.null,scuola_id.in.(${A})`)
    expect(ids(data)).toEqual(['a', 'g'])
  })

  it('.or("scuola_id.eq.A,scuola_id.is.null") = globali + sede A', async () => {
    const s = creaFintoSupabase(dbBase())
    const { data } = await s.from('news').select('*').or(`scuola_id.eq.${A},scuola_id.is.null`)
    expect(ids(data)).toEqual(['a', 'g'])
  })

  it('.or() è in AND con i filtri che lo precedono', async () => {
    const s = creaFintoSupabase(dbBase())
    const { data } = await s
      .from('news')
      .select('*')
      .eq('id', 'b')
      .or(`scuola_id.is.null,scuola_id.in.(${A})`)
    expect(ids(data)).toEqual([])
  })

  it('.or() con and(...) annidato', async () => {
    const s = creaFintoSupabase({
      media: [
        { id: 'm1', is_broadcast: true, target_classes: ['2 ANNI'] },
        { id: 'm2', is_broadcast: true, target_classes: ['3 ANNI'] },
        { id: 'm3', is_broadcast: false, target_classes: ['2 ANNI'], tag_students: ['s1'] },
      ],
    })
    const { data } = await s
      .from('media')
      .select('*')
      .or('and(is_broadcast.eq.true,target_classes.cs.{"2 ANNI"}),tag_students.ov.{s1}')
    expect(ids(data)).toEqual(['m1', 'm3'])
  })

  it('.neq() esclude il valore E le righe NULL (semantica SQL: NULL <> B è NULL)', async () => {
    const s = creaFintoSupabase(dbBase())
    const { data } = await s.from('news').select('*').neq('scuola_id', B)
    expect(ids(data)).toEqual(['a'])
  })

  it('.not(col, "eq", v) nega davvero', async () => {
    const s = creaFintoSupabase(dbBase())
    const { data } = await s.from('news').select('*').not('scuola_id', 'eq', B)
    expect(ids(data)).toEqual(['a'])
  })

  it('.is(col, null) tiene solo le righe globali', async () => {
    const s = creaFintoSupabase(dbBase())
    const { data } = await s.from('news').select('*').is('scuola_id', null)
    expect(ids(data)).toEqual(['g'])
  })

  it('.gte()/.lte() confrontano davvero (date ISO)', async () => {
    const s = creaFintoSupabase(dbBase())
    const { data } = await s
      .from('news')
      .select('*')
      .gte('pubblicato_il', '2026-03-02')
      .lte('pubblicato_il', '2026-03-02')
    expect(ids(data)).toEqual(['b'])
  })

  it('.order() ordina e .limit()/.range() tagliano dopo l\'ordinamento', async () => {
    const s = creaFintoSupabase(dbBase())
    const disc = await s.from('news').select('*').order('pubblicato_il', { ascending: false }).limit(1)
    expect(ids(disc.data)).toEqual(['g'])
    const pagina = await s.from('news').select('*').order('id', { ascending: true }).range(1, 1)
    expect(ids(pagina.data)).toEqual(['b'])
  })

  it('il join !inner: la riga senza nodo annidato viene esclusa', async () => {
    const s = creaFintoSupabase({
      certificati: [
        { id: 'c1', alunni: { scuola_id: A } },
        { id: 'c2', alunni: { scuola_id: B } },
        { id: 'c3' },
      ],
    })
    const { data } = await s.from('certificati').select('*, alunni!inner(scuola_id)').in('alunni.scuola_id', [A])
    expect(ids(data)).toEqual(['c1'])
  })

  it('select("*, alunni!inner(...)") esclude la riga senza nodo annidato, anche senza filtro sul campo interno', async () => {
    const s = creaFintoSupabase({
      certificati: [
        { id: 'c1', alunni: { scuola_id: A } },
        { id: 'c2', alunni: null },
        { id: 'c3' },
      ],
    })
    const { data } = await s.from('certificati').select('*, alunni!inner(scuola_id)')
    expect(ids(data)).toEqual(['c1'])
  })

  it('.contains() sugli array', async () => {
    const s = creaFintoSupabase({
      media: [
        { id: 'm1', tag_students: ['s1', 's2'] },
        { id: 'm2', tag_students: ['s3'] },
      ],
    })
    const { data } = await s.from('media').select('*').contains('tag_students', ['s1'])
    expect(ids(data)).toEqual(['m1'])
  })
})

describe('finto-supabase — le scritture avvengono davvero e restano registrate', () => {
  it('.delete().eq() rimuove SOLO la riga richiesta e lascia le altre', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    const s = creaFintoSupabase(db, [], { scritture })
    const { error } = await s.from('news').delete().eq('id', 'a')
    expect(error).toBeNull()
    expect(ids(db.news)).toEqual(['b', 'g'])
    expect(scritture).toEqual([
      expect.objectContaining({ tabella: 'news', operazione: 'delete' }),
    ])
    expect(ids(scritture[0].colpite)).toEqual(['a'])
  })

  it('.delete() con un filtro che non trova nulla non tocca niente', async () => {
    const db = dbBase()
    const s = creaFintoSupabase(db)
    await s.from('news').delete().eq('id', 'inesistente')
    expect(ids(db.news)).toEqual(['a', 'b', 'g'])
  })

  it('.insert() aggiunge la riga, la registra e la restituisce con .select().single()', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    const s = creaFintoSupabase(db, [], { scritture })
    const { data, error } = await s
      .from('news')
      .insert({ scuola_id: B, titolo: 'Nuova' })
      .select('id')
      .single()
    expect(error).toBeNull()
    expect((data as { id: string }).id).toEqual(expect.any(String))
    expect(db.news).toHaveLength(4)
    expect(scritture).toEqual([
      expect.objectContaining({ tabella: 'news', operazione: 'insert' }),
    ])
    expect(scritture[0].valori).toEqual([expect.objectContaining({ scuola_id: B, titolo: 'Nuova' })])
  })

  it('.insert() genera l\'id anche quando la route passa `id: undefined`', async () => {
    const db = dbBase()
    const s = creaFintoSupabase(db)
    const { data } = await s
      .from('news')
      .insert({ id: undefined, titolo: 'Senza id' })
      .select('id')
      .single()
    expect((data as { id: string }).id).toEqual(expect.any(String))
  })

  it('.insert() di un array registra tutte le righe (chi è finito nel DB e con quale sede)', async () => {
    const db: DBFinto = { utenti_scuole: [] }
    const scritture: Scrittura[] = []
    const s = creaFintoSupabase(db, [], { scritture })
    await s.from('utenti_scuole').insert([
      { utente_id: 'reale', scuola_id: A },
      { utente_id: 'collaudo', scuola_id: B },
    ])
    expect(scritture[0].valori.map((r) => r.utente_id)).toEqual(['reale', 'collaudo'])
    expect(db.utenti_scuole).toHaveLength(2)
  })

  it('.update() applica la patch SOLO alle righe filtrate', async () => {
    const db = dbBase()
    const s = creaFintoSupabase(db)
    await s.from('news').update({ titolo: 'Cambiato' }).eq('scuola_id', A)
    expect(db.news.map((r) => r.titolo)).toEqual(['Cambiato', 'Sede B', 'Globale'])
  })

  it('.upsert() aggiorna sull\'esistente e inserisce quando non c\'è', async () => {
    const db = dbBase()
    const s = creaFintoSupabase(db)
    await s.from('news').upsert([
      { id: 'a', titolo: 'Aggiornata' },
      { id: 'z', scuola_id: B, titolo: 'Creata' },
    ])
    expect(db.news).toHaveLength(4)
    expect(db.news.find((r) => r.id === 'a')?.titolo).toBe('Aggiornata')
    expect(db.news.find((r) => r.id === 'z')?.titolo).toBe('Creata')
  })

  it('.upsert({ onConflict }) usa le colonne indicate come chiave', async () => {
    const db: DBFinto = { presenze: [{ alunno_id: 'x', data: '2026-03-01', stato: 'assente' }] }
    const s = creaFintoSupabase(db)
    await s
      .from('presenze')
      .upsert({ alunno_id: 'x', data: '2026-03-01', stato: 'presente' }, { onConflict: 'alunno_id,data' })
    expect(db.presenze).toHaveLength(1)
    expect(db.presenze[0].stato).toBe('presente')
  })
})

describe('finto-supabase — quello che non sa fare lo dice, non lo nasconde', () => {
  it('un operatore non emulato LANCIA invece di passare avanti senza filtrare', async () => {
    const s = creaFintoSupabase(dbBase()) as unknown as { from: (t: string) => Record<string, unknown> }
    expect(() => s.from('news').textSearch).toThrow(/non emulato dal finto client/)
  })

  it('order/limit/or su tabella REFERENZIATA lanciano (bersaglio diverso, non emulato)', () => {
    const q = creaFintoSupabase(dbBase()).from('news').select('*') as unknown as {
      order: (c: string, o: object) => unknown
      limit: (n: number, o: object) => unknown
      or: (f: string, o: object) => unknown
    }
    expect(() => q.order('x', { referencedTable: 'alunni' })).toThrow(/non emulato/)
    expect(() => q.limit(1, { referencedTable: 'alunni' })).toThrow(/non emulato/)
    expect(() => q.or('id.eq.a', { referencedTable: 'alunni' })).toThrow(/non emulato/)
  })

  it('rpc() non configurata LANCIA', async () => {
    const s = creaFintoSupabase(dbBase())
    await expect(async () => await s.rpc('qualcosa', {})).rejects.toThrow(/rpc/)
  })

  it('rpc() configurata risponde', async () => {
    const s = creaFintoSupabase(dbBase(), [], {
      rpc: { somma: () => ({ data: 3, error: null }) },
    })
    const { data } = await s.rpc('somma', {})
    expect(data).toBe(3)
  })

  it('storage non configurato LANCIA (non un 500 silenzioso)', () => {
    const s = creaFintoSupabase(dbBase())
    expect(() => s.storage.from('bucket')).toThrow(/storage/)
  })
})

describe('finto-supabase — errori PostgREST e count', () => {
  it('l\'errore iniettato per tabella torna in { error } e blocca la scrittura', async () => {
    const db = dbBase()
    const s = creaFintoSupabase(db, [], { errori: { news: { code: '42703', message: 'colonna assente' } } })
    const lettura = await s.from('news').select('*')
    expect(lettura.data).toBeNull()
    expect((lettura.error as { code: string }).code).toBe('42703')

    await s.from('news').delete().eq('id', 'a')
    expect(ids(db.news)).toEqual(['a', 'b', 'g'])
  })

  it('l\'errore iniettato torna anche da maybeSingle()', async () => {
    const s = creaFintoSupabase(dbBase(), [], { errori: { news: { code: 'PGRST204' } } })
    const { data, error } = await s.from('news').select('*').eq('id', 'a').maybeSingle()
    expect(data).toBeNull()
    expect((error as { code: string }).code).toBe('PGRST204')
  })

  it('select("*", { count: "exact" }) restituisce il conteggio PRIMA del limit', async () => {
    const s = creaFintoSupabase(dbBase())
    const { data, count } = await s.from('news').select('*', { count: 'exact' }).limit(1)
    expect(count).toBe(3)
    expect((data as unknown[]).length).toBe(1)
  })

  it('select con head: true non restituisce righe ma il conteggio sì', async () => {
    const s = creaFintoSupabase(dbBase())
    const { data, count } = await s.from('news').select('*', { count: 'exact', head: true })
    expect(data).toBeNull()
    expect(count).toBe(3)
  })
})
