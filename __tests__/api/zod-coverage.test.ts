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
const GRUPPI_COPERTI: string[] = [
    // M3.2 (zod 1/14)
    'attendance',
    'avvisi',
    'diary',
    'grades',
    'notes',
    'tasks',
    // M3.3 (zod 2/14)
    'chat',
    'gallery',
    'locker',
    'mensa',
    // M3.4 (zod 3/14 — parent A)
    'parent/forms',
    'parent/submissions',
    'parent/students',
    'parent/onboarding',
    'parent/competenze',
    'parent/medical-certificates',
    'parent/giustifiche-didattiche',
    // M3.5 (zod 4/14 — parent B: chiude tutto parent/*)
    'parent/presenze',
    'parent/primaria',
    'parent/mensa',
    // M3.6 + M3.7 (zod 5/14 + 6/14 — chiude tutto primaria/*)
    'primaria',
    // M3.8 (zod 7/14)
    'pagamenti',
    // M3.9 (zod 8/14 — pubblici)
    'forms',
    'fea',
    'iscrizione',
    'public',
    'register',
    'panic-alert',
    // M3.10 (zod 9/14 — infra)
    'me',
    'educator-sections',
    'notifiche',
    'push',
    'teacher',
    'seed-db',
    'debug-supabase',
    'debug',
    // M3.11 (zod 10/14 — admin A; il prefisso 'admin' intero arriva col 13/14)
    'admin/dashboard',
    'admin/students',
    'admin/adults',
    'admin/parents',
    'admin/staff',
    'admin/schools',
    'admin/sections',
    'admin/pre-inscriptions',
    'admin/iscrizioni',
];

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
