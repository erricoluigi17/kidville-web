# D2 — Schema dati, RPC, cron e migrazioni della coda fatture (allineato al CONTRATTO v4)

> Sessione in sola lettura: nessun file del repo scritto.
> - **[V]** = verificato: repo, `gh`, produzione (solo SELECT di aggregati, nomi di oggetti ed espressioni costanti), PGlite in memoria.
> - **[D]** = scelta di progetto o deduzione.
>
> **Il CONTRATTO v4 prevale su questo testo.** Qui c'è solo quello che il contratto lascia a D2: la DDL esatta, i trigger, il corpo delle RPC, gli helper interni, lo specchio TS, il GDPR, i test PGlite, il lock specchio e la parte DB del rilascio. Stati, transizioni, codici, avvisi, firme, protocollo del giro, log e proprietà dei file non li ridefinisco: rimando con «C§n».

---

## Correzioni C0 (23/09/2026) — prevalgono sul resto del documento

Fonte: contratto, sezione «Registro C0» (C0.1 rilievi, C0.2 default del titolare, C0.3 predicato, C0.4 richieste). Per questo componente:
- **Predicato unico (C0 G1)**: `_fatture_coda_partita_non_registrata` = testo di contratto C0.3, sostituisce la forma di R6 (§5.1). Test nuovo: «sola riga scartata dello stesso file ⇒ accodata con motivo `ritrasmissione`». Il lock specchio confronta il testo SQL con quello del gemello di D1.
- **`fatture_coda_invio_registra(…, p_solo_verifica boolean DEFAULT false)` (C0 G2)**: con `true` esegue tutti i controlli di C§7.3 (compreso `_fatture_coda_riga_difetto` su pagamento e sede della voce) con numero segnaposto e **non scrive**. Nessuna RPC nuova. Codice `giornale_non_aperto` in `CODICI_ERRORE` con effetto ferma. Test PGlite: `BAD_INPUT` dopo il numero ⇒ un solo invio `bruciata`, voce `errore`, nessun secondo numero al giro dopo.
- **Battito della pulizia (C0 G4)**: `_fatture_coda_log(…, p_fingerprint text DEFAULT NULL)`; il file 3 scrive il letterale `'cron:fatture-coda-pulizia'`, `evento='cron'`, `livello='info'`, `contesto.campi={operazione:'fatture-coda-pulizia', esito:'ok', n_*}`. Il lock specchio verifica il letterale.
- **Tetto fail-closed (C0 m1)**: in tutti i conteggi del tetto `esito IS DISTINCT FROM 'non_eseguito'`; test: upload prenotato con esito NULL occupa il posto, con limite 2 il terzo riceve `QUOTA_ORARIA`.
- **Nomi (C0 m6)**: i nomi di D2 fanno fede (`INTESTATARIO_ORIGINE[I]`, `CAUSALE_MODO[I]`, `AZIONE_RICHIESTA`/`AZIONI_RICHIESTE`); si aggiunge `TIPI_DOCUMENTO_SUPPORTATI = ['TD01']`. Il lock specchio esclude `vocabolario-log.ts` come catalogo: niente eccezioni contate per `'sospesa'`/`'assente'`.
- **Circuito 429 (C0.4, riscritto in C0.5 n. 6)**: vale R8 di D2: `chiudi(…,'aruba_429')` apre il circuito solo se è chiuso, con `_fatture_coda_apri_circuito`, che calcola `fino_a = GREATEST(…, adesso + 60')` all'istante della **chiusura** (§5.1); a circuito aperto non fa nulla. La frase precedente («dall'istante del tentativo») non corrispondeva a questo testo ed è ritirata.
- **Seconda passata del critico (contratto C0.5)**:
  - **n. 1, numero conteso**: `_tentativo_chk` diventa `(tentativi = 0) = (stato = 'numerata' OR (stato = 'bruciata' AND esito_codice IS DISTINCT FROM 'numero_conteso'))`, e `tentativi > 0 ⇒ tentato_il`. `_fatture_coda_invii_guardia` ammette `da_ritentare → bruciata` e `incerta → bruciata` solo con `esito_codice='numero_conteso'`, e li scrive **solo** `fatture_coda_invio_ricerca(non_combacia)` (azzera `xml`, `riga_registro`, `consecutivi_429`). `incerta → in_volo` in `invio_tenta` richiede `ricerca_esito='assente'`. `fatture_coda_numero_bruciato` rifiuta `p_codice='numero_conteso'` (`BAD_INPUT`). `chiudi('errore','numero_conteso')` richiede un invio `bruciata numero_conteso` ultimo della sua quota; l'anomalia `numerazione_anomala` è intrinseca al codice finale (§5.3.1). Test PGlite in §10 (lavoratore e avvisi).
  - **n. 3, togli (default D1)**: helper `_fatture_coda_solo_invii_non_consegnati(p_voce uuid) → boolean` (la voce ha invii e sono tutti `rifiutata`/`bruciata`), usato da `fatture_coda_togli`, dal trigger `_fatture_coda_voci_guardia` e dal campo additivo `solo_invii_non_consegnati` di `fatture_coda_stato_pagamenti`.
  - **n. 4-5, doppione chiuso (default D2)**: lo scrive solo `fatture_coda_pulizia()` (§6), azione `doppione_chiuso_pagamento_chiuso` nel CHECK di `fatture_coda_eventi.azione`.
  - **n. 7, R6**: il testo di `_fatture_coda_partita_non_registrata` in §5.1 è riscritto nella forma CASE di C0.3.
- **Default del titolare (C0.2)**: D1 `fatture_coda_togli` ammette una voce `errore` con invii tutti `rifiutata`/`bruciata`; D2 il doppione non identico di un pagamento non più `pagato` esce dal bollino e scrive una volta l'evento `doppione_chiuso_pagamento_chiuso` (attore NULL); D3 `non_combacia` chiude `errore numero_conteso` con invio `bruciata` e anomalia `numerazione_anomala`, non `da_verificare`; D4 `fatture_coda_sospendi(NULL, motivo)` resta ammessa con attore NULL = sistema (motivo obbligatorio).
- **F3 (C0 m8)**: `scadenze-documenti-personale` (`47 5 * * *`, HTTP) cade su un minuto del tick (R9 di D2 confermata).

## 0. Confini

**D2 consegna nella PR-A** (C§19):
- i 3 file SQL (C§4);
- `src/lib/fatture-coda/contratto-db.ts` e `src/lib/fatture-coda/rpc.ts`;
- `src/lib/gdpr/esegui.ts` e `__tests__/lib/gdpr-esegui.test.ts`, nello stesso commit;
- `__tests__/helpers/fatture-coda-pglite.ts`, i 5 test PGlite, il lock specchio, il test di `rpc.ts` e quello dell'oblio.

**D2 non consegna:**
- fotografie, `JOB_CRON`, `TRACCE_DOCENTE`, `NOT_NULL_ATTESE` (PR-B, D6);
- route, giro, sync, `classifica.ts`, test ponte (D3);
- API e `VoceInElenco` (D4); notifiche e testi (D5); salute, cardine, `supabase-su-pglite.ts`, E2E (D6).

**Interfacce che altri usano da D2:**
- le 32 RPC del campo `rpc` del contratto, con le firme lì fissate;
- l'helper PGlite, che usano anche il test ponte di D3 (C§17.6) e il cardine di D6 (C§17.3): `creaDbCoda()`, `semina.*`, `xmlDiProva()`, `preparaVoceInMano()` (§10.1).

---

## 1. Fatti verificati (si aggiungono a C§1)

| # | Fatto | Fonte |
|---|---|---|
| G1 | `cron.job`, riletto il 23/09: 26 job, nessuno `fatture-coda%`, nessuno alle `49 3`.<br>Ai minuti ≡2 (mod 5) coincidono tre job:<br>• `scadenze-documenti-personale` (`47 5 * * *`, comando HTTP): una coincidenza al giorno, alle 05:47;<br>• `iscrizioni-sanitari` (`47 4 * * *`, solo SQL nel comando);<br>• `iscrizioni-retention-esito` (`27 * * * *`, solo SQL).<br>**Corregge il G1 della v3 e C§1 F3**, che dicevano «nessun job HTTP» (R9). Nessun effetto: pg_cron esegue i job in parallelo e pg_net li mette in coda | SELECT jobname, schedule, `command ilike '%http%'` [V] |
| G2 | `net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) → bigint`; `net._http_response(id, status_code, content_type, headers, content, timed_out, error_msg, created)` | `pg_proc` [V] |
| G3 | Colonne che uso:<br>• `pagamenti`: `id`, `scuola_id` (nullo ammesso), `stato` varchar, `fattura_stato` enum, `fattura_aruba_id` varchar, `data_incasso` timestamptz, `creato_il`;<br>• `fatture_emesse`: 23 colonne, fra cui `sdi_stato smallint`, `aruba_filename`, `xml_inviato`, `importo`, `quota_adult_id`, `bollo_virtuale NOT NULL`. Nessuna colonna con la data del documento;<br>• `app_log`: `fingerprint`, `giorno`, `occorrenze`, `contesto jsonb`, `ambiente` | `information_schema.columns` [V] |
| G4 | Produzione il 23/09: ultima version `20260920124744`; PG 17.6; «Trasporto fallito» 0 | SELECT [V] |
| G5 | PGlite 0.5.8 è PostgreSQL 18.3:<br>• conosce i fusi orari;<br>• ha `pg_trigger_depth()` e `regexp_count`;<br>• in PG18 una colonna `GENERATED` senza `STORED` è VIRTUAL | prova in memoria [V] |
| G6 | `scuoleDiUtente` = la sede dell'utente, più `utenti_scuole` solo per gli admin | `src/lib/auth/scope.ts:53-82` [V] |
| G7 | `requireStaff` legge `ruolo, role, archiviato_il` | `src/lib/auth/require-staff.ts:95` [V] |
| G8 | Indici esistenti su `fatture_emesse`:<br>• `fatture_emesse_sezionale_anno_numero_uidx (sezionale, anno, numero) WHERE sezionale IS NOT NULL`;<br>• `fatture_emesse_pagamento_quota_uidx (pagamento_id, COALESCE(quota_adult_id, uuid nullo)) WHERE sdi_stato IS NULL OR sdi_stato NOT IN (2,4,9)` | `20260809235620_fatture_numerazione_sezionale.sql:121-123, 167-169` [V] |
| G9 | `senzaCommenti` conserva i commenti dentro `$$…$$` | `soglia-fotografia.ts:210-264` [V] |
| G10 | In `anonimizzaAlunno`:<br>• `pagIds` è a `esegui.ts:1748` e si calcola anche se la lettura fallisce (`errPag` finisce solo nel log, `:1747`);<br>• il passo 3b chiude a `:1791`; `lettureFallite` è a `:2050-2059`.<br>Nel test, `makeFake` (`gdpr-esegui.test.ts:96`) non ha `rpc`; `pagamenti:[{id:'pag-1'}]` compare a `:255, :292, :323` | [V] |
| G11 | `mapStatoAruba` è esportata da `src/lib/aruba/stato.ts:45`; `isScarto` vale per i codici 2, 4 e 9 (`:34, :36, :41`). `fatturaViva` = riga non di scarto (`src/lib/pagamenti/fattura-viva.ts:83-84`) | [V] |
| G12 | Specchi TS:<br>• `progressivoInvioFattura` = lettera, `anno%100` su 2 cifre, numero con `padStart(6)`, che **non tronca** (`emissione.ts:331-334`);<br>• `formattaNumeroFattura`: FPR con anno a 2 cifre, Asilo a 4 (`sezionale.ts:584-603`);<br>• `oggiFiscaleISO` = giorno Europe/Rome (`src/lib/format/fiscal-date.ts:8-11`);<br>• `baseRow` = 16 chiavi, `xml_inviato` compresa (`emissione.ts:2282-2303`) | [V] |
| G13 | Nel modello XML ciascuno di questi tag compare una volta: `<ProgressivoInvio>` (`fatturapa-xml.ts:548`), `<TipoDocumento>TD01` (`:582`), `<Data>` (`:584`), `<Numero>` (`:585`), `<ImportoTotaleDocumento>` (`:587`). `importo()` = `toFixed(2)` (`:345-347`) | [V] |
| G14 | **Controllo positivo sulle 425 righe reali**, con le stesse espressioni SQL di §4.1. Per 425 righe su 425:<br>• ogni tag compare una volta;<br>• `<Numero>` = `_numero_documento`;<br>• `<ProgressivoInvio>` = `progressivo_invio` = `_progressivo`;<br>• `<ImportoTotaleDocumento>` = `importo` (oggi tutte IVA 0);<br>• anno di `<Data>` = `anno`;<br>• `TD01`;<br>• l'XML inizia con `<`.<br>XML da 3286 a 3461 byte; la riga di registro più grande, senza XML né colonne di trasporto, pesa 746 byte | SELECT aggregata [V] |
| G15 | Predicati di «partita non registrata» in produzione. Valgono tutti **6**, e sono gli stessi 6:<br>• `in_attesa` e 0 righe;<br>• `in_attesa` e nessuna riga viva;<br>• file del pagamento assente dal registro;<br>• `in_attesa` e file assente.<br>`in_attesa` senza file: 0. Pagamenti `scartata`: 11, di cui 7 con una riga in scarto, 4 senza righe, 0 col file assente dal registro | SELECT aggregata [V] |
| G16 | `lpad('1234567',6,'0')` = `'123456'`: tronca. `regexp_count('<Data>x</Data><DataScadenza>', '<Data>')` = 1. `?&` e `jsonb_object_keys` si comportano come atteso | espressioni costanti in produzione [V] |
| G17 | PGlite in memoria:<br>• un blocco annidato che solleva `ERRCODE 'FC001'` e lo intercetta con `WHEN SQLSTATE 'FC001'` annulla le proprie scritture;<br>• una plpgsql che chiama una funzione non ancora creata si crea, dà `42883` e si può intercettare;<br>• la farfalla con `COALESCE` sulla riga iniziale vale `true` | prova in memoria [V] |
| G18 | Postgres non ammette sottoquery in un `CHECK`: la logica che le richiede va in una funzione IMMUTABLE | documentazione PG [D, fonte nota] |

---

## 2. Risposta ai rilievi del critico

1. **Un fatto, un avviso (bloccante).** Accolto, come C§2 S44-S46.
   - In SQL: consegna dell'anomalia nella chiusura (§5.3.1); parcheggio in `anomalia_da_consegnare` (§4.2, §5.5, §5.6); `segnala_scarto_sdi` con un solo avviso (§5.6); `fine_gruppo` (§5.10).
   - **In più:** l'aggregazione degli `errore` salta gli avvisi con `a_tutti_gli_admin`. Altrimenti un errore senza anomalia finirebbe agli admin dentro l'avviso di un altro.
   - Test (a)-(d), parcheggio e fine gruppo in §10.
   - La parte di `fattura_scartata` è di D3 (S46).
2. **12 giorni nelle letture (grave).** Accolto (S48): `invii_oltre_limite` in `stato_pagamenti`, solo per `numerata`, `da_ritentare` e `incerta` (§5.8). Test a 12 e 13 giorni.
3. **Bidello a 3 rami (grave).** Accolto (S49); il ramo era già nella mia v3 (§5.5).
   - **In più**, trovata rivedendo i lock: il bidello prende il cancello `FOR UPDATE` **prima** delle voci. Nella v3 lo liberava alla fine, dopo le voci. Con `richiedi_verifica`, che prende cancello `FOR SHARE` e poi voce, nasceva un ciclo (§5.9).
4. **Forma di `p_invio` e `riga_registro` (grave).** Accolto (S50).
   - L'SQL ricontrolla progressivo, `<Numero>`, `<Data>`, `<ImportoTotaleDocumento>`, `<TipoDocumento>` e le 15 chiavi.
   - Le stesse espressioni danno 425 su 425 sulle righe vere (G14).
   - L'helper serve il test ponte di D3 (§10.1).
