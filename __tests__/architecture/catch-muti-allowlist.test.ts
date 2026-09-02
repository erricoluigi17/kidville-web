import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock sui CATCH MUTI — la difesa che impedisce alla categoria di ricrescere.
 *
 * LA STORIA. AGENTS.md regola 6 vieta il `catch` che non logga da quando esiste il documento,
 * eppure al collaudo del 2026-07-31 il repo ne conteneva 87: `.catch(() => {})` e `catch {}`
 * sparsi quasi tutti sulle fetch delle pagine di dashboard e dei componenti feature — cioè
 * esattamente il canale su cui un genitore vede «la pagina non si riempie» e l'assistenza non
 * ha niente da leggere. Nessuno di loro era nuovo: la disciplina di chi scriveva aveva retto,
 * il debito no. Ed è normale che sia andata così: **la regola 6 non aveva un lock**, viveva
 * solo nella buona volontà, e una regola senza gate non è una regola, è un auspicio.
 *
 * COME È FATTA LA DIFESA. Due pezzi che si coprono a vicenda, di proposito:
 *
 *  1. **ESLint** (`no-restricted-syntax` in `eslint.config.mjs`) vieta il pattern in TUTTO
 *     `src/`, tranne che nei file elencati nell'allowlist qui sotto. È ciò che ferma il catch
 *     muto in un file NUOVO, prima ancora del commit.
 *  2. **Questo test** conta le occorrenze dei file in allowlist e pretende che il numero
 *     COMBACI. È ciò che ferma il catch muto in un file VECCHIO — dove ESLint, per forza di
 *     cose, tace. E pretende che una voce bonificata venga tolta: l'allowlist può solo
 *     rimpicciolirsi, e i due tetti costanti qui sotto scendono con lei.
 *
 * Senza (1) il debito ricresce nei file nuovi; senza (2) i 53 file esentati diventerebbero un
 * porto franco. Nessuno dei due da solo basta.
 *
 * PERCHÉ IL CONTEGGIO E NON LA RIGA. Le righe si spostano a ogni modifica sopra di loro: un
 * lock sui numeri di riga sarebbe rosso per motivi che non c'entrano niente, e un lock che
 * suona a vuoto è un lock che si impara a spegnere. Il conteggio si muove solo quando si
 * aggiunge o si toglie un catch muto — che è esattamente l'evento da sorvegliare.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');
const ALLOWLIST = path.join(RADICE, 'docs/superpowers/catch-muti-allowlist.json');

/**
 * L'UNICA deroga, la stessa che vale per `no-console`: `src/lib/logging/**` è il logger, e il
 * suo fail-open è VOLUTO e documentato (regola 9: «il logger non deve mai rompere l'app»).
 * Un `.catch(() => {})` lì dentro è la scelta giusta — loggare il fallimento del logging con
 * il logging è il modo più diretto di costruire un ciclo infinito. Non sta in allowlist
 * perché non è debito da smaltire: è un'esenzione permanente, e vive nella config.
 */
const ESENTE = 'src/lib/logging/';

/**
 * TETTI MONOTONI DECRESCENTI. Sono la misura del 2026-08-01, dopo la bonifica dei 5 percorsi
 * che contavano. Si abbassano, mai si alzano: chi bonifica un file toglie la voce e porta giù
 * il numero. Chi si trovasse a doverli ALZARE sta aggiungendo un catch muto, ed è quello il
 * momento di fermarsi, non dopo.
 */
const MAX_FILE = 52;
const MAX_OCCORRENZE = 82;

