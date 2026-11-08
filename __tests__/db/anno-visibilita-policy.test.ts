import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import {
  applicaPr2,
  creaDbAnnoPr2,
  SCHEMA_AVVISI_CHAT_VOCI_GENITORE,
  SCHEMA_BASE,
  SCHEMA_GALLERIA_GENITORE,
  SCHEMA_LEGAMI_GENITORE,
  SCHEMA_NEWS_GENITORE,
} from '../helpers/schema-anno-pglite'

/**
 * PR 4.4 · COMPITO 4.4.4 · LE REGOLE DI ACCESSO DEL GENITORE E IL BROADCAST DELLA CHAT (migrazione M44b).
 *
 * Le funzioni di M44a dicono che cosa vede una famiglia; qui lo dicono anche le regole di accesso, cioè quello che esce da
 * una lettura fatta con la sessione del genitore. Le prove girano con `SET ROLE authenticated` e il token di ciascun genitore
 * del seme, sulle regole vere: PRIMA di M44b il banco ha quelle di oggi, con il testo di produzione scritto qui sotto e non
 * letto dalla fotografia, che dopo il merge si rigenera. `PRIMA` sono le letture fatte con quelle regole: ogni differenza
 * viene da M44b, e ciò che non doveva cambiare si confronta invece di riscriverlo a mano.
 *
 * IL BANCO COME LA PRODUZIONE. `utenti`, `utenti_scuole`, `sections`, `parents`, `student_parents`,
 * `legame_genitori_alunni` e `frequenze` hanno la RLS accesa e nessuna regola per `authenticated`: una sottoquery su di loro,
 * dentro una regola, non torna niente. Sono i casi `staff` e `grado`: in produzione oggi quei due rami non aprono niente.
 *
 * Calendario fisso (`creaAnniFissi`): 2026/27 corrente. Il confronto con OGGI riguarda solo l'ingresso (01/09/2026, passato) e
 * un `visibile_dal` lontano. Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_B = '22222222-2222-4222-8222-222222222223'
const SEZ_1 = '55555555-5555-4555-8555-555555555551'
const SEZ_2 = '55555555-5555-4555-8555-555555555552'
const SEZ_B = '55555555-5555-4555-8555-555555555553'

const GEN_LEGAME = '99999999-9999-4999-8999-999999999991'
const GEN_PONTE = '99999999-9999-4999-8999-999999999992'
const GEN_ALTRA_SEDE = '99999999-9999-4999-8999-999999999993'
const GEN_RITIRATO = '99999999-9999-4999-8999-999999999994'
const GEN_ESTRANEO = '99999999-9999-4999-8999-999999999995'
/** Secondo genitore di `FIGLIO_PONTE`: ha la sua quota della voce divisa. */
const GEN_ALTRO = '99999999-9999-4999-8999-999999999996'

const FIGLIO_1 = '11111111-1111-4111-8111-111111111111'
const FIGLIO_2 = '11111111-1111-4111-8111-111111111112'
const FIGLIO_PONTE = '11111111-1111-4111-8111-111111111113'
const FIGLIO_B = '11111111-1111-4111-8111-111111111114'
const FIGLIO_RITIRATO = '11111111-1111-4111-8111-111111111115'

const PONTE_1 = '88888888-8888-4888-8888-888888888881'
const PONTE_2 = '88888888-8888-4888-8888-888888888882'
const PONTE_3 = '88888888-8888-4888-8888-888888888883'

const DOC_1 = '77777777-7777-4777-8777-777777777771'
const DOC_2 = '77777777-7777-4777-8777-777777777772'
const SEGRETERIA = '77777777-7777-4777-8777-777777777773'
/** Ha la sua sede in `utenti` e la seconda in `utenti_scuole`. */
const DIREZIONE = '77777777-7777-4777-8777-777777777774'

const FAMIGLIE = { GEN_LEGAME, GEN_PONTE, GEN_ALTRA_SEDE, GEN_RITIRATO, GEN_ESTRANEO, GEN_ALTRO }
const PERSONALE = { DOC_1, DOC_2, SEGRETERIA, DIREZIONE }
const TABELLE = ['galleria_media_v2', 'chat_threads', 'chat_messages', 'pagamenti', 'pagamenti_quote', 'news_posts', 'incassi'] as const
type Tabella = (typeof TABELLE)[number]

/** Le colonne che il banco minimo non ha, e `current_parent_student_ids()` con il corpo vero del baseline. */
const SCHEMA_CHAT_E_PERSONALE = `
  ALTER TABLE public.chat_messages
    ADD COLUMN sender_id uuid,
    ADD COLUMN content text,
    ADD COLUMN read_at timestamptz,
    ADD COLUMN delivered_at timestamptz;
  ALTER TABLE public.utenti ADD COLUMN scuola_id uuid;
  CREATE TABLE public.utenti_scuole (
    utente_id uuid NOT NULL,
    scuola_id uuid NOT NULL,
    PRIMARY KEY (utente_id, scuola_id)
  );
  CREATE TABLE public.incassi (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
    quota_id uuid REFERENCES public.pagamenti_quote(id),
    importo numeric(10,2) NOT NULL DEFAULT 10
  );
  CREATE FUNCTION public.current_parent_student_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $f$
    SELECT sp.student_id FROM public.student_parents sp JOIN public.parents p ON p.id = sp.parent_id WHERE p.auth_user_id = auth.uid()
  $f$;
`

/** Lo schema `realtime` come in produzione (catalogo del 12/10/2026), con il corpo vero di `realtime.send`. */
const SCHEMA_REALTIME = `
  CREATE SCHEMA realtime;
  GRANT USAGE ON SCHEMA realtime TO anon, authenticated;
  CREATE TABLE realtime.messages (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp NOT NULL DEFAULT now(),
    inserted_at timestamp NOT NULL DEFAULT now(),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    PRIMARY KEY (id, inserted_at)
  );
  ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
  GRANT SELECT, INSERT, UPDATE ON realtime.messages TO anon, authenticated;
  CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $t$
    SELECT nullif(current_setting('realtime.topic', true), '')::text
  $t$;
  GRANT EXECUTE ON FUNCTION realtime.topic() TO anon, authenticated;
  CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT false)
  RETURNS void LANGUAGE plpgsql AS $send$
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

/**
 * L'ACCESSO DI OGGI. La RLS accesa dov'è accesa in produzione, i permessi di `20260909112234_chat_permessi_stretti.sql`, e il
 * testo delle regole letto da `pg_policies` il 07/11/2026. Scritto qui e non letto dalla fotografia, che dopo il merge cambia.
 */
const ACCESSO_DI_OGGI = `
  ALTER TABLE public.galleria_media_v2 ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.pagamenti ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.pagamenti_quote ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.incassi ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.news_posts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.alunni ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.utenti ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.utenti_scuole ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.parents ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.student_parents ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.legame_genitori_alunni ENABLE ROW LEVEL SECURITY;

  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.chat_threads FROM authenticated;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.chat_messages FROM authenticated;
  REVOKE ALL ON TABLE public.chat_threads FROM anon;
  REVOKE ALL ON TABLE public.chat_messages FROM anon;

  CREATE POLICY "parent read alunni figli (parents space)" ON public.alunni FOR SELECT TO authenticated
    USING (id IN (SELECT current_parent_student_ids() AS current_parent_student_ids));

  CREATE POLICY chat_threads_select_participant ON public.chat_threads FOR SELECT TO authenticated
    USING ((teacher_id = (SELECT auth.uid() AS uid)) OR (parent_id = (SELECT auth.uid() AS uid))
      OR (parent_id IN (SELECT parents.id FROM parents WHERE (parents.auth_user_id = (SELECT auth.uid() AS uid)))));

  CREATE POLICY chat_messages_select_participant ON public.chat_messages FOR SELECT TO authenticated
    USING (thread_id IN (SELECT chat_threads.id FROM chat_threads
      WHERE ((chat_threads.teacher_id = (SELECT auth.uid() AS uid)) OR (chat_threads.parent_id = (SELECT auth.uid() AS uid))
        OR (chat_threads.parent_id IN (SELECT parents.id FROM parents WHERE (parents.auth_user_id = (SELECT auth.uid() AS uid)))))));

  CREATE POLICY "parent read galleria figli (parents space)" ON public.galleria_media_v2 FOR SELECT TO authenticated
    USING ((eliminato_il IS NULL)
      AND (EXISTS (SELECT 1 FROM alunni a WHERE ((a.id = ANY (ARRAY(SELECT current_parent_student_ids() AS current_parent_student_ids)))
        AND (a.scuola_id = galleria_media_v2.scuola_id))))
      AND ((is_broadcast = true) OR (tag_students && ARRAY(SELECT current_parent_student_ids() AS current_parent_student_ids))));

  CREATE POLICY "auth read news_posts" ON public.news_posts FOR SELECT TO authenticated
    USING ((EXISTS (SELECT 1 FROM utenti u WHERE ((u.id = (SELECT auth.uid() AS uid)) AND ((u.ruolo)::text <> 'genitore'::text)
        AND ((news_posts.scuola_id IS NULL) OR (news_posts.scuola_id = u.scuola_id)
          OR (news_posts.scuola_id IN (SELECT us.scuola_id FROM utenti_scuole us WHERE (us.utente_id = (SELECT auth.uid() AS uid))))))))
      OR ((stato = 'pubblicata'::text) AND (EXISTS (SELECT 1 FROM alunni a
        WHERE ((a.id IN (SELECT current_parent_student_ids() AS current_parent_student_ids
                         UNION SELECT lga.alunno_id FROM legame_genitori_alunni lga WHERE (lga.genitore_id = (SELECT auth.uid() AS uid))))
          AND ((news_posts.scuola_id IS NULL) OR (news_posts.scuola_id = a.scuola_id))
          AND ((news_posts.target_scope = 'globale'::text)
            OR ((news_posts.target_scope = 'classi'::text) AND ((a.classe_sezione)::text = ANY (news_posts.target_classes)))
            OR ((news_posts.target_scope = 'grado'::text) AND (EXISTS (SELECT 1 FROM sections s
              WHERE ((s.id = a.section_id) AND (s.school_type = ANY (news_posts.target_gradi))))))))))));
  CREATE POLICY "service news_posts" ON public.news_posts TO service_role USING (true) WITH CHECK (true);

  CREATE POLICY "parent read pagamenti figli (parents space)" ON public.pagamenti FOR SELECT TO authenticated
    USING (alunno_id IN (SELECT current_parent_student_ids() AS current_parent_student_ids));
  CREATE POLICY "service pagamenti" ON public.pagamenti TO service_role USING (true) WITH CHECK (true);

  CREATE POLICY "parent read own quota" ON public.pagamenti_quote FOR SELECT TO authenticated
    USING (adult_id = (SELECT auth.uid() AS uid));
  CREATE POLICY "parent read quote figli (parents space)" ON public.pagamenti_quote FOR SELECT TO authenticated
    USING (pagamento_id IN (SELECT pg.id FROM pagamenti pg WHERE (pg.alunno_id IN (SELECT current_parent_student_ids() AS current_parent_student_ids))));

  CREATE POLICY "parent read incassi" ON public.incassi FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM pagamenti p WHERE ((p.id = incassi.pagamento_id)
      AND (p.alunno_id IN (SELECT legame_genitori_alunni.alunno_id FROM legame_genitori_alunni
        WHERE (legame_genitori_alunni.genitore_id = (SELECT auth.uid() AS uid))))
      AND ((p.tipo <> 'split'::pagamento_tipo) OR (incassi.quota_id IN (SELECT q.id FROM pagamenti_quote q
        WHERE ((q.pagamento_id = p.id) AND (q.adult_id = (SELECT auth.uid() AS uid)))))))));
  CREATE POLICY "parent read incassi figli (parents space)" ON public.incassi FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM pagamenti pg WHERE ((pg.id = incassi.pagamento_id)
      AND (pg.alunno_id IN (SELECT current_parent_student_ids() AS current_parent_student_ids)))));
