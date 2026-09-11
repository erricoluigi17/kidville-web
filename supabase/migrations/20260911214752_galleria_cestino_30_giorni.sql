-- ═══════════════════════════════════════════════════════════════════════════════
-- GALLERIA · IL CESTINO A 30 GIORNI — «Elimina» nasconde subito, distrugge dopo
-- Scritta il 2026-09-11, misurando il database di produzione in SOLA LETTURA.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ─── ⚠️ NON È ANCORA APPLICATA. TRE COSE DOPO L'APPLY, UNA PRIMA DEL MERGE ────
--
-- Questo file è stato SCRITTO, non applicato: chi l'ha scritto non esegue
-- `apply_migration`, perché su questo database ci sono dati reali di minori e
-- l'istruzione si mostra a una persona prima di partire. Al 2026-09-11 le tre
-- colonne NON esistono in produzione (`information_schema.columns`: zero righe) e
-- i due indici nemmeno (`to_regclass` → NULL su entrambi). Verificato, non dedotto.
--
--   1. ⚠️ RINOMINA QUESTO FILE CON LA VERSION CHE IL DATABASE HA REGISTRATO.
--      Lo strumento MCP `apply_migration` NON usa la version del nome che gli si
--      passa: genera la PROPRIA, dall'orologio del momento. Il 2026-08-31 lo
--      scarto fu di undici secondi (`…192032` sul disco, `…192043` in tabella) e
--      bastò: `supabase db push` non trova la version del file fra le applicate,
--      la considera nuova e LA RIAPPLICA. Qui riapplicare non distruggerebbe dati
--      — ogni istruzione di questo file è idempotente — ma *l'idempotenza è una
--      fortuna, non una difesa*. Perciò, subito dopo l'apply:
--          SELECT version, name FROM supabase_migrations.schema_migrations
--           ORDER BY version DESC LIMIT 3;
--      e si rinomina il file in `<version_registrata>_galleria_cestino_30_giorni.sql`
--      PRIMA di committarlo. La stessa lezione è nella testata di
--      `20260810204727_candidature_retention_cron.sql`.
--
--   2. RIGENERA LE DUE FOTOGRAFIE, E IN QUEST'ORDINE: apply → rileggi la version →
--      rinomina → rigenera. Mai l'inverso. La soglia di una fotografia è l'ISTANTE
--      dello scatto, quindi una fotografia scattata prima della rinomina resta più
--      vecchia del file e i lock restano rossi senza che si capisca perché.
--        · `__tests__/fixtures/pg-policies-snapshot.json`, perché questo file
--          riscrive una policy → `node scripts/rls-fotografia.mjs --sql`.
--        · `__tests__/fixtures/migrazioni-applicate-snapshot.json`, perché cambia
--          l'elenco delle applicate → `node __tests__/fixtures/migrazioni-fotografia.mjs --sql`.
--          ⚠️ Al 2026-09-11 quella fotografia è GIÀ indietro di due: si ferma a
--          `20260909113156`, mentre la produzione ha anche `20260909121501` e
--          `20260911113000`. Non è un debito di questo file, ma va chiuso nello
--          stesso giro: rigenerando oggi compaiono TRE novità, e chi guarda non
--          distingue più la propria dalle altrui.
--        · `get_advisors(security)` dopo l'apply deve tornare **0 ERROR**.
--
--   3. PRIMA DEL MERGE, IL PRD — E NON LO CHIUDE CHI SCRIVE QUESTO FILE.
--      `AGENTS.md` non lascia scelta: «qualunque cambiamento a
--      codice/funzionalità/schema dati deve essere riflesso nel PRD nello stesso
--      lavoro… un intervento non è completo se il PRD non è allineato». Questa È
--      una modifica di schema: tre colonne, due indici, e una condizione nuova
--      nella policy di lettura dei GENITORI.
--      Misurato il 2026-09-11: `PRD REGISTRO ELETTRONICO.md` non nomina il cestino
--      della galleria da nessuna parte — un grep di `cestino|eliminato_il|file_rimosso`
--      trova il cestino del DIARIO (riga 1424) e tre icone di form, nient'altro.
--      Serve una voce di changelog datata, nella forma delle voci vicine
--      (`## 🧾 Changelog — <titolo> — 2026-09-11 (branch …)`), che dichiari: le tre
--      colonne, il perché di `ON DELETE SET NULL` su `eliminato_da`, i due indici
--      parziali, la condizione `eliminato_il IS NULL` come PRIMA della USING, e
--      l'ordine obbligato migrazione → codice → cron della purga.
--      Perché non lo fa chi scrive qui: il PRD è un file di radice, e su questo
--      albero di lavoro girano più agenti in parallelo — due voci inserite in cima
--      nello stesso momento si sovrascrivono. Lo chiude chi fa il merge, in un
--      passaggio solo, per tutto il branch. È scritto QUI e non soltanto in una
--      consegna perché *un adempimento che vive solo in un messaggio è un
--      adempimento che non verrà fatto*.
--
-- ─── IN QUATTRO RIGHE, PER CHI DEVE APPROVARLA ────────────────────────────────
--   COSA FA. Aggiunge TRE colonne a `galleria_media_v2`, due indici, e riscrive
--   la policy di lettura del genitore aggiungendovi UNA condizione. Nient'altro.
--   COSA NON FA. Non tocca una sola riga di dati: nessun INSERT, nessun UPDATE,
--   nessun DELETE, nessun backfill. Non cancella colonne, tabelle, vincoli o
--   permessi. Non tocca lo Storage. Non crea lavori schedulati.
--   SE VA STORTO. La peggiore delle ipotesi è che la transazione venga annullata
--   e si resti nello stato di oggi. Il peggiore degli esiti *riusciti* è che i
--   genitori vedano MENO del dovuto — mai più — perché l'unica cosa che questa
--   migrazione aggiunge alla policy è un filtro che RESTRINGE.
--   QUANTO COSTA ADESSO. Aggiungere una colonna `timestamptz` nullabile in
--   Postgres non riscrive la tabella (il default è NULL, quindi nessun rewrite):
--   è una modifica di catalogo, istantanea. I due indici su 1318 righe si
--   costruiscono in millisecondi. L'unico lock che esce dalla tabella è quello
--   della chiave esterna di `eliminato_da`, che prende un `SHARE ROW EXCLUSIVE`
--   su `utenti` per il tempo della validazione — che su una colonna appena nata,
--   quindi NULL su tutte le righe, non ha niente da validare.
--
-- ─── È ADDITIVA E INERTE, E QUESTO È IL MOTIVO PER CUI VA APPLICATA PRIMA ─────
--
-- Inerte vuol dire una cosa precisa e verificabile: le tre colonne nascono NULL
-- su **tutte e 1318** le righe esistenti, quindi il giorno dell'apply
-- `eliminato_il IS NULL` è vero per ogni foto in archivio, e la policy riscritta
-- qui sotto lascia passare esattamente le stesse righe di prima. Nessun
-- programma scrive quelle colonne finché il codice del cestino non è in
-- produzione: oggi non esiste una sola route che le nomini.
--
-- Perciò l'ordine giusto è questo, e non l'inverso:
--   1. QUESTA migrazione, PRIMA del rilascio. Se andasse dopo, il codice nuovo
--      leggerebbe e scriverebbe colonne che non esistono, e PostgREST
--      risponderebbe `42703` in SELECT e `PGRST204` in INSERT/UPDATE: il cestino
--      sarebbe rotto nella finestra fra i due momenti, e a schermo l'utente
--      vedrebbe un errore senza capire perché.
--   2. Il rilascio del codice (nascondi, elenca il cestino, ripristina).
--   3. **Il cron della purga, DOPO, e in una migrazione separata.** È l'unico
--      pezzo che DISTRUGGE, e va acceso solo quando si è visto funzionare il
--      resto. Un automa che cancella file, accesso lo stesso giorno in cui il
--      codice che marca le righe entra in produzione, cancellerebbe sulla base di
--      un comportamento che nessuno ha ancora osservato. Il verso in cui si
--      sbaglia conta: una riga nascosta e non ancora distrutta si recupera con un
--      UPDATE, un file cancellato dallo Storage non torna.
--
-- ─── LA DECISIONE, E COS'ERA IL DIFETTO ───────────────────────────────────────
--
-- Oggi «Elimina» su una foto della galleria è irreversibile: la riga se ne va e
-- il file con lei. Su una galleria di scuola dell'infanzia questo significa che
-- un tocco sbagliato di un'insegnante — su un telefono, fra venti bambini —
-- cancella per sempre la foto di un pomeriggio che non si ripete.
--
-- Decisione del titolare: premere Elimina fa sparire la foto SUBITO dalla vista
-- di tutti (genitori compresi), la lascia recuperabile **30 giorni**, e poi la
-- distrugge davvero — riga E file. Tre colonne bastano a dirlo, e sono tutte e
-- tre dei timestamp: il cestino non ha bisogno di uno stato in più da tenere
-- coerente con le date, perché lo stato È la data.
--
-- ─── MISURATO IN PRODUZIONE IL 2026-09-11, NON DEDOTTO ────────────────────────
--
--   SELECT count(*), count(*) FILTER (WHERE scuola_id IS NULL) FROM galleria_media_v2;
--     → 1318 righe, di cui 0 con `scuola_id` nullo.
--   Prima foto 2026-09-01 14:40 UTC, ultima 2026-09-11 16:21 UTC — cioè oggi.
--   RIMISURATO lo stesso giorno, in una seconda sessione, prima di consegnare:
--   1318 e 0, identici — e la foto più recente è ancora quella delle 16:21. Non
--   è la prova che il numero sia stabile: è la prova che in quelle ore non sono
--   entrate foto. Fra una settimana sarà falso comunque.
--
-- ⚠️ Il 2026-09-05 la migrazione `20260906013059_galleria_indici_vista_di_sede`
-- misurava **301 righe** su questa stessa tabella. In sei giorni sono diventate
-- 1318: **più che quadruplicate**. Chi legge questo commento fra una settimana
-- non copi il 1318 — lo ricontti, è una riga di SQL, ed è una LETTURA.
--
-- Il vincolo esatto su `uploaded_by`, letto da `pg_constraint` (contype = 'f'):
--   galleria_media_v2_uploaded_by_fkey
--     FOREIGN KEY (uploaded_by) REFERENCES utenti(id) **ON DELETE CASCADE**
--   galleria_media_v2_scuola_id_fkey
--     FOREIGN KEY (scuola_id) REFERENCES schools(id)
--
-- Gli indici già presenti, letti da `pg_indexes` (e non da `pg_constraint`, che
-- **non vede** gli indici parziali — lezione pagata il 2026-09-09):
--   galleria_media_v2_pkey · idx_galleria_media_v2_scuola_id ·
--   idx_galleria_v2_created · idx_galleria_v2_sede_created ·
--   idx_galleria_v2_tag_students · idx_galleria_v2_uploaded_by
--   Nessuno di essi è parziale: i due che nascono qui sono i primi.
--
-- La policy attuale, letta da `pg_policies`: **una sola**, di SELECT, per
-- `authenticated`, quella del 2026-07-31 riscritta in fondo a questo file. Il
-- resto degli accessi passa dal service-role, che la RLS non la vede.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- LE TRE SCELTE CHE VALE LA PENA AVER CAPITO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 1. `eliminato_da` È `ON DELETE SET NULL`, E MAI `ON DELETE CASCADE`.
--    `uploaded_by`, sulla stessa tabella, è `ON DELETE CASCADE` (misurato qui
--    sopra), e lì ha un senso discutibile ma almeno leggibile: cancellare
--    un'insegnante porta via le foto che ha caricato lei. Ripetere quella scelta
--    su `eliminato_da` significherebbe una cosa completamente diversa e
--    indifendibile: **cancellare l'impiegata che ha premuto Elimina
--    cancellerebbe le foto che ha eliminato lei** — cioè il cestino perderebbe
--    per sempre proprio le righe che qualcuno potrebbe voler ripristinare, e le
--    perderebbe per un fatto che non ha niente a che vedere con quelle foto.
--    `eliminato_da` è un'ATTRIBUZIONE, non una proprietà: dice «chi l'ha fatto»,
--    e se quella persona non c'è più la risposta giusta è «non si sa più chi»,
--    non «allora buttiamo via anche la foto».
--
-- 2. NESSUN CAMPO DI TESTO LIBERO. Non c'è, e non va aggiunto, nessun `motivo`.
--    Un campo libero in cui un adulto scrive perché ha eliminato la foto di un
--    bambino è, per costruzione, PII scritta su un minore: finirebbe nei backup,
--    negli export, e prima o poi in un log. Per il chi/quando/cosa esiste già
--    `audit_scritture_docente`, che è il posto dove questa informazione ha una
--    forma, una retention e dei permessi. Tre timestamp e un uuid non sono un
--    racconto: sono un fatto.
--
-- 3. `file_rimosso_il` NON È UN DOPPIONE DI `eliminato_il`, E SERVE A DUE COSE.
--    Sono due momenti diversi: `eliminato_il` è quando la foto è stata nascosta,
--    `file_rimosso_il` è quando il file è stato tolto dallo Storage. Fra i due
--    passano 30 giorni, e i due presidi che vivono in quello scarto sono:
--      · **la purga diventa idempotente.** Lo Storage non si raggiunge da
--        Postgres: la cancellazione del file la fa una route HTTP, e una route
--        HTTP può fallire a metà, andare in timeout, o essere richiamata due
--        volte dallo stesso cron. Marcando il file come già rimosso, il secondo
--        giro salta le righe che il primo ha già chiuso invece di ritentare per
--        sempre un DELETE su un file che non c'è più.
--      · **il cestino non mostra ciò che non si può più ripristinare.** Una riga
--        con `file_rimosso_il` valorizzato è una riga la cui immagine non esiste
--        più: offrire «Ripristina» su quella riga sarebbe un bottone che
--        restituisce una foto rotta. L'elenco del cestino filtra
--        `file_rimosso_il IS NULL`, e chi ha superato i 30 giorni sparisce dal
--        cestino anche se la sua riga resta ancora in tabella per un po'.
--
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- ⚠️ QUESTO FILE RENDE ROSSO UN LOCK, ED È DOVUTO — MA NON PER IL MOTIVO OVVIO
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `__tests__/architecture/rls-per-sede.test.ts` fallisce sulla prova «nessuna
-- migrazione più recente della fotografia tocca le policy senza rigenerarla», e
-- nomina questo file. È giusto: il file riscrive davvero una policy, e la
-- fotografia di `pg_policies` non può contenere una modifica non ancora applicata.
-- Il rosso si spegne DOPO l'apply, rigenerando la fotografia (punto 2 della
-- testata). Prima non si spegne, e non c'è modo di farlo spegnere.
--
-- La parte che non è ovvia, e che è stata MISURATA e non dedotta: il rosso **non
-- dipende dal blocco `CREATE POLICY` in fondo al file**. `toccaLaRls()` cerca la
-- parola `policy` dentro `senzaCommenti(sql)`, e `senzaCommenti()` toglie i
-- commenti ma CONSERVA di proposito le stringhe — perché una policy vera può
-- vivere dentro un `EXECUTE format('create policy …')`. La prima occorrenza che
-- sopravvive non è il `CREATE POLICY`: è la parola «policy» dentro il LETTERALE
-- del `COMMENT ON COLUMN` di `eliminato_il`, molto più su in questo file.
-- Troncando il file prima di TUTTA la sezione 3, il lock resta ROSSO.
--
-- Serve saperlo per una ragione pratica, e per evitare due reazioni sbagliate:
--   · scorporare la policy in una migrazione a parte per avere un file verde
--     **non funziona** — il file con le sole colonne resterebbe rosso, e nessuno
--     capirebbe perché;
--   · riscrivere il commento per togliere quella parola sarebbe un lock che paga
--     chi commenta di meno, cioè esattamente il difetto chiuso il 2026-08-12 su
--     questo stesso riconoscitore.
-- Il commento resta com'è. Il rosso si chiude applicando.

