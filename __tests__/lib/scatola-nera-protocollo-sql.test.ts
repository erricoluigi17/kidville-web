// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * T4 · IL REGISTRO DI PROTOCOLLO NELLA SCATOLA NERA («copia silenziosa», robustezza seconda serie,
 * sessione 3), PROVATO SU UN POSTGRES VERO.
 *
 * Le decisioni #6 e #26 del registro («nessuna traccia applicativa») restano: qui non c'è nessun
 * log. Una registrazione eliminata e i suoi allegati restano 90 giorni in
 * `scatola_nera.eliminazioni`, una registrazione rettificata lascia la versione di prima in
 * `scatola_nera.modifiche`, e `protocollo_elimina` restituisce anche i documenti sostituiti dalle
 * rettifiche, che la route toglie dal bucket con l'API dello Storage. Lo Storage è ridotto alle due
 * colonne che la funzione legge. Le WORM del registro non servono qui: le prova
 * `protocollo-elimina-sql.test.ts`. Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const file = readdirSync(CARTELLA).find((f) => f.endsWith(suffisso))
  if (!file) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, file), 'utf8')
}
const ELIMINAZIONI = migrazione('_scatola_nera_registro_eliminazioni.sql')
const MODIFICHE = migrazione('_scatola_nera_modifiche.sql')
const PROTOCOLLO = migrazione('_scatola_nera_protocollo.sql')

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const PROT = 'b0000000-0000-4000-8000-000000000001'
const ALTRO = 'b0000000-0000-4000-8000-000000000002'
/** Lo stesso formato di `istanteVersione` (`src/lib/protocolli/store.ts`): UTC, 17 cifre. */
const ISTANTE = '20261021103015123'

/** Lo Storage ridotto alle due colonne che la funzione legge. */
const STORAGE = `
    CREATE SCHEMA storage;
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL
    );
`

/** Lo schema minimo senza Storage, ruoli compresi: lo usano il database principale e quelli non migrati. */
const SCHEMA_REGISTRO = `
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL, evento text NOT NULL, sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL, fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1, visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

    CREATE TABLE public.protocolli (
      id uuid PRIMARY KEY, scuola_id uuid NOT NULL, anno int NOT NULL, numero int NOT NULL,
      oggetto text, file_originale text, file_timbrato text
    );
    -- Il freno della fase 7: RESTRICT al posto di CASCADE.
    CREATE TABLE public.protocolli_allegati (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      protocollo_id uuid NOT NULL REFERENCES public.protocolli(id) ON DELETE RESTRICT,
      path text NOT NULL
    );
`
const SCHEMA = SCHEMA_REGISTRO + STORAGE

let db: PGlite

