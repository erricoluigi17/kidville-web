# Roadmap Gap — Kidville (giugno 2026)

> Generata da audit automatico PRD↔codice (18 moduli, 36 agenti). Confronto: `PRD REGISTRO ELETTRONICO.md` (fonte di verità) + `ROADMAP_TECNICA.md` + `prompts/` contro `src/` e `supabase/migrations/`.
> **Stato:** 518 requisiti — **299 implementati (58%)**, **125 parziali (24%)**, **94 mancanti (18%)**.
> Le voci marcate `✓` sono state confermate da una verifica avversariale (un secondo agente ha cercato di smentire il gap trovando il codice).
> **Avanzamento P2 — core compliance (2026-06-26):** chiusi 5 item requisito (valutazione↔obiettivo, presa-visione note FEA, orario famiglie, finalità accesso fascicolo, Panic Alert notifica) → ~**304 implementati**; 3 decisi e parzializzati (AES at-rest, Export MIUR XLSX+PDF, account sospeso→P3). Delta incrementale del sottoinsieme, non un re-audit completo dei 36 agenti.

---

## P0 — Fondamenta: Autenticazione & Sicurezza (BLOCCANTE)
*Stato aggiornato (branch `feat/p0-auth`, slice S0-S7 + S11-S12 implementate e verificate). Restano rollout-gated S8/S9/S13 — vedi in fondo.*

- **Autenticazione reale** `✅ FATTO` — `resolveIdentity()` ([require-staff.ts](src/lib/auth/require-staff.ts)) preferisce la sessione Supabase, anti-spoof header, flag `ALLOW_HEADER_IDENTITY`; `src/middleware.ts` rinnova la sessione + redirect anonimo → login. Staff già auth-backed (`utenti.id` FK `auth.users`); 89/92 genitori ora bindati ad `auth.users` (backfill S6).
- **Pagina Login/Landing** `✅ FATTO` — `/auth/login` (email/password, mostra password, banner "solo su invito"/errore, toggle Alto contrasto). *(Selettore Sede/Tenant: risolto dal record utente, non a login.)*
- **Recupero credenziali / reset password** `✅ FATTO (DL-005)` — `POST /api/admin/regenerate-credentials`: la Segreteria genera password random e la invia via email (no self-service).
- **Cloud Auth rigida** `✅ FATTO (base)` — login invite-only, nessuna auto-registrazione; legame creato solo dalla Segreteria (`parents`/`student_parents`). *(Flusso invito-link `/auth/join` superato da DL-005 per il path credenziali.)*
- **Gate auth su Galleria** `✅ FATTO` — `requireDocente` su `/api/gallery` POST + `/api/gallery/upload` (+ grades/notes/attendance). Endpoint pericolosi sigillati (seed-db/debug/wipe/seed-full); rate-limit su iscrizione + send-otp.
- **RLS hardening** `🔶 PARZIALE` — colonna ponte `parents.auth_user_id` + policy pagamenti additive per lo spazio `parents` (S4/S7) verificate su dati reali. **Lockdown completo (rimozione policy `allow_all`/`anon`) = rollout-gated (S9).**
- **Audit Log immutabile** `✅ FATTO (read+credenziali)` — `GET /api/admin/audit` (filtro per attore/entità su `audit_scritture_docente`); rigenerazione credenziali tracciata. *(Audit su ogni mutazione anagrafica = follow-up.)*

**Rollout-gated (NON attivati: romperebbero la prod finché i genitori non sono onboardati):**
- **S8** — letture genitore via `createSessionClient` (helper `createParentReadClient` pronto, flag `PARENT_READS_USE_SESSION` OFF).
- **S9** — rimozione policy permissive `allow_all_*`/`TO anon`. Prerequisito: migrare le letture anon dirette del frontend (`alunni`/`legame_genitori_alunni`/`utenti`/`form_*`) verso API/policy `authenticated`.
- **S13** — `ALLOW_HEADER_IDENTITY='false'` (sigillo sola-sessione) dopo l'onboarding.

