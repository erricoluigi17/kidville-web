import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import itShared from '../../messages/it/shared.json';
import enShared from '../../messages/en/shared.json';

/**
 * Galleria docente — l'errore del server si legge nella lingua dell'interfaccia.
 *
 * ─── IL DIFETTO (verificatore adversariale, 2026-08-03 — W5) ────────────────
 * `src/app/(dashboard)/teacher/gallery/page.tsx` mostrava gli errori così:
 *
 *     const errData = await res.json();
 *     alert(errData.error || t('galleryErrTag'));
 *
 * cioè la PROSA del server, che nasce in italiano dentro una route dove il
 * locale non esiste. Con l'interfaccia in inglese una maestra leggeva
 * «Uno o più bambini taggati non appartengono ai tuoi plessi.» — e il `codice`
 * che serviva a tradurla (`TAG_FUORI_SEDE`) viaggiava nella stessa risposta,
 * con le chiavi già presenti in `messages/it` e `messages/en`. Nessuno le
 * leggeva. È lo stesso difetto già chiuso su avvisi, tasks e allegati con
 * `messaggioErrore` (`src/lib/ui/esito-fetch.ts`): qui la funzione non era mai
 * arrivata.
 *
 * ─── IL CONTRATTO ──────────────────────────────────────────────────────────
 * Ogni messaggio d'errore che nasce da una RISPOSTA del server passa da
 * `messaggioErrore`: con `<html lang="en">` esce la frase inglese di catalogo,
 * con `lang="it"` quella italiana, e senza `codice` resta la prosa del server
 * (che è comunque meglio del silenzio). Gli `alert` che NON leggono una
 * risposta — «Tag aggiornati», «Media eliminato», gli errori di rete — sono già
 * `t(...)` e restano tali: farli passare da `messaggioErrore` non avrebbe senso,
 * perché non c'è nessuna `Response` da leggere.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), alert: vi.fn() }));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(''),
    useParams: () => ({}),
    usePathname: () => '/teacher/gallery',
}));
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: 'aaaa1111-0000-4000-8000-000000000001', role: 'educator', ready: true }),
}));
// La coda offline apre IndexedDB: fuori tema, e non esiste in jsdom.
vi.mock('@/lib/offline/syncEngine', () => ({
    saveLocalGalleryMedia: vi.fn(async () => undefined),
    syncPendingGalleryMedia: vi.fn(async () => undefined),
}));
vi.mock('@/lib/offline/db', () => ({}));

const SEZIONE = 'TEST Infanzia';
const ALUNNO = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Mario', cognome: 'Rossi', consenso_privacy: true };
const MEDIA = {
    id: 'cccc3333-0000-4000-8000-000000000003',
    file_url: 'https://esempio.test/foto.jpg',
    file_type: 'image',
    caption: 'Gita al parco',
    tag_students: [] as string[],
    is_broadcast: false,
    created_at: '2026-08-03T10:00:00.000Z',
    uploader_name: 'Maestra Anna',
};

/** La prosa che il server manda accanto al codice: italiana per costruzione. */
const PROSA_SERVER = 'Uno o più bambini taggati non appartengono ai tuoi plessi.';

let rispostaPatch: { status: number; body: Record<string, unknown> };
let rispostaDelete: { status: number; body: Record<string, unknown> };
const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.setAttribute('lang', 'en');
    rispostaPatch = { status: 403, body: { error: PROSA_SERVER, codice: 'TAG_FUORI_SEDE' } };
    rispostaDelete = { status: 403, body: { error: 'Media fuori dal tuo plesso', codice: 'SEDE_NON_ACCESSIBILE' } };
    vi.stubGlobal('alert', h.alert);
    vi.stubGlobal('confirm', () => true);
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url);
        const metodo = init?.method ?? 'GET';
        if (u.includes('/api/educator-sections')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ sectionNames: [SEZIONE] }) });
        }
        if (u.includes('/api/diary/students')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => [ALUNNO] });
        }
        if (u.includes('/api/me')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ ruolo: 'educator' }) });
        }
        if (u.includes('/api/gallery') && metodo === 'PATCH') {
            return Promise.resolve(new Response(JSON.stringify(rispostaPatch.body), { status: rispostaPatch.status }));
        }
        if (u.includes('/api/gallery') && metodo === 'DELETE') {
            return Promise.resolve(new Response(JSON.stringify(rispostaDelete.body), { status: rispostaDelete.status }));
        }
        if (u.includes('/api/gallery')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ media: [MEDIA], total: 1 }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    document.documentElement.setAttribute('lang', 'it');
});

