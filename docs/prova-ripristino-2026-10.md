# Prova di ripristino — ottobre 2026

Roadmap di robustezza, fase 2. **Un backup che nessuno ha mai ripristinato è una speranza.** Qui stanno gli esiti delle
due prove: solo **numeri e nomi di tabella**, mai righe, nomi di persone o messaggi di errore con valori (il repository è
pubblico e il database contiene dati di minori).

## Prova 1 — la nostra copia, sul Mac · ✅ riuscita il 06/10/2026

**Cosa si è provato.** Il dump cifrato del giro `completo` del 06/10 (00:04 UTC) è stato scaricato da R2, decifrato con la
chiave **privata** `age` (tenuta fuori dal repository e fuori da GitHub) e ripristinato in un Postgres 17.11 usa-e-getta
che ascolta **solo su un socket locale**, senza rete. Poi le righe di ogni tabella sono state contate e confrontate con
quelle registrate nel manifest nello stesso istante del dump. Comando: `scripts/backup/ripristina-prova.sh` (passi nel
runbook, «Prova di ripristino»).

| | |
|---|---|
| Tabelle nel manifest | 183 (125 con almeno una riga), **441.858 righe** in tutto |
| Tabelle confrontate | 175 (le altre sono lo schema `cron` e le tabelle i cui dati il backup esclude di proposito) |
| **Uguali al manifest** | **175 su 175** |
| Diverse | **0** |
| Errori di `pg_restore` | 5, tutti attesi (estensioni e ruoli di Supabase che in locale non esistono: `pg_cron`, `pg_net` e simili) |
| Tempo di ripristino | 1 secondo; totale con decifratura e confronto 3 secondi |
| Pulizia | nessun processo Postgres e nessuna cartella di lavoro rimasti (la cartella conteneva i dati dei bambini) |

**File.** `scripts/backup/apri-campioni.sh` ha aperto **54 file in 12 bucket** dallo specchio cifrato (decifrati al volo) e li
ha confrontati con gli originali su Supabase: impronta `sha256` uguale e firma dei byte coerente con l'estensione, in
**54 casi su 54**. `gallery` e `video_originals` non sono nel backup per scelta del titolare del 06/10 e lo script li salta
dichiarandolo (`ESCLUDI_BUCKET`).

**Cosa ha trovato la prova (difetti dello script, non del backup).** Tre, tutti invisibili ai test con strumenti finti e
corretti con un test visto prima rosso:

1. `apri-campioni.sh`: `sort -R | head -n 5` con `set -o pipefail` usciva con codice **141** (SIGPIPE) sui bucket con
   migliaia di file.
2. `apri-campioni.sh`: i bucket fuori dal backup risultavano «diversi» perché cercati nello specchio. Ora `ESCLUDI_BUCKET`
   li salta; **senza**, un bucket mancante dallo specchio fa fallire il giro (voluto).