`

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const fileMigrazione = (suffisso: string) => {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`manca supabase/migrations/*${suffisso}`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}

/** Dopo `SCHEMA_BASE` e le colonne dell'anno: lo schema, il broadcast di oggi, l'accesso di oggi. */
async function preparaAccesso(d: PGlite) {
  await d.exec(SCHEMA_LEGAMI_GENITORE)
  await d.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
  await d.exec(SCHEMA_CHAT_E_PERSONALE)
  await d.exec(SCHEMA_REALTIME)
  await d.exec(fileMigrazione('_chat_broadcast_privato.sql'))
  await d.exec(ACCESSO_DI_OGGI)
}

let db: PGlite

const prova = (nome: string, fn: () => Promise<void>) => it(nome, fn, 60_000)

async function inRollback(fn: () => Promise<void>) {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}

/** Il ruolo e il token, in un savepoint: finito `fn` si torna a chi eravamo. Va chiamata dentro una transazione. */
async function comeChi<T>(utente: string | null, fn: () => Promise<T>, ruolo = 'authenticated'): Promise<T> {
  await db.exec('SAVEPOINT come_chi')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(utente ? { sub: utente, role: ruolo } : { role: ruolo })])
    await db.exec(`SET LOCAL ROLE ${ruolo}`)
    return await fn()
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT come_chi')
    await db.exec('RELEASE SAVEPOINT come_chi')
  }
}

async function codiceErrore(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params)
    return 'nessun-errore'
  } catch (e) {
    return (e as { code?: string }).code ?? 'senza-codice'
  }
}

async function una<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}

/** Ogni uuid del seme ha un nome: il rosso si legge, e una riga doppia resta doppia. */
const ETICHETTE = new Map<string, string>(
  Object.entries({ ...FAMIGLIE, ...PERSONALE, PONTE_1, PONTE_2, PONTE_3 }).map(([nome, id]) => [id, nome]),
)
const nomi = (ids: string[]) => ids.map((i) => ETICHETTE.get(i) ?? `sconosciuto:${i}`).sort()

async function idDi(tabella: Tabella, colonna = 'id'): Promise<string[]> {
  const r = await db.query<{ id: string }>(`SELECT ${colonna} AS id FROM public.${tabella}`)
  return nomi(r.rows.map((x) => x.id))
}

const vede = (utente: string | null, tabella: Tabella, ruolo?: string) => comeChi(utente, () => idDi(tabella), ruolo)

type Letture = Record<string, string[]>

/** Che cosa legge ciascuno, con le regole che ci sono in questo momento. */
async function letture(): Promise<Letture> {
  const out: Letture = {}
  for (const [nome, id] of Object.entries({ ...FAMIGLIE, ...PERSONALE })) {
    for (const t of TABELLE) out[`${t} · ${nome}`] = await vede(id, t)
  }
  return out
}

/** Le stesse letture con la RLS spenta sulle tabelle che in produzione la spengono ai rami `staff` e `grado`. */
const SENZA_RLS_SUI_RAMI = `
  ALTER TABLE public.utenti DISABLE ROW LEVEL SECURITY;
  ALTER TABLE public.utenti_scuole DISABLE ROW LEVEL SECURITY;
  ALTER TABLE public.sections DISABLE ROW LEVEL SECURITY;
`

type RigaRegola = { schemaname: string; tablename: string; policyname: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }

const regole = async (d: PGlite = db) =>
  (await d.query<RigaRegola>(
    `SELECT schemaname::text, tablename::text, policyname::text, cmd, roles::text[] AS roles, qual, with_check
       FROM pg_policies ORDER BY schemaname, tablename, policyname`)).rows

let PRIMA: Letture
let PRIMA_SENZA_RLS: Letture
let PRIMA_REGOLE: RigaRegola[]
let PRIMA_SERVIZIO: Record<string, string[]>

let ANNO_2627: string
let ATTIVO_B: string

const F: Record<string, string> = {}
const T: Record<string, string> = {}
const V: Record<string, string> = {}
const N: Record<string, string> = {}

async function foto(nome: string, d: { sede?: string; tag?: string[]; broadcast?: boolean; target?: string[]; eliminata?: boolean }) {
  F[nome] = await una<string>(
    `INSERT INTO public.galleria_media_v2 (scuola_id, tag_students, is_broadcast, target_section_ids, created_at, eliminato_il)
     VALUES ($1, $2, $3, $4, '2026-10-20T12:00:00+02:00', $5) RETURNING id`,
    [d.sede ?? SEDE, d.tag ?? [], d.broadcast ?? false, d.target ?? null, d.eliminata ? '2026-10-30T10:00:00Z' : null])
  ETICHETTE.set(F[nome], nome)
}

async function thread(nome: string, docente: string, genitore: string, figlio: string) {
  T[nome] = await una<string>(
    `INSERT INTO public.chat_threads (teacher_id, parent_id, student_id) VALUES ($1, $2, $3) RETURNING id`, [docente, genitore, figlio])
  ETICHETTE.set(T[nome], nome)
  const m = await una<string>(
    `INSERT INTO public.chat_messages (thread_id, sender_id, content) VALUES ($1, $2, 'Testo di prova') RETURNING id`, [T[nome], docente])
  ETICHETTE.set(m, `MSG_${nome}`)
}

async function voce(nome: string, d: { alunno: string; sede?: string; competenza?: string; tipo?: string; visibileDal?: string }) {
  const competenza = d.competenza ?? '2026-10-01'
  V[nome] = await una<string>(
    `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, periodo_competenza, visibile_dal, tipo)
     VALUES ($1, $2, 'Voce di prova', 100, $3, $3, $4, $5) RETURNING id`,
    [d.alunno, d.sede ?? SEDE, competenza, d.visibileDal ?? null, d.tipo ?? 'singolo'])
  ETICHETTE.set(V[nome], nome)
}

