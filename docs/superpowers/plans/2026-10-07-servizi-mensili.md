# Piano — Parte 2: servizi mensili

Specifica: `docs/superpowers/specs/2026-10-07-kpi-contabilita-servizi-mensili-design.md`. Parte 1 in produzione dal 2026-10-07 (PR #204). Esecuzione: un sub-agente Sonnet per compito (TDD), revisione Opus dopo ogni compito e sul diff finale.


Decisioni aggiuntive:
- **Fine/eliminazione di un'iscrizione con voci future già generate → si chiede alla segreteria**:
  finestra con «Elimina le N voci non pagate e non fatturate» / «Mantienile» / «Annulla». Le voci
  pagate, parziali o fatturate non si toccano mai e vengono elencate.
- **Deduplica storica attiva**: in prod ci sono 24 voci di pomeridiano/doposcuola di set–ott 2026
  senza `periodo_competenza`; una voce della stessa categoria con scadenza nel mese blocca la
  generazione del servizio per quel bambino (stessa regola «mese della voce» della Parte 1). Senza
  questo, la prima generazione le addebiterebbe due volte.
- Comportamenti allineati alla retta: nessuna push ai genitori per i servizi (vale `visibile_dal`);
  la generazione annuale copre set–giu (luglio/agosto con «Genera servizi del mese»); i servizi non
  seguono `retta_auto_enabled` né `retta_a_carico_di` (il servizio è del bambino).

### Migrazione `supabase/migrations/<date -u +%Y%m%d%H%M%S>_servizi_mensili.sql` (idempotente)
- `CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions` (disponibile, non installata).
- `payment_categories`: `mensile boolean not null default false`, `importo_mensile_default numeric(10,2)`,
  CHECK importo ≥ 0, CHECK `NOT mensile OR slug <> 'retta'`.
- Tabella `iscrizioni_servizi` (id, alunno_id FK cascade, categoria_id FK restrict, scuola_id FK
  schools, importo_mensile ≥ 0, `dal` primo del mese, `al` facoltativo primo del mese ≥ dal,
  creato_da senza FK, timestamp, trigger `set_updated_at`), **EXCLUDE gist** contro iscrizioni
  sovrapposte (alunno, categoria, daterange), RLS attiva senza policy (solo service-role), REVOKE ad
  anon/authenticated.
- Funzioni plpgsql (non `sql`: non validate alla CREATE), REVOKE + GRANT solo service_role:
  `servizi_da_generare(periodo, sede, alunni)` (predicato unico per anteprima e conferma; scadenza e
  `visibile_dal` con la **stessa formula della retta**; descrizione «<Nome> MM/YYYY»; gruppo
  `<slug>-YYYY-MM`; filtri: categoria mensile+attiva, alunno iscritto con classe e della sede,
  dal ≤ periodo ≤ al, deduplica su `COALESCE(periodo_competenza, mese scadenza)`),
  `genera_servizi_mensili` (controlli sede operativa/periodo/elenco; `INSERT … ON CONFLICT
  (alunno_id, categoria_id, periodo_competenza) WHERE <predicato identico all'indice> DO NOTHING`;
  ritorna il conteggio), `genera_servizi_anno` (cicla set–giu).
- **Non si tocca `genera_rette_*`.** Sonde finali: firme, REVOKE efficace, sede ferma rifiutata
  (messaggio distinto da quello accettato, a differenza della sonda di `20260907192611`).
- Bozza SQL completa: nel rapporto del Plan agent, da copiare nel compito T2.

### Compiti (TDD, Sonnet per compito, revisione Opus)
- **T1 · Regole pure** `src/lib/pagamenti/servizi-mensili.ts` (`primoDelMese`, `zMese`,
  `periodiSovrapposti`, `attivaNel`) + test.
- **T2 · Migrazione + prova SQL su PGlite** (`__tests__/lib/servizi-mensili-sql.test.ts`, modello
  `video-retention-rpc.test.ts`, `btree_gist` da `@electric-sql/pglite/contrib`), file applicato due
  volte; casi: fuori periodo, formula scadenza, idempotenza, esclusioni, deduplica storica,
  sovrapposizione 23P01, CHECK, retta non mensile, annuale, privilegi. Voce in
  `MIGRAZIONI_ATTESE_AL_MERGE` (`__tests__/architecture/soglia-fotografia.ts`); lock da far passare:
  `migrazioni-complete`, `fk-scuola-id`, `rls-per-sede`, `onconflict-arbitro`,
  `security-definer-revoke-lock`, `migrazioni-senza-sede-cablata`, `stati-alunno-anche-in-sql`.
  Dopo aver **mostrato** il file: `gh workflow run "DB migrate (CI)"` sul solo DB della CI.
- **T3 · Aiuti server** `src/lib/pagamenti/generazione-server.ts`: `sedeDellaGenerazione`
  (= `sedeDelleRette` spostata, con codice `SEDE_DI_COLLAUDO`), `tracciaAuditGenerazione`,
  `generaServizi(...)` con try/catch proprio, log di successo anche a 0 e `error` su guasto. Codici
  nuovi in `CODICI_ERRORE` + `messages/{it,en}/shared.json`. I test `genera-rette-*` esistenti
  restano verdi **senza modifiche** (prova che lo spostamento è neutro).
- **T4 · Aggancio in `genera-rette/route.ts`**: dopo le rette (mensile e annuale) `generaServizi`;
  se i servizi falliscono risposta 200 con `data.servizi = { errore: true, codice }` e log `error`
  (le rette già scritte non sembrano fallite); se le rette falliscono i servizi non partono. Test in
  `genera-rette-sede-scrittura.test.ts` con le rpc dei servizi in un array **separato** da `h.chiamate`.
- **T5 · Route `src/app/api/pagamenti/genera-servizi/route.ts`** (`withRoute`, `requireStaff`, zod):
  GET anteprima (`servizi_da_generare`), POST generazione manuale; 503 `SERVIZI_NON_DISPONIBILI` se
  lo schema manca (DB E2E non migrato).
- **T6 · Route iscrizioni `src/app/api/pagamenti/servizi/route.ts`**: GET (servizi mensili + iscritti
  della sede; `{ non_disponibile: true }` se lo schema manca), POST (controllo sovrapposizioni prima,
  insert semplice, 23P01 → 409), PATCH (importo/dal/al) e DELETE sempre `.eq('scuola_id')`;
  **fine/eliminazione in due tempi**: senza `voci_future` risponde l'elenco delle voci fuori periodo
  (eliminabili vs intoccabili); con `voci_future: 'elimina' | 'mantieni'` esegue (eliminando solo
  le non pagate/non fatturate, con lo stesso predicato della cancellazione voce esistente in
  `/api/pagamenti`), audit e log col conteggio.
- **T7 · Route categorie**: zod POST/PATCH con `mensile` e `importo_mensile_default` (inseriti solo
  se presenti), log `categoria-aggiornata`, 23503 su DELETE → 409 `CATEGORIA_IN_USO`.
- **T8 · `CategorieManager`** estratto da `SettingsPanel.tsx:378-433` in un file suo, con
  `scuola_id` in GET/POST (oggi manca), casella «Mensile» + importo predefinito + Salva (PATCH).
- **T9 · Navigazione**: `'servizi'` dopo `'genera'` in `ContabilitaNav.tsx`; in
  `admin/pagamenti/page.tsx` la vista va dentro `SedeRequired` ed è esclusa dal ramo multi-sede.
- **T10 · `ServiziPanel.tsx`**: una scheda per servizio (alunno, classe, importo `formatEuro`,
  dal/al, Modifica/Termina/Elimina), «Aggiungi iscritti» con `SelettoreAlunni` (importo proposto,
  mese d'inizio obbligatorio, esclusi i già iscritti nel periodo), finestra «cosa fare delle voci
  future», «Genera servizi del mese» con anteprima, stati vuoti («attivalo in Impostazioni»,
  `non_disponibile`). Aggiunta a `CHIAMANTI` di `limite-elenco-alunni.test.ts`.
- **T11 · `GeneratoreRette`**: riga «N voci di servizi generate» o avviso se `servizi.errore`.
- **T12 · E2E** `e2e/admin-contabilita.spec.ts`: `?vista=servizi` mostra il titolo sia con schema
  assente sia con elenco vuoto (verifica solo in CI).
- **T13 · PRD, gate, rilascio**: changelog + schema nel PRD; gate completi; prima del merge solo
  letture (`count(*)` di `pagamenti`, `payment_categories`, `enrollment_submissions`); la migrazione
  la applica **l'integrazione al merge** (mai `apply_migration` a mano); dopo il merge solo letture
  (colonne, 0 righe, privilegi, conteggio pagamenti invariato, `get_advisors` 0 ERROR). Poi PR-B:
  fotografie rigenerate dalla produzione, `MIGRAZIONI_ATTESE_AL_MERGE` svuotata,
  `iscrizioni_servizi` in `NOT_NULL_ATTESE`.

Trappole note: `ON CONFLICT` su indice parziale vuole il WHERE identico (42P10);
`date_trunc` su `date` va castato a `timestamp`; niente upsert JS su `iscrizioni_servizi`
(`onconflict-arbitro`); il finto Supabase dei test lancia sulle rpc non emulate; lock
`errori-con-codice` sui file nuovi.



## Bozza SQL completa della migrazione (dal Plan agent, da verificare e adattare in T2)

Da verificare in T2 prima di scrivere il file: come `genera_rette_mensili` tratta gli alunni
`sospeso` (la bozza non li esclude: allinearsi alla retta), i nomi reali di `schools.operativa`,
`admin_settings.retta_giorno_scadenza` / `retta_giorno_visibilita`, `alunni.giorno_scadenza_pagamenti`,
la funzione `set_updated_at`, e il predicato ESATTO dell'indice `uq_pagamenti_categoria_mese`
(`pg_indexes`, non `pg_constraint`).

```sql
-- Servizi mensili. La applica l'INTEGRAZIONE al merge (version del file), mai a mano.
-- Idempotente. Non tocca genera_rette_*. creato_da SENZA FK a utenti (come fatture_coda).
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

ALTER TABLE public.payment_categories
  ADD COLUMN IF NOT EXISTS mensile boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS importo_mensile_default numeric(10,2);
DO $mig$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payment_categories_importo_mensile_chk') THEN
    ALTER TABLE public.payment_categories ADD CONSTRAINT payment_categories_importo_mensile_chk
      CHECK (importo_mensile_default IS NULL OR importo_mensile_default >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payment_categories_retta_non_mensile_chk') THEN
    ALTER TABLE public.payment_categories ADD CONSTRAINT payment_categories_retta_non_mensile_chk
      CHECK (NOT mensile OR slug IS DISTINCT FROM 'retta');
  END IF;
END $mig$;

CREATE TABLE IF NOT EXISTS public.iscrizioni_servizi (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id       uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  categoria_id    uuid NOT NULL REFERENCES public.payment_categories(id) ON DELETE RESTRICT,
  scuola_id       uuid NOT NULL REFERENCES public.schools(id),
  importo_mensile numeric(10,2) NOT NULL,
  dal             date NOT NULL,
  al              date,
  creato_da       uuid NOT NULL,
  creato_il       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT iscrizioni_servizi_importo_chk CHECK (importo_mensile >= 0),
  CONSTRAINT iscrizioni_servizi_dal_chk CHECK (EXTRACT(DAY FROM dal) = 1),
  CONSTRAINT iscrizioni_servizi_al_chk CHECK (al IS NULL OR (EXTRACT(DAY FROM al) = 1 AND al >= dal)),
  CONSTRAINT iscrizioni_servizi_no_sovrapposte EXCLUDE USING gist (
    alunno_id WITH =, categoria_id WITH =,
    daterange(dal, (al + interval '1 month')::date, '[)') WITH &&)
);
CREATE INDEX IF NOT EXISTS iscrizioni_servizi_sede_categoria_idx ON public.iscrizioni_servizi (scuola_id, categoria_id);
CREATE INDEX IF NOT EXISTS iscrizioni_servizi_alunno_idx ON public.iscrizioni_servizi (alunno_id);
DROP TRIGGER IF EXISTS trg_iscrizioni_servizi_updated_at ON public.iscrizioni_servizi;
CREATE TRIGGER trg_iscrizioni_servizi_updated_at BEFORE UPDATE ON public.iscrizioni_servizi
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.iscrizioni_servizi ENABLE ROW LEVEL SECURITY;   -- nessuna policy: solo service-role
REVOKE ALL ON TABLE public.iscrizioni_servizi FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.iscrizioni_servizi TO service_role;

-- Un predicato solo, per anteprima e conferma. plpgsql (non sql): non validato alla CREATE.
CREATE OR REPLACE FUNCTION public.servizi_da_generare(p_periodo date, p_scuola_id uuid, p_alunno_ids uuid[] DEFAULT NULL)
RETURNS TABLE (iscrizione_id uuid, alunno_id uuid, categoria_id uuid, importo numeric,
               scadenza date, visibile_dal date, descrizione text, gruppo text)
LANGUAGE plpgsql STABLE SET search_path TO 'public', 'pg_temp' AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT i.id, i.alunno_id, i.categoria_id, i.importo_mensile,
         -- STESSA formula della retta (20260731115341: righe 157-158, 188-189, 257)
         (p_periodo + ((COALESCE(al.giorno_scadenza_pagamenti, s.retta_giorno_scadenza, 5) - 1) || ' days')::interval)::date,
         ((p_periodo - interval '1 month')::date + ((COALESCE(s.retta_giorno_visibilita, 25) - 1) || ' days')::interval)::date,
         pc.nome || ' ' || to_char(p_periodo, 'MM/YYYY'),
         COALESCE(NULLIF(pc.slug, ''), 'servizio') || '-' || to_char(p_periodo, 'YYYY-MM')
    FROM public.iscrizioni_servizi i
    JOIN public.payment_categories pc ON pc.id = i.categoria_id
    JOIN public.alunni al ON al.id = i.alunno_id
    LEFT JOIN public.admin_settings s ON s.scuola_id = al.scuola_id
   WHERE i.scuola_id = p_scuola_id AND al.scuola_id = p_scuola_id
     AND (pc.scuola_id IS NULL OR pc.scuola_id = p_scuola_id)
     AND pc.mensile AND pc.attivo
     AND al.stato = 'iscritto'
     AND (al.classe_sezione IS NOT NULL OR al.section_id IS NOT NULL)
     AND i.importo_mensile > 0
     AND i.dal <= p_periodo AND (i.al IS NULL OR i.al >= p_periodo)
     AND (p_alunno_ids IS NULL OR i.alunno_id = ANY (p_alunno_ids))
     AND NOT EXISTS (SELECT 1 FROM public.pagamenti p
           WHERE p.alunno_id = i.alunno_id AND p.categoria_id = i.categoria_id
             AND p.tipo = ANY (ARRAY['singolo','padre','split']::pagamento_tipo[])
             -- stessa regola della Contabilità (parte 1): copre le voci storiche senza mese
             AND COALESCE(p.periodo_competenza, date_trunc('month', p.scadenza::timestamp)::date) = p_periodo);
END $$;

CREATE OR REPLACE FUNCTION public.genera_servizi_mensili(p_periodo date, p_scuola_id uuid, p_alunno_ids uuid[] DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_operativa boolean; v_n integer;
BEGIN
  IF p_scuola_id IS NULL THEN RAISE EXCEPTION 'genera_servizi_mensili: la sede (p_scuola_id) è obbligatoria'; END IF;
  IF p_periodo IS NULL OR EXTRACT(DAY FROM p_periodo) <> 1 THEN RAISE EXCEPTION 'genera_servizi_mensili: periodo non è il primo del mese'; END IF;
  IF p_alunno_ids IS NOT NULL AND cardinality(p_alunno_ids) = 0 THEN RAISE EXCEPTION 'genera_servizi_mensili: elenco alunni vuoto'; END IF;
  SELECT s.operativa INTO v_operativa FROM public.schools s WHERE s.id = p_scuola_id;
  IF v_operativa IS NULL THEN RAISE EXCEPTION 'genera_servizi_mensili: sede % inesistente', p_scuola_id; END IF;
  IF NOT v_operativa THEN RAISE EXCEPTION 'genera_servizi_mensili: sede % ferma, nessun servizio', p_scuola_id; END IF;

  INSERT INTO public.pagamenti (alunno_id, scuola_id, categoria_id, descrizione, importo, scadenza,
                                tipo, obbligatorio, gruppo, periodo_competenza, visibile_dal, stato)
  SELECT d.alunno_id, p_scuola_id, d.categoria_id, d.descrizione, d.importo, d.scadenza,
         'singolo'::pagamento_tipo, true, d.gruppo, p_periodo, d.visibile_dal, 'da_pagare'
    FROM public.servizi_da_generare(p_periodo, p_scuola_id, p_alunno_ids) d
  ON CONFLICT (alunno_id, categoria_id, periodo_competenza)
    WHERE categoria_id IS NOT NULL
      AND tipo = ANY (ARRAY['singolo','padre','split']::pagamento_tipo[])
      AND periodo_competenza IS NOT NULL
  DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.genera_servizi_anno(p_anno_inizio integer, p_scuola_id uuid, p_alunno_ids uuid[] DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_tot integer := 0; m integer;
BEGIN
  IF p_scuola_id IS NULL THEN RAISE EXCEPTION 'genera_servizi_anno: la sede (p_scuola_id) è obbligatoria'; END IF;
  FOR m IN 9..12 LOOP v_tot := v_tot + public.genera_servizi_mensili(make_date(p_anno_inizio, m, 1), p_scuola_id, p_alunno_ids); END LOOP;
  FOR m IN 1..6  LOOP v_tot := v_tot + public.genera_servizi_mensili(make_date(p_anno_inizio + 1, m, 1), p_scuola_id, p_alunno_ids); END LOOP;
  RETURN v_tot;
END $$;

REVOKE ALL ON FUNCTION public.servizi_da_generare(date, uuid, uuid[])    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_servizi_mensili(date, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.genera_servizi_anno(integer, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.servizi_da_generare(date, uuid, uuid[])    TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_servizi_mensili(date, uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.genera_servizi_anno(integer, uuid, uuid[]) TO service_role;

DO $mig$ DECLARE v_sede uuid; BEGIN
  IF to_regprocedure('public.genera_servizi_mensili(date,uuid,uuid[])') IS NULL
     OR to_regprocedure('public.genera_servizi_anno(integer,uuid,uuid[])') IS NULL
     OR to_regprocedure('public.servizi_da_generare(date,uuid,uuid[])') IS NULL
  THEN RAISE EXCEPTION 'firme dei servizi non come attese'; END IF;
  IF has_function_privilege('authenticated','public.genera_servizi_mensili(date,uuid,uuid[])','EXECUTE')
     OR has_function_privilege('anon','public.genera_servizi_mensili(date,uuid,uuid[])','EXECUTE')
     OR has_table_privilege('authenticated','public.iscrizioni_servizi','SELECT')
     OR has_table_privilege('anon','public.iscrizioni_servizi','SELECT')
  THEN RAISE EXCEPTION 'REVOKE non ha morso'; END IF;
  SELECT id INTO v_sede FROM public.schools WHERE operativa = false LIMIT 1;
  IF v_sede IS NOT NULL THEN
    BEGIN
      PERFORM public.genera_servizi_mensili(date '2026-09-01', v_sede, NULL);
      RAISE EXCEPTION 'SONDA FALLITA: generazione permessa';
    EXCEPTION WHEN raise_exception THEN
      IF position('ferma, nessun servizio' in SQLERRM) = 0 THEN RAISE; END IF;
    END;
  END IF;
END $mig$;
NOTIFY pgrst, 'reload schema';
```

Trappole specifiche (dal Plan agent): R2 il finto Supabase dei test lancia sulle rpc non emulate
(da qui il try/catch dentro `generaServizi` e l'array separato nei test di genera-rette); R3 lock
`errori-con-codice` sui file nuovi; R4 in `admin/pagamenti/page.tsx` la vista `servizi` va esclusa
dalla condizione `vista !== 'genera' && vista !== 'causali'`; R6 la sonda di `20260907192611` non può
fallire (messaggio uguale a quello accettato); R7 niente upsert JS su `iscrizioni_servizi`;
R8 `CategorieManager` oggi non manda `scuola_id`.
