/**
 * CHE COSA SIGNIFICA «NON PIÙ ISCRITTO», DETTO IN UN POSTO SOLO.
 *
 * `alunni.stato` è una `varchar` **senza vincolo `CHECK`** (misurato il
 * 2026-08-12 su `pg_constraint`: sulla tabella non esiste alcun check su questa
 * colonna) e la PATCH di `admin/students` la valida con `z.unknown()`. Nella
 * colonna può quindi finire qualunque stringa. Il prodotto oggi ne produce tre,
 * ed è `STATI_TENDINA` a dirlo: `iscritto`, `ritirato`, `sospeso`.
 *
 * ─── LA TERZA MISURA: COSA C'È DAVVERO IN COLONNA ────────────────────────────
 *
 * Le due misure qui sopra dicono che cosa il database CONSENTE e che cosa il
 * prodotto SA PRODURRE. Nessuna delle due risponde alla domanda che decide se il
 * passaggio da negazione (`.neq('stato','iscritto')`) ad allowlist
 * (`.in('stato', [...STATI_NON_PIU_ISCRITTO])`) lascia qualcuno fuori: **quali
 * valori ci sono adesso nelle righe vere**. Una restrizione toglie dai candidati
 * all'oblio ogni riga con uno stato fuori elenco, e se in produzione esistesse un
 * `trasferito` la famiglia non potrebbe più esercitare l'art. 17 dal prodotto.
 *
 * Eseguita sul database di produzione il 2026-08-12, invece che dedotta:
 *
 *     select stato, count(*), count(anonimizzato_il) from alunni group by stato;
 *     → una sola riga:  iscritto | 33 | 0
 *
 * Nessuno stato fuori dall'allowlist, nessun alunno già anonimizzato: la
 * restrizione **non orfana nessuno oggi**. Il sospetto era però fondato, ed è il
 * motivo per cui questa misura sta scritta qui e non lasciata al prossimo che
 * passa: le fixture PRECEDENTI usavano `'non_iscritto'`, un quarto valore che
 * nella tendina non esiste e che nel database non è mai esistito — cioè il team
 * aveva già dato per buono uno stato che non c'era.
 *
 * ⚠️ È una fotografia, non un invariante: 33 righe oggi non impediscono a un
 * `UPDATE` a mano di scriverne una quarta domani. Il presidio che non invecchia è
 * la sonda di `admin/gdpr/candidates`, che conta gli stati fuori elenco e li
 * dichiara in `app_log` invece di lasciarli sparire dall'elenco in silenzio.
 *
 * ⚠️ IL DIFETTO CHE QUESTO MODULO CHIUDE — era in produzione.
 * `admin/gdpr/candidates` selezionava i candidati al diritto all'oblio con
 * `.neq('stato', 'iscritto')`, e `admin/gdpr/richieste` decideva chi
 * anonimizzare con `f.stato !== 'iscritto'`. Sono NEGAZIONI: dicono «tutto
 * tranne uno», quindi un bambino soltanto **sospeso** — che è iscritto a tutti
 * gli effetti — compariva fra i candidati a un'anonimizzazione irreversibile,
 * insieme a ogni stato che qualcuno aggiungerà in futuro, senza chiedere il
 * permesso a nessuno.
 *
 * Qui il confine è un ELENCO CHIUSO. La differenza non è stilistica: un elenco
 * che si allarga da solo verso l'unica operazione dell'applicazione che non ha
 * un annulla è un incidente che aspetta una tendina.
 *
 * ─── CHE COSA DIVENTA ROSSO SE QUALCUNO AGGIUNGE UNO STATO ───────────────────
 *
 * Fino al 2026-08-12 questa testata prometteva che ad accorgersene sarebbe stato
 * `__tests__/lib/alunni-stato.test.ts`. **Era falso, ed è stato misurato in
 * collaudo il 2026-08-12**: aggiungendo `<option value="trasferito">` alla
 * tendina di `StudentDetailPanel.tsx`, 997 test restavano verdi — perché quel file importa
 * solo da qui e la tendina non la vede nessuno. La via per cui uno stato nuovo
 * entra davvero in produzione è la `<select>`, non questo modulo.
 *
 * Il presidio vero sono DUE file, e insieme chiudono il giro:
 *   · `__tests__/architecture/stati-alunno-classificati.test.ts` legge i `value=`
 *     delle `<option>` nelle due tendine di sorgente e pretende che l'insieme sia
 *     esattamente `STATI_TENDINA`;
 *   · `__tests__/lib/alunni-stato.test.ts` pretende che OGNI voce di
 *     `STATI_TENDINA` stia da una parte sola del confine — `STATO_ISCRITTO`
 *     oppure `STATI_NON_PIU_ISCRITTO`.
 * Uno stato nuovo rende rosso il primo; classificarlo «e basta» non spegne il
 * secondo finché qualcuno non decide di che parte sta. Che è il punto.
 *
 * ⚠️ Da non confondere con la colonna booleana `alunni.sospeso`, che è un'altra
 * cosa: la sospensione per morosità (`@/lib/pagamenti/sospensione`). Il valore
 * `'sospeso'` di questa colonna e quel booleano non si parlano.
 */

