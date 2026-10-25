# Sessione 10 — Operazioni a più passi senza perdite — piano di implementazione

> **Per chi esegue:** sotto-skill obbligatoria `superpowers:subagent-driven-development` (consigliata) oppure `superpowers:executing-plans`; i passi usano le caselle (`- [ ]`).

**Obiettivo:** nessun passo irreversibile (file cancellati, prese visione tolte) avviene prima dei passi che possono ancora fallire, in tre operazioni: eliminazione di un membro del personale, riapertura di uno scrutinio, modifica di una nota.

**Architettura:**
- **Personale.** L'ordine diventa *lettura → poteri → righe in una transazione → account → file nel cestino*. Una funzione nuova, `personale_elimina_dipendente`, cancella pratica d'origine, fascicolo e profilo (`public.utenti`) tutti insieme o nessuno: se una chiave senza cascata trattiene il profilo risponde `23503` e la route archivia senza aver toccato un file. Le scansioni non si cancellano più: si **spostano** in `cestino/<giorno>/` dello stesso bucket, e il giro notturno `cestino-registro-retention` le distrugge passato il termine del cestino.
- **Scrutinio.** La riapertura **copia** ogni pagella consegnata in `ritirate/<scrutinio>/<alunno>-<istante>.pdf`, marca la riga (`ritirata_il`, più la copia in `file_ritirati`) e solo dopo toglie i PDF dalla cartella dello scrutinio. Due colonne nuove su `pagelle`, perché il vincolo di unicità su scrutinio e alunno tiene una riga per alunno: la generazione successiva la rimette in vigore. Senza le colonne (DB della CI) si fa come prima, e lo si dice.
- **Note.** Una funzione transazionale, `note_modifica`, toglie la presa visione **solo** alle note a cui cambia il testo, e lo fa nella stessa transazione dell'aggiornamento. Merchandise e sedi: un test ciascuna sulle compensazioni che già ci sono.

**Tecnologie:** Postgres 17 su Supabase (PL/pgSQL, `SECURITY DEFINER` con `search_path` fisso), PGlite (`@electric-sql/pglite`) per provare le migrazioni lette dal disco, Next 16 App Router (route in `withRoute`), `@supabase/storage-js` (`copy`, `move`, `list` paginato, `remove`), vitest.

**Specifica:** `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md`, §7 «Sessione 10» (righe 640-673 alla rilettura della sera del 20/10), regole comuni della §5 (righe 133-197), §6 «Apertura e chiusura» e «Per la sessione dopo» (righe 237-243), la riga `| 10 |` della tabella di stato (si trova con `grep -n "^| 10 |"`, mai per numero di riga). I numeri di riga sono una comodità di lettura: le sezioni si cercano per titolo.

---

## Mappa dei file

| File | Ruolo | Righe lette |
|---|---|---|
| `__tests__/fixtures/migrazioni-applicate-snapshot.json` e i file che nomina la sezione «Per la sessione dopo» del piano della sessione rilasciata per ultima | **Modifica.** Chiusura della precedente (Compito 1, Passo 4): fotografia delle migrazioni rigenerata dalla produzione, più quello che quella sezione elenca | procedura in testa a `__tests__/fixtures/migrazioni-fotografia.mjs` (righe 18-28) |
| `supabase/migrations/<V1>_personale_elimina_dipendente.sql` | **Crea.** `personale_elimina_dipendente(uuid, uuid)`; commento nuovo a `personale_cancella_fascicolo` | nuovo |
| `supabase/migrations/<V2>_pagelle_ritirate.sql` | **Crea.** `pagelle.ritirata_il`, `pagelle.file_ritirati` | nuovo |
| `supabase/migrations/<V3>_note_modifica.sql` | **Crea.** `note_modifica(...)` | nuovo |
| `supabase/migrations/20260920001032_docente_archiviato_e_cancella_fascicolo.sql` | Sola lettura: `personale_cancella_fascicolo`, REVOKE e COMMENT | la funzione, le tre revoche, il commento |
| `supabase/migrations/20260704120000_baseline.sql` | Sola lettura: `nota_ricezioni` 2050-2057, `note_disciplinari` 2066-2080, `pagelle` 2218-2226, vincoli di `pagelle` 3548 e 5752-5768 | quelle righe |
| `supabase/migrations/20261015183000_storici_stampe_rettifiche.sql` | Sola lettura: `note_disciplinari.data_evento` (451) | 451 |
| `supabase/migrations/20261019223123_battiti_app_log_che_contano.sql` | Sola lettura: modello della sezione ROLLBACK (95-97) | 59-98 |
| `src/lib/storage/copia-verificata.ts` | **Crea.** `copiaNelBucket`, `oggettoAssente`, `destinazioneGiaPresente` | nuovo |
| `__tests__/lib/copia-verificata.test.ts` | **Crea.** | nuovo |
| `src/lib/storage/cestino-file.ts` | **Crea.** `spostaNelCestino`, `svuotaCestinoScaduto` | nuovo |
| `__tests__/lib/cestino-file.test.ts` | **Crea.** | nuovo |
| `src/lib/storage/rimozione-verificata.ts` | **Non cambia.** `rimuoviEVerifica` (156), `bloccanti` (61), verifica con `list(cartella, { limit: 100, search })` (131-149) | 40-170 |
| `src/lib/db/colonna-assente.ts`, `src/lib/db/tolleranza-schema.ts` | **Non cambiano.** `colonnaNuovaAssente` (13); `tolleranza-schema` non si allarga (specifica §5) | 1-16; 50-63 |
| `src/app/api/avvisi/[id]/risposte/route.ts` | **Non cambia.** `RPC_ASSENTE` (71), modello dei due insiemi locali di questa sessione (`PERSONALE_ELIMINA_ASSENTE` nel Compito 8, `NOTE_MODIFICA_ASSENTE` nel Compito 14): nessun modulo condiviso, specifica §5 | 60-71, 629-660 |
| `__tests__/lib/personale-elimina-dipendente-sql.test.ts` | **Crea.** PGlite, migrazione letta dal disco | nuovo |
| `src/lib/personale/cancella-fascicolo.ts` | **Modifica 1-167** (riscritto): lettura, righe, cestino separati; l'insieme locale `PERSONALE_ELIMINA_ASSENTE` | 1-167 |
| `src/lib/personale/caricamenti.ts` | **Non cambia.** `BUCKET_DOCUMENTI_PERSONALE` (82); importa solo logger e rimozione verificata | 1-3, 82 |
| `src/app/api/admin/staff/eliminazione/route.ts` | **Modifica 15** (import) **e 424-500** (`cancella`) | 1-40, 330-501 |
| `__tests__/api/staff-eliminazione.test.ts` | **Modifica 18-31, 34-46, 65-74, 121-125, 150-166, 281-336** | 1-337 |
| `src/app/api/admin/staff/riporta-a-genitore/route.ts` | **Non cambia.** Usa `ok`, `motivo`, `fileRimossi`, `praticheCancellate` (196-263) | 190-263 |
| `__tests__/api/staff-riporta-a-genitore.test.ts` | **Modifica 27-38, 48-54, 128-132, 178-191**, un caso nuovo | 25-215 |
| `src/app/api/gdpr/retention-cestino-registro/route.ts` | **Modifica 1-17** (import) **e 682-800** (POST) | 1-22, 125, 257-317, 682-800 |
| `__tests__/api/gdpr-retention-cestino-registro.test.ts` | **Modifica 163-170** (`list`), tre casi dopo 479, un caso dopo 870 | 5-300, 807-882 |
| `__tests__/lib/pagelle-ritirate-sql.test.ts` | **Crea.** PGlite | nuovo |
| `src/lib/primaria/pagelle-ritirate.ts` | **Crea.** `percorsoPagellaRitirata`, `pagelleInVigore` | nuovo |
| `__tests__/lib/pagelle-ritirate.test.ts` | **Crea.** Anche `persistPagella` | nuovo |
| `src/lib/primaria/pagella-store.ts` | **Modifica 209-219** (`persistPagella`) | 1-30, 189-220 |
| `src/app/api/primaria/scrutinio/riapri/route.ts` | **Modifica** intero (272 righe): import, commento, passo 2, audit, log, risposta | 1-272 |
| `__tests__/api/primaria-scrutinio-riapri.test.ts` | **Modifica 4-14, 25-89, 148-174, 236-374, 403-444**, casi nuovi | 1-526 |
| `src/app/api/primaria/scrutinio/route.ts` | **Modifica 1-13** (import) **e 282-284** | 1-16, 270-306 |
| `__tests__/api/primaria-scrutinio-pagelle-archiviate.test.ts` | **Modifica 17-40, 105-110**, un caso | 1-143 |
| `src/app/api/primaria/pagella/route.ts` | **Modifica 1-12, 105-110, 124-139, 173-255** | 1-20, 80-264 |
| `__tests__/api/primaria-pagella-elimina.test.ts` | Un `describe` nuovo dopo 352 (quattro casi) | 1-190, 230-369, 354-436 (titoli) |
| `src/lib/gdpr/esegui.ts` | **Modifica 784-803** (`obliaPagelleAlunno`) | 1-22, 213, 615-803, 1250-1291 |
| `__tests__/lib/gdpr-oblio-storage-verificato.test.ts` | **Modifica 57**, un `describe` in fondo (due casi) | 1-240, titoli fino a 352 |
| `src/lib/storici/adattatori/scolastici-primaria.ts` | **Modifica 191-192** (`pagelle()`) | 170-198 |
| `src/lib/storici/adattatori/scolastici-comune.ts` | **Non cambia.** `perIds` legge `*` (77-87), `allegato` (105-119) | 77-122 |
| `__tests__/lib/storici-scolastici.test.ts` | Due casi dopo 447 | 1-70, 430-455 |
| `src/components/features/primaria/AzioniScrutinio.tsx` | **Modifica 134** | 70-76, 125-140 |
| `messages/it/teacherPrimaria.json`, `messages/en/teacherPrimaria.json` | **Modifica 369, 371, 374** | 366-376 |
| `__tests__/components/AzioniScrutinio.test.tsx` | **Modifica 11, 171, 186, 188, 191, 194, 203, 204, 206, 215, 230, 365, 430, 432**, un caso | 155-235, 365, 415-436 |
| `__tests__/lib/note-modifica-sql.test.ts` | **Crea.** PGlite | nuovo |
| `src/app/api/primaria/note/route.ts` | **Modifica 564-568** (commento), **610-645** (i due rami), **682-690** (log); prima di 564 l'insieme locale `NOTE_MODIFICA_ASSENTE` e la funzione nuova. Gli import non cambiano (`logErrore`, `logEvento` alla riga 27, `SupabaseClient` alla 7) | 1-73, 160-175, 530-710 |
| `__tests__/api/primaria-note-modifica-elimina.test.ts` | **Modifica 52-70, 169, 191-199, 224-236, 327-328, 577-586**, describe nuovo | 1-380, 540-627 |
| `src/lib/primaria/rettifica-storica.ts` | **Non cambia.** `AzioneStorica` (11), `righe` per azione (17-28) | 11-28 |
| `src/app/api/admin/merch/ordini/route.ts` | **Non cambia.** `disfa` (189-198) logga già ogni compensazione non riuscita | 180-230 |
| `__tests__/api/admin-guasti-db-non-diventano-valori.test.ts` | Un caso dopo il test «ordine: il collegamento ordine→addebito fallisce…» (righe 178-186 al 20/10; la sessione 2 toglie un import più in alto, quindi si cerca il titolo) | 18-66, 109, 125, 150-203 |
| `src/app/api/admin/schools/route.ts` | **Modifica 349-351** (il blocco `if (cleanupErr)` con `evento: 'db-fallback-cleanup'`). Le risposte con `error.message` del file (righe 269, 304, 320, 334, 352) **restano come sono**: le sistemano solo le sessioni successive alla 13 (specifica §7 «Sessione 13») | 320-362 |
| `__tests__/api/admin-schools-provisioning.test.ts` | Un caso dopo il test «degrade: insert scuole fallito → cleanup della riga schools + 500» (righe 194-203 al 20/10) | 1-122, 186-210 |
| `PRD REGISTRO ELETTRONICO.md` | **Modifica.** Changelog in cima (prima della riga 1) | 1-12 |
| `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` | **Modifica** la riga della sessione 10 nella tabella di stato (trovata col `grep` del Compito 1, Passo 7, mai per numero di riga): «Note» al Compito 1, «in revisione» al Compito 18; e la riga della sessione chiusa al Compito 1 | 21-42, 133-197, 237-243, 640-673 |
| `__tests__/fixtures/finto-supabase.ts` | **Non cambia.** `opzioni.rpc` (123), `rpc()` che lancia se non emulata (933-943) | 96-125, 925-954 |
| `__tests__/lib/gdpr-oblio-completo.test.ts` | **Non cambia.** Il finto risponde `PGRST205` a ogni lettura di `pagelle` (818): il ripiego dell'oblio lo deve tacere | 600-640, 806-840 |

`<V1>`, `<V2>`, `<V3>` sono le version scritte al momento con `date -u +%Y%m%d%H%M%S`, mai un orario tondo e mai nel futuro.

---

## Passo 0 — misura prima

Tutto in **sola lettura**: strumento MCP `execute_sql` sul progetto di produzione, solo `SELECT`. Si leggono conteggi, nomi di tabelle e di colonne, impronte di funzioni: **mai** il contenuto di pagelle, note o fascicoli del personale, nemmeno una riga. I numeri finiscono nel file delle misure `${TMPDIR:-/tmp}/s10-misure.env` (fuori dal repository, una riga `CHIAVE=valore` per numero) e da lì nel PRD (Compito 17).

### Compito 1 — Prerequisiti, worktree, chiusura della sessione precedente, decisioni

**File:**
- Modifica: `__tests__/fixtures/migrazioni-applicate-snapshot.json`, più i file che elenca la sezione «Per la sessione dopo» del piano della sessione rilasciata per ultima (Passo 4)
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (la riga della sessione chiusa al Passo 4; la colonna «Note» della riga della sessione 10 al Passo 7)
- Modifica: `PRD REGISTRO ELETTRONICO.md` (lo Stato della voce della sessione chiusa, Passo 4)

- [ ] **Passo 1: i prerequisiti — la sessione 3 (colonna «Dopo») è mergiata e le sue migrazioni sono applicate**

Si verificano due **fatti**, mai il testo dello «Stato» della tabella: lo «Stato» di una sessione lo porta a «in produzione» la sessione aperta dopo di lei (specifica §5, «Apertura di una sessione: i prerequisiti»).

```bash
git -C /Users/lerri/kidville-web fetch origin
git -C /Users/lerri/kidville-web cat-file -e origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md && echo specifica-presente
git -C /Users/lerri/kidville-web show origin/main:docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md | grep "^| 10 |"
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s03-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
git -C /Users/lerri/kidville-web ls-tree --name-only origin/main supabase/migrations/ | grep -E "_scatola_nera_(cascate_anagrafiche|protocollo)\.sql$"
```

Atteso: `specifica-presente`; la riga della sessione 10, con `3` nella colonna «Dopo»; **una** riga dalla `gh` (numero e istante del merge della sessione 3); **due** file della sessione 3, `<version>_scatola_nera_cascate_anagrafiche.sql` e `<version>_scatola_nera_protocollo.sql`. Poi, in sola lettura sulla produzione (strumento MCP `execute_sql`, solo `SELECT`):

```sql
SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE name IN ('scatola_nera_cascate_anagrafiche', 'scatola_nera_protocollo')
 ORDER BY version;
```

Atteso: **due** righe, con le **stesse** version dei due file elencati sopra (l'integrazione applica una migrazione con la version del file). Infine nessuna PR `robustezza2/` aperta, salvo i rami `-esito`:

```bash
gh pr list --repo erricoluigi17/kidville-web --state open --search "head:robustezza2/" --json number,headRefName --jq '.[] | select(.headRefName | endswith("-esito") | not) | "\(.number) \(.headRefName)"'
```

Atteso: nessuna riga. Se uno qualunque di questi controlli non torna, **fermati**: la sessione 10 vuole la 3 in produzione (specifica §3, «3 → 10»: le righe sono già al sicuro nella scatola nera, qui si mettono al sicuro i file), e una PR della serie ancora aperta vuol dire che un'altra sessione non è chiusa.

- [ ] **Passo 2: worktree e ramo da `origin/main`**

```bash
git -C /Users/lerri/kidville-web worktree add -b robustezza2/s10-operazioni-a-piu-passi /Users/lerri/kidville-web-s10-operazioni origin/main
cd /Users/lerri/kidville-web-s10-operazioni && git status -sb | head -3
```

Atteso: `## robustezza2/s10-operazioni-a-piu-passi...origin/main`, albero pulito. Da qui in poi ogni comando gira in `/Users/lerri/kidville-web-s10-operazioni`; mai nel checkout principale, dove lavorano altre sessioni. Il nome del ramo è quello del file del piano senza la data: la sessione dopo lo usa per ritrovare questo piano.

- [ ] **Passo 3: `.env.local` e dipendenze**

Un worktree nuovo nasce senza `.env.local`. **Chiedi al titolare** se puoi copiarlo dal checkout principale, e copialo solo se risponde sì:

```bash
cp /Users/lerri/kidville-web/.env.local /Users/lerri/kidville-web-s10-operazioni/.env.local
npm ci 2>&1 | tail -5
```

Atteso: `added N packages`, nessun `ERR!`.

- [ ] **Passo 4: chiudi la sessione rilasciata per ultima (prima di ogni codice)**

Quale sessione chiudere non si deduce dal numero: è la PR `robustezza2/` mergiata più di recente, esclusi i rami `-esito` (specifica §5, «Apertura di una sessione: la chiusura della precedente»).

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/" --limit 50 --json number,headRefName,mergedAt --jq 'map(select(.headRefName | endswith("-esito") | not)) | sort_by(.mergedAt) | last | "\(.number) \(.headRefName)"'
```

Atteso: una riga, `<numero> robustezza2/sNN-<nome>` (ce n'è almeno una: la sessione 3 del Passo 1). Con l'ordine 1→14 è di solito la sessione 9, ma vale la riga stampata. Il suo piano è `docs/superpowers/plans/2026-10-20-robustezza2-<il ramo senza «robustezza2/»>.md`. Leggi **per intero** la sua sezione «Per la sessione dopo» (l'ultima prima dell'«Autorevisione») ed eseguila tutta, nell'ordine in cui la scrive: fotografie, voci da togliere da `MIGRAZIONI_ATTESE_AL_MERGE` (`__tests__/architecture/soglia-fotografia.ts`) e dalle altre liste che nomina, la sua riga di stato a «in produzione» (la trovi con il `grep -n "^| NN |"` che la sezione indica), il commit di `main`, la misura «dopo» se è già matura, lo Stato della sua voce nel PRD. Una misura che quella sezione dice «matura dal giorno …» la scrive la prima PR che tocca la specifica dopo quel giorno: se il giorno è passato, è questa. Il commit di `main` da scrivere:

```bash
git -C /Users/lerri/kidville-web log origin/main --oneline --grep "(#<numero stampato sopra>)" | head -1
```

La fotografia delle migrazioni si rigenera **sempre** quando la sessione chiusa aveva migrazioni, e i comandi sono questi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query che stampa (`select version, name from supabase_migrations.schema_migrations order by version`) con `execute_sql` sul progetto di produzione, in sola lettura, salva la risposta JSON in `${TMPDIR:-/tmp}/s10-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "${TMPDIR:-/tmp}/s10-migrazioni.json"
npx vitest run __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  1 passed`; le migrazioni delle sessioni rilasciate compaiono con la version del file. Le altre fotografie (indici unici, policy, chiavi esterne, tabelle per sede, bucket, schema delle candidature) si rigenerano **solo** se quella sezione le nomina, col comando che dà lei.

- [ ] **Passo 5: gate di partenza**

```bash
npx vitest run 2>&1 | tail -15
CI=1 npx vitest run __tests__/architecture/offline-html-nativo.test.ts 2>&1 | tail -5
```

Atteso: tutti i file verdi tranne, al massimo, `offline-html-nativo` al primo giro (in un worktree nuovo la shell nativa non è sincronizzata); col secondo comando `1 passed`. Se è rosso un altro lock di fotografia, rileggi la sezione «Per la sessione dopo» del Passo 4: una fotografia che nomina e che non hai rigenerato è un passo saltato; una che non nomina si rigenera col generatore che il messaggio d'errore indica, sempre dalla produzione, e lo si scrive nel messaggio di commit. Leggi la riga `Test Files`, non il codice d'uscita di una pipe.

- [ ] **Passo 6: commit della chiusura**

```bash
git status --short
git add -u
git status --short
```

Atteso: dopo `git add -u` ogni riga comincia con `M ` (in colonna 1), e i file sono solo quelli che la sezione «Per la sessione dopo» nomina, più la specifica e il PRD. Un file non tracciato nuovo, qui, non ci deve essere.

```bash
git commit -m "$(cat <<'EOF'
Chiusura della sessione rilasciata per ultima, prima della sessione 10

Eseguita la sezione «Per la sessione dopo» del suo piano: fotografia delle
migrazioni rigenerata dalla produzione (e le altre che quella sezione nomina),
riga di stato a «in produzione» col commit di main, Stato della voce nel PRD.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Passo 7: le decisioni del titolare, prima di qualunque codice**

Mostra al titolare le dieci voci di «Decisioni che restano al titolare», in fondo a questo piano (specifica §7 «Sessione 10»: si mostrano alla fine del Compito 1). Le voci 1-9 sono scelte, e il piano è scritto per quelle che la sezione indica; la voce 10 (la scadenza) non è una scelta: si mostra la data prevista del merge, e se non sta entro metà dicembre la sessione si ferma. Scrivi le risposte nella colonna «Note» della riga della sessione 10:

```bash
grep -n "^| 10 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga sola; si modifica quella, mai una riga presa per numero. Se una risposta è diversa da quella per cui il piano è scritto, cerca nel piano i compiti che nominano quella voce: se ce ne sono, **fermati** e riscrivi prima quei compiti; se non ce ne sono, la risposta va solo nel PRD. Poi:

```bash
git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git commit -m "$(cat <<'EOF'
Specifica della seconda serie: decisioni del titolare per la sessione 10

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 2 — Le misure «prima»

**File:** nessuno nel repository. Il file delle misure è `${TMPDIR:-/tmp}/s10-misure.env`.

- [ ] **Passo 1: il conteggio delle domande d'iscrizione (§5)**

```sql
SELECT count(*) FROM enrollment_submissions;
```

Scrivi `ISCRIZIONI=` col numero letto e `ISCRIZIONI_ALLE=` con l'output di `date -u '+%Y-%m-%d %H:%M'`. Non si copia da nessun documento: si conta.

- [ ] **Passo 2: quanto spesso girano i tre percorsi, dai log con `esito` (30 giorni)**

`app_log` tiene 30 giorni, non 90: questa è la finestra dei log; il Passo 3 dà i 90 giorni.

```sql
SELECT contesto->'campi'->>'esito' AS esito,
       sum(occorrenze)    AS n,
       count(DISTINCT giorno) AS giorni,
       min(giorno)        AS dal
  FROM app_log
 WHERE giorno >= (now() AT TIME ZONE 'UTC')::date - 30
   AND contesto->'campi'->>'esito' IN ('staff-cancellato', 'staff-archiviato', 'eliminazione-rifiutata-si-archivia',
                              'scansioni-non-rimosse', 'file-rimossi-righe-no', 'fascicolo-non-cancellato',
                              'scrutinio-riaperto', 'pagella-eliminata', 'nota-modificata', 'nota-invariata',
                              'addebito-orfano-non-rimosso')
 GROUP BY 1 ORDER BY 1;
```

Scrivi una riga per esito, in maiuscolo con i trattini come trattini bassi: `LOG_STAFF_CANCELLATO=`, `LOG_SCRUTINIO_RIAPERTO=`, `LOG_NOTA_MODIFICATA=`, … (0 se l'esito non compare), più `LOG_DAL=` col `min(giorno)` più vecchio.

- [ ] **Passo 3: le stesse operazioni sui 90 giorni, dall'audit delle scritture**

```sql
SELECT entita_tipo,
       azione,
       count(*) AS n,
       count(*) FILTER (WHERE valore_dopo ? 'pagelle_eliminate') AS riaperture,
       count(*) FILTER (WHERE coalesce((valore_dopo->>'pagelle_eliminate')::int, 0) > 0) AS riaperture_con_pagelle,
       min(creato_il) AS dal
  FROM audit_scritture_docente
 WHERE creato_il >= now() - interval '90 days'
   AND (   (entita_tipo = 'utente_staff' AND azione IN ('delete', 'update'))
        OR (entita_tipo = 'scrutinio'    AND azione = 'update')
        OR (entita_tipo = 'nota'         AND azione = 'update')
        OR (entita_tipo = 'pagella'      AND azione = 'delete'))
 GROUP BY 1, 2 ORDER BY 1, 2;
```

Si leggono solo conteggi e la presenza di una chiave numerica: `valore_dopo` delle note contiene testi, e qui non se ne legge nessuno. Scrivi `AUDIT_STAFF_DELETE=`, `AUDIT_STAFF_UPDATE=`, `AUDIT_RIAPERTURE=` (colonna `riaperture` della riga `scrutinio`), `AUDIT_RIAPERTURE_CON_PAGELLE=`, `AUDIT_NOTE_UPDATE=`, `AUDIT_PAGELLE_DELETE=`, `AUDIT_DAL=`.

**Soglia che cambia il piano.** Se `AUDIT_RIAPERTURE_CON_PAGELLE` > 0 negli ultimi 90 giorni, nel Compito 17 il PRD lo dice in grassetto: quelle riaperture hanno già distrutto pagelle consegnate, e la sessione non le recupera (i file tornano solo dallo specchio di R2, se ancora nei suoi 30 giorni). Se `AUDIT_STAFF_DELETE` = 0 e `LOG_STAFF_CANCELLATO` = 0, il percorso del personale non ha mai girato: la priorità resta la riapertura di gennaio, e il personale si rilascia lo stesso perché il codice è nello stesso giro.

- [ ] **Passo 4: le note firmate e le pagelle che esistono oggi**

```sql
SELECT count(*) FILTER (WHERE firmata_il IS NOT NULL) AS note_firmate, count(*) AS note FROM public.note_disciplinari;
SELECT count(*) AS ricezioni FROM public.nota_ricezioni;
SELECT count(*) AS pagelle, count(DISTINCT scrutinio_id) AS scrutini_con_pagelle FROM public.pagelle;
SELECT stato, count(*) AS n FROM public.scrutini GROUP BY 1 ORDER BY 1;
```

Scrivi `NOTE_FIRMATE=`, `NOTE=`, `RICEZIONI=`, `PAGELLE=`, `SCRUTINI_CON_PAGELLE=`, `SCRUTINI_CHIUSI=`, `SCRUTINI_APERTI=`.

- [ ] **Passo 5: gli oggetti nei due bucket, e i due prefissi nuovi vuoti**

```sql
SELECT bucket_id,
       count(*) AS oggetti,
       count(*) FILTER (WHERE name LIKE 'ritirate/%') AS ritirate,
       count(*) FILTER (WHERE name LIKE 'cestino/%')  AS cestino
  FROM storage.objects
 WHERE bucket_id IN ('pagelle', 'documenti_personale')
 GROUP BY 1 ORDER BY 1;
```

Scrivi `OGGETTI_PAGELLE=`, `OGGETTI_PERSONALE=`, `RITIRATE_PRIMA=`, `CESTINO_PERSONALE_PRIMA=`. **Soglia:** se `ritirate` o `cestino` non sono 0, **fermati**: qualcuno usa già quel prefisso, e né la riapertura né il giro notturno devono toccarlo. Si sceglie un altro prefisso con il titolare prima di andare avanti.

- [ ] **Passo 6: colonne, indici e funzioni che il piano dà per esistenti (o per assenti)**

```sql
SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND (table_name = 'pagelle'
     OR (table_name = 'note_disciplinari'
         AND column_name IN ('categoria', 'testo', 'richiede_firma', 'firmata_il', 'firmata_da',
                             'nota_gruppo_id', 'section_id', 'data_evento', 'storico_versione')))
 ORDER BY table_name, ordinal_position;

SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'pagelle' ORDER BY 1;

SELECT p.oid::regprocedure AS funzione,
       md5(pg_get_functiondef(p.oid)) AS impronta,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_esegue
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('personale_cancella_fascicolo', 'personale_elimina_dipendente', 'note_modifica',
                     'provisiona_sede', 'storici_applica_rettifica')
 ORDER BY 1;
```

Scrivi `IMPRONTA_CANCELLA_FASCICOLO=` e `PROVISIONA_SEDE=presente|assente`. **Soglie:**
- `pagelle.ritirata_il` o `pagelle.file_ritirati` già presenti, oppure `personale_elimina_dipendente` o `note_modifica` già esistenti → **fermati**: un'altra sessione ha usato quei nomi.
- Nessun indice di unicità su `(scrutinio_id, alunno_id)` → **fermati**: `persistPagella` fa l'upsert su quella coppia, e il disegno «una riga per alunno che si ritira e torna in vigore» non regge.
- `note_disciplinari.data_evento` assente → togli `p_data_evento` dalla funzione del Compito 7 e dalla sua chiamata nel Compito 14, e scrivilo nel PRD.
- `provisiona_sede` assente → il ripiego delle sedi gira in produzione, e il test del Compito 15 non è più un caso di scuola: dillo al titolare.
- La sessione **non ridefinisce** `personale_cancella_fascicolo`: ne cambia solo il commento. Salva comunque `pg_get_functiondef` di quella funzione in `${TMPDIR:-/tmp}/s10-funzioni-prima.sql` (è codice, non dati): serve al Ritorno indietro.

- [ ] **Passo 7: le chiavi esterne verso il profilo, l'account e le pratiche**

```sql
SELECT c.conrelid::regclass AS tabella,
       a.attname            AS colonna,
       c.confrelid::regclass AS verso,
       c.confdeltype        AS alla_cancellazione
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
 WHERE c.contype = 'f'
   AND c.confrelid IN ('auth.users'::regclass, 'public.pratiche_personale'::regclass)
    OR (c.contype = 'f' AND c.confrelid = 'public.utenti'::regclass
        AND c.conrelid IN ('public.pratiche_personale'::regclass, 'public.anagrafica_personale'::regclass,
                           'public.presenze'::regclass, 'public.pagelle'::regclass))
 ORDER BY 3, 1, 2;
```

Atteso: `pratiche_personale.utente_id` e `.evasa_da` verso `utenti` con `a` (nessuna azione); `anagrafica_personale.utente_id` con `c`, `.aggiornata_da` con `a`; `anagrafica_personale.origine_pratica_id` verso le pratiche con `n`; `caricamenti_personale.pratica_id` con `c`; `utenti.id` verso `auth.users` con `c`. **Soglie:**
- Una di queste con un'azione diversa → correggi lo schema minimo della prova PGlite del Compito 5 perché ricalchi la produzione, prima di scrivere la funzione.
- Una tabella diversa da `public.utenti` che punta ad `auth.users` con `a` o `r` → dopo che la funzione ha tolto il profilo, `deleteUser` può fallire: è il ramo «account di accesso non rimosso» del Compito 8. Scrivi `FK_AUTH_SENZA_CASCATA=` col numero e riferiscilo al titolare (decisione 2 in fondo).

- [ ] **Passo 8: i trigger sulle tabelle che la sessione scrive**

```sql
SELECT tgrelid::regclass AS tabella, tgname, tgenabled
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgrelid IN ('public.pagelle'::regclass, 'public.note_disciplinari'::regclass,
                   'public.nota_ricezioni'::regclass, 'public.utenti'::regclass,
                   'public.anagrafica_personale'::regclass, 'public.pratiche_personale'::regclass)
 ORDER BY 1, 2;
```

Atteso: i trigger della scatola nera (`scatola_nera_eliminazioni`, `scatola_nera_modifiche`, `scatola_nera_no_truncate`) e quelli degli storici. **Soglia:** un trigger su `pagelle` che rifiuta un `UPDATE` (un «sola aggiunta», un blocco della firma) → **fermati**: la marcatura del ritiro è un `UPDATE`, e il disegno dei Compiti 10 e 11 va rivisto col titolare.

- [ ] **Passo 9: il giro notturno che svuoterà il cestino gira davvero?**

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE '%cestino%' ORDER BY 1;
SELECT giorno, occorrenze, contesto->'campi'->>'esito' AS esito
  FROM app_log
 WHERE evento = 'cron' AND contesto->'campi'->>'operazione' = 'cestino-registro-retention'
 ORDER BY giorno DESC LIMIT 7;
```

Scrivi `CRON_CESTINO=attivo|spento` e `BATTITI_OK_7G=` (giorni con esito `ok`). **Soglia:** job spento o nessun battito `ok` negli ultimi 7 giorni → il cestino del personale non si svuoterebbe mai: **fermati** e dillo al titolare (i cron sono delle sessioni 6 e 8).

- [ ] **Passo 10: controllo del file delle misure**

```bash
grep -c "=" "${TMPDIR:-/tmp}/s10-misure.env"
grep -n "=$" "${TMPDIR:-/tmp}/s10-misure.env"
```

Atteso: almeno 30 righe; nessuna riga che finisce con `=` (un valore vuoto è una misura non fatta).

---

## Moduli comuni: copia verificata e cestino dei file

Due mattoni che i compiti successivi usano. Nessuno tocca la produzione: sono funzioni pure attorno allo Storage, provate con un archivio finto.

**Le RPC nuove non hanno un modulo comune.** Una RPC che il DB della CI non ha risponde `PGRST202` (o `42883` se chiamata da SQL); `colonnaNuovaAssente` (`src/lib/db/colonna-assente.ts:13`) riconosce solo `42703`/`PGRST204`. La specifica (§5, «Codice che regge il momento del merge») chiede di reggere **solo** questi due codici, **solo** sulla chiamata della RPC nuova, con un **insieme locale** sul modello di `RPC_ASSENTE` (`src/app/api/avvisi/[id]/risposte/route.ts:71`) e una riga `info` che dice perché. Le due chiamate della sessione hanno quindi ciascuna il suo: `PERSONALE_ELIMINA_ASSENTE` in `src/lib/personale/cancella-fascicolo.ts` (Compito 8) e `NOTE_MODIFICA_ASSENTE` in `src/app/api/primaria/note/route.ts` (Compito 14). Niente `src/lib/db/rpc-assente.ts`: un riconoscitore condiviso inviterebbe a usarlo su altre chiamate, e il nome `rpcNonInstallata` è già della sessione 7 (`src/lib/health/controlli.ts`). `src/lib/db/tolleranza-schema.ts` non si allarga, perché lì `PGRST202` è un guasto di proposito. Le due funzioni nuove leggono solo tabelle e colonne che esistono già anche nel DB della CI: un `42703` o un `42P01` dentro di loro è schema a metà, e va al canale degli errori come `23503` e `57014` (lo provano i test dei Compiti 8 e 14).

### Compito 3 — La copia verificata

**File:**
- Crea: `src/lib/storage/copia-verificata.ts`
- Test: `__tests__/lib/copia-verificata.test.ts`

- [ ] **Passo 1: il test rosso**

`__tests__/lib/copia-verificata.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento }))

import { copiaNelBucket, destinazioneGiaPresente, oggettoAssente } from '@/lib/storage/copia-verificata'

type EsitoFinto = { error: unknown } | 'lancia'

const NON_TROVATO = { message: 'Object not found', statusCode: '404', status: 400 }
const BUCKET_ASSENTE = { message: 'Bucket not found', statusCode: '404', status: 400 }
const GIA_LI = { message: 'The resource already exists', statusCode: '409', status: 400 }
const GUASTO = { message: 'internal error', statusCode: '500', status: 500 }

function archivioFinto(esitiPerSorgente: Record<string, EsitoFinto> = {}) {
  const chiamate: { bucket: string; da: string; a: string }[] = []
  const supabase = {
    storage: {
      from: (bucket: string) => ({
        copy: async (da: string, a: string) => {
          chiamate.push({ bucket, da, a })
          const e = esitiPerSorgente[da]
          if (e === 'lancia') throw new Error('rete giù')
          return e ? { data: null, error: e.error } : { data: { path: a }, error: null }
        },
      }),
    },
  }
  return { supabase: supabase as never, chiamate }
}

const A = { da: 'S/A.pdf', a: 'ritirate/S/A-1.pdf' }
const B = { da: 'S/B.pdf', a: 'ritirate/S/B-1.pdf' }

beforeEach(() => vi.clearAllMocks())

