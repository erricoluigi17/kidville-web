import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))

vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import {
  ammessoAllIstituto,
  ammessoInClasse,
  candidatiDellaClasse,
  leggiAmmissione,
} from '@/lib/votazioni/ammissione-genitore'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto, type Riga } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'

/**
 * L'AMMISSIONE DI UN GENITORE, PROVATA CON UN DATABASE CHE FILTRA DAVVERO.
 *
 * È la regola che il GET (la scheda) e il POST (il voto) condividono: se i due giudicassero in modo
 * diverso, il genitore vedrebbe una scheda e poi si vedrebbe rifiutare il voto. Qui si prova la regola
 * una volta sola, sui dati; le due route la provano ognuna per conto proprio sulle risposte.
 *
 * Solo dati finti: uuid inventati e cognomi di fantasia.
 */

const uuid = (prefisso: string, n: number) => `${prefisso}-0000-4000-8000-${String(n).padStart(12, '0')}`

const CLASSE_A1 = uuid('c1000000', 1)
const CLASSE_A2 = uuid('c2000000', 2)
const CLASSE_A3 = uuid('c3000000', 3) // in cui l'elettore NON ha figli
const CLASSE_B1 = uuid('c4000000', 4) // della sede B

const ELETTORE = uuid('a0000000', 1)
const COLLEGA = uuid('a0000000', 2) // genitore nella stessa classe A1
const ALTRO = uuid('a0000000', 3) // genitore nella classe A3
const INATTIVO = uuid('a0000000', 4) // genitore nella classe A1 con account disattivato

const AL = (n: number) => uuid('b0000000', n)

const utente = (id: string, cognome: string, nome: string, extra: Riga = {}): Riga => ({
  id,
  cognome,
  nome,
  ruolo: 'genitore',
  attivo: true,
  ...extra,
})

const alunno = (id: string, section_id: string, scuola_id: string, extra: Riga = {}): Riga => ({
  id,
  scuola_id,
  section_id,
  stato: 'iscritto',
  archiviato_il: null,
  nome: 'Bimbo',
  cognome: 'Finto',
  classe_sezione: 'CLASSE',
  ...extra,
})

const legame = (alunno_id: string, genitore_id: string): Riga => ({ alunno_id, genitore_id })

function dbBase(): DBFinto {
  return {
    sections: [
      { id: CLASSE_A1, scuola_id: SEDE_A, name: '2 ANNI' },
      { id: CLASSE_A2, scuola_id: SEDE_A, name: '3 ANNI' },
      { id: CLASSE_A3, scuola_id: SEDE_A, name: '4 ANNI' },
      { id: CLASSE_B1, scuola_id: SEDE_B, name: '2 ANNI' },
    ],
    alunni: [
      alunno(AL(1), CLASSE_A1, SEDE_A),
      alunno(AL(2), CLASSE_A1, SEDE_A), // secondo figlio dell'elettore nella STESSA classe
      alunno(AL(3), CLASSE_A2, SEDE_A),
      alunno(AL(4), CLASSE_A3, SEDE_A),
      alunno(AL(5), CLASSE_B1, SEDE_B),
      alunno(AL(6), CLASSE_A1, SEDE_A), // figlio del collega e dell'inattivo
    ],
    legame_genitori_alunni: [
      legame(AL(1), ELETTORE),
      legame(AL(2), ELETTORE),
      legame(AL(3), ELETTORE),
      legame(AL(5), ELETTORE),
      legame(AL(6), COLLEGA),
      legame(AL(6), INATTIVO),
      legame(AL(4), ALTRO),
    ],
    student_parents: [],
    parents: [],
    utenti: [
      utente(ELETTORE, 'Rossi', 'Anna'),
      utente(COLLEGA, 'Bianchi', 'Luca'),
      utente(ALTRO, 'Verdi', 'Marta'),
      utente(INATTIVO, 'Inattivi', 'Ida', { attivo: false }),
    ],
  }
}

const leggi = (db: DBFinto, opzioni: OpzioniFinto = {}) => creaFintoSupabase(db, [], opzioni)
const nomi = (genitori: { nome: string }[]) => genitori.map((g) => g.nome)

beforeEach(() => {
  h.logEvento.mockClear()
  h.logErrore.mockClear()
})

