import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// ════════════════════════════════════════════════════════════════════════════
// LO SCARICO DALLA SUPERVISIONE RESTA NEL REGISTRO — `admin/chat/messages/scarico:POST`
// ════════════════════════════════════════════════════════════════════════════
//
// La scheda «Tutti» della pagina Messaggi è la supervisione silenziosa: i due
// interlocutori non vedono niente, e `chat_vigilanza_accessi` è l'UNICO
// contrappeso. Portarsi via una foto è più grave che leggerla: la riga `scarico`
// si scrive PRIMA di firmare l'indirizzo, e se non si scrive il file non parte
// (503 `VIGILANZA_NON_TRACCIABILE`).
//
// Le asserzioni che contano sono sull'ORDINE (la riga esiste quando la firma
// viene chiesta), sulla SCRITTURA (cosa finisce in tabella) e sull'ASSENZA
// dell'indirizzo nella risposta quando il registro non c'è — non sullo status da
// solo. Il DB è un finto che APPLICA i filtri e ESEGUE le scritture (come
// `admin-chat-vigilanza-registro.test.ts`), non un mock piatto.

const THREAD = 'dddddddd-0000-4000-8000-000000000004'
const STUDENT = 'eeeeeeee-0000-4000-8000-000000000005'
const OPERATORE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const MSG_FOTO = 'cccccccc-0000-4000-8000-000000000001'
const MSG_DOC = 'cccccccc-0000-4000-8000-000000000002'
const MSG_SENZA_PERCORSO = 'cccccccc-0000-4000-8000-000000000003'
const PERCORSO = `${STUDENT}/abc-foto-segreta.jpg`
const URL_FIRMATO = 'https://abcdefgh.supabase.co/storage/v1/object/sign/chat-allegati/x/fresca.jpg?token=FRESCO'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  firma: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string; message?: string }>,
  /** Le righe che il registro conteneva nell'istante in cui è stata chiesta la firma. */
  registroAllaFirma: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: h.assertAlunnoInScope }))
vi.mock('@/lib/chat/allegati', () => ({
  firmaAllegatiChat: (...a: unknown[]) => h.firma(...a),
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { errori: h.errori, scritture: h.scritture }),
  }
})

import { POST } from '@/app/api/admin/chat/messages/scarico/route'

const req = (body: unknown = { message_id: MSG_FOTO }) =>
  new NextRequest('http://localhost/api/admin/chat/messages/scarico', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.9, 10.0.0.1',
      'user-agent': 'Collaudo/1.0',
    },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  chat_threads: [{ id: THREAD, student_id: STUDENT }],
  alunni: [{ id: STUDENT, scuola_id: SEDE_A }],
  chat_messages: [
    { id: MSG_FOTO, thread_id: THREAD, sender_id: 'x', content: 'ecco la foto', attachment_url: PERCORSO, attachment_type: 'image' },
    { id: MSG_DOC, thread_id: THREAD, sender_id: 'x', content: 'il referto', attachment_url: `${STUDENT}/abc-referto.pdf`, attachment_type: 'document' },
    { id: MSG_SENZA_PERCORSO, thread_id: THREAD, sender_id: 'x', content: 'foto sparita', attachment_url: null, attachment_type: 'image' },
  ],
  chat_vigilanza_accessi: [],
})

