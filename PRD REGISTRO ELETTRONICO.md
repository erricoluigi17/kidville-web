
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
> | **Presenze** | 🔶 UI pronta | `/teacher/attendance`, `/parent/attendance` | `/api/panic-alert` |
> | **Registro Primaria** | 🔶 UI pronta | `/teacher/register`, `/parent/register` | `/api/grades`, `/api/notes` |
> | **Armadietto** | ⬜ Da implementare | — | — |
> | **Mensa** | ⬜ Da implementare | — | — |
> | **Chat** | ⬜ Da implementare | — | — |
> | **Pagamenti** | ⬜ Da implementare | — | — |
> | **Modulistica** | ⬜ Da implementare | — | — |
> | **Foto/Video** | ⬜ Da implementare | — | — |

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
differenza del Nido/Infanzia, questo strumento gestisce logiche didattiche e ministeriali (voti, note,
argomenti delle lezioni, presenze orarie). È progettato per garantire l'isolamento delle discipline tra
i docenti, fornire una reportistica chiara ai genitori e supportare la direzione scolastica nella
valutazione periodica.

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
### 4.1 Logica di Inserimento
• Tipologia Voti: Il sistema supporta un modello ibrido. Sono ammessi sia voti numerici standard (es. 1-10) sia giudizi descrittivi (es. Base, Avanzato).
• Mappatura per Medie: I giudizi descrittivi, impostati a livello di Admin, possiedono un valore numerico nascosto associato, indispensabile per permettere all'algoritmo di calcolare le medie in background.
• Categorizzazione: Ogni valutazione inserita deve essere categorizzata per tipologia: Scritto, Orale o Pratico.

### 4.2 Medie e Isolamento delle Materie
• Privacy tra Colleghi: La visibilità delle valutazioni è strettamente limitata alla propria disciplina. Un docente non ha accesso ai voti assegnati allo stesso alunno da docenti di altre materie.
• Calcolo della Media: Il sistema calcola una media automatica dei voti (visibile esclusivamente all'insegnante e non ai genitori). Questa media è calcolata dal sistema ma rimane modificabile/sovrascrivibile manualmente dall'insegnante in sede di scrutinio.

### 4.3 Comunicazione alle Famiglie
• Buffer di Sicurezza: All'inserimento di un voto, il sistema attende 10 minuti prima di inviare la notifica push e rendere visibile la valutazione, consentendo al docente di correggere eventuali errori di battitura.
• Nessuna Firma Richiesta: Non è richiesta la spunta di "presa visione" da parte del genitore per le normali valutazioni.
• Persistenza Visiva: In caso di account genitore sospeso (es. per ritardi amministrativi), i dati del registro elettronico (voti e compiti) restano comunque visibili per garantire la trasparenza e il diritto all'informazione didattica.

## 5. Note e Provvedimenti Disciplinari
• Categorizzazione Cromatica: Le note sono suddivise in tre categorie distinte, differenziate visivamente (tramite colori/icone) sull'app del genitore:
  1. Nota Disciplinare (Comportamento)
  2. Nota Didattica (Es. materiale dimenticato)
  3. Compiti a casa non svolti
• Assegnazione Massiva: L'insegnante può selezionare più alunni (o l'intera classe) e assegnare una nota collettiva con un'unica operazione.
• Firma per Presa Visione: A differenza dei voti, le Note Disciplinari richiedono obbligatoriamente l'interazione del genitore, che deve apporre una firma digitale per "presa visione" direttamente dall'applicazione, confermando la ricezione della comunicazione.

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

# PRD - Kidville App: Modulo Modulistica, Certificati e Onboarding Legale

## 1. Obiettivo del Modulo
Il modulo Modulistica e Certificati digitalizza l'intero flusso burocratico della scuola. Il suo scopo
primario non è solo la dematerializzazione cartacea, ma l'innalzamento di uno scudo giuridico
protettivo attorno all'ente, ai docenti e al Dirigente Scolastico. Attraverso l'uso di Firme
Elettroniche Semplici (FES), cristallizzazione dei log e dichiarazioni sostitutive di atto di notorietà,
il modulo garantisce l'inattaccabilità legale della scuola, automatizzando parallelamente
l'aggiornamento dell'Anagrafica e la generazione di certificati.

