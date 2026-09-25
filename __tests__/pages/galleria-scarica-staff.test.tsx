import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

/**
 * «SCARICA» IN GALLERIA ANCHE PER DOCENTI E SEGRETERIA (spec 2026-09-24 §7, NAT3a).
 *
 * `MediaGrid` sa mostrare il solo «Scarica» con `scaricabile`; qui si verifica che
 * le DUE superfici dello staff lo chiedano davvero — la galleria del docente
 * (`/teacher/gallery`) e la vista di sede della Segreteria (`GalleriaSedeGiornate`,
 * montata da `/admin/gallery`) — e che il cestino della sede resti SENZA: una foto
 * che si è deciso di rimuovere non si distribuisce.
 *
 * Il test fallisce se si toglie `scaricabile` da uno dei due chiamanti: la prop
 * assente vale «nessuno scarico», che è il comportamento di prima.
 */

const h = vi.hoisted(() => ({
    logClient: vi.fn(),
    alert: vi.fn(),
    scaricaMedia: vi.fn(),
}));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));
vi.mock('@/lib/native/scarica', async () => {
    const vero = await vi.importActual<typeof import('@/lib/native/scarica')>('@/lib/native/scarica');
    return { ...vero, scaricaMedia: h.scaricaMedia };
});
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

import TeacherGalleryPage from '@/app/(dashboard)/teacher/gallery/page';
import { GalleriaSedeGiornate, type FotoSede } from '@/components/features/gallery/GalleriaSedeGiornate';
import itShared from '../../messages/it/shared.json';

const URL_FOTO = 'https://esempio.test/storage/v1/object/sign/gallery/uploads/x/foto.jpg?token=t';

// Dati di fantasia: nessun nome o uuid reale.
const MEDIA = {
    id: 'cccc3333-0000-4000-8000-000000000003',
    file_url: URL_FOTO,
    file_type: 'image',
    caption: 'Gita al parco',
    tag_students: [] as string[],
    is_broadcast: false,
    created_at: '2026-08-03T10:00:00.000Z',
    uploader_name: 'Insegnante',
};

const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    h.scaricaMedia.mockResolvedValue({ esito: 'nativo-galleria' });
    vi.stubGlobal('alert', h.alert);
    fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes('/api/educator-sections')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ sectionNames: ['TEST Infanzia'] }) });
        }
        if (u.includes('/api/diary/students')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => [] });
        }
        if (u.includes('/api/me')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ ruolo: 'educator' }) });
        }
        if (u.includes('/api/gallery')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ media: [MEDIA], total: 1 }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('Galleria docente — «Scarica» c’è, Condividi no', () => {
    it('la card e il visore del docente scaricano con l’helper; niente Condividi', async () => {
        render(<TeacherGalleryPage />);
        await waitFor(() => expect(screen.getByAltText(MEDIA.caption)).toBeInTheDocument());

        const sullaCard = screen.getByTitle(itShared.mediaScarica);
        expect(screen.queryByTitle(itShared.mediaCondividi)).toBeNull();
        fireEvent.click(sullaCard);
        await waitFor(() => expect(h.scaricaMedia).toHaveBeenCalledTimes(1));
        expect(h.scaricaMedia.mock.calls[0][0]).toMatchObject({
            url: URL_FOTO,
            nomeFile: 'Gita al parco.jpg',
            tipo: 'foto',
            etichetta: 'gallery',
        });

        fireEvent.click(screen.getByAltText(MEDIA.caption));
        const comandi = await screen.findByTestId('visore-comandi');
        expect(comandi.textContent).toContain(itShared.mediaScarica);
        expect(comandi.textContent).not.toContain(itShared.mediaCondividi);
        expect(comandi.textContent).not.toContain(itShared.mediaSegnala);
    });
});

describe('Vista di sede (Segreteria) — «Scarica» c’è, nel cestino no', () => {
    const TESTI = {
        senzaData: 'Senza data',
        conteggio: (n: number) => `${n} foto`,
        taggatoSenzaNome: 'Bambino senza nome',
    };
    const FOTO = { ...MEDIA, file_type: 'foto' } as unknown as FotoSede;

    it('la galleria di sede mostra «Scarica» sulla card e lo passa all’helper', async () => {
        render(<GalleriaSedeGiornate foto={[FOTO]} testi={TESTI} onDelete={async () => {}} />);

        fireEvent.click(screen.getByTitle(itShared.mediaScarica));
        await waitFor(() => expect(h.scaricaMedia).toHaveBeenCalledTimes(1));
        expect(h.scaricaMedia.mock.calls[0][0]).toMatchObject({ url: URL_FOTO, tipo: 'foto' });
        expect(screen.queryByTitle(itShared.mediaCondividi)).toBeNull();
    });

    it('il cestino NON ha «Scarica»: una foto da rimuovere non si distribuisce', () => {
        render(
            <GalleriaSedeGiornate
                foto={[FOTO]}
                testi={TESTI}
                onRipristina={async () => {}}
                testiCestino={{
                    eliminataIl: (d: string) => `Eliminata il ${d}`,
                    restanoGiorni: (n: number) => `restano ${n} giorni`,
                    ripristina: 'Ripristina',
                    ripristinaInCorso: 'Ripristino…',
                    anteprimaNonDisponibile: 'Anteprima non disponibile',
                }}
            />,
        );
        // Prima una PRESENZA: il cestino è davvero a schermo. Senza questa riga, un
        // cestino che non rende nulla farebbe passare le due assenze qui sotto.
        expect(screen.getByRole('button', { name: 'Ripristina' })).toBeInTheDocument();
        expect(screen.queryByTitle(itShared.mediaScarica)).toBeNull();
        expect(screen.queryByRole('button', { name: itShared.mediaScarica })).toBeNull();
    });
});
