import { describe, it, expect, vi, beforeEach } from 'vitest'

// La coda storica video non usa più la porta delle foto: solo foto con owner e
// sede espliciti attraversano `caricaMediaGalleria`.
const h = vi.hoisted(() => ({
    caricaMediaGalleria: vi.fn(),
    righe: [] as Array<Record<string, unknown>>,
    aggiornate: [] as Array<[unknown, unknown]>,
}))
vi.mock('@/lib/gallery/carica-media', () => ({ caricaMediaGalleria: h.caricaMediaGalleria }))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: (e: Error) => e.name }))
vi.mock('@supabase/ssr', () => ({ createBrowserClient: vi.fn() }))
vi.mock('@/lib/offline/db', () => ({
    db: { galleria: {
        toArray: async () => h.righe,
        get: async (id: string) => h.righe.find(r => r.id === id),
        update: async (id: unknown, changes: Record<string, unknown>) => {
            h.aggiornate.push([id, changes])
            const row = h.righe.find(r => r.id === id)
            if (row) Object.assign(row, changes)
        },
        delete: async () => {},
    } },
}))
import { syncPendingGalleryMedia } from '@/lib/offline/syncEngine'

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const schoolId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const inCoda = (tipoBlob: string, fileType: 'video' | 'foto' = 'foto') => ({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', uploaded_by: ownerId, scuola_id: schoolId,
    upload_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', caption: 'x', tag_students: [],
    is_broadcast: false, target_classes: null, file_type: fileType,
    file_blob: new Blob(['x'], { type: tipoBlob }), file_name: 'privato',
    creato_il: '2026-09-09T00:00:00.000Z', sync_status: 'pending', phase: 'upload',
})

beforeEach(() => {
    vi.clearAllMocks()
    h.righe = []
    h.aggiornate = []
    h.caricaMediaGalleria.mockResolvedValue({ ok: false, motivo: 'firma', stato: 500 })
    vi.stubGlobal('navigator', { onLine: true })
})

describe('syncPendingGalleryMedia · confine foto/video e MIME', () => {
    it('senza identità/sede non legge la coda e non carica', async () => {
        h.righe = [inCoda('image/jpeg')]
        await syncPendingGalleryMedia()
        expect(h.caricaMediaGalleria).not.toHaveBeenCalled()
    })
    it('un video usa la propria pipeline e non attraversa la porta foto', async () => {
        h.righe = [inCoda('video/webm;codecs=vp9', 'video')]
        await syncPendingGalleryMedia({ ownerId, schoolId })
        expect(h.caricaMediaGalleria).not.toHaveBeenCalled()
    })
    it('la foto usa il MIME del blob, normalizzato', async () => {
        h.righe = [inCoda('image/webp;variant=x')]
        await syncPendingGalleryMedia({ ownerId, schoolId })
        expect(h.caricaMediaGalleria).toHaveBeenCalledWith(expect.any(File), 'image/webp', expect.any(Object))
    })
    it('una foto legacy senza tipo conserva il ripiego JPEG', async () => {
        h.righe = [inCoda('')]
        await syncPendingGalleryMedia({ ownerId, schoolId })
        expect(h.caricaMediaGalleria).toHaveBeenCalledWith(expect.any(File), 'image/jpeg', expect.any(Object))
    })
})
