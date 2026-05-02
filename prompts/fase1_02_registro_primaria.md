# Prompt Atomico: Fase 1 - Modulo Registro Elettronico Primaria

## Contesto Generale
Sei un AI Software Engineer Senior. Il tuo compito è sviluppare il **Modulo Diario Scuola Primaria (Registro Elettronico)** per il SaaS Kidville, basandoti sulla Fase 1 della Roadmap Tecnica.

## Obiettivo del Task
Costruire il registro elettronico ministeriale per la scuola primaria, con isolamento rigoroso delle discipline, gestione di voti, compiti e note.

## Specifiche estratte dal PRD
1. **Appello Orario e Compresenza:**
   - Tracciamento stato: Presente, Assente, Ritardo, Uscita Anticipata.
   - Firma del docente per singola ora. Supporto per compresenza (firme multiple e indipendenti per la stessa ora).
2. **Didattica (Argomenti e Compiti):**
   - Inserimento argomento lezione e compiti assegnati contestualmente alla firma.
   - Possibilità di allegare media (foto lavagna, schede).
   - Compiti visibili sulla bacheca dell'alunno (senza spunta di completamento e senza notifiche push). Visibili anche in caso di assenza.
3. **Valutazioni (Voti):**
   - Modello ibrido: numerici (es. 1-10) o descrittivi (es. Base, Avanzato). I giudizi descrittivi devono avere un valore numerico nascosto per il calcolo delle medie.
   - Categorizzazione: Scritto, Orale, Pratico.
   - Isolamento materia: il docente vede solo i voti della propria materia.
   - Buffer Notifica: invio notifica al genitore ritardata di 10 minuti per permettere correzioni.
4. **Note e Provvedimenti:**
   - 3 categorie (Disciplinare, Didattica, Compiti non svolti) con codifica visiva.
   - Assegnazione massiva (es. intera classe).
   - Richiesta di **Firma digitale per presa visione** obbligatoria da parte del genitore per le note disciplinari.

## Agent Consigliati
Per massimizzare la qualità e l'affidabilità di questa fase, raccomandiamo l'uso dei seguenti sub-agent specializzati (configurazioni disponibili in `agents/awesome-claude-code-subagents-main/categories`):
- `@fullstack-developer.md` (01-core-development) per l'implementazione coesa di UI e logica di business.
- `@postgres-pro.md` (05-data-ai) per l'implementazione rigorosa delle policy RLS che garantiscono l'isolamento dei voti.

## Linee Guida Design (UI/UX)
- **Tassativo:** Tutte le interfacce utente sviluppate per questo modulo devono attenersi rigorosamente alle specifiche visive, alla palette cromatica e ai componenti definiti nel file `design.md` presente nella root del progetto. Consultalo prima di scrivere codice UI.

## Istruzioni Operative
1. **Database:** Definisci le tabelle Supabase `class_schedule`, `lessons_log`, `assignments`, `grades` e `disciplinary_notes`. Applica Row Level Security (RLS) per garantire l'isolamento dei voti tra docenti di materie diverse.
2. **Backend:** Crea la logica per il calcolo asincrono delle medie e il job ritardato (10 min) per l'invio delle notifiche dei voti.
3. **UI Docente:** Sviluppa la griglia oraria, modale per firma, form inserimento valutazioni e assegnazione note massiva.
4. **UI Genitore:** Sviluppa le sezioni per visualizzare orario, compiti, andamento scolastico e il flusso di "Firma per presa visione" delle note.
