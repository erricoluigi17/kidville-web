-- =============================================================================
-- CRM DELLA SEGRETERIA · LA QUOTA D'ISCRIZIONE IN CONTABILITÀ E LE SETTIMANE DI DISPONIBILITÀ
--
-- Specifica: docs/superpowers/specs/2026-10-31-crm-quota-e-disponibilita-design.md
-- Piano:     docs/superpowers/plans/2026-10-31-crm-quota-e-disponibilita.md  (Compito 1)
--
-- ── COSA CAMBIA ──────────────────────────────────────────────────────────────
-- 1. `crm_bambini` porta la quota d'iscrizione (importo, metodo, anno, stato, giorno del pagamento, chi
--    l'ha segnata) e il collegamento all'alunno in anagrafica. La vecchia spunta `quota_saldata` resta nel
--    database ma è dismessa: la verità è `quota_stato`.
-- 2. `crm_eventi.tipo` ammette cinque tipi nuovi (quota in contabilità, quota corretta, quota tolta,
--    alunno collegato, alunno scollegato).
-- 3. Le disponibilità non sono più una settimana tipo che vale per sempre: `crm_settimane` (la testata, per
--    sede o per persona) e `crm_fasce` (le fasce di quella settimana) sostituiscono `crm_disponibilita`.
--    Una settimana mai registrata eredita la più recente non successiva: lo risolve il codice, qui si
--    garantisce solo che la copia-e-modifica sia UNA scrittura (`crm_salva_settimana`).
-- 4. Cinque funzioni, tutte solo del service_role, che fanno in UNA transazione ciò che altrimenti
--    sarebbero quattro o cinque chiamate separate (la famiglia di difetti pagata con `registra_incasso_voce`):
--    `crm_quota_passa`, `crm_quota_segna`, `crm_quota_togli`, `crm_aggancia_alunno`, `crm_salva_settimana`.
-- 5. I tre report di cassa (`report_cassa_aggregato`, `report_cassa_dettaglio`,
--    `conteggio_cassa_provenienza`) non contano più un movimento di cassa «assorbito» da un incasso.
--
-- ── LE SCELTE CHE NON SI VEDONO DAL CODICE ───────────────────────────────────
-- A. IL DOPPIO CONTEGGIO. Un'entrata di cassa registrata dal CRM (contanti, bambino non ancora alunno)
--    e l'incasso in contanti che nasce quando la quota passa in contabilità sono lo STESSO denaro. La cassa
--    somma i movimenti veri e, come entrate virtuali, gli incassi in contanti delle voci: senza una regola
--    il totale del giorno salirebbe. Regola: un movimento con `incasso_id` valorizzato è ASSORBITO da quell'
--    incasso e non si conta (`cassa_movimenti.incasso_id` esiste dalla migrazione della cassa; oggi nessun
--    movimento lo porta). I tre report qui sotto lo applicano; gli altri punti che sommano la cassa li
--    sistema il codice (stessa regola, una funzione pura condivisa).
-- B. LA RIGA DEL BAMBINO SI BLOCCA PER PRIMA (`FOR UPDATE`): il doppio clic su «Segna la quota» mette in
--    fila le due richieste, e la seconda trova la quota già segnata invece di scrivere una seconda entrata
--    in cassa. Lo stesso vale per il passaggio in contabilità e per l'aggancio.
-- C. LA VOCE «ISCRIZIONE» NASCE COME NASCE IN CONTABILITÀ: stessi campi di `POST /api/pagamenti`, e
--    l'incasso passa da `registra_incasso_voce` (residuo ricalcolato dopo il blocco, stato pagato,
--    audit). Mai un INSERT scritto a parte sugli incassi. Il bonifico NON crea un incasso: la voce nasce
--    aperta e la chiude la banca (decisione di Luigi, 31/10/2026).
-- D. `periodo_competenza` è il 1° settembre dell'anno d'apertura (2027-09-01 per il 2027/28): la
--    fatturazione sceglie la serie dall'anno di competenza.
-- E. NESSUN UUID DI SEDE SCRITTO A MANO: la categoria «Iscrizione» si ritrova per slug, come categoria di
--    sistema e globale; la sede di ogni scrittura è quella del bambino.
-- F. LE CHIAVI VERSO `utenti` NUOVE (`crm_settimane.utente_id`, `crm_settimane.aggiornata_da`) sono NO
--    ACTION, come le altre tracce di chi ha scritto nel CRM.
-- G. RLS ACCESA E NESSUNA POLICY sulle due tabelle nuove: le legge solo il service-role, dopo il gate di
--    sede dell'applicazione (come le altre sette tabelle `crm_*`).
-- H. GLI EVENTI DI UNA STESSA TRANSAZIONE PORTANO `clock_timestamp()`, non `now()`: «alunno collegato» e
--    «quota in contabilità» nascono insieme, e con lo stesso istante la cronologia li ordinerebbe a caso.
-- I. IL CONTRO-MOVIMENTO DELLO STORNO PORTA LA DATA DELLO STORNO (oggi), come in `storno/route.ts`: il
--    totale di un giorno passato non si riscrive, la correzione appare nel giorno in cui è stata fatta.
--
-- ── COME SI APPLICA ──────────────────────────────────────────────────────────
-- La applica l'INTEGRAZIONE Supabase al merge, con la version di questo file: mai a mano. Supabase la
-- esegue in una transazione sola, quindi se una riga fallisce non resta niente a metà.
-- NON è rieseguibile: converte e poi toglie `crm_disponibilita`. Le fotografie delle guardie (migrazioni,
-- indici unici, RLS, FK) si rigenerano in una PR-B successiva.
-- =============================================================================

