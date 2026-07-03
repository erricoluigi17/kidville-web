# Baseline lint — piano "app 100%"

Registrata a inizio piano (post-M0.6, branch `feat/app-completion`) per il tracking
monotono richiesto dai MILESTONE GATE: ad ogni gate il conteggio `npx eslint src supabase`
deve essere ≤ del gate precedente, fino allo zero assoluto in M9 (`npx eslint . --max-warnings 0`).

## Conteggi di partenza (2026-07-02)

| Comando | Errori | Warning | Totale |
|---|---|---|---|
| `npx eslint src supabase` | 262 | 96 | 358 |
| `npx eslint .` (intero repo, inclusi test/scripts) | 302 | 109 | 411 |

## Regole dominanti (`src` + `supabase`)

| Regola | Occorrenze |
|---|---|
| `@typescript-eslint/no-explicit-any` | 120 |
| `@typescript-eslint/no-unused-vars` | 76 |
| `react/no-unescaped-entities` | 18 |
| `@next/next/no-img-element` | 6 |
| `@typescript-eslint/ban-ts-comment` | 5 |
| altri | 3 |

## Storico gate

| Gate | Data | eslint src+supabase (err/warn) |
|---|---|---|
| M0 (baseline) | 2026-07-02 | 262 / 96 |
| M1 (sicurezza) | 2026-07-02 | 262 / 95 |
| M2 (robustezza) | 2026-07-02 | 231 / 84 |
| M3 (zod sweep) | 2026-07-03 | 208 / 79 |
| M4 (identità session-only) | 2026-07-03 | 117 / 44 |
| M4B (smistamento per ruolo) | 2026-07-03 | 117 / 44 |
