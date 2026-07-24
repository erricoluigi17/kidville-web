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
