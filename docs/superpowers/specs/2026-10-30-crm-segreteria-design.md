# CRM della segreteria — specifica

**Data:** 30/10/2026 · **Stato:** approvata dal titolare il 30/10/2026 ·
**Per:** chi pianifica e costruisce

## 1. Perché

Le segretarie tracciavano contatti, visite ed esiti con una mini-app esterna, «Kidville Sales HUB V8»
(Firebase `crm-vendite`, https://kidville-sales.netlify.app). Ci sono tre problemi:

- **Espone dati di minori.** Entra con un accesso anonimo, quindi chiunque abbia il link legge nomi,
  telefoni, date di nascita e note sui bambini. È ferma dal 4/06/2026; il titolare la chiude da sé.
- **Le statistiche non sono affidabili.** La misura del 30/10 su 228 schede, confrontate con il registro
  Kidville, dice che 58 schede sono sbagliate nell'uno o nell'altro verso:
  - dei 94 «ISCRITTO», 61 sono oggi alunni e 32 non si trovano;
  - 26 iscritti veri non erano segnati come tali.

  Le cause sono tre: chi fissa e chi svolge sono scritti a mano (24 grafie per circa 6 persone, 69
  «Segreteria» generici), gli stati non vengono aggiornati (49 «In Programma» con la data passata) e
  l'esito è un menu staccato dalla realtà.
- **Non c'è una procedura.** Il manuale di vendita prevede telefonata, visita e follow-up, ma 59 visite
  svolte su 69 non iscritte hanno il primo follow-up «Non fatto».

Il picco cade a gennaio: 64 visite e 44 iscritti a gennaio 2026. **Il CRM deve funzionare prima di gennaio 2027.**

## 2. Obiettivi, non obiettivi, anti-obiettivi

**Obiettivi**
1. La segreteria gestisce le **schede famiglia** della propria sede: contatto, uno o più bambini, uno o più
   appuntamenti, esito per bambino.
2. **Chi fissa può assegnare la visita a qualsiasi collega della stessa sede.** Ogni segretaria vede e
   modifica tutte le schede della sua sede, e nessuna delle altre.
3. **Due statistiche separate.** Chi ha fissato si misura su quante famiglie si presentano; chi ha svolto
   la visita, su quanti bambini si iscrivono. Le persone sono sempre utenti dell'app, mai nomi scritti a mano.
4. **«Iscritto» è collegato alla domanda vera.** Il collegamento avviene in automatico se email o telefono
   coincidono, oppure a mano con un avviso visibile, con un pulsante «Associa al bambino».
5. **Aprendo una scheda si vede lo storico della famiglia**: chi ha fatto cosa, e quando.
6. **Disponibilità settimanali di ogni segretaria**, che diventano slot prenotabili, e un'**interfaccia per
   un assistente AI esterno** che fissa appuntamenti da solo in base a persona e sede.
7. **Il follow-up lo propone l'app.** Dopo una visita la prossima telefonata nasce da sola, con scadenza e
   responsabile, e la lista «da richiamare oggi» la mostra. *(Scelta dell'assistente, vedi §6 e §15.)*

**Non obiettivi (prima versione)**
- La sincronizzazione con Google Calendar: la sostituiscono l'agenda interna e le notifiche dell'app.
- L'invio di messaggi WhatsApp o SMS dall'app. Si tengono i collegamenti «chiama» e «apri WhatsApp».
- Il costo per iscritto collegato alle campagne. L'**origine** del contatto si registra, i costi no.
- Il percorso di iscrizione all'anno successivo nel registro (lo stato «accettato per il 2027/28» e la quota
  legata alla domanda). È un progetto a parte, ed è un prerequisito per il registro, non per il CRM.
- Promemoria automatici alla famiglia e una vista a colonne.
- La domanda «anno in corso / anno prossimo» nel modulo pubblico (P2). Tocca il modulo da cui arrivano le
  domande vere, cioè il rischio del primo anti-obiettivo: nella prima versione l'anno lo indica la
  segreteria.

**Anti-obiettivi:** se succede una di queste cose, il lavoro è fallito anche se funziona.
- Un errore del CRM impedisce a una famiglia di inviare la domanda.
- Una segretaria vede o modifica schede di un'altra sede.
- Il merito di una visita va a un nome scritto a mano, o a due persone insieme.
- L'AI prenota uno slot già occupato o fuori disponibilità, o crea doppioni della stessa famiglia.
- Nei log finiscono dati personali.

## 3. Vincoli

- **Pattern del repo.** Route avvolte in `withRoute`, validazione `zod`, logging obbligatorio senza dati
  personali (`logOk`, `logErrore`, `logEvento`), `requireStaff(request, ['segreteria', 'admin'])` (più gli
  eventuali ruoli decisi in §14) e sede risolta con `resolveScuolaScrittura` / `resolveScuoleAttive`. L'admin
  ha più sedi: ogni sua scrittura dichiara la sede, altrimenti `resolveScuolaScrittura` risponde 400.
- **Tabelle.** Ogni tabella nuova ha `scuola_id` → `public.schools(id)`, RLS attiva senza policy e accesso
  solo service-role, come `candidature_sedi` e `iscrizioni_decisioni`. Vanno rispettati i lock di
  `__tests__/architecture/` (`fk-scuola-id`, `rls-per-sede`, `isolamento-sede-coverage`,
  `migrazioni-senza-sede-cablata`, `logging-coverage`, `zod-coverage`).
- **Migrazioni.** Si applicano solo dalla PR al merge, che fa il titolare. Il DB E2E della CI non è migrato:
  il codice deve degradare in modo pulito su `PGRST204` / `42703` (`.claude/rules/migrazioni.md`).
- **Sede.** La segreteria ha **una sola sede** (`utenti.scuola_id`); l'admin può averne più d'una
  (`utenti_scuole`). La sede E2E (`e2e0…`) e la sede Demo restano fuori da ogni elenco.
- **Menu ed etichette.** Voce in `NAV_GROUPS` (`src/components/features/admin/admin-nav-config.ts`) con
  `roles: ['segreteria', 'admin']`; etichette in `messages/it` e `messages/en`. Pagina modello per elenco, filtri e
  dettaglio: `/admin/candidature`.
- **Tre regole di processo.** Il PRD (`PRD REGISTRO ELETTRONICO.md`) si aggiorna nello stesso lavoro. Il
  repository è pubblico: niente dati reali in test e fixture. I dati sono di minori, quindi vale la
  minimizzazione (vedi §9).

## 4. Le strade considerate

| Strada | Cosa | Esito |
|---|---|---|
| **A** | Una scheda per bambino, con lo storico. | **Scelta dal titolare**, con tre aggiunte: più bambini nella stessa scheda, slot settimanali e prenotazione da AI. |
| B | Una famiglia con più appuntamenti sotto. | Le aggiunte portano la A molto vicino alla B: servono scheda famiglia, bambini e appuntamenti come righe separate. La B piena (fasi, vista a colonne) resta fuori. |
| C | Collegamento alla domanda tramite un trigger nel database. | Scartata: resta invisibile al logging dell'app, è più difficile da provare e una migrazione costa un merge. |

## 5. Decisioni del titolare (30/10/2026)

1. Si accede solo come segreteria. Ogni segretaria vede e modifica le schede della propria sede, colleghi
   compresi.
2. Le statistiche sono due e separate: chi fissa (presentazioni) e chi svolge (iscrizioni).
3. «Iscritto» = **arriva una domanda di iscrizione** che coincide per **email o telefono** con la scheda:
   il passaggio a iscritto è automatico. La segreteria può segnarlo anche a mano; allora la scheda mostra
   «nessuna domanda collegata» e un pulsante per associare il bambino.
4. In una scheda si possono mettere più bambini.
5. Chi fissa può fissare per i colleghi della stessa sede.
6. Aprendo la scheda si apre lo storico della famiglia.
7. Slot settimanali per ogni segretaria, prenotabili in automatico da un assistente AI.
8. Un tempo l'«ISCRITTO» poteva essere un ingresso a metà dell'anno in corso: l'esito deve distinguere
   **anno in corso** da **anno prossimo**.

**Proposte dell'assistente, non ancora confermate:**
- **P1.** La quota di iscrizione saldata compare sulla scheda come secondo segno (sì/no, data, chi l'ha
  segnata), ma non serve per contare l'iscritto. Il 30/10 il titolare l'aveva messa nella definizione;
  la regola del punto 3 non la richiede.
- **P2.** Il modulo pubblico chiede «per l'anno in corso / per l'anno prossimo». Il collegamento funziona
  anche senza; senza, l'anno lo indica la segreteria. **Fuori dalla prima versione** (vedi §2).

## 6. Il modello

Le righe sono proposte di forma: nomi esatti e tipi li decide chi costruisce.

**`crm_schede`** — la famiglia
- `scuola_id`, nome del genitore di riferimento, fino a **due telefoni e due email** (normalizzati per il
  confronto, conservati anche come digitati).
- `origine`: telefonata, WhatsApp, Instagram, Facebook, Google, sito/modulo, passaparola, open day,
  assistente AI, altro.
- Le tre domande del manuale (routine, paura, desiderio), facoltative. Sono testo libero su un minore:
  vanno redatte nei log e cancellate con la conservazione.
- `creato_da` (utente oppure null se l'ha creata l'AI) e `creato_via` (segreteria / AI).

**`crm_bambini`** — uno o più per scheda
- Nome, **data di nascita** e `anno_ingresso` (in corso / prossimo / non indicato).
- `esito`: aperto, iscritto, lista d'attesa, ci pensa, perso.
- `motivo_perdita`, a scelta: prezzo, distanza, orari, altra scuola, non risponde, rinviato, altro; più una
  nota.
- `esito_origine` (automatico / manuale), `esito_da`, `esito_il`.
- Il collegamento: `domanda_id` → `enrollment_submissions.id` più l'**indice del figlio** dentro
  `data.children`. Nessuna domanda e nessun figlio può essere collegato due volte. La chiave esterna è
  `ON DELETE SET NULL`: la domanda può sparire per la conservazione a 24 mesi o per l'oblio, e il CRM non
  deve bloccarla (vedi §7).
- La quota (P1): saldata sì/no, data, segnata da.

**`crm_appuntamenti`** — visite fissate; una scheda può averne più d'una
- `scuola_id`, `inizio`, `durata_min`.
- `assegnata_a`: utente di segreteria della stessa sede.
- `fissato_da` (utente, oppure null) e `fissato_via` (segreteria / AI).
- `stato`: in programma, svolto, non presentato, annullato.
- `svolto_da`: scelto dall'elenco delle segretarie della sede; parte da `assegnata_a`. `segnato_da` è chi
  ha premuto il tasto. Così la visita fatta dalla Segretaria 2 e segnata dalla Segretaria 1 va alla
  Segretaria 2, e resta scritto chi l'ha segnata.
- Spostare cambia `inizio` (ed eventualmente `assegnata_a`) e scrive un evento con il prima e il dopo.

**`crm_azioni`** — i follow-up, uno per riga *(scelta dell'assistente)*
- `scheda_id`, `tipo` (follow-up 1, riprova, follow-up 2, ultimatum, recupero non presentato, richiamare),
  `scadenza` (giorno e ora), `responsabile`.
- `esito` quando è fatta: ci pensa, non risponde, vuole iscriversi, non interessato. Più `fatta_da` e
  `fatta_il`.
- **La catena è quella che la mini-app già scriveva su Google Calendar**
  (`sales-app-functions/index…js`, righe 389–524), tutte alle 10:30:
  - visita svolta → follow-up 1 a +2 giorni;
  - «ci pensa» → passo successivo a +3 giorni (follow-up 1 → follow-up 2 → ultimatum);
  - «non risponde» → riprova il giorno dopo, sullo stesso passo;
  - «vuole iscriversi» o «non interessato» chiudono la catena; il secondo chiede il motivo di perdita.
- In più rispetto a prima: un «non presentato» crea un «recupero» per il giorno dopo.
- Il responsabile parte da chi ha svolto la visita, e si può cambiare con una collega della sede.
- La segretaria può spostare o cancellare un'azione, con evento. Le azioni scadute e non fatte restano in
  testa alla lista «da richiamare oggi».

**`crm_eventi`** — lo storico che si apre con la scheda
- Tipi: creata, telefonata, nota, appuntamento fissato / spostato / riassegnato / svolto / non presentato /
  annullato, esito cambiato, domanda collegata in automatico, domanda collegata a mano, collegamento tolto,
  quota segnata, prenotazione dall'AI.
- Autore: utente, oppure null per sistema e AI, con l'indicazione di quale.
- Dati: prima e dopo, solo id, enumerazioni e date. Il testo libero sta solo negli eventi «nota» e
  «telefonata».

**`crm_disponibilita`** — il modello settimanale per persona
- `scuola_id`, `utente_id`, giorno della settimana, ora di inizio e di fine, durata dello slot (proposta:
  45 minuti), valido dal / al.

**`crm_indisponibilita`** — le eccezioni
- Persona (oppure tutta la sede, per le chiusure), dal / al, motivo (ferie, malattia, chiusura, altro).

**Slot libero** = disponibilità − indisponibilità − appuntamenti in programma di quella persona. **Il
doppione si impedisce nel database**: due appuntamenti in programma della stessa persona non possono
sovrapporsi (vincolo di esclusione o indice univoco; sceglie chi costruisce). L'AI e una segretaria che
prenotano lo stesso slot nello stesso istante devono produrre un appuntamento e un `409`.

**`crm_integrazioni`** — le chiavi dell'AI
- Nome, sedi ammesse, impronta del token (mai il token in chiaro), attiva sì/no, creata da, ultimo uso.
- Il titolare la crea e la revoca dall'app.

## 7. Il collegamento con la domanda

**Quando.** Dentro `POST /api/iscrizione` (`src/app/api/iscrizione/route.ts`), **dopo** che la domanda è
salvata, si chiama `collegaDomandaAlCrm(domandaId)`. La chiamata è a tentativo: se fallisce scrive
`logErrore` e la famiglia riceve comunque la sua conferma. Se esistono altri percorsi che creano domande,
vale lo stesso.

**Come.**
1. Si normalizzano telefoni e email di tutti gli adulti della domanda. Telefono: solo cifre, via `+39` e
   `0039`, ultime 10 cifre. Email: minuscole, senza spazi.
2. Si cercano schede **della stessa sede** con almeno un telefono o un'email uguali, fra quelle aperte o
   create negli ultimi 12 mesi.
3. Dentro la scheda trovata, si abbina ogni bambino a un figlio della domanda per data di nascita o per
   nome. Se è uno contro uno, l'abbinamento è automatico.
4. Se l'abbinamento è certo, il bambino diventa iscritto, con `esito_origine` automatico e un evento
   «domanda collegata in automatico».
   Se la famiglia coincide ma il bambino è ambiguo, si collega la scheda e si mostra **«domanda arrivata —
   associa il bambino»**. Lo stesso vale se coincidono più schede: nessuna scelta automatica, solo
   l'avviso.
5. Le coincidenze con schede di altre sedi non si collegano: si scrive solo un `logEvento` senza dati.

**A mano.** «Segna iscritto» senza domanda mette un badge fisso **«Iscritto a mano · nessuna domanda
collegata»**. Il pulsante **«Associa al bambino»** apre la ricerca fra le domande della sede, le più recenti
prima, con nome del bambino, data di nascita e genitore: sono gli stessi dati che la segreteria vede già in
«Moduli ricevuti». Si sceglie il figlio, il collegamento parte e lo storico lo registra. Il collegamento si
può anche togliere, sempre con evento.

**Quando la domanda cambia** *(scelta dell'assistente)*
- **Domanda respinta** (`rejected`): il bambino resta iscritto, ma passa fra quelli **«da verificare»**
  con il badge «domanda respinta» e non conta più fra i verificati. Decide la segreteria: o lo riporta
  «aperto»/«perso», o lo conferma a mano.
- **Domanda cancellata** (conservazione o oblio): `domanda_id` diventa nullo e il bambino resta iscritto,
  con il badge «domanda non più presente». Un evento lo registra. Da lì conta fra gli iscritti a mano.
- **Seconda domanda per lo stesso bambino:** non si collega in automatico a un bambino che è già
  collegato. Si scrive un `logEvento` senza dati, e la scheda mostra «è arrivata un'altra domanda».

Per accorgersi del rifiuto, la route che cambia lo stato della domanda chiama lo stesso modulo del
collegamento, a tentativo, come in `POST /api/iscrizione`. Non serve un cron.

## 8. L'interfaccia per l'assistente AI

Autenticazione con `Authorization: Bearer <token>` (vedi `crm_integrazioni`). Ogni token vale solo per le
sedi ammesse, ha un limite di richieste e ogni chiamata si registra senza dati personali.

- `GET /api/crm/ai/slot?sede=…&dal=…&al=…[&persona=…]` → slot liberi, ciascuno con inizio, fine, id e nome
  di battesimo della segretaria, sede.
- `POST /api/crm/ai/prenota` → corpo: sede, inizio, persona (facoltativa), famiglia (nome del genitore,
  telefono, email facoltativa), bambini (nome, data di nascita), origine, nota facoltativa.
  - Se nella sede esiste già una scheda con quel telefono o quell'email, l'appuntamento va lì: niente
    doppioni. *(Scelta dell'assistente per i casi limite:)*
    - se quella scheda ha già un appuntamento «in programma», risponde `409 GIA_PRENOTATO`, con solo
      l'orario esistente: l'AI lo comunica alla famiglia e non ne crea un secondo;
    - i bambini nuovi, per nome e data di nascita, si aggiungono alla scheda;
    - un bambino «perso» torna «aperto», con evento; un bambino «iscritto» resta tale.
  - Risposte: `201` con id e orario, `409 SLOT_OCCUPATO`, `422` se la validazione fallisce.
  - La segretaria assegnata riceve una notifica nell'app.
- `DELETE /api/crm/ai/prenotazioni/:id` → annulla, solo le prenotazioni fatte da quel token.

L'AI **non legge** le schede esistenti. Nelle statistiche di «chi ha fissato» l'AI ha una riga sua.

## 9. Schermate, permessi, conservazione

**Schermate:** `/admin/crm`, con voce di menu solo per la segreteria.
- **Agenda:** la settimana, una colonna per segretaria, con slot liberi e appuntamenti. Da qui si fissa e
  si sposta.
- **Schede:** elenco con filtri (esito, persona, da richiamare oggi, «senza domanda collegata», origine,
  periodo). Il dettaglio è un pannello fisso che si apre **sullo storico**, con sopra famiglia e bambini
  (badge e pulsante «Associa»), appuntamenti e prossima azione.
- **Disponibilità:** ognuna modifica la propria settimana e le proprie assenze.
- **Statistiche:** vedi §10.
- **Integrazioni** (solo admin): creare, vedere e revocare le chiavi dell'AI. Il token si vede una volta
  sola, quando lo si crea.

**Fissare fuori dagli slot** *(scelta dell'assistente)*
- La segretaria **può** fissare a qualsiasi ora, anche per chi non ha inserito la disponibilità. L'agenda
  mostra un avviso «fuori disponibilità», ma non blocca.
- Il database impedisce solo la sovrapposizione. Gli slot vincolano solo l'AI.
- Se una disponibilità si restringe, le visite già fissate restano e prendono lo stesso avviso.
- L'avvio quindi non dipende dal fatto che tutte abbiano inserito la propria settimana. Senza
  disponibilità, l'AI per quella persona non trova slot.

**Permessi**

| Chi | Cosa può fare |
|---|---|
| Segreteria | Tutto sulla propria sede, niente sulle altre. Comprese le statistiche per persona di tutte le colleghe della sede (decisione del titolare). |
| Admin (titolare) | Tutte le sedi, e il confronto fra sedi. |
| Coordinatrici (Direzione) | `403` per ora: nelle sedi vere non c'è nessun account `coordinator`. Aggiungerle è una riga. *(Scelta dell'assistente.)* |
| Docenti, genitori, cucina | `403`. |
| Token AI | Solo §8. |

**Conservazione** *(scelta dell'assistente, da controllare)*
- **Si anonimizza, non si cancella**: dopo 12 mesi dall'ultimo evento. Si svuotano nomi, telefoni, email,
  note, testo degli eventi e le tre domande del manuale. Restano sede, date, enumerazioni, esiti e
  attribuzioni.
  - Così il confronto gennaio su gennaio sopravvive.
  - Le colonne con dati personali nascono annullabili fin dalla prima migrazione, più `anonimizzata_il`.
- Il cron che lo fa **non entra nella prima versione**. Il CRM parte vuoto, quindi la prima scheda da
  anonimizzare arriva un anno dopo l'avvio. Va nel piano come lavoro datato, prima di quella scadenza.

## 10. Le metriche

| Metrica | Definizione | A chi va | Escluso |
|---|---|---|---|
| Appuntamento concluso | stato svolto o non presentato | — | gli annullati |
| Tasso di presentazione | svolti / conclusi | `fissato_da`; l'AI a parte | — |
| Close rate | bambini iscritti / bambini delle schede con una visita svolta nel periodo | `svolto_da` dell'ultima visita svolta prima dell'iscrizione; una persona per bambino, mai due | — |
| Iscritti verificati | quelli con domanda collegata | — | — |
| Iscritti a mano | quelli senza domanda collegata | — | — |
| Ritardo contatto → visita | mediana in giorni | — | — |
| Follow-up in tempo | azioni fatte entro il giorno di scadenza / azioni scadute nel periodo (righe di `crm_azioni`) | `responsabile`; è attività, non merito | azioni cancellate |

Iscritti verificati e iscritti a mano si mostrano separati. Il periodo si legge sulla data della visita.

**Casi di prova (da tradurre in test):**
1. La Segretaria 1 fissa, la Segretaria 2 svolge, il bambino si iscrive → presentazione +1 alla 1,
   iscritto +1 alla 2.
2. La 2 svolge, la 1 segna «svolto» → la visita va alla 2.
3. Una famiglia con due bambini, se ne iscrive uno → 1 iscritto su 2.
4. La visita viene spostata due volte da una collega → un appuntamento solo, due eventi nello storico.
5. Un iscritto a mano senza domanda → conta fra gli iscritti a mano, non fra i verificati.
6. L'AI fissa → presentazione alla riga «AI».

## 11. Le vecchie schede e lo spegnimento

- **Le 228 schede della mini-app non si importano** (decisione del titolare, 30/10). Il CRM parte vuoto:
  niente script di import, niente attribuzioni «non attribuite», niente confronto con l'anno scorso dentro
  l'app.
- **Dopo l'avvio:** si spengono il progetto Firebase, le funzioni, il sito Netlify, e si cancellano gli
  eventi con dati personali dai tre Google Calendar. Lo fa il titolare, che ha le credenziali; il piano gli
  consegna la lista dei passi e la prova da una finestra anonima.

## 12. Come si verifica (lo può rifare un terzo)

- **Matrice dei permessi**, scritta prima: ruolo × sede × azione → esito atteso. La provano test delle API e
  un E2E: una segretaria di Giugliano non vede né sposta schede di Aversa; una collega della stessa sede sì;
  una coordinatrice riceve `403`. Le statistiche per persona della sede le vede ogni segretaria di quella
  sede, e nessuna di un'altra.
- **Statistiche:** i casi del §10, più un dataset finto di 20 appuntamenti con i numeri attesi calcolati a
  mano.
- **Collegamento:** telefoni scritti in formati diversi (`+39 333…`, `0039…`, con spazi), email con
  maiuscole, due schede che coincidono (solo avviso), sede diversa (nessun collegamento), un errore del
  collegamento (la domanda passa lo stesso).
- **AI:** slot occupato → `409`; due prenotazioni simultanee → una sola riesce; token revocato → `401`;
  sede non ammessa → `403`; nessun doppione per telefono già noto.
- **Log:** nessun dato personale (lock di redazione verde).
- **Prova d'uso:** fissare per una collega, spostare, segnare svolto, associare il bambino. La fa una
  segretaria senza aiuto.

## 13. Lasciato a chi costruisce

Nomi di tabelle e colonne, algoritmo di generazione degli slot, forma del vincolo anti-sovrapposizione,
testi delle notifiche, impaginazione, suddivisione in PR. Vincoli di ordine: la prima versione utilizzabile
(vedi §14, punto 3) deve arrivare prima di gennaio; l'interfaccia per l'AI viene dopo.

## 14. Decisioni aperte del titolare

Risposte del titolare, 30/10/2026:

1. **Le 228 schede della mini-app non si importano.** Si parte da zero (§11).
2. **Le statistiche per persona le vede tutta la sede.** Ogni segretaria vede i numeri delle colleghe
   della propria sede; l'admin vede tutte le sedi e il confronto (§9).
   - *Nota dell'assistente:* sono misure di rendimento su lavoratori nominati e visibili ai colleghi.
     Prima dell'avvio conviene chiedere alla consulente del lavoro se serve un'informativa alle segretarie
     (Statuto dei lavoratori, art. 4, e privacy dei dipendenti). Non è un parere legale: è la domanda da
     fare.
3. **A gennaio il CRM, l'AI dopo.** La prima versione comprende schede e bambini, agenda e spostamenti,
   disponibilità, follow-up, storico, collegamento con le domande e statistiche. L'interfaccia per l'AI
   (§8) e la pagina «Integrazioni» arrivano in un rilascio successivo. Lo schema però nasce già con
   `fissato_via`, `creato_via` e il vincolo anti-sovrapposizione, così l'AI non richiede migrazioni di
   struttura.

**Prerequisito di avvio (misurato il 30/10, solo conteggi).** Chi fa le visite deve avere un account
`segreteria` o `admin` nella propria sede. Nelle tre sedi vere oggi gli account sono:
- `segreteria`: 5 (Aversa 1, Cesa 2, Giugliano 2);
- `admin` con sede: 2;
- `coordinator`: 0.

Nella mini-app i nomi distinti erano circa 6, quindi va controllato persona per persona prima di gennaio.

## 15. Scelte dell'assistente (da controllare)

Le ha prese l'assistente dopo la revisione indipendente del 30/10. Ognuna si può ribaltare senza toccare
il resto.

- **L'admin entra nel CRM su tutte le sedi**, e c'è una pagina «Integrazioni» solo sua per le chiavi
  dell'AI (§3, §9).
- **Assegnare e svolgere una visita** lo possono le persone con account `segreteria` o `admin` di quella
  sede. Le coordinatrici restano fuori finché non ce ne sono (§9, §14).
- **Follow-up:** si riprende la catena della mini-app (+2, +3, +3 giorni alle 10:30, riprova il giorno
  dopo se non risponde), più un «recupero» dopo un non presentato (§6, `crm_azioni`).
- **Domanda respinta** → «da verificare»; **domanda cancellata** → resta iscritto, conta fra gli iscritti
  a mano (§7).
- **L'AI su una famiglia già prenotata** risponde `409 GIA_PRENOTATO` e non crea un secondo appuntamento
  (§8).
- **La segretaria può fissare fuori dagli slot**, con un avviso; gli slot vincolano solo l'AI (§9).
- **Conservazione:** anonimizzare a 12 mesi invece di cancellare; il cron arriva dopo la prima versione
  (§9).
- **P1:** la quota saldata è un segno sulla scheda, non entra nel conteggio degli iscritti (§5).
- **P2:** la domanda «anno in corso / anno prossimo» resta fuori dalla prima versione (§2).
- **Gli esempi usano «Segretaria 1 / 2»**, mai nomi veri: il repository è pubblico.
