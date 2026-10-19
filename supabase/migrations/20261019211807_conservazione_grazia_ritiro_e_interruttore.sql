-- =============================================================================
-- MOTIVI DELLE ASSENZE: SETTE GIORNI DI GRAZIA DOPO IL RITIRO, E UN INTERRUTTORE
-- Roadmap di robustezza, fase 4, problema D6 («pulizie che possono cancellare troppo»)
--
-- ─── IL DIFETTO ─────────────────────────────────────────────────────────────
-- `presenze_giustificazioni_retention_tick` (ogni notte alle 04:59 UTC) azzera
-- `giustificazione_testo` e `note_appello` di un bambino appena il suo stato
-- diventa «ritirato». Non legge nessuna data: un «ritirato» scelto per sbaglio
-- dalla tendina della scheda alle 18:00 costa, alle 04:59, tutti i motivi delle
-- assenze di quel bambino, e rimettere «iscritto» la mattina dopo non li riporta
-- indietro (non sono nella scatola nera: è un UPDATE, non un DELETE).
--
-- La seconda copia dello stesso difetto sta in `storici_tick` (ogni MINUTO), che
-- azzera le stesse due chiavi nelle revisioni delle stampe storiche con la
-- negazione `coalesce(a.stato,'iscritto')<>'iscritto'`: la forma che
-- `20260812224407` aveva abolito, perché prende anche i SOSPESI (che frequentano).
--
-- ─── LA CORREZIONE ──────────────────────────────────────────────────────────
-- 1. `alunni.stato_cambiato_il`: QUANDO lo stato è cambiato l'ultima volta, scritto
--    da un trigger (nessuna route deve ricordarsene). Le 16 righe «ritirato» di
--    oggi hanno tutte `archiviato_il`, che è la stessa data: si riporta quella.
-- 2. `public.alunno_uscita_consolidata(stato, dal)`: la regola in un posto solo.
--    Vero solo se lo stato è nell'allowlist `stati_alunno_non_piu_iscritto()` E
--    il cambio ha almeno 7 giorni. Una data assente vale «da prima di questa
--    migrazione», cioè consolidata: è il comportamento di sempre per chi era già
--    ritirato, e quei motivi sono già stati azzerati.
-- 3. L'automa notturno la usa, e ha un INTERRUTTORE: se le righe da azzerare
--    sono più di 200 non ne tocca nessuna, scrive una riga `error` in `app_log`
--    (la salute e il campanello la vedono) e salta il battito della notte. Per
--    sbloccarlo, dopo aver guardato: nella stessa sessione
--      SET app.conservazione_forza = 'on';
--      SELECT public.presenze_giustificazioni_retention_tick();
-- 4. `storici_tick` usa la stessa regola al posto della negazione.
--
-- ─── LA MISURA, PRIMA DI SCRIVERE (produzione, 19/10, sola lettura) ─────────
--   presenze con testo: 455 · vecchie di 12 mesi: 0 · orfane: 0 · di ritirati: 0
--   alunni: 790 iscritti, 16 ritirati (16 con archiviato_il) · storici_revisioni
--   dei moduli presenze: 0. Oggi la migrazione non cambia l'esito di nessuna riga.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
-- Riapplicare le definizioni di `20260812224407` (automa) e `20261015183000`
-- (storici_tick). La colonna e il trigger possono restare: nessuno li legge più.
-- Il DB E2E della CI non è migrato: nessun codice applicativo legge la colonna.
-- =============================================================================

-- ─── 1. QUANDO è cambiato lo stato ──────────────────────────────────────────
ALTER TABLE public.alunni ADD COLUMN IF NOT EXISTS stato_cambiato_il timestamptz;

COMMENT ON COLUMN public.alunni.stato_cambiato_il IS
  'Istante dell''ultimo cambio di alunni.stato, scritto dal trigger alunni_traccia_cambio_stato. Serve alla grazia di 7 giorni prima che un ritiro faccia scadere i dati legati all''iscrizione (public.alunno_uscita_consolidata). NULL = stato mai cambiato dopo il 2026-10-19.';

-- Le righe già ritirate: la data del ritiro è quella dell'archiviazione. Prima del
-- trigger, così l'UPDATE non lo fa scattare (e non tocca altre colonne: nessun
-- altro trigger di `alunni` guarda questa).
UPDATE public.alunni
   SET stato_cambiato_il = archiviato_il
 WHERE stato_cambiato_il IS NULL
   AND archiviato_il IS NOT NULL
   AND COALESCE(stato, 'iscritto') = ANY (public.stati_alunno_non_piu_iscritto());

