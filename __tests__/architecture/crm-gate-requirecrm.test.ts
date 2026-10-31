import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { mascheraSorgente } from '../fixtures/sorgente';
import { RUOLI_CRM } from '@/lib/crm/accesso';

/**
 * Lock del CRM della segreteria: OGNI handler HTTP sotto `src/app/api/admin/crm/` passa da `requireCrm`,
 * PRIMA di aprire il client service-role.
 *
 * Perché un lock e non un 403 ripetuto in ogni file di test: la revisione del 31/10/2026 ha trovato che il
 * 403 della coordinatrice e del genitore era provato su alcune route soltanto. Il ruolo lo decide un
 * punto solo (`requireCrm` → `RUOLI_CRM`), e quello che può sbagliare è la route che NON lo chiama: un
 * `requireStaff(request)` col default ammette la coordinatrice, e la service-role scavalca le RLS. Una
 * route nuova del CRM che dimentica il gate cade qui, il giorno stesso, senza che nessuno debba ricordarsi
 * di scriverle il test del 403.
 *
 * Il sorgente si legge MASCHERATO (`mascheraSorgente`): un `requireCrm(` scritto in un commento non conta.
 */

const CRM_ROOT = path.join(process.cwd(), 'src', 'app', 'api', 'admin', 'crm');
const HANDLER = /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=/g;

function routeFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...routeFiles(full));
        else if (e.name === 'route.ts') out.push(full);
    }
    return out;
}

/** Ogni handler col suo pezzo di sorgente (dal suo `export const` al successivo), senza commenti. */
function handlers(): { dove: string; corpo: string }[] {
    const out: { dove: string; corpo: string }[] = [];
    for (const f of routeFiles(CRM_ROOT)) {
        const src = mascheraSorgente(fs.readFileSync(f, 'utf8')).senzaCommenti;
        const inizi = [...src.matchAll(HANDLER)];
        inizi.forEach((m, i) => {
            const fine = i + 1 < inizi.length ? inizi[i + 1].index : src.length;
            out.push({ dove: `${path.relative(CRM_ROOT, f)} → ${m[1]}`, corpo: src.slice(m.index, fine) });
        });
    }
    return out;
}

const HANDLERS = handlers();

describe('CRM: ogni handler passa da requireCrm', () => {
    it('ci sono handler da controllare (se questa cade, il lock si sta autoingannando)', () => {
        // 25 handler in 17 file al 31/10/2026. È un pavimento: una route nuova lo alza, non lo rompe.
        expect(routeFiles(CRM_ROOT).length).toBeGreaterThanOrEqual(17);
        expect(HANDLERS.length).toBeGreaterThanOrEqual(25);
    });

    it('RUOLI_CRM ammette segreteria e Direzione, non la coordinatrice né il genitore', () => {
        expect([...RUOLI_CRM]).toEqual(['segreteria', 'admin']);
    });

    it('ogni handler chiama requireCrm', () => {
        const senza = HANDLERS.filter((h) => !/\brequireCrm\s*\(/.test(h.corpo)).map((h) => h.dove);
        expect(senza).toEqual([]);
    });

    it('nessun handler chiama requireStaff direttamente (il suo default ammette la coordinatrice)', () => {
        const diretti = HANDLERS.filter((h) => /\brequireStaff\s*\(/.test(h.corpo)).map((h) => h.dove);
        expect(diretti).toEqual([]);
    });

    it('il gate viene prima del client service-role', () => {
        const dopo = HANDLERS.filter((h) => {
            const gate = h.corpo.search(/\brequireCrm\s*\(/);
            const client = h.corpo.search(/\bcreateAdminClient\s*\(/);
            return client !== -1 && (gate === -1 || client < gate);
        }).map((h) => h.dove);
        expect(dopo).toEqual([]);
    });
});
