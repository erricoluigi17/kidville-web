import { APP_TIMEZONE } from '@/i18n/config';

/**
 * ─── DA UN GIORNO CIVILE ITALIANO AI DUE ISTANTI CHE LO DELIMITANO ───────────
 *
 * `dataCivile()` fa la strada di andata: da un istante alla data `YYYY-MM-DD` in
 * `Europe/Rome`. Questo modulo fa quella di RITORNO, e serve ogni volta che un
 * filtro «dal … al …» — che una persona scrive in giorni — deve colpire una
 * colonna `timestamptz`, cioè un istante.
 *
 * ── PERCHÉ NON BASTA `${ymd}T00:00:00Z` ─────────────────────────────────────
 *
 * Perché su Vercel il processo gira in UTC e su Supabase la sessione anche,
 * mentre chi usa l'applicazione sta in Italia. `gte('creata_il', '2026-09-01')`
 * significa `>= 2026-09-01 00:00:00 UTC`, che a Roma sono le **02:00** del
 * mattino: una candidatura arrivata all'una di notte del 1° settembre finisce
 * nel 31 agosto, e la segreteria che filtra «oggi» non la trova. È lo stesso
 * scarto che il 2026-08-01 alle 01:08 ha fatto sparire un incasso vero da un
 * KPI — il difetto per cui `dataCivile()` esiste, visto dall'altro lato.
 *
 * ── PERCHÉ DUE PASSAGGI, E NON UN OFFSET SOLO ───────────────────────────────
 *
 * Perché nei due giorni in cui l'ora cambia l'offset di Roma **non è lo stesso
 * ai due estremi dello stesso giorno**: il 29 marzo 2026 a mezzanotte è ancora
 * +01:00 e a mezzogiorno è già +02:00. Prendere l'offset una volta sola (a
 * mezzogiorno, come verrebbe naturale per «stare lontani dai bordi») sposterebbe
 * l'inizio di quel giorno di un'ora piena, cioè farebbe entrare nell'elenco
 * un'ora del giorno prima. Si stima l'offset sull'istante ingenuo, si corregge,
 * e si rilegge l'offset sull'istante corretto: è l'algoritmo classico, e i due
 * giorni di cambio ora sono provati in `__tests__/lib/confini-giorno.test.ts`.
 *
 * ── L'ESTREMO FINALE È INCLUSIVO ────────────────────────────────────────────
 *
 * «Dal 1° al 31» comprende il 31, come nel motore dei filtri (`motore.ts`).
 * Perciò `fineGiornoCivile` restituisce l'ULTIMO millisecondo del giorno e i
 * chiamanti usano `.lte()`, mai `.lt()`: l'ultimo giorno che sparisce è il
 * difetto più comune di tutti, e si nota solo quando manca la registrazione di
 * fine mese.
 */

/** `YYYY-MM-DD`, e nient'altro. La verifica del CALENDARIO è più sotto. */
const FORMA_YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Lo scarto in minuti fra `Europe/Rome` e UTC in un dato istante.
 *
 * `timeZoneName: 'longOffset'` rende `GMT+02:00`: è l'unica fonte che conosce le
 * regole dell'ora legale (comprese quelle passate), e ricopiarle a mano
 * significherebbe avere due calendari nel repo e correggerne uno solo.
 */
function offsetMinuti(istante: Date): number | null {
  // ⚠️ `en-CA` e non `en-US`, e non è indifferente: la REGIONE della lingua
  // inglese è una decisione di prodotto e vive in `LOCALE_BCP47`
  // (`src/i18n/config.ts`) — il lock `date-con-timezone` rende rosso chi la
  // ridecide altrove, ed è il difetto per cui esiste (en-US quasi ovunque,
  // en-GB nel solo calendario Mensa). Qui non si mostra niente a nessuno: si
  // legge un NUMERO, e `en-CA` è lo stesso formato macchina che `dataCivile`
  // usa per produrre `YYYY-MM-DD`. Verificato: `timeZoneName: 'longOffset'`
  // rende `GMT+02:00` identico in `en-CA`, `en-US` e `it-IT`.
  const parti = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(istante);
  const testo = parti.find((p) => p.type === 'timeZoneName')?.value ?? '';
  // `GMT` nudo (nessuno scarto) è legittimo: d'inverno in un fuso a offset zero.
  if (testo === 'GMT') return 0;
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(testo);
  if (!m) return null;
  const segno = m[1] === '-' ? -1 : 1;
  return segno * (Number(m[2]) * 60 + Number(m[3]));
}

/** La data esiste davvero sul calendario? (`2026-02-30` non esiste.) */
function esiste(anno: number, mese: number, giorno: number): boolean {
  const d = new Date(Date.UTC(anno, mese - 1, giorno));
  return d.getUTCFullYear() === anno && d.getUTCMonth() === mese - 1 && d.getUTCDate() === giorno;
}

