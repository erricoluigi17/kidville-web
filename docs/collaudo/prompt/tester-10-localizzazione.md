# Tester n. 10 — Localizzazione e internazionalizzazione

Sei **il tester n. 10**. Fai **un solo collaudo**: i testi, le date, i numeri, e la tenuta del layout
quando la lingua cambia. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; naviga e leggi,
non salvare niente; non fermi né riavvii il server su `:3100`.

---

## Come è fatta la localizzazione qui

- **next-intl senza routing per-locale**: l'albero delle rotte non ha `/[locale]`, la lingua sta in un
  **cookie `KV_LOCALE`** (`src/i18n/config.ts:11`).
- **Due lingue**: `it` (predefinita) ed `en`. I locali BCP47 sono forzati a `it-IT` e **`en-GB`**
  (non en-US) — `src/i18n/config.ts:35-38`.
- **34 namespace per lingua**, in `messages/it/<ns>.json` e `messages/en/<ns>.json`.
- **Fuso d'istituto fisso**: `Europe/Rome` (`src/i18n/config.ts:27`).
- Restano in italiano **di proposito**: PDF, CSV, log, corpi delle notifiche che sono dato, valuta,
  marchio. Non segnalarli come mancanze — verifica semmai che siano ancora *quelli*.

---

## Che cosa devi verificare

### 1. I cataloghi sono in parità
```bash
npx vitest run __tests__/i18n
npx vitest run __tests__/architecture/messaggi-parita-cataloghi.test.ts
npx vitest run __tests__/architecture/messaggi-plurali-e-glossario.test.ts
ls messages/it | wc -l && ls messages/en | wc -l     # atteso 34 e 34
```
Poi cerca ciò che i lock non vedono: chiavi presenti in entrambi ma **non tradotte** (valore identico
all'italiano dentro `messages/en/`), chiavi **mai usate** nel codice, chiavi usate ma **assenti** nei
cataloghi.
```bash
grep -rho "t('\([a-zA-Z0-9_.]*\)'" src/ | sort -u | wc -l
```

### 2. Testo cablato nel codice
Frasi italiane scritte a mano dentro i componenti invece che nei cataloghi:
```bash
grep -rnE ">[A-ZÀ-Ù][a-zà-ù]+ [a-zà-ù]+" src/components src/app --include=*.tsx | head -60
grep -rL "useTranslations" $(git ls-files 'src/app/(dashboard)/**/page.tsx') 2>/dev/null | head -30
```
Il secondo comando è il metodo che qui ha già funzionato: le pagine **senza** `useTranslations` sono
le candidate a contenere testo cablato. Escludi le pagine legali, che sono in italiano per obbligo
(lock `pagine-legali`: devono avere `lang="it"` e **non** usare `useTranslations`).

### 3. Date e fusi — il punto più fragile
Trappola specifica di questo prodotto: presenze, diario e registro sono **date senza ora**, e una
`toLocaleDateString` senza fuso esplicito le sposta di un giorno a seconda di dove gira il codice.
Ci sono due lock apposta:
```bash
npx vitest run __tests__/architecture/date-con-timezone.test.ts
npx vitest run __tests__/architecture/date-senza-fuso.test.ts
```
Verifica **sul prodotto**: apri una schermata con una data (una presenza, un avviso, una scadenza),
poi rifallo con il browser impostato su un fuso diverso:
```js
await browser.newContext({ locale: 'it-IT', timezoneId: 'Pacific/Auckland' })
```
Se la data mostrata cambia giorno, hai trovato il difetto. **Prova anche una data a cavallo di
mezzanotte e il 1° gennaio.**

### 4. Numeri, valute, plurali
- Gli importi in euro devono passare da `lib/format/valuta.ts` (lock `importi-in-euro-localizzati`):
  formato italiano `1.234,56 €`, e `en-GB` coerente.
- I plurali: "1 bambino" / "2 bambini" / "0 bambini". Cerca le concatenazioni a mano
  (`${n} bambin` + …), che in inglese si rompono.
- Le percentuali, le ore, le durate.

### 5. Il layout regge le stringhe lunghe
Passa a `en` (cookie `KV_LOCALE=en`) e ripassa **almeno 10 schermate** nelle tre aree. Cerca: testo
tagliato, bottoni che vanno a capo male, tabulazioni che sballano, etichette che escono dal loro
contenitore, la bottom-nav con le voci sovrapposte. Le stringhe inglesi qui sono spesso **più lunghe**
di quelle italiane, non più corte.

Poi il caso estremo: applica una stringa lunghissima via CSS (`::after` con del testo) o restringi a
320 px e guarda cosa succede alle etichette più lunghe.

### 6. Il selettore di lingua
Sta su login e su Profilo. Verifica: cambia davvero la lingua, sopravvive al ricaricamento, sopravvive
al logout/login, e non c'è un lampeggio di italiano prima dell'inglese.

---

## La prova di validità (obbligatoria)

- Metti `KV_LOCALE` a un valore **non valido** (`KV_LOCALE=zz`): deve ricadere su `it`, non rompersi.
  Se non cambia niente nemmeno con `en`, il cookie non viene letto e tutto il tuo collaudo è finto.
- Il tuo controllo sulle date: fallo prima su un fuso identico (`Europe/Rome`) — non deve segnalare
  niente — e poi su `Pacific/Auckland`.

## Verdetto

| | Quando |
|---|---|
| **PASS** | 34+34 namespace in parità, nessuna chiave mancante, nessun testo cablato fuori dalle pagine legali, date stabili al cambio di fuso, layout che regge l'inglese su 10 schermate |
| **FAIL** | una data che cambia giorno col fuso, testo cablato in una pagina tradotta, chiavi mancanti, layout rotto in inglese |
| **BLOCCATO** | non riesci a cambiare lingua |

## Il tuo report

`docs/collaudo/risultati/tester-10-localizzazione.md` — front-matter con `tester: 10`,
`categoria: localizzazione`. Elenca le schermate viste nelle due lingue. Nei warning: le chiavi non
tradotte davvero, quelle mai usate, le stringhe al limite dello spazio.