/** L'unico stato che significa «frequenta». È anche il `DEFAULT` della colonna. */
export const STATO_ISCRITTO = 'iscritto'

/** Lo stato in cui l'archiviazione mette l'alunno: anagrafica intatta, fuori dagli elenchi. */
export const STATO_RITIRATO = 'ritirato'

/** Terra di mezzo: il bambino frequenta ancora, la sua pratica è ferma per un motivo. */
export const STATO_SOSPESO = 'sospeso'

/**
 * GLI STATI CHE IL PRODOTTO SA PRODURRE — le voci delle due tendine.
 *
 * Non è documentazione: è ciò che
 * `__tests__/architecture/stati-alunno-classificati.test.ts` confronta con i
 * `value=` scritti in `StudentDetailPanel.tsx` e in `admin/students/page.tsx`.
 * Aggiungere una `<option>` senza aggiungerla qui è rosso; aggiungerla qui senza
 * classificarla è rosso in `__tests__/lib/alunni-stato.test.ts`.
 */
export const STATI_TENDINA = [STATO_ISCRITTO, STATO_RITIRATO, STATO_SOSPESO] as const

export type StatoTendina = (typeof STATI_TENDINA)[number]

/** Le due sole parti del confine. Non c'è un «dipende». */
export type LatoDelConfine = 'ancora-iscritto' | 'non-piu-iscritto'

/**
 * DOVE STA OGNI STATO — la decisione, presa una per una e scritta qui.
 *
 * È un `Record` sull'unione esatta di `STATI_TENDINA`, e questo lo rende il
 * punto in cui non si può passare distratti: aggiungere una voce alla tendina
 * senza aggiungerla qui **non compila** (`tsc --noEmit` rosso, chiave mancante),
 * e `__tests__/lib/alunni-stato.test.ts` lo ridice a runtime.
 *
 * Un elenco `STATI_NON_PIU_ISCRITTO` scritto a mano sarebbe stato più corto e
 * avrebbe avuto un difetto: uno stato nuovo semplicemente non ci sarebbe finito,
 * in silenzio, ricadendo dalla parte «protetta» senza che nessuno lo decidesse.
 * Ricadere dalla parte protetta è il verso giusto in cui sbagliare — ma è
 * comunque una decisione presa da una dimenticanza, e qui le decisioni le
 * prendono le persone.
 */
export const LATO_DEL_CONFINE: Record<StatoTendina, LatoDelConfine> = {
  [STATO_ISCRITTO]: 'ancora-iscritto',
  [STATO_RITIRATO]: 'non-piu-iscritto',
  // La terra di mezzo, e il difetto che questo modulo ha chiuso: `sospeso` è un
  // bambino che frequenta. Sta dalla parte protetta, e ci sta per decisione.
  [STATO_SOSPESO]: 'ancora-iscritto',
}

/**
 * ALLOWLIST — gli unici stati che valgono «non più iscritto».
 *
 * Non è `tutto tranne STATO_ISCRITTO`, ed è il punto di questo file: solo ciò
 * che è qui dentro può autorizzare un'operazione irreversibile su un minore.
 * Deriva da `LATO_DEL_CONFINE` invece di essere ribattuta a mano — «una regola
 * valida per due strade deve vivere in un posto solo»: con due elenchi paralleli
 * il giorno che si sposta uno stato da una parte all'altra se ne aggiorna uno e
 * si dimentica l'altro, e qui l'altro autorizza un'anonimizzazione.
 */
export const STATI_NON_PIU_ISCRITTO: readonly string[] = STATI_TENDINA.filter(
  (s) => LATO_DEL_CONFINE[s] === 'non-piu-iscritto',
)

