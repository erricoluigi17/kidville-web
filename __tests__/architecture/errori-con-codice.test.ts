import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch';
import itShared from '../../messages/it/shared.json';
import enShared from '../../messages/en/shared.json';

/**
 * Lock sui MESSAGGI D'ERRORE DEL SERVER — la difesa che impedisce alla categoria di ricrescere.
 *
 * LA STORIA. Collaudo del 2026-07-31, categoria localizzazione: con l'interfaccia in inglese la
 * modale «New notice» rispondeva «Sede non accessibile» e «Specificare la sede (scuola_id) per
 * questa operazione». Italiano dentro un'interfaccia inglese, e il secondo messaggio — scritto
 * per chi legge i log — mostrava a una segretaria il nome di una colonna del database.
 *
 * Nessuna delle due era una traduzione dimenticata: quel testo NASCE sul server, dove il locale
 * e il catalogo non esistono, e il client (`messaggioErrore`) lo rende testualmente. Il tester
 * ha contato **452 messaggi d'errore italiani distinti** nelle route: tradurne due avrebbe
 * chiuso due sintomi e lasciato in piedi la causa. Perciò il canale ha un CODICE stabile
 * (`{ error: '…', codice: 'SEDE_NON_ACCESSIBILE' }`) e il client traduce il codice.
 *
 * COSA SORVEGLIA QUESTO FILE, e perché ciascuna regola.
 *
 *  1. **Ogni codice che esce da `src/` è dichiarato e tradotto in ENTRAMBE le lingue.** Un
 *     codice inventato in una route e mai dichiarato non è un mezzo fix: a schermo ricadrebbe
 *     sulla prosa italiana, cioè sul difetto di partenza, con l'aria di essere chiuso.
 *  2. **La frase di un codice non torna a viaggiare da sola.** Le 20 copie scritte a mano dicevano
 *     sei cose diverse per lo stesso rifiuto; ora passano tutte da `rifiutoSede()`. Se qualcuno
 *     riscrive «Sede non accessibile» a mano in una route, quella risposta smette di essere
 *     traducibile e nessun altro test se ne accorge.
 *  3. **Nessun messaggio mostrato all'utente nomina una colonna del database.** È la metà di F2
 *     che non riguarda la lingua: `scuola_id` non è un'informazione per chi lavora in segreteria.
 *  4. **Il debito non cresce.** Le risposte d'errore ancora SENZA codice sono 1478 in 284 file:
 *     sono l'inventario di `docs/superpowers/errori-senza-codice-allowlist.json`, che può solo
 *     rimpicciolirsi. Una risposta nuova in un file NUOVO è vietata; in un file già in elenco è
 *     vietato superare il numero dichiarato.
 *
 * PERCHÉ IL CONTEGGIO E NON LA RIGA. Le righe si spostano a ogni modifica sopra di loro: un lock
 * sui numeri di riga sarebbe rosso per motivi che non c'entrano niente, e un lock che suona a
 * vuoto è un lock che si impara a spegnere.
 *
 * COME SI PAGA IL DEBITO. Si sostituisce `NextResponse.json({ error: '…' }, { status })` con una
 * risposta che porta anche `codice`, si dichiara il codice in `CODICI_ERRORE`
 * (`src/lib/ui/esito-fetch.ts`) e si aggiungono le due voci ai cataloghi. Poi si abbassa il
 * numero del file in allowlist — o si toglie la voce, se è arrivato a zero.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');
const ALLOWLIST = path.join(RADICE, 'docs/superpowers/errori-senza-codice-allowlist.json');

/**
 * TETTI MONOTONI DECRESCENTI, misurati il 2026-08-01 dopo la conversione dei 20 dinieghi di
 * sede e RIMISURATI il 2026-08-07 con la conversione di «comunica un'assenza» (4 risposte, il
 * file esce dall'elenco). Si abbassano, mai si alzano.
 *
 * ⚠️ E si abbassano FINO ALLA MISURA, non di un po'. Fino a oggi dicevano 284/1478 mentre
 * l'allowlist era già scesa a 282/1471: sette risposte d'errore potevano tornare senza codice
 * con questo lock verde — cioè il debito poteva ricrescere dentro il test che esiste per
 * impedirlo. Non era una scelta: è ciò che succede quando si paga il debito e ci si dimentica
 * di stringere il tetto. Oggi i due numeri coincidono con `totale_occorrenze` e con la
 * lunghezza dell'elenco, e chi convertirà la prossima risposta dovrà toccarli per forza.
 *
 * 2026-08-08 · −1 (1465 → 1464). `attendance/daily:POST` restituiva il `message` grezzo di
 * PostgREST dentro `details` (rilievo M10): la risposta ora passa da `erroreInterno()`, che
 * nel file c'era già. Una risposta in meno scritta a mano, e il messaggio resta nel log.
 *
 * 2026-08-11 · −4 (1464 → 1460). `POST /api/admin/adults` è stato CANCELLATO — irraggiungibile
 * (nessuna pagina montava la sua scheda) e rotto (scriveva le colonne generate di `utenti`) — e
 * con lui quattro delle sei risposte senza codice di quel file: ne restano DUE, entrambe nel GET,
 * che resta. `MAX_FILE` non si muove: la voce resta in elenco, non è arrivata a zero.
 * Qui non è stato pagato un debito, è sparito il codice che lo portava: ma il tetto scende lo
 * stesso, perché lasciarlo a 1464 vorrebbe dire che quelle quattro risposte possono tornare —
 * dentro un file ancora vivo e gated — con questo lock verde. È il modo silenzioso in cui un
 * lock smette di misurare.
 *
 * 2026-08-12 · −5 (1460 → 1455). `DELETE /api/admin/students` è stata RIMOSSA: non funzionava
 * per 28 alunni su 33 (sette FK senza `ON DELETE CASCADE`) e per gli altri cinque metteva
 * l'operazione più distruttiva dell'app dietro un doppio clic. Con lei se ne vanno cinque
 * risposte d'errore senza codice — un 404, un 409, due 500 e il ripiego del `catch`. Come per
 * `admin/adults`, qui non è stato pagato un debito: è sparito il codice che lo portava. Il
 * tetto scende lo stesso, perché lasciarlo a 1460 vorrebbe dire che quelle cinque risposte
 * possono tornare — in un file vivo, gated e molto frequentato — con questo lock verde.
 * `MAX_FILE` non si muove: la voce resta in elenco, non è arrivata a zero (21 risposte).
 *
 * 2026-09-01 · −2 file e −18 risposte (280 → 278, 1455 → 1437), e i due cali non hanno la
 * stessa origine. CINQUE risposte se ne vanno con `GET/POST /api/locker/catalog`, cancellata:
 * unica rotta su `locker_catalog` (tabella che nessuna migrazione applicata crea), senza un
 * solo chiamante in tutto il repo, e con `error.message` di PostgREST restituito al chiamante
 * in due punti. Come per `admin/adults` e `admin/students`, qui non è stato pagato un debito:
 * è sparito il codice che lo portava, e il tetto scende lo stesso.
 *
 * Le altre TREDICI non sono di questo lavoro, ed è il motivo per cui vanno scritte. `0974424a`
 * (PR #88, carta intestata) ha abbassato l'allowlist a 1442 risposte e 279 file senza toccare
 * questi due numeri, rimasti a 1455/280: tredici risposte d'errore potevano tornare senza
 * codice, dentro file vivi, con questo lock verde. È il difetto descritto nel ⚠️ qui sopra
 * («si abbassano FINO ALLA MISURA, non di un po'»), ricomparso tre settimane dopo che quel
 * paragrafo era stato scritto — la prova che una regola affidata a un commento non si fa
 * rispettare da sola. Da qui i due numeri tornano a coincidere con `totale_occorrenze` (1437)
 * e con la lunghezza dell'elenco (278). Non è un giudizio sul merito di quelle tredici: è la
 * loro MISURA, e la rifà chiunque con
 * `jq '.totale_occorrenze, (.file | length)' docs/superpowers/errori-senza-codice-allowlist.json`.
 *
 * 2026-09-01 · −1 (1437 → 1436), e il debito è stato PAGATO, non spostato. Il rifiuto della
 * password in `parent/onboarding:POST` era una risposta sola, scritta senza codice apposta
 * «per non far crescere il conteggio»: la schermata che la riceve passa da
 * `soloCatalogoDaCorpo`, quindi il genitore leggeva «Operazione non riuscita» davanti a una
 * password lunga nove caratteri. Ora sono QUATTRO risposte — una per motivo, ciascuna con il
 * suo `codice` letterale — e il conteggio scende lo stesso, perché le risposte CON codice non
 * sono debito: sono la sua estinzione. `MAX_FILE` non si muove, il file resta in elenco con
 * cinque risposte ancora da convertire (misurate, non stimate: dichiararne quattro rende
 * rosso il test qui sotto).
 *
 * 2026-09-04 · −2 (1436 → 1434), e il debito è stato PAGATO. Lo spostamento di sede in
 * `admin/staff:PATCH` ha portato con sé nove controlli `{ error }` di PostgREST in più: scritti
 * a mano sarebbero state nove risposte nuove senza codice, dentro un file già in elenco. Passano
 * tutte da un `erroreDb(operazione, evento, error)` locale — una risposta sola, un `logErrore`
 * solo, e l'`evento` che dice QUALE lettura o scrittura è stata respinta. Il file scende da 7 a
 * 5: restano i due `Internal Server Error` dei `catch`, il 404 «Utente non trovato» e il 403 del
 * self-lockout. `MAX_FILE` non si muove: la voce resta in elenco, non è arrivata a zero.
 *
 * 2026-09-04 · −1 (1434 → 1433). `pagamenti/riconciliazione:POST` impara a ricevere il file
 * della banca com'è (.xls/.xlsx/.csv, in multipart) e nasce con QUATTRO risposte nuove — file
 * assente, tipo non ammesso, oltre il tetto, illeggibile — tutte e quattro CON codice: non
 * entrano nel conteggio, perché una risposta con codice non è debito. In più è stata convertita
 * quella che c'era già («Nessun accredito riconosciuto») → `ESTRATTO_CONTO_SENZA_ACCREDITI`, e
 * il file scende da 9 a 8: restano i sei 500/503 di PostgREST e i due `Internal Server Error`
 * dei `catch`. `MAX_FILE` non si muove: la voce resta in elenco.
 */
