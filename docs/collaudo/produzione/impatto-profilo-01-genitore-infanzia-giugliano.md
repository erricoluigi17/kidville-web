# Profilo 01 — genitore, infanzia (3-6), Kidville Giugliano

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

## Come si presentava l'app a questo profilo, giorno per giorno

**Dal 6 all'8 agosto** l'app ha servito la versione pubblicata la sera del 6. In quella versione
tutto ciò che un genitore poteva **mandare** dall'app non partiva: scrivere alla maestra, inviare un
modulo compilato, chiedere il codice per firmarlo, rispondere a un avviso, comunicare un'assenza.
Otto porte dell'area genitori rispondevano con un errore vuoto a **ogni** famiglia non sospesa per
morosità, e a schermo restava un messaggio generico di problema di rete. Nello stesso periodo
«Comunica un'assenza» era una funzione che non aveva mai funzionato per nessuno: il pulsante veniva
mostrato proprio alle famiglie **senza** figli in primaria — cioè a questo profilo — e non portava da
nessuna parte, perché chi lo premeva prendeva lo stesso errore vuoto di tutto il resto. Dietro
quell'errore il servizio era comunque riservato alla primaria e avrebbe rifiutato lo stesso, ma
quel rifiuto il genitore non arrivava nemmeno a leggerlo. Sulla stessa schermata il pulsante d'invio
stava in fondo alla pagina, difeso solo da uno spazio fisso contro la barra di navigazione: toccarlo
apriva il Diario. Con l'Alto Contrasto acceso i due campi del modulo erano bianchi su
bianco, e col telefono in inglese il rifiuto della data usciva in inglese, in una bolla di sistema
dentro un'app italiana.

**La sera dell'8 agosto alle 22:54** è entrato in `main` l'intero lavoro sulle assenze, e col deploy
che segue in produzione: le otto porte hanno ricominciato a rispondere, la comunicazione dell'assenza
è stata aperta a tutti e tre i gradi, e il pulsante d'invio ha ricevuto un piede tutto suo. Per
**un'ora, quarantaquattro minuti e diciassette secondi**, però, quel piede copriva il campo «Motivo»
sui telefoni fra 640 e 731 px: si toccava il campo dove lo si vedeva e si finiva sul pulsante che
invia. Col rilascio delle **00:38 del 9 agosto** la testata ha ceduto 250 px e il campo è tornato
sopra il piede.

**Dal 9 al 14 agosto** la produzione è cambiata **otto** volte, e una sola di quelle uscite ha toccato
qualcosa che questo profilo vede: l'**11 agosto alle 10:16**, sulla schermata pubblica dove si
sceglie il plesso del proprio figlio (riga 66). Restavano aperte due cose: un pezzo dell'app che non
arrivava lasciava la schermata su «Caricamento…» per sempre — senza messaggio e senza un pulsante per riprovare — e il
certificato che la famiglia si scaricava da sé.

**Il 15 e il 16 agosto** si concentra il resto. Alle 00:25 del 15 la schermata bloccata su
«Caricamento…» ha finalmente ricevuto un messaggio e un pulsante; alle 02:48 del 15 è partita per la
prima volta la conferma della domanda d'iscrizione, che fino a quel momento non era mai stata
spedita a nessuno. In quegli stessi due giorni il certificato scaricabile dalla scheda «Certificati»
usciva con una banda verde disegnata dal codice, la scritta «KIDVILLE SCHOOLS» al posto della
ragione sociale e, in calce, la firma di un «Dirigente Scolastico» — una figura che in una
cooperativa non esiste; e il modulo per autorizzare la gita non compariva, nemmeno quando la gita
c'era davvero. Tutto questo si chiude alle **11:31 del 16 agosto**. Il 17 agosto la produzione
cambia ancora due volte, all'1:06 e all'1:35, ma su cose che questo profilo non vede; dopo l'1:35
non cambia più, e gli ultimi quattro giorni del test girano su quella versione.

## I difetti che questo profilo poteva incontrare

