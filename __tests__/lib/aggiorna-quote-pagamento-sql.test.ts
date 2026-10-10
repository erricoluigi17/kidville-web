// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrazione, schemaSoldi, TABELLE_SOLDI } from '../helpers/schema-soldi-pglite'

/**
 * QUOTE DI UN PAGAMENTO DIVISO · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Fino al 2026-10-10 la route cancellava tutte le quote e le reinseriva: ogni
 * quota rinasceva con un id nuovo e la FK `incassi.quota_id … ON DELETE SET NULL`
 * staccava ogni incasso già registrato. Ora `aggiorna_quote_pagamento` aggiorna
 * chi resta, inserisce i nuovi, toglie gli assenti solo se senza incassi.
 *
 * In fondo il controllo negativo: il comportamento VECCHIO (DELETE + INSERT),
 * eseguito sullo stesso schema, lascia l'incasso con `quota_id` NULL. Se non lo
 * lasciasse, questo test non misurerebbe niente.
 *
 * Solo dati finti.
 */

const NUOVA = migrazione('_aggiorna_quote_senza_reinserire.sql')
const MAMMA = 'c0000000-0000-4000-8000-000000000001'
const PAPA = 'c0000000-0000-4000-8000-000000000002'
const NONNA = 'c0000000-0000-4000-8000-000000000003'
const OPERATORE = 'b0000000-0000-4000-8000-000000000001'

let db: PGlite

type Quota = { id: string; adult_id: string; importo: string; etichetta: string | null }
type Esito = { esito: string; quote?: Quota[]; tolte?: number } & Record<string, unknown>

async function aggiorna(pagamento: string, quote: { adult_id: string; importo: number | string; etichetta?: string | null }[]): Promise<Esito> {
  const r = await db.query<{ r: Esito }>(
    'SELECT public.aggiorna_quote_pagamento($1, $2::jsonb, $3) AS r',
    [pagamento, JSON.stringify(quote), OPERATORE],
  )
  return r.rows[0].r
}

async function voce(importo: number): Promise<string> {
  const r = await db.query<{ id: string }>('INSERT INTO public.pagamenti (importo) VALUES ($1) RETURNING id', [importo])
  return r.rows[0].id
}

async function quoteDi(pagamento: string): Promise<Quota[]> {
  const r = await db.query<Quota>(
    'SELECT id, adult_id, importo, etichetta FROM public.pagamenti_quote WHERE pagamento_id = $1 ORDER BY adult_id',
    [pagamento],
  )
  return r.rows
}

async function incassaSuQuota(pagamento: string, quota: string, importo: number): Promise<string> {
  const r = await db.query<{ id: string }>(
    'INSERT INTO public.incassi (pagamento_id, importo, quota_id) VALUES ($1, $2, $3) RETURNING id',
    [pagamento, importo, quota],
  )
  return r.rows[0].id
}

async function quotaDellIncasso(incasso: string): Promise<string | null> {
  const r = await db.query<{ quota_id: string | null }>('SELECT quota_id FROM public.incassi WHERE id = $1', [incasso])
  return r.rows[0].quota_id
}

beforeAll(async () => {
  db = new PGlite()
  await schemaSoldi(db)
  await db.exec(NUOVA)
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await db.exec(`TRUNCATE ${TABELLE_SOLDI} CASCADE;`)
  await db.query('INSERT INTO public.utenti (id) VALUES ($1), ($2), ($3)', [MAMMA, PAPA, NONNA])
})

