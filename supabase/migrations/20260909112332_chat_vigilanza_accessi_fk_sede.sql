-- ════════════════════════════════════════════════════════════════════════════
-- VIGILANZA CHAT — `scuola_id` prende il suo riferimento
-- ════════════════════════════════════════════════════════════════════════════
--
-- La migrazione `20260909111537` ha creato `chat_vigilanza_accessi` con tutte le
-- colonne uuid senza foreign key, motivandolo in testata: il registro deve
-- sopravvivere all'oblio GDPR dell'operatore e alla cancellazione del thread.
--
-- Il ragionamento vale per `operatore_id`, `thread_id` e `alunno_id`. NON vale
-- per `scuola_id`: una sede non si cancella e non si anonimizza. Il lock
-- `__tests__/architecture/fk-scuola-id.test.ts` l'ha detto con parole che vanno
-- riportate perche sono la ragione di questa migrazione: «e esattamente come
-- sono nate le 31 colonne senza FK: una alla volta, ognuna con una buona
-- ragione per rimandare».
--
-- `ON DELETE RESTRICT` implicito (nessuna azione dichiarata): cancellare una
-- sede che compare nel registro deve fallire, non svuotare la riga.
-- La colonna resta NULLABLE: sul ramo `esito = 'fuori-scope'` la sede non e nota
-- (e la conversazione di un'altra sede, non la si legge per scoprirlo), e un
-- NULL non e soggetto al vincolo.
--
-- IDEMPOTENTE: il vincolo si aggiunge solo se non c'e gia.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chat_vigilanza_accessi_scuola_id_fkey'
       AND conrelid = 'public.chat_vigilanza_accessi'::regclass
  ) THEN
    ALTER TABLE public.chat_vigilanza_accessi
      ADD CONSTRAINT chat_vigilanza_accessi_scuola_id_fkey
      FOREIGN KEY (scuola_id) REFERENCES public.schools(id);
  END IF;
END $$;

COMMENT ON COLUMN public.chat_vigilanza_accessi.scuola_id IS
  'Sede del bambino AL MOMENTO della lettura, denormalizzata: un trasferimento successivo non deve riscrivere la storia. Ha FK verso schools(id) — a differenza delle altre colonne uuid di questa tabella, che ne sono prive per sopravvivere all''oblio GDPR: una sede non si cancella. NULL sul ramo esito=''fuori-scope'', dove la sede non e nota.';
