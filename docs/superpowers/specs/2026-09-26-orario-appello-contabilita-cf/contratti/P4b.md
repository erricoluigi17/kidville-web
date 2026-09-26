# P4b — Cassa: selettore di sede nelle finestre di scrittura

Stato: implementato il 2026-09-26 (ondata 2). Consumatore: **P4** (`CassaPanel`), che deve
passare le prop nuove: fino ad allora `CassaPanel.tsx` non compila (4 errori `TS2322`) e
`__tests__/components/CassaPanel.test.tsx` è rosso (`sedi` è `undefined`).

## La decisione

In Cassa la **lettura** unisce le sedi (K3), ma ogni **scrittura** è di una sede sola: ogni sede è
un cassetto a sé, con il suo fondo, il suo saldo e il suo svuotamento. Le route di scrittura non
cambiano (K3): quelle che **creano** (`POST` movimento, chiusura, categoria, upload-url
dell'allegato, `PATCH` impostazioni) vogliono `scuola_id` nel body e rispondono 400 se la sede è
ambigua. Per questo la sede si sceglie **dentro la finestra**, prima di scrivere.

Eccezione da non fraintendere: la **`DELETE` di una categoria** non prende la sede dalla query.
`deleteQuerySchema = z.object({ id: zUuid })` (`src/app/api/pagamenti/cassa/categorie/route.ts`)
scarta ogni altro parametro, e lo scope viene dalla **sede della categoria stessa**, letta e
verificata dal server con `caricaCategoriaConScope` (una categoria di sede si cancella solo se
quella sede è fra le proprie; una globale da qualunque admin). Il client manda comunque
`&scuola_id=<sede scelta>` per coerenza con le altre chiamate, ma **il server lo ignora**: non è
una protezione e nessuno deve contarci.

## Prop: le stesse per le quattro finestre

`scuolaId: string` **non esiste più**. Al suo posto:

```ts
import type { SedeCassa } from '@/components/features/admin/pagamenti/CassaSede';
// SedeCassa = { id: string; nome: string }

sedi: SedeCassa[]            // le sedi EFFETTIVE su cui l'utente può scrivere in cassa
sedeIniziale: string | null  // la sede già scelta dalla pagina, o null quando le sedi sono più d'una
```

| Finestra | File | Firma |
|---|---|---|
| Uscita / entrata manuale | `CassaMovimentoModal.tsx` | `{ userId, sedi, sedeIniziale, tipoIniziale, onClose, onDone, returnFocusRef? }` |
| Svuota cassa | `CassaChiusuraModal.tsx` | `{ userId, sedi, sedeIniziale, onClose, onDone, returnFocusRef? }` |
| Categorie di uscita | `CassaCategorieManager.tsx` | `{ userId, sedi, sedeIniziale }` |
| Impostazioni (fondo, soglia) | `CassaImpostazioni.tsx` | `{ userId, sedi, sedeIniziale }` |

Il cablaggio atteso in `CassaPanel`, allo stesso modo di `FiscalePanel` → `RevisioneFatturePanel`:
`sedi` = le sedi effettive del cockpit (`useSediAttive`) come `{ id, nome }`, e
`sedeIniziale` = la sede della pagina quando è una sola, altrimenti `null`.

## La regola della sede (`CassaSede.tsx`, file nuovo)

`sedeDiLavoroCassa(sedi, scelta)` e l'hook `useSedeCassa(sedi, sedeIniziale)`:

| `sedi` | sede di lavoro | selettore |
|---|---|---|
| 0 | `null`: la finestra non legge e non scrive, e dice «Nessuna sede disponibile» | no |
| 1 | quella, sempre, qualunque sia `sedeIniziale` | **no** |
| più d'una | `sedeIniziale` **solo se** è fra `sedi`; altrimenti `null` finché l'utente non sceglie | **sì**, obbligatorio |

- **Nessuna preselezione a caso**: con più sedi e `sedeIniziale` null (o estranea) il `<select>`
  vale `""` e mostra «Scegli la sede» (opzione disabilitata).
- Il selettore è `CampoSedeCassa`: `<label for>` «Sede» + `<select aria-required="true">`; con 0
  o 1 sede non rende niente. Etichetta dell'opzione = `nome` ripulito, oppure l'uuid se il nome è
  vuoto. `aria-required` (e non `required`) perché l'obbligo si annuncia subito agli screen reader
  (WCAG 3.3.2 / 4.1.2) ma la validazione resta della finestra, col suo messaggio tradotto.
- **Nessuna sede (`sedi = []`)**: tutte e quattro le finestre mostrano subito «Nessuna sede
  disponibile…» al posto del form, senza leggere né scrivere niente.

## Cosa fa ogni finestra con la sede

**`CassaMovimentoModal`**
- Con `sedi = []` il form non si rende: c'è solo il messaggio e «Annulla» (niente «Salva», niente
  «Prima scegli la sede», che lì non si potrebbe fare).
