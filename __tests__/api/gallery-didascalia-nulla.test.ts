import { beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================================
// `POST /api/gallery` — NESSUNA DIDASCALIA ai contenuti nuovi, e un avviso ai genitori
// che non nomina niente (decisione del titolare, 2026-10-02).
//
// ─── IL PERCHÉ ───────────────────────────────────────────────────────────────
// La `caption` di una foto era il nome del file scelto da chi carica, e nella pratica di
// questa scuola è «Marco al parco.jpg»: il nome di un bambino. Finiva in tre posti:
// nella riga di galleria, nel corpo della notifica push ai genitori («Marco al parco.jpg»
// sulla schermata di blocco di ogni famiglia taggata) e — se qualcuno la loggava — in
// `app_log`. Da oggi la riga nasce sempre con `caption` NULL, qualunque cosa mandi il
// client, e l'avviso ha un testo fisso. Le 4.195 didascalie esistenti non si toccano, e
// la modifica esplicita (`PATCH`) resta com'è (la prova sta in `gallery-auth.test.ts`).
//
// ─── COME SI PROVA ───────────────────────────────────────────────────────────
// Il client manda una didascalia che è un nome di bambino riconoscibile, e si guarda
// OGNI posto in cui potrebbe arrivare: la riga scritta, il payload della RPC idempotente,
// gli argomenti dell'avviso e tutte le righe di log. Se uno solo la contiene, il nome di
// un bambino è uscito dalla porta sbagliata.
// =============================================================================

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  sede: vi.fn(),
  rpc: vi.fn(),
  insert: vi.fn(),
  notify: vi.fn(),
  genitoriAlunni: vi.fn(),
  genitoriClassi: vi.fn(),
  genitoriScuola: vi.fn(),
  eventi: [] as unknown[][],
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.auth, requireStaff: h.auth }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: h.sede,
  resolveScuoleAttive: vi.fn(),
  scuoleDiUtente: vi.fn(),
}))
vi.mock('@/lib/gallery/tag-scope', () => ({ assertTagStudentsInScope: vi.fn(async () => null) }))
vi.mock('@/lib/gallery/privacy', () => ({ alunniSenzaConsenso: vi.fn(async () => []) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notify }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiAlunni: h.genitoriAlunni,
  genitoriDiClassi: h.genitoriClassi,
  genitoriDiScuola: h.genitoriScuola,
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...argomenti: unknown[]) => { h.eventi.push(argomenti) },
  logErrore: (...argomenti: unknown[]) => { h.eventi.push(argomenti) },
  logOk: (...argomenti: unknown[]) => { h.eventi.push(argomenti) },
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: h.rpc,
    from: () => ({ insert: h.insert }),
  }),
}))

import { POST } from '@/app/api/gallery/route'
import { pubblicaFotoIdempotente } from '@/lib/gallery/pubblicazione-foto'

const OWNER = '11111111-1111-4111-8111-111111111111'
const SEDE = '22222222-2222-4222-8222-222222222222'
const UPLOAD = '33333333-3333-4333-8333-333333333333'
const ALUNNO = '44444444-4444-4444-8444-444444444444'
const FAMIGLIA_1 = '55555555-5555-4555-8555-555555555555'
const FAMIGLIA_2 = '66666666-6666-4666-8666-666666666666'
/** Un nome di file com'è davvero: contiene il nome di un bambino. */
const NOME_FILE = 'Marco-al-parco-IMG_4821.jpg'

const post = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/gallery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** La richiesta di un client vecchio: manda ancora il nome del file come didascalia. */
const corpo = (extra: Record<string, unknown> = {}) => ({
  file_url: `uploads/${OWNER}/foto.jpg`,
  file_type: 'foto',
  scuola_id: SEDE,
  caption: NOME_FILE,
  tag_students: [ALUNNO],
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.eventi = []
  h.auth.mockResolvedValue({ user: { id: OWNER, role: 'educator', scuola_id: SEDE } })
  h.sede.mockResolvedValue({ scuolaId: SEDE })
  h.genitoriAlunni.mockResolvedValue([FAMIGLIA_1, FAMIGLIA_2])
  h.genitoriClassi.mockResolvedValue([FAMIGLIA_1])
  h.genitoriScuola.mockResolvedValue([FAMIGLIA_1, FAMIGLIA_2])
  h.notify.mockResolvedValue(undefined)
  h.insert.mockImplementation((riga: Record<string, unknown>) => ({
    select: () => ({ single: async () => ({ data: { id: 'media-1', ...riga }, error: null }) }),
  }))
  h.rpc.mockResolvedValue({ data: { ok: true, created: true, media: { id: UPLOAD } }, error: null })
})

