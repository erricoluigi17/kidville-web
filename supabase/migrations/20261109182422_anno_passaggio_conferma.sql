-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ANNO SCOLASTICO, PR 4.8 · «Il passaggio d'anno» · M48b, confermare, annullare e rientrare (compito 4.8.7)
-- La applica l'integrazione GitHub di Supabase al merge, con la version del FILE. Si applica DOPO M48a (anteprima) e M48c (didattica):
-- la conferma chiama `passaggio_calcola` e `passaggio_copia_didattica`.
--
-- Il passaggio lo fa la SEGRETERIA, con l'anteprima, le eccezioni e una conferma: non gira mai da sé, e `anni_tick` non lo chiama. La conferma è
-- UNA transazione sola: o cambia tutto, o non cambia niente. L'unica cosa che gira da sola (giro 2, R6) è la RICOPIA DELLE SCHEDE nel giorno
-- dell'`inizio` dell'anno nuovo: `passaggio_ricopia_schede`, job orario `passaggio-ricopia-schede`, separato da `anni_tick`.
--
-- Contenuto: una colonna nullable in `passaggi_anno_docenti` (`inserita`: quali assegnazioni ha scritto la conferma, perché
-- l'annullamento tolga solo quelle), `passaggio_oggi` (il giorno, con la stessa porta di `anni_tick`), `passaggio_conferma`,
-- `passaggio_annulla`, `passaggio_conferma_tardiva`. Nessun uuid di sede, nessun valore del 2027/28.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.passaggi_anno_docenti ADD COLUMN IF NOT EXISTS inserita boolean NOT NULL DEFAULT false;
-- (giro 2, R6) Il giorno in cui le schede della sede sono state ricopiate sulla classe nuova (NULL = non ancora). Una conferma fatta a
-- anno nuovo già cominciato la valorizza subito.
ALTER TABLE public.passaggi_anno ADD COLUMN IF NOT EXISTS schede_copiate_il timestamptz;

-- ── Giro di correzione 1 · B1 · lo storico delle classi non perde la riga aperta ─────────────────
-- `storici_traccia_classe` (trigger su `alunni`): corpo di produzione del 2026-11-09 (`pg_get_functiondef`), con UNA correzione. La terza
-- scrittura di classe nello stesso giorno (conferma, annullo, riconferma) cadeva sulla riga di quella mattina, già chiusa con `al` = oggi,
-- e `ON CONFLICT DO NOTHING` non la riapriva: il bambino restava in classe senza riga aperta, e `media_visibili_genitore` e le stampe
-- per giorno (`alunni-giorno.ts`) non lo vedevano per tutto l'anno. Ora la riga dello stesso giorno e della stessa classe si RIAPRE.
-- Cambia per chi legge: niente, se non che il caso sopra torna a funzionare. DA DICHIARARE nel corpo della PR (tocca un trigger vecchio).
CREATE OR REPLACE FUNCTION public.storici_traccia_classe()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
 -- = (now() at time zone 'Europe/Rome')::date, ma si può fissare nelle prove. (giro 3, NS3) `passaggio_ricopia_schede` fissa il giorno con
 -- `kidville.storico_giorno` (solo dentro la sua transazione): se il job gira in ritardo la riga di classe parte comunque dall'`inizio`.
declare giorno date := coalesce(nullif(current_setting('kidville.storico_giorno', true), '')::date, public.giorno_roma(now()));
begin
  if TG_OP='UPDATE' and new.section_id is not distinct from old.section_id and new.scuola_id is not distinct from old.scuola_id
    and new.archiviato_il is not distinct from old.archiviato_il then return new; end if;
  if TG_OP='UPDATE' then
    update public.alunni_classi_storico set al=greatest(dal,giorno)
    where alunno_id=new.id and al is null;
  end if;
  if new.section_id is not null and new.anonimizzato_il is null and new.archiviato_il is null then
    -- la riga di questa classe aperta e chiusa nello stesso giorno (la mattina stessa) torna aperta
    update public.alunni_classi_storico set al=null
    where alunno_id=new.id and scuola_id=new.scuola_id and section_id=new.section_id and dal=giorno and fonte='trasferimento' and al is not null;
    insert into public.alunni_classi_storico(alunno_id,scuola_id,section_id,section_nome,dal,fonte)
    values(new.id,new.scuola_id,new.section_id,coalesce((select name from public.sections where id=new.section_id),''),giorno,'trasferimento') on conflict do nothing;
  end if;
  begin
    insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
    values('info','registro','server','Appartenenza storica registrata','storici-classe-tracciata',jsonb_build_object('alunno_id',new.id,'scuola_id',new.scuola_id))
      on conflict (fingerprint, giorno) do update
        set occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  exception when others then raise log 'storici: logging appartenenza non riuscito [%]', SQLSTATE;
  end;
  return new;
end $$;
REVOKE ALL ON FUNCTION public.storici_traccia_classe() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storici_traccia_classe() TO service_role;

-- L'invariante nuova, «ogni bambino in classe ha una riga aperta di storico», come funzione a sé (misura in produzione il 2026-11-09:
-- 0 casi su tutte le sedi, quindi può girare di notte). NON ridefinisco `anno_invarianti()`: è una funzione lunga che ogni PR
-- ridefinisce per intero, e la mia versione più recente cancellerebbe quelle degli altri rami. L'aggancio si fa all'allineamento.
-- Conta i bambini con una classe, né archiviati né anonimizzati, senza nessuna riga aperta. Senza la tabella dello storico: 0.
CREATE OR REPLACE FUNCTION public.passaggio_storico_senza_riga_aperta()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n bigint;
BEGIN
  IF to_regclass('public.alunni_classi_storico') IS NULL THEN
    RETURN 0;
  END IF;
  SELECT count(*) INTO v_n
    FROM public.alunni a
   WHERE a.section_id IS NOT NULL AND a.archiviato_il IS NULL AND a.anonimizzato_il IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.alunni_classi_storico h WHERE h.alunno_id = a.id AND h.al IS NULL);
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.passaggio_storico_senza_riga_aperta() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passaggio_storico_senza_riga_aperta() TO service_role;

-- ── Giro di correzione 1 · B3 · la finestra fra la conferma e l'inizio dell'anno nuovo ───────────
-- Ruling R1 (a): dal giorno della conferma al giorno prima dell'`inizio` del nuovo anno la famiglia vede come prima della conferma.
-- `anno_visibile(sede, oggi)` = l'anno attivo, tranne quando non è ancora cominciato (`inizio > oggi`): allora vale l'anno il cui
-- periodo contiene oggi (il vecchio, in chiusura). Prima di una conferma l'anno attivo è già cominciato: il ramo nuovo non scatta mai.
-- `frequenze_attive` (e con lei `figli_attivi`, le foto, gli avvisi, le chat, `verificaAlunnoAttivo`, la rubrica) legge da qui. Chi esce
-- ha la frequenza vecchia `uscito`: non c'è. Chi è nuovo ha la frequenza nel nuovo anno, con `data_ingresso` = inizio: non c'è finché non comincia.
CREATE OR REPLACE FUNCTION public.anno_visibile(p_scuola uuid, p_oggi date)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN a.inizio > p_oggi THEN coalesce(
             (SELECT v.id FROM public.anni_sede v
               WHERE v.scuola_id = p_scuola AND v.periodo @> p_oggi AND v.stato IN ('corrente', 'in_chiusura', 'chiuso')
               LIMIT 1),
             a.id)
           ELSE a.id
         END
    FROM public.anni_sede a
   WHERE a.id = public.anno_attivo(p_scuola)
