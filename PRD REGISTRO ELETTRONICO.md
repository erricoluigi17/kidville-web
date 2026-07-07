
> [!IMPORTANT]
> ## 📊 Stato Implementazione e Architettura Database
>
> ### Database
> Il software recupera, aggiorna e inserisce tutti i dati su un database relazionale PostgreSQL.
> - **Fase Demo/Sviluppo:** Supabase (PostgreSQL gestito, con API REST automatiche e RLS).
> - **Fase Produzione:** PostgreSQL self-hosted sul server dell'istituto.
>
> L'applicazione comunica con il database tramite API Routes server-side (Next.js), che utilizzano il client Supabase in demo e un client PostgreSQL diretto in produzione. Le credenziali sono isolate in variabili d'ambiente (`.env.local`).
>
> ### Schema Database Attivo
> Le tabelle attualmente create e operative su Supabase sono:
> | Tabella | Descrizione | RLS |
> |---------|-------------|-----|
> | `schools` | Anagrafica sedi (multi-tenant) | ✅ Policy anon SELECT |
> | `utenti` | Staff (PK `id` FK → `auth.users`); **genitori reali su `parents`** | ⚠️ RLS abilitata ma **bypassata via `service_role`** — lockdown letture genitore in P0 (DL-003) |
> | `alunni` | Anagrafica alunni con allergie | ✅ Policy anon SELECT |
> | `eventi_diario` | Eventi giornalieri del Diario 0-6 | ✅ SELECT + INSERT + UPDATE |
> | `legame_genitori_alunni` | Relazione genitore↔figlio | ✅ RLS attivo |
> | `valutazioni` | Voti e giudizi (Primaria) | Schema creato, non ancora popolato |
> | `galleria_media` | Foto/Video con privacy tagging | Schema creato, non ancora popolato |
> | `armadietto` | Inventario materiali a scalare | Schema creato, non ancora popolato |
> | `ticket_mensa` | Saldo ticket pasto prepagato | Schema creato, non ancora popolato |
> | `pagamenti` | Scadenziario rette e quote | Schema creato, non ancora popolato |
>
> ### Moduli Implementati
> | Modulo | Stato | Pagine | API Routes |
> |--------|-------|--------|------------|
> | **Diario 0-6** | ✅ Operativo | `/teacher/diary` | `/api/diary/students`, `/api/diary/entries` |
> | **Presenze** | 🔶 UI pronta | `/teacher/attendance`, `/parent/attendance` | `/api/panic-alert`, `/api/attendance/*` |
> | **Registro Primaria** | 🔶 UI pronta | `/teacher/register`, `/parent/register` | `/api/grades`, `/api/notes` |
> | **Armadietto** | ✅ Operativo | `/teacher/locker`, `/parent/locker` | `/api/locker/*` |
> | **Mensa** | ✅ Operativo | `/admin/mensa`, `/parent/mensa` | `/api/mensa/*` |
> | **Chat** | ✅ Operativo | `/teacher/chat`, `/parent/chat` | `/api/chat/*` |
> | **Pagamenti** | ✅ Operativo | `/admin/pagamenti`, `/parent/pagamenti` | `/api/pagamenti/*` |
> | **Modulistica** | ✅ Operativo | `/admin/forms`, `/parent/forms` | `/api/forms/*` |
> | **Foto/Video** | ✅ Operativo | `/teacher/gallery`, `/parent/gallery` | `/api/gallery/*` |
>
> ### 🎓 Moduli Normativi Scuola Primaria (gap da colmare)
> Requisiti derivati da L. 150/2024, O.M. 3 del 9/1/2025 (All. A), note MIM 5274/2024 e 2773/2025,
> D.M. 14/2024, Regolamento UE 2016/679 (GDPR), L. 4/2004 (Legge Stanca) e cooperazione SIDI.
> | Modulo | Stato | Priorità / Fase | Note |
> |--------|-------|-----------------|------|
> | **Valutazione conforme O.M. 3/2025** | ❌ Non conforme | Fase 1 | Oggi voti numerici: vietati alla primaria. Da convertire a motore ibrido per grado (vedi §4) |
> | **Orario / Tempo scuola / Materie master** | ❌ Da implementare | Fase 1 | `materia` oggi è testo libero; servono materie strutturate, campanelle, modelli 27/29/40h |
> | **Compresenza avanzata** | 🔶 Parziale | Fase 1 | Firme indipendenti presenti; manca firma con argomenti/compiti per singoli alunni + oscuramento |
> | **Vincoli temporali immodificabilità** | ❌ Da implementare | Fase 1 | Blocco 2gg classe/orali, 15gg scritti; sblocco solo dirigente |
> | **Scrutinio + Pagella online** | ❌ Da implementare | Fase 2 | 6 giudizi sintetici, Ed. Civica, comportamento; PDF statico (firma qualificata rimandata) |
> | **Fascicolo Personale + PEI/PDP** | 🔶 Parziale | Fase 2 | Oggi solo flag BES/DSA + delegati; serve fascicolo completo, RBAC ristretto, audit accessi |
> | **Libretto web giustificazioni** | 🔶 Parziale | Fase 2 | Esiste preavviso assenza; manca giustificazione online con PIN dispositivo |
> | **Interoperabilità SIDI / Piattaforma Unica** | ✅ Implementato (P5, DL-047..050) · 🔶 egress gated | Fase P5 | Import ZIP (parser pluggable), Fase A, frequentanti, genitori-alunni, certificati competenze D.M. 14/2024 + indicatore sync. **Trasmissione reale subordinata all'accreditamento ministeriale** |
> | **Accessibilità AgID / Legge Stanca** | 🔶 Baseline (P1, DL-008) | Trasversale | Fatto: alto contrasto globale persistito, focus-ring, reduced-motion, Modal accessibile, landmark/skip-link/aria-current, smoke jest-axe. WCAG-AA = definition-of-done; audit AA per-pagina incrementale |

---

## 🗓️ Changelog — Logout + Anagrafica fullscreen + Test 360° Primaria 2026-07-07 (branch `feat/logout-anagrafica-fullscreen`)

Interventi UI su richiesta utente + campagna di test funzionale end-to-end sulla scuola primaria.

- **(a) Pulsante Log out in TUTTE le aree.** Prima non esisteva alcun logout nell'app (né Direzione/Segreteria,
  né Docente, né Genitore). Aggiunti: helper client `doLogout()` (`src/lib/auth/logout.ts` — chiude la sessione
  Supabase `auth.signOut()`, azzera i cookie server-side via `POST /api/auth/logout` [`kv-active-role`,
  `sedi_attive`], ripulisce l'identità applicativa in `localStorage` [`kv_user_id`/`_role`/`_parent_id`/
  `_student_id`/`_teacher_id`], reindirizza a `/auth/login`); nuovo endpoint `src/app/api/auth/logout/route.ts`;
  componenti `UserMenu` (dropdown sulla scritta ruolo "Segreteria/Direzione" in alto a destra della TopBar cockpit)
  e `LogoutMenuButton` riusabile (drawer mobile Direzione, bottom-sheet Docente e Genitore).
- **(b) Scheda anagrafica a TUTTA AREA (non più drawer laterale).** Il dettaglio alunno/genitore si apriva come
  pannello laterale stretto sopra la lista. Ora apre nella nuova route `/admin/students/[id]` (full-screen, pattern
  `CockpitPage` + back-link, coerente con `/admin/students/sezioni/[id]`). `StudentDetailPanel`/`ParentDetailPanel`
  hanno una prop `variant='page'|'drawer'`; la tabella naviga alla route (propaga `?userId=`+`kind=`); rimosso
  l'overlay `selectedStudent` dalla lista. Logica di salvataggio/associazione invariata (stessi endpoint PATCH/DELETE).
- **(c) Test funzionale 360° Primaria (TEST 1A prod) → resoconto condivisibile — ESEGUITO.** Completate le anagrafiche
  di test (11 alunni + 10 famiglie collegate via parents+student_parents+legame), portati i docenti primaria a **5**
  + creata la Segreteria di test, assegnazioni materia complete, password note verificate al login. Harness Playwright
  dedicato in `e2e/primaria-360/` (config isolata, 16 storageState, journeys 10/20/30/40/50/60), 70 screenshot, ispezione
  visiva da agenti + riconciliazione DB. **Esiti**: Segreteria (anagrafica fullscreen, orario, pagamenti €525 incassati,
  ticket) ✓; 5 docenti (firma+lezione+voti+compiti+3 note ciascuno, avviso gita) ✓; genitori (orario, visione,
  2 chiarimenti chat con risposta docente, 10/10 adesioni gita, 5/5 prenotazioni mensa) ✓; riscontri cross-ruolo
  (mensa→segreteria “5 pasti”, voto→genitore, incassi→segreteria, chat bidirezionale) ✓; logout ✓ in tutte le aree.
  **Problematiche (solo report)**: dashboard “16 vs 23 alunni”; mensa genitore non mostra saldo/prenotazioni (contesto
  figlio non risolto); docente senza vista mensa (“In arrivo”); data-consegna-compiti assente in UI docente;
  bottom-nav che copre contenuto in alcune viste; cutoff mensa 09:30 blocca “oggi” (corretto); chat con spinner lazy;
  overlay dev Next “1 Issue” = hydration-mismatch pre-esistente sidebar (solo dev). Firma FEA del modulo gita (OTP) non
  inclusa (meccanismo separato). Resoconto HTML condivisibile pubblicato come Artifact.

Gate feature: `eslint . --max-warnings 0` = 0 · `vitest run` = 776/776 (aggiunti `logout.test.ts`,
`auth-logout-route.test.ts`) · `build` ok (route `/admin/students/[id]` generata).

---

## 🗓️ Changelog — Hardening DB (ETL sede + REVOKE EXECUTE) 2026-07-06 (branch `fix/db-hardening`)

Migrazione `20260706210352` (applicata a prod via MCP `apply_migration` e verificata; repo allineato).

- **(a) ETL moduli d'iscrizione — sede non più hardcoded.** `fn_form_submission_etl` (trigger su
  `form_submissions`) inseriva i nuovi alunni con `scuola_id = '11111111-…'`, sede **inesistente**:
  la FK `alunni_scuola_id_fkey → schools(id)` falliva e l'`EXCEPTION` best-effort inghiottiva l'errore
  → l'alunno **non veniva mai creato** (silenzioso). Ora la sede è risolta da `public.schools` (mono-sede
  in prod → Kidville Giugliano); se nessuna sede, skip pulito. Bug era **latente** (`form_submissions`/
  `enrollment_submissions` a 0 righe: sarebbe scattato al 1° modulo d'iscrizione inviato dal builder).
- **(b) Superficie RPC ridotta (advisor SECURITY DEFINER).** `REVOKE EXECUTE` ad `anon`/`authenticated`
  su `fn_form_submission_etl` (solo trigger), `notifiche_dispatch_tick`, `rls_auto_enable`,
  `mensa_check_allergie_giornaliero` (non-trigger, non-RLS, non `.rpc` app; `service_role` mantenuto).
  Su `is_staff_or_admin` tolto **solo** ad `anon` (le sue policy RLS sono tutte `TO authenticated`).
  Esito advisor: **anon SECURITY DEFINER 5 → 0**; **authenticated 6 → 2** (restano `is_staff_or_admin`
  e `current_parent_student_ids`, **necessari** alle policy RLS del "parents space" — non rimovibili
  senza rompere RLS).

Non toccati (per scelta/rischio): `pg_net` in schema `public` (spostarlo può rompere webhook/push) e
**leaked-password protection OFF** (è un toggle Auth, da abilitare in dashboard Supabase → Authentication).
Gate: `eslint` 0, `vitest` 773/773, `build` ok.

---

## 🗓️ Changelog — Allineamento migrazioni DB ↔ repo 2026-07-06 (branch `chore/db-migration-align`)

Housekeeping post-deploy (verifica via MCP Supabase su prod `uimulkjyekgemjakmepp`). La migrazione
anagrafiche era nel repo come `20260767_*` — **nome-versione NON valido** (il CLI Supabase esige un
timestamp a 14 cifre `YYYYMMDDHHMMSS`) — mentre in prod risultava già applicata e registrata come
**`20260706105201`**. Verificato che lo schema prod è allineato: baseline `20260704120000` = dump completo
(include divise/fatture/certificati/sidi/push…), e `20260706105201` applicata **per intero** (4 colonne su
alunni+parents + funzione ETL). **Rinominato il file** → `20260706105201_anagrafiche_residenza_provincia_civico.sql`:
repo e prod coincidono, `supabase db push` resta un no-op pulito. Nessuna modifica a schema/dati.

Note residue emerse (non-bloccanti, da valutare a parte): (a) `fn_form_submission_etl` hardcoda una sede
inesistente (`11111111-…`) → il trigger ETL su `form_submissions` inserirebbe alunni orfani (path non usato
dall'import via API, che passa da `enrollment_submissions`); (b) advisor Supabase **WARN** pre-esistenti:
funzioni SECURITY DEFINER esposte via RPC ad anon/authenticated, `pg_net` in schema `public`, leaked-password
protection off. Gli INFO `rls_enabled_no_policy` sono **by-design** (pattern service-role, non RLS).

---

## 🗓️ Changelog — Fix pre-deploy gate E2E 2026-07-06 (branch `feat/batch-segreteria`)

Tre regressioni emerse in CI (E2E Playwright rosso) sul batch segreteria, tutte risolte senza
alterare il comportamento di prodotto voluto:

- **`/api/admin/students` (GET) resiliente al 42703** — il commit del batch anagrafiche aveva
  aggiunto `residence_street_number`/`residence_province` (migrazione `20260767`) alla SELECT della
  lista, ma solo a POST/PATCH era stato dato il retry "pre-migration"; la GET no. Su un DB privo di
  quelle colonne (progetto E2E CI, o finestra pre-migrate di un deploy) PostgREST rispondeva 42703 →
  HTTP 500 → tabella anagrafica vuota. Ora la GET rimuove le colonne mancanti e riprova, come già
  facevano POST/PATCH. In prod le colonne esistono già → nessun cambiamento funzionale.
- **Diario genitore E2E** — il buffer visibilità 10' (introdotto nel batch) filtra su `creato_il`;
  il seed inseriva l'evento umore con `creato_il = now()` → nascosto ai genitori. Il seed ora
  retrodata `creato_il` di 30' (solo dati di test; il buffer di prod resta invariato).
- **Iscrizione pubblica E2E** — (a) `/admin/iscrizioni` ora reindirizza a *Modulistica → Moduli
  ricevuti*: aggiornata l'asserzione heading del test; (b) i 4 campi resi obbligatori sul form
  pubblico (Nazione/Cittadinanza/Civico/Provincia residenza) **restano obbligatori** (scelta
  confermata: dati completi per SIDI) → il test happy-path ora li compila; (c) **import iscrizione
  resiliente al 42703**: la PATCH `/api/admin/iscrizioni` scriveva `residence_street_number`/
  `residence_province` (mig. 20260767) su `parents`/`alunni`; su DB senza quelle colonne l'INSERT
  falliva e il `continue` saltava la creazione dell'account referente (nessuna credenziale emessa).
  Ora rimuove le colonne mancanti e riprova, come la GET students. In prod le colonne esistono → nessun impatto.

Gate: `eslint` 0, `vitest` verde, `build` ok, E2E Playwright verde in CI.

---

## 🗓️ Changelog — Configurazione invio email Resend 2026-07-06 (branch `feat/batch-segreteria`)

Attivazione dell'invio email reale tramite **Resend** (provider transazionale già cablato in
`src/lib/email/send.ts`, chiamata REST via `fetch` — nessuna libreria aggiuntiva). Consumatori:
OTP firma moduli (`/api/forms/send-otp`, `otp-ticket`), credenziali genitori
(`/api/admin/regenerate-credentials`, `/api/admin/iscrizioni`).

- **Fix bug link login nelle credenziali:** `credentialsEmailBody` puntava a `${NEXT_PUBLIC_APP_URL}/login`
  (rotta inesistente → 404); corretto in **`/auth/login`**, coerente con la rotta reale e con
  `regenerate-credentials`. Senza il fix i genitori avrebbero ricevuto un link rotto all'accensione delle email.
- **Scaffolding env** in `.env.local`: `RESEND_API_KEY` (vuoto → fallback log, nessun invio),
  `OTP_FROM_EMAIL` (fase 1 sandbox `onboarding@resend.dev` → fase 2 `noreply@kidville.it` a dominio verificato),
  `NEXT_PUBLIC_APP_URL` (base dei link nelle email).
- **Attivazione produzione (residuo, lato servizi esterni):** creare account Resend + API key, verificare
  il dominio `kidville.it` (record DNS SPF/DKIM), impostare le stesse env su Vercel (`RESEND_API_KEY`,
  `OTP_FROM_EMAIL`, `NEXT_PUBLIC_APP_URL` = URL prod).

Gate: `eslint` 0, `vitest` verde, `build` ok.

---

## 🗓️ Changelog — Unificazione Iscrizioni → Modulistica 2026-07-06 (branch `feat/batch-segreteria`)

Unificate le due voci di sidebar **Iscrizioni** e **Modulistica** in un'unica voce **Modulistica**.
Gate verde: `eslint` 0, `vitest` 773/773, `build` ok.

- La sidebar perde la voce **Iscrizioni**; la sezione «Anagrafica & Iscrizioni» è rinominata **«Anagrafica»**.
- La pagina **Modulistica** ha ora 4 tab: **Moduli inviabili** + **Moduli ricevuti** (spostate da Iscrizioni),
  **Moduli Genitori** e **Template Certificati ODT**. Rimossa la tab **Moduli Esterni**.
- «Moduli ricevuti» = le iscrizioni ricevute (invariato rispetto alla vecchia «Ricevute»): il link SIDI è preservato.
- I due motori restano separati (form-builder vs moduli-genitori OTP).
- I componenti sono stati estratti in `src/components/features/admin/iscrizioni/` (`ModuliInviabili`, `ModuliRicevuti`);
  `/admin/iscrizioni` è ora un **redirect** a `/admin/modulistica?tab=ricevuti` (link/segnalibri preservati).
  Modulistica legge `?tab=`; il back-link del builder punta a `?tab=inviabili`. Le tab inviabili/ricevuti
  operano multi-sede (fuori dalla guardia sede-singola che resta per Moduli Genitori/ODT).
- **Dashboard**: i link/KPI/alert che puntavano a Iscrizioni ora vanno a `/admin/modulistica?tab=ricevuti`;
  rimosso il doppione «Iscrizioni» dal menu rapido (già presente «Modulistica»). Fix `withUser` per usare
  `&` quando l'href ha già una query string (evita il doppio `?`).

---

## 🗓️ Changelog — Fix Segreteria/Didattica/Modulistica 2026-07-06 (branch `feat/batch-segreteria`)

Batch di 7 interventi correttivi. Gate verde: `eslint` 0, `vitest` 773/773, `build` ok
(e2e in CI su push). **Richiede l'applicazione della migrazione `20260767`** (colonne
residenza + ETL) sul DB prod prima dell'uso dei nuovi campi.

1. **Anagrafiche complete e allineate (alunno ≡ genitore).** Alunno e genitore hanno ora lo
   stesso set anagrafico completo; unica differenza i contatti (email/telefono, solo genitore).
   Aggiunti **Cittadinanza** (`citizenship`), **Nazione di nascita** (`birth_nation`),
   **Numero civico** (`residence_street_number`) e **Provincia di residenza** (`residence_province`,
   sigla) a: form di creazione (`ScrollableStudentForm`/`ScrollableAdultForm`), route
   `POST/PATCH/GET /api/admin/students`, e **schede di modifica** (`StudentDetailPanel`/`ParentDetailPanel`,
   prima incomplete). Migrazione `20260767`: `residence_province`+`residence_street_number` su
   `alunni` e `parents`. Insert/patch resilienti alle colonne non ancora esistenti (42703 → retry).
2. **Bug "nuovo alunno + mamma non salvata né associata" risolto.** Nuovo helper condiviso
   `src/lib/anagrafiche/parents.ts` (`linkOrCreateParent`): CF vuoto → `null` (chiude la violazione
   UNIQUE che causava il 500 silente); cittadinanza reale per i genitori, col ruolo solo per lo
   staff (preserva il workaround tab Staff). `POST /api/admin/students` accetta ora `parents[]`
   opzionale → **salvataggio atomico** alunno+genitori in un'unica richiesta (niente più genitori
   persi né alunni duplicati al retry). `FamilyRegistryManager` fa una sola fetch e mostra l'esito
   reale (niente più finto "salvato" a fallimento parziale).
3. **Anagrafica sezione — insegnanti di riferimento.** Nuova API
   `/api/admin/sections/[id]/teachers` (GET/POST/DELETE, gate Direzione, add/remove) sulla ponte
   `utenti_sezioni`; card "Insegnanti di riferimento" nel dettaglio sezione. Aggiungendo/rimuovendo
   un docente si aggiorna automaticamente la sua anagrafica ("Classi assegnate" in StaffPanel).
4. **Didattica primaria — classe nell'associazione Materie–Docenti.** Il modello DB/API era già
   class-aware (`utenti_sezioni_materie.section_id`): la classe è ora esplicita **in entrambi i modi**
   (tendina Classe nel form di `DocentiMaterieManager` + selettore in alto condiviso + classe mostrata
   in ogni riga).
5. **Mensa — Livello (tendina) + Sezioni (multi-select).** `SezioniMultiSelect` ha una prop
   `withLivelloFilter`: tendina Livello (Nido/Infanzia/Primaria) che filtra le sezioni multi-select.
   Attiva nel MenuBuilder; storage e vista genitore invariati.
6. **Armadietto — materiale assegnato alle classi con tendina.** Stessa UX del punto 5
   (`withLivelloFilter`) nel form "Nuovo Materiale"; rimosso il vincolo fisso a nido/infanzia
   (ora copre anche primaria).
7. **Modulo d'iscrizione standard — campi nuovi + editor segreteria + "Reimposta".** I 4 campi
   nuovi sono nel template (visibili+obbligatori). Il modulo standard è ora un modello `form_models`
   editabile dal builder (nuovo `src/lib/forms/enrollment-default-schema.ts` con
   `ENROLLMENT_DEFAULT_SCHEMA` + id stabile + `ensureStandardEnrollmentModel`): card in `/admin/iscrizioni`
   con **"Modifica"** (builder) e **"Reimposta"** (`POST /api/admin/form-models/reset`, solo per il
   modello standard). Il wizard `/iscrizione` è ora schema-driven (`GET /api/iscrizione/model`, fallback
   al template); **flusso invariato** (invio a `enrollment_submissions`, revisione in "Ricevute").
   ETL import e trigger `fn_form_submission_etl` estesi ai 4 nuovi campi; catalogo builder
   (`anagrafica-fields.ts`) aggiornato. **Fix builder**: il form-builder non caricava mai un modello
   esistente (`?id=` ignorato → apriva sempre "Nuovo Modello" vuoto, bug pre-esistente anche per i
   moduli personalizzati). Aggiunto `GET /api/admin/form-models/[id]` + caricamento nel builder
   (schema/titolo/pubblicazione) e salvataggio in **PATCH** quando si modifica (non duplica più).
   Ora "Modifica" sul modulo standard apre i 36 campi (2 pagine) già presenti.

---

## 🗓️ Changelog — Batch Segreteria 2026-07-05 (branch `feat/batch-segreteria`)

Batch di 9 interventi segreteria/didattica + creazione di 2 classi di prova. Gate verde:
`eslint` 0, `vitest` 765/765, `build` ok (e2e in CI su push). Branch non ancora
pushato/mergeato al momento della scrittura.

1. **Diario 0-6 — buffer visibilità 10'.** Il ramo genitore di `GET /api/diary/entries`
   nasconde le voci create da meno di `diario_config.buffer_visibilita_min` minuti
   (default 10), replicando la finestra di correzione delle valutazioni primaria. Campo
   regolabile in Impostazioni → Diario. Il ramo docente/segreteria vede tutto in tempo reale.
2. **Materie primaria — accessibilità.** Il preset `materie_preset` è già seedato (65 righe);
   la causa reale di "mancano le materie" era l'**assenza di sezioni di primaria** in prod
   (le materie sono per-sezione). Il pannello Didattica primaria mostra ora un empty-state con
   CTA "Crea una sezione primaria" invece del selettore vuoto.
3. **Anagrafiche — salvataggio unico + fix bug.** Un solo pulsante "Salva anagrafica" fuori
   dalle schede salva alunno + tutti i genitori insieme e collegati (schede genitore vuote
   saltate; se l'alunno fallisce non si crea nulla → niente genitori orfani). I form alunno/adulto
   sono `forwardRef` con `validate()/reset()/isEmpty()`, tutti montati. **Bug "campi genitore
   vuoti alla riapertura" risolto**: `parents` ha RLS ON con **zero policy**, e la route
   `GET /api/admin/parents/[id]` usava il client con RLS (`createClient`) tornando sempre vuoto;
   ora usa `createAdminClient` (service-role) come le altre route admin.
4. **Import anagrafiche — prestampato CSV.** Nuovo `src/lib/import/template.ts` (intestazioni
   italiane alunno + 2 genitori) + `POST /api/admin/import/anagrafiche` che crea alunni + genitori
   collegati con dedup sul codice fiscale. In Strumenti: "Scarica prestampato CSV" + import server.
5. **Mensa — assegnazione sezioni multi-select.** Nuovo componente riusabile `SezioniMultiSelect`
   (da `/api/admin/sections/scoped`); nel MenuBuilder, selezionando un menu, compare l'elenco
   sezioni a selezione multipla. Nuovo `PUT /api/mensa/class-assignments` (semantica set).
6. **Armadietto — materiale per classi + carico a tutta la sezione.** `POST /api/locker/materials`
   accetta `classi_sezioni[]` (crea il materiale su più sezioni); la config materiali usa sezioni
   reali (non più lista hardcoded) con `SezioniMultiSelect`; il modale di carico ha l'opzione
   "Assegna a tutta la sezione" (distribuzione a tutti gli alunni della classe).
7. **Rigenera credenziali — PDF nelle notifiche (genitori + staff).** `regenerate-credentials`,
   oltre alla mail, genera un PDF (`src/lib/pdf/credentials-pdf.ts`) salvato nel bucket privato
   `credenziali` e accoda una notifica alla segreteria con link di download
   (`GET /api/admin/credentials-pdf?key=`, staff-gated). Pulsante reale in ParentDetailPanel e StaffPanel.
8. **Messaggi alla segreteria (nuova sezione).** Voce sidebar "Messaggi" + pagina `/admin/messaggi`
   con 2 tab: "Con i genitori" (chat segreteria↔genitore; riusa `/api/chat/*` con la segreteria
   come `teacher_id`) e "Tutti i messaggi" (**supervisione sola-lettura** di tutte le chat
   genitore↔insegnante, filtrabile per insegnante/genitore/classe; `/api/admin/chat/{threads,messages,contacts}`).
9. **Iscrizioni — UI unica.** `/admin/iscrizioni` divisa in "Ricevute" (le richieste, invariate) +
   "Moduli inviabili via link" (i modelli del builder con pubblica/copia-link; il wizard `/iscrizione`
   compare come "modulo predefinito"). *Follow-up*: unificare nella lista Ricevute anche le
   submission dei moduli d'iscrizione (ETL dedicato) — non fatto per contenere il rischio.

**Classi di prova (produzione, sede Kidville Giugliano `d53b0fbc-…`).** Create 2 sezioni etichettate
TEST — **"TEST Infanzia"** (school_type infanzia) e **"TEST 1A"** (primaria) — ognuna con 10 alunni,
2 insegnanti e 10 genitori con login (password comune `KidvilleTest.2026!`, hash verificato). Email:
`test.inf.docente{1,2}` / `test.inf.genitore{1..10}` / `test.pri.*` `@kidville.test`. Dati fittizi
ripulibili (etichetta TEST).

**Nota di regressione nota (non risolta):** in `parents` la colonna `citizenship` conserva in realtà il
*ruolo* (`mother`/`father`/`educator`…) come workaround load-bearing per il filtro Staff e il pannello
di dettaglio; la cittadinanza reale digitata viene sovrascritta. Non toccato per non rompere
`students/page.tsx`. Da bonificare separatamente con un campo ruolo dedicato.

---

# PRD - Kidville App: Modulo Anagrafica e Account Famiglia

## 1. Obiettivo del Modulo
Il modulo Anagrafica rappresenta il core relazionale del sistema Kidville. Centralizza i dati di
studenti, genitori e personale, fungendo da sorgente di verità per tutte le altre funzionalità (Mensa,
Pagamenti, Diario, Valutazioni). La struttura è progettata per supportare un modello SaaS multi-
sede, garantire l'operatività offline per i docenti e mantenere la rigorosa conformità GDPR.

## 2. Struttura Dati (Data Model)
### 2.1 Anagrafica Alunno (StudentModel)
***Dati Principali:** Nome, Cognome, Data di nascita, Luogo di nascita, Sesso, Codice Fiscale,
Indirizzo di residenza, Cittadinanza, Sede di appartenenza, Classe/Sezione.
***Stato dell'Alunno:** Iscritto, Non iscritto, Ritirato, Sospeso.
***Dati Medico/Mensa:** Allergie e Intolleranze (con blocco visivo in fase di appello/mensa).
Flag **"Usa pannolino"** (Si/No): se attivo, ogni evento "Bagno/Igiene" registrato nel Diario 0-6
scala automaticamente un pannolino dall'Armadietto del bambino (vedi Modulo Armadietto §2.2). Per i
bambini senza questo flag, gli eventi Bagno non generano alcuno scalo di materiale.
***Dati Didattici:** Profilo BES (Si/No), Storico valutazioni, Note disciplinari, Accesso allo storico
del "Diario 0-6" degli anni precedenti.
***Gestione Delegati:** Lista dinamica di persone autorizzate al ritiro. Non vi è limite numerico.
Richiede esplicito caricamento del documento di identità del delegato. Nel caso di fratelli, la
delega va replicata per singolo alunno.
***Dati Finanziari (Connessione Payments):** Importo retta, Scadenza mensile del pagamento,
Eventuali sconti applicati (es. sconto fratelli).

### 2.2 Account Genitore (ParentModel)
***Dati Principali:** Corrispondenti a quelli dell'alunno, con l'obbligo di inserimento di Numero di
cellulare e Indirizzo Email.
***Gestione Identità:** Le famiglie sono gestite creando un account univoco e separato per
ciascun genitore. Nel caso in cui un membro dello staff (es. insegnante) sia anche genitore,
l'accesso avviene tramite un unico account globale che gestisce permessi incrociati.

## 3. Gestione Ruoli e Permessi (RBAC)
| Ruolo | Permessi di Lettura | Permessi di Azione e Scrittura |
|---|---|---|
| **Direzione** (ruolo tecnico `admin`) | Accesso illimitato ai dati di **tutti i plessi associati** (ponte `utenti_scuole`; in assenza di righe, ricade sul proprio `scuola_id`). | Tutte le azioni della Segreteria, ma estese a **ogni plesso associato**. Mai cross-tenant fuori dai plessi assegnati. Chiusura/pubblicazione scrutinio (operazione di dirigenza) e sblocco voci time-lockate restano riservati alla dirigenza (`requireStaff`). |
| **Segreteria** (ruolo tecnico `segreteria`) | Accesso illimitato ai dati del **proprio plesso** (`utenti.scuola_id`), mai cross-tenant. | Creazione, modifica e importazione dati del proprio plesso. **Accesso in scrittura a TUTTE le funzioni docente** di qualunque classe del proprio plesso (registro, appello, valutazioni, note, scrutinio, fascicolo, diario 0-6, armadietto), **riusando** le schermate/endpoint del docente (nessun fork UI). Vincoli: l'**autore/valutatore ufficiale** (firma FEA — *vero valutatore*) resta **sempre il docente** (`maestra_id`/`proposto_da` invariati); ogni scrittura è tracciata in `audit_scritture_docente` (diff `valore_prima`/`valore_dopo`); le voci time-lockate/firmate richiedono lo sblocco motivato della dirigenza (`sblocchi_audit`). Gestione inviti genitori e reset password staff del proprio plesso. **Dashboard gestionale completa** (`/admin`: anagrafe/iscrizioni, pagamenti, mensa, impostazioni, modulistica) via `requireStaff` (default include `segreteria`). **Escluse** (solo dirigenza `admin`/`coordinator`): chiusura/pubblicazione scrutinio, generazione pagella ufficiale, sblocco time-lock — vincolo O.M. 3/2025 + FEA. |
| **Insegnante** (ruolo tecnico `educator`) | Visibilità completa sull'anagrafica degli alunni in carico (dati medici, didattici e deleghe), con l'**esclusione assoluta** dei recapiti di contatto dei genitori. Visibilità limitata alle **proprie sezioni** (`utenti_sezioni`) e allo storico dell'anno in corso. | Scrittura sulle funzioni didattiche **solo per le proprie sezioni/materie** (registro, appello, valutazioni, note, ...). Modalità *Sola Lettura* sui record anagrafici core: nessuna modifica autonoma dell'anagrafe. |
| **Genitore** (ruolo tecnico `genitore`) | Accesso all'anagrafica dei propri figli e al proprio profilo personale. | Può aggiornare in autonomia esclusivamente i propri recapiti di contatto e i documenti di identità in scadenza. Nessuna modifica ai dati core dell'alunno. **Escluso da tutti gli endpoint docente** (`requireDocente`). **Login reale** (Supabase Auth, identità risolta dalla sessione su `parents.auth_user_id = auth.uid()`); **nessuna auto-registrazione** né self-service reset password (DL-002/DL-005, Fase P0). |

## 4. Flussi Operativi e Funzionalità Core
### 4.1 Onboarding e Acquisizione Dati
***Form di Pre-iscrizione Esterno:** II sistema genera un link sicuro inviato ai nuovi iscritti. I
genitori compilano i moduli esternamente; la Segreteria importa i dati con un click, popolando in
automatico il database senza data-entry manuale.
***Assegnazione Massiva (Bulk):** Implementazione di una Ul tabellare nella dashboard Admin
che consente la selezione multipla degli alunni per l'assegnazione rapida a classi, sezioni o gruppi
mensa.

### 4.2 Amministrazione, Sicurezza e GDPR
***Audit Log di Sistema:** Tracciamento immutabile di tutte le modifiche anagrafiche in una
collection separata. La dashboard permette alla Segreteria di filtrare l'elenco cronologico delle
operazioni per singolo utente (Insegnante o Genitore).
**Recupero Credenziali (DL-005, Fase P0):** Un pulsante **"Rigenera credenziali"** dedicato
all'interno dell'anagrafica del genitore (e del record staff) permette alla Segreteria di
forzare il reset della password (`auth.admin.updateUserById` con password random) e di
**inviarla automaticamente via email** all'utente. **Nessun self-service "password
dimenticata"**: il recupero passa sempre dalla Segreteria.
***Gestione Diritto all'Oblio:** In base alle normative GDPR, in caso di esplicita richiesta del
genitore, è previsto un flusso di *Hard Delete* che rimuove fisicamente i dati dai server,
bypassando il normale "Soft Delete" applicato in fase di ritiro/sospensione.

## 5. Specifiche Architetturali e di Sincronizzazione
***Moduli Coinvolti:** `src/app/(dashboard)/teacher/` (Pagine docente), `src/app/(dashboard)/parent/` (Pagine genitore), `src/app/api/` (API Routes server-side), `src/lib/supabase/` (Client DB).
***Database:** PostgreSQL. In fase demo il software si collega a **Supabase** (PostgreSQL gestito con API REST e Row Level Security). In produzione si collegherà a un **PostgreSQL self-hosted** sul server dell'istituto. Il cambio avviene modificando le variabili d'ambiente `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` nel file `.env.local`.
***Flusso Dati:** Ogni operazione dell'insegnante (compilazione entrata, pranzo, nanna, bagno, attività) genera una chiamata API al server che esegue un **UPSERT** sulla tabella `eventi_diario`: se per quel bambino+tipo_evento+data esiste già un record, viene aggiornato (UPDATE); altrimenti viene creato (INSERT). La lettura degli alunni avviene tramite SELECT sulla tabella `alunni` filtrata per `classe_sezione`.
***Cloud Authentication:** Relazione rigorosa e vincolata. I genitori non dispongono di codici di auto-invito; è unicamente la Segreteria a creare il legame parent_id <-> student_id ed effettuare l'onboarding. L'autenticazione è gestita tramite **Supabase Auth** (`auth.users` + `auth.identities`) con email/password.
***Offline-First per Docenti:** Le anagrafiche degli studenti vengono salvate in un database locale IndexedDB (tramite **Dexie.js**) per permettere l'appello e il registro offline. Un **Sync Engine** personalizzato (`src/lib/offline/syncEngine.ts`) si occupa di allineare i dati locali con il database centrale PostgreSQL non appena il dispositivo torna online. Le fotografie e i media pesanti sono esclusi dal caching per minimizzare l'impatto sulla memoria del dispositivo.
***Multi-Tenant:** La proprietà `scuola_id` (Sede di appartenenza, FK verso tabella `schools`) è obbligatoria su ogni tabella radice (`utenti`, `alunni`), garantendo isolamento logico dei dati tra plessi diversi all'interno dello stesso ambiente Kidville.

---

# PRD - Kidville App: Modulo Segreteria/Direzione (Accesso Scrittura per Classe)

## 1. Obiettivo del Modulo
Dare ai ruoli **Segreteria** e **Direzione** accesso in **scrittura a tutte le funzioni del docente**, per qualunque classe della propria scuola/plesso, **riusando le stesse schermate/endpoint del docente** (nessuna duplicazione di UI). In questo modo la conformità **O.M. 3/2025** e la **firma FEA** restano intatte, perché si opera sugli stessi flussi certificati del docente.

- **Segreteria** (`segreteria`): vede e scrive **solo sul proprio plesso** (`utenti.scuola_id`).
- **Direzione** (`admin`): può seguire **più plessi**, tramite il ponte `utenti_scuole` (fallback al proprio `scuola_id`).
- Provisioning ruolo Segreteria: valore applicativo in `utenti.ruolo = 'segreteria'` (free-text; l'enum non viene alterato — `loadAppUser` legge `role || ruolo`).

## 2. Modello di Sicurezza (gate uniforme + scope + audit)
Ogni endpoint docente applica, nell'ordine:
1. **Gate ruolo** — `requireDocente` (allowlist `educator/admin/coordinator/segreteria`; **genitore e cuoca esclusi**). Chiude anche la falla che lasciava raggiungere gli endpoint docente al genitore.
2. **Scope per tenant/classe** — helper in `src/lib/auth/scope.ts`:
   - `scuoleDiUtente(user)` → plessi consentiti (proprio `scuola_id`; per `admin` la lista in `utenti_scuole`).
   - `assertSezioneInScope(user, sectionId)` → aree section-keyed (appello, registro, note, scrutinio, orario).
   - `assertAlunnoInScope(user, alunnoId)` → aree student-keyed (valutazioni, prospetto, fascicolo, diario, ...).
   - Regola: `educator` → solo sezioni assegnate (`utenti_sezioni`); `segreteria`/`coordinator`/`admin` → tutte le classi dei propri plessi. **Mai cross-tenant.**
3. **Audit** — `logScrittura()` (`src/lib/audit/scrittura.ts`) registra in `audit_scritture_docente`: attore (id+ruolo), plesso, classe, entità, azione e **diff `valore_prima`/`valore_dopo`**. Log immodificabile (RLS: solo INSERT/SELECT).

## 3. Vincoli di Conformità
- **Firma FEA / vero valutatore**: l'autore ufficiale resta **sempre il docente**. I campi `valutazioni.maestra_id`, `note_disciplinari.maestra_id`, `firme_docenti.maestra_id`, `scrutinio_giudizi.proposto_da` **non** assumono mai l'identità della Segreteria; l'attore Segreteria figura **solo** in `audit_scritture_docente.attore_id`. Per una **nuova** scrittura valutativa la UI Segreteria deve **selezionare il docente** titolare/contitolare (validato su `utenti_sezioni`/`utenti_sezioni_materie`); senza un docente valido → **422** (mai forgiare la firma).
- **O.M. 3/2025**: sui documenti ufficiali solo **giudizi sintetici**; la **media numerica** resta ausilio interno, mai su pagella/viste famiglie (già garantito; la Segreteria non la espone).
- **Conflitti**: last-write-wins + audit; voci in time-lock/firmate richiedono lo sblocco motivato della dirigenza (`sblocchi_audit`). *Conflitti → segnala, non forzare.*

## 4. Notifiche
Toggle `admin_settings.segreteria_config.notifica_docente` (Settings Hub): se attivo, quando Segreteria/Direzione scrive su una classe non propria, il docente titolare riceve notifica (riuso del sistema notifiche esistente).

## 5. Selettore Classe (unica UI nuova — stub)
Riuso di `RegistriClassePanel` (deep-link `/teacher/primaria/[sectionId]/[seg]?userId=`), con elenco classi filtrato per `scuoleDiUtente`. **Stub minimale, da rifinire con Claude Design.** Nessun fork delle viste docente.

## 6. Stato per area (aggiornato a ogni commit)
| Area | Gate | Scope | Audit | Stato |
|---|---|---|---|---|
| Fondamenta (ruolo, `utenti_scuole`, `audit_scritture_docente`, helper, fix grado) | — | — | — | ✅ Fatto |
| classe/[sectionId], classi | `requireDocente` | `assertSezioneInScope` / `scuoleDiUtente` | — (read) | ✅ Fatto |
| Leak in lettura (sezioni, prospetto, fascicolo-rbac, bypass pagella) | `requireDocente` dove serve | `scuoleDiUtente`/`assertAlunnoInScope` (tenant) | — (read) | ✅ Fatto |
| appello, registro, note, valutazioni, scrutinio, orario | `requireDocente` | `assertSezioneInScope`/`assertAlunnoInScope` | `logScrittura` + `notificaTitolariScrittura` | ✅ Fatto (valutatore preservato via `risolviValutatore`; nuove valutazioni/firme della segreteria richiedono `docenteId` → 422 senza UI selezione docente) |
| fascicolo | `puoAccedereFascicolo` (RBAC + tenant + segreteria) | alunno | `fascicolo_accessi_audit` + `logScrittura` (upload) | ✅ Fatto |
| diary 0-6 | `requireDocente` (rami genitore aperti) | `assertAlunnoInScope` / nome→plesso | `logScrittura` | ✅ Fatto (UI cablata a `getCurrentTeacherId`; verifica runtime lato utente — vedi nota) |
| armadietto | `requireDocente` (carico/ack genitore aperti) | `assertAlunnoInScope` / `assertClasseNomeInScope` | `logScrittura` | ✅ Fatto (consumo/materiali/catalogo gatati; carico + "preso in carico" + reads alunno genitore aperti; verifica runtime lato utente) |
| tasks | `requireDocente` (intero modulo) | `task_interni.scuola_id` (migrazione 20260719) | `logScrittura` | ✅ Fatto (proxy author → backfill via real_author_id; UI cablata; verifica runtime lato utente dopo migrazione) |
| avvisi | `requireDocente` (staff; genitore lettura/risposte aperte) | `avvisi.scuola_id` (migrazione 20260719) | `logScrittura` | ✅ Fatto (GET ramo genitore + POST risposte aperti; create/edit/delete/risposte-GET/upload gatati; UI cablata) |
| Selettore classe Segreteria (stub) + toggle notifica | `requireDocente` (via /classi) | `scuoleDiUtente` | — | ✅ Fatto (stub, Claude Design) |
| **FEA — Servizio firma in-house (P1)** | firmatario = sessione | per-firmatario (`fea_signatures`, policy `any-one`/`all-required`) | `fea_audit_log` (immutabile) | ✅ Fatto (DL-001/006/007/009/010): `src/lib/fea/`, ricevuta PDF `GET /api/fea/receipt`, 3 consumatori ricablati; migrazioni `20260730/31/32` |
| **Push — Servizio notifiche bufferizzate (P1)** | `x-cron-secret` su dispatch | per-utente | — | ✅ Fatto: `enqueueNotifiche` generico + cron dispatch generico (`notifiche_dispatch_tick`, ogni 5′) → il buffer 10′ ora parte (prima solo pagamenti). Migrazioni `20260733/733b` |
| **Accessibilità — Baseline (P1, DL-008)** | — | — | — | 🔶 Baseline: provider HC globale (cookie SSR, no-FOUC), token HC + focus-ring + reduced-motion, Modal accessibile, landmark/skip-link/aria-current, smoke `jest-axe`. WCAG-AA = DoD; audit AA per-pagina incrementale |
| **P2 — Valutazione ↔ obiettivo (DL-015)** | `requireDocente` | `assertSezioneInScope` | `logScrittura` | ✅ Fatto: enforcement condizionale ≥1 obiettivo (`obiettiviDisponibili`), righe `valutazione_obiettivi`, UI checkbox docente |
| **P2 — Presa visione note FEA (DL-014)** | OTP/FES (sessione) | per-firmatario (`fea_signatures` `nota`) | `fea_audit_log` | ✅ Fatto: `nota_ricezioni` (migr. `20260740`), `POST /api/parent/primaria/note/firma` (+otp); vecchio POST → 410 |
| **P2 — Orario visibile alle famiglie** | `getRequestUserId` | sezione del figlio | — (read) | ✅ Fatto: `GET /api/parent/primaria/orario` + pagina genitore |
| **P2 — Finalità accesso Fascicolo (DL-011)** | `puoAccedereFascicolo` | alunno | `fascicolo_accessi_audit.finalita` | ✅ Fatto: `finalita` cablata in list/download/upload + campo UI |
| **P2 — Panic Alert push (DL-016)** | sessione | plesso alunno | — | ✅ Fatto: notifica simultanea Segreteria/Direzione + genitori (push P1, best-effort). Blocco-uscita UI/banner/clear = sequenziati |
| **P2 — AES Fascicolo (DL-011) / Export MIUR (DL-012) / Account sospeso (DL-013)** | — | — | — | 🔶 Decisi: AES = at-rest gestita (no app-crypto); Export = XLSX+PDF (impl. sequenziata); sospensione rinviata a P3 |
| **P3 — Fatturazione Elettronica Aruba/SDI (DL-017..020)** | `requireStaff` (emissione) / `x-cron-secret` (sync) | pagamento → scuola; genitore via `legame_genitori_alunni` (download PDF) | `fatture_emesse` (XML + stato SDI + numerazione) | ✅ Fatto (P3.1): client REST reale, XML FatturaPA (B2C/N4/no-bollo), numerazione interna, scarti polling + notifica Segreteria + copia cortesia PDF. Migrazione `20260741`. **Verifica live SDI gated su credenziali Aruba del committente** |
| **P3 — Pagamenti residui: sospensione moroso + vista categorie + ricevuta (DL-021..023)** | `requireStaff(['admin','coordinator'])` (sospensione) / guard `assertGenitoreNonSospeso` (azioni) | `assertAlunnoInScope`; genitore via `legame_genitori_alunni` | `logScrittura` (sospensione) | ✅ Fatto (P3.2): flag soft per-alunno (`alunni.sospeso`, migr. `20260742`) + banner/badge + enforcement su firme moduli; vista genitore a categorie; ricevuta PDF non fiscale. Login/letture preservati |
| **P3 — Logica condizionale form (DL-024)** | — (motore puro) | — | — | ✅ Fatto (P3.3a): `src/lib/forms/conditional.ts` (eq/neq/contains/gt/lt); wizard mostra/nasconde + valida solo visibili + strip valori nascosti; editor condizione nel builder. Singola condizione per campo, nessuna migrazione |
| **P3 — Delibera ammissioni + scoring (DL-025)** | `requireStaff` (delibera/override) | per `model_id` | `esito_da`/`esito_il` su `form_submissions` | ✅ Fatto (P3.3b): scoring applicato in live (migr. `20260743`), `calcolaDelibera` (soglia+posti), esito ammesso/lista/non + override, export PDF delibera, UI RankingTable |
| **P3 — ETL form→anagrafiche (DL-026)** | trigger `SECURITY DEFINER` | scuola default / match anagrafico | `RAISE NOTICE` best-effort | ✅ Fatto (P3.3c): `fn_form_submission_etl` riscritto su `parents`/`alunni`/`student_parents` (migr. `20260744`); traduzioni `db_mapping`, upsert su `fiscal_code`/`codice_fiscale`, link. Verificato con dry-run live. Completa il deferral DL-025 |
| **P3 — Certificato medico self-service (DL-027)** | `requireUser` (upload) / `requireStaff` (validazione) | scope `legame_genitori_alunni` | `logScrittura` (validazione) | ✅ Fatto (P3.3d): tabella corretta (migr. `20260745`, era drift), periodo dal/al + stato, bucket privato; upload genitore → validazione Segreteria (Valida/Rifiuta + nota) + download scoped. Nessun sollecito automatico |
| **P3 — Staff RBAC (DL-028)** | `requireStaff(['admin','coordinator'])` (Direzione) | scuola/classi (`utenti_sezioni`) | `logScrittura` (`staff_rbac`) | ✅ Fatto (P3.4a): `GET/PATCH /api/admin/staff` + pannello `/admin/staff` (ruolo/sede/classi); self-lockout guard; ruoli assegnabili no-genitore. Nessuna migrazione |
| **P3 — Blocchi Consensi & Allegati + upload (DL-029)** | `requireStaff` (builder) / `requireUser` (upload) | per `model_id` / service-role | `consents_log` snapshot GDPR | ✅ Fatto (P3.3e): tipo campo `consent` (testo+link+checkbox) reso e configurabile nel builder, snapshot legale `consents_log` (migr. `20260746`); endpoint upload generico `/api/forms/upload` (ripara wizard autenticato) + `/api/forms/submit` (insert server-role); gate `requireStaff` su `/api/admin/form-models` (era ungated). Allegati: service-role + scoping app |
| **P3 — Pubblica modello + link pubblico (DL-030)** | `requireStaff` (publish) / token pubblico (compilazione) | `public_token` + `access_mode` | submission anonima `consents_log` | ✅ Fatto (P3.3f): `published_at`/`public_token`/`access_mode` (migr. `20260747`); `POST /api/admin/form-models/publish` (publica/ritira, link `/m/{token}`); pagina pubblica `/m/[token]` (WizardContainer anonimo); `POST /api/public/forms/[token]/submit|upload` token-scoped (consensi applicati); config accessi pubblico/registrati; builder con pannello Pubblica/Copia link |
| **P3 — Firma congiunta + reinvio OTP (DL-031)** | OTP email (FEA) | slot `fea_signatures` per submission | `signature_log` per-slot + `logFeaEvent` | ✅ Fatto (P3.3g): `signature_mode` single/joint su form_models (migr. `20260748`); send-otp slot-aware (completa per policy `all-required`); 2° firmatario email-only + reinvio OTP; UI `OtpSignatureModal` (reinvia + step 2° genitore) + toggle nel builder. Riusa slot FEA P1 (DL-007) |
| **P3 — Proxy upload cartaceo (DL-032)** | `requireDocente` | `legame_genitori_alunni` (parent) | `logScrittura` (`modulistica_cartaceo`) | ✅ Fatto (P3.3h): `POST /api/teacher/modulistica` riscritto (era stub ungated con path finto) → upload **reale** della scansione su `form_attachments/cartaceo/`, gate docente, `origine='cartaceo'` (migr. `20260749`), evidenza strutturata + audit. UI teacher con File reale (multipart); merge PDF classe marca "(CARTACEO)" |
| **P3 — Multi-Sede CRUD (DL-033)** | `requireStaff(['admin','coordinator'])` (Direzione) | tabella `scuole` (registry) | `logScrittura` (`multi_sede`) | ✅ Fatto (P3.4b): tabella `scuole` (migr. `20260750`, era `scuola_id` hardcoded; seed sede esistente); `GET/POST/PATCH /api/admin/schools` aggiungi/rinomina/disattiva (soft) + `config` jsonb isolata; UI `/admin/schools` (`SchoolsPanel`). No FK su scuola_id (soft-reference); hard-delete fuori scope |
| **P3 — GDPR diritto all'oblio (DL-034)** | `requireStaff(['admin','coordinator'])` (Direzione) | `alunni`/`parents` + `student_parents` | `logScrittura` (`gdpr_oblio`) | ✅ Fatto (P3.4c): lista non-iscritti (`/api/admin/gdpr/candidates`) → `POST /api/admin/gdpr/erase` **solo anonimizzazione** (placeholder `CANCELLATO-{hash}`, no DELETE), genitore anonimizzato solo se orfano, file PII rimossi (escluso `fatture`); preserva audit+fisco; **dry-run + doppia conferma**; `anonimizzato_il` (migr. `20260751`); UI `/admin/gdpr` (`OblioPanel`) |
| **P0 — Letture parent-facing via route server (DL-035)** | `requireStaff`/`requireUser` | service-role + scoping app | — (read) | ✅ Fatto: 6 siti anon migrati; nuove route `/api/me`, `/api/admin/forms/{models,rankings,submissions[+id]}`; riuso `/api/parent/students`, `/api/forms/upload`. `grep getSupabase` → solo auth+realtime |
| **P0 — Gate + audit mutazioni anagrafiche (DL-036/037)** | `requireStaff(['admin','coordinator','segreteria'])` | service-role | `logScrittura` (`alunni`/`genitori`/`legame`/`sezioni`/`iscrizione`) | ✅ Fatto: `/api/admin/{students,parents,sections,iscrizioni}` ora gatati + auditati (erano ungated/unaudited). Bulk iscrizioni: una riga audit per entità creata |
| **P0 — RLS lockdown S9a+S9b (DL-038/039/040/041/044/046)** | — | RLS prod (default-deny anon; service-role passa) | — | ✅ **LOCKDOWN COMPLETO**: droppate **TUTTE** le policy permissive (migr. `20260752`→`20260759`); `pg_policies qual='true'` su anon/public = **0**. Chat realtime con policy `authenticated` partecipante. `get_advisors` **0 ERROR**. 🔶 **S13** (`ALLOW_HEADER_IDENTITY='false'`) = solo flip env operativo dopo onboarding di massa |
| **P4 — Diario 0-6 · D1 (DL-040)** | `requireDocente` (cattura); ramo genitore service-role (gate proprietà → S13) | `assertAlunnoInScope` | `logScrittura` (`diario`) | ✅ Push genitore 1×/figlio (buffer 10' + debounce, `enqueueDiarioGenitori`); "Entrata" read-only da Presenze (`/api/diary/checkin`); filtro solo-presenti + toggle; bulk "Nanna per tutti"; input nota libera docente. **S9b Diario:** `/api/diary/entries` → service-role + DROP `eventi_diario_*_anon` (migr. `20260753`), advisors 0 ERROR. 🔶 D2: traduzione/dashboard Segreteria/riconciliazione `daily_routines` |
| **P4 — Galleria · G1 (DL-041)** | `requireDocente` (POST); ruolo per delete/patch | service-role (visibilità tagged/broadcast in API) | — | ✅ **Privacy Lock server-side**: tag di alunni senza `consenso_privacy` → **422 con nomi** (POST+PATCH, bypass broadcast); helper `src/lib/gallery/privacy.ts`. **S9b Galleria:** DROP `galleria_media_v2` permissive (migr. `20260754`, tutti gli accessi già service-role), advisors 0 ERROR. *(broadcast, delete admin, interconnessione Diario già presenti.)* |
| **P4 — Comunicazione · C1 (DL-042)** | `requireUser` + rate-limit (`/api/chat/translate`) | service-role | — | ✅ **Traduzione automatica chat** via Claude `claude-haiku-4-5`, **gated su `ANTHROPIC_API_KEY`** (503 + UI nasconde se assente): servizio `src/lib/translate/claude.ts`, endpoint `/api/chat/translate`, pulsante "Traduci" sui messaggi in arrivo (target = lingua dispositivo). 🔶 S9b chat realtime (`chat_messages`/`chat_threads`) = gated onboarding; note vocali/file/super-admin lettura = slice successive |
| **P4 — Mensa · M1 (DL-043)** | `requireUser` (`/api/parent/mensa/allergie`) | service-role; alunno per id | — | ✅ **Icona pericolo allergeni genitore**: cross menù-del-giorno↔allergeni figlio (riuso helper puri 14 UE), banner rosso nella pagina mensa genitore. *(Infra allergeni cuoca/segreteria + cron già presenti.)* 🔶 Resta: isolamento UI Cuoca, dashboard real-time tipologia, semaforo scorte, esclusioni classe |
| **P4 — Armadietto · S9b (DL-044)** | `requireDocente` + scope (`/api/locker/materials`) | service-role | `logScrittura` (`armadietto_config`) | ✅ Migrata a service-role + **DROP** `locker_config` permissive (migr. `20260755`), advisors 0 ERROR. *(Flusso richiesta→chiusura ciclo già presente in `locker/requests`.)* 🔶 Resta: carico merci, lista spesa genitore, dashboard inadempienze, reminder 07:00 |
| **P4 — Anagrafica · onboarding (DL-045)** | `requireUser` (`/api/parent/onboarding`) | service-role; genitore self | — | ✅ **Onboarding genitore** `/parent/onboarding`: consensi GDPR obbligatori (422 se mancanti) + set password Supabase Auth (se bindato) + `parents.onboarded_at`/`consensi_gdpr` (migr. `20260756`). **Prerequisito S13** (sessione reale). 🔶 Resta: PIN dispositivo, stato Non-iscritto, trasferimento sedi, dati finanziari; **flip S13 = operativo** (onboarding di massa) |
| **P5 — Certificato Competenze (DL-047)** | `requireStaff` (read/seed) / `['admin','coordinator']` (genera+firma) | alunno; genitore via `student_parents`/`legame` | slot FEA `certificato_competenze` + `fea_audit_log` (`logFeaEvent`) | ✅ Fatto: tabelle `certificati_competenze`+`_livelli` (migr. `20260760`, RLS default-deny), modello D.M.14/2024 (8 competenze × 4 livelli A/B/C/D), PDF (riuso pagella) + firma applicativa dirigente, seed da scrutinio finale classe-quinta (guard 422/409), download admin+genitore. UI `/admin/competenze` + card pagelle genitore |
| **P5 — Numero domanda + Import ZIP SIDI (DL-048)** | `requireStaff` (upload/preview) / `['admin','coordinator']` (apply) | service-role | `logScrittura` (`alunni`/`genitori`/`legame`) | ✅ Fatto: `alunni.numero_domanda_sidi` + staging `sidi_import_batches` (migr. `20260762`); parser **jszip pluggable** (`normalizeSidiRow` sostituibile), matching numero domanda→CF-fallback→crea, genitori dedup CF, **idempotente**. Route `/api/admin/sidi/import`. UI in `SidiPanel` |
| **P5 — Client SIDI + flussi + sync (DL-049)** | `['admin','coordinator']` (trasmissioni) / `requireStaff` (legami/sync-state) | service-role; legami validati Segreteria | `logScrittura` (`legame_sidi`) | ✅ Fatto (**egress gated**): `src/lib/sidi/client.ts` (503 `non_configurato`/`non_accreditato`), builder neutri + serializer sostituibili, guardie sequenza (Fase A→freq→PU, 409), `sidi_config` + `sidi_sync_state` + `student_parents.validato_*` (migr. `20260763`). Route `/api/admin/sidi/{fase-a,frequentanti,piattaforma-unica,legami,sync-state}` + `settings/sidi` (password mascherata). UI `/admin/sidi` indicatore a cascata. **Invio reale subordinato all'accreditamento ministeriale** |
| **P5 — Bulk gruppi mensa (DL-050)** | `requireStaff` | service-role | `logScrittura` (`alunni`/`gruppo_mensa`) | ✅ Fatto: `gruppi_mensa` + `alunni.gruppo_mensa_id` (migr. `20260761`), `PATCH /api/admin/students` ramo `gruppo_mensa_id` + CRUD `/api/admin/gruppi-mensa`, `BulkAssignBar` esteso |

### 6.1 Nota — moduli 0-6 / tasks / avvisi: cablaggio auth COMPLETATO
Prerequisito **risolto**: le UI docente di diary, armadietto, tasks e avvisi sono state
cablate al modello auth (`getCurrentTeacherId` → `userId` su TUTTE le chiamate, incl.
`meta`/`upload`/by-id; `syncEngine` incluso) e i relativi endpoint ora applicano
gate `requireDocente` + scope per tenant + `logScrittura`, **distinguendo i flussi
GENITORE che restano aperti** (carico armadietto, "preso in carico" richieste, timeline
diario, lettura/risposte avvisi). Aggiunta la migrazione `20260719` con `scuola_id` su
`armadietto`/`task_interni`/`avvisi` (backfill via join canonici: alunno→scuola,
autore→scuola; per `task_interni` via `real_author_id` JSON, non il proxy `author_id`).

**Da fare lato utente (ambiente agent offline verso Supabase):** applicare la migrazione
`20260719` e verificare a runtime (genitore 200 sulle sue azioni / 403 sulle azioni staff;
pagine esistenti senza 401; cross-tenant 403). NB: la lista `tasks` è vuota finché la
migrazione non è applicata (filtra per `scuola_id`). La primaria — cuore conforme
O.M. 3/2025 + FEA — resta pienamente coperta.

---

# PRD - Kidville App: Modulo Diario 0-6 anni (Nido e Infanzia)

## 1. Obiettivo del Modulo
Il modulo Diario 0-6 anni ha lo scopo di documentare la routine quotidiana dei bambini del Nido e
dell'Infanzia. È progettato per essere uno strumento di data-entry ultra-rapido per l'insegnante e
un feed di aggiornamento costante per il genitore, garantendo che ogni evento rilevante (pasti,
nanna, igiene) sia comunicato istantaneamente.

## 2. Logica degli Eventi e Routine
### 2.1 Categorie di Routine
Il sistema gestisce i seguenti eventi, ciascuno con campi specifici:
• Entrata: Registrazione dell'orario di arrivo.
• Attività: Tipo di attività, flag di partecipazione e modalità di coinvolgimento (descrizione testuale libera).
• Merenda Mattutina: Tipologia e quantità.
• Pranzo (Multi-Pasto): Diviso per portate (Primo, Secondo, Contorno, Frutta).
• Compilazione automatica: Se il menu del giorno è inserito nel modulo Mensa, i campi "portata" vengono popolati automaticamente.
• Livelli di consumo: Niente, Poco, Metà, Quasi tutto, Tutto, Bis.
• Nanna: Registrazione obbligatoria dell'orario di Inizio e Fine.
• Bagno / Igiene: Monitoraggio specifico di: Pipì, Cacca, Uso del Vasino (per potty training).

## 3. Esperienza Utente: Insegnante (Data-Entry)
### 3.1 Operatività e Velocità — Flusso Event-First + Bottom Sheet
Il data-entry segue un flusso sequenziale in **due step** per ridurre gli errori cognitivi:
- **Step 1 — Selezione Tipo di Evento:** La schermata principale mostra esclusivamente una griglia di pulsanti grandi e touch-friendly, uno per ciascun tipo di routine (Entrata, Attività, Merenda, Pranzo, Nanna, Sveglia, Bagno). La lista degli alunni non è visibile in questa fase.
- **Step 2 — Bottom Sheet con Controlli Inline:** Dopo aver toccato un evento, un pannello scorre dal basso (bottom sheet) mostrando la lista completa dei bambini presenti. I controlli specifici per l'evento appaiono **inline, accanto ad ogni bambino** — senza navigare su nuove pagine o aprire modali aggiuntivi. Il pulsante "Salva per tutti" chiude il pannello e sincronizza i dati.
- **Filtro Presenze:** Le sezioni di inserimento mostrano esclusivamente i bambini segnati come "Presenti" nel modulo Presenze. Gli assenti vengono rimossi automaticamente dalla lista per evitare errori di input.
- **Note Libere:** Ogni evento può essere integrato con note scritte a mano per una personalizzazione totale della comunicazione.

### 3.1.1 Campi Specifici per Tipo di Evento
- **Entrata:** Campo orario d'ingresso (pre-compilato con l'ora corrente, modificabile manualmente) per ogni bambino.
- **Attività:** Quattro pulsanti di partecipazione per ogni bambino: "Non fatta", "Con difficoltà", "Con aiuto", "In autonomia". Codice colore: rosso, arancio, giallo, verde.
- **Pranzo (Multi-Portata):** Per ogni bambino, una riga di pulsanti quantità (✗ Niente / ¼ Poco / ½ Metà / ¾ Quasi tutto / ★ Tutto) per **ciascuna portata del giorno** (Primo, Secondo, Contorno, Frutta). Se il menu del giorno prevede N portate, compaiono N righe per bambino. I bambini con allergie appaiono evidenziati in rosso.
- **Merenda:** Come il Pranzo, ma con una sola portata generica.
- **Nanna (Inizio):** evento con **pulsante dedicato e distinto**; campo orario d'inizio del riposo pomeridiano per ogni bambino. *(Decisione definitiva — incongruenza #6: Nanna e Sveglia restano DUE pulsanti separati, non un pulsante unico.)*
- **Sveglia (Fine Nanna):** evento con **pulsante dedicato e distinto** dalla Nanna; campo orario di fine riposo per ogni bambino. La coppia Nanna→Sveglia documenta il riposo nella forma "dalle … alle …".
- **Bagno/Igiene:** Tre contatori cumulativi per bambino — **Pipì** (💧), **Cacca** (💩) e **Vasino** (🚽, potty training) — con pulsanti + e − per incrementare/decrementare il conteggio. Il valore viene salvato come numero intero (es. "Pipì: 2, Cacca: 1, Vasino: 1"). *(Decisione definitiva — incongruenza #7: il Vasino è un controllo previsto e implementato.)* Ogni evento Bagno scala 1 pannolino dall'Armadietto solo per i bambini con flag "Usa pannolino" (vedi Anagrafica §2.1 e Armadietto §2.2; incongruenza #9).


### 3.2 Sicurezza e Validazione
• Dashboard Allergie: Fin dal mattino, la dashboard dell'insegnante evidenzia le allergie/intolleranze del giorno.
• Allerta Mensa: Nella sezione pasto, i bambini con allergie o intolleranze compaiono con il nome in rosso per richiamare l'attenzione immediata dell'operatore.
• Buffer di Modifica (10 Minuti): Per prevenire l'invio di notifiche errate, il sistema prevede una finestra di 10 minuti dal salvataggio durante la quale l'insegnante può modificare o annullare l'evento prima che la notifica push venga inoltrata al genitore.

## 4. Esperienza Utente: Genitore (Timeline)
### 4.1 Visualizzazione e Feedback
• Timeline Unificata: II genitore visualizza un flusso cronologico unico e verticale di tutti gli eventi della giornata (Timeline Feed).
• Notifiche Push: Il sistema invia una notifica push per ogni singolo evento registrato (dopo il buffer di 10 min), garantendo una trasparenza totale in tempo reale.
• Modalità Sola Lettura: La timeline è puramente informativa; non è prevista interazione (like o commenti) da parte del genitore.
• Multilingua Dinamico: Tutte le voci standard delle routine (es. "Ha dormito", "Pasto completo") vengono tradotte automaticamente nella lingua impostata sul dispositivo del genitore.

### 4.2 Privacy e Media
• Privacy Tagging: Le foto caricate nel diario possono taggare più bambini. La foto sarà visibile esclusivamente nella timeline dei genitori dei bambini taggati.

## 5. Amministrazione e Monitoraggio (Segreteria)
### 5.1 Configurazione e Controllo
• Customizzazione per Classe: La Segreteria può abilitare o disabilitare specifiche categorie di routine in base alla classe (es. disabilitare "Bagno/Cambio" per le classi dell'Infanzia che non ne necessitano).
• Dashboard di Monitoraggio: Uno strumento dedicato permette alla Segreteria di vedere in tempo reale quali classi stanno compilando il diario e quali sono inattive, facilitando il coordinamento didattico.
• Archiviazione e Storico:
  • I dati del diario oltre i 14 giorni non sono più consultabili dal genitore per ottimizzare le performance, ma rimangono accessibili alla Segreteria per controlli o audit.
  • Al passaggio del bambino alla Scuola Primaria, la sezione "Diario 0-6" scompare automaticamente dalla Ul del genitore, rimanendo visibile solo lato insegnante come archivio storico.

## 6. Specifiche Tecniche di Sincronizzazione
• Timestamp Offline: In caso di assenza di rete, il sistema registra l'orario effettivo in cui l'evento è accaduto (timestamp manuale o di inserimento locale) e lo sincronizza appena la connessione viene ripristinata.
• Disaccoppiamento Mensa: L'inserimento del consumo del pasto nel diario è logicamente separato dallo scalo del ticket mensa nel modulo pagamenti.

> [!NOTE]
> ### Stato Implementazione Diario 0-6
> **Implementato e operativo:**
> - ✅ Flusso Event-First con Bottom Sheet (Step 1 → Step 2)
> - ✅ Entrata: campo orario pre-compilato, inline per bambino
> - ✅ Attività: 4 livelli partecipazione (Non fatta / Con difficoltà / Con aiuto / In autonomia) con codice colore
> - ✅ Pranzo Multi-Portata: accordion per portata, pulsanti quantità (✗/¼/½/¾/★) per bambino
> - ✅ Merenda: come pranzo ma con portata singola
> - ✅ Nanna: orario inizio + orario fine unificati in una riga
> - ✅ Bagno: contatori +/- per Pipì (💧) e Cacca (💩)
> - ✅ Alert allergie visivo (nome in rosso, banner con elenco allergie)
> - ✅ Persistenza dati su Supabase (`eventi_diario`) con logica UPSERT
> - ✅ Ripristino stato da database al cambio sezione
> - ✅ Badge ✅ per alunni salvati, toast di conferma
> - ✅ Alunni caricati da database (`alunni` filtrati per `classe_sezione`)
>
> **Differenze rispetto al PRD — decisioni definitive e correzioni pianificate (Blocco 3):**
> - 🔧 **Nanna/Sveglia (incongruenza #6 — RISOLTA):** oggi unificati in un unico pulsante "Nanna" con due input orario. Decisione: DUE pulsanti distinti "Nanna (Inizio)" e "Sveglia (Fine Nanna)" che registrano "dalle … alle …". *Da correggere nel codice.*
> - 🔧 **Filtro presenze (incongruenza #8 — RISOLTA):** oggi vengono mostrati tutti gli alunni della sezione. Decisione: requisito **ATTIVO** — mostrare solo i bambini "Presenti" nel modulo Presenze. *Da implementare.*
> - ✅ **Bagno/Igiene — Vasino (incongruenza #7 — RISOLTA):** contatori Pipì 💧, Cacca 💩 e **Vasino 🚽** (potty training) sono controlli previsti e implementati.
> - 🔧 **Armadietto/pannolino (incongruenza #9 — RISOLTA):** decisione — ogni evento Bagno scala 1 pannolino dall'Armadietto solo per i bambini con flag "Usa pannolino" in Anagrafica. *Da implementare.*
> - ⚠️ I nomi delle portate pranzo sono ancora mock (`MOCK_MEAL_COURSES`) — in futuro saranno caricati dal modulo Mensa via Supabase
> - ⚠️ Il buffer di modifica 10 minuti (§3.2) non è ancora implementato
> - ⚠️ Le note libere per evento non sono ancora esposte nell'interfaccia (il campo `nota_libera` esiste nel DB)
> - ⚠️ La timeline genitore (§4) non è ancora implementata

---

# PRD - Kidville App: Modulo Armadietto (Gestione Materiale Scolastico)

## 1. Obiettivo del Modulo
Il modulo Armadietto digitalizza la gestione dei materiali personali dei bambini (Nido e Infanzia),
sostituendo i biglietti cartacei e le comunicazioni verbali alla porta. Il sistema si basa su un
approccio ibrido: un inventario automatizzato a scalare per i beni di consumo continuo (es.
pannolini) e un sistema di alert "a semaforo" per le richieste puntuali, garantendo sempre la
massima chiarezza per i genitori e un basso carico cognitivo per lo staff.

## 2. Gestione Inventario e Tipologie di Materiale
### 2.1 Catalogo Materiali Multi-Tenant
• Materiali di Default: Il sistema prevede categorie base quali Pannolini, Asciugamani, Creme e Cambi completi.
• Personalizzazione Sede: Ogni scuola (tenant) ha la facoltà di configurare, aggiungere o rimuovere voci dalla propria lista predefinita tramite il pannello di Amministrazione.
• Richieste Custom: Oltre ai materiali in lista, l'insegnante dispone di un campo a testo libero per richiedere oggetti fuori standard.

### 2.2 Sistema a Scalare e Logica del Semaforo
La gestione delle scorte si basa su un algoritmo quantitativo:
• Carico Merci: Quando il genitore consegna il materiale, l'insegnante registra fisicamente l'ingresso nell'app, specificando i dettagli (es. marca, taglia e quantità totale di pannolini).
• Consumo Automatico: Ad **ogni evento "Bagno/Igiene"** registrato nel modulo Diario 0-6 il sistema scala automaticamente **un'unità di pannolino** dal totale disponibile nell'armadietto, **esclusivamente per i bambini con il flag "Usa pannolino" attivo in Anagrafica** (vedi §2.1 Anagrafica Alunno). I bambini senza tale flag non subiscono alcuno scalo, anche se per loro viene registrato un evento Bagno (es. solo uso del vasino). Lo scalo riguarda il solo materiale "pannolino"; gli altri materiali si scalano unicamente con consumo manuale registrato dall'insegnante.
• Alert Visivi (Semaforo): Il livello delle scorte viene comunicato cromaticamente:
  • Verde: Scorte sufficienti.
  • Giallo: Allerta di esaurimento (giacenza inferiore a 5 unità).
  • Rosso: Emergenza/Esaurito (giacenza inferiore a 2 unità).

## 3. Esperienza Utente: Insegnante (Data-Entry e Controllo)
• Indipendenza dalle Presenze: A differenza del Diario, le richieste di materiale non sono inibite se l'alunno è assente. L'insegnante può inoltrare l'avviso in modo che il genitore prepari il materiale per il rientro.
• Selezione Massiva (Bulk): Per ottimizzare i tempi, l'insegnante può selezionare più bambini contemporaneamente e inviare una richiesta collettiva per lo stesso materiale.
• Chiusura del Ciclo: Il ciclo di richiesta viene considerato "Chiuso" e risolto esclusivamente dall'insegnante nel momento in cui verifica la ricezione fisica del materiale in classe.
• Supporto Offline: Tutte le operazioni di richiesta o aggiornamento scorte sono garantite anche in assenza di connettività, salvate in cache locale e sincronizzate automaticamente alla ripresa del segnale di rete.

## 4. Esperienza Utente: Genitore (Notifiche e Interfaccia)
• UI "Lista della Spesa": All'interno dell'app del genitore, la sezione Armadietto mostra in modo chiaro le quantità residue dei materiali a scuola e funge da lista visiva per gli elementi mancanti richiesti dall'insegnante.
• Isolamento Profili: In caso di account multi-figlio, le notifiche e gli alert sono rigidamente associati al profilo (avatar) del singolo bambino.
• Notifiche e Reminder:
  • La richiesta genera un avviso immediato al momento dell'invio da parte dell'insegnante.
  • Il sistema prevede un Reminder Automatico schedulato per le ore 07:00 del mattino seguente, per massimizzare la probabilità che il genitore non dimentichi il materiale.
• Feedback di Rassicurazione: Alla ricezione della notifica, il genitore può cliccare un pulsante di acknowledgment (es. "Preso in carico" / "Lo porto domani"), che aggiorna in tempo reale lo stato lato insegnante.
• Accesso allo Storico: L'interfaccia genitore non prevede l'accesso a uno storico delle richieste pregresse per mantenere l'Ul pulita ed essenziale.

## 5. Amministrazione e Monitoraggio (Segreteria)
• Abilitazione per Grado Scolastico: La Segreteria può disattivare integralmente il widget Armadietto per specifiche classi o gradi d'istruzione (es. Scuola Primaria, dove la gestione cambia radicalmente rispetto a Nido/Infanzia).
• Dashboard delle Inadempienze: La Direzione ha a disposizione un pannello di controllo per monitorare le richieste inevase. Il sistema evidenzia i genitori che non hanno fornito il materiale dopo un periodo critico, permettendo solleciti mirati.
• Log degli Ingressi: Per ragioni di trasparenza, il sistema archivia e storicizza esclusivamente gli eventi di "Carico Materiale" (cosa è stato portato e quando). Le mere richieste transitorie non vengono storicizzate, mantenendo il database leggero e ottimizzato.

---

# PRD - Kidville App: Modulo Diario Scuola Primaria (Registro Elettronico)

## 1. Obiettivo del Modulo
Il modulo "Diario Scuola Primaria" funge da vero e proprio Registro Elettronico ufficiale. A
differenza del Nido/Infanzia, questo strumento gestisce logiche didattiche e ministeriali (valutazioni
conformi alla normativa, note, argomenti delle lezioni, presenze orarie). È progettato per garantire
l'isolamento delle discipline tra i docenti, fornire una reportistica chiara ai genitori e supportare la
direzione scolastica nella valutazione periodica e negli adempimenti di scrutinio.

## 2. Appello, Orario e Registro di Classe
### 2.1 Gestione Presenze
• Stati di Presenza: L'insegnante può registrare quattro stati: Presente, Assente, Ritardo e Uscita Anticipata.
• Firma del Docente: La validazione della presenza del docente (firma del registro) avviene tramite un semplice "tap" sull'ora di lezione di riferimento.
• Compresenza: Il sistema supporta l'assegnazione di più docenti alla stessa classe nella stessa ora. Ogni insegnante firma il registro in modo indipendente e personale per la propria quota oraria.

### 2.2 Orario delle Lezioni
• Configurazione Centralizzata: L'orario settimanale e l'assegnazione delle materie sono preimpostati e gestiti esclusivamente dalla Segreteria tramite il pannello Admin.
• Visualizzazione Genitore: Le famiglie hanno accesso a una sezione dedicata in app dove possono consultare l'orario settimanale completo e le materie specifiche previste per il proprio figlio.

## 3. Gestione della Didattica (Argomenti e Compiti)
• Compilazione della Lezione: Contestualmente alla firma dell'ora, l'insegnante è tenuto a inserire l'argomento svolto in classe e i compiti assegnati per casa.
• Allegati Multimediali: Per entrambe le voci (argomenti e compiti), il docente ha la possibilità di allegare file multimediali (es. foto della lavagna, pagina del libro o schede).
• Visibilità e Assegnazione Compiti:
  • I compiti appaiono in una bacheca dedicata nell'app genitore/alunno.
  • Nessuna Notifica: L'assegnazione dei compiti non genera notifiche push (modalità consultazione pull).
  • Sola Lettura: Non è prevista una funzione di spunta o contrassegno "Svolto" lato genitore/alunno.
  • Recupero Assenti: I compiti assegnati e gli argomenti svolti rimangono visibili alle famiglie degli alunni risultati "Assenti" in quella giornata, garantendo il diritto al recupero.

## 4. Sistema di Valutazione e Voti

> [!IMPORTANT]
> **Adeguamento normativo (L. 1 ottobre 2024, n. 150 e O.M. n. 3 del 9 gennaio 2025).**
> Nella scuola primaria i **voti numerici sono vietati**, sia in itinere sia in sede di scrutinio.
> Il modello precedente (voti 1-10 + livelli Base/Intermedio/Avanzato dei riferimenti 2020) è
> **superato** e va sostituito. Lo stato attuale del codice ([GradesTab.tsx](src/components/features/teacher/register/GradesTab.tsx),
> tabella `valutazioni` con `voto_numerico`/`giudizio_testo`) **non è conforme** per la primaria.

> [!IMPORTANT]
> **Decisioni definitive — incongruenze #1, #2, #3, #4 (vedi Appendice → Note di coerenza).** *(Aggiornate dopo revisione del committente: media e categorie di prova confermate.)*
> - **#1 (Voto visibile = giudizio sintetico):** alla **primaria** il voto **visibile/ufficiale** mostrato a docenti e famiglie è **esclusivamente il giudizio sintetico** (in itinere e a scrutinio); **non si mostrano voti numerici 1-10**. È però **mantenuta un'associazione numerica interna/nascosta** a ciascun giudizio (es. *Sufficiente* = 6), usata **solo internamente** per il calcolo della media (vedi #3). I voti numerici visibili restano possibili solo per i gradi non-primaria.
> - **#2 (Scala giudizi):** l'unica scala ammessa per i giudizi sintetici della primaria è quella dell'**Allegato A O.M. 3/2025** — *Ottimo, Distinto, Buono, Discreto, Sufficiente, Non sufficiente*. La vecchia scala **Base/Intermedio/Avanzato** è **SUPERATA**.
> - **#3 (Medie — MANTENUTE, solo docente):** alla primaria **il calcolo della media È PREVISTO**, basato sull'**associazione numerica nascosta** dei giudizi sintetici (#1). La media è uno strumento interno di sintesi **del docente**. **Visibilità: la media numerica è mostrata ESCLUSIVAMENTE al personale docente/segreteria e NON è MAI visibile al genitore** — né in itinere né nell'area famiglia, e non viene nemmeno inviata al client dell'app genitore. L'app genitore espone solo i giudizi (sintetici/descrittivi), mai valori numerici o medie. Il documento di valutazione resta espresso in giudizi.
> - **#4 (Scritto/Orale/Pratico — MANTENUTE):** la categorizzazione **Scritto/Orale/Pratico è mantenuta anche alla primaria**: serve sia come tipologia della prova sia per i **termini di immodificabilità §8** (orali 2gg / scritte-pratiche 15gg). La valutazione in itinere usa comunque obiettivi di apprendimento e quattro dimensioni.

### 4.1 Motore di Valutazione Ibrido (configurabile per grado)
Il sistema espone un **unico motore di valutazione**, il cui comportamento è determinato da una
configurazione a livello di Admin per **grado d'istruzione / sezione**:
• **Primaria:** modello a **giudizi** conforme O.M. 3/2025. La modalità a voti numerici è disabilitata
  e non selezionabile dal docente.
• **Altri gradi (es. eventuale secondaria di primo grado):** può essere abilitata la modalità a voti
  numerici classici (1-10) con categorizzazione Scritto/Orale/Pratico.
• La configurazione è impostata dalla Segreteria/Dirigenza e applicata automaticamente in base alla
  classe dell'alunno: il docente non sceglie il "sistema di voto", lo eredita dal contesto.

### 4.2 Valutazione in Itinere (Primaria) — per Obiettivi di Apprendimento
La valutazione quotidiana mantiene **funzione formativa** e si articola così:
• **Obiettivi di Apprendimento:** prima di inserire qualsiasi valutazione, il docente associa alla
  propria disciplina gli obiettivi di apprendimento estratti dal **curricolo d'istituto** (definiti per
  classi parallele). Gli obiettivi sono gestiti come anagrafica configurabile (Admin/Dirigenza).
• **Valutazione per Dimensioni:** una prova viene legata a uno o più obiettivi e descritta tramite le
  quattro dimensioni cardine:
  1. **Autonomia** (Sì / No)
  2. **Continuità** (Sì / No)
  3. **Tipologia della situazione** (Nota / Non nota)
  4. **Risorse mobilitate** (Interne / Esterne / Entrambe)
• **Giudizio descrittivo auto-generato:** sulla base delle dimensioni il sistema propone un giudizio
  descrittivo testuale, **pienamente modificabile** dall'insegnante.
• **Giudizio sintetico in itinere (alternativa):** in alternativa al descrittivo esteso, il docente può
  registrare direttamente un giudizio sintetico abbreviato (es. Buono, Sufficiente) correlato
  all'obiettivo testato, per semplificare la visualizzazione nel prospetto.
• **Nessun voto numerico** alla primaria, in nessuna delle due modalità.
• **Annotazione numerica privata (facoltativa):** sulla singola verifica in itinere il docente può registrare un **appunto numerico** (scala /10) come **strumento di lavoro personale**. Vincoli: (a) il valore **ufficiale** periodico/finale per disciplina resta il **giudizio sintetico** (Allegato A) scelto dal docente; (b) l'annotazione **non compare** sul documento di valutazione (pagella/scrutinio); (c) **non è MAI visibile al genitore** (endpoint docente con gate di ruolo; gli endpoint `/api/parent/**` non la espongono); (d) **non genera automaticamente** il giudizio e **non produce medie automatiche**. Il sistema può al massimo **suggerire** un giudizio sintetico a partire dal numero (giudizio col valore nascosto più vicino), ma il docente deve **confermarlo** esplicitamente.

### 4.3 Scrutinio Periodico e Finale (Primaria) — Sei Giudizi Sintetici
In sede di scrutinio (intermedio e finale), il team dei docenti contitolari attribuisce a ciascun
alunno, **per ogni disciplina del curricolo** (compresa l'**Educazione Civica**), un unico **giudizio
sintetico** correlato al livello di apprendimento raggiunto. La scala è quella dell'**Allegato A
dell'O.M. 3/2025**, implementata in modo rigido (non rimodulabile nelle definizioni standard):

| Giudizio sintetico | Livello |
|--------------------|---------|
| **Ottimo** | Autonomia e consapevolezza piene anche in situazioni complesse e non note |
| **Distinto** | Buona autonomia, errori rari, gestione positiva di situazioni nuove simili a quelle note |
| **Buono** | Attività portate a termine con autonomia, in situazioni note |
| **Discreto** | Autonomia parziale, prevalentemente in situazioni note e con risorse fornite |
| **Sufficiente** | Attività essenziali svolte solo in situazioni note e con supporto/risorse esterne |
| **Non sufficiente** | Esecuzione incerta e non adeguata al contesto, anche con supporto |

• **Declinazioni locali (PTOF):** pannello di configurazione lato Admin/Dirigente per importare le
  declinazioni dei descrittori deliberate dagli organi collegiali, che integrano/sostituiscono i testi
  standard in pagella (le definizioni della scala restano comunque ancorate all'Allegato A).
• **Giudizio di comportamento:** espresso collegialmente come giudizio sintetico (no decimi).
• Il giudizio di scrutinio può essere proposto a partire dal quadro delle valutazioni in itinere, ma
  resta **modificabile/sovrascrivibile** collegialmente dal team docenti.

### 4.4 Isolamento delle Materie e Riservatezza tra Colleghi
• La visibilità delle valutazioni è limitata alla **propria disciplina**: un docente non accede alle
  valutazioni assegnate allo stesso alunno da docenti di altre materie.
• Eventuali aggregazioni/prospetti d'insieme sono riservate al team in sede di scrutinio e alla Dirigenza.

### 4.5 Comunicazione alle Famiglie
• **Solo giudizi, mai numeri:** l'area genitore mostra **esclusivamente i giudizi** (sintetici e/o
  descrittivi) e l'argomento della prova. **Nessun voto numerico e nessuna media** sono visibili al
  genitore, in itinere o a scrutinio; la media numerica resta uno strumento riservato al docente (vedi
  §4 #3) e non viene neppure trasmessa al client dell'app genitore.
• **Buffer di Sicurezza (a tempo):** una valutazione in itinere diventa visibile al genitore (e la
  notifica push parte) solo **trascorso il buffer dalla creazione** — `notif_buffer_valutazioni_min`,
  default 10 minuti — per consentire correzioni. La visibilità è calcolata sul **tempo di creazione**
  (`creato_il`), non su un flag di pubblicazione separato: il docente vede subito la propria valutazione,
  il genitore solo dopo il buffer.
• **Nessuna firma richiesta** per le normali valutazioni in itinere.
• **Persistenza Visiva:** in caso di account genitore sospeso (ritardi amministrativi), i dati del
  registro (valutazioni e compiti) restano comunque visibili, a tutela del diritto all'informazione didattica.

### 4.6 Note di Migrazione Dati
La struttura attuale (`valutazioni.voto_numerico`, `valutazioni.giudizio_testo`, `materia` testo libero)
va evoluta verso un modello che supporti: riferimento a **materia master** (vedi §6 Orario e Materie),
**obiettivi di apprendimento**, le **quattro dimensioni**, il **giudizio sintetico** (enum vincolato per
la primaria) e una distinzione tra valutazione *in itinere* e *di scrutinio*. La modalità a voti numerici
resta supportata a schema solo per i gradi non-primaria.

## 5. Note e Provvedimenti Disciplinari
• Categorizzazione Cromatica: Le note sono suddivise in tre categorie distinte, differenziate visivamente (tramite colori/icone) sull'app del genitore:
  1. Nota Disciplinare (Comportamento)
  2. Nota Didattica (Es. materiale dimenticato)
  3. Compiti a casa non svolti
• Assegnazione Massiva: L'insegnante può selezionare più alunni (o l'intera classe) e assegnare una nota collettiva con un'unica operazione.
• Firma per Presa Visione: A differenza dei voti, le Note Disciplinari richiedono obbligatoriamente l'interazione del genitore, che deve apporre una firma digitale per "presa visione" direttamente dall'applicazione, confermando la ricezione della comunicazione.

## 6. Orario, Tempo Scuola e Materie
La primaria adotta la **contitolarità** (più docenti sulla stessa classe) e diversi modelli di tempo
scuola. Il sistema supera la logica "una materia in testo libero per ora" introducendo dati strutturati.

### 6.1 Materie Master (Discipline)
• Anagrafica delle **discipline** gestita dalla Segreteria/Dirigenza (es. Italiano, Matematica, Storia,
  Geografia, Scienze, Inglese, Arte, Musica, Ed. Fisica, Tecnologia, Religione/Alternativa).
• **Educazione Civica** come disciplina trasversale dedicata (oggetto di valutazione autonoma a scrutinio).
• **Mensa** modellabile come **turno/disciplina** del tempo scuola (vedi §6.3), associabile anche a
  gruppi-classe quando gli alunni provengono da classi diverse.
• Valutazioni (§4) e firme di lezione si **agganciano alla materia master** (non più testo libero).

### 6.2 Campanelle e Matrice Oraria
• Definizione delle **"campanelle"** (intervalli orari di lezione) per plesso/classe.
• Matrice oraria settimanale che associa, per ciascuna campanella, **classe → materia → docente/i**.
• Gestione molti-a-molti per contitolarità (più docenti sulla stessa ora/classe).

### 6.3 Modelli di Tempo Scuola
• Configurazione per plesso/classe dei modelli: **Tempo Normale (27 o 29 ore)** e **Tempo Pieno (40 ore)**.
• Nel tempo pieno, l'orario include mensa e ricreazione come tempo scuola a tutti gli effetti.

### 6.4 Configurazione e Visibilità
• L'orario settimanale e l'assegnazione materie sono **gestiti dalla Segreteria** (pannello Admin).
• Le famiglie consultano in app l'**orario settimanale** e le materie previste per il proprio figlio.

## 7. Compresenza e Firma del Registro
### 7.1 Firma di Lezione
• La firma dell'ora avviene con un "tap" sulla campanella; contestualmente il docente inserisce
  **argomento svolto** e **compiti** (con eventuali allegati, vedi §3).

### 7.2 Compresenza — Cofirma Digitale
• Più docenti possono accedere alla **stessa ora/classe**. Il secondo docente (es. sostegno o
  potenziamento) può apporre la propria **cofirma** sull'argomento inserito dal docente ordinario,
  selezionando la **tipologia di compresenza** dal pannello.

### 7.3 Firma Indipendente per Alunni Specifici (oscuramento)
• Quando il docente di sostegno svolge **attività individualizzate** non coincidenti con la
  programmazione di classe, può firmare la medesima ora ma indirizzare **argomento, compiti e note
  esclusivamente a uno o più alunni selezionati**.
• Tali contenuti sono **oscurati alle famiglie degli altri alunni** per ragioni di riservatezza
  (visibilità ristretta ai soli destinatari).

## 8. Vincoli Temporali e Immodificabilità delle Registrazioni
Il registro elettronico ha natura di **atto pubblico**: inserimenti e modifiche sono tracciati e
sottoposti a vincoli temporali.

| Operazione | Termine massimo (default, configurabile) |
|------------|------------------------------------------|
| Modifica annotazioni del registro di classe | 2 giorni dall'evento |
| Inserimento valutazioni per prove orali | 2 giorni dallo svolgimento |
| Inserimento valutazioni per prove scritte/pratiche | 15 giorni dallo svolgimento |

• **Configurabilità:** i termini sono impostabili dall'istituto (con i valori di default sopra).
• **Blocco automatico:** oltre la scadenza il sistema impedisce inserimenti/modifiche.
• **Sblocco riservato:** solo Dirigente/Supervisor può sbloccare, **previa richiesta motivata**.
• **Tracciamento:** ogni inserimento, modifica e sblocco è registrato nell'audit (`registro_modifiche`):
  utente, azione, valore precedente/nuovo, timestamp, IP.

## 9. Scrutinio e Pagella Online
### 9.1 Workflow di Scrutinio
• Sessione collegiale del **team docenti contitolari**: per ogni alunno si consolidano i giudizi
  sintetici per disciplina + Educazione Civica + comportamento (vedi §4.3).
• La Dirigenza coordina e chiude la sessione di scrutinio (periodico e finale).

### 9.2 Documento di Valutazione (Pagella) — Livello Base
• Al termine dello scrutinio il sistema **genera il documento di valutazione in PDF statico** non modificabile.
• Le famiglie scaricano la pagella dall'area riservata, con l'**autenticazione attuale dell'app**.

> [!NOTE]
> **Conformità firma rimandata.** In questa fase la pagella **non** prevede firma digitale qualificata
> del Dirigente, né contrassegno elettronico, né download previa autenticazione forte SPID/CIE.
> Tali requisiti (integrazione certificatori di firma qualificata e identità digitale) sono pianificati
> come **fase successiva** e andranno aggiunti per la piena dematerializzazione a norma.

---

# PRD - Kidville App: Modulo Foto e Video (Galleria Multimediale)

## 1. Obiettivo del Modulo
Il modulo "Foto e Video" funge da hub centralizzato per la condivisione dei media scolastici. È un
widget trasversale, abilitato per tutti i gradi d'istruzione (Nido, Infanzia, Primaria). Il sistema è
progettato attorno a un rigoroso meccanismo di "Privacy Tagging", garantendo la totale aderenza
al GDPR e tutelando l'immagine dei minori, pur mantenendo un'esperienza di consultazione fluida
per le famiglie.

## 2. Caricamento e Gestione Media (Lato Insegnante)
### 2.1 Upload e Organizzazione
• Selezione Multipla (Bulk Upload): I docenti possono caricare simultaneamente più foto e video dalla galleria del proprio dispositivo.
• Nessun Limite di Formato: Non sono previsti limiti stringenti sulla durata dei video caricati.
• Feed Cronologico Unico: Non è prevista la creazione di cartelle o "Album" tematici. Tutti i media confluiscono in un unico feed verticale ordinato cronologicamente dal più recente al meno recente.
• Pubblicazione Diretta: L'upload da parte dell'insegnante è istantaneo e non richiede l'approvazione o la moderazione preventiva da parte della Segreteria.

### 2.2 Meccanismo di Tagging e Privacy Lock
• Regola del Tag Obbligatorio: Un contenuto multimediale viene caricato sui server, ma non è visibile a nessun genitore finché l'insegnante non effettua il tagging esplicito.
• Lista Completa: L'interfaccia di tagging mostra la lista completa degli alunni della classe (non filtrata per presenze giornaliere), permettendo al docente di selezionare chi è ritratto.
• Blocco Liberatoria Privacy: Il sistema implementa un blocco di sicurezza (Privacy Lock). Se per un determinato alunno la famiglia non ha firmato la liberatoria per l'uso delle immagini, il sistema inibisce l'interfaccia, impedendo fisicamente all'insegnante di selezionare e taggare quel bambino.

## 3. Esperienza Utente: Genitore (Visualizzazione e Interazione)
### 3.1 Visualizzazione Isolata
• Filtro Assoluto: II genitore ha accesso unicamente ai contenuti multimediali in cui il profilo del proprio figlio è stato esplicitamente taggato dall'insegnante. Foto di gruppo o di altri bambini in cui il figlio non compare sono totalmente invisibili e inaccessibili.
• Interazione in Sola Lettura: La galleria ha uno scopo puramente documentale. Non sono previste interazioni social (nessun "Mi piace", né commenti).

### 3.2 Azioni sui Media
• Download: I genitori sono autorizzati a scaricare liberamente foto e video sulla memoria locale del proprio smartphone.
• Condivisione Nativa: È presente un pulsante "Condividi" che permette di esportare il media verso app di terze parti (es. WhatsApp, Telegram) sfruttando le funzionalità native del sistema operativo del telefono.

## 4. Strumenti di Amministrazione e Sicurezza (Segreteria)
### 4.1 Moderazione e Controllo
• Cancellazione Globale: La Direzione/Segreteria detiene i diritti di amministrazione assoluta e può eliminare istantaneamente qualsiasi foto o video dal database e dal feed di tutti gli utenti, intervenendo rapidamente in caso di segnalazioni.

### 4.2 Comunicazioni Istituzionali (Bypass Tagging)
• L'Amministrazione ha a disposizione uno strumento per caricare "Media Generici" (es. locandine di eventi, foto della struttura vuota, comunicazioni visive). Per questi caricamenti, la Segreteria può bypassare il meccanismo di tagging e inviare il file in broadcast a tutti i genitori dell'istituto o a classi specifiche.

### 4.3 Tutela dell'Immagine (Watermark)
• Watermark Automatico: Per tutelare la provenienza e la proprietà delle immagini scolastiche, l'applicazione applica in automatico in fase di caricamento un watermark contenente il logo della scuola. Questo viene posizionato di default al centro in basso su ogni singola foto caricata dai docenti.

## 5. Interconnessioni Architetturali
• Sincronizzazione con "Diario 0-6": Il modulo Galleria funziona come collettore centrale. Le foto scattate e taggate direttamente all'interno delle attività del Diario Nido/Infanzia (es. lavoretto, momento della merenda) confluiscono automaticamente e in tempo reale in questo widget, evitando duplicazioni di caricamento per il docente.

---

# PRD - Kidville App: Modulo Presenze e Check-in/Check-out

## 1. Obiettivo del Modulo
Il modulo Presenze è il sistema centrale per il tracciamento fisico degli alunni all'interno della
struttura scolastica. Copre l'intero ciclo giornaliero (dall'ingresso all'uscita), gestisce in modo
sicuro le deleghe di ritiro e funge da "sorgente di verità" per abilitare o disabilitare l'operatività di
altri moduli (come il Diario e il Registro di Classe).

## 2. Esperienza Utente: Insegnante (Appello e Uscita)
### 2.1 Fase di Check-in (Ingresso)
• Vista di Classe: L'insegnante visualizza esclusivamente la lista degli alunni assegnati alla propria classe.
• Logica "Empty State": All'apertura della schermata di appello, la lista si presenta non compilata (nessun "Presente" di default).
• Timestamp Automatico e Modificabile: Un semplice tap sul nome dell'alunno segna lo stato "Presente" e l'app registra automaticamente l'orario di ingresso (Check-in) basato sull'orologio di sistema. Qualora l'alunno fosse entrato precedentemente e l'insegnante stesse compilando il registro in ritardo, l'orario di Check-in può essere modificato manualmente.

### 2.2 Fase di Check-out (Uscita) e Sicurezza
• Registrazione Uscita: A fine giornata (o in caso di uscita anticipata), l'insegnante esegue il "Check-out", registrando l'orario effettivo di uscita dalla struttura.
• Verifica Delegati: L'insegnante non è tenuto a selezionare manualmente chi ha ritirato il bambino, ma ha a disposizione un rapido accesso in sola lettura alla lista dei delegati autorizzati.
• Riconoscimento Visivo: Aprendo la scheda delegati, l'insegnante visualizza in tempo reale la foto del documento d'identità caricato in precedenza dalla famiglia, permettendo un riconoscimento visivo immediato e sicuro.
• Allarme Ritiro Non Autorizzato (Panic Alert): Qualora si presenti una persona non presente nella lista dei delegati, l'insegnante ha a disposizione un pulsante di blocco/allerta. La pressione del tasto genera una notifica istantanea simultanea alla Segreteria e all'App del Genitore, bloccando l'uscita dell'alunno.

### 2.3 Operatività Offline
• Caching Locale: Tutte le operazioni di Check-in e Check-out sono garantite anche in assenza di rete. I dati vengono salvati nella cache locale e sincronizzati automaticamente con il cloud al ripristino della connettività.

## 3. Esperienza Utente: Genitore (Assenze e Giustifiche)
• Comunicazione Silenziosa: Non sono previste notifiche push in tempo reale per i normali eventi di Check-in e Check-out, per evitare di sovraccaricare il genitore con avvisi considerati di routine.
• Preavviso di Assenza: Il genitore può inserire preventivamente, in totale autonomia tramite l'App, un avviso di assenza (es. per malattia o motivi familiari) prima dell'inizio delle lezioni.
• Caricamento Certificati Medici: In caso di assenza prolungata (es. superiore ai giorni previsti dal regolamento), l'interfaccia richiede e permette al genitore l'upload diretto del certificato medico di riammissione, che andrà in validazione alla Segreteria.

### 3.1 Libretto Web — Giustificazione Online (con PIN dispositivo)
• **Giustificazione online:** in presenza di assenza, ritardo o uscita anticipata registrati dal docente,
  l'area genitore abilita la funzione di **giustificazione digitale** dell'evento.
• **PIN dispositivo:** l'operazione è protetta dall'inserimento di un **codice PIN dispositivo** scelto
  dal genitore, per prevenire utilizzi non autorizzati (equivalente digitale del libretto cartaceo).
• **Tracciamento:** ogni giustificazione registra autore, evento giustificato, motivazione, timestamp e
  presa visione; lo storico è consultabile da genitore e Segreteria.
• **Integrazione:** la funzione si lega agli eventi del modulo `presenze` e al flusso certificati medici
  esistente; più tutori dello stesso alunno mantengono libretti/PIN distinti.

## 4. Dashboard Amministrazione e Cucina
### 4.1 Monitoraggio Segreteria
• Fotografia Globale: La dashboard della Segreteria mostra una panoramica in tempo reale degli alunni presenti in tutta la struttura, con la possibilità di cliccare ed effettuare un "drill-down" (dettaglio) per visualizzare i numeri specifici di ogni singola classe.
• Sovrascrittura Dati: La Direzione possiede i permessi di amministrazione per modificare, correggere o sovrascrivere eventuali errori di registrazione (presenze/assenze) commessi dagli insegnanti.
• Export Ministeriale: È presente una funzione di esportazione (in formato Excel/PDF) dei registri di presenza validi ai fini dei controlli MIUR per Nido, Infanzia e Primaria.

### 4.2 Dashboard Cucina e Cut-off Mensa
• Orario di Cut-off: II limite orario (es. 09:30) per l'invio dei numeri definitivi dei pasti viene gestito direttamente dalla Dashboard della Cucina.
• Approvazione Ritardi: Se un alunno entra in Ritardo (post cut-off), la sua presenza viene registrata, ma l'aggiunta del suo pasto alla lista della cucina richiede un'approvazione manuale da parte della Segreteria.

## 5. Interconnessioni Architetturali e di Flusso
• Isolamento Finanziario: II tracciamento delle presenze/assenze non ha alcun impatto automatizzato sulla fatturazione o sulle rette mensili gestite nel modulo Pagamenti.
• Disaccoppiamento Mensa: Segnare un bambino "Presente" non consuma automaticamente il ticket pasto. Le due azioni (Check-in fisico e consumo del pasto nel Diario) rimangono logicamente separate per l'insegnante.
• Sincronizzazione Diario 0-6: Un alunno che non è marcato "Presente" in questo widget globale scompare automaticamente dalle liste di selezione multipla del Diario di Bordo (Nido/Infanzia), prevenendo l'inserimento accidentale di routine (es. pasti, nanna) per bambini non a scuola.
• Sincronizzazione Primaria: Allo stesso modo, lo stato di "Assente" nel modulo Presenze generale si riflette in automatico nel Registro di Classe della Scuola Primaria.

---

# PRD - Kidville App: Modulo Comunicazione (Chat e Bacheca Avvisi)

## 1. Obiettivo del Modulo
Il modulo Comunicazione centralizza tutti i flussi informativi della piattaforma Kidville. È suddiviso
in tre macro-aree logiche: la messaggistica istantanea (Chat) per il dialogo quotidiano e privato tra
scuola e famiglia, la Bacheca per le comunicazioni ufficiali (Circolari/Avvisi) e un sistema di Task
interno per il coordinamento dello staff. Il modulo è progettato per abbattere le barriere
linguistiche e garantire il pieno controllo amministrativo da parte della Direzione.

## 2. Chat Privata (Scuola - Famiglia)
### 2.1 Logica e Inoltro Messaggi
***Comunicazione 1-a-1:** La messaggistica è rigorosamente individuale. Non sono previsti "Gruppi Classe" tra genitori.
***Isolamento Genitoriale:** In caso di più tutori per lo stesso bambino (es. genitori separati), le chat rimangono distinte. Ogni genitore ha un thread separato con l'insegnante.
***Vincolo di Contatto:** I genitori possono avviare e intrattenere chat esclusivamente con gli insegnanti assegnati alla classe del proprio figlio.
***Operatività H24:** II sistema permette l'invio e la ricezione di messaggi 24 ore su 24, senza blocchi orari imposti dal sistema.

### 2.2 Funzionalità Multimediali e Accessibilità
***Condivisione File:** All'interno della chat è pienamente supportato l'invio di allegati multimediali, inclusi documenti (PDF), fotografie e note vocali.
***Traduzione Automatica:** Per favorire l'inclusione, il modulo integra un sistema di traduzione automatica in tempo reale, permettendo agli insegnanti e alle famiglie straniere di comunicare efficacemente ciascuno nella propria lingua madre.

## 3. Bacheca e Avvisi Ufficiali (Circolari)
### 3.1 Creazione e Targeting
***Permessi di Invio:** La Segreteria può inviare comunicazioni a livello globale (intero istituto) o filtrarle per classi specifiche. Anche il singolo Insegnante ha i permessi per creare e pubblicare avvisi, limitatamente alla propria classe di competenza.
***Tipologia di Avviso:**
***Presa Visione:** L'apertura e la lettura dell'avviso da parte del genitore registra automaticamente la "Presa visione" a sistema (Read Receipt).
***Richiesta di Adesione:** Per avvisi che richiedono un'autorizzazione (es. gita scolastica), il sistema abilita pulsanti interattivi che permettono al genitore di esprimere una conferma (Si) o un diniego (No) esplicito.

### 3.2 Monitoraggio
***Dashboard Avvisi:** L'interfaccia di Segreteria e dell'Insegnante include un cruscotto di monitoraggio per ogni avviso inviato. Mostra in tempo reale l'elenco di chi ha letto la comunicazione e un recap tabellare delle risposte per le richieste di adesione.

## 4. Comunicazione Interna (Gestione Task Staff)
***Dashboard Segreteria-Insegnanti:** La comunicazione organizzativa interna non avviene tramite chat, ma attraverso un sistema a bacheca/task.
***Assegnazione Comunicazioni:** Se un genitore lascia un messaggio in Segreteria o se c'è una direttiva interna, la Direzione crea un "Task/Comunicazione" assegnandolo a una classe intera (visibile a tutti i docenti di quella sezione) oppure a un singolo insegnante specifico.

## 5. Sicurezza e Amministrazione (Direzione)
### 5.1 Permessi di "Super-Admin"
* La Direzione/Segreteria dispone di privilegi di livello Super-Admin. Questo garantisce la facoltà di accedere in sola lettura e in chiaro a tutte le chat private intercorse tra insegnanti e genitori, al fine di tutelare l'istituto e risolvere eventuali controversie. *(P0: l'identità Super-Admin è risolta dalla sessione (`requireStaff` → `resolveIdentity`), non più da `?userId=`.)*

### 5.2 Persistenza dei Dati
***Conservazione Storico:** I thread di chat non vengono mai cancellati automaticamente (nemmeno al termine dell'anno scolastico), ma fungono da storico. La cancellazione di una chat può avvenire solo tramite intervento manuale e insindacabile della Direzione.
***Sempre Attivo (Emergenze):** Il modulo di comunicazione è considerato un canale critico. Pertanto, anche nel caso in cui l'account di un genitore venga sospeso per motivazioni amministrative (es. insolvenze), la chat privata rimane pienamente operativa per garantire la comunicazione in caso di emergenze.

---

# PRD - Kidville App: Modulo Gestione Form di Raccolta Dati (Kidville)

## 1. Descrizione Generale
La funzione "Form" di Kidville rappresenta il motore avanzato per la creazione, compilazione, gestione e validazione di moduli digitali. Pensato per sostituire integralmente il cartaceo, il sistema gestisce l'intero ciclo di vita del dato: dalla raccolta tramite interfacce utente lussuose e guidate, fino all'importazione automatizzata nelle anagrafiche principali del gestionale, passando per la validazione legale tramite Firma Elettronica Avanzata (FEA).

## 2. Obiettivi
- **Digitalizzazione Completa:** Gestire iscrizioni, deleghe, consensi (es. privacy/foto), sondaggi e creazione automatica di graduatorie.
- **Esperienza Premium (UX):** Offrire ai genitori un flusso di compilazione "wizard" (passo-passo, una pagina per persona) fluido e privo di stress cognitivo.
- **Gestione Staff Intuitiva:** Fornire agli amministratori un costruttore di form Drag & Drop altamente visivo.
- **Sicurezza e Validità Legale:** Garantire la protezione dei dati (tramite RLS in Supabase) e la validità delle firme tramite verifica OTP via Email.
- **Integrazione Nativa:** Automatizzare i flussi di ETL (Extract, Transform, Load) verso le anagrafiche direttamente tramite PostgreSQL.

## 3. Stack Tecnologico di Riferimento
- **Frontend:** Next.js 19, React, Tailwind CSS, Framer Motion (per micro-animazioni nei wizard), @dnd-kit/core (per il builder).
- **Backend & Database:** Supabase (PostgreSQL per dati relazionali e JSONB per campi dinamici), Supabase Auth.
- **Storage:** Supabase Storage.
- **Automazioni & ETL:** Trigger e funzioni PL/pgSQL nativi, pg_cron per task schedulati.
- **Generazione Documenti:** Server-side via API Routes (Next.js) integrato con librerie di generazione PDF (es. Puppeteer o PDFKit).

## 4. Requisiti Funzionali
### 4.1. Creazione e Configurazione Modelli (Form Builder)
- **Interfaccia Costruttore:** Area dedicata allo staff (Form > Modelli) dotata di un'interfaccia Drag & Drop per assemblare rapidamente i moduli.
- **Componenti Dinamici:** Possibilità di inserire blocchi predefiniti (Dati Bambino, Dati Adulto, Consensi, Caricamento Allegati) o campi personalizzati. **✅ (P3.3e, DL-029)** blocco **Consensi/Privacy** (tipo `consent`: testo del consenso + link informativa + checkbox obbligatoria) e blocco **Allegati** (tipi file ammessi + dimensione max) disponibili nella palette del builder e configurabili nel `PropertiesPanel`; l'accettazione dei consensi è archiviata con **snapshot legale** (`form_submissions.consents_log`: testo + timestamp, evidenza GDPR).
- **Logica Condizionale:** Impostazione di regole di visibilità e obbligatorietà basate sulle risposte precedenti. **✅ (P3.3a, DL-024)** motore puro `src/lib/forms/conditional.ts` (operatori =, ≠, contiene, >, <): il wizard mostra/nasconde i campi a runtime, valida solo i visibili (un campo nascosto, anche obbligatorio, non blocca) e rimuove i valori nascosti dalla submission; editor condizione nel `PropertiesPanel`. Modello a singola condizione per campo (`FormField.condition`).
- **Scoring per Graduatorie:** Il builder deve permettere l'assegnazione di un "peso" o "punteggio" (scoring) a specifiche risposte o blocchi (es. +5 punti per genitori lavoratori, +3 punti per fratelli già iscritti) per automatizzare la generazione delle graduatorie. **✅ (P3.3b, DL-025)** scoring applicato in live (migr. `20260743`: colonne+trigger+indice); **delibera ammissioni** automatica (soglia+posti, `calcolaDelibera`) con esito ammesso/lista_attesa/non_ammesso, override per-candidato ed **export PDF** della delibera. *(NB: trigger ETL form→anagrafiche deferito per drift `adults`/`student_adults`.)*
- **Configurazione Accessi:** Definizione di chi può compilare il form (utenti registrati o tramite link pubblico). Nota: Nessuna integrazione SPID richiesta. **✅ (P3.3f, DL-030)** **Pubblica modello**: dal builder la Segreteria pubblica/ritira il modello e ottiene un **link pubblico** `/m/{public_token}` (`POST /api/admin/form-models/publish`, colonne `published_at`/`public_token`/`access_mode` — migr. `20260747`). **Config accessi**: `public` (chiunque col link) o `authenticated` (solo registrati). La compilazione anonima passa da `/m/[token]` → endpoint **token-scoped** `/api/public/forms/[token]/submit|upload` (consensi obbligatori applicati; snapshot `consents_log`). *(La firma OTP su form pubblici — raccolta email firmatario — è rinviata alla slice firma congiunta.)*
- **Impostazioni FEA:** Abilitazione della Firma Elettronica Avanzata, definendo i firmatari richiesti (firma singola o congiunta di entrambi i genitori). *(DL-001: FEA realizzata in-house come servizio trasversale Fase P1 — OTP email + ricevuta PDF con log IP/Timestamp/Hash SHA-256.)* **✅ Implementato (P1):** servizio `src/lib/fea/` riusabile — builder `signature_log` canonico, **slot firmatari** `fea_signatures` con policy di completamento configurabile (default `any-one`, opzione `all-required` — DL-007), **audit immutabile** `fea_audit_log` (DL-009), **ricevuta PDF inattaccabile** `GET /api/fea/receipt` (hash documentale SHA-256 + IP/UA/timestamp, libreria **jsPDF** — DL-006). Consumatori ricablati: wizard moduli, ricezione pagella, giustifica assenza. *(Nota legale: implementazione in-house "FEA" per DL-001; informativa/processo da validare col committente.)* **✅ Firma congiunta + reinvio OTP (P3.3g, DL-031):** `signature_mode` `single`/`joint` su `form_models` (migr. `20260748`, toggle nel builder). In `joint` la submission resta `pending_signature` finché entrambi i genitori non firmano: `/api/forms/send-otp` è **slot-aware** (registra uno slot `fea_signatures` per firmatario, completa con policy `all-required`); il **2° firmatario** è email-only (POST send-otp con `submissionId`+`signerEmail`). **Reinvio OTP** = POST send-otp con `submissionId` (rigenera+reinvia). UI `OtpSignatureModal`: bottone "Reinvia codice" (cooldown) + step "2° genitore".

### 4.2. Compilazione Form (Lato Utente/Genitore)
- **Modalità di Rete:** Compilazione strettamente "Online-Only" per garantire l'immediata validazione degli OTP e la sicurezza dei caricamenti.
- **UX / UI Design:** Flusso "Wizard" (Step-by-step). L'interfaccia mostrerà una sezione alla volta (es. "Pagina 1: Dati Madre", "Pagina 2: Dati Padre", "Pagina 3: Dati Bambino") con transizioni fluide gestite da Framer Motion.
- **Firma Elettronica e OTP:** Al termine della compilazione, il sistema invierà un codice OTP via Email al firmatario per validare legalmente il documento prima dell'invio definitivo.
- **Caricamento Allegati:** Supporto per l'upload di documenti (es. carte d'identità, certificati medici) direttamente all'interno dei passaggi del wizard. **✅ (P3.3e, DL-029)** endpoint upload generico server-side `POST /api/forms/upload` (service-role, validazione tipo/dimensione, bucket privato `form_attachments`): ripara l'upload nel wizard **autenticato** (il client browser anon non può scrivere su bucket deny-by-default). Sicurezza allegati = **service-role + scoping app** (nessuna policy `storage.objects`, coerente con P0).

### 4.3. Gestione Compilazioni (Raccolta Dati)
- **Dashboard Raccolta:** Vista a tabella/lista per lo staff con filtri avanzati (data, stato, modello, tag).
- **Anteprima e Modifica:** Visualizzazione chiara dei dati JSONB raccolti. Possibilità per lo staff di applicare correzioni amministrative mantenendo un log della versione originale compilata dall'utente.
- **Generazione ed Esportazione:**
  - **Generazione PDF:** Gestita lato server per garantire un layout impeccabile e non gravare sul dispositivo dell'utente. I PDF escluderanno gli allegati fisici dalla stampa.
  - **Esportazione XLSX:** Download dell'intero dataset per analisi esterne.
  - **Integrazione Anagrafiche (ETL nativo):** I dati raccolti nei moduli di "Iscrizione" vengono riversati nelle tabelle anagrafiche principali di Kidville (Utenti, Bambini, Relazioni). Questo processo di mapping ed estrazione dai campi JSONB avviene direttamente nel database tramite funzioni e trigger PostgreSQL SQL, garantendo massima velocità e consistenza relazionale.

### 4.4. Gestione Graduatorie
- **Calcolo Punteggi:** Generazione automatica di liste di ammissione basate sui pesi/punteggi configurati nel Form Builder.
- **Dashboard Graduatorie:** Possibilità per lo staff di visualizzare il ranking, applicare correzioni manuali (override di punteggio per casi eccezionali) e deliberare le ammissioni.

## 5. Requisiti Non Funzionali e Sicurezza
### 5.1. Sicurezza e Storage (RLS)
- **Row Level Security (RLS) Rigorosa:** Le policy su Supabase Storage e Database devono essere strettissime. Gli allegati caricati durante la compilazione devono essere accessibili esclusivamente al compilatore originale e al personale amministrativo autorizzato (Staff). Nessun accesso pubblico o inter-utente.

### 5.2. Automazioni e Cron Jobs
- **Motore di Automazione Interno:** L'invio di solleciti per firme non completate, promemoria di scadenza moduli e altri task periodici sono gestiti interamente dal database utilizzando l'estensione pg_cron di PostgreSQL su Supabase. Nessun servizio esterno per l'orchestrazione dei job.

### 5.3. Performance e Accessibilità
- L'approccio server-side per i documenti complessi e l'utilizzo di viste materializzate / query JSONB ottimizzate in PostgreSQL garantiranno altissime performance anche con migliaia di compilazioni storiche archiviate.
- Compatibilità totale della web app su browser desktop e mobile.

---

# PRD - Kidville App: Modulo Menu e Mensa

## 1. Obiettivo del Modulo
Il modulo "Menu e Mensa" automatizza la filiera della ristorazione scolastica. Gestisce in modo
integrato la pianificazione ciclica dei pasti, la sicurezza alimentare tramite il matching automatico
degli allergeni, l'amministrazione dei "Ticket Pasto" a scalare e fornisce interfacce dedicate sia
per lo staff didattico che per il personale di cucina.

## 2. Configurazione Menu e Gestione Cucina
### 2.1 Menu Builder e Ciclicità
• Menu Builder Digitale: La Segreteria non carica PDF statici, ma utilizza un "Menu Builder" nativo per strutturare i pasti (Primo, Secondo, Contorno, Frutta).
• Ciclicità Programmabile: Il sistema supporta la creazione di menu ciclici. La Segreteria imposta la durata del ciclo (es. 4 settimane) e il sistema autocompila il calendario futuro, riducendo il data-entry.
• Variazioni Giornaliere: È possibile applicare eccezioni e variazioni al menu giornaliero (es. sostituzione di un ingrediente non consegnato dal fornitore), che generano in automatico una notifica di aggiornamento alle famiglie.
• Gestione Calendario Chiusure: La Segreteria imposta i giorni di festività/chiusura a livello globale. In tali giorni, l'intero modulo mensa si disattiva, inibendo richieste pasti e scali di ticket.

### 2.2 Dashboard Dedicata (Ruolo "Cuoca")
• Isolamento dell'Interfaccia: Il sistema prevede un Ruolo Auth specifico per il personale di cucina. Accedendo con questo ruolo su un tablet, la "Cuoca" visualizza esclusivamente la dashboard mensa.
• Dati Operativi: La dashboard mostra in tempo reale i numeri definitivi dei pasti da preparare, raggruppati per tipologia (Pasti Standard, Diete in Bianco, Diete Speciali per intolleranze), garantendo massima privacy e oscurando il resto delle funzioni dell'app (es. chat, valutazioni).

## 3. Sicurezza Alimentare e Intolleranze
• Tracciamento Obbligatorio: Durante l'inserimento dei piatti nel Menu Builder, è obbligatorio specificare i relativi allergeni (es. glutine, lattosio, uova).
• Matching Automatico e Alert: Il sistema incrocia costantemente gli allergeni del piatto con i dati medici dell'Anagrafica dell'alunno.
• Interfaccia Genitore: Nel calendario menu del genitore, se è previsto un pasto pericoloso per il bambino, il piatto viene automaticamente contrassegnato con un'icona di allerta visiva inequivocabile (es. semaforo rosso).

## 4. Ticketing e Modello Economico
### 4.1 Logica "Prepagato a Scalare"
• Saldo Separato: Il sistema funziona a "Ticket Pasto" a scalare. Ogni alunno possiede un proprio saldo individuale (nessun "portafoglio famiglia" condiviso in caso di fratelli).
• Ricarica Offline (Solo Segreteria): L'acquisto di nuovi pacchetti di ticket non avviene tramite pagamento in-app (es. Stripe). Le famiglie acquistano i ticket tramite la Segreteria, la quale ha un'interfaccia dedicata per accreditare manualmente il numero di ticket e il relativo importo al profilo dell'alunno.
• Reminder Esaurimento Scorte: Quando il saldo di un alunno scende sotto una soglia critica preimpostata, il sistema invia in automatico una notifica push al genitore ("Attenzione, ticket mensa in esaurimento").

### 4.2 Consumo e Rimborsi
• Scatto del Ticket: II ticket viene scalato nel momento in cui il genitore (tramite la propria app) spunta/prenota attivamente la consumazione del pasto per la giornata.
• Storni Manuali: La Segreteria possiede i permessi amministrativi per effettuare rimborsi manuali o riaccreditare ticket in caso di uscite anticipate impreviste.

## 5. Operatività Quotidiana (Docenti e Famiglie)
### 5.1 Flusso Insegnante e Richieste Speciali
• Vista Menu e Consumi: L'insegnante visualizza il menu in un tab separato dell'app, corredato dalla lista degli alunni che hanno regolarmente prenotato il pasto per quel giorno.
• Diete in Bianco: L'insegnante può richiedere una dieta in bianco per un alunno (es. in caso di malessere temporaneo). Questa operazione deve avvenire rigorosamente entro l'orario di cut-off (es. 09:30) per aggiornare tempestivamente i monitor della cucina.
• Esclusioni di Classe: In caso di gita scolastica, l'insegnante ha a disposizione un comando di "blocco massivo" per annullare la mensa per tutta la classe con un solo click.

### 5.2 Specificità Scuola Primaria
• Poiché alla Scuola Primaria non si utilizza il Diario 0-6 per la rendicontazione dei pasti, è prevista una sezione speciale "Cucina/Mensa". In questo tab, la Segreteria o l'insegnante compila in modo rapido l'elenco dei bambini effettivamente presenti in refettorio, permettendo al sistema di allineare e scalare correttamente i ticket.

### 5.3 Esportazioni e Fatturazione Esterna
• Report Catering: La Direzione scolastica dispone di uno strumento di esportazione che genera un report di fine mese (Excel/PDF) con i numeri esatti e aggregati dei pasti consumati (divisi per standard e speciali). Questo documento è pronto per essere inviato all'azienda di catering esterna per la rendicontazione e fatturazione.

---

# PRD - Kidville App: Modulo Pagamenti e Gestione Economica

## 1. Obiettivo del Modulo
Il modulo Pagamenti (lib/features/payments/) è il sistema di tracciamento finanziario della
piattaforma. La scelta architetturale fondamentale è l'assenza di pagamenti in-app: l'applicazione
funge da scadenziario, promemoria e registro di stato per le famiglie, mentre la transazione
economica reale avviene esternamente (bonifico, contanti, POS) e viene validata manualmente
dalla Segreteria.

## 2. Creazione e Assegnazione Pagamenti (Lato Segreteria)
### 2.1 Generatore Universale
La Segreteria dispone di un tool per generare qualsiasi tipologia di pagamento (es. Rette, Quote d'iscrizione, Divise, Gite).
• Assegnazione Flessibile: I pagamenti possono essere assegnati massivamente a un'intera classe oppure singolarmente a specifici studenti.
• Rateizzazione: In fase di creazione di un pagamento ad alto importo, la Segreteria ha la facoltà di abilitare un piano di rateizzazione predefinito.

### 2.2 Rette Mensili e Quote
• Automazione Rette: Il sistema genera automaticamente le rette ricorrenti. Di default, la retta applicata e la data di scadenza sono standard per tutti.
• Override Anagrafico: Non ci sono sconti automatici. Eventuali modifiche all'importo della retta (es. sconti fratelli) o alla data di scadenza devono essere impostate manualmente dalla Segreteria all'interno dell'Anagrafica dello studente.
• Quote d'Iscrizione: A differenza delle rette, la quota di iscrizione annuale non si autogenera all'importazione dell'alunno, ma deve essere assegnata manualmente.
• Split Pagamenti (Genitori Separati): Su richiesta delle famiglie, la Segreteria può impostare dall'Anagrafica la divisione del debito (es. $50/50$) su due account genitoriali distinti.

## 3. Registrazione, Fatturazione e Morosità
### 3.1 Registrazione Incassi
• II genitore non può pagare tramite l'app.
• Quando la Segreteria riceve il pagamento, lo registra manualmente a sistema. L'aggiornamento dello stato in "Pagato" è istantaneo e si riflette in tempo reale sull'app del genitore.
• Fatturazione su Richiesta: Il sistema non invia fatture automaticamente. La Segreteria ha a disposizione un pulsante "Invia Fattura/Ricevuta" per generare e inoltrare il documento al genitore.

### 3.2 Cruscotto Insoluti
• Dashboard Morosità: La Direzione ha una visuale completa sui pagamenti in sospeso. Gli utenti insoluti e i pagamenti scaduti sono evidenziati cromaticamente in rosso.
• Sospensione Manuale: Il blocco dell'account per grave morosità (es. inibizione delle funzioni app) non è automatico, ma richiede un'azione manuale e consapevole da parte della Direzione. **✅ (P3.2, DL-021)** flag soft per-alunno (`alunni.sospeso`), set dalla Direzione (`POST /api/admin/pagamenti/sospensione` + audit); il genitore legge ma le azioni di servizio (firme moduli) sono inibite; banner genitore + badge admin. *(Login e info di sicurezza sul minore preservati.)*

## 4. Esperienza Utente Genitore e Reminder
### 4.1 Visualizzazione a Categorie
• L'interfaccia genitore categorizza i pagamenti per tipologia (es. "Rette", "Quote di iscrizione", "Mensa", "Gite"). **✅ (P3.2, DL-022)** vista raggruppata per `payment_categories` (`raggruppaPerCategoria`), storico saldati + pendenze per categoria. Ricevuta PDF non fiscale scaricabile sul saldato **✅ (DL-023)**.
• Ogni categoria mostra chiaramente lo storico dei pagamenti saldati e le pendenze future.
• Voci Facoltative: Per i pagamenti non obbligatori, il genitore può semplicemente ignorarli; resteranno visibili nell'elenco fino alla data di naturale scadenza.

### 4.2 Sistema di Reminder Aggressivo
• Per combattere le insolvenze, il sistema prevede una logica di notifica push automatizzata per i pagamenti obbligatori:
  1. Notifica nel giorno esatto della scadenza.
  2. Reminder ricorrente inviato ogni due giorni finché la Segreteria non contrassegna la voce come saldata.

## 5. Interconnessioni Modulari
• Widget Mensa: La vendita dei pacchetti ticket mensa è gestita unicamente dalla Segreteria, che inserisce manualmente nel sistema il numero di pasti acquistati a seguito del pagamento esterno.
• Widget Form (Gite): II flusso amministrativo per le gite richiede un doppio check. Nell'elenco riepilogativo della Segreteria e dell'insegnante, l'alunno avrà il "Semaforo Verde" per partecipare all'uscita solo se possiede sia l'autorizzazione firmata digitalmente (Modulo Form) sia la quota saldata (Modulo Pagamenti). **✅ Proxy upload cartaceo (P3.3h, DL-032):** se un genitore consegna il modulo **firmato a penna** alla porta, la maestra/Segreteria carica la **scansione** dal semaforo docente (`POST /api/teacher/modulistica`, **gate `requireDocente`**): upload reale su `form_attachments/cartaceo/`, la sottomissione è marcata `origine='cartaceo'` (migr. `20260749`) con evidenza strutturata (`method:'PROXY_CARTACEO'`, staff acquirente, IP/UA/timestamp) + audit `logScrittura`; il **merge PDF di classe** distingue "(CARTACEO)" dalla FES digitale. *(Era uno stub: salvava un path finto, senza upload né gate.)*

---

# PRD - Kidville App: Modulo Fatturazione Elettronica (Integrazione Aruba)

> **✅ Implementato (P3.1, 2026-06-26 — DL-017/018/019/020):** integrazione **reale** Aruba REST (no mock).
> Generatore XML FatturaPA in-house (B2C/FPR12, TD01, IVA 0% Natura N4, no bollo, IdTrasmittente Aruba PEC),
> client REST `signin/upload/getByFilename`, numerazione interna per scuola/anno, state machine stati SDI,
> monitoraggio scarti via cron `fatture-sdi-sync` con notifica realtime Segreteria + banner, copia di cortesia
> PDF al genitore. Credenziali mai esposte (env/vault). **La verifica live end-to-end con lo SDI è subordinata
> alle credenziali Aruba DEMO/PROD del committente** (codice pronto, attivazione con flag + credenziali).

## 1. Obiettivo del Modulo
Il modulo di Fatturazione Elettronica estende le capacità finanziarie del sistema interfacciandosi
nativamente con l'ecosistema Aruba. L'obiettivo è generare vere e proprie fatture elettroniche (in
formato XML destinate al Sistema di Interscambio - SDI dell'Agenzia delle Entrate) in modo
sicuro, rispettando le normative fiscali vigenti per gli enti scolastici, senza appesantire il flusso di
lavoro manuale della Segreteria.

## 2. Architettura Sicura e Flusso API
• Backend Proprietario per la Sicurezza: Per garantire la massima sicurezza e non esporre mai le chiavi API di Aruba nel codice frontend dell'applicazione, l'intera logica di comunicazione con Aruba avviene lato server. Il click sul pulsante nell'app innesca una chiamata API a un endpoint dedicato del nostro backend (es. Node.js/Python). Il backend, che dialoga in sicurezza con il database PostgreSQL, si occuperà di eseguire la chiamata protetta verso i server di Aruba in background, mantenendo nascoste le chiavi API.
• Azione Esclusivamente Manuale: Non è prevista alcuna automazione occulta. La generazione e l'invio della fattura ad Aruba avvengono solo ed esclusivamente se la Segreteria preme fisicamente il pulsante "Invia Fattura" in corrispondenza di un pagamento saldato. Se il pulsante non viene premuto, il pagamento risulta registrato internamente ma non viene emessa alcuna fattura.

## 3. Anagrafica e Dati di Fatturazione
• Intestatario Predefinito: All'interno dell'Anagrafica dell'alunno è presente un campo obbligatorio denominato "Intestatario Fattura". La Segreteria seleziona a quale dei due genitori (o tutori legali) dovranno essere intestate di default le fatture fiscali.
• Recupero Dati Automatico: Al momento dell'emissione, il sistema interroga l'anagrafica del Genitore Intestatario e compila automaticamente il tracciato XML con tutti i dati richiesti da Aruba per la validazione (es. Nome, Cognome, Indirizzo di Residenza completo, Codice Fiscale, Codice Destinatario/PEC).

## 4. Regole Fiscali e Numerazione
• Numerazione Sequenziale: Kidville delega completamente la gestione del progressivo numerico (es. Fattura n. 1, 2, 3...) al sistema Aruba, evitando conflitti di numerazione e garantendo l'allineamento fiscale sul cassetto fiscale della scuola.
• Regime IVA e Natura: Tutte le fatture emesse tramite questo flusso applicano automaticamente l'esenzione IVA per i servizi scolastici, utilizzando l'impostazione fissa: 0% di IVA, Natura N4 (Esente Articolo 10).
• Esclusione Marca da Bollo: Il sistema è configurato per non applicare in automatico alcuna riga relativa all'addebito della marca da bollo, lasciando l'importo della prestazione pulito.

## 5. Gestione Errori e Interfaccia Genitore
• Monitoraggio Scarti SDI: Se la fattura inviata ad Aruba viene successivamente scartata dal Sistema di Interscambio (SDI) dell'Agenzia delle Entrate (ad esempio per un Codice Fiscale errato nell'anagrafica del genitore), il backend di Kidville intercetta lo stato e invia una notifica di errore in tempo reale alla dashboard della Segreteria, specificando il motivo dello scarto per permettere una rapida correzione.
• Download Self-Service per le Famiglie: Una volta che la fattura è stata emessa con successo, l'interfaccia dell'App Genitore si aggiorna in automatico. In corrispondenza della voce di pagamento saldata (es. "Retta di Marzo"), comparirà un'icona di download che permette al genitore di scaricare sul proprio dispositivo la copia di cortesia in formato PDF generata da Aruba.

---

# PRD - Kidville App: Modulo Impostazioni (Pannello di Controllo Globale)

## 1. Obiettivo del Modulo
Il modulo Impostazioni (lib/features/admin/ e lib/core/) rappresenta la cabina di regia del SaaS
Kidville. Accessibile esclusivamente con privilegi di Direzione/Segreteria (Super-Admin), permette
di plasmare dinamicamente ogni singola funzionalità descritta nei moduli precedenti. Questo
garantisce che la piattaforma sia scalabile e totalmente personalizzabile per ogni singola sede
(Tenant) senza richiedere l'intervento degli sviluppatori.

## 2. Configurazione Globale, Sedi e Ruoli (Anagrafica)
• Gestione Multi-Sede (Tenant): Possibilità di aggiungere, rinominare o disattivare le sedi fisiche della scuola. Ogni sede ha la propria configurazione isolata. **✅ (P3.4b, DL-033)** creata la tabella registry `scuole` (migr. `20260750`, la sede era un `scuola_id` hardcoded; seed della sede esistente); `GET/POST/PATCH /api/admin/schools` **gated alla Direzione** (`requireStaff(['admin','coordinator'])`) per **aggiungi / rinomina / disattiva** (soft `attiva=false`) + `config` jsonb isolata + audit `logScrittura('multi_sede')`; UI `/admin/schools` (`SchoolsPanel`). *(Nessuna FK su `scuola_id` in questa slice: resta soft-reference; hard-delete sede fuori scope.)*
• Gradi d'Istruzione e Classi: Creazione e gestione dei gradi (Nido, Infanzia, Primaria) e delle relative sezioni/classi.
• Gestione Staff (RBAC): Pannello per l'onboarding del personale. La Segreteria può creare account assegnando ruoli rigidi (Docente, Segreteria, Cuoca, Direzione) e associare i docenti alle rispettive classi. **✅ (P3.4a, DL-028)** pannello `/admin/staff` per gestire ruolo/sede/classi del personale esistente (`GET/PATCH /api/admin/staff`), **gate riservato alla Direzione** (admin/coordinator) + self-lockout guard + audit; ruoli assegnabili Docente/Segreteria/Cuoca/Direzione/Amministratore (no genitore). *(Onboarding nuovi account con provisioning auth: resta il flusso invito/credenziali DL-005.)*

## 3. Configurazione Moduli Didattici (Diario e Registro)
### 3.1 Diario 0-6 (Nido e Infanzia)
• Customizzazione Routine: La Segreteria può abilitare o disabilitare specifici widget di routine (es. "Bagno", "Nanna") a livello di singola classe (es. togliendo il modulo "Nanna" per le classi dell'Infanzia).

### 3.2 Diario Scuola Primaria
• Materie Master e Orario: Pannello per la gestione delle discipline (incl. Educazione Civica e Mensa-turno), delle campanelle e del palinsesto settimanale (modelli tempo scuola 27/29/40 ore), che si riflette automaticamente nei registri degli insegnanti (vedi Modulo Primaria §6).
• Sistema di Valutazione (motore ibrido per grado): Configurazione del modello di valutazione per grado/sezione. Per la **Primaria** è forzato il modello conforme **O.M. 3/2025** (giudizi per obiettivi in itinere + 6 giudizi sintetici allo scrutinio, voti numerici disabilitati); per eventuali gradi non-primaria è abilitabile il modello a voti numerici. Vedi Modulo Primaria §4.
• Declinazioni Locali (PTOF): Importazione delle declinazioni dei descrittori dei giudizi sintetici deliberate dagli organi collegiali, che integrano/sostituiscono i testi standard dell'Allegato A in pagella.
• Obiettivi di Apprendimento: Gestione del curricolo d'istituto (obiettivi per disciplina e classe) da rendere disponibili ai docenti per la valutazione in itinere.

## 4. Configurazione Armadietto e Mensa
• Inventario Armadietto: Gestione della "Lista Default" dei materiali (es. Pannolini, Salviette, Cambi). La Segreteria può aggiungere nuove voci personalizzate che appariranno poi nei menu a tendina degli insegnanti.
• Setup Cucina e Mensa:
  • Orario Cut-off: Impostazione dell'orario limite (es. 09:30) per la chiusura delle presenze e delle diete in bianco ai fini del calcolo dei pasti.
  • Menu Builder: Accesso allo strumento di creazione dei menu ciclici e associazione obbligatoria degli allergeni ai piatti.
  • Calendario Chiusure: Impostazione dei giorni festivi e di chiusura scolastica in cui il sistema disabilita in automatico scalo ticket e appello.

## 5. Configurazione Flussi Amministrativi e Finanziari
### 5.1 Pagamenti e Ticket
• Rette Default: Impostazione dell'importo standard della retta mensile e della data di scadenza globale (modificabile poi singolarmente dall'anagrafica del singolo alunno).
• Ticket Mensa: Configurazione del costo del singolo Ticket Pasto e dei "Pacchetti" acquistabili (es. pacchetto da 10 o 20 pasti) che la Segreteria utilizzerà per ricaricare i conti degli alunni.
• Gestione Insoluti: Impostazione della tolleranza (numero di giorni di ritardo) prima che un pagamento venga contrassegnato in rosso come "Insoluto".

### 5.2 Modulistica e Form Builder
• Accesso al motore di creazione template (Form Builder). Da qui la Segreteria genera i modelli per uscite didattiche e consensi privacy, impostando i campi dinamici richiesti ai genitori.

### 5.3 Fatturazione Elettronica (Integrazione Aruba)
• Credenziali API: Sezione sicura per l'inserimento e l'aggiornamento delle chiavi API di Aruba. **✅ (P3.1)** username in `admin_settings.aruba_config`; la **password non è mai salvata in chiaro** — si memorizza solo un riferimento (`password_ref`) risolto lato server da env/vault. Ambiente DEMO/PROD selezionabile.
• Dati Scuola: Inserimento dei dati di fatturazione dell'istituto (Partita IVA, Codice Fiscale, PEC, sede strutturata indirizzo/CAP/comune/provincia) necessari per la corretta generazione del tracciato XML. **✅ (P3.1)** consumati dal `CedentePrestatore`.
• Regime IVA: Pannello per mappare le causali di default (es. Retta = Esente IVA Art. 10). **✅ (P3.1)** campo `RegimeFiscale` (default RF01) nei dati fiscali; le fatture applicano comunque IVA 0%/Natura N4 fissa (DL-018).

---

# PRD - Kidville App: Modulo Fascicolo Personale dell'Alunno

## 1. Obiettivo del Modulo
Il Fascicolo Personale è l'archivio documentale e storico dello studente. Contiene dati amministrativi
comuni e **dati particolari (sensibili)** — stato di salute, documenti di inclusione — e deve quindi
sottostare a tutele rigorose di accesso e tracciamento, in conformità al GDPR (Reg. UE 2016/679).
Estende l'anagrafica esistente (oggi limitata a note mediche, flag BES/DSA e delegati).

## 2. Composizione del Fascicolo
### 2.1 Sezione Amministrativa
• Anagrafica studente e genitori/tutori (con **codice fiscale validato**).
• Recapiti telefonici ed e-mail per emergenze.
• **Deleghe al prelievo** all'uscita, con allegato il documento d'identità dei delegati (riusa `delegati`).
• Storico iscrizioni, **pagelle degli anni precedenti** e **certificati delle competenze**.

### 2.2 Sezione Consensi e Privacy
• Modulo di consenso al trattamento dati e informativa privacy firmata.
• **Consenso specifico** per riprese foto/video durante attività didattiche e uscite (collegato al
  Privacy Lock della Galleria).
• Consenso al **trasferimento del fascicolo** informatico ad altra scuola in caso di mobilità.

### 2.3 Sezione Riservata — Documenti di Inclusione (PEI/PDP)
• Diagnosi funzionali, certificazioni ASL e relazioni (L. 104/1992).
• **PEI** redatto dal GLO; **PDP** e certificazioni DSA (L. 170/2010).

## 3. Protezione e Controllo Accessi
> [!IMPORTANT]
> **Livello di protezione adottato (decisione di prodotto): RBAC ristretto + audit accessi.**
> La cifratura dei file è demandata allo storage gestito (Supabase Storage). Una crittografia
> applicativa dedicata (AES-256 a livello di tabella/file) **non** è prevista in questa fase e potrà
> essere introdotta successivamente se richiesto dal titolare del trattamento.

• **RBAC ristretto:** l'accesso (visualizzazione/modifica) a PEI/PDP e documenti sanitari è limitato ai
  **docenti contitolari della classe di riferimento**, al **Dirigente** e al personale di **segreteria
  espressamente autorizzato**. Vietato l'accesso a docenti di altre classi o utenti non profilati.
• **Audit log accessi:** ogni consultazione/modifica di un documento sensibile genera un log
  **immodificabile** (chi, quando, quale documento, finalità) — estensione di `registro_modifiche`.
• **Segregazione logica:** i documenti sensibili sono archiviati separatamente dalla documentazione
  amministrativa, con bucket/percorsi dedicati e ACL distinte.
• **Workflow firma GLO:** il PEI è atto che richiede la sottoscrizione di docenti contitolari,
  specialisti ASL e genitori. Area di collaborazione protetta dove i membri del GLO visualizzano la
  bozza, annotano e appongono la firma per accettazione (firma applicativa in linea con il livello
  "Base" del documento; firma qualificata rimandata, cfr. §9.2 modulo Primaria).

---

# PRD - Kidville App: Modulo Interoperabilità SIDI / Piattaforma Unica

## 1. Obiettivo del Modulo
Garantire l'interoperabilità bidirezionale con il **SIDI** (Sistema Informativo dell'Istruzione) e con
la **Piattaforma Unica** del Ministero, per l'efficienza amministrativa della segreteria e gli
adempimenti di legge. Il registro non opera come sistema isolato.

## 2. Importazione Nuovi Iscritti (Flusso SIDI)
• **Ricezione file ZIP ministeriale:** upload diretto del file `.zip` generato dal SIDI (dati nuovi
  iscritti e famiglie), **senza** che l'operatore debba rinominarlo o modificarlo.
• **Matching su Numero di domanda:** l'associazione/deduplica avviene confrontando il **Numero di
  domanda di iscrizione SIDI** contenuto nel flusso, evitando anagrafiche duplicate e garantendo il
  corretto aggancio dei documenti del fascicolo.
• **Sincronizzazione dati genitori:** sovrascrittura/integrazione dei contatti già presenti, usando il
  **codice fiscale** come chiave primaria di associazione.

## 3. Allineamento Strutturale e Invio Frequentanti
• **Fase A — Struttura di base:** ricezione dal SIDI di sedi, sezioni, classi e tempo scuola per
  allineare il database locale. Le modifiche strutturali lato SIDI vanno recepite **prima** dell'invio
  dei dati alunni.
• **Invio flusso di frequenza:** trasmissione telematica degli alunni effettivamente frequentanti per
  classe. La corretta trasmissione è prerequisito per l'accesso di docenti/famiglie ai servizi della
  Piattaforma Unica.

## 4. Flusso Genitori-Alunni (Piattaforma Unica)
• Flusso periodico (mensile/annuale) di **associazione Genitori-Alunni** trasmesso in cooperazione
  applicativa al SIDI, con le relazioni parentali validate dalla segreteria, così che solo i soggetti
  legalmente responsabili accedano ai dati riservati sulla piattaforma ministeriale.

## 5. Export Certificati delle Competenze (Classe Quinta)
• Generazione e trasmissione al SIDI della **scheda dei certificati delle competenze** di fine classe
  quinta, compilata in sede di scrutinio finale, secondo il **D.M. n. 14 del 30/1/2024**.

> [!NOTE]
> L'attivazione dei flussi SIDI in cooperazione applicativa richiede l'**accreditamento ministeriale**
> del software e le relative credenziali/canali. Le tempistiche (avvio anno scolastico, generalmente
> entro fine ottobre) vincolano la sequenza Fase A → frequentanti → servizi Piattaforma Unica.
>
> **Pianificazione (DL-004, 2026-06-25):** modulo incluso nel master plan come **Fase P5 (finale)**,
> dopo i moduli core. Oggi ~2/12 requisiti implementati.
>
> **Implementato (Fase P5, 2026-06-27, DL-047..050):** ✅ **§2** import `.zip` (parser jszip pluggable) + matching su **Numero domanda** (campo `alunni.numero_domanda_sidi`) + sync genitori per CF (DL-048); ✅ **§3** builder Fase A (sezioni+tempo scuola) + frequentanti (alunni iscritti per classe), con indicatore stato `Fase A → frequentanti → Piattaforma Unica` e guardie di sequenza (DL-049); ✅ **§4** builder associazioni Genitori-Alunni sui **legami validati dalla Segreteria** (DL-049); ✅ **§5** **Certificato delle Competenze** classe quinta (D.M. 14/2024) generato dallo scrutinio finale, PDF + firma FEA + download genitore (DL-047). 🔶 **La trasmissione telematica reale resta GATED** (`sidiTransmit` → 503) finché non si ottiene l'**accreditamento ministeriale** del software (credenziali/canali di cooperazione applicativa) — dipendenza esterna, come la verifica live Aruba/SDI. I serializer del tracciato XML sono **adapter sostituibili** al tracciato ufficiale.

---

# PRD - Kidville App: Accessibilità, Sicurezza e Compliance (Trasversale)

## 1. Obiettivo
Requisiti trasversali a tutti i moduli per garantire conformità ad AgID, MIM e Garante Privacy. Il
mancato rispetto può comportare l'esclusione dal mercato scolastico o sanzioni.

## 2. Accessibilità (Legge Stanca)
• Conformità a **L. 9/1/2004 n. 4 (Legge Stanca)** e s.m.i., **D.Lgs. 106/2018** e **Linee Guida AgID**
  sull'accessibilità (aggiornamento 29/5/2023), con riferimento WCAG.
• Interfaccia ad **alto contrasto** e compatibilità con i principali **screen reader**.
• L'accessibilità è criterio di accettazione per il frontend di tutti i moduli (parent, teacher, admin).
• **✅ Baseline P1 (DL-008):** toggle **alto contrasto globale** persistito su cookie SSR-safe (`<html data-contrast>`, applicato a tutta l'app senza FOUC), set token CSS HC + **focus-ring** visibile + `prefers-reduced-motion`; primitive **Modal accessibile** (`role="dialog"`/`aria-modal`/focus-trap/Escape/restore focus); **landmark** `nav`/`main` + **skip-link** + `aria-current` sulla navigazione; **smoke test `jest-axe`** su login/modale OTP/nav. **WCAG-AA = definition-of-done** dei nuovi frontend; l'audit AA per-pagina dei moduli esistenti è applicato **incrementalmente** nelle fasi successive (non un audit big-bang in P1).

## 3. Privacy e Adempimenti
• **Pubblicazione informative privacy** destinate ad alunni, genitori, docenti e personale ATA, sempre
  disponibili in una sezione dedicata.
• **Raccolta e tracciamento del consenso** per trattamenti che eccedono le attività istituzionali (es.
  pubblicazione foto/video su canali della scuola), con archiviazione sicura del consenso digitale.
• Per alunni con disabilità, BES o DSA, la raccolta del consenso per la trasmissione dati
  all'Anagrafe Nazionale degli Studenti è documentata e, ove necessario, con copia firmata.

## 4. Audit e Tracciabilità
• **Audit log immodificabile** degli accessi a dati e documenti sensibili (chi, quando, finalità),
  in conformità ai requisiti del Garante per le PA — estensione di `registro_modifiche` e
  `firme_documenti` esistenti.
• **RLS in produzione (DL-003, Fase P0):** attivazione effettiva della **Row Level Security** (oggi
  bypassata via `service_role`). Letture lato genitore via `createSessionClient()` (isolamento per
  figlio/sede, identità `parents.auth_user_id = auth.uid()`); scritture staff via `service_role` con
  **audit obbligatorio** (`audit_scritture_docente`). **Roll-out per famiglia-tabella** (alunni →
  presenze → eventi_diario → galleria → valutazioni/note → pagamenti → comunicazione), con
  `get_advisors(security)` a **zero ERROR** come gate tra una famiglia e l'altra; rimozione delle
  policy dev `TO anon`. Nota: lo **staff è già auth-backed** (`utenti.id` FK → `auth.users`, quindi
  `utenti.id = auth.uid()`); le policy staff esistenti restano valide.

## 5. Autenticazione e Accesso (DL-002, Fase P0)
• **Login reale invite-only** su Supabase Auth: pagina `/auth/login` (email+password), `src/middleware.ts`
  di protezione route con redirect anonimo → login, identità risolta **server-side dalla sessione**
  (`resolveIdentity()`: `auth.getUser()` → id app), non più via `?userId=`/header o fallback `DEV_*`.
• **Transizione incrementale (shim):** i gate preferiscono la sessione; l'header `x-user-id` è **ignorato
  se ≠ sessione** (anti-spoofing) e tollerato solo dietro flag `ALLOW_HEADER_IDENTITY` finché i ~104
  punti client non sono ripuliti. Nessun big-bang.
• **Cloud Auth rigida:** **nessuna auto-registrazione** dei genitori; il legame `parent_id ↔ student_id`
  è creato **esclusivamente dalla Segreteria**. Identità unificata: **staff già auth-backed**
  (`utenti.id` FK → `auth.users`); **genitori** autoritativi su `parents`+`student_parents`, resi
  auth-backed via colonna **`parents.auth_user_id`** (la PK `parents.id` non viene ripuntata perché
  referenziata da `student_parents`). `legame_genitori_alunni` resta come compat (record demo).
• **Recupero credenziali:** Segreteria-managed con invio automatico email (DL-005), nessun self-service.

---

# Appendice — Checklist Controlli Richiesti per Ruolo e Pagina

> [!NOTE]
> Questa appendice è la **spec OBIETTIVO**: elenca per ogni ruolo e pagina i pulsanti, le azioni, i badge e gli elementi UI chiave che la pagina **deve** avere, per consentire un confronto (diff visivo) col design implementato. I controlli previsti restano in lista anche se non ancora presenti nel codice. Consolidata da PRD + ROADMAP_TECNICA + prompts/ + codice applicativo.


## Genitore

### `/parent` — Home / Dashboard Genitore
_Modulo PRD: Trasversale + Mobile UI_

**Checklist controlli richiesti:**
- Selettore 'Seleziona figlio' (switch tra figli)
- Indicatore 'Figlio attivo' (avatar iniziali + nome + classe)
- Indicatore stato presenza 'A scuola'
- Widget 'Riepilogo presenze'
- Widget 'Avvisi non letti' (badge contatore)
- Widget 'Pagamenti in scadenza' (riepilogo)
- Indicatore 'Tutto in regola' (pagamenti saldati)
- Azione 'Vai a Pagamenti' (widget riepilogo cliccabile)
- Lista 'Accessi rapidi ai moduli' (griglia tile)
- Pulsante tile 'Pagamenti'
- Pulsante tile 'Mensa'
- Pulsante tile 'Avvisi'
- Pulsante tile 'Chat'
- Pulsante tile 'Diario' (infanzia/nido)
- Pulsante tile 'Galleria'
- Pulsante tile 'Moduli'
- Pulsante tile 'Registro' (primaria)
- Pulsante tile 'Lezioni' (primaria)
- Pulsante tile 'Compiti' (primaria)
- Pulsante tile 'Armadietto' (infanzia)
- Pulsante tile 'Presenze' (infanzia)
- Indicatore 'Saluto orario' (Buongiorno/pomeriggio/sera)
- Tab navigazione 'Home'
- Tab navigazione 'Avvisi'
- Tab navigazione 'Chat'
- Tab navigazione 'Scuola/Diario' (per grado)
- Pulsante 'Altro' (apre sheet sezioni)
- Pulsante 'Chiudi' sheet sezioni
- Lista 'Tutte le sezioni' (sheet Altro)

### `/parent/attendance` — Presenze & Assenze
_Modulo PRD: Presenze §3_

**Checklist controlli richiesti:**
- Selettore figlio (alunno)
- Campo 'Motivo dell'assenza' (opzionale)
- Selettore date assenza (da / a)
- Selettore tipologia (Assenza / Ritardo / Uscita anticipata)
- Pulsante 'Comunica Assenza'
- Banner 'Avviso Inviato' (conferma)
- Pulsante 'Torna Indietro'
- Pulsante 'Carica certificato medico'
- Indicatore stato validazione certificato (in attesa / approvato)
- Pulsante 'Giustifica' evento (assenza/ritardo/uscita)
- Campo PIN dispositivo (giustificazione)
- Campo 'Motivazione giustifica'
- Lista eventi da giustificare
- Lista storico giustificazioni
- Banner Panic Alert ricevuto (ritiro non autorizzato)

### `/parent/primaria/assenze` — Libretto Web / Giustificazioni
_Modulo PRD: Presenze §3.1_

**Checklist controlli richiesti:**
- Lista eventi presenza (assenza/ritardo/uscita anticipata)
- Badge stato 'Assente'
- Badge stato 'Ritardo'
- Badge stato 'Uscita anticipata'
- Badge '✓ Giustificata'
- Badge 'Da giustificare'
- Banner 'N assenze non ancora giustificate'
- Indicatore orario entrata (ritardo)
- Indicatore orario uscita (uscita anticipata)
- Indicatore testo motivazione giustifica
- Indicatore 'Nota docente'
- Pulsante 'Giustifica' su evento da giustificare
- Campo PIN dispositivo per confermare la giustifica
- Campo motivazione giustifica
- Pulsante 'Invia codice OTP' (firma FES via email)
- Campo inserimento codice OTP
- Pulsante 'Conferma giustifica'
- Pulsante 'Comunica assenza in anticipo'
- Selettore data assenza preventiva
- Azione upload certificato medico di riammissione
- Indicatore 'Presa visione' della giustifica
- Indicatore firma FES (autore/timestamp giustifica)
- Banner errore 'Giustifica non più possibile oltre N giorni'

### `/parent/avvisi` — Bacheca Avvisi / Circolari
_Modulo PRD: Comunicazione §3_

**Checklist controlli richiesti:**
- Lista Avvisi/Circolari (card cliccabili)
- Azione Apri/espandi avviso (registra presa visione automatica)
- Pulsante 'Sì, aderisco'
- Pulsante 'No'
- Pulsante 'Allegato File' (apre PDF/documento circolare)
- Pulsante 'Link Esterno'
- Badge 'Nuovo' (avviso non ancora letto)
- Indicatore stato risposta 'Hai aderito ✓' / 'Hai declinato'
- Banner Scadenza / 'Scaduto il' avviso
- Badge Tipo avviso (📢 presa visione / 📋 adesione)
- Indicatore Mittente e tempo pubblicazione
- Indicatore Classe/destinatario avviso
- Selettore/Indicatore Studente attivo (avatar + classe)
- Banner stato vuoto 'Nessun avviso'

### `/parent/chat` — Chat con Insegnante
_Modulo PRD: Comunicazione §2_

**Checklist controlli richiesti:**
- Pulsante 'Nuova Chat'
- Lista Thread insegnanti
- Campo Scrivi messaggio
- Pulsante 'Invia messaggio'
- Pulsante 'Allega file'
- Azione Invio nota vocale
- Indicatore Traduzione automatica messaggio
- Toggle Mostra originale/Traduzione
- Badge Messaggi non letti (contatore intestazione)
- Badge Non letti per thread
- Separatore 'Nuovi Messaggi'
- Indicatore Conferma di lettura (doppia spunta)
- Anteprima Allegato immagine
- Anteprima Allegato documento
- Banner Orario risposta docenti (fuori orario)
- Selettore Insegnante nel modal Nuova Chat
- Indicatore Insegnante e classe/sezione
- Pulsante 'Indietro' (vista mobile chat)
- Azione Rimuovi allegato dalla composizione

### `/parent/compiti` — Bacheca Compiti
_Modulo PRD: Primaria §3_

**Checklist controlli richiesti:**
- Lista 'Compiti' raggruppata per giorno
- Indicatore materia del compito
- Campo testo compiti assegnati
- Indicatore 'Consegna' (data scadenza compito)
- Indicatore 'Compiti' attività individualizzata (sostegno)
- Banner 'Nessun compito assegnato di recente'
- Azione 'Apri allegato' del compito (foto/scheda/PDF)
- Filtro per materia
- Filtro per data
- Banner 'Visibile anche se assente' (diritto al recupero)
- Indicatore 'Sezione disponibile solo per la primaria'
- Pulsante 'Vai al Diario'

### `/parent/diary` — Diario 0-6 (Timeline)
_Modulo PRD: Diario 0-6 §4_

**Checklist controlli richiesti:**
- Lista 'Timeline cronologica eventi della giornata'
- Indicatore 'Orario evento' su ogni card
- Card evento 'Entrata' (sola lettura)
- Card evento 'Attivita' (sola lettura)
- Card evento 'Merenda' (sola lettura)
- Card evento 'Pranzo' (sola lettura)
- Card evento 'Nanna' (sola lettura)
- Card evento 'Bagno/Igiene' (sola lettura)
- Indicatore 'Nota libera maestra' su card evento
- Pulsante 'Giorno precedente' (navigazione data)
- Pulsante 'Giorno successivo' (navigazione data, disabilitato su Oggi)
- Indicatore 'Etichetta giorno' (Oggi/Ieri/data)
- Sezione 'Le foto di oggi' (accordion collassabile)
- Lista 'Griglia foto taggate del giorno'
- Pulsante 'Scarica' foto
- Pulsante 'Condividi' foto
- Azione 'Apri foto a schermo intero' (lightbox)
- Pulsante 'Foto precedente/successiva' nel lightbox
- Badge 'Generale' su foto broadcast
- Banner 'Visibilita 14 giorni / contatta segreteria'
- Indicatore 'Chip nome bambino + sezione'
- Indicatore 'Stato vuoto - nessuna voce diario'
- Selettore 'Cambio bambino / avatar' (multi-figlio)
- Indicatore 'Traduzione multilingua delle routine'

### `/parent/forms/[id]` — Compilazione Form (Wizard)
_Modulo PRD: Form §4.2_

**Checklist controlli richiesti:**
- Indicatore barra di avanzamento wizard
- Indicatore 'Passo X di N'
- Indicatore titolo/descrizione pagina (step)
- Pulsante 'Indietro'
- Pulsante 'Avanti'
- Pulsante 'Invia' (ultimo step, senza firma)
- Pulsante 'Firma il modulo' (ultimo step, con firma)
- Indicatore stato 'Invio…' (caricamento submit)
- Campo testo/numero/email/telefono dinamico
- Campo data
- Campo area di testo (textarea)
- Selettore a tendina (select)
- Selettore a scelta singola (radio)
- Campo consenso a scelta multipla (checkbox)
- Pulsante 'Seleziona un file (PDF, JPG…)' upload allegato
- Indicatore caricamento allegato (spinner/'Caricamento…')
- Badge allegato caricato (icona FileCheck2 + nome file)
- Banner 'Allegato caricato' con percorso file
- Banner errore caricamento allegato
- Banner informativo firma OTP richiesta
- Indicatore campo obbligatorio (asterisco)
- Banner errore validazione campo
- Modale firma elettronica OTP/FEA
- Campo codice OTP a 6 cifre
- Indicatore 'Codice inviato a <email>'
- Pulsante 'Firma e completa' (verifica OTP)
- Pulsante 'Reinvia codice OTP'
- Pulsante chiudi modale firma (X)
- Banner errore verifica OTP
- Indicatore 'Modulo firmato!' (firma OTP riuscita)
- Indicatore 'Modulo inviato!' (conferma invio)
- Pulsante 'Torna ai moduli'
- Firma congiunta secondo firmatario (entrambi i genitori)
- Indicatore campo a visibilità/obbligatorietà condizionale

### `/parent/gallery` — Galleria Foto/Video
_Modulo PRD: Foto e Video §3_

**Checklist controlli richiesti:**
- Lista Feed media taggati del proprio figlio
- Pulsante 'Scarica' (download su card)
- Pulsante 'Scarica' (download in lightbox)
- Pulsante 'Condividi' (condivisione nativa su card)
- Pulsante 'Condividi' (condivisione nativa in lightbox)
- Azione Apri media a schermo intero (lightbox)
- Pulsante Navigazione 'Precedente' (lightbox)
- Pulsante Navigazione 'Successiva' (lightbox)
- Pulsante 'Chiudi' lightbox
- Icona Play video
- Pulsante 'Carica Altre Foto' (paginazione)
- Badge 'Generale' (media broadcast)
- Indicatore Conteggio foto disponibili
- Indicatore Caption + autore/uploader del media
- Banner 'Solo foto in cui tuo figlio è taggato'
- Indicatore Avatar/nome del proprio figlio (selezione profilo)
- Banner Stato vuoto 'Nessuna foto disponibile'

### `/parent/lezioni` — Orario Lezioni
_Modulo PRD: Primaria §2.2 / §6.4_

**Checklist controlli richiesti:**
- Indicatore griglia orario settimanale (matrice giorni x ore)
- Lista materie previste per il figlio
- Indicatore campanelle / fasce orarie (ora inizio-fine)
- Selettore giorno della settimana (Lun-Sab)
- Badge blocco 'Mensa'
- Badge blocco 'Intervallo'
- Indicatore docente per ora/materia
- Indicatore modello tempo scuola (27/29/40 ore)
- Lista lezioni recenti raggruppate per giorno
- Indicatore materia + argomento svolto per lezione
- Banner attività individualizzata (sostegno) per la lezione
- Icona allegato lezione (PDF / immagine) apribile
- Pulsante 'Aggiorna' (ricarica dati)
- Indicatore figlio selezionato (nome e cognome)
- Banner 'Sezione non disponibile' per non-primaria con link al Diario
- Banner stato vuoto 'Nessuna lezione registrata di recente'

### `/parent/locker` — Armadietto (Lista della Spesa)
_Modulo PRD: Armadietto §4_

**Checklist controlli richiesti:**
- Lista 'Situazione Materiale' (scorte residue per materiale)
- Indicatore semaforo scorte Verde/Giallo/Rosso
- Indicatore quantità residua numerica per materiale
- Lista 'Da portare a scuola' (materiali richiesti dall'insegnante)
- Badge contatore richieste pendenti
- Pulsante 'Preso in carico'
- Pulsante 'Lo porto domani' (acknowledgment alternativo)
- Indicatore stato 'Preso in carico' (richieste acknowledged)
- Banner notifica richiesta materiale (avviso immediato)
- Banner reminder automatico ore 07:00
- Selettore profilo figlio (isolamento multi-figlio)
- Indicatore nome figlio corrente
- Tab 'Panoramica'
- Tab 'Andamento Mensile'
- Pulsante mese precedente (andamento mensile)
- Pulsante mese successivo (andamento mensile)
- Toggle 'Storico richieste'
- Pulsante 'Aggiorna' (refresh manuale)
- Badge 'LIVE' (aggiornamento realtime)
- Indicatore 'Aggiornato alle' (ultimo refresh)
- Toast conferma salvataggio acknowledgment

### `/parent/mensa` — Menu & Mensa
_Modulo PRD: Mensa §3-§4_

**Checklist controlli richiesti:**
- Indicatore 'Saldo ticket' (pill verde con icona Ticket)
- Badge nome menu ciclico (es. 'Menu Primavera')
- Pulsante 'Aggiorna saldo' (refresh)
- Pulsante 'Settimana precedente' (chevron sinistra)
- Pulsante 'Settimana successiva' (chevron destra)
- Indicatore 'Intervallo settimana' (range date)
- Lista 'Calendario menu settimanale' (giorni con portate)
- Pulsante 'Prenota pranzo'
- Pulsante 'Disdici' (annulla prenotazione)
- Badge 'Prenotato' (giorno confermato, stile emerald)
- Icona 'Allerta allergeni del piatto' (semaforo rosso per pasto pericoloso al bambino)
- Badge 'Allergene presente' (etichetta allergene del giorno)
- Banner 'Reminder ticket in esaurimento / saldo esaurito'
- Indicatore 'Menu non ancora pubblicato'
- Indicatore 'Mensa chiusa' (giorno di chiusura/festività)
- Indicatore 'Inserito dalla segreteria' (origine prenotazione)
- Badge 'Prenotato' bloccato (giorno passato, icona Lock)
- Banner 'Sessione non valida' (errore auth)

### `/parent/modulistica` — Modulistica & Certificati
_Modulo PRD: Form + Presenze §3_

**Checklist controlli richiesti:**
- Tab 'Da Compilare'
- Tab 'Archivio Firmati'
- Tab 'Certificati Self-Service'
- Tab 'Certificati Medici'
- Lista moduli da compilare
- Badge 'Autorizzazione'
- Badge 'Sondaggio'
- Badge 'Gradimento'
- Badge figlio destinatario modulo
- Badge scadenza modulo 'Scade il'
- Pulsante 'Compila' (sondaggio/gradimento)
- Pulsante 'Compila e Firma' (autorizzazione)
- Campo dinamico testo/data/textarea
- Selettore radio risposta a opzioni
- Campo checkbox consenso GDPR
- Selettore rating 1-5
- Indicatore campo obbligatorio asterisco
- Banner FES 'Firma Elettronica Semplice'
- Indicatore 'Verifica via email'
- Pulsante 'Invia Risposte' (invio diretto)
- Pulsante 'Invia e Firma Ricevuta' (autorizzazione)
- Pulsante 'Annulla' compilazione
- Campo OTP a 6 cifre (modale firma)
- Pulsante 'Firma e completa' (modale OTP)
- Banner conferma 'Modulo firmato!'
- Lista archivio moduli firmati
- Badge 'Ricevuta FES Protetta'
- Pulsante 'Ricevuta PDF' (download)
- Pulsante 'Scarica PDF' Certificato Frequenza
- Pulsante 'Scarica PDF' Certificato Iscrizione
- Selettore 'Seleziona Figlio' (certificato medico)
- Pulsante 'Carica Certificato' (upload file)
- Campo 'Note di accompagnamento'
- Pulsante 'Invia Certificato Medico'
- Lista 'Ricevute Caricamenti Medici Recenti'
- Badge 'Giustificato' giorni coperti
- Badge 'In attesa di abbinamento assenza'
- Banner 'Non hai moduli da compilare'
- Wizard step-by-step (una sezione per persona)
- Indicatore firma congiunta entrambi i genitori
- Banner scadenza bloccante modulo

### `/parent/pagamenti` — Pagamenti & Fatture
_Modulo PRD: Pagamenti §4 + Aruba §5_

**Checklist controlli richiesti:**
- Lista pagamenti da pagare
- Lista storico pagamenti effettuati
- Indicatore importo voce (€)
- Indicatore importo residuo (resta €)
- Badge stato 'Pagato'
- Badge stato 'Scaduto' in rosso
- Badge stato 'Da pagare'
- Badge stato 'Parziale'
- Indicatore voce obbligatoria (•obbl.)
- Indicatore quota split 'tua quota'
- Icona download fattura PDF su voce saldata
- Indicatore fattura non disponibile su voce pagata
- Toggle 'Attiva promemoria pagamenti' (push opt-in)
- Badge 'Promemoria attivi'
- Indicatore alunno (nome/cognome) per voce
- Indicatore data scadenza voce
- Icona categoria voce (Rette/Mensa/Gite...)
- Filtro/Tab categorie (Rette/Quote/Mensa/Gite)
- Indicatore totale da pagare (riepilogo home)

### `/parent/primaria` — Hub Primaria Genitore
_Modulo PRD: Primaria (navigazione)_

**Checklist controlli richiesti:**
- Pulsante 'Lezioni' (Argomenti e compiti)
- Pulsante 'Valutazioni' (Giudizi e medie per materia)
- Pulsante 'Note' (Note disciplinari e didattiche)
- Pulsante 'Presenze' (Assenze, ritardi e giustifiche)
- Pulsante 'Pagelle' (Scarica e firma le pagelle)
- Pulsante 'Orario' (Orario settimanale e materie del figlio)
- Pulsante 'Compiti' (bacheca compiti dedicata)
- Indicatore 'Scuola Primaria' (titolo sezione con icona)
- Selettore figlio (per famiglie con più alunni primaria)

### `/parent/primaria/note` — Note Disciplinari (Presa Visione)
_Modulo PRD: Primaria §5_

**Checklist controlli richiesti:**
- Lista note del figlio
- Badge categoria 'Disciplinare' (rosso)
- Badge categoria 'Didattica' (blu)
- Badge categoria 'Compiti non svolti' (giallo/ambra)
- Pulsante 'Firma presa visione'
- Badge 'Firmata'
- Indicatore 'In attesa di firma'
- Banner 'N nota in attesa di firma'
- Campo testo della nota
- Indicatore data nota
- Indicatore stato firma in corso 'Firma…'
- Banner certificazione FES (IP/timestamp) presa visione
- Azione download ricevuta PDF della firma

### `/parent/primaria/pagelle` — Pagelle / Documento di Valutazione
_Modulo PRD: Primaria §9 + Fascicolo_

**Checklist controlli richiesti:**
- Lista pagelle per periodo (Intermedio/Finale)
- Campo 'Periodo' (es. Intermedio/Finale)
- Campo 'A.S. anno scolastico'
- Pulsante 'PDF' (download documento di valutazione)
- Lista giudizi sintetici per disciplina
- Indicatore giudizio sintetico Educazione Civica
- Indicatore 'Comportamento' (giudizio sintetico)
- Indicatore 'Giudizio globale'
- Toggle 'Dettaglio/Nascondi' giudizi
- Pulsante 'Firma' (avvia firma pagella OTP)
- Campo 'Codice OTP' (firma via email)
- Pulsante 'Conferma' (firma OTP)
- Pulsante 'Annulla' (firma OTP)
- Badge 'Firmata' (presa visione pagella)
- Banner esito firma (successo/errore)
- Indicatore 'Dev OTP code' (ambiente sviluppo)
- Banner 'Nessuna pagella disponibile' (stato vuoto)
- Lista pagelle anni precedenti (storico)
- ✅ Pulsante 'Scarica certificato delle competenze' _(P5/DL-047, card pagelle genitore + `/api/parent/competenze`)_
- Filtro 'Anno scolastico'

### `/parent/primaria/valutazioni` — Valutazioni / Andamento
_Modulo PRD: Primaria §4.5_

**Checklist controlli richiesti:**
- Lista Materie (prospetto valutazioni in itinere per disciplina)
- Azione 'Espandi/Comprimi materia' (accordion card materia)
- Filtro per materia
- Badge 'Giudizio sintetico' (es. Ottimo/Buono/Sufficiente)
- Campo 'Giudizio descrittivo' (testo della valutazione)
- Indicatore 'Tipo prova' (orale/scritto/pratica)
- Campo 'Argomento' della valutazione
- Indicatore 'Data valutazione'
- Indicatore 'Conteggio valutazioni per materia'
- Indicatore 'Media per materia'
- Banner 'Buffer visibilità 10 minuti' (ritardo pubblicazione valutazione)
- Banner 'Persistenza dati anche con account sospeso'
- Indicatore 'Stato vuoto' (Nessuna valutazione disponibile)

### `/parent/register` — Registro (vista Genitore) — ⛔ DEPRECATA
_Modulo PRD: Primaria (vista genitore)_

> [!WARNING]
> **Pagina DEPRECATA.** Sostituita dalle pagine genitore dedicate e conformi O.M. 3/2025:
> `/parent/primaria` (hub), `/parent/primaria/valutazioni`, `/parent/primaria/note`, `/parent/primaria/pagelle`, `/parent/primaria/assenze`, `/parent/compiti`, `/parent/lezioni`.
> La rotta legacy va **reindirizzata** a queste pagine (Blocco 3). I controlli sotto restano come snapshot storico; il target è distribuito nelle pagine canoniche elencate.

**Checklist controlli (legacy — snapshot storico, NON target):**
- Lista 'Valutazioni' (giudizi per materia)
- Indicatore giudizio sintetico/descrittivo per valutazione
- Indicatore materia/tipo prova per valutazione
- Indicatore argomento collegato alla valutazione
- Lista 'Compiti' (bacheca compiti per il genitore/alunno)
- Indicatore allegati multimediali dei compiti/argomenti
- Banner 'Recupero assenti' (compiti/argomenti visibili anche se assente)
- Lista 'Orario settimanale' (materie del figlio)
- Indicatore 'Andamento scolastico' (riepilogo andamento)
- Banner 'Note da firmare' (note in attesa di presa visione)
- Pulsante 'Firma' (presa visione nota disciplinare)
- Badge categoria nota (Disciplinare/Didattica/Compiti non svolti)
- Lista 'Pagelle' (documento di valutazione per periodo)
- Pulsante 'Firma e visualizza' (firma ricezione pagella)
- Campo 'Codice' OTP firma pagella
- Pulsante 'Conferma' codice firma pagella
- Pulsante 'Vedi a schermo' (giudizi pagella dopo firma)
- Pulsante 'Scarica PDF' pagella
- Lista 'Assenze da giustificare'
- Indicatore stato assenza (Assenza/Ritardo/Uscita anticipata)
- Badge 'presa visione / in attesa / da giustificare'
- Pulsante 'Giustifica' (avvia giustifica assenza)
- Campo 'Motivazione' giustifica assenza
- Campo 'Codice' OTP/PIN giustifica assenza
- Pulsante 'Conferma' codice giustifica
- Pulsante 'Comunica assenza in anticipo'
- Campo 'Data' assenza in anticipo
- Campo 'Motivo' assenza in anticipo
- Pulsante 'Invia' assenza in anticipo
- Campo upload certificato medico (riammissione)
- Pulsante 'Dichiara impreparato (a priori)'
- Selettore 'Materia' dichiarazione impreparato
- Campo 'Data' dichiarazione impreparato
- Campo 'Motivo' dichiarazione impreparato
- Pulsante 'Invia dichiarazione' impreparato
- Banner 'Diario 0-6' (redirect se figlio non in primaria)
- Indicatore 'Persistenza dati con account sospeso'

## Insegnante

### `/teacher` — Home / Dashboard Docente
_Modulo PRD: Diario §3.2 + Trasversale_

**Checklist controlli richiesti:**
- Banner Allergie del giorno
- Lista Allergie/intolleranze del giorno (nome alunno in rosso + badge)
- Indicatore Stato compilazione diario (classi compilate/inattive)
- Badge ✅ Diario del giorno completato
- Lista Accessi rapidi alle classi/sezioni
- Azione 'Registro di Classe' (accesso rapido modulo)
- Azione 'Presenze · Appello' (accesso rapido modulo)
- Azione 'Diario del Giorno' (accesso rapido modulo)
- Azione 'Galleria' (accesso rapido modulo)
- Azione 'Avvisi' (comunicazione)
- Azione 'Chat famiglie' (comunicazione)
- Azione 'Modulistica' (comunicazione)
- Azione 'Attività' (task/bacheca interna)
- Azione 'Armadietto' (gestione materiale)
- Selettore Mondo Infanzia/Nido ↔ Primaria (GradeWorldSwitch)
- Badge Grado abilitato (Infanzia / Nido / Primaria)
- Indicatore Data odierna
- Pulsante 'Vai alla Primaria' (fallback docente solo-primaria)
- Indicatore stato 'Nessuna funzione abilitata' (gating matrice)
- Bottom navigation docente

### `/teacher/attendance` — Appello Presenze (Nido/Infanzia)
_Modulo PRD: Presenze §2_

**Checklist controlli richiesti:**
- Tab 'Oggi'
- Tab 'Mese'
- Indicatore 'Presenti X/N'
- Indicatore 'Offline'
- Indicatore stato sync / sincronizzazione automatica
- Lista alunni della propria classe (empty state)
- Pulsante 'Presente' (per alunno)
- Pulsante 'Ritardo' (per alunno)
- Pulsante 'Assente' (per alunno)
- Badge stato alunno (Presente/Ritardo/Uscita Ant./Assente)
- Campo 'Orario Check-in' modificabile
- Indicatore 'Ingresso HH:MM' (orario check-in)
- Indicatore 'Uscita HH:MM' (orario check-out)
- Pulsante 'Uscita Ant.' (uscita anticipata rapida)
- Pulsante 'Uscita' (apri scheda delegati)
- Pulsante 'Reset / Cambia stato' (per alunno)
- Indicatore di caricamento riga alunno
- Lista 'Delegati Autorizzati' (sola lettura)
- Indicatore foto documento delegato
- Campo nome/relazione delegato
- Pulsante 'Conferma' uscita con delegato
- Pulsante 'Panic Alert - Ritiro Non Autorizzato'
- Banner 'Blocca uscita e notifica Segreteria + Genitore'
- Pulsante 'Chiudi' scheda delegati
- Selettore data (navigatore giorno)
- Pulsante 'Oggi' (torna a oggi)
- Pulsante 'Aggiorna presenze' (refresh)
- Indicatore legenda stati (Presente/Ritardo/Uscita Ant./Assente)
- Selettore mese (Mese precedente/successivo)
- Pulsante 'Esporta PDF' registro mensile
- Indicatore riepilogo P/A/R/U/ORE per alunno

### `/teacher/avvisi` — Bacheca Avvisi Docente
_Modulo PRD: Comunicazione §3_

**Checklist controlli richiesti:**
- Pulsante 'Nuovo' (crea avviso)
- Campo 'Titolo' avviso
- Campo 'Contenuto' avviso
- Selettore Tipo 'Presa visione'
- Selettore Tipo 'Adesione'
- Selettore Destinatari 'Per classe'
- Selettore Destinatari 'Tutti' (globale)
- Selettore classi target (chip multi-selezione)
- Campo 'Scadenza' avviso/adesione (data)
- Pulsante 'Carica File (PDF, Immagini)'
- Campo 'Link Esterno'
- Azione 'Rimuovi file allegato'
- Pulsante 'Pubblica Avviso'
- Pulsante 'Salva Modifiche' (avviso esistente)
- Lista avvisi pubblicati
- Azione 'Espandi avviso' (chevron card)
- Indicatore destinatari su card (classi/globale)
- Badge tipo avviso (Presa visione / Adesione)
- Indicatore 'X hanno letto' (read receipt)
- Indicatore conteggio adesioni 'Si'
- Indicatore conteggio adesioni 'No'
- Banner scadenza/scaduto su card
- Icona allegato 'Allegato File'
- Icona 'Link Esterno'
- Pulsante 'Dettaglio' (apre cruscotto monitoraggio)
- Pulsante 'Modifica' avviso
- Pulsante 'Elimina' avviso
- Tab 'Stato Lettura' (cruscotto)
- Tab 'Adesioni' (cruscotto)
- Indicatore 'Letti' su totale + percentuale
- Indicatore 'Non letti'
- Indicatore adesioni 'Si / No / Attesa'
- Filtro 'Classe' (cruscotto)
- Filtro 'Risposta' (Si/No/Attesa/Date)
- Campo ricerca 'Cerca alunno o genitore'
- Pulsante 'Azzera' filtri
- Sub-tab 'Letti' / 'Non letti'
- Lista alunni/genitori con stato lettura
- Lista risposte adesione per alunno (Si/No/Attesa)

### `/teacher/chat` — Chat Docente
_Modulo PRD: Comunicazione §2_

**Checklist controlli richiesti:**
- Pulsante 'Nuova Chat'
- Modal 'Nuova Chat' (selezione genitore)
- Lista contatti genitori della propria classe
- Lista conversazioni (thread 1-a-1)
- Indicatore associazione genitore-alunno nel thread
- Badge contatore messaggi non letti (per thread)
- Indicatore puntino non letto sull'avatar
- Badge contatore globale non letti (header)
- Campo 'Scrivi un messaggio'
- Pulsante 'Invia messaggio'
- Pulsante 'Allega file'
- Azione invio allegato foto/immagine
- Azione invio allegato documento/PDF
- Pulsante 'Nota vocale'
- Toggle 'Traduzione automatica'
- Indicatore messaggio tradotto
- Azione 'Mostra originale / traduzione'
- Indicatore stato lettura messaggio (spunte)
- Separatore 'Nuovi Messaggi'
- Indicatore data messaggi (Oggi/Ieri)
- Indicatore orario messaggio
- Banner chat sempre attiva (H24 / emergenze)

### `/teacher/diary` — Diario 0-6 Data-Entry
_Modulo PRD: Diario 0-6 §3_

**Checklist controlli richiesti:**
- Pulsante evento 'Entrata'
- Pulsante evento 'Attività'
- Pulsante evento 'Merenda'
- Pulsante evento 'Pranzo'
- Pulsante evento 'Nanna'
- Pulsante evento 'Sveglia'
- Pulsante evento 'Bagno'
- Pulsante 'Salva per tutti'
- Campo orario 'Entrata' per bambino
- Selettore livello partecipazione 'Non fatta'
- Selettore livello partecipazione 'Con difficoltà'
- Selettore livello partecipazione 'Con aiuto'
- Selettore livello partecipazione 'In autonomia'
- Selettore tipo attività
- Campo 'Descrizione attività'
- Pulsante 'Aggiungi attività'
- Pulsante 'Rimuovi attività'
- Selettore quantità pasto '✗ Niente'
- Selettore quantità pasto '¼ Poco'
- Selettore quantità pasto '½ Metà'
- Selettore quantità pasto '¾ Quasi tutto'
- Selettore quantità pasto '★ Tutto'
- Indicatore quantità 'Bis'
- Lista portate pranzo (Primo/Secondo/Contorno/Frutta)
- Banner 'Menu del giorno'
- Campo orario 'Si addormenta' (inizio nanna)
- Campo orario 'Si sveglia' (fine nanna)
- Contatore +/- 'Pipì'
- Contatore +/- 'Cacca'
- Contatore 'Vasino' (potty training)
- Campo 'Note libere' per evento
- Banner allergie
- Indicatore allergia nome in rosso
- Filtro presenze (solo bambini presenti)
- Badge ✅ alunno salvato
- Toast 'Salvato con successo'
- Indicatore 'Offline'
- Pulsante 'Chiudi' pannello evento (X)
- Indicatore conteggio compilati per attività
- Azione 'Bulk / Nanna per tutti' (selezione multipla alunni)
- Pulsante 'Indietro' (Step 1 da Step 2)

### `/teacher/gallery` — Galleria Upload & Tagging
_Modulo PRD: Foto e Video §2_

**Checklist controlli richiesti:**
- Pulsante 'Carica' (apre step upload)
- Pulsante 'Annulla' (esce dal flusso upload/tag)
- Selettore 'Sezione'
- Azione 'Selezione multipla / Bulk Upload' (drag&drop o file picker multiplo)
- Azione 'Trascina foto o video' (drop zone)
- Lista 'Anteprime file selezionati' (griglia preview pre-tag)
- Icona 'Rimuovi file' (X su anteprima)
- Pulsante 'Carica N file' (conferma selezione, va al tagging)
- Lista 'Miniature caricamento multiplo' (selettore foto attiva per tag)
- Badge 'Conteggio tag' (numero alunni taggati sulla miniatura)
- Badge '!' (foto senza tag, non pubblicabile)
- Badge 'G' Generale (miniatura broadcast)
- Indicatore 'Foto X di N'
- Pulsante 'Applica a tutte' (propaga tag/config a tutte le foto)
- Campo 'Cerca alunno o genitore'
- Lista 'Alunni della classe (completa, non filtrata per presenze)'
- Azione 'Tagga alunno' (toggle selezione nella foto)
- Indicatore 'Privacy Lock' (alunno senza liberatoria disabilitato)
- Icona 'EyeOff' (alunno senza liberatoria)
- Badge 'Solo genitori' (alunno senza liberatoria)
- Icona 'Check' (alunno taggato/selezionato)
- Pulsante 'Seleziona tutti' / 'Deseleziona tutti'
- Banner 'Foto Privata' (selezionato alunno senza liberatoria)
- Banner 'Info liberatoria/Privacy Lock'
- Pulsante 'Pubblica N file' (conferma upload con watermark)
- Indicatore 'Watermark automatico' (logo applicato in upload)
- Lista 'Feed cronologico unico' (griglia media sezione)
- Indicatore 'Tempo fa' (timestamp relativo media)
- Badge 'Generale' (media broadcast nel feed)
- Azione 'Apri lightbox media'
- Icona 'Naviga precedente/successivo' (frecce lightbox)
- Lista 'Bambini taggati nella foto' (riepilogo lightbox)
- Pulsante 'Modifica Tag' (ri-tagging media già pubblicato)
- Pulsante 'Salva' tag modificati
- Pulsante 'Elimina Media' (cancellazione dal feed)
- Toggle 'Caricamento in Broadcast' (invia a tutta la classe)
- Banner 'Offline' (upload salvato in locale)
- Pulsante 'Scarica' media (download)
- Pulsante 'Condividi' media nativo

### `/teacher/locker` — Armadietto Docente
_Modulo PRD: Armadietto §3_

**Checklist controlli richiesti:**
- Tab 'Carico Genitore'
- Tab 'Consumo'
- Tab 'Mensile'
- Pulsante 'Registra Carico Odierno'
- Pulsante 'Aggiungi carico per <alunno>'
- Selettore 'Alunno' (modale carico)
- Selettore 'Materiale' (modale carico)
- Campo 'Materiale custom (testo libero)'
- Campo 'Quantità' (stepper +/-)
- Campo 'Marca/Taglia' (dettagli carico)
- Pulsante 'Conferma Carico'
- Indicatore 'Stock Totale Attuale'
- Indicatore Semaforo scorte Verde/Giallo(<5)/Rosso(<2)
- Badge 'ESAURITO'
- Badge consegne odierne '✓ N'
- Badge '✅ Consegnato oggi'
- Pulsante riga materiale 'Registra consumo'
- Campo 'Quantità usata' (stepper consumo)
- Pulsante 'Conferma' (consumo)
- Pulsante 'Annulla' (form consumo)
- Azione 'Richiesta materiale al genitore'
- Azione 'Selezione massiva alunni (Bulk)'
- Pulsante 'Invia richiesta collettiva'
- Selettore 'Materiale richiesta' (anche custom)
- Azione 'Chiudi/Risolvi ciclo richiesta (ricezione)'
- Indicatore stato richiesta 'Preso in carico dal genitore'
- Banner 'Supporto offline (salvato in cache / sincronizza)'
- Indicatore 'Richiesta indipendente dalle presenze'
- Indicatore 'Scalo automatico pannolino da eventi Bagno (solo bambini con flag Usa pannolino)'
- Filtro materiale (vista Mensile)
- Pulsante 'Mese precedente'
- Pulsante 'Mese successivo'
- Icona 'Portato' / 'Non portato' (griglia mensile)
- Pulsante 'Aggiorna' (refresh)
- Icona/Link 'Impostazioni materiali'

### `/teacher/settings/locker` — Config Armadietto (Catalogo)
_Modulo PRD: Armadietto §2 / Impostazioni §4_

**Checklist controlli richiesti:**
- Pulsante 'Indietro' (torna ad Armadietto)
- Filtro Classe/Sezione (tab Girasoli/Coccinelle/Tulipani/Margherite)
- Lista materiali del catalogo per classe
- Pulsante 'Aggiungi Materiale per <classe>'
- Pulsante 'Elimina' materiale (Trash)
- Toggle 'Attivo/Disattiva' materiale
- Campo 'Nome materiale'
- Selettore 'Icona materiale'
- Campo 'Unita di misura'
- Campo 'Soglia Allerta (Giallo)'
- Campo 'Soglia Urgente/Esaurito (Rosso)'
- Indicatore semaforo soglie sulla card (Giallo Allerta / Rosso Urgente)
- Azione 'Riordina materiale' (frecce su/giu)
- Pulsante 'Salva Materiale'
- Pulsante 'Annulla' (form nuovo materiale)
- Banner informativo 'Come funziona' (semafori e visibilita)
- Indicatore stato vuoto 'Nessun materiale configurato'
- Indicatore salvataggio in corso (spinner per riga)
- Campo 'Richiesta materiale custom (testo libero)'
- Selettore default catalogo sede (Pannolini/Asciugamani/Creme/Cambi)
- Toggle abilitazione widget Armadietto per classe/grado

### `/teacher/modulistica` — Modulistica Docente (Cruscotto)
_Modulo PRD: Form §4 (cruscotto insegnante)_

**Checklist controlli richiesti:**
- Tab 'Semaforo Consensi'
- Tab 'Certificati Medici'
- Selettore 'Modulo di Autorizzazione'
- Indicatore 'Stato approvazioni classe' (semaforo verde/rosso)
- Badge 'N Firmati' (conteggio verdi)
- Badge 'N Mancanti' (conteggio rossi)
- Lista alunni con stato firma
- Badge 'FES OK' (consenso firmato)
- Pulsante 'Invia Sollecito' (campana)
- Pulsante 'Proxy' (upload cartaceo)
- Banner 'Proxy Upload Cartaceo' (modale)
- Campo 'Carica File' (modale proxy)
- Pulsante 'Registra Firma' (conferma proxy)
- Pulsante 'Annulla' (modale proxy)
- Pulsante 'Gestisci Giorni' (certificato medico)
- Badge 'Certificato Medico'
- Badge giorni coperti (date)
- Indicatore 'Da registrare giorni coperti'
- Campo 'Aggiungi Giorno' (data)
- Pulsante 'Aggiungi' giorno coperto
- Lista 'Giorni di Copertura Inseriti'
- Pulsante 'Salva Copertura'
- Pulsante 'Esporta PDF consensi classe'
- Indicatore semaforo Giallo (firma congiunta parziale)
- Indicatore 'Scadenza modulo' (deadline bloccante)

### `/teacher/register` — Registro Primaria (legacy) — ⛔ DEPRECATA
_Modulo PRD: Primaria §4_

> [!WARNING]
> **Pagina DEPRECATA.** Sostituita dalle pagine conformi O.M. 3/2025 basate sui **giudizi sintetici**:
> `/teacher/primaria/[sectionId]/registro` (firma lezione + argomenti/compiti), `/teacher/primaria/[sectionId]/valutazioni` (valutazione in itinere per obiettivi/dimensioni/giudizi), `/teacher/primaria/[sectionId]/prospetto`, `/teacher/primaria/[sectionId]/note`, `/teacher/primaria/[sectionId]/scrutinio`.
> La rotta legacy va **reindirizzata** a queste pagine (Blocco 3). Sono **SUPERATI** (non target) solo i controlli a **voti numerici visibili (1-10)** e alla scala **Base/Intermedio/Avanzato**, sostituiti dai **giudizi sintetici Allegato A**. Le pagine canoniche mantengono invece le **categorie Scritto/Orale/Pratico** e la **media** (calcolata sull'associazione numerica nascosta dei giudizi).

**Checklist controlli (legacy — snapshot storico, NON target):**
- Tab 'Lezioni'
- Tab 'Valutazioni'
- Tab 'Note'
- Indicatore 'Classe 3A Primaria'
- Lista ore di lezione (1ª-8ª ora)
- Pulsante 'Firma' (per ora)
- Selettore Materia (firma lezione)
- Campo 'Argomento svolto in classe'
- Campo 'Compiti per casa'
- Campo 'Data di consegna compiti'
- Pulsante 'Salva e Firma'
- Pulsante 'Modifica' (lezione firmata)
- Pulsante 'Allegato' (media lezione)
- Indicatore 'Firmato' (ora firmata)
- Azione Cofirma compresenza
- Selettore tipologia compresenza
- Azione Firma indipendente per alunni specifici (oscuramento)
- Indicatore stato presenza alunno (Presente/Assente/Ritardo/Uscita Anticipata)
- Pulsante 'Aggiungi Voto'
- Selettore Alunno (valutazione)
- Selettore Materia (valutazione)
- Selettore Tipo prova (Scritto/Orale/Pratico)
- Toggle modalità voto Numerico vs Giudizio
- Campo Voto numerico (1-10)
- Selettore Giudizio (Base/Intermedio/Avanzato)
- Selettore Obiettivo di apprendimento
- Toggle dimensione 'Autonomia' (Sì/No)
- Toggle dimensione 'Continuità' (Sì/No)
- Selettore dimensione 'Tipologia situazione' (Nota/Non nota)
- Selettore dimensione 'Risorse mobilitate' (Interne/Esterne/Entrambe)
- Campo Giudizio descrittivo auto-generato (modificabile)
- Selettore Giudizio sintetico in itinere (es. Buono/Sufficiente)
- Selettore Giudizio sintetico scrutinio (Ottimo/Distinto/Buono/Discreto/Sufficiente/Non sufficiente)
- Pulsante 'Salva Voto'
- Lista valutazioni inserite (tabella)
- Badge voto/giudizio colorato in tabella
- Banner 'Buffer Notifica 10 minuti'
- Badge 'Voto salvato!' (conferma)
- Lista selezione alunni (note)
- Pulsante 'Seleziona Tutti'/'Deseleziona Tutti'
- Selettore Categoria nota (Disciplinare/Didattica/Compiti non svolti)
- Campo 'Testo della nota'
- Toggle 'Richiedi Firma per Presa Visione'
- Pulsante 'Assegna Nota (n)'
- Lista 'Note Recenti' (storico)
- Badge stato firma nota ('Firmata'/'In attesa')
- Banner blocco modifiche oltre vincolo temporale

### `/teacher/tasks` — Task Staff
_Modulo PRD: Comunicazione §4_

**Checklist controlli richiesti:**
- Tab 'Assegnati a me'
- Tab 'Creati da me'
- Tab 'Archivio'
- Tab 'Da Controllare'
- Tab 'Tutti i Task'
- Pulsante 'Prendo in carico'
- Pulsante 'Risolvi Task'
- Pulsante 'Conferma Risolto'
- Campo 'Note di Risoluzione'
- Pulsante 'Scegli file' allegati risoluzione
- Pulsante 'Completa Compito'
- Pulsante 'Chiarimenti'
- Pulsante 'Invia' chiarimento
- Pulsante 'Vedi dettagli' / 'Nascondi dettagli'
- Pulsante 'Nuovo'
- Badge contatore task in sospeso
- Badge priorita' (Bassa/Media/Alta/Urgente)
- Badge stato 'Da Fare' / 'In Corso' / 'Da Controllare' / 'Completato'
- Badge categoria task
- Badge destinatario (singolo/classe/ruolo/globale)
- Badge 'In Attesa di Approvazione'
- Badge 'Aggiornato'
- Indicatore deadline / 'SCADUTO'
- Indicatore progresso 'Compiti Approvati'
- Badge allergie alunno collegato
- Lista allegati con anteprima/download
- Banner 'Revisione Richiesta'
- Indicatore lucchetto compito non proprio
- Pulsante 'Elimina task'
- Pulsante 'Modifica task'
- Pulsante 'Approva Task' / 'Approva Compito'
- Pulsante 'Richiedi Modifica' (revisione)
- Indicatore ruolo utente (Direzione/Coordinatore/Insegnante)
- Notifica browser nuovo task / compito risolto / revisione

### `/teacher/primaria` — Hub Sezioni Primaria
_Modulo PRD: Primaria (navigazione)_

**Checklist controlli richiesti:**
- Lista 'Le mie classi' (classi/sezioni in carico)
- Azione 'Seleziona classe' (card classe verso registro)
- Indicatore numero alunni della classe
- Indicatore anno scolastico della classe
- Icona ChevronRight (apertura classe)
- Selettore 'Mondo' Infanzia/Primaria (GradeWorldSwitch)
- Banner 'Nessuna classe primaria assegnata'
- Banner errore caricamento classi
- Indicatore di caricamento 'Caricamento…'

### `/teacher/primaria/[sectionId]` — Dashboard Sezione
_Modulo PRD: Primaria (sezione)_

**Checklist controlli richiesti:**
- Tab 'Registro'
- Tab 'Appello'
- Tab 'Valutazioni'
- Tab 'Note'
- Tab 'Orario'
- Tab 'Prospetto'
- Tab 'Scrutinio'
- Tab 'Fascicolo'
- Icona 'Indietro' (torna a Le mie classi)
- Indicatore 'Nome classe' (titolo sezione)
- Badge 'Primaria' (grado)
- Badge 'Modalità segreteria'
- Lista 'Alunni' della sezione con contatore
- Lista 'Le mie materie' (chip discipline assegnate)
- Banner 'Empty state alunni' (Nessun alunno)
- Banner 'Empty state materie' (Nessuna materia assegnata)
- Indicatore 'Hint navigazione schede' (usa le schede in alto)
- Indicatore 'Riepilogo presenze del giorno'
- Indicatore 'Allergie alunno' (nome in rosso + badge)

### `/teacher/primaria/[sectionId]/appello` — Appello Orario Primaria
_Modulo PRD: Primaria §2.1_

**Checklist controlli richiesti:**
- Pulsante 'Presente' (per alunno)
- Pulsante 'Assente' (per alunno)
- Pulsante 'Ritardo' (per alunno)
- Pulsante 'Uscita' (uscita anticipata, per alunno)
- Campo 'Entrata' (orario ritardo)
- Campo 'Uscita' (orario uscita anticipata)
- Pulsante 'Tutti presenti'
- Campo 'Data appello' (selettore data)
- Pulsante 'Giustificata · presa visione' (giustifica genitore)
- Badge 'giustif. vista'
- Selettore 'Alunno' (riepilogo ore assenze)
- Campo 'Dal' (periodo riepilogo)
- Campo 'Al' (periodo riepilogo)
- Indicatore 'Ore assenze' (totale)
- Indicatore 'Ore ritardi'
- Indicatore 'Ore permessi'
- Indicatore 'Totale ore' mancate
- Lista 'Ore mancate per materia'
- Indicatore sync offline appello
- Azione 'Firma docente (tap sull'ora di lezione)'
- Indicatore 'Compresenza' (firme docenti indipendenti)
- Selettore 'Tipologia compresenza' (cofirma)
- Campo 'Argomento svolto' (contestuale alla firma)
- Campo 'Compiti assegnati' (contestuale alla firma)
- Selettore 'Ora/Campanella' (griglia oraria)
- Indicatore 'Sync con presenze generali'

### `/teacher/primaria/[sectionId]/registro` — Registro di Classe / Firma Lezione
_Modulo PRD: Primaria §3 + §7_

**Checklist controlli richiesti:**
- Selettore data registro
- Lista campanelle (ore di lezione)
- Indicatore ora e fascia oraria
- Indicatore materia della lezione
- Pulsante 'Firma' lezione (tap sulla campanella)
- Pulsante 'Modifica' lezione firmata
- Badge ✅ firma apposta
- Campo 'Argomento svolto'
- Campo 'Compiti'
- Indicatore argomento lezione (riga)
- Badge 'Compiti' (riga)
- Azione 'Allega' file multimediale
- Lista allegati lezione
- Icona tipo allegato (PDF/Immagine)
- Selettore 'Tipo firma' (compresenza)
- Azione 'Cofirma' su argomento del docente ordinario
- Indicatore firme docenti sulla riga
- Selettore destinatari alunni (firma indipendente sostegno)
- Campo 'Argomento (per i destinatari)'
- Campo 'Compiti (per i destinatari)'
- Indicatore 'attività individualizzata' (riga)
- Banner privacy attività individualizzata
- Selettore 'Classe' (firma supplenza in altra sezione)
- Banner 'supplenza' altra classe
- Indicatore stato offline / coda di sincronizzazione
- Pulsante 'Annulla' modale firma
- Pulsante 'Firma' (conferma modale)
- Banner vincolo temporale / blocco immodificabilità
- Indicatore alunni 'Assenti' (recupero compiti)

### `/teacher/primaria/[sectionId]/valutazioni` — Valutazioni in Itinere
_Modulo PRD: Primaria §4.1-§4.2_

**Checklist controlli richiesti:**
- Selettore 'Alunno'
- Selettore 'Materia'
- Selettore 'Obiettivo di apprendimento'
- Pulsante 'Associa obiettivi alla disciplina'
- Selettore 'Tipo prova' (Orale/Scritto/Pratico)
- Tab 'Per dimensioni'
- Tab 'Giudizio sintetico'
- Toggle 'Autonomia' (Sì/No)
- Toggle 'Continuità' (Sì/No)
- Toggle 'Tipologia della situazione' (Nota/Non nota)
- Toggle 'Risorse mobilitate' (Interne/Esterne/Entrambe)
- Campo 'Giudizio descrittivo' (auto-generato, editabile)
- Selettore 'Giudizio sintetico in itinere'
- Campo 'Argomento' (obbligatorio)
- Pulsante 'Salva valutazione'
- Banner 'Buffer di sicurezza 10 minuti'
- Lista 'Valutazioni recenti'
- Indicatore 'Modalità valutazione' (Per dimensioni / sintetico) sulla valutazione recente
- Banner 'Voti numerici disabilitati alla primaria'
- Messaggio 'Valutazione salvata'
- Pulsante 'Segna impreparato (alunno selezionato)'
- Lista 'Impreparati giustificati — oggi'
- Badge origine impreparato (dal genitore / dal docente)

### `/teacher/primaria/[sectionId]/prospetto` — Prospetto Valutazioni
_Modulo PRD: Primaria §4.4_

**Checklist controlli richiesti:**
- Selettore 'Alunno'
- Selettore 'Materia'
- Filtro 'Tutte le materie' (panoramica)
- Lista panoramica medie per materia
- Indicatore 'Media' per materia (panoramica, da associazione numerica nascosta dei giudizi)
- Indicatore 'Valutazioni' (conteggio) per materia
- Azione 'Apri dettaglio per obiettivo' (riga panoramica)
- Indicatore 'Media matematica (giudizi sintetici)' per materia
- Lista valutazioni raggruppate per obiettivo
- Indicatore 'Codice obiettivo'
- Badge 'Giudizio sintetico'
- Indicatore 'Tipo prova' (scritto/orale/pratico)
- Indicatore 'Data valutazione'
- Indicatore 'Giudizio descrittivo' (testo)
- Banner 'Errore caricamento'
- Indicatore 'Nessuna valutazione registrata'
- Filtro per obiettivo di apprendimento
- Indicatore isolamento 'Solo la propria disciplina'

### `/teacher/primaria/[sectionId]/note` — Note Disciplinari (Docente)
_Modulo PRD: Primaria §5_

**Checklist controlli richiesti:**
- Selettore categoria 'Disciplinare (Comportamento)'
- Selettore categoria 'Didattica'
- Selettore categoria 'Compiti non svolti'
- Lista alunni con checkbox di selezione
- Pulsante 'Tutta la classe' / 'Deseleziona tutti'
- Campo 'Testo della nota'
- Toggle 'Richiedi firma di presa visione al genitore'
- Pulsante 'Invia nota'
- Lista 'Note recenti'
- Badge categoria sulla nota (cromatico)
- Indicatore stato 'attesa firma' / 'firmata'
- Banner errore caricamento alunni
- Banner conferma 'Nota inviata'
- Filtro alunni presenti per inserimento massivo
- Azione 'Modifica nota' (entro finestra temporale)
- Indicatore blocco temporale (immodificabilita oltre scadenza)

### `/teacher/primaria/[sectionId]/orario` — Orario Lezioni (Docente)
_Modulo PRD: Primaria §6_

**Checklist controlli richiesti:**
- Indicatore 'Orario settimanale' (titolo pagina)
- Lista Griglia oraria settimanale (matrice campanelle x giorni)
- Indicatore Intestazioni giorni (Lun-Sab)
- Indicatore Fascia oraria campanella (ora_inizio-ora_fine)
- Indicatore Materia per cella (nome disciplina master)
- Indicatore Docente assegnato per cella
- Badge Mensa (cella tipo mensa)
- Badge Intervallo/Ricreazione (cella tipo intervallo)
- Banner 'Orario non ancora configurato' (empty state)
- Indicatore Caricamento orario (loading)
- Indicatore Cella vuota '—' (campanella lezione senza materia)
- Indicatore Contitolarita (piu docenti sulla stessa ora/classe)
- Indicatore Gruppo-classe per disciplina (es. mensa/alternativa)
- Indicatore Modello tempo scuola (Tempo Normale 27/29h / Tempo Pieno 40h)

### `/teacher/primaria/[sectionId]/scrutinio` — Scrutinio & Pagella
_Modulo PRD: Primaria §4.3 + §9_

**Checklist controlli richiesti:**
- Selettore 'Periodo' (intermedio/finale + anno scolastico)
- Banner 'Nessun periodo di scrutinio configurato'
- Indicatore stato scrutinio 'Aperto — proposta giudizi' / 'Chiuso il <data>'
- Banner esito operazione (salvataggi/errori, badge ✓)
- Tabella 'Giudizi alunno x disciplina'
- Selettore 'Giudizio sintetico' per cella (scala Allegato A)
- Indicatore disciplina 'Educazione Civica' (marcatore *)
- Indicatore isolamento materie (celle disciplina altrui disabilitate)
- Pulsante 'Salva giudizi'
- Pulsante 'Template CSV'
- Pulsante 'Importa CSV'
- Azione 'Proponi giudizi da valutazioni in itinere'
- Campo 'Giudizio del comportamento'
- Campo 'Giudizio globale' (facoltativo)
- Pulsante 'Salva comportamento'
- Azione 'Override collegiale giudizio' (modifica/sovrascrittura)
- Pulsante 'Chiudi scrutinio' (solo Dirigente)
- Indicatore 'Scrutinio incompleto: mancano N giudizi'
- Pulsante 'Genera pagelle (tutte)' (solo Dirigente)
- Pulsante 'Pagella PDF' per alunno (post-chiusura)
- Indicatore 'Pubblicato ai genitori' / 'Non pubblicato (solo staff)'
- Pulsante 'Pubblica ai genitori' / 'Revoca pubblicazione' (solo Dirigente)
- Banner conferma 'Pubblicare i voti? I genitori riceveranno una notifica'
- Selettore 'Declinazione descrittori PTOF' applicata in pagella

### `/teacher/primaria/[sectionId]/fascicolo` — Fascicolo Personale Alunno
_Modulo PRD: Fascicolo Personale_

**Checklist controlli richiesti:**
- Selettore 'Alunno'
- Banner 'Accesso tracciato' (documenti riservati)
- Banner 'Accesso non autorizzato' (RBAC negato)
- Banner errore caricamento alunni
- Tab/Sezione 'Documenti ufficiali' (PEI/PDP/sanitari)
- Tab/Sezione 'Pagelle' (storico anni)
- Tab/Sezione 'Sezione amministrativa'
- Tab/Sezione 'Consensi e Privacy'
- Selettore 'Tipo documento' (Diagnosi/PEI/PDP/L.104)
- Campo 'Descrizione documento'
- Campo 'Data di scadenza' documento
- Campo 'File' (upload PDF/immagine)
- Pulsante 'Carica' documento
- Indicatore 'Caricamento…' (stato upload)
- Badge 'Documento caricato' (conferma salvataggio)
- Badge tipo documento (PEI/PDP/104) sulla riga
- Indicatore 'Scade il' (scadenza documento)
- Pulsante 'Apri' (download documento ufficiale)
- Pulsante 'Apri PDF' pagella
- Lista 'Pagelle per anno scolastico' (accordion)
- Toggle anno scolastico (espandi/chiudi)
- Indicatore 'Pubblicata il' (data pagella)
- ✅ Pulsante 'Apri/Scarica certificato delle competenze' _(P5/DL-047, admin `/admin/competenze` + genitore)_
- Indicatore 'Audit log accessi' (chi/quando/finalità)
- Campo 'Finalità di accesso' (motivazione consultazione)
- Sezione/Area 'Workflow firma GLO' (PEI)
- Pulsante 'Visualizza bozza PEI' (GLO)
- Campo 'Annotazione PEI' (collaborazione GLO)
- Pulsante 'Firma per accettazione PEI' (firma Base)
- Badge 'Firme GLO' (stato sottoscrizioni)
- Lista 'Deleghe al prelievo' (con documento delegato)
- Indicatore segregazione 'Documento sensibile' (bucket riservato)

## Segreteria/Admin

### `/admin` — Dashboard Segreteria
_Modulo PRD: Presenze §4.1 + Trasversale_

**Checklist controlli richiesti:**
- Indicatore 'Alunni presenti in tempo reale' (totale struttura)
- Azione 'Drill-down presenze per classe'
- Azione 'Sovrascrivi/correggi presenze docente'
- Pulsante 'Export registro presenze (Excel/PDF) MIUR'
- Indicatore 'Alunni in Ritardo post cut-off da approvare'
- Banner 'Panic Alert ritiro non autorizzato'
- Lista 'Accessi rapidi moduli' (hub Tutti i moduli)
- Pulsante 'Iscrizioni' (azione rapida header)
- Pulsante 'Genera rette'
- Indicatore KPI 'Alunni iscritti'
- Indicatore KPI 'Pagamenti scaduti'
- Indicatore KPI 'Incassato nel mese'
- Indicatore KPI 'Iscrizioni in attesa'
- Indicatore KPI 'Prenotazioni mensa oggi'
- Indicatore KPI 'Fatture da emettere'
- Indicatore 'Incassi ultimi 6 mesi' (grafico trend)
- Indicatore 'Alunni per classe' (grafico)
- Pannello 'Pagamenti scaduti' (alert con badge contatore)
- Pannello 'Iscrizioni da processare' (alert con badge contatore)
- Pulsante 'Apri' (link di dettaglio nei pannelli alert)
- Badge contatore notifiche su pannelli alert

### `/admin/students` — Anagrafica Alunni
_Modulo PRD: Anagrafica §2-§4_

**Checklist controlli richiesti:**
- Tab 'Alunni'
- Tab 'Genitori'
- Tab 'Sezioni'
- Tab 'Staff'
- Filtro 'Cerca per nome/cognome/codice fiscale'
- Filtro 'Classe / Sezione'
- Filtro 'Stato alunno'
- Tabella alunni (Cognome/Nome/Nascita/Classe/Stato/Info)
- Selettore 'Seleziona tutti' (checkbox header)
- Selettore riga alunno (checkbox)
- Azione 'Ordina colonna' (sort header)
- Indicatore 'Sezione: X (n alunni)' (group-by)
- Badge 'Allergie' (nome/badge ROSSO + AlertTriangle)
- Badge 'BES'
- Badge stato alunno (Iscritto/Ritirato/Sospeso)
- Indicatore 'Totale Alunni'
- Indicatore 'Iscritti'
- Indicatore 'Con BES'
- Indicatore 'Con Allergie'
- Pulsante 'Nuovo Alunno'
- Pulsante 'Esporta'
- Pulsante 'Importa pre-iscrizioni' (import dati con 1 click)
- Pulsante 'Genera link pre-iscrizione sicuro'
- Barra 'Assegnazione massiva (Bulk)' selezionati
- Selettore 'Classe destinazione' (bulk)
- Selettore 'Gruppo mensa' (bulk)
- Pulsante 'Assegna' (bulk)
- Pulsante 'Annulla selezione' (bulk)
- Pulsante 'Trasferisci alunno tra sedi'
- Azione 'Apri scheda alunno' (riga cliccabile)
- Campo 'Nome' alunno
- Campo 'Cognome' alunno
- Campo 'Data di nascita'
- Campo 'Codice Fiscale'
- Campo 'Luogo di nascita'
- Campo 'Sesso'
- Campo 'Indirizzo di residenza'
- Campo 'Cittadinanza'
- Selettore 'Sede di appartenenza'
- Selettore 'Classe / Sezione' (scheda)
- Selettore 'Stato alunno' (Iscritto/Ritirato/Sospeso)
- Campo 'Allergie / Intolleranze'
- Badge allergeni ROSSI (chip da note_mediche)
- Toggle 'BES (Bisogni Educativi Speciali)'
- Campo 'Note BES'
- Lista 'Famiglia e Delegati' (tab Madre/Padre/Delegato)
- Pulsante 'Aggiungi delegato'
- Indicatore 'Documento identità delegato' (tipo/numero)
- Pulsante 'Visualizza Allegato' documento delegato
- Pulsante 'Carica documento identità delegato'
- Lista 'Fratelli / Sorelle'
- Lista 'Segnalazioni e Reclami' (note disciplinari)
- Sezione 'Dati Economici / Retta' (connessione Payments)
- Pulsante 'Salva Modifiche' alunno
- Badge conferma salvataggio (toast ✅)
- Pulsante 'Elimina Alunno (GDPR)' (Hard Delete)
- Banner 'Conferma eliminazione definitiva (GDPR)'
- Pulsante 'Reset password / re-invio credenziali genitore'
- Pulsante 'Invita genitore / crea legame parent-student'
- Pulsante 'Reset password staff'
- Lista 'Audit Log modifiche anagrafiche'
- Filtro 'Audit log per utente (Insegnante/Genitore)'

### `/admin/students/new` — Nuovo Alunno
_Modulo PRD: Anagrafica §2_

**Checklist controlli richiesti:**
- Tab 'Alunno'
- Tab 'Madre'
- Tab 'Padre'
- Pulsante 'Aggiungi Componente'
- Icona Cestino rimozione tab componente
- Banner 'Salva prima l'alunno per collegamento automatico'
- Campo Nome alunno
- Campo Cognome alunno
- Selettore Sesso alunno
- Campo Data di Nascita alunno
- Campo Comune di Nascita
- Campo Provincia di Nascita (sigla)
- Campo Codice Fiscale alunno
- Indicatore 'Codice Fiscale Autocalcolato'
- Selettore Sede di appartenenza
- Selettore Sezione (Classe/Sezione)
- Campo Indirizzo di Residenza
- Campo Comune di Residenza
- Campo CAP residenza
- Campo Cittadinanza alunno
- Selettore Stato dell'Alunno (Iscritto/Non iscritto/Ritirato/Sospeso)
- Campo Allergie e Intolleranze
- Selettore Allergeni (14 allergeni UE, badge rosso)
- Toggle 'Studente BES / DSA'
- Campo Note BES / DSA
- Toggle 'Usa pannolino' (abilita scalo automatico pannolino dagli eventi Bagno del Diario — incongruenza #9)
- Selettore Intestatario Fattura (Madre/Padre/Altro)
- Campo Dettagli Intestatario alternativo (Nome/Cognome/CF)
- Campo Importo Retta
- Campo Scadenza mensile pagamento
- Campo Sconti applicati (es. sconto fratelli)
- Pulsante 'Salva Alunno'
- Badge 'Alunno Salvato!' (conferma con ID)
- Pulsante 'Vai alla lista alunni'
- Pulsante 'Nuovo alunno'
- Campo Nome adulto
- Campo Cognome adulto
- Selettore Ruolo Familiare/Operativo
- Selettore Sesso adulto
- Campo Data di Nascita adulto
- Campo Cittadinanza adulto
- Campo Nazione di Nascita adulto
- Campo Comune di Nascita adulto
- Campo Codice Fiscale adulto
- Campo Indirizzo Completo adulto
- Campo Città di Residenza adulto
- Campo CAP adulto
- Campo Numeri di Cellulare (multipli)
- Pulsante 'Aggiungi Numero'
- Campo Indirizzi Email (multipli, prima per Auth)
- Badge 'Primaria' su email principale
- Pulsante 'Aggiungi Email'
- Pulsante 'Rigenera Credenziali'
- Pulsante 'Salva Adulto'
- Azione Upload documento identità delegato
- Azione Upload documenti BES/PEI/Diagnosi

### `/admin/iscrizioni` — Iscrizioni & Onboarding (SIDI)
_Modulo PRD: Anagrafica §4.1 + SIDI_

**Checklist controlli richiesti:**
- Lista 'Richieste di iscrizione' (pending/totale)
- Indicatore 'In attesa (n) · Totale {n}'
- Badge stato 'In attesa'
- Badge stato 'Importata'
- Badge stato 'Rifiutata'
- Indicatore conteggio Bambini per richiesta
- Indicatore conteggio Adulti per richiesta
- Azione 'Apri dettaglio richiesta'
- Sezione 'Bambini' del dettaglio
- Campo 'Codice fiscale alunno'
- Selettore 'Classe / Sezione' per alunno
- Sezione 'Adulti' del dettaglio
- Campo 'Codice fiscale adulto'
- Selettore 'Referente / intestatario' (radio)
- Pulsante 'Documento' alunno
- Pulsante 'Documento' adulto
- Pulsante 'Importa nelle anagrafiche'
- Pulsante 'Rifiuta'
- Banner 'Iscrizione importata' con credenziali
- Indicatore 'Credenziali inviate via email al referente'
- Banner 'Email non inviata - comunicare manualmente'
- Lista 'Avvisi' import (warnings)
- Banner 'Nessuna richiesta ricevuta' (empty state)
- Indicatore 'Caricamento' (spinner)
- ✅ Pulsante 'Upload ZIP ministeriale SIDI' _(P5/DL-048, in `SidiPanel` → `/admin/sidi`)_
- ✅ Azione 'Matching su Numero di domanda SIDI' _(P5/DL-048, `applySidiRecords`)_
- ✅ Azione 'Sincronizzazione dati genitori (chiave CF)' _(P5/DL-048)_
- ✅ Campo 'Numero domanda iscrizione SIDI' _(P5/DL-048, `alunni.numero_domanda_sidi`)_
- ✅ Azione 'Fase A - Allineamento struttura (sedi/sezioni/classi/tempo scuola)' _(P5/DL-049, `buildFaseAReconcile`; egress gated)_
- ✅ Pulsante 'Invia flusso frequentanti al SIDI' _(P5/DL-049; egress gated 503 fino ad accreditamento)_
- ✅ Azione 'Trasmissione associazione Genitori-Alunni (Piattaforma Unica)' _(P5/DL-049, solo legami validati Segreteria; egress gated)_
- ✅ Indicatore stato sincronizzazione SIDI (Fase A → frequentanti → Piattaforma Unica) _(P5/DL-049, `sidi_sync_state` + 3 pill a cascata)_
- Pulsante 'Genera link sicuro pre-iscrizione'
- ✅ Azione 'Assegnazione massiva (bulk) a classi/sezioni/gruppi mensa' _(P5/DL-050, `BulkAssignBar` + `gruppi_mensa`)_

### `/admin/forms/builder` — Form Builder
_Modulo PRD: Form §4.1_

**Checklist controlli richiesti:**
- Campo 'Nome del modello'
- Pulsante 'Indietro' (torna a Modulistica)
- Lista 'Libreria Campi' (palette drag&drop)
- Azione 'Trascina campo dalla palette al canvas'
- Selettore tipo campo 'Testo Corto'
- Selettore tipo campo 'Testo Lungo'
- Selettore tipo campo 'Menu a Tendina'
- Selettore tipo campo 'Numero'
- Selettore tipo campo 'Allegato File'
- Selettore tipo campo 'Firma'
- Lista 'Campi Anagrafica' (blocchi predefiniti)
- Blocco predefinito 'Bambino' (collassabile)
- Blocco predefinito 'Madre' (collassabile)
- Blocco predefinito 'Padre' (collassabile)
- Blocco predefinito 'Delegato / Tutore' (collassabile)
- Toggle espandi/collassa gruppo anagrafica
- Indicatore 'Mapping ETL' del campo anagrafica (db_mapping)
- Tab pagine wizard (step del modulo)
- Pulsante 'Aggiungi pagina'
- Indicatore 'Step X / N' della pagina attiva
- Azione 'Trascina per riordinare i campi'
- Azione 'Seleziona campo per modificarne le proprietà'
- Pulsante 'Elimina campo' (cestino)
- Campo 'Etichetta' del campo
- Campo 'Testo Segnaposto' (placeholder)
- Toggle 'Obbligatorio'
- Campo 'Punteggio Graduatoria' (punti del campo)
- Editor 'Opzioni & Punteggi' (select/radio/checkbox)
- Campo punti per singola opzione
- Pulsante 'Aggiungi opzione'
- Pulsante 'Rimuovi opzione'
- Indicatore 'Mapping ETL' nel pannello proprietà
- Badge 'Obbligatorio' sul campo nel canvas
- Badge '+N pt' (punteggio) sul campo nel canvas
- Pulsante 'Salva Modello'
- Badge stato salvataggio 'Salvato!' (check)
- Banner errore 'Errore' salvataggio
- Indicatore conteggio 'N pagine · N campi'
- Editor 'Logica Condizionale' (regole di visibilità campo)
- Pulsante 'Pubblica modello' (attiva il modello)
- Pannello 'Impostazioni FEA' (abilita Firma Elettronica)
- Selettore 'Firmatari richiesti' (firma singola / congiunta genitori)
- Configurazione accessi 'Chi può compilare' (registrati / link pubblico)
- Campo 'Scadenza bloccante del modulo'
- Configurazione 'Scoring graduatoria' a livello modello (soglia / max punteggio)
- Blocco predefinito 'Consensi' (GDPR check-box separati)

### `/admin/forms/submissions` — Raccolta Compilazioni
_Modulo PRD: Form §4.3_

**Checklist controlli richiesti:**
- Campo 'Cerca per modello o contenuto'
- Filtro Stato compilazione
- Filtro Modello
- Filtro Data invio
- Filtro Tag
- Pulsante 'Esporta tutto (N)' XLSX massivo
- Azione 'Scarica PDF' (riga)
- Azione 'Esporta XLSX' (riga)
- Azione 'Apri anteprima compilazione' (riga)
- Lista campi compilati (dati JSONB)
- Badge Stato compilazione
- Indicatore 'Firma' / data firma
- Indicatore 'Modello rimosso'
- Pulsante 'Scarica PDF' (anteprima)
- Pulsante 'Esporta XLSX' (anteprima)
- Pulsante 'Chiudi' anteprima
- Pulsante 'Rimuovi filtri'
- Azione 'Modifica amministrativa compilazione'
- Indicatore 'Log versione originale'
- Azione 'Importa in Anagrafica (ETL)'
- Indicatore 'Allegati esclusi dal PDF'

### `/admin/forms/rankings` — Graduatorie
_Modulo PRD: Form §4.4_

**Checklist controlli richiesti:**
- Indicatore 'Candidati' (conteggio totale)
- Indicatore 'Punteggio medio'
- Indicatore 'Punteggio massimo'
- Campo Cerca candidato
- Filtro Modulo (selettore 'Tutti i moduli')
- Lista Ranking candidati ordinata per punteggio
- Indicatore Posizione/rank in classifica
- Badge Medaglia top 3 (1°/2°/3°)
- Indicatore Punteggio calcolato
- Indicatore Delta modifiche manuali (+/- accanto al punteggio)
- Indicatore Data firma (Firma)
- Icona Info tooltip 'Modifiche manuali'
- Azione Apri regolazione (click su riga candidato)
- Pulsante 'Rimuovi filtri'
- Modale 'Regola punteggio' (override manuale)
- Campo Bonus/Malus (stepper +/- e input numerico)
- Campo Motivazione (obbligatorio)
- Indicatore Punteggio base / Modifiche manuali / Totale attuale
- Lista Storico modifiche manuali nel modale
- Pulsante 'Applica' (salva override punteggio)
- Pulsante 'Annulla' (chiudi modale senza salvare)
- Azione Delibera ammissioni
- Indicatore Stato ammesso/non ammesso candidato
- Pulsante Esporta graduatoria (XLSX/PDF)

### `/admin/modulistica` — Modulistica Admin
_Modulo PRD: Form (gestione modelli)_

**Checklist controlli richiesti:**
- Tab 'Moduli Genitori'
- Tab 'Moduli Esterni'
- Tab 'Iscrizioni Nuovi Alunni'
- Tab 'Template Certificati ODT'
- Pulsante 'Nuovo Modulo Genitori'
- Pulsante 'Nuovo Modulo Esterni'
- Azione 'Form Builder Drag & Drop'
- Selettore 'Tipo di Modulo' (Sondaggio/Gradimento/Autorizzazione)
- Campo 'Titolo Modulo'
- Campo 'Descrizione / Istruzioni'
- Campo 'Scadenza Modulo'
- Selettore 'Classi Target'
- Pulsante 'Aggiungi Campo'
- Selettore 'Tipo Input' campo
- Campo 'Opzioni di scelta' (radio)
- Toggle 'Campo Obbligatorio'
- Pulsante 'Rimuovi Campo'
- Pulsante 'Salva Modulo'
- Azione 'Blocco Dati Bambino / Adulto / Consensi / Allegati'
- Azione 'Logica Condizionale campi'
- Campo 'Scoring / Punteggio per Graduatorie'
- Selettore 'Configurazione Accessi' (utenti registrati / link pubblico)
- Toggle 'Abilita Firma Elettronica (FEA/FES)'
- Selettore 'Firmatari richiesti' (singola/congiunta genitori)
- Badge 'Tipo Modulo' (etichetta)
- Badge 'OTP / Firma FES' (scudo)
- Badge 'Destinatari' (classi/esterni)
- Badge 'Scadenza' (semaforo scaduto/in scadenza)
- Pulsante 'Merge [Classe]' (export massivo PDF cumulativo)
- Indicatore 'Stato firma per alunno' (AUTORIZZATO/NON AUTORIZZATO)
- Indicatore 'Log FES' (IP / Timestamp / Hash SHA-256)
- Pulsante 'Modifica Scadenza'
- Pulsante 'Elimina Modulo'
- Azione 'Sollecito firme non completate'
- Pulsante 'Esporta XLSX dataset'
- Lista 'Dashboard Raccolta Compilazioni' con filtri (data/stato/modello/tag)
- Azione 'Anteprima e Modifica compilazione (con log versione)'
- Pulsante 'Genera PDF singola compilazione'
- Azione 'Dashboard Graduatorie (ranking + override + ammissioni)'
- Selettore 'Upload Template ODT Carta Intestata'
- Selettore 'Upload Template ODT Certificato Frequenza'
- Selettore 'Upload Template ODT Certificato Iscrizione'
- Badge 'Template ODT caricato' (conferma)

### `/admin/mensa` — Mensa Admin / Menu Builder & Ticket
_Modulo PRD: Mensa §2 + §4_

**Checklist controlli richiesti:**
- Tab 'Menu' (Menu Builder)
- Tab 'Report cucina'
- Tab 'Inserisci ticket'
- Pulsante 'Ricarica ticket' (vai a Pagamenti)
- Pulsante 'Impostazioni mensa'
- Selettore Menu (multi-menu / Menu unico legacy)
- Selettore Settimana ciclo (1..N)
- Campo 'Nome piatto' per portata
- Campo 'Ingredienti' per portata
- Toggle allergene per portata (14 allergeni UE)
- Pulsante 'Salva settimana N'
- Badge 'Salvato' (conferma rotazione)
- Campo 'Data' eccezione (override giornaliero)
- Toggle 'Mensa chiusa' (chiusura per data)
- Editor portate variazione giornaliera (override)
- Pulsante 'Aggiungi' eccezione
- Lista eccezioni/chiusure impostate
- Icona 'Elimina' eccezione (cestino)
- Indicatore impostazione durata ciclo (n. settimane)
- Azione autocompilazione calendario ciclico
- Banner notifica variazione alle famiglie
- Filtro 'Data' report cucina
- Filtro 'Sezione' report cucina
- Indicatore 'Totale pasti' del giorno
- Indicatore conteggio 'allergie nel menu di oggi'
- Lista 'Prenotati per sezione'
- Badge allergene per alunno (rosso se in conflitto)
- Indicatore conflitto allergene-menu (riga rossa + dettaglio portate)
- Indicatore numeri per tipo dieta (Standard/Bianco/Speciale)
- Pulsante 'Esporta report catering' (Excel/PDF)
- Campo ricerca alunno (inserimento ticket)
- Indicatore 'Saldo' ticket alunno
- Campo 'Data del pasto'
- Pulsante 'Inserisci ticket (scala 1)'
- Banner avviso forzatura saldo negativo (debito)
- Badge conferma 'Ticket inserito / nuovo saldo'
- Pulsante 'Ricarica manuale ticket' (accredito pacchetto+importo)
- Selettore 'Pacchetto ticket' (es. 10/20 pasti)
- Azione 'Storno / rimborso ticket'
- Indicatore semaforo scorte ticket (Verde/Giallo<5/Rosso<2)
- Banner reminder esaurimento scorte (soglia critica)

### `/admin/pagamenti` — Pagamenti, Morosità & Fatturazione
_Modulo PRD: Pagamenti §2-§3 + Aruba_

**Checklist controlli richiesti:**
- Tab 'Scadenziario'
- Tab 'Genera rette'
- Tab 'Genera pagamenti'
- Tab 'Ticket mensa'
- Pulsante 'Mensa & Cucina'
- Pulsante 'Impostazioni'
- Indicatore KPI 'Incassato'
- Indicatore KPI 'Da incassare'
- Indicatore KPI 'Scaduto (morosità)' in rosso
- Campo 'Cerca alunno o sezione'
- Filtro 'Categoria pagamento'
- Selettore 'Anno scolastico'
- Selettore 'Mese di competenza'
- Filtro 'Morosi'
- Pulsante 'Aggiorna' (refresh)
- Banner 'Alunni senza retta generata'
- Pulsante 'Genera mancanti'
- Indicatore 'Riga moroso in rosso'
- Badge stato pagamento (Da pagare/Parziale/Pagato/Scaduto)
- Badge 'Non generata'
- Pulsante 'Incassa'
- Icona 'Modifica pagamento' (matita)
- Pulsante 'Nuovo acquisto' (+)
- Icona 'Dividi in acconti'
- Lista 'Acquisti per alunno' (categoria)
- Selettore 'Anno scolastico / Mese singolo' (generatore rette)
- Selettore 'Anno scolastico' (generatore rette)
- Campo 'Mese di competenza' (generatore rette)
- Pulsante 'Anteprima' rette
- Indicatore 'Retta default'
- Indicatore 'Split (genitori separati)'
- Pulsante 'Genera N rette'
- Selettore 'Categoria' (generatore pagamenti)
- Selettore 'Classe (vuoto = tutti)'
- Campo 'Causale / descrizione'
- Campo 'Importo'
- Campo 'Scadenza'
- Campo 'Gruppo (evita duplicati)'
- Toggle 'Obbligatorio'
- Toggle 'Dividi in acconti'
- Campo 'N° rate'
- Pulsante 'Genera per N alunni'
- Campo 'Importo incassato'
- Selettore 'Metodo' (Contanti/Bonifico/POS/Assegno/Altro)
- Campo 'Data incasso'
- Campo 'Note incasso'
- Indicatore 'Pagamento parziale residuo'
- Toggle 'Riporta eccedenza sulla rata successiva'
- Pulsante 'Registra' (incasso)
- Badge 'Pagamento saldato'
- Pulsante 'Invia fattura'
- Campo 'Causale fattura'
- Pulsante 'Emetti' fattura
- Pulsante 'Riprova fattura'
- Pulsante 'Scarica fattura' (download PDF)
- Banner 'Scarto SDI' con motivo
- Campo 'Descrizione' (modifica pagamento)
- Campo 'Importo' (modifica/override retta)
- Campo 'Scadenza' (modifica)
- Selettore 'Categoria' (modifica)
- Toggle 'Pagamento obbligatorio' (modifica)
- Lista 'Incassi registrati'
- Azione 'Modifica incasso'
- Azione 'Storna incasso' (elimina)
- Pulsante 'Salva modifiche'
- Campo 'Descrizione' (nuovo acquisto)
- Campo 'Importo' (nuovo acquisto)
- Toggle 'Pagamento obbligatorio (genera solleciti)'
- Toggle 'Dividi in acconti (rate)' (nuovo acquisto)
- Toggle 'Già pagato (registra subito incasso)'
- Selettore 'Metodo di pagamento' (nuovo acquisto)
- Pulsante 'Registra acquisto'
- Pulsante 'Configura acconti'
- Pulsante 'Genera rate uguali'
- Campo 'Totale piano rateale'
- Campo 'N° rate' (piano)
- Campo '1ª scadenza' (piano)
- Azione 'Aggiungi rata'
- Azione 'Elimina rata'
- Indicatore 'Somma rate vs Totale'
- Pulsante 'Crea piano rateale'
- Campo 'Cerca alunno' (ticket mensa)
- Indicatore 'Saldo ticket'
- Selettore 'Pacchetto ticket'
- Campo 'Pezzi / Costo / Metodo' (ricarica)
- Pulsante 'Ricarica (crea pagamento Mensa saldato)'
- Pulsante 'Sospendi account moroso'
- Toggle 'Override retta da anagrafica (sconto fratelli / data)'
- Indicatore 'Reminder aggressivo insoluti'
- Indicatore 'Quota saldata per gita (semaforo verde)'

### `/admin/primaria` — Config Primaria (Materie/Orario/Valutazione)
_Modulo PRD: Impostazioni §3.2 + Primaria §6_

**Checklist controlli richiesti:**
- Selettore Classe/Sezione (primaria)
- Tab 'Orario'
- Selettore Tempo scuola (27/29/40 ore)
- Selettore Giorni settimana (5/6 giorni)
- Pulsante 'Genera orario'
- Pulsante 'Rigenera campanelle'
- Indicatore 'Attivo: Xh/Ygg'
- Selettore Materia per cella oraria
- Selettore Docente per cella oraria
- Indicatore cella Mensa 🍽
- Indicatore cella Intervallo ☕
- Lista Materie master di sezione
- Pulsante 'Applica preset materie per livello'
- Selettore Livello classe (1ª-5ª) per preset
- Campo 'Nome materia' + Codice
- Pulsante 'Aggiungi' materia
- Toggle 'attiva' materia
- Pulsante 'Elimina' materia
- Badge 'Ed. Civica' su materia
- Badge 'Mensa' (turno) su materia
- Selettore 'Obiettivo della classe' per materia
- Selettore Materia (gestione obiettivi curricolo)
- Selettore Livello (gestione obiettivi curricolo)
- Campo Codice + Descrizione obiettivo
- Pulsante 'Aggiungi' obiettivo
- Pulsante 'Elimina' obiettivo
- Banner motore valutazione forzato O.M. 3/2025 (Primaria)
- Selettore modello valutazione per grado/sezione
- Lista 'Scala giudizi sintetici' (6 ufficiali Allegato A)
- Campo 'Valore numerico' giudizio (media in itinere)
- Campo 'Giudizio descrittivo (pagella)'
- Toggle 'attivo' giudizio della scala
- Pulsante Aggiungi/Elimina giudizio scala
- Lista 'Template giudizio descrittivo' (PTOF/Allegato A)
- Editor giudizio di scrutinio per voto (livello×materia×periodo)
- Lista Assegnazione Docenti & Materie
- Toggle 'contitolare' docente-materia
- Campo Vincoli temporali registro (giorni orali/scritti)
- Campo Buffer notifiche valutazioni (min)
- Pulsante 'Salva impostazioni' (vincoli/notifiche)
- Tab 'Registri di classe'
- Tab 'Fascicoli/Accessi'

### `/admin/impostazioni` — Impostazioni Globali (Super-Admin)
_Modulo PRD: Modulo Impostazioni (tutto)_

**Checklist controlli richiesti:**
- Tab 'Funzioni & moduli'
- Tab 'Pagamenti & Fatturazione'
- Tab 'Modulistica'
- Tab 'Didattica primaria'
- Tab 'Pagelle & Scrutinio'
- Tab 'Diario'
- Tab 'Presenze & Giustifiche'
- Tab 'Note disciplinari'
- Tab 'Mensa'
- Tab 'Armadietto'
- Tab 'Avvisi'
- Tab 'Chat'
- Tab 'Galleria'
- Selettore sezione (sidebar/pills navigazione impostazioni)
- Pulsante 'Aggiungi sede'
- Azione 'Rinomina/Disattiva sede'
- Pulsante 'Crea grado/classe'
- Pulsante 'Aggiungi staff' (onboarding personale)
- Selettore 'Ruolo' (Docente/Segreteria/Cuoca/Direzione)
- Azione 'Associa docente a classe'
- Lista 'Categorie pagamento'
- Badge 'Categoria di sistema' (lucchetto)
- Campo 'Nuova categoria pagamento'
- Pulsante 'Aggiungi categoria pagamento'
- Icona 'Elimina categoria pagamento'
- Campo 'Retta default (€)'
- Campo 'Giorno scadenza retta (1-28)'
- Campo 'Visibile dal giorno (mese prec.)'
- Campo 'Tolleranza insoluti (giorni)'
- Toggle 'Generazione automatica rette mensili'
- Campo 'Causale fattura (template)'
- Pulsante 'Salva' (Retta e morosità)
- Lista 'Pacchetti ticket mensa'
- Campo 'Nome/Pezzi/Costo pacchetto ticket'
- Pulsante 'Aggiungi pacchetto'
- Icona 'Elimina pacchetto ticket'
- Pulsante 'Salva' (Pacchetti ticket)
- Campo 'Username Aruba'
- Campo 'Password Aruba (riferimento vault)'
- Campo 'Partita IVA'
- Campo 'Codice Fiscale'
- Campo 'PEC'
- Campo 'Ragione sociale'
- Campo 'Sede legale'
- Campo 'Regime fiscale'
- Selettore 'Mappatura aliquote/cause IVA'
- Toggle 'Abilita invio fatture (produzione)'
- Selettore 'Ambiente Aruba (test/prod)'
- Badge 'Scaffold' (Fatturazione Aruba)
- Pulsante 'Salva' (Fatturazione Aruba)
- Tabella 'Funzioni × Grado' (matrice attivazione moduli)
- Toggle 'Funzione attiva per grado'
- Pulsante 'Salva' (Funzioni & moduli)
- Badge 'Salvato ✓'
- Selettore 'Routine attive nel diario'
- Campo 'Compilazione diario dalle/alle'
- Campo 'Diario visibile ai genitori dalle'
- Toggle 'Note libere docenti abilitate'
- Badge 'Coming soon' (Diario)
- Pulsante 'Salva' (Diario)
- Campo 'Orario cut-off mensa'
- Selettore 'Giorni mensa attivi'
- Campo 'Settimane di rotazione menu'
- Campo 'Soglia avviso saldo basso'
- Pulsante 'Salva impostazioni mensa'
- Lista 'Menu mensa' (creazione menu per ordine)
- Pulsante 'Aggiungi menu'
- Icona 'Elimina menu'
- Pulsante 'Aggiungi assegnazione classe→menu'
- Selettore 'Menu' (assegnazione classe)
- Indicatore 'Assegnazione attiva/programmata' (✓/⏳)
- Calendario chiusure scolastiche (giorni festivi)
- Campo 'Costo singolo ticket pasto'
- Campo 'Soglia scorta bassa (pezzi)'
- Toggle 'Notifica genitore scorta bassa'
- Toggle 'Richieste materiale ai genitori abilitate'
- Lista 'Categorie materiale extra'
- Pulsante 'Aggiungi categoria armadietto'
- Pulsante 'Salva' (Armadietto)
- Tab 'Materie' (didattica primaria)
- Tab 'Docenti & Materie'
- Tab 'Obiettivi' (curricolo d'istituto)
- Tab 'Classificazione docenti'
- Tab 'Vincoli & notifiche'
- Selettore 'Classe/Sezione' (didattica primaria)
- Campo 'Orario/campanelle e palinsesto settimanale'
- Campo 'Time-lock registro orali (giorni)'
- Campo 'Time-lock scritti/pratici (giorni)'
- Campo 'Buffer notifiche valutazioni (min)'
- Tab 'Periodi scrutinio'
- Tab 'Scala giudizi'
- Tab 'Giudizi scrutinio' (declinazioni PTOF)
- Selettore 'Modello valutazione per grado'
- Selettore 'Chi può inviare moduli' (ruoli)
- Toggle 'Firma moduli con OTP'
- Campo 'Promemoria moduli non compilati (giorni)'
- Selettore 'Formato export submissions (CSV/XLSX)'
- Azione 'Apri Form Builder'
- Pulsante 'Salva' (Modulistica)
- Campo 'Giorni max per giustificare'
- Campo 'Soglia alert assenze (%)'
- Campo 'Appello entro le'
- Toggle 'Giustifica obbligatoria assenze'
- Toggle 'Giustifica con firma OTP genitore'
- Toggle 'Uscite anticipate richiedono delega'
- Toggle 'Presa visione nota con firma OTP'
- Toggle 'Nota visibile al genitore subito'
- Toggle 'Notifica segreteria a nuova nota'
- Lista 'Categorie nota disciplinare'

### `/admin/tools` — Strumenti / Audit / Export
_Modulo PRD: Anagrafica §4.2 + Presenze §4.1_

**Checklist controlli richiesti:**
- Pulsante 'Genera Esportazione' (Excel anagrafiche)
- Pulsante 'Scegli File .xlsx' (importa e sincronizza)
- Campo upload file Excel/CSV (.xlsx/.xls/.csv)
- Indicatore caricamento import/export (spinner)
- Badge 'Importati N su M record!' (esito import)
- Banner nota tecnica elaborazione lato browser
- Lista Audit Log cronologico modifiche anagrafiche
- Filtro Audit Log per singolo utente (Insegnante/Genitore)
- Pulsante 'Recupero credenziali / Reset password' utente
- Pulsante 'Export ministeriale registri presenze' (Excel/PDF)
- Selettore formato export (Excel / PDF)
- Filtro export presenze per grado (Nido/Infanzia/Primaria)
- Pulsante 'Importa pre-iscrizioni' (un click da form esterno)
- Azione 'Diritto all'oblio / Hard Delete' GDPR **✅ (P3.4c, DL-034)** — `/admin/gdpr` (`OblioPanel`): lista alunni **non iscritti** + genitori → cancellazione definitiva = **anonimizzazione** (no DELETE righe, zero rischio FK) con placeholder `CANCELLATO-{hash}` su `alunni`/`parents` (orfani) + rimozione file PII; **preserva audit + fisco** (obbligo legale); **dry-run + doppia conferma** (digitare il nominativo), gate Direzione, audit `gdpr_oblio`. Marcatore `anonimizzato_il` (migr. `20260751`).

## Cuoca

### `/admin/mensa/cucina` — Dashboard Cucina
_Modulo PRD: Mensa §2.2_

**Checklist controlli richiesti:**
- Indicatore 'Pasti Standard' (conteggio per tipologia)
- Indicatore 'Diete in Bianco' (conteggio per tipologia)
- Indicatore 'Diete Speciali' (conteggio per intolleranze)
- Indicatore 'Totale pasti del giorno'
- Indicatore 'Cut-off' (orario limite, es. 09:30)
- Banner 'Numeri provvisori / definitivi (pre/post cut-off)'
- Indicatore real-time / aggiornamento automatico pasti
- Pulsante 'Aggiorna' (refresh manuale dati)
- Lista 'Menu di oggi' (Primo/Secondo/Contorno/Frutta)
- Banner 'Mensa chiusa' (giorno di chiusura)
- Lista 'Allergeni del menu di oggi'
- Badge allergene piatto (nome in rosso + emoji)
- Lista 'Prenotati per sezione' (conteggio per classe)
- Indicatore 'Conflitti allergie nel menu di oggi'
- Badge alunno con allergia/conflitto (nome in ROSSO + alert)
- Filtro 'Data' (selettore giorno report)
- Filtro 'Sezione' (selettore classe)
- Azione 'Approvazione ritardi / richiesta oltre cut-off'
- Indicatore 'Isolamento interfaccia' (sola lettura, nessun dato sensibile)

## Pubblico/Onboarding

### `/iscrizione` — Form Iscrizione Pubblico
_Modulo PRD: Form §4.2 (pre-iscrizione)_

**Checklist controlli richiesti:**
- Indicatore 'Passo X di N'
- Indicatore barra di avanzamento wizard
- Banner 'Iscrizione Nuovo Alunno'
- Pulsante 'Avanti'
- Pulsante 'Indietro'
- Pulsante 'Invia richiesta'
- Tab Bambino (pagina dati minore)
- Tab Adulto (pagina genitore/tutore/delegato)
- Tab Riepilogo
- Pulsante 'Aggiungi un altro figlio'
- Pulsante 'Aggiungi adulto / tutore'
- Pulsante 'Rimuovi' (figlio/adulto)
- Campo Documento d'identità del minore (upload)
- Campo Documento d'identità adulto (upload)
- Indicatore stato upload allegato (caricamento/caricato)
- Campo Codice Fiscale alunno
- Campo Codice Fiscale adulto
- Campo Allergie / Intolleranze alunno
- Selettore Ruolo adulto (Madre/Padre/Tutore/Delegato)
- Banner 'È obbligatorio almeno un adulto / usa stesso CF'
- Banner conferma 'Richiesta inviata!'
- Indicatore stato invio in corso ('Invio…')
- Selettore consenso GDPR / privacy (check-box separati)
- Campo firma elettronica (FES/FEA)
- Pulsante 'Invia codice OTP' (email firmatario)
- Campo inserimento codice OTP
- Indicatore firmatari richiesti (singola/congiunta genitori)

### `/onboarding` — Onboarding Genitore
_Modulo PRD: Anagrafica + Auth_

**Checklist controlli richiesti:**
- Banner 'Benvenuto in Kidville' di primo accesso genitore
- Campo Email account (precompilato dall'invito Segreteria)
- Campo Numero di cellulare
- Campo Nuova password
- Campo Conferma password
- Indicatore robustezza password
- Toggle 'Mostra password'
- Toggle 'Accetto l'Informativa Privacy (GDPR)'
- Toggle 'Accetto i Termini e Condizioni del servizio'
- Toggle 'Consenso uso dati anagrafici/medici figli'
- Pulsante 'Leggi informativa completa' (apertura documento)
- Campo PIN dispositivo libretto
- Campo Conferma PIN dispositivo libretto
- Pulsante 'Completa attivazione account'
- Indicatore stato avanzamento step onboarding
- Banner 'Invito non valido / scaduto'
- Pulsante 'Vai al login' al termine onboarding
- Azione Redirect automatico a /iscrizione

### `/` — Login / Landing
_Modulo PRD: Trasversale (Auth/Accessibilità)_

**Checklist controlli richiesti:**
- Campo 'Email'
- Campo 'Password'
- Pulsante 'Accedi'
- Toggle 'Mostra password'
- Pulsante 'Password dimenticata? / Recupero credenziali'
- Banner 'Accesso solo su invito Segreteria (no auto-registrazione)'
- Toggle 'Alto contrasto'
- Indicatore 'Compatibilità screen reader (label/ARIA sui campi)'
- Banner messaggio errore credenziali
- Indicatore selezione Sede/Tenant
- Pulsante 'Deploy Now'
- Pulsante 'Documentation'

## Note di coerenza — Incongruenze PRD ↔ Roadmap/Prompt

> [!NOTE]
> **STATO: tutte le 9 incongruenze sono RISOLTE** con le decisioni definitive qui sotto recepite nel PRD (giugno 2026). Il PRD resta la fonte di verità.
> - Blocco 1 (questo PRD): decisioni recepite nel corpo e nelle checklist. ✅
> - Blocco 2 (`ROADMAP_TECNICA.md` + `prompts/`): contenuti in conflitto marcati come SUPERATI e allineati al PRD.
> - Blocco 3 (codice): correzioni applicate per #1–#4, #6, #8, #9 (vedi sezioni successive). La firma (#5, FEA) era esclusa dal Blocco 3 ma è stata **rimessa in scope** come servizio in-house — vedi **DL-001** nel Decision Log.

- ✅ **RISOLTA** — **Valutazione primaria: voti numerici vietati vs modello ibrido numerico/descrittivo** (alta). **Decisione recepita (rev. committente):** voto **visibile** = **giudizio sintetico** Allegato A; **nessun voto numerico 1-10 visibile** alla primaria. È **MANTENUTA l'associazione numerica nascosta** (es. *Sufficiente* = 6) usata solo internamente per la media (#3). I voti numerici visibili restano solo per i gradi non-primaria. *Analisi originale:* PRD: PRD §4 (Diario Scuola Primaria) è categorico: per la primaria i voti numerici sono VIETATI sia in itinere sia a scrutinio (L.150/2024, O.M.3/2025). Il motore è 'ibrido per grado': per la Primaria la modalità a voti numerici è 'disabilitata e non selezionabile dal docente'; i numerici (1-10) sono ammessi SOLO per gradi non-primaria. La valutazione in itinere è per obiettivi/4 dimensioni con giudizio descrittivo; lo scrutinio usa i 6 giudizi sintetici dell'Allegato A. Lo stato attuale del codice (GradesTab.tsx, valutazioni.voto_numerico) è dichiarato 'NON conforme'. · Roadmap/Prompt: ROADMAP_TECNICA.md (riga 15, Fase 1) prescrive per il registro primaria un 'Sistema di valutazione ibrido (voti numerici e giudizi descrittivi)' senza alcuna restrizione per grado. prompts/fase1_02_registro_primaria.md (punto 3) ordina esplicitamente: 'Valutazioni (Voti): Modello ibrido: numerici (es. 1-10) o descrittivi (es. Base, Avanzato)' come spec del modulo Primaria. Questo contraddice direttamente il divieto del PRD: la roadmap/prompt fanno implementare i voti numerici proprio dove sono vietati.
- ✅ **RISOLTA** — **Scala di giudizio primaria: Allegato A (Ottimo→Non sufficiente) vs 'Base/Avanzato'** (media). **Decisione recepita:** l'unica scala ammessa alla primaria è quella dell'**Allegato A O.M. 3/2025** (Ottimo, Distinto, Buono, Discreto, Sufficiente, Non sufficiente). La scala **Base/Intermedio/Avanzato è SUPERATA** e non va più usata. *Analisi originale:* PRD: PRD §4.3 impone in modo rigido la scala dell'Allegato A O.M.3/2025 a SEI giudizi sintetici (Ottimo, Distinto, Buono, Discreto, Sufficiente, Non sufficiente), 'non rimodulabile nelle definizioni standard'. Il box IMPORTANT di §4 dichiara esplicitamente SUPERATO e 'da sostituire' il vecchio modello a livelli 'Base/Intermedio/Avanzato' (riferimenti 2020). · Roadmap/Prompt: prompts/fase1_02_registro_primaria.md (punto 3) usa come esempio di giudizi descrittivi proprio 'Base, Avanzato', cioè la scala dichiarata superata dal PRD. Manca ogni riferimento alla scala a 6 livelli dell'Allegato A o all'enum vincolato per la primaria.
- ✅ **RISOLTA** — **Calcolo automatico delle medie dei voti (primaria)** (alta). **Decisione recepita (rev. committente):** il **calcolo della media è MANTENUTO**, basato sull'**associazione numerica nascosta** dei giudizi sintetici (#1). La media è uno strumento interno di sintesi per il docente (il documento di valutazione resta espresso in giudizi). *Analisi originale:* PRD: Il PRD non prevede alcun 'calcolo medie' per la primaria: la valutazione in itinere è formativa, per obiettivi di apprendimento e 4 dimensioni (Autonomia, Continuità, Tipologia situazione, Risorse), con giudizio descrittivo/sintetico; lo scrutinio aggrega in 6 giudizi sintetici per disciplina, modificabili collegialmente. Non esiste il concetto di media numerica alla primaria (coerente col divieto dei voti numerici). · Roadmap/Prompt: ROADMAP_TECNICA.md (riga 15) richiede 'calcolo automatico medie'. prompts/fase1_02_registro_primaria.md istruisce: 'I giudizi descrittivi devono avere un valore numerico nascosto per il calcolo delle medie' e (Istruzioni Operative, punto 2 Backend) 'Crea la logica per il calcolo asincrono delle medie'. Introdurre un valore numerico nascosto e una media reintroduce di fatto la valutazione numerica vietata dal PRD.
- ✅ **RISOLTA** — **Categorizzazione voti Scritto/Orale/Pratico applicata alla primaria** (media). **Decisione recepita (rev. committente):** le categorie **Scritto/Orale/Pratico sono MANTENUTE anche alla primaria** — servono come tipologia della prova e per i termini di immodificabilità §8 (orali 2gg / scritte-pratiche 15gg). *Analisi originale:* PRD: PRD §4.1 riserva la categorizzazione Scritto/Orale/Pratico (con voti 1-10) esclusivamente ai gradi NON-primaria ('eventuale secondaria di primo grado'). Per la primaria la valutazione è per obiettivi e dimensioni, senza categorie scritto/orale/pratico. · Roadmap/Prompt: prompts/fase1_02_registro_primaria.md (punto 3, modulo Primaria) elenca tra le specifiche delle Valutazioni: 'Categorizzazione: Scritto, Orale, Pratico', senza limitarla ai gradi non-primaria, quindi imponendola al registro primaria.
- ✅ **RISOLTA** — **Firma documenti modulistica: FEA (Avanzata) vs FES (Semplice)** (alta). **Decisione recepita:** la firma documenti è **FEA (Firma Elettronica Avanzata)**, come da PRD, confermata. I riferimenti a **FES** in roadmap/prompt sono **SUPERATI**. ⚠️ **Aggiornamento (DL-001, 2026-06-25):** l'implementazione tecnica della FEA è ora **in scope** e sarà realizzata **in-house** (OTP email + verifica identità + ricevuta PDF con log IP/Timestamp/User-Agent/Hash SHA-256) nella Fase P1 del master plan — non più a carico del committente. ✅ **Implementata (P1, 2026-06-25):** servizio `src/lib/fea/` (builder `signature_log`, slot firmatari `fea_signatures` con policy `any-one`/`all-required` — DL-007, audit `fea_audit_log` — DL-009, ricevuta `GET /api/fea/receipt` con hash documentale via **jsPDF** — DL-006); 3 consumatori ricablati (wizard moduli/pagella/giustifica). *Nota legale:* l'etichetta resta "FEA" per DL-001; il livello tecnico (OTP+identità da sessione+ricevuta inattaccabile) è una firma elettronica rafforzata in-house — informativa/processo da validare col committente. *Analisi originale:* PRD: PRD Modulo Form (prd.md e sezione omologa nel PRD principale) descrive la validazione legale tramite 'Firma Elettronica Avanzata (FEA)' — §1 Descrizione Generale e §4.1 'Impostazioni FEA: Abilitazione della Firma Elettronica Avanzata, definendo i firmatari richiesti'. La validità è garantita da OTP via email. · Roadmap/Prompt: ROADMAP_TECNICA.md (Fase 4, riga 50) parla di 'Integrazione Firma Elettronica Semplice (FES)'. prompts/fase4_01_modulistica.md intitola la sezione 'Scudo Giuridico e FES' e ripete 'Firma Elettronica Semplice (FES)' / 'efficacia legale della Firma Elettronica Semplice'. FEA e FES sono due livelli giuridici diversi (eIDAS): contraddizione sul tipo di firma da implementare e sul valore probatorio.
- ✅ **RISOLTA** — **Diario: pulsanti Nanna e Sveglia separati vs pulsante unico 'Nanna' (inizio+fine)** (media). **Decisione recepita:** **DUE pulsanti distinti** — "Nanna (Inizio)" e "Sveglia (Fine Nanna)" — che registrano l'orario "dalle … alle …". Il pulsante unico attuale va corretto (Blocco 3). *Analisi originale:* PRD: PRD §3.1 e §3.1.1 elencano DUE eventi/pulsanti distinti nella griglia: 'Nanna (Inizio)' (orario inizio riposo) e 'Sveglia (Fine Nanna)' (orario fine). La griglia Step 1 include esplicitamente sia 'Nanna' sia 'Sveglia' come pulsanti separati. La nota di implementazione del PRD segnala già come deviazione l'unificazione. · Roadmap/Prompt: prompts/fase2_01_diario_infanzia.md (punto 1 e Flusso UX) tratta 'Nanna (inizio e fine)' come singola routine/pulsante unico con due input. ROADMAP_TECNICA.md (Fase 2) elenca solo 'Nanna' tra le routine, senza 'Sveglia'. La griglia eventi quindi prevede un solo pulsante anziché i due richiesti dal PRD.
- ✅ **RISOLTA** — **Filtro presenze nel Diario 0-6 (mostrare solo i 'Presenti')** (bassa). **Decisione recepita:** requisito **ATTIVO** — le sezioni di inserimento del Diario mostrano **solo i bambini "Presenti"** nel modulo Presenze. Da implementare nel codice (Blocco 3). *Analisi originale:* PRD: PRD §3.1 (Filtro Presenze) richiede che le sezioni di inserimento del Diario mostrino esclusivamente i bambini 'Presenti' nel modulo Presenze, rimuovendo automaticamente gli assenti. Tuttavia la nota di implementazione dello stesso PRD avverte che 'Il filtro presenze ... non è ancora attivo — vengono mostrati tutti gli alunni della sezione'. · Roadmap/Prompt: prompts/fase2_01_diario_infanzia.md richiede ripetutamente il filtro presenze come requisito attivo (punto 2 'Filtro presenze: Mostra solo i bambini Presenti oggi', Flusso UX Step 2 'compare la lista dei bambini Presenti oggi', Istruzioni punto 3). Esiste quindi una incongruenza tra requisito di prodotto (filtro obbligatorio) e stato dichiarato nel PRD (filtro non implementato, lista completa mostrata).
- ✅ **RISOLTA** — **Diario Bagno/Igiene: 'Vasino/potty training' vs soli contatori Pipì/Cacca** (bassa). **Decisione recepita:** il **Vasino 🚽** è un **controllo previsto e già implementato**, accanto a Pipì 💧 e Cacca 💩 (documentato in §3.1.1). *Analisi originale:* PRD: PRD §2.1 indica per Bagno/Igiene il monitoraggio di Pipì, Cacca e 'Uso del Vasino (per potty training)'. La sezione §3.1.1 e la nota di implementazione descrivono però solo due contatori +/- (Pipì 💧 e Cacca 💩), senza il tracciamento Vasino. · Roadmap/Prompt: prompts/fase2_01_diario_infanzia.md (punto 1) elenca 'Bagno/Igiene (Pipì, Cacca, Vasino)' come routine da supportare, reintroducendo il Vasino che la parte operativa del PRD e l'implementazione non prevedono come controllo dedicato.
- ✅ **RISOLTA** — **Armadietto: trigger consumo su 'cambio pannolino' vs evento 'Bagno/Igiene'** (bassa). **Decisione recepita:** lo scalo di **1 pannolino** avviene ad **ogni evento Bagno** del Diario, ma **solo per i bambini con flag "Usa pannolino"** attivo in Anagrafica (§2.1). I bambini senza flag non subiscono scalo. Da implementare nel codice (Blocco 3). *Analisi originale:* PRD: PRD Armadietto §2.2 (Consumo Automatico) scala un'unità ad ogni azione specifica di consumo registrata nel Diario, citando esplicitamente l'esempio 'cambio pannolino'. Nel Diario, però, l'evento Bagno è modellato come contatori Pipì/Cacca, non come 'cambio pannolino' dedicato. · Roadmap/Prompt: prompts/fase2_02_armadietto_anagrafica.md (Istruzioni punto 1) prescrive un trigger che 'alla registrazione di un evento Bagno/Igiene nel Diario ... decrementa la disponibilità', legando lo scalo a qualunque evento Bagno (es. pipì) e non al solo cambio pannolino: ambiguità su quale azione consuma lo stock, con rischio di decremento errato.

---

# Decision Log (Implementazione)

> [!IMPORTANT]
> Registro cronologico delle decisioni prese durante l'implementazione del **Master Plan** (vedi `ROADMAP_GAP_2026.md` + piano `a-crea-un-piano`). Ogni voce è recepita anche **inline** nelle sezioni/checklist pertinenti del PRD. In caso di conflitto con testo più vecchio, **vince la voce più recente del Decision Log**.

### 2026-06-25 — DL-001 — [Fase P1] FEA: da "esclusa/committente" a "in scope, in-house"
- **Contesto:** il PRD (incongruenza #5 e nota Blocco 3) dichiarava la firma FEA **esclusa** dall'implementazione e "a carico del committente". Il committente ha deciso di **includerla nello scope** del prodotto.
- **Decisione:** la **FEA è in scope** e verrà realizzata **in-house** come servizio trasversale (Fase P1): slot firmatari (singola/congiunta genitori), invio/reinvio **OTP via email** (base `forms/send-otp` esistente), verifica identità, **ricevuta PDF inattaccabile** con log **IP / Timestamp / User-Agent / Hash SHA-256**. Consumata da: Modulistica/Form (§Form §4.1), Pagelle (§Primaria §9.2), firma di registro docente (§Primaria §8), consensi e workflow GLO del PEI (§Fascicolo).
- **Impatto PRD:** aggiornati la nota Blocco 3 e l'incongruenza **#5** (rimosso "esclusa dal Blocco 3"); annotato §Form §4.1; in `ROADMAP_TECNICA.md` Fase 4 rimossa la nota "a carico del committente".
- **Alternative scartate:** provider terzo certificato (Aruba Firma/Namirial/InfoCert) — scartato per costo/dipendenza esterna; rinvio della scelta — scartato perché la FEA è prerequisito di più moduli.

### 2026-06-25 — DL-002 — [Fase P0] Autenticazione reale invite-only su Supabase Auth
- **Contesto:** non esiste autenticazione reale. L'identità viaggia via `?userId=`/header `x-user-id` con fallback hardcoded (`DEV_TEACHER_ID`/`DEV_PARENT_ID`); il modello identità è frammentato (`utenti` staff scollegata da `auth.users`; `parents` + `legame_genitori_alunni` coesistenti). I gate RBAC si fidano dell'identità passata dal client.
- **Decisione:** implementare **login reale invite-only** su **Supabase Auth** (Fase P0): pagina `/auth/login` (email+password+recupero), `src/middleware.ts` di protezione route, identità risolta **server-side dalla sessione** (non da query param), unificazione identità (genitori autoritativi su `parents`+`student_parents`, `auth_user_id` su `utenti`), **nessuna auto-registrazione genitori**, legame `parent_id↔student_id` creato solo dalla Segreteria. Dettagli tecnici da fissare nello spec P0.
- **Impatto PRD:** annotati §Anagrafica §3 (RBAC), §Comunicazione §5 (Super-Admin), §Trasversale (nuova §5 Autenticazione e Accesso).
- **Alternative scartate:** mantenere il modello a query param (insicuro); magic-link only (preferito email+password per la pagina login da PRD).
- **Correzione (2026-06-25, da verifica DB live):** lo **staff è già auth-backed** — `utenti.id` ha FK → `auth.users(id)` (`utenti_id_fkey`), 10/10 staff presenti in `auth.users` (9 con password/confermati). Quindi **niente colonna `auth_user_id` su `utenti`** e niente backfill staff: per lo staff vale già `utenti.id = auth.uid()`. I **genitori reali** (92) vivono su `parents`/`student_parents`, **non** su `utenti(genitore)` (5 demo): `parents.id` è un uuid random **senza** FK ad auth, quindi si auth-backano aggiungendo **`parents.auth_user_id`** (la PK non si ripunta, è referenziata da `student_parents`). Le RLS pagamenti, oggi keyed sullo spazio `legame.genitore_id = auth.uid()`, vengono estese allo spazio `parents`/`student_parents` mantenendo il ramo legacy in `OR`. Strategia di transizione = **shim incrementale** dietro flag `ALLOW_HEADER_IDENTITY` (no big-bang).

### 2026-06-25 — DL-003 — [Fase P0] Attivazione RLS in produzione
- **Contesto:** 74 tabelle hanno RLS abilitata ma tutti gli endpoint usano `service_role` che la bypassa; le policy dev (`rls_policies_dev.sql`) sono aperte `TO anon`. In produzione la RLS è inattiva.
- **Decisione:** attivare la **RLS in produzione** (Fase P0): letture lato genitore via `createSessionClient()` (RLS applicata a DB, isolamento per figlio/sede); scritture staff via `service_role` **con audit obbligatorio** (`audit_scritture_docente`). Roll-out per famiglia-tabella su staging prima del prod; verifica con `get_advisors`.
- **Impatto PRD:** annotata §Trasversale §4 (Audit e Tracciabilità).
- **Alternative scartate:** RLS solo "teatro" via service_role ovunque (non conforme GDPR/multi-tenant).
- **Nota rollout (2026-06-25, da verifica):** la base RLS è pronta — `parents.auth_user_id` (S4) e le policy pagamenti additive per lo spazio `parents` (S7) sono applicate e verificate su dati reali (genitore vede solo i propri figli). Il **lockdown finale** (rimozione delle policy permissive `allow_all_*`/`TO anon`, S9) e l'attivazione delle letture genitore via `createSessionClient` (S8, helper `createParentReadClient` pronto dietro flag `PARENT_READS_USE_SESSION`) sono uno **step di rollout controllato**: vanno fatti DOPO l'onboarding dei genitori (login reale → sessione, via DL-005) e DOPO aver migrato le **letture anon dirette** del frontend (`alunni`/`legame_genitori_alunni`/`utenti`/`form_*`) verso API/policy `authenticated`. Attivarli prima romperebbe la produzione. Il sigillo `ALLOW_HEADER_IDENTITY='false'` (S13) chiude la fase.

### 2026-06-25 — DL-004 — [Fase P5] SIDI / Piattaforma Unica incluso come fase finale
- **Contesto:** il modulo Interoperabilità SIDI è nel PRD ma fuori dalle 5 fasi originali della roadmap (oggi ~2/12 requisiti implementati).
- **Decisione:** **incluso nel master plan come ultima fase (P5)**, dopo i moduli core, vincolato dall'accreditamento ministeriale e dalle tempistiche d'avvio anno scolastico.
- **Impatto PRD:** annotata §Interoperabilità SIDI (nota di pianificazione).
- **Alternative scartate:** parcheggiarlo come progetto separato (rischio di anagrafica non allineata al SIDI); solo ganci dati (rinviato del tutto il valore amministrativo).

### 2026-06-25 — DL-005 — [Fase P0] Recupero credenziali Segreteria-managed con invio automatico email
- **Contesto:** la pagina di login (spec P0) prevedeva un "password dimenticata" self-service. Non esiste oggi alcun login/reset reale; "Rigenera credenziali" è uno stub (solo toast). Per i genitori il modello è invite-only (nessuna auto-registrazione).
- **Decisione:** il recupero password è **gestito dalla Segreteria**, non self-service: un pulsante **"Rigenera credenziali"** dentro l'anagrafica del genitore (e del record staff) chiama un endpoint admin (`requireStaff`) che genera una nuova password random (`auth.admin.updateUserById`) e la **invia automaticamente via email** all'utente (riuso di `sendEmail`/Resend). **Niente "password dimenticata" self-service** sulla pagina di login. Coerente con l'impianto invite-only e con §Anagrafica §4.2.
- **Impatto PRD:** aggiornata §Anagrafica §4.2 (Recupero Credenziali), §Anagrafica §3 (riga Genitore), §Trasversale §5 (Autenticazione e Accesso).
- **Alternative scartate:** `resetPasswordForEmail` self-service di Supabase (scelta dall'utente: il recupero deve restare presidiato dalla Segreteria); reset senza invio email (più carico operativo, l'utente non riceve le credenziali).

### 2026-06-25 — DL-006 — [Fase P1] Libreria PDF = jsPDF (Puppeteer/PDFKit superati)
- **Contesto:** il PRD citava sia **Puppeteer** sia **PDFKit** per la generazione PDF; il codice però usa già **jsPDF** (`jspdf` + `jspdf-autotable`) per l'export moduli (`/api/forms/export/pdf`) e per la pagella (`src/lib/primaria/pagella-pdf.ts`).
- **Decisione:** la libreria PDF è **jsPDF**, riusata anche per la **ricevuta di firma** FEA (`src/lib/fea/receipt-pdf.ts`). Niente Puppeteer (headless Chrome: dipendenza pesante, costo cold-start serverless, gestione binario Chromium) né PDFKit. I riferimenti a Puppeteer/PDFKit nel PRD/roadmap sono **[SUPERATO]**.
- **Impatto PRD:** annotato §Form §4.1 e §5.3; coerente con DL-001 (ricevuta inattaccabile).
- **Alternative scartate:** Puppeteer (sovradimensionato/serverless-costoso); pdf-lib (nuova dipendenza, più verboso senza vantaggi qui).

### 2026-06-25 — DL-007 — [Fase P1] Modello firmatari FEA: una firma sufficiente, slot per entrambi
- **Contesto:** §Form §4.1 "Impostazioni FEA" prevede firma **singola o congiunta** di entrambi i genitori. Serviva fissare la regola di completamento.
- **Decisione:** il servizio FEA modella **N slot firmatari** (tabella additiva `fea_signatures`, 1 riga per slot, stato `pending/signed`). La **policy di completamento è configurabile**: default **`any-one`** (basta la firma di un genitore per completare), opzione **`all-required`** (richieste entrambe). Il modello prevede quindi la possibilità di entrambi i firmatari pur restando, di default, sufficiente una sola firma. Le colonne per-flusso esistenti (`pagella_ricezioni.firma`, `presenze.giustificazione_firma`, `form_submissions.signature_log`, `forms_submissions.signature_log`) restano source-of-truth del firmatario primario; `fea_signatures` è il ledger parallelo su cui si valuta la policy.
- **Impatto PRD:** annotato §Form §4.1 (Impostazioni FEA).
- **Alternative scartate:** solo firma singola (rework certo quando servirà la congiunta nel Form Builder P3); array JSON nelle colonne esistenti (niente stato per-slot né completamento parziale).

### 2026-06-25 — DL-008 — [Fase P1] Accessibilità: baseline + WCAG-AA come definition-of-done
- **Contesto:** L. 4/2004 (Legge Stanca)/AgID richiedono alto contrasto, ARIA/screen reader, WCAG. Esisteva solo un toggle alto-contrasto **locale alla pagina di login** (stato non persistito, non globale).
- **Decisione:** **baseline P1** = provider globale alto-contrasto (`src/lib/accessibility/`, persistito su cookie SSR-safe → `<html data-contrast>` senza FOUC) applicato a tutta l'app, set token CSS HC + focus-ring + `prefers-reduced-motion` in `globals.css`, primitive **Modal accessibile** (`role=dialog`/`aria-modal`/focus-trap/Escape/restore focus), landmark `nav`/`main` + skip-link, `aria-current` sulla navigazione, e **smoke test `jest-axe`** (login/modale OTP/nav). La conformità **WCAG-AA** diventa **definition-of-done** dei nuovi frontend; l'audit AA per-pagina dei moduli esistenti è applicato **incrementalmente** nelle fasi successive (non un audit big-bang in P1).
- **Impatto PRD:** aggiornati §Trasversale §2 (Accessibilità) e top-matter (riga Accessibilità AgID).
- **Alternative scartate:** audit WCAG 2.1 AA completo di ogni pagina ora (sconfina in P2-P4); solo toggle globale senza ARIA/focus/test (non difendibile come "alto contrasto + screen reader").

### 2026-06-25 — DL-009 — [Fase P1] Audit FEA su tabella dedicata `fea_audit_log`
- **Contesto:** serviva un'evidenza FES immutabile (CAD Art. 20 / DPR 445/2000) per tutti i flussi di firma. L'audit esistente `audit_scritture_docente` è **staff-scoped** (attore/ruolo docente, enum `azione insert/update/delete`, diff `valore_prima/dopo`): semantica incompatibile con la firma del genitore.
- **Decisione:** audit di firma su tabella **dedicata e immutabile `fea_audit_log`** (eventi `otp_sent`/`signed`/`verify_failed`, hash/IP/User-Agent), best-effort (un errore di audit non blocca la firma). Scritta da tutti i consumatori FEA (pagella, giustifica, forms-otp, wizard moduli).
- **Impatto PRD:** annotato §Trasversale §4 (Audit e Tracciabilità) e §Form §4.1.
- **Alternative scartate:** riuso di `audit_scritture_docente` (modello attore/azione errato); nessun audit dedicato (perdita dell'evidenza FES trasversale).

### 2026-06-25 — DL-010 — [Fase P1] `form_submissions` canonica, `forms_submissions` legacy (no migrazione dati)
- **Contesto:** coesistono due tabelle: **`form_submissions`** (usata dal wizard live `/api/forms/send-otp` + export PDF) e **`forms_submissions`** (path legacy onboarding/`persist-submission`). Il wizard live finora **non** salvava alcun `signature_log`.
- **Decisione:** **canonica = `form_submissions`**; `forms_submissions` resta **legacy**. Aggiunta colonna `signature_log JSONB` a `form_submissions` così anche il wizard registra l'evidenza FES canonica. **Nessuna migrazione dati** tra le due tabelle in P1 (consolidamento rinviato per non toccare un path di firma in produzione).
- **Impatto PRD:** annotato §Form §4.1.
- **Alternative scartate:** unificare/migrare i dati ora (rischio su un flusso di firma live, fuori scope P1); cambiare il meccanismo OTP del wizard (cambierebbe il contratto del client `OtpSignatureModal`).

### 2026-06-26 — DL-011 — [Fase P2] Crittografia Fascicolo: cifratura at-rest gestita (no AES applicativa)
- **Contesto:** il PRD §Fascicolo cita "crittografia AES-256" dei file sensibili (PEI/PDP/sanitari). La migrazione `20260630_fascicolo_rbac_audit.sql` aveva già scelto di demandare la cifratura a Supabase Storage (bucket privato `sensitive_documents` + signed URL TTL 60s + RBAC `puoAccedereFascicolo` + audit immutabile `fascicolo_accessi_audit`), senza crittografia applicativa.
- **Decisione:** il controllo "AES-256" è **soddisfatto dalla cifratura at-rest gestita** (Storage cifra at-rest in AES-256) + bucket privato + signed URL a TTL breve + RBAC + audit accessi. **Nessuna crittografia applicativa** (envelope/KMS): aggiungerebbe custodia chiavi a nostro carico e romperebbe lo streaming via signed URL, per un beneficio marginale dato l'accesso già mediato da API service_role. Lato UI restano da aggiungere il badge "Documento sensibile" (banner "Accesso tracciato" già presente) — slice sequenziato.
- **Impatto PRD:** §Fascicolo (sezione crittografia/sicurezza) + §6 Stato per area.
- **Alternative scartate:** envelope encryption applicativa AES-256 con KMS (XL, fuori core P2; eventualmente a carico committente per livello qualificato).

### 2026-06-26 — DL-012 — [Fase P2] Export ministeriale Presenze = registro mensile XLSX + PDF
- **Contesto:** per una scuola paritaria non esiste uno schema "ministeriale MIUR" unico per il registro presenze; il requisito era ambiguo. Esiste già un export **PDF** mensile (`MonthlyAttendanceTable.tsx`, jsPDF).
- **Decisione:** "Export ministeriale" = **registro mensile in XLSX + PDF**: griglia giorno×alunno con totali (presenze/assenze/ritardi/giustificate), layout istituzionale. XLSX via libreria **`xlsx`** (da verificare/aggiungere alla prima implementazione), PDF via jsPDF esistente. **Implementazione sequenziata** dopo il sottoinsieme "core compliance" di questa sessione.
- **Impatto PRD:** §Presenze (Export) + checklist `ROADMAP_GAP_2026`.
- **Alternative scartate:** tracciato XML SIDI (è P5/Interoperabilità, non Presenze); attendere un template dal committente (lo si potrà sostituire se fornito).

### 2026-06-26 — DL-013 — [Fase P2] Meccanismo "account sospeso" rinviato a P3
- **Contesto:** il requisito "persistenza visiva con account sospeso" presuppone un meccanismo di sospensione account che **non esiste** (nessun flag `sospeso` su `utenti`/`parents`, nessun gate auth) e che si sovrappone alla "sospensione account moroso" del modulo amministrativo/finanziario (P3).
- **Decisione:** il **meccanismo di sospensione** (flag + gate auth + stato UI read-only) è **materia di P3**; il requisito esce dallo scope P2 per non costruire mezzo meccanismo qui e rifarlo in P3.
- **Impatto PRD:** §Primaria Valutazione (nota di rinvio) + cross-ref §Pagamenti/Impostazioni P3 + §6 Stato.
- **Alternative scartate:** introdurre `sospeso` ora in P2 (anticipa lavoro P3 con rischio di disallineamento col modello morosità).

### 2026-06-26 — DL-014 — [Fase P2] Presa visione note → pattern FEA (OTP/FES) + `nota_ricezioni`
- **Contesto:** la firma di presa visione delle note disciplinari (interazione obbligatoria, PRD §Primaria) usava un semplice timestamp `note_disciplinari.firmata_il` via `POST /api/parent/primaria/note`, **senza** evidenza FES (IP/hash/audit).
- **Decisione:** la presa visione adotta lo **stesso pattern della pagella** (DL-006/007/009): OTP email (FES) → `buildSignatureLog` salvato in nuova tabella **`nota_ricezioni`** (`UNIQUE(nota_id, genitore_id)`, RLS service+read) + slot firmatari `fea_signatures` (`entita_tipo='nota'`) + audit immutabile `fea_audit_log`. Nuove route `POST /api/parent/primaria/note/firma` (+ `/firma/otp`); il vecchio `POST /api/parent/primaria/note` risponde **410** (deprecato). `note_disciplinari.firmata_il`/`firmata_da` restano valorizzati per retro-compat con la vista genitore.
- **Impatto PRD:** §Primaria (Note disciplinari, presa visione) + §6 Stato.
- **Alternative scartate:** mantenere il timestamp semplice (privo di valore probatorio FES); riusare `pagella_ricezioni` (semantica/entità diversa).

### 2026-06-26 — DL-015 — [Fase P2] Valutazione in itinere legata a ≥1 obiettivo (enforcement condizionale)
- **Contesto:** il PRD chiede la valutazione in itinere "legata a ≥1 obiettivo di apprendimento" (O.M. 172/2020). Il codice usava `argomento` (testo libero obbligatorio) **al posto** dell'obiettivo strutturato; la tabella `valutazione_obiettivi` esisteva ma quasi inutilizzata (1 riga). Su DB live **1 scuola ha 7 obiettivi** configurati (italiano/matematica/storia/geografia, livelli 1/3).
- **Decisione:** reintrodurre il collegamento strutturato a `valutazione_obiettivi` con **enforcement CONDIZIONALE**: ≥1 obiettivo obbligatorio **solo quando la scuola ha obiettivi configurati** per quella (materia, livello) — stesso filtro del selettore docente, estratto nel helper unico `src/lib/primaria/obiettivi.ts` (`obiettiviDisponibili`). Se non ce ne sono, **fallback su `argomento`** (sempre obbligatorio): non blocca le scuole senza curricolo seminato. `POST /api/primaria/valutazioni` valida ed inserisce le righe link; la UI docente mostra i checkbox obiettivi quando disponibili.
- **Impatto PRD:** §Primaria Valutazione + §6 Stato.
- **Alternative scartate:** enforcement rigido sempre (bloccherebbe le scuole senza obiettivi); considerare `argomento` sufficiente (non soddisfa il vincolo normativo dove il curricolo esiste).

### 2026-06-26 — DL-016 — [Fase P2] Panic Alert: notifica simultanea Segreteria/Direzione + genitore (push P1)
- **Contesto:** `POST /api/panic-alert` registrava solo il flag `presenze.panic_alert=true`, **senza** alcuna notifica (requisito PRD §Presenze: allerta istantanea simultanea Segreteria + App Genitore).
- **Decisione:** dopo il salvataggio, **notifica best-effort** via servizio push P1: a tutto lo **staff del plesso** dell'alunno con ruolo `segreteria`/`admin`/`coordinator` (`enqueueNotifiche`, `bufferMin:0`) **e** ai **genitori** dell'alunno (`enqueueNotifichePerAlunni`, `bufferMin:0`). Un errore di notifica **non invalida** il Panic Alert salvato. *(Il blocco-uscita UI + banner genitore + clear-con-audit restano slice sequenziati.)*
- **Impatto PRD:** §Presenze (Panic Alert) + §6 Stato.
- **Alternative scartate:** notifica solo Segreteria (il genitore deve essere allertato); risoluzione genitori via `student_parents` (incoerente con il resto delle notifiche primaria, che usano `legame_genitori_alunni` — allineamento rinviato a P0/rollout).

### 2026-06-26 — DL-017 — [Fase P3] Fatturazione Elettronica = integrazione REALE Aruba (REST), niente mock
- **Contesto:** il modulo Fatturazione (Aruba/SDI) era **1/11** — `src/lib/aruba/client.ts` era uno **stub** che restituiva sempre un esito `MOCK-…` "emessa", senza alcuna chiamata di rete. La P3.1 (slice "Aruba a sé") chiude la lacuna più compliance-critica.
- **Decisione:** sostituire lo stub con un **client REST reale** verso le API Aruba "Fatturazione Elettronica" (Bearer token: `POST /auth/signin` grant_type=password → access/refresh; `POST /services/invoice/upload` con `dataFile` base64; `GET /services/invoice/out/getByFilename` per stato/PDF). Credenziali **mai esposte al client**: username dal config, password risolta lato server da `process.env` via `password_ref` (env/vault). Ambiente DEMO/PROD da `aruba_config.ambiente`. Se Aruba non è configurato/credenziali assenti l'emissione ritorna **503 esplicito** (non più "successo finto"). Tutto il core è **TDD** mockando il boundary HTTP; la verifica live end-to-end con lo SDI resta **gated** sulle credenziali Aruba (DEMO per i test, PROD per l'esercizio) del committente — dipendenza esterna documentata (come SIDI in P5).
- **Impatto PRD:** §Fatturazione Elettronica (Aruba) §2/§5 + §Impostazioni §5.3 + §6 Stato. File: `src/lib/aruba/{client,fatturapa-xml,stato,emissione}.ts`, `src/app/api/pagamenti/fattura/{route,sync/route}.ts`, migrazione `20260741_aruba_fatturazione.sql`.
- **Alternative scartate:** mantenere il mock (non chiude i gap); integrazione reale "a scatola chiusa" senza confine testabile (non verificabile né TDD).

### 2026-06-26 — DL-018 — [Fase P3] Profilo fiscale FatturaPA = B2C privati (FPR12, IVA 0% Natura N4, no bollo)
- **Contesto:** gli intestatari fattura sono **persone fisiche** (genitori), non titolari di P.IVA/SDI; servizi scolastici esenti.
- **Decisione:** tracciato `FatturaElettronicaPrivati` **FPR12**, `TipoDocumento` **TD01**, `CodiceDestinatario` **0000000** (recapito via SDI nel cassetto fiscale, nessuna PEC per il privato). Regole fisse: **IVA 0% / Natura N4** "esente art. 10 DPR 633/1972", **nessuna marca da bollo**. `IdTrasmittente` = **Aruba PEC `01879020517`** (obbligatorio sul canale API, altrimenti errore 0094). `CedentePrestatore` dai dati fiscali scuola (`aruba_config.fiscal` + `RegimeFiscale`), `CessionarioCommittente` dall'intestatario (`alunni.intestatario_fatture.adult_id` → `parents`: CF, nome/cognome, residenza). Generatore XML in-house (`src/lib/aruba/fatturapa-xml.ts`), golden-file testato.
- **Impatto PRD:** §Fatturazione Elettronica §3/§4. **Alternative scartate:** FatturaPA PA (FPA12, ente pubblico — qui il cedente è privato); applicare IVA/bollo (contrario al regime esente scolastico).

### 2026-06-26 — DL-019 — [Fase P3] Numerazione interna per (scuola, anno fiscale)
- **Contesto:** il PRD §4 cita "numerazione delegata ad Aruba"; via **API `upload`** però il `<Numero>` deve già essere nell'XML (l'auto-numerazione è solo del pannello web Aruba).
- **Decisione:** Kidville genera una **sequenza monotòna per (scuola, anno)** persistita in `fatture_numerazione` via funzione `prossimo_numero_fattura()` (upsert con lock riga, `SECURITY DEFINER`, EXECUTE revocato ad anon/authenticated → solo `service_role`); il numero è scritto in `fatture_emesse.numero` e nell'XML. Lo **SDI assegna l'IdentificativoSDI** lato Aruba (memorizzato come `aruba_filename`/`fattura_aruba_id`). **Riconcilia** (e supera per il canale API) la dicitura PRD "delegata ad Aruba".
- **Impatto PRD:** §Fatturazione Elettronica §4 (annotato). **Alternative scartate:** lasciare la numerazione ad Aruba via API (non supportato dall'endpoint upload).

### 2026-06-26 — DL-020 — [Fase P3] Scarti SDI via polling cron + notifica realtime Segreteria + copia cortesia PDF
- **Contesto:** Aruba elabora in modo **asincrono** (entro 24h); lo stato SDI (scarto/consegna) arriva dopo l'upload. Requisito PRD §5: intercettare gli **scarti SDI** con motivo + alert Segreteria; copia di cortesia PDF per il genitore.
- **Decisione:** endpoint **service-to-service** `POST /api/pagamenti/fattura/sync` (gate `x-cron-secret`, pattern `push/dispatch`) schedulato via **pg_cron** (`fatture-sdi-sync`, ogni 30′, `pg_net` con GUC `app.fattura_sync_url`/`app.cron_secret`). Per ogni fattura non terminale interroga Aruba e mappa gli stati 1..10 sullo stato interno (`src/lib/aruba/stato.ts`): validi-SDI (6/7/8/10) → **emessa**; scarti (2 errore, 4 NS, 9 rifiuto) → **scartata**; in volo (1/3/5) → **in_attesa**. Su scarto **accoda notifica realtime** allo staff del plesso (`enqueueNotifiche` P1, tipo `fattura_scartata`) + **banner** su `/admin/pagamenti`. Su stato valido recupera il **PDF di cortesia** (`includePdf`) e lo salva nel bucket privato `fatture` (servito al genitore da `GET /api/pagamenti/fattura` con fallback all'anteprima). Stato pagamento UI: `in_attesa` → "In attesa SDI", `emessa` → download.
- **Impatto PRD:** §Fatturazione Elettronica §5 + §6 Stato. **Alternative scartate:** webhook Aruba (più complesso da accreditare; polling riusa l'infra cron esistente); attesa sincrona (Aruba è asincrona entro 24h).

### 2026-06-26 — DL-021 — [Fase P3] Sospensione account moroso = soft per-alunno (no login block)
- **Contesto:** la "sospensione manuale account moroso" (PRD §Pagamenti §3.2: "inibizione delle funzioni app", azione consapevole della **Direzione**) e la "persistenza visiva con account sospeso" (DL-013) richiedevano un meccanismo inesistente.
- **Decisione:** flag **per-alunno** su `alunni` (`sospeso` + `sospeso_motivo`/`sospeso_il`/`sospeso_da`, migr. `20260742`), impostato solo dalla **Direzione** (`POST /api/admin/pagamenti/sospensione`, `requireStaff(['admin','coordinator'])` + scope tenant + audit `logScrittura`). La sospensione è **soft**: il genitore **accede e legge** (presenze/diario/comunicazioni/pagamenti restano visibili — sicurezza del minore preservata), vede un **banner** "account sospeso per morosità" (`StoricoPagamenti`) + badge admin (`PaymentsDashboard`); le **azioni di servizio** sono inibite tramite guard riusabili `src/lib/pagamenti/sospensione.ts` (`assertAlunnoNonSospeso`/`assertGenitoreNonSospeso`). *Enforcement applicato:* nuove **firme/compilazioni moduli** (`POST /api/forms/send-otp` → 403). **Giustifiche/comunicazioni/diario NON bloccati** (child-safety): raffinamento dichiarato di "inibizione funzioni app"; il guard è pronto per estendere ad altre azioni commerciali.
- **Impatto PRD:** §Pagamenti §3.2/§4, §Primaria Valutazione (chiude il rinvio DL-013), §6 Stato. **Alternative scartate:** blocco di login (blocca info di sicurezza sul minore); flag per-genitore (la morosità è per-alunno; il guard genitore deriva comunque dai figli).

### 2026-06-26 — DL-022 — [Fase P3] Vista genitore pagamenti raggruppata per categoria
- **Contesto:** PRD §4.1 chiede la categorizzazione (Rette/Iscrizione/Mensa/Divisa/Materiale); la UI mostrava un elenco piatto Da pagare / Pagati.
- **Decisione:** raggruppamento per `payment_categories` con helper **puro** `raggruppaPerCategoria` (`src/lib/pagamenti/categorie.ts`, golden-tested): un gruppo per categoria (icona/colore), "Altro" in coda, split da-pagare/pagati interno. `StoricoPagamenti` consuma il payload `/api/pagamenti` (già con `payment_categories`).
- **Impatto PRD:** §Pagamenti §4.1 + §6 Stato. **Alternative scartate:** tab per categoria (più click; le sezioni in colonna sono più leggibili su mobile).

### 2026-06-26 — DL-023 — [Fase P3] Ricevuta locale non fiscale, distinta dalla fattura elettronica
- **Contesto:** PRD §3.1 cita "Invia Fattura/Ricevuta"; serviva una ricevuta scaricabile anche quando non si emette la fattura elettronica Aruba.
- **Decisione:** `GET /api/pagamenti/ricevuta?pagamento_id=` genera una **ricevuta PDF non fiscale** (jsPDF) per qualunque pagamento **saldato**, con scoping staff/genitore; indipendente da Aruba e dallo stato `fattura_stato`. UI: pulsante "Ricevuta" sul pagamento saldato (`StoricoPagamenti`), affiancato al "Fattura" (quando emessa).
- **Impatto PRD:** §Pagamenti §3.1/§4 + §6 Stato. **Alternative scartate:** riusare il PDF Aruba (è il documento fiscale, non sempre disponibile/voluto).

### 2026-06-26 — DL-024 — [Fase P3] Logica condizionale form: singola condizione, valutata a runtime
- **Contesto:** `FormField.condition` esisteva nello schema ma **non veniva mai valutata** — il wizard mostrava tutti i campi e l'editor non la configurava (condizioni "morte").
- **Decisione:** mantenuto il modello a **singola condizione** per campo (backward-compatible, niente migrazione). Motore **puro** `src/lib/forms/conditional.ts` (`valutaCondizione`/`campoVisibile`/`campiVisibili`/`pulisciNascosti`), operatori `eq/neq/contains/gt/lt`. **Runtime:** `StepRenderer` filtra i campi visibili (`useWatch`); `WizardContainer` valida solo i visibili (un campo nascosto, anche obbligatorio, non blocca) e **rimuove i valori nascosti** dalla submission. **Editor:** `PropertiesPanel` con toggle + select campo/operatore/valore (`campiDisponibili` dalla builder page). 10 test golden sul motore.
- **Impatto PRD:** §Form §4.1 (Form Builder) + §6 Stato. **Alternative scartate:** multi-condizione AND/OR (estende schema + editor; rimandata a una sotto-slice successiva).

### 2026-06-26 — DL-025 — [Fase P3] Delibera ammissioni (auto soglia+posti) + applicazione scoring; ETL deferito
- **Contesto:** mancavano lo **stato di ammissione** (ammesso/non/lista) e l'export delibera. Inoltre la migrazione `20260528` (scoring + ETL) **non era applicata in live** (assenti `score`/`manual_adjustments` su `form_submissions`) → le graduatorie non potevano funzionare.
- **Decisione:** (1) **Applicata la parte SCORING** di 20260528 (migr. `20260743`): colonne `score`/`manual_adjustments`, calcolo (`calc_form_base_score`/`calc_manual_delta` con `search_path` fisso), trigger BEFORE, indice, backfill → graduatorie operative. (2) **Esito ammissione** su `form_submissions` (`esito_ammissione` CHECK ammesso/lista_attesa/non_ammesso + `esito_il`/`esito_da`/`esito_note`). (3) **Motore puro** `src/lib/forms/delibera.ts` (`calcolaDelibera`): top-N sopra soglia = ammessi, sopra soglia oltre i posti = lista d'attesa, sotto soglia = non ammessi. (4) `POST /api/forms/delibera` (bulk per `modelId`+posti+soglia, e override singolo `submissionId`+esito) gated `requireStaff`. (5) **Export PDF** `GET /api/forms/export/delibera`. (6) UI `RankingTable`: badge esito + barra delibera (posti/soglia/applica/Esporta PDF) + override nel modale. 13 test.
- **⚠️ ETL deferito:** il trigger **ETL form→anagrafiche** di 20260528 è stato **escluso** perché referenzia tabelle **inesistenti in live** (`adults`/`student_adults` vs `parents`/`student_parents`, drift) — applicarlo romperebbe il completamento dei moduli d'iscrizione. Va riscritto sulle tabelle reali in una slice dedicata.
- **Impatto PRD:** §Form §4.1 (Scoring/Graduatorie) + checklist `/admin/forms/rankings` + §6 Stato. **Alternative scartate:** delibera solo manuale (la soglia+posti è il requisito); applicare l'ETL così com'è (romperebbe le iscrizioni).

### 2026-06-26 — DL-026 — [Fase P3] Fix ETL form→anagrafiche: `adults`/`student_adults` → `parents`/`student_parents`
- **Contesto:** il trigger `fn_form_submission_etl` (migr. 20260528) inseriva in `adults`/`student_adults` — **tabelle inesistenti in live** → al completamento di un modulo d'iscrizione sarebbe fallito (per questo era stato **deferito** in DL-025).
- **Decisione:** riscritto sulle tabelle **reali** (migr. `20260744`): **parents** (`id gen_random_uuid()`, nessuna FK ad auth → le pre-iscrizioni hanno `auth_user_id` NULL; upsert su `fiscal_code`), **alunni** (guard sui NOT NULL `nome`/`cognome`/`data_nascita`; match su `codice_fiscale` o `nome+cognome+data`; `scuola_id` default), **student_parents** (PK `(student_id,parent_id)`, `ON CONFLICT DO NOTHING`). I `db_mapping` sono raccolti in JSONB per-tabella e **tradotti** sulle colonne reali (`address→residence_address`, `phones→phone_numbers` come ARRAY, `birth_place→birth_city`); l'INSERT legge **solo colonne esistenti** (chiavi extra ignorate). Gestisce sia i prefissi `adults.*` (preset del builder) sia `parents.*` (template iscrizione). **Best-effort** (gli errori anagrafici non bloccano il completamento del modulo). **Verificato con dry-run d'integrazione sul DB live** (alunno+genitore+legame creati, wrapping ARRAY e traduzioni corretti) e poi ripulito.
- **Impatto PRD:** §Form §4.1 (ETL form→anagrafiche) + §Anagrafica + §6 Stato. Completa il deferral di DL-025.
- **Alternative scartate:** ETL applicativo in TS (il trigger DB garantisce coerenza transazionale al completamento); legare `parents.id` ad `auth.users` (le pre-iscrizioni non hanno ancora un account).

### 2026-06-26 — DL-027 — [Fase P3] Certificato medico self-service: upload genitore → validazione Segreteria
- **Contesto:** la tabella `certificati_medici` (20260526) **non era applicata in live** (drift), con `caricato_da` FK ad `auth.users` e `giorni_coperti DATE[]` "popolati dall'insegnante"; le route erano **stub pre-auth** (`parent_id` hardcoded, nessun upload file, nessuno stato di validazione).
- **Decisione:** schema corretto (migr. `20260745`): copertura come **periodo** `data_inizio`/`data_fine`, **stato** (`in_validazione`/`validato`/`rifiutato`), `validato_da`/`validato_il`/`nota_validazione`; `caricato_da` **senza FK** (identità dalla sessione); **bucket privato** `certificati-medici` (dato sanitario) + RLS con staff-read. Il **genitore carica** (multipart: file→bucket + periodo) via `POST /api/parent/medical-certificates` (`requireUser` + scope `legame_genitori_alunni`) → stato `in_validazione`; la **Segreteria valida/rifiuta** via `PATCH /api/teacher/medical-certificates` (`requireStaff` + audit `logScrittura`, può correggere il periodo); **download scoped** `GET …/file` (staff o genitore collegato). UI: form upload genitore (file + dal/al) + modale di validazione staff (apri documento, Valida/Rifiuta + nota). Helper puro `periodoValido`/`isEsitoValidazione`. **Nessun sollecito automatico sui certificati** (scelta di prodotto esplicita).
- **Impatto PRD:** §Modulistica (certificato medico) + §6 Stato. **Alternative scartate:** `giorni_coperti` array (il periodo dal/al è più chiaro per un certificato); solleciti automatici (esclusi per scelta).

### 2026-06-26 — DL-028 — [Fase P3] Staff RBAC: gestione ruoli/sede/classi riservata alla Direzione
- **Contesto:** `utenti.ruolo` è testo libero e non esisteva alcun pannello per gestire il personale; PRD §Impostazioni §2 chiede la "Gestione Staff (RBAC)".
- **Decisione:** `GET/PATCH /api/admin/staff` **gated alla Direzione** (`requireStaff(['admin','coordinator'])`). Il PATCH aggiorna `ruolo`/`scuola_id`/`gradi` e **rimpiazza** le assegnazioni classi (`utenti_sezioni`), con **audit** `logScrittura` (`staff_rbac`). Ruoli **assegnabili**: `educator` (Docente)/`segreteria`/`cuoca`/`coordinator` (Direzione)/`admin` — **NON `genitore`** (helper puro `src/lib/auth/ruoli.ts`). **Self-lockout guard**: la Direzione non può cambiare il proprio ruolo. La **creazione di nuovi account** (provisioning auth) **non è in scope** (resta il flusso invito/credenziali DL-005). UI: pannello `/admin/staff` (lista + edit ruolo/sede/classi). Nessuna migrazione (tabelle esistenti).
- **Impatto PRD:** §Impostazioni §2 (Gestione Staff RBAC) + §6 Stato. **Alternative scartate:** consentire alla Segreteria di assegnare ruoli (rischio di escalation → ristretto alla Direzione); creare account auth in questo slice (separato, via invito).

### 2026-06-26 — DL-029 — [Fase P3] Blocchi Consensi & Allegati nel Form Builder + upload generico server-side
- **Contesto:** il Form Builder (Sistema A `form_models.schema`) aveva già il blocco `file` ma **nessun blocco Consensi**; PRD §Form §4.1 chiede i "Componenti Dinamici" inclusi **Consensi** e **Caricamento Allegati**. Esplorazione live: l'upload allegati nel wizard **autenticato** era **rotto** (`storage.objects` ha zero policy → bucket deny-by-default; il client browser è anon e non può scrivere), e anche l'insert submission non-firma falliva (RLS `form_submissions` richiede sessione Supabase Auth, assente nel modello identità app-level). La route `/api/admin/form-models` era **ungated**.
- **Decisione:** (1) Nuovo tipo campo **`consent`** (`FormField.text`/`link`/`link_label`): reso da `FieldRenderer` come testo+link+**una checkbox** (se obbligatorio il wizard blocca finché non spuntata), configurabile nel builder (palette "Consensi/Privacy" + `PropertiesPanel`). **1 blocco = 1 consenso**. (2) **Evidenza legale GDPR**: helper puro `src/lib/forms/consensi.ts` (`estraiConsensi`/`consensiObbligatoriMancanti`) → **snapshot** `{field_id,label,text?,link?,accepted,accepted_at}` archiviato in `form_submissions.consents_log` (migr. `20260746`), popolato server-side da `send-otp` e dal nuovo `POST /api/forms/submit` (path senza firma, service-role, sostituisce l'insert client rotto). Guard server-side: consenso obbligatorio non accettato → 400. (3) **Upload generico** `POST /api/forms/upload` (service-role, `requireUser` + rate-limit, validazione tipo/dimensione, `form_attachments/models/{modelId}/…`), cablato nel wizard autenticato (`StepRenderer`). (4) Rifinitura blocco **Allegati**: `accept`/`max_size_mb` configurabili. (5) **Gate** `requireStaff` su `POST/PATCH /api/admin/form-models`.
- **Sicurezza allegati:** **service-role + scoping app** (coerente con tutto l'app e con P0): bucket privati, accesso solo via endpoint server-role; **nessuna** policy `storage.objects`. La variante upload **pubblica** (token-scoped per modello pubblicato) è rimandata alla slice "Pubblica modello".
- **Impatto PRD:** §Form §4.1 (Componenti Dinamici, Caricamento Allegati) + §6 Stato. **Test:** `consensi.test.ts` (7), `forms-upload.test.ts` (5), `forms-submit.test.ts` (4), `form-models-gate.test.ts` (4), `forms-send-otp-consensi.test.ts` (2) — tutti verdi; advisors security+performance **0 ERROR**. **Alternative scartate:** policy RLS esplicite su `storage.objects` (introduce un modello d'accesso diverso dal resto dell'app); blocco Consensi multi-checkbox (valore/evidenza più complessi → 1-blocco-1-consenso); consenso registrato solo come boolean senza snapshot (debole come evidenza legale).

### 2026-06-26 — DL-030 — [Fase P3] Pubblica modello + link pubblico + config accessi + submission pubblica
- **Contesto:** PRD §Form §4.1 chiede "Pubblica modello" + "Configurazione Accessi (registrati / link pubblico)". I `form_models` (Sistema A, builder) non avevano stato di pubblicazione né link; la compilazione pubblica esisteva solo per l'iscrizione hardcoded (`/iscrizione` → `EnrollmentWizard`). `/admin/modulistica` gestisce il sistema **legacy** `forms_templates`, distinto.
- **Decisione:** colonne `published_at` (NULL=bozza), `public_token` (uuid unico **stabile** tra unpublish/republish), `access_mode` (`public`|`authenticated`, default `public`) su `form_models` (migr. `20260747`). `POST /api/admin/form-models/publish` (gated `requireStaff`): publish genera/riusa token + `published_at` → ritorna link `/m/{token}`; unpublish azzera `published_at` (token preservato). Pagina pubblica **`/m/[token]`** (server component, carica via service-role; `notFound` se non pubblicato; schermata "accesso riservato" se `authenticated` senza sessione) che rende `WizardContainer` in **modalità pubblica** (`publicToken`, anonimo, **firma OTP disattivata**). Endpoint **token-scoped** anonimi `POST /api/public/forms/[token]/submit` (valida pubblicato+`public`; guard consensi obbligatori→400; `completed`+`consents_log`) e `…/upload` (validazione tipo/dimensione, `form_attachments/public/{token}/…`). Middleware: `PUBLIC_PREFIXES += '/m','/api/public'`. Builder: pannello **Pubblica/Copia link** + toggle accesso; le fetch admin del builder inviano ora `x-user-id` (id admin dev `…555555555555`).
- **Submission pubblica = senza firma:** l'intake pubblico (iscrizioni/sondaggi) non usa OTP; la **firma** pubblica (raccolta email del firmatario) è rinviata alla slice firma congiunta. Sicurezza: token-scoped + service-role + rate-limit (coerente DL-029).
- **Impatto PRD:** §Form §4.1 (Configurazione Accessi) + §6 Stato. **Test:** `publish.test.ts` (5), `middleware-rules.test.ts` (esteso `/m`,`/api/public`), `form-models-publish.test.ts` (5), `public-forms-submit.test.ts` (5), `public-forms-upload.test.ts` (4) — verdi; advisors **0 ERROR**. **Alternative scartate:** rigenerare il token a ogni pubblicazione (romperebbe i link già condivisi → token stabile); riusare l'insert client-side per il pubblico (bloccato da RLS → endpoint server-role); pubblicare i `forms_templates` legacy (sistema distinto, in via di dismissione).

### 2026-06-26 — DL-031 — [Fase P3] Firma congiunta (2° firmatario) + reinvio OTP
- **Contesto:** PRD §Form §4.1 chiede "firma singola o congiunta di entrambi i genitori" + "reinvia OTP". `/api/forms/send-otp` gestiva **un solo** firmatario con completamento immediato; l'infra FEA P1 (slot `fea_signatures`, policy `all-required` DL-007, `ReceiptPayload.slots`) era già predisposta ma inutilizzata per i moduli.
- **Decisione:** colonna **`signature_mode`** (`single`|`joint`, default `single`) su `form_models` (migr. `20260748`), impostata dal builder quando lo schema contiene un blocco Firma. Helper puro `src/lib/fea/firma-congiunta.ts` (`firmatariRichiesti`/`firmaCompleta`/`prossimoSlot`). **`POST /api/forms/send-otp`** con `submissionId` = **reinvio/2° firmatario** (rigenera `otp_secret`, invia a `signerEmail` o all'email del `user_id`; NON crea una nuova submission). **`PATCH`** ora **slot-aware**: indice slot = #slot già firmati (`getSlots`), `recordSignerSlot(slotIndex, policy)` con `policy = joint? all-required : any-one`; carica `signature_mode` e completa (`status=completed`) **solo** quando `firmaCompleta(mode, firmati+1)` — altrimenti resta `pending_signature` e risponde `{ completed:false, needsMoreSigners:true, signedSlots, requiredSigners }`. **2° firmatario email-only** (slot `signer_user_id` null ammesso). UI `OtpSignatureModal`: bottone **"Reinvia codice"** (cooldown 30s) + step **"2° genitore"** (email → invio → verifica); il builder mostra il toggle **Firma singola/congiunta**.
- **Retro-compat:** senza `signature_mode` (default `single`) il flusso completa al 1° codice come prima — i test di caratterizzazione send-otp restano verdi.
- **Impatto PRD:** §Form §4.1 (Impostazioni FEA) + §6 Stato. **Test:** `firma-congiunta.test.ts` (4), `forms-send-otp-firma-congiunta.test.ts` (5: reinvio 404/ok, joint 1°→pending, joint 2°→completed, single→completed) — verdi (17 test send-otp totali); advisors **0 ERROR**. **Alternative scartate:** firma parallela con OTP simultanei ai due genitori (più complessa, rischio di codici incrociati → sequenziale); >2 firmatari (YAGNI); firma OTP sui form **pubblici** (rinviata: richiede raccolta strutturata dell'email del firmatario anonimo).

### 2026-06-26 — DL-032 — [Fase P3] Proxy upload cartaceo reale (modulistica)
- **Contesto:** PRD §Form (Gite) prevede l'acquisizione del modulo **cartaceo** firmato a penna consegnato a scuola. `POST /api/teacher/modulistica` era uno **stub**: accettava `file_path` come **stringa** (nessun upload reale su Storage), **ungated** (`teacher_id` dal body), `signature_log` ad-hoc. Il **merge PDF di classe** (`/api/admin/documents-merge` + `handleExportMergePDF`) esisteva già come report cumulativo.
- **Decisione:** riscrittura del POST come **upload reale multipart**: `requireDocente` (educator/admin/coordinator/segreteria), validazione tipo/dimensione, file salvato in `form_attachments/cartaceo/{form_id}/…` (service-role), sottomissione `forms_submissions` con `is_signed=true`, **`origine='cartaceo'`** (nuova colonna, migr. `20260749`, CHECK `online|cartaceo`), `pdf_path` reale, **evidenza strutturata** (`signature_log` `{method:'PROXY_CARTACEO', acquisito_da, ip, user_agent, timestamp, compliance}` — **non** finge una FES digitale) + **audit** `logScrittura('modulistica_cartaceo')`. UI teacher: il modal tiene il **File** reale e invia `FormData`. Il merge PDF marca **"(CARTACEO)"** vs "FES FIRMATA DIGITALMENTE".
- **Impatto PRD:** §Form (Widget Form/Gite) + §6 Stato. **Test:** `teacher-modulistica-proxy.test.ts` (5: 401/400×3/201 con upload `cartaceo/`+`origine`+audit) — verdi; advisors **0 ERROR**. **Sollecito firme docente:** resta un toast informativo (nessun cron automatico, per regola di prodotto). **Alternative scartate:** mantenere il path-stringa (nessuna prova del documento); gate `requireStaff` solo Segreteria (la maestra acquisisce alla porta → `requireDocente`); concatenare i PDF reali nel merge (richiede `pdf-lib`; il merge resta report cumulativo).

### 2026-06-26 — DL-033 — [Fase P3] Multi-Sede CRUD (registry scuole)
- **Contesto:** PRD §Impostazioni chiede "Gestione Multi-Sede (aggiungi/rinomina/disattiva, config isolata)". In live **non esisteva** una tabella sedi: lo `scuola_id` era un **UUID hardcoded** (`11111111-…`) usato come soft-reference in `sections`/`utenti`/`alunni` (1 sola sede).
- **Decisione:** creata la tabella registry **`scuole`** (migr. `20260750`: `id, nome, citta, indirizzo, attiva, config jsonb, timestamps`) con **seed** della sede esistente (`ON CONFLICT DO NOTHING`). `GET/POST/PATCH /api/admin/schools` **gated alla Direzione** (`requireStaff(['admin','coordinator'])`, coerente con Staff RBAC DL-028) per **aggiungi / rinomina / disattiva** (soft `attiva=false`, **non** hard-delete) + aggiornamento `config` isolata, con **audit** `logScrittura('multi_sede')`. Helper puro `src/lib/scuole/validate.ts` (`validaNomeScuola`/`normalizzaScuola`). UI `/admin/schools` + `SchoolsPanel` (lista, aggiungi, rinomina inline, toggle attiva), gate Direzione lato server, fetch con `x-user-id`.
- **Scope/sicurezza:** **nessuna FK** su `scuola_id` (additivo e sicuro; resta soft-reference — la migrazione dati/FK è rinviata). La tabella `scuole` eredita il modello del progetto (RLS auto-abilitata da `rls_auto_enable`, **nessuna policy** → accesso solo via endpoint service-role gated; advisor `rls_enabled_no_policy` di livello **INFO**, come tutte le tabelle esistenti). **Hard-delete di una sede** fuori scope (pericoloso → eventualmente via diritto all'oblio).
- **Impatto PRD:** §Impostazioni §1 (Gestione Multi-Sede) + §6 Stato. **Test:** `scuole-validate.test.ts` (5), `schools-route.test.ts` (9: gate GET/POST/PATCH, nome vuoto, 404, crea+rinomina+disattiva+audit) — verdi; advisors **0 ERROR**. **Alternative scartate:** aggiungere subito FK + migrazione dati su tutte le tabelle `scuola_id` (invasivo/rischioso → soft-reference); hard-delete sede nel CRUD (distruttivo → solo soft-disable); gate `['admin']` puro (allineato a "Direzione" DL-028 = admin+coordinator).

### 2026-06-27 — DL-034 — [Fase P3] GDPR diritto all'oblio (anonimizzazione)
- **Contesto:** PRD §Impostazioni chiede "diritto all'oblio / hard delete GDPR". L'alunno è referenziato in ~20 tabelle operative (FK) + file storage; esistono audit immutabili e registri fiscali con obblighi di conservazione.
- **Decisione (flusso a 2 passi, fissato con l'utente):** **(1)** lista candidati `GET /api/admin/gdpr/candidates` = `alunni` con `stato <> 'iscritto'` e `anonimizzato_il IS NULL` + genitori collegati (via `student_parents`); **(2)** `POST /api/admin/gdpr/erase` = cancellazione definitiva come **SOLA ANONIMIZZAZIONE** (nessuna DELETE di righe → zero rischio FK): i campi PII di `alunni` (e dei `parents` **orfani**, cioè senza altri figli iscritti) vengono sovrascritti con placeholder deterministico `CANCELLATO-{hash}` e marcati `anonimizzato_il` (migr. `20260751`); l'`auth_user_id` del genitore viene sganciato; i **file PII** del soggetto vengono rimossi dallo storage (binari non anonimizzabili) **escluso il bucket `fatture`**. **Preserva audit + fisco** (`audit_scritture_docente`/`fascicolo_accessi_audit`/`sblocchi_audit`/`registro_modifiche` e `pagamenti`/`fatture_emesse`): righe intatte, de-identificate perché l'anagrafica a cui puntano è anonimizzata (GDPR art.17(3)(b)). **Sicurezza:** **dry-run** (conteggi senza scrivere) + **doppia conferma** (`confirm` = `COGNOME NOME`, via `confermaValida`), **rifiuto** se l'alunno è ancora iscritto (409), gate **Direzione**, audit `logScrittura('gdpr_oblio')`. Helper puri `src/lib/gdpr/anonimizza.ts` (`placeholderFor`/`patchAlunno`/`patchParent`/`nomeConferma`/`confermaValida`) + `src/lib/gdpr/orfano.ts`. UI `/admin/gdpr` (`OblioPanel`): lista + modale con anteprima dry-run e campo di conferma.
- **Impatto PRD:** §Impostazioni (Diritto all'oblio) + §6 Stato. **Test:** `gdpr-anonimizza.test.ts` (6), `gdpr-erase-route.test.ts` (7: gate/404/iscritto-409/dryrun/conferma-errata/execute/orfano-vs-non), `gdpr-candidates-route.test.ts` (2) — verdi; advisors **0 ERROR**. **Alternative scartate:** hard-delete fisico delle righe (rischio FK su ~20 tabelle + perdita di prove/fisco → solo anonimizzazione, scelta utente); purgare anche il bucket `fatture` (viola la conservazione fiscale); cancellazione automatica senza dry-run/conferma (operazione irreversibile → doppia conferma); propagazione automatica al genitore anche se ha altri figli iscritti (→ solo orfani).

### 2026-06-27 — DL-035 — [Fase P0] Letture parent-facing via route server service-role (End-state X)
- **Contesto:** chiusura P0. Restavano 6 siti client che leggevano/scrivevano tabelle sensibili col **client anon del browser** (`getSupabase().from()`): `parent/modulistica` (legame/alunni/utenti), `teacher/gallery` (utenti.ruolo), admin form `RankingTable`/`SubmissionsTable`/`RankingAdjustModal` (form_models/form_submissions), `FieldRenderer` (storage upload). Prerequisito per il drop delle policy permissive (S9).
- **Decisione:** migrare tutte le letture a **route server gated + service-role + scoping applicativo** (NON a RLS `authenticated`/sessione; `PARENT_READS_USE_SESSION` resta `false`, le policy authenticated additive `20260722` restano dormienti = opzione S8 futura). Nuove route: `GET /api/me` (profilo proprio, senza segreti), `GET /api/admin/forms/{models,rankings,submissions}` (`requireStaff`), `PATCH /api/admin/forms/submissions/[id]` (`requireStaff`+audit); riuso `/api/parent/students` e `/api/forms/upload`. Gate di uscita: `grep getSupabase\(\) src/` → solo `auth/login` + 3 file realtime (`.channel()`), **zero** `.from()` su tabelle.
- **Impatto PRD:** §Trasversale §4 (identità/letture), §6 Stato. **Test:** `me-route.test.ts` (3), `forms-admin-routes.test.ts` (8) — verdi. **Scoperta:** `form_models`/`form_submissions` avevano GIÀ RLS `authenticated` (`is_staff_or_admin()`); la migrazione è difesa-in-profondità + funziona anche con header-identity. **Alternative scartate:** flip `PARENT_READS_USE_SESSION` ora (richiede sessioni genitore = onboarding); policy `authenticated` per-tabella (più complesso, rinviato a S8).

### 2026-06-27 — DL-036 — [Fase P0] Gate Segreteria+Direzione sulle mutazioni anagrafiche
- **Contesto:** `/api/admin/{students,parents,sections,iscrizioni}` erano **senza gate ruolo** (il middleware protegge le pagine `(dashboard)`, non le API route) → chiunque raggiungesse l'endpoint poteva mutare l'anagrafica.
- **Decisione:** `requireStaff(request)` (allowlist default `['admin','coordinator','segreteria']`) in testa a POST/PATCH/DELETE (e GET) delle 4 route; educatori/genitori esclusi. Refactor a `createAdminClient` unico (rimosso il client `@supabase/supabase-js` a livello modulo in `parents`).
- **Impatto PRD:** §Anagrafica §3, §Trasversale §5, §6 Stato. **Test:** in `admin-anagrafica-audit.test.ts`/`iscrizioni-import-audit.test.ts` (gate 403). **Alternative scartate:** `['admin','coordinator']` (solo Direzione) — bloccherebbe l'operatività reale della Segreteria; affidarsi al middleware (non copre `/api/`).

### 2026-06-27 — DL-037 — [Fase P0] Audit immutabile su ogni mutazione anagrafica
- **Contesto:** P0 richiede "audit log immutabile delle modifiche anagrafiche". Solo schools/staff/gdpr/sospensione loggavano; alunni/parents/sezioni/iscrizioni **no**.
- **Decisione:** `logScrittura()` (helper esistente, tabella append-only `audit_scritture_docente`, RLS solo INSERT/SELECT) dopo OGNI mutazione: `entitaTipo` ∈ {`alunni`,`genitori`,`legame`,`sezioni`,`graduatoria`,`iscrizione`}, con `valorePrima` (fetch pre-update) / `valoreDopo`. Per il bulk iscrizioni: una riga per entità creata (alunno/genitore/legame) + esito import.
- **Impatto PRD:** §Anagrafica §3, §6 Stato. **Test:** `admin-anagrafica-audit.test.ts` (14), `iscrizioni-import-audit.test.ts` (3), `forms-admin-routes.test.ts` PATCH — verdi. **Alternative scartate:** nuovo helper/tabella dedicata (riuso `logScrittura`, già immutabile e filtrabile da `GET /api/admin/audit`).

### 2026-06-27 — DL-038 — [Fase P0] Lockdown RLS in due tempi (S9a sicuro / S9b per-famiglia)
- **Contesto:** il DB aveva **~20 policy permissive** (`allow_all`/`TO anon`/`TO public USING(true)`) su tabelle di ogni modulo — RLS di fatto bypassata, **dati sensibili leggibili via anon key** (es. `allow_all_valutazioni` = voti alunni). **Scoperta chiave:** non tutte le route server usano service-role; molte usano il **client di sessione** (`createClient`, anon per header-identity) e DIPENDONO dalle permissive — un drop indiscriminato romperebbe diary/gallery/note/registro/locker.
- **Decisione (S9a, migr. `20260752`, applicata):** droppare le permissive solo sulle tabelle **provatamente service-role-only** (nessuna route nel set session-client): `avvisi`, `avvisi_risposte`, `task_interni`, **`valutazioni`**, `mensa_menu_config`, `mensa_class_menu_assignment`, `forms_submissions`, `forms_templates`. RLS resta **abilitata** (default-deny per anon/authenticated; service-role passa). `get_advisors(security)` = **0 ERROR**, WARN `always_true` 18→8. **(S9b, rinviato — runbook in `P0_ROLLOUT_CHECKLIST.md`):** `eventi_diario`/`note_disciplinari`/`registro_orario`/`firme_docenti`/`galleria_media_v2`/`locker_config`/`schools`/`alunni` richiedono PRIMA la migrazione della route session-client → service-role (route dei moduli P2/P4); `chat_messages`/`chat_threads` (realtime) richiedono l'onboarding genitori (vedi DL-039). **pagamenti/incassi realtime: già coperti da policy S7, nessuna azione.**
- **Impatto PRD:** §Trasversale §4 (RLS produzione), §6 Stato. **Alternative scartate:** drop di tutte le permissive subito (romperebbe la prod via i client di sessione → split S9a/S9b); flip `PARENT_READS_USE_SESSION` (richiede onboarding).

### 2026-06-27 — DL-039 — [Fase P0] Revoca `exec_sql` da anon/authenticated + hardening funzioni
- **Contesto:** `public.exec_sql(text)` (SECURITY DEFINER) era **eseguibile da `anon`/`authenticated`** via `/rest/v1/rpc/exec_sql` → **SQL arbitrario dal public API** (buco critico). 12 funzioni avevano `search_path` mutabile.
- **Decisione (migr. `20260752`):** `REVOKE ALL ON FUNCTION exec_sql(text) FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE … TO service_role` (le route admin di migrazione girano service-role → restano funzionanti); `ALTER FUNCTION … SET search_path = public, pg_temp` su 12 funzioni segnalate. **Verifica:** `exec_sql` non più nell'elenco advisor "anon/authenticated executable"; 0 ERROR.
- **Impatto PRD:** §Trasversale §4 (sicurezza DB) + §6 Stato. **Alternative scartate:** drop di `exec_sql` (lo usano `/api/admin/apply-migration` via service-role → solo revoca dai ruoli pubblici); revocare anche `is_staff_or_admin` (usata nelle policy RLS di form_* → lasciata, solo search_path).

### 2026-06-27 — DL-040 — [Fase P4] Diario 0-6 · slice D1 (cattura + notifica + lockdown S9b)
- **Contesto:** prima slice di P4 (moduli 0-6). Stato: push parent bufferizzato pronto ma non agganciato al diario; filtro presenti già nell'endpoint (`/api/diary/students?onlyPresent=true`); "Entrata" rimossa dal Diario; `nota_libera` in schema + mostrata al genitore ma senza input docente; nessun bulk "Nanna"; gli accessi `eventi_diario` usavano il client di **sessione** (blocco S9b).
- **Decisioni (fissate con l'utente):** **(1)** Push genitore per aggiornamento diario = **1 per figlio** (no spam per-evento), con **buffer 10' + debounce** (`enqueueDiarioGenitori`: elimina la notifica diario pending del figlio e ri-accoda → la finestra di modifica è il buffer stesso). **(2)** **"Entrata" read-only dalle Presenze** (`/api/diary/checkin` → `presenze.orario_entrata`), nessun evento `eventi_diario` duplicato. **(3)** filtro **solo Presenti** di default in UI docente + toggle "Tutti"; **(4)** bulk **"Nanna per tutti"** (orario inizio = ora); **(5)** input **nota libera** docente (`nota_libera` nel payload). **(6) Lockdown S9b Diario:** migrati TUTTI gli accessi `eventi_diario` di `/api/diary/entries` a **service-role** (End-state X, DL-035) — `educator-sections`/`wipe` già admin, `debug-supabase` sigillato — poi **DROP** `eventi_diario_insert_anon/_select_anon/_update_anon` (migr. `20260753`). RLS resta abilitata (resta la policy genitore additiva `authenticated`; anon = default-deny).
- **Rinviato a S13/onboarding:** lo **scoping di proprietà** del ramo genitore (un genitore solo i propri figli): finché l'identità è via header (spoofabile) il gate non aggiunge sicurezza reale e romperebbe l'accesso demo (verificato: `DEV_PARENT_ID` non possiede l'alunno demo di default); la lettura passa comunque via service-role.
- **Rinviato a D2:** traduzione voci routine (i18n), dashboard monitoraggio Segreteria, riconciliazione `eventi_diario`/`daily_routines`, auto-fill quantità portate.
- **Impatto PRD:** §Diario 0-6 + §6 Stato. **Test:** `diario-notifiche.test.ts` (3: debounce/buffer/no-genitori), `diary-entries-scope.test.ts` (2: ramo genitore service-role + gate docente) — verdi; full suite **375 verdi**; advisors **0 ERROR** (WARN `eventi_diario` azzerati). **Alternative scartate:** push per-evento (spam → 1/figlio); ripristino evento `entrata` nel Diario (duplica il check-in di Presenze → read-only da Presenze); gate proprietà subito (rompe la demo header-identity → S13).

### 2026-06-27 — DL-041 — [Fase P4] Galleria · slice G1 (Privacy Lock server-side + lockdown S9b)
- **Contesto:** modulo Galleria. Già fatti (verificato): broadcast istituzionale, cancellazione globale admin, interconnessione Diario, e il **Privacy Lock in UI** (`StudentTagger` impedisce di selezionare alunni senza `consenso_privacy`). Mancava l'**enforcement server-side**: `POST/PATCH /api/gallery` accettavano qualsiasi `tag_students[]`. Colonna `alunni.consenso_privacy` **esiste** in prod (40/128 con consenso). **Scoperta:** TUTTI gli accessi a `galleria_media_v2` sono già service-role (il client di sessione in `gallery/route.ts` serve solo `auth.getUser()`), quindi il lockdown S9b non richiede migrazione route (smentita la mia euristica P0 che lo classificava session-blocked).
- **Decisione (fissata con l'utente):** **Privacy Lock invalicabile lato server** — se la foto NON è broadcast, ogni alunno in `tag_students` deve avere `consenso_privacy=true`; altrimenti **422 con i nomi** (rifiuto netto, no strip silenzioso). Helper puro `studentiSenzaConsenso` + async `alunniSenzaConsenso` (`src/lib/gallery/privacy.ts`), applicato in POST e in PATCH (sui tag EFFETTIVI dopo l'update, copre anche lo spegnimento del broadcast). **Lockdown S9b:** **DROP** `galleria_media_v2."Allow all for service role"` (migr. `20260754`); RLS resta abilitata, anon = default-deny, service-role passa.
- **Impatto PRD:** §Foto/Video (Galleria) + §6 Stato. **Test:** `gallery-privacy.test.ts` lib (5) + api (4: 422 con nome/201 consenso/broadcast bypass/403) — verdi; full suite **384 verdi**; advisors **0 ERROR** (WARN `galleria_media_v2` azzerato). **Alternative scartate:** strip silenzioso dei non-consenzienti (il docente non si accorge → rifiuto 422); migrare le route a session-client per la RLS (inutile: già tutte service-role → solo drop).

### 2026-06-27 — DL-042 — [Fase P4] Comunicazione · slice C1 (traduzione automatica chat)
- **Contesto:** PRD §Comunicazione chiede "traduzione automatica" chat insegnante↔famiglie straniere (requisito chiave mancante). Nel repo nessuna integrazione LLM/traduzione e nessuna chiave nel `.env.local`.
- **Decisione (fissata con l'utente):** traduzione on-demand via **Claude API** (modello **`claude-haiku-4-5`**, economico/veloce — consultata la reference `claude-api`), **gated su `ANTHROPIC_API_KEY`** (dipendenza esterna come Aruba/SDI): se la chiave manca il servizio ritorna `disabled` e l'UI nasconde il pulsante. Servizio `src/lib/translate/claude.ts` (`translateText`, client SDK ufficiale `@anthropic-ai/sdk`, client iniettabile per i test); endpoint `POST /api/chat/translate` (`requireUser` + rate-limit anti-abuso, 503 se disabilitato); UI: pulsante **"Traduci"** sotto ogni messaggio IN ARRIVO in `ChatMessageArea` (target = lingua del dispositivo `navigator.language`, toggle mostra/nascondi, traduzione mostrata sotto l'originale). *(Drop S9b chat realtime = onboarding, separato.)*
- **Impatto PRD:** §Comunicazione + §6 Stato. **Test:** `translate-claude.test.ts` (4: disabled/empty/traduce-con-model-haiku/errore-non-lancia), `chat-translate.test.ts` (4: 401/400/200/503) — verdi; full suite **392 verdi**; tsc 0 errori. **Alternative scartate:** provider esterno DeepL/Google (Claude più naturale per il progetto); raw `fetch` invece dell'SDK ufficiale (la reference impone l'SDK quando esiste); traduzione automatica su ogni messaggio (costo → on-demand 1 tap); `thinking`/`effort` su haiku (non supportati/non necessari per una traduzione).

### 2026-06-27 — DL-043 — [Fase P4] Mensa · slice M1 (icona pericolo allergeni genitore)
- **Contesto:** §Mensa chiede "alert incrociato anagrafica + icona pericolo personalizzata genitore". L'infra allergeni 14 UE è già completa (allergeni per portata su `mensa_menu_rotazione`, `alunni.allergeni`, job cuoca/segreteria `controllaAllergie` + cron `mensa_check_allergie_giornaliero`); mancava il **lato genitore**.
- **Decisione (autonoma):** `GET /api/parent/mensa/allergie?alunno_id=&date=` (`requireUser`, service-role) che **riusa gli helper puri già testati** (`allergeniAlunno`, `resolveMenuGiorno`, `conflittiAllergie`) per incrociare gli allergeni del figlio col menù del giorno → `{ conflitti, conflitti_label, dettaglio (portate), pericolo }`. UI: **banner pericolo** rosso nella pagina mensa genitore quando `pericolo` (mostra gli allergeni in conflitto).
- **Impatto PRD:** §Mensa + §6 Stato. **Test:** `parent-mensa-allergie.test.ts` (5: 401/400/pericolo-glutine/no-allergeni/mensa-chiusa) — verdi; full suite **400 verdi**; tsc 0 errori. **Alternative scartate:** ricalcolare la logica conflitti nell'endpoint (riuso degli helper puri); isolamento interfaccia Cuoca come prima slice (meno safety-critical della cross-allergeni genitore → sequenziato).

### 2026-06-27 — DL-044 — [Fase P4] Armadietto · S9b lockdown `locker_config`
- **Contesto:** il flusso richiesta materiale→**chiusura ciclo** è già presente (`/api/locker/requests` PATCH `acknowledged`/`fulfilled` + `preso_in_carico_il`). L'unico accessor di `locker_config` (`/api/locker/materials`) usava però il **client di sessione** → blocco S9b residuo.
- **Decisione (autonoma):** migrata `/api/locker/materials` a **service-role** (gate `requireDocente` + scope `assertClasseNomeInScope` + audit `logScrittura('armadietto_config')` invariati); **DROP** delle 2 policy permissive `auth_gestisce_locker_config` (ALL authenticated true) + `tutti_leggono_locker_config` (SELECT public), migr. `20260755`. Resta solo `service_role_locker_config` (esclusa dal lint). `get_advisors` 0 ERROR.
- **Impatto PRD:** §Armadietto + §6 Stato + `P0_ROLLOUT_CHECKLIST` (spunta `locker_config`). **Test:** full suite **400 verdi**, tsc 0 errori. **Alternative scartate:** aggiungere subito carico-merci/dashboard-inadempienze (feature ampie → sequenziate; la slice chiude il residuo P0).

### 2026-06-27 — DL-045 — [Fase P4] Anagrafica · onboarding genitore (primo accesso) — capstone S13
- **Contesto:** §Anagrafica chiede "onboarding genitore (`/onboarding`: primo accesso, password/PIN, consensi GDPR)". `/onboarding` era già occupato (redirect a `/iscrizione` pubblica) → nuova pagina **`/parent/onboarding`**. È il **prerequisito ingegneristico di S13**: dà al genitore una sessione reale.
- **Decisione (autonoma):** migr. `20260756` (`parents.onboarded_at` + `consensi_gdpr` jsonb); helper puro `consensiMancanti` (`CONSENSI_RICHIESTI=['privacy']`); `POST /api/parent/onboarding` (`requireUser`): **422** se consensi obbligatori mancanti, **400** se password <8, registra `consensi_gdpr`+`onboarded_at` su `parents`, e **aggiorna la password Supabase Auth** (`admin.auth.admin.updateUserById`) se il genitore è bindato (`auth_user_id`); pagina `/parent/onboarding` (password + checkbox consenso privacy GDPR). **Il flip S13** (`ALLOW_HEADER_IDENTITY='false'`) **resta operativo** (richiede l'onboarding di massa dei genitori reali — fuori da una sessione di codice).
- **Impatto PRD:** §Anagrafica §3 + §Trasversale (identità) + §6 Stato. **Test:** `onboarding-consensi.test.ts` (4), `parent-onboarding.test.ts` (5: 401/422/400/200-record/200-password) — verdi; full suite **406 verdi**; tsc 0 errori. **Alternative scartate:** sovrascrivere `/onboarding` (è il redirect all'iscrizione pubblica → `/parent/onboarding`); PIN dispositivo come primario (la password Supabase Auth è il meccanismo di sessione; PIN rinviato).

### 2026-06-27 — DL-046 — [Fase P0] Completamento lockdown RLS S9b (drop di TUTTE le policy permissive)
- **Contesto:** restavano permissive su `note_disciplinari`/`registro_orario`/`firme_docenti`/`schools` (in realtà già service-role: le route le leggevano via `createAdminClient`, `createClient` solo per `auth.getUser()` — euristica import era falso positivo), su `alunni` (`alunni_select_anon`, ancora letta in sessione da 4 route) e su `chat_messages`/`chat_threads` (realtime anon).
- **Decisione (autonoma):** **Wave 1** (migr. `20260757`) drop `note_disciplinari`/`registro_orario`/`firme_docenti`/`schools` (già service-role). **Wave 2** (migr. `20260758`): migrate a service-role gli ultimi lettori session-client di `alunni` (`attendance/monthly`, `diary/students`, `locker/requests`, `locker/inventory`) → drop `alunni_select_anon` (resta la policy genitore additiva). **Wave 3** (migr. `20260759`): **realtime RLS chat** — policy `authenticated` partecipante su `chat_messages`/`chat_threads` (`teacher_id`/`parent_id = auth.uid()` o genitore via `parents.auth_user_id`) + drop permissive. **Risultato:** `pg_policies` con `qual='true'` su anon/public/authenticated-ALL = **0** → **lockdown RLS S9b COMPLETO**. `get_advisors` 0 ERROR; restano solo advisory standard Supabase (pg_net in public, SECURITY DEFINER `is_staff_or_admin`/`current_parent_student_ids` necessarie alla RLS, leaked-password = toggle dashboard).
- **Nota realtime:** la chat **live** ora richiede sessione (authenticated); l'anon header-identity non onboardato non riceve più il push live (la cronologia resta via `/api/chat/messages` service-role). Reversibile (`CREATE POLICY`).
- **Restano OPERATIVI (non codice):** **S13** `ALLOW_HEADER_IDENTITY='false'` (env, da flippare dopo l'onboarding di massa) + invio credenziali genitori. **Test:** full suite **406 verdi**; tsc 0 errori. **Alternative scartate:** migrare anche `is_staff_or_admin`/`current_parent_student_ids` (servono alla valutazione RLS per authenticated → lasciate); toccare le funzioni cron (`notifiche_dispatch_tick`/`mensa_check_allergie_giornaliero`) (rischio rottura cron per WARN minore).

### 2026-06-27 — DL-047 — [Fase P5] Certificato delle Competenze (D.M. 14/2024, classe quinta)
- **Contesto:** il Certificato delle Competenze di fine primaria (PRD §Interoperabilità §5) era **totalmente assente** (nessuna tabella, generatore PDF o UI), pur essendo un adempimento di legge (D.M. 14 del 30/1/2024) e un documento di valore reale per le famiglie **indipendente dall'accreditamento SIDI**.
- **Decisione:** build **completo incl. firma FEA**. Tabelle `certificati_competenze` + `certificato_competenza_livelli` (migr. `20260760`, RLS default-deny). Modello statutario puro `src/lib/competenze/modello.ts` (8 **competenze chiave europee** + scala a **4 livelli A/B/C/D** — NB il 4° del certificato è «Iniziale», distinto dalla scala pagella O.M.172/2020 «In via di prima acquisizione»). Precompilazione euristica dei livelli dai giudizi di scrutinio (`livello-mapping.ts`, sovrascrivibile). Generatore PDF `certificato-pdf.ts` (riusa lo stile `buildPagellaPdf`, legenda 4 livelli + firma applicativa). Store `certificato-store.ts`: `validaScrutinioFinaleClasseQuinta` (gate livello-5 primaria + scrutinio chiuso → 422/409), `seedCertificato` (bozza idempotente su `(alunno, anno)`), `generaCertificato` → PDF su bucket privato + `stato='firmato'` + **slot FEA dirigente** (`recordSignerSlot` policy `any-one`, DL-007) + `logFeaEvent`. Route: `GET/POST/PATCH /api/admin/competenze` (seed/edit, gate Direzione), `POST /api/admin/competenze/genera` (genera+firma, **dirigenza** `['admin','coordinator']`), `GET /api/admin/competenze/download`, `GET /api/parent/competenze` (scope figlio, solo generato/firmato). UI `/admin/competenze` (editor livelli + genera/scarica) + card download nella pagina pagelle genitore.
- **Impatto PRD:** §Interoperabilità §5 → implementato; §6 Stato nuova riga; checklist pulsanti «Scarica certificato delle competenze». **TDD:** 17 test (modello/mapping/PDF/store/route/scope).
- **Alternative scartate:** auto-derivare i livelli dai voti senza intervento docente (l'attribuzione è un atto del team docente → solo suggerimento); firma OTP genitore (il certificato è atto del dirigente → firma applicativa dirigente come la pagella).

### 2026-06-27 — DL-048 — [Fase P5] Numero domanda iscrizione SIDI + import ZIP ministeriale
- **Contesto:** PRD §Interoperabilità §2: ricezione `.zip` SIDI senza rinomina, matching/dedup su **Numero di domanda**, sync genitori per CF. Non esisteva alcun campo `numero_domanda` né parser ZIP (jszip assente).
- **Decisione:** parser **pluggable su schema assunto** (deciso col committente: nessun campione SIDI reale disponibile). Campo `alunni.numero_domanda_sidi` + indice unico parziale per scuola + staging `sidi_import_batches` (migr. `20260762`, RLS default-deny). `src/lib/sidi/zip-parser.ts` (jszip; manifest `domande.csv`/`domande.json`; `normalizeSidiRow` = **unico punto sostituibile** al tracciato vero). `import-apply.ts` `applySidiRecords`: matching ① numero domanda → ② fallback CF (stampa il numero domanda) → ③ creazione, genitori dedup su `parents.fiscal_code`, link `student_parents`, **idempotente**, riusa la logica di upsert di `/api/admin/iscrizioni` + `logScrittura`. Route `POST/PATCH/GET /api/admin/sidi/import` (upload+preview gate staff; **apply** gate Direzione). UI in `SidiPanel` (link da `/admin/iscrizioni`).
- **Impatto PRD:** §Interoperabilità §2 → implementato; checklist `/admin/iscrizioni` (Upload ZIP / Matching numero domanda / Sync genitori CF / campo Numero domanda). **TDD:** 14 test (parser/normalize/apply/route).
- **Alternative scartate:** rinviare lo ZIP e usare solo un campo manuale (perde il flusso ministeriale); targettizzare un tracciato XML reale ora (ignoto → rischio rilavoro: isolato in `normalizeSidiRow`).

### 2026-06-27 — DL-049 — [Fase P5] Client SIDI gated + Fase A + frequentanti + Piattaforma Unica + indicatore sync
- **Contesto:** PRD §Interoperabilità §3/§4: allineamento strutturale Fase A, invio frequentanti, flusso associazioni Genitori-Alunni in cooperazione applicativa. La **trasmissione reale richiede l'accreditamento ministeriale** del software (credenziali/canali), oggi non disponibile — stessa dipendenza esterna della verifica live Aruba/SDI (DL-004/DL-017).
- **Decisione:** **fondamenta + boundary gated** (specchio Aruba). `src/lib/sidi/client.ts` (`SidiConfig`, `resolveSidiCredentials` via `password_ref`→env, `sidiBaseUrls` DEMO/PROD, `sidiTransmit` → **503** `non_configurato`/`non_accreditato`, mai successo finto). Builder **neutri** `payload.ts` (Fase A reconcile, frequentanti solo `stato='iscritto'` per sezione, genitori-alunni solo legami **validati Segreteria**); serializer XML **sottili e sostituibili** `serializer.ts`; guardie `sequenza.ts` (Fase A→frequentanti→Piattaforma Unica, 409 fuori ordine). Config `admin_settings.sidi_config` + route `settings/sidi` (clone Aruba, password mascherata). Validazione legami `student_parents.validato_sidi/_il/_da`. Stato `sidi_sync_state` (migr. `20260763`) + indicatore. Route gated `POST /api/admin/sidi/{fase-a,frequentanti,piattaforma-unica}` (dirigenza), `GET/PATCH /api/admin/sidi/legami`, `GET /api/admin/sidi/sync-state`. UI `SidiPanel`/`/admin/sidi`: indicatore 3 pill a cascata + banner «accreditamento in corso».
- **Impatto PRD:** §Interoperabilità §3/§4 → implementato (egress gated); checklist `/admin/iscrizioni` (Fase A / Invia frequentanti / Trasmissione Genitori-Alunni / Indicatore stato sync). **TDD:** 18 test (client/payload/sequenza/serializer/route gate/sequenza-guard/settings-mask).
- **Resta gated/follow-up:** invio telematico reale (accreditamento); tracciato XML reale (serializer sostituibili); inbound cooperazione applicativa + auto-apply struttura Fase A nel DB locale (no scritture distruttive da boundary non accreditato).
- **Alternative scartate:** serializzare subito i tracciati reali su specifiche assunte (rilavoro); rinviare del tutto i builder finché non accreditati (si perde il valore interno di prep-dati e l'indicatore).

### 2026-06-27 — DL-050 — [Fase P5] Assegnazione massiva a gruppi mensa
- **Contesto:** PRD checklist `/admin/iscrizioni`: «Assegnazione massiva (bulk) a classi/sezioni/gruppi mensa». La bulk classe/sezione esisteva; **nessun modello gruppi mensa**.
- **Decisione:** modello minimale `gruppi_mensa` (per scuola, unique nome) + `alunni.gruppo_mensa_id` (migr. `20260761`, RLS default-deny). Esteso `PATCH /api/admin/students` con ramo `{ids[], gruppo_mensa_id}` (`gruppo_mensa_id` null = rimozione) + audit per alunno; CRUD `GET/POST /api/admin/gruppi-mensa`. UI: `BulkAssignBar` esteso (controllo gruppo mensa retro-compatibile) + wiring `/admin/students`.
- **Impatto PRD:** checklist `/admin/iscrizioni` (Assegnazione massiva). **TDD:** 5 test (bulk mensa + regressione classe + gate CRUD).
- **Alternative scartate:** gruppo mensa come tabella ponte molti-a-molti (un alunno → un turno mensa, FK singola sufficiente, YAGNI).
