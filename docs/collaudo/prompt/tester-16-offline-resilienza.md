# Tester n. 16 — Offline e resilienza

Sei **il tester n. 16**. Fai **un solo collaudo**: cosa succede quando qualcosa non c'è — la rete, un
provider esterno, il database. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; naviga e leggi,
non salvare niente; non fermi né riavvii il server su `:3100`.

> ⚠️ **Si simulano i guasti dal lato del browser, non si rompe niente per davvero.** Non si spegne il
> database, non si revoca una chiave, non si satura un provider. Tutti i guasti si inducono
> intercettando le richieste nel browser (`page.route`) o staccando la rete del contesto.

---

## Che cosa devi verificare

### 1. Il service worker
Sta in `public/sw.js`. Cose da sapere prima di aprire un difetto:
- la versione è `const VERSIONE = 'v4'` (**riga 131**), e alla riga sotto c'è
  `IMPRONTA-PAGINA-OFFLINE: <hash>` — l'impronta della pagina `/offline`, che va rialzata **insieme**
  alla versione;
- **una modifica a `/offline` non arriva sui dispositivi finché non si alza `VERSIONE`**. È la trappola
  che qui ha già fatto sembrare rotto un fix che funzionava;
- si serve dalla cache **solo** ciò che la risposta dichiara immutabile (`immutable`, o `max-age` ≥ 1
  giorno); il resto è rete-prima-cache-di-riserva;
- **mai in cache** (riga 146): `/api/`, `/m/` (il path contiene un token, cioè una credenziale) e
  `/auth/callback`;
- le richieste RSC **non** si intercettano (difeso da `__tests__/offline/sw.test.ts`);
- **non esiste un manifest PWA** in questo progetto: l'installabilità passa dalla shell Capacitor. Non
  segnalarlo come mancanza, semmai verifica che nessuna pagina lo dia per scontato.

```bash
npx vitest run __tests__/offline
npx vitest run __tests__/architecture/sw-versione-offline.test.ts
npx vitest run __tests__/architecture/offline-etichette-rotte.test.ts
npx vitest run __tests__/architecture/offline-html-nativo.test.ts
grep -n "VERSIONE\|IMPRONTA-PAGINA-OFFLINE" public/sw.js | head
```

### 2. Offline vero, nel browser
Carica l'app, poi stacca la rete (`await context.setOffline(true)`) e prova:
- ricaricare la pagina corrente → deve comparire il guscio, non l'errore del browser;
- navigare verso una rotta già visitata → dalla cache;
- navigare verso una rotta mai visitata → la pagina `/offline`, con **le etichette giuste** (il lock
  `offline-etichette-rotte` verifica che coprano le rotte reali: controlla che sia vero anche per le
  rotte aggiunte di recente);
- chiamare un'API → deve fallire in modo pulito, con un messaggio, non con una pagina bianca;
- **tornare online**: l'app si riprende da sola, o serve un ricaricamento a mano?

Verifica anche il badge/indicatore di offline (`ui/OfflineBadge.tsx`): compare, e sparisce quando deve?

### 3. I provider esterni caduti
Intercetta e fai fallire, uno alla volta, le chiamate verso l'esterno: email (Resend), push
(FCM/APNs), fatturazione (Aruba/SDI), SIDI, embed Instagram. Per ognuno:
- l'utente vede un messaggio sensato, o la funzione muore in silenzio?
- il log registra il **corpo** dell'errore, non solo lo status? (è la regola 3 di `AGENTS.md`, nata da
  un `403` loggato senza corpo che ha tenuto le email ferme per mesi);
- c'è un tentativo di ripetizione, o una coda? E se non c'è, il fallimento è visibile a qualcuno?

L'embed Instagram ha un *health-check* «best-effort»: verifica cosa succede quando risponde male o
lentamente — l'incorporazione di terze parti è il modo più comune per far rallentare una pagina che
non c'entra niente.

### 4. Il database che risponde male
Con `page.route('**/rest/v1/**', …)` restituisci `500`, poi `429`, poi una risposta lenta (10 s), poi
un JSON malformato. Per ognuno: l'utente cosa vede? Ci sono timeout, o la pagina resta appesa per
sempre? Un'attesa senza fine è peggio di un errore.

### 5. Rete lenta e instabile
Con la rete a 3G lento e con una perdita di pacchetti simulata: le pagine principali arrivano? Le
richieste in corso quando la rete cade vengono ritentate o restano appese? Se l'utente tocca due volte
un comando lento, parte due volte l'operazione?

### 6. La degradazione sul database non migrato
Il database della CI **non è migrato**: il codice nuovo deve degradare con `PGRST204` (colonna assente
in scrittura) e `42703` (colonna assente in lettura), non rompersi. Simula le due risposte e guarda
cosa succede a schermo.

---

## La prova di validità (obbligatoria)

- Prima di dire che l'offline funziona, verifica che con la rete **staccata** una rotta mai visitata
  dia davvero la pagina `/offline` e non una copia in cache: svuota la CacheStorage del contesto e
  ripeti.
- Prima di dire che un provider caduto è gestito, verifica che la tua intercettazione **stia
  davvero intercettando**: falla rispondere `418` e controlla di vedere un `418` da qualche parte. Se
  non lo vedi, stai simulando un guasto che non arriva al codice.

## Verdetto

| | Quando |
|---|---|
| **PASS** | guscio offline funzionante, `/offline` per le rotte non viste, nessuna cache di `/api/` o `/m/`, provider caduti con messaggio all'utente e corpo dell'errore nel log, nessuna attesa infinita |
| **FAIL** | pagina bianca offline, un token in cache, un provider che fallisce in silenzio, una richiesta che resta appesa senza timeout |
| **BLOCCATO** | non riesci a simulare i guasti |

## Il tuo report

`docs/collaudo/risultati/tester-16-offline-resilienza.md` — front-matter con `tester: 16`,
`categoria: offline-resilienza`. Fai una tabella **guasto → cosa vede l'utente → cosa dice il log**.
Nei warning: le attese lunghe senza indicatore, i ritentati mancanti, i doppi invii possibili.
