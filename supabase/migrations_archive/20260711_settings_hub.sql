-- =============================================================================
-- IMPOSTAZIONI HUB — configurazione per-modulo + estensione matrice funzioni
-- =============================================================================
-- Idempotente. Aggiunge una colonna JSONB di config per ciascun modulo dell'app
-- (diario, presenze, note, avvisi, chat, galleria, armadietto, modulistica) su
-- admin_settings, con seed dei default. Estende funzioni_matrice (20260613) con
-- le nuove chiavi modulo per grado, in merge (non sovrascrive valori esistenti).
-- Pagelle/Scrutinio e Mensa mantengono lo storage già esistente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. COLONNE CONFIG PER MODULO
-- -----------------------------------------------------------------------------
ALTER TABLE public.admin_settings
  ADD COLUMN IF NOT EXISTS diario_config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS presenze_config    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS note_config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS avvisi_config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS chat_config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS galleria_config    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS armadietto_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS modulistica_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.admin_settings.diario_config      IS 'Config diario infanzia/nido: routine attive, finestra compilazione, visibilità genitori.';
COMMENT ON COLUMN public.admin_settings.presenze_config    IS 'Config presenze/appello: regole giustifiche, firma OTP, soglie alert.';
COMMENT ON COLUMN public.admin_settings.note_config        IS 'Config note disciplinari: firma OTP, visibilità, categorie, notifiche.';
COMMENT ON COLUMN public.admin_settings.avvisi_config      IS 'Config avvisi: ruoli pubblicazione, conferma lettura, allegati, scadenza.';
COMMENT ON COLUMN public.admin_settings.chat_config        IS 'Config chat: abilitazione genitori, orari docenti, broadcast.';
COMMENT ON COLUMN public.admin_settings.galleria_config    IS 'Config galleria: privacy, ruoli upload, approvazione, download, dimensioni.';
COMMENT ON COLUMN public.admin_settings.armadietto_config  IS 'Config armadietto: soglie scorta, notifiche, richieste materiale.';
COMMENT ON COLUMN public.admin_settings.modulistica_config IS 'Config modulistica: firma OTP, promemoria, ruoli invio, formato export.';

-- -----------------------------------------------------------------------------
-- 2. SEED DEFAULT (solo dove non ancora configurato)
-- -----------------------------------------------------------------------------
UPDATE public.admin_settings SET diario_config = jsonb_build_object(
  'routine_attive', jsonb_build_array('pasto','sonno','cambio','attivita','umore'),
  'orario_compilazione_da', '08:00',
  'orario_compilazione_a', '18:00',
  'visibile_genitori_da', '16:00',
  'note_libere_abilitate', true
) WHERE diario_config = '{}'::jsonb;

UPDATE public.admin_settings SET presenze_config = jsonb_build_object(
  'giustifica_obbligatoria', true,
  'giustifica_max_giorni_retroattivi', 5,
  'giustifica_richiede_firma_otp', true,
  'soglia_assenze_alert_pct', 25,
  'orario_appello_entro', '09:30',
  'uscite_anticipate_richiedono_delega', true
) WHERE presenze_config = '{}'::jsonb;

UPDATE public.admin_settings SET note_config = jsonb_build_object(
  'firma_otp_richiesta', true,
  'visibile_genitore_immediata', true,
  'categorie', jsonb_build_array('comportamento','didattica','materiale'),
  'notifica_admin_su_creazione', true
) WHERE note_config = '{}'::jsonb;

UPDATE public.admin_settings SET avvisi_config = jsonb_build_object(
  'ruoli_pubblicazione', jsonb_build_array('admin','teacher'),
  'conferma_lettura_abilitata', true,
  'allegati_max_mb', 10,
  'scadenza_default_giorni', 30
) WHERE avvisi_config = '{}'::jsonb;

UPDATE public.admin_settings SET chat_config = jsonb_build_object(
  'abilitata_genitori', true,
  'orario_docenti_da', '08:00',
  'orario_docenti_a', '17:00',
  'giorni_attivi', jsonb_build_array(1,2,3,4,5),
  'broadcast_solo_admin', true,
  'risposta_fuori_orario_msg', 'I docenti rispondono negli orari scolastici. Il tuo messaggio sarà letto alla riapertura.'
) WHERE chat_config = '{}'::jsonb;

UPDATE public.admin_settings SET galleria_config = jsonb_build_object(
  'consenso_privacy_richiesto', true,
  'upload_ruoli', jsonb_build_array('admin','teacher'),
  'approvazione_admin_richiesta', false,
  'download_genitori_abilitato', true,
  'max_mb_per_file', 25
) WHERE galleria_config = '{}'::jsonb;

UPDATE public.admin_settings SET armadietto_config = jsonb_build_object(
  'soglia_scorta_bassa', 2,
  'notifica_genitore_scorta_bassa', true,
  'richieste_materiale_abilitate', true,
  'categorie_extra', jsonb_build_array()
) WHERE armadietto_config = '{}'::jsonb;

UPDATE public.admin_settings SET modulistica_config = jsonb_build_object(
  'firma_otp_richiesta', true,
  'promemoria_giorni', 3,
  'invio_ruoli', jsonb_build_array('admin'),
  'export_formato', 'csv'
) WHERE modulistica_config = '{}'::jsonb;

-- -----------------------------------------------------------------------------
-- 3. ESTENSIONE funzioni_matrice — nuove chiavi modulo per grado (merge)
-- -----------------------------------------------------------------------------
-- Aggiunge le chiavi solo se mancanti nel grado: i valori già configurati
-- dall'admin hanno la precedenza (nuove_chiavi || esistente).
UPDATE public.admin_settings
SET funzioni_matrice = jsonb_build_object(
  'primaria', jsonb_build_object(
    'mensa', true, 'chat', true, 'avvisi', true,
    'armadietto', false, 'modulistica', true, 'pagelle', true
  ) || COALESCE(funzioni_matrice->'primaria', '{}'::jsonb),
  'infanzia', jsonb_build_object(
    'mensa', true, 'chat', true, 'avvisi', true,
    'armadietto', true, 'modulistica', true, 'pagelle', false
  ) || COALESCE(funzioni_matrice->'infanzia', '{}'::jsonb),
  'nido', jsonb_build_object(
    'mensa', true, 'chat', true, 'avvisi', true,
    'armadietto', true, 'modulistica', true, 'pagelle', false
  ) || COALESCE(funzioni_matrice->'nido', '{}'::jsonb)
)
WHERE scuola_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
