-- =============================================================================
-- A2 · AVVISI — due scadenze invece di una, i partecipanti, il tetto dei posti
--       contato in PERSONE, e la lista d'attesa
--       branch feat/avvisi-scadenze-adesioni
-- =============================================================================
--
-- ── LE MISURE, PRESE PRIMA DI SCRIVERE IL BACKFILL (produzione, 2026-09-19) ──
--
--   SELECT count(*) FILTER (WHERE scadenza IS NULL AND created_at < now() - interval '30 days') AS spariranno_subito,
--          count(*) FILTER (WHERE scadenza IS NULL)                                             AS senza_scadenza,
--          count(*) FILTER (WHERE tipo = 'adesione')                                            AS di_adesione,
--          count(*)                                                                             AS totale
--     FROM public.avvisi;
--
--     spariranno_subito =  1
--     senza_scadenza    = 22
--     di_adesione       = 10
--     totale            = 35
--
--   E, dalle stesse letture del 2026-09-19:
--     avvisi con created_at NULL ................................  0
--     righe in avvisi_risposte .................................. 869  (di cui risposta='si': 65)
--     righe in admin_settings ...................................   4  (tutte senza `promemoria_giorni_prima`)
--
--   COSA DICONO QUESTI NUMERI, e perché stanno qui invece di un'intenzione.
--   22 avvisi su 35 non hanno mai avuto una scadenza. La regola di conversione
--   scelta (`created_at + 30 giorni`) ne manda **1** immediatamente oltre il
--   termine: è un avviso pubblicato più di 30 giorni fa e mai scaduto, che dal
--   momento dell'applicazione risulterà scaduto. È UNO, è noto, ed è il prezzo
--   dichiarato della conversione — non una sorpresa da scoprire dopo. Gli altri
--   21 restano vivi perché più recenti di 30 giorni.
--   ⚠️ NON CONFONDERE «1» CON «QUANTI RISULTERANNO SCADUTI». Rimisurato il
--   2026-09-19 eseguendo il backfill A VUOTO (una `SELECT` con la stessa
--   espressione, zero scritture), la scomposizione dei 35 è:
--         11  avevano già una `scadenza` PASSATA  → erano GIÀ invisibili
--          1  senza scadenza e più vecchio di 30gg → NUOVO, è il prezzo sopra
--         21  senza scadenza ma recenti            → restano visibili
--          2  con scadenza futura                  → restano visibili
--   Quindi dopo l'applicazione gli avvisi scaduti sono **12**, non 1: il
--   filtro «Scaduti» del cockpit ne mostrerà dodici, e chi si aspettava uno
--   penserà a un difetto. L'UNO è il numero di avvisi che CAMBIANO STATO, ed
--   è quello che conta per le famiglie — ma è un numero diverso, e le due
--   frasi si assomigliano abbastanza da essere scambiate.
--   Verifica, sempre in sola lettura:
--     select count(*) filter (where scadenza is not null and scadenza < current_date),
--            count(*) filter (where scadenza is null and created_at + interval '30 days' < now())
--     from avvisi;
--   `created_at IS NULL` non esiste su nessuna riga (la colonna ha
--   `DEFAULT CURRENT_TIMESTAMP` dal 2026-07-04): il `COALESCE(..., now())` nella
--   funzione di conversione è una rete, non un percorso che questo backfill
--   attraversa.
--   ⚠️ Questi quattro numeri invecchiano. Chi legge fra una settimana li
--   RICONTI: è una `SELECT`, e le letture non chiedono conferma a nessuno.
--
-- ── L'AMBIENTE, VERIFICATO E NON CREDUTO (produzione, 2026-09-19) ────────────
--
--   SELECT current_setting('default_transaction_isolation');  →  'read committed'
--   SELECT current_setting('server_version');                 →  '17.6'
--
--   La correttezza delle tre RPC di questo file POGGIA su `READ COMMITTED`, ed è
--   il default di PostgREST/Supabase — verificato, non assunto. Vedi il riquadro
--   «LA CONCORRENZA» più sotto: sotto `REPEATABLE READ` il conteggio dei posti
--   NON sarebbe protetto, e per questo le due RPC di scrittura lo controllano da
--   sé e **rifiutano di lavorare** fuori da `READ COMMITTED`.
--
-- ⚠️ QUESTO FILE NON È MAI STATO DATO IN PASTO A UN PARSER POSTGRESQL, e chi lo
--   rivede deve saperlo. In questo repo una migrazione dentro una PR la applica
--   l'INTEGRAZIONE al merge, con la version del FILE: riapplicarla a mano ne
--   produrrebbe due righe in `supabase_migrations`, quindi qui è stata solo
--   SCRITTA. Sulla macchina di scrittura non c'è né `psql`, né Docker, né un
--   Postgres locale, e l'unico server raggiungibile è la PRODUZIONE, dove questo
--   cantiere fa soltanto letture. Quello che è stato verificato davvero, con
--   `SELECT` su produzione, è l'ARITMETICA (il riquadro del fuso qui sotto) e il
--   CATALOGO (volatilità, DEFAULT, `NOT NULL`, trigger esistenti). La prima
--   analisi sintattica vera sarà l'applicazione al merge.
--
-- ── CHE COSA FA QUESTA MIGRAZIONE, in nove pezzi ─────────────────────────────
--   1. `avviso_scadenza_da_legacy()`: la regola di conversione, scritta UNA volta.
--   2. Le colonne nuove su `avvisi` e `avvisi_risposte`, tutte commentate.
--   3. Il trigger di compatibilità fra `scadenza` (vecchia) e `scadenza_avviso`.
--   4. Il backfill, idempotente, e il `SET NOT NULL` su `scadenza_avviso`.
--   5. I vincoli (e i tre che NON si scrivono, col perché).
--   6. Gli indici.
--   7. `avviso_posti_occupati()` — la somma, in persone.
--   8. `avviso_adesione_registra()` / `avviso_adesione_gestisci()` — le due
--      strade di scrittura, serializzate sullo stesso lock.
--   9. `avvisi_config_default()` v2: `promemoria_giorni_prima`, col suo gemello
--      TypeScript e il recupero delle sedi già esistenti.
--
-- ── CHE COSA NON FA ─────────────────────────────────────────────────────────
--   · NON cancella `avvisi.scadenza`. Fra il merge e il deploy — e per tutta la
--     durata di un eventuale rollback — il CODICE VECCHIO gira contro questo
--     schema: inserisce senza `scadenza_avviso` (violerebbe il `NOT NULL`),
--     legge `scadenza` per il feed, la riscrive sul PUT. Il drop sta in una PR
--     successiva, con la lista di controllo scritta accanto al trigger.
--   · NON aggiunge `scuola_id` a `avvisi_risposte`. La sede sta sul padre
--     (`avvisi.scuola_id`), la risposta ci arriva solo attraverso `avviso_id`, e
--     questo è il motivo per cui il lock `fk-scuola-id` non scatta su questa
--     tabella: non c'è colonna da vincolare. Una `scuola_id` denormalizzata qui
--     sarebbe una seconda verità sulla sede, cioè un modo nuovo di archiviare
--     una risposta nel plesso sbagliato in silenzio.
--   · NON tocca la RLS. `avvisi` e `avvisi_risposte` hanno RLS accesa e **zero
--     policy** (lockdown P0): tutto passa dal service-role, che la RLS la
--     scavalca. Le RPC qui sotto sono `SECURITY DEFINER` e revocate a
--     `anon`/`authenticated`: restano raggiungibili solo dal service-role, cioè
--     dalle route che hanno già il proprio gate applicativo a monte.
--   · NON cabla nessun uuid di sede (lock `migrazioni-senza-sede-cablata`).
--   · NON promuove nessuno dalla coda da sé. Nessun automatismo: chi entra lo
--     decide la segreteria, con `avviso_adesione_gestisci`.
--   · NON IMPEDISCE AL CODICE VECCHIO DI SCRIVERE SU `avvisi_risposte`, e questa
--     è la seconda metà della finestra merge→deploy, quella che finora non era
--     raccontata. Il riquadro qui sopra descrive il codice vecchio su `avvisi`;
--     ma la route odierna `POST /api/avvisi/[id]/risposte`
--     (src/app/api/avvisi/[id]/risposte/route.ts:159-165) fa un `upsert` DIRETTO
--     su `avvisi_risposte`, senza passare da nessuna RPC. Che cosa produce,
--     verificato leggendo quel codice:
--       — NON può sfondare il tetto dei posti. Non scrive `stato_adesione`, e
--         solo `'ammessa'` occupa: una riga nata lì vale zero nel conteggio di
--         `avviso_posti_occupati`.
--       — Ma produce righe con `risposta = 'si'` e `stato_adesione` NULL, cioè
--         adesioni INVISIBILI SIA AL CONTEGGIO SIA ALLA CODA. Non sono un danno
--         al tetto: sono un residuo che qualcuno dovrà RICONCILIARE A MANO dopo
--         il deploy, decidendo riga per riga se ammetterle o metterle in coda.
--       — Si trovano così, e il numero va contato quel giorno, non copiato da qui:
--           SELECT count(*) FROM public.avvisi_risposte
--            WHERE risposta = 'si' AND stato_adesione IS NULL;
--         (al 2026-09-19, prima dell'applicazione, erano le 65 righe storiche:
--         dopo il deploy ogni incremento su questo conteggio è un residuo della
--         finestra.) Si sistemano con `avviso_adesione_gestisci`, che è anche il
--         motivo per cui quella funzione accetta una riga con `risposta` già
--         scritta invece di pretendere di essere lei a crearla.
--       — ⚠️ MA QUEL CONTEGGIO NON È PIÙ FATTO DI UNA COSA SOLA. Da quando
--         `avviso_adesione_gestisci` sa TOGLIERE (`p_stato := 'nessuna'`, § 8b),
--         una rimozione deliberata di chi aveva detto `'si'` lascia una riga con
--         esattamente questa forma. Chi riconcilia non «rimetta dentro» tutto ciò
--         che la query restituisce: una riga con `posto_assegnato_il` valorizzato
--         è stata dentro e ne è stata TOLTA da una persona, e rimetterla dentro
--         disfa una decisione della segreteria. I residui veri della finestra
--         `posto_assegnato_il` non ce l'hanno mai, perché la route vecchia
--         `stato_adesione` non lo scrive proprio:
--           SELECT count(*) FROM public.avvisi_risposte
--            WHERE risposta = 'si' AND stato_adesione IS NULL
--              AND posto_assegnato_il IS NULL;   -- ← i residui, senza le rimozioni
--
-- ── IDEMPOTENTE ─────────────────────────────────────────────────────────────
--   `CREATE OR REPLACE` · `ADD COLUMN IF NOT EXISTS` · `DROP TRIGGER IF EXISTS`
--   · backfill filtrato su `IS NULL` · vincoli aggiunti solo se `pg_constraint`
--   non li conosce già · `CREATE INDEX IF NOT EXISTS` · `SET NOT NULL` (no-op se
--   già applicato). Rilanciarla non cambia niente una seconda volta.
--
-- ── SE VA STORTO ────────────────────────────────────────────────────────────
--   Nessuna colonna rimossa, nessuna riga cancellata, nessun dato di famiglie o
--   di bambini toccato. Ma «additivo» NON vuol dire «non scrive niente», e la
--   differenza va detta per intero invece che arrotondata.
--
--   🔴 IL BACKFILL DATA 22 AVVISI CHE UNA SCADENZA NON CE L'AVEVANO.
--   Il trigger di compatibilità nasce PRIMA del backfill (§ 3, ordine voluto),
--   quindi l'`UPDATE` della § 4 lo fa scattare su ogni riga — e la sua ultima
--   istruzione, `NEW.scadenza := (NEW.scadenza_avviso AT TIME ZONE
--   'Europe/Rome')::date`, è INCONDIZIONATA. Misurato su questa produzione il
--   2026-09-19:
--
--     righe con `scadenza` già valorizzata che CAMBIEREBBERO ......  0
--                                            (round-trip esatto, andata e ritorno)
--     righe con `scadenza IS NULL` che diventano DATATE ........... 22  su 35
--     di queste, già scadute nell'istante dell'applicazione ........  1
--     intervallo delle date nuove ................. 2026-08-16 → 2026-10-19
--
--   Per quelle 22 righe il valore che la colonna esprimeva era `NULL`, cioè
--   «NESSUNA SCADENZA». I «30 giorni» non sono qualcosa che quella colonna
--   dicesse già: sono una DECISIONE DI QUESTA MIGRAZIONE, presa dal committente
--   (un avviso più vecchio di un mese esce dalla bacheca). L'effetto è voluto e
--   non è il difetto; il difetto sarebbe scrivere qui che nessun dato viene
--   riscritto, che è la frase che questo riquadro conteneva prima.
--
--   E QUELLA RIGA GIÀ SCADUTA LO È ANCHE PER IL CODICE VECCHIO: l'avviso più
--   antico dei 22 è del 2026-07-17, +30 giorni fa 2026-08-16, che il trigger
--   scrive anche in `avvisi.scadenza` — quindi sparisce dal feed di *entrambe* le
--   versioni del codice, non solo di quella nuova.
--
--   IL ROLLBACK NON LE RIPRISTINA DA SOLO. Droppare il trigger e togliere il
--   `NOT NULL` lascia `avvisi.scadenza` datata su tutte e 22: il riquadro
--   ROLLBACK in coda al file porta l'elenco degli id letto PRIMA
--   dell'applicazione, e l'istruzione che li rimette a `NULL`.
-- =============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. LA REGOLA DI SCADENZA, SCRITTA UNA VOLTA SOLA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `avvisi.scadenza` è una `date` nullable. Diventa un istante così:
--   · c'è una data  →  le 23:59:59.999 di QUEL giorno, a Roma;
--   · non c'è       →  `created_at + 30 giorni` (e `now()` se manca anche quello).
--
-- IL `.999` NON È UN DETTAGLIO: è il gemello al millisecondo di
-- `fineGiornoCivile()` (src/lib/format/confini-giorno.ts:112), che il prodotto
-- usa già per chiudere un giorno civile italiano — `istanteCivile(ymd,
-- '23:59:59.999')`. Due definizioni di «fine giornata» che differiscono di un
-- millisecondo producono un avviso che il server considera scaduto e
-- l'interfaccia ancora aperto, per un millesimo di secondo al giorno, una volta
-- ogni tanto: il difetto meno riproducibile che si possa scrivere. Se un giorno
-- uno dei due cambia, cambiano ENTRAMBI.
--
-- E LA GEMELLANZA È STATA MISURATA, non dichiarata (2026-09-19). A sinistra la
-- SELECT eseguita su questa produzione, a destra le asserzioni già scritte in
-- `__tests__/lib/confini-giorno.test.ts:44,49` — i due giorni di cambio ora,
-- che sono l'unico posto dove due calendari possono divergere:
--
--   SQL  (g::date + time '23:59:59.999') AT TIME ZONE 'Europe/Rome'
--   TS   fineGiornoCivile(g)
--
--     2026-03-29 → 2026-03-29 21:59:59.999+00   │   '2026-03-29T21:59:59.999Z'
--     2026-10-25 → 2026-10-25 22:59:59.999+00   │   '2026-10-25T22:59:59.999Z'
--
-- Identici al millisecondo, ora legale e ora solare. Nella stessa lettura è stato
-- verificato anche il RITORNO, da cui dipende la lista di controllo per il drop
-- di `scadenza` più sotto: `(… AT TIME ZONE 'Europe/Rome')::date` restituisce il
-- giorno di partenza su tutti e cinque i giorni provati, cambi d'ora compresi.
--
-- PERCHÉ `STABLE` E NON `IMMUTABLE`, misurato invece che ricordato.
--   Il sospetto naturale è `AT TIME ZONE`. È SBAGLIATO, e la prova è nel
--   catalogo di questa stessa produzione (PG 17.6, letto il 2026-09-19):
--     SELECT proname, pg_get_function_identity_arguments(oid),
--            CASE provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' END
--       FROM pg_proc WHERE pronamespace='pg_catalog'::regnamespace AND proname='timezone';
--   →  timezone(text, timestamp without time zone)  =  **immutable**
--   →  timezone(timestamp without time zone)        =  stable   (usa il GUC di sessione)
--   Cioè: `AT TIME ZONE` con un NOME di fuso scritto a mano è immutabile; è la
--   forma a un argomento, quella che legge il fuso della sessione, a essere
--   stabile. Qui il nome è letterale, quindi quel pezzo non impedisce nulla.
--
--   La ragione vera è l'ALTRO ramo: `now()` è `stable` (stessa lettura), e una
--   funzione che lo contiene non può essere `IMMUTABLE` — se lo dichiarassi tale
--   il pianificatore potrebbe costantizzarne il risultato e un indice costruito
--   su di essa conserverebbe per sempre l'istante in cui è stato costruito.
--
--   ED È LA STESSA RAGIONE PER CUI UNA COLONNA GENERATA È IMPOSSIBILE: una
--   `GENERATED ALWAYS AS` pretende un'espressione IMMUTABILE. A cui si aggiunge
--   un secondo impedimento, indipendente e decisivo: una colonna generata non è
--   SCRIVIBILE, e `scadenza_avviso` il codice nuovo deve poterla scrivere.
CREATE OR REPLACE FUNCTION public.avviso_scadenza_da_legacy(
  p_scadenza   date,
  p_created_at timestamptz
) RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN p_scadenza IS NOT NULL
             THEN (p_scadenza + time '23:59:59.999') AT TIME ZONE 'Europe/Rome'
           ELSE COALESCE(p_created_at, now()) + interval '30 days'
         END;