- Il selettore è il primo campo del form.
- Le categorie si leggono solo a sede nota (`GET …/categorie?scuola_id=S`); prima il `<select>`
  della categoria è disabilitato e dice «Prima scegli la sede».
- Cambiare sede **azzera** la categoria scelta e l'elenco, poi si rilegge: una categoria di sede A
  non parte mai con la sede B.
- «Salva» senza sede: nessuna chiamata, messaggio «Scegli la sede della cassa…» in `role="alert"`,
  il selettore prende `aria-invalid` e `aria-describedby` verso il messaggio. Un 400 del server
  con `details[].path === 'scuola_id'` marca lo stesso campo.
- Allegato: `POST …/allegato/upload-url` con `scuola_id` = sede scelta, quindi il path su Storage
  è quello della sede scelta. Il `POST …/movimenti` porta la stessa sede.
- **Categorie non lette** (giro 3): una `GET …/categorie` con stato non ok (403, 500) o in errore
  di rete non è «nessuna categoria». Log `logClient` di livello `error`
  (`cassa-categorie-lettura-rifiutata` con lo stato HTTP, oppure
  `cassa-categorie-caricamento-fallito: <nome errore>` con stato 0); accanto al select della
  categoria (solo per le uscite) un avviso `role="alert"` `cassaMovCatErrLettura`; il select è
  disabilitato e punta all'avviso con `aria-describedby`. «Salva» su un'uscita in quello stato non
  chiama niente e non dice «seleziona una categoria» (che porterebbe fuori strada): marca il select
  con `aria-invalid`. Un'**entrata** non usa categorie e si salva normalmente. Legato alla sede:
  cambiando sede l'avviso si toglie e si rilegge.

**`CassaChiusuraModal`**
- Senza sede: nessuna `GET …/saldo`, nessun campo «Totale contato», nessun «Conferma»; solo
  «Scegli la sede: ogni sede ha la sua cassa…».
- Il saldo mostrato è **sempre** quello della sede scelta: al cambio di sede il saldo in pagina si
  toglie subito e si rilegge; una risposta in ritardo della sede precedente viene scartata.
- Al cambio di sede si azzerano anche «Totale contato» e note: erano il conteggio del cassetto
  dell'altra sede, e differenza e prelievo non si calcolano mai contro il saldo di una sede con un
  numero contato in un'altra.
- `POST …/chiusura` invia sempre e solo `{ scuola_id, contato, note }`.
- Il selettore si disabilita durante l'invio e dopo l'esito; con più sedi l'esito riporta anche la
  riga «Sede».
- Correzione collaterale: una `GET …/saldo` con risposta non ok (es. 403 `SEDE_NON_ACCESSIBILE`)
  o in errore di rete ora dice «Impossibile leggere il saldo di cassa.» (`role="alert"`), con un
  `logClient` di livello `error`. Prima diceva «Modulo cassa non ancora attivo», che è un'altra cosa.
  L'effetto del saldo non ha più `t` fra le dipendenze.

**`CassaCategorieManager`**
- Senza sede: né elenco né campo di aggiunta, solo il messaggio.
- `GET` (query `scuola_id`) e `POST` (body `scuola_id`) usano la sede scelta. La `DELETE` manda
  `id` e, per coerenza, anche `scuola_id` in query, che però il server **ignora**: la cancellazione
  è limitata dalla sede della categoria, verificata con `caricaCategoriaConScope` (vedi sopra).
