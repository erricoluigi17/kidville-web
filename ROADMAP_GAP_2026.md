# Roadmap Gap — Kidville (giugno 2026)

> Generata da audit automatico PRD↔codice (18 moduli, 36 agenti). Confronto: `PRD REGISTRO ELETTRONICO.md` (fonte di verità) + `ROADMAP_TECNICA.md` + `prompts/` contro `src/` e `supabase/migrations/`.
> **Stato:** 518 requisiti — **299 implementati (58%)**, **125 parziali (24%)**, **94 mancanti (18%)**.
> Le voci marcate `✓` sono state confermate da una verifica avversariale (un secondo agente ha cercato di smentire il gap trovando il codice).

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
- **Accessibilità Legge Stanca (L.4/2004 / AgID)** — criterio legale: alto contrasto + toggle, ARIA/screen reader, WCAG. Oggi missing/partial.
- **Presenze (Fase 1, 17/36)**:
  - Operatività **offline-first** reale (cache locale + sync al ripristino) + indicatore Offline/stato sync.
  - **Check-out**: verifica visiva delegato con **foto documento d'identità**.
  - **Panic Alert** `✓`: notifica istantanea simultanea Segreteria + App Genitore, blocco uscita, banner genitore.
  - **Giustifiche genitore**: PIN dispositivo per-tutore / firma OTP, "comunica assenza in anticipo".
  - Orario check-in modificabile (correzione retroattiva); override Direzione; **Export ministeriale MIUR** (Excel/PDF).
- **Registro Primaria — residui (Fase 1)**:
  - **Note disciplinari: firma genitore per presa visione** (interazione obbligatoria) + finestra di modifica/blocco.
  - Filtro alunni presenti per inserimento note massivo.
  - **Sblocco riservato al Dirigente** con motivazione + tracciamento; **audit** inserimenti/modifiche (valore prima/dopo).
  - Visibilità famiglie: orario settimanale + materie del figlio in app.
  - Valutazione in itinere legata a ≥1 **obiettivo**; giudizio di scrutinio **proposto** dalle in-itinere e modificabile collegialmente; import massivo giudizi via CSV; storico pagelle per A.S.
- **Fascicolo Personale (Trasversale, 13/21)**:
  - Sezione **Amministrativa** e sezione **Consensi/Privacy** come tab del fascicolo.
  - **Workflow firma GLO del PEI** (area protetta, annota, firma accettazione, badge "Firme GLO").
  - Crittografia applicativa **AES-256** dei file; badge "Documento sensibile" + banner "Accesso tracciato".

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
- **FEA — Firma Elettronica Avanzata** (tecnica/qualificata): esplicitamente esclusa dal Blocco 3 del PRD. Richiesta in: Modulistica/Form, Pagelle (firma dirigente/SPID-CIE), firma di registro docente. **Da realizzare lato committente** — ma vanno comunque predisposti i ganci UI/dati.
