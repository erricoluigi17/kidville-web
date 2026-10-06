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

## Prova 2 — «Restore to a new project» di Supabase · ⬜ da fare dal titolare

Verifica il **paracadute di Supabase** (i suoi backup fisici), non il nostro: serve a sapere quanto ci mette e se i conteggi
tornano. La creazione del progetto richiede di scegliere una password del database, quindi la fa il titolare.

**Prima di cominciare**

- **Di notte e fuori dalle 08:00–09:00 UTC.** Il progetto ripristinato copia anche `pg_cron` e `pg_net`: **28 job attivi**,
  19 dei quali chiamano l'app di produzione, e `iscrizioni-import-invio` manda email dalle 08:10 UTC.
- **Spegnere `pg_cron` nel progetto nuovo appena è nato**, prima di ogni altra cosa: nell'editor SQL **del progetto
  temporaneo** (mai quello di produzione) `UPDATE cron.job SET active = false;`.
- Non collegare niente al progetto temporaneo: contiene dati di minori.

**Passi.** Pannello Supabase → Database → Backups → «Restore to a new project» → scegliere il backup di ieri → nome
`kidville-prova-ripristino` → stessa regione (UE) → scegliere la password. Cronometrare dalla conferma a «progetto pronto».

**Cosa si registra qui (solo numeri):** minuti di attesa; per le tabelle chiave (`alunni`, `utenti`, `pagamenti`, `incassi`,
`enrollment_submissions`, `auth.users`) le righe nel progetto temporaneo contro la produzione dello stesso giorno (la
differenza attesa è quella dei dati scritti dopo il backup); se i file di Storage ci sono (i backup fisici di Supabase
**non** contengono i file: è proprio il motivo dello specchio su R2).

**Dopo.** Il progetto temporaneo **lo cancella il titolare** dal pannello (Settings → General → Delete project). Chi
esegue una cancellazione di progetto non è mai l'assistente.

| Esito | Valore |
|---|---|
| Data e ora della prova | — |
| Minuti per avere il progetto pronto | — |
| Tabelle chiave: temporaneo / produzione | — |
| `pg_cron` spento entro (minuti dalla nascita) | — |
| Progetto cancellato il | — |

## Per mettere la ✅ sulla fase 2

- Prova 1 ✅ (fatta, qui sopra).
- Prova 2 compilata nella tabella.
- **Due notti consecutive** di backup automatico riuscito (verificate con `gh run list --workflow backup-notturno.yml --event schedule`).
- Le **copie offline delle chiavi** confermate dal titolare.
