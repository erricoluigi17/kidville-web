import { describe, it, expect, vi, beforeEach } from 'vitest'

// Bucket `gallery` PRIVATO (2026-07-31). Prima era pubblico: chiunque avesse — o
// indovinasse — l'indirizzo di un file vedeva la foto di un bambino SENZA LOGIN,
// per sempre. Il filtro di sede e la regola «foto privata» giravano solo sul
// database, mai sul file. Ora il DB conserva il PERCORSO nel bucket e la lettura
// serve un link FIRMATO a tempo, generato dietro allo stesso gate della route.
//
// Qui si collauda il modulo che regge quel contratto:
//  - `percorsoNelBucket`: da qualunque valore storico di `file_url` al percorso;
//  - `firmaMediaGalleria`: UNA sola chiamata in blocco (`createSignedUrls`) per
//    pagina, e il fallimento della firma NON fa sparire la foto in silenzio.

// La forma di risposta di `createSignedUrls` (storage-js): un elemento per
// percorso, con `error` valorizzato quando quel singolo file non si è firmato.
type RispostaFirma = {
  data: Array<{ path: string | null; signedUrl: string | null; error?: string | null }> | null
  error: unknown
}

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  // Ultima invocazione di createSignedUrls: [percorsi, ttl]
  chiamate: [] as Array<{ percorsi: string[]; ttl: number }>,
  risposta: { data: [], error: null } as RispostaFirma,
}))

vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

import { descriviErrore } from '@/lib/logging/serialize'
import {
  BUCKET_GALLERIA,
  TTL_FIRMA_GALLERIA_S,
  percorsoNelBucket,
  firmaMediaGalleria,
} from '@/lib/gallery/storage'

// Il corpo dell'errore si legge come lo leggerebbe il logger reale: `JSON.stringify`
// su un `Error` dà `{}` e non proverebbe nulla.
const messaggioLoggato = (err: unknown) => descriviErrore(err).messaggio

// Client Supabase simulato: registra ogni chiamata alla firma in blocco e
// restituisce la risposta preparata dal test. `from` accetta SOLO il bucket
// della galleria: se il codice firmasse su un altro bucket, il test lo vede.
const supabase = {
  storage: {
    from: (bucket: string) => {
      if (bucket !== BUCKET_GALLERIA) throw new Error(`bucket inatteso: ${bucket}`)
      return {
        createSignedUrls: async (percorsi: string[], ttl: number) => {
          h.chiamate.push({ percorsi, ttl })
          return h.risposta
        },
      }
    },
  },
}

const eventiStorage = () => h.logEvento.mock.calls.filter((c) => c[0] === 'storage')

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamate = []
  h.risposta = { data: [], error: null }
})

describe('percorsoNelBucket — dal valore storico di file_url al percorso', () => {
  it('un percorso semplice resta se stesso', () => {
    expect(percorsoNelBucket('uploads/ed1/1753-abc.jpg')).toBe('uploads/ed1/1753-abc.jpg')
  })

  it('riconosce un URL PUBBLICO completo e ne ricava il percorso', () => {
    const url = 'https://abcdef.supabase.co/storage/v1/object/public/gallery/uploads/ed1/1753-abc.jpg'
    expect(percorsoNelBucket(url)).toBe('uploads/ed1/1753-abc.jpg')
  })

  it('riconosce un URL già FIRMATO (e ne butta via il token scaduto)', () => {
    const url = 'https://abcdef.supabase.co/storage/v1/object/sign/gallery/uploads/ed1/x.jpg?token=vecchio'
    expect(percorsoNelBucket(url)).toBe('uploads/ed1/x.jpg')
  })

  it('decodifica il percorso percent-encoded dell\'URL', () => {
    const url = 'https://abcdef.supabase.co/storage/v1/object/public/gallery/uploads/ed1/foto%20di%20gruppo.jpg'
    expect(percorsoNelBucket(url)).toBe('uploads/ed1/foto di gruppo.jpg')
  })

  it('un percent-encoding malformato non fa esplodere nulla: resta grezzo', () => {
    const url = 'https://abcdef.supabase.co/storage/v1/object/public/gallery/uploads/ed1/50%.jpg'
    expect(percorsoNelBucket(url)).toBe('uploads/ed1/50%.jpg')
  })

  it('un URL di UN ALTRO bucket non è della galleria → null', () => {
    const url = 'https://abcdef.supabase.co/storage/v1/object/public/avvisi-allegati/x.png'
    expect(percorsoNelBucket(url)).toBeNull()
  })

  it('un indirizzo esterno non è firmabile → null', () => {
    expect(percorsoNelBucket('https://cdn.example/foto.jpg')).toBeNull()
  })

  it('vuoto, nullo e indefinito → null', () => {
    expect(percorsoNelBucket('')).toBeNull()
    expect(percorsoNelBucket(null)).toBeNull()
    expect(percorsoNelBucket(undefined)).toBeNull()
  })
})

