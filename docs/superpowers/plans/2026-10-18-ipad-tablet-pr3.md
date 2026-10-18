# iPad PR 3 — la segreteria su tablet: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** su iPad il cockpit della segreteria smette di essere la versione telefono (sotto i 1024 px) o una sidebar da 256 px che toglie spazio alle tabelle (da 1024 a 1279). Al loro posto: un binario a icone da 744 a 1279 px, la sidebar piena da 1280.

**Architecture:**
- Il guscio admin dichiara `--kv-rail-w` su `[data-kv-guscio-admin]`: 0 sotto i 744 px, 88 px fino a 1279, 16rem da 1280. Lo legge la regola degli overlay del contenuto.
- La topbar desktop compare da 744 px, al posto di quella mobile. Così binario e sidebar hanno la stessa geometria: `sticky top-16`, alti `100vh - 4rem`, come la sidebar di oggi.
- Il binario (`AdminBinario`) ha i quattro tab della barra in basso, più Anagrafica e «Menu». «Menu» apre lo stesso contenuto del foglio (`AdminMenuSheet`, variante `pannello`) in un pannello accanto al binario: stesse voci, stesso filtro per ruolo, stessa sede.

**Tech Stack:** Next.js 16, Tailwind v4 (`tablet:` = 744 px, `xl:` = 1280 px), vitest, Playwright (`tablet-verticale` 768 px, `tablet-orizzontale` 1194 px).

**Perché 1280 e non 1024 per la sidebar piena:** a 1024 px (iPad 13" in verticale) e a 1194 (11" in orizzontale) la sidebar da 256 px lascia 768–938 px. Il registro transazioni ha `min-w-[820px]` e scorre di lato. Con il binario da 88 px restano 936–1106 px.

**Tutto in un rilascio** (decisione del titolare: «un unico deploy finale»). Nella stessa PR entrano anche:
- la riga di stato della PR 2 nel PRD;
- le card degli avvisi bianche nelle schermate WebKit, trovate guardando quelle della PR 2.

---

### Task 1: il guscio

**Files:**
- `src/app/(dashboard)/admin/layout.tsx`
- `src/app/globals.css`
- `src/components/features/admin/{AdminTopBar,AdminTopBarMobile,AdminSidebar,AdminBottomNav,AdminMenuSheet}.tsx`
- nuovo `src/components/features/admin/AdminBinario.tsx`

- [ ] Layout:
  - `data-kv-guscio-admin` sul contenitore;
  - la riga `lg:flex` diventa `tablet:flex`;
  - `<AdminBinario />` prima di `<AdminSidebar />`;
  - `main`: `pb-28 lg:pb-0` diventa `pb-28 tablet:pb-0`.
- [ ] Topbar:
  - `AdminTopBar` passa da `hidden lg:flex` a `hidden tablet:flex`; il marchio da `w-[214px]` a `w-auto xl:w-[214px]`; `attivoSu="(min-width: 744px)"`;
  - `AdminTopBarMobile` passa da `lg:hidden` a `tablet:hidden`, con `attivoSu="(max-width: 743.98px)"`.
- [ ] Sidebar piena da 1280: `lg:` diventa `xl:` sulle classi di `AdminSidebar`.
- [ ] Barra in basso e foglio: `lg:hidden` diventa `tablet:hidden`.
- [ ] `AdminMenuSheet` prende la prop `variante?: 'foglio' | 'pannello'`. Il pannello è `fixed` da `top-16` in giù, a sinistra parte da `left-[88px]` ed è largo 360 px. Focus trap, `Esc`, ritorno del fuoco, Indietro di Android e blocco dello scorrimento restano gli stessi.
- [ ] `AdminBinario`: `hidden tablet:flex xl:hidden`, `sticky top-16 h-[calc(100vh-4rem)] w-[88px] z-[105]`. Contiene:
  - le voci Home, Avvisi, Contabilità, Mensa e Anagrafica, con gli stessi `activeHref`, `visibleItem` e `withUser` della barra in basso;
  - «Menu», con `aria-expanded`, e `aria-current="true"` quando la rotta è una voce del menu.

  La pillola attiva ha la stessa grammatica della barra in basso (`bg-kidville-green`, icona `text-kidville-yellow`), che è anche il gancio dell'Alto Contrasto.
