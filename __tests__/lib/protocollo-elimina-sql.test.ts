// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * `protocollo_elimina` · LA FUNZIONE PROVATA SU UN POSTGRES VERO, CON IL FRENO RESTRICT.
 *
 * Fase 7 della roadmap di robustezza: la FK `protocolli_allegati.protocollo_id`
 * passa da CASCADE a RESTRICT. La funzione di eliminazione (solo admin) prima
 * cancellava la registrazione e lasciava gli allegati alla cascata; ora li
 * cancella lei, prima. Il WORM delle due tabelle si apre solo col GUC
 * transaction-locale che la funzione accende.
 *
 * Le funzioni WORM e la definizione di partenza si leggono dal file del
 * registro protocolli; la definizione in vigore dall'ultima migrazione che la
 * riscrive. Schema minimo; solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE_REGISTRO = readdirSync(CARTELLA).find((f) => f.endsWith('_registro_protocolli.sql'))
if (!FILE_REGISTRO) throw new Error('migrazione *_registro_protocolli.sql non trovata')
const REGISTRO = readFileSync(join(CARTELLA, FILE_REGISTRO), 'utf8')

const RE_FUNZIONE = /create\s+or\s+replace\s+function\s+public\.protocollo_elimina\s*\(p_id uuid\)[\s\S]*?end \$\$;/i
const ULTIMA = readdirSync(CARTELLA)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => RE_FUNZIONE.test(readFileSync(join(CARTELLA, f), 'utf8')))
  .at(-1)
if (!ULTIMA) throw new Error('nessuna migrazione definisce public.protocollo_elimina')

function estrai(sql: string, re: RegExp, cosa: string): string {
  const m = re.exec(sql)
  if (!m) throw new Error(`${cosa} non trovato`)
  return m[0]
}

const WORM = [
  estrai(REGISTRO, /CREATE OR REPLACE FUNCTION public\.worm_protocolli\(\)[\s\S]*?END \$\$;/, 'worm_protocolli'),
  estrai(REGISTRO, /CREATE TRIGGER trg_worm_protocolli\s[\s\S]*?;/, 'trg_worm_protocolli'),
  estrai(REGISTRO, /CREATE OR REPLACE FUNCTION public\.worm_protocolli_allegati\(\)[\s\S]*?END \$\$;/, 'worm_protocolli_allegati'),
  estrai(REGISTRO, /CREATE TRIGGER trg_worm_protocolli_allegati\s[\s\S]*?;/, 'trg_worm_protocolli_allegati'),
].join('\n')
const DEFINIZIONE_DI_PRIMA = estrai(REGISTRO, RE_FUNZIONE, 'protocollo_elimina del registro')
const DEFINIZIONE_IN_VIGORE = estrai(readFileSync(join(CARTELLA, ULTIMA), 'utf8'), RE_FUNZIONE, `protocollo_elimina in ${ULTIMA}`)

const PROT = 'b0000000-0000-4000-8000-000000000001'
const ALTRO = 'b0000000-0000-4000-8000-000000000002'

type PgErr = { code?: string; message: string }

async function schema(conn: PGlite, definizione: string): Promise<void> {
  await conn.exec(`
    -- scuola_id, anno e numero dalla sessione 3 della seconda serie: la funzione ne ricava il
    -- prefisso delle versioni. Qui restano NULL e lo Storage non c'è: si provano i soli percorsi
    -- della registrazione, come nel database della CI.
    CREATE TABLE public.protocolli (
      id uuid PRIMARY KEY,
      scuola_id uuid,
      anno int,
      numero int,
      file_originale text,
      file_timbrato text
    );
    -- Il freno della fase 7 (PR 2): RESTRICT al posto di CASCADE.
    CREATE TABLE public.protocolli_allegati (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      protocollo_id uuid NOT NULL REFERENCES public.protocolli(id) ON DELETE RESTRICT,
      path text NOT NULL
    );
  `)
  await conn.exec(WORM)
  await conn.exec(definizione)
}

async function semina(conn: PGlite): Promise<void> {
  await conn.exec(`
    INSERT INTO public.protocolli (id, file_originale, file_timbrato) VALUES
      ('${PROT}', 'sede/2026/1-originale.pdf', 'sede/2026/1-timbrato.pdf'),
      ('${ALTRO}', 'sede/2026/2-originale.pdf', NULL);
    INSERT INTO public.protocolli_allegati (protocollo_id, path) VALUES
      ('${PROT}', 'sede/2026/1-allegato-a.pdf'),
      ('${PROT}', 'sede/2026/1-allegato-b.pdf'),
      ('${ALTRO}', 'sede/2026/2-allegato.pdf');
  `)
}

