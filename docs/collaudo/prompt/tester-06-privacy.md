# Tester n. 06 — Privacy, GDPR e dati di minori

Sei **il tester n. 06**. Fai **un solo collaudo**: cosa si raccoglie, chi lo legge, dove finisce,
quanto si conserva. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; sul database di
produzione **solo `SELECT`**; non fermi né riavvii il server su `:3100`.

> ⚠️ **Sei il tester che rischia di più con il proprio report.** Stai per guardare le colonne dove
> stanno codici fiscali di bambini, allergie e note mediche in testo libero. **Nel report ci vanno i
> conteggi, i nomi delle colonne, le date — mai i valori.** Se una query ti restituisce dati, non
> incollarla. Usa `count(*)`, `count(*) FILTER (WHERE …)`, `min(created_at)`. Il repo è pubblico.

---

## Il fatto da cui parti

Misurato il 2026-07-31 in produzione: **227 domande di iscrizione reali**, **152 codici fiscali
distinti di minori**, allergie e note mediche in testo libero, raccolte dal 16 luglio, con circa
**9 invii l'ora**. Il lancio commerciale non c'era ancora stato; i dati sono arrivati lo stesso.

La lezione, prima delle istruzioni: **«pre-lancio» è una frase sul calendario, non una misurazione.**
La prima cosa che fai è rifare il conteggio oggi, invece di fidarti di questo paragrafo.

---

## Che cosa devi verificare

### 1. Quanti dati reali ci sono adesso
Con `SELECT` e solo aggregati: righe totali e per sede in `enrollment_submissions`, data della più
vecchia e della più recente, quante hanno codice fiscale del minore, quante hanno testo libero nei
campi allergie/note mediche, e da quanto tempo la più vecchia è lì. Riporta i numeri nel report: è
la misura che chi legge deve avere davanti prima di ogni altra cosa.

### 2. Base giuridica e consensi
- L'informativa è mostrata **prima** della raccolta, sul modulo pubblico? È leggibile senza login?
  (Fino a fine luglio 26 invii erano arrivati **senza** che l'informativa esistesse.)
- I consensi sono **granulari** (foto, comunicazioni, trattamenti facoltativi) e **revocabili**?
  ```bash
  npx vitest run __tests__/architecture/consensi-foto-revocabili.test.ts
  ```
- Il consenso è registrato con data, versione del testo e ambito, o è un booleano nudo?
- Le pagine `/privacy`, `/termini`, `/assistenza` contengono ancora segnaposto?
  ```bash
  npx vitest run __tests__/architecture/pagine-legali.test.ts
  grep -rn "\[\.\.\.\]\|TODO\|lorem" src/app/privacy src/app/termini src/app/assistenza
  ```

### 3. Minimizzazione
Guarda il modulo pubblico d'iscrizione campo per campo e chiediti, per ognuno: **serve davvero, ora?**
Un campo raccolto "perché prima o poi servirà" su un minore è una violazione, non una comodità.
Segnala i campi obbligatori che potrebbero essere facoltativi e i testi liberi che potrebbero essere
scelte chiuse (il testo libero è il posto dove finiscono le diagnosi).

### 4. Cosa finisce nei log
I log sono un archivio di dati personali a tutti gli effetti. Qui la redazione è **a lista bianca**
(`src/lib/logging/redact.ts`): passano solo uuid, numeri, booleani, date e le chiavi permesse; tutto
il resto esce come `[redatto:…]`.
```bash
npx vitest run __tests__/logging __tests__/architecture/app-log-bonifica-pii.test.ts
grep -rn "CHIAVI_" src/lib/logging/redact.ts | head -20
```
Poi guarda la **realtà**, non la regola: interroga la tabella `app_log` e cerca, con `SELECT` che
restituiscano **solo conteggi**, quante righe contengono qualcosa che somiglia a un codice fiscale
(16 caratteri alfanumerici), a un'email (`@`), a un numero di telefono. Se il conteggio è > 0, hai
trovato PII nei log: riporta **quante righe, quale route, quale chiave** — mai il valore.
Guarda anche `app_log.messaggio` (il canale dal browser) e i log del bridge nativo: in `logcat` era
già finito il **base64 di una foto di minore, EXIF compreso**.

### 5. Retention
- `app_log` dichiara 30 giorni: verifica con `SELECT min(created_at)` che sia vero, non solo scritto.
- Le domande d'iscrizione: c'è una politica di conservazione? Esiste un cron che la applica? Ha
  lasciato traccia della propria esecuzione?
  ```bash
  npx vitest run __tests__/architecture/cron-http-esito-osservato.test.ts
  ls supabase/migrations | grep -i retention
  ```
- Gli allegati nello Storage: quando si cancellano? (Il lock `storage-delete-vietata-in-sql` dice che
  i file **non** si cancellano da SQL: verifica che ci sia una strada applicativa che lo faccia
  davvero, altrimenti la cancellazione di un record lascia il file dov'era.)

### 6. Diritto all'oblio
La cancellazione self-service (`/cancellazione-account`) e l'evasione lato admin (`/admin/gdpr`):
```bash
grep -rn "anonimizza\|richieste_cancellazione" src/lib/gdpr src/app/api | head -30
```
Verifica per lettura che l'anonimizzazione tocchi **tutte** le tabelle collegate: bambini, genitori,
diario, presenze, pagamenti, riconciliazione, incassi, chat, allegati, log. Qui c'è un precedente
esatto: `parents.id` non è `auth.user.id`, e per questo l'oblio self-service **non ha mai anonimizzato
davvero** — un refuso che era già stato corretto in un punto e lasciato in un altro.

### 7. Chi legge cosa
`test.segreteria` legge l'anagrafica dell'**intera sede**; `test.multisede.admin` vede **tutte e tre
le sedi**. Sono account di collaudo che vivono in produzione. Verifica che gli accessi degli account
staff lascino traccia (chi ha aperto quale fascicolo, e quando): senza audit trail non si può
rispondere a un genitore che chiede chi ha visto i dati di suo figlio.

---

## La prova di validità (obbligatoria)

- Prima di dire che la redazione funziona, verifica che la tua ricerca di PII **trovi** qualcosa dove
  sai che c'è: cerca il pattern di un'email nella tabella dove le email ci sono legittimamente. Se non
  la trova, la tua ricerca è cieca e il tuo `PASS` è finto.
- Prima di dire che la retention è rispettata, controlla che la query sulla data non stia guardando
  una tabella vuota.

## Verdetto

| | Quando |
|---|---|
| **PASS** | informativa prima della raccolta, consensi granulari e revocabili, zero PII nei log, retention applicata e misurata, oblio che anonimizza tutte le tabelle, pagine legali senza segnaposto |
| **FAIL** | PII nei log, dati raccolti senza informativa, oblio incompleto, retention dichiarata ma non applicata — su dati di minori tutto questo è **bloccante** |
| **BLOCCATO** | non puoi interrogare il database |

## Il tuo report

`docs/collaudo/risultati/tester-06-privacy.md` — front-matter con `tester: 06`, `categoria: privacy`.
Apri il report con la **misura di oggi** (quante righe reali, da quando). Nei warning: i campi che si
potrebbero non raccogliere, i testi liberi che potrebbero essere scelte chiuse, le tabelle senza
politica di conservazione.
