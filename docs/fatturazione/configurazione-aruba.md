# Configurazione del collegamento ad Aruba — stato misurato

**Misurato il 2026-09-03.** Questo documento risponde a una domanda sola: *qual è, oggi, la
configurazione con cui questo software parla con Aruba, e dove si discosta da ciò che Aruba
documenta.* Non è una guida all'emissione (quella è
[`HANDOFF-aruba-2026-09-02.md`](HANDOFF-aruba-2026-09-02.md)) e non è il tracciato del documento
(quello è [`tracciato-di-riferimento.md`](tracciato-di-riferimento.md)).

**Ogni riga porta la sua fonte.** Nella colonna «cosa dice Aruba» il livello di certezza è:

| | |
|---|---|
| **A** | testuale dalla documentazione ufficiale (v1 1.21.0 · v2 2.2.0), citabile |
| **B** | da guide o manuali Aruba non-API (manuale «Utenza Premium») |
| **C** | inferenza nostra: **non** è una fonte, è un'ipotesi dichiarata |

Nella colonna «verificato come» c'è la riga di codice, la query o l'URL da cui viene il valore.
Dove non c'è, il valore **non è verificato** e la riga lo dice.

**In questo file non ci sono segreti**: né la password, né lo username Aruba, né la P.IVA della
cooperativa, né dati di famiglie. Solo nomi di variabili, conteggi, codici e numeri di riga.

---

## 0. Due versioni del codice, e vale la pena saperlo prima della tabella

Metà delle righe qui sotto hanno **due** valori, perché in questo momento esistono due versioni:

