
> [!IMPORTANT]
> ## 📊 Stato Implementazione e Architettura Database
>
> ### Database
> Il software recupera, aggiorna e inserisce tutti i dati su un database relazionale PostgreSQL.
> - **Fase Demo/Sviluppo:** Supabase (PostgreSQL gestito, con API REST automatiche e RLS).
> - **Fase Produzione:** PostgreSQL self-hosted sul server dell'istituto.
>
> L'applicazione comunica con il database tramite API Routes server-side (Next.js), che utilizzano il client Supabase in demo e un client PostgreSQL diretto in produzione. Le credenziali sono isolate in variabili d'ambiente (`.env.local`).
>
> ### Schema Database Attivo
> Le tabelle attualmente create e operative su Supabase sono:
> | Tabella | Descrizione | RLS |
> |---------|-------------|-----|
> | `schools` | Anagrafica sedi (multi-tenant) | ✅ Policy anon SELECT |
> | `utenti` | Staff e genitori (FK → auth.users) | ✅ RLS attivo |
> | `alunni` | Anagrafica alunni con allergie | ✅ Policy anon SELECT |
> | `eventi_diario` | Eventi giornalieri del Diario 0-6 | ✅ SELECT + INSERT + UPDATE |
> | `legame_genitori_alunni` | Relazione genitore↔figlio | ✅ RLS attivo |
> | `valutazioni` | Voti e giudizi (Primaria) | Schema creato, non ancora popolato |
> | `galleria_media` | Foto/Video con privacy tagging | Schema creato, non ancora popolato |
> | `armadietto` | Inventario materiali a scalare | Schema creato, non ancora popolato |
> | `ticket_mensa` | Saldo ticket pasto prepagato | Schema creato, non ancora popolato |
> | `pagamenti` | Scadenziario rette e quote | Schema creato, non ancora popolato |
>
> ### Moduli Implementati
> | Modulo | Stato | Pagine | API Routes |
> |--------|-------|--------|------------|
> | **Diario 0-6** | ✅ Operativo | `/teacher/diary` | `/api/diary/students`, `/api/diary/entries` |
> | **Presenze** | 🔶 UI pronta | `/teacher/attendance`, `/parent/attendance` | `/api/panic-alert`, `/api/attendance/*` |
> | **Registro Primaria** | 🔶 UI pronta | `/teacher/register`, `/parent/register` | `/api/grades`, `/api/notes` |
> | **Armadietto** | ✅ Operativo | `/teacher/locker`, `/parent/locker` | `/api/locker/*` |
> | **Mensa** | ✅ Operativo | `/admin/mensa`, `/parent/mensa` | `/api/mensa/*` |
> | **Chat** | ✅ Operativo | `/teacher/chat`, `/parent/chat` | `/api/chat/*` |
> | **Pagamenti** | ✅ Operativo | `/admin/pagamenti`, `/parent/pagamenti` | `/api/pagamenti/*` |
> | **Modulistica** | ✅ Operativo | `/admin/forms`, `/parent/forms` | `/api/forms/*` |
> | **Foto/Video** | ✅ Operativo | `/teacher/gallery`, `/parent/gallery` | `/api/gallery/*` |
>
> ### 🎓 Moduli Normativi Scuola Primaria (gap da colmare)
> Requisiti derivati da L. 150/2024, O.M. 3 del 9/1/2025 (All. A), note MIM 5274/2024 e 2773/2025,
> D.M. 14/2024, Regolamento UE 2016/679 (GDPR), L. 4/2004 (Legge Stanca) e cooperazione SIDI.
> | Modulo | Stato | Priorità / Fase | Note |
> |--------|-------|-----------------|------|
> | **Valutazione conforme O.M. 3/2025** | ❌ Non conforme | Fase 1 | Oggi voti numerici: vietati alla primaria. Da convertire a motore ibrido per grado (vedi §4) |
> | **Orario / Tempo scuola / Materie master** | ❌ Da implementare | Fase 1 | `materia` oggi è testo libero; servono materie strutturate, campanelle, modelli 27/29/40h |
> | **Compresenza avanzata** | 🔶 Parziale | Fase 1 | Firme indipendenti presenti; manca firma con argomenti/compiti per singoli alunni + oscuramento |
> | **Vincoli temporali immodificabilità** | ❌ Da implementare | Fase 1 | Blocco 2gg classe/orali, 15gg scritti; sblocco solo dirigente |
> | **Scrutinio + Pagella online** | ❌ Da implementare | Fase 2 | 6 giudizi sintetici, Ed. Civica, comportamento; PDF statico (firma qualificata rimandata) |
> | **Fascicolo Personale + PEI/PDP** | 🔶 Parziale | Fase 2 | Oggi solo flag BES/DSA + delegati; serve fascicolo completo, RBAC ristretto, audit accessi |
> | **Libretto web giustificazioni** | 🔶 Parziale | Fase 2 | Esiste preavviso assenza; manca giustificazione online con PIN dispositivo |
> | **Interoperabilità SIDI / Piattaforma Unica** | ❌ Da implementare | Fase 3 | Import ZIP, Fase A, frequentanti, genitori-alunni, certificati competenze D.M. 14/2024 |
> | **Accessibilità AgID / Legge Stanca** | ❌ Da verificare | Trasversale | WCAG, alto contrasto, screen reader; tracciamento consensi e audit accessi dati sensibili |

# PRD - Kidville App: Modulo Anagrafica e Account Famiglia

## 1. Obiettivo del Modulo
Il modulo Anagrafica rappresenta il core relazionale del sistema Kidville. Centralizza i dati di
studenti, genitori e personale, fungendo da sorgente di verità per tutte le altre funzionalità (Mensa,
Pagamenti, Diario, Valutazioni). La struttura è progettata per supportare un modello SaaS multi-
sede, garantire l'operatività offline per i docenti e mantenere la rigorosa conformità GDPR.

## 2. Struttura Dati (Data Model)
### 2.1 Anagrafica Alunno (StudentModel)
***Dati Principali:** Nome, Cognome, Data di nascita, Luogo di nascita, Sesso, Codice Fiscale,
Indirizzo di residenza, Cittadinanza, Sede di appartenenza, Classe/Sezione.
***Stato dell'Alunno:** Iscritto, Non iscritto, Ritirato, Sospeso.
***Dati Medico/Mensa:** Allergie e Intolleranze (con blocco visivo in fase di appello/mensa).
***Dati Didattici:** Profilo BES (Si/No), Storico valutazioni, Note disciplinari, Accesso allo storico
del "Diario 0-6" degli anni precedenti.
***Gestione Delegati:** Lista dinamica di persone autorizzate al ritiro. Non vi è limite numerico.
Richiede esplicito caricamento del documento di identità del delegato. Nel caso di fratelli, la
delega va replicata per singolo alunno.
***Dati Finanziari (Connessione Payments):** Importo retta, Scadenza mensile del pagamento,
Eventuali sconti applicati (es. sconto fratelli).

### 2.2 Account Genitore (ParentModel)
***Dati Principali:** Corrispondenti a quelli dell'alunno, con l'obbligo di inserimento di Numero di
cellulare e Indirizzo Email.
***Gestione Identità:** Le famiglie sono gestite creando un account univoco e separato per
ciascun genitore. Nel caso in cui un membro dello staff (es. insegnante) sia anche genitore,
l'accesso avviene tramite un unico account globale che gestisce permessi incrociati.

## 3. Gestione Ruoli e Permessi (RBAC)
| Ruolo | Permessi di Lettura | Permessi di Azione e Scrittura |
|---|---|---|
| **Segreteria / Admin** | Accesso illimitato ai dati anagrafici della propria Sede di appartenenza. | Creazione, modifica e importazione dati. Trasferimento alunni tra sedi. Gestione inviti genitori e reset password staff. |
| **Insegnante** | Visibilità completa sull'anagrafica degli alunni in carico (dati medici, didattici e deleghe), con l'**esclusione assoluta** dei recapiti di contatto dei genitori. Visibilità dello storico limitata all'anno in corso. | Modalità *Sola Lettura*. Nessuna facoltà di modifica autonoma dei record anagrafici. |
| **Genitore** | Accesso all'anagrafica dei propri figli e al proprio profilo personale. | Può aggiornare in autonomia esclusivamente i propri recapiti di contatto e i documenti di identità in scadenza. Nessuna modifica ai dati core dell'alunno. |

## 4. Flussi Operativi e Funzionalità Core
### 4.1 Onboarding e Acquisizione Dati
***Form di Pre-iscrizione Esterno:** II sistema genera un link sicuro inviato ai nuovi iscritti. I
genitori compilano i moduli esternamente; la Segreteria importa i dati con un click, popolando in
automatico il database senza data-entry manuale.
***Assegnazione Massiva (Bulk):** Implementazione di una Ul tabellare nella dashboard Admin
che consente la selezione multipla degli alunni per l'assegnazione rapida a classi, sezioni o gruppi
mensa.

### 4.2 Amministrazione, Sicurezza e GDPR
***Audit Log di Sistema:** Tracciamento immutabile di tutte le modifiche anagrafiche in una
collection separata. La dashboard permette alla Segreteria di filtrare l'elenco cronologico delle
operazioni per singolo utente (Insegnante o Genitore).
**Recupero Credenziali:** Un pulsante dedicato all'interno dell'anagrafica permette alla
Segreteria di forzare il reset della password di un utente e re-inviarla via mail.
***Gestione Diritto all'Oblio:** In base alle normative GDPR, in caso di esplicita richiesta del
genitore, è previsto un flusso di *Hard Delete* che rimuove fisicamente i dati dai server,
bypassando il normale "Soft Delete" applicato in fase di ritiro/sospensione.

