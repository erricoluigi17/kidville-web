# Storici: impaginazione per giorno e contenuti di classe una volta sola

Approvato dall'utente il 18 ottobre 2026 (approccio A di tre). Corregge due difetti delle stampe
degli storici segnalati dalla segreteria: il file «non è leggibile» e la lezione/attività compare
una volta per ogni bambino anche quando è identica per tutta la classe.

## Il problema, misurato

Riproduzione con dati sintetici e il motore vero (`creaPdfStorico`):

| Stampa | Contenuto | Pagine oggi |
|---|---|---|
| Registro delle lezioni | 10 giorni × 5 lezioni | 34 |
| Attività svolte (diario) | 10 giorni × 2 attività × 18 bambini | 182 |

Ogni registrazione è una scheda «Registrazione N» con un campo per riga, vuoti compresi
(«Alunno: —», «Tipo firma: —»). Nel diario la stessa attività e la stessa nota di sezione sono
ripetute per ogni bambino.

In produzione, dal 1° settembre (solo conteggi): 7.749 righe di attività ma 740 distinte per
sezione e giorno; 203 righe con nota di sezione ma 14 testi distinti; 19 note individuali.
L'app delle educatrici salva l'attività di sezione su ogni bambino: l'accorpamento va fatto in
lettura, non cambiando come si scrive il diario.

Il registro della primaria tiene già la lezione di classe una volta sola dalla #237 (18/10,
`raggruppaPerAlunno` con il blocco «contenuti comuni di classe»): il file segnalato era con ogni
probabilità generato prima del rilascio. Resta bloccato dal test esistente
`storici-generazioni.test.ts` › «mette le lezioni comuni in testa una volta».

## 1. Dati: attività del diario accorpate (`adattatori/scolastici-diario.ts`)