async function quota(nome: string, voceId: string, adulto: string): Promise<string> {
  const id = await una<string>(`INSERT INTO public.pagamenti_quote (pagamento_id, adult_id, importo) VALUES ($1, $2, 50) RETURNING id`, [voceId, adulto])
  ETICHETTE.set(id, nome)
  return id
}

async function incasso(nome: string, voceId: string, quotaId: string | null = null) {
  const id = await una<string>(`INSERT INTO public.incassi (pagamento_id, quota_id) VALUES ($1, $2) RETURNING id`, [voceId, quotaId])
  ETICHETTE.set(id, nome)
}

async function news(nome: string, d: { sede?: string | null; stato?: string; scope?: string; classi?: string[]; gradi?: string[] }) {
  N[nome] = await una<string>(
    `INSERT INTO public.news_posts (scuola_id, stato, target_scope, target_classes, target_gradi, author_id, created_at)
     VALUES ($1, $2, $3, $4, $5::text[]::public.school_type_enum[], $6, '2026-10-20T12:00:00+02:00') RETURNING id`,
    [d.sede === undefined ? SEDE : d.sede, d.stato ?? 'pubblicata', d.scope ?? 'globale', d.classi ?? null, d.gradi ?? null, SEGRETERIA])
  ETICHETTE.set(N[nome], nome)
}

async function seme() {
  const anni = await db.query<{ anno_inizio: number; id: string; anno_id: string; scuola_id: string }>(
    `SELECT y.anno_inizio, s.id, s.anno_id, s.scuola_id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
  const riga = (sede: string, n: number) => anni.rows.find((x) => x.scuola_id === sede && x.anno_inizio === n)!
  ANNO_2627 = riga(SEDE, 2026).id
  ATTIVO_B = riga(SEDE_B, 2026).id

  const sezione = (id: string, sede: string, nome: string, grado: string) =>
    db.query(`INSERT INTO public.sections (id, scuola_id, name, anno_id, school_type) VALUES ($1, $2, $3, $4, $5)`, [id, sede, nome, riga(sede, 2026).anno_id, grado])
  await sezione(SEZ_1, SEDE, 'Girasoli', 'infanzia')
  await sezione(SEZ_2, SEDE, 'Margherite', 'primaria')
  await sezione(SEZ_B, SEDE_B, 'Tulipani', 'infanzia')

  const persone: Array<[string, string, string]> = [
    [DOC_1, 'educator', SEDE], [DOC_2, 'educator', SEDE], [SEGRETERIA, 'segreteria', SEDE], [DIREZIONE, 'coordinator', SEDE],
    [GEN_LEGAME, 'genitore', SEDE], [GEN_PONTE, 'genitore', SEDE], [GEN_ALTRA_SEDE, 'genitore', SEDE_B],
    [GEN_RITIRATO, 'genitore', SEDE], [GEN_ESTRANEO, 'genitore', SEDE], [GEN_ALTRO, 'genitore', SEDE],
  ]
  for (const [id, ruolo, sede] of persone) await db.query(`INSERT INTO public.utenti (id, ruolo, scuola_id) VALUES ($1, $2, $3)`, [id, ruolo, sede])
  await db.query(`INSERT INTO public.utenti_scuole (utente_id, scuola_id) VALUES ($1, $2)`, [DIREZIONE, SEDE_B])
  await db.query(`INSERT INTO public.utenti_sezioni (utente_id, section_id) VALUES ($1, $2), ($3, $4)`, [DOC_1, SEZ_1, DOC_2, SEZ_2])

  // Le frequenze le scrive il seme: lo specchio resta spento mentre nascono gli alunni, come in `anno-visibilita-genitore.test.ts`.
  await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = false`)
  const alunno = (id: string, sede: string, sez: string, classe: string) =>
    db.query(`INSERT INTO public.alunni (id, scuola_id, section_id, classe_sezione) VALUES ($1, $2, $3, $4)`, [id, sede, sez, classe])
  await alunno(FIGLIO_1, SEDE, SEZ_1, 'Girasoli')
  await alunno(FIGLIO_2, SEDE, SEZ_2, 'Margherite')
  await alunno(FIGLIO_PONTE, SEDE, SEZ_2, 'Margherite')
  await alunno(FIGLIO_B, SEDE_B, SEZ_B, 'Tulipani')
  await alunno(FIGLIO_RITIRATO, SEDE, SEZ_1, 'Girasoli')
  await db.exec(`UPDATE public.anno_regole SET specchio_alunni_attivo = true`)

  // Due strade per il legame, come in produzione: quella di oggi delle regole (`parents`) e l'altra.
  await db.query(`INSERT INTO public.legame_genitori_alunni (genitore_id, alunno_id) VALUES ($1, $2), ($1, $3), ($4, $5)`,
    [GEN_LEGAME, FIGLIO_1, FIGLIO_2, GEN_ALTRO, FIGLIO_PONTE])
  await db.query(`INSERT INTO public.parents (id, auth_user_id) VALUES ($1, $2), ($3, $4), ($5, $6)`,
    [PONTE_1, GEN_PONTE, PONTE_2, GEN_ALTRA_SEDE, PONTE_3, GEN_RITIRATO])
  await db.query(`INSERT INTO public.student_parents (student_id, parent_id) VALUES ($1, $2), ($3, $4), ($5, $6)`,
    [FIGLIO_PONTE, PONTE_1, FIGLIO_B, PONTE_2, FIGLIO_RITIRATO, PONTE_3])

  const frequenza = (figlio: string, anno: string, sez: string, stato = 'iscritto', uscita: string | null = null) =>
    db.query(
      `INSERT INTO public.frequenze (alunno_id, anno_sede_id, section_id, stato, data_ingresso, data_uscita, origine, creata_il)
       VALUES ($1, $2, $3, $4, '2026-09-01', $5, 'recupero', '2026-11-07T10:00:00+01:00')`, [figlio, anno, sez, stato, uscita])
  await frequenza(FIGLIO_1, ANNO_2627, SEZ_1)
  await frequenza(FIGLIO_2, ANNO_2627, SEZ_2)
  await frequenza(FIGLIO_PONTE, ANNO_2627, SEZ_2)
  await frequenza(FIGLIO_B, ATTIVO_B, SEZ_B)
  await frequenza(FIGLIO_RITIRATO, ANNO_2627, SEZ_1, 'ritirato', '2026-10-30')

  const storico = (figlio: string, sez: string, sede = SEDE) =>
    db.query(`INSERT INTO public.alunni_classi_storico (alunno_id, scuola_id, section_id, dal, fonte) VALUES ($1, $2, $3, '2026-09-01', 'attuale')`, [figlio, sede, sez])
  await storico(FIGLIO_1, SEZ_1)
  await storico(FIGLIO_2, SEZ_2)
  await storico(FIGLIO_PONTE, SEZ_2)
  await storico(FIGLIO_B, SEZ_B, SEDE_B)
  await storico(FIGLIO_RITIRATO, SEZ_1)

  await foto('F_1', { tag: [FIGLIO_1] })
  await foto('F_2', { tag: [FIGLIO_2] })
  await foto('F_FRATELLI', { tag: [FIGLIO_1, FIGLIO_2] })
  await foto('F_CON_PONTE', { tag: [FIGLIO_1, FIGLIO_PONTE] })
  await foto('F_SEZ_1', { target: [SEZ_1] })
  await foto('F_SEZ_2', { target: [SEZ_2] })
  await foto('F_SEDE', { broadcast: true })
  await foto('F_B', { sede: SEDE_B, tag: [FIGLIO_B] })
  await foto('F_RITIRATO', { tag: [FIGLIO_RITIRATO] })
  await foto('F_CESTINO', { tag: [FIGLIO_1], eliminata: true })

  await thread('T_1', DOC_1, GEN_LEGAME, FIGLIO_1)
  await thread('T_NON_ASSEGNATO', DOC_2, GEN_LEGAME, FIGLIO_1)
  await thread('T_PONTE', DOC_2, GEN_PONTE, FIGLIO_PONTE)
  await thread('T_SCHEDA', DOC_1, PONTE_1, FIGLIO_PONTE)
  await thread('T_RITIRATO', DOC_1, GEN_RITIRATO, FIGLIO_RITIRATO)

  await voce('V_1', { alunno: FIGLIO_1 })
  await voce('V_DIVISA_SUA', { alunno: FIGLIO_PONTE, tipo: 'split' })
  await voce('V_DIVISA_ALTRO', { alunno: FIGLIO_PONTE, tipo: 'split' })
  await voce('V_FUTURA', { alunno: FIGLIO_PONTE, competenza: '2027-10-01' })
  await voce('V_NASCOSTA', { alunno: FIGLIO_PONTE, visibileDal: '2099-01-01' })
  await voce('V_RITIRATO', { alunno: FIGLIO_RITIRATO })
  await voce('V_B', { alunno: FIGLIO_B, sede: SEDE_B })
  const qSua = await quota('Q_SUA', V.V_DIVISA_SUA, GEN_PONTE)
  const qAltro = await quota('Q_ALTRO', V.V_DIVISA_ALTRO, GEN_ALTRO)
  await incasso('I_1', V.V_1)
  await incasso('I_SUA', V.V_DIVISA_SUA, qSua)
  await incasso('I_ALTRO', V.V_DIVISA_ALTRO, qAltro)
  await incasso('I_RITIRATO', V.V_RITIRATO)

  await news('N_TUTTE_LE_SEDI', { sede: null })
  await news('N_SEDE', {})
  await news('N_SEDE_B', { sede: SEDE_B })
  await news('N_SEZ_1', { scope: 'classi', classi: ['Girasoli'] })
  await news('N_SEZ_2', { scope: 'classi', classi: ['Margherite'] })
  await news('N_GRADO', { scope: 'grado', gradi: ['primaria'] })
  await news('N_BOZZA', { stato: 'bozza' })
  // Per classi ma senza sede: il trigger non sa su quale anno tradurre e gli uuid restano NULL.
  await news('N_CLASSI_SENZA_UUID', { sede: null, scope: 'classi', classi: ['Girasoli'] })

  await db.exec(`DELETE FROM realtime.messages`)
}