/**
 * I CANALI VERSO LE FAMIGLIE — il confine, in un posto solo e per davvero.
 *
 * ⚠️ QUESTA COSTANTE È NATA DA UNA FRASE FALSA, e vale la pena dirlo. Il
 * 2026-08-12 cinque letture presero `.eq('stato', STATO_ISCRITTO)` scritto a
 * mano, e il commento di `genitoriDiScuola` prometteva: «se domani la scelta
 * cambia si cambia qui, in un posto solo». Non era vero: lo stesso confine era
 * ribattuto in CINQUE punti (`admin/chat/contacts`, `agenda:POST`,
 * `genitoriDiClassi`, `genitoriDiScuola`, `news/digest`) più un SESTO che era
 * rimasto cieco del tutto (`genitoriDiGrado`). Sei copie di una regola: la forma
 * di difetto che questo repo ha già pagato e che sa nominare — *una regola valida
 * per due strade deve vivere in un posto solo*.
 *
 * ─── CHE COSA SONO «I CANALI» ────────────────────────────────────────────────
 * La rubrica della segreteria, gli avvisi di plesso, gli inviti d'agenda, il
 * digest News: tutto ciò che decide se il prodotto può ancora PARLARE a una
 * famiglia. Non sono elenchi operativi — «genera le rette», «mostrami la classe»,
 * «manda i frequentanti al SIDI» vogliono altro, e infatti restano `iscritto` in
 * senso stretto (vedi `eAncoraIscritto` qui sotto).
 *
 * ─── PERCHÉ `'sospeso'` STA DENTRO, ed è un cambiamento di comportamento ─────
 * Fino al 2026-08-13 il confine era `STATO_ISCRITTO` in senso stretto, quindi
 * escludeva `'sospeso'` — che `LATO_DEL_CONFINE`, dieci righe più su, classifica
 * `'ancora-iscritto'`: **un bambino che frequenta**. Le due testate lo
 * ammettevano in prosa e nessuna asserzione ne parlava, cioè era una decisione
 * senza gate. L'effetto misurato: la famiglia di un sospeso spariva dalla
 * rubrica della segreteria — che non poteva più nemmeno APRIRE una
 * conversazione — dagli avvisi di plesso, dagli inviti d'agenda e dal digest,
 * tutto insieme e senza che niente lo dicesse. Non è un elenco che sbaglia per
 * difetto: è una famiglia a scuola resa irraggiungibile.
 *
 * Derivare da `LATO_DEL_CONFINE` invece di scrivere `[STATO_ISCRITTO]` chiude il
 * giro: un bambino non può essere insieme «protetto dall'anonimizzazione perché
 * è a scuola» e «irraggiungibile perché non è iscritto». Un confine solo, non
 * due — ed è lo stesso `Record` esaustivo, quindi uno stato nuovo non compila
 * finché qualcuno non decide di che parte sta.
 *
 * ⚠️ Si applica con `.in('stato', [...])` e non con `.eq`: il giorno che questo
 * elenco avrà due voci, un `.eq` sarebbe rimasto a filtrarne una sola.
 */
export const STATI_CON_CANALE_FAMIGLIA: readonly string[] = STATI_TENDINA.filter(
  (s) => LATO_DEL_CONFINE[s] === 'ancora-iscritto',
)

