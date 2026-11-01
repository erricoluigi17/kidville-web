# CRM della segreteria — la quota d'iscrizione in contabilità e le disponibilità settimana per settimana

*Documento di progetto · 31/10/2026 · branch `feat/crm-quota-disponibilita` · segue
[`2026-10-30-crm-segreteria-design.md`](2026-10-30-crm-segreteria-design.md) (CRM in produzione con #273 e #274).*

## 1. Perché

Il CRM è in produzione da oggi. Luigi, guardando i video tutorial, chiede due cambiamenti:

1. **La quota d'iscrizione** non deve essere solo una spunta con una data. Deve avere l'**importo** e deve
   **portare il bambino in contabilità**, sulla quota d'iscrizione del suo anno scolastico. La cassa del
   giorno deve tornare: se la famiglia paga in contanti, quei soldi sono nel cassetto oggi.
2. **Le disponibilità** non devono essere una settimana tipo che vale per sempre. Si danno **per persona o
   per tutta la sede**, e **settimana per settimana**.

## 2. Decisioni prese

| Decisione | Chi | Quando |
|---|---|---|
| Un alunno **nuovo** paga la quota **prima** di essere in anagrafica (la domanda non è ancora importata) | Luigi | 31/10 |
| I contanti della quota entrano **subito** nella cassa del giorno, anche se il bambino non è in anagrafica | Luigi | 31/10 |
| Strada **A**: entrata di cassa subito, voce sull'alunno quando l'alunno esiste (vedi §4) | Luigi | 31/10 |
| In una fascia **della sede**, chi riceve la famiglia lo **sceglie chi fissa** la visita | Luigi | 31/10 |
| Una settimana nuova **parte dalla precedente** | Luigi | 31/10 |
| Il riassunto delle disponibilità del §6 è giusto (comprese le proposte dell'assistente lì elencate) | Luigi | 31/10 |
| Una quota pagata con **bonifico** la chiude la banca: la voce nasce da pagare (§5.2) | Luigi | 31/10 |
| L'anno scolastico della quota si ricava dall'anno di ingresso del bambino | assistente, non contestata | 31/10 |
| Un orario della sede è libero finché almeno una persona della sede è libera a quell'ora | assistente, non contestata | 31/10 |

Le scelte marcate *[assistente]* nel resto del documento sono dell'assistente e Luigi le può cambiare.

## 3. Obiettivi, non obiettivi, anti-obiettivi

**Obiettivi**
- La segreteria segna la quota dalla scheda del CRM: importo, giorno, metodo. Non deve aprire la contabilità.
- I contanti compaiono nella cassa del giorno nello stesso momento.
- Quando il bambino diventa alunno, la quota diventa la sua voce «Iscrizione AAAA/AA» in contabilità, già
  pagata (da pagare se è un bonifico, finché non arriva), **senza che il totale di nessun giorno di cassa
  cambi**.
- Nessuna quota resta dimenticata: chi non è ancora agganciato a un alunno si vede in una lista.
- Le disponibilità si leggono e si cambiano per settimana; una settimana non toccata è uguale alla precedente.
- Le fasce della sede mostrano orari liberi senza nome; la persona si sceglie quando si fissa.

**Non obiettivi**
- Fatturare la quota prima che esista l'alunno: la fattura segue la voce, come oggi.
- Gestire la quota d'iscrizione fuori dal CRM in modo diverso da oggi (la contabilità resta com'è).
- Rifare i video tutorial: dopo il rilascio vanno rigirati l'8 (quota) e l'11 (disponibilità), a parte.
- Disponibilità con eccezioni «solo per questa settimana»: Luigi ha scelto che la settimana nuova erediti
  dalla precedente.

**Anti-obiettivi** (sarebbe un fallimento anche se funzionasse)
- Un euro contato due volte in cassa, o un giorno di cassa già chiuso il cui totale cambia dopo.
- Una voce in contabilità senza alunno: oggi **3.638 voci su 3.638** hanno un alunno, e cassa, estratto
  conto, fatture, solleciti e notifiche ai genitori lo danno per scontato.
- L'import delle domande che fallisce per colpa del CRM.
- Una seconda voce «Iscrizione» per lo stesso alunno e lo stesso anno.

## 4. Strade considerate per la quota pagata prima dell'anagrafica

| | Strada | Perché sì | Perché no |
|---|---|---|---|
| **A** ✅ | Entrata di cassa subito; voce sull'alunno quando l'alunno esiste, con l'entrata agganciata all'incasso | La contabilità resta «ogni voce ha un alunno»; la cassa accetta già entrate senza voce | Finché il bambino non è in anagrafica la quota non è nell'estratto conto di nessuna famiglia |
| B | Voce in contabilità senza alunno, intestata alla scheda del CRM | La più diretta | Tocca tutte le letture della contabilità, che oggi presumono l'alunno |
| C | Il CRM crea subito l'alunno in anagrafica | Contabilità invariata | Il CRM non ha il codice fiscale: all'import della domanda nasce un doppione; l'alunno comparirebbe in classi e appello |

Luigi ha scelto **A**.

## 5. Parte 1 — La quota d'iscrizione

### 5.1 Cosa segna la segreteria

Nel riquadro «Bambini» della scheda, al posto della sola spunta:

- **importo** (euro, > 0, due decimali);
- **giorno del pagamento** (vuoto = oggi; mai nel futuro);
- **come ha pagato**: contanti, carta (POS) o bonifico *[assistente: i tre metodi che la cassa conosce;
  `assegno` e `altro` esistono ma non servono qui]*;
- l'**anno scolastico** non si sceglie: si ricava dall'anno di ingresso del bambino — `in_corso` → anno
  scolastico corrente (`annoScolasticoCorrente()` di `src/lib/anno-scolastico.ts`), `prossimo` → quello
  successivo. Con `non_indicato` il CRM chiede di indicarlo prima di salvare *[assistente]*.

**Contanti e cassa già chiusa** *[assistente]*: per i contanti il giorno del pagamento deve cadere **dopo
l'ultima chiusura di cassa** della sede. La chiusura registra come rettifica la differenza col contato:
un'entrata datata a un giorno già chiuso conterebbe due volte quei soldi. Se il giorno è già chiuso, il CRM
lo dice e propone oggi.

**La vecchia spunta** *[assistente]*: `quota_saldata` e `quota_saldata_il` sono sostituite dalla quota con
importo. In produzione c'è **una** sola quota spuntata, nella sede Demo, creata per il tutorial: si mostra
come «quota senza importo» e si può completare, poi segue il percorso normale. Il builder decide se tenere le
colonne vecchie come derivate o toglierle, purché l'API e la scheda non dipendano più da loro.

### 5.2 Cosa succede, caso per caso

| Il bambino… | Metodo | Subito | Quando diventa alunno |
|---|---|---|---|
| è già alunno (fratello, rinnovo, già collegato) | contanti o carta | nasce la voce «Iscrizione AAAA/AA» pagata, con il suo incasso | — |
| è già alunno | **bonifico** | nasce la voce «Iscrizione AAAA/AA» **da pagare**; la chiude il bonifico dall'estratto conto | — |
| non è ancora alunno | **contanti** | un'**entrata** in `cassa_movimenti` nella cassa del giorno | nasce la voce pagata; l'entrata si aggancia all'incasso |
| non è ancora alunno | carta | niente in cassa (non è nel cassetto); la quota è «in attesa» | nasce la voce pagata con il suo incasso |
| non è ancora alunno | **bonifico** | niente in cassa; la quota è «in attesa» | nasce la voce **da pagare**; la chiude il bonifico dall'estratto conto |

**Bonifico: la voce la chiude la banca** (decisione di Luigi, 31/10). Per un bonifico non nasce mai un incasso dal
CRM: nasce la voce aperta con l'importo segnato, e la riconciliazione bancaria la chiude quando il movimento
arriva, da sola se la causale corrisponde, altrimenti a mano come per gli altri bonifici. È la banca a provare
che i soldi sono arrivati, e così il movimento bancario trova sempre una voce aperta su cui posarsi invece di
finire su un'altra voce della famiglia. Nel CRM la quota si legge «in contabilità, in attesa del bonifico»
finché la voce non è pagata. Carta (POS) e contanti invece sono pagati subito: la ricevuta del POS e il
contante in mano sono già la prova *[assistente, per la carta]*.

**L'entrata di cassa** (contanti, bambino non ancora alunno): `tipo = 'entrata'`, `metodo = 'contanti'`,
`importo`, `data` = giorno del pagamento, `cassa_categoria_id` = la categoria di sistema dei pagamenti con
`slug = 'iscrizione'` (è la «cassa di provenienza»), `categoria_id` nullo (le `cassa_categorie` sono
categorie di spesa), `descrizione` = «Quota d'iscrizione AAAA/AA – nome del bambino (CRM)» *[assistente:
la descrizione la leggono solo gli staff della sede, ed è il modo in cui chi conta il cassetto sa di chi
sono quei soldi; non entra mai in un log]*, `registrato_da` = chi segna.

