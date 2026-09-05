# Piano — Handoff del 5 settembre: stato fattura in lista, guardie, code minori
## Ciclo esecutore (Opus 5) + critico (Fable 5.1), diretto dall'orchestratore (Fable 5.1)

Data: 2026-09-05 · Branch di lavoro: `feat/fatture-movimenti-e-guardie` (nuovo, da `origin/main` = `a945de72`)

---

## 1. Contesto

L'artifact «Handoff: bonifici fatturati e sei code aperte» lascia, dopo il rilascio della PR #116, sette
lavori. Il titolare ha deciso quali entrano e come. Il repository è **pubblico** e in produzione ci sono
dati reali di minori: nessun nome vero in codice, test, report o commit; sul database **solo `SELECT`**.

Stato misurato all'avvio: `origin/main` = `a945de72`; il branch `feat/estratto-conto-xls-intestatario` è
**tutto dentro main** (PR #116 mergiata da quel branch alle 23:07 del 4/09, `git diff origin/main HEAD`
vuoto); l'unica modifica non committata nell'albero è `.claude/settings.json` (permessi, non nostra:
**nessuno la committa**). Baseline dichiarata dall'handoff: 14.033 test verdi su 1.103 file.

## 2. Decisioni del titolare (risposte all'intervista)

| Tema | Decisione |
|---|---|
| Scope | **1a, 1b, 2, 3a, 3b, 3c**. Fuori: 3d (Alto Contrasto, «deciso di rimandare») e sezione 4 (non è codice). |
| Storia git (nomi veri) | Solo il file corrente. **Nessuna riscrittura della storia.** |
| 1a, fattura scartata | **Tre stati** in lista: numero · «Scartata, da riemettere» · «Da fatturare». |
| 1b | Dimostrare con test, dal percorso del movimento, la guardia che esiste; correggere solo se un test la smentisce; **più una guardia difensiva alla conferma** (movimento che porta già un `pagamento_id` con fattura viva → conferma verso un altro pagamento = 409). |
| 3b | **Regola rafforzata**: 409 se una riga viva ha `quota_adult_id` fuori dalle quote correnti (null compreso) **oppure** è di un adulto corrente ma con importo diverso dalla sua quota di oggi. |
| Consegna | **PR mergiata e deploy verificato** dall'orchestratore; poi pulizia dei branch (regola 3). |
| Isolamento | **Stesso albero, file disgiunti.** Nessun esecutore committa: committa l'orchestratore, per percorsi. |
| Tornate | **Nessun tetto**: si va finché ogni critico dà l'ok. |
| PRD | **Un esecutore dedicato alla fine**, col proprio critico; ogni esecutore consegna il testo della propria voce. |
| Branch | Nuovo branch da `origin/main`; **cancellare** il vecchio (locale e remoto). |

## 3. Architettura del ciclo

```
Fase 0  orchestratore: branch nuovo, vecchio cancellato
Onda 1  6 coppie in PARALLELO (perimetri disgiunti):
        E-1a/C-1a · E-1b/C-1b · E-2/C-2 · E-3a/C-3a · E-3b/C-3b · E-3c/C-3c
        per ogni task:  esecutore ──report──▶ critico ──VERDETTO──▶
             OK      → orchestratore committa i soli percorsi del task
             NON OK  → NUOVO esecutore (task di correzione scritto dal critico)
                       ──report──▶ LO STESSO critico (SendMessage) … finché OK
Onda 2  E-PRD/C-PRD (dopo i sei OK) → commit del PRD
Fase F  gate completo → push → PR → CI verde → merge → deploy verificato → pulizia branch → memoria
```

- **Esecutori**: `subagent_type: esecutore-opus` (frontmatter: `claude-opus-5`, effort `max`, skill
  `test-driven-development`, `systematic-debugging`, `verification-before-completion`). Un esecutore = un task.
- **Critici**: `subagent_type: general-purpose`, `model: fable`. Un critico per task, **persistente**: le
  tornate successive dello stesso task tornano allo stesso critico via `SendMessage`, così ricorda cosa ha già
  contestato. Il critico non modifica codice (salvo la mutazione di prova, ripristinata identica, §5.2).
- **Correzioni**: quando il critico dice NON OK, l'orchestratore lancia un **nuovo** esecutore con: la spec del
  task (§7), il report dell'esecutore precedente, l'elenco dei difetti del critico. Nessun tetto di tornate.
- **Chi committa**: solo l'orchestratore, dopo l'OK del critico, con `git add -- <percorsi del task>` (mai
  `git add -A`, mai `.claude/settings.json`). Messaggio in italiano, stile narrativo del repo, con i trailer
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` e `Claude-Session: https://claude.ai/code/session_01HbjzebhpbpTmGBZVZfL4Ym`.
- All'avvio dell'esecuzione questo piano viene copiato in `docs/superpowers/plans/2026-09-05-fatture-movimenti-e-guardie.md`
  (convenzione del repo) e committato con il PRD.

