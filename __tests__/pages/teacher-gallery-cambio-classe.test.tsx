import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invalidaEducatorSectionsCache } from '@/lib/sezioni/educator-sections-cache';
import { SEDE_A } from '../fixtures/sedi';
import itServizi from '../../messages/it/teacherServizi.json';
import itShared from '../../messages/it/shared.json';

/**
 * Galleria del docente — cosa succede al CAMBIO DI CLASSE (revisione lotto 8).
 *
 *  · foto di una classe NON restano accanto all'errore di lettura della classe nuova (`setMedia([])`);
 *  · l'avviso di errore della classe di prima non resta (`setReadError(false)`);
 *  · durante un caricamento il selettore è spento e il cambio è ignorato (N1: `annullaCaricamento` butterebbe le copie
 *    dei video nativi che si stanno spedendo);
 *  · con file già scelti si chiede conferma prima di scartarli (N2).
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), confirm: vi.fn(), alert: vi.fn(), salva: vi.fn() }));

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
    saveLocalGalleryMedia: h.salva,
    syncPendingGalleryMedia: vi.fn(async () => undefined),
}));
vi.mock('@/lib/offline/db', () => ({}));

const SEC_A = 'aaaa1111-0000-4000-8000-0000000000a1';
const SEC_B = 'aaaa1111-0000-4000-8000-0000000000a2';
const NOME_A = 'TEST Infanzia';
const NOME_B = 'TEST Nido';
const ADA = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Ada', cognome: 'Bianchi', consenso_privacy: true };
const MEDIA_A = { id: 'cccc3333-0000-4000-8000-0000000000a1', file_url: 'https://esempio.test/a.jpg', file_type: 'image', caption: 'Foto della classe A', tag_students: [] as string[], is_broadcast: false, created_at: '2026-10-10T10:00:00.000Z', uploader_name: 'Maestra Anna' };
const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const sezioni = () => ([
    { id: SEC_A, name: NOME_A, scuolaId: 's', scuolaNome: 'S', school_type: 'infanzia', solaLettura: false, annoId: 'a27', annoEtichetta: '2026/27', annoStato: 'corrente', annoInizio: '2026-09-01', annoFine: '2999-08-31' },
    { id: SEC_B, name: NOME_B, scuolaId: 's', scuolaNome: 'S', school_type: 'infanzia', solaLettura: false, annoId: 'a27', annoEtichetta: '2026/27', annoStato: 'corrente', annoInizio: '2026-09-01', annoFine: '2999-08-31' },
]);

beforeEach(() => {
    vi.clearAllMocks();
    invalidaEducatorSectionsCache();
    h.confirm.mockReturnValue(true);
    h.salva.mockImplementation(async () => undefined);
    document.cookie = `sedi_attive=${SEDE_A}; path=/`;
    vi.stubGlobal('confirm', h.confirm);
    vi.stubGlobal('alert', h.alert);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:anteprima', revokeObjectURL: () => undefined }));
    fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes('/api/educator-sections')) return ok({ sections: sezioni(), sectionNames: [NOME_A, NOME_B] });
        if (u.includes('/api/me')) return ok({ ruolo: 'educator' });
        if (u.includes('/api/diary/students')) return ok([ADA]);
        if (u.includes('/api/gallery')) return ok({ media: u.includes(encodeURIComponent(NOME_A)) ? [MEDIA_A] : [], total: 1 });
        return ok({});
    });
    vi.stubGlobal('fetch', fetchMock);
});

import TeacherGalleryPage from '@/app/(dashboard)/teacher/gallery/page';

const selettore = async () => (await screen.findByLabelText(itServizi.gallerySezioneLabel)) as HTMLSelectElement;
const verso = (sel: HTMLSelectElement, id: string) => fireEvent.change(sel, { target: { value: id } });

/** Porta la pagina al passo dei tag con una foto scelta. */
async function sceltaDiUnaFoto() {
    const vista = render(<TeacherGalleryPage />);
    await screen.findByText('Foto della classe A');
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) }));
    await waitFor(() => expect(vista.container.querySelector('input[type="file"]')).toBeTruthy());
    const input = vista.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'foto1.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`1 ${itShared.mediaFilePlurale}`) }));
    await waitFor(() => expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument());
    return vista;
}

describe('galleria docente — cambio di classe', () => {
    it('🔴 la classe nuova risponde 500: la foto della classe di prima NON resta accanto all’errore', async () => {
        render(<TeacherGalleryPage />);
        await screen.findByText('Foto della classe A');
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((url: string, init?: unknown) => {
            const u = String(url);
            if (u.includes('/api/gallery') && u.includes(encodeURIComponent(NOME_B))) return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
            return base(url, init);
        });
        verso(await selettore(), SEC_B);
        await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/gallery') && String(u).includes(encodeURIComponent(NOME_B)))).toBe(true));
        await new Promise((r) => setTimeout(r, 30));
        expect(screen.queryByText('Foto della classe A')).toBeNull();
    });

    it('🔴 l’avviso di errore della classe di prima non resta quando si passa a una classe che risponde bene', async () => {
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((url: string, init?: unknown) => {
            const u = String(url);
            if (u.includes('/api/gallery') && u.includes(encodeURIComponent(NOME_A))) return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
            if (u.includes('/api/gallery') && u.includes(encodeURIComponent(NOME_B))) return new Promise(() => undefined); // appesa
            return base(url, init);
        });
        render(<TeacherGalleryPage />);
        const sel = await selettore();
        await waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
        verso(sel, SEC_B);
        await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
    });

    it('🔴 N1 · durante un caricamento il selettore è spento e un cambio forzato è ignorato', async () => {
        await sceltaDiUnaFoto();
        h.salva.mockImplementation(() => new Promise(() => undefined)); // il giro resta in corso (uploading)
        fireEvent.click(screen.getByText(`${ADA.nome} ${ADA.cognome}`)); // la foto ha il suo bambino: «Pubblica» si accende
        fireEvent.click(screen.getByRole('button', { name: /Pubblica/ }));
        const sel = await selettore();
        await waitFor(() => expect(sel.disabled).toBe(true));
        verso(sel, SEC_B);
        expect(h.confirm).not.toHaveBeenCalled();
        expect(sel.value).toBe(SEC_A);
        expect(screen.getByText(itServizi.galleryCaricamentoUpload)).toBeInTheDocument();
    });

    it('🔴 N2 · con file già scelti il cambio chiede conferma; rifiutata, scelta e classe restano', async () => {
        await sceltaDiUnaFoto();
        h.confirm.mockReturnValue(false);
        const sel = await selettore();
        verso(sel, SEC_B);
        expect(h.confirm).toHaveBeenCalledTimes(1);
        expect(sel.value).toBe(SEC_A);
        expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument();
    });

    it('N2 · confermata, la scelta si scarta e la classe cambia', async () => {
        await sceltaDiUnaFoto();
        h.confirm.mockReturnValue(true);
        verso(await selettore(), SEC_B);
        await waitFor(() => expect(screen.queryByText(`${ADA.nome} ${ADA.cognome}`)).toBeNull());
        expect(((await selettore()) as HTMLSelectElement).value).toBe(SEC_B);
    });

    it('senza file scelti il cambio non chiede niente', async () => {
        render(<TeacherGalleryPage />);
        await screen.findByText('Foto della classe A');
        verso(await selettore(), SEC_B);
        expect(h.confirm).not.toHaveBeenCalled();
    });
});
