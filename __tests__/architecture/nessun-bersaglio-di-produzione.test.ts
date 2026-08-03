// @vitest-environment node
//
// Ambiente `node` e non jsdom: qui si misura il `fetch` del runtime e il client Supabase del
// SERVER. Un finto browser non aggiunge niente e renderebbe la misura dipendente da come jsdom
// espone `fetch` — cioè verde o rossa per una ragione che non c'entra con ciò che si verifica.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 🔴 LOCK — LA SUITE NON PARLA CON LA PRODUZIONE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO, misurato il 2026-08-03, e non è un'ipotesi: è successo.
 *
 * Sei route admin costruivano il proprio client con `createClient` di `@supabase/supabase-js`.
 * Portandole al factory strumentato (`@/lib/supabase/server-client`) — che è la correzione giusta,
 * e resta — hanno cominciato, **sotto vitest**, a puntare a `uimulkjyekgemjakmepp.supabase.co`:
 * il database di produzione, con 227 domande d'iscrizione e 152 codici fiscali di minori.
 *
 * La catena è questa, e va capita tutta perché ogni anello è ragionevole da solo:
 *  · `src/lib/supabase/public-config.ts` risolve `SUPABASE_URL` con un RIPIEGO HARD-CODED sulla
 *    produzione. In produzione serve, per la ragione scritta lì (le `NEXT_PUBLIC_*` su Vercel si
 *    sono rivelate fragili) — e infatti quel file NON si tocca;
 *  · è una `const` valutata all'IMPORT del modulo;
 *  · sotto vitest `.env.local` non viene caricato (verificato: `process.env.NEXT_PUBLIC_SUPABASE_URL`
 *    era **assente** dentro i test);
 *  · i test che «dirottavano su localhost» scrivevano `process.env` nel `beforeEach`, cioè DOPO
 *    che il modulo era già stato valutato.
 *
 * A fermare il danno era rimasta una cosa sola: che la chiave di servizio, in quel momento, fosse
 * assente. Con una `SUPABASE_SERVICE_ROLE_KEY` vera in ambiente, `npx vitest run` avrebbe eseguito
 * `auth.admin.updateUserById` (il reset della password di un genitore) e il ciclo di DELETE su 25
 * tabelle di `admin/wipe` **contro la produzione**.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * LE TRE DIFESE, e questo file le misura tutte e tre:
 *
 *  1. `vitest.config.ts` → `test.env`: URL e chiavi finti PRIMA di ogni import. Verificato che
 *     sovrascrivono anche l'ambiente di shell — una `NEXT_PUBLIC_SUPABASE_URL` di produzione
 *     esportata a mano non passa;
 *  2. `test/setup.ts`: una guardia su `globalThis.fetch` che LANCIA se l'URL nomina l'host di
 *     produzione. Non logga e tira dritto: una richiesta partita è già partita;
 *  3. il client vero: costruito dal factory, sotto vitest deve puntare a `localhost`. È la sonda
 *     che chiude il giro — le prime due possono esserci ed essere aggirate da un modulo che si
 *     costruisca l'indirizzo per conto suo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * ⚠️ COSA QUESTO LOCK **NON** COPRE. Un lock di cui si sopravvaluta la portata fa smettere di
 * guardare, ed è peggio di nessun lock.
 *
 *  · **Un test che sostituisce `globalThis.fetch` con il proprio.** Ce ne sono, ed è legittimo: la
 *    guardia (difesa 2) esce di scena. Ma un test che si finge la rete non la sta usando — il
 *    rischio residuo è il test che finge SOLO UNA PARTE della rete, e quello lo copre la difesa 1,
 *    che non dipende da nessuna sostituzione.
 *  · **Chi non passa da `fetch`.** Un client `pg` su TCP, un websocket, `child_process` che invoca
 *    `psql`: oggi in `src/` non ce n'è nessuno, e se ne comparisse uno questa guardia non lo
 *    vedrebbe. Andrebbe aggiunta una regola, non dedotto che sia sicuro.
 *  · **`e2e/`.** Playwright NON gira sotto vitest e non passa di qui. L'E2E ha un progetto Supabase
 *    suo (la sede fittizia `e2e00000-…`) e le sue regole; `npm run e2e` in locale è in `deny`
 *    proprio perché `.env.local` punta alla produzione.
 *  · **`scripts/`, `supabase/functions/`.** Fuori dal perimetro dei test.
 *  · **Che i mock siano quelli GIUSTI.** Questo lock impedisce alla suite di parlare con la
 *    produzione; non dice se un test che pensa di aver finto il database lo ha finto davvero. Il
 *    sintomo tipico — un client vero che risponde «non trovato» e un test che legge quel 404 come
 *    un esito applicativo — resta mestiere di chi scrive il test.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

