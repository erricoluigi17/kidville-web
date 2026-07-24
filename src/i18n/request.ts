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
    teacherNav: (await import(`../../messages/${locale}/teacherNav.json`)).default,
    teacherDiario: (await import(`../../messages/${locale}/teacherDiario.json`)).default,
    teacherPresenze: (await import(`../../messages/${locale}/teacherPresenze.json`)).default,
    teacherComunicazioni: (await import(`../../messages/${locale}/teacherComunicazioni.json`)).default,
    teacherPrimaria: (await import(`../../messages/${locale}/teacherPrimaria.json`)).default,
    teacherTasks: (await import(`../../messages/${locale}/teacherTasks.json`)).default,
    teacherServizi: (await import(`../../messages/${locale}/teacherServizi.json`)).default,
    adminNav: (await import(`../../messages/${locale}/adminNav.json`)).default,
    adminStudents: (await import(`../../messages/${locale}/adminStudents.json`)).default,
    adminContabilita: (await import(`../../messages/${locale}/adminContabilita.json`)).default,
    adminMensa: (await import(`../../messages/${locale}/adminMensa.json`)).default,
    adminModulistica: (await import(`../../messages/${locale}/adminModulistica.json`)).default,
    adminComunicazioni: (await import(`../../messages/${locale}/adminComunicazioni.json`)).default,
    adminPrimaria: (await import(`../../messages/${locale}/adminPrimaria.json`)).default,
    adminSettings: (await import(`../../messages/${locale}/adminSettings.json`)).default,
    adminAltro: (await import(`../../messages/${locale}/adminAltro.json`)).default,
    shared: (await import(`../../messages/${locale}/shared.json`)).default,
    etichette: (await import(`../../messages/${locale}/etichette.json`)).default,
    parentNews: (await import(`../../messages/${locale}/parentNews.json`)).default,
    parentChat: (await import(`../../messages/${locale}/parentChat.json`)).default,
    parentPrimaria: (await import(`../../messages/${locale}/parentPrimaria.json`)).default,
    parentServizi: (await import(`../../messages/${locale}/parentServizi.json`)).default,
    parentForms: (await import(`../../messages/${locale}/parentForms.json`)).default,
  };

  return { locale, messages };
});