describe('copiaNelBucket — prima la copia, e sapere se c\'è', () => {
  it('copia ogni coppia, nell\'ordine, e non logga errori', async () => {
    const { supabase, chiamate } = archivioFinto()
    const e = await copiaNelBucket(supabase, 'pagelle', [A, B], 'test')
    expect(chiamate).toEqual([{ bucket: 'pagelle', ...A }, { bucket: 'pagelle', ...B }])
    expect(e.copiati).toEqual([A, B])
    expect(e.falliti).toEqual([])
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('409: la copia c\'è già, non è un guasto', async () => {
    const { supabase } = archivioFinto({ [A.da]: { error: GIA_LI } })
    const e = await copiaNelBucket(supabase, 'pagelle', [A], 'test')
    expect(e.giaPresenti).toEqual([A])
    expect(e.falliti).toEqual([])
  })

  it('404 «Object not found»: non c\'è niente da conservare, e lo si dice a livello info', async () => {
    const { supabase } = archivioFinto({ [A.da]: { error: NON_TROVATO } })
    const e = await copiaNelBucket(supabase, 'pagelle', [A, B], 'test')
    expect(e.sorgentiAssenti).toEqual([A])
    expect(e.copiati).toEqual([B])
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'info', expect.objectContaining({ esito: 'copie-sorgente-assente', n_sorgenti_assenti: 1 }))
  })

  it('«Bucket not found» porta 404 ma è un guasto', async () => {
    const { supabase } = archivioFinto({ [A.da]: { error: BUCKET_ASSENTE } })
    const e = await copiaNelBucket(supabase, 'pagelle', [A], 'test')
    expect(e.falliti).toEqual([A])
    expect(e.primoErrore).toBe(BUCKET_ASSENTE)
  })

  it('un 500 non ferma le copie dopo, e si logga a livello error con l\'errore vero', async () => {
    const { supabase, chiamate } = archivioFinto({ [A.da]: { error: GUASTO } })
    const e = await copiaNelBucket(supabase, 'pagelle', [A, B], 'test')
    expect(chiamate).toHaveLength(2)
    expect(e.falliti).toEqual([A])
    expect(e.copiati).toEqual([B])
    expect(h.logEvento).toHaveBeenCalledWith(
      'storage', 'error',
      expect.objectContaining({ esito: 'copie-non-riuscite', bucket: 'pagelle', n_file: 2, n_copiati: 1, n_falliti: 1 }),
      GUASTO,
    )
  })

  it('un\'eccezione di trasporto è un fallimento come gli altri', async () => {
    const { supabase } = archivioFinto({ [A.da]: 'lancia' })
    const e = await copiaNelBucket(supabase, 'pagelle', [A], 'test')
    expect(e.falliti).toEqual([A])
    expect(e.primoErrore).toBeInstanceOf(Error)
  })

  it('elenco vuoto, coppie vuote, uguali o doppie: nessuna chiamata in più', async () => {
    const { supabase, chiamate } = archivioFinto()
    await copiaNelBucket(supabase, 'pagelle', [], 'test')
    expect(chiamate).toEqual([])
    await copiaNelBucket(supabase, 'pagelle', [{ da: ' ', a: 'x' }, { da: 'S/A.pdf', a: 'S/A.pdf' }, A, { ...A }], 'test')
    expect(chiamate).toEqual([{ bucket: 'pagelle', ...A }])
  })

  it('nei log mai un percorso', async () => {
    const { supabase } = archivioFinto({ [A.da]: { error: GUASTO }, [B.da]: { error: NON_TROVATO } })
    await copiaNelBucket(supabase, 'pagelle', [A, B], 'test')
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('S/')
  })
})

describe('i due riconoscitori', () => {
  it('oggettoAssente', () => {
    expect(oggettoAssente(NON_TROVATO)).toBe(true)
    expect(oggettoAssente({ message: 'Object not found' })).toBe(true)
    expect(oggettoAssente(BUCKET_ASSENTE)).toBe(false)
    expect(oggettoAssente(GUASTO)).toBe(false)
    expect(oggettoAssente(null)).toBe(false)
  })
  it('destinazioneGiaPresente', () => {
    expect(destinazioneGiaPresente(GIA_LI)).toBe(true)
    expect(destinazioneGiaPresente({ message: 'The resource already exists' })).toBe(true)
    expect(destinazioneGiaPresente(NON_TROVATO)).toBe(false)
    expect(destinazioneGiaPresente(undefined)).toBe(false)
  })
})
```

- [ ] **Passo 2: rosso per il motivo giusto**

```bash
npx vitest run __tests__/lib/copia-verificata.test.ts 2>&1 | tail -8
```

Atteso: `Test Files  1 failed`, con `Failed to resolve import "@/lib/storage/copia-verificata"`.

- [ ] **Passo 3: `src/lib/storage/copia-verificata.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

/**
 * COPIARE PRIMA DI TOGLIERE, E SAPERE SE LA COPIA C'È.
 *
 * `storage.from(b).copy(da, a)` risponde `{ data, error }` e non lancia sui 4xx; l'errore porta
 * `statusCode` come stringa ('404', '409') e `status` come numero. Tre esiti NON sono guasti e
 * restano separati, perché il chiamante decide su di essi:
 *  · copiato               → la copia c'è;
 *  · destinazione già lì   → la copia c'è (l'ha fatta un tentativo precedente);
 *  · sorgente assente      → non c'è niente da conservare: un `info`, non un errore.
 * Tutto il resto è un guasto, e il chiamante NON deve togliere l'originale. «Bucket not found»
 * porta anch'esso 404 ma è un guasto: si riconosce dal testo e si esclude.
 *
 * Si prosegue su tutte le coppie anche dopo un guasto: il chiamante deve sapere QUALI copie
 * sono arrivate, per toglierle se annulla. Nei log mai i percorsi (uuid di alunni, nomi scelti
 * dalle famiglie): solo conteggi.
 */

export type CoppiaCopia = { da: string; a: string }

export type EsitoCopia = {
  copiati: CoppiaCopia[]
  giaPresenti: CoppiaCopia[]
  sorgentiAssenti: CoppiaCopia[]
  falliti: CoppiaCopia[]
  primoErrore: unknown
}

function campi(e: unknown): { messaggio: string; stato: string } {
  const o = (e ?? {}) as { message?: unknown; statusCode?: unknown; status?: unknown }
  return {
    messaggio: typeof o.message === 'string' ? o.message : '',
    stato: String(o.statusCode ?? o.status ?? ''),
  }
}

/** L'OGGETTO non c'è. Un bucket assente non vale: è un guasto di configurazione. */
export function oggettoAssente(e: unknown): boolean {
  if (!e) return false
  const { messaggio, stato } = campi(e)
  if (/bucket/i.test(messaggio)) return false
  return stato === '404' || /object not found/i.test(messaggio)
}

/** La destinazione esiste già. */
export function destinazioneGiaPresente(e: unknown): boolean {
  if (!e) return false
  const { messaggio, stato } = campi(e)
  return stato === '409' || /already exists/i.test(messaggio)
}

export async function copiaNelBucket(
  supabase: SupabaseClient,
  bucket: string,
  coppie: CoppiaCopia[],
  op: string,
): Promise<EsitoCopia> {
  const esito: EsitoCopia = { copiati: [], giaPresenti: [], sorgentiAssenti: [], falliti: [], primoErrore: null }

  const viste = new Set<string>()
  const unici: CoppiaCopia[] = []
  for (const c of coppie) {
    const da = typeof c?.da === 'string' ? c.da.trim() : ''
    const a = typeof c?.a === 'string' ? c.a.trim() : ''
    if (!da || !a || da === a) continue
    const chiave = `${da}\n${a}`
    if (viste.has(chiave)) continue
    viste.add(chiave)
    unici.push({ da, a })
  }
  if (unici.length === 0) return esito

  const archivio = supabase.storage.from(bucket)
  for (const c of unici) {
    try {
      const { error } = await archivio.copy(c.da, c.a)
      if (!error) esito.copiati.push(c)
      else if (destinazioneGiaPresente(error)) esito.giaPresenti.push(c)
      else if (oggettoAssente(error)) esito.sorgentiAssenti.push(c)
      else {
        esito.falliti.push(c)
        esito.primoErrore ??= error
      }
    } catch (e) {
      // Guasto di TRASPORTO: `copy()` non ritorna, lancia. Stesso trattamento dell'errore restituito.
      esito.falliti.push(c)
      esito.primoErrore ??= e
    }
  }

  if (esito.falliti.length > 0) {
    logEvento(
      'storage',
      'error',
      {
        operazione: op,
        esito: 'copie-non-riuscite',
        tipo: 'copia-verificata',
        bucket,
        n_file: unici.length,
        n_copiati: esito.copiati.length + esito.giaPresenti.length,
        n_falliti: esito.falliti.length,
      },
      esito.primoErrore,
    )
  }
  if (esito.sorgentiAssenti.length > 0) {
    logEvento('storage', 'info', {
      operazione: op,
      esito: 'copie-sorgente-assente',
      tipo: 'copia-verificata',
      bucket,
      n_file: unici.length,
      n_sorgenti_assenti: esito.sorgentiAssenti.length,
    })
  }
  return esito
}
```

- [ ] **Passo 4: verde**

```bash
npx vitest run __tests__/lib/copia-verificata.test.ts 2>&1 | tail -8
npx vitest run __tests__/architecture/errori-postgrest-guardati.test.ts 2>&1 | tail -5
```

Atteso: `Test Files  1 passed`, poi `1 passed`.

- [ ] **Passo 5: commit**

```bash
git add src/lib/storage/copia-verificata.ts __tests__/lib/copia-verificata.test.ts
git commit -m "$(cat <<'EOF'
Copia verificata nello Storage

copiaNelBucket separa copiato, già presente e sorgente assente dai guasti veri,
prosegue su tutte le coppie e dice quali copie sono arrivate.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 4 — Il cestino dei file: spostare oggi, distruggere dopo

**File:**
- Crea: `src/lib/storage/cestino-file.ts`
- Test: `__tests__/lib/cestino-file.test.ts`

Il cestino sta **nello stesso bucket**, sotto `cestino/<AAAA-MM-GG>/<percorso di prima>`: `move` dentro un bucket è un'operazione dello Storage che non riscarica il file, e la cartella del giorno dice al giro notturno quando il file è entrato. Il prefisso è uno solo per tutti i bucket: il Passo 5 del Compito 2 ha verificato che oggi è vuoto.

- [ ] **Passo 1: il test rosso**

`__tests__/lib/cestino-file.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento }))

import {
  TETTO_FILE_CESTINO,
  percorsoNelCestino,
  spostaNelCestino,
  svuotaCestinoScaduto,
} from '@/lib/storage/cestino-file'

type Opzioni = {
  moveFallisce?: Set<string>
  moveLancia?: Set<string>
  resistenti?: Set<string>
  erroreRemove?: boolean
  erroreList?: boolean
}

/**
 * Un bucket in memoria con la semantica che conta: `list` restituisce le CARTELLE con `id: null`
 * e i file con un id, ordinati per nome, paginati con `offset`/`limit` (100 se non indicato) e
 * filtrati per inizio del nome con `search`; `remove` tace sui percorsi che non esistono.
 */
function archivioFinto(iniziali: string[], o: Opzioni = {}) {
  const oggetti = new Set(iniziali)
  const chiamate: string[] = []
  const archivio = {
    move: async (da: string, a: string) => {
      chiamate.push(`move ${da}`)
      if (o.moveLancia?.has(da)) throw new Error('rete giù')
      if (o.moveFallisce?.has(da)) return { data: null, error: { message: 'internal error', statusCode: '500', status: 500 } }
      if (!oggetti.has(da)) return { data: null, error: { message: 'Object not found', statusCode: '404', status: 400 } }
      oggetti.delete(da)
      oggetti.add(a)
      return { data: { message: 'Successfully moved' }, error: null }
    },
    remove: async (percorsi: string[]) => {
      chiamate.push(`remove ${percorsi.length}`)
      if (o.erroreRemove) return { data: null, error: { message: 'internal error', statusCode: '500', status: 500 } }
      const tolti = percorsi.filter((p) => oggetti.has(p) && !o.resistenti?.has(p))
      tolti.forEach((p) => oggetti.delete(p))
      return { data: tolti.map((name) => ({ name })), error: null }
    },
    list: async (cartella: string, opz: { limit?: number; offset?: number; search?: string } = {}) => {
      chiamate.push(`list ${cartella}`)
      if (o.erroreList) return { data: null, error: { message: 'internal error', statusCode: '500', status: 500 } }
      const prefisso = cartella ? `${cartella}/` : ''
      const voci = new Map<string, string | null>()
      for (const p of oggetti) {
        if (!p.startsWith(prefisso)) continue
        const resto = p.slice(prefisso.length)
        const barra = resto.indexOf('/')
        if (barra < 0) voci.set(resto, 'oggetto')
        else voci.set(resto.slice(0, barra), null)
      }
      const nomi = [...voci.keys()].filter((n) => !opz.search || n.startsWith(opz.search)).sort()
      const offset = opz.offset ?? 0
      const limit = opz.limit ?? 100
      return { data: nomi.slice(offset, offset + limit).map((name) => ({ name, id: voci.get(name) ?? null })), error: null }
    },
  }
  const supabase = { storage: { from: () => archivio } }
  return { supabase: supabase as never, oggetti, chiamate }
}

const ADESSO = new Date('2026-11-03T10:00:00Z')
const BUCKET = 'documenti_personale'

beforeEach(() => vi.clearAllMocks())

describe('spostaNelCestino — il file esce dal suo posto ma non dall\'archivio', () => {
  it('il percorso nel cestino porta il giorno in UTC', () => {
    expect(percorsoNelCestino('P1/doc.pdf', ADESSO)).toBe('cestino/2026-11-03/P1/doc.pdf')
  })

  it('sposta i file invece di cancellarli, e lo dice anche quando va tutto bene', async () => {
    const { supabase, oggetti, chiamate } = archivioFinto(['P1/a.pdf', 'P1/b.pdf'])
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/a.pdf', 'P1/b.pdf'], 'test', ADESSO)
    expect(e).toEqual({ nelCestino: 2, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 0 })
    expect([...oggetti].sort()).toEqual(['cestino/2026-11-03/P1/a.pdf', 'cestino/2026-11-03/P1/b.pdf'])
    expect(chiamate.some((c) => c.startsWith('remove'))).toBe(false)
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'info', expect.objectContaining({ esito: 'file-nel-cestino', n_file: 2, n_nel_cestino: 2 }))
  })

  it('un file che non c\'è più è un esito raggiunto, non un errore', async () => {
    const { supabase } = archivioFinto(['P1/a.pdf'])
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/a.pdf', 'P1/sparito.pdf'], 'test', ADESSO)
    expect(e).toEqual({ nelCestino: 1, giaAssenti: 1, rimossiSenzaCestino: 0, orfani: 0 })
    expect(h.logEvento.mock.calls.some((c) => c[1] === 'error')).toBe(false)
  })

  it('se lo spostamento fallisce il file si cancella, come prima, e lo si dice', async () => {
    const { supabase, oggetti } = archivioFinto(['P1/a.pdf', 'P1/b.pdf'], { moveFallisce: new Set(['P1/b.pdf']) })
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/a.pdf', 'P1/b.pdf'], 'test', ADESSO)
    expect(e).toEqual({ nelCestino: 1, giaAssenti: 0, rimossiSenzaCestino: 1, orfani: 0 })
    expect([...oggetti]).toEqual(['cestino/2026-11-03/P1/a.pdf'])
    expect(h.logEvento).toHaveBeenCalledWith(
      'storage', 'warn',
      expect.objectContaining({ esito: 'cestino-non-raggiunto', n_file: 1 }),
      expect.objectContaining({ statusCode: '500' }),
    )
  })

  it('un file che non si sposta e non si cancella è un orfano, e si grida', async () => {
    const { supabase } = archivioFinto(['P1/b.pdf'], { moveFallisce: new Set(['P1/b.pdf']), resistenti: new Set(['P1/b.pdf']) })
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/b.pdf'], 'test', ADESSO)
    expect(e.orfani).toBe(1)
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'error', expect.objectContaining({ esito: 'file-orfani-fuori-cestino', n_file: 1 }))
  })

  it('un remove che risponde errore lascia orfani tutti i file che non si erano spostati', async () => {
    const { supabase } = archivioFinto(['P1/b.pdf'], { moveFallisce: new Set(['P1/b.pdf']), erroreRemove: true })
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/b.pdf'], 'test', ADESSO)
    expect(e).toEqual({ nelCestino: 0, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 1 })
  })

  it('uno spostamento che lancia segue la stessa strada di quello che fallisce', async () => {
    const { supabase, oggetti } = archivioFinto(['P1/a.pdf'], { moveLancia: new Set(['P1/a.pdf']) })
    const e = await spostaNelCestino(supabase, BUCKET, ['P1/a.pdf'], 'test', ADESSO)
    expect(e.rimossiSenzaCestino).toBe(1)
    expect(oggetti.size).toBe(0)
  })

  it('vuoti, doppioni e percorsi già nel cestino non si toccano', async () => {
    const { supabase, chiamate } = archivioFinto(['P1/a.pdf', 'cestino/2026-11-01/P0/x.pdf'])
    const e = await spostaNelCestino(supabase, BUCKET, ['', '  ', null, '/P1/a.pdf', 'P1/a.pdf', 'cestino/2026-11-01/P0/x.pdf', 'cestino'], 'test', ADESSO)
    expect(chiamate).toEqual(['move P1/a.pdf'])
    expect(e.nelCestino).toBe(1)
  })

  it('nei log mai un percorso', async () => {
    const { supabase } = archivioFinto(['P1/b.pdf'], { moveFallisce: new Set(['P1/b.pdf']), resistenti: new Set(['P1/b.pdf']) })
    await spostaNelCestino(supabase, BUCKET, ['P1/b.pdf'], 'test', ADESSO)
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('P1/')
  })
})

describe('svuotaCestinoScaduto — il giro notturno distrugge solo i giorni passati', () => {
  it('toglie le cartelle-giorno più vecchie della soglia e lascia le altre', async () => {
    const { supabase, oggetti } = archivioFinto([
      'cestino/2026-10-01/P1/a.pdf',
      'cestino/2026-10-01/P1/sotto/b.pdf',
      'cestino/2026-10-20/P2/c.pdf',
      'cestino/varie/d.pdf',
      'P3/e.pdf',
    ])
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e).toEqual({ esito: 'ok', giorniScaduti: 1, fileRimossi: 2, fileGiaAssenti: 0, fileBloccanti: 0, lottoPieno: false })
    expect([...oggetti].sort()).toEqual(['P3/e.pdf', 'cestino/2026-10-20/P2/c.pdf', 'cestino/varie/d.pdf'])
    expect(h.logEvento).toHaveBeenCalledWith('gdpr', 'info', expect.objectContaining({ esito: 'cestino-file-svuotato', n_giorni: 1, n_file: 2, n_bloccanti: 0 }))
  })

  it('un cestino che non esiste è un giro a zero, non un errore', async () => {
    const { supabase } = archivioFinto(['P3/e.pdf'])
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e).toMatchObject({ esito: 'ok', giorniScaduti: 0, fileRimossi: 0 })
  })

  it('un file che resiste: file-non-rimossi, a livello error', async () => {
    const { supabase } = archivioFinto(
      ['cestino/2026-10-01/P1/a.pdf', 'cestino/2026-10-01/P1/b.pdf'],
      { resistenti: new Set(['cestino/2026-10-01/P1/a.pdf']) },
    )
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e).toMatchObject({ esito: 'file-non-rimossi', fileRimossi: 1, fileBloccanti: 1 })
    expect(h.logEvento).toHaveBeenCalledWith('gdpr', 'error', expect.objectContaining({ esito: 'cestino-file-svuotato', n_bloccanti: 1 }))
  })

  it('un elenco che non risponde: elenco-fallito, e niente si cancella', async () => {
    const { supabase, chiamate } = archivioFinto(['cestino/2026-10-01/P1/a.pdf'], { erroreList: true })
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e.esito).toBe('elenco-fallito')
    expect(chiamate.some((c) => c.startsWith('remove'))).toBe(false)
    expect(h.logEvento).toHaveBeenCalledWith('storage', 'error', expect.objectContaining({ esito: 'cestino-non-letto' }), expect.anything())
  })

  it('oltre il tetto ne toglie quanti il tetto ammette e dice che il lotto è pieno', async () => {
    const file = Array.from({ length: TETTO_FILE_CESTINO + 1 }, (_, i) => `cestino/2026-01-01/P/${String(i).padStart(4, '0')}.pdf`)
    const { supabase, oggetti } = archivioFinto(file)
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-10-10', 'test')
    expect(e).toMatchObject({ esito: 'ok', fileRimossi: TETTO_FILE_CESTINO, lottoPieno: true })
    expect(oggetti.size).toBe(1)
  })

  it('più di mille cartelle-giorno: la radice del cestino si legge a pagine', async () => {
    const giorno = 86_400_000
    const file = Array.from({ length: 1001 }, (_, i) => `cestino/${new Date(Date.UTC(2020, 0, 1) + i * giorno).toISOString().slice(0, 10)}/f.pdf`)
    const { supabase } = archivioFinto(file)
    const e = await svuotaCestinoScaduto(supabase, BUCKET, '2026-01-01', 'test')
    expect(e).toMatchObject({ giorniScaduti: 1001, fileRimossi: TETTO_FILE_CESTINO, lottoPieno: true })
  })
})
```

- [ ] **Passo 2: rosso**

```bash
npx vitest run __tests__/lib/cestino-file.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  1 failed`, `Failed to resolve import "@/lib/storage/cestino-file"`.

- [ ] **Passo 3: `src/lib/storage/cestino-file.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { bloccanti, rimuoviEVerifica } from '@/lib/storage/rimozione-verificata'
import { oggettoAssente } from '@/lib/storage/copia-verificata'

/**
 * IL CESTINO DEI FILE: OGGI SI SPOSTA, IL GIRO NOTTURNO DISTRUGGE.
 *
 * Una cancellazione a più passi che toglie i file per PRIMI li perde quando un passo dopo
 * fallisce: la riga resta, il documento no. Qui il passo sui file diventa l'ULTIMO e diventa
 * reversibile: il file va in `cestino/<giorno UTC>/<percorso di prima>` dello stesso bucket, e
 * `cestino-registro-retention` lo distrugge passato il termine del cestino.
 *
 * Se lo spostamento non riesce, il file si cancella subito (il comportamento di prima): le righe
 * che lo nominavano sono già andate, e un file che nessuna riga nomina è peggio di un file
 * cancellato. Se non si riesce nemmeno a cancellarlo è un ORFANO, e si grida.
 *
 * Nei log mai i percorsi: solo conteggi.
 */

export const PREFISSO_CESTINO = 'cestino'
/** Quanti file al massimo un giro toglie dal cestino: il resto lo prende il giro dopo. */
export const TETTO_FILE_CESTINO = 500
const PAGINA_ELENCO = 1000
/** Un elenco senza tetto è un ciclo che può non finire: cento pagine bastano e avanzano. */
const PAGINE_MASSIME = 100
const GIORNO_CARTELLA = /^\d{4}-\d{2}-\d{2}$/

type Archivio = ReturnType<SupabaseClient['storage']['from']>

export function giornoCestino(adesso: Date): string {
  return adesso.toISOString().slice(0, 10)
}

export function percorsoNelCestino(percorso: string, adesso: Date): string {
  return `${PREFISSO_CESTINO}/${giornoCestino(adesso)}/${percorso}`
}

export type EsitoCestino = {
  /** Spostati nel cestino: si possono ancora recuperare. */
  nelCestino: number
  /** Non c'erano più: esito già raggiunto. */
  giaAssenti: number
  /** Lo spostamento non è riuscito e sono stati cancellati subito. */
  rimossiSenzaCestino: number
  /** Né spostati né cancellati: restano al loro posto senza una riga che li nomini. */
  orfani: number
}

function normalizza(percorsi: (string | null | undefined)[]): string[] {
  const out = new Set<string>()
  for (const p of percorsi) {
    if (typeof p !== 'string') continue
    const pulito = p.trim().replace(/^\/+/, '')
    if (!pulito || pulito === PREFISSO_CESTINO || pulito.startsWith(`${PREFISSO_CESTINO}/`)) continue
    out.add(pulito)
  }
  return [...out]
}

export async function spostaNelCestino(
  supabase: SupabaseClient,
  bucket: string,
  percorsi: (string | null | undefined)[],
  op: string,
  adesso: Date = new Date(),
): Promise<EsitoCestino> {
  const esito: EsitoCestino = { nelCestino: 0, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 0 }
  const unici = normalizza(percorsi)
  if (unici.length === 0) return esito

  const archivio = supabase.storage.from(bucket)
  const daRimuovere: string[] = []
  let primoErrore: unknown = null
  for (const p of unici) {
    try {
      const { error } = await archivio.move(p, percorsoNelCestino(p, adesso))
      if (!error) esito.nelCestino++
      else if (oggettoAssente(error)) esito.giaAssenti++
      else {
        daRimuovere.push(p)
        primoErrore ??= error
      }
    } catch (e) {
      daRimuovere.push(p)
      primoErrore ??= e
    }
  }

  if (daRimuovere.length > 0) {
    logEvento(
      'storage',
      'warn',
      { operazione: op, esito: 'cestino-non-raggiunto', tipo: 'cestino-file', bucket, n_file: daRimuovere.length },
      primoErrore,
    )
    const r = await rimuoviEVerifica(supabase, bucket, daRimuovere, op)
    if (r.erroreRimozione) {
      esito.orfani += daRimuovere.length
    } else {
      esito.rimossiSenzaCestino += r.rimossi.length
      esito.giaAssenti += r.giaAssenti.length
      esito.orfani += bloccanti(r).length
    }
  }

  if (esito.orfani > 0) {
    logEvento('storage', 'error', {
      operazione: op,
      esito: 'file-orfani-fuori-cestino',
      tipo: 'cestino-file',
      bucket,
      n_file: esito.orfani,
    })
  }
  logEvento('storage', 'info', {
    operazione: op,
    esito: 'file-nel-cestino',
    tipo: 'cestino-file',
    bucket,
    n_file: unici.length,
    n_nel_cestino: esito.nelCestino,
    n_gia_assenti: esito.giaAssenti,
    n_rimossi_senza_cestino: esito.rimossiSenzaCestino,
    n_orfani: esito.orfani,
  })
  return esito
}

// ─── Lo svuotamento, chiamato dal giro notturno ──────────────────────────────

export type EsitoSvuotamento = {
  esito: 'ok' | 'elenco-fallito' | 'file-non-rimossi'
  giorniScaduti: number
  fileRimossi: number
  fileGiaAssenti: number
  fileBloccanti: number
  lottoPieno: boolean
}

export const SVUOTAMENTO_VUOTO: EsitoSvuotamento = {
  esito: 'ok',
  giorniScaduti: 0,
  fileRimossi: 0,
  fileGiaAssenti: 0,
  fileBloccanti: 0,
  lottoPieno: false,
}

type Voce = { name: string; id: string | null }
type Elenco = { ok: true; voci: Voce[] } | { ok: false; errore: unknown }

async function elenca(archivio: Archivio, cartella: string, offset: number): Promise<Elenco> {
  try {
    const { data, error } = await archivio.list(cartella, {
      limit: PAGINA_ELENCO,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    })
    if (error) return { ok: false, errore: error }
    const voci = (Array.isArray(data) ? data : []).map((o) => ({
      name: typeof o?.name === 'string' ? o.name : '',
      id: typeof o?.id === 'string' ? o.id : null,
    }))
    return { ok: true, voci }
  } catch (e) {
    return { ok: false, errore: e }
  }
}

async function tutteLeVoci(archivio: Archivio, cartella: string): Promise<Elenco> {
  const voci: Voce[] = []
  for (let pagina = 0; pagina < PAGINE_MASSIME; pagina++) {
    const r = await elenca(archivio, cartella, pagina * PAGINA_ELENCO)
    if (!r.ok) return r
    voci.push(...r.voci)
    if (r.voci.length < PAGINA_ELENCO) break
  }
  return { ok: true, voci }
}

/** I file sotto `cartella`, a qualunque profondità, fino a `tetto`. `id === null` è una cartella. */
async function fileSotto(
  archivio: Archivio,
  cartella: string,
  tetto: number,
  out: string[],
): Promise<{ ok: true } | { ok: false; errore: unknown }> {
  for (let pagina = 0; pagina < PAGINE_MASSIME && out.length < tetto; pagina++) {
    const r = await elenca(archivio, cartella, pagina * PAGINA_ELENCO)
    if (!r.ok) return r
    for (const v of r.voci) {
      if (out.length >= tetto) break
      if (!v.name) continue
      const percorso = `${cartella}/${v.name}`
      if (v.id === null) {
        const sotto = await fileSotto(archivio, percorso, tetto, out)
        if (!sotto.ok) return sotto
      } else {
        out.push(percorso)
      }
    }
    if (r.voci.length < PAGINA_ELENCO) break
  }
  return { ok: true }
}

/**
 * Distrugge i file entrati nel cestino in un giorno PRECEDENTE a `sogliaGiorno` (AAAA-MM-GG).
 * Il termine non si decide qui: lo passa il giro notturno, che è il solo a conoscerlo.
 */
export async function svuotaCestinoScaduto(
  supabase: SupabaseClient,
  bucket: string,
  sogliaGiorno: string,
  op: string,
): Promise<EsitoSvuotamento> {
  const archivio = supabase.storage.from(bucket)
  const esito: EsitoSvuotamento = { ...SVUOTAMENTO_VUOTO }

  const radice = await tutteLeVoci(archivio, PREFISSO_CESTINO)
  if (!radice.ok) {
    logEvento('storage', 'error', { operazione: op, esito: 'cestino-non-letto', tipo: 'cestino-file', bucket }, radice.errore)
    return { ...esito, esito: 'elenco-fallito' }
  }
  const giorni = radice.voci
    .filter((v) => v.id === null && GIORNO_CARTELLA.test(v.name) && v.name < sogliaGiorno)
    .map((v) => v.name)
    .sort()
  esito.giorniScaduti = giorni.length

  const raccolti: string[] = []
  for (const g of giorni) {
    if (raccolti.length > TETTO_FILE_CESTINO) break
    const r = await fileSotto(archivio, `${PREFISSO_CESTINO}/${g}`, TETTO_FILE_CESTINO + 1, raccolti)
    if (!r.ok) {
      logEvento('storage', 'error', { operazione: op, esito: 'cestino-non-letto', tipo: 'cestino-file', bucket }, r.errore)
      return { ...esito, esito: 'elenco-fallito' }
    }
  }
  esito.lottoPieno = raccolti.length > TETTO_FILE_CESTINO
  const lotto = raccolti.slice(0, TETTO_FILE_CESTINO)

  if (lotto.length > 0) {
    const r = await rimuoviEVerifica(supabase, bucket, lotto, op)
    if (r.erroreRimozione) {
      esito.fileBloccanti = lotto.length
    } else {
      esito.fileRimossi = r.rimossi.length
      esito.fileGiaAssenti = r.giaAssenti.length
      esito.fileBloccanti = bloccanti(r).length
    }
  }
  if (esito.fileBloccanti > 0) esito.esito = 'file-non-rimossi'

  logEvento('gdpr', esito.esito === 'ok' ? 'info' : 'error', {
    operazione: op,
    esito: 'cestino-file-svuotato',
    tipo: 'cestino-file',
    bucket,
    n_giorni: esito.giorniScaduti,
    n_file: esito.fileRimossi,
    n_gia_assenti: esito.fileGiaAssenti,
    n_bloccanti: esito.fileBloccanti,
    lotto_pieno: esito.lottoPieno,
  })
  return esito
}
```

Il campo `tipo` in ogni riga serve: nei test del giro notturno il battito si riconosce proprio perché **non** ha `tipo` (`battito()` in `__tests__/api/gdpr-retention-cestino-registro.test.ts` filtra `!e.campi.tipo`). `tipo`, `bucket`, `esito`, `operazione` sono fra le chiavi che la redazione lascia in chiaro (`CHIAVI_IN_CHIARO`, `src/lib/logging/redact.ts:250`).

- [ ] **Passo 4: verde, e i lock che guardano questi file**

```bash
npx vitest run __tests__/lib/cestino-file.test.ts 2>&1 | tail -6
npx vitest run __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/architecture/cestino-registro-giorni-un-numero-solo.test.ts 2>&1 | tail -6
```

Atteso: `1 passed` (15 test), poi `2 passed`. Se il secondo lock è rosso su `cestino-file.ts`, un commento nomina una cifra accanto a «giorni»: riscrivilo senza.

- [ ] **Passo 5: commit**

```bash
git add src/lib/storage/cestino-file.ts __tests__/lib/cestino-file.test.ts
git commit -m "$(cat <<'EOF'
Cestino dei file nello Storage: spostare oggi, distruggere col giro notturno

spostaNelCestino porta i file in cestino/<giorno>/ dello stesso bucket e, se lo
spostamento non riesce, li cancella come prima dicendo quanti sono rimasti
orfani; svuotaCestinoScaduto distrugge le cartelle-giorno oltre la soglia, a
pagine e con un tetto per giro.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Migrazione

Tre file, ciascuno provato su un Postgres vero (PGlite) che **legge il file dal disco** e lo applica due volte. Nessuno si applica a mano: li applica l'integrazione Supabase al merge, con la version del file. Le version si scrivono al momento con `date -u +%Y%m%d%H%M%S` e devono venire **dopo** l'ultima migrazione su `origin/main` (oggi `20261019223123_battiti_app_log_che_contano.sql`; controlla con `ls supabase/migrations | tail -1`).

Due lock guardano il **testo** di ogni migrazione, stringhe di `COMMENT ON` comprese (i commenti `--` no):
- `soglia-fotografia`: niente parole che dicano «tocca le guardie» (l'inglese per *unicità* e *chiave primaria*, il riferimento a `utenti` come chiave esterna, aggiunta o rimozione di un vincolo, le regole di sicurezza per riga, la rimozione di una tabella, la nascita di una colonna di sede). Nei testi si scrive «vincolo di unicità».
- `migrazioni-distruttive-approvate`: un `DELETE FROM` fuori dal corpo di una funzione vuole la riga di approvazione. Qui i `DELETE` stanno tutti dentro funzioni.

### Compito 5 — `personale_elimina_dipendente`: pratica, fascicolo e profilo in una transazione

**File:**
- Crea: `supabase/migrations/<V1>_personale_elimina_dipendente.sql`
- Test: `__tests__/lib/personale-elimina-dipendente-sql.test.ts`

Lo schema minimo del test ricalca le chiavi lette nel Passo 7 del Compito 2: se lì un'azione era diversa, si corregge qui **prima** di scrivere la funzione.

- [ ] **Passo 1: il test rosso**

`__tests__/lib/personale-elimina-dipendente-sql.test.ts`:

```ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * ELIMINAZIONE DI UN MEMBRO DEL PERSONALE · LA MIGRAZIONE SU UN POSTGRES VERO.
 *
 * Ciò che conta lo può far rispettare solo il database: il «tutto o niente» quando una chiave
 * senza cascata trattiene il profilo, l'ordine dei DELETE, i permessi. Lo schema è un MINIMO
 * con le chiavi della produzione (Passo 7 del Compito 2 del piano della sessione 10). Il file
 * della migrazione è LETTO DAL DISCO e applicato DUE volte. Solo uuid inventati.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).filter((f) => f.endsWith('_personale_elimina_dipendente.sql'))
if (FILE.length !== 1) throw new Error(`attesa UNA migrazione *_personale_elimina_dipendente.sql, trovate ${FILE.length}`)
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE[0]), 'utf8')

const DIPENDENTE = '30000000-0000-4000-8000-000000000001'
const COLLEGA = '30000000-0000-4000-8000-000000000002'
const PRATICA = '40000000-0000-4000-8000-000000000001'
const PRATICA_COLLEGA = '40000000-0000-4000-8000-000000000002'

type PgErr = { code?: string; message: string }
type Conteggi = { pratiche_cancellate: number; anagrafiche_cancellate: number; profili_cancellati: number }

const RUOLI = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`
const TABELLE = `
  CREATE TABLE public.utenti (id uuid PRIMARY KEY, ruolo text);
  CREATE TABLE public.pratiche_personale (
    id uuid PRIMARY KEY,
    utente_id uuid REFERENCES public.utenti(id),
    evasa_da uuid REFERENCES public.utenti(id)
  );
  CREATE TABLE public.caricamenti_personale (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pratica_id uuid REFERENCES public.pratiche_personale(id) ON DELETE CASCADE
  );
  CREATE TABLE public.anagrafica_personale (
    utente_id uuid PRIMARY KEY REFERENCES public.utenti(id) ON DELETE CASCADE,
    origine_pratica_id uuid REFERENCES public.pratiche_personale(id) ON DELETE SET NULL,
    aggiornata_da uuid REFERENCES public.utenti(id)
  );
  CREATE TABLE public.presenze (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    registrato_da uuid REFERENCES public.utenti(id)
  );
`
/** La funzione di prima, ridotta all'osso: alla migrazione serve solo che esista, per il commento. */
const FUNZIONE_DI_PRIMA = `
  CREATE FUNCTION public.personale_cancella_fascicolo(p_utente_id uuid, p_pratica_id uuid DEFAULT NULL)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
`

let db: PGlite

async function numero(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

async function elimina(utente: string | null, pratica: string | null): Promise<Conteggi> {
  const u = utente ? `'${utente}'::uuid` : 'NULL::uuid'
  const p = pratica ? `'${pratica}'::uuid` : 'NULL::uuid'
  const { rows } = await db.query<{ r: Conteggi }>(`SELECT public.personale_elimina_dipendente(${u}, ${p}) AS r`)
  return rows[0].r
}

async function errore(fn: () => Promise<unknown>): Promise<PgErr> {
  try {
    await fn()
  } catch (e) {
    return e as PgErr
  }
  throw new Error('attesa un\'eccezione dal database')
}

async function impronta() {
  return {
    pratica: await numero(`SELECT count(*) FROM public.pratiche_personale WHERE id = '${PRATICA}'`),
    caricamenti: await numero(`SELECT count(*) FROM public.caricamenti_personale WHERE pratica_id = '${PRATICA}'`),
    anagrafica: await numero(`SELECT count(*) FROM public.anagrafica_personale WHERE utente_id = '${DIPENDENTE}'`),
    profilo: await numero(`SELECT count(*) FROM public.utenti WHERE id = '${DIPENDENTE}'`),
  }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(RUOLI + TABELLE + FUNZIONE_DI_PRIMA)
  await db.exec(MIGRAZIONE)
  await db.exec(MIGRAZIONE) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.presenze, public.caricamenti_personale, public.anagrafica_personale,
             public.pratiche_personale, public.utenti CASCADE;
    INSERT INTO public.utenti (id, ruolo) VALUES ('${DIPENDENTE}', 'docente'), ('${COLLEGA}', 'segreteria');
    INSERT INTO public.pratiche_personale (id, utente_id) VALUES ('${PRATICA}', '${DIPENDENTE}');
    INSERT INTO public.caricamenti_personale (pratica_id) VALUES ('${PRATICA}'), ('${PRATICA}');
    INSERT INTO public.anagrafica_personale (utente_id, origine_pratica_id, aggiornata_da)
      VALUES ('${DIPENDENTE}', '${PRATICA}', '${DIPENDENTE}');
  `)
})

