// @vitest-environment node
/**
 * IL LINK CHE APRE UNA CONVERSAZIONE, E COSA SE NE FA IL CLIENT (parte C, 2026-09-15).
 *
 * Un modulo PURO (`src/lib/chat/link-conversazione.ts`), usato dal server che scrive il link e dai
 * client che lo ricevono: la push nativa, il centro notifiche, la web push. Una regola sola, provata
 * qui una volta invece che tre volte in tre posti.
 *
 * La parte che non si può sbagliare è il RIFIUTO. Un link di notifica finisce in `router.push` o in
 * `window.location`, e fino a oggi l'unico controllo era `link.startsWith('/')`: `'//evil.example'`
 * lo passa, ed è un indirizzo di un altro sito. Il browser, prima di leggere un URL, toglie spazi e
 * caratteri di controllo ai bordi e tab e a capo OVUNQUE — `'/\t/evil.example'` diventa
 * `'//evil.example'` — e tratta `\` come `/`. Per questo le prove qui sotto non si fidano di una lista
 * di esempi: ogni link accettato passa anche dal parser WHATWG vero (`URL` di Node), e deve restare
 * sulla stessa origine.
 */
import { describe, it, expect } from 'vitest';
import {
    PARAM_THREAD,
    instradaLinkNotifica,
    leggiIdThread,
    leggiLinkChat,
    linkConversazione,
    linkEffettivoNotifica,
} from '@/lib/chat/link-conversazione';

const T = 'dddddddd-0000-4000-8000-000000000014';
const U = 'aaaaaaaa-0000-4000-8000-000000000011';
const ORIGINE = 'https://app.kidville.example';

describe('leggiIdThread', () => {
    it('accetta la forma 8-4-4-4-12 (la stessa di zUuid) e la restituisce in minuscolo', () => {
        expect(leggiIdThread(T)).toBe(T);
        expect(leggiIdThread(T.toUpperCase())).toBe(T);
        // Gli id seedati hanno cifre ripetute e varianti non standard: zUuid li accetta, e anche qui.
        expect(leggiIdThread('e2e00000-0000-0000-0000-000000000001')).toBe('e2e00000-0000-0000-0000-000000000001');
    });

    it('rifiuta tutto il resto', () => {
        for (const v of ['abc', '', `${T} `, `${T}x`, T.slice(1), null, undefined, 42, {}]) {
            expect(leggiIdThread(v), String(v)).toBeNull();
        }
    });
});

describe('linkConversazione', () => {
    it('è la pagina chat dell’area, con il thread nella query', () => {
        expect(linkConversazione('parent', T)).toBe(`/parent/chat?${PARAM_THREAD}=${T}`);
        expect(linkConversazione('teacher', T)).toBe(`/teacher/chat?thread=${T}`);
    });

    it('scrive l’id nella forma canonica: minuscolo', () => {
        expect(linkConversazione('teacher', T.toUpperCase())).toBe(`/teacher/chat?thread=${T}`);
    });
});

describe('leggiLinkChat', () => {
    it('riconosce le due pagine chat, con o senza thread', () => {
        expect(leggiLinkChat(`/parent/chat?thread=${T}`)).toEqual({ area: 'parent', threadId: T });
        expect(leggiLinkChat(`/teacher/chat?userId=${U}&thread=${T}#fondo`)).toEqual({ area: 'teacher', threadId: T });
        expect(leggiLinkChat('/parent/chat')).toEqual({ area: 'parent', threadId: null });
    });

    it('un thread che non è un id vale «nessun thread»', () => {
        expect(leggiLinkChat('/parent/chat?thread=abc')).toEqual({ area: 'parent', threadId: null });
        expect(leggiLinkChat('/parent/chat?thread=')).toEqual({ area: 'parent', threadId: null });
    });

    it('il percorso deve essere ESATTAMENTE quello: niente somiglianze, niente altri siti', () => {
        for (const link of [
            `/parent/chatbot?thread=${T}`,
            `/parent/chat/altro?thread=${T}`,
            `/parent/chat/?thread=${T}`,
            `/admin/chat?thread=${T}`,
            `/chat?thread=${T}`,
            `//evil.example/parent/chat?thread=${T}`,
            `https://evil.example/parent/chat?thread=${T}`,
            `parent/chat?thread=${T}`,
        ]) {
            expect(leggiLinkChat(link), link).toBeNull();
        }
    });
});

