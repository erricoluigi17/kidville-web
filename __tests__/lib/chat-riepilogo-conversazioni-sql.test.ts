// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * IL RIEPILOGO DELLE CONVERSAZIONI · LA MIGRAZIONE VERA, SU UN POSTGRES VERO.
 *
 * Robustezza 2, sessione 12 (S7). `GET /api/chat/threads` costruiva la lista con quattro letture per
 * conversazione: ~150 richieste al database con 37 conversazioni, ogni 30 s, per due orologi.
 * `public.chat_riepilogo_conversazioni(p_utente)` restituisce la stessa forma in una chiamata.
 *
 * Qui si prova che la forma è QUELLA di prima (ordine, ripieghi «?» e «unknown», non letti, ultimo
 * messaggio), che nessuno vede le conversazioni altrui (il filtro, i permessi, e la RLS come
 * seconda difesa se un GRANT sbagliato aprisse la porta), e che senza le colonne la migrazione
 * non si rompe: salta. PGlite è Postgres 17+; solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_chat_riepilogo_conversazioni.sql'))
if (!FILE) throw new Error('migrazione *_chat_riepilogo_conversazioni.sql non trovata')
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE), 'utf8')

/** uuid finti, leggibili nel rosso. */
const u = (n: number) => `f1200000-0000-4000-8000-${String(n).padStart(12, '0')}`
const D1 = u(1)
const D2 = u(2)
const G1 = u(11)
const G2 = u(12)
const A1 = u(21)
const A2 = u(22)
const T1 = u(31)
const T2 = u(32)
const T3 = u(33)
const T4 = u(34)
const NESSUNO = u(97)
const ALUNNO_FANTASMA = u(98)
const ESTRANEO = u(99)
const m = (n: number) => u(40 + n)

const RUOLO_GENERATO = `role text generated always as (
  case ruolo when 'genitore' then 'parent' when 'docente' then 'teacher' else ruolo end) stored`

