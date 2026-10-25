// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * S7 — LA LISTA COL RIEPILOGO È LA LISTA DI PRIMA, SUGLI STESSI DATI (robustezza 2, sessione 12).
 *
 * `chat-riepilogo-conversazioni-sql.test.ts` prova la funzione contro valori attesi scritti a mano;
 * `chat-threads-riepilogo.test.ts` prova la route con un client finto. Nessuno dei due mette a
 * confronto le DUE STRADE della route sugli stessi dati — ed è lì che si nasconde un cambio visibile
 * per chi usa la chat (un ripiego «?» diverso, un non letto contato in un altro modo, un ordine
 * diverso, una conversazione di troppo o di meno).
 *
 * Qui la `GET` vera gira due volte per ogni utente sullo stesso Postgres (PGlite):
 *  · col riepilogo installato (una `rpc`, una lettura delle sospensioni);
 *  · con la `rpc` che risponde «non installata» (`PGRST202`), cioè il percorso di prima con le sue
 *    quattro letture per conversazione;
 * e le due risposte devono essere IDENTICHE. Il client finto non inventa risposte: traduce le
 * chiamate del costruttore di supabase-js in SQL, come fa PostgREST, e le esegue sul database.
 *
 * Lo schema è quello di produzione (letto il 25/10/2026 da `information_schema`, sola lettura):
 * `first_name`/`last_name`/`role` di `utenti` sono colonne GENERATE da `nome`/`cognome`/`ruolo`,
 * `student_id` non è mai nullo, `last_message_at` ha default `CURRENT_TIMESTAMP`. Ci sono un docente,
 * una segreteria che scrive come `teacher_id`, un genitore con conversazioni in due sedi, un genitore
 * col nome vuoto, un interlocutore che non è in `utenti`, un alunno che non esiste, sospensioni attive
 * e riaperte. Solo dati finti.
 */