/**
 * I percorsi bonificati in questo ciclo, che NON possono tornare in allowlist. Non è un
 * elenco a caso: `regenerate-credentials` è il percorso delle EMAIL DI CREDENZIALI, cioè il
 * difetto storico da cui nasce l'intera regola 6 (per mesi nessuna credenziale arrivò a
 * destinazione, il provider rispondeva 403 e il codice registrava solo il numero); gli altri
 * due sono le pagine di anagrafica e di ricarica ticket, dove il fallimento muto di una fetch
 * si presenta all'operatore come «l'elenco è vuoto» — indistinguibile da «non c'è nessuno».
 *
 * AGGIUNTO IL 2026-08-04 — `NativePushAutoRegister.tsx`, e vale la pena dire cosa è costato.
 * Il suo `.catch(() => {})` inghiottiva l'ESITO della registrazione push nativa. Quel giorno
 * l'app girava su un iPhone vero, installata da TestFlight: in `push_subscriptions` non
 * c'era NESSUNA riga `ios`, e del tentativo non restava traccia da nessuna parte — non si
 * poteva distinguere «l'utente ha detto no» da «il plugin è esploso» da «non è mai partito
 * niente». Il file ha per giunta un `attempted` di modulo che rende il tentativo UNICO per
 * sessione: il catch muto non perdeva un errore fra tanti, perdeva l'unico che ci fosse.
 *
 * TOLTO IL 2026-08-11 — `AdultRegistryForm.tsx` era entrato qui il giorno prima, e il giorno
 * dopo il file non esiste più: cancellato insieme a `POST /api/admin/adults`, la rotta
 * irraggiungibile e rotta che serviva. Una voce che punta a un percorso inesistente farebbe
 * cadere il controllo POSITIVO qui sotto (`fs.existsSync`), che è esattamente ciò che deve
 * fare: questo elenco parla di file vivi e bonificati, non di file scomparsi.
 *
 * AGGIUNTO IL 2026-09-01 — `teacher/modulistica/page.tsx`, bonificata riscrivendola per la
 * barra filtri. Il suo unico `.catch(() => {})` stava sulla lettura delle SEZIONI del docente
 * (`/api/educator-sections`), ed è il caso peggiore della categoria: senza sezioni la pagina
 * non sa quale classe mostrare, quindi resta ferma sullo spinner — e uno spinner eterno è
 * indistinguibile da «questo docente non ha sezioni». Ora quel ramo logga, e la voce esce
 * dall'allowlist: se restasse, ESLint continuerebbe a tacere sul file e il prossimo catch
 * muto ci rientrerebbe senza che nessuno se ne accorga.
 */
const MAI_PIU_IN_ALLOWLIST = [
    'src/app/api/admin/regenerate-credentials/route.ts',
    'src/app/(dashboard)/admin/students/page.tsx',
    'src/components/features/admin/pagamenti/TicketMensaPanel.tsx',
    'src/components/providers/NativePushAutoRegister.tsx',
    'src/app/(dashboard)/teacher/modulistica/page.tsx',
];

/* ────────────────────────────────────────────────────────────────────────────────
 * LA MISURA, e perché non è semplicemente «fai girare ESLint».
 *
 * Far girare ESLint dentro il test sarebbe la cosa più ovvia — una sola definizione di
 * «catch muto», zero possibilità di divergenza. È stato provato: 70 secondi. Su un gate che
 * ESLint lo lancia già per conto suo, sarebbe un minuto e dieci pagato due volte a ogni run,
 * ed è il genere di costo che porta la gente a lanciare i test «solo prima del push».
 *
 * Quindi la misura è testuale, ed è stata VERIFICATA file per file contro l'output vero di
 * ESLint: coincidono su tutti e 56 i file che ESLint vede. Le uniche due differenze sono in
 * `src/app/offline/*`, e vanno nella direzione innocua: sono `catch(e){}` dentro le stringhe
 * ES5 dello script inline che il Service Worker serve quando la rete non c'è. Per ESLint è
 * testo; per il browser di un genitore in metropolitana è codice che gira davvero, e quando
 * muore muore in silenzio come tutti gli altri. Il test li conta, ESLint no.
 *
 * Le due passate esistono perché ESLint tratta i commenti in modo DIVERSO nei due casi, e la
 * misura deve seguirlo per non diventare rossa dove lui è verde (o viceversa):
 *  · `no-empty` IGNORA i blocchi che contengono un commento → per le CLAUSOLE `catch {}` i
 *    commenti devono restare visibili (maschera `§`, che non è spazio);
 *  · `no-restricted-syntax` lavora sull'AST, dove i commenti non esistono → per gli HANDLER
 *    `.catch(() => { /* … *\/ })` i commenti devono sparire (maschera con spazi).
 * ──────────────────────────────────────────────────────────────────────────────── */

/**
 * Sostituisce i commenti con `riempi`, lasciando INTATTE le stringhe (è così che si contano i
 * catch di `/offline`) e i ritorni a capo (è così che i numeri di riga restano quelli veri).
 *
 * Con `§` una riga di commento che *cita* `.catch(() => {})` — e in questo repo ce ne sono
 * quattro, tutte a spiegare perché il catch muto è stato tolto — resta non-vuota e non
 * inquina il conteggio. Con `' '` sparisce, che è quello che serve per gli handler.
 */
