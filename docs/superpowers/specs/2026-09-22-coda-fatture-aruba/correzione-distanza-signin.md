# Coda fatture Aruba — correzione urgente del 24/09: 65 s fra due accessi ad Aruba (e «Inviata»)

Piano esecutivo **unico** di una correzione urgente, non di una consegna. L'ha scritto un solo autore, prima
degli esecutori in parallelo (lezione 1 di `HANDOFF.md`). Prevale sui due rapporti di lettura del 24/09
(«signin» e «sync»), da cui nasce e che §0 ha ricontrollato con letture proprie. Il modello è
`consegna-2b-rifiniture.md`, in forma corta.

- Richiesta del titolare: «correggi tutto e poi vai avanti fino al deploy». Il 24/09 la coda (nucleo #160,
  2a #162, 2b #163, tutte in produzione) ha lavorato per la prima volta con fatture vere e ha mostrato un
  difetto urgente: **un'ora di coda ferma per tutte le sedi**. L'obiettivo è la PR entro un'ora.
- Branch `fix/coda-fatture-distanza-signin`, da `main` `02eb9836` (#163). **I numeri di riga sono di
  `02eb9836`**: chi esegue li ricontrolla e modifica per **stringa**, mai per numero.
- Il codice compare solo dove una parola sbagliata cambia il comportamento: SQL completo, frammenti del giro,
  test. Il resto è indicato per file e stringa.

---

## 0. Fatti misurati (solo letture, 24/09/2026 fra le 11:20 e le 11:45, ora di Roma)

In DB gli orari sono UTC (−2 h): qui sono tutti convertiti a Roma.

| Cosa | Valore | Come |
|---|---|---|
| Le prime fatture vere della coda | **15 voci**, tutte `emessa`. Gruppo 1: lotto di 4 voci, accodato alle 09:56:42, preso alle 09:56:43, emesso fra le 09:57:02 e le 09:57:31. Gruppo 2: pulsante, urgente, accodato alle 10:09:13, preso alle 10:09:15, emesso alle 10:09:56. Gruppi 3–11: accodati fra le 10:09:49 e le 10:37:35 (3–7 urgenti, dai pulsanti; 8–11 non urgenti; 10 voci), **presi tutti alle 11:12:00** ed emessi fra le 11:12:19 e le 11:13:21. La voce del gruppo 3 ha `tentativi` 2 | `fatture_coda`, solo colonne non personali (stato, codici, orari, `tentativi`) |
| Il 429 | `app_log`: `giro-concluso` del gruppo 2 alle 10:09:56,533. Alle 10:09:59,545 `aruba:signin` **error con `stato_http` 429** (route `/api/pagamenti/fattura/coda/giro`) e, nello stesso millisecondo, `numerazione-non-allineabile-asilo` col messaggio «Aruba signin fallita (HTTP 429): (nessun corpo nella risposta)». Seguono `voce-aruba_429` (warn) alle 10:09:59,664 e `giro-concluso` alle 10:09:59,787 | `app_log`, campi non personali |
| La distanza fra i due accessi | I `signin` 200 del giro sono 3 (primo alle 09:56:46,3, ultimo alle 11:12:03,6). Quello del gruppo 2 sta in mezzo, ma la deduplica per giorno non ne tiene l'ora. Fra presa e `signin` si misura 3,3 s (09:56:43 → 09:56:46,3) e 3,6 s (11:12:00 → 11:12:03,6), quindi il `signin` del gruppo 2 cade verso le 10:09:18–19 e il 429 arriva **circa 41 s dopo**. Il secondo giro ha preso il testimone subito dopo il rilascio del primo (10:09:56,5) | ricostruita |
| La pausa | `fatture_coda_stato`: `pausa_fino_a` 11:09:59, `pausa_motivo` `aruba-429`, nessun lavoratore, `ultimo_giro_il` 11:27:00 (un giro a vuoto del cron). Tutte le sveglie delle 10:10–10:37 e i tick del cron hanno trovato la coda in pausa; alle 10:32:59 `finestra-sync` (la sveglia dell'accodamento delle 10:32:58). Il primo tick dopo la pausa, alle 11:12, ha preso le 10 voci | lettura alle 11:31; battito `fatture-coda-tick` (`niente-da-fare` 101 volte oggi) |
| Cron | `fatture-coda-tick` `7,12,17,22,27,37,42,47,52,57 * * * *`. `fatture-sdi-sync` gira ogni trenta minuti, ai minuti **0 e 30**: il commento di `giro.ts:173` dice «2 e 32», e sbaglia | `cron.job` |
| I `signin` della sync | route `/api/pagamenti/fattura/sync`, 4 occorrenze, dalle 10:00:04,4 alle 11:30:03,7 | `app_log` |
| «Inviata» fuori tabella | error `stato-non-interpretato`, «Aruba getByFilename: dicitura di stato fuori tabella «Inviata»», sempre dalla route della sync. Per giorno: 11/09 21, 15/09 216, 16/09 730, 17/09 370, 18/09 4, 21/09 23, 24/09 16 (dalle 10:00:05 alle 11:31:02). Totale **1.380**. Nessun'altra parola è mai stata registrata | `app_log`, `messaggio ilike '%fuori tabella%'` |
| `fatture_emesse` di oggi | 5 a `sdi_stato` 6 («Recapito impossibile (depositata) — Aruba: «Non consegnata»»); 10 a `sdi_stato` **0** «Stato sconosciuto (0) — Aruba: «Inviata»» | `group by sdi_stato, sdi_stato_label` |
| Funzioni in produzione, prima della correzione | `fatture_coda_prendi`: md5 `e06cffa49bb3f21f681f93116db95f57`, 2052 caratteri. `fatture_coda_rilascia`: `9cfa221d9276202904f79fb08a47c0a2`, 918. Sono i corpi del nucleo. `fatture_coda_chiudi`: `4869df98d72fe9c07cc4f296cb469fb2`, 2765, uguale al file della 2b | `pg_proc` confrontato col corpo `AS $$ … $$` dei file |
| Migrazioni | l'ultima applicata è `20260924010455_fatture_coda_chiudi_emessa_azzera_messaggio` | `supabase_migrations.schema_migrations` |
| La 2b | PR #163, merge alle 06:38:05 (`02eb9836`); deploy `6630315575` `success` alle 06:39:58. Il run «DB migrate (prod)» `35956482220` è **waiting**: non si approva. I 13 `gallery.published` sono stati inviati alle 06:43: 0 non inviati, 0 in quarantena | `gh pr view`, `gh api …/deployments/…/statuses`, `gh run list`, `video_outbox` |
| File di test | **1442** | `find` con le esclusioni di `vitest.config.ts:22` |
| Base verde | le tre verifiche mirate di §3 (11 + 4 + 6 = 21 file) verdi a `02eb9836` | `npx vitest run` mirato |
| Albero | pulito, su `fix/coda-fatture-distanza-signin` | `git status` |

---

## 1. Causa e decisioni

### 1.1 La causa del 429

Il lavoratore unico (advisory lock più testimone in `fatture_coda_prendi`) impedisce che due giri lavorino
**insieme**. Non impone però nessuna **distanza** fra un giro e il successivo.

Ogni giro è un'invocazione Vercel nuova (cron o sveglia via pg_net):
1. `eseguiBloccoFatture` crea una sessione vuota (`esegui-blocco-fatture.ts:148`, `creaSessioneAruba()`).
2. Il `signin` parte con la prima emissione che supera i nostri controlli (`ensureToken()`,
   `emissione.ts:2099`).

Quindi **un giro = un `signin`**, e Aruba ne concede uno al minuto per IP.

La sveglia parte a ogni accodamento riuscito (`coda/route.ts:430`), dopo «Rimetti» (`azioni/route.ts:147`) e
alla ripresa (`sospensione/route.ts:60`). Il 24/09 il secondo pulsante è arrivato mentre il primo giro
finiva. Il suo giro ha preso il testimone appena liberato e ha fatto il `signin` una quarantina di secondi
dopo il precedente. Aruba ha risposto 429 proprio sul `signin`, `classificaEsito` l'ha letto come «429
prima del numero» (`giro.ts:213`), e il giro ha chiesto la pausa di 60 minuti.

### 1.2 La causa di «stato-non-interpretato» (sync SdI): certa, quindi dentro

Il difetto non è della coda e non è nato il 24/09. `arubaGetByFilename` legge la dicitura italiana di
`invoices[0].status` e la traduce con `DICITURA_A_CODICE` (`src/lib/aruba/stato.ts:125-132`).

La mappa ha solo le tre diciture **terminali** del campione dell'11/09: 4.000 documenti, tutti già conclusi.
Il primo stato che Aruba dà dopo l'upload è «Inviata», lo stato **in volo**. Non è in mappa, quindi diventa
codice 0, `error` in `app_log` ed etichetta «Stato sconosciuto (0)» a registro.

La riga resta comunque in coda, perché lo 0 sta in `STATI_IN_VOLO` (`sync/route.ts:49`), e al giro dopo
diventa 6 o 4. La tabella numerica ha già la voce giusta: 3 «Inviata allo SDI», `in_attesa`, non terminale,
non scarto. La si aspettava anche `docs/fatturazione/HANDOFF-aruba-2026-09-02.md:254`. È un caso solo
(sempre e solo «Inviata», 1.380 volte) e la correzione è di una riga.

Non c'entra col 429: la sync non girava alle 10:09 e il suo `signin` è un altro.

### 1.3 Decisioni tecniche

| # | Decisione | Perché |
|---|---|---|
| C1 | Colonna nuova `fatture_coda_stato.ultimo_accesso_il timestamptz` (può essere nulla) | `ultimo_giro_il` non si può riusare. `prendi` la scrive a ogni presa del testimone, anche a vuoto e prima di qualunque `signin`: i giri a vuoto del cron la sposterebbero ogni 5 minuti e ritarderebbero le sveglie. In più è il «segno di vita» della GET e del pannello (`coda/route.ts:75`, `:218`) |
| C2 | Il controllo sta **in `fatture_coda_prendi`**, sotto `pg_advisory_xact_lock` e la `FOR UPDATE` della riga 1, dopo sospesa, pausa e lavoratore. Rifiuta se `ultimo_accesso_il > now() - interval '65 seconds'`. Il rifiuto è come quello della pausa: niente testimone, niente `ultimo_giro_il`, nessuna voce toccata | È il solo punto atomico da cui passano tutti i giri. Un controllo solo nel codice (leggi, aspetta, prendi) lascerebbe passare due giri che leggono nello stesso istante. 65 = 60 più margine |
| C3 | **Due timbri.** `prendi` timbra quando consegna almeno una voce. `rilascia` timbra alla FINE del giro, per un token che aveva voci (`EXISTS … lavoratore_token = p_token`), con `GREATEST`: vale anche col testimone già scaduto, come la pausa, e non torna mai indietro. Un giro a vuoto non timbra | Un giro fa il `signin` solo mentre tiene il testimone, quindi B.presa ≥ A.rilascio + 65 s ≥ A.`signin` + 65 s. Il timbro alla presa da solo non basta: il `signin` arriva dopo le voci respinte dai controlli locali (fino a 14 × 2,5 s di `PAUSA_FRA_UPLOAD_MS`). Quello al rilascio da solo non basta se «Rimetti» ha tolto il token a tutte le voci del giro prima del rilascio. `chiudi` non azzera il token (nucleo `:437-470`, 2b), lo toglie solo `rimetti` (`:626`) |
| C4 | Nel giro, **dopo la finestra e prima del bidello**, si legge `ultimo_accesso_il`. Se l'unico ostacolo è la distanza, il giro **aspetta** il residuo più 1 s (al massimo `ATTESA_MASSIMA_MS` = 66 s), poi ricontrolla la finestra. Con un altro lavoratore attivo, una pausa o la coda sospesa non aspetta, perché `prendi` rifiuterebbe comunque. Bidello, tetto orario e `prendi` usano l'istante di DOPO l'attesa | Senza attesa, la sveglia che arriva subito dopo un giro troverebbe `prendi` chiuso, e il pulsante «urgente» aspetterebbe il cron: fino a 5 minuti, 10 a cavallo della sync. Il budget si conta dall'inizio dell'invocazione (`inizioMs: inizio`, `giro.ts:438`), quindi il muro dei 300 s resta. 66 s di attesa più 155 s di `RISERVA_PEGGIORE_MS` stanno sotto i 290 s di `BUDGET_BLOCCO_MS`: dopo l'attesa più lunga resta posto per una fattura, e lo tiene un lock (G6) |
| C5 | Se la lettura fallisce (`42703` prima della migrazione, il DB E2E), non si aspetta e si scrive un `warn` `accesso-non-letto` | Il codice può arrivare prima della migrazione, e in quel caso si torna al comportamento di ieri. La garanzia vera sta comunque in `prendi` |
| C6 | La finestra della sync del giro diventa **`:59–:05` e `:29–:35`**. I minuti del cron non cambiano | La sync fa il `signin` a :00:04 e :30:0x. Un giro partito al minuto 59 lo farebbe meno di un minuto prima. Se il 429 lo prende la sync, quel suo giro salta; se lo prende il giro della coda, la coda si ferma un'ora |
| C7 | Non cambiano `EsitoGiroCodice`, la route del giro e la GET | Un rifiuto per distanza nel battito è `niente-da-fare`, e la spiegazione sta nella riga `attesa-accesso`. Il battito resta il vocabolario di `/api/health` (`giro/route.ts:42-51`) |
| C8 | «Inviata» → **3** in `DICITURA_A_CODICE`. Il livello `error` per le parole davvero nuove resta | Causa certa (§1.2). Il 3 sta già in `STATI_IN_VOLO`, e per `mapStatoAruba` 0 e 3 danno lo stesso `in_attesa`, quindi coda, aggregato del pagamento e PDF non cambiano. Cambiano l'etichetta a registro e il falso allarme. Non è «emessa»: precede anche gli scarti, fino a 54 ore misurate |
| C9 | Una sola migrazione. Nessuna scrittura in produzione a mano | La applica l'integrazione al merge. Le 10 righe di oggi a `sdi_stato` 0 si correggono da sole al primo giro della sync dopo il deploy (0 → 3 o → 6) |

### 1.4 Fuori, e perché

- **Le ricerche contro la sync.** Un blocco partito alle :57 che dura oltre le :00 non rifà il `signin`, ma le
  sue letture del pavimento (10 `findByUsername` oggi) possono sommarsi alle `getByFilename` della sync (11
  alle 10:00) e superare le 12 ricerche al minuto. Lo chiude il **cancello condiviso** della seconda consegna
  (`HANDOFF.md` §3, punto 3).
- **Le route dirette `POST /api/pagamenti/fattura` e `…/lotto`.** Dall'interfaccia non le chiama più nessuno
  (`FatturaButton` e `LottoFatturePanel` usano `/coda`), ma esistono e fanno il `signin` senza nessun
  coordinamento. Seconda consegna: 410 o passaggio dal cancello.
- **60 minuti di pausa dopo un 429 sul `signin`** sono sproporzionati (il limite è al minuto). Il giro non
  distingue il 429 del `signin` da quello della ricerca senza toccare i messaggi dell'emissione. Con questa
  correzione la coda non dovrebbe più causarne: è una decisione per dopo.
- **Gli script** (`scripts/lib/aruba-lettura.mjs`): partono già solo senza attività Aruba dell'app negli
  ultimi 10 minuti (`MINUTI_ATTIVITA_APP`) e a coda sospesa. Non cambiano.
- **«Presa in carico»** non entra nella mappa: non è mai stata misurata, e la regola di `stato.ts` è
  aggiungere solo le diciture viste.
- Nessuna scrittura sulle 10 righe a `sdi_stato` 0 (C9).
- **Il momento del rilascio.** Un giro in volo con le funzioni vecchie mentre la migrazione si applica non
  timbra. La finestra è di secondi, e il testimone protegge comunque dalla sovrapposizione.

---

## 2. Compiti, onde e proprietà dei file

### 2.1 I quattro compiti

| Sigla | Onda | Cosa fa |
|---|---|---|
| **ACCESSI** | 1 | La migrazione (C1–C3) e le prove su PGlite: nove casi nuovi, tre controlli negativi, sette test esistenti adattati e uno sostituito |
| **GIRO** | 1 | Costanti, attesa e finestra in `giro.ts` (C4–C7), il modello `CodaFinta` e i test G1–G8 |
| **INVIATA** | 1 | La dicitura «Inviata» → 3 (C8) e i suoi test |
| **DOC** | 2 | Voce del PRD datata 24/09/2026, HANDOFF (prime fatture vere, il 429 delle 10:09, la 2b al vero, questa correzione), nucleo |

### 2.2 Ordine

1. **Onda 1**: ACCESSI, GIRO e INVIATA partono insieme, e nessuno tocca un file di un altro. C'è una sola
   attesa, in un verso solo: il **G6 di GIRO** (il lock che legge la migrazione) si lancia dopo il passo 5
   di ACCESSI, quello che scrive la migrazione. Il controllo, in sola lettura, è
   `ls supabase/migrations | grep -c '_fatture_coda_distanza_accessi\.sql$'` → `1`.
   Il modello `CodaFinta` non dipende dalla migrazione: riproduce il contratto di §3.1.
2. **Onda 2**: DOC, col diff reale e il nome vero del file di ACCESSI.
3. Gate di §4.1, critico, rilascio di §5.

### 2.3 Proprietà dei file: ogni file ha UN solo proprietario

| Compito | File | Azione |
|---|---|---|
| ACCESSI | `supabase/migrations/<T>_fatture_coda_distanza_accessi.sql` | **crea** |
| ACCESSI | `__tests__/db/fatture-coda-nucleo.test.ts` | modifica |
| GIRO | `src/lib/fatture-coda/giro.ts` | modifica |
| GIRO | `__tests__/lib/fatture-coda/giro.test.ts` | modifica |
| INVIATA | `src/lib/aruba/stato.ts` | modifica (una voce e un commento) |
| INVIATA | `__tests__/lib/aruba/stato.test.ts` | modifica |
| INVIATA | `__tests__/lib/aruba/client.test.ts` | modifica |
| DOC | `PRD REGISTRO ELETTRONICO.md` | modifica |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/HANDOFF.md` | modifica |
| DOC | `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/nucleo.md` | modifica |

Totale: **10 file** più questo piano. Uno solo è nuovo (la migrazione). Nessun file di test nuovo.

### 2.4 File che nessuno tocca

- `src/app/api/pagamenti/fattura/coda/giro/route.ts`, `…/coda/route.ts` (la GET non espone la colonna nuova),
  `…/coda/azioni/route.ts`, `…/coda/sospensione/route.ts`, `…/fattura/sync/route.ts`, `…/fattura/route.ts`,
  `…/fattura/lotto/route.ts`.
- `src/lib/fatture-coda/api.ts`, `src/lib/pagamenti/esegui-blocco-fatture.ts`, `src/lib/pagamenti/lotto-fatture.ts`,
  `src/lib/aruba/emissione.ts`, `src/lib/aruba/client.ts` (l'allarme per le parole ignote resta com'è),
  `scripts/lib/aruba-lettura.mjs`.
- Le migrazioni del nucleo, della 2a e della 2b. `__tests__/architecture/soglia-fotografia.ts`
  (`MIGRAZIONI_ATTESE_AL_MERGE` resta `{}`: la migrazione nuova non accende nessun riconoscitore, e lo prova
  N9), tutte le fixture.
- `__tests__/api/fattura-coda-giro.test.ts`, `__tests__/api/fattura-sync*.test.ts`,
  `__tests__/lib/fatture-coda/api.test.ts`: si lanciano, non si modificano.

### 2.5 Regole per chi esegue in parallelo

- Si scrivono **solo** i propri file. Niente `git` che cambi stato, niente `npm install`, niente scritture in
  produzione (sul DB solo `SELECT`, con `supabase db query --linked` dalla radice).
- **Test rossi prima** del codice, e le assenze si verificano **dopo** una presenza (`.claude/rules/test.md`).
  Si conta **`Test Files N passed`**: un percorso sbagliato esce 0 senza eseguire niente.
- `npx eslint <i propri file> --max-warnings 0`. `npx tsc --noEmit` si legge **filtrando** i propri percorsi,
  perché l'albero è condiviso.
- Un rosso in un file di un altro compito si **segnala**, non si corregge.
- «Rompi il codice» senza git: copia in scratchpad, modifica, test rosso, ripristino con `cp`, `shasum -a 256`
  uguale a prima.
- Nei test solo uuid palesemente finti. Nessun nome, nessun codice fiscale, nessun numero di fattura vero.

---

## 3. Passi (TDD)

### 3.1 ACCESSI: la migrazione e le prove su PGlite

**Il nome.** `supabase/migrations/<T>_fatture_coda_distanza_accessi.sql`, con `T=$(date -u +%Y%m%d%H%M%S)` preso
quando si scrive il file. I vincoli:
- `T > 20260924010455` (l'ultima applicata), mai nel futuro, version unica;
- un solo file con quel suffisso;
- nessuna delle parole che accendono le guardie delle fotografie, **nemmeno nei commenti né nelle stringhe**:
  `policy`, `unique`, `primary key`, `row level security`, `drop table`, `add/drop constraint`,
  `references utenti`, `scuola_id`.

⚠️ `senzaCommenti` toglie i commenti `--` **fuori** dai corpi `$$`, ma lascia intatti i corpi e le stringhe.
Per questo i commenti dentro le funzioni dicono «65 s» e mai l'intervallo scritto per esteso: il lock G6 pretende
un solo `interval '… seconds'` nel testo eseguibile.

**Il testo completo.** Le due funzioni sono quelle del nucleo (`prendi` `:302-375`, `rilascia` `:478-511`) più
il controllo e i due timbri: chi scrive le confronta con `diff`. I privilegi ripetono `:764`, `:766`, `:774`,
`:776`, `:784`, `:786`.

```sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- CODA FATTURE — 65 secondi fra due accessi ad Aruba della coda (correzione del 24/09)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Fonte: docs/superpowers/specs/2026-09-22-coda-fatture-aruba/correzione-distanza-signin.md,
-- compito ACCESSI.
--
-- Il 24/09 alle 10:09:59 un giro svegliato da un accodamento ha fatto il signin una
-- quarantina di secondi dopo quello del giro precedente. Aruba ne concede UNO al minuto
-- per IP: ha risposto 429, e la pausa del 429 ha fermato la coda per un'ora, per tutte
-- le sedi. Il lavoratore unico impediva due giri INSIEME, non due giri a pochi secondi
-- l'uno dall'altro: ogni giro è un'invocazione nuova, con una sessione Aruba nuova, cioè
-- un signin nuovo.
--
-- `ultimo_accesso_il` dice fin quando un giro della coda può aver usato una sessione
-- Aruba. Lo scrivono:
--   · fatture_coda_prendi, quando consegna almeno una voce (il signin arriva subito dopo);
--   · fatture_coda_rilascia, per un token che aveva preso voci: il signin può arrivare
--     tardi (le voci respinte dai nostri controlli escono prima dell'accesso), e dalla
--     FINE del giro la distanza vale sempre.
-- fatture_coda_prendi non consegna niente prima di 65 secondi da lì (DISTANZA_ACCESSI_S
-- in src/lib/fatture-coda/giro.ts: un test tiene insieme i due numeri). Il rifiuto è
-- come quello della pausa: niente testimone, niente ultimo_giro_il, nessuna voce toccata.
--
-- Una colonna e due funzioni con la firma IDENTICA a quella del nucleo
-- (20260923102831_fatture_coda_nucleo.sql): stessi corpi, più il controllo e i due
-- timbri. Nessuna tabella e nessun indice nuovi. La applica l'integrazione Supabase al
-- merge, con la version di questo file. MAI a mano.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.fatture_coda_stato
  ADD COLUMN IF NOT EXISTS ultimo_accesso_il timestamptz;

COMMENT ON COLUMN public.fatture_coda_stato.ultimo_accesso_il IS
  'Fin quando un giro della coda fatture puo'' aver usato una sessione Aruba: lo scrivono fatture_coda_prendi (quando consegna voci) e fatture_coda_rilascia (per un token che ne aveva prese). fatture_coda_prendi non consegna voci prima di 65 secondi da qui: Aruba concede un signin al minuto per IP (correzione del 24/09/2026).';


-- ── fatture_coda_prendi ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fatture_coda_prendi(
  p_token uuid,
  p_max integer,
  p_prestito_s integer
)
RETURNS SETOF public.fatture_coda
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stato public.fatture_coda_stato%ROWTYPE;
  v_ids   uuid[];
BEGIN
  IF p_token IS NULL OR p_max IS NULL OR p_max < 1 OR p_prestito_s IS NULL OR p_prestito_s < 1 THEN
    RAISE EXCEPTION 'fatture_coda_prendi: token, p_max >= 1 e p_prestito_s >= 1 obbligatori'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fatture_coda'));

  SELECT * INTO v_stato FROM public.fatture_coda_stato WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fatture_coda_prendi: manca la riga id=1 di fatture_coda_stato'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_stato.sospesa THEN
    RETURN;
  END IF;
  IF v_stato.pausa_fino_a IS NOT NULL AND v_stato.pausa_fino_a > now() THEN
    RETURN;
  END IF;
  IF v_stato.lavoratore_token IS NOT NULL
     AND v_stato.lavoratore_token <> p_token
     AND v_stato.lavoratore_scade_il IS NOT NULL
     AND v_stato.lavoratore_scade_il > now() THEN
    RETURN;
  END IF;
  -- Meno di 65 s dall'ultimo accesso della coda: come la pausa, niente testimone,
  -- niente ultimo_giro_il, e le voci restano in_coda per il giro dopo.
  IF v_stato.ultimo_accesso_il IS NOT NULL
     AND v_stato.ultimo_accesso_il > now() - interval '65 seconds' THEN
    RETURN;
  END IF;

  UPDATE public.fatture_coda_stato
     SET lavoratore_token    = p_token,
         lavoratore_scade_il = now() + make_interval(secs => p_prestito_s),
         ultimo_giro_il      = now()
   WHERE id = 1;

  WITH scelte AS (
    SELECT c.id
    FROM public.fatture_coda c
    WHERE c.stato = 'in_coda'
    ORDER BY c.urgente DESC, c.gruppo_seq, c.data_riferimento, c.ordine_selezione, c.id
    LIMIT p_max
    FOR UPDATE SKIP LOCKED
  ),
  prese AS (
    UPDATE public.fatture_coda c
       SET stato             = 'in_invio',
           presa_il          = now(),
           prestito_scade_il = now() + make_interval(secs => p_prestito_s),
           lavoratore_token  = p_token,
           tentativi         = c.tentativi + 1,
           aggiornato_il     = now()
      FROM scelte
     WHERE c.id = scelte.id
    RETURNING c.id
  )
  SELECT array_agg(prese.id) INTO v_ids FROM prese;

  -- Almeno una voce consegnata: il signin di questo giro arriva fra un istante.
  IF v_ids IS NOT NULL THEN
    UPDATE public.fatture_coda_stato
       SET ultimo_accesso_il = now()
     WHERE id = 1;
  END IF;

  RETURN QUERY
    SELECT c.*
    FROM public.fatture_coda c
    WHERE c.id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))
    ORDER BY c.urgente DESC, c.gruppo_seq, c.data_riferimento, c.ordine_selezione, c.id;
END $$;


-- ── fatture_coda_rilascia ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fatture_coda_rilascia(
  p_token uuid,
  p_pausa_minuti integer,
  p_motivo text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fatture_coda'));

  -- Un giro che aveva preso voci può aver fatto il signin fino a qui (le voci respinte
  -- dai nostri controlli escono PRIMA dell'accesso): l'orologio della distanza riparte
  -- dalla fine del giro. Vale anche col testimone già scaduto, come la pausa qui sotto,
  -- e non torna mai indietro. fatture_coda_chiudi non azzera il token delle voci: lo
  -- toglie solo «Rimetti», e per quel caso resta il timbro della presa.
  IF p_token IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.fatture_coda WHERE lavoratore_token = p_token) THEN
    UPDATE public.fatture_coda_stato
       SET ultimo_accesso_il = GREATEST(COALESCE(ultimo_accesso_il, now()), now())
     WHERE id = 1;
  END IF;

  UPDATE public.fatture_coda_stato
     SET lavoratore_token    = NULL,
         lavoratore_scade_il = NULL
   WHERE id = 1
     AND p_token IS NOT NULL
     AND lavoratore_token = p_token;

  IF COALESCE(p_pausa_minuti, 0) > 0 THEN
    UPDATE public.fatture_coda_stato
       SET pausa_fino_a = GREATEST(COALESCE(pausa_fino_a, now()),
                                   now() + make_interval(mins => p_pausa_minuti)),
           -- Il motivo segue la scadenza che vince (nel SET si leggono i valori VECCHI).
           pausa_motivo = CASE
                            WHEN pausa_fino_a IS NULL
                              OR pausa_fino_a <= now() + make_interval(mins => p_pausa_minuti)
                            THEN left(p_motivo, 200)
                            ELSE pausa_motivo
                          END
     WHERE id = 1;
  END IF;
END $$;


-- ── Proprietà e privilegi (come il nucleo) ──────────────────────────────────
ALTER FUNCTION public.fatture_coda_prendi(uuid, integer, integer) OWNER TO postgres;
ALTER FUNCTION public.fatture_coda_rilascia(uuid, integer, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fatture_coda_prendi(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fatture_coda_rilascia(uuid, integer, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fatture_coda_prendi(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fatture_coda_rilascia(uuid, integer, text) TO service_role;

-- La colonna nuova la legge il giro via PostgREST: la cache dello schema va ricaricata.
NOTIFY pgrst, 'reload schema';
```

Il `service_role` legge già la tabella (`GRANT SELECT`, nucleo `:176`), e un privilegio di tabella copre anche le
colonne nuove. Nessun indice nuovo: l'`EXISTS` scandisce per `lavoratore_token` una tabella di poche migliaia di
righe, una volta per giro.

**Passi (rosso prima), in `__tests__/db/fatture-coda-nucleo.test.ts`**

1. **Caricamento e aiuti**, prima di scrivere la migrazione.
   - Accanto a `:46-49`: `SUFFISSO_ACCESSI = '_fatture_coda_distanza_accessi.sql'`, `TROVATI_ACCESSI`, `NOME_ACCESSI`
     e `DISTANZA_ACCESSI`, con lo stesso schema.
   - Nel `beforeEach` (`:283-289`), dopo `CHIUDI_AZZERA`: `if (DISTANZA_ACCESSI) await db.exec(DISTANZA_ACCESSI)`.
   - Nella prova di seconda esecuzione (`:380-396`), dopo `CHIUDI_AZZERA`:
     `if (DISTANZA_ACCESSI) await expect(db.exec(DISTANZA_ACCESSI)).resolves.toBeDefined()`. Il commento
     `:386-387` diventa «nucleo → 2a → 2b → 24/09».
   - La testata (`:3-10`) cita la quarta migrazione.
   - Al tipo `Stato` (`:253-262`) si aggiunge `ultimo_accesso_il: Date | null`, e vicino a `stato()` tre aiuti:

   ```ts
   /** Come se l'ultimo accesso della coda fosse di più di 65 s fa: il giro dopo può prendere. */
   async function dimenticaAccesso() {
     await db.exec(`UPDATE public.fatture_coda_stato SET ultimo_accesso_il = NULL WHERE id = 1`)
   }
   /** Mette l'ultimo accesso a un'espressione SQL, per esempio `now() - interval '64 seconds'`. */
   async function accessoA(espressione: string) {
     await db.exec(`UPDATE public.fatture_coda_stato SET ultimo_accesso_il = ${espressione} WHERE id = 1`)
   }
   /** I secondi passati dall'ultimo accesso, misurati dal database. */
   async function secondiDallAccesso(): Promise<number | null> {
     const { rows } = await db.query<{ s: number | null }>(
       `SELECT extract(epoch FROM now() - ultimo_accesso_il)::float8 AS s FROM public.fatture_coda_stato WHERE id = 1`,
     )
     return rows[0].s
   }
   ```

2. **I casi nuovi**, in un `describe('65 s fra due accessi ad Aruba (correzione del 24/09)')` **dentro**
   `describe('fatture_coda_prendi')`, dopo `:673-679`, così `preparaCodaMista()` resta a portata di mano. L'ordine
   di consegna è 5, 2, 3, 1, 4.
   - **N1** · «dopo un giro con voci, un altro token non prende prima di 65 s: niente testimone, niente
     `ultimo_giro_il`, voci intatte». Sostituisce il `:633`.
     - `preparaCodaMista()`; `numeri(await prendi(TOKEN_A, 1))` → `[5]`; `rilascia(TOKEN_A, 0, null)`;
       `prima = await stato()`, con `ultimo_accesso_il` non nullo.
     - `await prendi(TOKEN_B, 15)` → `[]`. Poi `stato()`: `lavoratore_token` nullo e `ultimo_giro_il.getTime()`
       uguale a quello di `prima`.
     - Le voci `in_coda`, lette con `voci()`, sono quattro, tutte con `tentativi` 0 e `lavoratore_token` nullo.
       È la prova sul DB che **la sveglia non perde voci**.
     - Infine `dimenticaAccesso()`, e `numeri(await prendi(TOKEN_B, 15))` → `[2, 3, 1, 4]`.
   - **N2** · «il confine: a 64 s rifiuta, a 65 s consegna».
     - `preparaCodaMista()`; `accessoA("now() - interval '64 seconds'")`; `prendi(TOKEN_A, 1)` → `[]`.
     - `accessoA("now() - interval '65 seconds'")`; `numeri(await prendi(TOKEN_A, 1))` → `[5]`.
     - Ogni `db.query` è una transazione sua, quindi il margine fra le due letture di `now()` è di millisecondi.
   - **N3** · «il rilascio sposta l'orologio alla FINE del giro».
     - `preparaCodaMista()`; `prendi(TOKEN_A, 1)`; `accessoA("now() - interval '10 minutes'")`, come se il
       `signin` fosse vecchio.
     - `rilascia(TOKEN_A, 0, null)`: `secondiDallAccesso()` è `< 2`, e `prendi(TOKEN_B, 1)` → `[]`.
   - **N4** · «un giro a vuoto non timbra».
     - A coda vuota, `prendi(TOKEN_A)` → `[]` e `rilascia(TOKEN_A, 0, null)`: `stato().ultimo_accesso_il` resta nullo.
     - Poi `nuovoPagamento(1)`, `accoda([{ pagamento_id: pag(1) }], true)` e `numeri(await prendi(TOKEN_B, 1))` →
       `[1]`: la sveglia che segue un cron a vuoto prende subito.
   - **N5** · «rilascia: senza voci non timbra; con voci timbra anche se il testimone è di un altro; mai
     all'indietro». Parte da `preparaCodaMista()`.
     - (a) `accessoA("now() - interval '10 minutes'")`, poi `rilascia(TOKEN_B, 0, null)`: `secondiDallAccesso()`
       resta `> 590`.
     - (b) `dimenticaAccesso()` e `prendi(TOKEN_A, 1)`. Poi
       `db.exec(\`UPDATE public.fatture_coda_stato SET lavoratore_token = '${TOKEN_B}', lavoratore_scade_il = now() + interval '330 seconds', ultimo_accesso_il = now() - interval '10 minutes' WHERE id = 1\`)`
       e `rilascia(TOKEN_A, 0, null)`. Il testimone resta `TOKEN_B` e `secondiDallAccesso()` è `< 2`.
     - (c) `accessoA("now() + interval '1 hour'")`, se ne legge il `getTime()`, poi `rilascia(TOKEN_A, 0, null)`:
       il valore non cambia.
   - **N6** · «"Rimetti" toglie il token alle voci del giro: resta il timbro della presa».
     - `preparaCodaMista()`; `const [voce] = await prendi(TOKEN_A, 1)`; `chiudi(voce.id, TOKEN_A, 'errore', 'scarto_aruba')`.
     - `rimetti([voce.id])` → `1`, poi `rilascia(TOKEN_A, 0, null)`: nessuna voce porta più A, quindi il rilascio
       non timbra.
     - `prendi(TOKEN_B, 1)` → `[]`, grazie al timbro della presa.
   - **N7** · «forma: la colonna è `timestamptz` e ammette null».
     `SELECT data_type AS tipo, is_nullable AS nullo FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fatture_coda_stato' AND column_name = 'ultimo_accesso_il'`
     → `[{ tipo: 'timestamp with time zone', nullo: 'YES' }]`. Firme, `SECURITY DEFINER`, `search_path` e privilegi
     li prova già la forma dello schema (`:322-371`), che gira dopo il `beforeEach`: un overload aggiungerebbe una riga.
   - **N8** · «la migrazione del 24/09 esiste, è una sola, viene dopo quella della 2b e non è nel futuro»: come
     `:780-786`, confrontando con `NOME_CHIUDI.slice(0, 14)`.
   - **N9** · «non accende nessuna guardia delle fotografie, e revoca per nome»: come `:788-797`. `toccaLaRls`,
     `toccaUnUnico` e `toccaLeFkUtenti` danno `false`; `senzaCommenti(DISTANZA_ACCESSI)` non contiene `/scuola_id/i`;
     il file contiene
     `REVOKE ALL ON FUNCTION public.fatture_coda_prendi(uuid, integer, integer) FROM PUBLIC, anon, authenticated;`
     e la riga gemella di `fatture_coda_rilascia(uuid, integer, text)`.

   Oggi sono tutti rossi: il file non c'è, e senza colonna `accessoA` fallisce con `42703`.

3. **I test esistenti da adattare, dichiarandolo nel commit.** Sono tutti test che chiamano `prendi` due volte
   di seguito, e oggi il secondo giro arriverebbe «subito». Sono sette adattati (sei direttamente, il `:799`
   attraverso `unaInMano`) e uno sostituito (il `:633`, da N1):
   - `unaInMano` (`:684-696`): `await dimenticaAccesso()` prima del suo `prendi`, perché ogni voce «in mano» è
     un giro nuovo a distanza. Copre il `:799`, che la chiama due volte;
   - `:593`: `dimenticaAccesso()` prima del 2°, del 3° e del 4° `prendi`;
   - `:619`: la `UPDATE` che fa scadere il testimone (`:626-628`) porta anche
     `ultimo_accesso_il = now() - interval '331 seconds'`, perché un testimone scade 330 s dopo la presa;
   - `:633` («dopo il rilascio del primo, un altro token prende subito»): **dice l'opposto della correzione**.
     Si toglie e N1 ne prende il posto, e il commit lo scrive;
   - `:662`: `dimenticaAccesso()` prima del 2° e del 3° `prendi`, altrimenti il 3° sarebbe `[]` per la ragione
     sbagliata;
   - `:733`: `dimenticaAccesso()` prima di «Al giro dopo…» (`:756`);
   - `:898`: `dimenticaAccesso()` prima di `prendi(TOKEN_B)` (`:923`);
   - `:1035`: `dimenticaAccesso()` prima di `prendi(TOKEN_B)` (`:1060`).

   Nessun altro test chiama `prendi` due volte con voci: sono verificati uno per uno `:466`, `:601`, `:640`,
   `:651`, `:826`, `:851`, `:945`, `:994`, `:1010`, `:1063` e i controlli negativi.

4. **Tre controlli negativi**, nel `describe('controlli negativi …')` (`:1186`). Le regex sono scritte sul
   testo di §3.1: se l'SQL cambia, cambiano insieme. Ogni caso comincia con `expect(rotta).not.toBe(DISTANZA_ACCESSI)`.

   ```ts
   /** Nucleo, 2a e 2b come in produzione, poi il 24/09 (rotto); due pagamenti in coda. */
   async function conAccessi(sql: string) {
     await conMigrazione(MIGRAZIONE)
     await db.exec(TOGLI_AZZERA)
     await db.exec(CHIUDI_AZZERA)
     await db.exec(sql)
     for (const n of [1, 2]) await nuovoPagamento(n)
     await accoda([1, 2].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
   }
   ```
   - «senza il controllo dei 65 s un altro token prenderebbe subito: N1 lo misura». Rottura:
     `DISTANZA_ACCESSI.replace(/\n\s*IF v_stato\.ultimo_accesso_il IS NOT NULL[\s\S]*?END IF;/, '')`. Poi
     `prendi(TOKEN_A, 1)` e `rilascia(TOKEN_A, 0, null)`: `numeri(await prendi(TOKEN_B, 1))` → `[2]`.
   - «senza il ramo di rilascia l'orologio resterebbe alla presa: N3 lo misura». Rottura:
     `/\n\s*IF p_token IS NOT NULL\s+AND EXISTS[\s\S]*?END IF;/`. Poi `prendi(TOKEN_A, 1)`,
     `ultimo_accesso_il = now() - interval '10 minutes'` e `rilascia(TOKEN_A, 0, null)`: `prendi(TOKEN_B, 1)` → `[2]`.
   - «senza il timbro della presa, un "Rimetti" prima del rilascio aprirebbe la porta: N6 lo misura». Rottura:
     `/\n\s*IF v_ids IS NOT NULL THEN[\s\S]*?END IF;/`. Poi `const [voce] = await prendi(TOKEN_A, 1)`, chiusura in
     `errore`, `rimetti([voce.id])` e `rilascia(TOKEN_A, 0, null)`: `prendi(TOKEN_B, 1)` ha lunghezza 1.

5. Si scrive la migrazione (§3.1), e tutto torna verde.

**Log**: nessuno, è SQL.

**Verifica**:
`npx vitest run __tests__/db/fatture-coda-nucleo.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/onconflict-arbitro.test.ts __tests__/architecture/rls-per-sede.test.ts __tests__/architecture/tracce-docente-dichiarate.test.ts __tests__/architecture/fk-scuola-id.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts __tests__/architecture/pii-nei-file-tracciati.test.ts __tests__/lib/insegnanti-template.test.ts`
→ **`Test Files 11 passed`**. Non si applica a mano (§5).

### 3.2 GIRO: l'attesa, la finestra, il modello

**Codice, in `src/lib/fatture-coda/giro.ts`**

1. Testata (`:23-30`): dopo il punto 1, un punto «1b. tenere 65 s fra il proprio accesso ad Aruba e quello del
   giro precedente (correzione del 24/09): se manca poco si aspetta, poi si ricontrolla la finestra».
2. Dopo `PAUSA_INCERTO_MINUTI` (`:56`):

   ```ts
   /**
    * I secondi fra due accessi ad Aruba della coda (correzione del 24/09/2026).
    *
    * Aruba concede UN `signin` al minuto per IP, e ogni giro è un'invocazione nuova con una
    * sessione nuova, cioè un `signin` nuovo. Il lavoratore unico impedisce due giri INSIEME,
    * non due giri a pochi secondi: il 24/09 alle 10:09:59 un giro svegliato da un accodamento
    * ha fatto il suo `signin` una quarantina di secondi dopo quello del giro precedente, ha
    * preso `429`, e la pausa del `429` ha fermato la coda per un'ora.
    *
    * La garanzia sta in `fatture_coda_prendi` (migrazione `…_fatture_coda_distanza_accessi.sql`,
    * `interval '65 seconds'`); un test in `__tests__/lib/fatture-coda/giro.test.ts` tiene
    * insieme i due numeri. Qui serve solo a sapere quanto aspettare.
    */
   export const DISTANZA_ACCESSI_S = 65

   /** Lo scarto concesso fra l'orologio di Vercel e quello del database. */
   const MARGINE_OROLOGIO_MS = 1_000

   /**
    * L'attesa più lunga che un giro si concede prima di chiedere un blocco. Con un ultimo
    * accesso nel futuro (orologi sfasati, un dato scritto a mano) non si dorme fino al muro dei
    * 300 s: si aspetta questo, poi decide `prendi`. Un test controlla che dopo l'attesa più
    * lunga resti il budget per una fattura.
    */
   export const ATTESA_MASSIMA_MS = DISTANZA_ACCESSI_S * 1000 + MARGINE_OROLOGIO_MS
   ```

3. `inFinestraSync` (`:170-190`). Il ritorno diventa
   `return minuto >= 59 || minuto <= 5 || (minuto >= 29 && minuto <= 35)`. Il docblock si riscrive col vero:
   - `fatture-sdi-sync` gira ogni trenta minuti, ai minuti 0 e 30, e fa il `signin` pochi secondi dopo
     (24/09: 10:00:04, 11:00:04, 11:30:03);
   - dal 24/09 la finestra comincia ai minuti 59 e 29, perché un giro partito lì farebbe il `signin` meno di
     un minuto prima di quello della sync;
   - il cron della coda non tocca mai questi minuti.

   ⚠️ Nel docblock **non** si scrive l'espressione cron con asterisco e barra (quella di «ogni trenta
   minuti»): dentro un commento `/** … */` il suo `*/` chiude il commento.
4. Prima di `eseguiGiroCoda` (dopo `RigaCoda`, `:256`):

   ```ts
   /**
    * Quanti millisecondi aspettare prima di chiedere un blocco: 0 se non serve, o se non si sa.
    *
    * Si aspetta SOLO quando l'unico ostacolo è la distanza dall'ultimo accesso: con un altro
    * lavoratore attivo, una pausa o la coda sospesa `prendi` rifiuterebbe comunque. Senza
    * attesa, una sveglia arrivata subito dopo un giro troverebbe `prendi` chiuso e la fattura
    * «urgente» aspetterebbe il cron: fino a 5 minuti, 10 a cavallo della sync.
    *
    * Una lettura fallita (`42703` prima che arrivi la migrazione del 24/09, il database E2E)
    * vale 0: si torna al comportamento di prima, e la distanza la garantisce `prendi`.
    */
   async function attesaPerAccesso(sb: SupabaseClient): Promise<number> {
     const { data, error } = await sb
       .from('fatture_coda_stato')
       .select('ultimo_accesso_il, lavoratore_scade_il, pausa_fino_a, sospesa')
       .eq('id', 1)
       .maybeSingle()
     if (error) {
       logEvento('fattura', 'warn', { operazione: OPERAZIONE_GIRO, esito: 'accesso-non-letto' }, error)
       return 0
     }
     const s = (data ?? null) as {
       ultimo_accesso_il?: string | null
       lavoratore_scade_il?: string | null
       pausa_fino_a?: string | null
       sospesa?: boolean | null
     } | null
     if (!s?.ultimo_accesso_il) return 0
     const ora = Date.now()
     const nelFuturo = (iso: string | null | undefined) => typeof iso === 'string' && Date.parse(iso) > ora
     if (s.sospesa === true || nelFuturo(s.pausa_fino_a) || nelFuturo(s.lavoratore_scade_il)) return 0
     const residuo = Date.parse(s.ultimo_accesso_il) + DISTANZA_ACCESSI_S * 1000 - ora
     if (!Number.isFinite(residuo) || residuo <= 0) return 0
     return Math.min(residuo + MARGINE_OROLOGIO_MS, ATTESA_MASSIMA_MS)
   }
   ```

5. In `eseguiGiroCoda`, subito dopo il passo 1 (`:268`) e **prima del bidello**:

   ```ts
   // ── 1b. LA DISTANZA DALL'ULTIMO ACCESSO DELLA CODA (24/09) ─────────────────────
   // Prima del bidello: bidello, tetto e `prendi` lavorano sui dati di DOPO l'attesa.
   let momento = adesso
   const attesa = await attesaPerAccesso(sb)
   if (attesa > 0) {
     logEvento('fattura', 'info', { operazione: OPERAZIONE_GIRO, esito: 'attesa-accesso', ms: attesa })
     await new Promise<void>((fatto) => setTimeout(fatto, attesa))
     momento = new Date(adesso.getTime() + attesa)
     // L'attesa può finire dentro la finestra della sync: si ricontrolla.
     if (inFinestraSync(momento)) return vuoto('finestra-sync')
   }
   ```

   Poi `contaEmesseUltimaOra(sb, momento)` al posto di `adesso` (`:291`), e il `@param adesso` (`:262`) dice
   «l'istante della chiamata; dopo un'attesa il giro usa l'istante di dopo».
6. Non cambiano `EsitoGiroCodice`, `classificaEsito`, `rilascia` né la route.

**Test, in `__tests__/lib/fatture-coda/giro.test.ts`: prima i test, rossi, poi il codice**

1. **Import**: `readdirSync` da `node:fs`; `DISTANZA_ACCESSI_S` e `ATTESA_MASSIMA_MS` da `@/lib/fatture-coda/giro`;
   `BUDGET_BLOCCO_MS` e `RISERVA_PEGGIORE_MS` da `@/lib/pagamenti/lotto-fatture`; `senzaCommenti` da
   `../../architecture/soglia-fotografia`. La testata (`:9-16`) aggiunge che `prendi` rifiuta anche «prima di 65 s
   dall'ultimo accesso».
2. **`CodaFinta` modella il contratto di §3.1**, con stato e non con un mock piatto:
   - campi nuovi:
     - `ultimoAccesso: number | null = null`;
     - `tokenConVoci = new Set<string>()`, il modello di `EXISTS`. Il `chiudi` del modello azzera il token delle
       voci (`:185`), quindi le voci non bastano a ricostruirlo;
     - `guastoStato: { data: unknown; error: unknown } | null = null`;
   - `chiamate` registra anche l'istante: `this.chiamate.push({ nome, args, t: Date.now() })`, col tipo
     aggiornato;
   - `prendi`, dopo il controllo del lavoratore (`:166-168`):
     `if (this.ultimoAccesso !== null && adesso - this.ultimoAccesso < DISTANZA_ACCESSI_S * 1000) return { data: [], error: null }`.
     Dopo aver preso: `if (prese.length > 0) { this.ultimoAccesso = adesso; this.tokenConVoci.add(String(args.p_token)) }`;
   - `rilascia`, in testa:
     `if (this.tokenConVoci.has(String(args.p_token))) this.ultimoAccesso = Math.max(this.ultimoAccesso ?? adesso, adesso)`;
   - in `from()`, prima del ramo generico `return { data: [], error: null }`, un ramo `fatture_coda_stato`. Se c'è
     `guastoStato` risponde con quello; altrimenti `data` è
     `{ ultimo_accesso_il, lavoratore_scade_il, pausa_fino_a, sospesa }`, dagli stessi campi del modello in ISO
     (null dove mancano).
3. **I casi nuovi**, in un `describe('la distanza fra due accessi ad Aruba (24/09)')`:
   - **G1** · il 24/09 in piccolo: «la sveglia arriva 42 s dopo la fine del giro precedente: il giro ASPETTA,
     poi emette».
     - `coda.accoda(1, { urgente: true })`; `await giro()`; `fine = coda.ultimoAccesso!` (timbrato dal `rilascia`
       del modello).
     - `coda.accoda(1, { urgente: true }, 2)`; `vi.setSystemTime(fine + 42_000)`; `h.eventi.length = 0`;
       `r = await giro()`.
     - Il risultato è `{ esito: 'eseguito', emesse: 1 }` e la voce 2 è `emessa`.
     - L'ultimo `prendi` ha `t - fine ≥ DISTANZA_ACCESSI_S * 1000`.
     - C'è un solo evento `attesa-accesso`, di livello `info`, con `ms` fra 23 000 e 24 000.
     - L'istante passato all'ultimo `h.conta` è a ≥ 65 000 ms da `fine`: il tetto si conta dopo l'attesa.
   - **G2** · `it.each` su tre ostacoli: un altro lavoratore attivo
     (`coda.lavoratore = { token: uuid(9999), scade: Date.now() + 60_000 }`), la pausa di un 429
     (`coda.pausaFinoA = Date.now() + 30 * 60_000`) e la coda sospesa (`coda.sospesa = true`).
     - Titolo: «con %s il giro NON aspetta: prendi rifiuterebbe comunque».
     - Ogni caso ha `coda.accoda(1)` e `coda.ultimoAccesso = Date.now() - 10_000`: senza la regola si
       aspetterebbero 56 s.
     - L'esito è `niente-da-fare`, `emetti` non è mai chiamato, non c'è nessun `attesa-accesso` e
       `Date.now() - t0 < 5_000`.
   - **G3** · «un'attesa che finisce dentro la finestra della sync: il giro si ferma lì, prima del bidello».
     - `vi.setSystemTime(new Date('2026-09-23T08:28:40Z'))`, cioè le 10:28:40 a Roma, fuori finestra.
     - `coda.accoda(1)` e `coda.ultimoAccesso = Date.now() - 10_000`: l'attesa è di 56 s e porta alle 10:29:36.
     - L'esito è `finestra-sync`, `nomi()` è `[]` (né bidello né `prendi`), `emetti` non è mai chiamato e la voce
       resta `in_coda`.
   - **G4** · «la sveglia che arriva mentre un giro lavora non perde la voce: la prende il cron dopo, UNA volta».
     - `coda.accoda(1)`, con
       `h.emetti.mockImplementationOnce(async () => { await new Promise((r) => setTimeout(r, 20_000)); return esitoOk })`.
     - `primo = eseguiGiroCoda(coda.client(), new Date(Date.now()))`, poi `await vi.advanceTimersByTimeAsync(10_000)`.
     - `coda.accoda(1, {}, 2)` e `secondo = eseguiGiroCoda(…)`. Poi
       `const [r1, r2] = await completa(Promise.all([primo, secondo]))`: `r1` ha `emesse: 1`, `r2` è
       `niente-da-fare`, la voce 2 è `in_coda` con `tentativi` 0.
     - `vi.setSystemTime(new Date('2026-09-23T08:12:00Z'))` e `await giro()`: una emessa.
     - `h.emetti.mock.calls.map((c) => c[1])` → `[uuid(1), uuid(2)]`.
   - **G5** · «la lettura dell'ultimo accesso fallisce (`42703`, colonna non ancora migrata): nessuna attesa, un
     `warn`, decide `prendi`».
     - `coda.accoda(1)` e `coda.guastoStato = { data: null, error: { code: '42703', message: 'colonna finta assente' } }`.
     - Il risultato è `{ esito: 'eseguito', emesse: 1 }`.
     - C'è un solo `accesso-non-letto`, di livello `warn`, con `errore` che contiene `{ code: '42703' }`, e nessun
       `attesa-accesso`.
   - **G6** · lock, in un `describe('LOCK: la distanza fra gli accessi è UNA, scritta in due lingue')`:
     - in `supabase/migrations` c'è un solo file `_fatture_coda_distanza_accessi.sql`;
     - su `senzaCommenti(file)`,
       `[...sql.matchAll(/interval\s+'(\d+)\s+seconds?'/gi)].map((m) => Number(m[1]))` →
       `[DISTANZA_ACCESSI_S]`: uno solo, e uguale;
     - `ATTESA_MASSIMA_MS === DISTANZA_ACCESSI_S * 1000 + 1_000`;
     - `ATTESA_MASSIMA_MS + RISERVA_PEGGIORE_MS < BUDGET_BLOCCO_MS`.

     Si lancia dopo il passo 5 di ACCESSI (§2.2).
   - **G7** · la finestra, nei due test esistenti (`:301`, `:312`): «DENTRO» su `[0, 2, 5, 29, 30, 32, 35, 59]`,
     «FUORI» su `[6, 7, 28, 36, 57, 58]`. Il 29 esce dal «fuori» di oggi.
   - **G8** · «un ultimo accesso nel FUTURO: si aspetta al massimo `ATTESA_MASSIMA_MS`».
     - `coda.accoda(1)` e `coda.ultimoAccesso = Date.now() + 60 * 60_000`.
     - L'esito è `niente-da-fare` (il modello rifiuta ancora), `Date.now() - t0 ≤ ATTESA_MASSIMA_MS + 1_000` e la
       voce resta `in_coda`.
4. **Restano verdi senza modifiche** i test a più giri («quaranta voci», «sessanta voci», il 429 e poi le 08:12,
   il caso (g)): i tick sono a 5 minuti, e l'ultimo accesso è sempre più vecchio di 65 s. Resta verde anche
   «il conteggio riceve l'istante del giro» (`:366`): senza attesa `momento` è `adesso`.

**Log**:
- `attesa-accesso`: `info`, con `ms`, un numero che passa la redazione per tipo;
- `accesso-non-letto`: `warn`, con l'errore di PostgREST.

Solo `operazione`, `esito` e `ms`: nessun dato personale. Il successo del giro lo dicono già `voce-emessa` e il
battito.

**Verifica**:
`npx vitest run __tests__/lib/fatture-coda/giro.test.ts __tests__/api/fattura-coda-giro.test.ts __tests__/architecture/coda-fatture-esiti-i18n.test.ts __tests__/lib/fatture-coda/api.test.ts`
→ **`Test Files 4 passed`**.

### 3.3 INVIATA: la dicitura della sync

**Test prima, rossi oggi.** Misurato: oggi `codiceStatoAruba('Inviata')` dà 0.

1. `__tests__/lib/aruba/stato.test.ts`, nel `describe('codiceStatoAruba')`:

   ```ts
   // Misurata in produzione dopo l'11/09 (app_log, fino al 24/09 sempre e solo lei): lo stato IN VOLO.
   it('«Inviata» è 3: in attesa, non terminale, non scarto — resta in coda', () => {
     expect(codiceStatoAruba('Inviata')).toBe(3)
     expect(codiceStatoAruba('  INVIATA ')).toBe(3)
     expect(mapStatoAruba(codiceStatoAruba('Inviata'))).toMatchObject({
       fatturaStato: 'in_attesa', isTerminal: false, isScarto: false,
     })
     expect(etichettaStatoAruba(mapStatoAruba(3), 'Inviata')).toBe('Inviata allo SDI — Aruba: «Inviata»')
   })
   ```

   - In `NESSUNA parola fuori dalle tre misurate` (`:250`), «tre» diventa «quattro» (anche il messaggio a
     `:266`), e fra le `mai_viste` entra `'Inviata allo SDI'`: niente sottostringhe, deve restare 0.
   - Il titolo di `:58` diventa «le tre diciture terminali misurate l'11/09 → i codici della tabella».
2. `__tests__/lib/aruba/client.test.ts`:
   - in `le tre diciture misurate escono con codice E fatturaStato giusti` (`:365`) si aggiunge
     `['Inviata', 3, 'in_attesa']` e il titolo dice «quattro»;
   - in `le tre diciture conosciute NON fanno rumore` (`:473-489`) il ciclo prende anche `'Inviata'` e il titolo
     dice «quattro». È il caso del falso allarme: oggi fa **1** allarme, quindi è rosso;
   - il caso `'Messa in quarantena'` (`:425`) resta com'è: prova che una parola davvero ignota grida ancora a
     livello `error`.

**Codice.** In `src/lib/aruba/stato.ts`, in fondo a `DICITURA_A_CODICE` (`:125-132`):

```ts
  // IN VOLO: trasmessa allo SDI, esito non ancora arrivato. Precede sia «Non consegnata» sia
  // «Scartata» (fino a 54 ore, misurato), quindi NON è emessa: è il 3 della tabella, che resta
  // in coda. Mancava dal campione dell'11/09 perché quei 4.000 documenti erano tutti conclusi.
  ['inviata', 3],
```

E nel blocco `:92-97`, dopo la tabella delle tre, una frase: dopo l'11/09 in produzione ne è comparsa **una
quarta**, sempre e solo lei, «Inviata» (1.380 righe `stato-non-interpretato` fino al 24/09): è lo stato in volo,
e va sul 3. Il livello `error` di `client.ts:821` **non** si tocca: per una parola davvero nuova resta giusto.

**Log**: nessuno nuovo. Sparisce il falso `error`.

**Verifica**:
`npx vitest run __tests__/lib/aruba/stato.test.ts __tests__/lib/aruba/client.test.ts __tests__/api/fattura-sync.test.ts __tests__/api/fattura-sync-notifiche.test.ts __tests__/lib/fatture-orfane-cli.test.ts __tests__/lib/pagamenti/fattura-viva.test.ts`
→ **`Test Files 6 passed`**.

### 3.4 DOC: PRD, HANDOFF, nucleo (onda 2)

Parte per ultimo, e legge il diff reale e il nome vero della migrazione. Le modifiche si fanno su sottostringhe
**uniche**: prima di ognuna `grep -cF` deve dare 1. Le ancore qui sotto sono già verificate uniche su `02eb9836`.
Solo conteggi, orari, version e md5: nessun dato personale (il lock `pii-nei-file-tracciati` guarda PRD e docs),
nessun uuid di sede, nessun numero di fattura. Mai scrivere «non ancora in produzione» né «PR da aprire»: dopo il
merge sarebbero falsi.

- **PRD** (`PRD REGISTRO ELETTRONICO.md`):
  - **Voce nuova**, subito prima di `## Changelog — Coda fatture Aruba — consegna 2b: le rifiniture (D1–D14) — 2026-09-24`:
    `## Changelog — Coda fatture Aruba — correzione urgente del 24/09: 65 s fra due accessi ad Aruba, e «Inviata» non è più un errore — 2026-09-24 (branch \`fix/coda-fatture-distanza-signin\`; stato di produzione: lo registra la PR di documenti dopo il deploy)`.
    Il contenuto, da §0 e §1:
    1. Il 24/09 le **prime fatture vere** della coda: 15 voci, tutte emesse (4 alle 09:57 da un lotto, 1 alle
       10:09 dal pulsante, 10 alle 11:12–11:13 dal cron, senza nessuno davanti).
    2. **Il 429 delle 10:09:59** sul `signin`, circa 41 s dopo quello del giro precedente, e la coda ferma fino
       alle 11:09:59 per tutte le sedi.
    3. **Causa** (§1.1).
    4. **Correzione**: la migrazione col suo nome, C1–C7 col perché in una riga ciascuno. Poi «**Una migrazione,
       applicata dall'integrazione al merge, mai a mano; nessuna scrittura in produzione**».
    5. **La sync e «Inviata»** (§1.2, C8), con i 1.380 falsi `error` e le 10 righe di oggi che si correggono da sole.
    6. **Log** (`attesa-accesso`, `accesso-non-letto`).
    7. **Test**: N1–N9 e tre controlli negativi su PGlite; il `:633` sostituito da N1 e gli altri adattati; G1–G8;
       «Inviata» in `stato` e `client`; `Test Files 1442 passed`.
    8. **Fuori, e perché** (§1.4) e **Verifica dopo il merge** (§5.2).

    Chiude con `---` e una riga vuota.
  - **La 2b al vero**:
    - nel titolo `:1791`, `(branch \`fix/coda-fatture-rifiniture-2b\`; stato di produzione: lo registra la PR di documenti dopo il deploy)`
      diventa
      `(branch \`fix/coda-fatture-rifiniture-2b\`, ✅ IN PRODUZIONE — PR [#163](https://github.com/erricoluigi17/kidville-web/pull/163), merge 24/09 06:38 (\`02eb9836\`))`;
    - dopo `invariati; 0 emesse con un messaggio. Se la riga nuova manca si indaga l'integrazione, mai a mano.`,
      un paragrafo «**Verificato il 24/09** (solo `SELECT`)». Contiene: deploy `6630315575` `success` alle
      06:39:58; `20260924010455` presente; md5 di `fatture_coda_chiudi` `4869df98…` uguale al file; run «DB
      migrate (prod)» `35956482220` in attesa e **non approvato**; i 13 `gallery.published` inviati alle 06:43,
      0 non inviati, 0 in quarantena.
  - **Riga di stato `:78`**:
    - `🔧 **Consegna 2b** (branch \`fix/coda-fatture-rifiniture-2b\`; lo stato di produzione lo registra la PR di documenti dopo il deploy)`
      diventa
      `✅ **Consegna 2b** ([#163](https://github.com/erricoluigi17/kidville-web/pull/163), in produzione dal 24/09 alle 06:39, migrazione \`20260924010455\` applicata dall'integrazione)`;
    - `(i 13 finiti in quarantena si riprendono con una scrittura dopo il deploy)` diventa
      `(i 13 finiti in quarantena sono stati ripresi e consegnati il 24/09 alle 06:43)`;
    - subito prima di `⏳ **Consegna 2c** (notifiche)`, un frammento di una frase:
      `🔧 **Correzione del 24/09** (branch \`fix/coda-fatture-distanza-signin\`; lo stato di produzione lo registra la PR di documenti dopo il deploy): 65 s fra due accessi ad Aruba della coda, e «Inviata» della sync SdI riconosciuta come «in volo».`
- **HANDOFF.md**:
  - `Stato aggiornato al **24/09/2026 03:20**.`: data e ora vere.
  - `| **Consegna 2b** | — | — |`: la riga al vero. `#163`; merge 24/09 06:38 (`02eb9836`), deploy 06:39:58;
    migrazione `20260924010455` applicata dall'integrazione e verificata (md5 `4869df98d72fe9c07cc4f296cb469fb2`
    uguale al file); run `35956482220` in attesa, **non si approva**. La frase che comincia con
    `⏳ **Da fare dopo il deploy \`READY\`, dalla sessione principale e mostrandola prima**` diventa il fatto:
    i 13 `gallery.published` inviati alle 06:43, 0 in quarantena.
  - Subito dopo, una riga nuova, **Correzione del 24/09**: `—` e `—` nelle colonne PR e Merge; branch
    `fix/coda-fatture-distanza-signin`; in una riga C1–C6 e C8; il nome della migrazione; piano
    `correzione-distanza-signin.md`; «lo stato di produzione lo registra la PR di documenti dopo il deploy».
  - Il paragrafo che comincia con `**Misurato al 24/09 alle 03:18**` si sostituisce con le **prime fatture vere
    del 24/09**. Il cardine (decisione 0) è provato: 15 voci, tutte emesse dal lavoratore, 10 dal cron delle 11:12
    senza nessuno davanti. Poi **il 429 delle 10:09:59** (§0), la pausa fino alle 11:09:59 e la causa in due
    righe, col rimando a questo piano. Restano da guardare dal vivo il chip sulle righe e la stima col giorno.
  - In «Rilievi emersi sul nucleo», dopo (f), un **(g)** chiuso da questa correzione: due giri a pochi secondi,
    un `signin` ciascuno, e il 429 che ferma la coda un'ora.
  - `3. **Cancello Aruba condiviso con la sync SdI**` aggiunge i residui di §1.4: le ricerche contro la sync, le
    route dirette e la pausa di 60 minuti dopo un 429 sul `signin`.
  - Dopo `2. Il titolare chiede tempi brevi: consegne piccole e verificabili.`, la lezione **3**: «Il
    lavoratore unico non distanzia i giri. Ogni giro è un'invocazione, una sessione, un `signin`: il ritmo di
    Aruba (un accesso al minuto) si tiene fra un giro e il successivo, non solo dentro il giro.»
- **nucleo.md**:
  - `- Motore: cron ogni 5 minuti, fuori dalle finestre della sync (:00–:05 e :30–:35); …`: dal 24/09 il giro sta
    fuori da :59–:05 e :29–:35, e fra due giri che accedono ad Aruba passano almeno 65 s;
  - dopo `| \`ultimo_giro_il\` | timestamptz |`, la riga `| \`ultimo_accesso_il\` | timestamptz (dal 24/09) |`;
  - in `fatture_coda_prendi`, al punto 2: «vuoto anche se sono passati meno di 65 s da `ultimo_accesso_il`
    (correzione del 24/09)». Al punto 4: «se consegna almeno una voce, `ultimo_accesso_il = now()`»;
  - in `fatture_coda_rilascia`, dopo `- Libera il lavoratore se il token combacia.`: «per un token che aveva
    preso voci, `ultimo_accesso_il = greatest(…, now())`, anche col testimone scaduto»;
  - §2, punto 1 (`1. **Finestra della sync**: …`): [59,5] e [29,35] dal 24/09, più un punto 1b sull'attesa (C4),
    il suo tetto e i due log.

**Log**: nessuno.

---

## 4. Gate, checklist, rotture

### 4.1 Gate (a compiti finiti; in zsh niente pipe prima di `$?`)

```sh
L=<scratchpad>
npx eslint . --max-warnings 0 > "$L/eslint.log" 2>&1; echo "eslint exit=$?"
npx tsc --noEmit > "$L/tsc.log" 2>&1; echo "tsc exit=$?"
npx vitest run > "$L/vitest.log" 2>&1; echo "vitest exit=$?"; grep -E "Test Files|Tests " "$L/vitest.log"
npm run build > "$L/build.log" 2>&1; echo "build exit=$?"
```

Atteso: tutti `exit=0` e **`Test Files 1442 passed`** (nessun file di test nuovo: se il numero è diverso, lo si
spiega). In CI i job sono due, `quality` ed `e2e`: il verde conta solo con **tutti e due**, e guardando i retry
dell'e2e. Il DB E2E non ha la colonna nuova, e la lettura del giro degrada con un `warn` (C5).

### 4.2 Checklist del critico

1. `git status --porcelain` = i 10 file di §2.3 più questo piano. Nient'altro.
2. La migrazione: nome e timestamp come in §3.1, e con `diff` sono le funzioni del nucleo più i tre blocchi.
   Poi:
   - una sola occorrenza di `interval '65 seconds'` nel testo senza commenti;
   - nessuna parola-guardia;
   - due `REVOKE` e due `GRANT`;
   - la `NOTIFY` in fondo.
3. `giro.ts`:
   - l'attesa sta DOPO la finestra e PRIMA del bidello;
   - la finestra si ricontrolla dopo l'attesa;
   - `contaEmesseUltimaOra` riceve `momento`;
   - `Math.min(…, ATTESA_MASSIMA_MS)` c'è;
   - nessuna attesa con lavoratore attivo, pausa o sospensione;
   - nel docblock non c'è l'espressione cron con asterisco e barra;
   - `EsitoGiroCodice` è invariato.
4. `CodaFinta`: il controllo della distanza sta dopo quello del lavoratore, come nell'SQL, e `rilascia` timbra
   solo per `tokenConVoci`.
5. PGlite: `:633` tolto e sostituito da N1; i sette adattamenti di §3.1 passo 3 e nessun altro; i tre controlli
   negativi; N1–N9.
6. `stato.ts`: una voce `['inviata', 3]`, e `client.ts` invariato.
7. PRD, HANDOFF e nucleo dicono il vero: la 2b in produzione, questa correzione con «lo stato lo registra la PR
   di documenti», nessun «non ancora in produzione». La regex P3 di `pii-nei-file-tracciati` passata a mano su
   PRD, HANDOFF e questo piano non trova niente.

### 4.3 Rompi il codice (copia in scratchpad → modifica → test rosso → `cp` indietro → `shasum` uguale)

| Correzione | Rottura | Deve diventare rosso |
|---|---|---|
| C2 controllo in `prendi` | via il blocco `IF v_stato.ultimo_accesso_il …` | N1 (lo fa già il primo controllo negativo, a ogni esecuzione) |
| C2 | il blocco spostato DOPO la `UPDATE` del testimone | N1 (testimone preso, `ultimo_giro_il` cambiato) |
| C2 | `'65 seconds'` → `'60 seconds'` | N2 (a 64 s consegna) e G6 (i due numeri divergono) |
| C3 timbro della presa | via il blocco `IF v_ids IS NOT NULL …` | N6 (e il terzo controllo negativo) |
| C3 | timbro anche con 0 voci (via la condizione) | N4 |
| C3 timbro del rilascio | via il blocco `IF p_token IS NOT NULL AND EXISTS …` | N3 (e il secondo controllo negativo) |
| C3 | senza la condizione `EXISTS` | N4 e N5 (a) |
| C3 | `= now()` al posto di `GREATEST(…)` | N5 (c) |
| C4 attesa | `attesaPerAccesso` restituisce sempre 0 | G1 (il secondo giro è `niente-da-fare`) |
| C4 | via il ricontrollo della finestra dopo l'attesa | G3 |
| C4 | via una delle tre condizioni «non si aspetta» | G2, nel caso corrispondente |
| C4 | `contaEmesseUltimaOra(sb, adesso)` | G1 (istante del conteggio) |
| C4 | via il `Math.min(…, ATTESA_MASSIMA_MS)` | G8 |
| C5 | su errore di lettura nessun log, o un `throw` | G5 |
| C6 finestra | via `minuto >= 59`, oppure 29 tolto | G7 |
| C8 «Inviata» | via `['inviata', 3]` | `stato` «Inviata è 3»; `client` «quattro diciture misurate» e «NON fanno rumore» |
| C8 | `['inviata', 6]` | `stato` «Inviata è 3» (in attesa, non terminale) |

---

## 5. Dopo il merge

### 5.1 Rilascio (sessione principale)

1. Gate di §4.1 verde, poi il critico. Un commit sul branch, in italiano e con le righe di attribuzione. Il
   commit dice che il `:633` è sostituito da N1 e che sette test sono adattati. Poi push e PR.
2. CI della PR: `quality` ed `e2e` tutti e due verdi, contando i retry.
3. Merge (squash). Il deploy di Vercel parte al push su `main` e non aspetta la CI di `main`: il gate vero è la
   CI della PR.
4. Deploy `READY` (`gh api repos/erricoluigi17/kidville-web/deployments?sha=<merge>` e i suoi `statuses`), poi §5.2.
   **La migrazione la applica l'integrazione Supabase al merge, con la version del file: mai a mano.** Il run
   «DB migrate (prod)» che nascerà **non si approva**.
5. Pulizia dei branch locali e remoti (AGENTS.md, punto 3). Lo stato di produzione di questa correzione
   (PR, merge, deploy, migrazione verificata) lo registra la **PR di documenti** su un branch nuovo da `main`,
   come la 2b.

### 5.2 Verifica (solo `SELECT`, dalla radice del repo)

```sh
supabase db query --linked "select version, name from supabase_migrations.schema_migrations where version >= '20260924010455' order by version"
supabase db query --linked "select name, count(*) from supabase_migrations.schema_migrations group by name having count(*) > 1"
supabase db query --linked "select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'fatture_coda_stato' and column_name = 'ultimo_accesso_il'"
supabase db query --linked "select p.proname, md5(p.prosrc), length(p.prosrc), p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth, has_function_privilege('service_role', p.oid, 'EXECUTE') as sr, pg_get_function_identity_arguments(p.oid) as args from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('fatture_coda_prendi', 'fatture_coda_rilascia') order by 1"
```

L'md5 atteso dei corpi nuovi si calcola dal file:

```sh
python3 - supabase/migrations/<T>_fatture_coda_distanza_accessi.sql <<'EOF'
import sys, hashlib
s = open(sys.argv[1], encoding='utf8').read()
for n in ('fatture_coda_prendi', 'fatture_coda_rilascia'):
    i = s.index('CREATE OR REPLACE FUNCTION public.' + n + '(')
    j = s.index('AS $$', i) + len('AS $$')
    k = s.index('$$;', j)
    print(n, hashlib.md5(s[j:k].encode('utf8')).hexdigest(), len(s[j:k]))
EOF
```

Atteso:
- due righe di migrazione (`20260924010455` e la nuova, con la version del **file**), e nessun nome doppio;
- la colonna `timestamp with time zone`, `YES`;
- **una sola** riga per funzione, con md5 diversi da quelli di prima (`e06cffa4…` e `9cfa221d…`) e uguali a
  quelli del file;
- definer, `search_path=public, pg_temp`, `anon` e `auth` falsi, `sr` vero, argomenti invariati.

Se la riga nuova manca, si indaga l'integrazione: mai a mano.

**Nelle ore dopo** (sole letture):

```sh
supabase db query --linked "select to_char(visto_la_prima at time zone 'Europe/Rome','HH24:MI:SS') as prima, occorrenze, livello, contesto->'campi'->>'esito' as esito from public.app_log where giorno = current_date and contesto->'campi'->>'operazione' = 'fatture-coda/giro' and contesto->'campi'->>'esito' in ('attesa-accesso', 'accesso-non-letto') order by 1"
supabase db query --linked "select count(*) from public.app_log where route = '/api/pagamenti/fattura/coda/giro' and stato_http = 429 and visto_l_ultima > '<deploy UTC>'"
supabase db query --linked "select giorno, occorrenze, visto_l_ultima from public.app_log where messaggio ilike '%fuori tabella%' and visto_l_ultima > '<deploy UTC>'"
supabase db query --linked "select sdi_stato, sdi_stato_label, count(*) from public.fatture_emesse where sdi_stato in (0, 3) group by 1, 2 order by 1"
supabase db query --linked "select to_char(ultimo_accesso_il at time zone 'Europe/Rome', 'YYYY-MM-DD HH24:MI:SS') as ultimo_accesso, lavoratore_token is not null as lavoratore, pausa_fino_a from public.fatture_coda_stato"
```

Atteso:
- nessun 429 del giro dopo il deploy;
- nessuna nuova riga «fuori tabella»;
- dopo il primo giro della sync, nessuna fattura a `sdi_stato` 0 con «Inviata»: diventano 3 «Inviata allo SDI —
  Aruba: «Inviata»», poi 6;
- `ultimo_accesso_il` valorizzato dopo il primo giro con voci;
- `attesa-accesso` solo quando due accodamenti sono vicini;
- `accesso-non-letto` solo nei minuti fra deploy e migrazione, se il codice è arrivato prima.

La prova vera è la prossima mattina di pulsanti ravvicinati: la coda non deve più fermarsi.

---

## Chiusura della sessione principale (24/09 pomeriggio)

Il giro 3 del critico dell'esecuzione ha lasciato due rilievi importanti, entrambi sui test (il codice era giusto):
- **N3** provava il timbro di fine giro in un ordine che il giro non segue (rilascio con la voce ancora `in_invio`).
  Ora segue prendi → chiudi → rilascia, e così il controllo negativo che lo accompagna. `chiudi` non azzera
  `lavoratore_token` in nessun ramo (migrazione `20260924010455`), quindi l'`EXISTS` di `rilascia` scatta anche nell'ordine vero.
- **Il budget dopo l'attesa** non era misurato. Nuovo **G9** in `giro.test.ts`: con fatture da 10 s e un'attesa di 56 s
  il blocco emette le fatture che il budget contato da PRIMA dell'attesa consente, meno di quelle che darebbe
  partendo dopo; le altre restano in coda. Visto rosso con `inizioMs: Date.now()` al posto di `inizioMs: inizio`,
  poi il file rimesso (`shasum` uguale).
I rilievi minori sui numeri del PRD (punti 5 e 7) sono corretti; il margine di 1 s (`MARGINE_OROLOGIO_MS`) resta senza un test che lo fissi.
