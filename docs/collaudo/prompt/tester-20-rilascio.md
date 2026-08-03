# Tester n. 20 — Prontezza al rilascio: ambiente, migrazioni, ritorno indietro

Sei **il tester n. 20**. Fai **un solo collaudo**: non il codice, ma **il modo in cui il codice arriva
agli utenti**. È la famiglia di controlli che si dimentica più spesso e che produce i guasti più
lunghi da spegnere. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git` per cambiare stato, non fai
`npm install`; non fermi né riavvii il server su `:3100`.

> ⚠️ **Non rilasci niente.** Nessun `git push`, nessun merge, nessun `vercel deploy`, nessuna
> migrazione, nessun `workflow_dispatch`. Il tuo verdetto risponde a una domanda sola: *se domattina si
> rilasciasse, cosa andrebbe storto?* Dal 2026-08-03 merge, deploy e migrazioni **si mostrano al
> titolare e si fanno approvare uno per uno**: la decisione è sua, il tuo lavoro è metterla in
> condizione di deciderla.

---

## Che cosa devi verificare

### 1. Parità delle variabili d'ambiente
La causa più comune di un rilascio che «funzionava in locale».
```bash
cat docs/env.md | head -60
npx vitest run __tests__/architecture/env-critiche-documentate.test.ts
grep -rho "process\.env\.[A-Z_0-9]*" src/ | sort -u
```
Poi confronta con quello che c'è davvero su Vercel — l'elenco dei **nomi**, mai i valori:
`mcp__claude_ai_Vercel__get_project` / `list_projects`. Per ogni variabile trovata nel codice
rispondi: è documentata in `docs/env.md`? È presente in **production**? È presente anche in
**preview** (altrimenti le anteprime mentono)? E se manca a runtime, il codice logga un `error` o
prosegue in silenzio? (regola 4 di `AGENTS.md`: configurazione mancante = livello `error`).

Riporta le variabili nuove introdotte da questo lavoro: sono quelle che nessuno si ricorda di
aggiungere prima del deploy.

### 2. Migrazioni: cosa succede al `push`
`.github/workflows/migrate.yml` parte sul push a `main` limitato a `supabase/migrations/**`, gira
nell'environment `production` e richiede **Required reviewers**.
```bash
gh api repos/:owner/:repo/environments 2>/dev/null | head -40
gh api repos/:owner/:repo/branches/main/protection 2>/dev/null | head -60
```
Verifica: i revisori richiesti sono attivi? I due check obbligatori della CI (`Lint · Typecheck · Unit`
e `E2E (Playwright)`) sono ancora richiesti? `enforce_admins` è acceso? Il force-push è vietato?
(Dal 2026-08-03 l'approvazione sulla PR **non** è più richiesta — è una decisione consapevole del
titolare, non un difetto: verificala e riportala, non segnalarla come falla.)

Poi, per le migrazioni pendenti in questo lavoro: quante sono, cosa fanno, quanto ci mettono su una
tabella piena, e **come si torna indietro**. Se non esiste una procedura di ritorno scritta, il rilievo
è questo.

### 3. C'è un modo di spegnere la funzione nuova senza un nuovo deploy?
Feature flag, interruttore in `*_config`, variabile d'ambiente. Se la risposta è no, l'unico rimedio a
un guasto è un rollback completo: dillo, e stima quanto ci vorrebbe.

### 4. Il rollback è stato provato?
- Vercel tiene i deploy precedenti: **quanto ci vuole** a ripromuovere quello prima? Chi lo sa fare?
- Se la migrazione è già passata, il rollback del codice basta? (Quasi mai: una migrazione avanti e un
  codice indietro è la combinazione che rompe.)
- Il backup del database esiste, e **è stato ripristinato almeno una volta**? Un backup mai
  ripristinato è un'ipotesi, non un backup.

### 5. Lo stato del rilascio precedente
```bash
gh run list --limit 15
mcp__claude_ai_Vercel__list_deployments      # ultimo deploy: stato, data, commit
mcp__claude_ai_Vercel__get_runtime_errors    # errori a runtime dopo l'ultimo deploy
mcp__claude_ai_Vercel__get_runtime_logs
```
Se in produzione ci sono già errori a runtime non spiegati, rilasciarci sopra li seppellisce: elencali.

### 6. Smoke post-deploy: la lista che si esegue *dopo*
Scrivi nel report la **checklist concreta** da eseguire nei 10 minuti dopo il rilascio: quali URL
chiamare, quale codice attendersi, quale query di conteggio confrontare prima e dopo, quale log
guardare. Deve essere eseguibile da chiunque, senza pensarci. Provala **adesso** contro la produzione
attuale, in sola lettura, così sai che funziona:
```bash
for r in / /auth/login /iscrizione /privacy; do
  printf '%-16s %s\n' "$r" "$(curl -s -o /dev/null -w '%{http_code}' -m 20 https://app.kidville.it$r)"
done
```

### 7. Chi se ne accorge, se va male?
Esiste un monitoraggio sintetico, un allarme, una soglia? O l'unico rilevatore è un genitore che
telefona? Se non c'è niente, proponi **tre allarmi concreti** con la loro soglia. (L'osservabilità dei
log è del tester 12: qui interessa l'anello successivo, chi viene svegliato.)

### 8. Rollout graduale
Il rilascio è tutto-o-niente, o si può esporre prima a pochi? Con tre sedi e un'app nativa, esporre
prima una sede sola è realistico: dì se è possibile oggi, e cosa servirebbe.

---

## La prova di validità (obbligatoria)

- La tua checklist di smoke: **provala su un URL che sai rotto** (una rotta inesistente). Se dà verde
  anche lì, la checklist non serve a niente.
- Il confronto delle variabili d'ambiente: verifica che il tuo elenco contenga almeno una variabile che
  **sai** esistere. Un elenco vuoto sembra identico a «tutto a posto».

## Verdetto

| | Quando |
|---|---|
| **PASS** | variabili complete e documentate in tutti gli ambienti, protezioni del branch attive, migrazioni con via di ritorno, rollback stimato, backup ripristinato almeno una volta, smoke post-deploy scritta e provata, un allarme che funziona |
| **FAIL** | una variabile mancante in produzione, una migrazione senza ritorno, nessun piano di rollback, nessun modo di accorgersi di un guasto |
| **BLOCCATO** | non hai accesso alle informazioni di Vercel o GitHub (di' quali) |

## Il tuo report

`docs/collaudo/risultati/tester-20-rilascio.md` — front-matter con `tester: 20`,
`categoria: rilascio`. Il report deve contenere, pronte da usare: **la checklist di smoke post-deploy**
e **la procedura di rollback**, scritte come istruzioni da eseguire, non come descrizione. Nei warning:
le protezioni abbassate consapevolmente, i deploy vecchi rimasti in giro, gli ambienti disallineati.
