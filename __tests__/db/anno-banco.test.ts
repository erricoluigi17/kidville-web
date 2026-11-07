import { describe, it, expect } from 'vitest'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * BANCO DI MISURA · il costo del trigger generico dell'anno e di `anno_invarianti()` (Compito 1.6).
 *
 * Gira SOLO con `KIDVILLE_BANCO_ANNO=1`; senza la variabile salta (un `describe.runIf`, cioè un
 * test che non fa niente). Nessuna asserzione sui tempi: sarebbero instabili. Si asserisce solo che
 * le righe ci siano. PGlite non è Postgres in produzione (è WASM, un solo processo, niente disco):
 * i numeri valgono come ORDINE DI GRANDEZZA e come RAPPORTO fra le righe della tabella, non come
 * tempi assoluti. Solo uuid finti.
 *
 * Dal Compito 3.3-2 il banco gira sulla CATENA fino a M3 (la guardia in osservazione c'è solo lì) e ogni caso
 * dichiara le sue manopole (`controlli_rigidi`, `guardia_attiva`, `guardia_osserva`): «spenta» vuol dire TUTTE
 * spente, perché `guardia_osserva` nasce accesa. Il caso aggiunto è l'osservazione (`guardia_attiva = false`,
 * `guardia_osserva = true`, lo stato al merge della PR 3) sullo stesso lavoro (INSERT in blocco, INSERT singoli,
 * UPDATE in blocco), più il caso peggiore: l'UPDATE in blocco su righe di un anno CHIUSO, dove ogni riga passa dal
 * contatore. Nessuna soglia nuova: il banco non ne aveva, e il rapporto osservazione/spenta si legge nella stampa.
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
    const db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M3' })
    const manopole = (rigidi: boolean, attiva: boolean, osserva: boolean) => db.query(
      'UPDATE public.anno_regole SET controlli_rigidi = $1, guardia_attiva = $2, guardia_osserva = $3', [rigidi, attiva, osserva])
    await manopole(false, false, false)
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
    // Senza il trigger `anno_id` (NOT NULL dalla PR 2) non si assegna da solo: il caso «SENZA trigger» lo scrive a mano.
    const annoId = (await db.query<{ a: string }>(
      `SELECT s.anno_id::text AS a FROM public.anni_sede s WHERE s.id = public.anno_attivo($1)`, [SEDE])).rows[0].a
    const bulkSenzaTrigger = () => db.query(
      `INSERT INTO public.presenze (scuola_id, data, anno_id)
       SELECT $1, $2::date + (g % ${GIORNI}), $3 FROM generate_series(1, ${N}) g`, [SEDE, inizio, annoId])
    const singoliSenzaTrigger = async () => {
      for (let i = 0; i < SINGOLI; i++) {
        await db.query(`INSERT INTO public.presenze (scuola_id, data, anno_id) VALUES ($1, $2::date + $3::int, $4)`,
          [SEDE, inizio, i % GIORNI, annoId])
      }
    }
    const singoli = async () => {
      for (let i = 0; i < SINGOLI; i++) {
        await db.query(`INSERT INTO public.presenze (scuola_id, data) VALUES ($1, $2::date + $3::int)`, [SEDE, inizio, i % GIORNI])
      }
    }
    const svuota = () => db.exec('TRUNCATE public.presenze')

    // 1 · senza il trigger generico
    await db.exec('ALTER TABLE public.presenze DISABLE TRIGGER trg_zz_anno_assegna_e_verifica')
    await tempo(`INSERT ${N} in un solo statement, SENZA trigger`, bulkSenzaTrigger)
    expect(await conta()).toBe(N)
    await svuota()
    await tempo(`INSERT ${SINGOLI} singoli, SENZA trigger`, singoliSenzaTrigger)
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

    // 2b · UPDATE in blocco con il trigger spento, per il confronto con l'osservazione
    await bulk()
    await tempo(`UPDATE ${N} (colonna non rilevante), CON trigger (spento)`, () =>
      db.exec(`UPDATE public.presenze SET uscita_anticipata = '11:30'`))
    await svuota()

    // 2c · OSSERVAZIONE (lo stato al merge della PR 3): la guardia calcola, conta, non rifiuta mai
    await manopole(false, false, true)
    await tempo(`INSERT ${N} in un solo statement, osservazione`, bulk)
    expect(await conta()).toBe(N)
    await svuota()
    await tempo(`INSERT ${SINGOLI} singoli, osservazione`, singoli)
    expect(await conta()).toBe(SINGOLI)
    await svuota()
    await bulk()
    await tempo(`UPDATE ${N} (colonna non rilevante), osservazione`, () =>
      db.exec(`UPDATE public.presenze SET uscita_anticipata = '11:30'`))
    await svuota()
    // il caso peggiore: righe di un anno CHIUSO (2025/26, il 31/08/2026 è il suo ultimo giorno), ognuna passa dal contatore
    await manopole(false, false, false)
    await db.exec(`INSERT INTO public.presenze (scuola_id, data)
                   SELECT '${SEDE}', DATE '2026-08-31' FROM generate_series(1, ${N}) g`)
    await manopole(false, false, true)
    await tempo(`UPDATE ${N} su un anno CHIUSO, osservazione (una volta per transazione)`, () =>
      db.exec(`UPDATE public.presenze SET uscita_anticipata = '11:30'`))
    expect(Number((await db.query<{ n: string }>(
      'SELECT coalesce(sum(n), 0)::text AS n FROM public.anno_guardia_osservazioni')).rows[0].n)).toBe(1) // una transazione = un 409: conta UNA volta, non N
    await svuota()
    await manopole(false, false, false)
    await db.exec(`INSERT INTO public.presenze (scuola_id, data)
                   SELECT '${SEDE}', DATE '2026-08-31' FROM generate_series(1, ${N}) g`)
    await tempo(`UPDATE ${N} su un anno CHIUSO, tutto spento (nessuna guardia)`, () =>
      db.exec(`UPDATE public.presenze SET uscita_anticipata = '11:30'`))
    await svuota()

    // 3 · controlli rigidi accesi
    await manopole(true, false, false)
    await tempo(`INSERT ${N} in un solo statement, controlli_rigidi`, bulk)
    expect(await conta()).toBe(N)
    await svuota()
    await tempo(`INSERT ${SINGOLI} singoli, controlli_rigidi`, singoli)
    expect(await conta()).toBe(SINGOLI)
    await svuota()

    // 4 · guardia accesa (righe nell'anno corrente: nessun gettone)
    await manopole(true, true, false)
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
      `\nrapporto con/senza trigger (singoli, spento): ${rapporto(`INSERT ${SINGOLI} singoli, CON`, `INSERT ${SINGOLI} singoli, SENZA`)}` +
      `\nOSSERVAZIONE / spenta: INSERT in blocco ${rapporto(`INSERT ${N} in un solo statement, osservazione`, `INSERT ${N} in un solo statement, CON`)}` +
      ` · INSERT singoli ${rapporto(`INSERT ${SINGOLI} singoli, osservazione`, `INSERT ${SINGOLI} singoli, CON`)}` +
      ` · UPDATE in blocco ${rapporto(`UPDATE ${N} (colonna non rilevante), osservazione`, `UPDATE ${N} (colonna non rilevante), CON`)}` +
      ` · UPDATE su anno chiuso ${rapporto(`UPDATE ${N} su un anno CHIUSO, osservazione`, `UPDATE ${N} su un anno CHIUSO, tutto spento`)}\n`)
    await db.close()
  }, 600_000)
})
