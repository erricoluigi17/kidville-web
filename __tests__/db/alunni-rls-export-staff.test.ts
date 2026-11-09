// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createBrowserClient, createServerClient } from '@supabase/ssr'

/**
 * CHE COSA RESTITUISCE `alunni` A CHI LEGGE DAL BROWSER (compito 4.4.8, decisione D3).
 *
 * `ImportExportClient` faceva `from('alunni').select('*')` con il client del browser. Con una
 * sessione quel client manda il JWT dell'utente (`fetchWithAuth` di supabase-js: il token, e solo
 * senza sessione la chiave), quindi PostgREST entra col ruolo `authenticated` e la RLS vale. Su
 * `alunni` l'unica policy è quella dei figli del genitore: una segreteria riceve `[]`, senza errore,
 * e `json_to_sheet([])` produce un file vuoto che si scarica come se fosse riuscito.
 *
 * La policy e la funzione NON sono ricopiate: si leggono dalle migrazioni. Se un giorno ne arriva
 * una per lo staff questo test diventa rosso, ed è giusto: la route server va ripensata. Limite
 * dichiarato: dice che cosa dicono le migrazioni, non che cosa c'è in produzione (il test non la
 * tocca). Dati finti, uuid finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')

const SEDE_A = '22222222-2222-4222-8222-222222222222'
const SEDE_B = '33333333-3333-4333-8333-333333333333'
const FIGLIO = '55555555-5555-4555-8555-555555555551'
const ALTRO_BAMBINO = '55555555-5555-4555-8555-555555555552'
const BAMBINO_SEDE_B = '55555555-5555-4555-8555-555555555553'
const GENITORE_AUTH = '66666666-6666-4666-8666-666666666661'
const SEGRETERIA_AUTH = '66666666-6666-4666-8666-666666666662'
const SEGRETERIA_ANCHE_GENITORE_AUTH = '66666666-6666-4666-8666-666666666663'
const FIGLIO_DELLA_SEGRETERIA = '55555555-5555-4555-8555-555555555554'
const GENITORE_RIGA = '77777777-7777-4777-8777-777777777771'
const GENITORE_SEGRETERIA_RIGA = '77777777-7777-4777-8777-777777777772'

/** Tutte le migrazioni, senza commenti: un'istruzione citata in una nota non è un'istruzione. */
function migrazioni(): { file: string; sql: string }[] {
  return readdirSync(CARTELLA)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({
      file,
      sql: readFileSync(join(CARTELLA, file), 'utf8').replace(/^\s*--.*$/gm, ''),
    }))
}

/** Le istruzioni che decidono chi legge `alunni`: policy create o tolte, e la RLS accesa o spenta. */
function istruzioniSuAlunni(sql: string): string[] {
  const forme = [
    /CREATE\s+POLICY\s+(?:"[^"]+"|\w+)\s+ON\s+(?:public\.)?"?alunni"?\s[^;]*;/gi,
    /(?:DROP|ALTER)\s+POLICY\s+(?:IF\s+EXISTS\s+)?(?:"[^"]+"|\w+)\s+ON\s+(?:public\.)?"?alunni"?[\s;][^;]*;?/gi,
    /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?alunni"?\s+(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\s*;/gi,
  ]
  return forme.flatMap((re) => [...sql.matchAll(re)].map((m) => m[0]))
}

const TUTTE = migrazioni()
const ISTRUZIONI = TUTTE.flatMap(({ file, sql }) => istruzioniSuAlunni(sql).map((testo) => ({ file, testo })))

/** La definizione VERA della funzione usata dalla policy: l'ultima, se qualcuno l'ha rifatta. */
function funzioneDeiFigli(): string {
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.current_parent_student_ids\(\)[\s\S]*?\$\$;/gi
  const trovate = TUTTE.flatMap(({ sql }) => [...sql.matchAll(re)].map((m) => m[0]))
  const ultima = trovate.at(-1)
  if (!ultima) throw new Error('current_parent_student_ids non si trova più nelle migrazioni')
  return ultima
}