5. **Motivo di ritrasmissione (grave).** Accolto (S51): `_fatture_coda_stati_scarto_sdi()`. In produzione 4 pagamenti `scartata` su 11 entrano come `prima_emissione` (G15). Test in `staff`.
6. **Predicato `PARTITA_NON_REGISTRATA` (minore).** Corretto: lo fisso in SQL (§5.7, `_fatture_coda_partita_non_registrata`) nella forma CASE di contratto C0.3 (C0.5 n. 7: la vecchia «unione delle due forme» è ritirata). In produzione vale 6 (C0.3). Test: «quota B viva, file della quota A assente ⇒ rifiuto»; «sola riga scartata dello stesso file ⇒ accodata come `ritrasmissione`».
7. **Sveglia persa mentre la sync tiene il cancello (minore).** La v4 non l'accoglie: implemento C§9.1 alla lettera, resta R4 e lo dichiaro come limite (§14).
8. **Firme aperte (minore), per la parte D2:**
   - `sveglia: boolean` nei ritorni di `accoda`, `rimetti`, `richiedi_verifica`, `sospendi` e `riprendi`;
   - l'elenco completo delle mappe (§7.1);
   - `EsitoChiusura` resta il ritorno della RPC, come dice C§13, e i valori di `p_esito` prendono il tipo `EsitoChiusuraRichiesto`;
   - `posizioni(NULL)` e `doppioni_aperti` fissati.
   Chiedo di registrarli in C§13 (R10). Il resto (`leggiAccessoAruba`, `riallinea00404`, `annullo-riapre-movimento`) non è di D2.
9. **Precisazioni sulle RPC (minore):**
   - (a) codici solo da conversione: implementati, R5;
   - (b) `emessa gia_a_registro` con invii tutti `registrata` è ammessa: rientra nel primo ramo di C§5.1, e lo scrivo;
   - (c) `giornale_non_aperto`: non è in C§8.3, quindi fino a una decisione il numero bruciato usa `xml_non_componibile` (R7);
   - (d) `p_codice_sdi` = NULL oppure `^[0-9]{5}$`, altrimenti `BAD_INPUT`;
   - (e) `posizioni(NULL)` restituisce tutti i candidati, al più 2000; `doppioni_aperti` = id delle voci;
   - (f) `chiudi(…,'aruba_429')` apre il circuito se non è già aperto (§5.5), e chiedo di scriverlo in C§9.2 (R8).
10. **Eccezioni del lock (minore).** Accolto:
    - niente eccezione per `'errore'` in `sync/route.ts`, perché la toglie D3;
    - niente eccezione per `'assente'`, `'illeggibile'`, `'ambigua'` in `TIPI_00404_NON_RISOLTO`, che D6 costruisce da `ESITO_RICERCA`;
    - aggiunta l'uguaglianza `MOTIVO_PARTITA_NON_REGISTRATA === ESITO_VOCE.partita_non_registrata` (§11).
11. **F3 e G1 sbagliati (minore).** Accolto: G1 corretto con la SELECT; chiedo di correggere F3 (R9). Il minuto del tick resta: la coincidenza delle 05:47 è innocua.

---

## 3. Regole di scrittura dei file

**Nomi e istanti** (C§4).
- `T1` = istante UTC reale di scrittura, dopo il merge di PR-D1b.
- Se una fotografia si rigenera dopo, i file si rinominano prima del merge, mai con un istante futuro.

**Testata.** «Stato: scritta il AAAA-MM-GG; la applica l'integrazione Supabase al merge della PR-A». Mai «NON APPLICATA». I tre file finiscono con `NOTIFY pgrst, 'reload schema';`.

**Idempotenza:**
- `CREATE TABLE IF NOT EXISTS` con i vincoli dentro il `CREATE`;
- `CREATE [UNIQUE] INDEX IF NOT EXISTS` e `CREATE OR REPLACE FUNCTION`;
- `DROP TRIGGER IF EXISTS` seguito da `CREATE TRIGGER`;
- `INSERT … ON CONFLICT DO NOTHING`;
- pg_cron: `unschedule` se il job c'è, poi `schedule`, dentro `DO … EXCEPTION`.

**Parole-guardia.** Nei file 2 e 3 non compaiono mai, nemmeno nei commenti (G9): `unique`, `primary key`, `policy`, `row level security`, `drop table`, `references … utenti`, `add constraint`, `drop constraint`, né righe che iniziano con `scuola_id uuid`.
- Si scrive `v_sede uuid`.
- Le violazioni si intercettano con `WHEN SQLSTATE '23505'`, mai con `unique_violation`.
- Solo il file 1 accende le tre guardie di C§1 F5.

**Solo PG ≤ 17.** `STORED` sempre scritto; vietati `RETURNING OLD/NEW`, `VIRTUAL`, `uuidv7(`, `WITHOUT OVERLAPS`.

**Orologio.** Nessun `now()` o `clock_timestamp()` fuori da `_fatture_coda_adesso()`. Uniche eccezioni: `visto_l_ultima = now()` negli `ON CONFLICT` di `app_log` e la colonna `giorno` di `app_log`.

**Sicurezza.**
- RPC: `SECURITY DEFINER`, owner `postgres`, `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC, anon, authenticated`, poi `GRANT EXECUTE … TO service_role`.
- Helper e trigger: `SECURITY INVOKER`, `SET search_path`, solo il `REVOKE`.

**`CHECK` senza sottoquery** (G18). La logica sulle chiavi di un `jsonb` e sui tag dell'XML sta in funzioni IMMUTABLE del file 1 (§4.1). Le stesse funzioni servono alla RPC per il `BAD_INPUT{campo}`: una fonte sola.

**Niente `lpad` nudo sui numeri.** Tronca (G16): si scrive `CASE WHEN length(x) >= n THEN x ELSE lpad(x, n, '0') END`, che è lo specchio di `padStart`.

**Log.** `_fatture_coda_log('<evento>','<livello>','<esito>', …)` con i primi tre argomenti letterali sulla stessa riga. Le chiavi di deduplica passano sempre da `lower(...)`.

**Errore interno `FC001`.**
- Un controllo sugli invii che fallisce **dopo** scritture parziali solleva `ERRCODE 'FC001'` dentro un blocco annidato.
- Il blocco esterno lo intercetta con `WHEN SQLSTATE 'FC001'` e il savepoint annulla le scritture (G17).
- Nessun altro errore si intercetta così.

---

## 4. File 1 — `<T1>_fatture_coda_schema.sql`

### 4.1 Helper di base (prima delle tabelle; solo `REVOKE`)

**Orologio e date**
- **`_fatture_coda_adesso() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() $$`** è l'unico orologio, anche nei `DEFAULT`. I test lo sostituiscono con `CREATE OR REPLACE`; l'OID resta lo stesso.
- **`_fatture_coda_giorno_roma(timestamptz) RETURNS date STABLE`** = `(t AT TIME ZONE 'Europe/Rome')::date`.
- **`_fatture_coda_oggi_fiscale() RETURNS date VOLATILE`** è il giorno a Roma di `adesso`: lo specchio di `oggiFiscaleISO` (decisione 14).
- **`_fatture_coda_epoch_ms(timestamptz) RETURNS bigint IMMUTABLE`** e **`_fatture_coda_iso(timestamptz) RETURNS text STABLE`** (istante UTC con la `Z`).

**Forma sicura dei `jsonb`**
- **`_fatture_coda_dati_sicuri(jsonb, int DEFAULT 0) RETURNS boolean IMMUTABLE`** accetta solo:
  - un oggetto di al più 4 KB;
  - chiavi `^[a-z][a-z0-9_]{0,39}$`;
  - stringhe `^[A-Za-z0-9_:.+/-]{0,128}$`;
  - numeri, booleani, null, array di scalari (al più 50);
  - un solo livello di annidamento.
- Il limite delle stringhe sale da 64 a 128 caratteri (v4). La chiave di un'anomalia arriva a 120 caratteri, e `<pagamento>-<quota>` di `doppia_emissione` ne fa 73.

**Costanti IMMUTABLE**, una per riga, nella forma `CREATE OR REPLACE FUNCTION public._fatture_coda_<nome>() RETURNS … LANGUAGE sql IMMUTABLE AS $$ SELECT … $$;`. Sono le 12 di C§4:

| Funzione | Valore |
|---|---|
| `minuti_pausa` | 15 |
| `minuti_circuito` | 60 |
| `giorni_limite_trasmissione` | 12 |
| `rientri_max` | 3 |
| `max_429` | 3 |
| `max_ricerche_fallite` | 3 |
| `minuti_rinvio_verifica` | 4 |
| `max_00404_non_risolti` | 6 |
| `spaziatura_signin_ms` | 65000 |
| `secondi_tetto_sveglia` | 60 |
| `mesi_conservazione` | 24 |
| `max_riga_registro_bytes` | 32768 |

In più, due liste:
- `_fatture_coda_stati_scarto_sdi() RETURNS int[]` = `ARRAY[2,4,9]`;
- `_fatture_coda_chiavi_riga_registro() RETURNS text[]` = le 15 chiavi di C§7.3, nell'ordine del contratto.

**Specchi del documento** (IMMUTABLE)

| Helper | Cosa fa |
|---|---|
| `_fatture_coda_progressivo(p_sezionale text, p_numero int, p_anno int) RETURNS text` | `CASE WHEN p_sezionale='FPR' THEN 'F' ELSE 'A' END ‖ lpad((p_anno % 100)::text, 2, '0') ‖ <numero su 6 cifre senza troncare>`. Specchio di `progressivoInvioFattura` (G12) |
| `_fatture_coda_numero_documento(p_sezionale, p_numero, p_anno) RETURNS text` | `p_sezionale ‖ ' ' ‖ p_numero ‖ '/' ‖ CASE WHEN p_sezionale='FPR' THEN right(p_anno::text, 2) ELSE p_anno::text END`. Specchio di `formattaNumeroFattura` |
| `_fatture_coda_tag_xml(p_xml text, p_tag text) RETURNS text` | Il contenuto del tag se `regexp_count(p_xml, '<'‖p_tag‖'>') = 1`, altrimenti NULL (un tag assente o ripetuto è illeggibile). `<Data>` non conta `<DataScadenza…>` (G16) |
| `_fatture_coda_xml_difetto(p_xml, p_sezionale, p_numero, p_anno, p_progressivo, p_data date, p_importo numeric) RETURNS text` | NULL se l'XML è coerente, altrimenti il primo campo che non torna:<br>• forma: `xml` (100 B..512 KB, primo carattere `<`);<br>• `xml.ProgressivoInvio`, `xml.Numero`, `xml.Data`, `xml.ImportoTotaleDocumento`.<br>I cast sono protetti da `CASE` con regex (`^\d{4}-\d{2}-\d{2}$`, `^\d{1,8}(\.\d{1,2})?$`). Gli importi si confrontano come `numeric` |
| `_fatture_coda_riga_difetto(p_riga jsonb, p_pagamento uuid, p_sede uuid, p_numero int, p_sezionale text, p_anno int, p_progressivo text, p_quota uuid) RETURNS text` | NULL se la riga è coerente, altrimenti il campo:<br>• `riga_registro` se non è un oggetto, se le chiavi non sono **esattamente** quelle di `_chiavi_riga_registro()` (`p ?& chiavi` e conteggio uguale) o se supera `max_riga_registro_bytes`;<br>• `riga_registro.<k>` se una delle 7 chiavi `pagamento_id, scuola_id, numero, sezionale, anno, progressivo_invio, quota_adult_id` non è uguale alla colonna.<br>Tipi controllati con `jsonb_typeof` prima del cast; `quota_adult_id` confrontato con `IS NOT DISTINCT FROM`. `importo` della riga non si confronta (C§7.3) |
| `_fatture_coda_anomalia_valida(jsonb) RETURNS boolean` | Esattamente le chiavi `{tipo, chiave, dati}`:<br>• `tipo` in `TIPI_ANOMALIA`;<br>• `chiave` `^[a-z0-9_:.+-]{1,120}$`;<br>• `dati` oggetto piatto che passa `dati_sicuri` |

**La regola dei 12 giorni.** **`_fatture_coda_invio_oltre_limite(p_data_documento date, p_autorizzata_il timestamptz) RETURNS boolean LANGUAGE sql VOLATILE`**:
- = `p_autorizzata_il IS NULL AND _fatture_coda_oggi_fiscale() − p_data_documento > _fatture_coda_giorni_limite_trasmissione()`;
- è l'unica regola dei 12 giorni (C§9, S42).

### 4.2 Tabelle

**Regole comuni:**
- colonne e significato: C§7; qui ci sono tipi, default, nomi dei vincoli (li legge il lock) e indici;
- ogni `timestamptz` con default prende `DEFAULT public._fatture_coda_adesso()`;
- ogni id uuid prende `gen_random_uuid()`.

#### `fatture_coda_gruppi`

**Colonne:**
- `id uuid` (chiave primaria), `seq bigint GENERATED ALWAYS AS IDENTITY`, `richiesta_id uuid NOT NULL`;
- `creato_da uuid NOT NULL REFERENCES public.utenti(id)` (NO ACTION), `creato_ruolo`, `origine`;
- `urgente boolean NOT NULL DEFAULT false`, `voci_accodate int NOT NULL`, `periodo jsonb`;
- `creato_il`, `concluso_il`.

**Vincoli:**
- `_seq_key UNIQUE(seq)`, `_richiesta_key UNIQUE(richiesta_id)`;
- `_ruolo_chk` (admin, coordinator, segreteria), `_origine_chk` (i 6 valori di `ORIGINI_GRUPPO`);
- `_voci_chk BETWEEN 1 AND 500`;
- `_periodo_chk`: `periodo` solo con origine `periodo`, e deve passare `dati_sicuri`;
- `_tempi_chk`.

**Indici:** `(creato_da, creato_il DESC)`; `(creato_il) WHERE concluso_il IS NULL`.

#### `fatture_coda_voci`

**Identità:**
- `id`;
- `gruppo_id` → gruppi RESTRICT;
- `pagamento_id` → `pagamenti` CASCADE (guardia `55006`, §4.3);
- `scuola_id uuid NOT NULL` → `schools` RESTRICT.

**Documento:**
- `tipo_documento text NOT NULL DEFAULT 'TD01'`;
- `fattura_rettificata_id` → `fatture_emesse` RESTRICT;
- `motivo text NOT NULL`, `origine_iniziale text NOT NULL`.

**Ordine:**
- `urgente`, `reinvio_pendente boolean NOT NULL DEFAULT false`;
- `livello smallint GENERATED ALWAYS AS (CASE WHEN reinvio_pendente THEN 0 WHEN motivo <> 'prima_emissione' THEN 1 WHEN urgente THEN 2 ELSE 3 END) STORED`;
- `data_riferimento date NOT NULL`, `ordine_selezione int NOT NULL DEFAULT 0`.

**Tempi:** `accodata_il`, `in_attesa_dal`, `stato_dal`.

**Causale e intestatario:**
- `causale_modo text NOT NULL DEFAULT 'invariata'`, `causale_manuale text`;
- `intestatario_scelto jsonb`, `intestatario_origine text`, `ricorda_scheda boolean NOT NULL DEFAULT false`.

**Lavorazione:**
- `stato text NOT NULL DEFAULT 'in_coda'`, `lavoro text`;
- `tentativi int NOT NULL DEFAULT 0`, `rientri_guasto smallint NOT NULL DEFAULT 0`;
- `giro bigint`, `lavoratore_token uuid`, `prestito_scade_il`, `presa_il`;
- **`anomalia_da_consegnare jsonb`** (v4).

**Verifica:**
- `verifica_dovuta_il`, `verifica_auto_esito text`;
- `azione_richiesta text`, `azione_richiesta_da` → utenti SET NULL, `azione_richiesta_il`.

**Esito e chiusura:**
- `esito_codice text`, `esito_messaggio text`, `esito_http smallint`, `esito_il`;
- `concluso_il`, `creato_il`, `aggiornato_il`.

Nessuna `azione_forzata`.

**Vincoli nominati**