function mascheraCommenti(sorgente: string, riempi: string): string {
    let out = '';
    let i = 0;
    let stato: 'code' | 'riga' | 'blocco' | 'str' = 'code';
    let apice = '';
    while (i < sorgente.length) {
        const c = sorgente[i];
        const d = sorgente[i + 1];
        if (stato === 'code') {
            if (c === '/' && d === '/') { stato = 'riga'; out += riempi + riempi; i += 2; continue; }
            if (c === '/' && d === '*') { stato = 'blocco'; out += riempi + riempi; i += 2; continue; }
            if (c === '"' || c === "'" || c === '`') { stato = 'str'; apice = c; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (stato === 'riga') {
            if (c === '\n') { stato = 'code'; out += '\n'; } else out += riempi;
            i++; continue;
        }
        if (stato === 'blocco') {
            if (c === '*' && d === '/') { stato = 'code'; out += riempi + riempi; i += 2; continue; }
            out += c === '\n' ? '\n' : riempi; i++; continue;
        }
        // stato === 'str'
        if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
        if (c === apice) stato = 'code';
        out += c; i++;
    }
    return out;
}

/** `catch {}` e `catch (e) {}` — la clausola che non dice niente. Gemella di `no-empty`. */
const CLAUSOLA_MUTA = /\bcatch\s*(?:\(\s*[A-Za-z_$][\w$]*\s*\))?\s*\{\s*\}/g;

/**
 * `.catch(() => {})`, `.catch(e => {})`, `.catch(function () {})` — l'handler c'è e non fa
 * niente. Gemello del selettore `no-restricted-syntax` della config.
 */
const HANDLER_MUTO = new RegExp(
    [
        String.raw`\.catch\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\)`,
        String.raw`\.catch\s*\(\s*(?:async\s+)?function\s*[\w$]*\s*\([^)]*\)\s*\{\s*\}\s*\)`,
    ].join('|'),
    'g',
);

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

/** Quante volte quel file tace. `0` significa bonificato. */
function quantiMuti(rel: string): number {
    const sorgente = fs.readFileSync(path.join(RADICE, rel), 'utf8');
    CLAUSOLA_MUTA.lastIndex = 0;
    HANDLER_MUTO.lastIndex = 0;
    const clausole = (mascheraCommenti(sorgente, '§').match(CLAUSOLA_MUTA) ?? []).length;
    const handler = (mascheraCommenti(sorgente, ' ').match(HANDLER_MUTO) ?? []).length;
    return clausole + handler;
}

type Voce = { path: string; n: number };
type Allowlist = { totale_occorrenze: number; file: Voce[] };

function leggiAllowlist(): Allowlist {
    return JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) as Allowlist;
}

describe('lock — catch muti (AGENTS.md regola 6)', () => {
    it('l’allowlist esiste, è ben formata e non ha doppioni', () => {
        expect(
            fs.existsSync(ALLOWLIST),
            'Manca docs/superpowers/catch-muti-allowlist.json. È il file che `eslint.config.mjs` ' +
                'legge per sapere dove la regola sui catch muti è ancora spenta: senza, o il gate ' +
                'è rosso su 84 punti legacy, o la regola non esiste affatto.',
        ).toBe(true);

        const a = leggiAllowlist();
        expect(Array.isArray(a.file)).toBe(true);
        for (const v of a.file) {
            expect(typeof v.path, `voce senza path: ${JSON.stringify(v)}`).toBe('string');
            expect(Number.isInteger(v.n) && v.n > 0, `voce con n non valido: ${v.path}`).toBe(true);
            expect(v.path.startsWith('src/'), `path fuori da src/: ${v.path}`).toBe(true);
        }
        const doppi = a.file.map((v) => v.path).filter((p, i, arr) => arr.indexOf(p) !== i);
        expect(doppi, 'stesso file due volte in allowlist: il conteggio non sarebbe più leggibile').toEqual([]);
    });

    it('ogni voce dell’allowlist esiste ancora e ha ESATTAMENTE il numero dichiarato', () => {
        const a = leggiAllowlist();
        const scomparsi: string[] = [];
        const bonificati: string[] = [];
        const cresciuti: string[] = [];

        for (const v of a.file) {
            if (!fs.existsSync(path.join(RADICE, v.path))) { scomparsi.push(v.path); continue; }
            const misurato = quantiMuti(v.path);
            if (misurato === 0) { bonificati.push(v.path); continue; }
            if (misurato !== v.n) {
                cresciuti.push(`${v.path}: dichiarati ${v.n}, misurati ${misurato} → scrivi "n": ${misurato}`);
            }
        }

        expect(
            scomparsi,
            'File in allowlist che non esistono più: togli la voce. Una riga che non corrisponde ' +
                'a niente fa sembrare il debito più grande di quello che è, e fa perdere tempo a ' +
                'chi lo smaltisce.',
        ).toEqual([]);

        expect(
            bonificati,
            'Questi file NON hanno più catch muti: ottimo lavoro, ora togli la voce dall’allowlist ' +
                'e abbassa MAX_FILE/MAX_OCCORRENZE qui sopra. Se la voce resta, ESLint continua a ' +
                'tacere su quel file e il prossimo catch muto ci rientra senza che nessuno se ne ' +
                'accorga — cioè si riapre esattamente il buco che questo lock è nato per chiudere.',
        ).toEqual([]);

        expect(
            cresciuti,
            'In questi file il numero di catch muti NON combacia con l’allowlist. Se è SALITO: ' +
                'ne hai aggiunto uno in un file dove ESLint tace, ed è il caso che questo test ' +
                'esiste per prendere — usa `logClient({livello:"warn",evento:"fetch",…})` nel ' +
                'browser o `logEvento(…)` sul server. Se è SCESO: hai bonificato, aggiorna il ' +
                'numero (e i tetti) invece di lasciare credito non speso.',
        ).toEqual([]);
    });

    it('nessun catch muto FUORI dall’allowlist (l’unica esenzione permanente è il logger)', () => {
        const a = leggiAllowlist();
        const noti = new Set(a.file.map((v) => v.path));
        const nuovi = sorgenti()
            .filter((f) => !f.startsWith(ESENTE) && !noti.has(f))
            .map((f) => ({ f, n: quantiMuti(f) }))
            .filter(({ n }) => n > 0)
            .map(({ f, n }) => `${f} (${n})`);

        expect(
            nuovi,
            'Catch muto in un file NON in allowlist. Non aggiungerlo all’allowlist: l’allowlist ' +
                'può solo rimpicciolirsi. Un errore che non lascia traccia è un guasto che ' +
                'l’assistenza non può nemmeno vedere — «nessun log» non distingue «tutto ok» da ' +
                '«non è mai partito niente», ed è letteralmente l’ambiguità che ha nascosto per ' +
                'mesi il guasto delle email di credenziali.',
        ).toEqual([]);
    });

    it('l’allowlist può solo rimpicciolirsi (tetti monotoni decrescenti)', () => {
        const a = leggiAllowlist();
        const somma = a.file.reduce((s, v) => s + v.n, 0);

        expect(
            a.file.length,
            `L’allowlist è cresciuta a ${a.file.length} file (tetto ${MAX_FILE}). Alzare il tetto ` +
                'non è la risposta: è la mossa che ha lasciato arrivare il debito a 87.',
        ).toBeLessThanOrEqual(MAX_FILE);

        expect(
            somma,
            `L’allowlist dichiara ${somma} catch muti (tetto ${MAX_OCCORRENZE}).`,
        ).toBeLessThanOrEqual(MAX_OCCORRENZE);

        expect(
            a.totale_occorrenze,
            `Il totale in testa al file dice ${a.totale_occorrenze}, la somma delle voci fa ` +
                `${somma}: scrivi "totale_occorrenze": ${somma}. È il numero che legge chi apre ` +
                'il file per sapere quanto debito resta, e deve dire il vero.',
        ).toBe(somma);
    });

    it('il logger non è in allowlist: la sua deroga è permanente e vive nella config', () => {
        const a = leggiAllowlist();
        const intrusi = a.file.map((v) => v.path).filter((p) => p.startsWith(ESENTE));
        expect(
            intrusi,
            'src/lib/logging/** non è debito da smaltire: è il fail-open della regola 9. Sta in ' +
                'eslint.config.mjs, dove il motivo è scritto accanto all’eccezione.',
        ).toEqual([]);
    });

    it('i percorsi bonificati in questo ciclo non possono rientrare', () => {
        const a = leggiAllowlist();
        const noti = new Set(a.file.map((v) => v.path));
        const rientrati = MAI_PIU_IN_ALLOWLIST.filter((p) => noti.has(p));
        expect(
            rientrati,
            'Questi percorsi sono stati bonificati apposta e non tornano in allowlist: ' +
                'credenziali (il difetto storico che ha dato origine alla regola 6), anagrafica ' +
                'alunni, ricarica ticket mensa, registrazione push nativa e modulistica del ' +
                'docente.',
        ).toEqual([]);

        // Controllo POSITIVO, accanto a quello negativo: i tre file esistono davvero e sono
        // puliti sul serio. Senza, il test passerebbe anche se qualcuno li cancellasse.
        for (const p of MAI_PIU_IN_ALLOWLIST) {
            expect(fs.existsSync(path.join(RADICE, p)), `sparito: ${p}`).toBe(true);
            expect(quantiMuti(p), `il catch muto è tornato in ${p}`).toBe(0);
        }
    });

    it('nessuna soppressione inline della regola fuori dal logger', () => {
        // Il giro di fuga più economico: `// eslint-disable-next-line no-restricted-syntax`.
        // È il gemello di `eslint-suppressions.json` — non rompe niente, non avvisa nessuno,
        // e riporta il gate al verde senza correggere una riga.
        const colpevoli = sorgenti()
            .filter((f) => !f.startsWith(ESENTE))
            .filter((f) => {
                const s = fs.readFileSync(path.join(RADICE, f), 'utf8');
                return /eslint-disable[^\n]*no-restricted-syntax/.test(s);
            });

        expect(
            colpevoli,
            'Soppressione inline di `no-restricted-syntax` fuori da src/lib/logging/**. La ' +
                'deroga è ammessa solo lì, e lì la dà la config: non serve scriverla nei file.',
        ).toEqual([]);
    });
});
