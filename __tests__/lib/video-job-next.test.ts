// @vitest-environment node

/**
 * `video_job_next` — la presa in carico del PROSSIMO job dalla coda, provata sul
 * file di migrazione VERO.
 *
 * Stesso impianto di `video-transitions.test.ts` e `video-intents.test.ts`: PGlite, i
 * ruoli di Supabase ricostruiti a mano, e le migrazioni lette **dal disco**. Leggerle
 * dal disco non è pigrizia: è l'unico modo perché questo test eserciti lo stesso testo
 * SQL che verrà applicato in produzione. Un test che ripete l'SQL dentro di sé prova la
 * propria copia, e resta verde il giorno in cui le due divergono.
 *
 * ⚠️ QUELLO CHE QUESTO FILE **NON** DIMOSTRA, detto qui e non in fondo.
 *
 * PGlite è a CONNESSIONE SINGOLA. La proprietà per cui `FOR UPDATE ... SKIP LOCKED`
 * esiste — due worker che si svegliano insieme prendono job DIVERSI invece di litigare
 * sullo stesso — richiede due transazioni davvero simultanee, e qui non si possono
 * avere: non c'è nessun momento in cui una riga risulti «bloccata da un altro», quindi
 * lo `SKIP LOCKED` non salta mai niente e un test che lo dichiarasse provato sarebbe un
 * verde muto. Ciò che si prova qui è tutto il resto, che non è poco:
 *
 *   · quali job sono eleggibili e quali no (stato del job, stato dell'intent, lease);
 *   · l'ordine di selezione (il più vecchio per primo, a parità di istante per id);
 *   · che due chiamate CONSECUTIVE prendano job diversi — che è l'effetto visibile su
 *     una connessione sola, e non è lo `SKIP LOCKED`;
 *   · che una lease scaduta venga riscattata e il `fence_epoch` salga, chiudendo fuori
 *     il worker morto;
 *   · che un job di un intent chiuso non venga preso MAI;
 *   · che la coda vuota risponda con un codice, e che lo dica al log;
 *   · che la logica di claim NON sia duplicata: la si sostituisce a runtime con una
 *     spia, e se `video_job_next` avesse una copia propria la spia non comparirebbe.
 *
 * Come si proverebbe davvero lo `SKIP LOCKED`: serve un Postgres con più connessioni —
 * il contenitore `supabase/postgres` della CI, o un `pg` locale — due client separati,
 * `BEGIN` su entrambi, `video_job_next` su entrambi PRIMA che uno dei due committi, e
 * l'asserzione che i due `job.id` siano diversi e che nessuna delle due chiamate si sia
 * messa in attesa. È scritto anche nel report di questa microtask.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const CARTELLA_MIGRAZIONI = join(process.cwd(), 'supabase/migrations')
const FILE_SCHEMA = '20260916190000_video_jobs.sql'
const FILE_TRANSIZIONI = '20260916190100_video_job_transitions.sql'
const FILE_NEXT = '20260917210000_video_job_next.sql'

const SCHEMA = readFileSync(join(CARTELLA_MIGRAZIONI, FILE_SCHEMA), 'utf8')
const TRANSIZIONI = readFileSync(join(CARTELLA_MIGRAZIONI, FILE_TRANSIZIONI), 'utf8')
const NEXT = readFileSync(join(CARTELLA_MIGRAZIONI, FILE_NEXT), 'utf8')

const SEDE = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const LEASE_A = '50000000-0000-4000-8000-000000000005'
const LEASE_B = '51000000-0000-4000-8000-000000000005'
const LEASE_C = '52000000-0000-4000-8000-000000000005'

type Job = {
  id: string
  status: string
  intent_id: string
  attempt: number
  fence_epoch: number
  lease_owner: string | null
  lease_expires_at: string | null
  spia?: boolean
}

type Risposta = {
  ok: boolean
  code?: string
  job?: Job
}

let db: PGlite

async function rpc(sql: string): Promise<Risposta> {
  const { rows } = await db.query<{ risultato: Risposta }>(`SELECT ${sql} AS risultato`)
  return rows[0].risultato
}

async function unaRiga<T>(sql: string): Promise<T> {
  const { rows } = await db.query<T>(sql)
  return rows[0]
}

/** Il prossimo job della coda, con la lease richiesta. */
const next = (proprietario: string, secondi = 300) =>
  rpc(`public.video_job_next('${proprietario}', ${secondi})`)