describe('personale_elimina_dipendente — tutto o niente', () => {
  it('cancella pratica, caricamenti (in cascata), fascicolo e profilo, e lo conta', async () => {
    expect(await elimina(DIPENDENTE, PRATICA)).toEqual({ pratiche_cancellate: 1, anagrafiche_cancellate: 1, profili_cancellati: 1 })
    expect(await impronta()).toEqual({ pratica: 0, caricamenti: 0, anagrafica: 0, profilo: 0 })
    expect(await numero(`SELECT count(*) FROM public.utenti WHERE id = '${COLLEGA}'`)).toBe(1)
  })

  it.each([
    ['una presenza registrata da lui', `INSERT INTO public.presenze (registrato_da) VALUES ('${DIPENDENTE}')`],
    ['una pratica di un collega evasa da lui', `INSERT INTO public.pratiche_personale (id, utente_id, evasa_da) VALUES ('${PRATICA_COLLEGA}', '${COLLEGA}', '${DIPENDENTE}')`],
    ['il fascicolo di un collega aggiornato da lui', `INSERT INTO public.anagrafica_personale (utente_id, aggiornata_da) VALUES ('${COLLEGA}', '${DIPENDENTE}')`],
  ])('%s trattiene il profilo: 23503, e NIENTE è cancellato', async (_caso, sql) => {
    await db.exec(sql)
    const e = await errore(() => elimina(DIPENDENTE, PRATICA))
    expect(e.code).toBe('23503')
    expect(await impronta()).toEqual({ pratica: 1, caricamenti: 2, anagrafica: 1, profilo: 1 })
  })

  it('la seconda chiamata trova zero righe e lo dice', async () => {
    await elimina(DIPENDENTE, PRATICA)
    expect(await elimina(DIPENDENTE, PRATICA)).toEqual({ pratiche_cancellate: 0, anagrafiche_cancellate: 0, profili_cancellati: 0 })
  })

  it('senza pratica cancella fascicolo e profilo', async () => {
    await db.exec(`DELETE FROM public.anagrafica_personale; DELETE FROM public.pratiche_personale;`)
    await db.exec(`INSERT INTO public.anagrafica_personale (utente_id) VALUES ('${DIPENDENTE}')`)
    expect(await elimina(DIPENDENTE, null)).toEqual({ pratiche_cancellate: 0, anagrafiche_cancellate: 1, profili_cancellati: 1 })
  })

  it('un utente nullo è una richiesta sbagliata: 22023', async () => {
    expect((await errore(() => elimina(null, null))).code).toBe('22023')
  })

  it('la porta è chiusa ad anon e authenticated, aperta al solo service_role', async () => {
    const firma = `'public.personale_elimina_dipendente(uuid, uuid)'`
    const { rows } = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon', ${firma}, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', ${firma}, 'EXECUTE') AS auth,
             has_function_privilege('service_role', ${firma}, 'EXECUTE') AS svc`)
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true })
  })

  it('il commento della funzione di prima non dice più «le scansioni le rimuove la route PRIMA»', async () => {
    const { rows } = await db.query<{ c: string }>(
      `SELECT obj_description('public.personale_cancella_fascicolo(uuid, uuid)'::regprocedure, 'pg_proc') AS c`,
    )
    expect(rows[0].c).toContain('cestino')
    expect(rows[0].c).not.toContain('PRIMA di chiamarla')
  })

  it('su un database senza la funzione di prima la migrazione non si ferma', async () => {
    const vuoto = new PGlite()
    try {
      await vuoto.exec(RUOLI + TABELLE)
      await expect(vuoto.exec(MIGRAZIONE)).resolves.toBeDefined()
      const { rows } = await vuoto.query<{ f: string | null }>(
        `SELECT to_regprocedure('public.personale_elimina_dipendente(uuid, uuid)')::text AS f`,
      )
      expect(rows[0].f).not.toBeNull()
    } finally {
      await vuoto.close()
    }
  })

  it('la migrazione non tocca lo Storage', () => {
    expect(MIGRAZIONE.toLowerCase()).not.toContain('storage.objects')
  })
})
```

- [ ] **Passo 2: rosso**

```bash
npx vitest run __tests__/lib/personale-elimina-dipendente-sql.test.ts 2>&1 | tail -6
```

Atteso: `Test Files  1 failed`, con `attesa UNA migrazione *_personale_elimina_dipendente.sql, trovate 0`.

- [ ] **Passo 3: la migrazione**

```bash
date -u +%Y%m%d%H%M%S
```

Crea `supabase/migrations/<V1>_personale_elimina_dipendente.sql`, dove `<V1>` è il numero appena stampato:

```sql
-- =============================================================================
-- ELIMINAZIONE DI UN MEMBRO DEL PERSONALE: LE RIGHE IN UNA TRANSAZIONE, I FILE DOPO
--
-- Seconda serie di robustezza, sessione 10 («Operazioni a più passi senza perdite»).
--
-- `POST /api/admin/staff/eliminazione` (azione `cancella`) faceva: scansioni tolte dallo
-- Storage → fascicolo cancellato (`personale_cancella_fascicolo`) → account cancellato con
-- `auth.admin.deleteUser`. Se l'ultimo passo trovava una chiave senza cascata (una presenza
-- registrata da lui, una pratica evasa da lui) la route archiviava: ma scansioni e fascicolo
-- erano già andati, e l'archiviato restava senza documenti.
--
-- `personale_elimina_dipendente` cancella in UNA transazione la pratica d'origine, il
-- fascicolo e il profilo (`public.utenti`). Se una chiave senza cascata trattiene il profilo,
-- Postgres risponde 23503 e annulla TUTTO: la route lo legge come «si archivia» e non ha
-- ancora toccato un file. Le scansioni le sposta nel cestino dello Storage DOPO, e le
-- distrugge il giro notturno `cestino-registro-retention`.
--
-- `personale_cancella_fascicolo` resta com'è (la usano `riporta-a-genitore` e, come ripiego
-- dove questa funzione non c'è, la route di eliminazione): cambia solo il suo commento, che
-- diceva «le scansioni le rimuove la route PRIMA».
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   SELECT p.oid::regprocedure, has_function_privilege('authenticated', p.oid, 'EXECUTE')
--     FROM pg_proc p WHERE p.proname = 'personale_elimina_dipendente';
--   → una riga, `false`. Nel repo: `__tests__/lib/personale-elimina-dipendente-sql.test.ts`
--   (PGlite, questo file letto dal disco e applicato due volte).
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.personale_elimina_dipendente(uuid, uuid);
--   e il commento di `personale_cancella_fascicolo` rimesso col testo di
--   `20260920001032_docente_archiviato_e_cancella_fascicolo.sql`. Il codice dell'app ripiega
--   da solo su `personale_cancella_fascicolo` (PGRST202): nessun dato da riportare indietro.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.personale_elimina_dipendente(
  p_utente_id uuid,
  p_pratica_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pratiche int := 0;
  v_anagrafiche int := 0;
  v_profili int := 0;
BEGIN
  IF p_utente_id IS NULL THEN
    RAISE EXCEPTION 'personale_elimina_dipendente: p_utente_id obbligatorio' USING ERRCODE = '22023';
  END IF;

  -- La pratica PER PRIMA, come in `personale_cancella_fascicolo`: il riferimento del fascicolo
  -- alla pratica si azzera da sé, i caricamenti se ne vanno in cascata.
  IF p_pratica_id IS NOT NULL THEN
    DELETE FROM public.pratiche_personale WHERE id = p_pratica_id;
    GET DIAGNOSTICS v_pratiche = ROW_COUNT;
  END IF;

  DELETE FROM public.anagrafica_personale WHERE utente_id = p_utente_id;
  GET DIAGNOSTICS v_anagrafiche = ROW_COUNT;

  -- Il profilo per ULTIMO: è il passo che una chiave senza cascata può rifiutare (23503), e il
  -- rifiuto annulla anche i due DELETE sopra.
  DELETE FROM public.utenti WHERE id = p_utente_id;
  GET DIAGNOSTICS v_profili = ROW_COUNT;

  RETURN jsonb_build_object(
    'pratiche_cancellate', v_pratiche,
    'anagrafiche_cancellate', v_anagrafiche,
    'profili_cancellati', v_profili
  );
END $$;

REVOKE ALL ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.personale_elimina_dipendente(uuid, uuid) IS
  'Cancella in UNA transazione la pratica d''origine, il fascicolo e il profilo di un membro '
  'del personale; se una chiave senza cascata trattiene il profilo risponde 23503 e annulla '
  'tutto. Ritorna i conteggi. NON tocca lo Storage: le scansioni la route le sposta nel '
  'cestino DOPO, e le distrugge il giro notturno cestino-registro-retention.';

-- Il commento della funzione di prima. Dentro un DO perché sul DB della CI la funzione può
-- non esserci, e un COMMENT su un oggetto assente fermerebbe «DB migrate (CI)».
DO $$
BEGIN
  IF to_regprocedure('public.personale_cancella_fascicolo(uuid, uuid)') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON FUNCTION public.personale_cancella_fascicolo(uuid, uuid) IS
      'Cancella in UNA transazione il fascicolo del personale e la pratica pubblica da cui '
      'e'' nato. Ritorna i conteggi. NON tocca lo Storage: le scansioni la route le sposta nel '
      'cestino DOPO averla chiamata, e le distrugge il giro notturno cestino-registro-retention.'$c$;
  END IF;
END $$;
```

- [ ] **Passo 4: verde, e i lock delle migrazioni**

```bash
npx vitest run __tests__/lib/personale-elimina-dipendente-sql.test.ts 2>&1 | tail -6
npx vitest run __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -8
```

Atteso: `1 passed` (11 test), poi `4 passed`.

- [ ] **Passo 5: commit**

```bash
git add supabase/migrations/*_personale_elimina_dipendente.sql __tests__/lib/personale-elimina-dipendente-sql.test.ts
git commit -m "$(cat <<'EOF'
Personale: pratica, fascicolo e profilo cancellati in una sola transazione

personale_elimina_dipendente cancella le tre cose insieme o nessuna: una chiave
senza cascata sul profilo risponde 23503 e la route può archiviare senza aver
toccato un file. Provata su PGlite leggendo la migrazione dal disco.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 6 — `pagelle.ritirata_il` e `pagelle.file_ritirati`

**File:**
- Crea: `supabase/migrations/<V2>_pagelle_ritirate.sql`
- Test: `__tests__/lib/pagelle-ritirate-sql.test.ts`

Il vincolo di unicità `pagelle_scrutinio_id_alunno_id_key` (baseline, riga 3548) tiene **una** riga per alunno e scrutinio, e `persistPagella` fa l'upsert proprio su quella coppia. Quindi la riga ritirata non può stare accanto alla nuova: è la stessa riga, che la generazione successiva rimette in vigore. Per questo le colonne sono due: `ritirata_il` dice se la riga è in vigore, `file_ritirati` conserva i percorsi delle copie ritirate e sopravvive all'upsert.

- [ ] **Passo 1: il test rosso**

`__tests__/lib/pagelle-ritirate-sql.test.ts`:

```ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * PAGELLE RITIRATE · LA MIGRAZIONE SU UN POSTGRES VERO.
 * La tabella è un minimo con il vincolo di unicità della produzione su (scrutinio, alunno).
 * Una riga esiste PRIMA della migrazione: deve ricevere i valori di partenza.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).filter((f) => f.endsWith('_pagelle_ritirate.sql'))
if (FILE.length !== 1) throw new Error(`attesa UNA migrazione *_pagelle_ritirate.sql, trovate ${FILE.length}`)
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE[0]), 'utf8')

const SCRUTINIO = '50000000-0000-4000-8000-000000000001'
const ALUNNO = '60000000-0000-4000-8000-000000000001'
const ALUNNO_2 = '60000000-0000-4000-8000-000000000002'

const TABELLA = `
  CREATE TABLE public.pagelle (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scrutinio_id uuid NOT NULL,
    alunno_id uuid NOT NULL,
    file_url text,
    generata_il timestamptz DEFAULT now(),
    generata_da uuid,
    firma_applicativa jsonb,
    UNIQUE (scrutinio_id, alunno_id)
  );
`

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(TABELLA)
  await db.exec(`INSERT INTO public.pagelle (scrutinio_id, alunno_id, file_url) VALUES ('${SCRUTINIO}', '${ALUNNO_2}', '${SCRUTINIO}/${ALUNNO_2}.pdf')`)
  await db.exec(MIGRAZIONE)
  await db.exec(MIGRAZIONE) // idempotente
})

afterAll(async () => {
  await db.close()
})

describe('migrazione pagelle ritirate', () => {
  it('aggiunge le due colonne con i tipi giusti', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pagelle'
         AND column_name IN ('ritirata_il', 'file_ritirati') ORDER BY column_name`)
    expect(rows).toEqual([
      { column_name: 'file_ritirati', data_type: 'ARRAY', is_nullable: 'NO' },
      { column_name: 'ritirata_il', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ])
  })

  it('una pagella che c\'era già resta in vigore, senza copie ritirate', async () => {
    const { rows } = await db.query<{ ritirata_il: string | null; file_ritirati: string[] }>(
      `SELECT ritirata_il, file_ritirati FROM public.pagelle WHERE alunno_id = '${ALUNNO_2}'`,
    )
    expect(rows[0]).toEqual({ ritirata_il: null, file_ritirati: [] })
  })

  it('ritirata e poi rigenerata: la riga torna in vigore e lo storico resta', async () => {
    await db.exec(`INSERT INTO public.pagelle (scrutinio_id, alunno_id, file_url) VALUES ('${SCRUTINIO}', '${ALUNNO}', '${SCRUTINIO}/${ALUNNO}.pdf')`)
    await db.exec(`
      UPDATE public.pagelle
         SET ritirata_il = now(),
             file_url = 'ritirate/${SCRUTINIO}/${ALUNNO}-1.pdf',
             file_ritirati = file_ritirati || 'ritirate/${SCRUTINIO}/${ALUNNO}-1.pdf'
       WHERE scrutinio_id = '${SCRUTINIO}' AND alunno_id = '${ALUNNO}' AND ritirata_il IS NULL`)
    // È l'upsert di `persistPagella`: stesse colonne, stessa coppia del vincolo di unicità.
    await db.exec(`
      INSERT INTO public.pagelle (scrutinio_id, alunno_id, file_url, ritirata_il)
      VALUES ('${SCRUTINIO}', '${ALUNNO}', '${SCRUTINIO}/${ALUNNO}.pdf', NULL)
      ON CONFLICT (scrutinio_id, alunno_id)
      DO UPDATE SET file_url = EXCLUDED.file_url, ritirata_il = EXCLUDED.ritirata_il`)
    const { rows } = await db.query<{ n: number; file_url: string; ritirata_il: string | null; file_ritirati: string[] }>(`
      SELECT count(*) OVER ()::int AS n, file_url, ritirata_il, file_ritirati
        FROM public.pagelle WHERE scrutinio_id = '${SCRUTINIO}' AND alunno_id = '${ALUNNO}'`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      file_url: `${SCRUTINIO}/${ALUNNO}.pdf`,
      ritirata_il: null,
      file_ritirati: [`ritirate/${SCRUTINIO}/${ALUNNO}-1.pdf`],
    })
  })

  it('su un database senza la tabella non si ferma', async () => {
    const vuoto = new PGlite()
    try {
      await expect(vuoto.exec(MIGRAZIONE)).resolves.toBeDefined()
    } finally {
      await vuoto.close()
    }
  })
})
```

- [ ] **Passo 2: rosso**

```bash
npx vitest run __tests__/lib/pagelle-ritirate-sql.test.ts 2>&1 | tail -6
```

Atteso: `1 failed`, `attesa UNA migrazione *_pagelle_ritirate.sql, trovate 0`.

- [ ] **Passo 3: la migrazione**

```bash
date -u +%Y%m%d%H%M%S
```

Crea `supabase/migrations/<V2>_pagelle_ritirate.sql`:

```sql
-- =============================================================================
-- LE PAGELLE RITIRATE DA UNA RIAPERTURA DELLO SCRUTINIO
--
-- Seconda serie di robustezza, sessione 10 («Operazioni a più passi senza perdite»).
--
-- Riaprire uno scrutinio chiuso cancellava i PDF delle pagelle e le loro righe: una pagella
-- già consegnata alle famiglie spariva senza traccia, e se un passo dopo falliva non si
-- tornava indietro. Ora la riapertura COPIA ogni PDF in `ritirate/<scrutinio>/<alunno>-
-- <istante>.pdf` dello stesso bucket, poi MARCA la riga, e solo alla fine toglie i PDF
-- dalla cartella dello scrutinio.
--
-- Due colonne e non una. Su `pagelle` c'è un vincolo di unicità su (scrutinio_id,
-- alunno_id): l'alunno ha UNA riga per scrutinio, e la generazione successiva fa l'upsert
-- proprio su quella coppia. La riga ritirata quindi non resta accanto alla nuova: è la
-- stessa riga, che la generazione rimette in vigore (`ritirata_il` torna NULL). Le copie si
-- accumulano in `file_ritirati`, che la generazione non tocca: è lo storico delle versioni
-- consegnate.
--   · `ritirata_il`   — quando la pagella in vigore è stata ritirata; NULL = in vigore.
--   · `file_ritirati` — i percorsi (bucket `pagelle`) delle copie ritirate, in ordine.
--
-- Senza queste colonne (DB della CI) il codice riconosce 42703/PGRST204, fa come prima e lo
-- dice nei log (`colonna-ritiro-assente`).
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'pagelle'
--      AND column_name IN ('ritirata_il', 'file_ritirati');
--   → due righe. Nel repo: `__tests__/lib/pagelle-ritirate-sql.test.ts`.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   Nessuno da applicare: le colonne restano inerti, il codice di prima non le legge.
--   Toglierle cancellerebbe lo storico delle pagelle ritirate e i soli riferimenti alle copie
--   in `ritirate/`: solo con una decisione scritta del titolare, in una migrazione sua.
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.pagelle') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE public.pagelle ADD COLUMN IF NOT EXISTS ritirata_il timestamptz;
  ALTER TABLE public.pagelle ADD COLUMN IF NOT EXISTS file_ritirati text[] NOT NULL DEFAULT '{}';

  COMMENT ON COLUMN public.pagelle.ritirata_il IS
    'Quando la pagella in vigore è stata ritirata da una riapertura dello scrutinio. NULL = in '
    'vigore. La generazione successiva la rimette a NULL (upsert sulla coppia scrutinio-alunno).';
  COMMENT ON COLUMN public.pagelle.file_ritirati IS
    'Percorsi nel bucket pagelle delle copie ritirate (ritirate/<scrutinio>/<alunno>-<istante>.pdf), '
    'in ordine. La generazione non lo tocca: è lo storico delle versioni consegnate.';
END $$;
```

- [ ] **Passo 4: verde, e i lock**

```bash
npx vitest run __tests__/lib/pagelle-ritirate-sql.test.ts 2>&1 | tail -6
npx vitest run __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -6
```

Atteso: `1 passed` (4 test), poi `3 passed`.

- [ ] **Passo 5: commit**

```bash
git add supabase/migrations/*_pagelle_ritirate.sql __tests__/lib/pagelle-ritirate-sql.test.ts
git commit -m "$(cat <<'EOF'
Pagelle: colonne ritirata_il e file_ritirati per la riapertura che conserva

La riga resta una per alunno e scrutinio: la riapertura la marca ritirata e ne
conserva la copia, la generazione successiva la rimette in vigore senza
perdere lo storico delle versioni consegnate.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 7 — `note_modifica`: la presa visione si toglie solo se cambia il testo, nella stessa transazione

**File:**
- Crea: `supabase/migrations/<V3>_note_modifica.sql`
- Test: `__tests__/lib/note-modifica-sql.test.ts`

Oggi la PATCH di `/api/primaria/note` (`src/app/api/primaria/note/route.ts:611-645`) cancella le prese visione con una richiesta e aggiorna la nota con un'altra: se la seconda fallisce, le famiglie hanno perso la firma e la nota è quella di prima. E le cancella per **qualunque** campo cambiato, anche la sola categoria. La funzione fa le due cose insieme, e le fa solo sulle note indicate in `p_ids_azzera` (quelle a cui la route vede cambiare il testo). Se nel Passo 6 del Compito 2 `note_disciplinari.data_evento` non c'era, togli `p_data_evento` dalla firma, dal corpo, dalle tre istruzioni dei permessi e dai test.

- [ ] **Passo 1: il test rosso**

`__tests__/lib/note-modifica-sql.test.ts`:

```ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * MODIFICA DI UNA NOTA · LA MIGRAZIONE SU UN POSTGRES VERO.
 * Ciò che si prova: la presa visione si toglie SOLO alle note indicate, nella stessa
 * transazione dell'aggiornamento; una sezione sbagliata non tocca niente. Schema minimo
 * dalla baseline (righe 2050-2080) più `data_evento`. Solo uuid e testi inventati.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).filter((f) => f.endsWith('_note_modifica.sql'))
if (FILE.length !== 1) throw new Error(`attesa UNA migrazione *_note_modifica.sql, trovate ${FILE.length}`)
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE[0]), 'utf8')

const SEZ = '70000000-0000-4000-8000-000000000001'
const ALTRA_SEZ = '70000000-0000-4000-8000-000000000002'
const N1 = '80000000-0000-4000-8000-000000000001'
const N2 = '80000000-0000-4000-8000-000000000002'
const N3 = '80000000-0000-4000-8000-000000000003'
const GRUPPO = '90000000-0000-4000-8000-000000000001'
const NUOVO_GRUPPO = '90000000-0000-4000-8000-000000000002'
const GENITORE = 'a0000000-0000-4000-8000-000000000001'

type PgErr = { code?: string; message: string }
type Nota = { id: string; categoria: string; testo: string; firmata_il: string | null; firmata_da: string | null; nota_gruppo_id: string | null; data_evento: string | null }
type Esito = { ricezioni_cancellate: number; note: Nota[] }

let db: PGlite

const uuidArr = (xs: string[]) => (xs.length ? `ARRAY[${xs.map((x) => `'${x}'`).join(', ')}]::uuid[]` : `'{}'::uuid[]`)
const testo = (v: string | null | undefined) => (v == null ? 'NULL::text' : `'${v}'::text`)

async function modifica(a: {
  ids: string[]; sezione: string | null; azzera?: string[]
  categoria?: string | null; testo?: string | null; firma?: boolean | null; data?: string | null; gruppo?: string | null
}): Promise<Esito> {
  const { rows } = await db.query<{ r: Esito }>(`
    SELECT public.note_modifica(
      ${uuidArr(a.ids)}, ${a.sezione ? `'${a.sezione}'::uuid` : 'NULL::uuid'}, ${uuidArr(a.azzera ?? [])},
      ${testo(a.categoria)}, ${testo(a.testo)}, ${a.firma == null ? 'NULL::boolean' : String(a.firma)},
      ${a.data ? `'${a.data}'::date` : 'NULL::date'}, ${a.gruppo ? `'${a.gruppo}'::uuid` : 'NULL::uuid'}
    ) AS r`)
  return rows[0].r
}

async function nota(id: string): Promise<Nota> {
  const { rows } = await db.query<Nota>(
    `SELECT id, categoria, testo, firmata_il::text, firmata_da::text, nota_gruppo_id::text, data_evento::text
       FROM public.note_disciplinari WHERE id = '${id}'`,
  )
  return rows[0]
}

async function ricezioni(id: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.nota_ricezioni WHERE nota_id = '${id}'`)
  return rows[0].n
}

async function errore(fn: () => Promise<unknown>): Promise<PgErr> {
  try {
    await fn()
  } catch (e) {
    return e as PgErr
  }
  throw new Error('attesa un\'eccezione dal database')
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

    CREATE TABLE public.note_disciplinari (
      id uuid PRIMARY KEY,
      alunno_id uuid,
      maestra_id uuid,
      categoria varchar(50),
      testo text,
      richiede_firma boolean DEFAULT false,
      firmata_il timestamptz,
      firmata_da uuid,
      creato_il timestamptz DEFAULT now(),
      section_id uuid,
      nota_gruppo_id uuid,
      oscurata_ad_altri boolean DEFAULT false,
      data_evento date
    );
    CREATE TABLE public.nota_ricezioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nota_id uuid REFERENCES public.note_disciplinari(id) ON DELETE CASCADE,
      alunno_id uuid,
      genitore_id uuid,
      firmato_il timestamptz,
      firma jsonb
    );
  `)
  await db.exec(MIGRAZIONE)
  await db.exec(MIGRAZIONE) // idempotente
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    DROP TRIGGER IF EXISTS rompi ON public.note_disciplinari;
    TRUNCATE public.nota_ricezioni, public.note_disciplinari;
    INSERT INTO public.note_disciplinari (id, categoria, testo, richiede_firma, firmata_il, firmata_da, section_id, nota_gruppo_id, data_evento) VALUES
      ('${N1}', 'comportamento', 'testo uno', true, '2026-09-09T12:00:00Z', '${GENITORE}', '${SEZ}', '${GRUPPO}', '2026-09-08'),
      ('${N2}', 'comportamento', 'testo uno', true, '2026-09-09T12:00:00Z', '${GENITORE}', '${SEZ}', '${GRUPPO}', '2026-09-08'),
      ('${N3}', 'comportamento', 'testo tre', true, '2026-09-09T12:00:00Z', '${GENITORE}', '${ALTRA_SEZ}', NULL, '2026-09-08');
    INSERT INTO public.nota_ricezioni (nota_id, genitore_id, firmato_il) VALUES
      ('${N1}', '${GENITORE}', '2026-09-09T12:00:00Z'),
      ('${N2}', '${GENITORE}', '2026-09-09T12:00:00Z'),
      ('${N3}', '${GENITORE}', '2026-09-09T12:00:00Z');
  `)
})

describe('note_modifica', () => {
  it('la sola categoria non tocca firme né prese visione', async () => {
    const e = await modifica({ ids: [N1, N2], sezione: SEZ, categoria: 'didattica' })
    expect(e.ricezioni_cancellate).toBe(0)
    expect(e.note.map((n) => n.categoria).sort()).toEqual(['didattica', 'didattica'])
    expect((await nota(N1)).firmata_il).not.toBeNull()
    expect(await ricezioni(N1)).toBe(1)
    expect(await ricezioni(N2)).toBe(1)
  })

  it('il testo nuovo azzera la firma solo delle note indicate', async () => {
    const e = await modifica({ ids: [N1, N2], sezione: SEZ, azzera: [N1], testo: 'testo nuovo' })
    expect(e.ricezioni_cancellate).toBe(1)
    expect(await nota(N1)).toMatchObject({ testo: 'testo nuovo', firmata_il: null, firmata_da: null })
    expect(await ricezioni(N1)).toBe(0)
    expect(await nota(N2)).toMatchObject({ testo: 'testo nuovo' })
    expect((await nota(N2)).firmata_il).not.toBeNull()
    expect(await ricezioni(N2)).toBe(1)
  })

  it('una nota di un\'altra sezione non si tocca, nemmeno se indicata da azzerare', async () => {
    const e = await modifica({ ids: [N3], sezione: SEZ, azzera: [N3], testo: 'intruso' })
    expect(e).toEqual({ ricezioni_cancellate: 0, note: [] })
    expect(await nota(N3)).toMatchObject({ testo: 'testo tre' })
    expect(await ricezioni(N3)).toBe(1)
  })

  it('la data nuova sposta la nota in un gruppo nuovo', async () => {
    await modifica({ ids: [N1], sezione: SEZ, data: '2026-10-01', gruppo: NUOVO_GRUPPO })
    expect(await nota(N1)).toMatchObject({ data_evento: '2026-10-01', nota_gruppo_id: NUOVO_GRUPPO })
    expect(await nota(N2)).toMatchObject({ data_evento: '2026-09-08', nota_gruppo_id: GRUPPO })
  })

  it('se l\'aggiornamento fallisce, la presa visione NON è stata tolta', async () => {
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.rompi_nota() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.testo = 'rompi' THEN RAISE EXCEPTION 'rotto apposta' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER rompi BEFORE UPDATE ON public.note_disciplinari FOR EACH ROW EXECUTE FUNCTION public.rompi_nota();
    `)
    const e = await errore(() => modifica({ ids: [N1], sezione: SEZ, azzera: [N1], testo: 'rompi' }))
    expect(e.code).toBe('P0001')
    expect(await ricezioni(N1)).toBe(1)
    expect((await nota(N1)).firmata_il).not.toBeNull()
  })

  it('senza note o senza sezione è una richiesta sbagliata: 22023', async () => {
    expect((await errore(() => modifica({ ids: [], sezione: SEZ }))).code).toBe('22023')
    expect((await errore(() => modifica({ ids: [N1], sezione: null }))).code).toBe('22023')
  })

  it('la porta è chiusa ad anon e authenticated, aperta al solo service_role', async () => {
    const firma = `'public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid)'`
    const { rows } = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon', ${firma}, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', ${firma}, 'EXECUTE') AS auth,
             has_function_privilege('service_role', ${firma}, 'EXECUTE') AS svc`)
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true })
  })
})
```

- [ ] **Passo 2: rosso**

```bash
npx vitest run __tests__/lib/note-modifica-sql.test.ts 2>&1 | tail -6
```

Atteso: `1 failed`, `attesa UNA migrazione *_note_modifica.sql, trovate 0`.

- [ ] **Passo 3: la migrazione**

```bash
date -u +%Y%m%d%H%M%S
```

Crea `supabase/migrations/<V3>_note_modifica.sql`:

```sql
-- =============================================================================
-- MODIFICA DI UNA NOTA: LA PRESA VISIONE SI TOGLIE SOLO SE CAMBIA IL TESTO
--
-- Seconda serie di robustezza, sessione 10 («Operazioni a più passi senza perdite»).
--
-- La PATCH di `/api/primaria/note` cancellava le prese visione delle famiglie con una
-- richiesta e aggiornava la nota con un'altra: se la seconda falliva, la firma era persa e
-- la nota era quella di prima. E le cancellava per QUALUNQUE campo cambiato, anche la sola
-- categoria. `note_modifica` fa le due cose nella stessa transazione e toglie la presa
-- visione solo alle note di `p_ids_azzera`, cioè quelle a cui la route vede cambiare il
-- testo. Solo le note della sezione `p_section_id`: un id di un'altra sezione non si tocca.
--
-- I parametri NULL lasciano il campo com'è. `p_nuovo_gruppo` è il gruppo nuovo quando la
-- data cambia (la nota esce dal gruppo che la legava alle altre).
--
-- Dove la funzione non c'è (DB della CI) la route ripiega sulle richieste separate, nello
-- stesso ordine di prima, e lo dice (`rpc-note-modifica-assente`).
--
-- ─── COME SI VERIFICA ────────────────────────────────────────────────────────
--   SELECT p.oid::regprocedure, has_function_privilege('authenticated', p.oid, 'EXECUTE')
--     FROM pg_proc p WHERE p.proname = 'note_modifica';
--   → una riga, `false`. Nel repo: `__tests__/lib/note-modifica-sql.test.ts`.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid);
--   La route ripiega da sola (PGRST202). Nessun dato da riportare indietro.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.note_modifica(
  p_ids uuid[],
  p_section_id uuid,
  p_ids_azzera uuid[] DEFAULT '{}',
  p_categoria text DEFAULT NULL,
  p_testo text DEFAULT NULL,
  p_richiede_firma boolean DEFAULT NULL,
  p_data_evento date DEFAULT NULL,
  p_nuovo_gruppo uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ricezioni int := 0;
  v_note jsonb;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR p_section_id IS NULL THEN
    RAISE EXCEPTION 'note_modifica: p_ids e p_section_id obbligatori' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.nota_ricezioni r
   USING public.note_disciplinari n
   WHERE r.nota_id = n.id
     AND n.id = ANY (p_ids)
     AND n.id = ANY (coalesce(p_ids_azzera, '{}'))
     AND n.section_id = p_section_id;
  GET DIAGNOSTICS v_ricezioni = ROW_COUNT;

  WITH aggiornate AS (
    UPDATE public.note_disciplinari n
       SET categoria      = coalesce(p_categoria, n.categoria),
           testo          = coalesce(p_testo, n.testo),
           richiede_firma = coalesce(p_richiede_firma, n.richiede_firma),
           data_evento    = coalesce(p_data_evento, n.data_evento),
           nota_gruppo_id = coalesce(p_nuovo_gruppo, n.nota_gruppo_id),
           firmata_il     = CASE WHEN n.id = ANY (coalesce(p_ids_azzera, '{}')) THEN NULL ELSE n.firmata_il END,
           firmata_da     = CASE WHEN n.id = ANY (coalesce(p_ids_azzera, '{}')) THEN NULL ELSE n.firmata_da END
     WHERE n.id = ANY (p_ids)
       AND n.section_id = p_section_id
    RETURNING n.*
  )
  SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) INTO v_note FROM aggiornate a;

  RETURN jsonb_build_object('ricezioni_cancellate', v_ricezioni, 'note', v_note);
END $$;

REVOKE ALL ON FUNCTION public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid) TO service_role;

COMMENT ON FUNCTION public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid) IS
  'Aggiorna le note di una sezione e toglie la presa visione delle famiglie SOLO alle note di '
  'p_ids_azzera (quelle a cui cambia il testo), nella stessa transazione. I parametri NULL '
  'lasciano il campo com''è. Ritorna le prese visione tolte e le note aggiornate.';
```

- [ ] **Passo 4: verde, e i lock**

```bash
npx vitest run __tests__/lib/note-modifica-sql.test.ts 2>&1 | tail -6
npx vitest run __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/migrazioni-distruttive-approvate.test.ts __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -8
```

Atteso: `1 passed` (7 test), poi `4 passed`.

- [ ] **Passo 5: commit**

```bash
git add supabase/migrations/*_note_modifica.sql __tests__/lib/note-modifica-sql.test.ts
git commit -m "$(cat <<'EOF'
Note: modifica e presa visione nella stessa transazione, solo se cambia il testo

note_modifica aggiorna le note di una sezione e toglie la firma delle famiglie
solo alle note indicate; se l'aggiornamento fallisce la presa visione resta.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Codice dell'app e interfaccia

Ogni compito di questa sezione funziona **anche senza** le migrazioni (DB della CI): riconosce il codice della funzione o della colonna assente, ripiega sul comportamento di prima e lo dice con un log. In produzione le migrazioni ci sono, e il ripiego non deve comparire mai nei log (lo verifica il Compito 18).

### Compito 8 — Personale: poteri, righe in transazione, account, file nel cestino

**File:**
- Modifica: `src/lib/personale/cancella-fascicolo.ts:1-167` (riscritto)
- Modifica: `src/app/api/admin/staff/eliminazione/route.ts:15` (import) e `:424-500` (`cancella`)
- Test: `__tests__/api/staff-eliminazione.test.ts:3-74, 121-125, 150-166, 297-335`
- Test: `__tests__/api/staff-riporta-a-genitore.test.ts:27-38, 48-54, 130-134, 150-159, 178-191`, un caso nuovo

L'ordine di oggi in `cancella` (`eliminazione/route.ts:439-469`) è *file → righe del fascicolo → poteri → account*: se l'account viene rifiutato (`23503`) la route archivia, ma le scansioni e il fascicolo sono già andati. L'ordine nuovo è *lettura dei percorsi → poteri → `personale_elimina_dipendente` → account → file nel cestino*. `riporta-a-genitore` non cambia codice: `cancellaFascicoloPersonale` mantiene firma e campi che quella route legge (`ok`, `motivo`, `fileRimossi`, `praticheCancellate`, `riporta-a-genitore/route.ts:199-260`), e cambia solo l'ordine interno (righe, poi cestino).

- [ ] **Passo 1: i test di `staff-eliminazione` descrivono l'ordine nuovo**

In `__tests__/api/staff-eliminazione.test.ts` sostituisci il commento di testa (righe 3-32) con:

```ts
/* ═══════════════════════════════════════════════════════════════════════════════
 * `admin/staff/eliminazione` — l'anteprima dice ciò che l'esecuzione farà
 *
 * ⚠️ IL FINTO NON EMULA LE CHIAVI ESTERNE, e va detto a lettere: accetta la
 * DELETE che Postgres rifiuterebbe. La domanda «questo docente è davvero
 * cancellabile?» la fa `personale_elimina_dipendente`, provata su PGlite in
 * `__tests__/lib/personale-elimina-dipendente-sql.test.ts`. Qui si prova che la
 * route ASCOLTA la risposta: 23503 → si archivia senza aver toccato un file, e mai
 * «cancellato» su una cancellazione che non c'è stata.
 *
 * ⚠️ LA PROIEZIONE È OBBLIGATORIA. Senza `creaFintoSupabaseConProiezione` il file
 * resterebbe verde anche se la route smettesse di CHIEDERE `ruolo` nella select
 * del bersaglio: la riga finta lo porterebbe comunque, e `puoEliminareStaff`
 * deciderebbe su un valore che in produzione sarebbe `undefined`.
 *
 * ─── L'ORDINE (sessione 10 della seconda serie di robustezza) ──────────────────
 *   poteri → righe in UNA transazione → account → file nel CESTINO.
 * I file per ULTIMI: un passo che fallisce dopo di loro li avrebbe persi. Nel
 * cestino e non cancellati: finché il giro notturno non li distrugge, un errore si
 * rimedia. I percorsi si leggono per primi, perché la cascata sulla pratica porta
 * via `caricamenti_personale`.
 *
 * ─── PROVA PER ROTTURA (Compito 8, Passo 7 del piano della sessione 10) ───────
 *   • `spostaScansioniNelCestino` spostato PRIMA di `eliminaRigheDipendente`
 *       → rossi «l'ordine» e «23503 … nessun file toccato»
 *   • tolto il ramo `rifiutata` (cade nel 503)                       → 1 rosso
 *   • fatto rispondere «cancellato» al ramo di ripiego dell'account  → 1 rosso
 * ═══════════════════════════════════════════════════════════════════════════════ */
```

Sostituisci il blocco `vi.hoisted` (righe 34-46) con:

```ts
const h = vi.hoisted(() => ({
  attore: {
    id: 'a0000000-0000-4000-8000-00000000000a',
    role: 'admin',
    ruoli: ['admin'],
    scuola_id: 'e0000000-0000-4000-8000-0000000000e1',
  } as Record<string, unknown>,
  deleteUserError: null as unknown,
  rpcChiamate: [] as { nome: string; args: unknown }[],
  /** Risposta per nome di funzione; una funzione assente risponde PGRST202, come il DB della CI. */
  rpcRisposte: {} as Record<string, { data: unknown; error: unknown }>,
  spostati: [] as string[][],
  ordine: [] as string[],
}))
```

Sostituisci il mock di `@/lib/storage/rimozione-verificata` (righe 65-74) con:

```ts
vi.mock('@/lib/storage/cestino-file', () => ({
  spostaNelCestino: vi.fn(async (_s: unknown, _b: string, percorsi: string[]) => {
    h.ordine.push('storage.cestino')
    h.spostati.push(percorsi)
    return { nelCestino: percorsi.length, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 0 }
  }),
}))

import { logEvento } from '@/lib/logging/logger'
```

Sostituisci la `rpc` finta (righe 121-125) con:

```ts
    ;(client as unknown as Record<string, unknown>).rpc = async (nome: string, args: unknown) => {
      h.ordine.push(`rpc.${nome}`)
      h.rpcChiamate.push({ nome, args })
      return h.rpcRisposte[nome] ?? { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    }
```

Nel `beforeEach` (righe 150-166) togli `h.rimozioni = []` e `h.esitoRimozione = 'ok'`, e aggiungi:

```ts
  h.spostati = []
  h.rpcRisposte = {
    personale_elimina_dipendente: {
      data: { pratiche_cancellate: 1, anagrafiche_cancellate: 1, profili_cancellati: 1 },
      error: null,
    },
    personale_cancella_fascicolo: { data: { pratiche_cancellate: 1, anagrafiche_cancellate: 1 }, error: null },
  }
```

Nel `describe('POST — cancella')` sostituisci i quattro test (righe 297-335) con:

```ts
  const conferma = () => POST(richiestaPost({ id: BERSAGLIO, decisioneAttesa: 'cancella', conferma: true }) as never)

  it("l'ordine: poteri → righe in transazione → account → file nel CESTINO, per ultimi", async () => {
    await conferma()
    const i = (passo: string) => h.ordine.indexOf(passo)
    expect(i('utenti_sezioni.delete')).toBeGreaterThanOrEqual(0)
    expect(i('utenti_sezioni.delete')).toBeLessThan(i('rpc.personale_elimina_dipendente'))
    expect(i('rpc.personale_elimina_dipendente')).toBeLessThan(i('auth.deleteUser'))
    expect(i('auth.deleteUser')).toBeLessThan(i('storage.cestino'))
    expect(h.spostati).toEqual([['p/fronte.jpg', 'p/retro.jpg']])
  })

  it('la funzione riceve anche la pratica d’origine', async () => {
    await conferma()
    expect(h.rpcChiamate[0]).toMatchObject({
      nome: 'personale_elimina_dipendente',
      args: { p_utente_id: BERSAGLIO, p_pratica_id: PRATICA },
    })
  })

  it('la risposta dice quanti file sono nel cestino', async () => {
    const res = await conferma()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      esito: 'cancellato',
      fileNelCestino: 2,
      fileRimossi: 2,
      praticheCancellate: 1,
      accountAccessoRimosso: true,
    })
  })

  it('23503 dal database: si ARCHIVIA, nessun file toccato, nessun account cancellato', async () => {
    h.rpcRisposte.personale_elimina_dipendente = {
      data: null,
      error: { code: '23503', message: 'violates foreign key constraint' },
    }
    const res = await conferma()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ esito: 'archiviato', motivo: 'cancellazione-rifiutata' })
    expect(db.utenti[0].archiviato_il).toBeTruthy()
    expect(h.spostati).toEqual([])
    expect(h.ordine).not.toContain('auth.deleteUser')
  })

  it('un guasto della funzione (57014): 503, nessun file toccato, nessun account cancellato', async () => {
    h.rpcRisposte.personale_elimina_dipendente = { data: null, error: { code: '57014', message: 'timeout' } }
    const res = await conferma()
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('FASCICOLO_NON_CANCELLATO')
    expect(h.spostati).toEqual([])
    expect(h.ordine).not.toContain('auth.deleteUser')
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'gdpr', 'error',
      expect.objectContaining({ esito: 'righe-dipendente-non-cancellate', entita_id: BERSAGLIO }),
      expect.objectContaining({ code: '57014' }),
    )
  })

  it.each(['PGRST202', '42883'])('funzione assente (%s, DB della CI): ripiega su personale_cancella_fascicolo e lo dice', async (code) => {
    h.rpcRisposte.personale_elimina_dipendente = { data: null, error: { code, message: 'funzione assente' } }
    const res = await conferma()
    expect((await res.json()).data.esito).toBe('cancellato')
    expect(h.rpcChiamate.map((c) => c.nome)).toEqual(['personale_elimina_dipendente', 'personale_cancella_fascicolo'])
    expect(h.rpcChiamate[1]).toMatchObject({ args: { p_utente_id: BERSAGLIO, p_pratica_id: PRATICA } })
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'gdpr', 'info',
      expect.objectContaining({ esito: 'rpc-eliminazione-assente-ripiego' }),
      expect.objectContaining({ code }),
    )
  })

  it.each(['42P01', '42703', 'PGRST205'])('%s dentro la funzione è schema a metà: niente ripiego, 503, nessun file toccato', async (code) => {
    h.rpcRisposte.personale_elimina_dipendente = { data: null, error: { code, message: 'manca qualcosa' } }
    const res = await conferma()
    expect(res.status).toBe(503)
    expect(h.rpcChiamate.map((c) => c.nome)).toEqual(['personale_elimina_dipendente'])
    expect(h.spostati).toEqual([])
    expect(h.ordine).not.toContain('auth.deleteUser')
  })

  it('ripiego e account rifiutato: i file vanno nel cestino PRIMA di archiviare, perché le righe non ci sono più', async () => {
    delete h.rpcRisposte.personale_elimina_dipendente
    h.deleteUserError = { code: '23503', message: 'violates foreign key constraint' }
    const res = await conferma()
    expect((await res.json()).data).toMatchObject({ esito: 'archiviato', motivo: 'cancellazione-rifiutata' })
    expect(h.ordine.indexOf('storage.cestino')).toBeGreaterThanOrEqual(0)
    expect(h.ordine.indexOf('storage.cestino')).toBeLessThan(h.ordine.indexOf('utenti.update'))
  })

  it('profilo cancellato ma account di accesso rifiutato: «cancellato», e lo si grida', async () => {
    h.deleteUserError = { status: 500, message: 'Database error deleting user' }
    const res = await conferma()
    expect((await res.json()).data).toMatchObject({ esito: 'cancellato', accountAccessoRimosso: false, fileNelCestino: 2 })
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'gdpr', 'error',
      expect.objectContaining({ esito: 'account-accesso-non-rimosso', entita_id: BERSAGLIO }),
      h.deleteUserError,
    )
    expect(db.utenti[0].archiviato_il).toBeFalsy()
  })
