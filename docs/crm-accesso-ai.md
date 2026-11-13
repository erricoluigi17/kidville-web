# Accesso dell’assistente al CRM Kidville

Il programma sul Mac può cercare orari per una visita, fissarla o annullarla, registrare e riconoscere un contatto e passare una famiglia alla segreteria. Le sette API sono sotto `/api/crm/ai`.

L’accesso parte spento. Sul server `CRM_AI_ATTIVO=1` accende le API. `CRM_AI_SEDI_AMMESSE` contiene gli UUID delle sedi ammesse, separati da virgole. Un elenco vuoto non ammette alcuna sede. Il primo collaudo, dopo il sì del titolare, è previsto per la sola sede Demo.

## Chiave e chiamate

La Direzione sceglie la sede in **CRM → Assistente** e crea una chiave. Se ne può tenere una attiva per sede. Il token intero compare una sola volta. Il CRM conserva l’impronta SHA-256, gli ultimi quattro caratteri mostrati nell’elenco e i metadati di creazione, ultimo uso e revoca. La Direzione può revocarlo. Una revoca vale subito: ogni rotta ricontrolla in SQL che la chiave sia ancora attiva per la sua sede prima di leggere o scrivere, e risponde `401 TOKEN_NON_VALIDO` se è stata revocata nel frattempo. Il programma recupera il token da un archivio locale di segreti, fuori da iCloud, dalle note condivise e dai log.

Usa HTTPS e invia `Authorization: Bearer <token>` ad ogni chiamata. La `sede` dichiarata nel corpo o nella query deve essere quella della chiave. Le POST usano `Content-Type: application/json` e accettano i soli campi documentati. Negli esempi `BASE_URL` è l’origine HTTPS autorizzata e `CRM_AI_TOKEN` contiene il token recuperato dal programma. Sostituisci i segnaposto con i valori previsti e serializza il corpo con la libreria JSON del programma.

Dove è richiesto il campo `telefono`, invia una stringa di 6–40 caratteri dopo aver tolto gli spazi ai bordi. Sono ammessi i normali separatori di un recapito, come spazi, punti, slash, trattini e parentesi, oltre ai prefissi `+39` e `0039`. Servono almeno nove cifre dopo la normalizzazione. Una stringa formalmente valida per lunghezza che contiene lettere o testo libero è rifiutata con `422 CONTATTO_OBBLIGATORIO`, prima di interrogare o scrivere schede e visite. Tipo e lunghezza errati danno `400`.

Dove è richiesto `origine`, scegli fra `telefonata`, `whatsapp`, `instagram`, `facebook`, `google`, `sito`, `passaparola`, `open_day`, `ai` e `altro`.

### Risposte comuni

| HTTP | Codice | Cosa fare |
|---|---|---|
| 400 | — | Correggi il JSON, i parametri o gli header richiesti. La risposta di validazione è `{error, details: [{path, message}]}`. |
| 401 | `TOKEN_NON_VALIDO` | Chiave mancante, malformata, sconosciuta o revocata. La risposta contiene `WWW-Authenticate: Bearer`. Controlla la chiave con la Direzione. |
| 403 | `SEDE_NON_AMMESSA` | La sede della chiave non è ammessa sul server. Avvisa il titolare. |
| 403 | `SEDE_NON_ACCESSIBILE` | La sede richiesta è diversa da quella della chiave. Correggi la richiesta. |
| 404 | `CRM_AI_SPENTO` | L’accesso è spento. Ferma i tentativi automatici e avvisa il titolare. |
| 429 | `TROPPE_RICHIESTE` | Il limite è di **60 chiamate al minuto per chiave**, per tutte le rotte insieme. Prima ancora di cercare la chiave c'è un tetto largo per indirizzo (300 al minuto, per istanza del server, senza leggere il database) contro i token inventati. Aspetta i secondi indicati da `Retry-After`. |
| 503 | `CRM_NON_INSTALLATO` | Lo schema richiesto manca in questo ambiente. Ferma i tentativi automatici e avvisa il titolare. |
| 500 | `CRM_OPERAZIONE_NON_RIUSCITA` | Errore tecnico. Per una prenotazione da riprovare conserva corpo e chiave di idempotenza. Per assistenza comunica l’`x-request-id` della risposta. |

Gli errori con codice hanno in genere la forma `{error, codice}`. Per le decisioni del programma usa lo stato HTTP e `codice`. I codici specifici delle singole rotte sono sotto.

## 1. Orari disponibili — GET /api/crm/ai/slot

