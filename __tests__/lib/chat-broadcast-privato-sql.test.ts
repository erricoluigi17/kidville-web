// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * LA CHAT SUL BROADCAST PRIVATO · LA MIGRAZIONE VERA, SU UN POSTGRES VERO.
 *
 * Fase 9 della roadmap di robustezza, problema S4-B. Il trigger su
 * `public.chat_messages` manda un SEGNALE a `realtime.send()` su un canale privato
 * per destinatario, al posto dei `postgres_changes` su tabella intera (la query WAL
 * del Realtime vale 49.361 s di tempo DB dal 06/08, 7,4 M chiamate).
 *
 * Tre cose vanno provate e non si possono provare leggendo il file:
 *
 *  1. **i destinatari sono ESATTAMENTE quelli della RLS** di lettura
 *     (`chat_messages_select_participant`): `teacher_id`, `parent_id`, e
 *     `parents.auth_user_id` del `parents.id = parent_id`. Un destinatario in meno è
 *     una chat che non arriva; uno in più è il messaggio di una famiglia spedito sul
 *     canale di un'altra;
 *  2. **il payload non porta il contenuto.** `realtime.messages` conserva le righe per
 *     qualche giorno (partizioni per data: il 12/10 esistevano dal 09/10 al 15/10),
 *     fuori dall'oblio e dalla scatola nera, e un messaggio di chat fra una famiglia e
 *     la maestra può contenere dati sanitari di un minore;
 *  3. **il guasto del segnale non fa fallire l'INSERT del messaggio.** Un `AFTER
 *     INSERT` che solleva annulla la transazione: la chat smetterebbe di funzionare per
 *     un guasto dell'osservabilità.
 *
 * ─── IL BANCO: `realtime.send` È QUELLA VERA, NON UNO STUB ───────────────────
 *
 * Il corpo di `realtime.send` qui sotto è copiato da `pg_proc.prosrc` della produzione
 * (letto il 2026-10-12, in sola lettura). Non è pignoleria: quella funzione **non ha un
 * `search_path` proprio**, quindi gira con quello del CHIAMANTE — cioè con la stringa
 * vuota che il nostro trigger si impone. Uno stub minimale non avrebbe mai mostrato se
 * un nome dentro di lei resta risolvibile a search_path vuoto (`gen_random_uuid()` lo è
 * perché da Postgres 13 vive in `pg_catalog`; su questo progetto `pgcrypto` sta in
 * `extensions`, che a search_path vuoto non si vede). E porta con sé il suo
 * `EXCEPTION WHEN OTHERS THEN RAISE WARNING`, che è il secondo strato di fail-open.
 *
 * `realtime.messages` in produzione è partizionata per giorno e le partizioni le crea
 * il server Realtime. Qui è una tabella sola: la partizione che manca è un modo in cui
 * `realtime.send` può fallire, e quel caso si prova a parte spegnendola del tutto.
 *
 * PGlite è Postgres 17+; solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_chat_broadcast_privato.sql'))
if (!FILE) throw new Error('migrazione *_chat_broadcast_privato.sql non trovata')
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE), 'utf8')

/**
 * Lo SQL senza NESSUN commento `--`, compresi quelli dentro i corpi `$$ … $$`.
 *
 * `senzaCommenti` di `soglia-fotografia` lascia intatto ciò che sta fra i dollari — ed è
 * giusto, perché lì ci può essere SQL eseguito. Qui serve il contrario: la testata
 * spiega perché il payload non porta il testo del messaggio, quindi la parola `content`
 * compare nella prosa, e un controllo fatto sul file intero sarebbe rosso per la
 * spiegazione invece che per il prodotto.
 */
const ESEGUIBILE = MIGRAZIONE.split('\n')
    .filter((r) => !r.trimStart().startsWith('--'))
    .join('\n')

/**
 * Le chiavi che il payload del segnale deve avere, e nient'altro.
 *
 * `attachment_type` non c'è di proposito: al client non serve più, perché per il thread
 * aperto ricarica la finestra dall'API (che porta testo, tipo e link firmato) e per
 * quelli in background non riscrive l'anteprima. Un campo in meno è un campo che non
 * resta per giorni in `realtime.messages`.
 */
const CHIAVI_PAYLOAD = ['created_at', 'delivered_at', 'id', 'read_at', 'sender_id', 'thread_id']

/* ═══════════════════════════════════════════════════════════════════════════════
 * IL BANCO
 * ═══════════════════════════════════════════════════════════════════════════════ */

/** Il corpo di `realtime.send` della produzione, letto da `pg_proc.prosrc` il 2026-10-12. */
const REALTIME_SEND_VERA = `
create function realtime.send(payload jsonb, event text, topic text, private boolean default false)
returns void language plpgsql as $send$
DECLARE
  generated_id uuid;
  final_payload jsonb;
