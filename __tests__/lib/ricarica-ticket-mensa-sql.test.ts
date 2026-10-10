// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrazione, schemaSoldi, TABELLE_SOLDI } from '../helpers/schema-soldi-pglite'

/**
 * RICARICA DEI TICKET MENSA · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Fino al 2026-10-10 la route faceva quattro scritture separate (saldo,
 * pagamento, incasso, movimento): ognuna poteva fallire dopo le precedenti.
 * `ricarica_ticket_mensa` le fa in una transazione. Il caso che conta di più è
 * in fondo: un passo che fallisce A METÀ (qui l'incasso, con un metodo fuori
 * elenco) non lascia NIENTE — né saldo salito, né pagamento, né movimento.
 *
 * PGlite ha una connessione sola: la serializzazione di due click (advisory lock)
 * la sorveglia il lock `ticket-ricarica-una-transazione`; la prova con due
 * sessioni vere sta nel PR. Solo dati finti.
 */

const NUOVA = migrazione('_ricarica_ticket_in_una_transazione.sql')
const SEDE = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = 'e0000000-0000-4000-8000-000000000001'
const OPERATORE = 'b0000000-0000-4000-8000-000000000001'

let db: PGlite

type Esito = { esito: string } & Record<string, unknown>

async function ricarica(a: {
  pezzi: number; costo: number; metodo?: string | null; conferma?: boolean; dalle?: string | null; alle?: string | null; alunno?: string
}): Promise<Esito> {
  const r = await db.query<{ r: Esito }>(
    `SELECT public.ricarica_ticket_mensa(
       p_alunno_id => $1, p_pezzi => $2, p_costo => $3, p_operatore => $4, p_metodo => $5,
       p_conferma_duplicato => $6, p_giorno_dalle => $7, p_giorno_alle => $8) AS r`,
    [a.alunno ?? ALUNNO, a.pezzi, a.costo, OPERATORE, a.metodo ?? null, a.conferma ?? false, a.dalle ?? null, a.alle ?? null],
  )
  return r.rows[0].r
}

async function conteggi() {
  const r = await db.query<{ saldo: number | null; pagamenti: number; incassi: number; movimenti: number; pagati: number }>(`
    SELECT (SELECT saldo_ticket FROM public.ticket_mensa WHERE alunno_id = $1) AS saldo,
           (SELECT count(*)::int FROM public.pagamenti WHERE alunno_id = $1) AS pagamenti,
           (SELECT count(*)::int FROM public.incassi i JOIN public.pagamenti p ON p.id = i.pagamento_id WHERE p.alunno_id = $1) AS incassi,
           (SELECT count(*)::int FROM public.mensa_ticket_movimenti WHERE alunno_id = $1) AS movimenti,
           (SELECT count(*)::int FROM public.pagamenti WHERE alunno_id = $1 AND stato = 'pagato') AS pagati`, [ALUNNO])
  return r.rows[0]
}

// Un giorno largo che contiene sempre «adesso».
const IERI = new Date(Date.now() - 86_400_000).toISOString()
const DOMANI = new Date(Date.now() + 86_400_000).toISOString()

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
  await db.query('INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)', [ALUNNO, SEDE])
  await db.exec(`INSERT INTO public.payment_categories (slug, scuola_id) VALUES ('mensa', NULL)`)
})

