// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * FASE 6 (indici) · LE 15 POLICY RISCRITTE DICONO LA STESSA COSA DI PRIMA.
 *
 * La migrazione `*_indici_fk_initplan_doppioni.sql` riscrive 15 policy RLS con
 * `(select auth.uid())` al posto di `auth.uid()`, perché Postgres la calcoli una volta
 * per istruzione invece che per riga (advisor `auth_rls_initplan`). È RLS su dati di
 * minori: una parentesi spostata o una condizione persa in una riscrittura a mano
 * aprirebbe o chiuderebbe l'accesso in silenzio, e nessun test di route lo vedrebbe
 * (le route usano il service-role).
 *
 * La prova: su un Postgres vero si creano le 15 policy col testo ESATTO di produzione
 * (`pg_policies` del 10/10/2026), si applicano gli `ALTER POLICY` LETTI DAL FILE della
 * migrazione, e si confronta ciò che Postgres rilegge (`pg_policies`) prima e dopo.
 * Togliendo dal «dopo» soltanto l'involucro `( SELECT auth.uid() AS uid)`, i due testi
 * devono coincidere carattere per carattere — e il «dopo» non deve contenere più
 * nessun `auth.uid()` nudo.
 *
 * Schema minimo con i nomi e i tipi veri delle colonne nominate dalle policy. Nessun dato.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_indici_fk_initplan_doppioni.sql'))
if (!FILE) throw new Error('migrazione *_indici_fk_initplan_doppioni.sql non trovata')
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE), 'utf8')

/** Le istruzioni `ALTER POLICY … ;` del file, nell'ordine in cui compaiono. */
function alterPolicyDelFile(sql: string): string[] {
  const senzaCommenti = sql.replace(/--[^\n]*/g, '')
  return senzaCommenti
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^ALTER\s+POLICY\b/i.test(s))
}