```

- [ ] **Passo 2: i test di `riporta-a-genitore`**

In `__tests__/api/staff-riporta-a-genitore.test.ts`:

Nel `vi.hoisted` (righe 27-38) aggiungi, dopo `rpcChiamate`:

```ts
  /** Se impostato, la RPC del fascicolo risponde con questo errore. */
  rpcErrore: null as unknown,
```

Sostituisci il mock di `@/lib/storage/rimozione-verificata` (righe 48-54) con:

```ts
vi.mock('@/lib/storage/cestino-file', () => ({
  spostaNelCestino: vi.fn(async (_s: unknown, _b: string, percorsi: string[]) => {
    h.ordine.push('storage.cestino')
    return { nelCestino: percorsi.length, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 0 }
  }),
}))
```

Sostituisci la `rpc` finta (righe 130-134) con:

```ts
    ;(client as unknown as Record<string, unknown>).rpc = async (nome: string, args: unknown) => {
      h.ordine.push(`rpc.${nome}`)
      h.rpcChiamate.push({ nome, args })
      if (h.rpcErrore) return { data: null, error: h.rpcErrore }
      return { data: { pratiche_cancellate: 1, anagrafiche_cancellate: 1 }, error: null }
    }
```

Nel `beforeEach` (righe 150-159) aggiungi `h.rpcErrore = null`.

Sostituisci i due test delle righe 178-191 con:

```ts
  it('cancella fascicolo e pratica, POI sposta i file nel cestino', async () => {
    const res = await POST(richiesta(corpoValido) as never)
    const { data } = await res.json()
    expect(data.fascicoloCancellato).toBe(true)
    expect(data.fileRimossi).toBe(2)
    expect(h.rpcChiamate[0]).toMatchObject({ args: { p_utente_id: BERSAGLIO, p_pratica_id: PRATICA } })
    expect(h.ordine.indexOf('rpc.personale_cancella_fascicolo')).toBeGreaterThanOrEqual(0)
    expect(h.ordine.indexOf('rpc.personale_cancella_fascicolo')).toBeLessThan(h.ordine.indexOf('storage.cestino'))
  })

  it('IL RUOLO PRIMA DEL FASCICOLO: il verso reversibile del guasto', async () => {
    await POST(richiesta(corpoValido) as never)
    expect(h.ordine.indexOf('utenti.update')).toBeLessThan(h.ordine.indexOf('rpc.personale_cancella_fascicolo'))
  })

  it('se le righe del fascicolo non si cancellano, i file restano dove sono', async () => {
    h.rpcErrore = { code: '57014', message: 'timeout' }
    const res = await POST(richiesta(corpoValido) as never)
    expect(res.status).toBe(200)
    expect((await res.json()).data.fascicoloCancellato).toBe(false)
    expect(h.ordine).not.toContain('storage.cestino')
  })
```

- [ ] **Passo 3: rossi**

```bash
npx vitest run __tests__/api/staff-eliminazione.test.ts __tests__/api/staff-riporta-a-genitore.test.ts 2>&1 | tail -15
```

Atteso: `Test Files  2 failed`. In `staff-eliminazione` falliscono i test del describe «cancella» (la route chiama ancora `personale_cancella_fascicolo` per prima e `storage.cestino` non compare); in `riporta-a-genitore` falliscono i tre test nuovi o riscritti (`storage.cestino` assente: oggi la libreria chiama `rimuoviEVerifica`).

- [ ] **Passo 4: `src/lib/personale/cancella-fascicolo.ts`, riscritto**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { spostaNelCestino, type EsitoCestino } from '@/lib/storage/cestino-file'
import { BUCKET_DOCUMENTI_PERSONALE } from './caricamenti'
import { percorsiDelDocumento, type ConDocumento } from './documento-righe'

/**
 * CANCELLARE IL FASCICOLO DI UN MEMBRO DEL PERSONALE — nell'ordine
 * **lettura dei percorsi → righe (in una transazione) → file nel cestino**.
 *
 * ─── DA DOVE NASCE ────────────────────────────────────────────────────────────
 *
 * Il modulo pubblico `/anagrafica-personale` è anonimo per scelta del titolare
 * (`20260811205643_anagrafica_personale.sql`, righe 35-43): chiunque abbia il
 * link può dichiararsi insegnante. Se la segreteria approva, `ensureStaffIdentity`
 * crea l'account E la scheda `anagrafica_personale` con codice fiscale,
 * residenza, estremi del documento e due SCANSIONI della carta d'identità. Su
 * una persona che non è un dipendente, quei dati non hanno base giuridica.
 *
 * ─── PERCHÉ I FILE PER ULTIMI, E NEL CESTINO ──────────────────────────────────
 *
 * Fino alla sessione 10 della seconda serie di robustezza i file uscivano per
 * PRIMI: la DELETE della pratica cascata su `caricamenti_personale`, l'unica riga
 * che li nomina, e con le righe cancellate prima un file rimasto nel bucket non
 * l'avrebbe più nominato nessuno. Ma l'ordine aveva il difetto opposto: se dopo i
 * file falliva un passo (la RPC, o l'account rifiutato da una chiave senza
 * cascata) il dipendente restava, archiviato, senza i suoi documenti.
 *
 * Ora i percorsi si LEGGONO per primi e restano in memoria; poi le righe, in una
 * transazione; poi i file si SPOSTANO in `cestino/<giorno>/` dello stesso bucket,
 * da cui li toglie il giro notturno `cestino-registro-retention`. Un guasto sulle
 * righe non ha toccato un file; uno spostamento che non riesce ripiega sulla
 * cancellazione di prima; un file che non si riesce né a spostare né a cancellare
 * si grida (`file-orfani-fuori-cestino`, in `cestino-file.ts`).
 *
 * ─── PERCHÉ UNA RPC PER LE RIGHE ──────────────────────────────────────────────
 *
 * PostgREST non rende atomiche due `.delete()`, e i due esiti parziali non si
 * somigliano: cancellata la sola anagrafica resta una pratica `approvata` e
 * slegata, che `retention-personale` non tocca MAI. Per l'eliminazione del
 * dipendente la transazione comprende anche il profilo (`personale_elimina_
 * dipendente`): una chiave senza cascata risponde 23503 e annulla tutto.
 *
 * ─── IDEMPOTENTE ──────────────────────────────────────────────────────────────
 *
 * Al secondo giro non c'è più il fascicolo: zero righe, zero file, e lo si dice.
 */

export type FascicoloLetto =
  | { ok: true; trovato: boolean; praticaId: string | null; percorsi: string[] }
  | { ok: false }

type RigaFascicolo = {
  utente_id: string
  origine_pratica_id?: string | null
  documento_fronte_path?: string | null
  documento_retro_path?: string | null
}

type Conteggi = { pratiche_cancellate?: number; anagrafiche_cancellate?: number; profili_cancellati?: number }

/**
 * `personale_elimina_dipendente` NON C'È ANCORA in questo database — i soli due codici con cui
 * succede: `PGRST202` (PostgREST non la trova nella schema cache: è il DB E2E della CI, che non è
 * migrato) e `42883` (Postgres: «undefined function»). Solo su QUESTA chiamata si ripiega sulla
 * funzione di prima, e lo si dice a livello `info` (specifica della seconda serie, §5; modello:
 * `RPC_ASSENTE` in `src/app/api/avvisi/[id]/risposte/route.ts`). Un insieme locale e non un
 * modulo comune, di proposito: nessun'altra chiamata deve poter ripiegare per contagio.
 *
 * Mai per gli altri codici: `42P01`/`42703` vogliono dire che la funzione c'è ma legge qualcosa
 * che manca (schema a metà, un guasto); `23503` (una chiave senza cascata) e `57014` (tempo
 * scaduto) sono risposte vere, e ripiegare su quelle rifarebbe a pezzi ciò che la funzione ha
 * appena rifiutato di fare tutto insieme. Si guarda il CODICE, mai il messaggio.
 */
const PERSONALE_ELIMINA_ASSENTE = new Set(['PGRST202', '42883'])

/** Il fascicolo, la pratica d'origine e i percorsi delle scansioni. Non scrive niente. */
export async function leggiFascicoloPersonale(
  supabase: SupabaseClient,
  utenteId: string,
  op: string,
): Promise<FascicoloLetto> {
  const { data: anagrafica, error: errAnagrafica } = await supabase
    .from('anagrafica_personale')
    .select('utente_id, origine_pratica_id, documento_fronte_path, documento_retro_path')
    .eq('utente_id', utenteId)
    .maybeSingle()
  if (errAnagrafica) {
    logErrore({ operazione: op, evento: 'fascicolo_lettura_anagrafica' }, errAnagrafica)
    return { ok: false }
  }
  // Nessun fascicolo: non c'è niente da cancellare, e non è un errore. È il caso
  // dei docenti senza anagrafica, e del secondo giro.
  if (!anagrafica) return { ok: true, trovato: false, praticaId: null, percorsi: [] }

  const riga = anagrafica as RigaFascicolo
  const praticaId = riga.origine_pratica_id ?? null

  // La pratica, per i SUOI percorsi: se il travaso all'approvazione era degradato
  // può averli ancora, e sono gli stessi file.
  let percorsiPratica: string[] = []
  if (praticaId) {
    const { data: pratica, error: errPratica } = await supabase
      .from('pratiche_personale')
      .select('id, documento_fronte_path, documento_retro_path')
      .eq('id', praticaId)
      .maybeSingle()
    if (errPratica) {
      logErrore({ operazione: op, evento: 'fascicolo_lettura_pratica' }, errPratica)
      return { ok: false }
    }
    if (pratica) percorsiPratica = percorsiDelDocumento(pratica as ConDocumento)
  }

  return {
    ok: true,
    trovato: true,
    praticaId,
    percorsi: [...new Set([...percorsiDelDocumento(riga), ...percorsiPratica])],
  }
}

export type EsitoRigheDipendente =
  | { esito: 'ok'; praticheCancellate: number; anagraficheCancellate: number; profiloEliminato: boolean }
  | { esito: 'rifiutata' }
  | { esito: 'guasto' }

/**
 * Pratica, fascicolo e profilo in UNA transazione. `rifiutata` = una chiave senza
 * cascata trattiene il profilo (23503): niente è stato cancellato, si archivia.
 * Dove la funzione non c'è (DB della CI) ripiega sulla sola cancellazione del
 * fascicolo, e il profilo resta da togliere all'account (`profiloEliminato: false`).
 */
export async function eliminaRigheDipendente(
  supabase: SupabaseClient,
  utenteId: string,
  praticaId: string | null,
  op: string,
): Promise<EsitoRigheDipendente> {
  const r = await supabase.rpc('personale_elimina_dipendente', { p_utente_id: utenteId, p_pratica_id: praticaId })
  if (!r.error) {
    const c = (r.data ?? {}) as Conteggi
    return {
      esito: 'ok',
      praticheCancellate: c.pratiche_cancellate ?? 0,
      anagraficheCancellate: c.anagrafiche_cancellate ?? 0,
      profiloEliminato: (c.profili_cancellati ?? 0) > 0,
    }
  }
  if (r.error.code === '23503') {
    logEvento('gdpr', 'warn', { operazione: op, esito: 'eliminazione-rifiutata-si-archivia', entita_id: utenteId }, r.error)
    return { esito: 'rifiutata' }
  }
  if (PERSONALE_ELIMINA_ASSENTE.has(r.error.code)) {
    // `info` (specifica §5): nel DB della CI la funzione non c'è ancora, ed è previsto. In
    // produzione questa riga non deve comparire mai (la cerca la misura «dopo»).
    logEvento('gdpr', 'info', { operazione: op, esito: 'rpc-eliminazione-assente-ripiego', entita_id: utenteId }, r.error)
    const vecchia = await supabase.rpc('personale_cancella_fascicolo', { p_utente_id: utenteId, p_pratica_id: praticaId })
    if (vecchia.error) {
      logEvento('gdpr', 'error', { operazione: op, esito: 'righe-fascicolo-non-cancellate', entita_id: utenteId }, vecchia.error)
      return { esito: 'guasto' }
    }
    const c = (vecchia.data ?? {}) as Conteggi
    return {
      esito: 'ok',
      praticheCancellate: c.pratiche_cancellate ?? 0,
      anagraficheCancellate: c.anagrafiche_cancellate ?? 0,
      profiloEliminato: false,
    }
  }
  logEvento('gdpr', 'error', { operazione: op, esito: 'righe-dipendente-non-cancellate', entita_id: utenteId }, r.error)
  return { esito: 'guasto' }
}

const CESTINO_VUOTO: EsitoCestino = { nelCestino: 0, giaAssenti: 0, rimossiSenzaCestino: 0, orfani: 0 }

/** Le scansioni nel cestino del bucket del personale. Mai i percorsi nei log. */
export async function spostaScansioniNelCestino(
  supabase: SupabaseClient,
  percorsi: string[],
  op: string,
): Promise<EsitoCestino> {
  if (percorsi.length === 0) return { ...CESTINO_VUOTO }
  return spostaNelCestino(supabase, BUCKET_DOCUMENTI_PERSONALE, percorsi, op)
}

export type EsitoFascicolo =
  | {
      ok: true
      /** Spostati nel cestino: recuperabili finché il giro notturno non li distrugge. */
      fileNelCestino: number
      /** Usciti dal loro posto: nel cestino più quelli cancellati subito. */
      fileRimossi: number
      fileGiaAssenti: number
      fileOrfani: number
      praticheCancellate: number
      anagraficheCancellate: number
    }
  | { ok: false; motivo: 'lettura-fallita' | 'righe-non-cancellate' }

/** Il solo fascicolo (il profilo resta): è il percorso di `riporta-a-genitore`. */
export async function cancellaFascicoloPersonale(
  supabase: SupabaseClient,
  utenteId: string,
  op: string,
): Promise<EsitoFascicolo> {
  const letto = await leggiFascicoloPersonale(supabase, utenteId, op)
  if (!letto.ok) return { ok: false, motivo: 'lettura-fallita' }
  if (!letto.trovato) {
    return {
      ok: true,
      fileNelCestino: 0,
      fileRimossi: 0,
      fileGiaAssenti: 0,
      fileOrfani: 0,
      praticheCancellate: 0,
      anagraficheCancellate: 0,
    }
  }

  const r = await supabase.rpc('personale_cancella_fascicolo', {
    p_utente_id: utenteId,
    p_pratica_id: letto.praticaId,
  })
  if (r.error) {
    // Nessun file è stato toccato: lo stato è quello di prima, e si può riprovare.
    logEvento('gdpr', 'error', { operazione: op, esito: 'righe-fascicolo-non-cancellate', entita_id: utenteId }, r.error)
    return { ok: false, motivo: 'righe-non-cancellate' }
  }
  const c = (r.data ?? {}) as Conteggi
  const file = await spostaScansioniNelCestino(supabase, letto.percorsi, op)
  return {
    ok: true,
    fileNelCestino: file.nelCestino,
    fileRimossi: file.nelCestino + file.rimossiSenzaCestino,
    fileGiaAssenti: file.giaAssenti,
    fileOrfani: file.orfani,
    praticheCancellate: c.pratiche_cancellate ?? 0,
    anagraficheCancellate: c.anagrafiche_cancellate ?? 0,
  }
}
```

- [ ] **Passo 5: la rotta di eliminazione**

In `src/app/api/admin/staff/eliminazione/route.ts` la riga 15 diventa:

```ts
import {
  eliminaRigheDipendente,
  leggiFascicoloPersonale,
  spostaScansioniNelCestino,
} from '@/lib/personale/cancella-fascicolo'
```

Le righe 424-500 (commento e funzione `cancella`) diventano:

```ts
/** Il 503 di un fascicolo che non si è potuto leggere o cancellare: nessun file è stato toccato. */
function fascicoloNonCancellato(): NextResponse {
  return NextResponse.json(
    {
      error: 'Non è stato possibile togliere i documenti dall’archivio: nessun dato è stato cancellato',
      codice: 'FASCICOLO_NON_CANCELLATO',
    },
    { status: 503 },
  )
}

/**
 * La cancellazione vera: poteri → righe (in una transazione) → account → file nel cestino.
 *
 * ⚠️ IL RAMO DI RIPIEGO È IL PUNTO DI QUESTA FUNZIONE. Postgres può rifiutare la
 * cancellazione del profilo per una chiave senza cascata che il registro non copriva
 * (una tabella nuova, una riga arrivata fra l'anteprima e adesso):
 * `personale_elimina_dipendente` risponde 23503 e annulla TUTTO, e qui si ARCHIVIA
 * senza aver toccato un file. Mai «cancellato» su una cancellazione che non c'è stata.
 *
 * I file per ULTIMI, e non cancellati: spostati nel cestino dello stesso bucket, da
 * cui li distrugge il giro notturno `cestino-registro-retention`. I percorsi si
 * leggono PRIMA di tutto, perché la cascata sulla pratica porta via i caricamenti
 * che li nominano.
 */
async function cancella(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  attore: Parameters<typeof logScrittura>[1]['attore'],
  utenteId: string,
  bersaglio: Bersaglio,
  plessi: string[],
): Promise<NextResponse> {
  // 1. Che cosa c'è da cancellare, letto prima di toccare qualunque cosa.
  const fascicolo = await leggiFascicoloPersonale(supabase, utenteId, OPERAZIONE_POST)
  if (!fascicolo.ok) return fascicoloNonCancellato()

  // 2. I poteri.
  if (!(await sganciaPoteri(supabase, utenteId, plessi, OPERAZIONE_POST))) {
    return NextResponse.json(
      { error: 'Non è stato possibile completare l’operazione', codice: 'STAFF_ELIMINAZIONE_NON_DECISA' },
      { status: 503 },
    )
  }

  // 3. Le righe: pratica, fascicolo e profilo insieme, o nessuna.
  const righe = await eliminaRigheDipendente(supabase, utenteId, fascicolo.praticaId, OPERAZIONE_POST)
  if (righe.esito === 'rifiutata') {
    return await archivia(supabase, attore, utenteId, bersaglio, plessi, 0, 'cancellazione-rifiutata')
  }
  if (righe.esito === 'guasto') return fascicoloNonCancellato()

  // 4. L'account di accesso.
  const { error: errAccount } = await supabase.auth.admin.deleteUser(utenteId)

  // 5. I file nel cestino: SEMPRE, a questo punto, perché le righe che li nominavano
  //    non ci sono più — anche quando l'account è stato rifiutato.
  const file = await spostaScansioniNelCestino(supabase, fascicolo.percorsi, OPERAZIONE_POST)

  let accountAccessoRimosso = true
  if (errAccount) {
    if (!righe.profiloEliminato) {
      // Ripiego (la funzione nuova non c'è): il profilo lo doveva togliere la cascata
      // dell'account, e l'account è stato rifiutato. Il dipendente esiste: si archivia.
      logEvento(
        'gdpr',
        'warn',
        { operazione: OPERAZIONE_POST, esito: 'eliminazione-rifiutata-si-archivia', entita_id: utenteId },
        errAccount,
      )
      return await archivia(supabase, attore, utenteId, bersaglio, plessi, 0, 'cancellazione-rifiutata')
    }
    // Il profilo non c'è più: senza profilo nessun gate lo fa entrare, ma l'account di
    // accesso è rimasto, e va tolto a mano. Si grida, con l'uuid per trovarlo.
    accountAccessoRimosso = false
    logEvento(
      'gdpr',
      'error',
      { operazione: OPERAZIONE_POST, esito: 'account-accesso-non-rimosso', entita_id: utenteId },
      errAccount,
    )
  }

  const fileRimossi = file.nelCestino + file.rimossiSenzaCestino
  await logScrittura(supabase, {
    attore,
    entitaTipo: 'utente_staff',
    entitaId: utenteId,
    azione: 'delete',
    scuolaId: bersaglio.scuolaId,
    valorePrima: {
      ruolo: bersaglio.ruolo,
      n_file_nel_cestino: file.nelCestino,
      n_file_rimossi: fileRimossi,
      pratiche_cancellate: righe.praticheCancellate,
    },
  })
  logEvento('gdpr', 'warn', {
    operazione: OPERAZIONE_POST,
    esito: 'staff-cancellato',
    entita_id: utenteId,
    sede_id: bersaglio.scuolaId,
    n_file_rimossi: fileRimossi,
    n_file_nel_cestino: file.nelCestino,
    n_file_gia_assenti: file.giaAssenti,
    n_file_orfani: file.orfani,
    account_accesso_rimosso: accountAccessoRimosso,
  })

  return NextResponse.json({
    success: true,
    data: {
      esito: 'cancellato',
      fileNelCestino: file.nelCestino,
      fileRimossi,
      praticheCancellate: righe.praticheCancellate,
      accountAccessoRimosso,
    },
  })
}
```

L'interfaccia (`src/components/features/admin/ZonaPericolosaStaff.tsx:406`) legge solo `data.esito`: i campi in più non la toccano.

- [ ] **Passo 6: verdi, e i lock**

```bash
npx vitest run __tests__/api/staff-eliminazione.test.ts __tests__/api/staff-riporta-a-genitore.test.ts 2>&1 | tail -8
npx vitest run __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts 2>&1 | tail -6
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `2 passed`; `3 passed`; `tsc` senza righe d'errore.

- [ ] **Passo 7: prova per rottura (e ritorno)**

In `cancella`, sposta la riga `const file = await spostaScansioniNelCestino(...)` subito prima di `const righe = await eliminaRigheDipendente(...)` e rilancia:

```bash
npx vitest run __tests__/api/staff-eliminazione.test.ts 2>&1 | tail -8
```

Atteso: rossi almeno «l'ordine…» e «23503 dal database…» (i file si muovono prima che il database decida). Rimetti la riga al suo posto, rilancia, verde. Se nessun test diventa rosso, il test dell'ordine non sta guardando quello che dice: correggilo prima di andare avanti.

- [ ] **Passo 8: commit**

```bash
git add src/lib/personale/cancella-fascicolo.ts src/app/api/admin/staff/eliminazione/route.ts __tests__/api/staff-eliminazione.test.ts __tests__/api/staff-riporta-a-genitore.test.ts
git commit -m "$(cat <<'EOF'
Eliminazione del personale: prima le righe in transazione, poi i file nel cestino

L'ordine diventa lettura dei percorsi → poteri → personale_elimina_dipendente →
account → scansioni nel cestino dello Storage. Un 23503 archivia senza aver
toccato un file; dove la funzione non c'è si ripiega su personale_cancella_fascicolo
dicendolo; un account di accesso rimasto senza profilo si grida.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 9 — Il giro notturno svuota anche il cestino dei file del personale

**File:**
- Modifica: `src/app/api/gdpr/retention-cestino-registro/route.ts:1-17` (import) e `:682-800` (`POST`)
- Test: `__tests__/api/gdpr-retention-cestino-registro.test.ts:163-170` (la `list` finta), un `describe` nuovo in fondo al file

La specifica (§7 «Sessione 10», «Cosa si tocca») lo dice così: il giro `cestino-registro-retention` «oggi lavora per righe e non conosce il bucket del personale: riceve un passo nuovo, con lo stesso termine del cestino del registro». Le righe che conosce sono `allegati_registro` e `student_documents` con `eliminato_il`: le scansioni spostate nel cestino non hanno una riga che le nomini. Il passo in più è `svuotaCestinoScaduto`, con lo **stesso termine** del cestino del registro (`sogliaPurgaCestinoRegistro`, `src/lib/primaria/cestino-registro.ts:80`): una costante sola, che il lock `cestino-registro-giorni-un-numero-solo` già sorveglia. Che le scansioni di un dipendente cancellato restino per quel termine e non per un altro è una decisione del titolare (decisione 1 in fondo).

- [ ] **Passo 1: la `list` finta conosce le cartelle e le pagine**

In `__tests__/api/gdpr-retention-cestino-registro.test.ts` sostituisci `list` (righe 163-170) con:

```ts
                    async list(cartella: string, opzioni?: { search?: string; limit?: number; offset?: number }) {
                        const err = h.errori[`list:${bucket}`]
                        if (err) return { data: null, error: err }
                        // Come lo Storage: le CARTELLE con `id: null`, i file con un id, per nome
                        // crescente, a pagine (`limit` 100 se non indicato), `search` = «comincia per».
                        const prefisso = cartella ? `${cartella}/` : ''
                        const voci = new Map<string, string | null>()
                        for (const p of insieme) {
                            if (!p.startsWith(prefisso)) continue
                            const resto = p.slice(prefisso.length)
                            const barra = resto.indexOf('/')
                            if (barra < 0) voci.set(resto, 'oggetto')
                            else if (!voci.has(resto.slice(0, barra))) voci.set(resto.slice(0, barra), null)
                        }
                        const nomi = [...voci.keys()].filter((n) => n.startsWith(opzioni?.search ?? '')).sort()
                        const da = opzioni?.offset ?? 0
                        const quanti = opzioni?.limit ?? 100
                        return {
                            data: nomi.slice(da, da + quanti).map((name) => ({ name, id: voci.get(name) ?? null })),
                            error: null,
                        }
                    },
```

Aggiorna anche il commento di `errori` nel `vi.hoisted` (righe 30-35) aggiungendo `` `list:${bucket}` `` fra le chiavi.

- [ ] **Passo 2: i test nuovi, in fondo al file**

```ts
describe('POST — il cestino dei file del personale (sessione 10)', () => {
    const B_PERSONALE = 'documenti_personale'
    const giornoFa = (giorni: number) => new Date(Date.now() - giorni * GIORNO).toISOString().slice(0, 10)

    it('svuota le cartelle-giorno oltre il termine del cestino e lascia le giovani', async () => {
        semina([], [])
        const vecchia = giornoFa(GIORNI_CESTINO_REGISTRO + 1)
        const nuova = giornoFa(GIORNI_CESTINO_REGISTRO - 1)
        h.bucket[B_PERSONALE] = new Set([
            `cestino/${vecchia}/P1/fronte.jpg`,
            `cestino/${vecchia}/P1/retro.jpg`,
            `cestino/${nuova}/P2/fronte.jpg`,
            'P3/fronte.jpg',
        ])
        const res = await chiama()
        expect(res.status).toBe(200)
        expect((await res.json()).cestino_personale).toMatchObject({ esito: 'ok', giorniScaduti: 1, fileRimossi: 2 })
        expect([...h.bucket[B_PERSONALE]].sort()).toEqual(['P3/fronte.jpg', `cestino/${nuova}/P2/fronte.jpg`])
        expect(battito()?.campi).toMatchObject({
            esito: 'ok',
            n_cestino_personale_giorni: 1,
            n_cestino_personale_file: 2,
            n_cestino_personale_bloccanti: 0,
            cestino_personale_ok: true,
        })
    })

    it('un file che resiste: 500, e il battito dice perché', async () => {
        semina([], [])
        const file = `cestino/${giornoFa(GIORNI_CESTINO_REGISTRO + 1)}/P1/fronte.jpg`
        h.bucket[B_PERSONALE] = new Set([file])
        h.resistenti.add(file)
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('cestino-personale-file-non-rimossi')
        expect(battito()?.campi).toMatchObject({
            esito: 'cestino-personale-file-non-rimossi',
            cestino_personale_ok: false,
            n_cestino_personale_bloccanti: 1,
        })
    })

    it('un elenco che non risponde: 500, e niente si cancella', async () => {
        semina([], [])
        const file = `cestino/${giornoFa(GIORNI_CESTINO_REGISTRO + 1)}/P1/fronte.jpg`
        h.bucket[B_PERSONALE] = new Set([file])
        h.errori[`list:${B_PERSONALE}`] = { message: 'internal error', statusCode: '500' }
        const res = await chiama()
        expect(res.status).toBe(500)
        expect((await res.json()).motivo).toBe('cestino-personale-elenco-fallito')
        expect(h.bucket[B_PERSONALE].has(file)).toBe(true)
    })

    it('il bucket è quello delle scansioni del personale, non un nome scritto a mano', () => {
        const sorgente = readFileSync(join(process.cwd(), 'src/app/api/gdpr/retention-cestino-registro/route.ts'), 'utf8')
        expect(sorgente).toContain("import { BUCKET_DOCUMENTI_PERSONALE } from '@/lib/personale/caricamenti'")
        expect(sorgente).toMatch(/svuotaCestinoScaduto\(\s*supabase,\s*BUCKET_DOCUMENTI_PERSONALE/)
    })
})
```

- [ ] **Passo 3: rossi**

```bash
npx vitest run __tests__/api/gdpr-retention-cestino-registro.test.ts 2>&1 | tail -10
```

Atteso: i quattro test nuovi rossi (`cestino_personale` è `undefined`, il bucket non si svuota); tutti gli altri verdi, anche con la `list` nuova.

- [ ] **Passo 4: la route**

In `src/app/api/gdpr/retention-cestino-registro/route.ts`, dopo l'import di `BUCKET_ALLEGATI_REGISTRO` (riga 17):

```ts
import { BUCKET_DOCUMENTI_PERSONALE } from '@/lib/personale/caricamenti'
import { SVUOTAMENTO_VUOTO, svuotaCestinoScaduto, type EsitoSvuotamento } from '@/lib/storage/cestino-file'
```

Nel `POST`, subito dopo la dichiarazione di `esiti` (righe 686-690):

```ts
    // Il cestino dei FILE del personale (sessione 10): non ha righe, ha cartelle-giorno
    // (`cestino/<AAAA-MM-GG>/…`) nel bucket delle scansioni.
    let cestinoPersonale: EsitoSvuotamento = { ...SVUOTAMENTO_VUOTO }
```

Subito dopo il ciclo `for (const c of CONTENITORI_CESTINO_REGISTRO) { … }`:

```ts
        // Stesso termine del cestino del registro, dalla stessa costante: un numero solo.
        cestinoPersonale = await svuotaCestinoScaduto(
            supabase,
            BUCKET_DOCUMENTI_PERSONALE,
            sogliaPurgaCestinoRegistro(adesso).slice(0, 10),
            JOB,
        )
```

Nel `corpo` aggiungi, dopo `fascicolo: esiti.fascicolo,`:

```ts
            cestino_personale: cestinoPersonale,
```

Fra il blocco `if (guasto) { … }` e il blocco `if (assenza) { … }`:

```ts
        if (cestinoPersonale.esito !== 'ok') {
            esitoBattito = `cestino-personale-${cestinoPersonale.esito}`
            return NextResponse.json({ ok: false, motivo: esitoBattito, ...corpo }, { status: 500 })
        }
```

Nel battito del `finally`, dopo `n_fascicolo_file: f.fileRimossi,`, sostituisci la riga `lotto_pieno: tutti.some((e) => e.lottoPieno),` con:

```ts
            n_cestino_personale_giorni: cestinoPersonale.giorniScaduti,
            n_cestino_personale_file: cestinoPersonale.fileRimossi,
            n_cestino_personale_bloccanti: cestinoPersonale.fileBloccanti,
            cestino_personale_ok: cestinoPersonale.esito === 'ok',
            lotto_pieno: tutti.some((e) => e.lottoPieno) || cestinoPersonale.lottoPieno,
```

e in fondo a `msg` aggiungi la parte del personale:

```ts
            msg:
                `${JOB}: cestino ${a.cancellate + f.cancellate} righe e ${a.fileRimossi + f.fileRimossi} file ` +
                `oltre i ${GIORNI_CESTINO_REGISTRO} giorni; conservazione ${k.cancellate} righe e ${k.fileRimossi} ` +
                `file oltre i ${GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO} giorni dal caricamento; ` +
                `personale ${cestinoPersonale.fileRimossi} file dal cestino`,
```

I totali `n_file_rimossi`, `n_righe`, … restano la somma dei soli tre contenitori di righe: i test esistenti li leggono così, e il cestino del personale ha le sue chiavi.

- [ ] **Passo 5: verdi, e i lock**

```bash
npx vitest run __tests__/api/gdpr-retention-cestino-registro.test.ts 2>&1 | tail -6
npx vitest run __tests__/architecture/cestino-registro-giorni-un-numero-solo.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/errori-postgrest-guardati.test.ts 2>&1 | tail -6
```

Atteso: `1 passed`; `3 passed`.

- [ ] **Passo 6: commit**

