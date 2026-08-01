import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * LOCK — ogni variabile d'ambiente CRITICA è documentata in `docs/env.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL GUASTO CHE QUESTO LOCK ESISTE PER IMPEDIRE.
 *
 * `src/instrumentation.ts` tiene l'elenco delle variabili la cui assenza produce un guasto
 * SILENZIOSO, e a ogni cold start scrive in `app_log` quali mancano (AGENTS, regola 4:
 * configurazione mancante = `error`). È osservabilità che funziona — ma dice solo che una
 * variabile manca, non a che serve, non chi la deve impostare, non cosa smette di funzionare
 * senza. Quella parte sta in `docs/env.md`, ed è l'unico posto in cui una persona la può
 * leggere PRIMA di un deploy.
 *
 * `LOG_HASH_SALT` non c'era. Nessuna riga, in nessuna tabella: la variabile esisteva solo
 * dentro `redact.ts` e dentro il preflight. Il costo si è visto due volte:
 *  · in sviluppo non la imposta nessuno, quindi `hashCorrelabile` è fail-closed e i log
 *    locali NON somigliano a quelli di produzione (chi debugga vede `[redatto]` dove in
 *    produzione c'è `#a1b2c3d4`);
 *  · il collaudo del 2026-07-31 l'ha scambiata per un incidente di produzione aperto da 11
 *    giorni — perché nessun documento del repo diceva che quella variabile esiste e che su
 *    Vercel è impostata.
 *
 * La regola che questo lock rende meccanica: una variabile entra nel preflight critico solo
 * insieme alla sua riga di documentazione. Il NOME e a cosa serve. **Mai il valore.**
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * Disciplina, come negli altri lock del repo: si scandisce il SORGENTE (un import non
 * dimostra un elenco), e ogni asserzione negativa ha il suo controllo positivo — un lock che
 * ha smesso di trovare qualunque cosa deve CADERE, non passare.
 */

const ROOT = process.cwd();
const INSTRUMENTATION = path.join(ROOT, 'src/instrumentation.ts');
const DOC_ENV = path.join(ROOT, 'docs/env.md');

/* ────────────────────────────────────────────────────────────────────────────
 * Estrattori
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * I nomi dentro `variabiliCritiche()`: `['NOME', process.env.NOME],`.
 * Si legge SOLO il corpo di quella funzione — altrove nel file compaiono `NEXT_RUNTIME` e
 * `VERCEL_ENV`, che non sono configurazione nostra ma variabili della piattaforma.
 */
export function criticheDelPreflight(sorgente: string): string[] {
    const inizio = sorgente.indexOf('function variabiliCritiche');
    if (inizio < 0) return [];
    const fine = sorgente.indexOf('];', inizio);
    if (fine < 0) return [];
    const corpo = sorgente.slice(inizio, fine);
    const nomi = corpo.match(/'([A-Z][A-Z0-9_]*)'/g) ?? [];
    return [...new Set(nomi.map((n) => n.slice(1, -1)))];
}

/**
 * I nomi documentati: la PRIMA cella di una riga di tabella markdown, che è la colonna
 * «Variabile». Una cella può portarne più d'uno (`` `ARUBA_USERNAME` / `ARUBA_PASSWORD` ``).
 *
 * Deliberatamente NON basta una menzione qualsiasi nel documento: una variabile citata di
 * sfuggita in una nota non è documentata: non ha «dove serve» né «cosa succede se manca».
 */
export function variabiliDocumentate(markdown: string): string[] {
    const nomi: string[] = [];
    for (const riga of markdown.split('\n')) {
        if (!riga.startsWith('|')) continue;
        const primaCella = riga.split('|')[1] ?? '';
        for (const m of primaCella.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) nomi.push(m[1]);
    }
    return [...new Set(nomi)];
}

/**
 * Un letterale «somiglia a un segreto»: chiave esadecimale (un salt è
 * `openssl rand -hex 32`), token base64url lungo, JWT. Gli uuid sono esclusi: in questo
 * documento sono identificatori di sede, non credenziali, e si citano apposta.
 *
 * Il lock `niente-password-nel-repo` non copre questo caso — chiede tre classi di caratteri
 * su quattro, e un salt esadecimale ne ha due (minuscole e cifre).
 */
export function sembraUnSegreto(valore: string): boolean {
    const v = valore.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return false;
    if (/^[0-9a-f]{32,}$/i.test(v)) return true;
    if (/^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(v)) return true;
    return /^[A-Za-z0-9_-]{40,}$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
}

/** I letterali di `docs/env.md` su cui ha senso cercare un valore: backtick e `NOME=…`. */
export function letteraliDi(markdown: string): { riga: number; valore: string }[] {
    const out: { riga: number; valore: string }[] = [];
    markdown.split('\n').forEach((riga, i) => {
        for (const m of riga.matchAll(/`([^`\n]{8,200})`/g)) out.push({ riga: i + 1, valore: m[1] });
        for (const m of riga.matchAll(/\b[A-Z][A-Z0-9_]*=(\S{8,200})/g)) out.push({ riga: i + 1, valore: m[1] });
    });
    return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Il lock
 * ──────────────────────────────────────────────────────────────────────────── */

describe('lock configurazione · le variabili critiche sono documentate in docs/env.md', () => {
    const sorgente = fs.readFileSync(INSTRUMENTATION, 'utf8');
    const doc = fs.readFileSync(DOC_ENV, 'utf8');
    const critiche = criticheDelPreflight(sorgente);
    const documentate = variabiliDocumentate(doc);

    it('lo scanner del preflight trova davvero l’elenco (sanity: il lock non gira a vuoto)', () => {
        expect(
            critiche.length,
            'Nessuna variabile critica estratta da src/instrumentation.ts: `variabiliCritiche()` è ' +
                'stata rinominata o riscritta, e questo lock sta passando SENZA VERIFICARE NIENTE. ' +
                'Aggiorna `criticheDelPreflight` prima di toccare altro.',
        ).toBeGreaterThanOrEqual(5);
        // Controllo positivo puntuale: due nomi che nel preflight ci sono di sicuro.
        expect(critiche).toContain('RESEND_API_KEY');
        expect(critiche).toContain('CRON_SECRET');
    });

    it('lo scanner della documentazione legge la colonna «Variabile» (anche con due nomi in cella)', () => {
        expect(documentate.length).toBeGreaterThan(20);
        expect(documentate).toContain('SUPABASE_SERVICE_ROLE_KEY');
        // `ARUBA_USERNAME` / `ARUBA_PASSWORD` stanno nella STESSA cella: prova che lo split regge.
        expect(documentate).toContain('ARUBA_PASSWORD');
        // Prova al contrario: un nome citato solo in prosa NON conta come documentato.
        expect(variabiliDocumentate('Vedi `NON_DOCUMENTATA` nelle note.\n')).toEqual([]);
        expect(variabiliDocumentate('| `NON_DOCUMENTATA` | dove | a che serve |\n')).toEqual(['NON_DOCUMENTATA']);
    });

    it('ogni variabile del preflight critico ha la sua riga in docs/env.md', () => {
        const mancanti = critiche.filter((v) => !documentate.includes(v));
        expect(
            mancanti,
            'Variabili critiche NON documentate in docs/env.md: ' +
                `${mancanti.join(', ')}.\n\n` +
                'Il preflight di src/instrumentation.ts le tratta come «se manca, il guasto è ' +
                'silenzioso» e scrive un `error` in app_log quando non ci sono. Chi legge quel log ' +
                'deve poter capire in trenta secondi a che serve la variabile e cosa smette di ' +
                'funzionare senza: aggiungi una riga nella tabella giusta di docs/env.md con NOME, ' +
                'dove serve e cosa succede se manca. **Solo il nome — mai il valore.**',
        ).toEqual([]);
    });

    it('docs/env.md non contiene NESSUN valore di segreto (prova di validità del rilevatore)', () => {
        // Controllo positivo: il rilevatore riconosce un salt e una chiave, e tace sul resto.
        // I campioni sono assemblati per concatenazione — un letterale intero qui dentro
        // farebbe scattare il lock su questo stesso file.
        expect(sembraUnSegreto('0'.repeat(32) + 'abcdef01')).toBe(true);
        expect(sembraUnSegreto('ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.firma')).toBe(true);
        expect(sembraUnSegreto('LOG_HASH_SALT')).toBe(false);
        expect(sembraUnSegreto('openssl rand -hex 32')).toBe(false);
        expect(sembraUnSegreto('11111111-2222-3333-4444-555555555555')).toBe(false);

        const trovati = letteraliDi(doc)
            .filter((l) => sembraUnSegreto(l.valore))
            .map((l) => `docs/env.md:${l.riga}`);
        expect(
            trovati,
            `Sembra esserci un VALORE di segreto in docs/env.md (${trovati.join(', ')}). ` +
                'Questo file documenta i NOMI: il valore sta nell’ambiente di hosting e nel gestore ' +
                'di credenziali del titolare. Il repository è pubblico — un valore scritto qui va ' +
                'tolto E ruotato: cancellarlo dal file non lo toglie dalla storia git.',
        ).toEqual([]);
    });
});
