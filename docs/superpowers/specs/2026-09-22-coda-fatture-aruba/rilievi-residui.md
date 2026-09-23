# Rilievi residui da chiudere in C0

## Ultimo critico del design (CORREGGERE)

### [grave] CONTRATTO + D1 + D2 + D4

Il predicato «partita non registrata» ha due testi incompatibili. La richiesta 1 di D1 e la R6 (§5.1) di D2 li chiedono entrambi al contratto, e ognuno sbaglia un caso.

Punto di partenza [V]: emissione.ts:2604 scrive fattura_aruba_id = okEsiti[0].uploadFileName, cioè il file della PRIMA quota riuscita.

Forma D1 (in_attesa, nessuna riga viva né col file del pagamento):
- Caso: quota B viva a registro, file della quota A assente. Il predicato dà FALSO e il 409 non scatta.
- L'idempotenza guarda solo le righe vive (emissione.ts:1458 [V]), quindi riemetterebbe A.
- [D] Dal pannello non ci si arriva: su in_attesa FatturaButton mostra solo il badge (FatturaButton.tsx:470-477 [V]).

Forma D2 (in_attesa e (nessuna viva oppure file assente)):
- Caso: la sola riga SCARTATA dello stesso file, cioè scarto registrato dalla sync e pagamento non aggiornato. Il predicato dà VERO e rifiuta una ritrasmissione legittima.
- Contraddice la riga «scartata con lo stesso file ⇒ falso» del test 4 di D1 e il caso (iii) della sua richiesta 1.

[V, SELECT del 23/09] Oggi in_attesa = 6, entrambe le forme danno 6, i due casi divergenti sono 0. Non cambia il rilascio, ma i test di D1 e D2 si contraddicono.

**Correzione richiesta:** C§9.4 e C§18 fissano un solo predicato. Va usato identico nel modulo di D1 (TS e gemello SQL), in _fatture_coda_partita_non_registrata di D2 e nel pre-controllo di D4:

```sql
p.fattura_stato='in_attesa' AND CASE
  WHEN p.fattura_aruba_id IS NOT NULL THEN NOT EXISTS (
    SELECT 1 FROM fatture_emesse f
    WHERE f.pagamento_id=p.id AND f.aruba_filename=p.fattura_aruba_id)
  ELSE NOT EXISTS (
    SELECT 1 FROM fatture_emesse f
    WHERE f.pagamento_id=p.id
      AND (f.sdi_stato IS NULL OR f.sdi_stato <> ALL(STATI_SDI_SCARTO)))
END
```

Oggi vale ancora 6.

Test da aggiungere:
- in D1: «riga viva di un'altra quota e file del pagamento assente ⇒ vero»;
- in D2: «sola riga scartata dello stesso file ⇒ accodata con motivo ritrasmissione».

La parità TS/SQL si prova su PGlite in D1, e il lock specchio di D2 confronta i due testi.

### [grave] CONTRATTO + D2 + D3

Un BAD_INPUT di fatture_coda_invio_registra arriva DOPO la RPC del numero. C§10.11 e D3 (Tab. A, «fermata-prima-dell-upload · numero non conservato → G») lo trattano come guasto nostro transitorio: numero bruciato e poi rientro.

Ma il rifiuto è deterministico, e ogni rientro consuma un numero fiscale:
- Il giro dopo riprende la stessa voce, che resta in testa, e brucia un numero nuovo, fino a 4 per voce.
- Con un difetto sistematico si passa alla voce successiva: circa 12 buchi di numerazione l'ora, 24 ore su 24 [D].
- Lo STOP di C§18 vale solo per le prime ore.

La decisione 17 parla di «errore DB momentaneo», non di un rifiuto che si ripete: questo è un ritentativo cieco.

La prova a secco di D3 copre solo un sottoinsieme TS dei controlli SQL. verificaFormaInvio, per esempio, non confronta pagamento_id e scuola_id di riga_registro con quelli della VOCE: InvioDaRegistrare non ha pagamento_id, mentre _fatture_coda_riga_difetto li confronta.

**Correzione richiesta:** (a) Portare la prova a secco nell'SQL, senza aggiungere RPC: fatture_coda_invio_registra riceve p_solo_verifica boolean DEFAULT false.
- Con true esegue tutti i controlli di §7.3 su un documento col numero segnaposto, e non scrive.
- D3 la chiama prima di prenotaInvio e della RPC del numero.
- Un BAD_INPUT in quel punto chiude la voce in errore senza consumare numeri.