$$;

COMMENT ON FUNCTION public.avviso_scadenza_da_legacy(date, timestamptz) IS
  'Converte la vecchia avvisi.scadenza (date) nell''istante avvisi.scadenza_avviso: le 23:59:59.999 di quel giorno a Europe/Rome, oppure created_at + 30 giorni se la data manca. Gemella al millisecondo di fineGiornoCivile() in src/lib/format/confini-giorno.ts.';

REVOKE ALL ON FUNCTION public.avviso_scadenza_da_legacy(date, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.avviso_scadenza_da_legacy(date, timestamptz) TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. LE COLONNE
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.avvisi
  ADD COLUMN IF NOT EXISTS scadenza_avviso   timestamptz,
  ADD COLUMN IF NOT EXISTS scadenza_adesione timestamptz,
  ADD COLUMN IF NOT EXISTS chiedi_numero     boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS etichetta_numero  varchar(120),
  ADD COLUMN IF NOT EXISTS numero_min        smallint     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS numero_max        smallint     NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS posti_totali      integer;

COMMENT ON COLUMN public.avvisi.scadenza_avviso IS
  'Istante oltre il quale l''avviso esce dal feed. Sostituisce la `date` `scadenza`, che resta solo per compatibilità col codice vecchio. Nullable oggi, NOT NULL dalla fine di questa stessa migrazione.';
COMMENT ON COLUMN public.avvisi.scadenza_adesione IS
  'Istante oltre il quale non si aderisce più. NULL = si aderisce fino a `scadenza_avviso`. Sempre <= `scadenza_avviso`: un avviso non può raccogliere adesioni dopo essere sparito dal feed.';
COMMENT ON COLUMN public.avvisi.chiedi_numero IS
  'true = al genitore si chiede QUANTE persone partecipano. Toglierla con numeri già raccolti resta lecito: i numeri restano dove sono e continuano a contare.';
COMMENT ON COLUMN public.avvisi.etichetta_numero IS
  'Come si chiama la cosa che si conta, mostrata accanto al campo ("Partecipanti", "Adulti", "Posti auto"). Solo interfaccia: il server non la legge mai.';
COMMENT ON COLUMN public.avvisi.numero_min IS
  'Minimo accettato quando `chiedi_numero`. Mai sotto 1: una adesione da zero persone è un rifiuto, e si esprime con risposta = no.';
COMMENT ON COLUMN public.avvisi.numero_max IS
  'Massimo accettato quando `chiedi_numero`. Tetto assoluto 999, che è il limite del vincolo, non una regola didattica.';
COMMENT ON COLUMN public.avvisi.posti_totali IS
  'Tetto dei posti, contato in PERSONE e non in adesioni: una famiglia da 4 ne occupa 4. NULL = nessun tetto. Abbassarlo sotto l''occupato è permesso e NON espelle nessuno (vedi il riquadro dei vincoli).';

ALTER TABLE public.avvisi_risposte
  ADD COLUMN IF NOT EXISTS numero_partecipanti smallint,
  ADD COLUMN IF NOT EXISTS stato_adesione      varchar(10),
  ADD COLUMN IF NOT EXISTS in_coda_dal         timestamptz,
  ADD COLUMN IF NOT EXISTS posto_assegnato_il  timestamptz;

COMMENT ON COLUMN public.avvisi_risposte.numero_partecipanti IS
  'Quante persone porta questa adesione. NULL vale **1 persona** in ogni conteggio: è il caso di tutte le 869 righe storiche e di ogni avviso senza `chiedi_numero`.';
COMMENT ON COLUMN public.avvisi_risposte.stato_adesione IS
  'ammessa | in_attesa | NULL. Solo `ammessa` occupa posti: un rifiuto e un ritiro sono la stessa cosa (NULL) e liberano il posto da soli, senza nessuna cancellazione.';
COMMENT ON COLUMN public.avvisi_risposte.in_coda_dal IS
  'Istante di ingresso in lista d''attesa: regge l''ORDINE DI ARRIVO. NON si azzera quando il genitore corregge il numero restando in coda — chi aspetta da ieri continua ad aspettare da ieri. E per la stessa ragione chi è in_attesa NON viene promosso dal proprio stesso ri-invio di "si" quando un posto si libera: promuove solo la segreteria, con avviso_adesione_gestisci. Senza quella regola questa colonna non servirebbe a niente, perché il posto andrebbe a chi ricarica la pagina più spesso invece che a chi è arrivato prima.';
COMMENT ON COLUMN public.avvisi_risposte.posto_assegnato_il IS
  'Istante in cui questa adesione è diventata `ammessa`. Scritto solo alla TRANSIZIONE, mai su una correzione di chi è già dentro.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. IL TRIGGER DI COMPATIBILITÀ — la parte più delicata del file
-- ═════════════════════════════════════════════════════════════════════════════
--
-- PERCHÉ ESISTE. `scadenza` non si può togliere oggi. Fra il merge e il deploy,
-- e per tutta la durata di un eventuale rollback, il codice VECCHIO gira contro
-- questo schema: inserisce senza `scadenza_avviso` (che fra poche righe diventa
-- `NOT NULL`), legge `scadenza` per decidere cosa mostrare nel feed, e la
-- riscrive a ogni PUT. Le due colonne devono restare vere ENTRAMBE, nei due
-- versi, finché quel codice può tornare a girare.
--
-- ⚠️ I DUE FATTI SU CUI POGGIA, verificati invece che creduti.
--
--  (a) «I vincoli NOT NULL e CHECK sono verificati DOPO i trigger BEFORE ROW.»
--      VERIFICATO, due volte.
--      · Documentazione PostgreSQL 17, `CREATE TRIGGER`, alla lettera: «The
--        trigger can be specified to fire before the operation is attempted on a
--        row (before constraints are checked and the INSERT, UPDATE, or DELETE
--        is attempted)».
--      · E su QUESTA produzione, dove lo stesso schema è in funzione da luglio:
--        `public.presenze.scuola_id` è `NOT NULL` e **non ha DEFAULT** (letto da
--        `pg_attribute`/`pg_attrdef` il 2026-09-19); a riempirla è
--        `trg_presenze_scuola_id`, `BEFORE INSERT OR UPDATE … FOR EACH ROW`
--        (`fn_scuola_id_da_alunno`, migrazione 20260731114449). Oggi la tabella
--        ha **7.157 righe, zero con `scuola_id` NULL**. Se il `NOT NULL` fosse
--        controllato prima del trigger, quel disegno non avrebbe mai potuto
--        inserire una riga.
--
--  (b) «I DEFAULT di colonna sono applicati PRIMA dei trigger BEFORE ROW, quindi
--      `NEW.created_at` è già valorizzato.»
--      NON VERIFICATO, e lo dico invece di nasconderlo. La documentazione di PG
--      17 non lo afferma da nessuna parte in modo esplicito (dice il contrario
--      per le colonne GENERATE: «the NEW row does not yet contain the new
--      generated value and should not be accessed»), e in questo database non
--      c'è un solo trigger BEFORE INSERT che legga una colonna con DEFAULT —
--      controllato sui sei esistenti interrogando `pg_trigger` + `pg_proc.prosrc`
--      il 2026-09-19: nessuno nomina `NEW.created_at`. Verificarlo davvero
--      richiederebbe una SCRITTURA, che questo cantiere non fa.
--
--      QUINDI NON CI SI POGGIA SOPRA. `avviso_scadenza_da_legacy` accetta un
--      `p_created_at` NULL e in quel caso usa `now()`; e `now()` è esattamente
--      ciò che `created_at DEFAULT CURRENT_TIMESTAMP` scriverebbe, perché
--      `now()` e `CURRENT_TIMESTAMP` sono la stessa funzione e valgono entrambe
--      l'istante d'inizio della transazione. Il risultato è IDENTICO nei due
--      mondi: se il DEFAULT è già stato applicato si usa quello, se non lo è si
--      calcola lo stesso istante. Un fatto che non si è potuto misurare non va
--      dato per buono: va reso irrilevante.
--
-- ⚠️ LISTA DI CONTROLLO PER IL DROP DI `avvisi.scadenza` (PR successiva, non questa)
--   1. Nessun riferimento residuo a `scadenza` (la colonna, non `scadenza_avviso`
--      né `scadenza_adesione`) in `src/`, `e2e/`, `mobile/`, `__tests__/`.
--   2. Il deployment precedente non è più promuovibile: finché lo è, un rollback
--      rimette in produzione codice che quella colonna la legge.
--   3. E le due colonne non devono essere derivate: la prova è un conteggio.
--        SELECT count(*) FROM public.avvisi
--         WHERE scadenza IS DISTINCT FROM (scadenza_avviso AT TIME ZONE 'Europe/Rome')::date;
--      Deve valere **0**. Qualunque altro numero significa che qualcosa scrive
--      ancora `scadenza` scavalcando il trigger, e il drop perderebbe quel dato.
--      ⚠️ La prova (3) pretende `count = 0`, ed è il motivo per cui l'ultima riga
--      di questo trigger è INCONDIZIONATA e deve restare tale: renderla
--      condizionata terrebbe alcune righe non derivate e farebbe fallire la prova.
--      Il prezzo di quella scelta — 22 avvisi che passano da «nessuna scadenza» a
--      una data — è misurato nel riquadro «SE VA STORTO» in testa al file.
--   4. IL DROP DELLA FUNZIONE, NON SOLO DEL TRIGGER. Un `DROP TRIGGER` lascia in
--      piedi `public.avvisi_scadenza_compat()`, che a quel punto è una funzione
--      ORFANA il cui corpo nomina una colonna che non esiste più: non dà errore
--      finché nessuno la chiama, e il primo che la ricollega a una tabella
--      prende un `42703` che sembra un bug di oggi e invece è un residuo. Si
--      droppa subito dopo il trigger.
--   5. IL DATABASE E2E DELLA CI È UN PROGETTO SEPARATO E NON È MIGRATO. Le
--      colonne nuove lì non esistono: il codice deve continuare a degradare in
--      modo pulito su `PGRST204` (INSERT/UPDATE: colonna sconosciuta allo schema
--      cache) e `42703` (SELECT: colonna inesistente) — sia per `scadenza_avviso`
--      prima del deploy, sia per `scadenza` DOPO il drop, perché in CI la colonna
--      vecchia continuerà a esistere e la nuova no. Una route che non li prevede
--      fa fallire l'E2E con un errore che sembra un bug del codice e non lo è.
--   Solo allora, in quest'ordine:
--     `DROP TRIGGER trg_avvisi_scadenza_compat ON public.avvisi;`
--     `DROP FUNCTION public.avvisi_scadenza_compat();`
--     `ALTER TABLE public.avvisi DROP COLUMN scadenza;`
CREATE OR REPLACE FUNCTION public.avvisi_scadenza_compat()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Il codice vecchio non conosce `scadenza_avviso`: si DEDUCE, mai un valore
    -- fisso. Un default di colonna qui sarebbe sbagliato due volte — non saprebbe
    -- niente della `scadenza` che il chiamante ha appena passato, e congelerebbe
    -- «30 giorni» nello schema invece che nella regola.
    IF NEW.scadenza_avviso IS NULL THEN
      NEW.scadenza_avviso := public.avviso_scadenza_da_legacy(NEW.scadenza, NEW.created_at);
    END IF;

  ELSE
    -- UPDATE: comanda chi ha CAMBIATO qualcosa, non chi è semplicemente presente
    -- nel payload. È la differenza fra «il PUT ha toccato la scadenza» e «il PUT
    -- ha rimandato indietro tutta la riga»: PostgREST manda comunque l'intero
    -- record, e un controllo su `IS NOT NULL` invece che su `IS DISTINCT FROM`
    -- ricalcolerebbe la scadenza a ogni salvataggio del solo titolo.
    IF NEW.scadenza_avviso IS DISTINCT FROM OLD.scadenza_avviso THEN
      -- Il codice NUOVO ha parlato: vince lui, e `scadenza` lo segue in coda.
      -- Un `scadenza_avviso := NULL` esplicito NON viene raddrizzato: sarebbe un
      -- difetto del codice nuovo, e deve sbattere contro il NOT NULL invece di
      -- essere coperto in silenzio.
      NULL;

    ELSIF NEW.scadenza IS DISTINCT FROM OLD.scadenza THEN
      IF NEW.scadenza IS NOT NULL THEN
        -- Il codice VECCHIO ha spostato la data: si ricalcola l'istante.
        -- (`created_at` non entra nel conto in questo ramo — `p_scadenza` non è
        -- NULL — ma si passa lo stesso, perché la regola vive in un posto solo.)
        NEW.scadenza_avviso := public.avviso_scadenza_da_legacy(NEW.scadenza, NEW.created_at);
      ELSE
        -- `scadenza := NULL` significava «nessuna scadenza». Non esiste più: un
        -- avviso senza istante di uscita non è rappresentabile. Si conserva
        -- quello che c'era, e la riga in coda rimetterà `scadenza` al suo posto.
        NEW.scadenza_avviso := OLD.scadenza_avviso;
      END IF;

    -- Non si è mossa nessuna delle due: non si tocca niente. Un PUT di solo
    -- titolo non deve spostare una scadenza.
    END IF;
  END IF;

  -- SEMPRE, in coda. Quando nulla si è mosso è un no-op per costruzione (le due
  -- colonne sono già derivate l'una dall'altra); quando qualcosa si è mosso è
  -- ciò che tiene in vita il feed del codice vecchio; e nel caso patologico di
  -- una riga in cui le due colonne fossero scivolate via, la ripara.
  NEW.scadenza := (NEW.scadenza_avviso AT TIME ZONE 'Europe/Rome')::date;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.avvisi_scadenza_compat() IS
  'Tiene sincronizzate avvisi.scadenza (date, codice vecchio) e avvisi.scadenza_avviso (timestamptz, codice nuovo) nei due versi, finché la prima esiste. Comanda la colonna che è CAMBIATA.';

-- `SECURITY INVOKER` di proposito, come `fn_scuola_id_da_alunno`: le scritture
-- su `avvisi` passano tutte dal service-role, e un trigger INVOKER che non
-- riuscisse a leggere fa fallire la scrittura — cioè nega — invece di scrivere
-- una scadenza sbagliata. Fra le due, la direzione sicura è questa.
DROP TRIGGER IF EXISTS trg_avvisi_scadenza_compat ON public.avvisi;
CREATE TRIGGER trg_avvisi_scadenza_compat
  BEFORE INSERT OR UPDATE ON public.avvisi
  FOR EACH ROW EXECUTE FUNCTION public.avvisi_scadenza_compat();


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. IL BACKFILL, E POI IL VINCOLO
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Il trigger è già attivo qui sopra, PRIMA del backfill, e l'ordine è voluto:
-- fra il backfill e il `SET NOT NULL` può passare una scrittura concorrente, e
-- deve trovare il presidio già acceso. È la stessa sequenza — trigger, backfill,
-- vincolo — della migrazione 20260731114449 su `presenze`/`armadietto`, e per
-- la stessa ragione.
--
-- Entrambe le UPDATE sono filtrate su `IS NULL`: rieseguire la migrazione non
-- tocca una riga già convertita, e soprattutto non scavalca una `scadenza_avviso`
-- che nel frattempo qualcuno abbia impostato a mano.

UPDATE public.avvisi
   SET scadenza_avviso = public.avviso_scadenza_da_legacy(scadenza, created_at)
 WHERE scadenza_avviso IS NULL;

-- «La stessa data»: è la decisione del committente. Non `scadenza_avviso - 1
-- giorno` e non un termine separato inventato qui — chi vorrà anticipare la
-- chiusura delle adesioni lo farà dall'interfaccia, avviso per avviso.
-- Solo sugli avvisi di adesione: su una presa visione un termine di adesione non
-- vuol dire niente, e scriverlo lo farebbe comparire nei filtri del cron.
UPDATE public.avvisi
   SET scadenza_adesione = scadenza_avviso
 WHERE tipo = 'adesione'
   AND scadenza_adesione IS NULL;

-- Dopo il backfill nessuna riga può essere rimasta indietro: la funzione di
-- conversione non restituisce mai NULL (il ramo senza data ripiega su `now()`).
ALTER TABLE public.avvisi
  ALTER COLUMN scadenza_avviso SET NOT NULL;


-- ── LE ADESIONI GIÀ DATE DIVENTANO «ammessa» ────────────────────────────────
--
-- AGGIUNTO IL 2026-09-19, DOPO aver simulato il post-deploy invece di dedurlo.
--
-- IL DIFETTO CHE CHIUDE. `riepilogoPosti` (src/lib/avvisi/posti.ts:111) conta
-- solo `stato_adesione = 'ammessa'`, e `misurato`
-- (dettaglio/numeri-adesioni.ts:162) distingue `undefined` — colonna ASSENTE,
-- database non migrato — da `null`. Dopo questa migrazione la colonna ESISTE,
-- quindi PostgREST restituisce `null`, `misurato` vale **true**, e la schermata
-- della segreteria dichiara con sicurezza «0 persone» su avvisi dove ci sono
-- adesioni vere. La guardia c'è ed è scritta bene, ma è tarata sul database non
-- migrato: il caso «colonna presente, dato storico» le passa accanto. Il
-- commento di quel file chiama quella frase «l'unica capace di far sembrare
-- vuoto un pullman pieno» — e senza questa UPDATE la scriverebbe da sola.
--
-- MISURATO IN PRODUZIONE IL 2026-09-19, non supposto:
--     risposta='si'  →  65 righe, TUTTE su avvisi `tipo='adesione'` (8 avvisi)
--     risposta='no'  →   0 righe, su qualunque tipo
--     risposta NULL  → 798 righe (prese visione: non sono adesioni)
--   e nessun avviso ha `posti_totali` (colonna appena nata): nessun tetto può
--   essere sfondato da questa scrittura, e nessuna coda può nascerne.
--
-- PERCHÉ 'ammessa' E NON UN NUOVO STATO. Quelle famiglie hanno detto sì quando
-- una capienza non esisteva: erano dentro, e nessuno le ha mai messe in coda.
-- 'ammessa' non inventa niente, TRADUCE. `posto_assegnato_il` resta NULL di
-- proposito: scriverci un istante significherebbe fabbricare la data di
-- un'ammissione che non è mai avvenuta attraverso il flusso nuovo. Nessun
-- codice in `src/` legge quella colonna (verificato con `grep`), quindi il NULL
-- non rompe niente.
--
-- IDEMPOTENTE: filtrata su `stato_adesione IS NULL`, al secondo giro tocca 0 righe.
--
-- 🔙 PER TORNARE INDIETRO, se il titolare decide che le adesioni storiche non
--    devono occupare posti. Una riga, e riporta esattamente allo stato di prima
--    perché nessun'altra istruzione di questo file scrive `stato_adesione`:
--      UPDATE public.avvisi_risposte
--         SET stato_adesione = NULL
--       WHERE risposta = 'si' AND stato_adesione = 'ammessa'
--         AND posto_assegnato_il IS NULL;
--    L'ultima condizione è ciò che distingue le righe convertite da qui (mai
--    passate dal flusso nuovo) da quelle ammesse a mano dalla segreteria DOPO
--    il deploy, che non vanno toccate.
UPDATE public.avvisi_risposte
   SET stato_adesione = 'ammessa'
 WHERE risposta = 'si'
   AND stato_adesione IS NULL;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. I VINCOLI
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Aggiunti solo se `pg_constraint` non li conosce già, così la migrazione è
-- rieseguibile (stesso schema di 20260814225302).
--
-- ⚠️ E `pg_constraint` **non vede gli indici UNIQUE parziali**: quelli della
-- sezione 6 si cercano in `pg_indexes`, non qui. Lezione già pagata il
-- 2026-09-09; qui non morde perché nessuno dei cinque vincoli è un indice.
--
-- ── I TRE VINCOLI CHE NON SI SCRIVONO, E IL PERCHÉ ──────────────────────────
--
--  (1) `tipo = 'adesione' ⇒ scadenza_adesione NOT NULL`.
--      Romperebbe il codice vecchio dentro la finestra fra merge e deploy: la
--      route odierna `POST /api/avvisi` non conosce `scadenza_adesione` e
--      pubblicherebbe un avviso di adesione con quella colonna a NULL — cioè
--      prenderebbe un errore su una funzione che oggi funziona. Il backfill qui
--      sopra ha già riempito tutte le righe esistenti; il vincolo va in una
--      migrazione di IRRIGIDIMENTO successiva, aggiunto `NOT VALID` e poi
--      `VALIDATE CONSTRAINT`, quando il codice vecchio non può più tornare.
--
--  (2) `chiedi_numero ⇒ numero_partecipanti NOT NULL`.
--      Non esprimibile: è un CHECK fra due TABELLE, e in PostgreSQL non esiste.
--      E anche potendo sarebbe sbagliato: il committente ha deciso che togliere
--      la bandierina quando i numeri sono già stati raccolti resta lecito, e
--      riaccenderla non deve invalidare le adesioni arrivate prima. Il controllo
--      sta dove la decisione si prende — dentro `avviso_adesione_registra`, al
--      momento della risposta (`NUMERO_RICHIESTO`).
--
--  (3) Qualunque vincolo fra `posti_totali` e l'occupato.
--      Abbassare il tetto sotto l'occupato è PERMESSO, ed è una scelta esplicita:
--      la sala si è rimpicciolita, la segreteria deve poterlo scrivere subito e
--      poi decidere con calma chi esce. Un vincolo qui trasformerebbe un fatto
--      del mondo in un errore del database, e chi occupa il posto verrebbe
--      espulso da un `CHECK` invece che da una persona.
DO $$
BEGIN
  -- Non si raccolgono adesioni dopo che l'avviso è sparito dal feed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.avvisi'::regclass
       AND conname  = 'avvisi_scadenza_adesione_entro_avviso_chk'
  ) THEN
    ALTER TABLE public.avvisi
      ADD CONSTRAINT avvisi_scadenza_adesione_entro_avviso_chk
      CHECK (scadenza_adesione IS NULL OR scadenza_adesione <= scadenza_avviso);
  END IF;

  -- L'intervallo dichiarato dall'avviso deve essere un intervallo.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.avvisi'::regclass
       AND conname  = 'avvisi_numero_intervallo_chk'
  ) THEN
    ALTER TABLE public.avvisi
      ADD CONSTRAINT avvisi_numero_intervallo_chk
      CHECK (numero_min >= 1 AND numero_max >= numero_min AND numero_max <= 999);
  END IF;

  -- Un tetto di zero posti non è un tetto: è un avviso che non accetta nessuno,
  -- e si esprime chiudendo le adesioni, non con un numero.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.avvisi'::regclass
       AND conname  = 'avvisi_posti_totali_positivo_chk'
  ) THEN
    ALTER TABLE public.avvisi
      ADD CONSTRAINT avvisi_posti_totali_positivo_chk
      CHECK (posti_totali IS NULL OR posti_totali > 0);
  END IF;

  -- L'elenco degli stati è CHIUSO. NULL resta legittimo e significa «nessuna
  -- adesione»: è lo stato di tutte le 869 righe storiche.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.avvisi_risposte'::regclass
       AND conname  = 'avvisi_risposte_stato_adesione_chk'
  ) THEN
    ALTER TABLE public.avvisi_risposte
      ADD CONSTRAINT avvisi_risposte_stato_adesione_chk
      CHECK (stato_adesione IS NULL OR stato_adesione IN ('ammessa', 'in_attesa'));
  END IF;

  -- Stesso tetto dell'intervallo dichiarabile dall'avviso: il vincolo di tabella
  -- è la rete sotto la validazione applicativa, non un suo doppione allentato.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.avvisi_risposte'::regclass
       AND conname  = 'avvisi_risposte_numero_partecipanti_chk'
  ) THEN
    ALTER TABLE public.avvisi_risposte
      ADD CONSTRAINT avvisi_risposte_numero_partecipanti_chk
      CHECK (numero_partecipanti IS NULL OR numero_partecipanti BETWEEN 1 AND 999);
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. GLI INDICI
-- ═════════════════════════════════════════════════════════════════════════════

