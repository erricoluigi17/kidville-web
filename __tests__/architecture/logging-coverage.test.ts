import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Coverage-lock del logging: OGNI export HTTP di OGNI route deve essere avvolto in `withRoute()`.
 *
 * Perché è un lock e non una checklist: una route nuda non fallisce, non si rompe e non avvisa
 * nessuno — semplicemente non compare nei log. È l'unico difetto di questo sistema che è invisibile
 * proprio nel canale che dovrebbe renderlo visibile. Il giorno in cui qualcuno aggiunge una route
 * dimenticando il wrapper, il buco lo scopre questo test, non un incidente in produzione.
 *
 * Modellato su `__tests__/api/zod-coverage.test.ts`, con due differenze deliberate:
 *
 *  1. NIENTE lista incrementale di gruppi. La copertura è TOTALE (tutte le route.ts sotto
 *     src/app/api), e una lista di prefissi avrebbe un difetto strutturale: una route in un gruppo
 *     NUOVO — cioè esattamente il caso in cui è più facile dimenticarsi il wrapper — non sarebbe
 *     coperta da nessun prefisso e passerebbe il lock in silenzio.
 *
 *  2. Si verifica anche il NOME. Non basta che l'export sia avvolto: il nome passato a `withRoute`
 *     finisce nella colonna `operazione` di `app_log` ed è la chiave con cui si chiede "quale route
 *     ha fallito". Un nome copiaincollato da un'altra route (il difetto più probabile quando si
 *     avvolgono 239 file) non rompe niente e non si vede: produce una colonna che MENTE, e una
 *     colonna che mente è peggio di una colonna che manca — perché ci si crede.
 */

const API_ROOT = path.join(process.cwd(), 'src', 'app', 'api');
const METODI = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

/** `export async function GET(` — la forma NON avvolta. */
const NUDO = new RegExp(`export\\s+(?:async\\s+)?function\\s+(${METODI})\\b`, 'g');
/** `export const GET = withRoute('nome', …)` — la forma avvolta, col nome. */
const AVVOLTO = new RegExp(`export\\s+const\\s+(${METODI})\\s*=\\s*withRoute\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
/** Un export avvolto in QUALCOSA che non è withRoute: sfuggirebbe a entrambe le regex sopra. */
const CONST_EXPORT = new RegExp(`export\\s+const\\s+(${METODI})\\s*=`, 'g');

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

/** `src/app/api/admin/parents/[id]/route.ts` → `admin/parents/[id]` */
function nomeAtteso(file: string): string {
    return path.relative(API_ROOT, path.dirname(file)).split(path.sep).join('/');
}

const FILES = routeFiles(API_ROOT);

describe('logging coverage lock', () => {
    it('ci sono route da controllare (se questa cade, il test si sta autoingannando)', () => {
        // Senza questa asserzione un errore nel path renderebbe VERDI tutti i test qui sotto,
        // semplicemente perché non troverebbero niente da controllare.
        expect(FILES.length).toBeGreaterThan(200);
    });

    it('nessun export HTTP è rimasto nudo', () => {
        const nudi: string[] = [];
        for (const f of FILES) {
            const src = fs.readFileSync(f, 'utf8');
            for (const m of src.matchAll(NUDO)) {
                nudi.push(`${path.relative(API_ROOT, f)} → ${m[1]}`);
            }
        }
        expect(nudi, 'export HTTP non avvolti in withRoute').toEqual([]);
    });

    it('ogni export HTTP avvolto passa da withRoute, non da un altro wrapper', () => {
        const estranei: string[] = [];
        for (const f of FILES) {
            const src = fs.readFileSync(f, 'utf8');
            const conWithRoute = new Set([...src.matchAll(AVVOLTO)].map((m) => m[1]));
            for (const m of src.matchAll(CONST_EXPORT)) {
                if (!conWithRoute.has(m[1])) estranei.push(`${path.relative(API_ROOT, f)} → ${m[1]}`);
            }
        }
        expect(estranei, 'export HTTP avvolti in qualcosa che non è withRoute').toEqual([]);
    });

    it('ogni route ha almeno un export HTTP avvolto', () => {
        const vuote = FILES.filter((f) => {
            const src = fs.readFileSync(f, 'utf8');
            return [...src.matchAll(AVVOLTO)].length === 0;
        }).map((f) => path.relative(API_ROOT, f));
        expect(vuote, 'route.ts senza nessun export avvolto').toEqual([]);
    });

    it('il NOME dice davvero quale route è: <path relativo a api>:<METODO>', () => {
        const bugiardi: string[] = [];
        for (const f of FILES) {
            const src = fs.readFileSync(f, 'utf8');
            const atteso = nomeAtteso(f);
            for (const m of src.matchAll(AVVOLTO)) {
                const [, metodo, nome] = m;
                if (nome !== `${atteso}:${metodo}`) {
                    bugiardi.push(`${path.relative(API_ROOT, f)}: withRoute('${nome}') dovrebbe essere '${atteso}:${metodo}'`);
                }
            }
        }
        expect(bugiardi, 'nomi di rotta che non corrispondono alla posizione del file').toEqual([]);
    });

    it("chi cattura un'eccezione la logga: un catch muto non arriva mai al wrapper", () => {
        // Se la route CATTURA l'eccezione e risponde 500, `withRoute` non la vede mai — vede solo una
        // Response con status 500 — e la riga che emette ha `operazione` e `stato`, ma niente stack e
        // niente messaggio. `logErrore` è ciò che salva lo stack (e alza la marca che impedisce al
        // wrapper di aggiungere un doppione più povero). Una route che cattura senza loggare è cieca
        // esattamente dove serve vedere.
        const muti: string[] = [];
        for (const f of FILES) {
            const src = fs.readFileSync(f, 'utf8');
            if (!/\bcatch\b/.test(src)) continue;
            if (/\blogErrore\s*\(/.test(src) || /\blogEvento\s*\(/.test(src)) continue;
            muti.push(path.relative(API_ROOT, f));
        }
        expect(muti, 'route con un catch che non logga (AGENTS regola 6)').toEqual([]);
    });
});
