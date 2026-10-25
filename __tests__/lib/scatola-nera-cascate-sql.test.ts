// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * SCATOLA NERA SU CASCATE E ANAGRAFICHE (robustezza, seconda serie, sessione 3) · PROVATA SU UN
 * POSTGRES VERO.
 *
 * Le tre migrazioni della scatola sono LETTE DAL DISCO e applicate in ordine: le eliminazioni
 * (fase 4), le modifiche (fase 12) e quella di questa sessione, DUE volte (idempotenza). Lo schema
 * è un MINIMO con i nomi veri e le FK in CASCADE che contano: utenti → conversazioni e avvisi,
 * alunni → conversazioni, storico classi, copie storiche, registro accessi, note → prese visione,
 * avvisi → risposte. Un finto client direbbe «sì» a tutto. Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const file = readdirSync(CARTELLA).find((f) => f.endsWith(suffisso))
  if (!file) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, file), 'utf8')
}
const ELIMINAZIONI = migrazione('_scatola_nera_registro_eliminazioni.sql')
const MODIFICHE = migrazione('_scatola_nera_modifiche.sql')
const CASCATE = migrazione('_scatola_nera_cascate_anagrafiche.sql')

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = '10000000-0000-4000-8000-000000000001'
const ALTRO_ALUNNO = '10000000-0000-4000-8000-000000000002'
const GENITORE = '20000000-0000-4000-8000-000000000001'
const ALTRO_GENITORE = '20000000-0000-4000-8000-000000000002'
const DOCENTE = '30000000-0000-4000-8000-000000000001'
const THREAD = '40000000-0000-4000-8000-000000000001'
const ALTRO_THREAD = '40000000-0000-4000-8000-000000000002'
const MSG_GENITORE = '50000000-0000-4000-8000-000000000001'
const MSG_DOCENTE = '50000000-0000-4000-8000-000000000002'
const MSG_ALTRO = '50000000-0000-4000-8000-000000000003'
const AVVISO = '60000000-0000-4000-8000-000000000001'
const NOTA = '70000000-0000-4000-8000-000000000001'
const CERTIFICATO = '80000000-0000-4000-8000-000000000001'

/** Le tabelle da svuotare fra un caso e l'altro (con i trigger spenti). */
const TABELLE = [
  'notifiche', 'fascicolo_accessi_audit', 'alunni_classi_storico', 'storici_collegamenti',
  'storici_revisioni', 'storici_generazioni', 'nota_ricezioni', 'note_disciplinari',
  'certificati_medici', 'avvisi_risposte', 'avvisi', 'chat_messages', 'chat_threads',
  'alunni', 'parents', 'utenti', 'schools', 'app_log',
]

let db: PGlite

