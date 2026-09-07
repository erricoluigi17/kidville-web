import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

/**
 * «Un genitore deve poter contattare solo le proprie insegnanti, così come le
 * insegnanti possono contattare solo i propri genitori: quando clicchi su nuova
 * chat, non devono proprio comparire le altre persone.»
 *
 * ─── COSA NON ERA VERO, misurato in produzione il 2026-09-07 ─────────────────
 *
 *  · **150 genitori su 706** vedevano, fra le «proprie insegnanti», una persona
 *    che insegnante non è: in `utenti_sezioni` ci sono 6 righe di `segreteria` e
 *    1 di `admin`, e la rubrica non guardava il ruolo.
 *  · **32 genitori** vedevano almeno un docente CESSATO.
 *  · **9 genitori** ricadevano in un fallback che restituiva **tutti i 63
 *    docenti di 5 sedi** — Demo ed E2E comprese.
 *  · **12 docenti su 60** vedevano i genitori di UNA sola delle proprie sezioni
 *    (`.limit(1)` **senza `order`**), e il filtro sugli alunni era per NOME di
 *    classe: dove il testo diverge dal `sections.name`, elenco vuoto con un 200.
 *  · `chat/threads:POST` non verificava affatto la controparte: **32 thread fuori
 *    sezione**, in crescita di circa uno al giorno.
 *
 * ─── PERCHÉ QUESTO FILE NON USA IL MOCK DELL'ALTRO ───────────────────────────
 *
 * `chat-contacts-legame-anagrafica.test.ts` monta un finto Supabase in cui `eq`,
 * `in` e `limit` sono la stessa funzione identità e `then` risolve con TUTTE le
 * righe della tabella. Quel mock è verde sia con `.limit(1)` sia senza, sia
 * filtrando per `classe_sezione` sia per `section_id`: **non può accorgersi di
 * questa correzione**. Qui si usa `creaFintoSupabase`, che i filtri li applica
 * davvero — ed è l'unico modo perché le rotture deliberate qui sotto producano
 * un rosso.
 */

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const SEC_A1 = 'c1c1c1c1-0000-4000-8000-00000000001a'
const SEC_A2 = 'c2c2c2c2-0000-4000-8000-00000000002a'
const SEC_B = 'c3c3c3c3-0000-4000-8000-00000000003b'
const ED = 'e1e1e1e1-1111-4111-8111-eeeeeeeeeeee'
const ED_ALTRO = 'e2e2e2e2-2222-4222-8222-eeeeeeeeeeee'
const ED_CESSATA = 'e3e3e3e3-3333-4333-8333-eeeeeeeeeeee'
const SEGRETERIA = '55555555-5555-4555-8555-555555555555'
const GEN_1 = 'f1f1f1f1-1111-4111-8111-ffffffffffff'
const GEN_2 = 'f2f2f2f2-2222-4222-8222-ffffffffffff'
const GEN_B = 'f3f3f3f3-3333-4333-8333-ffffffffffff'
const ALU_1 = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_2 = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
const ALU_B = 'a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa'

/** Il nome-classe DIVERGE dal `sections.name`: è la forma misurata il 2026-09-02. */
const NOME_SEZIONE_A1 = '4 ANNI A'
const TESTO_DIVERGENTE = '4 anni  a'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture }),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture }),
  }
})

