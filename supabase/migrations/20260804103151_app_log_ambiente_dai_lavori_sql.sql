-- ═══════════════════════════════════════════════════════════════════════════════
-- `app_log.ambiente` NON PUÒ RESTARE NULL QUANDO A SCRIVERE È UN LAVORO pg_cron
-- (rilievo T12-F4, rimisurato il 2026-08-04)
--
-- ⚠️ NON APPLICATA dall'agente che l'ha scritta. La applica il coordinatore dopo averla
--    mostrata al titolare: in produzione ci sono 299 domande d'iscrizione (misurate il
--    2026-08-04; CLAUDE.md ne dichiara ancora 227, che era il numero del 31 luglio) e 152
--    codici fiscali di minori.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- LA MISURA (produzione, 2026-08-04):
--   · 6 righe su 1263 hanno `ambiente IS NULL`;
--   · tutte e 6 hanno `sorgente='server'`, `livello='info'`, `evento='gdpr'`,
--     `app_versione IS NULL`, `request_id IS NULL`;
--   · gli orari coincidono ESATTAMENTE con due job pg_cron — `iscrizioni-sanitari`
--     (`47 4 * * *` → le righe 04:47) e `app-log-bonifica-pii` (`11 5 * * 1` → 05:11 di
--     lunedì) — e il loro `contesto->>'esito'` è quello che le funzioni scrivono.
--
-- IL RILIEVO ERA STATO ARCHIVIATO COME FALSO PERCHÉ «ZERO RIGHE HANNO sorgente='sql'».
-- Quella query non poteva restituire altro che zero, e per DUE ragioni indipendenti scritte
-- nello schema stesso:
--   · `app_log_sorgente_check` → CHECK (sorgente = ANY (ARRAY['server','client']));
--   · `sorgente` ha DEFAULT 'server'.
-- Cioè `sorgente='sql'` è un valore VIETATO: cercarlo per smentire il rilievo è una
-- tautologia, non una misura. La colonna che distingue davvero è `ambiente`, ed è NULL.
--
-- LA CAUSA RADICE: sei funzioni `SECURITY DEFINER` fanno
--   INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
-- OMETTENDO `ambiente` — che non ha default e resta NULL. Sono
--   app_log_bonifica_pii_tick, audit_docente_retention_tick, iscrizioni_retention_http,
--   iscrizioni_retention_sorveglia, iscrizioni_retention_tick, iscrizioni_sanitari_tick.
-- Solo `app_log_registra` (la RPC che chiama `appLog` da Node) valorizza la colonna, perché
-- il valore glielo passa il processo: `ambienteCorrente()` (`src/lib/logging/ambiente.ts`)
-- legge `VERCEL_ENV`, che dentro Postgres non esiste.
--
-- PERCHÉ NON È INNOCUO. Chi indaga un guasto filtra `WHERE ambiente = 'production'` — è il
-- primo filtro, ed è quello che il commento in `ambiente.ts` descrive come il modo in cui si
-- legge questa tabella alle tre di notte. Quelle righe cadono fuori da quel filtro. E non
-- sono righe qualunque: sono l'UNICA prova che la rimozione dei dati sanitari dei minori
-- (`iscrizioni_sanitari_tick`) e la bonifica PII di `app_log` sono girate davvero. È il caso
-- della regola 5 di AGENTS.md alla lettera — senza il log del successo, «nessuna riga» non
-- distingue «tutto a posto» da «non è mai partito niente». Con `iscrizioni_retention_sorveglia`
-- (che gira ogni ora ed esiste per DARE L'ALLARME) il costo sarebbe un allarme invisibile.
--
-- LA CORREZIONE STA IN UN POSTO SOLO — ed è deliberato. Riscrivere le sei funzioni una per una
-- è la forma di rimedio che questo repo ha già pagato caro (memoria del 2026-08-01: «una regola
-- valida per due strade deve vivere in un posto solo»; lì un OTP su quattro era rimasto
-- indietro). Un DEFAULT sulla colonna copre le sei di oggi E la settima che qualcuno scriverà
-- il mese prossimo senza aver letto niente di tutto questo. Nessuna funzione viene ridefinita
-- da questa migrazione: chi passa `ambiente` esplicitamente (`app_log_registra`) non se ne
-- accorge nemmeno, perché un DEFAULT si applica solo alla colonna OMESSA.

-- ─── LA PRIMA STESURA NON POTEVA FUNZIONARE, E VALE LA PENA DIRE PERCHÉ ─────
--
-- La versione scritta dall'agente apriva con:
--     ALTER DATABASE <corrente> SET app.ambiente = 'production'
-- così che il DEFAULT potesse leggere `current_setting('app.ambiente')` e il database
-- dichiarasse il proprio ambiente da sé — con la bella proprietà che un database DIVERSO
-- (il progetto E2E della CI) non avrebbe mai potuto ereditare 'production' per sbaglio.
--
-- Misurato al momento di applicarla:
--     ERROR: 42501: permission denied to set parameter "app.ambiente"
--     SELECT rolsuper FROM pg_roles WHERE rolname = current_user  →  false
-- Su Supabase il ruolo `postgres` NON è superuser, e impostare un parametro custom a livello
-- di database richiede quel privilegio. Non è un permesso che manca e si può chiedere: è una
-- strada chiusa dalla piattaforma.
--
-- Quindi il valore diventa un LETTERALE, e con esso arriva un limite che va scritto qui
-- invece che scoperto fra sei mesi: **questa migrazione è vera solo per il database su cui
-- viene applicata**. Se un giorno qualcuno la applicherà al progetto E2E — che oggi non è
-- migrato, ed è documentato in CLAUDE.md — quel database comincerà a scrivere 'production'
-- nei propri log mentendo. Il rimedio, quel giorno, è una riga: cambiare il default lì.
-- Il `COMMENT ON COLUMN` qui sotto lo dice a chi guarderà lo schema, che è l'unico posto in
-- cui qualcuno lo leggerà davvero.

-- 1. Il DEFAULT, con il valore che questo database ha davvero.
ALTER TABLE public.app_log
  ALTER COLUMN ambiente
  SET DEFAULT 'production';

COMMENT ON COLUMN public.app_log.ambiente IS
  'Ambiente che ha scritto la riga. Da Node lo passa il processo (VERCEL_ENV, via '
  'ambienteCorrente()); dalle funzioni SQL dei job pg_cron nessuno lo passava e restava NULL '
  '- cioe fuori dal filtro WHERE ambiente = ''production'' con cui questa tabella si legge. '
  'Il DEFAULT lo copre. ATTENZIONE: il valore e un LETTERALE, perche ALTER DATABASE SET '
  'richiede il superuser che su Supabase non abbiamo. Se questa migrazione viene applicata a '
  'un database che NON e la produzione (per esempio il progetto E2E della CI), il default va '
  'cambiato li, o quel database scrivera ''production'' nei propri log mentendo.';

-- 2. Le righe già scritte. Sono 6, sono log (nessun dato personale: `contesto` contiene solo
--    `esito` e un CONTEGGIO), e restano invisibili per sempre al filtro per ambiente se non le
--    si tocca. Il `WHERE` è volutamente stretto: solo ciò che è già NULL, mai una riga che un
--    ambiente ce l'ha. Idempotente — rieseguirla non trova più niente.
UPDATE public.app_log
   SET ambiente = 'production'
 WHERE ambiente IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COME SI VERIFICA CHE ABBIA FUNZIONATO (da eseguire DOPO l'applicazione):
--
--   -- (a) nessuna riga orfana resta, e il default è in piedi:
--   SELECT count(*) FILTER (WHERE ambiente IS NULL) AS orfane FROM public.app_log;   -- attesa: 0
--   SELECT column_default FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='app_log' AND column_name='ambiente';
--
--   -- (b) LA PROVA VERA, che non è (a): (a) resterebbe verde anche se il default non
--   --     scattasse mai sulle INSERT delle funzioni. Si guarda la PROSSIMA riga scritta da un
--   --     lavoro pg_cron — `iscrizioni-sanitari` gira ogni notte alle 04:47 UTC:
--   SELECT creato_il, evento, ambiente
--     FROM public.app_log
--    WHERE fingerprint IN ('cron:iscrizioni-sanitari', 'cron:app-log-bonifica-pii')
--      AND creato_il > now() - interval '2 days'
--    ORDER BY creato_il DESC;
--   -- attesa: `ambiente = 'production'` su una riga creata DOPO l'applicazione.
--   -- Finché questa (b) non è stata guardata con i propri occhi, la correzione è dichiarata,
--   -- non dimostrata.
-- ═══════════════════════════════════════════════════════════════════════════════