BEGIN
  BEGIN
    generated_id := gen_random_uuid();

    IF payload ? 'id' THEN
      final_payload := payload;
    ELSE
      final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
    END IF;

    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);

    INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
    VALUES (generated_id, final_payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'WarnSendingBroadcastMessage: %', SQLERRM;
  END;
END;
$send$;
`

/** Lo schema come in produzione PRIMA della migrazione (catalogo del 2026-10-12). */
async function schemaComeProduzione(db: PGlite): Promise<void> {
    await db.exec(`
      create role anon;
      create role authenticated;

      create schema auth;
      grant usage on schema auth to anon, authenticated;
      -- Il corpo vero di auth.uid() in produzione (pg_get_functiondef, 2026-10-12).
      create function auth.uid() returns uuid language sql stable as $uid$
        select coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid
      $uid$;
      grant execute on function auth.uid() to anon, authenticated;

      create schema realtime;
      grant usage on schema realtime to anon, authenticated;
      create table realtime.messages (
        topic text not null,
        extension text not null,
        payload jsonb,
        event text,
        private boolean default false,
        updated_at timestamp not null default now(),
        inserted_at timestamp not null default now(),
        id uuid not null default gen_random_uuid(),
        primary key (id, inserted_at)
      );
      alter table realtime.messages enable row level security;
      grant select, insert, update on realtime.messages to anon, authenticated, postgres;
      create function realtime.topic() returns text language sql stable as $t$
        select nullif(current_setting('realtime.topic', true), '')::text
      $t$;
      grant execute on function realtime.topic() to anon, authenticated;
    `)
    await db.exec(REALTIME_SEND_VERA)
    await db.exec(`
      create table public.parents (id uuid primary key, auth_user_id uuid);
      create table public.chat_threads (
        id uuid primary key,
        teacher_id uuid not null,
        parent_id uuid not null,
        student_id uuid,
        last_message_at timestamptz,
        created_at timestamptz default now()
      );
      create table public.chat_messages (
        id uuid primary key,
        thread_id uuid not null references public.chat_threads(id),
        sender_id uuid not null,
        content text not null,
        attachment_url text,
        attachment_type varchar(20),
        read_at timestamptz,
        created_at timestamptz default now(),
        delivered_at timestamptz
      );
    `)
}

/** uuid finti, leggibili nel rosso. */
const u = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const DOCENTE = u(1)
const GENITORE_AUTH = u(2)
const PARENTS_ROW = u(3)
const ESTRANEO = u(9)

let progressivo = 100
const nuovoId = () => u(++progressivo)

type Segnale = { topic: string; event: string; private: boolean; extension: string; payload: Record<string, unknown> }

async function segnali(db: PGlite): Promise<Segnale[]> {
    const { rows } = await db.query<Segnale>(
        `select topic, event, private, extension, payload from realtime.messages order by topic, event, inserted_at`,
    )
    return rows
}

/** Un thread con il genitore collegato via `parents` (il caso normale di produzione). */
async function threadNormale(db: PGlite): Promise<string> {
    const thread = nuovoId()
    await db.query(`insert into public.parents (id, auth_user_id) values ($1, $2)`, [PARENTS_ROW, GENITORE_AUTH])
    await db.query(`insert into public.chat_threads (id, teacher_id, parent_id) values ($1, $2, $3)`, [thread, DOCENTE, PARENTS_ROW])
    return thread
}

async function inserisciMessaggio(db: PGlite, thread: string, extra: Partial<Record<string, unknown>> = {}): Promise<string> {
    const id = nuovoId()
    await db.query(
        `insert into public.chat_messages (id, thread_id, sender_id, content, attachment_url, attachment_type, created_at, read_at, delivered_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
            id,
            thread,
            (extra.sender_id as string) ?? DOCENTE,
            (extra.content as string) ?? 'Allergia alle arachidi, ha la penna in cartella',
            (extra.attachment_url as string) ?? null,
            (extra.attachment_type as string) ?? null,
            (extra.created_at as string) ?? '2026-10-12T08:00:00.000Z',
            (extra.read_at as string) ?? null,
            (extra.delivered_at as string) ?? null,
        ],
    )
    return id
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * LA MIGRAZIONE, LETTA
 * ═══════════════════════════════════════════════════════════════════════════════ */

