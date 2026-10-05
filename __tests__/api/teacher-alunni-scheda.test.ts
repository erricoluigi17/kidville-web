import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, OpzioniFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const SEZ_MIA = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRUI = 'aaaa2222-2222-4222-8222-aaaaaaaaaaaa'
const SEZ_MATERIA = 'aaaa3333-3333-4333-8333-aaaaaaaaaaaa'
const SEZ_B = 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb'
const ALU_MIO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_ALTRUI = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
const ALU_MATERIA = 'a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa'
const ALU_B = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const ALU_RITIRATO = 'a4a4a4a4-4444-4444-8444-aaaaaaaaaaaa'
const ALU_ANONIMO = 'a5a5a5a5-5555-4555-8555-aaaaaaaaaaaa'
const ALU_SOSPESO = 'a7a7a7a7-7777-4777-8777-aaaaaaaaaaaa'
const ALU_STATO_IGNOTO = 'a8a8a8a8-8888-4888-8888-aaaaaaaaaaaa'
const CF_MIO = 'TSTMIO21C44Z999Q'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: undefined as Record<string, { code: string }> | undefined,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { errori: h.errori, scritture: h.scritture } as OpzioniFinto),
  }
})

import * as rotta from '@/app/api/teacher/alunni/[id]/route'

const alunno = (id: string, section_id: string, scuola_id: string, extra: Record<string, unknown> = {}) => ({
  id, section_id, scuola_id, nome: 'Alfa', cognome: 'Prova-E2E', stato: 'iscritto', anonimizzato_il: null,
  gender: 'F', data_nascita: '2021-03-04', codice_fiscale: `tst${id.slice(0, 4)}21c44z999q`,
  allergies: null, allergeni: [], note_mediche: null, is_bes_dsa: false, usa_pannolino: false,
  consenso_privacy: true, consenso_foto_sito: true, consenso_foto_social: false,
  importo_retta_mensile: 987, intestatario_fatture: 'INTESTATARIO-FINTO', documento_path: 'doc/ALUNNO-FINTO.pdf',
  ...extra,
})

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_MIA, scuola_id: SEDE_A, name: 'Girasoli', school_type: 'infanzia' },
    { id: SEZ_ALTRUI, scuola_id: SEDE_A, name: 'Tulipani', school_type: 'infanzia' },
    { id: SEZ_MATERIA, scuola_id: SEDE_A, name: '3A', school_type: 'primaria' },
    { id: SEZ_B, scuola_id: SEDE_B, name: 'Girasoli', school_type: 'infanzia' },
  ],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: SEZ_MIA }],
  utenti_sezioni_materie: [{ utente_id: 'ed1', section_id: SEZ_MATERIA, materia_id: 'm1' }],
  utenti_scuole: [],
  alunni: [
    alunno(ALU_MIO, SEZ_MIA, SEDE_A, { codice_fiscale: CF_MIO.toLowerCase(), allergies: 'latte, fragole', allergeni: ['latte'] }),
    alunno(ALU_ALTRUI, SEZ_ALTRUI, SEDE_A),
    alunno(ALU_MATERIA, SEZ_MATERIA, SEDE_A),
    alunno(ALU_B, SEZ_B, SEDE_B),
    alunno(ALU_RITIRATO, SEZ_MIA, SEDE_A, { stato: 'ritirato' }),
    alunno(ALU_ANONIMO, SEZ_MIA, SEDE_A, { anonimizzato_il: '2026-09-01T00:00:00Z' }),
    // `stato = 'sospeso'`: la pratica è ferma, il bambino frequenta. Porta anche la
    // colonna BOOLEANA `sospeso` della morosità, un dato economico che non deve uscire.
    alunno(ALU_SOSPESO, SEZ_MIA, SEDE_A, { cognome: 'Pausa-E2E', stato: 'sospeso', sospeso: true, allergies: 'kiwi' }),
    alunno(ALU_STATO_IGNOTO, SEZ_MIA, SEDE_A, { stato: 'trasferito' }),
  ],
  student_parents: [
    {
      student_id: ALU_MIO, relation_type: 'mother', is_primary: true,
      parents: { first_name: 'Mamma', last_name: 'Prova-E2E', phone_numbers: ['333 000 0000'], emails: ['mamma@example.test'], fiscal_code: 'tstmmm80a41z999q', anonimizzato_il: null, document_number: 'DOC-GENITORE-FINTO', documento_path: 'doc/GENITORE-FINTO.pdf' },
    },
    { student_id: ALU_MIO, relation_type: 'father', is_primary: false, parents: { first_name: 'Ex', last_name: 'Anonimo', anonimizzato_il: '2026-01-01T00:00:00Z' } },
    { student_id: ALU_ALTRUI, relation_type: 'mother', is_primary: true, parents: { first_name: 'Altra', last_name: 'Mamma', anonimizzato_il: null } },
  ],
  delegates: [
    { id: 'd1', student_id: ALU_MIO, first_name: 'Nonna', last_name: 'Prova-E2E', relation: 'Nonna', document_number: 'DOC-DELEGATO-FINTO', document_url: 'u', created_at: '2026-09-01T00:00:00Z' },
    // Inserito DOPO ma creato PRIMA: esce per primo solo se la lettura ordina per `created_at`.
    { id: 'd2', student_id: ALU_MIO, first_name: 'Zio', last_name: 'Prova-E2E', relation: 'Zio', document_number: 'DOC-DELEGATO-FINTO-2', document_url: 'u', created_at: '2026-08-01T00:00:00Z' },
  ],
  fascicolo_accessi_audit: [],
})