**La voce** (quando c'è l'alunno): in `pagamenti`, categoria di sistema `iscrizione`, `descrizione` =
«Iscrizione AAAA/AA», `importo`, `scadenza` = giorno del pagamento, **`periodo_competenza` = 1° settembre
dell'anno d'apertura** (es. `2027-09-01` per il 2027/28), `tipo = 'singolo'`, `alunno_id`, `scuola_id` =
sede della scheda, `creato_da`. Poi il suo **incasso** in `incassi` con lo stesso importo e metodo e
**`data_incasso` = giorno del pagamento**, non il giorno dell'aggancio.

*Nota di esecuzione (31/10/2026): per il bonifico la scadenza è il giorno del pagamento + 30 giorni, perché il cron dei solleciti non scriva a chi ha già pagato; decisione dell'assistente, da confermare dal titolare. Precisazione (ritocco finale, 31/10/2026): i 30 giorni partono dal più tardi fra il giorno del pagamento e oggi a Roma (`GREATEST(quota_saldata_il, oggi a Roma) + 30`), perché la voce nasce quando arriva l'alunno e per un bambino «prossimo» può essere mesi dopo il bonifico: ancorata al giorno del pagamento nascerebbe già scaduta, col sollecito in coda a chi ha pagato, e un bonifico arrivato prima che la voce esistesse non ha potuto essere riconciliato (la segreteria lo associa a mano entro i 30 giorni). Inoltre l'interfaccia ora manda sempre `giorno` (il campo parte da oggi, e un giorno vuoto o incompleto spegne «Salva»); il server accetta ancora il vuoto come oggi, quindi «vuoto = oggi» del §5.1 vale solo per chi chiama l'API.*

