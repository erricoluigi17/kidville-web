# PR 4.6 · annotazioni: difetti secondari non corretti e differenze da dichiarare nel corpo della PR

Fonte dei numeri: revisione finale Opus del 09/11/2026 (`pr4-6-final-review.md`), misurata in produzione in sola lettura.

## 🟥 DECISIONE DEL TITOLARE (non cambiata dalla PR) · rilievo 14: la conferma non riporta la retta

`20261109035219_anno_iscrizione_conferma.sql:372-373` e `:474`. Quando si conferma una frequenza per l'anno nuovo, la retta non viene
riportata:

- pagante di famiglia a **400** → passa a **150**;
- fratello **a carico** → non è più a carico;
- retta **propria 200** → passa a **150**.

In produzione: **45 bambini a carico** e circa **703 rette personali**, quindi il primo «Conferma» sul 2027/28 cambia molti importi.
Il flag `retta_personalizzata_precedente` vale true/false/true e la scheda può già segnalarlo. Non è un difetto di questo diff, ma da
qui la conferma comincia a produrre voci di pagamento. **Non cambiato**: va deciso dal titolare prima di aprire le conferme sul 2027/28.

## Da dichiarare nel corpo della PR (differenze volute, non difetti)

- **5 · Righe che non si generano più.** In produzione, confrontando la funzione vecchia con il predicato nuovo sull'anno in corso:
  7450 righe contro 7418, **32 in meno, di cui 11 ancora da generare**. Sono 31 bambini con `data_iscrizione` NULL e ingresso dopo il
  mese. Criterio: la retta di un mese **prima dell'ingresso** non si genera più (il vecchio la chiedeva). Settembre 2026: 31 righe, 21 già
  generate (restano dove sono: nessuna migrazione tocca `pagamenti`), 10 da fare; ottobre 2026: 1 da fare.
- **6 · `alunni.stato = 'sospeso'` con frequenza viva ora riceve la retta.** M46a: la frequenza viva decide, non lo stato di oggi. Nessuno
  scrittore in `src`, 0 casi in produzione: teorico. Va deciso se un sospeso con frequenza viva debba riceverla.
- **7 · `data_iscrizione` dopo l'ingresso.** Si generano i mesi prima dell'iscrizione. 0 casi in produzione. Se `scriviFrequenzaDopoAlunni`
  fallisce (è fail-open) l'ingresso resta alla data di oggi: controllare il log di quel ramo. Da riportare nel PRD.
- **15 · Il pro-rata cambia base: da `data_iscrizione` a `data_ingresso`.** Iscrizione NULL con ingresso 20/09: sconto da 0 a 75.
  Iscrizione 20/10 con ingresso 01/09: da 75 a 0. Oggi 0 sedi con il pro-rata acceso. **Prima di accenderlo su una sede, rimisurare**: in
  produzione 672 frequenze hanno l'ingresso a settembre dopo il 01/09 (621 con iscrizione NULL, 51 con data) e solo 92 coincidono con
  l'inizio, quindi la scelta di `data_ingresso` allarga molto la platea.
- **24 · `SECURITY DEFINER`.** Le funzioni di M46a passano a `SECURITY DEFINER` con `search_path` fissato; la produzione non lo era.
  Privilegi misurati: `anon` e `authenticated` falsi, `service_role` vero. Ora scritto nell'intestazione della migrazione.
- **25 · Nota operativa.** La fonte dell'importo è `frequenze.*`: una correzione a mano via SQL su `alunni.importo_retta_mensile` non
  conta più, perché lo specchio `alunni` → `frequenze` scatta solo su INSERT e cambio di sede. Gli scrittori dell'app passano già dalla
  frequenza. Chi interviene a mano deve scrivere `frequenze.retta_mensile`.
- **Degradazione.** Con un database senza lo schema dell'anno la route torna alla strada storica, che conserva il ripiego a 150 di
  proposito; va tolto quando tutte le migrazioni sono applicate (PR 5).
- **Solo uuid e conteggi nei log**; nessun dato di persone.

## Annotati, non corretti (su indicazione del coordinatore)

- **8 · Il mese singolo ignora i mesi del listino.** Luglio si genera anche con mesi senza luglio (come faceva il vecchio), ma il testo
  della scheda dice «Mesi in cui si genera la retta». Da adattare il testo o avvisare nell'anteprima.
- **12 · I servizi non seguono le stesse regole della retta.** M46a:490-492 e :505-514. Un bambino in arrivo con sezione solo in frequenza
  ha la retta e non il servizio; con giorno 12 in frequenza: retta il 12/09, servizio il 05/09 (il commento dice «stesse date»); con
  ingresso a novembre il servizio parte a settembre. `iscrizioni_servizi` oggi è vuota. Da fare: leggere da `frequenze` come la retta e
  rispettare ingresso e uscita.
- **13 · La fascia dell'anno prossimo viene dalla sezione di oggi.** M46a:171. Stesso bambino: 300 in infanzia, poi 500 quando gli si
  assegna la prima sezione. `sezioni_con_fascia` oggi 0. Da fare: per chi non ha sezione nell'anno, `senza_importo` o un esito che lo
  segnali.
