import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { APP_TIMEZONE, DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@/i18n/config';

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
    // Il cambio password: UN namespace per QUATTRO superfici (profilo genitore,
    // profilo docente, impostazioni della segreteria, interstiziale del primo
    // accesso). Sta a sé e non dentro `profilo` o `adminSettings` perché è lo
    // stesso identico modulo montato in aree diverse: dividerne i testi per area
    // vorrebbe dire quattro copie della stessa frase, e la prima a divergere
    // sarebbe quella che nessuno riapre più.
    password: (await import(`../../messages/${locale}/password.json`)).default,
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
    documenti: (await import(`../../messages/${locale}/documenti.json`)).default,
    shared: (await import(`../../messages/${locale}/shared.json`)).default,
    etichette: (await import(`../../messages/${locale}/etichette.json`)).default,
    parentNews: (await import(`../../messages/${locale}/parentNews.json`)).default,
    parentChat: (await import(`../../messages/${locale}/parentChat.json`)).default,
    parentPrimaria: (await import(`../../messages/${locale}/parentPrimaria.json`)).default,
    parentServizi: (await import(`../../messages/${locale}/parentServizi.json`)).default,
    // Le frasi che le DUE schermate dell'assenza (nido·infanzia e primaria)
    // condividono davvero: l'informativa sul motivo, l'avviso «questo giorno lo
    // hai già comunicato», la conferma che distingue l'aggiornamento dalla
    // creazione. Un namespace suo, e non una copia in `parentServizi` +
    // `parentPrimaria`, perché la stessa frase scritta due volte è il difetto da
    // cui nasce questo lavoro: le due schermate divergevano in 5 stringhe su 7.
    parentAssenze: (await import(`../../messages/${locale}/parentAssenze.json`)).default,
    parentForms: (await import(`../../messages/${locale}/parentForms.json`)).default,
    // I diciassette prestampati (`src/lib/prestampati/`), in DUE namespace e non in
    // uno: la famiglia ne vede otto e li compila dal telefono, la segreteria li vede
    // tutti e li genera dal banco. Le stesse etichette compaiono da entrambe le parti
    // (`modelli.*`) e sono le sole voci ripetute: il resto sono due schermate diverse,
    // e tenerle in un file solo avrebbe mandato alla famiglia il vocabolario del
    // protocollo e alla segreteria quello del codice usa e getta.
    prestampatiGenitore: (await import(`../../messages/${locale}/prestampatiGenitore.json`)).default,
    prestampatiSegreteria: (await import(`../../messages/${locale}/prestampatiSegreteria.json`)).default,
    public: (await import(`../../messages/${locale}/public.json`)).default,
  };

  // `timeZone` è la rete di sicurezza di next-intl: senza, i formattatori del
  // provider (useFormatter) userebbero il fuso del PROCESSO — UTC su Vercel —
  // e il server renderebbe un giorno diverso da quello del browser italiano.
  return { locale, timeZone: APP_TIMEZONE, messages };
});
