// @vitest-environment node

/**
 * I RITENTATIVI DEI JOB VIDEO — `video_job_retry` e le due funzioni che ne dipendono,
 * provati sui file di migrazione VERI.
 *
 * Stesso impianto di `video-job-next.test.ts` e `video-transitions.test.ts`: PGlite, i
 * ruoli di Supabase ricostruiti a mano, e le migrazioni lette **dal disco**, nell'ordine
 * in cui la produzione le ha applicate. Un test che ripete l'SQL dentro di sé prova la
 * propria copia, e resta verde il giorno in cui le due divergono.
 *
 * ─── COME SI TROVANO LE DUE MIGRAZIONI DI QUESTA PR ─────────────────────────────────────
 *
 * Per SUFFISSO del nome, non per nome intero. Le due migrazioni nascono con un timestamp
 * provvisorio e, quando vengono applicate a mano prima del merge, il file passa alla
 * `version` registrata (`git mv`): un test che ne conoscesse il nome intero si romperebbe
 * proprio in quel momento, e chi lo ripara a mano rischia di aggiustare il test invece del
 * file. Le migrazioni VECCHIE (schema, transizioni, intent, next, retention) hanno un nome
 * che non cambia più.
 *
 * ─── COSA QUESTO FILE **NON** DIMOSTRA, detto qui e non in fondo ────────────────────────
 *
 * PGlite è a CONNESSIONE SINGOLA. Che due `video_job_retry` simultanei sullo stesso job si
 * serializzino sul lock dell'intent, o che un `video_job_cancel` concorrente vinca su un
 * retry in corso, richiede due transazioni davvero in volo, e qui non si possono avere. Si
 * prova invece l'ORDINE dei lock leggendo il testo (come `video-job-next.test.ts`) e tutto
 * ciò che è osservabile da una connessione sola: le decisioni, gli stati, i log, i
 * privilegi, e che una chiamata ripetuta non sposti l'attesa.
 *
 * `INTENT_CHANGED_RETRY` è il terzo caso, e va nominato: è la rilettura che ogni transizione
 * dei job fa dopo il lock sul job («l'intent che ho bloccato è ancora quello del job?»), e
 * nasce solo con DUE transazioni in volo, perché l'intent del job dovrebbe cambiare fra il
 * lock sull'intent e quello sul job. Da una connessione sola non c'è nessun «fra»: qui non si
 * prova da vivo, ma sul TESTO, col test «le guardie di video_job_retry sono quelle di
 * video_job_fail, byte per byte», che confronta quel tratto con `video_job_fail` e diventa
 * rosso se la guardia sparisce.
 *
 * L'OROLOGIO si muove con degli UPDATE (`rendiDovuto`, `scadiLease`), mai con uno `sleep`:
 * `video_job_retry` calcola l'attesa con `clock_timestamp()`, e per far «passare» cinque
 * minuti si porta indietro la colonna invece di aspettarli.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  senzaCommenti,
  toccaLaRls,
  toccaLeFkUtenti,
  toccaUnUnico,
} from '../architecture/soglia-fotografia'

const CARTELLA_MIGRAZIONI = join(process.cwd(), 'supabase/migrations')

const leggi = (file: string): string => readFileSync(join(CARTELLA_MIGRAZIONI, file), 'utf8')

/** Il file che finisce con quel suffisso, e uno solo: altrimenti il test non sa quale leggere. */
function trovaPerSuffisso(suffisso: string): string {
  const trovati = readdirSync(CARTELLA_MIGRAZIONI).filter((f) => f.endsWith(suffisso))
  if (trovati.length !== 1) {
    throw new Error(
      `Cerco in supabase/migrations/ UN file che finisce con «${suffisso}» e ne trovo ` +
        `${trovati.length} (${trovati.join(', ') || 'nessuno'}). Se la migrazione è stata ` +
        `rinominata con la version registrata, il suffisso deve restare lo stesso.`,
    )
  }
  return trovati[0]
}

/**
 * Il testo senza le righe di solo commento. Un test che legge un file come TESTO legge anche
 * i commenti, e una stringa cercata può trovarsi nel commento che la spiega invece che nel
 * codice: per questo ogni controllo sul TESTO della migrazione passa da qui.
 */
const soloCodice = (sql: string): string =>
  sql
    .split('\n')
    .filter((r) => !/^\s*--/.test(r))
    .join('\n')

// Le migrazioni vecchie, nell'ordine di applicazione.
const SCHEMA = leggi('20260916190000_video_jobs.sql')
const TRANSIZIONI = leggi('20260916190100_video_job_transitions.sql')
const INTENTI = leggi('20260916190200_video_intent_lifecycle.sql')
const NEXT_ORIGINALE = leggi('20260917210000_video_job_next.sql')
const RETENTION = leggi('20260918110000_video_retention_riconciliazione.sql')
// Le due di questa PR.
const BUCKET = leggi(trovaPerSuffisso('_video_build_bucket.sql'))
const RITENTATIVI = leggi(trovaPerSuffisso('_video_job_ritentativi.sql'))

const SEDE = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const NUOVA_REVISIONE = '30000000-0000-4000-8000-0000000000f0'
const LEASE_A = '50000000-0000-4000-8000-000000000005'
const LEASE_B = '51000000-0000-4000-8000-000000000005'
const LEASE_C = '52000000-0000-4000-8000-000000000005'
const LEASE_D = '53000000-0000-4000-8000-000000000005'
const INESISTENTE = '99999999-9999-4999-8999-999999999999'

/** I due guasti nostri che i test alternano: due codici veri del runner. */
const CODICE = 'BUILD_DOWNLOAD_FAILED'
const ALTRO_CODICE = 'SANDBOX_UNAVAILABLE'

type Job = {
  id: string
  status: string
  intent_id: string
  attempt: number
  fence_epoch: number
  lease_owner: string | null
  lease_expires_at: string | null
  next_attempt_at: string | null
  last_error_code: string | null
  error_code: string | null
  original_delete_after: string | null
}

type Risposta = {
  ok: boolean
  code?: string
  job?: Job
  job_spenti?: number
  job_cancellati?: number
  [chiave: string]: unknown
}

/** La riga di `video_jobs` letta con SQL: i timestamp tornano come `Date`, non come stringhe. */
type Riga = {
  status: string
  attempt: number
  fence_epoch: number
  lease_owner: string | null
  lease_expires_at: Date | null
  next_attempt_at: Date | null
  last_error_code: string | null
  error_code: string | null
  original_delete_after: Date | null
  created_at: Date
  updated_at: Date
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

async function riga(jobId: string): Promise<Riga> {
  return unaRiga<Riga>(`
    SELECT status, attempt, fence_epoch::int AS fence_epoch, lease_owner, lease_expires_at,
           next_attempt_at, last_error_code, error_code, original_delete_after,
           created_at, updated_at
    FROM public.video_jobs WHERE id = '${jobId}'
  `)
}

/** Un valore SQL letterale: `NULL`, un numero, oppure una stringa fra apici. */
const lit = (v: string | number | null): string =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`

type ArgomentiRetry = {
  fence: number | null
  lease: string | null
  codice: string | null
  massimo: number | null
  attesa: number | null
}

/**
 * `video_job_retry` con gli argomenti che il runner passerebbe al PRIMO guasto di un job
 * appena preso (fence 1, lease A, massimo 4, attesa 300 s). Ogni test cambia solo ciò che
 * sta provando.
 */
function ritenta(jobId: string | null, parziali: Partial<ArgomentiRetry> = {}): Promise<Risposta> {
  const a: ArgomentiRetry = {
    fence: 1,
    lease: LEASE_A,
    codice: CODICE,
    massimo: 4,
    attesa: 300,
    ...parziali,
  }
  return rpc(
    `public.video_job_retry(${lit(jobId)}, ${lit(a.fence)}, ${lit(a.lease)}, ` +
      `${lit(a.codice)}, ${lit(a.massimo)}, ${lit(a.attesa)})`,
  )
}

const next = (lease: string, secondi = 300) => rpc(`public.video_job_next('${lease}', ${secondi})`)
const claim = (jobId: string, lease: string, secondi = 300) =>
  rpc(`public.video_job_claim('${jobId}', '${lease}', ${secondi})`)

/**
 * Un intent + il suo job, in `awaiting_upload`.
 *
 * `created_at` si sposta con un UPDATE perché la colonna ha `DEFAULT now()` e dentro una
 * sola transazione `now()` non avanza: senza lo spostamento due job nascerebbero con lo
 * stesso istante e l'ordine della coda sarebbe deciso dal solo tie-break. La sigla finisce
 * dentro un uuid, quindi vale solo l'esadecimale (due cifre).
 */
async function creaJob(
  sigla: string,
  opzioni: { minutiFa?: number } = {},
): Promise<{ intentId: string; jobId: string }> {
  const intentId = `31000000-0000-4000-8000-0000000000${sigla}`
  const jobId = `41000000-0000-4000-8000-0000000000${sigla}`
  const minutiFa = opzioni.minutiFa ?? 0
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
    SET created_at = created_at - interval '${minutiFa} minutes',
        updated_at = updated_at - interval '${minutiFa} minutes'
    WHERE id = '${jobId}';
  `)
  return { intentId, jobId }
}

