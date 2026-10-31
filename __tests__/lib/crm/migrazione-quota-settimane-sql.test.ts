// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * LA QUOTA D'ISCRIZIONE E LE SETTIMANE · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Il lock accanto (`migrazione-quota-settimane.test.ts`) legge il TESTO della migrazione; questo file la
 * ESEGUE. In una funzione plpgsql il nome di una colonna sbagliato non lo vede nessuno finché la funzione
 * non gira: in produzione esploderebbe davanti a una famiglia. Qui girano tutte e cinque, dentro una
 * copia fedele delle tabelle che toccano.
 *
 * Cosa NON è finto: la migrazione del CRM, la migrazione della cassa (provenienza), `registra_incasso_voce`
 * e le funzioni di ricalcolo sono LETTE dai loro file, non riscritte. È finto solo ciò che serve a farle
 * stare in piedi (sedi, utenti, domande, alunni, categorie) e le tabelle del conto — con le colonne vere.
 *
 * PGlite ha UNA connessione sola: la concorrenza vera (due richieste in volo sullo stesso bambino) qui non
 * si vede. Si vede però ciò che il blocco rende vero DOPO l'attesa: la seconda richiesta trova la quota già
 * segnata, la corregge con uno storno, e in cassa resta UNA entrata. Il `FOR UPDATE` lo sorveglia il lock.
 *
 * Solo dati finti: nomi di prova, uuid inventati.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
/** `CREATE OR REPLACE FUNCTION public.<nome>(…) … END $$;` tagliato dal file. */
function funzione(testo: string, nome: string): string {
  const inizio = testo.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`)
  const fine = testo.indexOf('END $$;', inizio)
  if (inizio < 0 || fine < 0) throw new Error(`corpo di ${nome} non trovato`)
  return testo.slice(inizio, fine + 'END $$;'.length)
}

const uuid = (pref: string, n: number) => `${pref}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const SEDE_A = uuid('a0000000', 1)
const SEDE_B = uuid('a0000000', 2)
const SEGRETARIA = uuid('b0000000', 1)
const COLLEGA = uuid('b0000000', 2)
const ALUNNO_A1 = uuid('c0000000', 1)
const ALUNNO_A2 = uuid('c0000000', 2)
const ALUNNO_B1 = uuid('c0000000', 3)
const GIORNO = '2026-10-30'

let db: PGlite

type Esito = Record<string, unknown> & { esito: string }

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } })
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA extensions;
    CREATE TYPE public.incasso_metodo AS ENUM
      ('contanti','bonifico','pos','assegno','altro','credito_famiglia','storno','rettifica');
    CREATE TYPE public.pagamento_tipo AS ENUM ('singolo','padre','rata');

    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.utenti (id uuid PRIMARY KEY);
    CREATE TABLE public.enrollment_submissions (id uuid PRIMARY KEY);
    CREATE TABLE public.parents (id uuid PRIMARY KEY);
    CREATE TABLE public.alunni (id uuid PRIMARY KEY, scuola_id uuid NOT NULL REFERENCES public.schools(id));

    CREATE TABLE public.payment_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id uuid REFERENCES public.schools(id),
      nome text NOT NULL, slug text,
      is_sistema boolean NOT NULL DEFAULT false, attivo boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.cassa_categorie (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text);
    CREATE TABLE public.cassa_chiusure (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

    CREATE TABLE public.pagamenti (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id),
      scuola_id uuid,
      descrizione text NOT NULL,
      importo numeric(10,2) NOT NULL,
      scadenza date NOT NULL,
      stato varchar(20) DEFAULT 'da_pagare',
      data_incasso timestamptz,
      categoria_id uuid REFERENCES public.payment_categories(id),
      tipo public.pagamento_tipo NOT NULL DEFAULT 'singolo',
      obbligatorio boolean NOT NULL DEFAULT true,
      parent_payment_id uuid REFERENCES public.pagamenti(id),
      gruppo text,
      importo_pagato numeric(10,2) NOT NULL DEFAULT 0,
      periodo_competenza date,
      creato_da uuid,
      aggiornato_il timestamptz DEFAULT now(),
      sconto numeric NOT NULL DEFAULT 0,
      sconto_motivo text
    );
    CREATE TABLE public.pagamenti_quote (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
      adult_id uuid NOT NULL, importo numeric(10,2) NOT NULL, etichetta text
    );
    CREATE TABLE public.incassi (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE RESTRICT,
      importo numeric(10,2) NOT NULL CHECK (importo <> 0),
      data_incasso date NOT NULL DEFAULT CURRENT_DATE,
      metodo public.incasso_metodo NOT NULL DEFAULT 'contanti',
      note text,
      quota_id uuid REFERENCES public.pagamenti_quote(id) ON DELETE SET NULL,
      registrato_da uuid,
      creato_il timestamptz DEFAULT now(),
      storno_di uuid, stornato_il timestamptz, storno_motivo text, transazione_id uuid
    );
    CREATE TABLE public.crediti_famiglia (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id uuid NOT NULL REFERENCES public.parents(id),
      scuola_id uuid NOT NULL, causale text NOT NULL,
      importo numeric(10,2) NOT NULL CHECK (importo <> 0),
      saldo_dopo numeric(10,2) NOT NULL CHECK (saldo_dopo >= 0),
      transazione_id uuid, incasso_id uuid, creato_da uuid, creato_il timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.registro_modifiche (
      id bigserial PRIMARY KEY,
      utente_id uuid, azione text NOT NULL, tabella_interessata varchar(100), record_id uuid,
      vecchio_valore jsonb, nuovo_valore jsonb, creato_il timestamptz DEFAULT now()
    );
    -- cassa_movimenti: le colonne di 20260720100000_cassa_base.sql (cassa_categoria_id arriva dalla sua migrazione).
    CREATE TABLE public.cassa_movimenti (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id     uuid NOT NULL REFERENCES public.schools(id),
      tipo          text NOT NULL CHECK (tipo IN ('entrata','uscita','prelievo','rettifica')),
      importo       numeric(10,2) NOT NULL CHECK (importo <> 0),
      metodo        text NOT NULL DEFAULT 'contanti' CHECK (metodo IN ('contanti','bonifico','carta','altro')),
      data          date NOT NULL DEFAULT CURRENT_DATE,
      categoria_id  uuid REFERENCES public.cassa_categorie(id) ON DELETE SET NULL,
      descrizione   text, note text, allegato_path text,
      incasso_id    uuid UNIQUE REFERENCES public.incassi(id) ON DELETE SET NULL,
      chiusura_id   uuid REFERENCES public.cassa_chiusure(id) ON DELETE SET NULL,
      registrato_da uuid REFERENCES public.utenti(id) ON DELETE SET NULL,
      creato_il     timestamptz NOT NULL DEFAULT now(),
      storno_di     uuid REFERENCES public.cassa_movimenti(id) ON DELETE SET NULL,
      stornato_il   timestamptz, storno_motivo text
    );

    CREATE FUNCTION public.trg_incassi_ricalcola() RETURNS trigger
      LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
    BEGIN
      PERFORM public.ricalcola_stato_pagamento(COALESCE(NEW.pagamento_id, OLD.pagamento_id));
      RETURN NULL;
    END $$;
    CREATE TRIGGER incassi_ricalcola AFTER INSERT OR DELETE OR UPDATE ON public.incassi
      FOR EACH ROW EXECUTE FUNCTION public.trg_incassi_ricalcola();

    INSERT INTO public.schools (id) VALUES ('${SEDE_A}'), ('${SEDE_B}');
    INSERT INTO public.utenti (id) VALUES ('${SEGRETARIA}'), ('${COLLEGA}');
    INSERT INTO public.alunni (id, scuola_id) VALUES ('${ALUNNO_A1}', '${SEDE_A}'), ('${ALUNNO_A2}', '${SEDE_A}'), ('${ALUNNO_B1}', '${SEDE_B}');
    INSERT INTO public.payment_categories (nome, slug, is_sistema, scuola_id) VALUES ('Iscrizione', 'iscrizione', true, NULL);
  `)

  // Le funzioni vere della contabilità, lette dai loro file.
  const v2 = migrazione('_contabilita_v2_regole.sql')
  await db.exec(funzione(v2, 'ricalcola_stato_padre'))
  await db.exec(funzione(v2, 'ricalcola_stato_pagamento'))
  await db.exec(migrazione('_registra_incasso_voce_bloccata.sql'))
  // La cassa: colonna cassa_categoria_id, i suoi trigger (la provenienza deve essere attiva e della sede) e il conteggio.
  await db.exec(migrazione('_cassa_provenienza_conteggio.sql'))
  // Il CRM com'era prima di questa migrazione, con una disponibilità da convertire.
  await db.exec(migrazione('_crm_segreteria.sql'))
  await db.exec(`
    INSERT INTO public.crm_disponibilita (scuola_id, utente_id, giorno_settimana, ora_inizio, ora_fine, durata_slot_min, valida_dal, valida_al) VALUES
      ('${SEDE_A}', '${SEGRETARIA}', 2, '09:00', '12:00', 45, '2020-01-01', NULL),
      ('${SEDE_A}', '${SEGRETARIA}', 4, '15:00', '17:00', 30, '2020-01-01', NULL),
      ('${SEDE_A}', '${COLLEGA}',    3, '09:00', '10:00', 45, '2020-01-01', '2020-12-31'),
      ('${SEDE_B}', '${SEGRETARIA}', 1, '10:00', '11:00', 45, '2020-01-01', '2999-12-31');
    INSERT INTO public.crm_schede (id, scuola_id, origine) VALUES ('${uuid('d0000000', 1)}', '${SEDE_A}', 'telefonata');
    INSERT INTO public.crm_bambini (scuola_id, scheda_id, nome, quota_saldata, quota_saldata_il)
      VALUES ('${SEDE_A}', '${uuid('d0000000', 1)}', 'Bimbo Demo', true, '2026-10-01');
  `)
  // La migrazione da provare.
  await db.exec(migrazione('_crm_quota_e_settimane.sql'))
}, 60_000)

afterAll(async () => {
  await db?.close()
})

// ── Aiuti ───────────────────────────────────────────────────────────────────────────────────────

async function una<T = Record<string, unknown>>(testo: string, par: unknown[] = []): Promise<T> {
  const r = await db.query<T>(testo, par)
  return r.rows[0]
}
async function righe<T = Record<string, unknown>>(testo: string, par: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(testo, par)).rows
}

let contatore = 0
/** Un bambino nuovo (con la sua scheda) nella sede data; collegato o no a un alunno. */
async function nuovoBambino(opz: { sede?: string; alunno?: string | null; anno?: 'in_corso' | 'prossimo' } = {}): Promise<string> {
  contatore += 1
  const sede = opz.sede ?? SEDE_A
  const scheda = await una<{ id: string }>(
    `INSERT INTO public.crm_schede (scuola_id, origine) VALUES ($1, 'telefonata') RETURNING id`,
    [sede],
  )
  const b = await una<{ id: string }>(
    `INSERT INTO public.crm_bambini (scuola_id, scheda_id, nome, anno_ingresso, alunno_id, alunno_collegato_il)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [sede, scheda.id, `Bimbo Prova ${contatore}`, opz.anno ?? 'prossimo', opz.alunno ?? null],
  )
  return b.id
}