CREATE OR REPLACE FUNCTION public.alunni_traccia_cambio_stato()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.stato IS DISTINCT FROM OLD.stato THEN
    NEW.stato_cambiato_il := now();
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.alunni_traccia_cambio_stato() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER alunni_traccia_cambio_stato
  BEFORE INSERT OR UPDATE OF stato ON public.alunni
  FOR EACH ROW EXECUTE FUNCTION public.alunni_traccia_cambio_stato();

-- ─── 2. LA REGOLA, in un posto solo ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.alunno_uscita_consolidata(p_stato text, p_dal timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(p_stato, 'iscritto') = ANY (public.stati_alunno_non_piu_iscritto())
     AND (p_dal IS NULL OR p_dal <= now() - make_interval(days => 7))
$$;

COMMENT ON FUNCTION public.alunno_uscita_consolidata(text, timestamptz) IS
  'Vero se un alunno e "non piu iscritto" (allowlist public.stati_alunno_non_piu_iscritto(), oggi solo "ritirato") da ALMENO 7 GIORNI (alunni.stato_cambiato_il; NULL = da prima del 2026-10-19). Unica regola per i lavori che fanno scadere dati alla fine dell''iscrizione: un ritiro scelto per sbaglio si corregge entro una settimana senza perdere niente.';

REVOKE ALL ON FUNCTION public.alunno_uscita_consolidata(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.alunno_uscita_consolidata(text, timestamptz) TO service_role;

-- ─── 3. L'AUTOMA NOTTURNO, con la grazia e l'interruttore ───────────────────
CREATE OR REPLACE FUNCTION public.presenze_giustificazioni_retention_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- IL TERMINE, in un posto solo. Dichiarato anche nell'informativa: il lock
  -- `informativa-conservazione-dichiarata.test.ts` confronta i due numeri.
  v_mesi   constant int := 12;
  -- L'INTERRUTTORE: oltre questo numero di righe in una notte non si tocca niente.
  -- Il giorno normale ne azzera poche (le assenze di un giorno di un anno fa, i
  -- motivi di un bambino ritirato); centinaia insieme sono un'anomalia da guardare.
  v_soglia constant int := 200;
  v_forza  boolean := COALESCE(current_setting('app.conservazione_forza', true), '') = 'on';
  v_ids    uuid[];
  v_righe  int := 0;
BEGIN
  SELECT COALESCE(array_agg(p.id), '{}')
    INTO v_ids
    FROM public.presenze AS p
   -- Solo le righe che hanno davvero qualcosa da togliere.
   WHERE (p.giustificazione_testo IS NOT NULL OR p.note_appello IS NOT NULL)
     AND (
           p.data < current_date - make_interval(months => v_mesi)
        -- La riga ORFANA: l'alunno non e piu in anagrafica, nessuna iscrizione la trattiene.
        OR NOT EXISTS (
             SELECT 1 FROM public.alunni a WHERE a.id = p.alunno_id
           )
        -- L'ALLOWLIST degli stati, e da almeno sette giorni (alunno_uscita_consolidata
        -- chiama public.stati_alunno_non_piu_iscritto()): un ritiro di ieri non cancella.
        OR EXISTS (
             SELECT 1
               FROM public.alunni a
              WHERE a.id = p.alunno_id
                AND public.alunno_uscita_consolidata(a.stato, a.stato_cambiato_il)
           )
         );

  IF cardinality(v_ids) > v_soglia AND NOT v_forza THEN
    -- Niente battito stanotte: il campanello vede il job muto E la riga d'errore.
    INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    VALUES (
      'error', 'cron', 'server',
      format('retention motivo assenza FERMATA dall''interruttore: %s righe oltre la soglia di %s, nessuna toccata', cardinality(v_ids), v_soglia),
      'cron:presenze-giustificazioni-retention:interruttore',
      jsonb_build_object(
        'campi', jsonb_build_object(
          'operazione',  'presenze-giustificazioni-retention',
          'esito',       'interruttore',
          'n_candidate', cardinality(v_ids),
          'soglia',      v_soglia
        )
      )
    )
    ON CONFLICT (fingerprint, giorno) DO UPDATE
      SET occorrenze = public.app_log.occorrenze + 1,
          visto_l_ultima = now(),
          contesto = excluded.contesto;
    RETURN 0;
  END IF;

  UPDATE public.presenze AS p
     SET giustificazione_testo = NULL,
         note_appello          = NULL
   WHERE p.id = ANY (v_ids);
  GET DIAGNOSTICS v_righe = ROW_COUNT;

  -- Un lavoro che cancella dati di famiglie deve dire ANCHE quando non cancella
  -- niente. Solo conteggi - nessun nome, nessun uuid, nessun testo.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'cron', 'server',
    format('retention motivo assenza e note appello (%s mesi o fine iscrizione da 7 giorni)', v_mesi),
    'cron:presenze-giustificazioni-retention',
    jsonb_build_object(
      'campi', jsonb_build_object(
        'operazione', 'presenze-giustificazioni-retention',
        'esito',      'ok',
        'azione',     'retention-presenze-giustificazioni',
        'n_righe',    v_righe,
        'mesi',       v_mesi,
        'forzata',    v_forza
      )
    )
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe;
END $$;

-- Il REVOKE va ripetuto a ogni CREATE OR REPLACE (lock security-definer-revoke-lock).
REVOKE ALL ON FUNCTION public.presenze_giustificazioni_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.presenze_giustificazioni_retention_tick() TO service_role;

COMMENT ON FUNCTION public.presenze_giustificazioni_retention_tick() IS
  'Azzera presenze.giustificazione_testo e presenze.note_appello dopo 12 MESI dal giorno dell''assenza, per gli alunni non piu in anagrafica, e per quelli "non piu iscritti" da almeno 7 giorni (public.alunno_uscita_consolidata). INTERRUTTORE: oltre 200 righe in un giro non tocca niente e scrive una riga error in app_log; si sblocca con SET app.conservazione_forza = ''on'' nella stessa sessione. La RIGA resta: stato, data e giustificata sono dati sulla frequenza. Scrive una riga di conteggi in app_log a ogni esecuzione, anche quando non tocca niente.';

-- ─── 4. LE STAMPE STORICHE, con la stessa regola ────────────────────────────
-- Identica a `20261015183000` tranne il predicato dell'iscrizione.
CREATE OR REPLACE FUNCTION public.storici_tick() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
declare base text:=public.cron_config('app.push_dispatch_url'); segreto text:=public.cron_config('app.cron_secret'); origine text;
begin
  -- Stessa regola della FONTE presenze (presenze_giustificazioni_retention_tick):
  -- scadono soltanto motivo e note, a 12 mesi dal fatto o alla fine dell'iscrizione
  -- consolidata da 7 giorni. Firma e frequenza restano conservate.
  update public.storici_revisioni r set contenuto=
    case when jsonb_typeof(r.contenuto->'riga')='object' then
      jsonb_set(r.contenuto,'{riga}',(r.contenuto->'riga')||jsonb_build_object('giustificazione_testo',null,'note_appello',null))
    else r.contenuto||jsonb_build_object('giustificazione_testo',null,'note_appello',null) end
    where r.modulo in ('presenze','giustifiche-presenza')
      and (r.giorno_competenza < (now() at time zone 'Europe/Rome')::date-interval '12 months'
        or exists(select 1 from public.alunni a where a.id=r.alunno_id and public.alunno_uscita_consolidata(a.stato, a.stato_cambiato_il)))
      and (r.contenuto->>'giustificazione_testo' is not null or r.contenuto->>'note_appello' is not null
        or r.contenuto#>>'{riga,giustificazione_testo}' is not null or r.contenuto#>>'{riga,note_appello}' is not null);
  if coalesce(base,'')='' then base:=public.cron_config('app.notifiche_promemoria_url'); end if;
  origine:=substring(base from '^https?://[^/]+');
  if coalesce(origine,'')='' or coalesce(segreto,'')='' then
    raise warning 'storici: configurazione cron mancante';
    begin
      insert into public.app_log(livello,evento,sorgente,messaggio,fingerprint,contesto)
      values('error','cron','server','Configurazione cron storici mancante','storici-cron-config-assente','{}'::jsonb);
    exception when others then raise log 'storici: logging cron non riuscito [%]',SQLSTATE; end;
    return;
  end if;
  perform net.http_post(url:=origine||'/api/admin/storici/cron',headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',segreto),body:='{}'::jsonb,timeout_milliseconds:=300000);
exception when others then raise warning 'storici: chiamata cron fallita [%]',SQLSTATE;
end $$;
revoke all on function public.storici_tick() from public,anon,authenticated;
grant execute on function public.storici_tick() to service_role;