describe('la migrazione del broadcast, letta', () => {
    it('🔴 NESSUN `alter table realtime.messages`: quella riga sola farebbe rotolare indietro tutto il file', () => {
        // `realtime.messages` è di `supabase_realtime_admin`, e `postgres` non ne è membro
        // (misurato il 2026-10-12: pg_has_role(postgres, supabase_realtime_admin, USAGE) = false).
        // `supautils.policy_grants` delega a `postgres` SOLO create/alter/drop policy; ogni
        // `ALTER TABLE` resta rifiutato — compreso `enable row level security`, che Postgres
        // boccia per ownership PRIMA di accorgersi che la RLS è già accesa. Un'istruzione
        // fallita annulla la transazione, e il file intero non viene applicato.
        expect(ESEGUIBILE.toLowerCase()).not.toMatch(/alter\s+table\s+(only\s+)?"?realtime"?\s*\.\s*"?messages"?/)
    })

    it('la policy è SELECT per `authenticated`, e non ce n’è nessuna di INSERT', () => {
        const policy = /create\s+policy[\s\S]*?on\s+"?realtime"?\s*\.\s*"?messages"?([\s\S]*?);/gi
        const trovate = [...ESEGUIBILE.matchAll(policy)]
        expect(trovate, 'nessuna policy su realtime.messages: i canali privati non si possono aprire').toHaveLength(1)
        const corpo = trovate[0][1].toLowerCase()
        expect(corpo).toMatch(/for\s+select/)
        expect(corpo).toMatch(/to\s+authenticated/)
        expect(corpo, 'una policy di INSERT farebbe dei client dei trasmettitori').not.toMatch(/for\s+(insert|all|update|delete)/)
    })

    it('il payload nomina le sei chiavi dichiarate, e MAI il contenuto o l’allegato', () => {
        const chiavi = [...ESEGUIBILE.matchAll(/'([a-z_]+)',\s*new\./gi)].map((m) => m[1]).sort()
        expect([...new Set(chiavi)]).toEqual(CHIAVI_PAYLOAD)
        expect(ESEGUIBILE, 'il testo del messaggio non esce dalla tabella della chat').not.toMatch(/new\.content/i)
        expect(ESEGUIBILE, 'il percorso dell’allegato non esce dalla tabella della chat').not.toMatch(/new\.attachment_url/i)
        expect(ESEGUIBILE, 'il tipo dell’allegato al client non serve: non resta per giorni in realtime.messages').not.toMatch(
            /new\.attachment_type/i,
        )
    })

    it('la funzione è SECURITY DEFINER con `search_path = \'\'` e l’EXECUTE revocato ad anon E authenticated', () => {
        expect(ESEGUIBILE.toLowerCase()).toMatch(/security\s+definer/)
        expect(ESEGUIBILE).toMatch(/set\s+search_path\s*=\s*''/i)
        const revoke = /revoke\s+all\s+on\s+function\s+public\.chat_messaggio_broadcast\(\)\s+from\s+([^;]+);/i.exec(ESEGUIBILE)
        expect(revoke, 'nessun REVOKE nominativo: la funzione resta chiamabile via /rest/v1/rpc').not.toBeNull()
        const ruoli = (revoke?.[1] ?? '').toLowerCase()
        for (const ruolo of ['public', 'anon', 'authenticated']) expect(ruoli).toContain(ruolo)
    })

    it('`realtime.send` è chiamata con `private` a `true`, esplicito', () => {
        const chiamate = [...ESEGUIBILE.matchAll(/realtime\.send\(([^;]*?)\)\s*;/gi)].map((m) => m[1])
        expect(chiamate.length).toBeGreaterThan(0)
        for (const argomenti of chiamate) expect(argomenti.toLowerCase().replace(/\s+/g, ' ')).toMatch(/,\s*true\s*$/)
    })

    it('il trigger dell’UPDATE ha la sua clausola WHEN: un testo riscritto non è una spunta', () => {
        expect(ESEGUIBILE.toLowerCase().replace(/\s+/g, ' ')).toContain(
            'when (old.read_at is distinct from new.read_at or old.delivered_at is distinct from new.delivered_at)',
        )
    })
})

/* ═══════════════════════════════════════════════════════════════════════════════
 * LA MIGRAZIONE, APPLICATA
 * ═══════════════════════════════════════════════════════════════════════════════ */