Il `periodo_competenza` non è un dettaglio: la fatturazione sceglie la serie dall'anno di competenza
(`annoScolasticoDiCompetenza`, `src/lib/fatturazione/sezionale.ts`). Senza, una quota del 2027/28 pagata a
novembre 2026 verrebbe fatturata sulla serie del 2026/27.

La voce e l'incasso si creano con **lo stesso percorso** che usa la contabilità quando registra un incasso
(`/api/pagamenti/incassi` e la funzione che chiama), non con un `insert` scritto a parte: così valgono le
stesse regole (stato pagato, `importo_pagato`, scatola nera).

**Autore e notifiche** *[assistente]*: `creato_da` della voce e `registrato_da` dell'incasso sono **chi ha
segnato la quota**, anche quando l'aggancio parte dall'import o da un collega. Quando la voce nasce da un
aggancio (automatico o a mano, a quota già segnata), al genitore **non** parte la notifica «Pagamento
registrato»: arriverebbe insieme alle credenziali, per un pagamento di giorni prima; la voce pagata resta
comunque visibile nell'app. Se invece il bambino è già alunno nel momento in cui si segna la quota, valgono
le notifiche normali della contabilità.

### 5.3 La regola che impedisce il doppio conteggio

La cassa somma due cose: i movimenti veri (`cassa_movimenti`) e, come entrate virtuali, gli incassi in
contanti delle voci (`incassi`, `metodo = 'contanti'`, non stornati) — in `src/app/api/pagamenti/cassa/
movimenti/route.ts` e in `src/lib/cassa/saldo.ts`. Quando la quota passa in contabilità nasce un incasso in
contanti che la cassa conterebbe **in più** rispetto all'entrata già registrata.

