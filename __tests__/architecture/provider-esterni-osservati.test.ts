import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock sui PROVIDER ESTERNI — ogni chiamata a un host di terze parti passa da `externalFetch`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * LA STORIA, ed è la stessa di sempre. Per mesi nessuna email di credenziali arrivò a un
 * genitore: Resend rispondeva `403` e il codice registrava soltanto il numero, mentre il corpo
 * diceva «the kidville.it domain is not verified». Da lì nasce `src/lib/logging/external.ts` e
 * la regola 3 di AGENTS.md, che elenca i provider PER NOME: «email, FCM, web-push, **Aruba/SDI**,
 * SIDI».
 *
 * Il 2026-08-02 il collaudo ha misurato che uno di quei nomi era rimasto fuori. Il client Aruba
 * (`src/lib/aruba/client.ts`) faceva SEI `fetch` a mano e cinque
 * `throw new Error(\`… (HTTP ${res.status})\`)`: in `app_log` restava «Aruba signin fallita
 * (HTTP 401)», su un percorso con obblighi fiscali. Il file era nato a giugno, PRIMA che il
 * modulo esistesse (luglio), e non era mai stato ricondotto. Nessun test era rosso — e non
 * poteva esserlo: `logging-coverage.test.ts` sorveglia le route, cioè le chiamate ENTRANTI.
 * Sulle chiamate USCENTI non c'era niente.
 *
 * Questo file è quel «niente». La regola 3 aveva un elenco solo in prosa: qui l'elenco è
 * eseguibile, e un provider nuovo non può entrare nel repo senza dichiararsi.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * COSA SORVEGLIA, e perché ciascuna regola:
 *
 *  1. **L'inventario è esaustivo.** Ogni host di terze parti che compare come LETTERALE in
 *     `src/` sta o fra i provider qui sotto o fra gli host che non si chiamano (un iframe, un
 *     namespace XML, un link in una pagina legale). Senza questa regola il lock difenderebbe
 *     solo i provider che qualcuno si è ricordato di scrivere — cioè difenderebbe il passato.
 *  1-bis. **Alcuni host sono VIETATI, non «da dichiarare».** La regola 1 chiede di dichiarare;
 *     questa vieta. Serve quando la ragione del divieto non è tecnica ma di titolarità — quali
 *     dati di un minore escono dal dispositivo e verso chi — perché altrimenti riaprire la
 *     porta costerebbe una riga in una mappa di test. Vedi `HOST_VIETATI`.
 *  2. **Dove si parla con un terzo non c'è `fetch` grezzo.** È la regola che era violata.
 *  3. **Controllo positivo: le chiamate esistono davvero.** Un lock che verifica solo assenze
 *     resta verde anche quando il codice sparisce, ed è il modo in cui un lock muore.
 *  4. **`aruba` per nome.** Regressione mirata sul difetto misurato: la riga che ha smesso di
 *     dire soltanto «401».
 *
 * FUORI PERIMETRO, deliberatamente: `src/lib/logging/**`. È il modulo che IMPLEMENTA
 * `externalFetch` — il suo `globalThis.fetch` è la chiamata vera, e la sua `http://l`
 * (`with-route.ts`) è una base fittizia per parsare gli URL, non un host. Stessa esenzione, e
 * per la stessa ragione, di `no-console` e del lock sui catch muti.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');

/** Il modulo del logging: esente (vedi sopra). */
const ESENTE = 'src/lib/logging/';

interface Provider {
    /** I frammenti di host che lo identificano nel sorgente. */
    host: string[];
    /** I file che gli PARLANO davvero (fanno la chiamata HTTP). */
    chiamanti: string[];
    /**
     * Il nome breve passato come primo argomento di `externalFetch`: finisce sulla riga come
     * `provider=…` ed è in lista bianca di `redact`, quindi si legge in chiaro anche in
     * `app_log`. `null` quando il provider è dichiarato ma nessuno lo chiama ancora.
     */
    nome: string | null;
    /**
     * La deroga, se questo provider NON passa da `externalFetch`, col perché. Vuota = deve
     * passarci. Una deroga non è un condono: è una decisione scritta, che il lock rilegge.
     */
    deroga?: string;
}

/**
 * L'ELENCO DELLA REGOLA 3, eseguibile. Un provider nuovo si aggiunge QUI, deliberatamente —
 * non lo si chiama e basta, che è come Aruba è rimasto fuori per due mesi.
 */
