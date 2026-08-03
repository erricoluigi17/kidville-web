# Tester n. 08 — Design system Clay Village

Sei **il tester n. 08**. Fai **un solo collaudo**: la coerenza visiva — i token, i componenti, il
fatto che due schermate della stessa app sembrino la stessa app. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; naviga e leggi,
non salvare niente; non fermi né riavvii il server su `:3100`.

---

## I token, dove stanno davvero

Non esiste `tailwind.config.*`: è Tailwind v4, e i token vivono nel CSS —
**`src/app/globals.css`, blocco `@theme inline`, righe 3-30**.

| Token | Hex |
|---|---|
| `--color-kidville-green` | `#006A5F` |
| `--color-kidville-yellow` | `#FDC400` |
| `--color-kidville-cream` | `#FEF1E4` |
| `--color-kidville-white` | `#FFFFFF` |
| `--color-kidville-error` | `#E53935` |
| `--color-kidville-success` | `#43A047` |
| `--color-kidville-yellow-light` | `#FFF8E1` |
| `--color-kidville-green-light` | `#E8F5F3` |
| `--color-kidville-green-dark` | `#00544B` (hover/pressed) |
| `--color-kidville-green-soft` | `#E2EEEC` |
| `--color-kidville-yellow-dark` | `#E6B100` |
| `--color-kidville-yellow-soft` | `#FBF0DD` |
| `--color-kidville-line` | `#EFE7DC` |

Più le tinte **per-dato** in `:root` (righe 96-113), che **non** sono token di tema: gradi
(`--kv-grade-nido #2A6FDB`, `--kv-grade-infanzia #006A5F`, `--kv-grade-primaria #E6720A`) e materie
(`--kv-subj-*`). Font: `--font-barlow` (Barlow Condensed), `--font-maven` (Maven Pro). Raggi:
`--radius-pill 9999px`, `--radius-card 16px`, `--radius-input 12px`.

---

## Che cosa devi verificare

### 1. Nessun colore fuori dai token
```bash
grep -rnE "#[0-9a-fA-F]{6}\b" src/ --include=*.tsx --include=*.ts | grep -v globals.css | head -60
grep -rnE "rgb\(|rgba\(|hsl\(" src/ --include=*.tsx | head -40
```
Ogni hex cablato in un componente è un rilievo. Trappola già pagata: **`@theme inline` inlinea l'hex**
nel CSS generato, quindi una variabile sovrascritta a runtime non ha effetto dove ti aspetteresti; e
un hex non va **mai** usato come base di una concatenazione con alpha.

### 2. I lock del design
```bash
npx vitest run __tests__/architecture/design-tokens-admin.test.ts
npx vitest run __tests__/architecture/header-cta-admin.test.ts
npx vitest run __tests__/architecture/settings-sistema-design.test.ts
```

### 3. Le primitive si usano, non si riscrivono
Le 17 primitive stanno in `src/components/ui/`: `Avatar`, `Badge`, `Btn`, `Card`, `cockpit`,
`ContrastMenuButton`, `DateField`, `LogoutMenuButton`, `Modal`, `OfflineBadge`, `OverflowMenu`,
`PageHeaderCard`, `PageLoader`, `PublicContrastButton`, `SaveConfirmation`, `SedeIcon`, `UserMenu`.
Cerca i posti dove qualcuno ha rifatto a mano un bottone, una card o una modale invece di usarle:
```bash
grep -rn "<button" src/components src/app --include=*.tsx | wc -l
grep -rn "from '@/components/ui/Btn'" src/ | wc -l
```
Un rapporto molto sbilanciato è la tua lista di sospetti. Idem per le modali (esiste `ui/Modal.tsx`) e
per gli importi in euro (esiste `lib/format/valuta.ts`, e il lock `importi-in-euro-localizzati`).

### 4. Come si vede davvero
Apri almeno **12 schermate** nelle quattro aree (genitore, docente, admin, pubblica) e confronta:
- la stessa gerarchia di intestazione (`PageHeaderCard`, `HeroCard`, `AppBar`)?
- gli stessi raggi, le stesse ombre, gli stessi spazi fra le card?
- i colori dei gradi e delle materie usati **sempre** per la stessa cosa?
- gli stati dei bottoni (normale, hover, premuto, disabilitato, in caricamento) esistono tutti?
- le varianti "piene" e "vuote" dei componenti sono coerenti fra loro?

Prendi i colori **calcolati**, non quelli scritti nel sorgente:
```js
await page.evaluate(() => getComputedStyle(document.querySelector('button')).backgroundColor)
```

### 5. Regressione visiva
Non esiste una baseline di screenshot in questo repo. Costruiscine una **temporanea, fuori dal repo**:
cattura le 12 schermate a 375 px e a 1440 px, mettile in una cartella temporanea e guardale in fila.
Ciò che salta all'occhio in una griglia di 24 immagini non salta all'occhio pagina per pagina.
Nel report **non allegare gli screenshot** (contengono dati reali): descrivi cosa hai visto.

### 6. Il tema ad alto contrasto
Esiste (`ContrastMenuButton`, `PublicContrastButton`): attivalo e ripassa 5 schermate. Il contrasto
alto non deve rompere il layout né far sparire elementi. Il contrasto *in sé* è del tester 09: se
trovi coppie sotto soglia, mandagliele sotto `ALTRUI`.

---

## La prova di validità (obbligatoria)

- Il tuo controllo sugli hex cablati: puntalo su `globals.css`, dove gli hex **ci sono per forza**.
  Se non ne trova, la tua ricerca è sbagliata.
- Il confronto dei colori calcolati: fallo su due elementi che sai essere diversi (un bottone primario
  e uno secondario). Se ti risultano uguali, stai leggendo l'elemento sbagliato.

## Verdetto

| | Quando |
|---|---|
| **PASS** | nessun colore fuori token nei componenti, lock verdi, primitive usate, 12 schermate coerenti, alto contrasto che non rompe |
| **FAIL** | colori cablati, componenti riscritti a mano, incoerenze visibili fra schermate della stessa area, stati mancanti |
| **BLOCCATO** | non riesci ad aprire le schermate autenticate |

## Il tuo report

`docs/collaudo/risultati/tester-08-design.md` — front-matter con `tester: 08`, `categoria: design`.
Elenca le schermate confrontate. Nei warning: le incoerenze minori, gli spazi che ballano, le tinte
per-dato usate per cose diverse in pagine diverse.