## 5. Specifiche Architetturali e di Sincronizzazione
***Moduli Coinvolti:** `src/app/(dashboard)/teacher/` (Pagine docente), `src/app/(dashboard)/parent/` (Pagine genitore), `src/app/api/` (API Routes server-side), `src/lib/supabase/` (Client DB).
***Database:** PostgreSQL. In fase demo il software si collega a **Supabase** (PostgreSQL gestito con API REST e Row Level Security). In produzione si collegherà a un **PostgreSQL self-hosted** sul server dell'istituto. Il cambio avviene modificando le variabili d'ambiente `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` nel file `.env.local`.
***Flusso Dati:** Ogni operazione dell'insegnante (compilazione entrata, pranzo, nanna, bagno, attività) genera una chiamata API al server che esegue un **UPSERT** sulla tabella `eventi_diario`: se per quel bambino+tipo_evento+data esiste già un record, viene aggiornato (UPDATE); altrimenti viene creato (INSERT). La lettura degli alunni avviene tramite SELECT sulla tabella `alunni` filtrata per `classe_sezione`.
***Cloud Authentication:** Relazione rigorosa e vincolata. I genitori non dispongono di codici di auto-invito; è unicamente la Segreteria a creare il legame parent_id <-> student_id ed effettuare l'onboarding. L'autenticazione è gestita tramite **Supabase Auth** (`auth.users` + `auth.identities`) con email/password.
***Offline-First per Docenti:** Le anagrafiche degli studenti vengono salvate in un database locale IndexedDB (tramite **Dexie.js**) per permettere l'appello e il registro offline. Un **Sync Engine** personalizzato (`src/lib/offline/syncEngine.ts`) si occupa di allineare i dati locali con il database centrale PostgreSQL non appena il dispositivo torna online. Le fotografie e i media pesanti sono esclusi dal caching per minimizzare l'impatto sulla memoria del dispositivo.
***Multi-Tenant:** La proprietà `scuola_id` (Sede di appartenenza, FK verso tabella `schools`) è obbligatoria su ogni tabella radice (`utenti`, `alunni`), garantendo isolamento logico dei dati tra plessi diversi all'interno dello stesso ambiente Kidville.

---

# PRD - Kidville App: Modulo Diario 0-6 anni (Nido e Infanzia)

## 1. Obiettivo del Modulo
Il modulo Diario 0-6 anni ha lo scopo di documentare la routine quotidiana dei bambini del Nido e
dell'Infanzia. È progettato per essere uno strumento di data-entry ultra-rapido per l'insegnante e
un feed di aggiornamento costante per il genitore, garantendo che ogni evento rilevante (pasti,
nanna, igiene) sia comunicato istantaneamente.

## 2. Logica degli Eventi e Routine
### 2.1 Categorie di Routine
Il sistema gestisce i seguenti eventi, ciascuno con campi specifici:
• Entrata: Registrazione dell'orario di arrivo.
• Attività: Tipo di attività, flag di partecipazione e modalità di coinvolgimento (descrizione testuale libera).
• Merenda Mattutina: Tipologia e quantità.
• Pranzo (Multi-Pasto): Diviso per portate (Primo, Secondo, Contorno, Frutta).
• Compilazione automatica: Se il menu del giorno è inserito nel modulo Mensa, i campi "portata" vengono popolati automaticamente.
• Livelli di consumo: Niente, Poco, Metà, Quasi tutto, Tutto, Bis.
• Nanna: Registrazione obbligatoria dell'orario di Inizio e Fine.
• Bagno / Igiene: Monitoraggio specifico di: Pipì, Cacca, Uso del Vasino (per potty training).

## 3. Esperienza Utente: Insegnante (Data-Entry)
### 3.1 Operatività e Velocità — Flusso Event-First + Bottom Sheet
Il data-entry segue un flusso sequenziale in **due step** per ridurre gli errori cognitivi:
- **Step 1 — Selezione Tipo di Evento:** La schermata principale mostra esclusivamente una griglia di pulsanti grandi e touch-friendly, uno per ciascun tipo di routine (Entrata, Attività, Merenda, Pranzo, Nanna, Sveglia, Bagno). La lista degli alunni non è visibile in questa fase.
- **Step 2 — Bottom Sheet con Controlli Inline:** Dopo aver toccato un evento, un pannello scorre dal basso (bottom sheet) mostrando la lista completa dei bambini presenti. I controlli specifici per l'evento appaiono **inline, accanto ad ogni bambino** — senza navigare su nuove pagine o aprire modali aggiuntivi. Il pulsante "Salva per tutti" chiude il pannello e sincronizza i dati.
- **Filtro Presenze:** Le sezioni di inserimento mostrano esclusivamente i bambini segnati come "Presenti" nel modulo Presenze. Gli assenti vengono rimossi automaticamente dalla lista per evitare errori di input.
- **Note Libere:** Ogni evento può essere integrato con note scritte a mano per una personalizzazione totale della comunicazione.

### 3.1.1 Campi Specifici per Tipo di Evento
- **Entrata:** Campo orario d'ingresso (pre-compilato con l'ora corrente, modificabile manualmente) per ogni bambino.
- **Attività:** Quattro pulsanti di partecipazione per ogni bambino: "Non fatta", "Con difficoltà", "Con aiuto", "In autonomia". Codice colore: rosso, arancio, giallo, verde.
- **Pranzo (Multi-Portata):** Per ogni bambino, una riga di pulsanti quantità (✗ Niente / ¼ Poco / ½ Metà / ¾ Quasi tutto / ★ Tutto) per **ciascuna portata del giorno** (Primo, Secondo, Contorno, Frutta). Se il menu del giorno prevede N portate, compaiono N righe per bambino. I bambini con allergie appaiono evidenziati in rosso.
- **Merenda:** Come il Pranzo, ma con una sola portata generica.
- **Nanna (Inizio):** Campo orario d'inizio del riposo pomeridiano per ogni bambino.
- **Sveglia (Fine Nanna):** Campo orario di fine riposo per ogni bambino.
- **Bagno/Igiene:** Due contatori cumulativi per bambino — **Pipì** (💧) e **Cacca** (💩) — con pulsanti + e − per incrementare/decrementare il conteggio. Il valore viene salvato come numero intero (es. "Pipì: 2, Cacca: 1").


### 3.2 Sicurezza e Validazione
• Dashboard Allergie: Fin dal mattino, la dashboard dell'insegnante evidenzia le allergie/intolleranze del giorno.
• Allerta Mensa: Nella sezione pasto, i bambini con allergie o intolleranze compaiono con il nome in rosso per richiamare l'attenzione immediata dell'operatore.
• Buffer di Modifica (10 Minuti): Per prevenire l'invio di notifiche errate, il sistema prevede una finestra di 10 minuti dal salvataggio durante la quale l'insegnante può modificare o annullare l'evento prima che la notifica push venga inoltrata al genitore.

## 4. Esperienza Utente: Genitore (Timeline)
### 4.1 Visualizzazione e Feedback
• Timeline Unificata: II genitore visualizza un flusso cronologico unico e verticale di tutti gli eventi della giornata (Timeline Feed).
• Notifiche Push: Il sistema invia una notifica push per ogni singolo evento registrato (dopo il buffer di 10 min), garantendo una trasparenza totale in tempo reale.
• Modalità Sola Lettura: La timeline è puramente informativa; non è prevista interazione (like o commenti) da parte del genitore.
• Multilingua Dinamico: Tutte le voci standard delle routine (es. "Ha dormito", "Pasto completo") vengono tradotte automaticamente nella lingua impostata sul dispositivo del genitore.

### 4.2 Privacy e Media
• Privacy Tagging: Le foto caricate nel diario possono taggare più bambini. La foto sarà visibile esclusivamente nella timeline dei genitori dei bambini taggati.

