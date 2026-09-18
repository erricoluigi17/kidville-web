// @vitest-environment node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * V14 — LA RETENTION DEGLI ORIGINALI, LA RICONCILIAZIONE, E IL BUCO CHE NON DEVE
 * RIAPRIRSI.
 *
 * ─── IL DIFETTO CHE QUESTE PROVE ESISTONO PER IMPEDIRE ──────────────────────
 *
 * `video_jobs_retention_originali_idx` è un indice PARZIALE:
 *
 *     ON video_jobs(original_delete_after)
 *     WHERE original_deleted_at IS NULL AND original_delete_after IS NOT NULL
 *
 * Una riga con `original_delete_after` a NULL non è «in ritardo»: è **fuori
 * dall'indice**, cioè invisibile a qualunque lavoro di conservazione che parta
 * dalla scadenza. L'originale — il video di un bambino in un bucket privato —
 * resta lì per sempre, e nessun conteggio lo nomina.
 *
 * Il difetto è già stato trovato e chiuso una volta, dentro
 * `video_intent_supersede` (`20260916190200_video_intent_lifecycle.sql:1044-1048`):
 * «un job non ancora concluso restava con `original_delete_after` NULL … 0 righe
 * su 1». Qui si chiude l'ULTIMO cammino rimasto — quello di chi non chiama
 * nessuna RPC, perché ha spento il telefono — e si mette una rete sotto tutti:
 * un job in stato CONCLUSO senza scadenza è un difetto, chiunque l'abbia scritto.
 *
 * ─── PERCHÉ LE PROVE STANNO SU PGlite E NON SU UN MOCK ──────────────────────
 *
 * Perché ciò che si sta verificando sono i VINCOLI: `video_jobs_lease_chk`
 * pretende che una lease viva stia solo su `processing`, `video_jobs_stato_errore_chk`
 * pretende un `error_code` su `failed`, `video_jobs_original_deleted_chk` pretende
 * che il timbro di cancellazione non preceda la propria scadenza. Un mock direbbe
 * «sì» a tutto, ed è esattamente il modo in cui una migrazione passa i test e poi
 * fallisce al primo `UPDATE` in produzione.
 */

const RADICE = process.cwd()
const leggi = (f: string) => readFileSync(join(RADICE, 'supabase/migrations', f), 'utf8')

const SCHEMA = leggi('20260916190000_video_jobs.sql')
const TRANSIZIONI = leggi('20260916190100_video_job_transitions.sql')
const INTENTI = leggi('20260916190200_video_intent_lifecycle.sql')
const RETENTION = leggi('20260918110000_video_retention_riconciliazione.sql')

const SEDE = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const INTENT = '30000000-0000-4000-8000-000000000003'
const LEASE = '50000000-0000-4000-8000-000000000005'

/** Sette giorni in millisecondi: il TTL che la consegna dichiara per ciò che è concluso. */
const SETTE_GIORNI_MS = 7 * 24 * 60 * 60 * 1000

type Esito = {
    ok: boolean
    code?: string
    [chiave: string]: unknown
}

let db: PGlite

async function rpc(sql: string): Promise<Esito> {
    const { rows } = await db.query<{ risultato: Esito }>(`SELECT ${sql} AS risultato`)
    return rows[0].risultato
}

/**
 * ⚠️ `timestamptz` torna da PGlite come `Date`, non come stringa. Tiparlo `string`
 * non è un dettaglio cosmetico: `toBe` su due `Date` diversi che valgono lo stesso
 * istante FALLISCE (confronto per identità), e — molto peggio — `Date.parse(x)` su
 * un `Date` passa per `String(x)`, che **perde i millisecondi**. Due istanti
 * distanti 40 ms risulterebbero uguali, e una prova di idempotenza costruita così
 * sarebbe verde anche se la scadenza si spostasse a ogni giro.
 */
type RigaJob = {
    id: string
    status: string
    error_code: string | null
    fence_epoch: number
    lease_owner: string | null
    lease_expires_at: Date | null
    original_delete_after: Date | null
    original_deleted_at: Date | null
}

async function job(id: string): Promise<RigaJob> {
    const { rows } = await db.query<RigaJob>(
        `SELECT id, status, error_code, fence_epoch, lease_owner, lease_expires_at,
                original_delete_after, original_deleted_at
           FROM public.video_jobs WHERE id = '${id}'`,
    )
    return rows[0]
}

