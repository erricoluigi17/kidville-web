# Candidature: voce propria nella sidebar, dettaglio fisso, filtri multipli per ruolo ed etichetta

## Contesto

Oggi le candidature («Lavora con noi», ~460+ CV, decine di pagine) sono la 4ª linguetta di
`/admin/modulistica?tab=candidature`. Tre problemi segnalati dal titolare:

1. **Il dettaglio "salta in alto".** Cliccando una candidatura dopo aver scorso la lista, la pagina
   torna su. Cause misurate:
   - il pannello sta in cima alla colonna destra di `grid gap-5 md:grid-cols-2`
     (`CandidatureInsegnanti.tsx:1811`) senza `sticky`;
   - `PannelloDettaglio` fa `titoloRef.current?.focus()` **senza `preventScroll`**
     (`CandidatureInsegnanti.tsx:2320`), quindi il browser scrolla fino all'`h2`.

   Sul telefono il dettaglio finisce in fondo a tutta la lista; il commento a 2313-2317 dice che
   «sostituisce l'elenco», ma il codice non lo fa. Stesso difetto in `ModuliRicevuti.tsx:549`.
2. **Filtri scomodi.**
   - «Posizione» c'è, ma non è `primario`: sta nascosto nel pulsante «⚙ Filtri».
   - «Etichetta» è un `<select>` a parte sotto la barra.
   - Entrambi accettano una sola voce.
3. **Le candidature non sono in sidebar**: stanno sepolte in Modulistica.

Esito voluto: scorrere 50-100 CV con il dettaglio sempre visibile; filtrare per più posizioni e
più etichette insieme; «Candidature» come voce del menu principale.

**Decisioni del titolare (17/10):**
- filtri in vista e a **scelta multipla**;
- sul telefono **foglio a tutto schermo**;
- voce nel gruppo **Amministrazione**;
- correzione anche su **Moduli ricevuti**.

**Branch:** si continua su `fix/storici-impaginazione`. Ha 1 commit non ancora pubblicato
(`d8d6c2e9`), quindi non c'è stato un deploy dopo il quale aprire un branch nuovo (regola AGENTS
n. 1). I due lavori usciranno nella stessa PR.

Prima riga del lavoro: salvare questo design in
`docs/superpowers/specs/2026-10-17-candidature-sidebar-pannello-fisso-design.md`, come da
brainstorming.

---

## 1. «Candidature» diventa una voce della sidebar

- **Pagina nuova** `src/app/(dashboard)/admin/candidature/page.tsx`, ricalcata su
  `src/app/(dashboard)/admin/coda-fatture/page.tsx`:
  - `CockpitPage` + `PageHeader` (eyebrow `adminAltro.eyebrowAmministrazione`);
  - titolo e sottotitolo nuovi in `adminAltro` (`candPageTitolo`, `candPageSottotitolo`, it + en);
  - `<Suspense fallback={null}><CandidatureInsegnanti /></Suspense>`. Lo richiede il lock
    `use-search-params-con-suspense`, perché `useFiltri` legge `useSearchParams`.
- **Voce in `src/components/features/admin/admin-nav-config.ts`**, gruppo Amministrazione, subito
  sopra Modulistica (riga 136):
  `{ href: '/admin/candidature', label: 'Candidature', labelKey: 'nav_candidature', icon: UserCheck, roles: ['admin','coordinator','segreteria'] }`.
  - I ruoli sono gli stessi di `requireStaff` sulla GET: la cuoca non vede una voce che le
    risponderebbe 403.
  - Sidebar desktop e foglio «Menu» mobile leggono la stessa config, quindi la voce compare in
    entrambi senza altro codice.
- **Testi da aggiungere:**
  - `nav_candidature` in `messages/{it,en}/etichette.json`;
  - `"candidature"` in `messages/{it,en}/offline.json` → `etichette.segmenti` (lock
    `offline-etichette-rotte`).
- **Riferimenti da aggiornare:**
  - `ROUTE_LOG = '/admin/candidature'` in `CandidatureInsegnanti.tsx:227`;
  - `/admin/candidature` con `inNav` in `e2e/primaria-360/config/coverage-matrix.ts`.

## 2. Via la linguetta da Modulistica, senza rompere i link vecchi

- **`src/app/(dashboard)/admin/modulistica/page.tsx`:**
  - togliere `candidature` da `TAB_ORDINE` (riga 110);
  - togliere il ramo 568-569 e l'import a riga 19;
  - togliere la chiave `modTabCandidature` da it ed en, sennò diventa orfana (lock
    `messaggi-chiavi-orfane`);
  - riscrivere `modPageSubtitle` senza «candidature».
  - La card «Lavora con noi» (link pubblico, `ModuliInviabili.tsx:155`) resta dov'è.
