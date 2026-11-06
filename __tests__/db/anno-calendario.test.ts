// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { creaDbAnno } from '../helpers/schema-anno-pglite'

/**
 * ANNO SCOLASTICO · IL CALENDARIO (Compito 1.1).
 *
 * Il SQL gira in PostgreSQL vero (PGlite): i vincoli (EXCLUDE, indice unico parziale, trigger di
 * continuità differito) esistono solo lì. Nessun test dipende da OGGI: le date dei test sono
 * fisse (`anni_sede_crea_per_sede(sede, '2026-11-06')`) e le prove sulla data vera sono RELATIVE
 * a `giorno_roma(now())`: una data cablata scade.
 *
 * Solo uuid finti, mai quelli di una sede reale (repo pubblico).
 */

const SEDE = '22222222-2222-4222-8222-222222222201'
const SEDE_ALTRA = '22222222-2222-4222-8222-222222222202'
const SEDE_PRIMA = '22222222-2222-4222-8222-222222222203'

let db: PGlite

/** Svuota il calendario: ogni test parte da zero e non dipende da quelli prima. */
async function pulisci(): Promise<void> {
  await db.exec(`
    DELETE FROM public.anni_sede_stati;
    DELETE FROM public.anni_sede;
    DELETE FROM public.anni_scolastici;
    DELETE FROM public.schools;
  `)
}

/** Una sede senza alcun anno: il trigger di `schools` li crea alla data VERA, qui si tolgono. */
async function sedeVuota(id: string): Promise<void> {
  await pulisci()
  await db.query('INSERT INTO public.schools (id, nome) VALUES ($1, $2)', [id, 'Sede di prova'])
  await db.exec('DELETE FROM public.anni_sede_stati; DELETE FROM public.anni_sede; DELETE FROM public.anni_scolastici;')
}

/** Una sede con gli anni calcolati a una data FISSA (la funzione che usa anche la migrazione). */
async function sedeAData(id: string, oggi: string): Promise<void> {
  await sedeVuota(id)
  await db.query('SELECT public.anni_sede_crea_per_sede($1, $2::date)', [id, oggi])
}

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}

/** `etichetta`: l'anno e lo stato di una sede, per leggere i risultati in chiaro. */
async function statiDiSede(id: string): Promise<Record<string, string>> {
  const r = await db.query<{ etichetta: string; stato: string }>(
    `SELECT a.etichetta, s.stato FROM public.anni_sede s
       JOIN public.anni_scolastici a ON a.id = s.anno_id WHERE s.scuola_id = $1`,
    [id],
  )
  return Object.fromEntries(r.rows.map((x) => [x.etichetta, x.stato]))
}

beforeAll(async () => {
  db = await creaDbAnno()
})

afterAll(async () => {
  await db.close()
})

describe('giorno_roma: il giorno è quello di Roma, non quello UTC', () => {
  it.each([
    ['2026-08-31T22:30:00Z', '2026-09-01'], // 00:30 del 1/9 a Roma, in UTC è ancora il 31/8
    ['2026-07-31T22:30:00Z', '2026-08-01'],
    ['2026-10-25T00:30:00Z', '2026-10-25'], // giorno del cambio d'ora (fine ora legale)
    ['2027-03-28T01:30:00Z', '2027-03-28'], // giorno del cambio d'ora (inizio ora legale)
    ['2026-07-31T21:30:00Z', '2026-07-31'], // 23:30 del 31/7 a Roma
    ['2026-08-31T21:30:00Z', '2026-08-31'],
    ['2026-12-31T23:30:00Z', '2027-01-01'], // inverno: Roma è UTC+1
    ['2026-12-31T22:30:00Z', '2026-12-31'],
    ['2027-01-15T10:00:00Z', '2027-01-15'],
  ])('giorno_roma(%s) = %s', async (istante, atteso) => {
    expect(await una<string>('SELECT public.giorno_roma($1::timestamptz)::text', [istante])).toBe(atteso)
  })
})

