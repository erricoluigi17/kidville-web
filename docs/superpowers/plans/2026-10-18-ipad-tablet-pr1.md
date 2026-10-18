# iPad tablet vero, PR 1: il guscio di genitori e docenti

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:executing-plans`. I passi usano le caselle (`- [ ]`).

**Obiettivo:** da 744 px in su, genitori e docenti hanno una navigazione laterale al posto della barra in basso e una colonna da 720 px invece di 430/460.
- Fra 744 e 1023 px la navigazione è un binario a icone.
- Da 1024 px è una sidebar con tutte le voci.

**Architettura:**
- **Breakpoint.** Si aggiunge `tablet` a 744 px nel `@theme` di Tailwind v4.
- **Formato.** Un hook `useFormatoGuscio()` (due `matchMedia` con `useSyncExternalStore`) sceglie **quale** navigazione montare: `telefono`, `binario` o `sidebar`. Ne esiste sempre una sola nel DOM, così gli E2E che cercano per testo non trovano doppioni.
- **Voci.** Le voci restano in `BottomNav.tsx` e `TeacherBottomNav.tsx`, esportate come hook (`useVociGenitore` e `useVociDocente`). Cinque lock leggono le voci da quei due file, e spostarle li renderebbe ciechi.
- **Larghezze.** Stanno in `src/lib/ui/larghezza-pagina.ts`.

**Tecnologie:** Next 16 App Router, Tailwind v4 (`@theme`), framer-motion, next-intl, vitest + jsdom, Playwright (WebKit).

Il design di riferimento è `docs/superpowers/specs/2026-10-18-ipad-tablet-design.md`.

---

## Mappa dei file

| File | Ruolo |
|---|---|
| `src/app/globals.css` | `--breakpoint-tablet` e variabili `--kv-rail-w` / `--kv-bottomnav-h` sul guscio `[data-kv-guscio-tablet]` |
| `src/lib/ui/use-formato-guscio.ts` (nuovo) | hook `telefono` / `binario` / `sidebar` |
| `src/lib/ui/larghezza-pagina.ts` (nuovo) | `COLONNA_DOCENTE`, `ROTTE_LARGHE_GENITORE`, `classeColonnaGenitore(pathname)` |
| `src/components/features/shell/ColonnaContenuto.tsx` (nuovo) | la colonna del genitore, che legge `pathname` |
| `src/components/features/shell/ElencoGruppiMenu.tsx` (nuovo) | le carte dei gruppi del menu e i pulsanti profilo/esci, condivisi da foglio e pannello |
| `src/components/features/shell/BarraLaterale.tsx` (nuovo) | binario, pannello Menu e sidebar; riceve le voci via prop |
| `src/components/features/parent/NavigazioneGenitore.tsx` (nuovo) | sceglie `BottomNav` oppure `BarraLaterale` con `useVociGenitore` |
| `src/components/features/teacher/NavigazioneDocente.tsx` (nuovo) | lo stesso per il docente |
| `parent/BottomNav.tsx`, `teacher/TeacherBottomNav.tsx` | esportano gli hook delle voci, usano `ElencoGruppiMenu`, prendono `tablet:hidden` |
| `parent/layout.tsx`, `teacher/layout.tsx` | `data-kv-guscio-tablet`, padding del binario, navigazione nuova |
| `shell/AppBar.tsx` | contenuto a tutta larghezza da 744 px |
| 12 pagine `teacher/**/page.tsx` | `COLONNA_DOCENTE` al posto di `mx-auto max-w-[460px]` |
| `__tests__/ui/larghezza-pagina.test.ts`, `__tests__/ui/use-formato-guscio.test.ts`, `__tests__/ui/barra-laterale.test.tsx`, `__tests__/architecture/colonna-tablet.test.ts` (nuovi) | i test |
| `playwright.config.ts`, `e2e/tablet-layout.spec.ts` (nuovo), `e2e/parent-news.spec.ts` | gli E2E |
| `PRD REGISTRO ELETTRONICO.md` | changelog, più lo stato di #237 e #238 |

---

### Task 1: breakpoint e variabili del guscio

**File:** modificare `src/app/globals.css`.

- [ ] **Passo 1.** Nel blocco `@theme inline` in testa al file, aggiungere:

```css
  /* TABLET — 744 px è l'iPad mini in verticale, il più stretto degli iPad. `md` (768) lo
     lascerebbe fuori, e ridefinire `md` toccherebbe 46 file che lo usano già con un altro
     significato. Tailwind ordina i breakpoint per valore: `tablet:` cade fra `sm:` e `md:`. */
  --breakpoint-tablet: 46.5rem;
