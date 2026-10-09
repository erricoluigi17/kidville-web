// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * SCATOLA NERA (fase 4, D3-A) · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Ciò che consegna lo fa rispettare solo il database: un trigger che vede anche
 * le righe portate via in CASCADE, una tabella in sola aggiunta, l'oblio che toglie
 * le copie di una persona, il ripristino che rimette le righe nell'ordine delle FK.
 * Un finto client direbbe «sì» a tutto.
 *
 * Lo schema è un MINIMO con i nomi veri e le stesse FK in CASCADE della
 * produzione (alunni → presenze, pagamenti → incassi). Il file della migrazione è
 * LETTO DAL DISCO e applicato DUE volte. Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_scatola_nera_registro_eliminazioni.sql'))
if (!FILE) throw new Error('migrazione *_scatola_nera_registro_eliminazioni.sql non trovata')
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE), 'utf8')

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = '10000000-0000-4000-8000-000000000001'
const FRATELLO = '10000000-0000-4000-8000-000000000002'
const GENITORE = '20000000-0000-4000-8000-000000000001'
const PAGAMENTO = '30000000-0000-4000-8000-000000000001'

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
    CREATE TABLE public.alunni (
      id uuid PRIMARY KEY, scuola_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
      nome text, allergies text, stato text DEFAULT 'iscritto'
    );
    CREATE TABLE public.presenze (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
      giorno date NOT NULL, stato text
    );
    CREATE TABLE public.legame_genitori_alunni (
      genitore_id uuid NOT NULL, alunno_id uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
      PRIMARY KEY (genitore_id, alunno_id)
    );
    CREATE TABLE public.pagamenti (
      id uuid PRIMARY KEY, alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE, importo numeric
    );
    CREATE TABLE public.incassi (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE, importo numeric
    );
    CREATE TABLE public.utenti (
      id uuid PRIMARY KEY, nome text, cognome text,
      nome_completo text GENERATED ALWAYS AS (nome || ' ' || cognome) STORED
    );
    -- Una tabella NON preziosa: deve restare fuori dalla scatola.
    CREATE TABLE public.notifiche (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), utente_id uuid);
  `)
  await db.exec(MIGRAZIONE)
  await db.exec(MIGRAZIONE) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    SET scatola_nera.manutenzione = 'on';
    DELETE FROM scatola_nera.eliminazioni;
    DELETE FROM scatola_nera.oblii;
    RESET scatola_nera.manutenzione;
    DELETE FROM public.app_log;
    ALTER TABLE public.schools DISABLE TRIGGER USER;
    ALTER TABLE public.alunni DISABLE TRIGGER USER;
    ALTER TABLE public.presenze DISABLE TRIGGER USER;
    ALTER TABLE public.legame_genitori_alunni DISABLE TRIGGER USER;
    ALTER TABLE public.pagamenti DISABLE TRIGGER USER;
    ALTER TABLE public.incassi DISABLE TRIGGER USER;
    ALTER TABLE public.utenti DISABLE TRIGGER USER;
    DELETE FROM public.incassi; DELETE FROM public.pagamenti; DELETE FROM public.legame_genitori_alunni;
    DELETE FROM public.presenze; DELETE FROM public.alunni; DELETE FROM public.schools; DELETE FROM public.utenti;
    DELETE FROM public.notifiche;
    ALTER TABLE public.schools ENABLE TRIGGER USER;
    ALTER TABLE public.alunni ENABLE TRIGGER USER;
    ALTER TABLE public.presenze ENABLE TRIGGER USER;
    ALTER TABLE public.legame_genitori_alunni ENABLE TRIGGER USER;
    ALTER TABLE public.pagamenti ENABLE TRIGGER USER;
    ALTER TABLE public.incassi ENABLE TRIGGER USER;
    ALTER TABLE public.utenti ENABLE TRIGGER USER;

    INSERT INTO public.schools VALUES ('${SEDE}', 'Sede di prova');
    INSERT INTO public.alunni (id, scuola_id, nome, allergies) VALUES
      ('${ALUNNO}', '${SEDE}', 'Bimbo', 'DATO DI PROVA'),
      ('${FRATELLO}', '${SEDE}', 'Fratello', NULL);
    INSERT INTO public.presenze (alunno_id, giorno, stato) VALUES
      ('${ALUNNO}', '2026-10-01', 'presente'), ('${ALUNNO}', '2026-10-02', 'assente');
    INSERT INTO public.legame_genitori_alunni VALUES ('${GENITORE}', '${ALUNNO}');
    INSERT INTO public.pagamenti VALUES ('${PAGAMENTO}', '${ALUNNO}', 150);
    INSERT INTO public.incassi (pagamento_id, importo) VALUES ('${PAGAMENTO}', 150);
    INSERT INTO public.utenti (id, nome, cognome) VALUES ('${GENITORE}', 'Adulta', 'DiProva');
  `)
})