-- ── 1) crm_bambini: la quota d'iscrizione e il collegamento all'alunno ───────
ALTER TABLE public.crm_bambini
  ADD COLUMN IF NOT EXISTS quota_importo numeric(10,2) CHECK (quota_importo > 0),
  ADD COLUMN IF NOT EXISTS quota_metodo text CHECK (quota_metodo IN ('contanti','carta','bonifico')),
  -- l'anno d'apertura dell'anno scolastico: 2027 per il 2027/28
  ADD COLUMN IF NOT EXISTS quota_anno smallint CHECK (quota_anno BETWEEN 2000 AND 2100),
  ADD COLUMN IF NOT EXISTS quota_stato text CHECK (quota_stato IN ('senza_importo','in_attesa','in_contabilita','bloccata')),
  ADD COLUMN IF NOT EXISTS quota_blocco_motivo text CHECK (quota_blocco_motivo IN ('gia_pagata','supera_residuo','piu_voci','entrata_stornata')),
  -- l'entrata registrata in cassa (solo contanti) finché il bambino non è un alunno
  ADD COLUMN IF NOT EXISTS quota_cassa_movimento_id uuid REFERENCES public.cassa_movimenti(id) ON DELETE SET NULL,
  -- la voce «Iscrizione AAAA/AA» in contabilità, quando la quota ci è passata
  ADD COLUMN IF NOT EXISTS quota_pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE SET NULL,
  -- l'alunno in anagrafica: un bambino del CRM a UN alunno, e un alunno a UN bambino
  ADD COLUMN IF NOT EXISTS alunno_id uuid REFERENCES public.alunni(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS alunno_collegato_il timestamptz;

ALTER TABLE public.crm_bambini
  ADD CONSTRAINT crm_bambini_alunno_unico UNIQUE (alunno_id),
  -- una quota segnata ha tutti i suoi dati; solo la vecchia spunta («senza importo») può non averli
  ADD CONSTRAINT crm_bambini_quota_completa CHECK (
    quota_stato IS NULL
    OR quota_stato = 'senza_importo'
    OR (quota_importo IS NOT NULL AND quota_metodo IS NOT NULL AND quota_anno IS NOT NULL AND quota_saldata_il IS NOT NULL)
  ),
  -- il motivo c'è se e solo se la quota è bloccata
  ADD CONSTRAINT crm_bambini_quota_blocco CHECK ((quota_stato IS NOT DISTINCT FROM 'bloccata') = (quota_blocco_motivo IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_crm_bambini_quota_cassa_movimento ON public.crm_bambini (quota_cassa_movimento_id);
CREATE INDEX IF NOT EXISTS idx_crm_bambini_quota_pagamento ON public.crm_bambini (quota_pagamento_id);
-- la lista «quote ancora da portare in contabilità»: solo gli stati aperti, per sede
CREATE INDEX IF NOT EXISTS idx_crm_bambini_quote_aperte ON public.crm_bambini (scuola_id, quota_stato)
  WHERE quota_stato IN ('senza_importo','in_attesa','bloccata');

-- la vecchia spunta diventa «quota senza importo» (in produzione ce n'è una sola, nella sede Demo)
UPDATE public.crm_bambini SET quota_stato = 'senza_importo' WHERE quota_saldata AND quota_stato IS NULL;

COMMENT ON COLUMN public.crm_bambini.quota_saldata IS
  'dismessa dal 31/10/2026: la verità è quota_stato. Resta nel database, ma non la legge e non la scrive più nessuno.';
COMMENT ON COLUMN public.crm_bambini.quota_stato IS
  'Quota d''iscrizione: senza_importo (la vecchia spunta), in_attesa (manca l''alunno), in_contabilita (è la voce Iscrizione dell''alunno), bloccata (il passaggio non è automatico: vedi quota_blocco_motivo). NULL = nessuna quota.';
COMMENT ON COLUMN public.crm_bambini.alunno_id IS
  'L''alunno in anagrafica a cui il bambino del CRM è collegato. Unico: un alunno è di un solo bambino del CRM.';

-- ── 2) crm_eventi: cinque tipi nuovi nello storico ───────────────────────────
ALTER TABLE public.crm_eventi
  DROP CONSTRAINT crm_eventi_tipo_check,
  ADD CONSTRAINT crm_eventi_tipo_check CHECK (tipo IN ('creata','modificata','telefonata','nota','bambino_aggiunto','bambino_modificato','appuntamento_fissato','appuntamento_spostato','appuntamento_riassegnato','appuntamento_svolto','appuntamento_non_presentato','appuntamento_annullato','esito_cambiato','quota_segnata','domanda_collegata_auto','domanda_collegata_mano','domanda_da_associare','collegamento_tolto','domanda_respinta','altra_domanda','azione_pianificata','azione_fatta','azione_spostata','azione_cancellata','quota_in_contabilita','quota_corretta','quota_tolta','alunno_collegato','alunno_scollegato'));

-- ── 3) crm_settimane: la testata di una settimana di disponibilità ───────────
CREATE TABLE IF NOT EXISTS public.crm_settimane (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id     uuid NOT NULL REFERENCES public.schools(id),
  -- nullo = la sede (fasce senza nome: chi riceve lo sceglie chi fissa la visita)
  utente_id     uuid REFERENCES public.utenti(id),
  -- il lunedì della settimana
  settimana     date NOT NULL CHECK (extract(isodow FROM settimana) = 1),
  aggiornata_da uuid REFERENCES public.utenti(id),
  aggiornata_il timestamptz NOT NULL DEFAULT now(),
  creata_il     timestamptz NOT NULL DEFAULT now(),
  -- una testata per sede+proprietario+settimana; i NULL non sono distinti, altrimenti la sede avrebbe più testate
  CONSTRAINT crm_settimane_proprietario UNIQUE NULLS NOT DISTINCT (scuola_id, utente_id, settimana),
  -- la chiave a cui puntano le fasce: serve a impedire che una fascia cambi sede
  UNIQUE (id, scuola_id)
);

ALTER TABLE public.crm_settimane ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_settimane_utente ON public.crm_settimane (utente_id);
CREATE INDEX IF NOT EXISTS idx_crm_settimane_aggiornata_da ON public.crm_settimane (aggiornata_da);

COMMENT ON TABLE public.crm_settimane IS
  'CRM segreteria: una settimana di disponibilità di un proprietario (una persona, o la sede con utente_id nullo). Le fasce di una settimana mai registrata sono quelle della più recente non successiva. Una testata senza fasce è una settimana volutamente vuota. RLS accesa e nessuna policy: la legge solo il service-role.';

-- ── 4) crm_fasce: le fasce di una settimana ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_fasce (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id        uuid NOT NULL REFERENCES public.schools(id),
  settimana_id     uuid NOT NULL,
  -- 1 = lunedì … 7 = domenica (ISO)
  giorno_settimana smallint NOT NULL CHECK (giorno_settimana BETWEEN 1 AND 7),
  ora_inizio       time NOT NULL,
  ora_fine         time NOT NULL,
  durata_slot_min  smallint NOT NULL DEFAULT 45 CHECK (durata_slot_min BETWEEN 15 AND 240),
  CHECK (ora_fine > ora_inizio),
  -- la fascia e la sede viaggiano con la loro settimana: il database, non il codice, impedisce il plesso sbagliato
  FOREIGN KEY (settimana_id, scuola_id) REFERENCES public.crm_settimane (id, scuola_id) ON DELETE CASCADE
);

ALTER TABLE public.crm_fasce ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_fasce_settimana ON public.crm_fasce (settimana_id, scuola_id);
CREATE INDEX IF NOT EXISTS idx_crm_fasce_scuola ON public.crm_fasce (scuola_id);

COMMENT ON TABLE public.crm_fasce IS
  'CRM segreteria: le fasce orarie (giorno ISO, dalle, alle, durata dello slot) di una settimana di disponibilità. Gli orari sono di Roma. Figlia di crm_settimane con chiave composta (settimana_id, scuola_id).';

-- ── 5) la conversione, e poi crm_disponibilita se ne va ──────────────────────
-- Una settimana per ogni (sede, persona) che ha fasce ancora valide, nella settimana in corso, con le sue
-- fasce copiate. Le fasce già scadute non si portano: non servirebbero a nessuno.
WITH proprietari AS (
  SELECT DISTINCT d.scuola_id, d.utente_id
    FROM public.crm_disponibilita d
   WHERE d.valida_al IS NULL OR d.valida_al >= CURRENT_DATE
), nuove AS (
  INSERT INTO public.crm_settimane (scuola_id, utente_id, settimana)
  SELECT p.scuola_id, p.utente_id, date_trunc('week', CURRENT_DATE)::date
    FROM proprietari p
  RETURNING id, scuola_id, utente_id
)
INSERT INTO public.crm_fasce (scuola_id, settimana_id, giorno_settimana, ora_inizio, ora_fine, durata_slot_min)
SELECT d.scuola_id, n.id, d.giorno_settimana, d.ora_inizio, d.ora_fine, d.durata_slot_min
  FROM public.crm_disponibilita d
  JOIN nuove n ON n.scuola_id = d.scuola_id AND n.utente_id = d.utente_id
 WHERE d.valida_al IS NULL OR d.valida_al >= CURRENT_DATE;

