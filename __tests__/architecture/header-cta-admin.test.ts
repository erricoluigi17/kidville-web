import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock del re-skin ciclo 2 (step E2). Il CTA primario nella riga azioni
 * dell'header delle pagine admin usa la costante condivisa `HEADER_BTN`
 * (bianco su verde ≈ 6,5:1, AA) e NON più il pattern giallo-su-verde brand:
 * dentro il remap `.kv-tab-giallo` quel pattern collassava a green-dark-su-verde
 * (≈1,36:1). Vedi il piano di correzione ciclo 2, causa radice C1.
 *
 * Scansione TESTUALE dei sorgenti dei chiamanti (non import): il lock è
 * indipendente dall'export `HEADER_BTN` della primitiva `cockpit.tsx`.
 */

const ROOT = process.cwd();
const P = (rel: string) => path.join(ROOT, rel);

const CHIAMANTI = {
    avvisi: 'src/app/(dashboard)/admin/avvisi/page.tsx',
    compiti: 'src/app/(dashboard)/admin/compiti/page.tsx',
    armadietto: 'src/app/(dashboard)/admin/armadietto/page.tsx',
    protocolli: 'src/app/(dashboard)/admin/protocolli/page.tsx',
    students: 'src/app/(dashboard)/admin/students/page.tsx',
    modulistica: 'src/app/(dashboard)/admin/modulistica/page.tsx',
} as const;

/**
 * In questi 3 chiamanti `text-kidville-yellow` viveva SOLO nel CTA header
 * inline: dopo lo swap a `HEADER_BTN` il token giallo sparisce dal file.
 * (Negli altri 3 il giallo resta legittimo in drawer/wizard/badge fuori
 * perimetro; lì il CTA header usava `BTN_PRIMARY`/`btnClass`, senza literal.)
 */
const SOLO_CTA_GIALLA = ['avvisi', 'compiti', 'armadietto'] as const;

describe('header CTA admin — HEADER_BTN (fix ciclo 2)', () => {
    for (const [nome, rel] of Object.entries(CHIAMANTI)) {
        it(`${nome}: il CTA header usa HEADER_BTN`, () => {
            const src = fs.readFileSync(P(rel), 'utf8');
            expect(src).toMatch(/HEADER_BTN/);
        });
    }

    for (const nome of SOLO_CTA_GIALLA) {
        it(`${nome}: nessun text-kidville-yellow (era solo il CTA header)`, () => {
            const src = fs.readFileSync(P(CHIAMANTI[nome]), 'utf8');
            expect(src.includes('text-kidville-yellow')).toBe(false);
        });
    }
});
