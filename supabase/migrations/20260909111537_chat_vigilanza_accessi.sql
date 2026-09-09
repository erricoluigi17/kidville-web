-- ════════════════════════════════════════════════════════════════════════════
-- VIGILANZA CHAT — il registro di chi ha letto le conversazioni altrui
-- ════════════════════════════════════════════════════════════════════════════
--
-- ─── IL DIFETTO ─────────────────────────────────────────────────────────────
-- `admin/chat/messages:GET` apre il CONTENUTO di una conversazione fra un
-- genitore e un'insegnante e non scrive niente: né riga di audit né log. Chi
-- ha ruolo `segreteria` puo leggere qualunque conversazione della propria sede
-- e non ne resta traccia da nessuna parte.
--
-- ─── LA MISURA (2026-09-09) ─────────────────────────────────────────────────
-- 409 conversazioni, 1.631 messaggi, di cui 1.577 nei 30 giorni precedenti.
-- Il contatore e passato da 1.608 a 1.631 in dieci minuti fra due query:
-- chi legge questa testata rifaccia il conteggio invece di copiarlo.
--
-- ─── LA DECISIONE DEL TITOLARE (2026-09-09) ─────────────────────────────────
-- La vigilanza resta SILENZIOSA: insegnante e genitore non vedono nulla, nessun
-- avviso in chat. In cambio ogni lettura finisce qui dentro, e il registro lo
-- legge SOLO la Direzione (`admin`, `coordinator`) — non la segreteria, che e
-- la parte sorvegliata. Nessuna esenzione: anche le letture della Direzione ci
-- finiscono.
--
-- ─── PERCHE NESSUNA FOREIGN KEY ─────────────────────────────────────────────
-- Stessa ragione di `conversazioni_sospensioni.sospesa_da`: il registro deve
-- sopravvivere alla cancellazione del thread e all'oblio GDPR dell'operatore.
-- Una FK `ON DELETE CASCADE` cancellerebbe la PROVA insieme all'oggetto, che e
-- l'esatto contrario di un registro di accountability (GDPR art. 5(2)).
--
-- ─── PERCHE `scuola_id` E DENORMALIZZATO ────────────────────────────────────
-- E la sede del bambino AL MOMENTO della lettura. Se domani il bambino viene
-- trasferito (`src/lib/sedi/trasferimento.ts`), la riga deve continuare a dire
-- dove stava quando e stata letta — non dove sta adesso. Serve anche a filtrare
-- il registro per sede senza join, cosa che `chat_threads` non permette perche
-- non ha `scuola_id`.
--
-- ─── PERCHE SOLO SELECT E INSERT, NEMMENO AL SERVICE-ROLE ───────────────────
-- Il registro e in sola aggiunta. Un UPDATE o un DELETE dall'applicazione non
-- deve essere possibile per SBAGLIO, non solo per policy: senza il GRANT non
-- esiste proprio la strada. La ritenzione (azzeramento di ip/user_agent/termine
-- a 12 mesi) gira come funzione SECURITY DEFINER, in una migrazione a parte.
--
-- ⚠️ IL `GRANT` QUI SOTTO NON BASTA, ed e documentato nella migrazione
--    successiva `20260909111608_chat_vigilanza_accessi_sola_aggiunta.sql`:
--    Supabase concede gia ALL a `service_role` per privilegio predefinito, e un
--    GRANT ristretto non toglie niente. Per restringere si REVOCA.
--
-- IDEMPOTENTE: `IF NOT EXISTS` ovunque, nessun dato scritto.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.chat_vigilanza_accessi (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operatore_id     uuid NOT NULL,
  operatore_ruolo  text NOT NULL,
  azione           text NOT NULL CHECK (azione IN ('lettura', 'ricerca')),
  esito            text NOT NULL DEFAULT 'ok' CHECK (esito IN ('ok', 'fuori-scope')),
  thread_id        uuid,
  alunno_id        uuid,
  scuola_id        uuid,
  n_messaggi       integer,
  termine          text,
  ip               text,
  user_agent       text,
  letto_il         timestamptz NOT NULL DEFAULT now()
);

-- L'elenco del registro, dal piu recente.
CREATE INDEX IF NOT EXISTS chat_vigilanza_accessi_quando_idx
  ON public.chat_vigilanza_accessi (letto_il DESC);

-- «Cosa ha letto questa persona».
CREATE INDEX IF NOT EXISTS chat_vigilanza_accessi_operatore_idx
  ON public.chat_vigilanza_accessi (operatore_id, letto_il DESC);

-- «Chi ha letto questa conversazione».
CREATE INDEX IF NOT EXISTS chat_vigilanza_accessi_thread_idx
  ON public.chat_vigilanza_accessi (thread_id, letto_il DESC);

-- Isolamento per sede della route di consultazione.
CREATE INDEX IF NOT EXISTS chat_vigilanza_accessi_sede_idx
  ON public.chat_vigilanza_accessi (scuola_id, letto_il DESC);

-- RLS accesa e ZERO policy: la tabella e raggiungibile solo dal service-role
-- (che la bypassa). Una tabella senza RLS in questo schema sarebbe leggibile
-- con la chiave anon pubblica via PostgREST. Il controllo d'accesso vive nel
-- gate applicativo `requireStaff(request, ['admin','coordinator'])`.
ALTER TABLE public.chat_vigilanza_accessi ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_vigilanza_accessi FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.chat_vigilanza_accessi TO service_role;

COMMENT ON TABLE public.chat_vigilanza_accessi IS
  'Registro in SOLA AGGIUNTA delle letture di vigilanza sulle conversazioni genitore-insegnante. Scritto da admin/chat/messages:GET e admin/chat/ricerca:GET; letto solo dalla Direzione (admin, coordinator). Nessuna FK: deve sopravvivere all''oblio GDPR e alla cancellazione del thread.';
COMMENT ON COLUMN public.chat_vigilanza_accessi.operatore_id IS
  'Chi ha letto. uuid di utenti.id, SENZA foreign key di proposito.';
COMMENT ON COLUMN public.chat_vigilanza_accessi.azione IS
  '«lettura» = ha aperto una conversazione; «ricerca» = ha cercato una parola in tutte le conversazioni della sede.';
COMMENT ON COLUMN public.chat_vigilanza_accessi.esito IS
  '«fuori-scope» registra il tentativo su una conversazione di un''altra sede: il gate ha gia identificato la persona, ed e esattamente cio che un registro serve a far vedere.';
COMMENT ON COLUMN public.chat_vigilanza_accessi.scuola_id IS
  'Sede del bambino AL MOMENTO della lettura, denormalizzata: un trasferimento successivo non deve riscrivere la storia.';
COMMENT ON COLUMN public.chat_vigilanza_accessi.termine IS
  'Solo per azione «ricerca»: la parola cercata. Sta qui e MAI nei log. Azzerata a 12 mesi dalla ritenzione.';
COMMENT ON COLUMN public.chat_vigilanza_accessi.ip IS
  'Azzerato a 12 mesi dalla ritenzione, come fa consensi-retention.';