## 4. Regole per TUTTI gli agenti (albero condiviso)

1. **Perimetro**: si toccano solo i file elencati nel proprio task. Serve un file fuori perimetro? Si scrive nel
   report e ci si ferma su quel punto, non si tocca.
2. **Niente git in scrittura** (`commit`, `checkout`, `stash`, `branch`, `reset`, `push`), **niente `npm install`**,
   **niente `npm run build`** (la cartella `.next` è condivisa), **niente E2E** (`npm run e2e`, `playwright` sono in
   `deny`: il seed scriverebbe in produzione).
3. Verifiche ammesse: `npx vitest run <file…>` (solo i propri file + i lock di architettura pertinenti),
   `npx eslint <file…> --max-warnings 0`, `npx tsc --noEmit`. Un rosso transitorio in un file di un altro task
   (mutazione di prova in corso) si rilancia dopo 30 secondi prima di chiamarlo difetto.
4. **Database di produzione: solo `SELECT`** (letture libere, non chiedono conferma). Mai `INSERT/UPDATE/DELETE/DDL`.
5. **Mai dati personali** nel codice, nei test, nei log, nei report, nei messaggi di commit: conteggi, uuid, codici
   d'errore. Un nome d'esempio si inventa e **si conta** (`select count(*)` su `parents.last_name` e `alunni.cognome`);
   cognomi già verificati a zero: `FABBRI`, `BIANCHI`, `PERLINI`. **`ROSSI` non è sicuro.**
6. TDD rigido: **il test si vede rosso prima**; l'output del rosso va incollato nel report.
7. Logging: regole 1-9 di `AGENTS.md`. `withRoute`, `logEvento`/`logErrore`, mai `console.*`, mai un `catch` muto,
   PostgREST **non lancia** (si controlla `{ error }`), redazione a lista bianca.
8. Chiavi i18n nuove: **in coda** al namespace, in `messages/it/<ns>.json` **e** `messages/en/<ns>.json`. **Mai riordinare** un catalogo.
9. Nessuna allowlist/baseline JSON si tocca, nessuna soglia di lock si abbassa, nessuna rotta si toglie da una sonda.
10. Report dell'esecutore (obbligatorio, in questo ordine): file toccati · prova del rosso (output) · comandi di
    verifica con output ed exit code (senza pipe: `$?` dopo una pipe mente) · cosa resta scoperto/warning ·
    **testo proposto per la voce di changelog del PRD** · domande aperte.

## 5. Standard «tripla A» — checklist del critico

Il critico dà **OK** solo se TUTTI i punti reggono; altrimenti **NON OK** con difetti numerati (`file:riga`, cosa
manca, come lo ha verificato) e il **task di correzione** pronto per un nuovo esecutore.

### 5.1 Verifica indipendente (il critico non si fida del report)
- Rilegge il diff dei file dichiarati (`git diff -- <file>`) e li confronta con la spec del task: tutto ciò che è
  chiesto c'è, **niente di più** (nessuna estensione di scope, nessun refactor non richiesto).
- Rilancia lui stesso: i test del task, i lock pertinenti (`__tests__/architecture/logging-coverage.test.ts`,
  `zod-coverage`, `errori-con-codice.test.ts`, `isolamento-sede-coverage.test.ts`, `pii-nei-file-tracciati.test.ts`,
  `__tests__/a11y/testo-muted-allowlist.test.ts`), `npx eslint <file> --max-warnings 0`, `npx tsc --noEmit`.
- Legge l'exit code di ogni comando direttamente, mai dopo una pipe.

### 5.2 Il test deve mordere
- La prova del rosso è nel report; in più il critico **rompe il codice** (una mutazione minima e mirata, es.
  inverte la condizione della guardia) e vede il test diventare rosso, poi **ripristina** e verifica con `git diff`
  che il file sia identico a prima della mutazione. La mutazione dura il tempo di una sola corsa di vitest.
- Nessun mock «piatto»: il fake distingue per tabella e per colonne; un mock che risponde `[]` a ogni tabella
  nuova (`fatture_emesse`) rende verde un codice che non legge niente.
- Le asserzioni sono sul **valore** (numero, codice, esito), non solo sullo status. Niente `getByText` che pesca sosia.

