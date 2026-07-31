import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock — un'identità letta da `localStorage` non può finire in un ATTRIBUTO.
 *
 * LA STORIA. `getCurrentTeacherId()` legge `window.localStorage` dentro il corpo
 * del componente. Sul server quello storage non esiste: la funzione ritorna
 * `null`. Così la bottom-nav docente veniva servita con
 * `href="/teacher?userId=null"` e ri-renderizzata nel browser con
 * `href="/teacher?userId=<uuid>"`. React segnala il mismatch a livello ERROR su
 * ogni caricamento di `/teacher`, `/teacher/diary`, `/teacher/chat`,
 * `/teacher/gallery` — e **gli attributi non li ripara**: al docente restava
 * davvero sotto il dito un link con la stringa «null» al posto del suo id, che
 * viaggiava poi come identità dentro le route `/api/*`.
 *
 * Non era una svista isolata: lo stesso schema stava in `ClasseShell` (i nove
 * tab di una classe primaria) e nell'hub `/teacher/primaria`. È esattamente
 * l'inciampo che il progetto aveva già pagato col saluto per fascia oraria, e la
 * risposta è la stessa: il valore che dipende dal browser si legge a DUE
 * passaggi (`useClientValue` / `useAdminIdentity` / `useTeacherIdentity`), mai
 * nel render che deve combaciare col server.
 *
 * COSA GUARDA QUESTO LOCK. L'intersezione delle tre condizioni che, insieme,
 * fanno il difetto:
 *   1. il file assegna una variabile da un getter d'identità che legge
 *      `localStorage` (`getCurrentTeacherId` / `getCurrentParentId` /
 *      `getCurrentStudentId`) o da `localStorage.getItem` diretto;
 *   2. quella stessa variabile viene interpolata in un template che costruisce
 *      un parametro d'identità (`userId=${x}`, `id=${x}`);
 *   3. il file renderizza attributi (`href={` / `action={` / `src={`).
 * Prese singolarmente sono innocue — leggere l'identità per una `fetch` va
 * benissimo. È la combinazione che produce l'HTML sbagliato.
 *
 * LIMITE DICHIARATO (perché il lock non basta da solo). È un'analisi TESTUALE:
 * non segue una funzione locale che legge lo storage per conto suo, né un
 * valore che passa da tre variabili. Per questo esiste anche la prova
 * COMPORTAMENTALE in `__tests__/ui/idratazione-identita-docente.test.tsx`, che
 * fa davvero render-server → idratazione e osserva gli errori di React. I due
 * test si coprono a vicenda: questo impedisce di riscrivere lo schema, quello
 * dimostra che i componenti veri non lo hanno.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');

/** Getter d'identità che, sotto, leggono `window.localStorage`. */
const GETTER = ['getCurrentTeacherId', 'getCurrentParentId', 'getCurrentStudentId'];

/**
 * Attributi renderizzati: quello che React NON ripara dopo un mismatch.
 *
 * `action={` è volutamente FUORI: qui non è l'attributo di un `<form>`, è una
 * prop di `PageHeaderCard` che riceve JSX (bottoni con i loro `onClick`). Un
 * handler può leggere `localStorage` quanto vuole — gira dopo l'idratazione, e
 * non finisce in nessun HTML. Includerla avrebbe fatto solo falsi positivi, e un
 * lock che grida al lupo si disattiva da solo.
 */
const ATTRIBUTI = ['href={', 'src={'];

function sorgentiTsx(dir = SRC): string[] {
    const out: string[] = [];
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const assoluto = path.join(dir, voce.name);
        if (voce.isDirectory()) {
            out.push(...sorgentiTsx(assoluto));
            continue;
        }
        if (!voce.name.endsWith('.tsx')) continue;
        out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'));
    }
    return out;
}

/**
 * Le variabili «contagiate» da una lettura d'identità basata su `localStorage`.
 *
 * Livello 0: assegnate direttamente dal getter (`const userId = getCurrentTeacherId(…)`)
 * o da `localStorage.getItem`.
 * Livello 1+: dichiarazioni la cui inizializzazione costruisce un parametro
 * d'identità a partire da una variabile già contagiata — è la forma che il
 * difetto aveva davvero in produzione (`const suffix = \`?userId=${userId}\``,
 * `const withUser = (href) => \`${href}?userId=${userId}\``). Si itera fino al
 * punto fisso, così una catena di due passaggi non sfugge.
 */