import { GET as CONTACTS } from '@/app/api/chat/contacts/route'
import { POST as CREA_THREAD } from '@/app/api/chat/threads/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_A1, scuola_id: SEDE_A, name: NOME_SEZIONE_A1 },
    // ⚠️ OMONIMA, nell'altra sede: è la ragione per cui il filtro per nome non
    // poteva reggere. Con tre plessi «2 ANNI» esiste ad Aversa E a Cesa.
    { id: SEC_B, scuola_id: SEDE_B, name: NOME_SEZIONE_A1 },
    { id: SEC_A2, scuola_id: SEDE_A, name: '3 ANNI B' },
  ],
  utenti_scuole: [],
  // ⚠️ SEC_A2 è PRIMA di proposito: `.limit(1)` senza `order` avrebbe preso
  // questa, e la maestra avrebbe visto i genitori della classe sbagliata.
  utenti_sezioni: [
    { utente_id: ED, section_id: SEC_A2 },
    { utente_id: ED, section_id: SEC_A1 },
    { utente_id: ED_ALTRO, section_id: SEC_B },
    { utente_id: ED_CESSATA, section_id: SEC_A1 },
    // La segreteria assegnata a una sezione: capita, e sono 6 righe in produzione.
    { utente_id: SEGRETERIA, section_id: SEC_A1 },
  ],
  utenti: [
    { id: ED, ruolo: 'educator', attivo: true, scuola_id: SEDE_A, nome: 'Ada', cognome: 'Edu', first_name: null, last_name: null },
    { id: ED_ALTRO, ruolo: 'educator', attivo: true, scuola_id: SEDE_B, nome: 'Ivo', cognome: 'Altrove', first_name: null, last_name: null },
    { id: ED_CESSATA, ruolo: 'educator', attivo: false, scuola_id: SEDE_A, nome: 'Ex', cognome: 'Cessata', first_name: null, last_name: null },
    { id: SEGRETERIA, ruolo: 'segreteria', attivo: true, scuola_id: SEDE_A, nome: 'Sara', cognome: 'Segre', first_name: null, last_name: null },
    { id: GEN_1, ruolo: 'genitore', attivo: true, scuola_id: SEDE_A, nome: 'Uno', cognome: 'Genitore', first_name: null, last_name: null },
    { id: GEN_2, ruolo: 'genitore', attivo: true, scuola_id: SEDE_A, nome: 'Due', cognome: 'Genitore', first_name: null, last_name: null },
    { id: GEN_B, ruolo: 'genitore', attivo: true, scuola_id: SEDE_B, nome: 'Bi', cognome: 'Genitore', first_name: null, last_name: null },
  ],
  alunni: [
    // ⚠️ `classe_sezione` DIVERGENTE dal `sections.name`: con il filtro per nome
    // questa riga non veniva trovata, e la rubrica usciva vuota con un 200.
    { id: ALU_1, nome: 'Uno', cognome: 'Bambino', classe_sezione: TESTO_DIVERGENTE, section_id: SEC_A1, scuola_id: SEDE_A, stato: 'iscritto' },
    { id: ALU_2, nome: 'Due', cognome: 'Bambino', classe_sezione: '3 ANNI B', section_id: SEC_A2, scuola_id: SEDE_A, stato: 'iscritto' },
    { id: ALU_B, nome: 'Bi', cognome: 'Bambino', classe_sezione: NOME_SEZIONE_A1, section_id: SEC_B, scuola_id: SEDE_B, stato: 'iscritto' },
  ],
  legame_genitori_alunni: [
    { genitore_id: GEN_1, alunno_id: ALU_1 },
    { genitore_id: GEN_2, alunno_id: ALU_2 },
    { genitore_id: GEN_B, alunno_id: ALU_B },
  ],
  student_parents: [],
  parents: [],
  chat_threads: [],
})

const get = () => new NextRequest('http://localhost/api/chat/contacts')
const post = (body: unknown) =>
  new NextRequest('http://localhost/api/chat/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture.length = 0
})

const contattiDi = async () => {
  const res = await CONTACTS(get())
  expect(res.status).toBe(200)
  return (await res.json()) as {
    contacts: { user_id: string; student_id: string; user_name: string }[]
    motivo: string | null
  }
}

describe('la rubrica del GENITORE: solo le proprie insegnanti', () => {
  beforeEach(() => h.requireUser.mockResolvedValue({ user: { id: GEN_1, role: 'genitore', scuola_id: SEDE_A } }))

  it('vede la maestra della sezione di suo figlio, e nessun altro', async () => {
    const j = await contattiDi()
    expect(j.contacts.map((c) => c.user_id)).toEqual([ED])
  })

  it('NON vede la maestra di un\'altra sede: erano 63 nomi su 5 plessi', async () => {
    expect((await contattiDi()).contacts.map((c) => c.user_id)).not.toContain(ED_ALTRO)
  })

  it('NON vede la SEGRETERIA assegnata alla sezione: 150 genitori se la vedevano', async () => {
    expect((await contattiDi()).contacts.map((c) => c.user_id)).not.toContain(SEGRETERIA)
  })

  it('NON vede la maestra CESSATA: erano 32 genitori', async () => {
    expect((await contattiDi()).contacts.map((c) => c.user_id)).not.toContain(ED_CESSATA)
  })

  it('il nome del contatto c\'è: una rubrica di uuid non è una rubrica', async () => {
    expect((await contattiDi()).contacts[0].user_name).toBe('Ada Edu')
  })

  it('figlio senza sezione: elenco vuoto, e il motivo lo dice', async () => {
    h.db.alunni = [{ ...(h.db.alunni as Record<string, unknown>[])[0], section_id: null }]
    const j = await contattiDi()
    expect(j.contacts).toEqual([])
    expect(j.motivo).toBe('figli-senza-sezione')
  })

  it('sezione senza insegnanti: elenco vuoto, e il motivo è un ALTRO', async () => {
    // Due vuoti diversi vogliono due frasi diverse: «tuo figlio non ha ancora una
    // classe» e «la classe non ha ancora insegnanti» mandano la famiglia dalla
    // segreteria per due cose diverse. In produzione il secondo caso è
    // `Sezione delle Meraviglie (NIDO)` a Cesa: 20 iscritti, zero educator attivi.
    h.db.utenti_sezioni = []
    const j = await contattiDi()
    expect(j.contacts).toEqual([])
    expect(j.motivo).toBe('sezione-senza-docenti')
  })
})