/**
 * Un intent + il suo job, in uno stato di partenza dichiarato.
 *
 * `created_at` si sposta con un UPDATE perché la colonna ha `DEFAULT now()` e dentro
 * una sola transazione `now()` non avanza: senza lo spostamento tre job nascerebbero
 * con lo stesso istante e l'ordine della coda sarebbe deciso dal solo tie-break.
 *
 * La sigla finisce dentro un uuid, quindi vale solo l'esadecimale: `g1` sembrava una
 * sigla come le altre e faceva esplodere il test con «invalid input syntax for type
 * uuid», non con l'asserzione che stava provando.
 */
async function creaJob(
  sigla: string,
  opzioni: { minutiFa?: number; statoIntent?: string } = {},
): Promise<{ intentId: string; jobId: string }> {
  const intentId = `30000000-0000-4000-8000-0000000000${sigla}`
  const jobId = `40000000-0000-4000-8000-0000000000${sigla}`
  const minutiFa = opzioni.minutiFa ?? 0
  const stato = opzioni.statoIntent ?? 'pending'
  const tempi =
    stato === 'pending'
      ? ''
      : stato === 'confirmed'
        ? ', confirmed_at = transaction_timestamp()'
        : stato === 'published'
          ? ', confirmed_at = transaction_timestamp(), published_at = transaction_timestamp()'
          : ', revoked_at = transaction_timestamp()'

  await db.exec(`
    INSERT INTO public.video_intents(
      id, owner_id, scuola_id, channel, requested_action, payload
    ) VALUES (
      '${intentId}', '${OWNER}', '${SEDE}', 'news', 'publish', '{}'
    );
    INSERT INTO public.video_jobs(
      id, owner_id, scuola_id, channel, idempotency_key, intent_id,
      original_bucket, original_path
    ) VALUES (
      '${jobId}', '${OWNER}', '${SEDE}', 'news', 'chiave-${sigla}', '${intentId}',
      'video_originals', 'originals/${sigla}/source'
    );
    UPDATE public.video_jobs
    SET created_at = created_at - interval '${minutiFa} minutes'
    WHERE id = '${jobId}';
    UPDATE public.video_intents
    SET status = '${stato}'${tempi}
    WHERE id = '${intentId}';
  `)
  return { intentId, jobId }
}

