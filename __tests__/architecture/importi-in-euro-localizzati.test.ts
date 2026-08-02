import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock della VALUTA: un importo in euro non si formatta mai a mano.
 *
 * Perché è un lock e non una linea guida. `formatEuro()` (`src/lib/format/valuta.ts`,
 * `Intl.NumberFormat('it-IT')`) esiste dal giorno uno ed è corretto — «€ 1.234,50» —, ma non era
 * mai stato reso OBBLIGATORIO: 14 file lo scavalcavano con `€ ${n.toFixed(2)}` e stampavano
 * «€ 2892.00», cioè punto decimale e nessun raggruppamento delle migliaia. Il difetto non faceva
 * rumore da nessuna parte: il test di `formatEuro` collaudava la funzione in ISOLAMENTO e restava
 * verde mentre a schermo, nella stessa pagina `/admin/pagamenti`, il tab «Scadenzario» mostrava
 * «€ 2892.00» e il tab «Cassa» — che usa `formatEuro` — «€ 2.301,62». Due formati di valuta a un
 * tab di distanza, con il gate tutto verde.
 *
 * È la firma esatta dei difetti già chiusi in questo repo: una regola che vive in un posto solo
 * (la funzione) e nessun presidio che ne imponga l'uso nei punti d'uso. Questo file è il presidio.
 *
 * Due regole, in profondità:
 *  1) In TUTTO `src/`: il carattere «€» non può stare accanto a un `toFixed(` (stessa riga o riga
 *     adiacente, per intercettare anche il JSX spezzato su più righe). Un «€» vicino a un
 *     `toFixed` è, per definizione, un importo formattato a mano per un essere umano.
 *  2) Nei MODULI DEL DENARO (contabilità, cassa, merchandise, fatturazione, riconciliazione)
 *     `toFixed(` è vietato del tutto, anche senza il simbolo accanto: lì dentro un numero con due
 *     decimali è un importo, e va da `formatEuro()`. Chi ha una ragione diversa la scrive
 *     nell'allowlist qui sotto — e la ragione deve reggere il fatto che il numero NON è destinato
 *     a un occhio italiano ma a un'altra macchina.
 *  3) Sempre nei moduli del denaro: nemmeno `toLocaleString`/`new Intl.NumberFormat` a mano.
 *     È la SECONDA PORTA dello stesso difetto, e in questo repo la lezione è già scritta col
 *     sangue: una regola valida per due strade deve vivere in un posto solo. `toLocaleString('it-IT',
 *     { minimumFractionDigits: 2 })` sembra corretto e NON lo è: l'it-IT ha `minimumGroupingDigits = 2`,
 *     quindi 1234,50 esce «1234,50» — senza il punto delle migliaia — esattamente come il difetto
 *     che questo lock chiude. L'unico `Intl.NumberFormat` legittimo dell'app vive in
 *     `src/lib/format/valuta.ts`, che è la casa della regola.
 *
 * Modellato su `__tests__/architecture/design-tokens-admin.test.ts`: scansione testuale dei
 * sorgenti, messaggio d'errore con `file:riga` di ogni violazione e la regola da seguire.
 */

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

/**
 * Allowlist MOTIVATA: gli unici `toFixed` su un importo che restano legittimi, perché il numero
 * non è destinato a un lettore italiano ma a un altro sistema — dove il punto decimale è imposto
 * dal formato e la virgola sarebbe un errore di interoperabilità.
 */
const TOFIXED_AMMESSI = new Map<string, string>([
    [
        'src/lib/aruba/fatturapa-xml.ts',
        'Tracciato FatturaPA per lo SDI: le specifiche impongono il punto come separatore decimale ' +
        'e nessun raggruppamento (es. «1234.50»). Italianizzarlo farebbe SCARTARE la fattura.',
    ],
    [
        'src/lib/pagamenti/riconciliazione.ts',
        'Impronta anti re-import (`hashMovimento`): l\'importo entra in una chiave di deduplica ' +
        'sha256, non in un testo per un umano. Cambiarne la resa spaccherebbe gli hash già scritti ' +
        'a database e farebbe rientrare movimenti bancari già importati.',
    ],
    [
        'src/lib/cassa/report.ts',
        'Export CSV del report cassa: la cella deve restare un NUMERO per Excel it-IT (virgola ' +
        'decimale, nessun raggruppamento, nessun simbolo). Con «€ 1.234,50» Excel leggerebbe testo ' +
        'e le somme del foglio smetterebbero di funzionare: qui il formato serve al parser, non all\'occhio.',
    ],
]);

/**
 * Moduli del denaro: qui `toFixed` è vietato di per sé (regola 2). Un percorso può essere una
 * cartella o un singolo file.
 */
const MODULI_DENARO = [
    'src/components/features/admin/pagamenti',
    'src/components/features/parent/pagamenti',
    'src/components/features/admin/StudentEconomicSection.tsx',
    'src/app/api/pagamenti',
    'src/app/(dashboard)/admin/merchandise',
    'src/lib/pagamenti',
    'src/lib/cassa',
    'src/lib/aruba',
    'src/lib/format/valuta.ts',
];

