import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 3.3-3 (f) · INVARIANTE 14 «MADRE ⇒ FK» (Ruling P5), in `anno_invarianti()` ridefinita da M3.
 *
 * Ogni riga `madre` di `anno_tabelle` deve avere una chiave esterna vera (`pg_constraint`, `contype = 'f'`, UNA colonna)
 * dalla colonna `madre_colonna` della figlia alla tabella madre. Oggi in produzione sono 18 su 18.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'

let db: PGlite

async function righe14(): Promise<Array<{ tabella: string; righe: number }>> {
  const r = await db.query<{ tabella: string; righe: string }>(
    `SELECT tabella, righe::text FROM public.anno_invarianti() WHERE invariante = '14' ORDER BY tabella`)
  return r.rows.map((x) => ({ tabella: x.tabella, righe: Number(x.righe) }))
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M3', completo: true })
}, 120_000)
afterAll(async () => { await db.close() })

async function sei(): Promise<number> {
  const r = await db.query<{ righe: string }>(
    `SELECT righe::text FROM public.anno_invarianti() WHERE invariante = '6' AND tabella = 'presenze'`)
  return Number(r.rows[0]?.righe ?? -1)
}

describe('3.3-3 (P31) · la 6 allineata a M3: le tabelle con `guardia` ridotta non sono scritture non guardate', () => {
  it('una modifica di un anno chiuso che ha scavalcato la guardia conta 1 su una tabella `piena`, 0 se la tabella è `nessuna`/`solo_contenuto`', async () => {
    await db.exec(`UPDATE public.anno_regole SET guardia_attiva = false, guardia_osserva = false`)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ('44444444-4444-4444-8444-444444444441', $1)`, [SEDE])
    const id = (await db.query<{ id: string }>(
      `INSERT INTO public.presenze (alunno_id, scuola_id, data) VALUES ('44444444-4444-4444-8444-444444444441', $1, DATE '2026-03-10') RETURNING id`, [SEDE])).rows[0].id
    await db.exec(`UPDATE public.anno_regole SET guardia_attiva = true`)
    await db.exec(`ALTER TABLE public.presenze DISABLE TRIGGER trg_zz_anno_assegna_e_verifica`)
    await db.query(`UPDATE public.presenze SET alunno_id = gen_random_uuid() WHERE id = $1`, [id])
    expect(await sei()).toBe(1)
    await db.exec(`UPDATE public.anno_tabelle SET guardia = 'solo_contenuto' WHERE tabella = 'presenze'`)
    expect(await sei()).toBe(0)
    await db.exec(`UPDATE public.anno_tabelle SET guardia = 'nessuna' WHERE tabella = 'presenze'`)
    expect(await sei()).toBe(0)
    await db.exec(`UPDATE public.anno_tabelle SET guardia = 'piena' WHERE tabella = 'presenze'`)
    expect(await sei()).toBe(1)
  })
})

describe('3.3-3 (f) · madre ⇒ FK', () => {
  it('sul seme pulito: almeno una tabella `madre` controllata, e zero difetti', async () => {
    const r = await righe14()
    expect(r.length).toBeGreaterThan(0)
    expect(r.filter((x) => x.righe > 0)).toEqual([])
    // e il numero di righe `madre` presenti nel database è quello che l'invariante guarda
    const madri = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.anno_tabelle t
        WHERE t.modo = 'madre' AND to_regclass(format('public.%I', t.tabella)) IS NOT NULL`)
    expect(r.length).toBe(Number(madri.rows[0].n))
  })

  it('una riga `madre` senza chiave esterna fa uscire 1; con la chiave torna 0; una FK composta non conta', async () => {
    await db.exec(`
      CREATE TABLE public.madre_di_prova (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.figlia_di_prova (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), madre_id uuid, altra_id uuid);
      INSERT INTO public.anno_tabelle (tabella, modo, madre_tabella, madre_colonna)
      VALUES ('figlia_di_prova', 'madre', 'madre_di_prova', 'madre_id');
    `)
    expect((await righe14()).find((x) => x.tabella === 'figlia_di_prova')).toEqual({ tabella: 'figlia_di_prova', righe: 1 })

    // una FK su un'ALTRA colonna non basta
    await db.exec(`ALTER TABLE public.figlia_di_prova ADD CONSTRAINT fk_altra FOREIGN KEY (altra_id) REFERENCES public.madre_di_prova(id)`)
    expect((await righe14()).find((x) => x.tabella === 'figlia_di_prova')?.righe).toBe(1)

    // la FK giusta
    await db.exec(`ALTER TABLE public.figlia_di_prova ADD CONSTRAINT fk_madre FOREIGN KEY (madre_id) REFERENCES public.madre_di_prova(id)`)
    expect((await righe14()).find((x) => x.tabella === 'figlia_di_prova')?.righe).toBe(0)

    // ... e tolta di nuovo, torna il difetto
    await db.exec(`ALTER TABLE public.figlia_di_prova DROP CONSTRAINT fk_madre`)
    expect((await righe14()).find((x) => x.tabella === 'figlia_di_prova')?.righe).toBe(1)
  })
})