describe('anni_scolastici: le colonne generate, nessuna data scritta a mano', () => {
  it('etichette e date predefinite vengono da anno_inizio', async () => {
    await pulisci()
    await db.query('INSERT INTO public.anni_scolastici (anno_inizio) VALUES (2026)')
    const r = await db.query<Record<string, string>>(
      `SELECT etichetta, etichetta_breve, inizio_predefinito::text AS i, fine_predefinita::text AS f
         FROM public.anni_scolastici WHERE anno_inizio = 2026`,
    )
    expect(r.rows[0]).toMatchObject({
      etichetta: '2026/2027',
      etichetta_breve: '2026/27',
      i: '2026-09-01',
      f: '2027-08-31',
    })
  })

  it('anno_inizio fuori da 2000..2100 è rifiutato', async () => {
    await expect(db.query('INSERT INTO public.anni_scolastici (anno_inizio) VALUES (1999)')).rejects.toMatchObject({
      code: '23514',
    })
  })
})

describe('anno_di e le funzioni con data fissa', () => {
  it('il 31/08 è ancora il 2025/26, il 01/09 è il 2026/27', async () => {
    await sedeAData(SEDE, '2026-11-06')
    const anno = (g: string) =>
      una<string>(
        `SELECT a.etichetta FROM public.anni_scolastici a WHERE a.id = public.anno_di($1, $2::date)`,
        [SEDE, g],
      )
    expect(await anno('2026-08-31')).toBe('2025/2026')
    expect(await anno('2026-09-01')).toBe('2026/2027')
  })

  it('un giorno fuori da ogni anno della sede non ha anno (NULL, non un errore)', async () => {
    await sedeAData(SEDE, '2026-11-06')
    expect(await una<string | null>('SELECT public.anno_di($1, $2::date)', [SEDE, '2020-01-01'])).toBeNull()
  })

  it('anno_sede_di dà la riga della sede per quell\'anno', async () => {
    await sedeAData(SEDE, '2026-11-06')
    const r = await una<boolean>(
      `SELECT public.anno_sede_di($1, a.id) = s.id
         FROM public.anni_scolastici a JOIN public.anni_sede s ON s.anno_id = a.id AND s.scuola_id = $1
        WHERE a.anno_inizio = 2026`,
      [SEDE],
    )
    expect(r).toBe(true)
  })

  it('a 2026-11-06: 2025/26 chiuso, 2026/27 corrente, con le date del §4.4.1', async () => {
    await sedeAData(SEDE, '2026-11-06')
    expect(await statiDiSede(SEDE)).toEqual({ '2025/2026': 'chiuso', '2026/2027': 'corrente' })
    const r = await db.query<Record<string, string>>(
      `SELECT a.anno_inizio::text AS aa, s.inizio::text AS i, s.fine::text AS f,
              s.ultimo_giorno_aperto::text AS u, s.prepara_successivo_dal::text AS p
         FROM public.anni_sede s JOIN public.anni_scolastici a ON a.id = s.anno_id
        WHERE s.scuola_id = $1 ORDER BY a.anno_inizio`,
      [SEDE],
    )
    expect(r.rows[1]).toEqual({
      aa: '2026', i: '2026-09-01', f: '2027-08-31', u: '2027-07-31', p: '2026-09-01',
    })
    expect(r.rows[0]).toMatchObject({ u: '2026-07-31', p: '2025-09-01' })
  })

  it('a 2027-08-15 il 2026/27 è in_chiusura (agosto: oltre l\'ultimo giorno aperto)', async () => {
    await sedeAData(SEDE, '2027-08-15')
    const stati = await statiDiSede(SEDE)
    expect(stati['2026/2027']).toBe('in_chiusura')
    expect(stati['2025/2026']).toBe('chiuso')
  })

  it('ogni anno creato lascia la sua riga nella storia degli stati', async () => {
    await sedeAData(SEDE, '2026-11-06')
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.anni_sede_stati t
         JOIN public.anni_sede s ON s.id = t.anno_sede_id WHERE s.scuola_id = $1`,
      [SEDE],
    )
    expect(r.rows[0].n).toBe('2')
  })

  it('anno_attivo: fra corrente, in_chiusura e chiuso, l\'inizio più recente', async () => {
    await sedeAData(SEDE, '2026-11-06')
    const etichetta = (p: string) =>
      una<string>(
        `SELECT a.etichetta FROM public.anni_sede s JOIN public.anni_scolastici a ON a.id = s.anno_id
          WHERE s.id = public.anno_attivo($1)`,
        [p],
      )
    expect(await etichetta(SEDE)).toBe('2026/2027')
    await sedeAData(SEDE, '2027-08-15')
    expect(await etichetta(SEDE)).toBe('2026/2027') // in agosto è ancora l'anno vecchio
  })

  it('anni_sede_crea_per_sede è idempotente', async () => {
    await sedeAData(SEDE, '2026-11-06')
    expect(await una<number>('SELECT public.anni_sede_crea_per_sede($1, $2::date)', [SEDE, '2026-11-06'])).toBe(0)
    expect(Object.keys(await statiDiSede(SEDE))).toHaveLength(2)
  })
})

describe('i vincoli del calendario', () => {
  /** Due anni vicini, lontani da quelli veri (2040/41 e 2041/42), scritti a mano per provare i vincoli. */
  async function dueAnni(): Promise<{ a: string; b: string }> {
    // Le due sedi nascono PRIMA degli anni di prova: il trigger di `schools` dà a una sede nuova
    // tutti gli anni che esistono, e i 2040/41 non sarebbero contigui a quelli veri.
    await pulisci()
    await db.query('INSERT INTO public.schools (id, nome) VALUES ($1, $3), ($2, $3)', [SEDE, SEDE_ALTRA, 'Sede di prova'])
    await db.exec('DELETE FROM public.anni_sede_stati; DELETE FROM public.anni_sede; DELETE FROM public.anni_scolastici;')
    const r = await db.query<{ id: string; anno_inizio: number }>(
      'INSERT INTO public.anni_scolastici (anno_inizio) VALUES (2040), (2041) RETURNING id, anno_inizio',
    )
    return {
      a: r.rows.find((x) => x.anno_inizio === 2040)!.id,
      b: r.rows.find((x) => x.anno_inizio === 2041)!.id,
    }
  }
  const inserisci = (anno: string, inizio: string, fine: string, stato = 'in_preparazione', sede = SEDE) =>
    db.query(
      `INSERT INTO public.anni_sede (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
       VALUES ($1, $2, $3::date, $4::date, $5, $3::date, $3::date)`,
      [sede, anno, inizio, fine, stato],
    )

  it('due periodi sovrapposti nella stessa sede: errore di esclusione (23P01)', async () => {
    const { a, b } = await dueAnni()
    await inserisci(a, '2040-09-01', '2041-08-31')
    await expect(inserisci(b, '2041-06-01', '2042-05-31')).rejects.toMatchObject({ code: '23P01' })
  })

  it('lo stesso periodo in due sedi diverse è lecito', async () => {
    const { a } = await dueAnni()
    await inserisci(a, '2040-09-01', '2041-08-31')
    await inserisci(a, '2040-09-01', '2041-08-31', 'in_preparazione', SEDE_ALTRA)
  })

  it('un buco fra due anni è rifiutato alla COMMIT (vincolo differito)', async () => {
    const { a, b } = await dueAnni()
    await db.exec('BEGIN')
    await inserisci(a, '2040-09-01', '2041-08-31')
    await inserisci(b, '2041-09-05', '2042-08-31') // salta 1-4 settembre
    await expect(db.exec('COMMIT')).rejects.toMatchObject({ message: expect.stringContaining('CALENDARIO_NON_CONTINUO') })
    await db.exec('ROLLBACK').catch(() => undefined)
    expect(await una<string>('SELECT count(*)::text FROM public.anni_sede WHERE scuola_id = $1', [SEDE])).toBe('0')
  })

  it('due anni contigui passano alla COMMIT', async () => {
    const { a, b } = await dueAnni()
    await db.exec('BEGIN')
    await inserisci(a, '2040-09-01', '2041-08-31')
    await inserisci(b, '2041-09-01', '2042-08-31')
    await db.exec('COMMIT')
    expect(await una<string>('SELECT count(*)::text FROM public.anni_sede WHERE scuola_id = $1', [SEDE])).toBe('2')
  })

  it('il confine si sposta nella stessa transazione (fine di uno e inizio dell\'altro)', async () => {
    const { a, b } = await dueAnni()
    await inserisci(a, '2040-09-01', '2041-08-31')
    await inserisci(b, '2041-09-01', '2042-08-31')
    await db.exec('BEGIN')
    try {
      // Prima si allunga A: per un istante A e B si sovrappongono. Con l'EXCLUDE immediato sarebbe 23P01.
      await db.query('UPDATE public.anni_sede SET fine = $1::date, ultimo_giorno_aperto = $2::date WHERE anno_id = $3', ['2041-09-14', '2041-07-31', a])
      await db.query('UPDATE public.anni_sede SET inizio = $1::date, prepara_successivo_dal = $1::date, ultimo_giorno_aperto = $1::date WHERE anno_id = $2', ['2041-09-15', b])
      await db.exec('COMMIT')
    } catch (e) {
      await db.exec('ROLLBACK')
      throw e
    }
    expect(await una<string>('SELECT fine::text FROM public.anni_sede WHERE anno_id = $1', [a])).toBe('2041-09-14')
  })

  it('un secondo corrente nella stessa sede: errore di unicità (23505)', async () => {
    const { a, b } = await dueAnni()
    await inserisci(a, '2040-09-01', '2041-08-31', 'corrente')
    await expect(inserisci(b, '2041-09-01', '2042-08-31', 'corrente')).rejects.toMatchObject({ code: '23505' })
  })

  it('stato fuori elenco, fine <= inizio, date di servizio fuori dall\'anno: CHECK (23514)', async () => {
    const { a } = await dueAnni()
    await expect(inserisci(a, '2040-09-01', '2041-08-31', 'sospeso')).rejects.toMatchObject({ code: '23514' })
    await expect(inserisci(a, '2040-09-01', '2040-09-01')).rejects.toMatchObject({ code: '23514' })
    await expect(
      db.query(
        `INSERT INTO public.anni_sede (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
         VALUES ($1, $2, '2040-09-01', '2041-08-31', 'in_preparazione', '2041-09-30', '2040-09-01')`,
        [SEDE, a],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      db.query(
        `INSERT INTO public.anni_sede (scuola_id, anno_id, inizio, fine, stato, ultimo_giorno_aperto, prepara_successivo_dal)
         VALUES ($1, $2, '2040-09-01', '2041-08-31', 'in_preparazione', '2041-07-31', '2039-01-01')`,
        [SEDE, a],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('la stessa sede non ha due volte lo stesso anno (23505)', async () => {
    const { a } = await dueAnni()
    await inserisci(a, '2040-09-01', '2041-08-31')
    await expect(inserisci(a, '2050-09-01', '2051-08-31')).rejects.toMatchObject({ code: '23505' })
  })
})

describe('una sede nuova riceve subito i suoi anni (trigger su schools)', () => {
  it('gli anni nascono con gli stati del §4.4.1, calcolati sul giorno di Roma di adesso', async () => {
    await pulisci()
    await db.query('INSERT INTO public.schools (id, nome) VALUES ($1, $2)', [SEDE, 'Sede nuova'])
    const oggi = await una<string>('SELECT public.giorno_roma(now())::text')
    const r = await db.query<{ inizio: string; fine: string; stato: string; u: string; p: string; anno: number }>(
      `SELECT s.inizio::text AS inizio, s.fine::text AS fine, s.stato, s.ultimo_giorno_aperto::text AS u,
              s.prepara_successivo_dal::text AS p, a.anno_inizio AS anno
         FROM public.anni_sede s JOIN public.anni_scolastici a ON a.id = s.anno_id
        WHERE s.scuola_id = $1 ORDER BY s.inizio`,
      [SEDE],
    )
    expect(r.rows.length).toBeGreaterThanOrEqual(2)
    // L'anno che contiene oggi c'è, e quello prima c'è ed è chiuso.
    const idx = r.rows.findIndex((x) => x.inizio <= oggi && oggi <= x.fine)
    expect(idx).toBeGreaterThanOrEqual(1)
    const att = r.rows[idx]
    expect(att.stato).toBe(oggi > att.u ? 'in_chiusura' : 'corrente')
    expect(r.rows[idx - 1].stato).toBe('chiuso')
    for (const x of r.rows.slice(idx + 1)) expect(x.stato).toBe('in_preparazione')
    for (const x of r.rows) {
      expect(x.u).toBe(`${x.anno + 1}-07-31`)
      expect(x.p).toBe(x.inizio)
      expect(x.inizio).toBe(`${x.anno}-09-01`)
      expect(x.fine).toBe(`${x.anno + 1}-08-31`)
    }
  })
})

describe('una sede nuova riceve ANCHE gli anni che esistono già (remoti, passati, futuri)', () => {
  const ANNI = (da: number, a: number) =>
    Array.from({ length: a - da + 1 }, (_, i) => `(${da + i})`).join(', ')

  it('con p_oggi fisso: il remoto e il precedente chiusi, il corrente corrente, il futuro in_preparazione', async () => {
    await pulisci()
    await db.query('INSERT INTO public.schools (id, nome) VALUES ($1, $2)', [SEDE, 'Sede di prova'])
    await db.exec('DELETE FROM public.anni_sede_stati; DELETE FROM public.anni_sede; DELETE FROM public.anni_scolastici;')
    await db.exec(`INSERT INTO public.anni_scolastici (anno_inizio) VALUES ${ANNI(2022, 2028)}`)
    await db.query('SELECT public.anni_sede_crea_per_sede($1, $2::date)', [SEDE, '2026-11-06'])
    expect(await statiDiSede(SEDE)).toEqual({
      '2022/2023': 'chiuso', '2023/2024': 'chiuso', '2024/2025': 'chiuso', '2025/2026': 'chiuso',
      '2026/2027': 'corrente', '2027/2028': 'in_preparazione', '2028/2029': 'in_preparazione',
    })
  })

  it('passando dal trigger su schools: gli stati seguono il giorno di Roma di adesso', async () => {
    await pulisci()
    const oggi = await una<string>('SELECT public.giorno_roma(now())::text')
    const anno = Number(oggi.slice(0, 4)) - (Number(oggi.slice(5, 7)) >= 9 ? 0 : 1)
    // Gli anni esistono PRIMA della sede: remoto (-5), passati, quello di oggi, due futuri.
    await db.exec(`INSERT INTO public.anni_scolastici (anno_inizio) VALUES ${ANNI(anno - 5, anno + 2)}`)
    await db.query('INSERT INTO public.schools (id, nome) VALUES ($1, $2)', [SEDE, 'Sede nuova'])
    const stati = await statiDiSede(SEDE)
    const et = (a: number) => `${a}/${a + 1}`
    expect(Object.keys(stati)).toHaveLength(8)
    expect(stati[et(anno - 5)]).toBe('chiuso')
    expect(stati[et(anno - 1)]).toBe('chiuso')
    expect(stati[et(anno)]).toBe(oggi > `${anno + 1}-07-31` ? 'in_chiusura' : 'corrente')
    expect(stati[et(anno + 1)]).toBe('in_preparazione')
    expect(stati[et(anno + 2)]).toBe('in_preparazione')
  })
})

describe('le sezioni dopo la migrazione stanno nella stessa transazione', () => {
  it('un ALTER TABLE su anni_sede accodato alla migrazione passa (la coda differita è scaricata)', async () => {
    // Con una sede già presente il blocco di recupero ha messo in coda i trigger differiti.
    const dbCoda = await creaDbAnno({
      sediPrimaDellaMigrazione: [SEDE_PRIMA],
      codaDopo: 'ALTER TABLE public.anni_sede ADD COLUMN prova int; ALTER TABLE public.anni_sede_stati ADD COLUMN prova int;',
    })
    try {
      const r = await dbCoda.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.columns
          WHERE table_name IN ('anni_sede', 'anni_sede_stati') AND column_name = 'prova'`,
      )
      expect(r.rows[0].n).toBe('2')
    } finally {
      await dbCoda.close()
    }
  })
})

