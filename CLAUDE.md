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

Il comando fa **una sola cosa interattiva**: all'inizio ti fa **molte domande** (scope, casi
limite, cosa non toccare, priorità nei compromessi). **Dopo che hai risposto non si ferma più**:
gira in un ciclo chiuso finché non è verde o finché non esaurisce gli 8 cicli.

```
   ┌───────────────────────────────────────────────────────────────┐
   │  a. scrittore-di-piani   → piano (step, criteri, cosa NON toccare)
   │  b. esecutore-opus-1..N  → codice + migrazioni + env + logging
   │     (Dynamic Workflow lanciato con la keyword `ultracode`)
   │  c. 11 tester-opus       → in parallelo, un test ciascuno, report dettagliati
   │  d. scrittore-di-piani   → nuovo piano di correzione (per CAUSA RADICE)
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

| Agente | Modello | Ruolo |
|---|---|---|
| `scrittore-di-piani` | `claude-fable-5` | Scrive il piano e rielabora i report dei tester in un piano di correzione. Non scrive codice. |
| `esecutore-opus-1..N` | `claude-opus-4-8` · `xhigh` | Implementa. Con **migrazioni**, **variabili d'ambiente** (solo nomi) e **logging**. |
| `tester-opus-backend` | `claude-opus-4-8` · `xhigh` | Route, gate di ruolo, zod, PostgREST, migrazioni |
| `tester-opus-frontend` | idem | Rendering, hydration, stati, browser vero |
| `tester-opus-design` | idem | Token Clay Village: `#006A5F` · `#FDC400` · `#FEF1E4` |
| `tester-opus-debug` | idem | Causa radice, non il sintomo |
| `tester-opus-mobile-android` | idem | Percorso utente reale via **Maestro** su emulatore |
| `tester-opus-mobile-ios` | idem | Percorso utente reale via **Maestro** su simulatore |
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
├── commands/ship-cycle.md        l'orchestratore                  ← COMMITTATO
├── hooks/verify_gate.sh          il gate deterministico           ← COMMITTATO
├── maestro-flows/                4 flow nativi + README           ← COMMITTATO
├── settings.local.json           preferenze personali             ← ignorato da git
└── .ship-cycle/                  stato runtime del ciclo          ← ignorato da git
```

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

# ⚠️ PROMEMORIA PRE-LANCIO — riattivare la conferma umana

**Oggi la pipeline fa merge, deploy in produzione e migrazioni sul DB di produzione SENZA
chiedere conferma.** È accettabile per un solo motivo: **siamo pre-lancio**, e in produzione
non c'è ancora nessun dato reale di famiglie e bambini.

**Prima del lancio pubblico — e comunque PRIMA che entri anche un solo dato reale di una
famiglia o di un minore — vanno riattivate le conferme umane.** Concretamente:

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
5. **Dati reali** — da quel momento gli account TEST in produzione, i seed e qualunque
   scrittura automatica su prod vanno rivisti: quello che oggi è "pre-lancio, nessun danno"
   diventa "dati di minori".

Finché questo blocco è ancora qui, **il lancio non è avvenuto**. Quando lo fai, aggiorna anche
il PRD.