describe('scatola nera — cosa registra', () => {
  it('una DELETE con le sue CASCADE: ogni riga, di ogni tabella, nella stessa transazione', async () => {
    await db.exec(`DELETE FROM public.alunni WHERE id = '${ALUNNO}'`)

    const { rows } = await db.query<{ tabella: string; n: number; transazioni: number }>(`
      SELECT tabella, count(*)::int AS n, count(DISTINCT transazione)::int AS transazioni
        FROM scatola_nera.eliminazioni GROUP BY tabella ORDER BY tabella`)
    expect(rows).toEqual([
      { tabella: 'alunni', n: 1, transazioni: 1 },
      { tabella: 'incassi', n: 1, transazioni: 1 },
      { tabella: 'legame_genitori_alunni', n: 1, transazioni: 1 },
      { tabella: 'pagamenti', n: 1, transazioni: 1 },
      { tabella: 'presenze', n: 2, transazioni: 1 },
    ])
    expect(await numero('SELECT count(DISTINCT transazione) FROM scatola_nera.eliminazioni')).toBe(1)
    // Controllo positivo: il fratello non è stato toccato, e non è in scatola.
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${FRATELLO}'`)).toBe(1)
  })

  it('la riga è intera, i soggetti sono gli uuid di `id` e delle colonne `*_id`', async () => {
    await db.exec(`DELETE FROM public.legame_genitori_alunni WHERE alunno_id = '${ALUNNO}'`)
    const { rows } = await db.query<{ riga: Record<string, unknown>; soggetti: string[]; ruolo: string }>(
      `SELECT riga, soggetti, ruolo FROM scatola_nera.eliminazioni`)
    expect(rows).toHaveLength(1)
    expect(rows[0].riga).toEqual({ genitore_id: GENITORE, alunno_id: ALUNNO })
    expect([...rows[0].soggetti].sort()).toEqual([ALUNNO, GENITORE].sort())
    expect(rows[0].ruolo).toBeTruthy()
  })

  it('una tabella fuori elenco non entra in scatola', async () => {
    await db.exec(`INSERT INTO public.notifiche (utente_id) VALUES ('${GENITORE}'); DELETE FROM public.notifiche`)
    expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(0)
  })

  it('TRUNCATE su una tabella preziosa è rifiutato, e la tabella resta piena', async () => {
    expect(await codiceErrore('TRUNCATE public.presenze')).toBe('P0001')
    expect(await numero('SELECT count(*) FROM public.presenze')).toBe(2)
  })
})

describe('scatola nera — solo in aggiunta', () => {
  beforeEach(async () => {
    await db.exec(`DELETE FROM public.presenze WHERE giorno = '2026-10-01'`)
  })

  it('UPDATE, DELETE e TRUNCATE della scatola sono rifiutati', async () => {
    expect(await codiceErrore(`UPDATE scatola_nera.eliminazioni SET tabella = 'x'`)).toBe('P0001')
    expect(await codiceErrore('DELETE FROM scatola_nera.eliminazioni')).toBe('P0001')
    expect(await codiceErrore('TRUNCATE scatola_nera.eliminazioni')).toBe('P0001')
    expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(1)
    // Il registro degli oblii, con una riga dentro (un trigger di riga su zero righe non scatta).
    await db.exec(`SELECT public.scatola_nera_dimentica(ARRAY['${FRATELLO}']::uuid[], 'alunno')`)
    expect(await codiceErrore('DELETE FROM scatola_nera.oblii')).toBe('P0001')
    expect(await codiceErrore(`UPDATE scatola_nera.oblii SET tipo = 'altro'`)).toBe('P0001')
    expect(await numero('SELECT count(*) FROM scatola_nera.oblii')).toBe(1)
  })

  it('i ruoli dell\'app non vedono lo schema, e non possono chiamare le sue funzioni', async () => {
    const { rows } = await db.query<Record<string, boolean>>(`
      SELECT has_schema_privilege('anon', 'scatola_nera', 'USAGE') AS anon_schema,
             has_schema_privilege('authenticated', 'scatola_nera', 'USAGE') AS auth_schema,
             has_function_privilege('authenticated', 'public.scatola_nera_dimentica(uuid[], text, text)', 'EXECUTE') AS auth_dimentica,
             has_function_privilege('anon', 'public.scatola_nera_dimentica(uuid[], text, text)', 'EXECUTE') AS anon_dimentica,
             has_function_privilege('service_role', 'public.scatola_nera_dimentica(uuid[], text, text)', 'EXECUTE') AS servizio_dimentica,
             has_function_privilege('service_role', 'scatola_nera.ripristina(bigint[])', 'EXECUTE') AS servizio_ripristina`)
    expect(rows[0]).toEqual({
      anon_schema: false, auth_schema: false, auth_dimentica: false, anon_dimentica: false,
      servizio_dimentica: true, servizio_ripristina: false,
    })
  })
})

