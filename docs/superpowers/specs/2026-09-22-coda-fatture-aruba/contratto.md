# CONTRATTO UNICO — Coda fatture Aruba e correzione urgente R1 (v4, 23/09/2026)

> Autore unico del contratto. **Vincola D1–D6: dove un design dice altro, vale questo testo.** Qui sta tutto ciò che è condiviso fra due o più componenti; ciò che è interno a un componente segue il suo design, purché non contraddica questo testo.
> **[V]** = verificato nel repo o in produzione (sola lettura: aggregati, espressioni costanti, nomi di oggetti). **[D]** = scelta di progetto o deduzione.
> La v4 sostituisce per intero la v3 e accoglie i 6 rilievi del critico sulla v3 (§0.2). Le correzioni delle versioni precedenti restano valide dove la v4 non le cambia; i nomi vecchi e quelli in vigore stanno in §3.

---

## Registro C0 (23/09/2026) — correzioni dell'ultimo critico del design e default del titolare

> **Prevale su ogni testo di questo contratto e di D1–D6 che dica altro.** Ogni design porta in testa un blocco «Correzioni C0» che rimanda qui. Dove un paragrafo più sotto non è stato riscritto, vale la riga di questo registro.

### C0.1 Rilievi chiusi (12: 4 gravi, 8 minori)

| # | Rilievo | Decisione (fonte di verità) | Tocca |
|---|---|---|---|
| G1 | Predicato «partita non registrata» con due testi (D1 e D2) | **Un solo predicato**, identico nel modulo TS di D1 (`fattura-partita-non-registrata.ts`) e nel suo gemello SQL, in `_fatture_coda_partita_non_registrata` di D2 e nel pre-controllo di D4 (vedi C0.3). Motivo [V]: `emissione.ts:2604` scrive `fattura_aruba_id = okEsiti[0].uploadFileName`, il file della **prima** quota riuscita; l'idempotenza guarda solo le righe vive (`emissione.ts:1458` [V]). Test nuovi: D1 «riga viva di un'altra quota e file del pagamento assente ⇒ vero»; D2 «sola riga scartata dello stesso file ⇒ accodata con motivo `ritrasmissione`». Parità TS/SQL provata su PGlite in D1; il lock specchio di D2 confronta i due testi | §9.4, §18, D1 §8, D2 §5, D4 §5 |
| G2 | `BAD_INPUT` di `fatture_coda_invio_registra` dopo la RPC del numero trattato come guasto transitorio (fino a 4 numeri bruciati per voce, ~12 buchi/ora [D]) | (a) `fatture_coda_invio_registra(…, p_solo_verifica boolean DEFAULT false)`: con `true` esegue **tutti** i controlli di §7.3 su un documento col numero segnaposto e non scrive. Nessuna RPC nuova (restano 32). D3 la chiama **prima** di `prenotaInvio` e della RPC del numero; un `BAD_INPUT` lì chiude la voce `errore` senza consumare numeri. (b) Un `BAD_INPUT` arrivato **dopo** il numero chiude la voce `errore giornale_non_aperto` con effetto **ferma** e anomalia agli admin: **mai rientro** (la decisione 17 copre l'errore DB momentaneo, non un rifiuto deterministico). (c) Test PGlite: `BAD_INPUT` dopo il numero ⇒ un solo invio `bruciata`, voce in `errore`, nessun secondo numero al giro dopo. `verificaFormaInvio` di D3 riceve `voce.pagamento_id` e `voce.scuola_id` e li confronta con `riga_registro` come fa `_fatture_coda_riga_difetto` | §9.2, §10.11, D2 §5, D3 §8/§13/Tab. A |
| G3 | «Ritrasmetti» cercato da C§17.4 ed E19, ma D5 v6 mostra `FatturaButton` in linea, il cui trigger su scartata è «Riprova fattura» (`FatturaButton.tsx:488`, `t('fatBtn_riprova')` [V]) | **Nome unico: «Riprova fattura»**, il trigger di `FatturaButton` in linea dentro la riga della voce, mostrato solo con `azioni.ritrasmetti=true`; apre il modale «Metti in coda la fattura». «Ritrasmetti» **non** è un nome accessibile. E19 di D6: presenza del comando, apertura del modale con l'anteprima simulata, POST singolo sul pagamento della voce; nessun comando con `ritrasmetti=false` né su una voce d'altra sede | §17.4, D5 §12, D6 §9 |
| G4 | Battito della pulizia: D2 compone `'cron:fatture-coda-pulizia:ok'`, D6 e `health.test.ts` pretendono il letterale `'cron:fatture-coda-pulizia'` | Il battito della pulizia si scrive con `_fatture_coda_log(…, p_fingerprint text DEFAULT NULL)`: con il parametro valorizzato il fingerprint è quello e non si compone. Nel file 3 compare il **letterale** `'cron:fatture-coda-pulizia'`; `evento='cron'`, `livello='info'`, `contesto.campi={operazione:'fatture-coda-pulizia', esito:'ok', n_*}`. Modello: l'INSERT esplicito di `20260807211157_presenze_retention_motivo_assenza.sql:146-158` [V]. Il lock specchio di D2 verifica il letterale; D6 §6.5 resta com'è | §15, D2 §6/§9/§11 |
| m1 | Tetto contato senza i NULL | In **tutti** i conteggi del tetto (ora e minuto, `_fatture_coda_upload_ultima_ora()` compresa): `esito IS DISTINCT FROM 'non_eseguito'`. Una prenotazione con esito NULL occupa il posto (fail-closed). Test in `fatture-coda-cancello.test.ts`: upload prenotato con esito NULL, limite 2 ⇒ il terzo riceve `QUOTA_ORARIA` | §9.1, D2 §5 |
| m2 | «Rimetti in coda» impraticabile per le voci con intestatario proposto dal bonifico | In `rimetti` il pre-controllo riceve come scelta l'intestatario salvato nella voce (`intestatario_scelto`, `intestatario_origine`): se è `proposta_bonifico` e coincide con la proposta ricalcolata vale come **confermato** (lo era all'accodamento); se diverge la voce resta in `errore` con `proposta_da_confermare`, e il dialogo dice di toglierla e riaccodarla dalla Riconciliazione con la spunta. `zCorpoRimetti` non cambia. Test in `fattura-coda-azioni.test.ts` e `RimettiInCodaDialog.test.tsx` | §12, D4 §10, D5 §6 |
| m3 | `scarto-senza-destinatari` a livello error anche quando la lista è vuota solo perché si è escluso chi ha accodato | Lista vuota **già prima** dell'esclusione ⇒ `error scarto-senza-destinatari` come oggi (`sync/route.ts:877-889` [V dal critico]); vuota **solo per l'esclusione** ⇒ nessun error, un `info` (esito `scarto-solo-chi-ha-accodato`), perché quella persona riceve `scarto_sdi` o il `da_verificare` dall'outbox. Casi in `fattura-sync-00404.test.ts` e `fattura-sync-cancello.test.ts` | §14, §15, D3 §15 |
| m4 | Test ponte su due database; `verificaFormaInvio` senza `pagamento_id` | Prima di `invio_registrato` l'INSERT del supabase finto si **rispecchia** in PGlite (`semina.rigaRegistro` con stesso id, pagamento, serie, anno, numero, `aruba_filename`). `verificaFormaInvio` riceve `voce.pagamento_id` e `voce.scuola_id` (vedi G2) | §17.6, D3 §8/§17 |
| m5 | Due testi di D5 imprecisi | (1) Superato dal default D3 (C0.2): con `numero_conteso` **non** esiste «Rimanda». (2) `{doc}` nei testi di notifica = `formattaNumeroFattura(sezionale, numero, anno)` (`sezionale.ts:584` [V]) dentro un `try`, con ripiego «una fattura»; un test per ogni serie (FPR esce «FPR n/26») | §14, D5 §10 |
| m6 | Nomi di mappe e tuple divergenti, firme di D3 non registrate, eccezioni del lock specchio | **Fanno fede D2 e D6**; D3 e D4 si adeguano in fase 0: `INTESTATARIO_ORIGINE`/`INTESTATARIO_ORIGINI` (non `ORIGINE_INTESTATARIO`), `CAUSALE_MODO`/`CAUSALE_MODI` (non `MODI_CAUSALE`), `AZIONE_RICHIESTA`/`AZIONI_RICHIESTE` (non `AZIONI_VERIFICA`), `ESITO_LOG` (non `ESITO_LOG_CANCELLO`). `TIPI_DOCUMENTO_SUPPORTATI` entra in `contratto-db.ts` (D2) = `['TD01']`. Firme estese di D3 registrate in §13: `giornaleDi(voce, token, cv)`, `risolviDocumenti(ctx)` con `ctx.giornale` e `ctx.parcheggia`, `chiudiTentativo(id, esito, opz?)`. Lock specchio: `vocabolario-log.ts` è **escluso come catalogo** (come `contratto-db.ts` e `api-contratto.ts`); nessuna eccezione contata per `'sospesa'` e `'assente'` | §13, §17.5, D2 §7/§11, D3, D4 §4, D6 §3 |
| m7 | Richieste fondate non scritte nel contratto | Scritte in **C0.4** | C0.4 |
| m8 | F3 falso, F7 impreciso, `ship-cycle.md` passo 4, rimando in D6 §10 | F3 e F7 corretti in §1; `ship-cycle.md:348-352` [V] prescrive ancora `apply_migration`: **il passo 4 NON si esegue** per PR-D1, PR-A e PR-B (§0.3, §18). Si segnala al titolare che il comando resta in contrasto con la decisione 25: decide lui se aggiornarlo. Rimando di D6 §10 corretto | §0.3, §1, §18, D6 §10 |

### C0.2 Default approvati dal titolare (applicati)

| # | Default | Regola in vigore |
|---|---|---|
| D1 | Numero rifiutato nel merito o bruciato: la voce si può togliere | **Eccezione a S29.** Una voce in `errore` i cui invii sono **tutti** `rifiutata` (scarto di merito di Aruba) o `bruciata` (mai arrivati allo SdI) si toglie con `fatture_coda_togli`: il buco di numerazione esiste già e togliere non ne crea altri. Gli invii restano a giornale (traccia, oblio escluso come oggi), il pagamento non si cancella. Con almeno un invio in qualunque altro stato resta `NUMERO_GIA_ASSEGNATO`. `azioni.togli` lo riflette; E2E: «Togli» attivo su un errore con soli invii `rifiutata`/`bruciata`, `aria-disabled` con un invio `registrata` [D] |
| D2 | Doppione SdI non identico su pagamento che non si rifattura più | Se il pagamento è annullato o rimborsato (non più `pagato`) la voce esce **da sola** dal bollino e da `doppioni_aperti` (S34 già la esclude dal conteggio [V]) e **`fatture_coda_pulizia()`** (file 3, D2, cron `'49 3 * * *'` [V, d2:889]) scrive un evento in `fatture_coda_eventi` (`doppione_chiuso_pagamento_chiuso`, attore NULL = sistema) una volta sola, con `NOT EXISTS` sullo stesso evento della voce; conta `n_doppioni_chiusi` nel battito. Nessuna RPC nuova (restano 32); il giro non lo scrive (C0.5 n. 5) [D] |
| D3 | Numero conteso | Su Aruba c'è un documento **diverso** con lo stesso numero: la voce **non** va in `da_verificare` e **non** si rimanda. Chiude `errore numero_conteso` (entra in `CODICI_ERRORE`, esce da `da_verificare M` e da `resta_da_verificare`), l'invio chiude `bruciata` (il numero appartiene a un altro documento), anomalia `numerazione_anomala` agli admin dentro l'avviso della chiusura (S44 invariata). Si rifattura con «Rimetti in coda», che prende un **numero nuovo**. Per D1 la voce si può anche togliere. **Meccanica (C0.5 n. 1):** la transizione la esegue `fatture_coda_invio_ricerca(…, 'non_combacia', …)`, che porta l'invio `da_ritentare` o `incerta` a `bruciata` con `esito_codice='numero_conteso'` (§5.2, §9.2); `_tentativo_chk` ammette `bruciata` con `tentativi ≥ 1` solo con quel codice (§7.3); poi il giro chiude `chiudi('errore','numero_conteso')`, che richiede quell'invio come ultimo della sua quota (§5.1) [D] |
| D4 | STOP d'urgenza durante la sorveglianza | L'agente di sorveglianza sospende con `fatture_coda_sospendi(NULL, '<motivo>')`: attore NULL = traccia «sistema», motivo obbligatorio. **La ripresa la fa solo il titolare** (`fatture_coda_riprendi` da admin), mai l'agente [D] |
| D5 | Modelli dei compiti | Un compito che può scrivere in produzione (anche `supabase db query --linked`, che esegue SQL arbitrario e legge `app_log`) gira **solo su sonnet o opus, mai haiku** [D] |

### C0.3 Predicato unico «partita non registrata» (G1)

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
Casi: quota B viva, file della quota A assente ⇒ **vero**; sola riga scartata dello stesso file ⇒ **falso** (ritrasmissione legittima). [V, SELECT del 23/09 riportato dal critico] oggi vale 6, come entrambe le forme precedenti: non cambia il rilascio.

### C0.4 Richieste dei design scritte nel contratto (m7)

- **Log e test.** `livelloLogCoda(operazione, esito, tipo?)` con `TIPI_BATTITO_GIRO`, `ESITO_TIPO_GIRO`, `LIVELLO_TIPO_GIRO` in `vocabolario-log.ts`: il livello del battito dipende dal tipo (§15). Nessun tetto di tempo con `setTimeout` o `Promise.race` sul percorso del giro (precedenti [V dal critico]: `client.ts:519`, `emissione.ts:473`; nei test `setTimerTickMode`). Nel cardine la finta di notifiche consuma l'outbox con `prendi`/`conferma` veri. Il percorso del giro non usa embedding, `.or()` né `.filter()`.
- **HTTP ed E2E.** `CodiceRispostaCoda = CodiceErroreCoda | 'SEDE_NON_ACCESSIBILE'` (§12 e §13 allineati). La GET della coda con `voce=` o `pagamento=` va oltre i 7 giorni, entro 24 mesi (link degli scarti tardivi, decisione 20). Negli E2E si simulano anche `/api/pagamenti/fattura/anteprima` e `/api/admin/settings/categorie` (`FatturaButton.tsx:282, :415` [V dal critico]).
- **RPC.** Codice `giornale_non_aperto` (effetto ferma, G2). Forma di `p_codice_sdi`: stringa di codice SdI (`^[0-9]{5}$`) o NULL. `sveglia` nei ritorni; `posizioni(NULL)` ammesso; `doppioni_aperti` = id di **voci**. `emessa gia_a_registro` ammessa con invii tutti `registrata`. Tipo `AccessoAruba` unico in `contratto-db.ts`. I codici ottenibili solo per conversione sono elencati come tali in §8.3.
- **Avvisi e sveglia.** La sveglia parte anche al rilascio del cancello da parte della sync (decisione 13). Una sola notifica anche per l'admin che ha accodato. `fattura_scartata` va a tutto lo staff se la segnalazione non è stata scritta.
- **Circuito 429 (riscritto in C0.5 n. 6).** `chiudi(…, 'aruba_429')` apre il circuito **solo se è chiuso**, chiamando `_fatture_coda_apri_circuito('aruba_429')` (d2:517, :1082 [V]); a circuito già aperto **non fa nulla**. `fino_a` lo calcola quell'helper come `GREATEST(COALESCE(fino_a, adesso), adesso + 60')` (d2:467 [V]), con `adesso = _fatture_coda_adesso()` all'istante della **chiusura**: a circuito chiuso vale `adesso + 60'`. Il 429 del tentativo ha già aperto (o allungato) il circuito in `aruba_cancello_esito('http_429')` (§9.1), quindi di norma `chiudi` lo trova aperto e non tocca nulla. Respinta la variante di D3 in cui anche `chiudi` allungava `fino_a` a circuito aperto: allungherebbe il silenzio oltre la decisione 16 senza un 429 nuovo [D].
- **Rilascio e R1.** Rollback immediato del deploy se l'integrazione non applica la PR-A entro 5 minuti. «Autore sistema» = `creato_da NULL`. Prove P0-P7 contro `rif`. S28 con cinque condizioni (`sync/route.ts:111, :224` [V dal critico]). Uguaglianze nel lock specchio.
- **Proprietà dei file (§19).** `fattureDaRighe`, la testata di `fattura-viva.ts` e `annullo-riapre-movimento.test.ts` vanno a **D4** (anche `emissione.ts` consuma quel lock). `emissione-supabase-finto.ts` va a **D3**.

### C0.5 Rilievi del critico di C0 (seconda passata, 23/09)

