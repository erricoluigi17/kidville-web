# P0 — Checklist di rollout (lockdown RLS + sigillo identità)

> Aggiornato 2026-06-27 (DL-035…DL-039). **Principio:** una policy permissiva si
> droppa SOLO quando ogni accesso server alla tabella usa il client **service-role**
> (che bypassa la RLS). Le route che usano il client di **sessione** (`createClient`,
> anon per header-identity / authenticated per staff loggato) dipendono dalle policy
> permissive: per quelle tabelle il drop richiede PRIMA la migrazione della route a
> service-role (o policy authenticated corrette). Ogni passo è reversibile.

## ✅ Step 1 — Letture anon dirette del frontend → route server gated  *(FATTO, DL-035)*
Le 6 letture/scritture anon dirette sono migrate a route server gated. `grep -rE "getSupabase\(\)" src/`
→ solo `auth/login` + i 3 file realtime (`.channel()` su chat/pagamenti). Nessun `.from()` su tabella.

| Sito client | Era | Ora |
|---|---|---|
| `parent/modulistica/page.tsx` | anon legame/alunni/utenti | `/api/parent/students` + `/api/me` |
| `teacher/gallery/page.tsx` | anon utenti.ruolo | `/api/me` |
| admin `RankingTable` / `SubmissionsTable` | anon form_models/form_submissions | `/api/admin/forms/{models,rankings,submissions}` |
| admin `RankingAdjustModal` | anon update form_submissions | `PATCH /api/admin/forms/submissions/[id]` (+audit) |
| `FieldRenderer` | anon storage upload | `/api/forms/upload` (sempre server) |

## ✅ S9a — Lockdown sicuro (sottoinsieme service-role) *(FATTO, migr. `20260752`, DL-038/039)*
Droppate le permissive su tabelle **solo service-role** (verificato: nessuna route nel set
session-client): `avvisi`, `avvisi_risposte`, `task_interni`, **`valutazioni`** (chiudeva
l'esposizione anon dei VOTI), `mensa_menu_config`, `mensa_class_menu_assignment`,
`forms_submissions`, `forms_templates`. + **revoca `exec_sql`** da anon/authenticated/public
(buco SQL arbitrario via PostgREST) + `search_path` fisso su 12 funzioni. `get_advisors` = **0 ERROR**,
WARN `always_true` 18→8.

## 🔶 S9b — Per-famiglia: migrare la route session-client → service-role, POI droppare
Le 6 tabelle sotto restano permissive perché una route le legge col **client di sessione**
(si romperebbe sia per anon header-identity sia per staff authenticated). Per ciascuna:
1. Migrare la route `createClient` → `createAdminClient` mantenendo gate (`requireDocente`/`requireStaff`)
   + scope (`assertSezioneInScope`/`assertAlunnoInScope`); verificare in transazione-rollback.
2. `DROP POLICY` permissiva; `get_advisors(security)` → 0 ERROR; smoke app.

| Tabella | Policy permissiva | Route bloccante (session-client) |
|---|---|---|
| `eventi_diario` | `eventi_diario_insert_anon/_select_anon/_update_anon` | `api/diary/entries/route.ts` (+ `educator-sections`) |
| `note_disciplinari` | `allow_all_note`, `Enable read access for all users` | `api/notes/sign/route.ts` |
| `registro_orario` | `allow_all_registro`, `Enable read…` | `api/register/lessons/route.ts` |
| `firme_docenti` | `allow_all_firme`, `Enable read…` | `api/register/lessons/route.ts` |
| `galleria_media_v2` | `Allow all for service role` | `api/gallery/route.ts` |
| `locker_config` | `auth_gestisce_locker_config`, `tutti_leggono…` | `api/locker/materials/route.ts` |
| `alunni` | `alunni_select_anon` (SELECT anon — espone gli alunni) | letture estese via session-client (attendance/diary/…): migrare prima |
| `schools` | `schools_select_anon` | `api/register/lessons` (session) |

*(Queste route appartengono ai moduli P2/P4 — il drop è naturale da fare quando si toccano in P4.)*

## 🔒 S9b-realtime + S13 — gated onboarding genitori
**chat_messages/chat_threads** (`Allow all for service role`) servono la sottoscrizione realtime
anon di `useChatRealtime`: dropparle rompe la chat dei genitori non onboardati. Sequenza:
1. **Onboarding:** inviare credenziali a staff + 89 genitori (`POST /api/admin/regenerate-credentials`;
   sistemare prima i 3 senza email valida). Monitorare `[auth][header-fallback]` → ~0.
2. Aggiungere policy `authenticated` scoped su chat (partecipante = `teacher_id`/`parent_id` del thread —
   **verificare la mappatura `parent_id`→`parents.auth_user_id` vs `utenti.id` prima di applicare**),
   poi `DROP` delle permissive. *(pagamenti/incassi realtime: GIÀ coperti da policy S7, nessuna azione.)*
3. **S13:** `ALLOW_HEADER_IDENTITY='false'` (sigillo sola-sessione). Rollback: rimettere `'true'`.