$$;
REVOKE ALL ON FUNCTION public.anno_visibile(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_visibile(uuid, date) TO service_role;

CREATE OR REPLACE FUNCTION public.frequenze_attive(p_alunni uuid[])
RETURNS TABLE (alunno_id uuid, frequenza_id uuid, section_id uuid, scuola_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_oggi date := public.giorno_roma(now());
BEGIN
  RETURN QUERY
    SELECT f.alunno_id, f.id, f.section_id, f.scuola_id
      FROM public.frequenze f
     WHERE f.alunno_id = ANY (p_alunni)
       AND f.stato IN ('in_attesa', 'iscritto')
       AND f.anno_sede_id = public.anno_visibile(f.scuola_id, v_oggi)
       AND f.data_ingresso <= v_oggi
       AND (f.data_uscita IS NULL OR f.data_uscita >= v_oggi);
END
$$;
REVOKE ALL ON FUNCTION public.frequenze_attive(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.frequenze_attive(uuid[]) TO service_role;

-- ── Giro di correzione 2 · R6 · lo specchio delle schede segue l'anno VISIBILE ──────────────────────────────────────────────
-- La copia `frequenze` → `alunni` (e quella inversa, e le invarianti) leggeva l'anno ATTIVO. Alla conferma l'anno attivo cambia, ma fino
-- all'`inizio` il nuovo anno non è ancora cominciato: la scheda si spostava sulla classe nuova (lo storico delle classi, le foto, la
-- rubrica, la scheda della maestra e circa 180 altre letture partono da lì) mentre `frequenze_attive` dava ancora la classe vecchia.
-- Ora tutto legge `anno_visibile`: prima di una conferma coincide con l'anno attivo (in produzione al merge non cambia niente); nella
-- finestra resta il vecchio; il giorno dell'inizio `passaggio_ricopia_schede` (job orario) ricopia le schede della sede.
-- Per chi legge: le firme non cambiano. Cambia il corpo di `alunni_riallinea_da_frequenze`, `frequenze_specchio_alunni`,
-- `alunni_specchio_frequenza` e `anno_invarianti` (CREATE OR REPLACE sull'ultima definizione).

CREATE OR REPLACE FUNCTION public.alunni_riallinea_da_frequenze(p_alunno uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cur   jsonb;
  v_f     jsonb;
  v_t     jsonb;
  v_patch jsonb;
  v_set   text;
  v_viva  boolean;
  v_stato text;
  v_arch  timestamptz;
  v_uscita date;
  v_nome  text;
  v_oggi  date := public.giorno_roma(now());
BEGIN
  SELECT to_jsonb(a) INTO v_cur FROM public.alunni a WHERE a.id = p_alunno;
  IF v_cur IS NULL OR (v_cur ->> 'scuola_id') IS NULL THEN
    RETURN;
  END IF;
  -- Una scheda anonimizzata (diritto all'oblio) non si riempie di nuovo: la copia dalla frequenza non riporta niente.
  IF (v_cur ->> 'anonimizzato_il') IS NOT NULL THEN
    RETURN;
  END IF;

  -- (giro 2, R6) La frequenza dell'anno VISIBILE della sede ATTUALE dell'alunno: mai quella di una sede lasciata. Fra la conferma e
  -- l'inizio dell'anno nuovo l'anno visibile è ancora il vecchio: la scheda resta com'è, e la ricopia a settembre la fa `passaggio_ricopia_schede`.
  SELECT to_jsonb(f) INTO v_f
    FROM public.frequenze f
   WHERE f.alunno_id = p_alunno
     AND f.anno_sede_id = public.anno_visibile((v_cur ->> 'scuola_id')::uuid, v_oggi);
  IF v_f IS NULL THEN
    RETURN;
  END IF;

  SELECT s.name::text INTO v_nome FROM public.sections s WHERE s.id = (v_f ->> 'section_id')::uuid;

  v_viva := (v_f ->> 'stato') IN ('in_attesa', 'iscritto');
  -- M45b (4.5.15, I2): un bambino «in arrivo» con la frequenza dell'anno attivo CHIUSA è un ex alunno che torna per l'anno prossimo.
  -- Quella frequenza è la sua storia, non il suo stato di oggi: ricopiarla lo riporterebbe `ritirato` e archiviato, cioè lo
  -- rimetterebbe fra i «Non iscritti» con la sua iscrizione dell'anno dopo ancora viva. Con una frequenza VIVA l'arrivo c'è
  -- stato (è il passaggio, 4.8) e la scheda lo segue come sempre.
  IF (v_cur ->> 'stato') = 'in_arrivo' AND NOT v_viva THEN
    RETURN;
  END IF;
  IF v_viva THEN
    -- 'sospeso' (o NULL, che il codice legge «iscritto») si conserva finché la frequenza è viva
    -- `ritirato` senza `archiviato_il` è la tendina della scheda (non archivia): resta com'è. Una vera riapertura
    -- (`archiviato_il` valorizzato) torna `iscritto`.
    v_stato := CASE WHEN (v_cur ->> 'archiviato_il') IS NOT NULL THEN 'iscritto'
                    WHEN coalesce(v_cur ->> 'stato', 'iscritto') IN ('iscritto', 'sospeso', 'ritirato')
                    THEN v_cur ->> 'stato' ELSE 'iscritto' END;
    v_arch := NULL;
  ELSE
    v_stato := 'ritirato';
    v_uscita := (v_f ->> 'data_uscita')::date;
    v_arch := coalesce((v_cur ->> 'archiviato_il')::timestamptz,
                       CASE WHEN v_uscita IS NOT NULL AND v_uscita <= v_oggi
                            THEN ((v_uscita + time '12:00') AT TIME ZONE 'Europe/Rome') ELSE now() END);
  END IF;

  v_t := jsonb_build_object(
    'section_id', v_f -> 'section_id',
    'classe_sezione', v_nome,
    'stato', v_stato,
    'archiviato_il', v_arch,
    'importo_retta_mensile',
      CASE WHEN jsonb_typeof(v_f -> 'retta_mensile') = 'number' THEN v_f -> 'retta_mensile' ELSE to_jsonb(0) END,
    'retta_a_carico_di', v_f -> 'retta_a_carico_di',
    'retta_split_config', v_f -> 'retta_split_config',
    'intestatario_fatture', v_f -> 'intestatario_fatture',
    'giorno_scadenza_pagamenti', v_f -> 'giorno_scadenza_pagamenti',
    'gruppo_mensa_id', v_f -> 'gruppo_mensa_id',
    'sospeso', v_f -> 'sospeso',
    'sospeso_causa', v_f -> 'sospeso_causa',
    'sospeso_motivo', v_f -> 'sospeso_motivo',
    'sospeso_il', v_f -> 'sospeso_il',
    'sospeso_da', v_f -> 'sospeso_da',
    'usa_pannolino', v_f -> 'usa_pannolino');

  -- (giro 4, NB4) Una frequenza NON viva non porta mai la sua classe su una scheda archiviata: l'archiviazione toglie la classe alla scheda
  -- (fuori dalla finestra anche alla frequenza), e la ricopia del 01/09 non deve rimettergliela. Il diario e l'appello leggono `section_id`
  -- senza guardare lo stato.
  IF NOT v_viva THEN
    v_t := v_t || jsonb_build_object('section_id', NULL::uuid, 'classe_sezione', NULL::text);
  END IF;

  -- (Riattiva, giro 5) Quando la scheda archiviata TORNA VIVA le tracce dell'archiviazione (autore, motivo, memoria della classe) se ne vanno con
  -- `archiviato_il`: una scheda `iscritto` con l'autore di un'archiviazione vecchia addosso è una traccia sbagliata (la «Conferma tardiva» e la
  -- ricopia del 01/09 la lasciavano). Solo se la scheda ERA archiviata: un'archiviazione rimasta a metà non ha ancora `archiviato_il`.
  IF v_viva AND (v_cur ->> 'archiviato_il') IS NOT NULL THEN
    v_t := v_t || jsonb_build_object('archiviato_da', NULL::uuid, 'archiviato_motivo', NULL::text,
                                     'archiviato_section_id', NULL::uuid, 'archiviato_classe_sezione', NULL::text);
  END IF;

  -- Senza una sezione né sulla frequenza né sulla scheda il NOME di classe non si tocca: il testo scritto a mano (o un
  -- nome che nella sede non risolve) non deve sparire solo perché la frequenza non ha una sezione. Se la sezione c'era
  -- e viene svuotata, invece, il nome segue (v_f section_id NULL ma v_cur section_id valorizzato).
  IF (v_f ->> 'section_id') IS NULL AND (v_cur ->> 'section_id') IS NULL THEN
    v_t := v_t - 'classe_sezione';
  END IF;

  -- solo le colonne che alunni ha davvero e che cambiano
  SELECT jsonb_object_agg(e.k, e.v) INTO v_patch
    FROM jsonb_each(v_t) AS e(k, v)
   WHERE v_cur ? e.k AND (v_cur -> e.k) IS DISTINCT FROM e.v;
  IF v_patch IS NULL THEN
    RETURN;
  END IF;

  SELECT string_agg(format('%I = r.%I', k, k), ', ') INTO v_set FROM jsonb_object_keys(v_patch) AS k;
  EXECUTE format(
    'UPDATE public.alunni a SET %s FROM jsonb_populate_record(NULL::public.alunni, $1) r WHERE a.id = $2', v_set)
    USING v_patch, p_alunno;
END
$$;

CREATE OR REPLACE FUNCTION public.frequenze_specchio_alunni()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attivo boolean;
  v_scuola uuid;
BEGIN
  SELECT r.specchio_frequenze_attivo INTO v_attivo FROM public.anno_regole r;
  IF NOT coalesce(v_attivo, false) THEN
    RETURN NULL;
  END IF;

  BEGIN
    SELECT a.scuola_id INTO v_scuola FROM public.alunni a WHERE a.id = NEW.alunno_id;
    IF v_scuola IS NULL OR NEW.anno_sede_id IS DISTINCT FROM public.anno_visibile(v_scuola, public.giorno_roma(now())) THEN
      RETURN NULL;
    END IF;
    PERFORM public.alunni_riallinea_da_frequenze(NEW.alunno_id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.anno_log_guasto('frequenze', 'specchio-fallito', 'frequenze_specchio_alunni',
                                   'specchio frequenze → alunni fallito: la scrittura della frequenza è passata',
                                   'db:anno-specchio:frequenze', SQLSTATE);
  END;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.alunni_specchio_frequenza()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attivo   boolean;
  v_n        jsonb := to_jsonb(NEW);
  v_oggi     date  := public.giorno_roma(now());
  v_as       public.anni_sede%ROWTYPE;
  v_old      public.anni_sede%ROWTYPE;
  v_arch     timestamptz;
  v_retta    numeric;
  v_giorno   integer;
  v_ingresso date;
BEGIN
  SELECT r.specchio_alunni_attivo INTO v_attivo FROM public.anno_regole r;
  IF NOT coalesce(v_attivo, false) THEN
    RETURN NULL;
  END IF;

  -- M45b: un bambino «in arrivo» (la sua domanda è per l'anno prossimo) non frequenta ancora. Lo specchio non gli dà
  -- nessuna frequenza dell'anno ATTIVO, né alla nascita né se la sede cambia: la sua frequenza è quella dell'anno che
  -- viene, e la scrive la 4.5.6. Lo stato si legge da jsonb come le altre colonne: dove `stato` non c'è, non scatta.
  IF v_n ->> 'stato' = 'in_arrivo' THEN
    RETURN NULL;
  END IF;

  -- 4.5.5: chi ERA `in_arrivo` e viene ritirato o archiviato non è mai stato nell'anno attivo: se in quello stesso aggiornamento
  -- cambia anche sede, lo specchio non esce più dal ramo qui sopra (lo stato nuovo non è più `in_arrivo`) e gli inserirebbe una
  -- frequenza `ritirato` in un anno in cui non ha mai frequentato. La sua frequenza è quella dell'anno aperto, e la chiude la
  -- 4.5.1. Il ritorno a `iscritto` (il passaggio, 4.8: stato nuovo `iscritto`, non archiviato) NON passa di qui: lo specchio lavora.
  IF TG_OP = 'UPDATE' AND to_jsonb(OLD) ->> 'stato' = 'in_arrivo'
     AND (v_n ->> 'stato' IN ('ritirato', 'trasferito', 'uscito') OR (v_n ->> 'archiviato_il') IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  BEGIN
    IF NEW.scuola_id IS NULL THEN
      RETURN NULL;
    END IF;

    -- (giro 3, NB3) Una classe che appartiene a un anno DIVERSO da quello visibile (la finestra: la classe nuova, l'anno non è cominciato) non si
    -- copia nella frequenza dell'anno visibile: sarebbe una sezione di un altro anno, e il database direbbe ANNO_NON_COERENTE a ogni scrittura.
    -- La frequenza di quell'anno la scrive chi ha scelto la classe (`anno_registra_frequenza`), nello stesso anno della classe.
    IF NEW.section_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.sections sc
          WHERE sc.id = NEW.section_id AND sc.anno_id IS NOT NULL
            AND sc.anno_id <> (SELECT v.anno_id FROM public.anni_sede v WHERE v.id = public.anno_visibile(NEW.scuola_id, v_oggi))) THEN
      -- (giro 4, NB3) Una scheda NUOVA (INSERT) nata dentro la finestra con la classe del nuovo anno (il trigger BEFORE l'ha risolta sull'anno attivo)
      -- diventa quello che il `POST` della segreteria fa di proposito: «in arrivo», senza classe sulla scheda, con la frequenza dell'anno nuovo
      -- (ingresso all'`inizio`). La classe passa alla frequenza e la scheda ci arriva con la ricopia del 01/09. Senza questo il bambino
      -- sarebbe `iscritto` in una classe che non ha ancora cominciato, senza nessuna frequenza, e la 11 scatterebbe dal 01/09.
      IF TG_OP = 'INSERT' AND (v_n ->> 'archiviato_il') IS NULL THEN
        UPDATE public.alunni SET stato = 'in_arrivo', section_id = NULL, classe_sezione = NULL WHERE id = NEW.id;
        PERFORM public.anno_registra_frequenza(
          NEW.id, public.anno_attivo(NEW.scuola_id), 'nuova', 'segreteria', NULL, NEW.section_id, NULL,
          CASE WHEN (v_n ->> 'importo_retta_mensile')::numeric > 0 THEN jsonb_build_object('retta_mensile', (v_n ->> 'importo_retta_mensile')::numeric) ELSE '{}'::jsonb END,
          NULL);
      END IF;
      RETURN NULL;
    END IF;

    -- la sede cambia: la frequenza viva della sede vecchia si chiude come `trasferito`
    IF TG_OP = 'UPDATE' AND OLD.scuola_id IS NOT NULL AND OLD.scuola_id IS DISTINCT FROM NEW.scuola_id THEN
      SELECT s.* INTO v_old FROM public.anni_sede s WHERE s.id = public.anno_visibile(OLD.scuola_id, v_oggi);
      IF FOUND THEN
        UPDATE public.frequenze f
           SET stato = 'trasferito', data_uscita = least(greatest(v_oggi, f.data_ingresso), v_old.fine)
         WHERE f.alunno_id = NEW.id AND f.anno_sede_id = v_old.id AND f.stato IN ('in_attesa', 'iscritto');
      END IF;
    END IF;

    SELECT s.* INTO v_as FROM public.anni_sede s WHERE s.id = public.anno_visibile(NEW.scuola_id, v_oggi);
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    v_arch := (v_n ->> 'archiviato_il')::timestamptz;
    v_retta := (v_n ->> 'importo_retta_mensile')::numeric;
    v_giorno := (v_n ->> 'giorno_scadenza_pagamenti')::integer;
    v_ingresso := least(greatest(v_oggi, v_as.inizio), v_as.fine);

    INSERT INTO public.frequenze
      (alunno_id, anno_sede_id, section_id, origine, tipo, stato, data_ingresso, data_uscita, retta_mensile,
       retta_a_carico_di, retta_split_config, intestatario_fatture, giorno_scadenza_pagamenti, gruppo_mensa_id,
       sospeso, sospeso_causa, sospeso_motivo, sospeso_il, sospeso_da, usa_pannolino)
    VALUES
      (NEW.id, v_as.id, NEW.section_id, 'recupero', NULL,
       CASE WHEN v_arch IS NULL THEN 'iscritto' ELSE 'ritirato' END,
       v_ingresso,
       CASE WHEN v_arch IS NULL THEN NULL ELSE least(greatest(public.giorno_roma(v_arch), v_ingresso), v_as.fine) END,
       CASE WHEN v_retta > 0 THEN v_retta END,
       (v_n ->> 'retta_a_carico_di')::uuid,
       nullif(v_n -> 'retta_split_config', 'null'::jsonb),
       nullif(v_n -> 'intestatario_fatture', 'null'::jsonb),
       CASE WHEN v_giorno BETWEEN 1 AND 28 THEN v_giorno END,
       (v_n ->> 'gruppo_mensa_id')::uuid,
       coalesce((v_n ->> 'sospeso')::boolean, false), v_n ->> 'sospeso_causa', v_n ->> 'sospeso_motivo',
       (v_n ->> 'sospeso_il')::timestamptz, (v_n ->> 'sospeso_da')::uuid,
       coalesce((v_n ->> 'usa_pannolino')::boolean, false))
    ON CONFLICT (alunno_id, anno_sede_id) DO UPDATE SET
      -- M45b: un bambino che torna in una sede in cui era già stato (A → B → A) riapre la frequenza di A. L'ingresso resta
      -- quello di prima solo se la riga era viva; se era chiusa (`trasferito`, `ritirato`, `uscito`) e nata dal recupero,
      -- l'ingresso è quello di oggi: altrimenti il periodo passato in B rientrerebbe nel periodo di A, e una famiglia
      -- vedrebbe le foto che la sede A ha fatto mentre il bambino non c'era. Si perde una foto vecchia, non si apre una nuova.
      data_ingresso = CASE WHEN public.frequenze.origine = 'recupero'
                            AND public.frequenze.stato NOT IN ('in_attesa', 'iscritto')
                            AND v_arch IS NULL
                           THEN v_ingresso ELSE public.frequenze.data_ingresso END,
      section_id = excluded.section_id,
      retta_mensile = excluded.retta_mensile,
      retta_a_carico_di = excluded.retta_a_carico_di,
      retta_split_config = excluded.retta_split_config,
      intestatario_fatture = excluded.intestatario_fatture,
      giorno_scadenza_pagamenti = excluded.giorno_scadenza_pagamenti,
      gruppo_mensa_id = excluded.gruppo_mensa_id,
      sospeso = excluded.sospeso, sospeso_causa = excluded.sospeso_causa, sospeso_motivo = excluded.sospeso_motivo,
      sospeso_il = excluded.sospeso_il, sospeso_da = excluded.sospeso_da,
      usa_pannolino = excluded.usa_pannolino,
      stato = CASE WHEN public.frequenze.origine = 'recupero' THEN excluded.stato ELSE public.frequenze.stato END,
      data_uscita = CASE WHEN public.frequenze.origine <> 'recupero' THEN public.frequenze.data_uscita
                         WHEN v_arch IS NULL THEN NULL
                         ELSE least(greatest(public.giorno_roma(v_arch), public.frequenze.data_ingresso), v_as.fine) END;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.anno_log_guasto('alunni', 'specchio-fallito', 'alunni_specchio_frequenza',
                                   'specchio alunni → frequenze fallito: la scrittura di alunni è passata',
                                   'db:anno-specchio:alunni', SQLSTATE);
  END;
  RETURN NULL;
END
$$;

-- (giro 2, R6/R8) Copia dell'ULTIMA definizione (`20261109035213_anno_alunno_in_arrivo.sql`, uguale a quella di produzione: md5 del corpo
-- edd1d31be3259e7ae7603b53fc4ffdb5, verificato il 2026-11-09 sul database di produzione e sul testo di quella migrazione). Cambiano: le invarianti 7, 11 e 11-bis guardano l'anno VISIBILE (fra la conferma e l'inizio dell'anno nuovo
-- la scheda segue il vecchio) e nasce la 15, lo storico delle classi.
CREATE OR REPLACE FUNCTION public.anno_invarianti()
RETURNS TABLE (invariante text, tabella text, righe bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r             record;
  v_guardia_dal timestamptz;
  v_mappa6      jsonb := '{}'::jsonb;
  v_ha_nera     boolean;
  v_ha_anno     boolean;
  v_fuori       text[];
  v_cond        text[];
  v_col         text;
  v_n           bigint;
  v_trovata     boolean := false;
  d             record;
  v_oggi        date := public.giorno_roma(now());
  v_figli_vivi  uuid[];
  v_freq_vive   uuid[];
  v_lasciate    uuid[];
  v_genitori    uuid[] := '{}';
  v_figli       uuid[] := '{}';
  v_st_alunni   uuid[] := '{}';
  v_st_scuole   uuid[] := '{}';
  v_st_sezioni  uuid[] := '{}';
  v_foto        bigint := 0;
  v_avvisi      bigint := 0;
  v_thread      bigint := 0;
  v_frequenze   bigint := 0;
  v_guasti      bigint := 0;
  v_guasto      text;
  v_gen         record;
  v_non_arrivo  text;
  v_non_archiv  text;
BEGIN
  -- 1. Nessun giorno senza anno, nessun giorno in due anni.
  SELECT count(*) INTO v_n FROM (
    SELECT s.scuola_id, g::date
      FROM (SELECT a.scuola_id, min(a.inizio) AS da, max(a.fine) AS al
              FROM public.anni_sede a GROUP BY a.scuola_id) s
     CROSS JOIN LATERAL generate_series(s.da::timestamp, s.al::timestamp, interval '1 day') g
      LEFT JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND g::date <@ a.periodo
     GROUP BY s.scuola_id, g::date
    HAVING count(a.id) <> 1) x;
  invariante := '1'; tabella := 'anni_sede'; righe := v_n; RETURN NEXT;

  -- 6, prima parte: le violazioni di tutte le tabelle in una volta sola (poi si distribuiscono).
  SELECT g.guardia_attiva_dal INTO v_guardia_dal FROM public.anno_regole g;
  v_ha_nera := to_regclass('scatola_nera.modifiche') IS NOT NULL;
  IF v_ha_nera AND v_guardia_dal IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce(jsonb_object_agg(x.tabella, x.n), '{}'::jsonb) FROM (
        SELECT m.tabella, count(*) AS n
          FROM scatola_nera.modifiche m
          -- `nessuna` e `solo_contenuto` non guardano gli UPDATE (la scatola nera registra solo UPDATE): non sono un difetto
          JOIN public.anno_tabelle t ON t.tabella = m.tabella AND t.guardia = 'piena'
         CROSS JOIN LATERAL (SELECT public.anno_guardia_sede(m.tabella, m.prima) AS sede) s
          JOIN public.anni_sede a ON a.scuola_id = s.sede AND a.anno_id = (m.prima ->> 'anno_id')::uuid
         CROSS JOIN LATERAL (SELECT min(st.dal) AS dal FROM public.anni_sede_stati st
                              WHERE st.anno_sede_id = a.id AND st.stato IN ('in_chiusura', 'chiuso')) ch
         WHERE m.modificata_il >= $1
           AND ch.dal IS NOT NULL
           AND m.modificata_il >= ch.dal
           -- le modifiche che la guardia lascia passare apposta non sono un difetto
           AND NOT (
             coalesce((SELECT bool_and(
                         c = ANY (public.anno_colonne_esenti(m.tabella))
                         OR (m.tabella = 'frequenze' AND c IN ('stato', 'quota_pagamento_id')))
                         FROM unnest(m.cambiate) c), false)
             AND (m.tabella <> 'frequenze'
                  OR NOT ('stato' = ANY (m.cambiate))
                  OR m.cambiate && ARRAY['moduli_completi', 'quota_saldata']))
           AND NOT EXISTS (SELECT 1 FROM public.correzioni_anno_chiuso_usi u
                            WHERE u.transazione = m.transazione AND u.tabella = m.tabella
                              AND (u.riga_id IS NULL OR u.riga_id = m.riga_id))
         GROUP BY m.tabella) x
    $q$ INTO v_mappa6 USING v_guardia_dal;
  END IF;

  FOR r IN SELECT * FROM public.anno_tabelle ORDER BY tabella LOOP
    CONTINUE WHEN to_regclass(format('public.%I', r.tabella)) IS NULL;
    v_ha_anno := public.anno_ha_colonna(r.tabella, 'anno_id');

    -- 2. Nessuna riga fuori dal suo anno (modo `data`).
    IF r.modo = 'data' THEN
      invariante := '2'; tabella := r.tabella;
      righe := CASE WHEN v_ha_anno THEN public.anno_righe_fuori_periodo(r.tabella) ELSE 0 END;
      RETURN NEXT;
    END IF;

    -- 6, seconda parte: una riga per tabella (se c'è la scatola nera).
    IF v_ha_nera THEN
      invariante := '6'; tabella := r.tabella; righe := coalesce((v_mappa6 ->> r.tabella)::bigint, 0);
      RETURN NEXT;
    END IF;

    -- 9. Nessuna riga nuova con una sezione di un altro anno.
    IF public.anno_ha_colonna(r.tabella, 'section_id') THEN
      invariante := '9'; tabella := r.tabella;
      righe := CASE WHEN v_ha_anno THEN public.anno_righe_sezione_altro_anno(r.tabella) ELSE 0 END;
      RETURN NEXT;
    END IF;

    -- 10a. La colonna e il trigger generico (una riga per tabella: 0, 1 o 2 difetti).
    invariante := '10a'; tabella := r.tabella;
    righe := (CASE WHEN v_ha_anno THEN 0 ELSE 1 END)
           + (CASE WHEN EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc pr ON pr.oid = tg.tgfoid
                                 WHERE tg.tgrelid = to_regclass(format('public.%I', r.tabella))
                                   AND pr.proname = 'anno_assegna_e_verifica' AND NOT tg.tgisinternal)
                   THEN 0 ELSE 1 END);
    RETURN NEXT;

    -- 12. Nessuna riga senza anno e con una sede da cui ricavarlo.
    invariante := '12'; tabella := r.tabella;
    righe := CASE WHEN v_ha_anno THEN public.anno_righe_senza_anno_con_sede(r.tabella) ELSE 0 END;
    RETURN NEXT;

    -- 14. «madre ⇒ FK» (Ruling P5; corretta in 4.2.M): ogni tabella `madre` ha una chiave esterna vera dalla colonna
    --     `madre_colonna` alla tabella madre. La chiave può essere COMPOSTA (le `votazioni_*` hanno
    --     `(votazione_id, scuola_id)`): conta se contiene la `madre_colonna` E garantisce davvero la madre, cioè ha una
    --     colonna sola, oppure è MATCH FULL, oppure tutte le sue colonne sono NOT NULL. Una composta MATCH SIMPLE con una
    --     colonna che ammette NULL non basta: con quella colonna NULL Postgres non controlla la chiave.
    IF r.modo = 'madre' THEN
      invariante := '14'; tabella := r.tabella;
      righe := CASE WHEN EXISTS (
                 SELECT 1 FROM pg_constraint c
                  WHERE c.contype = 'f'
                    AND c.conrelid = to_regclass(format('public.%I', r.tabella))
                    AND c.confrelid = to_regclass(format('public.%I', r.madre_tabella))
                    AND EXISTS (SELECT 1 FROM unnest(c.conkey) AS k(attnum)
                                  JOIN pg_attribute at ON at.attrelid = c.conrelid AND at.attnum = k.attnum
                                 WHERE at.attname = r.madre_colonna)
                    AND (cardinality(c.conkey) = 1
                         OR c.confmatchtype = 'f'
                         OR NOT EXISTS (SELECT 1 FROM unnest(c.conkey) AS k(attnum)
                                          JOIN pg_attribute at ON at.attrelid = c.conrelid AND at.attnum = k.attnum
                                         WHERE NOT at.attnotnull))) THEN 0 ELSE 1 END;
      RETURN NEXT;
    END IF;
  END LOOP;

  IF NOT v_ha_nera THEN
    invariante := '6'; tabella := '(scatola_nera assente)'; righe := 0; RETURN NEXT;
  END IF;

  -- 3. Nessuna doppia frequenza viva per lo stesso bambino nello stesso anno.
  SELECT count(*) INTO v_n FROM (
    SELECT f.alunno_id, f.anno_id FROM public.frequenze f
     WHERE f.stato IN ('in_attesa', 'iscritto')
     GROUP BY f.alunno_id, f.anno_id HAVING count(*) > 1) x;
  invariante := '3'; tabella := 'frequenze'; righe := v_n; RETURN NEXT;

  -- 4. Nessun «iscritto» senza moduli o senza quota, ricalcolato dalla verità e non dai flag.
  SELECT count(*) INTO v_n
    FROM public.frequenze f
    LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
   WHERE f.stato = 'iscritto' AND f.origine <> 'recupero'
     AND (EXISTS (SELECT 1 FROM public.moduli_richiesti m
                   WHERE m.anno_sede_id = f.anno_sede_id AND m.lista = f.tipo
                     AND NOT EXISTS (SELECT 1 FROM public.frequenze_moduli fm
                                      WHERE fm.frequenza_id = f.id AND fm.modulo_id = m.id))
          OR q.id IS NULL OR q.stato <> 'pagato');
  invariante := '4'; tabella := 'frequenze'; righe := v_n; RETURN NEXT;
  --    4-bis. I flag dicono la verità (vale anche per chi non è «iscritto»).
  SELECT count(*) INTO v_n
    FROM public.frequenze f
    LEFT JOIN public.pagamenti q ON q.id = f.quota_pagamento_id
   WHERE f.quota_saldata IS DISTINCT FROM (q.id IS NOT NULL AND q.stato = 'pagato');
  invariante := '4'; tabella := 'frequenze (flag)'; righe := v_n; RETURN NEXT;

  -- 5. Nessuna competenza fuori dal periodo del suo anno.
  v_n := 0;
  IF to_regclass('public.pagamenti') IS NOT NULL AND public.anno_ha_colonna('pagamenti', 'anno_id') THEN
    EXECUTE 'SELECT count(*) FROM public.pagamenti p '
            'JOIN public.anni_sede a ON a.scuola_id = p.scuola_id AND a.anno_id = p.anno_id '
            'WHERE p.periodo_competenza IS NOT NULL AND NOT (p.periodo_competenza <@ a.periodo)'
    INTO v_n;
  END IF;
  invariante := '5'; tabella := 'pagamenti'; righe := v_n; RETURN NEXT;

  -- 10b. Una tabella con `anno_id` che il registro non conosce.
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO v_fuori
    FROM pg_class c JOIN pg_attribute at ON at.attrelid = c.oid
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND at.attname = 'anno_id' AND at.attnum > 0 AND NOT at.attisdropped
     AND c.relname NOT IN ('anni_sede', 'riconciliazione_anno')
     AND c.relname NOT IN (SELECT t.tabella FROM public.anno_tabelle t);
  IF v_fuori IS NULL THEN
    invariante := '10b'; tabella := '(nessuna)'; righe := 0; RETURN NEXT;
  ELSE
    FOREACH v_col IN ARRAY v_fuori LOOP
      invariante := '10b'; tabella := v_col; righe := 1; RETURN NEXT;
    END LOOP;
  END IF;

  -- 11. La scheda alunno e la frequenza dell'anno attivo dicono la stessa cosa (solo chi ha la frequenza).
  --     Si confrontano `section_id` e i campi con lo STESSO nome e lo STESSO tipo su `alunni` e
  --     `frequenze`; lo stato e la retta hanno nomi e significati diversi e restano fuori.
  v_n := 0;
  -- 4.5.15 (I2): un bambino «in arrivo» ha la frequenza dell'anno attivo chiusa (è un ex alunno che torna) e la scheda no: non sono
  -- due copie della stessa cosa, e non si confrontano. `stato` si nomina solo dove la colonna c'è.
  v_non_arrivo := CASE WHEN public.anno_ha_colonna('alunni', 'stato')
                       THEN 'AND al.stato IS DISTINCT FROM ''in_arrivo'' ' ELSE '' END;
  IF to_regclass('public.alunni') IS NOT NULL THEN
    -- (giro 4, NB4) Una scheda ARCHIVIATA non ha classe (la 15-bis), mentre la frequenza chiusa può tenere la sua per la storia: quella coppia non è una
    -- discordanza. Ogni altra differenza di classe resta un allarme.
    v_cond := ARRAY[CASE WHEN public.anno_ha_colonna('alunni', 'archiviato_il')
                         THEN 'NOT (al.archiviato_il IS NOT NULL AND al.section_id IS NULL AND f.stato IN (''ritirato'', ''trasferito'', ''uscito'')) AND al.section_id IS DISTINCT FROM f.section_id'
                         ELSE 'al.section_id IS DISTINCT FROM f.section_id' END];
    -- Fase B (4.3.4): l'invariante guarda anche ciò che lo specchio inverso scrive in più (sospensione).
    FOREACH v_col IN ARRAY ARRAY['retta_a_carico_di', 'gruppo_mensa_id', 'giorno_scadenza_pagamenti',
                                 'usa_pannolino', 'retta_split_config', 'intestatario_fatture',
                                 'sospeso', 'sospeso_causa', 'sospeso_motivo', 'sospeso_il', 'sospeso_da'] LOOP
      IF EXISTS (SELECT 1 FROM pg_attribute x JOIN pg_attribute y ON y.attname = x.attname AND y.atttypid = x.atttypid
                  WHERE x.attrelid = 'public.alunni'::regclass AND y.attrelid = 'public.frequenze'::regclass
                    AND x.attname = v_col AND x.attnum > 0 AND y.attnum > 0
                    AND NOT x.attisdropped AND NOT y.attisdropped) THEN
        v_cond := v_cond || format('al.%I IS DISTINCT FROM f.%I', v_col, v_col);
      END IF;
    END LOOP;
    -- archiviato ↔ frequenza chiusa (NON `alunni.stato`: la tendina può dire «ritirato» senza archiviare) e retta
    -- (lo zero di `alunni` è NULL nella frequenza).
    IF EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = 'public.alunni'::regclass
                  AND x.attname = 'archiviato_il' AND x.attnum > 0 AND NOT x.attisdropped) THEN
      v_cond := v_cond || ARRAY['(al.archiviato_il IS NOT NULL) IS DISTINCT FROM (f.stato IN (''ritirato'', ''trasferito'', ''uscito''))'];
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = 'public.alunni'::regclass
                  AND x.attname = 'importo_retta_mensile' AND x.attnum > 0 AND NOT x.attisdropped) THEN
      v_cond := v_cond || ARRAY['nullif(al.importo_retta_mensile, 0) IS DISTINCT FROM f.retta_mensile'];
    END IF;
    EXECUTE 'SELECT count(*) FROM public.alunni al '
            'JOIN public.frequenze f ON f.alunno_id = al.id AND f.anno_sede_id = public.anno_visibile(al.scuola_id, public.giorno_roma(now())) '
            'WHERE (' || array_to_string(v_cond, ' OR ') || ') ' || v_non_arrivo
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni'; righe := v_n; RETURN NEXT;

  --     11-bis. Un alunno con una sede, che NON è «in arrivo», deve avere la frequenza dell'anno attivo (lo specchio la crea).
  --     Un bambino «in arrivo» (PR 4.5) non frequenta ancora: la sua frequenza è dell'anno che viene, e la guarda la 11-ter.
  --     `stato` si nomina solo dove la colonna c'è (il banco minimo e il database della CI possono non averla).
  --     Nemmeno un archiviato che non ha mai avuto la frequenza dell'anno attivo (4.5.15, I3): un `in_arrivo` archiviato esce da
  --     «in arrivo» ma non è mai entrato nell'anno attivo, e la sua frequenza è dell'anno che viene (chiusa dall'archiviazione).
  v_n := 0;
  v_non_archiv := CASE WHEN public.anno_ha_colonna('alunni', 'archiviato_il')
                       THEN 'AND al.archiviato_il IS NULL ' ELSE '' END;
  IF to_regclass('public.alunni') IS NOT NULL AND to_regclass('public.frequenze') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.alunni al WHERE al.scuola_id IS NOT NULL '
            || v_non_arrivo || v_non_archiv ||
            'AND public.anno_visibile(al.scuola_id, public.giorno_roma(now())) IS NOT NULL '
            'AND NOT EXISTS (SELECT 1 FROM public.frequenze f WHERE f.alunno_id = al.id '
            'AND f.anno_sede_id = public.anno_visibile(al.scuola_id, public.giorno_roma(now())))'
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni (senza frequenza)'; righe := v_n; RETURN NEXT;

  --     11-ter. Un alunno «in arrivo» deve avere una frequenza viva in un anno che viene (in preparazione o con le iscrizioni
  --     aperte): un bambino in arrivo senza arrivo è una domanda approvata che non ha lasciato traccia nell'anno prossimo.
  --     Se l'anno è già diventato `corrente` e lo stato non è passato a `iscritto` (il passaggio non ha girato), lo dice questa
  --     riga: la frequenza non è più «di un anno che viene». (giro 2, R6) Un anno `corrente` che non è ancora cominciato lo è ancora (anche per la 11-quater).
  v_n := 0;
  IF to_regclass('public.alunni') IS NOT NULL AND to_regclass('public.frequenze') IS NOT NULL
     AND public.anno_ha_colonna('alunni', 'stato') THEN
    EXECUTE 'SELECT count(*) FROM public.alunni al WHERE al.stato = ''in_arrivo'' '
            'AND NOT EXISTS (SELECT 1 FROM public.frequenze f '
            'JOIN public.anni_sede s ON s.id = f.anno_sede_id '
            'WHERE f.alunno_id = al.id AND f.stato IN (''in_attesa'', ''iscritto'') '
            'AND (s.stato::text IN (''in_preparazione'', ''iscrizioni_aperte'') '
            'OR (s.stato::text = ''corrente'' AND s.inizio > public.giorno_roma(now()))))'
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni (in arrivo senza arrivo)'; righe := v_n; RETURN NEXT;

  --     11-quater (4.5.16, E). Una scheda ARCHIVIATA non deve avere una frequenza viva in un anno che viene: l'archiviazione la
  --     chiude (`chiudiFrequenzeAperte`), ma la scheda si scrive prima e la chiusura può non riuscire. In quel caso la quota
  --     resta visibile alla famiglia: la API lo dice e propone «Riprova», e questa riga è la rete per chi ricarica la pagina senza
  --     riprovare.
  v_n := 0;
  IF to_regclass('public.alunni') IS NOT NULL AND to_regclass('public.frequenze') IS NOT NULL
     AND to_regclass('public.anni_sede') IS NOT NULL AND public.anno_ha_colonna('alunni', 'archiviato_il') THEN
    EXECUTE 'SELECT count(*) FROM public.alunni al WHERE al.archiviato_il IS NOT NULL '
            'AND EXISTS (SELECT 1 FROM public.frequenze f '
            'JOIN public.anni_sede s ON s.id = f.anno_sede_id '
            'WHERE f.alunno_id = al.id AND f.stato IN (''in_attesa'', ''iscritto'') '
            'AND (s.stato::text IN (''in_preparazione'', ''iscrizioni_aperte'') '
            'OR (s.stato::text = ''corrente'' AND s.inizio > public.giorno_roma(now()) '
            -- (giro 3, NS4) La conferma TARDIVA fatta nella finestra è voluta: la scheda (archiviata dal passaggio) torna viva all'inizio, con la
            -- ricopia. Si riconosce dalla riga del passaggio (`eccezione`, `esce`/`non_risposto`) che punta a QUESTA frequenza, finché le schede
            -- non sono state ricopiate. Chi è stato archiviato dopo (dalla segreteria) ha la frequenza chiusa dall'archiviazione: non è qui.
            'AND NOT EXISTS (SELECT 1 FROM public.passaggi_anno_righe x JOIN public.passaggi_anno pt ON pt.id = x.passaggio_id '
            'WHERE x.frequenza_a_id = f.id AND x.eccezione AND x.esito IN (''esce'', ''non_risposto'') '
            'AND pt.stato = ''confermato'' AND pt.schede_copiate_il IS NULL))))'
    INTO v_n;
  END IF;
  invariante := '11'; tabella := 'alunni (archiviato con iscrizione viva)'; righe := v_n; RETURN NEXT;

  -- 13. I nomi di classe e gli uuid di sezione dicono la stessa cosa (una riga per tabella che ha le due colonne).
  FOR d IN SELECT x.tabella AS t, x.righe AS n FROM public.anno_target_divergenti() x LOOP
    v_trovata := true;
    invariante := '13'; tabella := d.t; righe := d.n; RETURN NEXT;
  END LOOP;
  IF NOT v_trovata THEN
    invariante := '13'; tabella := '(nessuna)'; righe := 0; RETURN NEXT;
  END IF;

  -- 8. I docenti vedono solo sezioni di anni attivi o passati (PR 4.3). Si passa dalla funzione di visibilità
  --    per ogni docente assegnato e si conta quante delle sezioni che restituisce hanno, nel catalogo
  --    (`anni_sede.stato`), un anno ancora in preparazione o con le iscrizioni aperte: deve essere zero.
  v_n := 0;
  IF to_regclass('public.utenti_sezioni') IS NOT NULL AND to_regclass('public.sections') IS NOT NULL THEN
    SELECT count(*) INTO v_n
      FROM (SELECT us.utente_id FROM public.utenti_sezioni us
             UNION SELECT um.utente_id FROM public.utenti_sezioni_materie um) u
     CROSS JOIN LATERAL public.sezioni_visibili_docente(u.utente_id) v
      JOIN public.sections s  ON s.id = v.section_id
      JOIN public.anni_sede a ON a.scuola_id = s.scuola_id AND a.anno_id = s.anno_id
     WHERE a.stato::text IN ('in_preparazione', 'iscrizioni_aperte');
  END IF;
  invariante := '8'; tabella := 'utenti_sezioni'; righe := v_n; RETURN NEXT;

  -- 7. Nessun genitore vede qualcosa attraverso un figlio non attivo (PR 4.4). Il perché di ogni scelta sta nella testata qui sopra.
  --    Le frequenze vive una volta sola, dal catalogo: un bambino vivo in due sedi compare due volte.
  SELECT coalesce(array_agg(f.alunno_id), '{}'), coalesce(array_agg(f.id), '{}') INTO v_figli_vivi, v_freq_vive
    FROM public.frequenze f
   WHERE f.stato IN ('in_attesa', 'iscritto')
     AND f.anno_sede_id = public.anno_visibile(f.scuola_id, v_oggi)
     AND f.data_ingresso <= v_oggi
     AND (f.data_uscita IS NULL OR f.data_uscita >= v_oggi);

  --    I bambini con una sede in cui hanno una frequenza e nessuna viva: è la coppia (figlio, sede) non viva.
  SELECT coalesce(array_agg(DISTINCT x.alunno_id), '{}') INTO v_lasciate
    FROM (SELECT f.alunno_id
            FROM public.frequenze f
           GROUP BY f.alunno_id, f.scuola_id
          HAVING NOT bool_or(f.id = ANY (v_freq_vive))) x;

  --    Tutte le coppie (genitore, figlio), per le due strade del legame di `figli_collegati`. `to_regclass` come lì.
  IF to_regclass('public.legame_genitori_alunni') IS NOT NULL THEN
    SELECT coalesce(array_agg(l.genitore_id), '{}'), coalesce(array_agg(l.alunno_id), '{}') INTO v_genitori, v_figli
      FROM public.legame_genitori_alunni l;
  END IF;
  IF to_regclass('public.student_parents') IS NOT NULL AND to_regclass('public.parents') IS NOT NULL THEN
    SELECT v_genitori || coalesce(array_agg(p.auth_user_id), '{}'), v_figli || coalesce(array_agg(sp.student_id), '{}')
      INTO v_genitori, v_figli
      FROM public.parents p
      JOIN public.student_parents sp ON sp.parent_id = p.id
     WHERE p.auth_user_id IS NOT NULL;
  END IF;

  --    Le funzioni di visibilità girano solo per chi ha una coppia non viva, e ognuno ha il suo blocco. Nessuno da guardare: girano
  --    lo stesso, una volta, per un genitore che non c'è.
  FOR v_gen IN
    WITH guardati AS (
      SELECT x.genitore,
             array_agg(x.figlio) AS figli,
             coalesce(array_agg(x.figlio) FILTER (WHERE vivo.alunno_id IS NULL), '{}') AS non_attivi
        FROM unnest(v_genitori, v_figli) AS x(genitore, figlio)
        LEFT JOIN (SELECT DISTINCT y.alunno_id FROM unnest(v_figli_vivi) AS y(alunno_id)) vivo ON vivo.alunno_id = x.figlio
        LEFT JOIN unnest(v_lasciate) AS lasciata(alunno_id) ON lasciata.alunno_id = x.figlio
       GROUP BY x.genitore
      HAVING bool_or(vivo.alunno_id IS NULL OR lasciata.alunno_id IS NOT NULL)
    )
    SELECT g.genitore, g.figli, g.non_attivi FROM guardati g
    UNION ALL
    SELECT NULL::uuid, '{}'::uuid[], '{}'::uuid[] WHERE NOT EXISTS (SELECT 1 FROM guardati)
  LOOP
    BEGIN
      IF to_regclass('public.galleria_media_v2') IS NOT NULL THEN
        -- Lo storico in array, come in `media_visibili_genitore`: la query delle foto resta statica anche dove la tabella non c'è.
        IF to_regclass('public.alunni_classi_storico') IS NOT NULL THEN
          SELECT coalesce(array_agg(h.alunno_id), '{}'), coalesce(array_agg(h.scuola_id), '{}'), coalesce(array_agg(h.section_id), '{}')
            INTO v_st_alunni, v_st_scuole, v_st_sezioni
            FROM public.alunni_classi_storico h
           WHERE h.alunno_id = ANY (v_gen.figli);
        END IF;
        v_foto := v_foto + (WITH sue AS MATERIALIZED (
                              SELECT f.alunno_id, f.scuola_id, f.section_id, f.id = ANY (v_freq_vive) AS viva
                                FROM public.frequenze f
                               WHERE f.alunno_id = ANY (v_gen.figli)
                              UNION ALL
                              SELECT h.alunno_id, h.scuola_id, h.section_id, false
                                FROM unnest(v_st_alunni, v_st_scuole, v_st_sezioni) AS h(alunno_id, scuola_id, section_id)
                            )
                            SELECT count(*)
                              FROM public.media_visibili_genitore(v_gen.genitore) v
                              LEFT JOIN public.galleria_media_v2 m ON m.id = v.media_id
                             WHERE NOT EXISTS (SELECT 1 FROM sue s WHERE s.viva AND s.alunno_id = v.alunno_id AND s.scuola_id = m.scuola_id)
                                OR (m.tag_students @> ARRAY[v.alunno_id]
                                    OR (m.is_broadcast = true
                                        AND coalesce(cardinality(m.target_section_ids), 0) = 0
                                        AND coalesce(cardinality(m.target_classes), 0) = 0)
                                    OR EXISTS (SELECT 1 FROM sue s
                                                WHERE s.alunno_id = v.alunno_id AND s.scuola_id = m.scuola_id
                                                  AND s.section_id = ANY (m.target_section_ids))) IS NOT TRUE);
      END IF;
      IF to_regclass('public.avvisi') IS NOT NULL THEN
        v_avvisi := v_avvisi + (WITH vive AS MATERIALIZED (
                                  SELECT f.alunno_id, f.scuola_id, f.section_id
                                    FROM public.frequenze f
                                   WHERE f.alunno_id = ANY (v_gen.figli) AND f.id = ANY (v_freq_vive)
                                )
                                SELECT count(*)
                                  FROM public.avvisi_visibili_genitore(v_gen.genitore) v
                                  LEFT JOIN public.avvisi a ON a.id = v.avviso_id
                                 WHERE NOT EXISTS (SELECT 1 FROM vive s
                                                    WHERE s.alunno_id = v.alunno_id AND s.scuola_id = a.scuola_id
                                                      AND (a.target_scope = 'globale' OR s.section_id = ANY (a.target_section_ids))));
      END IF;
      IF to_regclass('public.chat_threads') IS NOT NULL THEN
        v_thread := v_thread + (SELECT count(*)
                                  FROM public.thread_visibili(v_gen.genitore) v
                                  JOIN public.chat_threads t ON t.id = v.thread_id
                                 WHERE t.student_id = ANY (v_gen.non_attivi)
                                   AND t.teacher_id IS DISTINCT FROM v_gen.genitore);
      END IF;
      v_frequenze := v_frequenze + (SELECT count(*) FROM public.figli_attivi(v_gen.genitore) a WHERE a.frequenza_id <> ALL (v_freq_vive));
    EXCEPTION
      WHEN OTHERS THEN
        v_guasti := v_guasti + 1;
        v_guasto := SQLSTATE;
    END;
  END LOOP;

  invariante := '7'; tabella := 'galleria_media_v2'; righe := v_foto; RETURN NEXT;
  invariante := '7'; tabella := 'avvisi'; righe := v_avvisi; RETURN NEXT;
  invariante := '7'; tabella := 'chat_threads'; righe := v_thread; RETURN NEXT;
  invariante := '7'; tabella := 'frequenze'; righe := v_frequenze; RETURN NEXT;
  IF v_guasti > 0 THEN
    invariante := '7'; tabella := format('(controllo fallito: %s)', v_guasto); righe := v_guasti; RETURN NEXT;
  END IF;

  -- 15. (giro 2, R8) Ogni bambino in classe ha una riga aperta nello storico delle classi (le foto e le stampe per giorno la leggono).
  invariante := '15'; tabella := 'alunni_classi_storico (senza riga aperta)'; righe := public.passaggio_storico_senza_riga_aperta(); RETURN NEXT;

  -- 15-bis. (giro 4, NB4) Una scheda ARCHIVIATA non ha una classe: il diario, l'appello e la modulistica leggono `section_id` senza guardare lo stato.
  -- Numero `15-bis` perché la 4.9 tiene il suo `16`. In produzione vale 0 (misura del 09/11: 17 archiviate nelle sedi vere, nessuna con la classe).
  invariante := '15-bis'; tabella := 'alunni (archiviata con una classe)';
  righe := (SELECT count(*) FROM public.alunni al WHERE al.archiviato_il IS NOT NULL AND al.section_id IS NOT NULL); RETURN NEXT;

  RETURN;
END
$$;

-- ── Giro di correzione 3 · le scritture della segreteria nella finestra ─────────────────────────────────────────
-- `anno_visibile_oggi(sede)` = `anno_visibile(sede, oggi di Roma)`: l'anno che le SCHEDE seguono. Le route che scrivono la scheda (salvare,
-- archiviare, assegnare la classe) lavorano su questo anno e non sull'anno attivo, che nella finestra è il nuovo e non è ancora cominciato.
CREATE OR REPLACE FUNCTION public.anno_visibile_oggi(p_scuola uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.anno_visibile(p_scuola, public.giorno_roma(now()))
$$;
REVOKE ALL ON FUNCTION public.anno_visibile_oggi(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_visibile_oggi(uuid) TO service_role;

-- (Riattiva, giro 5) «Questa scheda è ANCORA archiviata dal passaggio?» Vera se il passaggio CONFERMATO che ha creato l'anno `p_anno_sede` ha chiuso la
-- frequenza `uscito` di questo bambino (riga `esce` o `non_risposto`) e la scheda ha `archiviato_il` che è del passaggio: non più tardi della
-- conferma (lo specchio scrive `now()` della transazione della conferma) oppure esattamente a mezzogiorno dell'uscita (lo scrive quando la fine
-- dell'anno vecchio è già passata o è oggi). Un'archiviazione della segreteria fatta DOPO la conferma ha un istante più tardi: è un'altra
-- archiviazione, e «Riattiva» la disfa come sempre. Un passaggio annullato ha lo stato `annullato` e non conta; il riconfermato è una riga nuova,
-- con la sua `confermato_il`. La porta del passaggio resta una sola: questa funzione NON è `passaggio_*` e la route non legge nessuna `passaggi_anno*`.
CREATE OR REPLACE FUNCTION public.anno_alunno_archiviato_dal_passaggio(p_alunno uuid, p_anno_sede uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.alunni al
      JOIN public.passaggi_anno p ON p.a_anno_sede_id = p_anno_sede AND p.scuola_id = al.scuola_id AND p.stato = 'confermato'
      JOIN public.passaggi_anno_righe r ON r.passaggio_id = p.id AND r.alunno_id = al.id AND r.esito IN ('esce', 'non_risposto')
      JOIN public.frequenze f ON f.id = r.frequenza_da_id AND f.stato = 'uscito'
     WHERE al.id = p_alunno
       AND al.archiviato_il IS NOT NULL
       AND (al.archiviato_il <= p.confermato_il
            OR al.archiviato_il = ((f.data_uscita + time '12:00') AT TIME ZONE 'Europe/Rome'))
  )
$$;
REVOKE ALL ON FUNCTION public.anno_alunno_archiviato_dal_passaggio(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_alunno_archiviato_dal_passaggio(uuid, uuid) TO service_role;

-- (giro 3, NB1) `sync_alunno_section_id`: copia dell'ULTIMA definizione (`20261106200347_anno_scolastico_schema.sql`); cambia solo l'anno in cui
-- si risolve il nome della classe (visibile invece di attivo).
CREATE OR REPLACE FUNCTION public.sync_alunno_section_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Solo quando abbiamo un nome classe da risolvere.
  IF NEW.classe_sezione IS NOT NULL AND length(trim(NEW.classe_sezione)) > 0 THEN
    -- Risolvi solo se è un INSERT, oppure se classe_sezione è cambiata, oppure se
    -- section_id non è ancora valorizzato. (Non sovrascrive un section_id impostato
    -- esplicitamente quando classe_sezione non cambia.)
    IF TG_OP = 'INSERT'
       OR NEW.classe_sezione IS DISTINCT FROM OLD.classe_sezione
       OR NEW.section_id IS NULL THEN
      -- 1.2 · NOVITÀ: solo le sezioni dell'anno della sede che le schede seguono. Il nome è unico per
      -- (sede, anno): con due «Girasoli» in due anni, il LIMIT 1 senza anno ne sceglierebbe una a caso.
      SELECT s.id INTO NEW.section_id
      FROM public.sections s
      WHERE s.scuola_id = NEW.scuola_id
        -- (giro 3, NB1) L'anno che le schede seguono (`anno_visibile_oggi`), non l'attivo: nella finestra fra la conferma del passaggio e
        -- l'inizio dell'anno nuovo l'attivo è il nuovo, e un nome di classe del vecchio anno non si risolverebbe (section_id a NULL).
        -- Fuori dalla finestra i due anni coincidono: stesso risultato di prima.
        -- (giro 4, NB3) In un INSERT dentro la finestra il nome si cerca PRIMA nell'anno attivo (il nuovo, come fa il `POST` della segreteria), poi nel
        -- visibile: con un nome che c'è in tutti e due («Girasoli») le due strade scelgono la stessa classe. Un nome solo del vecchio anno (un centro
        -- estivo) resta nel vecchio. Fuori dalla finestra l'attivo e il visibile coincidono.
        AND s.anno_id IN (SELECT a.anno_id FROM public.anni_sede a
                           WHERE a.id = public.anno_visibile_oggi(NEW.scuola_id)
                              OR (TG_OP = 'INSERT' AND a.id = public.anno_attivo(NEW.scuola_id)))
        AND lower(replace(s.name, ' ', '')) = lower(replace(NEW.classe_sezione, ' ', ''))
      ORDER BY (s.anno_id = (SELECT a.anno_id FROM public.anni_sede a WHERE a.id = public.anno_attivo(NEW.scuola_id)) AND TG_OP = 'INSERT') DESC
      LIMIT 1;

      -- Nessuna sezione combacia: l'alunno resta senza classe e non comparirà in
      -- nessun appello né in nessun registro. Prima questo ramo non esisteva e
      -- l'unico segnale era il silenzio.
      IF NEW.section_id IS NULL THEN
        INSERT INTO public.app_log (
          livello, evento, sorgente, messaggio, fingerprint, scuola_id, contesto
        )
        VALUES (
          'warn', 'anagrafica', 'server',
          'classe senza sezione corrispondente: l''alunno resta fuori da ogni registro',
          'db:alunno-senza-sezione:' || coalesce(NEW.scuola_id::text, 'senza-sede'),
          NEW.scuola_id,
          jsonb_build_object(
            'esito', 'alunno-senza-sezione',
            'operazione', 'sync_alunno_section_id',
            'sezione', NEW.classe_sezione,
            'alunno_id', NEW.id,
            'origine', TG_OP
          )
        )
        ON CONFLICT (fingerprint, giorno) DO UPDATE
          SET occorrenze = public.app_log.occorrenze + 1,
              visto_l_ultima = now();
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- (giro 3, NB3) `anno_registra_frequenza`: copia dell'ULTIMA definizione (`20261109035219_anno_iscrizione_conferma.sql`, nessuna migrazione
-- successiva la ridefinisce). Cambia UNA condizione: accetta anche un anno `corrente` non ancora cominciato.
CREATE OR REPLACE FUNCTION public.anno_registra_frequenza(
  p_alunno uuid, p_anno_sede uuid, p_tipo text, p_origine text, p_domanda uuid,
  p_section uuid, p_data_ingresso date, p_campi jsonb, p_da uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a      public.anni_sede%ROWTYPE;
  v_scuola uuid;
  v_f      public.frequenze%ROWTYPE;
  v_creata boolean := false;
  v_campi  jsonb := coalesce(p_campi, '{}'::jsonb);
  v_retta  numeric;
  v_giorno integer;
  v_quota  jsonb;
  v_fascia text;
  v_oltre  boolean;
  v_ignorata boolean := false;
  v_riaperta boolean := false;
  v_chiusa   boolean := false;
BEGIN
  IF p_tipo IS NULL OR p_tipo NOT IN ('conferma', 'nuova') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'tipo')::text;
  END IF;
  IF p_origine IS NULL OR p_origine NOT IN ('domanda', 'conferma', 'segreteria', 'import') THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'origine')::text;
  END IF;
  IF jsonb_typeof(v_campi) <> 'object' THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'campi')::text;
  END IF;

  SELECT * INTO v_a FROM public.anni_sede WHERE id = p_anno_sede FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNO_NON_TROVATO' USING DETAIL = json_build_object('anno_sede_id', p_anno_sede)::text;
  END IF;
  -- (giro 3, NB3) Un anno `corrente` che non è ancora cominciato (la finestra fra la conferma del passaggio e l'inizio) accetta le
  -- iscrizioni come un anno con le iscrizioni aperte: agosto è il mese in cui la segreteria iscrive i bambini nuovi.
  IF v_a.stato <> 'iscrizioni_aperte' AND NOT (v_a.stato = 'corrente' AND v_a.inizio > public.giorno_roma(now())) THEN
    RAISE EXCEPTION 'ANNO_NON_APERTO'
      USING DETAIL = json_build_object('anno_sede_id', v_a.id, 'stato', v_a.stato)::text;
  END IF;

  SELECT a.scuola_id INTO v_scuola FROM public.alunni a WHERE a.id = p_alunno;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PARAMETRO_MANCANTE' USING DETAIL = json_build_object('campo', 'alunno')::text;
  END IF;
  IF v_scuola IS DISTINCT FROM v_a.scuola_id THEN
    RAISE EXCEPTION 'SEDE_DIVERSA' USING DETAIL = json_build_object('anno_sede_id', v_a.id)::text;
  END IF;

  SELECT * INTO v_f FROM public.frequenze WHERE alunno_id = p_alunno AND anno_sede_id = p_anno_sede FOR UPDATE;
  IF FOUND THEN
    IF p_domanda IS NOT NULL AND v_f.domanda_id IS NULL THEN
      UPDATE public.frequenze SET domanda_id = p_domanda WHERE id = v_f.id;
    END IF;
    -- 4.5.15 (M4): la frequenza c'e' gia' e la sezione NON si cambia da qui (la classe la sposta la segreteria, con il suo gesto).
    -- Ma chi ha chiesto una sezione diversa deve saperlo: il silenzio farebbe credere che sia stata applicata.
    IF v_f.stato = 'ritirato' THEN
      -- 4.5.16: la STESSA riga (la coppia bambino-anno e' unica) si riapre. Le chiavi presenti in `p_campi` valgono, con la lista
      -- bianca dell'INSERT; quelle assenti restano come sono. `tipo` e `origine` non cambiano.
      UPDATE public.frequenze f SET
        stato = 'in_attesa',
        data_uscita = NULL,
        section_id = coalesce(p_section, f.section_id),
        domanda_id = coalesce(p_domanda, f.domanda_id),
        retta_mensile = CASE WHEN v_campi ? 'retta_mensile'
          THEN CASE WHEN nullif(v_campi ->> 'retta_mensile', '')::numeric > 0 THEN nullif(v_campi ->> 'retta_mensile', '')::numeric END
          ELSE f.retta_mensile END,
        retta_esente = CASE WHEN v_campi ? 'retta_esente' THEN coalesce((v_campi ->> 'retta_esente')::boolean, false) ELSE f.retta_esente END,
        retta_a_carico_di = CASE WHEN v_campi ? 'retta_a_carico_di' THEN (v_campi ->> 'retta_a_carico_di')::uuid ELSE f.retta_a_carico_di END,
        retta_split_config = CASE WHEN v_campi ? 'retta_split_config' THEN nullif(v_campi -> 'retta_split_config', 'null'::jsonb) ELSE f.retta_split_config END,
        intestatario_fatture = CASE WHEN v_campi ? 'intestatario_fatture' THEN nullif(v_campi -> 'intestatario_fatture', 'null'::jsonb) ELSE f.intestatario_fatture END,
        giorno_scadenza_pagamenti = CASE WHEN v_campi ? 'giorno_scadenza_pagamenti'
          THEN CASE WHEN nullif(v_campi ->> 'giorno_scadenza_pagamenti', '')::integer BETWEEN 1 AND 28 THEN nullif(v_campi ->> 'giorno_scadenza_pagamenti', '')::integer END
          ELSE f.giorno_scadenza_pagamenti END,
        gruppo_mensa_id = CASE WHEN v_campi ? 'gruppo_mensa_id' THEN (v_campi ->> 'gruppo_mensa_id')::uuid ELSE f.gruppo_mensa_id END,
        usa_pannolino = CASE WHEN v_campi ? 'usa_pannolino' THEN coalesce((v_campi ->> 'usa_pannolino')::boolean, false) ELSE f.usa_pannolino END
       WHERE f.id = v_f.id;
      SELECT * INTO v_f FROM public.frequenze WHERE id = v_f.id;
      v_riaperta := true;
    ELSIF v_f.stato IN ('in_attesa', 'iscritto') THEN
      v_ignorata := p_section IS NOT NULL AND v_f.section_id IS DISTINCT FROM p_section;
    ELSE
      -- `trasferito` o `uscito`: non si riapre da qui. La domanda e' stata collegata (sopra); la voce non nasce.
      v_chiusa := true;
    END IF;
  ELSE
    v_retta := nullif(v_campi ->> 'retta_mensile', '')::numeric;
    v_giorno := nullif(v_campi ->> 'giorno_scadenza_pagamenti', '')::integer;
    INSERT INTO public.frequenze
      (alunno_id, anno_sede_id, section_id, domanda_id, tipo, stato, origine, data_ingresso,
       retta_mensile, retta_esente, retta_a_carico_di, retta_split_config, intestatario_fatture,
       giorno_scadenza_pagamenti, gruppo_mensa_id, usa_pannolino)
    VALUES
      (p_alunno, v_a.id, p_section, p_domanda, p_tipo, 'in_attesa', p_origine, coalesce(p_data_ingresso, v_a.inizio),
       CASE WHEN v_retta > 0 THEN v_retta END,
       coalesce((v_campi ->> 'retta_esente')::boolean, false),
       (v_campi ->> 'retta_a_carico_di')::uuid,
       nullif(v_campi -> 'retta_split_config', 'null'::jsonb),
       nullif(v_campi -> 'intestatario_fatture', 'null'::jsonb),
       CASE WHEN v_giorno BETWEEN 1 AND 28 THEN v_giorno END,
       (v_campi ->> 'gruppo_mensa_id')::uuid,
       coalesce((v_campi ->> 'usa_pannolino')::boolean, false))
    ON CONFLICT (alunno_id, anno_sede_id) DO NOTHING
    RETURNING * INTO v_f;
    IF FOUND THEN
      v_creata := true;
    ELSE
      -- Un'altra transazione l'ha scritta un attimo prima: è quella.
      SELECT * INTO v_f FROM public.frequenze WHERE alunno_id = p_alunno AND anno_sede_id = p_anno_sede FOR UPDATE;
    END IF;
  END IF;

  IF v_f.stato IN ('in_attesa', 'iscritto') THEN
    v_quota := public.anno_quota_voce(v_f.id, p_da);
  ELSE
    v_quota := jsonb_build_object('esito', NULL, 'pagamento_id', v_f.quota_pagamento_id);
  END IF;

  SELECT coalesce(s.fascia, CASE WHEN f.section_id IS NULL THEN 'senza_sezione' ELSE 'senza_fascia' END) INTO v_fascia
    FROM public.frequenze f LEFT JOIN public.sections s ON s.id = f.section_id
   WHERE f.id = v_f.id;
  SELECT coalesce(bool_or(c.oltre), false) INTO v_oltre
    FROM public.anno_conta_posti(v_a.id) c WHERE c.fascia = v_fascia;

  RETURN jsonb_build_object('frequenza_id', v_f.id, 'creata', v_creata,
                            'quota', v_quota -> 'esito', 'pagamento_id', v_quota -> 'pagamento_id',
                            'posti_oltre', v_oltre)
         || CASE WHEN v_ignorata THEN jsonb_build_object('sezione_ignorata', true) ELSE '{}'::jsonb END
         || CASE WHEN v_riaperta THEN jsonb_build_object('riaperta', true) ELSE '{}'::jsonb END
         || CASE WHEN v_chiusa THEN jsonb_build_object('chiusa', true) ELSE '{}'::jsonb END;
END
$$;

-- ── passaggio_oggi ───────────────────────────────────────────────────────────────────────────────
-- Il giorno di oggi per una sede. NULL = oggi a Roma. Un giorno scelto da chi chiama è ammesso SOLO per le sedi di prova
-- (`e2e00000…`) o messe in `anno_regole.sedi_simulazione`: la stessa porta di `anni_tick` (ANNI_TICK_OGGI_NON_AMMESSO).
CREATE OR REPLACE FUNCTION public.passaggio_oggi(p_scuola uuid, p_oggi date)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_oggi IS NULL THEN
    RETURN public.giorno_roma(now());
  END IF;
  IF p_scuola::text LIKE 'e2e00000%'
     OR EXISTS (SELECT 1 FROM public.anno_regole g WHERE p_scuola = ANY (g.sedi_simulazione)) THEN
    RETURN p_oggi;
  END IF;
  RAISE EXCEPTION 'PASSAGGIO_OGGI_NON_AMMESSO';
END
$$;

-- ── passaggio_log ────────────────────────────────────────────────────────────────────────────────
-- Una riga di `app_log` con i SOLI numeri e uuid (mai un nome, mai un conteggio per bambino). Mai un errore: se il log non si scrive,
-- il passaggio non per questo si ferma.
CREATE OR REPLACE FUNCTION public.passaggio_log(p_scuola uuid, p_esito text, p_passaggio uuid, p_campi jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
  VALUES ('info', 'anno-scolastico', 'server', 'passaggio d''anno: ' || p_esito, p_scuola,
          'passaggio-' || p_esito || ':' || p_passaggio::text,
          jsonb_build_object('campi', jsonb_build_object('operazione', 'passaggio', 'esito', p_esito, 'entita_id', p_passaggio) || p_campi))
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'passaggio_log: riga non scritta [%]', SQLSTATE;
END
$$;

-- ── passaggio_conferma ───────────────────────────────────────────────────────────────────────────
-- Il giorno dopo l'ultimo giorno aperto dell'anno vecchio la segreteria conferma: cambia l'anno attivo.
-- Codici: PASSAGGIO_OGGI_NON_AMMESSO (per primo), PASSAGGIO_NON_TROVATO, PASSAGGIO_NON_MODIFICABILE (annullato),
--   PASSAGGIO_TROPPO_PRESTO (`oggi <= ultimo_giorno_aperto` del vecchio), PASSAGGIO_NON_PRONTO, ANTEPRIMA_VECCHIA (le righe non
--   coincidono più col ricalcolo, ignorando le eccezioni: DETAIL {righe_diverse}), RIGHE_DA_DECIDERE (DETAIL {senza_sezione,
--   ritirato_tendina}: righe che continuano, cambiano grado o sono nuove senza classe nuova, e “ritirato” dalla tendina da decidere).
-- Rifatta su un passaggio già confermato ritorna `gia_confermato: true` SENZA scrivere niente.
--
-- ORDINE OBBLIGATORIO (una transazione; `FOR UPDATE` sui due anni e sul passaggio, sempre in questo ordine):
--   1. i controlli e il ricalcolo;
--   2. le USCITE, mentre il vecchio è ancora l'anno attivo: la specchiatura sulla scheda dell'alunno (ritirato, archiviato) guarda
--      l'anno attivo, e deve guardare quello vecchio. Per ogni `esce`/`non_risposto` la frequenza vecchia diventa `uscito` con
--      `data_uscita` = fine dell'anno, e lo stato di prima si salva (serve all'annullamento). Un “esce” scelto a mano su chi ha già
--      una frequenza nuova viva ritira anche quella (`ritirato`, uscita = ingresso);
--   3. i DOCENTI: le assegnazioni `copiata`/`aggiunta` entrano in `utenti_sezioni` (se mancano), e si ricorda quali ha scritto la conferma;
--   4. la DIDATTICA: `passaggio_copia_didattica`;
--   5. le classi scelte a mano: `frequenze.section_id` delle righe con eccezione;
--   6. il CAMBIO DI STATO: il vecchio `corrente → in_chiusura` se serve, le domande del vecchio si chiudono, il nuovo diventa `corrente`
--      (il vecchio PRIMA del nuovo: un solo `corrente` per sede); una riga in `anni_sede_stati` per ciascuno; i valori di prima in `conteggi`;
--   7. lo SPECCHIO: `alunni_riallinea_da_frequenze` per ogni bambino del passaggio, ora che l'anno attivo è il nuovo (a chi non ha una
--      frequenza nell'anno nuovo non cambia niente; a chi l'ha ritirata a mano segue la scheda);
--   8. il passaggio diventa `confermato`, con chi e quando, i conteggi, e una riga di log con i soli numeri.
-- Risposta: {passaggio_id, gia_confermato, conteggi{continuano, nuovi, usciti, cambia_grado, docenti_copiati}}.
CREATE OR REPLACE FUNCTION public.passaggio_conferma(p_passaggio uuid, p_da uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p        public.passaggi_anno%ROWTYPE;
  v_da       public.anni_sede%ROWTYPE;
  v_a        public.anni_sede%ROWTYPE;
  v_oggi     date;
  v_diverse  integer;
  v_senza    integer;
  v_tendina  integer;
  v_continuano integer;
  v_nuovi    integer;
  v_cambia   integer;
  v_usciti   integer := 0;
  v_docenti  integer := 0;
  v_didattica jsonb;
  v_giro     record;
  v_conteggi jsonb;
BEGIN
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  v_oggi := public.passaggio_oggi(v_p.scuola_id, p_oggi);

  -- I due anni prima, poi il passaggio: lo stesso ordine di `passaggio_anteprima` (nessuna attesa circolare).
  PERFORM 1 FROM public.anni_sede WHERE id IN (v_p.da_anno_sede_id, v_p.a_anno_sede_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;

  IF v_p.stato = 'confermato' THEN
    RETURN jsonb_build_object('passaggio_id', v_p.id, 'gia_confermato', true, 'conteggi', jsonb_build_object(
      'continuano', coalesce((v_p.conteggi ->> 'continuano')::integer, 0), 'nuovi', coalesce((v_p.conteggi ->> 'nuovi')::integer, 0),
      'usciti', coalesce((v_p.conteggi ->> 'usciti')::integer, 0), 'cambia_grado', coalesce((v_p.conteggi ->> 'cambia_grado')::integer, 0),
      'docenti_copiati', coalesce((v_p.conteggi ->> 'docenti_copiati')::integer, 0)));
  END IF;
  IF v_p.stato <> 'anteprima' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_MODIFICABILE' USING DETAIL = json_build_object('passaggio_id', v_p.id)::text;
  END IF;

  SELECT * INTO v_da FROM public.anni_sede WHERE id = v_p.da_anno_sede_id;
  SELECT * INTO v_a  FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;

  -- 1 · controlli e ricalcolo
  IF v_oggi <= v_da.ultimo_giorno_aperto THEN
    RAISE EXCEPTION 'PASSAGGIO_TROPPO_PRESTO'
      USING DETAIL = json_build_object('giorni_mancanti', v_da.ultimo_giorno_aperto - v_oggi + 1)::text;
  END IF;
  IF v_a.stato <> 'iscrizioni_aperte' OR public.anno_attivo(v_da.scuola_id) IS DISTINCT FROM v_da.id THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_PRONTO' USING HINT = 'anni-cambiati';
  END IF;

  SELECT count(*) INTO v_diverse
    FROM (SELECT x.* FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id) r2
    FULL JOIN public.passaggio_calcola(v_da.id, v_a.id) c ON c.alunno_id = r2.alunno_id
   WHERE r2.alunno_id IS NULL OR c.alunno_id IS NULL
      OR r2.frequenza_da_id IS DISTINCT FROM c.frequenza_da_id
      OR (r2.eccezione AND ((r2.frequenza_a_id IS NULL) <> (c.frequenza_a_id IS NULL)))
      -- (giro 2, B6) la tendina «ritirato»/«sospeso» comparsa DOPO una scelta a mano: la riga in eccezione non la porta, il ricalcolo sì
      OR (r2.eccezione AND r2.esito IN ('continua', 'cambia_grado', 'nuova') AND NOT r2.tendina_decisa
          AND c.avviso = 'ritirato_tendina' AND r2.avviso IS DISTINCT FROM 'ritirato_tendina')
      OR (NOT r2.eccezione AND (r2.esito <> c.esito
                                OR r2.frequenza_a_id IS DISTINCT FROM c.frequenza_a_id
                                OR r2.sezione_a_id IS DISTINCT FROM c.sezione_a_id
                                OR r2.avviso IS DISTINCT FROM c.avviso));
  IF v_diverse > 0 THEN
    RAISE EXCEPTION 'ANTEPRIMA_VECCHIA' USING DETAIL = json_build_object('righe_diverse', v_diverse)::text;
  END IF;

  SELECT count(*) FILTER (WHERE esito IN ('continua', 'cambia_grado', 'nuova') AND sezione_a_id IS NULL),
         count(*) FILTER (WHERE avviso = 'ritirato_tendina'),
         count(*) FILTER (WHERE esito = 'continua'),
         count(*) FILTER (WHERE esito = 'nuova'),
         count(*) FILTER (WHERE esito = 'cambia_grado')
    INTO v_senza, v_tendina, v_continuano, v_nuovi, v_cambia
    FROM public.passaggi_anno_righe WHERE passaggio_id = v_p.id;
  IF v_senza > 0 OR v_tendina > 0 THEN
    RAISE EXCEPTION 'RIGHE_DA_DECIDERE'
      USING DETAIL = json_build_object('senza_sezione', v_senza, 'ritirato_tendina', v_tendina)::text;
  END IF;

  -- 1bis · (giro 1, B6) la scheda dell'alunno com'è ADESSO, perché l'annullo la rimetta: lo specchio di sotto la riscrive.
  UPDATE public.passaggi_anno_righe r SET scheda_da_prima = al.stato, scheda_archiviata_da_prima = al.archiviato_il
    FROM public.alunni al
   WHERE r.passaggio_id = v_p.id AND al.id = r.alunno_id;

  -- 2 · le uscite, con il vecchio ancora attivo
  UPDATE public.passaggi_anno_righe r SET stato_da_prima = f.stato
    FROM public.frequenze f
   WHERE r.passaggio_id = v_p.id AND r.esito IN ('esce', 'non_risposto') AND f.id = r.frequenza_da_id AND f.stato IN ('in_attesa', 'iscritto');
  UPDATE public.frequenze f SET stato = 'uscito', data_uscita = v_da.fine
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.esito IN ('esce', 'non_risposto') AND f.id = r.frequenza_da_id AND f.stato IN ('in_attesa', 'iscritto');
  GET DIAGNOSTICS v_usciti = ROW_COUNT;
  UPDATE public.frequenze f SET stato = 'ritirato', data_uscita = f.data_ingresso
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.esito = 'esce' AND r.frequenza_a_id IS NOT NULL AND f.id = r.frequenza_a_id AND f.stato IN ('in_attesa', 'iscritto');

  -- 3 · i docenti
  WITH nuovi AS (
    INSERT INTO public.utenti_sezioni (utente_id, section_id)
    SELECT d.utente_id, d.sezione_a_id
      FROM public.passaggi_anno_docenti d
     WHERE d.passaggio_id = v_p.id AND d.origine IN ('copiata', 'aggiunta')
       -- (giro 2, B5/R7) esiste, e non è stato archiviato dopo l'anteprima
       AND EXISTS (SELECT 1 FROM public.utenti u WHERE u.id = d.utente_id AND u.archiviato_il IS NULL)
       -- (giro 2, B5) una COPIA vale solo se chi la porta è ancora sulla classe vecchia, come nel ricalcolo: la maestra tolta dalla classe
       -- vecchia dopo l'anteprima non prende la classe nuova anche senza «Ricalcola». Le `aggiunta` sono scelte a mano e restano.
       AND (d.origine = 'aggiunta'
            OR EXISTS (SELECT 1
                         FROM public.utenti_sezioni us
                         JOIN public.sections sn ON sn.id = d.sezione_a_id
                         JOIN public.sections so ON so.id = sn.continua_da AND so.id = us.section_id
                        WHERE us.utente_id = d.utente_id AND so.anno_id = v_da.anno_id AND so.scuola_id = v_da.scuola_id))
    ON CONFLICT DO NOTHING
    RETURNING utente_id, section_id)
  UPDATE public.passaggi_anno_docenti d SET inserita = true
    FROM nuovi n
   WHERE d.passaggio_id = v_p.id AND d.utente_id = n.utente_id AND d.sezione_a_id = n.section_id;
  GET DIAGNOSTICS v_docenti = ROW_COUNT;

  -- 4 · la didattica della classe nuova
  v_didattica := public.passaggio_copia_didattica(v_p.id);

  -- 5 · le classi scelte a mano
  UPDATE public.frequenze f SET section_id = r.sezione_a_id
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.eccezione AND r.esito IN ('continua', 'cambia_grado', 'nuova') AND r.sezione_a_id IS NOT NULL
     AND f.id = r.frequenza_a_id AND f.stato IN ('in_attesa', 'iscritto') AND f.section_id IS DISTINCT FROM r.sezione_a_id;

  -- 6 · il cambio di stato: il vecchio prima del nuovo (un solo `corrente` per sede)
  v_conteggi := jsonb_build_object(
    'stato_da_prima', v_da.stato, 'domande_da_prima', v_da.domande_aperte,
    'continuano', v_continuano, 'nuovi', v_nuovi, 'usciti', v_usciti, 'cambia_grado', v_cambia, 'docenti_copiati', v_docenti);
  IF v_da.stato = 'corrente' THEN
    UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE id = v_da.id;
    INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_da.id, 'in_chiusura', p_da);
  END IF;
  UPDATE public.anni_sede SET domande_aperte = false WHERE id = v_da.id;
  UPDATE public.anni_sede SET stato = 'corrente' WHERE id = v_a.id;
  INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_a.id, 'corrente', p_da);

  -- 6bis · (giro 1, B6/R2; giro 2: anche «sospeso») «continua» scelto dalla segreteria su un bambino con la tendina «ritirato» o
  -- «sospeso» è una decisione esplicita: la scheda torna `iscritto` (e non archiviata). L'annullo la rimette com'era (`scheda_da_prima`).
  UPDATE public.alunni al SET stato = 'iscritto', archiviato_il = NULL, archiviato_da = NULL, archiviato_motivo = NULL, archiviato_section_id = NULL, archiviato_classe_sezione = NULL
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.tendina_decisa AND r.esito IN ('continua', 'cambia_grado')
     AND al.id = r.alunno_id AND al.stato IN ('ritirato', 'sospeso') AND al.anonimizzato_il IS NULL;

  -- 7 · lo specchio. (giro 2, R6) Copia la frequenza dell'anno VISIBILE: se il nuovo anno è già cominciato è il nuovo, altrimenti
  -- resta il vecchio e la scheda non si muove (chi esce l'ha già avuta ritirata al passo 2); le schede passano sulla classe nuova il
  -- giorno dell'`inizio`, con `passaggio_ricopia_schede`.
  FOR v_giro IN
    SELECT x.alunno_id FROM public.passaggi_anno_righe x
     WHERE x.passaggio_id = v_p.id
  LOOP
    PERFORM public.alunni_riallinea_da_frequenze(v_giro.alunno_id);
  END LOOP;

  -- 8 · confermato
  UPDATE public.passaggi_anno
     SET stato = 'confermato', confermato_da = p_da, confermato_il = now(), conteggi = v_conteggi,
         schede_copiate_il = CASE WHEN v_a.inizio <= v_oggi THEN now() END
   WHERE id = v_p.id;

  PERFORM public.passaggio_log(v_p.scuola_id, 'confermato', v_p.id,
    jsonb_build_object('n_continuano', v_continuano, 'n_nuovi', v_nuovi, 'n_usciti', v_usciti, 'n_cambia_grado', v_cambia,
                       'n_docenti_copiati', v_docenti, 'n_materie', coalesce((v_didattica ->> 'materie')::integer, 0)));

  RETURN jsonb_build_object('passaggio_id', v_p.id, 'gia_confermato', false, 'conteggi', jsonb_build_object(
    'continuano', v_continuano, 'nuovi', v_nuovi, 'usciti', v_usciti, 'cambia_grado', v_cambia, 'docenti_copiati', v_docenti));
END
$$;

-- ── passaggio_annulla ────────────────────────────────────────────────────────────────────────────
-- Annulla un passaggio. Un'anteprima si scarta (nessun effetto da disfare). Un passaggio CONFERMATO si annulla solo se nel nuovo anno non
-- c'è ancora niente d'USO: PASSAGGIO_NON_ANNULLABILE, con DETAIL i conteggi per tabella, se una tabella del registro con `modo = 'data'`
-- ha già righe nei giorni del nuovo anno. Fuori dal conto stanno `iscrizioni_servizi` e `eventi_agenda` (le prepara la segreteria in
-- anticipo); le tabelle `dichiarato` (classi, frequenze, pagamenti, domande) e le figlie non contano mai: le crea la preparazione.
-- Disfa, nell'ordine: il nuovo torna `iscrizioni_aperte`; il vecchio torna `corrente` SOLO se lo era e se oggi è ancora dentro il suo
-- periodo; `domande_aperte` del vecchio torna com'era; i `uscito` tornano al loro stato di prima (`data_uscita` vuota); i `ritirato`
-- per eccezione tornano vivi; si tolgono i soli `utenti_sezioni` scritti dalla conferma; lo specchio si rifà per tutti. LE COPIE
-- DIDATTICHE RESTANO (sono lavoro della segreteria: ricopiarle non duplica). Idempotente: rifatta ritorna `gia_annullato: true`.
CREATE OR REPLACE FUNCTION public.passaggio_annulla(p_passaggio uuid, p_da uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p       public.passaggi_anno%ROWTYPE;
  v_da      public.anni_sede%ROWTYPE;
  v_a       public.anni_sede%ROWTYPE;
  v_oggi    date;
  v_uso     jsonb := '{}'::jsonb;
  v_n       bigint;
  v_tab     record;
  v_giro    record;
  v_riaperto boolean := false;
  v_tornati integer := 0;
  v_ritirati integer := 0;
  v_tolti   integer := 0;
  v_tardive integer := 0;
  v_post    jsonb;
BEGIN
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  v_oggi := public.passaggio_oggi(v_p.scuola_id, p_oggi);

  PERFORM 1 FROM public.anni_sede WHERE id IN (v_p.da_anno_sede_id, v_p.a_anno_sede_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;

  IF v_p.stato = 'annullato' THEN
    RETURN jsonb_build_object('passaggio_id', v_p.id, 'gia_annullato', true);
  END IF;

  IF v_p.stato = 'anteprima' THEN
    UPDATE public.passaggi_anno SET stato = 'annullato', annullato_da = p_da, annullato_il = now() WHERE id = v_p.id;
    PERFORM public.passaggio_log(v_p.scuola_id, 'annullato', v_p.id, jsonb_build_object('n_ripristinati', 0));
    RETURN jsonb_build_object('passaggio_id', v_p.id, 'conteggi', jsonb_build_object('ripristinati', 0));
  END IF;

  SELECT * INTO v_da FROM public.anni_sede WHERE id = v_p.da_anno_sede_id;
  SELECT * INTO v_a  FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;

  -- Il nuovo dev'essere ancora l'anno in corso, e senza niente d'uso.
  IF v_a.stato <> 'corrente' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_ANNULLABILE' USING DETAIL = json_build_object('anno_non_corrente', 1)::text;
  END IF;
  FOR v_tab IN
    SELECT g.tabella FROM public.anno_tabelle g
     WHERE g.modo = 'data' AND g.tabella NOT IN ('iscrizioni_servizi', 'eventi_agenda')
       AND to_regclass('public.' || g.tabella) IS NOT NULL
     ORDER BY g.tabella
  LOOP
    v_n := public.anno_conta_righe_assegnate_nei_giorni(v_tab.tabella, v_a.anno_id, v_a.scuola_id, v_a.inizio, v_a.fine);
    IF v_n > 0 THEN
      v_uso := v_uso || jsonb_build_object(v_tab.tabella, v_n);
    END IF;
  END LOOP;
  -- (giro 1, S8) Un'iscrizione registrata DOPO la conferma (non è una conferma tardiva del passaggio) è un uso del nuovo anno: annullare
  -- la lascerebbe viva in una classe di un anno tornato `iscrizioni_aperte`. Si rifiuta e si dice quante sono.
  SELECT count(*) INTO v_n FROM public.frequenze f
   WHERE f.anno_sede_id = v_a.id AND f.stato IN ('in_attesa', 'iscritto')
     AND f.creata_il > v_p.confermato_il AND f.origine IS DISTINCT FROM 'passaggio';
  IF v_n > 0 THEN
    v_uso := v_uso || jsonb_build_object('frequenze_dopo_la_conferma', v_n);
  END IF;
  IF v_uso <> '{}'::jsonb THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_ANNULLABILE' USING DETAIL = v_uso::text;
  END IF;
  -- (giro 1, S4) Le conferme tardive del passaggio restano: la frequenza e la voce di quota sono della famiglia. Si dice quante sono.
  SELECT count(*) INTO v_tardive FROM public.frequenze f
   WHERE f.anno_sede_id = v_a.id AND f.stato IN ('in_attesa', 'iscritto')
     AND f.creata_il > v_p.confermato_il AND f.origine = 'passaggio';

  -- Gli anni: il nuovo lascia il posto di `corrente` PRIMA che il vecchio lo riprenda.
  UPDATE public.anni_sede SET stato = 'iscrizioni_aperte' WHERE id = v_a.id;
  INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_a.id, 'iscrizioni_aperte', p_da);
  IF coalesce(v_p.conteggi ->> 'stato_da_prima', '') = 'corrente' AND v_oggi <= v_da.fine THEN
    UPDATE public.anni_sede SET stato = 'corrente' WHERE id = v_da.id AND stato <> 'corrente';
    IF FOUND THEN
      INSERT INTO public.anni_sede_stati (anno_sede_id, stato, da) VALUES (v_da.id, 'corrente', p_da);
      v_riaperto := true;
    END IF;
  END IF;
  IF v_p.conteggi ? 'domande_da_prima' THEN
    UPDATE public.anni_sede SET domande_aperte = (v_p.conteggi ->> 'domande_da_prima')::boolean WHERE id = v_da.id;
  END IF;

  -- (giro 2, P23) Chi è stato archiviato DOPO la conferma (e non dal passaggio: non è un `esce`) resta archiviato. Si ricorda com'è, perché
  -- lo specchio di sotto lo riscrive dalle frequenze; e si chiude la sua frequenza nuova, che l'archiviazione non ha toccato.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', al.id, 'stato', al.stato, 'arch', al.archiviato_il)), '[]'::jsonb) INTO v_post
    FROM public.alunni al
    JOIN public.passaggi_anno_righe x ON x.passaggio_id = v_p.id AND x.alunno_id = al.id
   WHERE x.esito IN ('continua', 'cambia_grado', 'nuova') AND al.archiviato_il IS NOT NULL AND al.archiviato_il >= v_p.confermato_il
     AND al.anonimizzato_il IS NULL;
  UPDATE public.frequenze f SET stato = 'ritirato', data_uscita = f.data_ingresso
    FROM public.passaggi_anno_righe x
    JOIN public.alunni al ON al.id = x.alunno_id
   WHERE x.passaggio_id = v_p.id AND x.esito IN ('continua', 'cambia_grado', 'nuova') AND f.id = x.frequenza_a_id
     AND f.stato IN ('in_attesa', 'iscritto') AND al.archiviato_il IS NOT NULL AND al.archiviato_il >= v_p.confermato_il;
  -- (giro 3, B6/P23) E si chiude anche la frequenza dell'anno VECCHIO che l'annullo rende di nuovo visibile: se restasse viva, la famiglia
  -- rivedrebbe il bambino (`frequenze_attive`) e l'invariante 11 si accenderebbe ogni notte. L'uscita è il giorno dell'archiviazione, dentro l'anno.
  UPDATE public.frequenze f SET stato = 'ritirato',
         data_uscita = least(greatest(public.giorno_roma(al.archiviato_il), f.data_ingresso), v_da.fine)
    FROM public.passaggi_anno_righe x
    JOIN public.alunni al ON al.id = x.alunno_id
   WHERE x.passaggio_id = v_p.id AND x.esito IN ('continua', 'cambia_grado') AND f.id = x.frequenza_da_id
     AND f.stato IN ('in_attesa', 'iscritto') AND al.archiviato_il IS NOT NULL AND al.archiviato_il >= v_p.confermato_il
     AND al.anonimizzato_il IS NULL;

  -- Le frequenze, con il vecchio di nuovo anno attivo (lo specchio le segue).
  UPDATE public.frequenze f SET stato = r2.stato_da_prima, data_uscita = NULL
    FROM public.passaggi_anno_righe r2
   WHERE r2.passaggio_id = v_p.id AND r2.esito IN ('esce', 'non_risposto') AND r2.stato_da_prima IS NOT NULL
     AND f.id = r2.frequenza_da_id AND f.stato = 'uscito';
  GET DIAGNOSTICS v_tornati = ROW_COUNT;
  UPDATE public.frequenze f SET stato = 'in_attesa', data_uscita = NULL
    FROM public.passaggi_anno_righe r2
   WHERE r2.passaggio_id = v_p.id AND r2.esito = 'esce' AND r2.eccezione AND r2.frequenza_a_id IS NOT NULL
     AND f.id = r2.frequenza_a_id AND f.stato = 'ritirato';
  GET DIAGNOSTICS v_ritirati = ROW_COUNT;

  -- Le assegnazioni dei docenti: solo quelle che la conferma ha scritto.
  DELETE FROM public.utenti_sezioni us
   USING public.passaggi_anno_docenti d
   WHERE d.passaggio_id = v_p.id AND d.inserita AND us.utente_id = d.utente_id AND us.section_id = d.sezione_a_id;
  GET DIAGNOSTICS v_tolti = ROW_COUNT;
  -- (giro 1, S12) Con l'assegnazione alla classe se ne vanno anche le sue materie, copiate dalla conferma: altrimenti un «togli» seguito
  -- da una riconferma lascerebbe le discipline a chi non ha più la classe.
  DELETE FROM public.utenti_sezioni_materie um
   USING public.passaggi_anno_docenti d
   WHERE d.passaggio_id = v_p.id AND d.inserita AND um.utente_id = d.utente_id AND um.section_id = d.sezione_a_id;
  UPDATE public.passaggi_anno_docenti SET inserita = false WHERE passaggio_id = v_p.id AND inserita;

  -- I bambini “nuovi” non hanno una frequenza viva nell'anno vecchio, e lo specchio non ha niente da copiare: tornano “in arrivo”, senza
  -- classe e non archiviati (com'erano prima dell'arrivo). Prima dello specchio, che li lascia così. Il resto della scheda (retta,
  -- intestatario) resta com'è: lo riscrive il prossimo specchio.
  UPDATE public.alunni a SET stato = 'in_arrivo', section_id = NULL, classe_sezione = NULL, archiviato_il = NULL, archiviato_da = NULL, archiviato_motivo = NULL, archiviato_section_id = NULL, archiviato_classe_sezione = NULL
   WHERE a.id IN (SELECT x.alunno_id FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id AND x.esito = 'nuova')
     AND a.anonimizzato_il IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.frequenze f
                      WHERE f.alunno_id = a.id AND f.anno_sede_id = public.anno_attivo(v_p.scuola_id) AND f.stato IN ('in_attesa', 'iscritto'));
  FOR v_giro IN SELECT x.alunno_id FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id LOOP
    PERFORM public.alunni_riallinea_da_frequenze(v_giro.alunno_id);
  END LOOP;

  -- (giro 1, B6) La scheda com'era PRIMA della conferma, dove lo specchio l'ha riscritta: chi era «ritirato» o «sospeso» dalla tendina
  -- lo torna, con la sua archiviazione di prima. Solo se oggi la scheda è `iscritto` e non archiviata, cioè ancora quella che ha scritto il
  -- passaggio (giro 2, P23: se un collega l'ha cambiata dopo, non si tocca), e non è anonimizzata.
  UPDATE public.alunni al SET stato = r.scheda_da_prima, archiviato_il = r.scheda_archiviata_da_prima
    FROM public.passaggi_anno_righe r
   WHERE r.passaggio_id = v_p.id AND r.scheda_da_prima IN ('ritirato', 'sospeso')
     AND al.id = r.alunno_id AND al.stato = 'iscritto' AND al.archiviato_il IS NULL AND al.anonimizzato_il IS NULL;

  -- (giro 2, P23) Chi era stato archiviato dopo la conferma torna archiviato (lo specchio e i «nuovi → in arrivo» l'avevano riaperto).
  UPDATE public.alunni al SET stato = coalesce(nullif(x.p ->> 'stato', 'in_arrivo'), 'ritirato'), archiviato_il = (x.p ->> 'arch')::timestamptz
    FROM jsonb_array_elements(v_post) AS x(p)
   WHERE al.id = (x.p ->> 'id')::uuid AND al.anonimizzato_il IS NULL;

  UPDATE public.passaggi_anno SET stato = 'annullato', annullato_da = p_da, annullato_il = now(), schede_copiate_il = NULL WHERE id = v_p.id;

  PERFORM public.passaggio_log(v_p.scuola_id, 'annullato', v_p.id,
    jsonb_build_object('n_ripristinati', v_tornati + v_ritirati, 'n_docenti_tolti', v_tolti));

  RETURN jsonb_build_object('passaggio_id', v_p.id, 'conteggi', jsonb_build_object(
    'ripristinati', v_tornati + v_ritirati, 'docenti_tolti', v_tolti, 'vecchio_riaperto', CASE WHEN v_riaperto THEN 1 ELSE 0 END,
    'tardive_restano', v_tardive));
END
$$;

-- ── passaggio_conferma_tardiva ───────────────────────────────────────────────────────────────────
-- Una famiglia che conferma DOPO il passaggio: il bambino era `esce` o `non_risposto` e la sua frequenza vecchia si è chiusa. Solo se il
-- passaggio è `confermato` e il nuovo anno è `corrente` (PASSAGGIO_NON_PRONTO) e la riga è `esce`/`non_risposto` (RIGA_NON_VALIDA).
-- Crea la frequenza nuova (`tipo = 'conferma'`, `origine = 'passaggio'`, `continua_da` = la vecchia, ingresso = il più tardi fra l'inizio
-- dell'anno e oggi) con i campi di famiglia della vecchia come `anno_conferma`, oppure RIAPRE quella ritirata; la classe è `p_section`
-- o la continuazione della vecchia. Poi lo specchio (la scheda archiviata torna viva: senza questo la voce della quota non nasce) e la
-- voce della quota. Aggiorna la riga (`frequenza_a_id`, `eccezione = true`; l'esito resta quello della conferma, che è storia).
-- Rifatta: `creata: false`. Risposta: {frequenza_id, creata, quota, pagamento_id}.
CREATE OR REPLACE FUNCTION public.passaggio_conferma_tardiva(
  p_passaggio uuid, p_alunno uuid, p_section uuid, p_da uuid, p_oggi date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p      public.passaggi_anno%ROWTYPE;
  v_a      public.anni_sede%ROWTYPE;
  v_r      public.passaggi_anno_righe%ROWTYPE;
  v_fd     public.frequenze%ROWTYPE;
  v_f      public.frequenze%ROWTYPE;
  v_s      public.sections%ROWTYPE;
  v_oggi   date;
  v_sez    uuid := p_section;
  v_creata boolean := false;
  v_ingresso date;
  v_quota  jsonb;
BEGIN
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_TROVATO' USING DETAIL = json_build_object('campo', 'passaggio')::text;
  END IF;
  v_oggi := public.passaggio_oggi(v_p.scuola_id, p_oggi);

  PERFORM 1 FROM public.anni_sede WHERE id IN (v_p.da_anno_sede_id, v_p.a_anno_sede_id) ORDER BY id FOR SHARE;
  SELECT * INTO v_p FROM public.passaggi_anno WHERE id = p_passaggio FOR UPDATE;
  SELECT * INTO v_a FROM public.anni_sede WHERE id = v_p.a_anno_sede_id;
  IF v_p.stato <> 'confermato' OR v_a.stato <> 'corrente' THEN
    RAISE EXCEPTION 'PASSAGGIO_NON_PRONTO' USING HINT = 'passaggio-non-in-corso';
  END IF;

  SELECT * INTO v_r FROM public.passaggi_anno_righe WHERE passaggio_id = v_p.id AND alunno_id = p_alunno FOR UPDATE;
  IF NOT FOUND OR v_r.esito NOT IN ('esce', 'non_risposto') THEN
    RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'riga-non-tardiva';
  END IF;
  IF EXISTS (SELECT 1 FROM public.alunni a WHERE a.id = p_alunno AND a.anonimizzato_il IS NOT NULL) THEN
    RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'alunno-anonimizzato';
  END IF;

  SELECT * INTO v_fd FROM public.frequenze WHERE id = v_r.frequenza_da_id;

  IF v_sez IS NOT NULL THEN
    SELECT * INTO v_s FROM public.sections WHERE id = v_sez;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'sezione-sconosciuta';
    END IF;
    IF v_s.scuola_id IS DISTINCT FROM v_p.scuola_id THEN
      RAISE EXCEPTION 'SEDE_DIVERSA' USING HINT = 'sezione';
    END IF;
    IF v_s.anno_id IS DISTINCT FROM v_a.anno_id THEN
      RAISE EXCEPTION 'SEZIONE_DI_ALTRO_ANNO' USING HINT = 'sezione';
    END IF;
  ELSIF v_fd.section_id IS NOT NULL THEN
    SELECT s.id INTO v_sez FROM public.sections s
     WHERE s.continua_da = v_fd.section_id AND s.anno_id = v_a.anno_id AND s.scuola_id = v_a.scuola_id
     ORDER BY s.id LIMIT 1;
  END IF;

  v_ingresso := least(greatest(v_a.inizio, v_oggi), v_a.fine);

  SELECT * INTO v_f FROM public.frequenze WHERE alunno_id = p_alunno AND anno_sede_id = v_a.id FOR UPDATE;
  IF FOUND THEN
    IF v_f.stato = 'ritirato' THEN
      -- (giro 1, S3) Senza una classe in cui metterlo il bambino tornerebbe iscritto e senza classe: si rifiuta.
      IF v_sez IS NULL AND v_f.section_id IS NULL THEN
        RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'tardiva-senza-classe';
      END IF;
      -- (giro 1, S2) L'ingresso è il giorno in cui la famiglia torna (non quello, vecchio, della frequenza che si riapre).
      UPDATE public.frequenze SET stato = 'in_attesa', data_uscita = NULL, tipo = 'conferma', data_ingresso = v_ingresso,
             continua_da = coalesce(continua_da, v_fd.id), section_id = coalesce(v_sez, section_id)
       WHERE id = v_f.id;
      v_creata := true;
    ELSIF v_f.stato NOT IN ('in_attesa', 'iscritto') THEN
      RAISE EXCEPTION 'FREQUENZA_NON_VIVA' USING DETAIL = json_build_object('stato', 1)::text;
    END IF;
  ELSE
    IF v_sez IS NULL THEN
      RAISE EXCEPTION 'RIGA_NON_VALIDA' USING HINT = 'tardiva-senza-classe';
    END IF;
    INSERT INTO public.frequenze
      (alunno_id, anno_sede_id, anno_id, scuola_id, section_id, continua_da, tipo, stato, origine, data_ingresso,
       retta_esente, retta_a_carico_di, retta_split_config, intestatario_fatture, giorno_scadenza_pagamenti, gruppo_mensa_id, usa_pannolino)
    VALUES
      (p_alunno, v_a.id, v_a.anno_id, v_a.scuola_id, v_sez, v_fd.id, 'conferma', 'in_attesa', 'passaggio', v_ingresso,
       coalesce(v_fd.retta_esente, false), v_fd.retta_a_carico_di, v_fd.retta_split_config, v_fd.intestatario_fatture,
       v_fd.giorno_scadenza_pagamenti, v_fd.gruppo_mensa_id, coalesce(v_fd.usa_pannolino, false))
    RETURNING * INTO v_f;
    v_creata := true;
  END IF;

  UPDATE public.passaggi_anno_righe SET frequenza_a_id = v_f.id, eccezione = true, modificata_da = p_da WHERE id = v_r.id;

  -- Prima lo specchio (la scheda archiviata torna viva), poi la voce: a una scheda archiviata la quota non nasce.
  -- (giro 2, N3) Se il nuovo anno non è ancora cominciato, la scheda resta com'è (lo specchio guarda l'anno visibile, ancora il vecchio): il
  -- bambino entra il giorno dell'`inizio`, come dice la specifica, e la voce nasce allora (`passaggio_ricopia_schede` la crea).
  PERFORM public.alunni_riallinea_da_frequenze(p_alunno);
  IF v_a.inizio > v_oggi THEN
    v_quota := jsonb_build_object('esito', 'rimandata_all_inizio', 'pagamento_id', NULL);
  ELSE
    v_quota := public.anno_quota_voce(v_f.id, p_da, v_oggi);
  END IF;

  PERFORM public.passaggio_log(v_p.scuola_id, 'conferma-tardiva', v_p.id, jsonb_build_object('n_creata', CASE WHEN v_creata THEN 1 ELSE 0 END));

  RETURN jsonb_build_object('frequenza_id', v_f.id, 'creata', v_creata,
                            'quota', v_quota -> 'esito', 'pagamento_id', v_quota -> 'pagamento_id');
END
$$;

-- ── passaggio_ricopia_schede ─────────────────────────────────────────────────────────────────────
-- (giro 2, R6) Il giorno dell'`inizio` dell'anno nuovo ricopia sulle schede della sede la classe nuova (e il resto: retta, intestatario,
-- sospensione…): è ciò che, fra la conferma e l'inizio, lo specchio non fa perché guarda l'anno visibile. Per ogni passaggio CONFERMATO
-- il cui nuovo anno è `corrente` e già cominciato, e le cui schede non sono state ricopiate (`schede_copiate_il` NULL):
--   1. chi è stato archiviato dopo la conferma (non un `esce`) non torna in classe: la sua frequenza nuova si chiude;
--   2. per ogni riga del passaggio `alunni_riallinea_da_frequenze` (il trigger dello storico lascia la riga di classe con la data di oggi);
--   3. le conferme tardive fatte nella finestra ricevono la voce di quota che non era nata;
--   4. `schede_copiate_il` = adesso, e una riga di log con i soli numeri.
-- IDEMPOTENTE: rifatta non trova niente da fare. Un guasto su un passaggio lo lascia com'era (riprova all'ora dopo) e non ferma gli altri.
-- `p_oggi` non NULL solo per le sedi di prova (la porta di `passaggio_oggi`). Risposta: {passaggi, schede, cambiate, archiviati, quote}.
CREATE OR REPLACE FUNCTION public.passaggio_ricopia_schede(p_oggi date DEFAULT NULL, p_scuola uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p         record;
  v_r         record;
  v_oggi      date;
  v_inizio    date;
  v_prima     jsonb;
  v_dopo      jsonb;
  v_passaggi  integer := 0;
  v_schede    integer := 0;
  v_cambiate  integer := 0;
  v_archiviati integer := 0;
  v_quote     integer := 0;
  v_n         integer;
  v_n2        integer := 0;
  v_c         integer;
  v_s         integer;
  v_a         integer;
  v_q         integer;
BEGIN
  FOR v_p IN
    SELECT p.id, p.scuola_id, p.a_anno_sede_id, p.confermato_il, p.confermato_da
      FROM public.passaggi_anno p
      JOIN public.anni_sede a ON a.id = p.a_anno_sede_id
     WHERE p.stato = 'confermato' AND p.schede_copiate_il IS NULL AND a.stato = 'corrente'
       AND (p_scuola IS NULL OR p.scuola_id = p_scuola)
     ORDER BY p.id
  LOOP
    v_oggi := public.passaggio_oggi(v_p.scuola_id, p_oggi);
    SELECT a.inizio INTO v_inizio FROM public.anni_sede a WHERE a.id = v_p.a_anno_sede_id;
    IF v_oggi < v_inizio THEN
      CONTINUE;
    END IF;
    PERFORM 1 FROM public.passaggi_anno WHERE id = v_p.id AND schede_copiate_il IS NULL FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    BEGIN
      v_c := 0; v_s := 0; v_a := 0; v_q := 0; v_n2 := 0;

      -- (giro 3, NB2) Chi è stato archiviato dopo la conferma, per QUALUNQUE esito (anche `nuova`), non rientra in classe. L'archiviazione della
      -- segreteria ha già chiuso la sua frequenza nuova (`chiudiFrequenzeAperte`): qui si CONTANO (`n_archiviati_dopo`) e, se per qualche
      -- altra via una frequenza viva fosse rimasta, la si chiude. `esce` e `non_risposto` non hanno una frequenza nuova viva da chiudere.
      SELECT count(*) INTO v_a
        FROM public.passaggi_anno_righe x
        JOIN public.alunni al ON al.id = x.alunno_id
       WHERE x.passaggio_id = v_p.id AND x.esito IN ('continua', 'cambia_grado', 'nuova') AND al.archiviato_il IS NOT NULL AND al.archiviato_il >= v_p.confermato_il;
      -- (Riattiva, giro 2) La frequenza chiusa TIENE la sua classe, come quella che chiude `chiudiFrequenzeAperte`: la riapre «Riattiva» con quella.
      UPDATE public.frequenze f SET stato = 'ritirato', data_uscita = f.data_ingresso
        FROM public.passaggi_anno_righe x
        JOIN public.alunni al ON al.id = x.alunno_id
       WHERE x.passaggio_id = v_p.id AND x.esito IN ('continua', 'cambia_grado', 'nuova') AND f.id = x.frequenza_a_id
         AND f.stato IN ('in_attesa', 'iscritto') AND al.archiviato_il IS NOT NULL AND al.archiviato_il >= v_p.confermato_il;

      -- (giro 3, NS3) Lo storico delle classi parte dall'`inizio` (o dalla conferma, se più tarda) anche se il job gira in ritardo.
      PERFORM set_config('kidville.storico_giorno', greatest(v_inizio, (v_p.confermato_il AT TIME ZONE 'Europe/Rome')::date)::text, true);

      FOR v_r IN SELECT x.alunno_id FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id ORDER BY x.alunno_id LOOP
        SELECT jsonb_build_array(al.section_id, al.stato, al.archiviato_il) INTO v_prima FROM public.alunni al WHERE al.id = v_r.alunno_id;
        PERFORM public.alunni_riallinea_da_frequenze(v_r.alunno_id);
        SELECT jsonb_build_array(al.section_id, al.stato, al.archiviato_il) INTO v_dopo FROM public.alunni al WHERE al.id = v_r.alunno_id;
        v_s := v_s + 1;
        IF v_prima IS DISTINCT FROM v_dopo THEN
          v_c := v_c + 1;
        END IF;
      END LOOP;

      -- (giro 3, NB3) I bambini iscritti NELLA FINESTRA (dalla segreteria, dopo la conferma) non hanno una riga del passaggio: sono «in arrivo»
      -- con una frequenza viva nell'anno nuovo, che ora è visibile. Entrano anche loro.
      -- (chiusura, N1) Non solo gli «in arrivo»: anche un bambino GIÀ in anagrafica (`iscritto` nel centro estivo, in una classe del solo anno vecchio)
      -- a cui è stata importata una domanda per l'anno nuovo ha la frequenza nuova ma la scheda ancora nella classe vecchia, e diario e appello
      -- leggono la scheda. Basta una frequenza viva nell'anno nuovo e nessuna riga del passaggio; gli archiviati restano fuori. Chi NON ha una domanda
      -- (nessuna frequenza nuova) non si tocca: lo decide la segreteria dal 01/09.
      FOR v_r IN
        SELECT DISTINCT f.alunno_id FROM public.frequenze f
          JOIN public.alunni al ON al.id = f.alunno_id
         WHERE f.anno_sede_id = v_p.a_anno_sede_id AND f.stato IN ('in_attesa', 'iscritto') AND f.data_ingresso <= v_oggi
           AND al.archiviato_il IS NULL AND al.anonimizzato_il IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.passaggi_anno_righe x WHERE x.passaggio_id = v_p.id AND x.alunno_id = f.alunno_id)
         ORDER BY f.alunno_id
      LOOP
        SELECT jsonb_build_array(al.section_id, al.stato, al.archiviato_il) INTO v_prima FROM public.alunni al WHERE al.id = v_r.alunno_id;
        PERFORM public.alunni_riallinea_da_frequenze(v_r.alunno_id);
        SELECT jsonb_build_array(al.section_id, al.stato, al.archiviato_il) INTO v_dopo FROM public.alunni al WHERE al.id = v_r.alunno_id;
        v_s := v_s + 1; v_n2 := v_n2 + 1;
        IF v_prima IS DISTINCT FROM v_dopo THEN
          v_c := v_c + 1;
        END IF;
      END LOOP;
      PERFORM set_config('kidville.storico_giorno', '', true);

      FOR v_r IN
        SELECT f.id FROM public.passaggi_anno_righe x
          JOIN public.frequenze f ON f.id = x.frequenza_a_id
         WHERE x.passaggio_id = v_p.id AND x.eccezione AND x.esito IN ('esce', 'non_risposto')
           AND f.origine = 'passaggio' AND f.stato IN ('in_attesa', 'iscritto') AND f.quota_pagamento_id IS NULL
      LOOP
        PERFORM public.anno_quota_voce(v_r.id, v_p.confermato_da, v_oggi);
        v_q := v_q + 1;
      END LOOP;

      UPDATE public.passaggi_anno SET schede_copiate_il = now() WHERE id = v_p.id;
      PERFORM public.passaggio_log(v_p.scuola_id, 'schede-ricopiate', v_p.id,
        jsonb_build_object('n_schede', v_s, 'n_cambiate', v_c, 'n_archiviati_dopo', v_a, 'n_quote_tardive', v_q, 'n_nuovi_della_finestra', v_n2));
      v_passaggi := v_passaggi + 1; v_schede := v_schede + v_s; v_cambiate := v_cambiate + v_c;
      v_archiviati := v_archiviati + v_a; v_quote := v_quote + v_q;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        INSERT INTO public.app_log (livello, evento, sorgente, messaggio, scuola_id, fingerprint, contesto)
        VALUES ('error', 'anno-scolastico', 'server', 'passaggio d''anno: ricopia delle schede non riuscita', v_p.scuola_id,
                'passaggio-ricopia-fallita:' || v_p.id::text,
                jsonb_build_object('campi', jsonb_build_object('operazione', 'passaggio-ricopia-schede', 'esito', 'errore',
                                   'entita_id', v_p.id, 'sqlstate', SQLSTATE)))
        ON CONFLICT (fingerprint, giorno) DO UPDATE
          SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'passaggio_ricopia_schede: errore non registrato [%]', SQLSTATE;
      END;
    END;
  END LOOP;

  -- (giro 3, NS2) Il battito del job si scrive SEMPRE, anche a vuoto: «nessun log» non distingue «niente da fare» da «non è partito». Stessa `operazione`
  -- del log di fallimento. Solo numeri. `simulato` dice che il giorno non era quello vero. Un guasto di scrittura del battito non rompe il giro.
  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('info', 'cron', 'server', 'passaggio_ricopia_schede: giro completato', 'cron:passaggio-ricopia-schede',
            jsonb_build_object('campi', jsonb_build_object(
              'operazione', 'passaggio-ricopia-schede', 'esito', 'ok',
              'passaggi', v_passaggi, 'schede', v_schede, 'cambiate', v_cambiate, 'archiviati', v_archiviati, 'quote', v_quote,
              'simulato', p_oggi IS NOT NULL)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'passaggio_ricopia_schede: battito non scritto [%]', SQLSTATE;
  END;

  RETURN jsonb_build_object('passaggi', v_passaggi, 'schede', v_schede, 'cambiate', v_cambiate, 'archiviati', v_archiviati, 'quote', v_quote);
END
$$;

REVOKE ALL ON FUNCTION public.passaggio_ricopia_schede(date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passaggio_ricopia_schede(date, uuid) TO service_role;

-- Il job: ogni ora, venticinque minuti dopo `anni-tick` (che non tocca). `pg_cron` c'è se c'è la funzione; sul DB della CI no.
DO $$
BEGIN
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'passaggio-ricopia-schede: pg_cron assente, job non programmato';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'passaggio-ricopia-schede';
  PERFORM cron.schedule('passaggio-ricopia-schede', '35 * * * *', $cron$ SELECT public.passaggio_ricopia_schede(); $cron$);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'passaggio-ricopia-schede: job non programmato [%]', SQLSTATE;
  BEGIN
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES ('error', 'migrazione', 'server', 'passaggio-ricopia-schede: job non programmato', 'migrazione:passaggio-ricopia-schede-non-programmato',
            jsonb_build_object('campi', jsonb_build_object('operazione', 'passaggio-ricopia-schede', 'esito', 'non-programmato', 'sqlstate', SQLSTATE)))
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1, visto_l_ultima = now(), contesto = excluded.contesto;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'passaggio-ricopia-schede: job non programmato e non registrato [%]', SQLSTATE;
  END;
END $$;

REVOKE ALL ON FUNCTION public.passaggio_oggi(uuid, date)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_log(uuid, text, uuid, jsonb)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_conferma(uuid, uuid, date)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_annulla(uuid, uuid, date)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.passaggio_conferma_tardiva(uuid, uuid, uuid, uuid, date)      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passaggio_oggi(uuid, date)                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_log(uuid, text, uuid, jsonb)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_conferma(uuid, uuid, date)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_annulla(uuid, uuid, date)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.passaggio_conferma_tardiva(uuid, uuid, uuid, uuid, date)   TO service_role;
-- (giro 2, R6) Le quattro funzioni ridefinite sopra mantengono i permessi di prima; si ripetono per nome, perché il lock
-- `security-definer-revoke-lock` guarda il file e non la storia.
REVOKE ALL ON FUNCTION public.alunni_riallinea_da_frequenze(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.frequenze_specchio_alunni()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.alunni_specchio_frequenza()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anno_invarianti()                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_alunno_section_id()            FROM PUBLIC, anon, authenticated;  -- (giro 3) funzione di trigger: nessuno la chiama a mano
GRANT EXECUTE ON FUNCTION public.alunni_riallinea_da_frequenze(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.anno_invarianti()                   TO service_role;
REVOKE ALL ON FUNCTION public.anno_registra_frequenza(uuid, uuid, text, text, uuid, uuid, date, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anno_registra_frequenza(uuid, uuid, text, text, uuid, uuid, date, jsonb, uuid) TO service_role;