**Regola nuova:** un movimento di cassa con `incasso_id` valorizzato è **assorbito** da quell'incasso e non
si conta: lo rappresenta l'incasso, con lo stesso importo, metodo e data. All'aggancio si scrive
`cassa_movimenti.incasso_id = <id dell'incasso>`. Il totale del giorno resta identico, anche se quel giorno
è già stato chiuso.

- La regola vale in **ogni** punto che somma o elenca la cassa: lista dei movimenti, saldo, report e CSV,
  chiusure, lettura multi-sede, KPI. Il builder li trova tutti e li fa passare da **una** funzione pura
  condivisa, con il suo test.
- Oggi **0 movimenti su 168** hanno `incasso_id`: la regola non cambia nessun totale passato.
- Lo storno di un movimento con `incasso_id` è già rifiutato dalla cassa («si storna dallo Scadenzario»):
  resta così.

### 5.4 L'aggancio all'alunno

- **Automatico, all'import della domanda.** In `src/lib/iscrizioni/import/esegui.ts`, per ogni figlio la
  funzione `alunnoDiRiferimento` restituisce l'alunno creato o ritrovato per `(domanda.id, ass.indice)`.
  `ass.indice` è la posizione del figlio in `data.children`, cioè lo stesso numero che il CRM salva in
  `crm_bambini.domanda_figlio`. Dopo che l'alunno esiste, l'import chiama una funzione del CRM che: trova il
  bambino del CRM con quella domanda e quel figlio, gli scrive l'alunno, e se ha una quota in attesa la passa
  in contabilità (§5.2).
  Questa funzione segue le regole di `src/lib/crm/collegamento.ts`: **non lancia mai**, ogni guasto è una
  riga di log e un esito; con le tabelle `crm_*` assenti (database E2E della CI) fa `non_installato`.
  **L'import non fallisce mai per colpa del CRM.**
- **Domanda già importata quando si collega** *[assistente]*. Se il CRM collega al bambino una domanda (in
  automatico o a mano) che è **già stata importata**, cerca l'alunno fra quelli che l'import ha creato per
  quella domanda (`iscrizioni_import_esiti.alunni_creati`), della stessa sede, con la stessa data di nascita
  e lo stesso nome. Uno solo → si collega; nessuno o più d'uno → resta da collegare a mano. Si leggono gli
  **alunni**, non la domanda: la regola 1 di `collegamento.ts` (dalla domanda solo nome, nascita e recapiti)
  resta intatta.
- **A mano, dalla scheda.** Per un fratello o un rinnovo che è già in anagrafica senza passare da una domanda,
  o quando la ricerca qui sopra non trova un solo alunno: «Collega all'alunno», con una ricerca fra gli alunni
  **della stessa sede**. Collegare un bambino che ha una quota in attesa la passa in contabilità.
- Un bambino del CRM si collega a **un** alunno, e un alunno a **un** bambino del CRM.

### 5.5 Casi che non devono rompersi

- **L'alunno ha già una voce «Iscrizione» per quell'anno** (stessa categoria, stesso `periodo_competenza`,
  oppure senza competenza ma con scadenza nello stesso anno scolastico): non se ne crea una seconda. Oggi la
  contabilità assegna la quota d'iscrizione a mano, quindi il caso è probabile *[assistente]*:
  - voce **aperta** → la quota la paga: l'incasso si registra su quella voce e l'entrata di cassa si aggancia
    a lui. Se l'importo supera il residuo, la quota resta bloccata in lista (niente credito automatico). Per
    un bonifico non si registra niente: la quota si lega alla voce aperta, che chiuderà la banca;
  - voce **già pagata** → la quota resta bloccata in lista con il motivo «c'è già una quota d'iscrizione
    pagata per quest'anno» e un'azione: «È lo stesso pagamento» (per i contanti storna l'entrata del CRM, per
    gli altri metodi toglie la quota dal CRM). Ogni altro caso si risolve in contabilità.
