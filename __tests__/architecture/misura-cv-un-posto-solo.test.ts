import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock — LA MISURA «QUANTE CANDIDATURE ARRIVANO SENZA CURRICULUM» VIVE IN UN
 * POSTO SOLO.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────
 *
 * Rendere `cv_path` obbligatorio è stata una decisione presa CONTRO un prezzo
 * misurato: le persone che d'ora in poi non potranno inviare il modulo. Il
 * prezzo era la parte importante, quindi è stato scritto accanto alla riga che
 * lo causa — e poi, giro dopo giro, **ribattuto in sedici commenti** fra `src/`
 * e `__tests__/`, perché ogni file che difendeva un pezzo della modifica aveva
 * bisogno di citarlo.
 *
 * Il 2026-08-25 quella cifra era `98 su 234, il 41,9%`. Rimisurata lo stesso
 * giorno alle 19:26 era `100 su 248`: **sbagliati tutti e tre i numeri**, in
 * sedici punti, e il gate era verde — sono commenti, nessuna asserzione li
 * legge. È la specie di guasto che questo repo paga più cara: non un segnale
 * assente, un segnale FALSO, che resta lì con l'aria di essere stato verificato.
 *
 * La cura NON era aggiornare sedici commenti — sarebbe stato lo stesso difetto,
 * rinviato di una settimana. La cura è che la cifra abbia UN POSTO SOLO, con la
 * sua ora e la sua query, e che tutti gli altri lo NOMININO. Questo lock è ciò
 * che impedisce alla sedicesima copia di tornare.
 *
 * ─── COSA GUARDA, E COSA NON GUARDA ────────────────────────────────────────
 *
 * Guarda: una percentuale con decimali (`41,9%`, `40.3%`) scritta entro
 * `FINESTRA` righe da una riga che parla di curriculum/candidature. È la forma
 * ESATTA che la deriva aveva preso, e la vicinanza al tema è ciò che evita di
 * litigare con le decine di percentuali legittime che il resto del repo scrive
 * nei propri commenti (`0,4%` in `password-temporanea`, `74 mm` in `carta`…).
 *
 * NON guarda: un conteggio nudo scritto senza percentuale («98 su 234»). Si
 * potrebbe, ma la stessa forma serve a frasi oneste e datate che questo repo usa
 * ovunque («20 su 58, misura del 2026-08-06»), e un lock che va aggirato di
 * routine smette di proteggere. Detto qui perché nessuno lo scambi per una
 * copertura totale: **questo lock chiude la porta da cui la deriva è entrata,
 * non tutte le porte.**
 */

const RADICE = process.cwd();

/** Il solo file autorizzato a portare la cifra. */
const SORGENTE = 'src/lib/forms/insegnanti-template.ts';

/** Il token cercabile che gli altri commenti nominano al posto del numero. */
const ANCORA = 'MISURA-CV';

const CARTELLE = ['src', '__tests__', 'e2e'];
const FINESTRA = 15;

const PERCENTUALE = /\d+[.,]\d+\s*%/;
const TEMA = /curriculum|cv_path|candidatur/i;

/** Questo file: contiene apposta un campione che viola, e non deve accusarsi. */
const QUESTO_LOCK = '__tests__/architecture/misura-cv-un-posto-solo.test.ts';

function scandisci(dir: string, acc: string[]): string[] {
    for (const voce of fs.readdirSync(path.join(RADICE, dir), { withFileTypes: true })) {
        const rel = path.join(dir, voce.name);
        if (voce.isDirectory()) {
            if (voce.name === 'node_modules' || voce.name.startsWith('.')) continue;
            scandisci(rel, acc);
        } else if (/\.tsx?$/.test(voce.name)) {
            acc.push(rel);
        }
    }
    return acc;
}

const FILE = CARTELLE.flatMap((d) => scandisci(d, [])).filter((f) => f !== QUESTO_LOCK);

