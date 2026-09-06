import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * LOCK — un guscio a FONDO CHIARO dichiara la propria superficie
 * (`kv-public` oppure `data-kv-shell`), o sta in allowlist con la ragione scritta.
 *
 * ─── IL DIFETTO CHE QUESTO LOCK IMPEDISCE ──────────────────────────────────
 *
 * In Alto Contrasto l'inchiostro del `body` è #FFFFFF (`globals.css`,
 * `[data-contrast="high"] body`) e `color` SI EREDITA. Ma la carta non si
 * ribalta insieme all'inchiostro: i fondi chiari sono utility Tailwind e
 * `@theme inline` ne INLINA l'hex dentro la classe generata
 * (`.bg-kidville-cream{background-color:#fef1e4}`, nessun `var()`), quindi il
 * rimappaggio dei token dentro `[data-contrast="high"]` non le tocca.
 *
 * Risultato: ogni testo che non dichiari un `text-*` proprio, dentro un guscio a
 * fondo chiaro, vale 1,11:1 sul crema e 1,00:1 sul bianco. E non serve
 * dimenticarsi una classe: il preflight di Tailwind mette `color: inherit` su
 * `input`, `select` e `textarea` — ogni controllo di modulo che non dichiari un
 * inchiostro è esposto per costruzione.
 *
 * La correzione del 2026-09-06 è una riga sola in `globals.css`:
 *
 *     [data-contrast="high"] [data-kv-shell],
 *     [data-contrast="high"] .kv-public { color: #000000 }
 *
 * cioè nero su crema 18,92:1 e nero su bianco 21,00:1. Ma quella riga raggiunge
 * SOLO le superfici che si dichiarano. Il giorno in cui è stata scritta,
 * `src/app/cancellazione-account/conferma/page.tsx` — la pagina di conferma della
 * cancellazione dell'account, un adempimento GDPR, pubblica, raggiunta da un
 * magic-link in un'email — era `<main className="min-h-screen bg-kidville-cream">`
 * e basta: nessuno dei due marcatori. La pagina SORELLA
 * (`/cancellazione-account`) il marcatore ce l'aveva. Nessun test era rosso,
 * perché nessun test guardava questa cosa.
 *
 * ⚠️ Su quella pagina, quel giorno, NON c'era testo a 1:1: ogni nodo di testo
 * dichiarava il proprio inchiostro, e in Alto Contrasto restava verde #006A5F
 * (5,86:1 sul crema, 6,51:1 sul bianco — sopra AA, ma è la luce NORMALE: chi
 * accende l'Alto Contrasto non otteneva niente). Il difetto era di due tipi
 * insieme, ed è per questo che un lock strutturale vale più di una misura di
 * contrasto:
 *   · il ribaltamento assente — misurabile, ma solo confrontando due pagine;
 *   · l'esposizione LATENTE — `<main>` e `<article>` dipingono carta chiara e
 *     non dichiarano inchiostro, quindi il PROSSIMO nodo di testo nudo, o il
 *     primo `<input>`, cade a 1,00:1. Una misura fatta oggi non lo vede. Questo
 *     lock sì, perché guarda la struttura e non il pixel.
 *
 * ─── PERCHÉ «FONDO CHIARO» SI MISURA, NON SI ELENCA ────────────────────────
 *
 * Il perimetro della regola non è una lista di classi scritta a mano: è il
 * risultato di un conto. Un fondo è CHIARO quando l'inchiostro ereditato in Alto
 * Contrasto (#FFFFFF) contro di esso sta SOTTO 4,5:1 — cioè quando ereditare è
 * il difetto. Gli hex si leggono da `@theme inline` in `globals.css`, mai
 * dall'asserzione (è la regola 1 di `contrasto-barra-forza-password.test.ts`:
 * «il fondo si LEGGE dal sorgente»).
 *
 * Il conto porta con sé la sua eccezione, e la porta GRATIS: `bg-kidville-green`
 * è #006A5F, il bianco ereditato ci vale 6,51:1, quindi NON è un guscio chiaro e
 * la regola non lo raggiunge. È il caso di `src/app/offline/page.tsx`, ed è bene
 * che sia così: darle `kv-public` porterebbe l'inchiostro a nero, cioè da 6,51:1
 * a 3,23:1. Uno scambio di difetto. Se il perimetro fosse stato un elenco
 * scritto a mano, prima o poi qualcuno ce l'avrebbe messa dentro «per coerenza».
 *
 * ─── IL BORDO DI QUESTA MISURA, DICHIARATO INVECE CHE TACIUTO ──────────────
 *
 *  1. L'ALFA NON SI RISOLVE. `bg-kidville-cream/40` si compone sul genitore, che
 *     staticamente non si conosce: qui vale il token BASE (crema). Sceglie di
 *     PRETENDERE il marcatore anche dove l'alfa potrebbe salvare — un lock che
 *     chiede troppo si corregge con una voce d'allowlist motivata, uno che chiede
 *     troppo poco non si accorge di niente.
 *  2. SI CONOSCONO I TOKEN KIDVILLE, PIÙ `bg-white` E `bg-black`. Un
 *     `bg-gray-50` scritto domani non sarebbe visto. Non è un buco tollerato per
 *     pigrizia: è che il repo non ne ha (misurato), e il lock `palette-di-serie`
 *     sorveglia proprio l'ingresso delle tinte di serie di Tailwind.
 *  3. LA TERNARIA SI LEGGE INTERA. `className={x ? 'min-h-screen' : 'bg-white'}`
 *     conta come un guscio chiaro anche se i due rami non convivono mai. Di nuovo:
 *     chiede troppo, non troppo poco. Oggi nel repo non ce n'è nessuno così.
 *
 * ─── COME SI CONSIDERA «COPERTA» UNA SUPERFICIE ────────────────────────────
 *
 * Tre modi, in ordine di preferenza:
 *   a. il marcatore sta sullo STESSO tag (`kv-public` nella `className`, oppure
 *      l'attributo `data-kv-shell`);
 *   b. lo dichiara un `layout.tsx` ANTENATO. Non è un'inferenza: in App Router
 *      l'annidamento dei layout è strutturale, dato dalle cartelle — i gruppi fra
 *      parentesi compresi. È così che `(dashboard)/admin/impostazioni/page.tsx`,
 *      che dipinge `min-h-screen bg-kidville-cream/40` senza marcatore, è coperta
 *      dal `data-kv-shell` di `(dashboard)/admin/layout.tsx`;
 *   c. per un guscio che vive in `src/components`, dove l'annidamento NON è
 *      strutturale: ogni file che lo importa dev'essere a sua volta una superficie
 *      coperta sotto `src/app`. Se un importatore non è sotto `src/app`, il lock
 *      lo dice invece di indovinare — «non so più dove si monta» è un'informazione,
 *      «passa» non lo è.
 *
 * ─── PERCHÉ C'È ANCHE IL CONTROLLO POSITIVO ────────────────────────────────
 *
 * Un lock verde perché non trova violazioni e un lock verde perché non guarda più
 * niente, da fuori, sono identici. Quindi: le pagine che il rilevatore DEVE vedere
 * sono nominate una per una; le regole CSS che rendono i due marcatori non
 * decorativi devono esistere davvero in `globals.css`; e il rilevatore viene messo
 * alla prova su un guscio scoperto ricostruito a mano.
 *
 * Gemelli: `__tests__/a11y/alto-contrasto-inchiostro-ereditato.test.tsx` (che misura
 * i contrasti veri, con la cascata risolta) e `__tests__/architecture/catch-muti-allowlist.test.ts`
 * (da cui questo file prende la forma dell'allowlist che può morire).
 */

const RADICE = process.cwd();
const APP = path.join(RADICE, 'src', 'app');
const COMPONENTI = path.join(RADICE, 'src', 'components');
const GLOBALS = path.join(RADICE, 'src', 'app', 'globals.css');

/* ── WCAG 2.x §1.4.3 ─────────────────────────────────────────────────────── */
const canale = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminanza = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * canale((n >> 16) & 255) + 0.7152 * canale((n >> 8) & 255) + 0.0722 * canale(n & 255);
};
const contrasto = (a: string, b: string) => {
    const [x, y] = [luminanza(a), luminanza(b)].sort((p, q) => q - p);
    return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
};

/** L'inchiostro che il `body` eredita in Alto Contrasto. È il difetto, in un hex. */
const INCHIOSTRO_EREDITATO = '#FFFFFF';
/** WCAG 1.4.3 AA, testo normale. Sotto questa soglia ereditare è un guasto. */
const SOGLIA = 4.5;

const css = fs.readFileSync(GLOBALS, 'utf8');

/**
 * `globals.css` senza commenti, ma con le righe al loro posto.
 *
 * ⚠️ NON è un dettaglio di comodo, ed è costato il primo giro rosso di questo file:
 * i commenti di `globals.css` CITANO il CSS di cui parlano — dentro il blocco
 * `[data-contrast="high"] body` c'è un commento che scrive `body { color: var(…) }`,
 * graffe comprese. Una misura fatta sul sorgente grezzo si ferma su quella graffa e
 * conclude che la dichiarazione non esiste. Qui i commenti diventano spazi (i ritorni
 * a capo restano), così una regola si legge solo dove è davvero una regola.
 */
const cssNudo = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * Le due regole che danno un senso ai marcatori. Sono funzioni e non due `test()`
 * scritti in linea perché così si possono mettere alla PROVA su un CSS che non le
 * ha: un controllo positivo che nessuno ha mai visto fallire non è un controllo.
 */
const ribaltaLaShell = (testo: string) => /\[data-contrast="high"\]\s*\[data-kv-shell\]/.test(testo);
const ribaltaLePubbliche = (testo: string) => /\[data-contrast="high"\]\s*\.kv-public/.test(testo);

/** Il contenuto del PRIMO blocco `@theme inline { … }`, a graffe bilanciate. */
function blocoTema(): string {
    const i = cssNudo.indexOf('@theme inline');
    if (i < 0) throw new Error('`@theme inline` non esiste più in globals.css: i token non si leggono più dal sorgente');
    let j = cssNudo.indexOf('{', i) + 1;
    let depth = 1;
    const inizio = j;
    while (j < cssNudo.length && depth > 0) {
        if (cssNudo[j] === '{') depth++;
        else if (cssNudo[j] === '}') depth--;
        j++;
    }
    return cssNudo.slice(inizio, j - 1);
}

/**
 * I fondi CHIARI, misurati: nome della utility → hex, per i soli riempimenti su
 * cui l'inchiostro ereditato sta sotto AA. `white`/`black` non sono token del
 * tema: sono le due utility di serie che il repo usa davvero sulle carte.
 */
function fondiChiari(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [, nome, hex] of blocoTema().matchAll(/--color-kidville-([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
        if (contrasto(INCHIOSTRO_EREDITATO, hex.toUpperCase()) < SOGLIA) out.set(`kidville-${nome}`, hex.toUpperCase());
    }
    out.set('white', '#FFFFFF');
    return out;
}

const FONDI_CHIARI = fondiChiari();

/** `min-h-screen`, `min-h-dvh`, `h-screen`, `min-h-[100dvh]`, … con o senza prefisso. */
const ALTEZZA_PIENA =
    /(?:^|[\s'"`{(,])(?:[a-z0-9]+:)*(?:min-)?h-(?:screen|dvh|svh|lvh|\[100dvh\]|\[100vh\]|\[100svh\])(?![\w-])/;

/** Il fondo chiaro nella stringa di classi, alfa compresa (`/40`) e prefissi compresi. */
function fondoChiaroIn(valore: string): { classe: string; hex: string } | null {
    for (const [nome, hex] of FONDI_CHIARI) {
        const re = new RegExp(
            `(?:^|[\\s'"\`{(,])(?:[a-z0-9]+:)*bg-${nome.replace(/[-]/g, '\\-')}(?:\\/\\d+)?(?![\\w-])`,
        );
        if (re.test(valore)) return { classe: `bg-${nome}`, hex };
    }
    return null;
}

/* ── Lettura del JSX ─────────────────────────────────────────────────────── */

/** Ogni valore di `className`, con la riga e la posizione nel sorgente. */
function classNames(src: string): { riga: number; indice: number; valore: string }[] {
    const out: { riga: number; indice: number; valore: string }[] = [];
    const re = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        const riga = src.slice(0, m.index).split('\n').length;
        if (m[1] !== undefined || m[2] !== undefined) {
            out.push({ riga, indice: m.index, valore: (m[1] ?? m[2]) as string });
            continue;
        }
        let i = re.lastIndex;
        let depth = 1;
        while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
        }
        out.push({ riga, indice: m.index, valore: src.slice(re.lastIndex, i - 1) });
        re.lastIndex = i;
    }
    return out;
}

/** Il tag di apertura che contiene quella `className` — serve a vedere `data-kv-shell`. */
function tagAttorno(src: string, indice: number): string {
    let apre = -1;
    for (let i = indice; i >= 0; i--) {
        if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) {
            apre = i;
            break;
        }
    }
    if (apre < 0) return '';
    let i = apre;
    let depth = 0;
    let apice = '';
    while (i < src.length) {
        const c = src[i];
        if (apice) {
            if (c === '\\') i++;
            else if (c === apice) apice = '';
        } else if (c === '"' || c === "'" || c === '`') apice = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) return src.slice(apre, i + 1);
        i++;
    }
    return src.slice(apre);
}

const MARCATORE_CLASSE = /(?:^|[\s'"`{(,])kv-public(?![\w-])/;
const MARCATORE_ATTRIBUTO = /\bdata-kv-shell\b/;

/* ── Il perimetro: i file di rotta di App Router, più i componenti ───────── */

const NOMI_DI_ROTTA = /^(page|layout|template|default|not-found|error|global-error)\.tsx$/;

function alberoTsx(dir: string, filtro: (nome: string) => boolean): string[] {
    const out: string[] = [];
    for (const v of fs.readdirSync(dir, { withFileTypes: true })) {
        const assoluto = path.join(dir, v.name);
        if (v.isDirectory()) {
            out.push(...alberoTsx(assoluto, filtro));
            continue;
        }
        if (!filtro(v.name)) continue;
        out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'));
    }
    return out;
}

const FILE_DI_ROTTA = alberoTsx(APP, (n) => NOMI_DI_ROTTA.test(n)).sort();
const FILE_COMPONENTI = alberoTsx(COMPONENTI, (n) => /\.tsx$/.test(n)).sort();

/**
 * Un `layout.tsx` antenato dichiara un marcatore? In App Router l'annidamento è
 * strutturale: si risale di cartella in cartella fino a `src/app`, gruppi fra
 * parentesi compresi. Per un `layout.tsx` si parte dalla cartella SOPRA la
 * propria, perché il suo guscio deve dichiararsi da sé.
 */
function copertoDaUnAntenato(rel: string): string | null {
    const proprio = path.basename(rel);
    let dir = path.dirname(path.join(RADICE, rel));
    if (proprio === 'layout.tsx') dir = path.dirname(dir);
    while (dir.startsWith(APP)) {
        const l = path.join(dir, 'layout.tsx');
        if (fs.existsSync(l)) {
            const s = fs.readFileSync(l, 'utf8');
            if (MARCATORE_ATTRIBUTO.test(s) || /\bkv-public\b/.test(s)) {
                return path.relative(RADICE, l).split(path.sep).join('/');
            }
        }
        if (dir === APP) break;
        dir = path.dirname(dir);
    }
    return null;
}

type Guscio = { file: string; riga: number; classe: string; hex: string; marcato: boolean };

/** I gusci a fondo chiaro di un file, e se il tag si dichiara da sé. */
function gusciChiari(rel: string): Guscio[] {
    const src = fs.readFileSync(path.join(RADICE, rel), 'utf8');
    const out: Guscio[] = [];
    for (const { riga, indice, valore } of classNames(src)) {
        if (!ALTEZZA_PIENA.test(valore)) continue;
        const fondo = fondoChiaroIn(valore);
        if (!fondo) continue;
        const marcato = MARCATORE_CLASSE.test(valore) || MARCATORE_ATTRIBUTO.test(tagAttorno(src, indice));
        out.push({ file: rel, riga, classe: fondo.classe, hex: fondo.hex, marcato });
    }
    return out;
}

/** Un file sotto `src/app` è una superficie coperta? (marcatore proprio o antenato) */
function superficieCoperta(rel: string): boolean {
    if (!rel.startsWith('src/app/')) return false;
    const src = fs.readFileSync(path.join(RADICE, rel), 'utf8');
    if (MARCATORE_ATTRIBUTO.test(src) || /\bkv-public\b/.test(src)) return true;
    return copertoDaUnAntenato(rel) !== null;
}

/* ── L'ALLOWLIST, con la ragione accanto ─────────────────────────────────── */

/**
 * Una voce qui dentro dice: «questa superficie dipinge carta chiara, NON dichiara
 * il marcatore, e va bene così — ecco perché». Deve poter MORIRE: se il file
 * sparisce, o se la condizione non vale più (qualcuno ha aggiunto il marcatore, o
 * cambiato il fondo, o tolto il guscio), il test lo dice e pretende che la voce
 * venga tolta. Un'allowlist che tollera voci morte è decorazione — e fa sembrare
 * il debito più grande di quello che è.
 */
const ALLOWLIST: { path: string; motivo: string }[] = [
    {
        path: 'src/app/auth/nuova-password/page.tsx',
        motivo:
            "L'interstiziale del primo accesso resta CHIARO in Alto Contrasto, ed è una misura, non " +
            'una dimenticanza: la decisione è scritta nella testata del file e i suoi inchiostri sono ' +
            'lockati a ≥5:1 in ENTRAMBE le modalità da `__tests__/a11y/contrasto-barra-forza-password.test.ts`. ' +
            'Darle `kv-public` significherebbe ribaltare a mano una seconda palette d\'Alto Contrasto per ' +
            'una schermata sola — la strada che porta a due linguaggi che divergono. Ogni nodo di testo ' +
            'della pagina e della `CambiaPasswordCard` dichiara il proprio inchiostro: qui non si eredita ' +
            'niente. ⚠️ Il giorno in cui questa pagina ospiterà un `<input>`, un `<select>` o una ' +
            "`<textarea>` senza `text-*` proprio, la deroga va rivista: il preflight di Tailwind mette " +
            '`color: inherit` sui controlli, ed è la porta da cui il difetto rientra.',
    },
];

/* ── I controlli positivi: chi il rilevatore DEVE vedere ─────────────────── */

/** Le cinque superfici pubbliche che il marcatore `kv-public` serve oggi. */
const PUBBLICHE_ATTESE = [
    'src/app/privacy/page.tsx',
    'src/app/termini/page.tsx',
    'src/app/assistenza/page.tsx',
    'src/app/cancellazione-account/page.tsx',
    'src/app/m/[token]/page.tsx',
];

/** Le tre shell dell'app: il loro guscio porta `data-kv-shell` sullo stesso tag. */
const SHELL_ATTESE = [
    'src/app/(dashboard)/parent/layout.tsx',
    'src/app/(dashboard)/teacher/layout.tsx',
    'src/app/(dashboard)/admin/layout.tsx',
];

const AIUTO = [
    '',
    'Un guscio a fondo chiaro deve dichiarare la propria superficie, altrimenti in Alto',
    "Contrasto l'inchiostro bianco del `body` ci si eredita sopra:",
    '',
    '    · pagina PUBBLICA (fuori dalle aree)  →  aggiungi `kv-public` alla className,',
    '      come fanno privacy, termini, assistenza, cancellazione-account e m/[token];',
    "    · guscio di un'AREA dell'app           →  l'attributo `data-kv-shell`, come i tre",
    '      layout di parent, teacher e admin.',
    '',
    'Se la superficie sta DENTRO una di quelle (una pagina sotto `(dashboard)/…`), non',
    'serve niente: la copertura la dà il layout antenato, e questo lock lo sa.',
    '',
    'Se invece è un caso in cui il ribaltamento NON si deve applicare, la voce va in',
    "ALLOWLIST qui sopra CON LA RAGIONE — e la ragione dev'essere una misura, non un",
    'gusto: quale coppia di colori regge, e dove è lockata.',
].join('\n');

/* ═══════════════════════════════════════════════════════════════════════════ */

describe('lock — un guscio a fondo chiaro dichiara la propria superficie', () => {
    it('il perimetro non è vuoto, e i fondi chiari si leggono da `@theme inline`', () => {
        // «Zero violazioni» e «zero file» sono la stessa asserzione, vista da fuori.
        expect(FILE_DI_ROTTA.length, 'nessun file di rotta trovato sotto src/app').toBeGreaterThan(50);
        expect(FILE_COMPONENTI.length, 'nessun componente trovato sotto src/components').toBeGreaterThan(50);

        // I due fondi che l'app usa davvero sulle carte, misurati e non scritti a mano.
        expect(FONDI_CHIARI.get('kidville-cream'), 'il token `cream` non è più leggibile da @theme inline').toBe(
            '#FEF1E4',
        );
        expect(FONDI_CHIARI.get('kidville-white')).toBe('#FFFFFF');
        expect(FONDI_CHIARI.has('white')).toBe(true);

        // …e la contro-misura che tiene fuori i fondi SCURI: il verde di brand non è
        // un guscio chiaro, e non deve diventarlo per coerenza estetica.
        expect(
            FONDI_CHIARI.has('kidville-green'),
            'bg-kidville-green è entrato fra i fondi chiari: il bianco ereditato ci vale 6,51:1, ' +
                'e dargli `kv-public` lo porterebbe a 3,23:1 (nero su verde). È /offline.',
        ).toBe(false);
        expect(contrasto(INCHIOSTRO_EREDITATO, '#006A5F')).toBeGreaterThanOrEqual(SOGLIA);
    });

    it('le regole CSS che rendono i due marcatori non decorativi esistono davvero', () => {
        // Senza questa riga il lock pretenderebbe una classe che non fa niente: la
        // forma peggiore di verde, perché costa disciplina e non compra contrasto.
        expect(
            ribaltaLaShell(cssNudo),
            'in globals.css non c\'è più nessuna regola `[data-contrast="high"] [data-kv-shell]`: ' +
                'il marcatore delle tre shell non ribalta più niente. Vedi ' +
                '__tests__/a11y/alto-contrasto-inchiostro-ereditato.test.tsx.',
        ).toBe(true);
        expect(
            ribaltaLePubbliche(cssNudo),
            'in globals.css non c\'è più nessuna regola `[data-contrast="high"] .kv-public`: il ' +
                'marcatore delle superfici pubbliche non ribalta più niente.',
        ).toBe(true);
        // E l'inchiostro ereditato è ancora bianco: è il difetto che dà senso al lock.
        expect(
            /\[data-contrast="high"\]\s*body\s*\{[^}]*color:\s*#FFFFFF/i.test(cssNudo),
            'il `body` in Alto Contrasto non eredita più #FFFFFF: se l\u2019inchiostro ereditato è ' +
                'cambiato, la soglia di «fondo chiaro» qui sopra va rimisurata contro il colore nuovo.',
        ).toBe(true);
    });

    it('le superfici che il rilevatore deve vedere ci sono, e sono marcate', () => {
        for (const rel of PUBBLICHE_ATTESE) {
            const gusci = gusciChiari(rel);
            expect(gusci.length, `${rel}: il rilevatore non ci vede più nessun guscio a fondo chiaro`).toBeGreaterThan(
                0,
            );
            expect(
                gusci.every((g) => g.marcato),
                `${rel}: guscio pubblico senza \`kv-public\` sul proprio tag`,
            ).toBe(true);
        }
        for (const rel of SHELL_ATTESE) {
            const gusci = gusciChiari(rel);
            expect(gusci.length, `${rel}: il rilevatore non ci vede più nessun guscio a fondo chiaro`).toBe(1);
            expect(gusci[0].marcato, `${rel}: la shell non porta più \`data-kv-shell\` sul proprio guscio`).toBe(true);
        }
    });

    it('ogni guscio chiaro sotto `src/app` è coperto (dal proprio tag o da un layout antenato)', () => {
        const consentiti = new Set(ALLOWLIST.map((v) => v.path));
        const scoperti: string[] = [];
        for (const rel of FILE_DI_ROTTA) {
            if (consentiti.has(rel)) continue;
            for (const g of gusciChiari(rel)) {
                if (g.marcato) continue;
                if (copertoDaUnAntenato(rel)) continue;
                scoperti.push(`${g.file}:${g.riga} → ${g.classe} (${g.hex}), inchiostro ereditato 1,00-1,11:1`);
            }
        }
        expect(scoperti, AIUTO).toEqual([]);
    });

    it('ogni guscio chiaro in `src/components` si dichiara, o si monta solo su superfici coperte', () => {
        const irrisolti: string[] = [];
        for (const rel of FILE_COMPONENTI) {
            const gusci = gusciChiari(rel).filter((g) => !g.marcato);
            if (gusci.length === 0) continue;

            const nome = path.basename(rel).replace(/\.tsx$/, '');
            const modulo = '@/' + rel.replace(/^src\//, '').replace(/\.tsx$/, '');
            const importatori = [...FILE_DI_ROTTA, ...FILE_COMPONENTI].filter(
                (f) => f !== rel && fs.readFileSync(path.join(RADICE, f), 'utf8').includes(`from '${modulo}'`),
            );

            if (importatori.length === 0) {
                irrisolti.push(`${rel} → guscio chiaro senza marcatore e senza nessun importatore (${nome})`);
                continue;
            }
            for (const imp of importatori) {
                if (!imp.startsWith('src/app/')) {
                    irrisolti.push(
                        `${rel} → montato da ${imp}, che non è un file di rotta: la copertura non è più decidibile`,
                    );
                    continue;
                }
                if (!superficieCoperta(imp)) {
                    irrisolti.push(`${rel} → montato da ${imp}, che NON è una superficie coperta`);
                }
            }
        }
        expect(
            irrisolti,
            [
                AIUTO,
                '',
                'Per un guscio che vive in `src/components` la copertura si eredita da chi lo monta, e',
                'questo lock la risolve leggendo gli import. Se non riesce più a risolverla, la strada',
                'giusta è dichiarare il marcatore sul guscio del componente — non allargare il lock.',
            ].join('\n'),
        ).toEqual([]);
    });
});

describe('lock — l’allowlist può morire, e quando muore lo dice', () => {
    it('ogni voce è ben formata, senza doppioni, e la ragione è scritta', () => {
        const doppi = ALLOWLIST.map((v) => v.path).filter((p, i, a) => a.indexOf(p) !== i);
        expect(doppi, 'stessa voce due volte: la ragione non sarebbe più leggibile').toEqual([]);
        for (const v of ALLOWLIST) {
            expect(v.path.startsWith('src/'), `path fuori da src/: ${v.path}`).toBe(true);
            expect(
                v.motivo.trim().length,
                `la voce ${v.path} non porta una ragione scritta. Una deroga senza motivo è una ` +
                    'deroga che nessuno saprà più togliere.',
            ).toBeGreaterThan(80);
        }
    });

    it('nessuna voce è MORTA (file sparito, o deroga che non serve più)', () => {
        const spariti: string[] = [];
        const inutili: string[] = [];
        for (const v of ALLOWLIST) {
            if (!fs.existsSync(path.join(RADICE, v.path))) {
                spariti.push(v.path);
                continue;
            }
            const scoperti = gusciChiari(v.path).filter((g) => !g.marcato && !copertoDaUnAntenato(v.path));
            if (scoperti.length === 0) inutili.push(v.path);
        }
        expect(
            spariti,
            'Voci che puntano a file inesistenti: toglile. Una riga che non corrisponde a niente fa ' +
                'sembrare il debito più grande di quello che è, e fa perdere tempo a chi lo smaltisce.',
        ).toEqual([]);
        expect(
            inutili,
            'Queste superfici NON hanno più un guscio chiaro scoperto — il marcatore è stato aggiunto, ' +
                'o il fondo è cambiato, o il guscio non c\'è più. Togli la voce dall\'allowlist: se resta, ' +
                'il giorno in cui la pagina tornerà scoperta il lock tacerà, ed è esattamente il buco che ' +
                'questo file esiste per chiudere.',
        ).toEqual([]);
    });
});

describe('lock — prova di validità del rilevatore', () => {
    const scopri = (jsx: string) => {
        const cn = classNames(jsx);
        return cn
            .filter((c) => ALTEZZA_PIENA.test(c.valore) && fondoChiaroIn(c.valore))
            .map((c) => ({
                marcato: MARCATORE_CLASSE.test(c.valore) || MARCATORE_ATTRIBUTO.test(tagAttorno(jsx, c.indice)),
                fondo: fondoChiaroIn(c.valore)!.classe,
            }));
    };

    it('il guscio SCOPERTO viene visto, ed è il difetto verbatim del 2026-09-06', () => {
        const jsx = '<main className="min-h-screen bg-kidville-cream px-4 py-10 sm:py-12">…</main>';
        expect(scopri(jsx)).toEqual([{ marcato: false, fondo: 'bg-kidville-cream' }]);
    });

    it('`kv-public` sulla className copre', () => {
        const jsx = '<main className="kv-public min-h-screen bg-kidville-cream px-4 py-10">…</main>';
        expect(scopri(jsx)).toEqual([{ marcato: true, fondo: 'bg-kidville-cream' }]);
    });

    it('`data-kv-shell` sul tag copre, anche se non sta nella className', () => {
        const jsx = '<div className="min-h-screen bg-kidville-cream" data-kv-shell>…</div>';
        expect(scopri(jsx)).toEqual([{ marcato: true, fondo: 'bg-kidville-cream' }]);
    });

    it('`data-kv-shell` su un ALTRO tag non copre questo', () => {
        const jsx =
            '<div data-kv-shell />\n<main className="min-h-screen bg-white">…</main>';
        expect(scopri(jsx)).toEqual([{ marcato: false, fondo: 'bg-white' }]);
    });

    it('un fondo SCURO non è un guscio chiaro: /offline resta fuori', () => {
        const jsx =
            '<main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-kidville-green px-8 text-center">…</main>';
        expect(scopri(jsx)).toEqual([]);
    });

    it('un fondo chiaro SENZA altezza piena non è un guscio', () => {
        const jsx = '<article className="rounded-card bg-white p-6 shadow-sm">…</article>';
        expect(scopri(jsx)).toEqual([]);
    });

    it('l’alfa non salva: `bg-kidville-cream/40` conta come crema', () => {
        const jsx = '<div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">…</div>';
        expect(scopri(jsx)).toEqual([{ marcato: false, fondo: 'bg-kidville-cream' }]);
    });

    it('la className scritta in una espressione viene letta lo stesso', () => {
        const jsx = "<div className={inCockpit ? '' : 'min-h-screen bg-kidville-cream/40'}>…</div>";
        expect(scopri(jsx)).toEqual([{ marcato: false, fondo: 'bg-kidville-cream' }]);
    });

    it('`min-h-dvh` conta quanto `min-h-screen`', () => {
        const jsx = '<div className="relative flex min-h-dvh flex-col overflow-hidden bg-kidville-cream px-4">…</div>';
        expect(scopri(jsx)).toEqual([{ marcato: false, fondo: 'bg-kidville-cream' }]);
    });

    it('una classe che CONTIENE il nome del marcatore non è il marcatore', () => {
        const jsx = '<main className="kv-public-ish min-h-screen bg-white">…</main>';
        expect(scopri(jsx)).toEqual([{ marcato: false, fondo: 'bg-white' }]);
    });

    it('il controllo sulle regole CSS sa dire di NO (su un CSS che non le ha)', () => {
        const senza = '[data-contrast="high"] body { color: #FFFFFF }\n.kv-public { color: red }';
        expect(ribaltaLaShell(senza)).toBe(false);
        expect(ribaltaLePubbliche(senza)).toBe(false);
        // …e di sì, sulla forma minima della regola vera.
        const con = '[data-contrast="high"] [data-kv-shell],\n[data-contrast="high"] .kv-public { color: #000000 }';
        expect(ribaltaLaShell(con)).toBe(true);
        expect(ribaltaLePubbliche(con)).toBe(true);
    });

    it('la catena dei layout distingue coperto da scoperto su file VERI del repo', () => {
        // Positivo: la pagina non ha marcatori suoi, la copertura gliela dà il layout.
        expect(copertoDaUnAntenato('src/app/(dashboard)/parent/forms/[id]/page.tsx')).toBe(
            'src/app/(dashboard)/parent/layout.tsx',
        );
        expect(superficieCoperta('src/app/(dashboard)/admin/impostazioni/page.tsx')).toBe(true);

        // Negativo, ed è la parte che rende il positivo un'informazione: fuori dalle
        // aree non c'è nessun layout con marcatore, e `src/app/layout.tsx` non ne ha.
        expect(copertoDaUnAntenato('src/app/privacy/page.tsx')).toBeNull();
        expect(copertoDaUnAntenato('src/app/offline/page.tsx')).toBeNull();
        expect(superficieCoperta('src/app/offline/page.tsx')).toBe(false);

        // La pagina pubblica è coperta dalla PROPRIA classe, non da un antenato.
        expect(superficieCoperta('src/app/privacy/page.tsx')).toBe(true);

        // Un guscio di shell non si copre da sé risalendo a sé stesso: il suo
        // marcatore deve stare sul proprio tag, e infatti l'antenato non ce l'ha.
        expect(copertoDaUnAntenato('src/app/(dashboard)/parent/layout.tsx')).toBeNull();
    });
});