beforeAll(async () => {
  db = await creaDbAnnoPr2({ sedi: [SEDE, SEDE_B], fino: 'M44a', codaPrima: SCHEMA_GALLERIA_GENITORE + SCHEMA_NEWS_GENITORE })
  await preparaAccesso(db)
  await seme()

  await inRollback(async () => { PRIMA = await letture() })
  await inRollback(async () => {
    await db.exec(SENZA_RLS_SUI_RAMI)
    PRIMA_SENZA_RLS = await letture()
  })
  await inRollback(async () => {
    PRIMA_SERVIZIO = {}
    for (const t of TABELLE) PRIMA_SERVIZIO[t] = await vede(null, t, 'service_role')
  })
  PRIMA_REGOLE = await regole()

  await applicaPr2(db, 'M44b')
}, 180_000)
afterAll(async () => { await db.close() })

describe('il banco ha davvero le regole di oggi', () => {
  it('prima di M44b un ritirato legge tutto, e una voce divisa si legge senza la quota', () => {
    expect(PRIMA['galleria_media_v2 · GEN_RITIRATO']).toEqual(['F_RITIRATO', 'F_SEDE'])
    expect(PRIMA['chat_threads · GEN_RITIRATO']).toEqual(['T_RITIRATO'])
    expect(PRIMA['news_posts · GEN_RITIRATO']).toEqual(['N_CLASSI_SENZA_UUID', 'N_SEDE', 'N_SEZ_1', 'N_TUTTE_LE_SEDI'])
    expect(PRIMA['pagamenti · GEN_PONTE']).toEqual(['V_DIVISA_ALTRO', 'V_DIVISA_SUA', 'V_FUTURA', 'V_NASCOSTA'])
  })

  it('prima di M44b chi è legato solo da `legame_genitori_alunni` dalle regole non aveva né foto né voci', () => {
    expect(PRIMA['galleria_media_v2 · GEN_LEGAME']).toEqual([])
    expect(PRIMA['pagamenti · GEN_LEGAME']).toEqual([])
  })
})

describe('galleria_media_v2', () => {
  prova('un authenticated vede solo media_visibili_miei: tre genitori, tre insiemi diversi', async () => {
    await inRollback(async () => {
      expect(await vede(GEN_LEGAME, 'galleria_media_v2')).toEqual(['F_1', 'F_2', 'F_CON_PONTE', 'F_FRATELLI', 'F_SEDE', 'F_SEZ_1', 'F_SEZ_2'])
      expect(await vede(GEN_PONTE, 'galleria_media_v2')).toEqual(['F_CON_PONTE', 'F_SEDE', 'F_SEZ_2'])
      expect(await vede(GEN_ALTRA_SEDE, 'galleria_media_v2')).toEqual(['F_B'])
    })
  })

  prova('la regola dà quello che dà la funzione', async () => {
    await inRollback(async () => {
      for (const genitore of Object.values(FAMIGLIE)) {
        await comeChi(genitore, async () => {
          const f = await db.query<{ id: string }>(`SELECT DISTINCT media_id AS id FROM public.media_visibili_miei()`)
          expect(await idDi('galleria_media_v2')).toEqual(nomi(f.rows.map((x) => x.id)))
        })
      }
    })
  })

  prova('un ritirato non vede la galleria nemmeno dal browser', async () => {
    await inRollback(async () => {
      expect(await vede(GEN_RITIRATO, 'galleria_media_v2')).toEqual([])
    })
  })

  prova('chi non ha figli, e chi non ha un token, non vede niente e non prende errori', async () => {
    await inRollback(async () => {
      expect(await vede(GEN_ESTRANEO, 'galleria_media_v2')).toEqual([])
      expect(await vede(null, 'galleria_media_v2')).toEqual([])
    })
  })
})

describe('chat_threads e chat_messages', () => {
  const manopola = (accesa: boolean) => db.query(`UPDATE public.anno_regole SET chat_sola_lettura_dal_passaggio = $1`, [accesa])

  prova('il partecipante vede la propria conversazione; un altro genitore no', async () => {
    await inRollback(async () => {
      expect(await vede(GEN_LEGAME, 'chat_threads')).toEqual(['T_1', 'T_NON_ASSEGNATO'])
      expect(await vede(GEN_LEGAME, 'chat_messages')).toEqual(['MSG_T_1', 'MSG_T_NON_ASSEGNATO'])
      expect(await vede(GEN_PONTE, 'chat_threads')).toEqual(['T_PONTE', 'T_SCHEDA'])
      expect(await vede(GEN_PONTE, 'chat_messages')).toEqual(['MSG_T_PONTE', 'MSG_T_SCHEDA'])
      expect(await vede(GEN_ALTRA_SEDE, 'chat_threads')).toEqual([])
      expect(await vede(GEN_ESTRANEO, 'chat_messages')).toEqual([])
    })
  })

  prova('anche se in sola lettura: con la manopola accesa la conversazione si legge lo stesso', async () => {
    await inRollback(async () => {
      await manopola(true)
      const scrivibili = await comeChi(GEN_LEGAME, async () =>
        (await db.query<{ thread_id: string; scrivibile: boolean }>(`SELECT thread_id, scrivibile FROM public.thread_visibili_miei()`)).rows)
      expect(Object.fromEntries(scrivibili.map((r) => [ETICHETTE.get(r.thread_id), r.scrivibile]))).toEqual({ T_1: true, T_NON_ASSEGNATO: false })
      expect(await vede(GEN_LEGAME, 'chat_threads')).toEqual(['T_1', 'T_NON_ASSEGNATO'])
      expect(await vede(GEN_LEGAME, 'chat_messages')).toEqual(['MSG_T_1', 'MSG_T_NON_ASSEGNATO'])
    })
  })

  prova('il figlio ritirato toglie la conversazione al genitore, non al docente', async () => {
    await inRollback(async () => {
      expect(await vede(GEN_RITIRATO, 'chat_threads')).toEqual([])
      expect(await vede(GEN_RITIRATO, 'chat_messages')).toEqual([])
      expect(await vede(DOC_1, 'chat_threads')).toEqual(['T_1', 'T_RITIRATO', 'T_SCHEDA'])
      expect(await vede(DOC_1, 'chat_messages')).toEqual(['MSG_T_1', 'MSG_T_RITIRATO', 'MSG_T_SCHEDA'])
    })
  })

  prova('il docente non più assegnato continua a leggere, in tutte e due le posizioni della manopola', async () => {
    await inRollback(async () => {
      expect(await vede(DOC_2, 'chat_threads')).toEqual(['T_NON_ASSEGNATO', 'T_PONTE'])
      await manopola(true)
      expect(await vede(DOC_2, 'chat_threads')).toEqual(['T_NON_ASSEGNATO', 'T_PONTE'])
      expect(await vede(DOC_2, 'chat_messages')).toEqual(['MSG_T_NON_ASSEGNATO', 'MSG_T_PONTE'])
    })
  })

  describe('non si inserisce in un thread sola lettura', () => {
    const inserisci = (thread: string) =>
      codiceErrore(`INSERT INTO public.chat_messages (thread_id, sender_id, content) VALUES ($1, $2, 'Scritto dal browser')`, [thread, GEN_LEGAME])

    prova('`authenticated` non può inserire del tutto: né nel thread in sola lettura, né in quello scrivibile', async () => {
      await inRollback(async () => {
        await manopola(true)
        expect(await comeChi(GEN_LEGAME, () => inserisci(T.T_NON_ASSEGNATO))).toBe('42501')
        expect(await comeChi(GEN_LEGAME, () => inserisci(T.T_1))).toBe('42501')
      })
    })

    prova('e se il permesso tornasse per sbaglio, non c’è una regola che apra: la RLS ferma lo stesso', async () => {
      await inRollback(async () => {
        await db.exec(`GRANT INSERT ON public.chat_messages TO authenticated`)
        expect(await comeChi(GEN_LEGAME, () => inserisci(T.T_1))).toBe('42501')
      })
    })

    prova('nessuna regola di scrittura per `authenticated` sulle cinque tabelle', async () => {
      const dopo = await regole()
      const scrittura = dopo.filter((r) =>
        ['galleria_media_v2', 'chat_threads', 'chat_messages', 'pagamenti', 'news_posts'].includes(r.tablename)
        && r.roles.includes('authenticated') && r.cmd !== 'SELECT')
      expect(scrittura).toEqual([])
    })
  })
})

