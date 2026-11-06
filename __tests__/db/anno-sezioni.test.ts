import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnno, fileMigrazioneAnno } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 1.2 · SEZIONI. Ogni sezione ha il suo anno, il nome è unico per (sede, anno), e le due
 * funzioni di oggi che cercano o propagano per NOME guardano solo l'anno attivo. Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_B = '22222222-2222-4222-8222-222222222223'
const SEZ_PRIMA = '33333333-3333-4333-8333-333333333331'
const SEZ_PRIMA_2 = '33333333-3333-4333-8333-333333333332'

let db: PGlite

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}

/** L'anno attivo della sede (`anni_scolastici.id`) e quello precedente. */
async function annoAttivo(sede = SEDE): Promise<string> {
  return una<string>(
    `SELECT s.anno_id FROM public.anni_sede s WHERE s.id = public.anno_attivo($1)`, [sede])
}
async function annoPrecedente(sede = SEDE): Promise<string> {
  return una<string>(
    `SELECT s.anno_id FROM public.anni_sede s JOIN public.anni_scolastici a ON a.id = s.anno_id
      WHERE s.scuola_id = $1 AND a.anno_inizio = (SELECT a2.anno_inizio - 1 FROM public.anni_scolastici a2
                                                   WHERE a2.id = (SELECT anno_id FROM public.anni_sede WHERE id = public.anno_attivo($1)))`,
    [sede])
}
async function sezione(sede: string, nome: string, anno: string | null): Promise<string> {
  return una<string>(
    `INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, $2, $3) RETURNING id`,
    [sede, nome, anno])
}
async function codice(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as { code?: string }).code ?? 'senza-codice' }
  return 'nessun-errore'
}

describe('Compito 1.2 · migrazione di sezioni che esistono già', () => {
  let dbPrima: PGlite
  beforeAll(async () => {
    dbPrima = await creaDbAnno({
      sediPrimaDellaMigrazione: [SEDE, SEDE_B],
      codaPrima: `
        INSERT INTO public.sections (id, scuola_id, name) VALUES
          ('${SEZ_PRIMA}',   '${SEDE}',   'Girasoli'),
          ('${SEZ_PRIMA_2}', '${SEDE_B}', 'Girasoli');
      `,
    })
  }, 60_000)
  afterAll(async () => { await dbPrima.close() })

  it('ogni sezione esistente riceve l\'anno attivo della propria sede', async () => {
    const r = await dbPrima.query<{ ok: boolean }>(
      `SELECT s.anno_id = a.anno_id AS ok
         FROM public.sections s JOIN public.anni_sede a ON a.id = public.anno_attivo(s.scuola_id)`)
    expect(r.rows.length).toBe(2)
    expect(r.rows.every((x) => x.ok)).toBe(true)
    // e l'anno attivo è quello che contiene oggi (relativo: nessuna data cablata)
    const oggi = await dbPrima.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.sections s JOIN public.anni_scolastici a ON a.id = s.anno_id
        WHERE public.giorno_roma(now()) BETWEEN a.inizio_predefinito AND a.fine_predefinita`)
    expect(oggi.rows[0].n).toBe(2)
  })

  it('anno_id è NOT NULL e ha la FK composta sulla sede (e quella sull\'anno)', async () => {
    const nn = await dbPrima.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='sections' AND column_name='anno_id'`)
    expect(nn.rows[0].is_nullable).toBe('NO')
    const fk = await dbPrima.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid='public.sections'::regclass AND contype='f'`)
    const defs = fk.rows.map((x) => x.def).join('\n')
    expect(defs).toMatch(/FOREIGN KEY \(scuola_id, anno_id\) REFERENCES (public\.)?anni_sede\(scuola_id, anno_id\)/)
    expect(defs).toMatch(/FOREIGN KEY \(anno_id\) REFERENCES (public\.)?anni_scolastici\(id\)/)
    expect(defs).toMatch(/FOREIGN KEY \(continua_da\) REFERENCES (public\.)?sections\(id\) ON DELETE SET NULL/)
  })

  it('gli indici unici di oggi sono rifatti con lo STESSO nome, e ora contengono anno_id', async () => {
    const r = await dbPrima.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='sections'`)
    const per = Object.fromEntries(r.rows.map((x) => [x.indexname, x.indexdef]))
    expect(per['sections_nome_per_sede']).toMatch(/UNIQUE.*\(scuola_id, anno_id, name\)/)
    expect(per['sections_forma_normalizzata_per_sede']).toMatch(/UNIQUE.*\(scuola_id, anno_id, lower\(replace\(\(name\)::text, ' '::text, ''::text\)\)\)/)
  })

  it('la migrazione si può riapplicare (idempotente)', async () => {
    await dbPrima.exec(readFileSync(fileMigrazioneAnno(), 'utf8'))
    const n = await dbPrima.query<{ n: number }>('SELECT count(*)::int AS n FROM public.sections')
    expect(n.rows[0].n).toBe(2)
  })
})

