-- =============================================================================
-- `max(evasa_il)` SULLA MADRE NON È PIÙ LA BASE DI UN TERMINE DI LEGGE.
--
-- ─── PERCHÉ QUESTA MIGRAZIONE NON CAMBIA UNA RIGA DI CODICE ─────────────────
-- Perché non deve. Il corpo di `candidature_ricalcola_stato` resta identico a
-- quello applicato con `20260820020000`: continua a scrivere `max(evasa_il)`
-- sulla candidatura, e va bene che lo faccia.
--
-- Quello che cambia è CHI SI FIDA DI QUEL VALORE. Il commento della migrazione
-- precedente diceva, testualmente:
--
--     «La correzione onesta sarebbe la conservazione per riga di sede.
--      Quando la si farà, questa colonna diventerà derivata e questo
--      commento si potrà cancellare.»
--
-- La si è fatta, il 2026-08-20: `/api/gdpr/retention-candidature` legge le
-- righe di sede e calcola la scadenza per riga, prendendo la PIÙ LONTANA.
--
-- ⚠️ UNA MIGRAZIONE APPLICATA NON SI RISCRIVE. Il file `20260820020000` è già
-- girato in produzione, e cambiargli il testo significherebbe che lo storico
-- racconta una cosa che non è mai stata eseguita. Perciò la correzione del
-- commento sta qui, in una migrazione nuova, e chi legge quella vecchia arriva
-- a questa dal commento della funzione.
--
-- ─── IL CASO CHE HA MOSSO TUTTO ─────────────────────────────────────────────
-- Aversa rifiuta a novembre, Giugliano approva a dicembre, la candidatura è
-- arrivata a gennaio. L'aggregato `stato` vale `approvata`, quindi con la regola
-- della colonna il termine decorreva dalla RICEZIONE: cancellazione a gennaio,
-- cioè DUE MESI dopo il rifiuto di Aversa invece dei dodici promessi
-- dall'informativa. Il verbale di quel rifiuto spariva prima del dovuto.
--
-- Nei casi non misti non cambia niente — tutte rifiutate → l'ultima decisione,
-- identico a `max(evasa_il)`; tutte approvate o mai valutate → la ricezione — e
-- questo è il motivo per cui non è stata riscritta nessuna riga dell'informativa:
-- la regola nuova conserva di più, mai di meno, e una promessa che non si
-- riduce non va rinegoziata.
--
-- ─── COSA RESTA A CARICO DI QUESTA COLONNA ──────────────────────────────────
-- L'interfaccia: il badge, l'elenco, «evasa il». Per quello `max()` è la
-- risposta giusta — «l'ultima volta che qualcuno ha deciso qualcosa su questa
-- pratica» — e non c'è più nessun termine di legge appeso a un valore che, per
-- costruzione, ne può dichiarare uno solo su tre.
-- =============================================================================

comment on function public.candidature_ricalcola_stato() is
  'Aggrega gli stati delle righe di sede sulla candidatura. `evasa_il` è `max()` delle decisioni, e dal 2026-08-20 è un valore per l''INTERFACCIA, non la base di un termine di conservazione: il cron `/api/gdpr/retention-candidature` calcola la scadenza PER RIGA DI SEDE e prende la più lontana, perché una candidatura rivolta a tre plessi porta tre decisioni e questa colonna ne può dichiarare una sola. Vedi la migrazione 20260820084800.';

comment on function public.candidatura_garantisci_sede() is
  'Garantisce che ogni candidatura abbia almeno la riga di sede del suo plesso di primo arrivo, con la DECISIONE INTERA (stato, data, autore, motivo) e non il solo stato. Il cockpit filtra dalle righe di sede: una candidatura senza righe è invisibile a tutti, non solo meno visibile. Dal 2026-08-20 quelle righe sono anche ciò da cui decorre la conservazione: vedi la migrazione 20260820084800.';
