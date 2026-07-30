# Audit dell'isolamento fra sedi — 30 luglio 2026

> Stato: **in corso.** Questo documento è l'inventario che guida le correzioni; le voci si spostano
> in `CHIUSA` man mano che vengono rilasciate. Il changelog di ogni rilascio sta nel
> `PRD REGISTRO ELETTRONICO.md`.

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

## Inventario per area

Legenda: **CHIUSA** = corretta e rilasciata · **APERTA** = da correggere · **N/A** = non applicabile.

### Presenze — 0 da correggere
`attendance/daily`, `attendance/delegates`, `attendance/monthly`, `admin/presenze/realtime`,
`primaria/appello`, `primaria/ore-assenza`, `primaria/presenze/giust-vista`,
`primaria/giustifiche-didattiche`: **CHIUSE** (le correzioni del 29/07 tengono, riverificate una per
una). `parent/presenze/*`: **N/A** (scope famiglia). `panic-alert`: vedi *fuori perimetro*.

### Diario, note, valutazioni — 4
| Route | Stato | Cosa perdeva |
|---|---|---|
| `diary/students` ramo `?id=` | **CHIUSA** (PR #59) | Nessun gate: `note_mediche` di un minore ed email dei genitori a chiunque, senza credenziali. Verificato in produzione: HTTP 200 |
| `notes` GET/POST | APERTA | `?alunnoId=` libero; senza parametro **tutte** le note disciplinari di tutte le sedi. Il POST inserisce note su `alunnoIds` arbitrari e notifica i genitori |
| `grades` GET/POST | APERTA | Idem su `valutazioni` |
| `educator-sections` GET | APERTA | Il ramo manager elenca le sezioni di tutte le sedi |

### Anagrafica e credenziali — 11
| Route | Stato | Cosa perde |
|---|---|---|
| `admin/students/[id]` | APERTA | `select *` + codice fiscale + `parents(*)` (CF, documento, indirizzo, telefoni) + `delegates(*)` (numero di documento) + fratelli, per qualunque alunno di qualunque sede |
| `admin/parents`, `admin/parents/[id]` | APERTA | Anagrafica dei genitori delle tre sedi |
| `admin/regenerate-credentials` | APERTA | Reset password e invio credenziali a un genitore di un'altra sede |
| `admin/credentials-pdf` | APERTA | PDF credenziali di qualunque sede |
| `admin/import/anagrafiche` | APERTA | Dedup del codice fiscale **globale**: lo stesso difetto già corretto in `admin/iscrizioni` il 29/07, qui no |
| `admin/sidi/legami` | APERTA | Crea legami genitore↔figlio cross-sede |
| `admin/sections/[id]/teachers` POST/DELETE | APERTA | Assegna docenti a sezioni di altre sedi (il GET filtra già) |
| `locker/materials`, `locker/notify`, `locker/requests` PATCH | APERTA | Configurazione e richieste dell'armadietto della classe omonima altrui |

### Chat e comunicazioni — 6
| Route | Stato | Cosa perde |
|---|---|---|
| `admin/chat/contacts` | APERTA | Nome e classe di **tutti** i minori e i genitori delle tre sedi, con la chat già apribile. ⚠️ La correzione del 29/07 riguardava il **gemello** `chat/contacts` (lato docente): questa non è mai stata toccata |
| `admin/chat/threads` | APERTA | Tutte le conversazioni genitore↔docente delle tre sedi, coi nomi dei minori |
| `admin/chat/messages` | APERTA | Contenuto dei messaggi di qualunque thread |
| `chat/threads` POST | APERTA | Verifica solo di essere partecipante, non che il minore sia della propria sede |
| `avvisi/[id]/risposte` | APERTA | Risposte e nomi di genitori/alunni di un avviso di un'altra sede |
| `admin/segnalazioni` | APERTA | Coda di moderazione di tutte le sedi |

### Galleria — 2
`gallery` PATCH e DELETE autorizzano per **intersezione di nomi-classe**: il docente del «2 ANNI» di
Aversa può modificare o eliminare le foto dei bambini del «2 ANNI» di Cesa. `gallery/upload` non
valida `target_classes`/`tag_students` per sede. Il GET è già chiuso.

### Modulistica — 7
`admin/forms/submissions` (+`[id]`), `admin/forms/rankings`, `forms/export/pdf`,
`forms/export/xlsx`, `forms/delibera` (+export): dati di famiglia e graduatorie di tutte le sedi.
`parent/forms`: i template sono filtrati per **nome classe**, quindi al genitore di Aversa
compaiono i moduli del «2 ANNI» di Cesa.

### Mensa — 1
`mensa/prenotazioni` ramo staff (`STAFF_FORZA`): prenota, disdice e legge per qualunque alunno di
qualunque sede. Il resto del modulo è già chiuso.

### Contabilità — 12
`pagamenti/tutori`, `pagamenti/pagante-comune`, `pagamenti/credito`, `pagamenti/quote`,
`pagamenti/incassi` (+`[id]`, +`storno`), `pagamenti/[id]/sconto`, `pagamenti/fattura` (+`list`),
`pagamenti/ricevuta`, `teacher/uscite`: si incassa, si storna, si scontano e si fatturano pagamenti
di un'altra sede. Le altre 24 route del modulo sono già chiuse.

### Registro primaria e competenze — 10
| Route | Stato | Cosa perde |
|---|---|---|
| `teacher/medical-certificates` GET | **CHIUSA** (PR #59) | Certificati medici di tutte le sedi: il gate c'era, il filtro no |
| `admin/competenze` (GET/POST/PATCH), `admin/competenze/download`, `admin/competenze/genera` | APERTA | Certificati delle competenze di sezioni di altre sedi, leggibili e modificabili |
| `admin/primaria/docenti-materie`, `admin/primaria/materie`, `admin/primaria/orario`, `admin/primaria/materia-obiettivo` | APERTA | Scritture su sezioni di altre sedi |
| `admin/primaria/fascicolo-audit` | APERTA | Rivela **quali** minori hanno un fascicolo PEI/PDP/104, in tutte le sedi |

Il fascicolo vero e proprio (`primaria/fascicolo`, `/file`, `/pagelle`) è **già chiuso** e va usato
come modello: `src/lib/primaria/fascicolo-rbac.ts:47-56` nega con motivo `cross-tenant` e traccia
ogni accesso su `fascicolo_accessi_audit`.

### GDPR — 3
`admin/gdpr/candidates` (nomi di minori non iscritti e genitori collegati, tutte le sedi),
`admin/gdpr/erase` (**anonimizza in modo irreversibile** un alunno e i suoi genitori di un'altra
sede), `admin/gdpr/richieste` (legge `scuola_id` e non lo confronta).

### Certificati medici — 2, entrambe CHIUSE (PR #59)
`parent/medical-certificates/file` (il ruolo bastava a scaricare il PDF di un minore di un'altra
sede) e `teacher/medical-certificates` GET.

### News · Notifiche · Iscrizioni — 0
Tutte già chiuse o non applicabili (30 route verificate).

### Altro — 2
`admin/audit` (legge la sede e non ci filtra), `admin/protocolli/upload-url`.

---

## I difetti che non sono «una route da filtrare»

### 1. Il vincolo di unicità del registro non contiene la sede — APERTO
```sql
unique_registro_orario UNIQUE (classe_sezione, data, ora_lezione)   -- manca scuola_id
```
Verificato sul database di produzione. Gli upsert `onConflict: 'classe_sezione,data,ora_lezione'`
(`register/lessons/route.ts:139`, `primaria/registro/route.ts:245`) **condividono la stessa riga fra
sedi omonime**: argomento, compiti e firme del «2 ANNI» di Aversa sovrascrivono quelli di Cesa.

È l'unico difetto che **corrompe** dati invece di esporli, ed è invisibile in lettura perché il gate
di scope sulle due route c'è. Al 30/07: **14 righe, 0 collisioni** — la migrazione è ancora
indolore. Correzione: `UNIQUE (scuola_id, classe_sezione, data, ora_lezione)` e allineamento dei due
`onConflict`.

### 2. L'identità da header aggira il proprio interruttore — APERTO
`ALLOW_HEADER_IDENTITY` è a `false` in produzione (verificato: `/api/me` con `x-user-id` → 401), ma
**il flag vive solo dentro `resolveIdentity`** (`require-staff.ts:93`). Quattro route chiamano
`getRequestUserId` **in diretta**, quindi `x-user-id: <uuid qualsiasi>` è accettato comunque:

- `parent/primaria/note/firma:37` — produce una **firma elettronica** con valore legale
  (`fea_audit_log`, il codice cita il CAD art. 20) attribuita a un genitore qualunque;
- `parent/primaria/note/firma/otp:21`, `parent/primaria/pagella/firma/otp:19`,
  `parent/presenze/giustifica/otp:20` — l'invio dell'OTP è attivabile da chiunque conosca l'uuid del
  genitore, senza sessione e senza limite di frequenza.

Il presidio residuo è il solo OTP via email. Correzione: passare tutte da `resolveIdentity`.
Verificato che la migrazione è sicura: 36 genitori su 47 hanno il ponte `parents.auth_user_id`, e i
restanti 11 non possono comunque usare il resto dell'applicazione.

### 3. Fail-open sul filtro di sede — APERTO
Circa 10 punti nella forma `if (plessi.length > 0) query.in('scuola_id', plessi)`: scope vuoto ⇒
**nessun filtro** ⇒ tutte le sedi. Più `gallery/route.ts:191`, che quando la colonna manca
**riesegue la query senza il filtro** (`buildMedia(false)`). Va convertito in *deny*.

---

## Cosa è stato verificato e SMENTITO

Due allarmi emersi durante l'audit si sono rivelati infondati. Restano qui perché la prossima
persona che li ritrova non ci perda tempo.

- **Le 15 route `admin/wipe`, `seed-*`, `debug-*`, `apply-*-migration` NON sono aperte.** Passano
  tutte da `sealDangerous()` (`src/lib/security/seal.ts:14`), che in produzione risponde **404**.
  Verificato live: `POST /api/admin/wipe` → 404, `GET` → 405 (405 = la route esiste ma il metodo è
  sbagliato; 404 sul metodo giusto = il sigillo ha risposto).
- **`pre_inscriptions` non esiste nel database di produzione.** Il `POST` anonimo del flusso legacy
  non può scrivere nulla: l'«iniezione anonima di codici fiscali» è teorica. Il flusso vivo è
  `/iscrizione` → `POST /api/iscrizione` → `enrollment_submissions`, e `/onboarding` fa redirect a
  `/iscrizione`, quindi il link già inviato alle famiglie resta valido.

---

## Fuori dal perimetro dell'isolamento (da correggere in questo lavoro, deciso il 30/07)

- **`admin/primaria/allegati:103`** crea il contenitore `registro-allegati` con `public: true` e
  salva `getPublicUrl`: gli allegati del registro sono leggibili da chiunque abbia l'indirizzo,
  **senza scadenza e senza login**. → contenitore privato + link firmati, come il fascicolo.
- **`admin/pre-inscriptions` PATCH** scrive la password temporanea del genitore **in chiaro** in
  `utenti.password_segreta` e la restituisce nella risposta.
- **`pagamenti/genera:238`** — `.then(() => {}, () => {})` sull'audit: scarta sia il successo sia
  l'errore, e PostgREST non lancia. È lo stesso costrutto che ha reso invisibile per mesi l'audit
  dei legami (corretto il 29/07).
- **`POST /api/panic-alert`** non ha alcun gate di ruolo.

## Fuori perimetro, non ancora deciso

- `consensi_accettazioni` è append-only **per sola convenzione**: nessun trigger, nessuna revoke.
- `test_table` è un residuo di collaudo rimasto in produzione.
- Adempimenti non tecnici indicati come obbligatori e oggi assenti: registro dei trattamenti
  (art. 30) e DPIA (art. 35).