> **Gli orari di questa tabella sono quelli in cui la correzione è entrata in `main`.** Il deploy
> concluso segue di qualche minuto, e non l'ho verificato: le durate che il documento afferma sono
> esatte, gli estremi sono anticipati di quei minuti.

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| 1 | Premevo «Invia» e non succedeva niente: usciva un errore generico di rete. Valeva per scrivere alla maestra, mandare un modulo compilato, chiedere il codice per firmarlo, rispondere a un avviso e comunicare un'assenza — otto porte dell'area genitori, per ogni famiglia non sospesa | bloccante | 08/08 22:54 | `f59854ab` | ⚠️ su `main`, ma **dedotta**: vedi la nota qui sotto |
| 2 | «Comunica un'assenza» c'era e non portava da nessuna parte: il pulsante veniva mostrato proprio a chi ha un bambino dell'infanzia, e premerlo restituiva lo stesso errore vuoto della riga 1. La funzione non era mai stata utilizzabile da nessuno — dietro l'errore il servizio era comunque riservato alla primaria, ma a quel rifiuto il genitore non arrivava | bloccante | 08/08 22:54 | `f59854ab` | ✅ su `main` |
| 3 | Toccavo il pulsante che invia l'assenza e mi ritrovavo sul Diario: il pulsante stava in fondo alla pagina, sotto la barra di navigazione | bloccante | 08/08 22:54 | `f59854ab` | ✅ su `main` |
| 5 | Toccavo il campo «Motivo» dove lo vedevo e finivo sul pulsante che invia: il campo era passato sotto la barra d'invio. In produzione dal rilascio delle 22:54 dell'8 a quello delle 00:38 del 9 | bloccante | 09/08 00:38 | `7ef10e87` | ✅ su `main` |
| 14 | Appena premuto, il pulsante principale diventava una macchia chiara illeggibile — proprio nel momento in cui si aspetta. Valeva per tutti i pulsanti principali dell'app, non solo per le assenze | fastidioso | 08/08 22:54 | `f59854ab` | ✅ su `main` |
| 15 | Con l'Alto Contrasto acceso i due campi del modulo erano bianchi su bianco; la conferma d'invio non veniva annunciata a chi usa lo screen reader, e il formato `gg/mm/aaaa` spariva appena si cominciava a scrivere | bloccante (in Alto Contrasto) | 08/08 22:54 | `f59854ab` | ✅ su `main` |
| 16 | Col telefono in inglese, la data rifiutata usciva in inglese — «Value must be … or later» — in una bolla di sistema dentro un'app italiana | fastidioso | 08/08 22:54 | `f59854ab` | ✅ su `main` |
| 20 | Un pezzo dell'app che non arrivava lasciava la schermata su «Caricamento…» per sempre: nessun messaggio, nessun pulsante per riprovare, nessuna via d'uscita che non fosse chiudere e riaprire | bloccante | 15/08 00:25 | `0e8480a3` | ✅ su `main` |
| 22 | Il certificato scaricato dalla scheda «Certificati» portava una banda verde disegnata dal codice, la scritta «KIDVILLE SCHOOLS» — che non è la ragione sociale della scuola — l'indirizzo stampato due volte e, in calce, la firma di un «Dirigente Scolastico» che in una cooperativa non esiste. Un foglio così, portato all'INPS o al datore di lavoro, non è un certificato | bloccante | 16/08 11:31 | `0974424a` | ✅ su `main` |
| 24 | Il modulo per autorizzare la gita non compariva, nemmeno quando la gita c'era; quando usciva aveva «Orario partenza» e «Rientro previsto» vuoti, e la notifica portava alla scheda sbagliata invece che al modulo | bloccante | 16/08 11:31 | `0974424a` | ✅ su `main` |
| 26 | Domanda d'iscrizione mandata dal modulo pubblico e firmata col codice: nessuna conferma, nessun riepilogo, niente. Restava il dubbio se fosse arrivata | bloccante | 15/08 02:48 | `b43a556e` | ✅ su `main` |
| 66 | Sulla schermata dove si sceglie il plesso del proprio figlio, il contorno fra una sede e l'altra non si vedeva: le tre sedi sembravano un blocco unico | fastidioso | 11/08 10:16 | `a9dcc6d8` | ✅ su `main` |

**La riga 1 è l'unica delle dodici che non ho potuto misurare, e va detto.** Il codice era corretto:
il difetto stava nel prodotto **compilato**, dove il compilatore trasformava in una stringa un ramo
dell'istruzione che decide se una famiglia è sospesa. Ho verificato che la versione del 6 agosto
contiene esattamente quella forma, e che il progetto si compila con lo strumento che produce
quell'effetto senza opzioni che lo escludano: la produzione era quindi coinvolta. Ma la prova diretta
sarebbe il pacchetto compilato di quel giorno, che non ho. È una deduzione solida, non una
misurazione come le altre undici.

Le ultime due righe (26 e 66) valgono per il genitore che in quei giorni ha usato il **modulo
pubblico d'iscrizione** per il 2026/27 — la stessa strada da cui, secondo l'inventario, sono
arrivate 387 domande. Chi non l'ha aperto non le ha incontrate.

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

- **n. 4** (toccando «Leggi l'informativa» partiva la comunicazione dell'assenza) — nella versione in
  produzione fino all'8 agosto quel collegamento **non esisteva in nessuna schermata dell'area
  genitori**: l'ho cercato in tutta l'area e non compare. È nato nella versione sotto collaudo.
