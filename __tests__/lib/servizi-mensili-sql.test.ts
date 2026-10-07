// @vitest-environment node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

/**
 * SERVIZI MENSILI · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO (PGlite, in memoria).
 *
 * Perché non un mock: ciò che la migrazione consegna sono VINCOLI e REGOLE DI SQL —
 * l'EXCLUDE contro le iscrizioni sovrapposte, i CHECK sul primo del mese, la
 * deduplica contro le voci storiche senza `periodo_competenza`, l'`ON CONFLICT`
 * che deve ripetere il predicato IDENTICO dell'indice parziale (altrimenti 42P10).
 * Un finto client direbbe «sì» a tutto, ed è così che una migrazione passa i test e
 * fallisce al primo INSERT in produzione.
 *
 * Lo schema qui sotto è il MINIMO di produzione prima della migrazione (colonne
 * verificate in sola lettura il 2026-10-07), e l'indice `uq_pagamenti_categoria_mese`
 * ha il predicato esatto di `pg_indexes`. Il file della migrazione è LETTO DAL DISCO e
 * applicato DUE volte: la seconda è la prova dell'idempotenza.
 *
 * Solo dati finti: uuid inventati, nessuna anagrafica.
 */

const FILE = '20261007170813_servizi_mensili.sql'
const MIGRAZIONE = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')

const SEDE_A = 'a0000000-0000-4000-8000-000000000001'
const SEDE_B = 'b0000000-0000-4000-8000-000000000002'
const SEDE_FERMA = 'f0000000-0000-4000-8000-000000000003'
const CAT = 'c0000000-0000-4000-8000-000000000001' // globale, mensile, attiva
const CAT_RETTA = 'c0000000-0000-4000-8000-000000000002'
const CAT_DI_B = 'c0000000-0000-4000-8000-000000000003' // appartiene alla sede B
const A1 = '10000000-0000-4000-8000-000000000001' // sede A, iscritto, classe, scadenza di sede
const A2 = '10000000-0000-4000-8000-000000000002' // sede A, iscritto, giorno proprio = 10
const A3 = '10000000-0000-4000-8000-000000000003' // sede B
const A4 = '10000000-0000-4000-8000-000000000004' // sede A, ritirato
const A5 = '10000000-0000-4000-8000-000000000005' // sede A, iscritto ma senza classe
const A6 = '10000000-0000-4000-8000-000000000006' // sede A, sospeso (come la retta: NON escluso)
const UTENTE = '99999999-0000-4000-8000-000000000009'
const FANTASMA = '00000000-0000-4000-8000-0000000000ee'

let db: PGlite

type PgErr = { code?: string; message: string }

async function errore(sql: string): Promise<PgErr | null> {
    try {
        await db.query(sql)
        return null
    } catch (e) {
        return e as PgErr
    }
}

async function numero(sql: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
    return rows[0].n
}

async function isc(
    alunno: string,
    dal: string,
    al: string | null = null,
    opzioni: { importo?: number; sede?: string; categoria?: string } = {},
): Promise<void> {
    const { importo = 80, sede = SEDE_A, categoria = CAT } = opzioni
    await db.exec(`
    INSERT INTO public.iscrizioni_servizi (alunno_id, categoria_id, scuola_id, importo_mensile, dal, al, creato_da)
    VALUES ('${alunno}', '${categoria}', '${sede}', ${importo}, '${dal}', ${al ? `'${al}'` : 'NULL'}, '${UTENTE}');
  `)
}

type Riga = {
    alunno_id: string
    importo: string
    scadenza: string
    visibile_dal: string
    descrizione: string
    gruppo: string
}

async function anteprima(periodo: string, sede = SEDE_A, alunni: string | null = null): Promise<Riga[]> {
    const { rows } = await db.query<Riga>(`
    SELECT alunno_id, importo::text, scadenza::text, visibile_dal::text, descrizione, gruppo
      FROM public.servizi_da_generare('${periodo}', '${sede}', ${alunni ? `ARRAY[${alunni}]::uuid[]` : 'NULL'})
     ORDER BY alunno_id`)
    return rows
}

const genera = (periodo: string, sede = SEDE_A, alunni: string | null = null) =>
    numero(`public.genera_servizi_mensili('${periodo}', '${sede}', ${alunni ? `ARRAY[${alunni}]::uuid[]` : 'NULL'})`)

