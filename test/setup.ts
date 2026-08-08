import '@testing-library/jest-dom';
import { vi } from 'vitest';

/* ════════════════════════════════════════════════════════════════════════════
 * 🔴 LA SUITE NON PARLA CON LA PRODUZIONE. MAI.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO, misurato il 2026-08-03. Sei route admin costruivano il proprio client con
 * `createClient` di `@supabase/supabase-js`; portandole al factory strumentato, sotto vitest
 * hanno cominciato a puntare a `https://uimulkjyekgemjakmepp.supabase.co` — cioè al database
 * con 227 domande d'iscrizione e 152 codici fiscali di minori. La ragione: `SUPABASE_URL`
 * (`src/lib/supabase/public-config.ts`) è una `const` valutata all'IMPORT, con un ripiego
 * hard-coded sulla produzione, e sotto vitest `.env.local` non viene caricato. I test che
 * «dirottavano su localhost» scrivendo `process.env` nel `beforeEach` arrivavano troppo tardi.
 *
 * A fermare il danno era rimasta una sola cosa: che la chiave di servizio, in quel momento,
 * fosse assente. Con una `SUPABASE_SERVICE_ROLE_KEY` vera in ambiente, `npx vitest run` avrebbe
 * eseguito `auth.admin.updateUserById` (il reset della password di un genitore) e il ciclo di
 * DELETE su 25 tabelle di `admin/wipe` CONTRO LA PRODUZIONE.
 *
 * LE DIFESE SONO TRE, e questa è quella che BLOCCA:
 *  1. `vitest.config.ts` → `test.env`: l'URL e la chiave sono finti PRIMA di ogni import, e
 *     sovrascrivono anche l'ambiente di shell (verificato: una `NEXT_PUBLIC_SUPABASE_URL` di
 *     produzione esportata nella shell NON passa);
 *  2. questa guardia: qualunque `fetch` verso l'host di produzione LANCIA, con un messaggio che
 *     dice cosa fare. Non si logga e si tira dritto: una richiesta partita è già partita;
 *  3. `__tests__/architecture/nessun-bersaglio-di-produzione.test.ts`: il lock che verifica che
 *     1 e 2 esistano ancora e funzionino davvero.
 *
 * ⚠️ COSA NON COPRE. Un test che sostituisce `globalThis.fetch` con il proprio (ce ne sono, ed è
 * legittimo) esce da questa guardia — ma un test che si finge la rete non la sta usando. Restano
 * fuori anche i client che non passano da `fetch` (`pg`, websocket): oggi non ce n'è nessuno.
 * ─────────────────────────────────────────────────────────────────────────────────
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * L'host del progetto Supabase di PRODUZIONE.
 *
 * Scritto a mano e NON importato da `public-config.ts`: quel modulo espone l'URL *risolto*
 * (che sotto vitest è `localhost`), non il ripiego. Il lock che sorveglia questa guardia lo
 * ripete a sua volta, e deve: due copie che devono coincidere sono il punto della misura.
 */
const HOST_DI_PRODUZIONE = 'uimulkjyekgemjakmepp.supabase.co';

const fetchNudo = globalThis.fetch;
if (typeof fetchNudo === 'function') {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let dove = '';
    try {
      dove = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String((input as Request)?.url ?? '');
    } catch {
      // Un `input` illeggibile non è un bersaglio di produzione: si lascia passare.
      dove = '';
    }
    if (dove.includes(HOST_DI_PRODUZIONE)) {
      throw new Error(
        'TEST VERSO LA PRODUZIONE BLOCCATO: un test ha provato a chiamare '
        + `${HOST_DI_PRODUZIONE} — il database con i dati reali dei minori. `
        + 'Quasi sempre significa che il client Supabase NON è stato finto: '
        + "mockare `@/lib/supabase/server-client` (è da lì che nascono tutti i client del server), "
        + 'non solo `@supabase/supabase-js`. Vedi test/setup.ts.',
      );
    }
    return fetchNudo(input as RequestInfo | URL, init);
  }) as typeof globalThis.fetch;
}

