/**
 * `annullaAppelloAlunno` — il bambino torna a «da registrare» (spec 2026-09-24, punto 6).
 *
 * Il finto di Supabase qui sotto NON restituisce sempre la stessa cosa: registra
 * ogni operazione (tabella, verbo, filtri, payload) e risponde secondo la riga
 * configurata. Le asserzioni guardano COSA viene scritto e CON QUALI filtri, non
 * solo l'esito: un'implementazione che cancellasse sempre la riga, o che
 * dimenticasse la revoca dell'avviso, farebbe rosso qui.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore }))

import { annullaAppelloAlunno } from '@/lib/presenze/annulla-appello'
import type { AppUser } from '@/lib/auth/require-staff'

type Filtro = [string, ...unknown[]]
interface Operazione {
  tabella: string
  verbo: 'select' | 'update' | 'delete'
  colonne?: string
  payload?: Record<string, unknown>
  filtri: Filtro[]
}

const DOCENTE = 'd0000000-0000-4000-8000-0000000000d1'
const GENITORE = 'e0000000-0000-4000-8000-0000000000e1'
const ALUNNO = '11111111-1111-4111-8111-111111111111'
const SEDE = 'aaaa0000-0000-4000-8000-00000000a001'
const SEZIONE = 'bbbb0000-0000-4000-8000-00000000b001'
const PRESENZA = 'cccc0000-0000-4000-8000-00000000c001'
const GIORNO = '2026-09-25'

const attore = { id: DOCENTE, role: 'educator', scuola_id: SEDE } as unknown as AppUser

/** Stato del finto: cosa risponde ciascuna operazione. */
let rigaLetta: Record<string, unknown> | null
let erroreLettura: unknown
let erroreScrittura: unknown
let righeScritte: number
let erroreRevoca: unknown
let operazioni: Operazione[]