/**
 * Quante righe l'indice parziale della retention VEDE davvero.
 *
 * Non è una parafrasi del `WHERE` dell'indice scritta a mano: è la stessa
 * condizione, e serve a dire «invisibile» con un numero invece che con un
 * aggettivo. La prova che conta, sotto, confronta questo conteggio con il totale.
 */
async function visibiliAllaRetention(): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.video_jobs
          WHERE original_deleted_at IS NULL AND original_delete_after IS NOT NULL`,
    )
    return rows[0].n
}

async function creaJob(
    id: string,
    opzioni: { status?: string; creatoOreFa?: number; aggiornatoOreFa?: number; intent?: string } = {},
): Promise<void> {
    const {
        status = 'awaiting_upload',
        creatoOreFa = 0,
        aggiornatoOreFa = creatoOreFa,
        intent = INTENT,
    } = opzioni
    await db.exec(`
    INSERT INTO public.video_jobs(
      id, owner_id, scuola_id, channel, idempotency_key, intent_id,
      original_bucket, original_path, status, created_at, updated_at
    ) VALUES (
      '${id}', '${OWNER}', '${SEDE}', 'news', 'chiave-${id}', '${intent}',
      'video_originals', 'originals/${id}/source', '${status}',
      now() - interval '${creatoOreFa} hours',
      now() - interval '${aggiornatoOreFa} hours'
    );
  `)
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

    INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    VALUES
      ('gallery', 'gallery', false, 52428800, ARRAY['image/jpeg', 'video/mp4']),
      ('news', 'news', true, 52428800, ARRAY['image/jpeg', 'video/mp4']),
      ('news_bozze', 'news_bozze', false, 52428800, ARRAY['image/jpeg', 'video/mp4']);
  `)

    await db.exec(SCHEMA)
    await db.exec(TRANSIZIONI)
    await db.exec(INTENTI)
    await db.exec(RETENTION)

    await db.exec(`
    INSERT INTO public.video_intents(
      id, owner_id, scuola_id, channel, requested_action, payload
    ) VALUES (
      '${INTENT}', '${OWNER}', '${SEDE}', 'news', 'publish', '{}'
    );
  `)
}

beforeEach(async () => {
    db = new PGlite()
    await preparaDatabase()
})

afterEach(async () => {
    await db.close()
})

