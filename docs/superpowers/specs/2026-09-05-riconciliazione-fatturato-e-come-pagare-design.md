# La riga verde non dice mai «fatturato», e il genitore non sa dove mandare i soldi

*Design — 2026-09-05 (branch `feat/riconciliazione-fatturato-e-come-pagare`, da `origin/main` `a945de72`)*

## Il problema, misurato

### 1. In riconciliazione, dopo la fattura, non succede niente

Il registro dei movimenti bancari ha **quattro stati e soli quattro** (`riconciliazione-ui.ts`,
`CHECK (stato IN ('da_abbinare','suggerito','confermato','ignorato'))`). La riga diventa verde alla
conferma dell'abbinamento e **resta identica per sempre**: l'emissione della fattura scrive su
`pagamenti.fattura_stato` (`emissione.ts`) e mai sul movimento. La catena si spezza in tre punti,
tutti a valle della fattura:

- `GET /api/pagamenti/riconciliazione` seleziona undici colonne del movimento e **nessun campo di
  fatturazione**; la query batch su `pagamenti` che già fa (`id, scuola_id`) serve solo a minimizzare i
  nomi dei minori nei suggerimenti.
- `MovimentoDialog.tsx:244` monta `<FatturaButton pagamentoId userId />` **senza `fatturaStato`**, e
  `FatturaButton.tsx:186` parte da `'non_richiesta'`: il pulsante dice «Invia fattura» anche quando la
  fattura è già uscita. Il dialog aveva già `fattura_stato` in mano — la risposta di
  `/api/pagamenti/[id]` lo porta — e ne teneva solo `stato` (`:93`).
- Non esiste un filtro «confermati da fatturare».

Le conseguenze sono due e non sono simmetriche. **Fatturare due volte** è *contenuto*: la guardia di
idempotenza (`emissione.ts:1046`) e l'indice `fatture_emesse_pagamento_quota_uidx` fermano il secondo
documento, ma l'operatore riceve un 409 che non capisce, e su un intestatario diverso passa per il ramo
«altro intestatario». **Saltare una fattura** è *reale e non mitigato*: su un registro globale con
centinaia di righe verdi indistinguibili nessuno può dire quali restano da fatturare.

### 2. Il genitore vede la causale, ma non l'IBAN né a chi è intestato il conto

La pagina `/parent/pagamenti` mostra il totale dovuto, le voci e la card «Causale consigliata per il
bonifico» (`CausaleBonifico.tsx`). Non dice che si può pagare anche in contanti, non mostra l'IBAN, non
mostra l'intestatario. Eppure:

- l'IBAN **esiste già** in Impostazioni → Fiscale (`admin_settings.fiscale_config.iban`, validato mod-97
  da `src/lib/pagamenti/iban.ts`), e il PRD (`:6393`) lo segna «da fare: compilarlo»;
- le email di sollecito hanno già il riquadro «Dati per il bonifico» con Importo · IBAN · Causale ·
  Intestato a (`sollecito.ts:87-95`), dove l'intestatario è la `denominazione` del cedente
  (`solleciti-invio.ts:131-135`, `:258`);
- `GET /api/pagamenti` ha già un loop per sede (`route.ts:237-240`) che legge `causali_config`: la
  lettura di `fiscale_config` si aggancia lì.

Il metodo di pagamento vive su `incassi.metodo`, non su `pagamenti`: «contanti o bonifico» è una regola
di casa, cioè testo, non una colonna. I contanti non sono detraibili (`metodoTracciabile`,
`fiscale.ts:85`, L. 160/2019): se si scrive che si può pagare in contanti, va detto anche questo.

## Le decisioni, e perché

### «Fatturato» è un chip sulla riga verde, non un quinto stato

Un quinto stato romperebbe il `CHECK` del DB, i filtri `?stato=` validati da zod e l'invariante
«stato del movimento = enum del DB». Il dato è **derivato** — `movimento.pagamento_id → pagamenti
.fattura_stato` — e derivato resta: il GET lo calcola con la query batch che già fa, estesa ai
`pagamento_id` dei confermati e alla colonna `fattura_stato`. Nessuna migrazione, nessuna colonna
duplicata su un registro che deve restare append-only.

