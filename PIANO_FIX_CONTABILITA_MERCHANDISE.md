# Piano di correzione — Contabilità + Merchandise (post-test PR #15)

Branch: `feat/fix-contabilita-merchandise` (da `main`, dopo deploy PR #15 ok).
Regole: ogni fase = 1+ commit tematici; PRD aggiornato; gate `eslint 0 / tsc 0 / vitest / build` verdi prima di "fatto"; nessuna scrittura su DB prod senza conferma esplicita.

Legenda: 🟠 alta · 🟡 media · 🔵 bassa · 🔩 trasversale · ⚠️ tocca DB prod · 🧠 richiede decisione.

---

## FASE 1 — 🟠 ALTA · KPI finanziari (1)
**C1** — `PaymentsDashboard.tsx:155`: nel ciclo `totals` aggiungere `if (p.tipo === 'padre') continue;` così "Da incassare/Scaduto" non contano padre+rate. Fix di 1 riga.
> commit: `fix(contabilita): KPI dashboard escludono i piani rateali padre`

## FASE 2 — 🟡 MEDIA · Correttezza fiscale (4 + 1 ⚠️)
**C2a** #7 `fatturapa-xml.ts`: con aliquota>0 scorporare (imponibile/imposta) e far quadrare `ImportoTotaleDocumento`.
**C2b** #8 `aruba/emissione.ts`: numero fattura — eliminare il fallback `?? 1`, interrompere la quota se la RPC non dà un numero (come `ricevute.ts`).
**C2c** #9 `attestazione.ts`: storni non tracciabili compensati nel bucket corretto (calcolo su netto per descrizione).
**C2d** #12 `riconciliazione/[id]:104`: verificare l'update del movimento (CAS `.eq('stato', …)`), stornare l'incasso se fallisce → niente doppio incasso.
**C2e** ⚠️ #16 `20260710130000_...:47`: ricevuta numerata — la FK `pagamento_id` da `ON DELETE CASCADE` a `RESTRICT` + guard nel `DELETE` pagamento (annulla ricevuta prima). *Nuova migrazione.*
> commit: `fix(contabilita): correttezza fiscale — IVA/scorporo, numerazione, attestazione, riconciliazione, FK ricevute`

## FASE 3 — 🟡 MEDIA · Sicurezza / scoping di sede (3)
**C3a** #11 `pagamenti/[id]`: GET/PATCH/DELETE verificano `scuola_id ∈ resolveScuoleAttive` (404 fuori scope).
**C3b** #10 `genera-rette`: non fidarsi di `scuola_id` dal client; filtrare su sedi attive.
**C3c** #27 `attestazione`: ramo staff — scope sulla scuola dell'alunno prima di comporre il PDF.
> commit: `fix(contabilita): scoping di sede su pagamenti/[id], genera-rette, attestazione`

## FASE 4 — 🟡🔵 MEDIA/BASSA · Correttezza magazzino (7)
**C4a** #2 `giacenze.ts`: filtrare per sede a livello DB e togliere/gestire il cap 5000 → no oversell.
**C4b** #40 `giacenze.ts:96`: distinguere schema-mancante (→[]) dagli altri errori (propagare) — niente stock azzerato in silenzio.
**C4c** #3 `cambio-taglia`: guard sullo stato sorgente (409 su `annullato`).
**C4d** #4 `export` / #19 `da-ordinare`: filtro sede a livello DB + `.order()` prima del `.limit()`.
**C4e** #18 evasione: usare le righe realmente aggiornate (`.update().select()`) per notifiche/conteggi → no falso successo / doppia notifica; idem `consegna`, `checkin`.
**C4f** #20 evadi-magazzino: allocazione atomica (RPC condizionale o check post-update `disponibile<0`).
> commit: `fix(merch): giacenze scope/cap, cambio-taglia guard, filtri sede, evasione idempotente`

## FASE 5 — 🟡 MEDIA · Frontend contabilità (3)
**C5a** #13 scadenzario: al cambio A.S. resettare anche `mese` al primo periodo valido.
**C5b** #14 `StoricoPagamenti`: residuo/"da saldare" per-quota sugli split (non usare `importo_pagato` dell'intero pagamento).
**C5c** #15 dashboard: stato `error` + banner "Riprova" quando il load fallisce.
> commit: `fix(contabilita): scadenzario A.S./mese, residuo split genitore, stato errore dashboard`

## FASE 6 — 🔵 BASSA · UX Merchandise (9)
#5 registra-arrivo no-op → disabilita/fallback · #6 evadi-tutte → selezione+`confirm` con nº pezzi · #23 annulla-riga `confirm` · #22 prezzo con virgola (it) · #24 registra-arrivo disabilita+guida · #25 nuovo-ordine empty-state · #26 checkbox `aria-label` · #21 dropdown ricerca non-stale · #39 toggle catalogo busy+errore.
> commit: `feat(merch): rifiniture UX — conferme, empty-state, prezzo it, accessibilità`

## FASE 7 — 🔵 BASSA · UX/grafica contabilità + condivisi (4)
#28 `StudentDetailPanel` fascia nera → token coerente · #29 skeleton KPI/agenda in loading · #30 `aria-label` sui refresh · #31 barra filtri coerente col bucket agenda.
> commit: `fix(contabilita): rifiniture UX/grafica dashboard + StudentDetailPanel`

## FASE 8 — 🔵 BASSA · DB merchandise (1 ⚠️)
**C8** #32 `20260711120000_...:90`: `merch_rettifiche.articolo_id` (e `divise_ordini_righe.articolo_id`) `ON DELETE SET NULL` → `RESTRICT`, oppure includere `articolo_nome` nella chiave giacenza quando id è NULL. *Nuova migrazione.*
> commit: `fix(merch): FK articolo ON DELETE RESTRICT + giacenza robusta a id nullo`

## FASE 9 — 🔵 Copertura test (7)
#17 rollback PO · #33 chiusura PO al check-in · #34 solleciti cron run · #35 riconciliazione PATCH/riapri · #36 solleciti su split · #37 evadi-magazzino gate 403/404/503 · #38 export/da-ordinare/PDF cross-plesso.
> commit: `test: copertura rollback PO, check-in, solleciti/split, riconciliazione, evasione, export cross-plesso`

## FASE 10 — 🔩🧠 Rischi trasversali di progettazione (8) — richiede decisioni
- **T4** timezone: helper date fiscali su `Europe/Rome` (numerazione/anno/scadenze/AdE). *(basso rischio, consigliato)*
- **T6** PII export: `logScrittura` su tutti gli export XLSX (accountability GDPR). *(basso)*
- **T7** split: validare Σ quote esplicite == totale prima dell'emissione. *(basso)*
- **T3** numerazione su scarto SDI: riuso stesso numero entro 5 gg invece di bruciarlo. *(medio)*
- **T2** idempotenza POST ordini/cambio-taglia (idempotency key/dedup) → no doppio addebito su retry. *(medio)*
- **T8** ⚠️ movimenti magazzino con origine tracciata (FK/reversibilità reso). *(medio, migrazione)*
- **T1** 🧠 atomicità: RPC transazionali per ordine/emissione/evasione (oggi sequenze non transazionali). *(alto)*
- **T5** 🧠 conservazione decennale/immodificabilità dei registri fiscali. *(alto, scelta architetturale)*

---

## Chiusura
1. Aggiornare **PRD** (`PRD REGISTRO ELETTRONICO.md`): changelog datato + tabelle stato.
2. Gate finali: `eslint . --max-warnings 0`, `tsc --noEmit`, `vitest run`, `npm run build`.
3. ⚠️ Migrazioni (C2e, C8, T8) applicate a prod **solo su conferma**, via MCP, con advisor 0 ERROR.
4. Deploy: PR → `main` (il merge lo lancia l'utente), poi pulizia branch.