-- LA SOMMA GIRA DENTRO IL LOCK, quindi deve costare il meno possibile: ogni
-- millisecondo speso qui è un millisecondo in cui tutti gli altri genitori di
-- quell'avviso aspettano. `INCLUDE (numero_partecipanti)` porta il valore dentro
-- la foglia dell'indice: la somma si legge senza mai toccare la tabella
-- (index-only scan). Parziale su `ammessa` perché è l'unico stato che occupa.
CREATE INDEX IF NOT EXISTS avvisi_risposte_ammesse_idx
  ON public.avvisi_risposte (avviso_id) INCLUDE (numero_partecipanti)
  WHERE stato_adesione = 'ammessa';

-- La coda, in ordine di arrivo: è la lettura della schermata di segreteria.
CREATE INDEX IF NOT EXISTS avvisi_risposte_coda_idx
  ON public.avvisi_risposte (avviso_id, in_coda_dal)
  WHERE stato_adesione = 'in_attesa';

-- «Chi NON ha ancora risposto»: il promemoria parte da qui, come anti-join fra
-- i destinatari e questo indice.
CREATE INDEX IF NOT EXISTS avvisi_risposte_chi_ha_risposto_idx
  ON public.avvisi_risposte (avviso_id, student_id)
  WHERE risposta IS NOT NULL;