- **Correggere una quota in attesa:** dalla scheda si cambiano importo, giorno e metodo, o la si toglie.
  Per i contanti si fa con lo storno già esistente della cassa (contro-movimento), non cancellando righe.
- **Correggere una quota già in contabilità:** il CRM la mostra in sola lettura con il collegamento alla voce;
  si corregge in contabilità come ogni altro incasso.
- **Il bambino diventa «perso» con una quota in attesa:** la quota resta in attesa e in lista; il rimborso è
  una decisione della segreteria, fuori da questo lavoro.
- **Il database E2E della CI non è migrato:** le colonne nuove non esistono (`PGRST204` in scrittura,
  `42703` in lettura). Il codice degrada pulito, come il resto del CRM.

### 5.6 La lista «Quote d'iscrizione in attesa dell'alunno»

In contabilità, per sede: bambino, scheda del CRM (collegamento), anno scolastico, importo, metodo, giorno
del pagamento, giorni di attesa, motivo se bloccata (§5.5). Una quota sparisce dalla lista quando passa in
contabilità. *[assistente: dove metterla nella pagina della contabilità lo decide il builder seguendo come
sono fatte le altre liste.]*

### 5.7 Storico del CRM

`crm_eventi.tipo` ha un vincolo `CHECK`: si estende. `quota_segnata` porta in `dati` importo, metodo,
giorno e anno; nuovi tipi per «quota passata in contabilità», «quota corretta», «quota tolta» e «alunno
collegato» / «collegamento all'alunno tolto». Mai testo libero di minori nei `dati`.

## 6. Parte 2 — Le disponibilità

### 6.1 Come funzionano (approvato da Luigi)

