# PIANO DI CORREZIONE — collaudo ciclo 2 (2026-07-31)

> **Per chi implementa:** questo piano si esegue con `superpowers:subagent-driven-development`.
> Ogni step è autonomo, ha i propri file **esclusivi**, il proprio criterio di accettazione
> verificabile e la propria **prova di validità** (rimettere il difetto e vedere il rosso).
> **TDD obbligatorio**: prima il test rosso, poi il codice, poi il verde, poi la prova di validità.

**Obiettivo:** chiudere **tutti i 45 rilievi** dei 11 tester-opus, raggruppati per **causa radice**,
senza aprire regressioni e senza che due esecutori si distruggano a vicenda scrivendo lo stesso file.

**Decisione del titolare (2026-07-31):** si chiude tutto, comprese le falle preesistenti su dati
di minori. Nessun rilievo viene rimandato. Dove il rilievo è troppo grande per un ciclo
(«91 catch muti») il piano fissa un **sotto-obiettivo verificabile** e un lock che impedisce al
debito di ricrescere.

---

## 1. Quadro

**Verdetto:** 11 categorie su 11 → `FAIL`.
**Rilievi:** 45 fallimenti (2 bloccanti · 33 gravi · 10 minori) + i warning promossi.

| Categoria | Verdetto | Fallimenti | Bloccanti |
|---|---|---|---|
| debug | FAIL | 2 | 0 |
| log | FAIL | 3 | 0 |
| localizzazione | FAIL | 5 | 0 |
| design | FAIL | 4 | 0 |
| accessibilita | FAIL | 10 | 1 |
| privacy | FAIL | 5 | 0 |
| backend | FAIL | 3 | 0 |
| sicurezza | FAIL | 2 | 1 |
| frontend | FAIL | 2 | 0 |
| mobile-android | FAIL | 5 | 0 |
| mobile-ios | FAIL | 4 | 0 |

