import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import itShared from '../../messages/it/shared.json';
import itServizi from '../../messages/it/teacherServizi.json';

/**
 * «✨ Applica alle altre» — la domanda arriva PRIMA, e il lavoro fatto foto per
 * foto non si perde.
 *
 * ─── IL DIFETTO, MISURATO IN PRODUZIONE ────────────────────────────────────
 * Il 6 settembre 2026 un'insegnante ha caricato 37 foto taggando i bambini
 * presenti in ognuna. In `galleria_media_v2` tutte e 37 hanno l'impronta di tag
 * IDENTICA: gli stessi 2 bambini, entrambi con `consenso_privacy = true`.
 * `handleApplyToAll` copiava i tag della foto attiva su tutte le altre e lo
 * diceva DOPO, con un `alert` non annullabile.
 *
 * Qui si monta la pagina VERA e si guarda l'ordine dei fatti: il dialogo deve
 * comparire prima che lo stato cambi, e la foto già taggata deve conservare i
 * suoi bambini.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), confirm: vi.fn(), alert: vi.fn() }));

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

const SEZIONE = 'TEST Infanzia';
const ADA = { id: 'bbbb2222-0000-4000-8000-000000000002', nome: 'Ada', cognome: 'Bianchi', consenso_privacy: true };
const BEA = { id: 'bbbb2222-0000-4000-8000-000000000003', nome: 'Bea', cognome: 'Verdi', consenso_privacy: true };

beforeEach(() => {
    vi.clearAllMocks();
    h.confirm.mockReturnValue(true);
    vi.stubGlobal('confirm', h.confirm);
    vi.stubGlobal('alert', h.alert);
    vi.stubGlobal('URL', Object.assign(URL, {
        createObjectURL: () => 'blob:anteprima',
        revokeObjectURL: () => undefined,
    }));
    vi.stubGlobal('fetch', vi.fn((url: string) => {
        const u = String(url);
        if (u.includes('/api/educator-sections')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ sectionNames: [SEZIONE] }) });
        if (u.includes('/api/diary/students')) return Promise.resolve({ ok: true, status: 200, json: async () => [ADA, BEA] });
        if (u.includes('/api/me')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ruolo: 'educator' }) });
        if (u.includes('/api/gallery')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ media: [], total: 0 }) });
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }));
});

import TeacherGalleryPage from '@/app/(dashboard)/teacher/gallery/page';

/** Carica tre file e porta la schermata al passo «tag». */
async function apriTreFoto() {
    const vista = render(<TeacherGalleryPage />);
    // gallery → upload
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itServizi.galleryCarica) }));
    await waitFor(() => expect(vista.container.querySelector('input[type="file"]')).toBeTruthy());
    const input = vista.container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [1, 2, 3].map(i => new File(['x'], `foto${i}.jpg`, { type: 'image/jpeg' }));
    fireEvent.change(input, { target: { files } });
    // upload → tag
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itShared.mediaCaricaVerbo) }));
    await waitFor(() => expect(screen.getByText(`${ADA.nome} ${ADA.cognome}`)).toBeInTheDocument());
    return vista;
}

/** Le miniature della striscia: `w-16` le distingue dall'anteprima grande. */
const miniature = (v: ReturnType<typeof render>) =>
    (Array.from(v.container.querySelectorAll('img[alt=""]'))
        .map(img => img.parentElement)
        .filter(el => el?.className.includes('w-16')) ?? []) as HTMLElement[];

/** Il badge di una miniatura porta il numero di tag di QUELLA foto («!» se zero). */
function badge(v: ReturnType<typeof render>, indice: number): string {
    return miniature(v)[indice]?.querySelector('.absolute')?.textContent?.trim() ?? '';
}

const pulsanteApplica = () => screen.queryByRole('button', { name: /Applica|Sostituisci/ });

describe('«Applica alle altre» non butta via il lavoro fatto foto per foto', () => {
    it('l\'etichetta dice quante foto toccherà, prima di premere', async () => {
        await apriTreFoto();
        fireEvent.click(screen.getByText(`${ADA.nome} ${ADA.cognome}`));
        // Foto 1 taggata; restano 2 foto da riempire.
        expect(pulsanteApplica()?.textContent).toMatch(/2/);
    });

    it('la foto già taggata a mano CONSERVA i suoi bambini', async () => {
        const v = await apriTreFoto();
        // Foto 1 → Ada
        fireEvent.click(screen.getByText(`${ADA.nome} ${ADA.cognome}`));
        // Passo alla foto 2 e la taggo con Bea: è il lavoro che non deve sparire.
        fireEvent.click(miniature(v)[1]);
        fireEvent.click(screen.getByText(`${BEA.nome} ${BEA.cognome}`));
        // Torno alla 1 e applico.
        fireEvent.click(miniature(v)[0]);
        fireEvent.click(pulsanteApplica()!);

        // La 2 resta con UN tag (Bea), la 3 riceve quello della 1.
        await waitFor(() => expect(badge(v, 2)).toBe('1'));
        expect(badge(v, 1)).toBe('1');
        // E il tag della foto 2 è DAVVERO Bea, non «un tag qualsiasi»: la prova è
        // per comportamento, non per classe CSS — cliccandola il badge scende a
        // zero, cosa che accade solo se era lei a essere selezionata.
        fireEvent.click(miniature(v)[1]);
        fireEvent.click(screen.getByText(`${BEA.nome} ${BEA.cognome}`));
        expect(badge(v, 1)).toBe('!');
    });

    it('la conferma arriva PRIMA che lo stato cambi, e nomina quante foto sono già taggate', async () => {
        const v = await apriTreFoto();
        fireEvent.click(screen.getByText(`${ADA.nome} ${ADA.cognome}`));
        fireEvent.click(miniature(v)[1]);
        fireEvent.click(screen.getByText(`${BEA.nome} ${BEA.cognome}`));
        fireEvent.click(miniature(v)[0]);

        // Rifiuto: niente deve cambiare.
        h.confirm.mockReturnValue(false);
        fireEvent.click(pulsanteApplica()!);
        expect(h.confirm).toHaveBeenCalledTimes(1);
        expect(String(h.confirm.mock.calls[0][0])).toMatch(/1/);
        expect(badge(v, 2)).toBe('!');   // la terza è ancora senza tag
    });

    it('senza niente da perdere non chiede niente: una conferma che si preme sempre non si legge più', async () => {
        await apriTreFoto();
        fireEvent.click(screen.getByText(`${ADA.nome} ${ADA.cognome}`));
        fireEvent.click(pulsanteApplica()!);
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it('l\'`alert` a posteriori non esiste più: era l\'avviso che arrivava a danno fatto', async () => {
        await apriTreFoto();
        fireEvent.click(screen.getByText(`${ADA.nome} ${ADA.cognome}`));
        fireEvent.click(pulsanteApplica()!);
        expect(h.alert).not.toHaveBeenCalled();
    });
});
