import { describe, it, expect } from 'vitest'
import { creaDbAnno } from '../helpers/schema-anno-pglite'

/**
 * BANCO DI MISURA · il costo del trigger generico dell'anno e di `anno_invarianti()` (Compito 1.6).
 *
 * Gira SOLO con `KIDVILLE_BANCO_ANNO=1`; senza la variabile salta (un `describe.runIf`, cioè un
 * test che non fa niente). Nessuna asserzione sui tempi: sarebbero instabili. Si asserisce solo che
 * le righe ci siano. PGlite non è Postgres in produzione (è WASM, un solo processo, niente disco):
 * i numeri valgono come ORDINE DI GRANDEZZA e come RAPPORTO fra le righe della tabella, non come
 * tempi assoluti. Solo uuid finti.
 *
 * Cosa NON misura: l'UPDATE di una riga con `anno_id` NULL, che fa il calcolo completo finché la PR 2 non
 * riempie le righe vecchie, perché gli INSERT del banco assegnano già l'anno.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const N = 10_000
const SINGOLI = 1_000
const GIORNI = 250

const attivo = process.env.KIDVILLE_BANCO_ANNO === '1'

describe.runIf(attivo)('banco anno · trigger generico e anno_invarianti()', () => {
  it('misura e stampa i tempi', async () => {
    const db = await creaDbAnno({ sediPrimaDellaMigrazione: [SEDE] })
    await db.exec('ALTER TABLE public.presenze ADD COLUMN uscita_anticipata time')
    const inizio = (await db.query<{ i: string }>(
      `SELECT s.inizio::text AS i FROM public.anni_sede s WHERE s.id = public.anno_attivo($1)`, [SEDE])).rows[0].i
    const righe: Array<[string, number]> = []
    const conta = async () =>
      Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.presenze')).rows[0].n)
    const tempo = async (nome: string, f: () => Promise<unknown>) => {
      const t = performance.now()
      await f()
      righe.push([nome, Math.round(performance.now() - t)])
    }
    const bulk = () => db.query(
      `INSERT INTO public.presenze (scuola_id, data)
       SELECT $1, $2::date + (g % ${GIORNI}) FROM generate_series(1, ${N}) g`, [SEDE, inizio])
    const singoli = async () => {
      for (let i = 0; i < SINGOLI; i++) {
        await db.query(`INSERT INTO public.presenze (scuola_id, data) VALUES ($1, $2::date + $3::int)`, [SEDE, inizio, i % GIORNI])
      }
    }
    const svuota = () => db.exec('TRUNCATE public.presenze')

    // 1 · senza il trigger generico
    await db.exec('ALTER TABLE public.presenze DISABLE TRIGGER trg_zz_anno_assegna_e_verifica')
    await tempo(`INSERT ${N} in un solo statement, SENZA trigger`, bulk)
    expect(await conta()).toBe(N)
    await svuota()
    await tempo(`INSERT ${SINGOLI} singoli, SENZA trigger`, singoli)
    expect(await conta()).toBe(SINGOLI)
    await svuota()
    await db.exec('ALTER TABLE public.presenze ENABLE TRIGGER trg_zz_anno_assegna_e_verifica')

    // 2 · con il trigger, controlli e guardia spenti (lo stato al merge)
    await tempo(`INSERT ${N} in un solo statement, CON trigger (spento)`, bulk)
    expect(await conta()).toBe(N)
    await svuota()
    await tempo(`INSERT ${SINGOLI} singoli, CON trigger (spento)`, singoli)
    expect(await conta()).toBe(SINGOLI)
    await svuota()

    // 3 · controlli rigidi accesi
    await db.exec('UPDATE public.anno_regole SET controlli_rigidi = true')
    await tempo(`INSERT ${N} in un solo statement, controlli_rigidi`, bulk)
    expect(await conta()).toBe(N)
    await svuota()
    await tempo(`INSERT ${SINGOLI} singoli, controlli_rigidi`, singoli)
    expect(await conta()).toBe(SINGOLI)
    await svuota()

    // 4 · guardia accesa (righe nell'anno corrente: nessun gettone)
    await db.exec('UPDATE public.anno_regole SET guardia_attiva = true')
    await tempo(`INSERT ${N} in un solo statement, guardia_attiva`, bulk)
    expect(await conta()).toBe(N)
    await svuota()
    await tempo(`INSERT ${SINGOLI} singoli, guardia_attiva`, singoli)
    expect(await conta()).toBe(SINGOLI)
    await svuota()

    // 5 · UPDATE e DELETE con la guardia accesa; poi le invarianti sulle righe presenti
    await bulk()
    await tempo(`UPDATE ${N} (colonna non rilevante), guardia_attiva`, () =>
      db.exec(`UPDATE public.presenze SET uscita_anticipata = '11:30'`))
    expect(Number((await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.presenze WHERE uscita_anticipata IS NOT NULL')).rows[0].n)).toBe(N)
    for (let k = 1; k <= 3; k++) {
      await tempo(`anno_invarianti() su ${N} presenze, esecuzione ${k}`, async () => {
        const r = await db.query('SELECT * FROM public.anno_invarianti()')
        expect(r.rows.length).toBeGreaterThan(0)
      })
    }
    await tempo(`DELETE ${N}, guardia_attiva`, () => db.exec('DELETE FROM public.presenze'))
    expect(await conta()).toBe(0)

    const con = (testo: string) => righe.find(([n]) => n.startsWith(testo))![1]
    const rapporto = (a: string, b: string) => (con(a) / Math.max(1, con(b))).toFixed(2)
    console.log(
      '\nBANCO ANNO (PGlite: ordine di grandezza)\n' +
      righe.map(([n, ms]) => `${String(ms).padStart(7)} ms  ${n}`).join('\n') +
      `\nrapporto con/senza trigger (bulk, spento): ${rapporto(`INSERT ${N} in un solo statement, CON`, `INSERT ${N} in un solo statement, SENZA`)}` +
      `\nrapporto con/senza trigger (singoli, spento): ${rapporto(`INSERT ${SINGOLI} singoli, CON`, `INSERT ${SINGOLI} singoli, SENZA`)}\n`)
    await db.close()
  }, 600_000)
})