### 5.3 Regole del progetto
- Logging (§4.7) sul codice toccato: un percorso d'errore nuovo senza log = NON OK. Nessun PII nei campi loggati.
- Isolamento di sede: ogni scrittura dichiara la sede; nessuna route «indovina».
- `codice` sulle risposte d'errore nuove (altrimenti si alza `docs/superpowers/errori-senza-codice-allowlist.json`, vietato).
- Design: token Clay Village (`#006A5F` · `#FDC400` · `#FEF1E4`) via classi, mai hex; nessun `text-kidville-muted`
  nuovo; contrasto AA del testo (≥ 4,5:1) sui chip.
- i18n: parità it/en, chiavi in coda, catalogo non riordinato.
- Privacy: il critico stesso ri-esegue le `count(*)` per il task 2 e scandisce il diff per nomi/CF/email.

### 5.4 Il report
Completo (§4.10), con il testo per il PRD misurato (numeri presi dai comandi, non ricordati).

Formato del verdetto: prima riga `VERDETTO: OK` oppure `VERDETTO: NON OK`; poi l'elenco.

## 6. Fase 0 — branch (orchestratore)

```
git checkout -b feat/fatture-movimenti-e-guardie origin/main     # la modifica a .claude/settings.json resta non committata
git branch -D feat/estratto-conto-xls-intestatario
git push origin --delete feat/estratto-conto-xls-intestatario
cp <questo piano> docs/superpowers/plans/2026-09-05-fatture-movimenti-e-guardie.md
```
Nota: `main` è checked-out nel worktree `/Users/lerri/kidville-web-aruba` (fermo a `bc74588c`), quindi qui non si fa
`git checkout main`: si parte da `origin/main`. Il worktree Aruba **non si tocca**.

## 7. I task

Perimetri **disgiunti** per costruzione: nessun file compare in due task. I test nuovi vanno in **file nuovi**
quando il file esistente servirebbe a due task (1a e 1b avrebbero condiviso `__tests__/api/pagamenti-riconciliazione.test.ts`).

### T-1a · Lo stato della fattura nella lista dei movimenti

**Perimetro**: `src/app/api/pagamenti/riconciliazione/route.ts` (solo il GET, righe 323-387) ·
`src/components/features/admin/pagamenti/riconciliazione-ui.ts` ·
`src/components/features/admin/pagamenti/RiconciliazionePanel.tsx` ·
`messages/it/adminContabilita.json` + `messages/en/adminContabilita.json` (append) ·
test nuovi: `__tests__/api/pagamenti-riconciliazione-fatture.test.ts`, `__tests__/components/RiconciliazionePanel-fattura.test.tsx`,
e (se serve un helper puro) `__tests__/pagamenti/riconciliazione-ui-fattura.test.ts`.

**Fatti**: il GET seleziona `id, import_id, scuola_id, data_operazione, importo, causale, controparte, stato, suggerimenti, pagamento_id, confermato_il`
(riga 334), `.limit(500)` (336), nessuna paginazione. La query in blocco da imitare è alle righe 349-384
(raccolta id → `new Set` → uscita anticipata → una `.in()` → degrado con `logEvento(... 'sedi_suggerimenti_non_risolte')` →
`Map` → arricchimento); **attenzione**: oggi esce a riga 353 se non ci sono suggerimenti, e l'arricchimento fattura
deve avvenire **comunque**. `pagamento_id` è valorizzato solo dalla conferma (`[id]/route.ts:175-188`): «già abbinato» = `pagamento_id != null`.
`fatture_emesse` ha `pagamento_id, numero, anno, sezionale (nullable sulle righe storiche), sdi_stato, quota_adult_id, importo`,
indici su `pagamento_id` (`baseline.sql:4205`, `:4212`). Scarto = `sdi_stato != null && mapStatoAruba(sdi_stato).isScarto`
(`src/lib/aruba/stato.ts:34`, stati 2/4/9); definizione di «viva» già in uso in `src/lib/aruba/emissione.ts:991-993`.
Numero: `formattaNumeroFattura(sezionale, numero, anno)` in `src/lib/fatturazione/sezionale.ts:584-602` (`Asilo 2328/2026`,
`FPR 1947/26`; **lancia** su `sezionale` null → ripiego `${numero}/${anno}`). Dedup per quota tenendo il `numero`
massimo, come `src/app/api/pagamenti/fattura/list/route.ts:66-73`. Codici «schema mancante» in `SCHEMA_MANCANTE` (route.ts:309).
Lato UI non esiste mapping: `setMovimenti((movRes.data ?? []) as MovimentoUi[])` (Panel:103), quindi il campo nuovo va
dichiarato in `MovimentoUi` (ui.ts:32-44). La riga è alle righe 257-291 del Panel (colonna destra 277-285: badge CF,
etichetta stato, chevron). Componente `Badge` in `src/components/ui/Badge.tsx` (toni `success|warn|error|neutral`).
Precedente: `FatturaChip.tsx` (chiavi `fatChip_*` in `adminContabilita.json:292-295`). L'allowlist
`docs/superpowers/testo-muted-allowlist.json:424` dichiara `n: 1` **esatto** per il Panel: un `text-kidville-muted` in più rompe il lock.
Il mock della route in `__tests__/api/pagamenti-riconciliazione.test.ts:34-90` risponde `[]` a ogni tabella ignota
(riga 84): un test su `fatture_emesse` deve pilotare esplicitamente la tabella (gancio `_cols`/`h.*`).

