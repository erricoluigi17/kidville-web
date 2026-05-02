# Prompt Atomico: Fase 4 - Modulo Menu e Mensa

## Contesto Generale
Sei un AI Software Engineer Senior. Sviluppa il **Modulo Menu e Mensa** (Fase 4) per automatizzare la filiera di ristorazione.

## Obiettivo del Task
Creare un sistema di pianificazione menu, match allergeni, e gestione ticket a scalare, separato in base ai ruoli.

## Specifiche estratte dal PRD
1. **Menu Builder:**
   - Creazione menu (Primo, Secondo, Contorno, Frutta) con ciclicità (es. 4 settimane autocompilate).
   - Associazione **obbligatoria allergeni**.
   - Matching automatico allergeni-anagrafica (icona allarme nel calendario genitore se pasto pericoloso).
   - Disattivazione intero modulo in giorni di chiusura globale.
2. **Ruolo "Cuoca" (Dashboard Dedicata):**
   - L'account Cuoca accede a una singola dashboard oscurata dal resto dell'app.
   - Vede i numeri definitivi (Pasti standard, Diete bianco, Diete speciali) con orario limite (Cut-off).
3. **Modello Ticketing a Scalare:**
   - Saldo individuale prepagato per alunno. Scalo ticket automatico quando genitore/insegnante prenota pasto nel Diario/Registro.
   - Ricarica offline (inserimento manuale saldo da Segreteria, niente Stripe).
   - Reminder automatico esaurimento scorte push.
4. **Insegnanti:**
   - Vista elenco prenotati, richiesta dieta in bianco (entro cut-off), esclusioni di classe (es. per gita).

## Agent Consigliati
Per massimizzare la qualità e l'affidabilità di questa fase, raccomandiamo l'uso dei seguenti sub-agent specializzati (configurazioni disponibili in `agents/awesome-claude-code-subagents-main/categories`):
- `@database-administrator.md` (03-infrastructure) per gestire la consistenza transazionale dello scalamento ticket mensa.
- `@fullstack-developer.md` (01-core-development) per lo sviluppo indipendente della Dashboard "Cuoca".

## Linee Guida Design (UI/UX)
- **Tassativo:** Tutte le interfacce utente sviluppate per questo modulo devono attenersi rigorosamente alle specifiche visive, alla palette cromatica e ai componenti definiti nel file `design.md` presente nella root del progetto. Consultalo prima di scrivere codice UI.

## Istruzioni Operative
1. **Architettura Dati:** Gestisci le tabelle `menus`, `menu_items`, `allergens`, `student_meal_balance`, e `meal_logs`. 
2. **Sistema Ticketing:** Implementa l'operazione transazionale che decrementa il saldo. Usa le Edge Functions per i check sui ticket in via d'esaurimento.
3. **UI Cuoca:** Sviluppa la view aggregata real-time (usando le subscription Supabase) per mostrare i numeri dei pasti senza alcun dato anagrafico sensibile eccetto le specifiche dietetiche.
