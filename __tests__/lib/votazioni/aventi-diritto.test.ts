import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import {
  figliAttiviConClasse,
  genitoriDelleClassi,
  genitoriDellaSede,
  nomiGenitori,
} from '@/lib/votazioni/aventi-diritto'
import { getFigliAttiviDiGenitore } from '@/lib/anagrafiche/legami'
import { STATI_CON_CANALE_FAMIGLIA } from '@/lib/alunni/stato'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto, type Riga } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'

/**
 * GLI AVENTI DIRITTO DI UNA VOTAZIONE, PROVATI CON UN DATABASE CHE FILTRA DAVVERO.
 *
 * Un avente diritto è un genitore con un ACCOUNT (e attivo) che ha un figlio ancora a scuola in una
 * delle classi della votazione. Ogni condizione ha un caso che la fa fallire se manca: con un mock
 * piatto (che risponde sempre la stessa lista) l'alunno ritirato o archiviato comparirebbe lo stesso.
 *
 * Solo dati finti: uuid inventati e cognomi di fantasia.
 */

// ── identità finte ───────────────────────────────────────────────────────────
const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${String(n).padStart(12, '0')}`

const CLASSE_1 = uuid('c1000000', 1)
const CLASSE_2 = uuid('c2000000', 2)
const CLASSE_3 = uuid('c3000000', 3) // della sede B
const CLASSE_VUOTA = uuid('c4000000', 4)

const G_ROSSI = uuid('a0000000', 1)
const G_BIANCHI = uuid('a0000000', 2)
const G_VERDI = uuid('a0000000', 3)
const G_NERI = uuid('a0000000', 4)
const G_INATTIVO = uuid('a0000000', 5)
const G_DOCENTE = uuid('a0000000', 6)
const G_ALTRA_SEDE = uuid('a0000000', 7)

const utente = (id: string, cognome: string, nome: string, extra: Riga = {}): Riga => ({
  id,
  cognome,
  nome,
  ruolo: 'genitore',
  attivo: true,
  ...extra,
})

const alunno = (id: string, section_id: string | null, extra: Riga = {}): Riga => ({
  id,
  scuola_id: SEDE_A,
  section_id,
  stato: 'iscritto',
  archiviato_il: null,
  nome: 'Bimbo',
  cognome: 'Finto',
  classe_sezione: section_id ? 'CLASSE' : null,
  ...extra,
})

const AL = (n: number) => uuid('b0000000', n)

/** Il legame «runtime» genitore↔alunno: l’account è direttamente l’`utenti.id`. */
const legame = (alunno_id: string, genitore_id: string): Riga => ({ alunno_id, genitore_id })

function dbBase(): DBFinto {
  return {
    sections: [
      { id: CLASSE_1, scuola_id: SEDE_A, name: '2 ANNI' },
      { id: CLASSE_2, scuola_id: SEDE_A, name: '3 ANNI' },
      { id: CLASSE_VUOTA, scuola_id: SEDE_A, name: '1 ANNO' },
      { id: CLASSE_3, scuola_id: SEDE_B, name: '2 ANNI' },
    ],
    alunni: [
      alunno(AL(1), CLASSE_1),
      alunno(AL(2), CLASSE_1),
      alunno(AL(3), CLASSE_2),
    ],
    legame_genitori_alunni: [
      legame(AL(1), G_ROSSI),
      legame(AL(2), G_ROSSI), // due figli nella STESSA classe: un solo Rossi
      legame(AL(3), G_ROSSI), // …e un terzo in un’altra classe: Rossi compare in entrambe
      legame(AL(1), G_BIANCHI),
    ],
    student_parents: [],
    parents: [],
    utenti: [
      utente(G_ROSSI, 'Rossi', 'Anna'),
      utente(G_BIANCHI, 'Bianchi', 'Luca'),
      utente(G_VERDI, 'Verdi', 'Marta'),
      utente(G_NERI, 'Neri', 'Paolo'),
      utente(G_INATTIVO, 'Inattivi', 'Ida', { attivo: false }),
      utente(G_DOCENTE, 'Docenti', 'Dina', { ruolo: 'docente' }),
      utente(G_ALTRA_SEDE, 'Lontani', 'Laura'),
    ],
  }
}

function leggi(db: DBFinto, opzioni: OpzioniFinto = {}) {
  return creaFintoSupabase(db, [], opzioni)
}

const nomi = (genitori: { nome: string }[]) => genitori.map((g) => g.nome)

beforeEach(() => {
  h.logEvento.mockClear()
  h.logErrore.mockClear()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('nomiGenitori', () => {
  it('«Cognome Nome», per cognome e poi nome, solo gli account attivi', async () => {
    const supabase = leggi(dbBase())
    const r = await nomiGenitori(supabase, [G_ROSSI, G_BIANCHI, G_VERDI, G_INATTIVO])
    expect(r.completo).toBe(true)
    expect(r.errore).toBeNull()
    expect(r.valore).toEqual([
      { utenteId: G_BIANCHI, nome: 'Bianchi Luca' },
      { utenteId: G_ROSSI, nome: 'Rossi Anna' },
      { utenteId: G_VERDI, nome: 'Verdi Marta' },
    ])
  })

  it('l’account inattivo è escluso, e NON c’è nessun filtro sul ruolo: un docente-genitore c’è', async () => {
    const supabase = leggi(dbBase())
    const r = await nomiGenitori(supabase, [G_INATTIVO, G_DOCENTE])
    expect(r.valore).toEqual([{ utenteId: G_DOCENTE, nome: 'Docenti Dina' }])
  })

  it('a parità di cognome decide il nome', async () => {
    const db = dbBase()
    db.utenti.push(utente(uuid('a0000000', 90), 'Rossi', 'Aldo'), utente(uuid('a0000000', 91), 'Rossi', 'Zita'))
    const r = await nomiGenitori(leggi(db), [uuid('a0000000', 91), G_ROSSI, uuid('a0000000', 90)])
    expect(nomi(r.valore)).toEqual(['Rossi Aldo', 'Rossi Anna', 'Rossi Zita'])
  })

  it('una lista vuota non interroga il database', async () => {
    const supabase = leggi(dbBase())
    const da = vi.spyOn(supabase, 'from')
    const r = await nomiGenitori(supabase, [])
    expect(r).toEqual({ valore: [], completo: true, errore: null })
    expect(da).not.toHaveBeenCalled()
  })

  it('i doppioni nella lista chiesta non producono doppioni nel risultato', async () => {
    const r = await nomiGenitori(leggi(dbBase()), [G_ROSSI, G_ROSSI, G_ROSSI.toUpperCase()])
    expect(r.valore.map((g) => g.utenteId)).toEqual([G_ROSSI])
  })

  it('oltre i 100 id per query va a blocchi e non ne perde nessuno', async () => {
    const db = dbBase()
    const ids: string[] = []
    for (let i = 0; i < 250; i++) {
      const id = uuid('d0000000', i)
      ids.push(id)
      db.utenti.push(utente(id, `Cognome${String(i).padStart(3, '0')}`, 'Nome'))
    }
    const supabase = leggi(db)
    const da = vi.spyOn(supabase, 'from')
    const r = await nomiGenitori(supabase, ids)
    expect(r.valore).toHaveLength(250)
    expect(r.completo).toBe(true)
    // 250 id → 3 blocchi da 100 al massimo: non una query per id, e non una sola con 250 id nell’URL.
    const sulleUtenti = da.mock.calls.filter(([t]) => t === 'utenti').length
    expect(sulleUtenti).toBe(3)
  })

  it('un errore del database → completo false, errore valorizzato, niente nomi inventati', async () => {
    const errore = { code: 'XX000', message: 'guasto finto' }
    const r = await nomiGenitori(leggi(dbBase(), { errori: { utenti: errore } }), [G_ROSSI])
    expect(r.completo).toBe(false)
    expect(r.errore).toMatchObject({ code: 'XX000' })
    expect(r.valore).toEqual([])
  })

  it('il guasto lascia una riga di log con il codice, senza nomi', async () => {
    await nomiGenitori(leggi(dbBase(), { errori: { utenti: { code: 'XX000' } } }), [G_ROSSI])
    const chiamate = JSON.stringify([...h.logEvento.mock.calls, ...h.logErrore.mock.calls])
    expect(chiamate).toContain('votazioni')
    expect(chiamate).not.toContain('Rossi')
    expect(chiamate).not.toContain('Anna')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('genitoriDelleClassi', () => {
  it('una Map con TUTTE le classi chieste, anche quelle senza genitori (aventi diritto 0, non assente)', async () => {
    const r = await genitoriDelleClassi(leggi(dbBase()), SEDE_A, [CLASSE_1, CLASSE_2, CLASSE_VUOTA])
    expect(r.completo).toBe(true)
    expect(r.errore).toBeNull()
    expect([...r.valore.keys()].sort()).toEqual([CLASSE_1, CLASSE_2, CLASSE_VUOTA].sort())
    expect(r.valore.get(CLASSE_VUOTA)).toEqual([])
  })

  it('due genitori dello stesso bambino sono presenti tutti e due, in ordine di cognome', async () => {
    const r = await genitoriDelleClassi(leggi(dbBase()), SEDE_A, [CLASSE_1])
    expect(nomi(r.valore.get(CLASSE_1)!)).toEqual(['Bianchi Luca', 'Rossi Anna'])
  })

  it('un genitore con DUE figli nella stessa classe compare UNA volta (una scheda, non due)', async () => {
    const r = await genitoriDelleClassi(leggi(dbBase()), SEDE_A, [CLASSE_1])
    const rossi = r.valore.get(CLASSE_1)!.filter((g) => g.utenteId === G_ROSSI)
    expect(rossi).toHaveLength(1)
  })

  it('un genitore con figli in DUE classi compare in entrambe', async () => {
    const r = await genitoriDelleClassi(leggi(dbBase()), SEDE_A, [CLASSE_1, CLASSE_2])
    expect(r.valore.get(CLASSE_1)!.map((g) => g.utenteId)).toContain(G_ROSSI)
    expect(r.valore.get(CLASSE_2)!.map((g) => g.utenteId)).toEqual([G_ROSSI])
  })

  it('chiedere una classe sola non fa comparire i genitori delle altre', async () => {
    const r = await genitoriDelleClassi(leggi(dbBase()), SEDE_A, [CLASSE_2])
    expect(r.valore.get(CLASSE_2)!.map((g) => g.utenteId)).toEqual([G_ROSSI])
    expect(r.valore.has(CLASSE_1)).toBe(false)
  })

  it('il genitore con account INATTIVO è escluso', async () => {
    const db = dbBase()
    db.alunni.push(alunno(AL(10), CLASSE_1))
    db.legame_genitori_alunni.push(legame(AL(10), G_INATTIVO))
    const r = await genitoriDelleClassi(leggi(db), SEDE_A, [CLASSE_1])
    expect(r.valore.get(CLASSE_1)!.map((g) => g.utenteId)).not.toContain(G_INATTIVO)
  })

  it('il docente-genitore (utenti.ruolo = docente) legato al figlio è INCLUSO', async () => {
    const db = dbBase()
    db.alunni.push(alunno(AL(11), CLASSE_1))
    db.legame_genitori_alunni.push(legame(AL(11), G_DOCENTE))
    const r = await genitoriDelleClassi(leggi(db), SEDE_A, [CLASSE_1])
    expect(r.valore.get(CLASSE_1)!.map((g) => g.utenteId)).toContain(G_DOCENTE)
  })

  it('l’alunno ARCHIVIATO è escluso: il suo genitore non è avente diritto per lui', async () => {
    const db = dbBase()
    db.alunni.push(alunno(AL(12), CLASSE_1, { archiviato_il: '2026-09-01T00:00:00.000Z' }))
    db.legame_genitori_alunni.push(legame(AL(12), G_VERDI))
    const r = await genitoriDelleClassi(leggi(db), SEDE_A, [CLASSE_1])
    expect(r.valore.get(CLASSE_1)!.map((g) => g.utenteId)).not.toContain(G_VERDI)
  })

  it('l’alunno con uno stato FUORI da STATI_CON_CANALE_FAMIGLIA (ritirato) è escluso; il sospeso, che frequenta, no', async () => {
    expect(STATI_CON_CANALE_FAMIGLIA).not.toContain('ritirato')
    expect(STATI_CON_CANALE_FAMIGLIA).toContain('sospeso')
    const db = dbBase()
    db.alunni.push(alunno(AL(13), CLASSE_1, { stato: 'ritirato' }), alunno(AL(14), CLASSE_1, { stato: 'sospeso' }))
    db.legame_genitori_alunni.push(legame(AL(13), G_VERDI), legame(AL(14), G_NERI))
    const r = await genitoriDelleClassi(leggi(db), SEDE_A, [CLASSE_1])
    const ids = r.valore.get(CLASSE_1)!.map((g) => g.utenteId)
    expect(ids).not.toContain(G_VERDI)
    expect(ids).toContain(G_NERI)
  })

  it('l’alunno di un’ALTRA sede non conta, nemmeno se punta alla stessa classe', async () => {
    const db = dbBase()
    db.alunni.push(alunno(AL(15), CLASSE_1, { scuola_id: SEDE_B }))
    db.legame_genitori_alunni.push(legame(AL(15), G_ALTRA_SEDE))
    const r = await genitoriDelleClassi(leggi(db), SEDE_A, [CLASSE_1])
    expect(r.valore.get(CLASSE_1)!.map((g) => g.utenteId)).not.toContain(G_ALTRA_SEDE)
  })

  it('l’alunno SENZA classe (section_id nullo) non entra in nessuna scheda', async () => {
    const db = dbBase()
    db.alunni.push(alunno(AL(16), null))
    db.legame_genitori_alunni.push(legame(AL(16), G_VERDI))
    const r = await genitoriDelleClassi(leggi(db), SEDE_A, [CLASSE_1, CLASSE_2])
    const tutti = [...r.valore.values()].flat().map((g) => g.utenteId)
    expect(tutti).not.toContain(G_VERDI)
  })

  it('i genitori che arrivano dall’ANAGRAFICA (student_parents → parents.auth_user_id) contano come quelli del legame runtime', async () => {
    const db = dbBase()
    const PARENT_ROW = uuid('e0000000', 1)
    db.student_parents.push({ student_id: AL(2), parent_id: PARENT_ROW })
    db.parents.push({ id: PARENT_ROW, auth_user_id: G_VERDI })
    // Un parents senza account non produce nessun elettore.
    db.student_parents.push({ student_id: AL(2), parent_id: uuid('e0000000', 2) })
    db.parents.push({ id: uuid('e0000000', 2), auth_user_id: null })
    const r = await genitoriDelleClassi(leggi(db), SEDE_A, [CLASSE_1])
    expect(r.valore.get(CLASSE_1)!.map((g) => g.utenteId)).toContain(G_VERDI)
    expect(r.valore.get(CLASSE_1)!).toHaveLength(3)
  })

  it('una lista di classi vuota non interroga il database', async () => {
    const supabase = leggi(dbBase())
    const da = vi.spyOn(supabase, 'from')
    const r = await genitoriDelleClassi(supabase, SEDE_A, [])
    expect(r.completo).toBe(true)
    expect(r.valore.size).toBe(0)
    expect(da).not.toHaveBeenCalled()
  })

  it('PIÙ DI 1000 alunni: la lettura va a blocchi, e nessun genitore si perde al taglio di PostgREST', async () => {
    const db = dbBase()
    db.alunni = []
    db.legame_genitori_alunni = []
    db.utenti = []
    for (let i = 0; i < 1005; i++) {
      const g = uuid('f0000000', i)
      db.alunni.push(alunno(uuid('f1000000', i), CLASSE_1))
      db.legame_genitori_alunni.push(legame(uuid('f1000000', i), g))
      db.utenti.push(utente(g, `Fam${String(i).padStart(4, '0')}`, 'X'))
    }
    // `maxRighe: 1000` è il `max_rows` di PostgREST: il finto client taglia ogni risposta come lui.
    const r = await genitoriDelleClassi(leggi(db, { maxRighe: 1000 }), SEDE_A, [CLASSE_1])
    expect(r.errore).toBeNull()
    expect(r.completo).toBe(true)
    expect(r.valore.get(CLASSE_1)).toHaveLength(1005)
  })

  it('un errore sulla lettura degli alunni → completo false, errore valorizzato, classi presenti ma vuote', async () => {
    const r = await genitoriDelleClassi(leggi(dbBase(), { errori: { alunni: { code: 'XX000' } } }), SEDE_A, [CLASSE_1])
    expect(r.completo).toBe(false)
    expect(r.errore).toMatchObject({ code: 'XX000' })
    expect(r.valore.get(CLASSE_1)).toEqual([])
  })

  it('un errore sui legami → completo false (l’elenco può essere corto), ma ciò che si è letto resta', async () => {
    const db = dbBase()
    db.student_parents.push({ student_id: AL(2), parent_id: uuid('e0000000', 3) })
    db.parents.push({ id: uuid('e0000000', 3), auth_user_id: G_VERDI })
    const r = await genitoriDelleClassi(
      leggi(db, { errori: { legame_genitori_alunni: { code: 'XX000' } } }),
      SEDE_A,
      [CLASSE_1],
    )
    expect(r.completo).toBe(false)
    // Mai `completo: false` senza un errore da passare alla risposta: la route ne ha bisogno.
    expect(r.errore).not.toBeNull()
    expect(r.valore.get(CLASSE_1)!.map((g) => g.utenteId)).toEqual([G_VERDI])
  })

  it('un errore sui nomi → completo false', async () => {
    const r = await genitoriDelleClassi(leggi(dbBase(), { errori: { utenti: { code: 'XX000' } } }), SEDE_A, [CLASSE_1])
    expect(r.completo).toBe(false)
    expect(r.errore).toMatchObject({ code: 'XX000' })
  })

  it('con un guasto lascia UNA riga di log del canale `votazioni`, senza nomi né uuid di bambini', async () => {
    await genitoriDelleClassi(leggi(dbBase(), { errori: { alunni: { code: 'XX000' } } }), SEDE_A, [CLASSE_1])
    const chiamate = [...h.logEvento.mock.calls, ...h.logErrore.mock.calls]
    expect(chiamate.length).toBeGreaterThan(0)
    const testo = JSON.stringify(chiamate)
    expect(testo).toContain('votazioni')
    expect(testo).not.toContain(AL(1))
    expect(testo).not.toContain('Rossi')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('genitoriDellaSede', () => {
  it('l’unione dei genitori di tutte le classi della sede, senza doppioni, in ordine di cognome', async () => {
    const r = await genitoriDellaSede(leggi(dbBase()), SEDE_A)
    expect(r.completo).toBe(true)
    expect(nomi(r.valore)).toEqual(['Bianchi Luca', 'Rossi Anna'])
  })

  it('le classi vengono da `sections` per `scuola_id`: la sede B non vede i genitori della A, e viceversa', async () => {
    const db = dbBase()
    db.alunni.push(alunno(AL(20), CLASSE_3, { scuola_id: SEDE_B }))
    db.legame_genitori_alunni.push(legame(AL(20), G_ALTRA_SEDE))
    const a = await genitoriDellaSede(leggi(db), SEDE_A)
    const b = await genitoriDellaSede(leggi(db), SEDE_B)
    expect(a.valore.map((g) => g.utenteId)).not.toContain(G_ALTRA_SEDE)
    expect(b.valore.map((g) => g.utenteId)).toEqual([G_ALTRA_SEDE])
  })

  it('una sede senza classi → elenco vuoto e completo', async () => {
    const db = dbBase()
    db.sections = []
    const r = await genitoriDellaSede(leggi(db), SEDE_A)
    expect(r).toEqual({ valore: [], completo: true, errore: null })
  })

  it('stesse regole delle classi: inattivo escluso, docente-genitore incluso, archiviato escluso', async () => {
    const db = dbBase()
    db.alunni.push(
      alunno(AL(21), CLASSE_2),
      alunno(AL(22), CLASSE_2),
      alunno(AL(23), CLASSE_2, { archiviato_il: '2026-09-01T00:00:00.000Z' }),
    )
    db.legame_genitori_alunni.push(legame(AL(21), G_INATTIVO), legame(AL(22), G_DOCENTE), legame(AL(23), G_VERDI))
    const r = await genitoriDellaSede(leggi(db), SEDE_A)
    const ids = r.valore.map((g) => g.utenteId)
    expect(ids).not.toContain(G_INATTIVO)
    expect(ids).toContain(G_DOCENTE)
    expect(ids).not.toContain(G_VERDI)
  })

  it('un errore sulle classi → completo false, errore valorizzato, elenco vuoto', async () => {
    const r = await genitoriDellaSede(leggi(dbBase(), { errori: { sections: { code: 'XX000' } } }), SEDE_A)
    expect(r.completo).toBe(false)
    expect(r.errore).toMatchObject({ code: 'XX000' })
    expect(r.valore).toEqual([])
  })

  it('un errore sugli alunni si propaga: completo false', async () => {
    const r = await genitoriDellaSede(leggi(dbBase(), { errori: { alunni: { code: 'XX000' } } }), SEDE_A)
    expect(r.completo).toBe(false)
    expect(r.errore).toMatchObject({ code: 'XX000' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('figliAttiviConClasse e `section_id` in getFigliAttiviDiGenitore', () => {
  it('getFigliAttiviDiGenitore restituisce `section_id` di ogni figlio (il contratto aggiunto in legami.ts)', async () => {
    const esito = await getFigliAttiviDiGenitore(leggi(dbBase()), G_ROSSI)
    const perId = new Map(esito.righe.map((r) => [r.id, r.section_id]))
    expect(perId.get(AL(1))).toBe(CLASSE_1)
    expect(perId.get(AL(2))).toBe(CLASSE_1)
    expect(perId.get(AL(3))).toBe(CLASSE_2)
  })

  it('i figli attivi con classe e sede, nella forma del contratto', async () => {
    const r = await figliAttiviConClasse(leggi(dbBase()), G_ROSSI)
    expect(r.completo).toBe(true)
    expect(r.errore).toBeNull()
    expect([...r.valore].sort((a, b) => a.alunnoId.localeCompare(b.alunnoId))).toEqual([
      { alunnoId: AL(1), sectionId: CLASSE_1, scuolaId: SEDE_A },
      { alunnoId: AL(2), sectionId: CLASSE_1, scuolaId: SEDE_A },
      { alunnoId: AL(3), sectionId: CLASSE_2, scuolaId: SEDE_A },
    ])
  })

  it('l’alunno archiviato e quello ritirato non sono un figlio “attivo”: la scheda non nasce', async () => {
    const db = dbBase()
    db.alunni.push(
      alunno(AL(30), CLASSE_1, { archiviato_il: '2026-09-01T00:00:00.000Z' }),
      alunno(AL(31), CLASSE_1, { stato: 'ritirato' }),
    )
    db.legame_genitori_alunni.push(legame(AL(30), G_VERDI), legame(AL(31), G_VERDI))
    const r = await figliAttiviConClasse(leggi(db), G_VERDI)
    expect(r.valore).toEqual([])
  })

  it('un figlio senza classe non genera nessuna scheda', async () => {
    const db = dbBase()
    db.alunni.push(alunno(AL(32), null))
    db.legame_genitori_alunni.push(legame(AL(32), G_NERI))
    const r = await figliAttiviConClasse(leggi(db), G_NERI)
    expect(r.valore).toEqual([])
  })

  it('un genitore senza figli → elenco vuoto e completo', async () => {
    const r = await figliAttiviConClasse(leggi(dbBase()), G_VERDI)
    expect(r).toEqual({ valore: [], completo: true, errore: null })
  })

  it('un errore sulla lettura degli alunni → completo false e l’errore, mai “nessun figlio” travestito da risposta', async () => {
    const r = await figliAttiviConClasse(leggi(dbBase(), { errori: { alunni: { code: 'XX000' } } }), G_ROSSI)
    expect(r.completo).toBe(false)
    expect(r.errore).toMatchObject({ code: 'XX000' })
    expect(r.valore).toEqual([])
  })
})
