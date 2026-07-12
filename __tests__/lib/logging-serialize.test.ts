import { describe, it, expect } from 'vitest';
import { serializza, descriviErrore, sanificaMessaggio } from '@/lib/logging/serialize';

/** Il messaggio con cui Postgres riporta una violazione di unicità: il valore è DENTRO il testo. */
const MSG_POSTGRES = 'duplicate key value violates unique constraint "parents_email_key"\n'
    + 'DETAIL: Key (email)=(mario.rossi@example.com) already exists.';
const EMAIL_IN_CHIARO = 'mario.rossi@example.com';

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
});

describe('serializza — il cap vale in OGNI ramo', () => {
    it('rispetta il cap anche quando è più corto del segnaposto di troncamento', () => {
        expect(serializza({ x: 'lungo' }, 1).length).toBeLessThanOrEqual(1);
    });

    it('rispetta il cap anche nel ramo di fallback "[non-serializzabile]"', () => {
        // Oggetto su cui lanciano SIA JSON.stringify (getter ostile) SIA String() (niente prototipo).
        const ostile: Record<string, unknown> = Object.create(null);
        Object.defineProperty(ostile, 'boom', {
            enumerable: true,
            get() { throw new Error('no'); },
        });
        expect(serializza(ostile, 5).length).toBeLessThanOrEqual(5);
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

describe('sanificaMessaggio — il testo dell\'errore non aggira la redazione', () => {
    it('maschera il valore nel pattern Postgres `Key (colonna)=(valore)`', () => {
        const out = sanificaMessaggio(MSG_POSTGRES);
        expect(out).not.toContain(EMAIL_IN_CHIARO);
        expect(out).toContain('Key (email)=(…)');
        // Ciò che serve a diagnosticare resta: il vincolo violato e la colonna.
        expect(out).toContain('parents_email_key');
        expect(out).toContain('already exists');
    });

    it('maschera il valore del vincolo qualunque sia la colonna', () => {
        const out = sanificaMessaggio('Key (telefono, codice_fiscale)=(3331234567, RSSMRA85T10A562S) already exists.');
        expect(out).toBe('Key (telefono, codice_fiscale)=(…) already exists.');
    });

    it('maschera il valore anche quando CONTIENE una parentesi chiusa', () => {
        const out = sanificaMessaggio('Key (indirizzo)=(Via Roma 1 (int. 3), Napoli) already exists.');
        expect(out).toBe('Key (indirizzo)=(…) already exists.');
        expect(out).not.toContain('Napoli');
    });

    it('maschera gli indirizzi email', () => {
        const out = sanificaMessaggio('invio fallito a mario.rossi+kv@sub.example.co.uk: 550');
        expect(out).toBe('invio fallito a [email]: 550');
    });

    it('maschera anche le email con lettere accentate', () => {
        const out = sanificaMessaggio('invio fallito a maría.rossì@example.com: 550');
        expect(out).toBe('invio fallito a [email]: 550');
    });

    it('maschera i codici fiscali in forma canonica', () => {
        expect(sanificaMessaggio('alunno RSSMRA85T10A562S non trovato')).toBe('alunno [cf] non trovato');
    });

    it('maschera i codici fiscali con omocodia (cifre sostituite da lettere)', () => {
        expect(sanificaMessaggio('alunno RSSMRA85T1LA562S non trovato')).toBe('alunno [cf] non trovato');
    });

    it('tronca a 500 caratteri', () => {
        expect(sanificaMessaggio('x'.repeat(2_000)).length).toBeLessThanOrEqual(500);
    });

    it('regge un messaggio enorme senza impiegare un tempo assurdo', () => {
        // Il regex dell'email fa backtracking: senza pre-taglio, un dump da megabyte lo
        // farebbe girare sull'intero input dentro il percorso di logging.
        const inizio = Date.now();
        sanificaMessaggio('a'.repeat(2_000_000) + '@' + 'b'.repeat(2_000_000));
        expect(Date.now() - inizio).toBeLessThan(200);
    });

    it('lascia intatto un messaggio senza dati personali', () => {
        expect(sanificaMessaggio('relation "alunni" does not exist')).toBe('relation "alunni" does not exist');
    });
});

describe('descriviErrore — la sanificazione copre OGNI campo di testo', () => {
    it('su un Error REALE l\'email non compare da NESSUNA parte', () => {
        // Il caso vero: `new Error(msg)` mette il messaggio nell'HEADER dello stack
        // (`Error: <message>`). Sanificare il solo campo `messaggio` è decorativo.
        const e = new Error(MSG_POSTGRES);
        const d = descriviErrore(e);

        expect(d.messaggio).not.toContain(EMAIL_IN_CHIARO);
        expect(d.stack).not.toContain(EMAIL_IN_CHIARO);
        expect(JSON.stringify(d)).not.toContain(EMAIL_IN_CHIARO);
        // …e ciò che serve a debuggare è ancora tutto lì.
        expect(d.stack).toContain('Key (email)=(…)');
        expect(d.stack).toContain('parents_email_key');
        expect(d.stack).toMatch(/\n\s+at /);
    });

    it('su un errore PostgREST reale sanifica `details` e `hint`', () => {
        // Con supabase-js il `DETAIL: Key (…)=(…)` arriva in `details`, non in `message`.
        const pgErr = {
            code: '23505',
            message: 'duplicate key value violates unique constraint "parents_email_key"',
            details: `Key (email)=(${EMAIL_IN_CHIARO}) already exists.`,
            hint: 'contattare mario.rossi@example.com',
        };
        const d = descriviErrore(pgErr);

        expect(d.codice).toBe('23505');
        expect(d.dettagli).toBe('Key (email)=(…) already exists.');
        expect(d.suggerimento).toBe('contattare [email]');
        expect(JSON.stringify(d)).not.toContain(EMAIL_IN_CHIARO);
    });

    it('segue `cause` di un livello e la sanifica', () => {
        const pgErr = { code: '23505', message: 'duplicate key', details: `Key (email)=(${EMAIL_IN_CHIARO})` };
        const e = new Error('salvataggio genitore fallito', { cause: pgErr });
        const d = descriviErrore(e);

        expect(d.messaggio).toBe('salvataggio genitore fallito');
        expect(d.causa?.codice).toBe('23505'); // senza `cause` l'errore VERO era perduto
        expect(d.causa?.dettagli).toBe('Key (email)=(…)');
        expect(JSON.stringify(d)).not.toContain(EMAIL_IN_CHIARO);
    });

    it('non insegue una catena di cause all\'infinito', () => {
        const a: Error & { cause?: unknown } = new Error('a');
        const b: Error & { cause?: unknown } = new Error('b');
        a.cause = b;
        b.cause = a;
        expect(() => descriviErrore(a)).not.toThrow();
        expect(descriviErrore(a).causa?.causa).toBeUndefined();
    });

    it('sanifica una stringa nuda lanciata come errore', () => {
        expect(descriviErrore('contatta mario.rossi@example.com').messaggio).toBe('contatta [email]');
    });

    it('sanifica anche il dump di un oggetto senza `message`', () => {
        expect(descriviErrore({ dettaglio: EMAIL_IN_CHIARO }).messaggio).not.toContain(EMAIL_IN_CHIARO);
    });
});

describe('descriviErrore — lo stack: frame intatti, ma sotto controllo', () => {
    it('NON tocca i frame: restano in chiaro e per intero', () => {
        // I frame sono path di sorgenti e nomi di funzione: nessun dato personale.
        // Sanificarli (troncamento a 500 compreso) renderebbe il logger inutile.
        const frame = (n: number) =>
            `    at handler${n} (/var/task/.next/server/app/api/anagrafiche/parents/route.js:${n}:42)`;
        const e = new Error('x');
        e.stack = 'Error: x\n' + [1, 2, 3, 4, 5, 6, 7, 8].map(frame).join('\n');
        const d = descriviErrore(e);

        expect(d.stack).toBe(e.stack);
        expect(d.stack!.length).toBeGreaterThan(500); // il cap del messaggio NON si applica qui
    });

    it('conta i FRAME, non le righe: un header multi-riga non se li mangia', () => {
        const e = new Error('x');
        e.stack = 'Error: riga1\nriga2 di header\nriga3 di header\n'
            + Array.from({ length: 20 }, (_, i) => `    at f${i} (/app/x.js:${i}:1)`).join('\n');
        const frame = descriviErrore(e).stack!.split('\n').filter((r) => r.trimStart().startsWith('at '));

        expect(frame.length).toBe(10); // contando le righe sarebbero stati 8
    });

    it('mette un cap in CARATTERI sui FRAME', () => {
        // Il messaggio gonfio è già contenuto dalla sanificazione dell'header (cap 500).
        // I FRAME no: bastano 10 frame con path lunghi per sfondare da soli il budget della
        // riga di log, e il conteggio dei frame non dice nulla sulla loro lunghezza.
        const e = new Error('x');
        e.stack = 'Error: x\n' + Array.from(
            { length: 10 },
            (_, i) => `    at f${i} (/var/task/${'sottocartella/'.repeat(30)}route.js:1:1)`,
        ).join('\n');

        expect(e.stack.length).toBeGreaterThan(4_000);
        expect(descriviErrore(e).stack!.length).toBeLessThanOrEqual(2_000);
    });

    it('contiene anche lo stack di un Error con un messaggio gonfio', () => {
        // `new Error('payload: ' + 'A'.repeat(20_000))` produce uno stack da ~20 KB, in un
        // modulo che esiste per stare sotto i 3.500 caratteri di riga.
        const e = new Error('payload: ' + 'A'.repeat(20_000));
        expect(e.stack!.length).toBeGreaterThan(20_000);
        expect(descriviErrore(e).stack!.length).toBeLessThanOrEqual(2_000);
    });
});

describe('descriviErrore — un campo rotto non azzera la riga di log', () => {
    it('un getter `stack` che lancia non fa perdere il messaggio', () => {
        const e = new Error('salvataggio fallito');
        Object.defineProperty(e, 'stack', { get() { throw new Error('stack ostile'); } });
        const d = descriviErrore(e);

        expect(d.messaggio).toBe('salvataggio fallito'); // il messaggio era leggibilissimo
        expect(d.stack).toBe('[campo-illeggibile]');
    });

    it('un `code` con toString rotto non fa perdere il messaggio', () => {
        const cattivo = {
            message: 'colonna assente',
            code: { toString() { throw new Error('no'); } },
        };
        const d = descriviErrore(cattivo);

        expect(d.messaggio).toBe('colonna assente');
        expect(d.codice).toBe('[campo-illeggibile]');
    });
});