describe('scatola nera — oblio e scadenza', () => {
  it('l\'oblio toglie le righe che nominano la persona, le altre restano, e scrive il registro', async () => {
    await db.exec(`DELETE FROM public.alunni WHERE id = '${ALUNNO}'`) // 6 righe, tutte legate all'alunno
    await db.exec(`DELETE FROM public.alunni WHERE id = '${FRATELLO}'`) // 1 riga del fratello

    const { rows } = await db.query<{ n: number }>(
      `SELECT public.scatola_nera_dimentica(ARRAY['${ALUNNO}']::uuid[], 'alunno', 'admin/gdpr/erase:POST') AS n`)
    // alunni, presenze ×2, legame, pagamenti nominano l'alunno; l'incasso nomina solo il pagamento.
    expect(rows[0].n).toBe(5)
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni WHERE '${ALUNNO}' = ANY(soggetti)`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM scatola_nera.eliminazioni WHERE tabella = 'alunni'`)).toBe(1) // il fratello

    const { rows: oblii } = await db.query<{ soggetto: string; tipo: string; righe_dimenticate: number }>(
      'SELECT soggetto, tipo, righe_dimenticate FROM scatola_nera.oblii')
    expect(oblii).toEqual([{ soggetto: ALUNNO, tipo: 'alunno', righe_dimenticate: 5 }])
  })

  it('un tipo sconosciuto è rifiutato; nessun soggetto è un no-op', async () => {
    expect(await codiceErrore(`SELECT public.scatola_nera_dimentica(ARRAY['${ALUNNO}']::uuid[], 'chiunque')`)).toBe('22023')
    const { rows } = await db.query<{ n: number }>(`SELECT public.scatola_nera_dimentica('{}'::uuid[], 'alunno') AS n`)
    expect(rows[0].n).toBe(0)
    expect(await numero('SELECT count(*) FROM scatola_nera.oblii')).toBe(0)
  })

  it('la scadenza toglie le righe oltre i 90 giorni, tiene le altre, e scrive il successo in app_log', async () => {
    await db.exec(`DELETE FROM public.presenze`) // 2 righe
    await db.exec(`
      SET scatola_nera.manutenzione = 'on';
      ALTER TABLE scatola_nera.eliminazioni DISABLE TRIGGER solo_aggiunta;
      UPDATE scatola_nera.eliminazioni SET eliminata_il = now() - interval '91 days'
       WHERE id = (SELECT min(id) FROM scatola_nera.eliminazioni);
      ALTER TABLE scatola_nera.eliminazioni ENABLE TRIGGER solo_aggiunta;
      RESET scatola_nera.manutenzione;`)

    const { rows } = await db.query<{ n: number }>('SELECT scatola_nera.scadenza() AS n')
    expect(rows[0].n).toBe(1)
    expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(1)
    const { rows: log } = await db.query<{ contesto: Record<string, unknown>; evento: string }>(
      `SELECT contesto, evento FROM public.app_log WHERE fingerprint = 'cron:scatola-nera-scadenza'`)
    expect(log[0].evento).toBe('cron')
    // Il battito nella forma che `/api/health` sa leggere (evento cron, campi.operazione, esito ok).
    expect(log[0].contesto).toMatchObject({
      campi: { operazione: 'scatola-nera-scadenza', esito: 'ok', n_righe: 1, n_presenti: 1 },
    })
    // Dopo la manutenzione la porta è di nuovo chiusa.
    expect(await codiceErrore('DELETE FROM scatola_nera.eliminazioni')).toBe('P0001')
  })
})

