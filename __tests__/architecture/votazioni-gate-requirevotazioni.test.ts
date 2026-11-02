import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { mascheraSorgente } from '../fixtures/sorgente';
import { RUOLI_VOTAZIONI } from '@/lib/votazioni/accesso';

/**
 * Lock delle votazioni dei rappresentanti: OGNI handler HTTP sotto `src/app/api/admin/votazioni/` passa da
 * `requireVotazioni`, PRIMA di aprire il client service-role.
 *
 * Perché un lock e non un 403 ripetuto in ogni file di test: il ruolo lo decide un punto solo
 * (`requireVotazioni` → `RUOLI_VOTAZIONI`), e quello che può sbagliare è la route che NON lo chiama. Tutte le
 * route lavorano col client service-role, che scavalca le RLS: una route nuova che dimentica il gate è
 * aperta a qualunque utente autenticato — un genitore compreso, e qui dentro c'è chi ha votato chi. Una route
 * che arriva dopo cade qui, il giorno stesso, senza che nessuno debba ricordarsi di scriverle il test del 403.
 *
 * Il sorgente si legge MASCHERATO (`mascheraSorgente`): un `requireVotazioni(` scritto in un commento non
 * conta. Modello: `crm-gate-requirecrm.test.ts`.
 */

const RADICE = path.join(process.cwd(), 'src', 'app', 'api', 'admin', 'votazioni');
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
function handlersDi(sorgente: string, dove: string): { dove: string; corpo: string }[] {
    const src = mascheraSorgente(sorgente).senzaCommenti;
    const inizi = [...src.matchAll(HANDLER)];
    return inizi.map((m, i) => {
        const fine = i + 1 < inizi.length ? (inizi[i + 1].index as number) : src.length;
        return { dove: `${dove} → ${m[1]}`, corpo: src.slice(m.index as number, fine) };
    });
}

function handlers(): { dove: string; corpo: string }[] {
    return routeFiles(RADICE).flatMap((f) =>
        handlersDi(fs.readFileSync(f, 'utf8'), path.relative(RADICE, f)),
    );
}

const HANDLERS = handlers();

/** Gli handler che non chiamano il gate, quelli che chiamano `requireStaff` a mano, quelli col gate dopo il client. */
const senzaGate = (hs: { dove: string; corpo: string }[]) =>
    hs.filter((h) => !/\brequireVotazioni\s*\(/.test(h.corpo)).map((h) => h.dove);
const conStaffDiretto = (hs: { dove: string; corpo: string }[]) =>
    hs.filter((h) => /\brequireStaff\s*\(/.test(h.corpo)).map((h) => h.dove);
const gateDopoIlClient = (hs: { dove: string; corpo: string }[]) =>
    hs
        .filter((h) => {
            const gate = h.corpo.search(/\brequireVotazioni\s*\(/);
            const client = h.corpo.search(/\bcreateAdminClient\s*\(/);
            return client !== -1 && (gate === -1 || client < gate);
        })
        .map((h) => h.dove);

describe('Votazioni (segreteria): ogni handler passa da requireVotazioni', () => {
    it('ci sono handler da controllare (se questa cade, il lock si sta autoingannando)', () => {
        // 6 handler in 3 file al 02/11/2026: GET e POST dell'elenco, GET/PATCH/DELETE del dettaglio, GET dei
        // genitori. È un pavimento: una route nuova lo alza, non lo rompe.
        expect(routeFiles(RADICE).length).toBeGreaterThanOrEqual(3);
        expect(HANDLERS.length).toBeGreaterThanOrEqual(6);
    });

    it('RUOLI_VOTAZIONI ammette Direzione, coordinatori e segreteria, non il genitore né il docente', () => {
        expect([...RUOLI_VOTAZIONI]).toEqual(['admin', 'coordinator', 'segreteria']);
    });

    it('ogni handler chiama requireVotazioni', () => {
        expect(senzaGate(HANDLERS)).toEqual([]);
    });

    it('nessun handler chiama requireStaff direttamente (il gate sta in un punto solo)', () => {
        expect(conStaffDiretto(HANDLERS)).toEqual([]);
    });

    it('il gate viene prima del client service-role', () => {
        expect(gateDopoIlClient(HANDLERS)).toEqual([]);
    });
});

/**
 * Il rilevatore deve poter FALLIRE: un lock che non vede la forma vietata è decorazione. Qui gli si danno
 * sorgenti finti con ognuno dei tre difetti, e si controlla che li riconosca (e che NON accusi la forma giusta).
 */
describe('il rilevatore riconosce le forme vietate', () => {
    const giusto = `export const GET = withRoute('x', async (request) => {
  const auth = await requireVotazioni(request)
  if (auth.response) return auth.response
  const supabase = await createAdminClient()
})`;

    it('un handler corretto non è segnalato', () => {
        const hs = handlersDi(giusto, 'finto.ts');
        expect(hs).toHaveLength(1);
        expect(senzaGate(hs)).toEqual([]);
        expect(conStaffDiretto(hs)).toEqual([]);
        expect(gateDopoIlClient(hs)).toEqual([]);
    });

    it('un handler senza gate è segnalato', () => {
        const hs = handlersDi(`export const POST = withRoute('x', async () => {\n  const s = await createAdminClient()\n})`, 'finto.ts');
        expect(senzaGate(hs)).toEqual(['finto.ts → POST']);
        expect(gateDopoIlClient(hs)).toEqual(['finto.ts → POST']);
    });

    it('requireStaff chiamato a mano è segnalato', () => {
        const hs = handlersDi(`export const GET = withRoute('x', async (r) => {\n  const a = await requireStaff(r)\n})`, 'finto.ts');
        expect(conStaffDiretto(hs)).toEqual(['finto.ts → GET']);
        expect(senzaGate(hs)).toEqual(['finto.ts → GET']);
    });

    it('il client aperto PRIMA del gate è segnalato', () => {
        const hs = handlersDi(
            `export const DELETE = withRoute('x', async (r) => {\n  const s = await createAdminClient()\n  const a = await requireVotazioni(r)\n})`,
            'finto.ts',
        );
        expect(senzaGate(hs)).toEqual([]);
        expect(gateDopoIlClient(hs)).toEqual(['finto.ts → DELETE']);
    });

    it('un gate scritto solo in un COMMENTO non conta', () => {
        const hs = handlersDi(
            `export const GET = withRoute('x', async () => {\n  // requireVotazioni(request) lo chiamerei qui\n  const s = await createAdminClient()\n})`,
            'finto.ts',
        );
        expect(senzaGate(hs)).toEqual(['finto.ts → GET']);
    });

    it('il pezzo di un handler non si confonde con quello del successivo', () => {
        const hs = handlersDi(
            `export const GET = withRoute('x', async () => {\n  return 1\n})\nexport const POST = withRoute('y', async (r) => {\n  const a = await requireVotazioni(r)\n})`,
            'finto.ts',
        );
        expect(senzaGate(hs)).toEqual(['finto.ts → GET']);
    });
});