- **18 · Impostazioni e l'importo accanto al rimando.** Corretto nel primo giro di correzione: accanto al rimando Impostazioni mostra
  la retta di base dell'anno in corso **letta dal listino** (la route della scheda Rette, nessuna route nuova), e non scrive nessun
  numero se manca la riga «per tutte le fasce». Lo specchio `admin_settings.retta_default_importo` non si mostra.
- **19 · La forma del log `anno-retta-impostata` è diversa dal piano.** Chiavi innocue (uuid, un codice, un flag). Allineare il piano.
- **22 · Prestazioni dell'anteprima annuale.** Il predicato sulla sede grande: 3591 righe in 1,56 s (misurato). L'anteprima annuale fa
  circa 4 blocchi, cioè circa 6 s (stima, non cronometrata sulla route vera), e il POST la rilegge. Da fare: una sola chiamata con tutti
  i mesi, oppure un riepilogo calcolato dal database.
- **21 · Il compito 4.6.10** è fatto (09/11/2026): PRD, nomi delle migrazioni rifatti con `date -u` (`20261109153822`, `20261109153825`)
  e corpo della PR in `.superpowers/pr4-6-corpo.md`. `MIGRAZIONI_ATTESE_AL_MERGE` resta vuoto: nessuna guardia segnala le due
  migrazioni (creano funzioni, nessun UNIQUE, nessuna policy) e il lock «nessuna voce morta» rifiuterebbe una dichiarazione che
  nessuno vede.

## Dalla ri-revisione (annotati, non corretti)

- **6 · La scrittura del listino sceglie la riga con un'altra regola.** `anno_listino_retta_imposta` (M46b) ordina per `l.id`, mentre
  `rette_da_generare` (M46a) ordina per `payment_category_id NULLS LAST, l.id`. Con due righe senza fascia il PUT può aggiornare una
  riga che il generatore non legge. Teorico: in produzione 0 doppioni, e la route non ne crea più (rifiuta `categoria_id` su `retta`).
  Da fare: stessa regola nei due punti.
- **8 · In modalità annuale la frase parla di «quel mese».** `genera-rette/route.ts`, risposta `MESE_FUORI_DAGLI_ANNI` per un anno
  senza `anni_sede` (es. 2028). In produzione gli anni proposti dal selettore esistono. Da fare: una frase distinta per l'anno.
- **Fuori ambito, da decidere:** il POST annuale non notifica le famiglie (a differenza del mensile); lo specchio `retta_default_importo`
  resta al vecchio valore dopo «Togli» (pesa solo sulla strada storica); commenti col 150 in `admin/iscrizioni/route.ts` e
  `ModuliRicevuti.tsx` fuori dall'elenco corretto.

## Correzione di una nota sbagliata (rilievo 20)

La versione precedente di questo file diceva che il servizio «oggi si imposta solo dalla scheda Quote». **Falso**: la scheda Quote
scrive solo `quota_*`, e il riquadro di sola lettura è stato tolto. `PUT voce: 'servizio'` e `mesi_effettivi.servizio` **non hanno
chiamanti**: oggi il servizio **non si imposta da nessuna schermata**. Il listino del servizio resta, per ora, scrivibile solo dalla
route (con la categoria).

## Altre note già annotate

- `genera-servizi/route.ts` non è stato toccato: l'SQL risolve l'anno da sé.
- `mesi_effettivi` della route rette è per voce (`retta`, `servizio`), non un array unico come nel piano.
- PGlite è Postgres 18, la produzione è 17: le migrazioni M46a/M46b non sono state provate sul 17.

## Che cosa vale per le PR dopo

| Voce | Per chi | Quando |
|---|---|---|
| 14 · la conferma non porta la retta | titolare, poi PR 4.8 | prima di aprire le conferme sul 2027/28 |
| 15 · pro-rata da `data_ingresso` | chi accende il pro-rata su una sede | rimisurare prima di accenderlo |
| 6 (dichiarata) · `sospeso` con frequenza viva | titolare | da decidere |
| 8 · il mese singolo e i mesi del listino; frase «quel mese» per l'anno | prossima PR sulla scheda Rette | testo o avviso |
| 12 · servizi che non seguono le regole della retta | PR che rende il servizio impostabile da una schermata | `iscrizioni_servizi` è vuota |
| 13 · la fascia dell'anno prossimo dalla sezione di oggi | PR 4.8 (passaggio d'anno) | quando si assegnano le sezioni |
| 22 · anteprima annuale (~6 s stimati) | PR 4.7 (cruscotto) o PR 5 | una sola chiamata con tutti i mesi |
| 6 (ri-revisione) · regola della riga nei due punti | prossima migrazione sul listino | teorico, 0 doppioni |
| POST annuale che non notifica; specchio dopo «Togli»; commenti col 150 | titolare / PR 5 | da decidere |
| strada storica di `genera-rette` con ripiego a 150 | PR 5 | quando tutte le migrazioni sono applicate |