| | commit | dove |
|---|---|---|
| **Produzione** | `3eec8638` (punta di `origin/main`, PR #110); per `src/` è identico a `8bea8bfb`, ultimo commit su `client.ts` — `git diff --stat 8bea8bfb 3eec8638 -- src/` vuoto | deploy Production registrato su GitHub per `3eec8638`: stato `success`, 2026-09-02 21:37 UTC (deployment 6232374535), verificato con `gh api repos/erricoluigi17/kidville-web/deployments?sha=<sha>` e `…/deployments/<id>/statuses` |
| **Locale** | `HEAD` di `fix/aruba-prima-fattura`, contiene `0b3a4380` | **non pushato** |

Verificato con `git merge-base --is-ancestor 0b3a4380 origin/main` → **falso**, e
`git log --oneline -1 origin/main -- src/lib/aruba/client.ts` → `8bea8bfb`.

**Convenzione sui numeri di riga.** Tutti i numeri di riga di questo documento sono del branch
**locale** (`HEAD`, che per `src/lib/aruba/` coincide con `0b3a4380` — `git diff --stat 0b3a4380 HEAD
-- src/lib/aruba/` è vuoto; `emissione.ts` è **identico** nelle due versioni). Dove in produzione la
stessa cosa sta a un'altra riga, la riga di produzione è indicata **fra parentesi**.

La differenza non è cosmetica: **il ritmo delle chiamate e il ritentativo dopo un `429` esistono
solo in locale.** In produzione le sette richieste della lettura del progressivo partono una
dietro l'altra senza nessuna pausa, e un `429` non viene ritentato. Verificato:
`git show 8bea8bfb:src/lib/aruba/client.ts | grep -n "429\|setTimeout\|ritent"` → **nessuna
occorrenza**.

---

## 1. La tabella: voce → valore → cosa dice Aruba → verificato come → divergenze

È una tabella sola, divisa in sei blocchi perché a schermo ci stia.

### 1.1 Collegamento, ambiente, credenziali

| Voce | Valore in produzione | Cosa dice Aruba (fonte · livello) | Verificato come | Divergenze |
|---|---|---|---|---|
| Host **produzione** | `https://auth.fatturazioneelettronica.aruba.it` (auth) · `https://ws.fatturazioneelettronica.aruba.it` (metodi) | Identici. docs v1 §«Base url» e docs v2 (stessi host per la v2) · **A** | `src/lib/aruba/client.ts:88-93` | nessuna |
| Host **demo** | `https://demoauth.…` · `https://demows.…` | Identici · **A** | `client.ts:95-98` | nessuna. ⚠️ Le credenziali demo sono **un account separato**, che **non risulta** mai richiesto per questa utenza (**C**). Docs v1 §2 «Ambienti»: «ambiente con funzionalità equivalenti all'ambiente di produzione, ma accessibile solo temporaneamente, tramite uno specifico accreditamento» (**A**) — quindi **non esiste una sandbox utilizzabile** |
| Selettore d'ambiente | `ambiente = "production"` su tutte e 3 le sedi | — | `select aruba_config->>'ambiente' from admin_settings` → `production` × 3 (E2E: `null`) | Il codice accetta `production` **o** `produzione`; **qualunque altro valore, refusi compresi, ricade in silenzio su DEMO** (`client.ts:89`). Il pannello propone come default la parola `sandbox` (`src/app/api/admin/settings/aruba/route.ts:93`), che nel client non esiste: è un terzo vocabolario |
| `abilitato` | `true` su tutte e 3 le sedi | — | stessa query → `true` × 3 | nessuna. `false` ⇒ `motivo:'non_configurato'`, HTTP 503, log `error` (`emissione.ts:355-372`) |
| Username | in `admin_settings.aruba_config.username`, **uno solo per tutte e tre le sedi** | `username` obbligatorio su `findByUsername` e deve coincidere con quello del token · **A** | `select count(distinct aruba_config->>'username')` → **1** su 3 sedi | nessuna. Il valore **non si scrive qui**: `resolveArubaCredentials` legge `config.username \|\| ARUBA_USERNAME` (`client.ts:107`) |
| `password_ref` | la stringa **`ARUBA_PASSWORD`** — è il **nome di una variabile d'ambiente**, non una password | — | `select aruba_config->>'password_ref'` → `ARUBA_PASSWORD` × 3 | nessuna. `client.ts:108-109` risolve `process.env[password_ref]` con ripiego su `process.env.ARUBA_PASSWORD`: oggi i due coincidono, e se un giorno la chiave cambiasse va cambiato anche l'elenco in `src/lib/health/controlli.ts:359` |
| Autenticazione | `POST /auth/signin`, `grant_type=password`, corpo `x-www-form-urlencoded` | Identico · **A** | `client.ts:256-267` | nessuna |
| Abilitazione dell'utenza | non verificabile da qui | «I Web Services della Fatturazione Elettronica di Aruba sono a disposizione delle utenze Premium o utenze base a loro collegate mediante delega.» · **A** (docs v1 §1 «Introduzione») | — | **Non misurato**, ma **dimostrato per fatti**: il 2026-09-02 quattordici `findByUsername` hanno risposto `2xx` dalla produzione (vedi §1.4). Un'utenza non abilitata risponderebbe `403` |

### 1.2 Anagrafica fiscale e contenuto del documento

| Voce | Valore in produzione | Cosa dice Aruba (fonte · livello) | Verificato come | Divergenze |
|---|---|---|---|---|
| `iva[]` in `aruba_config` | **la chiave non esiste** su nessuna delle 3 sedi | — | `select aruba_config ? 'iva'` → `false` × 3 | **Nessuna, e non è una mancanza**: senza righe configurate `ivaEntry` è `undefined` (`emissione.ts:877-889`), il generatore applica il default `{aliquota: 0, natura: 'N4', riferimentoNormativo: 'Esente Art. 10 DPR 633/72'}` (`fatturapa-xml.ts:487`, costanti alle righe `76` e `96`) — che è **la stessa dicitura, lettera per lettera, delle fatture vere** misurate il 2026-08-10. Vedi §3.6 |
| Coerenza aliquota ↔ natura | verificata **tre volte**: all'ingresso del pannello, prima di consumare un numero, e nel generatore | Lo XSD **non** la vede; sono le regole di controllo SdI **00400** e **00401** (specifiche SdI, codificate in `fatturapa-xml.ts:461-481`; **non è nella doc Aruba**) | `admin/settings/aruba/route.ts:39-67` · `emissione.ts:890-915` · `fatturapa-xml.ts:461-481` | nessuna |
| `fiscal` (dentro `aruba_config`) vs `fiscale_config` | `fiscale_config` **completa** su tutte e 3 le sedi (10 chiavi, coi nomi esatti: `cap` (5), `codice_fiscale` (11), `comune`, `denominazione`, `email`, `indirizzo`, `numero_civico`, `piva` (11), `provincia` (2), `regime_fiscale`). `aruba_config.fiscal` esiste **solo su Giugliano** ed è **interamente vuoto** (`piva` = `''`, `regime` = `''`) | — | `jsonb_object_keys` su entrambe + `length()` sui campi | **Nessuna divergenza effettiva**: `cedenteDaConfig(fiscaleCfg, cfg.fiscal)` (`emissione.ts:410`) fa prevalere `fiscale_config`, e il ripiego di Giugliano è **inerte** perché vuoto. Il ripiego è **campo per campo**: `cedenteDaConfig` compone ogni campo con `primoNonVuoto(fiscale_config.X, fiscal.Y)` (`cedente.ts:407-429`), quindi `aruba_config.fiscal` viene letto **solo dove `fiscale_config` lascia il campo vuoto**. Con `fiscale_config` completa su tutte e tre le sedi, riempire `fiscal` **non cambierebbe nulla**; il ramo si accenderebbe soltanto se qualcuno **svuotasse** un campo di `fiscale_config` — ed è quello, non il contrario, il rischio da sorvegliare. `email` e `numero_civico` non hanno **nessun** ripiego (`cedente.ts:417`, `428`) |
| `regime_fiscale` | `RF01` su tutte e 3 | valore del tracciato, non di Aruba | `select fiscale_config->>'regime_fiscale'` → `RF01` × 3 | nessuna. Default codificato in `src/lib/fatturazione/cedente.ts:177` |
| **Un solo cedente per tre sedi** | 1 P.IVA, 1 codice fiscale, 1 denominazione, 1 comune per tutte e 3 le sedi | Il multi-cedente esiste per le utenze Premium · **B**; come l'API attribuisca la fattura al cedente **non è documentato** · **C** | `select count(distinct …)` su `fiscale_config` → **1** per ognuno dei quattro campi | nessuna, ed è la ragione per cui il multi-cedente **non è in gioco**. Ne segue che il contatore dei sezionali è **globale e non per sede** — la RPC `prossimo_numero_fattura_sezionale` ha chiave `(sezionale, anno)` e nessuna `scuola_id`, ed è coerente |
| `bollo_enabled` | **chiave assente** in `fiscale_config` su tutte e 3 le sedi ⇒ bollo **spento** | Le docs API **non citano** `DatiBollo`: passa nel tracciato standard. Aruba **non assolve** il bollo — «va versato tramite F24, anche se inserito in fattura» · **B** | `select fiscale_config ? 'bollo_enabled'` → `false` × 3 · `src/lib/pagamenti/fiscale.ts:96-101` (`if (!cfg?.bollo_enabled) return 0`) | **Nessuna, ed è la decisione del titolare**: niente blocco `<DatiBollo>` (`fatturapa-xml.ts:518-523`). Se un domani si accendesse, la soglia è 77,47 € e l'importo 2 € (`fiscale.ts:73-74`), e **il bollo non viene riaddebitato al cliente** (non esiste l'interruttore: `fiscale.ts:103-125`) |
| `IdTrasmittente` | `IT` + **`01879020517`**, cablato | «dovrà essere valorizzato con il codice fiscale dell'intermediario Aruba PEC S.p.A.: 01879020517» · **A** (docs v1 §7.1). Se non lo è, errore **0094**: «La fattura che stai inviando contiene ID e/o contatti dei trasmittenti differenti dai dati dell'intermediario Aruba PEC» · **A** (§7.6.1) | `fatturapa-xml.ts:75` (`ARUBA_PEC_PIVA`), scritto a `fatturapa-xml.ts:544-547` | nessuna |
| `senderPIVA` (parametro dell'upload) | **sempre inviato**, valorizzato con la P.IVA del cedente | «Nel caso in cui la fattura che si intende trasmettere abbia TD26 (…) come 2.1.1.1 TipoDocumento, il campo senderPIVA può essere utilizzato per specificare quale tra il cedente/prestatore e il cessionario/committente sia il mittente della fattura» · **A** (docs v1 §7.4) | `client.ts:321` ← `emissione.ts:1142` | **Divergenza d'uso, innocua ma reale**: i nostri documenti sono `TD01` (`fatturapa-xml.ts:582`), non `TD26`. Lo inviamo dove la doc non lo chiede. Misurato: gli upload non sono ancora stati provati, quindi **non sappiamo** se sia ignorato o rifiutato (**C**) |
| Firma (`credential` / `domain`) | **non inviati affatto** (le chiavi non compaiono nel corpo JSON) | «I parametri "domain" e "credential" rappresentano rispettivamente il dominio e le credenziali di firma automatica se possedute dall'utente, in caso contrario lasciare tali campi vuoti o ometterli.» · **A** (docs v1 §7.4, testo sotto l'esempio di richiesta) ⇒ omessi = firma di Aruba | `client.ts:319-323`: il corpo contiene solo `dataFile`, `senderPIVA`, `skipExtraSchema` | **nessuna: l'omissione è esplicitamente ammessa** dalla doc, alla lettera, accanto al «lasciare vuoti». L'alternativa per file già firmati è `/services/invoice/uploadSigned`, che **non usiamo** |
| `skipExtraSchema` | `false`, esplicito | «false di default. Se impostato a true non vengono effettuati i Controlli extraschema sincroni e i Controlli extraschema asincroni (…)» · **A** (docs v1 §7.4, tabella *Request fields*) | `client.ts:322` | nessuna: passiamo il default, cioè teniamo **accesi** i controlli extra-schema |

### 1.3 La lettura del progressivo: paginazione e ritmo

