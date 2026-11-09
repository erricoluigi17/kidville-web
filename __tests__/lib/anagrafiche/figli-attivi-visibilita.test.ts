import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type RispostaRpc } from '../../fixtures/finto-supabase'

/**
 * PR 4.4 · `getFigliAttiviDiGenitore` decide «attivo» con la funzione SQL.
 *
 * Tre esiti, e un guasto non apre mai: schema indietro = il comportamento di oggi, con un `info`; ogni altro errore =
 * nessun figlio e `errore`, mai l'elenco largo. `motivoNascosto` resta sopra la funzione: `figli_attivi` dà attivo anche
 * chi ha una frequenza viva senza sezione, e l'app di famiglia quel bambino non lo mostra.
 */

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento }
})

import { getFigliAttiviDiGenitore } from '@/lib/anagrafiche/legami'
import { leggiVisibilita } from '@/lib/anno/visibilita-genitore'

const GEN = '99999999-9999-4999-8999-999999999991'
const ATTIVO = '11111111-1111-4111-8111-111111111111'
const SENZA_FREQUENZA = '11111111-1111-4111-8111-111111111112'
const SENZA_SEZIONE = '11111111-1111-4111-8111-111111111113'
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_B = '22222222-2222-4222-8222-222222222223'
const SEZ = '55555555-5555-4555-8555-555555555551'
const SEZ_B = '55555555-5555-4555-8555-555555555552'
const FREQ = '66666666-6666-4666-8666-666666666661'
const FREQ_B = '66666666-6666-4666-8666-666666666662'

const riga = (id: string, extra: Record<string, unknown> = {}) => ({
  id, nome: 'Nome', cognome: 'Prova', classe_sezione: '3 ANNI', scuola_id: SEDE, section_id: SEZ, stato: 'iscritto', archiviato_il: null, ...extra,
})

const dbBase = (): DBFinto => ({
  legame_genitori_alunni: [
    { genitore_id: GEN, alunno_id: ATTIVO },
    { genitore_id: GEN, alunno_id: SENZA_FREQUENZA },
  ],
  parents: [],
  student_parents: [],
  alunni: [riga(ATTIVO), riga(SENZA_FREQUENZA)],
})

const conRpc = (db: DBFinto, figli_attivi: () => RispostaRpc) => creaFintoSupabase(db, [], { rpc: { figli_attivi } }) as never

const frequenzaDi = (alunno: string, frequenza = FREQ, section: string | null = SEZ, scuola = SEDE) => ({
  alunno_id: alunno, frequenza_id: frequenza, section_id: section, scuola_id: scuola,
})

beforeEach(() => { vi.clearAllMocks() })

