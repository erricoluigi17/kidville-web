import { describe, it, expect, vi, beforeEach } from 'vitest'

// Bucket `avvisi_allegati` e `task_allegati` PRIVATI (2026-07-31). Fino a oggi
// erano `public: true` e nel database finiva l'indirizzo di `getPublicUrl`:
// chiunque avesse — o indovinasse — quell'URL scaricava l'allegato di una
// comunicazione scolastica SENZA LOGIN e PER SEMPRE. Il gate di ruolo e
// l'isolamento per sede giravano sul database, mai sul file.
//
// Stesso rimedio già in esercizio sulla galleria (`src/lib/gallery/storage.ts`,
// il modello): nel dato si conserva il PERCORSO nel bucket e la lettura serve un
// link FIRMATO a tempo, dietro allo stesso gate della route che lo produce.
//
// Qui si collauda il modulo che regge quel contratto per i due bucket.

// Forma di risposta di `createSignedUrls` (storage-js): un elemento per
// percorso, con `error` valorizzato quando quel singolo file non si è firmato.
type RispostaFirma = {
  data: Array<{ path: string | null; signedUrl: string | null; error?: string | null }> | null
  error: unknown
}

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  chiamate: [] as Array<{ bucket: string; percorsi: string[]; ttl: number }>,
  risposta: { data: [], error: null } as RispostaFirma,
}))

vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

import { descriviErrore } from '@/lib/logging/serialize'
import { TTL_FIRMA_GALLERIA_S } from '@/lib/gallery/storage'
import {
  BUCKET_AVVISI_ALLEGATI,
  BUCKET_TASK_ALLEGATI,
  TTL_FIRMA_ALLEGATI_S,
  percorsoNelBucket,
  firmaAllegatiAvvisi,
  normalizzaAllegatoAvviso,
  firmaAllegatiTask,
  normalizzaAllegatiTask,
} from '@/lib/allegati/storage'

const PROGETTO = 'https://abcdefgh.supabase.co'
const messaggioLoggato = (err: unknown) => descriviErrore(err).messaggio

// Client Supabase simulato: registra ogni firma in blocco e restituisce la
// risposta preparata dal test.
const supabase = {
  storage: {
    from: (bucket: string) => ({
      createSignedUrls: async (percorsi: string[], ttl: number) => {
        h.chiamate.push({ bucket, percorsi, ttl })
        return h.risposta
      },
    }),
  },
}

// Client che ESPLODE: guasto di trasporto (il fetch che non arriva allo Storage).
const supabaseRotto = {
  storage: {
    from: () => ({
      createSignedUrls: async () => {
        throw new Error('fetch failed: ECONNRESET')
      },
    }),
  },
}

const eventiStorage = () => h.logEvento.mock.calls.filter((c) => c[0] === 'storage')

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamate = []
  h.risposta = { data: [], error: null }
})

describe('percorsoNelBucket — da qualunque valore storico al percorso', () => {
  it('un percorso semplice resta se stesso', () => {
    expect(percorsoNelBucket(BUCKET_AVVISI_ALLEGATI, '1779633720167-cf3vwoq.pdf')).toBe(
      '1779633720167-cf3vwoq.pdf',
    )
  })

  it('riconosce un URL PUBBLICO completo e ne ricava il percorso', () => {
    const url = `${PROGETTO}/storage/v1/object/public/avvisi_allegati/1779633720167-cf3vwoq.pdf`
    expect(percorsoNelBucket(BUCKET_AVVISI_ALLEGATI, url)).toBe('1779633720167-cf3vwoq.pdf')
  })

  it('riconosce un URL già FIRMATO e ne butta via il token scaduto', () => {
    const url = `${PROGETTO}/storage/v1/object/sign/task_allegati/verbale.pdf?token=eyJhbGciOi.SCADUTO`
    expect(percorsoNelBucket(BUCKET_TASK_ALLEGATI, url)).toBe('verbale.pdf')
  })

  it('un indirizzo di un ALTRO bucket non viene reinterpretato', () => {
    const url = `${PROGETTO}/storage/v1/object/public/gallery/uploads/ed1/foto.jpg`
    expect(percorsoNelBucket(BUCKET_AVVISI_ALLEGATI, url)).toBeNull()
  })

  it('un link esterno (non è lo Storage) resta fuori: non è firmabile qui', () => {
    expect(percorsoNelBucket(BUCKET_AVVISI_ALLEGATI, 'https://comune.example/bando.pdf')).toBeNull()
  })

  it('vuoto e nullo danno null', () => {
    expect(percorsoNelBucket(BUCKET_AVVISI_ALLEGATI, '')).toBeNull()
    expect(percorsoNelBucket(BUCKET_AVVISI_ALLEGATI, null)).toBeNull()
    expect(percorsoNelBucket(BUCKET_AVVISI_ALLEGATI, undefined)).toBeNull()
  })
})