| Area | Vincoli |
|---|---|
| Documento | `_tipo_chk`; `_motivo_chk`; `_origine_chk` (i 5 valori di `ORIGINI_ACCODAMENTO`); `_td04_chk`: `(tipo='TD04') = (motivo='nota_credito') = (fattura_rettificata_id IS NOT NULL)` |
| Stato e lavoro | `_stato_chk`; `_lavoro_chk`: `(stato='in_invio') = (lavoro IS NOT NULL)`; `_prestito_chk`: in `in_invio` sono non nulli `prestito_scade_il`, `lavoratore_token`, `giro` e `presa_il`; `_concluso_chk`: `(stato IN ('emessa','tolta')) = (concluso_il IS NOT NULL)` |
| **Anomalia (v4)** | `_anomalia_chk`: `anomalia_da_consegnare IS NULL OR (stato='in_invio' AND _fatture_coda_anomalia_valida(anomalia_da_consegnare))` |
| Esito e verifica | `_errore_chk`: `errore ⇒ esito_codice`; `_verifica_chk`: `da_verificare ⇒ esito_codice AND verifica_dovuta_il`; `_auto_chk`: `NULL` o `'non_trovata'`; `_azione_chk`: `cerca`/`rimanda`, con `azione_richiesta_il`, solo in `da_verificare`/`in_invio`; `_codice_chk`: la lista esplicita dei 58 `CODICI_ESITO_VOCE`; `_messaggio_chk ≤ 1000`; `_http_chk 0..999` |
| Causale e intestatario | `_causale_chk`: `manuale ⇔ testo` di 1..1000 caratteri dopo `btrim`; `_intestatario_chk`: `tipo ∈ {adult, persona}`, ≤ 4 KB, `adult_id` uuid se `adult`; `_int_origine_chk`; `_ricorda_chk` |
| Contatori | `_contatori_chk`: `ordine_selezione` 0..100000, `tentativi` 0..10000, `rientri_guasto` 0..3 |
| Minimizzazione | `_minimo_chk`: una voce chiusa ha `causale_modo='invariata'` e intestatario, `esito_messaggio` e `ricorda_scheda` neutri |
| Tempi | `_tempi_chk` |

**Indici:**
- `fatture_coda_voci_una_attiva_uidx (pagamento_id, tipo_documento) WHERE stato IN ('in_coda','in_invio','da_verificare','errore')`;
- `_attesa_idx (livello, data_riferimento, ordine_selezione) WHERE stato='in_coda'`;
- `_verifica_idx (verifica_dovuta_il) WHERE stato='da_verificare'`;
- `_gruppo_idx (gruppo_id, stato)`, `_sede_idx (scuola_id, stato)`, `_pagamento_idx`;
- `_prestito_idx (prestito_scade_il) WHERE stato='in_invio'`, `_token_idx`, `_in_attesa_idx (in_attesa_dal) WHERE stato IN ('in_coda','in_invio')`, `_conclusa_idx (concluso_il)`.

#### `fatture_coda_invii`

**Colonne:**
- chiavi esterne: `voce_id`, `pagamento_id`, `scuola_id` (tutte RESTRICT); `fattura_emessa_id` → `fatture_emesse` RESTRICT;
- quota: `quota_adult_id uuid`, `quota_label text`;
- numero: `sezionale text`, `anno int`, `numero int`, `progressivo_invio text`, `data_documento date`, `importo numeric(10,2)`;
- documento: `xml text`, `riga_registro jsonb`;
- stato e tentativi: `stato text`, `tentativi int DEFAULT 0`, `primo_tentativo_il`, `tentato_il`;
- contatori: `consecutivi_429 smallint NOT NULL DEFAULT 0`, `ricerche_fallite smallint NOT NULL DEFAULT 0`;
- ricerca: `ricerca_il`, `ricerca_esito`;
- `tardiva_autorizzata_il timestamptz` (NULL di default, senza FK);
- esito: `esito_il`, `esito_http`, `esito_codice`, `esito_dettaglio`, `aruba_filename`, `id_sdi`;
- `registrata_il`, `creato_il`, `aggiornato_il`.

**Vincoli nominati**

| Area | Vincoli |
|---|---|
| Stato e numero | `_stato_chk`; `_serie_chk`: `sezionale IN ('Asilo','FPR')`, `numero ≥ 1`, `anno = extract(year FROM data_documento)`; **`_progressivo_chk` (v4)**: `progressivo_invio = _fatture_coda_progressivo(sezionale, numero, anno)`; `_importo_chk > 0`; `_label_chk ≤ 200` |
| Documento | `_carico_chk`: un invio aperto ha `xml` e `riga_registro`; `_vuoto_chk`: in `registrata`, `rifiutata` e `bruciata` sono nulli; **`_xml_chk` (v4)**: `xml IS NULL OR _fatture_coda_xml_difetto(xml, sezionale, numero, anno, progressivo_invio, data_documento, importo) IS NULL`; **`_riga_chk` (v4)**: `riga_registro IS NULL OR _fatture_coda_riga_difetto(riga_registro, pagamento_id, scuola_id, numero, sezionale, anno, progressivo_invio, quota_adult_id) IS NULL` |
| Tentativi e ricerca | `_tentativo_chk` (C0.5 n. 1): `(tentativi = 0) = (stato = 'numerata' OR (stato = 'bruciata' AND esito_codice IS DISTINCT FROM 'numero_conteso'))`, e `tentativi > 0 ⇒ tentato_il`; `_contatori_chk`: i due contatori `BETWEEN 0 AND 3`; `_ricerca_chk`: `(ricerca_il IS NULL) = (ricerca_esito IS NULL)` ed esito in `ESITI_RICERCA` |
| Esito | `_filename_chk`: in `caricata`/`registrata` c'è il filename, di 1..255 caratteri; `_registrata_chk`: in `registrata` ci sono `registrata_il` e `fattura_emessa_id`; `_codice_chk`: la regex di `CODICI_ESITO_INVIO` (C§8.3); `_esito_chk`: `esito_dettaglio ≤ 2000`, `id_sdi` `^[A-Za-z0-9_.-]{1,64}$`; `_tempi_chk` |

**Indici:**
- `_numero_uidx (sezionale, anno, numero)`;
- `_quota_viva_uidx (voce_id, COALESCE(quota_adult_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE stato NOT IN ('rifiutata','bruciata')`;
- `_fattura_uidx (fattura_emessa_id) WHERE fattura_emessa_id IS NOT NULL`;
- `(voce_id)`, `(pagamento_id)`, `(stato) WHERE stato IN (<aperti>)`.

Il `CHECK` con le regex sull'XML si rivaluta a ogni UPDATE della riga. Il costo è trascurabile: oggi gli XML pesano da 3,3 a 3,5 KB (G14), e un invio si aggiorna una decina di volte.

#### `fatture_coda_eventi`

**Colonne:**
- `id bigint GENERATED ALWAYS AS IDENTITY` (chiave primaria);
- `voce_id` e `gruppo_id` → SET NULL;
- `pagamento_id` senza FK; `scuola_id` → `schools`;
- `azione`, `attore_id` → `utenti` NO ACTION;
- `dettaglio jsonb NOT NULL DEFAULT '{}'`, `il`.

**Vincoli:**
- `_azione_chk` con i 21 valori di C§7.4;
- `_dettaglio_chk` = `dati_sicuri(dettaglio)`.

**Indici:** `(voce_id, il)`, `(gruppo_id, il)`, `(scuola_id, il)`, `(il)`, `(pagamento_id, azione)`.

**`dettaglio` per azione (v4):**
- `anomalia`: `{tipo, chiave, consegna}`, con `consegna` in `CONSEGNE_ANOMALIA`;
- `chiusa`: `{richiesto, codice, finale, stato, http, bidello, forzato, anomalia?, consegna?}`;
- `sdi_*`: `{fattura_emessa_id, n}`;
- `rimessa` e `verifica_richiesta`: `{…, forzata, autorizzati}`.

#### `fatture_coda_avvisi`

**Colonne:**
- `id uuid` (chiave primaria), `tipo`;
- `destinatario_id` → `utenti` CASCADE; `a_tutti_gli_admin boolean NOT NULL DEFAULT false`;
- `gruppo_id`, `voce_id`, `attore_id` senza FK;
- `dati jsonb NOT NULL DEFAULT '{}'`, `chiave_dedup text NOT NULL`;
- `tentativi smallint NOT NULL DEFAULT 0`, `lease_token`, `lease_scade_il`, `inviato_il`, `creato_il`.

**Vincoli:**
- `_chiave_key UNIQUE(chiave_dedup)`;
- `_tipo_chk` (9 tipi);
- **`_dest_chk`: `destinatario_id IS NOT NULL OR a_tutti_gli_admin`** (C§7.5; la forma della v2 era sbagliata);
- `_dati_chk` = `dati_sicuri`, che ammette `fine_gruppo` come unico oggetto annidato;
- `_chiave_chk ^[a-z0-9_:.+-]{1,160}$`;
- `_lease_chk`: `(lease_token IS NULL) = (lease_scade_il IS NULL)`, `tentativi` 0..20.

**Indici:**
- `_da_inviare_idx (creato_il) WHERE inviato_il IS NULL`;
- **`_in_attesa_gruppo_idx (gruppo_id, destinatario_id, tipo) WHERE inviato_il IS NULL AND lease_token IS NULL`**: serve all'aggregazione degli errori e a `fine_gruppo`.

#### `fatture_coda_stato`, `aruba_cancello`, `aruba_tentativi`

Come C§7.6-§7.8.
- **`fatture_coda_stato`**: riga `id=1`, con `ultima_sveglia_il` e `ultimo_giro_il` NULL all'inizio; `sospesa_da` → `utenti` SET NULL; `_sospesa_chk` (`sospesa = (sospesa_il IS NOT NULL)`); `pausa_motivo` e `sospesa_motivo` ≤ 200.
- **`aruba_cancello`**: riga unica; `_titolare_chk` (titolare, token, prestito e `preso_il` nulli insieme); `_circuito_chk`; `fence ≥ 0`.
- **`aruba_tentativi`**: `id` identity; `il` dall'orologio; `_tipo_chk`, `_titolare_chk`, `_esito_chk` (9 esiti; `esito` ed `esito_il` nulli insieme). Indici `(tipo, il)`, `(invio_id) WHERE invio_id IS NOT NULL`, `(il)`, `(token, tipo, il)`.

### 4.3 Trigger di invarianza (file 1)

**Regole comuni:**
- tutti `BEFORE`, con `SET search_path`;
- errori `23514` (transizione vietata o campo immutabile) oppure `55006`;
- la cancellazione passa solo con `current_setting('app.fatture_coda_pulizia', true) = 'on'`.

#### `_fatture_coda_voci_guardia()` — `BEFORE INSERT OR UPDATE OR DELETE`

**INSERT.** Forza lo stato iniziale:
- `stato='in_coda'`;
- lavoro, giro, token, prestito, `esito_*` e **`anomalia_da_consegnare`** nulli;
- contatori a 0, `reinvio_pendente=false`;
- `accodata_il`, `in_attesa_dal` e `stato_dal` = adesso.

**DELETE.**
- Con la pulizia attiva passa.
- Dal CASCADE di un pagamento: `55006` se `OLD.stato IN ('in_invio','da_verificare')` o se la voce ha un invio qualsiasi (S29).

**UPDATE.**
- **Immutabili:** `id, pagamento_id, scuola_id, tipo_documento, fattura_rettificata_id, motivo, origine_iniziale, data_riferimento, accodata_il, creato_il`.
- **Solo con `errore → in_coda`:** cambiano `gruppo_id` e `ordine_selezione`.
- **`reinvio_pendente`:** cambia solo con `pg_trigger_depth() > 1`.
- **Transizioni:** le 9 coppie di C§5.1, più i controlli di riserva sugli invii:

  | Transizione | Vietata (23514) se… |
  |---|---|
  | `→ tolta` | la voce ha un invio qualsiasi |
  | `→ emessa` | c'è un invio aperto |
  | `→ errore` | c'è un invio aperto, salvo `guasto_ripetuto`/`oltre_12_giorni` con aperti tutti `numerata` |
  | `→ da_verificare` | non c'è un `incerta`/`caricata`, oppure c'è un `in_volo` |
  | `in_invio → in_coda` | c'è un `in_volo`, `caricata` o `incerta` |

- **`anomalia_da_consegnare` (v4):** cambia solo con `OLD.stato = 'in_invio'`, e solo da NULL a valore (parcheggio) o da valore a NULL (consegna). Da un valore a un altro → `23514`, perché la seconda anomalia va solo in eventi e log. `_anomalia_chk` la obbliga a NULL fuori da `in_invio`.
- **Voce `emessa`:** cambia solo `esito_codice`, secondo la mappa di C§5.1. **Voce `tolta`:** nulla.
- **`urgente`:** cambia solo in `in_coda` o con `errore → in_coda`.
- **Causale, intestatario, `ricorda_scheda`:** cambiano solo con `OLD.stato = NEW.stato ∈ {in_coda, errore}` e nessun invio aperto, oppure verso i valori neutri alla chiusura.
- **`in_attesa_dal`:** lo calcola sempre il trigger (S17): adesso quando la voce entra in `{in_coda, in_invio}` da fuori, altrimenti `OLD`. Una scrittura diretta si ignora.
- **`stato_dal`, `aggiornato_il`:** li scrive il trigger.

#### `_fatture_coda_invii_guardia()` — `BEFORE INSERT OR UPDATE OR DELETE`

**INSERT:**
- stato `numerata` o `bruciata`;
- contatori a 0, ricerca nulla, `tardiva_autorizzata_il` nulla;
- pagamento e sede uguali a quelli della voce.

**DELETE:** solo con la pulizia attiva.

**UPDATE:**
- **Immutabili:** voce, pagamento, sede, quota, serie, anno, numero, progressivo, data, importo, `creato_il`.
  - `aruba_filename`, `id_sdi` e `fattura_emessa_id` non cambiano più una volta scritti.
  - `xml` e `riga_registro` restano uguali oppure diventano NULL.
- **Transizioni:** solo quelle di C§5.2.
- **`bruciata` da un invio esistente (C0.5 n. 1):** solo `da_ritentare`/`incerta` → `bruciata` con `NEW.esito_codice = 'numero_conteso'`; ogni altra via a `bruciata` passa dall'INSERT di `numero_bruciato`.
- **`consecutivi_429`:** forzato a 0 quando `NEW.stato IN ('caricata','registrata','rifiutata','bruciata')` e lo stato cambia. Altrimenti il nuovo valore può essere solo `OLD`, `LEAST(OLD+1, 3)` o `0`.
- **`ricerche_fallite`:** stessa forma.
- **`tardiva_autorizzata_il`:** da NULL si scrive solo su un invio aperto non `caricata`; una volta scritta non cambia e non si azzera.

#### Gli altri trigger

| Trigger | Regola |
|---|---|
| `_fatture_coda_invii_reinvio()` — `AFTER INSERT OR UPDATE OF stato` | `voci.reinvio_pendente := EXISTS(invii della voce in 'numerata' o 'da_ritentare')`, scritto solo se cambia |
| `_fatture_coda_gruppi_guardia()` | immutabili tranne `voci_accodate` e `concluso_il`, che passa una volta sola da NULL a valore |
| `_fatture_coda_eventi_guardia()` | solo aggiunte: `UPDATE` ammesso per i SET NULL delle FK |
| `_aruba_tentativi_guardia()` | solo aggiunte: `UPDATE` ammesso su `esito/http/esito_il` e `invio_id` quando sono NULL |

### 4.4 RLS, privilegi, commenti

Per ognuna delle 8 tabelle:
- `ENABLE` + `FORCE ROW LEVEL SECURITY`, 0 policy;
- `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`, poi `GRANT SELECT … TO service_role`;
- `COMMENT ON TABLE` in italiano.

Su ogni helper e trigger: `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated`.

---

## 5. File 2 — `<T1+60s>_fatture_coda_rpc.sql`

### 5.1 Helper interni (senza GRANT)