async function schemaMinimo(conn: PGlite) {
    await conn.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE SCHEMA extensions;
    -- come Supabase: ciò che nasce in public è subito di anon/authenticated, quindi i REVOKE
    -- della migrazione hanno qualcosa da togliere davvero
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

    CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

    CREATE TYPE public.pagamento_tipo AS ENUM ('singolo', 'padre', 'rata', 'split');

    CREATE TABLE public.schools (id uuid PRIMARY KEY, operativa boolean);
    CREATE TABLE public.alunni (
      id uuid PRIMARY KEY,
      scuola_id uuid,
      stato varchar,
      classe_sezione varchar,
      section_id uuid,
      data_iscrizione date,
      giorno_scadenza_pagamenti int,
      sospeso boolean DEFAULT false
    );
    CREATE TABLE public.admin_settings (
      scuola_id uuid,
      retta_giorno_scadenza int,
      retta_giorno_visibilita int,
      retta_default_importo numeric
    );
    CREATE TABLE public.payment_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id uuid,
      nome varchar NOT NULL,
      slug varchar NOT NULL,
      colore varchar,
      icona varchar,
      is_sistema boolean DEFAULT false,
      attivo boolean DEFAULT true,
      ordine int DEFAULT 0,
      creato_il timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.pagamenti (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid,
      scuola_id uuid,
      descrizione text NOT NULL,
      importo numeric(10,2) NOT NULL,
      scadenza date NOT NULL,
      stato varchar(20) DEFAULT 'da_pagare',
      categoria_id uuid,
      tipo public.pagamento_tipo NOT NULL DEFAULT 'singolo',
      obbligatorio boolean NOT NULL DEFAULT true,
      gruppo text,
      importo_pagato numeric(10,2) NOT NULL DEFAULT 0,
      periodo_competenza date,
      visibile_dal date
    );
    -- predicato ESATTO letto da pg_indexes in produzione
    CREATE UNIQUE INDEX uq_pagamenti_categoria_mese ON public.pagamenti
      USING btree (alunno_id, categoria_id, periodo_competenza)
      WHERE ((categoria_id IS NOT NULL)
         AND (tipo = ANY (ARRAY['singolo'::public.pagamento_tipo, 'padre'::public.pagamento_tipo, 'split'::public.pagamento_tipo]))
         AND (periodo_competenza IS NOT NULL));
  `)
}

beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } })
    await schemaMinimo(db)
    // DUE volte: la seconda è la prova dell'idempotenza (nessun errore, nessun doppione)
    await db.exec(MIGRAZIONE)
    await db.exec(MIGRAZIONE)
})

afterAll(async () => {
    await db.close()
})

beforeEach(async () => {
    await db.exec(`
    TRUNCATE public.iscrizioni_servizi, public.pagamenti, public.admin_settings,
             public.alunni, public.payment_categories, public.schools CASCADE;

    INSERT INTO public.schools(id, operativa) VALUES
      ('${SEDE_A}', true), ('${SEDE_B}', true), ('${SEDE_FERMA}', false);

    INSERT INTO public.payment_categories(id, scuola_id, nome, slug, mensile, attivo) VALUES
      ('${CAT}', NULL, 'Pomeridiano', 'pomeridiano', true, true),
      ('${CAT_RETTA}', NULL, 'Retta', 'retta', false, true),
      ('${CAT_DI_B}', '${SEDE_B}', 'Doposcuola B', 'doposcuola-b', true, true);

    -- la sede A ha le sue impostazioni (scadenza il 7, visibile dal 20 del mese prima);
    -- la sede B no: valgono i default 5 e 25
    INSERT INTO public.admin_settings(scuola_id, retta_giorno_scadenza, retta_giorno_visibilita)
    VALUES ('${SEDE_A}', 7, 20);

    INSERT INTO public.alunni(id, scuola_id, stato, classe_sezione, giorno_scadenza_pagamenti, sospeso) VALUES
      ('${A1}', '${SEDE_A}', 'iscritto', 'Sez A', NULL, false),
      ('${A2}', '${SEDE_A}', 'iscritto', 'Sez A', 10, false),
      ('${A3}', '${SEDE_B}', 'iscritto', 'Sez B', NULL, false),
      ('${A4}', '${SEDE_A}', 'ritirato', 'Sez A', NULL, false),
      ('${A5}', '${SEDE_A}', 'iscritto', NULL, NULL, false),
      ('${A6}', '${SEDE_A}', 'iscritto', 'Sez A', NULL, true);
  `)
})

describe('struttura: colonne, tabella, privilegi', () => {
    it('payment_categories ha le colonne nuove e i default giusti', async () => {
        const { rows } = await db.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
            `SELECT column_name, is_nullable, column_default FROM information_schema.columns
              WHERE table_name = 'payment_categories' AND column_name IN ('mensile','importo_mensile_default')
              ORDER BY column_name`,
        )
        expect(rows.map((r) => r.column_name)).toEqual(['importo_mensile_default', 'mensile'])
        const mensile = rows.find((r) => r.column_name === 'mensile')!
        expect(mensile.is_nullable).toBe('NO')
        expect(mensile.column_default).toMatch(/false/)
        // le categorie esistenti (la retta) restano NON mensili
        expect(await numero(`(SELECT count(*) FROM public.payment_categories WHERE slug = 'retta' AND mensile)`)).toBe(0)
    })

    it('niente accesso per anon/authenticated, sì per service_role', async () => {
        expect(await numero(`has_table_privilege('authenticated','public.iscrizioni_servizi','SELECT')::int`)).toBe(0)
        expect(await numero(`has_table_privilege('anon','public.iscrizioni_servizi','SELECT')::int`)).toBe(0)
        expect(await numero(`has_table_privilege('service_role','public.iscrizioni_servizi','INSERT')::int`)).toBe(1)
        for (const f of [
            'public.servizi_da_generare(date,uuid,uuid[])',
            'public.genera_servizi_mensili(date,uuid,uuid[])',
            'public.genera_servizi_anno(integer,uuid,uuid[])',
        ]) {
            expect(await numero(`has_function_privilege('authenticated','${f}','EXECUTE')::int`), f).toBe(0)
            expect(await numero(`has_function_privilege('anon','${f}','EXECUTE')::int`), f).toBe(0)
            expect(await numero(`has_function_privilege('service_role','${f}','EXECUTE')::int`), f).toBe(1)
        }
    })

    it('RLS attiva e nessuna policy (solo service-role)', async () => {
        expect(
            await numero(`(SELECT relrowsecurity::int FROM pg_class WHERE oid = 'public.iscrizioni_servizi'::regclass)`),
        ).toBe(1)
        expect(await numero(`(SELECT count(*) FROM pg_policies WHERE tablename = 'iscrizioni_servizi')`)).toBe(0)
    })

    it('la sonda finale non fa fallire la migrazione con una sede ferma presente', async () => {
        // un database fresco in cui la sede ferma esiste GIÀ quando la migrazione parte
        const conn = new PGlite({ extensions: { btree_gist } })
        try {
            await schemaMinimo(conn)
            await conn.exec(`INSERT INTO public.schools(id, operativa) VALUES ('${SEDE_FERMA}', false);`)
            await expect(conn.exec(MIGRAZIONE)).resolves.toBeDefined()
        } finally {
            await conn.close()
        }
    })
})

describe('servizi_da_generare / genera_servizi_mensili', () => {
    it('fuori da dal/al non si genera niente; dentro sì (estremi inclusi)', async () => {
        await isc(A1, '2026-10-01', '2026-12-01')
        expect(await anteprima('2026-09-01')).toHaveLength(0)
        expect(await anteprima('2027-01-01')).toHaveLength(0)
        expect(await anteprima('2026-10-01')).toHaveLength(1)
        expect(await anteprima('2026-12-01')).toHaveLength(1)
        expect(await genera('2026-09-01')).toBe(0)
        expect(await genera('2027-01-01')).toBe(0)
    })

    it('formula di scadenza, visibile_dal, descrizione, gruppo, importo (con impostazioni di sede)', async () => {
        await isc(A1, '2026-09-01', null, { importo: 80 })
        await isc(A2, '2026-09-01', null, { importo: 55.5 })
        const [r1, r2] = await anteprima('2026-10-01')
        expect(r1.alunno_id).toBe(A1)
        // sede A: scadenza il 7 -> 2026-10-07; visibile dal 20 del mese prima -> 2026-09-20
        expect(r1.scadenza).toBe('2026-10-07')
        expect(r1.visibile_dal).toBe('2026-09-20')
        expect(r1.descrizione).toBe('Pomeridiano 10/2026')
        expect(r1.gruppo).toBe('pomeridiano-2026-10')
        expect(Number(r1.importo)).toBe(80)
        // il giorno proprio dell'alunno (10) batte quello di sede
        expect(r2.alunno_id).toBe(A2)
        expect(r2.scadenza).toBe('2026-10-10')
        expect(Number(r2.importo)).toBe(55.5)
    })

    it('senza admin_settings valgono i default 5 e 25; il gennaio prende il dicembre prima', async () => {
        await isc(A3, '2026-09-01', null, { sede: SEDE_B })
        const r = await anteprima('2027-01-01', SEDE_B)
        expect(r).toHaveLength(1)
        expect(r[0].scadenza).toBe('2027-01-05')
        expect(r[0].visibile_dal).toBe('2026-12-25')
    })

    it('la generazione scrive la voce come la retta, e la seconda chiamata è a zero (idempotenza)', async () => {
        await isc(A1, '2026-09-01')
        await isc(A2, '2026-09-01')
        expect(await genera('2026-10-01')).toBe(2)
        expect(await genera('2026-10-01')).toBe(0)
        const { rows } = await db.query<Record<string, string | boolean>>(
            `SELECT tipo::text, obbligatorio, stato, periodo_competenza::text AS p, scadenza::text AS s,
                    visibile_dal::text AS v, gruppo, scuola_id::text AS sede
               FROM public.pagamenti WHERE alunno_id = '${A1}'`,
        )
        expect(rows).toEqual([
            {
                tipo: 'singolo',
                obbligatorio: true,
                stato: 'da_pagare',
                p: '2026-10-01',
                s: '2026-10-07',
                v: '2026-09-20',
                gruppo: 'pomeridiano-2026-10',
                sede: SEDE_A,
            },
        ])
        expect(await numero(`(SELECT count(*) FROM public.pagamenti)`)).toBe(2)
    })

    it('categoria non mensile o non attiva: saltata', async () => {
        await isc(A1, '2026-09-01')
        await db.exec(`UPDATE public.payment_categories SET mensile = false WHERE id = '${CAT}'`)
        expect(await anteprima('2026-10-01')).toHaveLength(0)
        await db.exec(`UPDATE public.payment_categories SET mensile = true, attivo = false WHERE id = '${CAT}'`)
        expect(await anteprima('2026-10-01')).toHaveLength(0)
        expect(await genera('2026-10-01')).toBe(0)
        await db.exec(`UPDATE public.payment_categories SET attivo = true WHERE id = '${CAT}'`)
        expect(await anteprima('2026-10-01')).toHaveLength(1)
    })

    it('categoria di un\'altra sede: saltata', async () => {
        await isc(A1, '2026-09-01', null, { categoria: CAT_DI_B })
        expect(await anteprima('2026-10-01')).toHaveLength(0)
    })

    it('alunno di altra sede, non iscritto, senza classe: saltati; il sospeso NO (come la retta)', async () => {
        await isc(A3, '2026-09-01', null) // iscrizione dichiarata sede A ma alunno di sede B
        await isc(A4, '2026-09-01')
        await isc(A5, '2026-09-01')
        await isc(A6, '2026-09-01')
        const r = await anteprima('2026-10-01')
        expect(r.map((x) => x.alunno_id)).toEqual([A6])
    })

    it('importo a zero: niente voce da zero euro', async () => {
        await isc(A1, '2026-09-01', null, { importo: 0 })
        expect(await anteprima('2026-10-01')).toHaveLength(0)
    })

    it('deduplica storica: una voce della stessa categoria SENZA periodo, con scadenza nel mese, blocca', async () => {
        await isc(A1, '2026-09-01')
        await isc(A2, '2026-09-01')
        // voce vecchia di A1: nessun periodo_competenza, scadenza a metà ottobre
        await db.exec(`
      INSERT INTO public.pagamenti(alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, tipo)
      VALUES ('${A1}', '${SEDE_A}', 'Pomeridiano ottobre (storico)', 80, '2026-10-15', '${CAT}', 'singolo');
    `)
        const r = await anteprima('2026-10-01')
        expect(r.map((x) => x.alunno_id)).toEqual([A2])
        expect(await genera('2026-10-01')).toBe(1)
        // il mese dopo la voce storica non c'entra
        expect((await anteprima('2026-11-01')).map((x) => x.alunno_id).sort()).toEqual([A1, A2])
    })

    it('deduplica: una voce della stessa categoria CON periodo blocca; una di altra categoria no', async () => {
        await isc(A1, '2026-09-01')
        await isc(A2, '2026-09-01')
        await db.exec(`
      INSERT INTO public.pagamenti(alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, tipo, periodo_competenza)
      VALUES ('${A1}', '${SEDE_A}', 'già generata', 80, '2026-10-07', '${CAT}', 'singolo', '2026-10-01'),
             ('${A2}', '${SEDE_A}', 'Retta 10/2026', 300, '2026-10-05', '${CAT_RETTA}', 'singolo', '2026-10-01');
    `)
        expect((await anteprima('2026-10-01')).map((x) => x.alunno_id)).toEqual([A2])
    })

    it('p_alunno_ids filtra; un array vuoto è un errore, non «zero generate»', async () => {
        await isc(A1, '2026-09-01')
        await isc(A2, '2026-09-01')
        expect((await anteprima('2026-10-01', SEDE_A, `'${A2}'`)).map((x) => x.alunno_id)).toEqual([A2])
        expect(await genera('2026-10-01', SEDE_A, `'${A2}'`)).toBe(1)
        const e = await errore(`SELECT public.genera_servizi_mensili('2026-10-01','${SEDE_A}', ARRAY[]::uuid[])`)
        expect(e?.message).toMatch(/elenco alunni vuoto/)
        expect(await numero(`(SELECT count(*) FROM public.pagamenti)`)).toBe(1)
    })

    it('sede nulla, inesistente o ferma: errore con messaggio distinto', async () => {
        await isc(A1, '2026-09-01')
        expect((await errore(`SELECT public.genera_servizi_mensili('2026-10-01', NULL)`))?.message).toMatch(
            /sede \(p_scuola_id\) è obbligatoria/,
        )
        expect((await errore(`SELECT public.genera_servizi_mensili('2026-10-01', '${FANTASMA}')`))?.message).toMatch(
            /inesistente/,
        )
        expect((await errore(`SELECT public.genera_servizi_mensili('2026-10-01', '${SEDE_FERMA}')`))?.message).toMatch(
            /ferma, nessun servizio/,
        )
        expect((await errore(`SELECT public.genera_servizi_mensili('2026-10-15', '${SEDE_A}')`))?.message).toMatch(
            /primo del mese/,
        )
        expect(await numero(`(SELECT count(*) FROM public.pagamenti)`)).toBe(0)
    })

    it('l\'anteprima restituisce ESATTAMENTE le righe che la generazione inserisce', async () => {
        await isc(A1, '2026-09-01', null, { importo: 80 })
        await isc(A2, '2026-10-01', '2026-10-01', { importo: 42.5 })
        await isc(A6, '2026-09-01', null, { importo: 30 })
        const prima = await anteprima('2026-10-01')
        expect(await genera('2026-10-01')).toBe(prima.length)
        const { rows } = await db.query<Riga>(
            `SELECT alunno_id, importo::text, scadenza::text, visibile_dal::text, descrizione, gruppo
               FROM public.pagamenti ORDER BY alunno_id`,
        )
        expect(rows).toEqual(prima)
        // e dopo, l'anteprima è vuota: stessa regola di dedupe
        expect(await anteprima('2026-10-01')).toHaveLength(0)
    })
})

describe('genera_servizi_anno', () => {
    it('somma solo i mesi settembre-giugno coperti dall\'iscrizione', async () => {
        await isc(A1, '2026-11-01', '2027-02-01') // nov, dic, gen, feb = 4
        expect(await numero(`public.genera_servizi_anno(2026, '${SEDE_A}', NULL)`)).toBe(4)
        expect(await numero(`public.genera_servizi_anno(2026, '${SEDE_A}', NULL)`)).toBe(0)
    })

    it('un\'iscrizione aperta copre i dieci mesi, mai luglio e agosto', async () => {
        await isc(A1, '2026-01-01', null)
        expect(await numero(`public.genera_servizi_anno(2026, '${SEDE_A}', NULL)`)).toBe(10)
        expect(
            await numero(`(SELECT count(*) FROM public.pagamenti WHERE EXTRACT(MONTH FROM periodo_competenza) IN (7, 8))`),
        ).toBe(0)
    })

    it('la sede è obbligatoria', async () => {
        expect((await errore(`SELECT public.genera_servizi_anno(2026, NULL)`))?.message).toMatch(/obbligatoria/)
    })
})

describe('iscrizioni_servizi: vincoli', () => {
    it('due iscrizioni sovrapposte (stesso alunno e categoria): 23P01; adiacenti: ok', async () => {
        await isc(A1, '2026-09-01', '2026-10-01')
        const e = await errore(`
      INSERT INTO public.iscrizioni_servizi(alunno_id, categoria_id, scuola_id, importo_mensile, dal, al, creato_da)
      VALUES ('${A1}', '${CAT}', '${SEDE_A}', 80, '2026-10-01', '2026-12-01', '${UTENTE}')`)
        expect(e?.code).toBe('23P01')
        // adiacente: la prima finisce con ottobre incluso, la seconda parte da novembre
        await expect(isc(A1, '2026-11-01', '2026-12-01')).resolves.toBeUndefined()
        // un'iscrizione aperta dopo quelle chiuse ma sovrapposta all'ultima: 23P01
        const aperta = await errore(`
      INSERT INTO public.iscrizioni_servizi(alunno_id, categoria_id, scuola_id, importo_mensile, dal, creato_da)
      VALUES ('${A1}', '${CAT}', '${SEDE_A}', 80, '2026-12-01', '${UTENTE}')`)
        expect(aperta?.code).toBe('23P01')
        // stesso alunno ma altra categoria, e altro alunno stessa categoria: niente conflitto
        await expect(isc(A1, '2026-09-01', null, { categoria: CAT_DI_B, sede: SEDE_B })).resolves.toBeUndefined()
        await expect(isc(A2, '2026-09-01', '2026-10-01')).resolves.toBeUndefined()
    })

    it('CHECK: dal e al sono il primo del mese, al >= dal, importo >= 0', async () => {
        const ins = (dal: string, al: string | null, importo: number) =>
            errore(`
        INSERT INTO public.iscrizioni_servizi(alunno_id, categoria_id, scuola_id, importo_mensile, dal, al, creato_da)
        VALUES ('${A1}', '${CAT}', '${SEDE_A}', ${importo}, '${dal}', ${al ? `'${al}'` : 'NULL'}, '${UTENTE}')`)
        expect((await ins('2026-09-02', null, 80))?.code).toBe('23514')
        expect((await ins('2026-09-01', '2026-10-15', 80))?.code).toBe('23514')
        expect((await ins('2026-10-01', '2026-09-01', 80))?.code).toBe('23514')
        expect((await ins('2026-09-01', null, -1))?.code).toBe('23514')
        expect(await ins('2026-09-01', '2026-09-01', 0)).toBeNull()
    })

    it('la categoria «retta» non può diventare mensile (23514); gli importi predefiniti non sono negativi', async () => {
        expect((await errore(`UPDATE public.payment_categories SET mensile = true WHERE id = '${CAT_RETTA}'`))?.code).toBe(
            '23514',
        )
        expect(
            (await errore(`UPDATE public.payment_categories SET importo_mensile_default = -5 WHERE id = '${CAT}'`))?.code,
        ).toBe('23514')
        expect(await errore(`UPDATE public.payment_categories SET importo_mensile_default = 45 WHERE id = '${CAT}'`)).toBeNull()
    })

    it('l\'alunno cancellato porta via le sue iscrizioni; la categoria con iscrizioni non si cancella', async () => {
        await isc(A1, '2026-09-01')
        const e = await errore(`DELETE FROM public.payment_categories WHERE id = '${CAT}'`)
        expect(e?.code).toBe('23503')
        await db.exec(`DELETE FROM public.alunni WHERE id = '${A1}'`)
        expect(await numero(`(SELECT count(*) FROM public.iscrizioni_servizi)`)).toBe(0)
    })

    it('updated_at si aggiorna da solo (trigger)', async () => {
        await isc(A1, '2026-09-01')
        await db.exec(`UPDATE public.iscrizioni_servizi SET updated_at = '2000-01-01'`)
        await db.exec(`UPDATE public.iscrizioni_servizi SET importo_mensile = 90`)
        expect(await numero(`(SELECT (updated_at > '2020-01-01')::int FROM public.iscrizioni_servizi)`)).toBe(1)
    })
})