const MAX_FILE = 278;
const MAX_OCCORRENZE = 1433;

/**
 * Le frasi RITIRATE il 2026-08-01: le sei versioni scritte a mano dello stesso rifiuto. Non
 * possono tornare in nessun corpo d'errore, con o senza codice — tre di loro nominano una
 * colonna del database, e tutte e sei dicevano cose diverse per la stessa cosa.
 */
const FRASI_RITIRATE = [
    'Sede non consentita',
    'Specificare la sede (scuola_id)',
    'Specificare la sede (scuola_id) per questa operazione',
    'Specificare la sede (scuola_id o sectionId): il nome della classe non la identifica',
    'Specificare la sede: più classi con questo nome (usare section_id)',
];

/**
 * I punti in cui i due dinieghi di sede NASCONO. Sono l'unica fonte consentita della frase, e
 * qui il lock pretende il contrario di altrove: che `rifiutoSede` ci sia davvero. Senza questo
 * controllo positivo, il test resterebbe verde anche se qualcuno cancellasse le chiamate — cioè
 * proprio nel caso in cui il difetto è tornato.
 */
const SORGENTI_DEL_RIFIUTO = [
    'src/lib/auth/scope.ts',
    'src/lib/auth/sede-richiesta.ts',
    'src/lib/mensa/scope.ts',
];

