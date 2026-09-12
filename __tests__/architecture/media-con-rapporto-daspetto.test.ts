import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * LOCK STRUTTURALE SUI MEDIA — un'immagine o un video a larghezza piena dichiara
 * quanto sarà ALTO, oppure dice dove si ferma.
 *
 * ─── IL BUCO CHE CHIUDE ─────────────────────────────────────────────────────
 * Il 2026-09-11, in `__tests__/`, non esisteva UNA SOLA asserzione su `grid-cols`,
 * `aspect-square`, `object-cover` o `<video>`. Verificato con grep prima di scrivere
 * questo file. È per questo che l'impaginazione rotta della galleria è arrivata in
 * produzione col gate verde: `eslint` non sa cosa sia un rapporto d'aspetto, `tsc`
 * vede una stringa, e i test in jsdom non hanno layout — `getBoundingClientRect`
 * restituisce zeri, quindi nessuno di loro poteva vedere un video verticale
 * allargato alla colonna né un pulsante caduto 80 px sotto il bordo.
 *
 * ─── LA REGOLA, E PERCHÉ È QUESTA ───────────────────────────────────────────
 * Un `<img>`/`<video>` con `w-full`/`w-screen` prende la larghezza del
 * contenitore. L'altezza, se nessuno la dichiara, la decide il RAPPORTO INTRINSECO
 * del file — cioè un dato che arriva dal telefono di un'insegnante e che nessuno
 * controlla. Un video 9:16 girato in verticale, larghezza 390, è alto 693 px: più
 * di uno schermo intero, e tutto ciò che gli sta sotto (i comandi) finisce fuori
 * campo. Quindi: o si dichiara il rapporto (`aspect-*`, `style={{aspectRatio}}`) —
 * e allora l'altezza è nota a priori — o si dichiara un tetto d'altezza insieme a
 * `object-contain`/`object-cover`, che è ciò che rende il taglio deliberato invece
 * che casuale. Un tetto SENZA `object-fit` non basta: l'immagine si deforma.
 *
 * ─── PERCHÉ IL CONTEGGIO ESATTO, E NON «ZERO VIOLAZIONI» ────────────────────
 * Le due violazioni che restano sono fuori dallo scopo del lavoro che ha scritto
 * questo lock (stanno nelle news, non nella galleria) e correggerle è una decisione
 * di prodotto: la copertina di un articolo TAGLIATA è una scelta grafica, non un
 * refuso. Metterle in allowlist con il numero esatto e la ragione scritta ottiene
 * le due cose che servono insieme: il debito è DICHIARATO (chi lo legge sa quante
 * sono e dove), e non può CRESCERE — se ne compare una terza il lock è rosso.
 * E i tetti si abbassano, mai si alzano: chi bonifica un file toglie la voce e
 * porta giù il numero, invece di lasciare credito non speso. Il credito non speso
 * è lo spazio in cui il difetto rientra restando verde, ed è già successo in
 * questo repo (`testo-muted-allowlist`, 73 occorrenze di slack).
 *
 * ─── COSA QUESTO LOCK NON PUÒ FARE ──────────────────────────────────────────
 * Legge il SORGENTE: sa dire che una classe c'è, non che a schermo produce il
 * risultato giusto. `max-h-[70svh]` scritto e `max-h-[70vh]` scritto sono
 * indistinguibili per lui, e su Safari iOS non lo sono per niente (`vh` è il
 * viewport GRANDE, quello senza barra degli indirizzi). Quella misura è
 * dell'altro livello: `e2e/impaginazione-media.spec.ts`, che apre le due gallerie
 * a 390×844 su WebKit e misura i rettangoli veri. I due si coprono a vicenda e
 * nessuno dei due da solo basta: il lock gira in due secondi su ogni file di
 * `src/` e ferma la classe che manca PRIMA del commit; il crawler gira in CI su
 * due schermate sole e vede ciò che il sorgente non dice.
 *
 * E poi questi quattro limiti, che sono del lock e non del crawler. Stanno scritti
 * perché un limite taciuto è un verde che qualcuno prenderà per una promessa.
 *
 *  1. **`h-full` passa come tetto d'altezza, e non è un tetto: è una DELEGA.**
 *     `h-full` vale `height: 100%`, cioè l'altezza del genitore — e in un genitore
 *     ad altezza automatica risolve ad `auto`, cioè a nessun tetto: allora
 *     `object-cover` non ha niente da cui tagliare, che è precisamente il difetto
 *     che la regola qui sopra descrive. Il genitore questo lock NON lo vede, legge
 *     un tag alla volta. Quindi `w-full h-full object-cover` è conforme **solo
 *     dentro un contenitore con l'altezza dichiarata**, e quando compare in un file
 *     nuovo si guarda il CHIAMANTE, non questo lock. Misurato il 2026-09-12: quattro
 *     dei tag conformi passano per questa via (la miniatura della tessera in
 *     `MediaGrid.tsx`, dentro un contenitore `aspect-square`; `NewsCard.tsx`;
 *     `CheckoutModal.tsx`; `TaskCard.tsx`, dentro un quadrato `w-9 h-9`) e tutti e quattro hanno il genitore dimensionato:
 *     nessun verde falso oggi. Irrigidire il predicato renderebbe rossi quattro file
 *     sani — cioè porterebbe a spegnere il lock; risalire al genitore è un lavoro a
 *     sé, dichiarato qui invece che taciuto, come il caso `<Image fill>`.
 *  2. **Le classi che arrivano da una PROP non le vede.** L'estrattore legge il
 *     testo del tag: `<img className={className} />` non contiene `w-full`, quindi
 *     quel tag esce dalla regola — ed è la scappatoia con cui un lock si neutralizza
 *     senza sembrare (si spostano le classi fuori dal tag e il rosso passa). Il caso
 *     vive dentro la galleria — `AnteprimaMedia.tsx`, le anteprime del caricamento
 *     video, cioè il percorso del difetto di questo stesso lavoro — e per questo dal
 *     2026-09-12 la forma più frequente **viene risolta**: un `className={IDENT}` che
 *     porta a una `const` stringa nello stesso file, anche passando per un default di
 *     destrutturazione (`{ className = RIEMPI }`). Vedi `classiRisolte`. Ciò che
 *     resta invisibile è la classe che arriva DAL CHIAMANTE: lì si guarda il
 *     chiamante, e i tre chiamanti di oggi mettono le anteprime in tessere
 *     dimensionate (`w-16 h-16 sm:w-20 sm:h-20`).
 *  3. Le classi composte a runtime (`cx(x && 'w-full')`) le vede solo se il
 *     letterale è scritto dentro il tag — e lì, in questo repo, c'è.
 *  4. Non sa niente dei breakpoint: `sm:aspect-video` conta come rapporto dichiarato
 *     anche se sotto i 640 px quel rapporto non esiste. È il limite che il crawler
 *     copre, perché misura a 390 px.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');