describe('Compito 1.2 · sezioni nuove', () => {
  beforeAll(async () => { db = await creaDbAnno() }, 60_000)
  afterAll(async () => { await db.close() })
  beforeEach(async () => {
    await db.exec(`DELETE FROM public.app_log; DELETE FROM public.avvisi; DELETE FROM public.alunni;
                   DELETE FROM public.sections; DELETE FROM public.schools;`)
    await db.query('INSERT INTO public.schools (id, nome) VALUES ($1, $2), ($3, $2)', [SEDE, 'Sede di prova', SEDE_B])
  })

  it('TRANSITORIO (la PR 3 lo toglie): una sezione senza anno_id riceve l\'anno attivo della sede', async () => {
    const id = await sezione(SEDE, 'Girasoli', null)
    expect(await una<string>('SELECT anno_id FROM public.sections WHERE id=$1', [id])).toBe(await annoAttivo())
  })

  it('un anno_id esplicito non viene sovrascritto dalla regola transitoria', async () => {
    const prec = await annoPrecedente()
    const id = await sezione(SEDE, 'Girasoli', prec)
    expect(await una<string>('SELECT anno_id FROM public.sections WHERE id=$1', [id])).toBe(prec)
  })

  it('il trigger transitorio scatta PRIMA di quello generico che arriverà con il Compito 1.4', async () => {
    const r = await db.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid='public.sections'::regclass AND NOT tgisinternal
          AND tgname LIKE 'trg\\_%' ORDER BY tgname`)
    const nomi = r.rows.map((x) => x.tgname)
    const mio = nomi.find((n) => n.includes('anno'))!
    expect(mio).toBeDefined()
    expect(mio < 'trg_zz_anno_assegna_e_verifica').toBe(true)
  })

  it('due sezioni con lo stesso nome normalizzato nello stesso anno: errore; in anni diversi: ammesse', async () => {
    const att = await annoAttivo()
    const prec = await annoPrecedente()
    await sezione(SEDE, '4 ANNI A', att)
    expect(await codice(sezione(SEDE, '4 ANNI A', att))).toBe('23505')     // identico
    expect(await codice(sezione(SEDE, '4 anni a', att))).toBe('23505') // stessa forma normalizzata
    expect(await codice(sezione(SEDE, '4anni a', att))).toBe('23505')
    expect(await codice(sezione(SEDE, '4 ANNI A', prec))).toBe('nessun-errore')
    expect(await codice(sezione(SEDE_B, '4 ANNI A', await annoAttivo(SEDE_B)))).toBe('nessun-errore') // altra sede
  })

  it('l\'errore 23505 esce proprio dagli indici con i nomi di sempre (la route li traduce per nome)', async () => {
    const att = await annoAttivo()
    await sezione(SEDE, 'Api', att)
    let vincolo = ''
    try { await sezione(SEDE, 'Api', att) } catch (e) { vincolo = (e as { constraint?: string }).constraint ?? '' }
    expect(vincolo).toMatch(/^sections_(nome_per_sede|forma_normalizzata_per_sede)$/)
  })

  it('un anno che la sede non ha è rifiutato dalla FK composta', async () => {
    await db.exec(`INSERT INTO public.anni_scolastici (anno_inizio) VALUES (2090) ON CONFLICT DO NOTHING`)
    const lontano = await una<string>('SELECT id FROM public.anni_scolastici WHERE anno_inizio=2090')
    try {
      expect(await codice(sezione(SEDE, 'Fuori', lontano))).toBe('23503')
    } finally {
      // un anno lontano, rimasto in tabella, farebbe creare alle sedi dei test dopo un buco nel calendario
      await db.exec('DELETE FROM public.anni_scolastici WHERE anno_inizio = 2090')
    }
  })

  it('fascia: i sei valori del §4.4.2 e NULL passano, il resto no', async () => {
    const att = await annoAttivo()
    for (const f of ['nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini']) {
      const id = await sezione(SEDE, `S-${f}`, att)
      await db.query('UPDATE public.sections SET fascia=$2 WHERE id=$1', [id, f])
    }
    const id = await sezione(SEDE, 'Senza fascia', att)
    expect(await una<string | null>('SELECT fascia FROM public.sections WHERE id=$1', [id])).toBeNull()
    expect(await codice(db.query('UPDATE public.sections SET fascia=$2 WHERE id=$1', [id, 'nido_3']))).toBe('23514')
  })

  it('continua_da: punta a una sezione e diventa NULL se quella sparisce', async () => {
    const prec = await sezione(SEDE, 'Girasoli', await annoPrecedente())
    const att = await sezione(SEDE, 'Girasoli 2', await annoAttivo())
    await db.query('UPDATE public.sections SET continua_da=$2 WHERE id=$1', [att, prec])
    await db.query('DELETE FROM public.sections WHERE id=$1', [prec])
    expect(await una<string | null>('SELECT continua_da FROM public.sections WHERE id=$1', [att])).toBeNull()
  })
})

describe('Compito 1.2 · sync_alunno_section_id cerca la sezione solo fra quelle dell\'anno attivo', () => {
  beforeAll(async () => { db = await creaDbAnno() }, 60_000)
  afterAll(async () => { await db.close() })
  beforeEach(async () => {
    await db.exec(`DELETE FROM public.app_log; DELETE FROM public.alunni; DELETE FROM public.sections; DELETE FROM public.schools;`)
    await db.query('INSERT INTO public.schools (id, nome) VALUES ($1, $2)', [SEDE, 'Sede di prova'])
  })

  it('con lo stesso nome in due anni, l\'alunno prende quella dell\'anno attivo (anche se l\'altra è stata inserita PRIMA)', async () => {
    const altro = await sezione(SEDE, 'Girasoli', await annoPrecedente())   // inserita per prima
    const att = await sezione(SEDE, 'Girasoli', await annoAttivo())
    // Il piano con l'indice sceglie in ordine di anno_id (un uuid a caso): la versione vecchia, con
    // LIMIT 1, passerebbe a volte per fortuna. Con la scansione sequenziale decide l'ordine di
    // inserimento, cioè l'altro anno: la prova non dipende dal caso.
    await db.exec('SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_indexonlyscan = off')
    let a: string
    try {
      a = await una<string>(
        `INSERT INTO public.alunni (scuola_id, classe_sezione) VALUES ($1, ' girasoli') RETURNING id`, [SEDE])
    } finally {
      await db.exec('RESET enable_indexscan; RESET enable_bitmapscan; RESET enable_indexonlyscan')
    }
    const sez = await una<string>('SELECT section_id FROM public.alunni WHERE id=$1', [a])
    expect(sez).toBe(att)
    expect(sez).not.toBe(altro)
  })

  it('se la sezione esiste solo in un altro anno, l\'alunno resta senza classe e il warn viene scritto', async () => {
    await sezione(SEDE, 'Solo ieri', await annoPrecedente())
    const a = await una<string>(
      `INSERT INTO public.alunni (scuola_id, classe_sezione) VALUES ($1, 'Solo ieri') RETURNING id`, [SEDE])
    expect(await una<string | null>('SELECT section_id FROM public.alunni WHERE id=$1', [a])).toBeNull()
    const log = await db.query<{ livello: string; fingerprint: string }>('SELECT livello, fingerprint FROM public.app_log')
    expect(log.rows).toEqual([{ livello: 'warn', fingerprint: `db:alunno-senza-sezione:${SEDE}` }])
  })

  it('funziona anche per chi scrive come authenticated (la RLS di anni_sede non lo rende cieco)', async () => {
    const att = await sezione(SEDE, 'Girasoli', await annoAttivo())
    await db.exec('SET ROLE authenticated')
    try {
      await db.query(`INSERT INTO public.alunni (id, scuola_id, classe_sezione) VALUES ('44444444-4444-4444-8444-444444444441', $1, 'Girasoli')`, [SEDE])
    } finally { await db.exec('RESET ROLE') }
    expect(await una<string>(`SELECT section_id FROM public.alunni WHERE id='44444444-4444-4444-8444-444444444441'`)).toBe(att)
  })
})

describe('Compito 1.2 · propaga_rinomina_sezione tocca solo l\'anno attivo', () => {
  beforeAll(async () => { db = await creaDbAnno() }, 60_000)
  afterAll(async () => { await db.close() })
  let att: string
  let altro: string
  beforeEach(async () => {
    await db.exec(`DELETE FROM public.app_log; DELETE FROM public.avvisi; DELETE FROM public.alunni; DELETE FROM public.sections; DELETE FROM public.schools;`)
    await db.query('INSERT INTO public.schools (id, nome) VALUES ($1, $2)', [SEDE, 'Sede di prova'])
    altro = await sezione(SEDE, 'Girasoli', await annoPrecedente())
    att = await sezione(SEDE, 'Girasoli', await annoAttivo())
    await db.query(`INSERT INTO public.alunni (scuola_id, classe_sezione) VALUES ($1, 'Girasoli')`, [SEDE])
    await db.query(`INSERT INTO public.avvisi (scuola_id, target_classes) VALUES ($1, ARRAY['Girasoli', 'Api'])`, [SEDE])
  })

  it('rinominare una sezione di un ALTRO anno non cambia avvisi e alunni dell\'anno attivo', async () => {
    await db.query(`UPDATE public.sections SET name='Orsetti' WHERE id=$1`, [altro])
    expect(await una<string>('SELECT classe_sezione FROM public.alunni')).toBe('Girasoli')
    expect(await una<string[]>('SELECT target_classes FROM public.avvisi')).toEqual(['Girasoli', 'Api'])
    expect(await una<number>('SELECT count(*)::int FROM public.app_log')).toBe(0)
  })

  it('REGRESSIONE: rinominare la sezione dell\'anno attivo propaga come oggi', async () => {
    await db.query(`UPDATE public.sections SET name='Farfalle' WHERE id=$1`, [att])
    expect(await una<string>('SELECT classe_sezione FROM public.alunni')).toBe('Farfalle')
    expect(await una<string[]>('SELECT target_classes FROM public.avvisi')).toEqual(['Farfalle', 'Api'])
    const log = await db.query<{ livello: string }>(`SELECT livello FROM public.app_log WHERE fingerprint = $1`, [`db:rinomina-sezione:${att}`])
    expect(log.rows).toEqual([{ livello: 'info' }])
  })
})
