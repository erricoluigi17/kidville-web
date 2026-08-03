# Tester n. 01 — Gate formale e catena di build

Sei **il tester n. 01**. Fai **un solo collaudo**: la catena di verifica automatica — lint, tipi,
test unitari, build, dipendenze. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git` (nemmeno `checkout` o `stash`), non fai
`npm install`; sul database di produzione **solo `SELECT`**; niente `npm run e2e*` né
`npx playwright test`; niente dati personali né segreti nel report (il repo è pubblico); non fermi né
riavvii il server su `:3100`. Altre chat stanno lavorando sullo stesso albero adesso.

**Sei l'unico autorizzato** a lanciare la suite intera e la build: gli altri 19 tester non possono.
Falle presto, così il resto della macchina resta libero.

---

## Che cosa devi verificare

### 1. I quattro comandi del gate
```bash
npx eslint . --max-warnings 0     # deve uscire 0 errori E 0 warning
npm run typecheck                 # tsc --noEmit — copre ANCHE __tests__/, che build e vitest non toccano
npx vitest run                    # ~674 file, ~6300 test
npm run build                     # deve finire senza errori
```
Per ciascuno riporta: **codice di uscita**, tempo, e il conteggio esatto (file/test/errori). Se
qualcosa è rosso, riporta l'output **letterale** del primo fallimento, non il riassunto.

> `npm run typecheck` è il comando che qui è già sfuggito: la CI fa `tsc --noEmit` sui test, mentre
> `npm run build` e `vitest` in locale **no**. Un errore di tipo dentro `__tests__/` passa in locale
> e spacca la CI. Lanciarlo è metà del tuo lavoro.

### 2. Il conteggio dei test non deve scendere
L'ultima misura registrata è **673 file / 6308 test** (`PRD REGISTRO ELETTRONICO.md`, changelog del
2026-08-02). Se oggi ne conti **meno**, qualcuno ha cancellato o disabilitato dei test: è un rilievo,
non una curiosità. Cerca anche i test spenti:
```bash
grep -rn "\.skip\|\.todo\|xit(\|xdescribe(" __tests__/ | head -50
grep -rn "eslint-disable" src/ | wc -l
```

### 3. I lock architetturali sono vivi
Sono 59 file in `__tests__/architecture/` e sono la memoria dei difetti già pagati. Verifica che
girino tutti e che nessuno sia stato indebolito:
```bash
npx vitest run __tests__/architecture
ls __tests__/architecture | wc -l          # atteso 59
```
Guarda in particolare `zod-coverage`, `logging-coverage`, `isolamento-sede-coverage`,
`gate-coverage`, `niente-password-nel-repo`, `migrazioni-complete`.

### 4. Dipendenze e ambiente
```bash
npm audit --omit=dev            # vulnerabilità che arrivano in produzione
npm outdated | head -30
node -v && cat .nvmrc           # .nvmrc dice 22, la CI usa 22: se la tua Node è diversa, è un rilievo
```
Una vulnerabilità `high`/`critical` in una dipendenza di produzione è **grave**; in una devDependency
è **minore** (motivalo).

### 5. Peso della build
Dall'output di `npm run build` prendi la tabella delle rotte e riporta: le **5 pagine con il First
Load JS più alto**, il valore dello *shared bundle*, e ogni rotta sopra **300 kB**. Non esiste un
budget dichiarato nel repo: se manca, dillo nei warning — un budget assente è il motivo per cui il
peso cresce senza che nessuno se ne accorga.

### 6. Smoke: si accende?
Con il server già in ascolto su `:3100` (non riavviarlo):
```bash
for r in / /auth/login /iscrizione /privacy /termini /assistenza /offline /cancellazione-account; do
  printf '%-28s %s\n' "$r" "$(curl -s -o /dev/null -w '%{http_code}' -m 20 http://localhost:3100$r)"
done
```
Attese: le pagine pubbliche `200`, le pagine protette `307` verso il login. Un `500` o un `404`
inatteso è un fallimento.

---

## La prova di validità (obbligatoria)

Prima di scrivere `PASS`, dimostra che questi controlli **saprebbero** fallire. Senza toccare file
del repo:

```bash
# ESLint vede davvero un console.log in src/? (la regola no-console è il presidio del logging)
echo 'console.log("x")' | npx eslint --stdin --stdin-filename src/finto.ts
#   → deve stampare un errore no-console. Se tace, il gate del logging è cieco.

# tsc vede davvero un errore di tipo?
D=$(mktemp -d); printf 'const n: number = "stringa"\n' > "$D/x.ts"
npx tsc --noEmit --strict "$D/x.ts"; rm -rf "$D"
#   → deve stampare TS2322.
```
Scrivi nel report l'esito di entrambe.

---

## Verdetto

| | Quando |
|---|---|
| **PASS** | i quattro comandi verdi, conteggio test non sceso, lock tutti presenti e verdi, nessuna vulnerabilità alta in produzione, smoke tutto atteso, prova di validità superata |
| **FAIL** | anche uno solo rosso, o test spariti, o un lock disattivato |
| **BLOCCATO** | un comando non termina o l'ambiente non lo permette — di' quale e perché |

## Il tuo report

`docs/collaudo/risultati/tester-01-gate.md` — front-matter con `tester: 01`, `categoria: gate`.
Nei **warning** finiscono: i warning di build, le `eslint-disable` sparse, i test spenti, le
dipendenze vecchie, il budget di bundle assente, e ogni numero che si allontana da quello dichiarato
nel PRD.
