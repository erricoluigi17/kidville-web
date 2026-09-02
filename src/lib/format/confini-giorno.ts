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
 */
function istanteCivile(ymd: string, ora: string): string | null {
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
