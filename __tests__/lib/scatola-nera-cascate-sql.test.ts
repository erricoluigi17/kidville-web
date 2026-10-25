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
 * avvisi → risposte, conversazioni → sospensioni. Un finto client direbbe «sì» a tutto. Solo dati
 * finti.
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
/** Una persona del personale che NON partecipa a nessuna conversazione (la Direzione che riapre). */
const DIREZIONE = '30000000-0000-4000-8000-000000000002'
const THREAD = '40000000-0000-4000-8000-000000000001'
const ALTRO_THREAD = '40000000-0000-4000-8000-000000000002'
const MSG_GENITORE = '50000000-0000-4000-8000-000000000001'
const MSG_DOCENTE = '50000000-0000-4000-8000-000000000002'
const MSG_ALTRO = '50000000-0000-4000-8000-000000000003'
const AVVISO = '60000000-0000-4000-8000-000000000001'
const NOTA = '70000000-0000-4000-8000-000000000001'
const CERTIFICATO = '80000000-0000-4000-8000-000000000001'
/** Adulti che intestano le fatture: in nessun'altra tabella, così ogni copia tolta è per l'intestatario. */
const INTESTATARIA_A = '2000000a-0000-4000-8000-00000000000a'
const INTESTATARIO_B = '2000000b-0000-4000-8000-00000000000b'
const ADULTO_QUOTA = '2000000c-0000-4000-8000-00000000000c'

/** Le tabelle da svuotare fra un caso e l'altro (con i trigger spenti). */
const TABELLE = [
  'notifiche', 'fascicolo_accessi_audit', 'alunni_classi_storico', 'storici_collegamenti',
  'storici_revisioni', 'storici_generazioni', 'nota_ricezioni', 'note_disciplinari',
  'certificati_medici', 'avvisi_risposte', 'avvisi', 'conversazioni_sospensioni', 'chat_messages',
  'chat_threads', 'alunni', 'parents', 'utenti', 'schools', 'app_log',
]

let db: PGlite

