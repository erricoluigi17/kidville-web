// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * SCRUTINIO · CONTROLLO DI VERSIONE, PROVATO SU UN POSTGRES VERO.
 *
 * Fino al 2026-10-10 `POST`/`PATCH /api/primaria/scrutinio` facevano un upsert
 * cieco: il secondo che salvava riscriveva con i valori vecchi della sua schermata
 * il giudizio che l'altro aveva appena cambiato. Le funzioni
 * `salva_giudizi_scrutinio` e `salva_comportamento_scrutinio` confrontano la
 * versione letta dal client (`updated_at`) con quella attuale: riga cambiata nel
 * frattempo + valore diverso = conflitto, e NIENTE si scrive.
 *
 * Ogni `db.query` di PGlite è una transazione sua: `now()` cambia fra una
 * chiamata e l'altra, come fra due salvataggi veri. La serializzazione di due
 * salvataggi SIMULTANEI (FOR UPDATE su `scrutini`) la sorveglia il lock
 * `scrutinio-controllo-versione`; la prova con due sessioni vere sta nel PR.
 * Lo schema qui sotto ricopia le tre tabelle del baseline e `set_updated_at`
 * (identica in produzione, letta il 2026-10-10). Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
const NUOVA = migrazione('_scrutinio_controllo_versione.sql')

const SCRUTINIO = 'c0000000-0000-4000-8000-000000000001'
const ALUNNO = 'e0000000-0000-4000-8000-000000000001'
const ALUNNO_2 = 'e0000000-0000-4000-8000-000000000002'
const MATERIA = 'd0000000-0000-4000-8000-000000000001'
const DOCENTE_A = 'b0000000-0000-4000-8000-00000000000a'
const DOCENTE_B = 'b0000000-0000-4000-8000-00000000000b'

let db: PGlite

type Riga = Record<string, unknown>
type Esito = { esito: string; righe?: Riga[]; conflitti?: Riga[] }

