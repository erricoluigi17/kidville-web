# Handoff — chiudere la fatturazione Aruba

> **Per chi apre una chat nuova dedicata SOLO a questo.** Il parser del numero è in produzione
> (`8bea8bfb`, PR #109) e **la lettura del progressivo è stata verificata in presa diretta il
> 2026-09-03** (Passo 1 ✅, ma sull'albero locale: vedi il riquadro nel Passo 1). Mancano **due**
> cose, in quest'ordine: **mergiare il branch `fix/aruba-emissione-reale`** — che porta il ritmo
> delle chiamate, il ritentativo dell'upload e la distinzione fra rifiuto di trasporto e scarto
> fiscale — e poi **emettere una fattura vera**, che preme il titolare dall'app. Tutto ciò che segue
> è misurato, non dedotto.
>
> 👉 **Comincia dalla §0**: è del 2026-09-03 e **supera** le sezioni successive dove divergono.

---

## 0. Stato al 2026-09-03 — le decisioni, il ritmo, e come si preme

Questa sezione è stata scritta il 2026-09-03 sul branch `fix/aruba-emissione-reale`. La
configurazione con cui il software parla con Aruba è stata misurata voce per voce nel referto
[`configurazione-aruba.md`](configurazione-aruba.md), che è la **fonte** di ogni numero qui sotto.

### 0.1 Le quattro decisioni del titolare

1. **Si emette sul pagamento da 300,00 €**, con lo **sconto residuo azzerato** — erano 30 € di
   «SCONTO FRATELLI», azzerati il 2026-09-03 alle 09:35, unica scrittura di quella giornata. In
   fattura va l'importo effettivamente incassato: **300,00 €**.
2. **Bollo spento**, come le fatture che la segreteria emette a mano dal pannello Aruba:
   `fiscale_config.bollo_enabled` è **assente** su tutte e tre le sedi, quindi nessun `<DatiBollo>`
   entra nel documento. Resta la domanda per il commercialista (§3, Passo 2), ma **oggi non si
   accende niente**.
3. **«Emetti» lo preme il titolare dall'app.** Non un agente e non uno script col service-role:
   quella strada scavalcherebbe il gate di ruolo, cioè proverebbe una cosa diversa da quella che si
   vuole provare.
4. **Prima si merge**: branch → PR → merge → deploy, e **solo dopo** si preme. Il ritmo e i
   ritentativi di §0.3 **non esistono in produzione** finché il merge non è fatto.

### 0.2 I limiti che Aruba documenta

| Limite | Valore documentato | Fonte |
|---|---|---|
| Autenticazione (`POST /auth/signin`) | **1 richiesta al minuto per IP** | SLA §3 |
| Ricerca fatture inviate (`findByUsername`) | **12 al minuto per IP** | SLA §3 |
| Upload (`upload` / `uploadSigned`) | **30 al minuto per IP** | SLA §3 |
| Volume degli upload | **Tier 0: 60 all'ora**, 10.000 all'anno — contano **solo gli upload riusciti**, quelli che generano un `uploadFileName` | Tiering §7.3 |
| Come è fatto | **leaky bucket** sulla frequenza + **TTL di un'ora** sulle chiavi di tracciamento: «Ogni singolo tentativo effettua un touch che resetta il timer del TTL a 1 ora»; l'eccedenza è rifiutata subito con `429`, «il sistema non accoda», e il retry «è interamente a carico dell'integratore» | Tiering §7.3.2 («non accoda», retry) e §7.3.3 scenario 3 (il «touch» che azzera il TTL) |

Pagina: `https://fatturazioneelettronica.aruba.it/apidoc/docs.html` (v1, riletta il 2026-09-03).

⚠️ **Il «~60 richieste all'ora» ripetuto in questo repo era il tier degli UPLOAD**, non delle
ricerche: modello giusto, cosa sbagliata. E **anche i tentativi rifiutati contano**, perché ognuno
azzera il TTL: bussare più forte allunga l'attesa.

### 0.3 Le nove richieste di una emissione, e cosa cambia il branch

| # | Chiamata | Note |
|---|---|---|
| 1 | `POST /auth/signin` | il token vive dentro l'invocazione: ogni «Emetti» ne fa uno nuovo |
| 2…8 | `GET …/findByUsername` × **7** | 3.311 documenti del 2026 ÷ 500 per pagina; una volta per lotto (cache 5′) |
| 9 | `POST …/invoice/upload` | l'unica che emette — ed è **il numero d'ordine su cui il 2026-09-02 è arrivato il `429`** |

Cosa porta il branch `fix/aruba-emissione-reale`, e serve tutto per questa emissione:

- **`PAUSA_FRA_PAGINE_MS` da 1.100 a 5.000 ms** — 12 ricerche/minuto significano **una ogni 5
  secondi**. Una lettura completa costa ≈ **36 s** (sei attese da 5 s più i ~6 s di risposte
  misurati), una volta per lotto.
- **Una pausa di 5 s prima dell'upload**, e solo se in quella invocazione il pavimento è stato letto
  **dal vivo**; se viene dalla cache, nessuna pausa.
- **`arubaUpload` ritenta UNA volta sul `429`**, dopo 90 s, con log `warn` `esito:
  'limite-richieste'`. Nessun altro errore viene ritentato: un `0034`, un `0092`, un `0094` non si
  ripetono mai.
- **Rifiuto di TRASPORTO ≠ scarto fiscale.** Un `429`, un `401`, un `5xx`, un corpo non-JSON o
  un'eccezione (timeout compreso) non finiscono più a registro come scarto «Errore upload» col blob
  HTML dentro `sdi_scarto_motivo` — su una tabella **WORM** dove il `DELETE` è vietato. La riga si
  scrive lo stesso, perché **il numero è consumato**, ma con etichetta **«Trasporto fallito»** e
  motivo breve `TRASPORTO <status>: esito ignoto, verificare sul pannello Aruba prima di ripremere`,
  tagliato a 200 caratteri. Log `error` con `esito: 'upload-trasporto'` (o `upload-esito-ignoto` per
  un'eccezione), e alla segreteria arriva un messaggio che dice **di non ripremere** prima di aver
  controllato su Aruba. `<status>` ha **quattro** forme, e la seconda è l'unica che dice
  «probabilmente partita»:
  - `HTTP 429`, `HTTP 401`, `HTTP 503`… — Aruba ha risposto con uno status non-2xx;
  - **`0034 dopo un 429`**, senza il prefisso `HTTP` perché non è uno status: il ritentativo dopo un
    `429` ha ricevuto `0034` «File già inviato di recente», e questo dice che il **primo** invio era
    stato ricevuto — la fattura è **molto probabilmente su Aruba**. A dirlo è il campo
    `dopoRitentativo` dell'esito, alzato **soltanto** dal ramo `ritentato && errorCode === '0034'`
    di `src/lib/aruba/client.ts:555-566`, e **non** il solo `errorCode`: un HTTP non-2xx col corpo
    `{"errorCode":"0034",…}` e nessun `429` di mezzo arriva identico ed è un rifiuto di trasporto
    ordinario, da raccontare col suo status. Il motivo e il messaggio li compongono le costanti
    `quale` e `detto` di `src/lib/aruba/emissione.ts:1410-1417`;
  - `HTTP <2xx> illeggibile` — un `2xx` col corpo che non si riesce a leggere: un motivo scritto
    `TRASPORTO 200: esito ignoto` metterebbe un `200` dentro un motivo di **fallimento**, e chi
    legge lo associa a un successo;
  - il `code` dell'eccezione, oppure `ignoto`, quando una risposta non c'è stata affatto (rete giù,
    DNS, TLS, timeout) — e anche quando a lanciare è il **signin** fatto subito prima dell'upload
    (pavimento in cache): lì il `code` è lo status di Aruba (`429`, `401`), l'upload non è mai
    partito, ma la riga a registro dice comunque «esito ignoto» — è il verso prudente in cui sbagliare,
    e il numero è consumato lo stesso.
- **`export const maxDuration = 300`** sulla route: signin + **6 pause** da 5 s fra le 7 pagine (30 s)
  + la pausa da 5 s prima dell'upload + upload + un eventuale 90 s dopo un `429` ≈ **125 s di sola
  attesa**, più le risposte — sotto il tetto dichiarato, con margine. (Non è il massimo teorico: anche
  la lettura ritenta una volta dopo un `429`, e ogni pagina sfortunata aggiunge 90 s; ma un
  troncamento in lettura cade PRIMA dell'allocazione del numero e non costa niente.)

### 0.4 Il pagamento pronto (riverificato con `SELECT` il 2026-09-03)

| | |
|---|---|
| `pagamenti.id` | `85320395-e0f9-4422-bc65-f42ca0006e47` |
| sede | Kidville **Aversa** |
| importo · pagato · **sconto** | `300.00` · `300.00` · **`0`** (sconto residuo azzerato) |
| `stato` · `fattura_stato` | `pagato` · `scartata` — l'aggregato lasciato dal tentativo fallito del 2026-09-02: **a registro non c'è nessuna riga**, quindi il pulsante mostra «Riprova fattura» e chiama la stessa route |
| serie attesa | **`FPR`** |
| `fatture_emesse` · `fatture_numerazione_sezionale` | **0 righe** e **0 righe**: nessuna fattura è mai partita da questo software |
| fatture in volo (`sdi_stato` 1·3·5) | **0** ⇒ il cron `fatture-sdi-sync` **non fa signin** finché non esiste la prima fattura |

### 0.5 Come si preme

1. **L'attesa è già stata fatta: l'ultima chiamata ad Aruba è del 2026-09-03 alle 12:32:22.** È il
   collaudo della numerazione (§3, Passo 1), costato **1 signin + 7 GET**, **nessun `429`**. Il TTL
   delle chiavi di tracciamento è di un'ora e **ogni tentativo lo azzera**: da quelle 12:32 i 60
   minuti sono **scaduti alle 13:32**, e da lì in poi «Emetti» si può premere.
   🔴 **NON rilanciare il collaudo della numerazione prima di premere «Emetti».** Costerebbe un
   altro `1 signin + 7 GET` e azzererebbe il TTL di un'ora: rimanderebbe l'emissione di un'altra ora
   senza aggiungere niente, perché i due progressivi li ha **già stampati** — `Asilo 2026 = 2327`,
   `FPR 2026 = 1946` (§3, Passo 1).
2. `https://app.kidville.it` → accesso della Direzione → **selettore sede su Kidville Aversa** →
   **Contabilità** (`/admin/pagamenti`) → il pagamento da 300,00 €, stato `pagato`.
3. Il pulsante dice **«Riprova fattura»** (perché `fattura_stato` è `scartata`). Premendolo si apre
   il modale **«Emetti fattura»** con la causale già compilata: si controlla il testo e si preme
   **«Emetti»** — **una volta sola**.
4. **Attendere ~40-45 secondi senza ricaricare la pagina e senza ripremere**: il giro fa un signin,
   sette pagine distanziate di 5 secondi, una pausa di 5 secondi e poi l'upload.
5. **Se compare un errore: copiare il messaggio esatto e fermarsi.** Il messaggio arriva come
   finestrella del browser (`alert`) e, per un rifiuto di **trasporto**, è testualmente quello di
   `messaggioTrasporto()` (`src/lib/aruba/emissione.ts:291-297`, chiamato a `:952`, `:1384` e
   `:1455`):

   > *«Aruba non ha concluso l’invio della fattura FPR 1947/26 (HTTP 429) e non sappiamo se il
   > documento sia partito. Il numero è comunque stato consumato. NON ripremere «Emetti»: controlla
   > prima sul pannello Aruba se la fattura risulta trasmessa.»*

   Fra parentesi c'è il rifiuto che è arrivato, nelle quattro forme di §0.3: `HTTP 429`, `HTTP 401`,
   `HTTP 503`… quando Aruba ha risposto con uno status non-2xx; **`0034 dopo un 429`** — senza
   `HTTP`, perché non è uno status — quando il ritentativo dopo un `429` ha ricevuto `0034` «File
   già inviato di recente», e allora il **primo** invio era stato ricevuto: la fattura è **molto
   probabilmente su Aruba**, ed è l'unico caso in cui il messaggio dice «probabilmente partita»;
   `HTTP <2xx> illeggibile` per un `2xx` col corpo che non si riesce a leggere; il `code`
   dell'eccezione (o `ignoto`) quando una risposta non c'è stata affatto.
   ⚠️ Le parole **«Trasporto fallito» non compaiono nell'alert di QUESTO errore**: sono l'etichetta
   della riga a registro (`sdi_stato_label`, query 2 di §0.6), e a video compaiono solo nell'alert del
   **409** del punto 6, quando si ripreme. Qui il caso si riconosce dalla frase «non sappiamo se il
   documento sia partito».

   **L'altro `429` che si può vedere** è quello della **lettura del progressivo** (prima
   dell'allocazione del numero, dopo il ritentativo interno): l'alert dice *«Aruba ha risposto
   «troppe richieste» (limite di 12 ricerche e 1 accesso al minuto). La fattura non è stata emessa e
   nessun numero è stato consumato. Aspetta almeno un'ora senza ripremere, poi riprova.»* — ed è
   esattamente così: nessun numero consumato, nessuna riga a registro, si aspetta un'ora.
6. **Dopo quell'errore il pulsante torna a dire «Riprova fattura» — e NON va premuto.** Non è un
   invito, è un ripiego: la risposta d'errore della route **non porta** `fattura_stato` (il blocco
   `if (!esito.ok)` di `src/app/api/pagamenti/fattura/route.ts:130-135` restituisce solo `error` e
   `data.motivo`) e `FatturaButton.tsx:88` ricade sul valore di scorta `'scartata'`, che è appunto
   l'etichetta «Riprova fattura». Cosa succede davvero premendolo, detto per intero:

   - **nessun secondo documento parte allo SdI.** La riga di trasporto ha `sdi_stato` **`null`** *e*
     `aruba_filename` **`null`**, e il ramo dell'idempotenza dentro `emettiFatturaPagamento` la
     riconosce da **quelle due colonne insieme** (`src/lib/aruba/emissione.ts:903-958`): non
     riemette;
   - **la route risponde `409`** — non `200`, non `502` — e a schermo compare l'`alert` con,
     testualmente, `messaggioTrasporto(numeroFattura, 'esito ignoto')` seguito dalle due vie
     d'uscita:

     > *«Aruba non ha concluso l’invio della fattura FPR 1947 (esito ignoto) e non sappiamo se il
     > documento sia partito. Il numero è comunque stato consumato. NON ripremere «Emetti»:
     > controlla prima sul pannello Aruba se la fattura risulta trasmessa. Se sul pannello Aruba la
     > fattura NON risulta, la riga «Trasporto fallito» a registro va chiusa a mano (sdi_stato = 2)
     > prima di riemettere; se risulta, va completata con il nome file (aruba_filename) e
     > sdi_stato = 1, così la sincronizzazione la riprende.»*

     ⚠️ Qui il numero è scritto **«FPR 1947»**, senza il `/26` che compare nel messaggio del punto 5:
     questo lo compone la riga già a registro (`${gia.sezionale} ${gia.numero}`), non l'XML. È lo
     stesso documento;
   - **il pagamento RESTA `scartata`** — nessun «In attesa SDI». L'esito della quota è `ok: false`,
     quindi `okEsiti` resta vuoto e l'aggregato scrive `fattura_stato: 'scartata'`
     (`src/lib/aruba/emissione.ts:1575-1580`). E in `app_log` compare un `warn` con
     `operazione: 'emettiFatturaPagamento:idempotenza'` ed `esito: 'trasporto-in-sospeso'`
     (`:927-928`): «quante volte si è ripremuto su una fattura dall'esito ignoto» diventa una query;
   - **il test che lo fissa** si chiama «la riga di trasporto NON lascia partire un secondo documento
     allo SdI» (`__tests__/lib/aruba/emissione-upload-trasporto.test.ts:313-370`): asserisce
     `httpStatus` **409**, nessun `in_attesa` fra gli `update` su `pagamenti`, e la riga di log
     `trasporto-in-sospeso`.

   Quindi si va a vedere sul **pannello Aruba** se la fattura risulta trasmessa, **prima** di
   qualunque altro tentativo. Poi la riga si chiude **a mano**, e le vie d'uscita sono due — le
   stesse che il messaggio dice: se sul pannello la fattura **non** risulta, `sdi_stato = 2` sulla
   riga «Trasporto fallito», che la libera per una riemissione; se **risulta**, `aruba_filename` col
   nome file di Aruba **e** `sdi_stato = 1`. Solo il secondo caso la rimette in carico al cron:
   `fatture-sdi-sync` legge `sdi_stato in (1, 3, 5)` (`STATI_IN_VOLO`,
   `src/app/api/pagamenti/fattura/sync/route.ts:22`) **e** `aruba_filename not null` (`:95-96`),
   quindi senza entrambe le colonne la riga resta ferma finché non la si guarda.
7. Se è andata bene, la riga passa a **«In attesa SDI»** — quella vera, con `fattura_aruba_id`
   **valorizzato** (query 3 di §0.6): da lì in poi lavora il cron ogni 30 minuti, e si controlla
   con le query di §0.6.

⚠️ **Dopo la prima emissione** esisterà una fattura in volo, quindi il cron `fatture-sdi-sync` farà
un **proprio signin a ogni tick** (:00 e :30) con la stessa utenza. Un secondo «Emetti» premuto nello
stesso minuto di un tick può incontrare il limite di **1 autenticazione al minuto**: se serve un
secondo tentativo, lo si dà lontano dai due minuti tondi.

### 0.6 Le quattro query di verifica, subito dopo

```sql
-- 1) NUMERAZIONE — dev'essere 1947 (= 1946 letto da Aruba alle 12:32 del 03/09, più uno)
SELECT sezionale, anno, ultimo_numero, aggiornato_il
FROM fatture_numerazione_sezionale ORDER BY anno DESC, sezionale;

-- 2) REGISTRO — la riga appena scritta
SELECT sezionale, numero, anno, progressivo_invio, sdi_stato, sdi_stato_label,
       aruba_filename, left(coalesce(sdi_scarto_motivo, ''), 120) AS motivo, pdf_path, creato_il
FROM fatture_emesse ORDER BY creato_il DESC LIMIT 3;

-- 3) PAGAMENTO — l'aggregato lato contabilità
SELECT id, stato, fattura_stato, fattura_aruba_id, fattura_emessa_il, fattura_pdf_path
FROM pagamenti WHERE id = '85320395-e0f9-4422-bc65-f42ca0006e47';

-- 4) LOG — l'esito raccontato, senza doverlo indovinare.
--    `occorrenze` NON è un di più: app_log deduplica per (fingerprint, giorno), quindi le sette
--    letture di pagina stanno in UNA riga con occorrenze = 7. Il filtro è su `visto_l_ultima`
--    perché `creato_il` resta quello della PRIMA occorrenza della giornata.
SELECT creato_il, visto_l_ultima, occorrenze, livello, left(messaggio, 200) AS messaggio,
       contesto->'campi'->>'operazione' AS operazione,
       contesto->'campi'->>'esito'      AS esito
FROM app_log WHERE evento = 'fattura' AND visto_l_ultima > now() - interval '2 hours'
ORDER BY visto_l_ultima DESC;
```

**Cosa deve rispondere:**

| Query | Valore atteso | Se invece… |
|---|---|---|
| **1** numerazione | **una** riga con `sezionale` = `FPR`, `anno` = `2026` e `ultimo_numero` = **1947** — cioè M + 1, dove M = **1946** è il massimo `FPR` letto da Aruba alle 12:32 del 2026-09-03. A registro (query 2) il `numero` è **1947**, e il documento si chiama **«FPR 1947/26»** | **`ultimo_numero` = 1 ⇒ FERMARE TUTTO**: il pavimento è stato letto come zero, ed è la collisione fiscale che tutto questo lavoro esiste per impedire. **`ultimo_numero` ≠ 1947** (per esempio 1948 o più) ⇒ **fermarsi comunque**: vuol dire che qualcuno ha emesso dal pannello Aruba dopo le 12:32, e la cosa va controllata **su Aruba** prima di qualunque altro passo |
| **2** registro | **una** riga, `sdi_stato` **1** «Presa in carico», `aruba_filename` valorizzato, `motivo` vuoto, `numero` **1947**, `progressivo_invio` **`F26001947`**. Dopo un tick del cron (ogni 30′): **3** «Inviata», poi **7** «Consegnata» (o **6** «Recapito impossibile», che il codice tratta comunque come `emessa` — `src/lib/aruba/stato.ts:27-31`. Gli stati **8** «Accettata» e **10** «Decorrenza termini» sono esiti del ciclo **PA**: su una `FPR12` intestata a un consumatore non arrivano, e aspettarli manderebbe a cercare un guasto che non c'è); `pdf_path` = `85320395-e0f9-4422-bc65-f42ca0006e47-1947.pdf` nel bucket **`fatture`**, scritto dal cron sugli stati non di scarto | `sdi_stato_label` = **«Trasporto fallito»** ⇒ il documento **potrebbe essere partito**: si controlla sul pannello Aruba e **non si ripreme**. Quella riga ha `sdi_stato` **`null`**, quindi **il cron non la ripesca** (interroga solo gli stati 1·3·5): la verifica è a mano, e il motivo breve nella colonna dice quale rifiuto è stato. `sdi_stato` **2 / 4 / 9** ⇒ scarto vero: il motivo è nella colonna, si corregge e si riemette |
| **3** pagamento | `fattura_stato` passa da `scartata` a **`in_attesa`** **con `fattura_aruba_id` valorizzato** (il nome file di Aruba) e `fattura_emessa_il` pieno; dopo il cron diventa `emessa` (o torna `scartata` su uno scarto SdI) | Tre letture diverse, da non confondere. **(a)** `scartata` **più** una riga a registro etichettata «Trasporto fallito» con `sdi_stato` `null` ⇒ è l'esito **ATTESO** di un rifiuto di trasporto — l'aggregato di fondo scrive `fattura_stato: 'scartata'` quando nessuna quota è riuscita (`src/lib/aruba/emissione.ts:1575-1580`) — **non** un guasto dell'aggregato: si legge la riga 2 e si va sul pannello Aruba, non si «riallinea a mano» un documento che potrebbe non essere mai partito. **(b)** `scartata` più una riga con `sdi_stato` **1** e `aruba_filename` valorizzato ⇒ l'aggregato **non** si è aggiornato: è il caso che i log di `segnalaStatoNonAggiornato` raccontano. **(c)** `in_attesa` con `fattura_aruba_id` **`NULL`** ⇒ **dal 2026-09-03 non dovrebbe più prodursi**: ripremere «Emetti» su una riga «Trasporto fallito» risponde **409** e lascia il pagamento `scartata` (§0.5, punto 6). Se compare lo stesso è un **guasto nuovo, da segnalare** — e intanto nessun cron lo ripescherà, perché `fatture-sdi-sync` filtra anche `aruba_filename not null` |
| **4** log | un `info` `esito: 'inviata'` con «fattura FPR 1947/26 inviata ad Aruba: `<nome file>`». Accanto, **una** riga `aruba:signin` con `occorrenze` = **1** e **una** riga `aruba:findByUsername` con `occorrenze` = **7** (8 se una pagina è stata ritentata), entrambe `info` — **non sette righe distinte**: `app_log` deduplica per `(fingerprint, giorno)` e tiene il conto in `occorrenze`. ⚠️ `occorrenze` = **1** su `aruba:signin` vale **subito dopo** l'emissione e basta: da quel momento esiste una fattura in volo, e il cron `fatture-sdi-sync` fa il **proprio** signin a ogni tick (:00 e :30) con la stessa `operazione`. Alla rilettura dopo 30-60 minuti (nota qui sotto) il valore sarà **2-3**, e non è un'anomalia | un `warn` `esito: 'limite-richieste'` dice che il `429` c'è stato ed è stato ritentato; un `error` `esito: 'upload-trasporto'` o `'upload-esito-ignoto'` dice che **non si sa** se la fattura sia partita; un `warn` `esito: 'trasporto-in-sospeso'` (operazione `emettiFatturaPagamento:idempotenza`) dice che qualcuno ha **ripremuto** su una riga «Trasporto fallito»: **niente è partito**, la route ha risposto **409** e il pagamento è rimasto `scartata` |

⚠️ Le prime tre query si scrivono **subito**; la seconda e la terza si **rileggono dopo 30-60
minuti**, quando il cron ha girato.

⚠️ **`app_log` deduplica per `(fingerprint, giorno)`, e questo cambia come si legge la query 4.**
Sette letture di pagina non fanno sette righe: fanno **una** riga con `occorrenze` = 7. Il `contesto`
e `creato_il` restano quelli della **prima** occorrenza della giornata — per questo la query filtra
su `visto_l_ultima`. *Misurato in produzione il 2026-09-02: due signin e quattordici
`findByUsername` hanno prodotto **due** righe, con `occorrenze` 2 e 14.* Una sola riga
`aruba:findByUsername` **non** significa che sei pagine non siano state lette: significa che il
conteggio sta nella colonna accanto.

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

🔄 **Aggiornamento del 2026-09-03 (§0.2 e §0.3).** Il limite ora ha un numero documentato, non solo
un'osservazione: **12 ricerche al minuto per IP**, cioè **una ogni 5 secondi** — ed è il valore a cui
è stata portata la pausa fra le pagine (era 1,1 s, che con i tempi di risposta faceva ancora ~33
richieste al minuto). Il ritentativo unico dopo un `429` vale ora **anche per l'upload**, che prima
non ne aveva nessuno; e i tentativi rifiutati **consumano** perché ogni tentativo azzera il TTL di
un'ora sulle chiavi di tracciamento (Tiering §7.3.2): l'attesa di 45-60 minuti qui sopra non è
scaramanzia, è quel TTL.

---

## 3. Cosa resta da fare, in ordine

### ✅ Passo 1 — la lettura col codice di PRODOTTO — **FATTO il 2026-09-03** (00:10 muto · 12:32 coi numeri: Asilo 2327 · FPR 1946)

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
scorre le pagine due volte: leggere quella richiede un altro collaudo, oppure — meglio — **mergiare
il branch**, che è comunque la versione giusta. 🔄 **Dal 2026-09-03 quel branch è
`fix/aruba-emissione-reale`**: contiene `0b3a4380` (la lettura in un passaggio) e in più il ritmo a
5 s, il ritentativo dell'upload e la distinzione fra rifiuto di trasporto e scarto fiscale (§0.3).
È la decisione 4 del titolare: **prima il merge, poi si preme**.

Le tre asserzioni che il passaggio garantisce, e che sono quelle che contano:

- **non è zero** → il pavimento della serie è stato letto davvero (uno zero significherebbe «la serie
  non è mai partita», ed è la frase che fa uscire `FPR 1/26` su millenovecento documenti);
- **è plausibile** (> 1000) → coerente con serie vive da anni;
- **`Asilo` ≠ `FPR`** → le due serie non sono più mescolate in un mucchio solo.

La correzione non è più dimostrata soltanto contro una fixture: è dimostrata **in presa diretta**.

✅ **LETTI il 2026-09-03, dalle 12:32:11 alle 12:32:22** — `Asilo 2026 = 2327` · `FPR 2026 = 1946`,
stampati sul serio, in 1 signin + 7 GET, `Tests 1 passed`, nessun `429`. Il collaudo ora scrive con
`process.stdout.write`, ed è ciò che ha fatto la differenza. *(Il log integrale sta nello scratchpad
di quella sessione, non nel repo: qui restano solo i due interi, che numeri di fattura sono e dati
personali non sono.)* I due valori coincidono con i documenti campione letti il 2026-08-10
(«Asilo 2327/2026», «FPR 1946/26»): dal 10 agosto la segreteria non ha emesso altro dal pannello.
👉 Il numero atteso per la fattura di oggi è quindi **«FPR 1947/26»**, e §0.6 lo pretende esatto.

Il riquadro che segue è **storia**, e vale la pena tenerla: racconta perché quei due numeri, prima
del 2026-09-03, non li aveva visti nessuno pur avendo speso due letture contro l'API vera.

🔴 ~~**I DUE PROGRESSIVI NON SONO ANCORA STATI LETTI DA NESSUNO**~~, **E NON ERA COLPA DEL `grep`.**

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

✅ **Corretto**: il collaudo scrive con `process.stdout.write`, e al lancio delle 12:32 del
2026-09-03 i numeri si sono visti. Servono al Passo 3 per controllare che la fattura emessa porti
`max + 1`: ora che si conoscono, quel controllo non è più la sola metà grossolana («se è `1`,
fermare tutto») ma il valore esatto — **`ultimo_numero` deve essere 1947** (§0.6, query 1).

🔄 **Quella lettura è l'ULTIMA chiamata ad Aruba della giornata**, e da lì partono i 60 minuti di
distanza da rispettare prima di premere «Emetti»: **scaduti alle 13:32** (§0.5, punto 1).
🔴 **NON rilanciare il collaudo oggi**: un secondo giro costerebbe altre otto richieste, azzererebbe
il TTL di un'ora e rimanderebbe l'emissione — per rileggere due numeri già scritti qui sopra. Il
collaudo del documento (§0.3, `PAGAMENTO_ID`) è un'altra cosa e non entra in questo conto: genera
l'XML **in memoria** e non chiama Aruba, quindi si può lanciare quando si vuole.

⚠️ E resta vero comunque: **non filtrare l'output**. Un valore non stampato è un valore perso —
esiste solo durante la chiamata, e rivederlo costa un'altra finestra da un'ora.

**Lanciarlo come PRIMA cosa della sessione**, senza nessun'altra chiamata ad Aruba prima — istruzione
per una sessione **futura**: il 2026-09-03 è già stato lanciato (12:32), e oggi non si rilancia.

- Se stampa i due numeri → la correzione è dimostrata anche in presa diretta. Si passa al passo 2.
- Se dà `429` → aspettare un'ora **senza altre chiamate** e ripetere. Non c'è scorciatoia.
- Se dà `ArubaNumerazioneError` con l'elenco delle chiavi → Aruba ha cambiato forma di nuovo, e le
  chiavi nel messaggio dicono dove guardare (la correzione del 2026-09-02 le mette apposta nel log).

⚠️ **Questo passo è stato TENTATO il 2026-09-02 e ha preso `429`** — sulla seconda serie, dopo che
la prima era già passata. Da allora il collaudo legge **entrambe le serie in un passaggio solo**
(1 signin + 7 GET, non 1 + 14) e mette una pausa fra le pagine, quindi il tentativo successivo
parte da una configurazione diversa e più leggera di quella che ha fallito. **Non serve più
commentare una delle due chiamate per dimezzare il costo**: il costo è già dimezzato.

🔄 **E la pausa, dal 2026-09-03, è quella giusta.** Con 1,1 s fra le pagine il ritmo restava di ~33
richieste al minuto (le sei attese più i ~6 s di risposte misurati), contro le **12/min** che Aruba
documenta: la pausa attenuava, non riportava dentro il limite. Ora sono **5 s**, cioè ≈ 36 s per le
sette pagine. **Il rischio della nona richiesta**, però, non lo chiude la pausa: l'upload arriva
subito dopo l'ultima pagina, quindi il branch aggiunge **una pausa di 5 s prima dell'upload** (solo
quando il pavimento è stato letto dal vivo) e **un ritentativo unico dopo 90 s** se l'upload prende
`429` — e se anche il secondo tentativo trova il muro, la riga a registro dice **«Trasporto
fallito»** invece di «Errore upload», perché un limite di frequenza non è uno scarto fiscale (§0.3).

~~Sui numeri attesi: la serie **`Asilo`** era arrivata a leggersi (il valore non è stato stampato
perché il collaudo asseriva prima di stampare — corretto anche quello), quindi il progressivo
`Asilo` **esiste ed è leggibile**. Quello che manca è vederlo, insieme a `FPR`.~~
🔄 **Superato: visti entrambi il 2026-09-03 alle 12:32** — `Asilo 2026 = 2327` e `FPR 2026 = 1946`.

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
| **sconto** | 🔄 **`0`, azzerato il 2026-09-03 alle 09:35** (era un residuo di 30 € «SCONTO FRATELLI»): in fattura va l'importo incassato, 300,00 € — decisione 1 di §0.1 |
| serie attesa | **`FPR`** (compie 3 anni entro il 30 aprile) |
| CF bambina · CF genitore | 16 caratteri entrambi ✓ |
| `intestatario_fatture` | valorizzato ✓ |
| fattura già presente | no ✓ (`fatture_emesse` **vuota**: 0 righe in totale, riverificato il 2026-09-03) |

👉 **Come si preme, passo per passo, sta in §0.5** — dove l'attesa di 60 minuti dall'ultima chiamata
ad Aruba risulta **già scaduta** (le 12:32 del collaudo più un'ora: 13:32), e c'è la regola del «non
ripremere».

Configurazione della sede, verificata: `abilitato: true`, `ambiente: production`, `password_ref`
presente, `fiscale_config` completa (cap · comune · provincia · email · piva · codice_fiscale ·
denominazione · regime_fiscale).

⚠️ **Due cose da guardare prima di premere** — ✅ **RISOLTE il 2026-09-02, e la seconda era scritta
male proprio qui sotto:**

1. ~~`aruba_config.iva` ha **0 righe**~~ → **è la configurazione GIUSTA, non una lacuna.** La chiave
   `iva` è **assente** (non un array vuoto) in tutte e tre le sedi, e il codice tratta i due casi
   allo stesso modo: la ricerca `(cfg.iva || []).find(…)` di `emissione.ts:1067` non trova la
   causale, e `fatturapa-xml.ts:487` (`NATURA_ESENTE`, dichiarata a `:76`) applica il
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

👉 **La versione aggiornata di questo passo è §0.6**: quattro query invece di tre (c'è anche
l'aggregato su `pagamenti`), con accanto i **valori attesi** e cosa fare quando non tornano. Quello
che segue è il nucleo, e resta valido.

Subito dopo l'emissione:

```sql
SELECT sezionale, anno, ultimo_numero, aggiornato_il
FROM fatture_numerazione_sezionale ORDER BY anno DESC, sezionale;

SELECT sezionale, numero, anno, progressivo_invio, sdi_stato, sdi_stato_label, aruba_filename
FROM fatture_emesse ORDER BY creato_il DESC LIMIT 3;
```

Il numero allocato dev'essere **`max(letto da Aruba) + 1`** per `FPR` 2026 — e quel massimo ora è un
numero, non un'incognita: **1946**, letto alle 12:32 del 2026-09-03, quindi **`ultimo_numero` = 1947**.
Se fosse `1`, **fermare tutto**: significa che il pavimento è stato letto come zero, ed è la
collisione fiscale che tutto questo lavoro esiste per impedire.

E il log applicativo, che racconta l'esito senza doverlo indovinare:

```sql
SELECT creato_il, livello, left(messaggio,200) AS messaggio,
       contesto->'campi'->>'operazione' AS operazione, contesto->'campi'->>'esito' AS esito
FROM app_log WHERE evento='fattura' AND creato_il > now() - interval '1 hour'
ORDER BY creato_il DESC;
```

---

## 4. Strumenti già pronti nel repo

| file | a cosa serve | chiama Aruba? |
|---|---|---|
| `scripts/collaudo/numerazione-aruba.collaudo.ts` | il codice di **prodotto** contro l'API vera, sola lettura | **sì**: 1 signin + 7 GET |
| `scripts/collaudo/fattura-singola.collaudo.ts` | 🔄 **nuovo il 2026-09-03**: genera **in memoria** il documento di **un solo** pagamento (`PAGAMENTO_ID`) e lo verifica elemento per elemento — serie, `N4`, riferimento normativo, **assenza di `<DatiBollo>`**, totale, `IdTrasmittente`, `RegimeFiscale`, `CodiceDestinatario` | **no**, e non chiama nemmeno la RPC: il numero è un segnaposto |
| `scripts/aruba-forma-elenco.mjs` | la **forma** della risposta: A/B a 4 celle, stampa solo i NOMI delle chiavi | **sì** |
| `scripts/aruba-prova-collegamento.mjs` | signin + una chiamata operativa (un account non abilitato supera il login e fallisce dopo) | **sì** |
| `scripts/aruba-campioni.mjs` | scarica campioni veri — `--out` **fuori dal repo**, che è pubblico | **sì** |
| `scripts/collaudo/upload-dryrun.mjs` | l'unico upload mai tentato da questo repo (commit `69d45a3e`, 2026-08-10, PR #79): `dryRun: true` con la P.IVA del cedente sostituita da una estranea, e conteggio delle fatture inviate **prima e dopo** — che è la prova osservabile che nulla è partito | **sì**, upload compreso: **non si lancia oggi** |

⚠️ **Ognuno di quelli marcati «sì» fa il proprio `signin`.** Lanciarne due di seguito significa `429`
sul secondo — e ogni tentativo, anche rifiutato, azzera il TTL di un'ora (§0.2).

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

- **`docs/fatturazione/configurazione-aruba.md`** — 🔄 *nuovo il 2026-09-03*: la configurazione con
  cui questo software parla con Aruba, voce per voce, ognuna col suo livello di certezza e col modo
  in cui è stata verificata. È la fonte dei numeri di §0
- `docs/fatturazione/tracciato-di-riferimento.md` — il tracciato XML campo per campo
- PRD, changelog **2026-09-03** «Nove richieste in pochi secondi contro un limite di dodici al
  minuto» (ritmo, ritentativo, rifiuto di trasporto, `maxDuration`) e riquadro «Stato al 2026-09-03»
  in testa al *Modulo Fatturazione Elettronica*
- PRD, changelog **2026-09-02** «La fattura cercava il proprio numero dove non c'era»
- `https://fatturazioneelettronica.aruba.it/apidoc/docs.html` — SLA §3 (limiti al minuto) e Tiering
  §7.3 (leaky bucket, TTL di un'ora, tier degli upload)
- `src/lib/aruba/client.ts` → `etichetteDellElemento` (la testata spiega la forma e il perché)
- `src/lib/aruba/emissione.ts` → i cinque messaggi d'errore distinti per `code`
