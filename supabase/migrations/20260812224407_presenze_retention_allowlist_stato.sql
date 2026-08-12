-- ═══════════════════════════════════════════════════════════════════════════════
-- LA NEGAZIONE CHE `@/lib/alunni/stato` HA ABOLITO SOPRAVVIVEVA NELL'AUTOMA.
--
-- ✅ APPLICATA in produzione il 2026-08-13 con `apply_migration`, dopo averne
--    misurato l'effetto in sola lettura (sotto) e mostrato il testo per intero.
--    Verificato SUBITO DOPO su `pg_get_functiondef`, e non dedotto dal «success»
--    dello strumento:
--      · `public.stati_alunno_non_piu_iscritto()` → `{ritirato}`;
--      · la definizione di `presenze_giustificazioni_retention_tick` CONTIENE
--        `stati_alunno_non_piu_iscritto` e NON contiene più
--        `COALESCE(a.stato, 'iscritto') = 'iscritto'`;
--      · `'sospeso' = any (…)` → false, `'ritirato' = any (…)` → true;
--      · `get_advisors` (security): nessun ERROR nuovo.
--
--    ⚠️ IL NOME DEL FILE PORTA LA `version` CHE HA ASSEGNATO IL DATABASE
--    (`20260812224407`), non una scelta di chi scrive: è la lezione di
--    `20260807211157`, e il lock `migrazioni-complete.test.ts` confronta i nomi
--    dei file con la fotografia di `supabase_migrations.schema_migrations`.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── IL FATTO ─────────────────────────────────────────────────────────────────
--
-- `presenze_giustificazioni_retention_tick` decideva chi non è più iscritto così:
--
--     OR NOT EXISTS (SELECT 1 FROM public.alunni a
--                     WHERE a.id = p.alunno_id
--                       AND COALESCE(a.stato,'iscritto') = 'iscritto')
--
-- cioè con una NEGAZIONE: «tutto tranne iscritto». È esattamente la forma che
-- `src/lib/alunni/stato.ts` esiste per abolire — quel modulo nasce dal difetto
-- gemello su `admin/gdpr/candidates`, dove `.neq('stato','iscritto')` metteva un
-- bambino soltanto SOSPESO (che frequenta) fra i candidati a un'anonimizzazione
-- irreversibile. La lezione era stata pagata in TypeScript e non era arrivata
-- all'SQL, dove la stessa regola vive una terza volta.
--
-- ─── LA MISURA, PRIMA DI SCRIVERE (produzione, 2026-08-13, sola lettura) ──────
--
--   select s.stato,
--          (not exists (select 1 from (values (s.stato)) t(v)
--                        where coalesce(t.v,'iscritto') = 'iscritto')) as azzera_oggi,
--          (coalesce(s.stato,'iscritto') = any (array['ritirato']))    as azzera_con_allowlist
--     from (values ('iscritto'),('sospeso'),('ritirato'),('trasferito'),(null)) s(stato);
--
--   stato      | azzera_oggi | azzera_con_allowlist
--   iscritto   | false       | false
--   sospeso    | TRUE        | false     ← un bambino che FREQUENTA
--   ritirato   | true        | true
--   trasferito | TRUE        | false     ← uno stato che nessuno ha classificato
--   (null)     | false       | false
--
-- Le due righe in maiuscolo sono il difetto: a un bambino sospeso — la cui pratica
-- è ferma per morosità o per un'altra ragione, ma che entra a scuola ogni mattina —
-- l'automa azzerava ogni notte alle 04:59 UTC `giustificazione_testo` e
-- `note_appello`, cioè TESTO LIBERO DI NATURA SANITARIA su un minore (il segnaposto
-- del modulo genitore chiede un sintomo: «Es. febbre, visita medica…»).
--
-- ⚠️ E LA MIGRAZIONE CHE L'AVEVA SCRITTO DICHIARAVA IL CONTRARIO. `20260807211157`
-- contiene, nero su bianco: «`COALESCE(stato,'iscritto')` di proposito: davanti a
-- uno stato che non si sa leggere si sceglie di NON cancellare — "non lo so" non
-- vale "demolisci"». La riga `trasferito` qui sopra misura che il codice faceva
-- l'opposto della sua stessa intenzione dichiarata. Non è una svista di stile: è
-- una negazione che si allarga da sola verso una cancellazione, e ogni stato che
-- qualcuno aggiungerà domani alla tendina ci entrerebbe senza chiedere il permesso
-- a nessuno.
--
-- ─── COSA CAMBIA, E COSA NO ──────────────────────────────────────────────────
--
-- Cambia SOLO il predicato di «non più iscritto», che diventa un ELENCO CHIUSO.
-- I dodici mesi, la riga di battito, la schedulazione, i permessi e la colonna
-- `giustificazione_firma` (che non si tocca) restano identici.
--
-- Restano azzerate anche le righe ORFANE — quelle il cui alunno non è più in
-- anagrafica: nessuna iscrizione le trattiene, e il testo è sanitario. Prima quel
-- caso era coperto per effetto collaterale della negazione; ora è un ramo suo,
-- scritto, perché con l'allowlist non lo sarebbe più stato.
--
-- Righe toccate da questo cambiamento, misurate in sola lettura prima di applicarlo:
-- il predicato di oggi e quello nuovo selezionano **0 righe entrambi** (33 alunni,
-- tutti `iscritto`, 1 riga con testo sanitario). Non c'è niente da riparare
-- all'indietro: si sta chiudendo la porta prima che qualcuno ci passi.
--
-- ─── PERCHÉ UNA FUNZIONE PER L'ELENCO, E NON L'ARRAY SCRITTO QUI ─────────────
--
-- «Una regola valida per due strade deve vivere in un posto solo»: la verità è in
-- `STATI_NON_PIU_ISCRITTO` (`src/lib/alunni/stato.ts`), e l'SQL non può importarla.
-- Il posto unico SQL è questa funzione, e le due copie sono tenute insieme dal lock
-- `__tests__/architecture/stati-alunno-anche-in-sql.test.ts`, che confronta l'array
-- di questa migrazione con la costante TypeScript e diventa rosso se divergono.
-- L'alternativa — ribattere `'ritirato'` dentro il `WHERE` — è la terza copia della
-- stessa regola, cioè il modo esatto in cui questo difetto è nato.
--
-- Il DB E2E della CI è un progetto separato e NON migrato: qui non c'è nessuna
-- dipendenza da pg_cron e nessuna chiamata alla funzione, quindi non tocca niente.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. L'ELENCO CHIUSO, in un posto solo ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.stati_alunno_non_piu_iscritto()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT ARRAY['ritirato']::text[] $$;

