import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc, type Scrittura } from '../fixtures/finto-supabase'

/**
 * PR 4.4 · La chat passa da `thread_visibili`: un thread che la funzione non dà non si vede e non si legge, uno con `scrivibile`
 * falso si legge e non si scrive (403 `CHAT_SOLA_LETTURA`), per le due parti. La rubrica e il gate che apre un thread guardano la
 * sezione della frequenza, non `alunni.section_id`. Schema indietro: quello che si fa oggi. Un guasto non apre. Solo uuid finti.
 */

const DOC = '99999999-9999-4999-8999-999999999991'
const DOC_VECCHIO = '99999999-9999-4999-8999-999999999992'
const GEN = '99999999-9999-4999-8999-999999999993'
const FIGLIO = '11111111-1111-4111-8111-111111111111'
const FIGLIO_NON_ATTIVO = '11111111-1111-4111-8111-111111111112'
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_ALTRA = '22222222-2222-4222-8222-222222222223'
const SEZ_NUOVA = '55555555-5555-4555-8555-555555555551'
const SEZ_VECCHIA = '55555555-5555-4555-8555-555555555552'
const SEZ_ALTRA_SEDE = '55555555-5555-4555-8555-555555555553'
const FREQ = '66666666-6666-4666-8666-666666666661'
const T_VIVO = 'dddddddd-0000-4000-8000-000000000001'
const T_NASCOSTO = 'dddddddd-0000-4000-8000-000000000002'

type Rpc = (args: Riga) => RispostaRpc

const INDIETRO: RispostaRpc = { data: null, error: { code: 'PGRST202', message: 'assente' } }
const GUASTO: RispostaRpc = { data: null, error: { code: '57014', message: 'timeout' } }

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  lette: [] as string[],
  scritture: [] as unknown[],
  threadVisibili: null as unknown,
  figliAttivi: null as unknown,
  riepilogo: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: async () => null }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ controparteThread: vi.fn(async () => null) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(), nomeUtente: vi.fn(async () => 'x') }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => {
  const finto = () => creaFintoSupabase(h.db as DBFinto, h.lette, {
    scritture: h.scritture as Scrittura[],
    rpc: {
      thread_visibili: (args: Riga) => (h.threadVisibili as Rpc)(args),
      figli_attivi: (args: Riga) => (h.figliAttivi as Rpc)(args),
      chat_riepilogo_conversazioni: (args: Riga) => (h.riepilogo as Rpc)(args),
    },
  })
  return { createAdminClient: async () => finto(), createClient: async () => finto() }
})

import { GET as LISTA, POST as APRI } from '@/app/api/chat/threads/route'
import { GET as LEGGI, POST as SCRIVI } from '@/app/api/chat/messages/route'
import { GET as RUBRICA } from '@/app/api/chat/contacts/route'

const url = 'http://test/api/chat'
const reqGet = (q = '') => new Request(`${url}${q}`) as never
const reqPost = (body: unknown) => new Request(url, { method: 'POST', body: JSON.stringify(body) }) as never
const genitore = { user: { id: GEN, role: 'genitore', ruoli: ['genitore'] } }
const docente = { user: { id: DOC, role: 'educator', ruoli: ['educator'] } }

const scrivibile = (thread: string, valore: boolean) => ({ thread_id: thread, scrivibile: valore })
const frequenza = (alunno: string, sezione: string | null, sede = SEDE) => ({
  alunno_id: alunno, frequenza_id: FREQ, section_id: sezione, scuola_id: sede,
})
const inserti = () => (h.scritture as Scrittura[]).filter((s) => s.tabella === 'chat_messages' && s.operazione === 'insert')
const negati = () => h.logEvento.mock.calls.filter((c) => (c[2] as { operazione?: string }).operazione === 'anno/visibilita:negato')

