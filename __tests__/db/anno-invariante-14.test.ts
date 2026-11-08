import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.2.M (2) · l'invariante 14 «madre ⇒ FK» non dà più il falso allarme sulle chiavi esterne COMPOSTE.
 *
 * In produzione la 14 dava 3 righe sulle tabelle `votazioni_*`, che hanno una FK composta
 * `(votazione_id, scuola_id) → votazioni(id, scuola_id)` con entrambe le colonne NOT NULL: la madre esiste di sicuro.
 * La regola giusta: una FK dalla tabella alla madre che CONTIENE la `madre_colonna` e che garantisce davvero la madre
 * (una colonna sola, oppure MATCH FULL, oppure tutte le colonne NOT NULL).
 * Solo tabelle e uuid finti.
 */

let db: PGlite

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: ['22222222-2222-4222-8222-222222222222'], fino: 'M42' })
}, 120_000)
afterAll(async () => { await db.close() })

async function quattordici(tabella: string): Promise<number | undefined> {
  const r = await db.query<{ righe: string }>(
    `SELECT righe::text FROM public.anno_invarianti() WHERE invariante = '14' AND tabella = $1`, [tabella])
  return r.rows.length ? Number(r.rows[0].righe) : undefined
}

/** Una madre con chiave (id, scuola_id) e una figlia registrata `madre`; `colonne` e `fk` sono il caso. */
async function caso(nome: string, colonneFiglia: string, fk: string | null): Promise<string> {
  const madre = `m14_${nome}_madre`
  const figlia = `m14_${nome}_figlia`
  await db.exec(`
    CREATE TABLE public.${madre} (id uuid PRIMARY KEY, scuola_id uuid NOT NULL, UNIQUE (id, scuola_id));
    CREATE TABLE public.m14_${nome}_altra (id uuid PRIMARY KEY, scuola_id uuid NOT NULL, UNIQUE (id, scuola_id));
    CREATE TABLE public.${figlia} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${colonneFiglia});
    ${fk ? `ALTER TABLE public.${figlia} ADD CONSTRAINT fk_${nome} ${fk.replaceAll('MADRE', madre).replaceAll('ALTRA', `m14_${nome}_altra`)};` : ''}
    INSERT INTO public.anno_tabelle (tabella, modo, madre_tabella, madre_colonna)
    VALUES ('${figlia}', 'madre', '${madre}', 'madre_id');
  `)
  return figlia
}

describe('4.2.M · invariante 14 e chiavi esterne composte', () => {
  it('FK di una colonna → 0', async () => {
    const t = await caso('una', 'madre_id uuid', 'FOREIGN KEY (madre_id) REFERENCES public.MADRE(id)')
    expect(await quattordici(t)).toBe(0)
  })

  it('FK composta con TUTTE le colonne NOT NULL → 0 (il caso delle votazioni)', async () => {
    const t = await caso('nn', 'madre_id uuid NOT NULL, scuola_id uuid NOT NULL',
      'FOREIGN KEY (madre_id, scuola_id) REFERENCES public.MADRE(id, scuola_id)')
    expect(await quattordici(t)).toBe(0)
  })

  it('FK composta MATCH SIMPLE con una colonna che ammette NULL → 1', async () => {
    const t = await caso('simple', 'madre_id uuid NOT NULL, scuola_id uuid',
      'FOREIGN KEY (madre_id, scuola_id) REFERENCES public.MADRE(id, scuola_id)')
    expect(await quattordici(t)).toBe(1)
  })

  it('FK composta MATCH FULL con una colonna che ammette NULL → 0', async () => {
    const t = await caso('full', 'madre_id uuid NOT NULL, scuola_id uuid',
      'FOREIGN KEY (madre_id, scuola_id) REFERENCES public.MADRE(id, scuola_id) MATCH FULL')
    expect(await quattordici(t)).toBe(0)
  })

  it('FK composta con la colonna NULLABILE proprio quella della madre (madre_id) e MATCH SIMPLE → 1', async () => {
    const t = await caso('simple2', 'madre_id uuid, scuola_id uuid NOT NULL',
      'FOREIGN KEY (madre_id, scuola_id) REFERENCES public.MADRE(id, scuola_id)')
    expect(await quattordici(t)).toBe(1)
  })

  it('nessuna FK → 1', async () => {
    const t = await caso('nessuna', 'madre_id uuid', null)
    expect(await quattordici(t)).toBe(1)
  })

  it('FK verso un\'altra tabella (non la madre) → 1', async () => {
    const t = await caso('altra', 'madre_id uuid NOT NULL, scuola_id uuid NOT NULL',
      'FOREIGN KEY (madre_id, scuola_id) REFERENCES public.ALTRA(id, scuola_id)')
    expect(await quattordici(t)).toBe(1)
  })

  it('FK composta che NON contiene la madre_colonna → 1', async () => {
    const t = await caso('senzacol', 'madre_id uuid, x uuid NOT NULL, scuola_id uuid NOT NULL',
      'FOREIGN KEY (x, scuola_id) REFERENCES public.MADRE(id, scuola_id)')
    expect(await quattordici(t)).toBe(1)
  })
})