const TOFIXED = /\.toFixed\s*\(/;
/** Formattazione numerica a mano: l'altra strada per riportare il difetto. */
const FORMATTAZIONE_A_MANO = /\.toLocaleString\s*\(|new\s+Intl\.NumberFormat\s*\(/;
/** La casa legittima della regola: qui `Intl.NumberFormat` ci deve stare. */
const CASA_DELLA_VALUTA = 'src/lib/format/valuta.ts';

function sorgenti(entry: string): string[] {
    if (!fs.existsSync(entry)) return [];
    const stat = fs.statSync(entry);
    if (stat.isFile()) return /\.tsx?$/.test(entry) ? [entry] : [];
    const out: string[] = [];
    for (const e of fs.readdirSync(entry, { withFileTypes: true })) {
        const full = path.join(entry, e.name);
        if (e.isDirectory()) out.push(...sorgenti(full));
        else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

const TUTTI = sorgenti(SRC).sort();
const FILE_DENARO = [...new Set(MODULI_DENARO.flatMap((p) => sorgenti(path.join(ROOT, p))))].sort();

const REGOLA_1 =
    'Importo in euro formattato a mano. Un «€» accanto a un `toFixed` stampa il formato ' +
    'anglosassone («€ 1234.50»): usa `formatEuro(x)` da `@/lib/format/valuta` — emette già il ' +
    'simbolo, quindi il «€ » scritto a mano va tolto.';

const REGOLA_2 =
    'Nei moduli del denaro `toFixed` è vietato: un numero a due decimali lì dentro è un importo e ' +
    'va da `formatEuro(x)` (`@/lib/format/valuta`). Se davvero non è per un occhio italiano ma per ' +
    'un altro sistema (tracciato SDI, chiave di deduplica, …), dichiaralo in `TOFIXED_AMMESSI` con ' +
    'la ragione scritta.';

const REGOLA_3 =
    'Formattazione numerica a mano in un modulo del denaro. `toLocaleString(\'it-IT\', ' +
    '{ minimumFractionDigits: 2 })` NON è equivalente a `formatEuro`: l\'it-IT ha ' +
    '`minimumGroupingDigits = 2` e stampa «1234,50» invece di «1.234,50». L\'unico ' +
    '`Intl.NumberFormat` dell\'app vive in `src/lib/format/valuta.ts`: usa `formatEuro(x)`.';

describe('valuta — nessun importo in euro formattato a mano', () => {
    it('ci sono sorgenti da controllare (senza questa asserzione il lock si autoingannerebbe)', () => {
        // Un percorso sbagliato renderebbe verde il lock semplicemente perché non troverebbe
        // niente da scansionare: è già successo in questo repo con altri test.
        expect(TUTTI.length).toBeGreaterThan(300);
        expect(FILE_DENARO.length).toBeGreaterThan(20);
    });

    it('ogni modulo del denaro dichiarato esiste davvero (una cartella rinominata non esce di soppiatto dal perimetro)', () => {
        // Il conteggio complessivo qui sopra non basta: con otto percorsi, uno spostato resterebbe
        // sopra soglia grazie agli altri sette e il suo contenuto smetterebbe di essere controllato
        // senza che niente diventi rosso.
        const vuoti = MODULI_DENARO.filter((p) => sorgenti(path.join(ROOT, p)).length === 0);
        expect(vuoti, 'Percorso spostato o rinominato: aggiorna MODULI_DENARO, altrimenti quel codice non è più sorvegliato.').toEqual([]);
    });

    it('l\'allowlist non è stantia: ogni file esiste e contiene ancora un toFixed', () => {
        const morte: string[] = [];
        for (const [f, motivo] of TOFIXED_AMMESSI) {
            const full = path.join(ROOT, f);
            if (!fs.existsSync(full)) { morte.push(`${f} → file inesistente`); continue; }
            if (!TOFIXED.test(fs.readFileSync(full, 'utf8'))) morte.push(`${f} → non ha più nessun toFixed`);
            if (motivo.trim().length < 40) morte.push(`${f} → motivazione troppo vaga`);
        }
        expect(morte, 'Voce di allowlist da rimuovere: un\'eccezione senza più oggetto nasconde le violazioni future.').toEqual([]);
    });

    it('regola 1 — in src/ nessun «€» affiancato a un toFixed', () => {
        const violazioni: string[] = [];
        for (const f of TUTTI) {
            if (TOFIXED_AMMESSI.has(rel(f))) continue;
            const righe = fs.readFileSync(f, 'utf8').split('\n');
            righe.forEach((riga, i) => {
                if (!TOFIXED.test(riga)) return;
                // Finestra ±1 riga: intercetta anche `<span>€</span>` sopra/sotto l'importo.
                const intorno = [righe[i - 1] ?? '', riga, righe[i + 1] ?? ''].join('\n');
                if (intorno.includes('€')) violazioni.push(`${rel(f)}:${i + 1} → ${riga.trim().slice(0, 120)}`);
            });
        }
        expect(violazioni, REGOLA_1).toEqual([]);
    });

    it('regola 2 — nei moduli del denaro nessun toFixed fuori dall\'allowlist motivata', () => {
        const violazioni: string[] = [];
        for (const f of FILE_DENARO) {
            if (TOFIXED_AMMESSI.has(rel(f))) continue;
            const righe = fs.readFileSync(f, 'utf8').split('\n');
            righe.forEach((riga, i) => {
                if (TOFIXED.test(riga)) violazioni.push(`${rel(f)}:${i + 1} → ${riga.trim().slice(0, 120)}`);
            });
        }
        expect(violazioni, REGOLA_2).toEqual([]);
    });

    it('regola 3 — nei moduli del denaro nessun toLocaleString/Intl.NumberFormat a mano', () => {
        const violazioni: string[] = [];
        for (const f of FILE_DENARO) {
            if (rel(f) === CASA_DELLA_VALUTA) continue;
            const righe = fs.readFileSync(f, 'utf8').split('\n');
            righe.forEach((riga, i) => {
                if (FORMATTAZIONE_A_MANO.test(riga)) violazioni.push(`${rel(f)}:${i + 1} → ${riga.trim().slice(0, 120)}`);
            });
        }
        expect(violazioni, REGOLA_3).toEqual([]);
    });
});