async function numero(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

/** Le copie nella scatola delle eliminazioni, contate per tabella. */
async function perTabella(): Promise<Record<string, number>> {
  const { rows } = await db.query<{ tabella: string; n: number }>(
    'SELECT tabella, count(*)::int AS n FROM scatola_nera.eliminazioni GROUP BY tabella ORDER BY tabella')
  return Object.fromEntries(rows.map((r) => [r.tabella, r.n]))
}

async function semina(): Promise<void> {
  await db.exec(`
    INSERT INTO public.schools VALUES ('${SEDE}', 'Sede di prova');
    INSERT INTO public.utenti (id, nome, cognome) VALUES ('${DOCENTE}', 'Docente', 'DiProva');
    INSERT INTO public.parents (id, nome) VALUES ('${GENITORE}', 'Adulta'), ('${ALTRO_GENITORE}', 'Altra');
    INSERT INTO public.alunni (id, scuola_id, nome) VALUES
      ('${ALUNNO}', '${SEDE}', 'Bimbo'), ('${ALTRO_ALUNNO}', '${SEDE}', 'Altro');
    INSERT INTO public.chat_threads VALUES
      ('${THREAD}', '${DOCENTE}', '${GENITORE}', '${ALUNNO}'),
      ('${ALTRO_THREAD}', '${DOCENTE}', '${ALTRO_GENITORE}', '${ALTRO_ALUNNO}');
    INSERT INTO public.chat_messages (id, thread_id, sender_id, content) VALUES
      ('${MSG_GENITORE}', '${THREAD}', '${GENITORE}', 'testo di prova'),
      ('${MSG_DOCENTE}', '${THREAD}', '${DOCENTE}', 'risposta di prova'),
      ('${MSG_ALTRO}', '${ALTRO_THREAD}', '${DOCENTE}', 'altro testo di prova');
    INSERT INTO public.storici_revisioni (alunno_id, modulo, entita_id) VALUES
      (NULL, 'chat', '${MSG_DOCENTE}'), ('${ALUNNO}', 'registro', '${NOTA}');
    INSERT INTO public.storici_collegamenti (alunno_id) VALUES ('${ALUNNO}');
    INSERT INTO public.storici_generazioni (alunni_ids) VALUES (ARRAY['${ALUNNO}']::uuid[]);
    INSERT INTO public.alunni_classi_storico (alunno_id) VALUES ('${ALUNNO}');
    INSERT INTO public.fascicolo_accessi_audit (alunno_id, user_id) VALUES ('${ALUNNO}', '${DOCENTE}');
    INSERT INTO public.avvisi VALUES ('${AVVISO}', '${DOCENTE}', 'Avviso di prova');
    INSERT INTO public.avvisi_risposte (avviso_id, parent_id, alunno_id) VALUES
      ('${AVVISO}', '${GENITORE}', '${ALUNNO}'),
      ('${AVVISO}', '${ALTRO_GENITORE}', '${ALTRO_ALUNNO}'),
      ('${AVVISO}', '${GENITORE}', '${ALUNNO}');
    INSERT INTO public.note_disciplinari (id, alunno_id, testo) VALUES ('${NOTA}', '${ALUNNO}', 'nota di prova');
    INSERT INTO public.nota_ricezioni (nota_id, alunno_id, genitore_id) VALUES ('${NOTA}', '${ALUNNO}', '${GENITORE}');
    INSERT INTO public.certificati_medici VALUES ('${CERTIFICATO}', '${ALUNNO}', 'valido');
    INSERT INTO public.notifiche (utente_id) VALUES ('${DOCENTE}');
  `)
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL, evento text NOT NULL, sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL, fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1, visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

    CREATE TABLE public.schools (id uuid PRIMARY KEY, nome text);
    CREATE TABLE public.utenti (id uuid PRIMARY KEY, nome text, cognome text, updated_at timestamptz);
    CREATE TABLE public.parents (id uuid PRIMARY KEY, nome text, updated_at timestamptz);
    CREATE TABLE public.alunni (
      id uuid PRIMARY KEY, scuola_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
      nome text, anonimizzato_il timestamptz, updated_at timestamptz
    );
    CREATE TABLE public.chat_threads (
      id uuid PRIMARY KEY,
      teacher_id uuid NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE,
      parent_id uuid NOT NULL,
      student_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE
    );
    CREATE TABLE public.chat_messages (
      id uuid PRIMARY KEY,
      thread_id uuid NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
      sender_id uuid NOT NULL, content text NOT NULL,
      rettifica_staff text, rettifica_staff_il timestamptz, rettifica_staff_da uuid,
      rettifica_versione int NOT NULL DEFAULT 0
    );
    CREATE TABLE public.avvisi (
      id uuid PRIMARY KEY, author_id uuid REFERENCES public.utenti(id) ON DELETE CASCADE, titolo text
    );
    CREATE TABLE public.avvisi_risposte (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      avviso_id uuid NOT NULL REFERENCES public.avvisi(id) ON DELETE CASCADE,
      parent_id uuid, alunno_id uuid
    );
    CREATE TABLE public.note_disciplinari (
      id uuid PRIMARY KEY, alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
      testo text, storico_versione int NOT NULL DEFAULT 1, updated_at timestamptz
    );
    CREATE TABLE public.nota_ricezioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nota_id uuid NOT NULL REFERENCES public.note_disciplinari(id) ON DELETE CASCADE,
      alunno_id uuid NOT NULL, genitore_id uuid NOT NULL
    );
    CREATE TABLE public.certificati_medici (
      id uuid PRIMARY KEY, alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
      stato text
    );
    CREATE TABLE public.alunni_classi_storico (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE, section_id uuid
    );
    CREATE TABLE public.storici_collegamenti (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE
    );
    CREATE TABLE public.storici_revisioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE,
      modulo text NOT NULL, entita_id uuid NOT NULL, contenuto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE public.storici_generazioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunni_ids uuid[] NOT NULL DEFAULT '{}',
      scade_il timestamptz NOT NULL DEFAULT now() + interval '1 day'
    );
    CREATE TABLE public.fascicolo_accessi_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE, user_id uuid
    );
    -- Effimera: deve restare fuori dalla scatola.
    CREATE TABLE public.notifiche (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      utente_id uuid REFERENCES public.utenti(id) ON DELETE CASCADE
    );
  `)
  await db.exec(ELIMINAZIONI)
  await db.exec(MODIFICHE)
  await db.exec(CASCATE)
  await db.exec(CASCATE) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  // `replica` spegne TUTTI i trigger, compresi quelli della scatola e delle cascate: si svuota
  // ogni tabella senza lasciare copie, e la scatola stessa senza passare dalla manutenzione.
  await db.exec(`
    SET session_replication_role = replica;
    ${TABELLE.map((t) => `DELETE FROM public.${t};`).join('\n    ')}
    DELETE FROM scatola_nera.eliminazioni;
    DELETE FROM scatola_nera.modifiche;
    DELETE FROM scatola_nera.oblii;
    SET session_replication_role = DEFAULT;
  `)
  await semina()
})

describe('registra() — l’interruttore `scatola_nera.senza_storico`', () => {
  it('acceso nella transazione: la DELETE avviene e NON lascia copia', async () => {
    await db.exec(`
      BEGIN;
      SELECT set_config('scatola_nera.senza_storico', 'on', true);
      DELETE FROM public.certificati_medici WHERE id = '${CERTIFICATO}';
      COMMIT;
    `)
    expect(await numero('SELECT count(*) FROM public.certificati_medici')).toBe(0)
    expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(0)
  })

  it('CONTROLLO POSITIVO: dopo il COMMIT l’interruttore è spento e la DELETE dopo lascia la copia', async () => {
    await db.exec(`
      BEGIN;
      SELECT set_config('scatola_nera.senza_storico', 'on', true);
      DELETE FROM public.certificati_medici WHERE id = '${CERTIFICATO}';
      COMMIT;
    `)
    await db.exec(`DELETE FROM public.parents WHERE id = '${ALTRO_GENITORE}'`)
    expect(await perTabella()).toEqual({ parents: 1 })
  })
})