| n. | Rilievo | Decisione | Tocca |
|---|---|---|---|
| 1 | [grave] Default D3 irrealizzabile: `bruciata` solo da `—`, `_tentativo_chk` vieta `bruciata` con `tentativi ≥ 1` (d2:305 prima di C0.5; oggi d2:310, riscritto [V]), `incerta → in_volo` con `non_combacia` ancora ammesso | Nuova transizione `da_ritentare`/`incerta` → `bruciata` eseguita da **`fatture_coda_invio_ricerca(non_combacia)`** (nessuna RPC nuova); `_tentativo_chk` riscritto: `(tentativi = 0) = (stato = 'numerata' OR (stato = 'bruciata' AND esito_codice IS DISTINCT FROM 'numero_conteso'))`; `fatture_coda_numero_bruciato` rifiuta `p_codice='numero_conteso'` (`BAD_INPUT`); `incerta → in_volo` solo con `ricerca_esito='assente'`; effetto proprio di `numero_conteso` in `chiudi('errore')`. D2 §4/§5, D3 Tab. A e rischi allineati | §5.1, §5.2, §7.3, §9.2, D2, D3 |
| 2 | Contratto non allineato al default D3 | `numero_conteso` esce da `CODICI_AVVISO_VERIFICA_MANUALE` (6 codici) e da «M o `resta`» in `TIPI_ANOMALIA`; frase dell'avviso `errore numero_conteso` in §8.6 | §8.5, §8.6 |
| 3 | Default D1 non scritto in §9.4 né nel trigger | `togli` e `_fatture_coda_voci_guardia` ammettono `errore → tolta` con invii tutti `rifiutata`/`bruciata`, tramite un solo helper `_fatture_coda_solo_invii_non_consegnati(voce)`; `fatture_coda_stato_pagamenti` lo espone nel campo additivo `solo_invii_non_consegnati`, da cui `azioni.togli` (nessuna RPC nuova, restano 32) | §5.1, §9.4, §9.5, §12 |
| 4 | Evento del default D2 fuori dall'elenco delle azioni | `doppione_chiuso_pagamento_chiuso` entra nelle azioni di `fatture_coda_eventi` | §7.4, §9.5 |
| 5 | Default D2 senza proprietario | Lo scrive solo `fatture_coda_pulizia()` (D2, file 3), una volta per voce | C0.2 D2, §9.5 |
| 6 | Circuito 429: C0.4 diceva «dall'istante del tentativo», D2 calcola `GREATEST(…, adesso + 60')` | C0.4 riscritto sul testo di D2, che fa fede | C0.4, D2, D3 |
| 7 | §0.3 prima di §0.2, regola 6 dentro §0.3 | Regola 6 riportata nell'elenco di §0; §0.2 prima di §0.3 | §0 |
| 8 | Default D4: la ripresa | Ribadito dove l'agente di sorveglianza agisce: sospende con `fatture_coda_sospendi(NULL, …)`, **mai** `fatture_coda_riprendi`, che spetta solo al titolare da admin (§9.4) | C0.2 D4, scomposizione R2V-F1 |

---

## 0. Regole d'uso (per ogni esecutore)

1. Nomi di tabelle, colonne, stati, codici, RPC, job, route e costanti: **solo** quelli di questo contratto. In TS si importano: il DB da `src/lib/fatture-coda/contratto-db.ts`, l'HTTP da `src/lib/fatture-coda/api-contratto.ts`, i log da `src/lib/fatture-coda/vocabolario-log.ts`. Un valore di `STATI_VOCE`, `STATI_INVIO`, `ESITI_RICERCA`, `ESITI_DOPPIONE`, `TIPI_ANOMALIA` o `CODICI_*` si scrive come proprietà della sua mappa (`STATO_VOCE.in_coda`, `ESITO_VOCE.guasto_ripetuto`…), mai come letterale (lock §17.5).
2. **Un proprietario per file e per PR** (§19). **Chi rompe ripara**: chi rompe un file lo ripara nello stesso commit; se il file è di un altro componente, commit congiunto col proprietario; un file non elencato in §19 diventa di chi lo rompe per primo, che lo aggiunge a §19 in quel commit.
3. Le migrazioni le applica **solo** l'integrazione GitHub di Supabase al merge (decisione 25). Mai `apply_migration`, mai `supabase db push` in scrittura, mai approvare `migrate.yml`, mai `migrate-ci` (decisione 27).
4. I tre file SQL della coda si caricano **identici** in PGlite: ciò che i test provano è ciò che va in produzione.
5. Nessun dato personale in log, avvisi, battiti e notifiche: solo uuid, numeri, codici e orari. Mai CF, nomi, causali o nomi file nei `campi`.
6. (C0.2 D5) Un compito che può scrivere in produzione gira solo su sonnet o opus, mai haiku.

### 0.2 Cosa cambia rispetto alla v3 (6 rilievi, tutti accolti)

| # | Rilievo | Correzione | Dove |
|---|---|---|---|
| 1 | Lo stesso fatto arriva più volte allo stesso admin: anomalia accanto a `da_verificare`, `verifica_manuale` o `errore`; 00404 non identico fino a 3 notifiche; gruppo di una fattura con due avvisi | **Un fatto, un avviso.** L'anomalia viaggia dentro l'avviso della chiusura (`dati.anomalia`, `a_tutti_gli_admin`). Quelle viste fuori dalla chiusura si parcheggiano sulla voce e le consegna la chiusura, anche del bidello. La fine del gruppo si attacca all'avviso ancora in attesa. `fattura_scartata` del 00404 non identico va solo a coordinator e segreteria, meno chi ha accodato | S44-S46, §7.2, §7.5, §8.2-§8.6, §9.2, §9.3, §11.5, §14, §17 |
| 2 | `VoceInElenco` ha due forme (D4 e D5) | Forma unica in `api-contratto.ts`: chiavi coi nomi delle colonne; `invii_aperti[]` e `fatture[]` con `numero_leggibile`; `fatture[].scartata` dal server; `azioni.ritrasmetti` esteso alle emesse con fattura scartata | S47, §12 |
| 3 | Il limite dei 12 giorni non ha una fonte per le letture | Campo additivo `invii_oltre_limite` in `fatture_coda_stato_pagamenti`, chiamata dalla GET della coda. Nessuna RPC nuova (restano 32), nessun ripiego in TS | S48, §9.5, §12, §17 |
| 4 | Il bidello in 3 passi lascia bloccata una voce di emissione con un `incerta` o un `caricata` | Bidello in 5 rami, con gli stessi esiti di §10.11 | S49, §9.2, §10.11, §17.1 |
| 5 | `p_invio` e `riga_registro` senza forma, e nessun test sul documento vero | Chiavi fissate; `importo` = `<ImportoTotaleDocumento>`; controlli SQL sull'XML; test ponte col vero `emettiFatturaPagamento` e la vera RPC su PGlite | S50, §7.3, §9.2, §10.4, §13, §17.6 |
| 6 | Ogni pagamento `scartata` entra come ritrasmissione, cioè in testa | `ritrasmissione` solo con una riga di registro in stato di scarto SdI. Col giornale, `scartata` solo per uno scarto di merito | S51, §6, §9.4, §10.4, §17.1 |

### 0.3 Passo 4 di `ship-cycle.md` (C0 m8)

Il passo 4 di `.claude/commands/ship-cycle.md:348-352` [V] prescrive ancora `apply_migration` dopo il merge. Per PR-D1, PR-A e PR-B **non si esegue** (regola 3 di §0, decisione 25). Nessun componente modifica quel file: il contrasto va segnalato al titolare, che decide.

---

## 1. Fatti verificati che decidono le scelte

| # | Fatto | Fonte |
|---|---|---|
| F1 | Le migrazioni in PR le applica l'integrazione Supabase al merge su `main`: il check «Supabase Preview» dà success ~30-40 s dopo il merge; `migrate.yml` viene annullato o non fa nulla | D1 §1.6, D6 F1 [V]; decisione 25 |
| F2 | Produzione, 23/09: ultima migrazione `20260920124744`; `fatture_emesse` 425 righe; 6 pagamenti «partiti ma non registrati»; 0 righe «Trasporto fallito» (`sdi_stato` e `aruba_filename` nulli) | SELECT aggregata [V] |
| F3 | `cron.job`: `video-retention` gira a `3,13,23,33,43,53 * * * *`, quindi le 03:43 non sono libere. (C0 m8) **Correzione:** i minuti `2,7,…,57` **non** sono tutti liberi da job HTTP: `scadenze-documenti-personale` (`47 5 * * *`, HTTP) cade su un minuto del tick [V, `cron.job` del 23/09, R9 di D2]; a `:27` c'è `iscrizioni-retention-esito`, solo SQL. Alle 05:47 il tick e quel job si sovrappongono: il tick non ne dipende [D]. Le 03:49 sono libere. `fatture-sdi-sync` gira `*/30` | `select jobname, schedule from cron.job` [V] |
| F4 | Istante delle fotografie: migrazioni-applicate 19/09 21:18:45Z · pg-policies 18/09 11:29:51Z · indici-unici 17/09 17:44:55Z · fk-utenti 20/09 00:07:19Z · fk-scuola-id 16/09 12:01:51Z · tabelle-scuola-id 01/09 17:32:09Z | `__tests__/fixtures/*.json` [V] |
| F5 | Sul file schema della coda scattano tre guardie di freschezza: `rls-per-sede.test.ts:318`, `onconflict-arbitro.test.ts:408`, `tracce-docente-dichiarate.test.ts:153` (via `posterioriCheContengono`, `soglia-fotografia.ts:109`). `fk-scuola-id` e `insegnanti-template` no. `migrazioni-complete` accetta i file posteriori alla fotografia e boccia un file anteriore allo scatto e non applicato (`:244-275`) | [V] |
| F6 | `cron-sorvegliato-e-applicato` guarda solo i nomi in `JOB_CRON` (`:86-132`). `health.test.ts:623-660` vuole, per ogni nome di `JOB_CRON`, un `const JOB = '<nome>'` in una route oppure `'cron:<nome>'` in un SQL | [V] |
| F7 | `/api/health`: esiti ok, degradato, giu; `giu` esce da `db-lettura` (`controlli.ts:58-59`) **e anche da `schema-atteso`** (`controlli.ts:504-525` [V], C0 m8). Il battito vale solo con esito ok o ok-parziale, livello info o warn, ambiente corrente (`:568, :604-612`). Un job di `JOB_CRON` senza battito dà `degradato` (`:657-660`). Le righe scritte dall'SQL hanno `ambiente='production'` di default (`20260804103151…:77-79`) | [V] |
| F8 | `isNotificaAbilitata` senza `scuolaId` risponde `true` senza leggere gli interruttori (`config.ts:31-36`); la sync oggi passa `scuolaId` (`sync/route.ts:892-906`) | [V] |
| F9 | In chiaro nei log restano solo `tipo, stato, esito, azione, operazione, canale, error_code, anno, periodo…` (`redact.ts:250-256`); uuid e istanti ISO passano per forma (`:588-608`); `motivo`, `origine` e `titolare` no | [V] |
| F10 | `EVENTI_PERSISTITI` contiene `fattura` e `cron`, non `notifica` (`logger.ts:188-190`) | [V] |
| F11 | La sync lavora solo righe con `aruba_filename`; `arubaGetByFilename` oggi chiede `includeFile:'false'` (`client.ts:761-777`) | [V] |
| F12 | `findByUsername` dà per documento `filename`, `idSdi`, `invoices[]{number, invoiceDate, status}` e `receiver`. Nel nostro XML il destinatario sta in `CessionarioCommittente/DatiAnagrafici/CodiceFiscale`; seguono `Data`, `Numero`, `ImportoTotaleDocumento` (`fatturapa-xml.ts:570, 584-587`). I tag ASCII restano leggibili dentro un `.p7m` (`stato.ts:519-521`) | [V] |
| F13 | Il motore della fatturazione ha 4 toni (`fatturazione-riga.ts:76`) e due bidoni che li partizionano (`:182-183`), come prova `riconciliazione-ui.test.ts:659-685` | [V] |
| F14 | La proposta d'intestatario dal bonifico non parte mai senza la spunta (`LottoFatturePanel.tsx:363-376, 753-759, 869-890`) | [V] |
| F15 | `utenti.role` è una colonna generata da `ruolo` | `.claude/rules/route-api.md` [V] |
| F16 | Una `.rpc('…'` letterale in una route passa il lock di isolamento se fra gli argomenti compare `scuola` (`isolamento-sede-coverage.test.ts:887-900`); `pagamenti/fattura/sync:POST` è già in `AMMESSE` (`:1281`) | [V] |
| F17 | Next 16: `after()` gira fino a `maxDuration` della route, anche se la risposta è fallita | `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` [V] |
| F18 | `@electric-sql/pglite` 0.5.8 è fra le devDependencies; il modello è `__tests__/lib/video-job-next.test.ts` | [V] |
| F19 | `enqueueNotifiche` restituisce `Promise<void>`: se l'INSERT fallisce scrive solo un log. Un INSERT per chiamata, una riga per destinatario (`utente_id, tipo, titolo, corpo, link, entita_tipo, entita_id, invio_programmato_il`); `scuolaId` facoltativo, `bufferMin` di default 0 | `src/lib/push/enqueue.ts:23-115` [V] |
| F20 | `TONI_DA_FARE = {da_fatturare, scartata}`; `daFatturareInListaDiLavoro` = confermato + pagato + da fare | `fatturazione-riga.ts:183, 250-252` [V] |
| F21 | `cron_config(p_nome text) RETURNS text` (Vault, poi GUC). L'origine si ricava come in `video_runner_tick_http`: primo URL configurato, poi `substring(… FROM '^https?://[^/]+')`. Esiste la chiave `app.fattura_sync_url` | `20260712220000_cron_config_vault.sql:24-45`; `20260918120000_video_runner_tick.sql:84-99`; `20260911113000…:43` [V] |
| F22 | `requireStaff(request: Request, allowed = ['admin','coordinator','segreteria'])`; il ruolo dell'`AppUser` è `role` oppure `ruolo` | `require-staff.ts:750-753, 343` [V] |
| F23 | In `src/` il modulo `src/lib/aruba/client.ts` lo importano solo `emissione.ts` (import relativo `./client`, `:53`) e `sync/route.ts`. Fuori da `src/` lo importano `scripts/collaudo/aruba-pagina-grande.collaudo.ts`, `fattura-singola.collaudo.ts`, `numerazione-aruba.collaudo.ts`. Chiamano Aruba direttamente `scripts/aruba-campioni.mjs`, `scripts/aruba-forma-elenco.mjs`, `scripts/aruba-prova-collegamento.mjs`, `scripts/collaudo/upload-dryrun.mjs` | grep [V] |
| F24 | Il lock intestatario ammette come chiamanti di `intestatarioAutomaticoDelLotto` solo `lotto-fatture.ts` e `LottoFatturePanel.tsx`, e di `propostaBloccataDaiDati` solo il pannello | `intestatario-fattura-un-motore-solo.test.ts:306-330` [V] |
| F25 | `tasso-errore` conta le impronte con `livello='error'` dell'ambiente negli ultimi 15', soglia 5: ogni valore di `distingui` è un'impronta in più | `controlli.ts:351, 687-715` [V] |
| F26 | La sync rilegge le righe con `sdi_stato IN (0,1,3,5)` e nome file, al massimo 30 per giro; una riga non aggiornata torna al giro dopo | `sync/route.ts:49, 97, 287-295` [V] |
| F27 | `findByUsername` ha già risposto 429 il 2026-09-02 | `client.ts:1289-1291` [V] |
| F28 | I log TS vanno in `app_log` con `createLogClient()` + `app_log_registra` dentro `after()`. I controlli di salute girano in parallelo in `eseguiControlli`, ognuno col tetto di `misura()` | `src/lib/logging/app-log.ts`; `controlli.ts:443, 842-858` [V] |
| F29 | Il WORM di `fatture_emesse` lascia modificabili `aruba_filename`, `sdi_stato`, `sdi_stato_label`, `sdi_scarto_motivo`, `inviata_il`, `aggiornata_il`, `pdf_path` | `20260809235620…:180-201` [V] |
| F30 | In Postgres `NOT (NULL > x AND NULL > y)` vale NULL: un `UPDATE … WHERE` con quella condizione non tocca la riga. Con `COALESCE(…, '-infinity')` vale `true` | `supabase db query --linked` su espressioni costanti [V] |
| F31 | Trasmettere allo SdI oltre 12 giorni dalla data del documento rende la fattura tardiva e sanzionabile (art. 21 c.4 DPR 633/72; Circ. 14/E par. 3.1) | `s_web-vincoli-fiscali.txt:4, 12` [V, fonte documentale] |
| F32 | Test esistenti che la coda rompe: `MovimentoDialog.test.tsx` (`:57`, `:334`), `errore-server-tradotto-cockpit.test.tsx` (`:156-186`), `riconciliazione-a11y-css.test.ts` (`:359-360`), `gdpr-esegui.test.ts` (il finto `makeFake` non ha `rpc`, `:98`). Montano o stubbano `FatturaButton` o `fetch` anche i test di interfaccia elencati per D5 in `proprieta_file` | grep [V] |
| F33 | `GET /api/pagamenti/riconciliazione` oggi non chiama `.rpc(`; i finti dei suoi 5 test non hanno `rpc` | grep [V] |
| F34 (v4) | 11 pagamenti `scartata`, tutti `pagato`: 7 con una riga in `sdi_stato ∈ (2,4,9)`, **4 senza alcuna riga a registro**, 0 con righe ma senza scarto. Oggi ogni emissione senza quote riuscite scrive `scartata`, qualunque sia il motivo (`emissione.ts:2553-2560`); lo scarto di merito di Aruba scrive la riga `sdi_stato=2` «Errore upload» (`:2440-2443`) | SELECT aggregata 23/09 [V] |
| F35 (v4) | Gli stati di scarto SdI sono 2, 4, 9, derivati da `mapStatoAruba(c).isScarto` | `sync/route.ts:144-161` [V] |
| F36 (v4) | `baseRow` = `pagamento_id, scuola_id, numero, sezionale, anno, progressivo_invio, causale, importo` (lordo della quota), `intestatario, xml_inviato, creato_da, quota_adult_id, quota_label, parent_registry_id, modalita_emissione, bollo_virtuale`. La riga a registro aggiunge `aruba_filename, sdi_stato, sdi_stato_label, inviata_il` | `emissione.ts:2282-2303, 2480` [V] |
| F37 (v4) | `<ImportoTotaleDocumento>` = round2(imponibile + imposta), con l'imponibile scorporato e arrotondato: con IVA > 0 può differire di un centesimo dal lordo incassato (10,01 € al 22% dà 10,00). `<Numero>` = `formattaNumeroFattura`: «Asilo 2328/2026», «FPR 1947/26». `<ProgressivoInvio>` = A oppure F, anno a 2 cifre, numero a 6 cifre. `<Data>` = `oggiFiscaleISO()` all'inizio dell'emissione | `fatturapa-xml.ts:485-492, 548, 584-587`; `emissione.ts:331-334, 977, 2001-2003`; `sezionale.ts:584-603` [V] |
| F38 (v4) | 11 pagamenti hanno più di una riga a registro (al massimo 4): una voce può avere più invii e più fatture | SELECT aggregata 23/09 [V] |
| F39 (v4) | `fatture_emesse` non ha una colonna con la data del documento: la data sta solo in `<Data>` dell'XML | `information_schema.columns` [V] |
| F40 (v4) | `numeroLeggibile` dà il numero stampato sul documento (via `formattaNumeroFattura`, `null` fuori scala); `etichettaFattura` nomina una riga con l'anno a 4 cifre e non va unita all'altra; `fatturaViva` = riga non in stato di scarto | `riconciliazione/route.ts:981-990`; `fattura-viva.ts:83-84, 95-110` [V] |
| F41 (v4) | La sync avvisa lo scarto con `fattura_scartata` a `staffScuola(…, ['admin','coordinator','segreteria'])`, con `scuolaId`; firma `staffScuola(supabase, scuolaId, ruoli)` | `sync/route.ts:877, 892-906`; `src/lib/notifiche/destinatari.ts:204-208` [V] |
| F42 (v4) | `aggregaFatturaStato` prende per ogni quota la riga di numero più alto e dà `scartata` se una è di scarto | `src/lib/aruba/stato.ts:1187-1199` [V] |

---

## 2. Le scelte fra le divergenze

| # | Punto | Scelta unica | Perché |
|---|---|---|---|
| S1 | Stati | Vocabolario di D2 giro 2 (§5). «Già emessa» = `emessa` con `esito_codice='gia_a_registro'` | SQL, lock e PGlite sono scritti su questo |
| S2 | RPC | L'insieme di D2 (§9) più `fatture_coda_invio_ricerca`; `fatture_coda_segnala_scarto_sdi` con `p_doppione` (4 valori). **32 RPC** | Il cancello fa già tutto con `prenota` ed `esito` |
| S3 | Quota | `aruba_tentativi`, sotto il lock di `aruba_cancello` | Un solo cancello nel DB (APPROCCIO) |
| S4 | Forma dei codici | Rifiuti RPC `MAIUSCOLO_SNAKE`; valori in DB `snake_case`; esiti dei log `kebab-case` | CHECK e `app_log` |
| S5 | Prova della ricerca | `fatture_coda_invio_ricerca(…, p_tentativi, p_esito)` per invio; `invio_tenta` pretende `ricerca_il > tentato_il` | L'indice annuale si costruisce una volta per giro |
| S6 | Documento ritrovato | 5 campi letti dal file scaricato (§11); l'SQL ricontrolla serie, numero, anno, importo e data | Decisione 15 |
| S7 | Terzo 429 | `consecutivi_429` per invio: +1 (tetto 3) su `http_429` di ogni tentativo legato all'invio (upload, pagine d'indice e download prenotati con `p_invio_id`). Si azzera **solo** con una risposta non-429 a un tentativo `upload` dell'invio, col passaggio a `caricata`, `registrata` o `rifiutata`, e con `richiedi_verifica`. Resta invariato su pagine e download riusciti, su `rete` e su `non_eseguito`. La conversione guarda la **somma** sugli invii aperti della voce, in ogni chiusura `riprova`, `rientro` o `resta` non concludente, anche del bidello | Decisione 16: dopo un 429 sull'upload la voce riparte «previa ricerca»; se la ricerca azzerasse il contatore, il terzo 429 non arriverebbe mai |
| S8 | 00404 (decisioni 29 e 15) | **Identico** (esattamente un candidato uguale sui 5 campi) → ricollegamento automatico. **Non identico provato** (indice completo, almeno un candidato, tutti letti, nessuno uguale) → scarto come oggi, pagamento `scartata`, voce `doppione_sdi`, «Da verificare». **Non risolto** (nessun candidato, un candidato illeggibile, indice incompleto, più candidati uguali) → nessuna scrittura su `fatture_emesse` né su `pagamenti`; la sync riprova; al 6° giro «Da verificare» `doppione_sdi_irrisolto` senza `scartata` | Solo un contenuto diverso letto prova che il documento consegnato è di altri |
| S9 | Notifiche | Un solo meccanismo: outbox `fatture_coda_avvisi` scritta in SQL → `spedisciAvvisiCoda()` → `enqueueNotifiche` senza `scuolaId`, `bufferMin: 0`, una notifica per avviso con destinatari uniti senza doppioni → rilettura di `notifiche` → conferma dei soli presenti. Errori aggregati in SQL per gruppo. Un fatto, un avviso (S44-S45) | F19: `enqueueNotifiche` non dice se ha scritto |
| S10 | Contratto HTTP | Quello di D4 in `api-contratto.ts` (§12) | Un solo proprietario |
| S11 | Coda non installata | Letture: 200 con `disponibile:false`. Scritture: 503 `CODA_FATTURE_NON_DISPONIBILE`. La riconciliazione degrada con **qualunque** errore della lettura della coda (F33) | La riconciliazione non si rompe per un dato accessorio |
| S12 | Proposta dal bonifico | Entra solo con `conferme_proposte[{pagamento_id, adult_id}]` uguale alla proposta ricalcolata dal server; altrimenti `proposta_da_confermare` | F14 |
| S13 | Tono `in_coda` | Nuovo tono dentro `TONI_FATTA`; bidone «Fatturate, in attesa o in coda» | Tiene la partizione di F13 |
| S14 | Stima | Una sola: `simulaInvii()` + `prossimoTick()` in `stima.ts` (D3), chiamata dal server | — |
| S15 | `rpc.ts` | Solo interprete; le route scrivono `supabase.rpc('fatture_coda_…', { p_scuola_ids, … })` in chiaro | F16 |
| S16 | Vocabolario dei log | Un solo modulo, `vocabolario-log.ts`. Battito con `tipo`, route **202**. Esiti attesi a `warn`; `error` solo per guasti veri, **mai** distinto per voce | Decisione 23, F25 |
| S17 | Attesa per `/api/health` | `in_attesa_dal` si azzera solo quando la voce entra in `{in_coda, in_invio}` da fuori (inserimento, `errore→in_coda`, `da_verificare→in_invio`); si legge con `fatture_coda_salute()` | Decisione 23 |
| S18 | Aruba finto | Uno solo: `__tests__/helpers/aruba-finto.ts` (stub di `fetch`). Nessun URL finto nel codice di produzione | Decisione 27 |
| S19 | E2E | Solo Playwright con risposte simulate delle API della coda | Decisione 27 |
| S20 | SQL vero | PGlite sui 3 file veri, orologio `_fatture_coda_adesso()`; test cardine su PGlite con route e lavoratore veri; test ponte del giornale (S50) | Decisioni 0 e 27 |
| S21 | Fotografie | PR-A: nessuna rigenerata, `MIGRAZIONI_ATTESE_AL_MERGE` per le tre guardie di F5, prova gemella. PR-B: rigenerazione delle 6 | Decisione 26 |
| S22 | Job | `fatture-coda-tick` `2,7,…,57 * * * *`; `fatture-coda-pulizia` `49 3 * * *`, eseguita una volta anche all'applicazione | F3 |
| S23 | `JOB_CRON` | Solo nella PR-B; nella PR-A nessuna voce in `JOB_CRON_NON_SORVEGLIATI` | F6 |
| S24 | Rilascio | Nessun gradino (decisione 28); lo STOP è «Sospendi coda» | — |
| S25 | Correzioni minori di D2 | `origine_iniziale`; `TRASPORTO_IN_SOSPESO`; gruppo inserito col numero richiesto e poi aggiornato; ogni RPC che scrive un invio blocca prima la voce; ruolo da `ruolo` (F15); azione azzerata uscendo dalla verifica | — |
| S26 | Segni di vita | `fatture_coda_stato.ultimo_giro_il`, scritto da ogni `aruba_cancello_prendi('coda', …)`, anche quando rifiuta | Striscia «nessun segno di vita» e farfalla della sveglia |
| S27 | D1 | Com'è, con tre ritocchi: l'aggregato non scrive `scartata` sugli stop di numerazione (col giornale vale S51); l'indagine riporta la prova git e deploy; `--allinea` considera `fatture_coda_invii` se esiste. Niente `migrate-ci` | — |
| S28 | Chiamate ad Aruba fuori dal cancello | Dopo il rilascio gli script che chiamano Aruba da fuori `src/` (quelli di D1, `scripts/aruba-*.mjs`, `scripts/collaudo/**`, F23) si lanciano solo a coda sospesa | Non passano dal cancello |
| S29 | «Numero assegnato» | La voce ha almeno un invio, in qualunque stato (anche `registrata`, `rifiutata`, `bruciata`): non si toglie (`NUMERO_GIA_ASSEGNATO`), non va in oblio, il suo pagamento non si cancella. «Documento costruito» = un invio aperto: da lì causale e intestatario non si toccano più | Decisione 11 alla lettera **(C0.2 D1)** Eccezione: una voce in `errore` con invii **tutti** `rifiutata` o `bruciata` si toglie; gli invii restano a giornale |
| S30 | `errore` con numero | `in_invio → errore` con invii aperti è ammesso solo con soli invii `numerata` e codice `guasto_ripetuto` o `oltre_12_giorni`. «Rimetti» riparte con lo stesso XML; oltre il limite serve la forza di un admin (S42) | Decisioni 17 e 15 senza voci bloccate |
| S31 | Ricerche e guasti che non concludono | `ESITI_RICERCA` comprende `ambigua`. `ricerche_fallite` sull'invio: 3 illeggibili → `ricerca_non_riuscita`. I codici non concludenti rinviano di 4' con effetto `ferma`. `prossima` salta le voci con `giro` = fence corrente. `ricerca_da_ripetere` si accetta solo dopo una `invio_ricerca(illeggibile)` registrata nella presa. Tetto di 3 guasti nostri su ogni lavoro | Decisioni 0 e 15: per ogni causa una voce ferma al più 3 giri |
| S32 | Sveglia | Salta solo con il cancello tenuto dalla coda; con coda sospesa, in pausa o a circuito aperto; con una sveglia già partita e il giro non ancora cominciato, da meno di 60 s. La farfalla usa `COALESCE(…, '-infinity')` su `ultima_sveglia_il` e `ultimo_giro_il` (F30). `aruba_cancello_rilascia` sveglia se nel prestito è entrato lavoro | Decisione 13 |
| S33 | Spaziatura accessi | 65 s fissi nell'SQL (`_fatture_coda_spaziatura_signin_ms()`), nessun parametro | APPROCCIO |
| S34 | Doppioni aperti | Bollino e vista contano `doppione_sdi` solo se il pagamento è ancora `scartata` e `pagato`; `doppione_sdi_irrisolto` solo se il pagamento è `pagato` | Decisione 21 senza bollino eterno **(C0.2 D2)** Il doppione non identico di un pagamento annullato o rimborsato esce da solo, con un evento `doppione_chiuso_pagamento_chiuso` (attore NULL) |
| S35 | Strato Aruba | `src/lib/aruba/**` non importa valori da `src/lib/fatture-coda/**`; è ammesso solo `import type { … } from '@/lib/fatture-coda/contratto-db'` | Nessuna dipendenza a runtime |
| S36 | Lock `aruba-solo-dal-cancello` | Guarda `src/**` (ts, tsx) dopo `senzaCommenti`, risolve gli import relativi e ha un controllo positivo | F23 |
| S37 | STOP d'urgenza | `fatture_coda_sospendi(NULL, '<motivo>')`: attore «sistema», motivo obbligatorio. La ripresa la fa un admin dalla pagina | Decisione 12 |
| S38 | Ritorno indietro | Prima «Sospendi coda», poi l'elenco degli invii aperti e delle voci da verificare, poi l'istruzione scritta di non riemetterli dalla vecchia strada, e solo dopo la promozione del deploy precedente | Evita doppie fatture |
| S39 | Salute | `controlloCodaFatture` importa `CODICI_SCHEMA_ASSENTE`; casi di test in §16 | Decisione 23 |
| S40 | Testi per codice | `CODICI_AVVISO_DA_VERIFICARE`, `CODICI_AVVISO_VERIFICA_MANUALE`, `MODO_DA_VERIFICARE` in `contratto-db.ts`; `testoAvviso` esaustivo per codice, per `dati.anomalia` e per `dati.fine_gruppo` | «Alle {ora} la cerca da sola» vale solo per 4 codici |
| S41 | Guasti nostri | Una sola tabella di destinazione (§10.11), usata dal lavoratore e, nei suoi 5 rami, dal bidello (S49). Il quarto guasto chiude sempre (conversione c) | Decisione 17 senza voci eterne in testa |
| S42 | 12 giorni su ogni trasmissione | Ogni passaggio di un invio a `in_volo`, e ogni prenotazione d'upload di reinvio, richiede `oggi − data_documento ≤ 12` oppure `tardiva_autorizzata_il` sull'invio. La regola sta in una funzione, `_fatture_coda_invio_oltre_limite`. L'autorizzazione è per documento: la scrivono solo `rimetti` e `richiedi_verifica('rimanda')` con la forza di un admin, una volta, e non si azzera | Decisione 15, F31 |
| S43 | File senza proprietario | Proprietari in §19; «chi rompe ripara»; misura dei test rossi a fine fase 2 | — |
| **S44** | **Un fatto, un avviso (v4)** | Un fatto = la transazione di una chiusura di voce (lavoratore o bidello) o di una segnalazione della sync. Per ogni fatto l'SQL scrive **al più un avviso per voce**, e la spedizione unisce i destinatari senza doppioni: ogni persona riceve al più una notifica per fatto. L'anomalia che accompagna la chiusura finale entra in `dati.anomalia` dell'avviso della chiusura, che prende `a_tutti_gli_admin`. Può essere intrinseca al codice (`registro_mancante`→`partita_non_registrata`, `numero_conteso`→`numerazione_anomala`, `guasto_ripetuto`→`guasti_ripetuti`) oppure da consegnare. Un `errore` con anomalia non si aggrega. Se la chiusura non scrive avvisi, l'anomalia scrive il suo avviso `anomalia` ai soli admin. Le anomalie viste fuori dalla transazione della chiusura (`numero_bruciato`; in TS `NUMERO_GIA_REGISTRATO`, `0034` su un numero nuovo, pavimento fuori scala, `doppia_emissione`) vanno in `anomalia_da_consegnare` della voce in mano e le consegna la chiusura, anche quella del bidello; senza voce in mano scrivono subito il loro avviso. Il 00404 non identico scrive un solo `da_verificare` con `dati.anomalia`. Evento e log `anomalia` restano sempre | Decisione 20: «un solo avviso per evento» e «admin in più: anomalie gravi e ogni Da verificare». Il parcheggio sopravvive alla morte del lavoratore, perché il bidello chiude comunque |
| **S45** | **Fine del gruppo (v4)** | Alla conclusione del gruppo, se c'è un avviso `errore`, `da_verificare` o `verifica_manuale` dello stesso gruppo per `creato_da` non ancora preso (`lease_token` e `inviato_il` nulli), il riepilogo va in `dati.fine_gruppo` del più recente e `gruppo_concluso` non nasce. Altrimenti nasce `gruppo_concluso` | Decisione 20 («fine del SUO gruppo, anche di una fattura» e «niente doppioni»): un gruppo di una fattura finito in errore o da verificare dà una notifica sola, e la fine del gruppo non si perde mai |
| **S46** | **`fattura_scartata` (v4)** | La sync la manda allo staff della sede (`staffScuola`) meno chi ha accodato. Con `p_doppione='non_identico'`, anche per le fatture nate fuori dalla coda, solo a `coordinator` e `segreteria`, perché gli admin ricevono già il `da_verificare`. Interruttore di sede invariato | F41; richiesta 9 di D3 |
| **S47** | **`VoceInElenco` (v4)** | Una forma sola (§12): chiavi coi nomi delle colonne; `invii_aperti[]` e `fatture[]` perché una voce di un pagamento a più quote ha un invio per quota (F38); `numero` intero più `numero_leggibile` calcolato con `numeroLeggibile` (F40); `fatture[].scartata` e `data_documento` calcolati dal server; i comandi solo da `azioni`, con `ritrasmetti` esteso alle emesse con fattura scartata | Rilievo 2: D5 non ricalcola niente e importa i tipi |
| **S48** | **12 giorni nelle letture (v4)** | `fatture_coda_stato_pagamenti` restituisce per ogni voce attiva `invii_oltre_limite`. La GET della coda la chiama per i pagamenti della pagina; `invii_aperti[].oltre_12_giorni`, `rimetti_serve_forza` e `rimanda_serve_forza` vengono solo da lì. Nessuna RPC nuova, nessun ripiego in TS | Un `trasporto_ignoto` invecchiato a 13 giorni deve chiedere la forza anche se il suo codice non lo dice |
| **S49** | **Bidello a 5 rami (v4)** | Gli stessi esiti di §10.11: `in_volo` → P; emissione o reinvio con un `incerta` → `gia_ricevuta_0034` o `prestito_scaduto` (P); con un `caricata` → `registro_mancante` (R); verifica con `incerta` o `caricata` → `resta` non concludente; altrimenti `rientro` | Senza i due rami centrali la voce restava `in_invio` per sempre (`INVII_INCOERENTI`), e dopo 24 h la salute andava degradata |
| **S50** | **Documento del giornale (v4)** | `p_invio` con 10 chiavi fisse (`InvioDaRegistrare`), `importo` = `<ImportoTotaleDocumento>`. L'SQL controlla sull'XML progressivo, `<Numero>`, `<Data>`, `<ImportoTotaleDocumento>`, `<TipoDocumento>`. `riga_registro` = `baseRow` senza `xml_inviato`, con chiavi esattamente `CHIAVI_RIGA_REGISTRO`. Test ponte col vero `emettiFatturaPagamento` e la vera RPC su PGlite | F36, F37. Senza il test ponte la prima prova sarebbe la produzione, con un numero bruciato a ogni tentativo (decisione 28) |
| **S51** | **Motivo della voce (v4)** | `ritrasmissione` solo se il pagamento ha una riga `fatture_emesse` con `sdi_stato ∈ STATI_SDI_SCARTO`; altrimenti `prima_emissione`. Col giornale l'aggregato del pagamento scrive `scartata` solo per uno scarto di merito di Aruba (quota `rifiutata`, riga `sdi_stato=2`, compreso lo `0034` su un numero nuovo); ogni altra fermata lascia `fattura_stato` com'era | F34: 4 degli 11 `scartata` non hanno mai avuto un documento e scavalcherebbero gruppi più vecchi (decisione 2) |

---

## 3. Equivalenze (nome da non usare più → nome in vigore)

| Vecchio | In vigore |
|---|---|
| stati `errore_dato`, `gia_emessa`, `annullata`, `sostituita`, `in_attesa`, `inviata`, `rimossa` | `errore`; `emessa` + `gia_a_registro`; `tolta`; nessuno («Rimetti» riusa la voce); `in_coda`; `emessa`; `tolta` |
| tabelle `fatture_coda`, `fatture_coda_controllo`, `fatture_coda_giri` | `fatture_coda_voci`; `fatture_coda_stato` + `aruba_cancello`; nessuna (battito in `app_log`) |
| colonne `presa_per`, `tentativi_guasto`, `ricerca_automatica_il`, `ripetizioni_429`, `creato_da_ruolo`, `circuito_aperto_fino_a`, `azione_forzata` | `lavoro`, `rientri_guasto`, `verifica_dovuta_il` + `verifica_auto_esito`, `fatture_coda_invii.consecutivi_429`, `fatture_coda_gruppi.creato_ruolo`, `circuito_fino_a`, `fatture_coda_invii.tardiva_autorizzata_il` |
| `GIORNI_LIMITE_RIMANDA`, `_fatture_coda_giorni_rimanda()` | `GIORNI_LIMITE_TRASMISSIONE`, `_fatture_coda_giorni_limite_trasmissione()`, `_fatture_coda_invio_oltre_limite(data, autorizzata_il)` |
| `fatture_coda_prenota_invio`; `fatture_coda_prendi_verifica`; `aruba_cancello_signin/_ricerca/_apri_circuito` | `aruba_cancello_prenota(p_token,'upload',…)`; `fatture_coda_prossima` (lavoro `verifica`); `aruba_cancello_prenota('signin' o 'ricerca')` + `aruba_cancello_esito` |
| `p_spaziatura_signin_ms`, `SPAZIATURA_SIGNIN_MINIMA_MS=60000` | nessun parametro; `SPAZIATURA_SIGNIN_MS=65000` |
| `fatture_coda_prendi_avvisi`, `annulla`, `rimetti_in_coda`, `segna_urgente`, `imposta_causale`, `rimanda`, «È arrivata» | `fatture_coda_avvisi_prendi`/`_conferma`, `fatture_coda_togli`, `fatture_coda_rimetti`, `fatture_coda_urgente`, `fatture_coda_causale`, `fatture_coda_richiedi_verifica(…,'cerca' o 'rimanda')`; «È arrivata» non esiste |
| route `/annulla`, `/rimanda`, `/coda/lavora`, `GET /coda/contatore`, `GET /coda/stato-pagamenti` | `/coda/togli`, `/coda/verifica`, `/coda/giro`, `GET /coda?solo_riepilogo=1`, `POST /coda/situazione` |
| vista `fatture_coda_ordine`, `ordine.ts`, `confrontaVoci` | `_fatture_coda_in_ordine()` + `fatture_coda_posizioni` |
| job `fatture-coda-retention`, `fatture-coda-giro` | `fatture-coda-pulizia`, `fatture-coda-tick` |
| `contratto-api.ts`, `codici-esito.ts` | `api-contratto.ts`; `vocabolario-log.ts` + `CODICI_ESITO_VOCE` in `contratto-db.ts` |
| `stimaFineCoda`, `stimaOrariInvio`, `stimaRimanenteMs`; `classificaEsito`, `pausaIncerto`, `postiOrari({usati,fuoriGiornale})` | `simulaInvii`, `prossimoTick`; `classificaEmissione`/`classificaRisoluzione`, `pausaInCorso`, `postiOrari(usati, soglia)` |
| `notificaPausaAruba`, `notificaScartoCoda`, `notificaAnomalia`, `notificaSospensione`, `notificaAvvisiPresi`, `avvisaSospensioneCoda`, `avvisaAnomaliaAdmin`, `dedupAvviso`; aggregazione degli errori in TS | `spedisciAvvisiCoda` (+ `fatture_coda_segnala_anomalia` in SQL); avviso `errore` aggregato in SQL |
| `SEDE_DI_COLLAUDO`, `ARUBA_FINTO_URL`, `KV_ARUBA_FINTO_URL`, ambiente `'finto'`, `e2e/coda-fatture-server-vero.spec.ts` | non esistono |
| `intestatario_origine='operatore'`, `intestatario_da_proposta` | `'scelta_operatore'`, `conferme_proposte` |
| `TETTO_LOTTO`, `TETTO_ACCODAMENTO`, `TETTO_AZIONE_MULTIPLA`; `zCorpoIdsVoci`, `RispostaTogli`/`RispostaUrgente`, `RispostaCausale` | `TETTO_VOCI_PER_GESTO`; `zCorpoTogli`, `RispostaAzioneMultipla`, `RispostaCausaleGet`/`RispostaCausalePost` |
| D5 `contatori.urgenti`, `inviate_oggi`, `inviate_ultima_ora`; `VerdettoPrecontrollo.pronta`; `coda_disponibile`, `righe[id].in_coda`; `zCorpoCausale {modo, testo}` | `contatori.per_livello.urgenti`, `emesse_oggi`, `upload_ultima_ora`; `esito` fra pronta, da_confermare, da_sistemare; `disponibile`, `righe[id].coda`; `{voce_id, causale: string o null}` |
| `VoceInElenco.errore{…}`, `tipo_invio`, `causale_manuale_presente`, `tolta_il`/`tolta_da` | `esito{codice, messaggio, http, il}`, `motivo`, `causale_modo` + `causale_manuale`, `tolta{il, da_nome}` |
| **(v4)** `VoceInElenco.invio_aperto{…}` e `fattura{…}` singoli; `verifica{dovuta_il, esito_automatico, richiesta, richiesta_il, forzata}`; `fattura.numero` stringa | `invii_aperti[]`, `fatture[]` (§12); `verifica{dovuta_il, auto_esito, azione_richiesta, azione_richiesta_il, azione_richiesta_da}`; `numero` intero + `numero_leggibile` |
| **(v4)** RPC `fatture_coda_invii_limite`; ripiego su `esito_codice === 'oltre_12_giorni'` | campo `invii_oltre_limite` di `fatture_coda_stato_pagamenti`; nessun ripiego |
| **(v4)** avviso `anomalia` accanto all'avviso della voce; `gruppo_concluso` accanto a un avviso in attesa dello stesso gruppo | `dati.anomalia`; `dati.fine_gruppo` |
| **(v4)** `DocumentoNumerato` di D3; `riga_registro` = `baseRow` intero; `importo` dell'invio = lordo della quota | `InvioDaRegistrare` di `contratto-db.ts`; `baseRow` senza `xml_inviato`; `importo` = `<ImportoTotaleDocumento>` |
| **(v4)** `motivo='ritrasmissione'` per ogni pagamento `scartata` | solo con una riga di scarto SdI a registro (S51) |
| `ricerca_non_riuscita` non concludente (v1); conversione del 429 in `invio_esito` (v1); azzeramento su ogni risposta non-429 (v2); `rientro` solo da emissione e reinvio (v2); bidello `riprova cancello_perso` (v2); bidello a 3 rami (v3) | `ricerca_da_ripetere`, con `ricerca_non_riuscita` concludente; conteggio in `aruba_cancello_esito` e azzeramento solo su upload; `rientro` da ogni lavoro; `rientro prestito_scaduto_senza_tentativo`; bidello a 5 rami |
| `p_doppione` `'da_verificare'`; esito `doppione-00404-da-verificare`; `riallinea00404` che dà `'ricollegata'` o `'da_verificare'` | `p_doppione` fra `ricollegato`, `non_identico`, `non_risolto`; esiti `doppione-00404-non-identico` e `doppione-00404-non-risolto`; `{esito: ricollegata, non_identico o non_risolto}` |

---

## 4. Nomi e costanti comuni

- Cartella TS della coda: `src/lib/fatture-coda/`. Lo strato Aruba, `src/lib/aruba/`, non importa valori da `src/lib/fatture-coda/`: è ammesso solo `import type` da `@/lib/fatture-coda/contratto-db` (S35).
- Tabelle (8): `fatture_coda_gruppi`, `fatture_coda_voci`, `fatture_coda_invii`, `fatture_coda_eventi`, `fatture_coda_avvisi`, `fatture_coda_stato`, `aruba_cancello`, `aruba_tentativi`.
- Migrazioni: `supabase/migrations/<T1>_fatture_coda_schema.sql`, `<T1+60s>_fatture_coda_rpc.sql`, `<T1+120s>_fatture_coda_cron.sql`. T1 è l'istante UTC reale di scrittura, maggiore della version di D1 e di ogni `generato_alle` delle fotografie su `main` al merge. Se una fotografia viene rigenerata dopo, i file si rinominano prima del merge, mai con un istante futuro.
- Job pg_cron: `fatture-coda-tick`, `'2,7,12,17,22,27,32,37,42,47,52,57 * * * *'` tutti i giorni (decisione 18), che è anche la `const JOB` della route del giro, il nome in `JOB_CRON` e `campi.operazione` del battito; `fatture-coda-pulizia`, `'49 3 * * *'`, solo SQL, battito `'cron:fatture-coda-pulizia'`.
- Route del lavoratore: `POST /api/pagamenti/fattura/coda/giro`. Tick: `public.fatture_coda_tick_http()`. Sveglia: solo SQL, `public._fatture_coda_sveglia(p_motivo)`, motivi `accodamento`, `rimessa`, `verifica`, `ripresa`.
- Orologio SQL: ogni lettura dell'ora, default di colonna compresi, passa da `public._fatture_coda_adesso()` (VOLATILE, `= clock_timestamp()`). «Oggi» = `public._fatture_coda_oggi_fiscale()` (giorno Europe/Rome, decisione 14).
- URL del giro: `_fatture_coda_url_giro()` prende la prima chiave configurata fra `cron_config('app.fattura_sync_url')`, `app.push_dispatch_url`, `app.notifiche_promemoria_url` e `app.retention_iscrizioni_url` (F21), ne ricava l'origine come `video_runner_tick_http` e aggiunge `/api/pagamenti/fattura/coda/giro`, dentro `EXCEPTION`.
- **Costanti del DB** (funzioni IMMUTABLE nell'SQL, specchio in `contratto-db.ts`, confrontate dal lock):
  - `MINUTI_PAUSA_INCERTO=15`, `MINUTI_CIRCUITO_429=60`, `GIORNI_LIMITE_TRASMISSIONE=12`, `RIENTRI_GUASTO_MAX=3`, `MAX_429_CONSECUTIVI=3` (sulla somma della voce), `MAX_RICERCHE_FALLITE=3`, `MINUTI_RINVIO_VERIFICA=4`, `MAX_00404_NON_RISOLTI=6`, `MESI_CONSERVAZIONE=24`;
  - `SPAZIATURA_SIGNIN_MS=65000`, `LIMITE_ORA_MASSIMO_SQL=60`, `LIMITE_MINUTO_UPLOAD_MASSIMO=30`, `LIMITE_MINUTO_RICERCA_MASSIMO=12`, `PRESTITO_SECONDI_MIN=30`, `PRESTITO_SECONDI_MAX=900`, `MINUTI_RICHIESTA_SYNC=2`, `SECONDI_TETTO_SVEGLIA=60`;
  - `ORE_ALLARME_ATTESA=24`, `ORE_ALLARME_SOSPESA=24`, `TETTO_VOCI_PER_GESTO=500`, `MAX_CAUSALE_MANUALE=1000`, `MAX_MOTIVO_SOSPENSIONE=200`;
  - **(v4)** `STATI_SDI_SCARTO = [2, 4, 9]` (`_fatture_coda_stati_scarto_sdi()` restituisce `int[]`; il lock lo confronta anche con `mapStatoAruba(c).isScarto` per c da 0 a 20, F35); `CHIAVI_RIGA_REGISTRO` (15 chiavi, §7.3); `MAX_RIGA_REGISTRO_BYTES=32768`;
  - `JOB_TICK_CODA`, `JOB_PULIZIA_CODA`, `CRON_TICK_CODA`, `CRON_PULIZIA_CODA`, `PERCORSO_GIRO_CODA`.
- **Costanti di ritmo del lavoratore** (`ritmo.ts`, D3): `SOGLIA_ORARIA_APP=50`, riesportata da `src/lib/pagamenti/tetto-orario-aruba.ts:51` e passata sempre come `p_limite_ora` (decisione 5); `SPAZIATURA_SIGNIN_MS` riesportata da `contratto-db.ts`; `LIMITE_RICERCHE_MINUTO=11`, `TETTO_UPLOAD_MINUTO=20`, `PAUSA_FRA_UPLOAD_MS=2500`, `MASSIMO_UPLOAD_PER_GIRO=15`, `MASSIMO_VOCI_PER_GIRO=40`, `MASSIMO_CANDIDATI_PER_INVIO=3`, `DURATA_PRESTITO_S=330`, `MAX_DURATION_GIRO_S=300`, `CADENZA_TICK_MS=300000`.

---

## 5. Stati e transizioni

### 5.1 Voce (`fatture_coda_voci.stato`) — sei stati

| Da → A | Chi | RPC | Condizione |
|---|---|---|---|
| — → `in_coda` | staff | `fatture_coda_accoda` | Pre-controllo TS di D4 superato; l'SQL rivalida pagato, sede, partita non registrata, trasporto in sospeso, tipo TD01 |
| `in_coda` → `in_invio` | lavoratore | `fatture_coda_prossima` | lavoro `emissione` o `reinvio`; `giro` della voce ≠ fence corrente |
| `in_coda` → `tolta` | staff | `fatture_coda_togli` | nessun invio (S29) |
| `in_invio` → `emessa` | lavoratore | `chiudi('emessa')` | l'ultimo invio di ogni quota del giornale è `registrata`, oppure nessun invio e codice `gia_a_registro`; il lavoratore chiude `emessa` solo dopo il completamento delle quote (§10.7) |
| `in_invio` → `errore` | lavoratore, bidello | `chiudi('errore')`; conversione c | nessun invio aperto; eccezione S30: `guasto_ripetuto` o `oltre_12_giorni` con soli invii aperti `numerata` |
| `in_invio` → `da_verificare` | lavoratore, bidello | `chiudi('da_verificare')` da ogni lavoro; `chiudi('resta_da_verificare')` solo dal lavoro `verifica`; conversioni a, b, c | dopo le conversioni e l'effetto di `oltre_12_giorni`: almeno un invio `incerta` o `caricata`, nessuno `in_volo` |
| `in_invio` → `in_coda` | lavoratore, bidello | `chiudi('riprova')`, `chiudi('rientro')`, da ogni lavoro | dopo le conversioni, nessun invio `in_volo`, `caricata` o `incerta` (ammessi `numerata` e `da_ritentare`). `riprova` = causa esterna, non conta; `rientro` = guasto nostro (decisione 17), conta in `rientri_guasto` |
| `da_verificare` → `in_invio` | lavoratore | `fatture_coda_prossima` (lavoro `verifica`) | azione richiesta, oppure verifica dovuta (`verifica_auto_esito` nullo e `verifica_dovuta_il ≤ adesso`), oppure invio `caricata`; `giro` ≠ fence |
| `errore` → `in_coda` | staff | `fatture_coda_rimetti` | nuovo gruppo `rimessa_in_coda`, in fondo o urgente; pagamento ancora `pagato`; un `numerata` oltre il limite senza autorizzazione → `OLTRE_12_GIORNI`, salvo la forza di un admin, che scrive `tardiva_autorizzata_il` (S42) |
| `errore` → `tolta` | staff | `fatture_coda_togli` | nessun invio, **oppure** invii tutti `rifiutata`/`bruciata` (C0.2 D1) |
| `emessa`, `tolta` | — | — | terminali |

Qualunque altra coppia dà `23514` dal trigger `_fatture_coda_voci_guardia`, che vieta anche `→ tolta` quando la voce ha un invio, salvo `errore → tolta` con invii tutti `rifiutata`/`bruciata` (C0.2 D1, C0.5 n. 3).

**Insiemi.** Attivi (un solo attivo per pagamento e tipo): `in_coda, in_invio, da_verificare, errore`. In attesa (misura di salute): `in_coda, in_invio`. Terminali: `emessa, tolta`. L'accodamento non tocca mai `pagamenti.fattura_stato`.

**Regole trasversali**
- `in_attesa_dal := _fatture_coda_adesso()` quando la voce entra in `{in_coda, in_invio}` da fuori: inserimento, `errore→in_coda`, `da_verificare→in_invio`. I passaggi `in_coda↔in_invio` non lo toccano.
- `urgente` cambia solo in `in_coda`, oppure nella rimessa.
- Causale e intestatario si ritoccano solo in `in_coda` o `errore` senza documento costruito (nessun invio aperto). Alla chiusura (`emessa`, `tolta`) si azzerano (minimizzazione, decisione 19).
- `azione_richiesta*` si azzerano in ogni uscita dal lavoro `verifica`, salvo le chiusure non concludenti (§8.2).
- **Numero assegnato** (S29): almeno un invio in qualunque stato. Non si toglie (eccezione C0.2 D1: voce `errore` con invii tutti `rifiutata`/`bruciata`), non va in oblio, il pagamento non si cancella (`55006`).
- `giro` (= fence della presa) resta sulla voce dopo la chiusura: `prossima` non riprende nello stesso giro una voce già trattata.
- **Contatori.** `richiedi_verifica` azzera `rientri_guasto` della voce e, sugli invii aperti, `ricerche_fallite` e `consecutivi_429`. `rimetti` azzera `rientri_guasto`.
- **Regola dei 12 giorni** (S42): ogni passaggio di un invio a `in_volo` richiede `oggi − data_documento ≤ 12` oppure `tardiva_autorizzata_il`.
- **(v4) Anomalia da consegnare** (S44): `anomalia_da_consegnare` vale solo in `in_invio`. La scrivono `fatture_coda_numero_bruciato` e `fatture_coda_segnala_anomalia` con la voce in mano (se è già piena, la nuova anomalia va solo in eventi e log). La consuma e la azzera ogni chiusura, anche del bidello.
- **Una voce `emessa` resta terminale.** Cambia solo il suo `esito_codice`, e solo così (trigger): dai codici di chiusura `emessa` e da `sdi_ricollegata` → `doppione_sdi`, `doppione_sdi_irrisolto` o `sdi_ricollegata`; da `doppione_sdi_irrisolto` → `doppione_sdi` o `sdi_ricollegata`; da `doppione_sdi` → `doppione_sdi_ritrasmesso`.

**Conversioni automatiche** (in `_fatture_coda_chiudi_voce`, quindi anche per il bidello). Si applicano prima dei controlli sugli invii; scatta la prima che si applica, nell'ordine a, b, c; la risposta porta `forzato:true` e `codice_finale`.
- **a. Terzo 429.** Chiusure `riprova`, `rientro` o `resta_da_verificare` non concludente con la somma di `consecutivi_429` sugli invii aperti della voce ≥ 3: gli invii `da_ritentare` diventano `incerta aruba_429_ripetuto`; la voce va `da_verificare aruba_429_ripetuto`, concludente dal lavoro `verifica` (`verifica_auto_esito='non_trovata'`, avviso `verifica_manuale`), codice P dagli altri lavori.
- **b. Terza ricerca fallita.** Chiusura con `ricerca_da_ripetere` e un invio a `ricerche_fallite = 3`: dal lavoro `verifica` esito concludente `ricerca_non_riuscita`; dagli altri lavori `da_verificare ricerca_non_riuscita` (M).
- **c. Quarto guasto nostro.** `rientro`, e `resta_da_verificare` con `guasto_transitorio` o `prestito_scaduto_senza_tentativo`. Se `rientri_guasto < 3`, lo aumentano di 1. Se era già 3: gli invii `da_ritentare` diventano `incerta guasto_ripetuto`; poi, con un invio `incerta` o `caricata`, la voce va (o resta) `da_verificare guasto_ripetuto` con `verifica_auto_esito='non_trovata'` (M, avviso `verifica_manuale`); altrimenti va `errore guasto_ripetuto`. Sempre anomalia `guasti_ripetuti` dentro l'avviso (S44) ed effetto `ferma`.

**Effetti propri di un codice** (controllati prima delle conversioni):
- `ricerca_da_ripetere`, con `riprova` o con `resta_da_verificare`, si accetta solo se un invio aperto ha `ricerca_esito='illeggibile'` con `ricerca_il ≥ presa_il`; altrimenti `RICERCA_MANCANTE`.
- `numero_conteso` (C0.5 n. 1): solo con `errore`; richiede un invio `bruciata` con `esito_codice='numero_conteso'` che sia l'ultimo della sua quota, e nessun invio aperto; con `da_verificare` o `resta_da_verificare`, o senza quell'invio, `BAD_INPUT`. Una voce con una quota così non può chiudere `emessa` (l'ultimo invio della quota non è `registrata`: `INVII_INCOERENTI`).
- `oltre_12_giorni`: con `errore` richiede un invio `numerata` oltre il limite senza autorizzazione; con `da_verificare` porta prima a `incerta oltre_12_giorni` gli invii `da_ritentare` oltre il limite senza autorizzazione, e ne richiede almeno uno; con `resta_da_verificare` richiede un invio non caricato oltre il limite senza autorizzazione. Altrimenti `BAD_INPUT`.

### 5.2 Invio (`fatture_coda_invii.stato`) — il giornale per documento numerato

| Da → A | RPC | Condizione |
|---|---|---|
| — → `numerata` | `fatture_coda_invio_registra` | dopo numero e XML, prima dell'upload; forma di `p_invio` in §7.3 |
| — → `bruciata` | `fatture_coda_numero_bruciato` | numero preso, XML mai costruito o giornale che non l'ha accettato; `tentativi = 0`; `p_codice='numero_conteso'` → `BAD_INPUT` (C0.5 n. 1) |
| `da_ritentare` → `bruciata` | `invio_ricerca(non_combacia)` (C0.2 D3, C0.5 n. 1) | su Aruba c'è un documento **diverso** con lo stesso numero: `esito_codice='numero_conteso'`, `xml` e `riga_registro` a NULL, `consecutivi_429 := 0`, `tentativi` resta ≥ 1 (ammesso da `_tentativo_chk`, §7.3). Il numero resta nel giornale (`_numero_uidx`), la quota torna libera per un numero nuovo (`_quota_viva_uidx` esclude `bruciata`) |
| `incerta` → `bruciata` | `invio_ricerca(non_combacia)` (C0.2 D3, C0.5 n. 1) | come la riga sopra |
| `numerata` → `in_volo` | `fatture_coda_invio_tenta` | prenotazione `upload` del token, legata all'invio; regola dei 12 giorni |
| `in_volo` → `caricata`, `registrata`, `da_ritentare`, `incerta`, `rifiutata` | `fatture_coda_invio_esito` | `registrata` diretta se la riga di registro indicata ha lo stesso filename; `0034` con `tentativi ≥ 2` → `incerta gia_ricevuta_0034` |
| `in_volo` → `incerta` | `fatture_coda_bidello` | prestito scaduto a metà (`prestito_scaduto`) |
| `da_ritentare` → `in_volo` | `invio_tenta` | `ricerca_esito='assente'` con `ricerca_il > tentato_il`; regola dei 12 giorni |
| `da_ritentare` → `caricata` | `invio_ricerca(combacia)` | `p_trovato` uguale (serie, numero, anno, importo, data) |
| `da_ritentare` → `incerta` | `invio_ricerca`: `ambigua` → `ambigua_su_aruba` (`non_combacia` porta a `bruciata`, righe sopra); 3ª `illeggibile` → `ricerca_non_riuscita`. Chiusura, anche del bidello: conversione a → `aruba_429_ripetuto`; conversione c → `guasto_ripetuto`; `da_verificare oltre_12_giorni` → `oltre_12_giorni` | — |
| `incerta` → `in_volo` | `invio_tenta` | voce con `azione_richiesta='rimanda'`; `ricerca_esito='assente'` con `ricerca_il > tentato_il`; regola dei 12 giorni. (C0.5 n. 1: `non_combacia` non è più ammesso, perché porta l'invio a `bruciata`; nessun «Rimanda» su un numero conteso) |
| `incerta` → `caricata` | `invio_ricerca(combacia)` | come sopra |
| `caricata` → `registrata` | `fatture_coda_invio_registrato` | riga di `fatture_emesse` con stesso pagamento, serie, anno, numero e stesso `aruba_filename` |
| `registrata`, `rifiutata`, `bruciata` | — | terminali |

**Colonne che cambiano senza cambiare stato**
- `ricerca_il`, `ricerca_esito`, `ricerche_fallite`: le scrive `invio_ricerca`; `richiedi_verifica` azzera `ricerche_fallite`.
- `consecutivi_429` (S7): +1 e azzeramento da upload in `aruba_cancello_esito`; azzeramento al passaggio a `caricata`, `registrata`, `rifiutata`, `bruciata` nel trigger `_fatture_coda_invii_guardia`; azzeramento in `richiedi_verifica`. Nessun altro lo scrive.
- `tardiva_autorizzata_il` (S42): da NULL a un istante, una volta sola, da `rimetti` o `richiedi_verifica` con la forza di un admin; non si azzera mai.

**Aperti:** `numerata, in_volo, caricata, da_ritentare, incerta`. `xml` e `riga_registro` restano uguali oppure diventano NULL, e lo diventano a `registrata`, `rifiutata`, `bruciata`. Un numero compare una volta nel giornale; un solo invio vivo per voce e quota.

### 5.3 Gruppo
`concluso_il` si scrive una sola volta, quando il gruppo non ha più voci `in_coda` né `in_invio` con lavoro `emissione` o `reinvio`. Allora `_fatture_coda_aggiorna_gruppo` applica S45: riepilogo in `dati.fine_gruppo` dell'avviso ancora in attesa del gruppo per `creato_da`, oppure avviso `gruppo_concluso`, anche per una fattura sola.

---

## 6. Ordine della coda (decisioni 2 e 3)

Una funzione sola, `_fatture_coda_in_ordine()`, usata da `prossima`, `posizioni`, `riepilogo`, dal controllo «niente da fare» di `prendi` e dalla sveglia di `rilascia`.
- **Candidati:** voci `in_coda` e voci `da_verificare` pronte (§5.1).
- **Rango:** verifica pronta = 0. Per le altre vale `livello` (colonna generata): 0 `reinvio_pendente` (invio `numerata` o `da_ritentare`); 1 `motivo ≠ prima_emissione`; 2 `urgente`; 3 normale.
- **ORDER BY:** `rango`, poi (solo rango 3) `gruppi.seq`, poi `data_riferimento`, `gruppi.seq`, `ordine_selezione`, `id`.
- **Nessuno spostamento manuale**: nessuna RPC riordina; «Urgente» mette o toglie il livello 2.
- **`prossima`** scorre i candidati nell'ordine (al più 100) e salta quelli con `giro` = fence del cancello; la testa è il primo non saltato. Se la testa richiede un upload (`emissione`, `reinvio`, oppure `verifica` con `rimanda`) e la quota oraria è piena → `QUOTA_ORARIA`: non si salta avanti.
- `data_riferimento` = data Europe/Rome di `pagamenti.data_incasso`, altrimenti di `creato_il`, altrimenti oggi.
- **(v4) `motivo`** (S51): `ritrasmissione` se all'accodamento il pagamento ha almeno una riga `fatture_emesse` con `sdi_stato = ANY(_fatture_coda_stati_scarto_sdi())`; altrimenti `prima_emissione` (TD01). `nota_credito` resta per TD04, oggi rifiutato. Lo stato `scartata` del pagamento, da solo, non basta (F34).

---

## 7. Tabelle (file 1, proprietario D2)

**Regole comuni.** RLS `ENABLE` + `FORCE`, nessuna policy. `REVOKE ALL` da `PUBLIC, anon, authenticated, service_role`, poi `GRANT SELECT` a `service_role`. Si scrive solo dalle RPC (SECURITY DEFINER, owner `postgres`). Tempi da `_fatture_coda_adesso()`. `COMMENT ON TABLE` in italiano. I file 1 e 2 finiscono con `NOTIFY pgrst, 'reload schema';`. Testate «Stato: scritta il AAAA-MM-GG; la applica l'integrazione Supabase al merge della PR-A», mai «NON APPLICATA». I file 2 e 3 non contengono `unique`, `primary key`, `policy`, `row level security`, `drop table`, `references … utenti`, `add constraint`, `drop constraint`, né righe che iniziano con `scuola_id uuid`.

### 7.1 `fatture_coda_gruppi`
`id`; `seq` identity UNIQUE (FIFO); `richiesta_id` UNIQUE; `creato_da` → utenti (NO ACTION); `creato_ruolo` fra admin, coordinator, segreteria; `origine` fra riconciliazione, lista_pagamenti, periodo, scheda_alunno, singolo, rimessa_in_coda; `urgente`; `voci_accodate 1..500` (inserito col numero richiesto, poi aggiornato; con 0 accodate il gruppo si cancella); `periodo jsonb` (solo con origine `periodo`); `creato_il`; `concluso_il` (una volta). Nessuna `scuola_id`.

### 7.2 `fatture_coda_voci`

| Area | Colonne |
|---|---|
| Identità | `id`; `gruppo_id` (RESTRICT); `pagamento_id` (CASCADE, con guardia `55006` se `in_invio`/`da_verificare` o se ha un invio); `scuola_id NOT NULL` |
| Documento | `tipo_documento` fra TD01 e TD04; `fattura_rettificata_id` (solo TD04); `motivo` fra prima_emissione, ritrasmissione, nota_credito (§6); `origine_iniziale NOT NULL` (immutabile) |
| Ordine | `urgente`; `reinvio_pendente` (trigger sugli invii); `livello` GENERATED; `data_riferimento`; `ordine_selezione 0..100000` |
| Tempi | `accodata_il` (immutabile); `in_attesa_dal` (§5.1) |
| Causale | `causale_modo` fra invariata, manuale, composta; `causale_manuale 1..1000` solo con `manuale` |
| Intestatario | `intestatario_scelto jsonb`; `intestatario_origine` fra scelta_operatore e proposta_bonifico se e solo se c'è l'intestatario; `ricorda_scheda` solo con `persona` |
| Lavorazione | `stato`; `stato_dal`; `lavoro` fra emissione, reinvio, verifica (solo `in_invio`); `tentativi`; `rientri_guasto 0..3`; `giro bigint`; `lavoratore_token`; `prestito_scade_il`; `presa_il`; **(v4) `anomalia_da_consegnare jsonb`** = `{tipo, chiave, dati}` in forma sicura (`tipo` in `TIPI_ANOMALIA`, `chiave` `^[a-z0-9_:.+-]{1,120}$`), NULL fuori da `in_invio` (CHECK) |
| Verifica | `verifica_dovuta_il`; `verifica_auto_esito` fra NULL e non_trovata; `azione_richiesta` fra NULL, cerca, rimanda; `azione_richiesta_da` (SET NULL); `azione_richiesta_il` |
| Esito | `esito_codice` (`^[a-z0-9_:-]{1,80}$`, §8.2: il TIPO, visibile a tutte le sedi); `esito_messaggio ≤1000` (solo sede propria); `esito_http`; `esito_il` |
| Chiusura | `concluso_il` se e solo se `emessa`/`tolta`; `creato_il`; `aggiornato_il` |

Valgono i CHECK di D2 §4.2 (minimizzazione delle chiuse, `da_verificare ⇒ esito_codice e verifica_dovuta_il`, `errore ⇒ esito_codice`). Indice `fatture_coda_voci_una_attiva_uidx (pagamento_id, tipo_documento) WHERE stato IN ('in_coda','in_invio','da_verificare','errore')`: l'`ON CONFLICT` ripete la stessa `WHERE`. Indici di attesa, verifica, gruppo, sede, pagamento, prestito, `in_attesa_dal`, conclusione.

### 7.3 `fatture_coda_invii` — una riga per numero preso
- `id`; `voce_id` (RESTRICT); `pagamento_id` (RESTRICT); `scuola_id`; `quota_adult_id`; `quota_label ≤200`.
- `sezionale` fra Asilo e FPR; `anno` (= anno di `data_documento`); `numero ≥1`; `progressivo_invio`; `data_documento`; **`importo > 0` = `<ImportoTotaleDocumento>` dell'XML** (v4, F37); per `bruciata` il lordo della quota, perché l'XML non esiste.
- `xml` (100 B..512 KB); `riga_registro jsonb` (≤ `MAX_RIGA_REGISTRO_BYTES`).
- `stato`; `tentativi`; `primo_tentativo_il`; `tentato_il`. **(C0.5 n. 1)** `_tentativo_chk`: `(tentativi = 0) = (stato = 'numerata' OR (stato = 'bruciata' AND esito_codice IS DISTINCT FROM 'numero_conteso'))`, e `tentativi > 0 ⇒ tentato_il`: un `bruciata` da `numero_bruciato` ha 0 tentativi, un `bruciata numero_conteso` (da `invio_ricerca`) ne ha almeno 1.
- `consecutivi_429 smallint 0..3 DEFAULT 0`; `ricerche_fallite smallint 0..3 DEFAULT 0`; `ricerca_il`; `ricerca_esito` fra combacia, assente, non_combacia, ambigua, illeggibile (se e solo se c'è `ricerca_il`).
- `tardiva_autorizzata_il timestamptz` (NULL di default; S42). Chi l'ha autorizzata sta negli eventi `rimessa` o `verifica_richiesta`; niente FK a utenti.
- `esito_il`, `esito_http`, `esito_codice` (§8.3), `esito_dettaglio ≤2000` (solo sede propria).
- `aruba_filename` (immutabile una volta scritto; obbligatorio in `caricata`/`registrata`); `id_sdi`; `fattura_emessa_id` (UNIQUE parziale); `registrata_il`; `creato_il`; `aggiornato_il`.
- Unici: `(sezionale, anno, numero)`; `(voce_id, COALESCE(quota_adult_id, uuid nullo)) WHERE stato NOT IN ('rifiutata','bruciata')`; `fattura_emessa_id`. Immutabili: voce, pagamento, sede, quota, serie, anno, numero, progressivo, data, importo, `creato_il`.

**(v4) Forma di `p_invio` (S50).** `fatture_coda_invio_registra` accetta esattamente le chiavi `quota_adult_id, quota_label, sezionale, anno, numero, progressivo_invio, data_documento, importo, xml, riga_registro` (tipo TS `InvioDaRegistrare`). `fatture_coda_numero_bruciato` accetta le stesse senza `xml` e `riga_registro` (`NumeroBruciatoDaRegistrare`). Una chiave in più o in meno, o un controllo qui sotto non superato, → `BAD_INPUT{campo}`; i CHECK della tabella sono la difesa.
- `data_documento` fra oggi−1 e oggi; `anno` = anno di `data_documento`.
- `progressivo_invio` = `_fatture_coda_progressivo(sezionale, numero, anno)`: `A` (Asilo) o `F` (FPR), anno a 2 cifre, numero a 6 cifre, specchio di `progressivoInvioFattura` (`emissione.ts:331-334`).
- Sull'XML: `<ProgressivoInvio>` = `progressivo_invio`; `<Numero>` = `_fatture_coda_numero_documento(sezionale, numero, anno)`, specchio di `formattaNumeroFattura` («Asilo N/AAAA», «FPR N/AA»); `<Data>` = `data_documento`; `<ImportoTotaleDocumento>` = `importo`; `<TipoDocumento>` = `tipo_documento` della voce.
- `riga_registro`: chiavi **esattamente** `CHIAVI_RIGA_REGISTRO` = `pagamento_id, scuola_id, numero, sezionale, anno, progressivo_invio, causale, importo, intestatario, creato_da, quota_adult_id, quota_label, parent_registry_id, modalita_emissione, bollo_virtuale`, cioè `baseRow` di `emissione.ts` senza `xml_inviato` (F36). Vietate in particolare `xml_inviato` (sta in `xml`), `aruba_filename`, `inviata_il`, `sdi_stato`, `sdi_stato_label`, `sdi_scarto_motivo`, `pdf_path`, `id`. `pagamento_id, scuola_id, numero, sezionale, anno, progressivo_invio, quota_adult_id` uguali alle colonne dell'invio e della voce. `riga_registro.importo` è il lordo della quota, come oggi in `fatture_emesse.importo`, e non si confronta con `importo` dell'invio (F37).
- La riga di registro si scrive come `riga_registro ∪ {xml_inviato: xml, aruba_filename, sdi_stato: 1, sdi_stato_label: 'Presa in carico', inviata_il}`: in `emissione.ts` dopo l'upload riuscito e in `reinvio.ts` (`assicuraRigaRegistro`).

### 7.4 `fatture_coda_eventi` — traccia append-only
`id` identity; `voce_id` e `gruppo_id` (SET NULL); `pagamento_id` (senza FK); `scuola_id`; `azione` fra accodata, presa, chiusa, tolta, rimessa, urgenza, causale, verifica_richiesta, prestito_scaduto, rientro_guasto, sospesa, ripresa, circuito_aperto, pausa, anomalia, oblio, numero_bruciato, ricerca, sdi_ricollegata, sdi_doppione, sdi_00404_non_risolto, doppione_chiuso_pagamento_chiuso (C0.2 D2, C0.5 n. 4: solo da `fatture_coda_pulizia`, attore NULL, `dettaglio {fattura_emessa_id}`); `attore_id` → utenti (NULL = sistema); `dettaglio jsonb` in forma sicura (`sdi_*`: `{fattura_emessa_id, n}`; `rimessa` e `verifica_richiesta`: anche `{forzata, autorizzati}`; `anomalia`: `{tipo, chiave, consegna}` con `consegna` fra avviso_voce, avviso_proprio, parcheggiata, scartata_seconda); `il`. Indice `(pagamento_id, azione)`.

### 7.5 `fatture_coda_avvisi` — l'outbox (§14)
- Colonne: `id` (= `entita_id` della notifica); `tipo` (9 tipi, §8.4); `destinatario_id` → utenti (CASCADE), nullo ammesso; `a_tutti_gli_admin bool`, con CHECK `destinatario_id IS NOT NULL OR a_tutti_gli_admin`; `gruppo_id`; `voce_id`; `attore_id`; `dati jsonb` in forma sicura (niente spazi); `chiave_dedup UNIQUE` (`^[a-z0-9_:.+-]{1,160}$`); `tentativi 0..20`; `lease_token`; `lease_scade_il`; `inviato_il`; `creato_il`. Nessuna `scuola_id`.
- **`dati`** segue `DatiAvviso` di `contratto-db.ts` (§8.4). **(v4)** Gli avvisi `errore`, `da_verificare` e `verifica_manuale` possono portare `anomalia` (un `TipoAnomalia`, S44) e `fine_gruppo` (`{voci_accodate, emesse, errori, da_verificare, tolte}`, S45).
- **Errori aggregati per gruppo** (`_fatture_coda_avviso_errore`). Senza anomalia: se esiste un avviso `errore` dello stesso gruppo con `inviato_il` e `lease_token` nulli, `dati.n + 1`; altrimenti avviso nuovo (`n=1`, codice e numero del primo errore, chiave `err:<gruppo>:<epoch_ms>`). **Con anomalia** l'errore ha un avviso suo (`n=1`, `a_tutti_gli_admin`, `dati.anomalia`, chiave `err:<voce>:<epoch_ms>`), mai aggregato.
- **Ordine nella transazione della chiusura**: `_fatture_coda_chiudi_voce` scrive l'avviso del fatto prima di aggiornare lo stato della voce, così `_fatture_coda_aggiorna_gruppo`, chiamata dal trigger, lo trova per S45. L'UPDATE di `fine_gruppo` porta `WHERE lease_token IS NULL AND inviato_il IS NULL`; se non tocca righe nasce `gruppo_concluso`.

### 7.6 `fatture_coda_stato` — riga unica
`sospesa`, `sospesa_da` (NULL = sistema), `sospesa_il`, `sospesa_motivo ≤200`; `pausa_fino_a`, `pausa_motivo`; `ultimo_giro_il` (ogni `prendi('coda')`); `ultima_sveglia_il`, `ultima_sveglia_richiesta_id`; `ultimo_tick_il`, `ultimo_tick_richiesta_id`; `aggiornato_il`. Sospensione e pausa fermano solo la coda. Nella riga iniziale `ultima_sveglia_il` e `ultimo_giro_il` sono NULL (§9.6).

### 7.7 `aruba_cancello` — riga unica
`titolare` fra coda e sync, `token`, `fence` monotono, `preso_il`, `prestito_scade_il`, `richiesta_sync_il`, `circuito_aperto_il`, `circuito_fino_a`, `circuito_motivo`, `aggiornato_il`. Il circuito ferma coda e sync.

### 7.8 `aruba_tentativi`
`id`; `tipo` fra signin, upload, ricerca; `titolare`; `token`; `fence`; `voce_id`, `pagamento_id`, `quota_adult_id`, `invio_id` (senza FK); `il`; `esito` fra ok, rifiuto, http_429, http_401, http_403, http_5xx, rete, illeggibile, non_eseguito; `http`; `esito_il`. È la fonte del conteggio orario e al minuto, della prova delle ricerche e dei 429 per invio.

**Lock, sempre in quest'ordine:** `aruba_cancello` → `fatture_coda_voci` → `fatture_coda_invii` → `fatture_coda_stato` → `fatture_coda_gruppi` → eventi, avvisi, tentativi. Ogni RPC che scrive un invio (anche `aruba_cancello_esito`) blocca prima la sua voce. Le RPC che svegliano (`accoda`, `rimetti`, `richiedi_verifica`, `riprendi`) prendono `aruba_cancello FOR SHARE` all'inizio. Si cancella solo con `fatture_coda_pulizia()`.

---

## 8. Codici

### 8.1 Rifiuti delle RPC
Forma `{"ok":false,"code":"<CODICE>", …}`; `RAISE` solo per le invarianti.
`CODICI_RIFIUTO`: `BAD_INPUT, ATTORE_NON_STAFF, ATTORE_NON_ADMIN, NON_TROVATO, SEDE_ASSENTE, FUORI_SEDE, NON_SALDATO, PARTITA_NON_REGISTRATA, TRASPORTO_IN_SOSPESO, TIPO_NON_SUPPORTATO, CAUSALE_NON_VALIDA, INTESTATARIO_NON_VALIDO, DUPLICATA_NELLA_RICHIESTA, TROPPE_VOCI, GIA_IN_CODA, STATO_NON_VALIDO, IN_LAVORAZIONE, NUMERO_GIA_ASSEGNATO, CAUSALE_ALTRA_SEDE, OLTRE_12_GIORNI, FORZA_SOLO_ADMIN, CIRCUITO_APERTO, SOSPESA, IN_PAUSA, NIENTE_DA_FARE, OCCUPATO, CANCELLO_PERSO, SIGNIN_TROPPO_PRESTO, QUOTA_ORARIA, RITMO_MINUTO, RICERCA_TROPPO_PRESTO, QUOTA_GIA_NUMERATA, TENTATIVO_NON_VALIDO, CEDI_ALLA_SYNC, TEMPO_INSUFFICIENTE, VOCE_GIA_IN_MANO, NON_TUA, PRESTITO_SCADUTO, INVII_INCOERENTI, NUMERO_GIA_REGISTRATO, RICERCA_MANCANTE, RICERCA_NON_VALIDA, CONTENUTO_NON_VERIFICATO, RINVIO_NON_PERMESSO, FATTURA_NON_CORRISPONDE, FILENAME_MANCANTE`. `BAD_INPUT` porta `{campo}` (v4: anche per la forma di `p_invio`).
`CODICI_SCHEMA_ASSENTE = PGRST202, PGRST205, PGRST204, 42883, 42P01, 42703`: unica lista, usata da `rpc.ts` e dalla salute.

### 8.2 `esito_codice` della voce (`CODICI_ESITO_VOCE`) ed effetti

| Chiusura | Codici | Effetto SQL | Effetto sul giro (TS) |
|---|---|---|---|
| `emessa` (`CODICI_EMESSA`) | `inviata`, `gia_a_registro`, `ritrovata_su_aruba`, `ritrasmessa`, `registrata_dal_giornale` | `concluso_il`, minimizzazione | prosegui |
| `errore` (`CODICI_ERRORE`) | `intestatario_mancante`, `numero_conteso` (C0.2 D3: invio `bruciata`, anomalia `numerazione_anomala` nell'avviso della chiusura, si rifattura con numero nuovo), `giornale_non_aperto` (C0 G2, effetto ferma), `intestatario_in_conflitto`, `intestatario_non_del_bambino`, `intestatario_non_valido`, `anagrafica_incompleta`, `gia_emessa_altro_intestatario`, `quota_estranea`, `configurazione`, `non_saldato`, `pagamento_inesistente`, `serie_non_determinabile`, `periodo_competenza_mancante`, `iva_incoerente`, `partita_non_registrata`, `trasporto_in_sospeso`, `xml_non_componibile`, `scarto_aruba`, `scarto_aruba_0034`, `tipo_documento_non_supportato`, `esito_sconosciuto` | nessun invio aperto; avviso `errore` (§7.5) | prosegui |
| `errore` con soli `numerata` (`CODICI_ERRORE_CON_NUMERATA`) | `oltre_12_giorni` (§10.5); `guasto_ripetuto` (solo conversione c) | avviso `errore`; per `guasto_ripetuto` con `dati.anomalia='guasti_ripetuti'` e agli admin | `oltre_12_giorni` prosegui; `guasto_ripetuto` ferma |
| `da_verificare` **P** | `trasporto_ignoto`, `prestito_scaduto`, `gia_ricevuta_0034`, `aruba_429_ripetuto` | pausa 15'; `verifica_dovuta_il` = fine pausa; avviso `da_verificare` con `verifica_automatica_il = max(fine pausa, fine circuito)` | pausa |
| `da_verificare` **R** | `registro_mancante` | nessuna pausa; verifica dovuta subito; avviso `da_verificare` con `dati.anomalia='partita_non_registrata'` | prosegui |
| `da_verificare` **M** | `ambigua_su_aruba`, `ricerca_non_riuscita`, `oltre_12_giorni`, `guasto_ripetuto` | nessuna pausa; `verifica_auto_esito='non_trovata'`; avviso `verifica_manuale`; `dati.anomalia`: `numero_conteso` → `numerazione_anomala`, `guasto_ripetuto` → `guasti_ripetuti`; per `oltre_12_giorni`, prima, i `da_ritentare` oltre il limite senza autorizzazione → `incerta oltre_12_giorni` | prosegui (`guasto_ripetuto`: ferma) (C0.2 D3: `numero_conteso` non è più qui, chiude `errore`) |
| `resta_da_verificare` concludente | `non_trovata`, `ambigua_su_aruba`, `oltre_12_giorni`, `ricerca_non_riuscita`, `aruba_429_ripetuto`, `guasto_ripetuto` | `verifica_auto_esito='non_trovata'`; azione azzerata; avviso `verifica_manuale` con la stessa `dati.anomalia` del rigo M | prosegui (`guasto_ripetuto`: ferma) (C0.2 D3: `numero_conteso` non è più qui, chiude `errore`) |
| `resta_da_verificare` non concludente | `ricerca_da_ripetere`, `rinviata`, `guasto_transitorio`, `prestito_scaduto_senza_tentativo` | `verifica_dovuta_il = adesso + 4'`; azione conservata; nessun avviso della voce; conversioni a, b, c | ferma |
| `riprova` | `aruba_429`, `quota_oraria`, `ritmo_minuto`, `cancello_perso`, `cedi_alla_sync`, `tempo_insufficiente`, `circuito_aperto`, `in_pausa`, `sospesa`, `ricerca_da_ripetere` | torna `in_coda` al suo posto; conversioni a, b | `aruba_429` circuito; gli altri ferma |
| `riprova` + pausa | `aruba_prima_del_numero`, `credenziali_rifiutate`, `numerazione_anomala` | + pausa 15' | pausa |
| `rientro` (`CODICI_RIENTRO`) | `guasto_transitorio`, `prestito_scaduto_senza_tentativo` | da ogni lavoro, invii aperti solo `numerata` e `da_ritentare`; conversioni a, c | ferma |
| `tolta` (`CODICI_TOLTA`) | `tolta_operatore`, `oblio` | minimizzazione | — |
| dopo la chiusura | `doppione_sdi`, `doppione_sdi_irrisolto`, `doppione_sdi_ritrasmesso`, `sdi_ricollegata` | solo sync e accodamento (§5.1) | — |

**(v4) Anomalie della chiusura (S44).** Decide la chiusura **finale**, dopo le conversioni. `dati.anomalia` = l'anomalia da consegnare, se c'è; altrimenti quella intrinseca al codice finale (`registro_mancante`, `numero_conteso`, `guasto_ripetuto`). Se la chiusura finale scrive un avviso della voce (`errore`, `da_verificare`, `verifica_manuale`), l'anomalia va lì dentro e l'avviso prende `a_tutti_gli_admin`. Se non ne scrive (`emessa`, `riprova`, `rientro`, `resta` non concludente), nasce un avviso `anomalia` ai soli admin (chiave `anom:<tipo>:<chiave>`). La seconda anomalia di uno stesso fatto va solo in eventi e log.

### 8.3 `esito_codice` dell'invio (`CODICI_ESITO_INVIO`)
`upload_ok`, `upload_429`, `upload_rete`, `upload_illeggibile`, `upload_<http a 3 cifre>`, `scarto_<codice Aruba>`, `gia_ricevuta_0034`, `aruba_429_ripetuto`, `prestito_scaduto`, `numero_conteso`, `ambigua_su_aruba`, `ricerca_non_riuscita`, `xml_non_componibile`, `oltre_12_giorni`, `guasto_ripetuto`. Le forme variabili si costruiscono con `codiceUpload(http)` e `codiceScarto(codice)` di `contratto-db.ts`. Il testo di Aruba o dello SdI va in `esito_dettaglio`. Sugli invii `incerta` l'`esito_codice` cambia solo con una conversione di stato.

### 8.4 Avvisi (`TIPI_AVVISO`, `dati` in forma sicura, `DatiAvviso`)

| tipo | chi lo scrive | destinatari | `dati` | `chiave_dedup` |
|---|---|---|---|---|
| `gruppo_concluso` | `_fatture_coda_aggiorna_gruppo`, alla conclusione, **solo se** non c'è un avviso in attesa del gruppo per `creato_da` (S45) | `creato_da` del gruppo | `voci_accodate, emesse, errori, da_verificare, tolte` | `gruppo:<gruppo>` |
| `errore` | `chiudi('errore')` (compresi `oltre_12_giorni` e `guasto_ripetuto`), conversione c, anche dal bidello | `creato_da` del gruppo corrente; **con anomalia anche tutti gli admin**, nella stessa riga | `n, codice, sezionale?, numero?, anno?, anomalia?, fine_gruppo?` | senza anomalia `err:<gruppo>:<epoch_ms>`, aggregato finché non è preso; con anomalia `err:<voce>:<epoch_ms>` |
| `da_verificare` | `chiudi('da_verificare')` coi codici P e R; bidello; conversione a fuori dalla verifica; `segnala_scarto_sdi` (`non_identico`; `non_risolto` al 6°) | chi ha accodato + tutti gli admin, in una riga (`destinatario_id` + `a_tutti_gli_admin`) | `codice, sezionale, numero, anno, verifica_automatica_il?, anomalia?, fine_gruppo?` | `dav:<voce>:<epoch_ms della chiusura>`; `dav:sdi:<fattura>`; `dav:sdi-nr:<fattura>` |
| `verifica_manuale` | `chiudi('da_verificare')` coi codici M; `resta_da_verificare` concludente; conversione a dalla verifica; conversioni b e c | chi ha accodato + admin, in una riga | `codice, sezionale, numero, anno, anomalia?, fine_gruppo?` | `vm:<voce>:<epoch_ms>` |
| `scarto_sdi` | `segnala_scarto_sdi` con `p_doppione` NULL | chi ha accodato, anche giorni dopo | `codice_sdi, sezionale, numero, anno` | `sdi:<fattura_emessa_id>` |
| `pausa_429` | `aruba_cancello_esito('http_429')` | ogni utente con voci `in_coda`/`in_invio` | `fino_a` | `c429:<epoch circuito_aperto_il>:<utente>` |
| `sospesa`, `ripresa` | `sospendi`/`riprendi` | utenti con voci in attesa, meno l'attore (lo esclude l'SQL) | `il`, `da_sistema` | `sosp:<epoch>:<utente>`, `rip:<epoch>:<utente>` |
| `anomalia` | solo per un'anomalia **senza** avviso della voce nello stesso fatto (§8.2, §8.5) | tutti gli admin | `tipo, sezionale?, numero?, anno?` | `anom:<tipo>:<chiave>` |

Per una fattura nata fuori dalla coda (nessuna voce) gli avvisi `da_verificare` del 00404 vanno ai soli admin (`destinatario_id` nullo).

### 8.5 Anomalie (`TIPI_ANOMALIA`)

| tipo | dove nasce | come arriva agli admin (S44) | chiave |
|---|---|---|---|
| `credenziali_aruba` | SQL, `aruba_cancello_esito` con 401/403 su `signin` | avviso `anomalia` (la voce chiude `riprova credenziali_rifiutate`, senza avviso) | giorno `AAAAMMGG` |
| `partita_non_registrata` | SQL, chiusura `da_verificare registro_mancante` (lavoratore o bidello) | dentro l'avviso `da_verificare` | invio |
| `numerazione_anomala` | SQL: chiusura `errore numero_conteso` (C0.2 D3, intrinseca al codice finale), 00404 non identico. TS, da consegnare: pavimento fuori scala, `NUMERO_GIA_REGISTRATO`, `0034` su un numero nuovo | dentro `verifica_manuale`, `da_verificare` o `errore` della chiusura; con `riprova numerazione_anomala` avviso `anomalia` | `<sezionale>-<anno>-<numero o pavimento>` |
| `numero_bruciato` | SQL, `fatture_coda_numero_bruciato` (da consegnare) | dentro l'avviso della chiusura; altrimenti avviso `anomalia` | `<sezionale>-<anno>-<numero>` |
| `doppia_emissione` | TS, 23505 su `pagamento_quota` all'INSERT del registro (da consegnare) | dentro il `da_verificare registro_mancante` che segue | `<pagamento>-<quota>` |
| `guasti_ripetuti` | SQL, conversione c (tutte e tre le uscite) | dentro `verifica_manuale` o `errore` (con gli admin) | voce |

Evento `anomalia` e log `anomalia` (error, distinto solo per tipo) si scrivono quando l'anomalia nasce, sempre.

### 8.6 Codici degli avvisi di verifica e loro testo (in `contratto-db.ts`)
- `CODICI_AVVISO_DA_VERIFICARE = trasporto_ignoto, prestito_scaduto, gia_ricevuta_0034, aruba_429_ripetuto, registro_mancante, doppione_sdi, doppione_sdi_irrisolto`.
- `MODO_DA_VERIFICARE: Record<CodiceAvvisoDaVerificare, 'ricerca_automatica' | 'registrazione_automatica' | 'ritrasmettere' | 'controllo_sul_pannello'>`: i primi quattro codici → `ricerca_automatica` («alle {ora} l'app la cerca da sola»); `registro_mancante` → `registrazione_automatica` («l'app la registra da sola al prossimo giro»); `doppione_sdi` → `ritrasmettere` («scartata come doppione di un documento diverso: va ritrasmessa, con numero nuovo»); `doppione_sdi_irrisolto` → `controllo_sul_pannello` («l'app non riesce a confrontarla con quella consegnata: controlla sul pannello Aruba e NON riemetterla»).
- `CODICI_AVVISO_VERIFICA_MANUALE = non_trovata, ambigua_su_aruba, oltre_12_giorni, ricerca_non_riuscita, aruba_429_ripetuto, guasto_ripetuto` (6; C0.5 n. 2: `numero_conteso` ne è uscito e chiude `errore`), ognuno con la sua frase.
- Avviso `errore` con codice `numero_conteso` (C0.2 D3): «su Aruba c'è un documento diverso con il numero di {doc}: il numero resta a quel documento. Per rifatturare usa "Rimetti in coda", che prende un numero nuovo»; `dati.anomalia='numerazione_anomala'`, agli admin. `oltre_12_giorni`: «sono passati più di 12 giorni dalla data: può rimandarla solo un admin, forzando». `guasto_ripetuto`: «l'app non è riuscita a chiuderla per un guasto suo: controlla sul pannello Aruba, poi Cerca o Rimanda».
- Avviso `errore` con codice `oltre_12_giorni`: «non inviata: sono passati più di 12 giorni dalla data; per rimetterla in coda serve un admin».
- **(v4)** `dati.anomalia` aggiunge una frase per `TipoAnomalia` («segnalata agli admin come …»), esaustiva. `dati.fine_gruppo` aggiunge «Gruppo concluso: …» con i soli conteggi diversi da zero, in forma neutra, perché lo leggono anche gli admin.
- Negli avvisi l'SQL scrive solo questi codici e tipi (lock §17.5).

---

## 9. RPC

**Convenzioni.** `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp`, owner `postgres`. `REVOKE ALL … FROM PUBLIC, anon, authenticated`, poi `GRANT EXECUTE … TO service_role`; gli helper `_fatture_coda_*` hanno solo il `REVOKE`. Ritorno `jsonb`. `p_attore` è sempre `auth.user.id` passato dalla route, mai preso dal corpo; unica eccezione `sospendi(NULL, …)` = sistema, mai da una route. `p_scuola_ids` è il perimetro: per leggere e gestire `sediReali().reali ∪ scuoleDiUtente(user)` (decisione 6); per accodare `scuoleDiUtente(user)`. **Le firme complete sono nel campo `rpc`; sono 32.** La regola dei 12 giorni sta in una funzione: `_fatture_coda_invio_oltre_limite(p_data_documento date, p_autorizzata_il timestamptz) RETURNS boolean` = `p_autorizzata_il IS NULL AND _fatture_coda_oggi_fiscale() − p_data_documento > _fatture_coda_giorni_limite_trasmissione()`.

### 9.1 Cancello
- **`aruba_cancello_prendi(p_titolare, p_token, p_prestito_secondi)`**: esegue il bidello; prende il cancello `FOR UPDATE`. Con `coda` scrive `ultimo_giro_il` anche se poi rifiuta. Circuito aperto → `CIRCUITO_APERTO{riapre_il}` (per entrambi i titolari). Solo per `coda`: `SOSPESA`, `IN_PAUSA`, `NIENTE_DA_FARE`. Stesso token vivo → idempotente. Altro titolare vivo → `OCCUPATO{titolare, libero_entro, cedera}` (+ `richiesta_sync_il` se la sync chiede mentre la coda tiene il cancello). Presa: `fence+1`, prestito 30..900 s → `{fence, prestito_scade_il, upload_ultima_ora, upload_ultimo_minuto, ultimo_signin_il}`.
- **`aruba_cancello_rilascia(p_token)`**: se il token è il titolare, libera il cancello. Le voci `in_invio` del token ricevono `prestito_scade_il := adesso` (warn `rilascio-con-voci-in-mano`). Poi, per entrambi i titolari, se un candidato di `_fatture_coda_in_ordine()` ha `in_attesa_dal > preso_il` o `azione_richiesta_il > preso_il`, chiama `_fatture_coda_sveglia('accodamento')`. Idempotente.
- **`aruba_cancello_prenota(p_token, p_tipo, p_limite_ora, p_limite_minuto, p_voce_id, p_quota_adult_id, p_invio_id)`**: unico punto che consuma il budget, prima della chiamata (e, per un numero nuovo, prima della RPC del numero). `signin`: spaziatura fissa di 65 s → `SIGNIN_TROPPO_PRESTO{attendi_ms}`. `ricerca`: `p_limite_minuto` 1..12 → `RICERCA_TROPPO_PRESTO`; con `p_invio_id` l'invio dev'essere di una voce `in_invio` del token; la sync passa `p_invio_id` nullo. `upload`: `p_limite_ora` 1..60 e `p_limite_minuto` 1..30 obbligatori; un numero nuovo solo per una voce `in_invio` del token senza invio vivo per la quota (`QUOTA_GIA_NUMERATA`); un reinvio solo per un invio `numerata`, `da_ritentare` o `incerta` della voce del token e dentro la regola dei 12 giorni (`OLTRE_12_GIORNI{data_documento, giorni}`); poi `RITMO_MINUTO`, `QUOTA_ORARIA{riprova_il}`. Ritorna `{tentativo_id, usati_ora, usati_minuto}`.
- **`aruba_cancello_esito(p_token, p_tentativo_id, p_esito, p_http)`**: chiude ogni prenotazione (esito tardivo accettato). `http_429` (qualunque tipo e titolare) → circuito `fino_a = max(fino_a, adesso+60')`, evento, avvisi `pausa_429`, warn `circuito-aperto`. 401/403 su `signin` → anomalia `credenziali_aruba` (avviso proprio). `non_eseguito` vale solo per un upload mai legato a un invio. **Contatore dei 429** (S7) per i tentativi legati a un invio aperto (lock voce → invio): `http_429` di qualunque tipo → `LEAST(+1, 3)`; risposta non-429 (ok, rifiuto, 401, 403, 5xx, illeggibile) a un `upload` → 0; il resto invariato. Ritorna `{circuito_fino_a, appena_aperto, invio: {id, consecutivi_429, somma_voce} | null}`.

### 9.2 Lavoratore
- **`fatture_coda_prossima(p_token, p_limite_ora, p_tempo_minimo_secondi)`**: advisory lock. Rifiuti `CANCELLO_PERSO`, `CIRCUITO_APERTO`, `CEDI_ALLA_SYNC` (richiesta della sync negli ultimi 2'), `TEMPO_INSUFFICIENTE`, `SOSPESA`, `IN_PAUSA`, `VOCE_GIA_IN_MANO`, `QUOTA_ORARIA`, `NIENTE_DA_FARE`. La testa è il primo candidato con `giro ≠ fence` (§6), presa `FOR UPDATE SKIP LOCKED`: `stato='in_invio'`, `lavoro`, `giro = fence`, prestito, `tentativi+1`, `presa_il`. Ritorna `{lavoro, voce{id, pagamento_id, scuola_id, tipo_documento, motivo, urgente, livello, origine_iniziale, causale_modo, causale_manuale, intestatario_scelto, intestatario_origine, ricorda_scheda, tentativi, rientri_guasto, azione_richiesta, verifica_automatica, prestito_scade_il}, gruppo{id, origine, creato_da, creato_ruolo}, invii[{id, stato, azione, tentativi, consecutivi_429, ricerche_fallite, ricerca_esito, ricerca_il, tardiva_autorizzata_il, oltre_12_giorni, quota_adult_id, quota_label, sezionale, anno, numero, progressivo_invio, data_documento, importo, xml, riga_registro, aruba_filename, fattura_emessa_id}]}`. `azione`: `numerata`→`invia`; `da_ritentare`→`cerca_poi_invia`; `incerta`→`cerca_poi_invia` solo con `rimanda`, altrimenti `solo_cerca`; `caricata`→`registra`. `oltre_12_giorni` = `_fatture_coda_invio_oltre_limite(data_documento, tardiva_autorizzata_il)`.
- **`fatture_coda_invio_registra(p_voce_id, p_token, p_invio)`** (v4): registra l'invio `numerata` con la forma di §7.3. Rifiuti `NUMERO_GIA_REGISTRATO`, `QUOTA_GIA_NUMERATA`, `NON_TUA`, `BAD_INPUT{campo}`.
- **`fatture_coda_numero_bruciato(p_voce_id, p_token, p_invio, p_codice)`** (v4): invio `bruciata` (senza `xml` e `riga_registro`, `tentativi = 0`; `p_codice='numero_conteso'` → `BAD_INPUT`, C0.5 n. 1), evento `numero_bruciato`, error `numero-bruciato`, evento e log `anomalia`; **l'anomalia `numero_bruciato` va in `anomalia_da_consegnare`** della voce e la consegna la chiusura (S44).
- **`fatture_coda_invio_tenta(p_invio_id, p_token, p_tentativo_id)`**: lega la prenotazione (upload, stesso token, non legata, esito nullo, meno di 2' fa) e porta l'invio `in_volo` (`tentativi+1`, `tentato_il`), alle condizioni di §5.2. Ogni passaggio a `in_volo` oltre il limite senza autorizzazione → `OLTRE_12_GIORNI{data_documento, giorni}`. Rifiuti `RINVIO_NON_PERMESSO`, `OLTRE_12_GIORNI`, `RICERCA_MANCANTE`, `TENTATIVO_NON_VALIDO`, `CANCELLO_PERSO`, `CIRCUITO_APERTO`.
- **`fatture_coda_invio_esito(p_invio_id, p_token, p_esito, p_http, p_aruba_filename, p_codice, p_dettaglio, p_id_sdi, p_fattura_emessa_id)`**: `p_esito` fra caricata, da_ritentare, rifiutata, incerta, partendo da `in_volo` (o da `incerta` del bidello: warn `esito-tardivo`). Non tocca `consecutivi_429` e non converte il 429. `0034` con `tentativi ≥ 2` → `incerta gia_ricevuta_0034` con `forzato:true`. `p_fattura_emessa_id` con lo stesso filename → `registrata`. `rifiutata` → warn `numero-non-usato`.
- **`fatture_coda_invio_ricerca(p_invio_id, p_token, p_tentativi, p_esito, p_trovato)`**: per un invio `incerta` o `da_ritentare` di una voce `in_invio` del token. Per `combacia`, `assente`, `non_combacia`, `ambigua`: `p_tentativi` = id di tentativi `ricerca` del token, esito `ok`, posteriori a `tentato_il` (altrimenti `RICERCA_NON_VALIDA`); `ricerche_fallite := 0`. `combacia`: `p_trovato {aruba_filename, sezionale, numero, anno, importo, data_documento}` uguale all'invio (altrimenti `CONTENUTO_NON_VERIFICATO`) → `caricata`. `non_combacia` (C0.2 D3, C0.5 n. 1): `da_ritentare` **o** `incerta` → `bruciata numero_conteso` (`xml` e `riga_registro` a NULL, `consecutivi_429 := 0`); l'anomalia `numerazione_anomala` la scrive la chiusura `errore numero_conteso` come intrinseca (§8.2), qui non si parcheggia. `ambigua`: `da_ritentare` → `incerta ambigua_su_aruba`; su un `incerta` lo stato non cambia. `illeggibile` (nessuna prova): `ricerche_fallite := LEAST(+1, 3)`; al 3° un `da_ritentare` → `incerta ricerca_non_riuscita`; warn `ricerca-non-riuscita`. Scrive sempre `ricerca_il`, `ricerca_esito` e l'evento `ricerca`. Ritorna `{stato_invio, ricerche_fallite, conclusa}`.
- **`fatture_coda_invio_registrato(p_invio_id, p_token, p_fattura_emessa_id)`**: `caricata → registrata` (`FATTURA_NON_CORRISPONDE`, `FILENAME_MANCANTE`).
- **`fatture_coda_chiudi(p_voce_id, p_token, p_esito, p_codice, p_messaggio, p_http)`**: `p_esito` fra emessa, errore, da_verificare, resta_da_verificare, riprova, rientro; `resta_da_verificare` solo dal lavoro `verifica`; `riprova` e `rientro` da ogni lavoro. Prima gli effetti propri dei codici, poi le conversioni a, b, c (la prima che scatta), poi i controlli sugli invii (§5.1); eccezione `numerata` per `errore guasto_ripetuto` e `oltre_12_giorni` (S30). **(v4)** Consegna l'anomalia (§8.2): scrive l'avviso del fatto prima dell'aggiornamento di stato e azzera `anomalia_da_consegnare`. Idempotente sullo stesso arrivo e token. Rifiuti `PRESTITO_SCADUTO{stato}`, `NON_TUA`, `INVII_INCOERENTI[{invio_id,stato}]`, `RICERCA_MANCANTE`, `BAD_INPUT`. Sempre `lavoro` e prestito a NULL, evento `chiusa`. Ritorna `{stato, gruppo_id, forzato, codice_finale}`.
- **`fatture_coda_bidello()`** (v4): per ogni voce `in_invio` con prestito scaduto vale **la prima regola che si applica**:
  1. un invio `in_volo` → ogni `in_volo` diventa `incerta prestito_scaduto`; voce `da_verificare prestito_scaduto` (P);
  2. lavoro `emissione` o `reinvio` con un invio `incerta` → `da_verificare`, codice `gia_ricevuta_0034` se un `incerta` porta quel codice, altrimenti `prestito_scaduto` (P);
  3. lavoro `emissione` o `reinvio` con un invio `caricata` → `da_verificare registro_mancante` (R, con `dati.anomalia`);
  4. lavoro `verifica` con un invio `incerta` o `caricata` → `resta_da_verificare prestito_scaduto_senza_tentativo` (non concludente);
  5. altrimenti (soli `numerata` e/o `da_ritentare`, o nessun invio), da ogni lavoro → `rientro prestito_scaduto_senza_tentativo`.
  Chiude con `_fatture_coda_chiudi_voce`: valgono le conversioni a e c, e consegna l'anomalia da consegnare. Libera il cancello scaduto; warn `prestito-scaduto` e `cancello-prestito-scaduto`, mai distinti per voce.

### 9.3 Outbox e segnalazioni
- **`fatture_coda_avvisi_prendi(p_token, p_limite)`**: lease di 2', `tentativi+1`, al massimo 10; al decimo error `avviso-abbandonato`, una volta. Ritorna `[{id, tipo, destinatario_id, a_tutti_gli_admin, gruppo_id, voce_id, attore_id, dati, creato_il}]`.
- **`fatture_coda_avvisi_conferma(p_token, p_ids)`**: scrive `inviato_il` sulle righe del lease.
- **`fatture_coda_segnala_scarto_sdi(p_fattura_emessa_id, p_codice_sdi, p_doppione)`**, con `p_doppione` fra NULL, ricollegato, non_identico, non_risolto: NULL → avviso `scarto_sdi` a chi ha accodato. `ricollegato` → evento `sdi_ricollegata`; la voce `emessa` passa a `sdi_ricollegata`; nessun avviso. `non_identico` → voce `doppione_sdi`; evento `sdi_doppione`; **un solo** avviso `da_verificare` (codice `doppione_sdi`, `dati.anomalia='numerazione_anomala'`, a chi ha accodato e agli admin); evento e log `anomalia`, nessun avviso `anomalia` a parte. `non_risolto` → conta gli eventi `sdi_00404_non_risolto` della fattura dopo l'ultimo `sdi_ricollegata` o `sdi_doppione`; sotto 6 aggiunge l'evento; al 6° la voce passa a `doppione_sdi_irrisolto` e parte l'avviso `da_verificare` (codice `doppione_sdi_irrisolto`); dopo il 6° non scrive più nulla; mai tocca `pagamenti` o `fatture_emesse`. Ritorna `{accodante_id, voce_id, non_risolti, da_verificare}`; senza voce gli avvisi vanno ai soli admin.
- **`fatture_coda_segnala_anomalia(p_tipo, p_chiave, p_dati, p_voce_id DEFAULT NULL, p_token DEFAULT NULL)`** (v4): evento e error `anomalia`, distinto solo per tipo. Con `p_voce_id` di una voce `in_invio` del token: l'anomalia va in `anomalia_da_consegnare` (se è già piena, resta solo in eventi e log) e la consegna la chiusura. Senza voce in mano: avviso `anomalia` subito agli admin.

### 9.4 Staff e admin
- **`fatture_coda_accoda(p_attore, p_scuola_ids, p_richiesta_id, p_origine, p_urgente, p_voci, p_periodo)`**: `aruba_cancello FOR SHARE` all'inizio. Idempotente su `richiesta_id`: se il gruppo c'è già risponde `gia_esistente` con le sue voci, senza rivalidare. Per ogni elemento controlla `NON_TROVATO`, `SEDE_ASSENTE`, `FUORI_SEDE`, `NON_SALDATO`, `PARTITA_NON_REGISTRATA`, `TRASPORTO_IN_SOSPESO` (riga viva con `sdi_stato` e `aruba_filename` nulli), `TIPO_NON_SUPPORTATO` (TD04, decisione 4), `CAUSALE_NON_VALIDA`, `INTESTATARIO_NON_VALIDO`, `DUPLICATA_NELLA_RICHIESTA`, `GIA_IN_CODA`; `TROPPE_VOCI` oltre 500. Scrive `origine_iniziale`, **`motivo` secondo §6 (S51)**, `data_riferimento`, `ordine_selezione`, `in_attesa_dal`. Porta a `doppione_sdi_ritrasmesso` le voci `doppione_sdi` dello stesso pagamento. Sveglia se ha accodato almeno una voce; info `accodate`.
- **`fatture_coda_togli(p_attore, p_scuola_ids, p_voce_ids)`**: voci `in_coda`/`errore` senza alcun invio, **oppure** (C0.2 D1, C0.5 n. 3) voci `errore` con invii tutti `rifiutata`/`bruciata` → `tolta tolta_operatore`, evento con l'attore; gli invii restano a giornale. `in_invio` → `IN_LAVORAZIONE`; `da_verificare`, oppure un invio in qualunque altro stato → `NUMERO_GIA_ASSEGNATO`; terminali → `STATO_NON_VALIDO`.
- **`fatture_coda_rimetti(p_attore, p_scuola_ids, p_richiesta_id, p_voce_ids, p_urgente, p_forza)`**: `aruba_cancello FOR SHARE`. Nuovo gruppo `rimessa_in_coda` di chi preme (idempotente). Solo voci `errore` con pagamento `pagato` (`NON_SALDATO`). Un `numerata` oltre il limite senza autorizzazione → `OLTRE_12_GIORNI{data_documento, giorni}`, salvo `p_forza` di un admin (`FORZA_SOLO_ADMIN`), che scrive `tardiva_autorizzata_il` (evento `rimessa {…, forzata, autorizzati}`, info `tardiva-autorizzata`). La voce va `in_coda` con gruppo e selezione nuovi, `rientri_guasto=0`, `in_attesa_dal` nuovo; è la stessa voce, quindi un `numerata` riparte con lo stesso XML. Sveglia.
- **`fatture_coda_urgente(p_attore, p_scuola_ids, p_voce_ids, p_urgente)`**: solo `in_coda`; evento `urgenza`.
- **`fatture_coda_causale(p_attore, p_scuola_ids, p_voce_id, p_modo, p_causale)`**: solo `in_coda`/`errore` senza documento costruito (invio aperto → `NUMERO_GIA_ASSEGNATO`; `in_invio` → `IN_LAVORAZIONE`); solo nella sede propria (`CAUSALE_ALTRA_SEDE`); evento `causale {modo, lunghezza}`.
- **`fatture_coda_richiedi_verifica(p_attore, p_scuola_ids, p_voce_id, p_azione, p_forza)`**: solo voci `da_verificare` (`in_invio` → `IN_LAVORAZIONE`, altro → `STATO_NON_VALIDO`). `p_forza` solo con `rimanda` (altrimenti `BAD_INPUT`). Con `rimanda`, un invio non caricato oltre il limite senza autorizzazione → `OLTRE_12_GIORNI`, salvo forza di un admin (`FORZA_SOLO_ADMIN`), che scrive `tardiva_autorizzata_il` (info `tardiva-autorizzata`). Scrive `azione_richiesta*`; azzera `ricerche_fallite` e `consecutivi_429` degli invii aperti e `rientri_guasto`; evento `verifica_richiesta {azione, forzata, autorizzati}`; sveglia.
- **`fatture_coda_sospendi(p_attore, p_motivo)`**: `p_attore` admin, oppure NULL = sistema con motivo 1..200 obbligatorio (`BAD_INPUT`). Idempotente (`gia`). Evento; info `sospesa` con `tipo` admin o sistema; avvisi `sospesa` agli accodanti in attesa, meno l'attore.
- **`fatture_coda_riprendi(p_attore)`**: solo admin; `aruba_cancello FOR SHARE`; avvisi `ripresa`; sveglia `ripresa`; l'ordine non cambia. **La chiama solo il titolare da admin, mai un agente** (C0.2 D4).

### 9.5 Letture, salute, GDPR, cron
- **`fatture_coda_riepilogo(p_scuola_ids, p_utente)`**: `contatori{in_coda, in_invio, da_verificare, da_verificare_operatore, doppioni_sdi, errore, emesse_oggi, tolte_oggi, per_livello{rimandate, ritrasmissioni, urgenti, normali}}`; `doppioni_aperti uuid[]` (≤500, S34); `per_sede`; `stato_coda{sospesa, sospesa_da, sospesa_da_sistema, sospesa_il, sospesa_motivo, pausa_fino_a, pausa_motivo, ultimo_giro_il, ultimo_tick_il, ultima_sveglia_il}`; `cancello{titolare, prestito_scade_il, circuito_aperto_il, circuito_fino_a, circuito_motivo}`; `upload{ultima_ora, ultimo_minuto, istanti[]}`; `in_attesa_piu_vecchia_dal`; `gruppi_miei` (7 giorni). Nessun dato personale.
- **`fatture_coda_posizioni(p_scuola_ids, p_voce_ids)`**: `[{voce_id, posizione, lavoro, rango}]`, rango globale, al massimo 2000 voci.
- **`fatture_coda_stato_pagamenti(p_scuola_ids, p_pagamento_ids)`** (v4): `[{pagamento_id, voce_id, stato, urgente, livello, numero_assegnato, solo_invii_non_consegnati, invii_oltre_limite: [{invio_id, stato, data_documento, giorni}]}]` delle sole voci attive, al massimo 2000 pagamenti. `invii_oltre_limite` elenca gli invii `numerata`, `da_ritentare` e `incerta` della voce con `_fatture_coda_invio_oltre_limite(data_documento, tardiva_autorizzata_il)` vero; `giorni = _fatture_coda_oggi_fiscale() − data_documento`. `solo_invii_non_consegnati` (C0.5 n. 3) = la voce ha invii e sono tutti `rifiutata`/`bruciata`: la stessa condizione che `fatture_coda_togli` e `_fatture_coda_voci_guardia` usano per C0.2 D1, scritta in un solo helper `_fatture_coda_solo_invii_non_consegnati(p_voce uuid) → boolean` [D]. Campi additivi: la riconciliazione li ignora.
- **`fatture_coda_salute()`**: `{ok, in_attesa_piu_vecchia_dal, sospesa, sospesa_il}`.
- **`fatture_coda_oblio(p_pagamento_ids)`**: le voci attive senza alcun invio diventano `tolta oblio`; quelle con numero assegnato restano (obbligo fiscale) e si contano.
- **`fatture_coda_tick_http()`**: bidello; controllo dell'esito HTTP del giro precedente (error `tick-esito-http`); `net.http_post` con `x-cron-secret` e `timeout_milliseconds := 300000`; scrive `ultimo_tick_il`.
- **`fatture_coda_pulizia()`**: cancella solo il vecchio (24 mesi) e chiuso: avvisi, tentativi, eventi, invii di voci chiuse, voci chiuse, gruppi vuoti; mai le voci attive. **(C0.2 D2, C0.5 n. 5)** Poi, per ogni voce `emessa` con `esito_codice` in (`doppione_sdi`, `doppione_sdi_irrisolto`) e pagamento non più `pagato`, senza un evento `doppione_chiuso_pagamento_chiuso` della voce: scrive quell'evento (attore NULL), una volta sola. Battito `'cron:fatture-coda-pulizia'` con `n_doppioni_chiusi` fra gli `n_*`. Il file 3 la esegue una volta anche all'applicazione, dentro `EXCEPTION`; tick e pulizia si programmano nel file 3 con unschedule-se-presente e poi `cron.schedule`, dentro `DO … EXCEPTION`.

### 9.6 Sveglia `_fatture_coda_sveglia(p_motivo)`
1. schema `net` assente → warn `sveglia-net-assente` e ritorno (l'accodamento riesce);
2. cancello tenuto dalla coda con prestito vivo → no (sveglierà `rilascia`);
3. `sospesa`, `pausa_fino_a > adesso` o circuito aperto → no;
4. farfalla: `UPDATE fatture_coda_stato SET ultima_sveglia_il = adesso WHERE id = 1 AND NOT (COALESCE(ultima_sveglia_il, '-infinity') > COALESCE(ultimo_giro_il, '-infinity') AND COALESCE(ultima_sveglia_il, '-infinity') > adesso − interval '60 seconds')`; nessuna riga aggiornata → no (F30);
5. URL nullo → error `sveglia-url-assente`;
6. `net.http_post(url, {x-cron-secret}, {"motivo": p_motivo}, timeout 300000)`; su eccezione error `sveglia-post-fallito`. La richiesta parte dopo il commit.

---

## 10. Protocollo di un giro (ordine vincolante)

1. `token = uuid()`; `aruba_cancello_prendi('coda', token, 330)`. Se non riesce: battito col `tipo`, `spedisciAvvisiCoda()`, fine, nessuna chiamata ad Aruba.
2. Ciclo `fatture_coda_prossima(token, SOGLIA_ORARIA_APP, ceil(riserva/1000))`, una voce alla volta. Ogni rifiuto chiude il giro col suo `tipo`.
3. Ogni chiamata ad Aruba segue `aruba_cancello_prenota` → chiamata (`ritenta:false`) → `aruba_cancello_esito`, anche su eccezione. Le ricerche per una voce si prenotano con `p_invio_id` dell'invio che si sta risolvendo.
4. Lavoro `emissione`: `emettiVoce()` → `emettiFatturaPagamento(…, {sessione, giornale, ritentaUpload:false, ritentaLettura:false})`. Per ogni quota: gate, accesso, pavimento; `giornale.prenotaInvio` prima della RPC del numero; numero e XML; `giornale.apriInvio(doc)` (= `invio_registra` + `invio_tenta`), con `doc: InvioDaRegistrare` costruito come in §7.3: `riga_registro` = `baseRow` senza `xml_inviato`; `importo`, `data_documento` e numero ricavati dal suo stesso XML con `estraiDatiDocumento` (una fonte sola). Se `apriInvio` fallisce non si fa l'upload: `numero_bruciato` se il numero non è conservato, prenotazione chiusa `non_eseguito`. Poi upload; `giornale.esitoInvio` (= `aruba_cancello_esito` + `invio_esito`); INSERT a registro (§7.3), poi `invio_registrato`. Dopo un upload riuscito non si ritrasmette mai. **(v4) Aggregato del pagamento col giornale (S51):** `scartata` solo se almeno una quota è stata rifiutata nel merito da Aruba (riga `sdi_stato=2`, compreso lo `0034` su un numero nuovo); ogni altra fermata (numerazione, intestatario, configurazione, trasporto, 429, guasto) lascia `fattura_stato` com'era (info `pagamento-non-toccato-rinvio`).
5. Lavoro `reinvio` (invii nell'ordine `caricata`, `da_ritentare`/`incerta`, `numerata`):
   - `numerata` con `oltre_12_giorni` → `errore oltre_12_giorni`, senza prenotare. Altrimenti upload diretto dello stesso XML;
   - `da_ritentare` → ricerca e confronto (§11) → `invio_ricerca`: `combacia` → registrazione (`ritrovata_su_aruba`); `assente` → con `oltre_12_giorni` `da_verificare oltre_12_giorni`, altrimenti reinvio dello stesso XML e numero; `non_combacia` → invio `bruciata numero_conteso`, voce `errore numero_conteso` appena non ha più invii aperti (C0.2 D3, C0.5 n. 1); `ambigua` → `da_verificare ambigua_su_aruba`; `illeggibile` → `riprova ricerca_da_ripetere` (alla 3ª scatta la conversione b); 429 durante la ricerca → `riprova aruba_429`.
6. Lavoro `verifica`: `caricata` → registrazione senza Aruba (`registrata_dal_giornale`); `solo_cerca` → `combacia` registra; `assente` → `resta non_trovata`; `non_combacia` → invio `bruciata numero_conteso` e voce `errore numero_conteso` (C0.2 D3: non più `resta`); `ambigua` → `resta ambigua_su_aruba`; `illeggibile` → `resta ricerca_da_ripetere`; limite o 429 → `resta rinviata`; guasto nostro → §10.11. `cerca_poi_invia` («Rimanda») → come sopra; con `assente` e reinvio permesso → stesso XML e numero (con `non_combacia` come `solo_cerca`: `bruciata`, `errore numero_conteso`, mai reinvio); con `oltre_12_giorni` → `resta oltre_12_giorni`. La ricerca automatica non rimanda mai un invio `incerta`.
7. **Completamento.** Risolti gli invii aperti, in ogni lavoro il lavoratore completa le quote con `emettiVoce(…, {soloCompletamento:true})`, idempotente per quota: invia i `numerata` rimasti (regola dei 12 giorni) e numera le quote mai numerate. Chiude `emessa` solo con tutte le quote del pagamento a registro.
8. `classificaEmissione`/`classificaRisoluzione` → `fatture_coda_chiudi`; la risposta (`forzato`, `codice_finale`) decide il log. Effetti del §8.2: `circuito`, `pausa` e `ferma` chiudono il giro; `prosegui` va avanti.
9. `finally`: `aruba_cancello_rilascia(token)`, poi `spedisciAvvisiCoda(supabase)`. Il battito lo scrive la route.
10. Tetti: 15 upload, 40 voci, riserva di tempo (prima voce con accesso 255 s, poi 155 s), 2,5 s fra due upload, accessi a 65 s.
11. **Guasti nostri e rifiuti inattesi (S41).** Una sola tabella, usata da `classifica.ts` e, nei suoi 5 rami, dal bidello (§9.2):

| Situazione della voce (dopo le conversioni) | Chiusura |
|---|---|
| un invio `in_volo` | nessuna: la voce resta al bidello (`rilascia` fa scadere il prestito) → `incerta prestito_scaduto` → `da_verificare` P |
| `emissione`/`reinvio` con un invio `incerta` | `da_verificare` col codice del trasporto (`trasporto_ignoto`, `gia_ricevuta_0034`…); il bidello usa `gia_ricevuta_0034` o `prestito_scaduto` |
| `emissione`/`reinvio` con un invio `caricata` | `da_verificare registro_mancante` (R) |
| `verifica` con un invio `incerta` o `caricata` | `resta_da_verificare guasto_transitorio` (il bidello: `prestito_scaduto_senza_tentativo`), non concludente, conta |
| ogni altro caso (solo `numerata` e/o `da_ritentare`, o nessun invio), da ogni lavoro | `rientro guasto_transitorio` (il bidello: `prestito_scaduto_senza_tentativo`), conta |

- **Guasto nostro**: errore del DB o della rete verso Supabase; eccezione del nostro codice; rifiuto inatteso di una RPC del lavoratore (`BAD_INPUT, TENTATIVO_NON_VALIDO, RICERCA_NON_VALIDA, CONTENUTO_NON_VERIFICATO, RICERCA_MANCANTE, RINVIO_NON_PERMESSO, INVII_INCOERENTI, QUOTA_GIA_NUMERATA, FATTURA_NON_CORRISPONDE, FILENAME_MANCANTE`). Si scrive un error `coda-rifiuto-inatteso` con `error_code`, mai distinto per voce.
- **Non sono guasti:** `CANCELLO_PERSO`, `PRESTITO_SCADUTO`, `NON_TUA` → nessuna chiusura, fine del giro; `VOCE_GIA_IN_MANO` → fine del giro (error `voce-gia-in-mano`); `CIRCUITO_APERTO` → `riprova circuito_aperto`; `QUOTA_ORARIA`, `RITMO_MINUTO` → `riprova` col codice; `OLTRE_12_GIORNI` → punti 5 e 6; `NUMERO_GIA_REGISTRATO` → anomalia `numerazione_anomala` da consegnare + `riprova numerazione_anomala` (pausa).
- Una chiusura rifiutata per un rifiuto inatteso si ripete una volta come guasto nostro, secondo la tabella; se anche quella è rifiutata, la voce resta al bidello, e anche questo percorso è limitato dalla conversione c.
- `ricerca_da_ripetere` si usa solo dopo una `invio_ricerca(…,'illeggibile')` riuscita nella presa (l'SQL lo ricontrolla), mai come ripiego di un guasto.

---

## 11. Documento ritrovato: il confronto (decisioni 15 e 29)

**11.1 Dati confrontati.** `DatiDocumento = {sezionale, numero, anno, data, importoCentesimi, destinatario}`. Il nostro si ricava dall'XML del giornale (lavoratore) o da `fatture_emesse.xml_inviato` (sync); quello trovato dal file scaricato con `arubaGetByFilename(…, {includeFile:true, includePdf:false})`. Serie, numero e anno da `<Numero>` con `numeroSezionaleDaEtichetta`; `<Data>`; `<ImportoTotaleDocumento>` in centesimi; destinatario = `CodiceFiscale` del cessionario, altrimenti `IdPaese+IdCodice`, maiuscolo e senza spazi. XML in chiaro o tag ASCII dentro il `.p7m`. Un campo mancante vale `illeggibile`. La stessa `estraiDatiDocumento` ricava `importo` e `data_documento` di `p_invio` (§10.4).

**11.2 Candidati.** Indice dell'anno con `arubaIndiceFattureInviate`: al massimo 20 pagine, una prenotazione per pagina, valido per tutto il giro; un indice incompleto lancia e vale `illeggibile`. Candidati = documenti con stessa serie, numero e anno (nella sync si esclude il nostro file scartato). Si scaricano al massimo 3 candidati, una ricerca prenotata ciascuno; quelli oltre il terzo contano come illeggibili.

**11.3 Esito (`ESITI_RICERCA`).** `combacia`: esattamente un candidato uguale sui 5 campi; `ambigua`: più di uno; `assente`: nessun candidato; `non_combacia`: almeno un candidato, tutti letti, nessuno uguale; `illeggibile`: indice incompleto, oppure un candidato non letto e nessuno uguale. Serie e numero da soli non bastano mai. CF, nomi e contenuti restano solo in memoria.

**11.4 Nel lavoratore** vale §10, punti 5 e 6.

**11.5 00404 nella sync (decisione 29).**
- **`combacia`** → UPDATE della riga, solo sulle colonne WORM (F29): `aruba_filename` del documento consegnato, `sdi_stato=1`, `sdi_stato_label='Presa in carico (originale ritrovato dopo 00404)'`, `sdi_scarto_motivo=null`. Riallineamento del pagamento; `segnala_scarto_sdi(…,'ricollegato')`; warn `doppione-00404-ricollegato`; nessun avviso di scarto. Un 23505 qui vale «non risolto».
- **`non_combacia`** → scarto registrato come oggi e pagamento `scartata` (ritrasmissibile con numero nuovo, livello 1); `segnala_scarto_sdi(…,'non_identico')`; warn `doppione-00404-non-identico`. **(v4, S46)** `fattura_scartata` va a `staffScuola(…, ['coordinator','segreteria'])` meno chi ha accodato, anche per le fatture nate fuori dalla coda.
- **`assente`, `illeggibile`, `ambigua`** → nessuna scrittura su `fatture_emesse` né su `pagamenti`; la riga resta in volo (F26) e la sync riprova. `segnala_scarto_sdi(…,'non_risolto')`; warn `doppione-00404-non-risolto` con `tipo` = esito. Al 6° giro (circa 3 ore) avviso `da_verificare doppione_sdi_irrisolto`, senza `scartata`; la sync continua a riprovare.
- Un giro fermato da cancello, circuito o 429 non conta come «non risolto». Limite dichiarato: un candidato illeggibile per sempre lascia la voce in «Da verificare»; si corregge nel codice.

---

## 12. Route HTTP (contratto di D4 in `src/lib/fatture-coda/api-contratto.ts`)

**Regole comuni.** Risposta `{success:true, data}` oppure `{error, codice, data?}`. Ordine: `withRoute('<percorso>:<METODO>')` → gate (`const auth = await requireStaff(request)`; per la sospensione `requireStaff(request, ['admin'])`, F22) → `parseBody`/`parseQuery` con lo schema di `api-contratto.ts` → `createAdminClient()` → perimetro → `supabase.rpc('fatture_coda_…', { p_attore: auth.user.id, p_scuola_ids, … })` letterale → `leggiEsitoRpc`. Corpi `z.strictObject`. `PERCORSI_CODA` non comprende il giro. Nessuna route della coda chiama Aruba o usa `after()`, tranne il giro.

| Metodo e percorso | Richiesta | Risposta | Gate | Chi la usa |
|---|---|---|---|---|
| `POST /api/pagamenti/fattura/coda/giro` (D3) | header `x-cron-secret`; `{motivo?: /^[a-z-]{1,24}$/}` | 202 `{accettato:true, canale}`; 401 `CRON_NON_AUTORIZZATO`; 400 | solo `segretoCronValido`; `maxDuration = 300` letterale; lavoro in `after()` | pg_cron e sveglia |
| `GET /api/pagamenti/fattura/coda` | `zQueryStato` (`solo_riepilogo?`, `vista` fra attive, inviate, tolte, doppioni_sdi, `stato?`, `sede?`, `gruppo?`, `pagamento?`, `voce?`, `mie?`, `da_verificare_operatore?`, `pagina`, `per_pagina ≤200`) | `{disponibile:true, riepilogo}` o `RispostaStato`; coda assente: 200 `{disponibile:false}`. **(v4)** Per i pagamenti della pagina chiama anche `fatture_coda_stato_pagamenti` (S48): da lì `oltre_12_giorni`, `rimetti_serve_forza`, `rimanda_serve_forza` e la voce attiva per `ritrasmetti`. Errore di lettura ⇒ 500 `LETTURA_FALLITA` | `requireStaff(request)`; perimetro | pagina (30 s), contatore (120 s) |
| `POST /api/pagamenti/fattura/coda` | `zCorpoAccoda` piatto. Multi: `{origine ∈ ORIGINI_MULTI, richiesta_id, urgente, pagamento_ids ≤500, conferme_proposte, periodo?}`. Singolo: `{origine:'singolo', richiesta_id, urgente, pagamento_id, tipo_documento?, intestatario?, causale?: string o null, ricorda_scheda?}` | `RispostaAccoda`; 422 `CODA_TIPO_NON_SUPPORTATO`; 409 `CODA_RICHIESTA_ALTRUI`; 503 | `requireStaff(request)` + `assertPagamentiInScope`; sedi proprie; `maxDuration=300` | `AccodaFattureDialog`, `FatturaButton` |
| `POST /coda/precontrollo` | `{origine, voci:[{pagamento_id, intestatario?}] ≤50}` | `RispostaPrecontrollo` (verdetti con `esito` fra pronta, da_confermare, da_sistemare; `tipo_invio` col predicato di §6) | `requireStaff(request)` + scope | dialogo, a blocchi di 50 |
| `GET /coda/periodo` | `da, a, base` fra bonifico e competenza, `categorie, sedi` | `RispostaPeriodo` (le 500 più vecchie, `restanti`) | `requireStaff(request)`; sedi proprie | «Fattura tutto il periodo» |
| `POST /coda/situazione` | `{pagamento_ids ≤500}` | `RispostaSituazione{disponibile, righe}` (fuori sede omessi) | `requireStaff(request)` | liste, drawer, Transazioni, scheda alunno |
| `POST /coda/togli` | `{voce_ids ≤500}` | `RispostaAzioneMultipla{fatte, rifiutate[{voce_id, codice}]}` | `requireStaff(request)`; perimetro | pagina |
| `POST /coda/rimetti` | `{richiesta_id, voce_ids ≤500, urgente, forza}` | `RispostaRimetti`; `forza` da non admin → 403 `CODA_FORZA_SOLO_ADMIN`; `OLTRE_12_GIORNI` → 409 `CODA_OLTRE_12_GIORNI`; con la forza di un admin l'autorizzazione va sul documento | `requireStaff(request)`; pre-controllo rifatto con `origine_iniziale`, saltate le voci con documento costruito | pagina |
| `POST /coda/urgente` | `{voce_ids ≤500, urgente}` | `RispostaAzioneMultipla` | `requireStaff(request)` | pagina |
| `GET` / `POST /coda/causale` | `?voce_id` / `{voce_id, causale: string(1..1000) o null}` | `RispostaCausaleGet` / `RispostaCausalePost`; 403 `CODA_CAUSALE_ALTRA_SEDE`; 409 | `requireStaff(request)` | dialogo Causale |
| `POST /coda/verifica` | `{voce_id, azione` fra cerca e rimanda`, forza}` (`forza` solo con `rimanda`) | `RispostaVerifica{voce_id, azione, forzata, registrata:true, sveglia, prossimo_giro_il}`, asincrona; 409 `CODA_OLTRE_12_GIORNI`; 403 `CODA_FORZA_SOLO_ADMIN` | `requireStaff(request)` (+ admin per `forza`) | dialogo Da verificare |
| `POST /coda/sospensione` | `{sospesa, motivo? ≤200}` | `RispostaSospensione{sospesa, il, gia, avvisi_spediti}`; poi `await spedisciAvvisiCoda()` | `requireStaff(request, ['admin'])` | pagina (admin) |
| `POST /api/pagamenti/fattura`, `POST …/lotto` | — | **410** `FATTURA_EMISSIONE_SOLO_IN_CODA`; GET del PDF e `/anteprima` invariati | — | nessuno |
| `GET /api/pagamenti/riconciliazione` | invariata | righe abbinate con `coda: {voce_id, stato, urgente, numero_assegnato}` o null; meta `coda_disponibile`. Qualunque errore nella lettura della coda ⇒ `coda: null`, `coda_disponibile:false`, rotta come oggi (warn `coda-non-migrata` o error `rpc-guasta`, F33) | invariato | Riconciliazione |
| `POST /api/pagamenti/fattura/sync` | invariata | cancello (§10), 00404 (§11.5), `fattura_scartata` secondo S46, `tipo` nel battito | cron | pg_cron `fatture-sdi-sync` |
| `GET /api/health` | — | settimo controllo `coda-fatture` (§16) | pubblico | monitor |

**Tipi condivisi.**
- `RiepilogoCoda`: `contatori{in_coda, in_invio, da_verificare, da_verificare_operatore, doppioni_sdi, errori, emesse_oggi, tolte_oggi, per_livello{rimandate, ritrasmissioni, urgenti, normali}}`; `bollino_rosso = da_verificare + doppioni_sdi > 0`; `upload_ultima_ora`, `soglia_oraria`; `stima_fine`, `prossimo_giro_il`, `ultimo_giro_il`, `giro_in_corso`; `pausa`, `circuito`; `sospesa{il, da_nome, da_sistema, motivo}` o null; `in_attesa_piu_vecchia_dal`; `gruppi_miei[]`.
- **`VoceInElenco` (v4, forma unica, S47)**:
  - identità e ordine: `voce_id, pagamento_id, gruppo_id, stato: StatoVoce, lavoro: LavoroVoce | null, livello: 0..3, motivo: MotivoVoce, tipo_documento, urgente, rimandata` (= `reinvio_pendente`), `posizione: number | null, stima_invio: string | null`;
  - `sede{id, nome}`, `alunno{nome, cognome} | null`, `importo, periodo_competenza, categoria, descrizione`, `gruppo{origine, urgente, creato_il}`, `accodata_il, in_attesa_dal, accodata_da: string | null` (nome), `tolta{il, da_nome} | null`, `rientri_guasto`;
  - `verifica: {dovuta_il, auto_esito: 'non_trovata' | null, azione_richiesta: 'cerca' | 'rimanda' | null, azione_richiesta_il, azione_richiesta_da: string | null} | null`: chiavi = colonne `verifica_dovuta_il`, `verifica_auto_esito`, `azione_richiesta*`; `azione_richiesta_da` è il nome risolto dal server, mai l'uuid; presente per `da_verificare` e per `in_invio` con lavoro `verifica`;
  - `esito: {codice: CodiceEsitoVoce, messaggio: string | null, http, il} | null` (messaggio solo per la sede propria);
  - **`invii_aperti: InvioAperto[]`** (gli invii `numerata, in_volo, caricata, da_ritentare, incerta` della voce, per quota): `{invio_id, stato: StatoInvio, sezionale, numero: number, anno, numero_leggibile: string, data_documento, importo, quota_label, tentativi, esito_codice, esito_il, dettaglio: string | null` (solo sede propria)`, aruba_filename, ricerca_esito, ricerca_il, ricerche_fallite, consecutivi_429, oltre_12_giorni: boolean` (solo da `invii_oltre_limite`)`, tardiva_autorizzata: boolean}`;
  - **`fatture: FatturaDellaVoce[]`** (le righe di registro legate agli invii della voce; per `emessa gia_a_registro` le righe del pagamento): `{fattura_emessa_id, sezionale, numero: number, anno, numero_leggibile: string | null, data_documento: string | null` (dall'invio del giornale; null senza invio, F39)`, quota_label, sdi_stato, sdi_stato_label, scartata: boolean` (= `!fatturaViva(riga)`)`}`;
  - `numero_leggibile` = `numeroLeggibile()` di `src/lib/pagamenti/fatture-dei-pagamenti.ts` (spostata da `riconciliazione/route.ts:981-990`, invariata, F40) per entrambi;
  - `propria_sede`, `causale_modo`, `causale_manuale | null` (null fuori sede);
  - `azioni: AzioniVoce = {togli, rimetti, rimetti_serve_forza, urgente, causale, cerca, rimanda, rimanda_serve_forza, ritrasmetti}`, calcolate dal server (`azioniAmmesse`): `togli` = `in_coda`/`errore` senza alcun invio, oppure `errore` con invii tutti `rifiutata`/`bruciata` (C0.2 D1; letto dal campo additivo `solo_invii_non_consegnati` di `fatture_coda_stato_pagamenti`, §9.5, senza ripiego in TS); su `errore numero_conteso` `rimetti` vero e `rimanda` falso per costruzione (la voce non è `da_verificare`, C0.2 D3); `rimetti` = `errore`, e `rimetti_serve_forza` = un `numerata` in `invii_oltre_limite`; `urgente` = `in_coda`; `causale` = sede propria, `in_coda`/`errore`, nessun invio aperto; `cerca` = `da_verificare` senza azione richiesta; `rimanda` = `da_verificare` senza azione richiesta con un invio non caricato, e `rimanda_serve_forza` = `invii_oltre_limite` non vuoto; **`ritrasmetti`** = sede propria, stato `emessa`, almeno una `fatture[].scartata`, pagamento `fattura_stato='scartata'` e `stato='pagato'`, nessuna voce attiva del pagamento (comprende il doppione `doppione_sdi` aperto; esclude `doppione_sdi_irrisolto`).
  - Mai intestatario o CF. D5 mostra i comandi solo da `azioni` e non ricalcola stati, limiti o numeri.
- `StatoPagamentoCoda` (in `contratto-db.ts`): `{pagamento_id, voce_id, stato, urgente, livello, numero_assegnato, invii_oltre_limite: InvioOltreLimite[]}`, con `InvioOltreLimite = {invio_id, stato, data_documento, giorni}`.

**Codici HTTP** (`CHIAVI_MESSAGGIO_CODA`): `CODA_FATTURE_NON_DISPONIBILE` 503, `CODA_ERRORE_INTERNO` 500, `CODA_ATTORE_NON_AUTORIZZATO` 403, `CODA_VOCE_NON_TROVATA` 404, `CODA_VOCE_IN_LAVORAZIONE` 409, `CODA_NUMERO_GIA_ASSEGNATO` 409, `CODA_STATO_NON_VALIDO` 409, `CODA_OLTRE_12_GIORNI` 409, `CODA_FORZA_SOLO_ADMIN` 403, `CODA_CAUSALE_ALTRA_SEDE` 403, `CODA_PAGAMENTO_NON_SALDATO` 409, `CODA_PERIODO_NON_VALIDO` 400, `CODA_TIPO_NON_SUPPORTATO` 422, `CODA_RICHIESTA_ALTRUI` 409, `FATTURA_EMISSIONE_SOLO_IN_CODA` 410. Si riusano `SEDE_NON_ACCESSIBILE`, `PAGAMENTO_NON_TROVATO`, `LETTURA_FALLITA`, `CRON_NON_AUTORIZZATO`. `MAPPA_RIFIUTO_HTTP: Record<CodiceRifiuto, …>` è esaustiva.

**`MOTIVI_NON_PRONTA`:** `pagamento_inesistente, non_saldato, gia_fatturata, in_attesa_sdi, partita_non_registrata, trasporto_in_sospeso, gia_in_coda, senza_bonifico_confermato, intestatario_da_scegliere, intestatario_dati_incompleti, quote_non_fatturabili, proposta_da_confermare, persona_incompleta, sede_non_configurata, causale_non_componibile, lettura_fallita, tipo_non_supportato`; solo nel client `controllo_interrotto`. Idoneità: il multiplo accetta solo `daFatturareInListaDiLavoro`; il singolo qualunque saldato; la proposta solo con `conferme_proposte` uguali. `causale_modo`: multi `composta`; singolo con stringa → `manuale`, con `null` → `composta`, assente → `invariata`.

---

## 13. Moduli TS (firme condivise; il dettaglio nel campo `moduli_ts`)

- **`contratto-db.ts` (D2, usabile nel browser)**: costanti del §4; per ogni elenco la mappa e la tupla; insiemi e transizioni; gruppi di codici; `CODICI_AVVISO_*`, `MODO_DA_VERIFICARE`; `codiceUpload`, `codiceScarto`; `CODICI_SCHEMA_ASSENTE`; `RPC_CODA`; i tipi di ritorno delle RPC. **(v4)** `STATI_SDI_SCARTO`, `CHIAVI_RIGA_REGISTRO`, `MAX_RIGA_REGISTRO_BYTES`; tipi `InvioDaRegistrare`, `NumeroBruciatoDaRegistrare`, `RigaRegistroDelGiornale`, `DatiAvviso` (per tipo, con `anomalia?` e `fine_gruppo?`), `FineGruppo`, `AnomaliaDaConsegnare`, `StatoPagamentoCoda`, `InvioOltreLimite`.
- **`rpc.ts` (D2)**: `leggiEsitoRpc<T>(risposta, nome)`, `schemaCodaAssente(err)`. Non chiama RPC.
- **`api-contratto.ts` (D4)**: schemi e tipi del §12, compresi `VoceInElenco`, `InvioAperto`, `FatturaDellaVoce`, `AzioniVoce`, `VerificaVoce`.
- **`stato-coda.ts` (D4)**: `componiVoceInElenco`, `azioniAmmesse` (con `oltreLimite` da `stato_pagamenti`, mai ricalcolato), `stimeDaPosizioni`.
- **`fatture-dei-pagamenti.ts` (D4)**: `numeroLeggibile`, unica per `invii_aperti` e `fatture`.
- **`stima.ts` (D3)**: `simulaInvii(p, quante?)`, `prossimoTick(adesso)`.
- **`notifiche.ts` (D5)**: `spedisciAvvisiCoda(supabase, opz?)`; non lancia mai.
- **`testi-notifica.ts` (D5)**: `testoAvviso(avviso, adesso)`, esaustivo su tipo, codici, `dati.anomalia` e `dati.fine_gruppo`.
- **`vocabolario-log.ts` (D6)**: §15.
- **`classifica.ts` (D3)**: la tabella del §10.11.
- **`scarti.ts` (D3)**: `ruoliFatturaScartata(doppione)` → `['coordinator','segreteria']` con `non_identico`, altrimenti `['admin','coordinator','segreteria']` (S46).
- **Strato Aruba (D3)**: `confronto-documento.ts` (`estraiDatiDocumento`, `confrontaDocumentoTrovato`, `esitoRicerca`), `client.ts`, `emissione.ts` (`GiornaleEmissione.apriInvio(doc: InvioDaRegistrare)`), `reinvio.ts`; tipi via `import type` da `contratto-db.ts` (S35).
- **Firme interne di D3 usate da altri**: `eseguiGiroCoda`, `emettiVoce`, `giornaleDi`, `creaSessioneArubaCancellata`, `riallinea00404`, `ricordaPersonaSullaScheda`.

---

## 14. Notifiche — un solo meccanismo

> **Riallineamento 2c (24/09).** Per il nucleo valgono `nucleo.md` §6 e `consegna-2c-notifiche.md` §1.5: niente outbox, tipi fuori catalogo, segni sulle voci e sulla riga di stato, scarto SdI allo staff della sede com'era. Questa sezione resta il riferimento del piano completo.

1. **In SQL**, nella stessa transazione del fatto, l'avviso entra in `fatture_coda_avvisi` (§8.4). `chiave_dedup` UNIQUE = un avviso per evento. **(v4)** Un fatto, un avviso (S44): l'anomalia del fatto sta dentro l'avviso della voce; la fine del gruppo si attacca all'avviso in attesa (S45). Gli errori senza anomalia si aggregano per gruppo finché l'avviso non è preso.
2. **`spedisciAvvisiCoda()`**:
   1. `fatture_coda_avvisi_prendi(token, limite)`;
   2. idempotenza: si legge `notifiche.select('entita_id').eq('entita_tipo','fattura_coda_avviso').in('entita_id', ids)`; gli avvisi già presenti si confermano senza rispedirli;
   3. destinatari di ciascun avviso = `{destinatario_id}` ∪ admin delle sedi reali (senza collaudo) se `a_tutti_gli_admin`, senza doppioni: un admin che ha anche accodato riceve una notifica. Se la lettura degli admin fallisce l'avviso resta (warn `destinatari-non-risolti`); con elenco vuoto l'avviso si conferma come «saltato» (warn);
   4. `enqueueNotifiche(supabase, {utenteIds, tipo: TIPO_NOTIFICA_DI_AVVISO[tipo], titolo, corpo, link, entitaTipo:'fattura_coda_avviso', entitaId: avviso.id, bufferMin: 0})`, senza `scuolaId`, una chiamata per avviso, testi da `testoAvviso`;
   5. riscontro (F19): si rilegge `notifiche` per gli id spediti e si confermano solo quelli presenti; gli assenti tornano col lease (fino a 10 tentativi, poi `avviso-abbandonato`); warn `notifica-non-trovata`;
   6. `fatture_coda_avvisi_conferma(token, confermati)`; se fallisce, warn `conferma-fallita`; al giro dopo il passo 2 li conferma senza rispedirli.
3. La campanella si aggiorna subito; la push parte al giro successivo di `notifiche-dispatch` (5'). Nessuna fascia notturna.

**Chi chiama `spedisciAvvisiCoda()`**: il lavoratore nel `finally` di ogni giro (anche a coda ferma), la sync dopo le segnalazioni, la route `sospensione` dopo la RPC. Nessun altro compone notifiche della coda. `src/lib/push/enqueue.ts` e `src/lib/notifiche/destinatari.ts` non si modificano.

**Catalogo:** 9 tipi `fattura_coda_*` con `obbligatoria: true` (niente interruttore, `isNotificaAbilitata` sempre `true`); etichette in `messages/{it,en}/etichette.json`.

**Testi.** Solo da `tipo` e `dati` (orari Europe/Rome), mai nomi. Per `da_verificare` e `verifica_manuale` la frase dipende dal codice (§8.6). L'avviso `errore` con `n=1` cita numero e causa, con `n>1` il conteggio. `dati.anomalia` e `dati.fine_gruppo` aggiungono la loro frase. Link interni con soli uuid.

**Scarti SdI (S46).** `fattura_scartata` resta allo staff della sede, col suo interruttore, meno chi ha accodato; con `non_identico` solo a coordinator e segreteria (meno chi ha accodato). Chi ha accodato riceve `scarto_sdi` dall'outbox, oppure `da_verificare doppione_sdi` per il 00404 non identico; per il non risolto nessun avviso di scarto. Gli admin, nel 00404 non identico, ricevono solo il `da_verificare` con `dati.anomalia`.

**Conseguenza misurabile (rilievo 1).** Casi (a) `registro_mancante`, (b) `errore numero_conteso` (C0.2 D3), (c) conversione c, (d) 00404 non identico: ogni admin riceve **una** notifica; un gruppo di una fattura finito in errore o da verificare dà **una** notifica a chi l'ha accodato.

---

## 15. Log e battito — vocabolario (`vocabolario-log.ts`, D6)

**Regole.** Chiavi stringa solo fra `tipo, stato, esito, azione, operazione, canale, error_code, anno`; uuid sotto `*_id`; numeri come numeri; istanti sotto `fino_a`. Mai `motivo`, `origine`, `titolare`. L'errore va come quarto argomento. **Livelli:** `info` per il normale; `warn` per ogni esito atteso (429, incerto, prestito scaduto, da verificare, errore di dato, rientro, pausa, circuito, ricerca non riuscita, 00404, oltre 12 giorni); `error` solo per guasti veri e mai con `distingui` per voce (F25).

**Battito della route del giro:** `logEvento('cron', livello, {operazione:'fatture-coda-tick', esito, tipo, azione?, canale, fino_a?, ms, posti, voci, emesse, errori, da_verificare, riprove, upload, ricerche, accessi, error_code?}, undefined, {distingui:['tipo']})`.
- `esito='ok'`, `info`: `coda-vuota, giro-concluso, tetto-giro, tempo-esaurito, quota-esaurita, circuito-aperto, in-pausa, sospesa, cancello-occupato, cede-alla-sync, ricerca-rinviata`; `ok` a `warn`: `circuito-aperto-ora`, `pausa-aperta-ora`.
- `ok-parziale`, `warn`: `coda-assente`. `guasto`, `error`: `guasto-cancello`, `guasto-coda`, `eccezione` (non contano come battito).
- Altri esiti della route: `secret-errato` (error, solo con header), `corpo-non-valido` (error), `after-non-disponibile` (warn).

| evento · operazione | esiti e livelli |
|---|---|
| `cron` · `fatture-coda-tick` (SQL) | `url-assente`, `post-fallito`, `tick-esito-http`, `tick-bidello-fallito`, `sveglia-url-assente`, `sveglia-post-fallito`, `cron-non-programmato`: error; `tick-esito-non-letto`, `sveglia-net-assente`: warn |
| `cron` · `fatture-coda-pulizia` (SQL) | battito `ok`, `azione='conservazione-24-mesi'`, `n_*`, fingerprint `cron:fatture-coda-pulizia` |
| `cron` · `fattura-sync` | `tipo` nel battito fra `niente-in-volo, lavorato, cancello-occupato, circuito-aperto, circuito-aperto-ora, guasto-cancello`; `doppione-00404-ricollegato`, `doppione-00404-non-identico`, `doppione-00404-non-risolto` (`tipo` = assente, illeggibile o ambigua): warn |
| `fattura` · `fatture-coda` — info | `accodate`, `sospesa` (`tipo` admin o sistema), `ripresa`, `tardiva-autorizzata` (SQL, con `n`), `coda-emessa`, `coda-riprova`, `coda-verifica-rinviata`, `arrivo-registrato`, `ritrasmessa`, `ricerca-conclusa`, `coda-precontrollo`, `coda-periodo-selezionato`, `coda-tolte`, `coda-rimesse`, `coda-urgenza`, `coda-causale`, `coda-verifica-richiesta`, `coda-schema-assente` |
| `fattura` · `fatture-coda` — warn | `circuito-aperto`, `pausa-esito-incerto`, `numero-non-usato`, `rilascio-con-voci-in-mano`, `cancello-prestito-scaduto`, `rientro-guasto`, `prestito-scaduto`, `esito-incerto`, `esito-tardivo`, `aruba-429-ripetuto`, `ricerca-non-riuscita`, `coda-errore`, `coda-da-verificare`, `registro-riparato`, `coda-non-migrata`, `coda-avvisi-non-spediti`, `coda-nomi-non-risolti`, `emissione-diretta-rifiutata` |
| `fattura` · `fatture-coda` — error | `numero-bruciato`, `anomalia` (distinta solo per tipo, scritta quando l'anomalia nasce), `cancello-perso`, `non-tua`, `voce-gia-in-mano`, `invii-incoerenti`, `numero-gia-registrato`, `fattura-non-corrisponde`, `bad-input`, `avviso-abbandonato`, `voce-non-chiusa`, `giornale-incoerente`, `rpc-guasta`, `coda-rifiuto-inatteso` |
| `fattura` · `aruba-cancello` | `occupato`, `rifiutato-signin`, `rifiutato-ricerca`: info; `circuito-aperto`, `assente`: warn; `guasto`, `forma-inattesa`: error; `tipo` = titolare |
| `fattura` · `emettiFatturaPagamento:*` | `numero-rinviato` (info; warn con `tipo=guasto`), `pagamento-non-toccato-rinvio` (info), `giornale-non-aperto` (error); di D1: `pavimento-sopra-contatore`, `partita-non-registrata-fermata` warn; `pavimento-fuori-scala`, `registro-*` error |
| `fattura` · `aruba:findByUsername` | `indice-concluso` (info) |
| `fattura` · `fatture-coda-avvisi` (D5) | `spediti` (info); `avvisi-non-leggibili`, `invio-fallito`, `destinatari-non-risolti`, `notifica-non-trovata`, `conferma-fallita` (warn) |

Il lock `fatture-coda-log-vocabolario` (D6) raccoglie ogni `esito:`/`tipo:` di `src/lib/fatture-coda/**`, delle route della coda, della sync e delle chiamate `_fatture_coda_log(...)` nelle migrazioni, e verifica vocabolario e livello.

---

## 16. `/api/health` — decisione 23

- Settimo controllo `coda-fatture`: `controlloCodaFatture(supabase, adesso)` in `src/lib/health/controlli.ts`, dentro `misura('coda-fatture', 'degradato', …)`, in parallelo in `eseguiControlli` (F28). Chiama `supabase.rpc('fatture_coda_salute')`.
- «Guasto» = `degradato` (`giu` resta a `db-lettura`), **solo** se: (1) `in_attesa_piu_vecchia_dal < adesso − 24 h` (minimo di `in_attesa_dal` sulle voci `in_coda`/`in_invio`, azzerato a ogni ingresso: un «Rimetti» riparte da zero); (2) `sospesa` con `sospesa_il < adesso − 24 h`.
- Errore con codice in `CODICI_SCHEMA_ASSENTE` → `ok` con nota «coda non ancora installata». Qualunque altro errore, o il tetto di `misura`, → `degradato` col solo codice, mai il `message`. Tutto il resto → `ok` con dettaglio numerico. Nessun'altra strada verso `degradato` per esiti attesi, che stanno a `warn`. Resta la sorveglianza del battito di `JOB_CRON` (PR-B).
- **Casi di `__tests__/lib/health/coda-fatture.test.ts`** (D6), ognuno con prova di rottura: 24 h − 1 s e 24 h + 1 s su `in_attesa_piu_vecchia_dal` e su `sospesa_il`; voce rimessa dopo 3 giorni in errore ⇒ `ok`; `PGRST202` e `42883` ⇒ `ok` con nota; ogni codice di `CODICI_SCHEMA_ASSENTE` ⇒ `ok`; un altro codice ⇒ `degradato` col solo codice; tetto superato ⇒ `degradato`; 7 da verificare + 3 errori di dato in 15' ⇒ `controlloTassoErrore` `ok` (livelli da `LIVELLO_LOG_CODA`).

---

## 17. Test (decisione 27)

### 17.1 SQL vero: PGlite sulle migrazioni reali (D2)
- **Helper** `__tests__/helpers/fatture-coda-pglite.ts`, `creaDbCoda()`: stub di `schools`, `auth.users`, `utenti(id, ruolo, scuola_id, archiviato_il)`, `utenti_scuole`, `pagamenti`, `fatture_emesse` (con `sdi_stato`), `app_log`, `cron_config(p_nome text) RETURNS text`, schema `net` (spia di `http_post`, `_http_response`), schema `cron` (spia di `schedule`/`unschedule`). Ruoli `anon`, `authenticated`, `service_role BYPASSRLS`. Carica i tre file dal disco. Espone `sql()`, `impostaAdesso(iso)`/`avanza(ms)`, `postInviati()`, `cronProgrammati()`, `log()`, `avvisi()`, `semina.{…}`, **`xmlDiProva({sezionale, numero, anno, data, importo, progressivo})`** (v4). Senza fusi orari si sostituisce solo `_fatture_coda_oggi_fiscale()`.
- `fatture-coda-schema.test.ts`: RLS e privilegi; ogni coppia di `TRANSIZIONI_VOCE`/`TRANSIZIONI_INVIO` (le vietate danno `23514`); `→ tolta` vietata con un invio; transizioni dell'`esito_codice` di una `emessa`; immutabili; minimizzazione; «una attiva»; `in_attesa_dal` sui tre ingressi; CHECK `destinatario_id IS NOT NULL OR a_tutti_gli_admin`; `tardiva_autorizzata_il` una volta e mai azzerata; `consecutivi_429` a 0 a `caricata`/`registrata`/`rifiutata`; **(v4)** `anomalia_da_consegnare` vietata fuori da `in_invio`; CHECK di `riga_registro` e `importo`.
- `fatture-coda-cancello.test.ts`: `prendi` (scrive `ultimo_giro_il` anche rifiutando), `prenota`, `esito`, circuito a +59:59 e +60:00, accesso a 64,9 s → `SIGNIN_TROPPO_PRESTO`, a 65,0 s → ok; quota al 3° con limite 2; `non_eseguito`; prenotazione di reinvio oltre 12 giorni → `OLTRE_12_GIORNI`; contatore dei 429 (+1 su upload, pagina e download legati; 0 su non-429 a un upload; invariato su pagina/download `ok`, `rete`, `non_eseguito`; `somma_voce`; il 429 della sync non conta); **(v4)** 401 su `signin` ⇒ un solo avviso `anomalia` al giorno.
- `fatture-coda-lavoratore.test.ts`:
  - ordine della decisione 2; giornale completo; `RICERCA_MANCANTE` su `invio_tenta` senza ricerca; `CONTENUTO_NON_VERIFICATO`; `numero_conteso` (C0.5 n. 1: `non_combacia` su `da_ritentare` e su `incerta` ⇒ `bruciata` con `tentativi ≥ 1` accettato da `_tentativo_chk`; `numero_bruciato` con `p_codice='numero_conteso'` ⇒ `BAD_INPUT`; `invio_tenta` su `incerta` con ricerca `non_combacia` impossibile; `chiudi('errore','numero_conteso')` senza l'invio conteso ⇒ `BAD_INPUT`; `chiudi('emessa')` con la quota contesa ⇒ `INVII_INCOERENTI`); `ambigua`;
  - **(v4) forma di `p_invio`**: XML di prova valido ⇒ ok; chiave in più, `riga_registro` con `xml_inviato`, `importo` diverso da `<ImportoTotaleDocumento>`, `<Numero>` o `<ProgressivoInvio>` diversi, `data_documento` di due giorni fa ⇒ `BAD_INPUT{campo}`;
  - ricerche: 3 `illeggibile` ⇒ `incerta ricerca_non_riuscita`, voce `da_verificare`, avviso `verifica_manuale`; `chiudi(…,'ricerca_da_ripetere')` senza una ricerca `illeggibile` nella presa ⇒ `RICERCA_MANCANTE`; rinvio di 4' e salto nello stesso giro;
  - terzo 429: i sei casi della v3 (sequenze upload/pagina, somma su due invii, `rientro` con somma 3, azzeramento da `richiedi_verifica`), con prova di rottura sull'azzeramento da pagine riuscite;
  - `0034`; 12 giorni a 12 e 13 giorni (`prossima`, `invio_tenta`, `errore oltre_12_giorni`, `da_verificare oltre_12_giorni`, autorizzazione);
  - guasti: 4 `rientro` con un `numerata` ⇒ `errore guasto_ripetuto`; con un `da_ritentare` ⇒ `incerta guasto_ripetuto`, voce M; `rientro` dalla verifica; `INVII_INCOERENTI` con `incerta`, `caricata`, `in_volo`; 4 guasti in verifica ⇒ `resta` concludente;
  - **(v4) bidello nei 5 rami**: `in_volo`; emissione con `incerta` `gia_ricevuta_0034` e con `incerta` `upload_5xx` (⇒ `prestito_scaduto`); emissione con `caricata` (⇒ `registro_mancante`); verifica con `incerta`; soli `numerata`/`da_ritentare` (⇒ `rientro`). Prova di rottura: senza i rami 2 e 3 la voce resta `in_invio` (`INVII_INCOERENTI`);
  - **(v4) un fatto, un avviso**: (a) `chiudi('da_verificare','registro_mancante')` e il ramo 3 del bidello ⇒ una sola riga (`da_verificare`, `a_tutti_gli_admin`, `dati.anomalia='partita_non_registrata'`) e nessuna riga `anomalia`; (b) `chiudi('errore','numero_conteso')` ⇒ una riga `errore` non aggregata, con gli admin e `dati.anomalia='numerazione_anomala'` (C0.2 D3); (c) conversione c nelle tre uscite ⇒ una riga (`verifica_manuale`, oppure `errore` non aggregato con gli admin) con `dati.anomalia='guasti_ripetuti'`; parcheggio: `numero_bruciato` + `rientro` ⇒ una riga `anomalia`; `numero_bruciato` + `errore` ⇒ una riga `errore` con anomalia e admin; `segnala_anomalia` con voce in mano e morte del lavoratore ⇒ il bidello la consegna; seconda anomalia dello stesso fatto ⇒ solo evento;
  - **(v4) fine del gruppo**: gruppo di una voce chiuso `errore` ⇒ una riga `errore` con `dati.fine_gruppo` e nessuna `gruppo_concluso`; chiuso `da_verificare` ⇒ una riga; gruppo tutto emesso ⇒ `gruppo_concluso`; avviso d'errore già preso ⇒ `gruppo_concluso`;
  - errori dello stesso gruppo prima dello spedisci ⇒ un avviso con `n=2`; avvisi una sola volta.
- `fatture-coda-staff.test.ts`:
  - `accoda`: tutti i codici, TD04, `TRASPORTO_IN_SOSPESO`, idempotenza, gruppo vuoto cancellato, `origine_iniziale`, doppione ritrasmesso; **(v4) motivo**: pagamento `scartata` senza righe ⇒ `prima_emissione`, livello 3, dietro i gruppi più vecchi; riga con `sdi_stato` 2, 4 o 9 ⇒ `ritrasmissione`, livello 1; riga consegnata ⇒ `prima_emissione`;
  - `togli` su una voce con quota `registrata` e su una con sola `rifiutata` ⇒ `NUMERO_GIA_ASSEGNATO`; `rimetti` di un `errore oltre_12_giorni` (senza forza, forza da non admin, forza di un admin con autorizzazione e stesso XML); `urgente`; `causale`; `richiedi_verifica` (forza solo con `rimanda`, azzeramenti);
  - sospendi/riprendi, `sospendi(NULL, motivo)`; riepilogo, posizioni, salute dopo una rimessa a 3 giorni = istante della rimessa, oblio;
  - **(v4) `stato_pagamenti`**: `invii_oltre_limite` vuoto a 12 giorni, pieno a 13 (con `giorni=13`) per `numerata`, `da_ritentare` e `incerta`, vuoto con `tardiva_autorizzata_il` e per un `caricata`;
  - `segnala_scarto_sdi` nei 4 valori; **(v4) (d)** `non_identico` ⇒ una sola riga `da_verificare` con `dati.anomalia`, nessuna riga `anomalia`; `non_risolto` ×6 ⇒ un avviso e voce `doppione_sdi_irrisolto`; poi `ricollegato` ⇒ `sdi_ricollegata`; uscita da `doppioni_aperti`;
  - un admin che ha accodato è un solo destinatario (riga unica); ogni riga di `app_log` ha il livello del vocabolario.
- `fatture-coda-cron.test.ts`: tick senza URL → error; tick che posta con timeout 300000 senza nessun client; pulizia; schedule. Sveglia: (0) riga iniziale con `ultima_sveglia_il` e `ultimo_giro_il` NULL: il primo accodamento fa un POST, con prova di rottura sui COALESCE; (a) due accodamenti con un giro in mezzo ⇒ due POST; (b) accodamento durante il giro ⇒ POST al `rilascia`; due accodamenti a 10 s ⇒ un POST, dopo 60 s senza giro il secondo; sospesa, pausa o circuito ⇒ nessun POST; `net` assente ⇒ warn e accodamento riuscito.
- Limite dichiarato: una connessione sola, quindi `SKIP LOCKED` e le corse non si provano.

### 17.2 Aruba finto — uno solo (D6)
`__tests__/helpers/aruba-finto.ts`: stub di `globalThis.fetch` per percorso sugli host veri (`/auth/signin`, `/services/invoice/upload`, `/services/invoice/out/findByUsername`, `/services/invoice/out/getByFilename`, `/services/notification/out/getByInvoiceFilename`). Espone `accoda`, `contatori`, `chiamate`, `ripristina` e risposte pronte (`accettata`, `scartoMerito`, `doppione0034`, `troppeRichiesteHtml`, `erroreServer`, `corpoIlleggibile`, `reteCaduta`, `credenzialiRifiutate`, `paginaIndice`, `documentoConFile`, `documentoSenzaDestinatario`). Lancia su una chiamata imprevista.

### 17.3 Il test cardine (decisione 0) — `__tests__/lib/fatture-coda/coda-senza-browser.test.ts` (D6)
- **Impianto:** PGlite con i tre file veri; `__tests__/helpers/supabase-su-pglite.ts` = client con `.rpc()` completo e `.from()` in sola lettura; ogni scrittura via `.from` lancia; Aruba finto. `vi.mock` di `@/lib/supabase/server-client` (`createAdminClient` → PGlite; `createLogClient` → client che scarta, battito verificato con una spia su `logEvento`), `next/server` (`after` cattura), `@/lib/fatture-coda/emetti-voce` (finta col giornale vero e `arubaUpload` vero), `@/lib/aruba/accesso`, `@/lib/fatture-coda/notifiche` (conta), `@/lib/auth/require-staff` e `next/headers` (lanciano). Il documento vero entra nel giornale nel test ponte (§17.6), non qui.
- **Scenario 1:** 120 voci in 3 gruppi di 3 sedi al minuto 0; poi solo la route del giro con `x-cron-secret` ai minuti ≡2 (mod 5); un urgente a metà. Asserzioni: 120 `emessa` con un solo invio `registrata`; ≤50 upload in ogni 60'; ≤15 per giro; l'urgente prima dei gruppi normali; fine entro un tick da `simulaInvii`; la fine di ogni gruppo arriva una volta (`gruppo_concluso` oppure `dati.fine_gruppo`); battito `ok` a ogni tick; zero chiamate a `requireStaff`, `cookies`, `headers`.
- **Scenario 2:** in più, una voce `da_verificare` col candidato illeggibile per sempre: le 120 escono; quella voce finisce `da_verificare ricerca_non_riuscita` con `verifica_manuale` dopo 3 giri; non più di 3 giri persi.
- **Scenario 3:** in più, una voce il cui upload riceve sempre 429, con pagine buone: tre 429 a un'ora di distanza, poi `da_verificare aruba_429_ripetuto`; nessun quarto upload; le altre escono.
- **Prove di rottura:** route senza `after`; giro che si ferma dopo una voce; `prossima` senza il salto `giro = fence` (scenario 2); azzeramento del contatore sulle pagine riuscite (scenario 3).

### 17.4 E2E Playwright simulati (D6) — `e2e/admin-coda-fatture.spec.ts` + `e2e/lib/coda-fatture-finta.ts`
Risposte simulate con i tipi di `api-contratto.ts`; `serviceWorkers:'block'`, `retries: 0`; presenza prima dell'assenza; `aria-disabled` letto dall'attributo; nessuna chiamata ai POST vecchi. Casi: riconciliazione; Urgente; contante non selezionabile; periodo 612 → 500; scheda alunno; singolo su contante; menu con bollino; banner 429; visibilità fra sedi; togli; rimetti multiplo; verifica con blocco a 12 giorni e forza admin; sospendi solo admin con `STORAGE.segreteria`; coda indisponibile; «Togli» `aria-disabled` su un errore con numero assegnato (salvo C0.2 D1); doppione SdI irrisolto senza comandi e con «NON riemetterla»; «Rimetti» di un `errore oltre_12_giorni` (serve un admin, l'admin forza); **(v4)** voce di un pagamento a due quote con due `invii_aperti`; (C0 G3) trigger in linea «Riprova fattura» su una voce emessa con fattura scartata, che apre «Metti in coda la fattura» con POST singolo, assente con `ritrasmetti=false` o su voce d'altra sede; (C0.2) «Togli» attivo su errore con soli invii `rifiutata`/`bruciata`; `errore numero_conteso` senza «Rimanda»; `trasporto_ignoto` a 13 giorni con «Rimanda» che chiede la forza. Nessuna migrazione del DB di CI, niente seed nuovo, niente `ci.yml`. **(C0.2 D1 e D3, C0.5)** Più due casi dai default: «Togli» attivo su un `errore` con soli invii `rifiutata`/`bruciata` e `aria-disabled` con un invio `registrata` (E20 di D6); voce `errore numero_conteso` con «Rimetti in coda» e senza «Rimanda» (E21).

### 17.5 Lock
- **D2 `fatture-coda-contratto-specchio`**: CHECK dell'SQL uguali alle liste TS; costanti IMMUTABLE uguali allo specchio (anche `STATI_SDI_SCARTO`, confrontata con `mapStatoAruba(c).isScarto` per c da 0 a 20, e `CHIAVI_RIGA_REGISTRO`); ogni `RPC_CODA` con `REVOKE`/`GRANT`; ogni `.rpc('fatture_coda_…'` o `'aruba_cancello_…'` letterale nel repo sta in `RPC_CODA`; job e percorso nel file 3; `const JOB = 'fatture-coda-tick'`; parole-guardia assenti dai file 2 e 3; ogni codice scritto dall'SQL sta nelle liste (anche `dati.codice` e `dati.anomalia` degli avvisi). In `src/lib/fatture-coda/**` (tranne `contratto-db.ts`), in `src/app/api/pagamenti/fattura/coda/**` e in `sync/route.ts` nessun letterale uguale a un valore di `STATI_VOCE`, `STATI_INVIO`, `ESITI_RICERCA`, `ESITI_DOPPIONE`, `TIPI_ANOMALIA` o `CODICI_*`, salvo eccezioni dichiarate e contate, con controllo positivo.
- **D4 `fatture-coda-api-contratto`**: schemi importati da `api-contratto.ts`; `.rpc` letterale con `p_scuola_ids` (tranne sospendi e riprendi) e `p_attore: auth.user.id`; `MAPPA_RIFIUTO_HTTP` completa.
- **D5 `fatture-coda-ui-contratto`**: nei componenti nessun letterale di stato fuori da `ui-stati.ts`, nessun percorso fuori da `PERCORSI_CODA`, nessuna chiamata ai POST vecchi, nessun calcolo di limiti o di azioni fuori da `azioni` (v4).
- **D6**: `fatture-coda-senza-browser`; `aruba-solo-dal-cancello` (scandisce `src/**`, risolve gli import relativi; i simboli di rete di `client.ts` solo da `emissione.ts`, `reinvio.ts`, `cancello.ts`, `risolvi.ts`, `scarti.ts`, `sync/route.ts`; `emettiFatturaPagamento`/`creaSessioneAruba` solo da `emetti-voce.ts`; in `src/lib/aruba/**` solo `import type` da `contratto-db`; controllo positivo); `soglia-oraria-un-numero-solo`; `fatture-coda-nessuno-spostamento`; `fatture-coda-una-stima-sola`; `fatture-coda-log-vocabolario`.
- **Lock esistenti, con proprietario e commit fissati** (§20): `intestatario-fattura-un-motore-solo` (D4), `tetto-orario-aruba` (D4), `riconciliazione-ui` (D4), `fatturazione-riconciliazione-un-motore-solo` (D4), `pannello-componi-testi-completi` e `messaggi-plurali-e-glossario` (D5). Nei lock con allowlist che può solo scendere (`catch-muti-allowlist`, `supabase-client-strumentato`) non entrano voci nuove.

### 17.6 (v4) Test ponte del giornale — `__tests__/lib/fatture-coda/ponte-giornale-pglite.test.ts` (D3)
- **Impianto:** `creaDbCoda()` (D2) con i tre file veri; `clientSuPglite()` (D6, anticipato in fase 0) per il giornale; Aruba finto (signin, pavimento, upload `accettata`); per le letture dell'emissione il supabase finto già usato dai test di `__tests__/lib/aruba/**`, con gli stessi uuid seminati in PGlite. Si accoda una voce, si prende il cancello, `prossima` la mette in mano al token.
- **Percorso vero:** `emettiFatturaPagamento` vero → `giornaleDi(voce, token)` vero → `prenotaInvio`, `apriInvio` (= `invio_registra` + `invio_tenta` su PGlite), upload finto, `esitoInvio`, INSERT a registro, `invio_registrato`.
- **Asserzioni:** `invio_registra` risponde ok; la riga dell'invio ha serie, numero, anno, progressivo, data e importo uguali ai tag dell'XML; le chiavi di `riga_registro` sono esattamente `CHIAVI_RIGA_REGISTRO`; la riga a registro scritta dopo l'upload ha le colonne di oggi.
- **Casi:** IVA 0 (N4); IVA 22% con 10,01 € (`importo` 10,00, `riga_registro.importo` 10,01); bollo virtuale; pagamento a due quote (due invii).
- **Prove di rottura:** `riga_registro` con `xml_inviato` ⇒ rosso; `importo` = lordo della quota nel caso 10,01 ⇒ rosso; `<Numero>` con l'anno a 4 cifre per FPR ⇒ rosso.

---

## 18. Fotografie, PR e rilascio (decisioni 24, 25, 26, 28)

> **(C0 m8)** Il passo 4 di `.claude/commands/ship-cycle.md` (`:348-352` [V], «applicale … con `apply_migration`») **NON si esegue** per PR-D1, PR-A e PR-B: le migrazioni le applica l'integrazione al merge (decisione 25), le verifiche sono V1-V4 di D6. Da segnalare al titolare: il comando resta in contrasto con la decisione 25, decide lui se aggiornarlo.
> **(C0 G1)** Il predicato del 409 `partita_non_registrata` è quello di Registro C0.3. **(C0.2 D4)** STOP d'urgenza in sorveglianza: `fatture_coda_sospendi(NULL, '<motivo>')`, ripresa solo dal titolare. **(C0.2 D5)** compiti che scrivono in produzione: sonnet o opus, mai haiku.

**R1 — PR-D1 (prima di tutto, D1)**
- Migrazione `…_fatture_emesse_senza_vincolo_numero_per_sede.sql` (senza la parola `unique`), `vincolo-registro.ts`, predicato e 409 `partita_non_registrata`, tetto del pavimento a 50 con il pavimento nei log, aggregato che non scrive `scartata` sugli stop di numerazione, script d'indagine e delle orfane. Si rigenera solo `fk-utenti-snapshot.json`, a contenuto invariato.
- Prima del merge: l'indagine P0-P6, in sola lettura. I contatori si scrivono solo se l'indagine lo richiede (P6 falso).
- Merge dopo le 16:00, lontano da `:00/:30`. Poi: check Supabase; lo script registra tutte le orfane presenti (oggi 6), mostrando ogni scrittura prima di applicarla; riconteggio a 0; poi PR-D1b con le fotografie delle migrazioni e degli indici unici.
- Fino al rilascio della coda la segreteria continua a emettere. Niente controllo in `/api/health`, niente `migrate-ci`.

**Coda — PR-A (funzionalità + migrazioni)**
- **Contenuto:** i tre file SQL; il codice di D2-D6; il 410 dei vecchi POST; `MIGRAZIONI_ATTESE_AL_MERGE` in `soglia-fotografia.ts` per i soli file segnalati dalle tre guardie di F5 (atteso il solo file schema), con la ragione «la applica l'integrazione Supabase al merge della PR-A; le fotografie si rigenerano nella PR-B», guardie su `posterioriDaRigenerare()`, prove gemelle. Nessuna fotografia rigenerata, niente `JOB_CRON` né `JOB_CRON_NON_SORVEGLIATI`.
- **Prima del merge** (solo SELECT): orfane = 0; «Trasporto fallito» = 0; nessuna emissione negli ultimi 10'; version della PR-A assenti da `schema_migrations`; `supabase db push --linked --dry-run` elenca solo i 3 file; CI `quality` ed `e2e` verdi, con la misura del §20 chiusa e il test ponte verde.
- **Merge** dopo le 16:00 di Roma, al minuto :43 (o :13), con `gh pr merge --squash --delete-branch`.
- **Dopo il merge** (entro 10', sola lettura): check `Supabase Preview` success; 3 righe in `schema_migrations`; 8 tabelle con RLS e 0 policy; privilegi; `cron.job` con 2 righe; battito della pulizia; primo battito del tick `ok`; `ultimo_giro_il` aggiornato; `coda-fatture` `ok`. `migrate.yml` non si approva mai. Se l'integrazione fallisce si corregge con una PR, mai a mano.
- **In diretta, le prime ore** (solo aggregati): voci e invii per stato; voci `ritrasmissione` (attese solo per pagamenti con riga di scarto, oggi 7); invii `bruciata` (atteso 0); tentativi per tipo ed esito; picco su 60' ≤ 50; avvisi non inviati e avvisi per fatto (mai più di uno per voce e transazione); battiti; coerenza (voci emesse senza riga viva, doppioni per pagamento e quota, numeri doppi, invii `caricata` da più di 10'). Nessuno script che chiama Aruba (S28) gira a coda attiva.
- **STOP** se compare uno di questi: un 429, una verifica non risolta, un doppione, un 23505, un numero bruciato, un picco oltre 50, un battito assente da 15', un'anomalia grave. Lo STOP è «Sospendi coda» di un admin. In urgenza, senza un admin disponibile: `select public.fatture_coda_sospendi(NULL, 'arresto d''urgenza durante il rilascio')`, mostrata prima di eseguirla. Riprende un admin dalla pagina.
- **Ritorno indietro** (S38): 1. «Sospendi coda» (o l'arresto d'urgenza); 2. elenco (SELECT, solo uuid e numeri) degli invii aperti e delle voci `da_verificare` e `in_invio`, con pagamento, serie, numero e anno; 3. istruzione scritta al titolare e alla segreteria: quei pagamenti non si riemettono dalla vecchia strada finché non sono verificati sul pannello Aruba; 4. solo allora promozione del deploy precedente e `cron.unschedule('fatture-coda-tick')`, mostrati prima di eseguirli. Le tabelle restano; nessun DROP se esiste un invio.

**Coda — PR-B (stesso giorno, nessuna migrazione, D6)**
1. Rigenerazione delle 6 fotografie dalla produzione in sola lettura, controllando che contengano le tabelle nuove.
2. `MIGRAZIONI_ATTESE_AL_MERGE` vuota (la prova gemella lo impone).
3. `JOB_CRON += {fatture-coda-tick, 20*MIN}`, `{fatture-coda-pulizia, 26*ORA}`.
4. `TRACCE_DOCENTE` += 5 voci (`creato_da` e `attore_id` bloccano e pesano; `azione_richiesta_da`, `sospesa_da` set-null; `destinatario_id` cascade) + chiavi `adminAltro`. `tardiva_autorizzata_il` e `anomalia_da_consegnare` non hanno FK.
5. `NOT_NULL_ATTESE += fatture_coda_voci, fatture_coda_invii`.
6. `isolamento-sede-coverage` sugli handler della coda, una soluzione per handler, misurata.
7. Battiti `ok` negli ultimi 20' prima del merge; merge dopo le 16:00, lontano da `:00/:30`.

---

## 19. Proprietà dei file (un proprietario per file e per PR; elenco completo nel campo `proprieta_file`)

- **D1:** migrazione R1, `vincolo-registro.ts`, `fattura-partita-non-registrata.ts`, script e librerie `numerazione-serie*`, `fatture-orfane*`, `aruba-lettura.mjs`, i test (compresi `__tests__/fixtures/casi-partita-non-registrata.ts`, `__tests__/lib/aruba-lettura.test.ts`, `__tests__/lib/numerazione-serie-cli.test.ts` e `__tests__/lib/fatture-orfane-cli.test.ts`), le fotografie di PR-D1 e PR-D1b. In PR-D1 anche `emissione.ts`, `fattura/route.ts`, `lotto/route.ts`, `esito-fetch.ts`, `shared.json` e i test esistenti di `__tests__/lib/aruba/**` che il suo cambiamento rompe.
- **D2:** i 3 SQL, `contratto-db.ts`, `rpc.ts`, `gdpr/esegui.ts` e `__tests__/lib/gdpr-esegui.test.ts`, helper PGlite, `__tests__/db/fatture-coda-*`, lock specchio, test di `rpc.ts` e dell'oblio.
- **D3:** `giro.ts`, `porte.ts`, `cancello.ts`, `coda-db.ts`, `ritmo.ts`, `classifica.ts`, `emetti-voce.ts`, `documenti.ts`, `risolvi.ts`, `stima.ts`, `scarti.ts`; `client.ts`, `emissione.ts` (PR-A), `reinvio.ts`, `accesso.ts`, `confronto-documento.ts`; `intestatari.ts`; route del giro; `sync/route.ts`; i loro test; i test esistenti di `__tests__/lib/aruba/**` in PR-A; **(v4) il test ponte** `__tests__/lib/fatture-coda/ponte-giornale-pglite.test.ts`.
- **D4:** `api-contratto.ts`, `precontrollo.ts`, `situazione.ts`, `periodo.ts`, `stato-coda.ts`, `risposte-api.ts`; `fatture-dei-pagamenti.ts` (con `numeroLeggibile`), `fatturazione-riga.ts`, `lotto-fatture.ts`, `scope.ts`; route `coda/*` (tranne `giro`), `riconciliazione/route.ts`, i 410; `esito-fetch.ts` e `shared.json` (PR-A); i lock di §17.5 marcati D4; i 5 test della GET di riconciliazione (F33); i loro test.
- **D5:** `notifiche.ts`, `testi-notifica.ts`, `ui-stati.ts`; catalogo notifiche; nav, layout, pagina Coda, componenti `coda/**`, `FatturaButton`, `FatturaChip`, `RiconciliazionePanel`, `riconciliazione-ui.ts`, `MovimentoDialog`, `PaymentsDashboard`, `PagamentoCardMobile`, `PagamentoDrawer`, `TransazioniPanel`, `RegistraIncassoModal`, `QuickAcquistoModal`, `PagamentiFattureAlunno`, `StudentDetailPanel`, `ContabilitaNav` (se la voce passa di lì); rimozione di `LottoFatturePanel`; lock UI e test; i test d'interfaccia esistenti di F32.
- **D6:** `vocabolario-log.ts`, `controlli.ts`, `health.test.ts`, test del controllo; `soglia-fotografia.ts` e le tre guardie (PR-A); lock nuovi; `aruba-finto.ts`, `supabase-su-pglite.ts` (fase 0), test cardine; E2E; `e2e/fixtures.ts`, `e2e/auth.setup.ts`; tutta la PR-B; PRD e spec della coda.
- **Nessuno:** `src/lib/push/enqueue.ts`, `src/lib/notifiche/destinatari.ts` (non si modificano).
- **Regole.** «Chi rompe ripara» (§0). `errori-senza-codice-allowlist.json` è di D4 e si tocca in commit congiunto con chi cambia `fattura/route.ts` o `sync/route.ts`. Gli E2E esistenti (`admin-contabilita.spec.ts`, `admin-riconciliazione-popup.spec.ts`…) li misura la CI della PR-A: un rosso lo ripara chi l'ha rotto.

---

## 20. Sequenza di lavoro

1. **PR-D1 → merge → orfane → PR-D1b** (D1). Il ramo della coda si ribasa su un `main` che contiene D1.
2. **Fase 0, interfacce, in sequenza:** D2 `contratto-db.ts` (con i tipi v4: `InvioDaRegistrare`, `CHIAVI_RIGA_REGISTRO`, `STATI_SDI_SCARTO`, `DatiAvviso`, `StatoPagamentoCoda`) e `rpc.ts`; D4 `api-contratto.ts` (`VoceInElenco` v4); D6 `vocabolario-log.ts`, `aruba-finto.ts` e **`supabase-su-pglite.ts`** (v4, anticipato per il test ponte); D2 helper PGlite (con `xmlDiProva`).
3. **Fase 1, in parallelo** (file disgiunti):
   - D2: i 3 SQL e i test PGlite (compresi un fatto un avviso, fine gruppo, bidello a 5 rami, forma di `p_invio`, motivo, `invii_oltre_limite`); `gdpr/esegui.ts` con `gdpr-esegui.test.ts`;
   - D3: `client.ts`, `emissione.ts` (giornale con `InvioDaRegistrare` e aggregato di S51), `reinvio.ts`, `accesso.ts`, `confronto-documento.ts`, `ritmo.ts`, `stima.ts`, `classifica.ts`, con i test esistenti di `__tests__/lib/aruba/**` che rompe;
   - D4: `fatture-dei-pagamenti.ts` (con `numeroLeggibile` spostata dalla route), `scope.ts`, `precontrollo.ts` e, nello stesso commit, il lock `intestatario-fattura-un-motore-solo` (chiamanti `lotto-fatture.ts`, `LottoFatturePanel.tsx`, `precontrollo.ts` per `intestatarioAutomaticoDelLotto`; `LottoFatturePanel.tsx`, `precontrollo.ts` per `propostaBloccataDaiDati`; ragione «la proposta la ricalcola il server; la conferma viaggia come `conferme_proposte`»). Poi `situazione.ts`, `periodo.ts`, `stato-coda.ts`, `risposte-api.ts`;
   - D5: `ui-stati.ts`, `testi-notifica.ts` (con `dati.anomalia` e `dati.fine_gruppo`), `notifiche.ts`, catalogo, navigazione.
4. **Fase 2:**
   - D3: `cancello.ts`, `coda-db.ts`, `emetti-voce.ts`, `documenti.ts`, `risolvi.ts`, `giro.ts`, route del giro, sync (con `ruoliFatturaScartata`), `scarti.ts`; **poi il test ponte** (§17.6), che deve essere verde prima della fase 3;
   - D4: route, 410, `riconciliazione/route.ts` coi suoi 5 test, tono `in_coda` + `riconciliazione-ui.test.ts`; nello stesso commit D5 aggiunge le voci `in_coda` di `CHIP_FATTURAZIONE`, `FRASE_FATTURAZIONE`, `ICONA_CHIP` e il filtro; poi si rilancia `fatturazione-riconciliazione-un-motore-solo`;
   - commit congiunto D5+D4: D5 elimina `LottoFatturePanel.tsx` e il suo test (con `pannello-componi-testi-completi` e `messaggi-plurali-e-glossario`) e porta `RiconciliazionePanel` su `TETTO_VOCI_PER_GESTO`; D4 toglie `LottoFatturePanel.tsx` dai chiamanti del lock intestatario e `TETTO_LOTTO` da `lotto-fatture.ts` e da `tetto-orario-aruba.test.ts`; poi si rilanciano i quattro lock;
   - D5: pagina, dialoghi (con `invii_aperti[]`, `fatture[]` e comandi solo da `azioni`), ingressi, con i test d'interfaccia esistenti che rompe (F32);
   - **Misura di fine fase:** `npx vitest run` intero; ogni componente pubblica i file rossi delle sue cartelle col proprietario (D5 misura `__tests__/components`, `__tests__/features`, `__tests__/pagamenti`, `__tests__/a11y`, `__tests__/ui`); l'elenco si chiude, con le riparazioni, prima della fase 3.
5. **Fase 3** (D6): test cardine, lock, salute, E2E simulati, meccanismo delle fotografie.
6. **Gate:** `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run` (la riga «Test Files N passed» si confronta col numero di file su disco), `npm run build`, CI.
7. **Fine:** PR-A, verifica, PR-B. A fine fase un critico rompe il codice di proposito e controlla che i test diventino rossi.

---

## 21. Eliminato (non si fa)

- «È arrivata» o qualunque registrazione a mano di una fattura come inviata.
- Stati `errore_dato`, `gia_emessa`, `annullata`, `sostituita`.
- RPC `prenota_invio`, `prendi_verifica`, `aruba_cancello_signin/_ricerca/_apri_circuito`, `annulla`, `rimetti_in_coda`, `segna_urgente`, `imposta_causale`, `rimanda`, `stima_fine`, **`fatture_coda_invii_limite`** (v4); parametro `p_spaziatura_signin_ms`.
- `ordine.ts`, `confrontaVoci`.
- Dedup delle notifiche su `tetto_frequenza` o a 60'; notifiche composte dalle route; aggregazione degli errori in TS; conferma di un avviso senza rilettura di `notifiche`; **(v4)** avviso `anomalia` accanto all'avviso della voce per lo stesso fatto; `gruppo_concluso` accanto a un avviso in attesa dello stesso gruppo; `fattura_scartata` agli admin nel 00404 non identico.
- Conversione del 429 dentro `invio_esito`; azzeramento del contatore dei 429 su pagine e download riusciti; 00404 «illeggibile» trattato come non identico; `scartata` senza prova di un contenuto diverso.
- `azione_forzata` sulla voce; upload di un numero già assegnato oltre 12 giorni senza autorizzazione per documento; **(v4)** qualunque calcolo del limite dei 12 giorni in TS e il ripiego su `esito_codice`.
- `ricerca_da_ripetere` come ripiego di un guasto nostro; `riprova cancello_perso` del bidello; **(v4)** il bidello a 3 rami.
- **(v4)** `invio_aperto` e `fattura` singoli in `VoceInElenco`; `numero` come stringa; azioni calcolate da D5.
- **(v4)** `riga_registro` con `xml_inviato` o con colonne di trasporto; `importo` dell'invio uguale al lordo della quota.
- **(v4)** `motivo='ritrasmissione'` per ogni `scartata`; col giornale, `scartata` scritta per fermate che non sono scarti di merito.
- `ARUBA_FINTO_URL`, `KV_ARUBA_FINTO_URL`, ambiente `'finto'`, `e2e/coda-fatture-server-vero.spec.ts`, `aruba-finto-server.mjs`, modifiche a `ci.yml`, `playwright.config.ts`, `seed-e2e.mjs`, `docs/env.md`.
- `migrate-ci`; approvazione di `migrate.yml`; `apply_migration`.
- `SEDE_DI_COLLAUDO`; fotografie rigenerate nella PR-A; `JOB_CRON_NON_SORVEGLIATI` nella PR-A.
- Gradini della prova vera. STOP d'urgenza a nome dell'uuid di una persona.
- Test `stati.test.ts`, `ordinamento.test.ts`, `classifica-esito.test.ts`, `cancello-puro.test.ts`, `base-url-finta.test.ts`, `ambiente-finto.test.ts`, `fatture-coda-rientri-automatici`, `fatture-coda-stati-un-elenco-solo`, `fatture-coda-verifica.test.ts` («Arrivata»).
- Modifiche a `/privacy` e a `informativa-conservazione-dichiarata`.
