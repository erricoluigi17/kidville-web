import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

/**
 * PR 3 · COMPITO 3.7-2b · l'import notturno (`eseguiDomanda` / `alunnoDiRiferimento`) collegato a `scriviFrequenza`
 * (fase A, §4.19). Tre siti: scheda esistente aggiornata, alunno nuovo, seconda passata `retta_a_carico_di`.
 * Per ognuno: una chiamata coi campi tradotti e l'anno della sede su cui `alunni` è scritto; zero su errore di `alunni`.
 *
 * ⚠️ Difetto noto, NON corretto qui (lo chiude la PR 4.5): l'import sposta il bambino nella classe nuova scrivendo
 * `classe_sezione` su `alunni`; la frequenza dell'anno attivo segue `alunni`, come lo specchio.
 */

const DOMANDA = 'd1d1d1d1-0000-4000-8000-000000000001'
const ESISTENTE = 'c3c3c3c3-0000-4000-8000-000000000003'
const CLASSE = '4 ANNI A'
const CF = 'XQQYKV19C07Z999T'
const ANNO = `anno-di-${SEDE_A}`

const h = vi.hoisted(() => ({
  scriviFrequenza: vi.fn(),
  annoAttivoDiSede: vi.fn(),
  invitaGenitore: vi.fn(),
  agganciaDaImport: vi.fn(),
}))

vi.mock('@/lib/crm/aggancio-alunno', () => ({ agganciaDaImport: (...a: unknown[]) => h.agganciaDaImport(...a) }))
vi.mock('@/lib/iscrizioni/import/inviti', async (orig) => {
  const m = await orig<typeof import('@/lib/iscrizioni/import/inviti')>()
  return { ...m, invitaGenitore: (...a: unknown[]) => h.invitaGenitore(...a) }
})
vi.mock('@/lib/auth/parent-identity', () => ({ findAuthUserIdByEmail: async () => null }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: vi.fn(async () => undefined) }))
vi.mock('@/lib/email/ritmo', () => ({ pausaFraEmail: vi.fn(async () => undefined) }))
vi.mock('@/lib/anno/frequenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/frequenze')>()),
  scriviFrequenza: h.scriviFrequenza,
  annoAttivoDiSede: h.annoAttivoDiSede,
}))

import { eseguiDomanda, alunnoDiRiferimento } from '@/lib/iscrizioni/import/esegui'
import type { AssegnazioneBambino, Domanda } from '@/lib/iscrizioni/import/analisi'

const domanda: Domanda = { id: DOMANDA, scuolaId: SEDE_A, creataIl: '2026-10-01T09:00:00Z', bambini: [], adulti: [] }
const dati = {
  children: [
    { nome: 'Bimbo', cognome: 'Prova', data_nascita: '2024-03-05' },
    { nome: 'Bimba', cognome: 'Prova', data_nascita: '2023-01-02' },
  ],
  adults: [{ first_name: 'Genitore', last_name: 'Prova', email: 'genitore@example.test', ruolo: 'madre' }],
}
const assegnazioni: AssegnazioneBambino[] = [
  { indice: 0, nome: 'Bimbo', cognome: 'Prova', classe: CLASSE, retta: 150, aCaricoDi: null },
  { indice: 1, nome: 'Bimba', cognome: 'Prova', classe: CLASSE, retta: 200, aCaricoDi: null },
]

let db: DBFinto

function client(errori: Record<string, { code: string; message?: string }> = {}, alunni: Riga[] = []) {
  db = {
    sections: [{ id: 's1', scuola_id: SEDE_A, name: CLASSE }],
    alunni,
    parents: [],
    student_parents: [],
    legame_genitori_alunni: [],
    enrollment_submissions: [{ id: DOMANDA, scuola_id: SEDE_A, consents_log: null }],
  }
  const rpc = async () => ({ data: null, error: null })
  return creaFintoSupabase(db, [], {
    errori,
    rpc: { iscrizioni_segna_creato: rpc, iscrizioni_chiudi: rpc, iscrizioni_annulla: rpc, iscrizioni_rinvia: rpc },
  })
}

const chiamate = () => h.scriviFrequenza.mock.calls.map((c) => c[1])

beforeEach(() => {
  vi.clearAllMocks()
  h.invitaGenitore.mockResolvedValue({ tipo: 'inviata', authUserId: 'auth-1', messageId: 'm-1' })
  h.agganciaDaImport.mockResolvedValue({ esito: 'fatto', agganciati: 2 })
  h.annoAttivoDiSede.mockImplementation(async (_c: unknown, sede: string | null) => (sede ? `anno-di-${sede}` : null))
  h.scriviFrequenza.mockResolvedValue({ ok: true })
})