describe('pagamenti', () => {
  prova('un genitore vede solo voci_visibili_miei', async () => {
    await inRollback(async () => {
      expect(await vede(GEN_LEGAME, 'pagamenti')).toEqual(['V_1'])
      expect(await vede(GEN_PONTE, 'pagamenti')).toEqual(['V_DIVISA_SUA'])
      expect(await vede(GEN_ALTRO, 'pagamenti')).toEqual(['V_DIVISA_ALTRO'])
      expect(await vede(GEN_ALTRA_SEDE, 'pagamenti')).toEqual(['V_B'])
      expect(await vede(GEN_ESTRANEO, 'pagamenti')).toEqual([])
    })
  })

  prova('la regola dà quello che dà la funzione', async () => {
    await inRollback(async () => {
      for (const genitore of Object.values(FAMIGLIE)) {
        await comeChi(genitore, async () => {
          const f = await db.query<{ id: string }>(`SELECT voce_id AS id FROM public.voci_visibili_miei()`)
          expect(await idDi('pagamenti')).toEqual(nomi(f.rows.map((x) => x.id)))
        })
      }
    })
  })

  prova('RESTRINGE: una voce divisa del figlio, senza la propria quota, oggi si legge e dopo M44b no', async () => {
    expect(PRIMA['pagamenti · GEN_PONTE']).toContain('V_DIVISA_ALTRO')
    await inRollback(async () => {
      expect(await vede(GEN_PONTE, 'pagamenti')).not.toContain('V_DIVISA_ALTRO')
    })
  })

  prova('le voci di un anno futuro e quelle con `visibile_dal` futuro escono anche dal browser', async () => {
    expect(PRIMA['pagamenti · GEN_PONTE']).toEqual(expect.arrayContaining(['V_FUTURA', 'V_NASCOSTA']))
    await inRollback(async () => {
      const dopo = await vede(GEN_PONTE, 'pagamenti')
      expect(dopo).not.toContain('V_FUTURA')
      expect(dopo).not.toContain('V_NASCOSTA')
    })
  })

  describe('chi legge `pagamenti` sotto la regola ne eredita la restrizione', () => {
    prova('`pagamenti_quote`: la propria quota sempre; quella dell’altro genitore non si legge più dalla voce del figlio', async () => {
      expect(PRIMA['pagamenti_quote · GEN_PONTE']).toEqual(['Q_ALTRO', 'Q_SUA'])
      await inRollback(async () => {
        expect(await vede(GEN_PONTE, 'pagamenti_quote')).toEqual(['Q_SUA'])
        expect(await vede(GEN_ALTRO, 'pagamenti_quote')).toEqual(['Q_ALTRO'])
        expect(await vede(GEN_ESTRANEO, 'pagamenti_quote')).toEqual([])
      })
    })

    prova('`incassi`: quelli della voce che non si vede non si leggono più', async () => {
      expect(PRIMA['incassi · GEN_PONTE']).toEqual(['I_ALTRO', 'I_SUA'])
      await inRollback(async () => {
        expect(await vede(GEN_PONTE, 'incassi')).toEqual(['I_SUA'])
      })
    })

    prova('`incassi` per chi è legato da `legame_genitori_alunni`: niente prima e niente dopo, quella tabella ha la RLS senza regole', async () => {
      expect(PRIMA['incassi · GEN_LEGAME']).toEqual([])
      await inRollback(async () => {
        expect(await vede(GEN_LEGAME, 'incassi')).toEqual([])
        expect(await vede(GEN_ALTRO, 'incassi')).toEqual([])
      })
    })
  })
})