describe('video_retention_scadenze — nessun originale resta senza una data di morte', () => {
    it('è SECURITY DEFINER, con search_path chiuso, e la eseguono solo il service role e nessun altro', async () => {
        // Porta con sé la potestà di dichiarare fallito il lavoro di qualcun altro e
        // di mettere una data di distruzione sul video di un bambino: se la potesse
        // chiamare `authenticated`, un genitore potrebbe far scadere l'originale
        // altrui. È lo stesso controllo che `video-transitions.test.ts` fa sulle sei
        // RPC di transizione, e vale per le stesse ragioni.
        const { rows } = await db.query<{
            nome: string
            security_definer: boolean
            configurazione: string[]
        }>(`
      SELECT p.proname AS nome, p.prosecdef AS security_definer, p.proconfig AS configurazione
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'video_retention_scadenze', 'video_retention_originale_rimosso', 'video_riconciliazione'
        )
      ORDER BY p.proname
    `)

        expect(rows).toHaveLength(3)
        for (const funzione of rows) {
            expect(funzione.security_definer, `${funzione.nome} non è SECURITY DEFINER`).toBe(true)
            expect(funzione.configurazione, `${funzione.nome} ha il search_path aperto`).toContain(
                'search_path=pg_catalog',
            )
            for (const [ruolo, atteso] of [
                ['service_role', true],
                ['anon', false],
                ['authenticated', false],
            ] as const) {
                const { rows: p } = await db.query<{ permesso: boolean }>(`
          SELECT has_function_privilege('${ruolo}', p.oid, 'EXECUTE') AS permesso
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = '${funzione.nome}'
        `)
                expect(p[0].permesso, `${funzione.nome} · ${ruolo}`).toBe(atteso)
            }
        }
    })

    it('un upload ABBANDONATO (telefono spento, nessuna RPC chiamata) esce dall’invisibilità', async () => {
        const ABBANDONATO = '41000000-0000-4000-8000-000000000001'
        await creaJob(ABBANDONATO, { status: 'awaiting_upload', creatoOreFa: 72 })

        // PRIMA: la riga esiste e l'indice della retention non la vede. È il difetto,
        // misurato e non raccontato.
        expect(await visibiliAllaRetention()).toBe(0)

        const esito = await rpc('public.video_retention_scadenze(48, 168, 100)')
        expect(esito.ok).toBe(true)
        expect(esito.abbandonati).toBe(1)

        const riga = await job(ABBANDONATO)
        expect(riga.status).toBe('failed')
        expect(riga.error_code).toBe('UPLOAD_ABBANDONATO')
        expect(riga.original_delete_after).not.toBeNull()
        // Sette giorni: lo stesso TTL che `video_job_fail` dà a un fallimento vero.
        // Non è un numero nuovo — è lo stesso, ed è voluto.
        const scadenza = riga.original_delete_after!.getTime()
        expect(scadenza - Date.now()).toBeGreaterThan(SETTE_GIORNI_MS - 60_000)
        expect(scadenza - Date.now()).toBeLessThan(SETTE_GIORNI_MS + 60_000)

        // DOPO: la riga è dentro l'indice parziale. È la stessa misura di prima, e
        // solo il confronto fra le due dice che qualcosa è cambiato davvero.
        expect(await visibiliAllaRetention()).toBe(1)
    })

    it('un upload ancora nella sua finestra NON viene toccato (controllo positivo)', async () => {
        const GIOVANE = '41000000-0000-4000-8000-000000000002'
        await creaJob(GIOVANE, { status: 'awaiting_upload', creatoOreFa: 12 })

        const esito = await rpc('public.video_retention_scadenze(48, 168, 100)')
        expect(esito.abbandonati).toBe(0)

        const riga = await job(GIOVANE)
        expect(riga.status).toBe('awaiting_upload')
        expect(riga.original_delete_after).toBeNull()
    })

    it('un job INCAGLIATO in coda o in lavorazione viene dichiarato fallito e il fence sale', async () => {
        const IN_CODA = '41000000-0000-4000-8000-000000000003'
        const IN_LAVORAZIONE = '41000000-0000-4000-8000-000000000004'
        await creaJob(IN_CODA, { status: 'queued', creatoOreFa: 240, aggiornatoOreFa: 240 })
        await creaJob(IN_LAVORAZIONE, { status: 'queued', creatoOreFa: 240, aggiornatoOreFa: 240 })

        // Il secondo prende una lease VERA e la lascia scadere: è il worker morto.
        await db.exec(`
      UPDATE public.video_jobs
         SET status = 'processing',
             lease_owner = '${LEASE}',
             lease_expires_at = now() - interval '2 hours',
             updated_at = now() - interval '240 hours'
       WHERE id = '${IN_LAVORAZIONE}';
    `)

        const esito = await rpc('public.video_retention_scadenze(48, 168, 100)')
        expect(esito.ok).toBe(true)
        expect(esito.incagliati).toBe(2)

        for (const id of [IN_CODA, IN_LAVORAZIONE]) {
            const riga = await job(id)
            expect(riga.status, id).toBe('failed')
            expect(riga.error_code, id).toBe('CONVERSIONE_INCAGLIATA')
            expect(riga.original_delete_after, id).not.toBeNull()
            // La lease va via: `video_jobs_lease_chk` la ammette solo su `processing`,
            // e lasciarla farebbe fallire l'UPDATE con un 23514 anonimo.
            expect(riga.lease_owner, id).toBeNull()
            expect(riga.lease_expires_at, id).toBeNull()
            // Il fence sale come in `video_job_cancel`: un worker che risorge si sente
            // rispondere FENCE_MISMATCH invece di chiudere un job non più suo.
            expect(riga.fence_epoch, id).toBe(1)
        }
    })

    it('il worker VIVO non viene dichiarato incagliato dalla sola età della riga', async () => {
        // Il caso limite che distingue «vecchio» da «morto»: una conversione lunga
        // tiene la lease e batte il cuore. Se bastasse l'età, questa RPC spegnerebbe
        // un lavoro in corso e butterebbe via la MicroVM che lo sta facendo.
        const VIVO = '41000000-0000-4000-8000-000000000005'
        await creaJob(VIVO, { status: 'queued', creatoOreFa: 240, aggiornatoOreFa: 240 })
        await db.exec(`
      UPDATE public.video_jobs
         SET status = 'processing',
             lease_owner = '${LEASE}',
             lease_expires_at = now() + interval '10 minutes',
             updated_at = now() - interval '240 hours'
       WHERE id = '${VIVO}';
    `)

        const esito = await rpc('public.video_retention_scadenze(48, 168, 100)')
        expect(esito.incagliati).toBe(0)
        expect((await job(VIVO)).status).toBe('processing')
    })

    it('un job CONCLUSO rimasto senza scadenza la riceve comunque: è la rete sotto tutti', async () => {
        // Il cammino che oggi non esiste, e che domani esisterà. Le cinque RPC che
        // concludono un job la scadenza la scrivono tutte; ma il giorno in cui
        // qualcuno ne aggiunge una sesta — o corregge una riga a mano — questa rete è
        // l'unica cosa fra quell'originale e «per sempre».
        const FALLITO = '41000000-0000-4000-8000-000000000006'
        const ANNULLATO = '41000000-0000-4000-8000-000000000007'
        await creaJob(FALLITO, { status: 'queued' })
        await creaJob(ANNULLATO, { status: 'queued' })
        await db.exec(`
      UPDATE public.video_jobs SET status = 'failed', error_code = 'A_MANO'
       WHERE id = '${FALLITO}';
      UPDATE public.video_jobs SET status = 'cancelled' WHERE id = '${ANNULLATO}';
    `)
        expect(await visibiliAllaRetention()).toBe(0)

        const esito = await rpc('public.video_retention_scadenze(48, 168, 100)')
        expect(esito.senza_scadenza).toBe(2)
        expect(await visibiliAllaRetention()).toBe(2)

        // Un fallimento conserva i suoi sette giorni: l'originale può ancora servire a
        // capire perché la conversione non è riuscita.
        const fallito = await job(FALLITO)
        expect(fallito.original_delete_after!.getTime() - Date.now()).toBeGreaterThan(
            SETTE_GIORNI_MS - 60_000,
        )
        // Un annullamento no: l'ha chiesto chi ha caricato, e l'originale se ne va
        // subito. È la stessa decisione di `video_job_cancel`, che scrive `LEAST(…, now)`.
        const annullato = await job(ANNULLATO)
        expect(annullato.original_delete_after!.getTime() - Date.now()).toBeLessThan(60_000)
        expect(annullato.error_code).toBeNull()
    })

    it('è idempotente: due giri di fila non spostano la scadenza né rialzano il fence', async () => {
        const ABBANDONATO = '41000000-0000-4000-8000-000000000008'
        await creaJob(ABBANDONATO, { status: 'awaiting_upload', creatoOreFa: 72 })

        await rpc('public.video_retention_scadenze(48, 168, 100)')
        const primo = await job(ABBANDONATO)
        const secondo = await rpc('public.video_retention_scadenze(48, 168, 100)')

        expect(secondo).toMatchObject({ ok: true, abbandonati: 0, incagliati: 0, senza_scadenza: 0 })
        const dopo = await job(ABBANDONATO)
        expect(dopo.original_delete_after!.getTime()).toBe(primo.original_delete_after!.getTime())
        expect(dopo.fence_epoch).toBe(primo.fence_epoch)
    })

    it('rifiuta gli argomenti impossibili invece di lavorare su un perimetro inventato', async () => {
        expect(await rpc('public.video_retention_scadenze(NULL, 168, 100)')).toEqual({
            ok: false,
            code: 'BAD_INPUT',
        })
        expect(await rpc('public.video_retention_scadenze(0, 168, 100)')).toEqual({
            ok: false,
            code: 'BAD_INPUT',
        })
        expect(await rpc('public.video_retention_scadenze(48, 168, 0)')).toEqual({
            ok: false,
            code: 'BAD_INPUT',
        })
        // Un tetto enorme non è una svista: è un giro che tiene lock su migliaia di
        // righe dentro una richiesta con un tempo massimo.
        expect(await rpc('public.video_retention_scadenze(48, 168, 100000)')).toEqual({
            ok: false,
            code: 'BAD_INPUT',
        })
    })

    it('non tocca un job PRONTO, nemmeno se il suo intent è stato superato', async () => {
        // `video_intent_supersede` lascia apposta stare i `ready`: quell'output è il
        // video che le famiglie stanno guardando finché la revisione nuova non
        // pubblica, e la sua scadenza è già esatta (`verified_at + 7 giorni`, imposta
        // da `video_jobs_original_ttl_chk`). Toccarla qui la sposterebbe.
        const PRONTO = '41000000-0000-4000-8000-000000000009'
        await creaJob(PRONTO, { status: 'queued', creatoOreFa: 500, aggiornatoOreFa: 500 })
        await db.exec(`
      UPDATE public.video_jobs
         SET status = 'ready',
             source_size = 1000, source_mime = 'video/mp4',
             output_bucket = 'video_processing', output_path = 'out/${PRONTO}.mp4',
             output_size = 900,
             probe_json = '{"durationSeconds": 12}'::jsonb,
             verified_at = now() - interval '500 hours',
             original_delete_after = now() - interval '500 hours' + interval '7 days'
       WHERE id = '${PRONTO}';
    `)
        const prima = await job(PRONTO)

        const esito = await rpc('public.video_retention_scadenze(48, 168, 100)')
        expect(esito).toMatchObject({ ok: true, abbandonati: 0, incagliati: 0, senza_scadenza: 0 })
        expect(await job(PRONTO)).toEqual(prima)
    })
})