## 5. Amministrazione e Monitoraggio (Segreteria)
### 5.1 Configurazione e Controllo
• Customizzazione per Classe: La Segreteria può abilitare o disabilitare specifiche categorie di routine in base alla classe (es. disabilitare "Bagno/Cambio" per le classi dell'Infanzia che non ne necessitano).
• Dashboard di Monitoraggio: Uno strumento dedicato permette alla Segreteria di vedere in tempo reale quali classi stanno compilando il diario e quali sono inattive, facilitando il coordinamento didattico.
• Archiviazione e Storico:
  • I dati del diario oltre i 14 giorni non sono più consultabili dal genitore per ottimizzare le performance, ma rimangono accessibili alla Segreteria per controlli o audit.
  • Al passaggio del bambino alla Scuola Primaria, la sezione "Diario 0-6" scompare automaticamente dalla Ul del genitore, rimanendo visibile solo lato insegnante come archivio storico.

## 6. Specifiche Tecniche di Sincronizzazione
• Timestamp Offline: In caso di assenza di rete, il sistema registra l'orario effettivo in cui l'evento è accaduto (timestamp manuale o di inserimento locale) e lo sincronizza appena la connessione viene ripristinata.
• Disaccoppiamento Mensa: L'inserimento del consumo del pasto nel diario è logicamente separato dallo scalo del ticket mensa nel modulo pagamenti.

> [!NOTE]
> ### Stato Implementazione Diario 0-6
> **Implementato e operativo:**
> - ✅ Flusso Event-First con Bottom Sheet (Step 1 → Step 2)
> - ✅ Entrata: campo orario pre-compilato, inline per bambino
> - ✅ Attività: 4 livelli partecipazione (Non fatta / Con difficoltà / Con aiuto / In autonomia) con codice colore
> - ✅ Pranzo Multi-Portata: accordion per portata, pulsanti quantità (✗/¼/½/¾/★) per bambino
> - ✅ Merenda: come pranzo ma con portata singola
> - ✅ Nanna: orario inizio + orario fine unificati in una riga
> - ✅ Bagno: contatori +/- per Pipì (💧) e Cacca (💩)
> - ✅ Alert allergie visivo (nome in rosso, banner con elenco allergie)
> - ✅ Persistenza dati su Supabase (`eventi_diario`) con logica UPSERT
> - ✅ Ripristino stato da database al cambio sezione
> - ✅ Badge ✅ per alunni salvati, toast di conferma
> - ✅ Alunni caricati da database (`alunni` filtrati per `classe_sezione`)
>
> **Differenze rispetto al PRD:**
> - ⚠️ Il campo "Nanna" e "Sveglia" sono unificati in un unico pulsante "Nanna" con due input orario (inizio/fine), anziché due pulsanti separati come da PRD §3.1.1
> - ⚠️ Il filtro presenze (mostrare solo bambini "Presenti") non è ancora attivo — vengono mostrati tutti gli alunni della sezione
> - ⚠️ I nomi delle portate pranzo sono ancora mock (`MOCK_MEAL_COURSES`) — in futuro saranno caricati dal modulo Mensa via Supabase
> - ⚠️ Il buffer di modifica 10 minuti (§3.2) non è ancora implementato
> - ⚠️ Le note libere per evento non sono ancora esposte nell'interfaccia (il campo `nota_libera` esiste nel DB)
> - ⚠️ La timeline genitore (§4) non è ancora implementata

---

# PRD - Kidville App: Modulo Armadietto (Gestione Materiale Scolastico)

## 1. Obiettivo del Modulo
Il modulo Armadietto digitalizza la gestione dei materiali personali dei bambini (Nido e Infanzia),
sostituendo i biglietti cartacei e le comunicazioni verbali alla porta. Il sistema si basa su un
approccio ibrido: un inventario automatizzato a scalare per i beni di consumo continuo (es.
pannolini) e un sistema di alert "a semaforo" per le richieste puntuali, garantendo sempre la
massima chiarezza per i genitori e un basso carico cognitivo per lo staff.

## 2. Gestione Inventario e Tipologie di Materiale
### 2.1 Catalogo Materiali Multi-Tenant
• Materiali di Default: Il sistema prevede categorie base quali Pannolini, Asciugamani, Creme e Cambi completi.
• Personalizzazione Sede: Ogni scuola (tenant) ha la facoltà di configurare, aggiungere o rimuovere voci dalla propria lista predefinita tramite il pannello di Amministrazione.
• Richieste Custom: Oltre ai materiali in lista, l'insegnante dispone di un campo a testo libero per richiedere oggetti fuori standard.

### 2.2 Sistema a Scalare e Logica del Semaforo
La gestione delle scorte si basa su un algoritmo quantitativo:
• Carico Merci: Quando il genitore consegna il materiale, l'insegnante registra fisicamente l'ingresso nell'app, specificando i dettagli (es. marca, taglia e quantità totale di pannolini).
• Consumo Automatico: Ad ogni azione registrata nel modulo Diario 0-6 (es. cambio pannolino), il sistema scala automaticamente un'unità dal totale disponibile nell'armadietto.
• Alert Visivi (Semaforo): Il livello delle scorte viene comunicato cromaticamente:
  • Verde: Scorte sufficienti.
  • Giallo: Allerta di esaurimento (giacenza inferiore a 5 unità).
  • Rosso: Emergenza/Esaurito (giacenza inferiore a 2 unità).

## 3. Esperienza Utente: Insegnante (Data-Entry e Controllo)
• Indipendenza dalle Presenze: A differenza del Diario, le richieste di materiale non sono inibite se l'alunno è assente. L'insegnante può inoltrare l'avviso in modo che il genitore prepari il materiale per il rientro.
• Selezione Massiva (Bulk): Per ottimizzare i tempi, l'insegnante può selezionare più bambini contemporaneamente e inviare una richiesta collettiva per lo stesso materiale.
• Chiusura del Ciclo: Il ciclo di richiesta viene considerato "Chiuso" e risolto esclusivamente dall'insegnante nel momento in cui verifica la ricezione fisica del materiale in classe.
• Supporto Offline: Tutte le operazioni di richiesta o aggiornamento scorte sono garantite anche in assenza di connettività, salvate in cache locale e sincronizzate automaticamente alla ripresa del segnale di rete.

## 4. Esperienza Utente: Genitore (Notifiche e Interfaccia)
• UI "Lista della Spesa": All'interno dell'app del genitore, la sezione Armadietto mostra in modo chiaro le quantità residue dei materiali a scuola e funge da lista visiva per gli elementi mancanti richiesti dall'insegnante.
• Isolamento Profili: In caso di account multi-figlio, le notifiche e gli alert sono rigidamente associati al profilo (avatar) del singolo bambino.
• Notifiche e Reminder:
  • La richiesta genera un avviso immediato al momento dell'invio da parte dell'insegnante.
  • Il sistema prevede un Reminder Automatico schedulato per le ore 07:00 del mattino seguente, per massimizzare la probabilità che il genitore non dimentichi il materiale.
• Feedback di Rassicurazione: Alla ricezione della notifica, il genitore può cliccare un pulsante di acknowledgment (es. "Preso in carico" / "Lo porto domani"), che aggiorna in tempo reale lo stato lato insegnante.
• Accesso allo Storico: L'interfaccia genitore non prevede l'accesso a uno storico delle richieste pregresse per mantenere l'Ul pulita ed essenziale.

## 5. Amministrazione e Monitoraggio (Segreteria)
• Abilitazione per Grado Scolastico: La Segreteria può disattivare integralmente il widget Armadietto per specifiche classi o gradi d'istruzione (es. Scuola Primaria, dove la gestione cambia radicalmente rispetto a Nido/Infanzia).
• Dashboard delle Inadempienze: La Direzione ha a disposizione un pannello di controllo per monitorare le richieste inevase. Il sistema evidenzia i genitori che non hanno fornito il materiale dopo un periodo critico, permettendo solleciti mirati.
• Log degli Ingressi: Per ragioni di trasparenza, il sistema archivia e storicizza esclusivamente gli eventi di "Carico Materiale" (cosa è stato portato e quando). Le mere richieste transitorie non vengono storicizzate, mantenendo il database leggero e ottimizzato.

---

# PRD - Kidville App: Modulo Diario Scuola Primaria (Registro Elettronico)

## 1. Obiettivo del Modulo
Il modulo "Diario Scuola Primaria" funge da vero e proprio Registro Elettronico ufficiale. A
differenza del Nido/Infanzia, questo strumento gestisce logiche didattiche e ministeriali (valutazioni
conformi alla normativa, note, argomenti delle lezioni, presenze orarie). È progettato per garantire
l'isolamento delle discipline tra i docenti, fornire una reportistica chiara ai genitori e supportare la
direzione scolastica nella valutazione periodica e negli adempimenti di scrutinio.

## 2. Appello, Orario e Registro di Classe
### 2.1 Gestione Presenze
• Stati di Presenza: L'insegnante può registrare quattro stati: Presente, Assente, Ritardo e Uscita Anticipata.
• Firma del Docente: La validazione della presenza del docente (firma del registro) avviene tramite un semplice "tap" sull'ora di lezione di riferimento.
• Compresenza: Il sistema supporta l'assegnazione di più docenti alla stessa classe nella stessa ora. Ogni insegnante firma il registro in modo indipendente e personale per la propria quota oraria.

### 2.2 Orario delle Lezioni
• Configurazione Centralizzata: L'orario settimanale e l'assegnazione delle materie sono preimpostati e gestiti esclusivamente dalla Segreteria tramite il pannello Admin.
• Visualizzazione Genitore: Le famiglie hanno accesso a una sezione dedicata in app dove possono consultare l'orario settimanale completo e le materie specifiche previste per il proprio figlio.

## 3. Gestione della Didattica (Argomenti e Compiti)
• Compilazione della Lezione: Contestualmente alla firma dell'ora, l'insegnante è tenuto a inserire l'argomento svolto in classe e i compiti assegnati per casa.
• Allegati Multimediali: Per entrambe le voci (argomenti e compiti), il docente ha la possibilità di allegare file multimediali (es. foto della lavagna, pagina del libro o schede).
• Visibilità e Assegnazione Compiti:
  • I compiti appaiono in una bacheca dedicata nell'app genitore/alunno.
  • Nessuna Notifica: L'assegnazione dei compiti non genera notifiche push (modalità consultazione pull).
  • Sola Lettura: Non è prevista una funzione di spunta o contrassegno "Svolto" lato genitore/alunno.
  • Recupero Assenti: I compiti assegnati e gli argomenti svolti rimangono visibili alle famiglie degli alunni risultati "Assenti" in quella giornata, garantendo il diritto al recupero.

## 4. Sistema di Valutazione e Voti

> [!IMPORTANT]
> **Adeguamento normativo (L. 1 ottobre 2024, n. 150 e O.M. n. 3 del 9 gennaio 2025).**
> Nella scuola primaria i **voti numerici sono vietati**, sia in itinere sia in sede di scrutinio.
> Il modello precedente (voti 1-10 + livelli Base/Intermedio/Avanzato dei riferimenti 2020) è
> **superato** e va sostituito. Lo stato attuale del codice ([GradesTab.tsx](src/components/features/teacher/register/GradesTab.tsx),
> tabella `valutazioni` con `voto_numerico`/`giudizio_testo`) **non è conforme** per la primaria.

### 4.1 Motore di Valutazione Ibrido (configurabile per grado)
Il sistema espone un **unico motore di valutazione**, il cui comportamento è determinato da una
configurazione a livello di Admin per **grado d'istruzione / sezione**:
• **Primaria:** modello a **giudizi** conforme O.M. 3/2025. La modalità a voti numerici è disabilitata
  e non selezionabile dal docente.
• **Altri gradi (es. eventuale secondaria di primo grado):** può essere abilitata la modalità a voti
  numerici classici (1-10) con categorizzazione Scritto/Orale/Pratico.
• La configurazione è impostata dalla Segreteria/Dirigenza e applicata automaticamente in base alla
  classe dell'alunno: il docente non sceglie il "sistema di voto", lo eredita dal contesto.

### 4.2 Valutazione in Itinere (Primaria) — per Obiettivi di Apprendimento
La valutazione quotidiana mantiene **funzione formativa** e si articola così:
• **Obiettivi di Apprendimento:** prima di inserire qualsiasi valutazione, il docente associa alla
  propria disciplina gli obiettivi di apprendimento estratti dal **curricolo d'istituto** (definiti per
  classi parallele). Gli obiettivi sono gestiti come anagrafica configurabile (Admin/Dirigenza).