describe('dopo la migrazione, la sede che c\'era già ha i suoi anni (relativo a oggi)', () => {
  it('l\'anno che contiene oggi è corrente (o in_chiusura ad agosto), quello prima è chiuso', async () => {
    // Un DB a parte: SEDE_PRIMA esiste PRIMA della migrazione, come in produzione, e gli altri test
    // ripuliscono il calendario del DB condiviso.
    const dbMig = await creaDbAnno({ sediPrimaDellaMigrazione: [SEDE_PRIMA] })
    try {
      const oggi = (await dbMig.query<{ g: string }>('SELECT public.giorno_roma(now())::text AS g')).rows[0].g
      const r = await dbMig.query<{ inizio: string; fine: string; stato: string; u: string; p: string }>(
        `SELECT inizio::text, fine::text, stato, ultimo_giorno_aperto::text AS u, prepara_successivo_dal::text AS p
           FROM public.anni_sede WHERE scuola_id = $1 ORDER BY inizio`,
        [SEDE_PRIMA],
      )
      expect(r.rows.length).toBeGreaterThanOrEqual(2)
      const idx = r.rows.findIndex((x) => x.inizio <= oggi && oggi <= x.fine)
      expect(idx).toBeGreaterThanOrEqual(1)
      const att = r.rows[idx]
      expect(att.stato).toBe(oggi > att.u ? 'in_chiusura' : 'corrente')
      expect(r.rows[idx - 1].stato).toBe('chiuso')
      expect(att.u).toBe(`${att.fine.slice(0, 4)}-07-31`)
      expect(att.p).toBe(att.inizio)
    } finally {
      await dbMig.close()
    }
  })
})

