# Sintesi finale — da incollare in **una** chat nuova, quando i 20 report sono depositati

> Questo non è un tester. È il passo che trasforma venti report in **una** lista di lavoro.
> Si lancia una volta sola, alla fine, in una chat pulita.

---

## Prompt da incollare

```
Sei l'ultimo passaggio del collaudo manuale di Kidville. I tester hanno finito e hanno
depositato i loro report in `docs/collaudo/risultati/`. Il tuo compito non è collaudare: è
mettere insieme quello che hanno trovato e dirmi in che ordine si sistema.

Leggi `docs/collaudo/README.md` per il contesto, poi TUTTI i file in
`docs/collaudo/risultati/`. Non modificare codice, non committare, non scrivere sul database.

Fai questo, in quest'ordine:

1. **Inventario.** Quali tester hanno consegnato e quali no. Per ognuno: verdetto e conteggi
   dal blocco YAML in testa al report. Una tabella sola.

2. **Deduplica.** Lo stesso difetto arriva spesso da tre tester con tre nomi diversi (il
   backend lo vede come 500, il frontend come pagina bianca, l'osservabilità come catch muto).
   Uniscili in un rilievo solo, citando tutti i tester che l'hanno visto: la convergenza di
   più tester su un difetto è un segnale di gravità, non una ripetizione da tagliare.

3. **Verifica adversariale dei bloccanti.** Per OGNI rilievo dichiarato `bloccante`, prova a
   smontarlo: leggi il codice citato, controlla se è già coperto da un test, cerca in
   `docs/audit/` se era già stato misurato e smontato. Un bloccante che non regge alla
   verifica va declassato o eliminato, dicendo perché. In questo repo, in un audit precedente,
   48 rilievi su 188 non hanno retto: aspettati che una parte cada.

4. **Causa radice comune.** Cerca i difetti che sono lo stesso errore ripetuto in posti
   diversi. La lezione già pagata qui: *una regola valida per due strade deve vivere in un
   posto solo* — POST e PUT, tasks e avvisi, 1 OTP su 4. Se trovi un difetto in un posto,
   chiedi sempre: dove altro vive la stessa strada?

5. **Piano di correzione**, ordinato per: (a) bloccanti su dati di minori o sicurezza,
   (b) altri bloccanti, (c) gravi, (d) minori, (e) warning che vale la pena chiudere ora.
   Per ogni voce: cosa si tocca (`file:riga`), qual è la correzione minima, quale test o lock
   impedisce la regressione, e se serve una migrazione.

6. **Cosa NON è stato collaudato.** Somma le sezioni `NON VERIFICATO` dei report e dimmi che
   rischio resta scoperto se si rilascia adesso. Questa sezione è obbligatoria: è quella che
   il titolare deve leggere prima di decidere.

Scrivi il risultato in `docs/collaudo/risultati/000-SINTESI.md`, e in chat dammi solo:
il conteggio per gravità, i bloccanti in tre righe l'uno, e la tua risposta a una domanda —
**si rilascia o no?** — con il perché.

Vincoli: nessun dato personale e nessun segreto nel documento (il repo è pubblico); le voci
smontate si citano comunque, con la prova, così nessuno le riapre fra un mese.
```

---

## Dopo la sintesi

Il documento `risultati/000-SINTESI.md` è l'ingresso naturale della pipeline di correzione:

```
/ship-cycle correggi i difetti bloccanti e gravi elencati in docs/collaudo/risultati/000-SINTESI.md
```

`/ship-cycle` fa il suo giro (piano → esecutori → 11 tester → correzione) e non si ferma finché il
gate non è verde. Ricorda che **merge, deploy e migrazioni chiedono l'approvazione del titolare,
uno per uno** (`CLAUDE.md`), e che la cartella `risultati/` non va su GitHub.