/* ────────────────────────────────────────────────────────────────────────────────
 * L'ALLOWLIST — due voci, misurate il 2026-09-11 con questo stesso estrattore.
 *
 * ⚠️ NON è l'elenco che il piano di lavoro si aspettava. Il piano ne nominava
 * cinque (`VideoEmbed`, `NewsDetailContent`, `InstagramEmbed`, `ChatMessageArea`,
 * `TaskCard`); misurati uno per uno, TRE sono conformi e non entrano qui:
 *  · `ChatMessageArea.tsx:210` — `w-full h-auto max-h-48 object-cover`: il tetto
 *    c'è (`max-h-48`) e l'`object-fit` c'è. È la forma giusta, non un'eccezione.
 *  · `TaskCard.tsx:241` — `w-full h-full object-cover` dentro un quadrato
 *    `w-9 h-9`: l'altezza è quella del padre, che è dichiarata.
 *  · `InstagramEmbed.tsx` — non contiene nessun `<img>` né `<video>`: è un
 *    `<iframe>` con `h-[560px]`, cioè fuori regola e comunque con l'altezza
 *    dichiarata.
 * Scriverle in allowlist «perché erano nell'elenco» avrebbe spento la regola su
 * tre file sani, ed è la mossa che trasforma un'allowlist in un porto franco.
 * ──────────────────────────────────────────────────────────────────────────────── */
