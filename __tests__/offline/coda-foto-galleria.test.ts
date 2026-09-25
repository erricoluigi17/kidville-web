import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

type Riga = Record<string, unknown> & { id: string }
const h = vi.hoisted(() => ({
  righe: new Map<string, Riga>(), carica: vi.fn(), processImage: vi.fn(), log: vi.fn(),
  beforeUpdate: null as null | ((id: string, changes: Record<string, unknown>) => Promise<void>),
}))
vi.mock('@/lib/offline/db', () => ({
  db: { galleria: {
    toArray: async () => [...h.righe.values()],
    get: async (id: string) => h.righe.get(id),
    put: async (row: Riga) => { h.righe.set(row.id, structuredClone(row)); },
    update: async (id: string, changes: Record<string, unknown>) => {
      await h.beforeUpdate?.(id, changes)
      const row = h.righe.get(id)
      if (row) h.righe.set(id, { ...row, ...structuredClone(changes) })
    },
    delete: async (id: string) => { h.righe.delete(id) },
  } },
}))
vi.mock('@/lib/gallery/carica-media', () => ({ caricaMediaGalleria: h.carica }))
vi.mock('@/lib/media/processing', () => ({ processImageWithWatermark: h.processImage }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.log, nomeErrore: (e: Error) => e.name }))