/**
 * L'UNICO `codice` non letterale ammesso, `file → espressione`.
 *
 * `rifiutoSede(codice)` costruisce la risposta a partire dal suo PARAMETRO: lì il
 * valore non c'è per definizione, e pretenderlo letterale vorrebbe dire tornare a
 * scrivere il rifiuto a mano in 137 route — cioè disfare la correzione del
 * 2026-08-01. L'esenzione regge solo perché quel codice è controllato dall'ALTRA
 * strada: `codiciUsati()` legge gli argomenti di ogni `rifiutoSede('X')` in `src/`,
 * e il test qui sotto verifica che quella strada porti davvero a casa qualcosa —
 * un'esenzione la cui copertura alternativa non funziona è un buco con un nome.
 *
 * L'elenco può solo rimpicciolirsi: una funzione nuova che riceve un codice da
 * fuori va aggiunta all'analisi, non a questa mappa.
 */
const CODICE_NON_LETTERALE_AMMESSO = new Map<string, string>([
    ['src/lib/auth/rifiuto-sede.ts', 'codice'],
]);

/* ────────────────────────────────────────────────────────────────────────────────
 * LA MISURA. Testuale, come nel lock sui catch muti e per lo stesso motivo: far girare un
 * parser vero su 285 file costa più del gate intero.
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

/** Il PRIMO argomento (oggetto letterale) di ogni `NextResponse.json(`, a parentesi bilanciate. */
function corpiJson(src: string): { testo: string; riga: number }[] {
    const out: { testo: string; riga: number }[] = [];
    const re = /NextResponse\.json\(\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const i = m.index + m[0].length;
        if (src[i] !== '{') continue;
        let liv = 0;
        let j = i;
        for (; j < src.length; j++) {
            const c = src[j];
            if (c === '{') liv++;
            else if (c === '}') { liv--; if (liv === 0) { j++; break; } }
            else if (c === '"' || c === "'" || c === '`') {
                const a = c;
                j++;
                while (j < src.length && src[j] !== a) { if (src[j] === '\\') j++; j++; }
            }
        }
        out.push({ testo: src.slice(i, j), riga: src.slice(0, i).split('\n').length });
    }
    return out;
}