describe('aggiorna_quote_pagamento · le quote si aggiornano, non si reinseriscono', () => {
  it('la migrazione si riapplica senza errori (CREATE OR REPLACE)', async () => {
    await db.exec(NUOVA)
  })

  it('prima divisione: crea le quote e segna il pagamento «split», con l\'audit', async () => {
    const p = await voce(300)
    const e = await aggiorna(p, [{ adult_id: MAMMA, importo: 150 }, { adult_id: PAPA, importo: '150' }])
    expect(e.esito).toBe('ok')
    expect(e.quote).toHaveLength(2)
    const t = await db.query<{ tipo: string }>('SELECT tipo::text FROM public.pagamenti WHERE id = $1', [p])
    expect(t.rows[0].tipo).toBe('split')
    const a = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.registro_modifiche WHERE azione = 'aggiorna_quote'`)
    expect(a.rows[0].n).toBe(1)
  })

  it('🔴 cambiare gli importi NON stacca gli incassi: stesso id di quota, quota_id intatto', async () => {
    const p = await voce(300)
    await aggiorna(p, [{ adult_id: MAMMA, importo: 150 }, { adult_id: PAPA, importo: 150 }])
    const [qMamma] = (await quoteDi(p)).filter((q) => q.adult_id === MAMMA)
    const inc = await incassaSuQuota(p, qMamma.id, 50)

    const e = await aggiorna(p, [{ adult_id: MAMMA, importo: 200, etichetta: 'mamma' }, { adult_id: PAPA, importo: 100 }])
    expect(e.esito).toBe('ok')
    const dopo = await quoteDi(p)
    const mammaDopo = dopo.find((q) => q.adult_id === MAMMA)!
    expect(mammaDopo.id).toBe(qMamma.id)
    expect(Number(mammaDopo.importo)).toBe(200)
    expect(mammaDopo.etichetta).toBe('mamma')
    expect(await quotaDellIncasso(inc)).toBe(qMamma.id)
  })

  it('un adulto nuovo si aggiunge, uno che esce si toglie (se non ha incassi)', async () => {
    const p = await voce(300)
    await aggiorna(p, [{ adult_id: MAMMA, importo: 150 }, { adult_id: PAPA, importo: 150 }])
    const e = await aggiorna(p, [{ adult_id: MAMMA, importo: 150 }, { adult_id: NONNA, importo: 150 }])
    expect(e.esito).toBe('ok')
    expect(e.tolte).toBe(1)
    expect((await quoteDi(p)).map((q) => q.adult_id)).toEqual([MAMMA, NONNA])
  })

  it('un adulto che esce ma HA incassi → quota_con_incassi, e niente cambia', async () => {
    const p = await voce(300)
    await aggiorna(p, [{ adult_id: MAMMA, importo: 150 }, { adult_id: PAPA, importo: 150 }])
    const [qPapa] = (await quoteDi(p)).filter((q) => q.adult_id === PAPA)
    const inc = await incassaSuQuota(p, qPapa.id, 20)
    const prima = await quoteDi(p)

    const e = await aggiorna(p, [{ adult_id: MAMMA, importo: 100 }, { adult_id: NONNA, importo: 200 }])
    expect(e.esito).toBe('quota_con_incassi')
    expect(e.quote).toEqual([qPapa.id])
    expect(await quoteDi(p)).toEqual(prima)
    expect(await quotaDellIncasso(inc)).toBe(qPapa.id)
  })

  it('somma diversa dall\'importo → somma_diversa senza scritture', async () => {
    const p = await voce(300)
    const e = await aggiorna(p, [{ adult_id: MAMMA, importo: 100 }, { adult_id: PAPA, importo: 100 }])
    expect(e.esito).toBe('somma_diversa')
    expect(await quoteDi(p)).toEqual([])
  })

  it('lo stesso adulto due volte → adulto_ripetuto', async () => {
    const p = await voce(300)
    const e = await aggiorna(p, [{ adult_id: MAMMA, importo: 150 }, { adult_id: MAMMA, importo: 150 }])
    expect(e.esito).toBe('adulto_ripetuto')
    expect(await quoteDi(p)).toEqual([])
  })

  it('pagamento inesistente → non_trovato; meno di due quote → errore 22023', async () => {
    const e = await aggiorna('d0000000-0000-4000-8000-000000000009', [{ adult_id: MAMMA, importo: 1 }, { adult_id: PAPA, importo: 1 }])
    expect(e.esito).toBe('non_trovato')
    const p = await voce(300)
    await expect(aggiorna(p, [{ adult_id: MAMMA, importo: 300 }])).rejects.toThrow(/almeno 2 quote/)
  })

  it('adulto inesistente → errore di FK e ROLLBACK: le quote di prima restano', async () => {
    const p = await voce(300)
    await aggiorna(p, [{ adult_id: MAMMA, importo: 150 }, { adult_id: PAPA, importo: 150 }])
    const prima = await quoteDi(p)
    await expect(
      aggiorna(p, [{ adult_id: MAMMA, importo: 150 }, { adult_id: 'c0000000-0000-4000-8000-0000000000ff', importo: 150 }]),
    ).rejects.toThrow()
    expect(await quoteDi(p)).toEqual(prima)
  })

  it('i permessi: EXECUTE solo alla service_role', async () => {
    const r = await db.query<{ ruolo: string; puo: boolean }>(`
      SELECT ruolo, has_function_privilege(ruolo, 'public.aggiorna_quote_pagamento(uuid, jsonb, uuid)', 'EXECUTE') AS puo
        FROM unnest(ARRAY['anon','authenticated','service_role']) AS ruolo`)
    expect(Object.fromEntries(r.rows.map((x) => [x.ruolo, x.puo]))).toEqual({
      anon: false, authenticated: false, service_role: true,
    })
  })

  it('controllo negativo: il comportamento VECCHIO (DELETE + INSERT) stacca l\'incasso', async () => {
    const p = await voce(300)
    await aggiorna(p, [{ adult_id: MAMMA, importo: 150 }, { adult_id: PAPA, importo: 150 }])
    const [qMamma] = (await quoteDi(p)).filter((q) => q.adult_id === MAMMA)
    const inc = await incassaSuQuota(p, qMamma.id, 50)
    // Le due istruzioni della route fino al 2026-10-10.
    await db.query('DELETE FROM public.pagamenti_quote WHERE pagamento_id = $1', [p])
    await db.query(
      'INSERT INTO public.pagamenti_quote (pagamento_id, adult_id, importo) VALUES ($1, $2, 200), ($1, $3, 100)',
      [p, MAMMA, PAPA],
    )
    expect(await quotaDellIncasso(inc)).toBeNull()
  })
})