async function segna(
  bambino: string,
  p: { importo?: number; metodo?: string; giorno?: string; anno?: number; da?: string | null } = {},
): Promise<Esito & { movimento_id: string | null; corretta: boolean; passaggio: (Esito & Record<string, unknown>) | null }> {
  const r = await una<{ r: never }>(
    `SELECT public.crm_quota_segna($1::uuid, $2::numeric, $3::text, $4::date, $5::smallint, $6::uuid) AS r`,
    [bambino, p.importo ?? 150.5, p.metodo ?? 'contanti', p.giorno ?? GIORNO, p.anno ?? 2027, p.da === undefined ? SEGRETARIA : p.da],
  )
  return r.r
}
async function passa(bambino: string, da: string | null = SEGRETARIA): Promise<Esito & Record<string, unknown>> {
  return (await una<{ r: never }>(`SELECT public.crm_quota_passa($1::uuid, $2::uuid) AS r`, [bambino, da])).r
}
async function togli(bambino: string, da: string | null = SEGRETARIA): Promise<Esito & Record<string, unknown>> {
  return (await una<{ r: never }>(`SELECT public.crm_quota_togli($1::uuid, $2::uuid) AS r`, [bambino, da])).r
}
async function aggancia(bambino: string, alunno: string, da: string | null = SEGRETARIA): Promise<Esito & Record<string, unknown>> {
  return (await una<{ r: never }>(`SELECT public.crm_aggancia_alunno($1::uuid, $2::uuid, $3::uuid) AS r`, [bambino, alunno, da])).r
}
async function salva(
  sede: string,
  utente: string | null,
  settimana: string,
  fasce: unknown[],
  da: string | null = SEGRETARIA,
): Promise<Esito & Record<string, unknown>> {
  return (
    await una<{ r: never }>(`SELECT public.crm_salva_settimana($1::uuid, $2::uuid, $3::date, $4::jsonb, $5::uuid) AS r`, [
      sede,
      utente,
      settimana,
      JSON.stringify(fasce),
      da,
    ])
  ).r
}

interface RigaBambino {
  quota_importo: string | null
  quota_metodo: string | null
  quota_anno: number | null
  quota_stato: string | null
  quota_blocco_motivo: string | null
  quota_saldata_il: string | null
  quota_segnata_da: string | null
  quota_cassa_movimento_id: string | null
  quota_pagamento_id: string | null
  alunno_id: string | null
  quota_saldata: boolean
}
async function bambino(id: string): Promise<RigaBambino> {
  return una<RigaBambino>(
    `SELECT quota_importo::text, quota_metodo, quota_anno, quota_stato, quota_blocco_motivo, quota_saldata_il::text,
            quota_segnata_da, quota_cassa_movimento_id, quota_pagamento_id, alunno_id, quota_saldata
       FROM public.crm_bambini WHERE id = $1`,
    [id],
  )
}
async function tipiEvento(id: string): Promise<string[]> {
  return (
    await righe<{ tipo: string }>(
      `SELECT e.tipo FROM public.crm_eventi e JOIN public.crm_bambini b ON b.scheda_id = e.scheda_id
        WHERE b.id = $1 AND e.tipo <> 'creata' ORDER BY e.creato_il, e.id`,
      [id],
    )
  ).map((r) => r.tipo)
}
async function datiEvento(id: string, tipo: string): Promise<Record<string, unknown>> {
  return (
    await una<{ dati: Record<string, unknown> }>(
      `SELECT e.dati FROM public.crm_eventi e JOIN public.crm_bambini b ON b.scheda_id = e.scheda_id
        WHERE b.id = $1 AND e.tipo = $2 ORDER BY e.creato_il DESC LIMIT 1`,
      [id, tipo],
    )
  ).dati
}

/** Le entrate di cassa del CRM per quella sede e quel giorno (esclusi i contromovimenti degli storni). */
async function entrateAttive(sede = SEDE_A, giorno = GIORNO) {
  return righe<{ id: string; importo: string; metodo: string; descrizione: string | null; incasso_id: string | null; cassa_categoria_id: string | null; categoria_id: string | null; registrato_da: string | null }>(
    `SELECT id, importo::text, metodo, descrizione, incasso_id, cassa_categoria_id, categoria_id, registrato_da
       FROM public.cassa_movimenti
      WHERE scuola_id = $1 AND data = $2 AND tipo = 'entrata' AND storno_di IS NULL AND stornato_il IS NULL`,
    [sede, giorno],
  )
}
/** Il totale di cassa in contanti del giorno, come lo dà il report (entrate, nette di storni e assorbimenti). */
async function entrateDelGiorno(sede = SEDE_A, giorno = GIORNO): Promise<number> {
  const r = await una<{ r: { totali: { entrate: number } } }>(
    `SELECT public.conteggio_cassa_provenienza($1::uuid[], $2::date, $2::date) AS r`,
    [[sede], giorno],
  )
  return Number(r.r.totali.entrate)
}
/**
 * Il totale di cassa da quel giorno in poi, senza fine. Serve agli storni: il contro-movimento porta la data
 * DELLO STORNO (oggi, come in `storno/route.ts`), non quella dell'entrata — il totale di un giorno passato
 * non si riscrive. Sommando il periodo intero, entrata e contro-movimento si vedono insieme.
 */
async function entrateDa(sede = SEDE_A, giorno = GIORNO): Promise<number> {
  const r = await una<{ r: { totali: { entrate: number } } }>(
    `SELECT public.conteggio_cassa_provenienza($1::uuid[], $2::date, NULL) AS r`,
    [[sede], giorno],
  )
  return Number(r.r.totali.entrate)
}
const voci = (alunno: string) =>
  righe<{ id: string; descrizione: string; importo: string; scadenza: string; stato: string; importo_pagato: string; periodo_competenza: string | null; categoria_id: string | null; tipo: string; obbligatorio: boolean; creato_da: string | null; scuola_id: string; gruppo: string | null }>(
    `SELECT id, descrizione, importo::text, scadenza::text, stato, importo_pagato::text, periodo_competenza::text, categoria_id, tipo::text, obbligatorio, creato_da, scuola_id, gruppo
       FROM public.pagamenti WHERE alunno_id = $1 ORDER BY creato_il_ordine`.replace(' ORDER BY creato_il_ordine', ' ORDER BY id'),
    [alunno],
  )