async function numero(conn: PGlite, sql: string): Promise<number> {
  const { rows } = await conn.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await schema(db, DEFINIZIONE_IN_VIGORE)
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  // Il WORM vieta anche lo svuotamento: si passa dal GUC, come la funzione.
  await db.exec(`
    BEGIN;
    SELECT set_config('app.protocollo_admin_delete', 'on', true);
    DELETE FROM public.protocolli_allegati;
    DELETE FROM public.protocolli;
    COMMIT;
  `)
  await semina(db)
})

describe('protocollo_elimina — con il freno RESTRICT sugli allegati', () => {
  it('cancella prima gli allegati, poi la registrazione, e restituisce TUTTI i percorsi da togliere dal bucket', async () => {
    const { rows } = await db.query<{ p: string[] }>(`SELECT public.protocollo_elimina('${PROT}') AS p`)
    expect([...rows[0].p].sort()).toEqual([
      'sede/2026/1-allegato-a.pdf',
      'sede/2026/1-allegato-b.pdf',
      'sede/2026/1-originale.pdf',
      'sede/2026/1-timbrato.pdf',
    ])
    expect(await numero(db, `SELECT count(*) FROM public.protocolli WHERE id = '${PROT}'`)).toBe(0)
    expect(await numero(db, `SELECT count(*) FROM public.protocolli_allegati WHERE protocollo_id = '${PROT}'`)).toBe(0)
    // L'altra registrazione e il suo allegato restano.
    expect(await numero(db, `SELECT count(*) FROM public.protocolli_allegati WHERE protocollo_id = '${ALTRO}'`)).toBe(1)
  })

  it('un id che non esiste: nessun percorso e niente si muove', async () => {
    const { rows } = await db.query<{ p: string[] }>(
      `SELECT public.protocollo_elimina('99999999-0000-4000-8000-000000000099') AS p`,
    )
    expect(rows[0].p).toEqual([])
    expect(await numero(db, `SELECT count(*) FROM public.protocolli_allegati`)).toBe(3)
  })

  it('fuori dalla funzione il WORM resta chiuso: una DELETE diretta di un allegato è rifiutata', async () => {
    let err: PgErr | null = null
    try {
      await db.exec(`DELETE FROM public.protocolli_allegati WHERE protocollo_id = '${PROT}'`)
    } catch (e) {
      err = e as PgErr
    }
    expect(err?.message).toMatch(/allegati immutabili/)
    expect(await numero(db, `SELECT count(*) FROM public.protocolli_allegati`)).toBe(3)
  })

  it('anche col WORM aperto, la registrazione con allegati non si cancella più da sola: è il freno', async () => {
    let err: PgErr | null = null
    try {
      await db.exec(`
        BEGIN;
        SELECT set_config('app.protocollo_admin_delete', 'on', true);
        DELETE FROM public.protocolli WHERE id = '${PROT}';
        COMMIT;
      `)
    } catch (e) {
      err = e as PgErr
      await db.exec('ROLLBACK')
    }
    // 23503 fino a Postgres 17 (la produzione), 23001 da Postgres 18 (PGlite).
    expect(err?.code).toMatch(/^(23503|23001)$/)
    expect(await numero(db, `SELECT count(*) FROM public.protocolli WHERE id = '${PROT}'`)).toBe(1)
  })

  it('la definizione di PRIMA (registro del 12/07), con lo stesso freno, cadeva: è il guasto che la fase 7 evita', async () => {
    const vecchio = new PGlite()
    try {
      await schema(vecchio, DEFINIZIONE_DI_PRIMA)
      await semina(vecchio)
      let err: PgErr | null = null
      try {
        await vecchio.query(`SELECT public.protocollo_elimina('${PROT}') AS p`)
      } catch (e) {
        err = e as PgErr
      }
      expect(ULTIMA, 'la definizione in vigore deve venire da una migrazione successiva al registro').not.toBe(FILE_REGISTRO)
      expect(err?.code).toMatch(/^(23503|23001)$/)
    } finally {
      await vecchio.close()
    }
  })
})
