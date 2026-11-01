# Menu della segreteria a 7 voci, a fisarmonica: piano di implementazione

> **Per chi esegue:** usare superpowers:executing-plans (consigliato qui) oppure
> superpowers:subagent-driven-development. I passi usano le caselle (`- [ ]`).

**Obiettivo:** il menu del cockpit Direzione/Segreteria passa da 27 voci in 7 gruppi (33 righe) a
**7 voci di primo livello**: Home e Anagrafica come link diretti, più 5 gruppi che si aprono a
fisarmonica. **Nessuna pagina cambia.**

**Architettura:** la sorgente unica resta `admin-nav-config.ts`, cioè `NAV_GROUPS`, riordinata nei
nuovi gruppi, con un'icona per ogni gruppo e due funzioni pure in più. Un hook condiviso
(`useGruppoAperto`) tiene aperto un gruppo alla volta. I due punti che disegnano i gruppi, la
sidebar del computer (`AdminSidebar`) e il foglio/pannello «Menu» di telefono e tablet
(`AdminMenuSheet`), mostrano un'intestazione-bottone per gruppo invece del titolo fisso. La barra in
basso e il binario del tablet non cambiano.

**Stack:** Next.js (App Router), React client components, next-intl, lucide-react, Tailwind,
framer-motion, Vitest e Testing Library.

**Specifica:** la sezione «Design» qui sotto. Al primo passo viene copiata in
`docs/superpowers/specs/2026-10-31-menu-segreteria-7-voci-design.md`, e questo piano in
`docs/superpowers/plans/2026-10-31-menu-segreteria-7-voci.md`.

**Esecuzione:** nativa. Implemento io i 4 task in questa sessione, poi un revisore nuovo legge
l'intero branch. I task dipendono uno dall'altro (config → sidebar → foglio), sono pochi, e un
errore si vede subito a schermo e si corregge con un commit. Quattro revisori separati costerebbero
più del rischio che coprono.

---

## Contesto

Luigi (31/10/2026): *«Il menu della segreteria è diventato troppo lungo e disordinato. Voglio
poche voci e accorpare quanto più possibile con un menu che poi possa aprire il sottomenu. Non
dobbiamo toccare nessuna pagina, solo il menu.»*

Oggi il gruppo «Amministrazione» da solo contiene 10 voci scollegate (Contabilità, CRM, Privacy,
Moderazione…). Le voci sono cresciute una PR alla volta, ognuna aggiunta dove c'era posto.

## Design (corto)

**Le scelte di Luigi, prese in questa conversazione:**
- **7 voci di primo livello**, raggruppate per tipo di lavoro (scelta fra 7 e 9 voci):

| Voce | Tipo | Contenuto, in quest'ordine |
|---|---|---|
| Home | link diretto | `/admin` |
| Anagrafica | link diretto | `/admin/students` |
| **Registro** | gruppo | Appello · Diario 0–6 · Primaria · Competenze · Galleria |
| **Comunicazione** | gruppo | Messaggi · Avvisi · News · Compiti · Moderazione |
| **Contabilità e servizi** | gruppo | Contabilità · Coda fatture · Mensa · Report Cucina · Armadietto · Merchandise |
| **Segreteria** | gruppo | CRM · Candidature · Modulistica · Documenti firmati · Protocollo · Storici e stampe |
| **Impostazioni** | gruppo | Impostazioni · Strumenti · Privacy & GDPR |

- **Fisarmonica** (scelta al posto della comparsa laterale): le voci si aprono sotto
  l'intestazione e si apre un gruppo alla volta. All'arrivo su una pagina si apre il suo gruppo.
  Stesso comportamento su computer, pannello del tablet e foglio del telefono.

**Approcci considerati:** fisarmonica (scelta), comparsa laterale (scartata: sull'iPad in
orizzontale, cioè il menu che Luigi usa di più, il «passa sopra» non esiste, il riquadro copre la
pagina e sul telefono servirebbe comunque la fisarmonica), barra a icone con seconda colonna
(scartata: cambierebbe la larghezza del menu, messa a posto il 18/10 e sorvegliata da
`menu-desktop-in-orizzontale.test.ts`).

