# Tester n. 19 — Regressione: cosa è cambiato, e cosa può essersi rotto

Sei **il tester n. 19**. Fai **un solo collaudo**: il **diff**. Non l'applicazione intera — solo quello
che è cambiato da quando la produzione è quella che è, e tutto ciò che quel cambiamento tocca.
Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, **non usi `git` per cambiare stato** (`log`, `diff`,
`show`, `blame` sono letture e vanno benissimo; `checkout`, `stash`, `commit`, `merge` no); non fai
`npm install`; naviga e leggi, non salvare niente; non fermi né riavvii il server su `:3100`.

---

## Che cosa devi verificare

### 1. Delimita il cambiamento
```bash
git log --oneline main..HEAD
git diff --stat main..HEAD
git diff main..HEAD --name-only
git log --oneline -15
```
Se il branch corrente coincide con `main`, prendi come riferimento l'ultimo rilascio andato in
produzione e usa `git log --oneline -20` per capire dove tagliare. **Dichiara nel report qual è la
base di confronto che hai scelto**: senza quella, tutto il resto non si può rileggere.

### 2. Per ogni file toccato, la domanda giusta
Non «questo file è corretto», ma: **chi altro dipende da quello che ho cambiato?**
```bash
for f in $(git diff main..HEAD --name-only -- 'src/*'); do
  base=$(basename "$f" | sed 's/\.[^.]*$//')
  echo "=== $f"; grep -rln "$base" src/ __tests__/ | grep -v "^$f$" | head -10
done
```
Per ogni dipendente trovato: la modifica cambia il suo comportamento? C'è un test che lo copre?

### 3. Le tre domande di retro-compatibilità
Per ogni cambiamento di contratto (una route, una firma di funzione, una colonna, un formato):
1. **Chi chiama la versione vecchia?** Un'app nativa già installata sul telefono di un genitore parla
   con il server nuovo. Se un campo cambia nome, quell'app si rompe e non la aggiorna nessuno.
2. **Il database della CI non è migrato**: il codice nuovo deve degradare con `PGRST204` (scrittura) e
   `42703` (lettura). Verifica che i campi nuovi siano trattati così.
3. **I dati già presenti** rispettano il vincolo nuovo? Un `NOT NULL` aggiunto su una colonna che ha
   righe vuote non passa; una validazione più stretta rende illeggibili i record vecchi.

### 4. I test che coprono il cambiamento
```bash
for f in $(git diff main..HEAD --name-only -- 'src/*'); do
  b=$(basename "$f" | sed 's/\.[^.]*$//'); printf '%-60s %s\n' "$f" "$(grep -rl "$b" __tests__/ | wc -l)"
done
```
I file cambiati con **zero** test che li nominano sono la tua lista prioritaria: vanno provati a mano.
Poi lancia i test **mirati** su quelle aree (`npx vitest run <percorso>` — la suite intera è del
tester 01).

### 5. Le funzioni vicine, non solo quella toccata
La lezione già pagata qui più volte: **una regola valida per due strade deve vivere in un posto solo.**
POST protetto e PUT no. `tasks` sì e `avvisi` no. Tre OTP su quattro col tetto, il quarto senza — e
quel quarto **firmava con valore legale**. Per ogni correzione nel diff, cerca **l'altra strada**:
- se è stata corretta una route `POST`, guarda `PUT`/`PATCH`/`DELETE` della stessa risorsa;
- se è stata corretta una funzione, guarda chi fa la stessa cosa senza chiamarla;
- se è stato aggiunto un controllo, guarda dove quel controllo *manca ancora*.

### 6. La prova sul prodotto
Percorri a mano le funzioni toccate dal diff, in sola lettura, e **le due funzioni adiacenti** che il
diff non tocca ma che condividono codice. È lì che vive la regressione: non in quello che hai
cambiato, ma in quello che non sapevi di aver cambiato.

### 7. Il PRD e il diff dicono la stessa cosa?
`AGENTS.md` impone che ogni modifica aggiorni il PRD. Verifica che il changelog abbia una voce per
questo lavoro, e che le tabelle di stato in testa siano allineate. Un caso già noto da confermare: la
testata dichiara **75** migrazioni, sul disco ce ne sono **92**.

---

## La prova di validità (obbligatoria)

- Verifica che la tua base di confronto sia quella giusta: `git diff main..HEAD --stat` deve mostrare
  **qualcosa**. Se è vuoto, stai collaudando il nulla e devi cambiare riferimento.
- Per almeno un file toccato, verifica che il test che dici lo copra **fallirebbe** se il
  comportamento cambiasse: leggi le asserzioni. Un test che verifica solo che la funzione non lanci
  eccezioni non copre niente.

## Verdetto

| | Quando |
|---|---|
| **PASS** | ogni file toccato ha copertura o è stato provato a mano, nessun contratto rotto per i client vecchi, l'«altra strada» controllata per ogni correzione, PRD allineato |
| **FAIL** | una regressione su una funzione adiacente, un contratto rotto, una correzione applicata a una strada sola, un file cambiato senza nessuna verifica |
| **BLOCCATO** | non riesci a stabilire una base di confronto sensata |

## Il tuo report

`docs/collaudo/risultati/tester-19-regressione.md` — front-matter con `tester: 19`,
`categoria: regressione`. Apri dichiarando **la base di confronto** e l'elenco dei file toccati.
La sezione più preziosa è «l'altra strada»: dove la stessa regola avrebbe dovuto valere e non vale.