| Voce | Valore in produzione | Cosa dice Aruba (fonte · livello) | Verificato come | Divergenze |
|---|---|---|---|---|
| `PAGINA_SIZE` | **500** | «`size` — default 10, **compreso tra 1 e 100**» · **A** (docs v1 §8.2) | `client.ts:392` | 🔶 **DIVERGENZA APERTA**: chiediamo cinque volte il massimo documentato. **Misurato che funziona** (2026-09-02: 3.311 documenti letti in 7 pagine), ma è comportamento non documentato: Aruba può ricondurlo a 100 in qualunque momento, **senza errore**. Se rispondesse con 100 documenti a fronte dei 500 chiesti, `client.ts:763-766` (in produzione `649-652`) tratterebbe la pagina 1 come **ULTIMA** (`ricevuti < PAGINA_SIZE`) e ritornerebbe il massimo di quei 100 documenti, **senza nessun log**: il `warn esito:'pagine-troncate'` **non scatta**, perché scatta solo dopo 20 pagine **piene**. E se la serie chiesta non comparisse fra quei 100, il ripiego sull'anno precedente (`client.ts:791-796`, prod `671-673`) legge un'altra pagina sola e può ritornare **0**: la RPC allocherebbe il numero **1** su una serie viva. L'involucro Spring porta `size`, `totalElements`, `totalPages` e `last` (rapporto §4) e il codice **non ne legge nessuno**. Vedi §5 riga 5 |
| `PAGINE_MAX` | **20** (⇒ tetto 10.000 documenti/anno con `size` 500) | — | `client.ts:390` | nessuna. Superato il tetto si logga `warn esito:'pagine-troncate'` e si restituisce comunque un limite **inferiore** valido (`client.ts:767-778`, prod `653-665`) |
| `PAUSA_FRA_PAGINE_MS` | 🔴 **NON ESISTE IN PRODUZIONE**. In locale: `1_100` ms | «Nr. massimo richieste per IP al minuto: **ricerca fatture inviate 12**» · **A** (SLA §3) | `client.ts:413` (locale) · `git show 8bea8bfb:…` → assente | 🔴 **La divergenza più grave del documento.** In produzione 7 GET partono senza pausa. Anche con la pausa locale, 7 GET in ~6,6 s valgono ~64 richieste/minuto di **frequenza istantanea**: sopra le 12/min documentate. La pausa attenua, **non riporta dentro il limite**. Vedi §2 e §3.1 |
| `PAUSA_DOPO_429_MS` | 🔴 **NON ESISTE IN PRODUZIONE**. In locale: `90_000` ms | Nessun `Retry-After` né header `X-RateLimit-*` documentati. «il sistema non accoda né memorizza le richieste in eccesso. Qualsiasi chiamata eccedente la capacità massima viene rifiutata istantaneamente con un errore di superamento soglia (HTTP 429)» · **A** (Tiering §7.3.2); «La gestione della logica di rinvio (retry logic) è interamente a carico dell'integratore.» · **A** (§7.3) | `client.ts:415` (locale) | I 90 s sono **prudenza, non misura** — lo dice il commento stesso (`client.ts:406-411`). La finestra vera non è nota e non è stata cercata a tentativi, perché ogni sonda consuma quota |
| Ritentativo sulla **lettura** | 🔴 **nessuno in produzione**. In locale: **uno solo**, e solo su `429` | Il retry è a carico dell'integratore · **A** | `client.ts:611-634` (locale) | Il «uno solo» è deliberato: il limite punisce la frequenza, insistere peggiora. Se anche il secondo tentativo trova il muro si **lancia**, e chi emette si ferma senza consumare numeri |
| Ritentativo sull'**upload** | 🔴 **nessuno, in nessuna delle due versioni** | upload 30/min per IP · **A** | `client.ts:307-349`: nessun ciclo, nessuna attesa | 🔴 **Vedi §3.2**: un `429` sull'upload viene oggi scritto a registro come **scarto fiscale**, su una tabella WORM, con il numero già bruciato |
| Finestra temporale della ricerca | `startDate = <anno>-01-01`, `endDate = <anno>-12-31` | Le due date filtrano sulla data di **creazione in Aruba**, non sulla data della fattura · **A** | `client.ts:559-560` (prod `512-513`) | ⚠️ **Divergenza latente a cavallo d'anno**: una fattura datata dicembre ma **caricata** a gennaio cade fuori dalla finestra del suo anno. Il pavimento verrebbe letto più basso del vero. Non è mai stato misurato (**C**) |
| `vatcodeSender` | inviato (P.IVA del cedente) — `countrySender` **mai** | «`countrySender` / `vatcodeSender`: **obbligatori se l'utente è un'utenza Premium**» · **A** | `client.ts:562` (prod `515`) | 🔶 **Divergenza misurata come innocua**: mandiamo metà della coppia che la doc dà per obbligatoria, e il 2026-09-02 quattordici chiamate hanno risposto `2xx` (§1.4). O non è imposto, o non siamo classificati come Premium su quel controllo: **non lo sappiamo** (**C**) |
| Ripiego sull'anno precedente | se una serie risulta a **zero** nell'anno chiesto, si rilegge l'anno prima (**altre N pagine**) | — | `client.ts:791-796` (prod `671-673`) | nessuna. Con i progressivi 2026 già letti (>1000 su entrambe le serie, collaudo del 2026-09-03) **questo ramo non scatta** |

### 1.4 Token e sessione

| Voce | Valore in produzione | Cosa dice Aruba (fonte · livello) | Verificato come | Divergenze |
|---|---|---|---|---|
| Durata del token | si prende `expires_in`, con ripiego a **1700 s** se assente | `expires_in` = **1800** (30 minuti) · **A** | `client.ts:273` | nessuna. Il ripiego a 1700 è più prudente della durata vera |
| Uso di `expiresAt` | 🔴 **calcolato e mai letto** | — | `arubaSignin` ritorna `expiresAt` (`client.ts:273`), ma `emissione.ts:739` prende **solo** `.accessToken`; nessun altro punto lo interroga | Nessuna scadenza viene controllata. Su un lotto lungo più di 30 minuti il token scade **in corsa** e l'upload risponde `401`, che oggi finisce a registro come «Errore upload» (vedi §3.2) |
| Refresh | 🔴 **`arubaRefresh` esiste e non ha nessun chiamante** | Refresh sullo stesso endpoint con `grant_type=refresh_token`; il refresh token vale 60 min · **A** | `grep -rn "arubaRefresh" src __tests__ scripts docs` → **1 definizione** (`client.ts:278`) + **1 test**, zero usi | Vedi §5 |
| Un `signin` per invocazione | `tokenCache` è dichiarato **dentro** `emettiFatturaPagamento` ⇒ **ogni POST fa un signin nuovo** | «Nr. massimo richieste di autenticazione per IP: **1 al minuto**» · **A** (SLA §3) | `emissione.ts:737-741` | 🔴 **Due emissioni nello stesso minuto dallo stesso IP = il secondo `signin` va contro il limite.** E il punto in cui il signin avviene **cambia il danno**: vedi §3.3. ⚠️ Non siamo l'unico consumatore di quel limite: anche il cron `fatture-sdi-sync` fa un **proprio `signin`** a ogni tick con fatture in volo (`sync/route.ts:173`), con la **stessa utenza** — vedi §2.3 |
| Prova che l'utenza funziona | 2026-09-02, 14:56:07→14:56:31, **dalla produzione**: 2 `aruba:signin` e 14 `aruba:findByUsername`, **tutte a livello `info`** (cioè tutte `2xx`); gli unici 2 `error` sono `etichette-illeggibili` | — | `select … from app_log where evento='fattura'` (30 giorni) | Nessun `429` in quell'episodio. Il `429` misurato («8 accettate in 4,2 s, la nona no») veniva dalla **macchina locale**, cioè da un altro IP. Che i due comportamenti differiscano perché gli IP d'uscita di Vercel cambiano è **un'ipotesi** (**C**), non una misura |

