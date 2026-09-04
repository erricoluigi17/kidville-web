# Colori fuori dai token e tema chiaro dichiarato — design

**Data**: 2026-09-04 · **Branch**: `feat/estratto-conto-xls-intestatario`

Questo documento tiene le **decisioni di design** e il **modello mentale**. La cronaca sta nel
changelog del PRD; qui c'è ciò che serve a chi domani deve scegliere un colore.

---

## 1. Il modello: l'app ha due modalità, e i token non le tengono insieme come sembra

Kidville ha due modalità visive: **normale** (Clay Village) e **Alto Contrasto** (Legge Stanca /
AgID), attivata dal cookie `kv_contrast=high` → `<html data-contrast="high">`.

⚠️ **Gli override dei token dentro `[data-contrast="high"]` NON raggiungono le classi Tailwind.**
I token stanno in `@theme inline` (`globals.css:3`), e l'opzione `inline` fa **inlinare l'hex** nella
utility: `.bg-kidville-cream` emette `background-color:#FEF1E4` letterale, non
`var(--color-kidville-cream)`.

Misurato col browser il 2026-09-04, creando elementi veri e leggendo `getComputedStyle`:

```
bg-kidville-cream    normale rgb(254,241,228)  →  Alto Contrasto rgb(254,241,228)
text-kidville-muted  normale rgb(154,166,162)  →  Alto Contrasto rgb(154,166,162)
SI_RIBALTANO: false
```

**Conseguenze pratiche, da tenere a mente sempre:**

| | |
|---|---|
| Il ribaltamento dei token vale solo per | `var(--color-kidville-*)` scritto a mano: i 3 CSS module e le regole dentro `globals.css` |
| L'Alto Contrasto è dipinto | **superficie per superficie a mano**: 141 regole in `globals.css`, 17 classi `kv-*` agganciate su 81 usate |
| Quindi tokenizzare un colore risolve | **la modalità normale**, non l'Alto Contrasto. Sono due lavori |
| L'Alto Contrasto di una superficie si risolve | scrivendo la sua regola `[data-contrast="high"] .qualcosa {}` |
| Una ridefinizione di token senza `var()` che la legga | è **inerte**: documentazione che mente. Il lock `token-alto-contrasto-non-inerti` la prende |

**L'eccezione che vale oro**: un `<input>/<select>/<textarea>` con `border-kidville-line` viene
ridipinto a `#000000` in Alto Contrasto da `globals.css:1029`. **Tokenizzare quel bordo compra
gratis la correzione dell'Alto Contrasto** di quel campo.

---

## 2. La scala degli inchiostri, e perché `muted` non ne fa parte

Contrasti misurati sul crema di pagina `#FEF1E4` e sul bianco:

| token | hex | crema | bianco | mestiere |
|---|---|---|---|---|
| `ink` | `#1F3D38` | 10,61 | 11,78 | testo primario, titoli |
| `green` | `#006A5F` | 5,86 | 6,51 | inchiostro di brand, il default del `body` |
| `sub` | `#55615C` | 5,82 | 6,46 | **testo secondario** — la destinazione di ogni etichetta |
| `hint` | `#65716C` | 4,58 | 5,08 | il **suggerimento dentro un campo** (segnaposto, «Seleziona…») |
| `muted` | `#7B8582` | 3,43 | 3,80 | **NON è testo**: bordi, divisori, glifi decorativi |
| `neutral` | `#8A958F` | 2,79 | 3,10 | contorno dei controlli a riposo ⚠️ vedi §4 |

### Perché `muted` non è stato portato ad AA

La fascia chiara peggiore **non è il crema** ma `cream-dark` `#F6E4D2`. Per arrivare a 4,5:1 là
servirebbe `#5F6764`, che è `sub` `#55615C` a meno di mezzo punto: **fra `hint` e `sub` l'intervallo
è vuoto**. Scurirlo fin lì avrebbe reso `muted` indistinguibile da `sub` mentre 1098 punti
continuavano a chiamarlo `muted` — il debito sarebbe sparito dai numeri senza che nessuno avesse
riletto una riga, e i cinque lock che lo sorvegliano non avrebbero più avuto niente da difendere.

`#7B8582` sta nella finestra **[3,07 · 3,80]** su tutte e 13 le fasce chiare:
- **> 3,0** (WCAG 1.4.11) → è un token non testuale valido, e chiude un difetto mai contato: i 37 `border-kidville-muted` stavano sotto soglia;
- **< 4,5** (WCAG 1.4.3) → **apposta**: i lock restano veri con la soglia che hanno oggi. Non si abbassa niente.