/**
 * Il valore di un `const NOME = '…'` di PRIMO livello nel file, se esiste.
 *
 * Serve a leggere `codice: UNA_COSTANTE`, che è il modo in cui questo repo scrive
 * un codice quando lo manda da due punti dello stesso file. Senza, il lock vedeva
 * `null` e smetteva di controllare (vedi il test «un `codice` che non è una
 * stringa letterale»). Deliberatamente ingenuo: risolve SOLO la forma
 * `const X = 'letterale'` nello stesso file, e su tutto il resto risponde `null`,
 * che qui vale «non lo so» — e «non lo so» fa fermare il lock, non tacere.
 */
function costanteLetterale(sorgente: string, nome: string): string | null {
    if (!/^[A-Za-z_$][\w$]*$/.test(nome)) return null;
    const re = new RegExp(
        `(?:^|\\n)\\s*(?:export\\s+)?const\\s+${nome}\\s*(?::\\s*[^=\\n]+)?=\\s*` +
            `(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")\\s*(?:as\\s+const\\s*)?[;\\n]`,
    );
    const m = re.exec(sorgente);
    if (!m) return null;
    return (m[1] ?? m[2] ?? '').replace(/\\'/g, "'").replace(/\\"/g, '"');
}

/**
 * Le proprietà di PRIMO livello di un oggetto letterale: nome, valore se è un
 * letterale, ed espressione GREZZA — che serve a risolvere `codice: UNA_COSTANTE`.
 */
function proprieta(obj: string): { nome: string; valore: string | null; grezzo: string | null }[] {
    const dentro = obj.slice(1, -1);
    const pezzi: string[] = [];
    let liv = 0;
    let buf = '';
    for (let i = 0; i < dentro.length; i++) {
        const c = dentro[i];
        if (c === '{' || c === '[' || c === '(') liv++;
        else if (c === '}' || c === ']' || c === ')') liv--;
        else if (c === '"' || c === "'" || c === '`') {
            const a = c;
            buf += c;
            i++;
            while (i < dentro.length && dentro[i] !== a) { if (dentro[i] === '\\') { buf += dentro[i]; i++; } buf += dentro[i]; i++; }
            buf += a;
            continue;
        }
        if (c === ',' && liv === 0) { pezzi.push(buf); buf = ''; continue; }
        buf += c;
    }
    pezzi.push(buf);
    const out: { nome: string; valore: string | null; grezzo: string | null }[] = [];
    for (const p of pezzi) {
        const conValore = p.match(/^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/);
        if (conValore) {
            const grezzo = conValore[2].trim();
            const lett = grezzo.match(/^'((?:[^'\\]|\\.)*)'$|^"((?:[^"\\]|\\.)*)"$/);
            const valore = lett ? (lett[1] ?? lett[2]).replace(/\\'/g, "'").replace(/\\"/g, '"') : null;
            out.push({ nome: conValore[1], valore, grezzo });
            continue;
        }
        // Scorciatoia (`{ error, codice }`): l'espressione È il nome stesso.
        const shorthand = p.match(/^\s*([A-Za-z_$][\w$]*)\s*$/);
        if (shorthand) out.push({ nome: shorthand[1], valore: null, grezzo: shorthand[1] });
    }
    return out;
}