async function numero(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

async function codiceErrore(sql: string): Promise<string | null> {
  try {
    await db.exec(sql)
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'errore'
  }
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
    INSERT INTO public.conversazioni_sospensioni (thread_id, sospesa_da, sospesa_verso, motivo) VALUES
      ('${THREAD}', '${DOCENTE}', '${GENITORE}', 'motivo di prova');
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

/** Lo schema minimo, ruoli compresi: lo usano il database principale e quello con la sola fase 4. */
const SCHEMA = `
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
    -- L'intestatario delle fatture e le quote della retta nominano un ADULTO dentro un JSON
    -- (\`adult_id\` = un parents.id), dove soggetti_di non guarda: forma letta in produzione il 25/10.
    CREATE TABLE public.alunni (
      id uuid PRIMARY KEY, scuola_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
      nome text, anonimizzato_il timestamptz, updated_at timestamptz,
      intestatario_fatture jsonb, invoice_holder_details jsonb, retta_split_config jsonb
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
    -- La prova che una conversazione è stata moderata (policy UGC): chi sospende, chi è sospeso e
    -- chi riapre stanno in colonne SENZA il suffisso _id, che soggetti_di non vede.
    CREATE TABLE public.conversazioni_sospensioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
      sospesa_da uuid NOT NULL, sospesa_verso uuid NOT NULL, motivo text, riaperta_da uuid
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
`

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
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

describe('le figlie in cascata entrano nella scatola delle eliminazioni', () => {
  it('cancellare un alunno: conversazioni e messaggi, sospensioni, prese visione, storico classi, copie storiche, registro accessi — nella stessa transazione', async () => {
    await db.exec(`DELETE FROM public.alunni WHERE id = '${ALUNNO}'`)
    expect(await perTabella()).toEqual({
      alunni: 1,
      alunni_classi_storico: 1,
      certificati_medici: 1,
      chat_messages: 2,
      chat_threads: 1,
      conversazioni_sospensioni: 1,
      fascicolo_accessi_audit: 1,
      nota_ricezioni: 1,
      note_disciplinari: 1,
      storici_collegamenti: 1,
      storici_revisioni: 1,
    })
    expect(await numero('SELECT count(DISTINCT transazione) FROM scatola_nera.eliminazioni')).toBe(1)
    // Controllo positivo: la conversazione dell'altro alunno è viva e non è in scatola.
    expect(await numero(`SELECT count(*) FROM public.chat_threads WHERE id = '${ALTRO_THREAD}'`)).toBe(1)
  })

  it('cancellare un avviso porta via le risposte dei genitori: tutte in scatola', async () => {
    await db.exec(`DELETE FROM public.avvisi WHERE id = '${AVVISO}'`)
    expect(await perTabella()).toEqual({ avvisi: 1, avvisi_risposte: 3 })
  })

  it('cancellare una docente: avvisi, risposte, conversazioni, sospensioni e messaggi in scatola; le notifiche no (effimere)', async () => {
    await db.exec(`DELETE FROM public.utenti WHERE id = '${DOCENTE}'`)
    expect(await perTabella()).toEqual({
      avvisi: 1, avvisi_risposte: 3, chat_messages: 3, chat_threads: 2, conversazioni_sospensioni: 1, utenti: 1,
    })
    // Controllo positivo: la notifica è stata cancellata davvero, solo senza copia.
    expect(await numero('SELECT count(*) FROM public.notifiche')).toBe(0)
  })

  it('cancellare una conversazione moderata: la sospensione resta in scatola, intera, con la conversazione', async () => {
    await db.exec(`DELETE FROM public.chat_threads WHERE id = '${THREAD}'`)
    expect(await perTabella()).toEqual({ chat_messages: 2, chat_threads: 1, conversazioni_sospensioni: 1 })
    // La prova della moderazione si ripristina com'era: conversazione, chi ha sospeso, chi, perché.
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni
      WHERE tabella = 'conversazioni_sospensioni' AND riga ->> 'thread_id' = '${THREAD}'
        AND riga ->> 'sospesa_verso' = '${GENITORE}' AND riga ->> 'motivo' = 'motivo di prova'`)).toBe(1)
  })

  it('i trigger: eliminazioni e TRUNCATE vietato sulle dieci figlie', async () => {
    const dieci = `ARRAY['chat_messages','chat_threads','conversazioni_sospensioni','avvisi','avvisi_risposte',
      'nota_ricezioni','alunni_classi_storico','storici_collegamenti','storici_revisioni','fascicolo_accessi_audit']`
    expect(await numero(`SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE g.tgname = 'scatola_nera_eliminazioni' AND c.relname = ANY(${dieci})`)).toBe(10)
    expect(await numero(`SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE g.tgname = 'scatola_nera_no_truncate' AND c.relname = ANY(${dieci})`)).toBe(10)
    expect(await codiceErrore('TRUNCATE public.chat_messages')).toBe('P0001')
    expect(await numero('SELECT count(*) FROM public.chat_messages')).toBe(3)
    expect(await codiceErrore('TRUNCATE public.conversazioni_sospensioni')).toBe('P0001')
    expect(await numero('SELECT count(*) FROM public.conversazioni_sospensioni')).toBe(1)
  })
})

describe('lo storico delle modifiche copre anagrafiche, note e certificati', () => {
  it('ogni anagrafica modificata lascia la riga com’era', async () => {
    await db.exec(`
      UPDATE public.alunni SET nome = 'Bimbo corretto' WHERE id = '${ALUNNO}';
      UPDATE public.parents SET nome = 'Adulta corretta' WHERE id = '${GENITORE}';
      UPDATE public.utenti SET cognome = 'Corretto' WHERE id = '${DOCENTE}';
      UPDATE public.note_disciplinari SET testo = 'nota corretta' WHERE id = '${NOTA}';
      UPDATE public.certificati_medici SET stato = 'scaduto' WHERE id = '${CERTIFICATO}';
    `)
    const { rows } = await db.query<{ tabella: string; riga_id: string; cambiate: string[] }>(
      'SELECT tabella, riga_id, cambiate FROM scatola_nera.modifiche ORDER BY tabella')
    expect(rows).toEqual([
      { tabella: 'alunni', riga_id: ALUNNO, cambiate: ['nome'] },
      { tabella: 'certificati_medici', riga_id: CERTIFICATO, cambiate: ['stato'] },
      { tabella: 'note_disciplinari', riga_id: NOTA, cambiate: ['testo'] },
      { tabella: 'parents', riga_id: GENITORE, cambiate: ['nome'] },
      { tabella: 'utenti', riga_id: DOCENTE, cambiate: ['cognome'] },
    ])
    // La versione di prima, intera: è quella che il ripristino rimette.
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE prima ->> 'nome' = 'Bimbo'`)).toBe(1)
  })

  it('il «tocco» che cambia solo storico_versione non si copia; una modifica vera sì', async () => {
    await db.exec(`UPDATE public.note_disciplinari SET storico_versione = storico_versione + 1 WHERE id = '${NOTA}'`)
    expect(await numero('SELECT count(*) FROM scatola_nera.modifiche')).toBe(0)
    await db.exec(`UPDATE public.note_disciplinari
                      SET testo = 'nota corretta', storico_versione = storico_versione + 1
                    WHERE id = '${NOTA}'`)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE tabella = 'note_disciplinari'`)).toBe(1)
  })

  it('i trigger delle modifiche sulle cinque tabelle nuove', async () => {
    expect(await numero(`SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE g.tgname = 'scatola_nera_modifiche'
        AND c.relname = ANY(ARRAY['alunni','parents','utenti','note_disciplinari','certificati_medici'])`)).toBe(5)
  })
})

describe('un database con la fase 4 ma senza lo storico delle modifiche (la CI non migrata)', () => {
  // Senza `scatola_nera.modifiche` un trigger delle modifiche farebbe fallire OGNI UPDATE delle
  // anagrafiche (42P01): la migrazione non lo accende, e la scatola delle eliminazioni lavora.
  let solo4: PGlite

  beforeAll(async () => {
    solo4 = new PGlite()
    await solo4.exec(SCHEMA)
    await solo4.exec(ELIMINAZIONI)
    await solo4.exec(CASCATE)
    await solo4.exec(CASCATE)
  })

  afterAll(async () => {
    await solo4.close()
  })

  it('nessun trigger delle modifiche, gli UPDATE delle anagrafiche passano, le eliminazioni si copiano', async () => {
    const trigger = await solo4.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'scatola_nera_modifiche'`)
    expect(trigger.rows[0].n).toBe(0)
    await solo4.exec(`
      INSERT INTO public.schools VALUES ('${SEDE}', 'Sede di prova');
      INSERT INTO public.alunni (id, scuola_id, nome) VALUES ('${ALUNNO}', '${SEDE}', 'Bimbo');
      UPDATE public.alunni SET nome = 'Bimbo corretto' WHERE id = '${ALUNNO}';
    `)
    const viva = await solo4.query<{ nome: string }>(`SELECT nome FROM public.alunni WHERE id = '${ALUNNO}'`)
    expect(viva.rows).toEqual([{ nome: 'Bimbo corretto' }])
    // Controllo positivo: la scatola delle eliminazioni c'è e copia.
    await solo4.exec(`DELETE FROM public.alunni WHERE id = '${ALUNNO}'`)
    const copie = await solo4.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scatola_nera.eliminazioni WHERE tabella = 'alunni'`)
    expect(copie.rows[0].n).toBe(1)
  })

  // L'oblio della sessione 3 sostituisce quello della fase 4 anche qui: senza la guardia su
  // `scatola_nera.modifiche` OGNI oblio fallirebbe con 42P01, e l'app direbbe «oblio incompleto».
  it('l’oblio non fallisce: toglie le copie delle eliminazioni e scrive l’oblio', async () => {
    await solo4.exec(`
      INSERT INTO public.schools VALUES ('${SEDE}', 'Sede di prova') ON CONFLICT DO NOTHING;
      INSERT INTO public.alunni (id, scuola_id, nome, intestatario_fatture) VALUES
        ('${ALTRO_ALUNNO}', '${SEDE}', 'Altro',
         '{"tipo": "adult", "adult_id": "${INTESTATARIA_A}", "nome": "Adulta di prova"}');
      DELETE FROM public.alunni WHERE id = '${ALTRO_ALUNNO}';
    `)
    const prima = await solo4.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scatola_nera.eliminazioni WHERE riga ->> 'id' = '${ALTRO_ALUNNO}'`)
    expect(prima.rows[0].n).toBe(1)

    const { rows } = await solo4.query<{ n: number }>(
      `SELECT public.scatola_nera_dimentica(ARRAY['${ALTRO_ALUNNO}']::uuid[], 'alunno', 'prova') AS n`)
    expect(rows[0].n).toBe(1)
    const dopo = await solo4.query<{ copie: number; oblii: number }>(`
      SELECT (SELECT count(*) FROM scatola_nera.eliminazioni WHERE riga ->> 'id' = '${ALTRO_ALUNNO}')::int AS copie,
             (SELECT count(*) FROM scatola_nera.oblii WHERE soggetto = '${ALTRO_ALUNNO}')::int AS oblii`)
    expect(dopo.rows[0]).toEqual({ copie: 0, oblii: 1 })
  })
})

