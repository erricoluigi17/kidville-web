-- ═══════════════════════════════════════════════════════════════════════════════
-- Quando una persona ha scelto la PROPRIA password — e cosa questa tabella NON sa.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- COSA REGISTRA: una riga per account (`auth.users.id`), aggiornata a ogni cambio
-- riuscito. Vale per i GENITORI (il ponte è `parents.auth_user_id`) e per il
-- PERSONALE (`utenti.id` È l'id di auth): una chiave sola, perché il gesto è lo
-- stesso e la password non è un affare di area.
--
-- ─── ⚠️ IL BACKFILL È VUOTO, ED È L'UNICA COSA ONESTA ──────────────────────────
--
-- Misurato in produzione il 2026-09-01: **560** genitori hanno `auth_user_id`,
-- **129** di questi non hanno mai fatto login (`last_sign_in_at IS NULL`), **22**
-- hanno `parents.onboarded_at` valorizzato.
--
-- Nessuno di questi tre numeri dice chi abbia cambiato la password.
--
--   · `onboarded_at` NON è un proxy: si valorizza anche accettando i soli consensi,
--     perché la password è FACOLTATIVA (`src/app/api/parent/onboarding/route.ts`).
--     I 22 non sono 22 password scelte: sono 22 onboarding completati.
--   · `auth.users.updated_at` NON è un proxy: si muove per ragioni che non sono un
--     cambio password. Già misurato e scartato il 2026-08-23 — vedi il blocco
--     «1. CHI» in `src/app/api/admin/iscrizioni/rinvia-credenziali/route.ts`.
--   · L'impronta bcrypt non è invertibile.
--
-- Quindi: ZERO righe inserite. **L'assenza di riga significa «non lo sappiamo»,
-- non «non ha cambiato».** Chi legge questa tabella deve distinguere TRE stati,
-- non due:
--
--   riga presente ................................. ha scelto la sua password, con data certa
--   nessuna riga + `last_sign_in_at IS NULL` ...... certamente ancora provvisoria
--   nessuna riga + ha fatto login ................. IGNOTO. Non si deduce, non si blocca.
--
-- Il terzo stato è la ragione per cui questa tabella **non** governa l'accesso.
-- Un blocco costruito su un ignoto è un lockout di massa: al deploy avrebbe chiuso
-- fuori 560 famiglie, comprese quelle che una password loro ce l'hanno già.
--
-- ─── COSA DECIDE DAVVERO CHI DEVE CAMBIARE ─────────────────────────────────────
--
-- L'unica cosa che sa CON CERTEZZA che una persona sta usando adesso una password
-- provvisoria è la FORMA della stringa digitata al login:
-- `classificaFormaPassword()` in `src/lib/auth/forma-password.ts`, che gira già a
-- ogni accesso e fino a oggi finiva soltanto in una riga di log.
-- L'instradamento a `/auth/nuova-password` nasce da lì — da un'osservazione fatta
-- al momento giusto, sulla persona giusta — non da questa tabella.
--
-- Questa tabella serve a MISURARE (quanti hanno cambiato, da quando, per quale
-- via) e a far sparire l'avviso nel profilo. Non a decidere chi entra.
--
-- ─── PERCHÉ UNA TABELLA E NON UNA COLONNA ──────────────────────────────────────
--
-- Due colonne (`parents.password_cambiata_il` + `utenti.password_cambiata_il`)
-- funzionerebbero, ma: due chiavi diverse (`parents.auth_user_id` vs `utenti.id`),
-- nessuna storia, e si toccherebbero due tabelle calde — `utenti` ha le colonne
-- GENERATED `first_name`/`last_name`/`role`, `parents` ha RLS e anonimizzazione.
-- `user_metadata` è scrivibile dall'utente stesso col proprio token, quindi non è
-- affidabile per niente che confini con la sicurezza; `app_metadata` vive in
-- `auth.users` e **non è interrogabile da PostgREST**, cioè nessun pannello e
-- nessuno `SELECT` di misura potrebbe leggerlo. Qui si misura in SQL su `public.*`.
--
-- ─── COSA NON FA ───────────────────────────────────────────────────────────────
-- Non tocca `auth.users`, non tocca `parents`, non tocca `utenti`, non rigenera
-- nessuna password, non scrive nessuna riga. È additiva e reversibile.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.password_cambi (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  cambiata_il  timestamptz NOT NULL DEFAULT now(),
  cambi        smallint    NOT NULL DEFAULT 1,
  -- 'primo-accesso' = dall'interstiziale, dopo un login con password temporanea
  -- 'self-service'  = dal profilo, di propria iniziativa
  -- 'onboarding'    = dal vecchio flusso consensi + password
  origine      text        NOT NULL DEFAULT 'self-service',
  CONSTRAINT password_cambi_origine_ck
    CHECK (origine IN ('primo-accesso', 'self-service', 'onboarding'))
);

COMMENT ON TABLE public.password_cambi IS
  'Quando un account ha scelto una password propria. NESSUN backfill: prima del 2026-09-01 il dato non esiste, e l''assenza di riga NON significa «non ha cambiato».';
COMMENT ON COLUMN public.password_cambi.cambi IS
  'Quante volte. Fa anche da segnale per l''audit: un valore che sale in fretta va guardato.';
COMMENT ON COLUMN public.password_cambi.origine IS
  'Da quale delle tre porte è passato il cambio. Serve a sapere se l''instradamento al primo accesso sta funzionando davvero, o se cambia password solo chi lo cerca nel profilo.';

CREATE INDEX IF NOT EXISTS password_cambi_cambiata_il_idx
  ON public.password_cambi (cambiata_il DESC);

-- RLS attiva + ZERO policy = nega tutto a chiunque non sia il service-role.
-- È l'intento, non una dimenticanza: questa tabella si scrive e si legge solo da
-- `createAdminClient()`, e nessun client di sessione deve poterla interrogare.
ALTER TABLE public.password_cambi ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

-- ─── COME SI VERIFICA, dopo l'apply ────────────────────────────────────────────
--   SELECT count(*) FROM public.password_cambi;                        -- atteso: 0
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'password_cambi';  -- atteso: t
--   SELECT count(*) FROM pg_policies WHERE tablename = 'password_cambi';   -- atteso: 0
--
-- ─── COME SI MISURA, dopo il rilascio ──────────────────────────────────────────
--   SELECT origine, count(*) FROM public.password_cambi GROUP BY 1;
--   -- se `primo-accesso` resta a 0 mentre `self-service` cresce, l'instradamento
--   -- non sta raggiungendo nessuno: è il segnale che il lavoro è a metà.
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS public.password_cambi;
