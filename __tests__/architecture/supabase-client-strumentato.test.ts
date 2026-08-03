import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * LOCK — un client Supabase LATO SERVER si costruisce in un posto solo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO CHE QUESTO LOCK ESISTE PER IMPEDIRE (misurato il 2026-08-03).
 *
 * `src/lib/supabase/server-client.ts` monta su OGNI client il `fetch` strumentato di
 * `src/lib/logging/supabase-fetch.ts`. Quel `fetch` fa due cose che nessun altro fa:
 *
 *  · vede il 4xx di PostgREST **anche quando il codice applicativo non guarda l'`{ error }`**
 *    — che nel repo succede in 73 scritture fire-and-forget (AGENTS.md, regola 7: PostgREST non
 *    lancia, ritorna `{ error }`, e un `try/catch` attorno a una query non scatta MAI);
 *  · mette un TETTO DI TEMPO sulla chiamata. Senza, un bersaglio che accetta la connessione e
 *    tace la tiene appesa — misurato: 150 secondi, senza eccezione né timeout.
 *
 * Sei route non passavano di lì. Importavano `createClient` da `@supabase/supabase-js` e si
 * costruivano il proprio client con la service-role key: `admin/regenerate-credentials`,
 * `admin/credentials-pdf`, `admin/students/[id]`, `admin/backfill-auth`, `admin/test-relations`,
 * `admin/wipe`. Fra queste, le DUE che gestiscono le credenziali dei genitori — cioè il percorso
 * da cui nasce la regola 3 di AGENTS.md, quella scritta dopo mesi di email di credenziali mai
 * arrivate perché il codice registrava `403` e buttava via il motivo.
 *
 * Nessun test era rosso, e non poteva esserlo: `logging-coverage.test.ts` sorveglia che ogni
 * route sia avvolta in `withRoute` (l'osservabilità della richiesta ENTRANTE), non con che client
 * parla. Su quale client si costruisce non c'era niente. Questo file è quel niente.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * COSA SORVEGLIA, e perché ciascuna regola:
 *
 *  1. **Nessuno importa un VALORE da `@supabase/supabase-js`.** I TIPI sì, e sono un centinaio
 *     (`import type { SupabaseClient }`): il tipo non costruisce niente. È `createClient` la
 *     porta da cui si esce dal perimetro strumentato.
 *  2. **`createServerClient` di `@supabase/ssr` si chiama solo dove è dichiarato.** Due posti, e
 *     il secondo — il middleware — ha un obbligo suo, verificato qui sotto.
 *  3. **Controllo positivo: i factory sono davvero strumentati.** Un lock che verifica solo
 *     assenze resta verde anche quando il codice sparisce, ed è così che un lock muore.
 *  4. **`createLogClient` NON deve essere strumentato**, ed è l'unica eccezione: un errore di
 *     scrittura su `app_log` che generasse un log che tenta di scrivere su `app_log` è ricorsione
 *     fino all'OOM. Qui si pretende l'assenza, non la presenza.
 *  5. **La settima strada: un `fetch` grezzo verso l'host Supabase.** Costruire il client non è
 *     l'unico modo di parlare col database: si può fare a mano, con la service-role key in un
 *     header. Chi lo fa è dichiarato, con la ragione.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * ⚠️ COSA QUESTO LOCK **NON** COPRE. Va saputo prima di fidarsene — un lock di cui si
 * sopravvaluta la portata è peggio di nessun lock, perché fa smettere di guardare.
 *
 *  · **IL BROWSER.** `createBrowserClient` è fuori perimetro: lì non esiste né
 *    `creaFetchStrumentato` (scriverebbe su `app_log` con un client di servizio che nel browser
 *    non c'è) né un tetto. Le chiamate del browser sono viste dal patch di `window.fetch` in
 *    `src/lib/logging/client.ts` — che però, per scelta dichiarata, NON spedisce i 4xx (una
 *    sessione scaduta e una password sbagliata sono risposte corrette, e una riga per ognuna
 *    sarebbe la tabella di rumore in cui gli errori veri non si trovano più). Quindi: le chiamate
 *    Supabase del browser **non hanno tetto**, e i loro 4xx **non arrivano in tabella**. È un
 *    buco noto, non coperto qui, e i tre file che costruiscono un client di browser sono elencati
 *    in `CLIENT_DI_BROWSER` perché almeno l'inventario resti vero.
 *  · **Che il client venga USATO bene.** Il lock vede da dove arriva, non se il chiamante
 *    controlla l'`{ error }` che riceve. Quello è mestiere della revisione e di
 *    `catch-muti-allowlist.test.ts`.
 *  · **`e2e/`, `scripts/`, `supabase/functions/`.** Fuori da `src/`: non finiscono nel prodotto.
 *  · **Un `fetch` verso Supabase che si costruisca l'URL a distanza.** La regola 5 riconosce i
 *    file che NOMINANO l'URL o la service-role key e fanno un `fetch` grezzo. Chi passasse
 *    l'indirizzo attraverso tre moduli sfuggirebbe alla misura testuale. Costo dichiarato: un
 *    parser vero su 860 file costerebbe più del gate intero, ed è la stessa scelta di tutti i
 *    lock di questa cartella.
 *  · **Il TETTO in sé.** Che la primitiva sia una sola e sia applicata lo tiene
 *    `__tests__/lib/logging-tetto.test.ts`; che il middleware non resti appeso lo misura
 *    `__tests__/lib/middleware-tetto.test.ts`, contro un server vero che accetta e tace.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');

/** Il file che ha il monopolio dei client server-side. */
const FACTORY = 'src/lib/supabase/server-client.ts';

/**
 * Il middleware è il SECONDO posto che può chiamare `createServerClient`, e non è una deroga:
 * è un runtime diverso. Sull'Edge la catena `logger → redact → node:crypto` non si carica, quindi
 * `creaFetchStrumentato` è irraggiungibile per costruzione. Ciò che il middleware DEVE fare —
 * ed è verificato — è prendere comunque il tetto dalla primitiva condivisa, che sull'Edge gira.
 */
const MIDDLEWARE = 'src/middleware.ts';

/**
 * I client di BROWSER. Non sono coperti (vedi la testata): stanno qui perché l'inventario sia
 * vero e perché il giorno in cui ne comparisse un quarto qualcuno debba scriverne la ragione.
 */
const CLIENT_DI_BROWSER = new Map<string, string>([
    ['src/lib/supabase/browser-client.ts', 'il singleton `getSupabase()`: è il client che dovrebbero usare tutti.'],
    ['src/components/features/admin/ImportExportClient.tsx',
        'si costruisce un client proprio invece di usare `getSupabase()`. Non è coperto da questo lock, '
        + 'ma è un secondo singleton di fatto: due client sulla stessa pagina significano due sessioni '
        + 'da tenere allineate.'],
    ['src/lib/offline/syncEngine.ts',
        'idem, nel motore di sincronizzazione offline. Qui la duplicazione ha una ragione in più — gira '
        + 'fuori dal ciclo di React, su risveglio della rete — ma resta un client non strumentato.'],
]);

/**
 * LA SETTIMA STRADA: chi nomina l'indirizzo (o la chiave di servizio) di Supabase E fa un `fetch`
 * grezzo. Non costruisce un client, ma parla lo stesso col nostro database.
 */
const FETCH_VERSO_SUPABASE = new Map<string, string>([
    ['src/app/api/admin/apply-enrollment-migration/route.ts',
        'DEROGA, ed è debito dichiarato. Sei `fetch` a mano verso `/rest/v1/rpc/exec_sql` e `/pg/query` '
        + 'con la service-role key negli header: nessun tetto, nessuna riga. NON è stata portata al '
        + 'factory per due ragioni concrete: `/pg/query` non ha nessun equivalente in supabase-js (è un '
        + 'endpoint che sull\'hosted non esiste nemmeno, ed è il ramo di ripiego), e la route è '
        + '`sealDangerous`, cioè risponde 404 in produzione — le migrazioni oggi si applicano con lo '
        + 'strumento MCP `apply_migration`. Il rischio residuo è quindi limitato a sviluppo e preview, '
        + 'dove appende la richiesta di chi la invoca. Va rimossa o ricondotta, non condonata.'],
    ['src/components/features/admin/ImportExportClient.tsx',
        'FALSO POSITIVO dichiarato: nomina `NEXT_PUBLIC_SUPABASE_URL` per costruire il proprio client '
        + 'di browser, e il suo unico `fetch` va a `/api/admin/import/anagrafiche`, cioè a una NOSTRA '
        + 'route — che è avvolta in `withRoute` e parla col database dal server, strumentata.'],
    ['src/lib/offline/syncEngine.ts',
        'FALSO POSITIVO dichiarato, stessa forma: i suoi cinque `fetch` vanno tutti a `/api/**` nostre. '
        + 'Nessuno di essi esce verso l\'host Supabase.'],
    ['src/middleware.ts',
        'FALSO POSITIVO dichiarato, e sta QUI e non in un\'eccezione dentro la regex — che è dove '
        + 'stava prima, con l\'esclusione del punto in `FETCH_GREZZO`, e da lì apriva il buco a tutti '
        + 'gli altri file. Il suo `globalThis.fetch(` non è una settima strada: è il CORPO del wrapper '
        + '`fetchConBudget`, cioè la chiamata vera che il tetto del middleware avvolge, montata sul '
        + 'client con `global: { fetch }` e verificata dalla regola 5 di questo file e da '
        + '`__tests__/lib/middleware-tetto.test.ts`. Sull\'Edge `creaFetchStrumentato` non si carica '
        + '(`logger → redact → node:crypto`), quindi il wrapper qui non può che essere a mano.'],
]);

/* ────────────────────────────────────────────────────────────────────────────────
 * LA MISURA. Testuale, come gli altri lock di questa cartella: far girare un parser vero su
 * ~860 file costerebbe più del gate intero.
 * ──────────────────────────────────────────────────────────────────────────────── */

/**
 * Il sorgente senza commenti.
 *
 * Il `//` di uno SCHEMA non è un commento: senza l'esclusione del `:` che lo precede, una riga con
 * `'https://…'` verrebbe troncata e il lock leggerebbe metà file convinto di averlo letto tutto.
 * È una via silenziosa con cui un lock smette di verificare senza diventare rosso.
 */
function senzaCommenti(sorgente: string): string {
    return sorgente
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function sorgenti(dir = SRC): string[] {
    const out: string[] = [];
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const assoluto = path.join(dir, voce.name);
        if (voce.isDirectory()) { out.push(...sorgenti(assoluto)); continue; }
        if (!/\.tsx?$/.test(voce.name)) continue;
        out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'));
    }
    return out;
}

const FILES = sorgenti();
const CODICE = new Map<string, string>(
    FILES.map((f) => [f, senzaCommenti(fs.readFileSync(path.join(RADICE, f), 'utf8'))]),
);

/**
 * Gli import da un pacchetto. La clausola è un gruppo di graffe, un `* as X` o un identificatore:
 * niente `[\s\S]*?`, che attraverserebbe gli import precedenti e attribuirebbe a un pacchetto i
 * binding di un altro — un lock che sbaglia a leggere è un lock che assolve a caso.
 */
function importiDa(sorgente: string, pacchetto: string): { soloTipo: boolean; clausola: string }[] {
    const re = new RegExp(
        `import\\s+(type\\s+)?(\\{[^}]*\\}|\\*\\s+as\\s+\\w+|\\w+)\\s+from\\s+['"]${pacchetto}['"]`,
        'g',
    );
    return [...sorgente.matchAll(re)].map((m) => ({ soloTipo: !!m[1], clausola: m[2] }));
}

/**
 * LE RI-ESPORTAZIONI, che sono la stessa porta con un'altra maniglia.
 *
 * `export { createClient } from '@supabase/supabase-js'` non è un `import`, e per mezza giornata
 * questo lock non l'ha vista: un verificatore ha creato `src/lib/supabase/sdk.ts` con quella sola
 * riga, ci ha riportato `admin/wipe` al client nudo — il ciclo di DELETE su 25 tabelle senza tetto
 * e senza riga — e il lock è rimasto 8/8. Da quel momento nessuno dei file che attingono al barrel
 * sarebbe più stato visibile, perché ciò che importano è un modulo NOSTRO.
 *
 * `export type { … } from` e `export { type X } from` restano leciti: un tipo non costruisce niente.
 */
function riesportazioniDa(sorgente: string, pacchetto: string): { soloTipo: boolean; clausola: string }[] {
    const re = new RegExp(
        `export\\s+(type\\s+)?(\\{[^}]*\\}|\\*(?:\\s+as\\s+\\w+)?)\\s+from\\s+['"]${pacchetto}['"]`,
        'g',
    );
    return [...sorgente.matchAll(re)].map((m) => ({ soloTipo: !!m[1], clausola: m[2] }));
}

/** I binding di VALORE di una clausola: `{ type A, b }` → `['b']`. */
function valoriImportati(clausola: string): string[] {
    if (!clausola.startsWith('{')) return [clausola];
    return clausola.slice(1, -1).split(',')
        .map((s) => s.trim()).filter(Boolean)
        .filter((b) => !/^type\s/.test(b))
        .map((b) => b.split(/\s+as\s+/)[0].trim());
}

/**
 * file → valori di quel pacchetto che il file PRENDE, per import o per ri-esportazione.
 *
 * Il nome dice «prende» e non «importa» apposta: le due forme sono la stessa uscita dal perimetro
 * strumentato, e chiamarne una sola col nome della regola è il modo in cui il buco è rientrato.
 */
function chiPrendeUnValoreDa(pacchetto: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [f, src] of CODICE) {
        const valori = [...importiDa(src, pacchetto), ...riesportazioniDa(src, pacchetto)]
            .filter((i) => !i.soloTipo)
            .flatMap((i) => valoriImportati(i.clausola));
        if (valori.length > 0) out.set(f, valori);
    }
    return out;
}

/**
 * Un `fetch(` chiamato a mano. Il carattere prima esclude solo i nomi che FINISCONO in `fetch`
 * (`externalFetch(`, `creaFetch(`): quelli sono i nostri wrapper.
 *
 * ⚠️ IL PUNTO NON SI ESCLUDE PIÙ, ed è la correzione di un aggiramento reale. L'esclusione
 * `[^\w.$]` era stata scritta per non far diventare rosso `src/middleware.ts`, che usa
 * `globalThis.fetch(` e nomina `SUPABASE_URL` — ma una deroga scritta nella REGOLA vale per tutti:
 * un verificatore ha aggiunto `globalThis.fetch(\`${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/scuole\`, {
 * headers: { apikey: SUPABASE_SERVICE_ROLE_KEY } })` dentro `admin/test-relations` — cioè
 * esattamente la settima strada che questa regola descrive — e il lock è rimasto 8/8. Adesso il
 * middleware sta dove devono stare le eccezioni, cioè in `FETCH_VERSO_SUPABASE`, con scritto
 * perché; e l'esclusione non copre più nessun altro.
 */
const FETCH_GREZZO = /(^|[^\w$])fetch\s*\(/g;
/** Il file nomina l'indirizzo del progetto o la chiave che apre il database. */
const CHIAVI_SUPABASE = /SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY/;
/** Il modulo che IMPLEMENTA il fetch strumentato: la sua `fetch` è la chiamata vera. */
const ESENTE = 'src/lib/logging/';

const DA_SUPABASE_JS = chiPrendeUnValoreDa('@supabase/supabase-js');
const DA_SSR = chiPrendeUnValoreDa('@supabase/ssr');

describe('lock — i client Supabase lato server nascono tutti dal factory strumentato', () => {
    it('la misura vede davvero il codice (autoinganno: se lo scanner non trova niente, il lock cade)', () => {
        // Senza questo, un errore nel path o nella regex renderebbe VERDI tutte le regole qui
        // sotto: «zero file scanditi» e «zero violazioni» hanno lo stesso colore.
        expect(FILES.length).toBeGreaterThan(500);
        expect(CODICE.get(FACTORY), 'il factory è sparito: questo lock non verifica più niente').toBeDefined();
        // Il tipo `SupabaseClient` è importato da un centinaio di file: se lo scanner degli import
        // non lo vede, non vedrebbe nemmeno un `createClient`.
        const conIlTipo = [...CODICE.entries()]
            .filter(([, s]) => importiDa(s, '@supabase/supabase-js').some((i) => i.soloTipo));
        expect(conIlTipo.length, 'lo scanner degli import non legge più le clausole').toBeGreaterThan(50);

        // I DUE LETTORI, provati su un caso costruito. Nel repo di oggi non esiste nessuna
        // ri-esportazione da `@supabase/supabase-js`, quindi la regola 1 sarebbe verde anche con
        // `riesportazioniDa` rotta: «nessuna violazione» e «non so leggerle» avrebbero di nuovo lo
        // stesso colore. È il modo esatto in cui questo lock era stato aggirato.
        const finto = [
            "export { createClient } from '@supabase/supabase-js';",
            "export type { SupabaseClient } from '@supabase/supabase-js';",
            "export { type Session } from '@supabase/supabase-js';",
            "export * from '@supabase/supabase-js';",
        ].join('\n');
        const lette = riesportazioniDa(finto, '@supabase/supabase-js');
        expect(lette.length, 'lo scanner delle RI-ESPORTAZIONI non legge più le clausole').toBe(4);
        expect(
            lette.filter((r) => !r.soloTipo).flatMap((r) => valoriImportati(r.clausola)).sort(),
            'una ri-esportazione di VALORE non viene più riconosciuta: il barrel torna invisibile',
        ).toEqual(['*', 'createClient']);

        // E il lettore dei corpi vede anche le arrow function, che è l'altro aggiramento da una riga.
        const corpiFinti = corpiDeiFactory(
            'export async function unoVecchio() { createServerClient(a, b, {}) }\n'
            + 'export const unoNuovo = async () => createServerClient(a, b, {})\n',
        );
        expect([...corpiFinti.keys()], 'un factory in forma di arrow function è di nuovo invisibile')
            .toEqual(['unoVecchio', 'unoNuovo']);
    });

    it('1. nessun file di `src/` prende un VALORE da `@supabase/supabase-js` (né importandolo, né ri-esportandolo)', () => {
        expect(
            [...DA_SUPABASE_JS.entries()].map(([f, v]) => `${f} → ${v.join(', ')}`).sort(),
            'Client Supabase costruito fuori dal perimetro strumentato. Un client così è MUTO (non '
            + 'vede il 4xx di PostgREST che il codice applicativo ignora — regola 7 di AGENTS.md) e '
            + 'SENZA TETTO (un bersaglio che accetta e tace appende la route: misurato, 150 secondi). '
            + 'Si prende il client da `@/lib/supabase/server-client` — `createAdminClient()` per il '
            + 'service-role, `createSessionClient()` quando deve valere la RLS. I TIPI si continuano '
            + 'a importare con `import type`, che non costruisce niente. E vale anche per un BARREL '
            + '(`export { createClient } from …`): ri-esportare la porta non la chiude, la sposta — '
            + 'da lì in poi chi vi attinge importa un modulo nostro e questo lock non lo vede più.',
        ).toEqual([]);
    });

    it('2. `createServerClient` di `@supabase/ssr` si chiama solo dove è dichiarato', () => {
        const serverClient = [...DA_SSR.entries()]
            .filter(([, v]) => v.includes('createServerClient'))
            .map(([f]) => f).sort();

        expect(
            serverClient,
            'Un client server-side costruito fuori dal factory. Vale la stessa regola del punto 1: '
            + 'il pacchetto cambia, il buco è identico — nessun `global: { fetch }`, quindi nessun '
            + 'tetto e nessuna osservabilità.',
        ).toEqual([FACTORY, MIDDLEWARE].sort());
    });

    it('3. CONTROLLO POSITIVO: ogni factory del server monta il fetch strumentato', () => {
        const src = CODICE.get(FACTORY) as string;
        expect(src).toContain('creaFetchStrumentato');

        // Si guarda il CORPO di ogni export di primo livello, non il file intero: un solo
        // `global: { fetch }` da qualche parte renderebbe verde anche un factory che non ce l'ha.
        const blocchi = corpiDeiFactory(src);
        expect(blocchi.size, 'i factory non si leggono più: aggiornare `corpiDeiFactory`').toBeGreaterThanOrEqual(4);

        // IL LOCK SA ANCORA LEGGERE IL FILE. Il conteggio dei blocchi da solo non basta: i cinque
        // factory vecchi ci sono sempre, quindi `blocchi.size >= 4` regge anche quando il sesto è
        // scritto in una forma che lo scanner non riconosce — ed è così che un
        // `export const createReportClient = async () => createServerClient(…)` è passato. Qui si
        // pretende che OGNI `createServerClient(` del file cada dentro un blocco: se il totale non
        // torna, c'è un client che nessuna delle regole qui sotto sta guardando.
        const totale = quante(src, /createServerClient\(/g);
        const neiBlocchi = [...blocchi.values()].reduce((n, corpo) => n + quante(corpo, /createServerClient\(/g), 0);
        expect(
            neiBlocchi,
            `${totale - neiBlocchi} chiamata/e a \`createServerClient(\` in ${FACTORY} cadono FUORI da `
            + 'ogni export riconosciuto: o è un client costruito a livello di modulo, o è scritto in '
            + 'una forma che `corpiDeiFactory` non legge. In entrambi i casi le regole 3 e 4 non lo '
            + 'stanno guardando — aggiornare lo scanner, non il codice.',
        ).toBe(totale);

        const nudi = [...blocchi.entries()]
            .filter(([nome, corpo]) => nome !== 'createLogClient'
                && corpo.includes('createServerClient(')
                && !/global:\s*\{\s*fetch:\s*fetchStrumentato\s*\}/.test(corpo))
            .map(([nome]) => nome);

        expect(
            nudi,
            'Un factory di `server-client.ts` costruisce un client SENZA il fetch strumentato. Va su '
            + 'TUTTI, non solo sull\'admin: `createClient()` è quello che usa `resolveIdentity()`, '
            + 'cioè il gate di autenticazione — strumentare solo l\'admin significa non vedere mai le '
            + 'query che rompono i login.',
        ).toEqual([]);
    });

    it('4. `createLogClient` è l\'UNICO senza strumentazione, e deve restarlo', () => {
        // Qui si pretende un'ASSENZA, ed è l'unico punto del lock in cui è la cosa giusta: se
        // questo client avesse il fetch strumentato, un errore di scrittura su `app_log`
        // genererebbe un log che tenta di scrivere su `app_log` → ricorsione fino all'OOM, in
        // produzione. È la PRIMA delle due difese; la seconda è la guardia `inLogger()`.
        const corpo = corpiDeiFactory(CODICE.get(FACTORY) as string).get('createLogClient');
        expect(corpo, '`createLogClient` è sparito: rileggere la nota sulla ricorsione').toBeDefined();
        expect(corpo as string).toContain('createServerClient(');
        expect(
            (corpo as string).includes('fetchStrumentato'),
            'Il client dei LOG è stato strumentato: una scrittura fallita su `app_log` proverebbe a '
            + 'scrivere su `app_log` che è fallita, all\'infinito.',
        ).toBe(false);
    });

    it('5. il MIDDLEWARE, che non può usare il factory, prende comunque il tetto dalla primitiva', () => {
        // Sull'Edge `creaFetchStrumentato` non si carica (`logger → redact → node:crypto`). Ma il
        // tetto sì: `@/lib/logging/tetto` non importa niente. Rinunciare a entrambi lascerebbe
        // senza scadenza il percorso da cui passa OGNI richiesta del sito — che è com'era.
        const src = CODICE.get(MIDDLEWARE) as string;
        expect(src, 'il middleware non prende più il tetto dalla primitiva condivisa')
            .toMatch(/import\s*\{[^}]*conTetto[^}]*\}\s*from\s*'@\/lib\/logging\/tetto'/);
        expect(src, 'il client del middleware non riceve più un `fetch` nostro')
            .toMatch(/global:\s*\{\s*fetch:/);
        expect(src, 'il tetto non è più applicato alla fetch del middleware').toContain('conTetto(');
    });

    it('6. LA SETTIMA STRADA: chi parla con Supabase a mano è dichiarato', () => {
        const grezzi = [...CODICE.entries()]
            .filter(([f]) => !f.startsWith(ESENTE))
            .filter(([, s]) => CHIAVI_SUPABASE.test(s))
            .filter(([, s]) => [...s.matchAll(FETCH_GREZZO)].length > 0)
            .map(([f]) => f).sort();

        expect(
            grezzi.filter((f) => !FETCH_VERSO_SUPABASE.has(f)),
            'Un file nomina l\'indirizzo (o la chiave di servizio) di Supabase e fa un `fetch` a '
            + 'mano. Costruire il client non è l\'unico modo di uscire dal perimetro strumentato: si '
            + 'può anche parlare col database direttamente, con la service-role key in un header, e '
            + 'il risultato è lo stesso — nessun tetto, nessuna riga. Se la chiamata va davvero a '
            + 'Supabase, si usa il client del factory; se invece va a una NOSTRA route `/api/**`, lo '
            + 'si dichiari in `FETCH_VERSO_SUPABASE` come falso positivo, con il perché.',
        ).toEqual([]);
    });

    it('ogni deroga è motivata, viva e non gonfiata', () => {
        for (const [file, perche] of FETCH_VERSO_SUPABASE) {
            expect(CODICE.has(file), `deroga su un file che non esiste più: ${file}`).toBe(true);
            expect(perche.length, `la deroga di ${file} non è motivata`).toBeGreaterThan(120);
            // Una deroga che non serve più è peggio di una deroga sbagliata: insegna che l'elenco
            // è una formalità. Se il file non ha più `fetch` grezzi, va tolta.
            expect(
                [...(CODICE.get(file) as string).matchAll(FETCH_GREZZO)].length,
                `${file} non ha più `.concat('`fetch` grezzi: togliere la deroga'),
            ).toBeGreaterThan(0);
        }
        for (const [file, perche] of CLIENT_DI_BROWSER) {
            expect(CODICE.has(file), `client di browser dichiarato ma sparito: ${file}`).toBe(true);
            expect(perche.length, `${file} non è motivato`).toBeGreaterThan(60);
        }
        // E l'inventario dei client di browser è ESATTO: un quarto file che se ne costruisce uno
        // deve dichiararsi, non entrare in silenzio.
        expect(
            [...DA_SSR.entries()].filter(([, v]) => v.includes('createBrowserClient')).map(([f]) => f).sort(),
            'Client Supabase di BROWSER non dichiarato. Non è coperto da questo lock (vedi la testata: '
            + 'lì non c\'è né tetto né persistenza dei 4xx), ma l\'inventario deve restare vero — e la '
            + 'domanda giusta, quasi sempre, è perché non si usa `getSupabase()`.',
        ).toEqual([...CLIENT_DI_BROWSER.keys()].sort());
    });
});

/**
 * I corpi degli export di primo livello di `server-client.ts`, per nome.
 *
 * ⚠️ LE ARROW FUNCTION CONTANO, ed è la correzione di un aggiramento reale. La regex prima era
 * `/export\s+async\s+function\s+(\w+)\s*\(/`: un verificatore ha aggiunto in fondo al file
 * `export const createReportClient = async () => createServerClient(…)` — senza
 * `global: { fetch: fetchStrumentato }`, cioè un client server muto e senza tetto DENTRO il file
 * che questo lock esiste per sorvegliare — e il test è rimasto 8/8, perché il factory nuovo era
 * invisibile e `blocchi.size >= 4` reggeva coi cinque vecchi.
 *
 * Il taglio è sul prossimo `export`. Chi legge questa funzione deve sapere che il conteggio dei
 * blocchi non basta da solo: il test 3 verifica anche che TUTTE le occorrenze di
 * `createServerClient(` del file cadano dentro un blocco riconosciuto — se una resta fuori, il
 * lock ha smesso di saper leggere il file e lo dice, invece di assolvere ciò che non vede.
 */
function corpiDeiFactory(sorgente: string): Map<string, string> {
    const out = new Map<string, string>();
    const re = /export\s+(?:async\s+)?(?:function\s+(\w+)\s*\(|const\s+(\w+)\s*=)/g;
    const inizi = [...sorgente.matchAll(re)].map((m) => ({ nome: m[1] ?? m[2], da: m.index ?? 0 }));
    inizi.forEach(({ nome, da }, i) => {
        const a = i + 1 < inizi.length ? inizi[i + 1].da : sorgente.length;
        out.set(nome, sorgente.slice(da, a));
    });
    return out;
}

/** Quante volte compare `ago` in `dove`. */
function quante(dove: string, ago: RegExp): number {
    return [...dove.matchAll(ago)].length;
}