- **Lettura rifiutata** (giro 3): una `GET …/categorie?scuola_id=S` con stato non ok (403
  `SEDE_NON_ACCESSIBILE`, 500) o in errore di rete **non** è un elenco vuoto. Log `logClient` di
  livello `error` — `cassa-categorie-lettura-rifiutata` con lo stato HTTP, oppure
  `cassa-categorie-caricamento-fallito: <nome errore>` con stato 0 — e, per quella sede, al posto
  di chip, campo «Aggiungi» e nota sulle categorie di sistema, un avviso `role="alert"`
  `cassaCatErrLettura`. È legato alla sede (`fallitaPer`, come in `CassaImpostazioni`): cambiando
  sede si toglie e si rilegge.
- Al cambio di sede l'elenco si svuota e si rilegge; una lettura più vecchia che arriva dopo viene
  scartata (contatore `ultimaLettura`).
- Mentre un `POST` o un `DELETE` è in volo (`busy`) selettore, «Aggiungi» e cestini sono
  disabilitati. In più `load(sede)` riceve la sede come argomento (non da una closure) e la
  risposta vale solo se `sede === sedeCorrente.current`; `add`/`del` ricordano la sede con cui sono
  partite e, se al ritorno è cambiata, scartano esito, errore e rilettura. Prima `add` richiamava il
  `load` catturato al render della sede vecchia, che prendeva il numero di lettura più alto e
  scriveva le categorie di Alfa sotto il selettore su Beta. Il rischio vero era quello: **l'elenco
  di Alfa mostrato sotto il nome di Beta**, con i cestini delle categorie di Alfa a portata di
  clic sotto l'etichetta sbagliata. Non era una cancellazione sulla sede sbagliata: una `DELETE`
  cancella la categoria indicata da `id` e il server la limita alla sede **di quella categoria**
  (`caricaCategoriaConScope`), ignorando lo `scuola_id` in query. (Il resoconto del giro 2 lo
  descriveva come un `DELETE ?id=<Alfa>&scuola_id=<Beta>` pericoloso per lo `scuola_id`: era
  sbagliato, corretto nel giro 3.)

**`CassaImpostazioni`**
- Senza sede: né campi né «Salva», solo il messaggio.
- I campi compaiono solo quando i valori letti sono **della sede scelta** (`caricataPer === scuolaId`).
  Al cambio di sede si rileggono; una risposta in ritardo viene scartata.
- **Lettura fallita** (rete, stato non ok come 403/500, oppure corpo senza `success: true`): avviso
  `role="alert"` «Impossibile leggere fondo cassa e soglia di questa sede…», e per quella sede
  **né campi né «Salva»** — dei campi vuoti manderebbero `{ fondo: 0, soglia_avviso: null }` sopra
  il fondo vero. Log `logClient` di livello `error`: `cassa-impostazioni-lettura-rifiutata` con lo
  stato HTTP, oppure `cassa-impostazioni-caricamento-fallito: <nome errore>` con stato 0. Con più
  sedi il selettore resta usabile; cambiando sede l'avviso si toglie e si rilegge.
- `PATCH /api/admin/settings` invia `{ scuola_id: <sede scelta>, cassa_config: { fondo, soglia_avviso } }`,
  sempre senza lo spread della config letta.
- Con una sola sede il rendering è quello di prima (messaggio di caricamento, poi la card).

## i18n (`adminContabilita`, it + en, inserite dopo `cassaMovCampoSede`)

`cassaSedeLabel`, `cassaSedeScegli`, `cassaSedeObbligatoria`, `cassaSedePrimaLaSede`,
`cassaSedeNessuna`, `cassaSedeScegliPerSaldo`, `cassaSedeScegliPerCategorie`,
`cassaSedeScegliPerImpostazioni`, `cassaCfgErrLettura` (giro 2), `cassaCatErrLettura`,
`cassaMovCatErrLettura` (giro 3).

## Test