type Voce = { path: string; n: number; perche: string };

const ALLOWLIST: Voce[] = [
    {
        path: 'src/components/features/news/VideoEmbed.tsx',
        n: 1,
        perche:
            'Il `<video>` di un articolo (`className="w-full rounded-card bg-black"`): nessun ' +
            'rapporto, nessun tetto. Un video verticale caricato in una news è alto quanto il suo ' +
            'rapporto decide. È il caso peggiore dei due, e sta qui perché le news non sono lo ' +
            'scopo del lavoro che ha scritto questo lock: la correzione è la stessa già applicata ' +
            'nel visore della galleria (`max-h-[70svh] w-auto max-w-full object-contain`), e va ' +
            'fatta guardando la pagina, non incollando una classe.',
    },
    {
        path: 'src/components/features/news/NewsDetailContent.tsx',
        n: 1,
        perche:
            'La COPERTINA dell\'articolo (`className="w-full object-cover"`): `object-cover` senza ' +
            'tetto d\'altezza non taglia niente, perché non c\'è niente da cui tagliare. La ' +
            'galleria dello stesso file (riga ~106) è conforme e dichiara `aspect-square`: qui ' +
            'basterebbe la stessa mossa, ma quale rapporto debba avere una copertina è una ' +
            'decisione grafica e non la prende un lock.',
    },
];

/**
 * TETTI MONOTONI DECRESCENTI. Misura del 2026-09-12: 10 tag a larghezza piena in
 * tutto `src/`, 8 conformi, 2 in allowlist — le due che stanno qui sotto, e sono
 * le stesse di ieri. (Il 2026-09-11 erano 8 e 6: i due in più NON sono codice
 * nuovo, sono i due tag di `AnteprimaMedia.tsx` che l'estrattore prima non vedeva
 * perché le loro classi arrivano da una `const`. Entrambi conformi. Quando un
 * conteggio si muove va detto SE si è mosso il repo o lo strumento.)
 * Si abbassano, mai si alzano.
 * Chi si trovasse a doverli ALZARE sta aggiungendo un media senza rapporto, ed è
 * quello il momento di fermarsi, non dopo.
 */
const MAX_FILE = 2;
const MAX_OCCORRENZE = 2;

/* ────────────────────────────────────────────────────────────────────────────────
 * I PAVIMENTI — «questo lock sta guardando qualcosa?».
 *
 * Un estrattore di tag JSX si rompe in silenzio: basta che la ricerca del `>` di
 * chiusura sbagli un ramo e il lock trova zero tag, dichiara zero violazioni e
 * resta verde per sempre. Sono PAVIMENTI e non fotografie: se salgono non è un
 * rosso (il repo è cresciuto), se scendono sotto il minimo l'estrattore è cieco e
 * va guardato lui, non il numero.
 * ──────────────────────────────────────────────────────────────────────────────── */
/** Tag `<img>`/`<video>` in tutto `src/` (misurati: 18). */
const MEDIA_MINIMI = 12;
/** Di quelli, quanti sono a larghezza piena (misurati: 10). */
const PIENI_MINIMI = 4;
/** Di quelli a larghezza piena, quanti sono CONFORMI (misurati: 8). */
const CONFORMI_MINIMI = 4;
/** Nodi con una classe `opacity-*` (misurati: 240): prova che il lato CLASSE spara. */
const CLASSE_OPACITY_MINIME = 100;
/**
 * Nodi con un `style` inline che contiene `opacity` (misurato: 1, `TiltCard.tsx:70`).
 * È il pavimento più fragile dei cinque, ed è voluto: se un giorno quel file
 * sparisse, il secondo lock non avrebbe più NIENTE su cui sparare e sarebbe verde
 * senza provare nulla. Meglio un rosso che chiede di rileggerlo.
 */
const STYLE_OPACITY_MINIMI = 1;

