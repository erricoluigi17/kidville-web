# Mensa: la segreteria aggiunge e annulla i pasti a qualunque ora — design

**Data:** 2026-10-12 · **Branch:** `feat/mensa-segreteria-prenotazioni` · **Richiesta del titolare, approvata in brainstorming**

## 1. Il problema, misurato

Segnalazione del titolare: *«La segreteria deve poter annullare e aggiungere le prenotazioni e i ticket
mensa anche fuori orario (non vedo proprio il pulsante)»*, poi *«la stessa cosa vale per poterli
aggiungere»*.

**Il server lo permette già, ed è provato dai test.** `POST` e `DELETE /api/mensa/prenotazioni`
saltano orario limite e blocco del saldo per `STAFF_FORZA = admin · coordinator · segreteria`, anche su
date passate, dentro la propria sede (`assertAlunnoInScope`), con scalo e riaccredito in transazione
(RPC `scala_ticket_e_prenota` / `riaccredita_ticket_e_disdici`). Lo provano
`__tests__/api/mensa-prenotazioni.test.ts` (segreteria oltre cutoff → 201 e 200; giorno passato con
cutoff vero).

**Quello che manca è l'interfaccia.**

- **Annullare**: nessuna schermata dello staff chiama la `DELETE`. L'unico chiamante è il calendario
  del genitore (`MensaCalendar`), che oltre l'orario mostra il lucchetto.
- **Aggiungere**: esiste solo la scheda «Inserisci ticket» di `/admin/mensa` — un modulo staccato
  (bambino → data → «Inserisci ticket (scala 1)»), che non mostra cosa il bambino ha già prenotato. Il
  Report cucina, dove la segreteria guarda chi mangia oggi, elenca i nomi senza alcun pulsante.

Produzione, sole `SELECT`, 2026-10-12: 1.289 prenotazioni; **83** inserite dalla segreteria (dal 07/09);
**61** disdette, **tutte** di genitori, **zero** dello staff.

## 2. Decisioni del titolare

1. I pulsanti stanno in **due** posti: la settimana del bambino e l'elenco del giorno nel Report cucina.
2. **Annulla chiede conferma** (finestra in pagina, mai `confirm()` nativo: vietato nel repo perché
   nella WebView Capacitor su iOS può non tornare). **Aggiungi no**: si rimedia con un «Annulla».

## 3. Approccio

Schermate **solo per lo staff**, **server invariato**. Scartati:

- *riusare `MensaCalendar` con un'opzione «staff»*: è costruito per il genitore (al 403 scrive
  `kv_student_id` in `localStorage`, lucchetto d'orario, blocco a saldo zero, catalogo `mensa`).
  Andrebbe biforcato in ogni ramo, col rischio di rompere la schermata delle famiglie;
- *far restituire i non prenotati all'API del report*: tocca un'API letta anche da cuoca e docenti,
  quando l'elenco degli iscritti ha già una sua chiamata (`/api/admin/students?stato=iscritto`).

## 4. Componenti

### 4.1 `src/lib/mensa/settimana.ts` (puro)

Aritmetica di date su stringhe `AAAA-MM-GG`, calcolata in UTC così che fuso e ora legale del browser
non spostino il giorno: `lunediDi(ymd)`, `piuGiorni(ymd, n)`, `giorniDellaSettimana(lunedi)` (7 date).
Il punto di partenza è `oggiRoma()` di `@/lib/mensa/cutoff`.

### 4.2 `src/lib/mensa/gestione-staff.ts` (puro)

- `RUOLI_GESTIONE_MENSA = ['admin', 'coordinator', 'segreteria']` e `gestisceMensa(ruolo)`: la stessa
  lista di `STAFF_FORZA` della route, che la importa da qui (una lista sola, non due da tenere uguali).
- `nonPrenotatiPerClasse(iscritti, prenotatiIds)`: raggruppa per `classe_sezione` gli iscritti non
  prenotati, ordinati per nome; un iscritto senza classe va in `'—'` come nel report.

### 4.3 `SettimanaMensaStaff` (nuovo, `src/components/features/admin/mensa/`)

Props `{ userId, alunno: { id, nome, cognome } }`.

- Carica la settimana: `GET /api/mensa/menu?alunno_id&from&to` e `GET /api/mensa/prenotazioni?alunno_id&from&to`.
- Navigazione ◀ ▶ e «Oggi»; mostra i soli giorni attivi o chiusi (come il genitore).
- Per ogni giorno: data, menù in breve, stato (prenotato / no), nota «inserito dalla segreteria» quando
  l'origine è quella, e **un** pulsante:
  - prenotato → **Annulla** → finestra di conferma *«Annullare il pasto di {nome} di {giorno}? Il ticket
    torna sul saldo.»* → `DELETE`;
  - non prenotato → **Aggiungi** → `POST` con `date: [giorno]`.
  - Nessun lucchetto d'orario, nessun blocco per giorno passato. Giorno con mensa chiusa: nessun pulsante.
