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

/** Due tabelle con righe collegate: serve alle scritture e all'errore per
 *  operazione, dove il punto è che la LETTURA riesca e la scrittura no. */
const dbScritture = (): DBFinto => ({
  alunni: [
    { id: 'a1', scuola_id: A, nome: 'Uno', archiviato_il: null },
    { id: 'a2', scuola_id: A, nome: 'Due', archiviato_il: null },
  ],
  chat_messages: [{ id: 'm1', alunno_id: 'a1', testo: 'ciao' }],
})

const ids = (righe: unknown): string[] =>
  ((righe ?? []) as { id: string }[]).map((r) => r.id).sort()

const codice = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

/** Il 23503 vero: `update or delete on table "alunni" violates foreign key constraint`. */
const VIOLAZIONE_FK = { code: '23503', message: 'violates foreign key constraint' }

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

  // ───────────────────────────────────────────────────────────────────────────
  // Le chiavi di `errori`. Sono la superficie che più facilmente tace: un
  // indirizzo che non colpisce niente non è un errore di sintassi, è un errore
  // che NON VIENE INIETTATO — `error` resta `null`, la riga viene cancellata
  // davvero, e il test che credeva di provare «respinta» prova il percorso
  // felice. Questi quattro casi sono stati MISURATI su una sonda prima di essere
  // chiusi: tutti e quattro passavano in silenzio.
  // ───────────────────────────────────────────────────────────────────────────
  it('una chiave `errori` con l\'operazione SBAGLIATA lancia invece di non iniettare niente', () => {
    for (const chiave of ['news:delele', 'news:DELETE', 'news:delete ', 'news: delete', 'news:']) {
      expect(
        () => creaFintoSupabase(dbBase(), [], { errori: { [chiave]: { code: '23503' } } }),
        `"${chiave}" doveva lanciare`,
      ).toThrow(/operazione non emulata/)
    }
  })

  it('una chiave `errori` con la TABELLA sbagliata lancia (il refuso è muto quanto l\'altro)', () => {
    expect(() => creaFintoSupabase(dbBase(), [], { errori: { new: { code: '42703' } } })).toThrow(
      /tabella non presente/,
    )
    expect(() =>
      creaFintoSupabase(dbBase(), [], { errori: { 'new:delete': { code: '23503' } } }),
    ).toThrow(/tabella non presente/)
  })

  it('le cinque operazioni valide e la chiave nuda NON lanciano', () => {
    for (const chiave of ['news', 'news:select', 'news:insert', 'news:update', 'news:upsert', 'news:delete']) {
      expect(
        () => creaFintoSupabase(dbBase(), [], { errori: { [chiave]: { code: '23503' } } }),
        `"${chiave}" non doveva lanciare`,
      ).not.toThrow()
    }
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

  // ───────────────────────────────────────────────────────────────────────────
  // L'errore indirizzato a `"<tabella>:<operazione>"`. Il perché sta tutto in un
  // posto solo — il commento di `erroreDi()` in `finto-supabase.ts` — comprese
  // la precedenza sulla chiave nuda, la misura del ramo che ha motivato la
  // chiave e i tre iniettori scritti a mano che questa deve assorbire.
  // ───────────────────────────────────────────────────────────────────────────
  it('la select RIESCE e la delete sulla STESSA tabella fallisce (la lettura prima della scrittura respinta)', async () => {
    const db = dbScritture()
    const scritture: Scrittura[] = []
    const s = creaFintoSupabase(db, [], { scritture, errori: { 'alunni:delete': VIOLAZIONE_FK } })

    // 1. la route legge l'alunno: deve trovarlo, o non arriva mai al ramo che ci interessa
    const lettura = await s.from('alunni').select('*').eq('id', 'a1').maybeSingle()
    expect(lettura.error).toBeNull()
    expect((lettura.data as { id: string } | null)?.id).toBe('a1')

    // 2. la route cancella: il DB rifiuta
    const cancellazione = await s.from('alunni').delete().eq('id', 'a1')
    expect(codice(cancellazione.error)).toBe('23503')

    // 3. e la riga È ANCORA LÌ: un errore che non blocca la scrittura è peggio di nessun errore
    expect(ids(db.alunni)).toEqual(['a1', 'a2'])
    expect(scritture).toEqual([])
  })

  it('la forma VERA della route: .delete().eq().in().select("id") propaga l\'errore e non tocca la riga', async () => {
    // `src/app/api/admin/students/route.ts` cancella così — filtro di sede
    // compreso, e con la `.select('id')` che serve a distinguere «respinta» da
    // «zero righe». È la forma che questa chiave esiste per rappresentare:
    // provarla su `.delete().eq()` e basta lascerebbe scoperto proprio il pezzo
    // in cui `selezionato` e `operazione` si incrociano.
    const db = dbScritture()
    const s = creaFintoSupabase(db, [], { errori: { 'alunni:delete': VIOLAZIONE_FK } })

    const { data, error } = await s.from('alunni').delete().eq('id', 'a1').in('scuola_id', [A]).select('id')
    expect(codice(error)).toBe('23503')
    expect(data).toBeNull()
    expect(ids(db.alunni)).toEqual(['a1', 'a2'])

    // e senza iniezione la STESSA catena cancella davvero e restituisce l'id:
    // il test sopra prova l'errore, questo prova che non è verde per inerzia.
    const dbPulito = dbScritture()
    const pulito = creaFintoSupabase(dbPulito, [])
    const ok = await pulito.from('alunni').delete().eq('id', 'a1').in('scuola_id', [A]).select('id')
    expect(ok.error).toBeNull()
    expect(ids(ok.data)).toEqual(['a1'])
    expect(ids(dbPulito.alunni)).toEqual(['a2'])
  })

  it('la chiave NUDA continua a valere per TUTTE le operazioni (retrocompatibilità)', async () => {
    const db = dbScritture()
    const s = creaFintoSupabase(db, [], { errori: { alunni: { code: '42703' } } })

    expect(codice((await s.from('alunni').select('*')).error)).toBe('42703')
    expect(codice((await s.from('alunni').insert({ id: 'a3' })).error)).toBe('42703')
    expect(codice((await s.from('alunni').update({ nome: 'X' }).eq('id', 'a1')).error)).toBe('42703')
    expect(codice((await s.from('alunni').upsert({ id: 'a1', nome: 'X' })).error)).toBe('42703')
    expect(codice((await s.from('alunni').delete().eq('id', 'a1')).error)).toBe('42703')

    expect(ids(db.alunni)).toEqual(['a1', 'a2'])
  })

  it('la chiave specifica non interferisce con le ALTRE operazioni della stessa tabella', async () => {
    const db = dbScritture()
    const s = creaFintoSupabase(db, [], { errori: { 'alunni:update': { code: 'PGRST204' } } })

    expect(codice((await s.from('alunni').update({ nome: 'X' }).eq('id', 'a1')).error)).toBe('PGRST204')
    // le altre passano, e passano DAVVERO: il DB cambia
    expect((await s.from('alunni').select('*')).error).toBeNull()
    expect((await s.from('alunni').insert({ id: 'a3', scuola_id: A }).select()).error).toBeNull()
    expect((await s.from('alunni').delete().eq('id', 'a2')).error).toBeNull()
    expect(ids(db.alunni)).toEqual(['a1', 'a3'])
    // e l'update respinto non ha toccato la riga
    expect((db.alunni.find((r) => r.id === 'a1') as { nome: string }).nome).toBe('Uno')
  })

  it('la chiave specifica non interferisce con le ALTRE TABELLE', async () => {
    const db = dbScritture()
    const s = creaFintoSupabase(db, [], { errori: { 'alunni:delete': VIOLAZIONE_FK } })

    expect(codice((await s.from('alunni').delete().eq('id', 'a1')).error)).toBe('23503')
    expect((await s.from('chat_messages').delete().eq('alunno_id', 'a1')).error).toBeNull()
    expect(ids(db.chat_messages)).toEqual([])
  })

  it('con ENTRAMBE le chiavi vince la specifica, e la nuda copre il resto', async () => {
    const s = creaFintoSupabase(dbScritture(), [], {
      errori: { alunni: { code: '42703' }, 'alunni:delete': VIOLAZIONE_FK },
    })

    expect(codice((await s.from('alunni').delete().eq('id', 'a1')).error)).toBe('23503')
    expect(codice((await s.from('alunni').select('*')).error)).toBe('42703')
    expect(codice((await s.from('alunni').update({ nome: 'X' })).error)).toBe('42703')
  })

  it('ogni operazione ha la sua chiave: select · insert · update · upsert · delete', async () => {
    const casi: [string, (s: ReturnType<typeof creaFintoSupabase>) => PromiseLike<unknown>][] = [
      ['alunni:select', (s) => s.from('alunni').select('*')],
      ['alunni:insert', (s) => s.from('alunni').insert({ id: 'a9' })],
      ['alunni:update', (s) => s.from('alunni').update({ nome: 'X' })],
      ['alunni:upsert', (s) => s.from('alunni').upsert({ id: 'a1', nome: 'X' })],
      ['alunni:delete', (s) => s.from('alunni').delete().eq('id', 'a1')],
    ]

    for (let i = 0; i < casi.length; i++) {
      const [chiave, esegui] = casi[i]
      const s = creaFintoSupabase(dbScritture(), [], { errori: { [chiave]: { code: 'P0001' } } })
      const esito = (await esegui(s)) as { error: unknown }
      expect(codice(esito.error), `${chiave} doveva fallire`).toBe('P0001')

      // e con la chiave di UN'ALTRA operazione VERA (la successiva, a giro) lo
      // stesso comando passa: le cinque chiavi non si contaminano a vicenda.
      const altra = casi[(i + 1) % casi.length][0]
      const pulito = creaFintoSupabase(dbScritture(), [], { errori: { [altra]: { code: 'P0001' } } })
      const passa = (await esegui(pulito)) as { error: unknown }
      expect(passa.error, `${chiave} non doveva essere toccata da ${altra}`).toBeNull()
    }
  })

  it('"<tabella>:select" copre lista, single(), maybeSingle() e il conteggio', async () => {
    const s = creaFintoSupabase(dbScritture(), [], { errori: { 'alunni:select': { code: '42703' } } })

    expect(codice((await s.from('alunni').select('*')).error)).toBe('42703')

    const uno = await s.from('alunni').select('*').eq('id', 'a1').single()
    expect(uno.data).toBeNull()
    expect(codice(uno.error)).toBe('42703')

    const forse = await s.from('alunni').select('*').eq('id', 'a1').maybeSingle()
    expect(forse.data).toBeNull()
    expect(codice(forse.error)).toBe('42703')

    // anche il conteggio, che è la lettura che le route usano per i badge
    const conta = await s.from('alunni').select('*', { count: 'exact', head: true })
    expect(codice(conta.error)).toBe('42703')
    expect(conta.count).toBeNull()
  })

  it('`await from(tabella)` senza select/insert/… LANCIA: il client vero non la esegue', async () => {
    // `from()` restituisce un `PostgrestQueryBuilder`, che non è thenable —
    // lo è solo il builder che tornano `.select()` e le scritture. Qui i due
    // sono un oggetto solo: senza questo presidio il finto client eseguirebbe
    // una query che in produzione non parte, e restituirebbe righe che nessuna
    // route riceverebbe mai. È la trappola del mock che tace, al rovescio.
    const s = creaFintoSupabase(dbScritture())
    await expect(s.from('alunni') as unknown as Promise<unknown>).rejects.toThrow(/non è una query/)
  })

  it('la lettura RIESCE anche quando è la insert a essere zittita (il caso «carico e poi registro»)', async () => {
    const db = dbScritture()
    const s = creaFintoSupabase(db, [], { errori: { 'chat_messages:insert': { code: '42501' } } })

    const letti = await s.from('chat_messages').select('*')
    expect(ids(letti.data)).toEqual(['m1'])
    expect(codice((await s.from('chat_messages').insert({ id: 'm2' })).error)).toBe('42501')
    expect(ids(db.chat_messages)).toEqual(['m1'])
  })

  it('con throwOnError() l\'errore per operazione LANCIA invece di tornare in { error }', async () => {
    const s = creaFintoSupabase(dbScritture(), [], { errori: { 'alunni:delete': VIOLAZIONE_FK } })
    await expect(s.from('alunni').delete().eq('id', 'a1').throwOnError()).rejects.toMatchObject({
      code: '23503',
    })
  })

  it('lo status dell\'errore è quello che PostgREST servirebbe, non 400 per tutti', async () => {
    // Una FK che respinge una DELETE è un 409 Conflict; il 400 è della colonna
    // che non esiste. Rappresentare il primo con la faccia del secondo è
    // insegnare il falso a chi legge il fixture per scrivere il test dopo.
    const attesi: [string, number, string][] = [
      ['23503', 409, 'Conflict'], // FK: lo storico si difende
      ['23505', 409, 'Conflict'], // unique
      ['42501', 403, 'Forbidden'], // permesso negato
      ['42P01', 404, 'Not Found'], // tabella inesistente
      ['42703', 400, 'Bad Request'], // colonna inesistente: qui il 400 è giusto
      ['PGRST204', 400, 'Bad Request'], // colonna assente dalla cache: idem
      ['08006', 503, 'Service Unavailable'], // connessione caduta
    ]
    for (const [code, status, statusText] of attesi) {
      const s = creaFintoSupabase(dbScritture(), [], { errori: { alunni: { code } } })
      const esito = await s.from('alunni').select('*')
      expect(esito.status, `${code} → status`).toBe(status)
      expect(esito.statusText, `${code} → statusText`).toBe(statusText)
    }
  })
})
