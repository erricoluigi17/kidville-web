import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * LOCK — nelle schermate delle FAMIGLIE non si mostra la prosa del server.
 *
 * ─── IL DIFETTO ────────────────────────────────────────────────────────────
 * Collaudo del 2026-08-03, categoria localizzazione, T10-F1: con l'interfaccia
 * in inglese l'errore che un genitore legge arrivava dal server, in italiano.
 * Il punto più esposto era la firma FES della modulistica — la finestra in cui
 * si appone una firma con valore legale — dove `verifyOtpAndSign` restituiva
 * `json.error` e `OtpEmailModal` lo stampava tale e quale.
 *
 * Non è una traduzione dimenticata. Quelle frasi NASCONO sul server, dove non
 * esistono né il locale né il catalogo: tradurne una chiude un sintomo e lascia
 * in piedi la causa, perché la successiva nascerà italiana come le altre. Il
 * rimedio strutturale c'è già ed è `src/lib/ui/esito-fetch.ts`: il server manda
 * un CODICE stabile, la traduzione avviene sul client.
 *
 * ─── PERCHÉ IL PERIMETRO È QUESTO, E NON «TUTTA L'APP» ─────────────────────
 * Perché è quello in cui la lingua straniera è la norma e non l'eccezione: le
 * famiglie e chi compila il modulo pubblico d'iscrizione. Il cockpit dello
 * staff ha un corpo di errori scritto PER CHI OPERA («alcune classi
 * destinatarie non appartengono alla sede»), e lì la prosa del server è
 * informazione vera che `messaggioDaCorpo` mostra di proposito. Un perimetro
 * misurabile e dichiarato vale più di un divieto generale che nessuno può
 * rispettare: quando il cockpit sarà convertito, si allarga questo elenco.
 *
 * ─── COSA CONTROLLA, ESATTAMENTE ───────────────────────────────────────────
 * Dentro il perimetro, per ogni file: raccoglie i nomi legati a un corpo di
 * risposta (`const j = await res.json()`, anche con `.catch()` o dentro un
 * ternario) e poi cerca ogni lettura di `<quel nome>.error` / `<quel nome>?.error`.
 * Se ce n'è una, quella prosa può finire a schermo.
 *
 * NON tocca le variabili che non vengono da `.json()`: `OtpEmailModal` riceve
 * `res.error` dalla sua prop `onVerify`, ed è una stringa GIÀ tradotta dal
 * chiamante — la traduzione si fa nell'ultimo punto in cui il locale esiste.
 *
 * ─── COSA NON PUÒ FARE ─────────────────────────────────────────────────────
 * Non vede la prosa che il server infila in campi diversi da `error`: in
 * `MensaCalendar` gli esiti per giorno arrivano in `esito.motivo`, che è ancora
 * italiano ed è dichiarato nel file. Si chiuderà quando quei motivi avranno un
 * codice ciascuno.
 */

const RADICE = process.cwd();

/**
 * Le schermate che una famiglia vede. `src/app/offline` è fuori di proposito:
 * non fa `fetch`, e i suoi testi passano da un catalogo suo.
 */
const PERIMETRO = [
    'src/app/(dashboard)/parent',
    'src/app/iscrizione',
    'src/components/features/parent',
    'src/components/features/public',
];

function fileDi(dir: string): string[] {
    const out: string[] = [];
    const visita = (d: string): void => {
        for (const voce of readdirSync(d)) {
            const p = join(d, voce);
            if (statSync(p).isDirectory()) visita(p);
            else if (/\.(tsx?|jsx?)$/.test(p)) out.push(p);
        }
    };
    visita(dir);
    return out;
}

/**
 * I nomi legati al CORPO di una risposta HTTP. Copre le forme in uso nel repo:
 *   const j = await res.json()
 *   const j = await res.json().catch(() => ({}))
 *   const j = res ? await res.json().catch(() => null) : null
 */
const LEGAME_JSON = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\bawait\s+[A-Za-z_$][\w$]*\s*\??\.\s*json\s*\(\)/g;

interface Rilievo {
    file: string;
    riga: number;
    nome: string;
    testo: string;
}

/** I punti in cui si legge `.error` da un corpo di risposta. */
function letturePros(): { rilievi: Rilievo[]; fileVisti: number; legamiVisti: number } {
    const rilievi: Rilievo[] = [];
    let fileVisti = 0;
    let legamiVisti = 0;

    for (const dir of PERIMETRO) {
        for (const f of fileDi(join(RADICE, dir))) {
            fileVisti++;
            const src = readFileSync(f, 'utf8');
            const nomi = new Set([...src.matchAll(LEGAME_JSON)].map((m) => m[1]));
            legamiVisti += nomi.size;
            if (nomi.size === 0) continue;

            const uso = new RegExp(`\\b(${[...nomi].join('|')})\\s*\\??\\.\\s*error\\b`);
            src.split('\n').forEach((linea, i) => {
                // Le righe di commento parlano del difetto: non lo commettono.
                const codice = linea.trim();
                if (codice.startsWith('//') || codice.startsWith('*')) return;
                const m = uso.exec(linea);
                if (m) rilievi.push({ file: relative(RADICE, f), riga: i + 1, nome: m[1], testo: codice });
            });
        }
    }
    return { rilievi, fileVisti, legamiVisti };
}

describe('lock — le schermate delle famiglie non mostrano la prosa del server', () => {
    it('il perimetro esiste davvero (il lock non è verde per un errore di scansione)', () => {
        const { fileVisti, legamiVisti } = letturePros();
        // Un lock che non trova né file né corpi di risposta da controllare è
        // verde per il motivo sbagliato: è il modo in cui un test smette di
        // proteggere senza dirlo. I valori sono ANCORATI a una misura, non
        // all'ordine relativo: il 2026-08-03 il perimetro contava 51 file e 33
        // corpi di risposta. Se si dimezza per un refactor questo diventa rosso
        // e chiede di riguardarlo, invece di restare verde su un albero vuoto.
        expect(fileVisti).toBeGreaterThan(40);
        expect(legamiVisti).toBeGreaterThan(25);
    });

    it('nessuna lettura di `.error` da un corpo di risposta', () => {
        const { rilievi } = letturePros();
        expect(
            rilievi.map((r) => `${r.file}:${r.riga} → ${r.testo}`),
            "La prosa del server nasce dove il locale non esiste: mostrarla a una famiglia con l'interfaccia " +
                'in inglese è il difetto T10-F1. Usa `soloCatalogoDaCorpo(corpo, t(…))` o ' +
                '`messaggioSoloCatalogo(res, t(…))` da `@/lib/ui/esito-fetch`: il codice dichiarato vince, ' +
                'il ripiego è la frase tradotta del componente.',
        ).toEqual([]);
    });
});
