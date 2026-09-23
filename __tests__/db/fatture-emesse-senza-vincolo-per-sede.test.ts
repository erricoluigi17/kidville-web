// @vitest-environment node

/**
 * Test 1 di D1 §12 — la migrazione che toglie il vincolo per sede (scuola_id, anno, numero)
 * da `fatture_emesse`, eseguita su PGlite dal FILE VERO della cartella delle migrazioni.
 *
 * Il vincolo della baseline confondeva la FPR N con la Asilo N della stessa sede: il sezionale
 * è del soggetto fiscale, non della sede. Dopo la migrazione restano a difendere il registro
 * l'indice per serie (sezionale, anno, numero) e quello per pagamento e quota sulle righe vive.
 *
 * Ogni prova ha il suo controllo negativo in fondo: la migrazione ROTTA (senza il drop, senza
 * le guardie) deve far fallire la prova corrispondente, altrimenti la prova non misura niente.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const SUFFISSO = '_fatture_emesse_senza_vincolo_numero_per_sede.sql'
const ULTIMA_MIGRAZIONE_PRECEDENTE = '20260920124744'

const TROVATI = readdirSync(CARTELLA).filter((nome) => nome.endsWith(SUFFISSO))
const NOME_FILE = TROVATI[0] ?? ''
const MIGRAZIONE = NOME_FILE ? readFileSync(join(CARTELLA, NOME_FILE), 'utf8') : ''
const VERSION = NOME_FILE.slice(0, NOME_FILE.indexOf('_'))

const VINCOLO_PER_SEDE = 'fatture_emesse_scuola_id_anno_numero_key'
const INDICE_PER_SERIE = 'fatture_emesse_sezionale_anno_numero_uidx'
const INDICE_PER_QUOTA = 'fatture_emesse_pagamento_quota_uidx'

// uuid palesemente finti: nessuna sede, nessun pagamento vero.
const SEDE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEDE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PAGAMENTO_1 = '11111111-1111-4111-8111-111111111111'
const PAGAMENTO_2 = '22222222-2222-4222-8222-222222222222'
const PAGAMENTO_3 = '33333333-3333-4333-8333-333333333333'
const PAGAMENTO_4 = '44444444-4444-4444-8444-444444444444'

/** Le parti dello schema reale che la migrazione tocca o legge (baseline + 20260809235620). */
const DDL_TABELLA = `
  CREATE TABLE public.fatture_emesse (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pagamento_id uuid NOT NULL, scuola_id uuid NOT NULL,
    numero integer NOT NULL,
    anno integer NOT NULL,
    sezionale text,
    sdi_stato smallint,
    quota_adult_id uuid
  );
  ALTER TABLE ONLY public.fatture_emesse
    ADD CONSTRAINT fatture_emesse_pkey PRIMARY KEY (id);
  ALTER TABLE ONLY public.fatture_emesse
    ADD CONSTRAINT ${VINCOLO_PER_SEDE} UNIQUE (scuola_id, anno, numero);
`
const DDL_INDICE_SERIE = `
  CREATE UNIQUE INDEX ${INDICE_PER_SERIE}
    ON public.fatture_emesse (sezionale, anno, numero)
    WHERE sezionale IS NOT NULL;
`
const DDL_INDICE_QUOTA = `
  CREATE UNIQUE INDEX ${INDICE_PER_QUOTA}
    ON public.fatture_emesse (pagamento_id, COALESCE(quota_adult_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE sdi_stato IS NULL OR sdi_stato NOT IN (2, 4, 9);
`

const aperti: PGlite[] = []