function finto() {
  return {
    from(tabella: string) {
      const op: Operazione = { tabella, verbo: 'select', filtri: [] }
      operazioni.push(op)
      const risultatoScrittura = () => {
        if (tabella === 'notifiche') return { data: null, error: erroreRevoca }
        if (erroreScrittura) return { data: null, error: erroreScrittura }
        const base = { ...(rigaLetta ?? {}), ...(op.payload ?? {}) }
        return { data: Array.from({ length: righeScritte }, () => base), error: null }
      }
      const qb: Record<string, unknown> = {
        select(colonne: string) {
          if (op.verbo === 'select') op.colonne = colonne
          return qb
        },
        update(payload: Record<string, unknown>) {
          op.verbo = 'update'
          op.payload = payload
          return qb
        },
        delete() {
          op.verbo = 'delete'
          return qb
        },
        eq: (...a: unknown[]) => { op.filtri.push(['eq', ...a]); return qb },
        is: (...a: unknown[]) => { op.filtri.push(['is', ...a]); return qb },
        not: (...a: unknown[]) => { op.filtri.push(['not', ...a]); return qb },
        maybeSingle: async () => ({ data: rigaLetta, error: erroreLettura }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(risultatoScrittura()).then(res, rej),
      }
      return qb
    },
  }
}

const riga = (extra: Record<string, unknown> = {}) => ({
  id: PRESENZA,
  alunno_id: ALUNNO,
  data: GIORNO,
  stato: 'presente',
  orario_entrata: '2026-09-25T06:45:00.000Z',
  orario_uscita: null,
  registrato_da: DOCENTE,
  giustificata_da: null,
  scuola_id: SEDE,
  section_id: SEZIONE,
  ...extra,
})

const annulla = () =>
  annullaAppelloAlunno(finto() as never, { alunnoId: ALUNNO, data: GIORNO, attore, operazione: 'test:DELETE' })

const scritture = (tabella: string) => operazioni.filter((o) => o.tabella === tabella && o.verbo !== 'select')

beforeEach(() => {
  vi.clearAllMocks()
  rigaLetta = riga()
  erroreLettura = null
  erroreScrittura = null
  erroreRevoca = null
  righeScritte = 1
  operazioni = []
  h.logScrittura.mockResolvedValue(undefined)
})

describe('la lettura che decide', () => {
  it('cerca la riga per alunno E giorno, e non chiede motivo, firma o nota interna', async () => {
    await annulla()
    const lettura = operazioni[0]
    expect(lettura.tabella).toBe('presenze')
    expect(lettura.verbo).toBe('select')
    expect(lettura.filtri).toEqual(expect.arrayContaining([['eq', 'alunno_id', ALUNNO], ['eq', 'data', GIORNO]]))
    expect(lettura.colonne).not.toMatch(/giustificazione_testo|giustificazione_firma|note_appello/)
  })

  it('nessuna riga → `non-trovata`, e niente viene scritto né revocato', async () => {
    rigaLetta = null
    expect(await annulla()).toEqual({ esito: 'non-trovata' })
    expect(operazioni).toHaveLength(1)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('`registrato_da` null (c\'è solo la comunicazione del genitore) → `niente-da-annullare`', async () => {
    rigaLetta = riga({ registrato_da: null, stato: 'assente', giustificata_da: GENITORE })
    expect(await annulla()).toEqual({ esito: 'niente-da-annullare' })
    expect(operazioni).toHaveLength(1)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('lettura FALLITA → `errore`, mai `non-trovata`', async () => {
    rigaLetta = null
    erroreLettura = { code: '42501', message: 'permission denied' }
    expect(await annulla()).toEqual({ esito: 'errore', fase: 'lettura' })
    expect(h.logErrore).toHaveBeenCalledTimes(1)
    expect(operazioni).toHaveLength(1)
  })
})

describe('appello senza comunicazione del genitore → la riga si CANCELLA', () => {
  it('DELETE della riga letta, filtrata per id e per la sede della riga, con la condizione ripetuta', async () => {
    const r = await annulla()
    expect(r).toMatchObject({ esito: 'cancellata', presenza: null, presenzaId: PRESENZA, avvisoRitirato: true })

    const [del] = scritture('presenze')
    expect(del.verbo).toBe('delete')
    expect(del.filtri).toEqual(expect.arrayContaining([
      ['eq', 'id', PRESENZA],
      ['eq', 'scuola_id', SEDE],
      // mai cancellare una comunicazione del genitore arrivata dopo la lettura
      ['is', 'giustificata_da', null],
      // né una riga il cui appello è stato annullato nel frattempo da un'altra mano
      ['not', 'registrato_da', 'is', null],
    ]))
  })

  it('audit `delete` con la fotografia di prima e nessun «dopo»', async () => {
    await annulla()
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const arg = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(arg).toMatchObject({
      entitaTipo: 'presenze', entitaId: PRESENZA, azione: 'delete', scuolaId: SEDE, sectionId: SEZIONE, valoreDopo: null,
    })
    expect(arg.valorePrima).toMatchObject({ stato: 'presente', registrato_da: DOCENTE, comunicazione_genitore: false })
    expect((arg.attore as { id: string }).id).toBe(DOCENTE)
  })

  it('0 righe cancellate (il genitore ha comunicato nel frattempo) → `cambiata-nel-frattempo`, nessuna revoca né audit', async () => {
    righeScritte = 0
    expect(await annulla()).toEqual({ esito: 'cambiata-nel-frattempo' })
    expect(scritture('notifiche')).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })
})

describe('appello sopra una comunicazione del genitore → si TORNA alla comunicazione', () => {
  beforeEach(() => {
    rigaLetta = riga({ stato: 'presente', giustificata_da: GENITORE })
  })

  it('UPDATE, non DELETE: stato assente, registrato_da / orari / nota interna a null', async () => {
    const r = await annulla()
    expect(r.esito).toBe('ripristinata-comunicazione')

    const [upd] = scritture('presenze')
    expect(upd.verbo).toBe('update')
    expect(upd.payload).toMatchObject({
      stato: 'assente', registrato_da: null, orario_entrata: null, orario_uscita: null, note_appello: null,
    })
    expect(typeof upd.payload?.aggiornato_il).toBe('string')
    expect(upd.filtri).toEqual(expect.arrayContaining([
      ['eq', 'id', PRESENZA],
      ['eq', 'scuola_id', SEDE],
      // la condizione che ha scelto il ramo si ripete nella scrittura (corsa)
      ['not', 'registrato_da', 'is', null],
    ]))
  })

  it('i campi della comunicazione NON compaiono nell\'update: restano intatti', async () => {
    await annulla()
    const chiavi = Object.keys(scritture('presenze')[0].payload ?? {})
    for (const k of chiavi) {
      expect(k).not.toMatch(/^giustificat|^giustificazione_|^giust_vista_/)
    }
  })

  it('restituisce la riga ripristinata, con le sole sei colonne dell\'appello', async () => {
    const r = await annulla()
    if (r.esito !== 'ripristinata-comunicazione') throw new Error(r.esito)
    expect(r.presenza).toMatchObject({ id: PRESENZA, stato: 'assente', orario_entrata: null })
  })

  it('audit `update` prima/dopo', async () => {
    await annulla()
    const arg = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(arg.azione).toBe('update')
    expect(arg.valorePrima).toMatchObject({ stato: 'presente', registrato_da: DOCENTE, comunicazione_genitore: true })
    expect(arg.valoreDopo).toMatchObject({ stato: 'assente', registrato_da: null, orario_entrata: null })
  })

  it('0 righe aggiornate → `cambiata-nel-frattempo`', async () => {
    righeScritte = 0
    expect(await annulla()).toEqual({ esito: 'cambiata-nel-frattempo' })
    expect(h.logScrittura).not.toHaveBeenCalled()
  })
})

describe('l\'avviso di assenza ancora in coda', () => {
  it.each([
    ['cancellata', riga()],
    ['ripristinata-comunicazione', riga({ giustificata_da: GENITORE })],
  ])('%s → ritira SOLO l\'avviso non ancora spedito di questo alunno', async (_esito, r) => {
    rigaLetta = r
    await annulla()
    const [rev] = scritture('notifiche')
    expect(rev.verbo).toBe('delete')
    expect(rev.filtri).toEqual(expect.arrayContaining([
      ['eq', 'tipo', 'assenza_non_comunicata'],
      ['eq', 'entita_id', ALUNNO],
      ['is', 'push_inviata_il', null],
    ]))
  })

  it('la revoca viene DOPO la scrittura riuscita', async () => {
    await annulla()
    const i = operazioni.findIndex((o) => o.tabella === 'notifiche')
    const j = operazioni.findIndex((o) => o.tabella === 'presenze' && o.verbo === 'delete')
    expect(j).toBeGreaterThan(-1)
    expect(i).toBeGreaterThan(j)
  })

  it('revoca fallita: l\'annullamento resta riuscito, ma si logga a `error` e lo si dice', async () => {
    erroreRevoca = { code: '57014', message: 'timeout' }
    const r = await annulla()
    expect(r).toMatchObject({ esito: 'cancellata', avvisoRitirato: false })
    expect(h.logEvento).toHaveBeenCalledWith(
      'notifica', 'error', expect.objectContaining({ esito: 'revoca-assenza-fallita' }), erroreRevoca,
    )
  })
})

describe('errori di scrittura e log', () => {
  it('scrittura fallita → `errore` di scrittura, nessuna revoca, nessun audit', async () => {
    erroreScrittura = { code: '23503', message: 'fk' }
    expect(await annulla()).toEqual({ esito: 'errore', fase: 'scrittura' })
    expect(h.logErrore).toHaveBeenCalledTimes(1)
    expect(scritture('notifiche')).toHaveLength(0)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('il successo si logga, con soli uuid ed enumerati', async () => {
    await annulla()
    const info = h.logEvento.mock.calls.find((c) => c[1] === 'info')
    expect(info?.[2]).toMatchObject({
      operazione: 'test:DELETE', esito: 'appello-annullato', tipo: 'cancellata', alunno_id: ALUNNO, presenza_id: PRESENZA,
    })
  })
})