Query obbligatoria `sede`, `dal` e `al` nel formato `AAAA-MM-GG`, `nascita` nel formato `AAAA-MM`. Le date sono civili, nel fuso di Roma, con estremi inclusi. `al` deve essere uguale o successivo a `dal`, al massimo 31 giorni dopo.

**200** — `{sede, gradi, etaCoperta, troncato, slot: [{inizio, fine}]}`. `gradi` può contenere `nido`, `infanzia` e `primaria` e indica la fascia d’età: l’assistente può dirla alla famiglia, ma non propone né assegna una classe, che sceglie la segreteria durante la visita. Per offrire la visita, il CRM verifica che la sede offra il servizio per quella fascia, leggendo l’elenco fisso dei servizi della sede, che non dipende dalle sezioni né dall’anno scolastico (vedi «Servizi offerti dalla sede»). Il risultato non conferma l’ammissione. Se la sede non offre il servizio, `etaCoperta` è `false` e `slot` è vuoto. Con copertura l’elenco può comunque essere vuoto. Gli orari hanno almeno due ore di anticipo, sono ordinati per inizio e fine e arrivano in ISO. Al massimo 60 coppie. Se `troncato` è `true`, restringi l’intervallo per vedere gli altri orari.

**Errori** — quelli comuni, incluso `400` per date, intervallo o parametri non ammessi. Il messaggio non riporta il nome dei parametri sconosciuti. Se mancano le tabelle di calendario o l’elenco dei servizi della sede, la risposta è `503 CRM_NON_INSTALLATO`.

```sh
curl --get "$BASE_URL/api/crm/ai/slot" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  --data-urlencode 'sede=<uuid della sede>' \
  --data-urlencode 'dal=<primo giorno AAAA-MM-GG>' \
  --data-urlencode 'al=<ultimo giorno AAAA-MM-GG>' \
  --data-urlencode 'nascita=<anno e mese AAAA-MM>'
```

## 2. Fissare una visita — POST /api/crm/ai/prenota

Corpo obbligatorio `sede`, `inizio` e `fine` ISO con fuso, `genitoreNome` (1–120 caratteri), `telefono`, `origine`, `bambini` (1–6 elementi, ciascuno con `nome` di 1–100 caratteri e `dataNascita` in formato `AAAA-MM-GG`). Facoltativi `email` (fino a 200 caratteri), `routine`, `paura` e `desiderio` (fino a 2.000 caratteri ciascuno). Prendi **insieme inizio e fine** dalla proposta di `/slot` scelta dalla famiglia. Lo stesso inizio può avere due durate diverse.

Invia l’header `Idempotency-Key` con un identificativo nuovo per ogni tentativo distinto (8–128 caratteri tra lettere ASCII, cifre, trattino e sottolineatura). Per ripetere **lo stesso tentativo**, per esempio dopo un timeout, riusa lo stesso corpo e la stessa chiave. Genera la chiave senza dati della famiglia.

**201** — visita fissata, `{id, inizio, fine, schedaId, schedaCreata, ripetuta: false}`. **200** — stesso esito di prenotazione già registrato, con `ripetuta: true`. Un replay non crea un’altra visita e non manda un altro avviso.

| HTTP | Codice | Esito |
|---|---|---|
| 409 | `GIA_PRENOTATO` | Esiste già una visita per la famiglia. La risposta include `id`, `inizio` e `fine` della visita trovata. |
| 409 | `SLOT_OCCUPATO` | Chiedi orari aggiornati con `/slot`. Per la nuova coppia scelta usa una chiave di idempotenza nuova. |
| 409 | `CRM_OPERAZIONE_NON_RIUSCITA` | Il tentativo risulta ancora in corso. Attendi e ripeti con lo stesso corpo e la stessa chiave. |
| 422 | `FUORI_DISPONIBILITA` | La coppia non è più prenotabile. Ricarica gli orari. |
| 422 | `ETA_NON_COPERTA` | La sede non offre il servizio per nessuna delle fasce d’età indicate. Non è una scelta di classe. |
| 422 | `CHIAVE_RIUSATA` | La chiave è già associata a un corpo diverso. Usa una nuova chiave se è davvero un altro tentativo. |
| 422 | `CONTATTO_OBBLIGATORIO` | Il telefono non è utilizzabile. |

