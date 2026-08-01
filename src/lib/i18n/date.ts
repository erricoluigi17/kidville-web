import { useMemo } from 'react';
import { useLocale } from 'next-intl';
import { APP_TIMEZONE, bcp47, intlDateTime } from '@/i18n/config';

// Helper condiviso per la formattazione LOCALIZZATA di date e orari.
//
// Il problema che risolve: per mesi l'app ha usato ovunque chiamate hardcoded
// `toLocale*String('it-IT', …)`. In modalità inglese quei mesi/giorni restavano
// in italiano. Qui il `locale` arriva da `useLocale()` (next-intl), così in IT il
// risultato è IDENTICO a prima (locale='it') e in EN si localizza.
//
// Perché `Intl.DateTimeFormat(locale, opts).format(d)` e non `toLocaleDateString`:
// `toLocaleDateString` inietta campi-data di default quando le opzioni non ne hanno
// (romperebbe il formato «solo ora»). `Intl.DateTimeFormat` rispetta ESATTAMENTE le
// opzioni passate, replicando 1:1 anche `toLocaleTimeString`.
//
// Fuso e regione (2026-08-01): la costruzione passa da `intlDateTime()`, che
// dichiara `Europe/Rome` e mappa la lingua sulla sua regione (it-IT / en-GB).
// Prima di allora il fuso era quello dell'AMBIENTE: lo stesso istante rendeva
// «giovedì 30 luglio» su Vercel (UTC) e «venerdì 31 luglio» nel browser.

/** Input accettati: stringa ISO/parsabile, timestamp, Date, o nullo. */
export type DateInput = string | number | Date | null | undefined;

/** I formati supportati. */
export type FormatoData =
  | 'lunga' //      5 novembre 2026
  | 'breve' //      05/11/2026
  | 'dataOra' //    05/11/2026, 09:30
  | 'ora' //        09:30
  | 'giornoMese' // 5 novembre
  | 'meseAnno'; //  novembre 2026

// Ogni voce dichiara il proprio fuso: `intlDateTime` lo metterebbe comunque di
// default, ma OPZIONI è una costante esportabile e leggibile da fuori — una voce
// senza `timeZone` tornerebbe a dipendere dall'ambiente il giorno in cui
// qualcuno la passasse a un `Intl.DateTimeFormat` scritto a mano. Il lock
// `date-con-timezone.test.ts` fallisce, e nomina la voce, se ne manca uno.
const OPZIONI: Record<FormatoData, Intl.DateTimeFormatOptions> = {
  lunga: { day: 'numeric', month: 'long', year: 'numeric', timeZone: APP_TIMEZONE },
  breve: { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: APP_TIMEZONE },
  dataOra: { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: APP_TIMEZONE },
  ora: { hour: '2-digit', minute: '2-digit', timeZone: APP_TIMEZONE },
  giornoMese: { day: 'numeric', month: 'long', timeZone: APP_TIMEZONE },
  meseAnno: { month: 'long', year: 'numeric', timeZone: APP_TIMEZONE },
};

function toDate(input: DateInput): Date | null {
  if (input == null || input === '') return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Formatta una data/ora per la lingua indicata. Variante NON-hook: per i punti che
 * hanno già il `locale` a disposizione (funzioni non-componente, o codice con
 * `useLocale()` a monte). Input non valido → stringa vuota (mai «Invalid Date»).
 */
export function formatData(input: DateInput, locale: string, kind: FormatoData): string {
  const d = toDate(input);
  if (!d) return '';
  return intlDateTime(locale, OPZIONI[kind]).format(d);
}

/**
 * Nome del mese (1 = gennaio … 12 = dicembre) localizzato e con l'iniziale
 * maiuscola, così in IT resta «Gennaio» (identico all'array MESI_IT) e in EN
 * diventa «January». Mese fuori range → stringa vuota. Sostituisce gli usi di
 * MESI_IT nei componenti client.
 */
export function nomeMese(mese: number, locale: string): string {
  if (!Number.isInteger(mese) || mese < 1 || mese > 12) return '';
  // Giorno 15 UTC: mai a cavallo del cambio-mese per qualunque fuso.
  const nome = intlDateTime(locale, { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2020, mese - 1, 15)),
  );
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}

/** Le funzioni di formato ritornate dall'hook, già legate al `locale` corrente. */
export interface DateFormatters {
  /**
   * Il locale corrente in forma BCP47 completa — `it-IT` / `en-GB`, mai `en`
   * nudo (che `Intl` risolverebbe su en-US, mese/giorno/anno). Serve ai punti
   * con opzioni fuori standard, che lo passano a `intlDateTime()`.
   */
  locale: string;
  dataLunga: (input: DateInput) => string;
  dataBreve: (input: DateInput) => string;
  dataOra: (input: DateInput) => string;
  ora: (input: DateInput) => string;
  giornoMese: (input: DateInput) => string;
  meseAnno: (input: DateInput) => string;
  nomeMese: (mese: number) => string;
}

/**
 * Hook: ritorna le funzioni di formato già legate alla lingua corrente
 * (`useLocale()`). Da usare nei componenti CLIENT che mostrano una data.
 */
export function useDateFormat(): DateFormatters {
  const lingua = useLocale();
  const locale = bcp47(lingua);
  return useMemo(
    () => ({
      locale,
      dataLunga: (input: DateInput) => formatData(input, locale, 'lunga'),
      dataBreve: (input: DateInput) => formatData(input, locale, 'breve'),
      dataOra: (input: DateInput) => formatData(input, locale, 'dataOra'),
      ora: (input: DateInput) => formatData(input, locale, 'ora'),
      giornoMese: (input: DateInput) => formatData(input, locale, 'giornoMese'),
      meseAnno: (input: DateInput) => formatData(input, locale, 'meseAnno'),
      nomeMese: (mese: number) => nomeMese(mese, locale),
    }),
    [locale],
  );
}