Vale per le righe di tipo `attivita` (con o senza l'elenco `activities`) in `diario_attivita` e
`diario_completo`, solo nelle stampe **di classe** (`richiesta.alunnoId` assente). La stampa di un
solo alunno non cambia.

- **Chiave di accorpamento**: data, voce, inizio, fine, descrizione. Autrice e nota di sezione non
  fanno parte della chiave: i loro valori distinti si uniscono con «; ».
- **Riga di classe** (una per chiave, `_ambito: 'classe'`, `alunno` vuoto), nella posizione della
  prima occorrenza:
  - `valore` (Partecipazione): i bambini raggruppati per valore. Il gruppo più numeroso mostra
    solo il conteggio, gli altri i nomi:
    «Ha partecipato: 12 bambini · Con entusiasmo: Rossi Mario, Bianchi Luca».
    Se nessun valore è registrato: «18 bambini». Se il valore è unico: «Ha partecipato: tutti i 18 bambini».
  - `notaIndividuale`: le note non vuote come «Cognome Nome: nota», separate da « · ».
  - `notaSezione`, `autore`: valori distinti uniti.
- **Righe del singolo** (solo con `raggruppamento: 'alunno'`), una per bambino e attività, senza
  descrizione né nota di sezione: data, voce, inizio, fine, partecipazione, nota individuale,
  autrice. `raggruppaPerAlunno` le mette nella scheda del bambino; la riga di classe va nel blocco
  comune, come per il registro.
- Con `raggruppamento: 'classe'` le righe del singolo non si generano: la riga di classe le contiene già.
- **Log**: un `logEvento('registro', 'info', …)` con `operazione: 'storici/diario-accorpa'`, il numero
  di righe lette e di righe di classe prodotte. Nessun nome, nessun testo libero.

Excel eredita l'accorpamento senza altre modifiche di struttura.

## 2. Impaginazione per giorno (`impaginazione-pdf.ts`)

Sostituisce le schede «Registrazione N» (`schede()`), sia per le sezioni narrative (diario,
registro, compiti, firme, note, documenti didattici, valutazioni) sia per i «Dettagli delle
registrazioni» delle tabelle troppo larghe.

Preparazione delle colonne, in quest'ordine:

1. **Colonne vuote** su tutte le righe: tolte.
2. **Inizio + Fine**: se esistono entrambe diventano una colonna «Orario» («10:00–10:45»).
3. **Colonne costanti** su tutta la sezione (almeno 2 righe, mai le colonne di testo lungo):
   salgono in una riga sotto il titolo della sezione, «Classe: 3ª A · Destinazione: Classe».
4. **Nota di sezione** (`notaSezione`): mai in tabella; i valori distinti del giorno si stampano
   una volta sotto il titolo del giorno.

Colonne di testo lungo (prendono lo spazio, non salgono mai in testata): argomento, compiti,
dettaglio, descrizione, testo, nota/note, notaIndividuale, valore della partecipazione, obiettivi,
allegati, e ogni colonna con un valore oltre 120 caratteri o con un a capo.

Disegno:

- Se la sezione ha la colonna `data`: per ogni giorno un titolo («Lunedì 5 ottobre 2026»), le note
  di sezione del giorno, poi una tabella `autoTable` senza la colonna data. Altrimenti una tabella
  sola.
- Orientamento per sezione: verticale fino a 5 colonne, orizzontale oltre (area sicura
  orizzontale di circa 241 mm fra marchio e piede).
- Corpo 10 pt, `overflow: 'linebreak'`, intestazione ripetuta su ogni pagina; una riga lunga si
  può spezzare fra due pagine (`rowPageBreak: 'auto'`): nessun testo tagliato.
- Colonne brevi note (ora, orario, consegna, numero) strette; le lunghe si spartiscono il resto.
- A cambio pagina dentro un giorno: titolo della sezione e «Lunedì 5 ottobre 2026 (continua)».
- Le tabelle con più di 7 colonne brevi mantengono la tabella orizzontale; le colonne in eccesso e
  quelle lunghe vanno in una seconda tabella «Dettagli delle registrazioni» con la colonna «N.»
  che rimanda alla riga, impaginata con le stesse regole.

Restano invariati: testata con sede e periodo, aree sicure della carta intestata, indice,
numerazione, originali allegati.

## 3. Prove

`__tests__/lib/storici-pdf-impaginazione.test.ts`, dati sintetici:

- 50 lezioni (10 giorni × 5) in al massimo 8 pagine; ogni giorno ha il suo titolo;
- nessuna «Registrazione N»; nessuna colonna interamente vuota stampata («Tipo firma» assente se vuota);
- colonna costante in testata una volta («Classe: 3ª A»);
- testo lungo integro (90 passaggi presenti), corpo ≥ 10 pt, inchiostro nelle aree sicure.

`__tests__/lib/storici-scolastici.test.ts` (adattatore diario):

- 18 bambini × 2 attività × 10 giorni in stampa di classe → 20 righe di classe, partecipazione
  raggruppata, nota di sezione una volta;
- con `raggruppamento: 'alunno'` → righe di classe più righe del singolo senza descrizione;
- stampa di un solo alunno → invariata.

`__tests__/lib/storici-generazioni.test.ts`: il diario accorpato finisce nel blocco comune e le
schede dei bambini contengono solo le loro righe.

Il gate resta quello di progetto: eslint, tsc, vitest, build, E2E in CI.

## Fuori perimetro

- Il modo in cui l'app salva il diario (una riga per bambino): resta com'è.
- Modelli su misura per ogni categoria (approccio B, scartato).
- Struttura dell'Excel.

## Aggiornamento in implementazione (18/10)

- La nota di sezione non è più una colonna: l'adattatore la trasforma in una riga del giorno
  (`_nota_giorno`), una per giorno e testo, in tutte le voci del diario. Il PDF la stampa sotto il
  titolo del giorno; Excel e il blocco comune del dossier la vedono una volta.
- Nel dossier per alunno la riga di classe porta la partecipazione a soli conteggi; nomi e note
  individuali restano nelle schede dei singoli.
- L'autrice sale in testata quando è la stessa per tutta la sezione, non per singolo giorno.
- Oltre 7 colonne i dati brevi in eccesso vanno in «Altri dati», e le larghezze delle colonne
  sono calcolate: con 12 colonne `autoTable` riduceva l'argomento a un carattere (193 pagine).
