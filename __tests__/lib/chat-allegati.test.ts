import { describe, it, expect, vi, beforeEach } from 'vitest'

// S32 — LA CHAT ESCE DAL MODELLO DEL LINK ETERNO.
//
// Fino al 2026-08-01 `POST /api/chat/upload` firmava l'allegato con un TTL di
// **365 giorni** e il client salvava quell'indirizzo firmato dentro
// `chat_messages.attachment_url`: un link permanente travestito da link a
// scadenza. Chiunque avesse — o inoltrasse — quell'URL apriva per un anno il
// certificato, la foto o il documento scambiato fra una famiglia e la scuola,
// SENZA LOGIN, fuori da ogni gate.
//
// È la stessa forma da cui `avvisi_allegati` e `task_allegati` sono usciti il
// 2026-07-31: nel dato si conserva il PERCORSO, e la lettura genera un link
// firmato a tempo dietro allo stesso gate della route che lo serve.
//
// Qui si collauda il modulo che regge quel contratto per il bucket `chat-allegati`.

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
import { TTL_FIRMA_ALLEGATI_S } from '@/lib/allegati/storage'
import {
  BUCKET_CHAT_ALLEGATI,
  TTL_FIRMA_CHAT_S,
  normalizzaAllegatoChat,
  firmaAllegatiChat,
} from '@/lib/chat/allegati'

const PROGETTO = 'https://abcdefgh.supabase.co'
const UTENTE = 'aaaaaaaa-0000-4000-8000-000000000001'
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

describe('il TTL della chat è quello breve del progetto, non un anno', () => {
  it('vale quanto gli allegati di avvisi e incarichi (10 minuti)', () => {
    expect(TTL_FIRMA_CHAT_S).toBe(TTL_FIRMA_ALLEGATI_S)
  })

  // Controllo POSITIVO accanto all'asserzione negativa: senza, «non è 365
  // giorni» passerebbe anche con un TTL di 364 giorni.
  it('NON è il TTL di un anno da cui questo step fa uscire la chat', () => {
    const UN_ANNO_S = 60 * 60 * 24 * 365
    expect(TTL_FIRMA_CHAT_S).not.toBe(UN_ANNO_S)
    expect(TTL_FIRMA_CHAT_S).toBeLessThanOrEqual(3600)
  })

  it('il bucket è quello della chat', () => {
    expect(BUCKET_CHAT_ALLEGATI).toBe('chat-allegati')
  })
})

