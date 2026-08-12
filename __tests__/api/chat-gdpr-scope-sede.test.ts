import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// Isolamento per sede su chat e GDPR — il blocco più esposto dell'audit.
//
//  · admin/chat/contacts  — rubrica: nome e classe di TUTTI i minori delle tre
//    sedi e dei loro genitori, a qualunque segreteria, con la chat già apribile.
//    ⚠️ La correzione del 2026-07-29 aveva toccato il GEMELLO `chat/contacts`
//    (lato docente): questa route non era mai stata guardata.
//  · admin/chat/threads   — supervisione di tutte le conversazioni delle tre sedi.
//  · admin/chat/messages  — CONTENUTO dei messaggi di qualunque thread, per uuid.
//  · chat/threads:POST    — bastava essere partecipante: `student_id` non era
//    verificato, quindi si apriva un thread su un minore di un'altra sede.
//  · admin/gdpr/candidates— nomi di minori non iscritti e genitori, tutte le sedi.
//  · admin/gdpr/erase     — ANONIMIZZAZIONE IRREVERSIBILE di un minore di un
//    altro plesso, autorizzata dal solo ruolo. Non esiste un annulla.
//  · admin/gdpr/richieste — `scuola_id` era letto e mai confrontato con niente.
//
// `chat_threads` NON ha `scuola_id`, e non serve: `student_id` è FK verso
// `alunni`, quindi la sede si deriva dal join.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
/** I due ancora ISCRITTI, uno per sede: senza, la rubrica non ha nessuno da mostrare. */
const ISC_A = 'a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa'
const ISC_B = 'b4b4b4b4-4444-4444-8444-bbbbbbbbbbbb'
const THREAD_A = 'c1c1c1c1-1111-4111-8111-cccccccccccc'
const THREAD_B = 'c2c2c2c2-2222-4222-8222-dddddddddddd'
const RICH_B = 'e2e2e2e2-2222-4222-8222-eeeeeeeeeeee'
const GEN_A = 'f1f1f1f1-1111-4111-8111-ffffffffffff'
const GEN_B = 'f2f2f2f2-2222-4222-8222-999999999999'
// `POST /api/chat/threads` valida gli id con `zUuid`: usare 'seg1'/'ed1' darebbe
// un 400 di validazione PRIMA del gate, e il test proverebbe la cosa sbagliata.
const SEG_A = '11111111-1111-4111-8111-111111111111'
const DOC_A = '22222222-2222-4222-8222-222222222222'
const OMONIMA = '2 ANNI'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  getGenitoriDiAlunni: vi.fn(),
  anonimizzaAlunno: vi.fn(),
  anonimizzaParent: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireUser: h.requireUser,
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: h.genitoreHasFiglio,
  getGenitoriDiAlunni: h.getGenitoriDiAlunni,
  getGenitoriDiAlunno: vi.fn(async () => []),
  getFigliDiGenitore: vi.fn(async () => []),
}))
vi.mock('@/lib/gdpr/esegui', () => ({
  anonimizzaAlunno: h.anonimizzaAlunno,
  anonimizzaParent: h.anonimizzaParent,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture }),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture }),
  }
})

import { GET as CONTACTS } from '@/app/api/admin/chat/contacts/route'
import { GET as THREADS } from '@/app/api/admin/chat/threads/route'
import { GET as MESSAGES } from '@/app/api/admin/chat/messages/route'
import { POST as CREA_THREAD } from '@/app/api/chat/threads/route'
import { GET as CANDIDATES } from '@/app/api/admin/gdpr/candidates/route'
import { POST as ERASE } from '@/app/api/admin/gdpr/erase/route'
import { GET as RICHIESTE, POST as EVADI } from '@/app/api/admin/gdpr/richieste/route'