La riga esce con `pagamento_stato` e `fattura_stato` **solo se confermata e di una sede attiva**
dell'operatore; altrimenti `null`. È la stessa minimizzazione dei label: un operatore non deve vedere
«da fatturare» dove non può agire. Una funzione pura, `chipFatturazione`, decide il chip:
`in_attesa` → «In attesa SDI» · `emessa` → «Fatturata» · `scartata` → «Scartata» · `non_richiesta` con
pagamento saldato → «Da fatturare» · altrimenti niente. Il filtro `?fattura=da_fatturare|fatturate` si
applica in memoria dopo l'arricchimento e si compone con `?stato=`.

### Il dialog passa al pulsante ciò che ha già in mano

`MovimentoDialog` salva `fattura_stato` dalla risposta che già riceve, lo passa a `FatturaButton` e
mostra il `FatturaChip`; con `onEmessa={onDone}` la lista si aggiorna dopo l'emissione, e il pulsante
mostra i link della fattura invece di «Invia». Quando la fattura è già uscita lo si dice in una riga.

### Un motore solo per IBAN e intestatario: la pagina e l'email dicono la stessa cosa

`coordinateBonificoSede(supabase, scuolaId)` in `src/lib/pagamenti/coordinate-bonifico.ts` legge
`fiscale_config` e `aruba_config`, prende la denominazione da `datiStruttura` e l'IBAN da
`ibanLeggibile` (assente o invalido ⇒ `null`, mai un IBAN sbagliato a schermo). Lo usano **sia**
`GET /api/pagamenti` (che risponde `sedi: [{ id, nome, iban, intestatario }]`) **sia** il motore dei
solleciti. Decisione del titolare: **nessun campo nuovo** per l'intestatario — è la denominazione del
cedente, come nelle email. Un lock architetturale impedisce che nascano due copie.

### «Come pagare» è una card sola, e non sparisce mai

Al genitore, quando c'è un residuo, compare la card «Come pagare» con due segmenti: **Bonifico**
(Intestato a · IBAN a gruppi di quattro con «Copia» · le causali per voce, che sono la card di prima
incorporata) e **Contanti** (in segreteria, ricevuta subito, non detraibili). Senza IBAN la card resta e
dice di chiederlo in segreteria. Le sedi con le stesse coordinate si mostrano una volta: il conto è uno
per la cooperativa, ma la configurazione è per sede e il codice non può darlo per scontato.

### La rete

- Test visti **rossi** prima della correzione: dialog senza `fatturaStato`, GET senza `fattura_stato`,
  risposta senza `sedi`.
- `chipFatturazione` con tabella di verità; il GET con un finto client che restituisce `fattura_stato`
  solo da `pagamenti`; `coordinateBonificoSede` con IBAN valido/invalido/assente e denominazione vuota.
- Lock `coordinate-bonifico-un-motore-solo`; regole Alto Contrasto agganciate a `kv-recon-chip` e
  `kv-come-pagare` fuori da ogni `@layer` (`@theme inline` inlina l'hex: i token ridefiniti non toccano
  le utility).
- E2E: «Come pagare» visibile sul DB CI senza `fiscale_config` (ripiego), pill «Da fatturare» presente.

## Cosa NON è stato fatto, e perché

- Nessuna migrazione e nessun campo nuovo: tutto è derivato da colonne esistenti.
- Le etichette del semaforo e dei filtri esistenti restano in italiano cablato: gap pre-esistente, si
  annota nel PRD e si chiude a parte.
- Nessun interruttore «contanti sì/no» per sede: oggi tutte e tre le sedi accettano entrambi i metodi.
- `emissione.ts` e la route `[id]` non si toccano: il 409 su «riapri» dei confermati esiste già.