-- Il feed: gli avvisi di UNA sede, i più recenti per scadenza prima.
CREATE INDEX IF NOT EXISTS avvisi_feed_sede_scadenza_idx
  ON public.avvisi (scuola_id, scadenza_avviso DESC);

-- Il cron delle adesioni in chiusura. Parziale, perché su 35 avvisi solo 10 sono
-- di adesione e il cron non deve nemmeno vedere gli altri.
CREATE INDEX IF NOT EXISTS avvisi_cron_scadenza_adesione_idx
  ON public.avvisi (scadenza_adesione)
  WHERE tipo = 'adesione' AND scadenza_adesione IS NOT NULL;


-- ═════════════════════════════════════════════════════════════════════════════
-- 7-8. LE TRE RPC — LA CONCORRENZA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- IL PRECEDENTE DOLOROSO è `varia_saldo_ticket` (20260907181116): il saldo veniva
-- letto, modificato e riscritto per valore assoluto. Due scritture concorrenti
-- leggevano lo stesso numero e scrivevano lo stesso risultato — e il danno non
-- era «saldo doppio» ma **incasso doppio e saldo singolo**. Nessun errore,
-- nessun log, e il numero che l'operatore guardava sembrava a posto.
--
-- QUI LA FORMA È IDENTICA. Tetto 10, occupati 8. Due genitori chiedono 2 posti
-- ciascuno nello stesso istante: entrambi leggono «occupati 8», entrambi vedono
-- spazio per 2, entrambi vengono ammessi. Il tetto di 10 diventa 12, e a
-- scoprirlo è la persona che quel giorno conta le sedie.
--
-- LA CURA, in tre righe.
--   1. `SELECT … FROM public.avvisi WHERE id = … FOR UPDATE` è IL PUNTO DI
--      SERIALIZZAZIONE. Non si blocca la riga della risposta (ogni genitore ha
--      la sua e non collidono mai): si blocca il PADRE, che è la cosa di cui il
--      tetto è una proprietà.
--   2. Il conteggio viene DOPO quel lock, come istruzione separata. In
--      `READ COMMITTED` ogni istruzione di un blocco plpgsql prende uno snapshot
--      nuovo: chi si sblocca vede il lavoro appena committato da chi lo
--      precedeva. È questo, e solo questo, a rendere il conteggio vero.
--   3. L'ORDINE DEI LOCK È SEMPRE `avvisi` → `avvisi_risposte`, in ENTRAMBE le
--      funzioni. La strada del genitore e quella della segreteria toccano le
--      stesse due tabelle: invertire l'ordine in una delle due genera deadlock
--      che compaiono solo sotto carico, cioè il giorno della gita.
--
-- ⚠️ E QUI UNA PRECISAZIONE CHE VA FATTA, invece che ripetere una comoda
-- semplificazione. Si dice spesso che sotto `REPEATABLE READ` questo schema «si
-- romperebbe rumorosamente» con un `40001`. **Non è vero in questo caso**:
-- `SELECT … FOR UPDATE` solleva `40001` quando la riga bloccata è stata
-- AGGIORNATA da una transazione concorrente, e qui la riga di `avvisi` viene
-- soltanto bloccata, mai scritta. Un chiamante in `REPEATABLE READ` prenderebbe
-- dunque il lock senza errore e conterebbe i posti sul proprio snapshot vecchio:
-- il difetto tornerebbe, **in silenzio**, che è esattamente la famiglia di guasti
-- che questo file esiste per chiudere.
-- Perciò non ci si affida al default: le due funzioni di scrittura CONTROLLANO
-- il livello di isolamento e rifiutano di lavorare fuori da `READ COMMITTED`.
-- Il default di produzione è `read committed` (verificato il 2026-09-19), quindi
-- in condizioni normali quel controllo non si vede mai — ed è il punto: è la
-- rete per il giorno in cui qualcuno imposta un `SET TRANSACTION ISOLATION
-- LEVEL` credendo di rendere il sistema più sicuro.
--
-- E IL RIFIUTO HA LA FORMA DI UN CODICE, non di un'eccezione. Un
-- `RAISE EXCEPTION` uscirebbe dal vocabolario del prodotto: il chiamante
-- riceverebbe prosa italiana con un `%` interpolato e **nessun `code`** a cui
-- agganciarsi, cioè esattamente ciò che una route non sa tradurre e finisce per
-- mostrare come 500 generico. Si torna invece
-- `{ok:false, code:'ISOLAMENTO_NON_SUPPORTATO', isolamento:'…'}`, come ogni
-- altro rifiuto di queste funzioni — vedi la tabella dei codici accanto a
-- `avviso_adesione_registra`. Rumoroso lo resta: il codice non è `ok`, la route
-- non scrive niente e il log porta il livello trovato.

-- ── 7. La somma, in persone ─────────────────────────────────────────────────
--
-- `p_escludi_risposta` non è un ornamento: serve quando si MODIFICA il numero di
-- un'adesione già ammessa. Il valore vecchio di quella stessa riga non deve
-- entrare nel conto contro cui si misura il valore nuovo, o una famiglia che
-- passa da 4 a 3 si troverebbe misurata come se ne chiedesse 7.
CREATE OR REPLACE FUNCTION public.avviso_posti_occupati(
  p_avviso_id        uuid,
  p_escludi_risposta uuid DEFAULT NULL
) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(COALESCE(r.numero_partecipanti, 1)), 0)::integer
    FROM public.avvisi_risposte r
   WHERE r.avviso_id = p_avviso_id
     AND r.stato_adesione = 'ammessa'
     AND (p_escludi_risposta IS NULL OR r.id <> p_escludi_risposta);
$$;

COMMENT ON FUNCTION public.avviso_posti_occupati(uuid, uuid) IS
  'Posti occupati da un avviso, contati in PERSONE: somma di numero_partecipanti (NULL = 1) sulle sole risposte ammessa. p_escludi_risposta toglie dal conto una riga, per misurare il numero NUOVO di chi sta correggendo il proprio.';