describe('video_retention_originale_rimosso — il timbro dopo che l’archivio ha confermato', () => {
    it('timbra la riga solo quando la scadenza è passata, e due volte non fa danno', async () => {
        const SCADUTO = '42000000-0000-4000-8000-000000000001'
        await creaJob(SCADUTO, { status: 'queued' })
        await db.exec(`
      UPDATE public.video_jobs
         SET status = 'cancelled', original_delete_after = now() - interval '1 hour'
       WHERE id = '${SCADUTO}';
    `)

        const primo = await rpc(`public.video_retention_originale_rimosso('${SCADUTO}')`)
        expect(primo.ok).toBe(true)
        const riga = await job(SCADUTO)
        expect(riga.original_deleted_at).not.toBeNull()
        // Il vincolo storico della tabella pretende `deleted_at >= delete_after`: se
        // il timbro fosse `now()` su una scadenza futura l'UPDATE esploderebbe.
        expect(riga.original_deleted_at!.getTime()).toBeGreaterThanOrEqual(
            riga.original_delete_after!.getTime(),
        )
        // L'indice parziale non la vede più: il lavoro è finito, non ripetuto.
        expect(await visibiliAllaRetention()).toBe(0)

        const secondo = await rpc(`public.video_retention_originale_rimosso('${SCADUTO}')`)
        expect(secondo).toMatchObject({ ok: true, idempotente: true })
        expect((await job(SCADUTO)).original_deleted_at!.getTime()).toBe(
            riga.original_deleted_at!.getTime(),
        )
    })

    it('rifiuta di timbrare un originale la cui scadenza NON è ancora arrivata', async () => {
        // È la difesa contro l'errore più costoso di tutti: cancellare l'originale di
        // un video che deve ancora essere convertito. Chi chiama passa un id; se
        // l'elenco da cui l'ha preso fosse sbagliato, qui si ferma.
        const VIVO = '42000000-0000-4000-8000-000000000002'
        await creaJob(VIVO, { status: 'queued' })
        await db.exec(`
      UPDATE public.video_jobs
         SET status = 'failed', error_code = 'X',
             original_delete_after = now() + interval '3 days'
       WHERE id = '${VIVO}';
    `)

        expect(await rpc(`public.video_retention_originale_rimosso('${VIVO}')`)).toEqual({
            ok: false,
            code: 'NON_ANCORA_SCADUTO',
        })
        expect((await job(VIVO)).original_deleted_at).toBeNull()
    })

    it('un job che non esiste e un argomento nullo non passano in silenzio', async () => {
        expect(await rpc(`public.video_retention_originale_rimosso(NULL)`)).toEqual({
            ok: false,
            code: 'BAD_INPUT',
        })
        expect(
            await rpc(`public.video_retention_originale_rimosso('49000000-0000-4000-8000-00000000ffff')`),
        ).toEqual({ ok: false, code: 'NOT_FOUND' })
    })

    it('una riga SENZA scadenza non si timbra: prima le si dà una data, poi la si cancella', async () => {
        const INVISIBILE = '42000000-0000-4000-8000-000000000003'
        await creaJob(INVISIBILE, { status: 'awaiting_upload' })

        expect(await rpc(`public.video_retention_originale_rimosso('${INVISIBILE}')`)).toEqual({
            ok: false,
            code: 'SENZA_SCADENZA',
        })
    })
})