const RADICE = process.cwd();

/**
 * L'host del progetto Supabase di PRODUZIONE, scritto a mano.
 *
 * NON si importa da `public-config.ts`: quel modulo espone l'URL *risolto*, che qui deve valere
 * `localhost` — importarlo renderebbe il confronto vero per costruzione. La stessa stringa sta in
 * `test/setup.ts`, e le due copie devono coincidere: è proprio quella coincidenza la misura.
 */
const HOST_DI_PRODUZIONE = 'uimulkjyekgemjakmepp.supabase.co';

/** Dove deve puntare la suite, e nient'altro. */
const BERSAGLIO_ATTESO = 'http://localhost:54321';

function leggi(rel: string): string {
    return fs.readFileSync(path.join(RADICE, rel), 'utf8');
}

describe('lock — nessun test può parlare con il database di produzione', () => {
    const fetchDelSetup = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = fetchDelSetup;
    });

    it('1. `vitest.config.ts` finge l\'ambiente Supabase PRIMA di ogni import', () => {
        const cfg = leggi('vitest.config.ts');
        // Il blocco `env:` non contiene graffe annidate: `[^}]*` resta DENTRO di esso. Con
        // `[\s\S]*` la regex attraverserebbe il file intero e sarebbe verde anche trovando i due
        // nomi in due punti scollegati — cioè leggerebbe a caso.
        const url = /env:\s*\{[^}]*NEXT_PUBLIC_SUPABASE_URL:\s*'([^']+)'/.exec(cfg)?.[1];
        expect(
            url,
            'Sparito (o rinominato) `NEXT_PUBLIC_SUPABASE_URL` dal blocco `test.env` di '
            + '`vitest.config.ts`. Senza, `SUPABASE_URL` di `public-config.ts` — che è una `const` '
            + 'valutata all\'IMPORT — ricade sul ripiego hard-coded, e il ripiego è la PRODUZIONE. '
            + 'Non si corregge `public-config.ts`: quel ripiego è codice di produzione e serve.',
        ).toBeDefined();
        expect(url as string, 'la configurazione dei test punta alla produzione').not.toContain(HOST_DI_PRODUZIONE);
        expect(url as string).toBe(BERSAGLIO_ATTESO);

        expect(
            /env:\s*\{[^}]*SUPABASE_SERVICE_ROLE_KEY:\s*'([^']+)'/.exec(cfg)?.[1],
            'la chiave di servizio non è più finta nella configurazione dei test',
        ).toBeDefined();
    });

    it('2. e il valore è arrivato davvero: sotto vitest l\'ambiente NON è quello di produzione', () => {
        // Non basta che la dichiarazione ci sia: deve essere in vigore. Sono due cose diverse — una
        // `env` messa nella sezione sbagliata del config è una riga che sembra una difesa e non lo è.
        expect(process.env.NEXT_PUBLIC_SUPABASE_URL, 'l\'URL finto non è in vigore').toBe(BERSAGLIO_ATTESO);
        expect(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', 'la chiave finta non è in vigore').not.toBe('');
        // Una chiave di servizio VERA è un JWT: comincia per `eyJ`. Se ne trovassimo una qui, la
        // difesa 1 non starebbe sovrascrivendo l'ambiente — e la suite avrebbe in mano le chiavi
        // del database dei minori.
        expect(
            (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').startsWith('eyJ'),
            'la suite ha in mano una chiave di servizio che sembra VERA: `test.env` non sta più '
            + 'sovrascrivendo l\'ambiente',
        ).toBe(false);
    });

    it('3. `SUPABASE_URL`, il valore che i client usano davvero, punta a localhost', async () => {
        const { SUPABASE_URL } = await import('@/lib/supabase/public-config');
        expect(SUPABASE_URL, 'nessun URL risolto: il modulo non si legge più').toBeTruthy();
        expect(
            SUPABASE_URL,
            'Sotto vitest i client Supabase puntano alla PRODUZIONE. È il difetto del 2026-08-03: '
            + 'un `npx vitest run` che esegue reset di password e DELETE contro i dati veri dei minori.',
        ).not.toContain(HOST_DI_PRODUZIONE);
        expect(SUPABASE_URL).toBe(BERSAGLIO_ATTESO);
    });

    it('4. LA GUARDIA BLOCCA: una `fetch` verso l\'host di produzione lancia', async () => {
        // È la difesa che vale anche quando le altre due sono aggirate — un modulo che si
        // costruisca l'indirizzo da sé, un test che scriva `process.env` a mano.
        await expect(
            globalThis.fetch(`https://${HOST_DI_PRODUZIONE}/rest/v1/alunni?select=id`),
        ).rejects.toThrow(/TEST VERSO LA PRODUZIONE BLOCCATO/);
    });

    it('4-bis. …e NON blocca tutto il resto (altrimenti non misurerebbe niente)', async () => {
        // CONTROLLO DI VALIDITÀ. Una guardia che lanciasse su qualunque URL renderebbe verde il
        // test qui sopra senza distinguere niente — e romperebbe le misure contro i server muti di
        // `logging-tetto` e `middleware-tetto`, che chiamano `127.0.0.1` sul serio.
        // La porta 1 rifiuta la connessione: l'errore è del runtime, non nostro.
        const errore = await globalThis.fetch('http://127.0.0.1:1/').then(
            () => new Error('la chiamata NON doveva riuscire'),
            (e: unknown) => e as Error,
        );
        expect(String(errore.message), 'la guardia sta bloccando anche ciò che non è produzione')
            .not.toMatch(/TEST VERSO LA PRODUZIONE BLOCCATO/);
    });

    it('5. LA SONDA: il client del factory strumentato interroga localhost, non la produzione', async () => {
        // Le regole 1-4 guardano la configurazione e la guardia. Questa guarda la cosa vera: si
        // costruisce il client come lo costruisce una route (`createAdminClient()`), si fa una
        // query, e si legge DOVE è andata. È l'unico punto in cui «l'ambiente è finto» e «il
        // client obbedisce all'ambiente» sono due affermazioni distinte.
        const chiamate: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            chiamate.push(typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request).url));
            return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof globalThis.fetch;

        const { createAdminClient } = await import('@/lib/supabase/server-client');
        const admin = await createAdminClient();
        await admin.from('alunni').select('id').limit(1);

        expect(chiamate.length, 'la sonda non ha visto nessuna chiamata: non sta misurando niente')
            .toBeGreaterThan(0);
        for (const url of chiamate) {
            expect(url, `il client del factory ha interrogato la PRODUZIONE: ${url}`)
                .not.toContain(HOST_DI_PRODUZIONE);
            expect(new URL(url).origin, `bersaglio inatteso: ${url}`).toBe(BERSAGLIO_ATTESO);
        }
    });

    it('6. l\'indirizzo di produzione vive in UN file solo di `src/`', () => {
        // Non è pedanteria: finché il ripiego sta in `public-config.ts` e basta, spegnerlo sotto
        // vitest è una riga di configurazione. Una seconda copia altrove — in un client, in un
        // `fetch` a mano, in una costante «di comodo» — sarebbe una strada che `test.env` non
        // chiude, e nessuno se ne accorgerebbe.
        const conLHost: string[] = [];
        const visita = (dir: string) => {
            for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
                const assoluto = path.join(dir, voce.name);
                if (voce.isDirectory()) { visita(assoluto); continue; }
                if (!/\.tsx?$/.test(voce.name)) continue;
                if (fs.readFileSync(assoluto, 'utf8').includes(HOST_DI_PRODUZIONE)) {
                    conLHost.push(path.relative(RADICE, assoluto).split(path.sep).join('/'));
                }
            }
        };
        visita(path.join(RADICE, 'src'));

        expect(
            conLHost.sort(),
            'L\'indirizzo del progetto di produzione è comparso in un secondo file di `src/`. Il '
            + 'ripiego vive in `public-config.ts` e lì soltanto: è la sola ragione per cui basta una '
            + 'riga di `vitest.config.ts` per staccare l\'intera suite dai dati veri dei minori.',
        ).toEqual(['src/lib/supabase/public-config.ts']);
    });

    it('7. la guardia è ancora scritta in `test/setup.ts`, con lo stesso host', () => {
        // La regola 4 la misura sul comportamento; questa dice DOVE andare a guardare quando
        // diventa rossa, e àncora la stringa: due copie dell'host che devono coincidere.
        const setup = leggi('test/setup.ts');
        expect(setup, 'la guardia su `globalThis.fetch` è sparita da test/setup.ts').toContain(HOST_DI_PRODUZIONE);
        expect(setup).toContain('TEST VERSO LA PRODUZIONE BLOCCATO');
    });
});