describe('le bonifiche accendono l’interruttore nella propria transazione', () => {
  beforeAll(async () => {
    // In produzione i due trigger esistono dal 15/10 (20261015183000_storici_stampe_rettifiche.sql:222
    // e :449); qui li crea il test, sulle funzioni ridefinite dalla migrazione della sessione 3.
    await db.exec(`
      CREATE OR REPLACE TRIGGER storici_oblio_alunno AFTER UPDATE OF anonimizzato_il ON public.alunni
        FOR EACH ROW EXECUTE FUNCTION public.storici_oblio_alunno();
      CREATE OR REPLACE TRIGGER storici_bonifica_chat BEFORE UPDATE OF content ON public.chat_messages
        FOR EACH ROW EXECUTE FUNCTION public.storici_bonifica_chat();
    `)
  })

  it('anonimizzare un alunno toglie revisioni e collegamenti SENZA copiarli', async () => {
    await db.exec(`UPDATE public.alunni SET anonimizzato_il = now() WHERE id = '${ALUNNO}'`)
    expect(await numero(`SELECT count(*) FROM public.storici_revisioni WHERE alunno_id = '${ALUNNO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.storici_collegamenti WHERE alunno_id = '${ALUNNO}'`)).toBe(0)
    expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(0)
    // Il battito resta quello di prima, con ON CONFLICT.
    expect(await numero(`SELECT count(*) FROM public.app_log WHERE fingerprint = 'storici-oblio-alunno'`)).toBe(1)
  })

  it('CONTROLLO POSITIVO: nella stessa transazione, dopo la bonifica, una DELETE torna a lasciare la copia', async () => {
    await db.exec(`
      BEGIN;
      UPDATE public.alunni SET anonimizzato_il = now() WHERE id = '${ALUNNO}';
      DELETE FROM public.fascicolo_accessi_audit WHERE alunno_id = '${ALUNNO}';
      COMMIT;
    `)
    expect(await perTabella()).toEqual({ fascicolo_accessi_audit: 1 })
  })

  it('l’interruttore torna com’era: se una pulizia dichiarata l’aveva già acceso, resta acceso', async () => {
    await db.exec(`
      BEGIN;
      SELECT set_config('scatola_nera.senza_storico', 'on', true);
      UPDATE public.alunni SET anonimizzato_il = now() WHERE id = '${ALUNNO}';
      DELETE FROM public.fascicolo_accessi_audit WHERE alunno_id = '${ALUNNO}';
      COMMIT;
    `)
    expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(0)
    // Controllo positivo: la DELETE dopo la bonifica è avvenuta davvero, solo senza copia.
    expect(await numero(`SELECT count(*) FROM public.fascicolo_accessi_audit WHERE alunno_id = '${ALUNNO}'`)).toBe(0)
  })

  it('correggere il testo di un messaggio toglie la sua revisione senza copiarla', async () => {
    await db.exec(`UPDATE public.chat_messages SET content = 'testo corretto' WHERE id = '${MSG_DOCENTE}'`)
    expect(await numero(`SELECT count(*) FROM public.storici_revisioni WHERE entita_id = '${MSG_DOCENTE}'`)).toBe(0)
    expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(0)
    expect(await numero(`SELECT rettifica_versione FROM public.chat_messages WHERE id = '${MSG_DOCENTE}'`)).toBe(1)
  })

  it('CONTROLLO POSITIVO: corretto e poi cancellato nella stessa transazione, il messaggio resta in scatola', async () => {
    await db.exec(`
      BEGIN;
      UPDATE public.chat_messages SET content = 'testo corretto' WHERE id = '${MSG_DOCENTE}';
      DELETE FROM public.chat_messages WHERE id = '${MSG_DOCENTE}';
      COMMIT;
    `)
    expect(await perTabella()).toEqual({ chat_messages: 1 })
  })
})

