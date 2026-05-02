# Prompt Atomico: Fase 3 - Modulo Comunicazione (Chat e Bacheca)

## Contesto Generale
Sei un AI Software Engineer Senior. Il tuo task è sviluppare il **Modulo Comunicazione** della piattaforma, come indicato nella Fase 3 della Roadmap.

## Obiettivo del Task
Sviluppare un sistema di messaggistica istantanea isolato e tradotto, oltre a una bacheca istituzionale per le comunicazioni formali.

## Specifiche estratte dal PRD
1. **Chat Privata (Scuola - Famiglia):**
   - Comunicazione rigorosamente 1-a-1 tra singolo Insegnante e singolo Genitore. Nessun gruppo. Genitori separati hanno chat separate.
   - Supporto allegati multimediali (PDF, foto, note vocali).
   - Traduzione automatica in tempo reale nella lingua dell'utente.
   - Chat sempre attiva H24, anche se account genitore sospeso amministrativamente (per emergenze).
2. **Bacheca Avvisi e Circolari:**
   - Invio globale (Istituto) o per classe.
   - Tracciamento "Presa Visione" all'apertura.
   - Pulsanti di adesione (Si/No) interattivi per specifiche richieste.
   - Dashboard monitoraggio letture per l'insegnante/segreteria.
3. **Comunicazione Interna (Task Staff):**
   - Nessuna chat interna, ma sistema a Task/Bacheca per assegnare direttive dalla Segreteria agli Insegnanti.
4. **Permessi Super-Admin:** Segreteria può leggere in chiaro ogni chat in sola lettura per audit.

## Agent Consigliati
Per massimizzare la qualità e l'affidabilità di questa fase, raccomandiamo l'uso dei seguenti sub-agent specializzati (configurazioni disponibili in `agents/awesome-claude-code-subagents-main/categories`):
- `@websocket-engineer.md` (01-core-development) o esperto realtime, per la gestione dei flussi socket e latenza zero.
- `@api-designer.md` (01-core-development) per il proxy/bridge sicuro verso le API di traduzione.

## Linee Guida Design (UI/UX)
- **Tassativo:** Tutte le interfacce utente sviluppate per questo modulo devono attenersi rigorosamente alle specifiche visive, alla palette cromatica e ai componenti definiti nel file `design.md` presente nella root del progetto. Consultalo prima di scrivere codice UI.

## Istruzioni Operative
1. **Real-time DB:** Utilizza le funzionalità real-time di Supabase per gestire la messaggistica istantanea. Assicurati che le RLS policies permettano alla Segreteria di leggere tutto, ma vincolino i genitori alla propria chat.
2. **Integrazione API Traduzione:** Implementa un bridge (Edge Function) verso Google Cloud Translation / DeepL per tradurre i messaggi in ingresso/uscita in background.
3. **Storage:** Configura i bucket Supabase Storage per gestire allegati chat e PDF circolari.
4. **UI:** Costruisci un'interfaccia chat moderna (stile WhatsApp) ma con chiari indicatori di traduzione e visualizzazione sicura.