const h = vi.hoisted(() => {
  type Db = { query: (sql: string, parametri?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
  type Risposta = { data: unknown; error: unknown; count?: number | null }

  const stato = {
    db: null as Db | null,
    rpcForzata: null as Risposta | null,
    chiamate: [] as string[],
  }

  const IDENTIFICATORE = /^[a-z_][a-z0-9_]*$/
  const nome = (c: string): string => {
    if (!IDENTIFICATORE.test(c)) throw new Error(`identificatore inatteso: ${c}`)
    return `"${c}"`
  }
  const comeErrore = (e: unknown) => ({
    code: (e as { code?: string }).code ?? 'sconosciuto',
    message: e instanceof Error ? e.message : String(e),
  })

  /** Il costruttore di supabase-js, tradotto in SQL come lo tradurrebbe PostgREST. */
  function from(tabella: string) {
    stato.chiamate.push(`from:${tabella}`)
    let colonne = '*'
    let soloConteggio = false
    let scrittura = false
    let limite: number | null = null
    const filtri: string[] = []
    const ordine: string[] = []
    const parametri: string[] = []
    // PostgREST riceve i valori come TESTO dalla query string: `eq.null` è la stringa «null».
    const p = (v: unknown): string => {
      parametri.push(String(v))
      return `$${parametri.length}`
    }

    const esegui = async (): Promise<Risposta> => {
      const db = stato.db
      if (!db) throw new Error('database non pronto')
      const where = filtri.length > 0 ? ` where ${filtri.join(' and ')}` : ''
      try {
        if (soloConteggio) {
          const { rows } = await db.query(`select count(*)::int as n from public.${nome(tabella)}${where}`, parametri)
          return { data: null, count: rows[0].n as number, error: null }
        }
        const cols = colonne === '*' ? '*' : colonne.split(',').map((c) => nome(c.trim())).join(', ')
        const ordinamento = ordine.length > 0 ? ` order by ${ordine.join(', ')}` : ''
        const taglio = limite !== null ? ` limit ${limite}` : ''
        const { rows } = await db.query(
          `select coalesce(json_agg(q), '[]'::json) as righe
             from (select ${cols} from public.${nome(tabella)}${where}${ordinamento}${taglio}) q`,
          parametri,
        )
        return { data: rows[0].righe, error: null }
      } catch (e) {
        return { data: null, count: null, error: comeErrore(e) }
      }
    }

    const b = {
      select(c = '*', opzioni?: { head?: boolean }) {
        colonne = c
        soloConteggio = Boolean(opzioni?.head)
        return b
      },
      eq(c: string, v: unknown) {
        filtri.push(`${nome(c)} = ${p(v)}`)
        return b
      },
      neq(c: string, v: unknown) {
        filtri.push(`${nome(c)} <> ${p(v)}`)
        return b
      },
      is(c: string, v: null) {
        if (v !== null) throw new Error('is: qui solo null')
        filtri.push(`${nome(c)} is null`)
        return b
      },
      in(c: string, valori: unknown[]) {
        filtri.push(valori.length > 0 ? `${nome(c)} in (${valori.map(p).join(', ')})` : 'false')
        return b
      },
      /** Solo la forma che la route usa: `a.eq.X,b.eq.Y`. */
      or(espressione: string) {
        const parti = espressione.split(',').map((pezzo) => {
          const [c, operatore, ...valore] = pezzo.split('.')
          if (operatore !== 'eq') throw new Error(`or: operatore inatteso ${operatore}`)
          return `${nome(c)} = ${p(valore.join('.'))}`
        })
        filtri.push(`(${parti.join(' or ')})`)
        return b
      },
      // Come PostgREST: `col.desc` senza `nullsfirst`/`nullslast` lascia il default di Postgres.
      order(c: string, opzioni?: { ascending?: boolean }) {
        ordine.push(`${nome(c)} ${opzioni?.ascending === false ? 'desc' : 'asc'}`)
        return b
      },
      limit(n: number) {
        limite = n
        return b
      },
      update() {
        stato.chiamate.push(`update:${tabella}`)
        scrittura = true
        return b
      },
      async maybeSingle(): Promise<Risposta> {
        const r = await esegui()
        if (r.error) return { data: null, error: r.error }
        const righe = (r.data as unknown[] | null) ?? []
        if (righe.length > 1) return { data: null, error: { code: 'PGRST116', message: 'più di una riga' } }
        return { data: righe[0] ?? null, error: null }
      },
      then<A, B = never>(ok?: (v: Risposta) => A | PromiseLike<A>, ko?: (e: unknown) => B | PromiseLike<B>) {
        const esito = scrittura ? Promise.resolve<Risposta>({ data: null, error: null }) : esegui()
        return esito.then(ok, ko)
      },
    }
    return b
  }

  /** `POST /rpc/<funzione>`: la funzione vera, se c'è; altrimenti l'errore vero di Postgres (42883). */
  async function rpc(funzione: string, argomenti: Record<string, unknown>): Promise<Risposta> {
    stato.chiamate.push(`rpc:${funzione}`)
    if (stato.rpcForzata) return stato.rpcForzata
    const db = stato.db
    if (!db) throw new Error('database non pronto')
    try {
      const { rows } = await db.query(`select public.${nome(funzione)}($1) as r`, [argomenti.p_utente])
      return { data: rows[0].r, error: null }
    } catch (e) {
      return { data: null, error: comeErrore(e) }
    }
  }

  return { requireUser: vi.fn(), logEvento: vi.fn(), stato, client: () => ({ from, rpc }) }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.client() }))

import { GET } from '@/app/api/chat/threads/route'

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_chat_riepilogo_conversazioni.sql'))
if (!FILE) throw new Error('migrazione *_chat_riepilogo_conversazioni.sql non trovata')
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE), 'utf8')

