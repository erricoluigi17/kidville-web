import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * LA CODA OFFLINE E IL TIPO DEL FILE — il mime si DERIVA, non si asserisce.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * Fino al 2026-09-09 questa coda cablava `item.file_type === 'video' ? 'video/mp4' :
 * 'image/jpeg'`. È la stessa classe di difetto che quel giorno aveva fermato la
 * galleria online — un mime deciso a mano invece che letto — ma rovesciata: là il
 * valore vero veniva respinto, qui un valore FALSO veniva accettato.
 *
 * `processVideoWithWatermark` sceglie il formato in base a ciò che il dispositivo
 * sa registrare (`processing.ts:293-300`): su Chrome esce mp4, altrove **webm**. Un
 * webm accodato partiva dichiarando `video/mp4`, e siccome il server deriva
 * l'estensione dal mime VALIDATO, finiva in archivio come `.mp4` con
 * `content-type: video/mp4` — un file etichettato per quello che non è, nel bucket da
 * cui il genitore lo scarica.
 *
 * Il tipo ce l'ha il blob salvato in coda (`db.ts:85`, che è il `File` processato
 * messo lì da `page.tsx`). Il cablaggio resta solo come RIPIEGO, per i blob che un
 * tipo non ce l'hanno.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

const h = vi.hoisted(() => ({
    caricaMediaGalleria: vi.fn(),
    righe: [] as Array<Record<string, unknown>>,
    aggiornate: [] as Array<[unknown, unknown]>,
}));

vi.mock('@/lib/gallery/carica-media', () => ({ caricaMediaGalleria: h.caricaMediaGalleria }));
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: (e: Error) => e.name }));
vi.mock('@supabase/ssr', () => ({ createBrowserClient: vi.fn() }));
vi.mock('@/lib/offline/db', () => ({
    db: {
        galleria: {
            where: () => ({ anyOf: () => ({ toArray: async () => h.righe }) }),
            update: async (id: unknown, v: unknown) => { h.aggiornate.push([id, v]); },
            delete: async () => {},
        },
    },
}));

import { syncPendingGalleryMedia } from '@/lib/offline/syncEngine';

/** Una riga in coda, col blob che porta il proprio tipo — come lo salva la pagina. */
const inCoda = (tipoBlob: string, fileType: 'video' | 'foto' = 'video') => ({
    id: 'loc-1',
    uploaded_by: 'ed-1',
    caption: 'x',
    tag_students: [],
    is_broadcast: false,
    target_classes: null,
    file_type: fileType,
    file_blob: new Blob(['x'], { type: tipoBlob }),
    file_name: 'IMG_bambina-rossi.webm',
    creato_il: '2026-09-09T00:00:00.000Z',
    sync_status: 'pending',
});

beforeEach(() => {
    vi.clearAllMocks();
    h.righe = [];
    h.aggiornate = [];
    h.caricaMediaGalleria.mockResolvedValue({ ok: false, motivo: 'firma', stato: 500 });
    vi.stubGlobal('navigator', { onLine: true });
});

describe('syncPendingGalleryMedia · il mime viene dal blob', () => {
    it('un video WEBM in coda non parte più dichiarando di essere mp4', async () => {
        h.righe = [inCoda('video/webm;codecs=vp9')];
        await syncPendingGalleryMedia();
        expect(h.caricaMediaGalleria).toHaveBeenCalledWith(expect.anything(), 'video/webm');
    });

    it('un blob SENZA tipo mantiene il ripiego di prima: non peggio di oggi', async () => {
        h.righe = [inCoda('')];
        await syncPendingGalleryMedia();
        expect(h.caricaMediaGalleria).toHaveBeenCalledWith(expect.anything(), 'video/mp4');
    });

    it('una foto senza tipo resta una jpeg', async () => {
        h.righe = [inCoda('', 'foto')];
        await syncPendingGalleryMedia();
        expect(h.caricaMediaGalleria).toHaveBeenCalledWith(expect.anything(), 'image/jpeg');
    });
});