/**
 * Le violazioni di un testo. Prende il TESTO e non il percorso apposta: è la
 * stessa funzione che il controllo positivo qui sotto applica a un campione
 * sintetico, così il rilevatore lo si vede MORDERE invece di crederci.
 */
function violazioni(testo: string): { riga: number; contenuto: string }[] {
    const righe = testo.split('\n');
    const fuori: { riga: number; contenuto: string }[] = [];
    for (let i = 0; i < righe.length; i++) {
        if (!PERCENTUALE.test(righe[i])) continue;
        const da = Math.max(0, i - FINESTRA);
        const a = Math.min(righe.length - 1, i + FINESTRA);
        for (let j = da; j <= a; j++) {
            if (TEMA.test(righe[j])) {
                fuori.push({ riga: i + 1, contenuto: righe[i].trim() });
                break;
            }
        }
    }
    return fuori;
}

describe('la misura del curriculum mancante vive in un posto solo', () => {
    it('CONTROLLO POSITIVO — il rilevatore morde davvero (e solo quando deve)', () => {
        const colpevole = ['// il curriculum è obbligatorio dal 24/08', '// e i senza-CV erano il 41,9%'].join('\n');
        const senzaTema = ['// il tasso di conversione della cassa', '// è salito al 41,9%'].join('\n');
        const senzaCifra = ['// il curriculum è obbligatorio dal 24/08', '// e i senza-CV erano quattro su dieci'].join('\n');

        expect(violazioni(colpevole), 'il rilevatore NON vede la deriva che esiste per fermare').toHaveLength(1);
        expect(violazioni(senzaTema), 'accusa una percentuale che non parla di candidature').toHaveLength(0);
        expect(violazioni(senzaCifra), 'accusa una frase senza nessuna cifra').toHaveLength(0);
    });

    it("l'àncora esiste, porta l'ORA, porta la query, e porta la cifra", () => {
        const src = fs.readFileSync(path.join(RADICE, SORGENTE), 'utf8');

        expect(src, `l'àncora ${ANCORA} è sparita da ${SORGENTE}: tutti i rimandi sono diventati ciechi`).toContain(ANCORA);
        expect(src, "la misura non porta la data").toMatch(/20\d\d-\d\d-\d\d/);
        expect(src, "la misura non porta l'ORA — e una tabella datata al solo giorno ha già ospitato due valori diversi").toMatch(/\d\d:\d\d/);
        expect(src, 'la query per rifare il conto non è scritta accanto alla cifra').toMatch(/from candidature_insegnanti/i);

        // L'altra metà dell'invariante: il posto unico deve CONTENERLA davvero.
        // Svuotarlo lasciando in piedi quindici rimandi sarebbe la stessa bugia
        // al contrario — puntatori che indicano una stanza vuota.
        expect(violazioni(src).length, 'il posto unico non porta più nessuna cifra').toBeGreaterThan(0);
    });

    it("l'àncora è NOMINATA da altri file: la rete dei rimandi non è vuota", () => {
        const citanti = FILE.filter(
            (f) => f !== SORGENTE && fs.readFileSync(path.join(RADICE, f), 'utf8').includes(ANCORA),
        );
        expect(citanti.length, `nessuno nomina ${ANCORA}: o è stato rinominato, o i commenti hanno ricominciato a ribattere il numero`).toBeGreaterThan(0);
    });

    it('nessun altro file del repo ribatte la cifra', () => {
        const colpevoli: string[] = [];
        for (const f of FILE) {
            if (f === SORGENTE) continue;
            for (const v of violazioni(fs.readFileSync(path.join(RADICE, f), 'utf8'))) {
                colpevoli.push(`${f}:${v.riga}  ${v.contenuto}`);
            }
        }
        expect(
            colpevoli,
            `la cifra è stata ribattuta fuori da ${SORGENTE}. Non aggiornarla qui: toglila e nomina l'àncora ${ANCORA}.`,
        ).toEqual([]);
    });
});