Si applicano anche gli errori comuni e gli esiti tecnici della lettura dei servizi della sede descritti per `/slot`. La coppia con fine non successiva all’inizio e una chiave di idempotenza assente o fuori formato danno `400`. Quando la richiesta arriva al riconoscimento della famiglia, si applica la stessa regola dei recapiti di E1, compreso il `500` per le schede ambigue o per un nuovo numero senza spazio.

```sh
curl -X POST "$BASE_URL/api/crm/ai/prenota" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <id del tentativo>' \
  --data '{"sede":"<uuid della sede>","inizio":"<inizio ISO da slot>","fine":"<fine ISO da slot>","genitoreNome":"<nome del genitore>","telefono":"{{telefono}}","origine":"whatsapp","bambini":[{"nome":"<nome del bambino>","dataNascita":"<AAAA-MM-GG>"}]}'
```

## 3. Annullare una visita — DELETE /api/crm/ai/prenotazioni/{id}

L’UUID della visita va nell’indirizzo e `sede` nella query. La stessa chiave che ha fissato la visita può annullarla se è in programma. Lo stato della visita e lo storico cambiano insieme nella funzione SQL `crm_ai_annulla`.

**200** — `{id, annullata: true, giaAnnullata}`. Al primo annullamento `giaAnnullata` è `false`. Un annullamento ripetuto con la stessa chiave dà `true` e non manda un altro avviso. Dopo la conferma nel database, l’app tenta l’avviso nella campanella della sola persona assegnata, con il giorno e l’ora della visita. Se l’avviso fallisce o il processo si interrompe prima di inviarlo, l’annullamento resta valido.

**Errori** — quelli comuni, `404 ELEMENTO_NON_TROVATO` se la visita non è stata trovata per quella sede e chiave, `409 STATO_NON_AMMESSO` se la visita risulta svolta o non presentata.

```sh
curl -X DELETE --get "$BASE_URL/api/crm/ai/prenotazioni/<uuid della visita>" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  --data-urlencode 'sede=<uuid della sede>'
```

## 4. E1 · Registrare un contatto — POST /api/crm/ai/contatti

Corpo obbligatorio `sede`, `telefono`, `origine`. Facoltativi `genitoreNome` (1–120 caratteri), `email` (fino a 200 caratteri) e `bambini` (0–6 elementi). Per ogni bambino sono facoltativi `nome` (1–100 caratteri) e `dataNascita` (`AAAA-MM-GG`). Per un modulo del sito senza dati sui bambini ometti `bambini` o invia `[]`.

**201** — `{schedaId, creata: true, visita: null}`. **200** — `{schedaId, creata: false, visita}` quando la scheda esiste già nella sede, riconosciuta dal telefono o dall’email normalizzati. `visita` è `null` oppure `{id, inizio, stato}`, con stato `in_programma`, `svolto` o `non_presentato`. Questa API registra il contatto senza fissare la visita.

Se l’email riconduce a una sola scheda attiva della sede e il telefono è nuovo, E1 lo salva nel primo dei due campi telefono libero. Salva insieme il numero originale e quello normalizzato: da quel momento anche E2 ed E4 ritrovano la stessa scheda con il nuovo numero. I recapiti già presenti, il nome, l’origine e le scelte della segreteria restano quelli della scheda. Ripresentare un numero già noto non lo scrive di nuovo.

**Errori** — quelli comuni e `422 CONTATTO_OBBLIGATORIO` per recapito inutilizzabile. Se entrambi i campi telefono sono occupati e il numero è nuovo, o se telefono ed email portano a più schede, E1 e la prenotazione rispondono `500 CRM_OPERAZIONE_NON_RIUSCITA` senza cambiare recapiti, creare schede o unirle. Il codice è lo stesso degli altri errori tecnici. Se il problema si ripete, chiedi una verifica alla segreteria e comunica l’`x-request-id`. Non dare per acquisito il recapito.

```sh
curl -X POST "$BASE_URL/api/crm/ai/contatti" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"sede":"<uuid della sede>","telefono":"{{telefono}}","origine":"sito"}'
```

## 5. E2 · Riconoscere un contatto — POST /api/crm/ai/contatti/stato

Corpo obbligatorio `sede`, `telefono`. La ricerca riguarda le schede della sede che non sono state anonimizzate. Riconosce anche un numero alternativo e, se ci sono più corrispondenze, sceglie la scheda creata per prima (a pari data, il primo UUID).