beforeEach(() => {
  vi.clearAllMocks()
  h.lette.length = 0
  h.scritture.length = 0
  h.db = {
    chat_threads: [
      { id: T_VIVO, teacher_id: DOC, parent_id: GEN, student_id: FIGLIO, last_message_at: '2026-11-02T10:00:00Z' },
      { id: T_NASCOSTO, teacher_id: DOC_VECCHIO, parent_id: GEN, student_id: FIGLIO_NON_ATTIVO, last_message_at: '2026-11-01T10:00:00Z' },
    ],
    chat_messages: [
      { id: 'eeeeeeee-0000-4000-8000-000000000001', thread_id: T_VIVO, sender_id: DOC, content: 'a', created_at: '2026-11-02T10:00:00Z', read_at: null },
      { id: 'eeeeeeee-0000-4000-8000-000000000002', thread_id: T_NASCOSTO, sender_id: DOC_VECCHIO, content: 'b', created_at: '2026-11-01T10:00:00Z', read_at: null },
    ],
    conversazioni_sospensioni: [],
    parents: [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', auth_user_id: GEN, consensi_gdpr: { privacy: true, termini: true } }],
    student_parents: [],
    legame_genitori_alunni: [
      { genitore_id: GEN, alunno_id: FIGLIO },
      { genitore_id: GEN, alunno_id: FIGLIO_NON_ATTIVO },
    ],
    alunni: [
      // `section_id` è rimasta quella dell'anno prima: decide la frequenza.
      { id: FIGLIO, nome: 'n', cognome: 'c', classe_sezione: 'Girasoli', section_id: SEZ_VECCHIA, scuola_id: SEDE, stato: 'iscritto' },
      { id: FIGLIO_NON_ATTIVO, nome: 'n', cognome: 'c', classe_sezione: 'Girasoli', section_id: SEZ_VECCHIA, scuola_id: SEDE, stato: 'iscritto' },
    ],
    utenti: [
      { id: DOC, ruolo: 'educator', attivo: true, scuola_id: SEDE, nome: 'n', cognome: 'c' },
      { id: DOC_VECCHIO, ruolo: 'educator', attivo: true, scuola_id: SEDE, nome: 'n', cognome: 'c' },
      { id: GEN, ruolo: 'genitore', attivo: true, scuola_id: SEDE, nome: 'n', cognome: 'c' },
    ],
    utenti_sezioni: [
      { utente_id: DOC, section_id: SEZ_NUOVA },
      { utente_id: DOC_VECCHIO, section_id: SEZ_VECCHIA },
    ],
    utenti_scuole: [],
    sections: [],
  }
  h.requireUser.mockResolvedValue(genitore)
  h.threadVisibili = (() => ({ data: [scrivibile(T_VIVO, true)], error: null })) as Rpc
  h.figliAttivi = (() => ({ data: [frequenza(FIGLIO, SEZ_NUOVA)], error: null })) as Rpc
  h.riepilogo = (() => ({
    data: [{ id: T_VIVO, student_id: FIGLIO }, { id: T_NASCOSTO, student_id: FIGLIO_NON_ATTIVO }],
    error: null,
  })) as Rpc
})

describe('GET /api/chat/threads', () => {
  const lista = async () => {
    const res = await LISTA(reqGet())
    expect(res.status).toBe(200)
    return await res.json() as Array<{ id: string; scrivibile: boolean }>
  }

  it('dal riepilogo: ciò che la funzione non dà non c’è, e `scrivibile` è il suo', async () => {
    h.threadVisibili = (() => ({ data: [scrivibile(T_VIVO, false)], error: null })) as Rpc

    expect((await lista()).map((t) => [t.id, t.scrivibile])).toEqual([[T_VIVO, false]])
  })

  it('dal ripiego del riepilogo: la stessa regola, e le letture per thread saltano il nascosto', async () => {
    h.riepilogo = (() => INDIETRO) as Rpc
    h.threadVisibili = (() => ({ data: [scrivibile(T_VIVO, true)], error: null })) as Rpc

    expect((await lista()).map((t) => [t.id, t.scrivibile])).toEqual([[T_VIVO, true]])
  })

  it('un genitore con zero figli attivi: lista vuota, non un errore', async () => {
    h.threadVisibili = (() => ({ data: [], error: null })) as Rpc

    expect(await lista()).toEqual([])
  })

  it('il docente: la funzione lo chiama con la sua identità, mai quella del client', async () => {
    const chiamate: unknown[] = []
    h.requireUser.mockResolvedValue(docente)
    h.threadVisibili = ((args: Riga) => {
      chiamate.push(args.p_utente)
      return { data: [scrivibile(T_VIVO, true)], error: null }
    }) as Rpc

    await LISTA(reqGet(`?userId=${GEN}`))

    expect(chiamate).toEqual([DOC])
  })

  it('un guasto della funzione non apre: 500, e nessun thread nel corpo', async () => {
    h.threadVisibili = (() => GUASTO) as Rpc

    const res = await LISTA(reqGet())

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
  })

  it('schema indietro: la lista di oggi, tutta scrivibile', async () => {
    h.threadVisibili = (() => INDIETRO) as Rpc

    const r = await lista()

    expect(r.map((t) => t.id)).toEqual([T_VIVO, T_NASCOSTO])
    expect(r.every((t) => t.scrivibile === true)).toBe(true)
  })
})

describe('GET /api/chat/messages', () => {
  const leggi = (thread: string) => LEGGI(reqGet(`?threadId=${thread}`))

  it('un thread che la funzione non dà non si legge: 403, con la riga di rifiuto', async () => {
    const res = await leggi(T_NASCOSTO)

    expect(res.status).toBe(403)
    expect(h.lette).not.toContain('chat_messages')
    expect(negati()).toHaveLength(1)
  })

  it('la sola lettura si legge', async () => {
    h.threadVisibili = (() => ({ data: [scrivibile(T_VIVO, false)], error: null })) as Rpc

    const res = await leggi(T_VIVO)

    expect(res.status).toBe(200)
    expect(h.lette).toContain('chat_messages')
  })

  it('un guasto non apre: 500, e i messaggi non si leggono', async () => {
    h.threadVisibili = (() => GUASTO) as Rpc

    const res = await leggi(T_VIVO)

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(h.lette).not.toContain('chat_messages')
  })

  it('schema indietro: si legge come oggi', async () => {
    h.threadVisibili = (() => INDIETRO) as Rpc

    expect((await leggi(T_NASCOSTO)).status).toBe(200)
  })

  it('chi non partecipa resta fuori senza chiedere alla funzione', async () => {
    const chiamata = vi.fn(() => ({ data: [], error: null }))
    h.threadVisibili = chiamata as unknown as Rpc
    h.requireUser.mockResolvedValue({ user: { id: 'ffffffff-0000-4000-8000-000000000001', role: 'genitore', ruoli: ['genitore'] } })

    expect((await leggi(T_VIVO)).status).toBe(403)
    expect(chiamata).not.toHaveBeenCalled()
  })
})

describe('POST /api/chat/messages', () => {
  const scrivi = (thread: string) => SCRIVI(reqPost({ thread_id: thread, content: 'ciao' }))

  it('sola lettura: 403 `CHAT_SOLA_LETTURA`, niente scritto, e nel log solo uuid', async () => {
    h.threadVisibili = (() => ({ data: [scrivibile(T_VIVO, false)], error: null })) as Rpc

    const res = await scrivi(T_VIVO)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'CHAT_SOLA_LETTURA', motivo: 'chat_sola_lettura' })
    expect(inserti()).toEqual([])
    const [riga] = negati()
    expect(riga[1]).toBe('warn')
    expect(riga[2]).toMatchObject({ tipo: 'chat-sola-lettura', thread: T_VIVO, uid: GEN })
    expect(JSON.stringify(riga[2])).not.toContain('ciao')
  })

  it('vale anche per il docente: la colonna è una sola', async () => {
    h.requireUser.mockResolvedValue(docente)
    h.threadVisibili = (() => ({ data: [scrivibile(T_VIVO, false)], error: null })) as Rpc

    expect((await scrivi(T_VIVO)).status).toBe(403)
    expect(inserti()).toEqual([])
  })

  it('il thread di un figlio non attivo: stesso 403, non un «thread non trovato»', async () => {
    const res = await scrivi(T_NASCOSTO)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'CHAT_SOLA_LETTURA' })
    expect(inserti()).toEqual([])
  })

  it('scrivibile: il messaggio parte', async () => {
    const res = await scrivi(T_VIVO)

    expect(res.status).toBe(201)
    expect(inserti()).toHaveLength(1)
  })

  it('un guasto non apre: 500, e niente scritto', async () => {
    h.threadVisibili = (() => GUASTO) as Rpc

    const res = await scrivi(T_VIVO)

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(inserti()).toEqual([])
  })

  it('schema indietro: il messaggio parte come oggi', async () => {
    h.threadVisibili = (() => INDIETRO) as Rpc

    expect((await scrivi(T_NASCOSTO)).status).toBe(201)
    expect(inserti()).toHaveLength(1)
  })
})