const incassiDi = (pagamento: string) =>
  righe<{ id: string; importo: string; metodo: string; data_incasso: string; registrato_da: string | null; note: string | null }>(
    `SELECT id, importo::text, metodo::text, data_incasso::text, registrato_da, note FROM public.incassi WHERE pagamento_id = $1 ORDER BY id`,
    [pagamento],
  )
async function categoriaIscrizione(): Promise<string> {
  return (await una<{ id: string }>(`SELECT id FROM public.payment_categories WHERE slug = 'iscrizione'`)).id
}
/** Una voce già presente per l'alunno (come quella che la contabilità assegna a mano). */
async function voceEsistente(alunno: string, opz: { importo: number; pagato?: number; competenza?: string | null; scadenza?: string }) {
  const cat = await categoriaIscrizione()
  const v = await una<{ id: string }>(
    `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, periodo_competenza)
     VALUES ($1, $2, 'Iscrizione assegnata a mano', $3, $4, $5, $6) RETURNING id`,
    [alunno, SEDE_A, opz.importo, opz.scadenza ?? '2027-09-10', cat, opz.competenza === undefined ? '2027-09-01' : opz.competenza],
  )
  if (opz.pagato) {
    await una(`SELECT public.registra_incasso_voce(p_pagamento_id => $1, p_importo => $2, p_registrato_da => $3, p_metodo => 'bonifico')`, [v.id, opz.pagato, COLLEGA])
  }
  return v.id
}

// ── La migrazione ───────────────────────────────────────────────────────────────────────────────