REVOKE ALL ON FUNCTION public.avviso_posti_occupati(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.avviso_posti_occupati(uuid, uuid) TO service_role;


-- ── 8a. Il genitore ─────────────────────────────────────────────────────────
--
-- ORDINE OBBLIGATORIO, e ogni passo è dove è per una ragione:
--   validazione → lock su `avvisi` → termine → numero → lock sulla risposta →
--   stato → upsert.
--
-- IL TERMINE SI CONTROLLA SOLO SE SI STA RISPONDENDO. La sola PRESA VISIONE
-- resta sempre lecita: leggere tardi non è aderire, e un genitore che apre
-- l'avviso il giorno dopo deve comunque risultare come uno che l'ha letto —
-- altrimenti l'elenco «chi non ha letto» diventa una bugia. Il termine è
-- `COALESCE(scadenza_adesione, scadenza_avviso)`.
--
-- `letto_il` / `risposta` / `risposto_il` si comportano ESATTAMENTE come oggi fa
-- `POST /api/avvisi/[id]/risposte` (src/app/api/avvisi/[id]/risposte/route.ts:143-156):
-- `letto_il` è il PRIMO istante e non si riscrive mai; `risposta`/`risposto_il`
-- cambiano solo quando una risposta arriva davvero, e altrimenti si conservano.
-- Questa funzione non introduce una seconda semantica: replica quella.
--
-- `prima_lettura` / `prima_risposta` tornano al chiamante perché servono a
-- decidere se notificare l'autore. Calcolarle QUI, sotto lo stesso lock, fa
-- sparire una query in più **e** una finestra TOCTOU: nella route odierna fra la
-- `select` che guarda se la riga esiste e l'`upsert` che la scrive c'è un
-- intervallo in cui due richieste dello stesso genitore possono entrambe
-- concludere «è la prima volta».
CREATE OR REPLACE FUNCTION public.avviso_adesione_registra(
  p_avviso_id  uuid,
  p_parent_id  uuid,
  p_student_id uuid,
  p_risposta   text        DEFAULT NULL,
  p_numero     smallint    DEFAULT NULL,
  p_ora        timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ora      timestamptz := COALESCE(p_ora, now());
  v_avviso   record;
  v_riga     public.avvisi_risposte;
  v_esiste   boolean := false;
  v_termine  timestamptz;
  v_stato    text;
  v_numero   smallint;
  v_richiesti integer;
  v_occupati integer;
  v_in_coda  timestamptz;
  v_assegnato timestamptz;
  v_letto    timestamptz;
  v_risposta text;
  v_risposto timestamptz;
  v_prima_lettura  boolean;
  v_prima_risposta boolean;
  v_out      public.avvisi_risposte;
  v_prima_persone integer;
  v_dopo_persone  integer;
  v_liberati integer;
  v_in_attesa integer;
BEGIN
  -- Vedi il riquadro «LA CONCORRENZA»: fuori da READ COMMITTED il conteggio dei
  -- posti non è protetto. Si rifiuta con un CODICE e non con un `RAISE`, perché
  -- un'eccezione uscirebbe dal vocabolario del prodotto — prosa italiana e
  -- nessun `code` a cui agganciarsi.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ISOLAMENTO_NON_SUPPORTATO',
                              'isolamento', current_setting('transaction_isolation'));
  END IF;

  -- 1. VALIDAZIONE. `NULL` è legittimo e significa «sto solo leggendo».
  IF p_risposta IS NOT NULL AND p_risposta NOT IN ('si', 'no') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'RISPOSTA_NON_VALIDA');
  END IF;

  -- 2. IL PUNTO DI SERIALIZZAZIONE. Primo lock: il PADRE. Sempre per primo.
  SELECT a.id, a.tipo, a.chiedi_numero, a.numero_min, a.numero_max,
         a.posti_totali, a.scadenza_avviso, a.scadenza_adesione
    INTO v_avviso
    FROM public.avvisi a
   WHERE a.id = p_avviso_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AVVISO_INESISTENTE');
  END IF;

  -- 3. IL TERMINE — solo per chi risponde.
  --
  -- ⚠️ GEMELLO DICHIARATO SULL'OPERATORE, non solo sul `COALESCE`.
  -- Questa riga e `avvisoScaduto()` in src/lib/avvisi/scadenze.ts sono la stessa
  -- regola in due linguaggi, e la gemellanza sta in DUE punti che vanno nominati
  -- tutti e due, perché l'assenza del secondo aveva già reso invisibile una
  -- divergenza vera:
  --   1. `COALESCE(scadenza_adesione, scadenza_avviso)`  ↔  `adesioniChiuse()`
  --   2. `>` e non `>=`                                   ↔  `avvisoScaduto()`
  -- LA SCADENZA È L'ULTIMO ISTANTE VALIDO, INCLUSO: all'istante esatto si aderisce
  -- ancora, si smette di aderire il millisecondo dopo. È anche ciò che rende
  -- coerente il `.999` del backfill, che è l'ultimo istante VIVO del giorno e non
  -- il primo morto. Fino al 2026-09-19 il TypeScript usava `>=` sul ramo «istante»
  -- e `>` sul ramo «data pura»: due metà ciascuna coerente con sé stessa, che
  -- nessun test poteva vedere divergere. Il terzo pezzo dello stesso gemello è il
  -- filtro del feed, che userà `.gte('scadenza_avviso', adesso)` e non `.gt`.
  -- Chi cambia uno di questi tre operatori li cambia TUTTI E TRE.
  IF p_risposta IS NOT NULL THEN
    v_termine := COALESCE(v_avviso.scadenza_adesione, v_avviso.scadenza_avviso);
    IF v_termine IS NOT NULL AND v_ora > v_termine THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TERMINE_SCADUTO', 'termine', v_termine);
    END IF;
  END IF;

  -- 4. IL NUMERO. Si controlla ciò che il chiamante HA MANDATO, non il valore
  --    effettivo: «assente» deve poter essere distinto da «uguale a prima».
  IF p_risposta = 'si' AND v_avviso.chiedi_numero THEN
    IF p_numero IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NUMERO_RICHIESTO',
                                'numero_min', v_avviso.numero_min,
                                'numero_max', v_avviso.numero_max);
    END IF;
    IF p_numero < v_avviso.numero_min OR p_numero > v_avviso.numero_max THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NUMERO_FUORI_INTERVALLO',
                                'numero_min', v_avviso.numero_min,
                                'numero_max', v_avviso.numero_max);
    END IF;
  END IF;

  -- 5. Secondo lock, nell'ordine giusto: la riga della risposta.
  SELECT r.* INTO v_riga
    FROM public.avvisi_risposte r
   WHERE r.avviso_id  = p_avviso_id
     AND r.parent_id  = p_parent_id
     AND r.student_id = p_student_id
     FOR UPDATE;
  v_esiste := FOUND;

  -- Il numero EFFETTIVO. Quando il chiamante non ne manda uno si conserva quello
  -- già raccolto: una presa visione non deve cancellare un dato, e nemmeno una
  -- bandierina `chiedi_numero` spenta dopo la raccolta.
  --
  -- 🔴 CON `chiedi_numero` SPENTO IL NUMERO NON È UN CAMPO GOVERNATO: si CONSERVA
  -- quello già raccolto e NON se ne accetta uno nuovo. Il controllo d'intervallo
  -- del passo 4 è condizionato a `chiedi_numero`, quindi senza questa distinzione
  -- un `p_numero = 900` su un avviso che il numero non lo chiede nemmeno passava
  -- SENZA ALCUN CONTROLLO, finiva in `numero_partecipanti` e OCCUPAVA 900 POSTI
  -- contro `posti_totali`. L'unica rete era il `CHECK (… BETWEEN 1 AND 999)`, che
  -- 900 lo lascia passare. Questa è la strada del GENITORE: il valore arriva da un
  -- client.
  -- ⚠️ Non è il contrario della decisione vicina: «togliere la bandierina con
  -- numeri già raccolti resta lecito, e i numeri restano dove sono e continuano a
  -- contare» vale ancora, ed è esattamente il ramo `ELSE`. Si CONSERVA ciò che c'è,
  -- si RIFIUTA ciò che arriva.
  v_numero := CASE WHEN v_avviso.chiedi_numero
                   THEN COALESCE(p_numero, v_riga.numero_partecipanti)
                   ELSE v_riga.numero_partecipanti
              END;

  -- `letto_il`: il PRIMO istante, mai riscritto (route:147).
  v_letto := COALESCE(v_riga.letto_il, v_ora);

  IF p_risposta IS NOT NULL THEN
    v_risposta := p_risposta;
    v_risposto := v_ora;
  ELSE
    -- Nessuna risposta in arrivo: si conserva quella di prima (route:153-156).
    v_risposta := v_riga.risposta;
    v_risposto := v_riga.risposto_il;
  END IF;

  v_prima_lettura  := NOT v_esiste;
  v_prima_risposta := p_risposta IS NOT NULL AND v_riga.risposta IS NULL;

  -- 6. LO STATO.
  v_stato     := v_riga.stato_adesione;
  v_in_coda   := v_riga.in_coda_dal;
  v_assegnato := v_riga.posto_assegnato_il;

  IF p_risposta = 'no' THEN
    -- Rifiuto e RITIRO sono la stessa cosa, e liberano il posto da soli: solo
    -- `ammessa` conta. Niente cancellazioni, niente conteggi da aggiornare.
    v_stato := NULL;

  ELSIF p_risposta = 'si' THEN
    v_richiesti := COALESCE(v_numero, 1);

    IF v_riga.stato_adesione = 'in_attesa' THEN
      -- 🔴 CHI È IN CODA RESTA IN CODA. PROMUOVE SOLO LA SEGRETERIA.
      -- Il riquadro di `avviso_adesione_gestisci` dice «NESSUNA PROMOZIONE
      -- AUTOMATICA», ma finché questo ramo non esisteva l'automatismo lo faceva
      -- proprio la strada del GENITORE: chi era in coda e ripeteva `'si'` nel
      -- momento in cui un posto si liberava cadeva nel ramo «c'è spazio» e
      -- diventava `ammessa` all'istante — SCAVALCANDO chi aspettava da prima,
      -- mentre `in_coda_dal` esiste apposta per reggere l'ordine d'arrivo. Il
      -- posto sarebbe andato a chi ricarica la pagina più spesso, non a chi è
      -- arrivato per primo.
      -- Il numero può comunque correggerlo: `v_numero` è già stato calcolato e
      -- l'upsert in coda lo scrive. E `in_coda_dal` NON si muove, perché la
      -- guardia della transizione più sotto chiede `IS DISTINCT FROM 'in_attesa'`:
      -- chi aspetta da ieri continua ad aspettare da ieri.
      -- Vale anche quando `posti_totali` è diventato NULL nel frattempo (tetto
      -- tolto): liberare la coda è una decisione, e la prende una persona.
      --
      -- ⚠️ FIN DOVE ARRIVA QUESTA GUARDIA, detto per intero perché il riquadro di
      -- `avviso_adesione_gestisci` promette «promuove solo la segreteria» e questa
      -- è l'unica riga che dice quanto quella promessa è larga davvero: la coda NON
      -- è inespugnabile dal lato genitore. Questo ramo ferma il `'si'` RIPETUTO —
      -- chi è in coda e ricarica la pagina resta in coda. Non ferma **`'no'` e poi
      -- `'si'`**: il `'no'` porta `stato_adesione` a NULL, e al `'si'` successivo
      -- la riga non è più `in_attesa`, quindi se nel frattempo un posto si è
      -- liberato quel genitore entra, scavalcando chi aspettava da prima.
      -- È VOLUTO e non è una svista: RITIRARSI SIGNIFICA PERDERE IL POSTO IN FILA.
      -- Chi se ne va esce dalla coda davvero — `in_coda_dal` gli viene riscritto
      -- con l'istante del rientro (la guardia della transizione scatta, perché NULL
      -- è distinto da `'in_attesa'`) e in coda ricomincia dal fondo. Il costo
      -- dichiarato è che un genitore che si ritira e ripensa nell'istante giusto
      -- può trovare il posto libero prima di chi era davanti: è il prezzo di non
      -- tenere prenotato un posto a chi ha detto di no, e la difesa vera è che
      -- dalla coda si entra per decisione della segreteria, non per velocità.
      v_stato := 'in_attesa';

    ELSIF v_avviso.posti_totali IS NULL THEN
      v_stato := 'ammessa';
    ELSE
      -- Il conteggio, DOPO il lock e come istruzione a sé: snapshot nuovo.
      v_occupati := public.avviso_posti_occupati(p_avviso_id, v_riga.id);

      IF v_occupati + v_richiesti <= v_avviso.posti_totali THEN
        v_stato := 'ammessa';

      ELSIF v_riga.stato_adesione = 'ammessa'
            AND v_richiesti <= COALESCE(v_riga.numero_partecipanti, 1) THEN
        -- UN CAMBIO NON CRESCENTE È SEMPRE SICURO, anche sopra capienza.
        -- Si finisce qui quando il tetto è stato ABBASSATO sotto l'occupato (cosa
        -- permessa, vedi il vincolo (3) che non si scrive): tetto 10, occupati 11,
        -- una famiglia da 4 che vuole scendere a 2. Rifiutare quella riduzione
        -- significava tenerla a 4 — cioè peggiorare la situazione che il rifiuto
        -- diceva di proteggere. La decisione del committente parla di chi prova ad
        -- AUMENTARE; scendere, o restare uguale, non toglie il posto a nessuno.
        v_stato := 'ammessa';

      ELSIF v_riga.stato_adesione = 'ammessa' THEN
        -- ⚠️ DECISIONE ESPLICITA DEL COMMITTENTE. Chi ha GIÀ il posto e prova ad
        -- alzare il numero oltre la capienza NON lo perde: si rifiuta la
        -- modifica e non si tocca NIENTE della riga — né lo stato, né il numero,
        -- né `letto_il`. Nessuna famiglia deve poter uscire dalla gita per aver
        -- provato a portare la nonna.
        RETURN jsonb_build_object(
          'ok', false, 'code', 'POSTI_ESAURITI',
          'occupati', v_occupati, 'posti_totali', v_avviso.posti_totali,
          'richiesti', v_richiesti,
          'stato', v_riga.stato_adesione, 'numero', v_riga.numero_partecipanti
        );

      ELSE
        -- In coda PER INTERO, mai spezzata: 2 posti liberi e una famiglia da 4
        -- fanno quattro persone in lista d'attesa, non due dentro e due fuori.
        v_stato := 'in_attesa';
      END IF;
    END IF;

  -- p_risposta IS NULL → sola presa visione: lo stato resta quello che era.
  END IF;

  -- Le due marche temporali si scrivono solo alla TRANSIZIONE. `in_coda_dal` in
  -- particolare regge l'ordine d'arrivo: riscriverlo a ogni correzione del
  -- numero rimanderebbe in fondo alla coda chi aspetta da ieri.
  IF v_stato = 'in_attesa' AND v_riga.stato_adesione IS DISTINCT FROM 'in_attesa' THEN
    v_in_coda := v_ora;
  END IF;
  IF v_stato = 'ammessa' AND v_riga.stato_adesione IS DISTINCT FROM 'ammessa' THEN
    v_assegnato := v_ora;
  END IF;

  -- 7. L'UPSERT, sul vincolo unico storico (avviso_id, parent_id, student_id).
  INSERT INTO public.avvisi_risposte (
    avviso_id, parent_id, student_id,
    letto_il, risposta, risposto_il,
    numero_partecipanti, stato_adesione, in_coda_dal, posto_assegnato_il
  ) VALUES (
    p_avviso_id, p_parent_id, p_student_id,
    v_letto, v_risposta, v_risposto,
    v_numero, v_stato, v_in_coda, v_assegnato
  )
  ON CONFLICT (avviso_id, parent_id, student_id) DO UPDATE
    SET letto_il            = EXCLUDED.letto_il,
        risposta            = EXCLUDED.risposta,
        risposto_il         = EXCLUDED.risposto_il,
        numero_partecipanti = EXCLUDED.numero_partecipanti,
        stato_adesione      = EXCLUDED.stato_adesione,
        in_coda_dal         = EXCLUDED.in_coda_dal,
        posto_assegnato_il  = EXCLUDED.posto_assegnato_il
  RETURNING * INTO v_out;

  -- 8. I DUE FATTI CHE SOLO QUI SI POSSONO SAPERE: «ho liberato posti» e «c'è
  --    gente in coda». Servono alla notifica `posti_liberati` della segreteria
  --    (decisione n. 28 del committente), e si calcolano DOPO la scrittura e
  --    DENTRO lo stesso lock su `avvisi` che ha serializzato tutto il resto.
  --
  --    🔴 PERCHÉ NON IN TYPESCRIPT. La route può contare la coda con una query
  --    sua, ma quella query gira DOPO il commit e fuori dal lock: fra la
  --    scrittura e il conteggio ci sta un'altra adesione, e il numero letto non
  --    è più quello che questa chiamata ha prodotto. È la stessa forma che la
  --    migrazione esiste per chiudere (il riquadro «LA CONCORRENZA», e prima
  --    ancora `varia_saldo_ticket`): un numero letto su uno snapshot diverso da
  --    quello su cui si è deciso non è una misura, è una coincidenza.
  --
  --    `posti_liberati` si conta in PERSONE, come `avviso_posti_occupati`, e
  --    vale per ENTRAMBE le strade che liberano: il ritiro (`'no'` su una riga
  --    ammessa → 4 persone liberate) e la RIDUZIONE del numero di chi resta
  --    ammesso (da 4 a 2 → 2 liberate). `GREATEST(…, 0)` perché chi AUMENTA o
  --    entra da zero non libera niente: quello è un occupato in più, non un
  --    numero negativo da far viaggiare fino a una notifica.
  v_prima_persone := CASE WHEN v_riga.stato_adesione = 'ammessa'
                          THEN COALESCE(v_riga.numero_partecipanti, 1) ELSE 0 END;
  v_dopo_persone  := CASE WHEN v_out.stato_adesione = 'ammessa'
                          THEN COALESCE(v_out.numero_partecipanti, 1) ELSE 0 END;
  v_liberati := GREATEST(v_prima_persone - v_dopo_persone, 0);

  -- La coda si conta SEMPRE, anche quando non si è liberato niente: è un
  -- `count(*)` che il database risolve da sé e che torna un INTERO — nessuna
  -- riga di anagrafica di minori attraversa il confine per far sapere un numero.
  SELECT count(*)::integer INTO v_in_attesa
    FROM public.avvisi_risposte r
   WHERE r.avviso_id = p_avviso_id
     AND r.stato_adesione = 'in_attesa';

  RETURN jsonb_build_object(
    'ok',             true,
    'stato',          v_out.stato_adesione,
    'numero',         v_out.numero_partecipanti,
    'prima_lettura',  v_prima_lettura,
    'prima_risposta', v_prima_risposta,
    'posti_liberati', v_liberati,
    'in_attesa',      v_in_attesa,
    'riga',           to_jsonb(v_out)
  );
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- I CODICI DELLE DUE RPC → IL CATALOGO DELL'APPLICAZIONE
-- (`CODICI_ERRORE` in src/lib/ui/esito-fetch.ts). Vale per ENTRAMBE le funzioni.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Questa tabella sta qui perché senza di lei chi scrive la route deve INDOVINARE
-- la corrispondenza — e su una voce indovinerebbe male, con la famiglia sbagliata
-- che legge la frase sbagliata.
--
--   RPC                        catalogo applicativo                     HTTP
--   ─────────────────────────  ───────────────────────────────────────  ────
--   TERMINE_SCADUTO            ADESIONE_SCADUTA                          409
--   RISPOSTA_INESISTENTE       RISPOSTA_NON_DELLAVVISO                   404
--   NUMERO_RICHIESTO           NUMERO_PARTECIPANTI_RICHIESTO             400
--   NUMERO_FUORI_INTERVALLO    NUMERO_PARTECIPANTI_FUORI_INTERVALLO      400
--   POSTI_ESAURITI             POSTI_ESAURITI  ← 🔴 NO, vedi sotto       409
--   AVVISO_INESISTENTE         — non esiste nel catalogo —               404
--   RISPOSTA_NON_VALIDA        — non esiste — (400 di validazione)       400
--   STATO_NON_VALIDO           — non esiste — (idem, lato segreteria)    400
--   RISPOSTA_CONTRARIA         — non esiste — (conferma, non errore)     409
--   ISOLAMENTO_NON_SUPPORTATO  — non esiste — (degrado, non un rifiuto   503
--                                 di merito: ADESIONI_NON_DISPONIBILI)
--
-- 🔴 `POSTI_ESAURITI` DELLA RPC ≠ `POSTI_ESAURITI` DEL CATALOGO, e i due nomi
-- uguali sono una trappola, non una comodità. Il catalogo lo descrive come «il
-- tetto non lascia spazio per questa adesione, e la lista d'attesa non fa parte
-- di questa risposta». Ma questa RPC a chi non ha posto NON lo restituisce mai:
-- quel genitore va in coda con `ok:true, stato:'in_attesa'`. L'unico caso in cui
-- la RPC lo restituisce è **chi è GIÀ AMMESSO e non riesce ad aumentare il
-- numero**. Se la route mappa i due nomi uguali, una famiglia che è DENTRO legge
-- «posti esauriti»: le viene detto che è fuori proprio mentre il sistema la sta
-- tenendo dentro. La route non deve riusare la stessa stringa per i due casi — il
-- caso della RPC è «sei già ammesso e l'aumento non ci sta», e va detto così.
--
-- 📬 CONSEGNA AL CANTIERE DI `esito-fetch.ts` (non è questo: quel file è di un
-- altro cantiere e qui non si tocca). Servono TRE codici nuovi nel catalogo:
--   · `AVVISO_NON_TROVATO` — 404, per `AVVISO_INESISTENTE`. Oggi non c'è, e
--     riusare `RISPOSTA_NON_DELLAVVISO` direbbe una cosa falsa (la risposta non
--     c'entra: manca l'avviso).
--   · un 400 di validazione per `RISPOSTA_NON_VALIDA` / `STATO_NON_VALIDO`. Sono
--     due sbagli del CLIENT su un enum chiuso, non due situazioni diverse per chi
--     legge: un codice solo basta, e la differenza vive nel log.
--   · 🆕 `RISPOSTA_CONTRARIA` — 409, e **NON è un errore: è una domanda**. La
--     riga dice che la famiglia aveva rifiutato, e la RPC si ferma invece di
--     riscriverle il «no». Il messaggio non deve dire «operazione fallita» ma
--     chiedere: «questa famiglia aveva risposto NO il <risposto_il>. Confermi
--     l'ammissione? La sua risposta verrà sostituita con SÌ». Solo dopo un sì
--     esplicito la route richiama la RPC con `p_ignora_rifiuto := true`.
--     ⚠️ La spunta di conferma NON si manda mai come `null`: o `true` o la si
--     omette. La RPC si difende con `COALESCE`, ma il `{"p_forza": null}` di un
--     form vuoto è esattamente il difetto che questo file ha già dovuto chiudere
--     due volte, e la seconda riga di difesa è che il client non lo produca.
-- Finché non esistono, la route li traduca a mano e NON li mappi su codici
-- esistenti che dicono altro.
COMMENT ON FUNCTION public.avviso_adesione_registra(uuid, uuid, uuid, text, smallint, timestamptz) IS
  'Presa visione e adesione di un genitore, serializzate sul lock di avvisi: termine, numero, tetto dei posti in persone e lista d''attesa in un''unica transazione. Ritorna {ok, code?, stato, numero, prima_lettura, prima_risposta, posti_liberati, in_attesa, riga}. posti_liberati = PERSONE che questa chiamata ha rilasciato (ritiro o riduzione del numero; 0 quando nessuna); in_attesa = count(*) delle righe in_attesa dell''avviso. Entrambi calcolati DOPO la scrittura e DENTRO lo stesso lock, perche'' la notifica posti_liberati alla segreteria non si regga su un conteggio preso fuori.';