- **Due tipi di fascia:** della **persona** (riceve lei) e della **sede** (riceve chi sceglie chi fissa, fra
  le persone libere a quell'ora).
- **Per settimana:** la pagina mostra una settimana (frecce avanti e indietro, «Questa settimana»), con una
  riga per la sede e una per ogni persona della segreteria della sede, e i giorni con le fasce.
- **Una settimana mai modificata è uguale alla precedente.** Modificare una settimana vale per quella e per
  tutte le successive finché qualcuno non la cambia di nuovo. Conseguenza accettata: un mercoledì aggiunto
  per una sola settimana si ritrova la settimana dopo e va tolto.
- **Le settimane passate non si modificano.** Quella in corso e le future sì.
- Si può preparare una settimana futura senza toccare quelle prima.
- Ferie, malattie e chiusure (`crm_indisponibilita`) restano come oggi.
- Ogni persona della segreteria della sede può cambiare le fasce della sede e quelle dei colleghi.
- Cambiare le fasce non tocca le visite già fissate; una visita rimasta fuori dalle fasce si segnala in
  agenda (oggi lo fa `fuoriDisponibilita` in `src/lib/crm/slot.ts`).

### 6.2 Una sola strada sensata

Ogni «proprietario» (una persona, oppure la sede) ha delle **settimane registrate**. Per sapere le fasce di
un proprietario in una settimana W si prende la sua settimana registrata più recente **non successiva** a W.
Modificare W per un proprietario che non ha W registrata **copia** le fasce che W ereditava e poi applica la
modifica, in un'unica operazione nel database (niente copie a metà).

L'alternativa — settimana tipo più eccezioni — è esclusa dalla scelta di Luigi.

Modello *[assistente; il builder può affinarlo tenendo le regole]*: una testata per settimana
(`scuola_id`, `utente_id` **nullo = la sede**, `settimana` = il lunedì, unica per sede+proprietario+settimana)
e le fasce come figlie (giorno, dalle, alle, durata dello slot). Una testata senza fasce è una settimana
volutamente vuota. `giorno_settimana`, ora di inizio e fine e durata restano come oggi; `valida_dal` e
`valida_al` non servono più. In produzione oggi c'è **1 fascia** (sede Demo, creata per il tutorial):
la migrazione la converte, nessun dato vero da salvare.

### 6.3 Gli orari liberi

- Fascia della **persona**: come oggi, uno slot per persona, escluse sue visite e assenze.
- Fascia della **sede**: uno slot senza nome, **libero se almeno una persona della sede** è libera in quello
  slot (nessuna visita in programma che si sovrappone, nessuna sua assenza, nessuna chiusura della sede).
  «Persone della sede» = le stesse che il CRM propone già come responsabili (`/api/admin/crm/persone`).
- Fissando su uno slot della sede, la finestra chiede la persona **fra quelle libere a quell'ora**.
  Il vincolo `crm_appuntamenti_no_sovrapposti` resta l'ultima difesa (409 `SLOT_OCCUPATO`).
- Se una persona ha una sua fascia e la sede ne ha una alla stessa ora, si vedono entrambi gli slot.

## 7. Vincoli

- **Dati di minori:** nei log solo uuid, importi, conteggi e codici d'esito (`@/lib/logging/redact`).
- **Migrazione:** una sola, nominata con l'ora UTC reale; la applica l'integrazione al merge, che fa il
  titolare. Dopo il merge: `SELECT` di verifica e `get_advisors` a 0 ERROR.
- **Multi-sede:** ogni scrittura dichiara la sua sede; quota, entrata, voce e alunno sono tutti della sede
  della scheda; il collegamento a mano cerca solo alunni di quella sede.
- **Pattern delle route:** `withRoute`, `requireStaff(request, ['segreteria'])` come il resto del CRM, `zod`,
  client service-role, PostgREST controllato sul valore di ritorno.
- **Logging obbligatorio:** il passaggio in contabilità e l'aggancio sono eventi critici e loggano anche il
  successo.
- **Gate:** `eslint --max-warnings 0`, `tsc --noEmit`, `vitest run` (lock compresi), `npm run build`, E2E in CI.
- **PRD** (`PRD REGISTRO ELETTRONICO.md`): stato e changelog datato nello stesso lavoro.

## 8. Come lo verifica un terzo

1. **Cassa che torna:** contanti segnati dal CRM per un bambino nuovo → entrata nella cassa di oggi; il giorno
   dopo si importa la domanda → nasce la voce pagata; il totale e il saldo della cassa del primo giorno sono
   **identici** prima e dopo, anche con il giorno chiuso.
2. **Bonifico:** quota con bonifico per un bambino nuovo → niente in cassa; all'import nasce la voce da pagare
   con quell'importo e nessun incasso; un movimento bancario con quella causale la chiude.
3. **Nessun doppione:** stesso alunno, stessa quota segnata due volte o aggancio ripetuto → una sola voce.
4. **Fattura sulla serie giusta:** la voce della quota 2027/28 pagata a novembre 2026 ha competenza
   `2027-09-01`.
5. **Import intoccabile:** con le tabelle `crm_*` assenti, e con un errore forzato nella funzione del CRM,
   l'import della domanda va a buon fine.
6. **Settimane:** test sulla funzione che risolve le fasce di una settimana (mai toccata = la precedente;
   modifica di W vista da W+1 e non da W−1; settimana vuota; passato bloccato).
7. **Slot della sede:** con due persone, una occupata e una in ferie a turno, lo slot della sede è libero
   finché una è libera, e la scelta della persona propone solo quella.
8. **Lista delle quote in attesa:** ogni quota non agganciata compare, con il motivo quando è bloccata.

## 9. Lasciato al builder

L'aspetto delle schermate (seguendo il CRM e la contabilità esistenti), i nomi esatti di colonne, funzioni e
route, il dettaglio della funzione SQL che copia una settimana, come mostrare in pagina che una settimana è
ereditata o modificata, e dove mettere la lista delle quote in attesa.