describe('sicurezza: tabelle e funzioni chiuse a anon e authenticated', () => {
  it('le tabelle nuove hanno la RLS accesa e nessuna policy', async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('anni_scolastici', 'anni_sede', 'anni_sede_stati') ORDER BY relname`,
    )
    expect(r.rows).toEqual([
      { relname: 'anni_scolastici', relrowsecurity: true },
      { relname: 'anni_sede', relrowsecurity: true },
      { relname: 'anni_sede_stati', relrowsecurity: true },
    ])
    expect(await una<string>(`SELECT count(*)::text FROM pg_policies WHERE tablename LIKE 'anni_%'`)).toBe('0')
  })

  it.each([
    ['giorno_roma(timestamptz)', 'SELECT public.giorno_roma(now())'],
    ['anno_di(uuid,date)', `SELECT public.anno_di('${SEDE}', current_date)`],
    ['anno_attivo(uuid)', `SELECT public.anno_attivo('${SEDE}')`],
  ])('%s: anon e authenticated non possono eseguirla, service_role sì', async (_n, sql) => {
    for (const ruolo of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${ruolo}`)
      await expect(db.query(sql)).rejects.toMatchObject({ code: '42501' })
      await db.exec('RESET ROLE')
    }
    await db.exec('SET ROLE service_role')
    await expect(db.query(sql)).resolves.toBeDefined()
    await db.exec('RESET ROLE')
  })

  it('TUTTE le funzioni di public: EXECUTE chiuso a anon, authenticated e PUBLIC, aperto a service_role', async () => {
    // Con i DEFAULT PRIVILEGES di Supabase (nell'aiuto) un REVOKE dimenticato lascia la funzione aperta.
    const r = await db.query<{ f: string; anon: boolean; auth: boolean; pubblico: boolean; servizio: boolean }>(
      `SELECT p.oid::regprocedure::text AS f,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              coalesce(bool_or(a.grantee = 0), false) AS pubblico,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS servizio
         FROM pg_proc p LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
        WHERE p.pronamespace = 'public'::regnamespace
        GROUP BY p.oid ORDER BY 1`,
    )
    const nomi = r.rows.map((x) => x.f.replace(/^public\./, '').replace(/\(.*/, '')).sort()
    expect(nomi).toEqual([
      'anni_sede_controlla_continuita', 'anni_sede_crea_per_sede', 'anno_attivo', 'anno_di',
      'anno_sede_di', 'giorno_roma', 'schools_crea_anni',
    ].sort())
    for (const x of r.rows) {
      expect(x, x.f).toMatchObject({ anon: false, auth: false, pubblico: false, servizio: true })
    }
  })

  it('TUTTE le tabelle nuove: nessun privilegio ad anon e authenticated, tutti a service_role', async () => {
    for (const t of ['anni_scolastici', 'anni_sede', 'anni_sede_stati']) {
      for (const ruolo of ['anon', 'authenticated']) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect(await una<boolean>('SELECT has_table_privilege($1, $2, $3)', [ruolo, `public.${t}`, p]), `${ruolo} ${p} ${t}`).toBe(false)
        }
      }
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(await una<boolean>('SELECT has_table_privilege($1, $2, $3)', ['service_role', `public.${t}`, p]), `service_role ${p} ${t}`).toBe(true)
      }
    }
  })

  it('le tabelle non si toccano da anon e authenticated (permesso negato)', async () => {
    for (const ruolo of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${ruolo}`)
      await expect(db.query('SELECT * FROM public.anni_sede')).rejects.toMatchObject({ code: '42501' })
      await db.exec('RESET ROLE')
    }
  })
})
