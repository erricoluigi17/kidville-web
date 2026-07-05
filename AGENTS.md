# Istruzioni di progetto — Kidville Web

Queste regole valgono per **ogni** sessione e vanno rispettate sempre.

## Lingua
- Comunicare con l'utente **solo in italiano**.

## Workflow di modifica (branch · PRD · deploy)
Regole operative obbligatorie:

1. **Si lavora sempre su un branch secondario, mai direttamente su `main`.**
   Alla **prima modifica** di una nuova attività si crea (o si riprende) un nuovo branch di lavoro
   — es. `git checkout -b feat/<descrizione>`. Non committare mai direttamente su `main`.

2. **Ogni modifica aggiorna anche il PRD.** Il PRD di riferimento è
   **`PRD REGISTRO ELETTRONICO.md`** (nella radice del repo). Qualunque cambiamento a
   codice/funzionalità/schema dati deve essere riflesso nel PRD nello stesso lavoro: aggiornare le
   tabelle di stato in cima e/o aggiungere una voce di changelog datata (vedi il blocco
   "Changelog — …" come modello). Un intervento non è completo se il PRD non è allineato.

3. **Dopo un deploy andato a buon fine** (cioè dopo che **tutte le verifiche/gate sono passate** —
   vedi sotto — e il branch è stato mergeato in `main` e rilasciato), **eliminare tutti i branch
   secondari** (locali e remoti): il branch appena rilasciato e ogni altro branch di lavoro residuo.
   `main` deve restare l'unico branch. Alla prossima modifica si riparte dal punto 1 con un nuovo branch.

## Gate di verifica (prima di considerare "fatto" / prima del merge)
Devono essere tutti verdi:
- `npx eslint . --max-warnings 0` → 0 errori
- `npx vitest run` → tutti verdi
- `npm run build` → build ok
- E2E Playwright → verde (gira in CI su push)

## Note
- `utenti.role` è una colonna **generata** da `ruolo`: non scriverla mai.
- Le route admin usano il pattern service-role (`createAdminClient`) + gate applicativo
  (`requireStaff`/`requireDocente`) + validazione `zod` (lock `zod-coverage`).
- Sede di produzione unica: **Kidville Giugliano** (`d53b0fbc-a9eb-4073-b302-73d1d5abd529`).