describe('linkEffettivoNotifica — le notifiche già in tabella col link vecchio', () => {
    const chat = (link: string | null, extra: Record<string, unknown> = {}) => ({
        link,
        entita_tipo: 'chat_thread',
        entita_id: T,
        ...extra,
    });

    it('il link nudo della chat riprende il thread da entita_id', () => {
        expect(linkEffettivoNotifica(chat('/parent/chat'))).toBe(`/parent/chat?thread=${T}`);
        expect(linkEffettivoNotifica(chat('/teacher/chat'))).toBe(`/teacher/chat?thread=${T}`);
    });

    it('conserva il resto della query e il frammento', () => {
        expect(linkEffettivoNotifica(chat(`/teacher/chat?userId=${U}`))).toBe(`/teacher/chat?userId=${U}&thread=${T}`);
        expect(linkEffettivoNotifica(chat('/parent/chat#x'))).toBe(`/parent/chat?thread=${T}#x`);
    });

    it('un thread non valido nel link si sostituisce, non si duplica', () => {
        expect(linkEffettivoNotifica(chat('/parent/chat?thread=abc'))).toBe(`/parent/chat?thread=${T}`);
    });

    it('lascia com’è tutto ciò che non è una chat senza thread con un’entità di chat', () => {
        const altro = 'eeeeeeee-0000-4000-8000-000000000099';
        expect(linkEffettivoNotifica(chat(`/parent/chat?thread=${altro}`))).toBe(`/parent/chat?thread=${altro}`);
        expect(linkEffettivoNotifica(chat('/parent/chat', { entita_tipo: 'avviso' }))).toBe('/parent/chat');
        expect(linkEffettivoNotifica(chat('/parent/chat', { entita_id: 'non-un-id' }))).toBe('/parent/chat');
        expect(linkEffettivoNotifica(chat('/parent/chat', { entita_id: null }))).toBe('/parent/chat');
        expect(linkEffettivoNotifica({ link: '/parent/chat' })).toBe('/parent/chat');
        expect(linkEffettivoNotifica(chat('/parent/avvisi'))).toBe('/parent/avvisi');
        expect(linkEffettivoNotifica(chat(null))).toBeNull();
    });
});

describe('instradaLinkNotifica — rifiuto dei link che non sono di questa app', () => {
    const OSTILI = [
        '//evil.example/x',
        '/\\evil.example/x',
        '\\\\evil.example/x',
        '\\/evil.example/x',
        'https://evil.example/x',
        'http:evil.example',
        'javascript:alert(1)',
        'evil.example/x',
        '',
        '   ',
        ' //evil.example/x',
        '\u0000//evil.example/x',
        '/\t/evil.example/x',
        '/\n/evil.example/x',
        '/\r/evil.example/x',
        '\t//evil.example/x',
        '/.//evil.example/x',
        '/..//evil.example/x',
        '/parent/..//evil.example/x',
        '/%2e//evil.example/x',
    ];

    it.each(OSTILI)('rifiuta %j, da qualunque pagina', (link) => {
        for (const pagina of ['/parent/chat', '/teacher', '/parent/home', '/', '/admin']) {
            expect(instradaLinkNotifica(link, pagina)).toEqual({ tipo: 'rifiuta' });
        }
    });

    it('la prova non è vuota: per il parser vero, molti di quei link portano davvero fuori', () => {
        // Fuori = un'altra origine, oppure un percorso che comincia con `//`: chi lo riusasse come
        // indirizzo relativo (la `history` di Next lo fa) finirebbe su un altro host.
        const fuori = OSTILI.filter((l) => {
            try {
                const u = new URL(l, ORIGINE);
                return u.origin !== ORIGINE || u.pathname.startsWith('//');
            } catch {
                return false; // non è nemmeno un URL: il browser non ci andrebbe
            }
        });
        expect(fuori.length).toBeGreaterThanOrEqual(14);
    });

    it('ogni link accettato resta, per il parser WHATWG vero, su questa origine e con un percorso di questa origine', () => {
        const LINK = [
            ...OSTILI,
            '/parent/avvisi',
            '/parent/chat',
            `/parent/chat?thread=${T}`,
            `/teacher/chat?thread=${T}&userId=${U}`,
            '/parent/modulistica?tab=certificati#sezione',
            '/',
            '/parent/./avvisi',
            '/parent/avvisi?torna=//evil.example',
            ' /parent/avvisi ',
        ];
        for (const link of LINK) {
            for (const pagina of ['/parent/chat', '/teacher', '/parent/home', '/']) {
                const esito = instradaLinkNotifica(link, pagina);
                if (esito.tipo === 'rifiuta') continue;
                const letto = new URL(esito.url, ORIGINE);
                expect(letto.origin, `${JSON.stringify(link)} da ${pagina}`).toBe(ORIGINE);
                expect(letto.pathname.startsWith('//'), `${JSON.stringify(link)} da ${pagina}`).toBe(false);
            }
        }
    });

    it('accetta i link interni normali (anche con una query che contiene //)', () => {
        expect(instradaLinkNotifica('/parent/avvisi', '/parent')).toEqual({ tipo: 'naviga', url: '/parent/avvisi' });
        expect(instradaLinkNotifica('/parent/avvisi?torna=//x', '/parent')).toEqual({ tipo: 'naviga', url: '/parent/avvisi?torna=//x' });
        // Spazi ai bordi: il browser li toglie, e il link che parte è quello pulito.
        expect(instradaLinkNotifica(' /parent/avvisi\n', '/parent')).toEqual({ tipo: 'naviga', url: '/parent/avvisi' });
    });
});