describe('scatola nera — ripristino', () => {
  it('una transazione intera torna com\'era, nell\'ordine delle FK (anche l\'identità e la colonna generata)', async () => {
    await db.exec(`DELETE FROM public.alunni WHERE id = '${ALUNNO}'`)
    await db.exec(`DELETE FROM public.utenti WHERE id = '${GENITORE}'`)
    const { rows: tx } = await db.query<{ t: string }>(
      `SELECT transazione::text AS t FROM scatola_nera.eliminazioni WHERE tabella = 'alunni'`)

    const { rows } = await db.query<{ r: { ripristinate: number; gia_presenti: number[]; fallite: unknown[] } }>(
      `SELECT scatola_nera.ripristina_transazione(${tx[0].t}) AS r`)
    expect(rows[0].r).toEqual({ ripristinate: 6, gia_presenti: [], fallite: [] })
    expect(await numero(`SELECT count(*) FROM public.presenze WHERE alunno_id = '${ALUNNO}'`)).toBe(2)
    expect(await numero(`SELECT count(*) FROM public.incassi WHERE pagamento_id = '${PAGAMENTO}'`)).toBe(1)
    const { rows: a } = await db.query<{ allergies: string }>(`SELECT allergies FROM public.alunni WHERE id = '${ALUNNO}'`)
    expect(a[0].allergies).toBe('DATO DI PROVA')

    // La riga di `utenti` ha una colonna generata: si ripristina senza nominarla.
    const { rows: u } = await db.query<{ id: string }>(`SELECT id::text FROM scatola_nera.eliminazioni WHERE tabella = 'utenti'`)
    const { rows: ru } = await db.query<{ r: { ripristinate: number } }>(
      `SELECT scatola_nera.ripristina(ARRAY[${u[0].id}]::bigint[]) AS r`)
    expect(ru[0].r.ripristinate).toBe(1)
    const { rows: nc } = await db.query<{ nome_completo: string }>(`SELECT nome_completo FROM public.utenti`)
    expect(nc[0].nome_completo).toBe('Adulta DiProva')
  })

  it('una riga già presente non si sovrascrive: si conta', async () => {
    await db.exec(`DELETE FROM public.legame_genitori_alunni`)
    await db.exec(`INSERT INTO public.legame_genitori_alunni VALUES ('${GENITORE}', '${ALUNNO}')`)
    const { rows: e } = await db.query<{ id: string }>('SELECT id::text FROM scatola_nera.eliminazioni')
    const { rows } = await db.query<{ r: { ripristinate: number; gia_presenti: number[] } }>(
      `SELECT scatola_nera.ripristina(ARRAY[${e[0].id}]::bigint[]) AS r`)
    expect(rows[0].r.ripristinate).toBe(0)
    expect(rows[0].r.gia_presenti).toEqual([Number(e[0].id)])
  })

  it('una riga il cui padre non c\'è più resta fuori, con il codice della FK', async () => {
    await db.exec(`DELETE FROM public.presenze WHERE giorno = '2026-10-01'`)
    await db.exec(`DELETE FROM public.alunni WHERE id = '${ALUNNO}'`)
    const { rows: p } = await db.query<{ id: string }>(
      `SELECT min(id)::text AS id FROM scatola_nera.eliminazioni WHERE tabella = 'presenze'`)
    const { rows } = await db.query<{ r: { ripristinate: number; fallite: { codice: string }[] } }>(
      `SELECT scatola_nera.ripristina(ARRAY[${p[0].id}]::bigint[]) AS r`)
    expect(rows[0].r.ripristinate).toBe(0)
    expect(rows[0].r.fallite).toEqual([{ id: Number(p[0].id), codice: '23503' }])
  })
})

describe('scatola nera — il controllo negativo', () => {
  it('SENZA il trigger la stessa DELETE non lascia traccia (il test misura il trigger, non il finto)', async () => {
    await db.exec('DROP TRIGGER scatola_nera_eliminazioni ON public.presenze')
    try {
      await db.exec(`DELETE FROM public.presenze`)
      expect(await numero('SELECT count(*) FROM scatola_nera.eliminazioni')).toBe(0)
    } finally {
      await db.exec(MIGRAZIONE)
    }
    expect(await numero(`SELECT count(*) FROM pg_trigger WHERE tgname = 'scatola_nera_eliminazioni' AND tgrelid = 'public.presenze'::regclass`)).toBe(1)
  })
})