(b) Se un BAD_INPUT arriva comunque dopo il numero, la voce chiude errore giornale_non_aperto (codice di R7/r6), con effetto ferma e anomalia agli admin. Mai rientro.

(c) Test PGlite: BAD_INPUT dopo il numero ⇒ un solo invio bruciata, voce in errore, nessun secondo numero al giro dopo.

### [grave] D5 + D6 + CONTRATTO

C§17.4 e l'E2E E19 di D6 cercano un link «Ritrasmetti» che porti alla scheda alunno con ?pagamento=. D6 lo ricava da D5 v5 (G17).

D5 v6 invece (§5.3 e §6) mostra il FatturaButton in linea solo con azioni.ritrasmetti. Su un pagamento scartato il suo trigger è «Riprova fattura» (FatturaButton.tsx:489 [V]), e nella tabella dei nomi di §12 «Ritrasmetti» non esiste.

Così com'è scritto, E19 è rosso.

**Correzione richiesta:** Fissare un nome solo in D5 §12 e in C§17.4. Due possibilità:
- il trigger in linea «Riprova fattura» dentro la riga della voce;
- un pulsante «Ritrasmetti» che apre il modale «Metti in coda la fattura».

D6 riscrive E19 di conseguenza:
- presenza del comando, apertura del modale con l'anteprima simulata, POST singolo sul pagamento della voce;
- nessun comando con ritrasmetti=false o su una voce d'altra sede.

### [grave] D2 + D6

Battito della pulizia: D2 e D6 descrivono due righe diverse.
- D2 scrive tutti i log SQL con _fatture_coda_log, che compone il fingerprint come left(evento:operazione:esito…). Per la pulizia risulta 'cron:fatture-coda-pulizia:ok'.
- D6 §6.5 asserisce fingerprint='cron:fatture-coda-pulizia'.
- Nella PR-B, con fatture-coda-pulizia in JOB_CRON e nessuna route con const JOB, health.test.ts:648-657 [V] pretende il letterale 'cron:fatture-coda-pulizia' dentro supabase/migrations.

I battiti SQL che esistono oggi scrivono quel letterale in modo esplicito (20260807211157_presenze_retention_motivo_assenza.sql:146-158 [V]).

Implementato come scritto, fallisce il cardine nella PR-A e health.test.ts nella PR-B.

**Correzione richiesta:** Il battito della pulizia si scrive con:
- fingerprint letterale 'cron:fatture-coda-pulizia' presente nel file 3, tramite un parametro opzionale p_fingerprint di _fatture_coda_log oppure un INSERT dedicato come quello delle retention;
- evento='cron', livello='info';
- contesto.campi = {operazione:'fatture-coda-pulizia', esito:'ok', n_*}.

Il lock specchio di D2 verifica il letterale; D6 §6.5 resta com'è.

### [minore] D2

Il tetto va contato fail-closed, e oggi il testo non lo garantisce.

