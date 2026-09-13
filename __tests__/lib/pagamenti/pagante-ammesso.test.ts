import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// `pagantiAmmessiPerAlunni` — CHI PUÒ ESSERE IL PAGANTE, IN UN POSTO SOLO.
//
// Il modulo è nato il 2026-09-13 come SEDE della regola, mentre la rotta gemella
// (`pagamenti/riconciliazione/[id]/contesto:GET`) ne teneva una seconda copia
// perché era in verifica. Fino a questo file il modulo non aveva **nessun test
// proprio**: l'unico presidio era il comportamento delle due rotte che lo
// chiamano — cioè la regola condivisa era sorvegliata solo di rimbalzo, e una
// modifica al modulo poteva rompere la rotta che NON si stava guardando.
//
// Qui si collauda il modulo direttamente, e in particolare le due cose che la
// rotta `contesto` gli chiede in più dell'insieme: le COPPIE (genitore, bambino)
// — che sono ciò da cui `scegliPaganteComune` decide — e la RELAZIONE
// dell'anagrafica, che è ciò che la schermata mostra accanto al nome.
//
// ⚠️ `parentIds` NON è calcolato a parte: è derivato dalle coppie. È la sola
// forma in cui i due non possono divergere — ed è il difetto che questa fetta
// esiste per chiudere, alla scala di una funzione.
// ─────────────────────────────────────────────────────────────────────────────