const PROVIDER_ESTERNI = new Map<string, Provider>([
    ['resend (email)', {
        host: ['api.resend.com'],
        chiamanti: ['src/lib/email/send.ts'],
        nome: 'resend',
    }],
    ['fcm (push native)', {
        host: ['fcm.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com'],
        chiamanti: ['src/lib/push/native-push.ts'],
        nome: 'fcm',
    }],
    ['web-push (browser)', {
        // Nessun host letterale: l'endpoint arriva dalla subscription del browser (Mozilla,
        // Google, Apple). È qui lo stesso, perché il provider è terzo e la regola vale uguale.
        host: [],
        chiamanti: ['src/lib/push/web-push.ts'],
        nome: 'web-push',
    }],
    ['aruba/SDI (fatturazione elettronica)', {
        host: ['fatturazioneelettronica.aruba.it'],
        chiamanti: ['src/lib/aruba/client.ts'],
        nome: 'aruba',
    }],
    ['instagram (health-check degli embed)', {
        // L'URL lo COSTRUISCE `lib/news/instagram.ts`, la chiamata la fanno le due route: il
        // file che nomina l'host e quello che parla col provider qui non coincidono.
        host: ['www.instagram.com'],
        chiamanti: [
            'src/app/api/news/instagram/valida/route.ts',
            'src/app/api/news/cron/run/route.ts',
        ],
        nome: 'instagram',
    }],
    ['sidi (Ministero dell\'Istruzione)', {
        host: ['sidi.pubblica.istruzione.it', 'demo-sidi.pubblica.istruzione.it'],
        chiamanti: [],
        nome: null,
        deroga:
            'src/lib/sidi/client.ts dichiara i due host ma NON fa ancora nessuna chiamata HTTP: '
            + 'l\'integrazione è ferma all\'accreditamento. Quando la prima chiamata arriverà, '
            + 'questa deroga va tolta e il file messo fra i chiamanti — AGENTS.md regola 3 nomina '
            + 'SIDI accanto ad Aruba, ed è lo stesso identico rischio.',
    }],
]);

/**
 * HOST MESSI AL BANDO — non «dichiarati altrove»: VIETATI. Il divieto è più forte della
 * regola 1, e la differenza conta.
 *
 * ─── IL FATTO, 2026-08-11 ────────────────────────────────────────────────────────
 * Fino a oggi qui c'era un settimo provider: `api.codicefiscale.it`, chiamato da
 * `src/lib/utils/fiscalCodeApi.ts`, con una deroga lunga che spiegava come mai non passasse
 * da `externalFetch`. La deroga era onesta e il logging era stato sistemato. Ma ciò che
 * quella `fetch` spediva erano NOME, COGNOME, SESSO, DATA DI NASCITA, COMUNE e PROVINCIA
 * DI NASCITA di un bambino, dal browser del genitore o della segreteria a un terzo che non
 * compare in nessuna informativa e che nessun consenso copre. La testata di quel file lo
 * diceva per esteso e concludeva che toglierlo era «una decisione di titolarità, non di
 * codice». Il titolare l'ha presa l'11 agosto 2026: si toglie. Il file è stato cancellato,
 * e con esso il ripiego da 425 KB di `codice-fiscale-js` in un chunk del browser.
 *
 * ─── PERCHÉ UN ELENCO A PARTE, E NON SEMPLICEMENTE «NIENTE» ──────────────────────
 * Perché togliere la voce dai provider lascia il divieto affidato alla regola 1, che è una
 * regola sulla DICHIARAZIONE: chiunque rimetta quell'host in `src/` può renderla verde
 * riaggiungendolo qui fra i provider o là fra gli host non chiamati. Sarebbe di nuovo una
 * decisione di titolarità presa modificando un test. Un host in questo elenco invece non
 * può comparire in `src/` in nessun modo, e non può nemmeno essere «riabilitato» altrove:
 * le due asserzioni qui sotto guardano entrambe le porte.
 *
 * Il calcolo del CF non ne ha più bisogno: `src/lib/fiscale/calcolo.ts` dà lo stesso
 * risultato senza rete e all'istante, perché il codice catastale arriva certo dalla tendina.
 */