## 2. Lo Scudo Giuridico: Valore Legale e Compliance (Art. 20 CAD)
Per garantire la massima efficacia probatoria, l'architettura dei moduli di autorizzazione (es. Uscite Didattiche, Consensi Privacy) è strutturata sui seguenti pilastri normativi:
• Autenticazione Forte: Il sistema predilige un'identificazione inequivocabile dell'utente, allineata ai protocolli SPID/CIE (Art. 65 del CAD).
• Firma Elettronica Semplice (FES): L'accettazione di un form genera una FES. II sistema cristallizza i log di sistema (Timestamp esatto, Indirizzo IP, ID univoco dell'utente) e genera un documento PDF statico, non modificabile a posteriori, archiviato nel rispetto del manuale di conservazione AgID.
• Tutela sulle Dinamiche Familiari: I form integrano tassativamente le dichiarazioni sostitutive di atto di notorietà (D.P.R. 445/2000). II genitore dichiarante si assume la piena responsabilità del consenso (o della sua presunta condivisione ex artt. 316 e 337-ter c.c.), esentando l'ente scolastico da indagini sulle dinamiche intrafamiliari.
• Isolamento GDPR (Art. 9): Il flusso di raccolta del consenso è parcellizzato. L'approvazione al trattamento dei dati particolari (es. sanitari, disabilità, intolleranze) è isolata tramite check-box dedicate, separata dal generale interesse istituzionale.
• Vincoli Disciplinari e Sicurezza: Il contratto digitale impone l'accettazione vincolante, con spunte separate, delle condizioni assicurative, dei protocolli di sicurezza stradale e delle conseguenze disciplinari ed economiche (incluso l'onere del rientro anticipato a carico della famiglia), in rigida ottemperanza al D.P.R. 134/2025.

## 3. Motore di Creazione Form (Segreteria e Admin)
### 3.1 Form Builder e Automazioni
• Creazione Dinamica: La Segreteria non è limitata a template statici, ma dispone di un Form Builder interno per creare moduli personalizzati aggiungendo campi testuali, check-box e informative.
• Scadenze Bloccanti: È possibile impostare una "Data di scadenza" tassativa (es. per l'adesione a una gita). Superata la data, il sistema blocca automaticamente nuove compilazioni.
• Aggiornamento Automatico Anagrafica: I dati inseriti dal genitore nei moduli (es. aggiornamento recapiti, cambio pediatra) vanno a sovrascrivere e aggiornare automaticamente i campi corrispondenti nell'Anagrafica dell'alunno, azzerando il data-entry manuale della Segreteria.

### 3.2 Form di Onboarding Esterno (Pre-Iscrizione)
• Link di Acquisizione: Il sistema permette alla Segreteria di generare un link esterno univoco da inviare alle nuove famiglie.
• Compilazione e Import: II genitore compila l'intera scheda anagrafica (dati alunno, genitori, delegati, emergenze) via web. Al termine, la Segreteria visualizza la scheda in una "Sala d'attesa" virtuale e, con un solo click, importa l'alunno nel database ufficiale di Kidville.

### 3.3 Esportazione Massiva
• Merge PDF: Per le uscite didattiche, la Segreteria dispone di una funzione di export massivo che unisce tutti i form compilati e firmati dagli alunni di una specifica classe in un unico file PDF multipagina, pronto per essere stampato o consegnato ai docenti accompagnatori.

## 4. Esperienza Utente: Genitore (Self-Service e Certificati)
### 4.1 Compilazione e Rilascio
• Ricevuta PDF: Alla conclusione di ogni compilazione e apposizione della firma, l'app genera automaticamente una copia PDF del documento firmato, che il genitore può scaricare sul proprio dispositivo.
• Certificati Self-Service: II genitore dispone di una sezione dedicata da cui può generare e scaricare in autonomia certificati pre-compilati con i dati della scuola (es. Certificato di Iscrizione, Certificato di Frequenza per bonus INPS), riducendo il carico di richieste in Segreteria.

### 4.2 Gestione Certificati Medici
• Upload Diretto: In caso di assenza per malattia, il genitore carica la scansione/foto del certificato medico di riammissione direttamente in app.
• Riammissione Immediata: L'upload sblocca automaticamente la posizione dell'alunno senza richiedere un'approvazione manuale preventiva da parte della Segreteria.
• Nessuno Storico: Per ragioni di privacy e pulizia dell'interfaccia, il genitore non ha accesso a uno storico cumulativo dei certificati medici caricati in passato.

## 5. Esperienza Utente: Insegnante (Monitoraggio in Classe)
• Cruscotto Autorizzazioni (Semaforo): In vista di un'uscita didattica o di un'attività che richiede consenso, l'insegnante visualizza nella dashboard della propria classe un indicatore visivo "a semaforo" (es. lista degli alunni con spunta verde per chi ha firmato, rossa per i mancanti), aggiornato in tempo reale.
• Caricamento per Conto Terzi (Proxy Upload): Qualora un genitore consegni fisicamente un documento cartaceo (es. certificato medico o delega) direttamente all'insegnante alla porta, quest'ultimo ha i permessi per fotografarlo e caricarlo a sistema per conto della famiglia, chiudendo l'iter burocratico.

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
• Orario e Materie: Pannello per la creazione del palinsesto settimanale (materie e orari) che si rifletterà automaticamente nei registri degli insegnanti.
• Sistema di Valutazione: Impostazione della scala di valutazione. Se la scuola opta per i giudizi descrittivi (es. Base, Intermedio, Avanzato), questo pannello permette di mappare il giudizio testuale a un valore numerico nascosto per consentire all'algoritmo il calcolo automatico delle medie.

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