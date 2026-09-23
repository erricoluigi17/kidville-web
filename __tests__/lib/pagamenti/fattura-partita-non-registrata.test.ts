// @vitest-environment node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  CODICI_SDI_SCARTO_REGISTRO,
  MOTIVO_PARTITA_NON_REGISTRATA,
  PREDICATO_SQL_PARTITA_NON_REGISTRATA,
  fatturaPartitaNonRegistrata,
  type RigaRegistroMinima,
} from '@/lib/pagamenti/fattura-partita-non-registrata'
import { fatturaViva } from '@/lib/pagamenti/fattura-viva'
import {
  CASI_PARTITA_NON_REGISTRATA,
  PAGAMENTI_DEI_CASI,
} from '../../fixtures/casi-partita-non-registrata'

type Pag = { fattura_stato?: string | null; fattura_aruba_id?: string | null }
type Predicato = (pag: Pag, righe: readonly RigaRegistroMinima[]) => boolean

/** I casi che un predicato sbaglia, per numero: è il modo in cui i controlli negativi mordono. */
function casiSbagliati(predicato: Predicato): number[] {
  const sbagliati = new Set<number>()
  for (const p of PAGAMENTI_DEI_CASI) {
    if (predicato(p, p.righe) !== p.atteso) sbagliati.add(p.caso)
  }
  return [...sbagliati].sort((a, b) => a - b)
}

// ── Le forme SBAGLIATE, eseguite come casi (controlli negativi) ──────────────

/** «Zero righe»: in attesa e nessuna riga a registro, di qualunque stato. */
const formaZeroRighe: Predicato = (pag, righe) =>
  pag.fattura_stato === 'in_attesa' && righe.length === 0

/** D1 v6: in attesa, nessuna riga viva né col file del pagamento. */
const formaD1v6: Predicato = (pag, righe) => {
  if (pag.fattura_stato !== 'in_attesa') return false
  const file = pag.fattura_aruba_id
  return !righe.some((r) => fatturaViva(r) || (file != null && r.aruba_filename === file))
}

/** D2 v4: in attesa e (nessuna riga viva OPPURE file del pagamento assente). */
const formaD2v4Unione: Predicato = (pag, righe) => {
  if (pag.fattura_stato !== 'in_attesa') return false
  const file = pag.fattura_aruba_id
  const nessunaViva = !righe.some(fatturaViva)
  const fileAssente = file != null && !righe.some((r) => r.aruba_filename === file)
  return nessunaViva || fileAssente
}

/** Ramo nullo con «una riga qualsiasi» al posto di `some(fatturaViva)` (negativo del test 4 di D1). */
const formaRamoNulloSenzaViva: Predicato = (pag, righe) => {
  if (pag.fattura_stato !== 'in_attesa') return false
  const file = pag.fattura_aruba_id
  if (file != null) return !righe.some((r) => r.aruba_filename === file)
  return righe.length === 0
}