// Mock globale di next-intl per i test. I componenti migrati usano
// useTranslations/useLocale, che senza il NextIntlClientProvider (vive nel
// RootLayout, non montato negli unit test) lancerebbero. Il mock risolve le
// chiavi contro i messaggi ITALIANI reali (messages/it.json), così i test che
// asseriscono sui testi italiani continuano a passare senza wrapper. Scalabile a
// tutta la migrazione i18n: nessun test esistente va toccato per il provider.
vi.mock('next-intl', async () => {
  const it: Record<string, Record<string, string>> = {
    common: (await import('../messages/it/common.json')).default,
    auth: (await import('../messages/it/auth.json')).default,
    nav: (await import('../messages/it/nav.json')).default,
    home: (await import('../messages/it/home.json')).default,
    avvisi: (await import('../messages/it/avvisi.json')).default,
    diario: (await import('../messages/it/diario.json')).default,
    mensa: (await import('../messages/it/mensa.json')).default,
    pagamenti: (await import('../messages/it/pagamenti.json')).default,
    profilo: (await import('../messages/it/profilo.json')).default,
    teacherNav: (await import('../messages/it/teacherNav.json')).default,
    teacherDiario: (await import('../messages/it/teacherDiario.json')).default,
    teacherPresenze: (await import('../messages/it/teacherPresenze.json')).default,
    teacherComunicazioni: (await import('../messages/it/teacherComunicazioni.json')).default,
    teacherPrimaria: (await import('../messages/it/teacherPrimaria.json')).default,
    teacherTasks: (await import('../messages/it/teacherTasks.json')).default,
    teacherServizi: (await import('../messages/it/teacherServizi.json')).default,
    adminNav: (await import('../messages/it/adminNav.json')).default,
    adminStudents: (await import('../messages/it/adminStudents.json')).default,
    adminContabilita: (await import('../messages/it/adminContabilita.json')).default,
    adminMensa: (await import('../messages/it/adminMensa.json')).default,
    adminModulistica: (await import('../messages/it/adminModulistica.json')).default,
    adminComunicazioni: (await import('../messages/it/adminComunicazioni.json')).default,
    adminPrimaria: (await import('../messages/it/adminPrimaria.json')).default,
    adminSettings: (await import('../messages/it/adminSettings.json')).default,
    adminAltro: (await import('../messages/it/adminAltro.json')).default,
    shared: (await import('../messages/it/shared.json')).default,
    etichette: (await import('../messages/it/etichette.json')).default,
    parentNews: (await import('../messages/it/parentNews.json')).default,
    parentChat: (await import('../messages/it/parentChat.json')).default,
    parentPrimaria: (await import('../messages/it/parentPrimaria.json')).default,
    parentServizi: (await import('../messages/it/parentServizi.json')).default,
    // Le frasi che le DUE schermate dell'assenza condividono. Senza questa riga
    // ogni test che monta `/parent/attendance` o `ComunicaAssenzaCard` mostrava a
    // schermo `parentAssenze.motivoPrivacy` — cioè il nome della chiave — e
    // qualunque asserzione sul testo sarebbe stata verde su una stringa che
    // nessun genitore leggerà mai.
    parentAssenze: (await import('../messages/it/parentAssenze.json')).default,
    parentForms: (await import('../messages/it/parentForms.json')).default,
    public: (await import('../messages/it/public.json')).default,
  };
  const resolve = (ns: string | undefined, key: string): string => {
    const gruppo = ns ? it[ns] : undefined;
    return (gruppo && gruppo[key]) ?? (ns ? `${ns}.${key}` : key);
  };
  const useTranslations = (ns?: string) => {
    const t = (key: string) => resolve(ns, key);
    return Object.assign(t, {
      rich: (key: string) => resolve(ns, key),
      markup: (key: string) => resolve(ns, key),
      raw: (key: string) => resolve(ns, key),
      has: () => true,
    });
  };
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  };
});

// I mock browser-specifici valgono solo in ambiente jsdom (i test con
// `@vitest-environment node` non hanno `window`).
if (typeof window !== 'undefined') {
  // Mock per funzioni specifiche del browser che jsdom non supporta
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Polyfill semplificato per crypto.randomUUID usato nei nostri script
  if (!window.crypto.randomUUID) {
    window.crypto.randomUUID = () => '12345678-1234-1234-1234-123456789012';
  }
}