/** Porta il job in coda (`queued`), come farebbe la fine dell'upload TUS. */
async function accoda(jobId: string) {
  const esito = await rpc(`public.video_job_uploaded('${jobId}', '${OWNER}', 1000, 'video/mp4')`)
  expect(esito.ok, `l'accodamento di ${jobId} doveva riuscire`).toBe(true)
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

    INSERT INTO public.schools(id) VALUES ('${SEDE}');
    INSERT INTO auth.users(id) VALUES ('${OWNER}');
    INSERT INTO public.utenti(id, scuola_id) VALUES ('${OWNER}', '${SEDE}');
  `)

  await db.exec(SCHEMA)
  await db.exec(TRANSIZIONI)
  await db.exec(NEXT)
}

/** I contesti loggati dall'evento indicato, nell'ordine in cui sono stati scritti. */
async function contestiLoggati(evento: string): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query<{ contesto: Record<string, unknown> }>(`
    SELECT payload -> 0 -> 'contesto' AS contesto
    FROM public.log_migrazioni
    WHERE payload -> 0 ->> 'evento' = '${evento}'
    ORDER BY ctid
  `)
  return rows.map((r) => r.contesto)
}

/** I livelli loggati dall'evento indicato, nell'ordine in cui sono stati scritti. */
async function livelliLoggati(evento: string): Promise<string[]> {
  const { rows } = await db.query<{ livello: string }>(`
    SELECT payload -> 0 ->> 'livello' AS livello
    FROM public.log_migrazioni
    WHERE payload -> 0 ->> 'evento' = '${evento}'
    ORDER BY ctid
  `)
  return rows.map((r) => r.livello)
}

beforeEach(async () => {
  db = new PGlite()
  await preparaDatabase()
})

afterEach(async () => {
  await db.close()
})

describe('video_job_next · forma della funzione', () => {
  it('è SECURITY DEFINER, ha search_path chiuso ed è eseguibile solo dal service role', async () => {
    const funzione = await unaRiga<{
      security_definer: boolean
      configurazione: string[]
      argomenti: string
      service: boolean
      anon: boolean
      authenticated: boolean
    }>(`
      SELECT p.prosecdef AS security_definer,
             p.proconfig AS configurazione,
             pg_get_function_identity_arguments(p.oid) AS argomenti,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'video_job_next'
    `)

    expect(funzione.security_definer).toBe(true)
    expect(funzione.configurazione).toContain('search_path=pg_catalog')
    // I NOMI dei parametri sono contratto, non decorazione: PostgREST passa gli
    // argomenti di una RPC per nome (`{ p_lease_owner, p_lease_seconds }`), quindi
    // rinominarli rompe il chiamante senza cambiare né i tipi né il comportamento.
    expect(funzione.argomenti).toBe('p_lease_owner uuid, p_lease_seconds integer')
    expect(funzione.service).toBe(true)
    expect(funzione.anon).toBe(false)
    expect(funzione.authenticated).toBe(false)
  })

  it('non prende MAI un lock su video_jobs prima di quello sull’intent', async () => {
    // Questa è una lettura del TESTO, e vale quanto vale: dice che nel corpo di
    // `video_job_next` l'unica riga bloccata per prima è quella dell'intent, e che il
    // lock sui job lo prende `video_job_claim` dopo. Invertire i due ordini è il modo
    // documentato in cui due RPC di questo schema si incrociano in un deadlock, e su
    // PGlite — una connessione sola — un deadlock non si può osservare.
    const corpo = /CREATE OR REPLACE FUNCTION public\.video_job_next[\s\S]*?\n\$\$;/.exec(NEXT)
    expect(corpo, 'il corpo di video_job_next non è stato trovato nel file').not.toBeNull()
    const sql = corpo![0]

    const primoLockIntent = sql.search(/FOR UPDATE OF i\b/)
    expect(primoLockIntent, 'manca il FOR UPDATE OF i (il lock sull’intent, che va per primo)')
      .toBeGreaterThan(-1)
    expect(sql).toMatch(/SKIP LOCKED/)
    expect(
      /FROM\s+public\.video_jobs[\s\S]*?FOR UPDATE(?!\s+OF i\b)/i.test(sql),
      'video_job_next non deve bloccare video_jobs da sé: lo fa video_job_claim, dopo l’intent',
    ).toBe(false)
  })
})

describe('video_job_next · quali job prende e in quale ordine', () => {
  it('rifiuta gli argomenti assenti e una lease fuori dai limiti di video_job_claim', async () => {
    expect(await rpc('public.video_job_next(NULL, 300)')).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_next('${LEASE_A}', NULL)`)).toEqual({
      ok: false,
      code: 'BAD_INPUT',
    })
    expect(await next(LEASE_A, 0)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await next(LEASE_A, 1801)).toEqual({ ok: false, code: 'BAD_INPUT' })
  })

  it('con la coda vuota risponde EMPTY_QUEUE, e lo dice al log a livello info', async () => {
    expect(await next(LEASE_A)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })

    // «Non c'era niente da fare» è informazione vera: senza questa riga, il silenzio
    // non distingue «coda tranquilla» da «il worker non è mai partito».
    expect(await livelliLoggati('video-job-next')).toEqual(['info'])
    expect(await contestiLoggati('video-job-next')).toEqual([{ code: 'EMPTY_QUEUE' }])
  })

  it('prende il job più vecchio, e due chiamate consecutive prendono job diversi', async () => {
    const vecchio = await creaJob('a1', { minutiFa: 30 })
    const mezzo = await creaJob('a2', { minutiFa: 20 })
    const recente = await creaJob('a3', { minutiFa: 10 })
    await accoda(recente.jobId)
    await accoda(vecchio.jobId)
    await accoda(mezzo.jobId)

    const primo = await next(LEASE_A)
    expect(primo).toMatchObject({
      ok: true,
      job: { id: vecchio.jobId, status: 'processing', attempt: 1, fence_epoch: 1, lease_owner: LEASE_A },
    })

    const secondo = await next(LEASE_B)
    expect(secondo).toMatchObject({ ok: true, job: { id: mezzo.jobId, lease_owner: LEASE_B } })

    const terzo = await next(LEASE_C)
    expect(terzo).toMatchObject({ ok: true, job: { id: recente.jobId, lease_owner: LEASE_C } })

    expect(await next(LEASE_A)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
  })

  it('non prende un job in attesa di upload, né uno già concluso, né uno cancellato', async () => {
    // `awaiting_upload`: il file non è ancora nello Storage, non c'è niente da convertire.
    await creaJob('b1', { minutiFa: 50 })

    const concluso = await creaJob('b2', { minutiFa: 40 })
    await accoda(concluso.jobId)
    await rpc(`public.video_job_claim('${concluso.jobId}', '${LEASE_A}', 300)`)
    await rpc(`public.video_job_ready(
      '${concluso.jobId}', 1, '${LEASE_A}', 'outputs/b2/final.mp4', 900,
      '{"durationSeconds":12}'::jsonb
    )`)

    const fallito = await creaJob('b3', { minutiFa: 30 })
    await accoda(fallito.jobId)
    await rpc(`public.video_job_claim('${fallito.jobId}', '${LEASE_A}', 300)`)
    await rpc(`public.video_job_fail('${fallito.jobId}', 1, '${LEASE_A}', 'CODEC_UNSUPPORTED', false)`)

    const cancellato = await creaJob('b4', { minutiFa: 20 })
    await accoda(cancellato.jobId)
    await rpc(`public.video_job_cancel('${cancellato.jobId}', '${OWNER}')`)

    expect(await next(LEASE_B)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
  })

  it('non tocca un job la cui lease è ancora viva, nemmeno del proprio worker', async () => {
    const solo = await creaJob('c1', { minutiFa: 10 })
    await accoda(solo.jobId)

    expect(await next(LEASE_A)).toMatchObject({ ok: true, job: { id: solo.jobId } })
    expect(await next(LEASE_B)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
    // Nemmeno chi possiede già la lease lo ripesca: `video_job_next` consegna lavoro
    // NUOVO, e un worker che ritenta non deve ricevere due volte lo stesso job.
    expect(await next(LEASE_A)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
  })

  it('riscatta la lease scaduta di un worker morto e ne alza il fence_epoch', async () => {
    const abbandonato = await creaJob('d1', { minutiFa: 10 })
    await accoda(abbandonato.jobId)
    await rpc(`public.video_job_claim('${abbandonato.jobId}', '${LEASE_A}', 300)`)
    await db.exec(`
      UPDATE public.video_jobs
      SET lease_expires_at = transaction_timestamp() - interval '1 second'
      WHERE id = '${abbandonato.jobId}'
    `)

    const riscattato = await next(LEASE_B)
    expect(riscattato).toMatchObject({
      ok: true,
      job: { id: abbandonato.jobId, status: 'processing', attempt: 2, fence_epoch: 2, lease_owner: LEASE_B },
    })

    // Il worker morto che risorge non può più chiudere il job: il fence è avanzato.
    expect(await rpc(`public.video_job_ready(
      '${abbandonato.jobId}', 1, '${LEASE_A}', 'outputs/d1/stale.mp4', 900,
      '{"durationSeconds":12}'::jsonb
    )`)).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
  })

  it('non prende mai un job il cui intent è stato chiuso (cancellato, superato, pubblicato)', async () => {
    const perStato = async (sigla: string, statoIntent: string) => {
      const creato = await creaJob(sigla, { minutiFa: 30, statoIntent: 'pending' })
      await accoda(creato.jobId)
      await db.exec(`
        UPDATE public.video_intents
        SET status = '${statoIntent}',
            confirmed_at = COALESCE(confirmed_at, transaction_timestamp()),
            revoked_at = CASE WHEN '${statoIntent}' IN ('cancelled', 'superseded')
                              THEN transaction_timestamp() ELSE revoked_at END,
            published_at = CASE WHEN '${statoIntent}' = 'published'
                                THEN transaction_timestamp() ELSE published_at END
        WHERE id = '${creato.intentId}'
      `)
      return creato
    }

    await perStato('e1', 'cancelled')
    await perStato('e2', 'superseded')
    await perStato('e3', 'published')

    expect(await next(LEASE_A)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })

    // Con un intent vivo accanto, la coda torna a consegnare — e consegna QUELLO.
    const vivo = await creaJob('e4', { minutiFa: 5 })
    await accoda(vivo.jobId)
    expect(await next(LEASE_A)).toMatchObject({ ok: true, job: { id: vivo.jobId } })
  })
})

describe('video_job_next · non duplica video_job_claim', () => {
  it('delega davvero: sostituendo video_job_claim con una spia, è la spia a rispondere', async () => {
    // Se `video_job_next` avesse una copia propria della logica di claim, questa
    // sostituzione non cambierebbe la risposta — ed è esattamente il difetto che il
    // repo ha già pagato con un gate copiato che proteggeva la POST e lasciava
    // scoperta la PATCH. Qui la duplicazione diventa un test rosso, non un commento.
    const atteso = await creaJob('f1', { minutiFa: 10 })
    await accoda(atteso.jobId)

    await db.exec(`
      CREATE OR REPLACE FUNCTION public.video_job_claim(
        p_job_id uuid,
        p_lease_owner uuid,
        p_lease_seconds integer
      )
      RETURNS jsonb
      LANGUAGE sql
      AS $spia$
        SELECT jsonb_build_object(
          'ok', true,
          'job', jsonb_build_object(
            'id', p_job_id,
            'lease_owner', p_lease_owner,
            'attempt', p_lease_seconds,
            'spia', true
          )
        )
      $spia$;
    `)

    expect(await next(LEASE_A, 600)).toEqual({
      ok: true,
      job: { id: atteso.jobId, lease_owner: LEASE_A, attempt: 600, spia: true },
    })
  })

  it('propaga il rifiuto di video_job_claim senza mascherarlo, e lo logga come errore', async () => {
    const candidato = await creaJob('f2', { minutiFa: 10 })
    await accoda(candidato.jobId)

    await db.exec(`
      CREATE OR REPLACE FUNCTION public.video_job_claim(
        p_job_id uuid,
        p_lease_owner uuid,
        p_lease_seconds integer
      )
      RETURNS jsonb
      LANGUAGE sql
      AS $spia$
        SELECT jsonb_build_object('ok', false, 'code', 'LEASE_ACTIVE')
      $spia$;
    `)

    expect(await next(LEASE_A)).toEqual({ ok: false, code: 'LEASE_ACTIVE' })
    expect(await livelliLoggati('video-job-next')).toEqual(['error'])
  })
})

describe('video_job_next · osservabilità', () => {
  it('logga il successo con soli identificatori e numeri: nessun percorso, nessun MIME', async () => {
    const preso = await creaJob('91', { minutiFa: 10 })
    await accoda(preso.jobId)
    await next(LEASE_A, 420)

    const contesti = await contestiLoggati('video-job-next')
    expect(contesti).toHaveLength(1)
    expect(contesti[0]).toEqual({
      job_id: preso.jobId,
      intent_id: preso.intentId,
      attempt: 1,
      fence_epoch: 1,
      lease_seconds: 420,
    })
    expect(await livelliLoggati('video-job-next')).toEqual(['info'])

    // La lista bianca della redazione non ammette testo libero: il percorso
    // dell'originale e il MIME dichiarato dal telefono non devono comparire da
    // nessuna parte nel log, nemmeno dentro il payload di un altro evento.
    const { rows } = await db.query<{ testo: string }>(
      `SELECT payload::text AS testo FROM public.log_migrazioni`,
    )
    for (const riga of rows) {
      expect(riga.testo).not.toContain('originals/91/source')
      expect(riga.testo).not.toContain('video/mp4')
    }
  })

  it('un logger che esplode non ferma la presa in carico (fail-open)', async () => {
    const preso = await creaJob('92', { minutiFa: 10 })
    await accoda(preso.jobId)

    await db.exec(`
      CREATE OR REPLACE FUNCTION public.app_log_registra(righe jsonb)
      RETURNS int LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'logger non disponibile';
      END $$
    `)

    expect(await next(LEASE_A)).toMatchObject({
      ok: true,
      job: { id: preso.jobId, status: 'processing', lease_owner: LEASE_A },
    })
  })
})
