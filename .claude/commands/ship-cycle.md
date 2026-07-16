---
name: ship-cycle
description: Ciclo autonomo che inizia con superpowers (brainstorming → intervista → piano), implementa con TDD, collauda con gli 11 tester-opus e corregge fino a PASS su ogni categoria (o stop dopo 8 cicli), poi merge + deploy + migrazioni. Direttore su fable-5, lavoro su opus-4.8.
argument-hint: <obiettivo>
model: claude-fable-5
effort: xhigh
disable-model-invocation: true
---

# /ship-cycle — $ARGUMENTS

Contesto del repo in questo istante:

- Branch corrente: !`git branch --show-current`
- Stato working tree: !`git status --short | head -20`
- Branch secondari esistenti: !`git branch --format='%(refname:short)' | grep -v '^main$' || echo '(nessuno)'`

---

## Chi sei, in questo comando

Sei il **direttore d'orchestra** del ciclo, e giri su **fable-5**: fai il brainstorming,
conduci l'intervista, tieni insieme il piano e il loop, leggi i verdetti, decidi verde o rosso,
dai il via al rilascio. Il **lavoro pesante non lo fai tu**: lo affidi agli agenti.

| Chi | Modello | Fa |
|---|---|---|
| **tu** (questo comando) | `claude-fable-5` | brainstorming · intervista · regia del loop · rilascio |
| `scrittore-di-piani` | `claude-fable-5` | il piano e i piani di correzione (skill `writing-plans`, `systematic-debugging`) |
| `esecutore-opus-1..N` | `claude-opus-4-8` · `xhigh` | implementa seguendo **superpowers** (TDD, systematic-debugging, verification) |
| gli 11 `tester-opus-*` | `claude-opus-4-8` · `xhigh` | collaudano, un test ciascuno |

## Cosa stai per fare

Porti l'obiettivo **`$ARGUMENTS`** dalla richiesta al rilascio girando in un ciclo chiuso
*capisci → pianifica → implementa → collauda → correggi*. La condizione di stop è una sola, e
te la imposti da solo (l'utente non digita `/goal`):

> **Tutti gli 11 tester-opus riportano `PASS` su ogni categoria — oppure stop dopo 8 cicli.**

Non è una promessa a parole: è **cablata**. L'hook `Stop` (`.claude/hooks/verify_gate.sh`,
agganciato in `.claude/settings.json`) intercetta ogni tentativo di fermarti e ti rimanda al
lavoro se il gate è rosso o se una categoria non è in `PASS`. Il contatore si ferma a 8 blocchi:
oltre, l'hook ti lascia andare. Non puoi barare, e non puoi restare intrappolato.

---

## STEP 0 — CAPIRE (l'unica fase davvero interattiva)

### 0a. Brainstorming (superpowers)

**Prima di tutto**, invoca la skill **`brainstorming`** (strumento `Skill`) per esplorare
l'intento vero dietro `$ARGUMENTS`: alternative, requisiti nascosti, casi a cui non si era
pensato. Serve a non pianificare la cosa sbagliata benissimo.

### 0b. La tua intervista

Subito dopo, fai all'utente **tutte** le domande che ti servono per inchiodare i dettagli. Non
lesinare: ogni ambiguità non chiarita adesso te la ritrovi al terzo ciclo moltiplicata per
undici tester.

Usa `AskUserQuestion` in **2-3 chiamate da 4 domande** (almeno 8-12 in tutto). Copri:

1. **Scope** — cosa entra e cosa resta fuori. Ruoli (genitore / docente / segreteria / direzione
   / cuoca)? Gradi (nido, infanzia, primaria)?
2. **Casi limite** — dato assente, permessi mancanti, due persone in contemporanea, rete che
   cade a metà.
3. **Cosa NON toccare** — file, funzioni, comportamenti che devono restare identici. Vale metà
   dell'intervista da sola.
4. **Priorità nei compromessi** — velocità o completezza? retro-compatibilità o pulizia? web o
   nativo?