describe('video_riconciliazione — un guasto che nessuno conta è un guasto che nessuno ripara', () => {
    it('conta le code, le lease scadute e gli originali da togliere, senza scrivere niente', async () => {
        const IN_ATTESA = '43000000-0000-4000-8000-000000000001'
        const IN_CODA = '43000000-0000-4000-8000-000000000002'
        const LEASE_MORTA = '43000000-0000-4000-8000-000000000003'
        const DA_TOGLIERE = '43000000-0000-4000-8000-000000000004'
        await creaJob(IN_ATTESA, { status: 'awaiting_upload', creatoOreFa: 1 })
        await creaJob(IN_CODA, { status: 'queued', creatoOreFa: 5, aggiornatoOreFa: 5 })
        await creaJob(LEASE_MORTA, { status: 'queued' })
        await creaJob(DA_TOGLIERE, { status: 'queued' })
        await db.exec(`
      UPDATE public.video_jobs
         SET status = 'processing', lease_owner = '${LEASE}',
             lease_expires_at = now() - interval '30 minutes'
       WHERE id = '${LEASE_MORTA}';
      UPDATE public.video_jobs
         SET status = 'cancelled', original_delete_after = now() - interval '1 minute'
       WHERE id = '${DA_TOGLIERE}';
    `)

        const prima = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM public.video_jobs WHERE updated_at > now() - interval '1 second'`,
        )

        const esito = await rpc('public.video_riconciliazione(48, 168, 1)')
        expect(esito).toMatchObject({
            ok: true,
            upload_in_sospeso: 1,
            in_coda: 1,
            in_coda_in_ritardo: 1,
            in_lavorazione: 1,
            lease_scadute: 1,
            originali_da_togliere: 1,
            conclusi_senza_scadenza: 0,
            outbox_in_attesa: 0,
            outbox_in_quarantena: 0,
        })

        // È una LETTURA: nessuna riga toccata. Senza questa asserzione, una
        // riconciliazione che «sistema» quel che conta sarebbe indistinguibile.
        const dopo = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM public.video_jobs WHERE updated_at > now() - interval '1 second'`,
        )
        expect(dopo.rows[0].n).toBe(prima.rows[0].n)
    })

    it('conta gli invisibili: un job concluso senza scadenza è un difetto, e il numero lo dice', async () => {
        const ROTTO = '43000000-0000-4000-8000-000000000005'
        await creaJob(ROTTO, { status: 'queued' })
        await db.exec(
            `UPDATE public.video_jobs SET status = 'failed', error_code = 'X' WHERE id = '${ROTTO}';`,
        )

        expect(await rpc('public.video_riconciliazione(48, 168, 1)')).toMatchObject({
            conclusi_senza_scadenza: 1,
        })

        // E dopo il giro di scadenze il numero torna a zero: le due funzioni si
        // parlano, e il conteggio non è una decorazione.
        await rpc('public.video_retention_scadenze(48, 168, 100)')
        expect(await rpc('public.video_riconciliazione(48, 168, 1)')).toMatchObject({
            conclusi_senza_scadenza: 0,
        })
    })

    it('conta l’uscita dei job conclusi in `video_processing`: il buco è dichiarato, non nascosto', async () => {
        // Questa consegna NON tocca `video_processing`: lo schema non ha un
        // `output_delete_after`, e inventare qui una scadenza significherebbe
        // cancellare l'uscita di un job `ready` che il finalizer — che non esiste
        // ancora — deve ancora copiare. Ma un peso morto che nessuno conta è un peso
        // morto che nessuno toglie, e sono video di minori: il numero esce.
        const MORTO = '43000000-0000-4000-8000-000000000006'
        const VIVO = '43000000-0000-4000-8000-000000000007'
        await creaJob(MORTO, { status: 'queued' })
        await creaJob(VIVO, { status: 'queued' })
        await db.exec(`
      UPDATE public.video_jobs
         SET status = 'failed', error_code = 'X',
             original_delete_after = now() + interval '7 days',
             output_bucket = 'video_processing', output_path = 'out/${MORTO}.mp4',
             output_size = 100
       WHERE id = '${MORTO}';
      UPDATE public.video_jobs
         SET status = 'ready',
             source_size = 10, source_mime = 'video/mp4',
             output_bucket = 'video_processing', output_path = 'out/${VIVO}.mp4',
             output_size = 90,
             probe_json = '{"durationSeconds": 3}'::jsonb,
             verified_at = now(),
             original_delete_after = now() + interval '7 days'
       WHERE id = '${VIVO}';
    `)

        // Solo il concluso: l'uscita di un `ready` è il video che deve ancora essere
        // pubblicato, e contarla come peso morto sarebbe un invito a distruggerla.
        expect(await rpc('public.video_riconciliazione(48, 168, 1)')).toMatchObject({
            output_di_job_conclusi: 1,
        })
    })

    it('conta la coda delle notifiche e quelle finite in quarantena', async () => {
        await db.exec(`
      INSERT INTO public.video_outbox(intent_id, revision, event_type, payload, attempts)
      VALUES
        ('${INTENT}', 1, 'intent.superseded', '{}'::jsonb, 0),
        ('${INTENT}', 1, 'intent.revoked', '{}'::jsonb, 25);
    `)

        expect(await rpc('public.video_riconciliazione(48, 168, 1)')).toMatchObject({
            outbox_in_attesa: 2,
            outbox_in_quarantena: 1,
        })
    })

    it('rifiuta gli argomenti impossibili', async () => {
        expect(await rpc('public.video_riconciliazione(NULL, 168, 1)')).toEqual({
            ok: false,
            code: 'BAD_INPUT',
        })
        expect(await rpc('public.video_riconciliazione(48, 0, 1)')).toEqual({
            ok: false,
            code: 'BAD_INPUT',
        })
    })
})

