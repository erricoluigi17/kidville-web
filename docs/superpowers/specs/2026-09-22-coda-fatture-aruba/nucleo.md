# Coda fatture Aruba — NUCLEO (consegna 1)

Deciso dal titolare il 23/09/2026: prima si consegna il **nucleo**, poi il resto del piano completo,
in una seconda consegna (vedi `HANDOFF.md`). Questo documento **prevale** su contratto e design D1–D6
per tutto ciò che riguarda il nucleo. Contratto e design restano il riferimento della seconda consegna.

## Obiettivo e perimetro

La segreteria mette in coda fino a **500** fatture in un gesto, **spegne il PC**, e l'app le invia in
background. L'invio segue il motore del lotto già blindato:
- una sessione Aruba per blocco di al massimo 15;
- 50 invii l'ora (`SOGLIA_ORARIA_APP`);
- stop su 0, 429 e 5xx;
- nessun ritentativo cieco;
- blocco 409 di R1.

Dal deploy la segreteria deve poter lavorare **senza funzioni a metà**.

**Dentro il nucleo**
- Coda persistente, in ordine FIFO per gruppo di accodamento; dentro il gruppo per data del pagamento, poi per ordine di selezione.
- Accodamento dal **lotto in riconciliazione**, che usa il pre-controllo e la conferma dell'intestatario esistenti.
- Il **pulsante singolo «Fattura»** accoda in **testa** (urgente) e fa partire subito un giro.
- Motore: cron ogni 5 minuti, fuori dalle finestre della sync (:00–:05 e :30–:35); un solo lavoratore alla volta; tetto orario fail-closed.
- Stop su 429 → pausa di 60 minuti. Esito incerto o 5xx → pausa di 15 minuti.
- Pagina «Coda fatture» per tutta la segreteria (tutte le sedi):
  - in attesa, in invio, errori, inviate negli ultimi 7 giorni, orario stimato di fine;
  - «Togli» e «Rimetti in coda»;
  - «Sospendi / Riprendi» solo per l'admin.
- `/api/health`: guasto se una voce è in coda da più di 24 ore o se la coda è sospesa da più di 24 ore. Tabella assente → ok con nota.

**Fuori dal nucleo** (seconda consegna, elenco in `HANDOFF.md`): notifiche, «fattura tutto il periodo», selezione multipla nella lista Pagamenti, sezione nella scheda alunno, verifica automatica degli incerti, «Rimanda» con lo stesso numero, cancello condiviso con la sync, giornale dei numeri, livelli di priorità ulteriori, 410 sui vecchi percorsi, test cardine su PGlite completo, E2E nuovi.

**Invariati**: numero preso all'invio, data documento = giorno d'invio, `emettiFatturaPagamento` usata così com'è.

## 1. Migrazione (un file): `supabase/migrations/<T>_fatture_coda_nucleo.sql`

`<T>` = `date -u +%Y%m%d%H%M%S` al momento della scrittura. Deve essere maggiore dell'ultima migrazione e di ogni `generato_alle` delle fotografie.

### Sequenza e tabelle

**Sequenza** `public.fatture_coda_gruppo_seq`.

**Tabella `public.fatture_coda`** (una voce per pagamento accodato)

| Colonna | Tipo | Note |
|---|---|---|
| `id` | uuid PK | `default gen_random_uuid()` |
| `gruppo_id` | uuid not null | un gesto di accodamento |
| `gruppo_seq` | bigint not null | FIFO fra i gruppi |
| `ordine_selezione` | int not null default 0 | |
| `data_riferimento` | date not null | data Europe/Rome di `pagamenti.data_incasso`, altrimenti `creato_il`, altrimenti oggi |
| `urgente` | bool not null default false | |
| `pagamento_id` | uuid not null | FK `pagamenti(id)` ON DELETE CASCADE |
| `scuola_id` | uuid not null | FK `schools(id)` |
| `intestatario_scelto` | jsonb null | stessa forma che il lotto passa oggi a `emettiFatturaPagamento` |
| `conferma_proposta` | bool not null default false | |
| `causale_manuale` | text null | 1..1000 caratteri; azzerata alla chiusura |
| `stato` | text not null | CHECK in (`in_coda`, `in_invio`, `emessa`, `errore`, `tolta`) |
| `esito_codice` | text null | |
| `esito_messaggio` | text null | ≤ 500 caratteri |
| `creato_da` | uuid not null | **senza FK a utenti**, per non accendere la guardia tracce-docente |
| `accodata_il` | timestamptz default now() | |
| `in_attesa_dal` | timestamptz default now() | si azzera a ogni rientro in coda |
| `presa_il` | timestamptz | |
| `prestito_scade_il` | timestamptz | |
| `lavoratore_token` | uuid | |
| `tentativi` | int default 0 | |
| `concluso_il` | timestamptz | |
| `aggiornato_il` | timestamptz default now() | |

