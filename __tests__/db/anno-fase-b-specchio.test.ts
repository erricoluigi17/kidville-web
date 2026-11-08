import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../helpers/schema-anno-pglite'

/**
 * COMPITO 4.3.4 · FASE B: LO SPECCHIO SI INVERTE (migrazione M43, in coda).
 *
 * Dal merge la frequenza dell'anno ATTIVO della sede attuale dell'alunno è la verità e `alunni` ne è la copia.
 * Calendario di prova fisso (`creaAnniFissi`): 2025/26 chiuso, 2026/27 corrente, 2027/28 in preparazione.
 * `alunni.stato` e `stato_cambiato_il` non stanno nel banco di base: li aggiunge `codaPrima`, col trigger vero
 * `alunni_traccia_cambio_stato`. Solo uuid finti.
 */

const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '33333333-3333-4333-8333-333333333333'
const SEZ_A = '55555555-5555-4555-8555-555555555552'
const SEZ_B = '55555555-5555-4555-8555-555555555553'
const AL = '11111111-1111-4111-8111-111111111111'
const AL2 = '11111111-1111-4111-8111-111111111112'
const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

let db: PGlite
const ANNO_SEDE: Record<string, string> = {} // `${sede}:${anno_inizio}`

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 30_000)
async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}
async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
async function alunno(id = AL): Promise<Record<string, unknown>> {
  return una<Record<string, unknown>>(`SELECT to_jsonb(a) FROM public.alunni a WHERE a.id = $1`, [id])
}
async function frequenza(id = AL, sede = S1, anno = 2026): Promise<Record<string, unknown>> {
  return una<Record<string, unknown>>(
    `SELECT to_jsonb(f) FROM public.frequenze f WHERE f.alunno_id = $1 AND f.anno_sede_id = $2`, [id, ANNO_SEDE[`${sede}:${anno}`]])
}
async function nuovoAlunno(id = AL, o: { sede?: string; sezione?: string | null; nome?: string | null; retta?: number } = {}) {
  await db.query(
    `INSERT INTO public.alunni (id, scuola_id, section_id, classe_sezione, importo_retta_mensile, stato)
     VALUES ($1, $2, $3, $4, $5, 'iscritto')`,
    [id, o.sede ?? S1, o.sezione === undefined ? SEZ_A : o.sezione, o.nome === undefined ? 'Girasoli' : o.nome, o.retta ?? 350])
}
async function aggiornamentiAlunni(): Promise<number> {
  return una<number>(`SELECT count(*)::int FROM public.prova_update_alunni`)
}
async function invariante11(): Promise<number> {
  return una<number>(`SELECT coalesce(sum(righe), 0)::int FROM public.anno_invarianti() WHERE invariante = '11'`)
}
function sezioneM43(): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith('_anno_sezioni_docenti_fase_b.sql'))!
  const sql = readFileSync(join(CARTELLA, f), 'utf8')
  const da = sql.indexOf('-- ── 4.3.4 ')
  const a = sql.indexOf('-- ── fine 4.3.4')
  expect(da, 'inizio della sezione 4.3.4 nella migrazione').toBeGreaterThan(-1)
  expect(a, 'fine della sezione 4.3.4 nella migrazione').toBeGreaterThan(da)
  return sql.slice(da, a)
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [S1, S2], fino: 'M43', completo: true,
    codaPrima: `
      ALTER TABLE public.alunni ADD COLUMN stato varchar(20), ADD COLUMN stato_cambiato_il timestamptz;
      CREATE FUNCTION public.alunni_traccia_cambio_stato() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.stato IS DISTINCT FROM OLD.stato THEN NEW.stato_cambiato_il := now(); END IF;
        RETURN NEW;
      END $f$;
      CREATE TRIGGER alunni_traccia_cambio_stato BEFORE INSERT OR UPDATE OF stato ON public.alunni
        FOR EACH ROW EXECUTE FUNCTION public.alunni_traccia_cambio_stato();
    `,
  })
  const r = await db.query<{ scuola_id: string; anno_inizio: number; id: string }>(
    `SELECT s.scuola_id, y.anno_inizio, s.id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
  for (const x of r.rows) ANNO_SEDE[`${x.scuola_id}:${x.anno_inizio}`] = x.id
  await db.query(`INSERT INTO public.sections (id, scuola_id, name) VALUES ($1, $2, 'Girasoli'), ($3, $2, 'Margherite')`,
    [SEZ_A, S1, SEZ_B])
  // un contatore degli UPDATE su `alunni`: prova che il giro si ferma e che il riallineamento è idempotente
  await db.exec(`
    CREATE TABLE public.prova_update_alunni (n bigserial PRIMARY KEY);
    CREATE FUNCTION public.prova_conta_update_alunni() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN INSERT INTO public.prova_update_alunni DEFAULT VALUES; RETURN NULL; END $f$;
    CREATE TRIGGER prova_conta_update_alunni AFTER UPDATE ON public.alunni
      FOR EACH ROW EXECUTE FUNCTION public.prova_conta_update_alunni();
  `)
}, 120_000)
afterAll(async () => { await db.close() })

describe('fase B · la frequenza dell’anno attivo si ricopia in alunni', () => {
  prova('andata e ritorno: alunni → frequenza → alunni lascia la riga identica', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      const prima = await alunno()
      expect((await frequenza()).section_id).toBe(SEZ_A)

      await db.query(`UPDATE public.frequenze SET section_id = $2 WHERE alunno_id = $1 AND anno_sede_id = $3`,
        [AL, SEZ_B, ANNO_SEDE[`${S1}:2026`]])
      const spostato = await alunno()
      expect(spostato.section_id).toBe(SEZ_B)
      expect(spostato.classe_sezione).toBe('Margherite')
      expect(spostato.importo_retta_mensile).toBe(350)

      await db.query(`UPDATE public.frequenze SET section_id = $2 WHERE alunno_id = $1 AND anno_sede_id = $3`,
        [AL, SEZ_A, ANNO_SEDE[`${S1}:2026`]])
      expect(await alunno()).toEqual(prima)
    })
  })

  prova('dopo lo spostamento section_id resta la sezione nuova anche con sync_alunno_section_id', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      await db.query(`UPDATE public.frequenze SET section_id = $2 WHERE alunno_id = $1`, [AL, SEZ_B])
      const t = await db.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.alunni'::regclass AND tgname = 'trg_alunni_sync_section'`)
      expect(t.rows).toHaveLength(1) // il trigger che riscrive section_id dal nome c'è, ed è scattato
      const a = await alunno()
      expect(a.section_id).toBe(SEZ_B)
      expect(a.classe_sezione).toBe('Margherite')
      // e la sezione svuotata svuota anche il nome
      await db.query(`UPDATE public.frequenze SET section_id = NULL WHERE alunno_id = $1`, [AL])
      const b = await alunno()
      expect(b.section_id).toBeNull()
      expect(b.classe_sezione).toBeNull()
    })
  })

  prova('una frequenza di un anno non attivo non tocca alunni', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      await db.query(
        `INSERT INTO public.frequenze (alunno_id, anno_sede_id, anno_id, scuola_id, origine, stato, data_ingresso, data_uscita)
         SELECT $1, s.id, s.anno_id, s.scuola_id, 'recupero', 'uscito', s.inizio, s.inizio FROM public.anni_sede s WHERE s.id = $2`,
        [AL, ANNO_SEDE[`${S1}:2025`]])
      const prima = await alunno()
      const n = await aggiornamentiAlunni()
      await db.query(
        `UPDATE public.frequenze SET stato = 'ritirato', retta_mensile = 999, sospeso = true
          WHERE alunno_id = $1 AND anno_sede_id = $2`, [AL, ANNO_SEDE[`${S1}:2025`]])
      expect(await alunno()).toEqual(prima)
      expect(await aggiornamentiAlunni()).toBe(n)
    })
  })

  prova('una frequenza ritirata archivia l’alunno (e riaprirla lo riporta iscritto)', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      expect((await alunno()).archiviato_il).toBeNull()
      await db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = data_ingresso WHERE alunno_id = $1 AND anno_sede_id = $2`,
        [AL, ANNO_SEDE[`${S1}:2026`]])
      const a = await alunno()
      expect(a.stato).toBe('ritirato')
      expect(a.archiviato_il).not.toBeNull()
      expect(a.stato_cambiato_il).not.toBeNull()

      await db.query(`UPDATE public.frequenze SET stato = 'iscritto', data_uscita = NULL WHERE alunno_id = $1 AND anno_sede_id = $2`,
        [AL, ANNO_SEDE[`${S1}:2026`]])
      const b = await alunno()
      expect(b.stato).toBe('iscritto')
      expect(b.archiviato_il).toBeNull()
    })
  })

  prova('sospeso resta sospeso finché la frequenza è viva', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      await db.query(`UPDATE public.alunni SET stato = 'sospeso' WHERE id = $1`, [AL])
      await db.query(`UPDATE public.frequenze SET retta_mensile = 400, sospeso = true, sospeso_causa = 'altro' WHERE alunno_id = $1`, [AL])
      const a = await alunno()
      expect(a.stato).toBe('sospeso')
      expect(a.importo_retta_mensile).toBe(400)
      expect(a.sospeso).toBe(true)
      expect(a.sospeso_causa).toBe('altro')
      // quando la frequenza si chiude, ritirato vince
      await db.query(`UPDATE public.frequenze SET stato = 'ritirato', data_uscita = data_ingresso WHERE alunno_id = $1`, [AL])
      expect((await alunno()).stato).toBe('ritirato')
    })
  })

  prova('retta NULL diventa 0, il resto non cambia', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      const prima = await alunno()
      await db.query(`UPDATE public.frequenze SET retta_mensile = NULL WHERE alunno_id = $1`, [AL])
      expect(await alunno()).toEqual({ ...prima, importo_retta_mensile: 0 })
    })
  })

  prova('con specchio_frequenze_attivo=false il trigger non scrive', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      await db.exec(`UPDATE public.anno_regole SET specchio_frequenze_attivo = false`)
      const prima = await alunno()
      await db.query(`UPDATE public.frequenze SET section_id = $2, retta_mensile = 500 WHERE alunno_id = $1`, [AL, SEZ_B])
      expect(await alunno()).toEqual(prima)
      await db.exec(`UPDATE public.anno_regole SET specchio_frequenze_attivo = true`)
      await db.query(`UPDATE public.frequenze SET retta_mensile = 501 WHERE alunno_id = $1`, [AL])
      expect((await alunno()).importo_retta_mensile).toBe(501)
      expect((await alunno()).section_id).toBe(SEZ_B)
    })
  })

  prova('il vecchio trigger alunni→frequenze (le 15 colonne) non esiste più; restano INSERT e sede', async () => {
    const t = await db.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.alunni'::regclass AND NOT tgisinternal AND tgname LIKE 'trg_alunni_specchio_frequenza%' ORDER BY tgname`)
    expect(t.rows.map((x) => x.tgname)).toEqual(['trg_alunni_specchio_frequenza_ins', 'trg_alunni_specchio_frequenza_sede'])
    // la funzione resta fino alla PR 5
    expect(await una<boolean>(`SELECT to_regprocedure('public.alunni_specchio_frequenza()') IS NOT NULL`)).toBe(true)
    await inRollback(async () => {
      await nuovoAlunno()
      await db.query(`UPDATE public.alunni SET importo_retta_mensile = 123 WHERE id = $1`, [AL])
      expect((await frequenza()).retta_mensile).toBe(350)
    })
  })

  prova('la migrazione fallisce se l’invariante 11 non è a zero', async () => {
    const sezione = sezioneM43()
    await inRollback(async () => {
      await nuovoAlunno()
      expect(await invariante11()).toBe(0)
      await db.exec(sezione) // a zero passa (e riapplicarla è innocuo)
    })
    await inRollback(async () => {
      await nuovoAlunno()
      await db.query(`UPDATE public.alunni SET usa_pannolino = true WHERE id = $1`, [AL]) // niente specchio che la ricopi
      expect(await invariante11()).toBeGreaterThan(0)
      await expect(db.exec(sezione)).rejects.toThrow(/FASE_B_INVARIANTE_11_ROSSA/)
    })
  })

  prova('un guasto nel trigger non blocca la scrittura della frequenza e lo registra', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      await db.exec(`
        CREATE FUNCTION public.prova_rompi_alunni() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN RAISE EXCEPTION 'guasto di prova'; END $f$;
        CREATE TRIGGER prova_rompi_alunni BEFORE UPDATE ON public.alunni
          FOR EACH ROW EXECUTE FUNCTION public.prova_rompi_alunni();`)
      await db.query(`UPDATE public.frequenze SET retta_mensile = 777 WHERE alunno_id = $1`, [AL])
      expect((await frequenza()).retta_mensile).toBe(777) // la frequenza è scritta
      expect((await alunno()).importo_retta_mensile).toBe(350) // la copia no
      const log = await db.query<{ contesto: Record<string, unknown>; messaggio: string }>(
        `SELECT contesto, messaggio FROM public.app_log WHERE fingerprint = 'db:anno-specchio:frequenze'`)
      expect(log.rows).toHaveLength(1)
      expect(log.rows[0].contesto).toMatchObject({ esito: 'specchio-fallito' })
      expect(JSON.stringify(log.rows[0])).not.toContain('777')
    })
  })

  prova('il riallineamento è idempotente: la seconda chiamata non fa nessun UPDATE', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      await db.exec(`UPDATE public.anno_regole SET specchio_frequenze_attivo = false`) // la frequenza cambia, alunni no
      await db.query(`UPDATE public.frequenze SET section_id = $2, retta_mensile = 480 WHERE alunno_id = $1`, [AL, SEZ_B])
      const n0 = await aggiornamentiAlunni()
      await db.query(`SELECT public.alunni_riallinea_da_frequenze($1)`, [AL])
      const n1 = await aggiornamentiAlunni()
      expect(n1).toBe(n0 + 1)
      await db.query(`SELECT public.alunni_riallinea_da_frequenze($1)`, [AL])
      expect(await aggiornamentiAlunni()).toBe(n1)
      expect(await invariante11()).toBe(0)
    })
  })

  prova('il giro è chiuso: un INSERT in alunni crea la frequenza e nessun UPDATE di alunni segue', async () => {
    await inRollback(async () => {
      const n0 = await aggiornamentiAlunni()
      await nuovoAlunno()
      expect(await frequenza()).toMatchObject({ stato: 'iscritto', origine: 'recupero', retta_mensile: 350, section_id: SEZ_A })
      expect(await aggiornamentiAlunni()).toBe(n0)
      // nemmeno un secondo giro dello stesso alunno
      await db.query(`SELECT public.alunni_riallinea_da_frequenze($1)`, [AL])
      expect(await aggiornamentiAlunni()).toBe(n0)
    })
  })

  prova('il trasferimento: la frequenza vecchia diventa trasferito, ne nasce una nuova e l’alunno non si archivia', async () => {
    await inRollback(async () => {
      await nuovoAlunno(AL2, { sezione: null, nome: null })
      const prima = await alunno(AL2)
      await db.query(`UPDATE public.alunni SET scuola_id = $2 WHERE id = $1`, [AL2, S2])
      expect((await frequenza(AL2, S1)).stato).toBe('trasferito')
      expect((await frequenza(AL2, S2)).stato).toBe('iscritto')
      const dopo = await alunno(AL2)
      expect(dopo.stato).toBe('iscritto')
      expect(dopo.archiviato_il).toBeNull()
      expect(dopo.stato_cambiato_il).toEqual(prima.stato_cambiato_il)
      expect(dopo.scuola_id).toBe(S2)
      expect(await invariante11()).toBe(0)
    })
  })

  prova('un DELETE della frequenza attiva non tocca alunni', async () => {
    await inRollback(async () => {
      await nuovoAlunno()
      const prima = await alunno()
      await db.query(`DELETE FROM public.frequenze WHERE alunno_id = $1`, [AL])
      expect(await alunno()).toEqual(prima)
    })
  })
})