_fatture_coda_upload_ultima_ora() e il conteggio al minuto contano i «tentativi upload con esito diverso da non_eseguito». In SQL, esito <> 'non_eseguito' esclude i NULL. Quindi una prenotazione in corso, o un tentativo il cui esito non è mai stato scritto (guasto del DB dopo l'upload), non consuma il budget. Questo contraddice C§9.1 («unico punto che consuma il budget, prima della chiamata») e il vincolo fail-closed del tetto.

**Correzione richiesta:** Scrivere esito IS DISTINCT FROM 'non_eseguito' in tutti i conteggi (ora e minuto).

Test in fatture-coda-cancello.test.ts: un upload prenotato con esito NULL occupa il posto, e con limite 2 il terzo riceve QUOTA_ORARIA.

### [minore] D4 + D5

«Rimetti in coda» non passa per le voci con intestatario proposto dal bonifico.
- D4 §10 rifà il pre-controllo con origine_iniziale e «la proposta si ricontrolla (§5.1)».
- Ma zCorpoRimetti non ha conferme_proposte, e RimettiInCodaDialog di D5 non ha la spunta.
- Risultato: una voce accodata con proposta_bonifico confermata, finita in errore per un dato (anagrafica_incompleta, intestatario_non_valido…), dopo la correzione esce sempre come proposta_da_confermare e non rientra.

La decisione 10 («Rimetti in coda», anche multiplo) diventa impraticabile proprio sul percorso più comune, la Riconciliazione.

**Correzione richiesta:** In rimetti il pre-controllo riceve come scelta l'intestatario salvato nella voce (intestatario_scelto e intestatario_origine):
- se è proposta_bonifico ed è uguale alla proposta ricalcolata, vale come confermato, perché lo era già all'accodamento;
- se diverge, la voce resta fra gli errori con proposta_da_confermare, e il dialogo dice di toglierla e riaccodarla dalla Riconciliazione con la spunta.

Servono i test in fattura-coda-azioni.test.ts e in RimettiInCodaDialog.test.tsx.

### [minore] D3

Con S46 D3 toglie dalla lista di fattura_scartata chi ha accodato, prima del ramo esistente in sync/route.ts:877-889 [V]. Quel ramo, se la lista è vuota, scrive logEvento('cron','error', esito 'scarto-senza-destinatari') e poi continue.

La lista può restare vuota solo per quell'esclusione:
- una sede la cui unica segreteria è chi ha accodato;
- oppure un non_identico con solo coordinator e segreteria, di cui una ha accodato.

Sono esiti attesi che finiscono a livello error, contro la decisione 23, e alzano tasso-errore.

**Correzione richiesta:** Distinguere due casi:
- lista vuota già prima dell'esclusione: error scarto-senza-destinatari, come oggi;
- lista vuota solo per l'esclusione di chi ha accodato: niente error, basta info, perché quella persona riceve scarto_sdi o il da_verificare dall'outbox.

Aggiungere un caso in fattura-sync-00404.test.ts e in fattura-sync-cancello.test.ts.

### [minore] D3

Il test ponte (§17 n. 19) usa due database. emettiFatturaPagamento scrive la riga a registro nel supabase finto (creaSupabaseEmissione). fatture_coda_invio_registrato di D2 invece cerca in fatture_emesse di PGlite una riga con stesso pagamento, serie, anno, numero e aruba_filename. Quindi l'asserzione «registrata dopo invio_registrato con l'id della riga inserita nel finto» riceve FATTURA_NON_CORRISPONDE.

C'è anche un secondo difetto: verificaFormaInvio (§8) confronta riga_registro.pagamento_id con doc, ma InvioDaRegistrare non ha pagamento_id.

**Correzione richiesta:** - Prima di invio_registrato, rispecchiare l'INSERT del finto in PGlite (semina.rigaRegistro con stesso id, pagamento, serie, anno, numero e aruba_filename), oppure far scrivere fatture_emesse del finto direttamente in PGlite.
- verificaFormaInvio riceve voce.pagamento_id e voce.scuola_id e li confronta con riga_registro, come fa l'SQL.

### [minore] D5

Due testi di D5 sono imprecisi.

(1) La conferma di «Rimanda» in VerificaEsitoDialog è unica: «se c'è la registro, se non c'è la rimando con lo stesso numero». Su una voce numero_conteso però su Aruba c'è già un documento DIVERSO con quel numero, e «Rimanda» ne crea un secondo con lo stesso numero, oppure uno scarto 00404 col numero perso. Il testo non lo dice (vedi domanda 1).

(2) In testi-notifica, {doc} = «{sezionale} n. {numero}/{anno}» scrive la serie FPR con l'anno a 4 cifre. Sul documento e in numero_leggibile della pagina il numero è «FPR 2542/26» (sezionale.ts:584-603 [V]), e sul pannello Aruba si cerca con quello.

**Correzione richiesta:** (1) Con codice numero_conteso, la conferma di «Rimanda» dice esplicitamente che su Aruba c'è un documento diverso con lo stesso numero, e che rimandarlo crea due documenti con quel numero. Il comportamento definitivo dipende dalla risposta del titolare.

(2) {doc} = formattaNumeroFattura(sezionale, numero, anno) dentro un try, con ripiego su «una fattura». Serve un test per ogni serie.

### [minore] CONTRATTO + D2 + D3 + D4 + D6

C§13 non fissa i nomi delle mappe e delle tuple, e i design non coincidono. A fase 0 chiusa, tsc sarebbe rosso.

Nomi divergenti:
- D2 esporta INTESTATARIO_ORIGINE/INTESTATARIO_ORIGINI; D3 usa ORIGINE_INTESTATARIO.
- D2 esporta CAUSALE_MODO/CAUSALE_MODI; D4 usa MODI_CAUSALE.
- D2 esporta AZIONE_RICHIESTA/AZIONI_RICHIESTE; D4 usa AZIONI_VERIFICA.
- D4 usa TIPI_DOCUMENTO_SUPPORTATI, che D2 non ha.
- D3 chiede ESITO_LOG_CANCELLO; D6 offre ESITO_LOG.

Firme cambiate: D3 modifica firme fissate da C§13 senza chiederlo, cioè giornaleDi(…, cv), risolviDocumenti con ctx.giornale e ctx.parcheggia, chiudiTentativo(…, opz).

Lock specchio: le eccezioni per 'sospesa' e 'assente' in vocabolario-log.ts vanno decise una volta sola. D2 le conta, D6 (richiesta 3) chiede invece di escludere il file.

**Correzione richiesta:** - C§13 elenca i nomi esatti di tutte le mappe e tuple di contratto-db.ts e vocabolario-log.ts: fanno fede quelli di D2 e D6, e D3 e D4 si adeguano in fase 0.
- C§13 registra le firme estese di D3.
- Il lock specchio adotta una sola regola per vocabolario-log.ts: eccezioni contate oppure esclusione come catalogo.

### [minore] CONTRATTO

Le seguenti richieste sono fondate, non contrastano con nessuna decisione e vanno scritte nel contratto.

Log e test:
- livelloLogCoda(operazione, esito, tipo?) insieme a TIPI_BATTITO_GIRO, ESITO_TIPO_GIRO e LIVELLO_TIPO_GIRO (D3 r2, D6 r2): LIVELLO_LOG_CODA ha un livello per esito, ma il livello del battito dipende dal tipo (§15).
- Nessun tetto di tempo fatto con setTimeout o Promise.race sul percorso del giro (D3 r2b, D6 r1). [V] client.ts:519, emissione.ts:473; setTimerTickMode in vitest index.d.ts:301.
- Nel cardine la finta di notifiche consuma l'outbox con prendi e conferma veri (D6 r8).
- Il percorso del giro non usa embedding, .or() né .filter() (D6 r9).

HTTP ed E2E:
- CodiceRispostaCoda = CodiceErroreCoda | 'SEDE_NON_ACCESSIBILE' (D4 r1, D5 r1): oggi C§12 e C§13 si contraddicono.
- La GET della coda con voce= o pagamento= va oltre i 7 giorni, entro i 24 mesi (D4 r2, D5 r2), per i link degli scarti tardivi (decisione 20).
- Negli E2E si simulano anche /api/pagamenti/fattura/anteprima e /api/admin/settings/categorie (D5 r3, D6 r7). [V] FatturaButton.tsx:282, :415.

RPC:
- Codice giornale_non_aperto (D2 R7, D3 r6).
- Forma di p_codice_sdi (D2 R10d, D3 r8).
- sveglia nei ritorni, posizioni(NULL) e doppioni_aperti come id di voci (D2 R10b-c, D4 r3, r5).
- emessa gia_a_registro ammessa con invii tutti registrata (D2 R10e, D3 r5).
- Tipo AccessoAruba (D3 r4, D4 r6).
- Codici ottenibili solo per conversione (D2 R5).

Avvisi e sveglia:
- La sveglia parte anche al rilascio della sync (D2 R4, decisione 13).
- Una sola notifica anche per l'admin che ha accodato (D2 R11).
- fattura_scartata va a tutto lo staff se la segnalazione non è stata scritta (D3 r9).

Rilascio e R1:
- Rollback immediato del deploy se l'integrazione non applica la PR-A entro 5 minuti (D6 r4).
- «Autore sistema» = creato_da NULL (D1 r2).
- Prove P0-P7 contro rif (D1 r5).
- S28 con cinque condizioni (D1 r3). [V] sync/route.ts:111, :224.
- Uguaglianze nel lock specchio (D1 r4).

Proprietà dei file (§19):
- fattureDaRighe, la testata di fattura-viva.ts e annullo-riapre-movimento.test.ts vanno a D4 (D4 r4). [V] :259, :652-653; anche emissione.ts è un consumatore di quel lock, :268.
- emissione-supabase-finto.ts va a D3 (D3 r10).

Da armonizzare: la R8 di D2 e la r7 di D3 danno due semantiche diverse a chiudi(riprova, aruba_429).

**Correzione richiesta:** Scrivere nel contratto tutte le richieste elencate.

Per il circuito aperto da chiudi(…, 'aruba_429') scegliere la semantica di D2: si apre solo se è chiuso, con fino_a calcolato dall'istante del tentativo che ha preso il 429. La variante di D3, GREATEST(fino_a, adesso+60') a ogni chiusura, allunga il silenzio oltre i «60 minuti dall'ultimo tentativo» della decisione 16.

