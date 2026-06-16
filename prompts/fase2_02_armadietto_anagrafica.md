# Prompt Atomico: Fase 2 - Modulo Armadietto e Anagrafica

> [!IMPORTANT]
> **Fonte di verità = PRD.** Documento di pianificazione storico: in caso di conflitto con il file `PRD REGISTRO ELETTRONICO.md` **vince sempre il PRD**. I contenuti in contrasto con il PRD sono marcati **[SUPERATO]** qui sotto (conservati per storico, non rimossi). Allineamento PRD: giugno 2026.

## Contesto Generale
Sei un AI Software Engineer Senior. Il task copre lo sviluppo del **Modulo Armadietto** (gestione scorte) e il consolidamento del **Modulo Anagrafica**, parte della Fase 2 della Roadmap.

## Obiettivo del Task
Automatizzare la richiesta di materiale scolastico (pannolini, cambi) tramite un sistema a scalare e completare le viste di anagrafica per la Segreteria.

## Specifiche estratte dal PRD
1. **Anagrafica & Onboarding (Segreteria):**
   - UI tabellare per assegnazione massiva alunni a classi/gruppi mensa.
   - Gestione anagrafica medico/didattica (BES, allergie).
   - Funzione Hard Delete per diritto all'oblio GDPR.
2. **Modulo Armadietto (Insegnante & Genitore):**
   - **Catalogo:** Lista materiali configurabile per sede (pannolini, creme, ecc.) + campo custom.
   - **Logica a scalare (Semaforo):** 
     - L'insegnante registra il "Carico" (es. 20 pannolini).
     - ~~Ogni azione "Cambio" nel Diario 0-6 scala 1 unità automaticamente.~~ **[SUPERATO — vedi PRD Armadietto §2.2]** Ogni **evento "Bagno/Igiene"** nel Diario 0-6 scala **1 pannolino** automaticamente, **solo per i bambini con flag "Usa pannolino" in Anagrafica** (i bambini senza flag non subiscono scalo).
     - Soglie: Verde (Ok), Giallo (<5, allerta), Rosso (<2, esaurito).
   - **Notifiche:** Push immediato alla richiesta + Reminder schedulato alle 07:00 del mattino successivo. Pulsante di "Preso in carico" per il genitore.
   - Azioni Bulk per richieste collettive, funzionante anche offline.

## Agent Consigliati
Per massimizzare la qualità e l'affidabilità di questa fase, raccomandiamo l'uso dei seguenti sub-agent specializzati (configurazioni disponibili in `agents/awesome-claude-code-subagents-main/categories`):
- `@fullstack-developer.md` (01-core-development) per gestire l'intero flusso dall'interfaccia UI all'aggiornamento scorte.
- `@backend-developer.md` (01-core-development) per la configurazione dei job schedulati (Reminder 07:00).

## Linee Guida Design (UI/UX)
- **Tassativo:** Tutte le interfacce utente sviluppate per questo modulo devono attenersi rigorosamente alle specifiche visive, alla palette cromatica e ai componenti definiti nel file `design.md` presente nella root del progetto. Consultalo prima di scrivere codice UI.

## Istruzioni Operative
1. **Integrazione Armadietto-Diario:** Crea un trigger o un service che, alla registrazione di un evento "Bagno/Igiene" nel Diario, decrementi di **1 pannolino** la disponibilità nella tabella `locker_inventory`, **solo se l'alunno ha il flag "Usa pannolino" attivo in Anagrafica** (**[allineato a PRD Armadietto §2.2]**; nessuno scalo per gli altri bambini).
2. **Job Schedulati:** Implementa una cron job (Edge Function) per inviare il reminder delle 07:00.
3. **UI Genitore:** Sviluppa l'interfaccia "Lista della Spesa" con i semafori visuali.
4. **UI Admin:** Sviluppa la tabella di assegnazione massiva (Bulk Assign) per alunni/classi con funzionalità di drag-and-drop o multi-select avanzata.