```

- [ ] **Passo 2.** Subito **dopo** il blocco `[data-kv-shell] { … --kv-bottomnav-h … }`, aggiungere il blocco qui sotto. Deve venire dopo perché il lock `assenze-rifiniture-secondo-collaudo` legge la **prima** dichiarazione di `--kv-bottomnav-h`.

```css
/* IL GUSCIO TABLET di genitori e docenti (`[data-kv-guscio-tablet]` sui due layout, non
   sull'admin, che ha il suo). Da 744 px la barra in basso non esiste più: al suo posto un
   binario a sinistra (88 px), che da 1024 px diventa una sidebar (16rem). `--kv-rail-w` è lo
   spazio che il contenuto deve lasciargli; `--kv-bottomnav-h` va a zero perché chi si appoggia
   sopra la barra (piede appiccicato dell'assenza, avvisi settimanali) non trovi una fascia vuota. */
[data-kv-guscio-tablet] {
  --kv-rail-w: 0px;
}
@media (min-width: 46.5rem) {
  [data-kv-guscio-tablet] {
    --kv-rail-w: 88px;
    --kv-bottomnav-h: 0px;
  }
}
@media (min-width: 64rem) {
  [data-kv-guscio-tablet] {
    --kv-rail-w: 16rem;
  }
}
```

- [ ] **Passo 3.** `npx vitest run __tests__/pages/assenze-rifiniture-secondo-collaudo.test.tsx`. Atteso: `Test Files 1 passed`.

### Task 2: hook `useFormatoGuscio`

**File:** creare `src/lib/ui/use-formato-guscio.ts`; test in `__tests__/ui/use-formato-guscio.test.ts`.

- [ ] **Passo 1. Test (rosso).** Il test simula `matchMedia` con larghezze diverse. Tre casi:
  - 390 dà `telefono`;
  - 834 dà `binario`;
  - 1194 dà `sidebar`.

  Un quarto caso è l'assenza di `matchMedia`, che deve dare `telefono`.

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFormatoGuscio, QUERY_TABLET, QUERY_SIDEBAR } from '@/lib/ui/use-formato-guscio';

function simulaLarghezza(px: number) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === QUERY_TABLET ? px >= 744 : q === QUERY_SIDEBAR ? px >= 1024 : false,
    media: q, addEventListener: () => {}, removeEventListener: () => {},
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe('useFormatoGuscio', () => {
  it.each([[390, 'telefono'], [743, 'telefono'], [744, 'binario'], [834, 'binario'], [1024, 'sidebar'], [1194, 'sidebar']])(
    'a %i px → %s', (px, atteso) => {
      simulaLarghezza(px);
      expect(renderHook(() => useFormatoGuscio()).result.current).toBe(atteso);
    });
  it('senza matchMedia resta telefono (server, jsdom)', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(renderHook(() => useFormatoGuscio()).result.current).toBe('telefono');
  });
});
```

- [ ] **Passo 2.** `npx vitest run __tests__/ui/use-formato-guscio.test.ts`. Atteso: FAIL, modulo inesistente.
- [ ] **Passo 3. Implementazione.** Stesso schema di `src/lib/ui/use-schermo-stretto.ts`:

```ts
'use client';
import { useSyncExternalStore } from 'react';

/** Da 744 px (iPad mini in verticale) il guscio di genitori e docenti lascia la barra in basso. */
export const QUERY_TABLET = '(min-width: 46.5rem)';
/** Da 1024 px il binario a icone diventa una sidebar con tutte le voci. */
export const QUERY_SIDEBAR = '(min-width: 64rem)';

export type FormatoGuscio = 'telefono' | 'binario' | 'sidebar';

const haMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function iscriviti(avvisa: () => void): () => void {
  if (!haMatchMedia()) return () => {};
  const mql = [window.matchMedia(QUERY_TABLET), window.matchMedia(QUERY_SIDEBAR)];
  mql.forEach((m) => m.addEventListener('change', avvisa));
  return () => mql.forEach((m) => m.removeEventListener('change', avvisa));
}

function leggi(): FormatoGuscio {
  if (!haMatchMedia()) return 'telefono';
  if (window.matchMedia(QUERY_SIDEBAR).matches) return 'sidebar';
  return window.matchMedia(QUERY_TABLET).matches ? 'binario' : 'telefono';
}

/**
 * Quale navigazione montare. Il server e il primo render del client rispondono `telefono`, così
 * l'HTML coincide e non c'è errore di idratazione. Sul tablet la barra in basso resta invisibile
 * (`tablet:hidden`) per l'istante prima dell'idratazione, poi lascia il posto al binario.
 * Si monta UNA navigazione sola: con due nel DOM, una nascosta, `getByText('Chat')` negli E2E ne
 * troverebbe due, e i flow Maestro che toccano per testo pure.
 */
export function useFormatoGuscio(): FormatoGuscio {
  return useSyncExternalStore(iscriviti, leggi, () => 'telefono');
}
```

