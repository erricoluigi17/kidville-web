// @vitest-environment node

/**
 * Le RPC del ciclo di vita degli intent video, provate sul file di migrazione VERO.
 *
 * Stesso impianto di `video-transitions.test.ts`: PGlite, i ruoli di Supabase
 * ricostruiti a mano, e le migrazioni lette **dal disco**. Leggerle dal disco non è
 * pigrizia: è l'unico modo perché questo test eserciti lo stesso testo SQL che verrà
 * applicato in produzione. Un test che ripete l'SQL dentro di sé prova la propria
 * copia, e resta verde il giorno in cui le due divergono.
 *
 * ⚠️ PGlite è a CONNESSIONE SINGOLA: due transazioni davvero simultanee qui non si
 * possono avere. Dove il piano chiede «un solo vincitore» si prova quindi la cosa che
 * il lock produce davvero — il perdente riparte DOPO che il vincitore ha committato e
 * trova lo stato nuovo — e si prova in ENTRAMBE le direzioni, perché un vincitore che
 * dipende dall'ordine non è un vincitore. Quello che questo impianto non può misurare
 * (che il secondo si metta in attesa invece di leggere una riga stantia) sta nel
 * `FOR UPDATE` sull'intent, preso per primo da tutte le RPC: è la proprietà che il
 * critico di V04 ha già fatto pagare due volte, ed è verificata qui sotto leggendo
 * l'ordine dei lock nel testo della migrazione.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const CARTELLA_MIGRAZIONI = join(process.cwd(), 'supabase/migrations')
const FILE_SCHEMA = '20260916190000_video_jobs.sql'
const FILE_TRANSIZIONI = '20260916190100_video_job_transitions.sql'
const FILE_INTENT = '20260916190200_video_intent_lifecycle.sql'

const SCHEMA = readFileSync(join(CARTELLA_MIGRAZIONI, FILE_SCHEMA), 'utf8')
const TRANSIZIONI = readFileSync(join(CARTELLA_MIGRAZIONI, FILE_TRANSIZIONI), 'utf8')
const INTENT = readFileSync(join(CARTELLA_MIGRAZIONI, FILE_INTENT), 'utf8')

const SEDE = '10000000-0000-4000-8000-000000000001'
const ALTRA_SEDE = '11000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const ALTRO_OWNER = '21000000-0000-4000-8000-000000000002'
const LEASE_A = '50000000-0000-4000-8000-000000000005'
const LEASE_B = '51000000-0000-4000-8000-000000000005'
const TARGET = '60000000-0000-4000-8000-000000000006'
const ALTRO_TARGET = '61000000-0000-4000-8000-000000000006'
const NUOVA_REVISIONE = '70000000-0000-4000-8000-000000000007'

/** Le nove funzioni che questa migrazione porta, nell'ordine in cui le dichiara. */
const RPC_NUOVE = [
  'video_intent_open',
  'video_intent_add_job',
  'video_intent_confirm',
  'video_intent_finalize',
  'video_intent_supersede',
  'video_intent_revoke',
  'video_outbox_claim',
  'video_outbox_sent',
  'video_outbox_fail',
] as const

type Intent = {
  id: string
  revision: number
  status: string
  target_id: string | null
  scuola_id: string | null
  published_at: string | null
}

type Job = {
  id: string
  status: string
  intent_id: string
  fence_epoch: number
  original_path: string
}

type Risposta = {
  ok: boolean
  code?: string
  intent?: Intent
  job?: Job
  eventi?: Record<string, unknown>[]
  evento?: Record<string, unknown>
  totale?: number
  pronti?: number
  job_cancellati?: number
}

let db: PGlite

async function rpc(sql: string): Promise<Risposta> {
  const risultato = await db.query<{ risultato: Risposta }>(`SELECT ${sql} AS risultato`)
  return risultato.rows[0].risultato
}

async function unaRiga<T>(sql: string): Promise<T> {
  const { rows } = await db.query<T>(sql)
  return rows[0]
}

