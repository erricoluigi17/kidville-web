# Le quattro cose rimaste aperte dopo `candidature-multisede` — design

**Data:** 2026-08-20 · **Branch:** `feat/candidature-multisede`
**Origine:** i quattro fronti di verifica avversariale e il critico di completezza del
2026-08-20 (journal `wf_a929e9b6-190`). Il rilascio è stato fermato su tre bloccanti, chiusi
in `84a91ef5`. Questo documento riguarda **ciò che è rimasto fuori di proposito**, e che il
titolare ha chiesto di chiudere prima del merge.

---

## Perché questo lavoro esiste

Alla domanda «al di fuori del tetto delle email non ci sono altri errori?» la risposta è
stata no, con quattro voci. Sono queste. Tre hanno un nome preciso nei rapporti dei fronti;
la quarta — «lo scaglione minore» — è un elenco di quattordici rilievi che nessuno aveva
riletto da quando è stato scritto, e che **è stato riverificato uno per uno sull'albero di
oggi** prima di entrare qui: alcuni erano già chiusi dalle correzioni dei bloccanti, e non
compaiono.

Una nota di metodo che vale per tutto il documento: **i rilievi dei fronti sono ipotesi
datate**. Fra la loro scrittura e oggi ci sono tre commit di correzione, e un rilievo che
descriveva il codice di ieri può descrivere il nulla. Ogni voce qui sotto porta la verifica
fatta oggi, non la citazione del rapporto.

---

## 1 · Il filtro di sede si lega al primo embed **per posizione**

### Il difetto

La rotta del cockpit interroga `candidature_insegnanti` con **due embed sulla stessa
tabella**:

```
.select(`${colonne}, ${EMBED_FILTRO_SCHEDA}, ${EMBED_TUTTE}`)
.in('candidature_sedi.scuola_id', scuole)
```

`EMBED_FILTRO_SCHEDA` è `candidature_sedi!inner(...)` e **restringe**; `EMBED_TUTTE` è
`sedi:candidature_sedi(...)` e **descrive**. PostgREST lega il filtro `candidature_sedi.…`
al **primo** embed di quella tabella nella stringa. Scambiare le due costanti sposta il
filtro sull'embed descrittivo: l'`!inner` smette di restringere, e l'elenco mostra
candidature di plessi che chi guarda non ha.

Misurato sulla produzione il 2026-08-20 e trovato corretto. **Ma nessun test lo protegge**, e
il motivo è il rilievo gemello: il finto dei test API (`candidature-insegnanti-scope-sede.test.ts:95-145`)
**non materializza mai l'embed filtrato**. Applica il filtro come predicato esistenziale
sulla riga e poi popola `sedi` con *tutte* le righe di sede, cablato. Un finto così non
distingue i due ordini: qualunque cosa faccia il sorgente, resta verde.

### Il rimedio, in due strati

**(a) Il finto impara la semantica posizionale.** Deve estrarre gli embed su
`candidature_sedi` **nell'ordine in cui compaiono** nella `select`, applicare il filtro al
**primo**, scartare la riga se quel primo è `!inner` e l'insieme filtrato è vuoto, e
materializzare **ciascun** embed con il proprio alias: quello filtrato con le sole righe che
passano, gli altri con tutte. Questo è il rimedio vero, perché rende *falsificabili* le
prove di scope già scritte.

**(b) Un lock d'architettura che legge il sorgente.** Per ogni `.select(...)` della rotta che
contiene due embed su `candidature_sedi`, pretende che quello con `!inner` compaia **per
primo**, e che il `.in('candidature_sedi.scuola_id', …)` sia nella stessa catena.

Servono entrambi e non è ridondanza: (a) sorveglia il **comportamento** e cadrebbe anche per
una terza forma che oggi non immaginiamo; (b) sorveglia l'**ordine** e dice in chiaro, nel
punto in cui si sbaglia, che l'ordine è un contratto. Un lock strutturale da solo lo si
aggira scrivendo la query altrove; un finto da solo non spiega perché.

**Controllo negativo obbligatorio.** Entrambi vanno rotti apposta e visti cadere. La lezione
di `PublicPageHeader-logo.test.tsx` — un lock verde per due giorni su una pagina senza logo —
è che «sabotato per vederlo cadere» dev'essere un gesto **eseguito**, e va scritto nel file
che è stato eseguito e cosa si è visto.