- [ ] **Passo 4.** Rilanciare il test. Atteso: 7 passed.
- [ ] **Passo 5. Commit:** `feat(tablet): breakpoint 744px e hook del formato del guscio`.

### Task 3: le larghezze in un modulo solo, più il lock

**File:** creare `src/lib/ui/larghezza-pagina.ts`, `__tests__/ui/larghezza-pagina.test.ts` e `__tests__/architecture/colonna-tablet.test.ts`.

- [ ] **Passo 1. Test unitario (rosso).**

```ts
import { describe, it, expect } from 'vitest';
import { classeColonnaGenitore, COLONNA_DOCENTE, ROTTE_LARGHE_GENITORE } from '@/lib/ui/larghezza-pagina';

describe('larghezza-pagina', () => {
  it('il genitore ha 430 px sul telefono e 720 da tablet', () => {
    expect(classeColonnaGenitore('/parent/mensa')).toBe('max-w-[430px] tablet:max-w-[720px]');
  });
  it('le rotte larghe si allargano, anche nelle sottorotte', () => {
    expect(ROTTE_LARGHE_GENITORE).toContain('/parent/chat');
    expect(classeColonnaGenitore('/parent/chat')).toBe('max-w-[430px] tablet:max-w-5xl');
    expect(classeColonnaGenitore('/parent/chat/abc')).toBe('max-w-[430px] tablet:max-w-5xl');
  });
  it('un prefisso che somiglia non basta', () => {
    expect(classeColonnaGenitore('/parent/chatbot')).toBe('max-w-[430px] tablet:max-w-[720px]');
  });
  it('il docente ha 460 px sul telefono e 720 da tablet', () => {
    expect(COLONNA_DOCENTE).toBe('mx-auto max-w-[460px] tablet:max-w-[720px]');
  });
});
```

- [ ] **Passo 2. Implementazione.**

```ts
/**
 * LE LARGHEZZE DELLE PAGINE DI GENITORI E DOCENTI, in un posto solo.
 *
 * Sul telefono restano quelle di sempre: 430 px il genitore, 460 il docente. Da 744 px (`tablet:`)
 * la colonna di lettura sale a 720 px, la misura che tiene una riga di testo leggibile.
 * Le pagine che vivono di larghezza (la chat a due riquadri) si dichiarano in
 * `ROTTE_LARGHE_GENITORE` e vanno fino a `max-w-5xl`.
 *
 * Le stringhe stanno qui per intero, mai composte: Tailwind trova le classi leggendo il sorgente,
 * e una classe montata a pezzi non verrebbe generata.
 */
export const COLONNA_DOCENTE = 'mx-auto max-w-[460px] tablet:max-w-[720px]';

const COLONNA_GENITORE = 'max-w-[430px] tablet:max-w-[720px]';
const COLONNA_GENITORE_LARGA = 'max-w-[430px] tablet:max-w-5xl';

export const ROTTE_LARGHE_GENITORE: readonly string[] = ['/parent/chat'];

export function classeColonnaGenitore(pathname: string): string {
  const larga = ROTTE_LARGHE_GENITORE.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  return larga ? COLONNA_GENITORE_LARGA : COLONNA_GENITORE;
}
```

