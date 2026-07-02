import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Coverage-lock M3: ogni route.ts dei gruppi già coperti DEVE importare
 * zod o @/lib/validation — la copertura non può regredire.
 *
 * Lista incrementale: ogni batch M3.x aggiunge i propri prefissi
 * (path relativi a src/app/api; coprono ogni route.ts sottostante).
 */
const GRUPPI_COPERTI: string[] = [];

const API_ROOT = path.join(process.cwd(), 'src', 'app', 'api');

function routeFilesUnder(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...routeFilesUnder(full));
        else if (entry.name === 'route.ts') out.push(full);
    }
    return out;
}

const IMPORT_RE = /from ['"]zod['"]|@\/lib\/validation/;

describe('zod coverage lock (M3)', () => {
    it.each(GRUPPI_COPERTI.length ? GRUPPI_COPERTI : [null])(
        'gruppo %s: ogni route importa zod/@lib/validation',
        (gruppo) => {
            if (gruppo === null) return; // lista ancora vuota (M3.1)
            const files = routeFilesUnder(path.join(API_ROOT, gruppo));
            expect(files.length, `nessuna route trovata sotto ${gruppo}`).toBeGreaterThan(0);
            const scoperte = files.filter((f) => !IMPORT_RE.test(fs.readFileSync(f, 'utf8')));
            expect(
                scoperte.map((f) => path.relative(API_ROOT, f)),
                `route senza validazione zod nel gruppo ${gruppo}`
            ).toEqual([]);
        }
    );
});