3. `ripristina-prova.sh`: su macOS un postmaster senza una locale valida muore con «postmaster became multithreaded during
   startup»; lo script ora imposta `LC_ALL` (`en_US.UTF-8` se non c'è).

## Prova 2 — «Restore to a new project» di Supabase · ✅ riuscita il 06/10/2026 (progetto temporaneo da cancellare)

Verifica il **paracadute di Supabase** (i suoi backup fisici), non il nostro. Dal pannello (Database → Backups → «Restore to
new project») si è ripristinato il backup più recente (06/10, 00:59 UTC) in un progetto nuovo: stessa organizzazione e
regione (`eu-west-1`), compute Small, **14,83 $ al mese di calcolo, fatturati a ore** (qualche centesimo per la prova).
È stata fatta **di giorno**, su richiesta del titolare, che ha accettato il rischio di notifiche doppie alle famiglie.

| | Esito |
|---|---|
| Richiesta inviata | 06/10, 12:49 UTC |
| Progetto pronto («COMPLETED», stato «Healthy») | entro le 12:54:58 UTC: **circa 5 minuti e mezzo** (è un massimo: il controllo era ogni minuto) |
| Ultima migrazione nel clone | `ruolo_backup_lettura`, la stessa di produzione |
| `pg_cron` spento | 12:57:15 UTC, **circa 2 minuti** dopo che il ripristino risultava completo |
| Tabelle in `public` | 145 nel clone, 145 in produzione |
| Ultimo log nel clone | 00:51 UTC, coerente con un backup delle 00:59 |

**Conteggi, clone contro produzione (12:48 UTC), spiegati record per record.** In produzione sono nate dopo il backup
(00:59:17 UTC) 26 righe di `pagamenti`, 359 di `incassi` e 1 di `enrollment_submissions`.

| Tabella | Clone | Produzione | Nate dopo il backup | Produzione − nuove |
|---|---|---|---|---|
| `alunni` | 789 | 789 | 0 | 789 ✅ |
| `utenti` | 956 | 956 | 0 | 956 ✅ |
| `auth.users` | 956 | 956 | 0 | 956 ✅ |
| `pagamenti` | 2.142 | 2.168 | 26 | 2.142 ✅ |
| `incassi` | 1.081 | 1.440 | 359 | 1.081 ✅ |
| `enrollment_submissions` | 722 | 723 | 1 | 722 ✅ |

**Tutte le tabelle chiave coincidono al record**, una volta tolte le righe scritte dopo il backup.

**Cosa ha insegnato** (e il runbook, scenario E, ora lo dice):

1. **Il modulo chiede una password del database ma la precompila** con una generata: non serve scriverne nessuna, e chi
   fa la prova non deve rivelarla. Il nome del progetto sì.
2. **`pg_cron` e `pg_net` vengono copiati e restano accesi**: la trappola era vera. Nel clone `UPDATE cron.job` è **negato**
   (`42501: permission denied for table job`). Si spegne dal pannello, **Database → Extensions → `pg_cron` → off** (cancella
   i job: va bene solo su un progetto temporaneo), oppure un job alla volta con
   `SELECT cron.alter_job(job_id := N, active := false);`.
3. **Da «pronto» a «cron spento» sono passati circa 2 minuti**, pur andando in fretta. In quel tempo il clone può avere
   eseguito dei job che chiamano l'app di produzione. Nei log di produzione di quella finestra (12:53–12:59 UTC) non c'è
   nessuna riga anomala, ma **non è una prova che non abbia eseguito nulla**. Per questo la prova si fa **di notte**, a
   coda delle notifiche vuota.
4. Il modulo avvisa che **non si copiano** Storage, Edge Functions, impostazioni di Auth, estensioni e impostazioni del
   database, repliche: un clone ripristinato **non è un'app funzionante**. I file si recuperano solo dallo specchio su R2.
5. Nella lista «Scheduled backups» i pulsanti **Restore ripristinano sopra la produzione**. Quelli giusti stanno nella
   scheda «Restore to new project».
6. La prova ha richiesto di **non fidarsi dell'ultimo clic**: ogni azione sul clone è stata preceduta dalla verifica del
   nome del progetto nel titolo della scheda e dell'indirizzo, perché un `cron.job` spento per sbaglio in produzione
   sarebbe stato un incidente.

**Il progetto temporaneo** `kidville-prova-ripristino-TEMPORANEO` contiene **dati veri di minori** e costa circa 2 centesimi
all'ora: **va cancellato appena possibile** (Settings → General → Delete project). L'assistente non cancella progetti.

| | |
|---|---|
| Progetto temporaneo cancellato il | — (da compilare) |

## Per mettere la ✅ sulla fase 2

- Prova 1 ✅ (fatta, qui sopra).
- Prova 2 ✅ (fatta, qui sopra) **e progetto temporaneo cancellato**.
- **Due notti consecutive** di backup automatico riuscito (verificate con `gh run list --workflow backup-notturno.yml --event schedule`).
- Le **copie offline delle chiavi** confermate dal titolare.