const righeRegistro = () => h.scritture.filter((s) => s.tabella === 'chat_vigilanza_accessi')
/** `Scrittura.valori` è l'array passato a `.insert()`: qui è sempre una riga sola. */
const rigaRegistro = (i = 0) => {
  const v = righeRegistro()[i].valori as Record<string, unknown> | Record<string, unknown>[]
  return (Array.isArray(v) ? v[0] : v) as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.registroAllaFirma = []
  h.requireStaff.mockResolvedValue({ user: { id: OPERATORE, role: 'segreteria', scuola_id: SEDE_A } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.firma.mockImplementation(async (_s: unknown, righe: Array<{ id: string; attachment_url: string | null }>) => {
    // Cosa risultava già scritto nel registro quando la route ha chiesto di firmare.
    h.registroAllaFirma = righeRegistro().map((s) => s.valori)
    return righe.map((r) => ({ ...r, attachment_url: URL_FIRMATO }))
  })
})

describe('POST /api/admin/chat/messages/scarico — il registro prima del file', () => {
  it('registra la riga scarico PRIMA di firmare: quando la firma parte la riga c\'è già', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)

    // L'ORDINE: alla chiamata di firma il registro conteneva già la riga `scarico`.
    expect(h.firma).toHaveBeenCalledTimes(1)
    expect(h.registroAllaFirma).toHaveLength(1)
    const allaFirma = h.registroAllaFirma[0] as Record<string, unknown> | Record<string, unknown>[]
    expect((Array.isArray(allaFirma) ? allaFirma[0] : allaFirma).azione).toBe('scarico')

    // E la riga dice chi, cosa, dove e da dove.
    expect(righeRegistro()).toHaveLength(1)
    expect(rigaRegistro()).toMatchObject({
      operatore_id: OPERATORE,
      operatore_ruolo: 'segreteria',
      azione: 'scarico',
      esito: 'ok',
      thread_id: THREAD,
      alunno_id: STUDENT,
      scuola_id: SEDE_A,
      n_messaggi: 1,
      ip: '203.0.113.9',
      user_agent: 'Collaudo/1.0',
    })
  })

  it('firma solo il messaggio chiesto, col suo percorso in tabella, e con l\'etichetta della route', async () => {
    await POST(req())
    const [, righe, operazione] = h.firma.mock.calls[0] as [unknown, Array<{ id: string; attachment_url: string }>, string]
    expect(righe).toEqual([{ id: MSG_FOTO, attachment_url: PERCORSO }])
    expect(operazione).toBe('admin/chat/messages/scarico:POST')
  })

  it('la guardia di sede riceve l\'ALUNNO del thread del messaggio, nella stessa forma della GET: (client, operatore, alunno)', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)

    // È il confine di isolamento fra sedi: `message_id` viene dalla richiesta, e se la guardia
    // ricevesse un altro uuid (il thread, il messaggio, l'operatore) il test dei 403 resterebbe
    // verde col mock che risponde come vuole. Qui si pinna COSA le viene passato.
    expect(h.assertAlunnoInScope).toHaveBeenCalledTimes(1)
    expect(h.assertAlunnoInScope).toHaveBeenCalledWith(
      expect.anything(),
      { id: OPERATORE, role: 'segreteria', scuola_id: SEDE_A },
      STUDENT,
    )

    // Il terzo argomento è l'alunno e nient'altro: gli uuid del thread, del messaggio e
    // dell'operatore sono tutti diversi da lui, quindi lo scambio non passerebbe inosservato.
    const alunnoPassato = h.assertAlunnoInScope.mock.calls[0][2]
    expect([THREAD, MSG_FOTO, OPERATORE]).not.toContain(alunnoPassato)
    expect(alunnoPassato).toBe(h.db.chat_threads[0].student_id)
  })

  it('registro non scrivibile: 503 VIGILANZA_NON_TRACCIABILE e nessuna firma', async () => {
    h.errori = { 'chat_vigilanza_accessi:insert': { code: '23502', message: 'null value' } }
    const res = await POST(req())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('VIGILANZA_NON_TRACCIABILE')
    // La prova vera: la firma non è stata nemmeno chiesta, e nella risposta non c'è nessun indirizzo.
    expect(h.firma).not.toHaveBeenCalled()
    expect(body.url).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('token=')
    expect(JSON.stringify(body)).not.toContain(PERCORSO)
  })

  it('fuori sede: riga fuori-scope e rifiuto, nessuna firma', async () => {
    h.assertAlunnoInScope.mockResolvedValue(
      NextResponse.json({ error: 'Accesso negato: alunno fuori dal tuo plesso' }, { status: 403 }),
    )
    const res = await POST(req())
    expect(res.status).toBe(403)

    expect(righeRegistro()).toHaveLength(1)
    expect(rigaRegistro()).toMatchObject({
      azione: 'scarico',
      esito: 'fuori-scope',
      thread_id: THREAD,
      alunno_id: STUDENT,
      operatore_id: OPERATORE,
    })
    expect(h.firma).not.toHaveBeenCalled()
    // Nessun indirizzo, nessun percorso nella risposta del guard.
    expect(JSON.stringify(await res.json())).not.toContain('token=')
  })

  it('un documento: 400 ALLEGATO_NON_FOTO, nessuna riga e nessuna firma', async () => {
    const res = await POST(req({ message_id: MSG_DOC }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ALLEGATO_NON_FOTO')
    expect(righeRegistro()).toHaveLength(0)
    expect(h.firma).not.toHaveBeenCalled()
    // Un documento non apre nemmeno il thread: il rifiuto viene prima di ogni altra lettura.
    expect(h.tabelle).not.toContain('chat_threads')
  })

  it('un messaggio di tipo image ma senza percorso: 400 ALLEGATO_NON_FOTO, nessuna riga', async () => {
    const res = await POST(req({ message_id: MSG_SENZA_PERCORSO }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ALLEGATO_NON_FOTO')
    expect(righeRegistro()).toHaveLength(0)
    expect(h.firma).not.toHaveBeenCalled()
  })

  it('senza staff: rifiutata dal gate, nessuna tabella letta e nessuna riga', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    const res = await POST(req())
    expect(res.status).toBe(403)
    expect(h.tabelle).toEqual([])
    expect(righeRegistro()).toHaveLength(0)
    expect(h.firma).not.toHaveBeenCalled()
  })

  it('risponde con l\'URL firmato e non col percorso del bucket', async () => {
    const res = await POST(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, url: URL_FIRMATO })
    // Controllo positivo accanto al negativo: l'URL c'è ED è quello firmato, il percorso grezzo non esce.
    expect(JSON.stringify(body)).not.toContain(PERCORSO)
    expect(JSON.stringify(body)).not.toContain('abc-foto-segreta')
  })
})