- [ ] `globals.css`: `[data-kv-guscio-admin]` con `--kv-rail-w` a 0, 88px e 16rem. La regola degli overlay passa da `@media (min-width: 1024px) { left: 16rem }` a `@media (min-width: 46.5rem) { left: var(--kv-rail-w) }`.
- [ ] Test:
  - `__tests__/architecture/admin-layout-shell.test.ts` aggiornato (`tablet:pb-0`, il binario montato);
  - nuovo `__tests__/ui/admin-binario.test.tsx`: le voci, l'attiva, «Menu» che apre il pannello e `Esc` che lo chiude;
  - aggiornati i test che fissano i vecchi punti (`admin-notifications-poll`, `notifications-panel-contatore-chat`).

### Task 2: le pagine dense e i comandi solo al passaggio del mouse

- [ ] `admin/impostazioni/page.tsx`: la sidebar delle sezioni passa da `md:block` a `lg:block`, e le pillole da `md:hidden` a `lg:hidden`. A 768 px, col binario, 224 px di sidebar lasciavano al modulo ~400 px.
- [ ] `admin/students/page.tsx:762`: da `grid-cols-2 md:grid-cols-5` a `grid-cols-2 md:grid-cols-3 lg:grid-cols-5`. Cinque schede da ~110 px a 768 px non leggono le etichette.
- [ ] `DraggableField.tsx:132` (cestino del campo) e `SectionsView.tsx:264`: `[@media(hover:none)]:opacity-100 focus-visible:opacity-100`. Senza mouse il cestino non compariva mai.

### Task 3: «Esci» leggibile anche nella segreteria

- [ ] `AdminSidebar` (`LOGOUT_ROW_CLS`) e `AdminMenuSheet`: da `text-kidville-error` (`#E53935`, 4,23:1 su bianco) a `text-kidville-error-strong`. È lo stesso difetto corretto nella PR 1 per genitori e docenti.

### Task 4: le card degli avvisi che restano bianche

- [ ] `AvvisoCard.tsx:402`: il `motion.div` che anima l'opacità porta anche `transition-all`. Una transizione CSS sulla stessa proprietà che anima framer-motion fa sì che, nelle schermate WebKit di #239 e #240, due card per giro restino a opacità 0, in posizioni diverse ogni volta. `transition-all` diventa `transition-colors`, che basta al bordo che cambia colore alla lettura.
- [ ] Marcatore `data-kv-avviso` sulla card.
- [ ] Nell'E2E tablet, per `/parent/avvisi`: OGNI `[data-kv-avviso]` arriva a opacità 1 (`expect.poll`, una presenza).
- [ ] Censimento dello stesso schema (`motion.*` con `initial` di opacità e `transition-all` sullo stesso elemento): ogni caso si corregge allo stesso modo.

### Task 5: E2E, PRD, gate

- [ ] `e2e/tablet-layout.spec.ts`: rotte della segreteria (`/admin`, `/admin/students`, `/admin/pagamenti`, `/admin/avvisi`, `/admin/mensa`, `/admin/impostazioni`) con `STORAGE.admin`. Per ciascuna si verifica:
  - l'URL giusto;
  - il binario visibile;
  - la barra in basso e la sidebar piena non visibili;
  - nessuno scorrimento orizzontale;
  - il contenuto a destra del binario;
  - la schermata allegata.

  In più: «Menu» del binario apre il pannello e porta alla voce scelta.
- [ ] PRD:
  - la riga **Stato** della PR 2 diventa «in produzione»;
  - una voce datata per la PR 3, che dice anche «nessun log nuovo».
- [ ] Gate:
  - `npx eslint . --max-warnings 0`;
  - `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`;
  - `npx vitest run` (riga «Test Files N passed»);
  - `NODE_OPTIONS=--max-old-space-size=8192 npm run build`;
  - le classi nuove presenti nel CSS di build.
- [ ] PR, Auto-fix, CI verde contando i retry, schermate a Luigi. Poi merge, rilascio verificato in produzione e branch puliti.
