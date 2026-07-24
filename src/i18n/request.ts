import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@/i18n/config';

// Config di richiesta next-intl: risolve la lingua dal cookie KV_LOCALE
// (fallback italiano) e assembla i messaggi da UN FILE PER NAMESPACE
// (messages/<locale>/<ns>.json). Gli import sono per-namespace con un solo
// segmento dinamico (${locale}) → bundle-safe: Next traccia i file di entrambe
// le lingue. Aggiungere una riga qui quando si crea un nuovo namespace.
export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE;

  const messages = {
    common: (await import(`../../messages/${locale}/common.json`)).default,
    auth: (await import(`../../messages/${locale}/auth.json`)).default,
    nav: (await import(`../../messages/${locale}/nav.json`)).default,
    home: (await import(`../../messages/${locale}/home.json`)).default,
    avvisi: (await import(`../../messages/${locale}/avvisi.json`)).default,
    diario: (await import(`../../messages/${locale}/diario.json`)).default,
    mensa: (await import(`../../messages/${locale}/mensa.json`)).default,
    pagamenti: (await import(`../../messages/${locale}/pagamenti.json`)).default,
    profilo: (await import(`../../messages/${locale}/profilo.json`)).default,
  };

  return { locale, messages };
});