Indici:
- **unico parziale** `fatture_coda_una_attiva_uidx (pagamento_id) WHERE stato IN ('in_coda','in_invio','errore')`;
- indici su `(stato, urgente, gruppo_seq)`, `(scuola_id)` e `(concluso_il)`.

**Tabella `public.fatture_coda_stato`** (riga unica, `id=1`)

| Colonna | Tipo |
|---|---|
| `id` | smallint PK, CHECK `id=1` |
| `sospesa` | bool default false |
| `sospesa_da` | uuid |
| `sospesa_il` | timestamptz |
| `pausa_fino_a` | timestamptz |
| `pausa_motivo` | text |
| `lavoratore_token` | uuid |
| `lavoratore_scade_il` | timestamptz |
| `ultimo_giro_il` | timestamptz |

Si inserisce la riga `id=1`.

**RLS**: ENABLE su entrambe le tabelle, **nessuna policy**, REVOKE ALL da `public`, `anon` e `authenticated`. Si scrive solo dalle RPC.

### RPC

Tutte SECURITY DEFINER, `SET search_path = public, pg_temp` (così nella migrazione), REVOKE da PUBLIC, anon e authenticated, GRANT EXECUTE a `service_role`.

- **`fatture_coda_accoda(p_voci jsonb, p_creato_da uuid, p_urgente boolean) returns jsonb`**
  - `p_voci` = `[{pagamento_id, intestatario_scelto?, conferma_proposta?, causale_manuale?, ordine_selezione}]`.
  - Un `gruppo_id` e un `gruppo_seq` per chiamata.
  - Salta i pagamenti con una voce attiva: `ON CONFLICT (pagamento_id) WHERE stato IN (...) DO NOTHING`.
  - Risponde `{gruppo_id, accodate, gia_in_coda: [uuid]}`.
- **`fatture_coda_prendi(p_token uuid, p_max int, p_prestito_s int) returns setof fatture_coda`**
  1. `pg_advisory_xact_lock(hashtext('fatture_coda'))`.
  2. Risponde vuoto se la coda è sospesa, se `pausa_fino_a > now()`, oppure se un altro token ha il lavoratore con `lavoratore_scade_il > now()`.
  3. Altrimenti prende il lavoratore (`token`, `scadenza = now()+p_prestito_s`, `ultimo_giro_il = now()`).
  4. Seleziona al massimo `p_max` voci `in_coda`, `ORDER BY urgente DESC, gruppo_seq, data_riferimento, ordine_selezione, id`, `FOR UPDATE SKIP LOCKED`, e le porta a `in_invio` con `presa_il`, `prestito_scade_il`, `lavoratore_token` e `tentativi+1`.
- **`fatture_coda_chiudi(p_id uuid, p_token uuid, p_esito text, p_codice text, p_messaggio text) returns void`**
  - Funziona solo se `lavoratore_token = p_token` e la voce è `in_invio`.
  - `p_esito ∈ {emessa, errore, riprova}`:
    - `riprova` → la voce torna `in_coda` (posizione invariata, `in_attesa_dal` invariato);
    - `emessa` → `concluso_il = now()`, `causale_manuale` e `intestatario_scelto` azzerati; dalla consegna 2b (D13) anche `esito_messaggio`, sempre, qualunque messaggio passi il chiamante (migrazione `20260924010455_fatture_coda_chiudi_emessa_azzera_messaggio.sql`, con un blocco `DO` che ripulisce le emesse che ne avessero già uno).
- **`fatture_coda_rilascia(p_token uuid, p_pausa_minuti int, p_motivo text) returns void`**
  - Libera il lavoratore se il token combacia.
  - Se `p_pausa_minuti > 0`: `pausa_fino_a = greatest(coalesce(pausa_fino_a, now()), now() + p_pausa_minuti minuti)` e `pausa_motivo`.
- **`fatture_coda_bidello() returns int`**
  - Voci `in_invio` con `prestito_scade_il < now()` → `errore` con codice `esito_incerto` («invio interrotto: controllare sul pannello Aruba prima di rimetterla in coda»).
  - Mai di nuovo `in_coda` in automatico.
