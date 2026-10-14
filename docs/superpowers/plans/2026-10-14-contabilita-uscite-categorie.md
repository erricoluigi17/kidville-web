# Contabilità: uscite e categorie — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Le conferme intermedie sono sostituite dall'autonomia esplicita di AGENTS.md.

**Goal:** Rendere consultabili le uscite e i singoli incassi per categoria, con somme complete e coerenti.

**Architecture:** Due viste nella navigazione esistente; dettaglio condiviso paginato. RPC SQL per righe e aggregati nello stesso snapshot, con la semantica del report attuale. Gate e scope nella route, totali economici solo alla Direzione.

**Tech Stack:** Next.js 16, React 19, next-intl, Supabase/PostgreSQL, Zod, Vitest/PGlite, Playwright.

## 1. Backend del dettaglio

File: nuova migrazione `supabase/migrations/*_report_cassa_dettaglio.sql`, `src/lib/cassa/dettaglio.ts`, `src/app/api/pagamenti/cassa/dettaglio/route.ts`; nuovi test in `__tests__/lib/` e `__tests__/api/`.

- [x] Definire i tipi condivisi della risposta come nel contratto della specifica.
- [x] Provare con PGlite il filtro su più sedi e oltre 1.000 righe: con 1.205 uscite da 1 euro, pagina 2/limite 50 restituisce 50 righe e `conteggio=1205`, `totale=1205`.
- [x] Implementare la RPC con CTE dell'insieme degli incassi e join allo storno originale, esclusione dei metodi non reali, filtri applicati prima della paginazione. Privilegi espliciti:

```sql
REVOKE ALL ON FUNCTION public.report_cassa_dettaglio(uuid[], text, date, date, uuid, boolean, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_cassa_dettaglio(uuid[], text, date, date, uuid, boolean, text, integer, integer) TO service_role;
```

- [x] Implementare GET con `withRoute('pagamenti/cassa/dettaglio:GET', ...)`, `requireStaff`, restrizione Direzione per le entrate, `parseQuery`, `sediLetturaCassa`, RPC, controllo `{error}`, log e `Cache-Control: no-store`.
- [x] Verificare storni positivi/negativi, originale fuori periodo, filtro metodo dopo attribuzione, categorie nulle, scope vuoto, errori e permessi. Eseguire i nuovi file con `npx vitest run <file>` e verificare il numero dei file eseguiti.

## 2. Dettaglio e pagina Uscite

File: `CassaDettaglio.tsx`, `UscitePanel.tsx` in `src/components/features/admin/pagamenti/`; cataloghi `messages/it/adminContabilita.json` e `messages/en/adminContabilita.json`.

- [x] Aggiungere componente elenco condiviso, filtri passati come props, pagina da 50 righe, somma completa dal server solo quando presente. Collegare stato della risposta alla query che l'ha prodotta per evitare dati precedenti sotto filtri nuovi.
- [x] Mostrare descrizione/note e giustificativi attraverso il flusso nativo già usato dal registro. Storni esplicitamente marcati.
- [x] Creare UscitePanel con periodo, categorie cassa multisede e metodo. Riutilizzare `CassaMovimentoModal` per registrare e ricaricare.
- [x] Testare cambio pagina, cambio filtro con richiesta sospesa, HTTP 403/500, schema assente e staff senza totali.

## 3. Riepilogo e navigazione

File: `CassaReport.tsx`, `ContabilitaNav.tsx`, `src/app/(dashboard)/admin/pagamenti/page.tsx`, `src/lib/cassa/report.ts`, test report/CSV ed E2E.

- [x] Aggiungere viste `uscite` e `riepilogo` con caricamento dinamico e `ContabilitaMultiSede`.
- [x] Aggiungere card entrate, uscite e differenza del periodo, colonne contante/altri e righe totali. Il filtro categoria di pagamento riguarda solo le entrate: esplicitarlo nel testo e nella differenza.
- [x] Aprire il dettaglio dalla categoria, passando UUID/null e periodo effettivo (`intero` azzera le date), con la sede corretta anche dal dettaglio per sede. Usare Modal e ripristino focus.
- [x] Allineare CSV ai totali e testare valori netti e categorie omonime.
- [x] Aggiungere E2E con mock della nuova RPC/route in CI, senza seed locale sul DB di produzione.

## 4. Revisione e rilascio

- [x] Aggiornare PRD con stato e limiti reali; revisionare aderenza alla specifica e qualità con agenti separati.
- [x] Eseguire `npx eslint . --max-warnings 0`, `npx vitest run`, `npm run build` e correggere ogni errore.
- [ ] Commit, push e PR; attendere tutti i gate CI, compreso Playwright. Migrazione solo dall'integrazione al merge. Verificare rilascio prima della pulizia dei branch.

Autoverifica del piano: ogni requisito della specifica è coperto dai punti 1–4; la stessa risposta e gli stessi tipi sono usati dalla route e dall'elenco; nessun conteggio o somma derivato da righe tagliate da PostgREST.