import { db } from '@/lib/offline/db'
import { accodaFotoGalleria, assegnaSedeFotoLegacy, drainGalleryPhotoQueue, listaFotoInCoda, prossimaRipresaCodaFoto, riprovaFotoInCoda, scartaFotoInCoda } from '@/lib/gallery/coda-foto'

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const schoolId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const id = (n: number) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`
const row = (n: number, extra: Record<string, unknown> = {}): Riga => ({
  id: id(n), uploaded_by: ownerId, scuola_id: schoolId, upload_id: id(n),
  caption: 'privato', tag_students: [], is_broadcast: false, target_classes: null,
  file_type: 'foto', file_blob: new Blob(['x'], { type: 'image/jpeg' }), file_name: 'privato.jpg',
  sync_status: 'pending', phase: 'upload', storage_path: null, next_attempt_at: null,
  creato_il: '2026-09-25T00:00:00.000Z', ...extra,
})

beforeEach(() => {
  vi.resetAllMocks()
  h.righe.clear()
  h.beforeUpdate = null
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'))
  vi.stubGlobal('navigator', { onLine: true })
  h.carica.mockImplementation(async (_file: File, _mime: string, opts?: { onPath?: (path: string) => Promise<void> }) => {
    await opts?.onPath?.('uploads/' + ownerId + '/oggetto.jpg')
    return { ok: true, path: 'uploads/' + ownerId + '/oggetto.jpg' }
  })
  h.processImage.mockResolvedValue(new File(['elaborata'], 'foto.jpg', { type: 'image/jpeg' }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('coda foto persistente', () => {
  it('programma la ripresa alla prima scadenza futura del Retry-After', () => {
    const now = Date.now()
    expect(prossimaRipresaCodaFoto([
      row(1, { next_attempt_at: now + 60_000 }),
      row(2, { next_attempt_at: now + 15_000 }),
      row(3, { next_attempt_at: now - 1000 }),
    ] as never, now)).toBe(15_000)
    expect(prossimaRipresaCodaFoto([row(3, { next_attempt_at: now - 1000 })] as never, now)).toBeNull()
  })
  it('con 31 foto conserva la 31ª al 429 e rispetta Retry-After anche al rientro', async () => {
    for (let n = 1; n <= 31; n++) h.righe.set(id(n), row(n))
    const post = vi.fn().mockImplementation(async () => {
      const numero = post.mock.calls.length
      return numero === 31
        ? { ok: false, status: 429, headers: { get: () => '60' } }
        : { ok: true, status: 201 }
    })
    vi.stubGlobal('fetch', post)

    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(h.righe.size).toBe(1)
    expect(h.righe.has(id(31))).toBe(true)
    expect(post).toHaveBeenCalledTimes(31)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(post).toHaveBeenCalledTimes(31)

    vi.setSystemTime(new Date('2026-09-25T12:01:01.000Z'))
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(post).toHaveBeenCalledTimes(32)
    expect(h.righe.size).toBe(0)
  })

  it('dopo risposta POST persa ripete lo stesso upload_id senza una nuova PUT', async () => {
    h.righe.set(id(1), row(1))
    const post = vi.fn().mockRejectedValueOnce(new TypeError('rete')).mockResolvedValueOnce({ ok: true, status: 200 })
    vi.stubGlobal('fetch', post)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(h.righe.get(id(1))).toMatchObject({ phase: 'publishing', storage_path: 'uploads/' + ownerId + '/oggetto.jpg' })
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(h.carica).toHaveBeenCalledTimes(1)
    expect(JSON.parse(post.mock.calls[0][1].body).upload_id).toBe(id(1))
    expect(JSON.parse(post.mock.calls[1][1].body).upload_id).toBe(id(1))
    expect(h.righe.size).toBe(0)
  })

  it('non scarta la foto mentre il POST è in corso e riconcilia con lo stesso UUID dopo una risposta persa', async () => {
    h.righe.set(id(1), row(1))
    let terminaPost: ((value: unknown) => void) | undefined
    const post = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { terminaPost = resolve }))
      .mockResolvedValueOnce({ ok: true, status: 200 })
    vi.stubGlobal('fetch', post)

    const primo = drainGalleryPhotoQueue({ ownerId, schoolId })
    await vi.waitFor(() => expect(terminaPost).toBeDefined())
    expect(h.righe.get(id(1))?.phase).toBe('publishing')
    expect(await scartaFotoInCoda({ ownerId, schoolId }, id(1))).toBe(false)
    expect(h.righe.has(id(1))).toBe(true)

    terminaPost?.({ ok: false, status: 503, headers: { get: () => '1' } })
    await primo
    expect(h.righe.get(id(1))?.phase).toBe('publishing')
    expect(await scartaFotoInCoda({ ownerId, schoolId }, id(1))).toBe(false)
    vi.setSystemTime(Date.now() + 1001)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(h.carica).toHaveBeenCalledTimes(1)
    expect(JSON.parse(post.mock.calls[0][1].body).upload_id).toBe(id(1))
    expect(JSON.parse(post.mock.calls[1][1].body).upload_id).toBe(id(1))
    expect(h.righe.size).toBe(0)
  })

  it('il POST foto usa il tetto condiviso per uscire da una connessione sospesa', async () => {
    h.righe.set(id(1), row(1))
    const post = vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError'))
    vi.stubGlobal('fetch', post)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(post.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(h.righe.get(id(1))).toMatchObject({ phase: 'publishing', sync_status: 'error', last_error: 'publish' })
  })

  it('isola account e sede, e non indovina la sede della riga legacy', async () => {
    h.righe.set(id(1), row(1))
    h.righe.set(id(2), row(2, { uploaded_by: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }))
    h.righe.set(id(3), row(3, { scuola_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }))
    h.righe.set(id(4), row(4, { scuola_id: undefined, upload_id: undefined }))
    vi.stubGlobal('crypto', { randomUUID: () => id(4) })
    const post = vi.fn().mockResolvedValue({ ok: true, status: 201 })
    vi.stubGlobal('fetch', post)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(post).toHaveBeenCalledTimes(1)
    expect(h.righe.has(id(4))).toBe(true)
    expect((await listaFotoInCoda({ ownerId, schoolId })).map(r => r.id)).toEqual([id(4)])
    expect(await assegnaSedeFotoLegacy({ ownerId: 'altro', schoolId }, id(4))).toBe(false)
    expect(await assegnaSedeFotoLegacy({ ownerId, schoolId }, id(4))).toBe(true)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(post).toHaveBeenCalledTimes(2)
    expect(h.righe.has(id(2))).toBe(true)
    expect(h.righe.has(id(3))).toBe(true)
  })

  it('una foto non decodificabile resta ritentabile/scartabile e le successive partono', async () => {
    h.righe.set(id(1), row(1, { phase: 'preparing', last_error: 'processing', sync_status: 'error' }))
    h.righe.set(id(2), row(2))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201 }))
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(h.righe.has(id(1))).toBe(true)
    expect(h.righe.has(id(2))).toBe(false)
    h.processImage.mockRejectedValueOnce(new Error('immagine non decodificabile'))
    expect(await riprovaFotoInCoda({ ownerId, schoolId }, id(1))).toBe(false)
    expect(h.righe.get(id(1))).toMatchObject({ phase: 'preparing', last_error: 'processing' })
    expect(await scartaFotoInCoda({ ownerId, schoolId }, id(1))).toBe(true)
    expect(h.righe.size).toBe(0)
  })

  it('Riprova rielabora la foto originale e poi la pubblica con lo stesso UUID', async () => {
    h.righe.set(id(1), row(1, { phase: 'preparing', last_error: 'processing', sync_status: 'error' }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201 }))
    expect(await riprovaFotoInCoda({ ownerId, schoolId }, id(1))).toBe(true)
    expect(h.righe.get(id(1))).toMatchObject({ phase: 'upload', sync_status: 'pending' })
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(h.righe.size).toBe(0)
  })

  it('non perde il batch quando IndexedDB rifiuta per quota: il chiamante riceve il rigetto', async () => {
    vi.spyOn(db.galleria, 'put').mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'))
    await expect(accodaFotoGalleria({
      id: id(1), uploaded_by: ownerId, scuola_id: schoolId, caption: 'privato',
      tag_students: [], is_broadcast: false, target_classes: null,
      file_blob: new Blob(['x'], { type: 'image/jpeg' }), file_name: 'privato.jpg',
      creato_il: '2026-09-25T00:00:00.000Z',
    })).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(h.righe.size).toBe(0)
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'gallery-coda-salvataggio-fallito' }))
  })

  it('singleflight: due richieste contemporanee pubblicano una sola volta', async () => {
    h.righe.set(id(1), row(1))
    let rispondi: ((value: unknown) => void) | undefined
    const post = vi.fn().mockImplementation(() => new Promise(resolve => { rispondi = resolve }))
    vi.stubGlobal('fetch', post)
    const primo = drainGalleryPhotoQueue({ ownerId, schoolId })
    const secondo = drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(secondo).toBe(primo)
    await vi.waitFor(() => expect(rispondi).toBeDefined())
    rispondi?.({ ok: true, status: 201 })
    await Promise.all([primo, secondo])
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('offline non tocca la rete e conserva la riga', async () => {
    h.righe.set(id(1), row(1))
    vi.stubGlobal('navigator', { onLine: false })
    const post = vi.fn()
    vi.stubGlobal('fetch', post)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(post).not.toHaveBeenCalled()
    expect(h.righe.size).toBe(1)
  })

  it('se cambia account o sede mentre il PUT è sospeso non avvia il POST', async () => {
    h.righe.set(id(1), row(1))
    let terminaPut: ((value: unknown) => void) | undefined
    let attivo = true
    h.carica.mockImplementationOnce(async (_file: File, _mime: string, opts: { onPath: (path: string) => Promise<void> }) => {
      await opts.onPath('uploads/' + ownerId + '/oggetto.jpg')
      return new Promise(resolve => { terminaPut = resolve })
    })
    const post = vi.fn()
    vi.stubGlobal('fetch', post)
    const task = drainGalleryPhotoQueue({ ownerId, schoolId, isCurrent: () => attivo })
    await vi.waitFor(() => expect(terminaPut).toBeDefined())
    attivo = false
    terminaPut?.({ ok: true, path: 'uploads/' + ownerId + '/oggetto.jpg' })
    await task
    expect(post).not.toHaveBeenCalled()
    expect(h.righe.has(id(1))).toBe(true)
  })

  it('se la risposta POST arriva dopo il cambio account conserva la riga per replay', async () => {
    h.righe.set(id(1), row(1))
    let terminaPost: ((value: unknown) => void) | undefined
    let attivo = true
    const post = vi.fn().mockImplementation(() => new Promise(resolve => { terminaPost = resolve }))
    vi.stubGlobal('fetch', post)
    const task = drainGalleryPhotoQueue({ ownerId, schoolId, isCurrent: () => attivo })
    await vi.waitFor(() => expect(terminaPost).toBeDefined())
    attivo = false
    terminaPost?.({ ok: true, status: 201 })
    await task
    expect(h.righe.get(id(1))).toMatchObject({ phase: 'publishing', storage_path: 'uploads/' + ownerId + '/oggetto.jpg' })
  })

  it('non avvia il POST se account o sede cambiano mentre salva la fase publishing', async () => {
    h.righe.set(id(1), row(1, { phase: 'publish', storage_path: 'uploads/' + ownerId + '/oggetto.jpg' }))
    let terminaSalvataggio: (() => void) | undefined
    h.beforeUpdate = async (_key, changes) => {
      if (changes.phase === 'publishing') {
        await new Promise<void>(resolve => { terminaSalvataggio = resolve })
      }
    }
    let corrente = true
    const post = vi.fn()
    vi.stubGlobal('fetch', post)

    const task = drainGalleryPhotoQueue({ ownerId, schoolId, isCurrent: () => corrente })
    await vi.waitFor(() => expect(terminaSalvataggio).toBeDefined())
    corrente = false
    terminaSalvataggio?.()
    await task
    expect(post).not.toHaveBeenCalled()
    expect(h.righe.has(id(1))).toBe(true)
  })

  it.each([401, 422, 429])('non perde l’incertezza del primo POST dopo un replay %i', async status => {
    h.righe.set(id(1), row(1))
    const post = vi.fn().mockRejectedValueOnce(new TypeError('risposta persa'))
      .mockResolvedValueOnce({ ok: false, status, headers: { get: () => '1' } })
    vi.stubGlobal('fetch', post)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(h.righe.get(id(1))?.phase).toBe('publishing')
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(post).toHaveBeenCalledTimes(2)
    expect(h.righe.get(id(1))?.phase).toBe('publishing')
    expect(await scartaFotoInCoda({ ownerId, schoolId }, id(1))).toBe(false)
    expect(h.righe.has(id(1))).toBe(true)
  })

  it.each([401, 422, 429])('permette lo scarto dopo il primo rifiuto definitivo %i', async status => {
    h.righe.set(id(1), row(1))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, headers: { get: () => '1' } }))
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(h.righe.get(id(1))?.phase).toBe('publish')
    expect(await scartaFotoInCoda({ ownerId, schoolId }, id(1))).toBe(true)
  })

  it('un 403 ferma il lotto e non cancella alcuna foto', async () => {
    h.righe.set(id(1), row(1))
    h.righe.set(id(2), row(2))
    const post = vi.fn().mockResolvedValue({ ok: false, status: 403, headers: { get: () => null } })
    vi.stubGlobal('fetch', post)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(post).toHaveBeenCalledTimes(1)
    expect(h.righe.size).toBe(2)
  })

  it('un 401 dalla firma ferma il lotto prima di firmare la foto successiva', async () => {
    h.righe.set(id(1), row(1))
    h.righe.set(id(2), row(2))
    h.carica.mockResolvedValueOnce({ ok: false, motivo: 'firma', stato: 401 })
    const post = vi.fn()
    vi.stubGlobal('fetch', post)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(h.carica).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
    expect(h.righe.size).toBe(2)
  })

  it('se la foto è scartata mentre il PUT è sospeso non pubblica il record', async () => {
    h.righe.set(id(1), row(1))
    let terminaPut: ((value: unknown) => void) | undefined
    h.carica.mockImplementationOnce(async (_file: File, _mime: string, opts: { onPath: (path: string) => Promise<void> }) => {
      await opts.onPath('uploads/' + ownerId + '/oggetto.jpg')
      return new Promise(resolve => { terminaPut = resolve })
    })
    const post = vi.fn()
    vi.stubGlobal('fetch', post)
    const task = drainGalleryPhotoQueue({ ownerId, schoolId })
    await vi.waitFor(() => expect(terminaPut).toBeDefined())
    expect(await scartaFotoInCoda({ ownerId, schoolId }, id(1))).toBe(true)
    terminaPut?.({ ok: true, path: 'uploads/' + ownerId + '/oggetto.jpg' })
    await task
    expect(post).not.toHaveBeenCalled()
    expect(h.righe.size).toBe(0)
  })

  it('un 503 con Retry-After sospende tutto il lotto senza tempestare il server', async () => {
    h.righe.set(id(1), row(1))
    h.righe.set(id(2), row(2))
    const post = vi.fn().mockResolvedValue({ ok: false, status: 503, headers: { get: () => '60' } })
    vi.stubGlobal('fetch', post)
    await drainGalleryPhotoQueue({ ownerId, schoolId })
    expect(post).toHaveBeenCalledTimes(1)
    expect(h.righe.get(id(1))?.next_attempt_at).toBe(Date.now() + 60_000)
    expect(h.righe.get(id(2))?.next_attempt_at).toBe(Date.now() + 60_000)
  })
})
