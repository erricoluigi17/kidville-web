
# D4: accodamento e API per l'interfaccia (giro 6, allineato al CONTRATTO v4)

Legenda: **[V]** = verificato nel repo in sola lettura il 23/09. **[D]** = scelta di progetto o deduzione.
Questo testo sostituisce il giro 5. **Il contratto v4 prevale.** Stati, RPC, codici, route, log, notifiche e proprietà dei file sono quelli del contratto. Qui c'è solo ciò che resta interno a D4, col rimando alla sezione del contratto per il resto.

---

## Correzioni C0 (23/09/2026) — prevalgono sul resto del documento

Fonte: contratto, sezione «Registro C0» (C0.1 rilievi, C0.2 default del titolare, C0.3 predicato, C0.4 richieste). Per questo componente:
- **Predicato unico (C0 G1)**: il pre-controllo usa il modulo di D1 col testo di contratto C0.3.
- **Rimetti con proposta del bonifico (C0 m2)**: in `rimetti` il pre-controllo riceve come scelta `intestatario_scelto`/`intestatario_origine` della voce: `proposta_bonifico` uguale alla proposta ricalcolata ⇒ confermato; diversa ⇒ resta `errore` con `proposta_da_confermare`. `zCorpoRimetti` non cambia. Test in `fattura-coda-azioni.test.ts`.
- **Nomi (C0 m6)**: `CAUSALE_MODI` (non `MODI_CAUSALE`), `AZIONI_RICHIESTE` (non `AZIONI_VERIFICA`); `TIPI_DOCUMENTO_SUPPORTATI` viene da `contratto-db.ts` di D2.
- **HTTP (C0.4)**: `CodiceRispostaCoda = CodiceErroreCoda | 'SEDE_NON_ACCESSIBILE'`; la GET con `voce=`/`pagamento=` va oltre 7 giorni entro 24 mesi; `doppioni_aperti` sono id di voci. `fattureDaRighe`, la testata di `fattura-viva.ts` e `annullo-riapre-movimento.test.ts` sono di D4.
- **Default (C0.2)**: `azioni.togli` vero anche su `errore` con invii tutti `rifiutata`/`bruciata` (D1); con `numero_conteso` `azioni.rimanda` falso e `azioni.rimetti` vero (D3).
- **Seconda passata (contratto C0.5 n. 3)**: `azioniAmmesse` legge il default D1 **solo** dal campo additivo `solo_invii_non_consegnati` di `fatture_coda_stato_pagamenti` (nessun ripiego in TS, come `invii_oltre_limite`); `togli` = `in_coda`/`errore` senza invii, oppure `errore` con `solo_invii_non_consegnati=true`. Test in `stato-coda.test.ts`: vero con soli `rifiutata`/`bruciata`, falso con uno `registrata`, con la prova di rottura sul campo.

## 0. Cosa cambia rispetto al giro 5

| Rilievo o novità v4 | Correzione | Dove |
|---|---|---|
| **Critico 1 (grave)**: le forme di `VoceInElenco` divergevano da D5 | Adotto la forma unica di C§12/S47 **alla lettera**: `verifica{dovuta_il, auto_esito, azione_richiesta, azione_richiesta_il, azione_richiesta_da}`; `invii_aperti: InvioAperto[]` e `fatture: FatturaDellaVoce[]` (non più un oggetto singolo); `numero` intero più `numero_leggibile` da `numeroLeggibile`; `fatture[].scartata = !fatturaViva(riga)` e `fatture[].data_documento` calcolati dal server; `azioni.ritrasmetti` esteso alle emesse con fattura scartata. Tipi esportati da `api-contratto.ts`: `VoceInElenco`, `InvioAperto`, `FatturaDellaVoce`, `AzioniVoce`, `VerificaVoce` | §4, §5.3, §9 |
| **Critico 2 (grave)**: 12 giorni senza fonte per le letture | Tolti la RPC nuova (vecchia richiesta 2) e il ripiego su `esito_codice`. La GET chiama `fatture_coda_stato_pagamenti` sui pagamenti della pagina; `oltre_12_giorni`, `rimetti_serve_forza` e `rimanda_serve_forza` vengono **solo** da `invii_oltre_limite` (S48). Se la lettura fallisce → 500 `LETTURA_FALLITA`, niente valori inventati | §5.3, §9 |
| Critico 3 (minore): predicato `PARTITA_NON_REGISTRATA` | Il pre-controllo usa `fatturaPartitaNonRegistrata` di D1, che è la stessa forma su cui si allinea l'SQL (C§9.4). L'ultima parola resta alla RPC: il suo rifiuto per riga diventa il motivo `partita_non_registrata` | §5.1, §6 |
| Critico 4 (minore): firme aperte | `leggiAccessoAruba`: **adotto il tipo di D3** così com'è (la vecchia richiesta 8 è ritirata). `sveglia` nei ritorni: resta una richiesta (r3). La proprietà di `annullo-riapre-movimento.test.ts` la prendo con la regola «chi rompe ripara» (C§0.2, C§19) e la aggiungo a §19 nel commit dello spostamento | §5.1, §5.5 |
| Critico 5 (minore): `CodiceRispostaCoda` e `voce=` oltre i 7 giorni | La v4 non li ha scritti. **Non devio**: `MAPPA_RIFIUTO_HTTP` resta `Record<CodiceRifiuto, {http; codice: CodiceErroreCoda}>` come nel contratto. `FUORI_SEDE` e `SEDE_ASSENTE` vanno quindi a 403 `CODA_ATTORE_NON_AUTORIZZATO` più l'error `coda-rifiuto-inatteso` (sono comunque incoerenze: il perimetro l'ha già filtrato la route). Se la richiesta r1 passa, i due si spostano su `SEDE_NON_ACCESSIBILE`. La regola `voce=`/`pagamento=` è interna a D4 (`GIORNI_STORICO_CODA` è mio) e la tengo; ne chiedo la scrittura in C§12 perché D5 ci costruisce i link (r2) | §5.4, §9 |
| v4 S51: `motivo` e `tipo_invio` | `tipo_invio` del pre-controllo vale `ritrasmissione` solo se il pagamento ha una riga `fatture_emesse` con `sdi_stato ∈ STATI_SDI_SCARTO`. Non basta più il tono `scartata` | §5.1 |
| v4 `numeroLeggibile` | Si sposta **invariata** in `fatture-dei-pagamenti.ts`. È l'unica fonte di `numero_leggibile` per `invii_aperti` e `fatture` (F40). [V] `route.ts:981-990`. Non si unisce a `etichettaFattura`: lo vieta la testata di `fattura-viva.ts:95-106` | §5.5 |

---

## 1. Fatti che decidono le scelte interne

- [V] Nella riconciliazione (`route.ts`, 2150 righe):
  - import di `fatturaViva` a `:39`; `FATTURE_SELECT` a `:939` (`pagamento_id, numero, anno, sezionale, sdi_stato, quota_adult_id`); `RigaFatturaMovimento` a `:941`;
  - `numeroLeggibile` a `:981`; la funzione pura `fattureDeiPagamenti(righe)` a `:1009`, che usa `fatturaViva` a `:1021`;
  - `perFatturazione` a `:880` (copia 5 campi); `sediAttive` si risolve tardi, a `:1379`;
  - nello stesso file c'è il `POST` (test `-auto` e `-upload`).
