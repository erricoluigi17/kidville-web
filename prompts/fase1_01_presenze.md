# Prompt Atomico: Fase 1 - Modulo Presenze e Check-in/Check-out

## Contesto Generale
Sei un AI Software Engineer Senior. Il tuo compito è sviluppare il **Modulo Presenze e Check-in/Check-out** per il SaaS Kidville, basandoti sulla Fase 1 della Roadmap Tecnica. L'architettura di base (Supabase) è già configurata. 

## Obiettivo del Task
Sviluppare la funzionalità core di tracciamento presenze degli alunni, garantendo operatività offline per gli insegnanti e massima sicurezza in fase di uscita (verifica delegati).

## Specifiche estratte dal PRD
1. **Check-in (Ingresso):**
   - Vista limitata alla propria classe per l'insegnante.
   - Lista inizialmente vuota (nessun "Presente" di default).
   - Registrazione "Presente" con tap singolo, con salvataggio timestamp basato sull'orologio di sistema (modificabile manualmente in caso di ritardo nell'inserimento).
2. **Check-out (Uscita) e Sicurezza:**
   - Registrazione orario effettivo di uscita.
   - Accesso rapido (sola lettura) alla lista dei delegati autorizzati per l'alunno.
   - Visualizzazione foto del documento d'identità del delegato per riconoscimento visivo.
   - **Panic Alert:** Pulsante di emergenza in caso di tentato ritiro non autorizzato. Deve generare una notifica istantanea alla Segreteria e al Genitore, bloccando il check-out nel sistema.
3. **Gestione Assenze (Genitore):**
   - Inserimento preventivo avviso assenza/giustifica tramite app genitore.
   - Nessuna notifica push di routine per ingressi/uscite normali.
4. **Architettura Offline-First:**
   - Le azioni di check-in/out devono funzionare senza rete, salvate in cache locale (es. SQLite/Isar o IndexedDB se web) e sincronizzate al ripristino della connettività.

## Agent Consigliati
Per massimizzare la qualità e l'affidabilità di questa fase, raccomandiamo l'uso dei seguenti sub-agent specializzati (configurazioni disponibili in `agents/awesome-claude-code-subagents-main/categories`):
- `@mobile-developer.md` (01-core-development) per l'ottimizzazione dell'esperienza mobile e offline-first.
- `@postgres-pro.md` (05-data-ai) per il setup ottimale della sincronizzazione locale/cloud su Supabase.

## Linee Guida Design (UI/UX)
- **Tassativo:** Tutte le interfacce utente sviluppate per questo modulo devono attenersi rigorosamente alle specifiche visive, alla palette cromatica e ai componenti definiti nel file `design.md` presente nella root del progetto. Consultalo prima di scrivere codice UI.

## Istruzioni Operative
1. **Database:** Crea le migration (o definisci gli schemi) Supabase necessari per la tabella `presenze` (con `alunno_id`, `data`, `orario_entrata`, `orario_uscita`, `stato`, `sync_status`) e la tabella `delegati`. Assicurati che si leghino alla tabella `alunni` esistente.
2. **Backend/API:** Sviluppa le Edge Functions/RPC necessarie, in particolare per gestire il trigger del "Panic Alert".
3. **Frontend Insegnante:** Implementa la UI per l'appello rapido, includendo lo stato offline e la visualizzazione del popup delegati con foto.
4. **Frontend Genitore:** Implementa la UI per comunicare l'assenza preventiva.
5. **Codice:** Scrivi codice modulare, tipizzato in TypeScript (se web/React Native) o Dart (se Flutter), separando la logica di business dalla UI. Assicurati di gestire correttamente gli stati offline/online.