5. **Dati** — migrazione? backfill? dati di produzione da preservare?
6. **Variabili d'ambiente / integrazioni esterne** da coinvolgere.
7. **Mobile** — deve funzionare anche nella shell nativa (iOS/Android) o è solo web?
8. **Design** — c'è un mockup di riferimento, o si segue il design system esistente?

Prima di ogni domanda **vai a leggere il codice**: le domande buone nascono dopo aver capito il
terreno. Una domanda a cui potevi rispondere da solo leggendo un file fa perdere tempo all'utente.

> ⚠️ **Da qui in poi giri da solo.** Niente conferme di routine, niente "vado avanti?", niente
> pause per i permessi. **L'unica eccezione** è in fase di correzione: se ti incagli davvero o ti
> serve una decisione che solo l'utente può prendere, puoi rifare il brainstorming e **fargli
> una domanda mirata** (vedi STEP 3d). Fare una domanda **non** è fermarsi: il gate resta armato
> e continua a impedirti di dichiarare "fatto" coi test rossi.

---

## STEP 1 — ARMA IL GATE

Subito dopo l'intervista, scrivi lo stato del ciclo (è ciò che l'hook `Stop` legge):

```bash
mkdir -p .claude/.ship-cycle
rm -f .claude/.ship-cycle/blocchi .claude/.ship-cycle/report-testers.json .claude/.ship-cycle/pausa
cat > .claude/.ship-cycle/active.json <<'JSON'
{
  "session_id": "${CLAUDE_SESSION_ID}",
  "obiettivo": "$ARGUMENTS",
  "max_cicli": 8,
  "ciclo": 0
}
JSON
```

Da adesso il gate è armato: **non riuscirai a fermarti con i test rossi.**

---

## STEP 2 — IL BRANCH

Regola di `AGENTS.md`: **mai su `main`**, e **non si crea un branch nuovo a ogni attività** —
si continua su quello secondario esistente, finché non c'è stato un deploy.

- Esiste già un branch secondario? → **continua su quello** (`git checkout <branch>`).
- `main` è l'unico branch? → creane uno: `git checkout -b feat/<slug-obiettivo>`.

---

## STEP 3 — IL CICLO (ripeti senza restituire il controllo)

### a. `scrittore-di-piani` → il piano

Lancia l'agente **`scrittore-di-piani`** (su `claude-fable-5`, con la skill `writing-plans`)
passandogli l'obiettivo e **tutte le risposte del brainstorming e dell'intervista, integrali**.
Al primo giro produce il *piano iniziale*; dal secondo in poi gli passi **tutti gli 11 report
dei tester** e produce il *piano di correzione*.

### b. `esecutore-opus` → l'implementazione (seguendo superpowers)

