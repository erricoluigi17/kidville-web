# PR 4.9 · difetti secondari annotati (09/11/2026)

Trovati lavorando alla 4.9 e **non corretti** qui perché fuori dal perimetro. Nessuno blocca la PR.

1. **`__tests__/architecture/offline-html-nativo.test.ts` è rosso già sul ramo 4.8** («i due lock qui sopra hanno GIRATO»): fallisce
   identico con e senza le modifiche della 4.9. Da guardare a parte.
2. **`__tests__/a11y/testo-muted-allowlist.test.ts` è rosso già sul ramo 4.8**: `src/components/features/parent/FasciaModuliDaRifirmare.tsx`
   (4.8.6) dipinge testo con `text-kidville-muted` (2,51:1). Si sostituisce con `text-kidville-sub`.
3. **`parseBody` risponde un 400 generico quando `zod` rifiuta** un `correzione.motivo` troppo corto: il client vede «richiesta non
   valida», non `MOTIVO_OBBLIGATORIO`. Il dialogo impedisce già di inviare meno di 8 caratteri, quindi nessun utente ci arriva; resta
   per chi chiama l'API a mano. `correzioneDaCorpo` (che dà il codice) serve per le route che leggono il corpo a mano e non è usata da
   nessuna delle tre.
4. **Il dialogo di correzione non vale per le scritture fatte con `FormData`** (upload): `conCorrezioneNelCorpo` lascia la richiesta
   com'è. Oggi nessuna delle tre route collegate riceve `FormData`; chi collegherà una quarta route con upload deve passare la
   correzione in un campo del form.
5. **Le altre route che scrivono per lo staff su un anno chiuso (presenze, voti, diario…) non offrono la correzione**: restano al 409
   `ANNO_CHIUSO` senza dialogo, per scelta del piano (la 4.9 collega solo competenze, periodi di scrutinio e votazioni). Il lock
   `anno-correzione-wiring` lo dichiara con le eccezioni elencate.
6. **`ripristino-demo.sql` non cancella classi e frequenze** create dalla simulazione (solo conteggi): decisione a mano del titolare.

## Giro di correzione 1 (revisione finale) · annotati, non corretti

7. **S11 · `tasso-errore` a ondate con la guardia spenta.** Una riga per sede vera, occorrenze cumulate nel giorno UTC: con tre sedi vere la
   soglia di 25 si supera al 9° giro del tick, verso metà mattina, e l'esito è `degradato`. È un calcolo del revisore, non una misura. Già
   `degradato` per `anno` in quei giorni, quindi cambia poco. Da guardare se capita davvero.
8. **S12 · i gettoni creati e non usati restano fino alla scadenza** (10 minuti): gonfiano i conteggi di chi legge. Ricadono da soli.
9. **S15 · `conCorrezioneNelCorpo` non vale per `FormData`** (stesso punto del n. 4): nessuna delle tre route lo riceve oggi.
10. **Agosto, le route di scrittura dei docenti** (R-a): **CHIUSA nel giro 1-bis** (`bbff236b`). Le route con `requireDocente` che scrivono
    (POST/PUT/PATCH/DELETE) ora prendono il gate della sezione scrivibile (`assertSezioneScrivibile`, `assertAlunnoScrivibile`,
    `assertClasseNomeScrivibile`): 37 route nella prima lista (per file, sbagliata), poi 8 handler in più trovati dal lock per handler
    (`sezioni-scrivibili-coverage`, eccezioni solo in `SCRITTURE_DOCENTI_SENZA_GATE`). Prova rossa a guardia spenta nei test
    `docenti-agosto-*`. Resta vero, e va detto al titolare: la sola lettura dei docenti in agosto arriva soltanto con la guardia accesa
    (a guardia spenta il tick non cambia stato, quindi nessuna sezione è `in_chiusura`).