/* ────────────────────────────────────────────────────────────────────────────────
 * COSA RESTA FUORI DALLA REGOLA, per scelta e con la ragione:
 *
 *  · `next/image` (`<Image>`). Il compilatore lo fa già: i suoi tipi pretendono
 *    `width`+`height` oppure `fill`, quindi un'immagine senza dimensioni
 *    dichiarate non compila. Una regola in più qui sarebbe una regola che non può
 *    scattare. (Il caso `fill` dentro un padre non dimensionato È un difetto
 *    possibile, e non lo copre nessuno: è un lavoro a sé, dichiarato qui invece
 *    che taciuto.)
 *  · `<iframe>`. Non è un media con rapporto intrinseco: è un documento, e
 *    l'altezza gliela dà sempre chi lo incorpora. I due del repo la dichiarano
 *    (`h-[560px]` su Instagram, `style={{ aspectRatio: '16 / 9' }}` su Vimeo).
 *  · le larghezze diverse da `w-full`/`w-screen`. Un `<img className="w-24">` ha
 *    una larghezza NOTA: il suo rapporto sbagliato produce un'immagine piccola e
 *    schiacciata, non una pagina che sfonda. È un difetto grafico, non
 *    strutturale, e un lock che li prendesse tutti costringerebbe a un'allowlist
 *    di decine di voci — cioè a spegnersi da solo.
 * ──────────────────────────────────────────────────────────────────────────────── */

/**
 * Sostituisce i commenti con spazi, lasciando INTATTE le stringhe e i ritorni a
 * capo (così i numeri di riga restano quelli veri).
 *
 * NON è un di più: in questo repo i commenti CITANO le classi di cui parlano.
 * `MediaGrid.tsx` cita `w-full max-h-[55vh]` per spiegare com'era il visore prima
 * della correzione, e cita `style={{ opacity: 1 }}` accanto a
 * `opacity-0 group-hover:opacity-100` per spiegare il difetto che il secondo lock
 * qui sotto sorveglia. Senza questa maschera il lock sarebbe rosso ESATTAMENTE sul
 * commento che racconta la correzione — e chi lo vedesse rosso imparerebbe a non
 * scrivere più quei commenti, che è il danno peggiore dei due.
 *
 * Stessa tecnica di `catch-muti-allowlist.test.ts` (lì la maschera è `§` per le
 * clausole `catch {}`, perché `no-empty` ignora i blocchi commentati; qui serve
 * che i commenti SPARISCANO, quindi spazi).
 */
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

interface Tag { nome: string; riga: number; testo: string }

/**
 * Estrae i TAG DI APERTURA che `rx` individua, dal `<` al `>` che li chiude.
 *
 * Non è un parser JSX e non pretende di esserlo: gli serve sapere dove finisce il
 * tag, e per quello bastano tre cose — le stringhe (dentro cui un `>` non chiude
 * niente), le graffe (`style={{ a: b > c }}`, `className={cx('a')}`) e gli escape.
 * Contare le graffe è il motivo per cui questo non è una regex: `className={x}`
 * dentro `<div style={{ transform: `translate(${x}px)` }}>` manda a gambe l'aria
 * qualunque `/<div[^>]*>/`.
 *
 * `rx.lastIndex = fine` dopo ogni tag: senza, un `<img>` annidato in un attributo
 * (non capita, ma) verrebbe contato due volte.
 */
function tagDiApertura(sorgente: string, rx: RegExp): Tag[] {
    const res: Tag[] = [];
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(sorgente))) {
        let i = m.index + m[0].length;
        let graffe = 0;
        let apice = '';
        let fine = -1;
        while (i < sorgente.length) {
            const c = sorgente[i];
            if (apice) {
                if (c === '\\') { i += 2; continue; }
                if (c === apice) apice = '';
                i++; continue;
            }
            if (c === '"' || c === "'" || c === '`') { apice = c; i++; continue; }
            if (c === '{') { graffe++; i++; continue; }
            if (c === '}') { graffe--; i++; continue; }
            if (c === '>' && graffe === 0) { fine = i; break; }
            i++;
        }
        if (fine < 0) continue;
        res.push({
            nome: m[1],
            riga: sorgente.slice(0, m.index).split('\n').length,
            testo: sorgente.slice(m.index, fine + 1),
        });
        rx.lastIndex = fine;
    }
    return res;
}