/** Lo schema delle quattro tabelle lette, come in produzione. `conFirstName: false` = DB non migrato. */
async function schema(db: PGlite, { conFirstName }: { conFirstName: boolean }): Promise<void> {
  const firstName = conFirstName ? 'first_name text,' : ''
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role nologin bypassrls;

    create schema auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create function auth.uid() returns uuid language sql stable as $uid$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
    $uid$;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;

    create table public.parents (id uuid primary key, auth_user_id uuid);
    create table public.utenti (
      id uuid primary key, nome text, cognome text, ruolo text, ${firstName} last_name text,
      ${RUOLO_GENERATO}
    );
    create table public.alunni (id uuid primary key, nome text, cognome text, classe_sezione text);
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
      read_at timestamptz,
      delivered_at timestamptz,
      created_at timestamptz default now()
    );
    grant select on all tables in schema public to authenticated, service_role;
  `)
}

/**
 * I dati. T1 = D1↔G1 (08:00), T2 = D1↔G2 (09:00), T3 = D2↔G2 (mai scritta), T4 = D1↔ESTRANEO con un
 * alunno che non esiste (07:00). Nomi vuoti e nulli per provare i ripieghi.
 */
async function dati(db: PGlite): Promise<void> {
  await db.exec(`
    insert into public.utenti (id, nome, cognome, ruolo, first_name, last_name) values
      ('${D1}', 'NomeD1', 'CognomeD1', 'docente', 'FirstD1', 'LastD1'),
      ('${D2}', 'NomeD2', 'CognomeD2', 'docente', null, null),
      ('${G1}', 'NomeG1', 'CognomeG1', 'genitore', 'FirstG1', ''),
      ('${G2}', '', 'CognomeG2', 'genitore', '', 'LastG2');
    insert into public.alunni (id, nome, cognome, classe_sezione) values
      ('${A1}', 'NomeA1', 'CognomeA1', 'Sez1'),
      ('${A2}', 'NomeA2', 'CognomeA2', null);
    insert into public.chat_threads (id, teacher_id, parent_id, student_id, last_message_at) values
      ('${T1}', '${D1}', '${G1}', '${A1}', '2026-10-20T08:00:00Z'),
      ('${T2}', '${D1}', '${G2}', '${A2}', '2026-10-20T09:00:00Z'),
      ('${T3}', '${D2}', '${G2}', '${A2}', null),
      ('${T4}', '${D1}', '${ESTRANEO}', '${ALUNNO_FANTASMA}', '2026-10-20T07:00:00Z');
    insert into public.chat_messages (id, thread_id, sender_id, content, read_at, delivered_at, created_at) values
      ('${m(1)}', '${T1}', '${D1}', 'testo finto 1', null, null, '2026-10-20T07:00:00Z'),
      ('${m(2)}', '${T1}', '${D1}', 'testo finto 2', null, '2026-10-20T07:15:00Z', '2026-10-20T07:10:00Z'),
      ('${m(3)}', '${T1}', '${D1}', 'testo finto 3', '2026-10-20T07:30:00Z', '2026-10-20T07:25:00Z', '2026-10-20T07:20:00Z'),
      ('${m(4)}', '${T1}', '${G1}', 'testo finto 4', null, null, '2026-10-20T08:00:00Z'),
      ('${m(5)}', '${T2}', '${G2}', 'testo finto 5', null, null, '2026-10-20T09:00:00Z');
  `)
}

type Riga = Record<string, unknown> & {
  id: string
  unread_count: number
  other_user: { first_name: string; last_name: string; role: string }
  student: { nome: string; cognome: string; classe_sezione: string | null }
  last_message: { content: string; sender_id: string; created_at: string } | null
}

async function riepilogo(db: PGlite, utente: string): Promise<Riga[]> {
  const { rows } = await db.query<{ r: Riga[] }>('select public.chat_riepilogo_conversazioni($1) as r', [utente])
  return rows[0].r
}

const perId = (righe: Riga[]) => Object.fromEntries(righe.map((r) => [r.id, r]))

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await schema(db, { conFirstName: true })
  await dati(db)
  await db.exec(MIGRAZIONE)
})

afterAll(async () => {
  await db.close()
})

describe('chat_riepilogo_conversazioni — la forma di prima, in una chiamata', () => {
  it('ordine per last_message_at decrescente, i null in testa (come `order(..., { ascending: false })`)', async () => {
    expect((await riepilogo(db, G1)).map((r) => r.id)).toEqual([T1])
    expect((await riepilogo(db, G2)).map((r) => r.id)).toEqual([T3, T2])
    expect((await riepilogo(db, D1)).map((r) => r.id)).toEqual([T2, T1, T4])
    expect((await riepilogo(db, D2)).map((r) => r.id)).toEqual([T3])
    expect(await riepilogo(db, NESSUNO)).toEqual([])
  })

  it('i non letti sono i messaggi ALTRUI con read_at nullo (consegnati o no)', async () => {
    const g1 = perId(await riepilogo(db, G1))
    expect(g1[T1].unread_count).toBe(2)
    const d1 = perId(await riepilogo(db, D1))
    expect(d1[T1].unread_count).toBe(1)
    expect(d1[T2].unread_count).toBe(1)
    expect(d1[T4].unread_count).toBe(0)
    const g2 = perId(await riepilogo(db, G2))
    expect(g2[T2].unread_count, 'il proprio messaggio non è un non letto').toBe(0)
  })

  it('le chiavi sono quelle di `select(*)` più le quattro dell’arricchimento', async () => {
    const [riga] = await riepilogo(db, G1)
    expect(Object.keys(riga).sort()).toEqual([
      'created_at', 'id', 'last_message', 'last_message_at', 'other_user', 'parent_id',
      'student', 'student_id', 'teacher_id', 'unread_count',
    ])
    expect(Object.keys(riga.last_message ?? {}).sort()).toEqual(['content', 'created_at', 'sender_id'])
  })

  it('l’ultimo messaggio è il più recente del thread, e nessun messaggio vale null', async () => {
    const [t1] = await riepilogo(db, G1)
    expect(t1.last_message?.content).toBe('testo finto 4')
    expect(t1.last_message?.sender_id).toBe(G1)
    expect(Date.parse(t1.last_message?.created_at ?? '')).toBe(Date.parse('2026-10-20T08:00:00Z'))
    const g2 = perId(await riepilogo(db, G2))
    expect(g2[T3].last_message).toBeNull()
  })

  it('i ripieghi sono quelli di prima: stringa vuota e null cadono sul campo italiano, poi su «?» e «unknown»', async () => {
    const d1 = perId(await riepilogo(db, D1))
    expect(d1[T1].other_user).toEqual({ first_name: 'FirstG1', last_name: 'CognomeG1', role: 'parent' })
    expect(d1[T2].other_user).toEqual({ first_name: '?', last_name: 'LastG2', role: 'parent' })
    expect(d1[T4].other_user).toEqual({ first_name: '?', last_name: '?', role: 'unknown' })
    expect(d1[T4].student).toEqual({ nome: '?', cognome: '?', classe_sezione: '?' })
    expect(d1[T1].student).toEqual({ nome: 'NomeA1', cognome: 'CognomeA1', classe_sezione: 'Sez1' })
    const g2 = perId(await riepilogo(db, G2))
    expect(g2[T3].other_user).toEqual({ first_name: 'NomeD2', last_name: 'CognomeD2', role: 'teacher' })
    expect(g2[T3].student, 'un alunno trovato con la classe nulla resta null').toEqual({
      nome: 'NomeA2', cognome: 'CognomeA2', classe_sezione: null,
    })
  })
})

describe('chat_riepilogo_conversazioni — nessuno vede le conversazioni altrui', () => {
  it('INVOKER, search_path fisso', async () => {
    const { rows } = await db.query<{ prosecdef: boolean; proconfig: string[] }>(`
      select p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'chat_riepilogo_conversazioni'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].prosecdef).toBe(false)
    expect(rows[0].proconfig).toEqual(['search_path=public, pg_temp'])
  })

  it('EXECUTE: anon no, authenticated no, service_role sì', async () => {
    const firma = 'public.chat_riepilogo_conversazioni(uuid)'
    const { rows } = await db.query<{ anon: boolean; autenticato: boolean; servizio: boolean }>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as autenticato,
              has_function_privilege('service_role', $1, 'EXECUTE') as servizio`,
      [firma],
    )
    expect(rows[0]).toEqual({ anon: false, autenticato: false, servizio: true })
  })

  it('una sessione `authenticated` non la può chiamare (42501)', async () => {
    await db.exec('begin')
    try {
      await db.exec('set local role authenticated')
      await expect(db.query('select public.chat_riepilogo_conversazioni($1)', [G1])).rejects.toMatchObject({ code: '42501' })
    } finally {
      await db.exec('rollback')
    }
  })

  it('`service_role` la chiama, e il filtro restituisce solo le conversazioni di p_utente', async () => {
    await db.exec('begin')
    try {
      await db.exec('set local role service_role')
      expect((await riepilogo(db, G1)).map((r) => r.id)).toEqual([T1])
    } finally {
      await db.exec('rollback')
    }
  })

  it('SECONDA DIFESA: con un GRANT sbagliato ad authenticated, la RLS di chat_threads nasconde le conversazioni altrui', async () => {
    await db.exec('begin')
    try {
      // La policy di produzione (migrazione 20261010221643, righe 171-174).
      await db.exec(`
        alter table public.chat_threads enable row level security;
        create policy chat_threads_select_participant on public.chat_threads for select to authenticated
          using ((teacher_id = (select auth.uid())) or (parent_id = (select auth.uid()))
            or (parent_id in (select parents.id from public.parents where parents.auth_user_id = (select auth.uid()))));
        grant execute on function public.chat_riepilogo_conversazioni(uuid) to authenticated;
      `)
      await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [G1])
      await db.exec('set local role authenticated')
      expect(await riepilogo(db, G2), 'G1 ha letto le conversazioni di G2 passando il suo id').toEqual([])
      expect((await riepilogo(db, G1)).map((r) => r.id)).toEqual([T1])
    } finally {
      await db.exec('rollback')
    }
  })

  it('riapplicata, la migrazione non si rompe e non cambia niente', async () => {
    await db.exec(MIGRAZIONE)
    expect((await riepilogo(db, D1)).map((r) => r.id)).toEqual([T2, T1, T4])
  })
})

describe('chat_riepilogo_conversazioni — la guardia del DB non migrato', () => {
  it('senza `utenti.first_name` la migrazione passa e la funzione NON nasce (la route va sul ripiego)', async () => {
    const vecchio = new PGlite()
    try {
      await schema(vecchio, { conFirstName: false })
      await vecchio.exec(MIGRAZIONE)
      const { rows } = await vecchio.query<{ f: string | null }>(
        `select to_regprocedure('public.chat_riepilogo_conversazioni(uuid)')::text as f`,
      )
      expect(rows[0].f).toBeNull()
    } finally {
      await vecchio.close()
    }
  })
})