**Cosa fare**
1. Backend: raccogli `pagamento_id` distinti delle righe caricate; se nessuno, nessuna query. Altrimenti **una sola**
   `.from('fatture_emesse').select('pagamento_id, numero, anno, sezionale, sdi_stato, quota_adult_id').in('pagamento_id', ids)`.
   Per ogni pagamento: righe vive (non scarto) → dedup per quota (numero massimo) → `fattura: { stato: 'emessa', numeri: string[] }`;
   solo scarti → `{ stato: 'scartata', numeri: [] }`; nessuna riga → `{ stato: 'da_fatturare', numeri: [] }`.
   Righe senza `pagamento_id`: campo assente. Lettura fallita → `fattura: null` su tutte le righe abbinate (è «non lo so»,
   non «no») + `logEvento('pagamento', 'warn', { operazione: 'pagamenti/riconciliazione:GET', esito: 'fatture_movimenti_non_risolte', n }, err)`;
   se il codice è in `SCHEMA_MANCANTE` (DB CI non migrato) livello `info` con esito `fatture_movimenti_schema_assente`.
   L'arricchimento avviene prima/indipendentemente dal ramo suggerimenti; il ramo suggerimenti resta com'è.
2. Tipi: `FatturaMovimentoUi = { stato: 'emessa' | 'scartata' | 'da_fatturare'; numeri: string[] }`; `MovimentoUi.fattura?: FatturaMovimentoUi | null`.
3. UI: nella colonna destra della riga, solo se `m.pagamento_id`: `Badge` tono `success` con «Fattura FPR 1947/26» (più numeri
   uniti da « · »), tono `error` «Scartata, da riemettere», tono `neutral` «Da fatturare»; `fattura === null` → nessun chip.
   Chiavi nuove in coda a `adminContabilita` (it **e** en), es. `reconFatturaEmessa` («Fattura {numeri}»), `reconFatturaScartata`,
   `reconFatturaDaFatturare` (o riuso di `fatChip_da_fatturare`).
4. Test (rosso prima): route — fattura viva → `numeri` contiene `'FPR 1947/26'`; riga storica senza `sezionale` → `'12/2025'`;
   multi-quota → due numeri; solo scarti → `'scartata'`; nessuna riga → `'da_fatturare'`; errore di lettura → `fattura: null` e 200;
   **`from('fatture_emesse')` chiamata una volta sola** con N righe abbinate; righe non abbinate senza campo; i test esistenti del GET
   (suggerimenti, privacy cross-sede) restano verdi. Panel — chip per i tre stati, nessun chip con `null` e sulle righe non confermate;
   il test esistente `RiconciliazionePanel.test.tsx` resta verde.

**Non toccare**: il POST/import, `MovimentoDialog.tsx`, `FatturaButton.tsx`, `FatturaChip.tsx`, le allowlist, `[id]/route.ts`.

**Criteri**: una query in blocco (asserita), tre stati distinti, scarto ≠ emessa, degrado onesto loggato, nessun `text-kidville-muted`
nuovo, it/en, lock `logging-coverage`/`errori-con-codice`/`testo-muted-allowlist`/`isolamento-sede-coverage` verdi.

### T-1b · Un bonifico non si fattura due volte

**Perimetro**: `src/app/api/pagamenti/riconciliazione/[id]/route.ts` (ramo conferma, righe 103-192; select 55-59) ·
test nuovi: `__tests__/api/pagamenti-riconciliazione-conferma-fatturata.test.ts` (route PATCH) e
`__tests__/lib/aruba/emissione-dal-movimento.test.ts` (motore, dal `pagamento_id` di un movimento confermato).