### [minore] CONTRATTO + D6

Ho ricontrollato più di 20 affermazioni aprendo i file, e sono confermate [V]:
- emissione.ts:331, 396, 1458, 2175, 2282-2303, 2443, 2480, 2555-2558, 2604, 883;
- fatturapa-xml.ts:548, 570, 582-587;
- sezionale.ts:584-603;
- controlli.ts:149, 351, 599-660, 836-855;
- client.ts:506, 519, 771, 946;
- FatturaButton.tsx:282, 415, 470-489;
- riconciliazione/route.ts:39, 880, 939, 981, 1009, 1021, 1379;
- redact.ts:250-256, logger.ts:188-190, config.ts:31-36;
- sync/route.ts:58, 97, 111, 224, 367, 381, 629, 877, 992;
- le tre guardie (:318, :408, :153), isolamento :887-900 e :1281, health.test.ts:140-147 e :623-660;
- tetto-orario-aruba.ts:44 e :51, LottoFatturePanel.tsx:363-376, baseline.sql:1508 e :3168-3172, la tabella notifiche senza CHECK su tipo.

Restano da correggere:
- F3 è falso: scadenze-documenti-personale ('47 5 * * *', HTTP) cade su un minuto del tick [V, cron.job del 23/09; R9 di D2].
- F7 è impreciso: anche schema-atteso esce giu (controlli.ts:504-525 [V]).
- .claude/commands/ship-cycle.md:348-352 [V] prescrive ancora apply_migration dopo il merge, contro la decisione 25, e nessun componente lo corregge.
- In D6 §10 il rimando «(richiesta 5)» punta alla richiesta sbagliata.

