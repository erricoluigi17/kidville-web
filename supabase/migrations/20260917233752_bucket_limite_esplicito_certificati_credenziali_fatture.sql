-- ═══════════════════════════════════════════════════════════════════════════════
-- Tre archivi senza tetto proprio lo ricevono: `certificati-medici`, `credenziali`,
-- `fatture`. Misurato in produzione il 2026-09-17.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL DIFETTO, misurato e non dedotto (`select id, public, file_size_limit from
-- storage.buckets order by id`, 16 righe):
--   · certificati-medici → file_size_limit = NULL
--   · credenziali        → file_size_limit = NULL
--   · fatture            → file_size_limit = NULL
--   · gli altri tredici  → un numero, da 4 MiB (`documenti_personale`) a 50 MiB
--                          (`gallery`, `news`, `news_bozze`)
--
-- Supabase applica `min(limite del bucket, tetto globale del progetto)`. Con il
-- limite del bucket a NULL resta il solo tetto globale — che **non vive in questo
-- repository**: sta nel pannello, Settings → Storage, e lo cambia chi ne ha bisogno
-- per tutt'altro. Il 2026-09-16 è passato da 52.428.800 (50 MiB) a 2.000.000.000
-- per far entrare gli originali video, e quel pomeriggio questi tre archivi sono
-- passati da 50 MiB a 2 GB: **quaranta volte più larghi, per una decisione che non
-- li riguardava e che nessuno ha preso su di loro.** Dentro ci sono certificati
-- medici di minori, i PDF delle credenziali di accesso delle famiglie e le fatture.
--
-- Non è un problema di ACCESSO — i tre bucket sono privati, e restano privati: chi
-- può scrivere non cambia di una riga. È un problema di SUPERFICIE: ciò che un
-- caricamento autorizzato ma sbagliato (o una route con un bug) può depositare
-- prima che qualcuno se ne accorga.
--
-- PERCHÉ UN LIMITE IMPLICITO È PEGGIO DI UNO ESPLICITO ANCHE QUANDO I DUE NUMERI
-- COINCIDONO, che è il vero motivo di questo file. Un limite implicito non è «il
-- valore di default»: è un rinvio a un numero che sta altrove. Finché i due valori
-- coincidono non si distingue dal limite scritto — poi l'altro numero cambia, per
-- ragioni sue, e il rinvio lo segue in silenzio. Nessun `git log`, nessuna riga di
-- revisione, nessun test rosso: la regola di questi tre bucket è cambiata senza che
-- esistesse un posto in cui qualcuno potesse vederla cambiare. Scriverla qui dentro
-- non la rende più stretta: la rende **rivedibile**, cioè discutibile da chi legge
-- il repo invece che da chi apre il pannello.
--
-- I NUMERI, scelti dalla misura e non da un'abitudine
-- (`select bucket_id, count(*), max((metadata->>'size')::bigint) from
--   storage.objects where bucket_id in (…) group by bucket_id`):
--
--  · `certificati-medici` → 15.728.640 (15 MiB). **0 oggetti**: il bucket oggi è
--    vuoto, quindi nessun file esistente può essere contraddetto da questo tetto.
--    Il numero non è inventato: è lo stesso di `sensitive_documents` — il fascicolo
--    di famiglia, 15 MiB, `MAX_SIZE` in `src/app/api/primaria/fascicolo/route.ts`.
--    E i due non sono «simili», sono **alternativi sullo stesso file**:
--    `magazziniAmmessi()` (`src/app/api/parent/prestampati/banco-famiglia.ts`)
--    risponde `[certificati-medici, sensitive_documents]` per i campi
--    `prescrizionePath` e `certificatoPath`, cioè lo stesso allegato può finire
--    nell'uno o nell'altro a seconda del modulo. Due tetti diversi sarebbero una
--    divergenza per costruzione: la stessa foto del certificato del pediatra
--    accettata da una porta e respinta dall'altra.
--
--  · `credenziali` → 4.194.304 (4 MiB). 191 oggetti, tutti `.pdf`, il più grande di
--    **5.364 byte**: sono fogli generati dal server (`admin/regenerate-credentials`),
--    una pagina con nome utente e password. 4 MiB è 782 volte il più grande che
--    esista, ed è il valore che questo repo già usa per i documenti generati
--    (`documenti_personale`, `iscrizioni_elenchi`).
--
--  · `fatture` → 8.388.608 (8 MiB). 384 oggetti, tutti `.pdf`, il più grande di
--    **54.498 byte** (53 KiB): li deposita `pagamenti/fattura/sync`. Perché non 4
--    MiB come `credenziali`, visto che il margine sarebbe comunque 80×: la fattura
--    elettronica ha un tetto suo, esterno a noi — il Sistema di Interscambio non
--    accetta file oltre i 5 MB — e mettere il nostro SOTTO quella soglia
--    significherebbe poter rifiutare in casa un documento che lo Stato considera
--    valido. 8 MiB la scavalca e resta 153 volte il file più grande che abbiamo.
--
-- COSA NON FA, e sono tre cose.
--   1. Non tocca `allowed_mime_types`. In produzione i tre ce l'hanno NULL, cioè
--      accettano qualunque tipo: è un secondo difetto, misurato lo stesso giorno,
--      e resta aperto di proposito. Decidere quali formati può avere un certificato
--      medico è una decisione di prodotto, e una migrazione non è il posto dove
--      prenderla di nascosto (stessa ragione scritta in `20260901174336`).
--   2. Non tocca nessun file già caricato: il limite vale al momento del
--      caricamento, i 575 oggetti esistenti restano dove sono e nessuno li rilegge.
--   3. Non tocca la visibilità nel senso di cambiarla — la DICHIARA, e vale la pena
--      dire perché: nessuna migrazione di questo repo ha mai detto che questi tre
--      bucket sono privati. Sono nati dalla console, e l'unica cosa che li tiene
--      chiusi è che nessuno li riapra; una ricostruzione da zero (ambiente nuovo,
--      disaster recovery) sarebbe ripartita senza garanzie. Da qui l'`insert … on
--      conflict`, che in produzione non crea niente e in un ambiente nuovo li fa
--      nascere già chiusi — la forma della migrazione `20260901174336` su `gallery`.
--
-- SE VA STORTO: l'effetto peggiore è che venga respinto un file più grande del
-- tetto — mai che se ne perda uno già archiviato. Per `certificati-medici` il caso
-- non esiste ancora (bucket vuoto); per gli altri due servirebbe un PDF 150 volte
-- più grande di qualunque cosa sia mai stata generata. Per tornare indietro:
-- `update storage.buckets set file_size_limit = null where id in (…)`, che però
-- rimetterebbe il tetto nelle mani del pannello.
--
-- IL LOCK: `__tests__/architecture/bucket-storage-dichiarati.test.ts`. Fino al
-- 2026-09-17 quel test aveva un `return` che saltava il controllo quando il limite
-- dichiarato era `null` — si spegneva da solo esattamente sui bucket che avrebbe
-- dovuto denunciare, e per questo il difetto ha potuto passare. Il `return` è stato
-- tolto insieme a questa migrazione: un limite assente adesso è rosso.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. `certificati-medici` — certificati sanitari dei bambini, 15 MiB come il
--    fascicolo di famiglia, che per due campi su tre è l'archivio alternativo.
insert into storage.buckets (id, name, public, file_size_limit)
values ('certificati-medici', 'certificati-medici', false, 15728640)
on conflict (id) do update
   set file_size_limit = 15728640,
       public          = false,
       updated_at      = now();

-- 2. `credenziali` — i fogli con nome utente e password, generati dal server.
insert into storage.buckets (id, name, public, file_size_limit)
values ('credenziali', 'credenziali', false, 4194304)
on conflict (id) do update
   set file_size_limit = 4194304,
       public          = false,
       updated_at      = now();

-- 3. `fatture` — i PDF delle fatture elettroniche, sopra il tetto dei 5 MB del SdI.
insert into storage.buckets (id, name, public, file_size_limit)
values ('fatture', 'fatture', false, 8388608)
on conflict (id) do update
   set file_size_limit = 8388608,
       public          = false,
       updated_at      = now();