- **n. 6** (il messaggio di rifiuto nascosto dietro il piede) e **n. 7** (una schermata e mezza di
  nulla dopo l'elenco) — sono nati dalle correzioni stesse e chiusi nello stesso rilascio: in
  produzione non ci sono mai stati. Nella versione del 6 agosto il messaggio d'errore sta dentro il
  modulo, sopra il pulsante, e il piede non esiste.
- **n. 8** (la barra verde che sparisce e il testo che risale nella Dynamic Island) e **n. 17** (il
  calendario che si apre da solo) — sono difetti di iPhone. Il test chiuso era su Google Play.
- **n. 9, 10, 11, 12** (l'assenza che sovrascriveva l'appello della maestra, l'annullamento che
  cancellava una presenza di un giorno qualunque, il motivo sanitario sovrascritto) — nessuno di
  questi poteva capitare a questo profilo: fino alle 22:54 dell'8 agosto il server **rifiutava ogni
  assenza** che non venisse da una famiglia della primaria, e da quel momento in poi erano già
  corretti. La prova sta nell'inventario: nessuna notifica di assenza comunicata, mai.
- **n. 13, 19, 31** e tutto ciò che riguarda la primaria — questo profilo non ha figli in primaria.
- **n. 18** (una data storta che fa cadere l'intera schermata, l'elenco storico senza anno) — è stato
  misurato sull'elenco delle assenze, che nella versione aperta a questo profilo **non c'era**: la
  schermata era un modulo di due campi e nient'altro.
- **n. 21** (con due figli il certificato usciva intestato al bambino sbagliato) — questo profilo ha
  un figlio solo.
- **n. 23** (certificato protocollato su due pagine) e **n. 25** (ogni scarico bruciava un numero di
  protocollo, e l'anno scolastico usciva sbagliato) — il certificato della famiglia **non aveva
  nessun numero di protocollo** fino al 16 agosto: nasceva nel telefono e si scaricava, e basta. In
  più il n. 25 accade solo fra la mezzanotte e le due del 1° agosto, cioè fuori dalla finestra del
  test.
- **n. 27-33** — sono le schermate della maestra.
- **n. 34-60** — sono i pannelli della segreteria e della Direzione. Questo profilo non vi ha accesso.
- **n. 61** (i dati anagrafici di un minore mandati a un servizio esterno) — la chiamata viveva
  soltanto nei tre moduli anagrafici del **pannello amministrativo**: ho verificato che nessun altro
  punto del prodotto la usava. Un genitore quei moduli non li apre.
- **n. 62-65, 67-71** — sono il modulo pubblico «Lavora con noi», cioè la strada di chi si candida
  per lavorare alla scuola, non quella di un genitore.
- **PARTE C.1** (la tabella pubblica per un'ora nella notte del 20 agosto) — contiene candidature di
  lavoro, non dati di famiglie; non se ne vede niente dentro l'app; e il suo commit non è su `main`.
- **PARTE B** per intero — invii automatici, email, log, fatturazione, migrazioni, pacchetto
  dell'app: reale e corretto, ma non visibile a schermo da un tester dell'app.

## Verifiche eseguite

Solo comandi di lettura. Nessun `git commit`, `add`, `push`, `checkout`; nessuna query al database.

1. `git show --stat --oneline <hash> | head -20` su **tutti** i commit citati
    (`f59854ab`, `7ef10e87`, `0e8480a3`, `0974424a`, `b43a556e`, `a9dcc6d8`) e su quelli che ho
    valutato ed escluso (`fcc51fc8`, `d7af75b6`, `65e3631c`, `0e0ba538`, `ddfe3b0e`, `aa048978`):
    esistono tutti.
2. `git branch --contains <hash> | grep -w main` sugli stessi: i sei citati sono **su `main`**.
    `ddfe3b0e` e `aa048978` **non lo sono** — coerente con l'inventario, ed è una delle ragioni per
    cui la PARTE C.1 resta fuori.
3. `git log --first-parent main --since=2026-08-06 --until=2026-08-21` → **18 righe**. La prima
    (06/08 17:52) è lo stato di partenza, quindi nella finestra del test la produzione è cambiata
    **17 volte**: 08/08 22:54 · 09/08 00:38 · 09/08 03:52 · 09/08 20:32 · 10/08 02:40 · 10/08 10:51 ·
    10/08 11:44 · 11/08 10:16 · 12/08 07:09 · 13/08 02:24 · 15/08 00:25 · 15/08 02:48 · 15/08 12:12 ·
    15/08 19:23 · 16/08 11:31 · **17/08 01:06** · 17/08 01:35. **Dopo l'1:35 del 17 agosto non è più
    cambiata niente.** Da qui vengono tutte le date della colonna «Rotto fino al», e la constatazione
    che dal 6 all'8 agosto l'app ha servito una versione sola. (In una prima stesura avevo scritto
    sedici cambiamenti e saltato quello dell'1:06 del 17 agosto: è materia di PARTE B — accessi ed
    email — e non sposta nessuna riga della tabella, ma il conteggio era sbagliato.)
4. `git log --first-parent main --since='2026-08-09 00:39' --until='2026-08-14 23:59'` → **8
    righe**, e fra queste c'è il rilascio delle 10:16 dell'11 agosto, che è il commit della riga 66.
    In una prima stesura avevo scritto «sei volte, nessuna delle quali tocca questo profilo»: erano
    sbagliate tutte e due le metà.
5. **Non ho verificato nessun deploy.** Tutti gli orari del documento sono quelli in cui il
    lavoro entra in `main`. La sola durata che il documento afferma — l'ora e quarantaquattro minuti
    della riga 5 — è misurata fra i due ingressi
    (`2026-08-08T22:54:30+02:00` → `2026-08-09T00:38:47+02:00`, cioè 1h 44m 17s) ed è esatta; gli
    estremi sono anticipati del tempo di deploy, che resta ignoto.
6. Letta la versione **in produzione il 6 agosto** della schermata delle assenze del genitore: 141
    righe, un campo data e un campo motivo, nessun elenco storico, nessun collegamento
    all'informativa, il messaggio d'errore dentro il modulo, e come sola difesa contro la barra di
    navigazione uno spazio fisso di 96 px — contro una barra che con l'area di sicurezza del telefono
    arriva a sfiorarli. Da qui le esclusioni dei n. 4, 6, 7 e 18.
7. Letta la porta che riceve la comunicazione dell'assenza nella stessa versione: il controllo sulla
    morosità sta alla riga 41, il rifiuto «solo primaria» alla riga 56. Il primo viene **prima**,
    quindi il genitore al secondo non ci arrivava: prendeva l'errore vuoto. È il motivo per cui la
    riga 2 della tabella descrive un pulsante che non porta da nessuna parte, e non una schermata che
    dice «riservato alla primaria» — quella frase nessuno l'ha mai letta.
8. Elencate le porte che passavano dal controllo guasto: sono **otto**, tutte dell'area genitori
    (risposte agli avvisi, messaggi alla maestra, richiesta e verifica del codice di firma, invio dei
    moduli, invio delle proprie risposte, comunicazione e giustificazione dell'assenza). Coincidono
    con l'inventario.
9. Cercato il pezzo che avrebbe dovuto gestire la schermata bloccata su «Caricamento…»: nella
    versione del 6 agosto **esiste ma non è agganciato a niente**; compare agganciato solo dal
    rilascio delle 00:25 del 15 agosto. Conferma il n. 20.
10. Cercata la scritta «KIDVILLE SCHOOLS» nel prodotto: è già presente nella versione **del 6
    agosto**, in due punti della schermata dei moduli del genitore — sia sulla ricevuta di firma sia
    sul certificato self-service — e sparisce solo con il rilascio delle 11:31 del 16 agosto. Il n. 22
    era quindi aperto per tutta la finestra del test, non solo dal 15.
11. Letta la regola che calcola l'anno scolastico: cambia il **1° agosto**. Il difetto del n. 25 può
    manifestarsi solo fra la mezzanotte e le due di quel giorno — fuori dalla finestra 6-20 agosto.
12. Cercato chi usava la chiamata al servizio esterno per il codice fiscale: **solo** i tre moduli
    anagrafici del pannello amministrativo. Nessuna schermata del genitore. Conferma l'esclusione del
    n. 61.
13. Letta la modifica alla schermata di scelta del plesso: il contorno passa da 1,10:1 a 5,82:1 nel
    rilascio delle 10:16 dell'11 agosto, sul modulo pubblico d'iscrizione. Conferma il n. 66.
14. Controllato con che cosa si compila il prodotto: `next` è alla versione **16.3.0** e lo script di
    build è `next build`, senza opzioni. In quella versione il compilatore che produce l'effetto
    della riga 1 è quello predefinito, quindi la produzione era coinvolta. Resta una deduzione: il
    pacchetto compilato dell'8 agosto non esiste più.
15. Letta la modifica alla porta del modulo pubblico d'iscrizione: la conferma alla famiglia nasce
    nel rilascio delle 02:48 del 15 agosto, e il codice dice testualmente che prima **non ne partiva
    nessuna**. Conferma il n. 26.
