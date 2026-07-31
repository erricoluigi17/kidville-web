# PROMPT ATOMICO — chiudere l'audit multi-sede del 2026-07-31

> Copia **tutto** il contenuto fra le righe di separazione in una sessione nuova di
> Claude Code aperta su `/Users/lerri/kidville-web`. È auto-contenuto: non serve
> aver letto la conversazione precedente.

---

Sei sul repo `/Users/lerri/kidville-web`, branch **`fix/multisede-audit-globale`**.
Parla e scrivi **in italiano**. Leggi subito `AGENTS.md` e `CLAUDE.md`: le loro
regole valgono su tutto ciò che segue e non sono negoziabili.

## Dove siamo

Il 2026-07-29 sono state aperte due sedi nuove: la produzione è passata da **una**
scuola (Kidville Giugliano) a **tre** (+ Aversa, + Cesa), più la sede fittizia
`e2e00000-…` su cui gira la CI. Il 31/07 è stato fatto un audit globale: 140
rilievi, cinque ondate di correzione, sette collaudi su undici. È tutto committato
e il gate è verde (**542 file, 4689 test**, eslint 0, tsc 0, build ok).

Ultimo commit: `51f9bcb`. **Non è stato ancora fatto il merge.**

Leggi, in quest'ordine, prima di toccare qualsiasi cosa:
1. `docs/audit/2026-07-31-audit-globale-multisede.md` — i 140 rilievi con la prova
2. `docs/superpowers/plans/2026-07-31-multisede-audit-globale.md` — il piano (13 famiglie, 29 step)
3. `git log --oneline 2fb0a1d..HEAD` — cosa è già stato fatto, un commit per ondata

## Regola che vale su tutto: **niente scritture su produzione senza chiedere**

`CLAUDE.md` porta ancora un promemoria che autorizza merge, deploy e migrazioni
senza conferma umana, e la ragione scritta è *«siamo pre-lancio, in produzione non
c'è ancora nessun dato reale di famiglie e bambini»*.

**Quel presupposto è FALSO ed è stato misurato il 31/07**: la tabella
`enrollment_submissions` contiene le domande di iscrizione di **oltre 200 famiglie
vere**, con 152 codici fiscali distinti di minori, allergie e note mediche in testo
libero, raccolte dal 16 luglio. Il modulo pubblico riceve ~9 invii l'ora.

Il titolare ha deciso il 31/07: **da qui in avanti ogni migrazione e il merge si
mostrano e si fanno approvare, uno per uno.** Scrivi la migrazione, spiegala in
italiano semplice (cosa fa, cosa NON fa, cosa succede se va storto), aspetta il sì.
Vale anche per gli `UPDATE`/`DELETE` sui dati veri.

Aggiornare il blocco «PROMEMORIA PRE-LANCIO» di `CLAUDE.md` è **il punto 8 di
questo lavoro**: oggi quel testo dice il falso.

---

# COSA MANCA — otto blocchi

Sono indipendenti fra loro salvo dove indicato. Il gate (`npx eslint . --max-warnings 0`,
`npx tsc --noEmit`, `npx vitest run`, `npm run build`) deve restare verde dopo ognuno.

## 1. I quattro collaudi non ancora lanciati

Girano con gli agenti `tester-opus-<categoria>` già presenti in `.claude/agents/`.
Il server di sviluppo è su **http://localhost:3000** e parla col **DB di produzione**.

