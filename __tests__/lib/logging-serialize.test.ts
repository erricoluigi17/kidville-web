import { describe, it, expect } from 'vitest';
import { serializza, descriviErrore, sanificaMessaggio } from '@/lib/logging/serialize';

describe('serializza — non lancia MAI', () => {
    it('regge un oggetto ciclico', () => {
        const c: Record<string, unknown> = { a: 1 };
        c.self = c;
        expect(() => serializza(c)).not.toThrow();
    });

    it('regge BigInt e Symbol (JSON.stringify li rifiuta)', () => {
        expect(() => serializza({ n: BigInt(10), s: Symbol('x') })).not.toThrow();
    });

    it('tronca alla dimensione massima', () => {
        const out = serializza({ x: 'a'.repeat(10_000) }, 200);
        expect(out.length).toBeLessThanOrEqual(200);
    });

    it('su input impossibile ritorna un segnaposto, non un throw', () => {
        const cattivo = { get boom() { throw new Error('no'); } };
        expect(() => serializza(cattivo)).not.toThrow();
    });
});

describe('serializza — fedeltà del contenuto', () => {
    it('marca il ciclo ma conserva il resto dell\'oggetto', () => {
        const c: Record<string, unknown> = { a: 1 };
        c.self = c;
        const out = serializza(c);
        expect(out).toContain('"a":1');
        expect(out).toContain('[ciclo]');
    });

    it('NON scambia un riferimento condiviso per un ciclo', () => {
        // `{ a: x, b: x }` non è ciclico: x compare due volte, ma non contiene sé stesso.
        // Un WeakSet globale lo marcherebbe `[ciclo]` e il dato sparirebbe dal log.
        const x = { id: 7 };
        const out = serializza({ a: x, b: x });
        expect(out).toBe('{"a":{"id":7},"b":{"id":7}}');
    });

    it('rende BigInt e Symbol in forma leggibile', () => {
        const out = serializza({ n: BigInt(10), s: Symbol('x'), f: () => 1 });
        expect(out).toContain('"10n"');
        expect(out).toContain('[symbol]');
        expect(out).toContain('[function]');
    });

    it('rispetta il cap anche quando è più corto del segnaposto di troncamento', () => {
        expect(serializza({ x: 'lungo' }, 1).length).toBeLessThanOrEqual(1);
    });
});

describe('descriviErrore', () => {
    it('estrae messaggio e stack da un Error', () => {
        const e = new Error('esploso');
        const d = descriviErrore(e);
        expect(d.messaggio).toBe('esploso');
        expect(d.stack).toContain('Error: esploso');
    });

    it('accetta anche un non-Error senza lanciare', () => {
        expect(descriviErrore('stringa').messaggio).toBe('stringa');
        expect(descriviErrore(null).messaggio).toBe('null');
        expect(descriviErrore({ code: 'PGRST204', message: 'colonna assente' }).messaggio)
            .toBe('colonna assente');
    });

    it('propaga il digest degli errori Server Component', () => {
        const e = Object.assign(new Error('x'), { digest: 'abc123' });
        expect(descriviErrore(e).digest).toBe('abc123');
    });

    it('tronca lo stack a un numero limitato di frame', () => {
        const e = new Error('x');
        e.stack = 'Error: x\n' + Array.from({ length: 50 }, (_, i) => `    at f${i}`).join('\n');
        expect(descriviErrore(e).stack!.split('\n').length).toBeLessThanOrEqual(11);
    });
});

describe('sanificaMessaggio — il messaggio d\'errore non aggira la redazione', () => {
    it('maschera il valore nel pattern Postgres `Key (colonna)=(valore)`', () => {
        const msg = 'duplicate key value violates unique constraint "parents_email_key"\n'
            + 'DETAIL: Key (email)=(mario.rossi@example.com) already exists.';
        const out = sanificaMessaggio(msg);
        expect(out).not.toContain('mario.rossi@example.com');
        expect(out).toContain('Key (email)=(…)');
        // Ciò che serve a diagnosticare resta: il vincolo violato e la colonna.
        expect(out).toContain('parents_email_key');
        expect(out).toContain('already exists');
    });

    it('maschera il valore del vincolo qualunque sia la colonna', () => {
        const out = sanificaMessaggio('Key (telefono, codice_fiscale)=(3331234567, RSSMRA85T10A562S) already exists.');
        expect(out).toBe('Key (telefono, codice_fiscale)=(…) already exists.');
    });

    it('maschera gli indirizzi email', () => {
        const out = sanificaMessaggio('invio fallito a mario.rossi+kv@sub.example.co.uk: 550');
        expect(out).toBe('invio fallito a [email]: 550');
    });

    it('maschera i codici fiscali in forma canonica', () => {
        const out = sanificaMessaggio('alunno RSSMRA85T10A562S non trovato');
        expect(out).toBe('alunno [cf] non trovato');
    });

    it('tronca a 500 caratteri', () => {
        expect(sanificaMessaggio('x'.repeat(2_000)).length).toBeLessThanOrEqual(500);
    });

    it('lascia intatto un messaggio senza dati personali', () => {
        expect(sanificaMessaggio('relation "alunni" does not exist')).toBe('relation "alunni" does not exist');
    });
});

describe('descriviErrore — applica la sanificazione a ogni messaggio', () => {
    const pg = 'duplicate key value violates unique constraint "parents_email_key"\n'
        + 'DETAIL: Key (email)=(mario.rossi@example.com) already exists.';

    it('sanifica il messaggio di un Error', () => {
        expect(descriviErrore(new Error(pg)).messaggio).not.toContain('mario.rossi@example.com');
    });

    it('sanifica il messaggio di un oggetto PostgREST', () => {
        const d = descriviErrore({ code: '23505', message: pg });
        expect(d.codice).toBe('23505');
        expect(d.messaggio).not.toContain('mario.rossi@example.com');
    });

    it('sanifica una stringa nuda lanciata come errore', () => {
        expect(descriviErrore('contatta mario.rossi@example.com').messaggio)
            .toBe('contatta [email]');
    });

    it('sanifica anche il dump di un oggetto senza `message`', () => {
        expect(descriviErrore({ dettaglio: 'mario.rossi@example.com' }).messaggio)
            .not.toContain('mario.rossi@example.com');
    });

    it('NON tocca lo stack: i frame restano in chiaro e per intero', () => {
        // Lo stack è fatto di path di sorgenti e nomi di funzione: nessun dato personale.
        // Sanificarlo (troncamento a 500 compreso) renderebbe il logger inutile proprio
        // quando serve. Frame realistici, > 500 caratteri in totale.
        const frame = (n: number) =>
            `    at handler${n} (/var/task/.next/server/app/api/anagrafiche/parents/route.js:${n}:42)`;
        const e = new Error('x');
        e.stack = 'Error: x\n' + [1, 2, 3, 4, 5, 6].map(frame).join('\n');
        const d = descriviErrore(e);
        expect(d.stack).toBe(e.stack);
        expect(d.stack!.length).toBeGreaterThan(500);
    });
});
