# iPad PR 2 — schermate principali su più colonne: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** da 1024 px, cioè con la sidebar, le schermate principali di genitori e docenti usano la larghezza dell'iPad su due colonne. Le gallerie passano a 3 colonne sul binario e a 4 con la sidebar.

**Architecture:**
- Le pagine che si allargano si dichiarano in `src/lib/ui/larghezza-pagina.ts` (`max-w-5xl` invece della colonna di lettura da 720).
- Le due colonne si accendono con `lg:` (1024 px), che è esattamente il punto in cui compare la sidebar. Lì lo spazio utile parte da 768 px: due colonne da ~360.
- L'ordine del DOM non cambia mai, quindi sul telefono resta tutto com'è.
- Le colonne della galleria le passa il chiamante (`MediaGrid` lo pretende), in base a `useFormatoGuscio()`.
- Niente container query: `container-type` applica il layout containment e diventa il blocco contenitore dei `fixed` discendenti, cioè di fogli, modali e visori.

**Tech Stack:** Next.js 16, Tailwind v4, vitest + jsdom, Playwright (progetti `tablet-verticale` e `tablet-orizzontale`).

**Come si è deciso, schermata per schermata.** Le schermate tablet della PR 1 (CI run 39130168885) mostrano a 1194 px una colonna da 720 con metà dello schermo vuota:

| Schermata | Decisione | Perché |
|---|---|---|
| Home genitore | sezioni su 2 colonne (griglia, `items-start`) | sono schede indipendenti; l'ordine resta quello del telefono, riga per riga |
| Galleria genitore e docente | 2 → 3 (binario) → 4 (sidebar) | due foto da 400 px per riga erano metà schermo per due miniature |
| Mensa | giorni su 2 colonne | schede brevi e indipendenti |
| Pagamenti | sinistra: totale e «come pagare»; destra: le voci | è già l'ordine del telefono, diviso in due |
| Avvisi, News | schede su 2 colonne | schede indipendenti |
| Home docente | sinistra: bacheca e allergie; destra: appello, scorciatoie, agenda | ordine del telefono, diviso in due |
| Appello | righe dei bambini su 2 colonne | con la colonna larga una riga da 890 px allontana il nome dai comandi |
| Diario docente | schede dei bambini su 2 colonne | vedi sotto |
| Diario genitore | **resta in una colonna** (galleria interna a 3 colonne da tablet) | è una cronologia: due colonne ne romperebbero l'ordine di lettura |

Rispetto allo spec («elenco dei bambini ed editor affiancati»): il diario docente non ha un elenco separato dall'editor. Si sceglie la routine e ogni bambino ha la propria scheda, impilata. Affiancare un elenco a un editor vorrebbe dire riprogettarlo. Qui le schede passano a due colonne, che è il guadagno vero: metà scorrimento per compilare una sezione.

---

### Task 1: larghezze e colonne della galleria, in un posto solo

**Files:**
- Modify: `src/lib/ui/larghezza-pagina.ts`
- Test: `__tests__/ui/larghezza-pagina.test.ts`

- [ ] **Step 1: test che falliscono** — aggiungere a `__tests__/ui/larghezza-pagina.test.ts`:

```ts
it('la home del genitore è larga, le sue sottorotte no', () => {
  expect(classeColonnaGenitore('/parent')).toBe('max-w-[430px] tablet:max-w-5xl');
  expect(classeColonnaGenitore('/parent/diary')).toBe('max-w-[430px] tablet:max-w-[720px]');
});

it('le schermate su più colonne del genitore sono larghe', () => {
  for (const r of ['/parent/gallery', '/parent/mensa', '/parent/pagamenti', '/parent/avvisi', '/parent/news', '/parent/news/abc']) {
    expect(classeColonnaGenitore(r), r).toBe('max-w-[430px] tablet:max-w-5xl');
  }
});

it('il docente ha anche la colonna larga', () => {
  expect(COLONNA_DOCENTE_LARGA).toBe('mx-auto max-w-[460px] tablet:max-w-5xl');
});

it('la galleria: 2 colonne sul telefono, 3 sul binario, 4 con la sidebar', () => {
  expect(colonneGalleria('telefono')).toBe(2);
  expect(colonneGalleria('binario')).toBe(3);
  expect(colonneGalleria('sidebar')).toBe(4);
});
```