describe('la rubrica dell\'INSEGNANTE: tutte le sue sezioni, per uuid', () => {
  beforeEach(() => h.requireUser.mockResolvedValue({ user: { id: ED, role: 'educator', scuola_id: SEDE_A } }))

  it('vede le famiglie di ENTRAMBE le sue sezioni: erano 12 docenti su 60 a vederne una', async () => {
    const j = await contattiDi()
    expect(j.contacts.map((c) => c.user_id).sort()).toEqual([GEN_1, GEN_2].sort())
  })

  it('vede il bambino la cui `classe_sezione` DIVERGE dal nome della sezione', async () => {
    // Col filtro per nome questa riga non si trovava: 200 con un elenco vuoto, e
    // nessuna riga di log a dirlo.
    expect((await contattiDi()).contacts.map((c) => c.student_id)).toContain(ALU_1)
  })

  it('NON vede la famiglia della sezione OMONIMA dell\'altra sede', async () => {
    const j = await contattiDi()
    expect(j.contacts.map((c) => c.user_id)).not.toContain(GEN_B)
    expect(j.contacts.map((c) => c.student_id)).not.toContain(ALU_B)
  })

  it('un bambino RITIRATO non porta la sua famiglia in rubrica', async () => {
    const alunni = h.db.alunni as Record<string, unknown>[]
    alunni[0].stato = 'ritirato'
    expect((await contattiDi()).contacts.map((c) => c.user_id)).not.toContain(GEN_1)
  })

  it('senza sezioni assegnate: elenco vuoto e motivo esplicito', async () => {
    h.db.utenti_sezioni = []
    const j = await contattiDi()
    expect(j.contacts).toEqual([])
    expect(j.motivo).toBe('nessuna-sezione-assegnata')
  })
})

describe('il GATE della scrittura: una vetrina non è una porta', () => {
  it('il genitore NON apre un thread con una maestra fuori dalla sezione di suo figlio', async () => {
    h.requireUser.mockResolvedValue({ user: { id: GEN_1, role: 'genitore', scuola_id: SEDE_A } })
    const res = await CREA_THREAD(post({ teacher_id: ED_ALTRO, parent_id: GEN_1, student_id: ALU_1 }))
    expect(res.status).toBe(403)
    expect(h.scritture).toEqual([])
  })

  it('né con una maestra CESSATA della sezione giusta', async () => {
    h.requireUser.mockResolvedValue({ user: { id: GEN_1, role: 'genitore', scuola_id: SEDE_A } })
    const res = await CREA_THREAD(post({ teacher_id: ED_CESSATA, parent_id: GEN_1, student_id: ALU_1 }))
    expect(res.status).toBe(403)
    expect(h.scritture).toEqual([])
  })

  it('la maestra NON apre un thread con un genitore che non è di quel bambino', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ED, role: 'educator', scuola_id: SEDE_A } })
    const res = await CREA_THREAD(post({ teacher_id: ED, parent_id: GEN_2, student_id: ALU_1 }))
    expect(res.status).toBe(403)
    expect(h.scritture).toEqual([])
  })

  it('la coppia legittima invece passa, e la riga nasce davvero', async () => {
    h.requireUser.mockResolvedValue({ user: { id: GEN_1, role: 'genitore', scuola_id: SEDE_A } })
    const res = await CREA_THREAD(post({ teacher_id: ED, parent_id: GEN_1, student_id: ALU_1 }))
    expect(res.status).toBe(201)
    expect(h.scritture).toEqual([
      expect.objectContaining({ tabella: 'chat_threads', operazione: 'insert' }),
    ])
  })

  it('la segreteria della stessa sede passa: è il ramo che tiene in piedi 35 thread', async () => {
    h.requireUser.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await CREA_THREAD(post({ teacher_id: SEGRETERIA, parent_id: GEN_1, student_id: ALU_1 }))
    expect(res.status).toBe(201)
  })
})

describe('i contatti già in conversazione non si ripropongono', () => {
  it('sparisce dalla rubrica chi ha già un thread aperto su quel bambino', async () => {
    h.requireUser.mockResolvedValue({ user: { id: GEN_1, role: 'genitore', scuola_id: SEDE_A } })
    h.db.chat_threads = [{ id: 't-1', teacher_id: ED, parent_id: GEN_1, student_id: ALU_1 }]
    const j = await contattiDi()
    expect(j.contacts).toEqual([])
    expect(j.motivo).toBe('tutti-gia-contattati')
  })
})