/** uuid finti, leggibili nel rosso. */
const u = (n: number) => `f1300000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SEDE_A = u(1)
const SEDE_B = u(2)
const D1 = u(11) // docente, sede A
const D2 = u(12) // docente, sede B
const S1 = u(13) // segreteria, scrive come teacher_id
const G1 = u(21) // genitore con figli in due sedi
const G2 = u(22) // genitore col nome vuoto
const ESTRANEO = u(29) // partecipante che non è in `utenti`
const NESSUNO = u(30) // nessuna conversazione
const A1 = u(41)
const A2 = u(42)
const A3 = u(43)
const ALUNNO_FANTASMA = u(49)
const T = (n: number) => u(60 + n)
const M = (n: number) => u(100 + n)
const SO = (n: number) => u(200 + n)

const SCHEMA_PRODUZIONE = `
  create role anon;
  create role authenticated;
  create role service_role nologin bypassrls;

  create table public.utenti (
    id uuid primary key,
    nome varchar not null,
    cognome varchar not null,
    ruolo varchar not null,
    first_name varchar generated always as (nome) stored,
    last_name varchar generated always as (cognome) stored,
    role varchar generated always as (ruolo) stored,
    scuola_id uuid
  );
  create table public.alunni (
    id uuid primary key, nome varchar not null, cognome varchar not null, classe_sezione varchar, scuola_id uuid
  );
  create table public.chat_threads (
    id uuid primary key,
    teacher_id uuid not null,
    parent_id uuid not null,
    student_id uuid not null,
    last_message_at timestamptz default current_timestamp,
    created_at timestamptz default now()
  );
  create table public.chat_messages (
    id uuid primary key,
    thread_id uuid not null references public.chat_threads(id),
    sender_id uuid not null,
    content text not null,
    attachment_url text,
    attachment_type varchar,
    read_at timestamptz,
    created_at timestamptz default now(),
    delivered_at timestamptz,
    rettifica_staff text,
    rettifica_staff_il timestamptz,
    rettifica_staff_da uuid,
    rettifica_versione integer not null default 0
  );
  create table public.conversazioni_sospensioni (
    id uuid primary key,
    thread_id uuid not null references public.chat_threads(id),
    sospesa_da uuid not null,
    sospesa_verso uuid not null,
    motivo text,
    scuola_id uuid,
    sospesa_il timestamptz not null,
    riaperta_il timestamptz,
    riaperta_da uuid,
    riaperta_tipo text
  );
`

const DATI = `
  insert into public.utenti (id, nome, cognome, ruolo, scuola_id) values
    ('${D1}', 'NomeD1', 'CognomeD1', 'docente', '${SEDE_A}'),
    ('${D2}', 'NomeD2', 'CognomeD2', 'educator', '${SEDE_B}'),
    ('${S1}', 'NomeS1', 'CognomeS1', 'segreteria', '${SEDE_A}'),
    ('${G1}', 'NomeG1', 'CognomeG1', 'genitore', '${SEDE_A}'),
    ('${G2}', '', '', 'genitore', '${SEDE_A}');
  insert into public.alunni (id, nome, cognome, classe_sezione, scuola_id) values
    ('${A1}', 'NomeA1', 'CognomeA1', 'Sez1', '${SEDE_A}'),
    ('${A2}', 'NomeA2', 'CognomeA2', null, '${SEDE_A}'),
    ('${A3}', 'NomeA3', 'CognomeA3', 'Sez3', '${SEDE_B}');
  insert into public.chat_threads (id, teacher_id, parent_id, student_id, last_message_at, created_at) values
    ('${T(1)}', '${D1}', '${G1}', '${A1}', '2026-10-20T08:00:00Z', '2026-10-01T08:00:00Z'),
    ('${T(2)}', '${D1}', '${G2}', '${A2}', '2026-10-20T09:00:00.123456Z', '2026-10-01T09:00:00Z'),
    ('${T(3)}', '${D2}', '${G1}', '${A3}', '2026-10-20T10:00:00Z', '2026-10-02T08:00:00Z'),
    ('${T(4)}', '${S1}', '${G2}', '${A2}', '2026-10-20T07:00:00Z', '2026-10-03T08:00:00Z'),
    ('${T(5)}', '${D1}', '${ESTRANEO}', '${ALUNNO_FANTASMA}', '2026-10-20T06:00:00Z', '2026-10-04T08:00:00Z'),
    ('${T(6)}', '${D2}', '${G2}', '${A3}', '2026-10-20T11:00:00Z', '2026-10-05T08:00:00Z');
  insert into public.chat_messages (id, thread_id, sender_id, content, read_at, delivered_at, created_at, attachment_url, attachment_type, rettifica_versione) values
    ('${M(1)}', '${T(1)}', '${D1}', 'testo finto 1', null, null, '2026-10-20T07:00:00Z', null, null, 0),
    ('${M(2)}', '${T(1)}', '${D1}', 'testo finto 2', null, '2026-10-20T07:15:00Z', '2026-10-20T07:10:00Z', null, null, 0),
    ('${M(3)}', '${T(1)}', '${D1}', 'testo finto 3', '2026-10-20T07:30:00Z', '2026-10-20T07:25:00Z', '2026-10-20T07:20:00Z', null, null, 0),
    ('${M(4)}', '${T(1)}', '${G1}', 'testo finto 4', null, null, '2026-10-20T08:00:00Z', 'percorso/finto.jpg', 'image', 1),
    ('${M(5)}', '${T(2)}', '${G2}', 'testo finto 5', null, null, '2026-10-20T09:00:00.123456Z', null, null, 0),
    ('${M(6)}', '${T(3)}', '${D2}', 'testo finto 6', '2026-10-20T10:05:00Z', '2026-10-20T10:01:00Z', '2026-10-20T10:00:00Z', null, null, 0),
    ('${M(7)}', '${T(4)}', '${S1}', 'testo finto 7', null, null, '2026-10-20T06:30:00Z', null, null, 0),
    ('${M(8)}', '${T(4)}', '${S1}', 'testo finto 8', null, null, '2026-10-20T07:00:00Z', null, null, 0),
    ('${M(9)}', '${T(5)}', '${ESTRANEO}', 'testo finto 9', null, null, '2026-10-20T06:00:00Z', null, null, 0);
  insert into public.conversazioni_sospensioni (id, thread_id, sospesa_da, sospesa_verso, motivo, scuola_id, sospesa_il, riaperta_il) values
    ('${SO(1)}', '${T(1)}', '${D1}', '${G1}', 'motivo finto', '${SEDE_A}', '2026-10-20T08:30:00Z', null),
    ('${SO(2)}', '${T(2)}', '${D1}', '${G2}', 'motivo finto', '${SEDE_A}', '2026-10-19T08:30:00Z', '2026-10-19T09:30:00Z'),
    ('${SO(3)}', '${T(4)}', '${S1}', '${G2}', null, '${SEDE_A}', '2026-10-20T07:30:00Z', null);