describe('fatturaPartitaNonRegistrata — tabella di verità sui 9 casi (CR1)', () => {
  it('i casi condivisi sono 9, numerati da 1 a 9, e ogni caso ha almeno un pagamento', () => {
    expect(CASI_PARTITA_NON_REGISTRATA.map((c) => c.numero)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    for (const c of CASI_PARTITA_NON_REGISTRATA) expect(c.pagamenti.length).toBeGreaterThan(0)
    // Uuid unici: il seed su PGlite li usa come chiave primaria.
    const idPag = PAGAMENTI_DEI_CASI.map((p) => p.id)
    const idRighe = PAGAMENTI_DEI_CASI.flatMap((p) => p.righe.map((r) => r.id))
    expect(new Set(idPag).size).toBe(idPag.length)
    expect(new Set(idRighe).size).toBe(idRighe.length)
    // Entrambi gli esiti sono rappresentati: una tabella tutta vera o tutta falsa non misura nulla.
    expect(PAGAMENTI_DEI_CASI.some((p) => p.atteso)).toBe(true)
    expect(PAGAMENTI_DEI_CASI.some((p) => !p.atteso)).toBe(true)
  })

  for (const caso of CASI_PARTITA_NON_REGISTRATA) {
    for (const p of caso.pagamenti) {
      it(`caso ${caso.numero} (${caso.descrizione}; ${p.fattura_stato}) → ${caso.atteso}`, () => {
        expect(fatturaPartitaNonRegistrata(p, p.righe)).toBe(caso.atteso)
      })
    }
  }

  it('il motivo è la stringa del contratto', () => {
    expect(MOTIVO_PARTITA_NON_REGISTRATA).toBe('partita_non_registrata')
  })
})

describe('controlli negativi: le forme ritirate sbagliano i casi attesi', () => {
  it('il predicato vero non sbaglia nessun caso', () => {
    expect(casiSbagliati(fatturaPartitaNonRegistrata)).toEqual([])
  })

  it('la forma «zero righe» sbaglia i casi 2 e 5 (e anche il 7, sola scartata senza file)', () => {
    // La scomposizione cita 2 e 5; il 7 è la stessa famiglia (una riga scartata
    // che la forma conta come registrazione) sul ramo senza file.
    expect(casiSbagliati(formaZeroRighe)).toEqual([2, 5, 7])
  })

  it('la forma D1 v6 sbaglia il caso 5 (viva di un\'altra quota, file assente)', () => {
    expect(casiSbagliati(formaD1v6)).toEqual([5])
  })

  it('l\'unione D2 v4 sbaglia il caso 3 (scartata dello stesso file: ritrasmissione legittima)', () => {
    expect(casiSbagliati(formaD2v4Unione)).toEqual([3])
  })

  it('il ramo nullo con «una riga qualsiasi» al posto di fatturaViva sbaglia il caso 7', () => {
    expect(casiSbagliati(formaRamoNulloSenzaViva)).toEqual([7])
  })
})

describe('CODICI_SDI_SCARTO_REGISTRO coincide col WHERE di fatture_emesse_pagamento_quota_uidx', () => {
  const MIGRAZIONE = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260809235620_fatture_numerazione_sezionale.sql'),
    'utf8',
  )

  it('stessa lista, nello stesso ordine, e non vuota', () => {
    const m = MIGRAZIONE.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS fatture_emesse_pagamento_quota_uidx[\s\S]*?WHERE\s+sdi_stato\s+IS\s+NULL\s+OR\s+sdi_stato\s+NOT\s+IN\s*\(([^)]*)\)/i,
    )
    // Controllo positivo: se l'indice cambia forma la regex non trova nulla, e
    // il test deve dirlo invece di confrontare due vuoti.
    expect(m, 'WHERE dell\'indice non trovato nella migrazione 20260809235620').not.toBeNull()
    const dallIndice = m![1].split(',').map((s) => Number(s.trim()))
    expect(dallIndice.every(Number.isInteger)).toBe(true)
    expect(dallIndice.length).toBeGreaterThan(0)
    expect([...CODICI_SDI_SCARTO_REGISTRO]).toEqual(dallIndice)
  })

  it('il gemello SQL porta la lista derivata, non un\'altra', () => {
    expect(PREDICATO_SQL_PARTITA_NON_REGISTRATA).toContain(
      `<> ALL (ARRAY[${CODICI_SDI_SCARTO_REGISTRO.join(',')}])`,
    )
  })
})

