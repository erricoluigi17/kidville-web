# Prompt Atomico: Fase 5 - Gestione Finanziaria, Aruba e Sicurezza (Cloud Auth)

> [!IMPORTANT]
> **Fonte di verità = PRD.** Documento di pianificazione storico: in caso di conflitto con il file `PRD REGISTRO ELETTRONICO.md` **vince sempre il PRD**. I contenuti in contrasto con il PRD sono marcati **[SUPERATO]** qui sotto (conservati per storico, non rimossi). Allineamento PRD: giugno 2026.

## Contesto Generale
Sei un AI Software Engineer Senior. Chiudi la roadmap con la **Fase 5**, incentrata sulla Gestione Economica, Integrazione Aruba e configurazione globale di Sicurezza (Cloud Auth).

## Obiettivo del Task
Sviluppare un sistema di tracciamento pagamenti off-platform, fatturazione elettronica protetta e consolidamento della logica auth vincolante.

## Specifiche estratte dal PRD
1. **Modulo Pagamenti (No In-App):**
   - Generatore pagamenti (Rette autogenerate, quote, divise) con rateizzazione e assegnazione massiva.
   - La transazione economica vera è esterna. La Segreteria marca il pagamento come "Saldato" manualmente.
   - Sistema di reminder aggressivi: push esatta scadenza + ogni 2 giorni per insoluti.
   - Dashboard Morosità per Segreteria. Interblocco con gite (Semaforo verde = Form Firmato + Quota Saldata).
2. **Fatturazione Elettronica (Aruba):**
   - Nessuna chiave API su frontend. Proxy backend (es. Node.js/Edge Function) per comunicare con SDI via Aruba.
   - Azione Esclusivamente Manuale: emissione solo su click. Nessun bollo automatico, Esenzione IVA Art. 10.
   - Flusso: intercetta scarti SDI. Genera e rendi disponibile PDF di cortesia ai genitori.
3. **Modulo Impostazioni (Super-Admin):**
   - Configurazione Multi-Sede (Tenant), orari lezioni, tolleranza insoluti, e abilitazione widget per grado.
4. **Sicurezza & Cloud Auth:**
   - Supabase è già online. Tuttavia, devi assicurare la rigida implementazione: **nessun auto-invito per i genitori**.
   - Solo la segreteria può invocare API interne per creare account genitore e forzare la relazione `parent_id` <-> `student_id`.
   - Implementare **Audit Log** su collection separata per modifiche anagrafiche.

## Agent Consigliati
Per massimizzare la qualità e l'affidabilità di questa fase, raccomandiamo l'uso dei seguenti sub-agent specializzati (configurazioni disponibili in `agents/awesome-claude-code-subagents-main/categories`):
- `@fintech-engineer.md` (07-specialized-domains) per l'implementazione sicura dell'integrazione proxy Aruba e gestione XML SDI.
- `@security-auditor.md` (04-quality-security) per stress-testare l'isolamento degli account e la policy "No Auto-Invito".

## Linee Guida Design (UI/UX)
- **Tassativo:** Tutte le interfacce utente sviluppate per questo modulo devono attenersi rigorosamente alle specifiche visive, alla palette cromatica e ai componenti definiti nel file `design.md` presente nella root del progetto. Consultalo prima di scrivere codice UI.

## Istruzioni Operative
1. **Cron & Backend:** Costruisci i worker per l'autogenerazione delle rette ricorrenti (il 1° del mese) e per lo scheduler dei reminder insoluti.
2. **Integrazione API Aruba:** Scrivi un servizio server-side isolato che mappa i dati anagrafici sull'XML richiesto da Aruba e gestisce il polling o i webhook di risposta SDI.
3. **RLS e Auth:** Verifica tutte le Row Level Security di Supabase affinché siano "Air-Tight" basandosi sulla relazione Parent-Student forzata in anagrafica. Nessun account deve poter leggere un DB record orfano.
4. **Interfacce Amministrative:** Sviluppa le complesse viste tabellari della Dashboard Morosità e del Pannello Super-Admin globale.