- **Link vecchi.** Nel database ci sono ~1.000 notifiche `candidatura_ricevuta` con il link
  `/admin/modulistica?tab=candidature`, usato da campanella, push e service worker.
  - Rimedio: `redirects()` in `next.config.ts` con `source: '/admin/modulistica'`,
    `has: [{ type: 'query', key: 'tab', value: 'candidature' }]`,
    `destination: '/admin/candidature'`, `permanent: false`.
  - La doc installata conferma che le query passano alla destinazione
    (`node_modules/next/dist/docs/.../redirects.md:43`), quindi anche i filtri nel link
    sopravvivono.
  - Si fa nel server e non con un `tabParam === '…'` nella pagina, che il lock
    `modulistica-linguette-raggiungibili` vieta.
  - Test nuovo: legge `redirects()` da `next.config.ts` e verifica la regola, con il perché scritto
    accanto.
- **Notifiche nuove:** `LINK_COCKPIT` in `src/app/api/iscrizione/insegnanti/route.ts:79` diventa
  `/admin/candidature`. Da aggiornare anche `__tests__/api/candidature-insegnanti-post.test.ts:725`.
- **Test da riallineare:**
  - `__tests__/pages/admin-modulistica-linguette.test.tsx`: da 7 a 6 linguette; togliere mock e
    voci `candidature` (74, 95, 218, 258);
  - `replaceState('/admin/modulistica?tab=candidature')` va sostituito con il percorso nuovo in
    `CandidatureInsegnanti-filtri-paginazione.test.tsx:192` e
    `CandidatureInsegnanti-etichetta.test.tsx:143`.

## 3. Dettaglio fisso a destra (computer) e foglio a tutto schermo (telefono)

Un pezzo condiviso, usato da Candidature e da Moduli ricevuti.

- **Hook** `src/lib/ui/use-schermo-largo.ts`:
  - `useSyncExternalStore` su `matchMedia('(min-width: 1024px)')`;
  - snapshot server e assenza di `matchMedia` (jsdom) valgono `true`. Così il rendering iniziale e
    i test esistenti restano nel ramo «colonna», e i 5 test che cercano `[aria-busy]` non cambiano.
- **Componente** `src/components/ui/ColonnaDettaglio.tsx`, props
  `{ aperto, onChiudi, titolo, occupato, segnaposto, chiaveContenuto, children }`:
  - **Schermo largo:**
    `<div aria-busy={occupato || undefined} className="lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto overscroll-contain">`.
    - `top-20` = barra `AdminTopBar` `h-16` (`sticky top-0`) + margine.
    - A ogni cambio di `chiaveContenuto` lo scorrimento interno torna a 0.
    - Senza selezione mostra `segnaposto` (oggi «Seleziona una candidatura»).
  - **Schermo stretto:**
    - nulla se `!aperto`: il segnaposto sotto la lista non serve;
    - se `aperto`, `<Drawer open onClose={onChiudi} title={titolo}>` (`src/components/ui/cockpit.tsx:311`),
      che ha già fuoco intrappolato, Escape e ritorno del fuoco alla riga cliccata. La lista sotto
      non si muove, quindi chiudendo si torna esattamente dov'eri.
    - Va verificato che il `Drawer` sia a piena larghezza sotto i 560px. Se non lo è, si aggiunge
      una prop.
- **In `CandidatureInsegnanti.tsx`:**
  - griglia `grid gap-5 lg:grid-cols-2 lg:items-start`;
  - la colonna dettaglio (1986-2039) diventa `<ColonnaDettaglio aperto={!!selezionata || aprendo !== null} …>`;
  - in `PannelloDettaglio` (2320): `focus({ preventScroll: true })`;
  - bottone «Indietro» da `md:hidden` a `lg:hidden`;
  - correggere il commento falso (2313-2317).
  - Scelta: da 768 a 1023 px non si tengono le due colonne. Lì la barra in alto è quella mobile,
    ad altezza variabile, e lo `sticky` ci finirebbe sotto; quelle larghezze usano il foglio.
- **Stessa cosa in `ModuliRicevuti.tsx`:** griglia a 549, colonna dettaglio, `focus` del suo
  pannello, «Indietro» a 721.

## 4. Filtri per ruolo ed etichetta: in vista e a scelta multipla

