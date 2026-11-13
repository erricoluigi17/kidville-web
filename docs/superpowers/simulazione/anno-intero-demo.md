# Simulare l'anno intero in Demo (PR 4.9)

> **La PR 4.9 è in produzione** (le migrazioni M49a e M49b le ha applicate l'integrazione al merge): la simulazione si può fare. Questo
> manuale lo segue la chat principale insieme al titolare; l'agente di una sessione parallela non lo esegue.
> I comandi che scrivono (il tick, il passaggio, il ripristino) li lancia il titolare dall'editor SQL: il freno nega `anno_regole`,
> `DELETE` e `UPDATE` all'agente, giustamente.

## ⚠️ Prima di cominciare: dillo al titolare

**Demo non serve ad altri collaudi finché la simulazione non è finita e il ripristino non è stato eseguito.** Per qualche giorno Demo
«viaggia nel tempo»: i suoi anni cambiano stato, i suoi bambini passano di classe, i suoi gettoni si accumulano. Chi sta collaudando
altro in Demo vede cose che non tornano. Si chiede un sì esplicito, e si scrive la data in cui comincia.

Regole che non si derogano:

- **Non si tocca mai una sede vera.** Il tick e il passaggio con una data nel futuro (`p_oggi`) sono ammessi solo per una sede di prova
  (`e2e0…`) o per una sede in `anno_regole.sedi_simulazione`. **Demo è già una sede di prova**: il suo id comincia per `e2e00000`, quindi il
  database la ammette da sé e il titolare non deve scrivere niente in `sedi_simulazione`. Per una sede che non comincia per `e2e00000` e non è
  in elenco il database rifiuta (`ANNI_TICK_OGGI_NON_AMMESSO`, `PASSAGGIO_OGGI_NON_AMMESSO`): non si cerca un'altra via.
- **Mai nomi, mai codici fiscali, mai righe di anagrafica** nei risultati: conteggi, stati, codici d'errore.
- **L'agente non esegue il ripristino.** Lo esegue il titolare dall'editor SQL.

## Che cosa si può simulare in Demo, e che cosa no

La guardia dell'anno (`ANNO_CHIUSO`, `PASSAGGIO_DA_FARE`, il gettone di correzione) **non è per sede**: è un interruttore solo,
`anno_regole.guardia_attiva`, uguale per tutte le sedi, e un secondo, `anno_regole.guardia_osserva`, per l'osservazione. Oggi in produzione
`guardia_attiva` è falsa e `guardia_osserva` vera. Dunque:

| Che cosa | In Demo, oggi (guardia spenta, in osservazione) | Per vedere il rifiuto vero |
|---|---|---|
| Il tick cambia gli stati degli anni | **Sì, anche a guardia spenta**: per una sede di prova (`e2e00000…`, come Demo) o in `sedi_simulazione` il tick agisce comunque (`anno_stati_aggiorna`: la guardia vale `sede ammessa OR guardia_attiva`) | non serve |
| Il passaggio d'anno (anteprima, conferma, annullo) con la data scelta | **Sì**, con `p_oggi`, da SQL (vedi il passo 6) | non serve |
| `ANNO_CHIUSO`, il dialogo «Registra come correzione», il gettone | **No**: la scrittura PASSA e viene **contata** in `anno_guardia_osservazioni` (tabella, operazione, stato dell'anno). Si vede ciò che la guardia *rifiuterebbe*, non il rifiuto | accendere la guardia per **tutte** le sedi: decisione del titolare, prevista entro il 30/06/2027 dopo due settimane di osservazione. **Non si accende per la simulazione** |
| `PASSAGGIO_DA_FARE` | **No**: confronta l'inizio dell'anno nuovo con l'orologio **vero**, non con `p_oggi` (M49b), e Demo ha l'anno nuovo nel 2027 | l'orologio vero a o dopo l'inizio dell'anno nuovo, senza passaggio (vedi la fine) |
| L'allarme «sedi con il passaggio d'anno da fare» in `salute_anno()` | **No**: `passaggio_da_fare` **esclude** le sedi `e2e00000…` (Demo) e quelle in `sedi_simulazione`, e vale 0 | idem |

Come si simula la correzione dell'anno chiuso (i passi 11-12) con la guardia spenta: si fa la scrittura sul vecchio anno e si guarda
che il contatore salga (`SELECT tabella, op, stato, origine, n FROM public.anno_guardia_osservazioni ORDER BY ultima_il DESC LIMIT 10;`).
Il rifiuto, il dialogo e il gettone li prova il banco automatico (`__tests__/db/anno-gettoni.test.ts`, `anno-intero.test.ts`, `anno-chiusura-scritture.test.ts`),
non Demo.

## Prerequisiti (si controllano con una lettura, nessuno chiede conferma)

1. Le due migrazioni sono applicate: `SELECT to_regproc('public.anno_stati_aggiorna') IS NOT NULL;` → `true`.
2. **La guardia non va accesa per la simulazione** (vedi sopra). Si controlla com'è: `SELECT guardia_attiva, guardia_osserva FROM public.anno_regole;`.
   Con `guardia_attiva` falsa il tick di Demo funziona lo stesso. Solo se il titolare ha già acceso la guardia per tutti (non prima del
   periodo di osservazione) i passi 5, 11 e 12 daranno il rifiuto vero invece del conteggio, per **tutte** le sedi.
3. **Demo è già ammessa come sede di prova** (l'id comincia per `e2e00000`): `sedi_simulazione` può restare com'è, vuoto, e il titolare non scrive niente.
   `sedi_simulazione` serve solo per simulare in una sede che NON comincia per `e2e00000`: allora la scrive lui, e solo quella sede
   (`UPDATE public.anno_regole SET sedi_simulazione = ARRAY['<SEDE>']::uuid[];`, il segnaposto lo sostituisce lui; qui non c'è l'uuid e non ci deve
   essere). Il ripristino accetta la sede se comincia per `e2e00000` oppure se è l'unica in elenco; una sede vera fuori elenco, o in un elenco di due, lo ferma.
4. Le invarianti sono pulite: `SELECT count(*) FROM public.anno_invarianti() WHERE righe <> 0;` → `0`.

## La fotografia di partenza (si salva prima di tutto)

Si salvano **solo conteggi e stati**, in un file `.md` in `docs/collaudo/risultati/` (cartella esclusa da git), mai nomi:

```sql
-- gli anni di Demo e il loro stato: serve al ripristino (la lista `_stati_iniziali` di ripristino-demo.sql)
SELECT s.etichetta_breve, a.stato, a.domande_aperte, a.inizio, a.ultimo_giorno_aperto, a.fine, a.id AS anno_sede_id
  FROM public.anni_sede a JOIN public.anni_scolastici s ON s.id = a.anno_id
 WHERE a.scuola_id = '<DEMO>' ORDER BY a.inizio;

-- quanto lavoro c'è
SELECT count(*) FROM public.frequenze   WHERE scuola_id = '<DEMO>';
SELECT count(*) FROM public.sections    WHERE scuola_id = '<DEMO>';
SELECT count(*) FROM public.passaggi_anno WHERE scuola_id = '<DEMO>';
SELECT count(*) FROM public.correzioni_anno_chiuso c
  JOIN public.anni_sede a ON a.id = c.anno_sede_id WHERE a.scuola_id = '<DEMO>';
```

E la **data di partenza** (oggi, con l'ora **e il fuso**, per esempio `2026-11-20 09:00:00+01`): serve al ripristino per sapere cosa è stato
scritto dopo. Il ripristino la rifiuta se è nel futuro o se è più vecchia della nascita di uno degli anni di Demo.

## I passi (le date vengono dalla fotografia: `U` = `ultimo_giorno_aperto` e `F` = `fine` dell'anno corrente di Demo)

Il giorno si passa sempre come `p_oggi`. Il tick è `SELECT public.anni_tick(DATE 'AAAA-MM-GG', '<DEMO>');` dall'editor SQL del titolare.
**L'ordine è quello vero del calendario**: il tick delle 00:10 di `U + 1` porta il vecchio anno a `in_chiusura`; **poi**, la mattina, la
segreteria fa il passaggio. Il tick non fa mai il passaggio e non promuove mai a `corrente`.

La colonna «atteso» vale per la guardia **in osservazione** (com'è oggi): le scritture passano e si contano. Se la guardia è già accesa
per tutti, dove scritto «passa e si conta» su un anno `chiuso` si legge `409 ANNO_CHIUSO`, e su un `in_chiusura` lo staff passa senza gettone.

| # | Quando (`p_oggi`) | Cosa si fa | Cosa deve succedere | Cosa si guarda |
|---|---|---|---|---|
| 1 | metà anno | `anni_tick` | niente cambia di stato | `anni_sede`: l'anno corrente resta `corrente` |
| 2 | un mese prima di `U` | si apre l'anno nuovo alle iscrizioni (Impostazioni di sede › Anno scolastico) | l'anno nuovo è `iscrizioni_aperte`, le classi continuano | schermata segreteria; invarianti `0` |
| 3 | `U` | `anni_tick` | niente cambia: l'ultimo giorno aperto è ancora `corrente` | stati invariati |
| 4 | `U + 1` | `anni_tick` | **il vecchio diventa `in_chiusura`** con `domande_aperte` falso; il nuovo resta `iscrizioni_aperte` (nessun anno è `corrente` nell'intervallo fino al passo 6: è l'ordine vero) | stati; una riga in `anni_sede_stati`; invarianti `0` |
| 5 | `U + 1` | una scrittura dello staff sul vecchio anno, per esempio una presenza dall'appello (è una scrittura di **oggi**, orologio vero: cade nel vecchio anno) | su un anno `in_chiusura` lo staff scrive **senza gettone**: la scrittura passa e viene contata | il contatore in `anno_guardia_osservazioni` sale di 1, nessun gettone creato |
| 6 | `U + 1` | **il passaggio**: anteprima e decisioni dalla schermata `/admin/students/passaggio`, **conferma da SQL con `p_oggi`** (vedi sotto) | nuovo `corrente`; il vecchio resta `in_chiusura` con `domande_aperte` falso | schermate docente (classi del vecchio anno in sola lettura, «anno che si sta chiudendo»), genitore, segreteria; invarianti `0` |
| 7 | `U + 1` | `anni_tick` | **non cambia niente**: la conferma ha già mosso gli stati | stati identici al passo 6 |
| 8 | `U + 1` | **annullare** (SQL, vedi sotto) con una presenza già presa nel nuovo anno | rifiuto `PASSAGGIO_NON_ANNULLABILE` | il codice d'errore, mai la riga |
| 9 | `F` | `anni_tick` | il vecchio è ancora `in_chiusura` | stati |
| 10 | `F + 1` | `anni_tick` | il vecchio diventa `chiuso`, il nuovo resta `corrente` | stati; la sola lettura per i docenti è «anno passato» |
| 11 | `F + 1` | la segreteria scrive sul vecchio anno (una scrittura di **oggi**) | in osservazione: **passa e si conta** con stato `chiuso`. A guardia accesa: `409 ANNO_CHIUSO` col dialogo «Registra come correzione», e col motivo (almeno 8 caratteri) passa e lascia un gettone | il contatore in `anno_guardia_osservazioni` con `stato = 'chiuso'`; con la guardia accesa la riga in `correzioni_anno_chiuso` (solo il conteggio) e il log senza motivo |
| 12 | `F + 1` | un docente prova a scrivere sul vecchio anno | rifiutato per la classe in sola lettura, nessun dialogo, nessun gettone nuovo (dipende da `controlli_rigidi`: se è spento si legge il contatore, non il rifiuto) | nessun gettone nuovo |

Il passo 8 richiede una presenza **datata nel nuovo anno**: si prende dalla schermata se lascia scegliere una data del nuovo anno. Se non
lo permette, il passo non si prova in Demo ma nel banco automatico (`__tests__/db/anno-passaggio-conferma.test.ts`, `anno-intero.test.ts`).

### Il passo 6 e il passo 8 da SQL

**Perché da SQL.** Dalla schermata la conferma usa l'orologio **vero**: in Demo darebbe `409 PASSAGGIO_TROPPO_PRESTO` (la data vera è prima di
`U`), e un `{ "oggi": … }` nel corpo della richiesta dà `400` (la route non accetta campi in più). L'anteprima invece non dipende dal giorno e
va bene dalla schermata. Le firme: `passaggio_anteprima(p_da_anno_sede, p_a_anno_sede, p_da, p_oggi)`, `passaggio_conferma(p_passaggio, p_da, p_oggi)`,
`passaggio_annulla(p_passaggio, p_da, p_oggi)`; `p_da` è l'uuid dell'utente che compie il gesto (il tuo, da `utenti`), `p_oggi` la data simulata.

```sql
-- gli id: l'anno_sede del vecchio e del nuovo (dalla fotografia: colonna anno_sede_id)

-- anteprima (in alternativa alla schermata). Dà indietro {passaggio_id, …}
SELECT public.passaggio_anteprima('<ANNO_SEDE_VECCHIO>'::uuid, '<ANNO_SEDE_NUOVO>'::uuid, '<UTENTE>'::uuid, DATE 'AAAA-MM-GG');

-- le decisioni sulle righe senza classe o «ritirato dalla tendina» si prendono dalla schermata /admin/students/passaggio
-- (altrimenti la conferma risponde RIGHE_DA_DECIDERE e dice quante).

-- conferma, con la data simulata U + 1
SELECT public.passaggio_conferma('<PASSAGGIO>'::uuid, '<UTENTE>'::uuid, DATE 'AAAA-MM-GG');

-- passo 8: l'annullo (rifiutato se nel nuovo anno c'è già una presenza)
SELECT public.passaggio_annulla('<PASSAGGIO>'::uuid, '<UTENTE>'::uuid, DATE 'AAAA-MM-GG');
```

Codici d'errore da aspettarsi: `PASSAGGIO_TROPPO_PRESTO` (la data è `U` o prima), `PASSAGGIO_NON_PRONTO` (il nuovo non è `iscrizioni_aperte`, o il
vecchio non è l'anno attivo), `PASSAGGIO_OGGI_NON_AMMESSO` (la sede non comincia per `e2e00000` e non è in `sedi_simulazione`), `RIGHE_DA_DECIDERE`, `ANTEPRIMA_VECCHIA` (rifai l'anteprima).

### Se il passo 6 non viene fatto

Se si salta dal passo 4 al 9, e poi al 10, il tick porta il vecchio a `chiuso` e il nuovo resta `iscrizioni_aperte`, senza anno `corrente`.
In Demo **non** compaiono né l'allarme «sedi con il passaggio d'anno da fare» (`salute_anno()` → `passaggio_da_fare` vale 0 per le sedi di prova `e2e00000…`, come Demo, e per quelle in
`sedi_simulazione`) né `PASSAGGIO_DA_FARE` (confronta l'orologio vero): una presenza datata nel nuovo anno **passa**, mentre una scrittura di **oggi**
cade nel vecchio anno chiuso e, a guardia accesa, prende `ANNO_CHIUSO`. Lo scenario si guarda negli stati, non nei rifiuti.

Ad ogni passo: `SELECT * FROM public.anno_invarianti() WHERE righe <> 0;` → nessuna riga. Un'invariante rossa ferma la simulazione e
si apre un difetto: non si prosegue.

## Che cosa questa simulazione non prova, e quando rifarlo

Tutto ciò che dipende dall'orologio **vero** o dall'interruttore **globale** non si prova in Demo con le date simulate: `PASSAGGIO_DA_FARE`, l'allarme
della salute, il rifiuto `ANNO_CHIUSO` con il dialogo e il gettone, i job notturni che scrivono sul registro con la guardia accesa.

**Da rifare a metà giugno 2027**, con l'orologio vero, nelle due settimane di osservazione che precedono l'accensione (entro il 30/06/2027):
la guardia è ancora in osservazione e il calendario vero di Demo è vicino ai suoi confini. Per far cadere l'orologio vero **dentro** il periodo
da provare si sposta il confine fra due anni di Demo con `public.sposta_confine_anno(p_anno_sede, p_nuova_fine)` (sposta la fine del primo e
l'inizio del successivo; rifiuta `CONFINE_NON_VALIDO` se la nuova fine precede l'`ultimo_giorno_aperto` del primo o l'inizio del successivo
non precede la sua fine, `ANNO_CHIUSO` se uno dei due è `chiuso`, `CONFINE_CON_RIGHE` se nei giorni che cambiano anno ci sono righe già assegnate).
Poi si ripetono i passi 5, 6, 11 e 12 **senza** `p_oggi` finto, e il titolare decide se accendere la guardia per tutti.

## Dopo: il ripristino

Il file `docs/superpowers/simulazione/ripristino-demo.sql` è **un blocco solo**: `BEGIN; DO $ripristino$ … $ripristino$; COMMIT;`. Non c'è un secondo invio.

1. Il titolare apre il file nell'editor SQL e legge in cima **che cosa cancella e che cosa no** (gettoni, passaggi e cronologia degli stati
   dopo la partenza, e gli stati degli anni; **non** le frequenze, le classi, le presenze, i voti, i pagamenti, né gli anni nati dalla simulazione).
2. Compila i tre punti marcati «DA COMPILARE»: l'uuid di Demo al posto di `<DEMO>`, la data di partenza al posto di `AAAA-MM-GG`, e le righe della
   fotografia al posto di `('AAAA/AA', 'corrente', false)` (una riga per anno: etichetta, stato, domande aperte).
3. Lo invia **tutto in una volta**. Il `COMMIT` è già nel file, dopo il blocco: **non** si scrive un secondo `COMMIT;` né un `ROLLBACK;`. Se il
   blocco si ferma da solo (`RIPRISTINO_SEGNAPOSTO`, `RIPRISTINO_SEDE_NON_DI_PROVA`, `RIPRISTINO_SEDI_NON_UNA`, `RIPRISTINO_SEDE_DIVERSA`, `RIPRISTINO_DATA`, `RIPRISTINO_FOTOGRAFIA`,
   `RIPRISTINO_CONTEGGI`) l'invio si interrompe lì, il `COMMIT` non parte e **non è cambiato niente**: si corregge ciò che dice il codice e si
   rinvia. Se l'editor risponde «current transaction is aborted», si invia `ROLLBACK;`. Se l'editor rifiutasse più istruzioni in un invio solo,
   si tolgono `BEGIN;` e `COMMIT;`: il blocco da solo è già atomico.
4. Se riesce, l'ultima tabella mostra gli stati finali di Demo, le frequenze da guardare a mano e le invarianti non a zero. **Dopo un passaggio
   confermato è normale che resti un'invariante** (sul banco di prova l'11 su `alunni`): tornano gli stati degli anni, non i bambini. Si decide a
   mano se bonificarli: Demo è una sede di prova, ma il titolare può averci messo dati propri.
5. Se per la simulazione era stata messa una sede in `sedi_simulazione`, la si toglie (`UPDATE public.anno_regole SET sedi_simulazione = '{}'::uuid[];`; per Demo non serve) e, se il titolare aveva cambiato la guardia, la si
   riporta com'era (con la data nel PRD).

**Che cosa è provato e che cosa no.** Il file è eseguito nel banco automatico (`__tests__/db/anno-ripristino-demo.test.ts`, PGlite), con la stessa
esecuzione multi-istruzione, su una simulazione vera: si ferma con una sede vera in elenco, con un segnaposto rimasto, con una data fuori posto; riesce
dopo una conferma vera. **Non è mai stato eseguito dall'editor SQL di Supabase**: che `BEGIN; DO …; COMMIT;` in un invio solo si comporti così lì
è la prima cosa da guardare alla prima esecuzione, con una fotografia salvata.

## Come si registra l'esito

Un file `docs/collaudo/risultati/simulazione-anno-intero-AAAA-MM-GG.md` (non va in git): per ogni passo, lo stato letto, il codice
d'errore se c'è stato un rifiuto, il contatore delle osservazioni, le invarianti, e se la schermata ha detto ciò che doveva. Conteggi e codici, mai nomi.

## Azzerare l'anno nuovo

`ripristino-demo.sql` rimette gli **stati** degli anni e toglie gettoni, passaggi e cronologia, ma lascia frequenze, voci di pagamento, sezioni,
domande, listino, moduli e posti dell'anno nuovo. Quando un agente di collaudo deve trovare il 2027/28 della Demo **come appena nato** (il
secondo dopo il primo; l'utente inesperto che parte da zero), si usano due file in più:

- `fotografa-anno-nuovo-demo.sql`: **sola lettura**, si esegue **prima** dei collaudi. Restituisce `sede_di_prova` (deve dire `true`), `anni_candidati`
  (deve dire `1`) e la `fotografia`, un testo JSON da copiare. L'istante dello scatto sta dentro la fotografia (`scattata_il`, versione 2): è la partenza, non va annotato né scritto.
- `azzera-anno-nuovo-demo.sql`: lo esegue il titolare **dopo** il ripristino (mai prima: se l'anno nuovo è ancora `corrente`, o restano passaggi,
  si ferma con `AZZERA_PRIMA_IL_RIPRISTINO`). Si compilano due punti (l'interruttore è un terzo gesto: vedi sotto): l'uuid di Demo al posto di `<DEMO>` e la
  fotografia al posto di `<FOTOGRAFIA>` (dentro `$foto$ … $foto$`). Si invia **tutto in una volta**; il `COMMIT` è già nel file.

**Prova a secco (sempre il primo passo).** Nel file c'è un interruttore, `c_prova_a_secco`, **acceso per difetto**. Con l'interruttore acceso il file
fa tutto e poi si ferma con l'errore `AZZERA_PROVA_A_SECCO`: nel **messaggio** dell'errore c'è il riassunto (una voce per riga: quante righe avrebbe
tolto, rimesso, lasciato; gli uuid delle domande che toglierebbe; gli uuid delle righe lasciate; le invarianti non a zero). L'errore annulla ogni cosa,
quindi non cambia niente, e il `COMMIT;` in fondo non viene raggiunto (se l'editor lo invia lo stesso, è un `ROLLBACK`). Per scrivere davvero si
mette `false`: un gesto in più, nel verso giusto. **Che cosa dimostra:** che il file è accettato dall'editor, che la sede e la fotografia sono
quelle giuste e che ogni colonna nominata esiste. I vincoli differiti di `anni_sede` (continuità del calendario, sovrapposizioni) li giudica la prova stessa, perché lo script esegue `SET CONSTRAINTS ALL IMMEDIATE` prima dei conti finali: non si scoprono al `COMMIT` dell'esecuzione vera. **Che cosa non dimostra:** subito dopo la fotografia non c'è ancora niente di nato dopo la
partenza, quindi il riassunto è fatto di zeri e il passo che toglie gli anni nati nel collaudo non gira. Quello si vede solo rifacendo la prova
**dopo** un collaudo, prima di spegnere l'interruttore.

**Ordine.** fotografia → prova a secco → collaudo → `ripristino-demo.sql` → prova a secco di nuovo (ora vede davvero che cosa c'è da togliere) → `azzera-anno-nuovo-demo.sql` con `c_prova_a_secco := false` → (se serve) collaudo successivo. Dopo una prova la sessione resta in una transazione abortita: se l'editor riusa la connessione, il primo invio vero si ferma su `BEGIN` con «current transaction is aborted». Prima di rilanciare si invia da solo `ROLLBACK;`, oppure si apre una scheda nuova dell'editor. E la `SELECT` finale lanciata a parte dopo una prova può mostrare l'esito di un'esecuzione vecchia, non quello della prova: l'esito della prova è nel messaggio dell'errore. La fotografia si rifà solo se
l'anno nuovo viene preparato di nuovo a mano; per il collaudo successivo vale la stessa.

**Che cosa fa.** Solo nella Demo e solo righe nate dopo la partenza: toglie le frequenze dell'anno nuovo (con le spunte), le voci di pagamento, le
domande del modulo pubblico, gli alunni nati dopo la partenza, le sezioni dell'anno nuovo con le loro copie; **rimette le frequenze dell'anno corrente com'erano nella fotografia** (stato, data di uscita e «no»: la conferma del passaggio fa uscire chi non ha risposto e chi ha detto «no», e il ripristino non le ritocca; un «no» scritto prima della partenza resta), e la scheda dell'alunno si riallinea da sola;
toglie gli **anni nati durante il collaudo** (con il viaggio nel tempo il tick fa nascere il 2028/29: senza questo passo il selettore ne mostrerebbe tre); rimette stato, domande aperte, listino, moduli e posti **come nella fotografia, con gli stessi uuid**. Ciò che ha un legame **resta e si elenca per
uuid** (una voce con incasso, fattura o movimento; un alunno con righe altrove; una sezione ancora usata): le decide il titolare. L'ultima tabella
dice, per tabella, quante righe sono state tolte, rimesse, lasciate, poi gli uuid delle lasciate e le invarianti non a zero.

**Codici d'errore** (il messaggio dell'eccezione è il codice; un codice ferma tutto e non cambia niente):

| Codice | Vuol dire |
|---|---|
| `AZZERA_SEGNAPOSTO` | la sede o la fotografia sono ancora i segnaposto (o la fotografia non è un JSON) |
| `AZZERA_SEDE_NON_DI_PROVA` | la sede non comincia per `e2e00000` e non è l'unica in `anno_regole.sedi_simulazione` |
| `AZZERA_DATA` | lo scatto della fotografia è nel futuro, o non torna con i suoi conteggi (le righe «di prima» non sono quante la fotografia dice) |
| `AZZERA_ANNO_NUOVO_NON_UNO` | la sede non ha **un solo** anno `in_preparazione` o `iscrizioni_aperte` nato prima della partenza (una data troppo vecchia finisce qui) |
| `AZZERA_PRIMA_IL_RIPRISTINO` | l'anno nuovo è già `corrente`, oppure restano passaggi dopo la partenza, oppure l'anno di partenza non è tornato `corrente` |
| `AZZERA_PROVA_A_SECCO` | l'interruttore `c_prova_a_secco` è acceso (lo è per difetto): il messaggio porta il riassunto, non è stato scritto niente. Per scrivere davvero si mette `false` |
| `AZZERA_CONFINE_CON_RIGHE` | rimettere le date dei due anni farebbe cadere nell'anno sbagliato righe nate o cambiate nel collaudo nei giorni di un confine spostato: il messaggio dà i conteggi per tabella, non si tocca niente. Cosa fare: trovarle (vedi «Le date degli anni»), toglierle a mano, rilanciare |
| `AZZERA_FREQUENZA_SPARITA` | una frequenza dell'anno di partenza della fotografia non esiste più: non si può rimetterla, si ferma tutto |
| `AZZERA_ANNI_NATI_USATI` | a un anno nato nel collaudo punta ancora altro, di **qualunque** tabella (sezioni, frequenze, domande, voci di pagamento, presenze, valutazioni…): il messaggio dice i conteggi per tabella, non si tocca niente. Cosa fare: guardare quelle righe (sono dati del collaudo datati nell'anno nato col viaggio nel tempo) e toglierle a mano, poi rilanciare |
| `AZZERA_FOTOGRAFIA` | la fotografia è della versione 1 o non ha `scattata_il` (si rifà con `fotografa-anno-nuovo-demo.sql`), non ha la forma attesa (anche le quattro date dei due anni), è di un altro anno, o contiene righe di un altro anno |
| `AZZERA_CONTEGGI` | dopo il lavoro restano righe nate dopo la partenza che non sono tra le «lasciate», o la configurazione non coincide con la fotografia |

**Le domande tolte.** Non hanno copia nella scatola nera: l'esito elenca una riga `domanda tolta · <uuid>` per ognuna, oltre al numero.

**Le dipendenze di secondo livello.** Una sezione la cui materia ha ancora una valutazione, un registro o uno scrutinio attaccato, o a cui è
assegnato un menù della mensa, **resta** ed è elencata; lo stesso una voce di pagamento con una quota a cui punta un incasso. Il motivo: togliere
la riga farebbe fallire il lavoro con un errore di chiave esterna, oppure scollegherebbe l'altra riga senza dirlo.

**Le date degli anni.** La fotografia contiene `inizio`, `fine`, `ultimo_giorno_aperto` e `prepara_successivo_dal` dell'anno nuovo e dell'anno
di partenza; lo script le rimette **dopo** le cancellazioni (con un solo aggiornamento, perché i vincoli di continuità si giudicano sul
risultato). Se il collaudo ha spostato un confine fra i due anni con `sposta_confine_anno`, torna dov'era. Attenzione: `sposta_confine_anno`
**non trascina righe** con sé, e rifiuta lo spostamento se nei giorni che cambiano anno c'è già qualcosa. Il rischio vero sono le righe **nate
dopo** lo spostamento, dentro i giorni spostati (presenze, diario, registro, mensa, avvisi…): assegnate all'anno nuovo, con una data che dopo il
ripristino del confine apparterrebbe all'anno vecchio. Lo script le conta con lo stesso criterio di `sposta_confine_anno` e, se ne trova, si
ferma con `AZZERA_CONFINE_CON_RIGHE`, i conteggi per tabella e, per ogni anno colpito, i giorni (`dal`, `al`) e gli id dell'anno (`anni_sede` e anno scolastico), senza cambiare niente. Come trovarle: per ogni tabella nominata nel messaggio,
le righe della Demo con la data fra il confine del collaudo e quello della fotografia, cioè nei giorni `dal`–`al` del messaggio (la tabella `anno_tabelle` dice quale colonna è la data; per `pagamenti` conta anche `scadenza` quando `periodo_competenza` è vuoto; per `frequenze` contano `data_ingresso` e `data_uscita`);
si tolgono a mano (sono righe nate o cambiate nel collaudo) e si rilancia. Per le **frequenze** il criterio è lo stesso (anno, sede, `data_ingresso` o `data_uscita` nei giorni) con una sola eccezione: la **data d'uscita** delle frequenze della fotografia non conta, perché il passo successivo la rimette com'era (se il collaudo ha allungato l'anno e confermato il passaggio, le ha fatte uscire proprio in quei giorni). La **data d'ingresso** conta sempre. Se il messaggio segnala una frequenza che sta nella fotografia, il collaudo le ha cambiato la data d'ingresso: **si rimette la data, non si cancella la riga** (una frequenza della fotografia non si cancella mai a mano).

**Quello che nasce accogliendo una domanda.** Accogliere una domanda dall'app crea più di un alunno: i legami con i genitori
(`legame_genitori_alunni`, `student_parents`) e l'invito con le credenziali (`iscrizioni_inviti_credenziali`). Questi **vanno via** insieme
all'alunno e alla domanda che lo script toglie (sono della Demo e nati dopo la partenza), così l'anno nuovo torna davvero «appena nato».
Restano invece, **elencati per uuid** fra le righe lasciate, gli **account** creati accogliendo la domanda (`parents`, `utenti`: li cancella solo
chi sa che nessuno li usa) e il **CRM** (`crm_bambini`, `crm_schede`): un bambino del CRM che punta all'alunno o alla domanda li trattiene, e
l'elenco dice perché quell'alunno non se n'è andato. Per le righe lasciate si decide a mano; l'invariante 11 conta gli alunni «in arrivo» rimasti
senza più la frequenza nuova.

**Che cosa non rimette.** Le spunte dei moduli di frequenze nate prima della partenza se un modulo è stato cambiato; gli **account** dei genitori
(`parents`, `utenti`) creati accogliendo una domanda: restano, e se sono nati dopo la partenza si elencano. Il legame con l'alunno e l'alunno
vanno via.

**Provato e no.** Il banco di prova ha le colonne della produzione per ogni tabella che lo script nomina, e `__tests__/db/anno-azzera-colonne.test.ts`
confronta ogni colonna dello script con una fotografia delle colonne di produzione (si rigenera con `__tests__/fixtures/colonne-azzera-fotografia.mjs`).
`__tests__/db/anno-azzera-demo.test.ts` (PGlite, stessa esecuzione multi-istruzione): un caso per codice più il caso principale, con
l'impronta md5 delle righe di prima e delle altre sedi. **Mai eseguito dall'editor SQL di Supabase**: alla prima esecuzione si guarda che
`BEGIN; CREATE FUNCTION; DO; DROP FUNCTION; COMMIT;` in un invio solo si comporti come sul banco.