- Nuovo: `__tests__/components/cassa-sede-finestre.test.tsx`, **36 casi** (16 del giro 1, 13 del
  giro 2, 5 del giro 3, 2 del giro 4). I finti rispondono
  diversamente per sede (saldo, fondo, categorie, path dell'allegato), quindi una sede sbagliata si
  vede nel numero a schermo o nel payload.
  - Movimento (5): una sede; più sedi senza scelta (salvataggio bloccato, nessuna lettura di
    categorie); scelta Beta (categorie, allegato e POST su Beta); il cambio di sede azzera la
    categoria; `sedeIniziale` fra le sedi è preselezionata, una estranea no.
  - Chiusura (4): una sede; più sedi (niente saldo né form prima della scelta, poi saldo, fondo e
    POST di Beta); risposta in ritardo della prima sede scartata; saldo rifiutato con 403.
  - Categorie (3): una sede (GET, POST, DELETE); più sedi (niente prima, poi tutto su Gamma);
    lettura in ritardo scartata.
  - Impostazioni (4): una sede; più sedi (niente prima, poi valori e PATCH di Beta); da Beta a
    Gamma si rileggono i valori; lettura in ritardo scartata.
- Adattati alle prop nuove, senza toccare asserzioni: `CassaMovimentoModal.test.tsx`,
  `CassaChiusuraModal.test.tsx`, `features/admin/cassa-scatta-foto.test.tsx`,
  `features/admin/errore-server-tradotto-cockpit.test.tsx`.
- Prova di mutazione: 13 rotture, ognuna applicata da sola e poi ripristinata. Ognuna ha fatto
  diventare rosso almeno un caso:
  1. preselezione della prima sede → 5 rossi;
  2. POST movimento con la prima sede → 1;
  3. allegato con la prima sede → 1;
  4. chiusura senza il flag `active` → 1 (ritardo);
  5. categorie senza il contatore → 1 (ritardo);
  6. PATCH con `sedeIniziale ?? sedi[0]` → 2;
  7. categoria non azzerata al cambio di sede → 1;
  8. saldo senza il controllo di `r.ok` → 1 (403);
  9. impostazioni senza il flag `active` → 1 (ritardo);
  10. selettore anche con una sede → 4;
  11. POST chiusura con la prima sede → 1;
  12. POST categoria con la prima sede → 1;
  13. salvataggio del movimento senza il controllo della sede → 1.

### Giro 2 (difetti del critico)

Casi aggiunti (13):
- Nessuna sede (4): Movimento, Svuota cassa, Categorie, Impostazioni con `sedi = []` → messaggio
  subito, nessuna chiamata, niente «Salva»/«Conferma»/campo.
- Movimento (+1, +1 asserzione): un 400 con `details[].path === 'scuola_id'` marca il selettore
  (`aria-invalid`, `aria-describedby` = id dell'alert); `aria-required="true"` sul selettore.
- Chiusura (+1, +1 asserzione): il cambio di sede svuota «Totale contato» e note; sul 403 del
  saldo `logClient` è chiamato con `{ livello: 'error', messaggio: 'cassa-saldo-rifiutato', stato: 403 }`.
- Categorie (+3): POST di Alfa in sospeso → passaggio a Beta → sblocco con 201: restano le
  categorie di Beta e nessuna nuova GET di Alfa; lo stesso con 409: nessun errore sotto Beta;
  DELETE di Alfa in sospeso → Beta → 409: niente Alfa, niente alert, nessuna GET di Alfa. Nei primi
  due si verifica anche che selettore, «Aggiungi» e cestino siano disabilitati durante il POST.
- Impostazioni (+3): GET 500 → alert, niente campi né «Salva», nessuna PATCH, log con stato 500;
  200 con `success: false` → alert; errore di rete con più sedi → alert e log con stato 0, poi Beta
  si legge normalmente.
- i18n (+1): `cassaCfgErrLettura` esiste in it ed en.

Prima delle correzioni, 8 dei casi nuovi erano rossi sul codice del giro 1 (i due su 400
`scuola_id` e su log del 403 coprivano comportamenti già presenti: la loro prova è la mutazione).
Prova di mutazione del giro 2, ogni rottura applicata da sola e ripristinata:
  14. `add` senza guardia della sede → 2 rossi;
  15. selettore delle categorie non disabilitato durante la scrittura → 2;
  16. errore del POST non scartato dopo il cambio di sede → 1;
  17. `aria-required` tolto → 1;
  18. Movimento con `sedi = []` rende il form come prima → 1;
  19. `setContatoStr('')` tolto dal cambio di sede → 1;
  20. lettura impostazioni che ignora lo stato HTTP → 1;
  21. lettura impostazioni che ignora `success` → 1;
  22. errore di rete delle impostazioni senza avviso → 1;
  23. saldo 403 senza `logClient` → 1;
  24. 400 `scuola_id` senza `setCampiErrati` → 1;
  25. log della lettura impostazioni senza lo stato HTTP → 1;
  26. `del` senza guardia della sede → 1;
  27. cestino non disabilitato → 2.

### Giro 3 (difetti del critico)

1. **Letture delle categorie che fallivano in silenzio.** `CassaCategorieManager.load(sede)` e
   l'effetto delle categorie in `CassaMovimentoModal` facevano `.then((r) => r.json())` senza
   guardare `r.ok`: un 403 `SEDE_NON_ACCESSIBILE` o un 500 diventava un elenco vuoto, senza log.
   Ora entrambe controllano `r.ok`, loggano `cassa-categorie-lettura-rifiutata` con lo stato, e
   mostrano un avviso tradotto legato alla sede (vedi le sezioni delle due finestre).
2. **Contratto sulla `DELETE` delle categorie.** Questo file diceva che la `DELETE` usa la sede
   scelta tramite `scuola_id` in query. Falso: la route lo scarta (`deleteQuerySchema = { id }`) e
   limita la cancellazione alla sede della categoria (`caricaCategoriaConScope`). Corretti la
   sezione «La decisione», la sezione di `CassaCategorieManager` e il resoconto del difetto del
   giro 1. Il client continua a mandare lo `scuola_id`, che il server ignora; il test esistente che
   lo verifica è rimasto invariato: controlla la coerenza del client, non una protezione.

Casi aggiunti (5):
- Movimento (+2): GET categorie 403 → avviso accanto al select, `logClient` con
  `{ livello: 'error', messaggio: 'cassa-categorie-lettura-rifiutata', stato: 403 }`, select
  disabilitato con `aria-describedby` verso l'avviso; «Salva» su un'uscita non chiama
  `…/movimenti`, non dice «seleziona una categoria» e marca il select `aria-invalid`. GET 500 su
  Alfa → avviso e log con stato 500; passando a Beta l'avviso va via e compaiono le categorie di Beta.
- Categorie (+2): GET 403 → `role="alert"` `cassaCatErrLettura`, niente campo né «Aggiungi», log
  con stato 403, nessuna scrittura. GET 500 su Alfa → avviso e log; passando a Beta l'avviso va
  via, compaiono le categorie di Beta e il campo di aggiunta.
- i18n (+1): `cassaCatErrLettura` e `cassaMovCatErrLettura` in it ed en.

Tutti e 5 erano rossi sul codice del giro 2. Prova di mutazione del giro 3, ognuna da sola e poi
ripristinata:
  28. manager senza il controllo di `r.ok` → 2 rossi;
  29. movimento senza il controllo di `r.ok` → 2;
  30. «Salva» dell'uscita senza la guardia `categorieNonLette` → 1;
  31. log del manager con `stato: 0` al posto di `r.status` → 2;
  32. movimento senza l'avviso accanto al select → 2;
  33. manager senza il ramo dell'avviso nel rendering → 2.

### Giro 4 (difetto del critico)

Il ramo «errore di RETE» delle due letture delle categorie non aveva test: togliendo
`setFallitaPer(sede)` dal `.catch` di `CassaCategorieManager.load` o `setCategorieFallitePer(scuolaId)`
dal `catch` dell'effetto di `CassaMovimentoModal`, i 34 casi restavano verdi. Nessuna modifica al
codice dei componenti: il comportamento c'era, mancava la prova.

Casi aggiunti (2):
- Movimento (+1): GET categorie rifiutata a livello di rete (`Promise.reject(new TypeError('Failed to
  fetch'))`) → avviso `cassaMovCatErrLettura`, `logClient` con `{ livello: 'error', messaggio:
  contiene 'cassa-categorie-caricamento-fallito', stato: 0 }`, select disabilitato con
  `aria-describedby` verso l'avviso; «Salva» su un'uscita non chiama `…/movimenti` e non dice
  «seleziona una categoria».
- Categorie (+1): tre sedi, `sedeIniziale='sede-a'`, GET di Alfa rifiutata per rete → alert
  `cassaCatErrLettura`, niente campo di aggiunta, log con stato 0; passando a Beta compare
  «Cancelleria Beta» (una volta), l'alert va via e torna il campo; nessuna scrittura.

Prova di mutazione del giro 4, ognuna da sola e poi ripristinata (confronto `cmp` con la copia):
  34. `.catch` del manager senza `setFallitaPer(sede)` → 1 rosso (il caso di rete delle Categorie);
  35. `catch` del movimento senza `setCategorieFallitePer(scuolaId)` → 1 rosso (il caso di rete del
      Movimento).