describe('POST /api/admin/chat/messages/scarico — gli altri rami', () => {
  it('firma che non riesce (URL null): 503 FIRMA_NON_RIUSCITA, la riga resta e nessun indirizzo esce', async () => {
    h.firma.mockImplementation(async (_s: unknown, righe: Array<{ id: string }>) => righe.map((r) => ({ ...r, attachment_url: null })))
    const res = await POST(req())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('FIRMA_NON_RIUSCITA')
    expect(body.url).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(PERCORSO)
    // La riga era già stata scritta (prima della firma, per spec): lo scarico richiesto è tracciato.
    expect(righeRegistro()).toHaveLength(1)
    expect(rigaRegistro()).toMatchObject({ azione: 'scarico', esito: 'ok' })
  })

  it('messaggio inesistente: 404 con codice, nessuna riga e nessuna firma', async () => {
    const res = await POST(req({ message_id: 'cccccccc-0000-4000-8000-0000000000ff' }))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('CHAT_MESSAGGIO_NON_TROVATO')
    expect(righeRegistro()).toHaveLength(0)
    expect(h.firma).not.toHaveBeenCalled()
  })

  it('conversazione inesistente: 404 con codice, nessuna riga e nessuna firma', async () => {
    h.db.chat_threads = []
    const res = await POST(req())
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('CHAT_CONVERSAZIONE_NON_TROVATA')
    expect(righeRegistro()).toHaveLength(0)
    expect(h.firma).not.toHaveBeenCalled()
  })

  it('guasto nella lettura del messaggio: 500 LETTURA_FALLITA, non un finto «non trovato»', async () => {
    h.errori = { 'chat_messages:select': { code: '57014', message: 'statement timeout' } }
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(righeRegistro()).toHaveLength(0)
    expect(h.firma).not.toHaveBeenCalled()
  })

  it('guasto nella lettura del thread: 500 LETTURA_FALLITA, nessuna riga', async () => {
    h.errori = { 'chat_threads:select': { code: '57014', message: 'statement timeout' } }
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(righeRegistro()).toHaveLength(0)
    expect(h.firma).not.toHaveBeenCalled()
  })

  it('guasto nella lettura della sede dell\'alunno: 500 LETTURA_FALLITA, niente riga con «sede sconosciuta», niente firma', async () => {
    h.errori = { 'alunni:select': { code: '57014', message: 'statement timeout' } }
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(righeRegistro()).toHaveLength(0)
    expect(h.firma).not.toHaveBeenCalled()
  })

  it('sul DB E2E della CI (tabella del registro assente) non blocca: 200 e URL firmato', async () => {
    h.errori = { 'chat_vigilanza_accessi:insert': { code: '42P01', message: 'relation does not exist' } }
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBe(URL_FIRMATO)
  })

  it('un body che non è un uuid: 400 dalla validazione, nessuna tabella letta', async () => {
    const res = await POST(req({ message_id: 'non-un-uuid' }))
    expect(res.status).toBe(400)
    expect(h.tabelle).toEqual([])
    expect(righeRegistro()).toHaveLength(0)
    expect(h.firma).not.toHaveBeenCalled()
  })

  it('un body senza message_id: 400 dalla validazione', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect(righeRegistro()).toHaveLength(0)
  })
})

describe('POST /api/admin/chat/messages/scarico — il log', () => {
  it('lo scarico riuscito lascia UNA riga di successo con solo uuid: mai URL, percorso o nome del file', async () => {
    await POST(req())
    const ok = h.logEvento.mock.calls.filter(
      (c) => c[0] === 'chat' && c[1] === 'info' && (c[2] as Record<string, unknown>).esito === 'scarico-registrato',
    )
    expect(ok).toHaveLength(1)
    expect(ok[0][2]).toMatchObject({
      operazione: 'admin/chat/messages/scarico:POST',
      esito: 'scarico-registrato',
      thread_id: THREAD,
      operatore_id: OPERATORE,
    })
    const tutto = JSON.stringify(h.logEvento.mock.calls)
    expect(tutto).not.toContain('token=')
    expect(tutto).not.toContain(PERCORSO)
    expect(tutto).not.toContain('abc-foto-segreta')
    expect(tutto).not.toContain('supabase.co')
  })

  it('se lo scarico non si registra NON si logga il successo', async () => {
    h.errori = { 'chat_vigilanza_accessi:insert': { code: '23502', message: 'null value' } }
    await POST(req())
    const ok = h.logEvento.mock.calls.filter((c) => (c[2] as Record<string, unknown>)?.esito === 'scarico-registrato')
    expect(ok).toHaveLength(0)
  })
})