**Categorie BLOCCATE (prerequisito d'ambiente), da sbloccare durante il ciclo:**
- **design · accessibilita · localizzazione** — nessuno dei tre ha potuto autenticare
  `test.multisede.admin@kidville.test` (nessun tester inserisce password). Il selettore di sede
  a tre plessi è stato misurato in *harness*, non in pagina. → **S39** prevede la sessione
  multi-sede aperta dall'orchestratore prima del collaudo finale.
- **frontend · log** — «gli allegati degli avvisi si aprono ancora» non è verificabile: 9 avvisi
  in produzione, **0 con `attachment_url`**. → **S39** prevede un avviso con allegato su una
  sezione `TEST *` **senza genitori agganciati** (attenzione: `POST /api/avvisi` notifica le
  famiglie reali della sede).
- **mobile-android** — due AVD (`KV2`, `Medium_Phone_API_36.1`) sono bloccati da una credenziale
  di schermo: il sintomo («Activity class does not exist» + schermo nero) sembra un APK rotto e
  non lo è. Si collauda su `KV-play-phone`.

**Già in lavorazione — NESSUNO STEP DI QUESTO PIANO LO TOCCA:**
`src/lib/auth/require-parent.ts:35` (sicurezza F1, **bloccante**: qualunque non-genitore legge i
dati di qualunque minore di qualunque sede) e le tre voci mendaci di allowlist in
`__tests__/architecture/isolamento-sede-coverage.test.ts:905,909,910`.
**Vincolo di sequenza:** gli step che toccano `src/lib/auth/scope.ts` (**S20**) e
`__tests__/architecture/isolamento-sede-coverage.test.ts` (**S10**) partono **solo dopo** che
quel lavoro è stato committato. Sono gli unici due punti di collisione.

---

## 2. Fallimenti raggruppati per CAUSA RADICE

### C1 — «La modale è un `div` con del blur, non un dialogo»
**Risolve:** android F1, android F2, android F3, iOS F1, design F2, frontend F2, a11y F3 (metà),
a11y F9, + i warning «`inert` dichiarato e mai presente» (design, frontend, debug).

**Sintomi che ne discendono** — sette report diversi, un solo file:
1. TalkBack non legge la modale su Android: il `backdrop-filter: blur(8px)` sta sul div **antenato**
   del `[role=dialog]`, e su WebView Chromium un antenato filtrato **cancella il sottoalbero
   dall'albero di accessibilità**. Prova sperimentale del tester via CDP:
   `parentElement.style.backdropFilter='none'` → `TITOLO`, `CONTENUTO`, `PUBBLICA AVVISO` ricompaiono.
   Controprova nel repo: `AdminMenuSheet.tsx:157-167` mette il blur su un div **fratello**
   `aria-hidden` ed è regolarmente esposto.
2. La pagina retrostante resta nell'albero e attivabile: `aria-modal="true"` vale **solo** per il
   top layer (`<dialog>`/`showModal()`), non per un `div`. Misurato:
   `{"inertSuMain":false,"ariaHiddenSuMain":null,"dialogAriaModal":"true"}`.
3. Il tasto Indietro fisico porta via la pagina e la bozza: `useOverlayIndietro`
   (`src/lib/mobile/overlay-indietro.ts:113`) **non è invocato da nessuno**. `grep` su tutto `src/`
   → solo la propria definizione e la propria docstring. Il registro è sempre vuoto,
   `chiudiOverlayInCima()` ritorna sempre `false`.
4. La X finisce **sotto la topbar verde**: `Modal.tsx:120` è `z-[80]`, `kv-admin-topbar` è
   `z-[105]`. Su iOS il tap colpisce **la campanella delle notifiche** (misurato: «Chiudi»
   `[364,78]-[408,123]` contro «Notifiche» `[380,70]-[424,114]`). Su Android/desktop la sidebar
   resta nitida e cliccabile.
5. Il focus-trap non gestisce `document.activeElement === <body>`: dopo il submit il `Tab` esce.

**Perché è la radice e non il sintomo:** sono cinque report che descrivono cinque effetti di
**un'unica decisione di progetto** — «la modale è un contenitore fatto in casa che si affida
all'`aria-modal`». Ogni sintomo è già stato corretto una volta *sul singolo consumatore*
(`f346c14` ha alzato la z per liberarsi della bottom-nav, e infatti sotto funziona e sopra no).
Correggere la **primitiva** chiude in un colpo i **15 componenti** che la usano (firma OTP,
incassi, cassa, chat…), non solo `AvvisoForm`.

**Come si verifica che è chiusa:** `adb shell uiautomator dump` con la modale aperta contiene
`PUBBLICA AVVISO` **e non contiene** `AVVISI PUBBLICATI`; `input keyevent 4` chiude la modale e
lascia il titolo scritto; `elementFromPoint` sul centro della X restituisce il `button`, non
`HEADER.kv-admin-topbar`.

**Regressioni possibili:** alzare la z sopra il chrome può far passare la modale sopra un toast o
sopra il pannello Notifiche → il lock **S02** confronta la modale con **tutte** le barre fisse, non
solo le bottom-nav. `inert` sui fratelli può congelare il portale di Next in sviluppo → il test di
integrazione monta un `Modal` vero e verifica che alla chiusura i fratelli tornino attivi.

---

### C2 — «Il lock guarda il difetto di ieri, non la regola»
**Risolve:** debug F1, debug F2, android F4 (metà), + i due warning sui test deboli
(`news-digest.test.ts:88-93`, `tasks-sede-dichiarata.test.ts:180`), + «nessun lock protegge la
parità dei cataloghi».

**Sintomi:**
- La correzione di sicurezza **più importante della giornata** — `avvisi_allegati` e
  `task_allegati` resi privati — **non è protetta da niente**. Una migrazione di due righe
  (`update storage.buckets set public = true where id='avvisi_allegati'`) passa **375 test su 33
  file**. Il lock `__tests__/architecture/bucket-storage-dichiarati.test.ts:151-202` guarda
  `file_size_limit`, l'esistenza dell'INSERT e i MIME: **mai** la colonna `public` — che il suo
  stesso parser (`valoriInsert()`) già estrae.
- `security-definer-revoke-lock.test.ts:66-69`: la congiunzione `&& /CREATE FUNCTION/`, aggiunta
  da `fcb3a22` per chiudere un falso positivo, apre un **falso negativo**: Postgres promuove a
  `SECURITY DEFINER` anche con `ALTER FUNCTION`, che non contiene nessuna `CREATE`.
- `news-digest.test.ts:88-93`: il mock non «dice sempre di sì» come prima, ma **riscrive la regola
  del resolver dentro il test**. Misurato: col difetto rimesso in `scope.ts` quel file **resta
  verde** mentre altri 5 diventano rossi.
- `tasks-sede-dichiarata.test.ts:180`: `expect([400, 403]).toContain(res.status)` — ora che il
  comportamento è deciso va inchiodato a **403**.

**Perché è la radice:** in tutti e quattro i casi la difesa è stata scritta **guardando il difetto
che si aveva davanti**, non la regola che il commit stesso dichiarava. La regola giusta è
«**privato salvo eccezione dichiarata**», non «si controlla ciò che si è appena guardato».

**Regressioni possibili:** un lock troppo severo sui bucket blocca migrazioni legittime → la
regola prevede un'**allowlist con la ragione scritta** (`news`, pubblico per decisione del titolare).

---

### C3 — «Il gate controlla il RUOLO, non l'oggetto richiesto»
**Risolve:** privacy F1, backend F2, sicurezza F2, log F2, + i warning backend sui `{ data }` non
controllati in `tasks/[id]`.

**Sintomi:**
- **Il documento d'identità di un minore è scaricabile dalla segreteria di un'altra sede.**
  `GET /api/admin/iscrizioni?doc=<percorso>` firma **qualunque** oggetto di `form_attachments`
  (870 file). Misurato, non dedotto: sessione `test.aversa.segreteria`, percorso preso da una
  domanda di **Giugliano** → `200` con l'URL firmato; l'URL scaricato **senza autenticazione** →
  `200 image/png 3.882.922 byte`, la scansione integra.
- `GET /api/tasks` prende **ruolo e identità dal query param `userId`**: un educator che passa lo
  userId di un admin vede i promemoria altrui; il ramo `?studentId=` restituisce nome, cognome,
  classe e **allergie** del bambino senza verifica di sezione.
- `PATCH /api/admin/schools` non ha nessun controllo di appartenenza: un `coordinator` —
  mono-plesso per modello (`scope.ts:58`) — riscrive nome, `attiva` e i **dati fiscali** di
  qualunque sede.
- `assertAvvisoInScope` (`avvisi/[id]/route.ts:29-40`) non destruttura `error`: guasto di lettura,
  id inesistente e vero tentativo cross-sede danno **la stessa 403** e **nessuno dei tre lascia
  una riga**.

**Perché è la radice:** `requireStaff`/`requireDocente` verificano *chi sei*. In queste quattro
rotte manca la domanda successiva — *quell'oggetto è tuo?* — e il client è `createAdminClient()`
(service-role), che **bypassa la RLS**: la difesa applicativa era l'unica. Il modello corretto
esiste già nel repo (`pagamenti/cassa/allegato/route.ts:33-37`, `scope.ts` con le sette `assert*`
e `scopeNonRisolto()`): va **applicato**, non inventato.

**Come si verifica:** ogni fix porta un test che asserisce sul **corpo** (elenco vuoto, `403`,
nessuna mutazione) e **non solo sullo status**, con accanto un controllo positivo che dimostri che
l'attore legittimo passa.

---

### C4 — «Il server manda prosa italiana all'utente»
**Risolve:** localizzazione F1, localizzazione F2, + metà di backend F3 e di frontend F1
(messaggi d'errore che dicono il falso), + il warning «452 messaggi d'errore italiani nelle route».

**Sintomi:** `'Sede non accessibile'` (`scope.ts:192`, nata **oggi**) e
`'Specificare la sede (scuola_id) per questa operazione'` (`scope.ts:211`) arrivano a schermo in
italiano anche con `<html lang="en">`, e la seconda mostra a una segretaria **il nome della colonna
del database**. `grep -rniE "non accessibile|not accessible" messages/` → **0 risultati**.

**Perché è la radice:** le route rispondono `{ error: '<italiano>' }` e il client rende quel testo
con `messaggioErrore()` (`src/lib/ui/esito-fetch.ts:27`). È **giusto per l'osservabilità** e
**scavalca del tutto next-intl**: il messaggio nasce dove locale e catalogo non esistono. Il fix
non è tradurre due stringhe: è dare al canale un **codice stabile**.

---

### C5 — «Lo stato e il nome vivono nelle classi Tailwind»
**Risolve:** a11y F1 (**bloccante**), a11y F2, F3 (metà), F4, F8, design F3, + i warning
`aria-busy`, `aria-required`, icone di riga nominate solo con `title`.

**Sintomi:** il **selettore di sede** non dice mai quale sede è attiva a chi non vede (stato =
colore + spunta; `aria-pressed`/`aria-checked`/`aria-current` tutti `null`; `aria-haspopup="true"`
su un popup **senza `role`**; `Esc` non chiude). Nella modale «Nuovo avviso» **cinque campi non
hanno etichetta associata** (il campo data non ha **nessun** nome accessibile: axe `label`,
impact **critical**); i quattro toggle e le pillole classe non hanno `aria-pressed`; il bottone
«togli allegato» è **12×12 px e muto**.

**Perché è la radice:** il pattern corretto **è già nel repo e funziona** — `/auth/login`
(«Mostra password» con nome statico + `aria-pressed`), i tab del cockpit (`aria-pressed="true"`),
e nello stesso `AvvisoForm.tsx:347` il `<select>` della sede è l'unico campo fatto bene
(`htmlFor="avviso-sede"` + `id`), aggiunto nella tornata multi-sede. Non va inventato niente: va
copiato sugli altri sette campi.

**Rischio concreto dichiarato dal tester:** pubblicare a **una classe sbagliata** senza accorgersene.

---

### C6 — «Il token decorativo usato per l'informazione portante»
**Risolve:** design F1, a11y F5, a11y F6, a11y F7, a11y F10, + i warning sulle 7 fasce d'errore
col token debole e sulle coppie fuori modale.

**Sintomi:** il **nome della sede** — l'informazione che disambigua i tre plessi — è scritto in
`text-kidville-muted` (#9AA6A2): **2,51:1** su bianco, **2,27:1** su crema. In Alto Contrasto i
valori **non cambiano**. Dentro la modale **12 coppie** sotto AA. Sulle tabelle admin l'Alto
Contrasto produce una **banda nera larga 40px** che copre la prima lettera di ogni riga
(`globals.css:449-459` usa `var(--color-kidville-white)`, rimappato a `#000000`, come coperchio su
una superficie che **non** si ribalta perché `@theme inline` ha già inlinato `#FFFFFF`).

**Perché è la radice:** i token giusti **esistono già e sono inutilizzati**:
`--color-kidville-sub` #55615C (6,46:1) e `--color-kidville-error-strong` #C62828 (4,92:1,
il cui commento dice testualmente «testo d'errore su error-soft»). Sistemare i token alla radice
chiude a11y F5, F7 e F10 **senza aggiungere una sola regola** `[data-contrast="high"]`.

---

### C7 — «L'osservabilità si ferma prima della tabella»
**Risolve:** log F1, log F3, + i warning W1, W3, W4, W5, W7 del report log e
`hashCorrelabile('')` del report privacy.

**Sintomi:**
- `avvisi:POST` emette il log di successo con `n_destinatari`, ma l'evento `avvisi` **non è in
  `EVENTI_PERSISTITI`**: la riga muore su Vercel. `select count(*) from app_log where
  evento='avvisi' and livello='info'` → **0 da sempre**, con 10 avvisi in 30 giorni e uno
  pubblicato **oggi alle 19:39 su questo branch**. Peggio: il commento a `logger.ts:113-116`
  giustifica l'esclusione affermando che quel log non esiste — ed è **falso dal commit stesso che
  l'ha scritto** (`534abd2` introduce log e commento insieme).
- **91 catch muti** in `src/` (86 `.catch(() => {})` + 5 `catch {}`), di cui ~87 reali. Fra questi
  `regenerate-credentials/route.ts:197` — sul bucket **credenziali**, cioè il percorso del difetto
  storico da cui nasce questa categoria.
- Il campo `sede=` sulla riga del 403 dice **la sede sbagliata** (la primaria dell'utente, non
  quella rifiutata). `stato_http` è NULL: chi legge non distingue il 403 (sicurezza) dal 400 (uso).
- `hashCorrelabile('')` è **una costante**: nome, cognome, CF ed email vuoti escono tutti come lo
  stesso `#xxxxxxxx`, e correlano persone diverse.

**Perché è la radice:** «nessun log» non distingue «tutto ok» da «non è mai partito niente». È
**letteralmente l'ambiguità che ha nascosto il guasto delle email** per mesi, ed è tornata su un
percorso nuovo (gli upload di allegati appena passati a bucket privato).

**Sotto-obiettivo per i 91 catch muti** (invece di rimandare): regola ESLint che **fallisce il
gate**, con una **allowlist committata dei file legacy** che può solo rimpicciolirsi, + bonifica
immediata dei percorsi che toccano credenziali, oblio e allegati. Il numero nell'allowlist è il
criterio di accettazione.

---

### C8 — «`resolveScuolaScrittura`: il ramo del cookie non ha avuto lo stesso trattamento del ramo dichiarato»
**Risolve:** sicurezza W1, sicurezza W2 (entrambi promossi a fix), + il warning log W3.

**Sintomi:** il cookie `sedi_attive` **manomesso** non produce 403 e non lascia log sul percorso di
**scrittura**: `POST /api/tasks` con `sedi_attive=<Cesa>` da un utente di Aversa → **201 su
Aversa**, nessun `sedi-attive-non-accessibili` (che invece compare in **lettura**). E il confronto
degli uuid è **case-sensitive** (`Set.has`) contro un tipo Postgres che non lo è: dichiarare la
**propria** sede in maiuscolo dà **403** e **inquina il contatore di sicurezza** con falsi positivi.

**Perché è la radice:** è **lo stesso schema** che `3fea7b2` ha appena rimosso per la sede
*dichiarata* — «il client chiede un plesso, il server ne sceglie un altro e non lo dice a nessuno» —
sopravvissuto sul ramo accanto, nella stessa funzione.

---

### C9 — «Il consenso e l'oblio ragionano per riga, non per dato»
**Risolve:** privacy F2, F3, F4, F5, + i warning su `news` senza cancellazione, allegati orfani,
foto del minore mai rimosse, `enrollment_submissions.credentials`, `audit_scritture_docente`.

**Sintomi:**
- **234 domande d'iscrizione** (152 CF di minori, 231 ancora `pending`, la più vecchia del 16
  luglio) senza **nessuna** regola di cancellazione e **fuori dall'oblio**:
  `grep -rn 'enrollment_submissions' src/lib/gdpr/` → **0 occorrenze**. La domanda conserva in
  chiaro CF, data di nascita, residenza, **allergie e note mediche** del minore. L'informativa
  pubblicata (`privacy/page.tsx:359-364`) promette «non oltre la durata dell'iscrizione» — e per
  231 domande l'iscrizione **non è mai iniziata**.
- L'oblio rimuove **solo** il file dell'alunno: il `documento_path` dei genitori viene azzerato
  *nella riga* ma il file **resta nel bucket**, e la rimozione sta dentro un `catch` muto.
- `consenso_foto_sito` e `consenso_foto_social`, raccolti da **141 famiglie**, **non hanno campo di
  destinazione e nessun codice li legge**, mentre il bucket `news` *è* il canale «sito web della
  Scuola» ed è pubblico. Il testo del consenso, scritto nel repo, dice che è **granulare per
  canale** (provv. Garante 725/2025).
- `is_broadcast: true` spegne il privacy-lock della galleria **prima ancora di interrogare il
  database**, anche con bambini taggati senza liberatoria. Il vincolo «broadcast ⇒ nessun tag» è
  imposto **solo dal client**: una regola di consenso applicata dal client non è un lock.

**Perché è la radice:** l'oblio è stato costruito partendo dalle **tabelle operative**; la tabella
di **origine** del dato — quella che ha raccolto tutto, categoria particolare art. 9 compresa —
non è mai entrata nell'elenco. E la pipeline dei consensi è stata chiusa fino al **primo** canale
con un campo a destinazione, e si è fermata lì.

---

### C10 — «Il fuso e la regione non sono dichiarati da nessuna parte»
**Risolve:** localizzazione F3, F4, F5, + i warning su glossario EN, stringhe cablate, tipografia.

**Sintomi:** **nessuna** formattazione dichiara `timeZone`. Stesso istante, stesso codice:
`TZ=UTC` → «giovedì 30 luglio», `TZ=Europe/Rome` → «venerdì 31 luglio». Su Vercel il runtime è
**UTC**. `teacher/diary/page.tsx:108` formatta `new Date()` **nel corpo del render**: data sbagliata
a schermo **più** disallineamento di idratazione. In inglese convivono due formati di data
**opposti**: en-US quasi ovunque, en-GB in `MensaCalendar.tsx:74`.

---

### C11 — «Le sedi nuove nascono senza corredo»
**Risolve:** backend F3.

**Sintomo:** `admin_settings.avvisi_config` è **NULL** per Aversa e Cesa → default `['admin']`, e
`segreteria` cade nel gruppo `teacher`. La segreteria riceve
`403 «La pubblicazione di avvisi è riservata alla segreteria»` — **il messaggio nomina come
autorizzato proprio il ruolo che sta negando**.

**Perché è la radice:** il provisioning delle sedi create dopo Giugliano non popola la
configurazione. È **il tema stesso del ciclo**: quando le sedi erano una, il corredo era implicito.

---

### C12 — «I flow Maestro codificano un'assunzione falsa sull'albero di accessibilità»
**Risolve:** android F4, android F5, iOS F2.

**Sintomi:** `text: "MENU"` **non esiste** nell'albero: la WebView espone l'`aria-label`
(`'Menu · tutte le sezioni'`), non il testo del `<span>` — cioè **l'esatto contrario** di quanto
affermano il commento nel flow e il README. Il flow docente tocca «Apri la bacheca» su un nodo
**alto 0 px** fuori viewport (Maestro dichiara `COMPLETED` e il tap cade su un'area morta). Su iOS
falliscono **tutti e tre**: `tapOn: "Accedi"` non fa partire il submit con la tastiera aperta, il
ramo permessi è collocato **prima** che il dialog nativo compaia, e il flow docente si àncora a
testi che dipendono **dall'ora del giorno** («Buongiorno!») e **dallo stato dei dati**
(«Modifica appello» contro «Fai l'appello ora»).

**Nota che pesa:** `android-screenshot-playstore.yaml:37-42` **documentava già** che «MENU» non è
selezionabile. La conoscenza c'era e non è stata propagata: per questo serve il lock.

---

### C13 — «Il nome della classe non è più una chiave univoca»
**Risolve:** iOS F4.

**Sintomo:** nella bacheca **del docente** due card su cinque mostrano
`219cab6a-2bf3-48d6-a443-b7aecda40f42` al posto del nome della sezione. Gli **stessi** avvisi, nel
cockpit, mostrano «TEST Infanzia»: l'admin risolve id → nome, il docente no.

**Perché è la radice:** è la coda dell'audit multi-sede — da quando le sedi sono tre il nome non è
più chiave univoca e **alcune scritture salvano l'id**. Va sistemata la lettura *e* verificato
quale percorso di scrittura archivia l'id.

---

### C14 — «Difese di piattaforma mai messe» (warning promossi a fix)
**Risolve:** sicurezza W4, W5, W6, W7, W11 · debug W3 (chat TTL 365 giorni) · backend (gate MIME
su `avvisi/upload`).

**Sintomi:** **nessun** header di sicurezza (CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
Referrer-Policy, Permissions-Policy) — e pesa più del solito, perché `src/middleware.ts` scrive
esso stesso che «in questo repo il path **È** una credenziale» e che gli id dei minori sono
segmenti di rotta: senza `Referrer-Policy` finiscono nell'header `Referer` verso terzi. Nessun
rate limit sulle 4 rotte OTP del genitore né sul login (6 password errate → 6× 400, **nessun 429**).
14 policy `using(true)` per `authenticated`, fra cui `orario_settimanale` e
`sezione_materia_obiettivo` che sono **per sezione**. `task_allegati` è l'unico bucket con
`allowed_mime_types = null`. La chat firma con **TTL di un anno** e salva l'URL in tabella: è
l'ultimo bucket con il modello da cui avvisi e task sono appena usciti.

---

### C15 — «Il 403 di un widget diventa l'errore della pagina»
**Risolve:** frontend F1, + il warning «etichetta bugiarda NUOVO GENITORE».

**Sintomo:** con l'account di segreteria il dettaglio di una sezione mostra
«Accesso negato: operazione riservata allo staff» — **pur essendo l'utente staff** — e due pannelli
spariscono senza spiegazione. Il 403 di un widget **secondario** viene promosso a errore di
**pagina**, e il messaggio è falso per chi lo legge.

---

### C16 — «zod valida il tipo, non il limite»
**Risolve:** backend F1.

**Sintomo:** `HTTP 500 {"error":"value too long for type character varying(255)"}` — il messaggio
grezzo di Postgres, col tipo esatto della colonna, restituito al client dove serviva un 400.

---

### C17 — «Capacitor scambia l'annullamento per assenza di rete»
**Risolve:** iOS F3.

**Sintomo:** dopo un login **riuscito** compare «KIDVILLE NON È RAGGIUNGIBILE» (1 volta su 6).
`NSURLErrorDomain -999` è `NSURLErrorCancelled`: la navigazione **non è fallita, è stata annullata**
da una seconda partita 28 ms dopo — le due navigazioni nascono da `router.replace()` seguito
subito da `router.refresh()` (`auth/login/page.tsx`, **4 occorrenze**).

---

### C18 — Metodo (rilievo del tester debug, accolto)
**Il repo non era congelato durante il collaudo:** due commit di un altro agente sono entrati
mentre i tester lavoravano (`1a00c12` → `a2e26e0`). Gli 11 verdetti **non si riferiscono tutti allo
stesso albero**. È un errore di orchestrazione, e diventa uno **step esplicito** del piano (**S39**).

---

## 3. Ordine di attacco (ondate e parallelizzazione)

**Regola d'oro:** due esecutori non aprono mai lo stesso file. Le colonne «File esclusivi» sotto
sono **disgiunte dentro la stessa ondata**.

```
ONDATA 0  (in corso, non pianificata qui)
  require-parent.ts + isolamento-sede-coverage.test.ts:905,909,910
        │
        ├──────────────► ONDATA 1 — le cinque incompiutezze + i dati di minori
        │                S01 S03 S04 S08 S09 S24  (6 esecutori in parallelo)
        │                     │
        │                     ▼
        │                ONDATA 2 — lock, gate, mobile
        │                S02 S05 S06 S07 S10* S11 S13 S14 S15  (*S10 attende ondata 0)
        │                     │
        │                     ▼
        │                ONDATA 3 — osservabilità, i18n, privacy strutturale
        │                S16 S17 S18 S19 S20* S21 S22 S23 S25 S26 S27  (*S20 attende ondata 0)
        │                     │
        │                     ▼
        │                ONDATA 4 — piattaforma, mobile, coda
        │                S12 S28 S29 S30 S31 S32 S33 S34 S35 S36 S37 S38
        │                     │
        └─────────────────────▼
                         S39 (collaudo a repo fermo) → S40 (PRD)
```

---

## 4. Gli step

> Convenzione di ogni step: **Causa** · **File esclusivi** · **Migrazione** · **Log** · **Test (TDD)**
> · **Criterio di accettazione (comando → output atteso)** · **Prova di validità** · **Non toccare**
> · **Parallelo con**.
>
> **Vietate le asserzioni-fantoccio.** `expect(x).not.toBe(...)` da solo non è un controllo: ogni
> asserzione negativa vuole **accanto** un controllo positivo che, col difetto rimesso, cade per
> primo. **Le asserzioni che contano sono sulla MUTAZIONE, non sullo status.**

---

## ONDATA 1 — le incompiutezze del ciclo e i dati di minori

### S01 — La primitiva `Modal` diventa un dialogo vero
- **Causa:** C1 · **chiude:** android F1, F2, F3 · iOS F1 · design F2 · frontend F2 · a11y F3 (metà), F9
- **File esclusivi:**
  - `src/components/ui/Modal.tsx` (modifica)
  - `src/components/features/admin/AdminMenuSheet.tsx` (aggancio del tasto Indietro)
  - `__tests__/components/Modal-dialogo-modale.test.tsx` (nuovo)
- **Cosa fare** (quattro correzioni, una sola causa):
  1. **Backdrop fratello.** Separare il velo dal contenitore del dialogo, esattamente come fa già
     `AdminMenuSheet.tsx:157-167`: un `<div className="absolute inset-0" aria-hidden="true">` che
     porta `background` + `backdropFilter`, e il `[role=dialog]` **senza nessun antenato filtrato**.
     Il velo usa `color-mix` sul token `--color-kidville-green` invece dell'`rgba(0,106,95,0.30)`
     cablato a `Modal.tsx:121`.
  2. **Piano sopra il chrome.** `z-[80]` → `z-[120]` sul contenitore. La topbar admin è `z-[105]`,
     la sidebar `z-105`, il foglio menu `z-[110]`.
  3. **`inert` sui fratelli.** All'apertura marcare `inert` (con fallback `aria-hidden="true"`) su
     tutti i fratelli del contenitore modale a livello di `document.body`, ripristinandoli alla
     chiusura. Con più modali aperti (lo `modalStack` esiste già) si ripristina **solo quando lo
     stack si svuota**.
  4. **Tasto Indietro.** Una riga: `useOverlayIndietro(open, onClose)` dentro `Modal.tsx` — copre
     in un colpo i **15 consumatori** — e la stessa dentro `AdminMenuSheet.tsx`, che non usa la
     primitiva.
  5. **Focus-trap robusto.** Se `document.activeElement` non è dentro `dialogRef`, riportare il
     focus dentro (`e.preventDefault(); first.focus()`), coprendo il caso `<body>`. E filtrare i
     focusable `display:none` (oggi `Modal.tsx:68` li include).
- **Migrazione DB:** nessuna · **Variabili d'ambiente:** nessuna
- **Log:** nessuno nuovo. `useOverlayIndietro` logga già solo ciò che va storto (una riga per
  pressione del tasto Indietro accecherebbe la coda da 20 eventi del client).
- **Test (TDD, in questo ordine):**
  1. rosso: montare un `Modal` **vero** e asserire che nessun antenato del `[role=dialog]` ha
     `backdropFilter` valorizzato;
  2. rosso: `inert` presente sui fratelli di `document.body` mentre è aperto, **assente dopo la
     chiusura** (controllo positivo: prima dell'apertura non c'è);
  3. rosso: `chiudiOverlayInCima()` ritorna `true` con un `Modal` montato e **`onClose` è stato
     invocato**; controllo positivo: senza modale ritorna `false`;
  4. rosso: `Tab` con `document.activeElement === document.body` riporta il focus dentro il dialogo.
- **Criterio di accettazione:**
  - `npx vitest run __tests__/components/Modal-dialogo-modale.test.tsx` → tutti verdi
  - sull'emulatore: `adb shell uiautomator dump` con la modale aperta → il dump **contiene**
    `PUBBLICA AVVISO` e **non contiene** `AVVISI PUBBLICATI` né `Modifica`/`Elimina` della tabella
  - `adb shell input keyevent 4` con testo nel campo TITOLO → la modale si chiude, **la pagina non
    cambia**, il testo è ancora lì al riaprire
  - in pagina: `document.elementFromPoint(cxChiudi, chiudiTop+3)` → il `button[aria-label]`, **non**
    `HEADER.kv-admin-topbar`
- **Prova di validità:** rimettere `backdropFilter` sull'antenato → il test 1 rosso e il dump torna
  a nascondere la modale; togliere la riga `useOverlayIndietro` → il test 3 rosso.
- **Non toccare:** `src/components/features/avvisi/AvvisoForm.tsx` (è di **S13**), `globals.css`
  (è di **S16**), la scala z documentata nel commento di `AvvisoForm.tsx` (la aggiorna S13).
- **Parallelo con:** S03, S04, S08, S09, S24.

### S03 — Il lock dei bucket guarda la colonna `public`
- **Causa:** C2 · **chiude:** debug F1 (la correzione di sicurezza più importante della giornata,
  oggi non protetta da niente)
- **File esclusivi:** `__tests__/architecture/bucket-storage-dichiarati.test.ts`
- **Cosa fare:** sfruttare il parser già presente (`valoriInsert()` restituisce **tutte** le
  colonne, `public` compresa). Regola: **per ogni** bucket di un elenco esplicito
  `{avvisi_allegati, task_allegati, gallery, chat-allegati, certificati-medici, credenziali,
  fatture, pagelle, protocollo, cassa-giustificativi, form_attachments}` **l'ultimo** statement che
  lo configura deve dire `public = false`; `news` è **l'unica eccezione ammessa**, elencata con la
  ragione scritta, come già fanno le altre allowlist del repo.
- **Test (TDD):** prima si scrive il test; per vederlo rosso si crea temporaneamente
  `supabase/migrations/20260801000000_prova_bucket_ripubblicato.sql` con
  `update storage.buckets set public = true where id = 'avvisi_allegati';`, **e la si cancella**
  dopo aver visto il rosso.
- **Criterio di accettazione:**
  - con la migrazione-esca presente: `npx vitest run __tests__/architecture/` → **rosso**, e il
    messaggio **nomina il bucket e il file**
  - senza l'esca: `npx vitest run __tests__/architecture/` → **375+ verdi, 0 rossi**
- **Prova di validità:** è il test stesso (la migrazione-esca è la mutazione).
- **Non toccare:** le migrazioni esistenti; il commento sui MIME di `gallery` (è una scelta
  dichiarata, va lasciata com'è e citata).
- **Parallelo con:** tutti.

### S04 — Il documento d'identità non si firma senza controllo di sede
- **Causa:** C3 · **chiude:** privacy F1 (**dati di minori, fuga attiva**)
- **File esclusivi:**
  - `src/app/api/admin/iscrizioni/route.ts`
  - `__tests__/api/iscrizioni-documento-in-scope.test.ts` (nuovo)
- **Cosa fare:** prima di firmare, risalire **dal percorso alla domanda** che lo contiene e
  verificarne la sede contro `resolveScuoleAttive`; 403 «Sede non accessibile» + `warn` persistito
  di soli uuid/conteggi se non è in scope, sullo stampo di `assertInvioInScope` (riga 120). Il
  modello corretto esiste: `src/app/api/pagamenti/cassa/allegato/route.ts:33-37` confronta il
  prefisso di sede nel percorso.
- **Migrazione DB:** `supabase/migrations/<TS>_enrollment_documento_path_indice.sql` — indice
  funzionale per risalire dal `documento_path` alla domanda senza `data::text like`.
  **Scritta, NON applicata.** Il codice deve degradare pulito se l'indice non c'è (la query resta
  corretta, solo più lenta): il DB E2E della CI **non è migrato**.
- **Log:** `logEvento('auth','warn',{tipo:'documento-fuori-sede', azione, utente, ruolo})` prima del
  403. **Mai** il percorso in chiaro (può contenere il nome del file originale).
- **Test (TDD):** l'attore di Aversa chiede un percorso di Giugliano → **403 e nessuna URL firmata
  nel corpo**; controllo positivo: l'attore di Giugliano sullo stesso percorso → 200 con `url`.
- **Criterio di accettazione:**
  ```
  curl --get --data-urlencode "doc=<percorso di Giugliano>" \
       -H 'Cookie: <sessione test.aversa.segreteria>' localhost:3000/api/admin/iscrizioni
  → 403, corpo senza campo "url"
  ```
  e con la sessione di Giugliano → `200` con `url` firmata.
- **Prova di validità:** rimuovere il controllo di sede → il test torna a 200 **e il corpo contiene
  `url`** (è l'asserzione sul corpo che deve cadere, non solo lo status).
- **Non toccare:** la proiezione esplicita che ha tolto `credentials` dalla GET (correzione buona,
  verificata); il ramo elenco.
- **Parallelo con:** S01, S08, S09, S24. **In sequenza prima di S22** (che tocca lo stesso file).

### S08 — `GET /api/tasks`: identità e ruolo dalla sessione, non dalla query
- **Causa:** C3 · **chiude:** backend F2
- **File esclusivi:**
  - `src/app/api/tasks/route.ts`
  - `__tests__/api/tasks-identita-da-sessione.test.ts` (nuovo)
- **Cosa fare:** calcolare `isManager` e `activeUserId` da `auth.user.id` / `auth.user.role`; il
  `userId` di query si **ignora** o si accetta solo se coincide con la sessione (come fa già
  `resolveIdentity`). Nel ramo `?studentId=` aggiungere `assertAlunnoInScope(supabase, auth.user,
  studentId)` (già in `scope.ts:584`: controlla plesso e, per gli educator, la sezione assegnata) e
  togliere `note_mediche` dal payload dei task se la schermata non lo usa.
- **Log:** `warn` `alunno-fuori-sede` sul diniego del ramo `studentId` (oggi non c'è **nessun**
  segnale).
- **Test (TDD):** educator che passa lo userId di un admin → l'elenco è **vuoto** (asserzione sul
  **corpo**, non sullo status); controllo positivo: l'admin col proprio userId vede il proprio task.
  Ramo `studentId` su un alunno fuori sezione → 403 **e nessun campo anagrafico nel corpo**.
- **Criterio di accettazione:**
  ```
  curl -b <sessione educator> 'localhost:3000/api/tasks?userId=<uuid admin>&filter=all' → []
  curl -b <sessione educator> 'localhost:3000/api/tasks?studentId=<alunno altrui>'      → 403
  ```
- **Prova di validità:** rimettere `const activeUserId = userId!` → il primo test torna a
  restituire il task altrui.
- **Non toccare:** `POST /api/tasks` (già corretto e verificato da 4 lock); `src/lib/auth/scope.ts`.
- **Parallelo con:** S01, S03, S04, S09, S24.

### S09 — La galleria non pubblica foto di gruppo senza liberatoria
- **Causa:** C9 · **chiude:** privacy F5 (**dati di minori**)
- **File esclusivi:**
  - `src/lib/gallery/privacy.ts`
  - `src/app/api/gallery/route.ts`
  - `__tests__/lib/gallery-privacy-broadcast.test.ts` (nuovo o esteso)
- **Cosa fare:** rifiutare **400** la combinazione `is_broadcast === true && tagUnici.length > 0`,
  **e** applicare il controllo di consenso anche al ramo broadcast — è il canale con la platea più
  ampia, cioè quello che ne ha più bisogno. Oggi
  `if (isBroadcast || uniqueTags.length <= 1) return []` esce **prima ancora di interrogare il
  database**, e il vincolo «broadcast ⇒ nessun tag» è imposto **solo dal client**
  (`teacher/gallery/page.tsx:304`).
- **Test (TDD):** `POST /api/gallery` con `is_broadcast:true` + 3 alunni senza consenso → **422/400
  e nessuna riga scritta in `galleria_media_v2`** (asserzione sulla mutazione); controllo positivo:
  gli stessi 3 alunni **con** consenso → 201.
- **Criterio di accettazione:** `npx vitest run __tests__/lib/gallery-privacy-broadcast.test.ts`
  verde, con l'asserzione sulle scritture (`scritti()` vuoto), non sullo status.
- **Prova di validità:** ripristinare `if (isBroadcast || …) return []` → rosso sul caso broadcast,
  **verde** sul controllo positivo (se cadono entrambi il test è scritto male).
- **Non toccare:** la logica del tag singolo (`uniqueTags.length <= 1`), che è una scelta
  dichiarata; `src/app/(dashboard)/teacher/gallery/page.tsx`.
- **Parallelo con:** S01, S03, S04, S08, S24.

### S24 — Le sedi nuove nascono col loro corredo
- **Causa:** C11 · **chiude:** backend F3
- **File esclusivi:**
  - `src/lib/scuole/corredo-sede.ts` (o l'equivalente che provisiona la sede)
  - `src/app/api/avvisi/route.ts` (**solo** il messaggio del 403 e la mappatura del gruppo)
  - `supabase/migrations/<TS>_avvisi_config_backfill_sedi.sql` (nuovo)
  - `__tests__/api/avvisi-pubblicazione-per-sede.test.ts` (nuovo)
- **Cosa fare:** (a) far nascere ogni sede nuova con `avvisi_config` valorizzato come Giugliano
  (`["admin","teacher"]`) + backfill di Aversa e Cesa; (b) decidere **esplicitamente** che
  `segreteria` sta nel gruppo `admin` (il PRD la equipara ad admin) — **è una decisione di prodotto:
  se il titolare dice diversamente, si cambia solo il messaggio**; (c) rendere il testo del 403
  coerente con la configurazione effettiva: **nominare i ruoli abilitati**, non «la segreteria»
  (oggi il messaggio indica come autorizzato proprio il ruolo che sta negando).
- **Migrazione:** backfill `avvisi_config` per le sedi con valore NULL. **Scritta, NON applicata.**
  Degradazione E2E: il codice deve reggere `avvisi_config` NULL senza 500 (default esplicito).
- **Test (TDD):** segreteria di Aversa pubblica sulla propria sede → **201 e la riga esiste**;
  controllo positivo/negativo: un `educator` di Aversa → 403 col messaggio che **nomina i ruoli
  abilitati reali**.
- **Criterio di accettazione:**
  ```
  curl -b <sessione test.aversa.segreteria> -X POST localhost:3000/api/avvisi \
       -d '{"titolo":"x","contenuto":"y","target_scope":"classe",
            "target_classes":["TEST Infanzia"],"scuola_id":"<Aversa>"}'  → 201
  ```
  **Attenzione:** `POST /api/avvisi` **notifica i genitori reali**. Si usa solo una classe
  `TEST *` senza genitori agganciati, e si cancella l'avviso **e la notifica** a fine prova.
- **Prova di validità:** rimettere `avvisi_config` a NULL nella fixture → il test torna 403.
- **Non toccare:** il gate di ruolo di `requireStaff`; il resto di `avvisi/route.ts` (il log di
  successo è di **S17**, `assertAvvisoInScope` è di **S11**). **Coordinarsi:** S11, S17 e S24
  toccano tutti l'area avvisi → **vanno in ondate diverse**.

---

## ONDATA 2 — lock, gate residui, mobile

### S02 — Il lock della modale confronta anche le barre in alto
- **Causa:** C2 · **chiude:** il buco che ha lasciato passare design F2 / frontend F2 / iOS F1
- **Dipende da:** S01 · **File esclusivi:** `__tests__/components/AvvisoForm-a11y-modale.test.tsx`
- **Cosa fare:** oggi il lock confronta la z della modale **solo con le tre bottom-nav** — per
  questo dichiarava verde una modale che la topbar continua a coprire. Va esteso a **tutte** le
  superfici fisse: `.kv-admin-topbar`, la sidebar admin, `AdminMenuSheet` (`z-[110]`), l'AppBar
  docente/genitore. Regola: `z(Modal) > max(z di ogni barra fissa)`.
- **Criterio:** riportando `Modal.tsx` a `z-[80]` il lock diventa **rosso e nomina la barra** che
  la copre; il controllo positivo (le barre un piano ce l'hanno davvero) resta verde.
- **Non toccare:** `Modal.tsx` (di S01).

### S05 — I due test deboli diventano test
- **Causa:** C2 · **chiude:** i due warning del tester debug
- **File esclusivi:** `__tests__/api/news-digest.test.ts`, `__tests__/api/tasks-sede-dichiarata.test.ts`
- **Cosa fare:**
  1. `news-digest.test.ts:88-93` — il mock **riscrive la regola del resolver dentro il test**: col
     difetto rimesso in `scope.ts` quel file resta verde mentre 5 altri cadono. Sostituirlo con il
     resolver **vero** (il file non deve mockare `scope`) oppure, se l'isolamento serve, con uno
     stub che **non contiene logica** e un caso di negazione fissato dal chiamante. *Un mock che
     riscrive la regola invecchia sempre in una direzione sola.*
  2. `tasks-sede-dichiarata.test.ts:180` — `expect([400, 403]).toContain(res.status)` → **`403`**
     secco. Aggiungere il caso mancante segnalato dal tester: **utente MONO-sede che dichiara una
     sede altrui** (quello che col difetto rispondeva 201 scrivendo nella propria sede).
- **Criterio:** rimettendo in `scope.ts` il ripiego silenzioso, `news-digest.test.ts` **diventa
  rosso** (oggi resta verde). L'asserzione sulla mutazione (`scritti()` vuoto) resta la principale.
- **Non toccare:** `src/lib/auth/scope.ts` (di S20).

### S06 — Il lock `SECURITY DEFINER` vede anche `ALTER FUNCTION`
- **Causa:** C2 · **chiude:** debug F2
- **File esclusivi:** `__tests__/architecture/security-definer-revoke-lock.test.ts`
- **Cosa fare:** in `definisceSecurityDefiner()` sostituire la congiunzione con una **disgiunzione**
  sulle due forme che definiscono davvero il privilegio:
  `/SECURITY\s+DEFINER/i.test(sql) && /(CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|ALTER\s+FUNCTION)/i.test(sql)`.
  `sqlSenzaCommenti()` **resta** e continua a chiudere il falso positivo che aveva motivato la
  modifica. Nessuna migrazione del repo usa oggi `ALTER FUNCTION`: **costo zero, nessuna allowlist**.
- **Criterio:** con un file d'esca `alter function public.x() security definer;` (senza REVOKE) →
  **rosso**; senza esca → 20 verdi.

### S07 — Il lock della parità dei cataloghi
- **Causa:** C2 · **chiude:** il warning «oggi 4830 = 4830 per disciplina umana»
- **File esclusivi:** `__tests__/architecture/messaggi-parita-cataloghi.test.ts` (nuovo)
- **Cosa fare:** confrontare gli **insiemi di chiavi file per file** fra `messages/it` e
  `messages/en`, sullo stampo di `migrazioni-complete.test.ts`. Motivo per cui serve: `test/setup.ts`
  mocka next-intl risolvendo **solo** `messages/it` → un namespace inglese dimezzato lascerebbe
  **l'intera suite verde**.
- **Criterio:** togliendo una chiave da un file `en`, il lock è rosso **e nomina file e chiave**.

### S10 — `PATCH /api/admin/schools`: si opera solo sulle proprie sedi
- **Causa:** C3 · **chiude:** sicurezza F2
- **Dipende da:** **ONDATA 0** (tocca `isolamento-sede-coverage.test.ts`)
- **File esclusivi:**
  - `src/app/api/admin/schools/route.ts`
  - `__tests__/architecture/isolamento-sede-coverage.test.ts` (**solo la voce :824**)
  - `__tests__/api/schools-patch-in-scope.test.ts` (nuovo)
- **Cosa fare:** dopo il gate di ruolo, `scuoleDiUtente` + 403 «Sede non accessibile» + `warn`,
  **stessa forma e stesso messaggio** di `resolveScuolaScrittura` (così il segnale è uno solo).
  Sulla GET: `.in('id', plessi)` **ed esclusione della sede E2E** con `isScuolaE2E`
  (`src/lib/scuole/reali.ts`), come fa già `/api/iscrizione/sedi`. Decidere **una volta sola** se il
  `coordinator` è multi-plesso: `scope.ts:58` dice di no → togliere `coordinator` da `DIREZIONE`
  per le operazioni che modificano una sede, o limitarlo alla propria.
  **Sostituire** la voce di allowlist `:824` con un test vero.
- **Test (TDD):** coordinator di Giugliano su una sede altrui → **403 e `scuole.updated_at`
  invariato** (asserzione sulla **mutazione**); controllo positivo: sulla **propria** sede → 200 e
  il campo cambia davvero.
- **Criterio:** `GET /api/admin/schools` con quella sessione → **le sole sedi proprie, senza
  «Kidville E2E»**.
- **Nota operativa dal collaudo:** `scuole.updated_at` della riga `e2e00000-…` è stato spostato dal
  tester a `2026-07-31 19:50:06.476+00` (valore precedente `2026-07-10 12:14:48.157+00`).

### S11 — `assertAvvisoInScope` guarda PostgREST e lascia un segnale
- **Causa:** C3 + C5 (PostgREST non lancia) · **chiude:** log F2 + i warning backend su `tasks/[id]`
- **File esclusivi:**
  - `src/lib/auth/scope.ts` → **NO**: per evitare la collisione con S20, la funzione si sposta in
    **`src/lib/auth/scope-avvisi.ts`** (nuovo) e `avvisi/[id]/route.ts` la importa.
  - `src/app/api/avvisi/[id]/route.ts`
  - `src/app/api/tasks/[id]/route.ts`
  - `__tests__/api/avvisi-scope-postgrest.test.ts` (nuovo)
- **Cosa fare:** destrutturare `{ data, error }`; su `error` → `scopeNonRisolto('scope-avviso-non-
  risolto', error, …)` → **500**; su `!row` → **404 «Avviso non trovato»** (senza toccare i contatori
  di sicurezza); su sede fuori scope → `logEvento('auth','warn',{tipo:'avviso-fuori-sede',…})`
  **prima** del 403, come già fanno `pagamento-fuori-sede`, `genitore-fuori-sede`,
  `utente-fuori-sede`, `classe-fuori-sede`. Stessa correzione in `tasks/[id]:PUT` (riga 165, dove un
  errore di lettura diventa un 404) e `:DELETE` (riga 301, dove diventa un 403 indistinguibile da un
  tentativo cross-sede). Smettere di rigirare `error.message` al client (`tasks/[id]:254,:314`).
- **Log:** tre righe distinte per tre cause distinte. Il `warn` lo emette **la funzione di scope**,
  non `withRoute` (che per politica manda 401/403/404 a `info`).
- **Test (TDD):** tre casi separati — guasto di lettura → 500; id inesistente → 404; avviso di
  un'altra sede → 403 **con la riga `warn` emessa** (si asserisce sulla chiamata a `logEvento`).
- **Criterio:**
  ```
  curl -b <sessione> localhost:3000/api/avvisi/00000000-0000-4000-8000-000000000999 → 404
  select count(*) from app_log where evento='auth' and livello='warn'
     and messaggio='avviso-fuori-sede' and creato_il > now() - interval '2 minutes';  → ≥ 1
  ```
- **Non toccare:** `src/lib/auth/scope.ts` (S20), `src/app/api/avvisi/route.ts` (S17/S24).

### S13 — L'accessibilità della modale «Nuovo avviso»
- **Causa:** C5 · **chiude:** a11y F2, F3 (metà), F4, F8, design F3 · + `aria-busy`, `aria-required`,
  `previewUrl` inutilizzato
- **File esclusivi:** `src/components/features/avvisi/AvvisoForm.tsx`,
  `__tests__/components/AvvisoForm-campi-a11y.test.tsx` (nuovo)
- **Cosa fare** — il pattern è **già nel file** (`:347`, il `<select>` della sede):
  1. `useId()` (già importato) per generare gli id, `htmlFor` su **ogni** `<label>` — Titolo (:373),
     Contenuto (:378), Scadenza (:423), File allegato (:432), Link esterno (:464). Il placeholder
     resta **suggerimento**, non etichetta.
  2. `aria-pressed` sui due toggle Tipo (:385-386), sui due Destinatari (:398-399) e sulle pillole
     classe (:411-418), **più un segno non cromatico** (spunta o bordo) per chi distingue male i
     colori. *Il rischio è pubblicare a una classe sbagliata senza accorgersene.*
  3. Bottone «togli allegato» (:454-456): `aria-label` da catalogo + `min-w-[44px] min-h-[44px]` con
     la pastiglia visiva piccola, `aria-hidden="true"` sull'icona.
  4. Submit: `aria-disabled` + guardia nell'handler al posto di `disabled` (così il focus **resta
     sul bottone**), `aria-busy="true"` sul dialogo durante l'invio, `role="status"` per lo stato.
  5. `-mr-2` → `-mr-1.5` a :103 (la crescita è 6px per lato, la compensazione applicata 8).
  6. Aggiornare il commento della **scala z** (:36-48), che oggi documenta i modali **sotto** il
     chrome admin: dopo S01 non è più vero.
- **Test (TDD):** ogni campo ha un **nome accessibile non vuoto**; ogni toggle ha `aria-pressed`
  coerente con lo stato **e cambia dopo il click**; il bottone allegato misura ≥ 44px e ha un nome.
- **Criterio:** harness axe su `AvvisoForm` → **0 violazioni `label`** (oggi: *critical*, 2 nodi);
  `read_page` sul dialogo → il campo data ha un nome.
- **Prova di validità:** togliere gli `htmlFor` → axe torna rosso *critical*.
- **Non toccare:** `Modal.tsx` (S01), i token di colore (S16).

### S14 — Il selettore di sede si annuncia (bloccante a11y)
- **Causa:** C5 · **chiude:** a11y F1 (**bloccante**) + design F1 (nome sede illeggibile) + design F4
  (tre icone)
- **File esclusivi:** `src/components/ui/cockpit.tsx`,
  `src/components/features/admin/SectionsView.tsx`, `src/app/(dashboard)/teacher/page.tsx`,
  `src/components/features/admin/settings/SedeCorrente.tsx`,
  `src/components/features/admin/settings/OblioPanel.tsx`,
  `src/app/(dashboard)/admin/students/sezioni/[id]/page.tsx`,
  `__tests__/components/SedeSelector-a11y.test.tsx` (nuovo)
- **Cosa fare:**
  1. **Stato annunciato** (`cockpit.tsx:410-421`): `role="menuitemradio"` + `aria-checked={active}`
     sulle righe, `role="menu"` + `aria-labelledby` sul contenitore (:392-405), `aria-controls` sul
     trigger. In alternativa: togliere `aria-haspopup` e usare `role="group"` + `aria-label`.
  2. `onKeyDown` su **Escape** che chiude e riporta il focus al trigger (oggi la chiusura è agganciata
     **solo a `mousedown` su document**: da tastiera non c'è modo di annullare).
  3. **Contrasto**: `text-kidville-muted` → `text-kidville-sub` sui **tre** punti in cui compare il
     **nome della sede** (`teacher/page.tsx:232`, `SectionsView.tsx:249`, la riga meta di `SedeRow`
     in `cockpit.tsx:416`, oggi **2,12:1**, il valore più basso incontrato). Alzare il font del chip
     da 10px a 11px.
  4. **Un solo glifo per «sede»**: esportare `SedeIcon` da `@/components/ui` (candidato naturale:
     `SchoolIcon`, già nel selettore) e sostituire `Building2` e `MapPin` nei 6 punti. `MapPin` resta
     nel wizard pubblico **solo** se lì significa «indirizzo/mappa».
- **Criterio:** con 3 sedi, ogni riga ha `aria-checked` (una sola `true`); `Esc` chiude e restituisce
  il focus; il rapporto misurato sul nome sede ≥ **4,5:1**.
- **Non toccare:** `globals.css` (S16), `AvvisoForm.tsx` (S13).

### S15 — I flow Maestro Android dicono la verità sull'albero
- **Causa:** C12 · **chiude:** android F4, android F5
- **File esclusivi:** `.claude/maestro-flows/android-percorso-genitore.yaml`,
  `android-percorso-docente.yaml`, `android-biometria-loop.yaml`,
  `.claude/maestro-flows/README.md`, `__tests__/architecture/maestro-flows-selettori.test.ts`
- **Cosa fare:** sostituire le **quattro** occorrenze di `text: "MENU"` con
  `text: "Menu · tutte le sezioni"` (genitore :73, :80, :105 · docente :58 · biometria :59);
  correggere i **commenti** e la tabella del README che affermano il contrario
  («la bottom-nav del genitore NON espone l'aria-label»: **è falso**, la misura dice che espone
  l'`aria-label` e non il testo del `<span>`). Aggiungere `scrollUntilVisible` prima del
  `tapOn: "Apri la bacheca"` (docente :79-86) e, **dopo** il tap, un'asserzione **negativa** sulla
  pagina di partenza (regola già scritta nel README per i tap ciechi). Estendere il lock
  `maestro-flows-selettori.test.ts`, che **oggi non dice nulla su «MENU»**, perché un selettore morto
  non possa rientrare.
- **Criterio:** `maestro test .claude/maestro-flows/android-percorso-genitore.yaml` → **22/22**;
  `…-docente.yaml` → verde fino in fondo; `npx vitest run
  __tests__/architecture/maestro-flows-selettori.test.ts` rosso se si rimette `"MENU"`.
- **Trappola da ricordare nel commento:** il match di Maestro è **case-insensitive** e la pagina
  contiene già il bottone `NUOVO AVVISO` → asserire l'apertura della modale con `Nuovo Avviso`
  **passa anche a modale chiusa**. Si asserisce un testo interno («Pubblica Avviso»).
- **Prerequisito d'ambiente:** `next dev` **non serve** (la WebView si ricarica da sola e svuota i
  campi): build di produzione + `next start`. AVD: `KV-play-phone`.

---

## ONDATA 3 — osservabilità, i18n, privacy strutturale

### S16 — I token: contrasto alla radice e Alto Contrasto che funziona
- **Causa:** C6 · **chiude:** a11y F5, F6, F7, F10 + i warning sulle 7 fasce d'errore e sulle coppie
  fuori modale
- **File esclusivi:** `src/app/globals.css`, `src/app/(dashboard)/admin/avvisi/page.tsx`,
  `src/app/(dashboard)/teacher/avvisi/page.tsx`, `src/components/features/admin/SezioniMultiSelect.tsx`,
  `src/components/features/admin/GiudiziManager.tsx`,
  `src/components/features/admin/settings/SettingsPanel.tsx`,
  `src/components/features/admin/ScrollableStudentForm.tsx`,
  `__tests__/a11y/contrasto-token.test.ts` (nuovo)
- **Cosa fare:**
  1. **Etichette e testo informativo**: `text-kidville-muted` → `text-kidville-sub` (#55615C,
     6,46:1). Fatto alla radice, chiude **anche** a11y F7 (Alto Contrasto dentro la modale) senza
     aggiungere una sola regola `[data-contrast="high"]`.
  2. **Errori**: `text-kidville-error` → `text-kidville-error-strong` (#C62828, 4,92:1) sulle 7
     fasce nuove — il token **esiste già** ed è documentato per questo accoppiamento.
  3. **Banda nera in Alto Contrasto** (`globals.css:449-459` + `:172`): regola esplicita
     `[data-contrast="high"] .kv-table-scroll { … }` col colore della superficie **reale** della
     tabella. Il commento sopra la regola dice «il colore-coperchio è il token superficie → si
     ribalta da solo»: **è l'assunto sbagliato**, perché la superficie usa `bg-white`, che
     `@theme inline` ha già inlinato a `#FFFFFF`. Estendere il lock esistente sui token in Alto
     Contrasto a chi usa `var(--color-kidville-white)` come colore di **copertura**.
  4. **KPI giallo su bianco** (1,61:1): numero in `text-kidville-green`, giallo come accento su
     bordo/icona.
  5. `ScrollableStudentForm.tsx:330`: `rgba(239,68,68,.3)` → il token `--color-kidville-error`.
- **Criterio:** scansione dei contrasti sul dialogo e su `/admin/avvisi` → **0 coppie sotto 4,5:1**
  (oggi 12 nella modale, 9 su `/admin/avvisi`, 8 su `?tab=sections`); in Alto Contrasto la prima
  lettera di ogni riga è leggibile.
- **Non toccare:** `:focus-visible` in `globals.css:271` — **l'anello di focus è sano** e le 171
  `focus:outline-none` **non** lo uccidono perché la regola è **fuori da ogni `@layer`**. Chi
  «ripulisce» quelle utility deve prima verificare di non spostare la regola dentro un layer.
  Il primario verde/giallo (4,05:1) è pattern di brand documentato: **non si tocca in questo ciclo**,
  si annota nel PRD.

### S17 — Il log di successo arriva davvero in tabella
- **Causa:** C7 · **chiude:** log F1 + i warning W1, W7
- **File esclusivi:** `src/lib/logging/logger.ts`, `src/lib/logging/supabase-fetch.ts`,
  `src/app/api/avvisi/upload/route.ts`, `src/app/api/tasks/upload/route.ts`,
  `__tests__/architecture/eventi-log.test.ts`
- **Cosa fare:**
  1. Aggiungere **`avvisi`** e **`storage`** a `EVENTI_PERSISTITI` (volume misurato: 10 avvisi/30
     giorni, rumore zero contro le 23,7 righe/giorno già assorbite) **e correggere il commento a
     `:113-116`, che oggi dice il falso**: afferma che nel repo non esiste nessun
     `logEvento('avvisi','info',…)`, e ne esiste uno, **introdotto dallo stesso commit**.
  2. `logEvento('storage','info',{esito:'allegato-caricato',bucket,size})` sui due upload — **solo
     insieme all'allowlist**, altrimenti si aggiunge una riga che non arriva da nessuna parte.
     Motivo: con i bucket appena resi privati, «l'allegato non si apre» è un guasto **nuovo**, e
     senza riga di successo «nessun log di upload» non distingue «nessuno ha caricato» da «gli
     upload non partono più». *È letteralmente l'ambiguità che ha nascosto il guasto delle email.*
  3. Estendere `eventi-log.test.ts`: **ogni `logEvento(evento,'info')` del repo appartiene a un
     evento persistito o a una lista di deroghe motivate**. È l'unica cosa che impedisce al difetto
     di tornare.
  4. **Rumore che acceca** (W1): una sola `GET /api/avvisi` produce **35 righe**, 34 delle quali
     `db … lenta=true` — un terzo delle 100 righe che Vercel restituisce, bruciate da un'apertura
     della bacheca. Alzare `LENTA_MS` (oggi 500, sotto la latenza tipica verso un Postgres remoto)
     **oppure** emettere **una riga di sintesi per richiesta** («n query lente=34, max=898ms»).
- **Criterio:** pubblicato un avviso, `select count(*) from app_log where evento='avvisi' and
  livello='info'` → **≥ 1** (oggi: 0 da sempre); una `GET /api/avvisi` produce **≤ 3 righe**.
- **Non toccare:** `auth` **resta fuori** dall'allowlist, ed è la scelta che conta: i suoi `info`
  sono i rifiuti dei gate e le risposte non-ok di GoTrue — rumore puro. Gli `auth` che servono
  all'audit sono `warn`/`error` e si persistono già per livello.

### S18 — La riga di log dice la verità
- **Causa:** C7 · **chiude:** log W3, W4, privacy `hashCorrelabile('')`, `stato_http` NULL
- **File esclusivi:** `src/lib/logging/redact.ts`, `src/lib/logging/with-route.ts`,
  `__tests__/lib/logging-redact.test.ts`
- **Cosa fare:** (a) `hashCorrelabile('')` produce un **hash costante**: nome, cognome, CF ed email
  vuoti escono tutti come lo stesso `#xxxxxxxx` e **correlano persone diverse**. Trattare `''` come
  `[redatto:str/0]` **prima** di hashare. (b) `url` è in `CHIAVI_PATH` e passa da `redigiPath`, che
  **non maschera un nome di file senza cifre**: stesso valore, due trattamenti (`"url"` in chiaro,
  `"fileUrl":"[redatto:str/27]"`). Un allegato può chiamarsi «certificato-<cognome>.pdf».
  (c) passare lo `stato` HTTP a `logEvento` sui dinieghi di scope, così chi legge distingue il 403
  (sicurezza) dal 400 (uso).
- **Criterio:** `hashCorrelabile('') !== hashCorrelabile('')` non è il test giusto — il test è:
  due stringhe **vuote** non producono lo stesso identificativo correlabile di due nomi diversi;
  e `redigiPath('certificato-rossi.pdf')` **non** restituisce la stringa in chiaro.
- **Non toccare:** la lista bianca — **non si aggiungono chiavi «perché sarebbe comodo vederle»:
  sono dati di minori**.

### S19 — I catch muti smettono di ricrescere (sotto-obiettivo verificabile)
- **Causa:** C7 · **chiude:** log F3 (91 catch muti) — **non con una bonifica di massa, ma con un
  lock + una bonifica mirata**
- **File esclusivi:** `eslint.config.mjs`, `src/app/api/admin/regenerate-credentials/route.ts`,
  `src/lib/allegati/storage.ts` (:186), `src/app/(dashboard)/admin/students/page.tsx` (:107-108),
  `src/components/features/admin/pagamenti/TicketMensaPanel.tsx` (:52,:70),
  `docs/superpowers/catch-muti-allowlist.json` (nuovo)
- **Cosa fare:**
  1. Regola ESLint che **fallisce il gate** su `.catch(() => {})` e `catch {}` vuoti in `src/`, con
     `eslint-disable` motivato ammesso **solo** in `src/lib/logging/**` (fail-open voluto e
     documentato).
  2. **Allowlist committata** dei file legacy ancora da bonificare, con il conteggio in testa. La
     regola: l'allowlist **può solo rimpicciolirsi** — un test in `__tests__/architecture/` asserisce
     che il numero non cresce e che ogni voce esiste ancora.
  3. **Bonifica immediata dei 5 percorsi che contano**: `regenerate-credentials:197`
     (`createBucket('credenziali')` — è il **percorso email credenziali**, il difetto storico da cui
     nasce questa categoria), `allegati/storage.ts:186` (codice **nuovo** di questo ciclo: la deroga
     va motivata in un `info`, non in un commento), le due fetch di `admin/students/page.tsx` (la
     pagina corretta da questo ciclo) e le due di `TicketMensaPanel`.
     Sostituzione: `logClient({livello:'warn',evento:'fetch',messaggio:'<cosa-non-si-è-caricato>',
     stato:res.status})` lato client — **il canale esiste, funziona ed è già usato correttamente**
     in `AvvisoForm.tsx:246,251` (23 righe `client:fetch` in tabella nelle ultime 24h).
- **Criterio di accettazione (numerico, verificabile):**
  ```
  npx eslint . --max-warnings 0     → exit 0
  grep -rnE "\.catch\(\(\s*\)\s*=>\s*\{\s*\}\)|catch\s*\{\s*\}" src/ | wc -l   → ≤ 86  (oggi 91)
  jq '.file | length' docs/superpowers/catch-muti-allowlist.json               → ≤ 81
  ```
  e il test che verifica che l'allowlist **non cresca**.
- **Prova di validità:** rimettere un `.catch(() => {})` in un file **non** in allowlist → il gate
  ESLint diventa rosso.

### S20 — `resolveScuolaScrittura`: il cookie riceve lo stesso trattamento della sede dichiarata
- **Causa:** C8 · **chiude:** sicurezza W1, W2 (promossi) + log W3
- **Dipende da:** **ONDATA 0** (`scope.ts` è il file che l'esecutore in corso potrebbe toccare)
- **File esclusivi:** `src/lib/auth/scope.ts`, `__tests__/lib/auth/scope.test.ts`
- **Cosa fare:**
  1. **Normalizzare a lowercase** `preferita` e gli elementi di `accessibili` (:183-185): oggi il
     confronto è `Set.has()` (case-sensitive) contro un tipo Postgres `uuid` che **non lo è**.
     Effetto misurato: la segreteria che dichiara **la propria** sede in maiuscolo riceve **403** e
     accende `sede-scrittura-fuori-scope`. **Doppio danno**: scrittura legittima negata *e* segnale
     di sicurezza inquinato.
  2. Cookie `sedi_attive` con **sole** sedi non accessibili (:194): oggi si scarta in silenzio e si
     ricade su «l'unica sede accessibile» → 201 senza log. In **lettura** lo stesso caso produce
     `sedi-attive-non-accessibili`: allineare la scrittura.
  3. Aggiungere `sede_richiesta: preferita` ai campi di `logEvento` (:188-191) — è un **uuid**, passa
     in lista bianca, **non è un dato personale**. Oggi la riga dice `sede=<sede primaria
     dell'utente>` e chi legge alle 3 di notte la scambia per la sede del tentativo.
  4. Correggere il commento :186-188 («la sede richiesta NON va in chiaro»): è vero per `campi`,
     **falso per la riga completa** — `parseBody` deposita il body grezzo e nella riga persistita si
     legge `payload.body.scuola_id` in chiaro. *È lo scarto che il prossimo lettore prende per
     garanzia.*
- **Criterio:** stessa sede in **maiuscolo** → **201** (oggi 403); cookie manomesso con sole sedi
  altrui → **403 + riga `warn`** (oggi 201 muto).
- **Prova di validità:** togliere il `.toLowerCase()` → il test del maiuscolo torna 403.

### S21 — Il messaggio d'errore del server ha un codice, non solo prosa
- **Causa:** C4 · **chiude:** localizzazione F1, F2 + metà di frontend F1 e backend F3
- **File esclusivi:** `src/lib/ui/esito-fetch.ts`, `messages/it/shared.json`, `messages/en/shared.json`,
  `src/app/api/mensa/menu/route.ts` (:143), `src/app/api/admin/import/anagrafiche/route.ts` (:81),
  `src/app/api/register/lessons/route.ts` (:182), `src/app/api/agenda/route.ts` (:127),
  `__tests__/architecture/errori-con-codice.test.ts` (nuovo)
- **Dipende da:** S20 (che tocca `scope.ts`, dove nascono i due messaggi)
- **Cosa fare:** affiancare a `error` un **codice stabile** (`{ error: '…', codice:
  'SEDE_NON_ACCESSIBILE' }`) e far tradurre **il codice** al client:
  `messaggioErrore()` diventa `t.has('errore.'+codice) ? t('errore.'+codice) : fallback`. Due chiavi
  (`erroreSedeNonAccessibile`, `erroreSedeDaSpecificare`) in **entrambi** i cataloghi. Riscrivere il
  testo per un essere umano **togliendo `scuola_id`** (il nome della colonna resta nel log
  `sede-scrittura-ambigua`, che è il posto giusto) e **uniformare le 4 copie scritte a mano**, che
  oggi dicono quattro cose diverse per lo stesso rifiuto. Lock: una nuova `error:` non compare senza
  codice.
- **Criterio:** con `KV_LOCALE=en`, il `role="alert"` della modale contiene **testo inglese da
  catalogo**; `grep -rn "scuola_id" messages/` → 0.
- **Nota:** i **452 messaggi d'errore italiani** nelle route sono la stessa classe. In questo ciclo si
  chiudono i due del perimetro **e si mette il lock**; il resto è debito dichiarato nel PRD.

### S22 — L'oblio segue il dato, non la riga
- **Causa:** C9 · **chiude:** privacy F2, F3 + i warning su foto del minore, allegati orfani,
  `credentials`, `audit_scritture_docente`
- **Dipende da:** S04 (stesso file `admin/iscrizioni/route.ts`)
- **File esclusivi:** `src/lib/gdpr/esegui.ts`, `src/lib/gdpr/anonimizza.ts`,
  `src/app/api/admin/gdpr/erase/route.ts`, `src/app/api/admin/iscrizioni/route.ts`,
  `supabase/migrations/<TS>_retention_iscrizioni_e_audit.sql`,
  `supabase/migrations/<TS>_drop_enrollment_credentials.sql`,
  `__tests__/lib/gdpr-oblio-completo.test.ts`
- **Cosa fare:**
  1. Estendere `anonimizzaAlunno`/`anonimizzaParent` e `admin/gdpr/erase` a **`enrollment_submissions`**:
     scrub del sottoalbero `data` per il soggetto, agganciato per CF o `documento_path`.
  2. Raccogliere i `documento_path` di **tutti** i soggetti (alunno **+ ogni `parents` collegato**) e
     rimuoverli insieme; sostituire il `catch` muto con
     `logEvento('storage','error',{operazione,esito:'oblio-file-non-rimosso',n_file},err)` e
     riportare il **conteggio dei file non rimossi** nella risposta e in `logScrittura`, così un
     oblio parziale è **visibile**.
  3. Rimozione dei media dallo storage alla cancellazione: `DELETE /api/news/[id]` (bucket **pubblico
     e oggi vuoto: è il momento giusto**), `avvisi/[id]`, `tasks/[id]` (`avvisi_allegati` ha già
     **1 oggetto orfano**), e le foto del minore in `gallery` (`esegui.ts:289-310` bonifica le
     segnalazioni ma non rimuove né la riga né il file, e l'alunno resta in `tag_students`).
  4. **Migrazioni (scritte, NON applicate):** job pg_cron di retention per le domande `rejected` e per
     le `pending` non evase oltre **N mesi** (*N va fissato dal titolare/legale — è l'unico numero
     che questo piano non decide*); scrub dei soli campi sanitari sulle `approved` già trasferite in
     anagrafica; retention su `audit_scritture_docente` (369 righe dal 5 luglio, `valore_dopo` **non
     redatto**: 9 righe con un CF in chiaro, 1 con `allergies`/`note_mediche` di un minore);
     **drop della colonna `enrollment_submissions.credentials`** (oggi vuota e non più riletta, ma la
     colonna esiste e le password in chiaro sono **anche nei backup** → va valutata la rotazione).
  5. Dichiarare il termine scelto in `src/app/privacy/page.tsx` e nel registro art. 30 — oggi
     l'informativa promette «non oltre la durata dell'iscrizione» per **231 domande la cui iscrizione
     non è mai iniziata**.
- **Criterio:** dopo un oblio su un soggetto di prova, `select count(*) from storage.objects where
  bucket_id='form_attachments' and name = any(<percorsi del nucleo>)` → **0**, e la risposta riporta
  `n_file_non_rimossi: 0`.
- **Non toccare:** il lock sui test di `esegui.ts` (l'oblio erase è già lockato: si estende, non si
  riscrive).

### S23 — Il consenso fotografico arriva a destinazione
- **Causa:** C9 · **chiude:** privacy F4
- **Dipende da:** S22 (stesso file `admin/iscrizioni/route.ts`)
- **File esclusivi:** `src/lib/forms/enrollment-template.ts`,
  `src/components/features/admin/news/NewsEditorPanel.tsx`, `src/app/api/news/route.ts`,
  `supabase/migrations/<TS>_alunni_consensi_foto_per_canale.sql`,
  `src/app/privacy/page.tsx`, `__tests__/api/news-consenso-foto.test.ts`
- **Cosa fare:** (a) propagare `consenso_foto_sito` e `consenso_foto_social` su **colonne per
  bambino**, popolate dall'import come già si fa per la galleria; (b) nell'editor News sostituire la
  **spunta libera** (oggi vive **solo in `useState`**, quindi non esiste prova di chi ha dichiarato
  cosa — art. 5 §2 e art. 7 §1) con la **selezione dei bambini ritratti** + controllo **server-side**
  del consenso «sito», sullo schema di `alunniSenzaConsenso`; in subordine, persistere la
  dichiarazione dell'operatore (chi, quando, versione del testo) su `news_posts`; (c) dire in
  `/privacy` che **esiste un canale pubblico senza login**.
- **Migrazione:** scritta, **NON applicata**. Degradazione E2E: colonne nuove → `PGRST204` su
  INSERT/UPDATE e `42703` su SELECT; il codice tratta l'assenza come «consenso non verificabile» e
  **blocca**, non come «consenso dato».
- **Criterio:** `POST /api/news` con una foto e un bambino **senza** consenso «sito» → rifiuto **e
  nessuna riga in `news_posts`**; controllo positivo: con consenso → 201.

### S25 — Il fuso è dichiarato, la regione è una sola
- **Causa:** C10 · **chiude:** localizzazione F4, F5
- **File esclusivi:** `src/i18n/config.ts`, `src/i18n/request.ts`, `src/lib/i18n/date.ts`,
  `src/components/features/parent/mensa/MensaCalendar.tsx`,
  `src/app/(dashboard)/teacher/diary/page.tsx`,
  `__tests__/architecture/date-con-timezone.test.ts` (nuovo)
- **Cosa fare:** `timeZone: 'Europe/Rome'` in **tutte** le voci di `OPZIONI` e nelle ~20
  `Intl.DateTimeFormat` inline (meglio: farle passare tutte dall'helper), più il ritorno di
  `timeZone` da `getRequestConfig`. Mappa `LOCALE_BCP47 = { it: 'it-IT', en: 'en-GB' }` in
  `src/i18n/config.ts`, letta da `date.ts` e da ogni `Intl.DateTimeFormat`; togliere il ramo scritto
  a mano da `MensaCalendar.tsx:74`. Per `teacher/diary:108` **il fuso non basta**: `new Date()` nel
  render va dietro il pattern `useClientValue` **già in uso nel repo** per il saluto orario.
  Lock che vieta `Intl.DateTimeFormat(` senza `timeZone` in `src/`.
- **Criterio:**
  ```
  TZ=UTC npx vitest run __tests__/architecture/date-con-timezone.test.ts   → verde
  TZ=Europe/Rome npx vitest run …                                          → verde, stesso output
  ```
  (oggi lo stesso istante rende «giovedì 30 luglio» contro «venerdì 31 luglio»).
- **Prova di validità:** togliere `timeZone` da una voce di `OPZIONI` → il lock rosso **e nomina la
  voce**.

### S26 — I plurali, il glossario e le stringhe cablate
- **Causa:** C10 · **chiude:** localizzazione F3 + i warning su glossario, tipografia, placeholder
- **File esclusivi:** `messages/it/**`, `messages/en/**`,
  `src/components/features/admin/StudentRegistryForm.tsx` (:321, :274),
  `src/app/api/admin/sections/scoped/route.ts` (:71), `src/lib/presenze/aggregate.ts` (:100)
- **Cosa fare:** convertire le ~10 chiavi in **ICU plural** in entrambi i cataloghi
  (`contAlunni`, `secConfigurate`, `toastAssegnati`, `toastAssegnatiMensa`, `toastExport`,
  `avvisi.sottotitoloDaGestire`, `diario.fotoScattate`, `teacherPrimaria.scrutinioImportate`,
  `teacherServizi.modulisticaFirmati`, `modulisticaMancanti`). **Attenzione: il mock di next-intl in
  `test/setup.ts` NON interpreta ICU** → vanno controllati gli unit test che asseriscono su questi
  testi. Uniformare «presa visione» (oggi `Acknowledgement` in tre file, `Read receipt` in altri
  due: l'elenco dice una cosa, la modale che lo crea un'altra). Portare a catalogo il placeholder
  cablato di `StudentRegistryForm.tsx:321`. Sostituire il fallback `|| 'Sede'` prodotto dal server.
  **Ripulire `messages/it/shared.json:galleryCercaPlaceholder`**, che contiene nome e cognome di una
  persona come esempio **in un repository pubblico**.
- **Criterio:** `node -e "…contAlunni…"` con `n=1` → «1 alunno»; `grep -rn "Read receipt" messages/`
  → 0 (o l'inverso, purché **uno solo**).

### S27 — Il 403 di un widget resta nel widget
- **Causa:** C15 · **chiude:** frontend F1 + il warning «etichetta bugiarda»
- **File esclusivi:** `src/app/(dashboard)/admin/students/sezioni/[id]/page.tsx`,
  `src/app/(dashboard)/admin/students/page.tsx` (:447),
  `src/app/api/admin/sections/[id]/teachers/route.ts` (:34), `src/lib/auth/require-staff.ts` (:255)
- **Cosa fare:** (a) **frontend, comunque necessario**: il 403 di `/teachers` va reso **dentro** il
  riquadro «Insegnanti di riferimento» come «non hai i permessi», non come errore della **pagina**;
  (b) **permessi, decisione del titolare**: o si aggiunge `'segreteria'` a `DIREZIONE` (almeno in
  GET), o si rende **vero** il messaggio — «riservata alla **Direzione**», non «allo staff» (la
  segreteria **è** staff: oggi il testo dice il falso a chi lo legge). (c) `page.tsx:447`: con la
  tab «SEZIONI» attiva il bottone dice **«NUOVO GENITORE»**.
- **Criterio:** con la sessione di segreteria, `/admin/students/sezioni/<id>` → **nessuna fascia
  rossa in cima**, il riquadro insegnanti mostra lo stato «permessi»; con l'admin → i due pannelli
  ci sono (2/2 e 0/2, come nel collaudo).

---

## ONDATA 4 — piattaforma, mobile, coda

### S12 — I flow Maestro iOS
- **Causa:** C12 · **chiude:** iOS F2
- **File esclusivi:** `.claude/maestro-flows/ios-percorso-segreteria.yaml`,
  `ios-percorso-genitore.yaml`, `ios-percorso-docente.yaml`
- **Cosa fare:** `pressKey: Enter` al posto di `tapOn: "Accedi"` (misurato affidabile: il tap non fa
  partire il submit con la tastiera aperta, e `tapOn: "Benvenuto/a!"` **non la chiude**); spostare la
  gestione del dialog permessi **dopo** il login, preceduta da
  `extendedWaitUntil: visible "Non consentire", optional: true` — **più una copia prima**, perché il
  permesso rimasto in coda ricompare al lancio successivo; nel flow docente sostituire ancore
  dipendenti **dall'ora** («Buongiorno!») e **dallo stato dei dati** («Modifica appello» /
  «Fai l'appello ora», `messages/it/teacherNav.json:appelloCtaFai`). Le varianti già verdi del tester
  sono in `…/scratchpad/{genitore-fix,docente-fix,docente-4}.yaml`.
- **Criterio:** i tre flow **arrivano in fondo**, 2 esecuzioni su 2, con `--device <UDID>` esplicito
  (con due simulatori booted, senza `--device` Maestro aggancia **l'iPad**, dove la bottom-nav è
  `lg:hidden` e metà dei selettori non esistono).
- **Warning da chiudere qui:** ogni esecuzione scrive `MAESTRO_KV_PASSWORD` **in chiaro** in
  `~/.maestro/tests/<timestamp>/maestro.log`. È la password comune dei **41 account TEST attivi in
  produzione**: prevedere la pulizia della cartella o un meccanismo che non passi il segreto come
  variabile di flow.

### S28 — L'annullamento non è un guasto di rete
- **Causa:** C17 · **chiude:** iOS F3
- **File esclusivi:** `ios/App/App/*` (gestore `didFailProvisionalNavigation`),
  `src/app/auth/login/page.tsx`
- **Cosa fare:** ignorare `NSURLErrorCancelled (-999)` prima di mostrare `errorPath`; togliere il
  `router.refresh()` **immediatamente dopo** `router.replace` (4 occorrenze: :190-191, :221-222,
  :256-257, :264-265) — il replace porta già dati freschi, e la seconda navigazione **uccide la
  prima**.
- **Criterio:** 6 login consecutivi con `clearState: true` → **0 apparizioni** di «KIDVILLE NON È
  RAGGIUNGIBILE» (oggi 1 su 6).

### S29 — La bacheca del docente risolve l'id in nome
- **Causa:** C13 · **chiude:** iOS F4
- **File esclusivi:** `src/components/features/avvisi/AvvisoCard.tsx` (:83, :151-156)
- **Cosa fare:** risolvere l'identificativo in nome di sezione **con la stessa fonte della lista
  admin**, e mostrare un'etichetta neutra quando non è risolvibile (**mai** l'UUID). **A monte**:
  verificare quale percorso di scrittura archivia l'id in `target_classes`, così il dato torna
  omogeneo — è la coda dell'audit multi-sede.
- **Criterio:** nella bacheca docente, `grep` dell'UUID negli screenshot → 0 occorrenze; le card
  mostrano «TEST Infanzia» come nel cockpit.

### S30 — Gli header di sicurezza, il rate limit, il sigillo
- **Causa:** C14 · **chiude:** sicurezza W4, W5, W11 (promossi)
- **File esclusivi:** `next.config.ts`, `src/app/api/parent/forms/otp/route.ts`,
  `src/app/api/parent/presenze/giustifica/otp/route.ts`,
  `src/app/api/parent/primaria/note/firma/otp/route.ts`,
  `src/app/api/parent/primaria/pagella/firma/otp/route.ts`,
  `__tests__/architecture/header-sicurezza.test.ts` (nuovo)
- **Cosa fare:** `headers()` in `next.config.ts` con CSP, HSTS, X-Frame-Options,
  X-Content-Type-Options, **Referrer-Policy** e Permissions-Policy. La `Referrer-Policy` **non è
  cosmetica qui**: `src/middleware.ts` documenta esso stesso che «in questo repo il path **È** una
  credenziale» (`/m/<token>`) e che gli id dei minori sono segmenti di rotta — senza, quei token e
  quegli uuid viaggiano nell'header `Referer` **verso qualunque origine esterna**. Aggiungere
  `@/lib/security/rate-limit` alle 4 rotte OTP del genitore (è **già** usato in `forms/send-otp` e
  `public/cancellazione-account`). Rivedere `sealDangerous`, che dipende da `NODE_ENV`: in locale
  (`development` + `.env.local` **di produzione**) `/api/admin/wipe` e soci **non danno 404** e
  agiscono sul database vero — il margine è **un solo account admin**.
- **Criterio:**
  ```
  curl -sI localhost:3000/ | grep -ci 'referrer-policy\|x-frame-options\|x-content-type-options' → 3
  ```
  e 20 richieste OTP consecutive → almeno un **429**.

### S31 — I bucket dichiarano cosa accettano
- **Causa:** C14 · **chiude:** sicurezza W7, backend (gate MIME `avvisi/upload`)
- **Dipende da:** S17 (che tocca `avvisi/upload/route.ts` e `tasks/upload/route.ts`): **in
  sequenza, mai in parallelo**
- **File esclusivi:** `src/lib/allegati/mime.ts` (nuovo, il gate condiviso),
  `src/app/api/avvisi/upload/route.ts`, `src/app/api/tasks/upload/route.ts`,
  `supabase/migrations/<TS>_task_allegati_mime.sql`
- **Cosa fare:** `task_allegati` è **l'unico bucket con `allowed_mime_types = null`**: accetta
  qualunque MIME dichiarato dal client. Oggi lo Storage lo serve `text/plain` + `nosniff` (nessuna
  XSS), **ma la difesa è del provider, non nostra**. Dichiarare l'allowlist MIME in migrazione e un
  gate applicativo condiviso, così `avvisi/upload` smette di restituire
  `500 {"error":"mime type text/plain is not supported"}` dove serviva un **415**.
- **Migrazione:** scritta, **NON applicata**.
- **Criterio:** upload di un `.txt` su avvisi → **415** con messaggio comprensibile (oggi 500 col
  testo grezzo del provider).

### S32 — La chat esce dal modello del link eterno
- **Causa:** C14 · **chiude:** debug W3 (promosso)
- **File esclusivi:** `src/app/api/chat/upload/route.ts` (:23-25, :98),
  `src/app/api/chat/messages/route.ts`
- **Cosa fare:** la chat firma con **TTL di 365 giorni** e **salva l'URL firmato** in
  `chat_messages.attachment_url`: è **un link permanente travestito da link a scadenza**, cioè
  esattamente la forma da cui avvisi e task sono appena usciti. Salvare il **percorso**, firmare **al
  momento della lettura** con TTL breve, come fa ora `src/lib/allegati/storage.ts`.
- **Criterio:** `select attachment_url from chat_messages` sui messaggi nuovi → **percorsi, non URL
  firmati**; la lettura restituisce `…/object/sign/…?token=`.

### S33 — Le policy `using(true)` che sono per sezione
- **Causa:** C14 · **chiude:** sicurezza W6 (promosso)
- **File esclusivi:** `supabase/migrations/<TS>_policy_orario_per_sede.sql`,
  `__tests__/architecture/rls-policy-sede.test.ts`
- **Cosa fare:** 14 policy `using(true)` per `authenticated` sono leggibili in cross-sede da
  **qualunque** loggato. Due sono **per sezione**: `orario_settimanale` e
  `sezione_materia_obiettivo` — **oggi un genitore di Aversa legge l'orario delle classi di
  Giugliano**. Aggiungere il predicato di sede su queste due; per le altre 12 (campanelle, materie,
  menu, preset) **accettare la scelta e scriverla in un commento sulla policy** — una decisione
  scritta non è un buco.
- **Migrazione:** scritta, **NON applicata**.

### S34 — zod dichiara anche il massimo
- **Causa:** C16 · **chiude:** backend F1
- **File esclusivi:** `src/app/api/tasks/route.ts` → **collide con S08** → **va in sequenza dopo S08**
  (stesso file), più `src/app/api/tasks/[id]/route.ts` (**collide con S11** → dopo S11)
- **Cosa fare:** allineare gli schemi al DDL: `titolo: z.string().min(1).max(255)`,
  `target_class: z.string().max(50).nullable().optional()`; in subordine mappare l'errore Postgres
  **22001** (`string_data_right_truncation`) a **400** e **smettere di rigirare `error.message` al
  client** (contiene nomi di colonna e di vincolo).
- **Criterio:** `POST /api/tasks` con `titolo` da 100.000 caratteri → **400** con messaggio di
  validazione (oggi: `500 {"error":"value too long for type character varying(255)"}`).

### S35 — Le notifiche orfane e gli allegati non pubblicati
- **Causa:** C9 (coda) · **chiude:** i warning backend/frontend su notifiche e file orfani
- **File esclusivi:** `src/app/api/avvisi/[id]/route.ts` → **collide con S11** → **dopo S11**
- **Cosa fare:** `DELETE /api/avvisi/<id>` non tocca le notifiche già generate: al genitore resta una
  notifica che **punta a un avviso inesistente**. Rimuovere le righe `notifiche` con l'`entita_id`
  dell'avviso. E un file caricato nella modale e poi non pubblicato **resta nel bucket per sempre**:
  prevedere la rimozione (o un job di pulizia degli orfani).

### S36 — Il Service Worker non serve JS stantio in sviluppo
- **Causa:** ambiente (warning frontend, promosso perché **fa vedere un'app rotta che non è rotta**)
- **File esclusivi:** `public/sw.js`
- **Cosa fare:** non cachare `_next/static` in sviluppo. La cache `kidville-shell-v3` teneva una
  copia vecchia di un chunk (246.051 byte contro 256.678) e produceva
  `ReferenceError: setErroreElenco is not defined`, un errore di hydration e «NESSUN ALUNNO TROVATO»
  con 25 alunni a database — **sopravvivendo alla ricarica**. In produzione il rischio è minore (URL
  per build-id), ma `public/sw.js` **documenta già la stessa trappola** per `/offline`.
- **Ricorda:** una modifica a `sw.js` non arriva sui telefoni finché non si alza `VERSIONE`.

### S37 — `LOG_HASH_SALT` (azione operativa, non codice)
- **Causa:** C7 · **chiude:** log W2
- **File esclusivi:** `docs/env.md`
- **Cosa fare:** `app_log` contiene da **11 giorni** (dal 2026-07-20, ancora il 31/07 alle 13:24)
  `error | config | "variabile d'ambiente critica mancante: LOG_HASH_SALT" | ambiente=production`.
  Conseguenza: `hashCorrelabile` è **fail-closed** e senza salt restituisce `[redatto]` — la privacy
  è salva (si sbaglia nel verso giusto), ma la funzione «è sempre lo stesso genitore» **è spenta da
  undici giorni**. **Qui l'osservabilità ha fatto il suo mestiere e nessuno ha raccolto il segnale.**
  Impostare la variabile su Vercel (**solo il nome va nel repo, mai il valore**) e documentarla.
- **Criterio:** `select count(*) from app_log where evento='config' and creato_il > now() -
  interval '1 day' and messaggio like '%LOG_HASH_SALT%'` → **0** dopo l'impostazione.

### S38 — Residui dei collaudi da rimuovere
- **Causa:** igiene · **File esclusivi:** nessuno (azione operativa)
- **Cosa fare:** rimuovere i file di prova nello Storage (nessun dato personale: `.txt`, PDF vuoto,
  PNG 1×1, tre file da 23 byte «TEST-collaudo-sicurezza»). Postgres rifiuta la cancellazione diretta
  (`42501: Direct deletion from storage tables is not allowed`): serve la service key.
  ```
  curl -X DELETE "$NEXT_PUBLIC_SUPABASE_URL/storage/v1/object/task_allegati/<nome>" \
       -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
  ```
  Bucket coinvolti: `task_allegati` (4 file), `avvisi_allegati` (1), `news` (1).
  Valutare il ripristino di `scuole.updated_at` della sede E2E a `2026-07-10 12:14:48.157+00`.

---

## ONDATA 5 — chiusura

### S39 — Il collaudo finale si fa a REPO FERMO
- **Causa:** C18 (rilievo di metodo del tester debug, accolto)
- **Cosa fare — è uno step dell'orchestratore, non di un esecutore:**
  1. **Congelare l'albero**: nessun commit, nessun agente che scrive, per tutta la durata del
     collaudo. Il ciclo 2 è partito da `1a00c12` e si è chiuso su `a2e26e0`: **due commit sono
     entrati mentre gli 11 tester lavoravano**, quindi i verdetti **non si riferiscono tutti allo
     stesso albero**. Se il gate finale viene letto come «tutti verdi sullo stesso codice», è
     **un'assunzione non verificata**.
  2. Registrare lo **sha di HEAD** in `.claude/.ship-cycle/report-testers.json` e pretendere che ogni
     report lo citi.
  3. **Sbloccare le prove che erano bloccate:** aprire la sessione
     `test.multisede.admin@kidville.test` nella finestra di collaudo (design, a11y e localizzazione
     non hanno potuto misurare il selettore a tre sedi in pagina); pubblicare **un** avviso con
     allegato su una sezione `TEST *` **senza genitori agganciati** e cancellarlo a fine prova
     (frontend e log non hanno potuto verificare «l'allegato si apre»: 0 avvisi con `attachment_url`
     su 9).
  4. **Un solo profilo Chrome per tester**, o profili separati: in questo ciclo l'interfaccia è
     passata all'inglese a metà flusso, una tab è nata in Alto Contrasto e le tab si aprivano da
     sole. `read_console_messages`/`read_network_requests` sono **per-tab** e restano attendibili;
     **gli screenshot no**.
  5. **Collaudo nativo su `next start`**, mai su `next dev`: la WebView si ricarica da sola e svuota
     i campi.

### S40 — Il PRD
- **Causa:** AGENTS.md §2 — **un intervento non è completo se il PRD non è allineato**
- **File esclusivi:** `PRD REGISTRO ELETTRONICO.md`
- **Cosa fare:**
  - **Tabelle di stato in cima:** aggiornare Accessibilità, Privacy/GDPR, Sicurezza, Osservabilità,
    Localizzazione, Mobile nativo con lo stato reale dopo questo ciclo.
  - **Voce di changelog datata `2026-07-31`**, una sola voce che elenca: la primitiva `Modal`
    diventata un dialogo vero (15 componenti), i quattro lock che ora guardano la regola, i quattro
    gate che ora verificano l'oggetto e non solo il ruolo, l'oblio esteso alla tabella d'origine, i
    consensi fotografici per canale, il fuso dichiarato, i flow Maestro allineati all'albero reale.
  - **Debito dichiarato (non chiuso in questo ciclo, ma scritto):** i 452 messaggi d'errore italiani
    nelle route; l'allowlist dei catch muti col suo numero; il primario verde/giallo a 4,05:1
    (pattern di brand); le 12 policy `using(true)` accettate con motivazione; le **93 domande con
    `raccolta_senza_informativa = true`** (dati di minori raccolti prima che il modulo mostrasse
    l'informativa: **il flag documenta il problema, non lo chiude** — servono informativa postuma,
    cancellazione o annotazione nel registro delle violazioni, ed è una **decisione del titolare**).
  - **Nessuna PII** di famiglie o minori, e **nessun segreto**: il repository è pubblico.

---

## 5. Warning dei tester da NON ignorare (promossi a fix in questo piano)

| Warning | Perché è una bomba a orologeria | Step |
|---|---|---|
| Chat: TTL 365 giorni + URL firmato salvato in tabella | è **l'ultimo bucket** col modello da cui avvisi e task sono appena usciti | S32 |
| Cookie `sedi_attive` manomesso: 201 muto in scrittura | **stesso schema** che `3fea7b2` ha appena rimosso, sopravvissuto sul ramo accanto | S20 |
| uuid confrontato **case-sensitive** | nega scritture legittime **e** inquina il contatore di sicurezza | S20 |
| Nessun header di sicurezza | il middleware scrive che «il path **È** una credenziale»: senza `Referrer-Policy` i token escono nel `Referer` | S30 |
| `hashCorrelabile('')` costante | correla **persone diverse**: rende inaffidabile l'unica funzione per cui l'hash esiste | S18 |
| `LOG_HASH_SALT` mancante da 11 giorni | l'osservabilità ha fatto il suo mestiere e **nessuno ha raccolto il segnale** | S37 |
| Upload senza log di successo | **è l'ambiguità che ha nascosto il guasto delle email** | S17 |
| 35 righe per una `GET /api/avvisi` | un terzo delle 100 righe di Vercel bruciate quando serve leggere un incidente | S17 |
| `orario_settimanale` `using(true)` | un genitore di Aversa legge l'orario delle classi di Giugliano | S33 |
| `task_allegati` senza allowlist MIME | la difesa oggi è **del provider**, non nostra | S31 |
| `sealDangerous` dipende da `NODE_ENV` | in locale `/api/admin/wipe` agisce sul DB **vero**: il margine è un account | S30 |
| SW che serve JS stantio | **fa vedere un'app rotta che non è rotta**: brucia un collaudo intero | S36 |
| Password Maestro in chiaro su disco | è la password comune dei **41 account TEST in produzione** | S12 |
| `enrollment_submissions.credentials` | la colonna esiste ancora e le password in chiaro sono **nei backup** | S22 |
| 93 domande `raccolta_senza_informativa` | il flag **documenta** il problema, non lo chiude | S40 (decisione) |

**Warning verificati e SANI — da non smontare per sbaglio:**
- L'anello di focus globale (`globals.css:271`) funziona: le 171 `focus:outline-none` **non** lo
  uccidono perché la regola è fuori da ogni `@layer`.
- La deduplica `(impronta, giorno)` separa correttamente per utente e per rotta: il segnale di
  sicurezza non viene attribuito alla persona sbagliata.
- `prefers-reduced-motion` è rispettato.
- Il lock delle migrazioni **non è teatro**: lo sha256 ricalcolato dal registro di produzione
  coincide byte per byte con la fotografia versionata.
- 0 `toLocale*` senza locale, 0 `aria-label` cablati, 0 chiavi `t()` mancanti su 4800.
- **Nessuna PII di famiglie o minori nel repo**: 1188 identificatori forti dal DB di produzione
  incrociati con 2016 file → 13 occorrenze, **zero** riferite a famiglie o minori.

---

## 6. Feature pronte al commit SUBITO (non aspettano il resto del piano)

Queste hanno `PASS` su tutte le categorie che le riguardano, misurato e non dedotto:

1. **I bucket degli allegati sono davvero privati.** `curl` sull'endpoint pubblico di un file che
   esiste → `400 NoSuchBucket`; firma con chiave anon → 400; `object/list` → `[]`. Verificato da
   **sicurezza, privacy, backend e frontend** indipendentemente.
2. **La RLS dei pagamenti è guarita senza fuga.** Un genitore legge **1 riga su 98**, nessun `42P17`;
   un secondo genitore 0; `pagamenti_letti_di_altri = 0`. Né 0 (nega tutto) né 98 (fuga).
3. **Il 403 della sede dichiarata è inaggirabile.** 8 vettori (uuid maiuscolo, chiave JSON
   duplicata, array, spazi, cookie manomesso…) → 6× 403 + 2× 400 zod, **zero scritture fuori sede
   verificate a DB**.
4. **L'identità da header è sigillata**, in locale **e in produzione** (`401` con `x-user-id`).
5. **`/admin/students?tab=sections` non resta più appesa**: confermato su iOS 2/2 con lo stesso
   percorso del ciclo precedente, e sull'APK Android.
6. **L'isolamento fra sedi tiene sull'app nativa**: Aversa vede 2 alunni suoi, 6 sezioni sue, 0
   avvisi, nessuna traccia di Giugliano.
7. **Le 12 prove di validità degli esecutori sono TUTTE risultate vere** — nessuna
   asserzione-fantoccio nei test nuovi. **È l'opposto di quanto trovato il 30/07.**

---

## 7. Come si chiude il ciclo

1. Ondata 0 (in corso) → commit.
2. Ondata 1 (6 esecutori in parallelo) → commit **appena ogni step è verde**, senza aspettare gli altri.
3. Ondate 2, 3, 4 → idem.
4. **S39: si congela il repo.** Solo allora partono gli 11 tester.
5. **S40: il PRD.**
6. Gate: `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` · `npm run build`
   — tutti verdi **sullo stesso sha**. L'E2E Playwright si verifica **in CI**: `.env.local` punta al
   DB di **produzione** e il seed locale scriverebbe lì dentro.
7. **Le migrazioni si mostrano al titolare una per una. Nessuna viene applicata da questo piano.**