> **Regola**: `muted` non dipinge testo. Se stai per scrivere `text-kidville-muted`, la risposta è
> `sub`; se è il segnaposto di un campo, è `hint`.

---

## 3. Tabella di mappatura — colore di serie → token

| se stai per scrivere | usa |
|---|---|
| `text-gray-300/400/500` | `text-kidville-sub` |
| `text-gray-600/700/800`, `text-black` | `text-kidville-ink` |
| `border-gray-*`, `divide-gray-*` | `border-kidville-line`, `divide-kidville-line` |
| `bg-gray-50` | `bg-kidville-cream` (pagina) o `bg-kidville-neutral-soft` (pannello) |
| `bg-gray-800/900` come superficie | `bg-kidville-ink` |
| `bg-red-*` | `bg-kidville-error-soft` + `text-kidville-error-strong` |
| `bg-amber-*` | `warn-soft` / `warn-strong` |
| `bg-blue-*` | `info-soft` / `info-strong` |
| `bg-black/40` come velo di modale | `bg-kidville-ink/40` — la costante `MODAL_OVERLAY` |
| il giallo di brand come **inchiostro su fondo chiaro** | `text-kidville-yellow-strong` `#7A5C00` |
| il giallo di brand come inchiostro **su verde** | `text-kidville-yellow-ink` `#FFDA5C` |

⚠️ **La rete di sicurezza sul giallo** (`globals.css:671`) è un selettore **discendente**:
`.bg-kidville-green .text-kidville-yellow`. Non aggancia un fondo dipinto con
`style={{background: linear-gradient(...)}}`, né `bg-kidville-green/95`, né una pillola che è un
elemento **fratello** in posizione assoluta. In quei casi si scrive `yellow-ink` nel punto d'uso.

### Restano legittimi, e non si toccano
Il letterbox di un player video (`bg-black`), il gradiente scuro che rende leggibile una didascalia
sopra una **foto arbitraria**, la pastiglia su una miniatura caricata dall'utente, il lightbox
`bg-kidville-ink/90`, e il tema scuro delle **email** (che non hanno `globals.css` e devono usare
valori letterali).

---

## 4. Debito residuo, dichiarato

1. **`neutral` `#8A958F` è ora il grigio più debole della scala** (2,79 sul crema), ed è quello che
   dipinge il contorno dei campi a riposo. Sotto i 3:1 di WCAG 1.4.11 sulle fasce più scure. Le
   regole per-superficie di `globals.css` oggi lo rattoppano campo per campo; la scelta pulita
   sarebbe allinearlo a `#7B8582`, ma tocca il modulo-specchio `chart-colors.ts` e un'asserzione di
   valore esatto. **Dichiarato, non nascosto.**
2. **76 colori di serie in 11 file**, congelati in `palette-di-serie.test.ts` con la motivazione
   accanto a ciascuno. `pink` e `orange` non hanno un token: serve una decisione di design.
3. **`PrimariaParentView.tsx`** — 40 di quei 76, in un file che **nessuna rotta monta**. Il rimedio
   giusto è cancellarlo, non ridipingerlo. È una cancellazione: si decide, non si fa per inerzia.
4. **2 dichiarazioni inerti** nel blocco Alto Contrasto (`success-strong`, `info-strong`).
5. **Il crawler di contrasto in Playwright non è stato scritto.** È l'unica cosa che misurerebbe il
   contrasto **vero** sulle schermate autenticate, nelle due modalità — dove nessuno ha mai
   misurato. Il disegno è nel piano di sessione.

---

## 5. Il tema è CHIARO, e ora lo diciamo

Decisione del titolare: Kidville è un'app **solo chiara**, dichiarato ovunque.
`html { color-scheme: light }`, `viewport.colorScheme`, `UIUserInterfaceStyle = Light`,
tema Android da `DayNight` a `Light` con `windowBackground` esplicito.

Non è una preferenza estetica: finché non era dichiarato, il **sistema operativo** disegnava da sé i
controlli nativi dentro campi che l'app dipinge bianchi — 463 `<input>` e 152 `<select>`.

⏳ **Da verificare, e non ancora fatto**: la prova su emulatore Android e simulatore iOS **forzati in
tema scuro**. È l'unica che dimostra i punti 1-3 del changelog. Finché non è fatta, quelle
correzioni sono ragionate, non provate.
