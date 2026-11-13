# L'anno scolastico come struttura portante — specifica

> **Stato**: approvata dal titolare il 06/11/2026. Le misure del §1 sono di quel giorno e invecchiano:
> un conteggio si rifà, non si copia. Piano: `docs/superpowers/plans/2026-11-06-anno-scolastico.md` ·
> invarianti: `docs/superpowers/specs/2026-11-06-anno-scolastico-invarianti.sql`.

## 0. Contesto

Oggi l'anno scolastico non esiste come oggetto: lo ricava `annoScolasticoCorrente()` (soglia 1° agosto,
Roma) e i campi «di quest'anno» stanno senza anno su `alunni` e `sections`. Da gennaio a settembre
convivono due anni (in corso + iscrizioni), d'estate tre. La segreteria deve lavorare sull'anno
prossimo senza toccare un dato di quello in corso. Le 21 decisioni del titolare (06/11) si applicano.

### 0.1 Le 21 decisioni del titolare (06/11/2026), con la 18 già corretta

**Struttura dell'anno**
1. Le date predefinite sono le stesse per le tre sedi (1/9 → 31/8), e ogni sede può cambiarle. Ogni giorno
   appartiene a un solo anno: niente buchi, niente sovrapposizioni.
2. Il centro estivo di luglio e agosto appartiene all'anno che si chiude (la soglia del 1° agosto va rivista).
3. L'anno successivo si crea da solo, «in preparazione», con date e listino copiati.
4. Le iscrizioni le apre la segreteria a mano, sede per sede.
5. Si accettano iscrizioni per entrambi gli anni: nel modulo pubblico la famiglia sceglie l'anno, e gli
   ingressi a metà anno restano possibili.
6. I dati di prima del 1/8/2026 diventano il 2025/26, chiuso. Agosto 2026 è il caso di confine (risolto
   dalla risposta 7).

**Iscrizioni**
7. La conferma la registra la segreteria; il genitore non fa niente.
8. Listino per sede e per anno: quota di conferma e quota di nuova iscrizione separate, più retta e servizi.
9. «Iscritto» = moduli spuntati dalla segreteria + quota saldata.
10. I posti per fascia d'età avvisano, non bloccano.

**Passaggio d'anno e sezioni**
11. Le sezioni continuano con gli stessi bambini; la segreteria corregge le eccezioni.
12. Il bambino all'ultimo anno d'infanzia che va alla primaria Kidville è una conferma, con quota e retta
    della primaria.
13. Il passaggio lo fa la segreteria (anteprima, eccezioni, conferma, annullamento), mai un cron.
14. I docenti vedono l'anno nuovo solo dopo il passaggio.

**Visibilità, chiusura, conservazione**
15. Il genitore non vede l'anno prossimo (eccezione: la quota, risposta 3).
16. Chi lascia perde subito l'accesso a foto e chat di quella classe.
17. Una famiglia nuova vede foto e chat solo da quando è entrata.
18. *(corretta dalla risposta 2)* L'anno chiuso lo correggono **Direzione e segreteria**; ogni correzione
    registra chi, quando e perché. I docenti, dopo la chiusura, solo leggono.
19. Le domande non accolte e i dati sanitari degli anni chiusi si tengono finché la famiglia non ne chiede la
    cancellazione; la specifica cita una volta il principio di limitazione della conservazione. *(Per le
    domande non accolte resta il job dei 24 mesi: risposta 14.)*

**Interfaccia e numeri**
20. Il selettore dell'anno sta accanto a quello della sede, è persistente, e avvisa quando l'anno scelto
    non è quello in corso.
21. Il cruscotto dell'anno prossimo, per sede: iscritti per sezione e fascia accanto ai posti; confermati /
    no / non risposto; quote incassate e mancanti; moduli senza quota e viceversa; confronto con la stessa
    data dell'anno prima.

## 1. Fase 0 — misure (06/11/2026, produzione, solo `count`)

**Domande di iscrizione: 740** (contate oggi: `SELECT count(*) FROM enrollment_submissions`).

| sede | sezioni | alunni (non archiviati) | domande |
|---|---|---|---|
| Giugliano `d53b0fbc…` | 16 | 368 (360) | 353 |
| Cesa `04accbfd…` | 14 | 279 (274) | 248 |
| Aversa `429da920…` | 7 | 135 (131) | 136 |
| Demo `e2e…d000` | 4 | 25 | 3 |
| E2E `e2e…0001` (non operativa) | 3 | 4 | 0 |

- `alunni.stato`: solo `iscritto` (non archiviati) e `ritirato` (tutti archiviati: 17 nelle sedi vere).
- `enrollment_submissions`: **nessun anno di destinazione da nessuna parte** (chiavi di `data`: `adults`,
  `children`, 4 consensi; chiavi dei figli: anagrafica + sanitari). Arrivi: luglio 238 · agosto 272 ·
  settembre 207 · ottobre 17 · novembre 3; stati `approved` / `rejected` / 2 `pending`. Tutte per il 2026/27.
- **Il database comincia di fatto a luglio 2026.** Nelle tre sedi vere, prima del 1° settembre 2026:
  presenze 0 · diario 0 · galleria 0 · avvisi 0 · note 0; chat 3 (agosto) · valutazioni 3 (luglio 2, agosto 1) ·
  voci di pagamento 4 (una retta con competenza giugno 2026, tre voci di luglio) · incassi 18
  (8 in luglio, 10 in agosto: 8 di questi sono rette di settembre/ottobre pagate in anticipo) ·
  alunni creati 4 in luglio, 438 in agosto (l'import per il 2026/27) · protocolli 18 · movimenti bancari 9.
  Tutto il resto di luglio/agosto (diario 208, chat 47, note 60, presenze 73, valutazioni 20…) è delle sedi di prova.
- `pagamenti`: 2.165 voci con competenza (sett. 2026 → nov. 2026, più una di giugno 2026) e **1.269 senza
  competenza** (materiale, gite, mensa, pomeridiano, doposcuola, 2 quote d'iscrizione, 3 rette).
- `alunni_classi_storico` esiste già: **20.137 righe** `alunno × sezione × dal/al` dal 1° settembre 2026
  (fonti `presenza`, `attuale`, `trasferimento`): una storia delle classi per data, senza anno.
- `scrutinio_periodi`: **vuota** (nessun quadrimestre configurato). `certificati_competenze`: vuota.
- `utenti.ruolo`: genitore 883 · educator 82 · segreteria 8 · **admin 4 (3 attivi)** · cuoca 1 · coordinator 1.
- `app_log`: le chiamate di segreteria/admin per area esistono solo da ottobre — la stagionalità vera non è
  ancora misurabile (un anno di vita non c'è).
- Visibilità (RLS viva): genitore → figli da `current_parent_student_ids()` (`student_parents`, senza date né
  stato). Galleria per il genitore: **tutte le foto `is_broadcast` della sede** + quelle col figlio taggato,
  nessun limite di data o di classe. Chat: partecipante del thread (docente/genitore), nessun anno.

- **Censimento del calcolo al volo: 25 file di `src/` ricavano l'anno scolastico da una data (28 con gli
  indiretti), non ~45** — gli altri ~20 della stima ricavano l'anno *solare* (protocolli, ricevute, fatture,
  PO, digest), e quello è giusto così. Le regole indipendenti sono 10: tre a soglia **1° agosto** (helper +
  due copie), sette a soglia **1° settembre**.
- **Scritture che ricavano l'anno da oggi** (le più gravi):
  - `crm_bambini.anno_ingresso` salva un'etichetta **relativa** (`in_corso`/`prossimo`) che cambia
    significato da sola alla soglia;
  - la quota del CRM prende l'anno da `adesso`, non dal giorno del pagamento (`…/quota/route.ts:186`);
  - `StudentRegistryForm.tsx:116`: `data_iscrizione` = oggi (in UTC), e le rette partono da quel mese;
  - `GeneratoreCategoria.tsx:72`: chiave anti-doppione `slug-annoSolare`, che dà doppioni o salti
    dentro lo stesso anno scolastico;
  - la scheda sanitaria scade il 31/07 (`firma/route.ts:1423`);
  - i prestampati e i protocolli stampano l'anno corrente (`prefill.ts:337`, `genera-documento/route.ts:122`);
  - la serie fattura senza competenza ricade su oggi (`emissione.ts:1008`).
- **Il dettaglio delle soglie**: agosto in `anno-scolastico.ts:25`,
  `banco-famiglia.ts:1192`, `primaria/periodo.ts:80`, `crm/quota-anno.ts:21`; settembre in
  (`fatturazione/sezionale.ts:172,228`, `pagamenti/selezione-voci.ts:55`, `GeneratoreRette.tsx:48`,
  `ScrutinioPeriodiManager.tsx:17` con l'ora del browser, `storici/periodi.ts:7`, `crm/statistiche.ts:306`).
  Per spostare la soglia vanno toccati insieme l'helper, le due copie, il `-07-31` di `banco-famiglia.ts:1180`,
  i due `-08-01` (`compiti/page.tsx:185`, `LezioniCompitiSections.tsx:247`) e `MESE_RIPIEGO_AMBIGUO`
  (`sezionale.ts:158`).
- **L'anno è già ricalcolato in almeno 10 punti, con due soglie diverse**: agosto (`anno-scolastico.ts:25`,
  `banco-famiglia.ts:1192`, `primaria/periodo.ts:80`, `crm/quota-anno.ts:21`) e settembre
  (`fatturazione/sezionale.ts:172,228`, `pagamenti/selezione-voci.ts:55`, `GeneratoreRette.tsx:48`,
  `ScrutinioPeriodiManager.tsx:17` con l'ora del browser, `storici/periodi.ts:7`, `crm/statistiche.ts:306`).
- **Valori scritti apposta per un anno**: `iscrizione/import-massivo/route.ts:166` (`'2026-08-22'`…`'2026-09-10'`);
  mesi delle rette e dei servizi cablati 9..12 + 1..6 (`20260731115341…sql:296`, `20261007170813…sql:235`,
  `genera-rette/route.ts:56`).
- Le rette si generano **a mano** (nessun cron); i cron sono tutti `pg_cron` → route HTTP con battito
  `logEvento('cron','info',{esito:'ok'})` e registro `JOB_CRON` (`src/lib/health/controlli.ts:219`).
- Le scritture passano dal **client service-role**: la RLS è scavalcata per costruzione. «Difendere l'anno
  chiuso nel database» vuol dire quindi **trigger**, non policy.
- Nessun ruolo «titolare»: `utenti.ruolo` è testo libero (`admin | coordinator | educator | segreteria |
  genitore | cuoca`); «Direzione» = `admin`+`coordinator` (`predicati-ruolo.ts:131`).
- Selettore di sede: `SedeSelector` (`components/ui/cockpit.tsx:519`) in `AdminTopBar.tsx:100`, stato in
  `lib/context/sede-context.tsx` (cookie `sedi_attive`, `epocaSede`, `SedeRequired`): il selettore
  dell'anno lo imita.
- PRD: la decisione aperta sta a `PRD REGISTRO ELETTRONICO.md:100` («Anni scolastici e passaggio di classe:
  da decidere entro settembre 2027»).

- **Altri valori cablati**: titolo predefinito «a.s. 2026/27» delle votazioni (`lib/votazioni/tipi.ts:37`).
- **Visibilità — chi filtra davvero è l'applicazione** (route service-role + gate). Niente viste SQL. La RLS
  conta solo per tre accessi diretti dal browser (realtime chat, `ImportExportClient`, `syncEngine`).
  - **La «chat di classe» non esiste**: la chat è 1:1 `chat_threads(teacher_id, parent_id, student_id)`, e la
    lettura e l'invio non guardano né stato né classe (solo l'apertura del thread lo fa).
  - **Galleria**: il genitore vede **i broadcast di tutta la sede**, anche quelli mandati ad altre classi
    (`gallery/route.ts:542`); le notifiche invece vanno solo alle classi bersaglio. `target_classes` è per
    **nome**, e lo sono anche quelli di avvisi e menu mensa: i nomi si ripetono ogni anno.
  - **Avvisi e mensa** non usano il gate «figlio attivo»: il genitore di un ritirato vede ancora gli avvisi
    di classe e può prenotare la mensa.
  - **Nessuna data d'ingresso della famiglia** da nessuna parte (`student_parents` e `legame_genitori_alunni`
    senza date); `alunni_classi_storico.dal` è affidabile solo dal 15/10/2026.
  - 🔴 **Oggi una re-iscrizione accettata sposta subito il bambino** nella classe nuova
    (`admin/iscrizioni/route.ts:1772`, `import/esegui.ts:357`): dal giorno dopo docenti e famiglia vedono
    la classe dell'anno prossimo. Contraddice le decisioni 14 e 15 **già adesso**: finché il modello nuovo non
    c'è, le conferme per il 2027/28 non vanno importate da quella strada.