describe('l’oblio segue le conversazioni: chi nomina la persona solo per thread_id', () => {
  it('oblio del genitore: se ne vanno anche il messaggio della docente nella sua conversazione, la sua revisione e la sospensione', async () => {
    await db.exec(`
      DELETE FROM public.storici_revisioni WHERE entita_id = '${MSG_DOCENTE}';
      DELETE FROM public.chat_threads WHERE id IN ('${THREAD}', '${ALTRO_THREAD}');
    `)
    expect(await perTabella()).toEqual({
      chat_messages: 3, chat_threads: 2, conversazioni_sospensioni: 1, storici_revisioni: 1,
    })
    // La regola dei soli `id` e `*_id` ne troverebbe 2 su 5: la conversazione e il messaggio del
    // genitore. La sospensione lo nomina in `sospesa_verso`, e la conversazione per `thread_id`.
    expect(await numero(
      `SELECT count(*) FROM scatola_nera.eliminazioni WHERE soggetti && ARRAY['${GENITORE}']::uuid[]`)).toBe(2)

    const { rows } = await db.query<{ n: number }>(
      `SELECT public.scatola_nera_dimentica(ARRAY['${GENITORE}']::uuid[], 'genitore', 'prova') AS n`)
    expect(rows[0].n).toBe(5)
    // Controllo positivo: l'altra conversazione e il suo messaggio restano.
    expect(await perTabella()).toEqual({ chat_messages: 1, chat_threads: 1 })
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni WHERE riga ->> 'id' = '${MSG_ALTRO}'`)).toBe(1)
    expect(await numero(`SELECT righe_dimenticate FROM scatola_nera.oblii WHERE soggetto = '${GENITORE}'`)).toBe(5)
  })

  it('oblio dell’alunno con la conversazione ANCORA VIVA: se ne va la copia del messaggio cancellato della docente', async () => {
    await db.exec(`DELETE FROM public.chat_messages WHERE id IN ('${MSG_DOCENTE}', '${MSG_ALTRO}')`)
    expect(await perTabella()).toEqual({ chat_messages: 2 })

    const { rows } = await db.query<{ n: number }>(
      `SELECT public.scatola_nera_dimentica(ARRAY['${ALUNNO}']::uuid[], 'alunno', 'prova') AS n`)
    expect(rows[0].n).toBe(1)
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni WHERE riga ->> 'id' = '${MSG_DOCENTE}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni WHERE riga ->> 'id' = '${MSG_ALTRO}'`)).toBe(1)
  })

  it('oblio dell’alunno: la sospensione della sua conversazione cancellata se ne va con la conversazione', async () => {
    await db.exec(`DELETE FROM public.chat_threads WHERE id = '${THREAD}'`)
    expect(await perTabella()).toEqual({ chat_messages: 2, chat_threads: 1, conversazioni_sospensioni: 1 })

    const { rows } = await db.query<{ n: number }>(
      `SELECT public.scatola_nera_dimentica(ARRAY['${ALUNNO}']::uuid[], 'alunno', 'prova') AS n`)
    expect(rows[0].n).toBe(4)
    expect(await perTabella()).toEqual({})
  })

  // Chi sospende, chi è sospeso e chi riapre (la Direzione, che nella conversazione non c'è) stanno
  // in colonne senza `_id`: la copia di una sospensione li nomina SOLO lì.
  it.each(['sospesa_da', 'sospesa_verso', 'riaperta_da'])(
    'la sospensione nomina la persona solo in `%s`: l’oblio la toglie, e lascia la conversazione degli altri',
    async (colonna) => {
      const persone: Record<string, string | null> = {
        sospesa_da: DOCENTE, sospesa_verso: ALTRO_GENITORE, riaperta_da: null, [colonna]: DIREZIONE,
      }
      await db.exec(`
        INSERT INTO public.conversazioni_sospensioni (thread_id, sospesa_da, sospesa_verso, riaperta_da, motivo)
        VALUES ('${ALTRO_THREAD}', '${persone.sospesa_da}', '${persone.sospesa_verso}',
                ${persone.riaperta_da ? `'${persone.riaperta_da}'` : 'NULL'}, 'motivo di prova');
        DELETE FROM public.chat_threads WHERE id = '${ALTRO_THREAD}';
      `)
      expect(await perTabella()).toEqual({ chat_messages: 1, chat_threads: 1, conversazioni_sospensioni: 1 })

      const { rows } = await db.query<{ n: number }>(
        `SELECT public.scatola_nera_dimentica(ARRAY['${DIREZIONE}']::uuid[], 'personale', 'prova') AS n`)
      expect(rows[0].n).toBe(1)
      // Controllo positivo: la conversazione e il messaggio, che la Direzione non nominano, restano.
      expect(await perTabella()).toEqual({ chat_messages: 1, chat_threads: 1 })
    },
  )

  it('le modifiche: l’oblio toglie ancora le versioni di prima che nominano la persona', async () => {
    await db.exec(`UPDATE public.parents SET nome = 'Adulta corretta' WHERE id = '${GENITORE}'`)
    const { rows } = await db.query<{ n: number }>(
      `SELECT public.scatola_nera_dimentica(ARRAY['${GENITORE}']::uuid[], 'genitore', 'prova') AS n`)
    expect(rows[0].n).toBe(1)
    expect(await numero('SELECT count(*) FROM scatola_nera.modifiche')).toBe(0)
  })

  // L'anonimizzazione è un UPDATE delle anagrafiche: dal Compito 5 lascia in `scatola_nera.modifiche`
  // la riga com'era, con i dati personali. Se ne va solo perché l'oblio dell'app chiama
  // `scatola_nera_dimentica` PER ULTIMA (`src/lib/gdpr/esegui.ts`, provato in
  // `gdpr-oblio-scatola-nera-alunno.test.ts` e `gdpr-oblio-account.test.ts`).
  it('anonimizzare un alunno lascia la riga com’era nello storico: l’oblio chiamato DOPO la toglie', async () => {
    await db.exec(`UPDATE public.alunni SET nome = 'Anonimo', anonimizzato_il = now() WHERE id = '${ALUNNO}'`)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE prima ->> 'nome' = 'Bimbo'`)).toBe(1)

    const { rows } = await db.query<{ n: number }>(
      `SELECT public.scatola_nera_dimentica(ARRAY['${ALUNNO}']::uuid[], 'alunno', 'prova') AS n`)
    expect(rows[0].n).toBe(1)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE prima ->> 'nome' = 'Bimbo'`)).toBe(0)
  })

  it('CONTROLLO POSITIVO dell’ordine: un’anonimizzazione DOPO l’oblio lascia la copia in scatola', async () => {
    await db.query(`SELECT public.scatola_nera_dimentica(ARRAY['${ALUNNO}']::uuid[], 'alunno', 'prova')`)
    await db.exec(`UPDATE public.alunni SET nome = 'Anonimo', anonimizzato_il = now() WHERE id = '${ALUNNO}'`)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE prima ->> 'nome' = 'Bimbo'`)).toBe(1)
  })

  it('solo il servizio chiama l’oblio', async () => {
    const { rows } = await db.query<Record<string, boolean>>(`
      SELECT has_function_privilege('authenticated', 'public.scatola_nera_dimentica(uuid[], text, text)', 'EXECUTE') AS auth,
             has_function_privilege('anon', 'public.scatola_nera_dimentica(uuid[], text, text)', 'EXECUTE') AS anon,
             has_function_privilege('service_role', 'public.scatola_nera_dimentica(uuid[], text, text)', 'EXECUTE') AS servizio`)
    expect(rows[0]).toEqual({ auth: false, anon: false, servizio: true })
  })
})

/** L'intestatario delle fatture come lo scrive l'app: un adulto registrato, per `adult_id`. */
function intestatario(adulto: string): string {
  return `'{"tipo": "adult", "adult_id": "${adulto}", "nome": "Adulto di prova"}'::jsonb`
}

/** Cambia una colonna di ALUNNO SENZA lasciare copia: lo stato di partenza del caso. */
async function partenza(colonna: string, valore: string): Promise<void> {
  await db.exec(`
    BEGIN;
    SELECT set_config('scatola_nera.senza_storico', 'on', true);
    UPDATE public.alunni SET ${colonna} = ${valore} WHERE id = '${ALUNNO}';
    COMMIT;
  `)
}

async function dimentica(soggetto: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT public.scatola_nera_dimentica(ARRAY['${soggetto}']::uuid[], 'genitore', 'prova') AS n`)
  return rows[0].n
}