| Categoria | Cosa deve guardare su QUESTA modifica |
|---|---|
| `design` | Il selettore di sede, il chip sede nella topbar mobile e i badge «Sede» rispettano i token Clay Village (`#006A5F` · `#FDC400` · `#FEF1E4`) e non usano hex letterali |
| `accessibilita` | Contrasto, tastiera, screen reader sui pezzi nuovi. **Parti da un difetto già noto**: la modale `AvvisoForm` non ha `role="dialog"` né `aria-modal`, e su Android non compare affatto nell'albero di accessibilità (TalkBack non la legge). Il bottone di chiusura è 32×32 px e senza `aria-label` |
| `localizzazione` | I testi nuovi in IT **e** EN (namespace next-intl): il 400 «Specificare la sede», la checklist di provisioning, i badge «Sede», «Anteprima non disponibile» della galleria |
| `debug` | **Rifai le prove di validità** dichiarate dagli esecutori: campionane almeno 5, rimetti il bug, verifica che il test diventi rosso. È il controllo sul controllo — il 30/07 due test si erano dichiarati verdi senza guardare niente |

**Account di collaudo** (produzione, password `Kidville1`):
`test.segreteria@kidville.test` (Giugliano, 25 alunni veri) · `test.aversa.segreteria@kidville.test` ·
`test.cesa.segreteria@kidville.test` · `test.aversa.docente@kidville.test` · `test.cesa.docente@kidville.test`.

⚠️ **Dei 57 utenti in produzione uno solo — l'admin del titolare — ha più di una sede.**
Con gli altri il selettore di sede **non deve comparire**: è corretto. Il ramo
multi-sede non è quindi collaudabile end-to-end senza le credenziali del titolare.
Dichiaralo come limite invece di inventarti un account.

Scrivi i verdetti in `.claude/.ship-cycle/report-testers.json`, formato:
`{"report":[{"categoria":"design","verdetto":"PASS"}, …]}` — 11 categorie:
backend, frontend, design, debug, mobile-android, mobile-ios, log, sicurezza,
privacy, localizzazione, accessibilita. Le sette già fatte sono elencate lì dentro.

## 2. L'Anagrafica che resta bloccata (trovato dal collaudo iOS)

**File**: `src/app/(dashboard)/admin/students/page.tsx` — righe 50, ~240, ~390.

Dal dettaglio di una sezione, «← Tutte le sezioni» porta a
`/admin/students?tab=sections`. La pagina monta con `isLoading = true` e **nessuno
lo spegne**: `setIsLoading(false)` vive solo dentro `fetchStudents`/`fetchParents`/
`fetchStaff`, e con `viewType === 'sections'` nessuna delle tre parte. Lo spinner
«Caricamento anagrafica…» resta per sempre. Riaprire dal menu **non ripara**: è la
stessa rotta, il componente non si rimonta. Bisogna uscire e rientrare.

Riprodotto 2 volte su 2 sul simulatore. **Preesistente** (identico su `main`), ma è
una schermata morta su un percorso quotidiano della segreteria.

Fix: inizializzare lo spinner in funzione del tab, o spegnerlo nel ramo `sections`.
Una riga. Serve un test che monti la pagina con `?tab=sections` e verifichi che lo
spinner sparisca.

## 3. La sede dichiarata fuori scope viene ignorata invece che negata (collaudo backend, F2)

**File**: `src/lib/auth/scope.ts`, `resolveScuolaScrittura`, riga ~160.

```ts
if (preferita && set.has(preferita)) return { scuolaId: preferita }
// …e se `preferita` NON è accessibile? Si tira dritto: cookie → unica sede.
```

Se il client dichiara una sede a cui non ha accesso, il resolver **non nega**:
decade a «non dichiarata» e scrive **altrove**, con `200/201` e senza log. Misurato:
`POST /api/mensa/alternative` con `scuola_id` di Cesa da un utente di Aversa →
`200`, riga scritta su **Aversa**. Idem `POST /api/gallery`.

Il difetto è **noto e tamponato route per route**: `src/app/api/news/digest/genera/route.ts:47-58`
lo documenta e aggiunge un `if (scuola_id && sw.scuolaId !== scuola_id) → 403`.
Ma su **46 file che chiamano `resolveScuolaScrittura` (64 chiamate) solo 4** fanno
quel confronto.