/**
 * L'istante ISO che corrisponde a `<ymd> <ora>` letta in `Europe/Rome`.
 * `null` se la data non è una data.
 *
 * ⚠️ ESPORTATA, e non era: dal 2026-09-07 la usa anche `@/lib/presenze/orario` per
 * comporre l'istante da un `HH:MM` digitato dal docente nell'appello. È lo stesso
 * problema di `inizioGiornoCivile` — cifre italiane → istante — e la ragione per cui
 * vive qui invece che là è nel titolo del modulo: la matematica dell'offset di Roma
 * sta in UN posto, con i due giorni di cambio ora provati una volta sola in
 * `__tests__/lib/confini-giorno.test.ts`. Una seconda copia sarebbe un secondo
 * calendario nel repo, e se ne correggerebbe uno.
 */
export function istanteCivile(ymd: string, ora: string): string | null {
  const m = FORMA_YMD.exec(ymd ?? '');
  if (!m) return null;
  if (!esiste(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  // Il tempo «ingenuo»: le stesse cifre lette come se fossero UTC. Non è
  // l'istante giusto, è il punto di partenza da cui si stima l'offset.
  const ingenuo = Date.parse(`${ymd}T${ora}Z`);
  if (Number.isNaN(ingenuo)) return null;
  const primo = offsetMinuti(new Date(ingenuo));
  if (primo === null) return null;
  const secondo = offsetMinuti(new Date(ingenuo - primo * 60_000));
  if (secondo === null) return null;
  return new Date(ingenuo - secondo * 60_000).toISOString();
}

/** Il primo istante del giorno civile italiano `ymd` (`null` se non è una data). */
export function inizioGiornoCivile(ymd: string): string | null {
  return istanteCivile(ymd, '00:00:00.000');
}

/** L'ULTIMO istante del giorno civile italiano `ymd`, incluso (`.999`). */
export function fineGiornoCivile(ymd: string): string | null {
  return istanteCivile(ymd, '23:59:59.999');
}

/**
 * `YYYY-MM-DDTHH:MM`, la forma di `<input type="datetime-local">` — **scritta una
 * volta sola in tutto il repo**.
 *
 * ⚠️ ESPORTATA dal 2026-09-19, e la ragione è un difetto che stava proprio qui.
 * Fino a quel giorno questa costante era `/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/`:
 * cioè esattamente la forma PERMISSIVA che `zDataOraLocale`
 * (`@/lib/validation/common`) dichiara nella propria docstring di aver evitato,
 * quella che «accetta `99:99`». La stessa difesa viveva in due posti e uno dei due
 * era più debole dell'altro.
 *
 * Non era pericolosa — qui una forma illeggibile degrada a `null` e non passa, e
 * `istanteCivile` avrebbe comunque respinto `99:99` un passaggio più in là — ma è
 * precisamente il modo in cui una difesa smette di essere una difesa: nessuno
 * sapeva quale delle due fosse quella vera. È la lezione di
 * `@/lib/avvisi/classi-sede`, già pagata in questo repo a caro prezzo: una regola
 * che vale per due strade vive in UN posto, o la seconda strada resta indietro per
 * sempre. Adesso lo schema zod importa questa costante, quindi le due non possono
 * più divergere in silenzio.
 *
 * ── PERCHÉ LA FORMA VIVE QUI E NON NEL MODULO DI VALIDAZIONE ────────────────
 *
 * Perché qui la stringa non si TESTA soltanto, si DESTRUTTURA: `istanteDaLocale`
 * usa i due gruppi per comporre l'istante. Chi valida ha bisogno di un sì/no, chi
 * parsa ha bisogno dei pezzi — e il proprietario di una grammatica è chi la legge,
 * non chi la controlla. Il gruppo interno è `(?:…)` apposta: così `m[2]` resta
 * l'intero `HH:MM` e l'ancoraggio non cambia il numero dei gruppi.
 */
export const FORMA_DATA_ORA_LOCALE = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * ─── DA `YYYY-MM-DDTHH:MM` ITALIANE ALL'ISTANTE ──────────────────────────────
 *
 * L'andata del campo data+ora: il modulo manda le cifre che la persona ha letto
 * sull'orologio a muro (`zDataOraLocale`, `@/lib/validation/common`), questo le
 * ancora al fuso e ne fa un istante da scrivere in una `timestamptz`. Non
 * ricalcola niente: compone `istanteCivile`, che è il posto dove la matematica
 * dell'offset di Roma vive — una seconda copia sarebbe un secondo calendario nel
 * repo, e se ne correggerebbe uno.
 *
 * `null` quando la forma non è quella o la data non esiste sul calendario.
 *
 * ── LE DUE ORE CHE ROMA NON HA, E L'ORA CHE HA DUE VOLTE ────────────────────
 *
 * Il campo è un `<input type="datetime-local">`: il browser NON conosce il fuso
 * dell'applicazione e lascia digitare qualunque ora, comprese le due che a Roma
 * si comportano male. I valori qui sotto sono stati **eseguiti**, non dedotti, e
 * sono fissati in `__tests__/lib/confini-giorno.test.ts`:
 *
 *   · `2026-03-29T02:30` — **non esiste**. Alle 02:00 di quella notte l'orologio
 *     salta a 03:00, e le 02:30 italiane non accadono mai.
 *       → `2026-03-29T01:30:00.000Z`, che a Roma sono le **03:30** (CEST).
 *     Cioè lo STESSO istante che produce `2026-03-29T03:30`: l'ora inesistente
 *     scivola in avanti di un'ora. (È il comportamento dell'algoritmo a due
 *     passaggi: il primo offset letto è +120, il secondo +60, e la correzione
 *     applicata è quella del secondo.)
 *
 *   · `2026-10-25T02:30` — **esiste due volte**. Alle 03:00 l'orologio torna a
 *     02:00, e le 02:30 passano una volta con l'offset estivo e una con quello
 *     invernale.
 *       → `2026-10-25T01:30:00.000Z`, cioè la SECONDA (CET, +01:00). La prima
 *     sarebbe stata `00:30Z`.
 *
 * ── PERCHÉ PER UNA SCADENZA È INNOCUO ───────────────────────────────────────
 *
 * Perché una scadenza è un CONFINE, non un appuntamento: nessuno deve trovarsi
 * da nessuna parte a quell'ora: qualcosa smette di essere valido. Nei due casi
 * lo scarto massimo è **un'ora**, e cade sempre dalla parte più permissiva —
 * l'ora saltata diventa l'istante immediatamente successivo, l'ora doppia prende
 * l'occorrenza più TARDA. In entrambi i casi la finestra per aderire è larga
 * quanto o più di quanto la segreteria credeva, mai più stretta: il modo di
 * sbagliare che non chiude in faccia la porta a una famiglia.
 *
 * E soprattutto: sono le due ore del calendario in cui nessuna segreteria mette
 * la scadenza di un avviso. La regola che conta è che il risultato sia
 * DETERMINISTICO e scritto — non che sia quello «giusto», perché per
 * `2026-03-29T02:30` un istante giusto non esiste.
 */
export function istanteDaLocale(dataOra: string): string | null {
  const m = FORMA_DATA_ORA_LOCALE.exec(dataOra ?? '');
  if (!m) return null;
  // I secondi a `00.000` e non a `59.999`: questo è un istante PUNTUALE, non
  // l'estremo di un giorno. Gli estremi inclusivi sono affare di
  // `fineGiornoCivile`, che è il solo posto dove il `.999` ha un senso.
  return istanteCivile(m[1], `${m[2]}:00.000`);
}

/**
 * L'ORA CIVILE italiana di un istante — `HH:MM` in `Europe/Rome`.
 *
 * Il gemello di ritorno di `dataCivile()` (`@/i18n/config`), e va usato insieme a
 * quello: `${dataCivile(d)}T${oraCivile(iso)}` ricompone esattamente il `value`
 * che `<input type="datetime-local">` si aspetta, chiudendo il giro
 * `istanteDaLocale` → colonna → campo. Senza di lui la riapertura di un avviso in
 * modifica mostrerebbe `new Date(iso).toISOString().slice(11,16)`, cioè l'ora
 * **UTC**: una scadenza salvata per le 18:00 riletta come «16:00», e la
 * segreteria che salva di nuovo senza toccare il campo la sposta indietro di due
 * ore ogni volta. È lo stesso difetto di `dataCivile`, un livello più in basso.
 *
 * Ritorna `''` per un istante illeggibile, come `formatData`: qui si RIEMPIE un
 * campo, e un campo vuoto si vede. Chi deve DECIDERE su una scadenza non usa
 * questa funzione ma `@/lib/avvisi/scadenze`, che su una stringa malformata
 * **lancia** — perché lì un valore mancato che scivola via come «''» diventa
 * «nessuna scadenza», cioè adesioni riaperte a tutti.
 */
export function oraCivile(istante: string): string {
  const d = new Date(istante);
  if (Number.isNaN(d.getTime())) return '';
  // ⚠️ `hourCycle: 'h23'` e non `hour12: false`: sono due cose diverse. Con
  // `hour12: false` la scelta fra il ciclo h23 (00…23) e h24 (01…24) resta al
  // locale, e nel ciclo h24 la mezzanotte si stampa `24:00` — un valore che
  // `<input type="datetime-local">` rifiuta in silenzio lasciando il campo
  // vuoto. Qui non si mostra un orario a una persona (quello è `formatData`): si
  // produce il formato macchina del campo, e lo si dichiara.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}
