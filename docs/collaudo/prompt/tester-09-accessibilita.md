# Tester n. 09 — Accessibilità (WCAG 2.2 AA)

Sei **il tester n. 09**. Fai **un solo collaudo**: l'app è usabile da chi non vede lo schermo, non usa
il mouse, non distingue i colori, o ha le mani impacciate. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; naviga e leggi,
non salvare niente; non fermi né riavvii il server su `:3100`.

Riferimento: **WCAG 2.2 livello AA**. Non ti serve conoscerlo a memoria: ti servono le sei prove qui
sotto, fatte sulle schermate vere.

---

## Che cosa devi verificare

### 1. Contrasto
Soglie: **4,5:1** per il testo normale, **3:1** per il testo grande (≥ 24px, o ≥ 19px grassetto) e per
i bordi dei componenti attivi. Calcola sui colori **computati**, non su quelli scritti nel sorgente:

```js
const coppie = await page.evaluate(() => [...document.querySelectorAll('button,a,label,h1,h2,p,span')]
  .slice(0, 200).map(el => {
    const s = getComputedStyle(el)
    return { tag: el.tagName, fg: s.color, bg: s.backgroundColor, size: s.fontSize, peso: s.fontWeight }
  }))
```
poi calcola il rapporto di luminanza per ogni coppia e riporta **quelle sotto soglia**, con la
schermata e l'elemento.

**Un caso già noto, da confermare**: il giallo del brand sul verde del brand dà **4,05:1** — sotto AA
per il testo normale (commento in `src/app/globals.css:24`). Verifica dove quella coppia è davvero
usata per del testo: è lì che il rilievo diventa reale.

### 2. Tastiera
Senza toccare il mouse, su almeno **8 schermate**:
- si arriva a **tutto** ciò che è interattivo con `Tab`?
- il **focus è sempre visibile**, e con un anello spesso abbastanza da vedersi sul suo sfondo?
- l'ordine di tabulazione segue l'ordine visivo?
- le modali intrappolano il focus e lo restituiscono alla chiusura? Si chiudono con `Esc`?
- i menu a scomparsa e la bottom-nav si aprono con `Invio`/`Spazio`?
- esiste un salto al contenuto ("skip link")?
- **niente trappole**: un punto da cui non si esce più con la tastiera è bloccante.

Le righe di tabella cliccabili e i bottoni a sola icona hanno già un lock ciascuno:
```bash
npx vitest run __tests__/architecture/righe-tabella-con-comando.test.ts
npx vitest run __tests__/architecture/bottone-icona-con-nome.test.ts
```

### 3. Struttura per lo screen reader
```bash
npx vitest run __tests__/a11y            # 10 file, jest-axe
```
Poi a mano, sulle stesse 8 schermate: un solo `<h1>`, gerarchia dei titoli senza salti, landmark
(`main`, `nav`, `header`), ogni campo con la sua `<label>` associata, ogni immagine informativa con
testo alternativo (e quelle decorative con `alt=""`), ogni bottone a sola icona con un nome
accessibile, tabelle con intestazioni vere. **Nome accessibile ≠ testo visibile**: un bottone che
mostra un'icona e si chiama "button" non esiste, per chi ascolta.

### 4. Annunci dinamici
Quando qualcosa cambia senza ricaricare la pagina — un salvataggio, un errore di validazione, una
notifica, il contatore della campanella — chi ascolta lo sa? Servono `aria-live`/`role="status"`.
Un errore di form che compare solo in rosso, visivamente, è invisibile a metà degli utenti.

### 5. Target e movimento
- I bersagli tattili devono essere almeno **24×24 px** (WCAG 2.2, criterio nuovo), meglio 44.
  Misurali con `getBoundingClientRect()` sui comandi delle 8 schermate.
- Con `prefers-reduced-motion` attivo, le animazioni si fermano?
- Zoom al **200%**: il contenuto resta leggibile e non si perde niente?

### 6. Alto contrasto
Attiva il tema ad alto contrasto (`ContrastMenuButton` / `PublicContrastButton`) e ripassa 4
schermate: nessun elemento deve sparire, nessun testo diventare illeggibile.

---

## La prova di validità (obbligatoria)

Il modo tipico in cui un collaudo di accessibilità mente è passare senza aver guardato:
- il tuo calcolo del contrasto: provalo su **nero su bianco** (deve dare 21:1) e su **grigio chiaro su
  bianco** (deve fallire). Se entrambi passano, la formula è sbagliata;
- la tua navigazione da tastiera: verifica che il conteggio degli elementi raggiunti con `Tab` sia
  **minore** del numero di elementi interattivi presenti in almeno una pagina che sai avere un
  problema — altrimenti stai contando male;
- **attenzione a `waitFor` su un'asserzione già vera**: passa subito e non prova niente. È esattamente
  così che, in questo repo, i test del loop biometrico erano falsi verdi.

## Verdetto

| | Quando |
|---|---|
| **PASS** | nessuna coppia sotto soglia su testo reale, tutto raggiungibile da tastiera con focus visibile, struttura semantica corretta, annunci presenti, target ≥ 24 px, zoom 200% ok |
| **FAIL** | una trappola per tastiera, un comando irraggiungibile, un contrasto sotto soglia su testo reale, un form senza etichette |
| **BLOCCATO** | non riesci ad aprire le schermate autenticate |

## Il tuo report

`docs/collaudo/risultati/tester-09-accessibilita.md` — front-matter con `tester: 09`,
`categoria: accessibilita`. Per ogni fallimento cita il **criterio WCAG** e la **misura** (il rapporto
di contrasto, i pixel del target). Nei warning: i contrasti al limite (fra 4,5 e 5), il focus poco
visibile, i target fra 24 e 44 px, l'ordine di tabulazione discutibile.