describe('instradaLinkNotifica — dove porta un link di chat', () => {
    it('già su una pagina chat, con un thread valido: si apre la conversazione senza navigare', () => {
        expect(instradaLinkNotifica(`/parent/chat?thread=${T}`, '/parent/chat')).toEqual({
            tipo: 'apri-thread',
            threadId: T,
            url: `/parent/chat?thread=${T}`,
        });
        expect(instradaLinkNotifica(`/teacher/chat?thread=${T}`, '/teacher/chat')).toEqual({
            tipo: 'apri-thread',
            threadId: T,
            url: `/teacher/chat?thread=${T}`,
        });
    });

    it('su una pagina chat dell’ALTRA area (doppio profilo): si apre lì, e il ripiego resta nell’area in cui si è', () => {
        // La lista dei thread elenca le conversazioni in cui si è docente E quelle in cui si è genitore:
        // la conversazione si apre nella pagina già aperta, senza cambiare veste.
        expect(instradaLinkNotifica(`/parent/chat?thread=${T}&userId=${U}`, '/teacher/chat')).toEqual({
            tipo: 'apri-thread',
            threadId: T,
            url: `/teacher/chat?thread=${T}&userId=${U}`,
        });
    });

    it('fuori dalla chat ma nell’altra area: il percorso si riscrive nell’area corrente, query intatta', () => {
        expect(instradaLinkNotifica(`/parent/chat?thread=${T}`, '/teacher')).toEqual({ tipo: 'naviga', url: `/teacher/chat?thread=${T}` });
        expect(instradaLinkNotifica(`/parent/chat?thread=${T}&userId=${U}`, '/teacher/registro')).toEqual({
            tipo: 'naviga',
            url: `/teacher/chat?thread=${T}&userId=${U}`,
        });
        expect(instradaLinkNotifica(`/teacher/chat?thread=${T}`, '/parent/home')).toEqual({ tipo: 'naviga', url: `/parent/chat?thread=${T}` });
        // Anche il link vecchio, senza thread: la guardia d'area avrebbe rimandato alla home.
        expect(instradaLinkNotifica('/parent/chat', '/teacher')).toEqual({ tipo: 'naviga', url: '/teacher/chat' });
    });

    it('nella stessa area, o fuori dalle due aree della chat: si naviga al link com’è', () => {
        expect(instradaLinkNotifica(`/parent/chat?thread=${T}`, '/parent')).toEqual({ tipo: 'naviga', url: `/parent/chat?thread=${T}` });
        expect(instradaLinkNotifica(`/teacher/chat?thread=${T}`, '/teacher/registro')).toEqual({ tipo: 'naviga', url: `/teacher/chat?thread=${T}` });
        // Lo staff in /admin non ha una chat aperta, e /teacher gli è permessa.
        expect(instradaLinkNotifica(`/teacher/chat?thread=${T}`, '/admin/notifiche')).toEqual({ tipo: 'naviga', url: `/teacher/chat?thread=${T}` });
        // Avvio a freddo: la WebView è ancora sulla radice.
        expect(instradaLinkNotifica(`/parent/chat?thread=${T}`, '/')).toEqual({ tipo: 'naviga', url: `/parent/chat?thread=${T}` });
        // Un link che non è di chat non si riscrive mai.
        expect(instradaLinkNotifica('/parent/avvisi', '/teacher')).toEqual({ tipo: 'naviga', url: '/parent/avvisi' });
    });

    it('sulla pagina chat, un link di chat senza un thread valido non apre niente: si naviga', () => {
        expect(instradaLinkNotifica('/parent/chat', '/parent/chat')).toEqual({ tipo: 'naviga', url: '/parent/chat' });
        expect(instradaLinkNotifica('/parent/chat?thread=abc', '/parent/chat')).toEqual({ tipo: 'naviga', url: '/parent/chat?thread=abc' });
    });
});