-- ─── 1. Le tre colonne ────────────────────────────────────────────────────────
-- Tutte nullabili, tutte NULL sulle righe esistenti: è ciò che rende questa
-- migrazione inerte. `ADD COLUMN IF NOT EXISTS` la rende ripetibile.
ALTER TABLE public.galleria_media_v2
  ADD COLUMN IF NOT EXISTS eliminato_il    timestamptz,
  ADD COLUMN IF NOT EXISTS eliminato_da    uuid REFERENCES public.utenti(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS file_rimosso_il timestamptz;

COMMENT ON COLUMN public.galleria_media_v2.eliminato_il IS
  'Quando la foto è stata messa nel cestino. NULL = foto viva e visibile; valorizzato = nascosta SUBITO a tutti (genitori compresi, per la policy di lettura), e recuperabile per 30 GIORNI. Dopo 30 giorni la purga la distrugge davvero, riga e file. Lo stato del cestino è questa data: non esiste un flag separato da tenere coerente con essa.';

COMMENT ON COLUMN public.galleria_media_v2.eliminato_da IS
  'Chi ha messo la foto nel cestino. È un''ATTRIBUZIONE, non una proprietà: perciò la chiave esterna è ON DELETE SET NULL e non ON DELETE CASCADE come uploaded_by sulla stessa tabella. Con CASCADE, cancellare l''impiegata che ha premuto Elimina cancellerebbe le foto che ha eliminato lei, cioè proprio quelle che nei 30 giorni si potrebbero voler ripristinare. Se la persona non c''è più, la risposta giusta è «non si sa più chi», non «via anche la foto». Il chi/quando/cosa dettagliato sta in audit_scritture_docente: qui non c''è e non va aggiunto nessun campo di testo libero, che su un minore sarebbe PII.';

COMMENT ON COLUMN public.galleria_media_v2.file_rimosso_il IS
  'Quando il file è stato tolto dallo Storage, alla scadenza dei 30 giorni. Serve a due cose. (1) Rende la purga IDEMPOTENTE: lo Storage non si raggiunge da Postgres, la cancellazione la fa una route HTTP che può fallire a metà o essere richiamata due volte, e questa data fa saltare al secondo giro le righe che il primo ha già chiuso. (2) Tiene fuori dal cestino ciò che non è più ripristinabile: una riga con questa data valorizzata non ha più l''immagine, quindi l''elenco del cestino filtra file_rimosso_il IS NULL invece di offrire un «Ripristina» che restituirebbe una foto rotta.';

-- ─── 2. I due indici, entrambi PARZIALI ───────────────────────────────────────
--
-- Sono parziali perché le due domande che il cestino introduce sono disgiunte e
-- di taglia molto diversa: la galleria legge SEMPRE le righe vive (che sono
-- quasi tutte), la purga legge SOLO quelle nel cestino (che sono poche). Un
-- indice parziale sul secondo insieme è piccolo quanto il cestino, non quanto la
-- tabella.
--
-- ⚠️ Un indice parziale serve solo alle query che portano la sua CONDIZIONE
-- scritta dentro. `WHERE scuola_id = … ORDER BY created_at DESC` senza
-- `eliminato_il IS NULL` non lo usa, e ricade sul composito già esistente
-- `idx_galleria_v2_sede_created`. È il motivo per cui quel composito NON si
-- tocca: fra questa migrazione e il rilascio del codice è lui a servire le
-- letture, perché nessuna query nomina ancora `eliminato_il`. Togliere un indice
-- «perché ora c'è quello nuovo» è una scommessa su query che non si sono
-- misurate.
--
-- NIENTE `CONCURRENTLY`, ed è una scelta: `apply_migration` avvolge tutto in una
-- transazione e `CREATE INDEX CONCURRENTLY` fuori da essa non può girare
-- (`25001`). Su 1318 righe il lock dura millisecondi.

-- (a) La lettura normale: «le foto VIVE di questa sede, dalla più recente».
CREATE INDEX IF NOT EXISTS idx_galleria_v2_sede_created_attive
    ON public.galleria_media_v2 (scuola_id, created_at DESC)
 WHERE eliminato_il IS NULL;

COMMENT ON INDEX public.idx_galleria_v2_sede_created_attive IS
  'Vista di sede della galleria dopo il cestino: le foto VIVE di un plesso, dalla più recente. Parziale su eliminato_il IS NULL, cioè quasi tutta la tabella, ma così le righe nel cestino non si scorrono nemmeno. Lo usano solo le query che portano scritto eliminato_il IS NULL; le altre ricadono su idx_galleria_v2_sede_created, che per questo non è stato rimosso.';

-- (b) La purga: «cosa è nel cestino da più di 30 giorni».
--     L'indice è piccolo per costruzione: contiene SOLO le righe eliminate.
--     `file_rimosso_il` non entra nella chiave di proposito — la selettività
--     vera la dà già la condizione parziale, e il cestino è un insieme che si
--     scorre per intero in un colpo.
CREATE INDEX IF NOT EXISTS idx_galleria_v2_cestino_purga
    ON public.galleria_media_v2 (eliminato_il)
 WHERE eliminato_il IS NOT NULL;

COMMENT ON INDEX public.idx_galleria_v2_cestino_purga IS
  'La purga del cestino: le righe messe nel cestino da più di 30 giorni, in ordine di data. Parziale su eliminato_il IS NOT NULL, quindi grande quanto il cestino e non quanto la tabella. Serve anche all''elenco del cestino mostrato alla segreteria.';

-- ─── 3. La policy di lettura del genitore ─────────────────────────────────────
--
-- Riscrittura di `20260731170007_galleria_lettura_genitore_con_sede.sql`, nella
-- forma che quel file stesso dichiara: **si AGGIUNGE una condizione, non se ne
-- toglie**. Il rischio di sbagliare così è «i genitori non vedono» (fastidioso,
-- reversibile con un UPDATE), mai «vedono troppo».
--
-- `eliminato_il IS NULL` è la PRIMA condizione, e non è un vezzo di stile: è
-- ciò che rende «Elimina» immediato anche per chi non passa dalla route. La
-- route `GET /api/gallery` il filtro lo avrà, ma è uno strato solo: chi leggesse
-- la tabella direttamente con la chiave del client (`authenticated`) vedrebbe
-- ancora la foto che un'insegnante ha appena messo nel cestino. La policy decide
-- chi vede la RIGA, il bucket privato chi vede il FILE — e finché il file esiste
-- (30 giorni) il link firmato va negato allo stesso modo.
--
-- (Sul realtime, per non ripetere a memoria ciò che si può misurare: al
-- 2026-09-11 `galleria_media_v2` NON è in nessuna pubblicazione — verificato su
-- `pg_publication_rel`, zero righe. Il giorno in cui vi entrasse, questa
-- condizione è ciò che impedirebbe a un evento di annunciare a un genitore una
-- foto già cestinata: la RLS vale anche lì.)
--
-- Il resto della USING è copiato senza modifiche dal file del 2026-07-31: sede
-- del figlio, più broadcast oppure tag su un proprio figlio.
DROP POLICY IF EXISTS "parent read galleria figli (parents space)" ON public.galleria_media_v2;

CREATE POLICY "parent read galleria figli (parents space)"
  ON public.galleria_media_v2 FOR SELECT TO authenticated
  USING (
    -- La foto non è nel cestino. Prima condizione: appena un'insegnante preme
    -- Elimina, il genitore non la vede più, senza attendere nessun automa.
    eliminato_il IS NULL
    -- La foto sta in una sede in cui questo genitore ha un figlio.
    AND EXISTS (
      SELECT 1 FROM public.alunni a
       WHERE a.id = ANY (ARRAY(SELECT current_parent_student_ids()))
         AND a.scuola_id = galleria_media_v2.scuola_id
    )
    -- …e resta vero tutto ciò che valeva prima.
    AND (
      is_broadcast = true
      OR tag_students && ARRAY(SELECT current_parent_student_ids())
    )
  );

COMMENT ON POLICY "parent read galleria figli (parents space)" ON public.galleria_media_v2 IS
  'Il genitore vede le foto broadcast e quelle in cui è taggato un suo figlio, solo nelle sedi in cui ha un figlio (vincolo del 2026-07-31), e solo se la foto NON è nel cestino (vincolo del 2026-09-11: eliminato_il IS NULL come prima condizione, così «Elimina» nasconde subito anche a chi leggesse la tabella senza passare dalla route).';

-- PostgREST tiene in memoria lo schema: senza questo, le tre colonne nuove
-- risponderebbero `PGRST204` finché non si riavvia.
NOTIFY pgrst, 'reload schema';