## P1 — Conformità normativa & core didattico incompleto
> **Nota numerazione:** questa sezione = **Fase P2** del `master_plan_full.md` (Conformità normativa & core didattico). Aggiornamento sottoinsieme "core compliance" P2 (2026-06-26): vedi DL-011..016. Le voci ✅ sotto sono chiuse in questo giro; le restanti sono sequenziate nei giri successivi della stessa fase.
- **Accessibilità Legge Stanca (L.4/2004 / AgID)** — criterio legale: alto contrasto + toggle, ARIA/screen reader, WCAG. **✅ Baseline P1 (DL-008):** provider alto-contrasto globale persistito (cookie SSR, no-FOUC), token HC + focus-ring + reduced-motion, Modal accessibile, landmark/skip-link/aria-current, smoke `jest-axe`. WCAG-AA = definition-of-done; audit AA per-pagina incrementale.
- *(NB — i servizi trasversali **FEA** e **Push bufferizzato** del master plan P1 sono completati: vedi PRD §6 Stato per area e DL-001/006/007/009/010.)*
- **Presenze (Fase 1, 17/36)**:
  - Operatività **offline-first** reale (cache locale + sync al ripristino) + indicatore Offline/stato sync.
  - **Check-out**: verifica visiva delegato con **foto documento d'identità**.
  - **Panic Alert**: ✅ **P2 (DL-016)** notifica istantanea simultanea Segreteria/Direzione + App Genitore via push P1 (best-effort). 🔶 Restano blocco uscita UI + banner genitore + clear-con-audit.
  - **Giustifiche genitore**: firma OTP ✅ (P1); PIN dispositivo per-tutore → rinviato a P3 (DL-013-area). "comunica assenza in anticipo" già presente.
  - Orario check-in modificabile (correzione retroattiva); override Direzione; **Export ministeriale MIUR** (Excel/PDF) → 🔶 **deciso P2 (DL-012)**: XLSX+PDF, impl. sequenziata.
- **Registro Primaria — residui (Fase 1)**:
  - **Note disciplinari: firma genitore per presa visione**: ✅ **P2 (DL-014)** flusso FEA OTP/FES (`nota_ricezioni` + slot + audit). 🔶 Resta la finestra di modifica/blocco.
  - Filtro alunni presenti per inserimento note massivo. 🔶 sequenziato.
  - **Sblocco riservato al Dirigente** con motivazione + tracciamento (`sblocchi_audit`) ✅; **audit** inserimenti/modifiche (valore prima/dopo, `audit_scritture_docente`) ✅.
  - Visibilità famiglie: orario settimanale + materie del figlio in app → ✅ **P2** (`GET /api/parent/primaria/orario` + pagina genitore).
  - Valutazione in itinere legata a ≥1 **obiettivo** → ✅ **P2 (DL-015)** (enforcement condizionale + `valutazione_obiettivi` + UI); giudizio di scrutinio **proposto** dalle in-itinere ✅; import massivo giudizi via CSV ✅; storico pagelle per A.S. ✅. 🔶 Resta: download template CSV, banner "voti numerici disabilitati".
- **Fascicolo Personale (Trasversale, 13/21)**:
  - Sezione **Amministrativa** e sezione **Consensi/Privacy** come tab del fascicolo. 🔶 sequenziato.
  - **Workflow firma GLO del PEI** (area protetta, annota, firma accettazione, badge "Firme GLO"). 🔶 sequenziato (slot `all-required` FEA P1 pronti).
  - Crittografia **AES-256** dei file → ✅ **deciso P2 (DL-011)**: cifratura at-rest gestita (Storage privato + signed URL + RBAC + audit), no app-crypto; **campo "finalità di accesso" cablato** ✅ (`fascicolo_accessi_audit.finalita`). 🔶 Resta badge "Documento sensibile" (banner "Accesso tracciato" già presente).

## P2 — Moduli amministrativi & finanziari
- **Fatturazione Elettronica Aruba (Fase 5, 1/11 — quasi tutto da costruire)**:
  - Generazione **XML FatturaPA** verso SDI; regime **IVA 0% Natura N4** automatico; esclusione marca da bollo; numerazione delegata ad Aruba.
  - Backend sicuro (chiavi mai esposte al client); monitoraggio **scarti SDI** con motivo + banner Segreteria; download copia cortesia PDF lato genitore.
  - Pannello impostazioni Aruba (credenziali vault, dati scuola P.IVA/CF/PEC, mappatura causali).
- **Pagamenti — residui (Fase 5, 25/30)**: fattura/ricevuta manuale su saldato; vista a categorie genitore (Rette/Quote/Mensa/Gite); sospensione manuale account moroso.
- **Modulistica & Form (Fase 4, builder 23/40 + modulistica 11/33)**:
  - **Form Builder Drag & Drop** completo (blocchi Bambino/Adulto/Consensi/Allegati), **logica condizionale**, scoring/soglia graduatoria, "Pubblica modello", config accessi (registrati/link pubblico).
  - Wizard: **firma congiunta secondo firmatario**, "reinvia OTP".
  - **ETL nativo PostgreSQL** (trigger `form_submissions→completed` che riversa in anagrafiche).
  - Graduatorie: **delibera ammissioni** + stato ammesso/non + **export XLSX/PDF**.
  - **Certificato medico self-service** (upload genitore → validazione Segreteria); ricevuta PDF inattaccabile (IP/Timestamp/Hash SHA-256); proxy upload cartaceo + sollecito firme docente; merge PDF classe.
  - **RLS allegati** + **pg_cron** solleciti/promemoria scadenza.
