# Handoff — chiudere la fatturazione Aruba

> **Per chi apre una chat nuova dedicata SOLO a questo.** Il codice è in produzione (`8bea8bfb`,
> PR #109) e **la lettura del progressivo è stata verificata in presa diretta il 2026-09-03**
> (Passo 1 ✅). Quello che manca è **una sola cosa: emettere una fattura vera**, e la preme una
> persona in segreteria. Tutto ciò che segue è misurato, non dedotto.

---

## 1. Il problema originale, e perché è chiuso a metà

Dalla Contabilità di Kidville Aversa, «Emetti» rispondeva:

> *«Impossibile leggere l'ultimo numero della serie «FPR» da Aruba: la fattura non è stata emessa
> per non rischiare un numero duplicato.»*

**Causa radice, misurata.** `GET /services/invoice/out/findByUsername` restituisce una pagina di
**DOCUMENTI**, e il numero della fattura sta in un array **annidato** dentro ciascuno:

```
json.content[i].invoices[j].number   ===   «Asilo 2327/2026»     ← 100/100 elementi
json.content[i].number               ===   undefined             ← 0/100   (dove leggeva il codice)
```

**NON era** `size`, **non era** `vatcodeSender`: escluso con un esperimento A/B a quattro celle.
**Non era** il rate limit, l'utenza non abilitata, l'ambiente sandbox o un timeout: il log diceva
`signin 200`, `findByUsername 200`, 3.311 documenti ricevuti.

La correzione è in `src/lib/aruba/client.ts` (`etichetteDellElemento`) ed è già in produzione.
⚠️ **Fallisce chiusa**: se sbagliasse ancora, non emette — non emette *male*.

### La forma vera della risposta, campo per campo (misurata)

Busta: `content`, `errorCode`, `errorDescription`, `first`, `last`, **`number`** *(⚠️ è il numero di
PAGINA di Spring Data, non un numero di fattura)*, `numberOfElements`, `size`, `totalElements`,
`totalPages`.

Ogni elemento di `content[]`:

| campo | contenuto |
|---|---|
| `filename` | `IT…xml.p7m` |
| `idSdi` | `17898673698` |
| `docType` · `invoiceType` | `FAT` · `FPR12` |
| `sender` | `{countryCode, description, fiscalCode, vatCode}` — la cooperativa |
| `receiver` | `{countryCode, description, fiscalCode, vatCode}` — **⚠️ un genitore reale** |
| **`invoices[]`** | **`{number, invoiceDate, status, statusDescription}` ← IL NUMERO È QUI** |
| `creationDate` · `lastUpdate` · `pddAvailable` · `signed` · `unsignedFile` · `id` · `username` | metadati |

---

## 2. 🔴 IL LIMITE ARUBA — leggere PRIMA di lanciare qualunque cosa

Questo è il motivo per cui il lavoro non si è chiuso, e ha fatto perdere tre ore.

> ### ⏱️ RIMISURATO IL 2026-09-02 — «~60 richieste all'ora» È IL MODELLO SBAGLIATO
>
> Il Passo 1 è stato eseguito, e ha preso `429`. **Ma non alla prima chiamata**: `signin` è passato,
> l'**intero** scorrimento della serie «Asilo» è passato, e il muro è arrivato sulla **prima pagina
> di «FPR»** — cioè **otto richieste accettate in 4,2 secondi**, e la nona no.
>
> Un tetto orario di sessanta richieste **non spiega** otto chiamate accettate in quattro secondi e
> la nona rifiutata. Quello che si tocca è uno strozzamento sulla **frequenza**, dentro una finestra
> breve. E spiega anche la riga qui sotto che sembrava una stranezza — *un `signin`, +30 s, un
> secondo `signin` → `429`*: non era il secchio quasi pieno, erano **due richieste troppo vicine**.
>
> ⚠️ **La finestra esatta non è nota, e NON è stata cercata a tentativi**: ogni probe consuma quota
> e brucia il tentativo dopo. È la stessa trappola che ha fatto perdere le tre ore. Chi vorrà
> misurarla lo faccia sapendo che costa un'ora per campione.

- **`signin` è strozzato duramente**, forse più delle altre chiamate: un `signin` riuscito, e
  **trenta secondi dopo** un secondo `signin` → `429`. Due login ravvicinati bastano.
- **Anche i tentativi RIFIUTATI consumano.** Dopo cinque tentativi in tre ore il `429` arrivava
  perfino sul `signin`, cioè sulla prima chiamata. **Non è un secchio che si riempie mentre bussi.**
- **Una lettura del progressivo costa 7 pagine** (3.311 documenti ÷ 500 per pagina).
  ✅ **Non più per serie**: dal 2026-09-02 le due serie si leggono in **un passaggio solo**, perché
  la richiesta a `findByUsername` **non contiene il sezionale** — leggerle separatamente scaricava
  due volte le stesse identiche pagine. Il collaudo completo ora costa **1 signin + 7 GET**,
  non 1 + 14.
- Il `429` arriva come **pagina HTML**, non come JSON.

### La regola operativa che ne discende

> **Un solo `signin` per sessione, e non si «prova prima con qualcosa di piccolo».**
> Quella prova costa esattamente quanto quella vera, e brucia la successiva.

Se si vede un `429`: **fermarsi almeno 45-60 minuti senza toccare niente**. Non fare probe di
verifica: le probe sono il problema. (Il codice ritenta **una volta sola**, da sé, dopo un'attesa:
se anche quella prende `429`, si ferma e non insiste.)

---

## 3. Cosa resta da fare, in ordine

### ✅ Passo 1 — la lettura col codice di PRODOTTO — **FATTO il 2026-09-03 alle 00:10**

```bash
COLLAUDO_REALE=1 npx vitest run --config vitest.collaudo.config.ts \
  scripts/collaudo/numerazione-aruba.collaudo.ts
```

**Esito: `Tests 1 passed`.** `arubaUltimoNumeroFattura` ha letto **entrambe le serie dall'API vera**,
ottenendo due progressivi **> 1000** e **diversi fra loro**.

⚠️ **Su QUALE codice, detto con precisione**: il collaudo ha girato sull'albero locale, che a
quell'ora conteneva già `0b3a4380` — la lettura in **un passaggio solo**, non ancora pushata. Quindi
è dimostrato il *parser* (`etichetteDellElemento`, identico nelle due versioni) contro l'API vera,
**nella variante a un passaggio**. La versione in produzione (`8bea8bfb`) ha lo stesso parser ma
scorre le pagine due volte: leggere quella richiede un altro collaudo, oppure — meglio — pushare
`0b3a4380`, che è comunque la versione giusta.

Le tre asserzioni che il passaggio garantisce, e che sono quelle che contano:

- **non è zero** → il pavimento della serie è stato letto davvero (uno zero significherebbe «la serie
  non è mai partita», ed è la frase che fa uscire `FPR 1/26` su millenovecento documenti);
- **è plausibile** (> 1000) → coerente con serie vive da anni;
- **`Asilo` ≠ `FPR`** → le due serie non sono più mescolate in un mucchio solo.

La correzione non è più dimostrata soltanto contro una fixture: è dimostrata **in presa diretta**.

🔴 **I DUE PROGRESSIVI NON SONO ANCORA STATI LETTI DA NESSUNO, E NON ERA COLPA DEL `grep`.**

Questo riquadro prima diceva che il 2026-09-03 un `| grep` si era mangiato le due righe coi numeri.
**Era la spiegazione comoda, ed era sbagliata.** La lettura è stata rifatta alle 07:39 catturando
l'output **integrale su file, senza nessun filtro**: il test è passato di nuovo, e le due righe
**non c'erano lo stesso**.

La causa vera, misurata con un file di prova che stampava le due cose una accanto all'altra:
**vitest intercetta `console.*` e in questa configurazione lo inghiotte**, mentre lascia passare
`process.stdout.write`. Il collaudo usava `console.log`. Quindi quei numeri **non sono mai stati
stampati** — non alle 00:10, non alle 07:39.

**Costo dell'errore: due letture contro l'API vera, entrambe «passate» ed entrambe mute.** La
seconda è stata spesa per riscoprire ciò che la prima aveva già fatto, perché la diagnosi del `grep`
sembrava plausibile e non era stata verificata.

✅ **Corretto**: il collaudo ora scrive con `process.stdout.write`. Al prossimo lancio i numeri si
vedranno. Servono al Passo 3 per controllare che la fattura emessa porti `max + 1`; finché non si
conoscono, di quel controllo resta solo la metà grossolana («se è `1`, fermare tutto»), che
intercetta la collisione grave ma non un errore di un'unità.

⚠️ E resta vero comunque: **non filtrare l'output**. Un valore non stampato è un valore perso —
esiste solo durante la chiamata, e rivederlo costa un'altra finestra da un'ora.

**Lanciarlo come PRIMA cosa della sessione**, senza nessun'altra chiamata ad Aruba prima.

- Se stampa i due numeri → la correzione è dimostrata anche in presa diretta. Si passa al passo 2.
- Se dà `429` → aspettare un'ora **senza altre chiamate** e ripetere. Non c'è scorciatoia.
- Se dà `ArubaNumerazioneError` con l'elenco delle chiavi → Aruba ha cambiato forma di nuovo, e le
  chiavi nel messaggio dicono dove guardare (la correzione del 2026-09-02 le mette apposta nel log).

⚠️ **Questo passo è stato TENTATO il 2026-09-02 e ha preso `429`** — sulla seconda serie, dopo che
la prima era già passata. Da allora il collaudo legge **entrambe le serie in un passaggio solo**
(1 signin + 7 GET, non 1 + 14) e mette una pausa fra le pagine, quindi il tentativo successivo
parte da una configurazione diversa e più leggera di quella che ha fallito. **Non serve più
commentare una delle due chiamate per dimezzare il costo**: il costo è già dimezzato.

Sui numeri attesi: la serie **`Asilo`** era arrivata a leggersi (il valore non è stato stampato
perché il collaudo asseriva prima di stampare — corretto anche quello), quindi il progressivo
`Asilo` **esiste ed è leggibile**. Quello che manca è vederlo, insieme a `FPR`.

### Passo 2 — la fattura vera

⚠️ **Non è automatizzabile e non va aggirata.** Non esiste sandbox per questo account (le credenziali
demo sono un account separato mai richiesto), quindi l'unica prova è emettere davvero. **Il pulsante
lo preme una persona in segreteria**: emettere chiamando la libreria col service-role scavalcherebbe
il gate dell'app, cioè proverebbe una cosa diversa da quella che si vuole provare.

**Il pagamento è già pronto e verificato:**

| | |
|---|---|
| `pagamenti.id` | `85320395-e0f9-4422-bc65-f42ca0006e47` |
| sede | Kidville **Aversa** (`429da920-2c1f-47a8-82ed-a26f63ee0591`) |
| importo | **300,00 €** — già corretto da 330,00 il 2026-09-02 |
| serie attesa | **`FPR`** (bambina nata il 07/12/2023 → compie 3 anni entro il 30 aprile) |
| CF bambina · CF genitore | 16 caratteri entrambi ✓ |
| `intestatario_fatture` | valorizzato ✓ |
| fattura già presente | no ✓ |

Configurazione della sede, verificata: `abilitato: true`, `ambiente: production`, `password_ref`
presente, `fiscale_config` completa (cap · comune · provincia · email · piva · codice_fiscale ·
denominazione · regime_fiscale).

⚠️ **Due cose da guardare prima di premere** — ✅ **RISOLTE il 2026-09-02, e la seconda era scritta
male proprio qui sotto:**

1. ~~`aruba_config.iva` ha **0 righe**~~ → **è la configurazione GIUSTA, non una lacuna.** La chiave
   `iva` è **assente** (non un array vuoto) in tutte e tre le sedi, e il codice tratta i due casi
   allo stesso modo: `emissione.ts:877` non trova la causale, `fatturapa-xml.ts:487` applica il
   default **aliquota 0 · Natura `N4` · «Esente Art. 10 DPR 633/72»**. È esattamente ciò che
   riportano le fatture vere. **Aggiungere una riga a mano è il modo di sbagliare, non di
   correggere.** Dimostrato end-to-end: la fixture di `__tests__/api/fattura-emissione.test.ts:121`
   non ha la chiave `iva` — identica alla produzione — e il test asserisce `<Natura>N4</Natura>`
   sull'XML davvero inviato.

2. 🔴 ~~`bollo_abilitato` non è impostato (`null`)~~ → **quella chiave NON ESISTE.** Cercata in tutto
   il repo il 2026-09-02: **zero occorrenze** in `src/`, `__tests__/`, `supabase/`. L'unica
   occorrenza in tutto l'albero era **questa riga dell'handoff**, che quindi mandava a controllare
   un interruttore immaginario.

   La chiave vera è **`fiscale_config.bollo_enabled`**, letta da `src/lib/pagamenti/fiscale.ts:97`
   (`if (!cfg?.bollo_enabled) return 0`). In produzione è **assente in tutte e tre le sedi** —
   quindi *non impostato ⇒ spento ⇒ nessun `<DatiBollo>`*: la fattura da 300 € oggi **uscirebbe
   senza bollo**. Non è un `null` ambiguo: è spento.

   L'interruttore c'è nel pannello (`SettingsPanel.tsx:350`), è per **sede**, e acceso funziona in
   entrambi i rami (test su e giù, non un mock piatto). ⚠️ Ma tocca anche le **ricevute**
   (`ricevute.ts:118` e `:295`): è lo stesso interruttore, non se ne può accendere metà. E il bollo
   **non viene riaddebitato** al genitore — il totale resta 300,00 € e i 2 € restano alla
   cooperativa.

   **Resta una domanda per il commercialista, e ora è ben posta:** *la cooperativa deve applicare la
   marca da bollo virtuale da 2 € sulle fatture elettroniche esenti Art. 10 sopra 77,47 €?* Elemento
   utile per rispondere: le fatture che la segreteria emette **a mano** dal pannello Aruba **non
   riportano il bollo** (letto su due documenti veri il 2026-08-10). Se la risposta è NO,
   l'interruttore resta spento e non si tocca niente.

### Passo 3 — verificare che il numero sia quello giusto

Subito dopo l'emissione:

```sql
SELECT sezionale, anno, ultimo_numero, aggiornato_il
FROM fatture_numerazione_sezionale ORDER BY anno DESC, sezionale;

SELECT sezionale, numero, anno, progressivo_invio, sdi_stato, sdi_stato_label, aruba_filename
FROM fatture_emesse ORDER BY creato_il DESC LIMIT 3;
```

Il numero allocato dev'essere **`max(letto da Aruba) + 1`** per `FPR` 2026. Se fosse `1`, **fermare
tutto**: significa che il pavimento è stato letto come zero, ed è la collisione fiscale che tutto
questo lavoro esiste per impedire.

E il log applicativo, che racconta l'esito senza doverlo indovinare:

```sql
SELECT creato_il, livello, left(messaggio,200) AS messaggio,
       contesto->'campi'->>'operazione' AS operazione, contesto->'campi'->>'esito' AS esito
FROM app_log WHERE evento='fattura' AND creato_il > now() - interval '1 hour'
ORDER BY creato_il DESC;
```

---

## 4. Strumenti già pronti nel repo

| file | a cosa serve |
|---|---|
| `scripts/collaudo/numerazione-aruba.collaudo.ts` | il codice di **prodotto** contro l'API vera, sola lettura |
| `scripts/aruba-forma-elenco.mjs` | la **forma** della risposta: A/B a 4 celle, stampa solo i NOMI delle chiavi |
| `scripts/aruba-prova-collegamento.mjs` | signin + una chiamata operativa (un account non abilitato supera il login e fallisce dopo) |
| `scripts/aruba-campioni.mjs` | scarica campioni veri — `--out` **fuori dal repo**, che è pubblico |

⚠️ **Ognuno di questi fa il proprio `signin`.** Lanciarne due di seguito significa `429` sul secondo.

---

## 5. Cosa NON va toccato, e perché

- **La severità di `arubaUltimoNumeroFattura`.** Se non riesce a leggere, **lancia**: non degrada al
  contatore interno, che per una serie nata sul gestionale di Aruba vale **zero**. Il 2026-09-02
  quella severità ha fermato un'emissione e ha permesso di trovare il difetto in due minuti. Un
  degrado «gentile» qui produce un numero di fattura già usato, cioè un illecito fiscale.
- **La lettura una volta per LOTTO** (`TTL_ULTIMO_NUMERO_MS`, 5 minuti). Una rilettura per fattura
  strozzerebbe un'emissione massiva a metà, lasciando la segreteria con metà delle rette fatturate.
  ⚠️ **Il TTL da solo non bastava, e il 2026-09-02 si è visto perché**: la cache è per *serie*
  (`chiaveSerieAruba`), quindi un lotto con dentro sia un bambino del nido sia uno della fascia FPR
  faceva **due** scorrimenti completi in rapida successione — quattordici richieste — che è
  esattamente la raffica che Aruba rifiuta. Ora le serie si leggono in un passaggio solo; se un
  giorno le serie diventassero tre, si continui a leggerle **insieme**, mai una alla volta.
- **I mock dei test.** Fino al 2026-09-02 costruivano la risposta come `{invoices:[{number}]}`, cioè
  **assumevano la forma che avrebbero dovuto dimostrare**, e sono rimasti verdi mentre in produzione
  non si leggeva niente. Le fixture nuove riproducono la forma **misurata**: se si toccano, si toccano
  dopo aver rimisurato, non prima.

## 6. Riferimenti

- `docs/fatturazione/tracciato-di-riferimento.md` — il tracciato XML campo per campo
- PRD, changelog **2026-09-02** «La fattura cercava il proprio numero dove non c'era»
- `src/lib/aruba/client.ts` → `etichetteDellElemento` (la testata spiega la forma e il perché)
- `src/lib/aruba/emissione.ts` → i cinque messaggi d'errore distinti per `code`