```bash
git add src/app/api/gdpr/retention-cestino-registro/route.ts __tests__/api/gdpr-retention-cestino-registro.test.ts
git commit -m "$(cat <<'EOF'
Giro notturno del cestino: svuota anche le scansioni del personale nel cestino

cestino-registro-retention distrugge le cartelle-giorno di cestino/ nel bucket
documenti_personale oltre lo stesso termine del cestino del registro; un file
che resiste o un elenco che non risponde fanno 500 e il battito lo dice.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 10 — Pagelle in vigore e ritirate: il modulo, la generazione, la GET dello scrutinio

**File:**
- Crea: `src/lib/primaria/pagelle-ritirate.ts`
- Modifica: `src/lib/primaria/pagella-store.ts:209-219` (`persistPagella`)
- Modifica: `src/app/api/primaria/scrutinio/route.ts:1-13` (import) e `:282-284`
- Test: `__tests__/lib/pagelle-ritirate.test.ts` (nuovo)
- Test: `__tests__/api/primaria-scrutinio-pagelle-archiviate.test.ts:17-40, 105-110`, un caso nuovo

Da qui in poi una riga di `pagelle` può essere **ritirata** (`ritirata_il` valorizzata) senza essere cancellata. Chi chiede «quali alunni hanno un PDF archiviato in vigore» lo deve dire (`.is('ritirata_il', null)`); chi genera la pagella la rimette in vigore (`ritirata_il: null` nell'upsert). Senza la colonna (`42703`/`PGRST204`) entrambi fanno come prima e lo dicono.

- [ ] **Passo 1: il test rosso del modulo e della generazione**

`__tests__/lib/pagelle-ritirate.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...orig, logEvento: h.logEvento }
})
// Il PDF non serve qui: `persistPagella` riceve il buffer già fatto.
vi.mock('@/lib/primaria/pagella-pdf', () => ({ buildPagellaPdf: vi.fn() }))

import { pagelleInVigore, percorsoPagellaRitirata } from '@/lib/primaria/pagelle-ritirate'
import { persistPagella } from '@/lib/primaria/pagella-store'

type Esito = { data: unknown; error: unknown }

function clientLettura(esiti: Esito[]) {
  const letture: string[][] = []
  const coda = [...esiti]
  const client = {
    from: (tabella: string) => {
      const passi = [tabella]
      const qb: Record<string, unknown> = {}
      qb.select = (c: string) => { passi.push(`select:${c}`); return qb }
      qb.eq = (c: string, v: unknown) => { passi.push(`eq:${c}=${String(v)}`); return qb }
      qb.is = (c: string, v: unknown) => { passi.push(`is:${c}=${String(v)}`); return qb }
      qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        letture.push(passi)
        return Promise.resolve(coda.shift() ?? { data: [], error: null }).then(res, rej)
      }
      return qb
    },
  }
  return { client: client as never, letture }
}

function clientGenerazione(erroriUpsert: unknown[] = []) {
  const upsert: { tabella: string; riga: Record<string, unknown>; opzioni: unknown }[] = []
  const coda = [...erroriUpsert]
  const client = {
    storage: {
      listBuckets: async () => ({ data: [{ name: 'pagelle' }], error: null }),
      createBucket: async () => ({ data: null, error: null }),
      from: () => ({ upload: async () => ({ data: { path: 'x' }, error: null }) }),
    },
    from: (tabella: string) => ({
      upsert: async (riga: Record<string, unknown>, opzioni: unknown) => {
        upsert.push({ tabella, riga, opzioni })
        return { data: null, error: coda.shift() ?? null }
      },
    }),
  }
  return { client: client as never, upsert }
}

const S = '50000000-0000-4000-8000-000000000001'
const A = '60000000-0000-4000-8000-000000000001'
const U = '70000000-0000-4000-8000-000000000001'
const DATI = { dirigente: null, chiusoIl: null } as never

beforeEach(() => vi.clearAllMocks())

describe('percorsoPagellaRitirata', () => {
  it('cartella dello scrutinio sotto ritirate/, alunno e istante al millesimo', () => {
    expect(percorsoPagellaRitirata(S, A, new Date('2026-11-03T10:00:00.123Z'))).toBe(`ritirate/${S}/${A}-20261103100000123.pdf`)
  })
})

describe('pagelleInVigore', () => {
  it('chiede solo le righe non ritirate dello scrutinio', async () => {
    const { client, letture } = clientLettura([{ data: [{ alunno_id: A }], error: null }])
    const r = await pagelleInVigore(client, S)
    expect(r).toEqual({ data: [{ alunno_id: A }], error: null })
    expect(letture).toEqual([['pagelle', 'select:alunno_id', `eq:scrutinio_id=${S}`, 'is:ritirata_il=null']])
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('senza la colonna (42703) rilegge senza filtro e lo dice a livello info', async () => {
    const { client, letture } = clientLettura([
      { data: null, error: { code: '42703', message: 'column pagelle.ritirata_il does not exist' } },
      { data: [{ alunno_id: A }], error: null },
    ])
    const r = await pagelleInVigore(client, S)
    expect(r).toEqual({ data: [{ alunno_id: A }], error: null })
    expect(letture[1]).toEqual(['pagelle', 'select:alunno_id', `eq:scrutinio_id=${S}`])
    expect(h.logEvento).toHaveBeenCalledWith('db', 'info', expect.objectContaining({ esito: 'colonna-ritiro-assente', scrutinio_id: S }))
  })

  it('un guasto vero non si ripiega: torna al chiamante', async () => {
    const guasto = { code: '08006', message: 'connection reset' }
    const { client, letture } = clientLettura([{ data: null, error: guasto }])
    expect(await pagelleInVigore(client, S)).toEqual({ data: null, error: guasto })
    expect(letture).toHaveLength(1)
  })
})

describe('persistPagella — la pagella rigenerata torna in vigore', () => {
  it('l’upsert rimette ritirata_il a NULL e non tocca file_ritirati', async () => {
    const { client, upsert } = clientGenerazione()
    await persistPagella(client, S, A, Buffer.from('pdf'), U, DATI)
    expect(upsert).toHaveLength(1)
    expect(upsert[0].riga).toMatchObject({ scrutinio_id: S, alunno_id: A, file_url: `${S}/${A}.pdf`, ritirata_il: null })
    expect(upsert[0].riga).not.toHaveProperty('file_ritirati')
    expect(upsert[0].opzioni).toEqual({ onConflict: 'scrutinio_id,alunno_id' })
  })

  it('senza la colonna (PGRST204) riprova senza, e lo dice', async () => {
    const { client, upsert } = clientGenerazione([{ code: 'PGRST204', message: "Could not find the 'ritirata_il' column" }])
    await persistPagella(client, S, A, Buffer.from('pdf'), U, DATI)
    expect(upsert).toHaveLength(2)
    expect(upsert[1].riga).not.toHaveProperty('ritirata_il')
    expect(h.logEvento).toHaveBeenCalledWith('db', 'info', expect.objectContaining({ esito: 'colonna-ritiro-assente' }))
  })

  it('un guasto vero lancia, senza secondo tentativo', async () => {
    const { client, upsert } = clientGenerazione([{ code: 'XX000', message: 'guasto' }])
    await expect(persistPagella(client, S, A, Buffer.from('pdf'), U, DATI)).rejects.toThrow('Registrazione della pagella archiviata non riuscita')
    expect(upsert).toHaveLength(1)
  })
})
```

- [ ] **Passo 2: il test della GET dello scrutinio**

In `__tests__/api/primaria-scrutinio-pagelle-archiviate.test.ts`, nel `vi.hoisted` (righe 17-40): aggiungi allo `state` una coda per tabella, consumata prima degli esiti fissi, e il filtro `is`:

```ts
  const state = {
    esiti: {} as Record<string, Esito>,
    /** Esiti da consumare in ordine PRIMA di `esiti` (per il ripiego, che legge due volte). */
    coda: {} as Record<string, Esito[]>,
    filtri: [] as Array<{ tabella: string; colonna: string; valore: unknown }>,
    select: [] as Array<{ tabella: string; colonne: string }>,
  }
```

e in `from(tabella)`:

```ts
        qb.eq = (colonna: string, valore: unknown) => { state.filtri.push({ tabella, colonna, valore }); return qb }
        qb.is = (colonna: string, valore: unknown) => { state.filtri.push({ tabella, colonna, valore }); return qb }
        for (const m of ['order', 'limit', 'in', 'insert']) qb[m] = () => qb
        const esito = () => Promise.resolve(state.coda[tabella]?.shift() ?? state.esiti[tabella] ?? { data: [], error: null })
```

Nel `beforeEach` aggiungi `h.state.coda = {}`. Le righe 105-110 diventano:

```ts
    // La query: colonna sola `alunno_id` (niente file_url, niente dati in più), filtro sullo
    // scrutinio restituito e sulle sole pagelle IN VIGORE (una riapertura le ritira, non le cancella).
    expect(h.state.select.filter((s) => s.tabella === 'pagelle')).toEqual([{ tabella: 'pagelle', colonne: 'alunno_id' }])
    expect(h.state.filtri.filter((f) => f.tabella === 'pagelle')).toEqual([
      { tabella: 'pagelle', colonna: 'scrutinio_id', valore: SCRUTINIO },
      { tabella: 'pagelle', colonna: 'ritirata_il', valore: null },
    ])
```

Aggiungi in fondo al `describe`:

```ts
  it('colonna del ritiro assente (DB della CI): rilegge senza filtro, e lo dice a livello info', async () => {
    h.state.coda.pagelle = [{ data: null, error: { code: '42703', message: 'column pagelle.ritirata_il does not exist' } }]
    h.state.esiti.pagelle = { data: [{ alunno_id: ALUNNO_A }], error: null }
    const corpo = await (await GET(richiesta())).json()
    expect(corpo.data.pagelleArchiviate).toEqual([ALUNNO_A])
    expect(corpo.data.pagelleArchiviateNonLette).toBe(false)
    expect(h.logEvento).toHaveBeenCalledWith('db', 'info', expect.objectContaining({ esito: 'colonna-ritiro-assente' }))
  })
```

- [ ] **Passo 3: rossi**

```bash
npx vitest run __tests__/lib/pagelle-ritirate.test.ts __tests__/api/primaria-scrutinio-pagelle-archiviate.test.ts 2>&1 | tail -10
```

Atteso: `pagelle-ritirate.test.ts` fallisce all'import (`Failed to resolve import "@/lib/primaria/pagelle-ritirate"`); nell'altro file falliscono il primo test (manca il filtro `ritirata_il`) e quello nuovo.

- [ ] **Passo 4: `src/lib/primaria/pagelle-ritirate.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'

/**
 * LE PAGELLE RITIRATE DA UNA RIAPERTURA DELLO SCRUTINIO.
 *
 * Una riapertura non cancella più le pagelle consegnate: le COPIA in
 * `ritirate/<scrutinio>/<alunno>-<istante>.pdf` dello stesso bucket e marca la riga
 * (`ritirata_il`, `file_ritirati`). La riga resta una per alunno (vincolo di unicità su
 * scrutinio e alunno): «in vigore» vuol dire `ritirata_il IS NULL`, e chi chiede le
 * pagelle in vigore lo deve dire.
 *
 * Senza le colonne (DB della CI, 42703) si legge come prima, senza filtro, e lo si dice:
 * lì la riapertura cancella ancora le righe, quindi «tutte» e «in vigore» coincidono.
 */

export const PREFISSO_RITIRATE = 'ritirate'

/** `ritirate/<scrutinio>/<alunno>-<AAAAMMGGhhmmssmmm>.pdf`: l'istante della riapertura, mai due uguali. */
export function percorsoPagellaRitirata(scrutinioId: string, alunnoId: string, adesso: Date): string {
  const istante = adesso.toISOString().replace(/\D/g, '').slice(0, 17)
  return `${PREFISSO_RITIRATE}/${scrutinioId}/${alunnoId}-${istante}.pdf`
}

const OP_IN_VIGORE = 'primaria/pagelle-ritirate:pagelleInVigore'

/** Gli alunni con una pagella archiviata IN VIGORE in questo scrutinio. Contratto `{ data, error }`. */
export async function pagelleInVigore(
  supabase: SupabaseClient,
  scrutinioId: string,
): Promise<{ data: { alunno_id: string }[] | null; error: unknown }> {
  const vigenti = await supabase
    .from('pagelle')
    .select('alunno_id')
    .eq('scrutinio_id', scrutinioId)
    .is('ritirata_il', null)
  if (!vigenti.error || !colonnaNuovaAssente(vigenti.error)) {
    return { data: (vigenti.data as { alunno_id: string }[] | null) ?? null, error: vigenti.error }
  }
  logEvento('db', 'info', { operazione: OP_IN_VIGORE, esito: 'colonna-ritiro-assente', scrutinio_id: scrutinioId })
  const tutte = await supabase.from('pagelle').select('alunno_id').eq('scrutinio_id', scrutinioId)
  return { data: (tutte.data as { alunno_id: string }[] | null) ?? null, error: tutte.error }
}
```

- [ ] **Passo 5: `persistPagella` rimette in vigore**

In `src/lib/primaria/pagella-store.ts` l'oggetto della riga (righe 210-216, con `firma_applicativa` alla 215) **non cambia**: cambia solo ciò che gli sta intorno.

La riga 209 (`const { error: errRiga } = await supabase.from('pagelle').upsert(`) diventa:

```ts
  // `ritirata_il: null`: una pagella rigenerata dopo una riapertura torna IN VIGORE. È la stessa
  // riga (vincolo di unicità su scrutinio e alunno) e `file_ritirati` non si tocca: è lo storico
  // delle versioni consegnate.
  const riga =
```

alla riga 216 la virgola finale cade (`},` diventa `}`), e le righe 217-219 diventano:

```ts
  const primo = await supabase.from('pagelle').upsert({ ...riga, ritirata_il: null }, { onConflict: 'scrutinio_id,alunno_id' })
  let errRiga = primo.error
  if (errRiga && colonnaNuovaAssente(errRiga)) {
    // DB della CI senza la colonna del ritiro: lì la riapertura cancella ancora le righe.
    logEvento('db', 'info', {
      operazione: 'primaria/pagella-store:persistPagella',
      esito: 'colonna-ritiro-assente',
      scrutinio_id: scrutinioId,
    })
    const secondo = await supabase.from('pagelle').upsert(riga, { onConflict: 'scrutinio_id,alunno_id' })
    errRiga = secondo.error
  }
  if (errRiga) throw new Error('Registrazione della pagella archiviata non riuscita', { cause: errRiga })
```

`colonnaNuovaAssente` e `logEvento` sono già importati (righe 3-4).

- [ ] **Passo 6: la GET dello scrutinio legge le sole pagelle in vigore**

In `src/app/api/primaria/scrutinio/route.ts`, dopo la riga 13:

```ts
import { pagelleInVigore } from '@/lib/primaria/pagelle-ritirate'
```

Le righe 282-284 diventano:

```ts
        // Quali alunni hanno DAVVERO un PDF archiviato IN VIGORE (spec 2026-09-24, S3; le
        // ritirate da una riapertura no): la pagina mostra «Elimina pagella» solo su queste.
        pagelleInVigore(supabase, scrutinio.id),
```

- [ ] **Passo 7: verdi**

```bash
npx vitest run __tests__/lib/pagelle-ritirate.test.ts __tests__/api/primaria-scrutinio-pagelle-archiviate.test.ts 2>&1 | tail -8
npx vitest run __tests__/api/primaria-pagella 2>&1 | tail -6
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `2 passed`; i file di test della pagella verdi (la generazione non è cambiata per chi la chiama); `tsc` senza errori.

- [ ] **Passo 8: commit**

```bash
git add src/lib/primaria/pagelle-ritirate.ts src/lib/primaria/pagella-store.ts src/app/api/primaria/scrutinio/route.ts __tests__/lib/pagelle-ritirate.test.ts __tests__/api/primaria-scrutinio-pagelle-archiviate.test.ts
git commit -m "$(cat <<'EOF'
Pagelle in vigore e ritirate: lettura filtrata, generazione che rimette in vigore

pagelleInVigore filtra ritirata_il IS NULL e ripiega senza filtro dove la
colonna manca, dicendolo; persistPagella rimette ritirata_il a NULL senza
toccare file_ritirati. La GET dello scrutinio offre «Elimina pagella» solo
sulle pagelle in vigore.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 11 — La riapertura dello scrutinio: copia, marca, e solo alla fine toglie

**File:**
- Modifica: `src/app/api/primaria/scrutinio/riapri/route.ts` (intero: righe 1-272)
- Test: `__tests__/api/primaria-scrutinio-riapri.test.ts:4-14, 25-89, 148-174, 179-192, 236-338, 403-444`, un `describe` nuovo

Oggi il passo 2 (`riapri/route.ts:160-199`) cancella i PDF e poi le righe: se le righe non si cancellano, i file sono già andati. Il passo nuovo:
- **2a.** copia ogni PDF della cartella dello scrutinio in `ritirate/…` (nessuna scrittura prima);
- **2b.** marca ogni riga, una per una, solo se ancora in vigore (`.is('ritirata_il', null)`);
- **2c.** toglie i PDF dalla cartella dello scrutinio.

Un guasto in 2a o 2b toglie le **sole copie create da questa richiesta** che nessuna riga nomina, e lascia originali e scrutinio come prima: la richiesta si ripete. Un guasto in 2c lascia righe già ritirate (con la copia) e scrutinio chiuso: la ripetizione non trova righe in vigore e toglie i PDF rimasti nella cartella.

- [ ] **Passo 1: il finto registra anche le copie e l'ordine di tutti i passi**

In `__tests__/api/primaria-scrutinio-riapri.test.ts`:

Il commento di testa (righe 4-14) diventa:

```ts
/**
 * POST /api/primaria/scrutinio/riapri — riapertura dello scrutinio chiuso (S1,
 * spec 2026-09-24 «sei interventi»; sessione 10 della seconda serie di robustezza).
 *
 * Il finto qui sotto REGISTRA ogni catena PostgREST (tabella, operazione, filtri,
 * payload) e ogni chiamata allo Storage, e risponde da una coda per
 * `tabella:operazione`. I test guardano QUALI scritture partono, con QUALI filtri e
 * in QUALE ordine — ritiro della pubblicazione, ritiro delle pagelle (copia in
 * `ritirate/`, marcatura della riga, poi i PDF fuori dalla cartella), riapertura —
 * e che `pagella_ricezioni` non venga mai toccata. `passi` mette in un'unica fila
 * scritture e Storage: è lì che si vede «prima la copia, poi tutto il resto».
 */
```

Nel `vi.hoisted` (righe 25-89) lo `state` diventa:

```ts
  const state = {
    code: {} as Record<string, Esito[]>,
    chiamate: [] as Chiamata[],
    storage: [] as Array<{ bucket: string; op: 'list' | 'remove' | 'copy'; arg: unknown }>,
    /** Scritture PostgREST e operazioni dello Storage, in un'unica fila. */
    passi: [] as string[],
    listEsito: { data: [], error: null } as Esito,
    removeEsito: null as Esito | null,
    /** Esiti di `copy`, in ordine; finita la coda la copia riesce. */
    copyEsiti: [] as Esito[],
  }
```

`scrive` registra anche il passo:

```ts
        const scrive = (op: Chiamata['op']) => (payload?: unknown) => {
          c.op = op
          c.payload = payload
          opFissata = true
          state.passi.push(`${table}:${op}`)
          return qb
        }
```

e lo Storage finto diventa:

```ts
      storage: {
        from(bucket: string) {
          return {
            list: (cartella: string, opts: unknown) => {
              state.storage.push({ bucket, op: 'list', arg: { cartella, opts } })
              state.passi.push('storage:list')
              return Promise.resolve(state.listEsito)
            },
            copy: (da: string, a: string) => {
              state.storage.push({ bucket, op: 'copy', arg: { da, a } })
              state.passi.push('storage:copy')
              return Promise.resolve(state.copyEsiti.shift() ?? { data: { path: a }, error: null })
            },
            remove: (percorsi: string[]) => {
              state.storage.push({ bucket, op: 'remove', arg: percorsi })
              state.passi.push('storage:remove')
              return Promise.resolve(
                state.removeEsito ?? { data: percorsi.map((name) => ({ name })), error: null },
              )
            },
          }
        },
      },
```

Le righe 148-174 (`righePagelle` e `preparaPercorsoFelice`) diventano:

```ts
const ID = (n: number) => `f1000000-0000-4000-8000-00000000000${n}`

const righePagelle: Esito = {
  data: [
    { id: ID(1), alunno_id: ALUNNO_1, file_url: `${SCRUTINIO}/${ALUNNO_1}.pdf`, file_ritirati: [] },
    { id: ID(2), alunno_id: ALUNNO_2, file_url: `${SCRUTINIO}/${ALUNNO_2}.pdf`, file_ritirati: [] },
    // Un file_url fuori dalla cartella dello scrutinio NON si copia e NON si cancella da qui.
    { id: ID(3), alunno_id: ALUNNO_ORFANO, file_url: `altro/${ALUNNO_ORFANO}.pdf`, file_ritirati: [] },
  ],
  error: null,
}

function preparaPercorsoFelice(scrutinio: Esito = scrutinioLetto()) {
  h.state.code = {
    'scrutini:select': [scrutinio],
    'scrutini:update': [
      { data: null, error: null }, // ritiro pubblicazione (senza .select)
      { data: { id: SCRUTINIO, section_id: SEZIONE, periodo_id: 'p', stato: 'aperto', pubblicato: false }, error: null },
    ],
    'notifiche:delete': [{ data: [{ id: 'n1' }, { id: 'n2' }], error: null }],
    'pagelle:select': [righePagelle],
    // Una marcatura per riga: ciascuna ritrova la SUA riga ancora in vigore.
    'pagelle:update': [1, 2, 3].map((n) => ({ data: [{ id: ID(n) }], error: null })),
    // Solo il ripiego senza colonne cancella le righe.
    'pagelle:delete': [{ data: [{ id: 1 }, { id: 2 }, { id: 3 }], error: null }],
  }
  // Nella cartella c'è anche un PDF SENZA riga (upsert fallito a suo tempo).
  h.state.listEsito = {
    data: [{ name: `${ALUNNO_1}.pdf` }, { name: `${ALUNNO_ORFANO}.pdf` }],
    error: null,
  }
}

const copie = () => h.state.storage.filter((s) => s.op === 'copy').map((s) => s.arg as { da: string; a: string })
const rimozioni = () => h.state.storage.filter((s) => s.op === 'remove').map((s) => s.arg as string[])
```

Nel `beforeEach` (righe 179-192) aggiungi `h.state.passi = []` e `h.state.copyEsiti = []`.

- [ ] **Passo 2: i test del percorso completo descrivono il ritiro**

Il test delle righe 236-290 diventa:

```ts
  it('ritira la pubblicazione, COPIA e marca le pagelle, poi toglie i PDF dalla cartella, riapre, e non tocca pagella_ricezioni', async () => {
    preparaPercorsoFelice()
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      success: true,
      pagelleRitirate: 3,
      pagelleEliminate: 0,
      fileConservati: 2,
      fileEliminati: 3,
      avvisiRitirati: 2,
    })

    // L'ordine è la sostanza: nessuna scrittura sulle pagelle prima delle copie,
    // nessun PDF fuori dalla cartella prima delle marcature.
    expect(h.state.passi).toEqual([
      'scrutini:update', // 1. ritiro pubblicazione
      'notifiche:delete', //    avviso «Pagella disponibile» in coda
      'storage:list', // 2. la cartella dello scrutinio
      'storage:copy', // 2a. copia di A1
      'storage:copy', //     copia di A2 (A3 punta fuori dalla cartella: niente copia)
      'pagelle:update', // 2b. marcature, una per riga
      'pagelle:update',
      'pagelle:update',
      'storage:remove', // 2c. solo adesso i PDF escono dalla cartella
      'scrutini:update', // 3. riapertura
    ])

    const w = scritture()
    // 1. Ritiro: solo la pubblicazione, a scrutinio ancora chiuso.
    expect(w[0].payload).toEqual({ pubblicato: false, pubblicato_da: null, pubblicato_il: null })
    expect(filtro(w[0], 'eq', 'id')).toBe(SCRUTINIO)
    expect(filtro(w[0], 'eq', 'stato')).toBe('chiuso')

    // Avviso: solo quello della pagella DI QUESTO scrutinio, e solo se non è partito.
    expect(filtro(w[1], 'eq', 'tipo')).toBe('pagella')
    expect(filtro(w[1], 'eq', 'entita_tipo')).toBe('scrutinio')
    expect(filtro(w[1], 'eq', 'entita_id')).toBe(SCRUTINIO)
    expect(w[1].filtri.some(([m, col]) => m === 'is' && col === 'push_inviata_il')).toBe(true)

    // 2. Si leggono solo le pagelle IN VIGORE.
    const lettura = h.state.chiamate.find((c) => c.table === 'pagelle' && c.op === 'select')!
    expect(filtro(lettura, 'eq', 'scrutinio_id')).toBe(SCRUTINIO)
    expect(lettura.filtri.some(([m, col, v]) => m === 'is' && col === 'ritirata_il' && v === null)).toBe(true)

    // 2a. Le copie: dai file della cartella a ritirate/<scrutinio>/<alunno>-<istante>.pdf.
    expect(copie().map((c) => c.da)).toEqual([`${SCRUTINIO}/${ALUNNO_1}.pdf`, `${SCRUTINIO}/${ALUNNO_2}.pdf`])
    copie().forEach((c, i) =>
      expect(c.a).toMatch(new RegExp(`^ritirate/${SCRUTINIO}/${[ALUNNO_1, ALUNNO_2][i]}-\\d{17}\\.pdf$`)),
    )

    // 2b. Le marcature: CAS sulla riga ancora in vigore, la copia diventa il file della riga.
    const marche = w.filter((c) => c.table === 'pagelle' && c.op === 'update')
    marche.forEach((m, i) => {
      expect(filtro(m, 'eq', 'id')).toBe(ID(i + 1))
      expect(filtro(m, 'eq', 'scrutinio_id')).toBe(SCRUTINIO)
      expect(m.filtri.some(([mm, col, v]) => mm === 'is' && col === 'ritirata_il' && v === null)).toBe(true)
    })
    expect(marche[0].payload).toEqual({ ritirata_il: expect.any(String), file_url: copie()[0].a, file_ritirati: [copie()[0].a] })
    expect(marche[2].payload).toEqual({ ritirata_il: expect.any(String), file_url: `altro/${ALUNNO_ORFANO}.pdf`, file_ritirati: [] })

    // 2c. File: righe + cartella, deduplicati, e MAI fuori dalla cartella; le copie restano.
    expect(rimozioni()).toHaveLength(1)
    expect([...rimozioni()[0]].sort()).toEqual(
      [`${SCRUTINIO}/${ALUNNO_1}.pdf`, `${SCRUTINIO}/${ALUNNO_2}.pdf`, `${SCRUTINIO}/${ALUNNO_ORFANO}.pdf`].sort(),
    )
    expect(rimozioni()[0]).not.toContain(`altro/${ALUNNO_ORFANO}.pdf`)
    expect(scritture().some((c) => c.table === 'pagelle' && c.op === 'delete')).toBe(false)

    // 3. Riapertura condizionata allo stato chiuso.
    const ultima = w[w.length - 1]
    expect(ultima.payload).toEqual({
      stato: 'aperto',
      chiuso_da: null,
      chiuso_il: null,
      pubblicato: false,
      pubblicato_da: null,
      pubblicato_il: null,
    })
    expect(filtro(ultima, 'eq', 'stato')).toBe('chiuso')

    // Le firme di ricezione sono storico: nessuna operazione su quella tabella.
    expect(h.state.chiamate.some((c) => c.table === 'pagella_ricezioni')).toBe(false)
  })
```

Nel test delle righe 292-322 il `valoreDopo` atteso e i campi del log diventano:

```ts
      valoreDopo: {
        stato: 'aperto',
        pubblicato: false,
        pagelle_ritirate: 3,
        pagelle_eliminate: 0,
        file_conservati: 2,
        file_eliminati: 3,
      },
```

```ts
    expect(ok![2]).toMatchObject({
      scrutinio_id: SCRUTINIO,
      section_id: SEZIONE,
      scuola_id: SCUOLA,
      era_pubblicato: true,
      pagelle_ritirate: 3,
      pagelle_eliminate: 0,
      file_conservati: 2,
      file_eliminati: 3,
      avvisi_ritirati: 2,
      ripiego_schema: false,
    })
```

Nel test delle righe 324-338 il titolo dice «… pagelle ritirate e riapertura» e le attese diventano:

```ts
    expect(scritture().map((c) => `${c.table}:${c.op}`)).toEqual([
      'notifiche:delete',
      'pagelle:update',
      'pagelle:update',
      'pagelle:update',
      'scrutini:update',
    ])
    expect((scritture()[4].payload as { stato: string }).stato).toBe('aperto')