---

## 2 · La conservazione GDPR si calcola **per riga di sede**

### Il difetto

`candidature_insegnanti.evasa_il` è **una colonna sola** e porta il termine di **più
trattamenti distinti**. Il trigger di aggregazione ci scrive `max(evasa_il)` delle righe di
sede, e solo quando nessuna sede è più `pending`.

Il cron (`/api/gdpr/retention-candidature`) calcola così: 12 mesi (24 col consenso) dalla
**decisione** se la candidatura è respinta, dalla **ricezione** in ogni altro caso.

Il caso che sbaglia è quello **misto**: Aversa rifiuta a novembre, Giugliano approva a
dicembre, la candidatura è arrivata a gennaio. L'aggregato vale `approvata`, quindi il
termine decorre dalla **ricezione**: la candidatura si cancella a gennaio dell'anno dopo,
cioè **due mesi** dopo il rifiuto di Aversa invece dei dodici promessi. Il verbale di quel
rifiuto sparisce prima del dovuto — che è esattamente la classe di difetto che la migrazione
`20260820004500` era nata per chiudere, su un altro percorso.

### Il rimedio

La scadenza si calcola **per riga di sede** e la candidatura si cancella quando è scaduta
**l'ultima**:

| riga di sede | giorno d'inizio |
|---|---|
| `rifiutata` | la **sua** `evasa_il` |
| `approvata` | la ricezione |
| `pending` | la ricezione |

`scadenza(candidatura) = max(scadenza(riga))`. La durata (12 / 24 mesi) resta una proprietà
della **persona** — dipende dal consenso, che è uno solo — non della riga.

Questo non cambia niente nei casi non misti: tutte rifiutate → `max(evasa_il)`, identico a
oggi; tutte approvate o mai valutate → ricezione, identico a oggi. **Cambia solo il caso
misto, e nel verso che conserva.**

### Il degrado

L'ambiente E2E della CI non ha `candidature_sedi`. La lettura dell'embed deve degradare su
`PGRST200`/`42P01`/`PGRST205` **tornando alla regola di oggi**, non saltando la spazzata:
una conservazione che non gira è peggio di una conservazione approssimata. Il degrado si
logga a livello `warn` con il codice, mai in silenzio.

### Cosa NON si fa

Non si tocca l'informativa. La regola che si applica dopo questo lavoro è **più conservativa**
di quella dichiarata, mai meno: nessuna promessa viene ridotta, quindi non c'è niente da
riscrivere. Il commento di `candidature_ricalcola_stato` che oggi dice «la correzione onesta
sarebbe la retention per riga di sede» va aggiornato: da oggi quella correzione c'è, e
`max(evasa_il)` sulla madre resta solo come **valore di comodo per l'interfaccia**, non più
come base di un termine di legge. Va detto lì, perché è lì che qualcuno lo rileggerà.

---

## 3 · I due test instabili

Due prove sul **fuoco** (`CandidatureInsegnanti`, `StaffDetailPanel-anagrafica`) sono cadute
una volta e passate al rerun, su file diversi. La suite intera rieseguita oggi alle 10:26 è
**962 file / 12077 test, tutti verdi**: non si sono ripresentate.

Un test che passa al secondo tentativo non è un test: è un dado. Il metodo è
`systematic-debugging` — riprodurre prima di correggere, e **non correggere ciò che non si
riproduce**. Il piano prevede una campagna di riproduzione (i due file da soli, in ordini
diversi, ripetuti; poi la suite intera con seed diverso) e **due esiti leciti**:

- **si riproduce** → si trova la causa (fuoco lasciato sporco da un test precedente, `cleanup`
  mancante, timer, ordine dei file) e si corregge alla radice;
- **non si riproduce in N tentativi** → **non si tocca niente**, e si scrive nel documento di
  collaudo quante volte si è provato e come. Inventare una correzione per un difetto che non
  si sa riprodurre significa aggiungere codice che nessuno può falsificare.

Il secondo esito è un esito, non una rinuncia. Va dichiarato come tale al titolare.

---

## 4 · Lo scaglione «minore» — e i medi rimasti sotto

