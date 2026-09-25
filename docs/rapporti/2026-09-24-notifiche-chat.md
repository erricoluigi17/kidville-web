# Notifiche della chat: verifica e correzioni

*Rapporto del 24–25/09/2026. È il punto 3 del lavoro «sei interventi e app 1.1» (spec in
`docs/superpowers/specs/2026-09-24-sei-interventi-app-1-1-design.md`).*

Nel documento ci sono solo conteggi aggregati: nessun nome, nessun testo di messaggio, nessun
identificativo di persona.

---

## In breve

- **Le notifiche arrivano.** Nella misura del 24/09, sugli ultimi 7 giorni, FCM ha accettato
  16.821 invii e ne ha rifiutati lo 0,14%. Un invio è una notifica spedita a **un** dispositivo:
  chi ha due telefoni ne riceve due. Le notifiche create sono un'altra misura, del 25/09, sui 7
  giorni scorrevoli fino a quel giorno: 17.630 in tutto, di cui 1.667 di chat. Le due finestre non
  coincidono, quindi i numeri non vanno messi a confronto.
  I guasti di consegna veri erano pochi. Il resto era un servizio **lento** (la chat arrivava
  in media dopo 2,8 minuti) e **di bassa qualità su Android**: notifiche senza banner, nel canale
  «Miscellaneous».
- Abbiamo trovato **undici difetti**. Dieci si correggono con il **deploy del sito**, perché l'app
  carica il sito e prende le correzioni al primo avvio. Uno solo richiede la **nuova app 1.1**:
  l'icona piccola di Android.
- A parte, il tasto «Apri Impostazioni» dell'avviso settimanale esiste solo sulla 1.1; sulla 1.0
  l'avviso spiega a parole dove andare.
- Non sono difetti due cose che lo sembrano: `aps-environment = development` nel repository e il
  tetto di 500 notifiche per giro. Sono spiegati più sotto.

---

## 1. Le misure

Misurate il **24/09** su produzione, sugli ultimi 7 giorni, con sole query di aggregati (conteggi,
medie, mediane). Il 25/09 abbiamo rilanciato le stesse query per controllarle (vedi la sezione 5).
Esito del controllo: il totale degli invii riusciti è confermato (16.823 sulla finestra spostata di un giorno, con 19
risposte `500` e 6 timeout invece di 5). La divisione 14.343 iOS / 2.478 Android è quella del 24/09
e da `app_log` non si può ricontrollare, perché il contesto di una riga resta quello della prima
occorrenza (vedi la sezione 5).