const HOST_VIETATI = new Map<string, string>([
    ['api.codicefiscale.it',
        'Riceveva nome, cognome, sesso, data e comune di nascita di un MINORE da un servizio '
        + 'terzo non coperto da informativa né da consenso. Rimosso l\'11 agosto 2026 per '
        + 'decisione del titolare del trattamento, insieme a `src/lib/utils/fiscalCodeApi.ts`. '
        + 'Il codice fiscale si calcola in locale con `src/lib/fiscale/calcolo.ts`: stesso '
        + 'risultato, nessun dato che esce dal dispositivo. Non si rimette, e non si rimette '
        + 'nemmeno spostandolo fra i provider o fra gli host non chiamati.'],
]);

/**
 * Host che compaiono come letterali ma che NESSUNO chiama: iframe, namespace XML, link in una
 * pagina legale, il nostro stesso progetto Supabase. Stanno qui per rendere ESAUSTIVO
 * l'inventario — senza, la regola 1 non potrebbe esistere e un provider nuovo passerebbe.
 */
const HOST_NON_CHIAMATI = new Map<string, string>([
    ['uimulkjyekgemjakmepp.supabase.co', 'il NOSTRO progetto Supabase: le sue chiamate passano da `supabase-fetch.ts`, che le strumenta già tutte.'],
    ['www.w3.org', 'namespace XSD del tracciato FatturaPA (`fatturapa-xml.ts`): è una stringa dentro un XML, non un indirizzo che si contatta.'],
    ['www.youtube-nocookie.com', 'sorgente di un `<iframe>` (`VideoEmbed.tsx`): lo carica il browser del genitore, il nostro server non ci parla.'],
    ['player.vimeo.com', 'idem, l\'altro player video di `VideoEmbed.tsx`.'],
    ['app.kidville.it', 'il NOSTRO dominio, e nemmeno come indirizzo da contattare: in `layout.tsx` è il ripiego di `metadataBase`, cioè il prefisso con cui Next scrive gli URL assoluti di `og:image` dentro l\'HTML. Nessuna richiesta parte da qui.'],
]);

/**
 * File con un `fetch` grezzo ammesso verso un terzo, e perché.
 *
 * ⚠️ OGGI È VUOTA, ed è la forma giusta in cui deve restare. L'unica voce che c'era —
 * `src/lib/utils/fiscalCodeApi.ts`, «client-side, `externalFetch` nel browser non esiste» —
 * è caduta l'11 agosto 2026 insieme al file: vedi `HOST_VIETATI` qui sopra. La mappa resta
 * dichiarata perché il caso è reale (una chiamata a un terzo dal browser non può passare da
 * `externalFetch`, che scrive su `app_log` col client di servizio), ma riempirla è una
 * decisione da scrivere, non un'abitudine da ereditare.
 */
const FETCH_GREZZO_AMMESSO = new Map<string, string>([]);

/* ────────────────────────────────────────────────────────────────────────────────
 * LA MISURA. Testuale, come negli altri lock di questa cartella e per la stessa ragione: far
 * girare un parser vero su 900 file costa più del gate intero.
 * ──────────────────────────────────────────────────────────────────────────────── */

