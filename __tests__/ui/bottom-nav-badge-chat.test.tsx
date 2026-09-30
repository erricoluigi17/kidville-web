import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

/**
 * IL NUMERO DEI MESSAGGI NON LETTI SU «MESSAGGI» E «CHAT» (passo 4, 2026-09-29).
 *
 * Una maestra ha ricevuto due messaggi alle 10:52, ha usato l'app tre volte senza aprire la chat e
 * li ha visti alle 16:14: fuori dalla pagina «Messaggi» non esisteva nessun contatore, e la
 * campanella era così gonfia da essere ignorata. Da qui il badge sulla barra in basso, che si vede
 * da qualunque schermata.
 *
 * Questo file misura le quattro cose che in questo punto dell'app si rompono in silenzio:
 *
 *  1. IL NOME ACCESSIBILE DEL LINK NON CAMBIA. Un `aria-label="Messaggi, 3 non letti"` sostituisce
 *     il contenuto: sulle WebView Android quel nome esce come `content-desc` e i flow Maestro
 *     toccano le voci PER TESTO (`.claude/maestro-flows/android-percorso-genitore.yaml`, dove il
 *     quinto tab è stato sbagliato due volte proprio per questo). Il numero va quindi in una
 *     DESCRIZIONE (`aria-describedby`), che si aggiunge al nome invece di prenderne il posto.
 *  2. IL PLURALE. Il badge mostra «9+» oltre il nove: la frase della descrizione è l'unico posto in
 *     cui il numero è detto per intero, e «3 messaggi non letto» lo sentirebbe solo chi già fa più
 *     fatica a leggere.
 *  3. L'ORDINE DEI FIGLI. `e2e/primaria-360/journeys/89-fix-360.spec.ts` capisce quale voce è
 *     attiva leggendo il colore di `tab.querySelector('span:last-child')`, cioè dell'ETICHETTA.
 *     Uno span nuovo che diventasse il primo `span:last-child` in ordine di documento farebbe
 *     misurare il colore sbagliato — e quel test non si romperebbe: cambierebbe risposta.
 *  4. NESSUNA RICHIESTA IN PIÙ. Le barre leggono solo lo store, e due lock contano le chiamate che
 *     fanno (`teacher-nav-gradi-una-chiamata`, `parent-figli-una-chiamata`).
 */

const stub = vi.hoisted(() => ({
    pathname: '/teacher',
    params: new URLSearchParams(),
    router: { push: () => {}, replace: () => {}, refresh: () => {} },
}));

vi.mock('next/navigation', () => ({
    usePathname: () => stub.pathname,
    useSearchParams: () => stub.params,
    useRouter: () => stub.router,
}));

type Store = typeof import('@/components/features/chat/contatore-non-letti');

let fetchMock: ReturnType<typeof vi.fn>;