REVOKE ALL ON FUNCTION public.avviso_adesione_registra(uuid, uuid, uuid, text, smallint, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.avviso_adesione_registra(uuid, uuid, uuid, text, smallint, timestamptz) TO service_role;


-- ── 8b. La segreteria ───────────────────────────────────────────────────────
--
-- Ammissione dalla coda E correzione del numero nella STESSA funzione, sotto lo
-- stesso lock, perché condividono l'invariante: entrambe cambiano quante persone
-- risultano dentro. Separarle significherebbe due funzioni che si misurano a
-- vicenda senza vedersi.
--
-- ⚠️ LA RIGA SI CERCA CON `id = p_risposta_id AND avviso_id = p_avviso_id`.
-- Senza quell'`AND`, una segreteria di Giugliano potrebbe ammettere PER ID una
-- risposta di Aversa: l'uuid della risposta è l'unica cosa che serve, e nessun
-- gate applicativo a monte se ne accorgerebbe, perché il gate controlla l'avviso
-- e la scrittura andrebbe sulla riga di un altro plesso. Tre sedi, un solo
-- database: la clausola è il confine.
--
-- NESSUNA PROMOZIONE AUTOMATICA. Questa funzione non guarda mai la coda da sé e
-- non fa entrare nessuno «perché si è liberato un posto»: chi entra lo decide una
-- persona. Un automatismo qui manderebbe email di ammissione nel cuore della
-- notte a famiglie che nel frattempo hanno già organizzato altro.
-- ⚠️ E la regola vale sulle DUE strade, non solo su questa: la promessa «promuove
-- solo la segreteria» è una promessa vuota se il genitore può auto-promuoversi
-- ripetendo `'si'` al momento giusto. Il ramo che lo impedisce sta in
-- `avviso_adesione_registra`, sotto `IF v_riga.stato_adesione = 'in_attesa'`.
-- 🔻 E arriva fin lì, non oltre: ferma il `'si'` RIPETUTO, non `'no'` seguito da
-- `'si'`, che un posto libero se lo prende. È voluto — chi si ritira perde il
-- posto in fila e in coda rientra dal fondo — ma va letto come una promessa
-- limitata, non come una coda inespugnabile: il ragionamento per intero sta
-- accanto a quel ramo.
--
-- IL TERMINE NON SI CONTROLLA. È il contrario della strada del genitore ed è
-- voluto: gestire la coda DOPO la scadenza è precisamente il mestiere di questa
-- funzione — qualcuno rinuncia il giorno prima e il primo della lista entra.
--
-- ── I TRE VALORI DI `p_stato`, E PERCHÉ «TOGLIERE» NE È UNO E NON UN SECONDO
--    PARAMETRO ──────────────────────────────────────────────────────────────
--
--   NULL         → «non parlo dello stato»: lo stato resta quello che era. Questo
--                  significato è PORTANTE (è il caso della sola correzione del
--                  numero) e non si può sovraccaricare con un secondo senso.
--   'ammessa'    → dentro, occupa posti.
--   'in_attesa'  → in coda.
--   'nessuna'    → 🆕 FUORI: `stato_adesione` torna a NULL e il posto si libera.
--
-- `'nessuna'` È UN VALORE DEL PARAMETRO, MAI UN VALORE DELLA COLONNA. In
-- `avvisi_risposte.stato_adesione` restano soltanto `NULL | 'ammessa' |
-- 'in_attesa'`, e il `CHECK` della § 5 non cambia di una virgola. Chi prova a
-- scriverlo in tabella trova il vincolo.
--
-- PERCHÉ UN QUARTO VALORE E NON UN `p_rimuovi boolean`: lo stato è UN campo, e un
-- booleano ortogonale creerebbe la combinazione `p_stato='ammessa', p_rimuovi=true`
-- — due istruzioni contrarie nella stessa chiamata, che qualcuno dovrebbe
-- arbitrare e qualcun altro indovinare. Un enum chiuso su un solo parametro non ha
-- nessuna combinazione contraddittoria da arbitrare. È la stessa ragione per cui
-- più sotto si ALLINEA `risposta` invece di tenere due verità sulla stessa riga.
-- E `NULL` non poteva significare «togli» perché significa già «non toccare»:
-- «non detto» e «detto: nessuno» sono due cose diverse e servono due parole.
--
-- PRIMA DI QUESTA VOCE LA SEGRETERIA NON POTEVA TOGLIERE NESSUNO. Né chi avesse
-- ammesso per sbaglio, né chi si fosse ritirato al telefono: l'unico che poteva
-- rimediare era la FAMIGLIA, ricollegandosi e ripremendo «no», e fino ad allora
-- risultava iscritta a una gita rifiutata **occupando un posto**. Una scrittura
-- senza strada di ritorno su un dato di una famiglia non è accettabile, e con
-- l'allineamento di `risposta` qui sotto quella mancanza diventava acuta.
--
-- 🔻 CHE COSA **NON** TOCCA `'nessuna'`, e perché — la parte che non si deduce
--    dal codice e va letta qui:
--   · `risposta` NON si tocca. Togliere qualcuno è un atto della SEGRETERIA sullo
--     STATO; la risposta è della famiglia. Riscriverla a `'no'` metterebbe in bocca
--     a una famiglia una frase che non ha detto — esattamente il difetto che il
--     rifiuto `RISPOSTA_CONTRARIA` qui sotto esiste per impedire, applicato
--     all'incontrario. Se la famiglia aveva detto `'si'`, quel `'si'` è un fatto
--     storico vero e resta; a cambiarlo è lei, da `avviso_adesione_registra`.
--   · `in_coda_dal` e `posto_assegnato_il` NON si azzerano. Sono MARCHE DI
--     TRANSIZIONE («è entrato in coda il…», «il posto gli è stato assegnato il…»,
--     vedi i loro `COMMENT ON COLUMN`), non campi di stato corrente: nessun
--     conteggio e nessun elenco le legge per una riga che è fuori, perché tutto
--     filtra su `stato_adesione`. Azzerarle SOLO qui darebbe alla rimozione fatta
--     dalla segreteria una memoria diversa da quella fatta dal genitore col
--     proprio «no» (che oggi le lascia intatte, § 8a): lo stesso atto dalle due
--     parti non può ricordare due cose diverse.
--     E non servono da scorciatoia per rientrare in testa alla coda: chi torna
--     dentro passa da una transizione, e le due guardie `IS DISTINCT FROM` più
--     sotto riscrivono ENTRAMBE le marche con l'istante di adesso (NULL è distinto
--     sia da `'in_attesa'` sia da `'ammessa'`). Il costo dichiarato è che una
--     schermata che mostrasse `in_coda_dal` senza guardare lo stato leggerebbe una
--     marca vecchia su una riga fuori: si guarda lo stato.
--   · ⚠️ CONSEGUENZA SUL CONTEGGIO DELLA FINESTRA merge→deploy: una riga tolta
--     dalla segreteria che aveva risposto `'si'` ha esattamente la forma
--     `risposta='si' AND stato_adesione IS NULL` della query di riconciliazione in
--     testa al file. Dopo il deploy quel conteggio contiene DUE cose: i residui da
--     riconciliare **e** le rimozioni deliberate. Vedi la nota lì.
--
-- 🔴 IL `DROP` PRIMA DEL `CREATE OR REPLACE` NON È DECORATIVO. `CREATE OR REPLACE
-- FUNCTION` identifica la funzione per NOME **e TIPI DEGLI ARGOMENTI**: aggiungere
-- `p_ignora_rifiuto` non sostituisce la versione a sei parametri, ne crea una
-- SECONDA accanto. E siccome entrambe hanno un default per tutto ciò che PostgREST
-- non manda, una chiamata per nome le troverebbe tutte e due e fallirebbe con
-- `PGRST203` (ambiguous function) — un guasto totale della segreteria, con lo
-- schema apparentemente a posto. Oggi la a-sei-parametri non esiste da nessuna
-- parte (questo file non è mai stato applicato, vedi il riquadro in testa), quindi
-- il `DROP IF EXISTS` è un no-op: è la rete per chi avesse applicato a mano una
-- bozza precedente, e mantiene la migrazione idempotente anche riapplicata.
DROP FUNCTION IF EXISTS public.avviso_adesione_gestisci(uuid, uuid, text, smallint, boolean, timestamptz);

