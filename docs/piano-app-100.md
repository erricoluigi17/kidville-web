# Piano: Completamento Kidville al 100%

## Context

L'app (registro elettronico / gestione scuola, Next.js 16 + React 19 + Supabase, fasi P0–P5 complete + redesign UI portato da Claude Design su `feat/ui-redesign-port`) è funzionalmente ricca ma non "finita": un audit a 3 agenti (UI, backend, qualità) ha trovato placeholder "in arrivo" visibili, endpoint non protetti, fallimenti silenziosi, zero validazione input, 3 test rossi, 334 errori lint e sprechi bundle/repo. Questo piano chiude tutto: niente pulsanti morti, niente rotture latenti, codice snellito, funzioni rinviate completate, rete di sicurezza E2E.

### Decisioni utente (vincolanti)
- Ambiente: solo sviluppo, DB resettabile → libertà piena.
- Integrazioni esterne (SIDI, Aruba/SDI, Resend): restano **gated**; si garantisce solo degrado pulito (mai fallimenti silenziosi).
- Refactoring aggressivo ma **reversibile ad ogni punto**: ogni step = 1 commit atomico + gate verde → si riprende da qualsiasi checkpoint.
- Branch: merge `feat/ui-redesign-port` → `main`, poi lavoro su `feat/app-completion`.
- Endpoint debug/seed: sigillati in produzione (`sealDangerous`), usabili in dev.
- Placeholder "grandi": si costruiscono TUTTI (agenda genitore+docente, ricerca globale admin, centro notifiche admin, presenze realtime multi-sede).
- Zod su TUTTE le route (185); lint a ZERO errori e ZERO warning; ID demo eliminati (identità solo da sessione); E2E Playwright completi.
- **Smistamento per ruolo**: link di accesso UNICO per tutti (`/auth/login`); dopo il login ognuno atterra sulla dashboard del proprio ruolo; se la stessa persona è sia docente che genitore, la pagina di login chiede con quale ruolo entrare. Un docente che apre un link `/parent` viene rimandato alla sua area (bug rilevato in test dall'utente).
- **App mobile**: progetti nativi iOS+Android reali con **Capacitor** (installabili da App Store/Play Store), non solo link online. Pubblicazione sugli store gated su account sviluppatore (come le altre integrazioni).
- **VINCOLO ASSOLUTO**: design Claude Design (token, utility `kv-`, primitive `ui/cockpit.tsx`, PageHeader/Tabs) e TUTTE le animazioni framer-motion sono INTOCCABILI. Output visivo/animazioni identici; le ottimizzazioni cambiano solo *come* il codice viene caricato.

### Fatti verificati (correzioni all'audit — vincolanti per l'esecutore)
| Assunzione audit | Verificato nel repo |
|---|---|
| ~225 route API | **185** `route.ts` sotto `src/app/api` (61 admin, 25 primaria, 24 parent, 13 pagamenti, …) |
| `jszip` inutilizzato | **FALSO**: usato da [zip-parser.ts](src/lib/sidi/zip-parser.ts). NON rimuovere. |
| Centro notifiche da costruire | `GET/PATCH /api/notifiche` **esiste già** (campo `letta_il` in tabella `notifiche`). Serve solo UI. Nessuna migrazione. |
| Tabella submissions | Si chiama **`form_submissions`** (migr. `20260528`), enum `form_submission_status`. |
| Umore: backend mancante | `eventi_diario.tipo_evento` è VARCHAR(50) + `dettagli JSONB` → nuovo `tipo_evento='umore'`, **nessuna migrazione**. |
| parent/compiti hardcoded | Già graceful (card + link Diario via `useChildSchoolType`). Solo verifica. |
| `FamilyDetailView.tsx` | **Dead code** (zero import) → eliminare. |
| Ultima migrazione numerata | `20260759_p0_s9b_chat.sql` → le nuove partono da **20260760**. |
| Già sigillate | `admin/wipe`, `admin/seed-full`, `seed-db`, `debug-supabase`. **Da sigillare**: `debug/scrutini`, `admin/apply-*` (5), `admin/setup-registro`, `check-schema`, `test-relations`, `backfill-auth`, `debug-mensa-auth`. |
| Identity client | `current-user.ts` (`DEV_PARENT_ID='33333333-…'`, `DEFAULT_STUDENT_ID='dc617529-…'`), `current-teacher.ts` (`DEV_TEACHER_ID='22222222-…'`), `admin/page.tsx` (`DEMO_ADMIN_ID`). Fallback inline in ~37 file. `resolveIdentity()` session-first già pronto. |
| Ruoli/aree | Il middleware controlla solo la PRESENZA di sessione, mai il ruolo; il login reindirizza a `?next=` o `/` senza guardare il ruolo → **bug confermato**: docente su `/parent` vede la dashboard genitore. Esistono già: layout per area (`(dashboard)/{parent,teacher,admin}/layout.tsx`), `/api/me` che ritorna `{ id, role }`, bridge `parents.auth_user_id` per rilevare il doppio profilo docente+genitore. |
| Mobile nativo | **Non esiste** alcun codice iOS/Android (no Capacitor/RN/Expo, no cartelle native, no manifest PWA). `public/sw.js` gestisce SOLO le push web (registrato in `PushOptIn.tsx`). Tutto da costruire (M10). |

---

## Disciplina di gate (identica per tutti gli step)

**STEP GATE** (fine di OGNI step, prima del commit):
```bash
npx tsc --noEmit                            # 0 errori (da M0.3 in poi)
npx eslint <path-toccati> --max-warnings 0  # zero err/warn sui SOLI file toccati (bonifica lint del file = parte dello step)
npx vitest run                              # 0 failed
git add -A && git commit -m "<msg>"
```
**MILESTONE GATE** (step dedicato a fine milestone): tsc + `eslint src` (conteggio errori ≤ gate precedente, annotato nel commit; da M9 `eslint . --max-warnings 0` DEVE passare) + vitest + `npm run build`; da M8 anche `npm run e2e`.
**SMOKE**: `npm run dev` + curl con status atteso, dove indicato.
**[UI-CAUTION]**: step che toccano componenti visibili — possono solo *riempire* placeholder con markup on-token; mai modificare varianti/transition/layout/animazioni esistenti; diff visivo manuale prima/dopo.

## Ordine milestone e razionale
M0 baseline (nulla è verificabile senza gate verdi) → M1 sicurezza (rischio massimo, le feature poggiano sui gate) → M2 robustezza (degrado pulito prima di costruire sopra) → M3 Zod (meccanico, prima delle feature così le nuove route nascono col pattern) → M4 identità (le feature nascono session-only) → **M4B smistamento per ruolo** (subito dopo l'identità: usa sessione+/api/me appena ripuliti) → M5 placeholder piccoli (rodaggio pattern migrazione+route+UI) → M6 agenda → M7 search/notifiche/presenze → M8 E2E (congela i flussi, incluso il role-routing) → M9 lint zero + perf + gate web finale → **M10 app native Capacitor** (per ultima: incapsula l'app web già finita e verde).

---

## M0 — Baseline (8 step)

- **M0.1** Merge `feat/ui-redesign-port` → `main` (`git merge --no-ff`). Verify: `git log -1`. Commit = merge commit.
- **M0.2** Branch `feat/app-completion` da main. Verify: `git branch --show-current`.
- **M0.3** Fix test rossi + tsc a zero: `__tests__/components/StudentAttendanceRow.test.tsx` (riallineare a `onSetStato`, via `onTogglePresence`/`attendanceLog`), `__tests__/lib/translate-claude.test.ts` (tuple/undefined). Verify: `tsc --noEmit` 0; `vitest run` 0 failed. Commit: `test: riallinea StudentAttendanceRow a onSetStato + fix tipi translate-claude`.
- **M0.4** Script npm `typecheck`/`gate` in package.json (`"gate": "tsc --noEmit && vitest run"`). Verify: `npm run gate` verde. Commit: `chore: script npm typecheck/gate`.
- **M0.5** Pulizia pesi: rm `design-reference/` (17MB zip), `agents/`, `scratch/` (47 file); `prompts/` → `docs/prompts/`; `.gitignore` aggiornato. Zero import da quei path (confermato). Verify: gate + `npm run build`. Commit: `chore: rimuovi design-reference/agents/scratch, sposta prompts/ in docs/`.
- **M0.6** Rm `src/components/features/admin/FamilyDetailView.tsx` (dead code). NON toccare jszip. Verify: `grep -rn FamilyDetailView src` vuoto; gate + build. Commit: `chore: elimina FamilyDetailView (dead code)`.
- **M0.7** Baseline lint documentata in `docs/lint-baseline.md` (per tracking monotono fino a M9). Commit: `docs: baseline lint`.
- **M0.8** MILESTONE GATE M0. Commit: `chore(M0): baseline verde`.

## M1 — Sicurezza: sigilli, gate, scoping (10 step)

- **M1.1** Sigilla [debug/scrutini](src/app/api/debug/scrutini/route.ts): `sealDangerous` + rimozione default `parentId`. Verify: curl no-session → 401; grep `33333333` nel file vuoto. Commit: `security: sigilla /api/debug/scrutini`.
- **M1.2** Gate [educator-sections](src/app/api/educator-sections/route.ts): `requireDocente`, identità da sessione; `?userId=` onorato solo per admin/coordinator. Verify: curl no-session 401. Commit: `security: gate su /api/educator-sections`.
- **M1.3** Gate [attendance/delegates](src/app/api/attendance/delegates/route.ts): `requireDocente` + `assertClasseNomeInScope`; via default `?? 'Girasoli'` → 400 se manca `sezione`. Commit: `security: gate+scope su /api/attendance/delegates`.
- **M1.4** `sealDangerous` su 10 route admin operative: `apply-enrollment-migration`, `apply-fase4-migration`, `apply-forms-migration`, `apply-mensa-multi-menu-migration`, `apply-migration`, `setup-registro`, `check-schema`, `test-relations`, `backfill-auth`, `debug-mensa-auth` (+ rm id demo inline). Verify: grep `-rLn sealDangerous` sui 10 path → vuoto. Commit: `security: sealDangerous su 10 route admin operative`.
- **M1.5** [primaria/me](src/app/api/primaria/me/route.ts): `getRequestUserId` → `resolveIdentity` session-first, contratto risposta identico. Commit: `security: /api/primaria/me usa resolveIdentity`.
- **M1.6** Ricognizione scoping: `docs/primaria-scope-audit.md` per tutte le 25 route primaria (gate sì/no, scope presente/mancante/N.A.). Commit: `docs: audit scoping primaria`.
- **M1.7** Fix scoping primaria batch 1: `registro`, `valutazioni`, `note`(+firma/otp), `ore-assenza`, `obiettivi`, `appello` — aggiungere `assertSezioneInScope`/`assertAlunnoInScope` dove manca. Verify: grep degli assert su ogni route del batch. Commit: `security(primaria 1/2): scoping registro/valutazioni/note/appello`.
- **M1.8** Fix scoping primaria batch 2: `scrutinio`(+chiudi/pubblica/import, rm demo-ID), `pagella`(+batch), `fascicolo`(+pagelle/file), `prospetto`, `orario`, `allegati`, `giustifiche-didattiche`(+demo-ID), `sblocca`, `classi`, `sezioni`, `classe/[sectionId]`, `presenze/giust-vista`. Verify: idem + `grep -rn "22222222-2222" src/app/api/primaria` vuoto. Commit: `security(primaria 2/2): scoping completo + rm demo-ID`.
- **M1.9** Audit cron: `x-cron-secret` su `push/dispatch` (ok), `pagamenti/fattura/sync` e `mensa/allergie-check` (verificare/aggiungere); grep `pg_net|cron` nelle migrazioni per l'elenco chiamate. Verify: curl senza header → 401. Commit: `security: x-cron-secret su tutte le route service-to-service`.
- **M1.10** MILESTONE GATE M1 + smoke curl dei 4 sigilli. Commit: `chore(M1): security gate verde`.

## M2 — Robustezza e degrado graceful (11 step)

- **M2.1** `sendEmail()`: esito propagato da OGNI chiamante (`grep -rln "sendEmail(" src/app/api`): risposta `{ email_inviata: false, warning: … }`, credenziali mostrate in dev, banner UI Segreteria dove serve; mai perdita silenziosa. Verify: nessun `await sendEmail` con esito ignorato. Commit: `robustness: esito sendEmail propagato`.
- **M2.2** VAPID graceful: [web-push.ts](src/lib/push/web-push.ts) non lancia a import; `sendPush` → `{ ok:false, error:'vapid_non_configurato' }`; dispatch riporta `non_configurato`; subscribe → 503 chiaro. Nuovo test `__tests__/lib/web-push.test.ts`. Commit: `robustness: web-push degrada senza chiavi VAPID`.
- **M2.3** Sweep `process.env.X!` a livello modulo nelle route → check runtime nell'handler → 503 `configurazione mancante: <VAR>` (include `admin/wipe`, `seed-full`). Verify: grep → vuoto. Commit: `robustness: nessun process.env! a import-time`.
- **M2.4** Aruba/SIDI gating visibile: log strutturato + campo `{ skipped, motivo:'credenziali_non_configurate' }` nel sync; badge "Integrazione non configurata" (Badge esistente, on-token) nelle UI admin pagamenti/sidi. Commit: `robustness: Aruba/SIDI gated con segnale visibile`.
- **M2.5–M2.7** `.single()` → `.maybeSingle()` + 404 esplicito sui fetch-by-id (REGOLA: non toccare `.insert/.update(...).select().single()`), in 3 batch: (5) parent/attendance/diary/chat/locker/avvisi/notes; (6) primaria/pagamenti/forms/fea/mensa/tasks/gallery/grades; (7) admin. Verify per batch: grep revisione = restano solo post-insert/update. Commit: `robustness(single n/3): …`.
- **M2.8** N+1 [chat/contacts](src/app/api/chat/contacts/route.ts): ramo docente riscritto con 3 query batched `.in()` (sezioni→alunni→legami→genitori); rm mapping hardcoded `22222222→maestra.anna@kidville.it`. Verify: grep demo/kidville.it vuoto; nessun await in for. Commit: `perf: chat/contacts batched, elimina N+1`.
- **M2.9** Limiti su select unbounded: `attendance/daily` `.limit(500)`; `admin/students` colonne esplicite + `.range()` (default 200, param limit/offset); `gallery` paginazione. Client aggiornati senza cambi UI. Commit: `perf: limit/range su daily/students/gallery`.
- **M2.10 [UI-CAUTION]** Teacher home: 3 useEffect (`primaria/me`, `educator-sections`, `avvisi`) → 1 useEffect con `Promise.all`, zero cambio visivo. Commit: `perf: teacher home fetch in Promise.all`.
- **M2.11** MILESTONE GATE M2. Commit: `chore(M2): robustezza verde`.

## M3 — Sweep Zod, 185 route (16 step)

**Strategia**: helper condivisi in `src/lib/validation/` — `http.ts` (`parseBody`/`parseQuery` → `{data} | {response}` con 400 `{ error:'Dati non validi', details:[{path,message}] }`, zod v4 `error.issues`) e `common.ts` (`zUuid`, `zDataYMD`, `zAnnoMese`, `zPaginazione` coerce 1–200 default 50, `zBool`). Schemi **colocati** in testa a ogni route.ts. Pattern: dopo il gate auth → `const q = parseQuery(...); if ('response' in q) return q.response;`. **Coverage-lock**: `__tests__/api/zod-coverage.test.ts` legge i route.ts dei gruppi coperti (lista incrementale) e asserisce l'import di zod/validation → la copertura non regredisce.

- **M3.1** Helper + test (`validation-http.test.ts`, `zod-coverage.test.ts` lista vuota). Commit: `feat(zod): helper parseBody/parseQuery + coverage-lock`.
- **M3.2–M3.14** Batch (~12-18 route l'uno), ognuno: schemi su ogni route del gruppo + gruppo aggiunto al coverage test + step gate. Commit: `feat(zod N/14): validazione <gruppo>`.
  | Step | Gruppo | ~n |
  |---|---|---|
  | M3.2 | attendance, diary, notes, grades, tasks, avvisi | 18 |
  | M3.3 | chat, gallery, locker, mensa | 18 |
  | M3.4 | parent A (forms, submissions, students, onboarding, competenze, medical-certificates…) | 12 |
  | M3.5 | parent B (presenze/*, primaria/* + firme/otp, mensa/allergie) | 12 |
  | M3.6 | primaria A (me, registro, valutazioni, note+firma/otp, appello, ore-assenza, obiettivi, orario, allegati, classi, sezioni, classe/[id]) | 13 |
  | M3.7 | primaria B (scrutinio+3, pagella+batch, fascicolo+2, prospetto, sblocca, giustifiche, giust-vista) | 12 |
  | M3.8 | pagamenti | 13 |
  | M3.9 | pubblici: forms, fea, iscrizione, public, register, panic-alert | 14 |
  | M3.10 | infra: me, educator-sections, notifiche, push, teacher, seed-db, debug-supabase, debug/scrutini | 12 |
  | M3.11 | admin A (dashboard, students, adults, parents, staff, schools, sections, pre-inscriptions, iscrizioni) | ~15 |
  | M3.12 | admin B (forms/*, form-models, regenerate-credentials, documents-merge) | ~15 |
  | M3.13 | admin C (primaria/*, settings, sidi/*, audit, gdpr, competenze, gruppi-mensa) | ~15 |
  | M3.14 | admin D (pagamenti/*, wipe, seed-full, apply-*, setup-registro, check-schema, test-relations, backfill-auth, debug-mensa-auth) | ~16 |
- **M3.15** Verifica totale: `grep -rLn "zod\|@/lib/validation" src/app/api --include=route.ts` → **vuoto**. Commit: `feat(zod 14/14): 185/185 route`.
- **M3.16** MILESTONE GATE M3. Commit: `chore(M3): zod sweep completo`.

## M4 — Rimozione demo-ID + chiusura identità (7 step)

- **M4.1** Hook `src/lib/auth/use-session-identity.ts`: `{ userId, role, ready }` con precedenza URL `?userId=` → localStorage → `GET /api/me` → `null`+redirect login. Zero fallback demo. + unit test. Commit: `feat(identity): useSessionIdentity`.
- **M4.2** Rm costanti demo da `current-user.ts` (`DEV_PARENT_ID`, `DEFAULT_STUDENT_ID`), `current-teacher.ts` (`DEV_TEACHER_ID`), `use-parent-identity.ts`, `offline/syncEngine.ts`; ritorno `string | null`, `ready=false` finché non risolto. Verify: grep dei 3 UUID in src/lib vuoto. Commit: `feat(identity): elimina costanti demo dai resolver`.
- **M4.3 [UI-CAUTION]** Sweep pagine parent (~8 con fallback inline: avvisi, forms/[id], chat, gallery, modulistica, diary…): helper aggiornati, `ready=false` → spinner esistenti. Verify: grep UUID in `(dashboard)/parent` vuoto. Commit: `feat(identity): parent session-only`.
- **M4.4** Sweep teacher (tasks:79, avvisi, chat, gallery, modulistica, page.tsx). Verify: grep vuoto. Commit: `feat(identity): teacher session-only`.
- **M4.5** Sweep admin (rm `DEMO_ADMIN_ID` da admin/page.tsx:30 + 12 pagine) + API residue (tasks, parent/forms+otp, parent/submissions, StudentEconomicSection.tsx). Verify: `grep -rn "22222222-2222\|33333333-3333\|dc617529" src` → **vuoto in tutto src**. Commit: `feat(identity): zero demo-ID nel repo`.
- **M4.6** `ALLOW_HEADER_IDENTITY=false` in `.env.local` + `docs/env.md` completo. Verify: login reale 3 ruoli ok; curl con solo `x-user-id` → 401. Commit: `feat(identity): identità solo da sessione`.
- **M4.7** MILESTONE GATE M4. Commit: `chore(M4): identity closure verde`.

## M4B — Smistamento per ruolo (5 step)

**Regole (decise dall'utente)**: link di accesso unico `/auth/login`; dopo il login si atterra sulla dashboard del proprio ruolo (genitore→`/parent`, educator→`/teacher`, admin/coordinator/segreteria→`/admin`); chi ha DOPPIO profilo (es. docente che è anche genitore, rilevabile via `utenti` + `parents.auth_user_id`) sceglie il ruolo alla login. Aprire un'area non coerente col ruolo attivo → redirect alla propria. Eccezione preservata: lo staff (admin/coordinator/segreteria) può aprire anche `/teacher` (ha già permessi di scrittura sulle funzioni docente lato API — non va rotto).

- **M4B.1** API profili: estendere [/api/me](src/app/api/me/route.ts) → `{ id, role, profili: [{ ruolo, area }] }` (doppio profilo da `utenti` + bridge `parents.auth_user_id`). Contratto retro-compatibile (`role` resta). + unit test. Commit: `feat(roles): /api/me espone i profili disponibili`.
- **M4B.2** Helper puro `src/lib/auth/active-role.ts`: `areaForRole()`, matrice `isAreaAllowed(ruoloAttivo, area)` (staff→admin+teacher; educator→teacher; genitore→parent), cookie `kv-active-role` (set/read server-side). + unit test delle regole pure. Commit: `feat(roles): areaForRole + cookie ruolo attivo`.
- **M4B.3 [UI-CAUTION]** Login unico con scelta ruolo: [auth/login/page.tsx](src/app/auth/login/page.tsx) dopo il login fetch profili → 1 profilo: set cookie + redirect all'area (il `?next=` è onorato solo se coerente col ruolo); ≥2 profili: step inline di scelta ruolo (bottoni on-token nella stessa card di login) → set cookie → redirect. Commit: `feat(roles): login unico con smistamento e scelta ruolo per profili doppi`.
- **M4B.4** Guardie d'area server-side nei 3 layout (`(dashboard)/parent/layout.tsx`, `teacher/layout.tsx`, `admin/layout.tsx`): risolvono sessione + ruolo attivo (cookie, fallback ruolo unico); se `!isAreaAllowed` → `redirect(areaForRole(...))`; se profilo doppio senza cookie → redirect a login per la scelta. Commit: `feat(roles): guardie d'area — docente su /parent finisce su /teacher`.
- **M4B.5** MILESTONE GATE M4B + smoke: login docente → `/teacher`; docente naviga `/parent` → redirect `/teacher`; utente doppio → picker. Commit: `chore(M4B): smistamento per ruolo verde`.

## M5 — Placeholder piccoli (7 step)

- **M5.1 [MIGRAZIONE]** `supabase/migrations/20260760_form_submissions_gestione.sql`: `ADD COLUMN IF NOT EXISTS gestita_il TIMESTAMPTZ, gestita_da UUID REFERENCES utenti(id)` su `form_submissions`; blocco `-- ROLLBACK` in coda. Apply via MCP. Commit: `feat(forms): migrazione gestita_il/gestita_da`.
- **M5.2 [UI-CAUTION]** "Segna gestita" end-to-end: PATCH `/api/admin/forms/submissions/[id]` (zod `{gestita?:boolean}`, audit) + GET ritorna i campi + [SubmissionDetailSidebar.tsx](src/components/features/admin/forms/submissions/SubmissionDetailSidebar.tsx) bottone reale con stato ottimista + badge "Gestita" in lista. Verify: grep "in arrivo" nel file vuoto. Commit: `feat(forms): Segna gestita end-to-end`.
- **M5.3 [UI-CAUTION]** Locker "Avvisa": nuova `POST /api/locker/notify` (requireUser + verifica legame genitore↔alunno, zod; destinatari = staff della scuola + docenti sezione via `enqueueNotifiche` tipo `locker_scorte`); [LockerTodayCard.tsx](src/components/features/parent/home/LockerTodayCard.tsx) chiamata reale + toast esito. Verify: riga in `notifiche` via MCP. Commit: `feat(locker): Avvisa reale`.
- **M5.4 [UI-CAUTION]** Umore (nessuna migrazione): teacher diary aggiunge tipo `'umore'` a EVENT_CONFIG con picker per alunno (5 valori in `dettagli.umore`, POST `/api/diary/entries` esistente, visibile se `diario_config.routine_attive` include `'umore'`); parent diary banner giallo legge l'evento umore più recente del giorno (emoji+label reali, fallback attuale se assente); mappa condivisa `src/lib/diary/umore.ts` + unit test. Commit: `feat(diario): umore della giornata`.
- **M5.5 [MIGRAZIONE se serve]** Chat upload: verificare `20260759_p0_s9b_chat.sql`; se manca `allegato_url` → migr. `20260761_chat_allegati.sql` (+bucket privato `chat-allegati`); nuova `POST /api/chat/upload` (requireUser, multipart 10MB, whitelist mime, URL firmato); [ChatInput.tsx](src/components/features/chat/ChatInput.tsx) TODO → upload reale. Commit: `feat(chat): upload allegati`.
- **M5.6** Micro-fix: fallback clipboard nel forms builder (input readonly selezionabile); verifica compiti/lezioni post-M4; rm stringhe "in arrivo" ormai false. Verify: `grep -rn "in arrivo" src --include='*.tsx'` → solo M6/M7 rimanenti. Commit: `fix(ui): fallback clipboard + verifiche`.
- **M5.7** MILESTONE GATE M5. Commit: `chore(M5): placeholder piccoli completi`.

## M6 — Feature: Agenda condivisa (5 step)

**Mini-design**: tabella `eventi_agenda` (migr. `20260762`, RLS come `notifiche`): `id, scuola_id FK schools, section_id FK sections NULL=evento di plesso, titolo, descrizione, tipo (evento|uscita|scadenza|riunione), data DATE, orario_inizio/fine TIME, visibile_genitori BOOL default true, creato_da FK utenti, creato_il` + 2 indici (scuola_id+data, section_id+data). API unica `/api/agenda`: GET (staff: requireDocente+scope; genitore: requireUser+legame su alunno_id → eventi plesso + sezione del figlio con visibile_genitori, limit 100), POST (requireDocente; educator solo proprie sezioni; enqueueNotifiche best-effort ai genitori), DELETE (creatore-o-direzione). Zod dal giorno 1.

- **M6.1 [MIGRAZIONE]** `20260762_eventi_agenda.sql` + apply + `-- ROLLBACK: DROP TABLE`. Commit: `feat(agenda): tabella eventi_agenda`.
- **M6.2** Route `/api/agenda` GET/POST/DELETE + unit test schemi. Commit: `feat(agenda): API role-aware`.
- **M6.3 [UI-CAUTION]** [AgendaTodayCard.tsx](src/components/features/parent/home/AgendaTodayCard.tsx): fetch prossimi 5 eventi, lista on-token, stato vuoto = card attuale con "Nessun appuntamento in programma"; parent/page.tsx passa studentId. Commit: `feat(agenda): card genitore reale`.
- **M6.4 [UI-CAUTION]** teacher/page.tsx:375-391: box "in arrivo" → lista eventi sezione attiva + composer inline on-token (titolo, data, tipo, visibile ai genitori). Commit: `feat(agenda): agenda docente con creazione`.
- **M6.5** MILESTONE GATE M6 + smoke: evento maestra → visibile al genitore. Commit: `chore(M6): agenda completa`.

## M7 — Feature: ricerca globale, centro notifiche, presenze realtime (7 step)

**Mini-design**: ① `GET /api/admin/search?q=` (min 2 char): requireStaff + `scuoleDiUtente()`; 4 query parallele ilike limit 5 su alunni/utenti/sections/form_models → `{ id, label, sub, href }` per gruppo. ② Centro notifiche: riuso `GET/PATCH /api/notifiche`; dropdown ultime 20, badge `non_lette`, poll 60s, click → PATCH + naviga, "Segna tutte lette". ③ `GET /api/admin/presenze/realtime`: per i plessi in scope, oggi: iscritti per scuola/classe, presenze raggruppate, `appelli_mancanti` = classi con 0 righe → `{ totale, sedi:[{scuola, presenti, iscritti, classi}] }`; poll client 60s (niente canali realtime).

- **M7.1** `/api/admin/search/route.ts` + unit test shape. Commit: `feat(search): endpoint scoped multi-entità`.
- **M7.2 [UI-CAUTION]** [AdminTopBar.tsx](src/components/features/admin/AdminTopBar.tsx):55-66 → input attivo (debounce 300ms) + nuovo `AdminSearchPanel.tsx` (dropdown on-token, Esc/blur, naviga); via readOnly e toast. Commit: `feat(search): ricerca globale live in TopBar`.
- **M7.3 [UI-CAUTION]** AdminTopBar:74-82 → nuovo `AdminNotificationsPanel.tsx` su `/api/notifiche`; pallino statico → badge condizionale `non_lette>0` (stesso markup). Commit: `feat(notifiche): centro notifiche admin`.
- **M7.4** `/api/admin/presenze/realtime/route.ts` + funzione pura `src/lib/presenze/aggregate.ts` + unit test. Commit: `feat(presenze): endpoint aggregato multi-sede`.
- **M7.5 [UI-CAUTION]** admin/page.tsx:261-284: Donut reale (presenti/iscritti), 4 tile reali, elenco sede/classe, poll 60s; via badge "In arrivo". Commit: `feat(presenze): card realtime collegata`.
- **M7.6** Sweep finale: `grep -rn "in arrivo" src --include='*.tsx'` → vuoto (o legittimi documentati). Commit: `chore: zero placeholder residui`.
- **M7.7** MILESTONE GATE M7. Commit: `chore(M7): search+notifiche+presenze completi`.

## M8 — E2E Playwright (7 step)

**Strategia**: `@playwright/test` devDep; `webServer` su porta 3100; seed deterministico `scripts/seed-e2e.mjs` (service-role, UUID fissi non-demo: 1 scuola, 2 sezioni, 4 alunni, utenti Auth reali `admin.e2e@kidville.test` ecc. con bridge `auth_user_id`, legami, avviso, evento agenda, presenze, submission; idempotente/upsert); auth via storageState (progetto `setup` fa login UI 3 ruoli → `e2e/.auth/*.json`).

- **M8.1** Setup Playwright + config + script `"e2e"` + .gitignore. Commit: `test(e2e): setup Playwright`.
- **M8.2** `scripts/seed-e2e.mjs` + `docs/e2e.md`. Verify: eseguito 2× senza errori. Commit: `test(e2e): seed deterministico`.
- **M8.3** `e2e/auth.setup.ts` + `auth.spec.ts` (login ok/ko 3 ruoli, anonimo→redirect, API no-session→401) + `role-routing.spec.ts` (login docente atterra su /teacher; docente naviga /parent → redirect /teacher; utente doppio profilo seedato → picker → area scelta). Commit: `test(e2e): auth + storageState + role routing`.
- **M8.4** Parent: `parent-home` (card, avvisi, agenda seedata, locker Avvisa→toast), `parent-diary` (timeline+umore), `parent-pagamenti`. Commit: `test(e2e): flussi genitore`.
- **M8.5** Teacher: `teacher-attendance` (appello+persistenza), `teacher-diary` (evento+umore), `teacher-agenda` (crea→genitore vede), `teacher-avvisi`. Commit: `test(e2e): flussi docente`.
- **M8.6** Admin+public: `admin-dashboard` (KPI+presenze), `admin-search`, `admin-notifications`, `admin-forms` (Segna gestita), `admin-students`, `public-iscrizione` (happy path + degrado email visibile), `chat` (messaggio+allegato). Commit: `test(e2e): flussi admin+pubblici`.
- **M8.7** MILESTONE GATE M8 (incluso `npm run e2e` verde, 15 spec). Commit: `chore(M8): suite E2E verde`.

## M9 — Lint a zero + perf polish + accettazione (8 step)

- **M9.1** Lint hotspot lib: `persist-submission.ts`, `media/processing.ts`, `offline/db.ts` (tipizzare any). Commit: `lint: lib hotspot a zero`.
- **M9.2** Edge functions: `@ts-ignore`→`@ts-expect-error` + fix (document-expiry-alert, locker-reminder). Commit: `lint: edge functions pulite`.
- **M9.3** Sweep a ZERO: `npx eslint . --max-warnings 0` exit 0 (batch per directory ammessi, commit multipli). Commit: `lint(sweep n): <dir> a zero`.
- **M9.4 [UI-CAUTION]** Dynamic import: jsPDF (admin/modulistica, parent/modulistica) e XLSX (ImportExportClient, teacher scrutinio) → `await import()` nell'handler. framer-motion NON toccato (LazyMotion SKIP: rischio behavior-diff). Verify: build + export in dev funziona. Commit: `perf: jsPDF/xlsx on-demand`.
- **M9.5 [UI-CAUTION]** ~12 `<img>` loghi/statici → `next/image` con width/height espliciti (resa identica); media utente restano `<img>`. Verify: warning no-img-element a zero. Commit: `perf: loghi su next/image`.
- **M9.6** `React.memo` SOLO su righe-lista misurabili (righe appello, lista alunni admin) — facoltativo, skip documentato se rischio. Commit: `perf: memo mirato (o skip documentato)`.
- **M9.7** Docs finali: README sezione integrazioni gated (SIDI 503, Aruba credential-gated, Resend fallback) + `docs/env.md`. Commit: `docs: stato finale`.
- **M9.8** **GATE FINALE WEB**: tsc 0 · `eslint . --max-warnings 0` pass · vitest 0 failed · `next build` ok · seed+`npm run e2e` verde · checklist spuntata in `docs/acceptance.md`. Commit: `chore(M9): web app 100% — gate finale verde`.

## M10 — App native iOS/Android con Capacitor (7 step)

**Architettura**: app Capacitor che carica l'app web da URL (`server.url` in config) — le API Next.js non sono impacchettabili in statico, quindi la shell nativa punta al server (in dev: `http://<ip-locale>:3000`; per gli store serve l'URL HTTPS pubblico quando verrà deployata). **Gated dichiarati** (come Aruba/SIDI): pubblicazione store → account Apple Developer + Google Play; push native → credenziali FCM/APNs; build iOS → Mac con Xcode. Rischio noto da documentare: linea guida Apple 4.2 penalizza i puri wrapper webview — mitigazioni incluse (push native, deep link, splash/icone native).

- **M10.1** `docs/mobile.md`: prerequisiti (Xcode, Android Studio, account), architettura, matrice gated, comandi build. Commit: `docs(mobile): prerequisiti e architettura Capacitor`.
- **M10.2** Install `@capacitor/core @capacitor/cli @capacitor/ios @capacitor/android` + `npx cap init` (appId `it.kidville.app`) + `capacitor.config.ts` con `server.url` da env `CAP_SERVER_URL`. Verify: `npx cap doctor`. Commit: `feat(mobile): Capacitor init + config`.
- **M10.3** `npx cap add ios && npx cap add android` (cartelle native committate) + icone/splash generate dal logo con `@capacitor/assets`. Verify: `npx cap sync` pulito. Commit: `feat(mobile): progetti nativi ios/ + android/ con icone e splash`.
- **M10.4** Push native: `@capacitor/push-notifications`; runtime detection (`Capacitor.isNativePlatform()`) → registrazione token nativo al posto del service worker web; `/api/push/subscribe` accetta token nativi (eventuale colonna `platform` su push_subscriptions → migr. `20260763_push_platform.sql` con rollback); invio FCM/APNs **gated** su credenziali con degrado pulito (pattern M2). Commit: `feat(mobile): push native gated con fallback web`.
- **M10.5 [UI-CAUTION]** Adattamenti webview senza cambi visivi web: CSS `env(safe-area-inset-*)` sulle superfici già esistenti, plugin StatusBar, gestione back button Android, schema deep link `kidville://`. Verify: app web nel browser pixel-identica. Commit: `feat(mobile): safe-area, status bar, back button, deep link`.
- **M10.6** Build verificabili in locale: APK debug Android via gradle CLI (installabile su emulatore/device) e build iOS simulator via xcodebuild se Xcode presente (altrimenti documentato come gated). `docs/mobile.md` aggiornato con l'esito. Commit: `feat(mobile): build debug Android/iOS funzionanti`.
- **M10.7** MILESTONE GATE M10: gate web completo invariato + `npx cap sync` + build Android ok. Commit: `chore(M10): app native pronte — pubblicazione store gated su account`.

---

## Migrazioni (tutte con blocco `-- ROLLBACK` commentato; revert = git revert step + blocco rollback; DB dev resettabile)

| File | Contenuto | Step |
|---|---|---|
| `20260760_form_submissions_gestione.sql` | `gestita_il`, `gestita_da` | M5.1 |
| `20260761_chat_allegati.sql` | (condizionale) `allegato_url` + bucket | M5.5 |
| `20260762_eventi_agenda.sql` | tabella `eventi_agenda` + indici + RLS | M6.1 |
| `20260763_push_platform.sql` | (condizionale) colonna `platform` su push_subscriptions per token nativi | M10.4 |

## File critici
- `src/lib/auth/require-staff.ts` (resolveIdentity/gate — cuore M1/M4)
- `src/lib/auth/scope.ts` (scoping riusato da ogni feature nuova)
- `src/lib/push/enqueue.ts` (notifiche: locker, agenda, centro notifiche)
- `src/components/features/admin/AdminTopBar.tsx` (search + campanella, M7)
- `src/app/(dashboard)/teacher/page.tsx` (agenda docente + perf + identità)

## Checklist di accettazione "app 100% finita"
- [ ] `main` col redesign; `feat/app-completion` con storia atomica (1 step = 1 commit revertabile)
- [ ] Nessuna route senza gate: debug/seed/migrazioni sigillate, cron con secret, primaria con scoping
- [ ] 185/185 route con zod (grep-lock + coverage test)
- [ ] Zero demo-ID in src; `ALLOW_HEADER_IDENTITY=false`; login reale 3 ruoli
- [ ] Zero fallimenti silenziosi (email/VAPID/Aruba/SIDI degradano con messaggi chiari)
- [ ] Zero placeholder: agenda ×2, search, notifiche, presenze realtime, Segna gestita, Avvisa, umore, chat upload — tutti reali
- [ ] Smistamento per ruolo: login unico, ognuno atterra sulla sua dashboard, docente su /parent → redirect, doppio profilo → scelta ruolo alla login
- [ ] App native: progetti ios/ e android/ Capacitor con icone/splash, push native gated, APK debug installabile (store gated su account sviluppatore)
- [ ] tsc 0 · eslint zero err+warn · vitest verde · build verde · e2e verde (16 spec × 3 ruoli)
- [ ] Design e animazioni pixel/behavior-identici ovunque non fosse un placeholder da riempire