async function numero(sql: string, conn: PGlite = db): Promise<number> {
  const { rows } = await conn.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

async function codiceErrore(sql: string): Promise<string | null> {
  try {
    await db.exec(sql)
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'errore'
  }
}

/** I trigger della scatola sulle due tabelle del registro, per nome. */
async function triggerProtocollo(conn: PGlite): Promise<Record<string, number>> {
  const { rows } = await conn.query<{ nome: string; n: number }>(`
    SELECT g.tgname AS nome, count(*)::int AS n FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
     WHERE g.tgname LIKE 'scatola_nera_%' AND c.relname IN ('protocolli', 'protocolli_allegati')
     GROUP BY 1 ORDER BY 1`)
  return Object.fromEntries(rows.map((r) => [r.nome, r.n]))
}

const SEMINA_REGISTRO = `
    INSERT INTO public.protocolli (id, scuola_id, anno, numero, oggetto, file_originale, file_timbrato) VALUES
      ('${PROT}', '${SEDE}', 2026, 1, 'Oggetto di prova',
       '${SEDE}/2026/0000001-originale.pdf', '${SEDE}/2026/0000001-timbrato.pdf'),
      ('${ALTRO}', '${SEDE}', 2026, 10, 'Altro oggetto', '${SEDE}/2026/0000010-originale.pdf', NULL);
    INSERT INTO public.protocolli_allegati (protocollo_id, path) VALUES
      ('${PROT}', '${SEDE}/2026/0000001-allegati/1-a.pdf'),
      ('${PROT}', '${SEDE}/2026/0000001-allegati/2-b.pdf'),
      ('${ALTRO}', '${SEDE}/2026/0000010-allegati/1-c.pdf');
`
const SEMINA = SEMINA_REGISTRO + `
    INSERT INTO storage.objects (bucket_id, name) VALUES
      ('protocollo', '${SEDE}/2026/0000001-versioni/${ISTANTE}-0000001-originale.pdf'),
      ('protocollo', '${SEDE}/2026/0000010-versioni/${ISTANTE}-0000010-originale.pdf'),
      ('altro_bucket', '${SEDE}/2026/0000001-versioni/${ISTANTE}-0000001-originale.pdf');
`

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(ELIMINAZIONI)
  await db.exec(MODIFICHE)
  await db.exec(PROTOCOLLO)
  await db.exec(PROTOCOLLO) // idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    SET session_replication_role = replica;
    DELETE FROM public.protocolli_allegati;
    DELETE FROM public.protocolli;
    DELETE FROM storage.objects;
    DELETE FROM scatola_nera.eliminazioni;
    DELETE FROM scatola_nera.modifiche;
    DELETE FROM public.app_log;
    SET session_replication_role = DEFAULT;
    ${SEMINA}
  `)
})

describe('protocollo nella scatola nera — eliminazioni', () => {
  it('eliminare una registrazione: registrazione e allegati restano in scatola, nella stessa transazione', async () => {
    await db.query(`SELECT public.protocollo_elimina('${PROT}')`)
    const { rows } = await db.query<{ tabella: string; n: number }>(
      'SELECT tabella, count(*)::int AS n FROM scatola_nera.eliminazioni GROUP BY 1 ORDER BY 1')
    expect(rows).toEqual([
      { tabella: 'protocolli', n: 1 },
      { tabella: 'protocolli_allegati', n: 2 },
    ])
    expect(await numero('SELECT count(DISTINCT transazione) FROM scatola_nera.eliminazioni')).toBe(1)
    // Controllo positivo: l'altra registrazione è viva, con il suo allegato.
    expect(await numero(`SELECT count(*) FROM public.protocolli WHERE id = '${ALTRO}'`)).toBe(1)
    expect(await numero('SELECT count(*) FROM public.protocolli_allegati')).toBe(1)
  })

  it('restituisce anche le versioni dei documenti rettificati: solo quelle della registrazione, solo nel bucket del protocollo', async () => {
    const { rows } = await db.query<{ p: string[] }>(`SELECT public.protocollo_elimina('${PROT}') AS p`)
    expect([...rows[0].p].sort()).toEqual([
      `${SEDE}/2026/0000001-allegati/1-a.pdf`,
      `${SEDE}/2026/0000001-allegati/2-b.pdf`,
      `${SEDE}/2026/0000001-originale.pdf`,
      `${SEDE}/2026/0000001-timbrato.pdf`,
      `${SEDE}/2026/0000001-versioni/${ISTANTE}-0000001-originale.pdf`,
    ].sort())
    // La funzione LEGGE lo Storage e non lo tocca: i file li toglie la route con l'API.
    expect(await numero('SELECT count(*) FROM storage.objects')).toBe(3)
  })

  it('TRUNCATE vietato sulle due tabelle del registro', async () => {
    expect(await codiceErrore('TRUNCATE public.protocolli_allegati')).toBe('P0001')
    expect(await numero('SELECT count(*) FROM public.protocolli_allegati')).toBe(3)
  })
})

describe('protocollo nella scatola nera — modifiche e permessi', () => {
  it('una rettifica lascia la registrazione com’era', async () => {
    await db.exec(`UPDATE public.protocolli SET oggetto = 'Oggetto corretto' WHERE id = '${PROT}'`)
    const { rows } = await db.query<{ tabella: string; cambiate: string[]; prima: Record<string, unknown> }>(
      'SELECT tabella, cambiate, prima FROM scatola_nera.modifiche')
    expect(rows).toHaveLength(1)
    expect(rows[0].tabella).toBe('protocolli')
    expect(rows[0].cambiate).toEqual(['oggetto'])
    expect(rows[0].prima.oggetto).toBe('Oggetto di prova')
  })

  it('i trigger: due di eliminazione, due di TRUNCATE vietato, due di modifica', async () => {
    expect(await triggerProtocollo(db)).toEqual({
      scatola_nera_eliminazioni: 2,
      scatola_nera_modifiche: 2,
      scatola_nera_no_truncate: 2,
    })
  })

  it('solo il servizio chiama protocollo_elimina', async () => {
    const { rows } = await db.query<Record<string, boolean>>(`
      SELECT has_function_privilege('authenticated', 'public.protocollo_elimina(uuid)', 'EXECUTE') AS auth,
             has_function_privilege('anon', 'public.protocollo_elimina(uuid)', 'EXECUTE') AS anon,
             has_function_privilege('service_role', 'public.protocollo_elimina(uuid)', 'EXECUTE') AS servizio`)
    expect(rows[0]).toEqual({ auth: false, anon: false, servizio: true })
  })
})

// Il database della CI si migra a mano, un file alla volta: può avere la fase 4 senza la 12, o
// nessuna delle due. Lì la migrazione non deve fallire né accendere un trigger che farebbe fallire
// ogni UPDATE o DELETE del registro (42P01/42883), come la prima migrazione della sessione.
describe('un database non migrato (la CI)', () => {
  it('fase 4 senza fase 12: niente trigger delle modifiche, la rettifica passa, l’eliminazione si copia', async () => {
    const solo4 = new PGlite()
    try {
      await solo4.exec(SCHEMA)
      await solo4.exec(ELIMINAZIONI)
      await solo4.exec(PROTOCOLLO)
      await solo4.exec(PROTOCOLLO)
      await solo4.exec(SEMINA)
      expect(await triggerProtocollo(solo4)).toEqual({ scatola_nera_eliminazioni: 2, scatola_nera_no_truncate: 2 })
      await solo4.exec(`UPDATE public.protocolli SET oggetto = 'Oggetto corretto' WHERE id = '${PROT}'`)
      expect(await numero(`SELECT count(*) FROM public.protocolli WHERE oggetto = 'Oggetto corretto'`, solo4)).toBe(1)
      // Controllo positivo: la scatola delle eliminazioni c'è e copia.
      await solo4.query(`SELECT public.protocollo_elimina('${PROT}')`)
      expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni', solo4)).toBe(3)
    } finally {
      await solo4.close()
    }
  })

  it('senza la scatola: nessun trigger, e protocollo_elimina restituisce i percorsi ed elimina', async () => {
    const nuda = new PGlite()
    try {
      await nuda.exec(SCHEMA)
      await nuda.exec(PROTOCOLLO)
      await nuda.exec(PROTOCOLLO)
      await nuda.exec(SEMINA)
      expect(await triggerProtocollo(nuda)).toEqual({})
      const { rows } = await nuda.query<{ p: string[] }>(`SELECT public.protocollo_elimina('${PROT}') AS p`)
      expect(rows[0].p).toHaveLength(5)
      expect(await numero(`SELECT count(*) FROM public.protocolli WHERE id = '${PROT}'`, nuda)).toBe(0)
    } finally {
      await nuda.close()
    }
  })

  it('senza lo Storage: i soli percorsi della registrazione, e la registrazione se ne va in scatola', async () => {
    const senzaStorage = new PGlite()
    try {
      await senzaStorage.exec(SCHEMA_REGISTRO)
      await senzaStorage.exec(ELIMINAZIONI)
      await senzaStorage.exec(MODIFICHE)
      await senzaStorage.exec(PROTOCOLLO)
      await senzaStorage.exec(SEMINA_REGISTRO)
      const { rows } = await senzaStorage.query<{ p: string[] }>(`SELECT public.protocollo_elimina('${PROT}') AS p`)
      expect([...rows[0].p].sort()).toEqual([
        `${SEDE}/2026/0000001-allegati/1-a.pdf`,
        `${SEDE}/2026/0000001-allegati/2-b.pdf`,
        `${SEDE}/2026/0000001-originale.pdf`,
        `${SEDE}/2026/0000001-timbrato.pdf`,
      ])
      expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni', senzaStorage)).toBe(3)
    } finally {
      await senzaStorage.close()
    }
  })
})