function variabiliContagiate(sorgente: string): Set<string> {
    const nomi = new Set<string>();
    const daGetter = new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:${GETTER.join('|')})\\s*\\(`, 'g');
    const daStorage = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:window\.)?localStorage\.getItem\s*\(/g;
    for (const re of [daGetter, daStorage]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(sorgente)) !== null) nomi.add(m[1]);
    }

    // Propagazione: `const X = …userId=${contagiata}…` → anche X è contagiata.
    let cresciuto = true;
    while (cresciuto) {
        cresciuto = false;
        const dichiarazioni = /\b(?:const|let|var)\s+(\w+)\s*=\s*([\s\S]{0,240}?);\n/g;
        let m: RegExpExecArray | null;
        while ((m = dichiarazioni.exec(sorgente)) !== null) {
            const [, nome, corpo] = m;
            if (nomi.has(nome)) continue;
            for (const contagiata of nomi) {
                if (new RegExp(`\\b(?:userId|id)=\\$\\{\\s*${contagiata}\\b`).test(corpo)) {
                    nomi.add(nome);
                    cresciuto = true;
                    break;
                }
            }
        }
    }
    return nomi;
}

/**
 * Le espressioni degli attributi renderizzati (`href={…}`), con le graffe
 * bilanciate: `[^}]*` non basta, dentro un href ci sono template annidati.
 */
function espressioniDiAttributo(sorgente: string): string[] {
    const out: string[] = [];
    for (const attributo of ATTRIBUTI) {
        let da = sorgente.indexOf(attributo);
        while (da !== -1) {
            let i = da + attributo.length;
            let livello = 1;
            while (i < sorgente.length && livello > 0) {
                if (sorgente[i] === '{') livello++;
                else if (sorgente[i] === '}') livello--;
                i++;
            }
            out.push(sorgente.slice(da + attributo.length, i - 1));
            da = sorgente.indexOf(attributo, da + attributo.length);
        }
    }
    return out;
}

describe("lock — l'identità da localStorage non entra negli attributi renderizzati", () => {
    it('nessun componente costruisce un attributo con un id letto nel render', () => {
        const colpevoli: string[] = [];

        for (const rel of sorgentiTsx()) {
            const sorgente = fs.readFileSync(path.join(RADICE, rel), 'utf8');
            const contagiate = variabiliContagiate(sorgente);
            if (contagiate.size === 0) continue;
            for (const espressione of espressioniDiAttributo(sorgente)) {
                for (const variabile of contagiate) {
                    if (new RegExp(`\\b${variabile}\\b`).test(espressione)) {
                        colpevoli.push(`${rel} → \`${variabile}\` dentro un attributo`);
                    }
                }
            }
        }

        expect(
            colpevoli,
            'Questo valore viene da `localStorage`, che sul SERVER non esiste: lì vale ' +
                '`null`, nel browser vale l\'uuid — e finisce dentro un attributo. React ' +
                'segnala il mismatch a ogni caricamento e NON ripara gli attributi: il link ' +
                'resta quello del server, con la stringa «null» al posto dell\'identità, e ' +
                'quella stringa poi viaggia dentro le route /api/*. Usa l\'identità a due ' +
                'passaggi — `useTeacherIdentity(search)` (docente) o `useAdminIdentity()` ' +
                '(cockpit) — e costruisci l\'href con il loro `withUser`, che il parametro ' +
                'lo OMETTE finché l\'identità non è risolta.',
        ).toEqual([]);
    });

    it("`useTeacherIdentity` non emette mai il parametro con identità non risolta", () => {
        // Lock sulla PRIMITIVA: è l'unico punto che rende `userId=null`
        // impossibile per costruzione invece che per disciplina di chi scrive
        // il prossimo href. Se `withUser` tornasse ad appendere sempre, i
        // componenti tornerebbero a servire la stringa «null» senza che nessun
        // altro test se ne accorga finché non si guarda l'HTML.
        const sorgente = fs.readFileSync(
            path.join(SRC, 'lib', 'auth', 'use-teacher-identity.ts'),
            'utf8',
        );
        expect(sorgente).toContain('if (!userId) return href;');
        expect(sorgente).toContain('useSyncExternalStore');
    });
});
