-- ═══════════════════════════════════════════════════════════════════════════════
-- LA SECONDA CONSEGNA — tre colonne, e una che NON si tocca.
--
-- ─── IL FATTO ───────────────────────────────────────────────────────────────
-- Il 2026-08-22 il cron ha spedito 67 credenziali. 37 famiglie sono entrate (metodo
-- `password`, misurato su `auth.mfa_amr_claims`), 30 no. Nessuna password è stata
-- ruotata dopo l'invio: quelle che le 30 famiglie hanno in mano sono ancora, oggi,
-- esattamente quelle scritte su GoTrue. Il difetto stava nel VIAGGIO — 28 caratteri
-- `base64url` con `l`/`I`/`1` e `O`/`0` indistinguibili, da trascrivere a mano su un
-- telefono — ed è chiuso dal formato nuovo `Xxxx-xxxx-xxxx-xxxx`.
--
-- Resta da rimandare le credenziali a chi non è mai entrato, nel formato nuovo.
--
-- ─── PERCHÉ TRE COLONNE NUOVE E NON IL RIUSO DI QUELLE CHE CI SONO ──────────
-- La strada a costo zero sarebbe riportare quelle righe a `stato = 'da_inviare'` e
-- lasciar fare a `riprendiInvitiSospesi`. Non si fa, per due ragioni.
--
-- 1. `inviato_il` e `resend_message_id` SONO UNA PROVA. Sono la sola risposta
--    possibile alla frase «non mi è mai arrivato niente»: *è stata consegnata al
--    provider il 22/08 alle 08:11:03 con il messaggio X*. Il ramo di successo di
--    `spedisci` li sovrascrive. Riusarli per la seconda consegna cancellerebbe il
--    solo dato che permette di distinguere «mai spedita» da «spedita e non letta» —
--    e con 30 famiglie che chiamano la segreteria, è la differenza fra sapere e
--    tirare a indovinare.
-- 2. `tentativi` conta i FALLIMENTI, e ha un tetto (`MAX_TENTATIVI_INVITO`).
--    Incrementarlo per una consegna riuscita significherebbe consumare i tentativi
--    di una riga sana.
--
-- `rigenerazioni` serve anche da CLAIM: la route la incrementa con un
-- compare-and-swap prima di toccare la password, così un doppio clic — o due
-- operatrici sulla stessa sede — non spruzzano due password alla stessa famiglia,
-- dove la seconda invaliderebbe la prima.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.iscrizioni_inviti_credenziali
  ADD COLUMN IF NOT EXISTS rigenerato_il timestamptz,
  ADD COLUMN IF NOT EXISTS rigenerazioni smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rigenerazione_message_id text;

COMMENT ON COLUMN public.iscrizioni_inviti_credenziali.rigenerato_il IS
  'Quando le credenziali sono state RIMANDATE (seconda consegna). `inviato_il` resta la prova del PRIMO recapito e non si sovrascrive mai.';
COMMENT ON COLUMN public.iscrizioni_inviti_credenziali.rigenerazioni IS
  'Quante volte le credenziali sono state rimandate. Fa anche da claim (compare-and-swap) perché due richieste concorrenti non consegnino due password alla stessa persona.';

-- Il conteggio giornaliero del tetto guarda `inviato_il`; le rigenerazioni sono
-- email vere e consumano la stessa quota, quindi l'indice serve a entrambe le
-- letture. Parziale: le righe mai rigenerate sono la maggioranza e non interessano.
CREATE INDEX IF NOT EXISTS iscrizioni_inviti_rigenerato_il_idx
  ON public.iscrizioni_inviti_credenziali (rigenerato_il)
  WHERE rigenerato_il IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA (DOPO l'apply)
--
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_name = 'iscrizioni_inviti_credenziali'
--      and column_name in ('rigenerato_il','rigenerazioni','rigenerazione_message_id');
--   -- 3 righe; rigenerazioni smallint default 0
--
--   -- la prova del primo recapito è intatta:
--   select count(*) from iscrizioni_inviti_credenziali where inviato_il is not null;
--   -- 67, come prima
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   drop index if exists public.iscrizioni_inviti_rigenerato_il_idx;
--   alter table public.iscrizioni_inviti_credenziali
--     drop column if exists rigenerato_il,
--     drop column if exists rigenerazioni,
--     drop column if exists rigenerazione_message_id;
-- ═══════════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
