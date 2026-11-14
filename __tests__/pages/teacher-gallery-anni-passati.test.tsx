import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invalidaEducatorSectionsCache } from '@/lib/sezioni/educator-sections-cache';
import itServizi from '../../messages/it/teacherServizi.json';
import itShared from '../../messages/it/shared.json';

/**
 * Lotto 8 — la galleria del docente apre in SOLA LETTURA le classi degli anni passati.
 *
 * Il finto server risponde come `/api/educator-sections?passati=1`: la classe dell'anno in corso (scrivibile) e quella del
 * 2025/26 `chiuso` (sola lettura) con lo STESSO nome. Sulla classe passata: selettore con l'anno, scritta, la lettura va su
 * `sectionId` + `dellAnno=1`, e NON ci sono né «Carica», né cancellazione, né etichette.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));

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
vi.mock('@/lib/offline/syncEngine', () => ({
    saveLocalGalleryMedia: vi.fn(async () => undefined),
    syncPendingGalleryMedia: vi.fn(async () => undefined),
}));
vi.mock('@/lib/offline/db', () => ({}));

const SEC_NUOVA = 'aaaa1111-0000-4000-8000-0000000000a1';
const SEC_VECCHIA = 'aaaa1111-0000-4000-8000-0000000000a2';
const NOME = 'TEST Infanzia';
const MEDIA = {
    id: 'cccc3333-0000-4000-8000-000000000003',
    file_url: 'https://esempio.test/foto.jpg',
    file_type: 'image',
    caption: 'Gita al parco',
    tag_students: [] as string[],
    is_broadcast: false,
    created_at: '2000-03-10T10:00:00.000Z',
    uploader_name: 'Maestra Anna',
};
const fetchMock = vi.fn();

const sezioni = () => ([
    { id: SEC_NUOVA, name: NOME, scuolaId: 's', scuolaNome: 'S', school_type: 'infanzia', solaLettura: false, annoId: 'a27', annoEtichetta: '2026/27', annoStato: 'corrente', annoInizio: '2026-09-01', annoFine: '2999-08-31' },
    { id: SEC_VECCHIA, name: NOME, scuolaId: 's', scuolaNome: 'S', school_type: 'infanzia', solaLettura: true, annoId: 'a26', annoEtichetta: '2025/26', annoStato: 'chiuso', annoInizio: '1999-09-01', annoFine: '2000-08-31' },
]);

beforeEach(() => {
    vi.clearAllMocks();
    invalidaEducatorSectionsCache();
    fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
        if (u.includes('/api/educator-sections')) return ok({ sections: sezioni(), sectionNames: [NOME] });
        if (u.includes('/api/me')) return ok({ ruolo: 'educator' });
        if (u.includes('/api/diary/students')) return ok([{ id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Mario', cognome: 'Rossi', consenso_privacy: true }]);
        if (u.includes('/api/gallery')) return ok({ media: [MEDIA], total: 1 });
        return ok({});
    });
    vi.stubGlobal('fetch', fetchMock);
});

import TeacherGalleryPage from '@/app/(dashboard)/teacher/gallery/page';

const apriVecchia = async () => {
    render(<TeacherGalleryPage />);
    const sel = (await screen.findByLabelText(itServizi.gallerySezioneLabel)) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: SEC_VECCHIA } });
    await screen.findByText(new RegExp(itServizi.galleryAnnoPassatoAiuto.slice(0, 25)));
    return sel;
};

describe('galleria docente — classi degli anni passati (lotto 8)', () => {
    it('chiede alla route anche le classi passate; il selettore porta l’anno accanto al nome, da 44 px', async () => {
        render(<TeacherGalleryPage />);
        const sel = (await screen.findByLabelText(itServizi.gallerySezioneLabel)) as HTMLSelectElement;
        expect(Array.from(sel.options).map((o) => o.textContent)).toEqual([`${NOME} · 2026/27`, `${NOME} · 2025/26`]);
        expect(sel.className).toContain('min-h-11');
        expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/educator-sections') && String(u).includes('passati=1'))).toBe(true);
    });

    it('🔴 classe passata: scritta «Anno passato», lettura su sectionId + dellAnno=1, NESSUN controllo di scrittura', async () => {
        await apriVecchia();
        expect(screen.getByText(/Anno passato/)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByAltText(MEDIA.caption)).toBeInTheDocument());
        expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/gallery?') && String(u).includes(`sectionId=${SEC_VECCHIA}`) && String(u).includes('dellAnno=1'))).toBe(true);
        // Niente «Carica».
        expect(screen.queryByRole('button', { name: new RegExp(itServizi.galleryCarica) })).toBeNull();
        // Nel visore: il «Scarica» c'è, ma né «Elimina» né «Modifica tag».
        fireEvent.click(screen.getByAltText(MEDIA.caption));
        expect(screen.queryByRole('button', { name: new RegExp(itShared.galleryModificaTag) })).toBeNull();
        expect(screen.queryByRole('button', { name: /elimina/i })).toBeNull();
        // I bambini (con i consensi) non si chiedono: nessuna etichettatura.
        const urls = fetchMock.mock.calls.map(([u]) => String(u));
        const dopo = urls.slice(urls.findIndex((u) => u.includes(`sectionId=${SEC_VECCHIA}`)) + 1);
        expect(dopo.some((u) => u.includes('/api/diary/students'))).toBe(false);
        // Nessuna scrittura è mai partita.
        expect(fetchMock.mock.calls.filter(([, init]) => ((init as { method?: string } | undefined)?.method ?? 'GET') !== 'GET')).toEqual([]);
    });

    const MEDIA_NUOVA = { ...MEDIA, id: 'cccc3333-0000-4000-8000-0000000000ff', caption: 'Foto della classe nuova', created_at: '2026-10-10T10:00:00.000Z' };

    it('🔴 R1 · una risposta lenta della classe di prima NON si sovrappone alla classe passata appena scelta', async () => {
        let sblocca: (r: unknown) => void = () => undefined;
        const lenta = new Promise((res) => { sblocca = res; });
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((url: string, init?: unknown) => {
            const u = String(url);
            if (u.includes('/api/gallery') && !u.includes('dellAnno=1')) return lenta;
            return base(url, init);
        });
        await apriVecchia();
        await screen.findByText('Gita al parco');
        // arriva adesso la risposta tardiva della classe nuova
        sblocca({ ok: true, status: 200, json: async () => ({ media: [MEDIA_NUOVA], total: 1 }) });
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByText('Foto della classe nuova')).toBeNull();
        expect(screen.getByText('Gita al parco')).toBeInTheDocument();
        expect(screen.queryByText(itServizi.galleryCarica)).toBeNull();
    });

    it('la classe dell’anno in corso resta scrivibile: «Carica» c’è, nessuna scritta', async () => {
        render(<TeacherGalleryPage />);
        await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) });
        expect(document.querySelector('[data-sola-lettura]')).toBeNull();
        expect(fetchMock.mock.calls.some(([u]) => String(u).includes('dellAnno=1'))).toBe(false);
    });
});