/** Porta il job in coda (`queued`), come farebbe la fine dell'upload TUS. */
async function accoda(jobId: string) {
  const esito = await rpc(`public.video_job_uploaded('${jobId}', '${OWNER}', 1000, 'video/mp4')`)
  expect(esito.ok, `l'accodamento di ${jobId} doveva riuscire`).toBe(true)
}

/** Un job già PRESO dal worker A: `processing`, attempt 1, fence 1, lease di 300 secondi. */
async function creaJobInLavorazione(
  sigla: string,
  opzioni: { minutiFa?: number } = {},
): Promise<{ intentId: string; jobId: string }> {
  const creato = await creaJob(sigla, opzioni)
  await accoda(creato.jobId)
  const preso = await claim(creato.jobId, LEASE_A)
  expect(preso, `la presa in carico di ${creato.jobId} doveva riuscire`).toMatchObject({
    ok: true,
    job: { status: 'processing', attempt: 1, fence_epoch: 1, lease_owner: LEASE_A },
  })
  return creato
}

/** Fa «passare» l'attesa: porta `next_attempt_at` un secondo nel passato. */
async function rendiDovuto(jobId: string) {
  await db.exec(`
    UPDATE public.video_jobs
    SET next_attempt_at = clock_timestamp() - interval '1 second'
    WHERE id = '${jobId}'
  `)
}