| Helper | Cosa fa |
|---|---|
| `_fatture_coda_log(p_evento, p_livello, p_esito, p_messaggio, p_campi DEFAULT '{}', p_distingui DEFAULT NULL)` | `app_log` con `ON CONFLICT (fingerprint, giorno) DO UPDATE` (occorrenze + 1), dentro `EXCEPTION WHEN OTHERS THEN NULL`.<br>• `operazione` da `p_campi`, di default `fatture-coda-tick` per `cron` e `fatture-coda` per `fattura`;<br>• `fingerprint = left(evento‖':'‖operazione‖':'‖esito‖COALESCE(':'‖distingui,''), 64)`;<br>• `distingui` solo per `anomalia` (col tipo) e `sospesa`, mai per voce (F25) |
| `_fatture_coda_evento(voce, gruppo, pagamento, sede, azione, attore, dettaglio)` | una riga di traccia |
| `_fatture_coda_avviso(tipo, dest, admin, gruppo, voce, attore, dati, chiave) → bool` | `INSERT … ON CONFLICT (chiave_dedup) DO NOTHING` con `lower(chiave)`; vero se ha inserito |
| **`_fatture_coda_chiave_monotona(p_prefisso text, p_id uuid) → text`** (v4) | `lower(prefisso‖':'‖id‖':'‖GREATEST(epoch_ms(adesso), COALESCE(max(ms delle chiavi prefisso:id:*), -1) + 1))`. Serve a `dav:`, `vm:`, `err:`: con l'orologio fermo dei test o due fatti nello stesso millisecondo non si perde un avviso |
| **`_fatture_coda_avviso_errore(p_voce, p_gruppo, p_dest, p_dati, p_anomalia text)`** (v4, C§7.5) | **Senza anomalia**, fino a 3 volte:<br>(1) `SELECT … FOR UPDATE` dell'avviso `errore` del gruppo con `NOT a_tutti_gli_admin` e `inviato_il`/`lease_token` nulli: se c'è, `dati.n + 1` e fine;<br>(2) altrimenti INSERT con chiave `err:<gruppo>:<ms monotono>`;<br>(3) se l'INSERT non ha scritto per una corsa, si ripete.<br>Dopo 3 giri `RAISE`.<br>**Con anomalia:** avviso proprio, `n=1`, `a_tutti_gli_admin`, `dati.anomalia`, chiave `err:<voce>:<ms monotono>`; mai aggregato, e mai bersaglio di aggregazione |
| `_fatture_coda_ruolo_staff(uuid) → text` | `ruolo IN ('admin','coordinator','segreteria') AND archiviato_il IS NULL` (G7) |
| `_fatture_coda_sede_propria(attore, sede) → bool` | `utenti.scuola_id = sede`, oppure (admin e riga in `utenti_scuole`): la semantica di `scuoleDiUtente` (G6) |
| `_fatture_coda_somma_429(voce) → int` | somma di `consecutivi_429` sugli invii aperti |
| **`_fatture_coda_partita_non_registrata(p_pagamento uuid) → bool`** (v4, R6 riscritta in C0.5 n. 7) | Testo di contratto C0.3, forma CASE: `p.fattura_stato = 'in_attesa' AND CASE WHEN p.fattura_aruba_id IS NOT NULL THEN NOT EXISTS(riga del pagamento con aruba_filename = p.fattura_aruba_id) ELSE NOT EXISTS(riga viva del pagamento) END`.<br>Riga viva = `sdi_stato IS NULL OR sdi_stato <> ALL(_fatture_coda_stati_scarto_sdi())`.<br>Quota B viva e file della quota A assente ⇒ vero; sola riga scartata dello stesso file ⇒ falso (ritrasmissione). In produzione dà 6 (C0.3) |
| **`_fatture_coda_trasporto_in_sospeso(p_pagamento, p_solo_scollegate bool) → bool`** | una riga viva con `sdi_stato` e `aruba_filename` nulli; con `p_solo_scollegate`, solo le righe che nessun invio collega (per `rimetti`) |
| `_fatture_coda_upload_ultima_ora()`, `_fatture_coda_upload_istanti()` | tentativi `upload` dell'ultima ora con esito diverso da `non_eseguito`, più le righe di `fatture_emesse` con `aruba_filename` nell'ultima ora che nessun invio collega |
| `_fatture_coda_imposta_pausa(codice) → timestamptz` | `pausa_fino_a := GREATEST(COALESCE(pausa_fino_a, adesso), adesso + 15')`; evento `pausa`; warn `pausa-esito-incerto` |
| **`_fatture_coda_apri_circuito(p_motivo) → jsonb`** (v4) | Precondizione: il chiamante ha il cancello `FOR UPDATE`.<br>• `circuito_fino_a := GREATEST(…, adesso + 60')`; `circuito_aperto_il` scritto solo se il circuito era chiuso;<br>• evento `circuito_aperto`, warn `circuito-aperto`;<br>• avvisi `pausa_429` agli accodanti in attesa, chiave `c429:<epoch circuito_aperto_il>:<utente>`.<br>Lo usano `aruba_cancello_esito` e `chiudi(…,'aruba_429')` |
| `_fatture_coda_accodanti_in_attesa() → uuid[]` | chi ha voci `in_coda`/`in_invio` |
| `_fatture_coda_inserisci_voce(…)` | §5.7 |
| `_fatture_coda_chiudi_voce(…) → jsonb` e `_fatture_coda_consegna_chiusura(…)` | §5.3 |
| `_fatture_coda_aggiorna_gruppo(p_gruppo)` | §5.10 |
| `_fatture_coda_doppioni_aperti(uuid[]) → uuid[]` | id di voci, S34, al più 500 |
| `_fatture_coda_sveglia(p_motivo) → bool` | §5.11 |

### 5.2 L'ordine: `_fatture_coda_in_ordine()`

`RETURNS TABLE (voce_id, lavoro, rango, posizione, giro, richiede_upload)`, `LANGUAGE sql VOLATILE`. Conforme a C§6:
- **candidati:** le voci `in_coda`; le voci `da_verificare` con un'azione richiesta, oppure con `verifica_auto_esito IS NULL AND verifica_dovuta_il ≤ adesso`, oppure con un invio `caricata`;
- **rango:** 0 per le verifiche, altrimenti `livello`;
- **ordine:** `ORDER BY rango, CASE WHEN rango=3 THEN seq END, data_riferimento, seq, ordine_selezione, id`;
- **`richiede_upload`:** `stato='in_coda' OR azione_richiesta='rimanda'`.

La usano `prossima`, `posizioni`, `riepilogo`, `prendi` e `rilascia`.

### 5.3 La chiusura: `_fatture_coda_chiudi_voce(p_voce, p_esito, p_codice, p_messaggio, p_http, p_da_bidello) → jsonb`

**Precondizione:** voce `FOR UPDATE` in `in_invio`. Con `p_codice='aruba_429'` il chiamante ha già il cancello `FOR UPDATE` (§5.5).

**0. Validazione** (rifiuti prima di ogni scrittura).
- `resta_da_verificare` solo dal lavoro `verifica`; gli altri esiti da ogni lavoro.
- Il codice deve stare nel gruppo del suo esito (C§8.2).
- Codici che nascono solo da una conversione (R5):
  - `guasto_ripetuto` passato a mano → `BAD_INPUT`, con qualunque esito;
  - `aruba_429_ripetuto` → `BAD_INPUT` se `_somma_429 < 3`;
  - `ricerca_non_riuscita` → `BAD_INPUT` se nessun invio aperto ha `ricerche_fallite = 3`.
- `emessa` con codice `gia_a_registro` si accetta anche se ogni quota ha l'ultimo invio `registrata`: rientra nel primo ramo di C§5.1.

**1. Lock** degli invii della voce, `FOR UPDATE ORDER BY id`.

**2. Effetti propri dei codici** (C§5.1):
- `ricerca_da_ripetere` senza un invio aperto con `ricerca_esito='illeggibile' AND ricerca_il ≥ presa_il` → `RICERCA_MANCANTE`;
- `oltre_12_giorni` → `BAD_INPUT` se manca la condizione del suo esito. Con `da_verificare`, i `da_ritentare` oltre il limite diventano `incerta oltre_12_giorni` al punto 4.

**3. Conversioni** (C§5.1): la prima che si applica, nell'ordine a, b, c.
- **a.** Somma dei 429 ≥ 3 su `riprova`, `rientro` o `resta` non concludente.
- **b.** `ricerca_da_ripetere` con un invio a `ricerche_fallite = 3`.
- **c.** Guasto nostro: sotto il tetto `rientri_guasto + 1` (evento `rientro_guasto`, warn `rientro-guasto`). Al quarto guasto: i `da_ritentare` → `incerta guasto_ripetuto`; con un `incerta` o `caricata`, voce `da_verificare guasto_ripetuto` (M); altrimenti `errore guasto_ripetuto`.

Con una conversione: `forzato:=true`, `codice_finale` = il codice nuovo.

**4. Blocco annidato** (savepoint):
- (a) scritture sugli invii;
- (b) controlli sugli stati degli invii dopo le conversioni (C§5.1). Se falliscono: `RAISE … ERRCODE 'FC001'`, poi fuori dal blocco si rileggono gli stati originali e si risponde `{ok:false, code:'INVII_INCOERENTI', invii:[{invio_id, stato}]}` con error `invii-incoerenti`. L'anomalia parcheggiata resta sulla voce.

**5. Stato** (v4): `SELECT … FROM fatture_coda_stato WHERE id=1 FOR UPDATE`, **sempre**, prima dell'UPDATE della voce (ordine dei lock, §5.9).
- Pausa per i codici P e `CODICI_RIPROVA_PAUSA`.
- Con codice `aruba_429`, se il circuito non è aperto: `_fatture_coda_apri_circuito('aruba_429')` (R8).

**6. Consegna** del fatto (§5.3.1): scrive l'avviso **prima** dell'UPDATE di stato (C§7.5).

**7. UPDATE della voce:**
- stato, `esito_*`, verifica, azione (azzerata in ogni uscita dalla verifica tranne `resta` non concludente);
- `lavoro := NULL`, `prestito_scade_il := NULL`, **`anomalia_da_consegnare := NULL`**; token e `giro` restano;
- `esito_messaggio := left(…, 1000)`.

Il trigger d'effetto chiama `_fatture_coda_aggiorna_gruppo`, che trova l'avviso del punto 6 (S45).

**8.** Con esito `emessa`: `esito_dettaglio := NULL` sugli invii della voce.