/** Le due barre non chiedono niente per il badge: qualunque risposta va bene. */
function reteMuta() {
    fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { gradi: ['infanzia'], ruolo: 'teacher' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
}

/**
 * Store e barra dallo STESSO registro dei moduli (il contatore è stato di MODULO), col valore già
 * scritto PRIMA del render: è la situazione vera — la campanella scrive il numero e la barra, montata
 * su ogni pagina, lo legge.
 */
async function montaBarra(area: 'teacher' | 'parent', nonLetti: number | null) {
    vi.resetModules();
    const store = (await import('@/components/features/chat/contatore-non-letti')) as Store;
    if (nonLetti !== null) store.impostaChatNonLettiDalServer(nonLetti, store.sequenzaChatNonLetti());
    const Barra =
        area === 'teacher'
            ? (await import('@/components/features/teacher/TeacherBottomNav')).default
            : (await import('@/components/features/parent/BottomNav')).default;
    const vista = render(<Barra />);
    return { store, ...vista };
}

/** Il nome della voce che porta il badge, per area. */
const VOCE = { teacher: 'Messaggi', parent: 'Chat' } as const;

function badge(): HTMLElement | null {
    return screen.queryByTestId('badge-chat-non-letti');
}

/**
 * La descrizione accessibile del link. Si usa `toHaveAccessibleDescription` di jest-dom, che passa
 * da `dom-accessibility-api` — cioè dall'ALGORITMO accname, lo stesso che applicano gli screen
 * reader e il ponte di Android. Leggere `aria-describedby` e poi il `textContent` dell'id proverebbe
 * solo che i due attributi si toccano: non che quella frase arrivi davvero alla descrizione. La
 * differenza non è teorica — `hidden` è esattamente il caso in cui l'algoritmo decide, perché un
 * nodo nascosto entra nel calcolo SOLO se è referenziato.
 */
function atteseDescrizione(area: 'teacher' | 'parent', frase: string) {
    return expect(screen.getByRole('link', { name: VOCE[area] })).toHaveAccessibleDescription(frase);
}

/**
 * La query di `89-fix-360.spec.ts`, riprodotta parola per parola: per ogni voce della barra, il
 * primo `span:last-child` in ordine di documento.
 */
function spanDelColore(container: HTMLElement): string[] {
    const nav = container.querySelector('nav');
    if (!nav) throw new Error('la barra non ha un <nav>');
    return Array.from(nav.children).map(
        (tab) => tab.querySelector('span:last-child')?.textContent?.trim() ?? '(nessuno)',
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    stub.pathname = '/teacher';
    stub.params = new URLSearchParams();
    reteMuta();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    ['teacher', '/teacher'],
    ['parent', '/parent'],
] as const)('barra in basso %s — il badge dei messaggi non letti', (area, percorso) => {
    beforeEach(() => {
        stub.pathname = percorso;
    });

    it('con 3 non letti il badge mostra 3, e il nome del link resta quello', async () => {
        const { container } = await montaBarra(area, 3);

        expect(badge()).toHaveTextContent('3');
        // Il NOME non cambia: è quello che i flow Maestro toccano per testo.
        const link = screen.getByRole('link', { name: VOCE[area] });
        expect(link).toBeInTheDocument();
        // Il numero sta nella DESCRIZIONE, col plurale giusto.
        expect(link).toHaveAccessibleDescription('3 messaggi non letti');
        // Il badge non è pronunciato due volte.
        expect(badge()).toHaveAttribute('aria-hidden', 'true');
        expect(container.querySelector('[aria-label*="non lett"]')).toBeNull();
    });

    it('con UN messaggio la descrizione è al singolare', async () => {
        await montaBarra(area, 1);
        atteseDescrizione(area, '1 messaggio non letto');
    });

    it('oltre il nove il badge dice «9+», ma la descrizione dice il numero vero', async () => {
        await montaBarra(area, 12);
        expect(badge()).toHaveTextContent('9+');
        atteseDescrizione(area, '12 messaggi non letti');
    });

    it('con 0 non letti non c\'è nessun badge e nessuna descrizione', async () => {
        await montaBarra(area, 0);
        expect(badge()).toBeNull();
        expect(screen.getByRole('link', { name: VOCE[area] })).not.toHaveAttribute('aria-describedby');
    });

    it('con `null` («non lo so») non c\'è nessun badge', async () => {
        await montaBarra(area, null);
        expect(badge()).toBeNull();
        expect(screen.getByRole('link', { name: VOCE[area] })).not.toHaveAttribute('aria-describedby');
    });

    it('il badge è il PRIMO figlio della pillola, e l\'icona resta dopo di lui', async () => {
        await montaBarra(area, 3);
        const b = badge();
        expect(b).not.toBeNull();
        const pillola = b!.parentElement!;
        expect(pillola.firstElementChild, 'il badge non è il primo figlio della pillola').toBe(b);
        expect(pillola.querySelector('svg'), 'la pillola ha perso la sua icona').not.toBeNull();
    });

    it('la query `span:last-child` dei 360 restituisce ancora l\'ETICHETTA, col badge e senza', async () => {
        const { container: senza } = await montaBarra(area, 0);
        const etichetteSenza = spanDelColore(senza);
        cleanup();
        const { container: con } = await montaBarra(area, 5);
        const etichetteCon = spanDelColore(con);

        expect(etichetteCon).toEqual(etichetteSenza);
        expect(
            etichetteCon,
            'Uno span nuovo è diventato il primo `span:last-child`: il test dei 360 leggerebbe il ' +
                'colore di un altro elemento e cambierebbe risposta invece di diventare rosso.',
        ).toContain(VOCE[area]);
        expect(etichetteCon).not.toContain('5');
        expect(etichetteCon).not.toContain('(nessuno)');
    });

    it('il badge non costa nessuna richiesta di rete', async () => {
        await montaBarra(area, 0);
        await waitFor(() => expect(screen.getByRole('link', { name: VOCE[area] })).toBeInTheDocument());
        const senza = fetchMock.mock.calls.map(([u]) => String(u));
        cleanup();
        vi.clearAllMocks();

        await montaBarra(area, 7);
        await waitFor(() => expect(badge()).not.toBeNull());
        const con = fetchMock.mock.calls.map(([u]) => String(u));

        expect(con.length, 'il badge ha aggiunto una richiesta').toBe(senza.length);
        expect(con.filter((u) => /notifiche|chat/.test(u))).toEqual([]);
    });
});