describe('la migrazione del broadcast, applicata', () => {
    let db: PGlite

    beforeAll(async () => {
        db = new PGlite()
        await schemaComeProduzione(db)
        await db.exec(MIGRAZIONE)
    }, 60_000)
    afterAll(async () => {
        await db?.close()
    })

    beforeEach(async () => {
        await db.exec('delete from realtime.messages; delete from public.chat_messages; delete from public.chat_threads; delete from public.parents;')
    })

    it('la funzione nasce SECURITY DEFINER, con `search_path` vuoto, e non è eseguibile da anon/authenticated', async () => {
        const { rows } = await db.query<{ prosecdef: boolean; proconfig: string | null; anon: boolean; auth: boolean }>(
            `select p.prosecdef, array_to_string(p.proconfig, ',') as proconfig,
                    has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                    has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'chat_messaggio_broadcast'`,
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].prosecdef).toBe(true)
        // `SET search_path = ''` si deposita in proconfig come `search_path=""`, con le
        // virgolette: il valore è la stringa vuota, non l'assenza del parametro.
        expect(rows[0].proconfig).toBe('search_path=""')
        expect(rows[0].anon).toBe(false)
        expect(rows[0].auth).toBe(false)
    })

    it('due trigger su chat_messages: AFTER INSERT e AFTER UPDATE, FOR EACH ROW, e nient’altro', async () => {
        const { rows } = await db.query<{ tgname: string; def: string }>(
            `select t.tgname, pg_get_triggerdef(t.oid) as def
               from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'chat_messages' and not t.tgisinternal
              order by t.tgname`,
        )
        expect(rows.map((r) => r.tgname)).toHaveLength(2)
        const insieme = rows.map((r) => r.def.toLowerCase().replace(/\s+/g, ' ')).join(' | ')
        expect(insieme).toMatch(/after insert on public\.chat_messages for each row/)
        expect(insieme).toMatch(/after update on public\.chat_messages for each row when/)
    })

    it('🔴 i destinatari sono i TRE della RLS, distinti, e il topic è `chat:<uid>`', async () => {
        const thread = await threadNormale(db)
        await inserisciMessaggio(db, thread)

        const righe = await segnali(db)
        expect(righe.map((r) => r.topic).sort()).toEqual(
            [`chat:${DOCENTE}`, `chat:${GENITORE_AUTH}`, `chat:${PARENTS_ROW}`].sort(),
        )
        for (const r of righe) {
            expect(r.event).toBe('INSERT')
            expect(r.private, 'un canale non privato non passa dalla RLS').toBe(true)
            expect(r.extension).toBe('broadcast')
        }
        expect(righe.some((r) => r.topic === `chat:${ESTRANEO}`)).toBe(false)
    })

    it('🔴 il payload porta le sei chiavi dichiarate e NON il contenuto né l’allegato', async () => {
        const thread = await threadNormale(db)
        const id = await inserisciMessaggio(db, thread, {
            content: 'Diagnosi: celiachia. Niente glutine in mensa.',
            attachment_url: 'gen-1/referto.pdf',
            attachment_type: 'document',
            delivered_at: '2026-10-12T08:00:05.000Z',
        })

        const righe = await segnali(db)
        expect(righe.length).toBeGreaterThan(0)
        for (const r of righe) {
            expect(Object.keys(r.payload).sort()).toEqual(CHIAVI_PAYLOAD)
            expect(r.payload.id).toBe(id)
            expect(r.payload.thread_id).toBe(thread)
            expect(r.payload.sender_id).toBe(DOCENTE)
            expect(r.payload.read_at).toBeNull()
            expect(r.payload.delivered_at).not.toBeNull()
        }
        const tutto = JSON.stringify(righe)
        expect(tutto, 'il testo del messaggio è finito in realtime.messages').not.toContain('celiachia')
        expect(tutto, 'il percorso dell’allegato è finito in realtime.messages').not.toContain('referto.pdf')
        expect(tutto, 'il tipo dell’allegato è finito in realtime.messages').not.toContain('document')
    })

    it('un thread il cui `parent_id` è già un uid di auth (nessuna riga in `parents`): due destinatari, nessun null', async () => {
        const thread = nuovoId()
        await db.query(`insert into public.chat_threads (id, teacher_id, parent_id) values ($1, $2, $3)`, [thread, DOCENTE, GENITORE_AUTH])
        await inserisciMessaggio(db, thread)

        const righe = await segnali(db)
        expect(righe.map((r) => r.topic).sort()).toEqual([`chat:${DOCENTE}`, `chat:${GENITORE_AUTH}`].sort())
        expect(righe.some((r) => r.topic.includes('null'))).toBe(false)
    })

    it('un genitore la cui riga `parents` ha `auth_user_id` uguale al `parent_id`: UN canale, non due', async () => {
        const thread = nuovoId()
        await db.query(`insert into public.parents (id, auth_user_id) values ($1, $1)`, [GENITORE_AUTH])
        await db.query(`insert into public.chat_threads (id, teacher_id, parent_id) values ($1, $2, $3)`, [thread, DOCENTE, GENITORE_AUTH])
        await inserisciMessaggio(db, thread)

        const righe = await segnali(db)
        expect(righe.map((r) => r.topic).sort()).toEqual([`chat:${DOCENTE}`, `chat:${GENITORE_AUTH}`].sort())
    })

    it('un genitore senza account (`parents.auth_user_id` nullo): il canale del docente e quello della riga, mai `chat:`', async () => {
        const thread = nuovoId()
        await db.query(`insert into public.parents (id, auth_user_id) values ($1, null)`, [PARENTS_ROW])
        await db.query(`insert into public.chat_threads (id, teacher_id, parent_id) values ($1, $2, $3)`, [thread, DOCENTE, PARENTS_ROW])
        await inserisciMessaggio(db, thread)

        const righe = await segnali(db)
        expect(righe.map((r) => r.topic).sort()).toEqual([`chat:${DOCENTE}`, `chat:${PARENTS_ROW}`].sort())
    })

    it('🔴 l’UPDATE delle spunte manda un segnale `UPDATE`; riscrivere il testo non manda niente', async () => {
        const thread = await threadNormale(db)
        const id = await inserisciMessaggio(db, thread)
        await db.exec('delete from realtime.messages')

        await db.query(`update public.chat_messages set content = 'testo riscritto' where id = $1`, [id])
        expect(await segnali(db), 'un UPDATE che non tocca le spunte ha svegliato il canale').toEqual([])

        await db.query(`update public.chat_messages set delivered_at = now() where id = $1`, [id])
        let righe = await segnali(db)
        expect(righe).toHaveLength(3)
        expect(new Set(righe.map((r) => r.event))).toEqual(new Set(['UPDATE']))

        await db.exec('delete from realtime.messages')
        await db.query(`update public.chat_messages set read_at = now() where id = $1`, [id])
        righe = await segnali(db)
        expect(righe).toHaveLength(3)
        expect(righe[0].payload.read_at).not.toBeNull()

        // Lo stesso valore riscritto non è un cambiamento: `IS DISTINCT FROM` lo vede.
        await db.exec('delete from realtime.messages')
        await db.query(`update public.chat_messages set read_at = read_at where id = $1`, [id])
        expect(await segnali(db)).toEqual([])
    })
})

