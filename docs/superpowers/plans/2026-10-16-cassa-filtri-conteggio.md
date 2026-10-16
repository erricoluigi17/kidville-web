# Cassa: provenienza, filtri e conteggio — piano

> Esecuzione con Superpowers subagent-driven-development; revisione funzionale e
> tecnica delle modifiche, senza pause di approvazione come richiesto da AGENTS.md.

**Obiettivo:** scelta esplicita della cassa di provenienza, filtri completi e scelta
del conteggio totale/per categoria all'apertura della stampa.

**Architettura:** conservare ledger e gate esistenti; attribuzione additiva alle
categorie di incasso, filtri puri condivisi e documento PDF server verificato.

**Stack:** Next.js App Router, React, TypeScript, zod, Supabase, Vitest.

- [x] Filtri: scrivere regressioni UI rosse; creare helper/componente dedicato;
  collegare entrambi i layout; leggere la lista completa con paginazione interna;
  aggiungere traduzioni IT/EN senza riordinare i cataloghi; eseguire test mirati.
- [x] Provenienza: regressioni API/UI e SQL rosse; colonna/FK/vincolo di sede;
  selezione esplicita obbligatoria sulle uscite, azzerata al cambio sede; conservare
  la provenienza negli storni; loggare esiti senza PII; eseguire test mirati.
- [x] Stampa: regressioni su scelta totale/categoria e scope; modale di scelta;
  PDF leggibile con flussi contanti e periodo/sedi dichiarati; riutilizzare
  LinkDocumento per web e nativo; loggare generazione ed errori.
- [x] Allineare PRD, revisionare diff per requisiti e qualità, eseguire ESLint,
  TypeScript, Vitest completo e build; annotare il limite E2E se non eseguito in CI.
- [ ] Pubblicare PR ed eseguire Playwright in CI prima del merge.
