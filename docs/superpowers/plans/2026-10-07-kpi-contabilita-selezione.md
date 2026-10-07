# Piano — Parte 1: KPI di contabilità per selezione, cifre nascondibili, dashboard Direzione senza euro

Specifica: `docs/superpowers/specs/2026-10-07-kpi-contabilita-servizi-mensili-design.md`. Esecuzione: un sub-agente Sonnet per compito (TDD: test rosso → modifica → verde), revisione Opus dopo ogni compito e sul diff finale.

## PARTE 1 — KPI (branch `feat/kpi-contabilita-selezione`, nessuna migrazione)

Ogni compito: test prima (rosso), modifica, test verde. Esecuzione Sonnet, revisione Opus a fine compito.

**T0 · Branch.** `git checkout -b feat/kpi-contabilita-selezione` da `main` pulito.

**T1 · API `/api/admin/dashboard` senza euro** — `src/app/api/admin/dashboard/route.ts`
- Via: query incassi (:68, :99-109), voce `incassi` nel ciclo log (:158), blocco trend/incassato
  (:197-216), `scadutoImporto` (:182, :193-195), `importo` negli alert (:184, :189), `eDirezione`
  (:5, :229-245, :253, :267), `MESI_IT`/`ymKey`/`curMonthKey`/`sixMonthsAgoIso`. Select pagamenti
  → `'id, scadenza, stato, alunni ( nome, cognome )'`. JSDoc: «nessun importo in euro esce da qui».
- Test: riscrivere `__tests__/api/admin-dashboard-kpi-direzione.test.ts:86-129` → «nessun ruolo
  riceve importi» (segreteria, admin, coordinator, ruoli reali misti): chiavi `pagamenti` =
  `['fattureInAttesa','scadutoCount']`, niente `trend`, chiavi alert = `['alunno','id','scadenza']`,
  `h.tabelle` senza `incassi`. `__tests__/api/admin-varie-scope-sede.test.ts`: via fixture incassi
  (:125-128), :264-282 riscritti su `scadutoCount` con righe seminate, via :303-311.
  Prova del rosso: rimettere `importo` e vedere il test fallire.

**T2 · Home `/admin`** — `src/app/(dashboard)/admin/page.tsx`
- Interfaccia ripulita (:44-63); card scaduti sempre `format:'int'` (:111-135); via card incassato
  (:136-150); griglia grafici a una colonna (:273-314); alert `right: f.dataBreve(s.scadenza)`,
  `meta: ''` (:330-335); via `euroFmt`, `TrendingUp`, `TrendIncassiChart`; scheletro 5 card (:240).
- `src/components/features/admin/DashboardCharts.tsx`: via `TrendIncassiChart` (:32-45, :52-101).
- `messages/{it,en}/adminNav.json`: cancellare le sole chiavi `kpiIncassatoMese`,
  `graficoIncassiTitolo`, `chartIncassato`, `kpiPagamentiScadutiSub` (senza riordinare).
- Test nuovo `__tests__/ui/admin-dashboard-senza-euro.test.tsx` (mock `DashboardCharts` col solo
  `StudentiPerClasseChart`; risposta finta che contiene ancora gli importi → la pagina non mostra `€`).
- E2E `e2e/admin-dashboard.spec.ts:27`: via «Incassato nel mese», più `toHaveCount(0)` dopo il ciclo.