type Errore = {
    file: string;
    riga: number;
    testo: string | null;
    conCodice: boolean;
    /** Il codice: letterale, oppure risolto da un `const X = '…'` dello stesso file. */
    codice: string | null;
    /**
     * L'espressione del `codice` quando NON si è potuta leggere (una chiamata, un
     * campo di un oggetto, una costante importata da altrove). Valorizzata, dice
     * che c'è un codice che nessuna regola di questo file sta controllando.
     */
    codiceOpaco: string | null;
};

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

/** Tutte le risposte JSON che portano un `error` all'utente, con e senza `codice`. */
function inventario(): Errore[] {
    const out: Errore[] = [];
    for (const f of sorgenti()) {
        const src = mascheraCommenti(fs.readFileSync(path.join(RADICE, f), 'utf8'));
        for (const corpo of corpiJson(src)) {
            const props = proprieta(corpo.testo);
            const err = props.find((p) => p.nome === 'error');
            if (!err) continue;
            const cod = props.find((p) => p.nome === 'codice');
            // `codice: UNA_COSTANTE` si risolve nel file; ciò che resta illeggibile
            // NON diventa `null` in silenzio (era il buco: un valore che il lettore
            // non capisce smetteva di essere confrontato con qualunque cosa).
            let codice = cod?.valore ?? null;
            let codiceOpaco: string | null = null;
            if (cod && codice === null) {
                codice = costanteLetterale(src, cod.grezzo ?? '');
                if (codice === null) codiceOpaco = cod.grezzo ?? '(illeggibile)';
            }
            out.push({
                file: f,
                riga: corpo.riga,
                testo: err.valore,
                conCodice: Boolean(cod),
                codice,
                codiceOpaco,
            });
        }
    }
    return out;
}

/**
 * I codici che escono davvero verso il client: quelli scritti dentro un corpo che porta
 * `error`, più gli argomenti di `rifiutoSede('X')`.
 *
 * NON si cerca `codice:` in tutto il file: `codice` è una parola comune e in
 * `src/lib/competenze/modello.ts` sono i livelli di competenza («A», «B», «C», «D»). Un lock
 * che li segnalasse come codici d'errore non dichiarati sarebbe rosso su una cosa giusta —
 * ed è così che si impara a spegnerlo.
 */
function codiciUsati(): { file: string; codice: string }[] {
    const out: { file: string; codice: string }[] = [];
    for (const e of inventario()) {
        if (e.codice) out.push({ file: `${e.file}:${e.riga}`, codice: e.codice });
    }
    for (const f of sorgenti()) {
        const src = mascheraCommenti(fs.readFileSync(path.join(RADICE, f), 'utf8'));
        for (const m of src.matchAll(/rifiutoSede\(\s*'([A-Z0-9_]+)'\s*\)/g)) out.push({ file: f, codice: m[1] });
    }
    return out;
}

type Voce = { path: string; n: number };
type Allowlist = { totale_occorrenze: number; file: Voce[] };

function leggiAllowlist(): Allowlist {
    return JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) as Allowlist;
}

// NB: non chiamarli `it`/`en` — `it` è la funzione di vitest.
const catIt = itShared as Record<string, string>;
const catEn = enShared as Record<string, string>;