COMMENT ON FUNCTION public.stati_alunno_non_piu_iscritto() IS
  'ALLOWLIST degli stati di alunni.stato che valgono "non piu iscritto". Gemello SQL di STATI_NON_PIU_ISCRITTO in src/lib/alunni/stato.ts, tenuto allineato dal lock __tests__/architecture/stati-alunno-anche-in-sql.test.ts. NON e "tutto tranne iscritto": "sospeso" e un bambino che FREQUENTA e sta dalla parte protetta per decisione. Solo cio che e qui dentro puo autorizzare la cancellazione di un dato di un minore.';

REVOKE ALL ON FUNCTION public.stati_alunno_non_piu_iscritto() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stati_alunno_non_piu_iscritto() TO service_role;

-- ─── 2. L'AUTOMA, con l'allowlist al posto della negazione ──────────────────
CREATE OR REPLACE FUNCTION public.presenze_giustificazioni_retention_tick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- IL TERMINE, in un posto solo. Dichiarato anche nell'informativa: il lock
  -- `informativa-conservazione-dichiarata.test.ts` confronta i due numeri.
  v_mesi  constant int := 12;
  v_righe int := 0;
BEGIN
  UPDATE public.presenze AS p
     SET giustificazione_testo = NULL,
         note_appello          = NULL
   -- Solo le righe che hanno davvero qualcosa da togliere: senza questa
   -- condizione il lavoro riscriverebbe ogni notte l'intero registro per non
   -- cancellare niente, e il conteggio nel log direbbe un numero che non
   -- descrive nessun dato rimosso.
   WHERE (p.giustificazione_testo IS NOT NULL OR p.note_appello IS NOT NULL)
     AND (
           p.data < current_date - make_interval(months => v_mesi)
        -- La riga ORFANA: l'alunno non e piu in anagrafica. Nessuna iscrizione la
        -- trattiene e il testo e sanitario, quindi esce. Prima era coperto per
        -- effetto collaterale della negazione; ora e un ramo dichiarato.
        OR NOT EXISTS (
             SELECT 1 FROM public.alunni a WHERE a.id = p.alunno_id
           )
        -- ⟵ L'ALLOWLIST. Solo gli stati dichiarati "non piu iscritto" autorizzano.
        --    Uno stato nuovo, un refuso o una maiuscola NON autorizzano: davanti a
        --    uno stato che non si sa leggere si sceglie di non cancellare, e i
        --    dodici mesi arrivano comunque.
        OR EXISTS (
             SELECT 1
               FROM public.alunni a
              WHERE a.id = p.alunno_id
                AND COALESCE(a.stato, 'iscritto') = ANY (public.stati_alunno_non_piu_iscritto())
           )
         );
  GET DIAGNOSTICS v_righe = ROW_COUNT;

  -- Un lavoro che cancella dati di famiglie deve dire ANCHE quando non cancella
  -- niente: "nessuna riga" non puo voler dire insieme "tutto a posto" e "non e
  -- mai partito". Solo conteggi - nessun nome, nessun uuid, nessun testo.
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES (
    'info', 'cron', 'server',
    format('retention motivo assenza e note appello (%s mesi o fine iscrizione)', v_mesi),
    'cron:presenze-giustificazioni-retention',
    jsonb_build_object(
      'campi', jsonb_build_object(
        'operazione', 'presenze-giustificazioni-retention',
        'esito',      'ok',
        'azione',     'retention-presenze-giustificazioni',
        'n_righe',    v_righe,
        'mesi',       v_mesi
      )
    )
  )
  ON CONFLICT (fingerprint, giorno) DO UPDATE
    SET occorrenze = public.app_log.occorrenze + 1,
        visto_l_ultima = now(),
        contesto = excluded.contesto;

  RETURN v_righe;
