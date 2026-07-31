-- ============================================================================
-- Ritrovare in fretta la domanda a cui appartiene un documento allegato
-- ============================================================================
--
-- COSA FA
--   Aggiunge un INDICE alla tabella delle domande di iscrizione
--   (`enrollment_submissions`), sulla colonna `data` — quella che contiene la
--   domanda compilata dalla famiglia. Un indice è come la rubrica in fondo a un
--   libro: non cambia una virgola del testo, serve solo a trovare la pagina
--   giusta senza sfogliarlo tutto.
--
-- PERCHÉ ADESSO
--   Da oggi, prima di aprire il documento d'identità allegato a una domanda, il
--   programma controlla A CHI appartiene quel documento: risale dal file alla
--   domanda che lo contiene e verifica che sia di una sede su cui la persona ha
--   diritto di lavorare. Prima quel controllo non c'era: la segreteria di
--   Aversa poteva aprire il documento d'identità di un bambino iscritto a
--   Giugliano (verificato sul campo il 31 luglio 2026). Ora il controllo c'è, e
--   questo indice serve a farlo costare praticamente nulla.
--
-- COSA NON FA
--   · non cancella, non modifica e non sposta NESSUN dato: le 239 domande
--     restano identiche, campo per campo;
--   · non cambia chi può vedere che cosa (permessi, RLS e funzioni non si
--     toccano);
--   · non tocca i file nel deposito documenti;
--   · non serve al controllo di sicurezza per funzionare — il controllo
--     funziona anche senza. Senza indice è solo più lento (e con 239 domande la
--     differenza non si nota nemmeno): per questo può essere applicata con
--     calma, e per questo la sua assenza non rompe l'ambiente di collaudo, che
--     non riceve le migrazioni.
--
-- SE VA STORTA
--   È l'operazione meno rischiosa che esista su un database: se non riesce, non
--   lascia niente a metà (una migrazione o passa tutta o non passa) e il
--   programma continua a funzionare esattamente come prima, controllo di
--   sicurezza compreso. Mentre viene creato, l'indice blocca per qualche
--   istante le SCRITTURE sulla tabella — cioè l'arrivo di nuove domande dal
--   modulo pubblico: su 239 righe si parla di frazioni di secondo, ma per
--   scrupolo si applica fuori dagli orari di punta.
--   Per tornare indietro basta una riga:
--     drop index if exists public.idx_enrollment_submissions_data;
-- ============================================================================

-- GIN con `jsonb_path_ops`: è la forma di indice che serve all'operatore di
-- contenimento `@>` — l'unico usato qui («quale domanda contiene questo
-- percorso di file?»). Rispetto al GIN predefinito è più piccolo e più veloce
-- proprio su `@>`; in cambio non serve alle ricerche per sola CHIAVE (`?`),
-- che qui non si fanno.
--
-- `if not exists` perché questo file deve poter essere riapplicato senza
-- effetti: su un database dove l'indice c'è già non fa nulla.
--
-- Nessun `concurrently`: le migrazioni girano dentro una transazione, che lo
-- vieta. Su 239 righe il blocco in scrittura è dell'ordine dei millisecondi.
create index if not exists idx_enrollment_submissions_data
    on public.enrollment_submissions
    using gin (data jsonb_path_ops);

comment on index public.idx_enrollment_submissions_data is
    'Risale dal percorso di un allegato (data->children[]->documento_path, data->adults[]->documento_path) alla domanda che lo contiene, con l''operatore di contenimento @>. Serve al gate di sede di admin/iscrizioni:GET?doc= (2026-07-31): senza, la verifica resta corretta ma legge tutta la tabella.';