const chiama = (id: string) =>
  rotta.GET(new NextRequest(`http://localhost/api/teacher/alunni/${id}`), { params: Promise.resolve({ id }) })

const audit = () => (h.scritture as Scrittura[]).filter((s) => s.tabella === 'fascicolo_accessi_audit')

/**
 * La route legge `alunni` DUE volte: il controllo (riga minima) e la scheda. Per
 * colpire solo la seconda serve un getter: `erroreDi` del finto client rilegge
 * `opzioni.errori[chiave]` a ogni esecuzione, PRIMA di filtrare `db[tabella]`. `azione`
 * riceve il numero della lettura e può restituire un errore o cambiare il database.
 */
const dallaSecondaLetturaDiAlunni = (azione: (n: number) => { code: string; message?: string } | undefined) => {
  let n = 0
  return {
    get 'alunni:select'() {
      n += 1
      return azione(n)
    },
  } as unknown as Record<string, { code: string }>
}

/** Fra il controllo e la lettura della scheda, la riga di `ALU_MIO` cambia così. */
const cambiaFraLeDueLetture = (modifica: (riga: Record<string, unknown>) => Record<string, unknown>) =>
  dallaSecondaLetturaDiAlunni((n) => {
    if (n === 2) h.db.alunni = h.db.alunni.map((a) => (a.id === ALU_MIO ? modifica(a) : a))
    return undefined
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = undefined
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/teacher/alunni/[id] — si apre', () => {
  it('educator della sezione: scheda completa, senza economia né documenti, e una riga di audit', async () => {
    const res = await chiama(ALU_MIO)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const testo = await res.text()
    for (const v of ['987', 'INTESTATARIO-FINTO', 'ALUNNO-FINTO', 'DOC-GENITORE-FINTO', 'GENITORE-FINTO', 'DOC-DELEGATO-FINTO', 'Anonimo']) {
      expect(testo).not.toContain(v)
    }
    const scheda = JSON.parse(testo)
    expect(scheda.codiceFiscale).toBe(CF_MIO)
    expect(scheda.sezione).toEqual({ id: SEZ_MIA, nome: 'Girasoli', grado: 'infanzia' })
    expect(scheda.salute).toMatchObject({ allergeni: ['latte'], allergieAltro: 'fragole', haAllergie: true })
    expect(scheda.genitori).toEqual([
      { nome: 'Mamma', cognome: 'Prova-E2E', parentela: 'madre', principale: true, telefoni: ['333 000 0000'], email: ['mamma@example.test'], codiceFiscale: 'TSTMMM80A41Z999Q' },
    ])
    expect(scheda.delegati).toEqual([
      { nome: 'Zio', cognome: 'Prova-E2E', parentela: 'Zio' },
      { nome: 'Nonna', cognome: 'Prova-E2E', parentela: 'Nonna' },
    ])

    expect(audit()).toHaveLength(1)
    expect(audit()[0].valori[0]).toMatchObject({ alunno_id: ALU_MIO, utente_id: 'ed1', azione: 'view', finalita: 'anagrafica-docente' })
  })

  it('il bambino «sospeso» frequenta: scheda con le allergie e una riga di audit', async () => {
    const res = await chiama(ALU_SOSPESO)
    expect(res.status).toBe(200)
    const testo = await res.text()
    // Nessuna etichetta «sospeso» e nessuna traccia della morosità (la colonna booleana).
    expect(testo.toLowerCase()).not.toContain('sospeso')
    const scheda = JSON.parse(testo)
    expect(scheda).toMatchObject({ id: ALU_SOSPESO, cognome: 'Pausa-E2E' })
    expect(scheda.salute).toMatchObject({ haAllergie: true, allergieAltro: 'kiwi' })
    expect(audit()).toHaveLength(1)
    expect(audit()[0].valori[0]).toMatchObject({ alunno_id: ALU_SOSPESO, utente_id: 'ed1', azione: 'view' })
  })

  it('educator assegnato per sola materia', async () => {
    expect((await chiama(ALU_MATERIA)).status).toBe(200)
  })

  it('segreteria: ogni bambino della propria sede', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    expect((await chiama(ALU_ALTRUI)).status).toBe(200)
  })

  it('se l’audit fallisce la scheda si mostra lo stesso, e il guasto va nei log', async () => {
    h.errori = { 'fascicolo_accessi_audit:insert': { code: '57P01' } }
    expect((await chiama(ALU_MIO)).status).toBe(200)
    expect(h.logEvento).toHaveBeenCalledWith('fascicolo', 'error', expect.objectContaining({ esito: 'audit-non-registrato', alunno_id: ALU_MIO }), expect.anything())
  })

  it('l’audit porta ip e user-agent della richiesta', async () => {
    const richiesta = new NextRequest(`http://localhost/api/teacher/alunni/${ALU_MIO}`, {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'UA-FINTO' },
    })
    expect((await rotta.GET(richiesta, { params: Promise.resolve({ id: ALU_MIO }) })).status).toBe(200)
    expect(audit()[0].valori[0]).toMatchObject({ ip: '203.0.113.7', user_agent: 'UA-FINTO', documento_id: null })
  })

  it('una colonna recente che il database non ha diventa «Non indicato», con un warn nei log', async () => {
    // Il finto client restituisce righe intere: la colonna assente si simula con una riga
    // che NON ha il campo (come in un database senza la migrazione) e con il 42703 sulla
    // lettura della scheda che la chiede. Il controllo (prima lettura) non la chiede.
    h.errori = dallaSecondaLetturaDiAlunni((n) =>
      n === 2 ? { code: '42703', message: 'column alunni.birth_province does not exist' } : undefined,
    )
    const res = await chiama(ALU_MIO)
    expect(res.status).toBe(200)
    const scheda = await res.json()
    expect(scheda.luogoNascita.provincia).toBeNull()
    expect(scheda.codiceFiscale).toBe(CF_MIO)
    expect(h.logEvento).toHaveBeenCalledWith(
      'db',
      'warn',
      expect.objectContaining({ operazione: 'teacher/alunni/[id]:GET', esito: 'colonna-assente:birth_province' }),
    )
    expect(audit()).toHaveLength(1)
  })
})

