# PR 4.5, iscrizioni all'anno prossimo: difetti secondari (09/11/2026)

La revisione finale su Opus e le tre ri-revisioni si sono chiuse senza bloccanti. Regola del titolare (02/10): il bloccante si
corregge, tutto il resto si annota. Qui sotto ciò che resta, con il motivo per cui non ferma la PR e dove va a finire. Nessuno di
questi perde dati o tocca dati di minori.

## Da riprendere nelle PR dopo

| Difetto | Effetto | Dove va |
|---|---|---|
| «Più voci» di quota si perde ricaricando la pagina | La riga dice «Quota da generare»; premendo, la risposta ridice «più voci» e non nasce un doppione | PR 4.7 (`piu_voci` letto dal server) |
| Dopo un ritiro con voce pagata la vista dice quota assente | La famiglia vede la voce pagata, la segreteria no; riconfermare la ricollega senza doppioni | PR 4.7 |
| La route `moduli-mancanti` non ha chiamanti, e conta anche righe di bambini ritirati dopo la conferma | Oggi nessuno la legge | PR 4.7 |
| La tendina «Ritirato» su un bambino confermato non chiude l'iscrizione dell'anno dopo né la voce | La riga resta viva nell'anno prossimo | PR 4.8 (l'anteprima la mostra e chiede una scelta), decisione del titolare |
| Un frequentante archiviato dopo la `fine` con l'anno ancora attivo, poi riattivato, torna `in_arrivo` | Solo da settembre 2027 | PR 4.8 |
| Un anno chiuso con `domande_aperte` vero verrebbe offerto dal modulo pubblico | Oggi nessun anno è in quello stato | PR 4.9 |
| Una prova usa `giorno_roma(now())` in `anno-riga-conferma-in-arrivo`, `anno-ritiro-conferma`, `anno-riapertura-416` | Da ricontrollare prima del 01/09/2027 | PR 4.9 (banco di prova) |

## Testi e schermate

- La riga di un bambino tornato dice «Classe di oggi» con la classe dell'anno prossimo. Oggi non ha una classe, e la scheda lo dice.
- L'esito `scheda_archiviata` di «Genera la quota» dice «La quota è a posto» senza che esista una voce. Si vede solo dopo una
  chiusura fallita, che ha già l'avviso con «Riprova» e l'invariante notturna.
- L'eliminazione con una riga viva dice «archivialo» anche a chi è già archiviato, dove c'è «Riporta». Stessa finestra.
- «Si rifà scegliendo la classe» vale solo per la primaria.
- `FREQUENZA_NON_VIVA` sulla route della quota parla di «anno di partenza», e `ANNO_NON_APERTO` lì diventa 500: tutti e due solo se
  due persone agiscono nello stesso istante.
- «1 sedi» e «1 giorni» nel controllo di salute dell'anno.
- Con un solo anno offerto, un 422 `ANNO_NON_OFFERTO` nel modulo pubblico non mostra il messaggio. Durante la ricarica, fino a
  8 secondi, Indietro e Invia sono spenti senza spinner.
- Dopo «Togli» nei posti autorizzati i campi restano con i valori di prima.
- Fra la scelta di una domanda e il caricamento delle classi il selettore mostra per un attimo le classi dell'altro anno: il server
  rifiuterebbe comunque.

## Comportamenti rari, misurati e lasciati così

- **Una coordinatrice che archivia toglie anche la voce**, mentre «Ritira» le risponde 403: archiviare è già un suo potere e la
  cancellazione è nel registro delle modifiche.
- **Togliere una voce non ricontrolla la sospensione per morosità** fino al giro notturno: una notte in più in un caso raro.
- **Una voce pagata rimasta dopo un ritiro non cambia importo** se la classe nuova ha un'altra fascia: rimborso e integrazione sono della
  segreteria.
- **Un bambino archiviato, tornato e riarchiviato nello stesso giorno**, alla riattivazione torna `iscritto` senza classe. La regola guarda
  la data, e lo stesso giorno non la distingue.
- **`riaperta` nel riepilogo dell'import si perde** se l'invito fallisce e la domanda viene ripresa il giorno dopo. Resta il log
  `frequenza-anno-registrata`. Il riepilogo non parte se la sede non ha un'email.
- **`riapriFrequenzaProssima` (da «Riporta») riapre anche una riga `trasferito`**: oggi nessuno scrive quello stato su una riga dell'anno
  prossimo.
- **La domanda nuova su una riga chiusa con `domanda_id` già valorizzata** non si collega e il testo dice «collegata»: irraggiungibile oggi.
- **`annoDiQuotaDellaScheda` non distingue un calendario illeggibile da un anno assente**: con un'etichetta stantia la quota del CRM può
  finire nell'anno sbagliato, con un log `info`.

## Prove e strumenti

- La prova 8 di `anno-riga-conferma-in-arrivo` non copre davvero «nessun anno attivo», perché `anno_attivo` conta anche i `chiuso`. Il
  ramo è stato provato a parte dalla ri-revisione e funziona.
- Un `.catch(() => undefined)` inutile nella prova 3 dello stesso file.
- Il lock dei lettori di `alunni` classifica per contenitore: una lettura nuova in un contenitore già classificato resta verde.
- La lettura a blocchi delle conferme si ferma al primo blocco sotto 500 righe: con `max_rows` di Supabase sotto 500 si fermerebbe presto
  in silenzio. Oggi è sopra, e **deve restarci**.
- Commenti rimasti indietro: `conferme/route.ts:71`, `ConfermeClient.tsx:493`, `import/esegui.ts:431,693`, `students/route.ts:139-142`.

## Non verificato

Tutto lo SQL è provato su PGlite, le schermate solo in jsdom. Postgres vero e browser li vede per primo il collaudo dopo il deploy, a
cui è affidata anche l'aria di questi testi. Non è misurato il peso di `anno_invarianti()` in produzione, né quello della vista «Nuove
iscrizioni» su migliaia di righe (oggi le frequenze sono circa 800 in tutte le sedi).
