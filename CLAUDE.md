@AGENTS.md

---

# Pipeline `/ship-cycle` — ciclo autonomo di rilascio

Oltre alle regole di `AGENTS.md` (che restano la fonte di verità del progetto), questo repo
porta con sé una pipeline agentica **committata**: funziona identica su qualunque macchina e
con qualunque account Claude, senza riconfigurare niente.

## Come si invoca

```
/ship-cycle <obiettivo>
```

Esempio: `/ship-cycle aggiungi la giustifica dell'assenza con firma OTP del genitore`

## Cosa succede

Il **direttore d'orchestra è `fable-5`** (il modello del comando): fa il brainstorming, conduce
l'intervista, tiene insieme il loop e dà il via al rilascio. Il lavoro pesante è sul **modello
Opus più forte disponibile, sempre al massimo effort** (implementazione e collaudo) — oggi
`claude-opus-5` · `max`.

L'unica fase interattiva è all'inizio: prima la skill **`brainstorming`** di superpowers (esplora
l'intento), poi **l'intervista** a raffica (scope, casi limite, cosa non toccare, priorità).
**Dopo, gira da solo** finché non è verde o finché non esaurisce gli 8 cicli — con **una sola
eccezione**: in fase di correzione, se si incaglia o serve una decisione dell'utente, può rifare
il brainstorming e fare una domanda mirata (fare una domanda non conta come "fermarsi").

```
   0. brainstorming (superpowers) → intervista → si arma il gate
   ┌───────────────────────────────────────────────────────────────┐
   │  a. scrittore-di-piani   → piano (writing-plans; step, criteri, cosa NON toccare)
   │  b. esecutore-opus-1..N  → codice con TDD + migrazioni + env + logging
   │     (Dynamic Workflow `ultracode`; segue superpowers in tutto)
   │  c. 11 tester-opus       → in parallelo, un test ciascuno, report dettagliati
   │  d. scrittore-di-piani   → piano di correzione per CAUSA RADICE
   │     (se incagliato: rifà il brainstorming e può chiedere all'utente)
   │  e. commit immediato     → appena una feature è verde, senza aspettare il resto
   └──────────────────────────── ↺ ────────────────────────────────┘
```

**Goal continuo, senza digitare `/goal`:**
*tutti gli 11 tester-opus riportano `PASS` su ogni categoria — oppure stop dopo 8 cicli.*

Non è una promessa del modello: è **cablata**. L'hook `Stop` (`.claude/hooks/verify_gate.sh`)
gira a ogni tentativo di fermarsi, riesegue il gate formale (`eslint` · `tsc` · `vitest` ·
`build`) e legge i verdetti dei tester. Se qualcosa è rosso, **blocca lo stop** e rimanda al
lavoro. Il contatore si ferma a 8 blocchi: oltre, lascia passare. Fuori da un `/ship-cycle`
l'hook non fa nulla — le conversazioni normali non pagano pedaggio.

## Gli agenti

Il **comando stesso** (il direttore) gira su `claude-fable-5` e usa la skill `brainstorming`.

| Agente | Modello | Ruolo |
|---|---|---|
| `scrittore-di-piani` | `claude-fable-5` | Scrive il piano e i piani di correzione (skill `writing-plans`, `systematic-debugging`). Non scrive codice. |
| `esecutore-opus-1..N` | `claude-opus-5` · `max` | Implementa seguendo **superpowers** (skill `test-driven-development`, `systematic-debugging`, `verification-before-completion`). Con **migrazioni**, **variabili d'ambiente** (solo nomi) e **logging**. |
| `tester-opus-backend` | `claude-opus-5` · `max` | Route, gate di ruolo, zod, PostgREST, migrazioni |
| `tester-opus-frontend` | idem | Rendering, hydration, stati, browser vero |
| `tester-opus-design` | idem | Token Clay Village: `#006A5F` · `#FDC400` · `#FEF1E4` |
| `tester-opus-debug` | idem | Causa radice, non il sintomo |
| `tester-opus-mobile-android` | idem | Percorso utente reale via **Maestro** su emulatore (skill `maestro-mobile-testing`) |
| `tester-opus-mobile-ios` | idem | Percorso utente reale via **Maestro** su simulatore (skill `maestro-mobile-testing`) |
| `tester-opus-log` | idem | Log applicativi, e i warning che i test formali non colgono |
| `tester-opus-sicurezza` | idem | RLS, permessi Supabase, injection, auth bypass |
| `tester-opus-privacy` | idem | GDPR, dati di minori: cosa si logga, chi legge, retention |
| `tester-opus-localizzazione` | idem | Testi, date, layout, tenuta della lingua |
| `tester-opus-accessibilita` | idem | Contrasto, tastiera, screen reader |

Ogni tester fa **un solo test** e produce un report con: categoria · comandi/flow eseguiti ·
verdetto `PASS`/`FAIL`/`BLOCCATO` · fallimenti (cosa, dove `file:riga`/rotta/schermata, errore
esatto, causa radice, come riprodurre, cosa serve per sistemarlo) · **warning anche quando il
verdetto è PASS**.

## I file

```
.claude/
├── settings.json                 allowlist permessi + hook Stop   ← COMMITTATO
├── agents/                       13 agenti                        ← COMMITTATO
├── commands/ship-cycle.md        l'orchestratore (direttore fable-5) ← COMMITTATO
├── hooks/verify_gate.sh          il gate deterministico           ← COMMITTATO
├── skills/maestro-mobile-testing/  skill Maestro per i tester mobile ← COMMITTATO
├── maestro-flows/                4 flow nativi + README           ← COMMITTATO
├── settings.local.json           preferenze personali             ← ignorato da git
└── .ship-cycle/                  stato runtime del ciclo          ← ignorato da git
```

Il metodo di **superpowers** (plugin) è agganciato agli agenti col campo `skills:` del loro
frontmatter: `brainstorming` (il comando), `writing-plans`/`systematic-debugging` (piani),
`test-driven-development`/`verification-before-completion` (esecutori). La skill
`maestro-mobile-testing` è **committata nel repo** (adattata da `tovimx/maestro-mobile-testing-skill`
per la nostra WebView Capacitor), così la pipeline resta identica su ogni macchina.

Stato runtime (`.claude/.ship-cycle/`): `active.json` (gate armato + `session_id` + `max_cicli`),
`blocchi` (contatore), `report-testers.json` (i verdetti che l'hook legge), `gate.log`.

**Vie di fuga**, se il ciclo va storto:
- `touch .claude/.ship-cycle/pausa` → l'hook smette di bloccare (resta armato).
- `rm -rf .claude/.ship-cycle` → gate disarmato del tutto.

## Vincoli d'ambiente che la pipeline conosce (e rispetta)

- **`.env.local` punta al DB di PRODUZIONE.** Perciò `npm run e2e` e `npm run e2e:seed` in
  locale sono in **`deny`**: il seed scriverebbe dentro il database di produzione. L'E2E si
  verifica **in CI**.
- **Le migrazioni si applicano con lo strumento MCP `apply_migration`** + `get_advisors`
  (0 ERROR). `migrate.yml` resta in attesa del baseline dello storico migrazioni.
- **Il DB E2E della CI è un progetto separato e non è migrato**: il codice nuovo deve degradare
  in modo pulito (PostgREST `PGRST204` su INSERT/UPDATE, `42703` su SELECT).
- **Il repository è pubblico**: mai segreti, mai PII reali di famiglie o bambini in codice,
  test, PRD o messaggi di commit.

---

# «Tu sei il tester n. X» — kit di collaudo manuale in chat separate

Accanto a `/ship-cycle`, che gira da solo in una chat sola, il repo porta un **kit di collaudo
manuale**: venti collaudi indipendenti, ognuno in una **chat diversa**, lanciati insieme.

**Quando l'utente apre una chat e scrive «tu sei il tester n. 7»** (o «tester 7», «sei il tester
sette»), non fare domande e non improvvisare: apri `docs/collaudo/README.md`, poi
`docs/collaudo/prompt/tester-07-*.md`, e segui quel file alla lettera. Vale per i numeri da **01 a
20**; l'indice completo è nel README.

Le tre cose che valgono per ogni tester, e che non si derogano:

- **è un collaudo in sola lettura**: non si scrive codice, non si usa `git`, non si fa
  `npm install`, sul database di produzione si fanno **solo `SELECT`**, e nell'interfaccia si
  naviga senza salvare (il server locale `:3100` parla col DB di **produzione**);
- **le chat girano insieme sullo stesso albero di lavoro**: un `git checkout` o un `npm install`
  sabota le altre diciannove. La suite intera e `npm run build` sono del tester 01, l'emulatore
  Android del 14, il simulatore iOS del 15;
- **il report va in `docs/collaudo/risultati/tester-NN-<slug>.md`**, uno solo, il proprio — cartella
  esclusa da git perché può contenere estratti del database di produzione. Nel report mai dati
  personali, mai segreti: conteggi, uuid e codici d'errore.

Alla fine, `docs/collaudo/SINTESI.md` contiene il prompt che unisce i venti report in una lista
unica di difetti, deduplicata e ordinata, da cui parte la correzione.

---

# 🔴 IN PRODUZIONE CI SONO DATI REALI DI MINORI — le conferme umane vanno riattivate

**Questo blocco, fino al 2026-07-31, diceva il falso.** Sosteneva che merge, deploy e migrazioni
potessero girare senza conferma perché *«siamo pre-lancio, e in produzione non c'è ancora nessun
dato reale di famiglie e bambini»*.

**Misurato il 2026-07-31**: la tabella `enrollment_submissions` contiene **227 domande di
iscrizione vere**, con **152 codici fiscali distinti di minori**, allergie e note mediche in testo
libero, raccolte **dal 16 luglio**. Il modulo pubblico riceve circa **9 invii l'ora**. Il lancio
commerciale non è avvenuto, ma i dati sono arrivati lo stesso: nessuno aveva riletto questo
promemoria da quando il modulo pubblico è andato online.

**La lezione, prima delle istruzioni**: «pre-lancio» è una frase sul calendario, non una
misurazione. L'unica domanda che conta è *quante righe reali ci sono adesso in produzione*, e ha
una risposta che si ottiene con una query. Chi legge questo file e sta per scrivere in produzione
la esegua, invece di fidarsi di questo paragrafo.

**Decisione del titolare (2026-07-31): da qui in avanti ogni migrazione e ogni merge si mostrano
e si fanno approvare, uno per uno.** Vale anche per gli `UPDATE`/`DELETE` sui dati veri. Le
verifiche in lettura restano libere.

Le conferme umane vanno riattivate così:

1. **`.claude/settings.json`** — sposta da `allow` ad `ask`:
   `Bash(gh:*)` (o almeno `Bash(gh pr merge:*)`), `Bash(git push:*)`, `Bash(vercel:*)`,
   `mcp__supabase__apply_migration`, `mcp__supabase__execute_sql`.
2. **`.claude/settings.json`** — riporta `permissions.defaultMode` da `acceptEdits` a `default`.
3. **`.claude/commands/ship-cycle.md`** — nel **Caso 1 (RILASCIO)** rimetti una conferma umana
   esplicita prima di: merge, deploy in produzione, migrazioni sul DB di produzione.
   L'autorizzazione oggi citata nel comando (*"senza conferma, siamo pre-lancio, nessun dato
   reale"*) **decade** in quel momento e va rimossa dal file.
4. **GitHub** — riattiva i *Required reviewers* sull'environment `production`
   (workflow `.github/workflows/migrate.yml`), così nessuna migrazione tocca il DB senza
   un'approvazione umana.
5. **Dati reali** — gli account TEST in produzione, i seed e qualunque scrittura automatica su
   prod vanno trattati come ciò che sono: strumenti che toccano **dati di minori**. In
   particolare `test.segreteria@kidville.test` legge l'anagrafica dell'intera sede, e
   `test.multisede.admin@kidville.test` vede tutte e tre le sedi.

**Stato di questi cinque punti: applicati il 2026-08-03 come ultimo atto del rilascio della PR #62
(`fc7c94a`, deploy Vercel `READY` su `app.kidville.it`) e ⚠️ REVOCATI LO STESSO GIORNO** — vedi il
riquadro «REVOCATO» qui sotto, che è la parte da leggere per prima.

| | Dove si verifica |
|---|---|
| 1. cinque permessi da `allow` ad `ask` | `.claude/settings.json` → `permissions.ask` |
| 2. `defaultMode` da `acceptEdits` a `default` | `.claude/settings.json` |
| 3. autorizzazione «pre-lancio» rimossa dal comando | `.claude/commands/ship-cycle.md`, Caso 1 |
| 4. *Required reviewers* sull'environment `production` | era **già attivo**: verificato via API, revisore `erricoluigi17` |
| 5. account TEST trattati come strumenti su dati di minori | password ruotata il 31/07, log Maestro bonificati il 02/08 |

### 🔻 REVOCATO il 2026-08-03 — le conferme sono durate un giorno

**I cinque punti qui sopra sono stati revocati dal titolare il 2026-08-03**, poche ore dopo essere
stati applicati e nel mezzo del collaudo dei venti tester. Richiesta testuale: *«far sì che vada
tutto in automatico quando sono in automode»*, e alla domanda esplicita su cosa dovesse passare
senza conferma la risposta è stata **«proprio tutto, migrazioni e merge compresi»**.

Quindi, da oggi e finché qualcuno non riscrive questo blocco:

- `Bash(gh:*)` · `Bash(git push:*)` · `Bash(vercel:*)` · `mcp__supabase__apply_migration` ·
  `mcp__supabase__execute_sql` sono in **`allow`**, non più in `ask`;
- `permissions.defaultMode` torna a **`acceptEdits`**;
- **migrazioni, merge, deploy e scritture sul database di produzione non chiedono più conferma.**

**Cosa questo significa, detto una volta e senza giri di parole**: `execute_sql` e
`apply_migration` in `allow` vogliono dire che un agente può eseguire `UPDATE` e `DELETE`, e
cambiare lo schema, sul database che al 2026-08-03 contiene **227 domande di iscrizione vere, 152
codici fiscali di minori, allergie e note mediche in testo libero** — senza che nessun essere umano
veda l'istruzione prima che parta. Non è un'ipotesi: è la definizione di ciò che è stato concesso.
La `deny` resta intatta (niente `rm -rf`, niente `git push --force`, niente `db reset`, niente
lettura dei file `.env`), ma la `deny` non protegge da una query sbagliata: protegge da un comando
distruttivo *noto*.

**Perché è scritto qui invece che nascosto**: fino al 2026-07-31 questo stesso file sosteneva il
falso per due settimane — diceva «pre-lancio, nessun dato reale» mentre arrivavano 9 domande
l'ora. La lezione pagata allora è che *un documento che descrive una protezione che non c'è più è
peggio di nessun documento*. Chi legge questo blocco e sta per scrivere in produzione non si fidi
del paragrafo: **esegua la query che conta le righe reali**, e sappia che nessuno gli chiederà
conferma prima di eseguirla.

**Come si torna indietro**, se un giorno serve: rimettere i cinque nomi sotto `permissions.ask` in
`.claude/settings.json`, riportare `defaultMode` a `default`, e togliere
`mcp__supabase__execute_sql` / `mcp__supabase__apply_migration` dall'`allow` di
`~/.claude/settings.json` e di `.claude/settings.local.json` — che li contengono **entrambi**, ed è
il motivo per cui le conferme del 2026-08-03 non sarebbero comunque mai scattate (rilievo `T19-F1`
del collaudo, che quel giorno era stato scritto come «grave» e la misura ha confermato).

⚠️ **Una protezione è stata ABBASSATA nello stesso rilascio, ed è giusto che si sappia**: su `main`
non è più richiesta un'approvazione sulla PR (decisione del titolare del 2026-08-03 — l'unico
account con accesso in scrittura è il suo, e GitHub non permette di approvare la propria PR, quindi
la regola bloccava ogni rilascio senza aggiungere un controllo vero). **Restano** obbligatori i due
check della CI (`Lint · Typecheck · Unit` ed `E2E (Playwright)`), `enforce_admins`, il divieto di
force-push e di cancellazione del branch.

Quando il lancio commerciale avverrà davvero, aggiorna anche il PRD.