describe('news_posts', () => {
  prova('solo le classi del figlio attivo', async () => {
    await inRollback(async () => {
      expect(await vede(GEN_LEGAME, 'news_posts')).toEqual(['N_SEDE', 'N_SEZ_1', 'N_SEZ_2', 'N_TUTTE_LE_SEDI'])
      expect(await vede(GEN_PONTE, 'news_posts')).toEqual(['N_SEDE', 'N_SEZ_2', 'N_TUTTE_LE_SEDI'])
      expect(await vede(GEN_ALTRA_SEDE, 'news_posts')).toEqual(['N_SEDE_B', 'N_TUTTE_LE_SEDI'])
    })
  })

  prova('la classe la dice la frequenza attiva, non `alunni.classe_sezione`', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE public.frequenze SET section_id = $2 WHERE alunno_id = $1`, [FIGLIO_PONTE, SEZ_1])
      expect(await vede(GEN_PONTE, 'news_posts')).toEqual(['N_SEDE', 'N_SEZ_1', 'N_TUTTE_LE_SEDI'])
    })
  })

  prova('il figlio ritirato non apre più niente, nemmeno quelle per tutti', async () => {
    await inRollback(async () => {
      expect(await vede(GEN_RITIRATO, 'news_posts')).toEqual([])
    })
  })

  prova('una news per classi senza uuid resta chiusa, anche per il figlio di quella classe: un dubbio non apre', async () => {
    expect(PRIMA['news_posts · GEN_RITIRATO']).toContain('N_CLASSI_SENZA_UUID')
    await inRollback(async () => {
      expect(await vede(GEN_LEGAME, 'news_posts')).not.toContain('N_CLASSI_SENZA_UUID')
    })
  })

  prova('una bozza non si legge', async () => {
    await inRollback(async () => {
      for (const genitore of Object.values(FAMIGLIE)) expect(await vede(genitore, 'news_posts')).not.toContain('N_BOZZA')
    })
  })

  prova('il ramo `grado` è giusto, e in produzione resta chiuso come oggi: `sections` ha la RLS senza regole per il genitore', async () => {
    expect(PRIMA['news_posts · GEN_PONTE']).not.toContain('N_GRADO')
    await inRollback(async () => {
      expect(await vede(GEN_PONTE, 'news_posts')).not.toContain('N_GRADO')
      await db.exec(SENZA_RLS_SUI_RAMI)
      expect(await vede(GEN_PONTE, 'news_posts')).toContain('N_GRADO')
      expect(await vede(GEN_LEGAME, 'news_posts')).toContain('N_GRADO')
      expect(await vede(GEN_ALTRA_SEDE, 'news_posts')).not.toContain('N_GRADO')
    })
  })
})

describe('chi non è un genitore', () => {
  prova('lo staff vede come prima, tabella per tabella', async () => {
    await inRollback(async () => {
      for (const [nome, id] of Object.entries(PERSONALE)) {
        for (const t of TABELLE) expect([`${t} · ${nome}`, await vede(id, t)]).toEqual([`${t} · ${nome}`, PRIMA[`${t} · ${nome}`]])
      }
    })
  })

  prova('lo staff vede come prima anche dove il ramo si apre, con la sede di `utenti` e quelle di `utenti_scuole`', async () => {
    await inRollback(async () => {
      await db.exec(SENZA_RLS_SUI_RAMI)
      for (const [nome, id] of Object.entries(PERSONALE)) {
        for (const t of TABELLE) expect([`${t} · ${nome}`, await vede(id, t)]).toEqual([`${t} · ${nome}`, PRIMA_SENZA_RLS[`${t} · ${nome}`]])
      }
      expect(await vede(SEGRETERIA, 'news_posts')).toEqual(['N_BOZZA', 'N_CLASSI_SENZA_UUID', 'N_GRADO', 'N_SEDE', 'N_SEZ_1', 'N_SEZ_2', 'N_TUTTE_LE_SEDI'])
      expect(await vede(DIREZIONE, 'news_posts')).toEqual(['N_BOZZA', 'N_CLASSI_SENZA_UUID', 'N_GRADO', 'N_SEDE', 'N_SEDE_B', 'N_SEZ_1', 'N_SEZ_2', 'N_TUTTE_LE_SEDI'])
    })
  })

  prova('`service_role` vede tutto come prima', async () => {
    await inRollback(async () => {
      for (const t of TABELLE) expect(await vede(null, t, 'service_role')).toEqual(PRIMA_SERVIZIO[t])
      expect(await vede(null, 'pagamenti', 'service_role')).toHaveLength(7)
    })
  })

  prova('`anon` non vede niente e non prende errori: le regole non sono sue', async () => {
    await inRollback(async () => {
      expect(await vede(null, 'galleria_media_v2', 'anon')).toEqual([])
      expect(await vede(null, 'pagamenti', 'anon')).toEqual([])
      expect(await vede(null, 'news_posts', 'anon')).toEqual([])
    })
  })
})

describe('una famiglia con zero figli attivi', () => {
  prova('legge liste vuote senza errori; da `pagamenti` le voci del ritirato con un dovuto aperto restano', async () => {
    await inRollback(async () => {
      expect(await vede(GEN_RITIRATO, 'galleria_media_v2')).toEqual([])
      expect(await vede(GEN_RITIRATO, 'chat_threads')).toEqual([])
      expect(await vede(GEN_RITIRATO, 'chat_messages')).toEqual([])
      expect(await vede(GEN_RITIRATO, 'news_posts')).toEqual([])
      expect(await vede(GEN_RITIRATO, 'pagamenti')).toEqual(['V_RITIRATO'])
      expect(await vede(GEN_RITIRATO, 'incassi')).toEqual(['I_RITIRATO'])
    })
  })

  prova('`current_parent_student_ids()` resta: l’anagrafica del figlio ritirato si legge ancora', async () => {
    await inRollback(async () => {
      const r = await comeChi(GEN_RITIRATO, async () => (await db.query<{ id: string }>(`SELECT id FROM public.alunni`)).rows)
      expect(r.map((x) => x.id)).toEqual([FIGLIO_RITIRATO])
    })
  })
})

describe('il trigger chat_messaggio_broadcast', () => {
  /** I canali che ricevono il segnale di un messaggio nuovo. */
  const canali = async (thread: string): Promise<string[]> => {
    await db.exec(`DELETE FROM realtime.messages`)
    await db.query(`INSERT INTO public.chat_messages (thread_id, sender_id, content) VALUES ($1, $2, 'Testo di prova')`, [thread, DOC_1])
    return canaliScritti()
  }
  const canaliScritti = async (): Promise<string[]> => {
    const r = await db.query<{ topic: string }>(`SELECT topic FROM realtime.messages`)
    return r.rows.map((x) => ETICHETTE.get(x.topic.replace(/^chat:/, '')) ?? x.topic).sort()
  }

  prova('il messaggio arriva al docente e al genitore che vede il thread', async () => {
    await inRollback(async () => {
      expect(await canali(T.T_1)).toEqual(['DOC_1', 'GEN_LEGAME'])
    })
  })

  prova('non manda il messaggio a un genitore che non vede il thread: figlio ritirato, nessun broadcast a lui, il docente sì', async () => {
    await inRollback(async () => {
      expect(await canali(T.T_RITIRATO)).toEqual(['DOC_1'])
    })
  })

  prova('vale anche per le spunte', async () => {
    await inRollback(async () => {
      await db.query(`INSERT INTO public.chat_messages (thread_id, sender_id, content) VALUES ($1, $2, 'Testo di prova')`, [T.T_RITIRATO, DOC_1])
      await db.exec(`DELETE FROM realtime.messages`)
      await db.query(`UPDATE public.chat_messages SET read_at = now() WHERE thread_id = $1`, [T.T_RITIRATO])
      expect((await canaliScritti()).every((c) => c === 'DOC_1')).toBe(true)
      expect((await canaliScritti()).length).toBeGreaterThan(0)
      await db.exec(`DELETE FROM realtime.messages`)
      await db.query(`UPDATE public.chat_messages SET read_at = now() WHERE thread_id = $1`, [T.T_1])
      expect(await canaliScritti()).toEqual(['DOC_1', 'GEN_LEGAME'])
    })
  })

  prova('con il thread in sola lettura il segnale arriva lo stesso: il genitore il thread lo vede, e la manopola non cambia chi riceve', async () => {
    await inRollback(async () => {
      expect(await canali(T.T_NON_ASSEGNATO)).toEqual(['DOC_2', 'GEN_LEGAME'])
      await db.query(`UPDATE public.anno_regole SET chat_sola_lettura_dal_passaggio = true`)
      expect(await canali(T.T_NON_ASSEGNATO)).toEqual(['DOC_2', 'GEN_LEGAME'])
    })
  })

  prova('il thread con la scheda in `parent_id`: arriva a chi ha l’account; il canale `chat:<id della scheda>` non serve a nessuno', async () => {
    await inRollback(async () => {
      expect(await canali(T.T_SCHEDA)).toEqual(['DOC_1', 'GEN_PONTE'])
    })
  })

  prova('il docente passa senza chiamata: il controllo gira solo per chi non è il docente del thread', async () => {
    await inRollback(async () => {
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.thread_e_visibile(p_utente uuid, p_thread uuid) RETURNS boolean
        LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
        BEGIN
          RAISE NOTICE 'controllo-chiamato';
          RETURN EXISTS (SELECT 1 FROM public.thread_visibili(p_utente) v WHERE v.thread_id = p_thread);
        END $f$;`)
      const controlli = async (thread: string) => {
        let n = 0
        await db.query(`INSERT INTO public.chat_messages (thread_id, sender_id, content) VALUES ($1, $2, 'Testo di prova')`, [thread, DOC_1], {
          onNotice: (avviso) => { if (avviso.message === 'controllo-chiamato') n++ },
        })
        return n
      }
      // Il genitore e basta: un destinatario da controllare, il docente no.
      expect(await controlli(T.T_1)).toBe(1)
      // La scheda in `parent_id` e l'account che le sta dietro: due, il docente no.
      expect(await controlli(T.T_SCHEDA)).toBe(2)
    })
  })

  prova('il segnale porta le sei chiavi di sempre, e mai il testo', async () => {
    await inRollback(async () => {
      await canali(T.T_1)
      const r = await db.query<{ chiave: string }>(`SELECT DISTINCT jsonb_object_keys(payload) AS chiave FROM realtime.messages`)
      expect(r.rows.map((x) => x.chiave).sort()).toEqual(['created_at', 'delivered_at', 'id', 'read_at', 'sender_id', 'thread_id'])
    })
  })

  prova('fail-open: se il controllo si guasta il messaggio entra lo stesso, e il segnale non parte per nessuno', async () => {
    await inRollback(async () => {
      await db.exec(`ALTER FUNCTION public.thread_e_visibile(uuid, uuid) RENAME TO thread_e_visibile_via`)
      expect(await canali(T.T_1)).toEqual([])
      expect(await una<number>(`SELECT count(*)::int FROM public.chat_messages WHERE thread_id = $1`, [T.T_1])).toBe(2)
    })
  })

  prova('resta chiusa ad `anon` e `authenticated`', async () => {
    const r = await db.query<{ anon: boolean; auth: boolean; definer: boolean; conf: string[] }>(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              p.prosecdef AS definer, p.proconfig AS conf
         FROM pg_proc p WHERE p.oid = 'public.chat_messaggio_broadcast()'::regprocedure`)
    expect(r.rows[0]).toMatchObject({ anon: false, auth: false, definer: true })
    expect(r.rows[0].conf).toEqual(['search_path=""'])
  })
})

describe('la regola realtime.messages del canale chat:<uid> resta', () => {
  prova('il testo non cambia', async () => {
    const trova = (righe: RigaRegola[]) => righe.find((r) => r.schemaname === 'realtime' && r.policyname === 'chat_broadcast_solo_il_proprio_canale')
    const dopo = trova(await regole())
    expect(dopo).toBeDefined()
    expect(dopo).toEqual(trova(PRIMA_REGOLE))
  })

  prova('ciascuno legge il proprio canale, non quello degli altri', async () => {
    await inRollback(async () => {
      await db.exec(`DELETE FROM realtime.messages`)
      await db.query(`INSERT INTO public.chat_messages (thread_id, sender_id, content) VALUES ($1, $2, 'Testo di prova')`, [T.T_1, DOC_1])
      const quanti = (canale: string) => comeChi(GEN_LEGAME, async () => {
        await db.query(`SELECT set_config('realtime.topic', $1, true)`, [`chat:${canale}`])
        return una<number>(`SELECT count(*)::int FROM realtime.messages`)
      })
      // La regola guarda il canale che si sta aprendo (`realtime.topic()`), non la colonna della riga: è il Realtime a smistare.
      expect(await quanti(GEN_LEGAME)).toBeGreaterThan(0)
      expect(await quanti(DOC_1)).toBe(0)
    })
  })
})

describe('il testo delle regole', () => {
  const NUOVE: Array<[string, string]> = [
    ['galleria_media_v2', 'parent read galleria figli (parents space)'],
    ['chat_threads', 'chat_threads_select_participant'],
    ['chat_messages', 'chat_messages_select_participant'],
    ['pagamenti', 'parent read pagamenti figli (parents space)'],
    ['news_posts', 'auth read news_posts'],
  ]
  const trova = (righe: RigaRegola[], tabella: string, nome: string) =>
    righe.find((r) => r.schemaname === 'public' && r.tablename === tabella && r.policyname === nome)

  prova('stessi nomi, stesso comando, stessi ruoli; nessuna regola in più o in meno', async () => {
    const ossatura = (righe: RigaRegola[]) => righe.map((r) => `${r.schemaname}.${r.tablename} · ${r.policyname} · ${r.cmd} · ${r.roles.join(',')}`)
    expect(ossatura(await regole())).toEqual(ossatura(PRIMA_REGOLE))
  })

  prova('cambia il testo delle cinque e di nessun’altra', async () => {
    const dopo = await regole()
    const cambiate = dopo.filter((r) => {
      const prima = PRIMA_REGOLE.find((p) => p.schemaname === r.schemaname && p.tablename === r.tablename && p.policyname === r.policyname)
      return prima?.qual !== r.qual || prima?.with_check !== r.with_check
    }).map((r) => r.tablename).sort()
    expect(cambiate).toEqual(NUOVE.map(([t]) => t).sort())
  })

  prova('ognuna passa dalla funzione del genitore, e non nomina più `current_parent_student_ids`', async () => {
    const dopo = await regole()
    const attese: Record<string, string> = {
      galleria_media_v2: 'media_visibili_miei()',
      chat_threads: 'thread_visibili_miei()',
      chat_messages: 'thread_visibili_miei()',
      pagamenti: 'voci_visibili_miei()',
      news_posts: 'figli_attivi_miei()',
    }
    for (const [t, nome] of NUOVE) {
      const r = trova(dopo, t, nome)
      expect(r?.qual).toContain(attese[t])
      expect(r?.qual).not.toContain('current_parent_student_ids')
    }
  })

  prova('il ramo staff di `news_posts` è lo stesso di prima, parola per parola', async () => {
    const ramoStaff = (qual: string | null | undefined) => {
      const inizio = qual?.indexOf('EXISTS') ?? -1
      const fine = qual?.indexOf(`stato = 'pubblicata'`) ?? -1
      return qual?.slice(inizio, fine)
    }
    const dopo = ramoStaff(trova(await regole(), 'news_posts', 'auth read news_posts')?.qual)
    expect(dopo).toContain('utenti_scuole')
    expect(dopo).toEqual(ramoStaff(trova(PRIMA_REGOLE, 'news_posts', 'auth read news_posts')?.qual))
  })

  prova('ognuna ha il suo commento', async () => {
    const r = await db.query<{ tabella: string; commento: string | null }>(
      `SELECT c.relname::text AS tabella, obj_description(p.oid, 'pg_policy') AS commento
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = ANY ($1) AND p.polname = ANY ($2)`,
      [NUOVE.map(([t]) => t), NUOVE.map(([, n]) => n)])
    expect(r.rows).toHaveLength(NUOVE.length)
    for (const riga of r.rows) expect(riga.commento, riga.tabella).toBeTruthy()
  })
})

// `postgres` su Supabase NON è superutente: salta la RLS perché è il proprietario. In PGlite l'utente di partenza lo è, e la
// prova sotto di lui nasconderebbe una ricorsione. Qui tabelle e funzioni passano a un proprietario qualunque.
const PROPRIETARIO_COME_IN_PRODUZIONE = `
  CREATE ROLE proprietario_vero NOSUPERUSER NOBYPASSRLS;
  GRANT USAGE ON SCHEMA auth TO proprietario_vero;
  DO $b$
  DECLARE
    r record;
  BEGIN
    FOR r IN
      SELECT c.oid::regclass AS nome
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
    LOOP
      EXECUTE format('ALTER TABLE %s OWNER TO proprietario_vero', r.nome);
    END LOOP;
    FOR r IN
      SELECT p.oid::regprocedure AS firma
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    LOOP
      EXECUTE format('ALTER FUNCTION %s OWNER TO proprietario_vero', r.firma);
    END LOOP;
  END
  $b$;
`

describe('nessuna ricorsione (42P17), con un proprietario che non è superutente', () => {
  prova('il banco la vede davvero: la regola di prima del 31/07 dà 42P17', async () => {
    await inRollback(async () => {
      await db.exec(PROPRIETARIO_COME_IN_PRODUZIONE)
      await db.exec(`CREATE POLICY ricorsiva ON public.pagamenti FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM public.pagamenti_quote q WHERE q.pagamento_id = pagamenti.id))`)
      expect(await comeChi(GEN_PONTE, () => codiceErrore(`SELECT id FROM public.pagamenti`))).toBe('42P17')
    })
  })

  prova('`pagamenti` e `pagamenti_quote` con le loro regole vere si leggono, e danno le stesse righe', async () => {
    await inRollback(async () => {
      await db.exec(PROPRIETARIO_COME_IN_PRODUZIONE)
      const proprietario = await una<string>(`SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.voci_visibili_genitore(uuid)'::regprocedure`)
      expect(proprietario).toBe('proprietario_vero')
      expect(await una<boolean>(`SELECT rolsuper FROM pg_roles WHERE rolname = 'proprietario_vero'`)).toBe(false)
      expect(await vede(GEN_PONTE, 'pagamenti')).toEqual(['V_DIVISA_SUA'])
      expect(await vede(GEN_PONTE, 'pagamenti_quote')).toEqual(['Q_SUA'])
      expect(await vede(GEN_PONTE, 'incassi')).toEqual(['I_SUA'])
    })
  })

  prova('lo stesso per thread, messaggi, galleria e news', async () => {
    await inRollback(async () => {
      await db.exec(PROPRIETARIO_COME_IN_PRODUZIONE)
      expect(await vede(GEN_PONTE, 'chat_threads')).toEqual(['T_PONTE', 'T_SCHEDA'])
      expect(await vede(GEN_PONTE, 'chat_messages')).toEqual(['MSG_T_PONTE', 'MSG_T_SCHEDA'])
      expect(await vede(GEN_PONTE, 'galleria_media_v2')).toEqual(['F_CON_PONTE', 'F_SEDE', 'F_SEZ_2'])
      expect(await vede(GEN_PONTE, 'news_posts')).toEqual(['N_SEDE', 'N_SEZ_2', 'N_TUTTE_LE_SEDI'])
    })
  })

  prova('anche il trigger gira col proprietario vero', async () => {
    await inRollback(async () => {
      await db.exec(PROPRIETARIO_COME_IN_PRODUZIONE)
      await db.exec(`ALTER FUNCTION public.chat_messaggio_broadcast() OWNER TO postgres`)
      await db.exec(`DELETE FROM realtime.messages`)
      await db.query(`INSERT INTO public.chat_messages (thread_id, sender_id, content) VALUES ($1, $2, 'Testo di prova')`, [T.T_RITIRATO, DOC_1])
      const r = await db.query<{ topic: string }>(`SELECT topic FROM realtime.messages`)
      expect(r.rows.map((x) => x.topic)).toEqual([`chat:${DOC_1}`])
    })
  })
})

