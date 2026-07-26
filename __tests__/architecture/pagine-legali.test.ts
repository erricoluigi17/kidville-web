import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock sulle tre pagine legali pubbliche.
 *
 * Sono gli URL che gli store chiedono (Privacy Policy URL e Support URL) e le
 * uniche pagine che un genitore legge per sapere chi tratta i dati di suo
 * figlio. Sono già andate in produzione **con i segnaposto dentro** — nessun
 * test le guardava, e il gate era verde.
 */

const RADICE = process.cwd();
const PAGINE = ['privacy', 'termini', 'assistenza'] as const;

function leggi(p: string): string {
    return fs.readFileSync(path.join(RADICE, 'src/app', p, 'page.tsx'), 'utf8');
}

/** Le forme dei segnaposto usati durante la stesura. */
const SEGNAPOSTO = /\[(Ragione sociale|indirizzo sede|email d[^\]]*)\]/i;

describe('lock — pagine legali', () => {
    for (const p of PAGINE) {
        it(`/${p} non contiene segnaposto`, () => {
            expect(leggi(p)).not.toMatch(SEGNAPOSTO);
        });
    }

    it('il recapito è una casella ORDINARIA, mai una PEC', () => {
        // Una PEC come recapito di supporto RIFIUTA la posta ordinaria: il
        // genitore che scrive da Gmail — e il revisore Apple, che usa
        // /assistenza come Support URL — riceve un errore di consegna. Un
        // recapito che rimbalza è peggio di nessun recapito: sembra funzionare.
        for (const p of PAGINE) {
            const email = leggi(p).match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [];
            expect(email.length, `/${p} non espone alcun recapito`).toBeGreaterThan(0);
            for (const e of email) {
                expect(e, `/${p} usa una PEC come recapito`).not.toMatch(/@pec\.|@.*\.pec\./i);
            }
        }
    });

    it('tutte e tre usano lo STESSO recapito', () => {
        // Tre indirizzi diversi significano tre caselle da tenere vive; e quando
        // una muore non se ne accorge nessuno.
        const primo = (leggi('privacy').match(/[\w.+-]+@[\w.-]+\.\w+/) ?? [])[0];
        for (const p of PAGINE) {
            expect(leggi(p)).toContain(primo);
        }
    });

    it('/privacy dichiara i dati conservati sul dispositivo e lo sblocco biometrico', () => {
        // Sono due trattamenti che l'app fa davvero e che l'informativa taceva.
        const privacy = leggi('privacy');
        expect(privacy).toContain('Dati conservati sul dispositivo');
        expect(privacy).toContain('Sblocco con impronta o volto');
    });

    it('/privacy e /termini identificano il Titolare', () => {
        for (const p of ['privacy', 'termini'] as const) {
            const testo = leggi(p);
            expect(testo).toMatch(/La Favola/i);
            expect(testo).toContain('03394870616');
        }
    });

    it('le tre pagine restano PUBBLICHE', () => {
        // Se uscissero da PUBLIC_PREFIXES, gli URL dichiarati agli store
        // risponderebbero con un redirect al login.
        const regole = fs.readFileSync(
            path.join(RADICE, 'src/lib/auth/middleware-rules.ts'),
            'utf8',
        );
        for (const p of PAGINE) expect(regole).toContain(`'/${p}'`);
    });
});