**Correzione richiesta:** - Correggere F3 e F7.
- Scrivere in C§0.3 e C§18 che il passo 4 di ship-cycle.md NON si esegue per PR-D1, PR-A e PR-B, e segnalare al titolare che il comando resta in contrasto con la decisione 25: decide lui se aggiornarlo.
- Correggere il rimando in D6 §10.

## Ultimo critico della scomposizione (CORREGGERE)

- [VERIFICATO] R2B-F1a viene committata con rossi che le CONVENZIONI non dichiarano. Rigenerare fk-utenti (R2B-1.4) fa diventare rosso tracce-docente-dichiarate.test.ts:100 («ogni FK verso utenti(id) è CENSITA») fino a R2B-1.9. Rigenerare migrazioni-applicate (R2B-1.1) fa diventare rossa la prova gemella di soglia-fotografia fino a R2B-1.7, come ammette la stessa descrizione di 1.7. Rigenerare tabelle-scuola-id può far diventare rosso isolamento-sede-coverage fino a 1.11. Il critico di F1a dice solo «Poi commit», contro la regola «ogni altro rosso a fine fase va riparato prima del commit». Correzione: aggiungere questi rossi ai «Rossi dichiarati» (da R2B-F1a a R2B-F1b), oppure fare un solo commit alla fine di R2B-F1b. Stessa incoerenza in R1: i rossi TDD 1.4 e 1.7-1.9 vengono committati in R1-F1a e R1-F1b ma mancano dall'elenco dei rossi dichiarati.

- [VERIFICATO] Un file resta senza proprietario. __tests__/lib/personale/tracce-docente.test.ts:113,120,130 fissa TRACCE_DOCENTE=56, VOCI_CHE_PESANO=44 e leggere=12. R2B-1.9 aggiunge 5 voci (2 pesano, 3 no), quindi il test diventa rosso: i valori giusti sono 61/46/15. Il file non compare in nessun design, non è fra i file_posseduti di R2B-1.9 e la verifica di 1.9 non lo esegue. Va aggiunto a R2B-1.9 sia nei file posseduti sia nella VT.

- [VERIFICATO] I conteggi N sono sbagliati perché il filtro di vitest confronta per sottostringa (node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js:10860-10870, `testFile.includes(f)`). `__tests__/lib/aruba` prende anche `__tests__/lib/aruba-lettura.test.ts`, creato da R1-1.5. R1-2.1 si aspetta 32 (30+2) e ne misurerà 33; R2A-2.5 si aspetta 34 (31+3) e ne misurerà 35. Con la regola «N esatto» l'esecutore si fermerebbe. Correzione: usare `__tests__/lib/aruba/` con la barra finale (vitest la tratta come cartella), oppure correggere N.

