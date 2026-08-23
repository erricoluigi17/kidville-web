-- ═══════════════════════════════════════════════════════════════════════════════
-- CINQUE ACCENSIONI INVECE DI UNA — e perché il tetto non c'entrava niente.
--
-- ─── LA MISURA (2026-08-22, primo giro vero) ────────────────────────────────
-- Il cron ha lavorato 60 domande in 244 secondi e si è fermato con
-- `esito: 'tempo-scaduto'` e 50 domande in coda — a un tetto di 300 email che non
-- aveva nemmeno sfiorato (ne erano uscite 67). Letto dai timestamp di
-- `iscrizioni_inviti_credenziali`, l'intervallo fra un'email e l'altra:
--
--     mediano 3,35 s · medio 3,58 s · minimo 2,25 s · massimo 5,32 s
--
-- Costante, senza coda lunga. Una costante senza coda non è «una query ogni tanto
-- lenta»: è un NUMERO FISSO di andate-e-ritorni in serie — ~27-29 per domanda, di
-- cui Resend pesa ~350 ms (il 10%) e la pausa fra le email 150 ms (il 4,5%).
--
-- Restano 352 domande: ~20 minuti di lavoro, contro un `maxDuration` di 300 s. Il
-- collo di bottiglia non è mai stato il tetto, ed è per questo che alzare
-- `INVITI_AL_GIORNO` da 90 a 300 (il 2026-08-21) non ha spostato niente: il giro si
-- era fermato a 67.
--
-- ─── PERCHÉ 10 MINUTI, E PERCHÉ È UN VINCOLO E NON UN GUSTO ─────────────────
-- `riprendiInvitiSospesi` NON ha un claim: legge le righe `da_inviare`/`fallita` e
-- comincia a spedire. Due invocazioni contemporanee leggerebbero LE STESSE righe, e
-- `spedisci` con la password nulla la RIGENERA — la seconda email invaliderebbe la
-- password appena consegnata dalla prima. Un genitore chiuso fuori da una corsa fra
-- due cron, con in mano una password morta e nessun modo di saperlo.
--
-- Dieci minuti fra un'accensione e l'altra sono più dei 300 s di `maxDuration`:
-- due giri **non possono** sovrapporsi, per costruzione. La distanza è sorvegliata
-- da `__tests__/architecture/import-iscrizioni-giri-non-si-sovrappongono.test.ts`,
-- che la confronta con il `maxDuration` della route: se un domani qualcuno stringe
-- gli intervalli o allunga la durata, il gate diventa rosso prima della produzione.
--
-- Non `*/10` tutto il giorno: ogni giro rilegge le domande di tutte le sedi (5,8 s
-- solo di avvio, misurati), e soprattutto una password non arriva alle tre di notte.
-- Cinque accensioni fra le 10:10 e le 10:50 di Roma: ~350 domande al giorno, cioè la
-- coda residua si chiude in un giorno con margine sulla finestra che scade il 10/09.
--
-- ✅ APPLICATA il 2026-08-23 alle 03:28 UTC, DOPO il deploy in produzione del
-- conteggio giornaliero (`emailSpediteOggi`) — verificato `Ready` su Vercel prima
-- di premere. Verifica dopo l'apply:
--   select jobname, schedule, active from cron.job where jobname = 'iscrizioni-import-invio';
--   -- iscrizioni-import-invio | 10,20,30,40,50 8 * * * | true
--   get_advisors: 0 ERROR (207 INFO, 22 WARN, tutti preesistenti)
--
-- ⚠️ ORDINE DI RILASCIO, DA NON INVERTIRE. Questa migrazione va applicata SOLO DOPO
-- che è in produzione il conteggio giornaliero letto dal database
-- (`emailSpediteOggi` in `src/lib/iscrizioni/import/inviti.ts`). Prima di quello il
-- contatore del tetto era una variabile LOCALE all'invocazione: con cinque giri,
-- «300 al giorno» diventerebbe 300 per giro, cioè 1500 email in una mattina, e non
-- lo segnalerebbe niente.
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  -- Si toglie il vecchio schedule prima di rimetterlo: `cron.schedule` con lo stesso
  -- nome aggiorna, ma passare dall'unschedule esplicito rende leggibile il rollback.
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'iscrizioni-import-invio';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;

  PERFORM cron.schedule('iscrizioni-import-invio', '10,20,30,40,50 8 * * *', $cron$ SELECT public.iscrizioni_import_invio_http(); $cron$);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (DOPO l'apply)
--
--   select jobname, schedule, active from cron.job where jobname = 'iscrizioni-import-invio';
--   -- 1 riga, '10,20,30,40,50 8 * * *', active = true
--
--   -- il giorno dopo: cinque battiti, non uno
--   select contesto->'campi'->>'esito', occorrenze, visto_l_ultima
--     from app_log
--    where evento = 'cron' and contesto->'campi'->>'operazione' = 'iscrizioni-import-invio'
--      and giorno = current_date;
--
--   -- e il tetto ha retto sull'INTERA giornata, non per giro:
--   select count(*) from iscrizioni_inviti_credenziali
--    where stato = 'inviata' and inviato_il >= date_trunc('day', now() at time zone 'Europe/Rome');
--   -- <= 300
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   select cron.unschedule(jobid) from cron.job where jobname = 'iscrizioni-import-invio';
--   select cron.schedule('iscrizioni-import-invio', '10 8 * * *', $cron$ SELECT public.iscrizioni_import_invio_http(); $cron$);
--   -- La sorveglianza in `src/lib/health/controlli.ts` non va toccata: la finestra di
--   -- 26 ore resta giusta in entrambi i casi, perché il lavoro è ancora giornaliero.
-- ═══════════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';