- Saldo in alto; se `saldo ≤ 0` compare l'avviso che aggiungendo il saldo va in negativo.
- Dopo ogni azione ricarica la settimana; l'esito (o il motivo del rifiuto) compare in una riga `role="status"`.
- Pulsante della riga disabilitato mentre la sua richiesta è in volo.

### 4.4 `PrenotazioneSegreteria` (modificato)

Resta la colonna di ricerca. La colonna destra, al posto del modulo «un giorno», mostra
`SettimanaMensaStaff` del bambino scelto. La scheda si chiama **«Prenotazioni»** (it) / **«Bookings»** (en).

### 4.5 `MensaReport` (modificato)

Nuova prop `gestionePrenotazioni?: boolean` (default `false`): senza, il componente è **identico** a
oggi (cuoca, docenti). Con:

- accanto a ogni prenotato, pulsante ✕ **Annulla** (`aria-label` col nome) → stessa conferma → `DELETE`;
- in fondo a ogni classe, «＋ Aggiungi un bambino» apre l'elenco dei non prenotati di quella classe,
  ciascuno con **Aggiungi** → `POST`;
- compaiono anche le classi **senza prenotati** (dall'elenco iscritti), rispettando il filtro di sezione;
- gli iscritti arrivano da `GET /api/admin/students?stato=iscritto&scuola_id&limit=LIMITE_ELENCO_ALUNNI`,
  chiamata solo quando `gestionePrenotazioni` è vero;
- dopo ogni azione si ricaricano report e alternative (conteggio, conflitti allergie).

Chi la accende: la scheda «Report cucina» di `/admin/mensa` e `/admin/mensa/cucina`, con
`gestionePrenotazioni={gestisceMensa(role)}` dal ruolo di `useSessionIdentity`.

### 4.6 `ConfermaAnnullaPasto` (nuovo, piccolo)

Finestra su `Modal` di `@/components/ui/Modal` con «Annulla il pasto» e «Lascia com'è», condivisa da
4.3 e 4.5. Il focus torna al pulsante che l'ha aperta: lo fa già `Modal` (ricorda l'elemento
attivo all'apertura), e il pulsante non è disabilitato in quel momento.

## 5. Errori e log

- Il server registra già ogni prenotazione e disdetta (`origine: segreteria`) e, a parte, il saldo che
  va sotto zero: nessun dato personale.
- Client: il motivo del rifiuto (`esito.motivo`, `j.error`) si mostra accanto all'azione; un errore di
  rete mostra il messaggio generico e chiama `logClient` con uno slug (`mensa-staff-…`), senza nomi né uuid
  nel messaggio.
- Nessun `catch` muto, nessun `console.*`.

## 6. Test

- **Puri**: `settimana.ts` (domenica → lunedì precedente; cambio d'ora di fine ottobre; fine anno);
  `nonPrenotatiPerClasse` (raggruppa, esclude i prenotati, ordina, senza classe in `'—'`);
  `gestisceMensa` (cuoca, educator, genitore → falso).
- **Componenti** (vitest + testing-library, `fetch` simulato):
  - `SettimanaMensaStaff`: con oggi oltre l'orario e un giorno passato i pulsanti sono **attivi**;
    «Aggiungi» fa la `POST` giusta; «Annulla» apre la conferma e solo dopo «Annulla il pasto» fa la
    `DELETE` giusta; «Lascia com'è» non chiama niente; saldo ≤ 0 mostra l'avviso;
  - `MensaReport`: senza `gestionePrenotazioni` nessun pulsante e nessuna chiamata a `/api/admin/students`;
    con, «Annulla» → conferma → `DELETE`; «Aggiungi un bambino» elenca solo i non prenotati della
    classe e «Aggiungi» fa la `POST`; una classe senza prenotati compare;
  - touch target ≥ 44px sui pulsanti nuovi (estensione dei test di design esistenti).
- I test di design esistenti di `PrenotazioneSegreteria` e `MensaReport` restano verdi o si aggiornano
  dove il modulo «un giorno» sparisce.

## 7. Fuori perimetro

- Nessuna modifica di **comportamento** alle route, allo schema o alle RPC. L'unica riga di server
  toccata è in `mensa/prenotazioni/route.ts`: `STAFF_FORZA` diventa l'import di `RUOLI_GESTIONE_MENSA`
  (§4.2), stessi tre ruoli — un file `route.ts` di Next non può esportare altro che i metodi HTTP,
  quindi la lista condivisa deve stare in `src/lib`.
- Notifiche al genitore quando la segreteria aggiunge o annulla: oggi non esistono, non si introducono.
- Il calendario del genitore non si tocca.
- Collaudo con un clic vero in locale: il server `:3100` scrive sul database di **produzione**, quindi
  un «Aggiungi» di prova scalerebbe un ticket vero a un bambino vero. Si collauda con i test, con l'E2E
  in CI e con un controllo in sola lettura della pagina.