describe('leggiAmmissione: da chi parte e che cosa legge', () => {
  it('parte dai figli: le sedi e le classi sono quelle dei figli, e le classi di una sede stanno insieme', async () => {
    const esito = await leggiAmmissione(leggi(dbBase()), ELETTORE)
    expect(esito.completo).toBe(true)
    expect(esito.errore).toBeNull()
    expect([...esito.valore.sedi].sort()).toEqual([SEDE_A, SEDE_B].sort())
    // Due figli nella stessa classe sono UNA classe.
    expect([...(esito.valore.classiDeiFigli.get(SEDE_A) ?? [])].sort()).toEqual([CLASSE_A1, CLASSE_A2].sort())
    expect(esito.valore.classiDeiFigli.get(SEDE_B)).toEqual([CLASSE_B1])
  })

  it('non legge la classe in cui l\'elettore non ha figli, e nemmeno tutta la sede', async () => {
    const letture: string[] = []
    const client = creaFintoSupabase(dbBase(), letture)
    await leggiAmmissione(client, ELETTORE, { sedi: [SEDE_A] })
    // `sections` (le classi della sede) non si legge mai: serve solo a `genitoriDellaSede`.
    expect(letture).not.toContain('sections')
  })

  it('la classe A3 (senza figli suoi) non entra nell\'ammissione: la sua lista di genitori non si legge', async () => {
    const esito = await leggiAmmissione(leggi(dbBase()), ELETTORE, { sedi: [SEDE_A] })
    const perClasse = esito.valore.genitori.get(SEDE_A)
    expect(perClasse?.has(CLASSE_A3)).toBe(false)
    expect(perClasse?.has(CLASSE_A1)).toBe(true)
  })

  it('un elettore senza figli non ha sedi né classi e il database non viene interrogato per le classi', async () => {
    const letture: string[] = []
    const esito = await leggiAmmissione(creaFintoSupabase(dbBase(), letture), uuid('ffffffff', 1))
    expect(esito.completo).toBe(true)
    expect(esito.valore.sedi).toEqual([])
    expect(letture).not.toContain('utenti')
  })

  it('un alunno ritirato non dà né una classe né un diritto', async () => {
    const db = dbBase()
    for (const a of db.alunni) if (a.id === AL(3)) a.stato = 'ritirato'
    const esito = await leggiAmmissione(leggi(db), ELETTORE, { sedi: [SEDE_A] })
    expect(esito.valore.classiDeiFigli.get(SEDE_A)).toEqual([CLASSE_A1])
    expect(ammessoInClasse(esito.valore, SEDE_A, CLASSE_A2)).toBe(false)
  })

  it('un figlio sospeso per morosità conta come tutti gli altri', async () => {
    const db = dbBase()
    for (const a of db.alunni) if (a.id === AL(3)) a.stato = 'sospeso'
    const esito = await leggiAmmissione(leggi(db), ELETTORE, { sedi: [SEDE_A] })
    expect(ammessoInClasse(esito.valore, SEDE_A, CLASSE_A2)).toBe(true)
  })

  it('usa i figli già letti da chi chiama, senza rileggerli', async () => {
    const esito = await leggiAmmissione(leggi(dbBase()), ELETTORE, {
      figli: [{ alunnoId: AL(1), sectionId: CLASSE_A1, scuolaId: SEDE_A }],
    })
    expect(esito.valore.sedi).toEqual([SEDE_A])
    expect(ammessoInClasse(esito.valore, SEDE_A, CLASSE_A1)).toBe(true)
    // Nel database ha un figlio anche in A2 e in B1, ma ha in mano solo quel figlio: se rileggesse i figli,
    // A2 comparirebbe. Non compare, quindi non li ha riletti.
    expect(ammessoInClasse(esito.valore, SEDE_A, CLASSE_A2)).toBe(false)
    expect(esito.valore.sedi).not.toContain(SEDE_B)
  })

  it('le opzioni `classi` e `sedi` restringono quello che si legge', async () => {
    const esito = await leggiAmmissione(leggi(dbBase()), ELETTORE, { sedi: [SEDE_A], classi: [CLASSE_A2] })
    expect([...esito.valore.genitori.keys()]).toEqual([SEDE_A])
    expect([...(esito.valore.genitori.get(SEDE_A)?.keys() ?? [])]).toEqual([CLASSE_A2])
    expect(ammessoInClasse(esito.valore, SEDE_A, CLASSE_A1)).toBe(false)
  })

  it('una classe chiesta che non è fra quelle dei figli non si legge nemmeno', async () => {
    const esito = await leggiAmmissione(leggi(dbBase()), ELETTORE, { sedi: [SEDE_A], classi: [CLASSE_A3] })
    expect(ammessoInClasse(esito.valore, SEDE_A, CLASSE_A3)).toBe(false)
    expect(esito.valore.genitori.get(SEDE_A)?.size ?? 0).toBe(0)
  })

  it('l\'uuid in maiuscolo non cambia niente', async () => {
    const esito = await leggiAmmissione(leggi(dbBase()), ELETTORE.toUpperCase(), { sedi: [SEDE_A.toUpperCase()] })
    expect(ammessoInClasse(esito.valore, SEDE_A.toUpperCase(), CLASSE_A1.toUpperCase())).toBe(true)
  })
})

