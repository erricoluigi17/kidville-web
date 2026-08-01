-- =============================================================================
-- S23 · privacy F4 — La dichiarazione di consenso di chi pubblica è una PROVA.
--
-- IL DIFETTO. L'editor delle News chiedeva all'operatore, al primo caricamento
-- di una foto, di spuntare «confermo di avere il consenso». Quella spunta viveva
-- in `useState`: non arrivava al server, non veniva archiviata, non consultava
-- nessun dato. Il bucket `news` è PUBBLICO e servito senza login — è il «sito web
-- della Scuola» per cui le famiglie danno un consenso distinto — e la sola difesa
-- era una casella che non lasciava traccia. Non esisteva alcun modo di sapere chi
-- avesse dichiarato cosa, né a quale versione del testo avesse risposto la
-- famiglia (art. 5 §2 «responsabilizzazione» e art. 7 §1 «prova del consenso»).
--
-- COSA FA. Quattro colonne su `news_posts`: chi è ritratto, chi l'ha dichiarato,
-- quando, e su quale versione del testo dei consensi. `NULL` sui post senza foto:
-- la differenza fra «non c'era niente da dichiarare» e «non è stato dichiarato»
-- deve restare leggibile anche fra due anni.
--
-- ⚠️ NON APPLICATA da chi l'ha scritta: va approvata dal titolare.
-- ⚠️ DB E2E non migrato: `POST /api/news` ritenta l'insert senza queste colonne
--    (`PGRST204`) e lascia una riga di log `colonna-consenso-assente`. Il GATE
--    del consenso, però, è già passato prima dell'insert: qui si perde la prova,
--    mai il controllo.
-- =============================================================================

alter table public.news_posts
  add column if not exists bambini_ritratti uuid[],
  add column if not exists consenso_dichiarato_da uuid,
  add column if not exists consenso_dichiarato_il timestamptz,
  add column if not exists consenso_versione text;

comment on column public.news_posts.bambini_ritratti is
  'Bambini dichiarati come ritratti nelle foto del post. `{}` = dichiarazione esplicita «nessun bambino ritratto» (media editoriale). NULL = post senza foto, niente da dichiarare. Ogni id elencato deve avere `alunni.consenso_foto_sito = true`: la verifica la fa `POST /api/news` prima di scrivere la riga.';

comment on column public.news_posts.consenso_dichiarato_da is
  'Utente che ha reso la dichiarazione sui bambini ritratti. Nessuna FK: se l''account viene cancellato (oblio) la prova di CHI ha pubblicato non deve sparire con lui.';

comment on column public.news_posts.consenso_dichiarato_il is
  'Momento della dichiarazione.';

comment on column public.news_posts.consenso_versione is
  'Versione del testo dei consensi a cui la dichiarazione si riferisce (`CONSENSI_VERSIONE` in `src/lib/forms/enrollment-template.ts`). Serve a sapere, fra due anni, a quale formulazione la famiglia aveva risposto.';

-- I post già esistenti restano a NULL: non si può inventare una dichiarazione
-- che nessuno ha reso. Al 2026-08-01 il bucket `news` è vuoto e nessun post
-- porta fotografie: non c'è niente da sanare a posteriori.
