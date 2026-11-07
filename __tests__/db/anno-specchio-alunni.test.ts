import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * PR 2 · COMPITO 2.3 · LO SPECCHIO `alunni` → `frequenze` (fase A, §4.19; migrazione M1).
 *
 * Ogni scrittura su `alunni` che cambia una colonna copiata si riflette nella frequenza dell'anno ATTIVO della sede
 * (origine `recupero`). FAIL-OPEN: se la frequenza non si può scrivere, `alunni` si scrive lo stesso e c'è una riga in
 * `app_log`. La catena è applicata fino a V2 perché l'invariante `alunni (senza frequenza)` è di V2.
 * Date FISSE (2025/26-2027/28); solo uuid finti. `alunni.stato` non c'è nel banco di prova: lo stato viene da
 * `archiviato_il`, come nel riempimento (in produzione le due colonne si scrivono insieme).
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '33333333-3333-4333-8333-333333333333'
const al = (n: number) => `44444444-4444-4444-8444-44444444444${n}`

let db: PGlite
let SEZ_A: string      // S1, 2026/27
let SEZ_B: string      // S1, 2027/28
let AS1: string        // anni_sede 2026/27 di S1
let AS2: string        // anni_sede 2026/27 di S2

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
interface Freq {
  stato: string; origine: string; tipo: string | null; retta: string | null; pannolino: boolean
  ingresso: string; uscita: string | null; section_id: string | null; anno_sede_id: string; scuola_id: string
}
async function frequenze(alunno: string): Promise<Freq[]> {
  const r = await db.query<Freq>(
    `SELECT stato, origine, tipo, retta_mensile::text AS retta, usa_pannolino AS pannolino, data_ingresso::text AS ingresso,
            data_uscita::text AS uscita, section_id, anno_sede_id, scuola_id
       FROM public.frequenze WHERE alunno_id = $1 ORDER BY scuola_id`, [alunno])
  return r.rows
}
async function alunno(n: number, o: { sede?: string; sezione?: string | null; retta?: number; pannolino?: boolean } = {}) {
  await db.query(
    `INSERT INTO public.alunni (id, scuola_id, section_id, importo_retta_mensile, usa_pannolino) VALUES ($1, $2, $3, $4, $5)`,
    [al(n), o.sede ?? S1, o.sezione ?? null, o.retta ?? 0, o.pannolino ?? false])
}
async function invariante(nome: string, tabella: string): Promise<number> {
  return una<number>(`SELECT righe::int FROM public.anno_invarianti() WHERE invariante = $1 AND tabella = $2`, [nome, tabella])
}
async function scritture(): Promise<number> {
  return una<number>(`SELECT count(*)::int FROM public.prova_scritture_frequenze`)
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1, S2], fino: 'V2', completo: true,
    codaPrima: `
      ALTER TABLE public.alunni ENABLE ROW LEVEL SECURITY;
      CREATE POLICY alunni_aperta ON public.alunni FOR ALL TO authenticated USING (true) WITH CHECK (true);
    `,
  })
  const a2627 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2026`)
  const a2728 = await una<string>(`SELECT id FROM public.anni_scolastici WHERE anno_inizio = 2027`)
  AS1 = await una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND anno_id = $2`, [S1, a2627])
  AS2 = await una<string>(`SELECT id FROM public.anni_sede WHERE scuola_id = $1 AND anno_id = $2`, [S2, a2627])
  SEZ_A = await una<string>(`INSERT INTO public.sections (scuola_id, name) VALUES ($1, 'Girasoli') RETURNING id`, [S1])
  SEZ_B = await una<string>(`INSERT INTO public.sections (scuola_id, name, anno_id) VALUES ($1, 'Nuvole', $2) RETURNING id`, [S1, a2728])
  // un contatore delle scritture su `frequenze`: prova che un UPDATE inutile non le tocca
  await db.exec(`
    CREATE TABLE public.prova_scritture_frequenze (n bigserial PRIMARY KEY);
    CREATE FUNCTION public.prova_conta_frequenze() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN INSERT INTO public.prova_scritture_frequenze DEFAULT VALUES; RETURN NULL; END $f$;
    CREATE TRIGGER prova_conta AFTER INSERT OR UPDATE ON public.frequenze
      FOR EACH ROW EXECUTE FUNCTION public.prova_conta_frequenze();
  `)
}, 120_000)
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`
    UPDATE public.anno_regole SET specchio_alunni_attivo = true;
    DELETE FROM public.alunni;
    DELETE FROM public.app_log;
    DELETE FROM public.prova_scritture_frequenze;
  `)
})

