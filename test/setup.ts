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
// chiavi contro i messaggi ITALIANI reali (`messages/it/*.json`), così i test che
// asseriscono sui testi italiani continuano a passare senza wrapper. Scalabile a
// tutta la migrazione i18n: nessun test esistente va toccato per il provider.
//
// ─── PERCHÉ I CATALOGHI SI LEGGONO DALLA CARTELLA, E NON PIÙ A UNO A UNO ────────
//
// Fino al 2026-08-16 questo oggetto era un ELENCO SCRITTO A MANO, e un elenco scritto a
// mano dimentica. Il ripiego del `resolve` qui sotto è il NOME DELLA CHIAVE: un catalogo
// non elencato non dà nessun errore, dà `namespace.chiave` a schermo — e ogni asserzione
// sul testo di quella schermata resta verde su una stringa che nessun utente leggerà mai.
//
// È successo due volte. La prima con `parentAssenze`, e l'avviso è rimasto scritto qui per
// giorni. La seconda con `prestampatiSegreteria`, nato il 2026-08-14: la quinta linguetta
// di «Modulistica» si misurava `prestampatiSegreteria.titolo` invece di «Prestampati»
// (`__tests__/pages/admin-modulistica-linguette.test.tsx`). Un avviso non è un meccanismo:
// finché l'elenco è a mano, la terza volta è solo questione di tempo.
//
// Ora si legge la cartella. Un catalogo nuovo è montato dal momento in cui il file esiste,
// e la classe intera del difetto è chiusa per costruzione — non c'è più niente da ricordare.
vi.mock('next-intl', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { IntlMessageFormat } = await import('intl-messageformat');
  const { join } = await import('node:path');
  // `process.cwd()` è la radice del repo sotto vitest, ed è l'ancora che usano già i lock
  // di `__tests__/architecture/`. `import.meta.url` qui NON serve: dentro la trasformazione
  // di Vite non è un URL `file:`, e `readdirSync` rifiuta gli altri schemi.
  const cartella = join(process.cwd(), 'messages/it');
  const it: Record<string, Record<string, string>> = {};
  for (const file of readdirSync(cartella)) {
    if (!file.endsWith('.json')) continue;
    it[file.slice(0, -'.json'.length)] = JSON.parse(
      readFileSync(join(cartella, file), 'utf8'),
    ) as Record<string, string>;
  }
  // Se la cartella non si legge, il mock risolverebbe OGNI chiave nel suo nome e la suite
  // diventerebbe verde su testi finti in mille punti: meglio un errore che lo dice.
  if (Object.keys(it).length === 0) {
    throw new Error(
      `Nessun catalogo italiano trovato in ${cartella}: il mock di next-intl mostrerebbe ` +
        'il nome delle chiavi al posto dei testi, e le asserzioni sui testi sarebbero finte.',
    );
  }
  const resolve = (ns: string | undefined, key: string): string => {
    const gruppo = ns ? it[ns] : undefined;
    return (gruppo && gruppo[key]) ?? (ns ? `${ns}.${key}` : key);
  };
  // ─── I VALORI, QUANDO CI SONO ──────────────────────────────────────────────
  //
  // Fino al 2026-08-20 questo mock IGNORAVA il secondo argomento di `t()`. Una
  // chiave con un placeholder (`Passo {corrente} di {totale}`) o con un plurale
  // ICU (`{n, plural, one {…} other {…}}`) finiva a schermo COSÌ COM'È, con le
  // graffe. Le asserzioni sui testi restavano verdi perché confrontavano la
  // stessa stringa grezza letta dal catalogo: nessun test poteva accorgersi che
  // un plurale non si formatta, o che un placeholder è scritto male.
  //
  // ⚠️ SI FORMATTA SOLO QUANDO ARRIVANO DEI VALORI. `t('chiave')` senza secondo
  // argomento resta byte per byte ciò che era: è l'unico modo di chiudere questo
  // buco senza toccare le centinaia di asserzioni che confrontano `t(k)` con la
  // stringa del catalogo. Le chiavi con ICU chiamate senza valori continuano a
  // rendersi grezze, esattamente come prima — quelle restano scoperte, e chi
  // scrive un plurale nuovo lo sappia.
  const formatta = (messaggio: string, valori: Record<string, unknown>): string => {
    try {
      return String(new IntlMessageFormat(messaggio, 'it').format(valori));
    } catch {
      // Un messaggio che non compila non deve far cadere il mock: cadrebbe come
      // «errore del test» invece che come «testo sbagliato», che è più difficile
      // da leggere. Si restituisce il grezzo, come faceva prima.
      return messaggio;
    }
  };
  const useTranslations = (ns?: string) => {
    const t = (key: string, valori?: Record<string, unknown>) =>
      valori === undefined ? resolve(ns, key) : formatta(resolve(ns, key), valori);
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