- **`fatture_coda_togli(p_ids uuid[], p_attore uuid) returns int`**: solo `in_coda` ed `errore` → `tolta`, con `concluso_il` e i campi personali azzerati; dalla consegna 2a azzera anche l'esito (`esito_codice`, `esito_messaggio`), come `fatture_coda_rimetti` (migrazione `20260923191725_fatture_coda_togli_azzera_esito.sql`).
- **`fatture_coda_rimetti(p_ids uuid[], p_attore uuid) returns int`**: solo `errore` → `in_coda`, con un nuovo `gruppo_seq` (in fondo), `in_attesa_dal = now()` ed esito azzerato.
- **`fatture_coda_sospendi(p_attore uuid, p_sospesa boolean) returns void`**
- **`fatture_coda_tick_http() returns void`**
  - Stesso schema di `video_runner_tick_http` / `fatture_sdi_sync_tick`: origine e segreto dal Vault tramite `public.cron_config`.
  - `net.http_post` verso `<origine>/api/pagamenti/fattura/coda/giro` con header `x-cron-secret` e `timeout_milliseconds := 300000`.
  - Se manca la configurazione, `RAISE WARNING` o log error come fa `video_runner_tick_http`.

**Cron**: `cron.schedule('fatture-coda-tick', '7,12,17,22,27,37,42,47,52,57 * * * *', 'select public.fatture_coda_tick_http()')`, dentro un `DO ... EXCEPTION` che tollera l'assenza di pg_cron (DB E2E). Niente minuti 2 e 32 (sync).

## 2. Lavoratore