- [ ] **Passo 3. Lock (rosso finché le pagine hanno il letterale).** `__tests__/architecture/colonna-tablet.test.ts` scansiona `src/app/(dashboard)/{parent,teacher}/**/*.tsx` alla ricerca di `max-w-[430px]` e `max-w-[460px]`. Si aspetta zero colpevoli e **più di 20 file scansionati**, perché un lock che non scansiona niente è verde lo stesso. È esente solo il modulo `larghezza-pagina.ts`, che sta fuori dalla cartella.

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RADICE = process.cwd();
const CARTELLE = ['src/app/(dashboard)/parent', 'src/app/(dashboard)/teacher'];
const LETTERALE = /max-w-\[(?:430|460)px\]/g;

function tsx(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsx(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

describe('lock — la colonna di genitori e docenti si allarga sul tablet', () => {
  const file = CARTELLE.flatMap((c) => tsx(join(RADICE, c)));

  it('il lock guarda davvero le pagine', () => {
    expect(file.length, 'nessuna pagina scansionata: il lock sarebbe verde per costruzione').toBeGreaterThan(20);
  });

  it('nessuna pagina si scrive a mano la colonna da telefono', () => {
    const colpevoli = file.flatMap((f) =>
      (readFileSync(f, 'utf8').match(LETTERALE) ?? []).map((m) => `${relative(RADICE, f)} — ${m}`));
    expect(
      colpevoli,
      'Una pagina fissa la propria larghezza a 430/460 px: sul tablet resterebbe una striscia da ' +
      'telefono in mezzo allo schermo. Si usa `COLONNA_DOCENTE` o `classeColonnaGenitore` da ' +
      '`src/lib/ui/larghezza-pagina.ts`, che sul telefono vale lo stesso.',
    ).toEqual([]);
  });
});
```

- [ ] **Passo 4.** `npx vitest run __tests__/ui/larghezza-pagina.test.ts __tests__/architecture/colonna-tablet.test.ts`. Atteso:
  - il test unitario PASS;
  - il lock FAIL, con 15 colpevoli: 14 nelle pagine docente e 1 in `parent/layout.tsx`.

### Task 4: pagine docente e colonna del genitore

**File:**
- creare `src/components/features/shell/ColonnaContenuto.tsx`;
- modificare `parent/layout.tsx`, `teacher/layout.tsx` e le 12 pagine docente elencate dal lock.

- [ ] **Passo 1.** Nelle pagine docente, sostituire `mx-auto max-w-[460px]` (o `mx-auto flex … max-w-[460px]`) con `${COLONNA_DOCENTE}` in un template literal, conservando le altre classi. Esempio da `teacher/page.tsx:262`:

```tsx
import { COLONNA_DOCENTE } from '@/lib/ui/larghezza-pagina';
// prima: <div className="mx-auto max-w-[460px] px-4 pt-5">
<div className={`${COLONNA_DOCENTE} px-4 pt-5`}>
```

Occorrenze:
- `teacher/page.tsx:262`
- `attendance/page.tsx:75,169`
- `settings/locker/page.tsx:176`
- `tasks/page.tsx:30`
- `avvisi/page.tsx:143`
- `mensa/page.tsx:93`
- `gallery/page.tsx:857`
- `modulistica/page.tsx:128`
- `locker/page.tsx:348`
- `diary/page.tsx:109,132`
- `primaria/page.tsx:45`
- `primaria/[sectionId]/page.tsx:73`

- [ ] **Passo 2.** Scrivere `ColonnaContenuto`:

```tsx
'use client';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { classeColonnaGenitore } from '@/lib/ui/larghezza-pagina';

/** La colonna dell'area genitore: 430 px sul telefono, 720 (o larga, per le rotte dichiarate) da tablet. */
export function ColonnaContenuto({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  return <div className={`relative mx-auto ${classeColonnaGenitore(pathname)}`}>{children}</div>;
}
```

- [ ] **Passo 3.** `parent/layout.tsx`:
  - sul `div` radice, `data-kv-guscio-tablet`;
  - il `<div className="relative max-w-[430px] mx-auto">` diventa `<div className="pl-[var(--kv-rail-w)]"><ColonnaContenuto>…</ColonnaContenuto></div>`, e `BottomNav` esce dalla colonna;
  - `NavigazioneGenitore` (Task 6) prende il posto di `BottomNav`, con la sua `Suspense`.
- [ ] **Passo 4.** `teacher/layout.tsx`:
  - sul `div` radice, `data-kv-guscio-tablet`;
  - `<main className="pb-28 outline-none">` diventa `<main className="pb-28 tablet:pb-10 pl-[var(--kv-rail-w)] outline-none">`;
  - `NavigazioneDocente` prende il posto di `TeacherBottomNav`.
- [ ] **Passo 5.** Rilanciare il lock. Atteso: PASS, con più di 20 file scansionati.
- [ ] **Passo 6. Commit:** `feat(tablet): colonna di lettura 720px per genitori e docenti`.

### Task 5: le voci esportate, e il menu condiviso

**File:**
- modificare `parent/BottomNav.tsx` e `teacher/TeacherBottomNav.tsx`;
- creare `shell/ElencoGruppiMenu.tsx`.

- [ ] **Passo 1. `ElencoGruppiMenu`.** È il blocco `<div className="flex flex-col gap-[18px]">…</div>` dei due fogli: carte dei gruppi, `CambiaProfiloMenuButton` e `LogoutMenuButton`. Le uniche differenze fra i due fogli sono `hrefDi` (il docente propaga `?userId=`) e l'etichetta «In arrivo». Le prop:

```ts
export interface VoceMenu { id: string; label: string; sub: string; icon: LucideIcon; href: string | null; tint: string; soon?: boolean }
export interface GruppoMenu { label: string; items: VoceMenu[] }
interface Props {
  gruppi: GruppoMenu[];
  pathname: string;
  hrefDi: (href: string) => string;
  /** Chiude il foglio sul tocco della voce della rotta in cui si è già (lì `pathname` non cambierebbe mai). */
  onChiudi: () => void;
  etichettaInArrivo: string;
}
```

  Il JSX si copia **identico** da `BottomNav.tsx:331-420`, con `hrefDi(it.href)`, `onClick={active ? onChiudi : undefined}` e i commenti sulla chiusura al cambio di rotta.
- [ ] **Passo 2. `BottomNav.tsx`.** Estrarre in `export function useVociGenitore()` tutto ciò che sta fra `useChildSchoolType()` e `anyMainTabActive`, e restituire:

```ts
{ t, pathname, mainTabs, visibleGroups, isActive, isMenuSectionActive, anyMainTabActive, nonLetti }
```

  Il componente lo chiama al posto del codice inline. Le voci e i `tint:` restano **in questo file**, perché li leggono i lock `tinte-funzioni-uniche`, `maestro-flows-selettori` e `assenze-rifiniture`.
  - Il foglio usa `<ElencoGruppiMenu … hrefDi={(h) => h} etichettaInArrivo={t('badgeInArrivo')} />`.
  - Il contenitore `fixed` della barra e quello del foglio prendono `tablet:hidden`.
- [ ] **Passo 3. `TeacherBottomNav.tsx`.** Stessa cosa con `export function useVociDocente()`, che restituisce anche `withUser`. Il foglio usa `hrefDi={withUser}`.
- [ ] **Passo 4.** `npx vitest run __tests__/ui __tests__/a11y __tests__/architecture`. Atteso: verde.
  - Se il censimento di `alto-contrasto-inchiostro-ereditato` o un lock che conta classi per file si sposta, va aggiornato **dicendo perché** nel messaggio del test: il JSX ha cambiato file, non contenuto.
- [ ] **Passo 5. Commit:** `refactor(nav): voci esportate come hook, menu raggruppato condiviso`.

### Task 6: `BarraLaterale` e le due navigazioni d'area

**File:**
- creare `shell/BarraLaterale.tsx`, `parent/NavigazioneGenitore.tsx` e `teacher/NavigazioneDocente.tsx`;
- test in `__tests__/ui/barra-laterale.test.tsx`.

- [ ] **Passo 1. Test (rosso).** `BarraLaterale` si rende con voci finte:
  - in `formato="binario"` mostra un `nav` con i tab principali (`aria-current="page"` su quello attivo) e un bottone Menu (`aria-expanded`);
  - cliccando il bottone compare un `dialog` con i gruppi, che si chiude con `Escape`;
  - in `formato="sidebar"` non c'è il bottone Menu e compaiono le intestazioni dei gruppi con le loro voci;
  - in entrambi i formati il badge chat è dentro il link `chat`;
  - **nessun `id` duplicato** nel documento.
- [ ] **Passo 2. Implementazione.** Le prop:

```ts
interface TabPrincipale { id: string; label: string; icon: LucideIcon; href: string | null }
interface Props {
  formato: 'binario' | 'sidebar';
  ariaNav: string;                  // «Navigazione principale», dal catalogo dell'area
  tab: readonly TabPrincipale[];    // l'ultimo è il Menu (href null)
  gruppi: GruppoMenu[];
  pathname: string;
  isActive: (href: string) => boolean;
  menuAcceso: boolean;              // isMenuSectionActive && !anyMainTabActive
  hrefDi: (href: string) => string;
  idTabBadge: string;               // 'chat' (genitore) | 'messaggi' (docente)
  nonLetti: { descrittoDa?: string; descrizione: ReactNode; badge: ReactNode };
  testi: { ariaMenu: string; eyebrow: string; titolo: string; chiudi: string; inArrivo: string };
}
```

  - **Contenitore:** `<aside data-kv-barra-laterale className="fixed left-0 bottom-0 z-40 flex flex-col overflow-y-auto border-r border-kidville-line bg-kidville-white" style={{ top: 'var(--kv-appbar-h)', width: 'var(--kv-rail-w)' }}>`.
  - **Binario:**
    - ogni tab è `flex flex-col items-center gap-1 py-3`;
    - la pillola è `relative w-12 h-8 rounded-full`, `bg-kidville-green` quando è attiva, con l'icona `text-kidville-yellow` se attiva e `text-kidville-sub` se no;
    - l'etichetta è `text-[10px] font-barlow font-bold uppercase tracking-wider`, `text-kidville-green` se attiva e `text-kidville-sub` se no;
    - il badge si monta come **primo** figlio della pillola e la descrizione come **primo** figlio del link: è la trappola dell'ordine documentata in `useBadgeChatNonLetti`.
  - **Pannello Menu:**
    - overlay `fixed inset-0 z-40 bg-kidville-green/30`;
    - pannello `fixed z-50 bottom-0 w-[360px] overflow-y-auto bg-kidville-cream p-4 shadow-2xl`, con `top: var(--kv-appbar-h)` e `left: var(--kv-rail-w)`;
    - attributi `role="dialog"`, `aria-modal`, `aria-labelledby` con `useId`, e `Escape` per chiudere;
    - dentro, intestazione (eyebrow, titolo, X) e `ElencoGruppiMenu`;
    - chiusura al cambio di rotta con lo stesso aggiustamento in render di `BottomNav`, mai un `useEffect` (`set-state-in-effect`).
  - **Sidebar:**
    - riga Home in cima;
    - per ogni gruppo un'intestazione `px-4 pb-1 pt-3 font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-sub`;
    - le voci sono `flex items-center gap-3 rounded-xl px-4 py-2.5 font-maven text-sm font-semibold`:
      - attiva: `bg-kidville-green text-white`, icona `text-kidville-yellow`;
      - inattiva: `text-kidville-sub hover:bg-kidville-green-soft hover:text-kidville-green`, icona nel `tint` della voce;
    - una voce con `href` null è un `div aria-disabled` con «In arrivo»;
    - in fondo, `CambiaProfiloMenuButton` e `LogoutMenuButton`.
- [ ] **Passo 3. `NavigazioneGenitore` e `NavigazioneDocente`.**

  Le voci si leggono **dentro** il ramo montato, così l'hook non ha mai due istanze, cioè due fetch dei figli:

```tsx
'use client';
function BarraLateraleGenitore({ formato }: { formato: 'binario' | 'sidebar' }) {
  const v = useVociGenitore();
  return <BarraLaterale formato={formato} tab={v.mainTabs} gruppi={v.visibleGroups} … />;
}
export function NavigazioneGenitore() {
  const formato = useFormatoGuscio();
  return formato === 'telefono' ? <BottomNav /> : <BarraLateraleGenitore formato={formato} />;
}
```

  Lo stesso vale per il docente, con `BarraLateraleDocente` e `useVociDocente`.
- [ ] **Passo 4.** Montare le due navigazioni nei layout (Task 4, passi 3 e 4) dentro la loro `Suspense`. `useSearchParams` serve al docente, e anche al genitore tramite `useChildSchoolType`.
- [ ] **Passo 5. AppBar** (`AppBar.tsx:106-109`):

```tsx
className={`mx-auto flex w-full items-center gap-2.5 px-4 pb-3 pt-2 tablet:max-w-none tablet:px-6 ${
  area === 'teacher' ? 'max-w-[460px]' : 'max-w-[430px]'
}`}
```

- [ ] **Passo 6.** `npx vitest run __tests__/ui/barra-laterale.test.tsx`. Atteso: PASS. Poi tutta `__tests__/ui __tests__/a11y __tests__/architecture`.
  - Il lock `visore-media-sopra-la-bottom-nav` riceve `BarraLaterale.tsx`: il visore deve stare sopra anche al binario (z-40).
  - `alto-contrasto-inchiostro-ereditato` ha un'espressione dentro un `bg-kidville-green` (il badge). La si dichiara in `IGNOTI_DICHIARATI` con la stessa giustificazione delle bottom-nav, perché la misura vera la fa `contrasto-cascata`.
- [ ] **Passo 7. Commit:** `feat(tablet): binario a icone e sidebar per genitori e docenti`.

### Task 7: E2E sul tablet

**File:** modificare `playwright.config.ts` ed `e2e/parent-news.spec.ts`; creare `e2e/tablet-layout.spec.ts`.

- [ ] **Passo 1. Due progetti nuovi**, dopo `webkit`:

```ts
{ name: 'tablet-verticale', testMatch: /tablet-layout\.spec\.ts$/, retries: 0,
  use: { ...devices['iPad Mini'] }, dependencies: ['setup'] },
{ name: 'tablet-orizzontale', testMatch: /tablet-layout\.spec\.ts$/, retries: 0,
  use: { ...devices['iPad Pro 11 landscape'] }, dependencies: ['setup'] },
```

  Va aggiunto anche `/tablet-layout\.spec\.ts$/` al `testIgnore` di `chromium`.
- [ ] **Passo 2. Lo spec.** Per `STORAGE.genitore` scorre `/parent`, `/parent/diary`, `/parent/avvisi`, `/parent/mensa`, `/parent/pagamenti`, `/parent/gallery` e `/parent/chat`. Per `STORAGE.docente` scorre `/teacher`, `/teacher/attendance`, `/teacher/diary`, `/teacher/gallery` e `/teacher/chat`. Su ogni rotta:
  1. l'URL finale non è `/auth/login`. Va **per primo**, perché un PASS sulla schermata di accesso è peggio di un rosso;
  2. `[data-kv-barra-laterale]` è visibile e `[data-kv-barra-bassa]` ha conteggio 0;
  3. `scrollWidth <= innerWidth + 1`;
  4. la colonna `main` è larga più di 600 px;
  5. `testInfo.attach('<rotta>', { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' })`.

  Si aspetta la presenza di qualcosa (`h1` o il primo contenuto), mai un'assenza.
- [ ] **Passo 3. `parent-news.spec.ts`.** Il test «voce News nel Menu sheet» prova il foglio del **telefono**. Va messo dentro un `test.describe` con `test.use({ viewport: { width: 390, height: 844 } })`, perché a 1280 px ora c'è la sidebar.
- [ ] **Passo 4.** `npx vitest run __tests__/architecture/e2e-webkit-installato.test.ts`. I due progetti tablet sono WebKit, e il job installa già `chromium webkit`. Se il lock pretende che **ogni** progetto WebKit abbia un `testMatch` che seleziona spec esistenti, `tablet-layout.spec.ts` lo soddisfa.
- [ ] **Passo 5. Commit:** `test(e2e): progetto tablet con iPad mini e iPad Pro 11 orizzontale`.

### Task 8: PRD, gate e PR

- [ ] **Passo 1. PRD.**
  - Voce di changelog datata 18/10: guscio tablet, breakpoint 744, colonna 720, binario/sidebar ed E2E tablet.
  - Esplicitare che il logging non serve: niente route, integrazioni o percorsi d'errore nuovi.
  - Riportare a ✅ prod lo stato di #237 e #238 nelle tabelle in cima.
- [ ] **Passo 2. Gate.**
  - `npx eslint . --max-warnings 0`
  - `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`
  - `npx vitest run`, controllando la riga `Test Files N passed`
  - `NODE_OPTIONS=--max-old-space-size=8192 npm run build`
- [ ] **Passo 3.** Prova di rottura del lock: rimettere `mx-auto max-w-[460px]` in `teacher/page.tsx` e verificare che `colonna-tablet` diventi rosso, poi rimettere com'era.
- [ ] **Passo 4.** Push e PR, con legame via `ccd_pr`. Si guardano la CI e i retry.
- [ ] **Passo 5.** Scaricare le schermate dal report HTML con `gh run download <id> -n playwright-report`, guardarle e mandarle a Luigi.