/* ═══════════════════════════════════════════════════════════════════════════════
 * FAIL-OPEN: UN GUASTO DEL SEGNALE NON PERDE UN MESSAGGIO
 * ═══════════════════════════════════════════════════════════════════════════════ */

describe('fail-open · l’INSERT del messaggio riesce comunque', () => {
    /** Un banco nuovo per ogni caso: qui si rompe lo schema di proposito. */
    async function banco(): Promise<PGlite> {
        const db = new PGlite()
        await schemaComeProduzione(db)
        await db.exec(MIGRAZIONE)
        return db
    }

    async function quantiMessaggi(db: PGlite): Promise<number> {
        const { rows } = await db.query<{ n: number }>('select count(*)::int as n from public.chat_messages')
        return rows[0].n
    }

    it('🔴 `realtime.send` che SOLLEVA: il messaggio è salvato, e nessuno lo perde', async () => {
        const db = await banco()
        try {
            const thread = await threadNormale(db)
            await db.exec(`
              create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default false)
              returns void language plpgsql as $x$ begin raise exception 'il Realtime è giù'; end; $x$;
            `)
            await inserisciMessaggio(db, thread)
            expect(await quantiMessaggi(db), 'un guasto del segnale ha annullato l’INSERT del messaggio').toBe(1)
        } finally {
            await db.close()
        }
    }, 60_000)

    it('🔴 `realtime.messages` che non c’è più (partizione mancante): il messaggio è salvato', async () => {
        const db = await banco()
        try {
            const thread = await threadNormale(db)
            // In produzione le partizioni per giorno le crea il server Realtime: se smette,
            // l'INSERT dentro `realtime.send` fallisce. Qui si toglie la tabella intera.
            await db.exec('drop table realtime.messages cascade;')
            await inserisciMessaggio(db, thread)
            expect(await quantiMessaggi(db)).toBe(1)
        } finally {
            await db.close()
        }
    }, 60_000)

    it('🔴 la ricerca dei destinatari che fallisce (`public.parents` sparita): il messaggio è salvato', async () => {
        const db = await banco()
        try {
            const thread = await threadNormale(db)
            await db.exec('drop table public.parents cascade;')
            await inserisciMessaggio(db, thread)
            expect(await quantiMessaggi(db)).toBe(1)
            expect(await segnali(db), 'il giro è fallito a metà e ha mandato un segnale parziale').toEqual([])
        } finally {
            await db.close()
        }
    }, 60_000)

    it('l’UPDATE delle spunte con il segnale rotto riesce lo stesso', async () => {
        const db = await banco()
        try {
            const thread = await threadNormale(db)
            const id = await inserisciMessaggio(db, thread)
            await db.exec(`
              create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default false)
              returns void language plpgsql as $x$ begin raise exception 'il Realtime è giù'; end; $x$;
            `)
            await db.query(`update public.chat_messages set read_at = now() where id = $1`, [id])
            const { rows } = await db.query<{ letto: string | null }>('select read_at::text as letto from public.chat_messages where id = $1', [id])
            expect(rows[0].letto, 'la spunta non è stata registrata').not.toBeNull()
        } finally {
            await db.close()
        }
    }, 60_000)
})

