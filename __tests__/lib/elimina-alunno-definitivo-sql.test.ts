// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { TABELLE_REGISTRO_PRIMARIA } from '@/lib/alunni/registro-primaria'

/**
 * ELIMINAZIONE DEFINITIVA DI UN ALUNNO · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Ciò che la migrazione consegna sono regole che solo il database può far
 * rispettare: l'ordine delle cancellazioni contro le FK senza CASCADE, il
 * «tutto o niente» di una transazione, i permessi sulla funzione. Un finto
 * client direbbe «sì» a tutto.
 *
 * Lo schema qui sotto è un MINIMO: colonne e FK riprendono la produzione
 * (lette in sola lettura il 2026-10-08 da `pg_constraint`), il resto è tolto.
 * Il file della migrazione è LETTO DAL DISCO e applicato DUE volte.
 *
 * Solo dati finti: uuid inventati, nessuna anagrafica.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_alunni_elimina_definitivo.sql'))
if (!FILE) throw new Error('migrazione *_alunni_elimina_definitivo.sql non trovata')
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE), 'utf8')

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const SEZ = 'c0000000-0000-4000-8000-000000000001'
const ADULTO = '10000000-0000-4000-8000-000000000001' // ritirato, legato al genitore che è lui stesso
const DOPPIONE = '10000000-0000-4000-8000-000000000002' // ritirato, una presenza
const ISCRITTO = '10000000-0000-4000-8000-000000000003' // frequenta: intoccabile
const SENZA_SEZ = '10000000-0000-4000-8000-000000000004' // iscritto ma senza sezione
const FRATELLO = '10000000-0000-4000-8000-000000000005'
const GENITORE = '20000000-0000-4000-8000-000000000001'

let db: PGlite

type PgErr = { code?: string; message: string }

async function elimina(alunno: string, conPagamenti = false): Promise<{ ok: boolean; code: string; righe?: Record<string, number> }> {
  const { rows } = await db.query<{ r: { ok: boolean; code: string; righe?: Record<string, number> } }>(
    `SELECT public.elimina_alunno_definitivo('${alunno}', ${conPagamenti}) AS r`,
  )
  return rows[0].r
}

async function numero(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

/**
 * Una riga di diario messa lì PRIMA di un rifiuto, e ricontata dopo. Il diario è
 * la prima cosa che la funzione cancella senza condizioni: se un giorno una
 * `delete` scivola sopra uno dei `return` di rifiuto, la sentinella sparisce e il
 * test di quel rifiuto diventa rosso — la sola scheda ancora presente non basta
 * a dire «niente si è mosso».
 */
async function sentinella(alunno: string): Promise<void> {
  await db.exec(`INSERT INTO public.eventi_diario (alunno_id) VALUES ('${alunno}')`)
}

async function sentinellaIntatta(alunno: string): Promise<void> {
  expect(
    await numero(`SELECT count(*) FROM public.eventi_diario WHERE alunno_id = '${alunno}'`),
    'la riga di diario è sparita: una cancellazione è avvenuta PRIMA del rifiuto',
  ).toBe(1)
}

