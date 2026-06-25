# P0 — Checklist di rollout (attivazione sicura di S8-enforce / S9 / S13)

> Stato: S0–S7, S11–S12 fatte (PR #2). Qui sotto i passi per attivare in sicurezza
> ciò che è rollout-gated. **Principio:** prima aggiungi il restrittivo, verifichi,
> poi togli il permissivo. Ogni passo è reversibile (flip env o `CREATE POLICY`).

## Step 1 — Eliminare le letture anon dirette del frontend *(prerequisito di S9)*
Finché il client anon del browser legge direttamente queste tabelle, droppare le
policy permissive le romperebbe. Per ogni sito: spostare la lettura su un'API route
server (service_role, gated) **oppure** garantire una policy `authenticated` dedicata.

| File | Legge (diretto, anon) | Azione | Stato |
|---|---|---|---|
| `src/app/(dashboard)/parent/modulistica/page.tsx` | `legame_genitori_alunni`, `alunni`, `utenti` | → API route server (parent-scoped) | ☐ |
| `src/app/(dashboard)/teacher/gallery/page.tsx` | `utenti` | → API route o policy `authenticated` | ☐ |
| `src/components/features/forms/FieldRenderer.tsx` | `form_attachments` (+ `.storage`) | → signed URL / API; RLS Storage allegati | ☐ |
| `src/components/features/admin/forms/rankings/RankingTable.tsx` | `form_models`, `form_submissions` | → API admin (requireStaff) | ☐ |
| `src/components/features/admin/forms/submissions/SubmissionsTable.tsx` | `form_submissions`, `form_models` | → API admin | ☐ |
| `src/components/features/admin/forms/rankings/RankingAdjustModal.tsx` | `form_submissions` | → API admin | ☐ |
| `src/components/features/parent/forms/WizardContainer.tsx` | `form_submissions` | → API parent-scoped | ☐ |

**Solo auth / realtime (nessuna azione di lettura tabellare):**
- `src/app/auth/login/page.tsx` → `signInWithPassword` (OK).
- `src/components/features/chat/useChatRealtime.ts` → `.channel()` realtime → richiede **realtime RLS** sulle tabelle chat (concern separato, da fare insieme alla famiglia comunicazione in S9).
- `parent/pagamenti/PagamentiSummary.tsx`, `StoricoPagamenti.tsx` → `.channel()` realtime sui pagamenti → idem (realtime RLS), i dati veri arrivano già da API.

**Gate per procedere allo Step 3:** `grep -rE "getSupabase\(\)" src/` non deve avere letture dirette di tabelle parent-facing (solo auth + realtime).

## Step 2 — Onboarding (dare una sessione prima di richiederla) *(prereq S8-enforce/S13)*
- Inviare le credenziali a staff + 89 genitori bindati con `POST /api/admin/regenerate-credentials` (a lotti; rispettare i limiti email). Sistemare prima i 3 genitori senza email valida (2 accentate + 1 mancante).
- **Osservabilità:** `resolveIdentity` ora logga `[auth][header-fallback]` quando usa il path header. Misurare quando scende a ~0 → readiness per S13.
- **Gate:** uso del path header ≈ 0 per N giorni consecutivi.

## Step 3 — RLS additiva → lockdown, una famiglia alla volta
Le policy restrittive `authenticated` sono già state **aggiunte additive e dormienti**
(migrazione `20260722_parents_read_policies`, sotto le permissive — nessun effetto finché
le permissive esistono). Per ogni famiglia, in ordine `alunni → presenze → eventi_diario
→ valutazioni/note → galleria → comunicazione`:
1. Verifica con transazione-rollback + impersonazione (`SET LOCAL ROLE authenticated` + jwt claims).
2. Switch lettura su `createParentReadClient` con flag per-famiglia, prima canary poi esteso.
3. `DROP POLICY` permissiva di quella famiglia; `get_advisors(security)` → 0 ERROR.
Rollback: flag OFF o `CREATE POLICY` col testo catturato.

## Step 4 — Sigillo (S13)
Quando Step 1–3 chiusi e header-fallback ≈ 0: `ALLOW_HEADER_IDENTITY='false'`.
Rollback: rimettere a `'true'` (1 flip).