- **Posizione (filtro del server):**
  - In `src/components/features/admin/iscrizioni/filtri-candidature.ts` (≈144) il campo `posizione`
    diventa `tipo: 'multi'`, `primario: true`, `dove: 'server'`.
    - Il motore lo scrive già come `?posizione=a,b` (`src/lib/ui/filtri/motore.ts:230`).
    - Su computer va nella riga principale come pastiglie spuntabili (`BarraFiltri.tsx:164`).
    - Sul telefono resta nel foglio «Filtri», come ogni campo non-`chip` di tutte le pagine
      (`BarraFiltri.tsx:341`). Non si cambia la regola condivisa.
  - Route `src/app/api/admin/candidature-insegnanti/route.ts`:
    - `getQuerySchema.posizione` (415) accetta una lista separata da virgole, senza doppioni, di
      valori in `POSIZIONI_AMMESSE`, da 1 a 7 voci. Un valore singolo resta valido, quindi i link
      vecchi funzionano. Lo schema segue il CSV di `pagamenti/riconciliazione/[id]/contesto/route.ts:171`.
    - La query (613) da `.contains('posizioni',[x])` diventa `.overlaps('posizioni', lista)`: passa
      chi si è candidato ad **almeno una** delle posizioni scelte.
    - Un valore sconosciuto dà 400 (zod), come oggi.
- **Etichetta (filtro del client, server invariato):**
  - In `CandidatureInsegnanti.tsx`, `filtroEtichetta` passa da `string` a `string[]` (638).
  - In `carica(…, etichettaSel)` (976, 1031-1044) il filtro diventa
    `scelte.has(mappa.perId[r.id] ?? SENZA_ETICHETTA)`; il ramo si accende con `length > 0`.
  - Il `<select>` (1725-1739) diventa un gruppo di pastiglie `aria-pressed` dentro
    `fieldset`/`legend`, sempre visibile, con «Senza etichetta» fra le voci.
  - Per avere lo stesso aspetto della barra si esporta l'helper `pastiglia` da `BarraFiltri.tsx`
    invece di copiare le classi.
  - Restano invariati il tetto `PAGINE_MAX_ETICHETTA`, gli avvisi di mappa troncata o fallita e il
    totale esatto.

## 5. Logging

- La route resta in `withRoute`; un `posizione` non valido produce un 400 già registrato dal wrapper.
- `ROUTE_LOG` aggiornato.
- Nessun `catch` nuovo: hook e componente non fanno chiamate di rete.

## 6. Test (TDD: prima rosso, poi il codice)

- **Route** (`__tests__/api/candidature-filtri-server.test.ts`):
  - due posizioni → `overlaps` con tutte e due;
  - un valore singolo → ok;
  - un valore sconosciuto → 400.
- **Componente:**
  - `CandidatureInsegnanti-filtri-paginazione.test.tsx`: posizione multipla nell'URL e nella fetch;
  - `CandidatureInsegnanti-etichetta.test.tsx`: le pastiglie al posto del `<select>`; due etichette
    insieme; «senza etichetta» combinata con un'altra.
- **`ColonnaDettaglio`** (con `matchMedia` finto):
  - stretto + aperto → `role="dialog"`;
  - largo → contenitore `sticky` con `aria-busy`;
  - `focus` chiamato con `preventScroll`.
- **Nav config:**
  - voce presente, con i suoi ruoli;
  - `labelKey` in tutti e due i cataloghi;
  - la cuoca non la vede.
- **Redirect:** la regola esiste in `next.config.ts`.
- **E2E** `e2e/admin-candidature.spec.ts`, se le fixture E2E permettono una sede con candidature;
  altrimenti si seminano come negli altri spec admin. Casi:
  - desktop: scorrere, aprire una candidatura in fondo, il pannello è nel viewport;
  - 375 px: si apre il foglio e, chiuso, `scrollY` è invariato;
  - il link vecchio porta alla pagina nuova.

  È l'unica prova a schermo possibile: in locale le pagine admin rimandano al login.

## 7. PRD

In `PRD REGISTRO ELETTRONICO.md`:
- voce di changelog datata **2026-10-17**: nuova posizione in sidebar, redirect, dettaglio fisso e
  foglio, filtri multipli;
- aggiornare la riga di stato di «Lavora con noi / Candidature».

## Verifica

1. Gate locale:
   - `npx eslint . --max-warnings 0`
   - `npx tsc --noEmit`
   - `npx vitest run`, inclusi i lock `offline-etichette-rotte`, `messaggi-chiavi-orfane`,
     `messaggi-parita-cataloghi`, `use-search-params-con-suspense`,
     `modulistica-linguette-raggiungibili`, `filtri-server-non-mentono`,
     `etichetta-candidatura-vocabolario`, `logging-coverage`, `zod-coverage`
   - `npm run build`
2. Sonda delle rotte sul server locale `:3100` con header-identity: `GET /api/admin/candidature-insegnanti?posizione=cuoca,segreteria`
   risponde 200 con `total` coerente; `?posizione=xyz` risponde 400.
   - Il DB è quello di produzione: **solo letture, nessuna PATCH di etichette**.
   - Server fermato a fine prova.
3. E2E in CI verde dopo il push, con tutti i job.
4. Dopo il rilascio: aprire una notifica vecchia dalla campanella e controllare che porti a
   `/admin/candidature`.

Commit sul branch. Push, PR, merge e deploy solo dopo il tuo ok a fine lavoro.