async function schemaMinimo(conn: PGlite) {
  await conn.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

    CREATE FUNCTION public.stati_alunno_non_piu_iscritto() RETURNS text[]
      LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['ritirato']::text[] $$;

    CREATE TABLE public.alunni (
      id uuid PRIMARY KEY,
      scuola_id uuid,
      stato varchar,
      section_id uuid,
      classe_sezione varchar,
      anonimizzato_il timestamptz,
      retta_a_carico_di uuid REFERENCES public.alunni(id) ON DELETE SET NULL
    );
    CREATE TABLE public.parents (id uuid PRIMARY KEY);
    CREATE TABLE public.student_parents (
      student_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE,
      parent_id uuid REFERENCES public.parents(id)
    );
    CREATE TABLE public.legame_genitori_alunni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id),
      parent_id uuid
    );
    CREATE TABLE public.presenze (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.eventi_diario (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.armadietto (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.ticket_mensa (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.forms_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid);
    CREATE TABLE public.galleria_media (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tag_alunni uuid[]);

    CREATE TABLE public.valutazioni (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.pagelle (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.scrutinio_giudizi (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.scrutinio_comportamento (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.note_disciplinari (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.certificati_competenze (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);

    CREATE TABLE public.pagamenti (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id),
      parent_payment_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE
    );
    CREATE TABLE public.incassi (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE);
    CREATE TABLE public.ricevute_emesse (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid, pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE SET NULL);
    CREATE TABLE public.fatture_emesse (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE RESTRICT);
    CREATE TABLE public.riconciliazione_movimenti (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE SET NULL);
    CREATE TABLE public.solleciti (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid, pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE);
    -- La coda delle fatture: in produzione 'stato' ha un CHECK su
    -- in_coda / in_invio / emessa / errore / tolta; qui basta il testo.
    CREATE TABLE public.fatture_coda (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE, stato text);

    -- Copia del diario creata a mano in produzione il 2026-09-08, senza
    -- migrazione: la funzione la nomina solo se c'è (SQL dinamico).
    CREATE TABLE public.backup_diario_vuote_20260908 (alunno_id uuid);
  `)
}

beforeAll(async () => {
  db = new PGlite()
  await schemaMinimo(db)
  await db.exec(MIGRAZIONE)
  await db.exec(MIGRAZIONE) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.backup_diario_vuote_20260908, public.fatture_coda,
             public.solleciti, public.riconciliazione_movimenti, public.fatture_emesse, public.ricevute_emesse,
             public.incassi, public.pagamenti, public.valutazioni, public.pagelle, public.scrutinio_giudizi,
             public.scrutinio_comportamento, public.note_disciplinari, public.certificati_competenze,
             public.galleria_media, public.forms_submissions, public.ticket_mensa, public.armadietto,
             public.eventi_diario, public.presenze, public.legame_genitori_alunni, public.student_parents,
             public.parents, public.alunni CASCADE;

    INSERT INTO public.alunni (id, scuola_id, stato, section_id, classe_sezione) VALUES
      ('${ADULTO}',    '${SEDE}', 'ritirato', NULL,     NULL),
      ('${DOPPIONE}',  '${SEDE}', 'ritirato', NULL,     NULL),
      ('${ISCRITTO}',  '${SEDE}', 'iscritto', '${SEZ}', 'SEZIONE A'),
      ('${SENZA_SEZ}', '${SEDE}', 'iscritto', NULL,     NULL),
      ('${FRATELLO}',  '${SEDE}', 'iscritto', '${SEZ}', 'SEZIONE A');
    INSERT INTO public.parents (id) VALUES ('${GENITORE}');
    INSERT INTO public.student_parents (student_id, parent_id) VALUES ('${ADULTO}', '${GENITORE}'), ('${ISCRITTO}', '${GENITORE}');
    INSERT INTO public.legame_genitori_alunni (alunno_id, parent_id) VALUES ('${ADULTO}', '${GENITORE}');
    INSERT INTO public.presenze (alunno_id) VALUES ('${DOPPIONE}');
  `)
})

describe('elimina_alunno_definitivo — chi si può eliminare', () => {
  it('rifiuta chi FREQUENTA (iscritto con sezione) e non tocca niente', async () => {
    await sentinella(ISCRITTO)
    expect(await elimina(ISCRITTO)).toMatchObject({ ok: false, code: 'frequentante' })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${ISCRITTO}'`)).toBe(1)
    await sentinellaIntatta(ISCRITTO)
  })

  it('uno stato VUOTO con la sezione vale «frequenta»: il NULL non apre la porta', async () => {
    // `alunni.stato` è nullable (DEFAULT 'iscritto'): per `eNonPiuIscritto` un
    // NULL non è un ritiro. In SQL `NULL = any(…)` dà NULL, e un `if not (…)`
    // costruito sopra non scatterebbe — cioè lascerebbe passare chi frequenta.
    await db.exec(`UPDATE public.alunni SET stato = NULL WHERE id = '${FRATELLO}'`)
    await sentinella(FRATELLO)
    expect(await elimina(FRATELLO)).toMatchObject({ ok: false, code: 'frequentante' })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${FRATELLO}'`)).toBe(1)
    await sentinellaIntatta(FRATELLO)
  })

  it('risponde «non_trovato» su un id che non esiste', async () => {
    expect(await elimina('99999999-0000-4000-8000-000000000099')).toMatchObject({ ok: false, code: 'non_trovato' })
  })

  it('rifiuta una scheda già anonimizzata', async () => {
    await db.exec(`UPDATE public.alunni SET anonimizzato_il = now() WHERE id = '${DOPPIONE}'`)
    await sentinella(DOPPIONE)
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: false, code: 'gia_anonimizzato' })
    await sentinellaIntatta(DOPPIONE)
  })

  it('caso A — l’adulto inserito come bambino: via la scheda e i due legami, il GENITORE resta intatto', async () => {
    expect(await elimina(ADULTO)).toMatchObject({ ok: true, code: 'eliminato' })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${ADULTO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.legame_genitori_alunni WHERE alunno_id = '${ADULTO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.student_parents WHERE student_id = '${ADULTO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.parents WHERE id = '${GENITORE}'`)).toBe(1)
    // e il figlio vero di quel genitore resta collegato
    expect(await numero(`SELECT count(*) FROM public.student_parents WHERE student_id = '${ISCRITTO}'`)).toBe(1)
  })

  it('caso B — il doppione: la presenza se ne va in cascata', async () => {
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: true, code: 'eliminato' })
    expect(await numero(`SELECT count(*) FROM public.presenze WHERE alunno_id = '${DOPPIONE}'`)).toBe(0)
  })

  it('un iscritto SENZA sezione si può eliminare', async () => {
    expect(await elimina(SENZA_SEZ)).toMatchObject({ ok: true, code: 'eliminato' })
  })

  it('porta via diario, armadietto, ticket, moduli e il tag nella galleria storica', async () => {
    await db.exec(`
      INSERT INTO public.eventi_diario (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.armadietto (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.ticket_mensa (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.forms_submissions (student_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.galleria_media (tag_alunni) VALUES (ARRAY['${DOPPIONE}', '${ISCRITTO}']::uuid[]);
    `)
    const r = await elimina(DOPPIONE)
    expect(r).toMatchObject({ ok: true, code: 'eliminato' })
    expect(r.righe).toMatchObject({ diario: 1, armadietto: 1, ticket_mensa: 1, moduli: 1, tag_galleria: 1 })
    expect(await numero(`SELECT count(*) FROM public.eventi_diario`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.galleria_media WHERE '${DOPPIONE}' = ANY(tag_alunni)`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.galleria_media WHERE '${ISCRITTO}' = ANY(tag_alunni)`)).toBe(1)
  })

  it('porta via anche la copia del diario del 2026-09-08, che esiste solo in produzione', async () => {
    await db.exec(`
      INSERT INTO public.backup_diario_vuote_20260908 (alunno_id) VALUES ('${DOPPIONE}'), ('${ISCRITTO}');
    `)
    const r = await elimina(DOPPIONE)
    expect(r).toMatchObject({ ok: true, code: 'eliminato' })
    expect(r.righe).toMatchObject({ backup_diario: 1 })
    expect(await numero(`SELECT count(*) FROM public.backup_diario_vuote_20260908 WHERE alunno_id = '${DOPPIONE}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.backup_diario_vuote_20260908 WHERE alunno_id = '${ISCRITTO}'`)).toBe(1)
  })

  it('senza la copia del diario (DB della CI) elimina lo stesso, e non la nomina fra le righe', async () => {
    await db.exec(`ALTER TABLE public.backup_diario_vuote_20260908 RENAME TO backup_diario_altrove`)
    try {
      const r = await elimina(DOPPIONE)
      expect(r).toMatchObject({ ok: true, code: 'eliminato' })
      expect(r.righe).not.toHaveProperty('backup_diario')
    } finally {
      await db.exec(`ALTER TABLE public.backup_diario_altrove RENAME TO backup_diario_vuote_20260908`)
    }
  })

  it('il fratello che aveva la retta a carico di questa scheda la perde (SET NULL), non sparisce', async () => {
    await db.exec(`UPDATE public.alunni SET retta_a_carico_di = '${DOPPIONE}' WHERE id = '${FRATELLO}'`)
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: true })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${FRATELLO}' AND retta_a_carico_di IS NULL`)).toBe(1)
  })
})

describe('elimina_alunno_definitivo — il registro della primaria', () => {
  for (const tabella of TABELLE_REGISTRO_PRIMARIA) {
    it(`una riga in ${tabella} blocca TUTTO, anche con i pagamenti ammessi`, async () => {
      await db.exec(`INSERT INTO public.${tabella} (alunno_id) VALUES ('${DOPPIONE}')`)
      await sentinella(DOPPIONE)
      expect(await elimina(DOPPIONE, true)).toMatchObject({ ok: false, code: 'registro_primaria' })
      expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${DOPPIONE}'`)).toBe(1)
      await sentinellaIntatta(DOPPIONE)
    })
  }

  it('le tabelle controllate in SQL sono ESATTAMENTE quelle di TABELLE_REGISTRO_PRIMARIA', () => {
    const blocco = /-- registro-primaria:inizio([\s\S]*?)-- registro-primaria:fine/.exec(MIGRAZIONE)
    expect(blocco, 'marcatori -- registro-primaria:inizio/fine assenti nella migrazione').not.toBeNull()
    const inSql = [...blocco![1].matchAll(/from public\.(\w+)/gi)].map((m) => m[1]).sort()
    expect(inSql).toEqual([...TABELLE_REGISTRO_PRIMARIA].sort())
  })
})

describe('elimina_alunno_definitivo — i pagamenti', () => {
  async function pagamento(alunno: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(`INSERT INTO public.pagamenti (alunno_id) VALUES ('${alunno}') RETURNING id`)
    return rows[0].id
  }

  it('con pagamenti e senza permesso: rifiuta «ha_pagamenti» e non tocca niente', async () => {
    await pagamento(DOPPIONE)
    await sentinella(DOPPIONE)
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: false, code: 'ha_pagamenti' })
    expect(await numero(`SELECT count(*) FROM public.pagamenti`)).toBe(1)
    await sentinellaIntatta(DOPPIONE)
  })

  it('con permesso e pagamenti puliti: via pagamenti e solleciti, poi la scheda', async () => {
    const p = await pagamento(DOPPIONE)
    await db.exec(`INSERT INTO public.solleciti (alunno_id, pagamento_id) VALUES ('${DOPPIONE}', '${p}')`)
    const r = await elimina(DOPPIONE, true)
    expect(r).toMatchObject({ ok: true, code: 'eliminato' })
    expect(r.righe).toMatchObject({ pagamenti: 1 })
    expect(await numero(`SELECT count(*) FROM public.pagamenti`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.solleciti`)).toBe(0)
  })

  // [nome, la riga che blocca, la tabella in cui quella riga deve restare]
  const BLOCCHI: [string, (p: string) => string, string][] = [
    ['incasso registrato', (p) => `INSERT INTO public.incassi (pagamento_id) VALUES ('${p}')`, 'incassi'],
    ['ricevuta emessa', (p) => `INSERT INTO public.ricevute_emesse (alunno_id, pagamento_id) VALUES ('${DOPPIONE}', '${p}')`, 'ricevute_emesse'],
    ['fattura emessa', (p) => `INSERT INTO public.fatture_emesse (pagamento_id) VALUES ('${p}')`, 'fatture_emesse'],
    ['bonifico abbinato', (p) => `INSERT INTO public.riconciliazione_movimenti (pagamento_id) VALUES ('${p}')`, 'riconciliazione_movimenti'],
    ['quota di un fratello appesa', (p) => `INSERT INTO public.pagamenti (alunno_id, parent_payment_id) VALUES ('${FRATELLO}', '${p}')`, 'pagamenti'],
    // Il file può essere già partito verso Aruba/SDI: la voce sparirebbe in CASCADE col pagamento.
    ['fattura in coda già in invio', (p) => `INSERT INTO public.fatture_coda (pagamento_id, stato) VALUES ('${p}', 'in_invio')`, 'fatture_coda'],
    // Esito ambiguo: non si sa se la fattura è nata o no.
    ['fattura in coda in errore', (p) => `INSERT INTO public.fatture_coda (pagamento_id, stato) VALUES ('${p}', 'errore')`, 'fatture_coda'],
  ]
  for (const [nome, sql, tabella] of BLOCCHI) {
    it(`${nome}: «pagamenti_non_cancellabili» anche col permesso, e niente si muove`, async () => {
      const p = await pagamento(DOPPIONE)
      await db.exec(sql(p))
      await sentinella(DOPPIONE)
      const prima = await numero(`SELECT count(*) FROM public.${tabella}`)
      expect(await elimina(DOPPIONE, true)).toMatchObject({ ok: false, code: 'pagamenti_non_cancellabili' })
      expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${DOPPIONE}'`)).toBe(1)
      expect(await numero(`SELECT count(*) FROM public.pagamenti WHERE alunno_id = '${DOPPIONE}'`)).toBe(1)
      expect(await numero(`SELECT count(*) FROM public.${tabella}`)).toBe(prima)
      await sentinellaIntatta(DOPPIONE)
    })
  }

  it('una voce di coda «tolta» non blocca: col permesso si cancella, e la voce se ne va in cascata', async () => {
    const p = await pagamento(DOPPIONE)
    await db.exec(`INSERT INTO public.fatture_coda (pagamento_id, stato) VALUES ('${p}', 'tolta')`)
    const r = await elimina(DOPPIONE, true)
    expect(r).toMatchObject({ ok: true, code: 'eliminato' })
    expect(r.righe).toMatchObject({ pagamenti: 1 })
    expect(await numero(`SELECT count(*) FROM public.fatture_coda`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${DOPPIONE}'`)).toBe(0)
  })

  it('una ricevuta emessa SENZA pagamento basta a bloccare', async () => {
    await db.exec(`INSERT INTO public.ricevute_emesse (alunno_id) VALUES ('${DOPPIONE}')`)
    await sentinella(DOPPIONE)
    expect(await elimina(DOPPIONE, true)).toMatchObject({ ok: false, code: 'pagamenti_non_cancellabili' })
    await sentinellaIntatta(DOPPIONE)
  })

  it('i pagamenti dell’alunno si bloccano FOR UPDATE prima di ogni controllo su di loro', () => {
    // PERCHÉ È UNA PROVA SUL TESTO E NON SUL COMPORTAMENTO. La corsa che questa
    // riga chiude ha bisogno di DUE transazioni aperte insieme: una che scrive un
    // incasso (o un abbinamento, o la quota di un fratello) su un pagamento P del
    // bambino e non ha ancora confermato, e questa funzione che controlla P, non
    // vede l'incasso e poi lo porta via in CASCADE con P. PGlite è un Postgres a
    // UNA connessione: le istruzioni si eseguono in fila, e una seconda
    // transazione concorrente non si può aprire. Un test «di concorrenza» qui
    // sarebbe sequenziale, cioè verde con e senza il lock: un finto.
    //
    // Si prova allora ciò che si può provare: che il lock c'è, che sta sulla
    // tabella giusta col filtro giusto, e che viene PRIMA dei controlli che deve
    // proteggere (registro e pagamenti) e DOPO i rifiuti che non toccano niente.
    // Il comportamento sequenziale resta coperto da tutti gli altri test.
    const istruzioni = MIGRAZIONE.replace(/--[^\n]*/g, '')
    const lock = /perform\s+1\s+from\s+public\.pagamenti\s+where\s+alunno_id\s*=\s*p_alunno\s+for\s+update\s*;/i.exec(istruzioni)
    expect(lock, 'manca «perform 1 from public.pagamenti where alunno_id = p_alunno for update;»').not.toBeNull()
    const posFrequentante = istruzioni.indexOf(`'frequentante'`)
    const posRegistro = istruzioni.search(/from\s+public\.valutazioni/i)
    const posContaPagamenti = istruzioni.search(/select\s+count\(\*\)\s+into\s+v_pagamenti/i)
    expect(posFrequentante).toBeGreaterThan(0)
    expect(lock!.index).toBeGreaterThan(posFrequentante)
    expect(lock!.index).toBeLessThan(posRegistro)
    expect(lock!.index).toBeLessThan(posContaPagamenti)
  })
})

describe('elimina_alunno_definitivo — tutto o niente, e chi può chiamarla', () => {
  it('un errore all’ultimo passo annulla anche le cancellazioni già fatte', async () => {
    // Una FK senza CASCADE che la funzione NON conosce: la DELETE finale fallisce.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.tabella_estranea (id serial PRIMARY KEY, alunno_id uuid REFERENCES public.alunni(id));
      INSERT INTO public.tabella_estranea (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.eventi_diario (alunno_id) VALUES ('${DOPPIONE}');
    `)
    let err: PgErr | null = null
    try {
      await elimina(DOPPIONE)
    } catch (e) {
      err = e as PgErr
    }
    expect(err?.code).toBe('23503')
    expect(await numero(`SELECT count(*) FROM public.eventi_diario WHERE alunno_id = '${DOPPIONE}'`)).toBe(1)
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${DOPPIONE}'`)).toBe(1)
    await db.exec(`DROP TABLE public.tabella_estranea`)
  })

  it('la porta è chiusa ad anon e authenticated, aperta al solo service_role', async () => {
    const firma = `'public.elimina_alunno_definitivo(uuid, boolean)'`
    const { rows } = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon', ${firma}, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', ${firma}, 'EXECUTE') AS auth,
             has_function_privilege('service_role', ${firma}, 'EXECUTE') AS svc`)
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true })
  })

  it('la migrazione non cancella mai da storage.objects', () => {
    expect(MIGRAZIONE.toLowerCase()).not.toContain('storage.objects')
  })
})
