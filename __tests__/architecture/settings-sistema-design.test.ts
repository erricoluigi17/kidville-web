import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock di design dello step W6 (/ship-cycle re-skin cockpit) — gruppo "Sistema".
 *
 * Due garanzie che i test formali del repo non coprono altrove:
 *
 * 1. I pannelli delle Impostazioni admin non usano classi Tailwind BIANCHE nude
 *    (`bg-white`/`text-white`). `@theme inline` NON remappa `bg-white`/`text-white`
 *    (che sono `#fff` cablato): una card `bg-white` resta bianca in Alto Contrasto
 *    e sparisce. Si usano i token (`bg-kidville-white`, `text-kidville-white`,
 *    `text-kidville-yellow`) che il tema ribalta. Il lock hex di 0C
 *    (`design-tokens-admin.test.ts`) NON intercetta questo caso (le classi bianche
 *    non sono hex), quindi serve un guard dedicato.
 *
 * 2. Le 4 pagine del gruppo "Sistema" espongono l'eyebrow "Sistema" nell'header
 *    (coerenza del PageHeaderCard con il resto dell'app, come da piano W6).
 */

const ROOT = process.cwd();
const SETTINGS_DIR = path.join(ROOT, 'src', 'components', 'features', 'admin', 'settings');

/** `bg-white`/`text-white`/`border-white`/`ring-white` NUDI (non i token `*-kidville-white`). */
const NUDE_WHITE = /\b(?:bg|text|border|ring)-white\b/g;

function tsxFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...tsxFiles(full));
        else if (/\.tsx$/.test(e.name) && !/\.(test|spec)\.tsx$/.test(e.name)) out.push(full);
    }
    return out;
}

describe('W6 Sistema — pannelli Impostazioni senza bianco nudo', () => {
    const files = tsxFiles(SETTINGS_DIR);

    it('ci sono pannelli da controllare', () => {
        expect(files.length).toBeGreaterThan(10);
    });

    it('nessun `bg-white`/`text-white` nudo (solo token `*-kidville-white`/`text-kidville-yellow`)', () => {
        const violazioni: string[] = [];
        for (const f of files) {
            fs.readFileSync(f, 'utf8').split('\n').forEach((riga, i) => {
                for (const m of riga.matchAll(NUDE_WHITE)) {
                    violazioni.push(`${path.relative(ROOT, f)}:${i + 1} → ${m[0]}`);
                }
            });
        }
        expect(violazioni).toEqual([]);
    });
});

describe('W6 Sistema — header con eyebrow "Sistema"', () => {
    const PAGES = [
        path.join(ROOT, 'src', 'app', '(dashboard)', 'admin', 'impostazioni', 'page.tsx'),
        path.join(ROOT, 'src', 'app', '(dashboard)', 'admin', 'tools', 'page.tsx'),
        path.join(ROOT, 'src', 'app', '(dashboard)', 'admin', 'schools', 'page.tsx'),
        path.join(ROOT, 'src', 'app', '(dashboard)', 'admin', 'sidi', 'page.tsx'),
    ];

    it.each(PAGES)('%s dichiara eyebrow="Sistema"', (page) => {
        const src = fs.readFileSync(page, 'utf8');
        expect(src).toMatch(/eyebrow=("|')Sistema\1/);
    });
});