## 2. La matrice delle tabelle (163 tabelle `public`)

Classi: **A** anagrafica permanente · **B** per anno scolastico · **C** per anno solare · **D** evento con data ·
**E** configurazione versionata per anno. Fra parentesi le righe stimate dove contano.

### B — per anno scolastico (il cuore del lavoro)
| tabella | come prende l'anno | motivo |
|---|---|---|
| **`frequenze`** (nuova) | `anno_id` FK | bambino × anno → sezione, retta, servizi, tipo, moduli, quota, stato. Sostituisce i campi senza anno di `alunni` |
| `alunni` → campi per anno | spostati su `frequenze` | `section_id`, `classe_sezione`, `stato`, `importo_retta_mensile`, `retta_split_config`, `intestatario_fatture`, `retta_a_carico_di`, `data_iscrizione`, `giorno_scadenza_pagamenti`, `gruppo_mensa_id`, `sospeso*`, `numero_domanda_sidi`, `usa_pannolino` |
| `sections` (42) | `anno_id` FK + `continua_da` | una sezione per anno; la riga di oggi diventa la sezione 2026/27 |
| `utenti_sezioni` (97), `utenti_sezioni_materie` (111) | dalla sezione | l'assegnazione docente segue la sezione dell'anno |
| `alunni_classi_storico` (20.137) | dalla sezione | resta la storia *dentro* l'anno (trasferimenti fra sezioni) |
| `presenze` (30.807), `eventi_diario` (65.352), `valutazioni` (840), `note_disciplinari`, `giustifiche_didattiche`, `registro_orario` (1.455), `eventi_agenda`, `armadietto`, `armadietto_richieste`, `mensa_prenotazioni` (2.458), `mensa_alternative` | dalla **data** nel calendario della sede, controllata contro la sezione | eventi dentro un anno |
| `scrutini`, `scrutinio_giudizi`, `scrutinio_comportamento`, `scrutinio_giudizio_descrittivo`, `pagelle`, `pagella_ricezioni`, `nota_ricezioni`, `valutazione_obiettivi`, `certificati_competenze` (`anno_scolastico` testo → FK) | dal periodo/sezione | valutazione dell'anno |
| `galleria_media_v2` (10.540), `video_intents`, `video_jobs` | data + **sezione** (oggi la classe è un nome) | visibilità per classe e per periodo (dec. 16-17) |
| `avvisi` (274), `avvisi_risposte`, `forms_submissions` (autorizzazioni gita) | data + sezioni bersaglio (oggi nomi) | |
| `votazioni*` (4 tabelle) | `anno_id` | rappresentanti di classe e d'istituto sono per anno |
| `pagamenti` (3.434) | `anno_id` (+ `periodo_competenza` dentro l'anno) | la voce appartiene a un anno; la fattura no (C) |
| `pagamenti_quote`, `iscrizioni_servizi` (ha già `dal`/`al`) | dalla voce / dalle date | |
| `enrollment_submissions` (740) | `anno_id` **di destinazione**, non la data d'arrivo | le 510 arrivate prima di settembre sono per il 2026/27 |
| `iscrizioni_decisioni`, `iscrizioni_elenco_caricamenti`, `iscrizioni_elenco_righe`, `iscrizioni_import_esiti` | dalla domanda / dal caricamento | |
| `crm_bambini` (`anno_ingresso` relativo, `quota_anno` intero) | `anno_id` | l'etichetta relativa va tolta |

### E — configurazione versionata per anno
| tabella | motivo |
|---|---|
| **`listino`** (nuova) | quota di conferma, quota di nuova iscrizione, retta per tipo, servizi — per sede × anno (dec. 8). Oggi: `admin_settings.retta_default_importo` + `rette_config` + `payment_categories.importo_mensile_default` |
| **`moduli_richiesti`** (nuova) | quali moduli servono, per sede × anno (domanda aperta) |
| **`posti_autorizzati`** (nuova) | posti per fascia d'età per sede × anno (dec. 10, 21). Le capienze vere sono solo in parte note: nido 38 (+50 spazio bambini) Giugliano, 30 Aversa, 30 Cesa; primavera 17/16; infanzia solo «N sezioni» |
| `scrutinio_periodi` (0 righe) | `anno_scolastico` testo → FK |
| `materie`, `sezione_materia_obiettivo`, `orario_settimanale`, `campanelle`, `tempo_scuola`, `locker_config` | appesi alla sezione: si versionano con lei (copiati al passaggio) |
| `obiettivi_apprendimento`, `giudizi_sintetici_scala`, `giudizio_template` | per sede; da versionare solo se cambiano (proposta: no) |
| `mensa_class_menu_assignment` (per nome + `attivo_dal`), `gruppi_mensa` | per sezione dell'anno |
| `admin_settings` | i campi economici passano al listino; il resto resta per sede |

### C — anno solare (resta così, e il perché)
`fatture_emesse`, `fatture_numerazione`, `fatture_numerazione_sezionale`, `fatture_coda`, `fatture_coda_stato`,
`fatture_visibilita_*`, `ricevute_emesse`, `ricevute_numerazione` (numerazione fiscale per anno solare);
`protocolli`, `protocolli_allegati`, `protocolli_numerazione` (registro rinnovato ogni anno solare);
`incassi`, `cassa_movimenti`, `cassa_chiusure`, `riconciliazione_import`, `riconciliazione_movimenti`,
`pagamenti_transazioni` (cassa: l'attestazione 730 conta gli incassi per anno solare);
`merch_po_numerazione`, `merch_ordini_fornitore`, `merch_rettifiche`, `news_digest_edizioni` (mese solare).
L'incasso resta solare ma punta a una voce che ha il suo anno: la quota 2027/28 incassata a febbraio 2027 è
un incasso del 2027 su una voce del 2027/28.

### D — evento con data, nessun anno proprio
`app_log`, `notifiche`, `registro_modifiche`, `audit_scritture_docente`, `fascicolo_accessi_audit`,
`fea_audit_log`, `fea_signatures`, `firme_docenti`, `firme_documenti`, `chat_vigilanza_accessi`, `cron_*` (3),
`otp_ticket_consumati`, `news_visualizzazioni`, `news_posts`, `solleciti`, `sblocchi_audit`, `storici_*` (3),
`video_outbox`, `gallery_photo_uploads` (la chiave anti-doppione delle foto: sopravvive alla foto purgata e viene scritta prima di lei, quindi non ha una madre né un anno proprio; l'anno sta su `galleria_media_v2`; uscita dal registro il 07/11/2026), `segnalazioni`, `richieste_cancellazione`, `task_interni`, `crm_appuntamenti`, `crm_azioni`,
`crm_eventi`, `crm_indisponibilita`, `crm_settimane`, `crm_fasce`, `iscrizioni_retention_esecuzioni`,
`iscrizioni_import_tentativi`, `iscrizioni_inviti_credenziali`, `password_cambi`, `consensi_accettazioni`,
`mensa_ticket_movimenti`, `certificati_medici` (ha già `data_inizio`/`data_fine`), `divise_ordini`,
`divise_ordini_righe`, `conversazioni_sospensioni`, `tetto_frequenza`, `allegati_registro`, `registro_destinatari`.

### A — anagrafica permanente
`alunni` (la parte anagrafica e sanitaria), `parents`, `utenti`, `utenti_scuole`, `student_parents`,
`legame_genitori_alunni`, `student_guardians`, `delegates`, `anagrafica_personale`, `pratiche_personale`,
`caricamenti_personale`, `candidature_insegnanti`, `candidature_sedi`, `crm_schede`, `schools`, `scuole`
(gemella legacy), `push_subscriptions`. Cataloghi senza anno: `payment_categories` (gli importi vanno al
listino), `cassa_categorie`, `protocolli_categorie`, `news_categorie`, `news_media`, `divise_articoli`,
`merch_fornitori`, `form_models`, `forms_templates`, `materie_preset`, `certificato_competenza_livelli`,
`galleria_media` (v1, non usata), `mensa_menu_config`, `mensa_menu_rotazione`, `mensa_menu_override`.

### Righe incerte → risolte dal titolare il 06/11 (vedi §3)
| riga | classe | risposta |
|---|---|---|
| `chat_threads`, `chat_messages` | B (dal bambino) | il thread resta; con un docente che non è più del bambino diventa **sola lettura**; chi lascia la scuola lo perde |
| `ticket_mensa`, `crediti_famiglia` | A | il credito è della famiglia: passa all'anno dopo |
| `student_documents` | B per i documenti annuali (certificati di iscrizione e frequenza, bonus nido); **A per i sanitari**, che valgono fino a revoca | |
| `form_submissions` (moduli firmati) | B: scadono con l'anno, **tranne i sanitari** (farmaci, dieta, scheda) che valgono fino a revoca | |
| `sidi_sync_state`, `sidi_import_batches` | D — **resta com'è** (proposta per anno non approvata) | |
| 1.269 voci senza competenza | B: anno della **scadenza** | |
| broadcast della galleria | B: li vedono **solo le famiglie delle classi destinatarie**, per il periodo in cui il bambino ci stava (oggi è un difetto) | |

## 3. Risposte alle domande aperte (titolare, 06/11/2026)

| # | domanda | risposta | cosa cambia |
|---|---|---|---|
| 1 | Chi chiude l'anno, e quando | Da solo, a una data fissa che la sede cambia nelle sue impostazioni. Predefinita: **31/07** dell'anno di fine | un job notturno, non un bottone |
| 2 | Chi corregge un anno chiuso | **Direzione (`admin`, `coordinator`) e segreteria**. Dopo la chiusura i docenti possono solo leggere | **la decisione 18 cambia**: non corregge solo la Direzione |
| 3 | Cosa vede il genitore dell'anno prossimo | Solo la voce «Iscrizione 2027/28»: importo, scadenza, causale | unica eccezione alla decisione 15 |
| 4 | Quali moduli servono | Per sede e per anno, in due liste (conferma, nuova iscrizione), copiate dall'anno prima | tabella `moduli_richiesti` |
| 5 | Due figli, ne lascia uno | Si perde solo ciò che passa dal figlio che lascia | la visibilità si calcola figlio per figlio |
| 6 | Quando nasce l'anno successivo | In una data scelta dalla sede | `prepara_successivo_dal`; predefinita = primo giorno dell'anno in corso (**scelta mia**) |
| 7 | Luglio e agosto 2026 | Per natura, senza eccezioni (regole in §4.13) | |
| 8 | Foto mandate «a tutta la sede» | Le vedono solo le famiglie delle classi destinatarie, o del bambino taggato, e solo per il periodo in cui il bambino era in quella classe | oggi è un difetto: si chiude nella PR 4.4 |
| 9 | La chat dopo il passaggio | Con un docente che non è più del bambino resta **in sola lettura** | |
| 10 | I moduli firmati in app | Scadono con l'anno e si rifirmano dal passaggio; la segreteria vede chi manca; i vecchi restano consultabili. **I moduli sanitari (scheda sanitaria, farmaci, dieta) valgono fino a revoca** | la scheda sanitaria smette di scadere il 31/07 (`firma/route.ts:1423`) |
| 11 | Credito mensa, crediti della famiglia, documenti | Credito mensa e crediti restano (classe A). I documenti legati a un anno (certificati, bonus nido) prendono l'anno, tranne i sanitari. **SIDI resta com'è** | |
| 12 | Come costruirlo | «Il più sicuro a lungo termine, non mi interessa se c'è più lavoro ora» | approccio 1 (§4.3) |
| 13 | Al passaggio, chi non ha né confermato né detto «no» | **Esce**: perde l'accesso dal passaggio, e rientra con una conferma tardiva | §4.9 |
| 14 | Il job che cancella dopo 24 mesi le domande non accolte | **Restano i 24 mesi**: la decisione 19 vale per i dati sanitari degli anni chiusi | §4.15; il job non si tocca |
| 15 | Dove si simula l'anno intero | **In Demo**, che resta spostata in avanti; alla fine le DELETE per riportarla a oggi le esegue il titolare | §4.17 |

## 4. Specifica

### 4.1 Perché, e cosa vuol dire riuscire

Oggi l'anno scolastico non esiste come oggetto. Lo ricavano **10 regole sparse con due soglie diverse**
(1° agosto e 1° settembre), e i campi «di quest'anno» (classe, stato, retta, fratello che paga) stanno su
`alunni` e `sections` senza anno. Da gennaio ad agosto convivono due anni, e d'estate tre. La segreteria
deve lavorare sul 2027/28 senza toccare un dato del 2026/27. Il modello di oggi non lo permette: una
conferma accettata sposta subito il bambino nella classe nuova (`admin/iscrizioni/route.ts:1772`,
`import/esegui.ts:357`).

Si è riusciti quando:
- a gennaio 2027 ogni sede apre le iscrizioni al 2027/28 con il suo listino e i suoi moduli, e nessun
  dato del 2026/27 si muove;
- da gennaio ad agosto il cruscotto dice, sezione per sezione, quanti sono gli iscritti, chi ha
  confermato e quanto manca;
- a fine agosto 2027 il passaggio è un'operazione con anteprima, eccezioni, conferma e annullamento:
  dopo, docenti e famiglie vedono il nuovo anno, e non lo vedono prima;
- il 1° agosto 2027 il 2026/27 diventa di sola lettura per i docenti, senza che nessuno debba farlo;
- ogni riga del database sa a quale anno appartiene, e il database rifiuta una riga sbagliata.

### 4.2 Obiettivi, non obiettivi, anti-obiettivi

**Obiettivi**: le 21 decisioni (con la 18 corretta) e le 12 risposte del §3.

**Non obiettivi**:
- SIDI;
- fatture, ricevute, protocolli, numerazioni e cassa, che restano sull'anno solare (§4.14);
- un versionamento a parte di orario e campanelle: seguono la sezione, che ha già il suo anno;
- il livello «organizzazione» per il noleggio;
- migrare il DB E2E della CI, a cui mancano tabelle (cassa): la migrazione lo aggira (§4.4.5).

**Anti-obiettivi** (se succede uno di questi è un fallimento, anche con tutti i test verdi):
- l'anno scritto come testo `'2026/2027'` al posto di una FK;
- valori scritti apposta per il 2027/28 (date, importi, mesi, titoli);
- il passaggio fatto da un cron;
- una scrittura che ricava l'anno dalla data di oggi;
- un'iscrizione bloccata perché i posti sono finiti;
- un bambino iscritto al 2027/28 che compare nella classe nuova prima del passaggio;
- un genitore che vede la classe di un figlio che ha lasciato la scuola;
- una riga di un anno chiuso modificata senza sapere chi, quando e perché;
- l'uuid di una sede scritto in una migrazione.

### 4.3 Approcci

| | come | pro | contro |
|---|---|---|---|
| **1 — scelto dal titolare** | `anno_id` FK `NOT NULL` su ogni tabella di classe B (~35), calcolato e verificato da trigger | l'anno di una riga non cambia in silenzio; ogni filtro è un'uguaglianza (niente bug UTC/Roma); se una sede sposta le date e lascia righe fuori, lo spostamento viene rifiutato; il lock può leggere dallo schema quali tabelle devono avere l'anno | ~200.000 righe da riempire, ~35 trigger, e ogni nuova tabella di classe B deve nascere con l'anno |
| 2 | nessuna colonna sugli eventi: l'anno si ricava al volo da data e calendario della sede | poche migrazioni | ogni lettura diventa un intervallo di date, e il bug Roma/UTC si ripete in ogni query; se la sede sposta una data, le righe cambiano anno senza che nessuno se ne accorga; un lock non ha niente da verificare |
| 3 | l'anno solo su `frequenze` e `sections`; gli eventi lo prendono dalla sezione | meno colonne | pagamenti, chat, foto mandate a tutti e avvisi di sede non hanno una sezione; `section_id` diventa NULL quando la sezione si cancella (FK `SET NULL`), e l'anno sparirebbe con lei |

### 4.4 Il modello dei dati

#### 4.4.1 L'anno e il calendario di ogni sede

**`anni_scolastici`** — tabella globale, una riga per anno:
- `anno_inizio smallint UNIQUE CHECK (anno_inizio BETWEEN 2000 AND 2100)`;
- colonne generate: `etichetta` (`'2026/2027'`, la forma di `annoScolasticoCorrente()` e dei campi testo di
  oggi), `etichetta_breve` (`'2026/27'`), `inizio_predefinito` (1/9) e `fine_predefinita` (31/8
  dell'anno dopo).

Nessuna data scritta a mano.

**`anni_sede`** — una riga per sede e per anno:
- `scuola_id → schools`, `anno_id → anni_scolastici`, `UNIQUE (scuola_id, anno_id)`;
- `inizio`, `fine`, `periodo daterange GENERATED ('[]')`;
- `EXCLUDE USING gist (scuola_id WITH =, periodo WITH &&)` (btree_gist 1.7 è già installato);
- **continuità**: un trigger di vincolo `DEFERRABLE INITIALLY DEFERRED` verifica che in ogni sede ogni
  anno cominci il giorno dopo la `fine` del precedente. Lo spostamento di un confine passa da una RPC
  sola (`sposta_confine_anno`), che sposta insieme la fine di un anno e l'inizio del successivo. Lo
  spostamento viene **rifiutato** se lascia fuori dal periodo righe già assegnate, e il messaggio dice
  quante per tabella;
- `stato`, con un solo `corrente` per sede (indice unico parziale);
- `ultimo_giorno_aperto` (predefinito 31/07 dell'anno di fine), `prepara_successivo_dal` (predefinito =
  `inizio`), `domande_aperte boolean` (se il modulo pubblico accetta domande per quest'anno);
- `creato_da` (NULL = creato dal job);
- storia degli stati in `anni_sede_stati (anno_sede_id, stato, dal, da)`: serve alle invarianti.
- **Una sede nuova riceve subito i suoi anni**: un trigger `AFTER INSERT` su `schools` le crea gli anni che
  esistono già, con le date predefinite (chiusi quelli passati, `corrente` quello che contiene oggi,
  `in_preparazione` quelli dopo). Serve al seed della CI, che crea le sedi dopo le migrazioni. Senza, ogni
  scrittura lì finirebbe in `GIORNO_SENZA_ANNO`. Demo ed E2E sono sedi come le altre: hanno anni, sezioni e
  frequenze (**scelta mia**).

| stato | ci si entra | docenti | genitori | Direzione e segreteria |
|---|---|---|---|---|
| `in_preparazione` | il job, dal `prepara_successivo_dal` dell'anno corrente | non lo vedono | non lo vedono | preparano listino, moduli, posti e sezioni |
| `iscrizioni_aperte` | la segreteria, a mano, sede per sede. Servono le due quote nel listino e almeno un modulo per lista | non lo vedono | vedono solo la quota del proprio figlio | conferme, nuove iscrizioni, rette in anticipo |
| `corrente` | **il passaggio** | vedono le loro sezioni | vedono | tutto |
| `in_chiusura` | il job, dal giorno dopo `ultimo_giorno_aperto` | **sola lettura** | come prima | scrivono senza dare un motivo (agosto, centro estivo) |
| `chiuso` | il job, dal giorno dopo `fine` | sola lettura | come prima | scrivono **solo** registrando una correzione |

**Anno attivo** di una sede: fra gli anni già passati (`corrente`, `in_chiusura`, `chiuso`), quello con
l'`inizio` più recente. È l'anno che vedono docenti e famiglie. In agosto è ancora quello vecchio; dopo il
passaggio è il nuovo.

Il passaggio si conferma dal giorno dopo l'`ultimo_giorno_aperto` del vecchio anno fino all'`inizio` del
nuovo. Prima di allora non si può, perché avremmo due anni correnti. Se il nuovo anno comincia e il
passaggio non è stato fatto, le scritture datate nel nuovo anno vengono rifiutate con
`409 PASSAGGIO_DA_FARE`. Il cruscotto lo segnala dal 1° agosto, e `/api/health` dà `degradato` da 7 giorni
prima dell'`inizio`, e il giro orario di `anni_tick` scrive, per ogni sede, una riga di log di livello `error` (la stessa impronta: le occorrenze crescono) col solo numero di giorni all'inizio (**scelta mia**: fermarsi è
meglio che archiviare in silenzio nell'anno sbagliato; la salute non scende a `giu` perché i controlli nuovi non lo fanno mai, lock
`salute-controlli-nuovi-mai-giu`: il `503` resta di `db-lettura`, `auth` e `schema-atteso`).

#### 4.4.2 Le sezioni

- Colonne nuove su `sections`:
  - `anno_id NOT NULL`;
  - `continua_da → sections`: la sezione dell'anno prima di cui questa è la continuazione;
  - `fascia`: `nido_1`, `nido_2`, `primavera`, `infanzia`, `primaria`, `spazio_bambini`; NULL ammesso.

  La fascia serve perché `school_type` oggi dice solo `nido | infanzia | primaria` (verificato), mentre
  listino e posti la richiedono: il nido del 1° anno costa 330 €, quello del 2° anno e la primavera
  300 €. **Scelta mia.**
- Il nome è unico per `(scuola_id, anno_id)`, nella forma normalizzata.
- Le sezioni dell'anno prossimo nascono quando si aprono le iscrizioni, copiate da quelle correnti con
  `continua_da`. La segreteria le rinomina, ne aggiunge, ne toglie. Nessun docente le vede prima del
  passaggio (dec. 14).
- Queste tabelle prendono l'anno attraverso la sezione, e all'anteprima del passaggio si copiano nella
  sezione di continuazione: `utenti_sezioni`, `utenti_sezioni_materie`, `materie`,
  `sezione_materia_obiettivo`, `orario_settimanale`, `campanelle`, `tempo_scuola`, `locker_config`.
- `propaga_rinomina_sezione` propaga solo alle righe dello stesso anno.

#### 4.4.3 Le frequenze

**`frequenze`** — un bambino, in un anno, in una sede. Prende il posto dei campi senza anno di `alunni`.

Collegamenti:
- `alunno_id`;
- `anno_sede_id`, più `anno_id`, una copia tenuta coerente che serve all'indice;
- `section_id`, dello stesso anno (verificato), NULL finché la segreteria non la assegna;
- `continua_da → frequenze`, `domanda_id → enrollment_submissions`,
  `quota_pagamento_id → pagamenti ON DELETE SET NULL`.

Tipo e stato:
- `tipo`: `conferma | nuova`; NULL solo quando `origine = 'recupero'`;
- `stato`: `in_attesa | iscritto | ritirato | trasferito | uscito`;
- `moduli_completi`, `quota_saldata`: le scrive un trigger, mai l'app;
- `origine`: `domanda | conferma | segreteria | import | passaggio | recupero`.

Date:
- `data_ingresso NOT NULL` e `data_uscita`, entrambe dentro il periodo dell'anno;
- `non_rinnova_il` e `non_rinnova_motivo` (un codice preso da un elenco chiuso, niente testo libero): è il
  «no» del cruscotto.

Soldi:
- `retta_mensile` NULL = dal listino, con `CHECK (retta_mensile > 0)`: **lo zero non esiste**, e così
  finisce la trappola `NULLIF(…, 0) → 150`;
- `retta_esente boolean` per chi non paga.

Dalla scheda dell'alunno passano alla frequenza `retta_a_carico_di`, `retta_split_config`,
`intestatario_fatture`, `giorno_scadenza_pagamenti`, `gruppo_mensa_id`, `sospeso*` e `usa_pannolino`. Il
legame «la retta la paga il fratello» prende finalmente un anno.

Vincoli e regole:
- `UNIQUE (alunno_id, anno_sede_id)`, più un indice unico parziale su `(alunno_id, anno_id)` per gli
  stati `in_attesa` e `iscritto`: una sola frequenza viva per anno, anche fra sedi diverse.
- **Regola dell'iscritto** (dec. 9): `CHECK (stato <> 'iscritto' OR (moduli_completi AND quota_saldata)
  OR origine = 'recupero')`. Il trigger porta la frequenza da `in_attesa` a `iscritto` e viceversa quando
  cambiano i moduli o la voce della quota. `ritirato`, `trasferito` e `uscito` si scrivono a mano o li
  scrive il passaggio.
- **`frequenze_moduli`** `(frequenza_id, modulo_id, spuntato_da, spuntato_il)`, unica per coppia, senza
  note libere. Se il modulo corrisponde a un prestampato firmato in app, la lista lo mostra («firmato in
  app il …»), ma la spunta resta della segreteria (dec. 9; **scelta mia**).

**Frequenza attiva**, la definizione su cui si regge la visibilità: sta nell'anno attivo della sede, è
`in_attesa` o `iscritto`, e oggi cade fra `data_ingresso` e `data_uscita`.

#### 4.4.4 La configurazione di ogni anno (classe E)

- **`listino_voci`** `(anno_sede_id, voce, fascia, payment_category_id, importo, mesi smallint[])`, con
  `voce` = `quota_conferma | quota_nuova | retta | servizio`:
  - `importo` NULL è ammesso solo `in_preparazione`; per aprire le iscrizioni servono le due quote;
  - `mesi` prende il posto dei mesi cablati 9..12 + 1..6 (`20260731115341…sql:296`,
    `20261007170813…sql:235`, `genera-rette/route.ts:56`);
  - sconto fratelli, pro-rata e giorni di scadenza e di visibilità restano per sede in `admin_settings`:
    sono regole, non prezzi (**scelta mia**).
- **`moduli_richiesti`** `(anno_sede_id, lista conferma|nuova, codice, titolo, ordine)`.
- **`posti_autorizzati`** `(anno_sede_id, fascia, posti, fonte)`. `fonte` è il riferimento
  dell'autorizzazione, non un dato personale. I posti servono solo come avviso (dec. 10).
- Quando nasce, l'anno successivo copia listino, moduli e posti dell'anno corrente (dec. 3); poi la
  segreteria corregge.
- Il catalogo dei moduli firmabili in app riceve un campo `durata` = `anno | fino_a_revoca` (PR 4.4, non PR 1). Scheda
  sanitaria, farmaci e dieta nascono `fino_a_revoca` (risposta 10).

#### 4.4.5 L'anno sulle tabelle di classe B

Ogni tabella B riceve:
- `anno_id uuid NOT NULL REFERENCES anni_scolastici`;
- dove la riga ha `scuola_id`, anche la FK composta `(scuola_id, anno_id) → anni_sede`.

Il registro **`anno_tabelle (tabella, modo, colonna_data, via_sede)`** elenca le tabelle B e dice come
ciascuna trova l'anno. Lo leggono i trigger, le invarianti, il controllo notturno e il lock.

| modo | da dove viene l'anno | tabelle |
|---|---|---|
| `data` | dalla data dell'evento, presa come giorno civile di Roma, nel calendario della sede | `presenze.data`, `eventi_diario.giorno_competenza`, `valutazioni.data_evento`, `note_disciplinari.data_evento`, `registro_orario.data`, `giustifiche_didattiche`, `eventi_agenda`, `armadietto*`, `mensa_prenotazioni.data`, `mensa_alternative`, `galleria_media_v2.giorno_competenza`, `video_*`, `avvisi.giorno_competenza`, `avvisi_risposte`, `forms_submissions`, `form_submissions` (dalla firma), `chat_messages.created_at`, `student_documents` (quelli annuali), `iscrizioni_servizi.dal` |
| `dichiarato` | lo dice chi scrive (`resolveAnnoScrittura`, §4.5) | `frequenze`, `sections`, `enrollment_submissions` (anno di **destinazione**), `pagamenti` (con verifica della competenza), `crm_bambini`, `votazioni`, il listino, i moduli e i posti, `scrutinio_periodi`, `certificati_competenze`, `iscrizioni_decisioni`, `iscrizioni_elenco_caricamenti` |
| `madre` | dalla riga a cui appartiene | `utenti_sezioni` (dalla sezione), `pagamenti_quote` (dalla voce), `scrutini*` e `pagelle` (dal periodo), `votazioni_*`, `iscrizioni_elenco_righe`, `frequenze_moduli` |

`chat_threads` resta senza anno: un thread attraversa gli anni (risposta 9). I messaggi, invece, ce
l'hanno.

**Il trigger `anno_assegna_e_verifica`** scatta `BEFORE INSERT OR UPDATE OR DELETE`. È una funzione
generica, che riceve il proprio modo dal registro:
1. modo `data`: trova sede e data, calcola `anno_di(sede, giorno)` e scrive `anno_id` se manca. Se
   l'`anno_id` arriva già scritto ed è diverso, si ferma con `ANNO_NON_COERENTE`;
2. modo `dichiarato`: `anno_id` è obbligatorio. Per `pagamenti` con competenza,
   `anno_di(sede, periodo_competenza)` deve coincidere;
3. se la riga ha `section_id`, la sezione deve essere dello stesso anno, altrimenti
   `SEZIONE_DI_ALTRO_ANNO`;
4. guardia dell'anno chiuso (§4.4.6).

`anno_di(scuola_id, giorno)` è `STABLE`. Se nessun anno contiene quel giorno, si ferma con
`GIORNO_SENZA_ANNO`: non deve mai succedere, perché il job crea l'anno successivo in anticipo e la
continuità esclude i buchi. I timestamp si convertono con un helper solo, `giorno_roma(timestamptz)`.

Vincoli d'ambiente per la migrazione:
- il DB E2E della CI non ha tutte le tabelle (manca la cassa): la colonna si aggiunge solo alle tabelle
  del registro che esistono (`to_regclass`). L'invariante «tabelle del registro senza colonna o senza
  trigger» lo dice in produzione;
- la migrazione non legge `schools.operativa`, che nel DB della CI manca;
- nessun uuid di sede.

#### 4.4.6 L'anno chiuso e le correzioni

Con il client service-role il database non sa chi è l'utente: la scatola nera registra solo
`service_role` e il percorso (`20261019215733…sql:114-127`). Per questo la guardia funziona a **gettone**:

- la tabella **`correzioni_anno_chiuso`** registra `id`, `utente_id`, `ruolo`, `anno_sede_id`,
  `codice` (`agosto | correzione | oblio`), `motivo` (testo, obbligatorio con `correzione`, **mai nei
  log**), `creata_il`, `scade_il` (+10 minuti), e poi `usata_il`, `transazione`, `tabella` e `riga_id`
  per ogni uso;
- una scrittura su una riga di un anno `in_chiusura` o `chiuso`, oppure una riga che passerebbe in uno di
  quegli anni, passa **solo** se la richiesta porta l'header `x-kidville-correzione: <id>` di un gettone
  valido per quell'anno. Il trigger lo legge da `current_setting('request.headers')`, che PostgREST
  riempie a ogni richiesta, e registra l'uso;
- il gettone lo crea soltanto `resolveAnnoScrittura`, e soltanto per Direzione e segreteria: con codice
  `agosto` per un anno `in_chiusura`, con codice `correzione` e un motivo per un anno `chiuso`. Un
  docente non lo ottiene mai;
- passano **senza gettone**:
  - le colonne d'incasso di `pagamenti` (`stato`, `importo_pagato`, `data_incasso`, `fattura_*`,
    `ultimo_sollecito_il`, `aggiornato_il`). Incassare una retta arretrata è cassa, non una correzione
    (**scelta mia**);
  - le funzioni di oblio e di conservazione (`anonimizzaAlunno`, i job di retention), che accendono un
    interruttore nuovo, `anno_chiuso.oblio`, nella propria transazione e registrano un gettone `oblio`.
    **L'interruttore va aggiunto all'elenco di `supabase_sql_freno.py`**, nella stessa categoria degli
    interruttori della scatola nera.

### 4.5 La regola di scrittura: `resolveAnnoScrittura`

È il gemello di `resolveScuolaScrittura` (`src/lib/auth/scope.ts:314`) e sta nello stesso file. La
firma è `resolveAnnoScrittura(request, supabase, user, scuolaId, { dichiarato?, correzione? })`.

Restituisce `{ annoSedeId, annoId, stato, gettone? }` oppure una risposta d'errore.

Ordine di risoluzione:
1. `anno_id` dichiarato nel corpo o nella query, validato da zod;
2. il cookie `anno_attivo`;
3. l'unico anno non chiuso della sede, se ce n'è uno solo (dal 1/9 di solito ce ne sono due).

Se nessuna delle tre basta, risponde **`400 ANNO_DA_SPECIFICARE`** e scrive un `warn`
`anno-scrittura-ambigua`. Non legge mai la data di oggi per scegliere.

Controlli:

| caso | risposta |
|---|---|
| l'anno dichiarato non esiste in quella sede | `400 ANNO_NON_DELLA_SEDE` (`warn`) |
| anno `in_preparazione` o `iscrizioni_aperte`, e chi scrive è un docente | `403 ANNO_NON_VISIBILE` |
| anno `in_chiusura` | docenti `409 ANNO_CHIUSO`; Direzione e segreteria ricevono un gettone `agosto` |
| anno `chiuso` | `409 ANNO_CHIUSO`, a meno che Direzione o segreteria passino `correzione: { motivo }`: allora ricevono un gettone `correzione` |

Le tabelle in modo `data` non chiedono l'anno a chi scrive, perché lo calcola il database. Le loro route
usano `annoDellaData(scuolaId, giorno)`, che applica le stesse regole sullo stato e si procura il gettone
per Direzione e segreteria. I codici dei trigger diventano risposte HTTP in un posto solo
(`erroreAnno()`):

| codice del trigger | risposta HTTP |
|---|---|
| `ANNO_CHIUSO` | 409 |
| `PASSAGGIO_DA_FARE` | 409 |
| `SEZIONE_DI_ALTRO_ANNO` | 422 |
| `ANNO_NON_COERENTE` | 422 |
| `GIORNO_SENZA_ANNO` | 500, con log `error` |

### 4.6 Creazione e chiusura automatiche: il job `anni_tick`

È una funzione SQL lanciata da `pg_cron` **ogni ora**, al minuto 10. È idempotente e decide sul giorno di
Roma (`giorno_roma(now())`), così il cambio dell'ora legale non le fa né saltare né ripetere un giorno
(**scelta mia**: un orario fisso in UTC cadrebbe una volta alle 23 e una volta all'una).

Ogni sede si lavora in un blocco proprio: un errore su una sede non ferma le altre.
1. **Crea l'anno successivo** quando oggi ≥ `prepara_successivo_dal` dell'ultimo anno e il successivo non
   c'è ancora:
   - `anni_scolastici` con `ON CONFLICT DO NOTHING`;
   - `anni_sede` con `inizio` = la `fine` precedente + 1;
   - `fine`, `ultimo_giorno_aperto` e `prepara_successivo_dal` con lo stesso giorno e mese dell'anno
     prima, così la sede che li ha spostati conserva la sua scelta (**scelta mia**);
   - stato `in_preparazione`, più la copia di listino, moduli e posti.

   Log `anno-creato`, livello `info`, con i conteggi.
2. **Cambia gli stati**:
   - da `corrente` a `in_chiusura` quando oggi > `ultimo_giorno_aperto`;
   - da `in_chiusura` a `chiuso` quando oggi > `fine`.

   Ogni cambio scrive in `anni_sede_stati` e lascia un log.
3. **Battito** `esito: 'ok'` con i conteggi per sede, anche quando non è successo niente. Si registra in
   `JOB_CRON` e `ESITI_BATTITO` (`src/lib/health/controlli.ts:219, :831`).

Il parametro `p_oggi date` serve per la simulazione. È ammesso **solo** per le sedi di prova (la stessa
regola di `isScuolaE2E`, `src/lib/scuole/reali.ts:24`: id con prefisso `e2e00000`) e solo dal ruolo di
servizio. Per tutte le altre sedi il job si ferma con un errore.

Il job **non fa mai il passaggio**.

### 4.7 Le iscrizioni

- **Modulo pubblico** (`POST /api/iscrizione`):
  - offre gli anni della sede con `domande_aperte`. Se sono due, la famiglia sceglie («2026/27 — ingresso
    durante l'anno» oppure «2027/28»); se è uno, non chiede niente; se non ce n'è nessuno, dice che le
    iscrizioni sono chiuse;
  - `enrollment_submissions.anno_id` è l'anno di destinazione, `NOT NULL`, e zod lo limita agli anni
    offerti.
- **Conferma** (dec. 7). Dall'elenco dell'anno in corso, la segreteria registra «Conferma per il
  2027/28», e questo crea:
  - una frequenza `tipo conferma` nell'anno prossimo;
  - la sezione, cioè la continuazione di quella attuale;
  - la voce della quota, con importo `quota_conferma` dal listino e categoria `iscrizione`.

  Il bambino all'ultimo anno d'infanzia che va alla primaria Kidville è una conferma con quota e retta
  della primaria (dec. 12): la riga viene segnata `cambia_grado` e la sezione si sceglie. Il genitore vede
  solo la voce della quota (risposta 3).
- **Nuova iscrizione**: una domanda accolta crea, o collega, l'alunno e una frequenza `tipo nuova`
  nell'anno di destinazione, con la quota `quota_nuova`.

  **Non scrive più `alunni.section_id` né `classe_sezione`** per un anno che non è quello attivo: così si
  chiude il difetto di `admin/iscrizioni/route.ts:1772` e di `import/esegui.ts:357`. Un ingresso a metà
  anno ha la sezione dalla `data_ingresso`.
- **CRM**:
  - `crm_bambini.anno_id` si dichiara sulla scheda con gli anni veri, e l'etichetta relativa
    `in_corso | prossimo` sparisce;
  - `crm_quota_passa` riceve l'`anno_id` al posto di `quota_anno`;
  - la competenza è l'`inizio` dell'anno della sede, non più `make_date(anno, 9, 1)`;
  - la quota prende l'anno dalla scheda, non da `adesso` (`…/quota/route.ts:186`).
- **`quota_saldata`**: la ricalcola un trigger su `pagamenti` (dopo un cambio di `stato` o di
  `importo_pagato`) per le frequenze che puntano a quella voce. Se la voce viene eliminata, la frequenza
  torna `in_attesa`.
- **Posti**: il conteggio per fascia, confrontato con `posti_autorizzati`, accende un avviso. Non blocca
  mai.

### 4.8 Rette e servizi dal listino

- `genera_rette_anno` e `genera_rette_mensili` ricevono un `anno_sede_id` dichiarato. Leggono le frequenze
  `in_attesa` e `iscritto` che coprono il mese, con il pro-rata di oggi.
- L'importo si decide così:
  - con `retta_esente`, nessuna voce;
  - altrimenti, nell'ordine: `retta_mensile`, la retta del listino per la fascia della sezione, la retta
    del listino senza fascia;
  - se non c'è nessun importo, la voce non si crea e l'esito la conta fra le «senza importo» (`warn`).

  I 150 € cablati spariscono. I mesi vengono dal listino. Il fratello che paga viene dalla frequenza.
- Le rette dell'anno prossimo si possono generare già con `iscrizioni_aperte`, perché d'estate le famiglie
  pagano settembre in anticipo (10 incassi in agosto 2026). I genitori le vedono dal passaggio.
- `iscrizioni_servizi` prende l'anno dal suo `dal`. La generazione segue la stessa regola.
- La generazione logga anche il successo, con i conteggi.

### 4.9 Il passaggio d'anno

Tabelle:
- `passaggi_anno` `(scuola_id, da_anno_sede_id, a_anno_sede_id, stato anteprima|confermato|annullato,
  creato_*, confermato_*, annullato_*, conteggi jsonb)`;
- `passaggi_anno_righe` `(alunno_id, frequenza_da_id, frequenza_a_id, sezione_da_id, sezione_a_id,
  esito, eccezione, modificata_da)`;
- `passaggi_anno_docenti` `(utente_id, sezione_a_id, origine copiata|aggiunta|tolta)`.

Il passaggio va in quattro tempi.

1. **Anteprima** (`passaggio_anteprima`). Si può rifare quante volte si vuole, e nessuno vede niente. Crea
   una riga per ogni bambino con una frequenza attiva nel vecchio anno o con una frequenza nel nuovo.
   L'esito di ogni riga è uno di questi:

   | esito | quando |
   |---|---|
   | `continua` | ha confermato e va nella sezione di continuazione |
   | `cambia_grado` | ha confermato, ma la sezione va scelta |
   | `nuova` | è una nuova iscrizione |
   | `esce` | ha detto «no», si è ritirato, o ha finito il ciclo |
   | `non_risposto` | non ha né confermato né detto «no»: **alla conferma esce come chi ha detto «no»** (risposta 13). L'anteprima lo mostra a parte, con il conteggio, perché la segreteria possa registrare le conferme mancanti prima di confermare |

   Chi è uscito così rientra con una **conferma tardiva**: una frequenza nuova `tipo conferma` con
   `data_ingresso` = il più tardi fra l'`inizio` del nuovo anno e il giorno della conferma. Foto e chat le
   vede da quel giorno (dec. 17; **scelta mia**).

   I docenti vengono copiati dalla sezione vecchia alla sua continuazione, e la copia si può correggere.
2. **Eccezioni**: la segreteria corregge le righe una per una (sezione, esito, docenti).
3. **Conferma** (`passaggio_conferma`), in una transazione sola e ripetibile: rifarla su un passaggio già
   confermato non fa niente e restituisce lo stesso esito. Si ferma se una riga non ha la sezione. Poi:
   - mette `uscito` le frequenze vecchie di chi esce, con `data_uscita` = la `fine` del vecchio anno;
   - copia i docenti;
   - porta il nuovo anno a `corrente`;
   - scrive il log `passaggio-confermato`, con i conteggi.

   Lo stato del vecchio anno non cambia: lo decidono le date.
4. **Annullamento** (`passaggio_annulla`). È ammesso solo finché nel nuovo anno non esistono righe delle
   tabelle `data` e `madre` diverse da quelle create dal passaggio (conteggio fatto sul registro). Rimette
   gli stati com'erano, toglie le copie dei docenti e lascia un log. Dopo la prima presenza o la prima foto
   rifiuta, e mostra i conteggi.

### 4.10 Chi vede cosa

Ogni regola sta in **un posto solo, in SQL**: in funzioni che usano sia le policy (con `auth.uid()`) sia
le route (con `rpc`, passando l'id). Sono queste:
- `sezioni_visibili_docente(utente) → (section_id, sola_lettura)`;
- `figli_attivi(genitore) → (alunno_id, frequenza_id, section_id, scuola_id)`;
- `media_visibili_genitore`, `avvisi_visibili_genitore`;
- `thread_visibili(utente) → (thread_id, scrivibile)`;
- `voci_visibili_genitore`.

`current_parent_student_ids()` resta per l'anagrafica (classe A), ma non apre più i contenuti della classe.

- **Docenti** (dec. 14): vedono le sezioni assegnate dell'anno attivo, in scrittura solo se l'anno è
  `corrente`, e in sola lettura quelle assegnate negli anni passati. Le sezioni di un anno
  `in_preparazione` o `iscrizioni_aperte` non le vedono mai. Direzione e segreteria vedono tutte le sezioni
  dell'anno scelto.
- **Foto** (risposta 8, dec. 16-17): il genitore vede una foto se il figlio è attivo e se è taggato,
  oppure se nel giorno della foto stava in una delle sezioni destinatarie (`alunni_classi_storico`, `dal`
  e `al`). Una foto per tutti senza destinatari vale per tutte le sezioni di quell'anno nella sede. Le foto
  degli anni passati di un bambino che continua restano visibili, perché in quel periodo lui era in quella
  classe (**mia lettura della risposta 8**). Chi lascia la scuola perde tutto, subito.
- **Chat** (risposta 9): il genitore legge il thread se il figlio è attivo. Scrive se, in più, il docente
  è assegnato alla sezione attuale del figlio nell'anno attivo, oppure è segreteria o Direzione. Il docente
  che non è più del bambino legge e non scrive.
- **Avvisi, news, moduli**: valgono le sezioni destinatarie, per uuid, rispetto alla sezione attuale del
  figlio nell'anno attivo. La **mensa** si prenota solo per un figlio attivo, in una data dell'anno attivo.
- **Pagamenti**: il genitore vede le voci dei propri figli negli anni già passati, compresi gli arretrati
  degli anni chiusi. Dell'anno prossimo vede solo la quota.
- **Moduli firmati**: il genitore vede i propri, di tutti gli anni. «Da rifirmare» sono quelli con
  `durata = anno` non firmati nell'anno attivo.
- **Dai nomi agli uuid**:
  - `avvisi.target_classes`, `galleria_media_v2.target_classes`, news e forms diventano
    `target_section_ids uuid[]`;
  - `mensa_class_menu_assignment.classe` diventa `section_id`.

  Le colonne con i nomi si tolgono nella PR 5.

### 4.11 Il selettore dell'anno e il cruscotto

**Selettore**:
- `AnnoSelector` sta accanto a `SedeSelector` (`cockpit.tsx:519`, `AdminTopBar.tsx:100`,
  `AdminTopBarMobile.tsx:51`), con il contesto `src/lib/context/anno-context.tsx` costruito sul modello di
  `sede-context.tsx`: cookie `anno_attivo` non httpOnly valido un anno, `epocaAnno`, `AnnoNotice`;
- il gemello lato server è `annoDalCookie`, in `scope.ts`, come `sediDalCookie`;
- lo vedono Direzione e segreteria. Docenti e genitori non scelgono l'anno;
- l'anno predefinito è l'anno attivo della sede scelta;
- quando l'anno scelto non è quello attivo compare un avviso fisso: «Stai guardando il 2027/28 (iscrizioni
  aperte), non l'anno in corso».

**Cruscotto dell'anno prossimo**, per sede (dec. 21):
- iscritti per sezione e per fascia accanto ai posti, con un avviso e nessun blocco;
- confermati, «no» e non risposto, presi dall'anno in corso;
- quote incassate e mancanti, in numero e in euro;
- chi ha i moduli senza la quota, e chi ha la quota senza i moduli;
- il confronto con la stessa data dell'anno prima. Per il 2026/27 è ricostruito dalle date di creazione
  di domande e alunni, ed è segnato «ricostruito».

La route è `GET /api/admin/anno/cruscotto` (`withRoute`, `requireStaff`, zod). I nomi dei bambini si
vedono solo in app.

**Impostazioni di sede**, sezione «Anno scolastico»:
- confini (`sposta_confine_anno`), `ultimo_giorno_aperto` e `prepara_successivo_dal`;
- «Apri le iscrizioni» e «Sospendi le domande dal sito».

### 4.12 La soglia, e i punti da correggere

Una funzione sola, `annoDi(scuolaId, giorno)`. Lato server legge `anni_sede`, con una cache per
richiesta; lato client legge dal contesto. Sostituisce le 10 regole del §1, e con loro il `-07-31` di
`banco-famiglia.ts:1180`, i due `-08-01` e `MESE_RIPIEGO_AMBIGUO`. Senza sede si usano le date predefinite
di `anni_scolastici`: con la decisione 2 la soglia passa dal 1° agosto al **1° settembre**. Una prova
verifica che la versione TS e quella SQL diano lo stesso anno nelle date del §4.17.

Correzioni puntuali:
- `StudentRegistryForm.tsx:116`: la data d'ingresso la sceglie la segreteria, come giorno di Roma;
- `GeneratoreCategoria.tsx:72`: la chiave anti-doppione diventa `slug + anno_id`;
- prestampati e protocolli (`prefill.ts:337`, `banco.ts:1526`, `genera-documento/route.ts:122`): stampano
  l'anno della frequenza;
- `aruba/emissione.ts:1008`: la serie senza competenza usa l'anno della voce;
- `votazioni/tipi.ts:37`: il titolo viene dall'anno della votazione;
- `import-massivo/route.ts:166`: primo e ultimo giorno vengono dall'anno dichiarato.

### 4.13 Il recupero dei dati che ci sono già

Sono tutte regole generiche, valide per ogni sede, senza uuid.
- **Anni**: tutti quelli che servono a coprire la riga datata più vecchia fino a oggi, cioè il 2025/26 e il
  2026/27. Il 2025/26 va dal 01/09/2025 al 31/08/2026, `chiuso`. Il 2026/27 va dal 01/09/2026 al
  31/08/2027, `corrente`, con ultimo giorno aperto il 31/07/2027 e `prepara_successivo_dal` il 01/09/2026:
  il job creerà il 2027/28 alla prima ora, senza valori scritti apposta.
- **Sezioni**: tutte nel 2026/27, con `fascia` NULL (la sceglie la segreteria preparando il 2027/28).
- **Frequenze**: una per alunno nel 2026/27, con `origine = 'recupero'`:
  - chi non è archiviato diventa `iscritto`; i ritirati archiviati diventano `ritirato`, con
    `data_uscita` = `archiviato_il`;
  - `data_ingresso` = il primo `dal` in `alunni_classi_storico`, altrimenti il 01/09/2026;
  - `retta_mensile` = `importo_retta_mensile` se è maggiore di zero, altrimenti NULL;
  - il listino 2026/27 riceve una retta senza fascia uguale a `retta_default_importo`, così il
    comportamento di oggi (zero → 150) **resta identico in euro**. Il rapporto conta quante frequenze si
    reggono su quella retta.
- **Eventi**: anno dalla data, con le regole del §4.4.5. Nelle sedi vere cadono nel 2025/26 3 messaggi di
  chat, 3 valutazioni e la retta di giugno; le 3 voci di luglio seguono la scadenza.
  - Le 3 valutazioni e le 73 presenze di prova di luglio e agosto puntano a sezioni del 2026/27.
  - **Il controllo «sezione dello stesso anno» vale per le scritture nuove, e l'invariante per le righe
    create dopo l'attivazione.** Le righe vecchie in contrasto si contano e si elencano per uuid nel
    rapporto (**scelta mia**).
- **Pagamenti**: anno dalla competenza; altrimenti dalla scadenza; altrimenti da `creato_il` (giorno di
  Roma). Il rapporto conta quante voci passano per ciascuna strada.
- **Domande**: tutte nel 2026/27, l'unico anno aperto quando sono arrivate. Il rapporto conta quelle
  arrivate dopo il 15/09, che la segreteria può spostare perché l'anno non è chiuso.
- **CRM**: l'etichetta relativa si traduce rispetto alla data di creazione della scheda; `quota_anno`
  diventa `anno_id`.
- **Nomi di classe → uuid**: si abbinano per sede e per anno, sul nome normalizzato. Chi resta senza
  abbinamento finisce nel rapporto **e va sistemato prima della PR 4.4**: una foto con un destinatario
  sconosciuto, altrimenti, non la vedrebbe nessuno.
- **Rapporto di riconciliazione** (`riconciliazione_anno`, solo conteggi). Per tabella e per sede
  registra:
  - righe prima e dopo, e righe per anno (devono tornare);
  - euro prima e dopo (`pagamenti.importo`, `importo_pagato`, `incassi.importo`);
  - casi ambigui per motivo.
- **Interruttori nella migrazione del riempimento**:
  - `scatola_nera.senza_storico`, altrimenti 200.000 «com'era» finirebbero nella scatola nera;
  - `anno_scolastico.riempimento` (corretto il 07/11/2026; la bozza diceva `registri.manutenzione`, che nessun trigger di queste tabelle legge
    e che aprirebbe `DELETE` sul WORM di `registro_modifiche` e `audit_scritture_docente`): il trigger generico rimette `storico_versione`
    e `updated_at` al valore di `OLD`, altrimenti salterebbero.

  **Sono interruttori del freno: il corpo della PR li mostra al titolare**, che approva il merge.

### 4.14 Che cosa resta sull'anno solare, e perché

Fatture, ricevute e le loro numerazioni seguono la legge fiscale, che numera per anno solare. Il registro
di protocollo si rinnova ogni anno solare. Incassi, cassa e riconciliazione bancaria contano per anno
solare (l'attestazione per il 730). I numeri degli ordini di merchandising e il notiziario seguono il
mese solare.

Un incasso resta solare, ma punta a una voce che ha il suo anno scolastico: la quota del 2027/28 pagata
a febbraio 2027 è un incasso del 2027 su una voce del 2027/28. `annoFiscale()` non si tocca.

### 4.15 La conservazione

I dati sanitari degli anni chiusi si tengono finché la famiglia non chiede di cancellarli (dec. 19). La
chiusura di un anno non cancella niente: l'oblio passa dagli strumenti che ci sono già
(`richieste_cancellazione`, «Elimina definitivamente», `anonimizzaAlunno`). Il GDPR, all'art. 5(1)(e),
fissa il principio di **limitazione della conservazione**: un dato personale si tiene solo per il tempo
che serve allo scopo per cui è stato raccolto.

**Le domande non accolte** seguono la regola che c'è già (risposta 14): il job
`POST /api/gdpr/retention-iscrizioni` le cancella dopo **24 mesi** (`MESI_CONSERVAZIONE = 24`,
`route.ts:116`; la prima volta a luglio 2028). Questo lavoro non lo tocca. Il job filtra per data di
arrivo, non per anno: resta corretto anche dopo l'`anno_id`.

Il job che cancella i motivi d'assenza 7 giorni dopo un ritiro (`20261019211807`) resta legato al solo
`ritirato`. Chi esce a fine anno non è un ritiro, quindi i suoi motivi restano (**scelta mia**, coerente
con la decisione 19).

### 4.16 I log

Tutti passano da `logEvento`, `logOk` e `logErrore`. Contengono solo uuid e conteggi.

| evento | livello |
|---|---|
| battito di `anni_tick` (`ok` anche a vuoto) | `info` |
| `anno-creato`, cambio di stato | `info` |
| `passaggio-anteprima`, `-confermato`, `-annullato` | `info` |
| rette generate | `info` |
| correzione registrata (tabella e uuid della riga; il motivo **mai**) | `info` |
| scrittura rifiutata con `ANNO_CHIUSO` o `PASSAGGIO_DA_FARE` | `warn` |
| `anno-scrittura-ambigua` | `warn` |
| `GIORNO_SENZA_ANNO` | `error` |
| invarianti dell'anno non a zero nel controllo notturno | `error` |

### 4.17 Le prove

**Invarianti** in `anno_invarianti()`: una funzione di sola lettura, eseguita anche dal controllo di
salute notturno (un'invariante mai rieseguita è una fotografia), e copiata nel file
`…-anno-scolastico-invarianti.sql`. Ognuna deve restituire **zero righe**:
1. un giorno senza anno, o in due anni (`generate_series` sui periodi di ogni sede);
2. una presenza fuori dal suo anno, e lo stesso controllo su ogni tabella di modo `data` del registro;
3. due frequenze vive per lo stesso bambino nello stesso anno;
4. un «iscritto» senza moduli o senza quota, ricalcolato dalla verità (`frequenze_moduli`, voce pagata) e
   non dai flag; esclude `recupero` e li conta;
5. una competenza fuori dal periodo del suo anno;
6. una riga di `scatola_nera.modifiche` su un anno **`chiuso`** (non `in_chiusura`: lì la segreteria scrive
   senza gettone, regola R-a, e in produzione le tabelle `piena` registrano migliaia di modifiche al mese:
   contarle sarebbe un falso difetto), successiva al cambio di stato, con almeno una colonna non esente e
   senza un uso di gettone nella stessa `transazione` (la scatola nera la registra già); per le tabelle
   senza scatola nera bastano i gettoni;
7. un genitore che vede, attraverso un figlio non attivo, una sezione, una foto, un avviso o un thread;
8. un docente che vede una sezione di un anno `in_preparazione` o `iscrizioni_aperte`;
9. (mia) una riga creata dopo l'attivazione con una sezione di un altro anno;
10. (mia) una tabella del registro senza colonna o senza trigger, o una tabella con `anno_id` che non è nel
    registro;
11. (mia, durante le PR 3-4) una scheda alunno che non coincide con la sua frequenza dell'anno attivo.
15. (4.8) un bambino in classe senza riga aperta nello storico delle classi;
16. (mia, 4.9) un anno `in_chiusura` o `chiuso` con le domande ancora aperte.

**Altre prove**:
- **Conservazione**: conteggi ed euro prima e dopo, dal rapporto del §4.13, uguali al centesimo.
- **Confronto con l'Excel**: frequenze per sezione confrontate con i fogli di classe del 21/09, leggendo
  solo i conteggi. Le differenze si spiegano con `alunni_classi_storico`.
- **Orologio spostato**, in TS e in SQL: 31/07 23:30, 01/08 00:30 (che in UTC è ancora il 31/07),
  31/08 23:30, 01/09 00:30, 31/12, 15/01, sempre ora di Roma. Più i due cambi d'ora: 25/10/2026 e
  28/03/2027.
- **Lock** `__tests__/architecture/anno-scrittura-coverage.test.ts`, costruito come
  `isolamento-sede-coverage`:
  - ogni insert o upsert su una tabella `dichiarato` (dalla fixture `__tests__/fixtures/tabelle-anno.json`,
    generata dal DB) passa da `resolveAnnoScrittura`, o scrive un `anno_id` ottenuto da lì;
  - fuori dal modulo dell'anno, in `src/` non compaiono `annoScolasticoCorrente(`, `-08-01`, `-07-31`, né
    calcoli dell'anno da `getMonth()`;
  - il lock dichiara quanti file e quante scritture ha esaminato, con un minimo atteso: un lock cieco è
    già successo tre volte;
  - **prova del rosso**: si rompe una route di proposito, si vede il lock diventare rosso, si rimette a
    posto.
- **Scenari nel browser**, in italiano semplice, sede Demo, con screenshot. Per esempio: «la segreteria
  apre le iscrizioni al 2027/28 e conferma un bambino; la maestra non vede niente di nuovo; il genitore vede
  solo la quota»; «una foto mandata alla sezione A non arriva alla famiglia della sezione B»; «un bambino
  ritirato: il genitore non vede più foto e chat».
- **Un anno intero simulato, in Demo** (risposta 15): `anni_tick(p_oggi)` sulle date dal 1/9 al 31/8,
  con apertura, conferme, passaggio, annullamento, ripasso e chiusura, controllando a ogni passo stati,
  visibilità e invarianti. Le scritture passano dalle API su `:3100`, solo nella sede Demo. Durante la
  simulazione Demo non serve ad altri collaudi, e va detto prima di cominciare. Alla fine Demo resta
  spostata in avanti: le `DELETE` per riportarla a oggi si preparano in un file e **le esegue il titolare**
  dall'editor SQL (il freno le nega, giustamente).

### 4.18 Le scelte mie, da controllare

1. Lo stato `in_chiusura` va dal giorno dopo `ultimo_giorno_aperto` alla `fine` (agosto). In quel mese
   scrivono solo Direzione e segreteria, con un gettone `agosto` e senza motivo; da `chiuso` serve il
   motivo.
2. Passaggio non fatto all'inizio del nuovo anno: le scritture del nuovo anno si fermano con
   `409 PASSAGGIO_DA_FARE`, e gli avvisi partono dal 1° agosto.
3. Il job gira ogni ora, idempotente, sul giorno di Roma.
4. L'anno successivo nasce con lo stesso giorno e mese di fine e di chiusura dell'anno prima.
5. La sezione ha una `fascia`, oltre a `school_type`.
6. Sconto fratelli, pro-rata e giorni di scadenza restano in `admin_settings`.
7. La spunta dei moduli è sempre della segreteria, anche quando il modulo è stato firmato in app.
8. Incassare un arretrato di un anno chiuso non è una correzione.
9. Le righe vecchie con una sezione di un altro anno si contano e non si toccano.
10. Le foto degli anni passati di un bambino che continua restano visibili.
11. Una foto per tutti senza destinatari vale per tutte le sezioni di quell'anno.
12. Il motivo d'assenza di chi esce a fine anno non si cancella.
13. Le domande arrivate da settembre restano nel 2026/27 finché la segreteria non le sposta.

14. Durante la transizione la fonte di verità passa da `alunni` a `frequenze` in tre fasi (§4.19).
16. Chi esce al passaggio perché non ha risposto, e poi conferma tardi, vede foto e chat dal giorno della
    conferma (o dall'inizio dell'anno, se conferma prima).
15. Le sedi di prova ricevono anni e frequenze come le altre, e ogni sede nuova li riceve alla nascita.

### 4.19 La transizione: chi è la fonte di verità, PR per PR (scelta mia)

Ogni PR deve poter andare in produzione da sola con il gate verde, e il merge lo fa il titolare a mano.
Per questo i campi vecchi e quelli nuovi convivono, e in ogni fase uno solo dei due comanda.

| fase | PR | fonte di verità | come resta allineato l'altro |
|---|---|---|---|
| A | 2 → 4.2 | `alunni` (i campi di oggi) | un trigger copia `alunni` nella frequenza dell'anno attivo. Dalla PR 3 l'app scrive tutti e due da un helper solo, `scriviFrequenza()`, e il trigger resta come rete |
| B | 4.3 → 4.9 | `frequenze` | una migrazione sostituisce il trigger con quello opposto: la frequenza dell'anno attivo si ricopia nei campi vecchi di `alunni`, così le letture non ancora spostate e le policy di oggi continuano a funzionare. Le frequenze degli anni non attivi non toccano mai `alunni` |
| C | 5 | `frequenze` | i campi vecchi e il trigger si tolgono, dopo che il lock ha mostrato che non li legge più nessuno |

Lo stesso vale per i nomi delle classi. Dalla PR 2 si scrivono insieme `target_classes` e
`target_section_ids`. Dalla PR 4.4 si legge `target_section_ids`. Nella PR 5 i nomi si tolgono.
L'invariante 11 e un confronto analogo fra nomi e uuid dicono, ogni notte, se i due lati si sono divisi.

### 4.20 Le app sugli store

L'app iOS e Android è una WebView che carica il sito da `server.url` (`capacitor.config.ts:5,112`):
interfaccia e API escono insieme a ogni deploy, e nessuna versione vecchia dell'interfaccia resta sugli
store. Resta solo la scheda già aperta durante un deploy. Per questo, fino alla PR 5, le API accettano
ancora `target_classes` per nome e lo traducono in uuid, e per la stessa ragione `anno_id` diventa
obbligatorio nel modulo pubblico solo dalla release successiva a quella che lo introduce.

### 4.21 Che cosa resta al costruttore

- I nomi delle colonne di dettaglio, purché seguano questo documento.
- Il modo in cui il client Supabase porta l'header del gettone: va bene un client per richiesta o
  `.setHeader()`.
- La divisione delle route grandi in moduli.
- L'aspetto del cruscotto, nello stile di `cockpit.tsx`.
- L'ordine dei trigger, purché la guardia venga dopo il calcolo.