describe('GET /api/teacher/alunni/[id] — non si apre', () => {
  it('403 su un bambino di un’altra sezione, SENZA leggerne l’anagrafica', async () => {
    const res = await chiama(ALU_ALTRUI)
    expect(res.status).toBe(403)
    expect(h.tabelle.filter((t) => t === 'alunni')).toHaveLength(1)
    expect(h.tabelle).not.toContain('student_parents')
    expect(h.tabelle).not.toContain('delegates')
    expect(audit()).toHaveLength(0)
    // La proiezione scrive il codice fiscale in maiuscolo: il confronto non deve dipenderne.
    const testo = (await res.text()).toLowerCase()
    expect(testo).not.toContain('tsta2a2')
    expect(testo).not.toContain('altra')
  })

  it('403 su un bambino di un’altra sede', async () => {
    const res = await chiama(ALU_B)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('ANAGRAFICA_FUORI_SEDE')
  })

  it('403 anche alla segreteria, che vede tutte le classi ma solo della propria sede', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await chiama(ALU_B)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('ANAGRAFICA_FUORI_SEDE')
    expect(h.tabelle).not.toContain('student_parents')
    expect(audit()).toHaveLength(0)
  })

  it('404 per ritirato, stato mai deciso, anonimizzato, inesistente', async () => {
    for (const id of [ALU_RITIRATO, ALU_STATO_IGNOTO, ALU_ANONIMO, 'c0c0c0c0-0000-4000-8000-cccccccccccc']) {
      expect((await chiama(id)).status).toBe(404)
    }
    expect(h.tabelle).not.toContain('student_parents')
    expect(audit()).toHaveLength(0)
  })

  it('400 per un id che non è un uuid, senza toccare il database', async () => {
    expect((await chiama('non-un-uuid')).status).toBe(400)
    expect(h.tabelle).toEqual([])
  })

  it('il rifiuto del gate di ruolo passa intatto e non legge niente', async () => {
    h.requireDocente.mockResolvedValue({ response: new Response('{}', { status: 401 }) })
    expect((await chiama(ALU_MIO)).status).toBe(401)
    expect(h.tabelle).toEqual([])
  })

  it.each(['student_parents', 'delegates', 'sections'])(
    '500 se %s non si legge: log del guasto, niente cache, nessuna riga di audit',
    async (tabella) => {
      h.errori = { [`${tabella}:select`]: { code: '57P01' } }
      const res = await chiama(ALU_MIO)
      expect(res.status).toBe(500)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect((await res.json()).codice).toBe('ANAGRAFICA_NON_LETTA')
      expect(h.logErrore).toHaveBeenCalledWith(
        expect.objectContaining({ operazione: 'teacher/alunni/[id]:GET', stato: 500 }),
        expect.objectContaining({ code: '57P01' }),
      )
      expect(audit()).toHaveLength(0)
    },
  )

  it('500 se la lettura della scheda su `alunni` fallisce dopo un controllo riuscito', async () => {
    h.errori = dallaSecondaLetturaDiAlunni((n) => (n >= 2 ? { code: '57P01' } : undefined))
    const res = await chiama(ALU_MIO)
    expect(res.status).toBe(500)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await res.json()).codice).toBe('ANAGRAFICA_NON_LETTA')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'teacher/alunni/[id]:GET', stato: 500 }),
      expect.objectContaining({ code: '57P01' }),
    )
    expect(audit()).toHaveLength(0)
  })

  it('sola lettura: il modulo esporta SOLO `GET`', () => {
    const metodi = Object.keys(rotta).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))
    expect(metodi).toEqual(['GET'])
  })
})

