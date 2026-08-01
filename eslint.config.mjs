import { readFileSync } from "node:fs";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * I file legacy in cui la regola sui CATCH MUTI è ancora spenta.
 *
 * Sta in un JSON committato e non qui dentro per un motivo pratico: è una lista che deve
 * ACCORCIARSI nel tempo, e un file di dati si legge, si conta (`jq '.file | length'`) e si
 * confronta fra due commit senza dover leggere una config. Il lock
 * `__tests__/architecture/catch-muti-allowlist.test.ts` verifica che ogni voce esista ancora,
 * che il conteggio combaci esattamente e che i due tetti non salgano.
 *
 * I metacaratteri glob vanno protetti: nei `files` di flat config i pattern passano da
 * minimatch, e `src/app/(dashboard)/teacher/primaria/[sectionId]/page.tsx` senza escape
 * significherebbe tutt'altro — `[sectionId]` è una CLASSE DI CARATTERI, cioè «un solo
 * carattere fra s, e, c, t, i, o, n, I, d». La regola resterebbe spenta su file a caso e
 * accesa proprio dove serviva spegnerla, e nessuno se ne accorgerebbe leggendo l'elenco.
 */
const catchMutiLegacy = JSON.parse(
  readFileSync(new URL("./docs/superpowers/catch-muti-allowlist.json", import.meta.url), "utf8"),
).file.map((voce) => voce.path.replace(/[[\]{}()!+@?*]/g, (c) => `\\${c}`));

/**
 * Il divieto vero e proprio. Due regole, perché i due modi di tacere hanno forma diversa:
 *  · la CLAUSOLA `catch {}` / `catch (e) {}` → `no-empty` con `allowEmptyCatch: false`;
 *  · l'HANDLER `.catch(() => {})` / `.catch(function () {})` → un selettore AST.
 */
const REGOLE_CATCH_MUTO = {
  "no-empty": ["error", { allowEmptyCatch: false }],
  "no-restricted-syntax": [
    "error",
    {
      selector:
        "CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement'][body.body.length=0]",
      message:
        "Catch muto: un errore che non lascia traccia (AGENTS.md regola 6). Nel browser " +
        "usa logClient({ livello: 'warn', evento: 'fetch', messaggio: '<cosa-non-si-è-caricato>', " +
        "stato: res.status }); sul server logEvento(...). Se il fallimento è davvero " +
        "ignorabile, loggalo a 'info' spiegando perché: un commento non basta, perché non " +
        "si può interrogare in SQL alle tre di notte.",
    },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Progetti nativi Capacitor (M10): sorgenti native + shim Cordova vendorizzati
    // (ios/**/public/cordova.js ecc.) non vanno lintati dal gate del repo.
    "ios/**",
    "android/**",
    // Harness one-off del test 360° Primaria (script Playwright + tooling): non
    // è codice applicativo spedito, gira solo su richiesta. Escluso dal gate.
    "e2e/primaria-360/**",
    // Le sessioni parallele di Claude Code creano i propri worktree qui dentro:
    // COPIE COMPLETE del repo, su un ALTRO branch. Senza questa esclusione il gate
    // di questo branch fallisce per il codice di un branch diverso — e chi legge il
    // rosso non ha modo di capire che non è suo. (Stessa esclusione in vitest.config.ts.)
    ".claude/**",
  ]),

  /**
   * `no-console` su src/: un `console.*` diretto è un BYPASS dell'osservabilità, non una
   * scorciatoia innocua. Salta la redazione (e qui i dati sono di minori: allergie, diagnosi,
   * valutazioni), salta il contesto della richiesta (nessun requestId, nessun utente: la riga
   * non si correla con nient'altro), e non arriva mai in `app_log` — cioè evapora dopo un
   * giorno e non si può né contare né interrogare. Si passa da `@/lib/logging/logger`.
   *
   * `error` e non `warn`: la CI gira con `--max-warnings 0`, quindi un warning sarebbe già un
   * fallimento — ma con un messaggio che non dice che è una violazione, e dopo un po' si
   * imparerebbe a ignorarlo.
   */
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: { "no-console": "error" },
  },
  /**
   * Le uniche eccezioni, e ognuna ha una ragione che non si applica alle altre:
   *  · src/lib/logging/** È il logger: è l'unico posto autorizzato a scrivere su console,
   *    perché è il posto in cui la redazione e il contesto vengono applicati;
   *  · src/middleware.ts gira su EDGE, dove il logger (node:async_hooks, node:crypto) non è
   *    caricabile: lì la riga logfmt si scrive a mano;
   *  · src/instrumentation.ts è la RETE DI SICUREZZA — deve poter parlare anche quando è il
   *    logger stesso ad essere rotto, ed è bundlato anche per l'Edge.
   */
  {
    files: [
      "src/lib/logging/**/*.{ts,tsx}",
      "src/instrumentation.ts",
      "src/instrumentation-client.ts",
      "src/middleware.ts",
    ],
    rules: { "no-console": "off" },
  },

  /**
   * CATCH MUTI — il divieto che mancava.
   *
   * PERCHÉ ESISTE. AGENTS.md regola 6 vieta il `catch` che non logga da sempre, e al collaudo
   * del 2026-07-31 il repo ne conteneva 87. Nessuno era nuovo: la disciplina di chi scriveva
   * aveva retto, il debito no — perché la regola non aveva un gate, e una regola senza gate
   * non è una regola, è un auspicio. Sono quasi tutti `.catch(() => {})` in coda a una fetch
   * di pagina: il guasto si presenta all'utente come un elenco vuoto, che è indistinguibile
   * da «non c'è nessuno», e all'assistenza come niente del tutto. È la stessa ambiguità che
   * per mesi ha nascosto il guasto delle email di credenziali — «nessun log» non distingue
   * «tutto ok» da «non è mai partito niente».
   *
   * Vale su TUTTO `src/`: anche la pagina più innocua fa fetch di dati di minori.
   */
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: REGOLE_CATCH_MUTO,
  },
  /**
   * L'unica esenzione PERMANENTE, ed è la stessa di `no-console` per la stessa ragione:
   * `src/lib/logging/**` è il logger, e il suo fail-open è VOLUTO (regola 9: «il logger non
   * deve mai rompere l'app»). Loggare il fallimento del logging col logging è il modo più
   * diretto di costruire un ciclo infinito — e in produzione un ciclo infinito nel logging
   * non degrada l'osservabilità, degrada l'applicazione.
   *
   * Non passa dall'allowlist perché non è debito da smaltire: non finirà mai a zero.
   */
  {
    files: ["src/lib/logging/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": "off", "no-empty": "off" },
  },
  /**
   * L'esenzione TEMPORANEA: i file legacy dell'allowlist. Va per ULTIMA — in flat config
   * vince l'ultimo blocco che matcha, e messa prima verrebbe riaccesa dal blocco generale.
   *
   * ESLint qui tace su un file INTERO, quindi da solo lascerebbe questi 58 file come un porto
   * franco. Non succede: il lock conta le occorrenze una per una e pretende che il numero
   * combaci esattamente con l'allowlist. Le due difese si coprono a vicenda — ESLint ferma il
   * catch muto nei file NUOVI, il lock lo ferma in quelli VECCHI.
   */
  {
    files: catchMutiLegacy,
    rules: { "no-restricted-syntax": "off" },
  },
]);

export default eslintConfig;
