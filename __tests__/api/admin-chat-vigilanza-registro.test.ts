import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// ════════════════════════════════════════════════════════════════════════════
// LA SPIATA LASCIA TRACCIA — `admin/chat/messages:GET` e il registro
// ════════════════════════════════════════════════════════════════════════════
//
// Fino al 2026-09-09 questa route apriva il CONTENUTO di una conversazione fra
// un genitore e un'insegnante senza scrivere niente: né riga di audit né log.
// Misurato quel giorno: 409 conversazioni, 1.631 messaggi, di cui 1.577 nei 30
// giorni precedenti, leggibili da chiunque avesse ruolo `segreteria` senza che
// ne restasse traccia.
//
// La vigilanza resta SILENZIOSA per decisione del titolare (i due interlocutori
// non vedono nulla): la riga di registro è l'UNICO contrappeso. Perciò qui si
// collauda anche il caso scomodo — se il registro non si scrive, il contenuto
// NON esce.
//
// Le asserzioni che contano sono sulla SCRITTURA (cosa finisce in tabella) e
// sull'assenza del contenuto nella risposta, non sullo status da solo.

const THREAD = 'dddddddd-0000-4000-8000-000000000004'
const STUDENT = 'eeeeeeee-0000-4000-8000-000000000005'
const OPERATORE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEGRETO = 'MIO-FIGLIO-HA-LA-FEBBRE-NON-DEVE-FINIRE-NEI-LOG'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: h.assertAlunnoInScope }))
// Gli allegati hanno già il loro collaudo (`chat-allegati-firmati.test.ts`): qui
// la firma è un passaggio, non l'oggetto del test.
vi.mock('@/lib/chat/allegati', () => ({
  firmaAllegatiChat: async (_s: unknown, righe: unknown[]) => righe,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { errori: h.errori, scritture: h.scritture }),
  }
})

import { GET } from '@/app/api/admin/chat/messages/route'

const req = () =>
  new NextRequest(`http://localhost/api/admin/chat/messages?thread_id=${THREAD}`, {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'Collaudo/1.0' },
  })

const dbBase = (): DBFinto => ({
  chat_threads: [{ id: THREAD, student_id: STUDENT }],
  alunni: [{ id: STUDENT, scuola_id: SEDE_A }],
  chat_messages: [
    { id: 'm1', thread_id: THREAD, sender_id: 'x', content: SEGRETO, attachment_url: null, attachment_type: null, created_at: '2026-09-08T10:00:00.000Z' },
    { id: 'm2', thread_id: THREAD, sender_id: 'y', content: 'va bene grazie', attachment_url: null, attachment_type: null, created_at: '2026-09-08T10:05:00.000Z' },
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
  h.requireStaff.mockResolvedValue({ user: { id: OPERATORE, role: 'segreteria', scuola_id: SEDE_A } })
  h.assertAlunnoInScope.mockResolvedValue(null)
})

describe('GET /api/admin/chat/messages — il registro di vigilanza', () => {
  it('scrive UNA riga di registro con chi, quale conversazione, quanti messaggi e da dove', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)

    const righe = righeRegistro()
    expect(righe).toHaveLength(1)
    expect(rigaRegistro()).toMatchObject({
      operatore_id: OPERATORE,
      operatore_ruolo: 'segreteria',
      azione: 'lettura',
      esito: 'ok',
      thread_id: THREAD,
      alunno_id: STUDENT,
      scuola_id: SEDE_A,
      n_messaggi: 2,
      ip: '203.0.113.9',
      user_agent: 'Collaudo/1.0',
    })
  })

  it('registra la sede LETTA DALL\'ALUNNO, non quella dell\'account che sta guardando', async () => {
    // L'admin multi-sede guarda una conversazione di un'altra sede accessibile:
    // nel registro deve finire la sede del BAMBINO, altrimenti la riga dice dove
    // stava chi legge invece di cosa ha letto.
    h.requireStaff.mockResolvedValue({ user: { id: OPERATORE, role: 'admin', scuola_id: 'ffffffff-0000-4000-8000-00000000000f' } })
    await GET(req())
    expect(rigaRegistro()).toMatchObject({ scuola_id: SEDE_A })
  })

  it('se il registro NON si scrive, il contenuto non esce: 503 e nessun messaggio', async () => {
    h.errori = { 'chat_vigilanza_accessi:insert': { code: '23502', message: 'null value' } }
    const res = await GET(req())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('VIGILANZA_NON_TRACCIABILE')
    // La prova vera: il testo del messaggio non è nella risposta.
    expect(JSON.stringify(body)).not.toContain(SEGRETO)
  })

  it('sul DB E2E della CI (tabella assente) NON blocca: 200 e conversazione servita', async () => {
    h.errori = { 'chat_vigilanza_accessi:insert': { code: '42P01', message: 'relation does not exist' } }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
  })

  it('registra anche il tentativo su una conversazione di un\'altra sede, con esito «fuori-scope»', async () => {
    h.assertAlunnoInScope.mockResolvedValue(
      NextResponse.json({ error: 'Accesso negato: alunno fuori dal tuo plesso' }, { status: 403 }),
    )
    const res = await GET(req())
    expect(res.status).toBe(403)

    const righe = righeRegistro()
    expect(righe).toHaveLength(1)
    expect(rigaRegistro()).toMatchObject({ azione: 'lettura', esito: 'fuori-scope', thread_id: THREAD })
    // Fuori scope non si legge nulla: i messaggi non devono essere stati toccati.
    expect(h.tabelle).not.toContain('chat_messages')
  })

  it('il gate nega: nessuna tabella letta e nessuna riga di registro', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(h.tabelle).toEqual([])
    expect(righeRegistro()).toHaveLength(0)
  })

  it('thread inesistente: 404, e non si registra una lettura mai avvenuta', async () => {
    h.db.chat_threads = []
    const res = await GET(req())
    expect(res.status).toBe(404)
    expect(righeRegistro()).toHaveLength(0)
  })
})