let db: PGlite

async function comeRuolo<T>(ruolo: 'anon' | 'authenticated' | 'service_role', sub: string | null, sql: string): Promise<T[]> {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    sub ? JSON.stringify({ sub, role: ruolo }) : '',
  ])
  await db.exec(`SET ROLE ${ruolo}`)
  try {
    return (await db.query<T>(sql)).rows
  } finally {
    await db.exec('RESET ROLE')
  }
}

/** La lettura che faceva il componente, con gli stessi privilegi di chi la manda. */
const idLetti = (ruolo: 'anon' | 'authenticated' | 'service_role', sub: string | null) =>
  comeRuolo<{ id: string }>(ruolo, sub, 'SELECT id FROM public.alunni ORDER BY id').then((r) => r.map((x) => x.id))

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
      SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $f$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

    CREATE TABLE public.alunni (id uuid PRIMARY KEY, scuola_id uuid);
    CREATE TABLE public.parents (id uuid PRIMARY KEY, auth_user_id uuid);
    CREATE TABLE public.student_parents (student_id uuid NOT NULL, parent_id uuid NOT NULL);
    -- Come nel baseline: i privilegi di tabella sono aperti, a chiudere è solo la RLS.
    GRANT ALL ON public.alunni TO anon, authenticated, service_role;
    GRANT ALL ON public.parents, public.student_parents TO service_role;

    INSERT INTO public.alunni (id, scuola_id) VALUES
      ('${FIGLIO}', '${SEDE_A}'),
      ('${ALTRO_BAMBINO}', '${SEDE_A}'),
      ('${FIGLIO_DELLA_SEGRETERIA}', '${SEDE_A}'),
      ('${BAMBINO_SEDE_B}', '${SEDE_B}');
    INSERT INTO public.parents (id, auth_user_id) VALUES
      ('${GENITORE_RIGA}', '${GENITORE_AUTH}'),
      ('${GENITORE_SEGRETERIA_RIGA}', '${SEGRETERIA_ANCHE_GENITORE_AUTH}');
    INSERT INTO public.student_parents (student_id, parent_id) VALUES
      ('${FIGLIO}', '${GENITORE_RIGA}'),
      ('${FIGLIO_DELLA_SEGRETERIA}', '${GENITORE_SEGRETERIA_RIGA}');
  `)

  await db.exec(funzioneDeiFigli())
  await db.exec(`
    REVOKE ALL ON FUNCTION public.current_parent_student_ids() FROM PUBLIC;
    GRANT ALL ON FUNCTION public.current_parent_student_ids() TO authenticated;
    GRANT ALL ON FUNCTION public.current_parent_student_ids() TO service_role;
  `)
  // Nell'ordine delle migrazioni, com'è andata in produzione.
  for (const { testo } of ISTRUZIONI) await db.exec(testo)
})

afterAll(async () => {
  await db.close()
})

describe('RLS di `alunni`: che cosa vede chi legge dal browser', () => {
  it('le migrazioni hanno una policy sola su `alunni`, ed è quella dei figli del genitore', () => {
    const policy = ISTRUZIONI.filter((i) => /POLICY/i.test(i.testo)).map((i) => i.testo.replace(/\s+/g, ' '))
    expect(policy).toHaveLength(1)
    expect(policy[0]).toContain('"parent read alunni figli (parents space)"')
    expect(policy[0]).toContain('TO authenticated')
    expect(ISTRUZIONI.some((i) => /ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(i.testo))).toBe(true)
    expect(ISTRUZIONI.some((i) => /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(i.testo))).toBe(false)
  })

  it('il genitore legge il proprio figlio: i dati ci sono e la policy lavora', async () => {
    // Il controllo che regge la prova qui sotto: senza, «zero righe» direbbe anche
    // «`auth.uid()` è rotto» o «la tabella è vuota».
    expect(await idLetti('authenticated', GENITORE_AUTH)).toEqual([FIGLIO])
  })

  it('LA PROVA: uno staff che non è genitore, col ruolo `authenticated`, legge ZERO righe e nessun errore', async () => {
    expect(await idLetti('authenticated', SEGRETERIA_AUTH)).toEqual([])
  })

  it('uno staff che è anche genitore legge solo i propri figli: un file incompleto che sembra intero', async () => {
    expect(await idLetti('authenticated', SEGRETERIA_ANCHE_GENITORE_AUTH)).toEqual([FIGLIO_DELLA_SEGRETERIA])
  })

  it('senza sessione (ruolo `anon`) nessuna riga: nessuna policy parla di anon', async () => {
    expect(await idLetti('anon', null)).toEqual([])
  })

  it('con la service role si leggono tutte le sedi: per questo la route server deve filtrarle da sé', async () => {
    expect(await idLetti('service_role', null)).toHaveLength(4)
  })

  it('il rosso possibile: con una policy per lo staff la stessa lettura darebbe righe', async () => {
    // Dimostra che lo zero di sopra viene dalla policy e non dal test. Si annulla subito dopo.
    await db.exec(`BEGIN; CREATE POLICY prova_staff ON public.alunni FOR SELECT TO authenticated USING (true);`)
    try {
      expect(await idLetti('authenticated', SEGRETERIA_AUTH)).toHaveLength(4)
    } finally {
      await db.exec('ROLLBACK')
    }
    expect(await idLetti('authenticated', SEGRETERIA_AUTH)).toEqual([])
  })
})

describe('quale token parte davvero: le librerie vere, con una rete finta', () => {
  const URL_FINTO = 'https://finto.supabase.co'
  const COOKIE = 'sb-finto-auth-token'
  const TOKEN_UTENTE = 'token-finto-dell-utente'
  const CHIAVE = 'chiave-finta'

  /** Una sessione valida da qui in poi: la scadenza si calcola, così il test non scade col calendario. */
  const sessione = () => JSON.stringify({
    access_token: TOKEN_UTENTE,
    refresh_token: 'rinnovo-finto',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: SEGRETERIA_AUTH, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
  })

  function opzioni(cookie: { name: string; value: string }[], catturati: Headers[]) {
    return {
      global: {
        fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
          catturati.push(new Headers(init?.headers))
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
        },
      },
      cookies: { getAll: () => cookie, setAll: () => undefined },
    }
  }

  it('il client di browser con una sessione manda il token dell’utente: è la lettura di `ImportExportClient`', async () => {
    const catturati: Headers[] = []
    const client = createBrowserClient(URL_FINTO, CHIAVE, {
      ...opzioni([{ name: COOKIE, value: sessione() }], catturati),
      isSingleton: false,
    })
    await client.from('alunni').select('*')
    expect(catturati).toHaveLength(1)
    expect(catturati[0].get('authorization')).toBe(`Bearer ${TOKEN_UTENTE}`)
  })

  it('anche `createClient()` con la service role, se nel cookie c’è una sessione, manda il token dell’utente', async () => {
    // È la convinzione corretta dalla revisione del 08/11: la chiave resta in `apikey`, ma il ruolo
    // lo decide `Authorization`, quindi la RLS vale. Per questo le route admin usano `createAdminClient`.
    const catturati: Headers[] = []
    const client = createServerClient(URL_FINTO, CHIAVE, opzioni([{ name: COOKIE, value: sessione() }], catturati))
    await client.from('alunni').select('*')
    expect(catturati[0].get('authorization')).toBe(`Bearer ${TOKEN_UTENTE}`)
    expect(catturati[0].get('apikey')).toBe(CHIAVE)
  })

  it('senza cookie parte la chiave: è il caso di `createAdminClient`, che legge zero cookie', async () => {
    const catturati: Headers[] = []
    const client = createServerClient(URL_FINTO, CHIAVE, opzioni([], catturati))
    await client.from('alunni').select('*')
    expect(catturati[0].get('authorization')).toBe(`Bearer ${CHIAVE}`)
  })
})
