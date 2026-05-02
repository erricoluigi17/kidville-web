# Prompt Atomico: Fase 3 - Modulo Foto e Video (Galleria)

## Contesto Generale
Sei un AI Software Engineer Senior. Il tuo task è sviluppare il **Modulo Foto e Video** (Fase 3), una galleria multimediale sicura e compliance al GDPR.

## Obiettivo del Task
Implementare un sistema di caricamento media bulk e una galleria con Privacy Tagging rigoroso.

## Specifiche estratte dal PRD
1. **Upload e Organizzazione:**
   - Selezione Multipla (Bulk Upload) dalla galleria dispositivo dell'insegnante.
   - Nessun limite formato. Feed cronologico unico (nessun album). Pubblicazione diretta senza moderazione preventiva.
2. **Privacy Tagging e Privacy Lock:**
   - La foto caricata NON è visibile finché non viene taggato esplicitamente un alunno.
   - **Privacy Lock:** L'UI di tagging inibisce la selezione di bambini per i quali manca la firma della liberatoria privacy.
3. **Esperienza Genitore:**
   - Visualizzazione isolata: il genitore vede *solo* i media in cui il proprio figlio è taggato.
   - Possibilità di Download e Condivisione nativa. Sola lettura, no interazioni social.
4. **Strumenti Segreteria:**
   - Cancellazione globale media. Caricamento "Media Generici" in broadcast ignorando il tagging.
   - **Watermark Automatico:** Aggiunta automatica del logo della scuola in basso al centro di ogni foto caricata.

## Agent Consigliati
Per massimizzare la qualità e l'affidabilità di questa fase, raccomandiamo l'uso dei seguenti sub-agent specializzati (configurazioni disponibili in `agents/awesome-claude-code-subagents-main/categories`):
- `@security-auditor.md` (04-quality-security) per validare in modo inflessibile il Privacy Tagging e le liberatorie.
- `@backend-developer.md` (01-core-development) per gestire il job asincrono di watermarking e ottimizzazione media.

## Linee Guida Design (UI/UX)
- **Tassativo:** Tutte le interfacce utente sviluppate per questo modulo devono attenersi rigorosamente alle specifiche visive, alla palette cromatica e ai componenti definiti nel file `design.md` presente nella root del progetto. Consultalo prima di scrivere codice UI.

## Istruzioni Operative
1. **Cloud Functions:** Crea una funzione serverless per processare l'immagine in upload, applicando il watermark tramite librerie grafiche (es. Sharp) prima di salvare il file definitivo nello Storage.
2. **Database:** Struttura le tabelle `media_items` e `media_tags`. Usa le policies RLS per filtrare le query dei genitori unicamente sui `media_id` taggati con lo `student_id` associato.
3. **UI Insegnante:** Implementa il flusso di Bulk Upload e l'interfaccia di tagging (gestendo lo stato "disabilitato" per chi non ha la liberatoria).
4. **Prestazioni:** Usa CDN o trasformazioni on-the-fly per generare thumbnail ottimizzate per il feed cronologico.
