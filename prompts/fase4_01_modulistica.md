# Prompt Atomico: Fase 4 - Modulo Modulistica, Certificati e Onboarding Legale

## Contesto Generale
Sei un AI Software Engineer Senior. Il tuo task è costruire il **Modulo Modulistica e Certificati** (Fase 4), che digitalizza la burocrazia scolastica conferendole valore legale.

## Obiettivo del Task
Fornire alla Segreteria un Form Builder dinamico per raccogliere Firme Elettroniche Semplici (FES) inattaccabili, e al genitore un portale self-service per certificati medici.

## Specifiche estratte dal PRD
1. **Scudo Giuridico e FES:**
   - Raccolta consenso tramite Firma Elettronica Semplice.
   - Cristallizzazione dei log (Timestamp esatto, IP, ID utente) e generazione di un documento PDF statico e immodificabile.
   - Isolamento moduli GDPR (check-box separati).
2. **Form Builder e Automazioni:**
   - Segreteria può creare form personalizzati con scadenze bloccanti.
   - Dati inseriti nel form aggiornano automaticamente l'Anagrafica.
   - Export massivo PDF (unione di tutti i consensi di una classe).
3. **Certificati (Self-Service):**
   - Genitore genera certificati precompilati (Frequenza, Iscrizione).
   - Upload certificato medico per assenze: sblocca l'alunno senza approvazione manuale preventiva.
4. **Cruscotto Insegnante:**
   - Semaforo autorizzazioni in classe (chi ha firmato e chi no per una gita).
   - "Proxy Upload": l'insegnante fotografa il certificato cartaceo alla porta e lo carica per conto del genitore.

## Agent Consigliati
Per massimizzare la qualità e l'affidabilità di questa fase, raccomandiamo l'uso dei seguenti sub-agent specializzati (configurazioni disponibili in `agents/awesome-claude-code-subagents-main/categories`):
- `@compliance-auditor.md` (04-quality-security) per garantire l'efficacia legale della Firma Elettronica Semplice (log IP/Timestamp).
- `@fullstack-developer.md` (01-core-development) per la costruzione fluida del drag-and-drop Form Builder.

## Linee Guida Design (UI/UX)
- **Tassativo:** Tutte le interfacce utente sviluppate per questo modulo devono attenersi rigorosamente alle specifiche visive, alla palette cromatica e ai componenti definiti nel file `design.md` presente nella root del progetto. Consultalo prima di scrivere codice UI.

## Istruzioni Operative
1. **Architettura PDF e FES:** Integra una libreria PDF-generation sul backend per generare il certificato firmato inserendo footer con Hash, IP e Timestamp.
2. **DB & JSONB:** Utilizza campi JSONB in Supabase per salvare flessibilmente i dati dinamici dei form creati col Form Builder.
3. **Automazioni:** Usa i trigger del DB per aggiornare i campi core dell'Anagrafica quando un form specifico viene "Sottomesso".
4. **UI:** Costruisci il costruttore drag-and-drop di form per la segreteria. Sviluppa le view per i cruscotti insegnante.