**Fatti (verificati)**: la fattura si emette per `pagamento_id` (`fattura/route.ts:58-73`: nessun `movimento_id`). La
guardia contro il secondo documento è inline in `emettiFatturaPagamento`: righe vive `emissione.ts:991-993`, predicato
`gia` 1044-1055, blocco 409 `gia_emessa_altro_intestatario` 1077-1143 (**prima** della RPC `prossimo_numero_fattura_sezionale` a 1528),
riga «trasporto fallito» (`sdi_stato` e `aruba_filename` nulli) → 409 a 1165-1201. Un movimento `confermato` **non torna
indietro**: `ignora`/`riapri` rispondono 409 (`[id]/route.ts:68-70, 87-89`), lo storno dell'incasso non tocca la tabella,
`hash_movimento` è unico globale (`20260719100000…sql:24-27`). La select del PATCH (riga 57) **non legge `pagamento_id`**.
Copertura esistente da inventariare prima di scrivere: `__tests__/lib/aruba/emissione-intestatario-scelto.test.ts`
(la guardia 409 in tutte le varianti), `emissione-upload-trasporto.test.ts` (riga trasporto fallito), `emissione-gate-numero.test.ts`
(conta `_rpc`; **deve restare verde**), `__tests__/api/pagamenti-riconciliazione.test.ts:234-393` (PATCH: conferma/ignora/riapri, CAS, residuo).
Le risposte d'errore nuove devono avere `codice` (allowlist `errori-senza-codice-allowlist.json`: verificare la voce di `[id]/route.ts`).

**Cosa fare**
1. **Guardia difensiva alla conferma** (dopo la riga 110, prima di ogni lettura/scrittura): aggiungi `pagamento_id` alla select
   (57). Se `mov.pagamento_id != null && mov.pagamento_id !== pagamentoId`: leggi `fatture_emesse` (`numero, anno, sezionale, sdi_stato`)
   per `mov.pagamento_id`; lettura fallita → **503** fail-closed con `codice: 'BONIFICO_FATTURA_NON_VERIFICABILE'` (nessuna
   scrittura avvenuta) + `logErrore`; una riga viva (`mapStatoAruba(...).isScarto` falso) → **409** `codice: 'BONIFICO_GIA_FATTURATO'`
   con il numero nel messaggio + `logEvento('pagamento', 'warn', { operazione: 'pagamenti/riconciliazione/[id]:PATCH', esito: 'bonifico-gia-fatturato-fermato', pagamento_id, numero, anno })`.
   Stesso `pagamento_id` o nessun `pagamento_id` precedente → nessuna lettura di `fatture_emesse` (asserito nei test).
2. **Test della guardia nuova** (file nuovo, mock copiato dal pattern esistente, con `fatture_emesse` pilotata per tabella):
   vecchio pagamento con fattura viva → 409 + `codice`, **zero insert in `incassi`**, zero update; solo scarti → prosegue;
   stesso pagamento → prosegue senza leggere `fatture_emesse`; lettura fallita → 503, zero scritture; i test PATCH esistenti restano verdi
   (la fixture senza `pagamento_id` non attiva la guardia).