describe('la migrazione, eseguita: schema e conversione', () => {
  it('crm_disponibilita non c’è più, e le fasce ancora valide sono state copiate nella settimana in corso', async () => {
    expect((await una<{ r: string | null }>(`SELECT to_regclass('public.crm_disponibilita')::text AS r`)).r).toBeNull()
    const testate = await righe<{ scuola_id: string; utente_id: string | null; settimana: string; giorni: number; corrente: boolean }>(
      `SELECT s.scuola_id, s.utente_id, s.settimana::text,
              (SELECT count(*)::int FROM public.crm_fasce f WHERE f.settimana_id = s.id) AS giorni,
              s.settimana = date_trunc('week', CURRENT_DATE)::date AS corrente
         FROM public.crm_settimane s ORDER BY s.scuola_id, s.utente_id`,
    )
    // La segretaria della sede A (2 fasce) e quella della sede B (1 fascia); la collega, scaduta nel 2020, no.
    expect(testate.map((t) => [t.scuola_id, t.utente_id, t.giorni])).toEqual([
      [SEDE_A, SEGRETARIA, 2],
      [SEDE_B, SEGRETARIA, 1],
    ])
    expect(testate.every((t) => t.corrente)).toBe(true)
    const fasce = await righe<{ giorno_settimana: number; ora_inizio: string; ora_fine: string; durata_slot_min: number }>(
      `SELECT f.giorno_settimana, f.ora_inizio::text, f.ora_fine::text, f.durata_slot_min
         FROM public.crm_fasce f JOIN public.crm_settimane s ON s.id = f.settimana_id
        WHERE s.scuola_id = $1 ORDER BY f.giorno_settimana`,
      [SEDE_A],
    )
    expect(fasce).toEqual([
      { giorno_settimana: 2, ora_inizio: '09:00:00', ora_fine: '12:00:00', durata_slot_min: 45 },
      { giorno_settimana: 4, ora_inizio: '15:00:00', ora_fine: '17:00:00', durata_slot_min: 30 },
    ])
  })

  it('la vecchia spunta diventa «quota senza importo», e la colonna dismessa resta', async () => {
    const demo = await una<{ quota_stato: string | null; quota_saldata: boolean; quota_importo: string | null }>(
      `SELECT quota_stato, quota_saldata, quota_importo::text FROM public.crm_bambini WHERE nome = 'Bimbo Demo'`,
    )
    expect(demo).toEqual({ quota_stato: 'senza_importo', quota_saldata: true, quota_importo: null })
  })

  it('le cinque funzioni sono eseguibili solo dal service_role; i tre report restano come prima', async () => {
    const firme = [
      'crm_quota_passa(uuid, uuid)',
      'crm_quota_segna(uuid, numeric, text, date, smallint, uuid)',
      'crm_quota_togli(uuid, uuid)',
      'crm_aggancia_alunno(uuid, uuid, uuid)',
      'crm_salva_settimana(uuid, uuid, date, jsonb, uuid)',
      'report_cassa_aggregato(uuid[], date, date, uuid)',
      'report_cassa_dettaglio(uuid[], text, date, date, uuid, boolean, text, integer, integer)',
      'conteggio_cassa_provenienza(uuid[], date, date)',
    ]
    for (const f of firme) {
      const r = await righe<{ ruolo: string; puo: boolean }>(
        `SELECT ruolo, has_function_privilege(ruolo, $1, 'EXECUTE') AS puo FROM unnest(ARRAY['anon','authenticated','service_role']) AS ruolo`,
        [`public.${f}`],
      )
      expect(Object.fromEntries(r.map((x) => [x.ruolo, x.puo])), f).toEqual({ anon: false, authenticated: false, service_role: true })
    }
  })

  it('i vincoli: la quota è coerente col suo stato, e un alunno è di un solo bambino', async () => {
    const b = await nuovoBambino()
    // «in_attesa» senza importo: lo rifiuta la coerenza della quota.
    await expect(db.query(`UPDATE public.crm_bambini SET quota_stato = 'in_attesa' WHERE id = $1`, [b])).rejects.toMatchObject({ code: '23514' })
    // «bloccata» senza motivo, e un motivo senza «bloccata»: tutti e due rifiutati.
    await expect(
      db.query(`UPDATE public.crm_bambini SET quota_stato = 'senza_importo', quota_blocco_motivo = 'gia_pagata' WHERE id = $1`, [b]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(db.query(`UPDATE public.crm_bambini SET quota_stato = 'bloccata' WHERE id = $1`, [b])).rejects.toMatchObject({ code: '23514' })
    // Lo stesso alunno su due bambini: 23505 sul vincolo con nome.
    const x = await nuovoBambino({ alunno: ALUNNO_A2 })
    const y = await nuovoBambino()
    await expect(db.query(`UPDATE public.crm_bambini SET alunno_id = $2 WHERE id = $1`, [y, ALUNNO_A2])).rejects.toMatchObject({
      code: '23505',
      constraint: 'crm_bambini_alunno_unico',
    })
    // Pulizia: il bambino x non deve tenere l'alunno per gli altri test.
    await db.query(`UPDATE public.crm_bambini SET alunno_id = NULL WHERE id = $1`, [x])
  })

  it('lo storico ammette i cinque tipi nuovi e rifiuta quelli inventati', async () => {
    const b = await nuovoBambino()
    const scheda = (await una<{ scheda_id: string }>(`SELECT scheda_id FROM public.crm_bambini WHERE id = $1`, [b])).scheda_id
    for (const tipo of ['quota_in_contabilita', 'quota_corretta', 'quota_tolta', 'alunno_collegato', 'alunno_scollegato', 'quota_segnata']) {
      await db.query(`INSERT INTO public.crm_eventi (scuola_id, scheda_id, tipo, autore_via) VALUES ($1, $2, $3, 'sistema')`, [SEDE_A, scheda, tipo])
    }
    await expect(
      db.query(`INSERT INTO public.crm_eventi (scuola_id, scheda_id, tipo, autore_via) VALUES ($1, $2, 'tipo_inventato', 'sistema')`, [SEDE_A, scheda]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

// ── crm_quota_segna ────────────────────────────────────────────────────────────────────────────

describe('crm_quota_segna · contanti, bambino non ancora alunno', () => {
  it('scrive UNA entrata nella cassa del giorno, con la categoria di sistema, e lascia la quota in attesa', async () => {
    const b = await nuovoBambino()
    const r = await segna(b, { importo: 150.5, metodo: 'contanti', giorno: GIORNO, anno: 2027 })
    expect(r).toMatchObject({ esito: 'ok', corretta: false, passaggio: null })

    const q = await bambino(b)
    expect(q).toMatchObject({
      quota_importo: '150.50',
      quota_metodo: 'contanti',
      quota_anno: 2027,
      quota_stato: 'in_attesa',
      quota_blocco_motivo: null,
      quota_saldata_il: GIORNO,
      quota_segnata_da: SEGRETARIA,
      quota_pagamento_id: null,
    })
    expect(q.quota_cassa_movimento_id).toBe(r.movimento_id)

    const mov = (await entrateAttive()).filter((m) => m.id === r.movimento_id)
    expect(mov).toHaveLength(1)
    expect(mov[0]).toMatchObject({
      importo: '150.50',
      metodo: 'contanti',
      incasso_id: null,
      cassa_categoria_id: await categoriaIscrizione(),
      categoria_id: null,
      registrato_da: SEGRETARIA,
    })
    expect(mov[0].descrizione).toBe(`Quota d'iscrizione 2027/28 – Bimbo Prova ${contatore} (CRM)`)
    expect(await tipiEvento(b)).toEqual(['quota_segnata'])
    expect(await datiEvento(b, 'quota_segnata')).toEqual({
      bambino_id: b,
      importo: 150.5,
      metodo: 'contanti',
      giorno: GIORNO,
      anno: 2027,
      movimento_id: r.movimento_id,
    })
  })

  it('la stessa richiesta due volte (il doppio clic, dopo l’attesa) lascia UNA entrata attiva e la cassa non cresce', async () => {
    const b = await nuovoBambino()
    const prima = await entrateDa()
    const r1 = await segna(b, { importo: 80 })
    const dopoPrima = await entrateDa()
    const r2 = await segna(b, { importo: 80 })
    expect(r1.corretta).toBe(false)
    expect(r2.corretta).toBe(true)
    expect(r2.movimento_id).not.toBe(r1.movimento_id)

    // L'entrata di prima è stornata (contro-movimento + marcatura + registro), quella nuova è l'unica attiva.
    const vecchio = await una<{ stornato_il: string | null; storno_motivo: string | null }>(
      `SELECT stornato_il::text, storno_motivo FROM public.cassa_movimenti WHERE id = $1`,
      [r1.movimento_id],
    )
    expect(vecchio.stornato_il).not.toBeNull()
    expect(vecchio.storno_motivo).toBe("Quota d'iscrizione corretta dal CRM")
    const contro = await una<{ importo: string; tipo: string; metodo: string; cassa_categoria_id: string | null; registrato_da: string | null }>(
      `SELECT importo::text, tipo, metodo, cassa_categoria_id, registrato_da FROM public.cassa_movimenti WHERE storno_di = $1`,
      [r1.movimento_id],
    )
    expect(contro).toMatchObject({ importo: '-80.00', tipo: 'entrata', metodo: 'contanti', registrato_da: SEGRETARIA })
    expect(contro.cassa_categoria_id).toBe(await categoriaIscrizione())
    const audit = await una<{ azione: string; tabella_interessata: string; nuovo_valore: Record<string, unknown>; vecchio_valore: Record<string, unknown> }>(
      `SELECT azione, tabella_interessata, nuovo_valore, vecchio_valore FROM public.registro_modifiche WHERE record_id = $1`,
      [r1.movimento_id],
    )
    expect(audit.azione).toBe('storno_cassa_movimento')
    expect(audit.tabella_interessata).toBe('cassa_movimenti')
    expect(audit.nuovo_valore.storno_motivo).toBe("Quota d'iscrizione corretta dal CRM")
    // Il registro non porta la descrizione (c'è il nome del bambino): solo i campi del movimento.
    expect(Object.keys(audit.vecchio_valore)).not.toContain('descrizione')

    expect(dopoPrima - prima).toBeCloseTo(80, 2)
    expect((await entrateDa()) - prima).toBeCloseTo(80, 2) // dopo la seconda: ancora 80, non 160
    expect((await bambino(b)).quota_cassa_movimento_id).toBe(r2.movimento_id)
    expect(await tipiEvento(b)).toEqual(['quota_segnata', 'quota_corretta'])
  })

  it('correggere il metodo da contanti a carta storna l’entrata e non ne scrive un’altra', async () => {
    const b = await nuovoBambino()
    const prima = await entrateDa()
    const r1 = await segna(b, { importo: 100, metodo: 'contanti' })
    const r2 = await segna(b, { importo: 100, metodo: 'carta' })
    expect(r2.movimento_id).toBeNull()
    expect((await bambino(b)).quota_cassa_movimento_id).toBeNull()
    expect((await bambino(b)).quota_metodo).toBe('carta')
    expect((await entrateDa()) - prima).toBeCloseTo(0, 2)
    const stornata = await una<{ stornato_il: string | null }>(`SELECT stornato_il::text FROM public.cassa_movimenti WHERE id = $1`, [r1.movimento_id])
    expect(stornata.stornato_il).not.toBeNull()
  })

  it('carta e bonifico non toccano la cassa: non è nel cassetto', async () => {
    for (const metodo of ['carta', 'bonifico']) {
      const b = await nuovoBambino()
      const prima = (await righe(`SELECT id FROM public.cassa_movimenti`)).length
      const r = await segna(b, { metodo, importo: 120 })
      expect(r).toMatchObject({ esito: 'ok', movimento_id: null, passaggio: null })
      expect((await righe(`SELECT id FROM public.cassa_movimenti`)).length, metodo).toBe(prima)
      expect(await bambino(b)).toMatchObject({ quota_stato: 'in_attesa', quota_metodo: metodo, quota_cassa_movimento_id: null })
    }
  })

  it('la vecchia spunta senza importo si completa: è la prima quota, non una correzione', async () => {
    const demo = await una<{ id: string }>(`SELECT id FROM public.crm_bambini WHERE nome = 'Bimbo Demo'`)
    const r = await segna(demo.id, { importo: 99.99, metodo: 'bonifico' })
    expect(r).toMatchObject({ esito: 'ok', corretta: false })
    expect(await bambino(demo.id)).toMatchObject({ quota_stato: 'in_attesa', quota_importo: '99.99', quota_saldata: true })
  })

  it('rifiuta ciò che il database non saprebbe scrivere (importo, metodo, giorno, anno), senza lasciare niente', async () => {
    const b = await nuovoBambino()
    const prima = (await righe(`SELECT id FROM public.cassa_movimenti`)).length
    const chiama = (importo: unknown, metodo: unknown, giorno: unknown, anno: unknown) =>
      db.query(`SELECT public.crm_quota_segna($1::uuid, $2::numeric, $3::text, $4::date, $5::smallint, $6::uuid)`, [b, importo, metodo, giorno, anno, SEGRETARIA])
    await expect(chiama(0, 'contanti', GIORNO, 2027)).rejects.toMatchObject({ code: '22023' })
    await expect(chiama(-5, 'contanti', GIORNO, 2027)).rejects.toMatchObject({ code: '22023' })
    await expect(chiama(10.005, 'contanti', GIORNO, 2027)).rejects.toMatchObject({ code: '22023' })
    await expect(chiama(10, 'assegno', GIORNO, 2027)).rejects.toMatchObject({ code: '22023' })
    await expect(chiama(10, 'contanti', null, 2027)).rejects.toMatchObject({ code: '22023' })
    await expect(chiama(10, 'contanti', GIORNO, null)).rejects.toMatchObject({ code: '22023' })
    expect((await righe(`SELECT id FROM public.cassa_movimenti`)).length).toBe(prima)
    expect((await bambino(b)).quota_stato).toBeNull()
  })

  it('un bambino che non c’è risponde non_trovato; la categoria che manca ferma i contanti prima di scrivere', async () => {
    expect((await segna(uuid('f0000000', 99))).esito).toBe('non_trovato')
    const b = await nuovoBambino()
    await db.exec(`UPDATE public.payment_categories SET slug = 'iscrizione_fuori' WHERE slug = 'iscrizione'`)
    try {
      const prima = (await righe(`SELECT id FROM public.cassa_movimenti`)).length
      expect((await segna(b, { metodo: 'contanti' })).esito).toBe('categoria_assente')
      expect((await righe(`SELECT id FROM public.cassa_movimenti`)).length).toBe(prima)
      expect((await bambino(b)).quota_stato).toBeNull()
      // I metodi che non toccano la cassa non hanno bisogno della categoria per segnare la quota.
      expect((await segna(b, { metodo: 'bonifico' })).esito).toBe('ok')
    } finally {
      await db.exec(`UPDATE public.payment_categories SET slug = 'iscrizione' WHERE slug = 'iscrizione_fuori'`)
    }
  })
})

// ── Il passaggio in contabilità ─────────────────────────────────────────────────────────────────

describe('il passaggio in contabilità · il totale di nessun giorno di cassa cambia', () => {
  it('contanti: segna per un bambino nuovo, poi l’alunno compare: nasce la voce pagata e l’entrata si aggancia all’incasso', async () => {
    const b = await nuovoBambino()
    const giorno = '2026-10-29'
    const r = await segna(b, { importo: 200, metodo: 'contanti', giorno, anno: 2027 })
    const prima = await entrateDelGiorno(SEDE_A, giorno)
    expect(prima).toBeCloseTo(200, 2)

    const a = await aggancia(b, ALUNNO_A1)
    expect(a).toMatchObject({ esito: 'ok', collegato: true })
    expect(a.passaggio).toMatchObject({ esito: 'ok', voce_nuova: true, metodo: 'contanti' })

    // La voce: gli stessi campi di POST /api/pagamenti, la competenza al 1° settembre, l'autore di chi ha segnato.
    const [voce] = await voci(ALUNNO_A1)
    expect(voce).toMatchObject({
      descrizione: 'Iscrizione 2027/28',
      importo: '200.00',
      scadenza: giorno,
      stato: 'pagato',
      importo_pagato: '200.00',
      periodo_competenza: '2027-09-01',
      tipo: 'singolo',
      obbligatorio: true,
      creato_da: SEGRETARIA,
      scuola_id: SEDE_A,
      gruppo: null,
      categoria_id: await categoriaIscrizione(),
    })
    // L'incasso: stesso importo, contanti, data = giorno del pagamento (non il giorno dell'aggancio).
    const inc = await incassiDi(voce.id)
    expect(inc).toHaveLength(1)
    expect(inc[0]).toMatchObject({ importo: '200.00', metodo: 'contanti', data_incasso: giorno, registrato_da: SEGRETARIA, note: "Quota d'iscrizione dal CRM" })
    expect(a.passaggio).toMatchObject({ pagamento_id: voce.id, incasso_id: inc[0].id })

    // L'entrata di cassa è assorbita da quell'incasso, e il totale del giorno è IDENTICO a prima.
    const mov = await una<{ incasso_id: string | null }>(`SELECT incasso_id FROM public.cassa_movimenti WHERE id = $1`, [r.movimento_id])
    expect(mov.incasso_id).toBe(inc[0].id)
    expect(await entrateDelGiorno(SEDE_A, giorno)).toBeCloseTo(prima, 2)

    expect(await bambino(b)).toMatchObject({ quota_stato: 'in_contabilita', quota_pagamento_id: voce.id, quota_blocco_motivo: null, alunno_id: ALUNNO_A1 })
    expect(await tipiEvento(b)).toEqual(['quota_segnata', 'alunno_collegato', 'quota_in_contabilita'])
    expect(await datiEvento(b, 'quota_in_contabilita')).toEqual({
      bambino_id: b,
      pagamento_id: voce.id,
      incasso_id: inc[0].id,
      importo: 200,
      metodo: 'contanti',
      anno: 2027,
    })
    expect(await datiEvento(b, 'alunno_collegato')).toEqual({ bambino_id: b, alunno_id: ALUNNO_A1 })
  })

  it('l’aggancio ripetuto non fa una seconda voce né un secondo incasso', async () => {
    const b = await nuovoBambino()
    await segna(b, { importo: 60 })
    await aggancia(b, ALUNNO_A2)
    const ancora = await aggancia(b, ALUNNO_A2)
    // La quota è già in contabilità: l'aggancio non ritenta niente (passaggio nullo); la chiamata diretta lo dice.
    expect(ancora).toEqual({ esito: 'ok', collegato: false, passaggio: null })
    expect(await voci(ALUNNO_A2)).toHaveLength(1)
    const [voce] = await voci(ALUNNO_A2)
    expect(await incassiDi(voce.id)).toHaveLength(1)
    expect(await passa(b)).toMatchObject({ esito: 'gia_in_contabilita', pagamento_id: voce.id })
  })

  it('il bambino è già alunno: segnare i contanti li porta subito in contabilità, nella stessa transazione', async () => {
    const alunno = uuid('c0000000', 10)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    const b = await nuovoBambino({ alunno })
    const giorno = '2026-10-28'
    const prima = await entrateDelGiorno(SEDE_A, giorno)
    const r = await segna(b, { importo: 75, giorno })
    expect(r.passaggio).toMatchObject({ esito: 'ok', voce_nuova: true, metodo: 'contanti' })
    const [voce] = await voci(alunno)
    expect(voce).toMatchObject({ stato: 'pagato', importo_pagato: '75.00' })
    expect(await entrateDelGiorno(SEDE_A, giorno)).toBeCloseTo(prima + 75, 2) // una volta sola, non due
    expect((await bambino(b)).quota_stato).toBe('in_contabilita')
  })

  it('carta: l’incasso è un pos, la cassa non ha niente da assorbire', async () => {
    const alunno = uuid('c0000000', 11)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    const b = await nuovoBambino({ alunno })
    const r = await segna(b, { importo: 90, metodo: 'carta', giorno: '2026-10-27' })
    expect(r.movimento_id).toBeNull()
    expect(r.passaggio).toMatchObject({ esito: 'ok', metodo: 'carta' })
    const [voce] = await voci(alunno)
    expect(voce.stato).toBe('pagato')
    expect((await incassiDi(voce.id)).map((i) => i.metodo)).toEqual(['pos'])
  })

  it('bonifico: la voce nasce da pagare e non nasce nessun incasso — la chiude la banca', async () => {
    const b = await nuovoBambino()
    await segna(b, { importo: 130, metodo: 'bonifico' })
    const a = await aggancia(b, ALUNNO_A1 /* già di un altro bambino? no: libero dopo i test sopra */).catch(() => null)
    // L'alunno A1 è già del bambino del primo test: l'aggancio dice alunno_gia_collegato e la quota resta in attesa.
    expect(a).toMatchObject({ esito: 'alunno_gia_collegato' })
    expect((await bambino(b)).quota_stato).toBe('in_attesa')

    const alunno = uuid('c0000000', 12)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    const ok = await aggancia(b, alunno)
    expect(ok.passaggio).toMatchObject({ esito: 'ok', voce_nuova: true, incasso_id: null, metodo: 'bonifico' })
    const [voce] = await voci(alunno)
    expect(voce).toMatchObject({ stato: 'da_pagare', importo_pagato: '0.00', importo: '130.00', periodo_competenza: '2027-09-01' })
    expect(await incassiDi(voce.id)).toHaveLength(0)
    expect((await bambino(b)).quota_stato).toBe('in_contabilita')
  })

  // La scadenza della voce NUOVA. Il cron dei solleciti scrive «non risulta ancora saldato» a scadenza + 3 giorni
  // alle voci aperte e obbligatorie: una voce da bonifico con scadenza = giorno del pagamento (oggi o passato)
  // farebbe scrivere a una famiglia che ha già pagato, prima che la banca riconcili. Decisione del 31/10/2026.
  describe('la scadenza della voce nuova', () => {
    async function voceNuovaDi(metodo: string, giorno: string) {
      const alunno = uuid('c2000000', ++contatore)
      await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
      const b = await nuovoBambino({ alunno })
      const r = await segna(b, { importo: 100, metodo, giorno })
      expect(r.passaggio).toMatchObject({ esito: 'ok', voce_nuova: true, metodo })
      const elenco = await voci(alunno)
      expect(elenco).toHaveLength(1)
      return elenco[0]
    }

    it('bonifico: la voce nuova scade 30 giorni DOPO il giorno del pagamento, e resta da pagare', async () => {
      const voce = await voceNuovaDi('bonifico', '2026-10-29')
      expect(voce.stato).toBe('da_pagare')
      expect(voce.scadenza).toBe('2026-11-28')
    })

    it('bonifico: i 30 giorni sono di calendario, anche a cavallo di mese e d’anno', async () => {
      expect((await voceNuovaDi('bonifico', '2026-12-15')).scadenza).toBe('2027-01-14')
      expect((await voceNuovaDi('bonifico', '2027-01-31')).scadenza).toBe('2027-03-02')
    })

    it.each(['contanti', 'carta'])('%s: la voce nuova nasce pagata e scade il giorno del pagamento', async (metodo) => {
      const voce = await voceNuovaDi(metodo, '2026-10-29')
      expect(voce.stato).toBe('pagato')
      expect(voce.scadenza).toBe('2026-10-29')
    })

    it('bonifico su una voce che l’alunno ha già: la sua scadenza non si tocca', async () => {
      const alunno = uuid('c2000000', ++contatore)
      await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
      const esistente = await voceEsistente(alunno, { importo: 100, scadenza: '2027-09-10' })
      const b = await nuovoBambino({ alunno })
      const r = await segna(b, { importo: 100, metodo: 'bonifico', giorno: '2026-10-29' })
      expect(r.passaggio).toMatchObject({ esito: 'ok', voce_nuova: false, pagamento_id: esistente })
      const elenco = await voci(alunno)
      expect(elenco).toHaveLength(1)
      expect(elenco[0].scadenza).toBe('2027-09-10')
    })
  })

  it('l’anno scolastico mette la competenza al 1° settembre di quell’anno e la descrizione AAAA/AA', async () => {
    const alunno = uuid('c0000000', 13)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    const b = await nuovoBambino({ alunno })
    await segna(b, { importo: 50, metodo: 'bonifico', anno: 2099 })
    const [voce] = await voci(alunno)
    expect(voce).toMatchObject({ descrizione: 'Iscrizione 2099/00', periodo_competenza: '2099-09-01' })
  })

  it('autore: la voce e l’incasso portano chi ha SEGNATO la quota, anche se l’aggancio lo fa un collega o il sistema', async () => {
    const b = await nuovoBambino()
    await segna(b, { importo: 40, da: SEGRETARIA })
    const alunno = uuid('c0000000', 14)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    await aggancia(b, alunno, null) // l'import: nessun utente
    const [voce] = await voci(alunno)
    expect(voce.creato_da).toBe(SEGRETARIA)
    expect((await incassiDi(voce.id))[0].registrato_da).toBe(SEGRETARIA)
    const ev = await una<{ autore: string | null; autore_via: string }>(
      `SELECT e.autore, e.autore_via FROM public.crm_eventi e JOIN public.crm_bambini b ON b.scheda_id = e.scheda_id
        WHERE b.id = $1 AND e.tipo = 'quota_in_contabilita'`,
      [b],
    )
    expect(ev).toEqual({ autore: null, autore_via: 'sistema' })
  })
})

describe('il passaggio in contabilità · i casi che non devono rompersi', () => {
  async function bambinoAlunnoConQuota(metodo: string, importo: number) {
    const alunno = uuid('c1000000', ++contatore)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    // Si prepara il bambino collegato SENZA passare dal passaggio automatico: la quota si scrive a mano, poi si prova a passare.
    const b = await nuovoBambino({ alunno })
    return { alunno, b, segnaSenzaPassare: async () => {
      await db.query(`UPDATE public.crm_bambini SET alunno_id = NULL WHERE id = $1`, [b])
      const r = await segna(b, { importo, metodo })
      await db.query(`UPDATE public.crm_bambini SET alunno_id = $2 WHERE id = $1`, [b, alunno])
      return r
    } }
  }

  it('una voce aperta di importo uguale: la quota la paga, nessuna seconda voce, e l’entrata di cassa si aggancia all’incasso', async () => {
    const { alunno, b, segnaSenzaPassare } = await bambinoAlunnoConQuota('contanti', 300)
    const voce = await voceEsistente(alunno, { importo: 300 })
    const r = await segnaSenzaPassare()
    const esito = await passa(b)
    expect(esito).toMatchObject({ esito: 'ok', voce_nuova: false, pagamento_id: voce })
    expect(await voci(alunno)).toHaveLength(1)
    expect((await voci(alunno))[0].stato).toBe('pagato')
    const inc = await incassiDi(voce)
    expect(inc).toHaveLength(1)
    expect((await una<{ incasso_id: string }>(`SELECT incasso_id FROM public.cassa_movimenti WHERE id = $1`, [r.movimento_id])).incasso_id).toBe(inc[0].id)
  })

  it('una voce senza competenza ma con scadenza nello stesso anno scolastico è LA voce di quell’anno', async () => {
    const { alunno, b, segnaSenzaPassare } = await bambinoAlunnoConQuota('bonifico', 100)
    const voce = await voceEsistente(alunno, { importo: 100, competenza: null, scadenza: '2028-06-30' })
    await segnaSenzaPassare()
    expect(await passa(b)).toMatchObject({ esito: 'ok', voce_nuova: false, pagamento_id: voce })
    expect(await voci(alunno)).toHaveLength(1)
  })

  it('una voce senza competenza con scadenza FUORI dall’anno scolastico non c’entra: ne nasce una nuova', async () => {
    const { alunno, b, segnaSenzaPassare } = await bambinoAlunnoConQuota('bonifico', 100)
    await voceEsistente(alunno, { importo: 100, competenza: null, scadenza: '2028-09-01' })
    await segnaSenzaPassare()
    expect(await passa(b)).toMatchObject({ esito: 'ok', voce_nuova: true })
    expect(await voci(alunno)).toHaveLength(2)
  })

  it('l’importo supera il residuo: la quota resta bloccata (nessun credito automatico) e non tocca niente', async () => {
    const { alunno, b, segnaSenzaPassare } = await bambinoAlunnoConQuota('contanti', 300)
    const voce = await voceEsistente(alunno, { importo: 250 })
    const r = await segnaSenzaPassare()
    expect(await passa(b)).toEqual({ esito: 'bloccata', motivo: 'supera_residuo' })
    expect(await bambino(b)).toMatchObject({ quota_stato: 'bloccata', quota_blocco_motivo: 'supera_residuo', quota_pagamento_id: null })
    expect(await incassiDi(voce)).toHaveLength(0)
    expect((await una<{ incasso_id: string | null }>(`SELECT incasso_id FROM public.cassa_movimenti WHERE id = $1`, [r.movimento_id])).incasso_id).toBeNull()
    expect(await tipiEvento(b)).not.toContain('quota_in_contabilita')
  })

  it('la voce è già pagata: bloccata con il suo motivo; poi, tolta la quota, la cassa torna a posto', async () => {
    const { alunno, b, segnaSenzaPassare } = await bambinoAlunnoConQuota('contanti', 300)
    await voceEsistente(alunno, { importo: 300, pagato: 300 })
    const prima = await entrateDa()
    await segnaSenzaPassare()
    expect(await passa(b)).toEqual({ esito: 'bloccata', motivo: 'gia_pagata' })
    expect((await bambino(b)).quota_blocco_motivo).toBe('gia_pagata')
    // «È lo stesso pagamento»: per i contanti si storna l'entrata del CRM.
    expect(await togli(b)).toEqual({ esito: 'ok', stornato: true })
    expect(await entrateDa()).toBeCloseTo(prima, 2)
    expect(await bambino(b)).toMatchObject({ quota_stato: null, quota_importo: null, quota_blocco_motivo: null, quota_cassa_movimento_id: null })
  })

  it('due voci per lo stesso alunno e anno: non si sceglie a caso', async () => {
    const { alunno, b, segnaSenzaPassare } = await bambinoAlunnoConQuota('bonifico', 100)
    await voceEsistente(alunno, { importo: 100 })
    await voceEsistente(alunno, { importo: 100 })
    await segnaSenzaPassare()
    expect(await passa(b)).toEqual({ esito: 'bloccata', motivo: 'piu_voci' })
    expect(await voci(alunno)).toHaveLength(2)
  })

  it('bonifico con una voce aperta: la quota si lega alla voce, nessun incasso, la chiuderà la banca', async () => {
    const { alunno, b, segnaSenzaPassare } = await bambinoAlunnoConQuota('bonifico', 100)
    const voce = await voceEsistente(alunno, { importo: 100 })
    await segnaSenzaPassare()
    expect(await passa(b)).toMatchObject({ esito: 'ok', voce_nuova: false, incasso_id: null, pagamento_id: voce })
    expect(await incassiDi(voce)).toHaveLength(0)
    expect((await voci(alunno))[0].stato).toBe('da_pagare')
    expect((await bambino(b)).quota_pagamento_id).toBe(voce)
  })

  it('bonifico con una voce già pagata: bloccata (gia_pagata), come per gli altri metodi', async () => {
    const { alunno, b, segnaSenzaPassare } = await bambinoAlunnoConQuota('bonifico', 100)
    await voceEsistente(alunno, { importo: 100, pagato: 100 })
    await segnaSenzaPassare()
    expect(await passa(b)).toEqual({ esito: 'bloccata', motivo: 'gia_pagata' })
  })

  it('l’entrata di cassa è stata stornata dalla cassa: passarla in contabilità creerebbe soldi che non ci sono', async () => {
    const { alunno, b, segnaSenzaPassare } = await bambinoAlunnoConQuota('contanti', 120)
    const r = await segnaSenzaPassare()
    await db.query(`UPDATE public.cassa_movimenti SET stornato_il = now(), storno_motivo = 'storno dalla cassa' WHERE id = $1`, [r.movimento_id])
    expect(await passa(b)).toEqual({ esito: 'bloccata', motivo: 'entrata_stornata' })
    expect(await voci(alunno)).toHaveLength(0)
    // Se la segreteria segna di nuovo la quota, la cassa riceve una entrata nuova (la vecchia era già stornata: niente doppio storno).
    const contro = (await righe(`SELECT id FROM public.cassa_movimenti WHERE storno_di = $1`, [r.movimento_id])).length
    const ancora = await segna(b, { importo: 120 })
    expect(ancora.passaggio).toMatchObject({ esito: 'ok' })
    expect((await righe(`SELECT id FROM public.cassa_movimenti WHERE storno_di = $1`, [r.movimento_id])).length).toBe(contro)
  })

  it('non pronta: senza alunno, senza quota o con la sola spunta', async () => {
    const senzaAlunno = await nuovoBambino()
    await segna(senzaAlunno, { metodo: 'bonifico' })
    expect(await passa(senzaAlunno)).toEqual({ esito: 'non_pronta' })
    const alunno = uuid('c2000000', 1)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    const senzaQuota = await nuovoBambino({ alunno })
    expect(await passa(senzaQuota)).toEqual({ esito: 'non_pronta' })
    expect((await passa(uuid('f0000000', 98))).esito).toBe('non_trovato')
  })

  it('l’alunno è di un’altra sede: sede_diversa, e non si scrive niente', async () => {
    const b = await nuovoBambino()
    await segna(b, { metodo: 'bonifico' })
    // Il collegamento non lo permetterebbe: lo si forza a mano per provare la difesa del passaggio.
    await db.query(`UPDATE public.crm_bambini SET alunno_id = $2 WHERE id = $1`, [b, ALUNNO_B1])
    expect(await passa(b)).toEqual({ esito: 'sede_diversa' })
    expect(await voci(ALUNNO_B1)).toHaveLength(0)
    await db.query(`UPDATE public.crm_bambini SET alunno_id = NULL WHERE id = $1`, [b])
  })

  it('se l’aggancio dell’entrata non riesce, SI DISFA TUTTO: niente voce, niente incasso, la quota resta in attesa', async () => {
    const alunno = uuid('c2000000', 2)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    const b = await nuovoBambino()
    const r = await segna(b, { importo: 55 })
    await db.query(`UPDATE public.crm_bambini SET alunno_id = $2 WHERE id = $1`, [b, alunno])
    // L'entrata risulta già assorbita da un altro incasso: l'UPDATE dell'aggancio non trova la riga.
    const altra = await una<{ id: string }>(`INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza) VALUES ($1, $2, 'altra', 5, '2026-10-01') RETURNING id`, [ALUNNO_A1, SEDE_A])
    const inc = await una<{ id: string }>(`INSERT INTO public.incassi (pagamento_id, importo, metodo) VALUES ($1, 5, 'contanti') RETURNING id`, [altra.id])
    await db.query(`UPDATE public.cassa_movimenti SET incasso_id = $2 WHERE id = $1`, [r.movimento_id, inc.id])

    await expect(db.query(`SELECT public.crm_quota_passa($1::uuid, $2::uuid)`, [b, SEGRETARIA])).rejects.toThrow(/non si aggancia/)
    expect(await voci(alunno)).toHaveLength(0)
    expect(await bambino(b)).toMatchObject({ quota_stato: 'in_attesa', quota_pagamento_id: null })
    expect(await tipiEvento(b)).not.toContain('quota_in_contabilita')
  })
})

// ── crm_quota_togli ────────────────────────────────────────────────────────────────────────────

describe('crm_quota_togli', () => {
  it('storna l’entrata con lo storno della cassa, azzera la quota e lascia traccia', async () => {
    const b = await nuovoBambino()
    const prima = await entrateDa()
    const r = await segna(b, { importo: 45 })
    expect(await togli(b)).toEqual({ esito: 'ok', stornato: true })
    expect(await entrateDa()).toBeCloseTo(prima, 2)
    const mov = await una<{ stornato_il: string | null; storno_motivo: string | null }>(`SELECT stornato_il::text, storno_motivo FROM public.cassa_movimenti WHERE id = $1`, [r.movimento_id])
    expect(mov.stornato_il).not.toBeNull()
    expect(mov.storno_motivo).toBe("Quota d'iscrizione tolta dal CRM")
    expect(await bambino(b)).toEqual({
      quota_importo: null, quota_metodo: null, quota_anno: null, quota_stato: null, quota_blocco_motivo: null,
      quota_saldata_il: null, quota_segnata_da: null, quota_cassa_movimento_id: null, quota_pagamento_id: null,
      alunno_id: null, quota_saldata: false,
    })
    expect(await tipiEvento(b)).toEqual(['quota_segnata', 'quota_tolta'])
    expect(await datiEvento(b, 'quota_tolta')).toEqual({ bambino_id: b, importo: 45, metodo: 'contanti', anno: 2027, stornato: true })
    const audit = await righe(`SELECT azione FROM public.registro_modifiche WHERE record_id = $1`, [r.movimento_id])
    expect(audit).toEqual([{ azione: 'storno_cassa_movimento' }])
  })

  it('carta e bonifico: nessuno storno, la quota se ne va', async () => {
    const b = await nuovoBambino()
    await segna(b, { metodo: 'bonifico' })
    expect(await togli(b)).toEqual({ esito: 'ok', stornato: false })
    expect((await bambino(b)).quota_stato).toBeNull()
  })

  it('la vecchia spunta si toglie e azzera anche quota_saldata', async () => {
    const demo = await una<{ id: string; quota_saldata: boolean }>(`SELECT id, quota_saldata FROM public.crm_bambini WHERE nome = 'Bimbo Demo'`)
    await db.query(`UPDATE public.crm_bambini SET quota_stato = 'senza_importo', quota_saldata = true WHERE id = $1`, [demo.id])
    expect(await togli(demo.id)).toEqual({ esito: 'ok', stornato: false })
    expect(await bambino(demo.id)).toMatchObject({ quota_stato: null, quota_saldata: false })
  })

  it('una quota già in contabilità non si toglie dal CRM; senza quota è un’operazione vuota che si può ripetere', async () => {
    const alunno = uuid('c3000000', 1)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    const b = await nuovoBambino({ alunno })
    await segna(b, { metodo: 'bonifico' })
    const prima = await bambino(b)
    expect(await togli(b)).toMatchObject({ esito: 'in_contabilita' })
    expect(await bambino(b)).toEqual(prima)
    expect(await segna(b)).toMatchObject({ esito: 'in_contabilita' })
    expect(await bambino(b)).toEqual(prima)

    const vuoto = await nuovoBambino()
    expect(await togli(vuoto)).toEqual({ esito: 'ok', stornato: false })
    expect(await tipiEvento(vuoto)).toEqual([])
    expect((await togli(uuid('f0000000', 97))).esito).toBe('non_trovato')
  })
})

// ── crm_aggancia_alunno ────────────────────────────────────────────────────────────────────────

describe('crm_aggancia_alunno', () => {
  it('l’alunno deve essere della stessa sede, e un bambino non cambia alunno', async () => {
    const b = await nuovoBambino()
    expect(await aggancia(b, ALUNNO_B1)).toEqual({ esito: 'sede_diversa' })
    expect(await aggancia(b, uuid('f0000000', 96))).toEqual({ esito: 'sede_diversa' })
    expect((await bambino(b)).alunno_id).toBeNull()

    const alunno = uuid('c4000000', 1)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    expect(await aggancia(b, alunno)).toEqual({ esito: 'ok', collegato: true, passaggio: null })
    expect(await aggancia(b, ALUNNO_A2)).toEqual({ esito: 'gia_collegato_altro' })
    expect((await bambino(b)).alunno_id).toBe(alunno)
    expect(await aggancia(b, alunno)).toEqual({ esito: 'ok', collegato: false, passaggio: null })
    expect((await aggancia(uuid('f0000000', 95), alunno)).esito).toBe('non_trovato')
  })

  it('lo stesso alunno su due bambini: la 23505 diventa un esito, non un errore, e il secondo non cambia', async () => {
    const alunno = uuid('c4000000', 2)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    const primo = await nuovoBambino()
    const secondo = await nuovoBambino()
    await segna(secondo, { metodo: 'bonifico' })
    expect((await aggancia(primo, alunno)).esito).toBe('ok')
    expect(await aggancia(secondo, alunno)).toEqual({ esito: 'alunno_gia_collegato' })
    expect(await bambino(secondo)).toMatchObject({ alunno_id: null, quota_stato: 'in_attesa' })
    expect(await tipiEvento(secondo)).toEqual(['quota_segnata'])
    expect(await voci(alunno)).toHaveLength(0)
  })

  it('una quota bloccata si riprova all’aggancio ripetuto', async () => {
    const alunno = uuid('c4000000', 3)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, SEDE_A])
    const b = await nuovoBambino()
    await segna(b, { metodo: 'bonifico', importo: 100 })
    await voceEsistente(alunno, { importo: 100, pagato: 100 })
    const a = await aggancia(b, alunno)
    expect(a).toMatchObject({ esito: 'ok', collegato: true, passaggio: { esito: 'bloccata', motivo: 'gia_pagata' } })
    // La segreteria sistema la voce in contabilità; poi riprova con lo stesso aggancio.
    await db.query(`DELETE FROM public.incassi WHERE pagamento_id IN (SELECT id FROM public.pagamenti WHERE alunno_id = $1)`, [alunno])
    const ripetuto = await aggancia(b, alunno)
    expect(ripetuto).toMatchObject({ esito: 'ok', collegato: false, passaggio: { esito: 'ok', voce_nuova: false } })
    expect((await bambino(b)).quota_stato).toBe('in_contabilita')
  })
})

// ── crm_salva_settimana ────────────────────────────────────────────────────────────────────────

describe('crm_salva_settimana', () => {
  /** Il lunedì della settimana in corso a Roma, spostato di `settimane` settimane. */
  async function lunedi(settimane: number): Promise<string> {
    return (
      await una<{ d: string }>(`SELECT (date_trunc('week', now() AT TIME ZONE 'Europe/Rome')::date + ($1::int * 7))::text AS d`, [settimane])
    ).d
  }
  const fascia = (giorno: number, da: string, a: string, durata = 45) => ({ giorno_settimana: giorno, ora_inizio: da, ora_fine: a, durata_slot_min: durata })

  it('rifiuta un giorno che non è lunedì, una settimana passata e fasce che si toccano', async () => {
    const corrente = await lunedi(0)
    const martedi = (await una<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [corrente])).d
    expect(await salva(SEDE_A, SEGRETARIA, martedi, [])).toEqual({ esito: 'settimana_non_valida' })
    expect(await salva(SEDE_A, SEGRETARIA, await lunedi(-1), [])).toEqual({ esito: 'settimana_passata' })
    expect(await salva(SEDE_A, SEGRETARIA, '2020-01-06', [])).toEqual({ esito: 'settimana_passata' })
    expect(await salva(SEDE_A, SEGRETARIA, await lunedi(2), [fascia(1, '09:00', '11:00'), fascia(1, '10:30', '12:00')])).toEqual({
      esito: 'fasce_sovrapposte',
    })
    // Due fasce identiche si toccano; due fasce attaccate (11:00-11:00) no; giorni diversi no.
    expect((await salva(SEDE_A, SEGRETARIA, await lunedi(2), [fascia(1, '09:00', '11:00'), fascia(1, '09:00', '11:00')])).esito).toBe('fasce_sovrapposte')
    expect((await salva(SEDE_A, COLLEGA, await lunedi(2), [fascia(1, '09:00', '11:00'), fascia(1, '11:00', '12:00'), fascia(2, '09:30', '10:30')])).esito).toBe('ok')
    // Niente è stato scritto dai rifiuti.
    expect((await righe(`SELECT id FROM public.crm_settimane WHERE settimana IN ($1, $2)`, [martedi, await lunedi(-1)])).length).toBe(0)
  })

  it('la settimana in corso si può modificare, quella dopo anche: una scrittura sola, le fasce si sostituiscono', async () => {
    const w = await lunedi(0)
    const r1 = await salva(SEDE_A, SEGRETARIA, w, [fascia(2, '09:00', '12:00')])
    expect(r1.esito).toBe('ok')
    const r2 = await salva(SEDE_A, SEGRETARIA, w, [fascia(3, '10:00', '11:00', 30), fascia(5, '15:00', '16:00')], COLLEGA)
    expect(r2).toEqual({ esito: 'ok', settimana_id: r1.settimana_id })
    const fasce = await righe<{ giorno_settimana: number; durata_slot_min: number }>(
      `SELECT giorno_settimana, durata_slot_min FROM public.crm_fasce WHERE settimana_id = $1 ORDER BY giorno_settimana`,
      [r1.settimana_id],
    )
    expect(fasce).toEqual([
      { giorno_settimana: 3, durata_slot_min: 30 },
      { giorno_settimana: 5, durata_slot_min: 45 },
    ])
    const testata = await una<{ aggiornata_da: string; scuola_id: string }>(`SELECT aggiornata_da, scuola_id FROM public.crm_settimane WHERE id = $1`, [r1.settimana_id])
    expect(testata).toEqual({ aggiornata_da: COLLEGA, scuola_id: SEDE_A })
    // Le fasce portano la sede della loro settimana (chiave composta).
    expect((await righe(`SELECT 1 FROM public.crm_fasce f JOIN public.crm_settimane s ON s.id = f.settimana_id WHERE f.settimana_id = $1 AND f.scuola_id <> s.scuola_id`, [r1.settimana_id])).length).toBe(0)

    const dopo = await salva(SEDE_A, SEGRETARIA, await lunedi(1), [fascia(2, '09:00', '12:00')])
    expect(dopo.settimana_id).not.toBe(r1.settimana_id)
    // Preparare la settimana dopo non tocca quella in corso.
    expect((await righe(`SELECT id FROM public.crm_fasce WHERE settimana_id = $1`, [r1.settimana_id])).length).toBe(2)
  })

  it('una lista vuota è una settimana volutamente vuota; la sede (utente nullo) ha UNA testata per settimana', async () => {
    const w = await lunedi(3)
    const s1 = await salva(SEDE_A, null, w, [fascia(1, '09:00', '10:00')])
    const s2 = await salva(SEDE_A, null, w, [])
    expect(s2.settimana_id).toBe(s1.settimana_id)
    expect((await righe(`SELECT id FROM public.crm_settimane WHERE scuola_id = $1 AND utente_id IS NULL AND settimana = $2`, [SEDE_A, w])).length).toBe(1)
    expect((await righe(`SELECT id FROM public.crm_fasce WHERE settimana_id = $1`, [s1.settimana_id])).length).toBe(0)
    // Una persona e la sede sono proprietari diversi.
    const persona = await salva(SEDE_A, SEGRETARIA, w, [fascia(1, '09:00', '10:00')])
    expect(persona.settimana_id).not.toBe(s1.settimana_id)
    // Un'altra sede è un'altra testata.
    const altra = await salva(SEDE_B, null, w, [fascia(1, '09:00', '10:00')])
    expect(altra.settimana_id).not.toBe(s1.settimana_id)
  })

  it('rifiuta gli argomenti che non può leggere (22023) e non lascia testate a metà', async () => {
    const w = await lunedi(4)
    const chiama = (fasce: string | null) =>
      db.query(`SELECT public.crm_salva_settimana($1::uuid, $2::uuid, $3::date, $4::jsonb, $5::uuid)`, [SEDE_A, SEGRETARIA, w, fasce, SEGRETARIA])
    await expect(chiama(null)).rejects.toMatchObject({ code: '22023' })
    await expect(chiama('{"giorno_settimana":1}')).rejects.toMatchObject({ code: '22023' })
    // Una fascia che il database non accetta (fine prima dell'inizio) disfa anche la testata.
    await expect(chiama(JSON.stringify([fascia(1, '12:00', '09:00')]))).rejects.toMatchObject({ code: '23514' })
    expect((await righe(`SELECT id FROM public.crm_settimane WHERE settimana = $1`, [w])).length).toBe(0)
  })
})

// ── I report ────────────────────────────────────────────────────────────────────────────────────

describe('i report di cassa non contano un movimento assorbito', () => {
  it('conteggio, aggregato e dettaglio: l’entrata assorbita sparisce dai movimenti e resta l’incasso, il totale è lo stesso', async () => {
    const sede = SEDE_B
    const giorno = '2026-09-15'
    const alunno = uuid('c5000000', 1)
    await db.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [alunno, sede])
    const b = await nuovoBambino({ sede })
    await segna(b, { importo: 77, giorno })
    const filtro = [[sede], giorno, giorno]
    const prima = await una<{ r: { totali: { entrate: number } } }>(`SELECT public.conteggio_cassa_provenienza($1::uuid[], $2::date, $3::date) AS r`, filtro)
    const aggPrima = await una<{ r: { controllo: { entrate: number } } }>(`SELECT public.report_cassa_aggregato($1::uuid[], $2::date, $3::date, NULL) AS r`, filtro)
    expect(prima.r.totali.entrate).toBeCloseTo(77, 2)
    expect(aggPrima.r.controllo.entrate).toBeCloseTo(0, 2) // l'aggregato conta gli incassi delle voci: ancora nessuno

    await aggancia(b, alunno)
    const dopo = await una<{ r: { totali: { entrate: number } } }>(`SELECT public.conteggio_cassa_provenienza($1::uuid[], $2::date, $3::date) AS r`, filtro)
    const aggDopo = await una<{ r: { controllo: { entrate: number } } }>(`SELECT public.report_cassa_aggregato($1::uuid[], $2::date, $3::date, NULL) AS r`, filtro)
    expect(dopo.r.totali.entrate).toBeCloseTo(77, 2) // lo stesso giorno, lo stesso totale: ora lo porta l'incasso
    expect(aggDopo.r.controllo.entrate).toBeCloseTo(77, 2) // ora c'è l'incasso della voce

    // Il dettaglio delle entrate mostra l'incasso una volta sola (i movimenti di cassa di tipo entrata non vi compaiono).
    const dettaglio = await una<{ r: { conteggio: number; totale: number } }>(
      `SELECT public.report_cassa_dettaglio($1::uuid[], 'entrata', $2::date, $3::date, NULL, false, NULL, 50, 0) AS r`,
      filtro,
    )
    expect(dettaglio.r).toMatchObject({ conteggio: 1, totale: 77 })
  })
})