describe('normalizzaAllegatoChat — in tabella finisce il PERCORSO, mai un link firmato', () => {
  it('da un URL FIRMATO (quello che i client storici rimandano) ricava il percorso', () => {
    const url = `${PROGETTO}/storage/v1/object/sign/chat-allegati/${UTENTE}/abc-referto.pdf?token=eyJhbGciOi.molto.lungo`
    expect(normalizzaAllegatoChat(url)).toBe(`${UTENTE}/abc-referto.pdf`)
  })

  it('da un URL PUBBLICO storico ricava il percorso', () => {
    const url = `${PROGETTO}/storage/v1/object/public/chat-allegati/${UTENTE}/abc-referto.pdf`
    expect(normalizzaAllegatoChat(url)).toBe(`${UTENTE}/abc-referto.pdf`)
  })

  it('un percorso resta se stesso (e perde lo slash iniziale, che lo Storage non vuole)', () => {
    expect(normalizzaAllegatoChat(`${UTENTE}/abc-referto.pdf`)).toBe(`${UTENTE}/abc-referto.pdf`)
    expect(normalizzaAllegatoChat(`/${UTENTE}/abc-referto.pdf`)).toBe(`${UTENTE}/abc-referto.pdf`)
  })

  it('vuoto, spazi e assente valgono «nessun allegato»', () => {
    expect(normalizzaAllegatoChat(null)).toBeNull()
    expect(normalizzaAllegatoChat(undefined)).toBeNull()
    expect(normalizzaAllegatoChat('   ')).toBeNull()
  })

  it('un indirizzo che NON è del nostro bucket non è un allegato di chat', () => {
    // Un URL altrui in `attachment_url` diventa `<img src>` a casa del
    // destinatario: un pixel di tracciamento piazzato da un utente autenticato
    // dentro la conversazione di una famiglia. Non si accetta.
    expect(normalizzaAllegatoChat('https://tracker.example/pixel.png')).toBeNull()
    expect(
      normalizzaAllegatoChat(`${PROGETTO}/storage/v1/object/sign/gallery/${UTENTE}/foto.jpg?token=x`),
    ).toBeNull()
  })

  it('uno schema URI non è un percorso (javascript:, data:, //host)', () => {
    expect(normalizzaAllegatoChat('javascript:alert(1)')).toBeNull()
    expect(normalizzaAllegatoChat('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(normalizzaAllegatoChat('//tracker.example/pixel.png')).toBeNull()
  })

  it('rifiuta la risalita di percorso', () => {
    expect(normalizzaAllegatoChat(`${UTENTE}/../altro-utente/segreto.pdf`)).toBeNull()
  })
})

describe('firmaAllegatiChat — la lettura serve link firmati a tempo', () => {
  it('firma IN BLOCCO: una sola chiamata allo Storage per tutta la pagina', async () => {
    const righe = [
      { id: 'm1', attachment_url: `${UTENTE}/a.pdf` },
      { id: 'm2', attachment_url: null },
      { id: 'm3', attachment_url: `${UTENTE}/b.jpg` },
    ]
    h.risposta = {
      data: [
        { path: `${UTENTE}/a.pdf`, signedUrl: `${PROGETTO}/storage/v1/object/sign/chat-allegati/${UTENTE}/a.pdf?token=T1` },
        { path: `${UTENTE}/b.jpg`, signedUrl: `${PROGETTO}/storage/v1/object/sign/chat-allegati/${UTENTE}/b.jpg?token=T2` },
      ],
      error: null,
    }

    const out = await firmaAllegatiChat(supabase, righe, 'chat/messages:GET')

    expect(h.chiamate).toHaveLength(1)
    expect(h.chiamate[0]).toMatchObject({ bucket: BUCKET_CHAT_ALLEGATI, ttl: TTL_FIRMA_CHAT_S })
    expect(h.chiamate[0].percorsi).toEqual([`${UTENTE}/a.pdf`, `${UTENTE}/b.jpg`])
    expect(out[0].attachment_url).toContain('/object/sign/chat-allegati/')
    expect(out[0].attachment_url).toContain('token=T1')
    expect(out[1].attachment_url).toBeNull()
    expect(out[2].attachment_url).toContain('token=T2')
  })

  it('anche un URL firmato già in tabella viene RI-firmato (dato storico)', async () => {
    const vecchio = `${PROGETTO}/storage/v1/object/sign/chat-allegati/${UTENTE}/a.pdf?token=SCADUTO`
    h.risposta = {
      data: [{ path: `${UTENTE}/a.pdf`, signedUrl: `${PROGETTO}/storage/v1/object/sign/chat-allegati/${UTENTE}/a.pdf?token=NUOVO` }],
      error: null,
    }

    const out = await firmaAllegatiChat(supabase, [{ id: 'm1', attachment_url: vecchio }], 'chat/messages:GET')

    expect(h.chiamate[0].percorsi).toEqual([`${UTENTE}/a.pdf`])
    expect(out[0].attachment_url).toContain('token=NUOVO')
    expect(out[0].attachment_url).not.toContain('SCADUTO')
  })

  it('senza allegati non tocca affatto lo Storage', async () => {
    const righe = [{ id: 'm1', attachment_url: null }, { id: 'm2', attachment_url: '' }]
    const out = await firmaAllegatiChat(supabase, righe, 'chat/messages:GET')
    expect(h.chiamate).toHaveLength(0)
    expect(out).toEqual(righe)
  })

  it('lo stesso file in due messaggi si firma UNA volta sola', async () => {
    h.risposta = {
      data: [{ path: `${UTENTE}/a.pdf`, signedUrl: `${PROGETTO}/storage/v1/object/sign/chat-allegati/${UTENTE}/a.pdf?token=T` }],
      error: null,
    }
    await firmaAllegatiChat(
      supabase,
      [{ id: 'm1', attachment_url: `${UTENTE}/a.pdf` }, { id: 'm2', attachment_url: `/${UTENTE}/a.pdf` }],
      'chat/messages:GET',
    )
    expect(h.chiamate[0].percorsi).toEqual([`${UTENTE}/a.pdf`])
  })

  it('un valore che non è del nostro bucket esce NULL e non arriva mai al browser', async () => {
    const out = await firmaAllegatiChat(
      supabase,
      [
        { id: 'm1', attachment_url: 'https://tracker.example/pixel.png' },
        { id: 'm2', attachment_url: 'javascript:alert(1)' },
      ],
      'chat/messages:GET',
    )
    expect(h.chiamate).toHaveLength(0)
    expect(out[0].attachment_url).toBeNull()
    expect(out[1].attachment_url).toBeNull()
  })

  it('quando lo Storage rifiuta, l’allegato esce NULL — mai il percorso grezzo — e il log porta il corpo del provider', async () => {
    const errore = { message: 'Bucket not found', statusCode: '404' }
    h.risposta = { data: null, error: errore }

    const out = await firmaAllegatiChat(supabase, [{ id: 'm1', attachment_url: `${UTENTE}/a.pdf` }], 'chat/messages:GET')

    // Controllo POSITIVO: non basta «non è il percorso», deve essere null.
    expect(out[0].attachment_url).toBeNull()
    expect(out[0].attachment_url).not.toBe(`${UTENTE}/a.pdf`)

    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(ev[0][2]).toMatchObject({ esito: 'firma-link-non-riuscita', bucket: BUCKET_CHAT_ALLEGATI })
    expect(messaggioLoggato(ev[0][3])).toContain('Bucket not found')
  })

  it('un guasto di TRASPORTO non fa esplodere la lettura della chat', async () => {
    const out = await firmaAllegatiChat(supabaseRotto, [{ id: 'm1', attachment_url: `${UTENTE}/a.pdf` }], 'chat/messages:GET')
    expect(out[0].attachment_url).toBeNull()
    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(messaggioLoggato(ev[0][3])).toContain('ECONNRESET')
  })

  it('firma parziale: chi si firma passa, chi no esce null e finisce nel log', async () => {
    h.risposta = {
      data: [
        { path: `${UTENTE}/a.pdf`, signedUrl: `${PROGETTO}/storage/v1/object/sign/chat-allegati/${UTENTE}/a.pdf?token=T1` },
        { path: `${UTENTE}/b.jpg`, signedUrl: null, error: 'Object not found' },
      ],
      error: null,
    }

    const out = await firmaAllegatiChat(
      supabase,
      [{ id: 'm1', attachment_url: `${UTENTE}/a.pdf` }, { id: 'm2', attachment_url: `${UTENTE}/b.jpg` }],
      'chat/messages:GET',
    )

    expect(out[0].attachment_url).toContain('token=T1')
    expect(out[1].attachment_url).toBeNull()
    const ev = eventiStorage()
    expect(ev).toHaveLength(1)
    expect(ev[0][2]).toMatchObject({ esito: 'firma-link-parziale', n_falliti: 1 })
  })

  it('non muta le righe ricevute (le route rispondono con oggetti di altri)', async () => {
    const riga = { id: 'm1', attachment_url: `${UTENTE}/a.pdf` }
    h.risposta = {
      data: [{ path: `${UTENTE}/a.pdf`, signedUrl: `${PROGETTO}/storage/v1/object/sign/chat-allegati/${UTENTE}/a.pdf?token=T` }],
      error: null,
    }
    await firmaAllegatiChat(supabase, [riga], 'chat/messages:GET')
    expect(riga.attachment_url).toBe(`${UTENTE}/a.pdf`)
  })

  it('nel log non finisce MAI il nome del file (dice di che comunicazione si tratta)', async () => {
    h.risposta = { data: null, error: { message: 'boom' } }
    await firmaAllegatiChat(
      supabase,
      [{ id: 'm1', attachment_url: `${UTENTE}/certificato-medico-rossi.pdf` }],
      'chat/messages:GET',
    )
    const ev = eventiStorage()
    expect(JSON.stringify(ev)).not.toContain('certificato-medico-rossi')
    // Controllo positivo: il log C'È e dice quanti file non si sono firmati.
    expect(ev[0][2]).toMatchObject({ n_percorsi: 1 })
  })
})