Il primo test esistente («il genitore resta a 430 px…») usa `/parent` come esempio di colonna stretta: va riscritto con `/parent/diary` e `/parent/locker`.

- [ ] **Step 2:** `npx vitest run __tests__/ui/larghezza-pagina.test.ts` → FAIL (`COLONNA_DOCENTE_LARGA`, `colonneGalleria` non esistono; `/parent` non è larga).

- [ ] **Step 3: implementazione**:

```ts
import type { FormatoGuscio } from '@/lib/ui/use-formato-guscio';

export const COLONNA_DOCENTE = 'mx-auto max-w-[460px] tablet:max-w-[720px]';
export const COLONNA_DOCENTE_LARGA = 'mx-auto max-w-[460px] tablet:max-w-5xl';

/** Le rotte larghe, sottorotte comprese. */
export const ROTTE_LARGHE_GENITORE: readonly string[] = [
  '/parent/chat', '/parent/gallery', '/parent/mensa', '/parent/pagamenti', '/parent/avvisi', '/parent/news',
];
/** Le rotte larghe SOLO in sé: `/parent` col prefisso allargherebbe tutta l'area. */
export const ROTTE_LARGHE_GENITORE_ESATTE: readonly string[] = ['/parent'];

export function classeColonnaGenitore(pathname: string): string {
  const larga =
    ROTTE_LARGHE_GENITORE_ESATTE.includes(pathname) ||
    ROTTE_LARGHE_GENITORE.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  return larga ? COLONNA_GENITORE_LARGA : COLONNA_GENITORE;
}

const COLONNE_GALLERIA: Record<FormatoGuscio, 2 | 3 | 4> = { telefono: 2, binario: 3, sidebar: 4 };
export function colonneGalleria(formato: FormatoGuscio): 2 | 3 | 4 {
  return COLONNE_GALLERIA[formato];
}

/**
 * Le due colonne delle schermate larghe: una sotto i 1024 px, due da lì (dove compare la sidebar
 * e lo spazio utile parte da 768 px). Una griglia a una colonna con `gap` è identica, sul telefono,
 * all'elenco impilato di prima.
 */
export const DUE_COLONNE = 'grid gap-3 lg:grid-cols-2 lg:items-start';
```

- [ ] **Step 4:** stesso comando → PASS. **Step 5:** commit `feat(tablet): rotte larghe e colonne della galleria in larghezza-pagina`.

### Task 2: genitore — home, mensa, avvisi, news, pagamenti

**Files:** `src/app/(dashboard)/parent/page.tsx:346-410`, `src/components/features/parent/mensa/MensaCalendar.tsx:406`, `src/app/(dashboard)/parent/avvisi/page.tsx:195`, `src/components/features/news/NewsFeedList.tsx:283`, `src/components/features/parent/pagamenti/StoricoPagamenti.tsx:183-252`.

- [ ] **Home:** le sezioni da «Presenze» ad «Agenda» entrano in un `<div data-kv-colonne className="lg:grid lg:grid-cols-2 lg:items-start">`. Ogni sezione tiene il proprio `px-4 pt-5`: nella griglia diventa il margine fra le colonne. Hero, banner, azioni rapide e footer restano fuori, a tutta larghezza.
- [ ] **Mensa:** `space-y-2.5` → `grid gap-2.5 lg:grid-cols-2 lg:items-start` con `data-kv-colonne`; la frase «nessun giorno» prende `lg:col-span-2`.
- [ ] **Avvisi:** `space-y-3` → `DUE_COLONNE` con `data-kv-colonne`.
- [ ] **News:** `flex flex-col gap-3` → `DUE_COLONNE` con `data-kv-colonne`.
- [ ] **Pagamenti:** il contenitore `space-y-5` diventa `data-kv-colonne` con `space-y-5 lg:grid lg:grid-cols-2 lg:gap-5 lg:space-y-0 lg:items-start`, e dentro due `div.space-y-5`:
  - sinistra: sospensione, totale, totale famiglia, `ComePagare`, `PushOptIn`;
  - destra: caricamento, errore, vuoto e gruppi.

  L'ordine nel DOM è quello di prima.
- [ ] `npx vitest run __tests__/components/MensaCalendar* __tests__/components/StoricoPagamenti* __tests__/components/ComePagare.test.tsx __tests__/components/pagamenti-senza-realtime.test.tsx __tests__/components/news` → verdi. Commit.

### Task 3: gallerie e diario del genitore