describe('le due regole: classe e istituto', () => {
  it('classe: ammesso se compare fra i genitori di QUELLA classe', async () => {
    const { valore } = await leggiAmmissione(leggi(dbBase()), ELETTORE)
    expect(ammessoInClasse(valore, SEDE_A, CLASSE_A1)).toBe(true)
    expect(ammessoInClasse(valore, SEDE_A, CLASSE_A2)).toBe(true)
    expect(ammessoInClasse(valore, SEDE_B, CLASSE_B1)).toBe(true)
    // La classe in cui ha figli un altro genitore, e quella di un'altra sede con lo stesso nome.
    expect(ammessoInClasse(valore, SEDE_A, CLASSE_A3)).toBe(false)
    // E la classe giusta nella sede sbagliata.
    expect(ammessoInClasse(valore, SEDE_B, CLASSE_A1)).toBe(false)
  })

  it('i candidati di una classe sono TUTTI i genitori della classe, lui compreso, e solo se è ammesso', async () => {
    const { valore } = await leggiAmmissione(leggi(dbBase()), ELETTORE)
    expect(nomi(candidatiDellaClasse(valore, SEDE_A, CLASSE_A1))).toEqual(['Bianchi Luca', 'Rossi Anna'])
    // L'account disattivato non è un candidato.
    expect(nomi(candidatiDellaClasse(valore, SEDE_A, CLASSE_A1))).not.toContain('Inattivi Ida')
    // Non è ammesso nella classe A3: la lista dei suoi genitori non gli arriva.
    expect(candidatiDellaClasse(valore, SEDE_A, CLASSE_A3)).toEqual([])
  })

  it('istituto: ammesso se compare nell\'unione delle classi dei suoi figli in QUELLA sede', async () => {
    const { valore } = await leggiAmmissione(leggi(dbBase()), ELETTORE)
    expect(ammessoAllIstituto(valore, SEDE_A)).toBe(true)
    expect(ammessoAllIstituto(valore, SEDE_B)).toBe(true)
    expect(ammessoAllIstituto(valore, uuid('eeeeeeee', 9))).toBe(false)
  })

  it('istituto: chi ha figli solo nella sede A non vota per la sede B', async () => {
    const { valore } = await leggiAmmissione(leggi(dbBase()), ALTRO)
    expect(ammessoAllIstituto(valore, SEDE_A)).toBe(true)
    expect(ammessoAllIstituto(valore, SEDE_B)).toBe(false)
  })

  it('un account disattivato non è ammesso da nessuna parte', async () => {
    const { valore } = await leggiAmmissione(leggi(dbBase()), INATTIVO)
    expect(ammessoInClasse(valore, SEDE_A, CLASSE_A1)).toBe(false)
    expect(ammessoAllIstituto(valore, SEDE_A)).toBe(false)
  })

  it('un docente-genitore (riga utenti con ruolo docente) è ammesso come tutti', async () => {
    const db = dbBase()
    for (const u of db.utenti) if (u.id === ELETTORE) u.ruolo = 'docente'
    const { valore } = await leggiAmmissione(leggi(db), ELETTORE)
    expect(ammessoInClasse(valore, SEDE_A, CLASSE_A1)).toBe(true)
  })
})

describe('l\'errore non è un "non ammesso"', () => {
  it('lettura dei nomi fallita: completo=false con l\'errore, e nessun diritto negato per silenzio', async () => {
    const esito = await leggiAmmissione(leggi(dbBase(), { errori: { 'utenti:select': { code: 'XX000' } } }), ELETTORE)
    expect(esito.completo).toBe(false)
    expect(esito.errore).not.toBeNull()
  })

  it('lettura dei figli fallita: completo=false con l\'errore e nessuna sede', async () => {
    const esito = await leggiAmmissione(
      leggi(dbBase(), { errori: { 'legame_genitori_alunni:select': { code: 'XX000' } } }),
      ELETTORE,
    )
    expect(esito.completo).toBe(false)
    expect(esito.errore).not.toBeNull()
    expect(esito.valore.sedi).toEqual([])
  })

  it('completo=false implica errore valorizzato', async () => {
    const esito = await leggiAmmissione(leggi(dbBase(), { errori: { 'alunni:select': { code: 'XX000' } } }), ELETTORE)
    if (!esito.completo) expect(esito.errore).not.toBeNull()
    expect(esito.completo).toBe(false)
  })
})
