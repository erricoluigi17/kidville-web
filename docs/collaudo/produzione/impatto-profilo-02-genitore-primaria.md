# Profilo 02 — genitore, scuola primaria

> **Questo NON è un feedback ricevuto.** È la ricostruzione, provata commit per commit, dei difetti
> che un utente con questo profilo poteva incontrare nell'app fra il 6 e il 20 agosto 2026.

## Come si presentava l'app a questo profilo, giorno per giorno

L'app Android è una finestra sul sito di produzione, e la produzione mostra soltanto ciò che è
stato portato sul ramo principale. Fra le due settimane del test chiuso questo cambia la lettura di
qualunque data: quello che un tester vedeva sul telefono non cambiava quando un difetto veniva
corretto, ma quando la correzione veniva rilasciata. Fra il 6 agosto alle 17:52 e l'8 agosto alle
22:54 sul ramo principale non è entrata una riga: per due giorni e mezzo l'app è rimasta ferma
esattamente com'era.

**Dal 6 all'8 agosto.** In quei due giorni e mezzo un genitore di primaria non aveva **nessun modo
di comunicare un'assenza**. Il pulsante non era rotto: non c'era. La voce «Presenze» della barra in
basso, e la scorciatoia della Home, portavano questo profilo a una schermata di sola lettura —
l'elenco delle assenze già registrate dalla maestra — mentre il modulo per comunicarne una nuova
veniva mostrato soltanto alle famiglie di nido e infanzia; e a quelle il server rispondeva che la
funzione era «disponibile solo per la scuola primaria». Le due porte si escludevano a vicenda. Le parole
«Comunica assenza in anticipo» e «Comunica un'assenza, anche per una data futura» erano scritte nel
dizionario della primaria fin da prima del test, e il riquadro che le disegnava esisteva: nessuna
schermata lo montava. Era un pezzo di prodotto finito e scollegato. Nella stessa schermata, l'unica azione
disponibile — giustificare un'assenza firmando con il codice usa e getta — si fermava su un
messaggio generico di errore: il server rispondeva con un guasto senza corpo, e quel guasto
colpiva in tutto otto porte. Sei erano raggiungibili da questo profilo oltre alla firma: scrivere
alla maestra, inviare un modulo per due strade diverse, chiedere il codice di firma per altre due,
rispondere a un avviso. L'ottava era proprio comunicare un'assenza, e a questo profilo era
preclusa dal difetto qui sopra. Sempre in quei giorni, se la lettura del legame fra genitore e
bambino non riusciva, le **venti porte** che verificano quel legame rispondevano negando l'accesso,
come se quel bambino non fosse suo. Sono le porte che alimentano il diario, la galleria,
l'armadietto, le competenze, le giustifiche didattiche, le allergie della mensa, le presenze e
l'intera area della primaria — orario, note, valutazioni, pagella, scrutinio. La chat con la
maestra e i moduli **non** sono fra queste.

**Dall'8 al 15 agosto.** L'8 agosto alle 22:54 arriva in produzione il rilascio che chiude tutto
questo insieme: il modulo per comunicare l'assenza compare per la prima volta dentro la schermata
delle assenze della primaria, le otto porte tornano a rispondere, il caricamento senza fine e le
letture fallite travestite da «nessuna assenza» spariscono, e i dieci testi grigi di quella
schermata — fra cui il motivo scritto dal genitore stesso — passano da un contrasto fuori norma a
uno leggibile. Da lì al 15 agosto sulle schermate della famiglia non cambia più niente. Resta un
solo guasto possibile, e non dipende dalla funzione: se un pezzo del programma non arriva —
rete che cade, applicazione riaperta dopo un rilascio — la scritta «Caricamento…» resta a schermo
per sempre, senza un messaggio e senza un pulsante per riprovare. La rete di protezione che
avrebbe dovuto dirlo esisteva dal 4 agosto e non era collegata a nessuna schermata.