3. **Dimostrazione dal percorso del movimento** (file nuovo, fake alla `emissione-gate-numero.test.ts:49-71` con `fatture_emesse`
   thenable per tabella): dato un movimento `confermato` con `pagamento_id`, seconda `emettiFatturaPagamento` sullo stesso
   `pagamento_id` — (a) stesso intestatario → `ok: true` idempotente, **`_rpc` mai chiamata**, nessun upload, `_inserts` vuoto;
   (b) intestatario diverso → 409 `gia_emessa_altro_intestatario`, `_rpc` mai chiamata; (c) riga trasporto fallito → 409 con
   «trasporto» nel messaggio, `_rpc` mai chiamata; (d) solo scarti → si riemette, `_rpc` una volta. Prima di scrivere, l'esecutore
   elenca nel report quali di (a)-(d) sono già coperti altrove e **non duplica alla cieca**: scrive ciò che manca o ciò che
   nessun test inquadra dal movimento. Se un test smentisce la guardia, la corregge in `emissione.ts` **solo dopo aver avvisato**
   (quel file è di T-3b: si coordina tramite l'orchestratore).

**Non toccare**: `emissione.ts` (salvo il caso sopra), `fattura/route.ts`, `MovimentoDialog.tsx`, il file di test esistente.

**Criteri**: nessuna scrittura prima del rifiuto (asserito), `codice` sulle risposte nuove, log sul percorso d'errore,
`emissione-gate-numero.test.ts` verde, lock verdi.

### T-2 · Nomi inventati in `abbinamento.test.ts`

**Perimetro**: `__tests__/lib/iscrizioni/abbinamento.test.ts` **soltanto**.

**Fatti**: il file (176 righe) dichiara alle righe 13-16 e 32 che i casi sono presi dal file vero di Giugliano. I nomi veri
sono nella fixture `ELENCO` (17 voci, righe 33-51), nelle 8 chiamate a `normalizzaNome` (55-74), nelle 8 chiamate ad
`abbina` (86-143, `it.each` 125-131) e negli attrezzi (157-168). Modulo sotto test: `src/lib/iscrizioni/import/abbinamento.ts`
(tre tentativi in cascata: uguaglianza normalizzata 75, stessi token 79, saldatura 83; `piuSimili` 94-99 ordina per Dice sui
bigrammi con tie-break `localeCompare`) e `normalizza.ts` (NFD, maiuscole, parentesi, apostrofi → spazio, collasso spazi, trim).
Nessun lock copre i nomi nei sorgenti di test (`pii-nei-file-tracciati.test.ts:56-70` esclude `.ts`).

**Vincoli da preservare** (ogni asserzione dipende dalla stringa):
riga 55 sola differenza di maiuscole · 59 accento · 63/64 apostrofo dritto **e** curvo · 68/69 doppio spazio, spazio finale,
spazio iniziale · 73/74 parentesi staccata **e** attaccata · 92/162 esattamente due token invertibili · 98/104/157-158
nome multi-parola con spazio che cade in punti diversi · 110/119 stesso nome su **due classi** · 88/94/100/106/114 legame
nome→classe · `it.each` 126-131: sei coppie «somiglia ma non è uguale» (una lettera sostituita, una vocale in meno, una
consonante in meno, doppia scempiata, due nomi saldati e invertiti, secondo nome aggiunto) e alla riga 137 la riga attesa deve
essere il **massimo assoluto** di similarità fra le 17 · 167: coppia di **14 caratteri** con **una** lettera diversa > 0,8 ·
168: < 0,3 · 143/149/172-174 invariati nella forma.

**Cosa fare**
1. Inventa un elenco di cognomi e nomi (cognomi verificati **a zero** con `SELECT count(*) FROM parents WHERE upper(last_name)=…`
   e `… FROM alunni WHERE upper(cognome)=…`; riusa `FABBRI`, `BIANCHI`, `PERLINI`; mai `ROSSI`). Nel report solo i conteggi.
2. Riscrivi fixture, chiamate e i commenti di testa (modello: `__tests__/lib/iscrizioni/elenco.test.ts:8-13` — «nomi INVENTATI,
   la FORMA è quella misurata il 2026-08-16»), preservando ogni vincolo sopra. Classi, importi e numeri di rigo possono restare.
3. Verifica: il file è verde; poi **rompi** `normalizzaNome` (es. togli la regola dell'apostrofo) e `piuSimili` (ordine) e guarda
   i test relativi diventare rossi; ripristina. `git grep` dei vecchi cognomi su tutto l'albero: **0** occorrenze (nel report
   solo il numero, mai le stringhe).

**Criteri**: nessun nome della fixture precedente sopravvive nell'albero; ogni asserzione ancora vincolante (dimostrato con le
mutazioni); conteggi DB a zero ri-eseguiti dal critico; nessun nome nel report/commit.

### T-3a · Contrasto nel calendario mensa

**Perimetro**: `src/components/features/parent/mensa/MensaCalendar.tsx` (**solo la riga 322**) · test nuovo
`__tests__/components/MensaCalendar-stato-vuoto.test.tsx` (se un test del componente esiste già, lo si estende).

**Fatti**: riga 322 `font-maven text-sm text-kidville-muted text-center py-8` = stato vuoto (`mensa.nessunGiorno`), letto da un
genitore; `muted` = `#7B8582` = 3,43:1 su crema (`globals.css:86-106`, «per il TESTO la destinazione resta `sub`»);
`sub` = `#55615C` ≥ 5,2:1 ovunque. Stessa correzione già fatta in `fc5d0033` (solo `text-kidville-muted` → `text-kidville-sub`,
JSON non toccato). Allowlist `docs/superpowers/testo-muted-allowlist.json:619-622` dichiara `n: 5`; il lock
(`__tests__/a11y/testo-muted-allowlist.test.ts:239-251`) accetta `misurati < dichiarati`. Le altre occorrenze nel file:
262, 346, 354, 391.

**Cosa fare**: test che rende lo stato vuoto e asserisce `text-kidville-sub` e l'assenza di `text-kidville-muted` su quel
paragrafo (rosso prima); sostituzione alla 322; il lock resta verde **senza toccare il JSON**. Nel report: cosa sono le altre
quattro occorrenze (testo letto o decorazione), **senza toccarle**.

**Criteri**: un solo attributo cambiato, JSON intatto, lock verde, test che morde.

### T-3b · Guardia multi-quota sulle righe estranee (409)

**Perimetro**: `src/lib/aruba/emissione.ts` (tipo `EsitoQuota` 120-143; select 904-907; blocco fra 993 e 996; mappa dei motivi
1913/1932) · `src/app/api/pagamenti/fattura/route.ts` (mappa `codice`, righe 83-85 e 197-218) · test nuovi:
`__tests__/lib/aruba/emissione-multi-quota-estranea.test.ts`, `__tests__/api/fattura-route-quota-estranea.test.ts`.