**`src/lib/fatture-coda/giro.ts`** — `eseguiGiroCoda(sb: SupabaseClient, adesso = new Date()): Promise<EsitoGiro>`
1. **Finestra della sync**: se il minuto Europe/Rome sta in [0,5] o in [30,35], esce con `esito:'finestra-sync'`.
2. `rpc('fatture_coda_bidello')`.
3. **Posti**: `contaEmesseUltimaOra` più `posizioniDisponibili`. **Fail-closed**: se il conteggio è `null`, i posti sono 0 (log warn `tetto-non-misurato`). Si prende `max = min(TETTO_BLOCCO, posti)`. Con 0 esce, esito `quota-oraria`.
4. `token = randomUUID()`, `rpc('fatture_coda_prendi', {p_token, p_max: max, p_prestito_s: 330})`. Nessuna voce → esito `niente-da-fare`, `rilascia`.
5. Il ciclo del blocco si **estrae** da `src/app/api/pagamenti/fattura/lotto/route.ts:198-417` in `src/lib/pagamenti/esegui-blocco-fatture.ts`. Contiene: sessione unica `creaSessioneAruba`, `ritentaUpload:false`, `PAUSA_FRA_UPLOAD_MS`, budget di tempo (`BUDGET_BLOCCO_MS`, `RISERVA_PEGGIORE_MS`), `fermaIlLotto`, e la classificazione in `emesse / gia_emesse / fallite / restanti / fermato`. La route del lotto lo riusa, con comportamento invariato e test esistenti verdi.
6. Per ogni voce si chiama `emettiFatturaPagamento` con `attore = creato_da` della voce, `intestatarioScelto` e `causale_manuale`.
7. **Mappatura degli esiti → `chiudi`**:
   - ok → `emessa` (codice `emessa`);
   - già emessa → `emessa` (codice `gia_emessa`);
   - rifiuto locale 400/404/409/422 → `errore` col codice della risposta e il messaggio;
   - scarto di merito Aruba → `errore` (codice `scarto_aruba`);
   - trasporto ignoto (numero consumato, 429 sull'upload, 0, 5xx, 401/403) → `errore` codice `esito_incerto`;
   - 429 prima del numero (signin o ricerca) → `riprova`;
   - voci non toccate perché il giro si è fermato → `riprova`.
8. **`rilascia`**: 60 minuti se c'è stato un 429 (motivo `aruba-429`); 15 minuti per un esito incerto, 0 o 5xx (motivo `esito-incerto`); altrimenti 0.
9. **Log**: senza PII, con `logEvento('fattura', …)` per esito e `logEvento('cron', …)` di battito nella route.

**Route `src/app/api/pagamenti/fattura/coda/giro/route.ts`**
- `export const maxDuration = 300` (**letterale**).
- `POST = withRoute('pagamenti/fattura/coda/giro:POST', …)`.
- Gate `segretoCronValido` sull'header `x-cron-secret`: 401 con log `secret-errato`.
- `const JOB = 'fatture-coda-tick'`; battito `logEvento('cron','info',{operazione: JOB, esito})` in **ogni** esito.
- Client service role; risponde `{ok:true, esito, emesse, errori, riprova}`.

## 3. API per l'interfaccia (contratto HTTP)

Schemi zod e tipi in **`src/lib/fatture-coda/api.ts`**. Tutte le route usano `withRoute` e `requireStaff`. Se la tabella è assente (PGRST205/42P01): le GET rispondono `{disponibile:false}`, le POST 503 `CODA_FATTURE_NON_DISPONIBILE`.

**`GET /api/pagamenti/fattura/coda`** → `{disponibile, stato, conteggi, stima_fine, voci}`
- `stato` = `{sospesa, sospesa_il, pausa_fino_a, pausa_motivo, ultimo_giro_il}`.
- `conteggi` = `{in_coda, in_invio, errore, emesse_7g, tolte_7g}`.
- `stima_fine`: ISO oppure null. Dalla consegna 2b (D3) `stimaFineCoda` simula i tick del cron (`MINUTI_TICK_CODA`, legati da un test alla migrazione) con le regole del giro: a ogni tick al più `TETTO_BLOCCO` fatture e i posti rimasti nel secchio delle 50/ora, contando le emesse dell'ultima ora e il momento in cui escono dalla finestra (`istantiEmesseUltimaOra`, `tetto-orario-aruba.ts`). Se le emesse non si possono misurare è `null`, come il giro, che senza misura non invia.
- `voci`: le attive più le concluse negli ultimi 7 giorni, al massimo 1000. Ogni voce: `{id, stato, urgente, accodata_il, esito_codice, esito_messaggio, scuola_id, scuola_nome, pagamento_id, alunno, descrizione, importo, creato_da_nome, posizione}`.
  - Tutte le sedi per tutto lo staff (decisione 6).
  - `esito_messaggio` è **null** se l'utente non ha la sede della voce (degli altri si vede solo il codice).
  - `posizione` è l'indice nell'ordine della coda, solo per `in_coda`.

**`POST /api/pagamenti/fattura/coda`**
- Corpo: `{voci: [{pagamento_id, intestatario?, conferma_proposta?, causale?}] (1..500), urgente?: boolean}`.
- `intestatario`: nel nucleo solo il ramo `adult`. Dalla consegna 2b (D1) anche `persona` (scritta a mano), ma **solo in un gesto di una voce** (`superRefine` su `zCorpoAccoda`): da un lotto non entra nessuna anagrafica digitata. La persona si controlla con `validaCessionario` **prima** di ogni lettura del DB: se è incompleta, 400 `INTESTATARIO_DIGITATO_INCOMPLETO` (log `warn` `intestatario-digitato-incompleto`, solo il conteggio) e non si accoda niente. Non esce dalla GET né dai log. Con la persona, `conferma_proposta` vuol dire «ricorda sulla scheda»: il nome del campo è storico.
- `assertPagamentoInScope` su **ogni** voce, e pagamento `pagato` (altrimenti 400 `PAGAMENTO_NON_SALDATO`).
- `rpc('fatture_coda_accoda', …)`, poi **sveglia**: `rpc('fatture_coda_tick_http')` senza attendere l'esito.
- Risposta `{gruppo_id, accodate, gia_in_coda}`.

**`POST /api/pagamenti/fattura/coda/azioni`**
- Corpo: `{azione: 'togli' | 'rimetti', ids: uuid[] (1..500)}` → `{aggiornate}`.
- Dopo «rimetti» parte la sveglia.
- Dalla consegna 2b (D2) i log di «Togli» e «Rimetti» portano l'attore (`utente`) e `distingui: ['operazione']`: senza, le due azioni avevano la stessa impronta e `app_log` ne teneva una riga sola al giorno. Una riga per utente, azione e giorno. «Sospendi/Riprendi» portava già l'attore.

**`POST /api/pagamenti/fattura/coda/sospensione`**
- Corpo: `{sospesa: boolean}`, **solo admin** (403 altrimenti).
- Alla ripresa parte la sveglia.

**Isolamento di sede**
- Le route che leggono la coda di tutte le sedi e il lavoratore hanno una voce motivata in `AMMESSE` di `isolamento-sede-coverage` (motivo: decisione 6 e utenza Aruba unica).
- Le scritture fanno lo scope per voce.

## 4. Interfaccia

**Pagina** `src/app/(dashboard)/admin/coda-fatture/page.tsx` con `src/components/features/admin/pagamenti/CodaFatturePanel.tsx`
- Polling di `GET /coda` ogni 20 s, **solo a scheda visibile**.
- Striscia di stato: sospesa, in pausa fino alle HH:MM, a domani alle HH:MM o a gg/mm alle HH:MM col giorno breve davanti, «ven 25/09» (Europe/Rome), oppure «l'invio continua anche a PC spento»; fine stimata nella stessa forma (consegna 2a).
- Contatori.
- Elenco con selezione multipla: «Togli» (su `in_coda` ed `errore`) e «Rimetti in coda» (su `errore`).
- Interruttore «Sospendi coda / Riprendi» visibile solo all'admin.
- Codici d'esito tradotti.

**Voce di menu** «Coda fatture» sotto Contabilità, con contatore delle voci attive (da `GET /coda`, campo `conteggi`).

**`LottoFatturePanel.tsx`**
- La fase di esecuzione con i blocchi pilotati dal browser **si sostituisce** con una sola `POST /coda` delle righe confermate (pagamento_id, intestatario adult, conferma).
- Fine: «N fatture messe in coda. Partono da sole, anche se chiudi la pagina o spegni il PC.», più il link alla pagina della coda e la segnalazione di quelle già in coda.
- `TETTO_LOTTO = 500`. Il test che lo lega a `SOGLIA_ORARIA_APP` si aggiorna: le due costanti ora sono indipendenti.

**`FatturaButton.tsx`** (emissione singola)
- Invece della POST diretta fa `POST /coda` con `urgente:true` e la causale scritta a mano, se c'è.
- Esito mostrato: «Messa in coda: parte entro pochi minuti».
- La route diretta `POST /api/pagamenti/fattura` **resta** (nessun 410 nel nucleo), ma l'interfaccia non la usa più.
- Consegna 2b (D1): il pulsante accoda **sempre**, anche con l'intestatario scritto a mano (nel nucleo quel ramo usava ancora la POST diretta). «Ricorda sulla scheda» viaggia come `conferma_proposta: true`, e la PATCH della scheda dal browser non c'è più: la scrive il lavoratore (`ricordaPersonaDigitata` in `esegui-blocco-fatture.ts`, che chiama `ricordaPersonaSullaScheda` di `intestatari.ts`) solo dopo un'emissione nuova riuscita e con l'attore del registro noto, leggendo prima il valore che sostituisce, e la riga del registro delle scritture porta quel valore, la sede e la classe del bambino. **Perimetro di sede**, lo stesso della PATCH (`assertAlunnoInScope`): scrive solo se la sede del bambino è fra quelle di chi ha accodato (`scuoleDiUtente`); se quelle sedi non si leggono (elenco vuoto) non scrive niente; fuori sede non tocca la scheda né il registro e logga il `warn` `intestatario-persona-fuori-sede`, e la fattura resta emessa (il gate del giro è la sede del **pagamento**, che dopo un trasferimento del bambino resta quella di partenza). Se la lettura o la scrittura falliscono, niente sulla scheda e un `warn` `intestatario-persona-non-salvato`; senza attore `intestatario-persona-non-ricordato-attore-ignoto`, su eccezione `intestatario-persona-non-ricordato` (fail-open); a scheda scritta `info` `intestatario-persona-salvato`. Con una voce attiva il pulsante sparisce; su «Errore in coda» al suo posto c'è il collegamento alla pagina «Coda fatture» (D5). `onEmessa` riceve `{ accodata: 'nuova' | 'gia' }` (D12).

**Chiavi i18n (le scrive SOLO il compito dell'interfaccia; gli altri usano questi nomi)**
- File: `messages/{it,en}/adminContabilita.json`, sotto `codaFatture`.
- Chiavi: `titolo`, `sottotitolo`, `stato.attiva`, `stato.sospesa`, `stato.pausa`, `stato.stimaFine`, `conteggi.inCoda`, `conteggi.inInvio`, `conteggi.errore`, `conteggi.emesse7g`, `azioni.togli`, `azioni.rimetti`, `azioni.sospendi`, `azioni.riprendi`, `lotto.messeInCoda`, `lotto.giaInCoda`, `lotto.vaiAllaCoda`, `singola.messaInCoda`, `esiti.<codice>` per ogni codice d'esito, `menu.codaFatture`.
- Apostrofo tipografico (’) nei testi inglesi: c'è un lock.

## 5. Salute, lock, PR

- `src/lib/health/controlli.ts`: controllo `coda-fatture` (§ Obiettivo). **JOB_CRON NON si tocca nella PR-A**: entra nella PR-B, dopo che la migrazione è applicata (decisione 26).
- Guardie di freschezza delle fotografie (`rls-per-sede`, `onconflict-arbitro`, eventuali altre) sulla migrazione nuova: si soddisfano col meccanismo previsto nel contratto, S21 / R2A-4.7 (dichiarazione delle migrazioni attese al merge con prova gemella). Mai spegnendo o allentando un lock.
- Gate: `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` (conteggio dei file) · `npm run build` · CI tutta verde.
- La migrazione la applica l'integrazione Supabase al merge. Mai a mano.
