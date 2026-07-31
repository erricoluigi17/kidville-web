import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Coverage-lock dell'isolamento fra sedi.
 *
 * Ogni route che legge dati di PERSONE con il client service-role (che scavalca
 * la RLS, quindi il gate applicativo è l'unico presidio) deve dichiarare uno
 * scope: o usa un helper di `@/lib/auth/scope`, o compare qui sotto
 * nell'allowlist **con la sua ragione scritta accanto**.
 *
 * Perché è un lock e non una checklist: il 2026-07-29 sette route perdevano
 * codici fiscali, nomi, presenze e genitori fra plessi **col gate formale
 * verde** — 3424 test ed E2E passanti. Un filtro mancante non rompe niente e non
 * avvisa nessuno: restituisce semplicemente più righe del dovuto. È il difetto
 * che i test non trovano da soli, perché tutto «funziona».
 *
 * Modellato su `logging-coverage.test.ts`, con la stessa scelta deliberata:
 * copertura TOTALE e nessuna lista di prefissi. Una route in un gruppo nuovo —
 * cioè il caso in cui è più facile dimenticarsi lo scope — non deve poter
 * passare in silenzio.
 */

const API_ROOT = path.join(process.cwd(), 'src', 'app', 'api');

/** Tabelle che contengono dati di persone: leggerle esige uno scope. */
const TABELLE_SENSIBILI = [
    'alunni', 'parents', 'student_parents', 'delegates',
    'certificati_medici', 'note_disciplinari', 'valutazioni',
];

const USA_SERVICE_ROLE = /createAdminClient\s*\(/;
const USA_SCOPE = /from '@\/lib\/auth\/scope'/;

/**
 * Route che leggono una tabella sensibile SENZA helper di scope, e perché è
 * corretto così. Ogni voce è una decisione, non un'eccezione di comodo: chi
 * aggiunge una riga qui deve poterla difendere.
 */
const AMMESSE: Record<string, string> = {
    // Lo scope è la FAMIGLIA, non la sede: il genitore vede i propri figli
    // ovunque siano iscritti, e il legame è verificato da requireParentOfStudent
    // o da genitoreHasFiglio.
    'parent/medical-certificates': 'scope famiglia (legame genitore↔figlio)',
    'parent/students': 'scope famiglia',
    'parent/presenze': 'scope famiglia',
    'parent/mensa/allergie': 'scope famiglia',
    'parent/competenze': 'scope famiglia',
    'parent/primaria': 'scope famiglia',
    'parent/forms': 'scope famiglia (sedi derivate dai figli)',
    'parent/account/richiesta-cancellazione': 'scope famiglia (self)',
    'parent/onboarding': 'self',
    'parent/submissions': 'scope famiglia',
    'parent/giustifiche-didattiche': 'scope famiglia (requireParent)',
    // Gate per LEGAME genitore↔figlio: lo scope è la famiglia, non la sede.
    'notes/sign': 'legame genitore↔figlio (genitoreHasFiglio)',
    'locker/notify': 'legame genitore↔figlio',
    'segnalazioni': 'legame genitore↔figlio + self',
    // Si può sospendere o riaprire SOLO una conversazione di cui si è
    // partecipanti: non c'è modo di agire su un thread altrui, quindi nemmeno
    // su uno di un'altra sede.
    'chat/threads/[id]/sospendi': 'solo i partecipanti del thread',
    'chat/threads/[id]/riapri': 'solo i partecipanti del thread',
    // RBAC dedicato e più stretto dello scope generico: nega `cross-tenant` e
    // traccia ogni accesso su `fascicolo_accessi_audit`.
    'primaria/fascicolo': 'RBAC dedicato in src/lib/primaria/fascicolo-rbac.ts',
    // Job schedulati: nessun utente, girano per TUTTE le sedi in ciclo.
    'notifiche/promemoria': 'cron: itera per sede',
    'mensa/allergie-check': 'cron: job globale',
    'pagamenti/solleciti': 'cron: itera per sede',
    'news/cron': 'cron',
    'push/dispatch': 'cron: coda notifiche',
    // Flussi pubblici con capability token o gate proprio.
    'public/forms': 'token pubblico del modello',
    'public/cancellazione-account': 'token monouso via email',
    'iscrizione': 'modulo pubblico: la sede è scelta e validata dentro la route',
    // Sigillati in produzione da sealDangerous() → 404.
    // (`admin/seed-full` e `seed-db` NON sono più qui: cancellate il 2026-07-31
    // perché cablavano l'uuid di una sede e `.env.local` punta al database di
    // produzione — il sigillo guarda NODE_ENV, non il database.)
    'admin/wipe': 'sealDangerous: 404 in produzione',
    'admin/backfill-auth': 'sealDangerous',
    'admin/check-schema': 'sealDangerous',
    'admin/test-relations': 'sealDangerous',
    'admin/setup-registro': 'sealDangerous',
    'admin/debug-mensa-auth': 'sealDangerous',
    'admin/apply-migration': 'sealDangerous',
    'admin/apply-enrollment-migration': 'sealDangerous',
    'admin/apply-fase4-migration': 'sealDangerous',
    'admin/apply-forms-migration': 'sealDangerous',
    'admin/apply-mensa-multi-menu-migration': 'sealDangerous',
    'debug-supabase': 'sealDangerous',
    'debug/scrutini': 'sealDangerous',
    // Gestione delle sedi stesse.
    'admin/schools': 'gestione sedi (Direzione)',
    'admin/sedi': 'elenco sedi accessibili',
    // Identità dell'utente corrente.
    'me': 'self',
    'auth/active-role': 'self',
};

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
function nomeRoute(file: string): string {
    return path.relative(API_ROOT, path.dirname(file)).split(path.sep).join('/');
}

function ammessa(nome: string): boolean {
    return Object.keys(AMMESSE).some((p) => nome === p || nome.startsWith(p + '/'));
}

const FILES = routeFiles(API_ROOT);

describe('coverage-lock isolamento fra sedi', () => {
    it('ci sono route da controllare (se cade, il test si sta autoingannando)', () => {
        expect(FILES.length).toBeGreaterThan(200);
    });

    it('ogni route service-role che legge dati di persone dichiara uno scope', () => {
        const scoperte: string[] = [];
        for (const f of FILES) {
            const testo = fs.readFileSync(f, 'utf8');
            if (!USA_SERVICE_ROLE.test(testo)) continue;
            const leggeSensibili = TABELLE_SENSIBILI.some((t) =>
                testo.includes(`from('${t}')`) || testo.includes(`from("${t}")`),
            );
            if (!leggeSensibili) continue;
            if (USA_SCOPE.test(testo)) continue;
            const nome = nomeRoute(f);
            if (ammessa(nome)) continue;
            scoperte.push(nome);
        }
        expect(scoperte).toEqual([]);
    });

    it('l\'allowlist non contiene voci morte (una route cancellata la lascerebbe indietro)', () => {
        const nomi = new Set(FILES.map(nomeRoute));
        const morte = Object.keys(AMMESSE).filter(
            (p) => !nomi.has(p) && ![...nomi].some((n) => n.startsWith(p + '/')),
        );
        expect(morte).toEqual([]);
    });
});