**200** — `{esiste: true, schedaId, creatoVia, visita, bambini: [{id, nascita}]}`. `creatoVia` è `segreteria` oppure `ai`. `nascita` è `AAAA-MM` oppure `null`. La visita è la prima in programma che deve ancora terminare o, in mancanza, quella con l’inizio più recente fra le non annullate. Se nessuna visita è disponibile, `visita` è `null`. Se non c’è una scheda corrispondente, la risposta è `{esiste: false, schedaId: null, creatoVia: null, visita: null, bambini: []}`.

**Errori** — quelli comuni e `422 CONTATTO_OBBLIGATORIO`. Se la lettura di visite o bambini raggiunge il limite tecnico di 1.000 righe, la richiesta dà `500 CRM_OPERAZIONE_NON_RIUSCITA`: l’API rifiuta il risultato che potrebbe essere incompleto. Lo stesso vale quando i dettagli sono letti da E1 o E3.

```sh
curl -X POST "$BASE_URL/api/crm/ai/contatti/stato" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"sede":"<uuid della sede>","telefono":"{{telefono}}"}'
```

## 6. E3 · Nuovi contatti della segreteria — GET /api/crm/ai/contatti/nuovi

Query obbligatoria `sede`, `dopo` (istante ISO con fuso), `dopoId` facoltativo (UUID). La prima chiamata con il solo `dopo` cerca schede create dopo quell’istante, escluso l’istante stesso. L’elenco comprende le sole schede attive inserite dalla segreteria nella sede.

**200** — `{contatti, prossimoDopo, prossimoDopoId}`, con `Cache-Control: no-store`. Fino a 100 contatti in ordine crescente per `creataIl` e, a parità di istante, per `schedaId`. Ogni elemento è `{schedaId, creataIl, telefono, origine, visita, bambini}`. `telefono` è il primo recapito normalizzato o `null`. Visita e bambini hanno la forma di E2.

Per ogni pagina elaborata, salva **entrambi** i valori `prossimoDopo` e `prossimoDopoId` come nuovo cursore. Mandali alla richiesta successiva come `dopo` e `dopoId`: questo include anche le altre schede allo stesso istante con UUID successivo. Conserva la stringa esatta dell’istante, con offset e microsecondi. Codifica entrambi i valori nella query con `URLSearchParams` o `curl --data-urlencode`, così un offset con `+` non diventa uno spazio. Alla pagina vuota arrivano `contatti: []` e due cursori `null`: conserva l’ultimo cursore valido (o l’istante iniziale se non è mai arrivata una scheda) per la prossima lettura. La presenza nell’elenco non attesta il consenso a contattare la famiglia su WhatsApp.

**Errori** — quelli comuni, incluso `400` per cursori malformati. Su errore conserva il cursore della pagina già elaborata.

```sh
curl --get "$BASE_URL/api/crm/ai/contatti/nuovi" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  --data-urlencode 'sede=<uuid della sede>' \
  --data-urlencode 'dopo=<prossimoDopo o istante iniziale ISO>' \
  --data-urlencode 'dopoId=<prossimoDopoId>'
```

Per la prima richiesta senza UUID di ripresa, ometti l’intera opzione `dopoId`.

## 7. E4 · Passare alla segreteria — POST /api/crm/ai/richiami

Corpo in una delle due forme.

- `{sede, motivo, schedaId}` per una scheda già nota.
- `{sede, motivo, telefono, origine, genitoreNome?}` per cercare o creare la scheda dal telefono. `genitoreNome` è facoltativo (1–120 caratteri).

Scegli `motivo` fra `chiede_persona`, `prezzo`, `sconto`, `salute`, `reclamo`, `non_so`, `incomprensione`, `vocale`, `altro`. Invia la categoria, senza il testo della conversazione o informazioni sanitarie. La funzione SQL `crm_ai_richiamo` assegna la voce «Da richiamare» e salva lo storico in un’unica transazione. L’azione è per il giorno corrente alle 10:30 di Roma. Se c’è già un richiamo aperto, restituisce quello. Preferisce la persona dell’ultima visita se è ancora abilitata, poi la segreteria e infine la Direzione.

**201** — `{azioneId, schedaId, creata: true}`. **200** — stessi campi con `creata: false` quando il richiamo era già aperto.

**Errori** — quelli comuni, `404 SCHEDA_NON_TROVATA` per un ID assente, anonimizzato o fuori sede, `409 NESSUN_RESPONSABILE` se non c’è una persona abilitata per il nuovo richiamo, `422 CONTATTO_OBBLIGATORIO` per recapito inutilizzabile. Con `NESSUN_RESPONSABILE` il passaggio non è stato assegnato, anche se la chiamata via telefono può avere registrato il contatto. Un corpo che mescola le due forme dà `400`.

