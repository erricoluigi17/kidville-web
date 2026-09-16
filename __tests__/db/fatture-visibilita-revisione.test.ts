// @vitest-environment node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const SNAPSHOT = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260916120000_fatture_visibilita_snapshot.sql'),
  'utf8',
)
const REVISIONE = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260916120100_fatture_visibilita_revisione.sql'),
  'utf8',
)
const WORM = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260809235759_worm_search_path.sql'),
  'utf8',
)

const SEDE = '10000000-0000-4000-8000-000000000001'
const ALTRA_SEDE = '20000000-0000-4000-8000-000000000002'
const ALUNNO = '30000000-0000-4000-8000-000000000003'
const ATTORE = '40000000-0000-4000-8000-000000000004'
const ATTORE_ALTRA_SEDE = '50000000-0000-4000-8000-000000000005'
const ATTORE_PONTE = '60000000-0000-4000-8000-000000000006'
const ACCOUNT_GENITORE = '70000000-0000-4000-8000-000000000007'
const ATTORE_GENITORE = '71000000-0000-4000-8000-000000000007'
const ATTORE_EDUCATOR = '72000000-0000-4000-8000-000000000007'
const ATTORE_CUOCA = '73000000-0000-4000-8000-000000000007'
const ATTORE_SEGRETERIA_PONTE = '74000000-0000-4000-8000-000000000007'
const ATTORE_STAFF_GENITORE = '75000000-0000-4000-8000-000000000007'
const PARENT_DIRETTO = '80000000-0000-4000-8000-000000000008'
const PARENT_LEGACY = '90000000-0000-4000-8000-000000000009'
const PARENT_ESTRANEO = 'a0000000-0000-4000-8000-00000000000a'
const PARENT_STAFF = 'a1000000-0000-4000-8000-00000000000a'
const PAGAMENTO = 'b0000000-0000-4000-8000-00000000000b'
const PAGAMENTO_ALTRA_SEDE = 'c0000000-0000-4000-8000-00000000000c'
const FATTURA_ORDINARIA = 'd0000000-0000-4000-8000-00000000000d'
const FATTURA_QUOTA = 'e0000000-0000-4000-8000-00000000000e'
const FATTURA_IRRISOLTA = 'f0000000-0000-4000-8000-00000000000f'
const FATTURA_SENZA_REVISIONE = '01000000-0000-4000-8000-000000000010'
const FATTURA_SCOPE_ERRATO = '02000000-0000-4000-8000-000000000020'

let db: PGlite

async function valore<T>(sql: string): Promise<T> {
  const risultato = await db.query<Record<string, T>>(sql)
  return Object.values(risultato.rows[0])[0]
}

async function comeRuolo<T>(ruolo: 'anon' | 'authenticated' | 'service_role', sql: string): Promise<T> {
  await db.exec(`SET ROLE ${ruolo}`)
  try {
    return await valore<T>(sql)
  } finally {
    await db.exec('RESET ROLE')
  }
}

async function eseguiComeRuolo(
  ruolo: 'anon' | 'authenticated' | 'service_role',
  sql: string,
): Promise<void> {
  await db.exec(`SET ROLE ${ruolo}`)
  try {
    await db.exec(sql)
  } finally {
    await db.exec('RESET ROLE')
  }
}

async function statoPersistito() {
  const risultato = await db.query<{
    revisioni: number
    audit: number
    flag_attivo: boolean
    snapshot_finalizzati: number
  }>(`
    SELECT
      (SELECT count(*)::int FROM public.fatture_visibilita_revisioni) AS revisioni,
      (SELECT count(*)::int FROM public.fatture_visibilita_audit) AS audit,
      (SELECT fatture_visibilita_attiva_il IS NOT NULL
       FROM public.admin_settings WHERE scuola_id = '${SEDE}') AS flag_attivo,
      (SELECT count(*)::int FROM public.fatture_emesse
       WHERE scuola_id = '${SEDE}' AND modalita_emissione IS NOT NULL) AS snapshot_finalizzati
  `)
  return risultato.rows[0]
}

function salvaSql(
  fatturaId: string,
  modalita: 'ordinaria' | 'quote_separate' | 'irrisolta',
  parentId: string | null = null,
  scuolaId = SEDE,
  attoreId = ATTORE,
): string {
  return `SELECT public.fatture_visibilita_salva_revisione(
    '${scuolaId}'::uuid,
    '${fatturaId}'::uuid,
    '${modalita}'::text,
    ${parentId ? `'${parentId}'::uuid` : 'NULL::uuid'},
    '${attoreId}'::uuid
  ) AS esito`
}