CREATE OR REPLACE FUNCTION public.avviso_adesione_gestisci(
  p_avviso_id       uuid,
  p_risposta_id     uuid,
  p_stato           text        DEFAULT NULL,
  p_numero          smallint    DEFAULT NULL,
  p_forza           boolean     DEFAULT false,
  p_ignora_rifiuto  boolean     DEFAULT false,
  p_ora             timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ora       timestamptz := COALESCE(p_ora, now());
  v_avviso    record;
  v_riga      public.avvisi_risposte;
  v_stato     text;
  v_numero    smallint;
  v_richiesti integer;
  -- `NULL` e non `0`: il conteggio gira SOLO dentro il ramo della capienza
  -- (`v_stato = 'ammessa'` e un tetto che esiste). Con `:= 0`, un'ammissione senza
  -- tetto, una rimessa in coda o una rimozione tornavano `occupati: 0` — uno zero
  -- NON MISURATO che il chiamante non distingue da uno zero contato. È la forma del
  -- `?? 0` che in questo repo ha congelato per sempre lo stato SDI di una fattura:
  -- scritto lo zero, esce per sempre. Con `NULL` il JSON dice `null` e chi legge sa
  -- che non è stato contato, senza rinunciare a non contare dentro il lock.
  v_occupati  integer;
  v_in_coda   timestamptz;
  v_assegnato timestamptz;
  v_sopra     boolean := false;
  v_risposta  text;
  v_risposto  timestamptz;
  v_allineata boolean := false;
  v_giu       boolean := false;
  v_tocca_stato boolean := false;
  v_out       public.avvisi_risposte;
BEGIN
  -- Stesso rifiuto della strada del genitore, stessa forma: un codice, non un
  -- `RAISE`. Vedi il riquadro «LA CONCORRENZA».
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ISOLAMENTO_NON_SUPPORTATO',
                              'isolamento', current_setting('transaction_isolation'));
  END IF;

  -- `'nessuna'` è il valore che TOGLIE (vedi il riquadro dei tre valori sopra):
  -- entra dalla validazione come gli altri due, ma non finisce mai in tabella.
  IF p_stato IS NOT NULL AND p_stato NOT IN ('ammessa', 'in_attesa', 'nessuna') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'STATO_NON_VALIDO');
  END IF;

  -- Primo lock: il padre. Stesso ordine della strada del genitore, o deadlock.
  SELECT a.id, a.chiedi_numero, a.numero_min, a.numero_max, a.posti_totali
    INTO v_avviso
    FROM public.avvisi a
   WHERE a.id = p_avviso_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AVVISO_INESISTENTE');
  END IF;

  -- Secondo lock: la riga, e SOLO se appartiene a questo avviso.
  SELECT r.* INTO v_riga
    FROM public.avvisi_risposte r
   WHERE r.id        = p_risposta_id
     AND r.avviso_id = p_avviso_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'RISPOSTA_INESISTENTE');
  END IF;

  -- `'nessuna'` → NULL, cioè FUORI, e il posto si libera da solo (solo `ammessa`
  -- occupa). `IS NOT DISTINCT FROM` e non `=`: con `p_stato` NULL un `=` darebbe
  -- NULL e il `CASE` cadrebbe comunque sull'`ELSE` — cioè il risultato giusto per
  -- la ragione sbagliata. In questo file le condizioni non tornano mai NULL, e
  -- questa non fa eccezione.
  v_stato     := CASE WHEN p_stato IS NOT DISTINCT FROM 'nessuna' THEN NULL
                      ELSE COALESCE(p_stato, v_riga.stato_adesione)
                 END;
  v_in_coda   := v_riga.in_coda_dal;
  v_assegnato := v_riga.posto_assegnato_il;

  -- 🔑 IL GESTO CHE ALLINEA (e che quindi può distruggere un «no»): «la segreteria
  -- NOMINA uno stato in questa chiamata **e** quello stato mette la riga DENTRO».
  -- Non «la riga uno stato ce l'ha già»: prima questa condizione era
  -- `v_stato IS NOT NULL`, e siccome `v_stato` eredita da `COALESCE`, una semplice
  -- correzione del NUMERO su una riga già ammessa faceva scattare l'allineamento.
  -- Un gesto che non parlava della risposta la riscriveva lo stesso.
  -- La seconda metà (`v_stato IS NOT NULL`) esclude `'nessuna'`: togliere qualcuno
  -- non lo mette dentro, quindi non c'è niente da allineare.
  -- Un solo booleano per il rifiuto e per l'allineamento, perché le due condizioni
  -- devono essere LA STESSA: scritte due volte, un giorno divergono.
  v_tocca_stato := p_stato IS NOT NULL AND v_stato IS NOT NULL;

  -- 🔴 STESSA REGOLA DELLA STRADA DEL GENITORE: con `chiedi_numero` spento il
  -- numero NON è un campo governato, quindi si CONSERVA quello già raccolto e non
  -- se ne accetta uno nuovo. Il controllo d'intervallo qui sotto è condizionato a
  -- `chiedi_numero` esattamente come là, e senza questa distinzione un `p_numero`
  -- arbitrario entrava senza alcun controllo e occupava posti contro
  -- `posti_totali` — l'unica rete essendo il `CHECK (… BETWEEN 1 AND 999)`.
  -- La segreteria se ne accorge: la funzione ritorna `numero` letto dalla riga
  -- SCRITTA, quindi il valore ignorato non le torna indietro come se fosse stato
  -- accettato. Per governare quel numero si riaccende la bandierina sull'avviso,
  -- che è il posto dove quella decisione si prende.
  v_numero := CASE WHEN v_avviso.chiedi_numero
                   THEN COALESCE(p_numero, v_riga.numero_partecipanti)
                   ELSE v_riga.numero_partecipanti
              END;

  -- L'intervallo si fa valere solo se l'avviso lo dichiara: su un avviso senza
  -- `chiedi_numero` il numero è un dato storico, non un campo governato.
  IF p_numero IS NOT NULL AND v_avviso.chiedi_numero
     AND (p_numero < v_avviso.numero_min OR p_numero > v_avviso.numero_max) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NUMERO_FUORI_INTERVALLO',
                              'numero_min', v_avviso.numero_min,
                              'numero_max', v_avviso.numero_max);
  END IF;

  IF v_stato = 'ammessa' AND v_avviso.posti_totali IS NOT NULL THEN
    v_richiesti := COALESCE(v_numero, 1);
    v_occupati  := public.avviso_posti_occupati(p_avviso_id, v_riga.id);

    -- Un cambio NON CRESCENTE su chi è GIÀ ammesso non può peggiorare la
    -- capienza: stessa ragione della strada del genitore. Capita quando il tetto
    -- è stato abbassato sotto l'occupato (permesso) — tetto 10, occupati 11, e la
    -- segreteria porta una famiglia da 4 a 2. Chiederle `p_forza` per una
    -- RIDUZIONE sarebbe un attrito al contrario: il gesto che avvicina al tetto
    -- verrebbe trattato come quello che lo sfonda.
    -- ⚠️ `IS NOT DISTINCT FROM` e non `=`: su una riga con `stato_adesione` NULL
    -- un `=` darebbe NULL, `NOT NULL` è NULL, e un `IF` con condizione NULL NON
    -- SCATTA — cioè il rifiuto per capienza sparirebbe in silenzio proprio sulle
    -- righe che non sono ancora dentro. Questa forma non torna mai NULL.
    v_giu := v_riga.stato_adesione IS NOT DISTINCT FROM 'ammessa'
             AND v_richiesti <= COALESCE(v_riga.numero_partecipanti, 1);

    IF v_occupati + v_richiesti > v_avviso.posti_totali THEN
      -- ⚠️ `COALESCE` e non `NOT p_forza` nudo: `DEFAULT false` vale se il parametro
      -- NON viene passato, non se arriva esplicitamente a NULL — ed è ciò che manda
      -- PostgREST con `{"p_forza": null}`, cioè una spunta facoltativa lasciata vuota.
      -- `NOT NULL AND NOT false` è NULL, e un IF con condizione NULL NON SCATTA: il
      -- rifiuto per capienza sparirebbe e si scriverebbe sopra il tetto senza che
      -- nessuno l'abbia chiesto — con `sopra_capienza: true` mostrato all'operatore
      -- come se la scelta fosse stata sua. Stessa trappola di `v_giu` qui sopra, un
      -- IF più su, e stessa forma del guasto di `varia_saldo_ticket`: nessun errore,
      -- nessun log, e il numero che si guarda sembra a posto.
      -- Verificato dal database, non ricordato:
      --   SELECT ((NOT NULL::boolean) AND (NOT false)) IS NULL;          -- → true
      --   SELECT (NOT COALESCE(NULL::boolean,false)) AND (NOT false);    -- → true
      IF NOT COALESCE(p_forza, false) AND NOT v_giu THEN
        -- Qui il lettore è la SEGRETERIA, non una famiglia: la decisione le
        -- promette la segnalazione di capienza, con i numeri, perché è lei a
        -- dover scegliere se forzare.
        RETURN jsonb_build_object(
          'ok', false, 'code', 'POSTI_ESAURITI',
          'occupati', v_occupati, 'posti_totali', v_avviso.posti_totali,
          'richiesti', v_richiesti
        );
      END IF;
      -- Si è sopra capienza e si scrive comunque — per `p_forza` o perché il
      -- cambio scende. In entrambi i casi lo si DICE: `sopra_capienza` è ciò che
      -- l'interfaccia mostra accanto al conteggio, e resta vero anche dopo una
      -- riduzione che sopra il tetto ci lascia lo stesso.
      v_sopra := true;
    END IF;
  END IF;

  -- ── 🔴 LE DUE VERITÀ SULLA STESSA RIGA, E COME SI CHIUDONO ─────────────────
  --
  -- `v_stato` non guardava `v_riga.risposta`: la segreteria poteva ammettere una
  -- riga che dice `risposta = 'no'`, e la riga finiva con `risposta='no'` **e**
  -- `stato_adesione='ammessa'`. Quella riga occupa un posto per
  -- `avviso_posti_occupati` (che guarda solo lo stato) e NON compare in nessun
  -- elenco filtrato su `risposta='si'`: due verità sullo stesso record, che è la
  -- forma esatta del difetto che questo file esiste per chiudere.
  --
  -- SCELTA: SI ALLINEA LA RISPOSTA, e lo si dichiara al chiamante.
  -- `stato_adesione` non NULL SIGNIFICA «questa famiglia è dentro»; l'unica
  -- `risposta` coerente con quel significato è `'si'`. Quindi quando la segreteria
  -- METTE O CAMBIA uno stato che porta dentro, su una riga che non dice già `'si'`,
  -- la risposta ci viene portata e `risposto_il` prende l'istante di ADESSO —
  -- perché è adesso che quell'adesione è stata registrata, ed è questo che è
  -- successo davvero: la famiglia ha cambiato idea al telefono e la segreteria
  -- l'ha scritto.
  --   · Su `risposta IS NULL` l'allineamento resta SILENZIOSO, ed è il caso in cui
  --     non si perde niente: è il modo in cui si recuperano le righe scritte dal
  --     codice vecchio nella finestra merge→deploy (vedi «CHE COSA NON FA» in testa
  --     al file), che una risposta non ce l'hanno proprio.
  --   · Le righe che dicono già `'si'` non vengono toccate: `risposto_il`
  --     conserva l'istante in cui la famiglia ha risposto davvero. È il caso
  --     normale — l'ammissione dalla coda — e deve restare a costo zero.
  --   · 🔴 SU `risposta = 'no'` SI RIFIUTA, e non si riscrive niente. Il «no» di una
  --     famiglia e l'istante in cui l'aveva espresso sono un dato suo: sovrascriverli
  --     li faceva sparire DAL DATABASE — sopravvivevano solo dentro il JSON di
  --     quella singola chiamata, cioè da nessuna parte. **Mostrare non è
  --     conservare.** Il rifiuto porta il codice `RISPOSTA_CONTRARIA` e restituisce
  --     il valore trovato, così l'interfaccia può chiedere «questa famiglia aveva
  --     rifiutato: confermi?» — lo standard che questo repo applica ovunque — e
  --     ripresentarsi con `p_ignora_rifiuto := true`. La riscrittura avviene SOLO
  --     dopo quel gesto deliberato.
  --   · `risposta_allineata` + `risposta_precedente` tornano al chiamante perché
  --     l'interfaccia lo MOSTRI: una risposta riscritta in silenzio sarebbe il
  --     rimedio peggiore della malattia. Sono `'si'`/`'no'`/`null`, non un dato
  --     personale.
  --   · E la strada del ritorno esiste: `p_stato := 'nessuna'` toglie l'adesione e
  --     libera il posto senza toccare `risposta`. Prima non c'era, e un'ammissione
  --     per sbaglio poteva disfarla solo la famiglia.
  -- L'alternativa scartata — tenere le due colonne in disaccordo e limitarsi a un
  -- flag — lasciava il disaccordo nel DATABASE, dove lo trova anche chi non passa
  -- da questa funzione: un `count` e un elenco che non tornano, e nessuno che
  -- sappia quale dei due ha ragione.
  --
  -- ⚠️ ORDINE: il controllo di capienza è GIÀ passato qui sopra. Su un avviso pieno
  -- la segreteria vede prima `POSTI_ESAURITI` e solo dopo, forzando, il
  -- `RISPOSTA_CONTRARIA`: due conferme in fila, perché sono due decisioni diverse
  -- (sfondare il tetto / riscrivere il no di una famiglia) e nessuna delle due deve
  -- poter passare dentro l'altra.
  IF v_tocca_stato
     AND v_riga.risposta IS NOT DISTINCT FROM 'no'
     AND NOT COALESCE(p_ignora_rifiuto, false) THEN
    -- `IS NOT DISTINCT FROM` e `COALESCE` per la stessa ragione di `p_forza` più
    -- sopra: qui una condizione NULL non rifiuterebbe, e il «no» verrebbe riscritto
    -- proprio nel caso che questo ramo esiste per proteggere.
    RETURN jsonb_build_object('ok', false, 'code', 'RISPOSTA_CONTRARIA',
                              'risposta_precedente', v_riga.risposta);
  END IF;

  v_risposta := v_riga.risposta;
  v_risposto := v_riga.risposto_il;
  IF v_tocca_stato AND v_riga.risposta IS DISTINCT FROM 'si' THEN
    v_risposta  := 'si';
    v_risposto  := v_ora;
    v_allineata := true;
  END IF;

  IF v_stato = 'in_attesa' AND v_riga.stato_adesione IS DISTINCT FROM 'in_attesa' THEN
    v_in_coda := v_ora;
  END IF;
  IF v_stato = 'ammessa' AND v_riga.stato_adesione IS DISTINCT FROM 'ammessa' THEN
    v_assegnato := v_ora;
  END IF;

  UPDATE public.avvisi_risposte r
     SET stato_adesione      = v_stato,
         numero_partecipanti = v_numero,
         in_coda_dal         = v_in_coda,
         posto_assegnato_il  = v_assegnato,
         risposta            = v_risposta,
         risposto_il         = v_risposto
   WHERE r.id = v_riga.id
  RETURNING r.* INTO v_out;

  RETURN jsonb_build_object(
    'ok',                  true,
    'stato',               v_out.stato_adesione,
    'numero',              v_out.numero_partecipanti,
    'occupati',            v_occupati,
    'posti_totali',        v_avviso.posti_totali,
    'sopra_capienza',      v_sopra,
    'risposta_allineata',  v_allineata,
    'risposta_precedente', v_riga.risposta,
    'riga',                to_jsonb(v_out)
  );
END;
$$;

-- ⚠️ I TRE NOMI QUI SOTTO RIPETONO I TIPI DEI PARAMETRI, e con la firma cambiata
-- vanno cambiati TUTTI E TRE. Un `REVOKE`/`GRANT` rimasto sulla vecchia firma non
-- dà errore: si applica a una funzione che non esiste più (e se esistesse, alla
-- funzione SBAGLIATA), e quella nuova resterebbe con i permessi di default —
-- `EXECUTE` a PUBLIC su una `SECURITY DEFINER`, cioè eseguibile da chiunque abbia
-- un token `anon`. Il silenzio di un GRANT non aggiornato è il modo più discreto
-- che ha una funzione di diventare pubblica.
COMMENT ON FUNCTION public.avviso_adesione_gestisci(uuid, uuid, text, smallint, boolean, boolean, timestamptz) IS
  'Lato segreteria: ammissione dalla coda, correzione del numero e RIMOZIONE (p_stato = "nessuna", che porta stato_adesione a NULL e libera il posto senza toccare risposta) sotto lo stesso lock di avvisi. La riga si cerca per id AND avviso_id (confine fra le sedi). Non promuove mai nessuno da sé. Mettere o cambiare uno stato che porta DENTRO, su una riga che non dice gia "si", ALLINEA anche risposta/risposto_il e lo dichiara con risposta_allineata; se quella riga dice "no" l''operazione e RIFIUTATA con RISPOSTA_CONTRARIA finche il chiamante non ripassa con p_ignora_rifiuto. Ritorna {ok, code?, stato, numero, occupati, posti_totali, sopra_capienza, risposta_allineata, risposta_precedente, riga}. ATTENZIONE a "occupati": e NULL quando il conteggio non e stato fatto (nessun tetto, rimessa in coda, rimozione), perche il calcolo gira solo dentro il ramo della capienza. NULL vuol dire NON MISURATO, non zero: chi lo mostra non lo scriva come 0.';