```sh
curl -X POST "$BASE_URL/api/crm/ai/richiami" \
  -H "Authorization: Bearer $CRM_AI_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"sede":"<uuid della sede>","telefono":"{{telefono}}","origine":"whatsapp","motivo":"chiede_persona"}'
```

## Dati restituiti e registro tecnico

Le risposte delle sette API escludono nomi di famiglie, bambini e personale, email, note, date di nascita complete e dettagli sanitari. Il mese di nascita nelle risposte E2 ed E3 serve per la fascia d’età. Il solo E3 restituisce il primo recapito normalizzato per il passaggio dei nuovi contatti della segreteria. L’accesso alle note delle visite (E5) resta fuori da questa versione.

Il middleware riconosce l’indirizzo delle API AI e le passa al controllo della chiave senza usare una sessione web o rinnovare i cookie. Il controllo dell’interruttore, della chiave e del limite viene prima della lettura del corpo. Il registro tecnico `app_log` usa operazione, esito, stato, identificativi tecnici e tempo della richiesta. I rifiuti anonimi del controllo sono registrati al massimo una volta al minuto per istanza. A interruttore spento il rifiuto non scrive nel database. Il wrapper delle API, il limitatore e il trasporto verso il database evitano di registrare URL con query, corpi, header inviati dal client, token, impronte o errori grezzi. Anche un guasto di rete produce una descrizione tecnica e un codice, quando disponibile. Per ritrovare la richiesta si usa l’`x-request-id` generato dal server.

## Servizi offerti dalla sede

Decisione del titolare (13/11/2026). La visita si rifiuta per età (`etaCoperta: false` in `/slot`, `422 ETA_NON_COPERTA` in `/prenota`) solo se la sede non offre il servizio per nessuna delle fasce d’età del bambino. L’elenco dei servizi è fisso, sta nella tabella `crm_servizi_sede` (una riga per sede e servizio) e non dipende da sezioni, posti o anno scolastico:

| Sede | Servizi |
|---|---|
| Giugliano | nido, infanzia, primaria |
| Aversa | nido, infanzia |
| Cesa | nido, infanzia, primaria |
| Demo (prove) | nido, infanzia, primaria |

Una sede senza righe non offre nessun servizio: la richiesta passa a una persona. Le fasce d’età sono calcolate dal solo mese di nascita (`src/lib/crm/ai/eta.ts`) e guardano all’inizio dell’anno scolastico in cui il bambino entrerebbe, non a oggi: nido se al prossimo 1° settembre avrà almeno 3 mesi di vita (chi li ha già oggi li ha anche a settembre) e fino ai 2 anni compiuti entro il 31 dicembre dell’anno di ingresso, infanzia da 3 a 5 anni con l’anticipo per i nati entro aprile, primaria da 6 a 10 anni con lo stesso anticipo. Il mese di nascita può essere nel futuro, per una nascita prevista: è accettato se a settembre il bambino avrà almeno 3 mesi (con nascita prevista fino a giugno entro il prossimo settembre), altrimenti `etaCoperta: false` o `422 ETA_NON_COPERTA`, mai un errore di formato; la scheda del CRM salva la data prevista nel campo `data_nascita`, che non ha vincoli sul futuro. Resta `400` solo per un formato non valido. L’assistente può dire la fascia, mai la classe. I valori iniziali li inserisce la migrazione `20261113212652_crm_servizi_sede.sql`; per ora si cambiano con un intervento sul database, non c’è ancora una pagina nelle impostazioni del CRM.

## Prima di aprire alle sedi vere

Punti noti, rimandati a dopo il collaudo sulla sola Demo.

- **Schede esistenti.** «Registra contatto» (E1) e la prenotazione scrivono su schede già esistenti quando riconoscono la famiglia da telefono o email: salvano un nuovo recapito nel primo campo libero. Da riesaminare con la segreteria prima di aprire alle sedi vere.
- **Ambiguità.** Due schede con lo stesso numero, o un terzo numero senza campo libero, tornano come errore generico `500 CRM_OPERAZIONE_NON_RIUSCITA`: l'assistente non può distinguere la causa e la verifica spetta alla segreteria.
- **Blocco in lettura delle disponibilità.** Durante una prenotazione le funzioni SQL bloccano in lettura le disponibilità di tutte le sedi; con più sedi attive e molte richieste insieme può rallentare le prenotazioni delle altre. Da misurare prima di aprire alle tre sedi.