function attivaSql(irrisolte: string[], attoreId = ATTORE): string {
  const elementi = irrisolte.map((id) => `'${id}'::uuid`).join(', ')
  return `SELECT public.fatture_visibilita_attiva(
    '${SEDE}'::uuid,
    ARRAY[${elementi}]::uuid[],
    '${attoreId}'::uuid
  ) AS esito`
}

async function preparaDatabase() {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      GRANT ALL ON TABLES TO service_role;

    CREATE TABLE public.schools (
      id uuid PRIMARY KEY
    );
    CREATE TABLE public.parents (
      id uuid PRIMARY KEY,
      auth_user_id uuid
    );
    CREATE TABLE public.utenti (
      id uuid PRIMARY KEY,
      ruolo varchar(50) NOT NULL,
      role varchar(50) GENERATED ALWAYS AS (ruolo) STORED,
      scuola_id uuid NOT NULL
    );
    CREATE TABLE public.utenti_scuole (
      utente_id uuid NOT NULL,
      scuola_id uuid NOT NULL
    );
    CREATE TABLE public.student_parents (
      student_id uuid NOT NULL,
      parent_id uuid NOT NULL
    );
    CREATE TABLE public.legame_genitori_alunni (
      genitore_id uuid NOT NULL,
      alunno_id uuid NOT NULL
    );
    CREATE TABLE public.pagamenti (
      id uuid PRIMARY KEY,
      scuola_id uuid,
      alunno_id uuid
    );
    CREATE TABLE public.admin_settings (scuola_id uuid PRIMARY KEY);
    CREATE TABLE public.fatture_emesse (
      id uuid PRIMARY KEY,
      pagamento_id uuid NOT NULL,
      scuola_id uuid NOT NULL,
      numero integer NOT NULL,
      anno integer NOT NULL,
      sezionale text,
      importo numeric(10,2) NOT NULL,
      xml_inviato text,
      quota_adult_id uuid,
      progressivo_invio text,
      intestatario jsonb,
      bollo_virtuale boolean,
      creato_il timestamptz DEFAULT now(),
      parent_registry_id uuid REFERENCES public.parents(id)
    );

    INSERT INTO public.schools (id) VALUES ('${SEDE}'), ('${ALTRA_SEDE}');
    INSERT INTO public.utenti (id, ruolo, scuola_id) VALUES
      ('${ATTORE}', 'segreteria', '${SEDE}'),
      ('${ATTORE_ALTRA_SEDE}', 'coordinator', '${ALTRA_SEDE}'),
      ('${ATTORE_PONTE}', ' ADMIN ', '${ALTRA_SEDE}'),
      ('${ATTORE_GENITORE}', 'genitore', '${SEDE}'),
      ('${ATTORE_EDUCATOR}', 'educator', '${SEDE}'),
      ('${ATTORE_CUOCA}', 'cuoca', '${SEDE}'),
      ('${ATTORE_SEGRETERIA_PONTE}', 'segreteria', '${ALTRA_SEDE}'),
      ('${ATTORE_STAFF_GENITORE}', 'segreteria', '${SEDE}');
    INSERT INTO public.utenti_scuole (utente_id, scuola_id)
      VALUES
        ('${ATTORE_PONTE}', '${SEDE}'),
        ('${ATTORE_SEGRETERIA_PONTE}', '${SEDE}');
    INSERT INTO public.parents (id, auth_user_id) VALUES
      ('${PARENT_DIRETTO}', NULL),
      ('${PARENT_LEGACY}', '${ACCOUNT_GENITORE}'),
      ('${PARENT_ESTRANEO}', NULL),
      ('${PARENT_STAFF}', '${ATTORE_STAFF_GENITORE}');
    INSERT INTO public.student_parents (student_id, parent_id)
      VALUES ('${ALUNNO}', '${PARENT_DIRETTO}');
    INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id)
      VALUES ('${ACCOUNT_GENITORE}', '${ALUNNO}');
    INSERT INTO public.pagamenti (id, scuola_id, alunno_id) VALUES
      ('${PAGAMENTO}', '${SEDE}', '${ALUNNO}'),
      ('${PAGAMENTO_ALTRA_SEDE}', '${ALTRA_SEDE}', '${ALUNNO}');
    INSERT INTO public.admin_settings (scuola_id) VALUES ('${SEDE}'), ('${ALTRA_SEDE}');
    INSERT INTO public.fatture_emesse
      (id, pagamento_id, scuola_id, numero, anno, importo, parent_registry_id)
    VALUES
      ('${FATTURA_ORDINARIA}', '${PAGAMENTO}', '${SEDE}', 1, 2026, 100, '${PARENT_ESTRANEO}'),
      ('${FATTURA_QUOTA}', '${PAGAMENTO}', '${SEDE}', 2, 2026, 100, NULL),
      ('${FATTURA_IRRISOLTA}', '${PAGAMENTO}', '${SEDE}', 3, 2026, 100, NULL),
      ('${FATTURA_SENZA_REVISIONE}', '${PAGAMENTO}', '${SEDE}', 4, 2026, 100, NULL),
      ('${FATTURA_SCOPE_ERRATO}', '${PAGAMENTO}', '${ALTRA_SEDE}', 5, 2026, 100, NULL);
  `)
  await db.exec(WORM)
  await db.exec(`
    CREATE TRIGGER trg_worm_fatture_emesse
      BEFORE UPDATE OR DELETE ON public.fatture_emesse
      FOR EACH ROW EXECUTE FUNCTION public.worm_fatture_emesse();
  `)
  await db.exec(SNAPSHOT)
  await db.exec(REVISIONE)
}

beforeEach(async () => {
  db = new PGlite()
  await preparaDatabase()
})

afterEach(async () => {
  await db.close()
})

describe('RPC di revisione dello storico', () => {
  it('sono SECURITY INVOKER, col search_path chiuso ed eseguibili soltanto dal service role', async () => {
    const funzioni = await db.query<{
      nome: string
      security_definer: boolean
      config: string[] | null
    }>(`
      SELECT p.proname AS nome,
             p.prosecdef AS security_definer,
             p.proconfig AS config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('fatture_visibilita_salva_revisione', 'fatture_visibilita_attiva')
      ORDER BY p.proname
    `)
    expect(funzioni.rows).toHaveLength(2)
    expect(funzioni.rows.every((f) => f.security_definer === false)).toBe(true)
    expect(funzioni.rows.every((f) => f.config?.includes('search_path=public, pg_temp'))).toBe(true)

    for (const ruolo of ['anon', 'authenticated'] as const) {
      await expect(comeRuolo(ruolo, salvaSql(FATTURA_ORDINARIA, 'ordinaria')))
        .rejects.toThrow(/permission denied/i)
    }
    expect(await valore<boolean>(`
      SELECT has_function_privilege(
        'service_role',
        'public.fatture_visibilita_salva_revisione(uuid,uuid,text,uuid,uuid)',
        'EXECUTE'
      )
    `)).toBe(true)
  })

  it.each([
    ['genitore', ATTORE_GENITORE],
    ['educator', ATTORE_EDUCATOR],
    ['cuoca', ATTORE_CUOCA],
  ])('nega il ruolo non contabile %s su entrambe le RPC senza alcun effetto', async (_ruolo, attore) => {
    const prima = await statoPersistito()
    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_ORDINARIA, 'ordinaria', null, SEDE, attore),
    )).rejects.toThrow(/attore.*abilitato/i)
    await expect(comeRuolo(
      'service_role',
      attivaSql([], attore),
    )).rejects.toThrow(/attore.*abilitato/i)
    expect(await statoPersistito()).toEqual(prima)
  })

  it.each([
    ['coordinator fuori sede', ATTORE_ALTRA_SEDE],
    ['segreteria presente soltanto nel ponte multi sede', ATTORE_SEGRETERIA_PONTE],
  ])('nega %s su entrambe le RPC e lascia intatti bozze, audit, flag e snapshot', async (_caso, attore) => {
    const prima = await statoPersistito()
    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_ORDINARIA, 'ordinaria', null, SEDE, attore),
    )).rejects.toThrow(/attore.*sede/i)
    await expect(comeRuolo(
      'service_role',
      attivaSql([], attore),
    )).rejects.toThrow(/attore.*sede/i)
    expect(await statoPersistito()).toEqual(prima)
  })

  it('riconosce lo staff dal ruolo reale anche quando lo stesso account è anche genitore', async () => {
    expect(await valore<string>(`
      SELECT role FROM public.utenti WHERE id = '${ATTORE_STAFF_GENITORE}'
    `)).toBe('segreteria')
    expect(await valore<boolean>(`
      SELECT EXISTS (
        SELECT 1 FROM public.parents WHERE auth_user_id = '${ATTORE_STAFF_GENITORE}'
      )
    `)).toBe(true)

    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_ORDINARIA, 'ordinaria', null, SEDE, ATTORE_STAFF_GENITORE),
    )).resolves.toMatchObject({ verificata_da: ATTORE_STAFF_GENITORE })
  })

  it('salva e corregge la bozza, verificando attore e data e appendendo l’audit', async () => {
    const prima = await comeRuolo<Record<string, unknown>>(
      'service_role',
      salvaSql(FATTURA_ORDINARIA, 'ordinaria'),
    )
    expect(prima).toMatchObject({
      fattura_id: FATTURA_ORDINARIA,
      modalita: 'ordinaria',
      finalizzata: false,
    })

    const seconda = await comeRuolo<Record<string, unknown>>(
      'service_role',
      salvaSql(FATTURA_ORDINARIA, 'quote_separate', PARENT_DIRETTO),
    )
    expect(seconda).toMatchObject({ modalita: 'quote_separate', parent_registry_id: PARENT_DIRETTO })
    expect(await valore<number>(`
      SELECT count(*)::int FROM public.fatture_visibilita_audit
      WHERE fattura_id = '${FATTURA_ORDINARIA}'
    `)).toBe(2)
    expect(await valore<boolean>(`
      SELECT verificata_da = '${ATTORE}'::uuid AND verificata_il IS NOT NULL
      FROM public.fatture_visibilita_revisioni WHERE fattura_id = '${FATTURA_ORDINARIA}'
    `)).toBe(true)
  })

  it('rifiuta sede incoerente fra parametro, fattura e pagamento e attori fuori sede', async () => {
    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_SCOPE_ERRATO, 'ordinaria', null, ALTRA_SEDE, ATTORE_ALTRA_SEDE),
    )).rejects.toThrow(/sede.*pagamento/i)
    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_ORDINARIA, 'ordinaria', null, SEDE, ATTORE_ALTRA_SEDE),
    )).rejects.toThrow(/attore.*sede/i)
    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_ORDINARIA, 'ordinaria', null, SEDE, ATTORE_PONTE),
    )).resolves.toMatchObject({ modalita: 'ordinaria' })
  })

  it('accetta quote solo per parents.id collegati al bambino, su entrambi i ponti reali', async () => {
    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_QUOTA, 'quote_separate', PARENT_DIRETTO),
    )).resolves.toMatchObject({ parent_registry_id: PARENT_DIRETTO })
    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_IRRISOLTA, 'quote_separate', PARENT_LEGACY),
    )).resolves.toMatchObject({ parent_registry_id: PARENT_LEGACY })
    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_SENZA_REVISIONE, 'quote_separate', PARENT_ESTRANEO),
    )).rejects.toThrow(/genitore.*alunno/i)
  })

  it('l’audit è append-only e RLS-chiuso, anche coi default grant al service role', async () => {
    await comeRuolo('service_role', salvaSql(FATTURA_ORDINARIA, 'ordinaria'))
    for (const privilegio of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(await valore<boolean>(`
        SELECT has_table_privilege('service_role', 'public.fatture_visibilita_audit', '${privilegio}')
      `)).toBe(false)
    }
    await expect(comeRuolo(
      'service_role',
      `UPDATE public.fatture_visibilita_audit SET azione = 'manomessa' RETURNING id`,
    )).rejects.toThrow(/permission denied|append-only/i)
    await expect(eseguiComeRuolo(
      'service_role',
      `TRUNCATE public.fatture_visibilita_audit`,
    )).rejects.toThrow(/permission denied|append-only/i)
    await expect(comeRuolo(
      'authenticated',
      `SELECT count(*) FROM public.fatture_visibilita_audit`,
    )).rejects.toThrow(/permission denied/i)
  })

  it('vincola ogni audit a una sede reale e la migrazione resta idempotente', async () => {
    const sedeInesistente = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

    await expect(eseguiComeRuolo('service_role', `
      INSERT INTO public.fatture_visibilita_audit (scuola_id, azione, verificata_da)
      VALUES ('${sedeInesistente}', 'attivazione', '${ATTORE}')
    `)).rejects.toThrow(/foreign key|violates foreign key constraint/i)

    await expect(eseguiComeRuolo('service_role', `
      INSERT INTO public.fatture_visibilita_audit (scuola_id, azione, verificata_da)
      VALUES ('${SEDE}', 'attivazione', '${ATTORE}')
    `)).resolves.toBeUndefined()

    await expect(db.exec(REVISIONE)).resolves.toBeDefined()
    expect(await valore<number>(`
      SELECT count(*)::int
      FROM pg_constraint
      WHERE conname = 'fatture_visibilita_audit_scuola_id_fkey'
        AND conrelid = 'public.fatture_visibilita_audit'::regclass
    `)).toBe(1)

    // Riproduce lo stato della CI, dove la tabella era gia stata creata dalla
    // prima versione della migrazione ma la FK non esisteva ancora.
    await db.exec(`
      ALTER TABLE public.fatture_visibilita_audit
      DROP CONSTRAINT fatture_visibilita_audit_scuola_id_fkey
    `)
    await expect(db.exec(REVISIONE)).resolves.toBeDefined()
    expect(await valore<number>(`
      SELECT count(*)::int
      FROM pg_constraint
      WHERE conname = 'fatture_visibilita_audit_scuola_id_fkey'
        AND conrelid = 'public.fatture_visibilita_audit'::regclass
    `)).toBe(1)
  })
})

describe('RPC di attivazione atomica', () => {
  async function preparaTreDecisioni() {
    await comeRuolo('service_role', salvaSql(FATTURA_ORDINARIA, 'ordinaria'))
    await comeRuolo('service_role', salvaSql(FATTURA_QUOTA, 'quote_separate', PARENT_DIRETTO))
    await comeRuolo('service_role', salvaSql(FATTURA_IRRISOLTA, 'irrisolta'))
  }

  it.each([
    ['admin multi sede', ATTORE_PONTE],
    ['staff che è anche genitore nella propria sede', ATTORE_STAFF_GENITORE],
  ])('consente l’attivazione a %s', async (_caso, attore) => {
    await preparaTreDecisioni()
    await comeRuolo('service_role', salvaSql(FATTURA_SENZA_REVISIONE, 'irrisolta'))

    await expect(comeRuolo<Record<string, unknown>>(
      'service_role',
      attivaSql([FATTURA_IRRISOLTA, FATTURA_SENZA_REVISIONE], attore),
    )).resolves.toMatchObject({ finalizzate: 2, irrisolte: 2 })
    expect(await valore<boolean>(`
      SELECT fatture_visibilita_attiva_il IS NOT NULL
      FROM public.admin_settings WHERE scuola_id = '${SEDE}'
    `)).toBe(true)
  })

  it('blocca l’attivazione se anche una sola fattura NULL non ha revisione', async () => {
    await preparaTreDecisioni()
    await expect(comeRuolo(
      'service_role',
      attivaSql([FATTURA_IRRISOLTA]),
    )).rejects.toThrow(/senza revisione/i)
    expect(await valore<boolean>(`
      SELECT fatture_visibilita_attiva_il IS NULL FROM public.admin_settings WHERE scuola_id = '${SEDE}'
    `)).toBe(true)
  })

  it('rifiuta anteprime stale o duplicate e lascia flag e snapshot invariati', async () => {
    await preparaTreDecisioni()
    await comeRuolo('service_role', salvaSql(FATTURA_SENZA_REVISIONE, 'irrisolta'))
    await expect(comeRuolo(
      'service_role',
      attivaSql([FATTURA_IRRISOLTA]),
    )).rejects.toThrow(/anteprima.*cambiata/i)
    await expect(comeRuolo(
      'service_role',
      attivaSql([FATTURA_IRRISOLTA, FATTURA_IRRISOLTA]),
    )).rejects.toThrow(/duplicat/i)
    expect(await valore<number>(`
      SELECT count(*)::int FROM public.fatture_emesse WHERE scuola_id = '${SEDE}' AND modalita_emissione IS NOT NULL
    `)).toBe(0)
    expect(await valore<boolean>(`
      SELECT fatture_visibilita_attiva_il IS NULL FROM public.admin_settings WHERE scuola_id = '${SEDE}'
    `)).toBe(true)
  })

  it('finalizza ordinarie e quote, preserva il parent ordinario e lascia NULL le irrisolte', async () => {
    await preparaTreDecisioni()
    await comeRuolo('service_role', salvaSql(FATTURA_SENZA_REVISIONE, 'irrisolta'))
    const esito = await comeRuolo<Record<string, unknown>>(
      'service_role',
      attivaSql([FATTURA_IRRISOLTA, FATTURA_SENZA_REVISIONE]),
    )
    expect(esito).toMatchObject({ finalizzate: 2, irrisolte: 2 })
    expect(await valore<string>(`
      SELECT modalita_emissione FROM public.fatture_emesse WHERE id = '${FATTURA_ORDINARIA}'
    `)).toBe('ordinaria')
    expect(await valore<string>(`
      SELECT parent_registry_id::text FROM public.fatture_emesse WHERE id = '${FATTURA_ORDINARIA}'
    `)).toBe(PARENT_ESTRANEO)
    expect(await valore<string>(`
      SELECT parent_registry_id::text FROM public.fatture_emesse WHERE id = '${FATTURA_QUOTA}'
    `)).toBe(PARENT_DIRETTO)
    expect(await valore<number>(`
      SELECT count(*)::int FROM public.fatture_emesse
      WHERE id IN ('${FATTURA_IRRISOLTA}', '${FATTURA_SENZA_REVISIONE}')
        AND modalita_emissione IS NULL
    `)).toBe(2)
    expect(await valore<boolean>(`
      SELECT fatture_visibilita_attiva_il IS NOT NULL FROM public.admin_settings WHERE scuola_id = '${SEDE}'
    `)).toBe(true)
    expect(await valore<string | null>(`
      SELECT NULLIF(current_setting('app.fatture_visibilita_finalizza_storico', true), '')
    `)).toBeNull()

    await expect(db.exec(`
      INSERT INTO public.fatture_emesse
        (id, pagamento_id, scuola_id, numero, anno, importo, modalita_emissione)
      VALUES
        ('03000000-0000-4000-8000-000000000030', '${PAGAMENTO}', '${SEDE}', 6, 2026, 100, NULL)
    `)).rejects.toThrow(/modalita_emissione obbligatoria/i)

    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_ORDINARIA, 'quote_separate', PARENT_DIRETTO),
    )).rejects.toThrow(/già finalizzata/i)
    await expect(db.exec(`UPDATE public.fatture_emesse SET numero = 99 WHERE id = '${FATTURA_ORDINARIA}'`))
      .rejects.toThrow(/campi fiscali immutabili/i)
  })

  it('fa rollback completo se una revisione quote è stata manomessa fuori RPC', async () => {
    await preparaTreDecisioni()
    await comeRuolo('service_role', salvaSql(FATTURA_SENZA_REVISIONE, 'irrisolta'))
    await comeRuolo(
      'service_role',
      `UPDATE public.fatture_visibilita_revisioni
       SET parent_registry_id = '${PARENT_ESTRANEO}'
       WHERE fattura_id = '${FATTURA_QUOTA}'
       RETURNING fattura_id`,
    )

    await expect(comeRuolo(
      'service_role',
      attivaSql([FATTURA_IRRISOLTA, FATTURA_SENZA_REVISIONE]),
    )).rejects.toThrow(/genitore.*alunno/i)
    expect(await valore<number>(`
      SELECT count(*)::int FROM public.fatture_emesse WHERE scuola_id = '${SEDE}' AND modalita_emissione IS NOT NULL
    `)).toBe(0)
    expect(await valore<boolean>(`
      SELECT fatture_visibilita_attiva_il IS NULL FROM public.admin_settings WHERE scuola_id = '${SEDE}'
    `)).toBe(true)
  })

  it('dopo l’attivazione una irrisolta si risolve esplicitamente e diventa irreversibile', async () => {
    await preparaTreDecisioni()
    await comeRuolo('service_role', salvaSql(FATTURA_SENZA_REVISIONE, 'irrisolta'))
    await comeRuolo(
      'service_role',
      attivaSql([FATTURA_IRRISOLTA, FATTURA_SENZA_REVISIONE]),
    )

    const risolta = await comeRuolo<Record<string, unknown>>(
      'service_role',
      salvaSql(FATTURA_IRRISOLTA, 'quote_separate', PARENT_LEGACY),
    )
    expect(risolta).toMatchObject({ finalizzata: true, modalita: 'quote_separate' })
    expect(await valore<string>(`
      SELECT modalita_emissione FROM public.fatture_emesse WHERE id = '${FATTURA_IRRISOLTA}'
    `)).toBe('quote_separate')
    await expect(comeRuolo(
      'service_role',
      salvaSql(FATTURA_IRRISOLTA, 'ordinaria'),
    )).rejects.toThrow(/già finalizzata/i)
  })
})
