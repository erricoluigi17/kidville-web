# Prompt Atomico: Fase 2 - Modulo Diario 0-6 (Nido e Infanzia)

> [!IMPORTANT]
> **Fonte di verità = PRD.** Documento di pianificazione storico: in caso di conflitto con il file `PRD REGISTRO ELETTRONICO.md` **vince sempre il PRD**. I contenuti in contrasto con il PRD sono marcati **[SUPERATO]** qui sotto (conservati per storico, non rimossi). Allineamento PRD: giugno 2026.

## Contesto Generale
Sei un AI Software Engineer Senior. Sviluppa il **Modulo Diario 0-6 anni** per il SaaS Kidville, basato sulla Fase 2 della Roadmap. Questo modulo è critico per la documentazione della routine dei bambini più piccoli.

## Obiettivo del Task
Creare un'interfaccia di data-entry estremamente rapida per le educatrici e una timeline unificata e in tempo reale per i genitori.

## Specifiche estratte dal PRD
1. **Routine Supportate:**
   - Entrata, Attività (con note testuali libere), Merenda, Pranzo (multipart: Niente, Poco, Metà, ecc.), **Nanna (Inizio)** e **Sveglia (Fine Nanna)** come **DUE pulsanti distinti** che registrano "dalle … alle …" (**[allineato a PRD §3.1.1]**, non un pulsante unico), Bagno/Igiene (Pipì, Cacca, Vasino).
2. **Esperienza Insegnante (Data-Entry):**
   - **Filtro presenze:** Mostra solo i bambini "Presenti" oggi. (Integrazione con Modulo Presenze Fase 1).
   - **Bulk Action:** Seleziona più bambini per assegnare la stessa azione (es. "Nanna per tutti").
   - **Allarmi Sicurezza:** Dashboard evidenzia intolleranze. In fase di pasto, nome rosso per bimbi allergici.
   - Buffer di 10 minuti prima dell'invio notifiche.
3. **Esperienza Genitore:**
   - Timeline verticale cronologica (sola lettura, no like/commenti).
   - Traduzione dinamica delle routine standard in base alla lingua del dispositivo.
   - Archiviazione: dati inaccessibili al genitore dopo 14 giorni (visibili solo Segreteria).

## Agent Consigliati
Per massimizzare la qualità e l'affidabilità di questa fase, raccomandiamo l'uso dei seguenti sub-agent specializzati (configurazioni disponibili in `agents/awesome-claude-code-subagents-main/categories`):
- `@frontend-developer.md` (01-core-development) per la costruzione di una UI/UX reattiva e veloce (data-entry).
- `@performance-engineer.md` (04-quality-security) per garantire il rendering fluido della timeline unificata.

## Linee Guida Design (UI/UX)
- **Tassativo:** Tutte le interfacce utente sviluppate per questo modulo devono attenersi rigorosamente alle specifiche visive, alla palette cromatica e ai componenti definiti nel file `design.md` presente nella root del progetto. Consultalo prima di scrivere codice UI.

## Flusso UX Insegnante (Event-First)
Il data-entry dell'insegnante segue un flusso in **due step**:
1. **Step 1 — Selezione Evento:** L'insegnante vede una griglia di pulsanti grandi con tutti i tipi di evento (Entrata, Pranzo, **Nanna, Sveglia**, Bagno, ecc.) e ne seleziona uno. La lista degli alunni non è ancora visibile.
2. **Step 2 — Selezione Alunni:** Dopo aver scelto il tipo di evento, compare la lista dei bambini "Presenti" oggi. L'insegnante seleziona uno o più bambini e conferma l'azione (singola o bulk). Il pulsante "Indietro" permette di tornare allo Step 1 senza perdere nulla.

Questo flusso riduce gli errori cognitivi e le selezioni accidentali, poiché l'insegnante mantiene il focus su **una sola dimensione per volta**.

## Istruzioni Operative
1. **Database Schema:** Crea tabella `daily_routines` ottimizzata per query cronologiche e filtri per studente.
2. **Business Logic:** Implementa il buffer delle notifiche e l'interblocco con il modulo mensa per visualizzare in rosso le allergie durante l'evento "Pasto".
3. **UI Insegnante (Event-First):** Implementa il flusso in due step: Step 1 mostra solo la griglia eventi; Step 2 (dopo selezione evento) mostra la lista alunni con selezione singola/multipla e pulsante "Indietro". Pulsanti grandi e touch-friendly.
4. **UI Genitore:** Sviluppa un componente Timeline accattivante, pulito e tradotto dinamicamente.