const req = (url: string) => new NextRequest(`http://localhost${url}`)
const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: OMONIMA },
    { id: 'sec-b', scuola_id: SEDE_B, name: OMONIMA },
  ],
  utenti_scuole: [],
  utenti_sezioni: [],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', classe_sezione: OMONIMA, section_id: 'sec-a', scuola_id: SEDE_A, stato: 'ritirato', anonimizzato_il: null },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', classe_sezione: OMONIMA, section_id: 'sec-b', scuola_id: SEDE_B, stato: 'ritirato', anonimizzato_il: null },
    // I due ISCRITTI, aggiunti il 2026-08-12. Questo file guarda `alunni` da due
    // parti opposte del confine: l'oblio vuole i NON più iscritti, la rubrica
    // della chat vuole i soli iscritti. Con due sole righe `ritirato` la prova
    // dell'isolamento fra sedi si sarebbe retta su una lista vuota — che passa
    // sempre, e non prova niente. Nome e cognome sono gli stessi apposta: le
    // asserzioni di questo file cercano «Alfa» e negano «Beta», ed è quella
    // asimmetria — la SEDE — che devono continuare a misurare.
    { id: ISC_A, nome: 'Alfa', cognome: 'Sede-A', classe_sezione: OMONIMA, section_id: 'sec-a', scuola_id: SEDE_A, stato: 'iscritto', anonimizzato_il: null },
    { id: ISC_B, nome: 'Beta', cognome: 'Sede-B', classe_sezione: OMONIMA, section_id: 'sec-b', scuola_id: SEDE_B, stato: 'iscritto', anonimizzato_il: null },
  ],
  utenti: [
    { id: GEN_A, nome: 'Genitore', cognome: 'DiAlfa', ruolo: 'genitore' },
    { id: GEN_B, nome: 'Genitore', cognome: 'DiBeta', ruolo: 'genitore' },
  ],
  chat_threads: [
    { id: THREAD_A, teacher_id: 'ed1', parent_id: GEN_A, student_id: ALU_A, last_message_at: null, alunni: { scuola_id: SEDE_A } },
    { id: THREAD_B, teacher_id: 'ed2', parent_id: GEN_B, student_id: ALU_B, last_message_at: null, alunni: { scuola_id: SEDE_B } },
  ],
  chat_messages: [
    { id: 'msg-b', thread_id: THREAD_B, sender_id: GEN_B, content: 'SEGRETO-SEDE-B', created_at: '2026-07-30T10:00:00Z' },
  ],
  richieste_cancellazione: [
    { id: RICH_B, parent_id: GEN_B, stato: 'pending', scuola_id: SEDE_B, creata_il: '2026-07-30T10:00:00Z' },
  ],
  student_parents: [],
  parents: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture.length = 0
  h.genitoreHasFiglio.mockResolvedValue(false)
  h.getGenitoriDiAlunni.mockImplementation(async (_c: unknown, ids: string[]) => {
    // Per SEDE, non per singolo id: i due iscritti aggiunti il 2026-08-12 stanno
    // negli stessi plessi dei ritirati, e `id === ALU_A` avrebbe attribuito alla
    // sede A i figli della B.
    const m = new Map<string, string[]>()
    for (const id of ids) m.set(id, id === ALU_A || id === ISC_A ? [GEN_A] : [GEN_B])
    return m
  })
  // Segreteria della sede A: per progetto vede TUTTE le classi del proprio
  // plesso e NESSUNA dell'altro.
  h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('GET /api/admin/chat/contacts — rubrica isolata per sede', () => {
  it('nessun minore e nessun genitore dell\'altra sede', async () => {
    const res = await CONTACTS(req('/api/admin/chat/contacts'))
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('Alfa')
    expect(corpo).not.toContain('Beta')
    expect(corpo).not.toContain('DiBeta')
  })
})