**Dal 15 al 20 agosto.** Il 15 agosto alle 00:25 entrano in app diciassette moduli di carta e la
sezione dei certificati della famiglia. Il certificato che il genitore scaricava da sé nasceva
però ancora dentro il telefono, e usciva con una banda verde inventata, la scritta «KIDVILLE
SCHOOLS» al posto della ragione sociale, l'indirizzo stampato due volte e in calce la firma di un
«Dirigente Scolastico» che in una cooperativa non esiste — quel generatore era in produzione già
prima del 6 agosto, quindi per l'intera durata del test. Nella stessa finestra il modulo di
autorizzazione alla gita non compariva mai, nemmeno quando la gita era stata pubblicata, e la
notifica che la annunciava apriva la linguetta sbagliata. Il 16 agosto alle 11:31 entrambe le cose
vengono chiuse: il certificato nasce dal motore della scuola, con la carta intestata vera e il
numero di protocollo, e il modulo della gita compare quando — e solo quando — la gita esiste. Dal
16 agosto al 20 agosto sul ramo principale non entra più niente che questo profilo potesse vedere.

## I difetti che questo profilo poteva incontrare

| # inv. | Cosa si vedeva a schermo | Gravità | Rotto fino al | Commit | Verificato |
|---|---|---|---|---|---|
| 2 | Nessun pulsante per comunicare un'assenza, in nessuna schermata. «Presenze» apriva un elenco di sola lettura; il modulo per comunicarne una nuova era mostrato solo alle famiglie di nido e infanzia, e a loro il server rispondeva che la funzione era riservata alla primaria. Il riquadro che dava quel pulsante alla primaria era scritto, tradotto e completo — e non era montato da nessuna schermata | bloccante | 8 ago, 22:54 | `f59854ab` | `--stat` + `--contains main`; letto il codice della barra in basso e della Home prima e dopo (riga 90 della barra in basso a `29da34b4`: la primaria va all'elenco, non al modulo); e soprattutto `git grep -n "PrimariaParentView" 29da34b4 -- 'src/*'` → **una sola riga, quella di `export`**: nessuno lo importava |
| 13 | La schermata delle assenze restava su «Caricamento…» senza fine quando il bambino non veniva risolto; e quando la lettura falliva, al posto di un errore compariva la frase «nessuna assenza» — cioè la scuola sembrava non avere niente da mostrare | bloccante | 8 ago, 22:54 | `f59854ab` | `--stat` + `--contains main`; letta la versione precedente della schermata: l'uscita anticipata non spegne l'attesa, e l'esito negativo lascia l'elenco vuoto |
| 1 | Premendo «Conferma» dopo aver ricevuto il codice di firma, la schermata rispondeva con un messaggio generico di fallimento. Lo stesso accadeva su **altre sei** porte raggiungibili da questo profilo: scrivere alla maestra, inviare un modulo per due strade diverse, chiedere il codice usa e getta per altre due, rispondere a un avviso. Le porte guaste erano otto; l'ottava era comunicare un'assenza, che questo profilo non poteva aprire (riga n. 2). Il server rispondeva con un guasto **senza corpo, zero byte** — colpiva tutte le famiglie non sospese | bloccante | 8 ago, 22:54 | `f59854ab` | `--stat` + `--contains main`; `git grep -l "assertGenitoreNonSospeso" 29da34b4 -- 'src/app/api/*'` → **8 file**, di cui uno solo irraggiungibile a questo profilo; letta la descrizione della misura: «HTTP 500, corpo vuoto, zero byte» |
| 33 ⤴ | Le **venti porte** che verificano il legame fra genitore e figlio potevano negare l'accesso come se il bambino non fosse suo, quando in realtà era quella verifica ad essere fallita. Alimentano il diario (quattro), la galleria, l'armadietto (due), le competenze, le giustifiche didattiche, le allergie della mensa, le presenze (tre) e l'area della primaria (sette: assenze, note, orario, valutazioni, scrutinio, e la pagella con la sua firma). **Non** la chat e **non** i moduli. Il rifiuto veniva anche contato fra i tentativi di accesso abusivo, a carico di una famiglia che non aveva fatto niente | bloccante | 8 ago, 22:54 | `f59854ab` | `--stat` + `--contains main`; `git grep -l "requireParent" 29da34b4 -- 'src/app/api/*'` → **20 file**, elencati e classificati uno per uno; letto il confronto fra la versione precedente e quella nuova della verifica |
| 18 | Nell'elenco storico delle assenze le date non portavano l'anno. E una data scritta male nell'archivio non rovinava una riga: faceva **cadere l'intera schermata**, perché la formattazione veniva eseguita mentre la pagina si disegnava | bloccante | 8 ago, 22:54 | `f59854ab` | `--stat` + `--contains main`; letta la riga che formatta la data nella versione precedente: giorno, mese e giorno-della-settimana, senza anno, su un valore non controllato |
| 14 | Il pulsante principale, mentre era spento — cioè proprio mentre si aspettava, o finché il codice di firma non era stato scritto — era quasi illeggibile: contrasto misurato **1,20:1**. Valeva su tutta l'app dal 29 giugno | fastidioso | 8 ago, 22:54 | `f59854ab` | `--stat` + `--contains main`; letta la classe del pulsante prima e dopo, con la misura dichiarata nel codice; `git log main -S'disabled:opacity' -- src/components/ui/Btn.tsx` → `4a6a3455`, 29/06/2026 14:08. ⚠️ **L'inventario apre la finestra a «≤07/08»: la misura dice 29 giugno** |
| 15 (parte primaria) | Nella schermata delle assenze **dieci testi** erano dipinti con un grigio a **2,51:1** su bianco, sotto il minimo di legge: fra questi l'orario di entrata e di uscita, la nota della maestra e il motivo scritto dal genitore stesso | fastidioso | 8 ago, 22:54 | `f59854ab` | `--stat` + `--contains main`; contate le occorrenze nella versione precedente della schermata: esattamente 10, come dichiara la prova aggiunta dal rilascio |
| 20 | Con un pezzo del programma non arrivato — rete caduta, o app riaperta dopo un rilascio — la scritta «Caricamento…» restava a schermo per sempre: nessun messaggio, nessun pulsante per riprovare. Il pannello che avrebbe dovuto dirlo esisteva dal 4 agosto e non era collegato a nessuna schermata | bloccante | 15 ago, 00:25 | `0e8480a3` | `--stat` + `--contains main`; cercato il pannello nell'albero precedente (esiste, nessuno lo monta) e in quello nuovo (montato fra i fornitori globali); `git log main --diff-filter=A --format='%h %ci' -- '*ChunkErrorBoundary*'` → `d244eea7`, 04/08/2026 16:45. ⚠️ **L'inventario dice 03/08: la misura dice 4 agosto** |
| 22 | Il certificato scaricato dall'app usciva con una **banda verde inventata**, la scritta «KIDVILLE SCHOOLS» al posto della ragione sociale, l'indirizzo stampato due volte e in calce «Il Dirigente Scolastico» — una figura che in una cooperativa non esiste. Nasceva dentro il telefono: nessun numero di protocollo, nessuna copia nel fascicolo del bambino | bloccante | 16 ago, 11:31 | `0974424a` | `--stat` + `--contains main`; trovate le righe che stampano quelle parole. ⚠️ **L'inventario data la finestra al 15 agosto: la misura dice che erano lì già il 6**, cioè per tutto il test |
| 24 | Il modulo di autorizzazione alla gita **non compariva mai**, nemmeno quando la gita era stata pubblicata per la sezione del bambino. E la notifica che la annunciava apriva la linguetta «Da Compilare», dove quel modulo non c'era | bloccante | 16 ago, 11:31 | `0974424a` | `--stat` + `--contains main`; nel rilascio del 15 agosto il modulo era spento da un elenco scritto a mano e i dati della gita non venivano costruiti da nessuna parte; il collegamento della notifica puntava a una linguetta che la pagina non leggeva |

**⤴** = riga che nell'inventario sta sotto **A.2 — DOCENTE**, non sotto A.1. Il perché sta al
punto 8 delle verifiche.

## Cosa questo profilo NON poteva incontrare, e perché lo scrivo

Sedici voci della PARTE A — le n. 3, 4, 5, 6, 7, 9, 10, 11, 12, 16, 17, 19, 21, 23, 25, 26 —
riguardano il genitore ma **non questo profilo**, e vanno tolte invece che adattate. Le scrivo perché la ragione per cui cadono è la stessa che rende affidabili le dieci che
restano: la produzione mostra solo ciò che è stato rilasciato.

**I difetti n. 3, 4, 6, 7, 9, 10, 11, 12** — il pulsante d'invio coperto dalla barra di navigazione,
il tocco su «Leggi l'informativa» che faceva partire la comunicazione, il messaggio di rifiuto nato
dietro il piede della schermata, la pagina che scorreva su una schermata e mezza di vuoto, e i
quattro difetti sui dati (il genitore che sovrascriveva l'appello della maestra, l'annullamento che
cancellava una presenza di un giorno qualunque, il motivo sanitario sovrascritto o azzerato in
silenzio, l'app che dichiarava di aver tolto il motivo senza toglierlo) — **sono stati trovati e
corretti dentro la stessa lavorazione, e sono arrivati in produzione già chiusi**, tutti insieme
l'8 agosto alle 22:54. Per quattro di essi c'è una seconda prova indipendente: riguardano il gesto
di comunicare o annullare un'assenza, e fino a quel momento **nessuna famiglia aveva mai potuto
compierlo** — la misura citata dall'inventario, zero notifiche di assenza comunicata da sempre, è
la dimostrazione che non erano raggiungibili.

**Il n. 5** — il campo «Motivo» che finiva sotto il piede della schermata sui telefoni da 640 a
731 px — è stato misurato e corretto sulla schermata **di nido e infanzia**, non su quella della
primaria: la correzione del 9 agosto alle 00:38 tocca quella pagina e la sua testata. Questo profilo
non ci passa.

**Il n. 15 nella sua parte più grave** — i due campi bianchi su bianco con l'Alto Contrasto acceso —
riguarda gli stessi due campi della schermata di nido e infanzia. La parte che tocca la primaria è
in tabella, ed è quella misurata sulla schermata giusta.

**Il n. 16 e il n. 17** — la bolla di sistema in inglese sul campo data e il calendario che si apriva
da solo — sono legati a un campo data che, sul lato primaria, prima dell'8 agosto non esisteva; e il
n. 17 è specifico di iPhone, mentre il test chiuso di cui questo profilo fa parte è su Android.

**Il n. 19** — le due schermate gemelle che dicevano cose diverse, e solo una che spiegava fino a
quando si può ritirare un'assenza — descrive il danno di **chi ha un figlio per grado**: due
prodotti diversi nella stessa app. Questo profilo ha un bambino solo, alla primaria, e vede una
schermata sola. Sul suo lato la frase mancava, ma per una ragione che è già la riga n. 2: mancava
l'intera funzione.

**Il n. 21** — il certificato firmato per il bambino sbagliato — richiede **due figli**: la scheda
dei certificati prendeva sempre il primo dell'elenco. Con un figlio solo il primo dell'elenco è
quello giusto.

**Il n. 23** — il certificato protocollato che usciva di due pagine — non era raggiungibile da un
genitore: fino al 16 agosto il certificato della famiglia non era protocollato affatto (nasceva nel
telefono, senza numero e senza archiviazione, ed è la riga n. 22). Il percorso protocollato è
arrivato in produzione già corretto.

**Il n. 25** — ogni scarico che riemetteva invece di riusare, bruciando un numero di protocollo — si
verificava **fra le 00:00 e le 02:00 del 1° agosto**, le due ore in cui il fuso del server e quello
delle famiglie stanno in due anni scolastici diversi. Il test è iniziato il 6 agosto, e il
certificato protocollato è arrivato in app il 16: la finestra non si è mai aperta.

**Il n. 26** — chi compila il modulo pubblico di iscrizione e firma con il codice non riceve nessuna
conferma — è un modulo pubblico del sito, fuori dall'area con le credenziali, e il bambino di questo
profilo è già iscritto. È plausibile che un genitore lo abbia usato per il nuovo anno; non è
dimostrabile per questo profilo, e quindi non lo conto.

**La PARTE C.1** — la tabella delle candidature rimasta pubblica per trentasette minuti la notte del
20 agosto — è un dato di **chi si candida a lavorare in Kidville**, non di questo profilo né di suo
figlio, e riguarda un modulo che questo profilo non usa. Il difetto è reale ed è stato in produzione;
non tocca questo profilo.

Escluse per regola, senza discussione, la **PARTE B** e la **PARTE C.2**.

## Verifiche eseguite

Tutte in sola lettura. Nessun comando di scrittura, nessun accesso al database, nessun file toccato
oltre a questo.

1. **Presenza e forma di ogni commit citato**: `git show --stat --oneline <hash> | head -20` su
   `f59854ab`, `0e8480a3`, `0974424a`, e sui due commit di contorno `d244eea7` (4 ago, nascita del
   pannello del n. 20) e `29da34b4` (6 ago, ultimo rilascio prima della finestra ferma).
2. **Presenza in produzione**: `git branch --contains <hash> | grep -w main` su tutti e cinque →
   tutti su `main`. Su `ddfe3b0e` (PARTE C.1) lo stesso comando risponde solo
   `feat/candidature-multisede`, coerente con l'inventario.
3. **Nessuno dei commit citati è una fusione con storia intermedia**: `git rev-list --parents -n 1`
   mostra un solo genitore per ciascuno. Da qui il fatto che regge tutto il documento: gli stati
   intermedi delle lavorazioni non sono mai esistiti sul ramo principale, quindi non sono mai stati
   in produzione.
4. **Cronologia del ramo principale nella finestra**: `git log main --since=2026-08-05
   --until=2026-08-21`. Fra `29da34b4` (6 ago 17:52) e `f59854ab` (8 ago 22:54) nessun rilascio;
   ultimo rilascio della finestra `b87ee964` (17 ago 01:35), che non tocca le schermate della
   famiglia.
5. **Lettura del codice prima e dopo**, per ogni riga della tabella: la scelta della destinazione
   nella barra in basso e nella Home; il controllo che rispondeva «disponibile solo per la scuola
   primaria»; la schermata delle assenze della primaria nella sua versione precedente (attesa non
   spenta, esito negativo che lascia l'elenco vuoto, data senza anno, dieci testi grigi contati uno
   per uno); il riquadro della primaria esportato e importato da nessuno; il confronto sulla verifica
   del legame genitore-figlio; il pannello del pezzo mancante cercato in entrambi gli alberi; le
   righe che stampavano «KIDVILLE SCHOOLS» e «Il Dirigente Scolastico», cercate anche nell'albero
   del 6 agosto.
6. **Conteggi, invece di aggettivi**, dove la tabella dà un numero:
   `git grep -l "assertGenitoreNonSospeso" 29da34b4 -- 'src/app/api/*'` → 8 porte guaste (riga
   n. 1); `git grep -l "requireParent" 29da34b4 -- 'src/app/api/*'` → 20 porte protette (riga
   n. 33), classificate una per una prima di riassumerle; occorrenze del grigio fuori norma nella
   schermata delle assenze → 10 (riga n. 15).
7. **Tre scostamenti dall'inventario, tutti dichiarati anche nella riga a cui appartengono.**
   L'inventario è la fonte, non l'ultima parola: dove la misura lo contraddice, in tabella c'è la
   misura.
   - **riga n. 22, finestra**: l'inventario la apre al 15 agosto.
     `git grep -c "KIDVILLE SCHOOLS" 29da34b4 -- 'src/app/(dashboard)/parent/modulistica/page.tsx'`
     → **2**: le scritte erano già lì il 6 agosto, cioè per tutto il test.
   - **riga n. 20, data di nascita**: l'inventario dice 03/08.
     `git log main --diff-filter=A --format='%h %ci' -- '*ChunkErrorBoundary*'` → `d244eea7`,
     **2026-08-04 16:45:18**.
   - **riga n. 14, da quando**: l'inventario dice «≤07/08».
     `git log main -S'disabled:opacity' -- src/components/ui/Btn.tsx` → `4a6a3455`,
     **2026-06-29 14:08:13**: il pulsante spento era illeggibile su tutta l'app da giugno.
8. **Una riga spostata di sezione, dichiarata.** La riga n. 33 sta nell'inventario sotto
   **A.2 — DOCENTE**, ed è marcata «⤴» in tabella. Sta qui perché la verifica che falliva è quella
   del legame fra genitore e figlio, e chi si vedeva negare l'accesso al proprio bambino era il
   genitore: la vittima è questo profilo, la categoria dell'inventario no. Nessun'altra riga viene
   da fuori la sezione A.1.
