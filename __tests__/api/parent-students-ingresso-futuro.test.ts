import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * PR 4.5 · COMPITO 4.5.11 · «L'ISCRIZIONE COMINCIA IL …»: la lettura lato server.
 *
 * Il caso vero: una famiglia nuova ha UN solo figlio, con stato `in_arrivo` (qui: un valore di dato, la costante la porta il 4.5.4),
 * senza frequenza nell'anno attivo e con una frequenza viva in un anno che non è ancora cominciato. Le frequenze non si leggono dal
 * browser: `GET /api/parent/students` le legge e ne fa uscire LA SOLA DATA. Un guasto non diventa né la frase nuova né «nessuna
 * iscrizione attiva». Dati finti: uuid finti, nessun nome reale.
 */

const GENITORE = '710717f0-d5ae-4f6f-889f-60d167b65a3b'
const FIGLIO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const FRATELLO = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const SEDE = 'eeeeeeee-0000-4000-8000-00000000000e'
const FREQ_1 = 'f1f1f1f1-1111-4111-8111-f1f1f1f1f1f1'
const FREQ_2 = 'f2f2f2f2-2222-4222-8222-f2f2f2f2f2f2'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
  errori: {} as Record<string, { code: string; message?: string }>,
  tabelle: [] as string[],
  attivi: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  // Come in produzione: `figli_attivi` risponde, e per un figlio con la sola frequenza futura risponde con zero righe.
  const rpc = { figli_attivi: () => ({ data: h.attivi, error: null }) } as never
  const crea = () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori, rpc })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { GET } from '@/app/api/parent/students/route'

const alunnoInArrivo = (id: string) => ({
  id, nome: 'Prova', cognome: 'Finta', classe_sezione: null, scuola_id: SEDE, section_id: null, stato: 'in_arrivo', archiviato_il: null,
})

/** Il caso della PR 4.4: iscritto e con la classe, ma la frequenza dell'anno attivo comincia più avanti ⇒ nascosto fra i `ritirato`. */
const iscrittoConIngressoFuturo = (id: string) => ({ ...alunnoInArrivo(id), stato: 'iscritto', section_id: 'sec-1', classe_sezione: '3 ANNI A' })

const frequenza = (id: string, alunno: string, dataIngresso: string, stato = 'in_attesa') => ({
  id, alunno_id: alunno, anno_id: 'anno-2027', anno_sede_id: 'as-2027', scuola_id: SEDE, section_id: 'sezione-segreta', stato, data_ingresso: dataIngresso,
})

const dbBase = (): DBFinto => ({
  legame_genitori_alunni: [{ genitore_id: GENITORE, alunno_id: FIGLIO }],
  parents: [],
  student_parents: [],
  scuole: [{ id: SEDE, nome: 'Sede di prova', citta: 'Città', indirizzo: 'Via 1', config: {} }],
  alunni: [alunnoInArrivo(FIGLIO)],
  frequenze: [frequenza(FREQ_1, FIGLIO, '2027-09-01')],
})

const chiedi = async () => {
  const res = await GET(new Request(`http://localhost/api/parent/students?userId=${GENITORE}`))
  return { stato: res.status, body: (await res.json()) as Record<string, unknown> }
}