describe('GET /api/admin/chat/threads — supervisione isolata per sede', () => {
  it('solo le conversazioni della propria sede', async () => {
    const res = await THREADS(req('/api/admin/chat/threads'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.map((t: { id: string }) => t.id)).toEqual([THREAD_A])
    expect(JSON.stringify(j)).not.toContain('Beta')
  })
})

describe('GET /api/admin/chat/messages — contenuto isolato per sede', () => {
  it('403 sul thread di un\'altra sede, senza leggere i messaggi', async () => {
    const res = await MESSAGES(req(`/api/admin/chat/messages?thread_id=${THREAD_B}`))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('chat_messages')
  })

  it('200 sul thread della propria sede', async () => {
    const res = await MESSAGES(req(`/api/admin/chat/messages?thread_id=${THREAD_A}`))
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('SEGRETO-SEDE-B')
  })
})

describe('POST /api/chat/threads — non si apre una chat su un minore altrui', () => {
  it('staff: 403 se il bambino è di un\'altra sede', async () => {
    h.requireUser.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await CREA_THREAD(post('/api/chat/threads', { teacher_id: SEG_A, parent_id: GEN_B, student_id: ALU_B }))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('chat_threads')
    expect(h.scritture).toEqual([])
  })

  it('genitore: 403 se il bambino non è suo, anche nella stessa sede', async () => {
    h.requireUser.mockResolvedValue({ user: { id: GEN_A, role: 'genitore', scuola_id: SEDE_A } })
    h.genitoreHasFiglio.mockResolvedValue(false)
    const res = await CREA_THREAD(post('/api/chat/threads', { teacher_id: DOC_A, parent_id: GEN_A, student_id: ALU_A }))
    expect(res.status).toBe(403)
  })

  // Controllo positivo. `not.toBe(403)` era verde su un 500: il finto client non
  // aveva `insert()`, quindi la creazione del thread esplodeva in TypeError e
  // finiva nel catch (audit R130). Qui si asserisce lo stato ESATTO e la
  // SCRITTURA: il thread nasce, e nasce sul bambino giusto.
  it('staff: crea davvero il thread sul bambino della propria sede', async () => {
    h.requireUser.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await CREA_THREAD(post('/api/chat/threads', { teacher_id: SEG_A, parent_id: GEN_A, student_id: ALU_A }))
    expect(res.status).toBe(201)
    expect(h.scritture).toEqual([
      expect.objectContaining({ tabella: 'chat_threads', operazione: 'insert' }),
    ])
    expect(h.scritture[0].valori).toEqual([
      { teacher_id: SEG_A, parent_id: GEN_A, student_id: ALU_A },
    ])
    expect(h.db.chat_threads.map((t) => t.student_id)).toEqual([ALU_A, ALU_B, ALU_A])
  })
})

describe('GET /api/admin/gdpr/candidates — candidati all\'oblio isolati per sede', () => {
  it('nessun minore dell\'altra sede', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'dir1', role: 'coordinator', scuola_id: SEDE_A } })
    const res = await CANDIDATES(req('/api/admin/gdpr/candidates'))
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('Alfa')
    expect(corpo).not.toContain('Beta')
  })
})

describe('POST /api/admin/gdpr/erase — l\'operazione irreversibile', () => {
  it('403 su un minore di un\'altra sede, e NON anonimizza nulla', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'dir1', role: 'coordinator', scuola_id: SEDE_A } })
    const res = await ERASE(post('/api/admin/gdpr/erase', { alunno_id: ALU_B, mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('student_parents')
  })

  it('403 anche in dry-run: il dry-run restituisce nome e cognome del minore', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'dir1', role: 'coordinator', scuola_id: SEDE_A } })
    const res = await ERASE(post('/api/admin/gdpr/erase', { alunno_id: ALU_B, mode: 'dryrun' }))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('Beta')
  })
})

describe('/api/admin/gdpr/richieste — richieste di cancellazione isolate per sede', () => {
  it('GET: nessuna richiesta dell\'altra sede', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'dir1', role: 'coordinator', scuola_id: SEDE_A } })
    const res = await RICHIESTE(req('/api/admin/gdpr/richieste'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST: 403 sulla richiesta di un\'altra sede, senza anonimizzare', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'dir1', role: 'coordinator', scuola_id: SEDE_A } })
    const res = await EVADI(post('/api/admin/gdpr/richieste', { id: RICH_B, mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(403)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
  })
})