REVOKE ALL ON FUNCTION public.avviso_adesione_gestisci(uuid, uuid, text, smallint, boolean, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.avviso_adesione_gestisci(uuid, uuid, text, smallint, boolean, boolean, timestamptz) TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 9. LA CONFIGURAZIONE DI SEDE — il promemoria, e i due gemelli insieme
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ GEMELLO TypeScript: `DEFAULT_AVVISI_CONFIG` in
-- src/lib/scuole/admin-settings-default.ts, confrontato CARATTERE PER CARATTERE
-- dal lock `__tests__/architecture/provisiona-sede-default-gemello.test.ts`, che
-- risolve da sé l'ULTIMA definizione di questa funzione — cioè questa.
--
-- PERCHÉ `promemoria_giorni_prima` ENTRA nel database mentre le altre tre chiavi
-- della schermata (`allegati_max_mb`, `scadenza_default_giorni`,
-- `conferma_lettura_abilitata`) restano fuori: perché ha un EFFETTO SERVER. È il
-- cron dei promemoria a leggerla, non un componente. Le chiavi senza effetto
-- server hanno già il proprio ripiego nell'interfaccia, e scriverle qui le
-- congelerebbe alla data della migrazione facendole divergere in silenzio da
-- quelle mostrate in Impostazioni. La regola non cambia: si scrive ciò che il
-- server legge. Cambia il numero delle chiavi che lo soddisfano — da una a due.
--
-- `provisiona_corredo_sede` NON si tocca: chiama già `avvisi_config_default()`,
-- quindi la sede numero quattro nasce col valore nuovo senza altre modifiche.
CREATE OR REPLACE FUNCTION public.avvisi_config_default() RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
AS $$
  SELECT '{"ruoli_pubblicazione": ["admin", "teacher"], "promemoria_giorni_prima": 3}'::jsonb;
$$;

COMMENT ON FUNCTION public.avvisi_config_default() IS
  'Configurazione avvisi con cui nasce una sede: chi pubblica, e quanti giorni prima parte il promemoria (gemella di DEFAULT_AVVISI_CONFIG in src/lib/scuole/admin-settings-default.ts).';

REVOKE ALL ON FUNCTION public.avvisi_config_default() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.avvisi_config_default() TO service_role;

-- IL RECUPERO DELLE SEDI GIÀ ESISTENTI. `provisiona_corredo_sede` non le ripara:
-- la sua INSERT ha `ON CONFLICT DO NOTHING` (la riga c'è già) e il suo UPDATE
-- agisce solo dove manca `ruoli_pubblicazione` — che al 2026-09-19 su tutte e
-- quattro le righe di `admin_settings` c'è. Senza questo UPDATE la chiave nuova
-- servirebbe solo alla sede numero quattro, mentre le sedi di oggi sono queste.
--
-- Si aggiunge SOLO la chiave mancante, fondendo con ciò che c'è: una
-- `ruoli_pubblicazione` personalizzata dalla Direzione resta intatta. E per
-- INSIEME, senza nominare nessuna sede (lock `migrazioni-senza-sede-cablata`) —
-- qui non serve nemmeno escludere la sede di collaudo, perché un numero di giorni
-- di promemoria su una sede finta è inerte.
UPDATE public.admin_settings
   SET avvisi_config = COALESCE(avvisi_config, '{}'::jsonb)
                       || jsonb_build_object(
                            'promemoria_giorni_prima',
                            public.avvisi_config_default() -> 'promemoria_giorni_prima'
                          )
 WHERE NOT (COALESCE(avvisi_config, '{}'::jsonb) ? 'promemoria_giorni_prima');


NOTIFY pgrst, 'reload schema';


-- ═════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── I permessi ──────────────────────────────────────────────────────────────
--   select has_function_privilege('authenticated',
--          'public.avviso_adesione_registra(uuid,uuid,uuid,text,smallint,timestamptz)', 'EXECUTE');  -- false
--   select has_function_privilege('anon',
--          'public.avviso_adesione_gestisci(uuid,uuid,text,smallint,boolean,boolean,timestamptz)', 'EXECUTE'); -- false
--   -- E che di `avviso_adesione_gestisci` ce ne sia UNA SOLA: due firme insieme
--   -- fanno fallire ogni chiamata per nome con `PGRST203`.
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'avviso_adesione_gestisci';   -- → 1
--   select has_function_privilege('service_role',
--          'public.avviso_posti_occupati(uuid,uuid)', 'EXECUTE');                                     -- true
--
-- ── Il backfill ─────────────────────────────────────────────────────────────
--   select count(*) from public.avvisi where scadenza_avviso is null;                 -- 0
--   select count(*) from public.avvisi
--    where scadenza is distinct from (scadenza_avviso at time zone 'Europe/Rome')::date;  -- 0
--   select count(*) from public.avvisi where tipo='adesione' and scadenza_adesione is null; -- 0
--   select count(*) from public.admin_settings
--    where not (avvisi_config ? 'promemoria_giorni_prima');                           -- 0
--
-- ── Gli indici parziali NON stanno in `pg_constraint`: si guarda `pg_indexes` ──
--   select indexname from pg_indexes
--    where schemaname='public' and tablename in ('avvisi','avvisi_risposte')
--      and indexname like 'avvisi%idx';
--
-- ═════════════════════════════════════════════════════════════════════════════
-- LA PROVA A DUE SESSIONI — che il tetto dei posti TENGA davvero
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Modellata su quella di 20260907181116. NON è stata eseguita da chi ha scritto
-- questo file: al momento della scrittura la migrazione non era ancora applicata.
-- La esegue il cantiere D2 DOPO il merge e ne incolla l'esito nel PRD.
--
-- Serve un avviso di prova con `posti_totali = 10` e due risposte. Si apre in DUE
-- terminali, `psql "$DATABASE_URL"` ciascuno, e si seguono i tempi.
--
--   -- PREPARAZIONE (una sola volta, terminale qualsiasi). Sostituire :sede con
--   -- una sede vera letta da `schools`, e :autore con un utente di staff.
--   insert into public.avvisi (author_id, titolo, contenuto, tipo, scuola_id,
--                              scadenza_avviso, posti_totali, chiedi_numero,
--                              numero_min, numero_max)
--   values (:autore, 'PROVA capienza', 'prova', 'adesione', :sede,
--           now() + interval '7 days', 10, true, 1, 8)
--   returning id;                                        -- → :avviso
--
--   -- Si porta l'occupato a 8 con una prima famiglia:
--   select public.avviso_adesione_registra(:avviso, :genitore_a, :alunno_a, 'si', 8::smallint);
--   select public.avviso_posti_occupati(:avviso);         -- → 8
--
--   ── SESSIONE A ───────────────────┬─ SESSIONE B ──────────────────────────────
--   begin;                           │
--   select public.avviso_adesione_   │
--     registra(:avviso, :genitore_b, │
--       :alunno_b, 'si', 2::smallint)│
--   -- → ok, stato 'ammessa'         │
--                                    │ begin;
--                                    │ select public.avviso_adesione_
--                                    │   registra(:avviso, :genitore_c,
--                                    │     :alunno_c, 'si', 2::smallint);
--                                    │ -- ⏸ SI BLOCCA sul FOR UPDATE di `avvisi`.
--                                    │ --   È il punto di serializzazione: senza
--                                    │ --   di esso B leggerebbe «occupati 8» e
--                                    │ --   il tetto di 10 diventerebbe 12.
--   commit;                          │
--                                    │ -- ▶ si sblocca, riconta su uno snapshot
--                                    │ --   NUOVO (read committed) e trova 10:
--                                    │ --   → ok, stato 'in_attesa', in_coda_dal
--                                    │ --     valorizzato. PER INTERO, non 0+2.
--                                    │ commit;
--   ────────────────────────────────┴───────────────────────────────────────────
--
--   -- L'ESITO ATTESO, da incollare nel PRD:
--   select public.avviso_posti_occupati(:avviso);         -- → 10, MAI 12
--   select stato_adesione, numero_partecipanti, in_coda_dal is not null
--     from public.avvisi_risposte where avviso_id = :avviso order by 1;
--   -- → ammessa 8 / ammessa 2 / in_attesa 2 con in_coda_dal = true
--
--   -- LA CONTROPROVA, che è la parte che rende la prova una prova: se B NON si
--   -- blocca, o se alla fine l'occupato è 12, il lock non sta serializzando
--   -- niente e il difetto di `varia_saldo_ticket` è tornato.
--
--   -- PULIZIA:
--   delete from public.avvisi_risposte where avviso_id = :avviso;
--   delete from public.avvisi where id = :avviso;
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--   drop trigger if exists trg_avvisi_scadenza_compat on public.avvisi;
--   drop function if exists public.avvisi_scadenza_compat();
--   drop function if exists public.avviso_adesione_gestisci(uuid,uuid,text,smallint,boolean,boolean,timestamptz);
--   drop function if exists public.avviso_adesione_registra(uuid,uuid,uuid,text,smallint,timestamptz);
--   drop function if exists public.avviso_posti_occupati(uuid,uuid);
--   alter table public.avvisi alter column scadenza_avviso drop not null;
--   -- Le colonne NUOVE si lasciano: sono additive e non danno fastidio a nessuno.
--   -- `avvisi_config_default()` torna alla versione precedente riscrivendola con
--   -- la sola chiave `ruoli_pubblicazione`.
--
-- ── 🔴 E POI LE 22 RIGHE, CHE I COMANDI QUI SOPRA NON RIPARANO ──────────────
--
--   Qui prima c'era scritto che «`avvisi.scadenza` non è mai stata persa, quindi
--   il codice vecchio riparte così com'è». **È FALSO**, ed è il motivo per cui
--   questo riquadro è stato riscritto: il backfill della § 4 fa scattare il
--   trigger su ogni riga, e la sua ultima istruzione — incondizionata — scrive
--   una `scadenza` DATATA anche sulle righe che avevano `NULL`. Droppare il
--   trigger non le riporta indietro: a quel punto quei 22 `NULL` sono persi, e
--   per il codice vecchio quegli avvisi hanno una scadenza che nessuno ha mai
--   scritto.
--
--   L'IMMAGINE PRECEDENTE, LETTA PRIMA DELL'APPLICAZIONE (2026-09-19, ore 13:2x
--   UTC). Sono uuid di avvisi e `NULL`: nessun dato di famiglie o di bambini.
--
--     SELECT id, scadenza, created_at FROM public.avvisi
--      WHERE scadenza IS NULL ORDER BY created_at;   -- → 22 righe, scadenza tutte NULL
--
--       created_at (UTC)               id
--       2026-07-17 15:13:09.179173+00  6dbc4c21-79f1-4d9d-b032-07bcae6f4682  ← l'unica che scade subito
--       2026-09-09 12:14:32.513776+00  5876ae02-6267-495b-8557-f265c66de024
--       2026-09-11 14:40:57.612469+00  1c8b0cdd-4f34-458a-a5f5-a55a3ba43a7f
--       2026-09-11 14:46:54.905785+00  d89ba474-3587-4c03-97ee-2b6bdbe74d46
--       2026-09-11 14:54:00.377433+00  caa457ad-b3fd-4f75-a8e6-ce865125b3ce
--       2026-09-14 13:19:45.527694+00  83edbfac-07c4-479a-837d-297abeb96b3a
--       2026-09-14 14:47:59.251022+00  a7546b8a-b417-40ee-8238-ca352ef8ad4b
--       2026-09-14 17:41:35.506322+00  6c52b1ef-a7c4-4f96-88aa-d08ed4ed5618
--       2026-09-14 18:04:07.080706+00  c563b1fc-5162-4144-99c3-788304603f39
--       2026-09-15 06:36:36.348232+00  8fd540e1-0c40-4334-9f7a-3d965051aefa
--       2026-09-15 14:30:25.869955+00  1c08933f-75fe-4f89-bc7b-274c8c6e3f97
--       2026-09-15 14:37:05.239188+00  1ebc5a3e-44c1-4783-9827-c5132ceebc22
--       2026-09-15 14:53:51.389403+00  fe92b15f-5b34-4a18-b7b2-59cf8243d693
--       2026-09-16 11:16:18.730423+00  4280ada9-08a7-497f-b60c-3aa3ca643e26
--       2026-09-16 12:11:08.268466+00  2f12b018-2eae-42d3-b52c-45dfcd8a709d
--       2026-09-16 13:55:58.8353+00    6ef83fd5-6b9f-46d3-80f6-49b8f1b88a16
--       2026-09-17 16:34:46.541405+00  35146b73-6976-4db7-a73b-d08a4a63f681
--       2026-09-17 16:40:12.748492+00  025ecf11-8a3a-48f4-a3b5-5e96b57a26c3
--       2026-09-17 19:05:39.484324+00  081eed22-e545-4c5c-8381-1ef26c48df10
--       2026-09-18 13:32:01.347904+00  6b871bdf-fc0b-4da2-8025-edd0a8e018ab
--       2026-09-19 07:36:37.639568+00  107c346f-836c-4a79-8ac9-294ccbf3c850
--       2026-09-19 08:33:41.196096+00  45715339-147e-495d-a2d6-73addd1c528e
--
--   ⚠️ QUESTO ELENCO È UNA FOTOGRAFIA, non una verità permanente: fra la lettura
--   e il merge la segreteria può pubblicare altri avvisi senza scadenza. Chi
--   applica la migrazione RIFACCIA la SELECT qui sopra subito PRIMA, e usi
--   QUELL'elenco — non questo. Contare e rileggere è una lettura, e le letture
--   non chiedono conferma a nessuno.
--
--   L'istruzione va DOPO il `drop trigger` (prima, il trigger la riscriverebbe
--   in coda partendo da `scadenza_avviso`):
--
--   update public.avvisi set scadenza = null
--    where id = any (array[
--      '6dbc4c21-79f1-4d9d-b032-07bcae6f4682','5876ae02-6267-495b-8557-f265c66de024',
--      '1c8b0cdd-4f34-458a-a5f5-a55a3ba43a7f','d89ba474-3587-4c03-97ee-2b6bdbe74d46',
--      'caa457ad-b3fd-4f75-a8e6-ce865125b3ce','83edbfac-07c4-479a-837d-297abeb96b3a',
--      'a7546b8a-b417-40ee-8238-ca352ef8ad4b','6c52b1ef-a7c4-4f96-88aa-d08ed4ed5618',
--      'c563b1fc-5162-4144-99c3-788304603f39','8fd540e1-0c40-4334-9f7a-3d965051aefa',
--      '1c08933f-75fe-4f89-bc7b-274c8c6e3f97','1ebc5a3e-44c1-4783-9827-c5132ceebc22',
--      'fe92b15f-5b34-4a18-b7b2-59cf8243d693','4280ada9-08a7-497f-b60c-3aa3ca643e26',
--      '2f12b018-2eae-42d3-b52c-45dfcd8a709d','6ef83fd5-6b9f-46d3-80f6-49b8f1b88a16',
--      '35146b73-6976-4db7-a73b-d08a4a63f681','025ecf11-8a3a-48f4-a3b5-5e96b57a26c3',
--      '081eed22-e545-4c5c-8381-1ef26c48df10','6b871bdf-fc0b-4da2-8025-edd0a8e018ab',
--      '107c346f-836c-4a79-8ac9-294ccbf3c850','45715339-147e-495d-a2d6-73addd1c528e'
--    ]::uuid[]);   -- attese: 22 righe
--
--   -- E la controprova, che è ciò che rende il rollback un rollback:
--   select count(*) from public.avvisi where scadenza is null;   -- → 22, non 0