**Fatti**: `multi = quote.length > 1` (869); le quote correnti vengono da `determinaQuoteFatturazione`
(`src/lib/pagamenti/intestatari.ts:326`, ramo separati 345-388); nel multi il predicato `gia` confronta solo `quota_adult_id`
(1045-1046) e la guardia 409 è esclusa da `!multi` (1077). `viveNonScartate` è calcolato fuori dal ciclo (991-993); l'ultimo punto
sicuro prima di consumare un numero è l'inizio del ciclo (996); `fatture_emesse.importo` esiste (`baseline.sql:1497`) ma
**non è nella select** (906). Test esistenti da tenere verdi: `__tests__/api/fattura-emissione-split.test.ts:120-231`
(2 quote → 2 righe; re-run idempotente; quota scartata riemessa), `emissione-intestatario-scelto.test.ts`, `emissione-gate-numero.test.ts`.

**Regola (rafforzata, decisa dal titolare)**: se `multi`, prima del ciclo: `correnti = Map(adultId → importo quota)`;
una riga viva è **estranea** se `quota_adult_id == null`, **oppure** non è in `correnti`, **oppure** il suo `importo`
(arrotondato al centesimo) ≠ l'importo della quota corrente di quell'adulto. Se ne esiste una → esito 409 per **tutte** le quote,
`motivo: 'quota_estranea'`, nessuna RPC, nessun upload, nessun insert; messaggio con il numero della riga (formato come 1093-1096)
e l'indicazione che serve una nota di variazione; `logEvento('fattura', 'warn', { operazione: 'emettiFatturaPagamento:multi-quota', esito: 'riga-viva-estranea-fermata', provider: 'aruba', scuola_id, pagamento_id, numero, anno, n_quote })`.
Route: `codice: 'FATTURA_RIGA_VIVA_ESTRANEA_ALLE_QUOTE'` sul motivo nuovo, come i tre esistenti (197-208).

**Test** (rosso prima, fake alla `gate-numero` con `fatture_emesse` thenable e `rpc` contata): fattura intera ad A (150) poi
split A/B 75/75 → 409 per entrambe, `_rpc` mai chiamata; riga viva con `quota_adult_id` null → 409; riga di un adulto C fuori
da A/B → 409; righe A 75 e B 75 già vive → idempotente (verde come oggi); A viva + B scartata → B si riemette; route: motivo
nuovo → 409 con `codice`. `emissione-gate-numero.test.ts` e i test split esistenti verdi.

**Non toccare**: `intestatari.ts`, `legami.ts` (sono di T-3c), le allowlist.

**Criteri**: nessun numero consumato (asserito), `codice`, log, regola rafforzata coperta caso per caso, lock verdi.

### T-3c · `getGenitoriDiAlunno`: «non lo so» invece di «no»

**Perimetro**: `src/lib/anagrafiche/legami.ts` (121-178) · `src/lib/pagamenti/intestatari.ts` (docblock 206-214; `identitaGenitoriDiAlunno`
249-287; `adultoEGenitoreDi` 303-314) · `__tests__/lib/legami.test.ts` · test nuovo `__tests__/lib/aruba/emissione-legami-non-verificabili.test.ts`.

**Fatti**: la lettura di `legame_genitori_alunni` (`legami.ts:136-141`) su errore chiama `segnalaLetturaLegami` (warn) e
prosegue; nessun flag di completezza risale. `identitaGenitoriDiAlunno` calcola `completo` (283) **senza** questa lettura;
`adultoEGenitoreDi` ritorna `null` solo se `!completo` (313); `emissione.ts:822-839` mappa `null` → **503**
`legami-non-verificabili`, nessun numero consumato; `false` → 422. Modello da seguire: `getFigliDiGenitoreEsito` (`legami.ts:61-97`)
con `registra()` (68-71) che abbassa `completo` **tranne** per i codici `SCHEMA_ASSENTE` (53-59: DB CI non migrato non è un guasto).
Altri 7 chiamanti di `getGenitoriDiAlunno` (solleciti, mensa, merch, diary, modulistica, intestatario-pagamento): **comportamento invariato**.

**Cosa fare**: nuova `getGenitoriDiAlunnoEsito(...)` → `{ genitori: string[]; completo: boolean }` (e la variante plurale se serve),
`completo=false` se una delle tre letture fallisce con codice non in `SCHEMA_ASSENTE`; `getGenitoriDiAlunno` resta com'è (wrapper).
`identitaGenitoriDiAlunno` usa la variante Esito e fonde `completo`. Aggiorna il docblock 206-214 (il caso è coperto).
Test (rosso prima): legami — errore su `legame_genitori_alunni` → `completo=false` e gli altri genitori ci sono; codice `PGRST205` →
`completo=true`; intestatari — `completo=false` → `adultoEGenitoreDi` = `null`; motore — errore su quella sola lettura con
intestatario scelto → **503**, `_rpc` mai chiamata, log `error` `legami-non-verificabili` presente.