describe('firmaMediaGalleria — una sola chiamata per pagina', () => {
  it('firma in BLOCCO: 3 media, 1 sola chiamata, TTL breve', async () => {
    h.risposta = {
      data: [
        { path: 'uploads/a.jpg', signedUrl: 'https://firmato/a', error: null },
        { path: 'uploads/b.jpg', signedUrl: 'https://firmato/b', error: null },
        { path: 'uploads/c.jpg', signedUrl: 'https://firmato/c', error: null },
      ],
      error: null,
    }
    const righe = [
      { id: '1', file_url: 'uploads/a.jpg' },
      { id: '2', file_url: 'uploads/b.jpg' },
      { id: '3', file_url: 'uploads/c.jpg' },
    ]
    const out = await firmaMediaGalleria(supabase, righe, 'gallery:GET')

    expect(h.chiamate).toHaveLength(1)
    expect(h.chiamate[0].percorsi).toEqual(['uploads/a.jpg', 'uploads/b.jpg', 'uploads/c.jpg'])
    expect(h.chiamate[0].ttl).toBe(TTL_FIRMA_GALLERIA_S)
    expect(TTL_FIRMA_GALLERIA_S).toBeLessThanOrEqual(600)
    expect(out.map((r) => r.file_url)).toEqual(['https://firmato/a', 'https://firmato/b', 'https://firmato/c'])
    // Gli altri campi della riga restano intatti.
    expect(out[0].id).toBe('1')
  })

  it('firma anche le righe STORICHE salvate come URL pubblico completo', async () => {
    h.risposta = {
      data: [{ path: 'uploads/ed1/x.jpg', signedUrl: 'https://firmato/x', error: null }],
      error: null,
    }
    const out = await firmaMediaGalleria(
      supabase,
      [{ id: '1', file_url: 'https://abcdef.supabase.co/storage/v1/object/public/gallery/uploads/ed1/x.jpg' }],
      'gallery:GET',
    )
    expect(h.chiamate[0].percorsi).toEqual(['uploads/ed1/x.jpg'])
    expect(out[0].file_url).toBe('https://firmato/x')
  })

  it('lo stesso percorso ripetuto si firma UNA volta sola', async () => {
    h.risposta = { data: [{ path: 'uploads/a.jpg', signedUrl: 'https://firmato/a', error: null }], error: null }
    const out = await firmaMediaGalleria(
      supabase,
      [{ id: '1', file_url: 'uploads/a.jpg' }, { id: '2', file_url: 'uploads/a.jpg' }],
      'gallery:GET',
    )
    expect(h.chiamate[0].percorsi).toEqual(['uploads/a.jpg'])
    expect(out.map((r) => r.file_url)).toEqual(['https://firmato/a', 'https://firmato/a'])
  })

  it('nessun percorso da firmare → lo storage non viene toccato affatto', async () => {
    const out = await firmaMediaGalleria(supabase, [{ id: '1', file_url: null }], 'gallery:GET')
    expect(h.chiamate).toHaveLength(0)
    expect(out[0].file_url).toBeNull()
  })

  it('pagina vuota → nessuna chiamata', async () => {
    const out = await firmaMediaGalleria(supabase, [], 'gallery:GET')
    expect(h.chiamate).toHaveLength(0)
    expect(out).toEqual([])
  })
})

describe('firmaMediaGalleria — il fallimento non sparisce in silenzio', () => {
  it('errore GLOBALE: file_url a null e log `error` COL CORPO del provider', async () => {
    h.risposta = { data: null, error: { message: 'Bucket not found', status: 404 } }
    const out = await firmaMediaGalleria(supabase, [{ id: '1', file_url: 'uploads/a.jpg' }], 'gallery:GET')

    // La foto non si serve con un indirizzo che non funziona.
    expect(out[0].file_url).toBeNull()

    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(ev[0][2]).toMatchObject({ operazione: 'gallery:GET', bucket: BUCKET_GALLERIA })
    // Il CORPO dell'errore del provider, non solo lo status: `403` non dice
    // nulla, `403 "the domain is not verified"` dice tutto (AGENTS §3).
    expect(ev[0][3]).toBeDefined()
    expect(messaggioLoggato(ev[0][3])).toContain('Bucket not found')
  })

  it('errore su UN SOLO percorso: solo quella foto va a null, le altre restano', async () => {
    h.risposta = {
      data: [
        { path: 'uploads/a.jpg', signedUrl: 'https://firmato/a', error: null },
        { path: 'uploads/b.jpg', signedUrl: null, error: 'Object not found' },
      ],
      error: null,
    }
    const out = await firmaMediaGalleria(
      supabase,
      [{ id: '1', file_url: 'uploads/a.jpg' }, { id: '2', file_url: 'uploads/b.jpg' }],
      'gallery:GET',
    )
    expect(out[0].file_url).toBe('https://firmato/a')
    expect(out[1].file_url).toBeNull()

    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(ev[0][2]).toMatchObject({ operazione: 'gallery:GET', n_falliti: 1 })
    expect(messaggioLoggato(ev[0][3])).toContain('Object not found')
  })

  it('nel log NIENTE percorsi né nomi di file: solo conteggi', async () => {
    h.risposta = { data: null, error: { message: 'boom' } }
    await firmaMediaGalleria(
      supabase,
      [{ id: '1', file_url: 'uploads/ed1/foto-di-mario-rossi.jpg' }],
      'gallery:GET',
    )
    const payload = JSON.stringify(eventiStorage()[0][2])
    expect(payload).not.toContain('mario')
    expect(payload).not.toContain('foto-di-mario-rossi')
    expect(payload).not.toContain('uploads/')
  })

  it('lo storage che ESPLODE non rompe la lettura: righe a null + log error', async () => {
    const rotto = {
      storage: {
        from: () => ({
          createSignedUrls: async () => {
            throw new Error('rete giù')
          },
        }),
      },
    }
    const out = await firmaMediaGalleria(rotto, [{ id: '1', file_url: 'uploads/a.jpg' }], 'gallery:GET')
    expect(out[0].file_url).toBeNull()
    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(messaggioLoggato(ev[0][3])).toContain('rete giù')
  })
})
