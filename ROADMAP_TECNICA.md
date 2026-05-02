# Roadmap Tecnica di Alto Livello - Kidville SaaS

Questa roadmap tecnica delinea le fasi di sviluppo per il SaaS Kidville, basata sul Product Requirements Document (PRD). L'obiettivo primario è sviluppare e rilasciare rapidamente le funzionalità core legate all'operatività didattica (Registro Elettronico, Presenze e Diario), considerando che l'infrastruttura di base (Database e Autenticazione Supabase) è già configurata.

## Fase 1: Core Registro Elettronico e Presenze (Mesi 1-2)
*Priorità massima alle funzionalità didattiche e di tracciamento degli alunni per garantire l'operatività di base nelle classi.*

*   **Modulo Presenze e Check-in/Check-out:**
    *   Appello offline-first con timestamp modificabile.
    *   Fase di Check-out con verifica visuale dei delegati (foto documento).
    *   Integrazione "Panic Alert" per ritiri non autorizzati e gestione assenze/giustifiche (lato genitore).
*   **Modulo Diario Scuola Primaria (Registro Elettronico):**
    *   Gestione appello orario e firme dei docenti (supporto compresenza).
    *   Inserimento argomenti della lezione, compiti assegnati e allegati multimediali.
    *   Sistema di valutazione ibrido (voti numerici e giudizi descrittivi) con isolamento per materia e calcolo automatico medie.
    *   Gestione note disciplinari/didattiche con richiesta di Firma per Presa Visione da parte del genitore.

## Fase 2: Gestione Nido/Infanzia e Anagrafica (Mesi 3-4)
*Estensione delle funzionalità didattiche ai più piccoli e consolidamento della sorgente dati (Anagrafica).*

*   **Modulo Diario 0-6 anni (Nido e Infanzia):**
    *   Data-entry rapido per categorie di routine (Entrata, Attività, Pasti, Nanna, Bagno/Igiene).
    *   Inserimento massivo (Bulk) filtrato in base agli alunni presenti.
    *   Timeline unificata per il genitore con notifiche push (buffer di sicurezza di 10 minuti).
*   **Modulo Anagrafica e Account Famiglia:**
    *   Completamento flussi operativi: Onboarding massivo e pre-iscrizioni.
    *   Gestione stato alunni, delegati e dati medico/didattici (allarmi allergie collegati alla mensa/diario).
*   **Modulo Armadietto (Nido/Infanzia):**
    *   Gestione scorte e catalogo materiali.
    *   Algoritmo a scalare collegato alle routine del Diario 0-6.
    *   Alert visuali ("a semaforo") per i genitori.

## Fase 3: Comunicazione e Multimedialità (Mesi 4-5)
*Creazione dei canali di comunicazione diretta tra scuola e famiglia nel rispetto rigoroso della privacy.*

*   **Modulo Comunicazione (Chat e Bacheca):**
    *   Chat 1-a-1 privata tra insegnante e singolo genitore (con traduzione automatica).
    *   Bacheca Avvisi e Circolari per comunicazioni globali o di classe (con richieste di adesione interattive e "Presa visione").
    *   Sistema Task/Bacheca interna per comunicazioni tra Segreteria e Staff.
*   **Modulo Foto e Video:**
    *   Galleria multimediale centralizzata con Bulk Upload.
    *   Sistema di "Privacy Tagging" vincolante: il media è visibile solo ai genitori dei bambini taggati (con Privacy Lock in caso di assenza liberatoria).
    *   Watermarking automatico.

## Fase 4: Modulistica, Burocrazia e Mensa (Mesi 6-7)
*Digitalizzazione del comparto burocratico/amministrativo e gestione avanzata della ristorazione.*

*   **Modulo Modulistica, Certificati e Onboarding Legale:**
    *   Form Builder dinamico per la Segreteria (Uscite didattiche, consensi).
    *   Integrazione Firma Elettronica Semplice (FES) e generazione ricevute PDF inattaccabili (log IP/Timestamp).
    *   Upload self-service di certificati medici per la riammissione rapida.
*   **Modulo Menu e Mensa:**
    *   Menu Builder con logica ciclica e associazione obbligatoria allergeni (alert incrociati con l'Anagrafica).
    *   Dashboard separata e dedicata per il Ruolo "Cuoca" (dati operativi e cut-off).
    *   Sistema a "Ticket Pasto" prepagato a scalare per alunno.

## Fase 5: Gestione Finanziaria e Impostazioni Avanzate (Mesi 8-9)
*Completamento con il tracciamento economico, le fatturazioni e il controllo globale da parte della Direzione.*

*   **Modulo Pagamenti:**
    *   Generatore di pagamenti universale (Rette, iscrizioni, quote extra) e gestione rateizzazioni.
    *   Scadenziario per i genitori con notifiche push e reminder aggressivi.
    *   Dashboard Morosità per l'amministrazione.
*   **Modulo Fatturazione Elettronica (Aruba):**
    *   Connessione API protetta backend-server verso Aruba (Nessuna chiave esposta).
    *   Emissione manuale guidata e gestione degli scarti SDI.
*   **Modulo Impostazioni (Pannello Super-Admin):**
    *   Gestione avanzata Multi-Tenant (Sedi).
    *   Definizione granulare di orari lezioni, scale di valutazione, e attivazione/disattivazione widget per grado d'istruzione.
*   **Modulo Sicurezza e Cloud Authentication:**
    *   Consolidamento dell'architettura Supabase (già configurata).
    *   Implementazione logica "Cloud Auth" rigida: nessun auto-invito per i genitori, creazione del legame univoco `parent_id` <-> `student_id` gestita esclusivamente dalla Segreteria.
    *   Implementazione Audit Log immutabile per il tracciamento delle modifiche anagrafiche.