Fix: spostare il controllo **dentro** `resolveScuolaScrittura` — `preferita`
presente e non accessibile ⇒ **403 «Sede non accessibile»** + log `warn`, mai
ripiego — e togliere i tamponi locali. Incoerenza da sanare: in lettura
`restringiASedeRichiesta` risponde già 403.

⚠️ Il test `__tests__/lib/auth/scope.test.ts` **cristallizza il comportamento
sbagliato** («sede dichiarata NON accessibile ⇒ ignorata»): va riscritto, non
aggirato. Rileggi il caso e cambialo con la motivazione nel commento.

## 4. Le migrazioni che vivono solo in produzione (collaudo backend, F4)

`supabase/migrations/` **non ricostruisce il database**. Sei versioni sono applicate
e non hanno un file nel repo:

```
20260730141828  registro_orario_unique_per_sede
20260730143833  modulistica_sede_su_modelli_e_compilazioni
20260730144035  modulistica_backfill_sede_compilazioni_storiche
20260730151739  locker_config_per_sezione
20260731075502  iscrizione_consents_log
20260731114828  presenze_armadietto_scuola_id_revoke
```

Il contenuto si recupera da
`select statements from supabase_migrations.schema_migrations where version = '…'`
(strumento MCP `execute_sql`, sola lettura). Il nome del file deve portare il
**timestamp realmente applicato**, non uno inventato.

Poi scrivi un **lock architetturale** che fallisca quando un file manca o quando
l'ordine dei nomi non riflette l'ordine di applicazione. Modello:
`__tests__/architecture/migrazioni-senza-sede-cablata.test.ts`.

Impatto oggi: nessuno sul servizio. Pieno su ricostruzione del DB, ambiente E2E e
disaster recovery.

## 5. Il documento d'audit del 30/07 dichiara chiuse cose che non lo erano (step W5-D, mai eseguito)

**File**: `docs/audit/2026-07-30-isolamento-fra-sedi.md`, nuovo lock
`__tests__/architecture/inventario-audit-verita.test.ts`.

Dodici voci sono marcate CHIUSA e `git log` dice che quei file non erano mai stati
toccati (righe 71, 94, 95, 97, 98, 108, 117, 118, 137, 158). Alcune sono state
chiuse **davvero** il 31/07. Per ognuna: `git log --oneline -- <file>` + lettura del
codice attuale, e poi
- se è chiusa davvero → riallinea citando il **commit vero**;
- se non lo è → la voce torna **APERTA**. Mai giustificare con «per intenzione».

Correggi anche le righe 164-175 (vincolo del registro orario: è chiuso, cita il
numero di migrazione) e annota le **verifiche negative** dell'audit del 31/07 —
cose che sembravano rotte e non lo erano — così il prossimo audit non rifà il
lavoro.

Il lock: estrae dal markdown le route marcate CHIUSA e verifica che superino il
criterio di `__tests__/architecture/isolamento-sede-coverage.test.ts` (o stiano
nella sua allowlist con la ragione).

Dettaglio nel piano, righe 907-922.

## 6. I due difetti del collaudo mobile

**Android — il flow committato è rotto** (`.claude/maestro-flows/android-percorso-segreteria.yaml:98`).
`tapOn: "Mensa"` non naviga: nell'albero di accessibilità della WebView esistono
**due** nodi «Mensa» — la scorciatoia della dashboard (fuori viewport, altezza 0,
schiacciata a `y=1857`) e il tab vero della bottom-nav. Maestro prende il primo e
tocca un'area morta. **L'app è sana**: `tapOn: { point: "68%,93%" }` funziona.
Stessa causa sul tap «Anagrafica» nel bottom-sheet.
Fix: disambiguare nel flow (punto, `childOf` la nav, o `aria-label` univoco sui 4
tab), e per lo sheet ancorarsi al sottotitolo `"Alunni, famiglie e personale"`.

