# Runbook di ripristino — «cosa fare se…»

> Roadmap di robustezza, fase 2 (problemi D1 e D2). Questo file serve il giorno in cui qualcosa è
> andato storto, quando nessuno ha voglia di ragionare. Se una procedura non è stata ancora **provata**,
> sta scritto: una procedura mai provata è una speranza, non un rimedio.
>
> 🔴 **Qui non ci sono dati personali e non ce ne devono essere.** I dati veri sono quelli di bambini e
> famiglie. Nei log, nei messaggi e nei documenti si scrivono solo numeri, nomi di tabella e uuid.

## In parole semplici

- **Supabase** è il database dell'app: lì ci sono i dati veri, ed è lì che l'app legge e scrive. Non cambia.
- **Cloudflare R2** (in Europa) è una **cassaforte in un altro edificio**. Ogni notte ci arriva una copia
  **cifrata** del database e dei file. L'app non la legge mai.
- Le copie sono **bloccate**: per 30 giorni (un anno per quelle mensili) nessuno le può cancellare né
  sovrascrivere, nemmeno chi ha le chiavi. Poi scadono da sole.
- Per **aprire** una copia servono due chiavi che stanno **solo offline** dal titolare: la chiave `age` (per il
  database) e la password di `rclone crypt` (per i file). **Senza, le copie sono illeggibili per tutti**,
  Cloudflare e noi compresi.

## Cosa c'è, dove, per quanto

| Cosa | Dove | Quanto si tiene | Come si apre |
|---|---|---|---|
| Backup fisici giornalieri di Supabase (database, **non** i file) | pannello Supabase → Database → Backups | 7 giorni | pannello: «Restore» o «Restore to a new project» |
| Dump cifrato del database | R2 `kidville-backup/db/giornalieri/AAAA-MM-GGThhmmZ.dump.age` (+ `.manifest.jsonl.age`) | 30 giorni (lock) | chiave privata `age` |
| Copia mensile del database | R2 `db/mensili/AAAA-MM.dump.age` | 12 mesi (lock) | chiave privata `age` |
| Specchio dei file (14 GB) | R2 `storage/corrente/…` | sempre aggiornato | password e salt di `rclone crypt` |
| File spariti da Supabase | R2 `storage/cestino/AAAA-MM-GG/…` | 30 giorni (lock) | password e salt di `rclone crypt` |
| **Foto e video della galleria** (`gallery`, `video_originals`) | **NON sono in nessun backup** | — | scelta del titolare, 2026-10-06 |

> 🔴 **Foto e video della galleria non hanno copie.** Per scelta del titolare (2026-10-06) i bucket `gallery` e
> `video_originals` sono **fuori dal backup** per non pagare spazio. Se vengono cancellati o persi, **non si
> recuperano**: nemmeno dallo scenario C. Il resto dei file (iscrizioni, protocollo, 104/PEI, fatture, pagelle,
> personale, chat) è coperto.

**Cosa NON c'è nel dump** (e va rifatto a mano dopo un ripristino su un progetto nuovo):
- i **dati** di `public.app_log`, `cron.job_run_details` e dei token di sessione di `auth` (la struttura sì; gli utenti rifanno il login);
- i **segreti dei cron** (`app.cron_secret` e i cinque URL): stanno nel **Vault** di Supabase, che il dump non copia. Si rimettono con `vault.create_secret`, un nome alla volta (scenario E, passo 6). Il manifest **non** li elenca: legge `pg_db_role_setting`, dove da quando i segreti sono nel Vault non ce n'è nessuno (misurato il 24/10: 10 righe, una sola `app.*`, `app.settings.jwt_exp`, che è di piattaforma Supabase e non nostra);
- le **password dei ruoli** (anche `backup_lettura`);
- le **chiavi API** del nuovo progetto (vanno rimesse in Vercel) e le impostazioni di Auth.

## Cosa serve per ripristinare, e dove sta

| Serve | Dove sta | Se è perso |
|---|---|---|
| **Chiave privata age** | offline, 2 supporti (titolare). Copia di lavoro in `~/KIDVILLE-CHIAVI-BACKUP/`, **fuori** dalla cartella dell'app e da ogni checkout git (vedi sotto: lo spostamento lo fa il titolare) | i dump non si aprono più, per nessuno |
| **Password e salt di rclone crypt** | offline, 2 supporti (titolare); in GitHub solo per il backup; copia di lavoro in `~/KIDVILLE-CHIAVI-BACKUP/` | i file dello specchio non si aprono più |
| **Token R2 di lettura** (`backup-lettura`) | pannello Cloudflare → R2 → Manage API tokens (si ricrea) | si ricrea; non serve la chiave per cambiarlo |
| Accesso al pannello Supabase, Vercel, GitHub | titolare | — |
| Strumenti sul computer | `age`, `rclone`, `jq`, Postgres 17 (`pg_restore`, `psql`, `initdb`) | `brew install age rclone jq postgresql@17` |