// La copia di un UPDATE su `alunni` contiene l'intestatario delle fatture, che è un GENITORE
// (in produzione 343 righe su 343 con `adult_id`, 25/10). `soggetti_di` legge solo le chiavi di
// primo livello: la copia nomina solo il bambino. Se la segreteria cambia l'intestatario da A a
// B, la riga viva nomina B e la copia è l'UNICO posto dove restano i dati di A.
describe('l’oblio di chi intesta le fatture di un bambino ancora iscritto', () => {
  it('le copie con A intestataria (una modifica qualunque, poi il cambio da A a B) se ne vanno con l’oblio di A', async () => {
    await partenza('intestatario_fatture', intestatario(INTESTATARIA_A))
    await db.exec(`UPDATE public.alunni SET nome = 'Bimbo corretto' WHERE id = '${ALUNNO}'`)
    await db.exec(`UPDATE public.alunni SET intestatario_fatture = ${intestatario(INTESTATARIO_B)} WHERE id = '${ALUNNO}'`)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche
      WHERE tabella = 'alunni' AND prima -> 'intestatario_fatture' ->> 'adult_id' = '${INTESTATARIA_A}'`)).toBe(2)
    // Il difetto: per la regola dei soli `id` e `*_id` le due copie non nominano A.
    expect(await numero(
      `SELECT count(*) FROM scatola_nera.modifiche WHERE soggetti && ARRAY['${INTESTATARIA_A}']::uuid[]`)).toBe(0)

    expect(await dimentica(INTESTATARIA_A)).toBe(2)
    expect(await numero('SELECT count(*) FROM scatola_nera.modifiche')).toBe(0)
    // Controllo positivo: la riga viva, che nomina B, non è affare dell'oblio della scatola.
    expect(await numero(`SELECT count(*) FROM public.alunni
      WHERE id = '${ALUNNO}' AND intestatario_fatture ->> 'adult_id' = '${INTESTATARIO_B}'`)).toBe(1)
  })

  // La tabella non ha una colonna `dopo`: la versione dopo sta nella riga viva o nella `prima`
  // della modifica successiva. I dati di B compaiono in una copia solo quando B viene sostituito.
  it('l’oblio di B toglie la copia in cui B compare, e lascia quella che contiene solo A', async () => {
    await partenza('intestatario_fatture', intestatario(INTESTATARIA_A))
    await db.exec(`UPDATE public.alunni SET intestatario_fatture = ${intestatario(INTESTATARIO_B)} WHERE id = '${ALUNNO}'`)
    await db.exec(`UPDATE public.alunni SET intestatario_fatture = NULL WHERE id = '${ALUNNO}'`)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE tabella = 'alunni'`)).toBe(2)

    expect(await dimentica(INTESTATARIO_B)).toBe(1)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche
      WHERE prima -> 'intestatario_fatture' ->> 'adult_id' = '${INTESTATARIA_A}'`)).toBe(1)
    expect(await dimentica(INTESTATARIA_A)).toBe(1)
    expect(await numero('SELECT count(*) FROM scatola_nera.modifiche')).toBe(0)
  })

  it('nessun falso positivo: altre copie dello stesso bambino, senza A o senza `adult_id`, restano', async () => {
    await partenza('intestatario_fatture', intestatario(INTESTATARIO_B))
    await db.exec(`UPDATE public.alunni SET nome = 'uno' WHERE id = '${ALUNNO}'`)
    // L'adulto non registrato (tipo «altro»): niente `adult_id`. Poi un `adult_id` nullo, poi
    // nessun intestatario, poi forme storte delle quote: nessun cast che possa fallire.
    await db.exec(`UPDATE public.alunni SET intestatario_fatture = '{"tipo": "altro", "dati": {"nome": "x"}}' WHERE id = '${ALUNNO}'`)
    await db.exec(`UPDATE public.alunni SET intestatario_fatture = '{"tipo": "adult", "adult_id": null}' WHERE id = '${ALUNNO}'`)
    await db.exec(`UPDATE public.alunni SET intestatario_fatture = NULL, retta_split_config = '{"quote": "testo"}' WHERE id = '${ALUNNO}'`)
    await db.exec(`UPDATE public.alunni SET retta_split_config = '{"quote": [1, null, "x", {"importo": 3}]}' WHERE id = '${ALUNNO}'`)
    await db.exec(`UPDATE public.alunni SET nome = 'due' WHERE id = '${ALUNNO}'`)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE tabella = 'alunni'`)).toBe(6)

    expect(await dimentica(INTESTATARIA_A)).toBe(0)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE tabella = 'alunni'`)).toBe(6)
    // Controllo positivo: B è nella `prima` delle prime due copie (il nome cambiato, poi il
    // passaggio all'adulto non registrato), e se ne va da quelle sole.
    expect(await dimentica(INTESTATARIO_B)).toBe(2)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE tabella = 'alunni'`)).toBe(4)
  })

  it('le quote della retta divisa nominano gli adulti allo stesso modo: l’oblio li segue', async () => {
    await partenza('retta_split_config', `'{"quote": [
      {"adult_id": "${INTESTATARIO_B}", "importo": 100, "nome": "Adulto di prova"},
      {"adult_id": "${ADULTO_QUOTA}", "importo": 50, "nome": "Altro adulto di prova"}]}'::jsonb`)
    await db.exec(`UPDATE public.alunni SET nome = 'Bimbo corretto' WHERE id = '${ALUNNO}'`)
    expect(await dimentica(INTESTATARIA_A)).toBe(0)
    expect(await dimentica(ADULTO_QUOTA)).toBe(1)
    expect(await numero('SELECT count(*) FROM scatola_nera.modifiche')).toBe(0)
  })

  it('la regola legge solo le copie di `alunni`: in un’altra tabella lo stesso percorso non è un intestatario', async () => {
    await db.exec(`
      INSERT INTO scatola_nera.modifiche (tabella, riga_id, prima, cambiate, soggetti, ruolo)
      VALUES ('pagamenti', '${CERTIFICATO}',
              '{"id": "${CERTIFICATO}", "intestatario_fatture": {"adult_id": "${INTESTATARIA_A}"},
                "retta_split_config": {"quote": [{"adult_id": "${INTESTATARIA_A}"}]}}',
              ARRAY['importo'], ARRAY['${CERTIFICATO}']::uuid[], 'prova');
      INSERT INTO scatola_nera.eliminazioni (tabella, riga, soggetti, ruolo)
      VALUES ('pagamenti',
              '{"id": "${CERTIFICATO}", "intestatario_fatture": {"adult_id": "${INTESTATARIA_A}"},
                "retta_split_config": {"quote": [{"adult_id": "${INTESTATARIA_A}"}]}}',
              ARRAY['${CERTIFICATO}']::uuid[], 'prova');
    `)
    expect(await dimentica(INTESTATARIA_A)).toBe(0)
    expect(await numero(`SELECT count(*) FROM scatola_nera.modifiche WHERE tabella = 'pagamenti'`)).toBe(1)
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni WHERE tabella = 'pagamenti'`)).toBe(1)
  })

  it('anche la copia di un bambino CANCELLATO (scatola delle eliminazioni) se ne va con l’oblio di A', async () => {
    await db.exec(`
      BEGIN;
      SELECT set_config('scatola_nera.senza_storico', 'on', true);
      UPDATE public.alunni SET intestatario_fatture = ${intestatario(INTESTATARIA_A)} WHERE id = '${ALTRO_ALUNNO}';
      COMMIT;
      DELETE FROM public.alunni WHERE id = '${ALTRO_ALUNNO}';
    `)
    const prima = await perTabella()
    expect(prima.alunni).toBe(1)

    expect(await dimentica(INTESTATARIA_A)).toBe(1)
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni WHERE tabella = 'alunni'`)).toBe(0)
    // Controllo positivo: le copie in cascata (conversazione, messaggio, risposta) non nominano A e restano.
    const restanti = Object.fromEntries(Object.entries(prima).filter(([t]) => t !== 'alunni'))
    expect(restanti).toEqual({ chat_messages: 1, chat_threads: 1 })
    expect(await perTabella()).toEqual(restanti)

    // Le quote della retta, nella copia di un bambino cancellato: stesso percorso, stessa regola.
    const terzo = '10000000-0000-4000-8000-000000000003'
    await db.exec(`
      INSERT INTO public.alunni (id, scuola_id, nome, retta_split_config) VALUES ('${terzo}', '${SEDE}', 'Terzo',
        '{"quote": [{"adult_id": "${ADULTO_QUOTA}", "importo": 10, "nome": "Adulto di prova"}]}');
      DELETE FROM public.alunni WHERE id = '${terzo}';
    `)
    expect(await dimentica(INTESTATARIA_A)).toBe(0)
    expect(await dimentica(ADULTO_QUOTA)).toBe(1)
    expect(await perTabella()).toEqual(restanti)
  })
})