describe('le prestazioni: la funzione gira una volta, non una per riga', () => {
  /** Il wrapper con una notifica in testa: le notifiche contate sono le sue chiamate. */
  const WRAPPER_CHE_SI_CONTA: Record<string, string> = {
    media_visibili_miei: `
      CREATE OR REPLACE FUNCTION public.media_visibili_miei() RETURNS TABLE (media_id uuid, alunno_id uuid)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      BEGIN
        RAISE NOTICE 'wrapper-chiamato';
        RETURN QUERY SELECT v.media_id, v.alunno_id FROM public.media_visibili_genitore(auth.uid()) v;
      END $f$;`,
    thread_visibili_miei: `
      CREATE OR REPLACE FUNCTION public.thread_visibili_miei() RETURNS TABLE (thread_id uuid, scrivibile boolean)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      BEGIN
        RAISE NOTICE 'wrapper-chiamato';
        RETURN QUERY SELECT v.thread_id, v.scrivibile FROM public.thread_visibili(auth.uid()) v;
      END $f$;`,
    voci_visibili_miei: `
      CREATE OR REPLACE FUNCTION public.voci_visibili_miei() RETURNS TABLE (voce_id uuid)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      BEGIN
        RAISE NOTICE 'wrapper-chiamato';
        RETURN QUERY SELECT v.voce_id FROM public.voci_visibili_genitore(auth.uid()) v;
      END $f$;`,
    figli_attivi_miei: `
      CREATE OR REPLACE FUNCTION public.figli_attivi_miei() RETURNS TABLE (alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      BEGIN
        RAISE NOTICE 'wrapper-chiamato';
        RETURN QUERY SELECT f.alunno_id, f.frequenza_id, f.section_id, f.scuola_id FROM public.figli_attivi(auth.uid()) f;
      END $f$;`,
  }

  const chiamate = async (genitore: string, tabella: Tabella): Promise<{ chiamate: number; righe: number }> =>
    comeChi(genitore, async () => {
      let n = 0
      const r = await db.query(`SELECT id FROM public.${tabella}`, [], { onNotice: (avviso) => { if (avviso.message === 'wrapper-chiamato') n++ } })
      return { chiamate: n, righe: r.rows.length }
    })

  const VOLUME = 200

  prova('galleria: 1 chiamata su centinaia di righe', async () => {
    await inRollback(async () => {
      await db.exec(WRAPPER_CHE_SI_CONTA.media_visibili_miei)
      await db.query(
        `INSERT INTO public.galleria_media_v2 (scuola_id, tag_students, created_at)
         SELECT $1, ARRAY[$2]::uuid[], '2026-10-20T12:00:00+02:00' FROM generate_series(1, ${VOLUME})`, [SEDE, FIGLIO_1])
      const r = await chiamate(GEN_LEGAME, 'galleria_media_v2')
      expect(r.righe).toBeGreaterThanOrEqual(VOLUME)
      expect(r.chiamate).toBe(1)
    })
  })

  prova('thread e messaggi: 1 chiamata', async () => {
    await inRollback(async () => {
      await db.exec(WRAPPER_CHE_SI_CONTA.thread_visibili_miei)
      await db.query(
        `INSERT INTO public.chat_messages (thread_id, sender_id, content) SELECT $1, $2, 'Testo di prova' FROM generate_series(1, ${VOLUME})`, [T.T_1, DOC_1])
      const m = await chiamate(GEN_LEGAME, 'chat_messages')
      expect(m.righe).toBeGreaterThanOrEqual(VOLUME)
      expect(m.chiamate).toBe(1)
      expect((await chiamate(GEN_LEGAME, 'chat_threads')).chiamate).toBe(1)
    })
  })

  prova('voci: 1 chiamata', async () => {
    await inRollback(async () => {
      await db.exec(WRAPPER_CHE_SI_CONTA.voci_visibili_miei)
      await db.query(
        `INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza, periodo_competenza)
         SELECT $1, $2, 'Voce di prova', 100, DATE '2026-10-01', DATE '2026-10-01' FROM generate_series(1, ${VOLUME})`, [FIGLIO_1, SEDE])
      const r = await chiamate(GEN_LEGAME, 'pagamenti')
      expect(r.righe).toBeGreaterThanOrEqual(VOLUME)
      expect(r.chiamate).toBe(1)
    })
  })

  prova('news: 1 chiamata, anche se la condizione guarda la riga', async () => {
    await inRollback(async () => {
      await db.exec(WRAPPER_CHE_SI_CONTA.figli_attivi_miei)
      await db.query(
        `INSERT INTO public.news_posts (scuola_id, stato, author_id, created_at)
         SELECT $1, 'pubblicata', $2, '2026-10-20T12:00:00+02:00' FROM generate_series(1, ${VOLUME})`, [SEDE, SEGRETERIA])
      const r = await chiamate(GEN_LEGAME, 'news_posts')
      expect(r.righe).toBeGreaterThanOrEqual(VOLUME)
      expect(r.chiamate).toBe(1)
    })
  })

  prova('il piano: `IN` diventa una sottoquery con la tabella hash, una per istruzione', async () => {
    await inRollback(async () => {
      const piano = (tabella: Tabella) => comeChi(GEN_LEGAME, async () => {
        const r = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) SELECT id FROM public.${tabella}`)
        return r.rows.map((x) => x['QUERY PLAN']).join('\n')
      })
      for (const t of ['galleria_media_v2', 'chat_threads', 'chat_messages', 'pagamenti'] as const) {
        expect(await piano(t), t).toMatch(/hashed SubPlan/)
      }
    })
  })
})

describe('M44b su un database senza l’anno', () => {
  prova('senza `frequenze` le regole di oggi restano, si leggono senza errori e il segnale parte come oggi', async () => {
    const nudo = new PGlite()
    try {
      await nudo.exec(SCHEMA_BASE)
      await nudo.exec(SCHEMA_GALLERIA_GENITORE)
      await nudo.exec(SCHEMA_NEWS_GENITORE)
      await preparaAccesso(nudo)
      const prima = await regole(nudo)
      await applicaPr2(nudo, 'M44a')
      await applicaPr2(nudo, 'M44b')
      expect(await regole(nudo)).toEqual(prima)

      // Il genitore di oggi: legge i suoi dati con le regole di oggi, e le funzioni dell'anno non entrano.
      const scheda = '88888888-8888-4888-8888-888888888884'
      await nudo.query(`INSERT INTO public.schools (id, nome) VALUES ($1, 'Sede di prova')`, [SEDE])
      await nudo.query(`INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)`, [FIGLIO_1, SEDE])
      await nudo.query(`INSERT INTO public.parents (id, auth_user_id) VALUES ($1, $2)`, [scheda, GEN_PONTE])
      await nudo.query(`INSERT INTO public.student_parents (student_id, parent_id) VALUES ($1, $2)`, [FIGLIO_1, scheda])
      const fotoId = (await nudo.query<{ id: string }>(`INSERT INTO public.galleria_media_v2 (scuola_id, tag_students) VALUES ($1, ARRAY[$2]::uuid[]) RETURNING id`, [SEDE, FIGLIO_1])).rows[0].id
      const voceId = (await nudo.query<{ id: string }>(`INSERT INTO public.pagamenti (alunno_id, scuola_id, descrizione, importo, scadenza) VALUES ($1, $2, 'Voce di prova', 100, DATE '2026-10-01') RETURNING id`, [FIGLIO_1, SEDE])).rows[0].id
      const threadId = (await nudo.query<{ id: string }>(`INSERT INTO public.chat_threads (teacher_id, parent_id, student_id) VALUES ($1, $2, $3) RETURNING id`, [DOC_1, scheda, FIGLIO_1])).rows[0].id

      const avvisi: string[] = []
      await nudo.query(`INSERT INTO public.chat_messages (thread_id, sender_id, content) VALUES ($1, $2, 'Testo di prova')`, [threadId, DOC_1], {
        onNotice: (n) => { avvisi.push(n.message ?? '') },
      })
      expect(avvisi).toEqual([])
      const canali = await nudo.query<{ topic: string }>(`SELECT topic FROM realtime.messages ORDER BY topic`)
      expect(canali.rows.map((r) => r.topic).sort()).toEqual([`chat:${DOC_1}`, `chat:${GEN_PONTE}`, `chat:${scheda}`].sort())

      await nudo.exec('BEGIN')
      await nudo.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: GEN_PONTE, role: 'authenticated' })])
      await nudo.exec('SET LOCAL ROLE authenticated')
      const leggi = async (t: string) => (await nudo.query<{ id: string }>(`SELECT id FROM public.${t}`)).rows.map((r) => r.id)
      expect(await leggi('galleria_media_v2')).toEqual([fotoId])
      expect(await leggi('pagamenti')).toEqual([voceId])
      expect(await leggi('news_posts')).toEqual([])
      await nudo.exec('ROLLBACK')
    } finally {
      await nudo.close()
    }
  })

  prova('si applica anche dove c’è solo il banco minimo: una regola che non c’è non si crea', async () => {
    const nudo = new PGlite()
    try {
      await nudo.exec(SCHEMA_BASE)
      const prima = await regole(nudo)
      // M44a fuori dalla transazione: ha il suo `lock_timeout`, e coprirebbe quello che manca qui.
      await applicaPr2(nudo, 'M44a')
      await nudo.exec('BEGIN')
      await applicaPr2(nudo, 'M44b')
      const r = await nudo.query<{ lock_timeout: string }>('SHOW lock_timeout')
      expect(r.rows[0].lock_timeout).toBe('10s')
      await nudo.exec('COMMIT')
      expect(await regole(nudo)).toEqual(prima)
    } finally {
      await nudo.close()
    }
  })

  prova('con `frequenze` ma senza `target_section_ids` la regola di news resta, le altre cambiano', async () => {
    const d = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M44a', codaPrima: SCHEMA_GALLERIA_GENITORE + SCHEMA_NEWS_GENITORE })
    try {
      await preparaAccesso(d)
      await d.exec(`ALTER TABLE public.news_posts DROP COLUMN target_section_ids`)
      const testo = async (nome: string) => (await regole(d)).find((r) => r.policyname === nome)?.qual
      const newsPrima = await testo('auth read news_posts')
      expect(newsPrima).toBeTruthy()
      await applicaPr2(d, 'M44b')
      expect(await testo('auth read news_posts')).toBe(newsPrima)
      expect(await testo('chat_threads_select_participant')).toMatch(/thread_visibili_miei/)
    } finally {
      await d.close()
    }
  })

  prova('con l’anno ma senza le tabelle e le regole di produzione non si ferma', async () => {
    for (const completo of [false, true]) {
      const d = await creaDbAnnoPr2({ sedi: [SEDE], fino: 'M44b', completo })
      try {
        const nate = (await regole(d)).map((r) => r.policyname)
        for (const nome of ['parent read galleria figli (parents space)', 'chat_threads_select_participant', 'chat_messages_select_participant',
          'parent read pagamenti figli (parents space)', 'auth read news_posts']) expect(nate).not.toContain(nome)
      } finally {
        await d.close()
      }
    }
  })
})