describe('l’invariante, detto una volta sola: NESSUN cammino lascia un originale invisibile', () => {
    it('dopo cancel, revoke, supersede, fail e abbandono, tutte le righe stanno dentro l’indice', async () => {
        // La prova che tiene insieme tutte le altre. Cinque job, cinque modi diversi
        // di finire — tre passano dalle RPC che esistevano già, due dal cammino nuovo
        // — e alla fine si conta: quante righe ci sono, e quante ne vede l'indice
        // parziale della retention. I due numeri devono coincidere.
        const ALTRO_INTENT = '30000000-0000-4000-8000-0000000000aa'
        const TERZO_INTENT = '30000000-0000-4000-8000-0000000000bb'
        const NUOVA_REV = '30000000-0000-4000-8000-0000000000cc'
        await db.exec(`
      INSERT INTO public.video_intents(id, owner_id, scuola_id, channel, requested_action, payload)
      VALUES
        ('${ALTRO_INTENT}', '${OWNER}', '${SEDE}', 'news', 'publish', '{}'),
        ('${TERZO_INTENT}', '${OWNER}', '${SEDE}', 'news', 'publish', '{}');
    `)

        const ANNULLATO = '44000000-0000-4000-8000-000000000001'
        const REVOCATO = '44000000-0000-4000-8000-000000000002'
        const SUPERATO = '44000000-0000-4000-8000-000000000003'
        const ABBANDONATO = '44000000-0000-4000-8000-000000000004'
        const INCAGLIATO = '44000000-0000-4000-8000-000000000005'

        await creaJob(ANNULLATO, { status: 'awaiting_upload' })
        await creaJob(REVOCATO, { status: 'awaiting_upload', intent: ALTRO_INTENT })
        await creaJob(SUPERATO, { status: 'awaiting_upload', intent: TERZO_INTENT })
        await creaJob(ABBANDONATO, { status: 'awaiting_upload', creatoOreFa: 72 })
        await creaJob(INCAGLIATO, { status: 'queued', creatoOreFa: 240, aggiornatoOreFa: 240 })

        expect(await visibiliAllaRetention()).toBe(0)

        expect(await rpc(`public.video_job_cancel('${ANNULLATO}', '${OWNER}')`)).toMatchObject({ ok: true })
        expect(await rpc(`public.video_intent_revoke('${ALTRO_INTENT}', '${OWNER}', 1)`)).toMatchObject({
            ok: true,
        })
        expect(
            await rpc(
                `public.video_intent_supersede('${TERZO_INTENT}', '${OWNER}', 1, '${NUOVA_REV}', NULL, NULL, NULL)`,
            ),
        ).toMatchObject({ ok: true })
        expect(await rpc('public.video_retention_scadenze(48, 168, 100)')).toMatchObject({ ok: true })

        const { rows } = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM public.video_jobs`,
        )
        expect(rows[0].n).toBe(5)
        expect(await visibiliAllaRetention()).toBe(5)
        expect(await rpc('public.video_riconciliazione(48, 168, 1)')).toMatchObject({
            conclusi_senza_scadenza: 0,
        })
    })
})