Quattordici voci, riverificate oggi. Tre erano già chiuse e non compaiono. Le altre si
raggruppano per **classe di difetto**, non per fronte, perché è così che si correggono senza
rifare due volte lo stesso ragionamento.

### 4a · Commenti che dicono il falso (tre)

Non sono rifiniture cosmetiche: in questo repo i commenti sono il posto dove vive la memoria
delle misure, e uno che mente **costa più di nessun commento**, perché chi lo legge smette di
verificare. Sono già costati due giorni in questo stesso lavoro.

- `__tests__/components/PublicPageHeader-logo.test.tsx:99-102` — dice che `/iscrizione` passa
  il selettore di lingua come `children`. Falso su tre punti: `/iscrizione` non usa quel
  componente, non ha nessun `LanguageSwitcher`, e «delle cinque» è il conteggio che il commit
  precedente dichiara di aver ritirato. La pagina che passa `children` è
  `/cancellazione-account`.
- `src/components/ui/MarchioKidville.tsx` — «DUE testate» (ce n'è una terza, ricopiata a mano,
  in `/cancellazione-account/conferma`); prescrive una `grep` che **per costruzione non può
  trovare** la classe di difetto per cui il file è nato (elenca solo chi il marchio ce l'ha);
  «lo lascia definito UNA volta» mentre `src/app/auth/login/page.tsx` monta l'`<Image>` a mano.
- `src/app/api/admin/candidature-insegnanti/route.ts:1043-1048` — `rifiuta()` passa
  `da: ['pending', 'in_approvazione']` a una tabella il cui `CHECK` non ammette
  `in_approvazione`: un valore che non può mai corrispondere, con sopra un commento che
  spiega perché serve.

### 4b · Dati che viaggiano senza che nessuno li disegni (due)

- `COLONNE_DETTAGLIO` spedisce ancora `candidature_insegnanti.motivo_rifiuto` — testo libero
  di giudizio su una persona, **non filtrato per sede**, che nessuno scrive più e nessuno
  rende. Oggi innocuo perché la colonna è vuota; il giorno di un import torna a uscire verso
  ogni plesso in scope senza che una riga di codice cambi.
- `EMBED_ELENCO` spedisce `sedi` (plesso + stato decisionale **altrui**) per ogni candidatura
  a ogni apertura di pagina, e l'elenco non lo legge: `riga.sedi` serve solo a
  `sedeSuCuiDecido`, chiamata sempre sulla candidatura **aperta**. È la dottrina «l'elenco è
  povero» applicata a `motivo_rifiuto` e non al resto.

  ⚠️ Qui la verifica di oggi corregge il rapporto: `sedeSuCuiDecido` è chiamata **anche**
  sulle righe dell'elenco per decidere se il pulsante è attivo. Va misurato prima di
  togliere: se serve, resta e si scrive **perché**; se non serve, esce. La decisione sta nel
  piano, non qui.

### 4c · L'uuid confrontato come stringa grezza (uno)

`route.ts:511` — `scuole.includes(sedeDichiarata)`: `scuole` porta le forme canoniche dal
database, `sedeDichiarata` è la stringa del client, e `z.guid()` **accetta il maiuscolo**. Un
client che manda l'uuid in maiuscolo si vede negare la **propria** sede con un 404 e accende
`logEvento('multi_sede','warn',{esito:'sede-fuori-scope'})` — cioè riempie di falsi positivi
un contatore nato come segnale di sicurezza. È parola per parola il difetto che
`src/lib/auth/scope.ts:95-107` racconta come già misurato il 2026-07-31, reintrodotto perché
il confronto è fatto a mano invece che con `formaConfronto`.

### 4d · Il singolare rimasto in un flusso diventato plurale (tre)

- `messages/{it,en}/public.json` — sei chiavi promettono «**la** Direzione» e «**la** sede» a
  chi si è appena candidato a tre plessi, una delle quali sulla riga immediatamente
  successiva a `candContestoDirezione`, che dice «ciascuna la valuta per conto suo».
- La **conferma alla candidata** elenca tutte le sedi nel corpo e nel piede dice «hai inviato
  una candidatura a Giugliano». Stesso difetto già corretto venti righe più su, nello stesso
  file.
- Il **ruolo** nella conferma: chi spunta «Altro» riceve «Ruolo: Altro (specifica qui
  sotto)» — l'istruzione del modulo al posto del mestiere — e ciò che ha scritto davvero
  (`posizione_altro`) non compare.

### 4e · Il client che incolpa la sede sbagliata (uno, MEDIO)

Il server, quando *una qualsiasi* delle sedi non è valida, risponde `SEDE_DA_SPECIFICARE`
**senza dire quale**; il client marca `sedeSmentitaDalServer(sedi[0])`, cioè spesso la sede
**valida**. Poi mostra un messaggio al singolare a chi ne aveva scelte due, dopo aver azzerato
tutte le spunte. Il rimedio giusto sta **sul server**: il 400 deve dire *quali* sedi ha
rifiutato. Il client smette di indovinare e nomina quelle.

### 4f · Tetti e forme di risposta (tre)

- `MAX_SEDI_PER_CANDIDATURA = 3` è cablato mentre il commento accanto dice che è `sediReali` a
  decidere; il client non lo conosce; il rifiuto arriva come «Si è verificato un errore
  durante l'invio». Il tetto va **derivato** dalle sedi reali e il messaggio deve arrivare.
- Nessun tetto alla **lunghezza grezza** dell'array prima del `refine` sui distinti.
- `{ "id": null }` resta possibile nel ramo `duplicata-riga-viva-non-trovata`, contro la
  dottrina scritta nello stesso file secondo cui una risposta di forma diversa **è** l'oracolo.

### 4g · La schermata che sopravvive al proprio scope (uno)

Togliere una sede dal selettore in alto ricarica l'elenco ma **non chiude il pannello**: resta
a schermo con i dati di una candidatura di quella sede, e «Rifiuta» spedisce una sede fuori
scope. Nessuna fuga — quei dati erano stati letti legittimamente — ma è una schermata che
mostra ciò che il suo scope non copre più.

### 4h · I pulsanti accesi su un percorso che non può riuscire (uno)

Il ripiego `mia?.stato ?? cand.stato` è documentato come servizio «all'ambiente non ancora
migrato». In quell'ambiente `cambiaStato` degrada **solo sulla colonna assente**, non sulla
tabella assente: ogni «Approva» prende `42P01` e torna 503. Il badge può ripiegare; i
**pulsanti** no — vanno spenti, con il motivo scritto.

### 4i · Il sospetto che va misurato, non dedotto (uno)

Il marchio su `/iscrizione` aggiunge ~250 px a una riga `flex` **senza `flex-wrap`**, contro
320 px disponibili a 360 px di viewport. È aritmetica su valori dichiarati in commenti, non
una misura: **va aperto un browser** a 320 e 360 px e letto lo `scrollWidth`. Se il difetto
c'è si corregge; se non c'è, si scrive che è stato misurato e non c'era.

---

## Cosa resta fuori, e perché

- **Il marchio su `/cancellazione-account/conferma` e `/m/[token]`.** Debito preesistente:
  `git diff main...HEAD` non tocca né l'una né l'altra. Entra nel prossimo lavoro, insieme al
  lock derivato da `PUBLIC_PREFIXES` invece che cablato a sette voci.
- **Il tetto delle email.** Non è un difetto del codice: è una decisione fra abbassare
  `INVITI_AL_GIORNO`, alzare il piano Resend, o accettare le perdite. Spetta al titolare e
  resta aperta.
- **Il lock del marchio derivato da `PUBLIC_PREFIXES`** e il **controllo negativo codificato**
  su quel lock: è il rimedio giusto al rilievo «l'elenco è cablato a sette voci», ma cambia un
  lock che sorveglia sette pagine, di cui due fuori da questo diff. Va fatto quando si fanno
  anche quelle.

---

## Come si verifica che questo lavoro è finito

- `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` · `npm run build`.
- **Ogni lock nuovo è stato rotto apposta e visto cadere**, e il file lo dice.
- La suite gira **tre volte di fila** verde, non una: è la prova che riguarda il punto 3.
- `/iscrizione` è stata **aperta davvero** a 320 e 360 px, e la misura è scritta.
- Il PRD porta la voce di changelog datata, come ogni intervento di questo repo.