async function nuovoDb(opzioni: { serie?: boolean; quota?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite()
  aperti.push(db)
  await db.exec(DDL_TABELLA)
  if (opzioni.serie !== false) await db.exec(DDL_INDICE_SERIE)
  if (opzioni.quota !== false) await db.exec(DDL_INDICE_QUOTA)
  return db
}

afterEach(async () => {
  while (aperti.length > 0) await aperti.pop()!.close()
})

function riga(r: {
  pagamento: string
  sede: string
  sezionale: string | null
  numero: number
  sdi?: number | null
}): string {
  const sezionale = r.sezionale === null ? 'NULL' : `'${r.sezionale}'`
  const sdi = r.sdi === undefined || r.sdi === null ? 'NULL' : String(r.sdi)
  return `INSERT INTO public.fatture_emesse (pagamento_id, scuola_id, sezionale, anno, numero, sdi_stato)
          VALUES ('${r.pagamento}', '${r.sede}', ${sezionale}, 2026, ${r.numero}, ${sdi});`
}

/** L'errore di Postgres che l'istruzione solleva, o null se passa. */
async function erroreDi(db: PGlite, sql: string): Promise<{ code?: string; message: string } | null> {
  try {
    await db.exec(sql)
    return null
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { code: err.code, message: String(err.message ?? e) }
  }
}

async function vincoloPresente(db: PGlite): Promise<boolean> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = '${VINCOLO_PER_SEDE}'`,
  )
  return r.rows[0].n === 1
}

async function conta(db: PGlite): Promise<number> {
  const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.fatture_emesse')
  return r.rows[0].n
}

/** La coppia che il vincolo per sede rifiutava: Asilo 2542 e FPR 2542 nella stessa sede. */
const COPPIA_STESSA_SEDE =
  riga({ pagamento: PAGAMENTO_1, sede: SEDE_A, sezionale: 'Asilo', numero: 2542 }) +
  riga({ pagamento: PAGAMENTO_2, sede: SEDE_A, sezionale: 'FPR', numero: 2542 })

/**
 * I controlli testuali di D1 §6.3 e della scomposizione (R1-1.1), sul testo INTERO, commenti
 * compresi: «no, nemmeno nei commenti». Restituisce le forme vietate trovate.
 */
function violazioniTestuali(sql: string): string[] {
  const vietate: Array<[string, RegExp]> = [
    ['unique', /unique/i],
    ['primary key', /\bprimary\s+key\b/i],
    ['policy', /\bpolicy\b/i],
    ['row level security', /\brow\s+level\s+security\b/i],
    ['rls', /\brls\b/i],
    ['drop table', /\bdrop\s+table\b/i],
    ['add constraint', /\badd\s+constraint\b/i],
    ['add column scuola_id', /\badd\s+column\s+(if\s+not\s+exists\s+)?scuola_id\b/i],
    ['riga che inizia con scuola_id uuid', /^[ \t]*scuola_id[ \t]+uuid\b/im],
    ['cascade', /\bcascade\b/i],
    ['uuid letterale', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
    ['funzione', /\bcreate\s+(or\s+replace\s+)?function\b/i],
    ['security definer', /\bsecurity\s+definer\b/i],
    ['cron.schedule', /\bcron\s*\.\s*schedule\b/i],
    ['NON APPLICATA', /non\s+applicata/i],
    ['scrittura di dati', /\b(insert\s+into|delete\s+from|truncate|update\s+(only\s+)?public\s*\.)/i],
  ]
  return vietate.filter(([, re]) => re.test(sql)).map(([nome]) => nome)
}

describe('migrazione · fatture_emesse senza il vincolo numero per sede', () => {
  it('il file si trova per suffisso, è uno solo, e la sua VERSION segue l’ultima migrazione e non è nel futuro', () => {
    expect(TROVATI).toHaveLength(1)
    expect(VERSION).toMatch(/^\d{14}$/)
    expect(VERSION > ULTIMA_MIGRAZIONE_PRECEDENTE).toBe(true)
    const adesso = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    expect(VERSION <= adesso).toBe(true)
  })

  it('PRIMA: Asilo 2542 e FPR 2542 nella stessa sede urtano il vincolo per sede (23505)', async () => {
    const db = await nuovoDb()
    const errore = await erroreDi(db, COPPIA_STESSA_SEDE)
    expect(errore?.code).toBe('23505')
    expect(errore?.message).toContain(VINCOLO_PER_SEDE)
  })

  it('DOPO: la stessa coppia entra, e il vincolo per sede non esiste più', async () => {
    const db = await nuovoDb()
    await db.exec(MIGRAZIONE)
    expect(await vincoloPresente(db)).toBe(false)
    expect(await erroreDi(db, COPPIA_STESSA_SEDE)).toBeNull()
    expect(await conta(db)).toBe(2)
  })

  it('DOPO: FPR 2542 in due sedi urta l’indice per serie (23505): il numero è di tutte le sedi insieme', async () => {
    const db = await nuovoDb()
    await db.exec(MIGRAZIONE)
    await db.exec(riga({ pagamento: PAGAMENTO_1, sede: SEDE_A, sezionale: 'FPR', numero: 2542 }))
    const errore = await erroreDi(
      db,
      riga({ pagamento: PAGAMENTO_2, sede: SEDE_B, sezionale: 'FPR', numero: 2542 }),
    )
    expect(errore?.code).toBe('23505')
    expect(errore?.message).toContain(INDICE_PER_SERIE)
    expect(await conta(db)).toBe(1)
  })

  it('DOPO: due righe vive con lo stesso pagamento e la stessa quota urtano l’indice per quota; scartata + viva entrano', async () => {
    const db = await nuovoDb()
    await db.exec(MIGRAZIONE)

    await db.exec(riga({ pagamento: PAGAMENTO_3, sede: SEDE_A, sezionale: 'Asilo', numero: 10 }))
    const errore = await erroreDi(
      db,
      riga({ pagamento: PAGAMENTO_3, sede: SEDE_A, sezionale: 'Asilo', numero: 11, sdi: 1 }),
    )
    expect(errore?.code).toBe('23505')
    expect(errore?.message).toContain(INDICE_PER_QUOTA)

    // Una scartata dallo SdI (2) seguita dalla riemissione viva: entrambe a registro.
    await db.exec(riga({ pagamento: PAGAMENTO_4, sede: SEDE_A, sezionale: 'FPR', numero: 20, sdi: 2 }))
    expect(
      await erroreDi(db, riga({ pagamento: PAGAMENTO_4, sede: SEDE_A, sezionale: 'FPR', numero: 21 })),
    ).toBeNull()
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.fatture_emesse WHERE pagamento_id = '${PAGAMENTO_4}'`,
    )
    expect(r.rows[0].n).toBe(2)
  })

  it('una seconda esecuzione non dà errori e lascia al loro posto i due indici e il commento', async () => {
    const db = await nuovoDb()
    await db.exec(MIGRAZIONE)
    await db.exec(COPPIA_STESSA_SEDE)
    await expect(db.exec(MIGRAZIONE)).resolves.toBeDefined()
    expect(await vincoloPresente(db)).toBe(false)
    expect(await conta(db)).toBe(2)

    const indici = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'fatture_emesse'
       ORDER BY indexname`,
    )
    expect(indici.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([INDICE_PER_QUOTA, INDICE_PER_SERIE]),
    )
    const commento = await db.query<{ c: string | null }>(
      `SELECT obj_description('public.${INDICE_PER_SERIE}'::regclass, 'pg_class') AS c`,
    )
    expect(commento.rows[0].c).toMatch(/per tutte le sedi insieme/)
  })

  it('le guardie fanno RAISE senza l’indice per serie, senza l’indice per quota, e con una riga senza sezionale — e il vincolo resta', async () => {
    const senzaSerie = await nuovoDb({ serie: false })
    const e1 = await erroreDi(senzaSerie, MIGRAZIONE)
    expect(e1?.message).toContain(`manca ${INDICE_PER_SERIE}`)
    expect(await vincoloPresente(senzaSerie)).toBe(true)

    const senzaQuota = await nuovoDb({ quota: false })
    const e2 = await erroreDi(senzaQuota, MIGRAZIONE)
    expect(e2?.message).toContain(`manca ${INDICE_PER_QUOTA}`)
    expect(await vincoloPresente(senzaQuota)).toBe(true)

    const conRigaSenzaSerie = await nuovoDb()
    await conRigaSenzaSerie.exec(
      riga({ pagamento: PAGAMENTO_1, sede: SEDE_A, sezionale: null, numero: 7 }),
    )
    const e3 = await erroreDi(conRigaSenzaSerie, MIGRAZIONE)
    expect(e3?.message).toMatch(/1 righe senza sezionale/)
    expect(await vincoloPresente(conRigaSenzaSerie)).toBe(true)
  })

  it('controlli testuali (D1 §6.3): nessuna forma vietata, nemmeno nei commenti; il drop è quello e solo quello', () => {
    expect(violazioniTestuali(MIGRAZIONE)).toEqual([])
    expect(MIGRAZIONE).toMatch(
      /ALTER TABLE public\.fatture_emesse\s+DROP CONSTRAINT IF EXISTS fatture_emesse_scuola_id_anno_numero_key;/,
    )
    expect(MIGRAZIONE.match(/\bdrop\s+constraint\b/gi)).toHaveLength(1)
    expect(MIGRAZIONE).toMatch(/COMMENT ON INDEX public\.fatture_emesse_sezionale_anno_numero_uidx IS/)
    expect(MIGRAZIONE).toMatch(/la applica l['’]integrazione Supabase al merge della PR-D1/)
    expect(MIGRAZIONE).toMatch(/nessun dato toccato/i)
  })
})

describe('controlli negativi · la prova deve fallire sulla migrazione rotta', () => {
  it('senza il DROP la coppia della stessa sede resta rifiutata: la prova DOPO misura il drop', async () => {
    const senzaDrop = MIGRAZIONE.replace(
      /ALTER TABLE public\.fatture_emesse\s+DROP CONSTRAINT IF EXISTS fatture_emesse_scuola_id_anno_numero_key;/,
      '',
    )
    expect(senzaDrop).not.toBe(MIGRAZIONE)
    const db = await nuovoDb()
    await db.exec(senzaDrop)
    expect(await vincoloPresente(db)).toBe(true)
    expect((await erroreDi(db, COPPIA_STESSA_SEDE))?.code).toBe('23505')
  })

  it('senza il blocco DO delle guardie il vincolo cade anche senza l’indice per serie: la prova delle guardie misura il DO', async () => {
    const senzaGuardie = MIGRAZIONE.replace(/DO \$\$[\s\S]*?END \$\$;/, '')
    expect(senzaGuardie).not.toBe(MIGRAZIONE)
    const db = await nuovoDb({ serie: false })
    // Il COMMENT ON INDEX fallirebbe sull'indice mancante: si toglie per isolare il drop.
    await db.exec(senzaGuardie.replace(/COMMENT ON INDEX[\s\S]*$/, ''))
    expect(await vincoloPresente(db)).toBe(false)
  })

  it('i controlli testuali riconoscono ogni forma vietata su un testo sintetico', () => {
    const casi: Array<[string, string]> = [
      ['unique', '-- il vincolo unique della baseline'],
      ['primary key', 'ALTER TABLE t ADD PRIMARY KEY (id);'],
      ['policy', 'CREATE POLICY p ON t;'],
      ['row level security', 'ALTER TABLE t ENABLE ROW LEVEL SECURITY;'],
      ['cascade', 'DROP INDEX i CASCADE;'],
      ['riga che inizia con scuola_id uuid', 'CREATE TABLE t (\n  scuola_id uuid NOT NULL\n);'],
      ['uuid letterale', `SELECT '${SEDE_A}';`],
      ['NON APPLICATA', '-- NON APPLICATA'],
      ['scrittura di dati', 'UPDATE public.fatture_emesse SET numero = 1;'],
    ]
    for (const [nome, testo] of casi) {
      expect(violazioniTestuali(testo), nome).toContain(nome)
    }
  })
})