`

/** Ogni utente, con le conversazioni che deve vedere (in ordine) e il ruolo con cui il gate lo riconosce. */
const UTENTI: Array<{ nome: string; id: string; ruolo: string; attese: string[] }> = [
  { nome: 'docente D1', id: D1, ruolo: 'docente', attese: [T(2), T(1), T(5)] },
  { nome: 'docente D2 (altra sede)', id: D2, ruolo: 'educator', attese: [T(6), T(3)] },
  { nome: 'segreteria S1', id: S1, ruolo: 'segreteria', attese: [T(4)] },
  { nome: 'genitore G1 (figli in due sedi)', id: G1, ruolo: 'genitore', attese: [T(3), T(1)] },
  { nome: 'genitore G2 (nome vuoto)', id: G2, ruolo: 'genitore', attese: [T(6), T(2), T(4)] },
  { nome: 'partecipante assente da utenti', id: ESTRANEO, ruolo: 'genitore', attese: [T(5)] },
  { nome: 'utente senza conversazioni', id: NESSUNO, ruolo: 'genitore', attese: [] },
]

type Riga = Record<string, unknown> & { id: string }

async function lista(utente: { id: string; ruolo: string }, rpcForzata: { data: unknown; error: unknown } | null) {
  h.stato.rpcForzata = rpcForzata
  h.stato.chiamate = []
  h.requireUser.mockResolvedValue({ user: { id: utente.id, role: utente.ruolo, scuola_id: SEDE_A } })
  const res = await GET(new Request(`http://localhost/api/chat/threads?userId=${NESSUNO}`))
  const corpo = (await res.json()) as Riga[]
  return { stato: res.status, corpo, chiamate: [...h.stato.chiamate] }
}

const NON_INSTALLATA = { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }

let db: PGlite
let senzaFunzione: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA_PRODUZIONE)
  await db.exec(DATI)
  await db.exec(MIGRAZIONE)
  // Lo stesso database SENZA la migrazione: la `rpc` riceve il 42883 vero di Postgres.
  senzaFunzione = new PGlite()
  await senzaFunzione.exec(SCHEMA_PRODUZIONE)
  await senzaFunzione.exec(DATI)
})

afterAll(async () => {
  await db.close()
  await senzaFunzione.close()
})

beforeEach(() => {
  vi.clearAllMocks()
  h.stato.db = db
  h.stato.rpcForzata = null
})

