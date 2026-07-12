import { describe, it, expect } from 'vitest';
import { redact, hashCorrelabile } from '@/lib/logging/redact';

/**
 * Campione REALE del dominio: se anche un solo valore sopravvive alla redazione,
 * il logging sta versando dati personali di minori nei log di Vercel.
 * Questo test è il gate: se è rosso, non si va in produzione.
 */
const CAMPIONE = {
    // salute (art. 9 GDPR, minori)
    allergie: 'arachidi e crostacei',
    diagnosi: 'disturbo specifico apprendimento',
    certificato_medico: 'cert-2026-0031.pdf',
    motivo: 'febbre alta',
    // testo libero
    descrizione: 'ha avuto una crisi durante la mensa',
    note: 'la mamma chiede di essere richiamata',
    testo: 'contenuto della comunicazione',
    contenuto: 'messaggio in chat',
    giudizio: 'raggiunge pienamente gli obiettivi',
    // identità
    nome: 'Mario',
    cognome: 'Rossi',
    email: 'genitore@example.com',
    codice_fiscale: 'RSSMRA80A01H501U',
    indirizzo: 'Via Roma 1',
    telefono: '3331234567',
    // sicurezza e valore legale
    password: 'Segreta.2026!',
    token: 'eyJhbGciOiJIUzI1NiJ9',
    code: '482913',
    firma: 'base64-della-firma-FEA',
    iban: 'IT60X0542811101000000123456',
    // valutazione (numerica: NON deve passare solo perché è un numero)
    voto: 7,
    valutazione: 9,
};

describe('redact — lista bianca', () => {
    it('nessun valore del campione sopravvive', () => {
        const redatto = redact(CAMPIONE) as Record<string, unknown>;
        const out = JSON.stringify(redatto);
        for (const [chiave, valore] of Object.entries(CAMPIONE)) {
            const cercato = String(valore);

            // Controllo puntuale: il valore redatto della chiave non contiene l'originale.
            // Vale per TUTTI i valori, compresi i numerici (voto: 7 → "[redatto]").
            expect(
                JSON.stringify(redatto[chiave]),
                `il valore di "${chiave}" è sopravvissuto`,
            ).not.toContain(cercato);

            // Controllo globale (più forte: intercetta anche un leak sotto un'ALTRA chiave).
            // Applicabile solo se la stringa cercata è abbastanza lunga da essere un segnale:
            // per i numeri a una cifra la ricerca per sottostringa sull'intero JSON è priva di
            // significato, perché le cifre compaiono per forza nei METADATI di redazione
            // (le lunghezze in "[redatto:str/17]", le cifre esadecimali degli hash).
            if (cercato.length >= 4) {
                expect(out, `il valore di "${chiave}" è sopravvissuto`).not.toContain(cercato);
            }
        }
    });

    it('conserva la FORMA: chiavi presenti, tipo e lunghezza delle stringhe', () => {
        const out = redact({ note: 'ciao' }) as Record<string, string>;
        expect(Object.keys(out)).toEqual(['note']);
        expect(out.note).toBe('[redatto:str/4]');
    });

    it('lascia in chiaro ciò che serve al debug e non identifica nessuno', () => {
        const out = redact({
            id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
            section_id: 'd53b0fbc-a9eb-4073-b302-73d1d5abd529',
            tipo: 'assenza',
            stato: 'confermato',
            azione: 'insert',
            periodo: '2026-07',
            attivo: true,
            quantita: 3,
        }) as Record<string, unknown>;
        expect(out.id).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
        expect(out.section_id).toBe('d53b0fbc-a9eb-4073-b302-73d1d5abd529');
        expect(out.tipo).toBe('assenza');
        expect(out.stato).toBe('confermato');
        expect(out.azione).toBe('insert');
        expect(out.periodo).toBe('2026-07');
        expect(out.attivo).toBe(true);
        expect(out.quantita).toBe(3);
    });

    it('nome/cognome/email diventano un hash STABILE (correlabile, non identificante)', () => {
        const a = redact({ email: 'genitore@example.com' }) as Record<string, string>;
        const b = redact({ email: 'genitore@example.com' }) as Record<string, string>;
        const c = redact({ email: 'altro@example.com' }) as Record<string, string>;
        expect(a.email).toBe(b.email);          // stabile → posso dire "è sempre lo stesso"
        expect(a.email).not.toBe(c.email);      // distingue persone diverse
        expect(a.email).not.toContain('genitore');
        expect(a.email).toMatch(/^#[0-9a-f]{8}$/);
    });

    it('i SEGRETI spariscono anche se numerici o uuid', () => {
        const out = redact({
            voto: 7,
            token: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
            code: 482913,
        }) as Record<string, string>;
        expect(out.voto).toBe('[redatto]');
        expect(out.token).toBe('[redatto]');
        expect(out.code).toBe('[redatto]');
    });

    it('una stringa nuda (senza chiave) è sempre redatta', () => {
        expect(redact('crisi convulsiva')).toBe('[redatto:str/16]');
    });

    it('regge annidamento, array, profondità e cicli senza lanciare', () => {
        const ciclico: Record<string, unknown> = { tipo: 'x' };
        ciclico.self = ciclico;
        expect(() => redact(ciclico)).not.toThrow();
        expect(() => redact({ a: { b: { c: { d: { e: { f: 1 } } } } } })).not.toThrow();
        const arr = redact({ figli: [{ nome: 'A' }, { nome: 'B' }] }) as { figli: unknown[] };
        expect(arr.figli).toHaveLength(2);
        expect(JSON.stringify(arr)).not.toContain('"A"');
    });

    it('un testo libero che COMINCIA con una data resta redatto', () => {
        // Regressione: con un regex data non ancorato in fondo, una nota di diario
        // datata ("2026-07-12 ...") sarebbe stata giudicata "auto-descrittiva" e
        // sarebbe uscita in chiaro nei log. Passa solo il timestamp ISO puro.
        const out = redact({
            note: '2026-07-12 il bambino ha avuto una crisi convulsiva in mensa',
            creato_il: '2026-07-12T10:30:00Z',
            data: '2026-07-12',
        }) as Record<string, string>;
        expect(out.note).not.toContain('crisi');
        expect(out.note).toBe('[redatto:str/60]');
        expect(out.creato_il).toBe('2026-07-12T10:30:00Z');
        expect(out.data).toBe('2026-07-12');
    });

    it('una chiave sconosciuta con valore stringa è redatta (default chiuso)', () => {
        const out = redact({ campo_inventato_domani: 'dato sensibilissimo' }) as Record<string, string>;
        expect(out.campo_inventato_domani).toBe('[redatto:str/19]');
    });

    it('hashCorrelabile è deterministico e corto', () => {
        expect(hashCorrelabile('x')).toBe(hashCorrelabile('x'));
        expect(hashCorrelabile('x')).toMatch(/^#[0-9a-f]{8}$/);
    });
});
