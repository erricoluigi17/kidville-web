---
paths:
  - "supabase/migrations/**/*.sql"
  - "supabase/migrations_archive/**/*.sql"
---

# Migrazioni Supabase

Nome: `YYYYMMDDHHMMSS_descrizione_in_snake_case.sql` — timestamp UTC, sempre crescente.

Si applicano con lo strumento MCP **`apply_migration`**, seguito da **`get_advisors`**, che deve
tornare **0 ERROR**. `migrate.yml` resta in attesa del baseline dello storico.

## 🔴 Una migrazione dentro una PR la applica l'INTEGRAZIONE al merge

E la applica **con la version del FILE**. Se l'hai già applicata a mano con un timestamp diverso, al
merge ne nascono **due righe** nello storico, e da lì in poi lo stato divergente si trascina. Decidi
*prima*: o a mano, o dalla PR — mai tutte e due.

## 🔴 Il database E2E della CI è un progetto separato e NON è migrato

Il codice nuovo deve **degradare in modo pulito**, perché in CI le colonne nuove non esistono:

| operazione | codice che torna | vuol dire |
|---|---|---|
| `INSERT` / `UPDATE` | `PGRST204` | colonna sconosciuta allo schema cache |
| `SELECT` | `42703` | colonna inesistente |

Una route che non li prevede fa fallire l'E2E con un errore che sembra un bug del codice e non lo è.

## I due lock

- **`__tests__/architecture/migrazioni-complete.test.ts`**
- **`__tests__/architecture/migrazioni-senza-sede-cablata.test.ts`** — **mai cablare l'uuid di una
  sede** dentro una migrazione: le sedi di produzione sono tre e una migrazione che ne nomina una
  sola è un bug che si vede solo in quel plesso.

## Trappole di Postgres già pagate

- **`pg_constraint` non vede gli indici UNIQUE parziali.** Se cerchi lì un vincolo che hai creato
  come indice parziale non lo trovi e concludi che non esiste: si guarda **`pg_indexes`**.
- **`ON CONFLICT` su un indice parziale dà `42P10`** se non ripeti la stessa clausola `WHERE`
  dell'indice nella `ON CONFLICT`.
- Senza strumento MCP disponibile: `supabase db query --linked`, eseguito dalla radice del repo.

## 🔴 Prima di scrivere in produzione

In `enrollment_submissions` ci sono domande di iscrizione **vere**: codici fiscali di minori,
allergie, note mediche in testo libero. **Conta prima di scrivere** — è una lettura, non chiede
conferma a nessuno:

```sql
SELECT count(*) FROM enrollment_submissions;
```

Non copiare un numero da un documento: al 2026-09-04 erano 583 e crescevano di ~20 al giorno.
E **mostra l'istruzione** che stai per applicare: mostrare non è chiedere, non costa niente, ed è
l'ultima cosa fra un errore e le famiglie dietro quelle righe.