**9.** Evento `chiusa` (con `anomalia` e `consegna` se ha consegnato un'anomalia parcheggiata) e i log di C§15:
- warn `esito-incerto` per P;
- `aruba-429-ripetuto`, `ricerca-non-riuscita`, `rientro-guasto`.

Ritorna `{ok, stato, gruppo_id, forzato, codice_finale}`.

**Effetti per gruppo di codici** (C§8.2):

| Chiusura | Effetti |
|---|---|
| `emessa` | `concluso_il`, minimizzazione |
| `errore` | `esito_*`; avviso secondo §5.3.1 |
| `da_verificare` **P** | pausa; `verifica_dovuta_il := pausa_fino_a`; `verifica_auto_esito := NULL`; avviso `da_verificare` con `verifica_automatica_il = GREATEST(pausa_fino_a, circuito_fino_a se è nel futuro)` |
| `da_verificare` **R** | `verifica_dovuta_il := adesso`; avviso `da_verificare` |
| `da_verificare` **M** | `verifica_dovuta_il := adesso`; `verifica_auto_esito := 'non_trovata'`; avviso `verifica_manuale` |
| `resta` concludente | `verifica_auto_esito := 'non_trovata'`; azione azzerata; avviso `verifica_manuale` |
| `resta` non concludente | `verifica_dovuta_il := adesso + 4'`; azione conservata; nessun avviso della voce |
| `riprova` / `rientro` | `in_coda`; `esito_codice` = il codice |

#### 5.3.1 `_fatture_coda_consegna_chiusura` — un fatto, un avviso (C§8.2, S44)

1. **Parcheggiata:** `v_parch := voce.anomalia_da_consegnare`, che può essere NULL.
2. **Intrinseca**, decisa dal codice **finale**:

   | Codice finale | Anomalia | Chiave |
   |---|---|---|
   | `registro_mancante` | `partita_non_registrata` | id dell'invio `caricata` |
   | `numero_conteso` (`errore`, C0.2 D3) | `numerazione_anomala` | `lower(<serie>-<anno>-<numero>)` dell'invio `bruciata numero_conteso` |
   | `guasto_ripetuto` | `guasti_ripetuti` | id della voce |

   Nasce adesso, quindi scrive sempre evento `anomalia` e log `anomalia` (error, distinto per tipo).
3. **Da consegnare:** `v_cons := COALESCE(v_parch, v_intr)`. Se ci sono tutte e due, l'intrinseca ha consegna `scartata_seconda`: solo evento e log.
4. **Avviso del fatto**, deciso dall'esito finale. `accodante` = `creato_da` del gruppo corrente della voce; serie, numero e anno sono quelli dell'ultimo invio.
   - **`errore`:** `_fatture_coda_avviso_errore(voce, gruppo, accodante, {codice, sezionale?, numero?, anno?}, v_cons.tipo)`.
   - **`da_verificare` P/R:** avviso `da_verificare`, `destinatario_id = accodante`, `a_tutti_gli_admin = true`, chiave `_chiave_monotona('dav', voce)`, `dati = {codice, sezionale, numero, anno, verifica_automatica_il?, anomalia?}`.
   - **`da_verificare` M e `resta` concludente:** avviso `verifica_manuale`, uguale ma con chiave `_chiave_monotona('vm', voce)`.
   - **`emessa`, `riprova`, `rientro`, `resta` non concludente:** nessun avviso della voce. Se c'è `v_cons`, avviso `anomalia` ai soli admin (`destinatario_id` NULL, `a_tutti_gli_admin`, `gruppo_id` e `voce_id` valorizzati), chiave `anom:<tipo>:<chiave>`, `dati = {tipo, sezionale?, numero?, anno?}`. Se la chiave c'è già (lo stesso fatto rivisto), solo evento e log.
5. **Traccia:** l'intrinseca finisce nell'evento `anomalia` con consegna `avviso_voce`; una parcheggiata consegnata va nell'evento `chiusa` con `{anomalia, consegna: avviso_voce|avviso_proprio}`.

Conseguenza, provata in §10:
- (a) `registro_mancante`, (b) `numero_conteso` e (c) conversione c producono **una** riga per fatto, con `a_tutti_gli_admin`;
- nessuna riga `anomalia` accanto;
- D5 unisce i destinatari (C§14 punto 2.3), quindi ogni admin riceve una notifica.

### 5.4 Cancello (C§9.1)

**`aruba_cancello_prendi`**:
1. validazione;
2. cancello `FOR UPDATE`;
3. bidello, che riprende lo stesso lock;
4. con titolare `coda`: `ultimo_giro_il := adesso`, prima di ogni rifiuto (S26);
5. nell'ordine: circuito → sospesa → pausa → `NIENTE_DA_FARE` → stesso token vivo (idempotente) → `OCCUPATO` (con `richiesta_sync_il` se chiede la sync) → presa (`fence+1`).

**`aruba_cancello_rilascia`**: come C§9.1.
- Con un token diverso: `{ok, rilasciato:false}`.
- Salva `v_preso` e libera il cancello.
- Le voci `in_invio` del token prendono `prestito_scade_il := adesso` (warn `rilascio-con-voci-in-mano {n}`).
- Se un candidato ha `in_attesa_dal > v_preso` o `azione_richiesta_il > v_preso`: `_fatture_coda_sveglia('accodamento')`.
- La condizione della sync in più sta nella richiesta R4.

**`aruba_cancello_prenota`**:
- cancello `FOR UPDATE`; `CANCELLO_PERSO`, `CIRCUITO_APERTO`;
- **`signin`:** 65000 ms dall'ultimo `signin` di qualunque titolare (`SIGNIN_TROPPO_PRESTO{attendi_ms}`);
- **`ricerca`:** `p_limite_minuto` 1..12; con `p_invio_id`, invio di una voce `in_invio` del token (`NON_TUA`); `RICERCA_TROPPO_PRESTO`; il tentativo nasce legato;
- **`upload`:** `p_limite_ora` 1..60 e `p_limite_minuto` 1..30; voce `FOR UPDATE` del token.
  - Numero nuovo: `QUOTA_GIA_NUMERATA` se la quota ha già un invio vivo.
  - Reinvio: invio `numerata`/`da_ritentare`/`incerta` della voce (`STATO_NON_VALIDO`) e `_invio_oltre_limite` falso (`OLTRE_12_GIORNI{data_documento, giorni}`).
  - Poi `RITMO_MINUTO`, `QUOTA_ORARIA{riprova_il}`; il tentativo nasce non legato.
- Ritorna `{ok, tentativo_id, usati_ora, usati_minuto}`.

**`aruba_cancello_esito`**:
1. validazione;
2. cancello `FOR UPDATE`;
3. tentativo; se legato, voce e poi invio `FOR UPDATE`;
4. `UPDATE … WHERE id AND token AND esito IS NULL RETURNING`; nessuna riga → `TENTATIVO_NON_VALIDO`. `non_eseguito` solo per un upload non legato;
5. **contatore dei 429** (S7), solo su un invio aperto:
   - `http_429` → `LEAST(+1, 3)`;
   - `upload` con esito `ok/rifiuto/http_401/http_403/http_5xx/illeggibile` → 0;
   - il resto invariato;
6. `http_429` → `_fatture_coda_apri_circuito('aruba_429')`;
7. 401/403 su `signin` → anomalia `credenziali_aruba`: evento (consegna `avviso_proprio`), log, avviso `anomalia` con chiave `anom:credenziali_aruba:<AAAAMMGG>`;
8. ritorna `{ok, circuito_fino_a, appena_aperto, invio:{id, consecutivi_429, somma_voce}|null}`.

### 5.5 Lavoratore (C§9.2)

**`fatture_coda_prossima`**:
1. advisory lock, validazioni;
2. cancello `FOR UPDATE`: `CANCELLO_PERSO` → `CIRCUITO_APERTO` → `CEDI_ALLA_SYNC` → `TEMPO_INSUFFICIENTE`;
3. stato (lettura): `SOSPESA` → `IN_PAUSA`;
4. `VOCE_GIA_IN_MANO`;
5. al più 100 candidati di `_in_ordine()`:
   - salta chi ha `giro IS NOT DISTINCT FROM fence`;
   - alla testa, con `richiede_upload` e quota piena → `QUOTA_ORARIA`;
   - presa `FOR UPDATE SKIP LOCKED`;
6. presa: `in_invio`, lavoro, token, `giro = fence`, prestito, `presa_il`, `tentativi + 1`; evento `presa`;
7. ritorno di C§9.2, con `oltre_12_giorni = _invio_oltre_limite(data_documento, tardiva_autorizzata_il)` per ogni invio aperto e `verifica_automatica = (lavoro='verifica' AND azione_richiesta IS NULL)`.

**`fatture_coda_invio_registra(p_voce_id, p_token, p_invio)`** (v4, C§7.3):
1. Voce `FOR UPDATE` del token (`NON_TUA`).
2. `p_invio` è un oggetto con **esattamente** le 10 chiavi di `InvioDaRegistrare`, altrimenti `BAD_INPUT{campo:'p_invio'}`.
3. Tipi:
   - `sezionale` in {`Asilo`, `FPR`}; `anno` e `numero ≥ 1` interi;
   - `data_documento` ISO; `importo` numerico > 0 con al più 2 decimali;
   - `quota_adult_id` uuid o null; `quota_label` ≤ 200 o null;
   - `xml` e `riga_registro` presenti.

   Ogni errore dà `BAD_INPUT{campo:<chiave>}`.
4. `data_documento` fra `oggi_fiscale − 1` e `oggi_fiscale`; `anno` = anno della data.
5. `progressivo_invio = _fatture_coda_progressivo(…)` (`campo:'progressivo_invio'`).
6. `_fatture_coda_xml_difetto(...)` non nullo → `BAD_INPUT{campo}` (`xml`, `xml.ProgressivoInvio`, `xml.Numero`, `xml.Data`, `xml.ImportoTotaleDocumento`).
7. `_fatture_coda_tag_xml(xml,'TipoDocumento') = voce.tipo_documento` (`campo:'xml.TipoDocumento'`).
8. `_fatture_coda_riga_difetto(...)` non nullo → `BAD_INPUT{campo}`.
9. Riga uguale in `fatture_emesse` (G8) → `NUMERO_GIA_REGISTRATO` (error `numero-gia-registrato`).
10. INSERT `numerata`. Un `23505` si riconosce con `GET STACKED DIAGNOSTICS … CONSTRAINT_NAME`: su `_numero_uidx` → `NUMERO_GIA_REGISTRATO`; su `_quota_viva_uidx` → `QUOTA_GIA_NUMERATA`.

Ogni `BAD_INPUT` scrive error `bad-input` con `tipo` = campo, mai distinto per voce. Ritorna `{ok, invio_id}`.

**`fatture_coda_numero_bruciato(p_voce_id, p_token, p_invio, p_codice)`** (v4):
- `p_invio` con esattamente le 8 chiavi di `NumeroBruciatoDaRegistrare`, stessi controlli dei punti 3-5; `p_codice` secondo `_invii_codice_chk`, altrimenti `BAD_INPUT`;
- `p_codice = 'numero_conteso'` → `BAD_INPUT` (C0.5 n. 1: quel codice nasce solo da `invio_ricerca`);
- INSERT `bruciata` con `tentativi = 0`, evento `numero_bruciato`, error `numero-bruciato`;
- anomalia `numero_bruciato` con chiave `lower(<serie>-<anno>-<numero>)`:
  - se `anomalia_da_consegnare` è NULL, la parcheggia (evento `anomalia` con consegna `parcheggiata`);
  - altrimenti solo evento (`scartata_seconda`);
  - sempre il log `anomalia`;
- `23505` → `NUMERO_GIA_REGISTRATO`;
- ritorna `{ok, invio_id, consegna}`.

**`fatture_coda_invio_tenta`**:
1. Cancello `FOR SHARE` (`CANCELLO_PERSO`, `CIRCUITO_APERTO`).
2. Voce, poi invio (`NON_TUA`).
3. Per ogni stato di partenza, prima di tutto: `_invio_oltre_limite` → `OLTRE_12_GIORNI`.
4. Per stato:
   - `numerata`: passa;
   - `da_ritentare`: serve `ricerca_esito='assente' AND ricerca_il > tentato_il` (`RICERCA_MANCANTE`);
   - `incerta`: servono `azione_richiesta='rimanda'` (`RINVIO_NON_PERMESSO`) e una ricerca `assente` recente (`RICERCA_MANCANTE`; C0.5 n. 1: `non_combacia` non c'è più, porta a `bruciata`);
   - altrimenti `STATO_NON_VALIDO`.
5. Lega la prenotazione: upload, stesso token, stessa voce, non legata, esito nullo, meno di 2' fa (`TENTATIVO_NON_VALIDO`).
6. `in_volo`, `tentativi + 1`, `tentato_il`.

**`fatture_coda_invio_esito`**, **`fatture_coda_invio_ricerca`**, **`fatture_coda_invio_registrato`**: come C§9.2. In `invio_ricerca`, `non_combacia` su `da_ritentare` o `incerta` → `bruciata`, `esito_codice='numero_conteso'`, `xml`/`riga_registro` NULL, `consecutivi_429 := 0` (C0.2 D3, C0.5 n. 1).
- `0034` con `tentativi ≥ 2` → `incerta gia_ricevuta_0034`.
- `rifiutata` → `xml` e `riga` nulli, warn `numero-non-usato`.
- Con `p_fattura_emessa_id` e lo stesso filename → `registrata`.
- Un esito tardivo su un `incerta` del bidello dà warn `esito-tardivo` e applica solo `caricata`.
- `combacia` confronta i 5 campi (`CONTENUTO_NON_VERIFICATO`). La terza `illeggibile` porta un `da_ritentare` a `incerta ricerca_non_riuscita`.

**`fatture_coda_chiudi`**:
1. **Se `p_codice = 'aruba_429'`**, prima di tutto il cancello `FOR UPDATE` (ordine canonico, §5.9).
2. Voce `FOR UPDATE`, altrimenti `NON_TROVATO`.
3. Voce `in_invio` col token → `_fatture_coda_chiudi_voce(…, false)`.
4. Stesso token ma voce già chiusa: si guarda l'ultimo evento `chiusa`:
   - `bidello:true` → `PRESTITO_SCADUTO{stato}`;
   - stessi `richiesto` e `codice` → risposta idempotente, senza riconsegnare nulla;
   - altrimenti `NON_TUA`.
5. Token diverso → `NON_TUA`, con error `non-tua`.

**`fatture_coda_bidello`** (v4, C§9.2, cinque rami):
1. **Cancello `FOR UPDATE` per primo.**
2. Poi, per ogni voce `in_invio` con prestito scaduto, `FOR UPDATE SKIP LOCKED`, vale la prima regola che si applica:
   1. un invio `in_volo` → ogni `in_volo` diventa `incerta prestito_scaduto`; `da_verificare prestito_scaduto`;
   2. `emissione`/`reinvio` con un `incerta` → `da_verificare`, con `gia_ricevuta_0034` se un `incerta` porta quel codice, altrimenti `prestito_scaduto`;
   3. `emissione`/`reinvio` con un `caricata` → `da_verificare registro_mancante`;
   4. `verifica` con un `incerta`/`caricata` → `resta_da_verificare prestito_scaduto_senza_tentativo`;
   5. altrimenti → `rientro prestito_scaduto_senza_tentativo`.
3. Chiude con `_fatture_coda_chiudi_voce(…, true)`: valgono le conversioni a e c e la consegna dell'anomalia parcheggiata. Un `INVII_INCOERENTI` lascia la voce al giro dopo.
4. Cancello scaduto → liberato.
5. Log: un solo `prestito-scaduto {n}` e un solo `cancello-prestito-scaduto {fence}`.

### 5.6 Outbox e segnalazioni (C§9.3)

**`avvisi_prendi` / `avvisi_conferma`:**
- lease di 2';
- al 10° tentativo l'avviso si marca abbandonato (11), con **un** error `avviso-abbandonato {n}`;
- `avvisi_prendi` ritorna un array; `avvisi_conferma` vale solo col token del lease.

**`fatture_coda_segnala_scarto_sdi(p_fattura_emessa_id, p_codice_sdi, p_doppione)`** (v4):
- **Validazione:**
  - la fattura esiste (`NON_TROVATO`);
  - `p_codice_sdi` NULL oppure `^[0-9]{5}$` (`BAD_INPUT{campo:'p_codice_sdi'}`);
  - `p_doppione` in `{NULL} ∪ ESITI_DOPPIONE`.
- **Voce:** la si trova da `fatture_coda_invii.fattura_emessa_id` e la si blocca `FOR UPDATE`. `accodante` = `creato_da` del gruppo corrente. Il suo `esito_codice` cambia **solo se la voce è `emessa`** (mappa di C§5.1); altrimenti solo evento e avviso.
- **NULL:** avviso `scarto_sdi` `sdi:<fattura>` all'accodante; senza voce nessun avviso.
- **`ricollegato`:** evento `sdi_ricollegata`; voce `emessa` → `sdi_ricollegata`; nessun avviso.
- **`non_identico`:**
  - evento `sdi_doppione`; voce `emessa` → `doppione_sdi`;
  - evento `anomalia` (`numerazione_anomala`, chiave `lower(<serie>-<anno>-<numero>)`, consegna `avviso_voce`) e log `anomalia`;
  - **un solo** avviso `da_verificare` con chiave `dav:sdi:<fattura>`, `destinatario_id` = accodante (NULL senza voce), `a_tutti_gli_admin`, `dati = {codice:'doppione_sdi', sezionale, numero, anno, anomalia:'numerazione_anomala'}`.
- **`non_risolto`:** k = eventi `sdi_00404_non_risolto` della fattura dopo l'ultimo `sdi_ricollegata` o `sdi_doppione`.
  - `k ≥ 6` → nulla;
  - altrimenti evento con `n = k+1`;
  - se `k+1 = 6`: voce `emessa` → `doppione_sdi_irrisolto` e avviso `dav:sdi-nr:<fattura>` (`codice:'doppione_sdi_irrisolto'`, stessi destinatari).
  - Mai scritture su `pagamenti` o `fatture_emesse`.
- Ritorna `{ok, accodante_id, voce_id, non_risolti, da_verificare}`.

**`fatture_coda_segnala_anomalia(p_tipo, p_chiave, p_dati, p_voce_id, p_token)`** (v4):
- **Validazione:** `p_tipo` in `TIPI_ANOMALIA`; `p_chiave` `^[A-Za-z0-9_:.+-]{1,120}$`, poi `lower()`; `p_dati` piatto e sicuro.
- **Sempre:** evento `anomalia` e error `anomalia`, distinto solo per tipo.
- **Con `p_voce_id` di una voce `in_invio` del token:**
  - se `anomalia_da_consegnare` è NULL, la parcheggia (`parcheggiata`);
  - altrimenti solo evento (`scartata_seconda`).
- **Senza voce in mano** (voce assente, chiusa o di un altro token): avviso `anomalia` subito agli admin, chiave `anom:<tipo>:<chiave>` (`avviso_proprio`).
- Ritorna `{ok, consegna}`.

### 5.7 Staff e admin (C§9.4)

**Controlli comuni:**
- attore staff (`ATTORE_NON_STAFF`);
- liste di 1..500 id, deduplicate;
- lock delle voci ordinato per id;
- `FUORI_SEDE`.

**`fatture_coda_accoda`**:
1. Cancello `FOR SHARE`.
2. Gruppo con `ON CONFLICT (richiesta_id) DO NOTHING`. Se c'era già: `{gia_esistente:true, creato_da, origine, voci, sveglia:false}`, senza rivalidare.
3. Per ogni elemento, nell'ordine, fino al primo rifiuto:
   - `BAD_INPUT` → `DUPLICATA_NELLA_RICHIESTA` → `NON_TROVATO` → `SEDE_ASSENTE` → `FUORI_SEDE`;
   - `GIA_IN_CODA` → `TIPO_NON_SUPPORTATO` (TD04) → `NON_SALDATO` (`stato <> 'pagato'`);
   - **`PARTITA_NON_REGISTRATA`** (`_fatture_coda_partita_non_registrata`) → `TRASPORTO_IN_SOSPESO`;
   - `CAUSALE_NON_VALIDA` → `INTESTATARIO_NON_VALIDO`.
4. **`motivo` (S51):** `ritrasmissione` se esiste una riga del pagamento con `sdi_stato = ANY(_fatture_coda_stati_scarto_sdi())`, altrimenti `prima_emissione`.
5. `data_riferimento` = giorno a Roma di `data_incasso`, poi di `creato_il`, poi oggi.
6. `INSERT … ON CONFLICT (pagamento_id, tipo_documento) WHERE stato IN (<attivi>) DO NOTHING`.
7. Le voci `doppione_sdi` dello stesso pagamento → `doppione_sdi_ritrasmesso`.
8. Con 0 voci accodate il gruppo si cancella; con almeno una, sveglia.
9. Info `accodate`.

Ritorna `{ok, gruppo_id, gia_esistente, accodate[{pagamento_id, voce_id, livello}], gia_in_coda[{pagamento_id, voce_id}], rifiutate[{pagamento_id, code}], sveglia}`.

**`fatture_coda_togli`**:
- `in_invio` → `IN_LAVORAZIONE`;
- `da_verificare` → `NUMERO_GIA_ASSEGNATO`;
- `in_coda` con un invio qualsiasi, oppure `errore` con un invio e `NOT _fatture_coda_solo_invii_non_consegnati(voce)` → `NUMERO_GIA_ASSEGNATO` (C0.2 D1, C0.5 n. 3);
- terminale → `STATO_NON_VALIDO`;
- altrimenti `tolta tolta_operatore` (gli invii `rifiutata`/`bruciata` restano a giornale).

**`fatture_coda_rimetti`**:
1. `p_forza` da un non admin → `FORZA_SOLO_ADMIN` per l'intera richiesta.
2. Cancello `FOR SHARE`; gruppo `rimessa_in_coda` idempotente.
3. Voci `FOR UPDATE` ordinate, poi invii.
4. Per voce:
   - `errore` (`STATO_NON_VALIDO`/`IN_LAVORAZIONE`);
   - pagamento `pagato` (`NON_SALDATO`);
   - senza invii: `PARTITA_NON_REGISTRATA` col predicato comune;
   - `TRASPORTO_IN_SOSPESO` sulle righe scollegate;
   - `numerata` oltre il limite: senza forza `OLTRE_12_GIORNI`; con la forza di un admin `tardiva_autorizzata_il := adesso`.
5. **Poi `fatture_coda_stato FOR UPDATE`** (§5.9).
6. UPDATE delle voci: `in_coda`, gruppo nuovo, `ordine_selezione`, `urgente`, `rientri_guasto=0`, `esito_*` nulli.
7. Evento `rimessa {…, forzata, autorizzati}`; info `tardiva-autorizzata`.
8. Gruppo vuoto cancellato; sveglia `rimessa`.

Ritorna `{ok, gruppo_id, gia_esistente, rimesse[], rifiutate[{voce_id, code, …}], autorizzati, sveglia}`.

**`fatture_coda_urgente`**: solo voci `in_coda`.

**`fatture_coda_causale`**:
- invio aperto → `NUMERO_GIA_ASSEGNATO`;
- `in_invio` → `IN_LAVORAZIONE`;
- sede non propria → `CAUSALE_ALTRA_SEDE`.

**`fatture_coda_richiedi_verifica`**:
1. `p_forza` con `cerca` → `BAD_INPUT`; da un non admin → `FORZA_SOLO_ADMIN`.
2. Cancello `FOR SHARE`, poi voce `da_verificare`.
3. Con `rimanda`: gli invii aperti non `caricata` oltre il limite danno `OLTRE_12_GIORNI`; con la forza di un admin, `tardiva_autorizzata_il`.
4. Scrive `azione_richiesta*`.
5. Azzera `ricerche_fallite` e `consecutivi_429` degli invii aperti e `rientri_guasto`.
6. Evento; sveglia `verifica`.

Ritorna `{ok, voce_id, azione, forzata, autorizzati, sveglia}`.

**`fatture_coda_sospendi` / `fatture_coda_riprendi`**:
- `sospendi(NULL, motivo)` = sistema, col motivo di 1..200 caratteri;
- avvisi agli accodanti in attesa, meno l'attore, con chiavi `sosp:`/`rip:`;
- `riprendi` prende il cancello `FOR SHARE` e sveglia.

Ritornano `EsitoSospendi {ok, sospesa, il, gia, avvisi, sveglia}`.

### 5.8 Letture, salute, oblio (C§9.5)

- **`riepilogo`**: `doppioni_aperti` = **id di voci** (S34, al più 500); `sospesa_da_sistema = sospesa AND sospesa_da IS NULL`.
- **`posizioni(p_scuola_ids, p_voce_ids)`**: con `p_voce_ids` NULL, tutti i candidati del perimetro, al più 2000, in ordine di rango.
- **`stato_pagamenti`** (v4, S48): ogni riga ha `invii_oltre_limite: [{invio_id, stato, data_documento, giorni}]`.
  - Comprende gli invii **`numerata`, `da_ritentare` e `incerta`** con `_invio_oltre_limite(data_documento, tardiva_autorizzata_il)` vero.
  - `giorni = _oggi_fiscale() − data_documento`.
  - Al più 2000 pagamenti; array vuoto se nessuno.
- **`salute`**: `{ok, in_attesa_piu_vecchia_dal, sospesa, sospesa_il}`.
- **`oblio`**: toglie solo le voci attive senza alcun invio; conta `trattenute_con_numero` e `in_lavorazione`.

### 5.9 Ordine dei lock (C§7)

Sequenza canonica: **cancello → voci → invii → stato → gruppi → eventi, avvisi, tentativi.** Due regole in più rispetto alla v3, entrambe [D]:
- **Chi aggiorna voci in modo che scatti il trigger d'effetto** (che blocca i gruppi) **e poi scrive `fatture_coda_stato` blocca lo stato prima dell'UPDATE delle voci.** Vale per `chiudi`/bidello (punto 5 di §5.3) e per `rimetti`. Senza questa regola, una rimessa (gruppo vecchio → stato) e una chiusura con pausa di un'altra voce dello stesso gruppo (stato → gruppo) formano un ciclo.
- **Bidello e `chiudi(…,'aruba_429')` prendono il cancello per primi.** Senza, `richiedi_verifica` (cancello `FOR SHARE` → voce) e bidello (voce → cancello `FOR UPDATE`) formano un ciclo.

| RPC | Sequenza |
|---|---|
| `prendi` | cancello → bidello (voci → invii → stato → gruppi) → stato |
| `prossima` | advisory → cancello → (stato in lettura) → voci `SKIP LOCKED` |
| `prenota` (upload) | cancello → voce → tentativi |
| `esito` | cancello → voce → invio → tentativi, stato del circuito, avvisi |
| `invio_*` | (`invio_tenta`: cancello `FOR SHARE`) → voce → invio |
| `chiudi` | (`aruba_429`: cancello) → voce → invii → **stato** → UPDATE della voce → gruppo (trigger) → avvisi |
| bidello | **cancello** → voci `SKIP LOCKED` → invii → stato → gruppi → avvisi |
| `accoda` | cancello `FOR SHARE` → gruppo nuovo → voci (INSERT) → stato (sveglia) |
| `rimetti` | cancello `FOR SHARE` → gruppo nuovo → voci ordinate → invii → **stato** → UPDATE delle voci → gruppi vecchi |
| `richiedi_verifica` | cancello `FOR SHARE` → voce → invii → stato (sveglia) |
| `rilascia` | cancello → voci (solo il prestito, nessun trigger d'effetto) → stato |
| `segnala_scarto_sdi` | voce → avvisi |

### 5.10 Trigger d'effetto e fine del gruppo (S45)

**`_fatture_coda_voci_dopo()`** — `AFTER UPDATE OF stato, lavoro, gruppo_id OR DELETE`: con la pulizia attiva non fa nulla; altrimenti aggiorna il gruppo nuovo e quello vecchio.

**`_fatture_coda_aggiorna_gruppo(p_gruppo)`**:
1. Gruppo `FOR UPDATE`. Esce se è già concluso, se ha voci `in_coda` o `in_invio` con lavoro `emissione|reinvio`, o se non ha voci.
2. `concluso_il := adesso`.
3. `v_fg = {voci_accodate, emesse, errori, da_verificare, tolte}`, con i conteggi sulle voci del gruppo.
4. **Cerca** l'avviso più recente con `gruppo_id = p_gruppo`, `destinatario_id = creato_da`, `tipo IN ('errore','da_verificare','verifica_manuale')`, `lease_token` e `inviato_il` nulli (`ORDER BY creato_il DESC, chiave_dedup DESC`).
5. Se c'è: `UPDATE … SET dati = dati || jsonb_build_object('fine_gruppo', v_fg) WHERE id = … AND lease_token IS NULL AND inviato_il IS NULL`.
6. Se non c'è, o se l'UPDATE non tocca righe: avviso `gruppo_concluso`, chiave `gruppo:<id>`, `dati = v_fg`.

Una voce che torna `in_coda` dopo la conclusione non riapre il gruppo.

### 5.11 La sveglia `_fatture_coda_sveglia(p_motivo)` (C§9.6)

1. Motivo fuori da `MOTIVI_SVEGLIA` → `false`.
2. `to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL` → warn `sveglia-net-assente`, `false`.
3. Cancello della coda con prestito vivo → `false`.
4. Coda sospesa, in pausa o a circuito aperto → `false`.
5. Farfalla con `COALESCE(…, '-infinity')` (F30); nessuna riga aggiornata → `false`.
6. `v_url := public._fatture_coda_url_giro()` dentro `EXCEPTION`: un'eccezione o un URL nullo → error `sveglia-url-assente {error_code?}`, `false`.
7. `net.http_post(url, body := {motivo}, headers := {Content-Type, x-cron-secret}, timeout_milliseconds := 300000)`; salva `ultima_sveglia_richiesta_id`; su eccezione error `sveglia-post-fallito`.
8. `true`.

---

## 6. File 3 — `<T1+120s>_fatture_coda_cron.sql`

**`_fatture_coda_url_giro()`** (helper):
- prende la prima chiave non vuota fra `app.fattura_sync_url`, `app.push_dispatch_url`, `app.notifiche_promemoria_url`, `app.retention_iscrizioni_url` (ognuna dentro `EXCEPTION`);
- ne ricava l'origine come `20260918120000_video_runner_tick.sql:84-97`;
- aggiunge `/api/pagamenti/fattura/coda/giro`.

**`fatture_coda_tick_http()`** (SD, GRANT):
1. Bidello, dentro `EXCEPTION` (error `tick-bidello-fallito`).
2. Esito del POST precedente da `net._http_response` (error `tick-esito-http`, warn `tick-esito-non-letto`).
3. URL nullo → error `url-assente`.
4. `net.http_post(…, timeout_milliseconds := 300000)`.
5. `ultimo_tick_il`, `ultimo_tick_richiesta_id`; un'eccezione → error `post-fallito`.

**`fatture_coda_pulizia()`** (SD, GRANT):
- flag `app.fatture_coda_pulizia` a `on`; limite = adesso − 24 mesi;
- cancella, in quest'ordine: avvisi → tentativi → eventi → invii delle voci chiuse → voci chiuse → gruppi vuoti;
- rimette il flag a `off`;
- **doppioni chiusi (C0.2 D2, C0.5 n. 5):** per ogni voce `emessa` con `esito_codice IN ('doppione_sdi','doppione_sdi_irrisolto')`, pagamento con `stato <> 'pagato'` e nessun evento `doppione_chiuso_pagamento_chiuso` della voce: `_fatture_coda_evento(voce, gruppo, pagamento, sede, 'doppione_chiuso_pagamento_chiuso', NULL, {fattura_emessa_id})`. Una volta sola per voce; test in `fatture-coda-cron.test.ts`: seconda esecuzione ⇒ nessun evento nuovo; pagamento ancora `pagato` ⇒ nessun evento;
- battito `cron:fatture-coda-pulizia` `ok` con `n_*` (compreso `n_doppioni_chiusi`), anche a zero.

**Job:**
- `'fatture-coda-tick'` a `'2,7,12,17,22,27,32,37,42,47,52,57 * * * *'`;
- `'fatture-coda-pulizia'` a `'49 3 * * *'`, più `PERFORM public.fatture_coda_pulizia();`.

Ognuno sta in un `DO … EXCEPTION`, e un fallimento scrive error `cron-non-programmato` con `operazione='fatture-coda-tick'`, `tipo` = nome del job e `azione` ∈ `schedule|prima-esecuzione`. Nei commenti del file: le SELECT di §12 e il ritorno indietro di C§18.

---

## 7. Moduli TS di D2

### 7.1 `src/lib/fatture-coda/contratto-db.ts` (usabile nel browser, nessun import)

**Mappe e tuple.** Ogni elenco ha una mappa (singolare) e una tupla (plurale), costruite con `mappa<const T extends readonly string[]>(t: T)`:

| Mappa / tupla | Tipo |
|---|---|
| `STATO_VOCE`/`STATI_VOCE` | `StatoVoce` |
| `STATO_INVIO`/`STATI_INVIO` | `StatoInvio` |
| `LAVORO`/`LAVORI` | |
| `MOTIVO_VOCE`/`MOTIVI_VOCE` | |
| `TIPO_DOCUMENTO`/`TIPI_DOCUMENTO` | |
| `ORIGINE_GRUPPO`/`ORIGINI_GRUPPO` | |
| `ORIGINE_ACCODAMENTO`/`ORIGINI_ACCODAMENTO` | |
| `CAUSALE_MODO`/`CAUSALE_MODI` | |
| `INTESTATARIO_ORIGINE`/`INTESTATARIO_ORIGINI` | |
| `RUOLO_STAFF`/`RUOLI_STAFF` | |
| `AZIONE_RICHIESTA`/`AZIONI_RICHIESTE` | |
| `AZIONE_INVIO`/`AZIONI_INVIO` | |
| `ESITO_CHIUSURA`/`ESITI_CHIUSURA` | **`EsitoChiusuraRichiesto`** |
| `ESITO_INVIO_RIPORTATO`/`ESITI_INVIO_RIPORTATI` | i 4 valori di `invio_esito` |
| `ESITO_RICERCA`/`ESITI_RICERCA` | |
| `ESITO_DOPPIONE`/`ESITI_DOPPIONE` | |
| `TIPO_TENTATIVO`/`TIPI_TENTATIVO` | |
| `ESITO_TENTATIVO`/`ESITI_TENTATIVO` | |
| `TITOLARE`/`TITOLARI` | |
| `TIPO_AVVISO`/`TIPI_AVVISO` | |
| `TIPO_ANOMALIA`/`TIPI_ANOMALIA` | |
| **`CONSEGNA_ANOMALIA`/`CONSEGNE_ANOMALIA`** | v4 |
| `AZIONE_EVENTO`/`AZIONI_EVENTO` | |
| `MOTIVO_SVEGLIA`/`MOTIVI_SVEGLIA` | |
| `RIFIUTO`/`CODICI_RIFIUTO` | `CodiceRifiuto` |
| `ESITO_VOCE`/`CODICI_ESITO_VOCE` | 58 valori |
| `ESITO_INVIO`/`CODICI_ESITO_INVIO` | 15 fissi |

**Insiemi e transizioni:** `STATI_VOCE_ATTIVI`, `STATI_VOCE_IN_ATTESA`, `STATI_VOCE_TERMINALI`, `STATI_INVIO_APERTI`; `TRANSIZIONI_VOCE` (9), `TRANSIZIONI_INVIO`.

**Gruppi di codici** di C§13, con `CODICI_SOLO_DA_CONVERSIONE = ['guasto_ripetuto']`. `CODICI_AVVISO_DA_VERIFICARE`, `CODICI_AVVISO_VERIFICA_MANUALE`, `MODO_DA_VERIFICARE`.

**Funzioni:**
- `codiceUpload(http)`: 2xx → `upload_ok`; 429 → `upload_429`; altro 100..599 → `upload_<http>`; altrimenti lancia;
- `codiceScarto(codice)`.

**Costanti** di C§4, v4 comprese: `STATI_SDI_SCARTO = [2,4,9] as const`, `CHIAVI_RIGA_REGISTRO` (15, `as const`), `MAX_RIGA_REGISTRO_BYTES = 32768`. Poi `CODICI_SCHEMA_ASSENTE` e `RPC_CODA` (32 nomi, tipo `NomeRpc`).

**Tipi v4** (forma di C§13):
- `InvioDaRegistrare`, `NumeroBruciatoDaRegistrare`, `RigaRegistroDelGiornale`;
- `FineGruppo`, `DatiAvviso`: unione discriminata per tipo, con `anomalia?: TipoAnomalia` e `fine_gruppo?: FineGruppo` su `errore`, `da_verificare` e `verifica_manuale`;
- `AnomaliaDaConsegnare`, `InvioOltreLimite`, `StatoPagamentoCoda` (con `invii_oltre_limite` **obbligatorio**).

**Tipi di ritorno delle RPC:**
- `EsitoPrendi`, `EsitoPrenota`, `EsitoTentativoChiuso` (con `somma_voce`);
- `LavoroPreso`, `VocePresa`, `InvioPreso` (con `tardiva_autorizzata_il`, `oltre_12_giorni`);
- `EsitoInvioRegistra`, `EsitoNumeroBruciato {invio_id, consegna}`, `EsitoRicercaInvio`;
- `EsitoChiusura` (il **ritorno** di `chiudi`: `{stato, gruppo_id, forzato, codice_finale}`);
- `AvvisoCoda`, `EsitoSegnalaScarto`, `EsitoSegnalaAnomalia {consegna}`;
- `EsitoAccodamento`, `EsitoRimetti`, `EsitoRichiediVerifica`, `EsitoSospendi`, **tutti con `sveglia: boolean`**;
- `EsitoTogli`, `EsitoUrgente`, `EsitoCausale`;
- `RiepilogoCodaDb`, `PosizioneVoce`, `SaluteCoda`, `EsitoOblio`.

### 7.2 `src/lib/fatture-coda/rpc.ts` (solo server; non chiama RPC)

**`leggiEsitoRpc<T>(risposta, nome: NomeRpc)`:**
1. errore con codice in `CODICI_SCHEMA_ASSENTE` → `non_migrata` (warn `coda-non-migrata`, una volta per processo e per nome);
2. altro errore → `guasto` (error `rpc-guasta`);
3. un array → `ok`;
4. `ok:true` → `ok`;
5. `ok:false` con un codice di `CODICI_RIFIUTO` → `rifiuto`;
6. altro → `guasto` (error `coda-rifiuto-inatteso`).

**`schemaCodaAssente(err)`.** I log passano da `logEvento('fattura', …)` con `operazione:'fatture-coda'`.

---

## 8. GDPR — `src/lib/gdpr/esegui.ts` + `__tests__/lib/gdpr-esegui.test.ts` (stesso commit)

**Invariato rispetto alla v3.** Nuova funzione `obliaCodaFatture(supabase, pagIds, op, pagamentiLetti)`, chiamata come passo 3a-ter dopo `:1791`:
- lettura dei pagamenti fallita → nessuna chiamata, `letto:false`;
- `pagIds` vuoto → `letto:true`;
- altrimenti `supabase.rpc('fatture_coda_oblio', { p_pagamento_ids: pagIds })` dentro `try/catch`:
  - `non_migrata` → `letto:true`;
  - `rifiuto`, `guasto` o eccezione → `logErrore` e `letto:false`.

**Poi:**
- `codaFatture.letto` entra in `lettureFallite` (`:2050-2059`); il tipo di ritorno non cambia;
- `makeFake` riceve `rpc` (risposta ok predefinita più registrazione delle chiamate);
- il caso di `:255` verifica la chiamata con `['pag-1']`;
- nessun altro test si rompe (G10).

---

## 9. Log scritti dall'SQL (C§15; nessun esito nuovo nella v4)

| evento · livello | Esiti |
|---|---|
| fattura · info | `accodate`, `sospesa` (`tipo` admin\|sistema), `ripresa`, `tardiva-autorizzata` |
| fattura · warn | `circuito-aperto` (anche da `chiudi aruba_429`), `pausa-esito-incerto`, `numero-non-usato`, `rilascio-con-voci-in-mano`, `cancello-prestito-scaduto`, `rientro-guasto`, `prestito-scaduto`, `esito-incerto`, `esito-tardivo`, `aruba-429-ripetuto`, `ricerca-non-riuscita` |
| fattura · error | `numero-bruciato`, `anomalia` (distinto solo per tipo, scritto quando l'anomalia nasce), `cancello-perso`, `non-tua`, `voce-gia-in-mano`, `invii-incoerenti`, `numero-gia-registrato`, `fattura-non-corrisponde`, `bad-input` (`tipo` = campo), `avviso-abbandonato` |
| cron · error | `url-assente`, `post-fallito`, `tick-esito-http`, `tick-bidello-fallito`, `sveglia-url-assente`, `sveglia-post-fallito`, `cron-non-programmato` |
| cron · warn | `tick-esito-non-letto`, `sveglia-net-assente` |
| cron · info | battito di `fatture-coda-pulizia` |

Campi: chiavi stringa solo fra `tipo, stato, esito, azione, operazione, canale, error_code, anno`; uuid sotto `*_id`; istanti sotto `fino_a`. Mai `motivo`, `origine`, `titolare`.

---

## 10. Test (decisione 27; C§17.1)

### 10.1 Helper `__tests__/helpers/fatture-coda-pglite.ts`

**`creaDbCoda(opz?: {senzaNet?, senzaCron?, senzaConfig?, senzaFile3?, adesso?})`: Promise<DbCoda>**

**Ruoli e stub:**
- ruoli `anon`, `authenticated`, `service_role BYPASSRLS`;
- `auth.users`, `schools`;
- `utenti(id, ruolo, role GENERATED STORED, scuola_id, attivo, archiviato_il)`, `utenti_scuole`;
- `pagamenti`, con le colonne di G3 ed enum `fattura_stato`;
- `fatture_emesse`, con le 23 colonne di G3 e i due indici di G8;
- `app_log`, col suo indice;
- `cron_config(p_nome text)`; schemi `net` e `cron` con le spie.

Carica i tre file **dal disco**.

**Orologio:** di default è quello vero, così il test ponte (C§17.6) resta coerente con `oggiFiscaleISO()`. `adesso` e `impostaAdesso` lo fermano.

**Espone:**
- `db`, per `clientSuPglite` di D6;
- `sql`, `impostaAdesso`, `avanza`, `postInviati`, `rispondiPost`, `cronProgrammati`, `log`, `avvisi`;
- **`avvisiDurante(fn)`**: le righe nate durante `fn`;
- `semina.{sede, utente, pagamento, rigaRegistro}` con id espliciti, così D3 usa gli stessi uuid del suo supabase finto;
- **`xmlDiProva({sezionale, numero, anno, data, importo, progressivo?, tipo?})`**: un XML minimo con i 5 tag, una volta sola ciascuno, oltre 100 B;
- **`preparaVoceInMano({pagamentoId, attore, token?})`**: accoda, prende il cancello, chiama `prossima`; ritorna `{voceId, token, fence}`;
- `chiudi`.

**`verificaVocabolari()`** (in `afterEach`) controlla che stiano nello specchio o nel vocabolario di C§15:
- ogni `esito_codice` di voci e invii;
- ogni `tipo` e `dati.codice` degli avvisi, e **`dati.anomalia`**;
- ogni `consegna` degli eventi `anomalia`;
- ogni coppia (livello, esito) in `app_log`.

### 10.2 I test

Ogni file comincia con un caso di sanità: i 3 file si caricano, 8 tabelle, 32 RPC.

**`fatture-coda-schema.test.ts`** — i casi di C§17.1, più:
- **specchi SQL↔TS:** `_fatture_coda_progressivo` e `_numero_documento` uguali a `progressivoInvioFattura` e `formattaNumeroFattura` sulla griglia `numero ∈ {1, 9, 2154, 999999, 1000000}`, `anno ∈ {2026, 2099}`, due serie. Prova di rottura: `lpad` nudo fallisce a 1000000;
- `_fatture_coda_tag_xml` con un tag ripetuto → NULL;
- `_riga_chk`: `xml_inviato` in più, una chiave in meno o `numero` diverso → `23514`;
- `_xml_chk`: `<ImportoTotaleDocumento>` diverso → `23514`;
- **`anomalia_da_consegnare`:** valida in `in_invio`; fuori da `in_invio` → `23514`; da un valore a un altro → `23514`;
- `_dest_chk` con destinatario e admin insieme → ok;
- ogni coppia di `TRANSIZIONI_*`; controlli di riserva; `tardiva_autorizzata_il` scritta una volta; `consecutivi_429` a 0 alle chiusure dell'invio;
- unione dei 58 codici.

**`fatture-coda-cancello.test.ts`** — C§17.1:
- prenotazione di reinvio a 12 giorni → ok, a 13 → rifiuto, con autorizzazione → ok;
- contatore dei 429 in tutti i rami;
- accesso a 64,9 s / 65,0 s; circuito a +59:59 / +60:00;
- **401 su `signin` due volte nello stesso giorno ⇒ una sola riga `anomalia`**.

**`fatture-coda-lavoratore.test.ts`** — tutti i casi di C§17.1 v4:
- **forma di `p_invio`:** `xmlDiProva` valido → ok. Ognuno di questi → `BAD_INPUT{campo}` atteso:
  - una chiave in più;
  - `riga_registro` con `xml_inviato`;
  - `importo` ≠ `<ImportoTotaleDocumento>`;
  - `<Numero>` con l'anno a 4 cifre per FPR;
  - `<ProgressivoInvio>` diverso;
  - `data_documento` di 2 giorni fa;
  - `<TipoDocumento>TD04`;
- terzo 429 nelle sequenze (1)-(6); 12 giorni; guasti; `RICERCA_MANCANTE`;
- **bidello in 5 rami**, con la prova di rottura senza i rami 2 e 3;
- **un fatto, un avviso** (con `avvisiDurante`):
  - (a) `chiudi('da_verificare','registro_mancante')` e ramo 3 del bidello ⇒ **una** riga `da_verificare` con `a_tutti_gli_admin` e `dati.anomalia='partita_non_registrata'`, nessuna riga `anomalia`;
  - (b) `chiudi('errore','numero_conteso')` ⇒ una riga `errore` non aggregata, con gli admin e `numerazione_anomala` (C0.2 D3); `non_combacia` su `da_ritentare` e su `incerta` ⇒ `bruciata` con `tentativi ≥ 1` accettato dal CHECK; `numero_bruciato(…,'numero_conteso')` ⇒ `BAD_INPUT`; `chiudi('emessa')` con la quota contesa ⇒ `INVII_INCOERENTI`; `togli` di quella voce riesce se tutti i suoi invii sono `rifiutata`/`bruciata`, con uno `registrata` ⇒ `NUMERO_GIA_ASSEGNATO`;
  - (c) conversione c nelle tre uscite ⇒ una riga con `guasti_ripetuti`: l'`errore` non è aggregato e ha gli admin;
  - parcheggio: `numero_bruciato` + `rientro` ⇒ una riga `anomalia`;
  - `numero_bruciato` + `errore` ⇒ una riga `errore` con anomalia e admin;
  - `segnala_anomalia` con la voce in mano, poi morte del lavoratore ⇒ il bidello consegna;
  - seconda anomalia ⇒ solo evento `scartata_seconda`;
  - `INVII_INCOERENTI` ⇒ l'anomalia resta parcheggiata;
  - un errore senza anomalia **non** si aggrega all'avviso con anomalia dello stesso gruppo;
- **fine del gruppo:**
  - gruppo di una voce chiuso `errore` ⇒ una riga `errore` con `dati.fine_gruppo`, nessuna `gruppo_concluso`;
  - chiuso `da_verificare` ⇒ una riga;
  - tutto emesso ⇒ `gruppo_concluso`;
  - avviso già preso ⇒ `gruppo_concluso`;
- **`chiudi(riprova, aruba_429)`:** a circuito chiuso apre il circuito e scrive gli avvisi `pausa_429`; a circuito già aperto non fa nulla (R8);
- savepoint `FC001`; codici solo da conversione → `BAD_INPUT`; `emessa gia_a_registro` con invii tutti `registrata` → ok;
- orologio fermo: due `dav` della stessa voce nello stesso millisecondo ⇒ due righe.

**`fatture-coda-staff.test.ts`** — C§17.1 v4:
- **motivo:**
  - `scartata` senza righe ⇒ `prima_emissione`, livello 3, dietro i gruppi più vecchi;
  - `sdi_stato` 2, 4 o 9 ⇒ `ritrasmissione`, livello 1;
  - riga consegnata ⇒ `prima_emissione`;
- **`PARTITA_NON_REGISTRATA`:**
  - `in_attesa` e 0 righe ⇒ rifiuto;
  - `in_attesa` con una sola riga scartata di un altro file ⇒ rifiuto;
  - `in_attesa` con riga viva del file X e `fattura_aruba_id = Y` non a registro ⇒ rifiuto;
  - riga viva dello stesso file ⇒ passa;
  - lo stesso in `rimetti` senza invii;
- **`stato_pagamenti.invii_oltre_limite`:** vuoto a 12 giorni; pieno a 13 (`giorni=13`) per `numerata`, `da_ritentare` e `incerta`; vuoto con autorizzazione e per `caricata`;
- **`segnala_scarto_sdi`:**
  - i 4 valori;
  - (d) `non_identico` ⇒ una riga `da_verificare` con `dati.anomalia`, nessuna riga `anomalia`; senza voce, `destinatario_id` NULL;
  - `p_codice_sdi='0404'` ⇒ `BAD_INPUT`;
  - voce non `emessa` ⇒ `esito_codice` invariato;
- **`sveglia`** nei ritorni di `accoda`, `rimetti`, `richiedi_verifica` e `riprendi`;
- `posizioni(NULL)`;
- il resto come nella v3.

**`fatture-coda-cron.test.ts`**: invariato (sveglia (0) con prova di rottura, (a), (b), 10 s / 60 s, fermi, `senzaNet`, `senzaFile3`, tick, pulizia, schedule).

**`__tests__/lib/fatture-coda-rpc.test.ts`** e **`__tests__/lib/gdpr-oblio-coda-fatture.test.ts`**: come nella v3.

**Limite dichiarato:** una sola connessione, quindi `SKIP LOCKED`, le corse e l'ordine dei lock (§5.9) non si provano: li garantisce solo la revisione.

---

## 11. Lock `__tests__/architecture/fatture-coda-contratto-specchio.test.ts`

1. **Specchio SQL↔TS:** gli `IN (...)` dei CHECK nominati del file 1 e le liste di validazione del file 2 contro le tuple, come insiemi e nei due versi, con un controllo positivo. Nessun `azione_forzata`.
2. **Costanti:**
   - le 12 funzioni IMMUTABLE;
   - `_fatture_coda_stati_scarto_sdi()` = `STATI_SDI_SCARTO` = `[c ∈ 0..20 | mapStatoAruba(c).isScarto]`, importando `@/lib/aruba/stato` (G11);
   - `_fatture_coda_chiavi_riga_registro()` = `CHIAVI_RIGA_REGISTRO`, anche nell'ordine;
   - i letterali di C§4 nei punti fissati.
3. **RPC:** 32 nomi con `CREATE OR REPLACE FUNCTION`, `REVOKE` e `GRANT`; nessun'altra funzione con GRANT; ogni `.rpc('fatture_coda_…'|'aruba_cancello_…'` letterale in `src/**` e `scripts/**` sta in `RPC_CODA`.
4. **Job e percorso nel file 3;** `const JOB = 'fatture-coda-tick'`.
5. **Regole di scrittura:**
   - parole-guardia nei file 2 e 3, sia nel testo grezzo sia dopo `senzaCommenti`;
   - niente PG18; orologio unico; log con tre argomenti letterali;
   - `_fatture_coda_invio_oltre_limite(` con due argomenti e nessun altro confronto a 12;
   - **nessun `lpad(` su `numero` fuori da `_fatture_coda_progressivo`**;
   - **ogni `'codice'`/`'anomalia'` letterale in `jsonb_build_object` del file 2 sta in `CODICI_ESITO_VOCE`/`TIPI_ANOMALIA`**.
6. **Uguaglianze fra moduli** (v4): `MOTIVO_PARTITA_NON_REGISTRATA` (D1, `@/lib/pagamenti/fattura-partita-non-registrata`) `=== ESITO_VOCE.partita_non_registrata === RIFIUTO.PARTITA_NON_REGISTRATA.toLowerCase()`.
7. **Nessun letterale duplicato** (C§17.5):
   - token stringa (`'…'`, `"…"`, `` `…` `` senza `${}`, tipi letterali compresi) uguali a un valore di `STATI_VOCE`, `STATI_INVIO`, `ESITI_RICERCA`, `ESITI_DOPPIONE`, `TIPI_ANOMALIA` o `CODICI_*`;
   - le chiavi d'oggetto non quotate non sono token;
   - ambito: `src/lib/fatture-coda/**` tranne `contratto-db.ts`, `src/app/api/pagamenti/fattura/coda/**`, `sync/route.ts`.
   - **Eccezioni `{file, letterale, ragione, conteggio}` contate esatte**, con «eccezione morta» e controllo positivo. All'inizio: `vocabolario-log.ts` con `'sospesa'` ed `'assente'` (esiti di log, non valori del DB), `api-contratto.ts` con `'sospesa'` e `'in_pausa'` (`PARTENZE`).
   - **Niente** eccezione per `sync/route.ts 'errore'`, che D3 toglie, e per `TIPI_00404_NON_RISOLTO`, che D6 costruisce da `ESITO_RICERCA`. Chi aggiunge un letterale aggiunge l'eccezione nello stesso commit (C§0.2). L'elenco si chiude a fine Fase 2.
8. **Prove di rottura:**
   - togliere uno stato;
   - `SELECT 12` → `SELECT 13`;
   - `ARRAY[2,4,9]` → `ARRAY[2,4]`;
   - una chiave in meno in `_chiavi_riga_registro`;
   - un GRANT mancante;
   - `unique` in un commento del file 2;
   - `RETURNING OLD`;
   - un secondo «> 12» nel file 2.

---

## 12. Parte DB del rilascio (la procedura è C§18)

**Prima del merge della PR-A** (solo SELECT):
- partite non registrate con `_fatture_coda_partita_non_registrata` scritta in SQL = 0 (oggi 6, G15);
- «Trasporto fallito» = 0;
- nessuna emissione negli ultimi 10';
- version assenti;
- `db push --dry-run` elenca solo i 3 file.

**Dopo il merge** (entro 10'):
- 3 version in `schema_migrations`;
- 8 tabelle con RLS FORCE e 0 policy;
- privilegi sulle 32 RPC;
- 2 job pg_cron;
- battito della pulizia `ok`;
- primo tick con risposta 202;
- `ultimo_giro_il` e `ultimo_tick_il` aggiornati.

**In diretta** (aggregati):
- voci e invii per stato;
- tentativi per tipo ed esito; picco su 60' ≤ 50;
- avvisi non inviati;
- `caricata` da più di 10'; numeri doppi;
- invii con `consecutivi_429 > 0`; invii con `tardiva_autorizzata_il`;
- in più (v4):
  - voci `ritrasmissione`: attese solo per pagamenti con una riga di scarto, oggi 7;
  - invii `bruciata`: atteso 0;
  - voci con `anomalia_da_consegnare` non nulla e `presa_il` più vecchia di 10': atteso 0;
  - avvisi per voce nello stesso istante: `select count(*) from (select voce_id, date_trunc('second', creato_il) from fatture_coda_avvisi where voce_id is not null group by 1,2 having count(*) > 1) x`, atteso 0.

**STOP d'urgenza:** `select public.fatture_coda_sospendi(NULL, 'arresto d''urgenza durante il rilascio')`, mostrata prima di eseguirla.

---

## 13. Decisioni → dove

| Decisione | Dove |
|---|---|
| 0 | tick §6, sveglia §5.11 |
| 2, 3 | §5.2; motivo S51 in §5.7 |
| 5 | `p_limite_ora ≤ 60` |
| 6 | `_sede_propria` |
| 10, 11 | `rimetti`, `togli`, S29 |
| 12 | sospendi/riprendi |
| 13 | §5.11, `rilascia` |
| 14 | `_oggi_fiscale` |
| 15 | `_invio_oltre_limite`, ricerca, `invii_oltre_limite` |
| 16 | contatore §5.4, conversione a, circuito da `chiudi` (R8) |
| 17 | conversione c, bidello a 5 rami |
| 19 | `_minimo_chk` |
| 20 | §5.3.1, §5.6, §5.10 |
| 22 | pulizia |
| 23 | `in_attesa_dal`, `salute` |
| 25, 26 | §3, §12 |
| 27 | §10 |
| 29 | `segnala_scarto_sdi` |

---

## 14. Limiti dichiarati

- PGlite ha una connessione sola; l'ordine dei lock si garantisce solo con la revisione.
- **Sveglia persa** mentre la sync tiene il cancello: si aspetta il tick, ≤ 5' (R4).
- La quota oraria non vede le fatture scritte a mano sul pannello (margine 50/60).
- Un candidato illeggibile per sempre lascia la voce «Da verificare».
- Dopo un `da_verificare aruba_429_ripetuto` il contatore resta a 3 fino a `richiedi_verifica`: la verifica automatica ha una sola occasione.
- **Admin che ha accodato**, gruppo concluso nella stessa chiusura di una voce `emessa`, `riprova` o `rientro` che consegna un'anomalia parcheggiata: riceve l'avviso `anomalia` (come admin) **e** `gruppo_concluso` (come accodante). S45 attacca `fine_gruppo` solo a `errore`, `da_verificare` e `verifica_manuale` (R11).
- **`ritrasmissione`** segue alla lettera S51: un pagamento con una vecchia riga di scarto e una riga viva successiva, se qualcuno lo accoda, entra a livello 1 e chiude `gia_a_registro`. Il pre-controllo di D4 lo segna `gia_fatturata`, quindi il caso è raro.


## File toccati

| Percorso | Azione | Motivo |
|---|---|---|
| `supabase/migrations/<T1>_fatture_coda_schema.sql` | crea | Contiene gli helper di base: orologio unico, giorno di Roma, dati_sicuri con stringhe fino a 128 caratteri, 12 costanti IMMUTABLE, _stati_scarto_sdi() e _chiavi_riga_registro(). Aggiunge gli specchi del documento (_progressivo senza troncare, _numero_documento, _tag_xml, _xml_difetto, _riga_difetto, _anomalia_valida) e _invio_oltre_limite, la regola unica dei 12 giorni. Crea le 8 tabelle coi CHECK nominati: voci con anomalia_da_consegnare; invii con _progressivo_chk, _xml_chk e _riga_chk senza sottoquery; avvisi con _dest_chk della v4 e l'indice degli avvisi in attesa per gruppo. Poi i trigger d'invarianza (anomalia parcheggiata solo in in_invio e mai sovrascritta, contatore dei 429, tardiva scritta una volta, controlli di riserva sugli invii), RLS FORCE senza policy e SELECT a service_role. È l'unico file che accende le tre guardie di freschezza |
| `supabase/migrations/<T1+60s>_fatture_coda_rpc.sql` | crea | Helper interni: log, avvisi, _chiave_monotona, _avviso_errore (aggrega solo senza anomalia e mai su avvisi degli admin), _partita_non_registrata (unione delle forme di D1 e D4, 6 in produzione), _trasporto_in_sospeso, _apri_circuito, _in_ordine. Poi _chiudi_voce con la consegna dell'anomalia prima dell'UPDATE di stato, lo stato bloccato prima delle voci e il savepoint FC001. Le 30 RPC con GRANT: invio_registra v4 (10 chiavi, controlli su XML e riga_registro); numero_bruciato e segnala_anomalia che parcheggiano; chiudi con aruba_429 che apre il circuito; bidello a 5 rami che prende il cancello per primo; segnala_scarto_sdi con un solo avviso; accoda con motivo S51; stato_pagamenti con invii_oltre_limite; sveglia nei ritorni. In più il trigger d'effetto con fine_gruppo (S45) e la sveglia con la farfalla COALESCE. Nessuna parola-guardia |
| `supabase/migrations/<T1+120s>_fatture_coda_cron.sql` | crea | _fatture_coda_url_giro, fatture_coda_tick_http, fatture_coda_pulizia col battito cron:fatture-coda-pulizia, schedule dei job ai minuti 2,7,…,57 e alle 03:49 più la prima esecuzione della pulizia, cron-non-programmato, NOTIFY pgrst |
| `src/lib/fatture-coda/contratto-db.ts` | crea | Specchio TS usabile nel browser: mappa + tupla per ogni elenco (con CONSEGNE_ANOMALIA ed ESITI_CHIUSURA di tipo EsitoChiusuraRichiesto), insiemi, transizioni, gruppi di codici (58 in CODICI_ESITO_VOCE), codiceUpload/codiceScarto. Costanti v4: STATI_SDI_SCARTO, CHIAVI_RIGA_REGISTRO, MAX_RIGA_REGISTRO_BYTES. RPC_CODA (32). Tipi v4: InvioDaRegistrare, NumeroBruciatoDaRegistrare, RigaRegistroDelGiornale, DatiAvviso con anomalia e fine_gruppo, FineGruppo, AnomaliaDaConsegnare, InvioOltreLimite, StatoPagamentoCoda. Ritorni delle RPC, con sveglia in EsitoAccodamento, EsitoRimetti, EsitoRichiediVerifica ed EsitoSospendi |
| `src/lib/fatture-coda/rpc.ts` | crea | leggiEsitoRpc (ok, array, rifiuto, non_migrata, guasto) e schemaCodaAssente; warn coda-non-migrata una volta per nome, rpc-guasta, coda-rifiuto-inatteso; non chiama RPC |
| `src/lib/gdpr/esegui.ts` | modifica | Passo 3a-ter di anonimizzaAlunno dopo :1791: obliaCodaFatture chiama fatture_coda_oblio coi pagIds (:1748). Non chiama se la lettura dei pagamenti è fallita e degrada su schema assente; il fallimento entra in lettureFallite (:2050-2059). Tipo di ritorno invariato |
| `__tests__/lib/gdpr-esegui.test.ts` | modifica | makeFake riceve rpc (risposta ok predefinita più registrazione delle chiamate); il caso di :255 verifica la chiamata a fatture_coda_oblio con ['pag-1']; stesso commit di esegui.ts |
| `__tests__/helpers/fatture-coda-pglite.ts` | crea | creaDbCoda() su PGlite: stub con le colonne reali di pagamenti e fatture_emesse (G3) e i due indici di G8, i tre file dal disco, orologio vero di default e fermabile. Espone avvisiDurante, semina con id espliciti, xmlDiProva, preparaVoceInMano e verificaVocabolari (anche dati.anomalia e consegna). Lo usano anche il test ponte di D3 e il cardine di D6 |
| `__tests__/db/fatture-coda-schema.test.ts` | crea | RLS e privilegi, transizioni, specchi SQL↔TS di progressivo e numero (anche a 1000000, con prova di rottura su lpad), _tag_xml, CHECK di riga_registro e XML, anomalia_da_consegnare (fuori da in_invio e sovrascrittura vietate), _dest_chk v4, tardiva, contatori, 58 codici |
| `__tests__/db/fatture-coda-cancello.test.ts` | crea | prendi, prenota (65 s, quota, ritmo, reinvio a 12/13 giorni), esito col contatore dei 429, circuito ±1 s, rilascia, 401 su signin con un solo avviso anomalia al giorno |
| `__tests__/db/fatture-coda-lavoratore.test.ts` | crea | Ordine; forma di p_invio in 7 rifiuti con campo; terzo 429; 12 giorni; guasti; bidello in 5 rami con prova di rottura. Un fatto un avviso nei casi (a)-(c), nel parcheggio (anche consegnato dal bidello) e nella seconda anomalia scartata; errore senza anomalia non aggregato a quello con gli admin. Fine del gruppo in 4 casi. chiudi aruba_429 che apre il circuito; savepoint FC001; codici solo da conversione; gia_a_registro con invii registrati; chiavi monotone a orologio fermo |
| `__tests__/db/fatture-coda-staff.test.ts` | crea | accoda (motivo S51 in 3 casi; PARTITA_NON_REGISTRATA in 4 casi, anche in rimetti; sveglia), togli, rimetti e richiedi_verifica con la forza, urgente, causale, sospendi e riprendi. stato_pagamenti.invii_oltre_limite a 12/13 giorni per stato; segnala_scarto_sdi nei 4 valori col caso (d), p_codice_sdi e voce non emessa; posizioni(NULL); salute, oblio |
| `__tests__/db/fatture-coda-cron.test.ts` | crea | Sveglia dalla riga iniziale con prova di rottura, casi (a)/(b)/farfalla/fermi, net assente, file 3 assente (42883), tick senza URL e senza client, esito HTTP precedente, pulizia e battito, schedule idempotente, cron-non-programmato |
| `__tests__/architecture/fatture-coda-contratto-specchio.test.ts` | crea | Lock specchio: CHECK e validazioni contro contratto-db; costanti, compresi STATI_SDI_SCARTO contro mapStatoAruba (0..20) e CHIAVI_RIGA_REGISTRO; 32 RPC con REVOKE/GRANT; .rpc letterali dentro RPC_CODA; job e percorso nel file 3; parole-guardia; niente PG18; lpad solo nel progressivo; codici e anomalie letterali degli avvisi nelle liste. Poi l'uguaglianza MOTIVO_PARTITA_NON_REGISTRATA con ESITO_VOCE e i letterali duplicati con eccezioni contate (nessuna per sync 'errore' e TIPI_00404_NON_RISOLTO) |
| `__tests__/lib/fatture-coda-rpc.test.ts` | crea | leggiEsitoRpc nei 6 rami e con ogni codice di CODICI_SCHEMA_ASSENTE; warn coda-non-migrata una volta per nome |
| `__tests__/lib/gdpr-oblio-coda-fatture.test.ts` | crea | anonimizzaAlunno chiama fatture_coda_oblio coi pagIds. Non chiama senza pagamenti o se la lettura dei pagamenti fallisce (lettureFallite+1). PGRST202 senza errore; altro errore o rpc che lancia → logErrore e lettureFallite+1; prova di rottura |

## Rischi

- PGlite è PostgreSQL 18.3, la produzione è 17.6 (G5). Un costrutto solo PG18 passerebbe i test e fallirebbe all'applicazione, e il dry-run non esegue nulla. Mitigazione: STORED sempre scritto e divieto nel lock specchio; restano possibili differenze di comportamento che la sintassi non mostra.
- PGlite ha una connessione sola: SKIP LOCKED, le corse, la ripetizione di _avviso_errore e soprattutto l'ordine dei lock di §5.9 non si provano. Ho corretto due cicli rispetto alla v3: bidello con richiedi_verifica, e rimetti con una chiusura in pausa dello stesso gruppo. Li garantisce solo la revisione. In produzione un ciclo diventa un 40P01 su una RPC, che il lavoratore tratta come guasto nostro.
- Un BAD_INPUT di invio_registra arriva dopo che il numero è stato preso, e ogni rifiuto brucia un numero (fino a 4 prima di guasto_ripetuto). Mitigazioni: le stesse espressioni SQL danno 425 su 425 sulle righe reali (G14); lo specchio SQL↔TS di progressivo e numero è provato in PGlite; il test ponte di D3 (C§17.6) è un gate prima della PR-A.
- Le regex sull'XML stanno anche nel CHECK di fatture_coda_invii e si rivalutano a ogni UPDATE della riga: il costo è trascurabile con XML da 3,5 KB (G14). Un XML futuro con un secondo tag <Numero> o <Data> (per esempio DatiOrdineAcquisto) renderebbe l'invio illeggibile per _tag_xml: il test ponte lo scoprirebbe prima del rilascio, ma un cambio di fatturapa-xml.ts deve rilanciarlo.
- (C0 G1, C0.5 n. 7) Rischio chiuso: D1, D2 e D4 usano lo stesso predicato CASE di C0.3, con parità TS/SQL provata su PGlite; il caso «quota B partita ma non registrata, quota A viva» dà lo stesso esito nel pre-controllo e nell'accodamento.
- Dopo un da_verificare aruba_429_ripetuto il contatore resta a 3 finché nessuno chiama richiedi_verifica. La verifica automatica ha una sola occasione: la prima chiusura non concludente la converte in resta concludente.
- R4 non accolta: un accodamento fatto poco prima che la sync prenda il cancello, se il giro trova OCCUPATO, aspetta il tick successivo (fino a 5'). È coerente con C§9.1, ma lascia un buco nella decisione 13.
- R11 non accolta: un admin che ha accodato può ricevere due notifiche (anomalia e gruppo_concluso) quando il gruppo si conclude nella stessa chiusura che consegna un'anomalia parcheggiata senza avviso della voce.
- R8 implementata prima di una decisione del contratto: chiudi(riprova,'aruba_429') a circuito chiuso apre il circuito e scrive gli avvisi pausa_429. Se il contratto la respinge, va tolta, e con lei il suo caso di test; nessuna interfaccia cambia.
- Letterali duplicati: le eccezioni contate (vocabolario-log.ts 'sospesa'/'assente', api-contratto.ts 'sospesa'/'in_pausa') dipendono dal testo finale dei file di D4 e D6. Fino alla chiusura dell'elenco a fine Fase 2 il lock può essere rosso; chi aggiunge un letterale lo dichiara nello stesso commit.
- Una voce in errore con un invio numerata o rifiutato (numero assegnato, S29) non si toglie, non va in oblio e il suo pagamento non si cancella (55006). Se il pagamento non è più saldato, resta in errore con intestatario e causale manuale conservati: è la decisione 11 alla lettera, ma è un residuo dal punto di vista GDPR. Stessa cosa per riga_registro e xml degli invii aperti, che contengono nome e CF dell'intestatario fino allo stato terminale.
- Le route esistenti che cancellano un pagamento non conoscono il 55006: su un pagamento in fatturazione o con un numero assegnato rispondono con un errore generico.
- (C0.2 D3, C0.5 n. 1) «Rimanda» su un numero conteso non esiste più: `non_combacia` porta l'invio a `bruciata numero_conteso` e la voce a `errore`. Il rovescio: un `non_combacia` sbagliato (confronto che fallisce su un documento nostro) brucia un numero valido; lo mitigano i 5 campi del confronto (C§11) e l'anomalia `numerazione_anomala` agli admin.
- Nella prima ora il conteggio orario include le righe di fatture_emesse non collegate a un invio, comprese le orfane registrate da D1 poco prima del rilascio: la coda è più prudente del necessario, ma non supera mai 50/ora.
- Le version dei file (T1) dipendono dall'ora del merge di PR-D1b. Se una fotografia si rigenera dopo la scrittura dei file, migrazioni-complete li boccia: vanno rinominati prima del merge, mai con un istante futuro.
- Il file 3 contiene _fatture_coda_url_giro, che la sveglia del file 2 chiama. Nei pochi secondi fra l'applicazione dei due file, una sveglia registrerebbe sveglia-url-assente (42883) e l'accodamento riuscirebbe comunque. In produzione i tre file si applicano nello stesso push.
- La pulizia eseguita all'applicazione del file 3 scrive un battito prima che JOB_CRON lo sorvegli (PR-B): è innocuo. Un suo fallimento si registra come cron-non-programmato con operazione fatture-coda-tick e tipo fatture-coda-pulizia, coppia già presente in C§15.