describe('eseguiDomanda — alunni NUOVI', () => {
  it('una chiamata per bambino con la sua retta, l’anno della sede letto una volta sola (cache condivisa)', async () => {
    const esito = await eseguiDomanda(client(), domanda, dati, assegnazioni, SEDE_A)
    expect(esito.esito).toBe('inviata')
    const [bimbo, bimba] = (db.alunni as Riga[]).map((a) => a.id)
    expect(chiamate()).toEqual([
      { alunnoId: bimbo, annoSedeId: ANNO, campi: { retta_mensile: 150 } },
      { alunnoId: bimba, annoSedeId: ANNO, campi: { retta_mensile: 200 } },
    ])
    const cache = h.annoAttivoDiSede.mock.calls.map((c) => c[2])
    expect(cache[0]).toBeInstanceOf(Map)
    expect(cache.every((c) => c === cache[0])).toBe(true)
  })

  it('alunni in errore: zero chiamate', async () => {
    const esito = await eseguiDomanda(client({ 'alunni:insert': { code: '23514', message: 'no' } }), domanda, dati, assegnazioni, SEDE_A)
    expect(esito.esito).not.toBe('inviata')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('scriviFrequenza fallita: l’import resta inviato', async () => {
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect((await eseguiDomanda(client(), domanda, dati, assegnazioni, SEDE_A)).esito).toBe('inviata')
  })

  it('«la paga il fratello»: retta 0 → retta_mensile NULL, poi il legame in una chiamata a parte', async () => {
    const aCarico: AssegnazioneBambino[] = [
      assegnazioni[0],
      { indice: 1, nome: 'Bimba', cognome: 'Prova', classe: CLASSE, retta: 0, aCaricoDi: 'Prova Bimbo' },
    ]
    await eseguiDomanda(client(), domanda, dati, aCarico, SEDE_A)
    const [bimbo, bimba] = (db.alunni as Riga[]).map((a) => a.id)
    expect(chiamate()).toEqual([
      { alunnoId: bimbo, annoSedeId: ANNO, campi: { retta_mensile: 150 } },
      { alunnoId: bimba, annoSedeId: ANNO, campi: { retta_mensile: null } },
      { alunnoId: bimba, annoSedeId: ANNO, campi: { retta_a_carico_di: bimbo } },
    ])
  })

  it('legame in errore: nessuna chiamata per il legame', async () => {
    const aCarico: AssegnazioneBambino[] = [
      assegnazioni[0],
      { indice: 1, nome: 'Bimba', cognome: 'Prova', classe: CLASSE, retta: 0, aCaricoDi: 'Prova Bimbo' },
    ]
    await eseguiDomanda(client({ 'alunni:update': { code: '23503', message: 'no' } }), domanda, dati, aCarico, SEDE_A)
    expect(chiamate().filter((c) => 'retta_a_carico_di' in (c.campi as object))).toHaveLength(0)
  })
})

describe('alunnoDiRiferimento — scheda ESISTENTE', () => {
  const grezzo = { codice_fiscale: CF, nome: 'Bimbo', cognome: 'Prova', data_nascita: '2024-03-05' }
  const esistente = (): Riga => ({ id: ESISTENTE, scuola_id: SEDE_A, codice_fiscale: CF, allergies: null, note_mediche: null })

  it('una chiamata con la retta nuova (classe_sezione non è una colonna copiata)', async () => {
    const esito = await alunnoDiRiferimento(client({}, [esistente()]), grezzo, assegnazioni[0], SEDE_A, DOMANDA)
    expect(esito).toEqual({ id: ESISTENTE })
    expect(chiamate()).toEqual([{ alunnoId: ESISTENTE, annoSedeId: ANNO, campi: { retta_mensile: 150 } }])
  })

  it('update di alunni in errore: errore e zero chiamate', async () => {
    const esito = await alunnoDiRiferimento(client({ 'alunni:update': { code: '23514', message: 'no' } }, [esistente()]), grezzo, assegnazioni[0], SEDE_A, DOMANDA)
    expect(esito).toHaveProperty('errore')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('stesso codice fiscale in un’altra sede: nessuna scrittura, zero chiamate', async () => {
    const altra = { ...esistente(), scuola_id: 'b2b2b2b2-0000-4000-8000-000000000002' }
    const esito = await alunnoDiRiferimento(client({}, [altra]), grezzo, assegnazioni[0], SEDE_A, DOMANDA)
    expect(esito).toHaveProperty('errore')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })
})
