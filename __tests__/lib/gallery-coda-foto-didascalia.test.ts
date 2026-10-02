import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================================
// LA CODA DELLE FOTO NON MANDA PIÙ LA DIDASCALIA (decisione del titolare, 2026-10-02).
//
// La riga locale della coda (IndexedDB) tiene il nome del file in `caption`: serve a
// mostrarlo sul dispositivo (`CodaFoto`), perché la maestra riconosca la foto che sta
// aspettando. Fino a oggi lo stesso valore partiva anche verso il server, dove diventava
// la didascalia pubblica della foto e il corpo della notifica ai genitori — e il nome di
// un file è, nella pratica, il nome di un bambino.
//
// Da oggi il POST porta `caption: null`. Questo file prova le due metà:
//  · dal dispositivo NON parte il nome del file (né nel campo, né altrove nel corpo);
//  · sul dispositivo il nome RESTA, finché la foto è in coda.
//
// (Il server, a sua volta, ignora la didascalia che gli arriva: `gallery-didascalia-nulla`.
// Sono due difese distinte, perché un telefono col bundle vecchio la manda ancora.)
// =============================================================================

type Riga = Record<string, unknown> & { id: string }
const h = vi.hoisted(() => ({
  righe: new Map<string, Riga>(),
  carica: vi.fn(),
  log: vi.fn(),
}))
vi.mock('@/lib/offline/db', () => ({
  db: {
    galleria: {
      toArray: async () => [...h.righe.values()],
      get: async (id: string) => h.righe.get(id),
      put: async (riga: Riga) => { h.righe.set(riga.id, structuredClone(riga)) },
      update: async (id: string, modifiche: Record<string, unknown>) => {
        const riga = h.righe.get(id)
        if (riga) h.righe.set(id, { ...riga, ...structuredClone(modifiche) })
      },
      delete: async (id: string) => { h.righe.delete(id) },
    },
  },
}))
vi.mock('@/lib/gallery/carica-media', () => ({ caricaMediaGalleria: h.carica }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.log, nomeErrore: (e: Error) => e.name }))

import { drainGalleryPhotoQueue, listaFotoInCoda } from '@/lib/gallery/coda-foto'

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEDE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ID = 'cccccccc-cccc-4ccc-8ccc-000000000001'
const PERCORSO = `uploads/${OWNER}/oggetto.jpg`
/** Il nome di file che la maestra ha scelto: contiene il nome di un bambino. */
const NOME_FILE = 'Marco-al-parco-IMG_4821.jpg'

/** Una foto già caricata nello Storage e pronta per il POST: salta l'upload. */
const rigaPronta = (extra: Record<string, unknown> = {}): Riga => ({
  id: ID,
  uploaded_by: OWNER,
  scuola_id: SEDE,
  upload_id: ID,
  caption: NOME_FILE,
  tag_students: [],
  is_broadcast: false,
  target_classes: null,
  file_type: 'foto',
  file_blob: new Blob(['x'], { type: 'image/jpeg' }),
  file_name: NOME_FILE,
  sync_status: 'pending',
  phase: 'publish',
  storage_path: PERCORSO,
  next_attempt_at: null,
  creato_il: '2026-10-02T00:00:00.000Z',
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.righe.clear()
})
// `fetch` si ripristina SEMPRE, anche se un'asserzione ha lanciato prima: un `fetch` finto che
// resta in giro farebbe passare (o cadere) i test che vengono dopo per un motivo che non è il loro.
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dal dispositivo al server: il nome del file non parte', () => {
  it('il POST porta `caption: null`, e il nome del file non compare in nessun punto del corpo', async () => {
    h.righe.set(ID, rigaPronta())
    const post = vi.fn().mockResolvedValue({ ok: true, status: 201 })
    vi.stubGlobal('fetch', post)

    await drainGalleryPhotoQueue({ ownerId: OWNER, schoolId: SEDE })

    expect(post).toHaveBeenCalledOnce()
    const testo = String(post.mock.calls[0][1].body)
    const corpo = JSON.parse(testo)
    expect(corpo.caption).toBeNull()
    // Il campo c'è e vale null: «non lo mando» non vuol dire «lo mando vuoto di nascosto».
    expect(corpo).toHaveProperty('caption')
    expect(testo).not.toContain(NOME_FILE)
    expect(testo).not.toContain('Marco')
    // E il resto del corpo è quello di sempre: l'idempotenza e la sede non si toccano.
    expect(corpo).toMatchObject({
      uploaded_by: OWNER,
      scuola_id: SEDE,
      upload_id: ID,
      file_url: PERCORSO,
      file_type: 'foto',
      tag_students: [],
      is_broadcast: false,
    })
  })

  it('anche una riga con la didascalia vuota o assente manda `null`', async () => {
    for (const caption of [null, '', undefined]) {
      h.righe.clear()
      h.righe.set(ID, rigaPronta({ caption }))
      const post = vi.fn().mockResolvedValue({ ok: true, status: 201 })
      vi.stubGlobal('fetch', post)
      await drainGalleryPhotoQueue({ ownerId: OWNER, schoolId: SEDE })
      expect(JSON.parse(String(post.mock.calls[0][1].body)).caption, JSON.stringify(caption)).toBeNull()
    }
  })
})

describe('sul dispositivo: la vista della coda continua a mostrare il nome del file', () => {
  it('una foto che non riesce a partire resta in coda con il suo nome', async () => {
    h.righe.set(ID, rigaPronta())
    // Rete assente: il POST non parte, la riga resta e il nome con lei.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('rete')))

    await drainGalleryPhotoQueue({ ownerId: OWNER, schoolId: SEDE })

    const inCoda = await listaFotoInCoda({ ownerId: OWNER, schoolId: SEDE })
    expect(inCoda).toHaveLength(1)
    expect(inCoda[0].caption).toBe(NOME_FILE)
    expect(inCoda[0].file_name).toBe(NOME_FILE)
  })
})