async function preparaDatabase() {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL,
      public boolean NOT NULL DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[],
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.utenti (
      id uuid PRIMARY KEY REFERENCES auth.users(id),
      scuola_id uuid NOT NULL REFERENCES public.schools(id)
    );

    CREATE TABLE public.log_migrazioni (payload jsonb NOT NULL);
    CREATE FUNCTION public.app_log_registra(righe jsonb)
    RETURNS int
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO public.log_migrazioni(payload) VALUES (righe);
      RETURN 1;
    END $$;

    INSERT INTO public.schools(id) VALUES ('${SEDE}'), ('${ALTRA_SEDE}');
    INSERT INTO auth.users(id) VALUES ('${OWNER}'), ('${ALTRO_OWNER}');
    INSERT INTO public.utenti(id, scuola_id)
    VALUES ('${OWNER}', '${SEDE}'), ('${ALTRO_OWNER}', '${SEDE}');

    INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    VALUES
      ('gallery', 'gallery', false, 52428800, ARRAY['image/jpeg', 'video/mp4']),
      ('news', 'news', true, 52428800, ARRAY['image/jpeg', 'video/mp4']),
      ('news_bozze', 'news_bozze', false, 52428800, ARRAY['image/jpeg', 'video/mp4']);
  `)

  await db.exec(SCHEMA)
  await db.exec(TRANSIZIONI)
  await db.exec(INTENT)
}

/** Apre un intent News di sede con un job, e lo porta a `ready` + `confirmed`. */
async function intentPronto(chiave = 'video-1'): Promise<{ intent: Intent; job: Job }> {
  const aperto = await rpc(`public.video_intent_open(
    '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
    '${chiave}', '${OWNER}/${chiave}/source', NULL, NULL
  )`)
  const intent = aperto.intent as Intent
  const job = aperto.job as Job
  await rpc(`public.video_job_uploaded('${job.id}', '${OWNER}', 1000, 'video/quicktime')`)
  await rpc(`public.video_job_claim('${job.id}', '${LEASE_A}', 300)`)
  await rpc(`public.video_job_ready(
    '${job.id}', 1, '${LEASE_A}', 'outputs/${job.id}/final.mp4', 900,
    '{"durationSeconds":12}'::jsonb
  )`)
  await rpc(`public.video_intent_confirm('${intent.id}', '${OWNER}', 1)`)
  return { intent, job }
}

describe('RPC ciclo di vita degli intent video', () => {
  // Il database si costruisce SOLO per questo gruppo. I due gruppi in fondo leggono
  // il testo della migrazione e devono restare in piedi anche quando il bootstrap
  // esplode: è proprio il caso in cui hanno qualcosa da dire — una `CREATE POLICY`
  // su una tabella che qui non esiste fa fallire `db.exec`, e con un `beforeEach`
  // comune il rosso utile finirebbe sepolto sotto diciassette rossi inutili.
  //
  // Il timeout esplicito non è scaramanzia. `vitest.config.ts` fissa
  // `testTimeout: 20000` ma NON `hookTimeout`, che resta al default di 10 secondi: e
  // questo hook costruisce un PGlite da zero e ci applica tre migrazioni (oltre 100 KB
  // di SQL) a OGNI test, venticinque volte. A macchina scarica sono ~400 ms per giro;
  // misurato con load average 18 — un'altra suite pesante in parallelo — lo stesso
  // hook ha sfondato i 10 secondi e ha tinto di rosso un test che non c'entrava
  // niente. Un tetto generoso non costa nulla quando l'hook non si pianta: si paga
  // solo se si pianta davvero, ed è allora che lo si vuole vedere fallire.
  beforeEach(async () => {
    db = new PGlite()
    await preparaDatabase()
  }, 60_000)

  afterEach(async () => {
    await db.close()
  })

  it('sono SECURITY DEFINER, con search_path chiuso ed eseguibili dal solo service role', async () => {
    const catalogo = await db.query<{
      nome: string
      security_definer: boolean
      configurazione: string[]
    }>(`
      SELECT p.proname AS nome,
             p.prosecdef AS security_definer,
             p.proconfig AS configurazione
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = ANY(ARRAY[${RPC_NUOVE.map((n) => `'${n}'`).join(', ')}])
      ORDER BY p.proname
    `)

    expect(
      catalogo.rows.map((r) => r.nome),
      'La migrazione non dichiara tutte le RPC attese, o ne dichiara due con lo stesso nome.',
    ).toEqual([...RPC_NUOVE].sort())

    for (const funzione of catalogo.rows) {
      expect(funzione.security_definer, `${funzione.nome} non è SECURITY DEFINER`).toBe(true)
      expect(
        funzione.configurazione,
        `${funzione.nome} non fissa search_path: risolverebbe i nomi con quello del chiamante`,
      ).toContain('search_path=pg_catalog')

      const permessi = await unaRiga<{ servizio: boolean; anonimo: boolean; autenticato: boolean }>(`
        SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AS servizio,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anonimo,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS autenticato
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '${funzione.nome}'
      `)
      expect(permessi.servizio, `${funzione.nome} non è eseguibile dal service role`).toBe(true)
      // Una SECURITY DEFINER raggiungibile da `anon` è una porta aperta su
      // `/rest/v1/rpc/<fn>` con la sola chiave pubblica. È la regressione delle RPC
      // mensa del 2026-07-18, e il lock `security-definer-revoke-lock` la sorveglia
      // sul testo: qui si misura il privilegio davvero concesso.
      expect(permessi.anonimo, `${funzione.nome} è eseguibile da anon`).toBe(false)
      expect(permessi.autenticato, `${funzione.nome} è eseguibile da authenticated`).toBe(false)
    }
  })

  it('apre intent e primo job, ed è idempotente sulla chiave del client', async () => {
    const prima = await rpc(`public.video_intent_open(
      '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
      'chiave-1', '${OWNER}/chiave-1/source', NULL, NULL
    )`)
    expect(prima).toMatchObject({
      ok: true,
      intent: { status: 'pending', revision: 1 },
      job: { status: 'awaiting_upload' },
    })

    const seconda = await rpc(`public.video_intent_open(
      '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
      'chiave-1', '${OWNER}/chiave-1/source', NULL, NULL
    )`)
    expect(seconda.ok).toBe(true)
    expect(seconda.job?.id).toBe(prima.job?.id)
    expect(seconda.intent?.id).toBe(prima.intent?.id)

    // Un solo intent e un solo job: il ritentativo non ha aperto niente.
    expect(
      await unaRiga<{ intenti: number; job: number }>(`
        SELECT (SELECT count(*) FROM public.video_intents)::int AS intenti,
               (SELECT count(*) FROM public.video_jobs)::int AS job
      `),
    ).toEqual({ intenti: 1, job: 1 })

    // Stessa chiave, altro originale: non è un ritentativo, è un errore.
    expect(
      await rpc(`public.video_intent_open(
        '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
        'chiave-1', '${OWNER}/chiave-1/altro', NULL, NULL
      )`),
    ).toEqual({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('rifiuta un originale fuori dalla cartella del proprietario e uno scope senza sede', async () => {
    // Il prefisso è ciò con cui l'oblio GDPR trova i file di una persona: un
    // originale archiviato altrove è un video di un minore che nessuna procedura
    // di cancellazione sa più raggiungere.
    expect(
      await rpc(`public.video_intent_open(
        '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
        'fuori', 'originals/fuori/source', NULL, NULL
      )`),
    ).toEqual({ ok: false, code: 'ORIGINAL_PATH_SCOPE' })
    // Anche il prefisso di un ALTRO utente è fuori: `LIKE '<uuid>/%'` e non un
    // semplice «contiene l'uuid».
    expect(
      await rpc(`public.video_intent_open(
        '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
        'altrui', '${ALTRO_OWNER}/${OWNER}/source', NULL, NULL
      )`),
    ).toEqual({ ok: false, code: 'ORIGINAL_PATH_SCOPE' })

    // Sede assente senza scope globale dichiarato: rifiutato con un codice, non
    // con il 23514 grezzo del CHECK.
    expect(
      await rpc(`public.video_intent_open(
        '${OWNER}', NULL, 'news', 'publish', '{}'::jsonb,
        'globale', '${OWNER}/globale/source', NULL, NULL
      )`),
    ).toEqual({ ok: false, code: 'SCOPE_REQUIRED' })
    expect(
      await rpc(`public.video_intent_open(
        '${OWNER}', NULL, 'gallery', 'publish', '{"scope":"global"}'::jsonb,
        'galleria-globale', '${OWNER}/galleria-globale/source', NULL, NULL
      )`),
    ).toEqual({ ok: false, code: 'SCOPE_REQUIRED' })

    // La News globale dichiarata passa, ed è l'unico caso.
    const globale = await rpc(`public.video_intent_open(
      '${OWNER}', NULL, 'news', 'publish', '{"scope":"global"}'::jsonb,
      'globale-ok', '${OWNER}/globale-ok/source', NULL, NULL
    )`)
    expect(globale).toMatchObject({ ok: true, intent: { scuola_id: null } })
  })

  it('pubblica solo un intent confermato, e solo quando TUTTI i job sono verificati', async () => {
    const { intent, job } = await intentPronto()

    const secondo = await rpc(`public.video_intent_add_job(
      '${intent.id}', '${OWNER}', 1, 'video-2', '${OWNER}/video-2/source'
    )`)
    expect(secondo, "add_job dopo la conferma cambierebbe ciò che l'utente ha confermato")
      .toEqual({ ok: false, code: 'INVALID_STATE' })

    // Lo stesso intent, ma con il secondo job aggiunto PRIMA della conferma.
    const aperto = await rpc(`public.video_intent_open(
      '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
      'multi-1', '${OWNER}/multi-1/source', NULL, NULL
    )`)
    const multi = aperto.intent as Intent
    const job1 = aperto.job as Job
    const aggiunto = await rpc(`public.video_intent_add_job(
      '${multi.id}', '${OWNER}', 1, 'multi-2', '${OWNER}/multi-2/source'
    )`)
    const job2 = aggiunto.job as Job
    expect(aggiunto.ok).toBe(true)

    for (const j of [job1, job2]) {
      await rpc(`public.video_job_uploaded('${j.id}', '${OWNER}', 1000, 'video/mp4')`)
      await rpc(`public.video_job_claim('${j.id}', '${LEASE_A}', 300)`)
    }
    await rpc(`public.video_job_ready(
      '${job1.id}', 1, '${LEASE_A}', 'outputs/${job1.id}/final.mp4', 900,
      '{"durationSeconds":12}'::jsonb
    )`)
    await rpc(`public.video_intent_confirm('${multi.id}', '${OWNER}', 1)`)

    // Uno pronto su due: non si pubblica, e la risposta dice il conto.
    const parziale = await rpc(`public.video_intent_finalize(
      '${multi.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
    )`)
    expect(parziale).toMatchObject({ ok: false, code: 'JOBS_NOT_READY', totale: 2, pronti: 1 })

    await rpc(`public.video_job_ready(
      '${job2.id}', 1, '${LEASE_A}', 'outputs/${job2.id}/final.mp4', 900,
      '{"durationSeconds":9}'::jsonb
    )`)
    const completo = await rpc(`public.video_intent_finalize(
      '${multi.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
    )`)
    expect(completo).toMatchObject({
      ok: true,
      intent: { status: 'published', target_id: TARGET },
    })

    // E un intent mai confermato non pubblica nemmeno con il job pronto.
    void job
    const nonConfermato = await rpc(`public.video_intent_open(
      '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
      'senza-conferma', '${OWNER}/senza-conferma/source', NULL, NULL
    )`)
    expect(
      await rpc(`public.video_intent_finalize(
        '${nonConfermato.intent?.id}', '${OWNER}', 1, '${SEDE}', 'news',
        '${ALTRO_TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'NOT_CONFIRMED' })
  })

  it("non pubblica un job in stato ready senza `verified_at`: lo stato senza la prova non basta", async () => {
    const { intent, job } = await intentPronto()
    // Si toglie SOLO la data di verifica, lasciando lo stato `ready`. È lo scenario
    // di una riga riportata a mano o migrata da un formato precedente.
    await db.exec(`
      ALTER TABLE public.video_jobs DROP CONSTRAINT video_jobs_ready_chk;
      ALTER TABLE public.video_jobs DROP CONSTRAINT video_jobs_original_ttl_chk;
      UPDATE public.video_jobs SET verified_at = NULL WHERE id = '${job.id}';
    `)
    expect(
      await rpc(`public.video_intent_finalize(
        '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toMatchObject({ ok: false, code: 'JOBS_NOT_READY', totale: 1, pronti: 0 })
  })

  it('rifiuta lo scope cambiato sotto le mani, in entrambi i versi del confronto NULL', async () => {
    const { intent } = await intentPronto()

    // Sede diversa da quella con cui i permessi erano stati valutati.
    expect(
      await rpc(`public.video_intent_finalize(
        '${intent.id}', '${OWNER}', 1, '${ALTRA_SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'SCOPE_CHANGED' })

    // Nessuna sede su un intent che ne ha una: è il verso in cui un confronto
    // scritto `<>` restituirebbe NULL e lascerebbe passare.
    expect(
      await rpc(`public.video_intent_finalize(
        '${intent.id}', '${OWNER}', 1, NULL, 'news', '${TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'SCOPE_CHANGED' })

    // Canale diverso.
    expect(
      await rpc(`public.video_intent_finalize(
        '${intent.id}', '${OWNER}', 1, '${SEDE}', 'gallery', '${TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'SCOPE_CHANGED' })

    // Revisione diversa, e proprietario diverso.
    expect(
      await rpc(`public.video_intent_finalize(
        '${intent.id}', '${OWNER}', 2, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'REVISION_MISMATCH' })
    expect(
      await rpc(`public.video_intent_finalize(
        '${intent.id}', '${ALTRO_OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'OWNER_MISMATCH' })

    // E la sede globale NULL su un intent globale passa: `IS NOT DISTINCT FROM`
    // deve riconoscere NULL come uguale a NULL, non rifiutare tutto per prudenza.
    const globale = await rpc(`public.video_intent_open(
      '${OWNER}', NULL, 'news', 'publish', '{"scope":"global"}'::jsonb,
      'g-1', '${OWNER}/g-1/source', NULL, NULL
    )`)
    const jobGlobale = globale.job as Job
    await rpc(`public.video_job_uploaded('${jobGlobale.id}', '${OWNER}', 1000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${jobGlobale.id}', '${LEASE_A}', 300)`)
    await rpc(`public.video_job_ready(
      '${jobGlobale.id}', 1, '${LEASE_A}', 'outputs/${jobGlobale.id}/final.mp4', 900,
      '{"durationSeconds":5}'::jsonb
    )`)
    await rpc(`public.video_intent_confirm('${globale.intent?.id}', '${OWNER}', 1)`)
    expect(
      await rpc(`public.video_intent_finalize(
        '${globale.intent?.id}', '${OWNER}', 1, NULL, 'news', '${ALTRO_TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toMatchObject({ ok: true, intent: { status: 'published' } })
  })

  it('un secondo finalize identico ritorna lo stesso target e NON accoda un secondo evento', async () => {
    const { intent } = await intentPronto()

    const prima = await rpc(`public.video_intent_finalize(
      '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published',
      '{"job":1}'::jsonb
    )`)
    const seconda = await rpc(`public.video_intent_finalize(
      '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published',
      '{"job":1}'::jsonb
    )`)

    expect(prima).toMatchObject({ ok: true, intent: { status: 'published', target_id: TARGET } })
    expect(seconda).toMatchObject({ ok: true, intent: { status: 'published', target_id: TARGET } })
    // `published_at` non è stato riscritto: il secondo giro non ha toccato niente.
    expect(seconda.intent?.published_at).toBe(prima.intent?.published_at)

    expect(
      await unaRiga<{ eventi: number }>(`
        SELECT count(*)::int AS eventi FROM public.video_outbox
        WHERE intent_id = '${intent.id}' AND event_type = 'news.published'
      `),
    ).toEqual({ eventi: 1 })

    // Lo stesso intent con un target DIVERSO non è un ritentativo: è un difetto, e
    // restituire in silenzio il vecchio target lo nasconderebbe.
    expect(
      await rpc(`public.video_intent_finalize(
        '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${ALTRO_TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'TARGET_CONFLICT' })
  })

  it('pubblicazione e ritiro hanno UN SOLO vincitore, in tutti e due gli ordini', async () => {
    // Direzione 1 — pubblica, poi prova a cancellare.
    const a = await intentPronto('a-1')
    expect(
      await rpc(`public.video_intent_finalize(
        '${a.intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toMatchObject({ ok: true, intent: { status: 'published' } })
    expect(await rpc(`public.video_job_cancel('${a.job.id}', '${OWNER}')`))
      .toEqual({ ok: false, code: 'INTENT_PUBLISHED' })
    expect(await rpc(`public.video_intent_revoke('${a.intent.id}', '${OWNER}', 1)`))
      .toEqual({ ok: false, code: 'INTENT_PUBLISHED' })
    expect(
      await unaRiga<{ status: string }>(
        `SELECT status FROM public.video_intents WHERE id = '${a.intent.id}'`,
      ),
    ).toEqual({ status: 'published' })

    // Direzione 2 — cancella, poi prova a pubblicare.
    const b = await intentPronto('b-1')
    expect(await rpc(`public.video_job_cancel('${b.job.id}', '${OWNER}')`))
      .toMatchObject({ ok: true, job: { status: 'cancelled' } })
    expect(
      await rpc(`public.video_intent_finalize(
        '${b.intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${ALTRO_TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'INTENT_REVOKED' })
    expect(
      await unaRiga<{ status: string; eventi: number }>(`
        SELECT i.status,
               (SELECT count(*)::int FROM public.video_outbox o
                 WHERE o.intent_id = i.id AND o.event_type = 'news.published') AS eventi
        FROM public.video_intents i WHERE i.id = '${b.intent.id}'
      `),
    ).toEqual({ status: 'cancelled', eventi: 0 })
  })

  it('il ritiro spegne i job, alza il fence e accoda un evento per la retention', async () => {
    const aperto = await rpc(`public.video_intent_open(
      '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
      'r-1', '${OWNER}/r-1/source', NULL, NULL
    )`)
    const intent = aperto.intent as Intent
    const job = aperto.job as Job
    await rpc(`public.video_job_uploaded('${job.id}', '${OWNER}', 1000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${job.id}', '${LEASE_A}', 300)`)

    const ritirato = await rpc(`public.video_intent_revoke('${intent.id}', '${OWNER}', 1)`)
    expect(ritirato).toMatchObject({
      ok: true,
      intent: { status: 'cancelled' },
      job_cancellati: 1,
    })

    // Il worker che stava lavorando non può più chiudere: il fence è cambiato.
    expect(
      await rpc(`public.video_job_ready(
        '${job.id}', 1, '${LEASE_A}', 'outputs/${job.id}/final.mp4', 900,
        '{"durationSeconds":12}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'FENCE_MISMATCH' })

    expect(
      await unaRiga<{ status: string; fence_epoch: number; scaduto: boolean }>(`
        SELECT status, fence_epoch::int, original_delete_after <= transaction_timestamp() AS scaduto
        FROM public.video_jobs WHERE id = '${job.id}'
      `),
    ).toEqual({ status: 'cancelled', fence_epoch: 2, scaduto: true })

    expect(
      await unaRiga<{ tipo: string; payload: Record<string, unknown> }>(`
        SELECT event_type AS tipo, payload FROM public.video_outbox
        WHERE intent_id = '${intent.id}'
      `),
    ).toEqual({ tipo: 'intent.revoked', payload: { job_cancellati: 1 } })

    // Ripetuto è idempotente, e non accoda un secondo evento.
    expect(await rpc(`public.video_intent_revoke('${intent.id}', '${OWNER}', 1)`))
      .toMatchObject({ ok: true, intent: { status: 'cancelled' } })
    expect(
      await unaRiga<{ eventi: number }>(
        `SELECT count(*)::int AS eventi FROM public.video_outbox WHERE intent_id = '${intent.id}'`,
      ),
    ).toEqual({ eventi: 1 })
  })

  it('la revisione nuova nasce come intent nuovo, perché in posto è VIETATA', async () => {
    const { intent } = await intentPronto('s-1')
    await rpc(`public.video_intent_finalize(
      '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
    )`)

    // Incrementare `revision` in posto è quello che il trigger dello schema vieta:
    // `video_outbox` la referenzia, e cambiarla sotto la coda farebbe raccontare a
    // un evento già accodato una revisione che non esiste più.
    await expect(
      db.exec(`UPDATE public.video_intents SET revision = 2 WHERE id = '${intent.id}'`),
    ).rejects.toThrow(/video_intents_revision_immutabile/)

    const superato = await rpc(`public.video_intent_supersede(
      '${intent.id}', '${OWNER}', 1, '${NUOVA_REVISIONE}', NULL, NULL, NULL
    )`)
    expect(superato).toMatchObject({
      ok: true,
      intent: { id: NUOVA_REVISIONE, revision: 2, status: 'pending', target_id: TARGET },
    })
    expect(
      await unaRiga<{ status: string; revocato: boolean; pubblicato: boolean }>(`
        SELECT status, revoked_at IS NOT NULL AS revocato, published_at IS NOT NULL AS pubblicato
        FROM public.video_intents WHERE id = '${intent.id}'
      `),
    ).toEqual({ status: 'superseded', revocato: true, pubblicato: true })

    // Ripetuta con lo STESSO uuid è idempotente: non nasce una terza revisione.
    const ripetuto = await rpc(`public.video_intent_supersede(
      '${intent.id}', '${OWNER}', 1, '${NUOVA_REVISIONE}', NULL, NULL, NULL
    )`)
    expect(ripetuto).toMatchObject({ ok: true, intent: { id: NUOVA_REVISIONE, revision: 2 } })
    expect(
      await unaRiga<{ intenti: number }>(
        `SELECT count(*)::int AS intenti FROM public.video_intents`,
      ),
    ).toEqual({ intenti: 2 })

    // La revisione superata ha lasciato il proprio evento per la retention.
    expect(
      await unaRiga<{ tipi: string[] }>(`
        SELECT array_agg(event_type ORDER BY event_type) AS tipi FROM public.video_outbox
        WHERE intent_id = '${intent.id}'
      `),
    ).toEqual({ tipi: ['intent.superseded', 'news.published'] })

    // E la revisione superata non pubblica più niente.
    expect(
      await rpc(`public.video_intent_finalize(
        '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${ALTRO_TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'INTENT_REVOKED' })
  })

  it('un intent già ritirato non si supera, e uno già pubblicato non si ritira', async () => {
    const a = await intentPronto('x-1')
    await rpc(`public.video_intent_revoke('${a.intent.id}', '${OWNER}', 1)`)
    expect(
      await rpc(`public.video_intent_supersede(
        '${a.intent.id}', '${OWNER}', 1, '${NUOVA_REVISIONE}', NULL, NULL, NULL
      )`),
    ).toEqual({ ok: false, code: 'INTENT_REVOKED' })

    // Il ramo `cancelled` del CHECK dello schema pretende `published_at IS NULL`:
    // ritirare qualcosa di pubblicato fallirebbe con un 23514 anonimo, quindi la
    // RPC lo dice prima, e indica la strada giusta (supersede).
    const b = await intentPronto('x-2')
    await rpc(`public.video_intent_finalize(
      '${b.intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
    )`)
    expect(await rpc(`public.video_intent_revoke('${b.intent.id}', '${OWNER}', 1)`))
      .toEqual({ ok: false, code: 'INTENT_PUBLISHED' })
  })

  it("lo scrittore dell'outbox prende, consegna, fallisce — e non prende due volte lo stesso", async () => {
    const { intent } = await intentPronto('o-1')
    await rpc(`public.video_intent_finalize(
      '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
    )`)

    const preso = await rpc(`public.video_outbox_claim('${LEASE_A}', 60, 10)`)
    expect(preso.ok).toBe(true)
    expect(preso.eventi).toHaveLength(1)
    const evento = preso.eventi?.[0] as { id: string; attempts: number; event_type: string }
    expect(evento.attempts).toBe(1)
    expect(evento.event_type).toBe('news.published')

    // Con la lease ancora valida un secondo worker non lo ripesca.
    expect(await rpc(`public.video_outbox_claim('${LEASE_B}', 60, 10)`))
      .toMatchObject({ ok: true, eventi: [] })

    // Una lease che non è tua non chiude l'evento.
    expect(await rpc(`public.video_outbox_sent('${evento.id}', '${LEASE_B}')`))
      .toEqual({ ok: false, code: 'LEASE_MISMATCH' })

    // Fallire NON rilascia la lease: la sposta avanti di un'attesa crescente, e
    // lascia il contatore dove sta. La lease è l'unico ritardo che questo schema
    // possiede — `video_outbox` non ha nessuna colonna di backoff — quindi
    // rilasciarla, come faceva la prima stesura, significava non aspettare affatto.
    expect(await rpc(`public.video_outbox_fail('${evento.id}', '${LEASE_A}', 'TARGET_MANCANTE')`))
      .toMatchObject({ ok: true, attesa_secondi: 5 })
    expect(
      await rpc(`public.video_outbox_claim('${LEASE_B}', 60, 10)`),
      "Un evento appena fallito è tornato subito prendibile: l'attesa non esiste.",
    ).toMatchObject({ ok: true, eventi: [] })

    // Passata l'attesa, l'evento torna in coda e il contatore è avanzato. Si sposta
    // la scadenza invece di dormire: un test che aspetta cinque secondi veri è un
    // test che qualcuno disattiverà.
    await db.exec(`
      UPDATE public.video_outbox SET lease_expires_at = now() - interval '1 second'
      WHERE id = '${evento.id}'
    `)
    const riprovato = await rpc(`public.video_outbox_claim('${LEASE_B}', 60, 10)`)
    expect(riprovato.eventi).toHaveLength(1)
    expect((riprovato.eventi?.[0] as { attempts: number }).attempts).toBe(2)

    expect(await rpc(`public.video_outbox_sent('${evento.id}', '${LEASE_B}')`))
      .toMatchObject({ ok: true, evento: { event_type: 'news.published' } })
    // Consegnato una volta, consegnato per sempre: il claim non lo rivede più.
    expect(await rpc(`public.video_outbox_claim('${LEASE_A}', 60, 10)`))
      .toMatchObject({ ok: true, eventi: [] })
    expect(await rpc(`public.video_outbox_fail('${evento.id}', '${LEASE_B}', 'TARDIVO')`))
      .toEqual({ ok: false, code: 'ALREADY_SENT' })
  })

  it("l'evento in quarantena a 25 tentativi non viene più ripescato", async () => {
    // Il tetto è quello di `video_outbox_attempts_chk`: senza il filtro
    // `attempts < 25` il claim farebbe fallire il proprio UPDATE con un 23514,
    // cioè trasformerebbe una quarantena in un guasto della coda.
    const { intent } = await intentPronto('q-1')
    await rpc(`public.video_intent_finalize(
      '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
    )`)
    await db.exec(`UPDATE public.video_outbox SET attempts = 25 WHERE intent_id = '${intent.id}'`)
    expect(await rpc(`public.video_outbox_claim('${LEASE_A}', 60, 10)`))
      .toMatchObject({ ok: true, eventi: [] })
  })

  it('un worker che ridrena la coda NON brucia i 25 tentativi in un giro solo', async () => {
    // Regressione misurata prima della correzione: con la lease RILASCIATA al
    // fallimento, un solo evento perdeva tutti e 25 i tentativi in 16 millisecondi —
    // con una lease dichiarata di 600 secondi — e finiva in quarantena permanente.
    // L'evento bruciato è quello di `finalize`, cioè l'unica riga che dice «aggancia
    // questo video alla sua News»: un 5xx di passaggio, e il video non veniva
    // agganciato mai più, senza che nulla riprovasse.
    const { intent } = await intentPronto('backoff-1')
    await rpc(`public.video_intent_finalize(
      '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
    )`)

    let giri = 0
    for (let n = 0; n < 40; n += 1) {
      const preso = await rpc(`public.video_outbox_claim('${LEASE_A}', 600, 10)`)
      const eventi = preso.eventi ?? []
      if (eventi.length === 0) break
      giri += 1
      await rpc(`public.video_outbox_fail(
        '${(eventi[0] as { id: string }).id}', '${LEASE_A}', 'GUASTO_DI_PASSAGGIO'
      )`)
    }
    expect(
      giri,
      'Il drenaggio stretto ha ripreso lo stesso evento più di una volta: la lease ' +
        'non lo trattiene, e i 25 tentativi si consumano senza che passi tempo.',
    ).toBe(1)
    expect(
      await unaRiga<{ attempts: number }>(
        `SELECT attempts FROM public.video_outbox WHERE intent_id = '${intent.id}'`,
      ),
    ).toEqual({ attempts: 1 })

    // L'attesa raddoppia e si ferma a 900 secondi: 25 tentativi coprono così circa
    // quattro ore e mezza, cioè un rilascio andato male o una rete che torna. Un
    // tetto senza fine farebbe aspettare giorni un evento che non arriverà mai.
    await db.exec(`
      UPDATE public.video_outbox
      SET attempts = 20, lease_expires_at = now() - interval '1 hour'
      WHERE intent_id = '${intent.id}'
    `)
    const tardi = await rpc(`public.video_outbox_claim('${LEASE_A}', 600, 10)`)
    expect(tardi.eventi).toHaveLength(1)
    expect(
      await rpc(`public.video_outbox_fail(
        '${(tardi.eventi?.[0] as { id: string }).id}', '${LEASE_A}', 'GUASTO_DI_PASSAGGIO'
      )`),
    ).toMatchObject({ ok: true, attesa_secondi: 900 })
  })

  it('la revisione superata spegne i job non conclusi, e lascia stare quelli pronti', async () => {
    // Regressione: `supersede` non toccava i job, a differenza di `revoke`. Costava
    // due cose, misurate — un worker con la lease in corso chiudeva comunque il job e
    // produceva l'output di una revisione che nessuno pubblicherà; e un job non
    // concluso restava con `original_delete_after` NULL, cioè invisibile a
    // `video_jobs_retention_originali_idx`: l'originale, il video di un minore in un
    // bucket privato, senza nessuna data di cancellazione, per sempre.
    const aperto = await rpc(`public.video_intent_open(
      '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
      'sup-vivo', '${OWNER}/sup-vivo/source', NULL, NULL
    )`)
    const intent = aperto.intent as Intent
    const inCorso = aperto.job as Job
    // Un secondo job dello stesso intent, portato fino a `ready`: è quello che NON va
    // toccato, perché ha già la sua scadenza esatta e — se l'intent è pubblicato — è
    // il video che le famiglie stanno guardando.
    const secondo = (
      await rpc(`public.video_intent_add_job(
        '${intent.id}', '${OWNER}', 1, 'sup-pronto', '${OWNER}/sup-pronto/source'
      )`)
    ).job as Job
    for (const j of [inCorso, secondo]) {
      await rpc(`public.video_job_uploaded('${j.id}', '${OWNER}', 1000, 'video/mp4')`)
      await rpc(`public.video_job_claim('${j.id}', '${LEASE_A}', 300)`)
    }
    await rpc(`public.video_job_ready(
      '${secondo.id}', 1, '${LEASE_A}', 'outputs/${secondo.id}/final.mp4', 900,
      '{"durationSeconds":7}'::jsonb
    )`)
    const scadenzaPronto = await unaRiga<{ quando: string }>(
      `SELECT original_delete_after AS quando FROM public.video_jobs WHERE id = '${secondo.id}'`,
    )

    const superato = await rpc(`public.video_intent_supersede(
      '${intent.id}', '${OWNER}', 1, '${NUOVA_REVISIONE}', NULL, NULL, NULL
    )`)
    expect(superato).toMatchObject({ ok: true, job_spenti: 1 })

    // Il job in corso è spento, il fence è salito e l'originale ha una scadenza.
    expect(
      await unaRiga<{ status: string; fence_epoch: number; scaduto: boolean }>(`
        SELECT status, fence_epoch::int,
               original_delete_after <= transaction_timestamp() AS scaduto
        FROM public.video_jobs WHERE id = '${inCorso.id}'
      `),
    ).toEqual({ status: 'cancelled', fence_epoch: 2, scaduto: true })

    // Ed è ciò che rende l'originale visibile alla retention: senza
    // `original_delete_after` quell'indice parziale non lo vede affatto.
    expect(
      await unaRiga<{ visibili: number }>(`
        SELECT count(*)::int AS visibili FROM public.video_jobs
        WHERE intent_id = '${intent.id}'
          AND original_deleted_at IS NULL AND original_delete_after IS NOT NULL
      `),
    ).toEqual({ visibili: 2 })

    // Il worker che stava transcodificando non può più chiudere il proprio job.
    expect(
      await rpc(`public.video_job_ready(
        '${inCorso.id}', 1, '${LEASE_A}', 'outputs/${inCorso.id}/final.mp4', 900,
        '{"durationSeconds":11}'::jsonb
      )`),
    ).toEqual({ ok: false, code: 'FENCE_MISMATCH' })

    // Il job già `ready` è rimasto intatto, scadenza compresa.
    expect(
      await unaRiga<{ status: string; quando: string }>(
        `SELECT status, original_delete_after AS quando FROM public.video_jobs WHERE id = '${secondo.id}'`,
      ),
    ).toEqual({ status: 'ready', quando: scadenzaPronto.quando })
  })

  it('una revisione di Galleria riceve il proprio primo video: il vincolo è sul CONTEGGIO', async () => {
    // Regressione: il guard di `add_job` era scritto sul CANALE e rifiutava un intent
    // `gallery` anche con ZERO job. Siccome `supersede` crea un intent nuovo e VUOTO,
    // una revisione di Galleria non poteva mai ricevere il proprio video e `finalize`
    // rispondeva per sempre `NO_JOBS`: metà dei canali non era revisionabile. Il
    // vincolo vero dello schema è `video_jobs_gallery_intent_unico_idx ON
    // video_jobs(intent_id) WHERE channel = 'gallery'`, che vieta il SECONDO job.
    const aperto = await rpc(`public.video_intent_open(
      '${OWNER}', '${SEDE}', 'gallery', 'publish', '{}'::jsonb,
      'gal-1', '${OWNER}/gal-1/source', '${TARGET}', NULL
    )`)
    const intent = aperto.intent as Intent
    const job = aperto.job as Job
    await rpc(`public.video_job_uploaded('${job.id}', '${OWNER}', 1000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${job.id}', '${LEASE_A}', 300)`)
    await rpc(`public.video_job_ready(
      '${job.id}', 1, '${LEASE_A}', 'outputs/${job.id}/final.mp4', 900,
      '{"durationSeconds":8}'::jsonb
    )`)
    await rpc(`public.video_intent_confirm('${intent.id}', '${OWNER}', 1)`)
    await rpc(`public.video_intent_finalize(
      '${intent.id}', '${OWNER}', 1, '${SEDE}', 'gallery', '${TARGET}', 'gallery.published', '{}'::jsonb
    )`)

    const superato = await rpc(`public.video_intent_supersede(
      '${intent.id}', '${OWNER}', 1, '${NUOVA_REVISIONE}', NULL, NULL, NULL
    )`)
    expect(superato).toMatchObject({ ok: true, intent: { revision: 2, status: 'pending' } })

    const primo = await rpc(`public.video_intent_add_job(
      '${NUOVA_REVISIONE}', '${OWNER}', 2, 'gal-2', '${OWNER}/gal-2/source'
    )`)
    expect(primo, 'La revisione nuova di una Galleria non riesce a ricevere il proprio video.')
      .toMatchObject({ ok: true, job: { status: 'awaiting_upload' } })

    // Ripetuto con la stessa chiave resta idempotente: è lo stesso job, non un errore.
    const ripetuto = await rpc(`public.video_intent_add_job(
      '${NUOVA_REVISIONE}', '${OWNER}', 2, 'gal-2', '${OWNER}/gal-2/source'
    )`)
    expect(ripetuto).toMatchObject({ ok: true, job: { id: primo.job?.id } })

    // Il SECONDO video, quello, resta vietato — ed è ciò che l'indice dice davvero.
    expect(
      await rpc(`public.video_intent_add_job(
        '${NUOVA_REVISIONE}', '${OWNER}', 2, 'gal-3', '${OWNER}/gal-3/source'
      )`),
    ).toEqual({ ok: false, code: 'SINGLE_JOB_CHANNEL' })
    expect(
      await unaRiga<{ job: number }>(
        `SELECT count(*)::int AS job FROM public.video_jobs WHERE intent_id = '${NUOVA_REVISIONE}'`,
      ),
    ).toEqual({ job: 1 })
  })

  it("il codice di conflitto lo decide l'indice che ha rifiutato, non una deduzione", async () => {
    // Regressione: il gestore `unique_violation` DEDUCEVA quale indice era scattato
    // («se la chiave di idempotenza non c'è, allora era l'originale»), e la deduzione
    // copriva due indici su tre. Un conflitto sul TARGET usciva come
    // `ORIGINAL_PATH_TAKEN`: una route che lo traducesse direbbe all'utente di
    // scegliere un altro file mentre il file è libero.
    await rpc(`public.video_intent_open(
      '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
      'c-1', '${OWNER}/c-1/source', '${TARGET}', NULL
    )`)

    // Stesso target, chiave e originale DIVERSI: il percorso non c'entra niente.
    expect(
      await rpc(`public.video_intent_open(
        '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
        'c-2', '${OWNER}/c-2/source', '${TARGET}', NULL
      )`),
    ).toEqual({ ok: false, code: 'TARGET_CONFLICT' })
    expect(
      await unaRiga<{ job: number }>(
        `SELECT count(*)::int AS job FROM public.video_jobs WHERE original_path = '${OWNER}/c-2/source'`,
      ),
      'Il percorso era libero: chiamarlo «occupato» manda la route a chiedere la cosa sbagliata.',
    ).toEqual({ job: 0 })

    // E l'originale davvero occupato continua a dirlo, con il suo codice.
    expect(
      await rpc(`public.video_intent_open(
        '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
        'c-3', '${OWNER}/c-1/source', NULL, NULL
      )`),
    ).toEqual({ ok: false, code: 'ORIGINAL_PATH_TAKEN' })
  })

  it('il logger che esplode non fa fallire nessuna transizione (fail-open)', async () => {
    const { intent } = await intentPronto('l-1')
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.app_log_registra(righe jsonb)
      RETURNS int LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'logger non disponibile';
      END $$
    `)
    await expect(
      rpc(`public.video_intent_finalize(
        '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
      )`),
    ).resolves.toMatchObject({ ok: true, intent: { status: 'published' } })
  })

  it('registra ogni transizione di intent con il proprio evento', async () => {
    const { intent } = await intentPronto('log-1')
    await rpc(`public.video_intent_finalize(
      '${intent.id}', '${OWNER}', 1, '${SEDE}', 'news', '${TARGET}', 'news.published', '{}'::jsonb
    )`)
    const { eventi } = await unaRiga<{ eventi: string[] }>(`
      SELECT array_agg(DISTINCT e.evento ORDER BY e.evento) AS eventi
      FROM public.log_migrazioni l,
           LATERAL jsonb_array_elements(l.payload) AS r(riga),
           LATERAL (SELECT r.riga ->> 'evento' AS evento) AS e
      WHERE e.evento LIKE 'video-intent-%'
        -- La riga che la migrazione scrive installandosi dice che il file è
        -- passato, non che una transizione è avvenuta: contarla renderebbe la
        -- prova verde anche senza nessuna RPC eseguita.
        AND e.evento <> 'video-intent-lifecycle-migration'
    `)
    expect(eventi).toEqual(['video-intent-confirm', 'video-intent-finalize', 'video-intent-open'])
  })
})

describe('la decisione su `storage.objects`: nessuna policy, e il motivo', () => {
  /**
   * Il piano di V02 chiedeva una policy di INSERT su `storage.objects` per
   * `video_originals`. Non c'è, e non è una dimenticanza: misurato sul progetto di
   * produzione il 2026-09-17, `storage.objects` appartiene a
   * `supabase_storage_admin`, mentre il ruolo che applica le migrazioni è `postgres`,
   * che non è superuser e non è membro di quel ruolo — `CREATE POLICY` fallirebbe con
   * 42501 in mezzo a un rilascio. E soprattutto non serve: Storage 1.73.1 espone
   * `/storage/v1/upload/resumable/sign`, la rotta TUS che autentica con la firma
   * `x-signature` prodotta da `createSignedUploadUrl()` e che nel codice di
   * storage-api gira su `dbSuperUser`, quindi fuori da RLS.
   *
   * Questo lock esiste perché la prossima persona che legge il piano non riapra il
   * capitolo scrivendo una policy che non si può applicare.
   */
  const MIGRAZIONI_VIDEO = [FILE_SCHEMA, FILE_TRANSIZIONI, FILE_INTENT]

  it('nessuna migrazione video crea una policy su `storage.objects`', () => {
    const colpevoli = MIGRAZIONI_VIDEO.filter((file) => {
      const sql = readFileSync(join(CARTELLA_MIGRAZIONI, file), 'utf8')
        // Si guarda l'SQL, non la prosa: questa stessa testata SPIEGA perché la
        // policy non c'è, e un lock che punisce chi documenta insegna a non
        // documentare.
        .replace(/--[^\n]*/g, ' ')
      return /\bCREATE\s+POLICY\b[\s\S]{0,200}?\bstorage\s*\.\s*objects\b/i.test(sql)
    })
    expect(
      colpevoli,
      "Una policy su `storage.objects` non si può applicare da qui: la tabella è di " +
        '`supabase_storage_admin` e le migrazioni girano come `postgres`, che non ne è ' +
        'membro (42501). E non serve: l\'upload TUS passa da `/upload/resumable/sign` ' +
        'con la firma del service role, che non attraversa RLS.',
    ).toEqual([])
  })

  it('la migrazione degli intent dichiara la rotta firmata come modo di caricare', () => {
    // Se qualcuno toglie la spiegazione, questo lock resta senza il proprio motivo e
    // la scelta torna a sembrare una dimenticanza — che è esattamente come V02 l'ha
    // classificata la prima volta.
    expect(INTENT).toContain('/storage/v1/upload/resumable/sign')
    expect(INTENT).toContain('x-signature')
  })

  it("l'evidenza citata è quella che si riproduce, e il controllo sta FUORI dal prefisso", () => {
    // La prima stesura diceva «tre risposte diverse», con una rotta inesistente che
    // rispondeva 404. Rimisurato il 2026-09-17 con quattro `POST` senza credenziali:
    // `/upload/resumable/inesistente` risponde 400 «Invalid Compact JWS», IDENTICO
    // alla gemella non firmata, perché `/upload/resumable/*` è una rotta jolly col
    // controllo JWT che assorbe ogni sottopercorso sconosciuto. Le risposte diverse
    // erano due, non tre, e il terzo pilastro — «la rotta esiste / non esiste» — era
    // falso come riportato. Il 404 esiste davvero, ma FUORI da quel prefisso.
    //
    // La conclusione regge lo stesso (la rotta firmata arriva al gestore TUS e chiede
    // `Tus-Resumable`, la gemella non ci arriva mai). Ma in un repository il cui
    // blocco CLAUDE.md nasce da numeri invecchiati, un'evidenza che non si riproduce
    // va corretta PRIMA che V07 e V10 la citino.
    for (const misura of [
      '412', // la rotta firmata: arriva al gestore TUS, quindi non è il JWT a fermarla
      'Tus-Resumable Required',
      '/storage/v1/upload/resumable/inesistente', // il falso controllo, dichiarato tale
      '/storage/v1/inesistente', // il controllo vero, scelto fuori dal prefisso jolly
      'Route POST:/inesistente not found',
    ]) {
      expect(
        INTENT,
        `La testata non riporta più la misura «${misura}»: senza, la scelta su ` +
          "`storage.objects` torna a poggiare su un'evidenza che non si riproduce.",
      ).toContain(misura)
    }
  })

  it("il prefisso del percorso NON è l'indice dell'oblio, e la misura lo conferma", () => {
    // La motivazione scritta accanto al vincolo `original_path LIKE '<owner_id>/%'`
    // diceva che serve all'oblio GDPR. Non regge: il prefisso è l'uuid di CHI CARICA
    // (staff, gate `requireDocente`), mentre l'oblio cancella per bambino o per
    // genitore. Elencare la cartella di un insegnante non trova il video di un
    // bambino. Il vincolo resta — è utile per la pulizia per caricatore — ma con la
    // ragione giusta accanto, che è la regola di stile di questo repository.
    const oblio = readFileSync(join(process.cwd(), 'src/lib/gdpr/esegui.ts'), 'utf8')
    expect(
      oblio,
      "`CanaleOblio` non è più «alunno | genitore»: la motivazione della testata di " +
        '`20260916190200` va rivista insieme a questo cambio.',
    ).toContain("export type CanaleOblio = 'alunno' | 'genitore'")

    // E i due bucket video nel registro dell'oblio non ci sono affatto. Il giorno in
    // cui ce li si mette — come ordina la voce IN_CODA di `20260916190000` in
    // `migrazioni-complete.test.ts` — questo test diventa rosso e la testata va
    // riscritta. È esattamente ciò che NON è successo alla frase che c'era prima.
    expect(
      /video_originals|video_processing/.test(oblio),
      'I bucket video sono entrati in `REGISTRO_BUCKET_OBLIO`: la testata di ' +
        '`20260916190200` dice ancora che l\'oblio non li raggiunge. Aggiornala.',
    ).toBe(false)

    expect(INTENT).toContain('CHI CARICA')
  })
})

describe("l'ordine dei lock, che PGlite da solo non può misurare", () => {
  /**
   * Con una connessione sola non si può osservare un'attesa. Ma l'ordine in cui una
   * funzione scrive i propri `FOR UPDATE` è nel testo, ed è la proprietà che il
   * critico di V04 ha fatto correggere: intent PRIMA, job POI. Due ordini diversi
   * sulle stesse due righe sono un deadlock che si manifesta solo sotto carico —
   * cioè mai in prova.
   */
  /**
   * Il corpo di ogni funzione, tagliato al proprio `$$;` e ripulito dai commenti.
   * Servono tutt'e due i tagli, e li ha imposti la misura, non la prudenza: lo `split`
   * su `CREATE OR REPLACE FUNCTION` lascia in coda a ciascun pezzo la PROSA che
   * introduce la funzione successiva, e quella prosa parla di lock — «il claim usa
   * `FOR UPDATE SKIP LOCKED`» sta sopra `video_outbox_claim`, cioè finisce dentro il
   * pezzo di `video_intent_revoke`. Senza il taglio, `video_intent_revoke` risulta
   * prendere un lock dopo l'orologio che non prende affatto. Un test che legge un file
   * come testo legge anche i commenti.
   */
  const CORPI = INTENT.split(/CREATE OR REPLACE FUNCTION/)
    .slice(1)
    .map((pezzo) => {
      const fine = pezzo.indexOf('$$;')
      return (fine === -1 ? pezzo : pezzo.slice(0, fine)).replace(/--[^\n]*/g, ' ')
    })

  it('ogni RPC che blocca sia intent sia job blocca prima l’intent', () => {
    const invertite: string[] = []
    for (const corpo of CORPI) {
      const nome = /^\s*public\.(\w+)/.exec(corpo)?.[1] ?? '?'
      const posIntent = corpo.search(/FROM public\.video_intents[\s\S]{0,200}?FOR UPDATE/)
      const posJob = corpo.search(/FROM public\.video_jobs[\s\S]{0,200}?FOR UPDATE/)
      if (posIntent === -1 || posJob === -1) continue
      if (posJob < posIntent) invertite.push(nome)
    }
    expect(
      invertite,
      'Queste RPC bloccano un job prima del suo intent: incrociate con le RPC di ' +
        '`20260916190100`, che fanno il contrario, producono un deadlock sotto carico.',
    ).toEqual([])
  })

  /**
   * L'unica eccezione, e il motivo per cui è un'eccezione vera e non un'esenzione di
   * comodo: `video_outbox_claim` acquisisce il lock e scrive nella STESSA istruzione
   * (una CTE `FOR UPDATE SKIP LOCKED` che alimenta l'UPDATE). Non esiste una finestra
   * fra il lock e la scrittura in cui l'orologio possa invecchiare, perché non esiste
   * un secondo statement. La regola nasce per le funzioni che prendono due lock in
   * due istruzioni separate, e lì vale senza sconti.
   */
  const OROLOGIO_IN_UNA_SOLA_ISTRUZIONE = new Set(['video_outbox_claim'])

  it("ogni RPC prende `clock_timestamp()` DOPO l'ultimo lock, non prima", () => {
    const anticipate: string[] = []
    for (const corpo of CORPI) {
      const nome = /^\s*public\.(\w+)/.exec(corpo)?.[1] ?? '?'
      if (OROLOGIO_IN_UNA_SOLA_ISTRUZIONE.has(nome)) continue
      const posOrologio = corpo.indexOf('v_now := pg_catalog.clock_timestamp()')
      if (posOrologio === -1) continue
      // L'ULTIMO `FOR UPDATE` della funzione, cercato su TUTTO il corpo: se l'orologio
      // sta prima, l'istante registrato è quello in cui si è entrati in coda, non
      // quello in cui si è scritto — e una lease calcolata su di esso nasce già
      // consumata dal tempo d'attesa.
      //
      // La prima stesura passava `posOrologio + 400` come secondo argomento di
      // `lastIndexOf`, che cerca ALL'INDIETRO a partire da lì: guardava quindi una
      // finestra di 400 caratteri DOPO l'orologio, e non «tutti i lock». Spostare
      // `v_now := clock_timestamp()` in cima a `video_intent_finalize` — prima di OGNI
      // lock, cioè la versione PEGGIORE dello stesso difetto — la lasciava verde.
      // Misurato: il guasto che l'esecutore aveva dichiarato di aver provato stava a
      // 15 caratteri dall'orologio, cioè dentro la finestra, quindi la prova «il test
      // morde» aveva misurato solo la variante mite. E queste due proprietà sono la
      // sola copertura che esiste per «un solo vincitore», perché PGlite è a
      // connessione singola: il sostituto era bucato proprio dove sostituisce.
      const ultimoLock = corpo.lastIndexOf('FOR UPDATE')
      if (ultimoLock !== -1 && ultimoLock > posOrologio) anticipate.push(nome)
    }
    expect(anticipate, "Queste RPC leggono l'orologio prima di aver preso tutti i lock.")
      .toEqual([])
  })
})