END $$;

-- ⚠️ IL REVOKE VA RIPETUTO A OGNI `CREATE OR REPLACE`, e non è una formalità.
-- Su un progetto Supabase ricostruito da zero, `ALTER DEFAULT PRIVILEGES … GRANT
-- EXECUTE … TO anon, authenticated` è attivo: una funzione SECURITY DEFINER che
-- nasce senza questa riga è chiamabile in anonimo via `/rest/v1/rpc/<fn>` con la
-- sola chiave pubblica — cioè un estraneo potrebbe far partire la cancellazione.
-- In produzione l'ACL era già `postgres=X | service_role=X` (misurato prima di
-- scrivere), quindi qui non toglie niente a nessuno: serve al giorno in cui questi
-- file ricostruiscono il database. Lock: `security-definer-revoke-lock.test.ts`.
REVOKE ALL ON FUNCTION public.presenze_giustificazioni_retention_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.presenze_giustificazioni_retention_tick() TO service_role;

COMMENT ON FUNCTION public.presenze_giustificazioni_retention_tick() IS
  'Azzera presenze.giustificazione_testo e presenze.note_appello dopo 12 MESI dal giorno dell''assenza, e subito per gli alunni il cui stato e nell''ALLOWLIST public.stati_alunno_non_piu_iscritto() (oggi: solo "ritirato") oppure che non esistono piu in anagrafica. NON usa la negazione "stato <> iscritto": un bambino soltanto SOSPESO frequenta, e il suo motivo di assenza non si tocca. Sono testo libero di natura sanitaria di un minore (il segnaposto del modulo genitore chiede un sintomo: "Es. febbre, visita medica..."), e l''informativa promette che i dati relativi alla salute non si conservano oltre la durata dell''iscrizione. La RIGA resta: stato, data e giustificata sono dati sulla frequenza, soggetti agli obblighi di conservazione documentale. Scrive una riga di conteggi in app_log a ogni esecuzione, anche quando non tocca niente.';