- [VERIFICATO+DEDOTTO] In R2A-F3 c'è una dipendenza fra compiti paralleli. errori-con-codice.test.ts:543-566 esige che ogni codice usato in src/ (inventario() e codiciUsati() scandiscono anche src/lib) sia dichiarato in CODICI_ERRORE e tradotto. R2A-3.11 (risposte-api.ts, «switch coi codici letterali») ha errori-con-codice nella propria verifica, ma i 15 codici della coda li dichiara R2A-3.13, che gira in parallelo: 3.11 non può essere verde da solo. Correzione: spostare la VT di errori-con-codice al critico di fine fase, oppure mettere 3.13 prima di 3.11. Collegato: R2A-6.9 introduce FATTURA_EMISSIONE_SOLO_IN_CODA senza possedere esito-fetch.ts né shared.json. Va dichiarato esplicitamente che quel codice è fra quelli di CHIAVI_MESSAGGIO_CODA (3.13) e va aggiunto errori-con-codice alla VT di 6.9.

- [VERIFICATO nel testo del piano] In R2A-F6b c'è una dipendenza fra compiti paralleli. R2A-6.10 dice «una chiave i18n mancante si segnala… la possiede R2A-6.15», e R2A-6.15, nella stessa fase, «aggiunge le chiavi segnalate da 6.10». In più, da R2A-F3 a R2A-F5 (componenti 3.19-3.21, 4.15-4.23, 5.10) nessun compito possiede adminContabilita.json: una chiave mancante lì non si può aggiungere dentro la fase. Correzione: una sotto-fase o un compito sequenziale «chiavi mancanti» all'inizio di ogni fase UI, oppure 6.10 dopo 6.15.

- [VERIFICATO] Le verifiche sono troppo strette sui componenti montati altrove. AdminSidebar, AdminMenuSheet e AdminBottomNav vengono montati SENZA CodaFattureContatoreProvider in quattro test: __tests__/a11y/contrasto-bordi-superfici-pubbliche.test.tsx:519,548,605; __tests__/a11y/contrasto-cascata.test.tsx:536,541; __tests__/components/sede-mobile-e-ricarica.test.tsx:53,175; __tests__/components/Modal-dialogo-modale.test.tsx:84,363. R2A-3.20 non richiede che useContatoreCoda, fuori dal provider, restituisca un valore neutro (disponibile:false) senza lanciare e senza fetch. R2A-5.10 possiede solo admin-bottom-nav e cambia-profilo. Casi analoghi: PaymentsDashboard è montato in __tests__/components/importi-euro-italiani.test.tsx:156, fuori da 6.12; StudentDetailPanel in __tests__/a11y/schede-alunno-a11y.test.tsx:269 e in legami-familiari-ui-cablaggio.test.tsx:181, fuori da 6.13; admin/layout è letto come testo da alto-contrasto-inchiostro-ereditato, guscio-chiaro-dichiara-la-superficie e skip-link-nel-catalogo, fuori da 3.20. Aggiungerli come «solo se rossi» e nella VT.

- [VERIFICATO nel testo] I modelli contraddicono la regola 9 delle CONVENZIONI («comandi capaci di scrivere in produzione → sonnet o opus»). R1-9.2, R2A-14.1, R2A-14.3, R2A-14.4, R2V-1.4 e R2V-2.4 sono assegnati a haiku ma usano `supabase db query --linked`, che esegue SQL arbitrario in produzione (e legge anche app_log, con il rischio PII). Vanno portati a sonnet.

- [VERIFICATO nel testo] Manca un caso di test. D2 chiede PARTITA_NON_REGISTRATA «in 4 casi, anche in rimetti», ma i casi di accoda sono stati spostati in R2A-4.4 e R2A-6.2 (staff) non elenca casi CR1 su fatture_coda_rimetti. Eppure R2A-6.1 implementa proprio il «predicato CR1 per le voci senza invii» in rimetti, e il lock 9.9 controlla solo che la funzione venga chiamata. Aggiungere a 6.2 i casi CR1 di rimetti, con una prova di rottura.

- [VERIFICATO nel testo] Il nome di una RPC non è coerente. R2A-6.1 scrive «segna_scarto_sdi», mentre D2 (file 2 e test staff) e D3 (scarti.ts: segnalaScartoSdi, «RPC letterale», R2A-4.10) usano fatture_coda_segnala_scarto_sdi. Va corretto in 6.1, perché il nome finisce in RPC_CODA, nei GRANT e nel lock specchio.