describe('GET /api/chat/contacts, famiglia', () => {
  const rubrica = async () => {
    const res = await RUBRICA(reqGet())
    expect(res.status).toBe(200)
    return await res.json() as {
      contacts: Array<{ user_id: string; student_id: string; scuola_id: string }>
      motivo: string | null
    }
  }

  beforeEach(() => {
    h.db.chat_threads = []
  })

  it('solo le insegnanti della sezione della frequenza, non di quella rimasta in anagrafica', async () => {
    const r = await rubrica()

    expect(r.contacts.map((c) => [c.user_id, c.student_id])).toEqual([[DOC, FIGLIO]])
  })

  it('un figlio non attivo non porta nessuno: non si apre una chat su di lui', async () => {
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    const r = await rubrica()

    expect(r.contacts).toEqual([])
    expect(r.motivo).toBe('nessun-figlio')
  })

  it('un bambino vivo in due sedi: le insegnanti di tutte e due, ognuna con la sua sede', async () => {
    h.db.utenti_sezioni.push({ utente_id: DOC_VECCHIO, section_id: SEZ_ALTRA_SEDE })
    h.figliAttivi = (() => ({
      data: [frequenza(FIGLIO, SEZ_NUOVA), frequenza(FIGLIO, SEZ_ALTRA_SEDE, SEDE_ALTRA)],
      error: null,
    })) as Rpc

    const r = await rubrica()

    expect(r.contacts.map((c) => [c.user_id, c.scuola_id]).sort()).toEqual([[DOC, SEDE], [DOC_VECCHIO, SEDE_ALTRA]].sort())
  })

  it('figlio attivo senza sezione: lo dice, e non ripiega su quella in anagrafica', async () => {
    h.figliAttivi = (() => ({ data: [frequenza(FIGLIO, null)], error: null })) as Rpc

    const r = await rubrica()

    expect(r.contacts).toEqual([])
    expect(r.motivo).toBe('figli-senza-sezione')
  })

  it('un guasto non apre: 500 come ogni lettura della rubrica', async () => {
    h.figliAttivi = (() => GUASTO) as Rpc

    const res = await RUBRICA(reqGet())

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'RUBRICA_NON_DISPONIBILE' })
    expect(h.lette).not.toContain('utenti_sezioni')
  })

  it('schema indietro: la sezione in anagrafica, come oggi', async () => {
    h.figliAttivi = (() => INDIETRO) as Rpc

    const r = await rubrica()

    // I due figli, entrambi nella sezione in anagrafica.
    expect(r.contacts.map((c) => [c.user_id, c.student_id])).toEqual([[DOC_VECCHIO, FIGLIO], [DOC_VECCHIO, FIGLIO_NON_ATTIVO]])
  })
})