describe('TTL — la scadenza è quella della galleria, non una seconda inventata', () => {
  it('vale 10 minuti, come il modello', () => {
    expect(TTL_FIRMA_ALLEGATI_S).toBe(TTL_FIRMA_GALLERIA_S)
    expect(TTL_FIRMA_ALLEGATI_S).toBe(600)
  })
})

describe('firmaAllegatiAvvisi — l\'allegato di un avviso esce FIRMATO', () => {
  it('firma il file e lascia intatto il link esterno (una sola chiamata per pagina)', async () => {
    h.risposta = {
      data: [
        { path: 'a.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/avvisi_allegati/a.pdf?token=T1`, error: null },
        { path: 'b.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/avvisi_allegati/b.pdf?token=T2`, error: null },
      ],
      error: null,
    }
    const righe = [
      { id: 'av1', attachment_url: JSON.stringify({ file: 'a.pdf', link: 'https://comune.example/bando' }) },
      { id: 'av2', attachment_url: JSON.stringify({ file: 'b.pdf', link: null }) },
    ]

    const out = await firmaAllegatiAvvisi(supabase, righe, 'avvisi:GET')

    // CONTROLLO POSITIVO: l'URL c'è, è firmato, e porta il percorso del file giusto.
    const primo = JSON.parse(out[0].attachment_url as string)
    expect(primo.file).toContain('/object/sign/avvisi_allegati/a.pdf')
    expect(primo.file).toContain('token=T1')
    // …e non è un indirizzo pubblico.
    expect(primo.file).not.toContain('/object/public/')
    // Il link esterno non è materia di firma: resta esattamente com'era.
    expect(primo.link).toBe('https://comune.example/bando')

    const secondo = JSON.parse(out[1].attachment_url as string)
    expect(secondo.file).toContain('/object/sign/avvisi_allegati/b.pdf')
    expect(secondo.link).toBeNull()

    // Una sola chiamata in blocco, sul bucket giusto, col TTL del modello.
    expect(h.chiamate).toHaveLength(1)
    expect(h.chiamate[0].bucket).toBe(BUCKET_AVVISI_ALLEGATI)
    expect(h.chiamate[0].percorsi).toEqual(['a.pdf', 'b.pdf'])
    expect(h.chiamate[0].ttl).toBe(TTL_FIRMA_ALLEGATI_S)

    // Gli altri campi della riga non si perdono per strada.
    expect(out[0].id).toBe('av1')
  })

  it('firma anche il formato STORICO (stringa nuda) e l\'URL pubblico salvato prima di oggi', async () => {
    h.risposta = {
      data: [{ path: 'storico.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/avvisi_allegati/storico.pdf?token=T`, error: null }],
      error: null,
    }
    const righe = [
      { id: 'av1', attachment_url: `${PROGETTO}/storage/v1/object/public/avvisi_allegati/storico.pdf` },
    ]
    const out = await firmaAllegatiAvvisi(supabase, righe, 'avvisi:GET')
    expect(h.chiamate[0].percorsi).toEqual(['storico.pdf'])
    expect(out[0].attachment_url).toContain('/object/sign/avvisi_allegati/storico.pdf')
    expect(out[0].attachment_url).not.toContain('/object/public/')
  })

  it('senza allegati non tocca lo Storage', async () => {
    const righe = [{ id: 'av1', attachment_url: null }, { id: 'av2', attachment_url: '' }]
    const out = await firmaAllegatiAvvisi(supabase, righe, 'avvisi:GET')
    expect(h.chiamate).toHaveLength(0)
    expect(out).toEqual(righe)
  })

  it('un avviso col SOLO link esterno non fa firmare niente e il link sopravvive', async () => {
    const righe = [{ id: 'av1', attachment_url: JSON.stringify({ file: null, link: 'https://comune.example/x' }) }]
    const out = await firmaAllegatiAvvisi(supabase, righe, 'avvisi:GET')
    expect(h.chiamate).toHaveLength(0)
    expect(JSON.parse(out[0].attachment_url as string).link).toBe('https://comune.example/x')
  })

  it('firma fallita: il file esce a null (mai il percorso grezzo) e si logga `error` COL CORPO', async () => {
    h.risposta = { data: null, error: { message: 'Object not found', status: 404 } }
    const righe = [{ id: 'av1', attachment_url: JSON.stringify({ file: 'a.pdf', link: 'https://comune.example/x' }) }]

    const out = await firmaAllegatiAvvisi(supabase, righe, 'avvisi:GET')

    const dec = JSON.parse(out[0].attachment_url as string)
    expect(dec.file).toBeNull()
    // Il link esterno non c'entra col guasto dello Storage: resta.
    expect(dec.link).toBe('https://comune.example/x')

    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(ev[0][2]).toMatchObject({ operazione: 'avvisi:GET', bucket: BUCKET_AVVISI_ALLEGATI })
    expect(messaggioLoggato(ev[0][3])).toContain('Object not found')
    // Nel log solo conteggi: il nome del file di una comunicazione non ci va.
    expect(JSON.stringify(ev[0][2])).not.toContain('a.pdf')
  })

  it('guasto di TRASPORTO (createSignedUrls lancia): non esplode, logga `error`, file a null', async () => {
    const righe = [{ id: 'av1', attachment_url: JSON.stringify({ file: 'a.pdf', link: null }) }]
    const out = await firmaAllegatiAvvisi(supabaseRotto, righe, 'avvisi:GET')
    expect(JSON.parse(out[0].attachment_url as string).file).toBeNull()
    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(messaggioLoggato(ev[0][3])).toContain('ECONNRESET')
  })

  it('firma PARZIALE (un file non firmato): quello firmato esce, l\'altro a null, e si logga', async () => {
    h.risposta = {
      data: [
        { path: 'a.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/avvisi_allegati/a.pdf?token=T1`, error: null },
        { path: 'b.pdf', signedUrl: null, error: 'Object not found' },
      ],
      error: null,
    }
    const righe = [
      { id: 'av1', attachment_url: JSON.stringify({ file: 'a.pdf', link: null }) },
      { id: 'av2', attachment_url: JSON.stringify({ file: 'b.pdf', link: null }) },
    ]
    const out = await firmaAllegatiAvvisi(supabase, righe, 'avvisi:GET')
    expect(JSON.parse(out[0].attachment_url as string).file).toContain('token=T1')
    expect(JSON.parse(out[1].attachment_url as string).file).toBeNull()
    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(messaggioLoggato(ev[0][3])).toContain('Object not found')
  })
})

describe('normalizzaAllegatoAvviso — in tabella il PERCORSO, non un indirizzo che scade', () => {
  it('un URL firmato rimandato dal client torna a essere il percorso', () => {
    const valore = JSON.stringify({
      file: `${PROGETTO}/storage/v1/object/sign/avvisi_allegati/a.pdf?token=SCADUTO`,
      link: 'https://comune.example/x',
    })
    const out = JSON.parse(normalizzaAllegatoAvviso(valore) as string)
    expect(out.file).toBe('a.pdf')
    expect(out.link).toBe('https://comune.example/x')
  })

  it('un URL pubblico storico diventa percorso', () => {
    const valore = `${PROGETTO}/storage/v1/object/public/avvisi_allegati/a.pdf`
    expect(normalizzaAllegatoAvviso(valore)).toBe('a.pdf')
  })

  it('un percorso passa intatto e un link esterno non viene reinterpretato', () => {
    expect(normalizzaAllegatoAvviso('a.pdf')).toBe('a.pdf')
    expect(normalizzaAllegatoAvviso('https://comune.example/bando.pdf')).toBe(
      'https://comune.example/bando.pdf',
    )
  })

  it('vuoto e nullo restano nulli', () => {
    expect(normalizzaAllegatoAvviso(null)).toBeNull()
    expect(normalizzaAllegatoAvviso('')).toBeNull()
  })
})

describe('firmaAllegatiTask — anche gli allegati annidati escono firmati', () => {
  const taskConAllegati = () => [
    {
      id: 't1',
      titolo: 'Verifica antincendio',
      attachments: [{ name: 'verbale.pdf', url: 'verbale.pdf', size: 10, type: 'application/pdf' }],
      compiti: [
        {
          id: 'c1',
          attachments: [{ name: 'foto.jpg', url: 'foto.jpg', size: 20, type: 'image/jpeg' }],
          commenti: [
            {
              id: 'k1',
              attachments: [{ name: 'nota.pdf', url: 'nota.pdf', size: 30, type: 'application/pdf' }],
            },
          ],
        },
      ],
      commenti: [
        { id: 'k2', attachments: [{ name: 'esterno', url: 'https://comune.example/x.pdf', size: 1, type: 'application/pdf' }] },
      ],
    },
  ]

  it('firma task, sotto-compiti e commenti con UNA sola chiamata in blocco', async () => {
    h.risposta = {
      data: [
        { path: 'verbale.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/verbale.pdf?token=A`, error: null },
        { path: 'foto.jpg', signedUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/foto.jpg?token=B`, error: null },
        { path: 'nota.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/nota.pdf?token=C`, error: null },
      ],
      error: null,
    }

    const out = await firmaAllegatiTask(supabase, taskConAllegati(), 'tasks:GET')

    // CONTROLLO POSITIVO a ogni livello: l'URL esiste, è firmato, e nomina il file giusto.
    expect(out[0].attachments[0].url).toContain('/object/sign/task_allegati/verbale.pdf')
    expect(out[0].compiti[0].attachments[0].url).toContain('/object/sign/task_allegati/foto.jpg')
    expect(out[0].compiti[0].commenti[0].attachments[0].url).toContain('/object/sign/task_allegati/nota.pdf')
    expect(JSON.stringify(out)).not.toContain('/object/public/')

    // I metadati dell'allegato non si perdono nella riscrittura.
    expect(out[0].attachments[0]).toMatchObject({ name: 'verbale.pdf', size: 10, type: 'application/pdf' })

    // Il link esterno non appartiene al bucket: non si tocca.
    expect(out[0].commenti[0].attachments[0].url).toBe('https://comune.example/x.pdf')

    expect(h.chiamate).toHaveLength(1)
    expect(h.chiamate[0].bucket).toBe(BUCKET_TASK_ALLEGATI)
    expect(h.chiamate[0].percorsi).toEqual(['verbale.pdf', 'foto.jpg', 'nota.pdf'])
    expect(h.chiamate[0].ttl).toBe(TTL_FIRMA_ALLEGATI_S)
  })

  it('senza allegati non tocca lo Storage', async () => {
    const righe = [{ id: 't1', titolo: 'x', attachments: [], compiti: [], commenti: [] }]
    const out = await firmaAllegatiTask(supabase, righe, 'tasks:GET')
    expect(h.chiamate).toHaveLength(0)
    expect(out).toEqual(righe)
  })

  it('firma anche gli allegati salvati come `fileUrl` — è la forma che il client archivia', async () => {
    // Il tipo dichiara `url`, ma quello che finisce nel payload è l'oggetto
    // restituito dall'upload, che porta `fileUrl`: `TaskCard` e
    // `StudentDetailPanel` leggono infatti `att.fileUrl || att.url`. Firmare
    // solo `url` lascerebbe rotti proprio gli allegati veri.
    h.risposta = {
      data: [{ path: 'verbale.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/verbale.pdf?token=A`, error: null }],
      error: null,
    }
    const righe = [{ id: 't1', attachments: [{ name: 'verbale.pdf', fileUrl: 'verbale.pdf', size: 10, type: 'application/pdf' }] }]
    const out = await firmaAllegatiTask(supabase, righe, 'tasks:GET')
    expect(h.chiamate[0].percorsi).toEqual(['verbale.pdf'])
    expect(out[0].attachments[0].fileUrl).toContain('/object/sign/task_allegati/verbale.pdf')
    expect(out[0].attachments[0].name).toBe('verbale.pdf')
  })

  it('firma fallita: url a null (mai il percorso grezzo) e log `error` col corpo', async () => {
    h.risposta = { data: null, error: { message: 'Bucket not found', status: 404 } }
    const out = await firmaAllegatiTask(supabase, taskConAllegati(), 'tasks:GET')
    expect(out[0].attachments[0].url).toBeNull()
    expect(out[0].compiti[0].attachments[0].url).toBeNull()
    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(ev[0][2]).toMatchObject({ operazione: 'tasks:GET', bucket: BUCKET_TASK_ALLEGATI })
    expect(messaggioLoggato(ev[0][3])).toContain('Bucket not found')
  })
})

describe('normalizzaAllegatiTask — si archivia il percorso', () => {
  it('riporta al percorso gli url firmati rimandati dal client, a ogni livello', () => {
    const payload = {
      attachments: [
        { name: 'verbale.pdf', url: `${PROGETTO}/storage/v1/object/sign/task_allegati/verbale.pdf?token=SCADUTO` },
      ],
      compiti: [
        { id: 'c1', attachments: [{ name: 'foto.jpg', url: `${PROGETTO}/storage/v1/object/public/task_allegati/foto.jpg` }] },
      ],
    }
    const out = normalizzaAllegatiTask(payload)
    expect(out.attachments[0].url).toBe('verbale.pdf')
    expect(out.compiti[0].attachments[0].url).toBe('foto.jpg')
    expect(out.attachments[0].name).toBe('verbale.pdf')
  })

  it('un link esterno non viene reinterpretato', () => {
    const payload = { attachments: [{ name: 'x', url: 'https://comune.example/x.pdf' }] }
    expect(normalizzaAllegatiTask(payload).attachments[0].url).toBe('https://comune.example/x.pdf')
  })

  it('riporta al percorso anche `fileUrl` e `previewUrl` (le chiavi che il client salva)', () => {
    const payload = {
      attachments: [{
        name: 'verbale.pdf',
        fileUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/verbale.pdf?token=SCADUTO`,
        previewUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/verbale.pdf?token=SCADUTO`,
        path: 'verbale.pdf',
      }],
    }
    const out = normalizzaAllegatiTask(payload)
    expect(out.attachments[0].fileUrl).toBe('verbale.pdf')
    expect(out.attachments[0].previewUrl).toBe('verbale.pdf')
  })
})