/** Sostituisce i commenti con spazi lasciando INTATTE le stringhe e i ritorni a capo. */
function mascheraCommenti(sorgente: string): string {
    let out = '';
    let i = 0;
    let stato: 'code' | 'riga' | 'blocco' | 'str' = 'code';
    let apice = '';
    while (i < sorgente.length) {
        const c = sorgente[i];
        const d = sorgente[i + 1];
        if (stato === 'code') {
            if (c === '/' && d === '/') { stato = 'riga'; out += '  '; i += 2; continue; }
            if (c === '/' && d === '*') { stato = 'blocco'; out += '  '; i += 2; continue; }
            if (c === '"' || c === "'" || c === '`') { stato = 'str'; apice = c; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (stato === 'riga') {
            if (c === '\n') { stato = 'code'; out += '\n'; } else out += ' ';
            i++; continue;
        }
        if (stato === 'blocco') {
            if (c === '*' && d === '/') { stato = 'code'; out += '  '; i += 2; continue; }
            out += c === '\n' ? '\n' : ' '; i++; continue;
        }
        // stato === 'str'
        if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
        if (c === apice) stato = 'code';
        out += c; i++;
    }
    return out;
}

/** L'AUTORITÀ di un URL letterale. I commenti sono già spariti: qui restano solo le stringhe. */
const HOST = /https?:\/\/([a-zA-Z0-9._%-]+)/g;

/**
 * Un `fetch(` NUDO. Il carattere prima esclude `externalFetch(` (lettera), `globalThis.fetch(`
 * e `res.fetch(` (punto): resta solo la chiamata diretta alla funzione globale, che è
 * esattamente ciò che non deve stare su un percorso verso un terzo.
 */
const FETCH_GREZZO = /(^|[^\w.$])fetch\s*\(/g;

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

const FILES = sorgenti().filter((f) => !f.startsWith(ESENTE));

/** Il sorgente di ogni file, una volta sola: il lock gira su ~900 file. */
const CODICE = new Map<string, string>(
    FILES.map((f) => [f, mascheraCommenti(fs.readFileSync(path.join(RADICE, f), 'utf8'))]),
);

/** host → file che lo nominano. */
const HOST_TROVATI = new Map<string, string[]>();
for (const [f, src] of CODICE) {
    for (const m of src.matchAll(HOST)) {
        const h = m[1];
        if (!HOST_TROVATI.has(h)) HOST_TROVATI.set(h, []);
        if (!HOST_TROVATI.get(h)!.includes(f)) HOST_TROVATI.get(h)!.push(f);
    }
}

/** Tutti i frammenti di host dichiarati come provider. */
const HOST_DEI_PROVIDER = [...PROVIDER_ESTERNI.values()].flatMap((p) => p.host);

function eDiUnProvider(host: string): boolean {
    return HOST_DEI_PROVIDER.some((frammento) => host === frammento || host.endsWith(`.${frammento}`) || host.includes(frammento));
}

function fetchGrezzi(file: string): number {
    return [...(CODICE.get(file) ?? '').matchAll(FETCH_GREZZO)].length;
}

/** I file che parlano con un terzo: chi ne nomina l'host, più i chiamanti dichiarati. */
const FILE_VERSO_TERZI = new Set<string>();
for (const [h, files] of HOST_TROVATI) if (eDiUnProvider(h)) for (const f of files) FILE_VERSO_TERZI.add(f);
for (const p of PROVIDER_ESTERNI.values()) for (const f of p.chiamanti) FILE_VERSO_TERZI.add(f);

describe('lock — le chiamate ai provider esterni passano da externalFetch', () => {
    it('la misura vede davvero il codice (autoinganno: se lo scanner non trova niente, il lock cade)', () => {
        // Senza, un errore nel path o nella regex renderebbe VERDI tutte le regole qui sotto:
        // «zero host trovati» e «zero violazioni» hanno lo stesso colore.
        expect(FILES.length).toBeGreaterThan(500);
        expect(HOST_TROVATI.size).toBeGreaterThan(8);
        expect(FILE_VERSO_TERZI.size).toBeGreaterThanOrEqual(PROVIDER_ESTERNI.size);
    });

    it('1. l\'inventario è ESAUSTIVO: ogni host di terze parti è dichiarato', () => {
        const sconosciuti = [...HOST_TROVATI.entries()]
            .filter(([h]) => !eDiUnProvider(h) && !HOST_NON_CHIAMATI.has(h))
            .map(([h, files]) => `${h} → ${files.join(', ')}`)
            .sort();

        expect(
            sconosciuti,
            'Host di terze parti che compare in `src/` senza essere dichiarato. Se lo si CHIAMA, va '
            + 'fra i PROVIDER_ESTERNI qui sopra e la chiamata deve passare da `externalFetch` '
            + '(AGENTS.md, regola 3: il corpo dell\'errore non si butta via). Se invece non lo si '
            + 'chiama — un iframe, un namespace, un link — va in HOST_NON_CHIAMATI CON IL PERCHÉ. '
            + 'Un provider che entra in silenzio è come ci è entrato Aruba: due mesi con «401» al '
            + 'posto del motivo, e nessun test rosso.',
        ).toEqual([]);
    });

    it('1-bis. gli host MESSI AL BANDO non ricompaiono in `src/`, e non si riabilitano altrove', () => {
        // La regola 1 pretende che un host sia DICHIARATO; questa pretende che certi host non
        // esistano affatto. Senza, rimettere `api.codicefiscale.it` — cioè rimettere i dati di un
        // bambino su una `fetch` verso un terzo — costerebbe una riga in una delle due mappe qui
        // sopra, e il gate resterebbe verde. È una decisione di titolarità: non si prende
        // modificando un test, e questo test esiste perché non si possa.
        const risorti = [...HOST_VIETATI.keys()]
            .filter((h) => HOST_TROVATI.has(h))
            .map((h) => `${h} → ${HOST_TROVATI.get(h)!.join(', ')}`)
            .sort();
        expect(
            risorti,
            'Un host messo al bando è tornato in `src/`. Il motivo del bando è scritto in '
            + 'HOST_VIETATI, e non è tecnico: riguarda quali dati di un minore escono dal '
            + 'dispositivo, e verso chi. Va riaperto dal titolare del trattamento, non qui.',
        ).toEqual([]);

        // E la seconda porta: nessuno lo «riabilita» dichiarandolo provider o host non chiamato.
        for (const host of HOST_VIETATI.keys()) {
            // `eDiUnProvider` e non `HOST_DEI_PROVIDER.includes`: la dichiarazione avviene per
            // FRAMMENTI, e `codicefiscale.it` riaprirebbe la porta senza nominare l'host intero.
            expect(eDiUnProvider(host), `${host} è tornato fra i PROVIDER_ESTERNI`).toBe(false);
            expect(HOST_NON_CHIAMATI.has(host), `${host} è tornato fra gli HOST_NON_CHIAMATI`).toBe(false);
            expect(HOST_VIETATI.get(host)!.length, `il bando di ${host} non è motivato`).toBeGreaterThan(80);
        }

        // ─── LA TERZA PORTA: IL NOME NUDO ───────────────────────────────────────────
        //
        // `HOST_TROVATI` nasce da uno scanner che cerca URL INTERI (`https?://…`). Basta
        // non scriverne uno per passargli davanti:
        //
        //     const H = 'api.codicefiscale.it'
        //     await fetch(`https://${H}/api/v1/calcola`, …)
        //
        // Misurato l'11 agosto 2026, con un file di sonda in `src/lib/`: i test di questo
        // file restavano TUTTI VERDI. Il commento di `HOST_VIETATI` prometteva che l'host
        // «non si rimette in nessun modo», e la misura ne copriva uno solo — cioè
        // esattamente il difetto che questo repo si è impegnato a non commettere: una
        // protezione descritta più forte di com'è.
        //
        // Per gli host BANDITI (non per tutti gli altri: qui la severità in più è
        // giustificata dalla posta in gioco) si cerca anche il nome nudo, in qualunque
        // stringa. I commenti sono già mascherati da `mascheraCommenti`, quindi
        // raccontare la storia di questo bando in un commento resta permesso — ed è
        // giusto che lo sia: la memoria di perché una porta è chiusa vale quanto la porta.
        for (const host of HOST_VIETATI.keys()) {
            const nudo = [...CODICE.entries()]
                .filter(([, src]) => src.includes(host))
                .map(([f]) => f)
                .sort();
            expect(
                nudo,
                `Il nome di ${host} compare in \`src/\` fuori da un URL: una stringa spezzata, `
                + 'una costante, una concatenazione. Il bando non si aggira scrivendo l\'host '
                + 'in un altro modo — il motivo è in HOST_VIETATI, e riguarda quali dati di un '
                + 'minore escono dal dispositivo.',
            ).toEqual([]);
        }

        // Autoinganno: se `eDiUnProvider` o lo scanner smettessero di funzionare, l'elenco
        // resterebbe vuoto per il motivo sbagliato. Un host che c'è DAVVERO deve essere visto.
        expect(HOST_TROVATI.has('api.resend.com'), 'lo scanner non vede più un host che esiste').toBe(true);
        // E lo stesso per la ricerca del nome nudo, che ha uno scanner suo: se `CODICE` si
        // svuotasse, il ciclo qui sopra passerebbe per il motivo sbagliato.
        expect(
            [...CODICE.values()].some((src) => src.includes('api.resend.com')),
            'la ricerca del nome nudo non vede più un host che esiste',
        ).toBe(true);
    });

    it('2. dove si parla con un terzo NON c\'è un `fetch` grezzo', () => {
        const nudi = [...FILE_VERSO_TERZI]
            .filter((f) => !FETCH_GREZZO_AMMESSO.has(f))
            .map((f) => ({ f, n: fetchGrezzi(f) }))
            .filter((x) => x.n > 0)
            .map((x) => `${x.f} (${x.n} chiamate)`)
            .sort();

        expect(
            nudi,
            'Chiamata a un provider esterno fatta con `fetch` diretto: su `!res.ok` il corpo della '
            + 'risposta si perde e nel log resta il solo status. È il guasto storico di questo '
            + 'repo, ed è costato mesi di email di credenziali mai arrivate. Si usa '
            + '`externalFetch(<provider>, url, init, { evento, campi })` da `@/lib/logging/external`.',
        ).toEqual([]);
    });

    it('3. controllo positivo: ogni provider dichiarato è chiamato DAVVERO, e da `externalFetch`', () => {
        const rotti: string[] = [];
        for (const [etichetta, p] of PROVIDER_ESTERNI) {
            if (p.deroga) continue;
            expect(p.chiamanti.length, `${etichetta}: nessun chiamante dichiarato e nessuna deroga`).toBeGreaterThan(0);
            for (const f of p.chiamanti) {
                if (!CODICE.has(f)) { rotti.push(`${etichetta}: ${f} non esiste più`); continue; }
                const src = CODICE.get(f) as string;
                if (!src.includes('externalFetch(')) rotti.push(`${etichetta}: ${f} non chiama più externalFetch`);
                if (p.nome && !src.includes(`'${p.nome}'`)) rotti.push(`${etichetta}: ${f} non nomina più il provider '${p.nome}'`);
            }
        }
        expect(
            rotti,
            'Un lock che verifica solo ASSENZE resta verde anche quando il codice sparisce — ed è '
            + 'così che un lock muore. Qui si pretende il contrario: che la chiamata osservata ci sia.',
        ).toEqual([]);
    });

    it('4. REGRESSIONE MIRATA: Aruba/SDI passa da `externalFetch` e non lancia più il solo status', () => {
        // Il difetto misurato il 2026-08-02. AGENTS.md regola 3 nomina «Aruba/SDI» per nome;
        // il client ne era fuori da giugno, con sei `fetch` a mano.
        const client = CODICE.get('src/lib/aruba/client.ts');
        expect(client, 'src/lib/aruba/client.ts è sparito: aggiornare il lock').toBeDefined();
        expect(fetchGrezzi('src/lib/aruba/client.ts'), 'è tornato un `fetch` a mano nel client Aruba').toBe(0);
        expect((client as string).includes('externalFetch(')).toBe(true);
        expect((client as string).includes("'aruba'")).toBe(true);

        // E l'errore che sale al chiamante porta il CORPO, non lo status nudo. La forma vietata
        // è quella letterale che c'era: `(HTTP ${res.status})` costruito su una Response.
        expect(
            /HTTP \$\{res\.status\}/.test(client as string),
            'è tornato il messaggio col solo status: «Aruba … fallita (HTTP 401)» non dice se è una '
            + 'password ruotata o un 5xx del provider.',
        ).toBe(false);
    });

    it('ogni deroga è motivata, viva e non contraddittoria', () => {
        for (const [etichetta, p] of PROVIDER_ESTERNI) {
            if (!p.deroga) continue;
            expect(p.deroga.length, `la deroga di ${etichetta} non è motivata`).toBeGreaterThan(80);
            // Una deroga è per chi NON passa da externalFetch: se ha anche un nome di provider
            // osservato, le due cose dicono l'opposto sullo stesso provider.
            expect(p.nome, `${etichetta}: ha una deroga E un nome osservato`).toBeNull();
        }
        for (const [file, perche] of FETCH_GREZZO_AMMESSO) {
            expect(CODICE.has(file), `deroga su un file che non esiste più: ${file}`).toBe(true);
            expect(perche.length, `la deroga di ${file} non è motivata`).toBeGreaterThan(40);
            expect(fetchGrezzi(file), `${file} non ha più `.concat('`fetch` grezzi: togliere la deroga')).toBeGreaterThan(0);
        }
        for (const [host, perche] of HOST_NON_CHIAMATI) {
            expect(HOST_TROVATI.has(host), `host dichiarato «non chiamato» ma non più presente: ${host}`).toBe(true);
            expect(perche.length, `${host} non è motivato`).toBeGreaterThan(40);
        }
    });
});
