import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, ErrorePostgrest } from '../fixtures/finto-supabase'

/**
 * ─── UN GUASTO DEL DATABASE NON DIVENTA «NESSUN VOTO» NÉ «NESSUNA FIRMA» ─────
 * (Fase 11 della roadmap di robustezza, «errori non ignorati» — 2026-10-19.)
 *
 * PostgREST non lancia: ritorna `{ data: null, error }`. Queste route leggevano
 * il solo `data`, e il `null` di un guasto diventava un VALORE:
 *
 *  · `parent/primaria/scrutinio:GET` — la firma di ricezione letta `null` era
 *    «non firmato» (`{ firmato: false }`: la UI riproponeva la firma OTP a chi
 *    aveva già firmato), e i giudizi letti `null` uscivano «—» su ogni materia;
 *  · `parent/primaria/pagella:GET` — le firme lette `null` mettevano ogni
 *    pagella a «da firmare»;
 *  · `parent/primaria:GET` — la sezione letta `null` dava `schoolType: null`
 *    con un 200, che `use-child-school-type` scrive in cache come risposta
 *    DETERMINATA; le valutazioni lette `null` erano «nessun voto»;
 *  · `primaria/scrutinio:GET` — i giudizi letti `null` erano una pagina dello
 *    scrutinio vuota, su cui la docente avrebbe riscritto;
 *  · `parent/mensa/allergie:GET` — l'alunno letto `null` era `pericolo: false`,
 *    cioè «il menu di oggi non contiene allergeni di tuo figlio» senza averli letti;
 *  · `push/subscribe:DELETE` — la cancellazione respinta rispondeva `success`.
 *
 * Ogni caso «guasto» qui sotto è stato visto ROSSO sul codice di prima (200 col
 * valore falso), e ha accanto il gemello sano che prova che il fixture regge:
 * senza il gemello un 500 potrebbe venire da un fixture rotto, non dal guasto.
 */

const SEDE = '10000000-0000-4000-8000-000000000001'
const SEZ = '20000000-0000-4000-8000-000000000002'
const ALUNNO = '30000000-0000-4000-8000-000000000003'
const GENITORE = '40000000-0000-4000-8000-000000000004'
const DOCENTE = '50000000-0000-4000-8000-000000000005'
const SCR = '60000000-0000-4000-8000-000000000006'
const PER = '70000000-0000-4000-8000-000000000007'
const MAT = '80000000-0000-4000-8000-000000000008'

const GUASTO: ErrorePostgrest = { code: '08006', message: 'connection failure' }

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  errori: {} as Record<string, { code: string; message?: string }>,
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: async () => ({ user: { id: GENITORE, role: 'genitore' } }),
}))
vi.mock('@/lib/auth/require-staff', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/auth/require-staff')>()
  return {
    ...vero,
    requireDocente: async () => ({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } }),
    requireUser: async () => ({ user: { id: GENITORE, role: 'genitore' } }),
  }
})
vi.mock('@/lib/auth/scope', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/auth/scope')>()
  return { ...vero, assertSezioneInScope: async () => null, assertAlunniInSezione: async () => null }
})
// Mock PARZIALE: la spia vede la riga come la scrive `rispostaGuastoDb`; il resto
// del modulo (che `withRoute` usa) resta vero.
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: (...a: unknown[]) => h.logErrore(...a) }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, [], { errori: h.errori }) }
})

import { GET as getScrutinioGenitore } from '@/app/api/parent/primaria/scrutinio/route'
import { GET as getPagelleGenitore } from '@/app/api/parent/primaria/pagella/route'
import { GET as getRegistroGenitore } from '@/app/api/parent/primaria/route'
import { GET as getScrutinioDocente } from '@/app/api/primaria/scrutinio/route'
import { GET as getAllergie } from '@/app/api/parent/mensa/allergie/route'
import { DELETE as deletePush } from '@/app/api/push/subscribe/route'

const get = (url: string) => new NextRequest(`http://test${url}`)

function dbBase(): DBFinto {
  return {
    alunni: [{ id: ALUNNO, nome: 'Bimbo', cognome: 'Prova', section_id: SEZ, scuola_id: SEDE, stato: 'iscritto' }],
    sections: [{ id: SEZ, name: '1A', school_type: 'primaria', scuola_id: SEDE }],
    admin_settings: [],
    scrutinio_periodi: [{ id: PER, nome: 'Primo quadrimestre', anno_scolastico: '2026/27', ordine: 1, attivo: true, scuola_id: SEDE }],
    scrutini: [{
      id: SCR, section_id: SEZ, periodo_id: PER, stato: 'chiuso', pubblicato: true, chiuso_il: '2027-02-01T10:00:00Z',
      scrutinio_periodi: { nome: 'Primo quadrimestre', anno_scolastico: '2026/27', ordine: 1 },
    }],
    pagella_ricezioni: [{ id: 'ric-1', scrutinio_id: SCR, alunno_id: ALUNNO, genitore_id: GENITORE, firmato_il: '2027-02-02T10:00:00Z' }],
    materie: [{ id: MAT, nome: 'Italiano', codice: 'ITA', e_civica: false, ordine: 1, section_id: SEZ, attiva: true }],
    utenti_sezioni_materie: [{ utente_id: DOCENTE, section_id: SEZ, materia_id: MAT }],
    scrutinio_giudizi: [{ scrutinio_id: SCR, alunno_id: ALUNNO, materia_id: MAT, giudizio_sintetico: 'Buono' }],
    scrutinio_comportamento: [],
    giudizi_sintetici_scala: [{ etichetta: 'Buono', ordine: 3, attivo: true, scuola_id: SEDE }],
    pagelle: [],
    registro_orario: [],
    valutazioni: [],
    note_disciplinari: [],
    presenze: [],
    push_subscriptions: [{ id: 'sub-1', endpoint: 'tok-1', utente_id: GENITORE }],
  }
}