describe('GET /api/teacher/alunni/[id] — la corsa fra il controllo e la lettura', () => {
  // Archiviare, dimenticare e trasferire non cancellano la riga: la AGGIORNANO (`stato`,
  // `anonimizzato_il`, `scuola_id`). La lettura della scheda deve rifare i filtri del
  // controllo, o un bambino uscito dal perimetro nell'intervallo esce con 200 e una riga di
  // audit. Un test per filtro: ciascuno da solo.
  it.each([
    ['passa a «ritirato»', (a: Record<string, unknown>) => ({ ...a, stato: 'ritirato' })],
    ['viene anonimizzato', (a: Record<string, unknown>) => ({ ...a, anonimizzato_il: '2026-10-04T00:00:00Z' })],
    ['cambia sede', (a: Record<string, unknown>) => ({ ...a, scuola_id: SEDE_B })],
  ])('se il bambino %s fra le due letture: 404, niente cache, nessuna riga di audit', async (_caso, modifica) => {
    h.errori = cambiaFraLeDueLetture(modifica)
    const res = await chiama(ALU_MIO)
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await res.json()).codice).toBe('ANAGRAFICA_NON_TROVATA')
    expect(audit()).toHaveLength(0)
  })

  it('se il bambino passa a «sospeso» fra le due letture la scheda si apre: la seconda lettura ammette gli stessi stati del controllo', async () => {
    // Il controllo vede un `iscritto`: qui si misura SOLO il filtro della seconda lettura.
    h.errori = cambiaFraLeDueLetture((a) => ({ ...a, stato: 'sospeso' }))
    const res = await chiama(ALU_MIO)
    expect(res.status).toBe(200)
    expect(audit()).toHaveLength(1)
  })

  it('se la riga sparisce fra le due letture: 404, niente cache, nessuna riga di audit', async () => {
    h.errori = dallaSecondaLetturaDiAlunni((n) => {
      if (n === 2) h.db.alunni = h.db.alunni.filter((a) => a.id !== ALU_MIO)
      return undefined
    })
    const res = await chiama(ALU_MIO)
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await res.json()).codice).toBe('ANAGRAFICA_NON_TROVATA')
    expect(audit()).toHaveLength(0)
  })
})
