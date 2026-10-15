// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrazione, schemaSoldi, TABELLE_SOLDI } from '../helpers/schema-soldi-pglite'

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = 'e0000000-0000-4000-8000-000000000001'
const OPERATORE = 'b0000000-0000-4000-8000-000000000001'
let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await schemaSoldi(db)
  await db.exec(migrazione('_ricarica_ticket_in_una_transazione.sql'))
  await db.exec(migrazione('_storici_ticket.sql'))
})
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`TRUNCATE ${TABELLE_SOLDI} CASCADE`)
  await db.query('INSERT INTO public.alunni (id, scuola_id) VALUES ($1,$2)', [ALUNNO, SEDE])
  await db.exec("INSERT INTO public.payment_categories (slug, scuola_id) VALUES ('mensa', NULL)")
})

async function giorno(delta: number): Promise<string> {
  const { rows } = await db.query<{ giorno: string }>("SELECT ((now() AT TIME ZONE 'Europe/Rome')::date + $1::int)::text AS giorno", [delta])
  return rows[0].giorno
}

async function ricarica(data: string, conferma = false) {
  const { rows } = await db.query<{ esito: { esito: string; pagamento_id?: string; incasso_id?: string } }>(
    'SELECT public.ricarica_ticket_mensa_storico($1,$2,$3,$4,$5,$6,$7) AS esito',
    [ALUNNO, 10, 50, OPERATORE, data, 'contanti', conferma],
  )
  return rows[0].esito
}

describe('ricariche storiche atomiche su Postgres', () => {
  it('ieri: saldo, incasso, pagamento e ledger conservano la data evento; creato_il resta oggi', async () => {
    const ieri = await giorno(-1)
    expect((await ricarica(ieri)).esito).toBe('ok')
    const { rows } = await db.query<{ data: string; incasso: string; scadenza: string; registrazione: string; ultimo: string; saldo_ticket: number }>(`
      SELECT m.data::text, i.data_incasso::text AS incasso, p.scadenza::text,
        (m.creato_il AT TIME ZONE 'Europe/Rome')::date::text AS registrazione,
        (t.ultimo_carico AT TIME ZONE 'Europe/Rome')::date::text AS ultimo, t.saldo_ticket
      FROM public.mensa_ticket_movimenti m JOIN public.pagamenti p ON p.id=m.pagamento_id
      JOIN public.incassi i ON i.pagamento_id=p.id JOIN public.ticket_mensa t ON t.alunno_id=m.alunno_id`)
    expect(rows[0]).toEqual({ data: ieri, incasso: ieri, scadenza: ieri, registrazione: await giorno(0), ultimo: ieri, saldo_ticket: 10 })
  })

  it('dedup sul giorno scelto anche se la ricarica è registrata tecnicamente oggi', async () => {
    const ieri = await giorno(-1)
    expect((await ricarica(ieri)).esito).toBe('ok')
    expect((await ricarica(ieri)).esito).toBe('duplicato')
    expect((await ricarica(await giorno(0))).esito).toBe('ok')
    const { rows } = await db.query<{ saldo_ticket: number }>('SELECT saldo_ticket FROM public.ticket_mensa')
    expect(rows[0].saldo_ticket).toBe(20)
  })

  it('una ricarica storica non arretra l’ultimo carico effettivo', async () => {
    await ricarica(await giorno(0))
    await ricarica(await giorno(-10))
    const { rows } = await db.query<{ ultimo: string }>("SELECT (ultimo_carico AT TIME ZONE 'Europe/Rome')::date::text AS ultimo FROM public.ticket_mensa")
    expect(rows[0].ultimo).toBe(await giorno(0))
  })

  it('errore nell’allineamento del ledger: nessuna ricarica parzialmente salvata', async () => {
    const ieri = await giorno(-1)
    await db.exec(`ALTER TABLE public.mensa_ticket_movimenti ADD CONSTRAINT prova_storico CHECK (data <> '${ieri}'::date)`)
    try {
      await expect(ricarica(ieri)).rejects.toThrow()
      const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.pagamenti')
      expect(rows[0].n).toBe(0)
      const saldi = await db.query('SELECT * FROM public.ticket_mensa')
      expect(saldi.rows).toHaveLength(0)
    } finally {
      await db.exec('ALTER TABLE public.mensa_ticket_movimenti DROP CONSTRAINT prova_storico')
    }
  })

  it('data futura rifiutata prima di qualunque scrittura', async () => {
    await expect(ricarica(await giorno(1))).rejects.toThrow('giorno di competenza non valido')
  })
})
