# Audit dell'isolamento fra sedi — 30 luglio 2026

> **Riallineato il 2026-07-31.** La prima stesura di questo documento dichiarava chiuse **dodici
> voci che nessuna PR d'isolamento aveva mai toccato**, e descriveva come aperto un difetto già
> risolto. Non per malafede: l'inventario era stato compilato *per intenzione* — l'elenco delle
> route **da correggere** è diventato l'elenco delle route **corrette**, e nessuno l'ha mai
> confrontato con `git show --name-only`. Ogni voce è stata riverificata una per una contro il
> diff reale e contro il codice di oggi; ognuna cita ora il **commit** che l'ha risolta.
>
> **Il lock è la parte che sopravvive a questo documento**, e adesso sono due:
> `__tests__/architecture/isolamento-sede-coverage.test.ts` obbliga ogni handler service-role che
> tocca dati di persone a dichiarare la sede (o a comparire nella sua allowlist con la ragione
> scritta), e `__tests__/architecture/inventario-audit-verita.test.ts` obbliga **questo file** a
> non dire il falso: ogni riga dell'inventario deve superare quel criterio **e** citare un commit
> che ha davvero toccato quel file. Un inventario invecchia; un lock no.
>
> Il changelog dei rilasci sta nel `PRD REGISTRO ELETTRONICO.md`; la ricognizione del giorno dopo,
> con i 140 rilievi che hanno prodotto la maggior parte dei commit citati qui, sta in
> `docs/audit/2026-07-31-audit-globale-multisede.md`.

## Perché