```

Nel test delle righe 363-374 aggiungi `expect(h.state.storage.some((s) => s.op === 'copy')).toBe(false)`.

- [ ] **Passo 3: i guasti, vecchi e nuovi**

Il test delle righe 403-422 cambia titolo e guadagna due attese (il resto resta):

```ts
  it('rimozione dei file fallita → 500: righe già ritirate con la copia, scrutinio RESTA CHIUSO (si può ripetere)', async () => {
```

```ts
    // Le copie in ritirate/ non si toccano: la sola rimozione tentata è quella della cartella.
    expect(rimozioni()).toHaveLength(1)
    expect(rimozioni()[0].every((p) => p.startsWith(`${SCRUTINIO}/`))).toBe(true)
```

Nel test delle righe 424-436 aggiungi `expect(h.state.storage.some((s) => s.op === 'copy')).toBe(false)`.

Il test delle righe 438-444 diventa:

```ts
  it('marcatura fallita → 500: si tolgono le sole copie create, gli originali restano, lo scrutinio resta chiuso', async () => {
    preparaPercorsoFelice()
    h.state.code['pagelle:update'] = [{ data: null, error: GUASTO }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    expect(rimozioni()).toHaveLength(1)
    expect([...rimozioni()[0]].sort()).toEqual(copie().map((c) => c.a).sort())
    expect(scritture().some((c) => (c.payload as { stato?: string })?.stato === 'aperto')).toBe(false)
    expect(
      logMock.logEvento.mock.calls.some((c) => c[0] === 'db' && c[1] === 'error' && c[2]?.esito === 'pagelle-non-marcate'),
    ).toBe(true)
  })
```

In fondo al file, un `describe` nuovo:

```ts
describe('POST /api/primaria/scrutinio/riapri — il ritiro: prima la copia (sessione 10)', () => {
  it('una copia fallita → 500 prima di qualunque scrittura sulle pagelle, e la copia riuscita si toglie', async () => {
    preparaPercorsoFelice()
    h.state.copyEsiti = [
      { data: { path: 'x' }, error: null },
      { data: null, error: { message: 'internal error', statusCode: '500' } },
    ]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    expect(scritture().some((c) => c.table === 'pagelle')).toBe(false)
    expect(rimozioni()).toEqual([[copie()[0].a]])
    expect(
      logMock.logEvento.mock.calls.some((c) => c[0] === 'storage' && c[1] === 'error' && c[2]?.esito === 'pagelle-non-ritirate'),
    ).toBe(true)
  })

  it('la seconda marcatura fallisce: si toglie la sola copia di A2, la riga di A1 resta ritirata con la sua', async () => {
    preparaPercorsoFelice()
    h.state.code['pagelle:update'] = [{ data: [{ id: ID(1) }], error: null }, { data: null, error: GUASTO }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    expect(rimozioni()).toEqual([[copie()[1].a]])
  })

  it('un PDF che non c’è più (404): la riga si ritira lo stesso, senza copia', async () => {
    preparaPercorsoFelice()
    h.state.copyEsiti = [{ data: null, error: { message: 'Object not found', statusCode: '404' } }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(200)
    expect((await res.json()).fileConservati).toBe(1)
    const prima = scritture().find((c) => c.table === 'pagelle' && c.op === 'update')!
    expect(prima.payload).toEqual({ ritirata_il: expect.any(String), file_url: `${SCRUTINIO}/${ALUNNO_1}.pdf`, file_ritirati: [] })
  })

  it('riga già ritirata da un’altra riapertura (zero righe aggiornate): la sua copia si toglie', async () => {
    preparaPercorsoFelice()
    h.state.code['pagelle:update'] = [{ data: [], error: null }, { data: [{ id: ID(2) }], error: null }, { data: [{ id: ID(3) }], error: null }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(200)
    expect((await res.json()).pagelleRitirate).toBe(2)
    expect(rimozioni()[0]).toEqual([copie()[0].a])
  })

  it('colonne del ritiro assenti (DB della CI, 42703): il comportamento di prima, e lo si dice', async () => {
    preparaPercorsoFelice()
    h.state.code['pagelle:select'] = [
      { data: null, error: { code: '42703', message: 'column pagelle.ritirata_il does not exist' } },
      righePagelle,
    ]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ pagelleRitirate: 0, pagelleEliminate: 3, fileConservati: 0 })
    expect(h.state.storage.some((s) => s.op === 'copy')).toBe(false)
    expect(scritture().map((c) => `${c.table}:${c.op}`)).toEqual([
      'scrutini:update',
      'notifiche:delete',
      'pagelle:delete',
      'scrutini:update',
    ])
    const seconda = h.state.chiamate.filter((c) => c.table === 'pagelle' && c.op === 'select')[1]
    expect(seconda.colonne).toBe('id, alunno_id, file_url')
    expect(logMock.logEvento).toHaveBeenCalledWith('db', 'info', expect.objectContaining({ esito: 'colonna-ritiro-assente' }))
  })

  it('ripiego con la cancellazione delle righe fallita → 500, scrutinio chiuso', async () => {
    preparaPercorsoFelice()
    h.state.code['pagelle:select'] = [{ data: null, error: { code: '42703', message: 'x' } }, righePagelle]
    h.state.code['pagelle:delete'] = [{ data: null, error: GUASTO }]
    const res = await POST(req({ scrutinioId: SCRUTINIO }))
    expect(res.status).toBe(500)
    expect(scritture().some((c) => (c.payload as { stato?: string })?.stato === 'aperto')).toBe(false)
  })
})
```

- [ ] **Passo 4: rossi**

```bash
npx vitest run __tests__/api/primaria-scrutinio-riapri.test.ts 2>&1 | tail -12
```

Atteso: rossi il percorso completo, l'audit, il «non pubblicato», la marcatura fallita e il `describe` nuovo tranne, forse, il ripiego con la cancellazione fallita (che il codice di oggi soddisfa per caso). Gli altri verdi.

- [ ] **Passo 5: la route, riscritta**

`src/app/api/primaria/scrutinio/riapri/route.ts` diventa:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type StaffRole } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'
import { PAGELLE_BUCKET } from '@/lib/primaria/pagella-store'
import { percorsoPagellaRitirata } from '@/lib/primaria/pagelle-ritirate'
import { copiaNelBucket, type CoppiaCopia } from '@/lib/storage/copia-verificata'

// Il nome della route, per i log. `withRoute` lo riceve come LETTERALE (il lock
// `logging-coverage` lo legge dal sorgente e lo confronta col percorso del file).
const OP = 'primaria/scrutinio/riapri:POST'

/**
 * Chi può riaprire: Segreteria e Direzione (decisione del titolare, spec
 * 2026-09-24 §2 Primaria). Il docente no — la chiusura è un atto della
 * dirigenza, e la riapertura ritira documenti già consegnati alle famiglie.
 */
const RUOLI_RIAPERTURA: readonly StaffRole[] = ['admin', 'coordinator', 'segreteria']

/** Tetto di sicurezza della lettura della cartella: una classe ha ~30 alunni. */
const LIMITE_ELENCO_FILE = 1000

const postBodySchema = z.object({
  scrutinioId: zUuid,
})

/**
 * Guasto → 500 con codice. `area` sceglie l'evento del log: i guasti del bucket
 * vanno sotto 'storage' (chi cerca in `app_log` perché i PDF non si cancellano
 * filtra su quello), quelli di PostgREST sotto 'db'.
 */
function nonRiuscita(esito: string, error: unknown, area: 'db' | 'storage' = 'db'): NextResponse {
  logEvento(area, 'error', { operazione: OP, esito }, error)
  return NextResponse.json(
    { error: 'Riapertura non riuscita', codice: 'SCRUTINIO_RIAPERTURA_NON_RIUSCITA' },
    { status: 500 },
  )
}

function giaAperto(): NextResponse {
  return NextResponse.json(
    { error: 'Lo scrutinio non è chiuso', codice: 'SCRUTINIO_RIAPERTURA_NON_CHIUSO' },
    { status: 409 },
  )
}

/**
 * Toglie le copie in `ritirate/` che QUESTA richiesta ha creato e che nessuna riga nomina (una
 * riapertura interrotta a metà). Se non ci riesce lo dice: restano file in più, mai pagelle perse.
 */
async function togliCopie(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  copie: string[],
): Promise<void> {
  if (copie.length === 0) return
  try {
    const { error } = await supabase.storage.from(PAGELLE_BUCKET).remove(copie)
    if (error) logEvento('storage', 'error', { operazione: OP, esito: 'copie-ritirate-orfane', n_file: copie.length }, error)
  } catch (e) {
    logEvento('storage', 'error', { operazione: OP, esito: 'copie-ritirate-orfane', n_file: copie.length }, e)
  }
}

type RigaScrutinio = {
  id: string
  section_id: string
  stato: string
  pubblicato: boolean | null
  chiuso_il: string | null
  pubblicato_il: string | null
  sections: { scuola_id: string | null } | { scuola_id: string | null }[] | null
}

type RigaPagella = { id: string; alunno_id: string; file_url: string | null; file_ritirati?: string[] | null }

/**
 * POST /api/primaria/scrutinio/riapri — body: { scrutinioId }
 *
 * Riporta uno scrutinio CHIUSO ad APERTO. Tre passi, in quest'ordine, e l'ordine
 * è la sostanza:
 *
 *  1. **Ritiro della pubblicazione** (se era pubblicato): `pubblicato=false`; e
 *     l'avviso «Pagella disponibile» ancora in coda si ritira SEMPRE, anche se lo
 *     scrutinio risulta già non pubblicato (nessuna rettifica se è già partito).
 *     È il passo che toglie la pagella agli occhi dei genitori
 *     — tutti i lettori dei genitori filtrano su `pubblicato = true` — e va per
 *     PRIMO: se dopo qualcosa si rompe, i genitori non vedono comunque più niente.
 *  2. **Ritiro delle pagelle PDF** (sessione 10 della seconda serie di robustezza):
 *     2a. ogni PDF della cartella dello scrutinio citato da una riga in vigore si
 *         COPIA in `ritirate/<scrutinio>/<alunno>-<istante>.pdf`, prima di qualunque
 *         scrittura;
 *     2b. ogni riga si MARCA ritirata (`ritirata_il`, la copia in `file_url` e in coda
 *         a `file_ritirati`), solo se ancora in vigore;
 *     2c. solo adesso i PDF escono dalla cartella dello scrutinio (quelli citati dalle
 *         righe PIÙ quelli presenti senza riga, se l'upsert era fallito).
 *     Un guasto in 2a o 2b toglie le sole copie create qui e lascia tutto com'era.
 *     `pagella_ricezioni` NON si tocca: dipende da `scrutinio_id`, non dalle pagelle,
 *     ed è lo storico delle firme di ricezione. Senza le colonne del ritiro (DB della
 *     CI) si cancellano file e righe come prima, e lo si dice.
 *  3. **Riapertura**: `stato='aperto'`, `chiuso_da`/`chiuso_il` azzerati.
 *
 * Se il passo 2 fallisce, lo scrutinio resta CHIUSO e non pubblicato: la stessa
 * richiesta si può ripetere (le righe già ritirate non si rileggono, i PDF rimasti
 * nella cartella si tolgono). Se si riaprisse prima, un guasto a metà lascerebbe uno
 * scrutinio aperto con PDF vecchi che una seconda chiamata non potrebbe più pulire
 * (risponderebbe 409 «non chiuso»).
 */
export const POST = withRoute('primaria/scrutinio/riapri:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, RUOLI_RIAPERTURA)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scrutinioId } = b.data

    const supabase = await createAdminClient()

    const { data: letto, error: errScrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, stato, pubblicato, chiuso_il, pubblicato_il, sections(scuola_id)')
      .eq('id', scrutinioId)
      .maybeSingle()
    if (errScrutinio) return nonRiuscita('scrutinio-non-letto', errScrutinio)
    if (!letto) {
      return NextResponse.json(
        { error: 'Scrutinio inesistente', codice: 'SCRUTINIO_RIAPERTURA_NON_TROVATO' },
        { status: 404 },
      )
    }
    const scrutinio = letto as unknown as RigaScrutinio

    // Sede PRIMA dello stato: la Segreteria e la Direzione riaprono solo scrutini
    // del proprio plesso, e a chi è fuori sede la risposta non deve dipendere
    // dallo stato di uno scrutinio che non le appartiene (409 vs 403).
    const scopeErr = await assertSezioneInScope(supabase, auth.user, scrutinio.section_id)
    if (scopeErr) return scopeErr

    if (scrutinio.stato !== 'chiuso') return giaAperto()

    const sez = Array.isArray(scrutinio.sections) ? scrutinio.sections[0] : scrutinio.sections
    const scuolaId = sez?.scuola_id ?? null

    // ── 1. Ritiro della pubblicazione ───────────────────────────────────────
    if (scrutinio.pubblicato) {
      const { error: errRitiro } = await supabase
        .from('scrutini')
        .update({ pubblicato: false, pubblicato_da: null, pubblicato_il: null })
        .eq('id', scrutinioId)
        .eq('section_id', scrutinio.section_id)
        .eq('stato', 'chiuso')
      if (errRitiro) return nonRiuscita('pubblicazione-non-ritirata', errRitiro)
    }

    // Avviso «Pagella disponibile» ancora in coda: si ritira SEMPRE, non solo se
    // lo scrutinio risulta pubblicato adesso. Può restare in coda con
    // `pubblicato=false` in due casi: un tentativo precedente ha ritirato la
    // pubblicazione ma non l'avviso (e poi è fallito più avanti), oppure la
    // pubblicazione è stata ritirata con /scrutinio/pubblica, che gli avvisi non
    // li tocca. Il delete è idempotente e costa una query.
    let avvisiRitirati = 0
    const { data: ritirati, error: errAvvisi } = await supabase
      .from('notifiche')
      .delete()
      .eq('tipo', 'pagella')
      .eq('entita_tipo', 'scrutinio')
      .eq('entita_id', scrutinioId)
      .is('push_inviata_il', null)
      .select('id')
    if (errAvvisi) {
      // Non blocca: la pubblicazione è ritirata, ma l'avviso «Pagella
      // disponibile» resta in coda e partirà per una pagella che non c'è più.
      logEvento('notifica', 'error', {
        operazione: OP,
        esito: 'avviso-pagella-non-ritirato',
        tipo: 'pagella',
        scrutinio_id: scrutinioId,
      }, errAvvisi)
    } else {
      avvisiRitirati = ((ritirati ?? []) as unknown[]).length
    }

    // ── 2. Ritiro delle pagelle PDF ─────────────────────────────────────────
    // Solo le righe IN VIGORE: una ripetizione dopo un guasto non rimarca quelle già ritirate.
    const vigenti = await supabase
      .from('pagelle')
      .select('id, alunno_id, file_url, file_ritirati')
      .eq('scrutinio_id', scrutinioId)
      .is('ritirata_il', null)
    const ripiegoSchema = !!vigenti.error && colonnaNuovaAssente(vigenti.error)
    if (ripiegoSchema) {
      logEvento('db', 'info', { operazione: OP, esito: 'colonna-ritiro-assente', scrutinio_id: scrutinioId })
    }
    const lettura = ripiegoSchema
      ? await supabase.from('pagelle').select('id, alunno_id, file_url').eq('scrutinio_id', scrutinioId)
      : vigenti
    if (lettura.error) return nonRiuscita('pagelle-non-lette', lettura.error)
    const pagelle = (lettura.data ?? []) as RigaPagella[]

    const bucket = supabase.storage.from(PAGELLE_BUCKET)
    const { data: elenco, error: errElenco } = await bucket.list(scrutinioId, { limit: LIMITE_ELENCO_FILE })
    if (errElenco) return nonRiuscita('cartella-pagelle-non-letta', errElenco, 'storage')

    // Solo percorsi DENTRO la cartella di questo scrutinio: un `file_url` che
    // puntasse altrove non si copia e non si cancella da qui.
    const prefisso = `${scrutinioId}/`
    const nellaCartella = (p: string | null): p is string => !!p && p.startsWith(prefisso)
    const daRimuovere = new Set<string>()
    for (const p of pagelle) {
      if (nellaCartella(p.file_url)) daRimuovere.add(p.file_url)
    }
    for (const f of (elenco ?? []) as { name: string }[]) {
      if (f.name && !f.name.includes('/')) daRimuovere.add(`${prefisso}${f.name}`)
    }

    let righeRitirate = 0
    let righeEliminate = 0
    let fileConservati = 0
    let fileEliminati = 0

    if (ripiegoSchema) {
      // DB senza le colonne del ritiro (la CI): file e righe cancellati, come prima.
      if (daRimuovere.size > 0) {
        const { data: rimossi, error: errRimozione } = await bucket.remove([...daRimuovere])
        if (errRimozione) return nonRiuscita('file-pagelle-non-eliminati', errRimozione, 'storage')
        fileEliminati = ((rimossi ?? []) as unknown[]).length
      }
      if (pagelle.length > 0) {
        const { data: cancellate, error: errCancella } = await supabase
          .from('pagelle')
          .delete()
          .eq('scrutinio_id', scrutinioId)
          .select('id')
        if (errCancella) return nonRiuscita('righe-pagelle-non-eliminate', errCancella)
        righeEliminate = ((cancellate ?? []) as unknown[]).length
      }
    } else {
      // 2a. Le copie, PRIMA di qualunque scrittura sulle pagelle.
      const adesso = new Date()
      const copiaDi = new Map<string, string>()
      const coppie: CoppiaCopia[] = []
      for (const p of pagelle) {
        if (!nellaCartella(p.file_url)) continue
        const a = percorsoPagellaRitirata(scrutinioId, p.alunno_id, adesso)
        copiaDi.set(p.id, a)
        coppie.push({ da: p.file_url, a })
      }
      const esitoCopie = await copiaNelBucket(supabase, PAGELLE_BUCKET, coppie, OP)
      const arrivate = new Set([...esitoCopie.copiati, ...esitoCopie.giaPresenti].map((c) => c.a))
      // Le sole copie che QUESTA richiesta ha creato: una «già presente» è di qualcun altro.
      const nostre = new Set(esitoCopie.copiati.map((c) => c.a))
      if (esitoCopie.falliti.length > 0) {
        await togliCopie(supabase, [...nostre])
        return nonRiuscita('pagelle-non-ritirate', esitoCopie.primoErrore, 'storage')
      }

      // 2b. Le marcature, riga per riga, solo se ancora in vigore.
      const trattate = new Set<string>()
      for (const p of pagelle) {
        const copia = copiaDi.get(p.id)
        const conservata = copia && arrivate.has(copia) ? copia : null
        const precedenti = Array.isArray(p.file_ritirati) ? p.file_ritirati : []
        const { data: marcate, error: errMarca } = await supabase
          .from('pagelle')
          .update({
            ritirata_il: adesso.toISOString(),
            file_url: conservata ?? p.file_url,
            file_ritirati: conservata ? [...precedenti, conservata] : precedenti,
          })
          .eq('id', p.id)
          .eq('scrutinio_id', scrutinioId)
          .is('ritirata_il', null)
          .select('id')
        if (errMarca) {
          const senzaRiga = pagelle
            .filter((q) => !trattate.has(q.id))
            .map((q) => copiaDi.get(q.id))
            .filter((c): c is string => !!c && nostre.has(c))
          await togliCopie(supabase, senzaRiga)
          return nonRiuscita('pagelle-non-marcate', errMarca)
        }
        trattate.add(p.id)
        if (((marcate ?? []) as unknown[]).length === 0) {
          // Un'altra riapertura l'ha già ritirata: vale la sua copia, la nostra si toglie.
          if (conservata && nostre.has(conservata)) await togliCopie(supabase, [conservata])
          continue
        }
        righeRitirate++
        if (conservata) fileConservati++
      }

      // 2c. Solo adesso i PDF escono dalla cartella dello scrutinio.
      if (daRimuovere.size > 0) {
        const { data: rimossi, error: errRimozione } = await bucket.remove([...daRimuovere])
        if (errRimozione) return nonRiuscita('file-pagelle-non-eliminati', errRimozione, 'storage')
        fileEliminati = ((rimossi ?? []) as unknown[]).length
      }
    }

    // ── 3. Riapertura ───────────────────────────────────────────────────────
    const { data: riaperto, error: errRiapri } = await supabase
      .from('scrutini')
      .update({
        stato: 'aperto',
        chiuso_da: null,
        chiuso_il: null,
        pubblicato: false,
        pubblicato_da: null,
        pubblicato_il: null,
      })
      .eq('id', scrutinioId)
      .eq('section_id', scrutinio.section_id)
      .eq('stato', 'chiuso')
      .select('id, section_id, periodo_id, stato, pubblicato')
      .maybeSingle()
    if (errRiapri) return nonRiuscita('scrutinio-non-riaperto', errRiapri)
    // Nessuna riga: un'altra riapertura è passata nel frattempo.
    if (!riaperto) return giaAperto()

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'scrutinio',
      entitaId: scrutinioId,
      azione: 'update',
      scuolaId,
      sectionId: scrutinio.section_id,
      valorePrima: {
        stato: 'chiuso',
        pubblicato: !!scrutinio.pubblicato,
        chiuso_il: scrutinio.chiuso_il,
        pubblicato_il: scrutinio.pubblicato_il,
        pagelle: pagelle.map((p) => ({ id: p.id, alunno_id: p.alunno_id })),
      },
      valoreDopo: {
        stato: 'aperto',
        pubblicato: false,
        pagelle_ritirate: righeRitirate,
        pagelle_eliminate: righeEliminate,
        file_conservati: fileConservati,
        file_eliminati: fileEliminati,
      },
    })

    // Il SUCCESSO si logga: riaprire uno scrutinio ritira documenti già
    // consegnati alle famiglie. Solo uuid, numeri e booleani.
    logEvento('registro', 'info', {
      operazione: OP,
      esito: 'scrutinio-riaperto',
      scrutinio_id: scrutinioId,
      section_id: scrutinio.section_id,
      scuola_id: scuolaId,
      attore_id: auth.user.id,
      era_pubblicato: !!scrutinio.pubblicato,
      avvisi_ritirati: avvisiRitirati,
      pagelle_ritirate: righeRitirate,
      pagelle_eliminate: righeEliminate,
      file_conservati: fileConservati,
      file_eliminati: fileEliminati,
      ripiego_schema: ripiegoSchema,
    }, undefined, { distingui: ['scrutinio_id'] })

    return NextResponse.json({
      success: true,
      data: riaperto,
      pagelleRitirate: righeRitirate,
      pagelleEliminate: righeEliminate,
      fileConservati,
      fileEliminati,
      avvisiRitirati,
    })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Riapertura non riuscita', codice: 'SCRUTINIO_RIAPERTURA_NON_RIUSCITA' },
      { status: 500 },
    )
  }
})
```

- [ ] **Passo 6: verdi, e i lock**

```bash
npx vitest run __tests__/api/primaria-scrutinio-riapri.test.ts 2>&1 | tail -8
npx vitest run __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/zod-coverage.test.ts 2>&1 | tail -6
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `1 passed`; `4 passed`; `tsc` senza errori.

- [ ] **Passo 7: prova per rottura (e ritorno)**

Sposta il blocco «2c» (la `bucket.remove` del percorso nuovo) subito prima del commento «2a» e rilancia il file: devono diventare rossi almeno il percorso completo (ordine dei `passi`) e «marcatura fallita» (la rimozione toglierebbe gli originali). Rimetti il blocco al suo posto, rilancia, verde.

- [ ] **Passo 8: commit**

```bash
git add src/app/api/primaria/scrutinio/riapri/route.ts __tests__/api/primaria-scrutinio-riapri.test.ts
git commit -m "$(cat <<'EOF'
Riapertura dello scrutinio: le pagelle consegnate si ritirano, non si cancellano

Prima la copia in ritirate/<scrutinio>/, poi la marcatura delle righe ancora in
vigore, solo alla fine i PDF fuori dalla cartella. Un guasto a metà toglie le
sole copie create e lascia lo scrutinio chiuso e ripetibile; senza le colonne
del ritiro (DB della CI) si fa come prima e lo si dice.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 12 — Chi legge `pagelle` sa delle versioni ritirate: eliminazione, oblio, storici

**File:**
- Modifica: `src/app/api/primaria/pagella/route.ts:1-12` (import), `:105-110` (tipo), `:124-139` (commento), `:173-255` (corpo della DELETE)
- Modifica: `src/lib/gdpr/esegui.ts:784-803` (`obliaPagelleAlunno`)
- Modifica: `src/lib/storici/adattatori/scolastici-primaria.ts:191-192`
- Test: `__tests__/api/primaria-pagella-elimina.test.ts` (un `describe` nuovo dopo la riga 352)
- Test: `__tests__/lib/gdpr-oblio-storage-verificato.test.ts:57` e un `describe` in fondo
- Test: `__tests__/lib/storici-scolastici.test.ts` (due casi dopo la riga 447)

Dopo il Compito 11 una riga di `pagelle` può nominare copie in `ritirate/` che **solo lei** nomina (`file_ritirati`). Tre lettori la trattano ancora come «una riga, un PDF»:
- la DELETE della pagella (`pagella/route.ts:205-214`) cancellerebbe la riga e lascerebbe le copie senza indice;
- l'oblio (`esegui.ts:789-803`) toglierebbe il solo `file_url` e cancellerebbe la riga: le versioni precedenti di una pagella, cioè giudizi su un bambino, resterebbero nell'archivio senza che niente le nomini;
- gli storici (`scolastici-primaria.ts:191`) esporterebbero la sola versione di `file_url`.

Il conteggio del giro a vuoto dell'oblio (`cosa-distrugge`) conta righe, non file, e non cambia.

- [ ] **Passo 1: i test rossi della DELETE**

In `__tests__/api/primaria-pagella-elimina.test.ts`, dopo la riga 352 (chiusura del `describe` «il percorso completo»):

```ts
describe('DELETE /api/primaria/pagella — le versioni ritirate restano (sessione 10)', () => {
  const RITIRATA = `ritirate/${SCRUTINIO}/${ALUNNO}-20261103100000123.pdf`

  it('pagella in vigore con versioni ritirate: il PDF esce, la riga si RITIRA sull’ultima versione invece di sparire', async () => {
    preparaPercorsoFelice(rigaPagella({ ritirata_il: null, file_ritirati: [RITIRATA] }))
    h.state.code['pagelle:update'] = [{ data: [{ id: PAGELLA }], error: null }]
    const res = await DELETE(reqValida())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, rigaEliminata: false, rigaConservata: true, fileEliminati: 1 })
    expect(h.state.storage[0].arg).toEqual([FILE_ALUNNO])
    expect(h.state.ordine).toEqual(['scrutini:select', 'pagelle:select', 'storage:pagelle:remove', 'pagelle:update'])

    const w = scritture()
    expect(w.map((c) => `${c.table}:${c.op}`)).toEqual(['pagelle:update'])
    expect(w[0].payload).toEqual({ ritirata_il: expect.any(String), file_url: RITIRATA })
    expect(w[0].filtri).toContainEqual(['is', 'ritirata_il', null])
    expect(filtro(w[0], 'eq', 'id')).toBe(PAGELLA)

    expect(auditMock.logScrittura.mock.calls[0][1]).toMatchObject({
      azione: 'update',
      entitaId: PAGELLA,
      valoreDopo: { ritirata_il: expect.any(String), file_url: RITIRATA },
    })
    expect(logMock.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'pagella-eliminata-storico-conservato', riga_conservata: true }),
      undefined,
      expect.anything(),
    )
  })

  it('riga già ritirata e nessun PDF in vigore → 404: la riga e le sue copie non si toccano', async () => {
    preparaPercorsoFelice(rigaPagella({ file_url: RITIRATA, ritirata_il: '2026-11-03T10:00:00Z', file_ritirati: [RITIRATA] }))
    h.state.fileEsistenti = new Set([RITIRATA])
    const res = await DELETE(reqValida())
    expect(res.status).toBe(404)
    expect(h.state.storage[0].arg).toEqual([FILE_ALUNNO])
    expect(h.state.fileEsistenti.has(RITIRATA)).toBe(true)
    expect(scritture()).toEqual([])
  })

  it('colonne del ritiro assenti (DB della CI, 42703): legge come prima e cancella la riga, e lo dice', async () => {
    preparaPercorsoFelice()
    h.state.code['pagelle:select'] = [
      { data: null, error: { code: '42703', message: 'column pagelle.ritirata_il does not exist' } },
      rigaPagella(),
    ]
    const res = await DELETE(reqValida())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, rigaEliminata: true, fileEliminati: 1 })
    const letture = h.state.chiamate.filter((c) => c.table === 'pagelle' && c.op === 'select')
    expect(letture.map((c) => c.colonne)).toEqual([
      'id, file_url, generata_il, generata_da, ritirata_il, file_ritirati',
      'id, file_url, generata_il, generata_da',
    ])
    expect(logMock.logEvento).toHaveBeenCalledWith('db', 'info', expect.objectContaining({ esito: 'colonna-ritiro-assente' }))
  })

  it('ritiro della riga fallito → 500 con codice, niente audit né log di successo', async () => {
    preparaPercorsoFelice(rigaPagella({ file_ritirati: [RITIRATA] }))
    h.state.code['pagelle:update'] = [{ data: null, error: GUASTO }]
    const res = await DELETE(reqValida())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('PAGELLA_ELIMINAZIONE_NON_RIUSCITA')
    expect(auditMock.logScrittura).not.toHaveBeenCalled()
    expect(logMock.logEvento).toHaveBeenCalledWith('db', 'error', expect.objectContaining({ esito: 'riga-pagella-non-ritirata' }), GUASTO)
  })
})
```

- [ ] **Passo 2: i test rossi dell'oblio e degli storici**

In `__tests__/lib/gdpr-oblio-storage-verificato.test.ts` la riga 57 diventa:

```ts
  pagelle?: { id: string; file_url: string | null; file_ritirati?: string[] }[]
```

e in fondo al file:

```ts
describe('oblio · le pagelle RITIRATE da una riapertura (sessione 10)', () => {
  const R1 = 'ritirate/scr-1/al-1-20261001090000000.pdf'
  const R2 = 'ritirate/scr-1/al-1-20261103100000123.pdf'

  it('ALUNNO · escono anche le copie in `ritirate/`, PRIMA della riga che le nomina', async () => {
    const f = fakeArchivio({
      presenti: { pagelle: ['scr-1/al-1.pdf', R1, R2] },
      pagelle: [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf', file_ritirati: [R1, R2] }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(f.archivio.get('pagelle')?.size, 'una pagella ritirata è rimasta nell’archivio dopo l’oblio').toBe(0)
    const iCopie = f.removed.findIndex((x) => x.bucket === 'pagelle' && x.paths.includes(R1))
    const iOriginale = f.removed.findIndex((x) => x.bucket === 'pagelle' && x.paths.includes('scr-1/al-1.pdf'))
    expect(iCopie).toBeGreaterThanOrEqual(0)
    expect(iCopie).toBeLessThan(iOriginale)
    expect(f.deleted.some((d) => d.table === 'pagelle')).toBe(true)
    expect(r.fileNonRimossi).toBe(0)
  })

  it('ALUNNO · una copia ritirata resta nel bucket → la riga NON si cancella, e si grida', async () => {
    const f = fakeArchivio({
      presenti: { pagelle: ['scr-1/al-1.pdf', R1] },
      rimuoveDavvero: false,
      forma: 'vuota',
      pagelle: [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf', file_ritirati: [R1] }],
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(f.deleted.some((d) => d.table === 'pagelle'), 'la riga che nomina la copia rimasta è sparita').toBe(false)
    expect(r.fileNonRimossi).toBeGreaterThan(0)
    expect(esitiErrore()).toContain('pagelle-ritirate-trattenute')
  })
})
```

In `__tests__/lib/storici-scolastici.test.ts`, dopo la riga 447 (stesso `describe`):

```ts
  it('una pagella ritirata da una riapertura porta tutte le versioni consegnate, ciascuna riconoscibile', async () => {
    const r1 = `ritirate/scrutinio/${A}-20261001090000000.pdf`
    const r2 = `ritirate/scrutinio/${A}-20261103100000123.pdf`
    const d = database({ sections: [classe], scrutinio_periodi: [periodo], scrutini: [scrutinio], pagelle: [{ id: 'p1', scrutinio_id: 'scrutinio', alunno_id: A,
      generata_il: '2026-09-01T12:00:00Z', file_url: r2, ritirata_il: '2026-11-03T10:00:00Z', file_ritirati: [r1, r2] }] })
    const ctx = contesto(d.db); ctx.richiesta.dal = '2026-06-01'; ctx.richiesta.al = '2026-06-30'
    const s = await raccogliScolastico(ctx, 'primaria_pagelle')
    expect(s?.allegati.map(a => a.percorso)).toEqual([r2, r1])
    expect(s?.allegati[0].nome).toMatch(/\(ritirata\)\.pdf$/)
    expect(s?.allegati[1].nome).toMatch(/\(ritirata 1\)\.pdf$/)
  })

  it('una pagella di nuovo in vigore: l’originale col suo nome, la versione ritirata accanto', async () => {
    const r1 = `ritirate/scrutinio/${A}-20261001090000000.pdf`
    const d = database({ sections: [classe], scrutinio_periodi: [periodo], scrutini: [scrutinio], pagelle: [{ id: 'p1', scrutinio_id: 'scrutinio', alunno_id: A,
      generata_il: '2026-09-01T12:00:00Z', file_url: `scrutinio/${A}.pdf`, ritirata_il: null, file_ritirati: [r1] }] })
    const ctx = contesto(d.db); ctx.richiesta.dal = '2026-06-01'; ctx.richiesta.al = '2026-06-30'
    const s = await raccogliScolastico(ctx, 'primaria_pagelle')
    expect(s?.allegati.map(a => a.percorso)).toEqual([`scrutinio/${A}.pdf`, r1])
    expect(s?.allegati[0].nome).not.toMatch(/ritirata/)
    expect(s?.allegati[1].nome).toMatch(/\(ritirata 1\)\.pdf$/)
  })
```

- [ ] **Passo 3: rossi**

```bash
npx vitest run __tests__/api/primaria-pagella-elimina.test.ts __tests__/lib/gdpr-oblio-storage-verificato.test.ts __tests__/lib/storici-scolastici.test.ts 2>&1 | tail -12
```

Atteso: rossi i quattro casi nuovi della DELETE (tranne, forse, il 404 della riga ritirata, che il codice di oggi soddisfa cancellando la riga: lì il rosso è `scritture()` non vuoto), i due dell'oblio (`pagelle-ritirate-trattenute` mai scritto; le copie restano) e i due degli storici (un solo allegato). Tutti gli altri verdi.

- [ ] **Passo 4: la DELETE della pagella**

In `src/app/api/primaria/pagella/route.ts`, dopo la riga 12:

```ts
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'
```

Le righe 105-110 diventano:

```ts
type PagellaArchiviata = {
  id: string
  file_url: string | null
  generata_il: string | null
  generata_da: string | null
  /** Sessione 10: valorizzata quando una riapertura ha ritirato la pagella. Assente nel DB della CI. */
  ritirata_il?: string | null
  /** Sessione 10: le copie in `ritirate/` delle versioni consegnate, dalla più vecchia. */
  file_ritirati?: string[] | null
}
```

Nel commento delle righe 124-139, prima della chiusura ` */`, aggiungi:

```ts
 *
 * Le versioni RITIRATE (sessione 10). Una riapertura copia la pagella consegnata in
 * `ritirate/<scrutinio>/…` e ne tiene il percorso in `file_ritirati`, che è l'unico indice di
 * quelle copie. Se la pagella in vigore ha versioni ritirate alle spalle, la riga NON si
 * cancella: si ritira (`ritirata_il`) e torna a nominare l'ultima versione consegnata. Una riga
 * già ritirata non è «la pagella» di questa richiesta: si tratta come assente.
```

Le righe 173-255 diventano:

```ts
    // Prima con le colonne del ritiro; senza (DB della CI, 42703) come prima, e lo si dice.
    const conRitiro = await supabase
      .from('pagelle')
      .select('id, file_url, generata_il, generata_da, ritirata_il, file_ritirati')
      .eq('scrutinio_id', scrutinioId)
      .eq('alunno_id', alunnoId)
      .maybeSingle()
    const ripiegoSchema = !!conRitiro.error && colonnaNuovaAssente(conRitiro.error)
    if (ripiegoSchema) {
      logEvento('db', 'info', { operazione: OP_DELETE, esito: 'colonna-ritiro-assente', scrutinio_id: scrutinioId })
    }
    const lettura = ripiegoSchema
      ? await supabase
          .from('pagelle')
          .select('id, file_url, generata_il, generata_da')
          .eq('scrutinio_id', scrutinioId)
          .eq('alunno_id', alunnoId)
          .maybeSingle()
      : conRitiro
    if (lettura.error) return eliminazioneNonRiuscita('pagella-non-letta', lettura.error)
    const letta = (lettura.data ?? null) as PagellaArchiviata | null
    // Una riga già ritirata non è in vigore: per questa richiesta è come se non ci fosse.
    const riga = letta && !letta.ritirata_il ? letta : null
    const storico = riga && Array.isArray(riga.file_ritirati) ? riga.file_ritirati : []
    const ultima = storico.length > 0 ? storico[storico.length - 1] : null

    // Percorsi: quello canonico di `persistPagella` più quello scritto nella
    // riga, ma SOLO se è un file di questo alunno nella cartella di questo
    // scrutinio — un `file_url` che puntasse altrove (o al PDF di un compagno)
    // non si cancella da qui. Le copie in `ritirate/` sono fuori dalla cartella.
    const cartella = `${scrutinioId}/`
    const percorsi = new Set<string>([`${cartella}${alunnoId}.pdf`])
    const fileDellaRiga = riga?.file_url ?? null
    if (
      fileDellaRiga &&
      fileDellaRiga.startsWith(`${cartella}${alunnoId}`) &&
      !fileDellaRiga.slice(cartella.length).includes('/')
    ) {
      percorsi.add(fileDellaRiga)
    }

    const { data: rimossi, error: errRimozione } = await supabase.storage
      .from(PAGELLE_BUCKET)
      .remove([...percorsi])
    if (errRimozione) return eliminazioneNonRiuscita('file-pagella-non-eliminato', errRimozione, 'storage')
    const fileEliminati = ((rimossi ?? []) as unknown[]).length

    let rigaEliminata = false
    let rigaConservata = false
    const adesso = new Date().toISOString()
    if (riga && ultima) {
      // Versioni ritirate alle spalle: la riga resta, ritirata, e torna a nominare l'ultima
      // versione consegnata. Il PDF in vigore è già fuori dall'archivio (sopra).
      const { data: ritirate, error: errRitira } = await supabase
        .from('pagelle')
        .update({ ritirata_il: adesso, file_url: ultima })
        .eq('id', riga.id)
        .eq('scrutinio_id', scrutinioId)
        .eq('alunno_id', alunnoId)
        .is('ritirata_il', null)
        .select('id')
      if (errRitira) return eliminazioneNonRiuscita('riga-pagella-non-ritirata', errRitira)
      rigaConservata = ((ritirate ?? []) as unknown[]).length > 0
    } else if (riga) {
      const { data: cancellate, error: errCancella } = await supabase
        .from('pagelle')
        .delete()
        .eq('id', riga.id)
        .eq('scrutinio_id', scrutinioId)
        .eq('alunno_id', alunnoId)
        .select('id')
      if (errCancella) return eliminazioneNonRiuscita('riga-pagella-non-eliminata', errCancella)
      rigaEliminata = ((cancellate ?? []) as unknown[]).length > 0
    }

    // Niente riga e niente file: non c'era nessuna pagella da eliminare.
    if (!rigaEliminata && !rigaConservata && fileEliminati === 0) {
      return NextResponse.json(
        { error: 'Pagella inesistente', codice: 'PAGELLA_ELIMINAZIONE_NON_TROVATA' },
        { status: 404 },
      )
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'pagella',
      entitaId: riga?.id ?? null,
      azione: rigaConservata ? 'update' : 'delete',
      scuolaId,
      sectionId: scrutinio.section_id,
      valorePrima: {
        scrutinio_id: scrutinioId,
        alunno_id: alunnoId,
        file_url: riga?.file_url ?? null,
        generata_il: riga?.generata_il ?? null,
        generata_da: riga?.generata_da ?? null,
      },
      valoreDopo: rigaConservata ? { ritirata_il: adesso, file_url: ultima } : null,
    })

    // Il SUCCESSO si logga: si toglie un documento già consegnabile alla
    // famiglia. Solo uuid, numeri e booleani.
    logEvento('registro', 'info', {
      operazione: OP_DELETE,
      esito: rigaConservata ? 'pagella-eliminata-storico-conservato' : 'pagella-eliminata',
      scrutinio_id: scrutinioId,
      alunno_id: alunnoId,
      section_id: scrutinio.section_id,
      scuola_id: scuolaId,
      attore_id: auth.user.id,
      riga_eliminata: rigaEliminata,
      file_eliminati: fileEliminati,
      ...(rigaConservata ? { riga_conservata: true } : {}),
    }, undefined, { distingui: ['scrutinio_id', 'alunno_id'] })

    return NextResponse.json({
      success: true,
      rigaEliminata,
      fileEliminati,
      ...(rigaConservata ? { rigaConservata: true } : {}),
    })
```

`rigaConservata` e `riga_conservata` compaiono solo quando sono veri: la risposta e il log del percorso di sempre restano identici (i test delle righe 238, 298 e 315 li confrontano con `toEqual`).

- [ ] **Passo 5: l'oblio toglie anche le copie, prima della riga**

In `src/lib/gdpr/esegui.ts` le righe 784-803 diventano:

```ts
/**
 * Le PAGELLE del minore: il PDF esce dal bucket e la riga che lo indicizza
 * sparisce. Dentro ci sono i giudizi per disciplina, il comportamento e il
 * giudizio globale — una descrizione del bambino, non un atto contabile.
 *
 * PRIMA LE VERSIONI RITIRATE (sessione 10 della seconda serie di robustezza). Una
 * riapertura dello scrutinio non cancella più la pagella consegnata: la copia in
 * `ritirate/<scrutinio>/…` e ne tiene il percorso in `file_ritirati`. Quelle copie sono
 * giudizi sul bambino come la pagella in vigore, e l'unica colonna che le nomina sta nella
 * riga che `obliaFileDaTabella` sta per cancellare: si tolgono prima, e se una resta nel
 * bucket le righe restano anche loro (l'oblio si ripete e la ritrova). Se non si riesce a
 * leggerle, l'oblio si ferma qui: `letto: false`, come per ogni inventario non letto.
 */
export async function obliaPagelleAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<EsitoTabellaOblio> {
  if (!alunnoId) return { rimossi: 0, nonRimossi: 0, righe: 0, letto: true }

  let rimosseRitirate = 0
  const { data, error } = await supabase.from('pagelle').select('id, file_ritirati').eq('alunno_id', alunnoId)
  if (error && !schemaAssente(error)) {
    logErrore({ operazione: op, evento: 'oblio_pagelle_ritirate_select' }, error)
    return { rimossi: 0, nonRimossi: 0, righe: 0, letto: false }
  }
  if (!error) {
    const copie = ((data ?? []) as unknown as { file_ritirati?: unknown }[]).flatMap((r) =>
      Array.isArray(r.file_ritirati) ? r.file_ritirati.filter((p): p is string => typeof p === 'string') : [],
    )
    if (copie.length > 0) {
      const percorsi = copie.map((p) => percorsoDelBucket(BUCKET_PAGELLE, p))
      const illeggibili = percorsi.filter((p) => p === null).length
      const esito = await rimuoviFileOblio(supabase, BUCKET_PAGELLE, percorsi, op)
      const trattenute = esito.nonRimossi + illeggibili
      if (trattenute > 0) {
        // Mai i percorsi: portano l'uuid del bambino. Solo il conteggio.
        logEvento('gdpr', 'error', {
          operazione: op,
          esito: 'pagelle-ritirate-trattenute',
          bucket: BUCKET_PAGELLE,
          n_file: trattenute,
          msg: `${op}: ${trattenute} pagelle ritirate restano nell'archivio: le righe di \`pagelle\` NON sono state cancellate`,
        })
        return { rimossi: esito.rimossi, nonRimossi: trattenute, righe: 0, letto: true }
      }
      rimosseRitirate = esito.rimossi
    }
  }

  const resto = await obliaFileDaTabella(supabase, {
    tabella: 'pagelle',
    colonnePercorso: ['file_url'],
    colonnaFiltro: 'alunno_id',
    valoreFiltro: alunnoId,
    bucket: BUCKET_PAGELLE,
    evento: 'oblio_pagelle',
    op,
  })
  return { ...resto, rimossi: resto.rimossi + rimosseRitirate }
}
```

Nel DB della CI la colonna non c'è: `schemaAssente` (righe 10 e 677) riconosce `42703` e l'oblio fa come prima. `rimuoviFileOblio` (riga 1260) è una dichiarazione di funzione: si usa prima della sua riga senza problemi.

- [ ] **Passo 6: gli storici esportano tutte le versioni**

In `src/lib/storici/adattatori/scolastici-primaria.ts` le righe 191-192 diventano:

```ts
    // Sessione 10: una pagella ritirata da una riapertura punta alla sua copia in `ritirate/`, e
    // `file_ritirati` porta tutte le versioni consegnate. Lo storico le esporta tutte, col nome
    // che le distingue dalla pagella in vigore.
    const ritirata = Boolean(r.ritirata_il)
    const base = `Pagella ${nome(ctx, id)} ${testo(p?.nome)}`
    const originale = allegato('pagelle', r.file_url, `${base}${ritirata ? ' (ritirata)' : ''}.pdf`, id, 'application/pdf')
    aggiungiAllegato(s, originale)
    const versioni = Array.isArray(r.file_ritirati) ? (r.file_ritirati as unknown[]) : []
    versioni.forEach((v, i) => {
      if (testo(v) === testo(r.file_url)) return
      aggiungiAllegato(s, allegato('pagelle', v, `${base} (ritirata ${i + 1}).pdf`, id, 'application/pdf'))
    })
```

`perIds` legge `*` (`scolastici-comune.ts:78`): le due colonne arrivano da sole dove esistono, e nel DB della CI sono `undefined` (nessuna versione, nessun suffisso).

- [ ] **Passo 7: verdi**

```bash
npx vitest run __tests__/api/primaria-pagella-elimina.test.ts __tests__/lib/gdpr-oblio-storage-verificato.test.ts __tests__/lib/storici-scolastici.test.ts 2>&1 | tail -8
npx vitest run __tests__/lib/gdpr- __tests__/lib/storici- 2>&1 | tail -6
npx vitest run __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/architecture/errori-con-codice.test.ts 2>&1 | tail -6
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `3 passed`; tutti i file `gdpr-*` e `storici-*` verdi (in particolare `gdpr-oblio-completo.test.ts`, il cui finto risponde `PGRST205` a ogni lettura di `pagelle` alla riga 818: `schemaAssente` lo tace come prima); `2 passed`; `tsc` senza errori.

- [ ] **Passo 8: commit**