/**
 * Vero SOLO per gli stati dell'allowlist.
 *
 * È il predicato che AUTORIZZA (oblio, esclusione dagli elenchi): tutto ciò che
 * non riconosce — uno stato nuovo, un refuso, una maiuscola, uno spazio in coda,
 * la colonna vuota — risponde `false`, cioè **non autorizza**. Rifiutare un
 * oblio si ripete; eseguirlo sul bambino sbagliato no.
 *
 * ─── PERCHÉ LEGGE `stato` E NON `archiviato_il` ──────────────────────────────
 *
 * La migrazione `20260812194517_alunni_archiviazione` ha aggiunto sei colonne, e
 * nella sua testata scrive «LA LEVA VERA NON È LO STATO»: quella frase parla di
 * come un bambino ESCE DAGLI ELENCHI (lo sganciamento dalla classe, che vale in
 * un centinaio di query per sezione), non di che cosa AUTORIZZA un'operazione
 * irreversibile. Sono due domande diverse e questa funzione risponde alla
 * seconda. Il commento SQL della colonna lo dice per esteso: «Insieme a `stato` =
 * ''ritirato'': lo stato dice COSA, questa dice QUANDO».
 *
 * Il nome di questa funzione era `eArchiviato` e annunciava di guardare
 * l'archiviazione: ora dice quello che fa. E la scelta di non guardare
 * `archiviato_il` non è pigrizia — è la sola sicura, e si legge in tabella:
 *
 *   | `stato`    | `archiviato_il` | che cos'è                       | autorizza? |
 *   |------------|-----------------|---------------------------------|------------|
 *   | ritirato   | valorizzato     | archiviato, il caso normale     | **sì**     |
 *   | ritirato   | NULL            | ritirato a mano dalla tendina   | **sì**     |
 *   | iscritto   | valorizzato     | riattivato, colonna non ripulita| **no**     |
 *   | iscritto   | NULL            | frequenta                       | no         |
 *
 * La terza riga è quella che decide: se `archiviato_il` autorizzasse, un ritorno
 * fra gli iscritti che dimentica di azzerarla lascerebbe un bambino che
 * FREQUENTA nell'elenco dell'anonimizzazione irreversibile. Nella direzione senza
 * annulla si sbaglia da una parte sola, e `stato` è il campo che il ritorno
 * riporta a `'iscritto'` per forza — altrimenti il bambino non ricompare da
 * nessuna parte e se ne accorge la segreteria lo stesso giorno.
 *
 * ⚠️ Chi scrive il flusso di archiviazione scriva quindi ENTRAMBE le cose:
 * `stato = STATO_RITIRATO` **e** `archiviato_il`. Con il solo `archiviato_il` il
 * bambino risulta archiviato dappertutto ma resta invisibile all'oblio: una
 * richiesta della famiglia ex art. 17 non sarebbe evadibile dal prodotto.
 */
export function eNonPiuIscritto(stato: string | null | undefined): boolean {
  if (typeof stato !== 'string') return false
  return STATI_NON_PIU_ISCRITTO.includes(stato)
}

/**
 * Vero per tutto ciò che NON è «non più iscritto» — `'sospeso'` compreso, e anche
 * una colonna vuota (il `DEFAULT` è `'iscritto'`: ciò che manca non è un ritiro).
 *
 * È il predicato che PROTEGGE: «questo bambino conta ancora come presente,
 * quindi i suoi dati e quelli dei suoi genitori non si toccano». Complementare a
 * `eNonPiuIscritto` di proposito — un confine solo, non due, altrimenti la terra
 * di mezzo (`'sospeso'`) tornerebbe a essere interpretata da ogni chiamante.
 *
 * ⚠️ NON è il filtro degli elenchi operativi. «Mostrami la classe», «genera le
 * rette», «invia i frequentanti al SIDI» vogliono i soli `iscritto` in senso
 * stretto. Misurato il 2026-08-12, e scritto qui perché fino a quella mattina
 * questa riga sosteneva che quei filtri «restano `.eq('stato', STATO_ISCRITTO)`»,
 * cioè che la costante li governasse: **non li governa**. In `src/` ci sono
 * ancora **11 filtri di lettura** con la stringa scritta a mano
 * (`pagamenti/genera`, `pagamenti/genera-rette`, `admin/dashboard`,
 * `admin/presenze/realtime`, `tasks/meta`, `locker/requests`, `locker/inventory`,
 * `primaria/classe`) — rimisurato il 2026-08-13, ed è ancora 11.
 *
 * ⚠️ E NON È NEMMENO IL FILTRO DEI CANALI VERSO LE FAMIGLIE (2026-08-13). Quello
 * è `STATI_CON_CANALE_FAMIGLIA`, poche righe più su, e `'sospeso'` sta DENTRO:
 * la rubrica, gli avvisi di plesso, gli inviti d'agenda e il digest News parlano
 * a una famiglia, e una famiglia a scuola deve restare raggiungibile. Tre
 * confini, tre nomi, tre ragioni scritte — invece di una stessa stringa copiata e
 * interpretata da ogni chiamante. Escludere un sospeso da un elenco operativo è
 * una scelta di prodotto reversibile; renderlo irraggiungibile o anonimizzarlo
 * no, ed è per questo che quei due non li decide `.eq(…)` scritto a mano.
 */
export function eAncoraIscritto(stato: string | null | undefined): boolean {
  return !eNonPiuIscritto(stato)
}
