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

/**
 * Il file SENZA commenti: è ciò che l'utente legge davvero.
 *
 * Serve perché i commenti di quelle pagine CITANO le formule sbagliate per
 * spiegare perché sono state tolte («utilizzando il servizio dichiari di
 * accettare», la piattaforma ODR chiusa). Un lock che cercasse quelle stringhe
 * nel file intero fallirebbe sulla documentazione della correzione invece che
 * sulla correzione: verificherebbe il contrario di quello che intende.
 */
function leggiTesto(p: string): string {
    return leggi(p)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');
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

    // ── Correzioni sostanziali del 2026-07-31 ────────────────────────────────
    // Non sono preferenze di stile: sono i punti che rendevano i due documenti
    // sbagliati, e sono anche quelli che un domani si reintroducono da soli
    // copiando un modello generico trovato altrove.

    it('/privacy NON fonda i dati sanitari sul consenso (art. 9.2.a)', () => {
        // Un consenso «obbligato» non è libero: se non comunichi l'allergia, la
        // Scuola non può preparare il pasto in sicurezza. E un consenso non
        // libero non è una base giuridica — fondarci sopra il trattamento di
        // dati sanitari di minori significa trattarli SENZA base.
        const privacy = leggiTesto('privacy');
        expect(privacy).not.toMatch(/lett\.?\s*a\s*GDPR[^)]*salute|salute[^.]{0,120}lett\.?\s*a\s*GDPR/i);
        expect(privacy).toContain('lett. g GDPR');
        expect(privacy).toContain('2-sexies');
        expect(privacy).toContain('non viene richiesto il consenso');
    });

    it('/privacy dichiara il consenso SOLO per foto e video', () => {
        const privacy = leggi('privacy');
        expect(privacy).toMatch(/fotografie e video[\s\S]{0,400}consenso/i);
        // …e che rifiutarlo non pregiudica il servizio: è ciò che lo rende libero.
        expect(privacy).toMatch(/non pregiudicano in alcun modo/i);
    });

    it('/privacy nomina Apple/APNs fra i destinatari', () => {
        // Le notifiche iOS transitano da APNs: tacere un destinatario noto è la
        // stessa omissione, in piccolo, già corretta sui trasferimenti.
        expect(leggi('privacy')).toContain('APNs');
    });

    it('/termini non usa la formula che non vincola nessuno', () => {
        // «Utilizzando il servizio dichiari di accettare» non è un'accettazione:
        // senza consenso espresso la limitazione di responsabilità non protegge.
        const termini = leggiTesto('termini');
        expect(termini).not.toMatch(/utilizzando il servizio.{0,60}accett/i);
        expect(termini).toMatch(/accettati\s*\{?'?\s*<strong>espressamente|espressamente<\/strong>/i);
    });

    it('/termini salva le norme inderogabili a tutela del consumatore', () => {
        // Il genitore verso una paritaria è un consumatore (Cass. 10910/2017):
        // le esclusioni di responsabilità per inadempimento sono NULLE.
        const termini = leggi('termini');
        expect(termini).toContain('Codice del Consumo');
        expect(termini).toMatch(/Nulla nei presenti termini esclude o limita/i);
        expect(termini).toContain('66-bis');
    });

    it('/termini NON rimanda alla piattaforma ODR europea, che è chiusa', () => {
        // Reg. UE 2024/3228: la piattaforma ODR non esiste più dal 20/07/2025.
        // Rinviarci sarebbe mandare un consumatore su una porta murata.
        expect(leggiTesto('termini')).not.toMatch(/ec\.europa\.eu\/consumers\/odr|piattaforma ODR/i);
    });

    it('nessuna pagina pubblica un segnaposto da completare', () => {
        for (const p of PAGINE) {
            expect(leggiTesto(p), `/${p} contiene un segnaposto`).not.toMatch(/DA COMPLETARE|■|TODO:/);
        }
    });

    it('la versione dei testi coincide con le costanti usate per la prova di accettazione', () => {
        // Se il testo cambia e la costante no, il genitore accetta un documento
        // e nel registro dei consensi ne risulta un altro: la prova si svuota.
        const versioni = fs.readFileSync(path.join(RADICE, 'src/lib/legal/versioni.ts'), 'utf8');
        expect(versioni).toMatch(/VERSIONE_PRIVACY = '2026-07-31'/);
        expect(versioni).toMatch(/VERSIONE_TERMINI = '2026-07-31'/);
        expect(leggi('privacy')).toContain('VERSIONE_PRIVACY');
        expect(leggi('termini')).toContain('VERSIONE_TERMINI');
    });
});