```bash
git add src/app/api/primaria/pagella/route.ts src/lib/gdpr/esegui.ts src/lib/storici/adattatori/scolastici-primaria.ts __tests__/api/primaria-pagella-elimina.test.ts __tests__/lib/gdpr-oblio-storage-verificato.test.ts __tests__/lib/storici-scolastici.test.ts
git commit -m "$(cat <<'EOF'
Pagelle ritirate: eliminazione, oblio e storici le vedono

La DELETE di una pagella con versioni ritirate ritira la riga invece di
cancellarla (è l'unico indice delle copie); l'oblio toglie le copie in
ritirate/ prima della riga e si ferma se una resta; gli storici esportano
ogni versione col suo nome.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 13 — L'interfaccia dice «ritirate», non «cancellate»

**File:**
- Modifica: `src/components/features/primaria/AzioniScrutinio.tsx:134`
- Modifica: `messages/it/teacherPrimaria.json:369, 371, 374`
- Modifica: `messages/en/teacherPrimaria.json:369, 371, 374`
- Test: `__tests__/components/AzioniScrutinio.test.tsx:11, 171, 186, 188, 191, 194, 203, 206, 215, 230, 365, 430, 432`, un caso nuovo

La modale della riapertura promette oggi «Le pagelle PDF già generate vengono cancellate» e il bottone dice «Riapri e cancella le pagelle». Dopo il Compito 11 non è più vero, e il conteggio del messaggio di successo legge `pagelleEliminate`, che nel percorso nuovo è 0.

- [ ] **Passo 1: i test cambiano testo, e un caso nuovo**

```bash
F=__tests__/components/AzioniScrutinio.test.tsx
perl -pi -e 's/Le pagelle PDF già generate vengono cancellate/Le pagelle PDF già consegnate vengono ritirate e conservate in archivio/; s/Riapri e cancella le pagelle/Riapri e ritira le pagelle/g; s/(\d) pagelle PDF cancellate ✓/$1 pagelle PDF ritirate ✓/g; s/pagelle PDF cancellate, firme/pagelle PDF ritirate, firme/; s/numero di pagelle cancellate/numero di pagelle ritirate/; s/senza pagelle da cancellare/senza pagelle da ritirare/' "$F"
grep -n "cancell" "$F"
```

Atteso dal `grep`: resta solo la riga 261 («Si cancella il PDF archiviato della pagella di …»), che è la modale di **Elimina pagella** e non cambia.

Poi, a mano, le risposte finte prendono la forma nuova. Riga 188:

```ts
      risposta(200, { success: true, pagelleRitirate: 3, pagelleEliminate: 0, fileConservati: 3, fileEliminati: 3, avvisiRitirati: 1 }),
```

riga 204:

```ts
    fetchMock.mockImplementation(() => risposta(200, { success: true, pagelleRitirate: 0, pagelleEliminate: 0 }))
```

riga 365:

```ts
        return risposta(200, { success: true, pagelleRitirate: 2, pagelleEliminate: 0, fileConservati: 2, fileEliminati: 2, avvisiRitirati: 0 })
```

e dopo il test «senza pagelle da ritirare» (riga 208):

```ts
  it('DB senza le colonne del ritiro (CI): le pagelle cancellate col percorso di prima si contano lo stesso', async () => {
    fetchMock.mockImplementation(() => risposta(200, { success: true, pagelleRitirate: 0, pagelleEliminate: 2 }))
    const { onRiaperto, dialogo } = monta(false, 'coordinator')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Riapri e ritira le pagelle' }))
    await waitFor(() => expect(onRiaperto).toHaveBeenCalledWith('Scrutinio riaperto, 2 pagelle PDF ritirate ✓'))
  })
```

- [ ] **Passo 2: rossi**

```bash
npx vitest run __tests__/components/AzioniScrutinio.test.tsx 2>&1 | tail -10
```

Atteso: rossi i test che cercano i testi nuovi (il bottone non si trova) e quelli col conteggio da `pagelleRitirate`.

- [ ] **Passo 3: il componente e i cataloghi**

`src/components/features/primaria/AzioniScrutinio.tsx`, riga 134:

```tsx
      onRiaperto(t('scrutinioRiaperto', { count: numeroDa(corpo, 'pagelleRitirate') + numeroDa(corpo, 'pagelleEliminate') }));
```

`messages/it/teacherPrimaria.json`, righe 369, 371 e 374:

```json
  "scrutinioRiapriConseguenzaPdf": "Le pagelle PDF già consegnate vengono ritirate e conservate in archivio: andranno generate di nuovo dopo la prossima chiusura.",
```

```json
  "scrutinioRiapriConferma": "Riapri e ritira le pagelle",
```

```json
  "scrutinioRiaperto": "{count, plural, =0 {Scrutinio riaperto ✓} one {Scrutinio riaperto, # pagella PDF ritirata ✓} other {Scrutinio riaperto, # pagelle PDF ritirate ✓}}",
```

`messages/en/teacherPrimaria.json`, righe 369, 371 e 374:

```json
  "scrutinioRiapriConseguenzaPdf": "The report card PDFs already delivered are withdrawn and kept on file: they will need to be generated again after the next closing.",
```

```json
  "scrutinioRiapriConferma": "Reopen and withdraw the report cards",
```

```json
  "scrutinioRiaperto": "{count, plural, =0 {Term assessment reopened ✓} one {Term assessment reopened, # report card PDF withdrawn ✓} other {Term assessment reopened, # report card PDFs withdrawn ✓}}",
```

Le chiavi non cambiano: nessun catalogo si riordina.

- [ ] **Passo 4: verdi**

```bash
npx vitest run __tests__/components/AzioniScrutinio.test.tsx 2>&1 | tail -6
npx vitest run __tests__/architecture 2>&1 | grep -iE "messag|catalog|i18n|Test Files" | tail -6
```

Atteso: `1 passed`; i lock dei cataloghi verdi.

- [ ] **Passo 5: commit**

```bash
git add src/components/features/primaria/AzioniScrutinio.tsx messages/it/teacherPrimaria.json messages/en/teacherPrimaria.json __tests__/components/AzioniScrutinio.test.tsx
git commit -m "$(cat <<'EOF'
Riapertura dello scrutinio: l'interfaccia dice «ritirate», e le conta

La modale e il bottone non promettono più una cancellazione che non avviene;
il messaggio di successo somma pagelle ritirate ed eliminate (queste ultime
solo nel ripiego senza colonne).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 14 — La PATCH delle note: una chiamata sola, e la presa visione si toglie solo se cambia il testo

**File:**
- Modifica: `src/app/api/primaria/note/route.ts` — prima di 564 (il commento `// PATCH /api/primaria/note`) l'insieme locale `NOTE_MODIFICA_ASSENTE` e una funzione nuova, `:564-568` (commento), `:610-645` (i due rami), `:682-690` (log). Gli import non cambiano: `logErrore` e `logEvento` ci sono già (riga 27), `SupabaseClient` anche (riga 7)
- Test: `__tests__/api/primaria-note-modifica-elimina.test.ts:52-70, 169, 191-199, 224-236, 327-328, 577-586`, un `describe` in fondo

Oggi (`note/route.ts:636-640`) le prese visione si cancellano con una richiesta e la nota si aggiorna con un'altra: se la seconda fallisce, le famiglie hanno perso la firma e la nota è quella di prima. E si cancellano per qualunque campo cambiato (`valori` alla riga 623 azzera sempre `firmata_il`). Il ramo della rettifica storica (righe 624-634) è già una transazione (`storici_applica_rettifica`): lì cambia solo *quali* note perdono la presa visione.

- [ ] **Passo 1: il test prende la funzione finta, e le attese nuove**

In `__tests__/api/primaria-note-modifica-elimina.test.ts`:

Le righe 52-57 diventano:

```ts
const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as Scrittura[],
  errori: undefined as Record<string, { code: string; message?: string }> | undefined,
  /** Le RPC del finto client: `note_modifica` per difetto (sessione 10), vedi `beforeEach`. */
  rpc: {} as Record<string, (args: Riga) => { data: unknown; error: unknown }>,
  rpcChiamate: [] as Array<{ nome: string; args: Riga }>,
}))
```

Le righe 63-68 diventano (e subito dopo, il logger con la spia che lascia passare):

```ts
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, [], {
        scritture: h.scritture,
        errori: h.errori,
        rpc: Object.fromEntries(
          Object.entries(h.rpc).map(([nome, f]) => [
            nome,
            (args: Riga) => {
              h.rpcChiamate.push({ nome, args })
              return f(args)
            },
          ]),
        ),
      }),
  }
})
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: vi.fn(vero.logEvento) }
})
```

Dopo la riga 70 (`import { GET, POST, PATCH, DELETE } …`):

```ts
import { logEvento } from '@/lib/logging/logger'
```

Dopo la riga 169 (fine di `dbBase`):

```ts
/**
 * `note_modifica` come la scrive la migrazione della sessione 10: tutto o niente, la presa
 * visione tolta solo alle note di `p_ids_azzera`, i parametri NULL lasciano il campo com'è.
 * La funzione SQL vera la prova `__tests__/lib/note-modifica-sql.test.ts` su PGlite.
 */
function noteModificaFinta(args: Riga): { data: unknown; error: unknown } {
  const ids = new Set(args.p_ids as string[])
  const azzera = new Set((args.p_ids_azzera as string[] | null) ?? [])
  const bersagli = (h.db.note_disciplinari as Riga[]).filter(
    (n) => ids.has(String(n.id)) && n.section_id === args.p_section_id,
  )
  const togliere = new Set(bersagli.filter((n) => azzera.has(String(n.id))).map((n) => n.id))
  const prima = (h.db.nota_ricezioni as Riga[]).length
  h.db.nota_ricezioni = (h.db.nota_ricezioni as Riga[]).filter((r) => !togliere.has(r.nota_id))
  const campi: Array<[string, string]> = [
    ['categoria', 'p_categoria'],
    ['testo', 'p_testo'],
    ['richiede_firma', 'p_richiede_firma'],
    ['data_evento', 'p_data_evento'],
    ['nota_gruppo_id', 'p_nuovo_gruppo'],
  ]
  for (const n of bersagli) {
    for (const [colonna, parametro] of campi) if (args[parametro] != null) n[colonna] = args[parametro]
    if (togliere.has(n.id)) {
      n.firmata_il = null
      n.firmata_da = null
    }
  }
  return {
    data: {
      ricezioni_cancellate: prima - (h.db.nota_ricezioni as Riga[]).length,
      note: bersagli.map((n) => ({ ...n })),
    },
    error: null,
  }
}
```

Nel `beforeEach` (righe 191-199), dopo `h.errori = undefined`:

```ts
  h.rpc = { note_modifica: noteModificaFinta }
  h.rpcChiamate = []
```

Il test «tutti» (righe 224-236) diventa:

```ts
  it('«tutti» modifica OGNI nota del gruppo e nessun\'altra; il testo non cambia, quindi le prese visione restano', async () => {
    const res = await patch({ id: NOTA_2, categoria: 'didattica', richiedeFirma: false, ambito: 'gruppo' })
    expect(res.status).toBe(200)
    expect((await res.json()).modificate).toBe(4)

    for (const id of [NOTA_1, NOTA_2, NOTA_3, NOTA_4]) {
      expect(notaDb(id)).toMatchObject({ categoria: 'didattica', richiede_firma: false })
    }
    // Sessione 10: la presa visione riguarda il TESTO letto dal genitore, che qui non cambia.
    expect(notaDb(NOTA_1)?.firmata_il).toBe('2026-09-09T12:00:00Z')
    expect(notaDb(NOTA_ALTRO_GRUPPO)?.categoria).toBe('disciplinare')
    expect(notaDb(NOTA_ALTRO_GRUPPO)?.firmata_il).toBe('2026-09-09T12:00:00Z')
    expect(ricezioni()).toEqual([NOTA_1, NOTA_ALTRO_GRUPPO])
    expect(audit()[0]).toMatchObject({ entita_id: GRUPPO, azione: 'update' })
  })
```

Le righe 327-328 diventano (il `describe` prova ora il ripiego senza la funzione, che è il percorso di prima):

```ts
describe('PATCH — senza la funzione (DB della CI): prima le firme, poi la nota', () => {
  beforeEach(() => {
    h.rpc = {
      note_modifica: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.note_modifica' } }),
    }
  })

  it('se la cancellazione delle prese visione fallisce: 500, e nota + firma restano intatte e coerenti', async () => {
```

Il test delle righe 577-586 diventa (lo spostamento di data non tocca più la firma):

```ts
  it('lo staff sposta la nota nel passato conservando originale e firme, senza perdere avvisi di altre note', async () => {
    come('dirigente')
    const res = await patch({ id: NOTA_1, data: '2020-04-02', ambito: 'alunno' })
    expect(res.status).toBe(200)
    expect(notaDb(NOTA_1)?.data_evento).toBe('2020-04-02')
    expect(notaDb(NOTA_1)?.nota_gruppo_id).not.toBe(GRUPPO)
    expect(h.db.storici_revisioni).toEqual(expect.arrayContaining([expect.objectContaining({ entita_id: NOTA_1, contenuto: { tabella: 'note_disciplinari', riga: expect.objectContaining({ nota_gruppo_id: GRUPPO, testo: 'Testo originale' }) } })]))
    // Sessione 10: cambia la data, non il testo: la presa visione del genitore resta.
    expect(notaDb(NOTA_1)).toMatchObject({ firmata_il: '2026-09-09T12:00:00Z', firmata_da: GENITORE_1 })
    expect(ricezioni()).toContain(NOTA_1)
    expect(notificheIds()).toContain('5') // altro gruppo, stesso genitore
    expect(notificheIds()).toContain('2') // nota di un altro bambino rimasta nel giorno originale
  })
```

In fondo al file:

```ts
describe('PATCH — una sola transazione, e la firma si toglie solo se cambia il testo (sessione 10)', () => {
  const scrittureNote = () =>
    h.scritture.filter((s) => s.tabella === 'nota_ricezioni' || s.tabella === 'note_disciplinari')

  it('testo cambiato: UNA chiamata a note_modifica, nessuna scrittura separata su note o prese visione', async () => {
    const res = await patch({ id: NOTA_1, testo: 'Testo corretto', ambito: 'alunno' })
    expect(res.status).toBe(200)
    expect(h.rpcChiamate).toHaveLength(1)
    expect(h.rpcChiamate[0]).toMatchObject({
      nome: 'note_modifica',
      args: {
        p_ids: [NOTA_1],
        p_section_id: SEZ,
        p_ids_azzera: [NOTA_1],
        p_testo: 'Testo corretto',
        p_categoria: null,
        p_nuovo_gruppo: null,
      },
    })
    expect(scrittureNote()).toEqual([])
  })

  it('la funzione fallisce (57014) → 500, e nota e presa visione restano come prima', async () => {
    h.rpc = { note_modifica: () => ({ data: null, error: { code: '57014', message: 'canceling statement' } }) }
    const res = await patch({ id: NOTA_1, testo: 'Testo corretto', ambito: 'alunno' })
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('NOTA_OPERAZIONE_NON_RIUSCITA')
    expect(notaDb(NOTA_1)).toMatchObject({ testo: 'Testo originale', firmata_il: '2026-09-09T12:00:00Z' })
    expect(ricezioni()).toContain(NOTA_1)
    expect(audit()).toHaveLength(0)
  })

  it('cambia solo la categoria di una nota firmata: la presa visione del genitore RESTA', async () => {
    const res = await patch({ id: NOTA_1, categoria: 'didattica', ambito: 'alunno' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ modificate: 1, firme_azzerate: 0 })
    expect(notaDb(NOTA_1)).toMatchObject({ categoria: 'didattica', firmata_il: '2026-09-09T12:00:00Z', firmata_da: GENITORE_1 })
    expect(ricezioni()).toContain(NOTA_1)
    expect(h.rpcChiamate[0].args.p_ids_azzera).toEqual([])
  })

  it.each(['PGRST202', '42883'])('funzione assente (DB della CI, %s): le due richieste di prima, e lo dice a livello info', async (code) => {
    h.rpc = {
      note_modifica: () => ({ data: null, error: { code, message: 'Could not find the function public.note_modifica' } }),
    }
    const res = await patch({ id: NOTA_1, testo: 'Testo corretto', ambito: 'alunno' })
    expect(res.status).toBe(200)
    expect(notaDb(NOTA_1)).toMatchObject({ testo: 'Testo corretto', firmata_il: null })
    expect(ricezioni()).not.toContain(NOTA_1)
    expect(scrittureNote().map((s) => `${s.tabella}:${s.operazione}`)).toEqual([
      'nota_ricezioni:delete',
      'note_disciplinari:update',
    ])
    expect(vi.mocked(logEvento)).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'rpc-note-modifica-assente' }),
      expect.objectContaining({ code }),
    )
  })
})
```

- [ ] **Passo 2: rossi**

```bash
npx vitest run __tests__/api/primaria-note-modifica-elimina.test.ts 2>&1 | tail -12
```

Atteso: rossi «tutti» (la firma di NOTA_1 si azzera), lo spostamento di data (presa visione tolta), i cinque casi del `describe` nuovo (tre test più i due codici del ripiego: nessuna chiamata a `note_modifica`, le scritture separate ci sono). I due test del ripiego (righe 328 e 349) restano verdi: sono il comportamento di oggi.

- [ ] **Passo 3: la route**

Gli import non cambiano. Prima del commento `// PATCH /api/primaria/note` (riga 564 al 20/10), l'insieme locale e la funzione del ripiego:

```ts
/**
 * `note_modifica` NON C'È ANCORA in questo database — i soli due codici con cui succede:
 * `PGRST202` (PostgREST non la trova nella schema cache: è il DB E2E della CI, che non è
 * migrato) e `42883` (Postgres: «undefined function»). Solo su QUESTA chiamata si ripiega sulle
 * due richieste di prima, e lo si dice a livello `info` (specifica della seconda serie, §5;
 * modello: `RPC_ASSENTE` in `src/app/api/avvisi/[id]/risposte/route.ts`). Un insieme locale e non
 * un modulo comune, di proposito. Ogni altro codice (`57014`, `42P01`, `42703`…) è un guasto vero
 * e risponde 500: ripiegare lì rifarebbe a pezzi ciò che la funzione ha rifiutato di fare insieme.
 */
const NOTE_MODIFICA_ASSENTE = new Set(['PGRST202', '42883'])

/**
 * Il ripiego della PATCH quando `note_modifica` non c'è ancora (DB della CI: `PGRST202`). Due
 * richieste come prima della sessione 10, nell'ordine che lascia ripetibile un guasto a metà:
 * prima le prese visione delle note a cui cambia il testo, poi le note. Con l'update riuscito e
 * la cancellazione fallita la firma resterebbe attaccata al testo nuovo, e il nuovo tentativo
 * troverebbe la nota «invariata»; così invece la ritrova «cambiata» e completa.
 */
async function modificaSenzaRpc(
  supabase: SupabaseClient,
  ids: string[],
  idsAzzera: string[],
  sectionId: string,
  valoriBase: Record<string, unknown>,
  valoriAzzera: Record<string, unknown>,
): Promise<{ ricezioni: number; dopo: unknown[] } | { error: unknown }> {
  let ricezioni = 0
  if (idsAzzera.length > 0) {
    const r = await supabase.from('nota_ricezioni').delete().in('nota_id', idsAzzera).select('id')
    if (r.error) return { error: r.error }
    ricezioni = ((r.data ?? []) as unknown[]).length
  }
  const dopo: unknown[] = []
  const restano = ids.filter((i) => !idsAzzera.includes(i))
  const lotti: Array<[string[], Record<string, unknown>]> = [
    [idsAzzera, valoriAzzera],
    [restano, valoriBase],
  ]
  for (const [lotto, valori] of lotti) {
    if (lotto.length === 0) continue
    const n = await supabase
      .from('note_disciplinari')
      .update(valori)
      .in('id', lotto)
      .eq('section_id', sectionId)
      .select(COLONNE_NOTA)
    if (n.error) return { error: n.error }
    dopo.push(...((n.data ?? []) as unknown[]))
  }
  return { ricezioni, dopo }
}
```

Le righe 564-568 diventano:

```ts
// PATCH /api/primaria/note
// body: { id, categoria?, testo?, richiedeFirma?, ambito: 'alunno'|'gruppo' }
// Nota già FIRMATA dal genitore e poi modificata NEL TESTO → la firma si AZZERA
// (`firmata_il`/`firmata_da` a null, `nota_ricezioni` cancellate): il genitore la rifirma
// sul testo nuovo. Data, categoria e «firma richiesta» non la toccano (sessione 10). Nota e
// prese visione cambiano nella STESSA transazione (`note_modifica`). Nessun avviso al genitore.
```

Le righe 610-645 diventano:

```ts
    const ids = cambiate.map((n) => n.id)
    // La presa visione del genitore riguarda il TESTO che ha letto (sessione 10): si toglie solo
    // alle note a cui il testo cambia. Data, categoria e «firma richiesta» non la toccano.
    const azzerate = patch.testo === undefined ? [] : cambiate.filter((n) => !stessoValore(n, 'testo'))
    const idsAzzera = azzerate.map((n) => n.id)
    const firmate = azzerate.filter((n) => n.firmata_il != null).length
    const nuovoGruppo = cambiaData && t.nota.nota_gruppo_id ? crypto.randomUUID() : null
    const valoriBase: Record<string, unknown> = { ...patch, ...(nuovoGruppo ? { nota_gruppo_id: nuovoGruppo } : {}) }
    const valoriAzzera: Record<string, unknown> = { ...valoriBase, firmata_il: null, firmata_da: null }

    let ricezioniCancellate = 0
    let dopo: unknown[] | null = null
    let error: unknown = null
    if (politicaModifica.sopprimiGenitori) {
      if (t.bersagli.some(n => n.storico_versione === undefined) || !t.scuolaId) return storicoIndisponibile()
      const azioni: AzioneStorica[] = []
      for (const n of cambiate) {
        const azzera = idsAzzera.includes(n.id)
        // La rettifica storica è già UNA transazione (`storici_applica_rettifica`): le prese
        // visione si tolgono lì dentro, e solo alle note a cui cambia il testo.
        if (azzera) azioni.push({ tabella: 'nota_ricezioni', operazione: 'delete', filtro: { nota_id: n.id } })
        azioni.push({ tabella: 'note_disciplinari', operazione: 'update', filtro: { id: n.id, section_id: t.sectionId }, valori: azzera ? valoriAzzera : valoriBase })
      }
      const rettifica = await applicaRettificaStorica(supabase, { attore: auth.user, scuolaId: t.scuolaId, sectionId: t.sectionId, modulo: 'note', giorno: giorniOriginali[0], attese: t.bersagli.map(n => ({ tabella: 'note_disciplinari', filtro: { id: n.id, section_id: t.sectionId }, versione: b.data.versioniAttese?.[n.id] ?? (n.id === id ? b.data.versioneAttesa : undefined) })), azioni })
      if ('response' in rettifica) return rettifica.response
      ricezioniCancellate = rettifica.righe.filter((_, i) => azioni[i]?.tabella === 'nota_ricezioni').flat().length
      dopo = rettifica.righe.filter((_, i) => azioni[i]?.tabella === 'note_disciplinari').flat()
    } else {
      // UNA chiamata: prese visione e nota insieme, o niente (sessione 10).
      const r = await supabase.rpc('note_modifica', {
        p_ids: ids,
        p_section_id: t.sectionId,
        p_ids_azzera: idsAzzera,
        p_categoria: patch.categoria ?? null,
        p_testo: patch.testo ?? null,
        p_richiede_firma: patch.richiede_firma ?? null,
        p_data_evento: patch.data_evento ?? null,
        p_nuovo_gruppo: nuovoGruppo,
      })
      if (r.error && NOTE_MODIFICA_ASSENTE.has(r.error.code)) {
        // DB della CI: la funzione non c'è ancora. `info` (specifica §5): è previsto lì, e solo lì.
        logEvento('registro', 'info', { operazione, esito: 'rpc-note-modifica-assente' }, r.error)
        const senza = await modificaSenzaRpc(supabase, ids, idsAzzera, t.sectionId, valoriBase, valoriAzzera)
        if ('error' in senza) {
          error = senza.error
        } else {
          ricezioniCancellate = senza.ricezioni
          dopo = senza.dopo
        }
      } else if (r.error) {
        error = r.error
      } else {
        const esito = (r.data ?? {}) as { ricezioni_cancellate?: number; note?: unknown[] }
        ricezioniCancellate = esito.ricezioni_cancellate ?? 0
        dopo = esito.note ?? []
      }
    }
    if (error) {
      logErrore({ operazione, stato: 500, evento: 'db' }, error)
      return operazioneNonRiuscita()
    }
```

Nelle righe 682-690 (log del successo) la riga di `ricezioni_cancellate` diventa:

```ts
      ricezioni_cancellate: ricezioniCancellate,
```

La risposta (righe 691-696) non cambia: `firme_azzerate` conta ora le sole note firmate a cui cambia il testo.

- [ ] **Passo 4: verdi, e i lock**

```bash
npx vitest run __tests__/api/primaria-note-modifica-elimina.test.ts 2>&1 | tail -8
grep -rln "api/primaria/note/route'" __tests__ | grep -v architecture
npx vitest run __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/architecture/errori-con-codice.test.ts __tests__/architecture/logging-coverage.test.ts 2>&1 | tail -6
npx tsc --noEmit 2>&1 | tail -5
```

Atteso: `1 passed`; il `grep` trova il solo `primaria-note-modifica-elimina.test.ts` (al 20/10 nessun altro test importa la PATCH; `primaria-parent-competenza.test.ts` importa la route **dei genitori**). Se ne compare un altro che passa da `creaFintoSupabase`, il finto lancia «rpc("note_modifica") non emulata»: aggiungi lì `rpc: { note_modifica: () => ({ data: null, error: { code: 'PGRST202' } }) }` alle opzioni, che lo riporta al percorso di prima. Poi `3 passed`; `tsc` senza errori.

- [ ] **Passo 5: prova per rottura (e ritorno)**

Nella chiamata `note_modifica` sostituisci `p_ids_azzera: idsAzzera` con `p_ids_azzera: ids` e rilancia il file: deve diventare rosso «cambia solo la categoria…» (la firma sparisce). Rimetti `idsAzzera`, rilancia, verde.

- [ ] **Passo 6: commit**

```bash
git add src/app/api/primaria/note/route.ts __tests__/api/primaria-note-modifica-elimina.test.ts
git commit -m "$(cat <<'EOF'
Note: modifica in una transazione, presa visione tolta solo se cambia il testo

La PATCH chiama note_modifica: prese visione e nota insieme o niente. Data,
categoria e firma richiesta non tolgono più la presa visione del genitore.
Senza la funzione (DB della CI) si fanno le due richieste di prima, e lo si
dice a livello info.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Compito 15 — Compensazioni di merchandise e sedi: un test ciascuna

**File:**
- Modifica: `src/app/api/admin/schools/route.ts:349-351` (il blocco `if (cleanupErr) { logErrore(… evento: 'db-fallback-cleanup' …) }`)
- Test: `__tests__/api/admin-guasti-db-non-diventano-valori.test.ts` (un caso subito dopo il test «ordine: il collegamento ordine→addebito fallisce → 500, e addebito, righe e ordine si disfano»)
- Test: `__tests__/api/admin-schools-provisioning.test.ts` (un caso subito dopo il test «degrade: insert scuole fallito → cleanup della riga schools + 500»)

Le due compensazioni ci sono già: `disfa` in `merch/ordini/route.ts:189-198` toglie addebito, righe e ordine e logga ogni passo non riuscito con l'id; il ripiego delle sedi (`schools/route.ts:336-353`) toglie la riga `schools` se `scuole` non si scrive. Nessun test prova il caso in cui **la compensazione stessa** fallisce, che è quello che lascia un orfano. Per le sedi il log di oggi (`evento: 'db-fallback-cleanup'`, riga 350) non porta l'id della riga orfana né un `esito` cercabile.

**Fuori da questo compito, di proposito:** le risposte del file che mandano al client `error.message` (al 20/10 righe 269, 304, 320, 334 e 352, fra cui la `return NextResponse.json({ error: scuoleErr.message }, …)` subito sotto il blocco che si cambia) restano **identiche**. La specifica (§7 «Sessione 13») le fa sistemare solo alle sessioni successive alla 13, con la funzione che la 13 introduce: qui non se ne aggiunge una e non se ne corregge una.

- [ ] **Passo 1: i due test**

In `__tests__/api/admin-guasti-db-non-diventano-valori.test.ts`, dentro il `describe('merch — una scrittura principale fallita è 500, e la creazione a metà si disfa', …)`, **subito dopo** la chiusura del test `it('ordine: il collegamento ordine→addebito fallisce → 500, e addebito, righe e ordine si disfano', …)` e **prima** di `it('ordine: la categoria dell’addebito non letta → 500 PRIMA di scrivere qualunque cosa', …)` (righe 186-188 al 20/10: la sessione 2 toglie un import più in alto nello stesso file, quindi si cerca il titolo, non il numero). I due aiutanti `preparaOrdine` e `corpoOrdine` sono dichiarati in quel `describe`, poco sopra:

```ts
  it('ordine: anche la compensazione fallisce → 500, e l’addebito rimasto è nel log col suo id', async () => {
    preparaOrdine()
    h.guasti['divise_ordini:update'] = GUASTO
    h.guasti['pagamenti:delete'] = GUASTO
    const res = await creaOrdine(json('http://localhost/api/admin/merch/ordini', 'POST', corpoOrdine))
    expect(res.status).toBe(500)
    // Un passo che non riesce non ferma gli altri: righe e ordine si tolgono lo stesso.
    expect(h.scritture.filter((s) => s.op === 'delete').map((s) => s.table)).toEqual(['pagamenti', 'divise_ordini_righe', 'divise_ordini'])
    expect(h.logEvento).toHaveBeenCalledWith(
      'db',
      'error',
      expect.objectContaining({ operazione: 'admin/merch/ordini:POST', esito: 'addebito-orfano-non-rimosso', entita_id: 'pagamenti-nuovo' }),
      GUASTO,
    )
  })
```

In `__tests__/api/admin-schools-provisioning.test.ts`, dentro `describe('POST /api/admin/schools — provisioning', …)`, subito dopo la chiusura del test `it('degrade: insert scuole fallito → cleanup della riga schools + 500', …)` e prima di `it('403 senza Direzione', …)` (righe 203-205 al 20/10):

```ts
  it('degrade: insert scuole fallito E pulizia fallita → 500, e la sede orfana è nel log col suo id', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } })
    h.scuoleInsertError = { message: 'boom', code: '23505' }
    h.schoolsDeleteError = { message: 'canceling statement', code: '57014' }
    const res = await POST(reqBody({ nome: 'Sede Rotta' }, 'POST'))
    expect(res.status).toBe(500)
    const orfana = h.inserts[0]?.row.id
    expect(h.deletes).toEqual([{ table: 'schools', id: orfana }])
    expect(h.logEvento).toHaveBeenCalledWith(
      'db',
      'error',
      expect.objectContaining({ operazione: 'admin/schools:POST', esito: 'sede-orfana-non-rimossa', entita_id: orfana }),
      expect.objectContaining({ code: '57014' }),
    )
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'db-fallback-scuole-cleanup-ko' }),
      expect.objectContaining({ code: '23505' }),
    )
  })
```

- [ ] **Passo 2: rosso (solo le sedi)**

```bash
npx vitest run __tests__/api/admin-guasti-db-non-diventano-valori.test.ts __tests__/api/admin-schools-provisioning.test.ts 2>&1 | tail -10
```

Atteso: il caso del merchandise è **verde** subito (la compensazione è già scritta così: il test la tiene ferma); quello delle sedi è rosso (`logEvento` mai chiamato con `sede-orfana-non-rimossa`).

- [ ] **Passo 3: la route delle sedi**

In `src/app/api/admin/schools/route.ts` il blocco delle righe 349-351, cioè

```ts
        if (cleanupErr) {
          logErrore({ operazione: 'admin/schools:POST', stato: 500, evento: 'db-fallback-cleanup' }, cleanupErr)
        }
```

diventa (la riga dopo, `return NextResponse.json({ error: scuoleErr.message }, { status: 500 })`, non si tocca):

```ts
        if (cleanupErr) {
          // La riga `schools` è rimasta senza la sua `scuole`: una sede orfana da bonificare. L'id
          // va nel log, con un `esito` cercabile (sessione 10 della seconda serie).
          logEvento('db', 'error', { operazione: 'admin/schools:POST', esito: 'sede-orfana-non-rimossa', entita_id: newId }, cleanupErr)
        }
```

`logEvento` è già importato (riga 17).

- [ ] **Passo 4: verdi**

```bash
npx vitest run __tests__/api/admin-guasti-db-non-diventano-valori.test.ts __tests__/api/admin-schools-provisioning.test.ts 2>&1 | tail -6
```

Atteso: `2 passed`.

- [ ] **Passo 5: commit**

```bash
git add src/app/api/admin/schools/route.ts __tests__/api/admin-guasti-db-non-diventano-valori.test.ts __tests__/api/admin-schools-provisioning.test.ts
git commit -m "$(cat <<'EOF'
Compensazioni di merchandise e sedi: provate quando falliscono anche loro

Un test per ciascuna: l'addebito orfano del merchandise finisce nel log col
suo id; la sede orfana del ripiego senza RPC ora ha un esito cercabile
(sede-orfana-non-rimossa) e il suo id.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Log

### Compito 16 — Il conto dei log: ogni esito nuovo c'è, ogni esito tolto è sparito

**File:** nessuno da modificare (verifica). Se un controllo fallisce, si corregge nel compito che ha scritto quel codice e si rifà il suo commit.

Esiti **nuovi** (tutti con `operazione` ed `esito`; mai un percorso di file, mai un testo: solo uuid, conteggi, booleani, `bucket`, `tipo`):

| Esito | Evento · livello | Dove | Quando |
|---|---|---|---|
| `rpc-eliminazione-assente-ripiego` | `gdpr` · info | `cancella-fascicolo.ts` (Compito 8) | `personale_elimina_dipendente` assente (CI) |
| `righe-fascicolo-non-cancellate` | `gdpr` · error | `cancella-fascicolo.ts` | la funzione di ripiego fallisce |
| `righe-dipendente-non-cancellate` | `gdpr` · error | `cancella-fascicolo.ts` | la funzione nuova fallisce con un codice vero |
| `account-accesso-non-rimosso` | `gdpr` · error | rotta di eliminazione | `auth.admin.deleteUser` fallisce dopo le righe |
| `cestino-non-raggiunto` | `storage` · warn | `cestino-file.ts` (Compito 4) | `move` fallita, il file si toglie con `remove` |
| `file-orfani-fuori-cestino` | `storage` · error | `cestino-file.ts` | falliscono sia `move` sia `remove` |
| `file-nel-cestino` | `storage` · info | `cestino-file.ts` | successo dello spostamento (anche a zero) |
| `cestino-non-letto` | `storage` · error | `cestino-file.ts` | elenco del cestino non leggibile |
| `cestino-file-svuotato` | `gdpr` · info/error | `cestino-file.ts` | svuotamento del giro notturno |
| `cestino-personale-<esito>` | `cron` · info (battito) | `retention-cestino-registro` (Compito 9) | esito del battito quando il cestino del personale non si svuota |
| `copie-non-riuscite` | `storage` · error | `copia-verificata.ts` (Compito 3) | una o più copie fallite |
| `copie-sorgente-assente` | `storage` · info | `copia-verificata.ts` | sorgente già sparita (404) |
| `colonna-ritiro-assente` | `db` · info | `pagelle-ritirate.ts`, `pagella-store.ts`, `riapri`, `pagella` (Compiti 10-12) | colonne del ritiro assenti (CI) |
| `pagelle-non-ritirate` | `storage` · error | `riapri` (Compito 11) | copia in `ritirate/` fallita |
| `pagelle-non-marcate` | `db` · error | `riapri` | marcatura di una riga fallita |
| `copie-ritirate-orfane` | `storage` · error | `riapri` | non si tolgono le copie di una riapertura interrotta |
| `riga-pagella-non-ritirata` | `db` · error | `pagella` DELETE (Compito 12) | ritiro della riga fallito |
| `pagella-eliminata-storico-conservato` | `registro` · info | `pagella` DELETE | successo con versioni ritirate |
| `oblio_pagelle_ritirate_select` (evento di `logErrore`) | error | `esegui.ts` (Compito 12) | elenco delle versioni ritirate non letto |
| `pagelle-ritirate-trattenute` | `gdpr` · error | `esegui.ts` | una copia ritirata resta nel bucket |
| `rpc-note-modifica-assente` | `registro` · info | `note` PATCH (Compito 14) | `note_modifica` assente (CI) |
| `sede-orfana-non-rimossa` | `db` · error | `schools` POST (Compito 15) | pulizia della riga `schools` fallita |