describe('parità TS/SQL su PGlite, caso per caso', () => {
  let db: PGlite

  /** Gli id dei pagamenti per cui il predicato SQL dato è vero. */
  async function veriSecondo(predicatoSql: string): Promise<Set<string>> {
    const r = await db.query<{ id: string }>(
      `SELECT p.id FROM public.pagamenti p WHERE ${predicatoSql}`,
    )
    return new Set(r.rows.map((x) => x.id))
  }

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      CREATE TABLE public.pagamenti (
        id uuid PRIMARY KEY,
        fattura_stato text,
        fattura_aruba_id text
      );
      CREATE TABLE public.fatture_emesse (
        id uuid PRIMARY KEY,
        pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id),
        quota_adult_id uuid,
        sdi_stato integer,
        aruba_filename text
      );
    `)
    for (const p of PAGAMENTI_DEI_CASI) {
      await db.query(
        'INSERT INTO public.pagamenti (id, fattura_stato, fattura_aruba_id) VALUES ($1, $2, $3)',
        [p.id, p.fattura_stato, p.fattura_aruba_id],
      )
      for (const r of p.righe) {
        await db.query(
          'INSERT INTO public.fatture_emesse (id, pagamento_id, quota_adult_id, sdi_stato, aruba_filename) VALUES ($1, $2, $3, $4, $5)',
          [r.id, p.id, r.quota_adult_id, r.sdi_stato, r.aruba_filename],
        )
      }
    }
  })

  afterAll(async () => {
    await db?.close()
  })

  it('il seed contiene tutti i pagamenti dei casi (controllo contro una parità su tabelle vuote)', async () => {
    const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.pagamenti')
    expect(r.rows[0].n).toBe(PAGAMENTI_DEI_CASI.length)
    expect(PAGAMENTI_DEI_CASI.length).toBeGreaterThanOrEqual(9)
  })

  it('per ogni pagamento, SQL = TS = atteso', async () => {
    const veriSql = await veriSecondo(PREDICATO_SQL_PARTITA_NON_REGISTRATA)
    const divergenze: string[] = []
    for (const p of PAGAMENTI_DEI_CASI) {
      const sql = veriSql.has(p.id)
      const ts = fatturaPartitaNonRegistrata(p, p.righe)
      if (sql !== ts || ts !== p.atteso) {
        divergenze.push(`caso ${p.caso} (${p.fattura_stato}): sql=${sql} ts=${ts} atteso=${p.atteso}`)
      }
    }
    expect(divergenze).toEqual([])
    // L'insieme vero non è banale: né vuoto né tutto.
    expect(veriSql.size).toBeGreaterThan(0)
    expect(veriSql.size).toBeLessThan(PAGAMENTI_DEI_CASI.length)
  })

  it('controllo negativo: il confronto morde — la forma SQL «zero righe» diverge sui casi 2, 5 e 7', async () => {
    const zeroRighe =
      "p.fattura_stato = 'in_attesa' AND NOT EXISTS (SELECT 1 FROM public.fatture_emesse f WHERE f.pagamento_id = p.id)"
    const veri = await veriSecondo(zeroRighe)
    const sbagliati = [
      ...new Set(PAGAMENTI_DEI_CASI.filter((p) => veri.has(p.id) !== p.atteso).map((p) => p.caso)),
    ].sort((a, b) => a - b)
    expect(sbagliati).toEqual([2, 5, 7])
  })

  it('stringa vuota nel file: SQL la tratta come NOT NULL, e il TS resta gemello', async () => {
    // Fuori dai 9 casi condivisi: un `if (file)` in TS la manderebbe nel ramo
    // nullo, e con una riga viva senza file i due lati darebbero esiti opposti.
    const id = 'e0000000-0000-4000-8000-000000000001'
    const rigaId = 'e0000000-0000-4000-8000-000000000002'
    const righe: RigaRegistroMinima[] = [{ sdi_stato: 7, aruba_filename: null }]
    await db.query(
      "INSERT INTO public.pagamenti (id, fattura_stato, fattura_aruba_id) VALUES ($1, 'in_attesa', '')",
      [id],
    )
    await db.query(
      'INSERT INTO public.fatture_emesse (id, pagamento_id, sdi_stato, aruba_filename) VALUES ($1, $2, 7, NULL)',
      [rigaId, id],
    )
    try {
      const sql = (await veriSecondo(PREDICATO_SQL_PARTITA_NON_REGISTRATA)).has(id)
      const ts = fatturaPartitaNonRegistrata({ fattura_stato: 'in_attesa', fattura_aruba_id: '' }, righe)
      expect(sql).toBe(true)
      expect(ts).toBe(sql)
    } finally {
      await db.query('DELETE FROM public.fatture_emesse WHERE id = $1', [rigaId])
      await db.query('DELETE FROM public.pagamenti WHERE id = $1', [id])
    }
  })
})