- [V] Il lock `annullo-riapre-movimento` elenca `riconciliazione/route.ts` fra i CONSUMATORI (`:259`) e pretende che importi `@/lib/pagamenti/fattura-viva` (`:652-653`). Dopo lo spostamento l'unico uso finisce in `fatture-dei-pagamenti.ts`.
- [V] `fatturaViva(r: Pick<RigaFatturaEmessa,'sdi_stato'>)` (`fattura-viva.ts:83`): è la definizione di `fatture[].scartata`.
- [V] Il lock `fatturazione-riconciliazione-un-motore-solo` vieta `fattura_stato ===` nella rotta di riconciliazione (`:216`). Il confronto su `fattura_stato` di `ritrasmetti` sta quindi in `stato-coda.ts`, in `src/lib`, fuori dalla rotta.
- [V] Il lock `errori-con-codice` segna «opaco» un `codice` non letterale (`:568-588`). La sua lista di esenzioni «può solo rimpicciolirsi» (`:310-315`).
- [V] `esitoFatturazione` sta a `fatturazione-riga.ts:152-171`; `TONI_FATTA`/`TONI_DA_FARE` a `:182-183`; `daFatturareInListaDiLavoro` a `:250`.
- [V] `max_rows = 1000` (`supabase/config.toml:18`). `maxDuration` è una route segment config valida in Next 16 (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md`).
- [V] Produzione 23/09, solo aggregati:
  - 280 pagamenti `pagato` da fatturare, di cui 2 con bonifico confermato e 153 senza `periodo_competenza`;
  - 11 pagamenti `scartata`: 7 con una riga di scarto, 4 senza righe (F34).

---

## 2. Confini

**Consegna** (C§19): le route `coda/*` tranne `giro`; `api-contratto.ts`, `precontrollo.ts`, `situazione.ts`, `periodo.ts`, `stato-coda.ts`, `risposte-api.ts`; `fatture-dei-pagamenti.ts`, `fatturazione-riga.ts`, `lotto-fatture.ts`, `scope.ts`; `riconciliazione/route.ts` con i suoi 5 test GET (F33); i due 410; `esito-fetch.ts` e `shared.json` (PR-A); i lock marcati D4. Con «chi rompe ripara» anche `annullo-riapre-movimento.test.ts` e i due test POST della riconciliazione, se lo spostamento li tocca.

**Non consegna:** SQL, `contratto-db.ts` e `rpc.ts` (D2); stima, ritmo, lavoratore e `accesso.ts` (D3); notifiche e UI (D5); vocabolario dei log, salute ed E2E (D6).

**Isolamento.**
- Ogni RPC si scrive letterale nel `route.ts`.
- Le RPC di scrittura portano `p_attore: auth.user.id` e `p_scuola_ids` (tranne `sospendi`/`riprendi`). Quelle di lettura (`riepilogo`, `posizioni`, `stato_pagamenti`) portano `p_scuola_ids`.
- Ogni `.from()` su una tabella con sede porta `.in('scuola_id', …)`.
- I nomi si leggono solo per embed con indicazione di colonna (`autore:utenti!creato_da(nome, cognome)`), mai con `.from('utenti')`.

---

## 3. Route: scelte interne

Forma, gate e risposte: **C§12**.

**`maxDuration`:**
- `POST coda` e `rimetti`: `300`;
- `precontrollo` e `periodo`: `60`;
- le altre: default.

**Perimetro:**
- `perimetroCoda` = `sediReali().reali ∪ scuoleDiUtente`: GET `coda`, `togli`, `urgente`, `verifica`, `rimetti`, `POST causale`;
- sedi proprie: `POST coda`, `precontrollo`, `periodo`, `situazione`, `GET causale`;
- nessun perimetro: `sospensione`, con `requireStaff(request, ['admin'])`.

**Ordine in ogni handler:**
1. `withRoute('pagamenti/fattura/coda[/x]:METODO')`;
2. `const auth = await requireStaff(request)`;
3. `parseBody`/`parseQuery` con lo schema di `api-contratto.ts`;
4. `createAdminClient()`;
5. perimetro o gate;
6. RPC letterale;
7. `leggiEsitoRpc` → `rispostaDaRifiuto` o `rispostaCoda`.

Il ruolo si legge da `auth.user.role` (F22). Nessuna route chiama Aruba né usa `after()`.

---

## 4. `api-contratto.ts` (usabile nel browser)

Nomi e contenuti: C§12 e C§13 (moduli_ts).

**Import ammessi:** `zod`, `@/lib/validation/common`, `@/lib/fatturazione/intestatario-scelto`, i tipi puri di `proposta-intestatario`, `type TonoFatturazione` e `./contratto-db`.

**Nessun letterale vietato dal lock D2.**
- I 4 motivi di `MOTIVI_NON_PRONTA` che coincidono con un codice (`pagamento_inesistente`, `non_saldato`, `partita_non_registrata`, `trasporto_in_sospeso`) si prendono da `ESITO_VOCE.<x>`.
- Gli enum zod si costruiscono sulle tuple (`STATI_VOCE`, `TIPI_DOCUMENTO`, `AZIONI_VERIFICA`, `ORIGINI_ACCODAMENTO`…).
- Le chiavi di `azione_richiesta` e `auto_esito` si tipizzano con le tuple di `contratto-db`.

**Tetti.**
- Da `contratto-db`: `TETTO_VOCI_PER_GESTO`, `MAX_CAUSALE_MANUALE`, `MAX_MOTIVO_SOSPENSIONE`.
- Propri: `TETTO_PRECONTROLLO_BLOCCO=50`, `TETTO_SITUAZIONE=500`, `MAX_GIORNI_PERIODO=366`, `GIORNI_STORICO_CODA=7`, `PER_PAGINA_MAX=200`.
- `VISTE_CODA = attive | inviate | tolte | doppioni_sdi`.

**Corpi.** Tutti `z.strictObject`, con `superRefine` su:
- id duplicati;
- `conferme_proposte` senza doppioni e solo su `pagamento_ids`;
- `periodo` presente se e solo se `origine:'periodo'`;
- `ricorda_scheda` solo con una persona;
- `intestatario` nel pre-controllo solo con `origine:'singolo'` e una voce;
- `forza` solo con `rimanda`.

La causale del singolo è `z.string().trim().min(1).max(MAX_CAUSALE_MANUALE).nullable().optional()`. In `zQueryPeriodo` le date si leggono come stringhe: la coerenza la controlla la route, così l'errore è `CODA_PERIODO_NON_VALIDO` e non il 400 generico.

**Tipi della v4.** Esattamente quelli di C§12 e moduli_ts: `VoceInElenco`, `VerificaVoce`, `InvioAperto`, `FatturaDellaVoce`, `AzioniVoce`. Mai intestatario né CF.
- `RispostaAzioneMultipla = {fatte: string[]; rifiutate: {voce_id; codice: CodiceErroreCoda; data_documento?; giorni?}[]}`.
- `CHIAVI_MESSAGGIO_CODA: Record<CodiceErroreCoda, string>`, con i 15 codici di C§12.

---

## 5. Moduli server

### 5.1 `precontrollo.ts`

Firme: C§13. `VerdettoInterno` estende `VerdettoPrecontrollo` con `intestatario` e `intestatario_origine`, che vanno solo alla RPC.

**Fase economica.** Tre letture a blocchi di 100, sempre `.in('scuola_id', sedi)`:
1. `pagamenti`: `SELECT_PAGAMENTO_CAUSALE` più `stato, fattura_stato, data_incasso, periodo_competenza, categoria_id, scuola_id, importo, alunni(nome,cognome)`;
2. `fattureDeiPagamenti(supabase, ids, sedi)` (§5.5), con anche le righe grezze;
3. `riconciliazione_movimenti` confermati.

**Verdetto.** Vince il primo motivo, in quest'ordine:
1. `pagamento_inesistente`;
2. `non_saldato`;
3. `partita_non_registrata` (`fatturaPartitaNonRegistrata` di D1);
4. `trasporto_in_sospeso` (riga viva con `sdi_stato` e `aruba_filename` nulli);
5. `gia_in_coda`, salvo `ignoraVoci`;
6. regola dell'origine:
   - multi: `daFatturareInListaDiLavoro({...riga, coda:null, stato})`, altrimenti `gia_fatturata` | `in_attesa_sdi` | `senza_bonifico_confermato` (decisione 8);
   - singolo: `pagato && fatturaDaFare`, per qualunque saldato.

**`tipo_invio` (v4, S51).** Vale `ritrasmissione` se fra le righe grezze del pagamento una ha `sdi_stato` in `STATI_SDI_SCARTO` (importato, mai scritto a mano); altrimenti `prima_emissione`. Serve solo a mostrarlo: a decidere è l'SQL.

**Fase costosa.** Solo sulle voci sopravvissute, concorrenza 8, entro `budgetMs`; le voci non iniziate vanno in `nonValutate`.
- `leggiAccessoAruba(supabase, scuolaId)` di D3, **col tipo di D3**, una volta per sede:
  - esito positivo → si prosegue;
  - «non configurato» o «disabilitato» → `sede_non_configurata`;
  - errore di lettura → `lettura_fallita`.
  - Nessun import da `@/lib/aruba/client` (S36).
- `componiCausalePagamento` → `causale_non_componibile`, più l'avviso `causale_troncata`.
- Multi:
  - eccezione di `componiIntestatarioPagamento` → `lettura_fallita`;
  - `!prontaPerIlLotto` → `quote_non_fatturabili` | `intestatario_dati_incompleti` (`propostaBloccataDaiDati`) | `intestatario_da_scegliere`;
  - `p = intestatarioAutomaticoDelLotto(a)`; `daProposta = p && !quoteTutteFatturabili(a.quote)`;
  - conferma uguale → `pronta` con `proposta_bonifico`;
  - senza conferma, in anteprima → `da_confermare`;
  - senza conferma o con un altro `adult_id`, all'accodamento → `proposta_da_confermare`.
  - La proposta **non si applica mai** senza conferma (S12, F14).
- Singolo: una persona con `validaCessionario` non vuoto → `persona_incompleta`.

**Log:** uno solo, `coda-precontrollo` (C§15), con soli conteggi e `ms`.

### 5.2 `situazione.ts`, `periodo.ts` (puri)

- `componiSituazione`: `documento = esitoFatturazione({...riga, coda})`. Con `in_coda` in `TONI_FATTA`, una voce attiva spegne da sola `idoneo_multi` e `fatturabile_singolo`.
- `ordinaEtaglia`: ordina per `data_riferimento`, poi per `pagamento_id`; restituisce `{candidati (500), totale, restanti}`.

### 5.3 `stato-coda.ts` (puro)

**`componiVoceInElenco(riga, ctx)`** compone la forma di C§12:
- **Visibilità (decisione 6).** Nomi, importi, stato, posizione, numero e codice dell'esito si vedono in tutte le sedi. `esito.messaggio`, `invii_aperti[].dettaglio` e `causale_manuale` valgono `null` fuori dalla sede propria.
- **`verifica`** si compone dalle colonne `verifica_dovuta_il`, `verifica_auto_esito` e `azione_richiesta*`. `azione_richiesta_da` è il nome dall'embed. C'è solo per `da_verificare`, o per `in_invio` con lavoro `verifica`.
- **`invii_aperti`**: gli invii della voce con stato in `STATI_INVIO_APERTI`, ordinati per `quota_label` e `numero`.
  - `numero_leggibile = numeroLeggibile({sezionale, numero, anno})`: per un invio del giornale non può essere null (sezionale Asilo/FPR e anno valido per CHECK); se lo fosse, l'invio si scarta e si scrive un warn `coda-nomi-non-risolti`.
  - `oltre_12_giorni = ctx.oltreLimite.has(invio_id)`;
  - `tardiva_autorizzata = tardiva_autorizzata_il != null`.
- **`fatture`**:
  - righe `fatture_emesse` con id fra i `fattura_emessa_id` degli invii della voce (tutti, non solo gli aperti);
  - per `emessa` con `gia_a_registro`, le righe del pagamento;
  - `numero_leggibile = numeroLeggibile(riga)`, `scartata = !fatturaViva(riga)`;
  - `data_documento` = quella dell'invio con lo stesso `fattura_emessa_id`, altrimenti null (F39).

**`azioniAmmesse(voce, invii, ctx)`**, firma di C§13, **nessun calcolo di date**:
- `togli` = `in_coda`/`errore` senza alcun invio;
- `rimetti` = `errore`; `rimetti_serve_forza` = uno dei suoi invii `numerata` sta in `ctx.oltreLimite`;
- `urgente` = `in_coda`;
- `causale` = sede propria, `in_coda`/`errore`, nessun invio in `STATI_INVIO_APERTI`;
- `cerca` = `da_verificare` senza `azione_richiesta`;
- `rimanda` = come `cerca`, più almeno un invio aperto non `caricata`; `rimanda_serve_forza` = `ctx.oltreLimite` non vuoto per la voce;
- **`ritrasmetti`** = sede propria, stato `emessa`, almeno una `fatture[].scartata`, `pagamento.fattura_stato` scartata e `pagamento.stato` pagato, `!ctx.voceAttivaDelPagamento`.
  - Comprende il `doppione_sdi` aperto. Esclude `doppione_sdi_irrisolto`: con quel codice `ritrasmetti = false` anche se le condizioni sono vere, perché il messaggio è «NON riemetterla».
  - I letterali `scartata`/`pagato` sono stati di `pagamenti`, fuori dalle liste vietate. Stanno in `src/lib` e non nella rotta, così il lock `un-motore-solo:216` resta verde.

**Altre funzioni.**
- `stimeDaPosizioni`: solo `simulaInvii` di D3. `daInviare = in_coda + in_invio`; `riapreIl = max(circuito_fino_a, pausa_fino_a)` se nel futuro.
- `ordinaPerPosizione`: solo visualizzazione.

### 5.4 `risposte-api.ts` (solo server, non chiama RPC)

- `perimetroCoda`: `sediReali ∪ scuoleDiUtente`; restituisce `null` se `schools` non si legge (→ 503 `LETTURA_FALLITA`).
- **`rispostaCoda(codice: CodiceErroreCoda, dati?)`**: export interno, l'**unico** costruttore dei corpi d'errore della coda.
  - Uno `switch` con un `case` per codice; in ognuno `error` e `codice` sono **letterali**.
  - In fondo `default: { const _x: never = codice }`, così l'esaustività la controlla `tsc`.
  - Il lock `errori-con-codice` resta senza esenzioni nuove.
- **`MAPPA_RIFIUTO_HTTP: Record<CodiceRifiuto, {http; codice: CodiceErroreCoda}>`**, come nel contratto: solo dati, chiavi calcolate (`[RIFIUTO.X]`).

| Codici RPC | HTTP · codice |
|---|---|
| `NON_TROVATO` | 404 `CODA_VOCE_NON_TROVATA` |
| `FUORI_SEDE`, `SEDE_ASSENTE`, `ATTORE_NON_STAFF`, `ATTORE_NON_ADMIN` | 403 `CODA_ATTORE_NON_AUTORIZZATO`, più error `coda-rifiuto-inatteso` (r1: `FUORI_SEDE`/`SEDE_ASSENTE` → `SEDE_NON_ACCESSIBILE`) |
| `IN_LAVORAZIONE` | 409 `CODA_VOCE_IN_LAVORAZIONE` |
| `NUMERO_GIA_ASSEGNATO` | 409 `CODA_NUMERO_GIA_ASSEGNATO` |
| `STATO_NON_VALIDO`, `GIA_IN_CODA`, `PARTITA_NON_REGISTRATA`, `TRASPORTO_IN_SOSPESO` | 409 `CODA_STATO_NON_VALIDO` |
| `OLTRE_12_GIORNI` | 409 `CODA_OLTRE_12_GIORNI` con `{data_documento, giorni}` |
| `FORZA_SOLO_ADMIN` | 403 `CODA_FORZA_SOLO_ADMIN` |
| `CAUSALE_ALTRA_SEDE` | 403 `CODA_CAUSALE_ALTRA_SEDE` |
| `NON_SALDATO` | 409 `CODA_PAGAMENTO_NON_SALDATO` |
| `TIPO_NON_SUPPORTATO` | 422 `CODA_TIPO_NON_SUPPORTATO` |
| tutti gli altri | 500 `CODA_ERRORE_INTERNO`, più error `coda-rifiuto-inatteso` (mai distinto per voce) |

- `rispostaDaRifiuto(code, azione, dati?)` = `rispostaCoda(MAPPA_RIFIUTO_HTTP[code].codice, dati)`, più il log.
- `rispostaCodaNonDisponibile()` = `rispostaCoda('CODA_FATTURE_NON_DISPONIBILE', {disponibile:false})`.
- `partenzaDa(sveglia, riepilogo, adesso)`, sei rami:
  1. `sveglia` → `subito`;
  2. coda sospesa → `sospesa`;
  3. circuito o pausa nel futuro → `in_pausa` con `riprende_il`;
  4. prestito vivo della coda → `giro_in_corso`;
  5. `ultima_sveglia_il > ultimo_giro_il` da meno di 60 s → `subito`;
  6. altrimenti → `prossimo_giro`.

### 5.5 `src/lib/pagamenti/fatture-dei-pagamenti.ts`

**Commit 1, spostamento puro** (dopo D1 in `main`):
- da `riconciliazione/route.ts` escono, **invariati**: `FATTURE_SELECT` (`:939`), `RigaFatturaMovimento` (`:941`), `numeroLeggibile` (`:981`, con la sua testata), e la funzione pura di `:1009`, esportata col nome `fattureDaRighe(righe)` perché il nome del contratto va alla lettura con cintura (§ sotto);
- la rotta importa da lì e non importa più `fattura-viva`;
- nello **stesso commit**, nel lock `annullo-riapre-movimento`, la voce CONSUMATORI (`:259`) diventa `src/lib/pagamenti/fatture-dei-pagamenti.ts`;
- il file del lock entra in C§19 sotto D4 («chi rompe ripara»);
- si ritocca la testata di `fattura-viva.ts:95-106`, che cita la rotta come sede di `numeroLeggibile` (solo commento; `fattura-viva.ts` diventa di D4 con la stessa regola);
- tutta la suite della riconciliazione, compresi `-auto` e `-upload`, deve restare verde.

**Poi** si aggiungono:
- `fattureDeiPagamenti(supabase, ids, sedi)`, la firma del contratto: legge `fatture_emesse` a blocchi di 100 con `.in('scuola_id', sedi)`; restituisce la mappa per pagamento e le righe grezze;
- `documentoDelPagamento(mappa, id)`.

La rotta della riconciliazione tiene la sua lettura di oggi (senza filtro di sede, coperta da `AMMESSE riconciliazione:GET`) e chiama `fattureDaRighe`, così ciò che mostra non cambia.

### 5.6 `assertPagamentiInScope(supabase, user, ids)` in `scope.ts`

- Una sola `scuoleDiUtente`, poi `pagamenti.select('id, scuola_id').in('id', blocco)` a blocchi di 100.
- Lettura fallita → `scopeNonRisolto('scope-pagamenti-non-risolti', …)`.
- Un id mancante → 404 `{error, codice:'PAGAMENTO_NON_TROVATO'}`, letterale.
- Una sola riga fuori sede o senza sede → `rifiutoSede('SEDE_NON_ACCESSIBILE')` sull'intera richiesta, più il warn `auth` `pagamenti-fuori-sede` con `n` (mai gli id).

---

## 6. `POST /api/pagamenti/fattura/coda`: accoda

`export const maxDuration = 300`.

1. `requireStaff` → `parseBody(zCorpoAccoda)` → `createAdminClient()`.
2. Singolo con `tipo_documento ∉ TIPI_DOCUMENTO_SUPPORTATI` → `rispostaCoda('CODA_TIPO_NON_SUPPORTATO')`, senza letture (decisione 4).
3. `assertPagamentiInScope`; `sedi = scuoleDiUtente`.
4. Idempotenza anticipata: `fatture_coda_gruppi.select('id, creato_da').eq('richiesta_id', …)`.
   - Gruppo di un altro utente → `CODA_RICHIESTA_ALTRUI`.
   - Gruppo dell'utente → RPC con le voci minime; D2 risponde `gia_esistente`.
   - Schema assente → 503.
5. `supabase.rpc('fatture_coda_stato_pagamenti', { p_scuola_ids: sedi, p_pagamento_ids })` → `codaDi`.
6. `precontrollaVoci(…, {budgetMs: 240_000, concorrenza: 8, conAnteprima: false})`, autorevole (decisione 7).
7. Le sole voci pronte, nell'ordine della richiesta, vanno a `supabase.rpc('fatture_coda_accoda', { p_attore: auth.user.id, p_scuola_ids: sedi, p_richiesta_id, p_origine, p_urgente, p_voci, p_periodo })`.
   - Ogni voce: `{pagamento_id, tipo_documento, causale_modo, causale?, intestatario?, intestatario_origine?, ricorda_scheda?}`.
   - `causale_modo` segue `MODI_CAUSALE` e la regola di C§12.
8. Nessuna pronta → 200 con `accodate: []` e i motivi.
9. Dopo la RPC, in parallelo e senza bloccare se fallisce: `posizioni` e `riepilogo` sul perimetro → `stimeDaPosizioni` e `partenzaDa(esito.sveglia, …)`.
10. Rifiuti per riga della RPC (`GIA_IN_CODA`, `NON_SALDATO`, `NON_TROVATO`, `PARTITA_NON_REGISTRATA`, `TRASPORTO_IN_SOSPESO`, `TIPO_NON_SUPPORTATO`) → motivi di `rifiutate`. Ogni altro codice → `rispostaDaRifiuto` sull'intera richiesta.
11. Log `coda-precontrollo`, `tipo` `urgente` | `normale`.

---

## 7. Tono `in_coda` e campo `coda` nella riconciliazione (S13, S11)

**`fatturazione-riga.ts`**
- `TonoFatturazione += 'in_coda'`, `FonteFatturazione += 'coda'`.
- `RigaFatturabile.coda?`, col tipo di C§13.
- Primo ramo di `esitoFatturazione`: `m.pagamento_id && m.coda` → `in_coda`.
- `TONI_FATTA = {fatturata, attesa, in_coda}`; `TONI_DA_FARE` invariato.
- Le chiavi UI le aggiunge D5 nello stesso commit (C§20).

**`riconciliazione/route.ts`**
- `perFatturazione` copia anche `coda`.
- `sediAttive` si calcola **prima** dell'arricchimento: è la stessa chiamata di `:1379`, spostata, e solo con pagamenti abbinati.
- Lettura in `try/catch`: `supabase.rpc('fatture_coda_stato_pagamenti', { p_scuola_ids: [...sediAttive], p_pagamento_ids: blocco })` a blocchi di 2000.
  - `ok` → mappa `{voce_id, stato, urgente, numero_assegnato}`; `invii_oltre_limite` si ignora;
  - `non_migrata`/`guasto` → `codaDi = null` (il log lo scrive già `leggiEsitoRpc`);
  - **eccezione** (anche `rpc` assente nei finti, F33) → `codaDi = null`, più un solo error `rpc-guasta` per richiesta, con l'errore come quarto argomento.
- `{...r, fattura, coda: codaDi?.get(pid) ?? null}`; meta `coda_disponibile`.
- Nessun `fattura_stato ===`.
- I 5 test GET restano verdi senza `rpc`: si aggiornano solo quelli che confrontano `meta` con `toEqual` (misura).

**`riconciliazione-ui.test.ts`:** 150 combinazioni (75 × con e senza `coda`), 5 toni, controllo positivo sul numero.

---

## 8. `GET coda/periodo` (decisione 9)

- **Controlli:** `da ≤ a`, al massimo 366 giorni, da 1 a 10 sedi, al massimo 50 categorie; altrimenti `CODA_PERIODO_NON_VALIDO`. `sedi ⊄ proprie` → `rifiutoSede`.
- **Letture** a pagine di 1000 con `.range()`, fino a 5000 righe; oltre, `troncato:true`.
  - Base `bonifico`: movimenti confermati nel periodo.
  - Base `competenza`: `pagamenti` `pagato` con `periodo_competenza` dal primo giorno del mese iniziale all'ultimo del mese finale. `senza_competenza` è un `count` (null con la base `bonifico`).
  - Filtro `categorie` quando non è vuoto.
- **Poi:** `stato_pagamenti` → `verdettiEconomici` con la regola multi → `ordinaEtaglia`.
- Log info `coda-periodo-selezionato`. Coda assente → 200 `disponibile:false`.

---

## 9. `GET coda`: stato (forma v4)

**`?solo_riepilogo=1`:** `fatture_coda_riepilogo(perimetro, auth.user.id)`, più `fatture_coda_stato.select('sospesa_da, autore:utenti!sospesa_da(nome, cognome)')`, più `prossimoTick`. `bollino_rosso = da_verificare + doppioni_sdi > 0`. La chiave DB `errore` diventa `contatori.errori`.

**Forma completa**
1. Il riepilogo.
2. La vista:
   - `attive`: `fatture_coda_posizioni(perimetro, NULL)`, più le voci attive del perimetro a pagine di 1000 → `ordinaPerPosizione` → pagina;
   - `inviate` e `tolte`: `concluso_il ≥ adesso − GIORNI_STORICO_CODA`, con `count:'exact'`;
   - `doppioni_sdi`: `.in('id', riepilogo.doppioni_aperti)`.
3. Con **`voce=` o `pagamento=`** la vista e lo storico non contano: si leggono quella voce, o le voci di quel pagamento, del perimetro, in qualunque stato ed età entro i 24 mesi. È il link di un avviso arrivato giorni dopo (r2).
4. Voci della pagina con gli embed:
   - `gruppo`, `pagamento(stato, fattura_stato, importo, periodo_competenza, categoria, descrizione, alunni(nome,cognome))`;
   - `accodata_da` via `creato_da`; `azione_richiesta_da` via embed;
   - `invii:fatture_coda_invii(id, stato, sezionale, anno, numero, data_documento, importo, quota_label, tentativi, esito_codice, esito_il, esito_dettaglio, aruba_filename, ricerca_esito, ricerca_il, ricerche_fallite, consecutivi_429, tardiva_autorizzata_il, fattura_emessa_id)`.
5. `fatture_emesse.select('id, pagamento_id, sezionale, numero, anno, quota_label, sdi_stato, sdi_stato_label').in('scuola_id', perimetro)`, con due filtri:
   - `.in('id', fattura_emessa_id degli invii)`;
   - `.in('pagamento_id', …)` per le voci `emessa` `gia_a_registro`.
6. **(v4, S48)** `supabase.rpc('fatture_coda_stato_pagamenti', { p_scuola_ids: perimetro, p_pagamento_ids: pagamenti della pagina })`, al massimo 200 pagamenti. Ne vengono:
   - `oltreLimite`: `invio_id → InvioOltreLimite`;
   - `voceAttivaDelPagamento`: il pagamento ha una voce attiva diversa da quella in esame.
7. Vista `tolte`: eventi `AZIONE_EVENTO.tolta` con l'attore per embed → `tolta{il, da_nome}`.
8. `componiVoceInElenco` per voce.

**Errori.**
- Un errore di lettura (compresa la 6) → 500 `LETTURA_FALLITA`.
- Un embed di nomi fallito → nomi `null` e warn `coda-nomi-non-risolti`.
- Coda assente → 200 `{disponibile:false}`.

---

## 10. Azioni sulle voci

**Comune.** `requireStaff` → `parseBody` → `perimetroCoda` → RPC letterale. Se nessuna voce è fatta e tutte hanno lo stesso codice → `rispostaCoda(codice, {rifiutate})`; altrimenti 200 con la divisione.

- **`togli`**: `fatture_coda_togli`. Log `coda-tolte`.
- **`rimetti`**:
  - `forza` da un non admin → 403 `CODA_FORZA_SOLO_ADMIN` prima di ogni lettura;
  - le voci con documento costruito (un invio aperto) saltano il pre-controllo; per le altre si rifà con `origine_iniziale`, e la proposta si ricontrolla (§5.1);
  - poi `fatture_coda_rimetti(…, p_forza)`;
  - `OLTRE_12_GIORNI` → 409 con `data_documento` e `giorni`;
  - log `coda-rimesse`.
- **`urgente`**: `fatture_coda_urgente`. Log `coda-urgenza`.
- **`causale`**:
  - GET: voce e pagamento nelle sedi proprie, `componiCausalePagamento`, `modificabile` = `azioni.causale`;
  - POST: `fatture_coda_causale`;
  - log `coda-causale`, con la sola lunghezza.
- **`verifica`**:
  - `forza` senza admin → 403 prima della RPC;
  - `fatture_coda_richiedi_verifica(…, p_forza)` → `{voce_id, azione, forzata, registrata:true, sveglia, prossimo_giro_il}`;
  - log `coda-verifica-richiesta`.
- **`sospensione`**:
  - `requireStaff(request, ['admin'])` → `sospendi` o `riprendi` con `p_attore: auth.user.id` → `await spedisciAvvisiCoda(supabase)`;
  - se gli avvisi falliscono: warn `coda-avvisi-non-spediti` e la sospensione resta;
  - voce `AMMESSE` misurata.

---

## 11. `POST coda/situazione` e scheda alunno

- Id fuori sede omessi.
- `stato_pagamenti` sulle sedi proprie.
- Per le voci `in_coda`, `posizioni` e `riepilogo`, da cui la stima.
- Coda assente → `{disponibile:false, righe}`.

La scheda alunno usa `GET /api/pagamenti?alunno_id`, `situazione`, `precontrollo` e `POST /coda` con origine `scheda_alunno` o `singolo`. «Ritrasmetti» dalla pagina Coda è un `POST /coda` singolo sul `pagamento_id` della voce `emessa`.

---

## 12. 410 e pulizia

### 12.1 I due 410

`POST /api/pagamenti/fattura` e `POST …/lotto`: `requireStaff` → 410 con corpo letterale `{error, codice:'FATTURA_EMISSIONE_SOLO_IN_CODA'}`, più warn `emissione-diretta-rifiutata` con `tipo` `singolo` | `lotto`.

- In `fattura/route.ts` escono il `POST`, l'import di `emettiFatturaPagamento`, la `const CODICE_TRASPORTO_IGNOTO` e gli import rimasti senza uso. Il GET del PDF resta, con `fatturaViva`.
- `lotto/route.ts` si riduce all'handler di rifiuto.
- L'allowlist e `MAX_OCCORRENZE` scendono alla misura.

### 12.2 `lotto-fatture.ts`: commit congiunto D5+D4, dopo l'eliminazione del pannello

- **Escono (21 export):** `TETTO_LOTTO`, `TETTO_BLOCCO`, `ATTESA_FRA_BLOCCHI_MS`, `PAUSA_FRA_UPLOAD_MS`, `RISERVA_PEGGIORE_MS`, `MAX_DURATION_BLOCCO_S`, `MARGINE_PIATTAFORMA_MS`, `BUDGET_BLOCCO_MS`, `LAVORO_UTILE_MS`, `DURATA_BLOCCO_STIMATA_MS`, `PAUSA_DOPO_RIFIUTO_LOCALE_MS`, `CorpoEmissione`, `corpoEmissione`, `pausaDopo`, `bloccoHaToccatoAruba`, `pausaDopoBlocco`, `fermaIlLotto`, `CODICE_TRASPORTO_IGNOTO`, `numeroInDubbio`, `stimaRimanenteMs`.
- **Restano:** `QuotaPerIlLotto`, `AnteprimaPerIlLotto`, `quoteTutteFatturabili`, `prontaPerIlLotto`.
- Nel commit, per ogni nome uscito, un grep su `src __tests__ e2e` non trova nulla.
- `lotto-fatture.test.ts` resta sui 4 export vivi.

---

## 13. Log

Esiti e livelli: **C§15**, righe di D4.
- Nessun doppione dei log di `leggiEsitoRpc`.
- `error` mai distinto per voce (F25).
- Chiavi solo fra quelle in chiaro, più i numeri.

---

## 14. Lock (D4, PR-A)

- **`errori-con-codice`:** nessuna esenzione nuova. I codici nuovi arrivano come letterali da `rispostaCoda`, da `assertPagamentiInScope` e dai 410. L'allowlist e `MAX_OCCORRENZE` scendono alla misura (compreso `sync/route.ts` di D3).
- **`intestatario-fattura-un-motore-solo`:** due aggiornamenti, nel commit della causa (C§20).
- **`tetto-orario-aruba`:** «il gesto non è il ritmo»; via `TETTO_LOTTO`.
- **`isolamento-sede-coverage`:** `AMMESSE` per `sospensione:POST`, misurata.
- **`riconciliazione-ui`:** 5 toni.
- **`fatturazione-riconciliazione-un-motore-solo`:** si rilancia, invariato.
- **`annullo-riapre-movimento`:** il consumatore diventa `fatture-dei-pagamenti.ts` (§5.5).
- **Nuovo `fatture-coda-api-contratto.test.ts`:**
  - (a) ogni route `coda/*` tranne `giro` importa gli schemi da `api-contratto` e non dichiara schemi `z` locali;
  - (b) ogni `.rpc('fatture_coda_…'` delle route ha `p_scuola_ids` (tranne `sospendi`/`riprendi`); quelle di scrittura hanno anche `p_attore: auth.user.id`;
  - (c) `MAPPA_RIFIUTO_HTTP` ha tutte le chiavi di `CODICI_RIFIUTO`, e ogni codice sta in `CODICI_ERRORE`;
  - (d) nelle route `coda/*` e nei 410 nessun `codice:` non letterale; in `risposte-api.ts` c'è un `codice: '<X>'` letterale per ogni `CodiceErroreCoda`;
  - (e) nessun `oltre_12_giorni`, `giorni` o calcolo con `data_documento` in `stato-coda.ts` fuori dalla lettura di `oltreLimite` (C§21);
  - (f) controllo positivo: le route trovate sono esattamente 10 file.

---

## 15. Test (D4)

- **`stato-coda.test.ts`:**
  - voce a due quote con due `invii_aperti`;
  - `numero_leggibile` FPR «FPR n/26» e Asilo «Asilo n/AAAA»;
  - `fatture[].scartata` con `sdi_stato` 2, 4, 9 vero, 1 falso;
  - `data_documento` null senza invio;
  - `ritrasmetti` vero su `emessa` più riga scartata più pagamento `scartata`/`pagato`; falso con una voce attiva, fuori sede, con `doppione_sdi_irrisolto`, con pagamento non `pagato`;
  - `rimetti_serve_forza` e `rimanda_serve_forza` **solo** da `oltreLimite`, con prova di rottura: una voce `trasporto_ignoto` con l'invio in `oltreLimite` chiede la forza anche se il codice non lo dice; senza la voce in `oltreLimite` non la chiede, anche con `esito_codice oltre_12_giorni`;
  - `dettaglio`, `messaggio` e `causale_manuale` null fuori sede.
- **`fattura-coda-stato.test.ts`:**
  - la forma v4 contro il tipo;
  - 12 e 13 giorni resi dai finti di `stato_pagamenti`;
  - `voce=` a 30 giorni dalla chiusura restituisce la voce;
  - `stato_pagamenti` in errore → 500 `LETTURA_FALLITA`;
  - nessun `forzata` in `verifica`.
- **`risposte-api.test.ts`:** ogni `CodiceErroreCoda` produce il suo status e il suo `codice`; `MAPPA_RIFIUTO_HTTP` è coerente con lo `switch`; `partenzaDa` nei 6 rami.
- **`precontrollo.test.ts`:**
  - `tipo_invio` `ritrasmissione` solo con una riga in `STATI_SDI_SCARTO`;
  - un pagamento `scartata` senza righe dà `prima_emissione`;
  - proposta con e senza conferma;
  - budget e `nonValutate`;
  - `leggiAccessoAruba` nei 3 esiti.
- **`riconciliazione-coda.test.ts`:** un finto senza `rpc` risponde 200 con `coda_disponibile:false`; `?fattura=fatturate` include le righe in coda; `invii_oltre_limite` ignorato.
- **`fatture-dei-pagamenti.test.ts`:**
  - `fattureDaRighe` equivalente alla funzione spostata (stessi casi);
  - `numeroLeggibile` invariata (FPR a 2 cifre, sezionale ignoto, fuori scala → null);
  - `fattureDeiPagamenti` filtra per sede.
- Gli altri come nel giro 5: accoda, situazione, azioni, periodo (controllo positivo su 2500 righe), 410, `assert-pagamenti-in-scope`, `fatturazione-riga-coda`.
- **Test vecchi:**
  - `fattura-route.test.ts`: casi POST → 410;
  - eliminati `fattura-lotto.test.ts` e `fattura-lotto-ricorda-intestatario.test.ts`, dopo l'elenco delle asserzioni concordato con D3;
  - `fattura-intestatario-route` e `quota-estranea` migrati;
  - `lotto-fatture.test.ts` sui 4 export vivi.

---

## 16. Sequenza (C§20)

1. Dopo D1 in `main`: commit dello spostamento puro in `fatture-dei-pagamenti.ts`, col lock `annullo-riapre-movimento` e la voce in C§19.
2. **Fase 0:** `api-contratto.ts` con i tipi v4; `CHIAVI_MESSAGGIO_CODA` e cataloghi.
3. **Fase 1:**
   - `fattureDeiPagamenti` con cintura e `scope.ts`;
   - `precontrollo.ts` più lock intestatario (1);
   - `situazione`, `periodo`, `stato-coda`, `risposte-api`.
4. **Fase 2:**
   - le route;
   - i 410;
   - tono `in_coda` più `perFatturazione`, `coda` e `riconciliazione-ui`, nel commit delle chiavi di D5;
   - commit congiunto D5+D4 (§12.2, lock intestatario (2), tetto);
   - misura di fine fase.
5. **Gate:** eslint, tsc, vitest (conteggio dei file), build.


## File toccati

| Percorso | Azione | Motivo |
|---|---|---|
| `src/lib/fatture-coda/api-contratto.ts` | crea | Contratto HTTP unico: schemi zod, tipi v4 (VoceInElenco con invii_aperti[], fatture[], VerificaVoce, InvioAperto, FatturaDellaVoce, AzioniVoce), CodiceErroreCoda, CHIAVI_MESSAGGIO_CODA; nessun letterale vietato |
| `src/lib/fatture-coda/precontrollo.ts` | crea | Pre-controllo senza Aruba; tipo_invio con STATI_SDI_SCARTO (S51); proposta solo con conferma uguale (S12); leggiAccessoAruba col tipo di D3 |
| `src/lib/fatture-coda/situazione.ts` | crea | Flag idoneo_multi/fatturabile_singolo e documento (puro) |
| `src/lib/fatture-coda/periodo.ts` | crea | ordinaEtaglia: le 500 più vecchie più le restanti (puro) |
| `src/lib/fatture-coda/stato-coda.ts` | crea | componiVoceInElenco nella forma v4 (numero_leggibile, fatture[].scartata = !fatturaViva, data_documento dal giornale); azioniAmmesse coi limiti solo da stato_pagamenti.invii_oltre_limite e ritrasmetti esteso |
| `src/lib/fatture-coda/risposte-api.ts` | crea | rispostaCoda (switch a codici letterali), MAPPA_RIFIUTO_HTTP col tipo del contratto, partenzaDa, perimetroCoda |
| `src/app/api/pagamenti/fattura/coda/route.ts` | crea | GET stato (forma v4, stato_pagamenti per i pagamenti della pagina, voce/pagamento fuori storico) e POST accoda |
| `src/app/api/pagamenti/fattura/coda/precontrollo/route.ts` | crea | Anteprima a blocchi di 50 |
| `src/app/api/pagamenti/fattura/coda/periodo/route.ts` | crea | Candidati del periodo con letture paginate a 1000 |
| `src/app/api/pagamenti/fattura/coda/situazione/route.ts` | crea | Flag di coda per liste, drawer, scheda alunno |
| `src/app/api/pagamenti/fattura/coda/togli/route.ts` | crea | Decisione 11 |
| `src/app/api/pagamenti/fattura/coda/rimetti/route.ts` | crea | Decisione 10, con la forza di un admin per documento (S42) |
| `src/app/api/pagamenti/fattura/coda/urgente/route.ts` | crea | Decisione 3 |
| `src/app/api/pagamenti/fattura/coda/causale/route.ts` | crea | Decisioni 6 e 19 |
| `src/app/api/pagamenti/fattura/coda/verifica/route.ts` | crea | Decisione 15, asincrona |
| `src/app/api/pagamenti/fattura/coda/sospensione/route.ts` | crea | Decisione 12, solo admin, poi spedisciAvvisiCoda |
| `src/app/api/pagamenti/fattura/route.ts` | modifica | POST → 410 con codice letterale; GET del PDF con fatturaViva invariato |
| `src/app/api/pagamenti/fattura/lotto/route.ts` | modifica | POST → 410; file ridotto all'handler di rifiuto |
| `src/app/api/pagamenti/riconciliazione/route.ts` | modifica | Campo coda con try/catch; perFatturazione porta coda; sediAttive anticipata; FATTURE_SELECT, RigaFatturaMovimento, numeroLeggibile e fattureDaRighe importati da fatture-dei-pagamenti |
| `src/lib/pagamenti/fatture-dei-pagamenti.ts` | crea | Spostamento puro (FATTURE_SELECT, RigaFatturaMovimento, numeroLeggibile invariata, fattureDaRighe), poi fattureDeiPagamenti(supabase, ids, sedi) con cintura di sede e documentoDelPagamento |
| `src/lib/pagamenti/fattura-viva.ts` | modifica | Solo il commento di testata (:95-106), che cita riconciliazione/route.ts come sede di numeroLeggibile; chi rompe ripara |
| `src/lib/pagamenti/fatturazione-riga.ts` | modifica | Tono in_coda dentro TONI_FATTA, fonte coda, campo coda |
| `src/lib/pagamenti/lotto-fatture.ts` | modifica | Via 21 export morti; restano i 4 usati dal pre-controllo |
| `src/lib/auth/scope.ts` | modifica | assertPagamentiInScope con PAGAMENTO_NON_TROVATO letterale e rifiutoSede |
| `src/lib/ui/esito-fetch.ts` | modifica | Spread di CHIAVI_MESSAGGIO_CODA |
| `messages/it/shared.json` | modifica | Messaggi dei 15 codici della coda |
| `messages/en/shared.json` | modifica | Messaggi dei 15 codici della coda |
| `docs/superpowers/errori-senza-codice-allowlist.json` | modifica | Allowlist abbassata alla misura dopo i 410 |
| `__tests__/architecture/errori-con-codice.test.ts` | modifica | Solo MAX_OCCORRENZE alla misura; nessuna esenzione nuova |
| `__tests__/architecture/annullo-riapre-movimento.test.ts` | modifica | CONSUMATORI (:259): riconciliazione/route.ts → fatture-dei-pagamenti.ts, nello stesso commit dello spostamento (chi rompe ripara; entra in C§19 sotto D4) |
| `__tests__/architecture/intestatario-fattura-un-motore-solo.test.ts` | modifica | Due aggiornamenti: col precontrollo e con la rimozione del pannello |
| `__tests__/architecture/isolamento-sede-coverage.test.ts` | modifica | AMMESSE per coda/sospensione:POST, misurata (PR-A) |
| `__tests__/pagamenti/tetto-orario-aruba.test.ts` | modifica | Il gesto (500) non è il ritmo (50); via TETTO_LOTTO |
| `__tests__/pagamenti/riconciliazione-ui.test.ts` | modifica | Partizione a 5 toni su 150 combinazioni |
| `__tests__/architecture/fatture-coda-api-contratto.test.ts` | crea | Lock D4: schemi importati, rpc letterali, MAPPA completa, codici letterali, nessun calcolo dei 12 giorni in stato-coda, 10 route |
| `__tests__/lib/fatture-coda/precontrollo.test.ts` | crea | Motivi, tipo_invio con STATI_SDI_SCARTO, proposta con conferma, budget, accesso |
| `__tests__/lib/fatture-coda/stato-coda.test.ts` | crea | Forma v4, due quote, numero_leggibile, scartata, ritrasmetti, limiti solo da oltreLimite con prova di rottura |
| `__tests__/lib/fatture-coda/risposte-api.test.ts` | crea | rispostaCoda esaustiva, coerenza con MAPPA_RIFIUTO_HTTP, partenzaDa nei 6 rami |
| `__tests__/lib/pagamenti/fatture-dei-pagamenti.test.ts` | crea | fattureDaRighe equivalente, numeroLeggibile invariata, fattureDeiPagamenti con cintura di sede |
| `__tests__/lib/pagamenti/fatturazione-riga-coda.test.ts` | crea | Tono in_coda e predicati |
| `__tests__/lib/auth/assert-pagamenti-in-scope.test.ts` | crea | Gate in blocco |
| `__tests__/api/fattura-coda-accoda.test.ts` | crea | POST accoda |
| `__tests__/api/fattura-coda-stato.test.ts` | crea | GET stato: forma v4, 12 e 13 giorni da stato_pagamenti, voce fuori storico, errore di lettura → 500 |
| `__tests__/api/fattura-coda-situazione.test.ts` | crea | Situazione |
| `__tests__/api/fattura-coda-azioni.test.ts` | crea | togli, rimetti, urgente, causale, verifica, sospensione |
| `__tests__/api/fattura-coda-periodo.test.ts` | crea | Periodo con paginazione e tetto |
| `__tests__/api/riconciliazione-coda.test.ts` | crea | Campo coda, filtro, finto senza rpc |
| `__tests__/api/fattura-emissione-diretta-410.test.ts` | crea | I due POST vecchi → 410 |
| `__tests__/api/pagamenti-riconciliazione.test.ts` | modifica | Solo se confronta meta con toEqual (F33, misura) |
| `__tests__/api/pagamenti-riconciliazione-fatture.test.ts` | modifica | Solo se la misura lo chiede (F33) |
| `__tests__/api/pagamenti-riconciliazione-fatturazione.test.ts` | modifica | Solo se la misura lo chiede (F33) |
| `__tests__/api/pagamenti-riconciliazione-filtri.test.ts` | modifica | Solo se la misura lo chiede (F33) |
| `__tests__/api/riconciliazione-ripresa-trasporto.test.ts` | modifica | Solo se la misura lo chiede (F33) |
| `__tests__/api/fattura-route.test.ts` | modifica | Casi POST → 410; asserzioni sull'emissione portate sui test di D3 |
| `__tests__/api/fattura-lotto.test.ts` | elimina | Emissione a lotto sostituita dalla coda |
| `__tests__/api/fattura-intestatario-route.test.ts` | modifica | Asserzioni portate su precontrollo ed emetti-voce, poi eliminato se vuoto |
| `__tests__/api/fattura-route-quota-estranea.test.ts` | modifica | Asserzioni portate sui test di emettiFatturaPagamento, poi eliminato se vuoto |
| `__tests__/api/fattura-lotto-ricorda-intestatario.test.ts` | elimina | Le 5 condizioni passano a emetti-voce.test.ts di D3 |
| `__tests__/lib/lotto-fatture.test.ts` | modifica | Resta sui 4 export vivi |

## Rischi

- [V] Lo spostamento in `fatture-dei-pagamenti.ts` toglie l'import di `fattura-viva` dalla rotta: senza l'aggiornamento di `annullo-riapre-movimento` nello stesso commit il lock diventa rosso (`:652-653`).
- [V] Un corpo d'errore scritto fuori da `rispostaCoda` con un codice importato rende rosso `errori-con-codice`. Lo prevengono il punto (d) del lock D4 e lo `switch` con `never`.
- [D] Se la richiesta r1 non viene accolta, un `FUORI_SEDE` restituito dalla RPC compare come «attore non autorizzato». Il perimetro lo filtra già la route, quindi il caso segnala un'incoerenza, che scrive l'error `coda-rifiuto-inatteso`.
- [V] `perFatturazione` (`route.ts:880`) non copia campi nuovi: se si dimentica `coda`, il filtro `?fattura=` ignora il tono `in_coda`. È coperto da `riconciliazione-coda.test.ts`.
- [V] `sediAttive` (`:1379`) va anticipata in una rotta di 2150 righe che contiene anche il POST: serve un commit dedicato con tutta la suite della riconciliazione verde.
- [V] Con `max_rows = 1000` ogni lettura più lunga deve paginare con `.range()`; il test ha un controllo positivo su 2500 righe.
- [D] La GET della coda diventa 500 se `fatture_coda_stato_pagamenti` fallisce. È una scelta voluta (i limiti non si inventano), ma la pagina dipende da una RPC in più.
- [D] `ritrasmetti` si calcola con `fattura_stato` e `stato` del pagamento letti dalla GET: una sync che scrive `scartata` fra la lettura e il clic è coperta dal pre-controllo e dalla RPC di accodamento.
- [D] Il campo `coda` della riconciliazione vale solo per le sedi dell'operatore: una riga abbinata di un'altra sede con il pagamento in coda mostra il chip del documento senza «In coda». Il limite è dichiarato.
- [V] Oggi solo 2 dei 280 pagamenti da fatturare hanno un bonifico confermato, quindi multiplo e periodo selezioneranno poco (decisione 8). D5 deve rendere evidenti `senza_competenza` e `senza_bonifico_confermato`.
- [D] Un pre-controllo di 500 righe si stima in 70-100 s, dentro `maxDuration` 300 e il budget di 240 s. Il campo `ms` del log `coda-precontrollo` lo misura nelle prime ore.
- [D] Le asserzioni dei test vecchi di emissione vanno portate sui test di D3 con un elenco concordato prima di eliminarle, altrimenti si perde copertura.