- [DEDOTTO] S35 e il lock 9.9 f sono in tensione. Lo strato Aruba (client.ts con esitoTentativoDi, confronto-documento.ts con esitoRicerca a 5 esiti, reinvio.ts) può importare da fatture-coda solo tipi, quindi deve scrivere i valori del contratto (ESITO_TENTATIVO, ESITO_RICERCA) come letterali. Il lock 9.9 f vieta i letterali duplicati e ha eccezioni solo per vocabolario-log, contratto-db e api-contratto. Il piano deve dichiarare quali file scandisce 9.9 f, oppure aggiungere eccezioni contate per src/lib/aruba/**; altrimenti il lock resta cieco o non può diventare verde.

- [DEDOTTO] R2A-4.5 (test ordine, fase F4) contiene «QUOTA_ORARIA in testa, senza scavalcare». Ma QUOTA_ORARIA è un rifiuto di aruba_cancello_prenota, che è nella parte B (R2A-5.1, fase F5), mentre il critico di F4 esige verdi 5 test SQL. Correzione: dichiarare che il caso usa solo funzioni della parte A (prossima/prendi), oppure spostarlo in R2A-5.2.

- [VERIFICATO] Le guardie Aruba degli script di R1 non hanno un finto fail-closed. test/setup.ts:82-113 blocca soltanto l'host Supabase di produzione, e aruba-finto nasce solo in R2A-1.2. I test di R1-1.5 (signin, 429, getByFilename in aruba-lettura.mjs) non hanno quindi un finto che lanci su chiamate impreviste verso gli host Aruba. Correzione: in R1-1.5 (e nei test CLI 2.3 e 2.4) richiedere vi.stubGlobal('fetch') con un finto che lanci su qualunque URL non previsto.

- [VERIFICATO] Il comando di prova di R2A-7.3, `rg "from '@/lib/pagamenti/lotto-fatture'"`, non vede l'import dinamico `await import('@/lib/pagamenti/lotto-fatture')` di __tests__/pagamenti/tetto-orario-aruba.test.ts:155: il risultato atteso (che lo nomina) non torna, e un uso residuo di TETTO_LOTTO sfuggirebbe. Usare `rg -n "lotto-fatture'" src __tests__ e2e`. Anche i «FATTI VERIFICATI» omettono questo importatore.

- [VERIFICATO] Il conteggio di R2A-11.3 («151 → 160») è ambiguo. Le 151 voci di __tests__/architecture comprendono soglia-fotografia.ts, che non è un test: i file di test sono 150 e con i 9 lock nuovi diventano 159. Va specificato se si contano voci o file .test.ts.

- [Minore] La verifica di R2A-10.1 va estesa. La rinomina cambia la chiave di MIGRAZIONI_ATTESE_AL_MERGE, che le guardie di rls-per-sede, onconflict-arbitro e tracce-docente-dichiarate leggono tramite posterioriDaRigenerare, ma la VT esegue solo 3 lock: va eseguito LOCK-MIGR completo (9).

- [Minore] L'arresto d'urgenza non è verificato in produzione. R2V si affida a `fatture_coda_sospendi(NULL,…)` eseguita dalla CLI, ma V3-V4 (R2A-14.2) controllano solo che le RPC siano eseguibili da service_role. Aggiungere in 14.2 `has_function_privilege(current_user, 'public.fatture_coda_sospendi(uuid,text)', 'EXECUTE')` col ruolo reale della CLI registrato in R1-0.2, prima di contarci come unica leva di STOP.

## Dopo C0 (critico: PASS) — rilievi minori da chiudere nella fase indicata

- [minore, da correggere prima di R2A-F5] Il circuito 429 non è arrivato nella scomposizione. scomposizione.md:1991 (R2A-5.1) e :2039 (R2A-5.4) calcolano ancora `fino_a` come «istante del tentativo di upload più recente con esito NULL o http_429 + 60'». Contratto C0.4 (riscritto in C0.5 n. 6), d2:467/:517 e il blocco C0 di d3:16 dicono invece che `chiudi(…,'aruba_429')` chiama `_fatture_coda_apri_circuito`, cioè GREATEST(COALESCE(fino_a, adesso), adesso+60') calcolato alla chiusura, ed è quell'helper che scrive l'evento `circuito_aperto` e gli avvisi `pausa_429`. La scomposizione contraddice anche la propria R2A-1.3 (:1105, «con la semantica di D2»). Chi esegue e chi scrive il test fisserebbero la variante che C0.5 n. 6 ha respinto [V]. Correzione: due righe in R2A-5.1 e R2A-5.4.
- [minore] Test 4 di D1 fermo alla forma vecchia. d1:957-972 ha 8 casi e non ha il caso nuovo di G1 («viva di un'altra quota, file assente ⇒ vero»). Il controllo negativo «length > 0 al posto di some(fatturaViva) ⇒ la seconda riga diventa rossa» non regge più: con la forma CASE la riga 2 passa dal ramo del file [V]. Non blocca: R1-1.3 (scomposizione:165-181) è corretta, con 9 casi e i negativi giusti, e il blocco C0 di D1 prevale.
- [minore] Testi interni rimasti indietro, coperti dal blocco C0 o dal Registro: d2:1225 (tabella dei file: «_partita_non_registrata (unione delle forme di D1 e D4)»); d2:1253 (una voce con un invio rifiutato non si toglie, contro il default D1); contratto §10.11 (:575), che mette ancora BAD_INPUT fra i guasti nostri con rientro senza l'eccezione di G2; d3:427, d4:101 e d4:275 (ORIGINE_INTESTATARIO, AZIONI_VERIFICA, MODI_CAUSALE); d6:484 e d6:512 («E1-E19», mentre il file ha anche E20 ed E21) [V].
- [minore] `giornale_non_aperto` come codice d'INVIO: il contratto §8.3 (:444) ha ancora 13 codici fissi senza di esso, e d2:98 (R7) dice di usare `xml_non_componibile`. La scomposizione (:1055, :1371, :2327) lo aggiunge invece a CODICI_ESITO_INVIO (14) e al CHECK. La scomposizione è coerente al suo interno, ma nel contratto la decisione non c'è [V].
- [minore] Lock specchio e `api-contratto.ts`: contratto C0.1 m6 (:26) lo dichiara escluso come catalogo, mentre scomposizione:2753 (R2A-9.9 f) e d2:1136 gli danno eccezioni contate per 'sospesa' e 'in_pausa'. Va scelta una regola sola [V].
- [minore] m2, test di rimetti: contratto (:22) e D4 (:537) indicano `__tests__/api/fattura-coda-azioni.test.ts`, la scomposizione R2A-5.16 (:2199) indica `fattura-coda-rimetti.test.ts`. Inoltre non elenca i due casi (proposta_bonifico uguale ⇒ confermata; diversa ⇒ proposta_da_confermare) e scrive ancora «origine_iniziale» accanto a sceltaSalvata [V].
- [minore] R1-F16 (scomposizione:959-961): l'obiettivo dice ancora «con le due domande aperte» e il critico controlla «che le domande siano chiare», mentre R1-16.2 (:982) e C0-18 dicono che non resta nessuna domanda aperta [V].
- Esito delle verifiche: i 12 rilievi del design (G1-G4, m1-m8) sono chiusi nel Registro C0 del contratto, nei blocchi C0 di D1-D6 e nella scomposizione (CR1-CR12). Ho controllato nel codice [V] FatturaButton.tsx:471-489 (con stato='scartata' il trigger è «Riprova fattura»; D5:236 forza fatturaStato='scartata'), ship-cycle.md:348-352 e la forma CASE in d1:604-621, d2:463 e R1-1.3. I 16 rilievi della scomposizione (C0-1…C0-16) sono chiusi; ho ricontrollato [V] vitest cli-api.BK8pd4xc.js:10860-10869 (filtro per sottostringa), tracce-docente.test.ts:114/120/130 (56/44/12), __tests__/architecture con 151 voci di cui 150 .test.ts, __tests__/lib/aruba con 28 file e 7 righe di `lotto-fatture'`. I 5 default sono applicati in modo coerente: D1 (S29 e §5.1:279, §9.4:520, azioni.togli, E20), D2 (S34, pulizia con evento `doppione_chiuso_pagamento_chiuso`), D3 (C0.5 n. 1: `_tentativo_chk` riscritto, `incerta→in_volo` solo con assente, E21, niente «Rimanda»), D4 (sospendi(NULL,…), riprendi solo dal titolare, C0-16 con has_function_privilege), D5 (nessun compito haiku usa --linked, --applica/--allinea o sospendi; i critici sono sonnet o opus). Nessun rilievo bloccante o grave resta aperto.