Il 29 luglio la produzione è passata da una sede a tre. Con un plesso solo il **nome della classe**
era di fatto una chiave univoca; con tre plessi «2 ANNI» e «5 ANNI» esistono in due sedi diverse.
Sette route che filtravano gli alunni per `classe_sezione` senza vincolo di `scuola_id` hanno
cominciato a perdere dati di minori fra plessi — **col gate formale verde**, 3424 test e E2E
passanti. Corrette (PR #57), ma erano tutte della stessa famiglia e sono emerse solo cercandole di
proposito. Questo audit verifica **tutte** le 282 route, una per una.

## Il modello di autorizzazione

| Livello | Vede e scrive su |
|---|---|
| **La classe appartiene alla sede** | una sezione non esiste «in astratto»: esiste **dentro** un plesso. Il suo nome **non è** un identificatore globale |
| **Admin / Direzione** | tutte le sedi (ponte `utenti_scuole`) |
| **Segreteria** | **solo la propria sede** (`utenti.scuola_id`) |
| **Coordinatore** | il proprio plesso, tutte le classi — già così oggi (`vedeTutteLeClassi`) |
| **Docente / educator** | il proprio plesso, e **solo le sezioni assegnate** (`utenti_sezioni`) |
| **Genitore** | solo i propri figli, indipendentemente dalla sede |
| **Cuoca** | nessun accesso nominativo ai minori fuori dal proprio compito |

### Decisioni prese dal titolare il 2026-07-30

| Ambito | Decisione | Conseguenza dichiarata |
|---|---|---|
| Segreteria | **solo la propria sede, da subito** | Aversa e Cesa (nessun personale) restano gestibili **solo dall'admin**. Al momento della decisione: **8 iscrizioni pendenti** su quelle due sedi |
| Educator | **solo le sezioni assegnate** | 9 educator su 10 le hanno già. Una supplente o una compresenza su una classe non assegnata riceve 403 finché non la si assegna |
| Contabilità | segreteria sul proprio plesso; le operazioni **cross-sede** (riconciliazione, incasso unico di famiglia, storni) **solo admin** | — |
| Chat | rubrica e conversazioni **della propria sede**; aggiunto il controllo mancante su chi apre un thread | — |
| `locker_config` | ripuntata su **`section_id`** | La tabella è vuota in produzione: migrazione a costo zero, e l'omonimia sparisce alla radice |
| `form_models` | **selezione della sede alla creazione del modulo** | Colonna sede (vuota = tutte) **+ selettore nel costruttore di moduli** |
| Informativa sul modulo pubblico | resta **l'ultimo passo**, come da piano | Il modulo raccoglie ~9 invii/ora senza informativa: rischio accettato esplicitamente |

## Numeri misurati in produzione (2026-07-30)

- Sedi reali: Giugliano (46 utenti, 18 sezioni, 25 alunni) · Aversa (1, 5, 1) · Cesa (0, 12, 0), più la sede finta E2E.
- Nomi di classe ripetuti fra sedi: **2** («2 ANNI», «5 ANNI»).
- **Unico account di personale non-TEST: 1 admin.** Educator 10/10, segreteria 1/1, coordinator 1/1, cuoca 1/1 sono account TEST. Nessuna restrizione applicata oggi chiude fuori una persona reale.
- Route API 282 · con gate di ruolo 188 · con `createAdminClient` 266 · **che usano un helper di scope 137**.
- Tabelle senza `scuola_id`: 57 su 117.

## Come si corregge

**Gate e filtro insieme, sempre.** Il gate (`assertClasseNomeInScope`, `assertAlunnoInScope`,
`assertSezioneInScope`, `assertAlunniInSezione`) impedisce di *nominare* una risorsa altrui; il
filtro (`.in('scuola_id', await resolveScuoleAttive(...))`, con `!inner` sui join) impedisce che
l'**omonimia** porti dentro i record dell'altra sede. Uno solo dei due non basta, e ogni correzione
porta **due prove di validità separate**: togli il gate → test rosso; togli il filtro → test rosso.

**Scope vuoto ⇒ nega.** Mai un fallback che toglie il filtro: `.in(…, [])` non deve mai diventare
«nessun filtro».

**I mock devono filtrare davvero** (`__tests__/fixtures/finto-supabase.ts`): con un mock piatto un
test d'isolamento è verde **anche senza** il filtro, e non prova niente.

---

## Inventario, per route

Una riga per route, e ognuna porta la sua prova. Prima di questa revisione le righe erano
raggruppate e la «prova» era il numero di una PR: è così che dodici voci false sono passate
inosservate — `PR #60` non è verificabile a colpo d'occhio, `2484a2f` sì.

**Come si legge la colonna «Prova».** Lo sha è il commit che ha introdotto il presidio oggi
presente nel file; la data è quella del commit. Dove ce ne sono due, il primo ha messo il gate e il
secondo l'ha completato (di solito: il 30/07 la lettura, il 31/07 la scrittura). Alcune route non
sono mai state toccate dall'audit perché lo scope ce l'avevano da mesi: lì la prova è il commit
d'origine, e la riga lo dice.

**Stati.** `CHIUSA` = il presidio è nel codice e il lock di copertura lo vede · `N/A` = la sede non
è il criterio d'accesso (scope famiglia, token pubblico, gestione delle sedi stesse) · `APERTA` =
manca. Non esiste lo stato «per intenzione».

<!-- INVENTARIO:INIZIO — formato letto da `__tests__/architecture/inventario-audit-verita.test.ts`.
     Una riga di tabella = una route: | `rotta` | STATO | prova | cosa perdeva |
     Prima cella: il nome della route fra backtick, come sotto `src/app/api/`.
     Seconda cella: CHIUSA · APERTA · N/A.
     Terza cella (obbligatoria su CHIUSA): almeno uno sha fra backtick e la data AAAA-MM-GG.
     Il lock verifica che ogni sha citato abbia DAVVERO toccato quel file, e che il file superi il
     criterio di `isolamento-sede-coverage.test.ts`. Aggiungere una riga CHIUSA senza il codice
     dietro fa fallire la suite, e dice quale. -->

### Presenze

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `attendance/daily` | CHIUSA | `4b1d7a0` 2026-07-30 (GET) · `c96b24c` 2026-07-31 (POST) | La prima stesura la dava chiusa dal 29/07: era vero **solo per la GET**. La POST restava nuda — una segreteria poteva segnare le presenze dei bambini di un altro plesso, e per un giorno il lock è stato verde perché guardava il file e non l'handler |
| `attendance/delegates` | CHIUSA | `4b1d7a0` 2026-07-30 · `fb20145` 2026-07-31 | Deleghe al ritiro di alunni di un'altra sede |
| `attendance/monthly` | CHIUSA | `a9f10d9` 2026-07-16 · `fb20145` 2026-07-31 | Riepilogo mensile per nome-classe: `assertClasseNomeInScope` aggiunto il 31/07 |
| `admin/presenze/realtime` | CHIUSA | `a555587` 2026-07-03 | Mai toccata dall'audit: nasce multi-sede, filtra su `scuoleDiUtente` |
| `primaria/appello` | CHIUSA | `fb20145` 2026-07-31 | Appello su sezioni di altre sedi |
| `primaria/ore-assenza` | CHIUSA | `9e05711` 2026-07-02 | Mai toccata dall'audit: `assertSezioneInScope` dal 2 luglio |
| `primaria/presenze/giust-vista` | CHIUSA | `06d972b` 2026-07-02 | Idem |
| `primaria/giustifiche-didattiche` | CHIUSA | `06d972b` 2026-07-02 | Idem |
| `parent/presenze` | N/A | — | Scope famiglia: i propri figli, in qualunque plesso |

### Diario, note, valutazioni

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `diary/students` | CHIUSA | `aa12fea` 2026-07-30 (PR #59) · `fb20145` 2026-07-31 | Ramo `?id=` senza gate: `note_mediche` di un minore ed email dei genitori a chiunque, senza credenziali. Verificato in produzione: HTTP 200 |
| `notes` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | `?alunnoId=` libero; senza parametro **tutte** le note disciplinari di tutte le sedi. Il POST inseriva note su `alunnoIds` arbitrari e notificava i genitori |
| `grades` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Idem su `valutazioni` |
| `educator-sections` | CHIUSA | `2484a2f` 2026-07-30 · `26cf931` 2026-07-31 | Il ramo manager elencava le sezioni di tutte le sedi |

### Anagrafica e credenziali

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `admin/students/[id]` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | `select *` + codice fiscale + `parents(*)` (CF, documento, indirizzo, telefoni) + `delegates(*)` + fratelli, per qualunque alunno di qualunque sede |
| `admin/parents` | CHIUSA | `2484a2f` 2026-07-30 · `534abd2` 2026-07-31 | Anagrafica dei genitori delle tre sedi |
| `admin/parents/[id]` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Idem, per id |
| `admin/regenerate-credentials` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Reset password e invio credenziali a un genitore di un'altra sede |
| `admin/credentials-pdf` | CHIUSA | `fb20145` 2026-07-31 | **Voce falsa nella prima stesura**: PR #60 non l'ha mai toccata. L'autorizzazione era delegata all'entropia della chiave (`<uuid>-<epoch>.pdf`) — autorizzazione per oscurità. Ora la chiave viene decomposta e la sede risolta dal destinatario. È anche una delle route **invisibili al lock**: non nomina nessuna tabella |
| `admin/import/anagrafiche` | CHIUSA | `fb20145` 2026-07-31 | **Voce falsa nella prima stesura.** Il dedup del codice fiscale era **globale**: importare un CSV in una sede agganciava i genitori nuovi al bambino omonimo di un'altra — una concessione **durevole** di lettura cross-sede, non una svista di query |
| `admin/sidi/legami` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Creava legami genitore↔figlio cross-sede |
| `admin/sections/[id]/teachers` | CHIUSA | `fb20145` 2026-07-31 · `0bd4ce2` 2026-07-31 | **Voce falsa nella prima stesura**: il file era fermo a `15a0647` (PR #56). Si assegnavano docenti a sezioni di altre sedi, e il grafo corrotto è la sorgente dei destinatari delle notifiche sui minori |
| `locker/materials` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Materiali dell'armadietto della classe omonima altrui |
| `locker/notify` | CHIUSA | `fb20145` 2026-07-31 | **Voce falsa nella prima stesura** (il file era fermo a `aba85e3`), ma il difetto ipotizzato non c'era: il gate è il legame genitore↔figlio. Il 31/07 è stata corretta per un'altra ragione — la risoluzione dello staff da notificare ignorava il ponte `utenti_scuole` |
| `locker/requests` | CHIUSA | `fb20145` 2026-07-31 | **Voce falsa nella prima stesura** (il file era fermo a `df9b8eb`, PR #32). Il gate sul nome-classe è arrivato il 31/07 |

### Chat e comunicazioni

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `admin/chat/contacts` | CHIUSA | `2484a2f` 2026-07-30 · `26cf931` 2026-07-31 | Nome e classe di **tutti** i minori e i genitori delle tre sedi, con la chat già apribile. ⚠️ La correzione del 29/07 riguardava il **gemello** `chat/contacts` (lato docente): questa non era mai stata toccata |
| `admin/chat/threads` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Tutte le conversazioni genitore↔docente delle tre sedi, coi nomi dei minori |
| `admin/chat/messages` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Contenuto dei messaggi di qualunque thread |
| `chat/threads` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Il POST verificava solo di essere partecipante, non che il minore fosse della propria sede |
| `avvisi/[id]/risposte` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Risposte e nomi di genitori/alunni di un avviso di un'altra sede |
| `admin/segnalazioni` | CHIUSA | `fb20145` 2026-07-31 | **Voce falsa nella prima stesura**: il file era fermo a `3e8eb79` (PR #52, moderazione UGC). La coda di moderazione era di tutte le sedi, in lettura e in presa in carico |

### Galleria

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `gallery` | CHIUSA | `2484a2f` 2026-07-30 · `fb20145` 2026-07-31 | PATCH e DELETE autorizzavano per **intersezione di nomi-classe**, e per la segreteria dal ramo `isAdmin` che concedeva tutto: il docente del «2 ANNI» di Aversa poteva modificare o eliminare le foto dei bambini del «2 ANNI» di Cesa. Ora la sede del media si confronta prima, i nomi dopo |

### Modulistica

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `admin/forms/submissions` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Domande di iscrizione e dati di famiglia di tutte le sedi |
| `admin/forms/submissions/[id]` | CHIUSA | `fb20145` 2026-07-31 | **Non era in elenco nella prima stesura**: la PATCH alterava il punteggio e rileggeva per intero la domanda di un'altra sede |
| `admin/forms/rankings` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Graduatorie di tutte le sedi |
| `forms/export/pdf` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Export con nomi dei minori |
| `forms/export/xlsx` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Idem |
| `forms/delibera` | CHIUSA | `fb20145` 2026-07-31 · `534abd2` 2026-07-31 | **Voce falsa nella prima stesura.** La segreteria di un plesso decideva ammessi, lista d'attesa e non ammessi su domande di qualunque plesso — e la scrittura passava dagli id inviati nel corpo della richiesta |
| `forms/export/delibera` | CHIUSA | `fb20145` 2026-07-31 | **Voce falsa nella prima stesura**: PDF con nomi dei minori e graduatoria, senza filtro di sede |
| `parent/forms` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | I template erano filtrati per **nome classe**: al genitore di Aversa comparivano i moduli del «2 ANNI» di Cesa |

### Mensa

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `mensa/prenotazioni` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Il ramo staff (`STAFF_FORZA`) prenotava, disdiceva e leggeva per qualunque alunno di qualunque sede. Lo staff resta libero di forzare allo sportello, dentro il proprio plesso |

### Contabilità

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `pagamenti/tutori` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Tutori paganti di un'altra sede |
| `pagamenti/pagante-comune` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Idem |
| `pagamenti/credito` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Credito di famiglia di un'altra sede |
| `pagamenti/quote` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Quote di un'altra sede |
| `pagamenti/incassi` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Si incassava su pagamenti di un'altra sede |
| `pagamenti/incassi/[id]` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Idem, per id |
| `pagamenti/incassi/storno` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Si stornava un incasso di un'altra sede |
| `pagamenti/[id]/sconto` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Sconti su pagamenti di un'altra sede |
| `pagamenti/fattura` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Si fatturava per un'altra sede |
| `pagamenti/fattura/list` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Elenco fatture di tutte le sedi |
| `pagamenti/ricevuta` | CHIUSA | `2484a2f` 2026-07-30 · `26cf931` 2026-07-31 | Ricevute di un'altra sede |
| `teacher/uscite` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Moduli di uscita didattica fuori dalle proprie sezioni |

Le altre 24 route del modulo erano già in scope. Le operazioni **volutamente** cross-sede
(riconciliazione bancaria, incasso unico di famiglia, prospetto famiglia) stanno nell'allowlist del
lock di copertura, ognuna con la sua ragione: il conto corrente della cooperativa è uno solo e due
fratelli possono stare in due plessi.

### Registro primaria e competenze

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `teacher/medical-certificates` | CHIUSA | `aa12fea` 2026-07-30 (PR #59) | Certificati medici di tutte le sedi: il gate c'era, il filtro no |
| `admin/competenze` | CHIUSA | `2484a2f` 2026-07-30 · `fb20145` 2026-07-31 | Certificati delle competenze di sezioni di altre sedi, leggibili e modificabili |
| `admin/competenze/download` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Scarico del certificato di un'altra sede |
| `admin/competenze/genera` | CHIUSA | `fb20145` 2026-07-31 | **Voce falsa nella prima stesura**: la Direzione di un plesso generava e **firmava (FEA)** i certificati delle competenze di un altro plesso |
| `admin/primaria/docenti-materie` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Scritture su sezioni di altre sedi |
| `admin/primaria/materie` | CHIUSA | `2484a2f` 2026-07-30 (GET) · `fb20145` 2026-07-31 (POST/PATCH/DELETE) | **Chiusa a metà nella prima stesura**: PR #60 aveva messo in scope il solo GET; POST (anche `apply-preset`), PATCH e DELETE scrivevano su sezioni di altre sedi |
| `admin/primaria/orario` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Idem |
| `admin/primaria/materia-obiettivo` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Idem |
| `admin/primaria/fascicolo-audit` | CHIUSA | `2484a2f` 2026-07-30 (PR #60) | Rivelava **quali** minori hanno un fascicolo PEI/PDP/104, in tutte le sedi |

Il fascicolo vero e proprio (`primaria/fascicolo`, `/file`, `/pagelle`) era già in regola e va usato
come modello: `src/lib/primaria/fascicolo-rbac.ts:47-56` nega con motivo `cross-tenant` e traccia
ogni accesso su `fascicolo_accessi_audit`.

### GDPR

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `admin/gdpr/candidates` | CHIUSA | `2484a2f` 2026-07-30 · `26cf931` 2026-07-31 | Nomi di minori non iscritti e genitori collegati, tutte le sedi |
| `admin/gdpr/erase` | CHIUSA | `2484a2f` 2026-07-30 · `534abd2` 2026-07-31 | **Anonimizzava in modo irreversibile** un alunno e i suoi genitori di un'altra sede. La bonifica resta volutamente cross-sede una volta autorizzata (allowlist del lock): cancellare «solo nella mia sede» sarebbe una cancellazione finta |
| `admin/gdpr/richieste` | CHIUSA | `2484a2f` 2026-07-30 · `534abd2` 2026-07-31 | Leggeva `scuola_id` e non ci confrontava niente |

### Certificati medici

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `parent/medical-certificates/file` | CHIUSA | `aa12fea` 2026-07-30 (PR #59) | Il ruolo bastava a scaricare il PDF di un minore di un'altra sede |

### Altro

| Route | Stato | Prova | Cosa perdeva |
|---|---|---|---|
| `admin/audit` | CHIUSA | `fb20145` 2026-07-31 | **Voce falsa nella prima stesura, e la più costosa**: il file era fermo al commit di logging (`af20dd8`, 13 luglio). Il registro immutabile delle scritture di **tutte** le sedi è rimasto leggibile dalla segreteria di un plesso per tutto il 30 e il 31 luglio, con la sua riga «CHIUSA» accanto. `scuola_id` era perfino nella proiezione: letto e non usato |
| `admin/protocolli/upload-url` | N/A | — | **Voce infondata nella prima stesura**: non tocca nessuna tabella e non legge dati di nessuno. Firma un URL di caricamento verso `staging/<uuid casuale>-<nome>` dietro `requireStaff(['admin','segreteria'])` e rate limit. La sede entra in gioco al passo successivo, quando il protocollo viene registrato |

### News · Notifiche · Iscrizioni

30 route verificate una per una il 30/07: già in scope o non applicabili. La ricognizione del 31/07
ha però trovato in quest'area difetti di **destinatario**, non di lettura (avvisi e news che non
raggiungevano Aversa e Cesa, allarme allergie muto, digest sulla sede finta): stanno nell'audit del
31 e nel PRD, non qui — questo documento parla di isolamento, non di consegna.

<!-- INVENTARIO:FINE -->

---

## I difetti che non sono «una route da filtrare»

### 1. Il vincolo di unicità del registro non conteneva la sede — risolto

```sql
-- prima
unique_registro_orario UNIQUE (classe_sezione, data, ora_lezione)   -- manca scuola_id
-- adesso
unique_registro_orario UNIQUE (scuola_id, classe_sezione, data, ora_lezione)
```

Migrazione **`supabase/migrations/20260730141828_registro_orario_unique_per_sede.sql`** (nel repo
dal commit `a10ceac`, 2026-07-31). Applicata al database di produzione e **riverificata su
`pg_index` il 31/07**: `CREATE UNIQUE INDEX unique_registro_orario … USING btree (scuola_id,
classe_sezione, data, ora_lezione)`.

Era l'unico difetto che **corrompeva** dati invece di esporli, ed era invisibile in lettura perché
il gate di scope sulle due route c'era: gli upsert su `onConflict: 'classe_sezione,data,ora_lezione'`
condividevano la stessa riga fra sedi omonime, e argomento, compiti e firme del «2 ANNI» di Aversa
sovrascrivevano quelli di Cesa. Al momento della migrazione: **14 righe, 0 collisioni** — indolore.

Il codice usa ora `CHIAVE_REGISTRO = 'scuola_id,classe_sezione,data,ora_lezione'`
(`src/lib/registro/chiave-orario.ts`), con ripiego sulla chiave storica **solo** su errore `42P10`
— cioè sul database E2E della CI, che non è migrato. Il lock
`__tests__/architecture/chiave-registro-per-sede.test.ts` impedisce che i due `onConflict`
divergano di nuovo.

> La prima stesura di questo documento descriveva il punto come aperto quando era già risolto: è
> stata scritta durante il lavoro e non riallineata dopo la migrazione. Vale come promemoria che un
> inventario a mano invecchia in ore, non in mesi.

### 2. L'identità da header aggirava il proprio interruttore — risolto

`ALLOW_HEADER_IDENTITY` è a `false` in produzione, ma il flag viveva solo dentro `resolveIdentity`
(`require-staff.ts`): quattro route chiamavano `getRequestUserId` **in diretta**, quindi
`x-user-id: <uuid qualsiasi>` era accettato comunque. Una di esse produceva una **firma elettronica
con valore legale** (`fea_audit_log`, il codice cita il CAD art. 20) attribuibile a un genitore
qualunque; le altre tre facevano partire l'OTP senza sessione e senza limite di frequenza.

Risolto da **`447b6c3`** (2026-07-31): tutte e quattro passano ora da `resolveIdentity`, con i test
`__tests__/api/firma-identita-da-sessione.test.ts` e `__tests__/api/otp-firma-senza-sessione.test.ts`.

### 3. Fail-open sul filtro di sede — risolto

Circa dieci punti nella forma `if (plessi.length > 0) query.in('scuola_id', plessi)`: scope vuoto ⇒
**nessun filtro** ⇒ tutte le sedi. Più il ramo di degrado della galleria, che quando la colonna
mancava rieseguiva la query **senza** il filtro.

Risolto nell'ondata del 31/07: il degrado passa da `degradoSedeLecito`, che concede il ripiego solo
quando la colonna manca davvero, e la forma vietata è cablata nel lock
`__tests__/architecture/scope-vuoto-nega.test.ts` (allowlist vuota alla nascita).

---

## Cosa è stato verificato e SMENTITO

Gli allarmi che si sono rivelati infondati restano qui, con la loro prova. Non è cortesia verso chi
li ha sollevati: è la parte del documento che fa **risparmiare** tempo, perché senza di essa il
prossimo audit rifà le stesse verifiche e riscopre le stesse non-notizie.

### Verificato il 30/07

- **Le 15 route `admin/wipe`, `seed-*`, `debug-*`, `apply-*-migration` non sono aperte.** Passano
  tutte da `sealDangerous()` (`src/lib/security/seal.ts:14`), che in produzione risponde **404**.
  Verificato live: `POST /api/admin/wipe` → 404, `GET` → 405 (405 = la route esiste ma il metodo è
  sbagliato; 404 sul metodo giusto = il sigillo ha risposto).
- **`pre_inscriptions` non esiste nel database di produzione.** Il `POST` anonimo del flusso legacy
  non può scrivere nulla: l'«iniezione anonima di codici fiscali» è teorica. Il flusso vivo è
  `/iscrizione` → `POST /api/iscrizione` → `enrollment_submissions`, e `/onboarding` fa redirect a
  `/iscrizione`, quindi il link già inviato alle famiglie resta valido.

### Verificato il 31/07 (ricognizione globale, 140 rilievi)

- **Nessun uuid né nome di sede è cablato nel database.** Otto superfici interrogate con lo stesso
  predicato (gli uuid delle quattro sedi, quello storico dell'era mono-plesso e i nomi
  «Kidville …» — il predicato per esteso sta nell'audit del 31/07): funzioni plpgsql,
  viste, viste materializzate, policy RLS (`qual` **e** `with_check`), comandi di `cron.job` (9 job
  attivi), `column_default`, `pg_get_constraintdef` (CHECK, FK, UNIQUE) → **0 righe ovunque**. Il
  nome della sede nella causale del bonifico è **derivato dal dato** a runtime
  (`src/lib/pagamenti/causale.ts:39-45`), non scritto nel codice; l'unico letterale «Kidville
  Giugliano» in un componente è il dato d'esempio dell'anteprima
  (`src/components/features/admin/pagamenti/CausaliPanel.tsx:45`).
- **Le numerazioni progressive sono per sede, e nessun chiamante indovina il plesso.**
  `fatture_numerazione`, `ricevute_numerazione`, `protocolli_numerazione`, `merch_po_numerazione`
  hanno tutte PRIMARY KEY `(scuola_id, anno)`, e le funzioni `prossimo_numero_*` prendono
  `p_scuola uuid` come primo parametro. La route degli ordini fornitore è la più rigorosa del repo:
  400 se le righe selezionate appartengono a plessi diversi, 403 se la sede non è fra i propri,
  400 se il fornitore è di un altro plesso. **Nessuna numerazione bucata è possibile per
  costruzione.**
- **Le 34 tabelle segnalate dall'advisor come «RLS attiva e zero policy» sono corrette, non
  scoperte.** Con RLS attiva e nessuna policy, `anon` e `authenticated` non leggono e non scrivono
  niente; il service-role passa perché ha `BYPASSRLS`. Sono le tabelle più sensibili del sistema
  (`parents`, `utenti`, `student_parents`, `sections`, `enrollment_submissions`) ed è proprio lì
  che la postura è quella giusta. Prova di trasporto: `GET` anonimo su `/rest/v1/presenze` → HTTP
  200 con `[]` (la RLS che nega), contro HTTP 404 `PGRST205` su una tabella inesistente. **Il
  pericolo sta all'opposto**, nelle tabelle che una policy ce l'hanno e la scrivono larga.
- **Il lock dei `REVOKE` sulle funzioni `SECURITY DEFINER` tiene.** Delle 29 funzioni in `public`,
  **zero** sono eseguibili da `anon` e due da `authenticated` (`current_parent_student_ids()`, che
  ritorna solo i figli di chi chiama, e `is_staff_or_admin()`, che ha un rilievo suo). Le altre 27
  — `exec_sql`, `provisiona_sede`, `registra_transazione_contabile`, i `prossimo_numero_*`, i tick
  dei cron — sono riservate a `service_role`, tutte con `search_path` fissato.
- **`admin/credentials-pdf`: il canale di fuga descritto non esisteva.** Il difetto di progetto era
  reale (autorizzazione per oscurità, vedi l'inventario), ma la catena di sfruttamento no: la
  notifica col link va **solo a chi ha eseguito la rigenerazione**
  (`enqueueNotifiche(admin, { utenteIds: [auth.user.id] })`), non a tutta la segreteria, e la
  rigenerazione era già vincolata da `assertParentInScope`. Nessun percorso realistico perché il
  personale di un altro plesso ottenesse una chiave.
- **`admin/protocolli/upload-url`, `locker/notify` e `locker/requests` non nascondevano il difetto
  che l'inventario lasciava intendere** (vedi le rispettive righe): le prime due erano voci
  infondate, la terza è stata corretta il 31/07 per una ragione diversa da quella scritta il 30.
- **`admin/primaria/obiettivi` PATCH e DELETE operano per solo id — ma la tabella è vuota.** Il
  difetto è reale nel codice e va chiuso; il suo impatto oggi è zero, e va detto perché non
  scavalchi in priorità qualcosa che perde dati adesso.

---

## Fuori dal perimetro dell'isolamento (deciso il 30/07, lavorato nell'ondata del 31)

- **`admin/primaria/allegati`** creava il contenitore `registro-allegati` con `public: true` e
  salvava `getPublicUrl`: gli allegati del registro erano leggibili da chiunque avesse l'indirizzo,
  **senza scadenza e senza login**. → contenitore privato + link firmati, come il fascicolo.
- **`admin/pre-inscriptions` PATCH** scriveva la password temporanea del genitore **in chiaro** in
  `utenti.password_segreta` e la restituiva nella risposta.
- **`pagamenti/genera`** — `.then(() => {}, () => {})` sull'audit: scartava sia il successo sia
  l'errore, e PostgREST non lancia. È lo stesso costrutto che ha reso invisibile per mesi l'audit
  dei legami.
- **`POST /api/panic-alert`** non aveva alcun gate di ruolo.

## Cosa resta aperto (dichiarato, non nascosto)

1. **L'informativa sul modulo pubblico d'iscrizione** era, il 30/07, l'ultimo passo per decisione
   del titolare: il modulo raccoglieva allergie, note mediche (BES/DSA) e il documento d'identità
   del minore **senza informativa e senza registrazione del consenso** (26 invii, ~9/ora). La PR
   #61 (`2fb0a1d`, 2026-07-31) ha messo in linea i testi e il consenso; resta la **validazione
   legale** dei testi adottati.
2. **`test_table`**, residuo di collaudo rimasto in produzione. La migrazione che la rimuove è
   stata scritta nell'ondata del 31/07 (`supabase/migrations/20260731192029_drop_test_table.sql`)
   e **attende di essere applicata**: nel repo c'è, sul database non ancora.
3. **`consensi_accettazioni` è append-only per sola convenzione**: nessun trigger, nessuna revoke.
4. Adempimenti non tecnici indicati come obbligatori e oggi assenti: **registro dei trattamenti**
   (art. 30) e **DPIA** (art. 35).
5. `task_interni` era l'ultima tabella con semantica mono-sede (`scuola_id` nullable): la bacheca
   interna nasceva senza dichiarare il plesso, ed era l'unico **debito** dichiarato nell'allowlist
   del lock di copertura. Il codice è stato chiuso nell'ondata del 31/07 e la migrazione che rende
   la colonna obbligatoria è nel repo
   (`supabase/migrations/20260731192131_task_interni_scuola_obbligatoria.sql`): finché non è
   applicata, il vincolo esiste nel codice e non nello schema.