**Scelte mie, da controllare leggendo:**
1. In «Segreteria» l'ordine è **CRM · Candidature · Modulistica**, non CRM · Modulistica ·
   Candidature come nell'anteprima: così restano veri i due lock del 17/10 e del 30/10
   (Candidature subito sopra Modulistica, CRM subito sopra Candidature).
2. **«Dashboard» diventa «Home»** nella sidebar, come nell'anteprima approvata e come già si
   chiama nella barra in basso. Cambia solo il valore di `nav_dashboard`, non la chiave.
3. Toccare l'intestazione **apre o chiude** il gruppo, non porta a nessuna pagina.
4. A gruppo **chiuso**, il gruppo che contiene la pagina aperta ha l'intestazione evidenziata («sei
   qui»). A gruppo **aperto** l'evidenza resta sulla voce, come oggi.
5. Il numero della **Coda fatture** compare sull'intestazione di «Contabilità e servizi» **solo a
   gruppo chiuso**. A gruppo aperto sta accanto alla voce, come oggi, senza doppioni.
6. Il gruppo della pagina si calcola sulla config intera, non sulle voci filtrate per ruolo. Al
   primo render il ruolo vale `null`, e il gruppo non deve «saltare» quando il ruolo arriva.
7. Lo stato aperto/chiuso **non** si salva nel browser: nessun `localStorage`, quindi nessun rischio
   di differenze fra server e client all'idratazione.
8. Nel foglio del telefono le voci già presenti nei tab in basso (Home, Avvisi, Contabilità, Mensa)
   e Anagrafica (in evidenza in cima) restano escluse dai gruppi, come oggi. Se la pagina aperta è
   uno di quei tab, nel foglio non si apre nessun gruppo: la voce accesa è già il tab.
9. I titoli dei gruppi abbandonati spariscono da `etichette` (it ed en) senza riordinare il resto
   del catalogo.

**Fuori perimetro:** le pagine, la barra in basso (`AdminBottomNav`, `tab-admin.ts`), il binario
del tablet (`AdminBinario`), le larghezze del menu, il selettore della sede nel foglio.

## Vincoli globali

- **Lingua:** tutto in italiano (etichette, commenti, messaggi di commit, PRD). Catalogo `en`
  allineato al `it` (lock `messaggi-parita-cataloghi`).