/* ═══════════════════════════════════════════════════════════════════════════════
 * LA POLICY: CHI PUÒ APRIRE IL CANALE, E CHI NON PUÒ TRASMETTERE
 * ═══════════════════════════════════════════════════════════════════════════════ */

describe('la policy su realtime.messages · chi può APRIRE un canale privato', () => {
    /**
     * ⚠️ CHE COSA DECIDE DAVVERO QUESTA POLICY, misurato qui e non immaginato.
     *
     * L'espressione è quella della documentazione di Realtime Authorization: confronta il
     * TOPIC DELLA CONNESSIONE (`realtime.topic()`, un GUC che imposta solo il server
     * Realtime quando un client entra in un canale) con `'chat:' || auth.uid()`. Non
     * confronta il topic della RIGA. Quindi la policy è un permesso di INGRESSO al canale,
     * e non un filtro per riga: a GUC favorevole, un `select` vede tutte le righe
     * `extension = 'broadcast'`.
     *
     * Non è una falla, e il confine va saputo: quel GUC nessun client lo può impostare —
     * via PostgREST `realtime.topic()` è NULL, e `NULL = 'chat:…'` non è vero, quindi da
     * lì non si vede niente; e lo schema `realtime` non è fra quelli esposti. Le righe,
     * comunque, non portano né testo né allegati.
     *
     * Stringere con `AND topic = 'chat:' || auth.uid()` è la mossa successiva, e NON si fa
     * qui: il controllo di Realtime passa da una riga che il server stesso inserisce e poi
     * rotola indietro, e di quel meccanismo non abbiamo una misura — una condizione in più
     * che non si accorda con la riga finta chiuderebbe il canale a tutti, cioè spegnerebbe
     * il tempo reale invece di stringerlo. Si valuta dopo aver visto i join riuscire.
     */
    let db: PGlite

    beforeAll(async () => {
        db = new PGlite()
        await schemaComeProduzione(db)
        await db.exec(MIGRAZIONE)
        const thread = await threadNormale(db)
        await inserisciMessaggio(db, thread)
    }, 60_000)
    afterAll(async () => {
        await db?.close()
    })

    /** `authenticated` con quell'uid, entrando in quel topic, vede qualcosa? */
    async function puoAprire(uid: string, topic: string): Promise<boolean> {
        await db.exec('begin')
        try {
            await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
            await db.query(`select set_config('realtime.topic', $1, true)`, [topic])
            await db.exec('set local role authenticated')
            const { rows } = await db.query<{ n: number }>('select count(*)::int as n from realtime.messages')
            return rows[0].n > 0
        } finally {
            await db.exec('rollback')
        }
    }

    it('🔴 il genitore apre il proprio canale', async () => {
        expect(await puoAprire(GENITORE_AUTH, `chat:${GENITORE_AUTH}`)).toBe(true)
    })

    it('🔴 e NON apre quello di un’altra famiglia, né quello della maestra', async () => {
        expect(await puoAprire(GENITORE_AUTH, `chat:${ESTRANEO}`)).toBe(false)
        expect(await puoAprire(GENITORE_AUTH, `chat:${DOCENTE}`)).toBe(false)
        expect(await puoAprire(ESTRANEO, `chat:${GENITORE_AUTH}`)).toBe(false)
    })

    it('un topic che non è il proprio canale di chat non si apre, nemmeno quasi', async () => {
        expect(await puoAprire(GENITORE_AUTH, GENITORE_AUTH)).toBe(false)
        expect(await puoAprire(GENITORE_AUTH, `chat:${GENITORE_AUTH}:extra`)).toBe(false)
        expect(await puoAprire(GENITORE_AUTH, `CHAT:${GENITORE_AUTH}`)).toBe(false)
        expect(await puoAprire(GENITORE_AUTH, '')).toBe(false)
    })

    it('🔴 senza sessione (anon, nessun claim) non si apre niente', async () => {
        await db.exec('begin')
        try {
            await db.query(`select set_config('realtime.topic', $1, true)`, [`chat:${GENITORE_AUTH}`])
            await db.exec('set local role anon')
            const { rows } = await db.query<{ n: number }>('select count(*)::int as n from realtime.messages')
            expect(rows[0].n, 'la policy è `to authenticated`: anon non deve vedere niente').toBe(0)
        } finally {
            await db.exec('rollback')
        }
    })

    it('la policy guarda `extension`: con sole righe di presence il permesso di broadcast non si apre', async () => {
        await db.exec('begin')
        try {
            // La presence vive nella stessa tabella: se la policy non filtrasse l'extension,
            // una riga di presence basterebbe ad aprire il canale dei broadcast.
            await db.exec(`delete from realtime.messages`)
            await db.query(
                `insert into realtime.messages (topic, extension, event, private, payload) values ($1, 'presence', 'track', true, '{}'::jsonb)`,
                [`chat:${GENITORE_AUTH}`],
            )
            await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [GENITORE_AUTH])
            await db.query(`select set_config('realtime.topic', $1, true)`, [`chat:${GENITORE_AUTH}`])
            await db.exec('set local role authenticated')
            const { rows } = await db.query<{ n: number }>('select count(*)::int as n from realtime.messages')
            expect(rows[0].n).toBe(0)
        } finally {
            await db.exec('rollback')
        }
    })

    it('🔴 un client NON può trasmettere sul proprio canale: nessuna policy di INSERT', async () => {
        await db.exec('begin')
        try {
            await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [GENITORE_AUTH])
            await db.query(`select set_config('realtime.topic', $1, true)`, [`chat:${GENITORE_AUTH}`])
            await db.exec('set local role authenticated')
            const errore = await db
                .query(`insert into realtime.messages (topic, extension, event, private, payload) values ($1, 'broadcast', 'INSERT', true, '{}'::jsonb)`, [
                    `chat:${GENITORE_AUTH}`,
                ])
                .then(
                    () => null,
                    (e: { code?: string }) => e,
                )
            expect(errore?.code, 'un client può fabbricare messaggi sul canale privato').toBe('42501')
        } finally {
            await db.exec('rollback')
        }
    })
})