**Android/iOS — la modale «Nuovo avviso» non esiste per lo screen reader**
(`src/components/features/avvisi/AvvisoForm.tsx:274-289`). Il contenitore non ha
`role="dialog"`, `aria-modal`, `aria-labelledby` né focus-trap; il contenuto
retrostante non è `inert`. Su Android l'albero di accessibilità continua a esporre
solo la pagina sotto. `AdminMenuSheet.tsx` è invece esposto correttamente: usalo da
modello. Il bottone di chiusura è `w-8 h-8` senza `aria-label`.

Correlato (warning del collaudo Android): il tasto **Indietro** non chiude gli
overlay, naviga indietro nella cronologia — con la modale aperta si perde l'avviso
che stavi scrivendo (`src/lib/mobile/native-shell.ts:47-50`). E la bottom-nav è
`z-50` come la modale, quindi **copre** il bottone «Pubblica avviso».

## 7. Quattro cose piccole, ognuna con la sua ragione

- **`avvisi_allegati` e `task_allegati` sono bucket PUBBLICI** (`storage.buckets.public = true`).
  `gallery` è stato chiuso il 31/07 con link firmati (`src/lib/gallery/storage.ts`
  è il modello da riusare). In `avvisi_allegati` c'è 1 file. **Chiedi al titolare**
  prima di chiuderli: cambia il comportamento degli allegati per i genitori.
- **Il bucket `news` non esiste ancora** in produzione, e `api/news/upload` lo
  creerebbe **pubblico** con `getPublicUrl`. Per un blog può andare — ma è una
  decisione da prendere, non da subire.
- **`gallery` ha `file_size_limit` 50 MB, il codice ne chiede 200.** Finora
  invisibile perché nessuno guardava l'esito di `updateBucket`; da oggi si vede nei
  log. Un video oltre 50 MB verrebbe rifiutato.
- **`pagamenti` ha una ricorsione infinita nelle policy RLS** (`42P17`, misurato:
  un genitore che legge `pagamenti` in RLS riceve un errore). Le policy
  `parent read pagamenti figli (parents space)` e `parent read quote figli (parents space)`
  si richiamano a vicenda. **Preesistente.** Non è una fuga (nega con errore), ma le
  sottoscrizioni realtime del genitore su pagamenti/incassi passano di lì.
- **`test_table`** è una tabella residua vuota nel DB di produzione: va rimossa.
- **Debito dichiarato da W5-A**: `tasks:GET` e `tasks:POST` sono in allowlist perché
  `task_interni.scuola_id` è nullable e la bacheca interna è ancora mono-sede.
  `POST /api/tasks` scrive `scuola_id: auth.user.scuola_id`, cioè il ripiego che
  l'audit dichiara eliminato. Serve migrazione (NOT NULL + backfill) +
  `resolveScuolaScrittura`.

## 8. Chiusura e rilascio

1. **`CLAUDE.md`** — il blocco «⚠️ PROMEMORIA PRE-LANCIO» dice il falso: riscrivilo
   con quanto misurato il 31/07 (dati reali in produzione dal 16 luglio) e applica i
   suoi stessi punti 1-5, che oggi sono ancora da fare.
2. **PRD** — più esecutori hanno aggiunto una voce di changelog ciascuno il 31/07:
   **consolidale in una sola**, datata, senza PII e senza uuid di produzione.
3. **Gate completo verde** + tutte le 11 categorie `PASS` in
   `.claude/.ship-cycle/report-testers.json`.
4. **PR** e attesa della CI (che gira `tsc --noEmit` sui `__tests__` e l'E2E
   Playwright: entrambi non girano in locale).
   ⚠️ Il segreto GitHub **`CI_E2E_PASSWORD`** è stato creato il 31/07 e serve al
   seed E2E: se la CI fallisce lì, è quello.