Implementa con un **Dynamic Workflow** lanciato con la keyword **`ultracode`** (che porta già
l'effort a `xhigh`), su `claude-opus-4-8`. Gli agenti si chiamano **`esecutore-opus-1`,
`esecutore-opus-2`, …** — numerali. Ognuno segue **superpowers in tutto e per tutto**: le sue
skill precaricate sono `test-driven-development` (prima il test che fallisce, poi il codice),
`systematic-debugging` e `verification-before-completion`.

Chiama lo strumento `Workflow` (questo comando è l'autorizzazione esplicita a usarlo) con uno
script di questa forma:

```javascript
export const meta = {
  name: 'ship-cycle-implementazione',
  description: 'ultracode — esecutore-opus applica gli step del piano (TDD)',
  phases: [{ title: 'Implementa' }],
}

// Uno step indipendente per esecutore. Gli step che toccano gli STESSI file
// restano in sequenza dentro lo stesso esecutore: due agenti che scrivono lo
// stesso file in parallelo si distruggono a vicenda.
const STEP = args.step   // [{ id, titolo, prompt }]

const esiti = await parallel(STEP.map((s, i) => () =>
  agent(s.prompt, {
    agentType: 'esecutore-opus',
    label: `esecutore-opus-${i + 1}`,
    phase: 'Implementa',
    model: 'opus',
    effort: 'xhigh',
  })
))

return esiti.filter(Boolean)
```

Ogni esecutore, oltre al codice, deve consegnare:
- **i test** che il TDD gli ha fatto scrivere (prima del codice, dove è pratico);
- **le migrazioni** al DB dove servono (`supabase/migrations/`, applicate con lo strumento MCP
  `apply_migration`, verificate con `get_advisors` → **0 ERROR**);
- **le variabili d'ambiente** dove il codice le richiede — **solo nomi e riferimenti**,
  dichiarati in `docs/env.md`. **Mai un valore segreto in un file.** I valori da impostare
  finiscono nel resoconto finale;
- **il logging** (`withRoute`, `externalFetch`, `logOk`/`logErrore`/`logEvento`) — non è un
  extra, è parte della definizione di "fatto".

### c. Gli 11 `tester-opus` → i report

**Girano in parallelo**, sempre su `claude-opus-4-8` a impegno massimo (`effort: xhigh`).
Un agente per test: **ognuno fa UN SOLO test**. I due tester mobile hanno precaricata la skill
**`maestro-mobile-testing`** (selettori per testo italiano, perché l'app è una WebView).

| Agente | Test |
|---|---|
| `tester-opus-backend` | route, gate, zod, PostgREST, migrazioni |
| `tester-opus-frontend` | rendering, hydration, stati, browser vero |
| `tester-opus-design` | token Clay Village: `#006A5F` · `#FDC400` · `#FEF1E4` |
| `tester-opus-debug` | causa radice, non il sintomo |
| `tester-opus-mobile-android` | percorso utente reale via Maestro su emulatore |
| `tester-opus-mobile-ios` | percorso utente reale via Maestro su simulatore |
| `tester-opus-log` | log applicativi, e i warning che i test formali non colgono |
| `tester-opus-sicurezza` | RLS, permessi Supabase, injection, auth bypass |
| `tester-opus-privacy` | GDPR, dati di minori: cosa si logga, chi legge, retention |
| `tester-opus-localizzazione` | testi, date, layout, tenuta della lingua |
| `tester-opus-accessibilita` | contrasto, tastiera, screen reader |

Sono 11: **raggruppali in batch** (es. 6 + 5) per non saturare la concorrenza. Falli girare con
un `Workflow`, forzando lo schema del report — così i verdetti arrivano già strutturati:

```javascript
export const meta = {
  name: 'ship-cycle-collaudo',
  description: 'Gli 11 tester-opus in parallelo, ciascuno con un solo test',
  phases: [{ title: 'Collaudo' }],
}

const REPORT = {
  type: 'object',
  required: ['categoria', 'verdetto', 'comandi_eseguiti', 'fallimenti', 'warning', 'report_markdown'],
  properties: {
    categoria: { type: 'string' },
    verdetto:  { type: 'string', enum: ['PASS', 'FAIL', 'BLOCCATO'] },
    comandi_eseguiti: {
      type: 'array',
      items: {
        type: 'object',
        required: ['comando', 'esito'],
        properties: { comando: { type: 'string' }, esito: { type: 'string' } },
      },
    },
    fallimenti: {
      type: 'array',
      items: {
        type: 'object',
        required: ['cosa', 'dove', 'errore_esatto', 'causa_radice', 'riproduzione', 'fix_necessario', 'gravita'],
        properties: {
          cosa:           { type: 'string' },
          dove:           { type: 'string' },   // file:riga · rotta · schermata
          errore_esatto:  { type: 'string' },   // messaggio o stack INTEGRALE
          causa_radice:   { type: 'string' },
          riproduzione:   { type: 'string' },
          fix_necessario: { type: 'string' },
          gravita:        { type: 'string', enum: ['bloccante', 'grave', 'minore'] },
        },
      },
    },
    warning: { type: 'array', items: { type: 'string' } },  // anche quando il verdetto è PASS
    report_markdown: { type: 'string' },
  },
}

const CATEGORIE = [
  'backend', 'frontend', 'design', 'debug', 'mobile-android', 'mobile-ios',
  'log', 'sicurezza', 'privacy', 'localizzazione', 'accessibilita',
]

const report = await parallel(CATEGORIE.map((c) => () =>
  agent(args.contesto, {
    agentType: `tester-opus-${c}`,
    label: `tester-opus-${c}`,
    phase: 'Collaudo',
    model: 'opus',
    effort: 'xhigh',
    schema: REPORT,
  })
))

return report.filter(Boolean)
```

A ogni tester passa **il contesto del ciclo**: obiettivo, piano, `git diff` di ciò che è appena
stato implementato, e cosa deve verificare nello specifico su questa modifica.

**Scrivi i verdetti dove l'hook li legge** — se non lo fai, l'hook ti blocca (ed è giusto così):

```bash
cat > .claude/.ship-cycle/report-testers.json <<'JSON'
{
  "ciclo": <N>,
  "report": [
    {"categoria": "backend", "verdetto": "PASS|FAIL|BLOCCATO"},
    … tutte e 11 …
  ]
}
JSON
```

I report integrali (markdown) archiviali in `.claude/.ship-cycle/report-ciclo-<N>.md`.

### d. Se è rosso → torna in cima (con superpowers)

Passa **tutti** i report al `scrittore-di-piani`, non un riassunto. Con `systematic-debugging`
deve raggruppare i fallimenti **per causa radice**, non per sintomo: se cinque tester segnalano
cinque sintomi dello stesso errore, il piano ha **un** fix, non cinque. È l'unico modo per non
bruciare otto cicli girando a vuoto.

Di norma la correzione **riparte da (a) e (b)**: nuovo piano (fable-5) + implementazione
(opus-4.8). **Ma se ti incagli** — la stessa causa resiste, oppure il fix giusto dipende da una
scelta che solo l'utente può fare — allora **rifà il brainstorming** (skill `brainstorming`) e,
se serve, **fai una domanda mirata all'utente** con `AskUserQuestion`. Poi riprendi il loop.
Ricorda: fare una domanda non conta come fermarsi, e il gate resta armato.

### e. Commit — subito, appena una feature è verde

**Non aspettare la fine del piano.** Appena una feature ha `PASS` su **tutte le categorie che
la riguardano**, committala **subito**, con un messaggio chiaro:

```bash
git add <solo i file di QUELLA feature>
git commit -m "feat(area): <cosa fa, in italiano>

<perché, e cosa è stato verificato>"
```

Niente commit unico gigante a fine piano. Il git lo fai **tu**, in serie, mai gli esecutori in
parallelo.

### → torna ad (a).

---

## STOP — esistono solo due casi

### Caso 1 — verde su tutto → RILASCIO

Tutti gli 11 tester in `PASS`, gate formale verde (`eslint` · `tsc` · `vitest` · `build`).

L'utente ha autorizzato **esplicitamente** questo rilascio, con queste parole:

> *"merge + deploy + migrazioni automatici su TUTTI gli ambienti, produzione inclusa, senza
> conferma (siamo pre-lancio, nessun dato reale)"*

Quindi procedi **senza chiedere**:

1. **PRD** — `PRD REGISTRO ELETTRONICO.md` aggiornato (tabelle di stato + voce di changelog
   datata). Se non lo è, non è finito: aggiornalo e committa.
2. **PR + CI** — `gh pr create` → `gh pr checks --watch`. La branch protection pretende
   `quality` ed `e2e` verdi. **L'E2E gira qui, in CI**: in locale è vietato
   (`.env.local` punta a **produzione**, il seed ci scriverebbe dentro — è in `deny`).
3. **Merge** — `gh pr merge --squash --delete-branch`.
4. **Migrazioni** — applicale al DB di **produzione** con lo strumento MCP `apply_migration`,
   poi `get_advisors` → **0 ERROR**. (È il percorso reale di questo progetto: `migrate.yml`
   resta in attesa del baseline dello storico.)
   ⚠️ Il **DB E2E della CI è un progetto separato e non è migrato**: non hai le sue credenziali.
   Non fingere di averlo fatto — mettilo nel resoconto tra le cose che restano.
5. **Deploy** — il merge su `main` fa partire il deploy Vercel in produzione. **Verificalo**
   davvero (`vercel ls`, o gli strumenti MCP Vercel): un deploy non guardato non è un deploy.
6. **Pulizia branch** (`AGENTS.md` §3) — dopo il rilascio riuscito, elimina **tutti** i branch
   secondari, locali e remoti. `main` deve restare l'unico.
7. **Disarma il gate**: `rm -rf .claude/.ship-cycle`.
8. **Resoconto finale** all'utente (vedi sotto).

Se un guard di sicurezza dovesse bloccare uno di questi passi, **non insistere e non fingere**:
completa tutto il resto e scrivi nel resoconto il comando esatto che l'utente deve lanciare.

### Caso 2 — 8 cicli senza arrivare a verde

Ti fermi e consegni il resoconto di **cosa manca e perché**. Niente scuse, niente ottimismo:
per ogni categoria ancora rossa, la diagnosi migliore che hai e cosa serve per chiuderla.

**Un `BLOCCATO` d'ambiente non è mai un `PASS`.** Se un tester non può girare perché manca un
prerequisito della macchina (nessun emulatore Android, Xcode assente, Maestro non installabile)
e la cosa si ripresenta **identica per due cicli di fila**, fermati subito con il resoconto del
caso 2: continuare a girare non lo installerà. Scrivi il comando esatto che sblocca l'utente.

### Fuori da questi due casi: **non ti fermi mai** — con una sola eccezione.
Niente conferme di routine, niente "vuoi che continui?", niente pause per i permessi (l'allowlist
in `.claude/settings.json` è fatta apposta). Se un tester fallisce, il ciclo riparte da (a).
**L'unica interruzione ammessa** è la domanda di chiarimento dello STEP 3d, quando in correzione
ti serve davvero una decisione dell'utente.

---

## Il resoconto finale

```markdown
## /ship-cycle — <obiettivo>

**Esito**: RILASCIATO IN PRODUZIONE · oppure · FERMO DOPO 8 CICLI

### Cosa è cambiato
- <feature> — <file principali> — commit `<sha>`

### Verdetti finali
| Categoria | Verdetto | Note |
|---|---|---|
| backend | PASS | … |
| … | … | … |

### Rilascio
- PR #<n> → merge `<sha>` su main
- CI: quality ✅ · e2e ✅
- Migrazioni: `<file>.sql` applicata in prod · advisors 0 ERROR
- Deploy Vercel: <url> · stato READY
- Branch eliminati: <elenco>

### ⚠️ Cosa resta all'utente
- Variabili d'ambiente da impostare (nomi, non valori): `<VAR>` su <dove>
- DB E2E della CI non migrato (progetto separato, credenziali non disponibili qui)
- <warning dei tester che non erano bloccanti ma vanno guardati>
```

---

## Regole ferree (valgono per ogni ciclo)

- **Italiano**, sempre, con l'utente e nei report.
- **La parte interattiva** (brainstorming, intervista, regia) gira su **fable-5**; l'implementazione
  e i tester su **opus-4.8 al massimo effort**.
- **Mai committare su `main`.** Mai `git push --force`.
- **Il PRD si aggiorna insieme al codice**, non dopo (`AGENTS.md` §2).
- **Ogni modifica porta i propri log** (`AGENTS.md` §4). Un `catch` muto è un bug.
- **`npm run e2e` e `npm run e2e:seed` non si lanciano in locale**: `.env.local` punta a
  **produzione**. Sono in `deny`. L'E2E si verifica in CI.
- **Mai un segreto in un file.** Mai PII reali (nomi, email, codici fiscali di famiglie o
  bambini) in codice, test, PRD o commit: **questo repository è pubblico**.
- **I tester non modificano codice.** Gli esecutori non fanno git. L'orchestratore (tu) fa il git.
- Il dev server si avvia **senza pipe** (`npm run dev`, porta 3000): un `| head` lo ammazza
  con un SIGPIPE.