describe('ricarica_ticket_mensa · saldo, pagamento, incasso e movimento insieme', () => {
  it('la migrazione si riapplica senza errori (CREATE OR REPLACE)', async () => {
    await db.exec(NUOVA)
  })

  it('ricarica pagata: saldo, pagamento «pagato» con la categoria mensa, incasso, movimento col saldo giusto', async () => {
    const e = await ricarica({ pezzi: 10, costo: 45 })
    expect(e.esito).toBe('ok')
    expect(e.saldo).toBe(10)
    expect(e.scuola_id).toBe(SEDE)
    expect(await conteggi()).toEqual({ saldo: 10, pagamenti: 1, incassi: 1, movimenti: 1, pagati: 1 })
    const p = await db.query<{ descrizione: string; importo: string; cat: string }>(
      `SELECT p.descrizione, p.importo, c.slug AS cat FROM public.pagamenti p JOIN public.payment_categories c ON c.id = p.categoria_id`,
    )
    expect(p.rows[0]).toEqual({ descrizione: 'Ricarica mensa — 10 ticket', importo: '45.00', cat: 'mensa' })
    const m = await db.query<{ saldo_dopo: number; origine: string; scuola_id: string }>(
      'SELECT saldo_dopo, origine, scuola_id FROM public.mensa_ticket_movimenti',
    )
    expect(m.rows[0]).toEqual({ saldo_dopo: 10, origine: 'segreteria', scuola_id: SEDE })
  })

  it('due ricariche (la seconda confermata) sommano il saldo, e il ledger lo segue', async () => {
    await ricarica({ pezzi: 10, costo: 45 })
    const e = await ricarica({ pezzi: 5, costo: 22.5, conferma: true, dalle: IERI, alle: DOMANI })
    expect(e.saldo).toBe(15)
    const m = await db.query<{ saldo_dopo: number }>('SELECT saldo_dopo FROM public.mensa_ticket_movimenti ORDER BY creato_il, saldo_dopo')
    expect(m.rows.map((x) => x.saldo_dopo)).toEqual([10, 15])
  })

  it('costo 0: saldo e movimento sì, incasso no', async () => {
    const e = await ricarica({ pezzi: 3, costo: 0 })
    expect(e.incasso_id).toBeNull()
    expect(await conteggi()).toMatchObject({ saldo: 3, pagamenti: 1, incassi: 0, movimenti: 1 })
  })

  it('🔴 già ricaricato oggi → «duplicato» con la ricarica precedente, e NIENTE scritto', async () => {
    await ricarica({ pezzi: 10, costo: 45 })
    const prima = await conteggi()
    const e = await ricarica({ pezzi: 10, costo: 45, dalle: IERI, alle: DOMANI })
    expect(e.esito).toBe('duplicato')
    const prec = e.precedente as { pezzi: number; importo: string }
    expect(prec.pezzi).toBe(10)
    expect(Number(prec.importo)).toBe(45)
    expect(await conteggi()).toEqual(prima)
  })

  it('la guardia guarda solo la finestra passata: una ricarica di ieri non conta', async () => {
    await ricarica({ pezzi: 10, costo: 45 })
    await db.exec(`UPDATE public.mensa_ticket_movimenti SET creato_il = now() - interval '3 days'`)
    const e = await ricarica({ pezzi: 2, costo: 9, dalle: new Date(Date.now() - 3_600_000).toISOString(), alle: DOMANI })
    expect(e.esito).toBe('ok')
  })

  it('🔴 un passo che fallisce A METÀ (incasso con metodo fuori elenco) non lascia NIENTE', async () => {
    await expect(ricarica({ pezzi: 10, costo: 45, metodo: 'baratto' })).rejects.toThrow()
    expect(await conteggi()).toEqual({ saldo: null, pagamenti: 0, incassi: 0, movimenti: 0, pagati: 0 })
  })

  it('alunno inesistente → non_trovato; pezzi 0 o costo negativo → errore 22023', async () => {
    expect((await ricarica({ pezzi: 1, costo: 1, alunno: 'e0000000-0000-4000-8000-0000000000ff' })).esito).toBe('non_trovato')
    await expect(ricarica({ pezzi: 0, costo: 1 })).rejects.toThrow(/pezzi/)
    await expect(ricarica({ pezzi: 1, costo: -1 })).rejects.toThrow(/costo/)
    expect((await conteggi()).pagamenti).toBe(0)
  })

  it('i permessi: EXECUTE solo alla service_role', async () => {
    const r = await db.query<{ ruolo: string; puo: boolean }>(`
      SELECT ruolo, has_function_privilege(ruolo,
        'public.ricarica_ticket_mensa(uuid, integer, numeric, uuid, text, boolean, timestamptz, timestamptz)', 'EXECUTE') AS puo
        FROM unnest(ARRAY['anon','authenticated','service_role']) AS ruolo`)
    expect(Object.fromEntries(r.rows.map((x) => [x.ruolo, x.puo]))).toEqual({
      anon: false, authenticated: false, service_role: true,
    })
  })

  it('controllo negativo: le scritture SEPARATE di prima lasciano il saldo salito senza pagamento', async () => {
    // Le prime due istruzioni della route fino al 2026-10-10, con il pagamento che fallisce.
    await db.query('SELECT public.varia_saldo_ticket($1, 10)', [ALUNNO])
    await expect(
      db.query(`INSERT INTO public.pagamenti (alunno_id, importo, tipo) VALUES ($1, 45, 'inesistente')`, [ALUNNO]),
    ).rejects.toThrow()
    expect(await conteggi()).toMatchObject({ saldo: 10, pagamenti: 0 })
  })
})