describe('INSERT di un alunno', () => {
  it('crea UNA frequenza nell\'anno attivo: recupero, iscritto, retta NULL, pannolino, ingresso = oggi dentro il periodo', async () => {
    await alunno(1, { sezione: SEZ_A, retta: 0, pannolino: true })
    const f = await frequenze(al(1))
    expect(f).toHaveLength(1)
    const atteso = await una<string>(
      `SELECT least(greatest(public.giorno_roma(now()), inizio), fine)::text FROM public.anni_sede WHERE id = $1`, [AS1])
    expect(f[0]).toMatchObject({
      stato: 'iscritto', origine: 'recupero', tipo: null, retta: null, pannolino: true,
      ingresso: atteso, uscita: null, section_id: SEZ_A, anno_sede_id: AS1, scuola_id: S1,
    })
    expect(await invariante('11', 'alunni')).toBe(0)
  })

  it('un alunno senza sede non ha frequenza', async () => {
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, NULL)`, [al(1)])
    expect(await frequenze(al(1))).toEqual([])
  })

  it('interruttore specchio_alunni_attivo = false: nessuna frequenza nuova', async () => {
    await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
    await alunno(1, { sezione: SEZ_A })
    expect(await frequenze(al(1))).toEqual([])
    await db.query(`UPDATE public.alunni SET importo_retta_mensile = 99 WHERE id = $1`, [al(1)])
    expect(await frequenze(al(1))).toEqual([])
  })
})

describe('UPDATE di un alunno', () => {
  it('retta, sezione, archiviazione e ritorno si riflettono nella frequenza', async () => {
    await alunno(1, { sezione: SEZ_A })
    await db.query(`UPDATE public.alunni SET importo_retta_mensile = 135.50 WHERE id = $1`, [al(1)])
    expect((await frequenze(al(1)))[0].retta).toBe('135.50')
    await db.query(`UPDATE public.alunni SET importo_retta_mensile = 0 WHERE id = $1`, [al(1)])
    expect((await frequenze(al(1)))[0].retta).toBeNull()
    await db.query(`UPDATE public.alunni SET section_id = NULL WHERE id = $1`, [al(1)])
    expect((await frequenze(al(1)))[0].section_id).toBeNull()
    await db.query(`UPDATE public.alunni SET section_id = $2 WHERE id = $1`, [al(1), SEZ_A])
    expect((await frequenze(al(1)))[0].section_id).toBe(SEZ_A)

    // l'ingresso di «oggi» sta dopo l'archiviazione: lo si porta a inizio anno, come farebbe uno storico vero
    await db.query(`UPDATE public.frequenze SET data_ingresso = DATE '2026-09-01' WHERE alunno_id = $1`, [al(1)])
    await db.query(`UPDATE public.alunni SET archiviato_il = TIMESTAMPTZ '2026-10-12 22:30:00+00' WHERE id = $1`, [al(1)])
    expect((await frequenze(al(1)))[0]).toMatchObject({ stato: 'ritirato', uscita: '2026-10-13' })
    await db.query(`UPDATE public.alunni SET archiviato_il = NULL WHERE id = $1`, [al(1)])
    expect((await frequenze(al(1)))[0]).toMatchObject({ stato: 'iscritto', uscita: null })
  })

  it('non rallenta: un UPDATE che non cambia una colonna copiata non scrive frequenze (anche se PostgREST le rimanda tutte)', async () => {
    await alunno(1, { sezione: SEZ_A })
    const prima = await scritture()
    await db.query(`UPDATE public.alunni SET retta_split_config = retta_split_config WHERE id = $1`, [al(1)])
    await db.query(`UPDATE public.alunni SET classe_sezione = 'Girasoli' WHERE id = $1`, [al(1)])
    await db.query(`UPDATE public.alunni SET importo_retta_mensile = importo_retta_mensile, section_id = section_id WHERE id = $1`, [al(1)])
    expect(await scritture()).toBe(prima)
    // e una colonna copiata che CAMBIA scrive
    await db.query(`UPDATE public.alunni SET usa_pannolino = true WHERE id = $1`, [al(1)])
    expect(await scritture()).toBe(prima + 1)
  })

  it('trasferimento: la frequenza della sede vecchia diventa trasferito, ne nasce una iscritto nella nuova', async () => {
    await alunno(1)
    await db.query(`UPDATE public.alunni SET scuola_id = $2 WHERE id = $1`, [al(1), S2])
    const f = await frequenze(al(1))
    expect(f).toHaveLength(2)
    const vecchia = f.find((x) => x.scuola_id === S1)!
    const nuova = f.find((x) => x.scuola_id === S2)!
    expect(vecchia).toMatchObject({ stato: 'trasferito', anno_sede_id: AS1 })
    expect(vecchia.uscita).not.toBeNull()
    expect(nuova).toMatchObject({ stato: 'iscritto', origine: 'recupero', anno_sede_id: AS2 })
    // l'indice «una viva per anno» regge: una sola frequenza viva
    expect(await una<number>(`SELECT count(*)::int FROM public.frequenze WHERE alunno_id = $1 AND stato IN ('in_attesa', 'iscritto')`, [al(1)])).toBe(1)
    expect(await invariante('3', 'frequenze')).toBe(0)
  })
})

describe('fail-open', () => {
  it('una sezione del 2027/28: l\'UPDATE di alunni RIESCE, la frequenza non cambia, e c\'è una riga in app_log', async () => {
    await alunno(1, { sezione: SEZ_A })
    await db.query(`UPDATE public.alunni SET section_id = $2 WHERE id = $1`, [al(1), SEZ_B])
    expect(await una<string>(`SELECT section_id FROM public.alunni WHERE id = $1`, [al(1)])).toBe(SEZ_B)
    expect((await frequenze(al(1)))[0].section_id).toBe(SEZ_A)
    const log = await db.query<{ livello: string; contesto: Record<string, string> }>(
      `SELECT livello, contesto FROM public.app_log WHERE evento = 'anno-scolastico'`)
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0].livello).toBe('error')
    expect(log.rows[0].contesto.esito).toBe('specchio-fallito')
    // solo tabella e SQLSTATE (più l'operazione): nessun valore, nessun nome
    expect(Object.keys(log.rows[0].contesto).sort()).toEqual(['esito', 'operazione', 'sqlstate', 'tabella'])
    expect(log.rows[0].contesto.tabella).toBe('alunni')
  })
})

describe('ruoli e cancellazione', () => {
  it('il ruolo authenticated (RLS aperta di prova) scrive alunni e lo specchio funziona (SECURITY DEFINER)', async () => {
    await db.exec('SET ROLE authenticated')
    try { await alunno(1, { sezione: SEZ_A }) } finally { await db.exec('RESET ROLE') }
    expect(await frequenze(al(1))).toHaveLength(1)
  })

  it('DELETE dell\'alunno porta via la frequenza (ON DELETE CASCADE)', async () => {
    await alunno(1)
    await db.query(`DELETE FROM public.alunni WHERE id = $1`, [al(1)])
    expect(await una<number>(`SELECT count(*)::int FROM public.frequenze WHERE alunno_id = $1`, [al(1)])).toBe(0)
  })
})

describe('l\'invariante «alunni (senza frequenza)»', () => {
  it('1 se si cancella la frequenza di un alunno con sede, 0 dopo l\'UPDATE che la rigenera', async () => {
    await alunno(1, { sezione: SEZ_A })
    expect(await invariante('11', 'alunni (senza frequenza)')).toBe(0)
    await db.query(`DELETE FROM public.frequenze WHERE alunno_id = $1`, [al(1)])
    expect(await invariante('11', 'alunni (senza frequenza)')).toBe(1)
    await db.query(`UPDATE public.alunni SET importo_retta_mensile = 50 WHERE id = $1`, [al(1)])
    expect(await invariante('11', 'alunni (senza frequenza)')).toBe(0)
  })
})
