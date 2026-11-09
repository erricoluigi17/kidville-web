# PR 4.8 · difetti secondari (non bloccanti)

Annotati durante la PR 4.8; nessuno perde dati di minori né rompe il gate. Da riprendere nella 4.9 o in una PR piccola.

1. **Client del calendario senza `anno_attivo_id`.** `calendario-context.tsx` e `anno-context.tsx` non usano il campo che la route porta dalla 4.8.4: dal 01/09 un docente cade sul predefinito. Nessun chiamante server usa `annoDiOggiPerChi`.
2. **`PassaggioLetto` non espone `da_anno_sede_id`.** Con due righe in `src/lib/anno/passaggio.ts` e una in `passaggio-risposte.ts` si può fare `assertAnnoSedeInScope` anche sull'anno vecchio per tutte le scritture (oggi solo nell'anteprima; il DB impone già la stessa sede).
3. **I nomi dei bambini nella pagina del passaggio** passano da `/api/admin/students?limit=1000` (porta con sé il codice fiscale nella risposta, scarica elenchi interi per 25 nomi). Meglio `GET …/passaggio/nomi?ids=` (staff, solo nome e cognome).
4. **Sette GET per i contatori** a ogni rilettura: far scrivere all'anteprima un `conteggi` stabile e leggerlo.
5. **Il commento in `src/lib/anno/errori.ts`** per `ANTEPRIMA_VECCHIA` e `RIGHE_DA_DECIDERE` dice «dettagli», ma i numeri escono a livello alto della risposta.
6. **`decidiAbbinamento`** (POST chat operatore) usa ancora `alunni.section_id`; `sezioniDiUtentePerGrado` mostra sezioni di anni passati; due `error` grezze in `scope.ts` (892, 1069) dicono «di un anno passato» (le riprende la 4.9).
7. **Gate staff esplicito** nella `page.tsx` del passaggio (oggi solo il layout admin, come `conferme`).
8. **Classe di partenza dei «nuovi»** non mostrata nella pagina (`classe_sezione` non valorizzata): compare «nessuna classe».
9. **Tendina docenti** elenca tutto lo staff, senza filtrare per ruolo.
10. **Lock `passaggio-lock`**: la prova del rosso è su testo finto, non su sorgenti veri mutati.