beforeEach(() => {
  h.db = dbBase()
  h.errori = {}
  h.logErrore.mockReset()
})

/** Il 500 del guasto: codice di catalogo, e la riga di log che nomina la tabella. */
async function atteso500(res: Response, evento: string, codice = 'LETTURA_FALLITA') {
  expect(res.status).toBe(500)
  expect(await res.json()).toMatchObject({ codice })
  expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ stato: 500, evento }), expect.objectContaining({ code: '08006' }))
}

describe('parent/primaria/scrutinio:GET — la pagella a schermo del genitore', () => {
  const url = `/api/parent/primaria/scrutinio?scrutinioId=${SCR}&studentId=${ALUNNO}`

  it('sano: firmata, i giudizi escono materia per materia', async () => {
    const res = await getScrutinioGenitore(get(url))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ firmato: true, discipline: [{ materia: 'Italiano', giudizio: 'Buono' }] })
  })

  it('la firma non letta NON è «non firmato»: 500, non { firmato: false }', async () => {
    h.errori = { pagella_ricezioni: GUASTO }
    await atteso500(await getScrutinioGenitore(get(url)), 'db:pagella_ricezioni')
  })

  it('i giudizi non letti NON sono «—» su ogni materia: 500', async () => {
    h.errori = { scrutinio_giudizi: GUASTO }
    await atteso500(await getScrutinioGenitore(get(url)), 'db:scrutinio_giudizi')
  })
})

describe('parent/primaria/pagella:GET — l’elenco delle pagelle col flag «firmato»', () => {
  const url = `/api/parent/primaria/pagella?studentId=${ALUNNO}`

  it('sano: la pagella pubblicata esce già firmata', async () => {
    const res = await getPagelleGenitore(get(url))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject([{ scrutinioId: SCR, firmato: true }])
  })

  it('le firme non lette NON mettono ogni pagella a «da firmare»: 500', async () => {
    h.errori = { pagella_ricezioni: GUASTO }
    await atteso500(await getPagelleGenitore(get(url)), 'db:pagella_ricezioni')
  })
})

describe('parent/primaria:GET — registro, voti e assenze del figlio', () => {
  const url = `/api/parent/primaria?studentId=${ALUNNO}`

  it('sano: il grado è «primaria»', async () => {
    const res = await getRegistroGenitore(get(url))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ schoolType: 'primaria', valutazioni: [] })
  })

  it('la sezione non letta NON è «nessun grado» (che il telefono metterebbe in cache): 500', async () => {
    h.errori = { sections: GUASTO }
    await atteso500(await getRegistroGenitore(get(url)), 'db:sections')
  })

  it('le valutazioni non lette NON sono «nessun voto»: 500', async () => {
    h.errori = { valutazioni: GUASTO }
    await atteso500(await getRegistroGenitore(get(url)), 'db:valutazioni')
  })
})

describe('primaria/scrutinio:GET — la pagina dello scrutinio della docente', () => {
  const url = `/api/primaria/scrutinio?sectionId=${SEZ}&periodoId=${PER}`

  it('sano: i giudizi proposti tornano', async () => {
    const res = await getScrutinioDocente(get(url))
    expect(res.status).toBe(200)
    expect((await res.json()).data.giudizi).toMatchObject([{ materia_id: MAT, giudizio_sintetico: 'Buono' }])
  })

  it('i giudizi non letti NON sono uno scrutinio vuoto da riscrivere: 500', async () => {
    h.errori = { scrutinio_giudizi: GUASTO }
    await atteso500(await getScrutinioDocente(get(url)), 'db:scrutinio_giudizi')
  })
})

describe('parent/mensa/allergie:GET — l’icona di pericolo del genitore', () => {
  it('l’alunno non letto NON è «nessun pericolo»: 500, non { pericolo: false }', async () => {
    h.errori = { alunni: GUASTO }
    await atteso500(await getAllergie(get(`/api/parent/mensa/allergie?alunno_id=${ALUNNO}&date=2026-10-19`)), 'db:alunni')
  })
})

describe('push/subscribe:DELETE — il dispositivo che chiede di non ricevere più avvisi', () => {
  const req = () => new NextRequest('http://test/api/push/subscribe?endpoint=tok-1', { method: 'DELETE' })

  it('sano: la sottoscrizione sparisce', async () => {
    const res = await deletePush(req())
    expect(res.status).toBe(200)
    expect(h.db.push_subscriptions).toEqual([])
  })

  it('la cancellazione respinta NON risponde «fatto»: 500 di scrittura', async () => {
    h.errori = { 'push_subscriptions:delete': GUASTO }
    const res = await deletePush(req())
    await atteso500(res, 'db:push_subscriptions', 'SCRITTURA_FALLITA')
    expect(h.db.push_subscriptions).toHaveLength(1)
  })
})