### 1.5 Dopo l'invio: stati SdI e cron di sincronizzazione

| Voce | Valore in produzione | Cosa dice Aruba (fonte · livello) | Verificato come | Divergenze |
|---|---|---|---|---|
| Mappa degli stati | 1 Presa in carico · 2 Errore elaborazione · 3 Inviata · 4 Scartata · 5 Non consegnata · 6 Recapito impossibile · 7 Consegnata · 8 Accettata · 9 Rifiutata · 10 Decorrenza termini | Identici, uno per uno · **A** | `src/lib/aruba/stato.ts:21-32` | **Nessuna sui codici.** La *interpretazione* è nostra e va detta: `6`, `7`, `8`, `10` ⇒ `emessa`; `2`, `4`, `9` ⇒ `scartata`; `1`, `3`, `5` ⇒ `in_attesa`. Uno stato fuori tabella non rompe niente: resta `in_attesa` con etichetta «Stato sconosciuto (n)» (`stato.ts:34-43`) |
| Lettura dello stato | `GET /services/invoice/out/getByFilename`, con `includePdf=true`, `includeFile=false` | Parametro documentato: **`filename`** · **A** (docs v1 §8.3) | `client.ts:359-363` ← `sync/route.ts:188` | nessuna |
| Cron `fatture-sdi-sync` | pg_cron **job 3**, `*/30 * * * *`, **attivo** | — | `select … from cron.job where jobid=3` | nessuna |
| Il cron arriva davvero | **sì**: `336` esecuzioni `succeeded` in 7 giorni (7 × 48 = 336) **e** il battito applicativo in `app_log` — `fattura-sync: avviato` + `fattura-sync: ok` — con ultima occorrenza **2026-09-03 07:30 UTC** | — | `cron.job_run_details` + `app_log where evento='cron'` | ⚠️ `succeeded` di pg_cron **non basta a dire niente**: `fatture_sdi_sync_tick()` fa `net.http_post` in fire-and-forget dentro `EXCEPTION WHEN OTHERS THEN null`. È **il battito applicativo** a provare che la richiesta arriva e il segreto combacia. (I conteggi non coincidono — 336 contro 304 occorrenze — perché `app_log` deduplica per giorno e la prima giornata parziale cade fuori dalla finestra: differenza attesa, **non indagata**) |
| URL e segreto del cron | entrambi nel Vault, e l'URL ha **la forma attesa** (`…/api/pagamenti/fattura/sync`) | — | `select name, decrypted_secret ~ '^https://…/api/pagamenti/fattura/sync$' from vault.decrypted_secrets` → `true` | nessuna. Se l'URL fosse vuoto la funzione **uscirebbe in silenzio** (`fatture_sdi_sync_tick`), senza log: è il caso che il battito applicativo intercetta |
| Notifiche SdI | 🔴 `arubaGetNotifications` esiste e **non ha chiamanti** | Parametro documentato: **`invoiceFilename`** · **A** (docs v1 §11.2) | `client.ts:820-833` (prod `677` e seguenti) invia `filename` · `grep -rn` → 1 definizione + 1 test, zero usi | 🔶 **Divergenza dormiente**: il nome del parametro è **sbagliato**. Non fa danni finché nessuno chiama la funzione; il giorno che qualcuno la chiama non funzionerà, e non sarà ovvio perché. Vedi §5 |

### 1.6 Variabili d'ambiente (solo NOMI, mai valori)