describe('GET /api/chat/threads — riepilogo e percorso di prima danno la STESSA lista', () => {
  it.each(UTENTI)('$nome: stesse righe, stesso ordine, stessi campi', async (utente) => {
    const nuovo = await lista(utente, null)
    const vecchio = await lista(utente, NON_INSTALLATA)

    expect(nuovo.stato).toBe(200)
    expect(vecchio.stato).toBe(200)
    // Il riepilogo è stato davvero usato (altrimenti si confronterebbe il percorso di prima con sé stesso).
    expect(nuovo.chiamate[0]).toBe('rpc:chat_riepilogo_conversazioni')
    expect(nuovo.chiamate.filter((c) => c.startsWith('from:chat_threads') || c.startsWith('from:chat_messages'))).toEqual([])
    expect(vecchio.chiamate).toContain('from:chat_threads')

    expect(nuovo.corpo.map((r) => r.id)).toEqual(utente.attese)
    expect(nuovo.corpo).toStrictEqual(vecchio.corpo)
  })

  it('il confronto non è vuoto: i campi arricchiti hanno valori veri', async () => {
    const { corpo } = await lista(UTENTI[0], null)
    const perId = Object.fromEntries(corpo.map((r) => [r.id, r]))
    expect(perId[T(1)]).toMatchObject({
      unread_count: 1,
      other_user: { first_name: 'NomeG1', last_name: 'CognomeG1', role: 'genitore' },
      student: { nome: 'NomeA1', cognome: 'CognomeA1', classe_sezione: 'Sez1' },
      last_message: { content: 'testo finto 4', sender_id: G1 },
      sospensione: { sospesaDa: D1, sospesaVerso: G1, motivo: 'motivo finto' },
    })
    expect(perId[T(2)]).toMatchObject({ other_user: { first_name: '?', last_name: '?', role: 'genitore' }, sospensione: null })
    expect(perId[T(5)]).toMatchObject({
      other_user: { first_name: '?', last_name: '?', role: 'unknown' },
      student: { nome: '?', cognome: '?', classe_sezione: '?' },
      unread_count: 1,
    })
  })

  it('un guasto della RPC (57014) torna alla lista di prima, identica', async () => {
    const errore = { code: '57014', message: 'canceling statement due to statement timeout' }
    const guasto = await lista(UTENTI[4], { data: null, error: errore })
    const nuovo = await lista(UTENTI[4], null)
    expect(guasto.stato).toBe(200)
    expect(guasto.corpo).toStrictEqual(nuovo.corpo)
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'error', expect.objectContaining({ esito: 'riepilogo-rpc-fallito' }), errore)
  })

  it('senza la funzione nel database (42883 vero di Postgres) la lista è la stessa', async () => {
    const conFunzione = await lista(UTENTI[3], null)
    h.stato.db = senzaFunzione
    const senza = await lista(UTENTI[3], null)
    expect(senza.stato).toBe(200)
    expect(senza.chiamate[0]).toBe('rpc:chat_riepilogo_conversazioni')
    expect(senza.chiamate).toContain('from:chat_threads')
    expect(senza.corpo).toStrictEqual(conFunzione.corpo)
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'info', expect.objectContaining({
      esito: 'riepilogo-non-installato', error_code: '42883', ripiego: true,
    }))
  })
})

describe('GET /api/chat/threads — nessuno vede le conversazioni altrui', () => {
  it.each(UTENTI)('$nome: ogni riga ha lui come teacher_id o parent_id, e nessuna manca', async (utente) => {
    const { corpo } = await lista(utente, null)
    for (const riga of corpo) {
      expect([riga.teacher_id, riga.parent_id], `riga ${riga.id}`).toContain(utente.id)
    }
    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from public.chat_threads where teacher_id = $1 or parent_id = $1',
      [utente.id],
    )
    expect(corpo).toHaveLength(rows[0].n)
  })

  it('il `?userId=` della query string non conta: vale l’identità del gate', async () => {
    // `lista` passa sempre `?userId=` di chi non ha conversazioni: se contasse, la lista sarebbe vuota.
    const { corpo } = await lista(UTENTI[0], null)
    expect(corpo.map((r) => r.id)).toEqual([T(2), T(1), T(5)])
  })
})