-- distruttiva approvata: crm_disponibilita sostituita da crm_settimane/crm_fasce (spec 2026-10-31 §6.2, approvata da Luigi); l'unica riga, sede Demo, è copiata sopra
DROP TABLE public.crm_disponibilita;

-- ── 6) le cinque funzioni ────────────────────────────────────────────────────

-- 6a) crm_quota_passa: la quota di un bambino diventa una voce in contabilità ---------------------------
CREATE OR REPLACE FUNCTION public.crm_quota_passa(
  p_bambino_id  uuid,
  p_eseguito_da uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_b            public.crm_bambini%ROWTYPE;
  v_sede_alunno  uuid;
  v_categoria    uuid;
  v_inizio_anno  date;
  v_voci         uuid[];
  v_voce_id      uuid;
  v_voce_nuova   boolean := false;
  v_importo_voce numeric;
  v_sconto       numeric;
  v_pagato       numeric;
  v_residuo      numeric;
  v_stornato     timestamptz;
  v_motivo       text;
  v_esito        jsonb;
  v_incasso_id   uuid;
  v_righe        integer;
  v_via          text := CASE WHEN p_eseguito_da IS NULL THEN 'sistema' ELSE 'segreteria' END;
BEGIN
  SELECT * INTO v_b FROM public.crm_bambini WHERE id = p_bambino_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;
  IF v_b.quota_stato = 'in_contabilita' THEN
    RETURN jsonb_build_object('esito', 'gia_in_contabilita', 'pagamento_id', v_b.quota_pagamento_id);
  END IF;
  IF v_b.quota_stato IS NULL OR v_b.quota_stato NOT IN ('in_attesa', 'bloccata') OR v_b.alunno_id IS NULL THEN
    RETURN jsonb_build_object('esito', 'non_pronta');
  END IF;

  -- L'alunno deve essere della sede del bambino: la quota non passa mai in un altro plesso.
  SELECT a.scuola_id INTO v_sede_alunno FROM public.alunni a WHERE a.id = v_b.alunno_id;
  IF NOT FOUND OR v_sede_alunno IS DISTINCT FROM v_b.scuola_id THEN
    RETURN jsonb_build_object('esito', 'sede_diversa');
  END IF;

  SELECT c.id INTO v_categoria
    FROM public.payment_categories c
   WHERE c.slug = 'iscrizione' AND c.is_sistema AND c.scuola_id IS NULL
   ORDER BY c.id
   LIMIT 1;
  IF v_categoria IS NULL THEN
    RETURN jsonb_build_object('esito', 'categoria_assente');
  END IF;

  -- Le voci «Iscrizione» che l'alunno ha già per quell'anno (competenza al 1° settembre, oppure senza
  -- competenza ma con scadenza dentro l'anno scolastico), bloccate: nessuno le cambia mentre decidiamo.
  v_inizio_anno := make_date(v_b.quota_anno::int, 9, 1);
  SELECT array_agg(x.id ORDER BY x.id) INTO v_voci
    FROM (
      SELECT p.id
        FROM public.pagamenti p
       WHERE p.alunno_id = v_b.alunno_id
         AND p.categoria_id = v_categoria
         AND (p.periodo_competenza = v_inizio_anno
              OR (p.periodo_competenza IS NULL
                  AND p.scadenza BETWEEN v_inizio_anno AND make_date(v_b.quota_anno::int + 1, 8, 31)))
       ORDER BY p.id
         FOR UPDATE
    ) x;

  IF coalesce(cardinality(v_voci), 0) > 1 THEN
    -- Due voci per lo stesso alunno e anno: non si sceglie a caso.
    v_motivo := 'piu_voci';
  ELSIF v_b.quota_metodo = 'contanti' AND v_b.quota_cassa_movimento_id IS NOT NULL THEN
    SELECT m.stornato_il INTO v_stornato
      FROM public.cassa_movimenti m
     WHERE m.id = v_b.quota_cassa_movimento_id
       FOR UPDATE;
    IF v_stornato IS NOT NULL THEN
      -- La cassa ha stornato l'entrata del CRM: passarla in contabilità creerebbe soldi che non ci sono.
      v_motivo := 'entrata_stornata';
    END IF;
  END IF;

  IF v_motivo IS NULL AND coalesce(cardinality(v_voci), 0) = 1 THEN
    SELECT p.importo, coalesce(p.sconto, 0), coalesce(p.importo_pagato, 0)
      INTO v_importo_voce, v_sconto, v_pagato
      FROM public.pagamenti p
     WHERE p.id = v_voci[1];
    v_residuo := v_importo_voce - v_sconto - v_pagato;
    IF v_residuo <= 0.005 THEN
      v_motivo := 'gia_pagata';
    ELSIF v_b.quota_metodo = 'bonifico' THEN
      -- La quota si lega alla voce aperta: la chiuderà la banca.
      v_voce_id := v_voci[1];
    ELSIF v_b.quota_importo > v_residuo + 0.005 THEN
      v_motivo := 'supera_residuo';
    ELSE
      v_voce_id := v_voci[1];
    END IF;
  END IF;

  IF v_motivo IS NOT NULL THEN
    UPDATE public.crm_bambini
       SET quota_stato = 'bloccata', quota_blocco_motivo = v_motivo, aggiornata_il = now()
     WHERE id = p_bambino_id AND scuola_id = v_b.scuola_id;
    RETURN jsonb_build_object('esito', 'bloccata', 'motivo', v_motivo);
  END IF;

  IF v_voce_id IS NULL THEN
    -- Nessuna voce: nasce con gli stessi campi di POST /api/pagamenti.
    INSERT INTO public.pagamenti
      (alunno_id, scuola_id, descrizione, importo, scadenza, categoria_id, tipo, obbligatorio,
       periodo_competenza, gruppo, creato_da, stato)
    VALUES
      (v_b.alunno_id, v_b.scuola_id,
       'Iscrizione ' || v_b.quota_anno::text || '/' || lpad(((v_b.quota_anno + 1) % 100)::text, 2, '0'),
       v_b.quota_importo, v_b.quota_saldata_il, v_categoria, 'singolo', true,
       v_inizio_anno, NULL, v_b.quota_segnata_da, 'da_pagare')
    RETURNING id INTO v_voce_id;
    v_voce_nuova := true;
  END IF;

  IF v_b.quota_metodo IN ('contanti', 'carta') THEN
    -- Lo stesso percorso della contabilità: residuo ricalcolato dopo il blocco, stato pagato, audit.
    v_esito := public.registra_incasso_voce(
      p_pagamento_id  => v_voce_id,
      p_importo       => v_b.quota_importo,
      p_registrato_da => v_b.quota_segnata_da,
      p_data_incasso  => v_b.quota_saldata_il,
      p_metodo        => CASE v_b.quota_metodo WHEN 'carta' THEN 'pos' ELSE 'contanti' END,
      p_note          => 'Quota d''iscrizione dal CRM'
    );
    IF v_esito->>'esito' IS DISTINCT FROM 'ok' OR (v_esito->'incasso'->>'id') IS NULL THEN
      -- Si disfa tutto, voce nuova compresa: meglio nessun passaggio che un passaggio a metà.
      RAISE EXCEPTION 'registra_incasso_voce non ha registrato la quota del bambino % (esito %)',
        p_bambino_id, coalesce(v_esito->>'esito', 'nullo');
    END IF;
    v_incasso_id := (v_esito->'incasso'->>'id')::uuid;

    IF v_b.quota_metodo = 'contanti' AND v_b.quota_cassa_movimento_id IS NOT NULL THEN
      -- L'entrata di cassa è il denaro di questo incasso: da ora lo rappresenta l'incasso e il movimento
      -- non si conta più. Il totale del giorno resta identico.
      UPDATE public.cassa_movimenti
         SET incasso_id = v_incasso_id
       WHERE id = v_b.quota_cassa_movimento_id
         AND scuola_id = v_b.scuola_id
         AND incasso_id IS NULL
         AND stornato_il IS NULL;
      GET DIAGNOSTICS v_righe = ROW_COUNT;
      IF v_righe = 0 THEN
        RAISE EXCEPTION 'l''entrata di cassa % non si aggancia all''incasso %', v_b.quota_cassa_movimento_id, v_incasso_id;
      END IF;
    END IF;
  END IF;

  UPDATE public.crm_bambini
     SET quota_stato = 'in_contabilita', quota_pagamento_id = v_voce_id, quota_blocco_motivo = NULL,
         aggiornata_il = now()
   WHERE id = p_bambino_id AND scuola_id = v_b.scuola_id;

  INSERT INTO public.crm_eventi (scuola_id, scheda_id, tipo, autore, autore_via, dati, creato_il)
  VALUES (v_b.scuola_id, v_b.scheda_id, 'quota_in_contabilita', p_eseguito_da, v_via,
          jsonb_build_object('bambino_id', p_bambino_id, 'pagamento_id', v_voce_id, 'incasso_id', v_incasso_id,
                             'importo', v_b.quota_importo, 'metodo', v_b.quota_metodo, 'anno', v_b.quota_anno),
          clock_timestamp());

  RETURN jsonb_build_object('esito', 'ok', 'pagamento_id', v_voce_id, 'incasso_id', v_incasso_id,
                            'voce_nuova', v_voce_nuova, 'metodo', v_b.quota_metodo);
END $$;

REVOKE ALL ON FUNCTION public.crm_quota_passa(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_quota_passa(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.crm_quota_passa(uuid, uuid) IS
  'CRM: la quota d''iscrizione di un bambino collegato a un alunno diventa la voce Iscrizione AAAA/AA in contabilita'' (o si lega a quella che l''alunno ha gia'', o resta bloccata con un motivo). Una transazione sola, riga del bambino bloccata. Contanti e carta: incasso da registra_incasso_voce e, per i contanti, entrata di cassa assorbita (incasso_id). Bonifico: voce da pagare, nessun incasso. Solo service_role.';

-- 6b) crm_quota_segna: segna o corregge la quota ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_quota_segna(
  p_bambino_id  uuid,
  p_importo     numeric,
  p_metodo      text,
  p_giorno      date,
  p_anno        smallint,
  p_eseguito_da uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_b          public.crm_bambini%ROWTYPE;
  v_mov        public.cassa_movimenti%ROWTYPE;
  v_importo    numeric(10,2) := round(p_importo, 2);
  v_categoria  uuid;
  v_contro     uuid;
  v_nuovo_mov  uuid;
  v_etichetta  text;
  v_corretta   boolean;
  v_passaggio  jsonb;
  v_via        text := CASE WHEN p_eseguito_da IS NULL THEN 'sistema' ELSE 'segreteria' END;
BEGIN
  SELECT * INTO v_b FROM public.crm_bambini WHERE id = p_bambino_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;
  IF v_b.quota_stato = 'in_contabilita' THEN
    RETURN jsonb_build_object('esito', 'in_contabilita', 'pagamento_id', v_b.quota_pagamento_id);
  END IF;

  -- La route valida prima; qui si rifiuta ciò che il database non saprebbe scrivere.
  IF p_importo IS NULL OR p_importo <= 0 OR p_importo <> v_importo THEN
    RAISE EXCEPTION 'importo non valido' USING ERRCODE = '22023';
  END IF;
  IF p_metodo IS NULL OR p_metodo NOT IN ('contanti', 'carta', 'bonifico') THEN
    RAISE EXCEPTION 'metodo non valido' USING ERRCODE = '22023';
  END IF;
  IF p_giorno IS NULL OR p_anno IS NULL THEN
    RAISE EXCEPTION 'giorno e anno sono obbligatori' USING ERRCODE = '22023';
  END IF;

  IF p_metodo = 'contanti' THEN
    SELECT c.id INTO v_categoria
      FROM public.payment_categories c
     WHERE c.slug = 'iscrizione' AND c.is_sistema AND c.scuola_id IS NULL
     ORDER BY c.id
     LIMIT 1;
    IF v_categoria IS NULL THEN
      RETURN jsonb_build_object('esito', 'categoria_assente');
    END IF;
  END IF;

  -- Se c'è già un'entrata di contanti non stornata, la si storna come fa la cassa: contro-movimento,
  -- marcatura dell'originale e riga nel registro modifiche. Mai una riga cancellata.
  IF v_b.quota_cassa_movimento_id IS NOT NULL THEN
    SELECT * INTO v_mov
      FROM public.cassa_movimenti m
     WHERE m.id = v_b.quota_cassa_movimento_id AND m.scuola_id = v_b.scuola_id
       FOR UPDATE;
    IF FOUND AND v_mov.stornato_il IS NULL THEN
      IF v_mov.incasso_id IS NOT NULL OR v_mov.storno_di IS NOT NULL OR v_mov.chiusura_id IS NOT NULL THEN
        RAISE EXCEPTION 'il movimento di cassa % non si storna dalla quota', v_mov.id;
      END IF;
      INSERT INTO public.cassa_movimenti
        (scuola_id, tipo, importo, metodo, categoria_id, cassa_categoria_id, storno_di, registrato_da)
      VALUES
        (v_mov.scuola_id, v_mov.tipo, -v_mov.importo, v_mov.metodo, v_mov.categoria_id, v_mov.cassa_categoria_id,
         v_mov.id, p_eseguito_da)
      RETURNING id INTO v_contro;
      UPDATE public.cassa_movimenti
         SET stornato_il = now(), storno_motivo = 'Quota d''iscrizione corretta dal CRM'
       WHERE id = v_mov.id;
      INSERT INTO public.registro_modifiche
        (azione, tabella_interessata, record_id, vecchio_valore, nuovo_valore, utente_id)
      VALUES
        ('storno_cassa_movimento', 'cassa_movimenti', v_mov.id,
         jsonb_build_object('id', v_mov.id, 'scuola_id', v_mov.scuola_id, 'tipo', v_mov.tipo,
                            'importo', v_mov.importo, 'metodo', v_mov.metodo, 'categoria_id', v_mov.categoria_id,
                            'cassa_categoria_id', v_mov.cassa_categoria_id, 'stornato_il', v_mov.stornato_il,
                            'storno_di', v_mov.storno_di, 'chiusura_id', v_mov.chiusura_id,
                            'incasso_id', v_mov.incasso_id),
         jsonb_build_object('storno_motivo', 'Quota d''iscrizione corretta dal CRM', 'contro_movimento_id', v_contro),
         p_eseguito_da);
    END IF;
  END IF;

  IF p_metodo = 'contanti' THEN
    -- L'entrata nella cassa del giorno: i contanti sono nel cassetto oggi, anche se il bambino non è ancora
    -- un alunno. La descrizione la leggono solo gli staff della sede e non entra mai in un log.
    v_etichetta := p_anno::text || '/' || lpad(((p_anno + 1) % 100)::text, 2, '0');
    INSERT INTO public.cassa_movimenti
      (scuola_id, tipo, importo, metodo, data, cassa_categoria_id, categoria_id, descrizione, registrato_da)
    VALUES
      (v_b.scuola_id, 'entrata', v_importo, 'contanti', p_giorno, v_categoria, NULL,
       format('Quota d''iscrizione %s – %s (CRM)', v_etichetta, coalesce(nullif(btrim(v_b.nome), ''), 'bambino')),
       p_eseguito_da)
    RETURNING id INTO v_nuovo_mov;
  END IF;

  v_corretta := v_b.quota_importo IS NOT NULL;

  UPDATE public.crm_bambini
     SET quota_importo = v_importo, quota_metodo = p_metodo, quota_anno = p_anno,
         quota_stato = 'in_attesa', quota_blocco_motivo = NULL,
         quota_saldata_il = p_giorno, quota_segnata_da = p_eseguito_da,
         quota_cassa_movimento_id = v_nuovo_mov, quota_pagamento_id = NULL,
         aggiornata_il = now()
   WHERE id = p_bambino_id AND scuola_id = v_b.scuola_id;

  INSERT INTO public.crm_eventi (scuola_id, scheda_id, tipo, autore, autore_via, dati, creato_il)
  VALUES (v_b.scuola_id, v_b.scheda_id,
          CASE WHEN v_corretta THEN 'quota_corretta' ELSE 'quota_segnata' END,
          p_eseguito_da, v_via,
          jsonb_build_object('bambino_id', p_bambino_id, 'importo', v_importo, 'metodo', p_metodo,
                             'giorno', p_giorno, 'anno', p_anno, 'movimento_id', v_nuovo_mov),
          clock_timestamp());

  -- Se il bambino è già un alunno, la quota passa subito in contabilità, nella stessa transazione.
  IF v_b.alunno_id IS NOT NULL THEN
    v_passaggio := public.crm_quota_passa(p_bambino_id, p_eseguito_da);
  END IF;

  RETURN jsonb_build_object('esito', 'ok', 'movimento_id', v_nuovo_mov, 'corretta', v_corretta,
                            'passaggio', v_passaggio);
END $$;

REVOKE ALL ON FUNCTION public.crm_quota_segna(uuid, numeric, text, date, smallint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_quota_segna(uuid, numeric, text, date, smallint, uuid) TO service_role;

COMMENT ON FUNCTION public.crm_quota_segna(uuid, numeric, text, date, smallint, uuid) IS
  'CRM: segna o corregge la quota d''iscrizione di un bambino. Una transazione sola con la riga del bambino bloccata (il doppio clic non scrive due entrate). Contanti: entrata nella cassa del giorno, con storno tracciato di quella precedente. Se il bambino e'' gia'' un alunno passa subito in contabilita'' (crm_quota_passa). Solo service_role.';

-- 6c) crm_quota_togli: toglie la quota dal CRM ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_quota_togli(
  p_bambino_id  uuid,
  p_eseguito_da uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_b        public.crm_bambini%ROWTYPE;
  v_mov      public.cassa_movimenti%ROWTYPE;
  v_contro   uuid;
  v_stornato boolean := false;
  v_via      text := CASE WHEN p_eseguito_da IS NULL THEN 'sistema' ELSE 'segreteria' END;
BEGIN
  SELECT * INTO v_b FROM public.crm_bambini WHERE id = p_bambino_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;
  IF v_b.quota_stato = 'in_contabilita' THEN
    RETURN jsonb_build_object('esito', 'in_contabilita', 'pagamento_id', v_b.quota_pagamento_id);
  END IF;
  IF v_b.quota_stato IS NULL AND NOT coalesce(v_b.quota_saldata, false) THEN
    -- Niente da togliere: ripetere la richiesta non fa danni.
    RETURN jsonb_build_object('esito', 'ok', 'stornato', false);
  END IF;

  IF v_b.quota_cassa_movimento_id IS NOT NULL THEN
    SELECT * INTO v_mov
      FROM public.cassa_movimenti m
     WHERE m.id = v_b.quota_cassa_movimento_id AND m.scuola_id = v_b.scuola_id
       FOR UPDATE;
    IF FOUND AND v_mov.stornato_il IS NULL THEN
      IF v_mov.incasso_id IS NOT NULL OR v_mov.storno_di IS NOT NULL OR v_mov.chiusura_id IS NOT NULL THEN
        RAISE EXCEPTION 'il movimento di cassa % non si storna dalla quota', v_mov.id;
      END IF;
      INSERT INTO public.cassa_movimenti
        (scuola_id, tipo, importo, metodo, categoria_id, cassa_categoria_id, storno_di, registrato_da)
      VALUES
        (v_mov.scuola_id, v_mov.tipo, -v_mov.importo, v_mov.metodo, v_mov.categoria_id, v_mov.cassa_categoria_id,
         v_mov.id, p_eseguito_da)
      RETURNING id INTO v_contro;
      UPDATE public.cassa_movimenti
         SET stornato_il = now(), storno_motivo = 'Quota d''iscrizione tolta dal CRM'
       WHERE id = v_mov.id;
      INSERT INTO public.registro_modifiche
        (azione, tabella_interessata, record_id, vecchio_valore, nuovo_valore, utente_id)
      VALUES
        ('storno_cassa_movimento', 'cassa_movimenti', v_mov.id,
         jsonb_build_object('id', v_mov.id, 'scuola_id', v_mov.scuola_id, 'tipo', v_mov.tipo,
                            'importo', v_mov.importo, 'metodo', v_mov.metodo, 'categoria_id', v_mov.categoria_id,
                            'cassa_categoria_id', v_mov.cassa_categoria_id, 'stornato_il', v_mov.stornato_il,
                            'storno_di', v_mov.storno_di, 'chiusura_id', v_mov.chiusura_id,
                            'incasso_id', v_mov.incasso_id),
         jsonb_build_object('storno_motivo', 'Quota d''iscrizione tolta dal CRM', 'contro_movimento_id', v_contro),
         p_eseguito_da);
      v_stornato := true;
    END IF;
  END IF;

  UPDATE public.crm_bambini
     SET quota_importo = NULL, quota_metodo = NULL, quota_anno = NULL, quota_stato = NULL,
         quota_blocco_motivo = NULL, quota_saldata_il = NULL, quota_segnata_da = NULL,
         quota_cassa_movimento_id = NULL, quota_pagamento_id = NULL, quota_saldata = false,
         aggiornata_il = now()
   WHERE id = p_bambino_id AND scuola_id = v_b.scuola_id;

  INSERT INTO public.crm_eventi (scuola_id, scheda_id, tipo, autore, autore_via, dati, creato_il)
  VALUES (v_b.scuola_id, v_b.scheda_id, 'quota_tolta', p_eseguito_da, v_via,
          jsonb_build_object('bambino_id', p_bambino_id, 'importo', v_b.quota_importo, 'metodo', v_b.quota_metodo,
                             'anno', v_b.quota_anno, 'stornato', v_stornato),
          clock_timestamp());

  RETURN jsonb_build_object('esito', 'ok', 'stornato', v_stornato);
END $$;

REVOKE ALL ON FUNCTION public.crm_quota_togli(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_quota_togli(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.crm_quota_togli(uuid, uuid) IS
  'CRM: toglie la quota d''iscrizione di un bambino che non e'' ancora in contabilita'' (storna l''entrata di cassa, se c''e'', con lo storno tracciato della cassa; azzera i campi della quota). Una transazione sola, riga del bambino bloccata. Solo service_role.';

-- 6d) crm_aggancia_alunno: il bambino del CRM si collega a un alunno ------------------------------------
CREATE OR REPLACE FUNCTION public.crm_aggancia_alunno(
  p_bambino_id  uuid,
  p_alunno_id   uuid,
  p_eseguito_da uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_b           public.crm_bambini%ROWTYPE;
  v_sede_alunno uuid;
  v_vincolo     text;
  v_collegato   boolean := false;
  v_passaggio   jsonb;
  v_via         text := CASE WHEN p_eseguito_da IS NULL THEN 'sistema' ELSE 'segreteria' END;
BEGIN
  SELECT * INTO v_b FROM public.crm_bambini WHERE id = p_bambino_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovato');
  END IF;

  -- L'alunno deve esistere ed essere della stessa sede: un collegamento non attraversa i plessi.
  SELECT a.scuola_id INTO v_sede_alunno FROM public.alunni a WHERE a.id = p_alunno_id;
  IF NOT FOUND OR v_sede_alunno IS DISTINCT FROM v_b.scuola_id THEN
    RETURN jsonb_build_object('esito', 'sede_diversa');
  END IF;

  IF v_b.alunno_id IS NOT NULL AND v_b.alunno_id <> p_alunno_id THEN
    RETURN jsonb_build_object('esito', 'gia_collegato_altro');
  END IF;

  IF v_b.alunno_id IS NULL THEN
    BEGIN
      UPDATE public.crm_bambini
         SET alunno_id = p_alunno_id, alunno_collegato_il = now(), aggiornata_il = now()
       WHERE id = p_bambino_id AND scuola_id = v_b.scuola_id;
      v_collegato := true;
    EXCEPTION WHEN unique_violation THEN
      -- L'alunno è già di un altro bambino del CRM (l'import e un collegamento a mano arrivano insieme).
      GET STACKED DIAGNOSTICS v_vincolo = CONSTRAINT_NAME;
      IF v_vincolo IS DISTINCT FROM 'crm_bambini_alunno_unico' THEN
        RAISE;
      END IF;
      RETURN jsonb_build_object('esito', 'alunno_gia_collegato');
    END;

    INSERT INTO public.crm_eventi (scuola_id, scheda_id, tipo, autore, autore_via, dati, creato_il)
    VALUES (v_b.scuola_id, v_b.scheda_id, 'alunno_collegato', p_eseguito_da, v_via,
            jsonb_build_object('bambino_id', p_bambino_id, 'alunno_id', p_alunno_id),
            clock_timestamp());
  END IF;

  -- Una quota in attesa (o bloccata, da riprovare) passa in contabilità nella stessa transazione.
  IF v_b.quota_stato IN ('in_attesa', 'bloccata') THEN
    v_passaggio := public.crm_quota_passa(p_bambino_id, p_eseguito_da);
  END IF;

  RETURN jsonb_build_object('esito', 'ok', 'collegato', v_collegato, 'passaggio', v_passaggio);
END $$;

REVOKE ALL ON FUNCTION public.crm_aggancia_alunno(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_aggancia_alunno(uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.crm_aggancia_alunno(uuid, uuid, uuid) IS
  'CRM: collega un bambino del CRM a un alunno della stessa sede (uno solo per bambino, e un alunno a un solo bambino: la violazione di crm_bambini_alunno_unico diventa l''esito alunno_gia_collegato) e, se la quota e'' in attesa o bloccata, la passa in contabilita'' nella stessa transazione. Solo service_role.';

-- 6e) crm_salva_settimana: salva le fasce di un proprietario per una settimana ----------------------------
CREATE OR REPLACE FUNCTION public.crm_salva_settimana(
  p_scuola_id   uuid,
  p_utente_id   uuid,
  p_settimana   date,
  p_fasce       jsonb,
  p_eseguito_da uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_id            uuid;
  v_lunedi_corrente date;
  v_sovrapposte   boolean;
BEGIN
  IF p_scuola_id IS NULL OR p_settimana IS NULL OR p_fasce IS NULL OR jsonb_typeof(p_fasce) <> 'array' THEN
    RAISE EXCEPTION 'sede, settimana e fasce (un array) sono obbligatori' USING ERRCODE = '22023';
  END IF;

  IF extract(isodow FROM p_settimana) <> 1 THEN
    RETURN jsonb_build_object('esito', 'settimana_non_valida');
  END IF;
  -- Le settimane passate non si modificano: il lunedì della settimana in corso è quello di Roma.
  v_lunedi_corrente := date_trunc('week', now() AT TIME ZONE 'Europe/Rome')::date;
  IF p_settimana < v_lunedi_corrente THEN
    RETURN jsonb_build_object('esito', 'settimana_passata');
  END IF;

  -- Due fasce dello stesso giorno che si toccano (anche identiche) sono un errore di chi le ha scritte.
  WITH f AS (
    SELECT * FROM jsonb_to_recordset(p_fasce)
      AS x(giorno_settimana smallint, ora_inizio time, ora_fine time, durata_slot_min smallint)
  )
  SELECT EXISTS (
    SELECT 1 FROM f a
     WHERE (SELECT count(*) FROM f b
             WHERE b.giorno_settimana = a.giorno_settimana
               AND b.ora_inizio < a.ora_fine
               AND a.ora_inizio < b.ora_fine) > 1
  ) INTO v_sovrapposte;
  IF v_sovrapposte THEN
    RETURN jsonb_build_object('esito', 'fasce_sovrapposte');
  END IF;

  -- La testata: prende il lucchetto sulla riga, quindi due salvataggi della stessa settimana si mettono in fila.
  INSERT INTO public.crm_settimane (scuola_id, utente_id, settimana, aggiornata_da, aggiornata_il)
  VALUES (p_scuola_id, p_utente_id, p_settimana, p_eseguito_da, now())
  ON CONFLICT ON CONSTRAINT crm_settimane_proprietario
  DO UPDATE SET aggiornata_da = EXCLUDED.aggiornata_da, aggiornata_il = now()
  RETURNING id INTO v_id;

  -- Le fasce si SOSTITUISCONO: la copia di ciò che si ereditava e la modifica sono un'unica scrittura.
  -- Una lista vuota è una settimana volutamente vuota.
  DELETE FROM public.crm_fasce WHERE settimana_id = v_id AND scuola_id = p_scuola_id;
  INSERT INTO public.crm_fasce (scuola_id, settimana_id, giorno_settimana, ora_inizio, ora_fine, durata_slot_min)
  SELECT p_scuola_id, v_id, f.giorno_settimana, f.ora_inizio, f.ora_fine, coalesce(f.durata_slot_min, 45)
    FROM jsonb_to_recordset(p_fasce)
      AS f(giorno_settimana smallint, ora_inizio time, ora_fine time, durata_slot_min smallint);

  RETURN jsonb_build_object('esito', 'ok', 'settimana_id', v_id);
END $$;

REVOKE ALL ON FUNCTION public.crm_salva_settimana(uuid, uuid, date, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_salva_settimana(uuid, uuid, date, jsonb, uuid) TO service_role;

COMMENT ON FUNCTION public.crm_salva_settimana(uuid, uuid, date, jsonb, uuid) IS
  'CRM: salva in una sola scrittura tutte le fasce di un proprietario (una persona, o la sede con utente_id nullo) per una settimana: la testata si crea o si aggiorna e le fasce si sostituiscono. Rifiuta una settimana che non e'' un lunedi'', una settimana passata (a Roma) e fasce sovrapposte. Solo service_role.';

-- ── 7) i report di cassa non contano i movimenti assorbiti da un incasso ─────
-- Testo dell'ULTIMA migrazione che definisce ciascuna funzione, con una sola aggiunta: `AND m.incasso_id
-- IS NULL` a ogni lettura di `cassa_movimenti`. Firma e risultato restano identici.

-- 7a) report_cassa_aggregato (ultima definizione: 20261010084330)
CREATE OR REPLACE FUNCTION public.report_cassa_aggregato(
  p_scuola_ids      uuid[],
  p_da        date DEFAULT NULL,
  p_a         date DEFAULT NULL,
  p_categoria uuid DEFAULT NULL
) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
  WITH insieme AS (
    SELECT i.id, i.importo, i.metodo::text AS metodo, i.storno_di, i.data_incasso,
           p.scuola_id, p.categoria_id
      FROM public.incassi i
      JOIN public.pagamenti p ON p.id = i.pagamento_id
     WHERE p.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND (p_da IS NULL OR i.data_incasso >= p_da)
       AND (p_a  IS NULL OR i.data_incasso <= p_a)
       AND (p_categoria IS NULL OR p.categoria_id = p_categoria)
  ),
  entrate AS (
    SELECT s.scuola_id, s.categoria_id, s.importo, s.data_incasso,
           CASE WHEN s.storno_di IS NULL THEN s.metodo ELSE o.metodo END AS metodo_reale
      FROM insieme s
      LEFT JOIN insieme o ON o.id = s.storno_di
  ),
  reali AS (
    SELECT * FROM entrate
     WHERE metodo_reale IN ('contanti', 'bonifico', 'pos', 'assegno', 'altro')
  ),
  uscite AS (
    SELECT m.scuola_id, m.categoria_id, m.importo, m.metodo, m.data
      FROM public.cassa_movimenti m
     WHERE m.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND m.tipo = 'uscita'
       AND m.incasso_id IS NULL
       AND (p_da IS NULL OR m.data >= p_da)
       AND (p_a  IS NULL OR m.data <= p_a)
  ),
  entrate_gruppi AS (
    SELECT CASE WHEN GROUPING(r.scuola_id) = 1 THEN NULL ELSE r.scuola_id END AS scuola_id,
           r.categoria_id, max(pc.nome) AS categoria_nome, r.metodo_reale AS metodo,
           round(sum(r.importo), 2) AS importo
      FROM reali r
      LEFT JOIN public.payment_categories pc ON pc.id = r.categoria_id
     GROUP BY GROUPING SETS ((r.scuola_id, r.categoria_id, r.metodo_reale), (r.categoria_id, r.metodo_reale))
  ),
  uscite_gruppi AS (
    SELECT CASE WHEN GROUPING(u.scuola_id) = 1 THEN NULL ELSE u.scuola_id END AS scuola_id,
           u.categoria_id, max(cc.nome) AS categoria_nome,
           round(sum(u.importo), 2) AS totale,
           round(COALESCE(sum(u.importo) FILTER (WHERE u.metodo = 'contanti'), 0), 2) AS contanti,
           round(COALESCE(sum(u.importo) FILTER (WHERE u.metodo IS DISTINCT FROM 'contanti'), 0), 2) AS altri
      FROM uscite u
      LEFT JOIN public.cassa_categorie cc ON cc.id = u.categoria_id
     GROUP BY GROUPING SETS ((u.scuola_id, u.categoria_id), (u.categoria_id))
  ),
  mesi AS (
    SELECT scuola_id, to_char(data_incasso, 'YYYY-MM') AS mese, importo AS entrate, 0::numeric AS uscite
      FROM reali WHERE data_incasso IS NOT NULL
    UNION ALL
    SELECT scuola_id, to_char(data, 'YYYY-MM'), 0::numeric, importo
      FROM uscite WHERE data IS NOT NULL
  ),
  mensile_gruppi AS (
    SELECT CASE WHEN GROUPING(scuola_id) = 1 THEN NULL ELSE scuola_id END AS scuola_id,
           mese, round(sum(entrate), 2) AS entrate, round(sum(uscite), 2) AS uscite
      FROM mesi
     GROUP BY GROUPING SETS ((scuola_id, mese), (mese))
  )
  SELECT jsonb_build_object(
    'entrate', (SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.scuola_id NULLS FIRST, g.categoria_id, g.metodo), '[]'::jsonb) FROM entrate_gruppi g),
    'uscite',  (SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.scuola_id NULLS FIRST, g.categoria_id), '[]'::jsonb) FROM uscite_gruppi g),
    'mensile', (SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.scuola_id NULLS FIRST, g.mese), '[]'::jsonb) FROM mensile_gruppi g),
    -- Il controllo: SUM piatti sullo stesso insieme, senza gruppi.
    'controllo', jsonb_build_object(
      'entrate',  (SELECT round(COALESCE(sum(importo), 0), 2) FROM reali),
      'uscite',   (SELECT round(COALESCE(sum(importo), 0), 2) FROM uscite),
      'incassi',  (SELECT count(*) FROM insieme),
      'movimenti', (SELECT count(*) FROM uscite)
    )
  );
$$;

REVOKE ALL ON FUNCTION public.report_cassa_aggregato(uuid[], date, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_cassa_aggregato(uuid[], date, date, uuid) TO service_role;

COMMENT ON FUNCTION public.report_cassa_aggregato(uuid[], date, date, uuid) IS
  'Report di cassa aggregato in SQL (entrate per categoria e metodo reale con storni netti, uscite per categoria contanti/altri, mensile), per sede e per tutte le sedi, con un controllo a SUM piatto. Dal 2026-10-10 (fase 5 robustezza): prima la route sommava in JavaScript righe tagliate a 1000. Dal 2026-10-31 non conta i movimenti di cassa assorbiti da un incasso (incasso_id valorizzato).';

-- 7b) report_cassa_dettaglio (ultima definizione: 20261014215153)
CREATE OR REPLACE FUNCTION public.report_cassa_dettaglio(
  p_scuola_ids uuid[],
  p_tipo text,
  p_da date DEFAULT NULL,
  p_a date DEFAULT NULL,
  p_categoria uuid DEFAULT NULL,
  p_senza_categoria boolean DEFAULT false,
  p_metodo text DEFAULT NULL,
  p_limite integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
  WITH insieme AS (
    SELECT i.id, i.importo, i.metodo::text AS metodo, i.storno_di,
           i.stornato_il, i.data_incasso, i.note, i.pagamento_id,
           p.scuola_id, p.categoria_id, p.descrizione
      FROM public.incassi i
      JOIN public.pagamenti p ON p.id = i.pagamento_id
     WHERE p_tipo = 'entrata'
       AND p.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND (p_da IS NULL OR i.data_incasso >= p_da)
       AND (p_a IS NULL OR i.data_incasso <= p_a)
       AND (p_categoria IS NULL OR p.categoria_id = p_categoria)
       AND (NOT COALESCE(p_senza_categoria, false) OR p.categoria_id IS NULL)
  ),
  entrate AS (
    SELECT s.*,
           CASE WHEN s.storno_di IS NULL THEN s.metodo ELSE o.metodo END AS metodo_reale
      FROM insieme s
      LEFT JOIN insieme o ON o.id = s.storno_di
  ),
  righe_filtrate AS (
    SELECT e.id, 'incasso'::text AS origine, e.scuola_id, NULL::text AS scuola_nome,
           e.data_incasso AS data, e.categoria_id, pc.nome AS categoria_nome,
           e.metodo_reale AS metodo, e.importo, e.descrizione, e.note,
           NULL::text AS allegato_path, e.storno_di, e.stornato_il, e.pagamento_id
      FROM entrate e
      LEFT JOIN public.payment_categories pc ON pc.id = e.categoria_id
     WHERE e.metodo_reale IN ('contanti', 'bonifico', 'pos', 'assegno', 'altro')
       AND (p_metodo IS NULL OR e.metodo_reale = p_metodo)
    UNION ALL
    SELECT m.id, 'cassa'::text, m.scuola_id, NULL::text,
           m.data, m.categoria_id, cc.nome,
           m.metodo, m.importo, m.descrizione, m.note,
           m.allegato_path, m.storno_di, m.stornato_il, NULL::uuid
      FROM public.cassa_movimenti m
      LEFT JOIN public.cassa_categorie cc ON cc.id = m.categoria_id
     WHERE p_tipo = 'uscita'
       AND m.tipo = 'uscita'
       AND m.incasso_id IS NULL
       AND m.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND (p_da IS NULL OR m.data >= p_da)
       AND (p_a IS NULL OR m.data <= p_a)
       AND (p_categoria IS NULL OR m.categoria_id = p_categoria)
       AND (NOT COALESCE(p_senza_categoria, false) OR m.categoria_id IS NULL)
       AND (p_metodo IS NULL OR m.metodo = p_metodo)
  ),
  pagina AS (
    SELECT * FROM righe_filtrate
     ORDER BY data DESC, id DESC
     LIMIT LEAST(100, GREATEST(1, COALESCE(p_limite, 50)))
     OFFSET GREATEST(0, COALESCE(p_offset, 0))
  ),
  totali AS (
    SELECT count(*) AS conteggio,
           round(COALESCE(sum(importo), 0), 2) AS totale,
           round(COALESCE(sum(importo) FILTER (WHERE metodo = 'contanti'), 0), 2) AS contanti,
           round(COALESCE(sum(importo) FILTER (WHERE metodo IS DISTINCT FROM 'contanti'), 0), 2) AS altri
      FROM righe_filtrate
  )
  SELECT jsonb_build_object(
    'righe', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.data DESC, p.id DESC), '[]'::jsonb) FROM pagina p),
    'conteggio', t.conteggio,
    'totale', t.totale,
    'contanti', t.contanti,
    'altri', t.altri
  ) FROM totali t;
$$;

REVOKE ALL ON FUNCTION public.report_cassa_dettaglio(uuid[], text, date, date, uuid, boolean, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_cassa_dettaglio(uuid[], text, date, date, uuid, boolean, text, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.report_cassa_dettaglio(uuid[], text, date, date, uuid, boolean, text, integer, integer) IS
  'Dettaglio cassa paginato: entrate reali e storni secondo report_cassa_aggregato, uscite e contro-movimenti; conteggio e totali sull’intero filtro. Dal 2026-10-31 non elenca i movimenti di cassa assorbiti da un incasso (incasso_id valorizzato). Solo service_role, scope vuoto nega.';

-- 7c) conteggio_cassa_provenienza (ultima definizione: 20261016075419)
CREATE OR REPLACE FUNCTION public.conteggio_cassa_provenienza(
  p_scuola_ids uuid[],
  p_da date DEFAULT NULL,
  p_a date DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH incassi_periodo AS (
    SELECT i.importo, p.scuola_id,
           CASE WHEN i.storno_di IS NULL THEN p.categoria_id ELSE op.categoria_id END AS cassa_categoria_id,
           CASE WHEN i.storno_di IS NULL THEN i.metodo ELSE o.metodo END AS metodo_reale
      FROM public.incassi i
      JOIN public.pagamenti p ON p.id = i.pagamento_id
      LEFT JOIN public.incassi o ON o.id = i.storno_di AND o.storno_di IS NULL
      LEFT JOIN public.pagamenti op ON op.id = o.pagamento_id
     WHERE p.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND (p_da IS NULL OR i.data_incasso >= p_da)
       AND (p_a IS NULL OR i.data_incasso <= p_a)
       AND (i.storno_di IS NULL OR op.scuola_id = p.scuola_id)
  ), flussi AS (
    SELECT i.scuola_id, i.cassa_categoria_id, i.importo AS entrate,
           0::numeric AS uscite, 0::numeric AS prelievi, 0::numeric AS rettifiche
      FROM incassi_periodo i WHERE i.metodo_reale = 'contanti'
    UNION ALL
    SELECT m.scuola_id, m.cassa_categoria_id,
           CASE WHEN m.tipo = 'entrata' THEN m.importo ELSE 0 END,
           CASE WHEN m.tipo = 'uscita' THEN m.importo ELSE 0 END,
           CASE WHEN m.tipo = 'prelievo' THEN m.importo ELSE 0 END,
           CASE WHEN m.tipo = 'rettifica' THEN m.importo ELSE 0 END
      FROM public.cassa_movimenti m
     WHERE m.scuola_id = ANY (COALESCE(p_scuola_ids, '{}'::uuid[]))
       AND m.metodo = 'contanti'
       AND m.tipo IN ('entrata','uscita','prelievo','rettifica')
       AND m.incasso_id IS NULL
       AND (p_da IS NULL OR m.data >= p_da)
       AND (p_a IS NULL OR m.data <= p_a)
  ), gruppi AS (
    SELECT f.scuola_id, f.cassa_categoria_id,
           round(sum(f.entrate), 2) AS entrate, round(sum(f.uscite), 2) AS uscite,
           round(sum(f.prelievi), 2) AS prelievi, round(sum(f.rettifiche), 2) AS rettifiche,
           round(sum(f.entrate - f.uscite - f.prelievi + f.rettifiche), 2) AS netto
      FROM flussi f GROUP BY f.scuola_id, f.cassa_categoria_id
  ), righe AS (
    SELECT g.scuola_id, g.cassa_categoria_id, c.nome AS cassa_nome,
           g.entrate, g.uscite, g.prelievi, g.rettifiche, g.netto
      FROM gruppi g LEFT JOIN public.payment_categories c ON c.id = g.cassa_categoria_id
  )
  SELECT jsonb_build_object(
    'righe', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.scuola_id, r.cassa_categoria_id NULLS FIRST), '[]'::jsonb) FROM righe r),
    'totali', jsonb_build_object(
      'entrate', round(COALESCE(sum(f.entrate), 0), 2),
      'uscite', round(COALESCE(sum(f.uscite), 0), 2),
      'prelievi', round(COALESCE(sum(f.prelievi), 0), 2),
      'rettifiche', round(COALESCE(sum(f.rettifiche), 0), 2),
      'netto', round(COALESCE(sum(f.entrate - f.uscite - f.prelievi + f.rettifiche), 0), 2)
    )
  ) FROM flussi f;
$$;

REVOKE ALL ON FUNCTION public.conteggio_cassa_provenienza(uuid[], date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conteggio_cassa_provenienza(uuid[], date, date) TO service_role;

COMMENT ON FUNCTION public.conteggio_cassa_provenienza(uuid[], date, date) IS
  'Flussi contanti del periodo, estremi inclusi, per sede/cassa di provenienza e totali: entrate-uscite-prelievi+rettifiche. Non comprende il fondo iniziale. Storni attribuiti all’originale anche fuori periodo; storico/chiusure in generale. Dal 2026-10-31 non conta i movimenti di cassa assorbiti da un incasso (incasso_id valorizzato). JSON unico, scope vuoto nega, solo service_role.';

-- ── 8) PostgREST rilegge lo schema ───────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