| Cosa | Valore |
|---|---|
| Invii FCM riusciti, **iOS** | **14.343** |
| Invii FCM riusciti, **Android** | **2.478** |
| Invii FCM falliti | **0,14%**: 19 risposte `500` e 5 timeout, **nessuno ritentato** |
| Ritardo della notifica di chat (dal messaggio all'invio) | media **2,8'**, mediana **2,9'**, massimo **9,6'** |
| Dispositivi iscritti alle push | **470 iOS**, **262 Android**, **20 web** |
| Utenti con il permesso delle notifiche **negato** | **26** |

Come leggere i numeri:

- **Il ritardo della chat dipendeva dal cron.** Il cron passa ogni 5 minuti, quindi la notifica
  aspettava in media mezzo giro. La media di 2,8' e la mediana di 2,9' sono proprio questo. Il
  massimo di 9,6' vuol dire che la notifica ha saltato almeno un giro. La causa è stata verificata
  il 25/09 con un aggregato: i tre ritardi più alti della settimana (9,6', 9,2' e 9,1') sono tutti
  del 22/09 e cadono in una delle 2 finestre oltre il tetto di 500 (vedi la sezione 3). Quando è
  nato il messaggio da 9,6', davanti a lui in coda c'erano circa 670 notifiche non ancora spedite,
  e il giro pesca sempre le più vecchie.
- **I 26 utenti con il permesso negato riprovavano a ogni avvio.** Hanno prodotto 554 righe di log
  dal 17/09 al 24/09 compresi, in media 21,3 a testa.
- **Quanto rumore c'era nei log**, sulla stessa finestra dal 17/09 al 24/09, righe `warn` delle
  push del client (`client:push`, 2.225 in tutto):
  - 1.671 righe «chat-apertura-da-notifica: aperta», una per ogni tocco riuscito su una
    notifica (misura del 25/09 con `sum(occorrenze)`, dal 17/09 al 24/09 compresi, cioè otto
    giorni di calendario). Il commento nel codice (`useAperturaThreadRichiesta.ts`) dice «~1.400 a
    settimana»: è la stessa misura sui sette giorni dal 17/09 al 23/09, che danno 1.437. Il numero
    di questo rapporto è 1.671, sugli otto giorni;
  - 554 righe di permesso negato.
- **Nello stesso evento e nella stessa finestra, a livello `error`**: 31 token non registrati per
  un errore di rete (`push-nativa-non-registrata: TypeError`) e 19 registrazioni senza risposta
  entro 20 s (`push-nativa-senza-esito`).

---

## 2. I difetti, uno per uno

Riepilogo:

| # | Difetto | Corretto in questo lavoro | Serve la 1.1? |
|---|---|---|---|
| 1 | Canale Android mai creato: tutto in «Miscellaneous» | sì | **no** |
| 2 | Nessun ritentativo sugli errori FCM (`5xx`, timeout) | sì | no |
| 3 | Doppioni possibili con giri sovrapposti | sì | no |
| 4 | Chat verso lo staff esclusa dalla push (PR #165) | sì | no |
| 5 | Badge iOS assente | sì | no |
| 6 | Notifica del browser con testo e nome | sì | no |
| 7 | Registrazione del token senza ritentativi | sì | no |
| 8 | Ascoltatori agganciati più volte | sì | no |
| 9 | Rumore nei log | sì | no (la versione dell'app nei log arriva anche dalla 1.0) |
| 10 | Mensa «saldo basso» con web-push diretto | sì | no |
| 11 | Icona piccola Android assente | sì, nel binario | **sì** |

A parte c'è l'avviso «Notifiche disattivate — Apri Impostazioni», al massimo una volta a settimana.
Compare anche sulla 1.0, ma il tasto che apre le impostazioni **del sistema** esiste solo sulla 1.1.
Sulla 1.0 l'avviso spiega a parole dove andare.

### 1. Il canale Android non veniva mai creato

**Cosa succedeva.** Il server mandava le push senza indicare un canale e l'app non ne creava
nessuno. Su Android 8 e successivi ogni notifica finiva quindi nel canale di riserva di Firebase
(«Miscellaneous»/«Varie»), con importanza predefinita: nessun banner in testa allo schermo e un
nome del canale che nelle impostazioni non diceva niente.

**Cosa è stato corretto.**
- Il nome del canale sta in un posto solo, `src/lib/push/canale-android.ts`: `kidville_notifiche`.
- Il server lo scrive in ogni push Android (`android.notification.channel_id` in
  `src/lib/push/native-push.ts`).
- L'app lo crea a ogni registrazione, prima di `register()`, in `creaCanaleAndroid`
  (`src/lib/push/native-register.ts`). Nome «Notifiche Kidville» («Kidville notifications» se la
  pagina è in inglese), **importanza alta**, **contenuto visibile** a schermo bloccato (decisione
  del titolare), vibrazione accesa.
- Se la creazione fallisce, resta una riga `error` e la registrazione va avanti comunque.
- Su Android 7 i canali non esistono: lì si scrive un solo `warn` per installazione.

**Serve la 1.1?** No. `createChannel` fa parte del plugin delle push, che c'è già nella 1.0.

**Da sapere.** Android tiene le impostazioni che l'utente ha cambiato su un canale già esistente.
Chi abbassa l'importanza di «Notifiche Kidville» se la tiene: è una scelta dell'utente e non un
guasto. Le notifiche già ricevute in «Miscellaneous» restano lì.

### 2. Nessun ritentativo sugli errori di FCM

**Cosa succedeva.** Un `500` o un timeout di FCM erano definitivi: la notifica era segnata come
inviata e non partiva più. Sono i 24 casi della settimana, lo 0,14%.

**Cosa è stato corretto** in `src/lib/push/native-push.ts` e `src/lib/push/dispatch.ts`:
- Su `5xx`, timeout, rete assente e `429` si riprova **subito**, fino a due volte, dopo 1 s e poi
  dopo 3 s. Su un `429` si aspetta il `Retry-After` di FCM, fino a 10 s.
- Se nessun telefono del destinatario l'ha ricevuta e tutti i rifiuti erano transitori, la notifica
  **torna in coda** e riparte al giro dopo, **fino a 30 minuti** dalla sua programmazione. Dopo i
  30 minuti ci si arrende e una riga `error` («resa-dopo-30-minuti») lo dice.
- Se anche un solo telefono l'ha ricevuta, non si rispedisce: sarebbe un doppione.
- `400`, `401` e `403` non si ritentano, perché la stessa richiesta avrebbe la stessa risposta.
- Il token morto (`404`, `UNREGISTERED`) resta come prima: il dispositivo si toglie.
- Un giro con molti dispositivi smette di fare ritentativi immediati dopo 20 s e lascia la notifica
  in coda invece di aspettare.

**Serve la 1.1?** No, è tutto sul server.

### 3. Doppioni possibili con giri sovrapposti

**Cosa succedeva.** Il dispatch leggeva le notifiche in coda, le spediva e le segnava come inviate
solo **a fine giro**. Due giri partiti insieme leggevano le stesse righe e le spedivano entrambi.
Con il solo cron ogni 5 minuti capitava di rado, con un giro lento. Con la chat «subito» (punto 4)
sarebbe capitato spesso.

**Cosa è stato corretto.** Il giro sta ora in `src/lib/push/dispatch.ts` (`eseguiDispatch`) e
**prende** le notifiche **prima** di spedirle, con un UPDATE condizionato
(`push_inviata_il is null` nella condizione, `returning id`). Spedisce solo quello che l'UPDATE gli
ha restituito. Se due giri si contendono una riga, il secondo la trova già presa e la salta: il
contatore `gia_prese` lo registra.

Quello che la presa costa (un giro che muore dopo averle prese le perderebbe) è coperto in tre
modi:
- un controllo del tempo **prima** della presa: oltre 40 s non si prende niente;
- un tetto del giro: le notifiche prese e non ancora tentate tornano in coda;
- una durata delle Function (`maxDuration = 300`) più lunga del caso peggiore calcolato in
  `src/lib/push/durata-dispatch.ts`, tenuta ferma da un lock.

**Serve la 1.1?** No.

### 4. La chat verso lo staff era esclusa, e la chat arrivava in 2,8'

**Cosa succedeva.** Con la PR #165 (coda fatture) allo staff (Direzione, Coordinamento, Segreteria,
Cuoca) arrivavano in push solo gli avvisi della coda fatture e lo scarto SdI. Anche la **chat**
restava nella sola campanella. Al 25/09 nessuno dello staff ha un dispositivo iscritto, quindi il
difetto non ha ancora fatto danni. Si sarebbe visto al primo iscritto.

**Cosa è stato corretto.**
- `TIPI_CHAT` (`chat_genitore`, `chat_docente`) è entrato in `TIPI_PUSH_STAFF` in
  `src/lib/push/dispatch.ts`. La chat allo staff va in push **con il mittente**, con lo stesso
  titolo e lo stesso corpo che riceve un genitore o un docente. Le altre notifiche dello staff
  restano nella campanella, come prima.
- La chat **parte subito**. Dopo ogni messaggio, `POST /api/chat/messages` programma con `after()`
  un giro di dispatch **30 secondi** dopo (`programmaDispatchChat`). I 30 s raccolgono le raffiche:
  tre messaggi in dieci secondi producono una sola push. La presa atomica del punto 3 impedisce il
  doppione con il cron.
- Il giro della chat scrive i suoi log sotto `push-dispatch-chat` e non sotto `push-dispatch`,
  perché altrimenti un cron fermo sembrerebbe vivo finché qualcuno scrive in chat.
- Se `after()` non è disponibile, la notifica resta in coda e la manda il cron entro 5 minuti. Una
  riga `warn` lo dice.

**Serve la 1.1?** No.

**Cosa aspettarsi.** Il ritardo tipico scende da circa 3 minuti a circa **30–40 secondi**.

### 5. Badge iOS assente

**Cosa succedeva.** Le push iOS non portavano il numero sull'icona dell'app. Il numero veniva
aggiornato solo ad app aperta, dal pannello delle notifiche.

**Cosa è stato corretto.**
- Ogni push iOS porta in `aps.badge` il numero delle **notifiche non lette** del destinatario
  (`letta_il` nullo). È lo stesso numero che l'app mette sull'icona quando è aperta
  (`src/lib/native/badge.ts`).
- Il conteggio si fa con **una query per giro**, qualunque sia il numero di utenti: la RPC
  `notifiche_non_lette_per_utente` della migrazione `20260924220200_push_badge_non_lette.sql`,
  eseguibile solo dal server.
- Se il conteggio fallisce, la push parte **senza** badge e una riga `warn`
  («badge-non-calcolato») lo segnala. Per un numero sull'icona non si ferma una notifica.
- Succede anche nell'intervallo fra il deploy e l'applicazione della migrazione, che la fa
  l'integrazione al merge.

**Serve la 1.1?** No, il badge lo mette iOS leggendo la push.

**Da sapere.** Il badge conta **tutte** le notifiche non lette, non solo la chat, come ha deciso il
titolare. Molti genitori non aprono mai la campanella. Misura del 25/09 sui 439 utenti con un
iPhone iscritto:
- 151 hanno 0 non lette;
- 123 ne hanno da 1 a 9;
- 159 ne hanno da 10 a 99;
- 6 ne hanno 100 o più;
- la mediana è 3.

Alla prima push dopo il deploy alcuni vedranno quindi un numero alto. Non è un errore: è il numero
che l'app mostra già ad app aperta.

### 6. La notifica del browser mostrava testo e nome

**Cosa succedeva.** Sul web, a pagina non in primo piano, `useUnreadNotifications` mostrava una
notifica del browser con il **nome del mittente** e il **testo dell'ultimo messaggio**. Compariva
sullo schermo di un computer che altri possono guardare, come la scrivania della segreteria o il
PC di casa.

**Cosa è stato corretto** in `src/components/features/chat/useUnreadNotifications.ts`:
- la notifica dice solo **«Nuovo messaggio in chat»**, senza testo, nome o conteggio;
- il clic apre comunque la conversazione giusta;
- se il browser non permette la notifica (Chrome su Android lancia «Illegal constructor»), resta
  una riga `warn` invece di un errore muto;
- un conteggio fallito lascia anch'esso una riga.

**Serve la 1.1?** No.

La **push** web e nativa porta ancora il mittente («Hai un nuovo messaggio da …»), mai il testo:
è la decisione del titolare. La modifica riguarda solo la notifica che la pagina aperta mostra da
sé.

### 7. La registrazione del token non ritentava

**Cosa succedeva.** L'app registrava il token **una volta per avvio**. Bastava un errore di rete o
un deploy in corso per lasciare il telefono senza notifiche fino al prossimo avvio a freddo. Chi
l'app non la chiude mai restava senza notifiche per giorni. Dal 17/09 al 24/09 (la stessa
finestra della sezione 1), a livello `error`:
- 31 token non registrati per un errore di rete;
- 19 registrazioni senza risposta entro 20 s.

**Cosa è stato corretto.**
- `POST /api/push/subscribe` ha **tre tentativi**, dopo 2 s e poi dopo 8 s, e ogni richiesta ha un
  tetto di 15 s. Si ritentano solo la rete e i `5xx`, perché un `4xx` è una risposta.
  (`src/lib/push/native-register.ts`)
- Quando l'app **torna in primo piano** si riprova, ma solo se l'ultimo esito era un fallimento che
  può guarire. Fra un tentativo e l'altro passa almeno un minuto, e i tentativi sono al massimo 5
  per sessione (`src/components/providers/NativePushAutoRegister.tsx`).
- Chi aveva negato il permesso e poi l'ha acceso dalle Impostazioni viene registrato al ritorno.
- Prima di chiedere il permesso si guarda lo stato con `checkPermissions`: se è già negato non si
  chiede più niente.
- Al rifiuto il token si **cancella** dal server, perché un telefono che ha detto no non deve
  restare fra i dispositivi.
- `native-shell` riprova a caricare un plugin quando il file non è arrivato per un problema di rete.

**Serve la 1.1?** No.

### 8. Ascoltatori agganciati più volte

**Cosa succedeva.** Ogni chiamata di registrazione agganciava la sua coppia di ascoltatori
(`registration`/`registrationError`). La registrazione automatica e l'interruttore «attiva» ne
producevano due coppie, e ogni rotazione del token partiva **due volte** verso il server.

**Cosa è stato corretto.**
- Gli ascoltatori sono **una coppia sola** per sessione, protetta da una guardia di modulo. Le
  chiamate successive aspettano l'esito di quella in corso.
- Si tolgono uno per uno, e mai con `removeAllListeners()`, che spegneva anche il tocco sulle
  notifiche.
- Un aggancio fallito riapre la guardia, così un nuovo tentativo può rimediare.
- Una disattivazione, cioè «disattiva», il logout o il permesso negato, ferma i ritentativi ancora
  in corso, così il token non viene riscritto dopo.

**Serve la 1.1?** No.

### 9. Rumore nei log

**Cosa succedeva.**
- Ogni apertura riuscita di una conversazione da una notifica scriveva un `warn`: 1.671 nella
  finestra dal 17/09 al 24/09 (vedi la sezione 1). Il client non ha un livello `info`. Erano la
  maggior parte dei `warn` delle push del client (`client:push`): 1.671 su 2.225 nella stessa
  finestra, e il resto erano le 554 righe di permesso negato. Dentro quel volume i guasti veri non
  si vedevano.
- Il permesso negato riscriveva la sua riga a ogni avvio: 554 righe da 26 utenti, dal 17/09 al 24/09.
- Ogni tentativo FCM fallito era un `error`, anche quando il ritentativo lo riparava.

**Cosa è stato corretto.**
- **Aperture da notifica** (`useAperturaThreadRichiesta.ts`): il successo si scrive **una volta su
  20**, a caso, con il fattore nei campi (`campione: 20`). Il volume vero si ricostruisce
  moltiplicando. I fallimenti (`non-trovata`, `id-non-valido`, `guasto`) si scrivono sempre.
- **Permesso negato**: una riga per installazione.
- **FCM**: il singolo tentativo fallito è `warn`. L'`error` arriva solo quando i ritentativi sono
  finiti («ritentativi-esauriti»), e c'è una riga `info` («riuscita-dopo-ritentativo») per contare
  quante notifiche i ritentativi hanno salvato.
- **Registrazione**: `warn` sul primo fallimento, dove l'esito vero arriva dopo; `error` solo a
  tentativi finiti.
- **Versione dell'app nei log**: ogni evento del client porta `versione_app`, letta dal binario con
  `App.getInfo()` (`src/lib/mobile/native-shell.ts`, `src/lib/logging/client.ts`). Serve a
  distinguere i telefoni con la 1.0 da quelli con la 1.1. Funziona anche sulla 1.0.

**Serve la 1.1?** No.

### 10. Mensa «saldo basso»: web-push diretto e doppione

**Cosa succedeva.** `notificaSaldoBasso` spediva la push da sé, con `sendPush`, a **tutti** i
dispositivi dei genitori, telefoni compresi. Un token FCM/APNs non ha le chiavi del web-push, e ogni
invio finiva in un errore «must have auth and p256dh keys»: 78 in 30 giorni. Chi usa il web la
riceveva **due volte**, perché la riga restava in coda e il dispatch la rispediva.

**Cosa è stato corretto** in `src/lib/mensa/notify.ts`:
- `notificaSaldoBasso` scrive solo la riga in `notifiche` e la push la porta il dispatch, sul canale
  giusto per ogni dispositivo;
- il successo si registra («accodata»);
- l'alert allergie segue lo stesso schema;
- in tutto `src/` l'unico modulo che chiama gli invii push è il dispatch, e un lock in
  `__tests__/api/push-dispatch.test.ts` lo impone.

**Serve la 1.1?** No.

### 11. Icona piccola Android assente

**Cosa succedeva.** Senza un'icona dichiarata, Android usava la sagoma dell'icona dell'app, che è
una card piena. Nella barra di stato si vedeva un **quadrato bianco**.

**Cosa è stato corretto.** `ic_stat_kidville` (la «K» del lettering, bianca su trasparente, in
cinque densità) e il colore verde del marchio sono dichiarati in
`android/app/src/main/AndroidManifest.xml`, con `default_notification_icon` e
`default_notification_color`.

**Serve la 1.1? Sì.** L'icona e il manifest stanno nel binario, quindi finché il telefono ha la 1.0
resta il quadrato.

---

## 3. Cosa NON è un difetto

### `aps-environment = development` nel repository

`ios/App/App/App.entitlements` dice `development`, e sembra il motivo per cui le push iOS non
dovrebbero arrivare in produzione. Non lo è.
- L'**export** dell'archivio con la firma *Apple Distribution* riscrive l'entitlement in
  **`production`**.
- È stato verificato sull'`.ipa` con `codesign -d --entitlements` (procedura e prova in
  `docs/store-submission.md`, §5).
- Anche l'archivio intermedio (`.xcarchive`) resta in `development`, ed è normale: gli entitlement
  vanno controllati sull'`.ipa`.
- La prova in produzione sono i **14.343 invii iOS riusciti** in una settimana.

Il file del repository non va cambiato: è l'export a decidere cosa arriva sullo store.

### Il tetto di 500 notifiche per giro

Ogni giro legge al massimo 500 notifiche (`LIMITE_LETTURA`), **sempre le più vecchie**. Non se ne
perde nessuna: quelle oltre il tetto partono al giro dopo, nell'ordine in cui sono nate.
- Il tetto serve a tenere il giro dentro la durata della Function. Il caso peggiore è calcolato in
  `durata-dispatch.ts`.
- Misura del 25/09 sugli ultimi 7 giorni: 17.630 notifiche in 812 finestre di 5 minuti. Il 99%
  delle finestre ne aveva al massimo 116, e solo **2 finestre** hanno superato 500 (la più piena
  ne aveva 667).
- In quei due casi l'eccedenza ha aspettato **un giro in più**, cioè 5 minuti.

**Da sapere.** Anche il giro della chat pesca le più vecchie. Se una chat arriva mentre è in coda un
invio di massa (un avviso a tutta una sede), la sua push può partire con il cron successivo invece
che dopo 30 s. È un ritardo di al massimo qualche minuto, in casi rari, e la notifica non si perde.
È già successo prima di questo lavoro, col solo cron: il ritardo massimo della settimana (9,6', il
22/09) cade proprio in una delle due finestre oltre 500 (vedi la sezione 1).

### Altre scelte fatte apposta

- **Con l'app aperta non cambia niente**, come ha deciso il titolare.
- Il **contenuto visibile** a schermo bloccato su Android è una decisione del titolare, e la push
  della chat non porta mai il testo del messaggio.
- Le push allo staff **diverse** dalla chat restano nella campanella. Vale la regola della PR #165:
  molte contengono il nome di un bambino o di un genitore.

---

## 4. Cosa resta da verificare

- **Sui dispositivi** (passo 6 della spec, dopo il deploy):
  - sull'emulatore KV-api33: nelle impostazioni Android il canale si chiama «Notifiche Kidville»,
    con importanza alta;
  - sul simulatore iPhone 16e: il numero sull'icona corrisponde alle notifiche non lette;
  - sull'emulatore KV-api33 con la 1.1 installata: nella barra di stato compare l'icona piccola
    (la «K»), non il quadrato bianco.
- **La presa atomica** è provata dai test (`__tests__/lib/push-dispatch-presa.test.ts`), non da due
  giri veri in produzione. La prova in produzione è il contatore `gia_prese` (vedi sotto).
- **La migrazione del badge** (`20260924220200_push_badge_non_lette.sql`) la applica
  l'integrazione al merge. Fino ad allora le push partono senza badge, con un `warn`.

---

## 5. Come verificarlo in produzione

Solo query di **aggregati** (conteggi, somme, medie) su `app_log`, `notifiche` e
`push_subscriptions`, da lanciare dalla radice del repository con
`supabase db query --linked "<query>"`. Nessuna di queste legge un nome o un testo.

⚠️ **Come deduplica `app_log`.** Le righe uguali (stesso livello, evento, route, messaggio, codice e
utente) si fondono in una riga al giorno, e `occorrenze` le conta. Il `contesto` resta quello della
**prima** occorrenza. Di conseguenza:
- i conteggi si fanno con `sum(occorrenze)`;
- i contatori scritti nel `contesto` (`native_inviate`, `gia_prese`, la piattaforma di un invio)
  **non si possono sommare** dalla tabella;
- la divisione per piattaforma degli invii FCM e la somma di `gia_prese` si leggono nei log di
  runtime di Vercel, dove ogni riga ha i suoi campi.

**1. Dispositivi iscritti per piattaforma** (24/09: 470 iOS, 262 Android, 20 web)
```sql
select platform, count(*) from push_subscriptions group by platform order by 1;
```

**2. Esiti FCM degli ultimi 7 giorni** (24/09: 16.821 riusciti, 19 `500`, 5 timeout, tutti
`error`)
```sql
select livello, coalesce(codice, '-') as codice, sum(occorrenze) as volte
  from app_log
 where evento = 'push' and giorno >= current_date - 7
   and (messaggio = 'messages:send' or codice in ('500','502','503','504','timeout','429'))
 group by 1, 2 order by 3 desc;
```
Dopo il deploy:
- i rifiuti transitori dei singoli tentativi compaiono come `warn`;
- un `error` con codice `5xx`/`timeout` (`ritentativi-esauriti`) vuol dire che i ritentativi
  immediati verso **quel dispositivo** sono finiti senza una risposta buona. La notifica può ancora
  arrivare da un altro dispositivo dello stesso utente, o al giro dopo: se non è arrivata da nessuna
  parte torna in coda e riparte ai giri successivi, per 30 minuti. Le notifiche perse davvero si
  contano con la query 3 («mai consegnate dopo 30 minuti»). Questo `error` deve comunque essere
  molto più raro dei `warn`.

**3. Invii salvati dal ritentativo, e giri con notifiche perse dopo 30 minuti**
```sql
select messaggio, sum(occorrenze) from app_log
 where evento in ('push', 'cron') and giorno >= current_date - 7
   and (messaggio = 'riuscita-dopo-ritentativo' or messaggio like '%mai consegnate dopo 30 minuti%')
 group by 1;
```
Come si legge:
- `riuscita-dopo-ritentativo` si scrive una volta per **invio a un dispositivo**: la somma conta gli
  invii salvati, non le notifiche;
- la riga delle notifiche mai consegnate si scrive una volta per **giro**, con il numero N di
  notifiche perse scritto nel messaggio. Le notifiche perse sono N moltiplicato per le occorrenze di
  quella riga (una riga per ogni N diverso).

**4. Ritardo della chat** (24/09: media 2,8', mediana 2,9', massimo 9,6'; dopo il deploy ci si
aspetta meno di un minuto)
```sql
select count(*) as notifiche,
       round(avg(extract(epoch from (push_inviata_il - creato_il)) / 60)::numeric, 1) as media_min,
       round((percentile_cont(0.5) within group
              (order by extract(epoch from (push_inviata_il - creato_il)) / 60))::numeric, 1) as mediana_min,
       round(max(extract(epoch from (push_inviata_il - creato_il)) / 60)::numeric, 1) as max_min
  from notifiche
 where tipo in ('chat_genitore', 'chat_docente')
   and push_inviata_il is not null
   and creato_il >= now() - interval '7 days';
```
Dal deploy `push_inviata_il` è l'istante della **presa**, un attimo prima dell'invio. Una misura a
cavallo del deploy mescola i due regimi: conviene partire dal giorno dopo.

**5. Il cron batte, e la chat parte da sola**
```sql
select giorno, evento, messaggio, sum(occorrenze)
  from app_log
 where giorno >= current_date - 3
   and messaggio in ('push-dispatch: avviato', 'push-dispatch: ok',
                     'push-dispatch-chat: avviato', 'push-dispatch-chat: ok',
                     'chat/messages:POST: dispatch anticipato della chat concluso',
                     'chat/messages:POST: dispatch anticipato della chat fallito (dettagli nelle righe push-dispatch-chat); le notifiche non prese restano in coda per il cron')
 group by 1, 2, 3 order by 1, 3;
```
Cosa aspettarsi:
- il cron fa **288** giri al giorno, con 288 «avviato» e 288 «ok»;
- le righe `push-dispatch-chat` devono essere più o meno tante quante i messaggi di chat inviati;
- un «avviato» senza il suo «ok» è un giro morto a metà.

**6. Badge non calcolato** (dovrebbe sparire dopo la migrazione)
```sql
select giorno, sum(occorrenze) from app_log
 where giorno >= current_date - 7 and contesto -> 'campi' ->> 'esito' = 'badge-non-calcolato'
 group by 1 order by 1;
```

**7. Il client: permesso, canale, registrazione, aperture** (gli eventi del client si chiamano
`client:push`)
```sql
select left(messaggio, 70) as messaggio, livello,
       sum(occorrenze) as volte, count(distinct utente_id) as utenti
  from app_log
 where sorgente = 'client' and evento = 'client:push' and giorno >= current_date - 7
 group by 1, 2 order by 3 desc;
```
Cosa aspettarsi dopo il deploy:
- `push-nativa-permesso-negato: denied` ha tante occorrenze quanti utenti, circa una per
  installazione, invece di 554 righe da 26 utenti;
- `push-nativa-canale-non-creato` è assente o raro, perché ogni riga è un telefono rimasto in
  «Miscellaneous»;
- `push-nativa-registrazione-ritento` (warn) supera di molto
  `push-nativa-non-registrata: ritentativi esauriti` (error);
- `push-nativa-ripresa: registrata al ritorno in primo piano` conta i telefoni recuperati;
- `chat-apertura-da-notifica: aperta` scende a circa un ventesimo: le aperture vere sono le
  occorrenze × 20.

**8. Quali versioni dell'app stanno scrivendo** (1.0 o 1.1; indicativo, perché il `contesto` è
quello della prima occorrenza)
```sql
select contesto -> 'campi' ->> 'versione_app' as versione, piattaforma, count(*)
  from app_log
 where sorgente = 'client' and giorno >= current_date - 7
 group by 1, 2 order by 3 desc;
```

**9. Mensa «saldo basso»** (78 errori web-push su token nativi in 30 giorni prima della correzione)
```sql
select giorno, sum(occorrenze) from app_log
 where giorno >= current_date - 30 and messaggio ilike '%p256dh%'
 group by 1 order by 1;
```
Dopo il deploy queste righe si fermano. La riga di successo «accodata» non finisce in `app_log`,
perché l'evento `mensa` non è fra quelli salvati in tabella, e si vede solo nei log di Vercel. In
tabella la prova è che gli avvisi escono dalla coda:
```sql
select count(*) as avvisi, count(push_inviata_il) as presi_dal_dispatch
  from notifiche
 where tipo = 'mensa_saldo_basso' and creato_il >= now() - interval '7 days';
```