describe('POST /api/chat/threads', () => {
  const apri = (docenteDelThread: string, alunno = FIGLIO) =>
    APRI(reqPost({ teacher_id: docenteDelThread, parent_id: GEN, student_id: alunno }))

  beforeEach(() => {
    h.db.chat_threads = []
  })

  it('con la insegnante della sezione della frequenza si apre', async () => {
    expect((await apri(DOC)).status).toBe(201)
  })

  it('con la insegnante della sezione rimasta in anagrafica no: la vetrina e la porta dicono lo stesso', async () => {
    const res = await apri(DOC_VECCHIO)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'CHAT_ABBINAMENTO_NON_CONSENTITO' })
  })

  it('su un figlio non attivo no', async () => {
    h.db.utenti_sezioni.push({ utente_id: DOC, section_id: SEZ_VECCHIA })

    const res = await apri(DOC, FIGLIO_NON_ATTIVO)

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'CHAT_ABBINAMENTO_NON_CONSENTITO' })
  })

  it('con la segreteria, che non guarda la sezione: sul figlio attivo sì, su quello non attivo no', async () => {
    const SEGRETERIA = '99999999-9999-4999-8999-999999999994'
    h.db.utenti.push({ id: SEGRETERIA, ruolo: 'segreteria', attivo: true, scuola_id: SEDE, nome: 'n', cognome: 'c' })
    h.db.utenti_scuole.push({ utente_id: SEGRETERIA, scuola_id: SEDE })

    expect((await apri(SEGRETERIA)).status).toBe(201)
    expect((await apri(SEGRETERIA, FIGLIO_NON_ATTIVO)).status).toBe(403)
  })

  it('un guasto non apre: 500 `non-deciso`, mai un rifiuto alla famiglia e mai un thread', async () => {
    h.figliAttivi = (() => GUASTO) as Rpc

    const res = await apri(DOC)

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'CHAT_ABBINAMENTO_NON_VERIFICATO' })
    expect((h.scritture as Scrittura[]).filter((s) => s.tabella === 'chat_threads')).toEqual([])
  })

  it('schema indietro: la sezione in anagrafica, come oggi', async () => {
    h.figliAttivi = (() => INDIETRO) as Rpc

    expect((await apri(DOC_VECCHIO)).status).toBe(201)
  })
})