/** Fa scadere la lease del job, come se il worker fosse morto. */
async function scadiLease(jobId: string) {
  await db.exec(`
    UPDATE public.video_jobs
    SET lease_expires_at = clock_timestamp() - interval '1 second'
    WHERE id = '${jobId}'
  `)
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

/** Il database senza nessuna migrazione: i ruoli di Supabase, lo Storage, le due tabelle d'appoggio e il log. */
async function preparaStub() {
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
}

/** La pipeline video come la produzione la avrà dopo questa PR: le migrazioni vecchie e poi i ritentativi. */
async function caricaPipeline() {
  await db.exec(SCHEMA)
  await db.exec(TRANSIZIONI)
  await db.exec(INTENTI)
  await db.exec(NEXT_ORIGINALE)
  await db.exec(RETENTION)
  await db.exec(RITENTATIVI)
}

beforeEach(async () => {
  db = new PGlite()
  await preparaStub()
})

afterEach(async () => {
  await db.close()
})

// ═════════════════════════════════════════════════════════════════════════════
describe('video_job_retry · pipeline completa', () => {
  beforeEach(caricaPipeline)

  // ───────────────────────────────────────────────────────────────────────────
  describe('forma delle funzioni', () => {
    it('sono SECURITY DEFINER, hanno il search_path chiuso e le esegue solo il service role', async () => {
      const { rows } = await db.query<{
        nome: string
        security_definer: boolean
        configurazione: string[]
        argomenti: string
        service: boolean
        anon: boolean
        authenticated: boolean
      }>(`
        SELECT p.proname AS nome,
               p.prosecdef AS security_definer,
               p.proconfig AS configurazione,
               pg_get_function_identity_arguments(p.oid) AS argomenti,
               has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('video_job_retry', 'video_job_next', 'video_job_claim')
        ORDER BY p.proname
      `)

      // Anche `next` e `claim`: sono state riscritte con CREATE OR REPLACE, e se il
      // REVOKE non fosse ripetuto un `anon` potrebbe riprendersi un job della coda.
      expect(rows.map((r) => r.nome)).toEqual(['video_job_claim', 'video_job_next', 'video_job_retry'])
      for (const f of rows) {
        expect(f.security_definer, `${f.nome} non è SECURITY DEFINER`).toBe(true)
        expect(f.configurazione, `${f.nome} ha il search_path aperto`).toContain('search_path=pg_catalog')
        expect(f.service, `${f.nome}: il service role non la può eseguire`).toBe(true)
        expect(f.anon, `${f.nome} è eseguibile da anon`).toBe(false)
        expect(f.authenticated, `${f.nome} è eseguibile da authenticated`).toBe(false)
      }

      // I NOMI dei parametri sono contratto, non decorazione: PostgREST passa gli
      // argomenti di una RPC per nome, quindi rinominarli rompe il chiamante senza
      // cambiare né i tipi né il comportamento.
      const perNome = Object.fromEntries(rows.map((r) => [r.nome, r.argomenti]))
      expect(perNome.video_job_retry).toBe(
        'p_job_id uuid, p_fence_epoch bigint, p_lease_owner uuid, p_error_code text, ' +
          'p_tentativi_massimi integer, p_attesa_secondi integer',
      )
      expect(perNome.video_job_next).toBe('p_lease_owner uuid, p_lease_seconds integer')
      expect(perNome.video_job_claim).toBe('p_job_id uuid, p_lease_owner uuid, p_lease_seconds integer')
    })

    it('prende i lock nello stesso ordine di video_job_fail: prima l’intent, poi il job, poi l’orologio', () => {
      // Lettura del TESTO, e vale quanto vale: su PGlite — una connessione sola — un
      // deadlock non si può osservare. Dice che nel corpo l'intent è bloccato per primo,
      // il job dopo, e che il `clock_timestamp()` per la lease e per l'attesa viene preso
      // DOPO entrambi: un orologio letto prima dei lock nascerebbe già consumato dal tempo
      // d'attesa del lock stesso.
      const corpo = /CREATE OR REPLACE FUNCTION public\.video_job_retry[\s\S]*?\n\$\$;/.exec(RITENTATIVI)
      expect(corpo, 'il corpo di video_job_retry non è stato trovato nel file').not.toBeNull()
      const sql = soloCodice(corpo![0])

      const lockIntent = sql.search(/FOR UPDATE OF i\b/)
      const lockJob = sql.search(/FROM public\.video_jobs\s+WHERE id = p_job_id\s+FOR UPDATE;/)
      const orologio = sql.search(/pg_catalog\.clock_timestamp\(\)/)

      expect(lockIntent, 'manca il FOR UPDATE OF i (il lock sull’intent, che va per primo)').toBeGreaterThan(-1)
      expect(lockJob, 'manca il lock sul job (FOR UPDATE su video_jobs)').toBeGreaterThan(lockIntent)
      expect(orologio, 'l’orologio va letto DOPO entrambi i lock').toBeGreaterThan(lockJob)
    })

    it('le guardie di video_job_retry sono quelle di video_job_fail, byte per byte (cambia solo il nome dell’evento)', () => {
      // Lettura del TESTO, e vale quanto vale. Le guardie di proprietà del job (rilettura
      // dell'intent, fence, stato, lease) sono quelle di `video_job_fail`: spec §4.7, lock
      // intent → job come `video_job_fail`. Da vivo non si prova `INTENT_CHANGED_RETRY` (nasce
      // solo con due transazioni in volo, vedi la testata del file), e l'ordine fra due rifiuti
      // lo prova un test per ogni coppia che qualcuno ha pensato di scrivere. Il confronto le
      // copre tutte insieme: due tratti, dal lock sull'intent al fence e da INVALID_STATE alla
      // lease scaduta, IDENTICI a quelli di `fail` salvo il nome dell'evento. Non dice che
      // `fail` sia giusto: dice che `retry` non se ne allontana.
      const corpoFail = /CREATE OR REPLACE FUNCTION public\.video_job_fail\([\s\S]*?\n\$\$;/.exec(TRANSIZIONI)
      const corpoRetry = /CREATE OR REPLACE FUNCTION public\.video_job_retry\([\s\S]*?\n\$\$;/.exec(RITENTATIVI)
      expect(corpoFail, 'il corpo di video_job_fail non è stato trovato nelle transizioni').not.toBeNull()
      expect(corpoRetry, 'il corpo di video_job_retry non è stato trovato nel file dei ritentativi').not.toBeNull()

      // L'unica differenza ammessa è il nome dell'evento loggato: si riporta `fail` a quello di retry.
      const testoFail = soloCodice(corpoFail![0]).split("'video-job-fail'").join("'video-job-retry'")
      const testoRetry = soloCodice(corpoRetry![0])

      /** Da `inizio` alla fine di `fine`, compresa. Ciascuno dei due deve comparire UNA volta sola. */
      const tratto = (testo: string, inizio: string, fine: string): string => {
        const volte = (pezzo: string) => testo.split(pezzo).length - 1
        expect(volte(inizio), `l'inizio ${JSON.stringify(inizio)} deve comparire una volta sola`).toBe(1)
        expect(volte(fine), `la fine ${JSON.stringify(fine)} deve comparire una volta sola`).toBe(1)
        const i = testo.indexOf(inizio)
        const f = testo.indexOf(fine, i)
        expect(f, `la fine ${JSON.stringify(fine)} deve stare DOPO l'inizio del tratto`).toBeGreaterThan(-1)
        return testo.slice(i, f + fine.length)
      }

      const INIZIO_A = '  SELECT i.* INTO v_intent\n'
      const FINE_A = "RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'FENCE_MISMATCH');\n  END IF;\n"
      const INIZIO_B = "  IF v_job.status <> 'processing' THEN\n"
      const FINE_B = "RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'LEASE_EXPIRED');\n  END IF;\n"

      const aFail = tratto(testoFail, INIZIO_A, FINE_A)
      const bFail = tratto(testoFail, INIZIO_B, FINE_B)

      // I controlli positivi dell'estrattore: se non pescasse i tratti veri, i due confronti qui
      // sotto sarebbero fra stringhe qualunque, e verdi per costruzione.
      expect(aFail).toContain('FOR UPDATE OF i')
      expect(aFail).toContain('INTENT_CHANGED_RETRY')
      expect(bFail).toContain('LEASE_MISMATCH')

      expect(
        tratto(testoRetry, INIZIO_A, FINE_A),
        'dal lock sull’intent al fence (NOT_FOUND, INTENT_CHANGED_RETRY, FENCE_MISMATCH) video_job_retry non è più identica a video_job_fail',
      ).toBe(aFail)
      expect(
        tratto(testoRetry, INIZIO_B, FINE_B),
        'da INVALID_STATE alla lease scaduta (LEASE_MISMATCH prima di LEASE_EXPIRED) video_job_retry non è più identica a video_job_fail',
      ).toBe(bFail)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe('il percorso normale: un guasto nostro rimette il job in coda', () => {
    it('processing → queued con la sua attesa, il codice annotato e la lease sciolta', async () => {
      const { jobId } = await creaJobInLavorazione('a1')

      // `updated_at` della presa in carico viene portato un'ora nel passato, e con lui
      // `created_at`: `video_jobs_tempi_chk` pretende `updated_at >= created_at`, e spostare
      // una colonna sola farebbe lanciare l'UPDATE. Senza lo spostamento la presa in carico e
      // la rimessa in coda starebbero a pochi millisecondi l'una dall'altra, e una rimessa
      // in coda che NON riscrive `updated_at` darebbe lo stesso risultato di una che lo
      // riscrive: con l'ora di distanza le due strade si distinguono.
      await db.exec(`
        UPDATE public.video_jobs
        SET created_at = created_at - interval '1 hour',
            updated_at = updated_at - interval '1 hour'
        WHERE id = '${jobId}'
      `)

      const esito = await ritenta(jobId)
      expect(esito).toMatchObject({
        ok: true,
        job: {
          id: jobId,
          status: 'queued',
          // Né `attempt` né `fence_epoch` cambiano qui: li alza `video_job_claim`.
          attempt: 1,
          fence_epoch: 1,
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: CODICE,
          // Il job NON è fallito: nessun `error_code`, e quindi nessun «fallito» per l'insegnante.
          error_code: null,
          // Non è concluso: l'originale serve ancora per il tentativo dopo.
          original_delete_after: null,
        },
      })
      expect(esito.job?.next_attempt_at, 'manca l’attesa').toEqual(expect.any(String))

      // Due fatti, letti dal database e non dalla risposta. (1) L'attesa è ESATTAMENTE quella
      // chiesta: `next_attempt_at` e `updated_at` nascono dallo stesso `v_now`, quindi la
      // differenza è di 300 secondi netti, al microsecondo. Un `EXTRACT(EPOCH …)::int`
      // l'avrebbe arrotondata, e avrebbe accettato anche due istanti a pochi millisecondi
      // uno dall'altro. (2) `updated_at` è stato RISCRITTO dalla rimessa in coda: è di pochi
      // istanti fa, non l'ora indietro a cui l'ha portato l'UPDATE qui sopra. Se la rimessa
      // in coda non lo scrivesse, cadrebbero tutte e due le verità (l'attesa sarebbe misurata
      // da un'ora fa), e la retention, che dichiara «incagliato» un job dal suo `updated_at`,
      // lo vedrebbe vecchio di un'ora mentre sta solo aspettando i suoi cinque minuti.
      const dopo = await unaRiga<{ esatta: boolean; recente: boolean }>(`
        SELECT next_attempt_at - updated_at = interval '300 seconds' AS esatta,
               updated_at > clock_timestamp() - interval '1 minute' AS recente
        FROM public.video_jobs WHERE id = '${jobId}'
      `)
      expect(dopo).toEqual({ esatta: true, recente: true })
    })

    it('accetta i confini: l’attesa va da 1 a 86400 secondi, il massimo da 1 a 10', async () => {
      const a = await creaJobInLavorazione('a2')
      expect(await ritenta(a.jobId, { massimo: 10, attesa: 1 })).toMatchObject({
        ok: true,
        job: { status: 'queued' },
      })
      expect(
        (await unaRiga<{ attesa_s: number }>(
          `SELECT EXTRACT(EPOCH FROM (next_attempt_at - updated_at))::int AS attesa_s
           FROM public.video_jobs WHERE id = '${a.jobId}'`,
        )).attesa_s,
      ).toBe(1)

      const b = await creaJobInLavorazione('a3')
      expect(await ritenta(b.jobId, { massimo: 10, attesa: 86400 })).toMatchObject({
        ok: true,
        job: { status: 'queued' },
      })
      expect(
        (await unaRiga<{ attesa_s: number }>(
          `SELECT EXTRACT(EPOCH FROM (next_attempt_at - updated_at))::int AS attesa_s
           FROM public.video_jobs WHERE id = '${b.jobId}'`,
        )).attesa_s,
      ).toBe(86400)
    })

    it('un job in attesa NON si pesca: next risponde EMPTY_QUEUE, non RETRY_NOT_DUE', async () => {
      const { jobId } = await creaJobInLavorazione('b1')
      await ritenta(jobId)

      // Se `video_job_next` non filtrasse l'attesa, sceglierebbe il job e sarebbe
      // `video_job_claim` a rifiutarlo con RETRY_NOT_DUE: stesso risultato per questo
      // job, ma un candidato per chiamata significherebbe una coda INTERA ferma (vedi il
      // test dopo). Qui si prova la forma: «niente da fare», non «rifiutato».
      expect(await next(LEASE_B)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
      expect((await riga(jobId)).status).toBe('queued')

      // E si dice a livello `info`: la coda è tranquilla, non rotta.
      expect(await livelliLoggati('video-job-next')).toEqual(['info'])
      expect(await contestiLoggati('video-job-next')).toEqual([{ code: 'EMPTY_QUEUE' }])
    })

    it('next SALTA il job in attesa e prende quello più recente già pronto', async () => {
      // Il caso per cui il filtro sta in `video_job_next` e non solo in claim: il job
      // in attesa è il PIÙ VECCHIO, quindi sarebbe il primo candidato. Se fosse scelto,
      // claim lo rifiuterebbe e `next` — che non scorre la coda — risponderebbe un
      // errore anche col job pronto subito dietro.
      const vecchio = await creaJobInLavorazione('b2', { minutiFa: 30 })
      await ritenta(vecchio.jobId)
      const prima = await riga(vecchio.jobId)

      const recente = await creaJob('b3', { minutiFa: 5 })
      await accoda(recente.jobId)

      expect(await next(LEASE_B)).toMatchObject({
        ok: true,
        job: { id: recente.jobId, status: 'processing', attempt: 1, fence_epoch: 1, lease_owner: LEASE_B },
      })

      // Il job in attesa non è stato toccato: stessa attesa, stesso stato.
      const dopo = await riga(vecchio.jobId)
      expect(dopo.status).toBe('queued')
      expect(dopo.attempt).toBe(1)
      expect(dopo.next_attempt_at?.getTime()).toBe(prima.next_attempt_at?.getTime())
    })

    it('tra due job in attesa prende quello DOVUTO, anche se è il più recente', async () => {
      // Il caso complementare: i job in attesa sono DUE, il più vecchio aspetta ancora e
      // solo il più recente ha finito. La coda non è ferma dietro al primo.
      const vecchio = await creaJobInLavorazione('b9', { minutiFa: 40 })
      await ritenta(vecchio.jobId)
      const recente = await creaJobInLavorazione('ba', { minutiFa: 20 })
      await ritenta(recente.jobId)
      await rendiDovuto(recente.jobId)

      expect(await next(LEASE_B)).toMatchObject({
        ok: true,
        job: { id: recente.jobId, attempt: 2, fence_epoch: 2, lease_owner: LEASE_B },
      })
      // E il vecchio resta lì ad aspettare: non è dovuto, e la coda risponde «niente da fare».
      expect(await next(LEASE_C)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
      expect((await riga(vecchio.jobId)).status).toBe('queued')
    })

    it('finita l’attesa next lo riprende: attempt + 1, fence + 1, attesa azzerata', async () => {
      const { jobId } = await creaJobInLavorazione('b4')
      await ritenta(jobId)
      await rendiDovuto(jobId)

      expect(await next(LEASE_B)).toMatchObject({
        ok: true,
        job: {
          id: jobId,
          status: 'processing',
          attempt: 2,
          fence_epoch: 2,
          lease_owner: LEASE_B,
          next_attempt_at: null,
        },
      })

      const riga2 = await riga(jobId)
      expect(riga2.next_attempt_at).toBeNull()
      // Il codice del guasto resta sulla riga come traccia: è per questo che
      // l'idempotenza guarda anche l'attesa, e non solo il codice.
      expect(riga2.last_error_code).toBe(CODICE)
      // Ancora non concluso: nessuna scadenza dell'originale.
      expect(riga2.original_delete_after).toBeNull()
    })

    it('un job dovuto, più vecchio di uno già pronto, passa per primo: la coda resta FIFO per created_at', async () => {
      const vecchio = await creaJobInLavorazione('b5', { minutiFa: 40 })
      await ritenta(vecchio.jobId)
      await rendiDovuto(vecchio.jobId)
      const recente = await creaJob('b6', { minutiFa: 5 })
      await accoda(recente.jobId)

      // Il ritentativo NON riparte come un job nuovo: conserva `created_at`, quindi il
      // suo posto in coda. Altrimenti un video in ritentativo passerebbe sempre dietro
      // a tutti quelli arrivati nel frattempo.
      expect(await next(LEASE_B)).toMatchObject({ ok: true, job: { id: vecchio.jobId, attempt: 2 } })
      expect(await next(LEASE_C)).toMatchObject({ ok: true, job: { id: recente.jobId, attempt: 1 } })
    })

    it('un claim per id su un job in attesa risponde RETRY_NOT_DUE e non lo tocca', async () => {
      const { jobId } = await creaJobInLavorazione('b7')
      await ritenta(jobId)
      const prima = await riga(jobId)

      expect(await claim(jobId, LEASE_B)).toEqual({ ok: false, code: 'RETRY_NOT_DUE' })

      const dopo = await riga(jobId)
      expect(dopo.status).toBe('queued')
      expect(dopo.attempt).toBe(1)
      expect(dopo.fence_epoch).toBe(1)
      expect(dopo.lease_owner).toBeNull()
      expect(dopo.next_attempt_at?.getTime()).toBe(prima.next_attempt_at?.getTime())

      // Una prima presa riuscita (info) e un rifiuto (error), nell'ordine; e il rifiuto
      // porta il suo codice.
      expect(await livelliLoggati('video-job-claim')).toEqual(['info', 'error'])
      const contesti = await contestiLoggati('video-job-claim')
      expect(contesti[1]).toMatchObject({ job_id: jobId, code: 'RETRY_NOT_DUE' })

      // Passata l'attesa lo stesso claim riesce.
      await rendiDovuto(jobId)
      expect(await claim(jobId, LEASE_B)).toMatchObject({
        ok: true,
        job: { attempt: 2, fence_epoch: 2, lease_owner: LEASE_B, next_attempt_at: null },
      })
    })

    it('un job che non ha mai aspettato si prende come prima (next_attempt_at NULL non lo blocca)', async () => {
      // Il controllo negativo del filtro: se `NULL <= v_now` fosse trattato come falso, ogni
      // job nuovo resterebbe in coda per sempre — cioè la pipeline intera ferma.
      const nuovo = await creaJob('b8')
      await accoda(nuovo.jobId)
      expect(await next(LEASE_A)).toMatchObject({
        ok: true,
        job: { id: nuovo.jobId, status: 'processing', attempt: 1, fence_epoch: 1 },
      })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe('i tentativi finiscono: quattro in tutto, poi failed', () => {
    it('il quarto guasto chiude il job: failed, error_code, scadenza dell’originale a sette giorni', async () => {
      const { jobId } = await creaJobInLavorazione('c1')
      const leasePerTentativo = [LEASE_A, LEASE_B, LEASE_C, LEASE_D]

      // Tre ritentativi dopo il primo: i guasti dei tentativi 1, 2 e 3 rimettono in coda…
      for (let n = 1; n <= 3; n++) {
        const lease = leasePerTentativo[n - 1]
        expect(await ritenta(jobId, { fence: n, lease, massimo: 4 })).toMatchObject({
          ok: true,
          job: { status: 'queued', attempt: n, fence_epoch: n, original_delete_after: null },
        })
        await rendiDovuto(jobId)
        expect(await next(leasePerTentativo[n])).toMatchObject({
          ok: true,
          job: { id: jobId, status: 'processing', attempt: n + 1, fence_epoch: n + 1 },
        })
      }

      // …e il guasto del quarto è definitivo.
      const fine = await ritenta(jobId, { fence: 4, lease: LEASE_D, massimo: 4 })
      expect(fine).toMatchObject({
        ok: true,
        job: {
          status: 'failed',
          error_code: CODICE,
          last_error_code: CODICE,
          attempt: 4,
          fence_epoch: 4,
          lease_owner: null,
          lease_expires_at: null,
          next_attempt_at: null,
        },
      })

      // La scadenza la scrive `video_job_fail`: sette giorni dallo stesso istante
      // dell'`updated_at`. Senza, la riga resterebbe fuori dall'indice della retention.
      // Si misura in SECONDI, con un'ora di tolleranza: un `interval '7 days'` sommato a un
      // timestamptz è un'addizione di giorni di calendario, e in un fuso con l'ora legale
      // sono 168 ore tranne la settimana in cui l'ora cambia. Il test non deve dipendere
      // dal fuso né dal giorno in cui gira.
      const scadenza = await unaRiga<{ presente: boolean; secondi: number }>(`
        SELECT original_delete_after IS NOT NULL AS presente,
               EXTRACT(EPOCH FROM (original_delete_after - updated_at))::int AS secondi
        FROM public.video_jobs WHERE id = '${jobId}'
      `)
      expect(scadenza.presente).toBe(true)
      expect(scadenza.secondi).toBeGreaterThanOrEqual(7 * 86400 - 3600)
      expect(scadenza.secondi).toBeLessThanOrEqual(7 * 86400 + 3600)

      // E dopo il fallimento definitivo la coda è vuota: nessun ritentativo fantasma.
      await rendiDovuto(jobId)
      expect(await next(LEASE_A)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
    })

    it('con un massimo di 1 il primo guasto è già definitivo (il confine è >=, non >)', async () => {
      const { jobId } = await creaJobInLavorazione('c2')
      // Qui il guasto che chiude è anche il PRIMO: `last_error_code` può valere CODICE solo
      // se l'esaurimento lo annota prima di lasciar chiudere a `video_job_fail` (nel giro
      // da quattro tentativi ce l'hanno già messo i ritentativi precedenti, e la riga
      // mancante passerebbe inosservata).
      expect(await ritenta(jobId, { massimo: 1 })).toMatchObject({
        ok: true,
        job: { status: 'failed', error_code: CODICE, last_error_code: CODICE, attempt: 1 },
      })
      const chiuso = await riga(jobId)
      expect(chiuso.last_error_code).toBe(CODICE)
      expect(chiuso.original_delete_after).not.toBeNull()
    })

    it('con un massimo di 2 il primo guasto ritenta e il secondo chiude', async () => {
      const { jobId } = await creaJobInLavorazione('c3')
      expect(await ritenta(jobId, { massimo: 2 })).toMatchObject({ ok: true, job: { status: 'queued' } })
      await rendiDovuto(jobId)
      await next(LEASE_B)
      expect(await ritenta(jobId, { fence: 2, lease: LEASE_B, massimo: 2 })).toMatchObject({
        ok: true,
        job: { status: 'failed', attempt: 2 },
      })
    })

    it('ripetuta dopo il fallimento definitivo è idempotente, e un altro codice è un conflitto', async () => {
      const { jobId } = await creaJobInLavorazione('c4')
      await ritenta(jobId, { massimo: 1 })
      const prima = await riga(jobId)

      // Stesso codice: la chiamata persa e ripetuta riceve ok, e la scadenza NON si riscrive.
      expect(await ritenta(jobId, { massimo: 1 })).toMatchObject({ ok: true, job: { status: 'failed' } })
      const dopo = await riga(jobId)
      expect(dopo.original_delete_after?.getTime()).toBe(prima.original_delete_after?.getTime())
      expect(dopo.updated_at.getTime()).toBe(prima.updated_at.getTime())

      // Un altro guasto su un job già chiuso non lo riapre né lo riscrive.
      expect(await ritenta(jobId, { massimo: 1, codice: ALTRO_CODICE })).toEqual({
        ok: false,
        code: 'ERROR_CONFLICT',
      })
      expect((await riga(jobId)).error_code).toBe(CODICE)
    })

    it('un job rifiutato (rejected) non si ritenta: è il file ad essere sbagliato', async () => {
      const { jobId } = await creaJobInLavorazione('c5')
      expect(
        await rpc(`public.video_job_fail('${jobId}', 1, '${LEASE_A}', 'CODEC_UNSUPPORTED', true)`),
      ).toMatchObject({ ok: true, job: { status: 'rejected' } })

      expect(await ritenta(jobId)).toEqual({ ok: false, code: 'ERROR_CONFLICT' })
      expect((await riga(jobId)).status).toBe('rejected')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe('i rifiuti: nessun effetto, e il verdetto giusto', () => {
    it('FENCE_MISMATCH, LEASE_MISMATCH e LEASE_EXPIRED lasciano il job com’era', async () => {
      const { jobId } = await creaJobInLavorazione('d1')
      const prima = await riga(jobId)

      expect(await ritenta(jobId, { fence: 2 })).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
      expect(await ritenta(jobId, { lease: LEASE_B })).toEqual({ ok: false, code: 'LEASE_MISMATCH' })
      expect(await riga(jobId)).toEqual(prima)

      await scadiLease(jobId)
      const scaduto = await riga(jobId)
      expect(await ritenta(jobId)).toEqual({ ok: false, code: 'LEASE_EXPIRED' })
      expect(await riga(jobId)).toEqual(scaduto)

      // Tutti e tre sono rifiuti del database, e vanno a `error`: il runner li legge come
      // «il job non è più mio» e non scrive niente.
      expect(await livelliLoggati('video-job-retry')).toEqual(['error', 'error', 'error'])
    })

    it('al tentativo massimo la lease si controlla PRIMA dell’esaurimento: i rifiuti non annotano niente', async () => {
      // L'ordine 5→6 del contratto. L'esaurimento (`attempt >= massimo`) SCRIVE: annota
      // `last_error_code` e `updated_at` prima di lasciar chiudere a `video_job_fail`. Se
      // venisse prima dei controlli sulla lease, chi non è più il proprietario del job, o ha
      // la lease scaduta, riceverebbe il suo rifiuto dopo aver lasciato la propria traccia
      // sulla riga di un altro. Il test qui sopra non lo vede: ha un massimo di 4 e un job al
      // primo tentativo, quindi l'esaurimento non lo raggiunge mai. Qui il massimo è 1, e il
      // primo tentativo è già l'ultimo.
      const { jobId } = await creaJobInLavorazione('d7')
      const prima = await riga(jobId)

      expect(await ritenta(jobId, { massimo: 1, lease: LEASE_B })).toEqual({ ok: false, code: 'LEASE_MISMATCH' })
      expect(await riga(jobId)).toEqual(prima)

      await scadiLease(jobId)
      const scaduto = await riga(jobId)
      expect(await ritenta(jobId, { massimo: 1 })).toEqual({ ok: false, code: 'LEASE_EXPIRED' })
      expect(await riga(jobId)).toEqual(scaduto)
      // Il controllo positivo: la riga di partenza non ha nessun codice annotato, quindi
      // «uguale a prima» vuol dire davvero «niente scritto».
      expect(scaduto.last_error_code).toBeNull()
    })

    // L'ordine dei due rifiuti sulla lease è quello di `video_job_fail`: prima «non è la tua»
    // (LEASE_MISMATCH), poi «è scaduta» (LEASE_EXPIRED). Il test «FENCE_MISMATCH,
    // LEASE_MISMATCH e LEASE_EXPIRED…» non lo vede: prova i due rifiuti uno alla volta, mai
    // una lease che sia insieme di un altro E scaduta.
    it('LEASE_MISMATCH viene prima di LEASE_EXPIRED: la lease di un altro, anche scaduta, è un rifiuto di proprietà', async () => {
      const { jobId } = await creaJobInLavorazione('d8')
      await scadiLease(jobId)
      const prima = await riga(jobId)

      expect(await ritenta(jobId, { lease: LEASE_B })).toEqual({ ok: false, code: 'LEASE_MISMATCH' })
      expect(await riga(jobId)).toEqual(prima)
    })

    it('INVALID_STATE: un job che non sta lavorando non si ritenta (awaiting_upload, queued mai fallito, ready)', async () => {
      const inAttesaDiUpload = await creaJob('d2')
      expect(await ritenta(inAttesaDiUpload.jobId, { fence: 0 })).toEqual({ ok: false, code: 'INVALID_STATE' })

      // `queued` ma mai fallito: niente `last_error_code`, niente attesa. Non è una
      // ripetizione di un ritentativo già riuscito, e va rifiutato.
      const inCoda = await creaJob('d3')
      await accoda(inCoda.jobId)
      expect(await ritenta(inCoda.jobId, { fence: 0 })).toEqual({ ok: false, code: 'INVALID_STATE' })

      const pronto = await creaJobInLavorazione('d4')
      expect(
        await rpc(`public.video_job_ready(
          '${pronto.jobId}', 1, '${LEASE_A}', 'outputs/d4/final.mp4', 900,
          '{"durationSeconds":12}'::jsonb
        )`),
      ).toMatchObject({ ok: true, job: { status: 'ready' } })
      expect(await ritenta(pronto.jobId)).toEqual({ ok: false, code: 'INVALID_STATE' })
      expect((await riga(pronto.jobId)).status).toBe('ready')
    })

    it('NOT_FOUND: un job che non esiste', async () => {
      expect(await ritenta(INESISTENTE)).toEqual({ ok: false, code: 'NOT_FOUND' })
      expect(await livelliLoggati('video-job-retry')).toEqual(['error'])
    })

    it('BAD_INPUT: argomenti assenti, codice malformato, massimo e attesa fuori misura', async () => {
      const { jobId } = await creaJobInLavorazione('d5')
      const prima = await riga(jobId)

      // Ogni caso è una funzione: le chiamate partono una alla volta, nell'ordine scritto.
      const casi: [string, () => Promise<Risposta>][] = [
        ['job nullo', () => ritenta(null)],
        ['fence nullo', () => ritenta(jobId, { fence: null })],
        ['lease nulla', () => ritenta(jobId, { lease: null })],
        ['codice nullo', () => ritenta(jobId, { codice: null })],
        ['codice vuoto', () => ritenta(jobId, { codice: '' })],
        ['codice minuscolo', () => ritenta(jobId, { codice: 'build_download_failed' })],
        ['codice con uno spazio', () => ritenta(jobId, { codice: 'BUILD FAILED' })],
        ['codice che comincia con una cifra', () => ritenta(jobId, { codice: '1BUILD' })],
        ['codice di 81 caratteri', () => ritenta(jobId, { codice: 'A'.repeat(81) })],
        ['massimo nullo', () => ritenta(jobId, { massimo: null })],
        ['massimo 0', () => ritenta(jobId, { massimo: 0 })],
        ['massimo 11', () => ritenta(jobId, { massimo: 11 })],
        ['attesa nulla', () => ritenta(jobId, { attesa: null })],
        ['attesa 0', () => ritenta(jobId, { attesa: 0 })],
        ['attesa 86401', () => ritenta(jobId, { attesa: 86401 })],
      ]
      for (const [nome, chiama] of casi) {
        expect(await chiama(), nome).toEqual({ ok: false, code: 'BAD_INPUT' })
      }

      // Nessun effetto: il job è ancora quello che era, e ogni rifiuto è a livello `error`.
      expect(await riga(jobId)).toEqual(prima)
      expect(await livelliLoggati('video-job-retry')).toEqual(casi.map(() => 'error'))
    })

    it('un codice di esattamente 80 caratteri è ammesso (il confine del formato)', async () => {
      const { jobId } = await creaJobInLavorazione('d6')
      const ottanta = 'E'.repeat(80)
      expect(await ritenta(jobId, { codice: ottanta })).toMatchObject({
        ok: true,
        job: { status: 'queued', last_error_code: ottanta },
      })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe('idempotenza: una chiamata persa e ripetuta non sposta l’attesa', () => {
    it('la seconda chiamata identica risponde ok e lascia la riga intatta, attesa compresa', async () => {
      const { jobId } = await creaJobInLavorazione('e1')
      const prima = await ritenta(jobId)
      expect(prima).toMatchObject({ ok: true, job: { status: 'queued' } })
      const dopoLaPrima = await riga(jobId)

      const seconda = await ritenta(jobId)
      expect(seconda).toMatchObject({
        ok: true,
        job: { id: jobId, status: 'queued', attempt: 1, fence_epoch: 1, last_error_code: CODICE },
      })

      // La prova vera: l'attesa NON si è spostata. Senza il ramo idempotente, il secondo
      // giro la rimetterebbe a +300 s da adesso — e un ritentativo di rete sul trasporto
      // allungherebbe di altri minuti l'attesa di un'insegnante.
      const dopoLaSeconda = await riga(jobId)
      expect(dopoLaSeconda.next_attempt_at?.getTime()).toBe(dopoLaPrima.next_attempt_at?.getTime())
      expect(dopoLaSeconda.updated_at.getTime()).toBe(dopoLaPrima.updated_at.getTime())

      // Un warn per il ritentativo vero, un info per la ripetizione.
      expect(await livelliLoggati('video-job-retry')).toEqual(['warn', 'info'])
      expect((await contestiLoggati('video-job-retry'))[1]).toMatchObject({ idempotent: true, job_id: jobId })
    })

    it('un codice DIVERSO su un job già in attesa non è una ripetizione: INVALID_STATE', async () => {
      const { jobId } = await creaJobInLavorazione('e2')
      await ritenta(jobId)
      const prima = await riga(jobId)

      expect(await ritenta(jobId, { codice: ALTRO_CODICE })).toEqual({ ok: false, code: 'INVALID_STATE' })
      expect(await riga(jobId)).toEqual(prima)
    })

    it('un fence VECCHIO su un job rimesso in coda con lo STESSO codice è FENCE_MISMATCH, non una ripetizione', async () => {
      // L'ordine 2→3 del contratto: il fence si controlla PRIMA dell'idempotenza. Perché un
      // fence vecchio possa essere scambiato per una ripetizione serve un job `queued`, con lo
      // stesso codice e la sua attesa, il cui fence però è già andato avanti: succede dopo DUE
      // ritentativi. Il primo rimette in coda, la presa in carico successiva porta il fence a
      // 2, il secondo rimette in coda col fence 2 e lo stesso codice. A quel punto il worker
      // del primo tentativo (fence 1), svegliatosi tardi, richiama con lo stesso codice: se
      // l'idempotenza venisse prima del fence riceverebbe ok per un ritentativo che non è
      // suo, e il runner lo registrerebbe come proprio.
      const { jobId } = await creaJobInLavorazione('e4')
      await ritenta(jobId)
      await rendiDovuto(jobId)
      expect(await next(LEASE_B)).toMatchObject({ ok: true, job: { fence_epoch: 2 } })
      expect(await ritenta(jobId, { fence: 2, lease: LEASE_B })).toMatchObject({
        ok: true,
        job: { status: 'queued' },
      })
      const prima = await riga(jobId)

      // Stesso codice, stesso job, già `queued` con la sua attesa: se il fence non venisse
      // per primo questa sarebbe la ripetizione idempotente. È invece il worker di prima.
      expect(await ritenta(jobId)).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
      expect(await riga(jobId)).toEqual(prima)
    })

    it('chi ha perso il job non può più chiuderlo: INVALID_STATE finché aspetta, FENCE_MISMATCH dopo la nuova presa', async () => {
      const { jobId } = await creaJobInLavorazione('e3')
      await ritenta(jobId)

      const pronto = (fence: number) =>
        rpc(`public.video_job_ready(
          '${jobId}', ${fence}, '${LEASE_A}', 'outputs/e3/stale.mp4', 900,
          '{"durationSeconds":12}'::jsonb
        )`)
      const fallito = (fence: number) =>
        rpc(`public.video_job_fail('${jobId}', ${fence}, '${LEASE_A}', 'ENCODE_FAILED', false)`)

      // Mentre il job aspetta, il fence è ancora 1 ma lo stato è `queued`: il worker di prima
      // non scrive niente.
      expect(await pronto(1)).toEqual({ ok: false, code: 'INVALID_STATE' })
      expect(await fallito(1)).toEqual({ ok: false, code: 'INVALID_STATE' })

      // Alla presa in carico successiva il fence sale a 2, e il fence 1 non vale più.
      await rendiDovuto(jobId)
      expect(await next(LEASE_B)).toMatchObject({ ok: true, job: { fence_epoch: 2 } })
      expect(await pronto(1)).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
      expect(await fallito(1)).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
      expect((await riga(jobId)).status).toBe('processing')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe('un job in attesa e il resto della pipeline', () => {
    it('video_job_cancel lo annulla: cancelled, scadenza all’originale, e nessuno lo riprende più', async () => {
      const { jobId } = await creaJobInLavorazione('f1')
      await ritenta(jobId)

      expect(await rpc(`public.video_job_cancel('${jobId}', '${OWNER}')`)).toMatchObject({
        ok: true,
        job: { status: 'cancelled', fence_epoch: 2 },
      })
      const annullato = await riga(jobId)
      expect(annullato.status).toBe('cancelled')
      // Il job annullato ha la sua scadenza: altrimenti il suo originale resterebbe fuori
      // dall'indice della retention per sempre.
      expect(annullato.original_delete_after).not.toBeNull()

      // Anche se l'attesa è passata, il job chiuso non torna in coda né si riprende.
      await rendiDovuto(jobId)
      expect(await next(LEASE_B)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
      expect((await claim(jobId, LEASE_B)).ok).toBe(false)
      expect((await riga(jobId)).status).toBe('cancelled')
    })

    it('video_intent_supersede lo spegne: cancelled, scadenza all’originale', async () => {
      const { jobId, intentId } = await creaJobInLavorazione('f2')
      await ritenta(jobId)

      expect(
        await rpc(`public.video_intent_supersede(
          '${intentId}', '${OWNER}', 1, '${NUOVA_REVISIONE}', NULL, NULL, NULL
        )`),
      ).toMatchObject({ ok: true, job_spenti: 1 })

      const spento = await riga(jobId)
      expect(spento.status).toBe('cancelled')
      expect(spento.original_delete_after).not.toBeNull()

      await rendiDovuto(jobId)
      expect(await next(LEASE_B)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
    })

    it('video_intent_revoke lo cancella: cancelled, scadenza all’originale', async () => {
      const { jobId, intentId } = await creaJobInLavorazione('f3')
      await ritenta(jobId)

      expect(await rpc(`public.video_intent_revoke('${intentId}', '${OWNER}', 1)`)).toMatchObject({
        ok: true,
        job_cancellati: 1,
      })

      const cancellato = await riga(jobId)
      expect(cancellato.status).toBe('cancelled')
      expect(cancellato.original_delete_after).not.toBeNull()

      await rendiDovuto(jobId)
      expect(await next(LEASE_B)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
    })

    it('video_retention_scadenze (b): l’attesa di pochi minuti non è un incaglio, ma un’attesa dimenticata sì', async () => {
      const { jobId } = await creaJobInLavorazione('f4')
      await ritenta(jobId)

      // Appena rimesso in coda: `updated_at` è adesso, quindi non è «incagliato» —
      // altrimenti la retention dichiarerebbe fallito un video che sta solo aspettando
      // i suoi cinque minuti.
      expect(await rpc('public.video_retention_scadenze(48, 1, 100)')).toMatchObject({
        ok: true,
        abbandonati: 0,
        incagliati: 0,
        senza_scadenza: 0,
      })
      expect((await riga(jobId)).status).toBe('queued')

      // Fermo da cinque ore, senza lease: la rete lo dichiara incagliato. Il vincolo che
      // un'attesa lasciata sulla riga potrebbe rompere NON esiste: l'UPDATE riesce.
      await db.exec(`
        UPDATE public.video_jobs
        SET created_at = created_at - interval '5 hours',
            updated_at = updated_at - interval '5 hours'
        WHERE id = '${jobId}'
      `)
      expect(await rpc('public.video_retention_scadenze(48, 1, 100)')).toMatchObject({
        ok: true,
        incagliati: 1,
      })

      const chiuso = await riga(jobId)
      expect(chiuso.status).toBe('failed')
      expect(chiuso.error_code).toBe('CONVERSIONE_INCAGLIATA')
      expect(chiuso.original_delete_after).not.toBeNull()
    })

    it('video_riconciliazione conta un job in attesa fra quelli in coda (solo un conteggio, dichiarato)', async () => {
      const { jobId } = await creaJobInLavorazione('f5', { minutiFa: 120 })
      await ritenta(jobId)

      // `in_coda_in_ritardo` guarda `created_at`: un video che aspetta il suo ritentativo
      // dopo due ore di vita risulta «in ritardo». È un conteggio, non una decisione: non
      // cambia lo stato di niente (la spec lo annota fra i rischi).
      expect(await rpc('public.video_riconciliazione(48, 168, 1)')).toMatchObject({
        ok: true,
        in_coda: 1,
        in_coda_in_ritardo: 1,
        incagliati: 0,
      })
      expect((await riga(jobId)).status).toBe('queued')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe('osservabilità', () => {
    it('logga il ritentativo a livello warn con soli identificatori, codici e numeri', async () => {
      const { jobId, intentId } = await creaJobInLavorazione('91')
      await ritenta(jobId)

      expect(await livelliLoggati('video-job-retry')).toEqual(['warn'])
      expect(await contestiLoggati('video-job-retry')).toEqual([
        {
          job_id: jobId,
          intent_id: intentId,
          attempt: 1,
          fence_epoch: 1,
          error_code: CODICE,
          tentativi_massimi: 4,
          attesa_secondi: 300,
        },
      ])

      // Sono video di minori: il percorso dell'originale e il MIME dichiarato dal telefono
      // non devono comparire da nessuna parte nel log.
      const { rows } = await db.query<{ testo: string }>(
        `SELECT payload::text AS testo FROM public.log_migrazioni`,
      )
      for (const r of rows) {
        expect(r.testo).not.toContain('originals/91/source')
        expect(r.testo).not.toContain('video/mp4')
      }
    })

    it('a tentativi esauriti il fallimento definitivo lo logga video_job_fail, con il codice', async () => {
      const { jobId } = await creaJobInLavorazione('92')
      await ritenta(jobId, { massimo: 1 })

      const contesti = await contestiLoggati('video-job-fail')
      expect(contesti).toHaveLength(1)
      expect(contesti[0]).toMatchObject({ job_id: jobId, status: 'failed', attempt: 1, error_code: CODICE })
      // Nessun `video-job-retry` per il fallimento: la decisione «definitivo» ha un autore solo.
      expect(await livelliLoggati('video-job-retry')).toEqual([])
    })

    it('un logger che esplode non ferma il ritentativo (fail-open)', async () => {
      const { jobId } = await creaJobInLavorazione('93')
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.app_log_registra(righe jsonb)
        RETURNS int LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'logger non disponibile';
        END $$
      `)

      expect(await ritenta(jobId)).toMatchObject({ ok: true, job: { status: 'queued', last_error_code: CODICE } })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe('le due funzioni copiate differiscono dall’originale SOLO per le modifiche dichiarate', () => {
    /** Da `CREATE OR REPLACE FUNCTION public.<nome>(` al `GRANT … TO service_role;` che la chiude. */
    function funzioneCompleta(sql: string, nome: string, firma: string): string {
      const forma = new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${nome}\\([\\s\\S]*?\\n` +
          `GRANT EXECUTE ON FUNCTION public\\.${nome}\\(${firma}\\)\\n  TO service_role;`,
      )
      const trovata = forma.exec(sql)
      if (!trovata) throw new Error(`non trovo la funzione ${nome}(${firma}) in quel file`)
      return trovata[0]
    }

    const occorrenze = (testo: string, pezzo: string): number => testo.split(pezzo).length - 1

    it('video_job_next: cambia UNA riga del WHERE, e il commento che la spiega', () => {
      const originale = funzioneCompleta(NEXT_ORIGINALE, 'video_job_next', 'uuid, integer')
      const nuova = funzioneCompleta(RITENTATIVI, 'video_job_next', 'uuid, integer')

      // Il controllo positivo dell'estrattore: se non trovasse il corpo vero, il
      // confronto qui sotto sarebbe fra due stringhe corte e verde per costruzione.
      expect(soloCodice(originale)).toContain('FOR UPDATE OF i SKIP LOCKED')
      expect(soloCodice(originale).length).toBeGreaterThan(1500)

      const VECCHIA = "      j.status = 'queued'\n"
      const NUOVA =
        "      (j.status = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= v_now))\n"
      const codice = soloCodice(nuova)

      expect(occorrenze(codice, NUOVA), 'la riga nuova del WHERE deve esserci, una volta sola').toBe(1)
      // Rimessa la riga vecchia, il corpo è IDENTICO all'originale, byte per byte.
      expect(codice.replace(NUOVA, VECCHIA)).toBe(soloCodice(originale))
    })

    it('video_job_claim: cambiano la guardia RETRY_NOT_DUE e l’azzeramento di next_attempt_at, e basta', () => {
      const originale = funzioneCompleta(TRANSIZIONI, 'video_job_claim', 'uuid, uuid, integer')
      const nuova = funzioneCompleta(RITENTATIVI, 'video_job_claim', 'uuid, uuid, integer')

      expect(soloCodice(originale)).toContain('LEASE_ACTIVE')
      expect(soloCodice(originale).length).toBeGreaterThan(2000)

      const GUARDIA =
        [
          "  IF v_job.status = 'queued' AND v_job.next_attempt_at > v_now THEN",
          '    PERFORM public._video_job_transition_log(',
          "      'video-job-claim', 'error', p_job_id, v_intent.id, 'RETRY_NOT_DUE'",
          '    );',
          "    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'RETRY_NOT_DUE');",
          '  END IF;',
        ].join('\n') + '\n\n'
      const AZZERA = '      next_attempt_at = NULL,\n'
      const codice = soloCodice(nuova)

      expect(occorrenze(codice, GUARDIA), 'la guardia deve esserci, una volta sola').toBe(1)
      expect(occorrenze(codice, AZZERA), 'l’azzeramento deve esserci, una volta sola').toBe(1)
      // Tolte le due modifiche, il corpo è IDENTICO all'originale, byte per byte.
      expect(codice.replace(GUARDIA, '').replace(AZZERA, '')).toBe(soloCodice(originale))

      // E la guardia sta PRIMA di INVALID_STATE: dopo, un job `queued` non dovuto verrebbe
      // preso come qualunque altro.
      expect(codice.indexOf(GUARDIA)).toBeLessThan(codice.indexOf("RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_STATE')"))
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe('la migrazione dei ritentativi', () => {
    it('aggiunge le due colonne, entrambe nullable, nel tipo giusto, ciascuna col suo COMMENT', async () => {
      const { rows } = await db.query<{ colonna: string; tipo: string; nullo: string }>(`
        SELECT column_name AS colonna, data_type AS tipo, is_nullable AS nullo
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'video_jobs'
          AND column_name IN ('next_attempt_at', 'last_error_code')
        ORDER BY column_name
      `)
      expect(rows).toEqual([
        { colonna: 'last_error_code', tipo: 'text', nullo: 'YES' },
        { colonna: 'next_attempt_at', tipo: 'timestamp with time zone', nullo: 'YES' },
      ])

      // I COMMENT. La spec (§4.7) li chiede, e sono l'unica spiegazione che resta attaccata
      // alle colonne una volta applicata la migrazione: dicono quando `next_attempt_at` ha
      // senso e perché `last_error_code` è solo un codice. Un `COMMENT ON COLUMN` tolto non
      // cambia né un tipo né un comportamento, quindi nessun altro test se ne accorgerebbe.
      const { rows: commenti } = await db.query<{ colonna: string; commento: string | null }>(`
        SELECT a.attname AS colonna, col_description(a.attrelid, a.attnum) AS commento
        FROM pg_attribute a
        WHERE a.attrelid = 'public.video_jobs'::regclass
          AND a.attname IN ('next_attempt_at', 'last_error_code')
        ORDER BY a.attname
      `)
      expect(commenti, 'la query dei COMMENT deve vedere le due colonne').toHaveLength(2)
      for (const c of commenti) {
        expect(c.commento, `${c.colonna} senza COMMENT`).not.toBeNull()
        // Più lungo di un titolo: una parola sola non spiega niente a chi legge lo schema.
        expect(c.commento?.length ?? 0, `${c.colonna}: COMMENT troppo corto per spiegare qualcosa`).toBeGreaterThan(80)
      }
      // La ragione di privacy (decisione D5) sta scritta accanto alla colonna: nel job si
      // salva solo il codice, mai lo stderr di ffmpeg, che può portare i metadati del
      // telefono (la posizione di dove è stato ripreso il bambino) e finirebbe in una tabella
      // senza conservazione.
      const ultimoErrore = commenti.find((c) => c.colonna === 'last_error_code')
      expect(ultimoErrore?.commento, 'il COMMENT di last_error_code non spiega il perché dello stderr').toContain('stderr')
    })

    it('il CHECK di last_error_code accetta il formato dei codici e rifiuta il resto', async () => {
      const { jobId } = await creaJob('81')
      const imposta = (valore: string) =>
        db.exec(`UPDATE public.video_jobs SET last_error_code = '${valore}' WHERE id = '${jobId}'`)

      // Se uno di questi tre UPDATE fosse rifiutato, `await` lancerebbe e il test sarebbe rosso.
      await imposta('BUILD_DOWNLOAD_FAILED')
      await imposta('E'.repeat(80))
      for (const valore of ['minuscolo', 'CON SPAZIO', '1INIZIA_CON_UNA_CIFRA', '', 'E'.repeat(81)]) {
        await expect(imposta(valore), `«${valore}» doveva essere rifiutato`).rejects.toThrow(
          /video_jobs_last_error_code_chk/,
        )
      }
      // NULL passa: è lo stato di ogni job che non ha mai aspettato.
      await db.exec(`UPDATE public.video_jobs SET last_error_code = NULL WHERE id = '${jobId}'`)
    })

    it('NESSUN vincolo lega next_attempt_at allo stato (lo romperebbero cancel, supersede, revoke, retention)', async () => {
      const { rows } = await db.query<{ def: string }>(`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'public.video_jobs'::regclass AND contype = 'c'
      `)
      // Il controllo positivo: la query vede davvero i CHECK della tabella (sono più di venti).
      expect(rows.length).toBeGreaterThan(15)
      expect(rows.some((r) => /last_error_code/.test(r.def))).toBe(true)
      expect(rows.filter((r) => /next_attempt_at/.test(r.def)).map((r) => r.def)).toEqual([])

      // E da vivo: l'attesa si può scrivere su una riga in QUALUNQUE stato (qui
      // `awaiting_upload`), senza che niente protesti: se un vincolo la legasse allo stato,
      // l'UPDATE lancerebbe.
      const { jobId } = await creaJob('82')
      await db.exec(`UPDATE public.video_jobs SET next_attempt_at = now() WHERE id = '${jobId}'`)
      expect((await riga(jobId)).next_attempt_at).not.toBeNull()
    })

    it('è idempotente: riapplicarla non rompe niente e non tocca i job in attesa', async () => {
      const { jobId } = await creaJobInLavorazione('83')
      await ritenta(jobId)
      const prima = await riga(jobId)

      await db.exec(RITENTATIVI)

      expect(await riga(jobId)).toEqual(prima)
      const { rows } = await db.query<{ nome: string }>(`
        SELECT conname AS nome FROM pg_constraint
        WHERE conrelid = 'public.video_jobs'::regclass AND conname LIKE '%last_error_code%'
      `)
      expect(rows).toEqual([{ nome: 'video_jobs_last_error_code_chk' }])
      // Le funzioni riscritte funzionano ancora: la ripetizione del ritentativo è idempotente.
      expect(await ritenta(jobId)).toMatchObject({ ok: true, job: { status: 'queued' } })
    })

    it('il successo dell’installazione si scrive nel log, senza dati di nessuno', async () => {
      const contesti = await contestiLoggati('video-job-retry-migration')
      expect(contesti).toEqual([
        {
          rpc_nuove: 1,
          rpc_riscritte: 2,
          colonne_nuove: 2,
          tentativi_massimi_ammessi: 10,
          attesa_massima_secondi: 86400,
        },
      ])
      expect(await livelliLoggati('video-job-retry-migration')).toEqual(['info'])
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('la migrazione dei ritentativi su un database che ha già dei job', () => {
  // La produzione del 02/10/2026 non è un database vuoto: ha job falliti col codice
  // vecchio, e potrebbe averne uno in lavorazione nell'istante in cui la migrazione viene
  // applicata. Qui si carica la pipeline SENZA i ritentativi, si crea quello stato, e solo
  // dopo si applica la migrazione: è il percorso che farà davvero.
  beforeEach(async () => {
    await db.exec(SCHEMA)
    await db.exec(TRANSIZIONI)
    await db.exec(INTENTI)
    await db.exec(NEXT_ORIGINALE)
    await db.exec(RETENTION)
  })

  /** Le colonne che esistono PRIMA della migrazione: la fotografia non può nominare quelle nuove. */
  const fotografiaPrima = (ids: string[]) =>
    db.query(`
      SELECT id, status, error_code, attempt, fence_epoch::int AS fence_epoch,
             original_delete_after, updated_at
      FROM public.video_jobs
      WHERE id IN (${ids.map((i) => `'${i}'`).join(', ')})
      ORDER BY id
    `)

  it('i job già falliti restano com’erano: nessun recupero, nessuna colonna nuova valorizzata', async () => {
    // Come i 17 della produzione: presi dal runner e chiusi al primo colpo, `attempt = 1`.
    const ids: string[] = []
    for (const sigla of ['01', '02', '03']) {
      const { jobId } = await creaJob(sigla)
      await accoda(jobId)
      await claim(jobId, LEASE_A)
      expect(
        await rpc(`public.video_job_fail('${jobId}', 1, '${LEASE_A}', '${CODICE}', false)`),
      ).toMatchObject({ ok: true, job: { status: 'failed' } })
      ids.push(jobId)
    }
    const prima = await fotografiaPrima(ids)
    expect(prima.rows).toHaveLength(3)

    await db.exec(RITENTATIVI)

    // Righe identiche, byte per byte: la migrazione non ne riscrive nemmeno una.
    expect((await fotografiaPrima(ids)).rows).toEqual(prima.rows)
    expect(
      (await unaRiga<{ n: number }>(`
        SELECT count(*)::int AS n FROM public.video_jobs
        WHERE next_attempt_at IS NOT NULL OR last_error_code IS NOT NULL
      `)).n,
    ).toBe(0)

    // E la coda non li riprende: decisione del titolare, nessun recupero (gli originali
    // scadono da soli).
    expect(await next(LEASE_B)).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
    expect((await riga(ids[0])).status).toBe('failed')
  })

  it('un job già in coda prima della migrazione si prende come sempre', async () => {
    const { jobId } = await creaJob('04')
    await accoda(jobId)

    await db.exec(RITENTATIVI)

    expect(await next(LEASE_A)).toMatchObject({
      ok: true,
      job: { id: jobId, status: 'processing', attempt: 1, fence_epoch: 1, next_attempt_at: null },
    })
  })

  it('un job in lavorazione mentre la migrazione si applica: il claim idempotente regge, e il suo guasto si ritenta', async () => {
    const { jobId } = await creaJob('05')
    await accoda(jobId)
    await claim(jobId, LEASE_A)

    await db.exec(RITENTATIVI)

    // Il riaggancio di una conversione lunga (`riprendi`) è il claim idempotente: stesso
    // proprietario, lease viva, nessun incremento. È il ramo che la riscrittura NON deve toccare.
    expect(await claim(jobId, LEASE_A)).toMatchObject({
      ok: true,
      job: { status: 'processing', attempt: 1, fence_epoch: 1, lease_owner: LEASE_A },
    })
    expect(await ritenta(jobId)).toMatchObject({
      ok: true,
      job: { status: 'queued', attempt: 1, fence_epoch: 1, last_error_code: CODICE },
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('video_build · il bucket dei binari di FFmpeg', () => {
  type RigaBucket = { id: string; name: string; pubblico: boolean; limite: string; mime: string[] | null }

  const bucket = () =>
    unaRiga<RigaBucket>(`
      SELECT id, name, public AS pubblico, file_size_limit::text AS limite, allowed_mime_types AS mime
      FROM storage.buckets WHERE id = 'video_build'
    `)

  it('nasce PRIVATO, a 300 MiB, con i soli due tipi dei binari', async () => {
    await db.exec(BUCKET)

    expect(await bucket()).toEqual({
      id: 'video_build',
      name: 'video_build',
      pubblico: false,
      limite: String(300 * 1024 * 1024),
      mime: ['application/gzip', 'application/x-xz'],
    })
    // 300 MiB, scritti in byte: il numero della migrazione e quello della spec sono lo stesso.
    expect(300 * 1024 * 1024).toBe(314_572_800)
  })

  it('è idempotente: riapplicarla lascia una riga sola, identica', async () => {
    await db.exec(BUCKET)
    const prima = await bucket()
    await db.exec(BUCKET)

    expect(await bucket()).toEqual(prima)
    expect(
      (await unaRiga<{ n: number }>(`SELECT count(*)::int AS n FROM storage.buckets WHERE id = 'video_build'`)).n,
    ).toBe(1)
  })

  it('se il bucket esiste già aperto o con altri limiti, lo riporta a privato e ai limiti dichiarati', async () => {
    // Il ramo `ON CONFLICT … DO UPDATE`, che in produzione è l'unico a girare se qualcuno
    // avesse creato il bucket dalla console: lo richiude, non lo lascia com'è.
    await db.exec(`
      INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
      VALUES ('video_build', 'video_build', true, 1, NULL)
    `)
    await db.exec(BUCKET)

    expect(await bucket()).toMatchObject({
      pubblico: false,
      limite: '314572800',
      mime: ['application/gzip', 'application/x-xz'],
    })
  })

  it('non tocca gli altri bucket', async () => {
    await db.exec(`
      INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
      VALUES ('news', 'news', true, 52428800, ARRAY['image/jpeg'])
    `)
    await db.exec(BUCKET)

    expect(
      await unaRiga<{ pubblico: boolean; limite: string }>(
        `SELECT public AS pubblico, file_size_limit::text AS limite FROM storage.buckets WHERE id = 'news'`,
      ),
    ).toEqual({ pubblico: true, limite: '52428800' })
  })

  it('il successo dell’installazione si scrive nel log', async () => {
    await db.exec(BUCKET)

    expect(await livelliLoggati('video-build-bucket-migration')).toEqual(['info'])
    expect(await contestiLoggati('video-build-bucket-migration')).toEqual([
      { bucket_privati: 1, limite_byte: 314572800 },
    ])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('le due migrazioni non accendono le guardie delle fotografie', () => {
  // Una migrazione dentro una PR non è in produzione: la fotografia non può contenerla, e
  // una guardia di freschezza che la riconosca resta rossa finché non si applica e si
  // rigenera. Se la migrazione non tocca ciò che la fotografia racconta, la guardia non
  // deve nemmeno scattare: è la stessa prova di `fatture-coda-nucleo.test.ts` (N9).
  const migrazioni: [string, string][] = [
    ['bucket', BUCKET],
    ['ritentativi', RITENTATIVI],
  ]

  it.each(migrazioni)('%s: né RLS, né indici unici, né vincoli sulle chiavi verso utenti, né la sede', (_nome, sql) => {
    expect(sql).not.toBe('')
    expect(toccaLaRls(sql)).toBe(false)
    expect(toccaUnUnico(sql)).toBe(false)
    expect(toccaLeFkUtenti(sql)).toBe(false)
    expect(senzaCommenti(sql)).not.toMatch(/scuola_id/i)
  })

  it('il CHECK di last_error_code sta DENTRO la definizione della colonna: è la forma che non accende la guardia', () => {
    // Il controllo positivo: la forma «ovvia», con un `ADD CONSTRAINT` a parte, la
    // accenderebbe — è il motivo per cui la migrazione non la usa. Senza questa riga, chi
    // riscrivesse il CHECK nella forma ovvia vedrebbe rosso un lock lontano e non saprebbe perché.
    expect(
      toccaLeFkUtenti(
        'ALTER TABLE public.video_jobs ADD CONSTRAINT video_jobs_last_error_code_chk CHECK (true);',
      ),
    ).toBe(true)
    expect(soloCodice(RITENTATIVI)).toMatch(
      /ADD COLUMN last_error_code text\s+CONSTRAINT video_jobs_last_error_code_chk\s+CHECK/,
    )
  })
})