const alle = (istanteIso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(istanteIso))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.errori = {}
  h.tabelle = []
  h.attivi = []
  h.requireUser.mockResolvedValue({ user: { id: GENITORE, role: 'genitore' }, response: null })
  alle('2026-11-09T10:00:00.000Z')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/parent/students — ingresso_futuro', () => {
  it('UN solo figlio in arrivo con la frequenza in un anno futuro ⇒ elenco vuoto, in_attesa e la data d’ingresso', async () => {
    const { stato, body } = await chiedi()
    expect(stato).toBe(200)
    expect(body.data).toEqual([])
    expect(body.in_attesa).toBe(true)
    expect(body.ingresso_futuro).toBe('2027-09-01')
  })

  it('esce LA SOLA data: niente id di frequenza, di sezione, di anno', async () => {
    const { body } = await chiedi()
    const testo = JSON.stringify(body)
    for (const vietato of [FREQ_1, 'sezione-segreta', 'anno-2027', 'as-2027']) {
      expect(testo, vietato).not.toContain(vietato)
    }
  })

  it('una frequenza che comincia oggi (giorno di Roma) o prima non è futura', async () => {
    h.db.frequenze = [frequenza(FREQ_1, FIGLIO, '2026-11-09')]
    expect((await chiedi()).body.ingresso_futuro).toBeNull()
  })

  it('il giorno è quello di ROMA: 23:30 del 31/08 il 1° settembre è futuro, 00:30 del 01/09 no', async () => {
    h.db.frequenze = [frequenza(FREQ_1, FIGLIO, '2026-09-01')]
    alle('2026-08-31T21:30:00.000Z')
    expect((await chiedi()).body.ingresso_futuro).toBe('2026-09-01')
    alle('2026-08-31T22:30:00.000Z')
    expect((await chiedi()).body.ingresso_futuro).toBeNull()
  })

  it('una frequenza futura NON viva (ritirata) non fa la frase', async () => {
    h.db.frequenze = [frequenza(FREQ_1, FIGLIO, '2027-09-01', 'ritirato')]
    expect((await chiedi()).body.ingresso_futuro).toBeNull()
  })

  it('con due figli, se UNO non ha un ingresso futuro la frase direbbe il falso: null', async () => {
    h.db.legame_genitori_alunni.push({ genitore_id: GENITORE, alunno_id: FRATELLO })
    h.db.alunni.push({ ...alunnoInArrivo(FRATELLO), stato: 'ritirato' })
    expect((await chiedi()).body.ingresso_futuro).toBeNull()
  })

  it('con due figli entrambi in arrivo: la data più vicina', async () => {
    h.db.legame_genitori_alunni.push({ genitore_id: GENITORE, alunno_id: FRATELLO })
    h.db.alunni.push(alunnoInArrivo(FRATELLO))
    h.db.frequenze = [frequenza(FREQ_1, FIGLIO, '2027-09-15'), frequenza(FREQ_2, FRATELLO, '2027-09-01')]
    expect((await chiedi()).body.ingresso_futuro).toBe('2027-09-01')
  })

  it('un guasto di lettura ⇒ MAI la data, e il motivo «ritirato» (nessuna iscrizione attiva) non si sostiene: pannello generico', async () => {
    h.db.alunni = [iscrittoConIngressoFuturo(FIGLIO)]
    h.errori = { frequenze: { code: 'XX000', message: 'guasto' } }
    const { stato, body } = await chiedi()
    expect(stato).toBe(200)
    expect(body.in_attesa).toBe(true)
    expect(body.ingresso_futuro).toBeNull()
    expect(body.motivo_assenza).toBeNull()
  })

  it('schema indietro (il DB della CI): il comportamento di oggi, senza data e con il motivo di sempre', async () => {
    h.db.alunni = [iscrittoConIngressoFuturo(FIGLIO)]
    h.errori = { frequenze: { code: '42P01', message: 'tabella assente' } }
    const { stato, body } = await chiedi()
    expect(stato).toBe(200)
    expect(body.ingresso_futuro).toBeNull()
    expect(body.motivo_assenza).toBe('ritirato')
    const righe = h.logEvento.mock.calls.filter((c) => (c[2] as { tipo?: string })?.tipo === 'ingresso-futuro-schema-indietro')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('info')
  })

  it('chi ha un figlio attivo non fa nessuna lettura delle frequenze', async () => {
    h.db.alunni = [iscrittoConIngressoFuturo(FIGLIO)]
    h.attivi = [{ alunno_id: FIGLIO, frequenza_id: FREQ_1, section_id: 'sec-1', scuola_id: SEDE }]
    const { body } = await chiedi()
    expect((body.data as unknown[]).length).toBe(1)
    expect(body.ingresso_futuro).toBeNull()
    expect(h.tabelle).not.toContain('frequenze')
  })
})
