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
| M5 (placeholder piccoli) | 2026-07-03 | 114 / 44 |
| M6 (agenda condivisa) | 2026-07-03 | 114 / 44 |
| M7 (search+notifiche+presenze) | 2026-07-03 | 113 / 44 |
| M8 (suite E2E Playwright) | 2026-07-03 | 113 / 44 |
| **M9 (lint zero + perf)** | 2026-07-03 | **0 / 0** |

## Chiusura (M9, 2026-07-03)

Obiettivo raggiunto: `npx eslint . --max-warnings 0` esce 0 sull'**intero
repo** (`src`, `supabase`, `__tests__`, `scripts`, `e2e`, config), non solo su
`src supabase`. Da qui in avanti il gate è binario: qualsiasi warning nuovo
rompe `--max-warnings 0`. Unici disable residui: `@next/next/no-img-element`
sui media utente (URL runtime da storage), tutti con motivazione inline.
