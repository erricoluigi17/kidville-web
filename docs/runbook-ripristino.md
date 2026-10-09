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
- le **impostazioni del database** (`app.cron_secret`, gli URL dei cron…): i loro **nomi** stanno nel manifest, i valori in Vercel (`CRON_SECRET`) e nel passaggio «Cron di produzione» di `docs/cicd.md`;
- le **password dei ruoli** (anche `backup_lettura`) e lo schema `vault`;
- le **chiavi API** del nuovo progetto (vanno rimesse in Vercel) e le impostazioni di Auth.

## Cosa serve per ripristinare, e dove sta

| Serve | Dove sta | Se è perso |
|---|---|---|
| **Chiave privata age** | offline, 2 supporti (titolare). Copia di lavoro nella cartella `KIDVILLE-CHIAVI-BACKUP/` dell'app: **ignorata da git** (un lock lo verifica) ma **non è una copia offline** | i dump non si aprono più, per nessuno |
| **Password e salt di rclone crypt** | offline, 2 supporti (titolare); in GitHub solo per il backup; copia di lavoro in `KIDVILLE-CHIAVI-BACKUP/` (ignorata da git) | i file dello specchio non si aprono più |
| **Token R2 di lettura** (`backup-lettura`) | pannello Cloudflare → R2 → Manage API tokens (si ricrea) | si ricrea; non serve la chiave per cambiarlo |
| Accesso al pannello Supabase, Vercel, GitHub | titolare | — |
| Strumenti sul computer | `age`, `rclone`, `jq`, Postgres 17 (`pg_restore`, `psql`, `initdb`) | `brew install age rclone jq postgresql@17` |

> ⚠️ **La chiave privata `age` e la password di cifratura non vanno MAI in GitHub, in chat, in un
> documento o in un file del repository.** Per una prova si mette la chiave in un file temporaneo e lo
> si cancella subito dopo.

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

Dal 2026-10-09 (fase 4 della roadmap) ogni riga cancellata da una delle **42 tabelle preziose** resta per 90 giorni
in `scatola_nera.eliminazioni`, con le righe portate via in CASCADE: anagrafica, presenze, diario, voti e scrutini,
certificati e documenti, pagamenti e incassi, cassa, moduli, sezioni e sedi. L'elenco esatto sta nella migrazione
`*_scatola_nera_registro_eliminazioni.sql`, fra i marcatori `tabelle-preziose`. **Fuori**: le tabelle che una retention
svuota per legge (domande di iscrizione, personale, candidature, galleria, allegati del registro, notifiche), il
protocollo e i registri. Per quelle si passa allo scenario A.

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
3. Se il workflow **non parte proprio** (nessuna email, nessun giro): lo vede il campanello (`campanello.yml`, fase 3), che apre `[backup-vecchio]` quando l'ultimo giro automatico riuscito ha più di 30 ore. Si guarda anche a mano con `gh run list --workflow backup-notturno.yml --event schedule`.

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
6. Rimetti le **impostazioni del database** (i nomi sono nel manifest) e le **password dei ruoli**.
7. Ricarica i **file** dallo specchio nel nuovo Storage (`rclone sync CRIPTO:corrente SB_NUOVO:`), con il remote cifrato.
8. In **Vercel** cambia le variabili del nuovo progetto (`NEXT_PUBLIC_SUPABASE_URL`, chiavi `anon` e `service_role`, URL del DB), poi rilancia il deploy.
9. Riapplica gli **oblii** avvenuti dopo la data della copia. Riaccendi i cron uno alla volta. Verifica i conteggi.

## Dopo QUALSIASI ripristino — lista di controllo

- [ ] `pg_cron` spento finché non è tutto a posto (e riacceso con cura).
- [ ] Conteggi per tabella confrontati con il manifest (`ripristina-prova.sh` lo fa).
- [ ] Impostazioni del database e password dei ruoli rimesse.
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