describe('getFigliAttiviDiGenitore sulla funzione SQL', () => {
  it('un figlio legato ma senza frequenza attiva non si mostra, e resta contato fra i nascosti', async () => {
    const esito = await getFigliAttiviDiGenitore(
      conRpc(dbBase(), () => ({ data: [frequenzaDi(ATTIVO)], error: null })), GEN)

    expect(esito.righe.map((r) => r.id)).toEqual([ATTIVO])
    expect(esito.totaleLegami).toBe(2)
    expect(esito.nascosti).toEqual({ archiviato: 0, ritirato: 1, 'senza-sezione': 0 })
    expect(esito.completo).toBe(true)
    expect(esito.errore).toBeNull()
  })

  it('una frequenza viva senza sezione: nascosto, e contato in `senza-sezione`', async () => {
    const db = dbBase()
    db.legame_genitori_alunni.push({ genitore_id: GEN, alunno_id: SENZA_SEZIONE })
    db.alunni.push(riga(SENZA_SEZIONE, { section_id: null, classe_sezione: null }))
    const esito = await getFigliAttiviDiGenitore(
      conRpc(db, () => ({ data: [frequenzaDi(ATTIVO), frequenzaDi(SENZA_SEZIONE, FREQ_B, null)], error: null })), GEN)

    expect(esito.righe.map((r) => r.id)).toEqual([ATTIVO])
    expect(esito.nascosti['senza-sezione']).toBe(1)
    expect(esito.righe.every((r) => r.section_id !== null)).toBe(true)
  })

  it('la scheda ha ancora la classe ma la frequenza attiva non ce l’ha: è senza sezione', async () => {
    const db = dbBase()
    db.legame_genitori_alunni.push({ genitore_id: GEN, alunno_id: SENZA_SEZIONE })
    db.alunni.push(riga(SENZA_SEZIONE))
    const esito = await getFigliAttiviDiGenitore(
      conRpc(db, () => ({ data: [frequenzaDi(ATTIVO), frequenzaDi(SENZA_SEZIONE, FREQ_B, null)], error: null })), GEN)

    expect(esito.righe.map((r) => r.id)).toEqual([ATTIVO])
    expect(esito.nascosti['senza-sezione']).toBe(1)
  })

  it('due frequenze vive dello stesso figlio (due sedi su anni attivi diversi) danno un figlio solo', async () => {
    const esito = await getFigliAttiviDiGenitore(
      conRpc(dbBase(), () => ({
        data: [frequenzaDi(ATTIVO), frequenzaDi(ATTIVO, FREQ_B, SEZ_B, SEDE_B)],
        error: null,
      })), GEN)

    expect(esito.righe.map((r) => r.id)).toEqual([ATTIVO])
  })

  it('`motivoNascosto` resta sopra la funzione: una frequenza viva e la scheda archiviata non si mostra', async () => {
    const db = dbBase()
    db.alunni[0] = riga(ATTIVO, { archiviato_il: '2026-10-01T10:00:00Z', stato: 'ritirato' })
    const esito = await getFigliAttiviDiGenitore(
      conRpc(db, () => ({ data: [frequenzaDi(ATTIVO)], error: null })), GEN)

    expect(esito.righe).toEqual([])
    expect(esito.nascosti.archiviato).toBe(1)
  })

  it('zero figli attivi con i legami: nessun errore, e `nascosti` lo dice (la pagina non resta in caricamento)', async () => {
    const esito = await getFigliAttiviDiGenitore(conRpc(dbBase(), () => ({ data: [], error: null })), GEN)

    expect(esito.righe).toEqual([])
    expect(esito.totaleLegami).toBe(2)
    expect(esito.nascosti.ritirato).toBe(2)
    expect(esito.completo).toBe(true)
    expect(esito.errore).toBeNull()
  })

  it('zero legami: la funzione non si chiama nemmeno', async () => {
    const rpc = vi.fn(() => ({ data: [], error: null }))
    const db = dbBase()
    db.legame_genitori_alunni = []
    const esito = await getFigliAttiviDiGenitore(conRpc(db, rpc), GEN)

    expect(rpc).not.toHaveBeenCalled()
    expect(esito.totaleLegami).toBe(0)
    expect(esito.errore).toBeNull()
  })

  it.each(['PGRST202', '42883'])('schema indietro (%s): il comportamento di oggi, con un `info`', async (code) => {
    const esito = await getFigliAttiviDiGenitore(
      conRpc(dbBase(), () => ({ data: null, error: { code, message: 'funzione assente' } })), GEN)

    expect(esito.righe.map((r) => r.id)).toEqual([ATTIVO, SENZA_FREQUENZA])
    expect(esito.errore).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith('anno-scolastico', 'info', expect.objectContaining({
      operazione: 'anno/visibilita:figli_attivi',
      esito: 'schema-indietro',
      error_code: code,
    }))
  })

  it('un guasto non apre: nessun figlio, `errore` valorizzato e riga di livello `error`', async () => {
    const guasto = { code: '57014', message: 'canceling statement due to statement timeout' }
    const esito = await getFigliAttiviDiGenitore(conRpc(dbBase(), () => ({ data: null, error: guasto })), GEN)

    expect(esito.righe).toEqual([])
    expect(esito.completo).toBe(false)
    expect(esito.errore).toEqual(guasto)
    expect(h.logEvento).toHaveBeenCalledWith('anno-scolastico', 'error', expect.objectContaining({
      operazione: 'anno/visibilita:figli_attivi',
      esito: 'lettura-fallita',
      error_code: '57014',
    }), expect.anything())
  })

  it('il successo lascia il conteggio a livello `info`', async () => {
    await getFigliAttiviDiGenitore(conRpc(dbBase(), () => ({ data: [frequenzaDi(ATTIVO)], error: null })), GEN)

    expect(h.logEvento).toHaveBeenCalledWith('anno-scolastico', 'info', expect.objectContaining({
      operazione: 'anno/visibilita:figli_attivi',
      esito: 'letta',
      n: 1,
    }))
  })

  it.each(['42703', '42P01'])('una funzione che si rompe nel corpo (%s) non riapre l’elenco largo', async (code) => {
    const guasto = { code, message: 'oggetto assente nel corpo della funzione' }
    const esito = await getFigliAttiviDiGenitore(conRpc(dbBase(), () => ({ data: null, error: guasto })), GEN)

    expect(esito.righe).toEqual([])
    expect(esito.completo).toBe(false)
    expect(esito.errore).toEqual(guasto)
  })
})

describe('leggiVisibilita: `indietro` vuol dire solo che manca la funzione', () => {
  const chiama = (code: string) => leggiVisibilita(
    conRpc(dbBase(), () => ({ data: null, error: { code, message: 'assente' } })),
    'figli_attivi',
    GEN,
  )

  it.each(['PGRST202', '42883'])('%s: `indietro`, con un `info`', async (code) => {
    expect(await chiama(code)).toEqual({ stato: 'indietro' })
    expect(h.logEvento).toHaveBeenCalledWith('anno-scolastico', 'info', expect.objectContaining({
      esito: 'schema-indietro',
      error_code: code,
    }))
  })

  // `schemaAnnoIndietro` li comprende tutti e quattro, e per chi legge una tabella ha ragione. Qui no: la funzione risponde, e
  // dentro manca qualcosa. Il giorno in cui una migrazione toglie una colonna letta da una funzione, le famiglie tornerebbero al
  // filtro largo senza un 500.
  it.each(['42703', '42P01', 'PGRST204', 'PGRST205'])('%s: `guasto`, con un `error`', async (code) => {
    const esito = await chiama(code)

    expect(esito.stato).toBe('guasto')
    expect(h.logEvento).toHaveBeenCalledWith('anno-scolastico', 'error', expect.objectContaining({
      operazione: 'anno/visibilita:figli_attivi',
      esito: 'lettura-fallita',
      error_code: code,
    }), expect.anything())
    expect(h.logEvento).not.toHaveBeenCalledWith('anno-scolastico', 'info', expect.objectContaining({ esito: 'schema-indietro' }))
  })
})