- [ ] `parent/gallery/page.tsx:149` e `teacher/gallery/page.tsx:985`: `colonne={colonneGalleria(formato)}` con `const formato = useFormatoGuscio();`.
- [ ] `MediaGrid.tsx:591`: la griglia prende `data-kv-colonne={colonne}`, così l'E2E legge quante colonne ha chiesto il chiamante.
- [ ] `parent/diary/page.tsx:437` (foto della giornata, colonna da 720): `colonne={formato === 'telefono' ? 2 : 3}`.
- [ ] Test unitario: `MediaGrid-impaginazione.test.tsx` aggiunge `data-kv-colonne="4"` con `colonne={4}`. Commit.

### Task 4: docente — home, appello, diario, galleria

- [ ] Home (`teacher/page.tsx`): `COLONNA_DOCENTE_LARGA`. Bacheca e allergie in un `div`, appello, scorciatoie e agenda in un altro, dentro `<div data-kv-colonne className="lg:grid lg:grid-cols-2 lg:gap-x-6 lg:items-start">`. I margini `mt-5`/`mt-6` restano sulle sezioni.
- [ ] Appello (`teacher/attendance/page.tsx`): `COLONNA_DOCENTE_LARGA`. `AppelloGiornaliero` prende la prop `griglia?: boolean` e, se vera, la lista `flex flex-col gap-2` diventa `grid gap-2 lg:grid-cols-2 lg:items-start` con `data-kv-colonne`. La segreteria (`admin/appello`) non la passa: è la PR 3.
- [ ] Diario (`teacher/diary/page.tsx`): `COLONNA_DOCENTE_LARGA`. Si aggiunge `export const GRIGLIA_BAMBINI = 'grid gap-2 lg:grid-cols-2 lg:items-start';` in `larghezza-pagina.ts`, e ogni `students.map` delle schede per bambino si avvolge in `<div className={GRIGLIA_BAMBINI}>`:
  - in `DiaryEventEditor.tsx`: nanna (`:1752`), bagno (`:1805`), umore (`:1944`);
  - `MealDetailInline.tsx:208`;
  - `RoutinePersonalizzataInline.tsx:114`;
  - `ActivityDetailInline.tsx:271` (`space-y-2` → `GRIGLIA_BAMBINI`).
- [ ] Galleria (`teacher/gallery/page.tsx`): `COLONNA_DOCENTE_LARGA`.
- [ ] `npx vitest run __tests__/components/diary* __tests__/components/appello* __tests__/architecture/colonna-tablet.test.ts` → verdi. Commit.

### Task 5: E2E, le colonne si misurano

- [ ] In `e2e/tablet-layout.spec.ts`, una tabella delle colonne attese per rotta, con `{ binario, sidebar }`:

| Rotta | binario | sidebar |
|---|---|---|
| `/parent` | 1 | 2 |
| `/parent/avvisi` | 1 | 2 |
| `/parent/mensa` | 1 | 2 |
| `/parent/pagamenti` | 1 | 2 |
| `/parent/gallery` | 3 | 4 |
| `/teacher` | 1 | 2 |
| `/teacher/attendance` | 1 | 2 |
| `/teacher/gallery` | 3 | 4 |

  Dopo `attendiPaginaFerma`:

```ts
await expect.poll(() => page.evaluate(() => {
  const el = document.querySelector('[data-kv-colonne]');
  if (!el) return 0;
  const t = getComputedStyle(el).gridTemplateColumns;
  return t === 'none' ? 1 : t.split(' ').length;
}), { timeout: 15_000 }).toBe(attese);
```

  Si aspetta una PRESENZA (il numero giusto), non un'assenza.
- [ ] Commit.

### Task 6: PRD, gate, PR

- [ ] Voce datata in testa a `PRD REGISTRO ELETTRONICO.md`, con la tabella delle decisioni e il logging («nessun log nuovo: solo disposizione»).
- [ ] Gate:
  - `npx eslint . --max-warnings 0`;
  - `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`;
  - `npx vitest run` (controllare la riga «Test Files N passed»);
  - `NODE_OPTIONS=--max-old-space-size=8192 npm run build`.
- [ ] Prova del morso: togliere `lg:grid-cols-2` da `DUE_COLONNE` e vedere rossi i test di Task 1.
- [ ] Push, PR, Auto-fix. A CI verde, schermate a Luigi PRIMA del merge (report HTML → indice zip → mappa allegato→test).