5. **Merge — CHIEDI CONFERMA AL TITOLARE.**
   🔴 `main` ha `required_approving_review_count: 1` + `enforce_admins: true`: con un
   solo sviluppatore **nessuna PR è mergiabile**. Serve abbassare temporaneamente:
   `gh api -X PATCH repos/erricoluigi17/kidville-web/branches/main/protection/required_pull_request_reviews -F required_approving_review_count=0`
   e **rimetterlo a 1 subito dopo**.
6. Verifica il deploy Vercel, elimina i branch secondari (locali e remoti: `main`
   deve restare l'unico), disarma il gate con `rm -rf .claude/.ship-cycle`.

---

## Vincoli d'ambiente da rispettare sempre

- **`.env.local` punta al DB di PRODUZIONE.** Mai `npm run e2e` né `npm run e2e:seed`
  in locale: il seed scriverebbe dentro il database di produzione. L'E2E si verifica
  in CI. Sui dati veri: **sola lettura**; le prove che scrivono si fanno solo sugli
  oggetti «TEST *» delle sedi Aversa e Cesa.
- **Il DB E2E della CI è un progetto separato e NON è migrato**: il codice nuovo deve
  degradare pulito (PostgREST `PGRST204` su INSERT/UPDATE, `42703` su SELECT).
- **Il repository è PUBBLICO**: mai segreti, mai PII reali di famiglie o bambini in
  codice, test, PRD, documenti d'audit o messaggi di commit.
- **`utenti.role`** è una colonna generata da `ruolo`: non scriverla mai.
- Le migrazioni si applicano con lo strumento MCP `apply_migration` + `get_advisors`
  (0 ERROR) — **dopo l'approvazione del titolare** — e il file corrispondente va
  scritto nel repo con il **timestamp realmente applicato**.

## Metodo (superpowers, non negoziabile)

- **test-driven-development**: prima il test che fallisce, poi il codice.
- **PROVA DI VALIDITÀ**: ogni test va dimostrato **rosso** rimettendo il difetto e
  **verde** dopo. Se non l'hai dimostrato, il test non conta.
  **Vietate** le asserzioni-fantoccio tipo `expect(res.status).not.toBe(403)` come
  controllo positivo: è la forma esatta dei due falsi verdi del 30/07.
  Ogni asserzione negativa vuole un **controllo positivo** accanto, altrimenti una
  pagina che non carica affatto passa il test.
- **verification-before-completion**: prima di dichiarare fatto, lancia i comandi e
  riporta l'output vero.
- Le asserzioni che contano sono sulla **mutazione** (nessuna riga scritta, RPC mai
  invocata), non solo sullo status: un 403 con la scrittura comunque avvenuta è un
  falso verde.

## Due cose imparate il 31/07 che ti risparmiano ore

1. **`banned_until = 'infinity'` rompe l'API admin di Supabase Auth.** È un timestamp
   valido per Postgres, l'`UPDATE` non protesta, ma GoTrue non riesce a
   serializzarlo: `auth.admin.listUsers()` fallisce sull'**intera pagina** che
   contiene quel record, con un errore il cui `message` è `undefined`. Effetto:
   `ensureParentIdentity` si rompe e l'onboarding genitori va fuori uso. Usa una data
   lontana ma rappresentabile (`2999-12-31`).
2. **Un lock che guarda il FILE invece dell'HANDLER non protegge niente.** Il vecchio
   `isolamento-sede-coverage` cercava l'import di `@/lib/auth/scope` in cima al file:
   un import amnistiava tutti i metodi HTTP sotto. Così `attendance/daily` aveva la
   GET protetta e la POST nuda — una segreteria poteva segnare presenze sui bambini
   di un'altra sede — e il lock restava verde. Ora è riscritto per span di esecuzione
   (1233 righe): se aggiungi una route, il test dei numeri (272/432/111) diventa
   rosso apposta, perché quella decisione deve passare sotto gli occhi di qualcuno.