describe('la didascalia del client si ignora: la riga nasce con `caption` NULL', () => {
  it('percorso storico (senza `upload_id`): il record scritto ha `caption: null`', async () => {
    const res = await POST(post(corpo()))
    expect(res.status).toBe(201)
    expect(h.insert).toHaveBeenCalledOnce()
    const scritto = h.insert.mock.calls[0][0] as Record<string, unknown>
    expect(scritto.caption).toBeNull()
    expect(JSON.stringify(scritto)).not.toContain(NOME_FILE)
    // E il resto della riga è quello di sempre: la didascalia era l'unica cosa da togliere.
    expect(scritto).toMatchObject({
      uploaded_by: OWNER,
      scuola_id: SEDE,
      file_url: `uploads/${OWNER}/foto.jpg`,
      file_type: 'foto',
      tag_students: [ALUNNO],
      is_broadcast: false,
    })
  })

  it('percorso idempotente (con `upload_id`): il payload della RPC ha `caption: null`', async () => {
    const res = await POST(post(corpo({ upload_id: UPLOAD })))
    expect(res.status).toBe(201)
    expect(h.rpc).toHaveBeenCalledOnce()
    const payload = h.rpc.mock.calls[0][1].p_payload as Record<string, unknown>
    expect(payload.caption).toBeNull()
    expect(JSON.stringify(h.rpc.mock.calls[0][1])).not.toContain(NOME_FILE)
    // L'impronta della RPC copre l'intero payload: dev'essere lo stesso a ogni replay,
    // qualunque didascalia mandi il client.
    h.rpc.mockClear()
    await POST(post(corpo({ upload_id: UPLOAD, caption: 'tutt-altro-nome.jpg' })))
    await POST(post(corpo({ upload_id: UPLOAD, caption: null })))
    await POST(post(corpo({ upload_id: UPLOAD, caption: undefined })))
    const payloadDelleRipetizioni = h.rpc.mock.calls.map((c) => c[1].p_payload)
    expect(payloadDelleRipetizioni).toHaveLength(3)
    for (const p of payloadDelleRipetizioni) expect(p).toEqual(payload)
  })

  it('una didascalia vuota o assente non cambia niente: sempre NULL', async () => {
    for (const caption of ['', null, undefined, '   ']) {
      h.insert.mockClear()
      const res = await POST(post(corpo({ caption })))
      expect(res.status).toBe(201)
      expect((h.insert.mock.calls[0][0] as Record<string, unknown>).caption, JSON.stringify(caption)).toBeNull()
    }
  })

  it('nessuna riga di log, di tutta la richiesta, contiene la didascalia', async () => {
    await POST(post(corpo()))
    await POST(post(corpo({ upload_id: UPLOAD })))
    expect(h.eventi.length, 'nessun log emesso: questo caso non prova niente').toBeGreaterThan(0)
    expect(JSON.stringify(h.eventi)).not.toContain(NOME_FILE)
  })
})

describe('l’avviso ai genitori: testo fisso, mai la didascalia né il nome del file', () => {
  it('titolo «Nuovi contenuti in galleria», corpo senza nomi, e il resto come prima', async () => {
    const res = await POST(post(corpo()))
    expect(res.status).toBe(201)
    expect(h.notify).toHaveBeenCalledOnce()
    expect(h.notify.mock.calls[0][1]).toEqual({
      tipo: 'galleria',
      scuolaId: SEDE,
      utenteIds: [FAMIGLIA_1, FAMIGLIA_2],
      titolo: 'Nuovi contenuti in galleria',
      corpo: 'Ci sono nuovi contenuti nella galleria.',
      link: '/parent/gallery',
      entitaTipo: 'galleria',
      // L'INSEGNANTE, non il media: è la chiave del debounce per insegnante (#131).
      entitaId: OWNER,
      bufferMin: 30,
      debounce: true,
    })
  })

  it('con un client che manda una didascalia, nessun argomento dell’avviso la contiene', async () => {
    await POST(post(corpo()))
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain(NOME_FILE)
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain('Marco')
  })

  it('anche sul percorso idempotente, e senza bambini (classi bersaglio) il testo è lo stesso', async () => {
    await POST(post(corpo({ upload_id: UPLOAD, tag_students: [], target_classes: ['2 ANNI'] })))
    expect(h.genitoriClassi).toHaveBeenCalledWith(expect.anything(), SEDE, ['2 ANNI'])
    const params = h.notify.mock.calls[0][1]
    expect(params.titolo).toBe('Nuovi contenuti in galleria')
    expect(params.corpo).toBe('Ci sono nuovi contenuti nella galleria.')
    expect(params.utenteIds).toEqual([FAMIGLIA_1])
  })

  it('un replay (`created: false`) non rinotifica: l’avviso è del solo vincitore', async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, created: false, media: { id: UPLOAD } }, error: null })
    const res = await POST(post(corpo({ upload_id: UPLOAD })))
    expect(res.status).toBe(200)
    expect(h.notify).not.toHaveBeenCalled()
  })
})

describe('`pubblicaFotoIdempotente` non porta mai una didascalia alla RPC', () => {
  it('nemmeno se il record che riceve ne ha una: il payload dice `caption: null`', async () => {
    // La route le passa già un record con `caption: null`, ma la garanzia non deve dipendere
    // da chi la chiama: il payload è coperto dall'impronta della RPC, e un valore che cambia
    // fra due repliche è un `UPLOAD_CONFLICT`.
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, created: true, media: { id: UPLOAD } }, error: null })
    const esito = await pubblicaFotoIdempotente(
      { rpc } as never,
      OWNER,
      SEDE,
      UPLOAD,
      {
        file_url: `uploads/${OWNER}/foto.jpg`,
        caption: NOME_FILE,
        tag_students: [ALUNNO],
        is_broadcast: false,
        target_classes: null,
      },
    )
    expect(esito.response).toBeUndefined()
    expect(rpc).toHaveBeenCalledOnce()
    const payload = rpc.mock.calls[0][1].p_payload
    expect(payload.caption).toBeNull()
    expect(JSON.stringify(rpc.mock.calls[0][1])).not.toContain(NOME_FILE)
    expect(payload).toMatchObject({ file_url: `uploads/${OWNER}/foto.jpg`, file_type: 'foto', tag_students: [ALUNNO] })
  })
})
