# PRD: Modulo Gestione Form di Raccolta Dati (Kidville)

## 1. Descrizione Generale
La funzione "Form" di Kidville rappresenta il motore avanzato per la creazione, compilazione, gestione e validazione di moduli digitali. Pensato per sostituire integralmente il cartaceo, il sistema gestisce l'intero ciclo di vita del dato: dalla raccolta tramite interfacce utente lussuose e guidate, fino all'importazione automatizzata nelle anagrafiche principali del gestionale, passando per la validazione legale tramite Firma Elettronica Avanzata (FEA).

## 2. Obiettivi
- **Digitalizzazione Completa:** Gestire iscrizioni, deleghe, consensi (es. privacy/foto), sondaggi e creazione automatica di graduatorie.
- **Esperienza Premium (UX):** Offrire ai genitori un flusso di compilazione "wizard" (passo-passo, una pagina per persona) fluido e privo di stress cognitivo.
- **Gestione Staff Intuitiva:** Fornire agli amministratori un costruttore di form Drag & Drop altamente visivo.
- **Sicurezza e Validità Legale:** Garantire la protezione dei dati (tramite RLS in Supabase) e la validità delle firme tramite verifica OTP via Email.
- **Integrazione Nativa:** Automatizzare i flussi di ETL (Extract, Transform, Load) verso le anagrafiche direttamente tramite PostgreSQL.

## 3. Stack Tecnologico di Riferimento
- **Frontend:** Next.js 19, React, Tailwind CSS, Framer Motion (per micro-animazioni nei wizard), @dnd-kit/core (per il builder).
- **Backend & Database:** Supabase (PostgreSQL per dati relazionali e JSONB per campi dinamici), Supabase Auth.
- **Storage:** Supabase Storage.
- **Automazioni & ETL:** Trigger e funzioni PL/pgSQL nativi, pg_cron per task schedulati.
- **Generazione Documenti:** Server-side via API Routes (Next.js) integrato con librerie di generazione PDF (es. Puppeteer o PDFKit).

## 4. Requisiti Funzionali
### 4.1. Creazione e Configurazione Modelli (Form Builder)
- **Interfaccia Costruttore:** Area dedicata allo staff (Form > Modelli) dotata di un'interfaccia Drag & Drop per assemblare rapidamente i moduli.
- **Componenti Dinamici:** Possibilità di inserire blocchi predefiniti (Dati Bambino, Dati Adulto, Consensi, Caricamento Allegati) o campi personalizzati.
- **Logica Condizionale:** Impostazione di regole di visibilità e obbligatorietà basate sulle risposte precedenti.
- **Scoring per Graduatorie:** Il builder deve permettere l'assegnazione di un "peso" o "punteggio" (scoring) a specifiche risposte o blocchi (es. +5 punti per genitori lavoratori, +3 punti per fratelli già iscritti) per automatizzare la generazione delle graduatorie.
- **Configurazione Accessi:** Definizione di chi può compilare il form (utenti registrati o tramite link pubblico). Nota: Nessuna integrazione SPID richiesta.
- **Impostazioni FEA:** Abilitazione della Firma Elettronica Avanzata, definendo i firmatari richiesti (firma singola o congiunta di entrambi i genitori).

### 4.2. Compilazione Form (Lato Utente/Genitore)
- **Modalità di Rete:** Compilazione strettamente "Online-Only" per garantire l'immediata validazione degli OTP e la sicurezza dei caricamenti.
- **UX / UI Design:** Flusso "Wizard" (Step-by-step). L'interfaccia mostrerà una sezione alla volta (es. "Pagina 1: Dati Madre", "Pagina 2: Dati Padre", "Pagina 3: Dati Bambino") con transizioni fluide gestite da Framer Motion.
- **Firma Elettronica e OTP:** Al termine della compilazione, il sistema invierà un codice OTP via Email al firmatario per validare legalmente il documento prima dell'invio definitivo.
- **Caricamento Allegati:** Supporto per l'upload di documenti (es. carte d'identità, certificati medici) direttamente all'interno dei passaggi del wizard.

### 4.3. Gestione Compilazioni (Raccolta Dati)
- **Dashboard Raccolta:** Vista a tabella/lista per lo staff con filtri avanzati (data, stato, modello, tag).
- **Anteprima e Modifica:** Visualizzazione chiara dei dati JSONB raccolti. Possibilità per lo staff di applicare correzioni amministrative mantenendo un log della versione originale compilata dall'utente.
- **Generazione ed Esportazione:**
  - **Generazione PDF:** Gestita lato server per garantire un layout impeccabile e non gravare sul dispositivo dell'utente. I PDF escluderanno gli allegati fisici dalla stampa.
  - **Esportazione XLSX:** Download dell'intero dataset per analisi esterne.
  - **Integrazione Anagrafiche (ETL nativo):** I dati raccolti nei moduli di "Iscrizione" vengono riversati nelle tabelle anagrafiche principali di Kidville (Utenti, Bambini, Relazioni). Questo processo di mapping ed estrazione dai campi JSONB avviene direttamente nel database tramite funzioni e trigger PostgreSQL SQL, garantendo massima velocità e consistenza relazionale.

### 4.4. Gestione Graduatorie
- **Calcolo Punteggi:** Generazione automatica di liste di ammissione basate sui pesi/punteggi configurati nel Form Builder.
- **Dashboard Graduatorie:** Possibilità per lo staff di visualizzare il ranking, applicare correzioni manuali (override di punteggio per casi eccezionali) e deliberare le ammissioni.

## 5. Requisiti Non Funzionali e Sicurezza
### 5.1. Sicurezza e Storage (RLS)
- **Row Level Security (RLS) Rigorosa:** Le policy su Supabase Storage e Database devono essere strettissime. Gli allegati caricati durante la compilazione devono essere accessibili esclusivamente al compilatore originale e al personale amministrativo autorizzato (Staff). Nessun accesso pubblico o inter-utente.

### 5.2. Automazioni e Cron Jobs
- **Motore di Automazione Interno:** L'invio di solleciti per firme non completate, promemoria di scadenza moduli e altri task periodici sono gestiti interamente dal database utilizzando l'estensione pg_cron di PostgreSQL su Supabase. Nessun servizio esterno per l'orchestrazione dei job.

### 5.3. Performance e Accessibilità
- L'approccio server-side per i documenti complessi e l'utilizzo di viste materializzate / query JSONB ottimizzate in PostgreSQL garantiranno altissime performance anche con migliaia di compilazioni storiche archiviate.
- Compatibilità totale della web app su browser desktop e mobile.
