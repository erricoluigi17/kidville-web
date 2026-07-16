import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock dei token di colore nell'area admin/cockpit (Direzione & Segreteria).
 *
 * Perché è un lock e non una linea guida: un hex cablato non rompe niente e non avvisa nessuno.
 * Semplicemente non segue il remap dei token — in particolare `@theme inline` inlinea gli hex nelle
 * utility, quindi un `style={{ background: '#FEF1E4' }}` NON si ribalta in Alto Contrasto e NON cambia
 * quando il brand cambia. È esattamente il tipo di deriva che il re-skin del cockpit ha ripulito e che
 * il giorno dopo qualcuno reintrodurrebbe con un copincolla da un mockup. Questo test lo scopre subito.
 *
 * Modellato su `__tests__/architecture/logging-coverage.test.ts`: scansione testuale dei sorgenti,
 * messaggio d'errore che elenca `file:riga` di ogni violazione più la regola da seguire.
 *
 * Regola: nell'area admin i colori si esprimono con i token `kidville-*` (classi Tailwind
 * `bg-kidville-*`/`text-kidville-*`/… o `var(--color-kidville-*)`), MAI con hex letterali. L'unica
 * casa legittima degli hex è `src/lib/ui/chart-colors.ts`, il modulo-specchio documentato dei token
 * per Recharts e le medaglie (Recharts setta attributi SVG dove `var()` non è affidabile).
 */

const ROOT = process.cwd();

/** Radici scansionate: tutta l'area admin + la primitiva cockpit condivisa. */
const SCOPE = [
    path.join(ROOT, 'src', 'app', '(dashboard)', 'admin'),
    path.join(ROOT, 'src', 'components', 'features', 'admin'),
    path.join(ROOT, 'src', 'components', 'ui', 'cockpit.tsx'),
];

/** Unica eccezione: il modulo-specchio dei token per grafici/medaglie. */
const ALLOWLIST = new Set([path.join(ROOT, 'src', 'lib', 'ui', 'chart-colors.ts')]);

/**
 * Hex COLORE letterale: `#` seguito da ESATTAMENTE 3, 4, 6 o 8 cifre esadecimali e da un confine
 * (nessuna cifra esadecimale a seguire). Le lunghezze valide dell'esadecimale CSS escludono i falsi
 * positivi: `#content` (dopo `#` una sola cifra hex `c`, poi `o`) non matcha, `#28` (2 cifre) non
 * matcha, `#123456789` (9) non matcha come `#123456`. Alternanza dalla più lunga alla più corta.
 */
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;

function sorgentiScope(entry: string): string[] {
    if (!fs.existsSync(entry)) return [];
    const stat = fs.statSync(entry);
    if (stat.isFile()) return [entry];
    const out: string[] = [];
    for (const e of fs.readdirSync(entry, { withFileTypes: true })) {
        const full = path.join(entry, e.name);
        if (e.isDirectory()) out.push(...sorgentiScope(full));
        else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
}

const FILES = [...new Set(SCOPE.flatMap(sorgentiScope))].filter((f) => !ALLOWLIST.has(f)).sort();

const REGOLA =
    'Hex colore letterali vietati nell\'area admin/cockpit. Usa i token `kidville-*` ' +
    '(classi `bg-kidville-*`/`text-kidville-*`/… o `var(--color-kidville-*)`); i colori di ' +
    'grafici e medaglie stanno SOLO in `src/lib/ui/chart-colors.ts`.';

describe('design-tokens admin lock', () => {
    it('ci sono sorgenti admin da controllare (se cade, il test si autoinganna)', () => {
        // Senza questa asserzione un path sbagliato renderebbe verde il lock semplicemente perché
        // non troverebbe niente da scansionare.
        expect(FILES.length).toBeGreaterThan(20);
    });

    it('nessun hex colore letterale nell\'area admin/cockpit (solo token o chart-colors.ts)', () => {
        const violazioni: string[] = [];
        for (const f of FILES) {
            const righe = fs.readFileSync(f, 'utf8').split('\n');
            righe.forEach((riga, i) => {
                for (const m of riga.matchAll(HEX)) {
                    violazioni.push(`${path.relative(ROOT, f)}:${i + 1} → ${m[0]}`);
                }
            });
        }
        expect(violazioni, REGOLA).toEqual([]);
    });
});

/**
 * Deliverable dello step 0C: le costanti di stile dei pannelli Impostazioni devono essere migrate
 * sui token dell'app — niente hex e niente `bg-white`/`text-white` nudi (che `@theme` non remappa).
 * A differenza del lock qui sopra (rosso finché le ondate non bonificano), questo blocco deve essere
 * verde: è la prova che `settings/ui.ts` è passato allo stile app.
 */
describe('settings/ui.ts — costanti migrate sui token dell\'app', () => {
    const UI = path.join(ROOT, 'src', 'components', 'features', 'admin', 'settings', 'ui.ts');
    const src = fs.readFileSync(UI, 'utf8');

    it('nessun hex colore letterale', () => {
        expect([...src.matchAll(HEX)].map((m) => m[0])).toEqual([]);
    });

    it('nessun `bg-white`/`text-white` nudo (si usa `bg-kidville-white` e i token di testo)', () => {
        const nudi = [...src.matchAll(/\b(?:bg|text)-white\b/g)].map((m) => m[0]);
        expect(nudi).toEqual([]);
    });
});