• **Valutazione per Dimensioni:** una prova viene legata a uno o più obiettivi e descritta tramite le
  quattro dimensioni cardine:
  1. **Autonomia** (Sì / No)
  2. **Continuità** (Sì / No)
  3. **Tipologia della situazione** (Nota / Non nota)
  4. **Risorse mobilitate** (Interne / Esterne / Entrambe)
• **Giudizio descrittivo auto-generato:** sulla base delle dimensioni il sistema propone un giudizio
  descrittivo testuale, **pienamente modificabile** dall'insegnante.
• **Giudizio sintetico in itinere (alternativa):** in alternativa al descrittivo esteso, il docente può
  registrare direttamente un giudizio sintetico abbreviato (es. Buono, Sufficiente) correlato
  all'obiettivo testato, per semplificare la visualizzazione nel prospetto.
• **Nessun voto numerico** alla primaria, in nessuna delle due modalità.

### 4.3 Scrutinio Periodico e Finale (Primaria) — Sei Giudizi Sintetici
In sede di scrutinio (intermedio e finale), il team dei docenti contitolari attribuisce a ciascun
alunno, **per ogni disciplina del curricolo** (compresa l'**Educazione Civica**), un unico **giudizio
sintetico** correlato al livello di apprendimento raggiunto. La scala è quella dell'**Allegato A
dell'O.M. 3/2025**, implementata in modo rigido (non rimodulabile nelle definizioni standard):

| Giudizio sintetico | Livello |
|--------------------|---------|
| **Ottimo** | Autonomia e consapevolezza piene anche in situazioni complesse e non note |
| **Distinto** | Buona autonomia, errori rari, gestione positiva di situazioni nuove simili a quelle note |
| **Buono** | Attività portate a termine con autonomia, in situazioni note |
| **Discreto** | Autonomia parziale, prevalentemente in situazioni note e con risorse fornite |
| **Sufficiente** | Attività essenziali svolte solo in situazioni note e con supporto/risorse esterne |
| **Non sufficiente** | Esecuzione incerta e non adeguata al contesto, anche con supporto |

• **Declinazioni locali (PTOF):** pannello di configurazione lato Admin/Dirigente per importare le
  declinazioni dei descrittori deliberate dagli organi collegiali, che integrano/sostituiscono i testi
  standard in pagella (le definizioni della scala restano comunque ancorate all'Allegato A).
• **Giudizio di comportamento:** espresso collegialmente come giudizio sintetico (no decimi).
• Il giudizio di scrutinio può essere proposto a partire dal quadro delle valutazioni in itinere, ma
  resta **modificabile/sovrascrivibile** collegialmente dal team docenti.

### 4.4 Isolamento delle Materie e Riservatezza tra Colleghi
• La visibilità delle valutazioni è limitata alla **propria disciplina**: un docente non accede alle
  valutazioni assegnate allo stesso alunno da docenti di altre materie.
• Eventuali aggregazioni/prospetti d'insieme sono riservate al team in sede di scrutinio e alla Dirigenza.

### 4.5 Comunicazione alle Famiglie
• **Buffer di Sicurezza:** all'inserimento di una valutazione il sistema attende 10 minuti prima di
  inviare la notifica push e renderla visibile, per consentire correzioni.
• **Nessuna firma richiesta** per le normali valutazioni in itinere.
• **Persistenza Visiva:** in caso di account genitore sospeso (ritardi amministrativi), i dati del
  registro (valutazioni e compiti) restano comunque visibili, a tutela del diritto all'informazione didattica.

### 4.6 Note di Migrazione Dati
La struttura attuale (`valutazioni.voto_numerico`, `valutazioni.giudizio_testo`, `materia` testo libero)
va evoluta verso un modello che supporti: riferimento a **materia master** (vedi §6 Orario e Materie),
**obiettivi di apprendimento**, le **quattro dimensioni**, il **giudizio sintetico** (enum vincolato per
la primaria) e una distinzione tra valutazione *in itinere* e *di scrutinio*. La modalità a voti numerici
resta supportata a schema solo per i gradi non-primaria.

## 5. Note e Provvedimenti Disciplinari
• Categorizzazione Cromatica: Le note sono suddivise in tre categorie distinte, differenziate visivamente (tramite colori/icone) sull'app del genitore:
  1. Nota Disciplinare (Comportamento)
  2. Nota Didattica (Es. materiale dimenticato)
  3. Compiti a casa non svolti
• Assegnazione Massiva: L'insegnante può selezionare più alunni (o l'intera classe) e assegnare una nota collettiva con un'unica operazione.
• Firma per Presa Visione: A differenza dei voti, le Note Disciplinari richiedono obbligatoriamente l'interazione del genitore, che deve apporre una firma digitale per "presa visione" direttamente dall'applicazione, confermando la ricezione della comunicazione.

## 6. Orario, Tempo Scuola e Materie
La primaria adotta la **contitolarità** (più docenti sulla stessa classe) e diversi modelli di tempo
scuola. Il sistema supera la logica "una materia in testo libero per ora" introducendo dati strutturati.

### 6.1 Materie Master (Discipline)
• Anagrafica delle **discipline** gestita dalla Segreteria/Dirigenza (es. Italiano, Matematica, Storia,
  Geografia, Scienze, Inglese, Arte, Musica, Ed. Fisica, Tecnologia, Religione/Alternativa).
• **Educazione Civica** come disciplina trasversale dedicata (oggetto di valutazione autonoma a scrutinio).
• **Mensa** modellabile come **turno/disciplina** del tempo scuola (vedi §6.3), associabile anche a
  gruppi-classe quando gli alunni provengono da classi diverse.
• Valutazioni (§4) e firme di lezione si **agganciano alla materia master** (non più testo libero).

### 6.2 Campanelle e Matrice Oraria
• Definizione delle **"campanelle"** (intervalli orari di lezione) per plesso/classe.
• Matrice oraria settimanale che associa, per ciascuna campanella, **classe → materia → docente/i**.
• Gestione molti-a-molti per contitolarità (più docenti sulla stessa ora/classe).

### 6.3 Modelli di Tempo Scuola
• Configurazione per plesso/classe dei modelli: **Tempo Normale (27 o 29 ore)** e **Tempo Pieno (40 ore)**.
• Nel tempo pieno, l'orario include mensa e ricreazione come tempo scuola a tutti gli effetti.

### 6.4 Configurazione e Visibilità
• L'orario settimanale e l'assegnazione materie sono **gestiti dalla Segreteria** (pannello Admin).
• Le famiglie consultano in app l'**orario settimanale** e le materie previste per il proprio figlio.

## 7. Compresenza e Firma del Registro
### 7.1 Firma di Lezione
• La firma dell'ora avviene con un "tap" sulla campanella; contestualmente il docente inserisce
  **argomento svolto** e **compiti** (con eventuali allegati, vedi §3).

### 7.2 Compresenza — Cofirma Digitale
• Più docenti possono accedere alla **stessa ora/classe**. Il secondo docente (es. sostegno o
  potenziamento) può apporre la propria **cofirma** sull'argomento inserito dal docente ordinario,
  selezionando la **tipologia di compresenza** dal pannello.

### 7.3 Firma Indipendente per Alunni Specifici (oscuramento)
• Quando il docente di sostegno svolge **attività individualizzate** non coincidenti con la
  programmazione di classe, può firmare la medesima ora ma indirizzare **argomento, compiti e note
  esclusivamente a uno o più alunni selezionati**.
• Tali contenuti sono **oscurati alle famiglie degli altri alunni** per ragioni di riservatezza
  (visibilità ristretta ai soli destinatari).

## 8. Vincoli Temporali e Immodificabilità delle Registrazioni
Il registro elettronico ha natura di **atto pubblico**: inserimenti e modifiche sono tracciati e
sottoposti a vincoli temporali.

| Operazione | Termine massimo (default, configurabile) |
|------------|------------------------------------------|
| Modifica annotazioni del registro di classe | 2 giorni dall'evento |
| Inserimento valutazioni per prove orali | 2 giorni dallo svolgimento |
| Inserimento valutazioni per prove scritte/pratiche | 15 giorni dallo svolgimento |

• **Configurabilità:** i termini sono impostabili dall'istituto (con i valori di default sopra).
• **Blocco automatico:** oltre la scadenza il sistema impedisce inserimenti/modifiche.
• **Sblocco riservato:** solo Dirigente/Supervisor può sbloccare, **previa richiesta motivata**.
• **Tracciamento:** ogni inserimento, modifica e sblocco è registrato nell'audit (`registro_modifiche`):
  utente, azione, valore precedente/nuovo, timestamp, IP.

## 9. Scrutinio e Pagella Online
### 9.1 Workflow di Scrutinio
• Sessione collegiale del **team docenti contitolari**: per ogni alunno si consolidano i giudizi
  sintetici per disciplina + Educazione Civica + comportamento (vedi §4.3).
• La Dirigenza coordina e chiude la sessione di scrutinio (periodico e finale).

### 9.2 Documento di Valutazione (Pagella) — Livello Base
• Al termine dello scrutinio il sistema **genera il documento di valutazione in PDF statico** non modificabile.
• Le famiglie scaricano la pagella dall'area riservata, con l'**autenticazione attuale dell'app**.

> [!NOTE]
> **Conformità firma rimandata.** In questa fase la pagella **non** prevede firma digitale qualificata
> del Dirigente, né contrassegno elettronico, né download previa autenticazione forte SPID/CIE.
> Tali requisiti (integrazione certificatori di firma qualificata e identità digitale) sono pianificati
> come **fase successiva** e andranno aggiunti per la piena dematerializzazione a norma.

---

# PRD - Kidville App: Modulo Foto e Video (Galleria Multimediale)

## 1. Obiettivo del Modulo
Il modulo "Foto e Video" funge da hub centralizzato per la condivisione dei media scolastici. È un
widget trasversale, abilitato per tutti i gradi d'istruzione (Nido, Infanzia, Primaria). Il sistema è
progettato attorno a un rigoroso meccanismo di "Privacy Tagging", garantendo la totale aderenza
al GDPR e tutelando l'immagine dei minori, pur mantenendo un'esperienza di consultazione fluida
per le famiglie.

## 2. Caricamento e Gestione Media (Lato Insegnante)
### 2.1 Upload e Organizzazione
• Selezione Multipla (Bulk Upload): I docenti possono caricare simultaneamente più foto e video dalla galleria del proprio dispositivo.
• Nessun Limite di Formato: Non sono previsti limiti stringenti sulla durata dei video caricati.
• Feed Cronologico Unico: Non è prevista la creazione di cartelle o "Album" tematici. Tutti i media confluiscono in un unico feed verticale ordinato cronologicamente dal più recente al meno recente.
• Pubblicazione Diretta: L'upload da parte dell'insegnante è istantaneo e non richiede l'approvazione o la moderazione preventiva da parte della Segreteria.

### 2.2 Meccanismo di Tagging e Privacy Lock
• Regola del Tag Obbligatorio: Un contenuto multimediale viene caricato sui server, ma non è visibile a nessun genitore finché l'insegnante non effettua il tagging esplicito.
• Lista Completa: L'interfaccia di tagging mostra la lista completa degli alunni della classe (non filtrata per presenze giornaliere), permettendo al docente di selezionare chi è ritratto.
• Blocco Liberatoria Privacy: Il sistema implementa un blocco di sicurezza (Privacy Lock). Se per un determinato alunno la famiglia non ha firmato la liberatoria per l'uso delle immagini, il sistema inibisce l'interfaccia, impedendo fisicamente all'insegnante di selezionare e taggare quel bambino.

## 3. Esperienza Utente: Genitore (Visualizzazione e Interazione)
### 3.1 Visualizzazione Isolata
• Filtro Assoluto: II genitore ha accesso unicamente ai contenuti multimediali in cui il profilo del proprio figlio è stato esplicitamente taggato dall'insegnante. Foto di gruppo o di altri bambini in cui il figlio non compare sono totalmente invisibili e inaccessibili.
• Interazione in Sola Lettura: La galleria ha uno scopo puramente documentale. Non sono previste interazioni social (nessun "Mi piace", né commenti).

### 3.2 Azioni sui Media
• Download: I genitori sono autorizzati a scaricare liberamente foto e video sulla memoria locale del proprio smartphone.
• Condivisione Nativa: È presente un pulsante "Condividi" che permette di esportare il media verso app di terze parti (es. WhatsApp, Telegram) sfruttando le funzionalità native del sistema operativo del telefono.

## 4. Strumenti di Amministrazione e Sicurezza (Segreteria)
### 4.1 Moderazione e Controllo
• Cancellazione Globale: La Direzione/Segreteria detiene i diritti di amministrazione assoluta e può eliminare istantaneamente qualsiasi foto o video dal database e dal feed di tutti gli utenti, intervenendo rapidamente in caso di segnalazioni.

### 4.2 Comunicazioni Istituzionali (Bypass Tagging)
• L'Amministrazione ha a disposizione uno strumento per caricare "Media Generici" (es. locandine di eventi, foto della struttura vuota, comunicazioni visive). Per questi caricamenti, la Segreteria può bypassare il meccanismo di tagging e inviare il file in broadcast a tutti i genitori dell'istituto o a classi specifiche.

### 4.3 Tutela dell'Immagine (Watermark)
• Watermark Automatico: Per tutelare la provenienza e la proprietà delle immagini scolastiche, l'applicazione applica in automatico in fase di caricamento un watermark contenente il logo della scuola. Questo viene posizionato di default al centro in basso su ogni singola foto caricata dai docenti.

## 5. Interconnessioni Architetturali
• Sincronizzazione con "Diario 0-6": Il modulo Galleria funziona come collettore centrale. Le foto scattate e taggate direttamente all'interno delle attività del Diario Nido/Infanzia (es. lavoretto, momento della merenda) confluiscono automaticamente e in tempo reale in questo widget, evitando duplicazioni di caricamento per il docente.

---

# PRD - Kidville App: Modulo Presenze e Check-in/Check-out

## 1. Obiettivo del Modulo
Il modulo Presenze è il sistema centrale per il tracciamento fisico degli alunni all'interno della
struttura scolastica. Copre l'intero ciclo giornaliero (dall'ingresso all'uscita), gestisce in modo
sicuro le deleghe di ritiro e funge da "sorgente di verità" per abilitare o disabilitare l'operatività di
altri moduli (come il Diario e il Registro di Classe).

## 2. Esperienza Utente: Insegnante (Appello e Uscita)
### 2.1 Fase di Check-in (Ingresso)
• Vista di Classe: L'insegnante visualizza esclusivamente la lista degli alunni assegnati alla propria classe.
• Logica "Empty State": All'apertura della schermata di appello, la lista si presenta non compilata (nessun "Presente" di default).
• Timestamp Automatico e Modificabile: Un semplice tap sul nome dell'alunno segna lo stato "Presente" e l'app registra automaticamente l'orario di ingresso (Check-in) basato sull'orologio di sistema. Qualora l'alunno fosse entrato precedentemente e l'insegnante stesse compilando il registro in ritardo, l'orario di Check-in può essere modificato manualmente.

### 2.2 Fase di Check-out (Uscita) e Sicurezza
• Registrazione Uscita: A fine giornata (o in caso di uscita anticipata), l'insegnante esegue il "Check-out", registrando l'orario effettivo di uscita dalla struttura.
• Verifica Delegati: L'insegnante non è tenuto a selezionare manualmente chi ha ritirato il bambino, ma ha a disposizione un rapido accesso in sola lettura alla lista dei delegati autorizzati.
• Riconoscimento Visivo: Aprendo la scheda delegati, l'insegnante visualizza in tempo reale la foto del documento d'identità caricato in precedenza dalla famiglia, permettendo un riconoscimento visivo immediato e sicuro.
• Allarme Ritiro Non Autorizzato (Panic Alert): Qualora si presenti una persona non presente nella lista dei delegati, l'insegnante ha a disposizione un pulsante di blocco/allerta. La pressione del tasto genera una notifica istantanea simultanea alla Segreteria e all'App del Genitore, bloccando l'uscita dell'alunno.

### 2.3 Operatività Offline
• Caching Locale: Tutte le operazioni di Check-in e Check-out sono garantite anche in assenza di rete. I dati vengono salvati nella cache locale e sincronizzati automaticamente con il cloud al ripristino della connettività.

## 3. Esperienza Utente: Genitore (Assenze e Giustifiche)
• Comunicazione Silenziosa: Non sono previste notifiche push in tempo reale per i normali eventi di Check-in e Check-out, per evitare di sovraccaricare il genitore con avvisi considerati di routine.
• Preavviso di Assenza: Il genitore può inserire preventivamente, in totale autonomia tramite l'App, un avviso di assenza (es. per malattia o motivi familiari) prima dell'inizio delle lezioni.
• Caricamento Certificati Medici: In caso di assenza prolungata (es. superiore ai giorni previsti dal regolamento), l'interfaccia richiede e permette al genitore l'upload diretto del certificato medico di riammissione, che andrà in validazione alla Segreteria.

### 3.1 Libretto Web — Giustificazione Online (con PIN dispositivo)
• **Giustificazione online:** in presenza di assenza, ritardo o uscita anticipata registrati dal docente,
  l'area genitore abilita la funzione di **giustificazione digitale** dell'evento.
• **PIN dispositivo:** l'operazione è protetta dall'inserimento di un **codice PIN dispositivo** scelto
  dal genitore, per prevenire utilizzi non autorizzati (equivalente digitale del libretto cartaceo).
• **Tracciamento:** ogni giustificazione registra autore, evento giustificato, motivazione, timestamp e
  presa visione; lo storico è consultabile da genitore e Segreteria.
• **Integrazione:** la funzione si lega agli eventi del modulo `presenze` e al flusso certificati medici
  esistente; più tutori dello stesso alunno mantengono libretti/PIN distinti.

## 4. Dashboard Amministrazione e Cucina
### 4.1 Monitoraggio Segreteria
• Fotografia Globale: La dashboard della Segreteria mostra una panoramica in tempo reale degli alunni presenti in tutta la struttura, con la possibilità di cliccare ed effettuare un "drill-down" (dettaglio) per visualizzare i numeri specifici di ogni singola classe.
• Sovrascrittura Dati: La Direzione possiede i permessi di amministrazione per modificare, correggere o sovrascrivere eventuali errori di registrazione (presenze/assenze) commessi dagli insegnanti.
• Export Ministeriale: È presente una funzione di esportazione (in formato Excel/PDF) dei registri di presenza validi ai fini dei controlli MIUR per Nido, Infanzia e Primaria.

### 4.2 Dashboard Cucina e Cut-off Mensa
• Orario di Cut-off: II limite orario (es. 09:30) per l'invio dei numeri definitivi dei pasti viene gestito direttamente dalla Dashboard della Cucina.
• Approvazione Ritardi: Se un alunno entra in Ritardo (post cut-off), la sua presenza viene registrata, ma l'aggiunta del suo pasto alla lista della cucina richiede un'approvazione manuale da parte della Segreteria.

## 5. Interconnessioni Architetturali e di Flusso
• Isolamento Finanziario: II tracciamento delle presenze/assenze non ha alcun impatto automatizzato sulla fatturazione o sulle rette mensili gestite nel modulo Pagamenti.
• Disaccoppiamento Mensa: Segnare un bambino "Presente" non consuma automaticamente il ticket pasto. Le due azioni (Check-in fisico e consumo del pasto nel Diario) rimangono logicamente separate per l'insegnante.
• Sincronizzazione Diario 0-6: Un alunno che non è marcato "Presente" in questo widget globale scompare automaticamente dalle liste di selezione multipla del Diario di Bordo (Nido/Infanzia), prevenendo l'inserimento accidentale di routine (es. pasti, nanna) per bambini non a scuola.
• Sincronizzazione Primaria: Allo stesso modo, lo stato di "Assente" nel modulo Presenze generale si riflette in automatico nel Registro di Classe della Scuola Primaria.

---

# PRD - Kidville App: Modulo Comunicazione (Chat e Bacheca Avvisi)

## 1. Obiettivo del Modulo
Il modulo Comunicazione centralizza tutti i flussi informativi della piattaforma Kidville. È suddiviso
in tre macro-aree logiche: la messaggistica istantanea (Chat) per il dialogo quotidiano e privato tra
scuola e famiglia, la Bacheca per le comunicazioni ufficiali (Circolari/Avvisi) e un sistema di Task
interno per il coordinamento dello staff. Il modulo è progettato per abbattere le barriere
linguistiche e garantire il pieno controllo amministrativo da parte della Direzione.

## 2. Chat Privata (Scuola - Famiglia)
### 2.1 Logica e Inoltro Messaggi
***Comunicazione 1-a-1:** La messaggistica è rigorosamente individuale. Non sono previsti "Gruppi Classe" tra genitori.
***Isolamento Genitoriale:** In caso di più tutori per lo stesso bambino (es. genitori separati), le chat rimangono distinte. Ogni genitore ha un thread separato con l'insegnante.
***Vincolo di Contatto:** I genitori possono avviare e intrattenere chat esclusivamente con gli insegnanti assegnati alla classe del proprio figlio.
***Operatività H24:** II sistema permette l'invio e la ricezione di messaggi 24 ore su 24, senza blocchi orari imposti dal sistema.

### 2.2 Funzionalità Multimediali e Accessibilità
***Condivisione File:** All'interno della chat è pienamente supportato l'invio di allegati multimediali, inclusi documenti (PDF), fotografie e note vocali.
***Traduzione Automatica:** Per favorire l'inclusione, il modulo integra un sistema di traduzione automatica in tempo reale, permettendo agli insegnanti e alle famiglie straniere di comunicare efficacemente ciascuno nella propria lingua madre.

## 3. Bacheca e Avvisi Ufficiali (Circolari)
### 3.1 Creazione e Targeting
***Permessi di Invio:** La Segreteria può inviare comunicazioni a livello globale (intero istituto) o filtrarle per classi specifiche. Anche il singolo Insegnante ha i permessi per creare e pubblicare avvisi, limitatamente alla propria classe di competenza.
***Tipologia di Avviso:**
***Presa Visione:** L'apertura e la lettura dell'avviso da parte del genitore registra automaticamente la "Presa visione" a sistema (Read Receipt).
***Richiesta di Adesione:** Per avvisi che richiedono un'autorizzazione (es. gita scolastica), il sistema abilita pulsanti interattivi che permettono al genitore di esprimere una conferma (Si) o un diniego (No) esplicito.

### 3.2 Monitoraggio
***Dashboard Avvisi:** L'interfaccia di Segreteria e dell'Insegnante include un cruscotto di monitoraggio per ogni avviso inviato. Mostra in tempo reale l'elenco di chi ha letto la comunicazione e un recap tabellare delle risposte per le richieste di adesione.

## 4. Comunicazione Interna (Gestione Task Staff)
***Dashboard Segreteria-Insegnanti:** La comunicazione organizzativa interna non avviene tramite chat, ma attraverso un sistema a bacheca/task.
***Assegnazione Comunicazioni:** Se un genitore lascia un messaggio in Segreteria o se c'è una direttiva interna, la Direzione crea un "Task/Comunicazione" assegnandolo a una classe intera (visibile a tutti i docenti di quella sezione) oppure a un singolo insegnante specifico.

## 5. Sicurezza e Amministrazione (Direzione)
### 5.1 Permessi di "Super-Admin"
* La Direzione/Segreteria dispone di privilegi di livello Super-Admin. Questo garantisce la facoltà di accedere in sola lettura e in chiaro a tutte le chat private intercorse tra insegnanti e genitori, al fine di tutelare l'istituto e risolvere eventuali controversie.

### 5.2 Persistenza dei Dati
***Conservazione Storico:** I thread di chat non vengono mai cancellati automaticamente (nemmeno al termine dell'anno scolastico), ma fungono da storico. La cancellazione di una chat può avvenire solo tramite intervento manuale e insindacabile della Direzione.
***Sempre Attivo (Emergenze):** Il modulo di comunicazione è considerato un canale critico. Pertanto, anche nel caso in cui l'account di un genitore venga sospeso per motivazioni amministrative (es. insolvenze), la chat privata rimane pienamente operativa per garantire la comunicazione in caso di emergenze.

---

# PRD - Kidville App: Modulo Gestione Form di Raccolta Dati (Kidville)

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

---

# PRD - Kidville App: Modulo Menu e Mensa

## 1. Obiettivo del Modulo
Il modulo "Menu e Mensa" automatizza la filiera della ristorazione scolastica. Gestisce in modo
integrato la pianificazione ciclica dei pasti, la sicurezza alimentare tramite il matching automatico
degli allergeni, l'amministrazione dei "Ticket Pasto" a scalare e fornisce interfacce dedicate sia
per lo staff didattico che per il personale di cucina.

## 2. Configurazione Menu e Gestione Cucina
### 2.1 Menu Builder e Ciclicità
• Menu Builder Digitale: La Segreteria non carica PDF statici, ma utilizza un "Menu Builder" nativo per strutturare i pasti (Primo, Secondo, Contorno, Frutta).
• Ciclicità Programmabile: Il sistema supporta la creazione di menu ciclici. La Segreteria imposta la durata del ciclo (es. 4 settimane) e il sistema autocompila il calendario futuro, riducendo il data-entry.
• Variazioni Giornaliere: È possibile applicare eccezioni e variazioni al menu giornaliero (es. sostituzione di un ingrediente non consegnato dal fornitore), che generano in automatico una notifica di aggiornamento alle famiglie.
• Gestione Calendario Chiusure: La Segreteria imposta i giorni di festività/chiusura a livello globale. In tali giorni, l'intero modulo mensa si disattiva, inibendo richieste pasti e scali di ticket.

### 2.2 Dashboard Dedicata (Ruolo "Cuoca")
• Isolamento dell'Interfaccia: Il sistema prevede un Ruolo Auth specifico per il personale di cucina. Accedendo con questo ruolo su un tablet, la "Cuoca" visualizza esclusivamente la dashboard mensa.
• Dati Operativi: La dashboard mostra in tempo reale i numeri definitivi dei pasti da preparare, raggruppati per tipologia (Pasti Standard, Diete in Bianco, Diete Speciali per intolleranze), garantendo massima privacy e oscurando il resto delle funzioni dell'app (es. chat, valutazioni).

## 3. Sicurezza Alimentare e Intolleranze
• Tracciamento Obbligatorio: Durante l'inserimento dei piatti nel Menu Builder, è obbligatorio specificare i relativi allergeni (es. glutine, lattosio, uova).
• Matching Automatico e Alert: Il sistema incrocia costantemente gli allergeni del piatto con i dati medici dell'Anagrafica dell'alunno.
• Interfaccia Genitore: Nel calendario menu del genitore, se è previsto un pasto pericoloso per il bambino, il piatto viene automaticamente contrassegnato con un'icona di allerta visiva inequivocabile (es. semaforo rosso).

## 4. Ticketing e Modello Economico
### 4.1 Logica "Prepagato a Scalare"
• Saldo Separato: Il sistema funziona a "Ticket Pasto" a scalare. Ogni alunno possiede un proprio saldo individuale (nessun "portafoglio famiglia" condiviso in caso di fratelli).
• Ricarica Offline (Solo Segreteria): L'acquisto di nuovi pacchetti di ticket non avviene tramite pagamento in-app (es. Stripe). Le famiglie acquistano i ticket tramite la Segreteria, la quale ha un'interfaccia dedicata per accreditare manualmente il numero di ticket e il relativo importo al profilo dell'alunno.
• Reminder Esaurimento Scorte: Quando il saldo di un alunno scende sotto una soglia critica preimpostata, il sistema invia in automatico una notifica push al genitore ("Attenzione, ticket mensa in esaurimento").

### 4.2 Consumo e Rimborsi
• Scatto del Ticket: II ticket viene scalato nel momento in cui il genitore (tramite la propria app) spunta/prenota attivamente la consumazione del pasto per la giornata.
• Storni Manuali: La Segreteria possiede i permessi amministrativi per effettuare rimborsi manuali o riaccreditare ticket in caso di uscite anticipate impreviste.

## 5. Operatività Quotidiana (Docenti e Famiglie)
### 5.1 Flusso Insegnante e Richieste Speciali
• Vista Menu e Consumi: L'insegnante visualizza il menu in un tab separato dell'app, corredato dalla lista degli alunni che hanno regolarmente prenotato il pasto per quel giorno.
• Diete in Bianco: L'insegnante può richiedere una dieta in bianco per un alunno (es. in caso di malessere temporaneo). Questa operazione deve avvenire rigorosamente entro l'orario di cut-off (es. 09:30) per aggiornare tempestivamente i monitor della cucina.
• Esclusioni di Classe: In caso di gita scolastica, l'insegnante ha a disposizione un comando di "blocco massivo" per annullare la mensa per tutta la classe con un solo click.

### 5.2 Specificità Scuola Primaria
• Poiché alla Scuola Primaria non si utilizza il Diario 0-6 per la rendicontazione dei pasti, è prevista una sezione speciale "Cucina/Mensa". In questo tab, la Segreteria o l'insegnante compila in modo rapido l'elenco dei bambini effettivamente presenti in refettorio, permettendo al sistema di allineare e scalare correttamente i ticket.

### 5.3 Esportazioni e Fatturazione Esterna
• Report Catering: La Direzione scolastica dispone di uno strumento di esportazione che genera un report di fine mese (Excel/PDF) con i numeri esatti e aggregati dei pasti consumati (divisi per standard e speciali). Questo documento è pronto per essere inviato all'azienda di catering esterna per la rendicontazione e fatturazione.

---

# PRD - Kidville App: Modulo Pagamenti e Gestione Economica

## 1. Obiettivo del Modulo
Il modulo Pagamenti (lib/features/payments/) è il sistema di tracciamento finanziario della
piattaforma. La scelta architetturale fondamentale è l'assenza di pagamenti in-app: l'applicazione
funge da scadenziario, promemoria e registro di stato per le famiglie, mentre la transazione
economica reale avviene esternamente (bonifico, contanti, POS) e viene validata manualmente
dalla Segreteria.

## 2. Creazione e Assegnazione Pagamenti (Lato Segreteria)
### 2.1 Generatore Universale
La Segreteria dispone di un tool per generare qualsiasi tipologia di pagamento (es. Rette, Quote d'iscrizione, Divise, Gite).
• Assegnazione Flessibile: I pagamenti possono essere assegnati massivamente a un'intera classe oppure singolarmente a specifici studenti.
• Rateizzazione: In fase di creazione di un pagamento ad alto importo, la Segreteria ha la facoltà di abilitare un piano di rateizzazione predefinito.

### 2.2 Rette Mensili e Quote
• Automazione Rette: Il sistema genera automaticamente le rette ricorrenti. Di default, la retta applicata e la data di scadenza sono standard per tutti.
• Override Anagrafico: Non ci sono sconti automatici. Eventuali modifiche all'importo della retta (es. sconti fratelli) o alla data di scadenza devono essere impostate manualmente dalla Segreteria all'interno dell'Anagrafica dello studente.
• Quote d'Iscrizione: A differenza delle rette, la quota di iscrizione annuale non si autogenera all'importazione dell'alunno, ma deve essere assegnata manualmente.
• Split Pagamenti (Genitori Separati): Su richiesta delle famiglie, la Segreteria può impostare dall'Anagrafica la divisione del debito (es. $50/50$) su due account genitoriali distinti.

## 3. Registrazione, Fatturazione e Morosità
### 3.1 Registrazione Incassi
• II genitore non può pagare tramite l'app.
• Quando la Segreteria riceve il pagamento, lo registra manualmente a sistema. L'aggiornamento dello stato in "Pagato" è istantaneo e si riflette in tempo reale sull'app del genitore.
• Fatturazione su Richiesta: Il sistema non invia fatture automaticamente. La Segreteria ha a disposizione un pulsante "Invia Fattura/Ricevuta" per generare e inoltrare il documento al genitore.

### 3.2 Cruscotto Insoluti
• Dashboard Morosità: La Direzione ha una visuale completa sui pagamenti in sospeso. Gli utenti insoluti e i pagamenti scaduti sono evidenziati cromaticamente in rosso.
• Sospensione Manuale: Il blocco dell'account per grave morosità (es. inibizione delle funzioni app) non è automatico, ma richiede un'azione manuale e consapevole da parte della Direzione.

## 4. Esperienza Utente Genitore e Reminder
### 4.1 Visualizzazione a Categorie
• L'interfaccia genitore categorizza i pagamenti per tipologia (es. "Rette", "Quote di iscrizione", "Mensa", "Gite").
• Ogni categoria mostra chiaramente lo storico dei pagamenti saldati e le pendenze future.
• Voci Facoltative: Per i pagamenti non obbligatori, il genitore può semplicemente ignorarli; resteranno visibili nell'elenco fino alla data di naturale scadenza.

### 4.2 Sistema di Reminder Aggressivo
• Per combattere le insolvenze, il sistema prevede una logica di notifica push automatizzata per i pagamenti obbligatori:
  1. Notifica nel giorno esatto della scadenza.
  2. Reminder ricorrente inviato ogni due giorni finché la Segreteria non contrassegna la voce come saldata.

## 5. Interconnessioni Modulari
• Widget Mensa: La vendita dei pacchetti ticket mensa è gestita unicamente dalla Segreteria, che inserisce manualmente nel sistema il numero di pasti acquistati a seguito del pagamento esterno.
• Widget Form (Gite): II flusso amministrativo per le gite richiede un doppio check. Nell'elenco riepilogativo della Segreteria e dell'insegnante, l'alunno avrà il "Semaforo Verde" per partecipare all'uscita solo se possiede sia l'autorizzazione firmata digitalmente (Modulo Form) sia la quota saldata (Modulo Pagamenti).

---

# PRD - Kidville App: Modulo Fatturazione Elettronica (Integrazione Aruba)

## 1. Obiettivo del Modulo
Il modulo di Fatturazione Elettronica estende le capacità finanziarie del sistema interfacciandosi
nativamente con l'ecosistema Aruba. L'obiettivo è generare vere e proprie fatture elettroniche (in
formato XML destinate al Sistema di Interscambio - SDI dell'Agenzia delle Entrate) in modo
sicuro, rispettando le normative fiscali vigenti per gli enti scolastici, senza appesantire il flusso di
lavoro manuale della Segreteria.

## 2. Architettura Sicura e Flusso API
• Backend Proprietario per la Sicurezza: Per garantire la massima sicurezza e non esporre mai le chiavi API di Aruba nel codice frontend dell'applicazione, l'intera logica di comunicazione con Aruba avviene lato server. Il click sul pulsante nell'app innesca una chiamata API a un endpoint dedicato del nostro backend (es. Node.js/Python). Il backend, che dialoga in sicurezza con il database PostgreSQL, si occuperà di eseguire la chiamata protetta verso i server di Aruba in background, mantenendo nascoste le chiavi API.
• Azione Esclusivamente Manuale: Non è prevista alcuna automazione occulta. La generazione e l'invio della fattura ad Aruba avvengono solo ed esclusivamente se la Segreteria preme fisicamente il pulsante "Invia Fattura" in corrispondenza di un pagamento saldato. Se il pulsante non viene premuto, il pagamento risulta registrato internamente ma non viene emessa alcuna fattura.

## 3. Anagrafica e Dati di Fatturazione
• Intestatario Predefinito: All'interno dell'Anagrafica dell'alunno è presente un campo obbligatorio denominato "Intestatario Fattura". La Segreteria seleziona a quale dei due genitori (o tutori legali) dovranno essere intestate di default le fatture fiscali.
• Recupero Dati Automatico: Al momento dell'emissione, il sistema interroga l'anagrafica del Genitore Intestatario e compila automaticamente il tracciato XML con tutti i dati richiesti da Aruba per la validazione (es. Nome, Cognome, Indirizzo di Residenza completo, Codice Fiscale, Codice Destinatario/PEC).

## 4. Regole Fiscali e Numerazione
• Numerazione Sequenziale: Kidville delega completamente la gestione del progressivo numerico (es. Fattura n. 1, 2, 3...) al sistema Aruba, evitando conflitti di numerazione e garantendo l'allineamento fiscale sul cassetto fiscale della scuola.
• Regime IVA e Natura: Tutte le fatture emesse tramite questo flusso applicano automaticamente l'esenzione IVA per i servizi scolastici, utilizzando l'impostazione fissa: 0% di IVA, Natura N4 (Esente Articolo 10).
• Esclusione Marca da Bollo: Il sistema è configurato per non applicare in automatico alcuna riga relativa all'addebito della marca da bollo, lasciando l'importo della prestazione pulito.

## 5. Gestione Errori e Interfaccia Genitore
• Monitoraggio Scarti SDI: Se la fattura inviata ad Aruba viene successivamente scartata dal Sistema di Interscambio (SDI) dell'Agenzia delle Entrate (ad esempio per un Codice Fiscale errato nell'anagrafica del genitore), il backend di Kidville intercetta lo stato e invia una notifica di errore in tempo reale alla dashboard della Segreteria, specificando il motivo dello scarto per permettere una rapida correzione.
• Download Self-Service per le Famiglie: Una volta che la fattura è stata emessa con successo, l'interfaccia dell'App Genitore si aggiorna in automatico. In corrispondenza della voce di pagamento saldata (es. "Retta di Marzo"), comparirà un'icona di download che permette al genitore di scaricare sul proprio dispositivo la copia di cortesia in formato PDF generata da Aruba.

---

# PRD - Kidville App: Modulo Impostazioni (Pannello di Controllo Globale)

## 1. Obiettivo del Modulo
Il modulo Impostazioni (lib/features/admin/ e lib/core/) rappresenta la cabina di regia del SaaS
Kidville. Accessibile esclusivamente con privilegi di Direzione/Segreteria (Super-Admin), permette
di plasmare dinamicamente ogni singola funzionalità descritta nei moduli precedenti. Questo
garantisce che la piattaforma sia scalabile e totalmente personalizzabile per ogni singola sede
(Tenant) senza richiedere l'intervento degli sviluppatori.

## 2. Configurazione Globale, Sedi e Ruoli (Anagrafica)
• Gestione Multi-Sede (Tenant): Possibilità di aggiungere, rinominare o disattivare le sedi fisiche della scuola. Ogni sede ha la propria configurazione isolata.
• Gradi d'Istruzione e Classi: Creazione e gestione dei gradi (Nido, Infanzia, Primaria) e delle relative sezioni/classi.
• Gestione Staff (RBAC): Pannello per l'onboarding del personale. La Segreteria può creare account assegnando ruoli rigidi (Docente, Segreteria, Cuoca, Direzione) e associare i docenti alle rispettive classi.

## 3. Configurazione Moduli Didattici (Diario e Registro)
### 3.1 Diario 0-6 (Nido e Infanzia)
• Customizzazione Routine: La Segreteria può abilitare o disabilitare specifici widget di routine (es. "Bagno", "Nanna") a livello di singola classe (es. togliendo il modulo "Nanna" per le classi dell'Infanzia).

### 3.2 Diario Scuola Primaria
• Materie Master e Orario: Pannello per la gestione delle discipline (incl. Educazione Civica e Mensa-turno), delle campanelle e del palinsesto settimanale (modelli tempo scuola 27/29/40 ore), che si riflette automaticamente nei registri degli insegnanti (vedi Modulo Primaria §6).
• Sistema di Valutazione (motore ibrido per grado): Configurazione del modello di valutazione per grado/sezione. Per la **Primaria** è forzato il modello conforme **O.M. 3/2025** (giudizi per obiettivi in itinere + 6 giudizi sintetici allo scrutinio, voti numerici disabilitati); per eventuali gradi non-primaria è abilitabile il modello a voti numerici. Vedi Modulo Primaria §4.
• Declinazioni Locali (PTOF): Importazione delle declinazioni dei descrittori dei giudizi sintetici deliberate dagli organi collegiali, che integrano/sostituiscono i testi standard dell'Allegato A in pagella.
• Obiettivi di Apprendimento: Gestione del curricolo d'istituto (obiettivi per disciplina e classe) da rendere disponibili ai docenti per la valutazione in itinere.

## 4. Configurazione Armadietto e Mensa
• Inventario Armadietto: Gestione della "Lista Default" dei materiali (es. Pannolini, Salviette, Cambi). La Segreteria può aggiungere nuove voci personalizzate che appariranno poi nei menu a tendina degli insegnanti.
• Setup Cucina e Mensa:
  • Orario Cut-off: Impostazione dell'orario limite (es. 09:30) per la chiusura delle presenze e delle diete in bianco ai fini del calcolo dei pasti.
  • Menu Builder: Accesso allo strumento di creazione dei menu ciclici e associazione obbligatoria degli allergeni ai piatti.
  • Calendario Chiusure: Impostazione dei giorni festivi e di chiusura scolastica in cui il sistema disabilita in automatico scalo ticket e appello.

## 5. Configurazione Flussi Amministrativi e Finanziari
### 5.1 Pagamenti e Ticket
• Rette Default: Impostazione dell'importo standard della retta mensile e della data di scadenza globale (modificabile poi singolarmente dall'anagrafica del singolo alunno).
• Ticket Mensa: Configurazione del costo del singolo Ticket Pasto e dei "Pacchetti" acquistabili (es. pacchetto da 10 o 20 pasti) che la Segreteria utilizzerà per ricaricare i conti degli alunni.
• Gestione Insoluti: Impostazione della tolleranza (numero di giorni di ritardo) prima che un pagamento venga contrassegnato in rosso come "Insoluto".

### 5.2 Modulistica e Form Builder
• Accesso al motore di creazione template (Form Builder). Da qui la Segreteria genera i modelli per uscite didattiche e consensi privacy, impostando i campi dinamici richiesti ai genitori.

### 5.3 Fatturazione Elettronica (Integrazione Aruba)
• Credenziali API: Sezione sicura per l'inserimento e l'aggiornamento delle chiavi API di Aruba.
• Dati Scuola: Inserimento dei dati di fatturazione dell'istituto (Partita IVA, Codice Fiscale, PEC) necessari per la corretta generazione del tracciato XML.
• Regime IVA: Pannello per mappare le causali di default (es. Retta = Esente IVA Art. 10).

---

# PRD - Kidville App: Modulo Fascicolo Personale dell'Alunno

## 1. Obiettivo del Modulo
Il Fascicolo Personale è l'archivio documentale e storico dello studente. Contiene dati amministrativi
comuni e **dati particolari (sensibili)** — stato di salute, documenti di inclusione — e deve quindi
sottostare a tutele rigorose di accesso e tracciamento, in conformità al GDPR (Reg. UE 2016/679).
Estende l'anagrafica esistente (oggi limitata a note mediche, flag BES/DSA e delegati).

## 2. Composizione del Fascicolo
### 2.1 Sezione Amministrativa
• Anagrafica studente e genitori/tutori (con **codice fiscale validato**).
• Recapiti telefonici ed e-mail per emergenze.
• **Deleghe al prelievo** all'uscita, con allegato il documento d'identità dei delegati (riusa `delegati`).
• Storico iscrizioni, **pagelle degli anni precedenti** e **certificati delle competenze**.

### 2.2 Sezione Consensi e Privacy
• Modulo di consenso al trattamento dati e informativa privacy firmata.
• **Consenso specifico** per riprese foto/video durante attività didattiche e uscite (collegato al
  Privacy Lock della Galleria).
• Consenso al **trasferimento del fascicolo** informatico ad altra scuola in caso di mobilità.

### 2.3 Sezione Riservata — Documenti di Inclusione (PEI/PDP)
• Diagnosi funzionali, certificazioni ASL e relazioni (L. 104/1992).
• **PEI** redatto dal GLO; **PDP** e certificazioni DSA (L. 170/2010).

## 3. Protezione e Controllo Accessi
> [!IMPORTANT]
> **Livello di protezione adottato (decisione di prodotto): RBAC ristretto + audit accessi.**
> La cifratura dei file è demandata allo storage gestito (Supabase Storage). Una crittografia
> applicativa dedicata (AES-256 a livello di tabella/file) **non** è prevista in questa fase e potrà
> essere introdotta successivamente se richiesto dal titolare del trattamento.

• **RBAC ristretto:** l'accesso (visualizzazione/modifica) a PEI/PDP e documenti sanitari è limitato ai
  **docenti contitolari della classe di riferimento**, al **Dirigente** e al personale di **segreteria
  espressamente autorizzato**. Vietato l'accesso a docenti di altre classi o utenti non profilati.
• **Audit log accessi:** ogni consultazione/modifica di un documento sensibile genera un log
  **immodificabile** (chi, quando, quale documento, finalità) — estensione di `registro_modifiche`.
• **Segregazione logica:** i documenti sensibili sono archiviati separatamente dalla documentazione
  amministrativa, con bucket/percorsi dedicati e ACL distinte.
• **Workflow firma GLO:** il PEI è atto che richiede la sottoscrizione di docenti contitolari,
  specialisti ASL e genitori. Area di collaborazione protetta dove i membri del GLO visualizzano la
  bozza, annotano e appongono la firma per accettazione (firma applicativa in linea con il livello
  "Base" del documento; firma qualificata rimandata, cfr. §9.2 modulo Primaria).

---

# PRD - Kidville App: Modulo Interoperabilità SIDI / Piattaforma Unica

## 1. Obiettivo del Modulo
Garantire l'interoperabilità bidirezionale con il **SIDI** (Sistema Informativo dell'Istruzione) e con
la **Piattaforma Unica** del Ministero, per l'efficienza amministrativa della segreteria e gli
adempimenti di legge. Il registro non opera come sistema isolato.

## 2. Importazione Nuovi Iscritti (Flusso SIDI)
• **Ricezione file ZIP ministeriale:** upload diretto del file `.zip` generato dal SIDI (dati nuovi
  iscritti e famiglie), **senza** che l'operatore debba rinominarlo o modificarlo.
• **Matching su Numero di domanda:** l'associazione/deduplica avviene confrontando il **Numero di
  domanda di iscrizione SIDI** contenuto nel flusso, evitando anagrafiche duplicate e garantendo il
  corretto aggancio dei documenti del fascicolo.
• **Sincronizzazione dati genitori:** sovrascrittura/integrazione dei contatti già presenti, usando il
  **codice fiscale** come chiave primaria di associazione.

## 3. Allineamento Strutturale e Invio Frequentanti
• **Fase A — Struttura di base:** ricezione dal SIDI di sedi, sezioni, classi e tempo scuola per
  allineare il database locale. Le modifiche strutturali lato SIDI vanno recepite **prima** dell'invio
  dei dati alunni.
• **Invio flusso di frequenza:** trasmissione telematica degli alunni effettivamente frequentanti per
  classe. La corretta trasmissione è prerequisito per l'accesso di docenti/famiglie ai servizi della
  Piattaforma Unica.

## 4. Flusso Genitori-Alunni (Piattaforma Unica)
• Flusso periodico (mensile/annuale) di **associazione Genitori-Alunni** trasmesso in cooperazione
  applicativa al SIDI, con le relazioni parentali validate dalla segreteria, così che solo i soggetti
  legalmente responsabili accedano ai dati riservati sulla piattaforma ministeriale.

## 5. Export Certificati delle Competenze (Classe Quinta)
• Generazione e trasmissione al SIDI della **scheda dei certificati delle competenze** di fine classe
  quinta, compilata in sede di scrutinio finale, secondo il **D.M. n. 14 del 30/1/2024**.

> [!NOTE]
> L'attivazione dei flussi SIDI in cooperazione applicativa richiede l'**accreditamento ministeriale**
> del software e le relative credenziali/canali. Le tempistiche (avvio anno scolastico, generalmente
> entro fine ottobre) vincolano la sequenza Fase A → frequentanti → servizi Piattaforma Unica.

---

# PRD - Kidville App: Accessibilità, Sicurezza e Compliance (Trasversale)

## 1. Obiettivo
Requisiti trasversali a tutti i moduli per garantire conformità ad AgID, MIM e Garante Privacy. Il
mancato rispetto può comportare l'esclusione dal mercato scolastico o sanzioni.

## 2. Accessibilità (Legge Stanca)
• Conformità a **L. 9/1/2004 n. 4 (Legge Stanca)** e s.m.i., **D.Lgs. 106/2018** e **Linee Guida AgID**
  sull'accessibilità (aggiornamento 29/5/2023), con riferimento WCAG.
• Interfaccia ad **alto contrasto** e compatibilità con i principali **screen reader**.
• L'accessibilità è criterio di accettazione per il frontend di tutti i moduli (parent, teacher, admin).

## 3. Privacy e Adempimenti
• **Pubblicazione informative privacy** destinate ad alunni, genitori, docenti e personale ATA, sempre
  disponibili in una sezione dedicata.
• **Raccolta e tracciamento del consenso** per trattamenti che eccedono le attività istituzionali (es.
  pubblicazione foto/video su canali della scuola), con archiviazione sicura del consenso digitale.
• Per alunni con disabilità, BES o DSA, la raccolta del consenso per la trasmissione dati
  all'Anagrafe Nazionale degli Studenti è documentata e, ove necessario, con copia firmata.

## 4. Audit e Tracciabilità
• **Audit log immodificabile** degli accessi a dati e documenti sensibili (chi, quando, finalità),
  in conformità ai requisiti del Garante per le PA — estensione di `registro_modifiche` e
  `firme_documenti` esistenti.