describe('lock — i messaggi d’errore del server hanno un codice', () => {
    it('la misura vede davvero i corpi d’errore (controllo positivo del parser)', () => {
        // Senza questo, un parser rotto renderebbe VERDI tutte le regole qui sotto:
        // «zero corpi trovati» e «zero violazioni» hanno lo stesso colore.
        const tutti = inventario();
        expect(tutti.length).toBeGreaterThan(1000);

        const noti = tutti.filter((e) => e.file === 'src/lib/auth/rifiuto-sede.ts');
        expect(noti, 'il costruttore dei dinieghi di sede non è più visto dalla misura').toHaveLength(1);
        expect(noti[0].conCodice, 'il corpo di `rifiutoSede` non risulta portare `codice`').toBe(true);
    });

    it('ogni codice usato in src/ è DICHIARATO e tradotto in entrambe le lingue', () => {
        const dichiarati = CODICI_ERRORE as Record<string, string>;
        const sconosciuti = codiciUsati()
            .filter((u) => !dichiarati[u.codice])
            .map((u) => `${u.file}: ${u.codice}`);

        expect(
            sconosciuti,
            'Codice mandato al client ma non dichiarato in CODICI_ERRORE (src/lib/ui/esito-fetch.ts). ' +
                'Il client non sa tradurlo: a schermo ricade sulla prosa italiana, cioè esattamente il ' +
                'difetto che il codice doveva chiudere.',
        ).toEqual([]);

        const senzaTraduzione: string[] = [];
        for (const [codice, chiave] of Object.entries(dichiarati)) {
            if (!catIt[chiave]?.trim()) senzaTraduzione.push(`${codice} → messages/it/shared.json:${chiave}`);
            if (!catEn[chiave]?.trim()) senzaTraduzione.push(`${codice} → messages/en/shared.json:${chiave}`);
        }
        expect(
            senzaTraduzione,
            'Codice dichiarato ma senza voce di catalogo: in quella lingua l’utente leggerebbe la prosa ' +
                'italiana del server.',
        ).toEqual([]);
    });

    it('un `codice` che il lock non sa LEGGERE non passa inosservato', () => {
        // IL BUCO, misurato il 2026-08-03 sulla strada accanto alla trappola del
        // codice RIUSATO che questo ciclo ha appena chiuso. `inventario()` leggeva
        // `codice` solo quando era una stringa letterale: con `codice: UNA_COSTANTE`
        // il valore era `null` e da lì in poi non veniva confrontato con niente —
        // né con `CODICI_ERRORE`, né coi due cataloghi. Un codice inventato, o
        // riusato, o scritto male, passava il lock qualunque cosa contenesse: la
        // regola qui sopra («ogni codice usato è dichiarato e tradotto») era verde
        // per il motivo peggiore, cioè perché non guardava.
        //
        // Adesso la costante si RISOLVE quando è un `const X = '…'` dello stesso
        // file, e ciò che resta illeggibile ferma il lock invece di farlo tacere.
        // Un valore che il lock non sa leggere è un valore che nessuno controlla.
        const opachi = inventario()
            .filter((e) => e.codiceOpaco && CODICE_NON_LETTERALE_AMMESSO.get(e.file) !== e.codiceOpaco)
            .map((e) => `${e.file}:${e.riga} → codice: ${e.codiceOpaco}`);

        expect(
            opachi,
            'Il `codice` di questa risposta non è una stringa letterale e non è un `const X = \'…\'` ' +
                'dello stesso file: il lock non può verificare che sia dichiarato in CODICI_ERRORE né ' +
                'che sia tradotto nelle due lingue. Scrivilo come letterale, o come costante locale.',
        ).toEqual([]);

        // L'UNICA esenzione regge solo se la sua copertura alternativa funziona:
        // i due codici di sede devono arrivare all'inventario dagli argomenti di
        // `rifiutoSede('X')`. Se quella lettura si rompesse, l'esenzione qui sopra
        // diventerebbe silenzio puro.
        const daRifiutoSede = codiciUsati()
            .filter((u) => u.file !== 'src/lib/auth/rifiuto-sede.ts')
            .map((u) => u.codice);
        for (const atteso of ['SEDE_NON_ACCESSIBILE', 'SEDE_DA_SPECIFICARE']) {
            expect(
                daRifiutoSede,
                `il codice ${atteso} non risulta più usato da nessuna parte: l’esenzione di ` +
                    '`rifiutoSede` non è più coperta da niente',
            ).toContain(atteso);
        }
    });

    it('la lettura delle costanti FUNZIONA (controllo positivo del lettore)', () => {
        // Senza questo, la regola qui sopra sarebbe verde anche con un lettore che
        // «risolve» qualunque cosa: dichiarerebbe letto ogni codice senza leggerne
        // nemmeno uno, ed è esattamente la forma di test finto che questo ciclo sta
        // togliendo di mezzo.
        const finto = [
            "const CODICE_X = 'SEDE_NON_ACCESSIBILE'",
            'export const CODICE_Y: string = "TROPPE_RICHIESTE";',
            'const CODICE_Z = calcola()',
        ].join('\n');

        expect(costanteLetterale(finto, 'CODICE_X')).toBe('SEDE_NON_ACCESSIBILE');
        expect(costanteLetterale(finto, 'CODICE_Y')).toBe('TROPPE_RICHIESTE');
        expect(costanteLetterale(finto, 'CODICE_Z'), 'una chiamata non è un valore leggibile').toBeNull();
        expect(costanteLetterale(finto, 'CODICE_MAI_DICHIARATO')).toBeNull();
    });

    it('i dinieghi di sede NASCONO da `rifiutoSede`, e ci nascono ancora (controllo positivo)', () => {
        const senza = SORGENTI_DEL_RIFIUTO.filter((p) => {
            expect(fs.existsSync(path.join(RADICE, p)), `sparito: ${p}`).toBe(true);
            return !/rifiutoSede\(/.test(fs.readFileSync(path.join(RADICE, p), 'utf8'));
        });
        expect(
            senza,
            'Questi moduli decidono i due dinieghi di sede per 137 route: se non passano più da ' +
                '`rifiutoSede`, il codice non parte e l’interfaccia inglese torna a mostrare l’italiano.',
        ).toEqual([]);
    });

    it('la frase di un codice non viaggia mai SENZA il suo codice', () => {
        const frasiTradotte = new Map<string, string>();
        for (const [codice, chiave] of Object.entries(CODICI_ERRORE as Record<string, string>)) {
            if (catIt[chiave]) frasiTradotte.set(catIt[chiave], codice);
        }

        const orfane = inventario()
            .filter((e) => !e.conCodice && e.testo !== null && frasiTradotte.has(e.testo))
            .map((e) => `${e.file}:${e.riga} → «${e.testo}» (codice ${frasiTradotte.get(e.testo!)})`);

        expect(
            orfane,
            'Questa frase HA un codice: usa `rifiutoSede(...)` (src/lib/auth/rifiuto-sede.ts) invece di ' +
                'riscriverla a mano. Scritta a mano viaggia senza codice, e per chi lavora in inglese ' +
                'torna a essere italiano — che è il fallimento F1 del collaudo del 2026-07-31.',
        ).toEqual([]);
    });

    it('le sei frasi ritirate non tornano, e nessun messaggio nomina `scuola_id`', () => {
        const tutti = inventario();

        const tornate = tutti
            .filter((e) => e.testo !== null && FRASI_RITIRATE.includes(e.testo))
            .map((e) => `${e.file}:${e.riga} → «${e.testo}»`);
        expect(
            tornate,
            'Frase ritirata il 2026-08-01: erano sei modi diversi di dire lo stesso rifiuto. Ora se ne ' +
                'dice uno solo, e lo costruisce `rifiutoSede(...)`.',
        ).toEqual([]);

        const conColonna = tutti
            .filter((e) => e.testo !== null && /scuola_id/.test(e.testo))
            .map((e) => `${e.file}:${e.riga} → «${e.testo}»`);
        expect(
            conColonna,
            'Un messaggio mostrato all’utente nomina una colonna del database. Il nome del campo serve a ' +
                'chi legge i log, e nel log ci deve restare: a una segretaria non dice niente, e racconta ' +
                'a chiunque com’è fatto lo schema.',
        ).toEqual([]);

        // ⚠️ E il testo va inseguito DOVE SI È SPOSTATO. Con la correzione del
        // 2026-08-01 la frase di un codice non sta più nel sorgente ma nel
        // catalogo: guardare solo i letterali di `src/` lascerebbe rientrare
        // `scuola_id` da `messages/`, con questa regola verde. Verificato
        // rimettendo il difetto: senza le due righe qui sotto il lock taceva.
        const catalogo: string[] = [];
        for (const [codice, chiave] of Object.entries(CODICI_ERRORE as Record<string, string>)) {
            for (const [lingua, cat] of [['it', catIt], ['en', catEn]] as const) {
                const testo = cat[chiave];
                if (testo && /scuola_id|section_id|sectionId/.test(testo)) {
                    catalogo.push(`messages/${lingua}/shared.json:${chiave} (${codice}) → «${testo}»`);
                }
            }
        }
        expect(
            catalogo,
            'La voce di catalogo di un codice d’errore nomina una colonna del database: è la stessa ' +
                'cosa di prima, spostata di un file. Il nome del campo vive nel log ' +
                '(`sede-scrittura-ambigua`), non davanti a chi lavora in segreteria.',
        ).toEqual([]);
    });

    it('l’allowlist del debito esiste, è ben formata e non ha doppioni', () => {
        expect(
            fs.existsSync(ALLOWLIST),
            'Manca docs/superpowers/errori-senza-codice-allowlist.json: è l’inventario delle risposte ' +
                'd’errore ancora senza codice. Senza, o il lock è rosso su 1478 punti legacy, o non esiste.',
        ).toBe(true);

        const a = leggiAllowlist();
        expect(Array.isArray(a.file)).toBe(true);
        for (const v of a.file) {
            expect(typeof v.path, `voce senza path: ${JSON.stringify(v)}`).toBe('string');
            expect(Number.isInteger(v.n) && v.n > 0, `voce con n non valido: ${v.path}`).toBe(true);
            expect(v.path.startsWith('src/'), `path fuori da src/: ${v.path}`).toBe(true);
        }
        const doppi = a.file.map((v) => v.path).filter((p, i, arr) => arr.indexOf(p) !== i);
        expect(doppi, 'stesso file due volte: il conteggio non sarebbe più leggibile').toEqual([]);
        expect(
            a.totale_occorrenze,
            `Il totale in testa al file dice ${a.totale_occorrenze}, la somma delle voci fa ` +
                `${a.file.reduce((s, v) => s + v.n, 0)}.`,
        ).toBe(a.file.reduce((s, v) => s + v.n, 0));
    });

    it('nessuna risposta d’errore SENZA codice fuori dall’allowlist, e in elenco nessuna in più', () => {
        const a = leggiAllowlist();
        const tetto = new Map(a.file.map((v) => [v.path, v.n]));

        const misurato = new Map<string, number>();
        for (const e of inventario()) {
            if (e.conCodice) continue;
            misurato.set(e.file, (misurato.get(e.file) ?? 0) + 1);
        }

        const nuovi = [...misurato.entries()]
            .filter(([f]) => !tetto.has(f))
            .map(([f, n]) => `${f} (${n})`);
        expect(
            nuovi,
            'Risposta d’errore senza `codice` in un file NON in allowlist. Non aggiungerlo all’elenco: ' +
                'l’elenco può solo rimpicciolirsi. Dichiara un codice in CODICI_ERRORE ' +
                '(src/lib/ui/esito-fetch.ts), mettilo nei due cataloghi e mandalo accanto a `error`. ' +
                'Un messaggio senza codice è un messaggio che l’utente inglese legge in italiano.',
        ).toEqual([]);

        const cresciuti = [...misurato.entries()]
            .filter(([f, n]) => tetto.has(f) && n > (tetto.get(f) as number))
            .map(([f, n]) => `${f}: dichiarate ${tetto.get(f)}, misurate ${n}`);
        expect(
            cresciuti,
            'In questi file le risposte d’errore senza codice sono AUMENTATE. Il debito è congelato al ' +
                '2026-08-01: si può solo pagare.',
        ).toEqual([]);

        const scomparsi = a.file
            .filter((v) => !fs.existsSync(path.join(RADICE, v.path)))
            .map((v) => v.path);
        expect(
            scomparsi,
            'File in allowlist che non esistono più: togli la voce. Una riga che non corrisponde a niente ' +
                'fa sembrare il debito più grande di quello che è.',
        ).toEqual([]);
    });

    it('l’allowlist può solo rimpicciolirsi (tetti monotoni decrescenti)', () => {
        const a = leggiAllowlist();
        expect(
            a.file.length,
            `L’allowlist è cresciuta a ${a.file.length} file (tetto ${MAX_FILE}). Alzare il tetto non è la ` +
                'risposta: è la mossa che ha lasciato arrivare la categoria a 452 messaggi distinti.',
        ).toBeLessThanOrEqual(MAX_FILE);
        expect(
            a.file.reduce((s, v) => s + v.n, 0),
            `L’allowlist dichiara ${a.file.reduce((s, v) => s + v.n, 0)} risposte senza codice (tetto ${MAX_OCCORRENZE}).`,
        ).toBeLessThanOrEqual(MAX_OCCORRENZE);
    });
});