Esiti **tolti**: `scansioni-non-rimosse` e `file-rimossi-righe-no` (il vecchio `cancella-fascicolo.ts`, dove l'ordine nuovo li rende impossibili) e l'evento `db-fallback-cleanup` di `logErrore` (sostituito da `sede-orfana-non-rimossa`). I campi nuovi dei log di successo esistenti: `pagelle_ritirate`, `file_conservati`, `ripiego_schema` in `scrutinio-riaperto`; `n_file_nel_cestino`, `n_file_orfani`, `account_accesso_rimosso` in `staff-cancellato`; `n_cestino_personale_giorni`, `n_cestino_personale_file`, `n_cestino_personale_bloccanti`, `cestino_personale_ok` nel battito del giro notturno; `riga_conservata` in `pagella-eliminata-storico-conservato`.

- [ ] **Passo 1: ogni esito nuovo è scritto nel codice**

```bash
for e in rpc-eliminazione-assente-ripiego righe-fascicolo-non-cancellate righe-dipendente-non-cancellate account-accesso-non-rimosso cestino-non-raggiunto file-orfani-fuori-cestino file-nel-cestino cestino-non-letto cestino-file-svuotato copie-non-riuscite copie-sorgente-assente colonna-ritiro-assente pagelle-non-ritirate pagelle-non-marcate copie-ritirate-orfane riga-pagella-non-ritirata pagella-eliminata-storico-conservato oblio_pagelle_ritirate_select pagelle-ritirate-trattenute rpc-note-modifica-assente sede-orfana-non-rimossa; do
  printf '%-40s %s\n' "$e" "$(grep -rn -- "$e" src | wc -l | tr -d ' ')"
done
grep -rn -- "cestino-personale-" src | head -3
```

Atteso: nessuna riga con `0`; `cestino-personale-` compare nella route del giro notturno.

- [ ] **Passo 2: ogni esito tolto è sparito, e nessun log nuovo porta un percorso**

```bash
grep -rn "scansioni-non-rimosse\|file-rimossi-righe-no\|db-fallback-cleanup" src
grep -n "percorso\|file_url\|da:\|a:" src/lib/storage/copia-verificata.ts src/lib/storage/cestino-file.ts | grep -n "logEvento\|logErrore" 
```

Atteso: il primo `grep` non stampa niente; il secondo non stampa niente (i percorsi stanno nelle strutture di ritorno, mai nei campi di un log).

- [ ] **Passo 3: i lock del logging**

```bash
npx vitest run __tests__/architecture/logging-coverage.test.ts __tests__/architecture/errori-postgrest-guardati.test.ts __tests__/architecture/errori-con-codice.test.ts 2>&1 | tail -6
npx eslint src/lib/storage src/lib/personale src/lib/primaria src/lib/gdpr/esegui.ts src/app/api/primaria src/app/api/admin/staff src/app/api/admin/schools src/app/api/gdpr/retention-cestino-registro --max-warnings 0 2>&1 | tail -5
```

Atteso: `3 passed`; `eslint` senza righe (regola `no-console` compresa).

---

## PRD

### Compito 17 — La voce del changelog, con i numeri misurati

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md` (in cima, prima della riga 1)

- [ ] **Passo 1: la voce, con i segnaposti delle misure**

Leggi le prime 12 righe del PRD (`Read` con `limit: 12`) e inserisci **prima** della riga 1:

```markdown
## 🛡️ Changelog — Robustezza, seconda serie, sessione 10: operazioni a più passi senza perdite — {DATA} (branch `robustezza2/s10-operazioni-a-piu-passi`)

**Stato:** 🔀 in revisione. Tre migrazioni, che applica l'integrazione al merge: `<V1>_personale_elimina_dipendente.sql`, `<V2>_pagelle_ritirate.sql`, `<V3>_note_modifica.sql`. Domande d'iscrizione contate il {ISCRIZIONI_ALLE} UTC: **{ISCRIZIONI}**. Piano: `docs/superpowers/plans/2026-10-20-robustezza2-s10-operazioni-a-piu-passi.md`.

- **Quanto girano i tre percorsi (misura prima).** Dall'audit delle scritture, dal {AUDIT_DAL}: {AUDIT_STAFF_DELETE} eliminazioni del personale, {AUDIT_RIAPERTURE} riaperture di scrutinio (di cui {AUDIT_RIAPERTURE_CON_PAGELLE} con pagelle cancellate), {AUDIT_NOTE_UPDATE} modifiche di note. Da `app_log` (30 giorni, dal {LOG_DAL}): `staff-cancellato` {LOG_STAFF_CANCELLATO}, `scrutinio-riaperto` {LOG_SCRUTINIO_RIAPERTO}, `nota-modificata` {LOG_NOTA_MODIFICATA}. In archivio: {PAGELLE} pagelle in {SCRUTINI_CON_PAGELLE} scrutini; {NOTE_FIRMATE} note con presa visione su {NOTE}.
- **Personale.** L'eliminazione va in quest'ordine: lettura dei file, poteri tolti, righe (pratica, fascicolo, profilo) in **una** transazione (`personale_elimina_dipendente`), account di accesso, e solo alla fine le scansioni, che non si cancellano più: vanno in `cestino/<giorno>/` dello stesso bucket. Il giro notturno `cestino-registro-retention` le distrugge passato lo stesso termine del cestino del registro, e il suo battito lo dice (`cestino_personale_ok`). Se una chiave senza cascata trattiene il profilo, la funzione risponde `23503` e il dipendente si archivia senza aver toccato un file.
- **Scrutinio.** La riapertura non cancella più le pagelle consegnate: le **copia** in `ritirate/<scrutinio>/<alunno>-<istante>.pdf`, marca la riga (`pagelle.ritirata_il`, `pagelle.file_ritirati`) e solo dopo toglie i PDF dalla cartella dello scrutinio. Un guasto a metà lascia lo scrutinio chiuso e ripetibile. La pagella rigenerata torna in vigore sulla stessa riga; «Elimina pagella», l'oblio e gli storici vedono le versioni ritirate. L'interfaccia dice «ritirate e conservate in archivio».
- **Note.** La modifica passa da `note_modifica`: nota e prese visione cambiano insieme o niente. La presa visione del genitore si toglie **solo** se cambia il testo; data, categoria e «firma richiesta» non la toccano più.
- **Merchandise e sedi.** Un test ciascuno sulla compensazione che fallisce; la sede orfana del ripiego senza RPC ha ora un esito cercabile (`sede-orfana-non-rimossa`) col suo id.
- **Nel DB della CI** (non migrato) ogni percorso ripiega sul comportamento di prima e lo dice a livello `info` (`colonna-ritiro-assente`, `rpc-eliminazione-assente-ripiego`, `rpc-note-modifica-assente`). In produzione questi esiti non devono comparire mai.
```

Se `AUDIT_RIAPERTURE_CON_PAGELLE` è maggiore di 0, aggiungi in fondo alla voce:

```markdown
- **⚠️ Pagelle già perse.** {AUDIT_RIAPERTURE_CON_PAGELLE} riaperture degli ultimi 90 giorni hanno cancellato pagelle consegnate prima di questa sessione. La sessione non le recupera: i file tornano solo dallo specchio esterno, se ancora nei suoi 30 giorni.
```

- [ ] **Passo 2: i segnaposti diventano i numeri, e i nomi dei file quelli veri**

```bash
M="${TMPDIR:-/tmp}/s10-misure.env"
grep -q "^DATA=" "$M" || echo "DATA=$(date -u +%F)" >> "$M"
while IFS='=' read -r k v; do
  [ -n "$k" ] && perl -pi -e "s{\\{$k\\}}{$v}g" "PRD REGISTRO ELETTRONICO.md"
done < "$M"
for f in personale_elimina_dipendente pagelle_ritirate note_modifica; do
  v=$(basename supabase/migrations/*_"$f".sql .sql)
  perl -pi -e "s{<V\\d>_${f}\\.sql}{${v}.sql}g" "PRD REGISTRO ELETTRONICO.md"
done
head -20 "PRD REGISTRO ELETTRONICO.md" | grep -nE "\{[A-Z_0-9]+\}|<V[0-9]>"
```

Atteso dall'ultimo `grep`: niente. Una graffa rimasta è una misura non fatta: si torna al Passo 0, non si scrive una stima.

- [ ] **Passo 3: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(cat <<'EOF'
PRD: changelog della sessione 10 (operazioni a più passi senza perdite)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Rilascio

### Compito 18 — Gate, PR, merge a mano, conferma, misura «dopo», pulizia

**File:**
- Modifica: `docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md` (la riga della sessione 10 nella tabella di stato, trovata con `grep -n "^| 10 |"`)
- Modifica, se il conteggio cambia: `PRD REGISTRO ELETTRONICO.md` (riga delle domande d'iscrizione)

- [ ] **Passo 1: il gate intero**

```bash
cd /Users/lerri/kidville-web-s10-operazioni
npx eslint . --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
CI=1 npx vitest run 2>&1 | tail -8
NODE_OPTIONS=--max-old-space-size=8192 npm run build 2>&1 | tail -8
```

Atteso: `eslint` e `tsc` senza righe; `vitest` con `Test Files … passed` e nessun `failed`; build `✓ Compiled successfully`. `CI=1` perché in un worktree nuovo il lock `offline-html-nativo` è rosso finché non c'è `cap sync` (specifica §5). **Mai** `npm run e2e` in locale: l'E2E gira in CI.

- [ ] **Passo 2: il conteggio subito prima della migrazione**

```sql
SELECT count(*) FROM enrollment_submissions;
```

Se il numero o l'ora sono cambiati rispetto alla voce del PRD, aggiorna quella riga (numero e `date -u '+%Y-%m-%d %H:%M'`) e:

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(cat <<'EOF'
PRD: conteggio delle domande d'iscrizione prima del merge (sessione 10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Passo 3: mostrare le migrazioni, poi la PR**

Mostrare non è chiedere: le tre migrazioni vanno lette per intero nel corpo della PR, prima che l'integrazione le applichi.

```bash
B="${TMPDIR:-/tmp}/s10-pr.md"
{
cat <<'EOF'
## Sessione 10 — Operazioni a più passi senza perdite

Piano: `docs/superpowers/plans/2026-10-20-robustezza2-s10-operazioni-a-piu-passi.md` · specifica §7 «Sessione 10».

- **Personale:** poteri → righe in una transazione (`personale_elimina_dipendente`) → account → scansioni nel cestino del bucket, svuotato dal giro `cestino-registro-retention`.
- **Scrutinio:** la riapertura copia le pagelle in `ritirate/<scrutinio>/`, marca la riga (`ritirata_il`, `file_ritirati`) e solo dopo toglie i PDF.
- **Note:** `note_modifica` aggiorna nota e prese visione insieme; la presa visione si toglie solo se cambia il testo.
- **Merchandise e sedi:** un test ciascuno sulla compensazione che fallisce.
- **CI non migrata:** ogni percorso ripiega sul comportamento di prima e lo dice a livello `info`.

**Merge a mano del titolare** (regola della serie): niente auto-merge. L'integrazione applica le tre migrazioni al merge.

## Le tre migrazioni
EOF
for f in supabase/migrations/*_personale_elimina_dipendente.sql supabase/migrations/*_pagelle_ritirate.sql supabase/migrations/*_note_modifica.sql; do
  printf '\n### `%s`\n\n```sql\n' "$(basename "$f")"
  cat "$f"
  printf '```\n'
done
printf '\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
} > "$B"
tail -1 "$B"
git push -u origin robustezza2/s10-operazioni-a-piu-passi
gh pr create --base main --head robustezza2/s10-operazioni-a-piu-passi \
  --title "Robustezza, sessione 10: operazioni a più passi senza perdite" \
  --body-file "$B"
```

Atteso: `tail -1` stampa la riga «🤖 Generated with …»; `gh` stampa l'indirizzo della PR. Annota il numero: `N`.

- [ ] **Passo 4: la tabella di stato dice «in revisione»**

```bash
grep -n "^| 10 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
```

Atteso: una riga sola. In quella riga (mai una riga presa per numero), colonne «Stato», «PR» e «Piano»: `da fare` → `in revisione` (queste parole, non «PR aperta» né «in corso»), `—` → `#N`, `` `s10-operazioni-a-piu-passi` `` → `` `docs/superpowers/plans/2026-10-20-robustezza2-s10-operazioni-a-piu-passi.md` ``. **Mai** «in produzione» su questa riga in questa PR: lo scrive la sessione che apre dopo, eseguendo la sezione «Per la sessione dopo» di questo piano (specifica §5, «La tabella di stato, in due tempi»). Poi:

```bash
git add docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git commit -m "$(cat <<'EOF'
Specifica della seconda serie: sessione 10 in revisione

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git push
```

- [ ] **Passo 5: CI verde su tutti i job**

```bash
gh pr checks N --watch --fail-fast=false 2>&1 | tail -20
```

Atteso: ogni job `pass`, compresi `DB migrate (CI)` e l'E2E. Un job `cancelled` non è rosso: nel gruppo di concorrenza `e2e-ci-db` una PR pubblicata dopo annulla quella in coda; si rilancia (`gh run rerun <id> --failed`), una PR alla volta. Un job `skipped` va capito, non contato come verde.

- [ ] **Passo 6: il merge lo fa il titolare**

Fermati e scrivi al titolare: numero della PR, CI verde, le tre migrazioni nel corpo. **Mai** `gh pr merge` né auto-merge da qui: è una regola della serie (specifica §5), che vale anche dove `CLAUDE.md` concede l'autonomia piena.

- [ ] **Passo 7: dopo il merge, la conferma che le migrazioni ci sono**

```bash
gh api "repos/{owner}/{repo}/commits/$(git ls-remote origin refs/heads/main | cut -f1)/status" --jq '.statuses[] | [.context, .state] | @tsv'
```

Atteso: lo stato di Vercel sul commit di `main` è `success` (il deploy di produzione è pronto). Poi, in sola lettura sulla produzione:

```sql
SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE name IN ('personale_elimina_dipendente', 'pagelle_ritirate', 'note_modifica')
 ORDER BY version;

SELECT to_regprocedure('public.personale_elimina_dipendente(uuid, uuid)') IS NOT NULL AS elimina_presente,
       to_regprocedure('public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid)') IS NOT NULL AS note_presente,
       has_function_privilege('anon', 'public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid)', 'EXECUTE') AS anon_note,
       has_function_privilege('authenticated', 'public.personale_elimina_dipendente(uuid, uuid)', 'EXECUTE') AS authenticated_elimina,
       has_function_privilege('service_role', 'public.personale_elimina_dipendente(uuid, uuid)', 'EXECUTE') AS service_elimina;

SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'pagelle' AND column_name IN ('ritirata_il', 'file_ritirati')
 ORDER BY 1;

SELECT count(*) FILTER (WHERE ritirata_il IS NOT NULL) AS ritirate,
       count(*) FILTER (WHERE cardinality(file_ritirati) > 0) AS con_storico
  FROM public.pagelle;
```

Atteso: tre righe con le version dei file; `true, true, false, false, true`; `file_ritirati` (`ARRAY`, `NO`, `'{}'::text[]`) e `ritirata_il` (`timestamp with time zone`, `YES`); `0, 0`. Una riga che manca → **non** si applica a mano (riapplicarla farebbe due righe in `schema_migrations`): si guarda il log dell'integrazione e si chiede al titolare.

- [ ] **Passo 8: la misura «dopo» — dove sta e quando matura**

La misura «dopo» la esegue e la scrive la **sessione che apre dopo**, nella sua chiusura della precedente: le `SELECT` qui sotto sono ripetute, identiche, nella sezione «Per la sessione dopo» in fondo a questo piano, con il giorno da cui maturano (24 ore dopo il deploy di produzione). Se questa sessione è ancora aperta a 24 ore dal deploy, può eseguirle per controllo, in sola lettura, e riferire i numeri al titolare; non le scrive né nella specifica né nel PRD (la riga di stato è «in revisione» fino alla sessione dopo).

```sql
SELECT contesto->'campi'->>'esito' AS esito, sum(occorrenze) AS n
  FROM app_log
 WHERE giorno >= DATE '<giorno del merge>'
   AND contesto->'campi'->>'esito' IN ('colonna-ritiro-assente', 'rpc-eliminazione-assente-ripiego', 'rpc-note-modifica-assente',
                              'copie-non-riuscite', 'pagelle-non-ritirate', 'pagelle-non-marcate', 'copie-ritirate-orfane',
                              'cestino-non-raggiunto', 'file-orfani-fuori-cestino', 'account-accesso-non-rimosso',
                              'righe-dipendente-non-cancellate', 'pagelle-ritirate-trattenute', 'sede-orfana-non-rimossa',
                              'scrutinio-riaperto', 'staff-cancellato', 'nota-modificata', 'file-nel-cestino')
 GROUP BY 1 ORDER BY 1;

SELECT giorno, contesto->'campi'->>'esito' AS esito, contesto->'campi'->>'cestino_personale_ok' AS cestino_personale_ok,
       contesto->'campi'->>'n_cestino_personale_file' AS file_distrutti
  FROM app_log
 WHERE evento = 'cron' AND contesto->'campi'->>'operazione' = 'cestino-registro-retention' AND giorno >= DATE '<giorno del merge>'
 ORDER BY giorno DESC LIMIT 3;

SELECT bucket_id,
       count(*) FILTER (WHERE name LIKE 'ritirate/%') AS ritirate,
       count(*) FILTER (WHERE name LIKE 'cestino/%')  AS cestino
  FROM storage.objects
 WHERE bucket_id IN ('pagelle', 'documenti_personale')
 GROUP BY 1 ORDER BY 1;
```

Atteso: nessuna riga per i tre esiti di ripiego e per gli esiti `error`; il battito notturno `ok` con `cestino_personale_ok = true`; `ritirate` e `cestino` a 0 finché non c'è una riapertura o un'eliminazione vera. (I campi stanno sotto `contesto.campi`, e `colonna-ritiro-assente`, un `info` di `db`, non arriva mai in `app_log`: vedi la nota nella sezione «Per la sessione dopo», punto 3.) La prova della specifica («oggetti in `ritirate/` dopo la prima riapertura vera») matura più tardi, alla prima riapertura vera (gennaio 2027): anche questa sta nella sezione «Per la sessione dopo».

Tutto quello che la sessione dopo deve fare per chiudere questa (fotografia delle migrazioni, riga di stato a «in produzione» col commit di `main`, misura «dopo», Stato della voce nel PRD) è scritto nella sezione «Per la sessione dopo», in fondo a questo piano: niente rami di soli documenti e niente PR separate dopo il rilascio.

- [ ] **Passo 9: pulizia**

Dopo il rilascio riuscito, il ramo e il worktree di **questa** sessione:

```bash
git -C /Users/lerri/kidville-web worktree remove /Users/lerri/kidville-web-s10-operazioni
git -C /Users/lerri/kidville-web branch -D robustezza2/s10-operazioni-a-piu-passi
git -C /Users/lerri/kidville-web push origin --delete robustezza2/s10-operazioni-a-piu-passi
git -C /Users/lerri/kidville-web branch -a | head -20
```

I rami delle altre sessioni con una PR ancora aperta restano (specifica §5). Il file delle misure resta fuori dal repository.

---

## Ritorno indietro

**Codice.** Instant Rollback di Vercel subito, sul deploy di produzione prima del merge; poi una PR di revert, con lo stesso merge a mano. La PR della sessione entra in `main` con lo squash, quindi il commit da annullare ha un solo genitore: si revoca senza `-m`. Il ramo sta **fuori** dal prefisso `robustezza2/`: la chiusura della precedente cerca la PR `robustezza2/` mergiata per ultima e ne apre il piano, e un `robustezza2/s10-revert` la manderebbe a un piano che non esiste (specifica §5: nessun altro nome di ramo nella serie).

```bash
git -C /Users/lerri/kidville-web fetch origin
git -C /Users/lerri/kidville-web log origin/main --oneline --grep "(#<numero della PR della sessione 10>)" | head -1
git -C /Users/lerri/kidville-web worktree add -b revert/s10-operazioni-a-piu-passi /Users/lerri/kidville-web-s10-revert origin/main
cd /Users/lerri/kidville-web-s10-revert && git revert --no-edit <sha stampato sopra>
```

Con il codice di prima e lo schema nuovo:
- l'eliminazione del personale torna a `personale_cancella_fascicolo`, che c'è ancora; la funzione nuova resta inerte;
- la riapertura torna a cancellare file e righe, la PATCH delle note alle due richieste: le colonne nuove e `note_modifica` restano inerti;
- **due cose non tornano da sole**, e vanno contate prima di decidere:

```sql
SELECT bucket_id,
       count(*) FILTER (WHERE name LIKE 'ritirate/%') AS ritirate,
       count(*) FILTER (WHERE name LIKE 'cestino/%')  AS cestino
  FROM storage.objects
 WHERE bucket_id IN ('pagelle', 'documenti_personale')
 GROUP BY 1;
SELECT count(*) AS ritirate_rigenerate
  FROM public.pagelle
 WHERE ritirata_il IS NOT NULL AND file_url NOT LIKE 'ritirate/%';
```

  1. le scansioni già in `cestino/` del bucket del personale: il giro notturno di prima non le conosce e non le distrugge più. Restano fascicoli di persone che non lavorano più alla scuola: il titolare decide se toglierle a mano o rilasciare di nuovo la sessione;
  2. una pagella ritirata e poi rigenerata col codice di prima resta con `ritirata_il` valorizzata (l'upsert di prima non la azzera): il codice di prima non la legge, ma alla nuova uscita della sessione risulterebbe «non in vigore». Prima di rilasciare di nuovo, si mostra e poi si esegue `UPDATE public.pagelle SET ritirata_il = NULL WHERE ritirata_il IS NOT NULL AND file_url NOT LIKE 'ritirate/%';` (solo se il conteggio sopra non è 0).

**I file delle migrazioni restano.** Il revert toglie anche i tre file delle migrazioni, ma le loro righe restano nel registro della produzione: alla prima fotografia rigenerata il lock `migrazioni-complete` («ogni migrazione applicata in produzione ha il suo file nel repo») diventerebbe rosso. Nella PR di revert si riportano i tre file così come sono in `main`:

```bash
git checkout <sha stampato sopra> -- $(git show --name-only --format= <sha stampato sopra> | grep -E '^supabase/migrations/.*_(personale_elimina_dipendente|pagelle_ritirate|note_modifica)\.sql$')
git status --short supabase/migrations/
```

Atteso: tre righe `A ` (i tre file tornano). Le funzioni e le colonne restano inerti col codice di prima.

**Migrazioni.** La sezione «ROLLBACK» nell'intestazione di ciascuna delle tre (Compiti 5-7). Diventa una migrazione nuova **solo** dentro la PR di revert, con la version da `date -u +%Y%m%d%H%M%S` (posteriore a tutte), mai applicata a mano:

```sql
DROP FUNCTION IF EXISTS public.note_modifica(uuid[], uuid, uuid[], text, text, boolean, date, uuid);
DROP FUNCTION IF EXISTS public.personale_elimina_dipendente(uuid, uuid);
DO $$
BEGIN
  IF to_regprocedure('public.personale_cancella_fascicolo(uuid, uuid)') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON FUNCTION public.personale_cancella_fascicolo(uuid, uuid) IS
      'Cancella in UNA transazione il fascicolo del personale e la pratica pubblica da cui '
      'e'' nato. Ritorna i conteggi. NON tocca lo Storage: le scansioni le rimuove la route '
      'PRIMA di chiamarla, perche'' la DELETE della pratica cascata su `caricamenti_personale`, '
      'cioe'' sull''unica riga che nomina quei file.'$c$;
  END IF;
END $$;
```

Il commento è quello di `20260920001032_docente_archiviato_e_cancella_fascicolo.sql`. Le colonne `pagelle.ritirata_il` e `pagelle.file_ritirati` **restano** (specifica §7 «Sessione 10», «Indietro»: «le colonne nuove restano inerti»): `file_ritirati` è l'unico indice delle copie in `ritirate/`, e toglierla le renderebbe orfane, fuori dalla portata dell'oblio. Un `DROP COLUMN` è una decisione del titolare (decisione 8), e solo con `ritirate` a 0.

---

## Per la sessione dopo

Questa sezione la esegue **chi apre la prima sessione dopo il rilascio della 10**, quando il suo Compito 1 trova `robustezza2/s10-operazioni-a-piu-passi` come PR `robustezza2/` mergiata per ultima (con l'ordine 1→14 di solito apre la 11), nel **primo commit** della sua sessione, dal suo worktree. Chi la esegue non ha letto il resto di questo piano: qui c'è tutto. Sulla produzione si fanno **solo letture** (`execute_sql`, solo `SELECT`); si scrive solo nel repository.

**1. Fotografia delle migrazioni.** La sessione 10 ha tre migrazioni: `<version>_personale_elimina_dipendente.sql`, `<version>_pagelle_ritirate.sql`, `<version>_note_modifica.sql`.

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs --sql
```

Esegui la query che stampa (`select version, name from supabase_migrations.schema_migrations order by version`) con `execute_sql`, salva la risposta JSON in `${TMPDIR:-/tmp}/chiusura-s10-migrazioni.json`, poi:

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs < "${TMPDIR:-/tmp}/chiusura-s10-migrazioni.json"
npx vitest run __tests__/architecture/migrazioni-complete.test.ts 2>&1 | tail -6
grep -cE '"name": "(personale_elimina_dipendente|pagelle_ritirate|note_modifica)"' __tests__/fixtures/migrazioni-applicate-snapshot.json
```

Atteso: `Test Files  1 passed`; il `grep` stampa `3`. Se stampa meno di 3, una migrazione non è stata applicata dall'integrazione: **non** si applica a mano (farebbe due righe in `schema_migrations`), si scrive nelle «Note» della riga della sessione 10 e si avvisa il titolare.

**Nessun'altra fotografia.** Le tre migrazioni aggiungono due funzioni (`personale_elimina_dipendente`, `note_modifica`) e due colonne a `pagelle` (`ritirata_il`, `file_ritirati`, senza chiavi esterne): niente indici unici, chiavi esterne, policy, tabelle per sede, bucket o schema delle candidature. I prefissi `ritirate/` e `cestino/` stanno dentro bucket che esistono già.

**2. Liste «fino alla chiusura».** Nessuna: la sessione 10 non aggiunge voci a `MIGRAZIONI_ATTESE_AL_MERGE` (`__tests__/architecture/soglia-fotografia.ts`) né ad altre liste temporanee. Controllo:

```bash
grep -n "personale_elimina_dipendente\|pagelle_ritirate\|note_modifica" __tests__/architecture/soglia-fotografia.ts
```

Atteso: nessuna riga.

**3. La misura «dopo».** Matura **24 ore dopo il deploy di produzione** della sessione 10 (il giorno dopo il merge). Se a quel momento la sessione dopo è già aperta e ha già fatto il suo primo commit, la scrive la prima PR che tocca la specifica dopo quel giorno. Il giorno del merge:

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:robustezza2/s10-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
```

Poi, in sola lettura, con quel giorno al posto di `<giorno del merge>` (formato `AAAA-MM-GG`):

```sql
SELECT contesto->'campi'->>'esito' AS esito, sum(occorrenze) AS n
  FROM app_log
 WHERE giorno >= DATE '<giorno del merge>'
   AND contesto->'campi'->>'esito' IN ('colonna-ritiro-assente', 'rpc-eliminazione-assente-ripiego', 'rpc-note-modifica-assente',
                              'copie-non-riuscite', 'pagelle-non-ritirate', 'pagelle-non-marcate', 'copie-ritirate-orfane',
                              'cestino-non-raggiunto', 'file-orfani-fuori-cestino', 'account-accesso-non-rimosso',
                              'righe-dipendente-non-cancellate', 'pagelle-ritirate-trattenute', 'sede-orfana-non-rimossa',
                              'scrutinio-riaperto', 'staff-cancellato', 'nota-modificata', 'file-nel-cestino')
 GROUP BY 1 ORDER BY 1;

SELECT giorno, contesto->'campi'->>'esito' AS esito, contesto->'campi'->>'cestino_personale_ok' AS cestino_personale_ok,
       contesto->'campi'->>'n_cestino_personale_file' AS file_distrutti
  FROM app_log
 WHERE evento = 'cron' AND contesto->'campi'->>'operazione' = 'cestino-registro-retention' AND giorno >= DATE '<giorno del merge>'
 ORDER BY giorno DESC LIMIT 3;

SELECT bucket_id,
       count(*) FILTER (WHERE name LIKE 'ritirate/%') AS ritirate,
       count(*) FILTER (WHERE name LIKE 'cestino/%')  AS cestino
  FROM storage.objects
 WHERE bucket_id IN ('pagelle', 'documenti_personale')
 GROUP BY 1 ORDER BY 1;
```

**Dove stanno i campi (corretto il 25/10, Compito 16).** `logEvento` scrive i campi del chiamante sotto `contesto.campi` (`rigaEvento` in `src/lib/logging/logger.ts`): il percorso è `contesto->'campi'->>'esito'`, non `contesto->>'esito'`, che in produzione è sempre vuoto e farebbe passare la misura con zero righe qualunque cosa sia successo. Le `SELECT` qui sopra sono già corrette. **Un esito di ripiego che `app_log` non vede comunque:** `colonna-ritiro-assente` è `logEvento('db', 'info', …)`, e `db` non sta in `EVENTI_PERSISTITI`: un `info` di `db` non arriva mai in tabella, quindi la sua assenza non prova niente. Che le colonne del ritiro ci siano lo dice la fotografia del punto 1 (`pagelle_ritirate` fra le tre righe), non questa query.

Atteso: nessuna riga per i tre esiti di ripiego (`colonna-ritiro-assente`, `rpc-eliminazione-assente-ripiego`, `rpc-note-modifica-assente`; il primo, come detto, non comparirebbe in ogni caso) e per gli esiti `error`; il battito notturno con esito `ok` e `cestino_personale_ok = true`; `ritirate` e `cestino` a 0 finché non c'è una riapertura o un'eliminazione vera. Si scrivono i numeri osservati, con giorno e ora UTC (`date -u '+%Y-%m-%d %H:%M'`) e la finestra (dal giorno del merge a oggi). **Condizionali:** un esito di ripiego presente in produzione vuol dire una migrazione che manca → non si applica a mano: lo si scrive nelle «Note» e si avvisa il titolare. Nessun battito `ok`, o `cestino_personale_ok` falso → il cestino del personale non si svuota: lo si scrive nelle «Note» e si avvisa il titolare.

**4. La misura che matura più tardi: la prima riapertura vera.** La prova della specifica («oggetti in `ritirate/` dopo la prima riapertura vera») matura **dal giorno della prima riapertura di uno scrutinio dopo il merge** (attesa a gennaio 2027, con gli scrutini del primo quadrimestre). Il giorno si legge così:

```sql
SELECT min(ritirata_il) AS prima_riapertura, count(*) AS pagelle_ritirate
  FROM public.pagelle
 WHERE ritirata_il IS NOT NULL;
```

Finché `prima_riapertura` è vuoto, la misura non è matura e non si scrive niente. Quando non lo è più, la **prima PR che tocca la specifica dopo quel giorno** rifà la terza `SELECT` del punto 3 e scrive nelle «Note» della riga della sessione 10 il numero di oggetti in `ritirate/` (atteso: almeno 1 per ogni pagella ritirata), con giorno e ora UTC.

**5. La riga di stato.**

```bash
grep -n "^| 10 |" docs/superpowers/specs/2026-10-20-robustezza-seconda-serie-design.md
git log origin/main --oneline --grep "(#<numero della PR della sessione 10>)" | head -1
```

Prima, un controllo: la sessione 10 non deve essere tornata indietro.

```bash
gh pr list --repo erricoluigi17/kidville-web --state merged --search "head:revert/s10-" --json number,mergedAt --jq '.[] | "\(.number) \(.mergedAt)"'
```

Atteso: nessuna riga. Se ne stampa una, la PR di revert (ramo `revert/s10-operazioni-a-piu-passi`, sezione «Ritorno indietro») è in `main`: «Stato» resta `in revisione`, in coda alle «Note» si scrive «tornata indietro, PR #<numero del revert>», i punti sotto si saltano e si avvisa il titolare.

Nella riga trovata (mai per numero di riga): «Stato» `in revisione` → `in produzione`; in coda alle «Note», il commit di `main` (`` commit `<sha corto>` ``) e, se matura, la misura del punto 3 con giorno, ora UTC e finestra.

**6. Il PRD.** La voce `## 🛡️ Changelog — Robustezza, seconda serie, sessione 10: operazioni a più passi senza perdite` (si trova con `grep -n "seconda serie, sessione 10" "PRD REGISTRO ELETTRONICO.md"`): la riga `**Stato:** 🔀 in revisione.` diventa `**Stato:** ✅ in produzione (PR #<numero>, commit `<sha corto>`, merge del <giorno> UTC).`, e se la misura del punto 3 è matura si aggiunge in fondo alla voce un punto «**Misura dopo** (<giorno e ora UTC>, finestra …)» con i numeri osservati.

---

## Autorevisione

| Specifica (`2026-10-20-robustezza-seconda-serie-design.md`, righe alla rilettura della sera del 20/10) | Compito |
|---|---|
| §7 S10 «Obiettivo»: nessun passo irreversibile prima dei passi che possono fallire (riga 642) | 4, 8, 11, 14; prove per rottura nei Compiti 8, 11, 14 |
| «Scadenza»: in produzione entro metà dicembre (643-644) | 1 (Passo 7: la data del merge si mostra, e se slitta ci si ferma), 18; decisione 10, che non è una scelta |
| «Misura prima»: eliminazioni, riaperture, modifiche di note; i 90 giorni da `audit_scritture_docente` (645-647) | 2 (Passi 2-3: `app_log` copre 30 giorni, i 90 vengono dall'audit) |
| Personale: permessi, una RPC per pratica, anagrafica e `utenti`, account, file in un prefisso di cestino; `cestino-registro-retention` riceve un passo nuovo con lo stesso termine (649-653) | 4, 5, 8, 9 |
| Riapertura: pagelle in `ritirate/<scrutinio>/`, riga marcata, `ritirata_il` e `file_ritirati`, ripiego `42703`; eliminazione, oblio e storici adattati (654-659) | 6, 10, 11; lettori adattati nel 12, interfaccia nel 13 |
| Note: presa visione tolta solo se cambia il testo, dentro una RPC transazionale; la `DELETE` resta fuori (660-662) | 7, 14 |
| Compensazioni di merchandise e sedi: un test ciascuna (663) | 15 |
| «Decisioni del titolare»: dieci, mostrate alla fine del Compito 1, prima di qualunque codice (664-667) | 1 (Passo 7); «Decisioni che restano al titolare» |
| «Rischio»: la riapertura cambia a ridosso del primo quadrimestre (668) | 13, 18; decisione 10 |
| «Indietro»: revert, le colonne nuove restano inerti, conteggi e `UPDATE` da mostrare (669-671) | Ritorno indietro |
| «Prova»: secondo o terzo passo che fallisce → nessun file cancellato (672) | 8 (righe e account rifiutati, schema a metà), 11 (copia e marcatura fallite), 12 (ritiro della riga fallito) |
| «Prova»: oggetti in `ritirate/` dopo la prima riapertura vera (672-673) | «Per la sessione dopo», punto 4 (matura alla prima riapertura vera) |
| §7 S13: le risposte con `error.message` si sistemano solo dopo la 13 (756-760) | 15 (le cinque di `admin/schools` restano identiche, nessuna nuova) |
| §5 ramo `robustezza2/sNN-<nome>` da `main` in un worktree nuovo (137-140) | 1, Passo 2 |
| §5 merge a mano del titolare, mai auto-merge (141-142) | 18, Passo 6 |
| §5 pulizia di ramo e worktree (143-144) | 18, Passo 9 |
| §5 codice che regge il merge: `42703`, e `PGRST202`/`42883` solo sulla chiamata della RPC, con un insieme locale e una riga `info` (145-151) | 8 (`PERSONALE_ELIMINA_ASSENTE`), 14 (`NOTE_MODIFICA_ASSENTE`), 10, 11, 12 |
| §5 tabella di stato in due tempi: «in revisione» nella propria PR, «in produzione» dalla sessione dopo (152-159) | 18, Passi 4 e 8; «Per la sessione dopo», punto 5 |
| §5 prerequisiti: PR della sessione 3 mergiata, migrazioni applicate, nessuna PR `robustezza2/` aperta (160-164) | 1, Passo 1 |
| §5 chiusura della sessione rilasciata per ultima, dal suo «Per la sessione dopo» (165-173) | 1, Passi 4 e 6 |
| §5 riferimenti al codice per contenuto, righe di stato trovate con `grep` e mai per numero (174-177) | 1, 15 (titoli dei test), 18; «Per la sessione dopo» |
| §5 corpi delle funzioni dalla produzione (178-180) | 2, Passo 6 (la sessione non ridefinisce funzioni esistenti: solo un commento) |
| §5 ritorno indietro con la sezione «ROLLBACK» (181-184) | 5, 6, 7; Ritorno indietro |
| §5 log con `esito` e voce del PRD (185-187) | 16, 17 |
| §5 gate (188-190) | 18, Passo 1 |
| §5 mai `npm run e2e` in locale (191) | 18, Passo 1 |
| §5 conteggio delle iscrizioni prima di ogni migrazione (192-193) | 2 (Passo 1), 18 (Passo 2) |
| §5 mai una stima al posto di una misura (194-195) | 2, 17 (Passo 2: una graffa rimasta ferma tutto) |
| §5 repository pubblico, dati di minori (196-197) | tutti: nei test solo uuid finti, codici, nomi di file |
| §6 «Apertura e chiusura» e sezione «Per la sessione dopo» (237-243) | 1; «Per la sessione dopo» |
| §1 la riga della sessione 10 nella tabella di stato | 1 (Passo 7, «Note»), 18 (Passo 4, «in revisione») |

**Segnaposto e nomi.** Nessun modulo comune per le RPC nuove: i due insiemi locali hanno nomi diversi e stanno nei due file che chiamano la funzione. I nomi delle funzioni, delle colonne e degli esiti sono gli stessi nei Compiti 5-18 e nella sezione «Per la sessione dopo».

---

## Decisioni che restano al titolare

1. **Il termine del cestino del personale.** Il piano usa lo stesso termine del cestino del registro (`GIORNI_CESTINO_REGISTRO`, un numero solo per il lock `cestino-registro-giorni-un-numero-solo`). Se per i fascicoli del personale serve un termine diverso, è un secondo numero e un lock da cambiare.
2. **Le chiavi verso `auth.users` senza cascata** (`FK_AUTH_SENZA_CASCATA` del Passo 0). Se `deleteUser` fallisce dopo la transazione, resta un account di accesso senza profilo: nessun gate lo fa entrare, ma va tolto a mano. Si accetta così (con l'errore `account-accesso-non-rimosso`), o si vuole togliere quella chiave?
3. **La presa visione delle note.** Oggi qualunque modifica la toglie; dopo la sessione solo il testo (come chiede la specifica). Cambiare data, categoria o «firma richiesta» lascia valida la firma del genitore sul testo che ha letto. Da confermare, perché le famiglie vedranno meno richieste di rifirma.
4. **Una pagella ritirata è una riga.** Resta in `pagelle` con le sue chiavi verso alunno e scrutinio: se quelle chiavi sono `RESTRICT` (lo dice il Passo 7 del Compito 2), una pagella ritirata blocca l'eliminazione definitiva dell'alunno o dello scrutinio come una in vigore. È voluto (sono documenti consegnati) o le ritirate devono cedere?
5. **File orfani se falliscono sia lo spostamento nel cestino sia la rimozione.** Il piano li conta e grida (`file-orfani-fuori-cestino`), senza un giro che li ritrovi. Basta il log, o serve un controllo periodico sul bucket?
6. **L'informativa.** Non nomina né il cestino del personale (le scansioni restano per il termine del cestino dopo l'eliminazione) né le pagelle ritirate (restano fino all'oblio). Va aggiornato il testo pubblicato?
7. **Il messaggio del 503** dopo lo sgancio dei poteri dice «nessun dato cancellato», ed è vero per righe e file, ma i poteri sono già stati tolti. Si cambia il testo?
8. **Il `DROP` delle colonne** in un eventuale ritorno indietro: solo con `ritirate/` vuota, e solo per decisione esplicita.
9. **Quanto restano le pagelle ritirate.** Il piano non dà loro un termine: restano fino all'oblio dell'alunno, come la pagella in vigore. Se serve un termine di conservazione, è un giro di pulizia in più.
10. **La scadenza — si mostra, non si sceglie.** La specifica vuole la sessione 10 in produzione **entro metà dicembre** (§3 «Scadenze», §7 «Sessione 10»), perché a gennaio si riaprono gli scrutini del primo quadrimestre, e le decisioni non si riaprono dentro un piano (§2). Al titolare si mostra la data prevista del merge. Rinviare il rilascio a dopo gli scrutini **non** è un'opzione di questo piano: se la data non sta entro metà dicembre, la sessione **si ferma** e lo scrive nelle «Note» della riga della sessione 10 nella tabella di stato (`grep -n "^| 10 |"`), dove il titolare decide fuori da questo piano.
