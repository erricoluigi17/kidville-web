# Tester n. 13 — Percorsi utente end-to-end

Sei **il tester n. 13**. Fai **un solo collaudo**: i percorsi completi che gli utenti veri
percorrono — e soprattutto **quali di questi percorsi nessun test copre**. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; naviga e leggi,
non salvare niente; non fermi né riavvii il server su `:3100`.

> ⚠️ **La suite E2E in locale è vietata dai permessi del repo**: `npm run e2e`, `npm run e2e:seed` e
> `npx playwright test` non si lanciano. Il motivo è che `.env.local` punta al database di
> **produzione** e il seed scriverebbe lì dentro. L'E2E gira **solo in CI**, su un progetto Supabase
> separato. Il tuo lavoro è quindi in due metà: **leggere** cosa copre la suite, e **percorrere a mano,
> in sola lettura**, quello che non copre.

---

## Che cosa devi verificare

### 1. Cosa copre la suite, davvero
Ci sono **22 spec** in `e2e/`: `admin-contabilita`, `admin-dashboard`, `admin-forms`, `admin-news`,
`admin-notifications`, `admin-protocolli`, `admin-search`, `admin-students`, `auth`, `chat`,
`isolamento-sedi`, `notifications-panel`, `parent-diary`, `parent-home`, `parent-news`,
`parent-pagamenti`, `public-iscrizione`, `role-routing`, `teacher-agenda`, `teacher-attendance`,
`teacher-avvisi`, `teacher-diary`.

Leggile e costruisci la **matrice di copertura**: per ciascuna delle sezioni del prodotto (18 genitore,
14 docente, 25 admin, più le pubbliche), dì se un percorso E2E la tocca e **fin dove** arriva —
apre la pagina? compila? salva? verifica il risultato lato dato?

Un E2E che apre una pagina e controlla che ci sia un titolo **non** copre quella funzione: scrivilo.

### 2. L'ultima esecuzione in CI
```bash
gh run list --workflow=ci.yml --limit 10
gh run view <id> --log-failed | head -100
```
(`gh` chiede conferma: è previsto.) Riporta: l'ultimo esito del job **E2E (Playwright)**, quanti test,
quanti falliti, e se ci sono test **flaky** (passati al secondo tentativo — la config ha `retries: 2`
in CI: un test che passa solo al retry è un difetto travestito da successo).

### 3. Il rischio strutturale: chromium soltanto
La config ha **un solo progetto browser**, `chromium`. Non c'è WebKit, non c'è Firefox, non c'è mobile
emulation. Tutto il comportamento su Safari/iOS è, per costruzione, **non coperto**. Dichiaralo come
rilievo con la sua gravità, non come nota.

### 4. I percorsi critici, percorsi a mano
Fai **almeno 6 percorsi completi** in sola lettura, uno per ruolo, e per ognuno annota dove ti saresti
dovuto fermare perché la prosecuzione richiede una scrittura:

1. **Genitore**: login → home → apre l'avviso più recente → controlla presenze del mese → apre il
   diario di ieri → apre i pagamenti e legge lo stato → apre la chat.
2. **Docente**: login → home → apre l'appello di oggi (senza salvare) → apre il registro → apre la
   bacheca avvisi → apre il diario di una sezione.
3. **Segreteria**: login → cockpit → anagrafica alunni → cerca un bambino → apre la modulistica →
   apre la mensa → apre gli avvisi.
4. **Admin multisede**: login → cambia sede → verifica che i numeri cambino → apre iscrizioni.
5. **Pubblico**: apre il modulo d'iscrizione → percorre tutti i passi **senza inviare** → verifica
   che l'informativa privacy sia visibile e leggibile prima dei dati.
6. **Ruolo doppio** (`test.doppio`): login → il selettore di profilo compare → passa da docente a
   genitore e viceversa.

Per ognuno: quanti passi, dove si è impuntato, cosa non torna, quanto ci ha messo.

### 5. Il seed e i selettori
```bash
npx vitest run __tests__/architecture/e2e-selettori-placeholder.test.ts
```
Questo lock esiste perché sei test E2E erano rossi per un **selettore** sbagliato, non per un difetto
di prodotto. Verifica che i selettori usati negli spec corrispondano a qualcosa che esiste davvero, e
che il seed (`scripts/seed-e2e.mjs`) crei ancora tutto quello che gli spec si aspettano — **leggendo**,
non eseguendo.

### 6. Cosa manca del tutto
Chiudi con l'elenco dei percorsi che **nessuno** copre: né E2E, né unit, né tu. Sono il vero risultato
di questo collaudo. Ordinali per quanto farebbero male se si rompessero.

---

## La prova di validità (obbligatoria)

- Prima di dire che un percorso funziona, verifica che il dato che vedi a schermo **corrisponda** a
  quello nel database (una `SELECT` di conteggio sulla stessa risorsa). Una pagina che mostra
  qualcosa non prova che mostri la cosa giusta.
- Prima di dire che la suite copre una sezione, apri lo spec e leggi le asserzioni: se asserisce solo
  l'esistenza di un titolo, la copertura è nominale.

## Verdetto

| | Quando |
|---|---|
| **PASS** | i 6 percorsi arrivano in fondo senza intoppi, l'ultimo E2E in CI è verde e senza flaky, la matrice di copertura non ha buchi su funzioni critiche |
| **FAIL** | un percorso si interrompe, un E2E rosso o flaky in CI, una funzione critica del tutto scoperta |
| **BLOCCATO** | non riesci ad autenticarti con gli account TEST |

## Il tuo report

`docs/collaudo/risultati/tester-13-e2e.md` — front-matter con `tester: 13`, `categoria: e2e`.
Il cuore del report è **la matrice di copertura** e l'elenco dei percorsi scoperti. Nei warning: i
test flaky, gli spec che asseriscono troppo poco, i selettori fragili.