/**
 * Una classe Tailwind è un TOKEN, non una sottostringa — e la differenza costa il
 * lock. `max-w-full` contiene `w-full`: senza il confine a sinistra questo lock
 * dichiarerebbe «a larghezza piena» il `<video>` del visore della galleria, che è
 * `w-auto max-w-full` cioè l'opposto. Il lookbehind rifiuta lettere, cifre, `_` e
 * il TRATTINO; il lookahead fa lo stesso a destra. Un prefisso di breakpoint
 * (`sm:w-full`) passa, perché `:` non è nessuna delle due cose.
 */
const token = (classe: string) => new RegExp(String.raw`(?<![\w-])${classe}(?![\w-])`);

const W_FULL = token('w-full');
const W_SCREEN = token('w-screen');
/** `aspect-square`, `aspect-[16/9]`, `aspect-video`. `aspect-auto` NON dichiara niente. */
const RAPPORTO_CLASSE = /(?<![\w-])aspect-(?!\[?auto(?![\w-]))/;
const RAPPORTO_INLINE = /aspectRatio/;
const OBJECT_FIT = /(?<![\w-])object-(contain|cover)(?![\w-])/;
/** `h-full`, `h-48`, `max-h-[70svh]`, `style={{ maxHeight: … }}`, `height: …`. `h-auto` no. */
const TETTO_ALTEZZA = /(?<![\w-])(?:max-)?h-(?!\[?auto(?![\w-]))|maxHeight|(?<![\w-])height\s*:/;

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

const codice = new Map<string, string>();
function leggi(rel: string): string {
    let s = codice.get(rel);
    if (s === undefined) {
        s = mascheraCommenti(fs.readFileSync(path.join(RADICE, rel), 'utf8'));
        codice.set(rel, s);
    }
    return s;
}

/**
 * Il valore di una `const`/`let` stringa dichiarata nello stesso file — niente
 * interpolazione, niente concatenazione: se non è un letterale puro, non si indovina.
 */
function costanteStringa(sorgente: string, nome: string): string | null {
    // `'`'` e non un backtick scritto: questa riga vive DENTRO un file che il
    // lock stesso non legge, ma un backtick dentro un `String.raw` chiuderebbe il
    // template — ed è così che questa funzione ha rotto la suite al primo giro.
    const APICI = '[\'"`]';
    const rx = new RegExp('(?:const|let)\\s+' + nome + '\\s*(?::\\s*string)?\\s*=\\s*(' + APICI + ')([\\s\\S]*?)\\1');
    const m = rx.exec(sorgente);
    if (!m || m[2].includes('${')) return null;
    return m[2];
}

/**
 * Le classi che il tag NON scrive ma che gli arrivano da un identificatore dello
 * stesso file. Chiude la scappatoia n. 2 della testata per il suo caso più
 * frequente, che è anche quello che vive nella galleria:
 *
 *   const RIEMPI = 'w-full h-full object-cover';                      ← qui
 *   function AnteprimaMedia({ className = RIEMPI }: Props) {          ← un salto
 *     return <img src={src} alt="" className={className} />;          ← il tag
 *
 * DUE salti al massimo, e solo verso letterali: un risolutore che inseguisse
 * espressioni arbitrarie diventerebbe un interprete, e un interprete che sbaglia in
 * silenzio è peggio del limite scritto. Se non trova niente restituisce stringa
 * vuota, cioè lascia il tag fuori dalla regola — come prima, ma per iscritto.
 */
function classiRisolte(sorgente: string, testoTag: string): string {
    const identificatori = [...testoTag.matchAll(/className=\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]);
    const risolti: string[] = [];
    for (const id of identificatori) {
        const diretto = costanteStringa(sorgente, id);
        if (diretto !== null) { risolti.push(diretto); continue; }
        // Secondo salto: `{ className = RIEMPI }` in una destrutturazione.
        const viaDefault = new RegExp(String.raw`(?<![\w$])${id}\s*=\s*([A-Za-z_$][\w$]*)`).exec(sorgente);
        if (!viaDefault) continue;
        const indiretto = costanteStringa(sorgente, viaDefault[1]);
        if (indiretto !== null) risolti.push(indiretto);
    }
    return risolti.join(' ');
}

interface Media {
    file: string; riga: number; nome: string; pieno: boolean; conforme: boolean; testo: string;
    /** Le classi arrivate da un identificatore: vuote quasi sempre, e si stampano. */
    risolte: string;
}

function mediaDi(rel: string): Media[] {
    const sorgente = leggi(rel);
    return tagDiApertura(sorgente, /<(img|video)(?=[\s/>])/g).map((t) => {
        const risolte = classiRisolte(sorgente, t.testo);
        // Il testo su cui i predicati decidono: il tag PIÙ le classi risolte. Il
        // `testo` originale resta quello che si stampa in un rosso, così chi lo legge
        // vede il tag come è scritto nel file e non una ricostruzione.
        const classi = risolte ? `${t.testo} ${risolte}` : t.testo;
        const pieno = W_FULL.test(classi) || W_SCREEN.test(classi);
        const rapporto = RAPPORTO_CLASSE.test(classi) || RAPPORTO_INLINE.test(classi);
        const conforme = rapporto || (OBJECT_FIT.test(classi) && TETTO_ALTEZZA.test(classi));
        return { file: rel, riga: t.riga, nome: t.nome, pieno, conforme, testo: t.testo, risolte };
    });
}

/** Solo i tag che la regola riguarda: a larghezza piena. */
function violazioniDi(rel: string): Media[] {
    return mediaDi(rel).filter((m) => m.pieno && !m.conforme);
}

const tuttiIMedia = (): Media[] => sorgenti().flatMap(mediaDi);

function riassunto(m: Media): string {
    const risolte = m.risolte ? ` + classi da un identificatore: «${m.risolte}»` : '';
    return `${m.file}:${m.riga} <${m.nome}> — ${m.testo.replace(/\s+/g, ' ').slice(0, 160)}${risolte}`;
}

describe('lock — un media a larghezza piena dichiara il suo rapporto (o dove si ferma)', () => {
    it('il lock non è cieco per costruzione (pavimenti sull’estrattore)', () => {
        const media = tuttiIMedia();
        expect(
            media.length,
            `L’estrattore trova ${media.length} tag <img>/<video> in src/ (pavimento ${MEDIA_MINIMI}). ` +
                'Sotto il pavimento non è «il repo si è alleggerito»: è l’estrattore che non trova ' +
                'più i tag, e da quel momento questo lock dichiara zero violazioni su qualunque cosa.',
        ).toBeGreaterThanOrEqual(MEDIA_MINIMI);

        const pieni = media.filter((m) => m.pieno);
        expect(
            pieni.length,
            `Solo ${pieni.length} tag a larghezza piena (pavimento ${PIENI_MINIMI}): il predicato ` +
                '`w-full`/`w-screen` non spara più. Il sospetto numero uno è il confine a sinistra ' +
                'del token — `max-w-full` NON è `w-full`, e un lookbehind sbagliato spegne o ' +
                'raddoppia questo lock in silenzio.',
        ).toBeGreaterThanOrEqual(PIENI_MINIMI);

        expect(
            pieni.filter((m) => m.conforme).length,
            `Solo ${pieni.filter((m) => m.conforme).length} tag a larghezza piena risultano CONFORMI ` +
                `(pavimento ${CONFORMI_MINIMI}). Se il predicato di conformità non spara più, ogni ` +
                'media diventa una violazione e il lock è rosso per un motivo che non c’entra con ' +
                'il prodotto — il che porta a spegnerlo.',
        ).toBeGreaterThanOrEqual(CONFORMI_MINIMI);
    });

    it('ogni voce dell’allowlist esiste ancora e ha ESATTAMENTE il numero dichiarato', () => {
        const scomparsi: string[] = [];
        const bonificati: string[] = [];
        const divergenti: string[] = [];

        for (const v of ALLOWLIST) {
            if (!fs.existsSync(path.join(RADICE, v.path))) { scomparsi.push(v.path); continue; }
            const misurato = violazioniDi(v.path).length;
            if (misurato === 0) { bonificati.push(v.path); continue; }
            if (misurato !== v.n) divergenti.push(`${v.path}: dichiarate ${v.n}, misurate ${misurato}`);
        }

        expect(
            scomparsi,
            'File in allowlist che non esistono più: togli la voce. Una riga che non corrisponde a ' +
                'niente fa sembrare il debito più grande di quello che è.',
        ).toEqual([]);

        expect(
            bonificati,
            'Questi file NON hanno più media senza rapporto: ottimo, ora togli la voce e abbassa ' +
                'MAX_FILE/MAX_OCCORRENZE. Se la voce resta, il file torna un porto franco e la ' +
                'prossima immagine senza tetto ci rientra senza che nessuno se ne accorga.',
        ).toEqual([]);

        expect(
            divergenti,
            'Il numero non combacia. Se è SALITO hai aggiunto un media a larghezza piena senza ' +
                'rapporto né tetto: dichiara `aspect-*` (o `style={{aspectRatio}}`), oppure un ' +
                '`max-h-*` insieme a `object-contain`/`object-cover`. Se è SCESO hai bonificato: ' +
                'scrivi il numero nuovo e porta giù i tetti.',
        ).toEqual([]);
    });

    it('nessun media a larghezza piena senza rapporto FUORI dall’allowlist', () => {
        const noti = new Set(ALLOWLIST.map((v) => v.path));
        const nuove = sorgenti()
            .filter((f) => !noti.has(f))
            .flatMap(violazioniDi)
            .map(riassunto);

        expect(
            nuove,
            'Un `<img>`/`<video>` a `w-full` senza rapporto d’aspetto né tetto d’altezza. Non ' +
                'aggiungerlo all’allowlist — l’allowlist può solo rimpicciolirsi. L’altezza la ' +
                'deciderebbe il file caricato dal telefono di un’insegnante: un video 9:16 a ' +
                'larghezza 390 è alto 693 px, e tutto ciò che gli sta sotto esce dallo schermo. ' +
                'Si dichiara `aspect-[16/9]` (o `style={{aspectRatio}}`), oppure ' +
                '`max-h-[70svh] object-contain` come il visore della galleria — `svh` e non `vh`, ' +
                'perché su Safari iOS `vh` è il viewport senza la barra degli indirizzi.',
        ).toEqual([]);
    });

    it('l’allowlist può solo rimpicciolirsi (tetti monotoni decrescenti)', () => {
        const somma = ALLOWLIST.reduce((s, v) => s + v.n, 0);

        expect(
            ALLOWLIST.length,
            `L’allowlist è cresciuta a ${ALLOWLIST.length} file (tetto ${MAX_FILE}). Alzare il ` +
                'tetto non è la risposta: è la mossa con cui un’allowlist diventa decorazione.',
        ).toBeLessThanOrEqual(MAX_FILE);

        expect(
            somma,
            `L’allowlist dichiara ${somma} media senza rapporto (tetto ${MAX_OCCORRENZE}).`,
        ).toBeLessThanOrEqual(MAX_OCCORRENZE);
    });

    it('ogni voce dell’allowlist porta la sua ragione scritta', () => {
        // Una voce senza ragione è un numero che nessuno sa più perché è lì: al primo
        // dubbio la si alza, perché costa meno che capire.
        const mute = ALLOWLIST.filter((v) => (v.perche ?? '').trim().length < 60).map((v) => v.path);
        expect(mute, 'Voce in allowlist senza una ragione scritta per esteso.').toEqual([]);
    });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * SECONDO LOCK — uno `style` inline non contraddice la classe che gli sta accanto.
 *
 * IL DIFETTO, misurato nella galleria il 2026-09-11: sullo STESSO nodo c'erano
 * `opacity-0 group-hover:opacity-100 md:group-hover:opacity-100` e, inline,
 * `style={{ opacity: 1 }}`. Lo stile inline vince su qualunque classe (è una
 * dichiarazione, non una regola: nessuna specificità la batte, solo `!important`).
 * Quindi le tre classi erano una BUGIA — chi leggeva il `className` credeva che i
 * comandi comparissero al passaggio del mouse, mentre erano sempre visibili.
 *
 * È il genere di contraddizione che nessun cancello del gate vede: ESLint non
 * confronta un attributo con un altro, `tsc` vede un oggetto valido, e in jsdom
 * `getComputedStyle` dice `1` — cioè conferma l'inline e non nota niente.
 * Un `className` che mente è peggio di un `className` sbagliato: il primo fa
 * scrivere la correzione nel posto dove non serve.
 * ══════════════════════════════════════════════════════════════════════════════ */

/** `style={{ …, opacity: x }}` — solo l'attributo, non un `opacity` qualunque. */
const STYLE_CON_OPACITY = /style\s*=\s*\{\{[^}]*?(?<![\w-])opacity\s*:/;
/** `opacity-0`, `opacity-55`, `opacity-[.85]`, `group-hover:opacity-100`. */
const CLASSE_OPACITY = /(?<![\w-])opacity-\[?[\w./]+/;

describe('lock — nessuno `style` inline che contraddica una classe `opacity-*`', () => {
    const tutti = () => sorgenti().flatMap((f) => tagDiApertura(leggi(f), /<([A-Za-z][\w.]*)(?=[\s/>])/g)
        .map((t) => ({ ...t, file: f })));

    it('il lock non è cieco per costruzione (i due predicati sparano davvero)', () => {
        const nodi = tutti();
        const conClasse = nodi.filter((t) => CLASSE_OPACITY.test(t.testo));
        const conStyle = nodi.filter((t) => STYLE_CON_OPACITY.test(t.testo));

        expect(
            conClasse.length,
            `Nodi con una classe \`opacity-*\`: ${conClasse.length} (pavimento ${CLASSE_OPACITY_MINIME}). ` +
                'Sotto il pavimento il lato CLASSE del confronto non spara più, e il lock è verde ' +
                'perché non guarda, non perché il repo sia pulito.',
        ).toBeGreaterThanOrEqual(CLASSE_OPACITY_MINIME);

        expect(
            conStyle.length,
            `Nodi con un \`style\` inline che contiene \`opacity\`: ${conStyle.length} (pavimento ` +
                `${STYLE_OPACITY_MINIMI}). Se è scesa a zero, l'ultimo nodo su cui questo lock poteva ` +
                'sparare non esiste più (era `src/components/features/admin/motion/TiltCard.tsx`, ' +
                'un riflesso `background`+`opacity` calcolati insieme, senza nessuna classe accanto: ' +
                'legittimo). Rileggi la regex PRIMA di fidarti del verde, e poi riporta il pavimento ' +
                'a quello che misuri.',
        ).toBeGreaterThanOrEqual(STYLE_OPACITY_MINIMI);
    });

    it('nessun nodo porta insieme una classe `opacity-*` e un `style` inline con `opacity`', () => {
        const colpevoli = tutti()
            .filter((t) => STYLE_CON_OPACITY.test(t.testo) && CLASSE_OPACITY.test(t.testo))
            .map((t) => `${t.file}:${t.riga} <${t.nome}> — ${t.testo.replace(/\s+/g, ' ').slice(0, 160)}`);

        expect(
            colpevoli,
            'Su questo nodo lo `style` inline e la classe `opacity-*` dicono due cose diverse, e ' +
                'vince l’inline: la classe è decorazione. Scegli UNO dei due. Se l’opacità dipende ' +
                'da uno stato, lo stato governi la CLASSE (o un `data-*` con la sua regola); se ' +
                'dev’essere un numero calcolato, togli la classe — e allora il `className` torna a ' +
                'dire il vero. È il difetto che ha reso invisibili i comandi della galleria per ' +
                'chi leggeva il codice, mentre a schermo erano sempre accesi.',
        ).toEqual([]);
    });
});