import TeacherGalleryPage from '@/app/(dashboard)/teacher/gallery/page';

/** Apre la galleria, il lightbox della foto, e salva una modifica ai tag. */
async function salvaTag() {
    render(<TeacherGalleryPage />);
    await waitFor(() => expect(screen.getByAltText(MEDIA.caption)).toBeInTheDocument());
    fireEvent.click(screen.getByAltText(MEDIA.caption));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itShared.galleryModificaTag) }));
    fireEvent.click(screen.getByText(`${ALUNNO.nome} ${ALUNNO.cognome}`));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${itShared.gallerySalva}$`) }));
    await waitFor(() => expect(h.alert).toHaveBeenCalled());
}

/** Apre il lightbox e chiede l'eliminazione del media. */
async function eliminaMedia() {
    render(<TeacherGalleryPage />);
    await waitFor(() => expect(screen.getByAltText(MEDIA.caption)).toBeInTheDocument());
    fireEvent.click(screen.getByAltText(MEDIA.caption));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itShared.galleryEliminaMedia) }));
    await waitFor(() => expect(h.alert).toHaveBeenCalled());
}

const testoAvviso = () => String(h.alert.mock.calls.at(-1)?.[0] ?? '');

describe('Galleria docente — il rifiuto del server si legge nella lingua dell’interfaccia', () => {
    it('PATCH 403 con `codice`, interfaccia EN: la frase è quella inglese di catalogo', async () => {
        await salvaTag();
        expect(testoAvviso()).toBe(enShared.erroreTagFuoriSede);
        // …e NON la prosa italiana che il server manda accanto al codice.
        expect(testoAvviso()).not.toContain(PROSA_SERVER);
    });

    it('…e con interfaccia IT esce la frase italiana di catalogo (non è cablato l’inglese)', async () => {
        document.documentElement.setAttribute('lang', 'it');
        await salvaTag();
        expect(testoAvviso()).toBe(itShared.erroreTagFuoriSede);
    });

    it('DELETE 403 con `codice`: stesso trattamento, non solo sui tag', async () => {
        await eliminaMedia();
        expect(testoAvviso()).toBe(enShared.erroreSedeNonAccessibile);
    });

    it('senza `codice` resta la prosa del server (meglio della frase generica)', async () => {
        rispostaPatch = { status: 500, body: { error: 'Errore imprevisto del provider' } };
        await salvaTag();
        expect(testoAvviso()).toBe('Errore imprevisto del provider');
    });

    it('corpo vuoto o non-JSON ⇒ il ripiego tradotto, mai la stringa vuota', async () => {
        fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
            const u = String(url);
            const metodo = init?.method ?? 'GET';
            if (u.includes('/api/educator-sections')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({ sectionNames: [SEZIONE] }) });
            }
            if (u.includes('/api/diary/students')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => [ALUNNO] });
            }
            if (u.includes('/api/me')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({ ruolo: 'educator' }) });
            }
            if (u.includes('/api/gallery') && metodo === 'PATCH') {
                return Promise.resolve(new Response('<html>502</html>', { status: 502 }));
            }
            if (u.includes('/api/gallery')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({ media: [MEDIA], total: 1 }) });
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        });
        await salvaTag();
        expect(testoAvviso().trim()).not.toBe('');
        expect(testoAvviso()).not.toContain('<html>');
    });

    it('il fallimento resta OSSERVABILE: il log c’è, e non porta il corpo della risposta', async () => {
        await salvaTag();
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', route: '/teacher/gallery', stato: 403 }),
        );
        const scritto = JSON.stringify(h.logClient.mock.calls);
        expect(scritto).not.toContain(PROSA_SERVER);
        expect(scritto).not.toContain(ALUNNO.cognome);
    });

    it('CONTROLLO POSITIVO — PATCH 200: l’avviso è quello di successo, non un errore', async () => {
        rispostaPatch = { status: 200, body: { id: MEDIA.id } };
        await salvaTag();
        expect(testoAvviso()).not.toBe(enShared.erroreTagFuoriSede);
        expect(testoAvviso()).not.toContain(PROSA_SERVER);
    });
});