async function giudizi(righe: Riga[], scrutinio = SCRUTINIO): Promise<Esito> {
  const r = await db.query<{ r: Esito }>('SELECT public.salva_giudizi_scrutinio($1, $2::jsonb) AS r', [scrutinio, JSON.stringify(righe)])
  return r.rows[0].r
}
async function comportamento(righe: Riga[]): Promise<Esito> {
  const r = await db.query<{ r: Esito }>('SELECT public.salva_comportamento_scrutinio($1, $2::jsonb) AS r', [SCRUTINIO, JSON.stringify(righe)])
  return r.rows[0].r
}
async function giudizioAttuale(alunno = ALUNNO) {
  const r = await db.query<{ giudizio_sintetico: string | null; proposto_da: string | null; updated_at: string }>(
    `SELECT giudizio_sintetico, proposto_da, updated_at::text FROM public.scrutinio_giudizi WHERE alunno_id = $1`, [alunno])
  return r.rows[0]
}
const g = (valore: string, extra: Riga = {}): Riga => ({
  alunno_id: ALUNNO, materia_id: MATERIA, giudizio_sintetico: valore, proposto_da: DOCENTE_A, ...extra,
})

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql
      SET search_path TO 'public', 'pg_temp' AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$;

    CREATE TABLE public.scrutini (
      id uuid PRIMARY KEY,
      section_id uuid,
      periodo_id uuid,
      stato text DEFAULT 'aperto' NOT NULL CHECK (stato IN ('aperto', 'chiuso'))
    );
    CREATE TABLE public.scrutinio_giudizi (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      scrutinio_id uuid NOT NULL REFERENCES public.scrutini(id),
      alunno_id uuid NOT NULL,
      materia_id uuid NOT NULL,
      giudizio_sintetico text,
      proposto_da uuid,
      proposto_il timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (scrutinio_id, alunno_id, materia_id)
    );
    CREATE TABLE public.scrutinio_comportamento (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      scrutinio_id uuid NOT NULL REFERENCES public.scrutini(id),
      alunno_id uuid NOT NULL,
      giudizio_testo text,
      scala_valore text,
      giudizio_globale text,
      updated_at timestamptz DEFAULT now(),
      UNIQUE (scrutinio_id, alunno_id)
    );
    CREATE TRIGGER trg_scrut_giudizi_updated_at BEFORE UPDATE ON public.scrutinio_giudizi
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    CREATE TRIGGER trg_scrut_comp_updated_at BEFORE UPDATE ON public.scrutinio_comportamento
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  `)
  await db.exec(NUOVA)
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await db.exec('TRUNCATE public.scrutinio_giudizi, public.scrutinio_comportamento, public.scrutini CASCADE;')
  await db.query(`INSERT INTO public.scrutini (id, stato) VALUES ($1, 'aperto')`, [SCRUTINIO])
})

describe('salva_giudizi_scrutinio · non vince più l’ultimo', () => {
  it('la migrazione si riapplica senza errori (CREATE OR REPLACE)', async () => {
    await db.exec(NUOVA)
  })

  it('prima scrittura (versione null = «non c’era») → ok, e la riga torna con la sua versione', async () => {
    const e = await giudizi([g('Buono', { versione: null })])
    expect(e.esito).toBe('ok')
    expect(e.righe).toHaveLength(1)
    expect(e.righe?.[0]).toMatchObject({ alunno_id: ALUNNO, giudizio_sintetico: 'Buono', proposto_da: DOCENTE_A })
    expect(e.righe?.[0].updated_at).toBeTruthy()
  })

  it('lo stesso client salva due volte di fila con la versione restituita → ok tutte e due', async () => {
    const e1 = await giudizi([g('Buono', { versione: null })])
    const e2 = await giudizi([g('Distinto', { versione: e1.righe?.[0].updated_at })])
    expect(e2.esito).toBe('ok')
    expect((await giudizioAttuale()).giudizio_sintetico).toBe('Distinto')
  })

  it('🔴 versione vecchia e valore diverso → «conflitto» con i soli uuid, e NIENTE scritto', async () => {
    const letta = (await giudizi([g('Buono', { versione: null })])).righe?.[0].updated_at
    // B (con la versione giusta) cambia il giudizio; A ha ancora quella di prima.
    await giudizi([g('Ottimo', { versione: letta, proposto_da: DOCENTE_B })])
    const primaDiA = await giudizioAttuale()

    const e = await giudizi([g('Sufficiente', { versione: letta })])

    expect(e.esito).toBe('conflitto')
    expect(e.conflitti).toEqual([{ alunno_id: ALUNNO, materia_id: MATERIA, versione: expect.any(String) }])
    expect(await giudizioAttuale()).toEqual(primaDiA)
    expect(primaDiA).toMatchObject({ giudizio_sintetico: 'Ottimo', proposto_da: DOCENTE_B })
  })

  it('versione vecchia ma STESSO valore → ok: non si perde il lavoro di nessuno', async () => {
    const letta = (await giudizi([g('Buono', { versione: null })])).righe?.[0].updated_at
    await giudizi([g('Ottimo', { versione: letta })])
    const e = await giudizi([g('Ottimo', { versione: letta })])
    expect(e.esito).toBe('ok')
  })

  it('🔴 «non c’era» (null) ma nel frattempo un altro l’ha creata con un altro valore → conflitto', async () => {
    await giudizi([g('Ottimo', { versione: null, proposto_da: DOCENTE_B })])
    const e = await giudizi([g('Buono', { versione: null })])
    expect(e.esito).toBe('conflitto')
    expect((await giudizioAttuale()).giudizio_sintetico).toBe('Ottimo')
  })

  it('un conflitto su una riga ferma TUTTO il salvataggio: nessuna riga a metà', async () => {
    const letta = (await giudizi([g('Buono', { versione: null })])).righe?.[0].updated_at
    await giudizi([g('Ottimo', { versione: letta })])
    const e = await giudizi([
      g('Sufficiente', { versione: letta }),
      g('Buono', { alunno_id: ALUNNO_2, versione: null }),
    ])
    expect(e.esito).toBe('conflitto')
    expect(await giudizioAttuale(ALUNNO_2)).toBeUndefined()
  })

  it('riga senza la chiave `versione` (pagina aperta prima del rilascio) → si scrive come prima', async () => {
    const letta = (await giudizi([g('Buono', { versione: null })])).righe?.[0].updated_at
    await giudizi([g('Ottimo', { versione: letta })])
    const e = await giudizi([g('Sufficiente')])
    expect(e.esito).toBe('ok')
    expect((await giudizioAttuale()).giudizio_sintetico).toBe('Sufficiente')
  })

  it('scrutinio chiuso → «chiuso»; inesistente → «non_trovato»; niente scritto', async () => {
    await db.query(`UPDATE public.scrutini SET stato = 'chiuso' WHERE id = $1`, [SCRUTINIO])
    expect((await giudizi([g('Buono', { versione: null })])).esito).toBe('chiuso')
    expect((await giudizi([g('Buono', { versione: null })], 'c0000000-0000-4000-8000-0000000000ff')).esito).toBe('non_trovato')
    expect(await giudizioAttuale()).toBeUndefined()
  })

  it('versione malformata → errore (22007), la stessa riga due volte → errore (21000)', async () => {
    await expect(giudizi([g('Buono', { versione: 'ieri' })])).rejects.toThrow()
    await expect(giudizi([g('Buono', { versione: null }), g('Ottimo', { versione: null })])).rejects.toThrow()
    expect(await giudizioAttuale()).toBeUndefined()
  })

  it('controllo negativo: l’upsert cieco di prima riscrive il giudizio dell’altro', async () => {
    await giudizi([g('Ottimo', { versione: null, proposto_da: DOCENTE_B })])
    // L'upsert della route fino al 2026-10-10, con il valore vecchio della schermata di A.
    await db.query(
      `INSERT INTO public.scrutinio_giudizi (scrutinio_id, alunno_id, materia_id, giudizio_sintetico, proposto_da)
       VALUES ($1, $2, $3, 'Sufficiente', $4)
       ON CONFLICT (scrutinio_id, alunno_id, materia_id) DO UPDATE
         SET giudizio_sintetico = EXCLUDED.giudizio_sintetico, proposto_da = EXCLUDED.proposto_da`,
      [SCRUTINIO, ALUNNO, MATERIA, DOCENTE_A],
    )
    expect((await giudizioAttuale()).giudizio_sintetico).toBe('Sufficiente')
  })
})

describe('salva_comportamento_scrutinio · stesso controllo', () => {
  const c = (testo: string, extra: Riga = {}): Riga => ({
    alunno_id: ALUNNO, giudizio_testo: testo, scala_valore: null, giudizio_globale: null, ...extra,
  })

  it('versione fresca → ok; versione vecchia con testo diverso → conflitto e niente scritto', async () => {
    const letta = (await comportamento([c('Corretto', { versione: null })])).righe?.[0].updated_at
    const e1 = await comportamento([c('Molto corretto', { versione: letta })])
    expect(e1.esito).toBe('ok')

    const e2 = await comportamento([c('Da migliorare', { versione: letta })])
    expect(e2.esito).toBe('conflitto')
    expect(e2.conflitti).toEqual([{ alunno_id: ALUNNO, versione: expect.any(String) }])
    const r = await db.query<{ giudizio_testo: string }>('SELECT giudizio_testo FROM public.scrutinio_comportamento')
    expect(r.rows[0].giudizio_testo).toBe('Molto corretto')
  })

  it('il confronto guarda tutti e tre i campi: cambia solo il giudizio globale → conflitto', async () => {
    const letta = (await comportamento([c('Corretto', { versione: null })])).righe?.[0].updated_at
    await comportamento([c('Corretto', { versione: letta, giudizio_globale: 'Sereno' })])
    const e = await comportamento([c('Corretto', { versione: letta })])
    expect(e.esito).toBe('conflitto')
  })
})

describe('permessi', () => {
  it('EXECUTE solo alla service_role, su tutte e due le funzioni', async () => {
    const r = await db.query<{ f: string; ruolo: string; puo: boolean }>(`
      SELECT f, ruolo, has_function_privilege(ruolo, f, 'EXECUTE') AS puo
        FROM unnest(ARRAY['public.salva_giudizi_scrutinio(uuid, jsonb)', 'public.salva_comportamento_scrutinio(uuid, jsonb)']) AS f,
             unnest(ARRAY['anon', 'authenticated', 'service_role']) AS ruolo`)
    for (const x of r.rows) expect([x.f, x.ruolo, x.puo]).toEqual([x.f, x.ruolo, x.ruolo === 'service_role'])
    expect(r.rows).toHaveLength(6)
  })
})
