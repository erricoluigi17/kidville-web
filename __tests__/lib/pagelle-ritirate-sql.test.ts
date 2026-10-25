// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * PAGELLE RITIRATE · LA MIGRAZIONE SU UN POSTGRES VERO.
 * La tabella è un minimo con il vincolo di unicità della produzione su (scrutinio, alunno).
 * Una riga esiste PRIMA della migrazione: deve ricevere i valori di partenza.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).filter((f) => f.endsWith('_pagelle_ritirate.sql'))
if (FILE.length !== 1) throw new Error(`attesa UNA migrazione *_pagelle_ritirate.sql, trovate ${FILE.length}`)
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE[0]), 'utf8')

const SCRUTINIO = '50000000-0000-4000-8000-000000000001'
const ALUNNO = '60000000-0000-4000-8000-000000000001'
const ALUNNO_2 = '60000000-0000-4000-8000-000000000002'

const TABELLA = `
  CREATE TABLE public.pagelle (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scrutinio_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    file_url text,
    generata_il timestamptz DEFAULT now(),
    generata_da uuid,
    firma_applicativa jsonb,
    UNIQUE (scrutinio_id, alunno_id)
  );
`

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(TABELLA)
  await db.exec(`INSERT INTO public.pagelle (scrutinio_id, alunno_id, file_url) VALUES ('${SCRUTINIO}', '${ALUNNO_2}', '${SCRUTINIO}/${ALUNNO_2}.pdf')`)
  await db.exec(MIGRAZIONE)
  await db.exec(MIGRAZIONE) // idempotente
})

afterAll(async () => {
  await db.close()
})

describe('migrazione pagelle ritirate', () => {
  it('aggiunge le due colonne con i tipi giusti', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pagelle'
         AND column_name IN ('ritirata_il', 'file_ritirati') ORDER BY column_name`)
    expect(rows).toEqual([
      { column_name: 'file_ritirati', data_type: 'ARRAY', is_nullable: 'NO' },
      { column_name: 'ritirata_il', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ])
  })

  it('una pagella che c\'era già resta in vigore, senza copie ritirate', async () => {
    const { rows } = await db.query<{ ritirata_il: string | null; file_ritirati: string[] }>(
      `SELECT ritirata_il, file_ritirati FROM public.pagelle WHERE alunno_id = '${ALUNNO_2}'`,
    )
    expect(rows[0]).toEqual({ ritirata_il: null, file_ritirati: [] })
  })

  it('ritirata e poi rigenerata: la riga torna in vigore e lo storico resta', async () => {
    await db.exec(`INSERT INTO public.pagelle (scrutinio_id, alunno_id, file_url) VALUES ('${SCRUTINIO}', '${ALUNNO}', '${SCRUTINIO}/${ALUNNO}.pdf')`)
    // `::text` esplicito: con un letterale senza tipo Postgres sceglie `text[] || text[]` e
    // risponde «malformed array literal» (misurato su PGlite e su Postgres 17).
    await db.exec(`
      UPDATE public.pagelle
         SET ritirata_il = now(),
             file_url = 'ritirate/${SCRUTINIO}/${ALUNNO}-1.pdf',
             file_ritirati = file_ritirati || 'ritirate/${SCRUTINIO}/${ALUNNO}-1.pdf'::text
       WHERE scrutinio_id = '${SCRUTINIO}' AND alunno_id = '${ALUNNO}' AND ritirata_il IS NULL`)
    // È l'upsert di `persistPagella`: stesse colonne, stessa coppia del vincolo di unicità.
    await db.exec(`
      INSERT INTO public.pagelle (scrutinio_id, alunno_id, file_url, ritirata_il)
      VALUES ('${SCRUTINIO}', '${ALUNNO}', '${SCRUTINIO}/${ALUNNO}.pdf', NULL)
      ON CONFLICT (scrutinio_id, alunno_id)
      DO UPDATE SET file_url = EXCLUDED.file_url, ritirata_il = EXCLUDED.ritirata_il`)
    const { rows } = await db.query<{ n: number; file_url: string; ritirata_il: string | null; file_ritirati: string[] }>(`
      SELECT count(*) OVER ()::int AS n, file_url, ritirata_il, file_ritirati
        FROM public.pagelle WHERE scrutinio_id = '${SCRUTINIO}' AND alunno_id = '${ALUNNO}'`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      file_url: `${SCRUTINIO}/${ALUNNO}.pdf`,
      ritirata_il: null,
      file_ritirati: [`ritirate/${SCRUTINIO}/${ALUNNO}-1.pdf`],
    })
  })

  it('su un database senza la tabella non si ferma', async () => {
    const vuoto = new PGlite()
    try {
      await expect(vuoto.exec(MIGRAZIONE)).resolves.toBeDefined()
    } finally {
      await vuoto.close()
    }
  })
})
