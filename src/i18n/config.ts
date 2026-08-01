// Configurazione i18n (next-intl SENZA routing per-locale: la lingua sta in un
// cookie, così non serve ricostruire l'albero delle rotte sotto /[locale] né
// toccare il middleware esistente). Italiano è la lingua di default.

export const LOCALES = ['it', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'it';

/** Nome del cookie che porta la lingua scelta dall'utente. */
export const LOCALE_COOKIE = 'KV_LOCALE';

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'it' || value === 'en';
}

/**
 * Il fuso dell'ISTITUTO, non quello di chi guarda. Le tre sedi sono in
 * Campania: una data del registro è sempre una data italiana.
 *
 * Va dichiarato ovunque perché `Intl` senza `timeZone` usa il fuso
 * DELL'AMBIENTE: su Vercel il processo gira in UTC, il browser di una famiglia
 * in Europe/Rome. Fra le 00:00 e le 02:00 italiane lo stesso istante rende due
 * GIORNI diversi — e qui la data è la chiave di presenze, registro e diario
 * (il vincolo di unicità del registro è (sede, classe, data, ora)).
 */
export const APP_TIMEZONE = 'Europe/Rome';

/**
 * La REGIONE di ogni lingua, decisa una volta sola. `'en'` nudo lo risolve
 * `Intl` su en-US (mese/giorno/anno): «8/10/2026» letto da una famiglia in
 * Italia è il 10 agosto, per Intl era l'8 ottobre. en-GB è la convenzione
 * coerente con una scuola italiana.
 */
export const LOCALE_BCP47: Record<Locale, string> = {
  it: 'it-IT',
  en: 'en-GB',
};

/**
 * Locale BCP47 completo a partire da una lingua dell'app. Accetta anche un
 * valore GIÀ mappato (`'en-GB'`) e lo lascia stabile: le funzioni di formato si
 * incatenano, e un doppio passaggio non deve degradare al default.
 * Valore sconosciuto o assente → la lingua di default.
 */
export function bcp47(locale: string | undefined | null): string {
  const base = (locale ?? '').split('-')[0];
  return LOCALE_BCP47[isLocale(base) ? base : DEFAULT_LOCALE];
}

/**
 * L'UNICO modo normale di costruire un formattatore di date nell'app: risolve
 * la regione della lingua e dichiara `Europe/Rome` per costruzione. Il fuso
 * resta sovrascrivibile (`{ timeZone: 'UTC' }`) per i pochi casi che devono
 * restare ancorati a UTC — il nome del mese, o una data già normalizzata.
 *
 * Il lock `__tests__/architecture/date-con-timezone.test.ts` vieta ogni
 * `new Intl.DateTimeFormat(` che non dichiari il proprio `timeZone`.
 */
export function intlDateTime(
  locale: string | undefined | null,
  opzioni: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(bcp47(locale), { timeZone: APP_TIMEZONE, ...opzioni });
}

/**
 * Formatta un istante con fuso e regione dichiarati — **e non lancia mai**.
 *
 * ─── PERCHÉ ESISTE, invece di `intlDateTime(…).format(new Date(x))` ─────────
 *
 * Perché le due forme si comportano in modo OPPOSTO su una data non valida, e
 * la differenza non si vede leggendo il codice:
 *
 *   new Date(undefined).toLocaleDateString('it-IT')   → "Invalid Date"
 *   new Intl.DateTimeFormat('it-IT').format(quella)   → RangeError: Invalid time value
 *
 * Il repo era pieno di `toLocaleDateString`, che davanti a una colonna nulla o a
 * un timestamp malformato stampava una stringa brutta e tirava dritto.
 * Sostituendole con `Intl` — che è il modo giusto di dichiarare fuso e regione —
 * ogni punto è diventato un potenziale **500**: misurato il 2026-08-01 su
 * `GET /api/pagamenti/ricevuta`, dove una ricevuta senza `creato_il` faceva
 * fallire il download del PDF a una famiglia invece di scrivere una riga
 * imperfetta.
 *
 * Qui l'istante non valido diventa stringa VUOTA, che è meglio sia di
 * «Invalid Date» sia di un'eccezione: un campo vuoto in un PDF si nota e non
 * rompe niente. `intlDateTime` resta per chi ha in mano una data già certa (o
 * gli serve `formatToParts`).
 */
export function formattaIstante(
  input: string | number | Date | null | undefined,
  locale: string | undefined | null,
  opzioni: Intl.DateTimeFormatOptions = {},
): string {
  if (input === null || input === undefined || input === '') return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return intlDateTime(locale, opzioni).format(d);
}

/**
 * La DATA CIVILE italiana di un istante — `YYYY-MM-DD` in `Europe/Rome`.
 *
 * Serve al codice di SERVIZIO, non a quello che mostra: aggregazioni, confronti
 * con colonne `date` del database, chiavi di raggruppamento. Lì `formatData` non
 * va bene (produce testo per un essere umano, in una lingua) e
 * `new Date().toISOString().slice(0,10)` è **sbagliato**: dà la data in UTC.
 *
 * Non è teoria, è stato misurato il 2026-08-01 alle 01:08 italiane, mentre a
 * Greenwich era ancora il 31 luglio: la dashboard cercava gli incassi «di questo
 * mese» in agosto e l'incasso registrato quel giorno era datato luglio. Un
 * incasso vero, sparito da un KPI. In produzione è la regola e non l'eccezione,
 * perché su Vercel il processo gira in UTC mentre chi usa l'app è in Italia:
 * ogni notte, fra mezzanotte e le due, server e utente stanno in due giorni
 * diversi.
 */
export function dataCivile(istante: Date = new Date()): string {
  // `en-CA` produce `YYYY-MM-DD`, che è anche il formato delle colonne `date`
  // di Postgres: nessuna ricomposizione a mano da cui possa nascere un refuso.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(istante);
}

/** Il MESE civile italiano di un istante — `YYYY-MM` in `Europe/Rome`. */
export function meseCivile(istante: Date = new Date()): string {
  return dataCivile(istante).slice(0, 7);
}

/**
 * Il primo giorno del mese civile, `n` mesi indietro rispetto a un istante.
 * Ritorna `YYYY-MM-DD`.
 *
 * Fa il conto sulle COMPONENTI della data italiana invece che con
 * `new Date(anno, mese - n, 1)`, che costruisce l'istante nel fuso del processo:
 * a gennaio, da un server in UTC, quel costruttore può restituire il mese
 * sbagliato.
 */
export function primoDelMeseCivile(mesiIndietro: number, istante: Date = new Date()): string {
  const [anno, mese] = meseCivile(istante).split('-').map(Number);
  const totale = anno * 12 + (mese - 1) - mesiIndietro;
  const a = Math.floor(totale / 12);
  const m = (totale % 12) + 1;
  return `${a}-${String(m).padStart(2, '0')}-01`;
}