// Testo di `pg_policies` in produzione al 10/10/2026 22:13 UTC (prima della migrazione).
const ORIGINALI: Array<{ tabella: string; policy: string; cmd: string; using?: string; check?: string }> = [
  {
    tabella: 'chat_messages', policy: 'chat_messages_select_participant', cmd: 'SELECT',
    using: `(thread_id IN ( SELECT chat_threads.id
   FROM chat_threads
  WHERE ((chat_threads.teacher_id = auth.uid()) OR (chat_threads.parent_id = auth.uid()) OR (chat_threads.parent_id IN ( SELECT parents.id
           FROM parents
          WHERE (parents.auth_user_id = auth.uid()))))))`,
  },
  {
    tabella: 'chat_threads', policy: 'chat_threads_select_participant', cmd: 'SELECT',
    using: `((teacher_id = auth.uid()) OR (parent_id = auth.uid()) OR (parent_id IN ( SELECT parents.id
   FROM parents
  WHERE (parents.auth_user_id = auth.uid()))))`,
  },
  { tabella: 'eventi_agenda', policy: 'own eventi agenda', cmd: 'SELECT', using: '(creato_da = auth.uid())' },
  {
    tabella: 'firme_docenti', policy: 'Maestre della scuola possono vedere tutte le firme del registro', cmd: 'SELECT',
    using: `(EXISTS ( SELECT 1
   FROM (registro_orario r
     JOIN utenti u ON ((r.scuola_id = u.scuola_id)))
  WHERE ((r.id = firme_docenti.registro_id) AND (u.id = auth.uid()) AND ((u.ruolo)::text <> 'genitore'::text))))`,
  },
  {
    tabella: 'form_submissions', policy: 'fs_insert_authenticated', cmd: 'INSERT',
    check: '((auth.uid() IS NOT NULL) AND ((user_id = auth.uid()) OR (user_id IS NULL)))',
  },
  { tabella: 'form_submissions', policy: 'fs_select_owner', cmd: 'SELECT', using: '(user_id = auth.uid())' },
  {
    tabella: 'form_submissions', policy: 'fs_update_owner', cmd: 'UPDATE',
    using: '(user_id = auth.uid())', check: '(user_id = auth.uid())',
  },
  {
    tabella: 'incassi', policy: 'parent read incassi', cmd: 'SELECT',
    using: `(EXISTS ( SELECT 1
   FROM pagamenti p
  WHERE ((p.id = incassi.pagamento_id) AND (p.alunno_id IN ( SELECT legame_genitori_alunni.alunno_id
           FROM legame_genitori_alunni
          WHERE (legame_genitori_alunni.genitore_id = auth.uid()))) AND ((p.tipo <> 'split'::pagamento_tipo) OR (incassi.quota_id IN ( SELECT q.id
           FROM pagamenti_quote q
          WHERE ((q.pagamento_id = p.id) AND (q.adult_id = auth.uid()))))))))`,
  },
  {
    tabella: 'note_disciplinari', policy: 'Genitori possono vedere le note dei propri figli', cmd: 'SELECT',
    using: `(EXISTS ( SELECT 1
   FROM legame_genitori_alunni
  WHERE ((legame_genitori_alunni.genitore_id = auth.uid()) AND (legame_genitori_alunni.alunno_id = note_disciplinari.alunno_id))))`,
  },
  {
    tabella: 'note_disciplinari', policy: 'Maestre della stessa scuola possono vedere le note', cmd: 'SELECT',
    using: `(EXISTS ( SELECT 1
   FROM (utenti u
     JOIN alunni a ON ((a.scuola_id = u.scuola_id)))
  WHERE ((u.id = auth.uid()) AND ((u.ruolo)::text <> 'genitore'::text) AND (a.id = note_disciplinari.alunno_id))))`,
  },
  { tabella: 'notifiche', policy: 'own notifiche', cmd: 'SELECT', using: '(utente_id = auth.uid())' },
  { tabella: 'pagamenti_quote', policy: 'parent read own quota', cmd: 'SELECT', using: '(adult_id = auth.uid())' },
  {
    tabella: 'push_subscriptions', policy: 'own push sub', cmd: 'ALL',
    using: '(utente_id = auth.uid())', check: '(utente_id = auth.uid())',
  },
  {
    tabella: 'registro_orario', policy: 'Genitori possono vedere il registro dei figli', cmd: 'SELECT',
    using: `(EXISTS ( SELECT 1
   FROM (alunni a
     JOIN legame_genitori_alunni lga ON ((a.id = lga.alunno_id)))
  WHERE ((lga.genitore_id = auth.uid()) AND (a.scuola_id = registro_orario.scuola_id) AND ((a.classe_sezione)::text = (registro_orario.classe_sezione)::text))))`,
  },
  {
    tabella: 'registro_orario', policy: 'Maestre della scuola possono gestire il registro', cmd: 'ALL',
    using: `(EXISTS ( SELECT 1
   FROM utenti u
  WHERE ((u.id = auth.uid()) AND ((u.ruolo)::text <> 'genitore'::text) AND (u.scuola_id = registro_orario.scuola_id))))`,
    check: `(EXISTS ( SELECT 1
   FROM utenti u
  WHERE ((u.id = auth.uid()) AND ((u.ruolo)::text <> 'genitore'::text) AND (u.scuola_id = registro_orario.scuola_id))))`,
  },
]

type Riga = { tablename: string; policyname: string; cmd: string; roles: string; qual: string | null; with_check: string | null }

let db: PGlite

async function leggiPolicy(): Promise<Map<string, Riga>> {
  const { rows } = await db.query<Riga>(
    `SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
       FROM pg_policies WHERE schemaname = 'public'`,
  )
  return new Map(rows.map((r) => [`${r.tablename} · ${r.policyname}`, r]))
}

/** Toglie SOLO l'involucro che la migrazione aggiunge: `( SELECT auth.uid() AS uid)` → `auth.uid()`. */
function senzaInvolucro(testo: string | null): string | null {
  return testo === null ? null : testo.replace(/\( SELECT auth\.uid\(\) AS uid\)/g, 'auth.uid()')
}