/* ═══════════════════════════════════════════════════════════════════════════════
 * IL ROLLBACK DELLA TESTATA
 * ═══════════════════════════════════════════════════════════════════════════════ */

describe('il rollback scritto nella testata', () => {
    /** Le istruzioni del blocco ROLLBACK, lette dal file e senza i `--`. */
    function rollback(): string[] {
        const righe = MIGRAZIONE.split('\n')
        const inizio = righe.findIndex((r) => /^--\s*─+\s*ROLLBACK/.test(r))
        expect(inizio, 'nessun blocco ROLLBACK nella testata').toBeGreaterThan(-1)
        const istruzioni: string[] = []
        for (const r of righe.slice(inizio + 1)) {
            if (!r.startsWith('--')) break
            const nuda = r.replace(/^--\s{0,3}/, '').trim()
            if (/^(drop|create|alter|revoke|grant)\b/i.test(nuda) && nuda.endsWith(';')) istruzioni.push(nuda)
        }
        return istruzioni
    }

    it('esiste, ed è eseguibile: trigger, funzione e policy tornano come prima', async () => {
        const istruzioni = rollback()
        expect(istruzioni.length, 'il rollback della testata non contiene istruzioni eseguibili').toBeGreaterThanOrEqual(3)

        const db = new PGlite()
        try {
            await schemaComeProduzione(db)
            await db.exec(MIGRAZIONE)
            for (const istruzione of istruzioni) await db.exec(istruzione)

            const { rows: trigger } = await db.query<{ n: number }>(
                `select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  where c.relname = 'chat_messages' and not t.tgisinternal`,
            )
            expect(trigger[0].n).toBe(0)
            const { rows: fn } = await db.query<{ n: number }>(
                `select count(*)::int as n from pg_proc where proname = 'chat_messaggio_broadcast'`,
            )
            expect(fn[0].n).toBe(0)
            const { rows: pol } = await db.query<{ n: number }>(
                `select count(*)::int as n from pg_policies where schemaname = 'realtime' and tablename = 'messages'`,
            )
            expect(pol[0].n).toBe(0)

            // E la chat continua a funzionare senza il segnale.
            const thread = await threadNormale(db)
            await inserisciMessaggio(db, thread)
            const { rows } = await db.query<{ n: number }>('select count(*)::int as n from public.chat_messages')
            expect(rows[0].n).toBe(1)
        } finally {
            await db.close()
        }
    }, 60_000)
})