type Riga = Record<string, unknown>
type ErrDb = { code?: string; message?: string } | null

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  /** `student_parents` — il ponte ANAGRAFICO: dà già il `parents.id`. */
  studentParents: [] as Riga[],
  studentParentsError: null as ErrDb,
  /** `legame_genitori_alunni` — il ponte RUNTIME: dà l'ACCOUNT, non il `parents.id`. */
  legamiRuntime: [] as Riga[],
  legamiRuntimeError: null as ErrDb,
  /** `parents` — le due letture: per `id` (dentro l'helper) e per `auth_user_id` (il ponte). */
  parents: [] as Riga[],
  /** Errore sulla sola lettura FILTRATA PER `auth_user_id`, che è il ponte del modulo. */
  ponteError: null as ErrDb,
  letture: [] as { tabella: string; colonne: string; filtri: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento,
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

/**
 * Il finto applica DAVVERO i filtri `.in()`, e non è un vezzo di fedeltà: senza,
 * ogni riga della fixture tornerebbe a qualunque query e «il ponte ha trovato
 * questo genitore» sarebbe indistinguibile da «gliel'ha passato il finto».
 * Stessa scelta, e stessa ragione, del finto di `…-contesto.test.ts`.
 */
function fakeSupabase() {
  return {
    from(tabella: string) {
      const filtri: Record<string, unknown> = {}
      let colonne = ''
      const b: Record<string, unknown> = {}
      b.select = (c?: string) => { colonne = c ?? ''; return b }
      b.in = (col: string, v: unknown) => { filtri[col] = v; return b }
      b.eq = (col: string, v: unknown) => { filtri[col] = v; return b }
      const sorgente = (): { data: Riga[] | null; error: ErrDb } => {
        if (tabella === 'student_parents') {
          return { data: h.studentParents, error: h.studentParentsError }
        }
        if (tabella === 'legame_genitori_alunni') {
          return { data: h.legamiRuntime, error: h.legamiRuntimeError }
        }
        if (tabella === 'parents') {
          // Le due letture su `parents` si distinguono per FILTRO: `auth_user_id`
          // è il ponte del modulo, `id` è quella interna a `getGenitoriDiAlunniEsito`.
          if ('auth_user_id' in filtri) return { data: h.parents, error: h.ponteError }
          return { data: h.parents, error: null }
        }
        return { data: [], error: null }
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        h.letture.push({ tabella, colonne, filtri: { ...filtri } })
        const r = sorgente()
        if (r.error) return resolve({ data: null, error: r.error })
        const passa = (riga: Riga) =>
          Object.entries(filtri).every(([col, atteso]) =>
            Array.isArray(atteso) ? atteso.includes(riga[col]) : riga[col] === atteso,
          )
        return resolve({ data: (r.data ?? []).filter(passa), error: null })
      }
      return b
    },
  }
}

import { pagantiAmmessiPerAlunni } from '@/lib/pagamenti/pagante-ammesso'

const BIMBO_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const BIMBO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
/** Il genitore che sta nell'ANAGRAFICA: 81 legami veri, in produzione, stanno solo lì. */
const PARENT_ANAGRAFICA = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
/** Il genitore che sta nel SOLO runtime: 4 legami veri, in produzione, stanno solo lì. */
const PARENT_RUNTIME = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
const ACCOUNT_RUNTIME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
/** Una famiglia che con questi bambini non c'entra niente. */
const PARENT_ESTRANEO = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9'
const BIMBO_ESTRANEO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9'

const chiama = (alunni: (string | null | undefined)[]) =>
  pagantiAmmessiPerAlunni(fakeSupabase() as never, alunni, 'test:OP')

beforeEach(() => {
  h.logEvento.mockClear()
  h.studentParents = []
  h.studentParentsError = null
  h.legamiRuntime = []
  h.legamiRuntimeError = null
  h.parents = []
  h.ponteError = null
  h.letture = []
})

describe('pagantiAmmessiPerAlunni — l’UNIONE dei due ponti', () => {
  it('il genitore noto alla sola ANAGRAFICA è ammesso', async () => {
    h.studentParents = [{ parent_id: PARENT_ANAGRAFICA, student_id: BIMBO_A, relation_type: 'madre' }]
    const r = await chiama([BIMBO_A])
    expect([...r.parentIds]).toEqual([PARENT_ANAGRAFICA])
    expect(r.completo).toBe(true)
  })

  it('il genitore noto al solo RUNTIME è ammesso, passando per `parents.auth_user_id`', async () => {
    h.legamiRuntime = [{ alunno_id: BIMBO_A, genitore_id: ACCOUNT_RUNTIME }]
    h.parents = [{ id: PARENT_RUNTIME, auth_user_id: ACCOUNT_RUNTIME }]
    const r = await chiama([BIMBO_A])
    expect([...r.parentIds]).toEqual([PARENT_RUNTIME])
  })

  it('un genitore di UN ALTRO bambino non entra', async () => {
    h.studentParents = [
      { parent_id: PARENT_ANAGRAFICA, student_id: BIMBO_A, relation_type: 'madre' },
      { parent_id: PARENT_ESTRANEO, student_id: BIMBO_ESTRANEO, relation_type: 'madre' },
    ]
    const r = await chiama([BIMBO_A])
    expect([...r.parentIds]).toEqual([PARENT_ANAGRAFICA])
  })

  it('senza bambini non legge niente e l’insieme è vuoto ma COMPLETO', async () => {
    const r = await chiama([null, undefined, '', '   '])
    expect(r.parentIds.size).toBe(0)
    expect(r.completo).toBe(true)
    expect(h.letture).toEqual([])
  })
})

describe('pagantiAmmessiPerAlunni — le COPPIE, che sono ciò da cui si sceglie il pagante', () => {
  it('restituisce le coppie (genitore, bambino) delle DUE sorgenti, anagrafica prima', async () => {
    h.studentParents = [{ parent_id: PARENT_ANAGRAFICA, student_id: BIMBO_A, relation_type: 'madre' }]
    h.legamiRuntime = [{ alunno_id: BIMBO_B, genitore_id: ACCOUNT_RUNTIME }]
    h.parents = [{ id: PARENT_RUNTIME, auth_user_id: ACCOUNT_RUNTIME }]
    const r = await chiama([BIMBO_A, BIMBO_B])
    expect(r.legami).toEqual([
      { parent_id: PARENT_ANAGRAFICA, student_id: BIMBO_A },
      { parent_id: PARENT_RUNTIME, student_id: BIMBO_B },
    ])
  })

  it('🔑 `parentIds` è DERIVATO dalle coppie: i due non possono divergere', async () => {
    h.studentParents = [
      { parent_id: PARENT_ANAGRAFICA, student_id: BIMBO_A, relation_type: 'madre' },
      // lo stesso genitore su DUE figli: due coppie, un solo id
      { parent_id: PARENT_ANAGRAFICA, student_id: BIMBO_B, relation_type: 'madre' },
    ]
    h.legamiRuntime = [{ alunno_id: BIMBO_A, genitore_id: ACCOUNT_RUNTIME }]
    h.parents = [{ id: PARENT_RUNTIME, auth_user_id: ACCOUNT_RUNTIME }]
    const r = await chiama([BIMBO_A, BIMBO_B])
    expect(r.legami).toHaveLength(3)
    expect([...r.parentIds]).toEqual([...new Set(r.legami.map((l) => l.parent_id))])
  })

  it('una coppia senza uno dei due estremi non entra né fra le coppie né fra gli id', async () => {
    h.studentParents = [
      { parent_id: PARENT_ANAGRAFICA, student_id: null, relation_type: 'madre' },
      { parent_id: null, student_id: BIMBO_A, relation_type: 'madre' },
    ]
    const r = await chiama([BIMBO_A])
    expect(r.legami).toEqual([])
    expect(r.parentIds.size).toBe(0)
  })
})

describe('pagantiAmmessiPerAlunni — la RELAZIONE, che è ciò che la schermata mostra', () => {
  it('porta il `relation_type` dell’anagrafica', async () => {
    h.studentParents = [{ parent_id: PARENT_ANAGRAFICA, student_id: BIMBO_A, relation_type: 'padre' }]
    const r = await chiama([BIMBO_A])
    expect(r.relazioni.get(PARENT_ANAGRAFICA)).toBe('padre')
  })

  it('un genitore noto al SOLO runtime non ha relazione: `undefined`, non una inventata', async () => {
    h.legamiRuntime = [{ alunno_id: BIMBO_A, genitore_id: ACCOUNT_RUNTIME }]
    h.parents = [{ id: PARENT_RUNTIME, auth_user_id: ACCOUNT_RUNTIME }]
    const r = await chiama([BIMBO_A])
    expect(r.parentIds.has(PARENT_RUNTIME)).toBe(true)
    expect(r.relazioni.has(PARENT_RUNTIME)).toBe(false)
  })

  it('`relation_type` assente dalla riga vale `null`', async () => {
    h.studentParents = [{ parent_id: PARENT_ANAGRAFICA, student_id: BIMBO_A }]
    const r = await chiama([BIMBO_A])
    expect(r.relazioni.get(PARENT_ANAGRAFICA)).toBeNull()
  })
})

describe('pagantiAmmessiPerAlunni — `completo`, che è la differenza fra «non è» e «non so»', () => {
  it('un guasto vero dell’anagrafica abbassa `completo` e lascia un `warn`', async () => {
    h.studentParentsError = { code: '08006', message: 'connection failure' }
    const r = await chiama([BIMBO_A])
    expect(r.completo).toBe(false)
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'pagante-legami-anagrafica-non-letti',
    )
    expect(riga, 'una lettura fallita senza riga di log è un presidio spento').toBeDefined()
    expect(riga![1]).toBe('warn')
  })

  it('un guasto vero del PONTE abbassa `completo`', async () => {
    h.legamiRuntime = [{ alunno_id: BIMBO_A, genitore_id: ACCOUNT_RUNTIME }]
    h.ponteError = { code: '08006', message: 'connection failure' }
    const r = await chiama([BIMBO_A])
    expect(r.completo).toBe(false)
  })

  it('«schema assente» NON abbassa `completo`: sul DB E2E spegnerebbe il gate e basta', async () => {
    h.studentParentsError = { code: '42P01' }
    const r = await chiama([BIMBO_A])
    expect(r.completo).toBe(true)
  })

  it('nel log non entra nessun uuid di persona: solo conteggi, esito e codice', async () => {
    h.studentParentsError = { code: '08006' }
    await chiama([BIMBO_A])
    const contesti = h.logEvento.mock.calls.map((c) => JSON.stringify(c[2]))
    for (const c of contesti) {
      expect(c, `un uuid di persona nel contesto del log: ${c}`).not.toContain(PARENT_ANAGRAFICA)
      expect(c).not.toContain(BIMBO_A)
    }
  })
})