> ⚠️ **La chiave privata `age` e la password di cifratura non vanno MAI in GitHub, in chat, in un
> documento o in un file del repository.** Per una prova si mette la chiave in un file temporaneo e lo
> si cancella subito dopo.

### Dove sta la copia di lavoro delle chiavi

Dalla sessione 4 della seconda serie di robustezza il posto della copia di lavoro (chiave privata `age`, password e
salt di `rclone crypt`) è `~/KIDVILLE-CHIAVI-BACKUP/`, nella cartella personale del titolare, fuori da ogni checkout
git. Dentro l'app la proteggeva solo `.gitignore`: un `git clean -x` l'avrebbe cancellata, e ogni worktree nuovo ne
era una copia possibile. La regola di `.gitignore` e il suo lock restano, come rete. Le copie **offline** restano due,
su due supporti. Questo documento non contiene e non conterrà mai le chiavi.

🔴 **Lo spostamento è un'azione del titolare, a mano.** Nessuna sessione di Claude apre, copia o sposta quella
cartella. Finché la prima casella qui sotto non è spuntata, la copia di lavoro sta **ancora** dentro l'app.

Procedura (Terminale del Mac, dalla cartella dell'app, cioè il checkout principale):
1. `ls -d ~/KIDVILLE-CHIAVI-BACKUP` → deve rispondere «No such file or directory» (non si sovrascrive niente).
2. `mv KIDVILLE-CHIAVI-BACKUP ~/KIDVILLE-CHIAVI-BACKUP` (sullo stesso disco è un cambio di nome: non resta una copia
   dietro). **Non** dentro Scrivania, Documenti o iCloud Drive, che si sincronizzano online.
3. `chmod 700 ~/KIDVILLE-CHIAVI-BACKUP` (la legge solo il titolare).
4. Controllo, senza aprire i file: `ls KIDVILLE-CHIAVI-BACKUP` nella cartella dell'app → «No such file or directory»;
   `ls ~/KIDVILLE-CHIAVI-BACKUP` → i due file ci sono.
5. `git worktree list`, e in ogni worktree elencato `ls KIDVILLE-CHIAVI-BACKUP` → «No such file or directory».
6. Spunta la casella qui sotto con la data.

- [ ] Cartella spostata fuori dall'app dal titolare, il gg/mm. Nella cartella dell'app
      `ls KIDVILLE-CHIAVI-BACKUP` risponde «No such file or directory».
- [ ] Revoca della vecchia `sb_secret_` (finita nella storia git di un clone dell'app, rapporto del 20/10, D8)
      confermata dal titolare nel pannello di Supabase (Project Settings → API Keys), il gg/mm.

## Collegarsi a R2 (sul Mac, con il token di LETTURA)

Le credenziali si digitano a mano nel terminale: non si incollano in chat e non si salvano.

```bash
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_REGION=auto RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
read -rsp "Access Key ID (lettura): " RCLONE_CONFIG_R2_ACCESS_KEY_ID; echo; export RCLONE_CONFIG_R2_ACCESS_KEY_ID
read -rsp "Secret (lettura): " RCLONE_CONFIG_R2_SECRET_ACCESS_KEY; echo; export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
read -rp "Account ID Cloudflare: " ACC; export RCLONE_CONFIG_R2_ENDPOINT="https://$ACC.eu.r2.cloudflarestorage.com"
rclone lsf R2:kidville-backup/db/giornalieri/
```

Per i **file** serve anche il remote cifrato (si apre solo con la password):

```bash
export RCLONE_CONFIG_CRIPTO_TYPE=crypt RCLONE_CONFIG_CRIPTO_REMOTE=R2:kidville-backup/storage
export RCLONE_CONFIG_CRIPTO_FILENAME_ENCRYPTION=standard RCLONE_CONFIG_CRIPTO_DIRECTORY_NAME_ENCRYPTION=false
read -rsp "Password crypt: " P1; echo; export RCLONE_CONFIG_CRIPTO_PASSWORD="$(rclone obscure "$P1")"
read -rsp "Salt crypt: " P2; echo; export RCLONE_CONFIG_CRIPTO_PASSWORD2="$(rclone obscure "$P2")"; unset P1 P2
rclone lsf CRIPTO:corrente --dirs-only
```

---

## Scenario A0 — «Una riga è stata CANCELLATA negli ultimi 90 giorni» (la scatola nera)

Dal 2026-10-09 (fase 4 della roadmap) ogni riga cancellata da una delle **tabelle preziose** resta per 90 giorni
in `scatola_nera.eliminazioni`, con le righe portate via in CASCADE: anagrafica, presenze, diario, voti e scrutini,
certificati e documenti, pagamenti e incassi, cassa, moduli, sezioni e sedi (42 tabelle, fra i marcatori
`tabelle-preziose` di `*_scatola_nera_registro_eliminazioni.sql`). Dalla sessione 3 della seconda serie anche le
**figlie in cascata** (messaggi, conversazioni e sospensioni delle conversazioni della chat, avvisi e risposte dei
genitori, prese visione delle note, storico delle classi, copie storiche, registro degli accessi al fascicolo: dieci
tabelle fra i marcatori `figlie-in-cascata` di `*_scatola_nera_cascate_anagrafiche.sql`) e il **registro di
protocollo** con i suoi allegati (`*_scatola_nera_protocollo.sql`). **Fuori**: le tabelle che una retention svuota per
legge (domande di iscrizione, personale, candidature, galleria, allegati del registro, notifiche) e i registri; chi
altro resta fuori, col motivo (configurazione d'accesso, tabelle operative, lavori di stampa, `registro_destinatari`),
sta nell'intestazione di `*_scatola_nera_cascate_anagrafiche.sql`. Per quelle si passa allo scenario A.

**Il protocollo.** Una registrazione eliminata torna con `scatola_nera.ripristina_transazione` (prima la
registrazione, poi gli allegati: l'ordine lo risolve la funzione; il WORM non vieta l'INSERT). I **file** no:
`protocollo_elimina` li toglie subito dal bucket (decisione #2), mentre la riga resta 90 giorni. I file della
registrazione e le versioni dei documenti rettificati tornano dal cestino dello specchio di R2 (scenario C, 30
giorni), con lo stesso prefisso `<sede>/<anno>/<numero a 7 cifre>` (`-originale.<ext>`, `-timbrato.pdf`,
`-allegati/`, `-versioni/`). Dopo 30 giorni la riga si ripristina ancora, i file non più.

**La chat e «libera spazio».** I messaggi senza allegato che «libera spazio» (`src/lib/alunni/libera-spazio.ts`)
toglie a un bambino ritirato finiscono anche loro in `scatola_nera.eliminazioni`: **i testi delle conversazioni fra
famiglia e insegnanti restano nel database per 90 giorni**, e lo spazio si libera davvero solo alla scadenza. L'oblio
li toglie se una famiglia lo chiede; nessun giro li toglie prima della scadenza. È la scelta «accetta», decisa
dall'assistente il 25/10/2026 in assenza del titolare, **da confermare**; l'informativa lo dice. Per tornare indietro
serve una funzione SQL che accenda `scatola_nera.senza_storico` per la sola DELETE di «libera spazio» (PostgREST da
solo non può farlo).

Si lavora dal **SQL editor** del pannello Supabase (ruolo `postgres`): l'app non ha accesso allo schema. Si legge prima,
si mostra, poi si scrive.

1. **Trova** le righe. Per persona (uuid dell'alunno, del genitore, del pagamento…) o per tabella e periodo:
   ```sql
   SELECT id, eliminata_il, transazione, tabella, ruolo, origine, riga->>'id' AS id_riga
     FROM scatola_nera.eliminazioni
    WHERE '<uuid>' = ANY(soggetti)              -- oppure: tabella = 'presenze' AND eliminata_il > now() - interval '2 days'
    ORDER BY id DESC;
   ```
   Righe cancellate insieme (una DELETE con le sue cascate) hanno la stessa `transazione`.
2. **Guarda** che cosa torna, senza copiarlo in chat né in un file: sono dati di minori.
   `SELECT tabella, count(*) FROM scatola_nera.eliminazioni WHERE transazione = <n> GROUP BY 1;`
3. **Ripristina**, dopo averlo mostrato:
   ```sql
   SELECT scatola_nera.ripristina_transazione(<transazione>);   -- tutto ciò che è stato cancellato insieme
   SELECT scatola_nera.ripristina(ARRAY[<id>, <id>]::bigint[]);  -- oppure solo alcune righe
   ```
   La risposta è `{"ripristinate": n, "gia_presenti": [...], "fallite": [...]}`. L'ordine delle FK lo risolve la
   funzione: chi aspetta il padre riprova al giro dopo. Una riga con la stessa chiave già presente **non** si
   sovrascrive: va in `gia_presenti`. Una riga di `utenti` torna solo se l'account esiste ancora in `auth.users`
   (`23503` in `fallite` vuol dire «manca il padre»). I **file** non sono nella scatola: tornano dallo specchio di R2.
4. **Gli oblii** non si ripristinano mai: chi è stato dimenticato non è più nella scatola (`public.scatola_nera_dimentica`
   l'ha tolto), e `scatola_nera.oblii` dice chi e quando.

## Scenario A0-bis — «Una riga è stata MODIFICATA male negli ultimi 90 giorni» (lo storico delle modifiche)

Dal 2026-10-19 (fase 12 della roadmap) ogni UPDATE su **13 tabelle** lascia in `scatola_nera.modifiche` la riga
**com'era prima**, per 90 giorni: valutazioni e obiettivi, presenze e giustifiche didattiche, pagamenti, quote e incassi,
scrutini (giudizi, comportamento, giudizio descrittivo, periodi) e pagelle (`*_scatola_nera_modifiche.sql`). Dalla
sessione 3 della seconda serie le tabelle sono **20**: anche alunni, genitori (`parents`), utenti, note disciplinari,
certificati medici (`*_scatola_nera_cascate_anagrafiche.sql`, marcatori `anagrafiche-storico`) e il registro di
protocollo con gli allegati (`*_scatola_nera_protocollo.sql`). Non si copia una modifica che tocca solo
`updated_at`/`aggiornato_il`/`storico_versione`, né la retention notturna delle giustificazioni (svuota testi per legge:
copiarli li terrebbe in vita). **Fuori**: tutto il resto, per cui si passa allo scenario A.

**Il protocollo.** Il WORM del registro rifiuta un UPDATE che non passa dalla rettifica: il ripristino di una
registrazione rettificata male si fa nella stessa transazione del suo interruttore, dopo averlo mostrato:
`BEGIN; SELECT set_config('app.protocollo_admin_update', 'on', true); SELECT scatola_nera.ripristina_modifiche(ARRAY[<id>]::bigint[]); COMMIT;`
(senza l'interruttore la riga finisce in `fallite`). Il documento di prima sta in
`<sede>/<anno>/<numero a 7 cifre>-versioni/<istante>-<nome del file di prima>` (istante UTC a 17 cifre, nome come
`<numero a 7 cifre>-originale.<ext>`): si rimette al percorso dell'originale dal pannello dello Storage, e il timbrato si
rigenera con una rettifica che ricarica quel documento. Le versioni non scadono: restano finché esiste la registrazione.
⚠️ **Riserva della regola T4:** la rettifica copia il documento di prima *prima* di caricare il nuovo, e se la copia non
riesce non parte e risponde **500**. Se il file indicato da `file_originale` non c'è più nel bucket, la copia fallisce
sempre: un documento già orfano non si può più sostituire con una rettifica finché qualcuno non rimette un file a quel
percorso dal pannello dello Storage. Misurato il 25/10/2026 (10:41 UTC): 0 orfani su 325 registrazioni.

**Le anagrafiche e l'oblio.** Anonimizzare una scheda (alunno, genitore, utente) è un UPDATE: lascia in
`scatola_nera.modifiche` la riga **com'era**, con i dati personali, finché l'oblio dell'app non chiama
`public.scatola_nera_dimentica`, che la toglie perché nomina l'`id`. L'app la chiama **per ultima**
(`src/lib/gdpr/esegui.ts`, `src/lib/gdpr/scatola-nera.ts`). Se quella chiamata fallisce, la copia **resta fino alla
scadenza dei 90 giorni**: nessuno la ritenta da solo; l'oblio risulta parziale (`letture_fallite` > 0; nel log `gdpr`
una riga `error` `scatola-nera-non-dimenticata` e, dalle route dell'oblio, `oblio-parziale`). Si rimedia dal SQL editor, dopo averla
mostrata: `SELECT public.scatola_nera_dimentica(ARRAY['<uuid>']::uuid[], '<alunno|genitore|personale|altro>', 'runbook');`
La funzione toglie anche i messaggi, le revisioni dei messaggi e le sospensioni delle conversazioni della persona, le
sospensioni che la nominano in `sospesa_da`, `sospesa_verso` o `riaperta_da`, e le copie di un alunno (cancellato o
com'era prima di un UPDATE) che la nominano come adulto in `intestatario_fatture.adult_id` o in
`retta_split_config.quote[].adult_id`: se la segreteria cambia l'intestatario da A a B, la riga viva nomina B e la copia è
l'unico posto dove resta A. Queste copie **non** hanno A in `soggetti`: la query del passo 1 qui sotto non le trova.

**Limiti noti dell'oblio nella scatola nera** (revisione indipendente del 25/10/2026; si estendono se il titolare lo chiede):
- **Uuid di persona fuori da `id`/`*_id`.** `soggetti_di` non legge `chat_messages.rettifica_staff_da`, `creato_da` (in
  `alunni_classi_storico` e `storici_collegamenti`) e, nello storico delle modifiche, `note_disciplinari.firmata_da`,
  `certificati_medici.caricato_da`, `alunni.retta_a_carico_di`: l'oblio non toglie una copia che nomina la persona solo
  lì. Restano solo uuid, senza altri dati. Si estende aggiungendo la colonna a `scatola_nera.soggetti_di`.
- **`fascicolo_accessi_audit`.** `ip` e `user_agent` si azzerano a 12 mesi (`fascicolo_audit_ip_retention_tick`), ma la
  copia di una riga cancellata a 11,9 mesi li conserva fino a 90 giorni in più.
- **L'adulto senza uuid.** `alunni.invoice_holder_details` (nome, cognome, codice fiscale dell'adulto che intesta le
  fatture: 47 righe il 25/10) e l'intestatario di tipo «altro», con i suoi `dati` (28 righe), non hanno un uuid che li
  leghi a una persona: l'oblio del genitore non li pulisce né sulla riga viva (difetto che c'era già,
  `src/lib/gdpr/esegui.ts`) né nelle copie. L'oblio dell'**alunno** li azzera sulla riga viva, e la copia che quell'UPDATE
  lascia se ne va perché nomina l'alunno.
- **Le DELETE dell'oblio scorrono le tabelle.** Su `scatola_nera.eliminazioni` (quattro rami `OR`) e su
  `scatola_nera.modifiche` (due) l'indice GIN di `soggetti` non serve: si legge tutta la tabella. Va bene con le 139 e 797
  righe del 25/10; se crescono, si spezza ogni DELETE in una per ramo.
- **La rettifica del protocollo a metà.** Se, dopo aver sovrascritto l'originale (stessa estensione), falliscono il
  caricamento del timbrato o la rpc, impronta e tipo nel database non corrispondono più al file. La copia in
  `<numero a 7 cifre>-versioni/` permette di recuperarlo (paragrafo «Il protocollo» qui sopra), ma nessuno lo ripristina da
  solo e nessun log lo segnala (difetto che c'era già; 0 casi su 325 registrazioni il 25/10).

Sempre dal **SQL editor** (ruolo `postgres`), leggendo prima e mostrando poi.

1. **Trova** le modifiche. Per persona o per tabella e periodo:
   ```sql
   SELECT id, modificata_il, transazione, tabella, riga_id, cambiate, ruolo, origine
     FROM scatola_nera.modifiche
    WHERE '<uuid>' = ANY(soggetti)              -- oppure: tabella = 'valutazioni' AND modificata_il > now() - interval '2 days'
    ORDER BY id DESC;
   ```
   `cambiate` dice quali colonne sono cambiate; una UPDATE su più righe ha una sola `transazione`.
2. **Guarda** quante righe torneranno indietro, senza copiarne il contenuto: sono dati di minori.
   `SELECT tabella, count(*) FROM scatola_nera.modifiche WHERE transazione = <n> GROUP BY 1;`
3. **Ripristina**, dopo averlo mostrato:
   ```sql
   SELECT scatola_nera.ripristina_modifiche_transazione(<transazione>);   -- tutta una UPDATE sbagliata
   SELECT scatola_nera.ripristina_modifiche(ARRAY[<id>, <id>]::bigint[]);  -- oppure solo alcune righe
   ```
   La risposta è `{"ripristinate": n, "righe_assenti": [...], "fallite": [...]}`. Le modifiche si riapplicano dalla
   più recente alla più vecchia, quindi ogni riga torna allo stato **prima della prima** modifica scelta. Una riga
   che nel frattempo è stata cancellata va in `righe_assenti`: prima la si riporta con lo scenario A0. Le colonne
   generate e le identity non si toccano. Il ripristino è a sua volta un UPDATE, e quindi lascia la sua copia: se
   era sbagliato, si annulla allo stesso modo.
4. **Attenzione al dopo.** Ripristinare un pagamento o un incasso non ricalcola le fatture già emesse né rimanda
   avvisi già partiti: si guarda la contabilità della persona prima di dire «fatto».

## Scenario A — «Un errore nei dati è stato scoperto» (riga o tabella sbagliata)

1. **Non fare niente di fretta e non scrivere nulla in produzione.** Annota quando è successo l'errore e cosa è cambiato.
   Se l'errore è una **cancellazione** degli ultimi 90 giorni su una tabella preziosa, la strada è lo scenario A0.
2. **Entro 7 giorni**: i backup fisici di Supabase hanno ancora la versione giusta. Strada più sicura:
   pannello Supabase → Database → Backups → **Restore to a new project** (non tocca la produzione), poi si
   copiano nella produzione **solo** le righe sbagliate. ⚠️ Il progetto nuovo contiene i dati dei minori: va
   distrutto appena finito, dal titolare, nel pannello.
3. **Da 8 a 30 giorni**: il dump cifrato di R2. Si scarica, si decifra e si ripristina in locale con
   `ripristina-prova.sh` (vedi sotto), si estraggono le righe giuste.
4. **Oltre i 30 giorni**: solo la copia mensile (12 mesi), se la riga esisteva il primo del mese.
5. Dopo il ripristino di quelle righe: riapplica gli **oblii GDPR** avvenuti dopo la data della copia. Dal 2026-10-09
   l'elenco è nel database di produzione, non più solo nei log (che si svuotano a 30 giorni):
   `SELECT eseguito_il, soggetto, tipo, canale FROM scatola_nera.oblii WHERE eseguito_il > '<data della copia>' ORDER BY 1;`
   Per ogni soggetto si rifà l'oblio dall'app (Direzione → GDPR) sulle righe appena ripristinate.

## Scenario B — «Il backup di stanotte è fallito» (email o segnalazione `backup-notturno`)

Non è un'emergenza la prima notte: l'ultima copia buona è quella di ieri. **Lo diventa dalla seconda** notte consecutiva.

1. Apri il link del giro nella segnalazione e leggi il passo rosso. I casi noti:
   - **«sorgente vuota» / «calata sotto il 90%»** (specchio): la sorgente appare vuota o molto più piccola. NON è
     una cancellazione voluta finché non lo verifichi su Supabase. Se invece è una pulizia vera: rilancia con
     `PERMETTI_CALO=1` (solo dallo script, a voce).
   - **«il piano prevede N cancellazioni»** (specchio): troppi file spariti dalla sorgente in un giro. Stessa verifica. Il giro si è fermato PRIMA di toccare lo specchio.
   - **«il piano sostituirebbe N file già presenti»** (specchio): rclone ritiene cambiati troppi file che nella sorgente non lo sono, di solito perché le **date** non coincidono (lo specchio è un `crypt`, senza hash). Nel log, sotto `PIANO`, ci sono i conteggi per frase e l'unità degli scarti di data (`ms`, `s`, `h`…): se sono `ms` o pochi `s` serve una finestra più larga (`FINESTRA_DATE` in `scripts/backup/specchio-storage.sh`, oggi 2 s); se sono ore, qualcuno ha toccato le date dei file. Nei log non passa mai un nome di file.
   - **«dump troppo piccolo» / «meno della metà di ieri»**: il database ha perso molte righe o il dump è monco. Verifica i conteggi su Supabase prima di tutto.
   - **errore di connessione / permessi** su `BACKUP_DB_URL`: password del ruolo `backup_lettura` cambiata, o il pooler. Si rimette con `ALTER ROLE backup_lettura WITH LOGIN PASSWORD '…'` (nel SQL editor, a mano) e si aggiorna il segreto.
   - **errore 403 su R2**: token R2 scaduto o revocato → si ricrea in Cloudflare e si aggiorna `BACKUP_R2_KEY_*`.
2. Rilancia: `gh workflow run backup-notturno.yml -f modalita=completo`.
3. Se il workflow **non parte proprio**: alle 02:23 UTC lo lancia il monitor esterno (Worker di Cloudflare), che in
   quel caso manda subito l'email «Backup notturno NON partito» con la risposta di GitHub. I casi noti:
   - `401 Bad credentials`: il token `GITHUB_TOKEN_CAMPANELLO` è scaduto o revocato → `docs/cicd.md`, «Monitor esterno»;
   - nessuna email e nessun giro: il Worker non è partito (pannello Cloudflare → Workers → `kidville-monitor-esterno` → Logs);
   - `esito=spento-a-mano` nei log del Worker: qualcuno ha spento il workflow; si riaccende con
     `gh workflow enable backup-notturno.yml`.
   Dopo 30 ore senza un giro automatico riuscito il campanello apre `[backup-vecchio]`. A mano:
   `gh run list --workflow backup-notturno.yml --limit 14`. I giri automatici sono «Backup notturno completo (da
   Cloudflare)» e quelli dello `schedule`; uno `schedule` «cancelled» è la guardia delle 20 ore, non un guasto.

## Scenario C — «Un file è stato cancellato per errore» (modulo, documento, allegato)

> Vale per tutti i bucket **tranne** `gallery` e `video_originals`, che non sono nel backup (vedi sopra).

1. Entro 30 giorni il file è nel cestino dello specchio. Cerca il giorno in cui è sparito (la cartella ha la data):
   ```bash
   rclone lsf CRIPTO:cestino --dirs-only          # le date disponibili
   rclone lsf CRIPTO:cestino/AAAA-MM-GG/<bucket> -R --files-only | head
   ```
2. Recuperalo (si decifra da solo) e rimettilo su Supabase:
   ```bash
   rclone copyto CRIPTO:cestino/AAAA-MM-GG/<bucket>/<percorso> ./recuperato.bin
   ```
   Il caricamento su Supabase si fa dal pannello (Storage) o con il remote `SB:` e la chiave S3, con lo
   **stesso percorso** di prima. ⚠️ Il file recuperato contiene dati di una famiglia: non lasciarlo in giro.
3. Se il file sparito era in realtà un **oblio GDPR voluto**, non va rimesso. Vedi lo scenario D.

## Scenario D — «Una famiglia ha chiesto la cancellazione dei dati» (oblio)

La cancellazione avviene su Supabase come sempre. Le copie esterne **scadono da sole**, e questo va scritto
nell'informativa e nel registro dei trattamenti:
- lo specchio dei file toglie il file nel giro successivo: resta nel **cestino** fino a **31 giorni**;
- i dump giornalieri contengono ancora i dati fino a **31 giorni**, i mensili fino a **12 mesi**;
- **non si possono cancellare prima**: il lock è fatto apposta, e vale anche per chi ha le chiavi.
Se un giorno una copia vecchia viene **ripristinata**, gli oblii avvenuti dopo la data di quella copia vanno **riapplicati**
prima di riaprire l'app (oggi l'elenco degli oblii è nei log: la fase 4 della roadmap ne farà un registro recuperabile).

## Scenario E — «Il progetto Supabase è perso o bloccato» (il disastro)

> 🟠 **Procedura provata a pezzi, non dall'inizio alla fine.** Le due prove del 06/10 (vedi
> `docs/prova-ripristino-2026-10.md`: la nostra copia sul Mac e il «Restore to a new project» di Supabase) ne coprono il database; mancano i file e l'app; chi la usa per un disastro vero
> deve aggiornare questo scenario con quello che ha trovato.

1. Respira. Le copie sono al sicuro in R2; l'app è ferma ma i dati non sono persi.
2. Crea un **nuovo progetto Supabase** nella stessa regione (UE, `eu-west-1`) e imposta una nuova password del database.
3. Scarica dump e manifest più recenti (sopra) e **verifica la copia** sul Mac prima di toccare il nuovo progetto:
   ```bash
   DUMP_FILE=./dump.age MANIFEST_FILE=./manifest.age AGE_KEY_FILE=./chiave-temporanea.txt \
     PG_BIN="$(brew --prefix postgresql@17)/bin" bash scripts/backup/ripristina-prova.sh
   ```
4. Ripristina il dump nel nuovo progetto (schema `public` per intero; per `auth` e `storage` i **dati**, perché lo
   schema esiste già) — il dettaglio e l'ordine esatto vanno confermati dalla prova.
5. **Subito, prima di qualunque altra cosa: spegni `pg_cron`** nel nuovo progetto (28 job attivi e 19 funzioni
   con `pg_net`: potrebbero chiamare l'app di produzione, e `iscrizioni-import-invio` manda email alle famiglie).
   **Provato il 06/10:** `pg_cron` viene copiato e resta **acceso**, e `UPDATE cron.job` è **negato** (`42501`). Si spegne
   dal pannello del **nuovo** progetto, Database → Extensions → `pg_cron` → off (cancella i job), oppure un job alla volta con
   `SELECT cron.alter_job(job_id := N, active := false);`. Controlla il nome del progetto nel titolo della scheda
   **prima** di cliccare: spegnerli in produzione sarebbe un incidente.
6. Rimetti i **segreti dei cron nel Vault** e le **password dei ruoli**. Il dump non porta lo schema `vault`, e
   `ALTER DATABASE … SET` è negato (`42501`). Dal SQL editor del **nuovo** progetto, una riga per nome, con il
   valore scritto solo lì (mai in un file, in una chat o nel repository):
   ```sql
   select vault.create_secret('<valore>', '<nome>');
   ```
   | Nome | Valore |
   |---|---|
   | `app.cron_secret` | lo stesso di `CRON_SECRET` su Vercel |
   | `app.push_dispatch_url` | `https://<dominio-prod>/api/push/dispatch` (molti cron ne usano solo l'origine) |
   | `app.notifiche_promemoria_url` | `https://<dominio-prod>/api/notifiche/promemoria` |
   | `app.retention_iscrizioni_url` | `https://<dominio-prod>/api/gdpr/retention-iscrizioni` |
   | `app.fattura_sync_url` | `https://<dominio-prod>/api/pagamenti/fattura/sync` |
   | `app.mensa_allergie_url` | `https://<dominio-prod>/api/mensa/allergie-check` |

   Controllo, senza leggere i valori: `select name from vault.secrets order by name;` → sei righe. L'elenco è
   sorvegliato dal lock `backup-notturno-sicuro`: ogni `cron_config('<nome>')` delle migrazioni deve stare qui.
7. Ricarica i **file** dallo specchio nel nuovo Storage (`rclone sync CRIPTO:corrente SB_NUOVO:`), con il remote cifrato.
8. In **Vercel** cambia le variabili del nuovo progetto (`NEXT_PUBLIC_SUPABASE_URL`, chiavi `anon` e `service_role`, URL del DB), poi rilancia il deploy.
9. Riapplica gli **oblii** avvenuti dopo la data della copia. Riaccendi i cron uno alla volta. Verifica i conteggi.

## Dopo QUALSIASI ripristino — lista di controllo

- [ ] `pg_cron` spento finché non è tutto a posto (e riacceso con cura).
- [ ] Conteggi per tabella confrontati con il manifest (`ripristina-prova.sh` lo fa).
- [ ] I sei segreti dei cron rimessi nel Vault (`select name from vault.secrets order by name;` → sei righe) e le password dei ruoli rimesse.
- [ ] Oblii GDPR avvenuti dopo la data della copia **riapplicati**.
- [ ] Il ruolo `backup_lettura` ha di nuovo login e password, e il segreto `BACKUP_DB_URL` è aggiornato.
- [ ] Un giro `modalita=prova` del backup notturno è verde.

---

## Provare il ripristino della NOSTRA copia (sul Mac)

Serve ogni 3 mesi (promemoria nella roadmap) e dopo ogni cambio di chiave. Non tocca la produzione.

```bash
# 1. scarica un dump e il suo manifest (collegati a R2 come sopra)
rclone copyto R2:kidville-backup/db/giornalieri/<AAAA-MM-GGThhmmZ>.dump.age ./dump.age
rclone copyto R2:kidville-backup/db/giornalieri/<AAAA-MM-GGThhmmZ>.manifest.jsonl.age ./manifest.age
```
```bash
# 2. la chiave privata va in un file TEMPORANEO, che si cancella subito dopo
DUMP_FILE=./dump.age MANIFEST_FILE=./manifest.age AGE_KEY_FILE=./chiave-temporanea.txt \
  PG_BIN="$(brew --prefix postgresql@17)/bin" bash scripts/backup/ripristina-prova.sh
```
```bash
# 3. pulizia: chiave, dump decifrabile e manifest
rm -f ./chiave-temporanea.txt ./dump.age ./manifest.age
```

Lo script stampa una riga `RISULTATO tabelle_confrontate=… uguali=… diverse=… secondi_ripristino=…` e esce con errore se
anche **una sola** tabella ha un numero di righe diverso dal manifest. Non stampa righe né i messaggi di `pg_restore`.

Per i **file**: `ESCLUDI_BUCKET="gallery video_originals" bash scripts/backup/apri-campioni.sh` (con i due remote `SB:`
e `CRIPTO:` configurati come sopra) apre 5 file per bucket, li decifra e li confronta con l'originale (impronta e firma
dei byte), **senza mostrarli**. `ESCLUDI_BUCKET` elenca i bucket fuori dal backup per scelta del titolare (gli stessi del
workflow): senza, il giro **fallisce** perché non li trova nello specchio, ed è giusto che un bucket sparito per errore
non passi inosservato.

## Cambiare la chiave age (rotazione)

Si genera una nuova coppia, si sostituisce la chiave **pubblica** in `backup-notturno.yml` (PR + merge) e da quella
notte le copie sono cifrate con la nuova. Le copie vecchie restano cifrate con la **vecchia** chiave privata: va
**conservata** finché esiste una copia fatta con lei (fino a 12 mesi per le mensili).

## Regole di conservazione su R2 (dal pannello Cloudflare)

Vedi la tabella in `docs/cicd.md` («Backup notturno esterno»). Si impostano **dopo** i giri di prova. R2 non ha
versioning né Object Lock S3: la protezione sono i **nomi con la data** e i **bucket lock** (che vincono sul lifecycle:
una scadenza non può cancellare un oggetto ancora bloccato). Con un lock attivo il bucket non si può svuotare.