describe('il nome del canale: il client e la migrazione dicono LA STESSA cosa', () => {
    /**
     * UNA stringa in due file, e uno sfasamento che NON si vede.
     *
     * Il trigger manda su `'chat:' || <uid>` e la policy autorizza `'chat:' || auth.uid()`; il
     * client apre `PREFISSO_TOPIC + <uid di auth>`. Se uno dei tre cambia da solo non si rompe
     * niente di rumoroso: il client resta sottoscritto a un canale su cui nessuno parla, i log
     * restano puliti, i test del task restano verdi, e la chat diventa muta — con il polling a 30 s
     * a coprire abbastanza bene da non far sospettare nulla. È esattamente la forma di guasto che
     * questo progetto ha già pagato (le email di credenziali, il diario «vuoto», i messaggi che non
     * arrivavano alle maestre): nessun errore, solo silenzio.
     *
     * Non si può provare con un test di comportamento — il server Realtime non c'è né in vitest né
     * in PGlite — quindi si prova sui byte dei due file.
     */
    /**
     * Il hook SENZA commenti. Non è un vezzo: la sua testata racconta per esteso che i
     * `postgres_changes` sono stati tolti, quindi quella parola compare nella prosa. Un controllo
     * fatto sul file intero sarebbe rosso per la spiegazione e verde per un binding vero — cioè un
     * lock che si immunizza da sé col proprio commento.
     */
    const HOOK = readFileSync(join(process.cwd(), 'src/components/features/chat/useChatRealtime.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')

    it('il prefisso del client è lo stesso del trigger E della policy', () => {
        const dichiarato = /const PREFISSO_TOPIC = '([^']+)'/.exec(HOOK)
        expect(dichiarato, 'il client non dichiara più `PREFISSO_TOPIC`: il nome del canale è sparso nel codice').not.toBeNull()
        const prefisso = dichiarato![1]
        expect(prefisso).toBe('chat:')

        // Il client lo USA per comporre il topic, e non lo tiene solo come costante decorativa.
        expect(HOOK).toContain('.channel(PREFISSO_TOPIC + identita.uid')

        // Il trigger manda su quel prefisso, e la policy autorizza quel prefisso: due occorrenze.
        const occorrenze = ESEGUIBILE.match(new RegExp(`'${prefisso}' \\|\\|`, 'g')) ?? []
        expect(
            occorrenze,
            `la migrazione non compone '${prefisso}' || … due volte (una nel trigger, una nella policy): ` +
                'uno dei due lati parla di un canale che l’altro non conosce, e la chat diventa muta in silenzio',
        ).toHaveLength(2)
    })

    it('il client non ascolta `postgres_changes`: è la voce che questa fase esiste per spegnere', () => {
        expect(
            HOOK,
            'un binding postgres_changes rimette il database a decodificare il WAL per ogni client collegato: ' +
                'è la query da 49.361 s di tempo DB che la fase 9 toglie',
        ).not.toContain('postgres_changes')
    })

    it('il client ascolta gli eventi che il trigger manda (TG_OP: INSERT e UPDATE)', () => {
        expect(ESEGUIBILE).toContain('realtime.send(v_payload, TG_OP')
        for (const evento of ['INSERT', 'UPDATE']) {
            expect(HOOK, `il client non ascolta l’evento ${evento}`).toContain(`.on('broadcast', { event: '${evento}' }`)
        }
    })
})