| Nome | Dove serve | Se manca | Verificato come |
|---|---|---|---|
| `ARUBA_PASSWORD` | l'unica indispensabile: `client.ts:109` la risolve via `password_ref` | **Nessuna fattura parte.** È in `VARIABILI_CRITICHE` (`src/lib/health/controlli.ts:359`) e nel preflight d'avvio (`src/instrumentation.ts:82`): il preflight logga `error` **solo in produzione** e `warn` altrove (`instrumentation.ts:136`); il controllo `config` di `/api/health` risponde `degradato` e **non logga** (`controlli.ts:719`) — ma per questa variabile non risponde **affatto**, vedi il riquadro qui sotto | ✅ **presente su Vercel production**: elenco dei **nomi** delle variabili, misurato dall'orchestratore il 2026-09-03 (`regole-comuni.md`). ⚠️ **NON dimostrabile da `/api/health`**: quella sonda non legge questa variabile — vedi divergenza qui sotto |
| `ARUBA_USERNAME` | solo come **ripiego** di `aruba_config.username` (`client.ts:107`) | Niente: l'utenza è già in banca dati su tutte e 3 le sedi. Per questo **non** è in `VARIABILI_CRITICHE`, e la ragione è scritta accanto all'elenco (`controlli.ts:349-353`) | dichiarata in `docs/env.md:79`; **presente su Vercel production** (soli **nomi**, misurato dall'orchestratore il 2026-09-03 — `regole-comuni.md`), ma **non necessaria**: l'utenza sta in banca dati |
| `CRON_SECRET` | header `x-cron-secret` del sync (`sync/route.ts:65-85`) | Il sync risponde `401` e le fatture restano «in volo» per sempre | stessa sonda `/api/health` — e questa è **davvero** fra le variabili provate (`controlli.ts:707`) |

🔴 **Divergenza nel codice, non nella configurazione: la sonda dichiara di sorvegliare ciò che non
legge.** `/api/health` → `controlloConfig` (`src/lib/health/controlli.ts:712-723`) filtra
`valoriCritici()` (`controlli.ts:701-709`), che elenca **sei** variabili —
`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `RESEND_API_KEY`, `OTP_FROM_EMAIL`,
`CRON_SECRET`, `LOG_HASH_SALT` — e **non** `ARUBA_PASSWORD`. Ma il messaggio che stampa quando tutto
va bene è `` `${VARIABILI_CRITICHE.length} variabili presenti` `` (`controlli.ts:721`), cioè la
lunghezza di un **altro** elenco (quello di `controlli.ts:338-360`, che di variabili ne ha **7** e
`ARUBA_PASSWORD` ce l'ha): **«7 variabili presenti» viene scritto controllandone 6**. Se domani la
password Aruba sparisse da Vercel, la sonda risponderebbe `config: ok` con «7 variabili presenti», e
il primo a scoprirlo sarebbe chi preme «Fattura».

**E la suite resta verde.** Il lock di `__tests__/api/health.test.ts:587-599` confronta la copia di
`instrumentation.ts` con `VARIABILI_CRITICHE` — **non** con `valoriCritici()` — e il test successivo
(`:601-621`) pretende `ARUBA_PASSWORD` dentro `VARIABILI_CRITICHE`, dove c'è. Eseguito il
2026-09-03: `npx vitest run __tests__/api/health.test.ts` → **exit 0, 23 test su 23 verdi**, con la
deriva in piedi. È il caso che il commento del lock descrive da sé alle righe `588-592` («il giorno
in cui qualcuno aggiunge una variabile critica al preflight e non qui, l'endpoint di salute
smetterebbe in silenzio di sorvegliarla»): la deriva è avvenuta davvero, solo che è **fra le due
liste dentro `controlli.ts`**, dove nessun lock guarda. → task suggerito in §5, riga **6**.

*Il fatto misurato non cambia*: `ARUBA_PASSWORD` **è** presente in produzione — lo dice l'elenco dei
nomi delle variabili Vercel letto dall'orchestratore, non questa sonda.

🔶 **Divergenza nella documentazione, non nel codice**: `docs/env.md:79` dice che senza le variabili
Aruba la fatturazione va «in modalità **locale/simulata**». **Non è vero, e non lo è mai stato**: il
motore risponde `motivo:'non_configurato'` con HTTP **503** e non simula niente
(`emissione.ts:366-371`). Una frase che promette un ripiego inesistente manda chi indaga nel posto
sbagliato. → task suggerito in §3.7.

---

## 2. Quante richieste HTTP costa UNA emissione

Conteggio riga per riga, per **un pagamento a quota singola** (il caso di Aversa che si deve
emettere). Il comportamento descritto (**nessuna pausa, nessun ritentativo**) è quello di
**produzione**; le righe sono quelle **locali**, con l'equivalente di produzione fra parentesi.

### 2.1 Cache fredda — nessun pavimento in memoria

| # | Chiamata | Riga che la fa | Note |
|---|---|---|---|
| 1 | `POST /auth/signin` | `emissione.ts:749` → `emissione.ts:739` → `client.ts:263` | dentro il `try` della lettura ⇒ un errore qui **non consuma numeri** |
| 2…8 | `GET /services/invoice/out/findByUsername` × **7** | `emissione.ts:750` → `client.ts:807` (`arubaUltimoNumeroFattura`, involucro a una serie) → `client.ts:701` (`arubaUltimiNumeriFattura`; in produzione `client.ts:603`, dove `arubaUltimoNumeroFattura` fa il giro da sé) → ciclo `client.ts:752-780` (prod `641-666`) → `client.ts:565` (prod `518`) | 7 pagine perché i documenti del 2026 sono **3.311** e `size` = 500 (⌈3311/500⌉ = 7). In produzione **senza pausa fra una e l'altra** |
| 9 | `POST /services/invoice/upload` | `emissione.ts:1140` → `client.ts:313` | **fuori** da qualunque `try`, e **dopo** che il numero è stato allocato (`emissione.ts:1013-1041`) |

**Totale: 9 richieste**, in una sola invocazione della route `pagamenti/fattura:POST`.
Con **due quote** (genitori separati): 10 — il signin e la lettura si pagano una volta sola, gli
upload sono due.

Se la serie risultasse **vuota** nell'anno corrente si aggiungerebbero altre 7 GET per l'anno
precedente (`client.ts:794`, prod `673`): **non è il nostro caso** — il collaudo del 2026-09-03 ha
letto entrambe le serie 2026 con progressivi > 1000.

### 2.2 Cache calda — pavimento già in memoria

`TTL_ULTIMO_NUMERO_MS` = **5 minuti** (`emissione.ts:187`), su una `Map` a livello di modulo
(`emissione.ts:189`).

| # | Chiamata | Riga | Note |
|---|---|---|---|
| 1 | `POST /auth/signin` | `emissione.ts:1139` | ⚠️ **il signin si paga lo stesso**: `tokenCache` vive dentro la funzione, non fra invocazioni |
| 2 | `POST /services/invoice/upload` | `emissione.ts:1140` | |

**Totale: 2 richieste.** Ma «cache calda» qui significa *stessa istanza serverless, entro cinque
minuti*: su Vercel **non è garantito** che due clic consecutivi finiscano sulla stessa istanza. La
cache è un'ottimizzazione opportunistica, **non una garanzia** — e il conto da usare per pianificare
è quello a freddo.

### 2.3 Confronto con i limiti documentati

| Limite (SLA §3 · **A**) | Cosa facciamo | Sta dentro? |
|---|---|---|
| **autenticazione 1/min per IP** | 1 signin per emissione **+ 1 signin per ogni tick del cron** | ✅ per **una** emissione. 🔴 **No** per due emissioni nello stesso minuto dallo stesso IP. ⚠️ E il software non è l'unico a consumare quel limite: il cron `fatture-sdi-sync` fa un **proprio `signin` a ogni tick** appena esistono fatture in volo (`sync/route.ts:173`, con `STATI_IN_VOLO = [1, 3, 5]` a `sync/route.ts:22`), con la **stessa utenza**. Dopo la prima fattura, un «Emetti» premuto nello stesso minuto di un tick (:00 / :30) può incontrare il limite 1/min — e a cache calda è esattamente il percorso di §3.3, dove il signin avviene **dopo** l'allocazione del numero. **Oggi non blocca: 0 righe in volo** (`select count(*) from fatture_emesse where sdi_stato in (1,3,5)` → `0`) |
| **ricerca fatture inviate 12/min per IP** | 7 GET | 🔴 **No come frequenza.** In produzione, **misurato** il 2026-09-02 in `app_log` (§1.4): `signin` 14:56:07 → errore 14:56:14 e `signin` 14:56:25 → errore 14:56:31, cioè **7 GET in ~6 secondi per lettura** (≈ **70/min** istantanei). In produzione non c'è nessuna pausa (§0): quei sei secondi sono per intero il tempo di risposta delle richieste. Con la pausa locale di 1,1 s le sole attese fanno ~6,6 s (≈ 64/min). Il tetto è 12/min, cioè **una ogni 5 secondi** |
| **upload 30/min per IP** | 1 upload | ✅ in volume. ⚠️ Se i secchi fossero **condivisi**, l'upload è la **nona** richiesta della raffica — ed è esattamente il numero d'ordine su cui il 2026-09-02 è arrivato il `429` (**C**: che i secchi siano condivisi non è documentato) |
| **file max 5 MB** (→ 413) | XML di una retta: qualche kB | ✅ |
| **Tier 0: 60 upload/ora, 10.000/anno** (Tiering §7.3 · **A**) | 1 upload | ✅. ⚠️ Nota: il famoso «~60 richieste l'ora» è **questo** — il tier degli **upload**, non delle ricerche: il modello sbagliato applicato alla cosa sbagliata, ed è quello che ha fatto perdere tre ore. Ed è **ancora sparso ovunque**. Censito con `grep -rn -E "60 richieste\|richieste/ora\|60 chiamate\|richieste l.ora" src supabase docs scripts __tests__`: **cinque** occorrenze in `emissione.ts` (`26`, `158`, `925-926`, `969`, `972` — e la `972` è **il messaggio che legge la segreteria**); lo stesso modello sta nel `COMMENT` della RPC **applicato in produzione** (`supabase/migrations/20260809235620_fatture_numerazione_sezionale.sql:278`, e nei commenti `:31` e `:254`), in `scripts/aruba-campioni.mjs:70`, in `scripts/aruba-forma-elenco.mjs:47`, in tre intestazioni di test (`__tests__/lib/aruba/emissione-gate-numero.test.ts:17` e `:220`, `__tests__/api/fattura-emissione.test.ts:17`) e in `tracciato-di-riferimento.md:242`. Due occorrenze soltanto **lo smentiscono** invece di ripeterlo (`HANDOFF-aruba-2026-09-02.md:56` e `scripts/collaudo/numerazione-aruba.collaudo.ts:32`): chi bonificherà le altre parta da lì |

**La misura che conta più di tutte** (2026-09-02, macchina locale): **8 richieste accettate in 4,2
secondi, la nona `429`, con corpo HTML**. È compatibile con un secchio da ~8 gettoni che si ricarica
a 12/min. Con quel modello, la sequenza in produzione (1 signin + 7 GET in pochi secondi) **svuota il
secchio esattamente prima dell'upload**.

---

## 3. Cosa manca per emettere oggi

In ordine di quanto costa sbagliare. Le prime tre sono **la stessa famiglia**: cosa succede quando
Aruba dice di no *dopo* che il numero è stato allocato.

### 3.1 Il codice che mette il ritmo e ritenta non è in produzione 🔴

**Motivazione.** `PAUSA_FRA_PAGINE_MS`, `PAUSA_DOPO_429_MS` e `paginaConRitentativo` esistono solo
sul branch locale (`0b3a4380`). In produzione le 7 GET partono in raffica e un `429` **non viene
ritentato**: la lettura lancia, l'emissione si ferma con `motivo:'numerazione'` — che almeno **non
consuma numeri**, ma non emette. Verificato:
`git show 8bea8bfb:src/lib/aruba/client.ts | grep -n "429\|setTimeout\|ritent"` → nessuna occorrenza;
`git merge-base --is-ancestor 0b3a4380 origin/main` → falso.

**Task suggerito.** Portare il branch `fix/aruba-prima-fattura` in produzione (PR + merge) **prima**
di premere «Emetti». È già il piano; qui si dice **perché** non è opzionale.

**E non basta**, va detto: anche con la pausa a 1,1 s restiamo a ~64 richieste/minuto contro un
limite documentato di 12/min. Portarci davvero dentro vuol dire **5 secondi fra le pagine** = ~35 s
per la sola lettura, il che chiama in causa §3.5.

### 3.2 Un `429` (o un `401`) sull'upload viene scritto a registro come scarto fiscale 🔴

**Motivazione.** `arubaUpload` non ritenta mai (`client.ts:307-349`). Su una risposta non-2xx con
corpo HTML — che è **esattamente** la forma del `429` di Aruba — l'envelope non ha `errorCode`,
quindi `errorCode` diventa la stringa `'429'` e `errorDescription` diventa `HTTP 429: <html…>`
(`client.ts:327-338`). Il chiamante non distingue: `!up.ok` ⇒ `INSERT` in `fatture_emesse` con
`sdi_stato: 2`, etichetta «Errore upload» e il blob HTML dentro `sdi_scarto_motivo`
(`emissione.ts:1145-1148`). Quella tabella è **WORM**: il trigger `worm_fatture_emesse` vieta il
`DELETE` e il cambio di `numero`/`importo`/`xml_inviato` (verificato leggendo
`pg_get_functiondef` in produzione). Risultato: **un limite di frequenza diventa un rifiuto fiscale
permanente**, con un numero bruciato e una riga che la segreteria legge come «scartata». Stessa cosa
per un `401` da token scaduto (§1.4).

**Task suggerito.** Distinguere, prima dell'`INSERT`, un **rifiuto di trasporto** (`429`, `5xx`,
`401`, corpo non-JSON) da uno **scarto di merito** (envelope Aruba con `errorCode` fuori da `0000`):
sul primo **non** scrivere la riga di scarto, restituire `motivo:'numerazione'`-simile con l'invito
ad attendere, e — se si vuole — ritentare **una volta sola** dopo una pausa, con lo stesso criterio
già usato in lettura. Il numero resta comunque consumato: quello lo risolve solo un ordine diverso
delle operazioni, che non è lavoro di oggi.

### 3.3 `ensureToken()` e `arubaUpload()` stanno fuori da ogni `try`, con il numero già allocato 🔴

**Motivazione.** Alle righe `emissione.ts:1139-1143` non c'è `try`. Qualunque **eccezione** lì —
`arubaSignin` che prende `429` a cache calda, oppure `arubaUpload` che non riceve risposta (rete,
DNS, TLS, o il **timeout di 30 s** configurato per il provider `aruba` in
`src/lib/logging/external.ts:111`) — risale fino al `catch` della route, che risponde
**500 «Internal Server Error»** (`pagamenti/fattura/route.ts:100-103`). A quel punto: **il numero è
già stato allocato** (riga 1041), **nessuna riga è a registro**, e soprattutto **non si sa se la
fattura sia partita**: un timeout a 30 secondi non dice che Aruba non abbia ricevuto il file.

**Task suggerito.** Racchiudere le due chiamate in un `try/catch` che (a) logga `error` con
`esito:'upload-esito-ignoto'`, (b) scriva a registro una riga in stato **incerto** — non «scartata»,
che è un'affermazione falsa — così che il sync o una persona possano andare a vedere su Aruba con il
`progressivo_invio`, (c) restituisca alla segreteria un messaggio che dice *«non sappiamo se è
partita: non ripremere, controlla»*. È il caso più velenoso dell'intero percorso e oggi non ha
nessuna rete.

### 3.4 Lo sconto sul pagamento — **risulta già chiuso**, da riverificare all'ultimo minuto ✅

**Motivazione.** Il file delle regole di sessione (`regole-comuni.md`, aggiornato il 2026-09-03 alle
**09:37**) registra: sconto residuo di 30 «SCONTO FRATELLI» **azzerato dall'orchestratore il
2026-09-03 alle 09:35**, unica scrittura della giornata. **Misurato con `SELECT`**: `sconto = 0`,
`importo = 300`, `importo_pagato = 300`, `stato = 'pagato'`, `fattura_stato = 'scartata'`, `0` righe
in `fatture_emesse` (e `fatture_emesse` / `fatture_numerazione_sezionale` **vuote in totale**).
Quindi la voce risulta **già chiusa**.

**Task suggerito.** Rileggere la riga **subito prima** di premere «Emetti» (è una `SELECT`, non
chiede conferma a nessuno). Nota per chi guarderà lo schermo: `fattura_stato` vale `'scartata'`
mentre a registro **non c'è nessuna riga** — è l'aggregato scritto dal tentativo fallito del
2026-09-02 (`emissione.ts:1260-1265`). Non blocca: il pulsante mostra «Riprova» e chiama la stessa
route (`FatturaButton.tsx:109`).

### 3.5 La route non dichiara un `maxDuration` 🔶

**Motivazione.** In tutto il repository esiste **un solo** `maxDuration`, ed è sull'import massivo
(`src/app/api/iscrizione/import-massivo/route.ts:136`), con accanto la spiegazione del perché non si
eredita un numero che nessuno ha scelto. `pagamenti/fattura:POST` non ce l'ha. Con il branch locale
il giro può durare **6 pause da 1,1 s** (la prima richiesta non aspetta, `client.ts:714-717`) + le
risposte + **90 secondi** di attesa dopo un `429`: oltre i cento secondi. Se il tetto di piattaforma
fosse più basso, la funzione verrebbe **troncata**, e il punto in cui viene troncata decide se il
danno è nullo (durante la lettura) o è §3.3 (dopo l'upload).

**Task suggerito.** Dichiarare `export const maxDuration` sulla route, scegliendo il numero **dopo**
aver deciso il ritmo di §3.1 — i due valori sono lo stesso problema visto da due lati.

### 3.6 Ciò che *sembra* mancare e invece non manca

Vale la pena scriverlo, perché sono le voci su cui è più facile «sistemare» qualcosa che è già
giusto:

- **La chiave `iva` in `aruba_config` non c'è, e va bene così.** Senza righe configurate il
  generatore usa `0% / N4 / «Esente Art. 10 DPR 633/72»` (`fatturapa-xml.ts:487`), che è la dicitura
  **misurata sulle fatture vere** il 2026-08-10, lettera per lettera (maiuscola su `Art.`, anno a due
  cifre). Aggiungere una riga `iva` a mano oggi significherebbe **cambiare il regime IVA** del
  documento: si farebbe solo su indicazione del commercialista, e comunque il pannello rifiuta le
  due combinazioni che lo SdI scarta (00400/00401).
- **`aruba_config.fiscal` assente su Aversa e Cesa non è una configurazione incompleta**:
  l'anagrafica del cedente si legge da `fiscale_config`, che è completa su tutte e tre. Il `fiscal`
  di Giugliano esiste ed è **vuoto**, quindi inerte.
- **`bollo_enabled` assente = bollo spento**, che è la decisione presa. Nessun blocco `<DatiBollo>`
  finisce nel documento.
- **`credential` e `domain` omessi = firma automatica di Aruba** (omissione ammessa dalla doc v1
  §7.4), ed è ciò che vogliamo.
- **`ARUBA_USERNAME` è presente in produzione**, ma anche se mancasse non sarebbe un problema:
  l'utenza sta in banca dati (`client.ts:107`).
- **Il cron di sincronizzazione è configurato, attivo e arriva davvero** (battito dell'ultima mezz'ora).

### 3.7 Una riga di documentazione che dice il falso 🔶

`docs/env.md:79` promette una «modalità locale/simulata» che non esiste (vedi §1.6). **Task
suggerito**: correggere la riga in «Assenti → l'emissione risponde 503 `non_configurato` e nessuna
fattura parte». Non è urgente per emettere, ed è precisamente il genere di frase che, lasciata lì,
un giorno fa cercare un ripiego inesistente mentre la fattura non parte.

---

## 4. `dryRun`: verificato testualmente, e **non si usa**

**La domanda**: l'upload della **v1** documenta un parametro `dryRun` che valida senza inviare allo
SdI?

**La risposta, misurata il 2026-09-03 interrogando la pagina ufficiale**
(`https://fatturazioneelettronica.aruba.it/apidoc/docs.html`, versione dichiarata **1.21.0**):

> **ASSENTE.** La stringa `dryRun` (e le varianti `dry run`, `dry-run`) **non compare in alcun punto
> della pagina** — indice, tabelle dei parametri, campi di risposta, changelog, esempi JSON.

I parametri che la v1 documenta davvero per `POST /services/invoice/upload` sono **cinque**:
`dataFile` (obbligatorio), `credential`, `domain`, `senderPIVA`, `skipExtraSchema`.

**Nella v2 invece esiste**, ed è citato alla lettera (docs v2, versione dichiarata **2.2.0**, §7.4):

> «*false* di default. Se impostato a 'true' la fattura attraverserà le fasi di validazione ma non
> verrà inviata a SdI»

🔴 **E qui sta il motivo per cui NON si usa oggi.** L'endpoint di upload della v2 sta sullo **stesso
host e sullo stesso path** di quello che chiamiamo noi — `https://ws.fatturazioneelettronica.aruba.it/services/invoice/upload`
(verificato chiedendo alla pagina v2 gli URL base e il path dell'upload). Quindi mandare
`dryRun: true` a quella URL ha **due esiti possibili e indistinguibili dalla risposta**:

1. il parametro viene onorato → la fattura è validata e **non** inviata;
2. il parametro viene **ignorato in silenzio** → **parte una fattura vera**, con un numero vero, su
   una serie fiscale viva, e ce ne accorgiamo solo dallo SdI.

Un parametro non documentato che, se ignorato, emette un documento fiscale **fuori registro** non è
un dispositivo di sicurezza: è una scommessa. **Non si usa.** Resta una **miglioria futura**, e la
strada per renderla usabile è misurarla, non dedurla: se un giorno si passerà davvero alla v2, si
verificherà che la risposta a `dryRun: true` **non** contenga un `uploadFileName` — che è l'unica
prova osservabile che nulla è stato trasmesso.

---

## 5. Migliorie future, non oggi

Nessuna di queste è necessaria per emettere la prima fattura. Sono elencate perché **esistono già a
metà** nel codice, e mezzo meccanismo è più insidioso di nessun meccanismo.

| | Cosa | Stato oggi | Perché non oggi |
|---|---|---|---|
| **1** | **Refresh del token** | `arubaRefresh` c'è (`client.ts:278`) e **nessuno la chiama**; `expiresAt` è calcolato e **mai letto** | Serve ai lotti che superano i 30 minuti. Per **una** fattura il token nasce e muore nella stessa invocazione. ⚠️ Il refresh passa dallo **stesso endpoint** del signin, quindi con ogni probabilità paga lo **stesso limite 1/min** (**C**): implementarlo senza misurarlo potrebbe **peggiorare** il problema di §3.1 |
| **2** | **Notifiche SdI** (`arubaGetNotifications`) | Esiste, **zero chiamanti**, e manda il parametro **`filename`** dove la doc chiede **`invoiceFilename`** (§1.5) | Oggi lo stato si legge da `getByFilename`, che basta. Le notifiche darebbero il **motivo** di uno scarto (`NS`) invece della sola etichetta. Chi la riprenderà **corregga prima il nome del parametro**: il difetto è già lì, silenzioso, e il primo che la chiami penserà che sia Aruba a non rispondere |
| **3** | **Utente `Ws` dedicato** | Oggi tutte e tre le sedi usano **la stessa utenza**, che è quella del pannello web | Il manuale Premium §6.2 prevede utenti aggiuntivi di tipo Web o **Ws** con username e password propri e il permesso «Web Service ciclo attivo» (**B**). Un'utenza dedicata separerebbe le chiamate del software da quelle della segreteria — che oggi **condividono lo stesso limite**, ed è una delle spiegazioni possibili di un `429` inatteso. Richiede un'operazione sul pannello Aruba, non sul codice |
| **4** | **Callback / PUSH** | non usata, non configurata | Aruba può notificare i cambi di stato invece di farsi interrogare: sostituirebbe il cron ogni 30 minuti. La «Api Key / OAuth 2» delle guide riguarda **solo** questa callback in uscita, **non** l'autenticazione delle API (**A/B**) — e vale la pena averlo scritto, perché il nome trae in inganno |
| **5** | **`size` 500 contro i 100 documentati** | Funziona (misurato: 3.311 documenti in 7 pagine), ma è fuori dalla doc (§1.3) | Non si tocca **adesso**: scendere a 100 quintuplicherebbe le richieste dentro un limite di frequenza, cioè peggiorerebbe §3.1 per rispettare una regola che oggi nessuno applica. Va **sorvegliato**, e senza illudersi che esista una rete: se Aruba riconducesse `size` a 100 senza dirlo, `client.ts:763-766` (prod `649-652`) leggerebbe `ricevuti < PAGINA_SIZE` e tratterebbe la pagina 1 come **ULTIMA**, restituendo il massimo di quei soli 100 documenti **senza nessun log**. Il `warn esito:'pagine-troncate'` (`client.ts:772-778`, prod `658-664`) **non scatterebbe**, perché scatta solo dopo 20 pagine **piene**. E se la serie chiesta non fosse fra quei 100, il ripiego sull'anno precedente (`client.ts:791-796`, prod `671-673`) leggerebbe un'altra pagina sola e potrebbe tornare **0**: la RPC allocherebbe il numero **1** su una serie viva. **Task suggerito (futuro, non oggi)**: confrontare `size` dell'involucro con `PAGINA_SIZE` — o usare `last` / `totalElements`, che oggi il codice **non legge** — e **lanciare** se non coincidono, con lo stesso criterio delle etichette illeggibili |
| **6** | **Sonda `/api/health` cieca su `ARUBA_PASSWORD`** | `controlloConfig` prova le **6** variabili di `valoriCritici()` (`controlli.ts:701-709`) e stampa `VARIABILI_CRITICHE.length` = **7** (`controlli.ts:721`): dichiara di sorvegliare la password Aruba e non la legge (§1.6). Nessun test se ne accorge — il lock confronta `instrumentation.ts` con `VARIABILI_CRITICHE`, mai con `valoriCritici()` (`__tests__/api/health.test.ts:587-599`) | Non serve per emettere: la variabile **c'è**, misurata sull'elenco dei nomi di Vercel. E non è codice di oggi: mettere le mani nella sonda di salute mentre si prepara la prima fattura aggiunge rischio senza toglierne. **Task suggerito (futuro)**: far derivare `valoriCritici()` da `VARIABILI_CRITICHE`, oppure aggiungere `['ARUBA_PASSWORD', process.env.ARUBA_PASSWORD]` con **accesso statico** a `process.env` (l'accesso dinamico non sopravvive al bundler) — e, prima della correzione, **un test che con la sola `ARUBA_PASSWORD` assente pretenda `degradato`**: è il test che oggi manca, ed è l'unico modo di vedere questo difetto diventare rosso |

---

## 6. Le fonti, in chiaro

**Documentazione ufficiale** (interrogata il 2026-09-03):
`https://fatturazioneelettronica.aruba.it/apidoc/docs.html` (v1, **1.21.0**) ·
`https://fatturazioneelettronica.aruba.it/apidoc/v2/docs.html` (v2, **2.2.0**) ·
manuale «Gestione e utilizzo utenza Premium» v1.23 (**B**).
Il rapporto della ricerca documentale **non è nel repository**; ogni citazione riportata qui è stata
riverificata sulle pagine ufficiali il 2026-09-03. (Quel rapporto indicava la v2 come 2.5.0: la
pagina dichiara **2.2.0**, ed è il numero usato in questo documento.)

**Produzione** (sole `SELECT`, il 2026-09-03): `admin_settings` (3 sedi + E2E) · `cron.job` e
`cron.job_run_details` · `vault.decrypted_secrets` (solo *presenza* e *forma*, mai i valori) ·
`app_log` (`evento='fattura'` a 30 giorni, `evento='cron'` a 7) · `pagamenti` (una riga) ·
`fatture_emesse` e `fatture_numerazione_sezionale` (soli `count(*)`) ·
`pg_get_functiondef` di `fatture_sdi_sync_tick`, `cron_config`,
`prossimo_numero_fattura_sezionale`, `worm_fatture_emesse`.

**Sonda pubblica**: `GET https://app.kidville.it/api/health` → `config` **ok**. ⚠️ Il messaggio dice
«7 variabili presenti», ma le variabili davvero provate sono le **6** di `valoriCritici()`
(`controlli.ts:701-709`), e `ARUBA_PASSWORD` **non è fra quelle** (§1.6). La presenza delle variabili
Aruba in produzione viene dall'elenco dei **nomi** su Vercel letto dall'orchestratore il 2026-09-03
(`regole-comuni.md`), non da questa sonda.

**Suite di test** (eseguita il 2026-09-03, sola lettura sul codice):
`npx vitest run __tests__/api/health.test.ts` → **exit 0, 23/23 verdi** — che è la prova del difetto
di §1.6, non della sua assenza.

**GitHub** (sole letture, il 2026-09-03): `gh api repos/erricoluigi17/kidville-web/deployments?sha=…`
e `…/deployments/<id>/statuses`, per stabilire **quale commit** sia davvero in produzione (§0).

**Codice**: `src/lib/aruba/{client,emissione,fatturapa-xml,stato}.ts` ·
`src/lib/fatturazione/{sezionale,cedente}.ts` · `src/lib/pagamenti/fiscale.ts` ·
`src/app/api/pagamenti/fattura/{route,sync/route}.ts` · `src/app/api/admin/settings/aruba/route.ts` ·
`src/lib/logging/external.ts` · `src/lib/health/controlli.ts` · `src/instrumentation.ts` ·
`src/components/features/admin/pagamenti/FatturaButton.tsx`.

**Nessuna chiamata ad Aruba è stata fatta per scrivere questo documento**: né signin, né
`findByUsername`, né upload. Tutto ciò che riguarda il comportamento in presa diretta viene da
misure **già registrate** in `app_log`, dai file del repository e dalla documentazione ufficiale.