- **Impostazioni / Super-Admin (Fase 5, 19/35)**:
  - **Gestione Multi-Sede** (aggiungi/rinomina/disattiva, config isolata per sede).
  - **Gestione Staff RBAC** (onboarding, ruoli Docente/Segreteria/Cuoca/Direzione, associazione classi).
  - Calendario chiusure (disabilita scalo ticket/appello); config ticket mensa (costo/pacchetti); accesso al Form Builder.
  - Strumenti: audit log, reset password, export ministeriale, **diritto all'oblio / hard delete GDPR**.

## P3 — Esperienza famiglia & moduli 0-6
- **Diario 0-6 (Fase 2, 21/37)**:
  - **Notifiche push** al genitore per ogni evento (dopo buffer 10 min) — il buffer/push è parziale/mancante.
  - Pulsante evento **"Entrata"** + orario precompilato (incongruenza ancora aperta nel codice).
  - **Filtro presenze** (mostra solo "Presenti") — incongruenza #7 dichiarata "da implementare".
  - Compilazione automatica portate dal menu del giorno; bulk "Nanna per tutti"; archivio 14 giorni (enforcement lato genitore); traduzione voci routine; dashboard monitoraggio Segreteria.
- **Armadietto (Fase 2, 5/22 — molto incompleto)**:
  - **Flusso "Richiesta materiale al genitore"** (creazione lato docente) + **chiusura ciclo** alla ricezione fisica.
  - Notifica immediata al genitore; bulk multi-bambino; indipendenza dalle presenze; isolamento multi-figlio.
  - **Carico merci** (ingresso fisico con marca/taglia/quantità) + log ingressi; UI genitore "Lista della Spesa"; reminder 07:00; ack "Preso in carico".
  - **Dashboard Inadempienze (Direzione)** + solleciti; on/off widget per classe.
- **Menu e Mensa (Fase 4, 19/33)**:
  - **Isolamento interfaccia Cuoca** (vede SOLO mensa); dashboard real-time per tipologia (Standard/Bianco/Speciali); cut-off.
  - **Allergeni per piatto** (14 UE) obbligatori + alert incrociato anagrafica + icona pericolo personalizzata genitore.
  - Semaforo scorte ticket; diete in bianco entro cut-off; esclusioni classe (gita); storni/riaccrediti Segreteria; report fine mese catering.
- **Comunicazione (Fase 3, 24/32)**:
  - **Traduzione automatica** messaggi chat (insegnante↔famiglie straniere) — requisito chiave mancante.
  - Note vocali; condivisione file/PDF/foto; super-admin Direzione lettura di tutte le chat; bacheca compiti genitore.
- **Galleria Foto/Video (Fase 3, 17/24)**:
  - **Privacy Lock** che inibisce fisicamente tagging di alunni senza liberatoria.
  - Comunicazioni istituzionali (bypass tagging broadcast); cancellazione globale admin; interconnessione con Diario 0-6.
- **Anagrafica (Fase 2, 17/36)**:
  - **Upload documenti** (identità delegato, BES/PEI/Diagnosi) nei form dashboard (oggi solo nel form pubblico).
  - Gestione delegati editabile (aggiungi/upload); **onboarding genitore** (`/onboarding`: primo accesso, password/PIN, consensi GDPR).
  - Stato "Non iscritto"; trasferimento alunno tra sedi; bulk gruppo mensa; importa pre-iscrizioni dalla pagina anagrafica; dati finanziari (retta/scadenza/sconti) nel form.

## P4 — Interoperabilità ministeriale (fuori roadmap originale, 2/12)
*Modulo "Interoperabilità SIDI / Piattaforma Unica": presente nel PRD ma non nelle 5 fasi originali. Quasi interamente da costruire.*
- Import file `.zip` SIDI; matching/dedup su Numero domanda iscrizione.
- Allineamento strutturale Fase A (sedi/sezioni/classi/tempo scuola) + **invio flusso frequentanti al SIDI**.
- Flusso Genitori-Alunni Piattaforma Unica; **export Certificati delle Competenze** (classe quinta, D.M. 14/2024); indicatore stato sync.

## Escluso by-design (a carico del committente)
- ~~**FEA — Firma Elettronica Avanzata**: esclusa dal Blocco 3, a carico del committente.~~ **[SUPERATO — DL-001/Fase P1]** La FEA è **in scope e realizzata in-house** (servizio `src/lib/fea/`: OTP email + identità da sessione + slot firmatari + ricevuta PDF inattaccabile + audit immutabile). ✅ Implementata in P1. *(Nota: una FEA qualificata/eIDAS resterebbe eventualmente lato committente; il livello in-house è una firma elettronica rafforzata — informativa da validare.)*