**Non toccare**: `emissione.ts` (di T-3b), gli altri chiamanti.

**Criteri**: 503 e non 422 nel caso descritto; CI non migrata non degrada; chiamanti invariati (test esistenti verdi); log presenti.

### T-PRD · Il PRD nello stesso lavoro (dopo i sei OK)

**Perimetro**: `PRD REGISTRO ELETTRONICO.md`.

**Fatti**: changelog in ordine cronologico inverso, voce più recente alla riga 133, formato
`## <emoji> Changelog — <frase che nomina il difetto> — YYYY-MM-DD (branch \`<branch>\`)`, poi **Segnalazione** fra virgolette,
conteggio dei difetti veri, sezioni numerate/tabelle. Tabella «Moduli Implementati» riga 70 («Contabilità (Pagamenti)») è
l'unica che copre riconciliazione e fattura.

**Cosa fare**: una voce nuova datata 2026-09-05 (branch `feat/fatture-movimenti-e-guardie`) che racconta i sei lavori con i
numeri **presi dai report** degli esecutori (test aggiunti, occorrenze, conteggi a zero — mai i nomi); aggiorna la riga 70
(stato fattura in lista, guardia alla conferma, guardia multi-quota rafforzata, lettura legami «non lo so»); nota il limite
rimasto: nessun lock impedisce nomi veri nei sorgenti di test (`pii-nei-file-tracciati.test.ts:56-70`), la storia git non è stata riscritta.

**Criteri**: ogni affermazione tracciabile a un report; formato identico alle voci precedenti; nessun PII; nessun'altra riga toccata.

## 8. Fase finale (orchestratore)

1. **Gate completo**, exit code letto uno per uno: `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run`
   (0 falliti; conteggio ≥ 14.033 + i test nuovi) · `npm run build`. Un rosso → task di correzione al critico del task responsabile.
2. Commit del PRD + copia del piano; `git push -u origin feat/fatture-movimenti-e-guardie`.
3. `gh pr create --base main` con titolo narrativo e corpo (cosa, numeri misurati, rilievi rimasti, trailer
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)` + link sessione).
4. `gh pr checks --watch`: entrambi i check (`Lint · Typecheck · Unit`, `E2E (Playwright)`); leggere i log E2E e **contare i `retry #`**
   (un job verde con retry è una degradazione, non un successo).
5. `gh pr merge --squash --delete-branch` (main usa lo squash: `(#116)`).
6. Deploy: attendere `READY` su Vercel per il commit di merge; `curl https://app.kidville.it/api/health` → 6/6 e versione = commit di merge.
7. `migrate.yml`: leggere lo stato della run armata dal merge; **non approvare** (nessuna migrazione in questo lavoro): riferire.
8. Pulizia (regola 3): `git fetch --prune`, `git checkout --detach origin/main`, `git branch -D feat/fatture-movimenti-e-guardie`;
   verificare che sul remoto resti solo `main`.
9. Memoria: una nota con le lezioni non ovvie (es. il «buco del riabbinamento» che non esisteva: `riapri` rifiuta i confermati)
   e l'aggiornamento dell'indice `MEMORY.md` (una riga, sotto 200 caratteri).

## 9. Verifica end-to-end

- Gate locale verde (4 comandi) + CI verde senza retry + deploy `READY` + `/api/health` 6/6 sulla versione nuova.
- Prova funzionale in produzione **in sola lettura**: `GET /api/pagamenti/riconciliazione` come staff mostra `fattura` sulle righe
  abbinate (oggi `riconciliazione_movimenti` ha 0 righe: il campo è inerte finché non si carica un estratto conto; si verifica
  che la risposta sia 200 e la lista vuota, e il comportamento con i test).
- `SELECT count(*) FROM enrollment_submissions` prima del merge (misurare, non copiare) — solo per il resoconto.

## 10. Riferimenti riusabili (già nel repo)

`mapStatoAruba` · `formattaNumeroFattura` · pattern «query in blocco» `riconciliazione/route.ts:349-384` · fake con contatori
`emissione-gate-numero.test.ts:49-71` · `getFigliDiGenitoreEsito` + `registra()` `legami.ts:61-97` · mappa `codice`
`fattura/route.ts:83-85,197-218` · `Badge` · pattern 503 fail-closed `emissione.ts:908-923`.