**T3 · Logica pura** — nuovo `src/lib/pagamenti/selezione-voci.ts`
- `SelezioneVoci = { categorie: string[]; anno: number; mesi: number[] }` (vuoto = tutte / tutto l'anno).
- `periodoDi`, `mesiAnnoScolastico(anno)` (12, set→ago), `meseDellaVoce(v)`
  (`periodo_competenza ?? scadenza`, primi 7 caratteri), `annoScolasticoDi`, `meseDi`,
  `filtraPerSelezione`, `eVistaPerAlunno(sel, rettaId)`, `eMeseDiRetta`, `etichettaMese`,
  `etichettaMesi` («ottobre 2026», «set–ott 2026», «dic 2026–gen 2027», non contigui con virgola;
  `intlDateTime(locale, { timeZone: 'UTC' })`).
- Test `__tests__/lib/pagamenti/selezione-voci.test.ts` (retta senza periodo → mese scadenza;
  «tutto l'anno» 2026 include lug 2027, esclude ago 2026; etichette; `annoScolasticoDi('2026-08-03')`=2025).

**T4 · Multi-select generico** — nuovo `SceltaMultiplaContabilita.tsx`
- Estrarre da `FiltroClassiContabilita.tsx` costanti (:63-79), disclosure/Escape/clic fuori
  (:122-140) e JSX (:228-315); props `etichetta, riepilogo, testoTutte, tutteAttiva, gruppi, attive,
  onCommuta, onTutte…`. `FiltroClassiContabilita` resta un involucro con la sola logica classi:
  **il suo test da 438 righe non si tocca** e deve restare verde (DOM identico).
- Test nuovo `__tests__/components/SceltaMultiplaContabilita.test.tsx` (nome accessibile, `aria-pressed`, Escape, axe).

**T5 · «Nascondi cifre»** — nuovi `cifre-nascoste.ts` e `CifraNascosta.tsx` in `components/features/admin/pagamenti/`
- Modello `src/components/features/gallery/video-galleria-nascosti.ts:26-61,113-118`: chiave
  `kv:contabilita-cifre-nascoste:<userId>`, storage protetto con ripiego in memoria, un solo log per
  sessione — `logClient` livello **`warn`** (il tipo non ha `info`), `evento: 'offline'`.
- `useCifreNascoste(id)` con `useSyncExternalStore` (snapshot server `false`), ascolta anche `storage`.
- `CifraNascosta`: `<span aria-hidden>••••</span><span className="sr-only">{t('dashCifraNascosta')}</span>`.
- `AgendaScadenze`: prop nuova `mascheraImporti` (default `false`).
- Test: storage che lancia → `false` e un solo log (`vi.resetModules()`); commutazione persistita e
  secondo consumatore aggiornato; `renderToString` con `'1'` → cifre visibili (hydration-safe).

**T6 · Filtri categorie e mesi** — nuovo `FiltriSelezioneContabilita.tsx`
- `FiltroCategorieContabilita` (etichetta comando **«Categorie»**, mai «Categoria»: collide con
  `findByLabelText('Categoria')` di multisede :536) e `FiltroMesiContabilita` (12 pastiglie,
  «Tutto l'anno»), sopra `SceltaMultiplaContabilita`.
- Chiavi `adminContabilita` it/en in coda ai gruppi: `filtroCategorie*`, `filtroMesi*` (plurali ICU),
  `filtroAnnoScolastico`, `dashKpiSelezione`, `dashKpiSelezioneVoce`, `dashNascondiCifre`,
  `dashCifraNascosta`, `dashThCategoria`, `dashVuotoSelezione`.

**T7 · `KpiContabilita.tsx`** — sposta :681-720 di `PaymentsDashboard`
- Mantiene `data-testid` `kpi-contabilita`/`kpi-per-sede`; riga `kpi-selezione` («Somma di: Retta ·
  ottobre 2026») con il bottone occhio: `aria-label` fisso `t('dashNascondiCifre')`, `aria-pressed`,
  `Eye`/`EyeOff` lucide con `aria-hidden`. Maschera solo gli euro, non «N pagamenti».

**T8 · `TabellaVociContabilita.tsx`** — solo spostamento di :1067-1144
- `text-kidville-muted` → `text-kidville-sub` (lock `testo-muted-allowlist`); `BTN_PRIMARY_SM` in `ui.ts`.
  Tutte le suite `PaymentsDashboard-*` verdi, comportamento invariato.

**T9 · Collegamento in `PaymentsDashboard.tsx`**
- Stato: `categorieScelte: string[] | null` (null = Retta predefinita, derivata, non impostata in un
  effetto), `mesiScelti` (`[meseDi(oggi)]`), `categorieLette`. Derivati: `selezione`,
  `selezioneInAttesa` (KPI a `—` finché le categorie non arrivano: niente lampo della somma totale),
  `vociSelezione = filtraPerSelezione(pagamentiVisibili, selezione)` → `totals`/`totaliPerSede`
  (:464-479); `vistaPerAlunno` sostituisce `isRettaView`; `meseUnico` sostituisce `mese` (:394, :518, :792).
- «Genera mancanti» solo con `vistaPerAlunno && eMeseDiRetta`; elenco per voce da `vociSelezione`;
  «Nuovo acquisto» solo con una categoria non-retta; colonna Categoria se le categorie ≠ 1.
- Filtri classi/categorie/mesi/anno nella riga del filtro classi (:724); via `<select>` :749-769,
  `meseCorto`/`periodiAnno` (:120-135). Agenda su `pagamentiVisibili` con `mascheraImporti`.
- Helper test `__tests__/helpers/scelta-contabilita.ts` (`scegliCategorie`, `scegliMesi`, `scegliAnno`).
- Test da aggiornare: `PaymentsDashboard-multisede` (:317, :461, :489, :509, :632 → helper; KPI
  :286-297 con default Retta×ottobre = Aversa 100/0/0/100, Giugliano 0/500/200/0, card 500; poi
  «tutte» → 570), `importi-euro-italiani` (:169-217 scegliendo set+ott 2026; :269; :349),
  `PaymentsDashboard-metodi-ammessi` (:145, :158), `PaymentsDashboard-retta-a-carico` (:475, :480).
- Test nuovo `PaymentsDashboard-selezione-voci.test.tsx`: default = sole rette del mese; multi →
  elenco per voce con colonna Categoria; KPI indifferenti a ricerca/Morosi; agenda conta tutto;
  testo `kpi-selezione`; niente «Genera mancanti» a luglio; occhio maschera card/sede/agenda,
  persiste al rimontaggio, assente per la Segreteria.
- `wc -l PaymentsDashboard.tsx` deve scendere sotto 1220.

**T10 · Chiusura Parte 1**
- PRD: voce `## 💶 Changelog — KPI di contabilità per mese e categoria, cifre nascondibili, dashboard
  Direzione senza euro — 2026-10-07` in cima a `PRD REGISTRO ELETTRONICO.md`; tra i «Noti e NON
  corretti qui»: le rate di una retta non hanno `periodo_competenza` e cadono nel mese della scadenza.
- `docs/superpowers/testo-muted-allowlist.json`: abbassare il conteggio di `PaymentsDashboard`.
- Gate: `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` · `npm run build`.
- Revisione finale Opus del diff intero; push, PR, CI (E2E) verde; merge a mano; deploy; pulizia
  branch (AGENTS.md punto 3).

Trappole note: `logClient` senza `info`; localStorage di jsdom e flag del modulo sopravvivono fra test
(`localStorage.clear()` + `vi.resetModules()`); plurali ICU e apostrofo tipografico; lock
`bottone-icona-con-nome` (chiave esistente nello stesso namespace); `formatEuro` per ogni importo.

