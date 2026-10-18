# iPad: da «telefono ingrandito» a tablet vero

## Contesto

Su iPad l'app non è rotta, ma è un telefono al centro dello schermo:

- **Genitori**: tutte le 26 pagine stanno in una colonna da **430 px** (`src/app/(dashboard)/parent/layout.tsx:52`). La barra in basso è centrata a 430 px (`BottomNav.tsx:175`). Su un iPad da 11" metà schermo è vuota; in orizzontale (1366 px) lo è il 69%.
- **Docenti**: 12 pagine fisse a **460 px** (`mx-auto max-w-[460px]`), più la barra in basso (`TeacherBottomNav.tsx:191`).
- **Segreteria**: fra 744 e 1023 px mostra la versione telefono (barra a pillole e fogli dal basso) con dentro tabelle da desktop. A 1024 px (iPad 13" verticale) compare la sidebar da 256 px e le tabelle escono di lato (`TransazioniPanel` min 820 px).
- **Difetti puntuali**:
  - la chat genitori passa a due riquadri da 768 px, ma dentro la colonna da 430 px, e alla conversazione restano circa 60 px;
  - 3 controlli si vedono solo al passaggio del mouse, quindi su touch non compaiono mai (form builder, sezioni, galleria).
- **Rotazione**: l'app nativa su iPad gira in tutti e 4 i versi (`Info.plist:110-116`) ed è universale (`TARGETED_DEVICE_FAMILY "1,2"`), ma la rotazione non è mai stata provata.

**Decisioni di Luigi (18/10)**: si rifà tutto l'insieme, perché l'iPad lo usano tutti (maestre, genitori, segreteria, revisore Apple). La forma è un **tablet vero**: menu laterale e contenuto largo. Si interviene **solo sul sito**, senza nuova build nativa: l'app già installata carica `app.kidville.it` e riceve tutto subito.

## Il design

### Breakpoint `tablet:` a 744 px

L'iPad mini in verticale è largo 744 px, sotto il `md` (768) di Tailwind. Ridefinire `md` toccherebbe 46 file già scritti, quindi si aggiunge un breakpoint dedicato in `src/app/globals.css` (Tailwind v4):

```css
@theme { --breakpoint-tablet: 46.5rem; }   /* 744 px, si ordina fra sm e md */
```

| Larghezza | Esempi | Genitori / Docenti | Segreteria |
|---|---|---|---|
| < 744 | telefoni, Split View stretto | come oggi (barra in basso) | come oggi |
| 744–1023 | iPad mini/11" verticale | **binario** a icone da 88 px | **binario** a icone |
| 1024–1279 | iPad 13" verticale, 11" orizzontale | **sidebar** da 256 px con tutte le voci | binario (più spazio alle tabelle) |
| ≥ 1280 | iPad 13" orizzontale, PC | sidebar | sidebar come oggi |

Variabili CSS in `globals.css`:
- `--kv-rail-w`: 0 / 88px / 16rem;
- `--kv-bottomnav-h` a `0px` da 744 px in su, perché `CampoNonCoperto` e i piedi appiccicati la leggono.

### PR 1: il guscio di genitori e docenti, più la rete di prova

1. **Voci di navigazione estratte in dati puri.** Si creano `src/components/features/parent/nav-genitore.ts` e `.../teacher/nav-docente.ts` con i tab principali e i gruppi del menu (oggi dentro `BottomNav.tsx:96-153` e `TeacherBottomNav.tsx:~100-130`). La barra in basso, il binario e la sidebar leggono la **stessa** lista, quindi non possono divergere. Il filtro per grado (`visibile`) e `?userId=` dei docenti (`withUser`) restano dove sono.
2. **Il contenuto del foglio «Menu» diventa un componente.** `MenuRaggruppato` si estrae dal foglio di `BottomNav.tsx:331-420`, con `CambiaProfiloMenuButton` e `LogoutMenuButton`, e lo stesso vale per il docente. Il foglio dal basso resta identico sul telefono.
3. **Nuovo `src/components/features/shell/BarraLaterale.tsx`**, condiviso dalle due aree.
   - `hidden tablet:flex fixed left-0 bottom-0`, `top: var(--kv-appbar-h)`, larghezza `var(--kv-rail-w)`.
   - Binario: pillole e etichette, con gli stessi token della barra in basso (`PILL`, `text-kidville-sub` 6,46:1). La voce «Menu» apre `MenuRaggruppato` in un pannello accanto al binario. Restano la chiusura al cambio di rotta (render-adjust, non `useEffect`) e `Escape`.
   - Sidebar (da 1024 px): tab principali e tutti i gruppi in linea, profilo/esci in fondo, nessun bottone Menu.
   - Badge chat da `useBadgeChatNonLetti`. ⚠️ Prima va verificato che due istanze montate (barra nascosta e binario) non duplichino l'`id` della descrizione; se lo fanno, si genera l'id con `useId` dentro l'hook.
4. **Layout.**
   - `parent/layout.tsx` e `teacher/layout.tsx` montano `BarraLaterale` e spostano il contenuto con `tablet:pl-[var(--kv-rail-w)]`.
   - Il contenitore da 430 px diventa un client component `ColonnaContenuto`. Da 744 px applica una **colonna di lettura da 720 px** come base. Le rotte larghe si dichiarano in un solo elenco, `src/lib/ui/larghezza-pagina.ts` (per ora `/parent/chat`); una funzione pura le rende testabili.
   - Le 12 pagine docente sostituiscono `mx-auto max-w-[460px]` con una costante condivisa dallo stesso modulo (460 sul telefono, 720 da 744 px).
   - `teacher/layout.tsx:54` `pb-28` diventa `tablet:pb-8`.
   - `BottomNav`, `TeacherBottomNav` e i loro fogli prendono `tablet:hidden`.
5. **AppBar** (`AppBar.tsx:106-109`): il contenuto è oggi limitato a 430/460 px. Da 744 px va a tutta larghezza (`tablet:max-w-none tablet:px-6`), con il logo a sinistra e la campanella a destra.
6. **Elementi fissi centrati** (`teacher/tasks`, `teacher/modulistica` con `left-1/2 max-w-[460px]`): da 744 px si centrano sull'area di contenuto, con offset `var(--kv-rail-w)/2`.
7. **Test**:
   - **Unit**: dati di navigazione per grado (infanzia/primaria) e `larghezza-pagina`.
   - **Lock** `__tests__/architecture/colonna-tablet.test.ts`: nessun `max-w-[430px]` o `max-w-[460px]` letterale nelle pagine genitore/docente fuori dal modulo condiviso. Deve dichiarare quanti file scandisce (> 0) per non diventare un lock cieco.
   - I test esistenti di `BottomNav` restano verdi senza modifiche.
8. **E2E.**
   - Nuovo progetto `tablet` in `playwright.config.ts`: WebKit, `devices['iPad Mini']` (768 px, binario) e `devices['iPad Pro 11 landscape']` (1194 px, sidebar), con `retries: 0`.
   - Nuovo `e2e/tablet-layout.spec.ts` che su un elenco di rotte genitore e docente verifica:
     - prima di tutto l'**URL finale**, che non deve essere il login;
     - binario o sidebar visibile e barra in basso nascosta;
     - **nessuno scorrimento orizzontale** (`scrollWidth <= innerWidth`): conta doppio, perché in modalità desktop la WebView di iPad rimpicciolisce le pagine che sbordano;
     - una schermata allegata al report per ogni rotta.
   - Gli spec che usano la barra in basso (`parent-news`, `parent-attendance-tocco`, `impaginazione-media`) oggi girano a 1280 px, dove ora comparirebbe la sidebar. Si fissano a viewport telefono (`390×844`), perché provano il telefono.
   - Il crawler `contrasto` misurerà da solo la sidebar nuova.

### PR 2: le schermate chiave su più colonne (dopo il rilascio della PR 1)

Il piano di dettaglio si scrive **guardando le schermate tablet prodotte dall'E2E della PR 1**, non alla cieca. Il perimetro previsto:

- **Genitori**:
  - home: schede su 2–3 colonne;
  - galleria: griglia larga;
  - mensa: calendario e dettaglio affiancati;
  - pagamenti: elenco e riepilogo;
  - avvisi/news: 2 colonne;
  - diario: giornata e riepilogo.
- **Docenti**:
  - home;
  - appello: griglia dei bambini a 3–4 colonne;
  - diario: elenco dei bambini ed editor affiancati in orizzontale;
  - galleria.

Ogni pagina che si allarga entra in `larghezza-pagina.ts`.

### PR 3: segreteria su tablet

- **Sidebar a binario.** `AdminSidebar.tsx:52` si comprime a binario fra 744 e 1279 px e resta piena da 1280. Da 744 px:
  - `AdminTopBar` si mostra al posto di `AdminTopBarMobile`;
  - `AdminBottomNav` e `AdminMenuSheet` si nascondono.
- **Overlay.** La regola di `globals.css:406-410` (`left: 16rem`) passa a `left: var(--kv-rail-w)`.
- **Strette ad alta densità**:
  - doppia sidebar di `admin/impostazioni/page.tsx:187`;
  - `admin/students/page.tsx:762` a 5 colonne;
  - le tabelle `min-w-[820px]`/`[720px]` alla nuova larghezza utile.
- **Controlli solo-hover** (`DraggableField.tsx:132`, `SectionsView.tsx:264`, `MediaGrid.tsx:689`): visibili anche senza mouse (`[@media(hover:none)]:opacity-100`).
- **E2E.** Il progetto `tablet` aggiunge le rotte admin principali.

### Fuori perimetro

- La nuova build nativa (`preferredContentMode`) è esclusa per decisione di Luigi.
- Resta escluso anche il blocco `orientation: 'portrait'` di `manifest.ts`, che vale solo per la PWA installata.

## Regole del repo, in ogni PR

- **Branch**: `feat/ipad-tablet`, da `main`. Si rilascia una PR alla volta, perché più PR pubblicate di fila annullano gli E2E in coda. Dopo ogni rilascio si puliscono i branch e se ne crea uno nuovo.
- **PRD**: changelog datato in `PRD REGISTRO ELETTRONICO.md`. Nella PR 1 si allinea anche lo stato di #237 e #238, rimasto in sospeso.
- **Logging**: interventi solo grafici, senza route, integrazioni o percorsi d'errore nuovi, quindi nessun log nuovo. Lo si scrive esplicitamente nel PRD.
- **Design**: si salva in `docs/superpowers/specs/2026-10-18-ipad-tablet-design.md` come primo commit del branch.

## Verifica

1. **Gate locale**: `npx eslint . --max-warnings 0`, `npx tsc --noEmit` e `npm run build` (heap 8192, perché in locale vanno in OOM), più `npx vitest run`. Va controllata la riga `Test Files N passed`. Il nuovo lock va fatto fallire una volta di proposito, rimettendo un `max-w-[460px]`.
2. **CI**: tutti i job verdi, compresi `tablet` e `contrasto`, **contando i retry**.
3. **Schermate**: si scaricano dal report HTML dell'E2E (`gh run download`), si guardano una per una e si mandano a Luigi con `SendUserFile` prima del merge.
4. **Dopo il deploy**: app nativa sul simulatore iPad Pro 13" (`1C7C9324-…`), che carica la produzione, in verticale e in orizzontale. Il login lo fa Luigi, oppure lo si prova su un iPad vero.
