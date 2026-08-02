-- =============================================================================
-- L'OBLIO NON DEVE POTER NASCERE SENZA SEDE — e la prova del consenso non deve
-- conservare un indirizzo IP per sempre. (Privacy W1 · W11 · W5, 2026-07-31)
--
-- CONTESTO. Dal 2026-07-29 le sedi reali sono TRE. `scuolaUnicaReale()` — l'ultimo
-- anello di sette catene `X ?? Y ?? scuolaUnicaReale(…)` — restituisce `null` per
-- costruzione quando le sedi sono più d'una: da quel giorno quei `??` non
-- ripiegano più, producono `NULL`.
--
-- 1) richieste_cancellazione.scuola_id → NOT NULL
--    Una richiesta con `scuola_id NULL` è un DIRITTO BLOCCATO, non un dettaglio:
--    non compare in nessun pannello di Direzione (`.in('scuola_id', plessi)`
--    scarta i NULL), la POST di evasione la nega (sede nulla ⇒ 403, e deve
--    negarla: l'anonimizzazione è irreversibile) e l'indice unico parziale su
--    `stato='pending'` impedisce di ripresentarla. Il genitore continua a leggere
--    «richiesta in corso» e nessuno la vede mai.
--    Il codice ora ricava la sede dai FIGLI e RIFIUTA la richiesta (422) se resta
--    indeterminabile (`src/lib/gdpr/sede-richiesta.ts`); questo vincolo è la rete
--    sotto: se un domani un terzo canale tornasse a scrivere NULL, fallirebbe
--    subito e a voce alta invece di produrre una riga fantasma.
--    Verificato prima di applicare: 0 righe in tabella (la tabella è vuota).
--
-- 2) enrollment_submissions.scuola_id → NOT NULL
--    Stesso schema, su dati VERI: qui ci sono le domande di iscrizione compilate
--    dalle famiglie, con i dati dei minori. Una riga senza sede non sarebbe
--    visibile a NESSUNA Direzione — dati di un bambino raccolti e mai più
--    guardati da nessuno. `POST /api/iscrizione` risponde già 400 quando la sede
--    è ambigua, quindi il vincolo non toglie niente a chi si iscrive: rende solo
--    impossibile il caso silenzioso.
--    Verificato prima di applicare: 166 righe, 0 con `scuola_id` nullo e 0 con
--    una sede inesistente in `schools`.
--
-- 3) consensi-retention — l'IP della prova di consenso scade
--    `consensi_accettazioni` conserva `ip` e `user_agent` di chi ha accettato
--    privacy e Termini. Il fatto e la VERSIONE accettata sono la prova (art. 7 §1
--    GDPR, art. 1341 c.c.); l'indirizzo IP è un dato personale (art. 4 §1) che la
--    corrobora nei mesi in cui una contestazione può nascere, non per sempre.
--    Job mensile che azzera i due soli campi oltre i 12 mesi — stessa finestra e
--    stesso stile di `news-retention` (20260720200000). La riga resta: continua a
--    dire COSA è stato accettato e QUANDO.
--    Complemento applicativo: `src/lib/gdpr/consensi-oblio.ts`, agganciato a
--    `anonimizzaParent` e ad `admin/gdpr/erase`, fa lo stesso scrub subito per
--    chi chiede la cancellazione dell'account.
--    Verificato prima di applicare: 0 righe in tabella (nessuna onboarding ancora).
--
-- Il DB E2E della CI è un progetto separato e NON migrato: non ha pg_cron (il
-- blocco DO … EXCEPTION lo protegge) e resterà senza questi NOT NULL, dove il
-- codice degrada già come sempre (PGRST204 / 42703).
-- =============================================================================

-- ── 1) Sede obbligatoria sulle richieste di cancellazione ────────────────────
ALTER TABLE public.richieste_cancellazione
  ALTER COLUMN scuola_id SET NOT NULL;

COMMENT ON COLUMN public.richieste_cancellazione.scuola_id IS
  'Sede competente a evadere la richiesta. NOT NULL dal 2026-07-31: una richiesta senza sede è invisibile a ogni Direzione, inevadibile e — per l''indice unico parziale su stato=''pending'' — irripresentabile. La sede si ricava dai figli del genitore (src/lib/gdpr/sede-richiesta.ts), mai da "quante sedi esistono".';

-- ── 2) Sede obbligatoria sulle domande di iscrizione ─────────────────────────
ALTER TABLE public.enrollment_submissions
  ALTER COLUMN scuola_id SET NOT NULL;

COMMENT ON COLUMN public.enrollment_submissions.scuola_id IS
  'Sede a cui è indirizzata la domanda. NOT NULL dal 2026-07-31: una riga senza sede non compare a nessuna Direzione, cioè dati di un minore raccolti e mai più guardati da nessuno. POST /api/iscrizione risponde 400 quando la sede è ambigua.';

-- ── 3) consensi-retention — via l'IP dopo 12 mesi, la prova resta ────────────
-- Idempotente (unschedule-se-presente). Protetto per il DB E2E della CI, che non
-- ha pg_cron. Si aggiornano SOLO le righe che hanno ancora qualcosa da togliere,
-- così il job non riscrive ogni mese l'intera tabella.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'consensi-retention';
  PERFORM cron.schedule(
    'consensi-retention',
    '23 4 1 * *',
    $cron$ UPDATE public.consensi_accettazioni
              SET ip = NULL, user_agent = NULL
            WHERE accettato_il < now() - interval '12 months'
              AND (ip IS NOT NULL OR user_agent IS NOT NULL); $cron$
  );
EXCEPTION WHEN OTHERS THEN null;
END $$;

COMMENT ON COLUMN public.consensi_accettazioni.ip IS
  'Indirizzo IP dell''accettazione: corrobora la prova, non la costituisce. Azzerato dall''oblio del genitore (src/lib/gdpr/consensi-oblio.ts) e dal job pg_cron consensi-retention dopo 12 mesi.';
COMMENT ON COLUMN public.consensi_accettazioni.user_agent IS
  'User-agent dell''accettazione. Stesso trattamento di `ip`: oblio immediato su richiesta, retention a 12 mesi.';

NOTIFY pgrst, 'reload schema';