- **Branch:** si continua su `chore/piano-approvato-a-mano` (PR #272 aperta, non mergiata). Regola
  1 di `AGENTS.md`: niente branch nuovo prima di un deploy riuscito. La descrizione della PR #272 va
  aggiornata perché copra anche il menu. Il merge lo fa il titolare.
- **PRD:** voce di changelog datata in cima a `PRD REGISTRO ELETTRONICO.md` (regola 2 di
  `AGENTS.md`).
- **Logging:** questo intervento non aggiunge route, integrazioni esterne né percorsi d'errore, quindi
  non servono log nuovi. Va scritto esplicitamente nel PRD.
- **Colori solo da token** (`bg-kidville-*`, `text-kidville-*`) in `features/admin/**` (lock
  `design-tokens-admin`). Niente hex fuori da `globals.css`.
- **Niente `setState` dentro `useEffect`** (regola `react-hooks/set-state-in-effect`): il cambio di
  pagina si gestisce aggiustando lo stato durante il render, come fa già `AdminBinario.tsx:63-67`.
- **Il gate vero resta nelle API:** i `roles` delle voci non cambiano, si spostano solo le voci.
- **Read, non `cat`**, per leggere i file (le regole di `.claude/rules/` si attivano sul Read).

## Punti da sorvegliare in revisione

1. **Le fatture in attesa non devono sparire a gruppo chiuso.** Il numero passa sull'intestazione
   (test nel Task 2).
2. **Cambio di pagina da dentro una pagina** (link, tasto Indietro) verso una pagina di un altro
   gruppo: il menu segue e apre il nuovo gruppo (test di rerender nel Task 2).
3. **Ruolo che arriva in due tempi** (`null` al primo render, poi `segreteria`): il gruppo aperto
   non cambia e le voci riservate compaiono (test nel Task 2).
4. **Foglio del telefono su una pagina-tab** (`/admin/mensa`): nessun gruppo aperto, nessuna voce
   ripetuta (test nel Task 3).
5. **Tastiera e lettori di schermo:** l'intestazione è un vero `<button type="button">` con
   `aria-expanded`. Nel foglio il focus-trap la attraversa: `FOCUSABLE` include già `button`. Va
   aggiunto un test nel Task 3 che conti l'intestazione fra gli elementi raggiungibili.

## File

| File | Cosa cambia |
|---|---|
| `src/components/features/admin/admin-nav-config.ts` | `NAV_GROUPS` a 7 voci, `icon` sul gruppo, `gruppoDellaPagina`, `gruppiVisibili`; i commenti che dicono «qui sopra»/«sotto» vanno riscritti dove l'ordine cambia |
| `src/components/features/admin/use-gruppo-aperto.ts` | **nuovo**: hook di stato della fisarmonica |
| `src/components/features/admin/AdminSidebar.tsx` | intestazioni-bottone, voci rientrate, contatore sull'intestazione |
| `src/components/features/admin/AdminMenuSheet.tsx` | stessa fisarmonica nel foglio e nel pannello |
| `src/app/globals.css` | una regola di Alto Contrasto per l'intestazione «sei qui» (vicino alla riga 1721) |
| `messages/it/etichette.json`, `messages/en/etichette.json` | 4 titoli di gruppo nuovi, 5 tolti, `nav_dashboard` → «Home» |
| `__tests__/ui/admin-nav-config.test.ts` | lock della struttura a 7 voci, gruppo di CRM e Candidature → `navgruppo_segreteria` |
| `__tests__/ui/admin-menu-fisarmonica.test.tsx` | **nuovo**: comportamento della fisarmonica, sidebar e foglio |
| `__tests__/components/coda/contatore-menu-coda-fatture.test.tsx` | il contatore sta sull'intestazione a gruppo chiuso |
| `__tests__/ui/admin-binario.test.tsx:140` | nel pannello «Impostazioni» è un bottone di gruppo, non più un link |
| `PRD REGISTRO ELETTRONICO.md` | changelog |

---

### Task 1: La config a 7 voci

**File:**
- Modifica: `src/components/features/admin/admin-nav-config.ts`
- Modifica: `messages/it/etichette.json`, `messages/en/etichette.json`
- Test: `__tests__/ui/admin-nav-config.test.ts`
- Crea: `docs/superpowers/specs/2026-10-31-menu-segreteria-7-voci-design.md` (la sezione Design qui sopra) e `docs/superpowers/plans/2026-10-31-menu-segreteria-7-voci.md` (questo file)

**Interfacce prodotte:**
- `NavGroup.icon?: LucideIcon`: presente su ogni gruppo con titolo, assente sui link diretti (`title: null`).
- `gruppoDellaPagina(current: string, escludi?: ReadonlySet<string>): string | null`: dato l'href
  già risolto da `activeHref`, restituisce il `titleKey` del gruppo con titolo che lo contiene,
  cercando su `NAV_GROUPS` **senza** filtro per ruolo e saltando gli href in `escludi`. Restituisce
  `null` per i link diretti, per gli href esclusi e per gli href sconosciuti.
- `gruppiVisibili(ruolo: string | null | undefined, escludi?: ReadonlySet<string>): NavGroup[]`:
  `NAV_GROUPS` con le voci filtrate da `visibleItem` e da `escludi`, senza i gruppi rimasti vuoti.

- [ ] **Passo 1: copiare spec e piano in `docs/superpowers/`** (i due file sopra).

- [ ] **Passo 2: scrivere i test che falliscono** in `admin-nav-config.test.ts`:

```ts
const ATTESO: [string | null, string[]][] = [
  [null, ['/admin']],
  [null, ['/admin/students']],
  ['navgruppo_registro', ['/admin/appello', '/admin/diary', '/admin/primaria', '/admin/competenze', '/admin/gallery']],
  ['navgruppo_comunicazione', ['/admin/messaggi', '/admin/avvisi', '/admin/news', '/admin/compiti', '/admin/moderazione']],
  ['navgruppo_contabilita_servizi', ['/admin/pagamenti', '/admin/coda-fatture', '/admin/mensa', '/admin/mensa/cucina', '/admin/armadietto', '/admin/merchandise']],
  ['navgruppo_segreteria', ['/admin/crm', '/admin/candidature', '/admin/modulistica', '/admin/documenti-firmati', '/admin/protocolli', '/admin/storici']],
  ['navgruppo_impostazioni', ['/admin/impostazioni', '/admin/tools', '/admin/gdpr']],
];
it('7 voci di primo livello, nell\'ordine e col contenuto decisi il 31/10', () => {
  expect(NAV_GROUPS.map((g) => [g.titleKey ?? null, g.items.map((i) => i.href)])).toEqual(ATTESO);
});
it('nessuna voce persa: le stesse 27 rotte di prima', () => {
  expect(ALL_HREFS).toHaveLength(27);
  expect(new Set(ALL_HREFS).size).toBe(27);
});
it.each(['it', 'en'])('link diretti con una voce sola; ogni gruppo con titolo ha icona e titolo nel catalogo %s', async (lingua) => {
  const catalogo = (await import(`../../messages/${lingua}/etichette.json`)).default as Record<string, unknown>;
  for (const g of NAV_GROUPS) {
    if (g.title === null) { expect(g.items).toHaveLength(1); expect(g.icon).toBeUndefined(); continue; }
    expect(g.icon).toBeDefined();
    expect(typeof catalogo[g.titleKey!]).toBe('string');
  }
});
it.each([
  ['/admin', null], ['/admin/students', null],
  ['/admin/mensa/cucina', 'navgruppo_contabilita_servizi'], ['/admin/protocolli', 'navgruppo_segreteria'],
  ['/admin/qualcosa-che-non-esiste', null],
])('gruppoDellaPagina(%s) = %s', (href, atteso) => expect(gruppoDellaPagina(href)).toBe(atteso));
it('gruppoDellaPagina ignora gli href esclusi', () => {
  expect(gruppoDellaPagina('/admin/mensa', new Set(['/admin/mensa']))).toBeNull();
});
it('gruppiVisibili toglie un gruppo rimasto vuoto', () => {
  const g = gruppiVisibili('segreteria', new Set(['/admin/impostazioni', '/admin/tools', '/admin/gdpr']));
  expect(g.map((x) => x.titleKey)).not.toContain('navgruppo_impostazioni');
});
it('gruppiVisibili nasconde alla cuoca CRM, Candidature, Protocollo e Storici', () => {
  const seg = gruppiVisibili('cuoca').find((g) => g.titleKey === 'navgruppo_segreteria')!;
  expect(seg.items.map((i) => i.href)).toEqual(['/admin/modulistica', '/admin/documenti-firmati']);
});
```

  Nei due `describe` già esistenti su Candidature e CRM, il gruppo diventa
  `navgruppo_segreteria` (al posto di `navgruppo_amministrazione`) e anche i titoli dei `describe`
  vanno aggiornati. Le asserzioni di posizione restano le stesse.

- [ ] **Passo 3: lanciare e vedere rosso**: `npx vitest run __tests__/ui/admin-nav-config.test.ts`
  → FAIL sui test nuovi. Controllare che la riga `Test Files 1` dica 1.

- [ ] **Passo 4: implementare.** Riordinare `NAV_GROUPS` secondo `ATTESO`, voci identiche a oggi
  (stessi `href`, `labelKey`, `icon`, `roles`). Titoli e icone dei gruppi: Registro
  `NotebookPen`, Comunicazione `MessagesSquare`, Contabilità e servizi `Wallet`, Segreteria
  `FolderOpen`, Impostazioni `Settings`. Aggiungere `gruppoDellaPagina` e `gruppiVisibili`, e
  aggiornare il commento di testa del file. In `etichette.json` (it/en):
  - aggiungere `navgruppo_registro` (Registro / Register), `navgruppo_contabilita_servizi`
    (Contabilità e servizi / Accounts & services), `navgruppo_segreteria` (Segreteria / Office),
    `navgruppo_impostazioni` (Impostazioni / Settings);
  - togliere `navgruppo_anagrafica`, `navgruppo_didattica`, `navgruppo_operativo`,
    `navgruppo_amministrazione`, `navgruppo_sistema`;
  - `nav_dashboard` diventa «Home» in tutte e due le lingue.

  Le chiavi nuove vanno nel punto dove stavano le vecchie, senza riordinare il resto del catalogo.

- [ ] **Passo 5: verde**: `npx vitest run __tests__/ui/admin-nav-config.test.ts __tests__/ui/news-nav-config.test.ts`
  → `Test Files 2 passed`.

- [ ] **Passo 6: commit**: `Menu segreteria: 7 voci di primo livello nella config condivisa`.

### Task 2: La sidebar a fisarmonica

**File:**
- Crea: `src/components/features/admin/use-gruppo-aperto.ts`
- Modifica: `src/components/features/admin/AdminSidebar.tsx`
- Test: `__tests__/ui/admin-menu-fisarmonica.test.tsx` (nuovo), `__tests__/components/coda/contatore-menu-coda-fatture.test.tsx`

**Interfacce:**
- Usa dal Task 1: `gruppoDellaPagina`, `gruppiVisibili`, `NavGroup.icon`.
- Produce: `useGruppoAperto(pathname: string, escludi?: ReadonlySet<string>): { aperto: string | null; alterna: (chiave: string) => void }`.
  - Valore iniziale: `gruppoDellaPagina(activeHref(pathname), escludi)`.
  - Cambio di `pathname`: `aperto` diventa il gruppo della nuova pagina (`null` sui link diretti).
    Lo stato si aggiusta durante il render, come `AdminBinario.tsx:63-67`.
  - `alterna(k)`: se `k` è aperto lo chiude, altrimenti apre `k` e chiude l'altro.

- [ ] **Passo 1: scrivere i test che falliscono**: `admin-menu-fisarmonica.test.tsx`. Gli stub di
  `usePathname`, `useAdminIdentity` e `useTranslations` sono `vi.hoisted`, come in
  `admin-binario.test.tsx`.
  - `a /admin/mensa è aperto solo «Contabilità e servizi», e Mensa è la pagina corrente`: il bottone
    `/contabilità e servizi/i` ha `aria-expanded="true"`, gli altri 4 `"false"`; il link «Mensa» ha
    `aria-current="page"`; `queryByRole('link', { name: 'Protocollo' })` è `null`.
  - `toccare «Segreteria» la apre e chiude «Contabilità e servizi»`: dopo il clic compare il link
    «Protocollo» e sparisce il link «Mensa».
  - `toccare il gruppo aperto lo chiude, e l'intestazione dice «sei qui»`: dopo il clic
    `aria-expanded="false"` e `data-contiene-pagina="true"`.
  - `cambio di pagina ⇒ si apre il gruppo della nuova pagina`: rerender con `/admin/protocolli`,
    «Segreteria» aperta.
  - `a /admin nessun gruppo aperto; Home e Anagrafica sono link diretti`: link «Home» con
    `aria-current="page"`, link «Anagrafica» presente, nessun bottone con `aria-expanded="true"`.
  - `ruolo che arriva in due tempi`: con `ruolo: null` a `/admin/protocolli`, «Segreteria» è aperta
    e il link «Protocollo» non c'è; rerender con `segreteria`, il gruppo resta aperto e il link
    «Protocollo» compare.
  - `l'intestazione è un <button type="button">`: verifica di `tagName` e attributo `type`.

  In `contatore-menu-coda-fatture.test.tsx`:
  - il primo test (pathname `/admin`) si aspetta il contatore **dentro il bottone** di «Contabilità
    e servizi», con `closest('button')` al posto di `closest('a')`, e lo stesso testo
    `6 voci attive in coda`;
  - nuovo test: a `/admin/coda-fatture` il contatore sta nel link `/admin/coda-fatture` e
    sull'intestazione non c'è;
  - il test «lettura fallita ⇒ la voce resta» si aspetta il bottone «Contabilità e servizi» al posto
    del testo «Coda fatture»;
  - il test della cuoca si aspetta anche `queryByTestId('contatore-coda-fatture')` uguale a `null`.

- [ ] **Passo 2: lanciare e vedere rosso**: `npx vitest run __tests__/ui/admin-menu-fisarmonica.test.tsx __tests__/components/coda/contatore-menu-coda-fatture.test.tsx`.

- [ ] **Passo 3: scrivere `use-gruppo-aperto.ts`** con la firma qui sopra.

- [ ] **Passo 4: riscrivere il corpo di `AdminSidebar`.** Le voci vengono da `gruppiVisibili(ruolo)`.
  - Link diretti (`title: null`): restano identici a oggi, compresa la pillola `motion.span
    layoutId="admin-nav-active"`.
  - Gruppo: `<button type="button">` con icona, titolo (`te(titleKey)`, con fallback a `title`) e
    una `ChevronDown` che ruota a gruppo aperto. Attributi `aria-expanded` e `aria-controls`, con id
    da `useId()` perché sidebar e foglio possono stare entrambi nel DOM.
    `data-contiene-pagina={!aperto && contiene ? 'true' : undefined}` e, nello stesso stato, le
    classi `bg-kidville-green-soft text-kidville-green`.
  - Se il gruppo contiene `CODA_FATTURE_HREF` visibile ed è chiuso, l'intestazione mostra
    `<ContatoreCodaFatture n={vociCoda} />`.
  - Gruppo aperto: `<div id role="group" aria-labelledby>` con le voci, rientrate di circa 12 px e
    con la stessa riga di oggi (icona, etichetta, pillola, contatore sulla voce). Gruppo chiuso: le
    voci non sono nel DOM.

  Il resto della sidebar non cambia: geometria, classi `lg:` (lock
  `menu-desktop-in-orizzontale`), z-index (lock `cockpit-drawer-a11y`) e «Esci» in fondo.

- [ ] **Passo 5: verde**: stesso comando del Passo 2 → `Test Files 2 passed`. Poi rompere di
  proposito `alterna` (che non chiude più l'altro gruppo) e vedere rosso il secondo test; infine
  ripristinare.

- [ ] **Passo 6: commit**: `Menu segreteria: la sidebar si apre a fisarmonica, un gruppo alla volta`.

### Task 3: Il foglio e il pannello «Menu» a fisarmonica

**File:**
- Modifica: `src/components/features/admin/AdminMenuSheet.tsx`
- Test: `__tests__/ui/admin-menu-fisarmonica.test.tsx`, `__tests__/ui/admin-binario.test.tsx:140`

**Interfacce:** usa `useGruppoAperto(pathname, ESCLUSI)` e `gruppiVisibili(ruolo, ESCLUSI)`.
`ESCLUSI` resta quello di oggi (`AdminMenuSheet.tsx:92-94`). Il `pathname` viene da `usePathname()`.

- [ ] **Passo 1: test che falliscono** (stesso file del Task 2, `describe('foglio «Menu»')`, che
  renderizza `<AdminMenuSheet open … />`):
  - `a /admin/coda-fatture si apre «Contabilità e servizi», senza Contabilità e Mensa che sono già
    nei tab`;
  - `a /admin/mensa nessun gruppo aperto` (la pagina è un tab);
  - `toccare un gruppo non chiude il foglio; toccare una voce sì` (`onClose` chiamato solo nel
    secondo caso);
  - `l'intestazione è fra gli elementi del focus-trap`: `dialog.querySelectorAll(FOCUSABLE)`
    contiene il bottone di gruppo.

  In `admin-binario.test.tsx:140` l'asserzione diventa
  `within(dialog).getByRole('button', { name: /impostazioni/i })`.

- [ ] **Passo 2: rosso**: `npx vitest run __tests__/ui/admin-menu-fisarmonica.test.tsx __tests__/ui/admin-binario.test.tsx`.

- [ ] **Passo 3: implementare.** Nel blocco dei gruppi (`AdminMenuSheet.tsx:280-305`) va la stessa
  intestazione-bottone del Task 2, con lo stile `ROW_CLS` del foglio. Le voci aperte restano le
  righe di oggi, con chevron a destra e `onClick={onClose}`. Il contatore va sull'intestazione a
  gruppo chiuso. Gli hook vanno chiamati **prima** di `if (!open) return null` (riga 168).
  Restano come sono la sede in cima, Anagrafica in evidenza e i pulsanti in fondo.

- [ ] **Passo 4: verde**: stesso comando → `Test Files 2 passed`. Poi
  `npx vitest run __tests__/ui/admin-bottom-nav.test.tsx __tests__/ui/cambia-profilo-nei-menu.test.tsx __tests__/components/sede-mobile-e-ricarica.test.tsx`
  → verdi.

- [ ] **Passo 5: commit**: `Menu segreteria: anche il foglio del telefono e il pannello del tablet a fisarmonica`.

### Task 4: Alto contrasto, PRD, gate e verifica a schermo

**File:**
- Modifica: `src/app/globals.css`, accanto a `[data-contrast="high"] .kv-admin-nav a[aria-current="page"]` (~riga 1721)
- Modifica: `PRD REGISTRO ELETTRONICO.md`

- [ ] **Passo 1: Alto Contrasto.** Aggiungere
  `[data-contrast="high"] .kv-admin-nav button[data-contiene-pagina="true"]` e la stessa regola per
  `.kv-admin-sheet`: `border-left: 4px solid #000000`. Usare un bordo e non `outline`, per non
  interferire con l'anello del fuoco. Poi lanciare `npx vitest run __tests__/a11y` → verde.

- [ ] **Passo 2: PRD.** Nuova voce in cima: `## 🧭 Changelog — Menu della segreteria a 7 voci, a
  fisarmonica — 2026-10-31 (branch \`chore/piano-approvato-a-mano\`)`. Dentro: tabella prima/dopo
  (33 righe → 7 voci), le 9 scelte mie, «nessuna pagina toccata», «nessun log nuovo: niente route,
  integrazioni o percorsi d'errore», l'elenco dei test cambiati.

- [ ] **Passo 3: gate completo**, ognuno letto dal proprio esito e non dalla coda di una pipe:
  `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` ·
  `NODE_OPTIONS=--max-old-space-size=8192 npm run build`.

- [ ] **Passo 4: verifica a schermo.** `preview_start` con `kidville-collaudo` (:3100, identità da
  header, sede Demo, ricetta in memoria `ricetta_collaudo_firma_otp_sede_demo.md`). **Solo
  navigazione, nessun salvataggio**: il server locale parla col DB di produzione. Screenshot di
  `/admin/mensa` a 1280 px (sidebar: «Contabilità e servizi» aperto), a 800 px (pannello del
  binario aperto) e a 390 px (foglio aperto). Poi un clic su «Segreteria» e lo screenshot del cambio.
  Controllare la console: nessun avviso di idratazione.

- [ ] **Passo 5: commit e push** su `chore/piano-approvato-a-mano`, poi aggiornare titolo e
  descrizione della PR #272 perché coprano anche il menu. Il merge **non** lo fa Claude: lo fa il
  titolare.

---

## Verifica, da capo a fondo

1. `npx vitest run __tests__/ui/admin-nav-config.test.ts __tests__/ui/admin-menu-fisarmonica.test.tsx __tests__/components/coda/contatore-menu-coda-fatture.test.tsx __tests__/ui/admin-binario.test.tsx`
   → `Test Files 4 passed`.
2. Gate completo verde: eslint, tsc, vitest, build.
3. Screenshot delle tre larghezze, con il gruppo della pagina aperto e un gruppo solo alla volta.
4. CI della PR #272 verde su **tutti** i job, E2E compresi. ⚠️ Correzione dopo la revisione finale: la
   frase scritta qui, «gli E2E non cliccano le voci dei gruppi», era falsa. Tre E2E cercavano voci che
   ora stanno in gruppi chiusi: `admin-candidature.spec.ts` (voce Candidature dalla Home) e
   `tablet-layout.spec.ts` (più di 8 link nella sidebar; «Impostazioni» come link nel pannello).
   Sono stati aggiornati: aprono il gruppo prima di cercare la voce.