let prima: Map<string, Riga>
let dopo: Map<string, Riga>

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE TYPE public.pagamento_tipo AS ENUM ('singolo', 'padre', 'rata', 'split');

    CREATE TABLE public.parents (id uuid PRIMARY KEY, auth_user_id uuid);
    CREATE TABLE public.chat_threads (id uuid PRIMARY KEY, teacher_id uuid, parent_id uuid);
    CREATE TABLE public.chat_messages (id uuid PRIMARY KEY, thread_id uuid);
    CREATE TABLE public.eventi_agenda (id uuid PRIMARY KEY, creato_da uuid);
    CREATE TABLE public.utenti (id uuid PRIMARY KEY, scuola_id uuid, ruolo varchar);
    CREATE TABLE public.alunni (id uuid PRIMARY KEY, scuola_id uuid, classe_sezione varchar);
    CREATE TABLE public.registro_orario (id uuid PRIMARY KEY, scuola_id uuid, classe_sezione varchar);
    CREATE TABLE public.firme_docenti (id uuid PRIMARY KEY, registro_id uuid);
    CREATE TABLE public.form_submissions (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.legame_genitori_alunni (genitore_id uuid, alunno_id uuid);
    CREATE TABLE public.pagamenti (id uuid PRIMARY KEY, alunno_id uuid, tipo public.pagamento_tipo);
    CREATE TABLE public.pagamenti_quote (id uuid PRIMARY KEY, pagamento_id uuid, adult_id uuid);
    CREATE TABLE public.incassi (id uuid PRIMARY KEY, pagamento_id uuid, quota_id uuid);
    CREATE TABLE public.note_disciplinari (id uuid PRIMARY KEY, alunno_id uuid);
    CREATE TABLE public.notifiche (id uuid PRIMARY KEY, utente_id uuid);
    CREATE TABLE public.push_subscriptions (id uuid PRIMARY KEY, utente_id uuid);
  `)
  for (const p of ORIGINALI) {
    const using = p.using ? ` USING (${p.using})` : ''
    const check = p.check ? ` WITH CHECK (${p.check})` : ''
    await db.exec(
      `CREATE POLICY "${p.policy}" ON public.${p.tabella} AS PERMISSIVE FOR ${p.cmd} TO authenticated${using}${check};`,
    )
  }
  prima = await leggiPolicy()
  for (const istruzione of alterPolicyDelFile(MIGRAZIONE)) await db.exec(`${istruzione};`)
  dopo = await leggiPolicy()
})

afterAll(async () => {
  await db?.close()
})

describe('fase 6 · policy riscritte con (select auth.uid())', () => {
  it('il file della migrazione riscrive esattamente le 15 policy dell\'advisor, una volta ciascuna', () => {
    const istruzioni = alterPolicyDelFile(MIGRAZIONE)
    expect(istruzioni).toHaveLength(ORIGINALI.length)
    expect(dopo.size).toBe(ORIGINALI.length)
  })

  it('nessuna policy ha più un auth.uid() nudo: ogni chiamata è dentro una sottoselezione', () => {
    for (const [nome, r] of dopo) {
      for (const testo of [r.qual, r.with_check]) {
        if (testo === null) continue
        const nudi = testo.replace(/\( SELECT auth\.uid\(\) AS uid\)/g, '')
        expect(nudi, nome).not.toMatch(/auth\.uid\(\)/)
        expect(testo, nome).toMatch(/\( SELECT auth\.uid\(\) AS uid\)/)
      }
    }
  })

  it('tolto l\'involucro, USING e WITH CHECK coincidono carattere per carattere con quelli di prima', () => {
    for (const [nome, r] of prima) {
      const nuova = dopo.get(nome)
      expect(nuova, nome).toBeDefined()
      expect(senzaInvolucro(nuova!.qual), `${nome} · USING`).toBe(r.qual)
      expect(senzaInvolucro(nuova!.with_check), `${nome} · WITH CHECK`).toBe(r.with_check)
    }
  })

  it('comando e ruoli restano quelli di prima (ALTER POLICY non li tocca)', () => {
    for (const [nome, r] of prima) {
      expect(dopo.get(nome)?.cmd, nome).toBe(r.cmd)
      expect(dopo.get(nome)?.roles, nome).toBe(r.roles)
    }
  })
})
