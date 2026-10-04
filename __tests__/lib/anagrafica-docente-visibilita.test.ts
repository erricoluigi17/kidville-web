import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

import {
  assertAlunnoAnagraficaInScope,
  sezioniAnagraficaVisibili,
} from '@/lib/anagrafiche/docente/visibilita'

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
const ALU_SENZA_SEZIONE = 'a6a6a6a6-6666-4666-8666-aaaaaaaaaaaa'
const ALU_SOSPESO = 'a7a7a7a7-7777-4777-8777-aaaaaaaaaaaa'
const ALU_STATO_IGNOTO = 'a8a8a8a8-8888-4888-8888-aaaaaaaaaaaa'
const ALU_STATO_NULL = 'a9a9a9a9-9999-4999-8999-aaaaaaaaaaaa'

const EDUCATOR: AppUser = { id: 'ed1', role: 'educator', scuola_id: SEDE_A }
const SEGRETERIA: AppUser = { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A }
const ADMIN: AppUser = { id: 'adm1', role: 'admin', scuola_id: SEDE_A }
const GENITORE: AppUser = { id: 'gen1', role: 'genitore', scuola_id: SEDE_A }
const CUOCA: AppUser = { id: 'cuo1', role: 'cuoca', scuola_id: SEDE_A }
/** La stessa insegnante di `EDUCATOR`, che sta guardando l'app nella veste di genitore. */
const DOCENTE_IN_VESTE_GENITORE: AppUser = {
  id: 'ed1', role: 'genitore', ruoli: ['educator', 'genitore'], scuola_id: SEDE_A,
}
/** La stessa segretaria di `SEGRETERIA`, nella veste di genitore: «tutte le classi» non vale. */
const SEGRETERIA_IN_VESTE_GENITORE: AppUser = {
  id: 'seg1', role: 'genitore', ruoli: ['segreteria', 'genitore'], scuola_id: SEDE_A,
}

let db: DBFinto
let tabelle: string[]
let opzioni: OpzioniFinto

const alunno = (id: string, section_id: string | null, scuola_id: string, extra: Record<string, unknown> = {}) => ({
  id, section_id, scuola_id, stato: 'iscritto', anonimizzato_il: null, ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  tabelle = []
  opzioni = {}
  db = {
    utenti_sezioni: [{ utente_id: 'ed1', section_id: SEZ_MIA }],
    // La stessa sezione anche per materia: l'unione non deve produrre doppioni.
    utenti_sezioni_materie: [
      { utente_id: 'ed1', section_id: SEZ_MATERIA, materia_id: 'm1' },
      { utente_id: 'ed1', section_id: SEZ_MIA, materia_id: 'm2' },
    ],
    utenti_scuole: [],
    alunni: [
      alunno(ALU_MIO, SEZ_MIA, SEDE_A),
      alunno(ALU_ALTRUI, SEZ_ALTRUI, SEDE_A),
      alunno(ALU_MATERIA, SEZ_MATERIA, SEDE_A),
      alunno(ALU_B, SEZ_B, SEDE_B),
      alunno(ALU_RITIRATO, SEZ_MIA, SEDE_A, { stato: 'ritirato' }),
      alunno(ALU_ANONIMO, SEZ_MIA, SEDE_A, { anonimizzato_il: '2026-09-01T00:00:00Z' }),
      alunno(ALU_SENZA_SEZIONE, null, SEDE_A),
      // `stato = 'sospeso'` è un bambino che frequenta (decisione del titolare, 04/10).
      alunno(ALU_SOSPESO, SEZ_MIA, SEDE_A, { stato: 'sospeso' }),
      // Uno stato che nessuno ha deciso: l'elenco è chiuso, quindi resta fuori.
      alunno(ALU_STATO_IGNOTO, SEZ_MIA, SEDE_A, { stato: 'trasferito' }),
      // La colonna è NULLABLE: uno stato vuoto non è una decisione, e resta fuori.
      alunno(ALU_STATO_NULL, SEZ_MIA, SEDE_A, { stato: null }),
    ],
  }
})

const client = () => creaFintoSupabase(db, tabelle, opzioni)

describe('sezioniAnagraficaVisibili', () => {
  it('segreteria: tutte le sezioni della sede, senza leggere le assegnazioni', async () => {
    expect(await sezioniAnagraficaVisibili(client(), SEGRETERIA)).toEqual({ esito: 'tutte' })
    expect(tabelle).toEqual([])
  })

  it('educator: unione di assegnazioni dirette e per materia, senza doppioni', async () => {
    const esito = await sezioniAnagraficaVisibili(client(), EDUCATOR)
    expect(esito.esito).toBe('sezioni')
    expect(esito.esito === 'sezioni' && [...esito.sezioni].sort()).toEqual([SEZ_MIA, SEZ_MATERIA].sort())
  })

  it('educator senza assegnazioni: elenco vuoto (nega per difetto)', async () => {
    db.utenti_sezioni = []
    db.utenti_sezioni_materie = []
    expect(await sezioniAnagraficaVisibili(client(), EDUCATOR)).toEqual({ esito: 'sezioni', sezioni: [] })
  })

  it('un guasto su una delle due letture è un ERRORE con log, mai «nessuna sezione»', async () => {
    opzioni = { errori: { utenti_sezioni_materie: { code: '57P01', message: 'terminating connection' } } }
    expect(await sezioniAnagraficaVisibili(client(), EDUCATOR)).toEqual({ esito: 'errore' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'error',
      expect.objectContaining({ tipo: 'anagrafica-sezioni-non-lette', utente: 'ed1' }),
      expect.objectContaining({ code: '57P01' }),
    )
  })
})

describe('assertAlunnoAnagraficaInScope', () => {
  const stato = async (user: AppUser, id: string) => {
    const esito = await assertAlunnoAnagraficaInScope(client(), user, id)
    return esito.ok ? 200 : esito.response.status
  }

  it('apre al docente della sezione e a quello di sola materia', async () => {
    expect(await stato(EDUCATOR, ALU_MIO)).toBe(200)
    expect(await stato(EDUCATOR, ALU_MATERIA)).toBe(200)
  })

  it('restituisce sezione e sede dell’alunno', async () => {
    const esito = await assertAlunnoAnagraficaInScope(client(), EDUCATOR, ALU_MIO)
    expect(esito).toEqual({ ok: true, alunno: { id: ALU_MIO, sectionId: SEZ_MIA, scuolaId: SEDE_A } })
  })

  it('403 per una sezione non sua della stessa sede, con una traccia warn per bambino', async () => {
    const esito = await assertAlunnoAnagraficaInScope(client(), EDUCATOR, ALU_ALTRUI)
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.response.status).toBe(403)
    expect((await esito.response.json()).codice).toBe('ANAGRAFICA_FUORI_SEZIONE')
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ tipo: 'anagrafica-fuori-sezione', utente: 'ed1', alunno_id: ALU_ALTRUI }),
      undefined,
      { distingui: ['alunno_id'] },
    )
  })

  it('403 per un alunno senza sezione (educator) e per un’altra sede', async () => {
    expect(await stato(EDUCATOR, ALU_SENZA_SEZIONE)).toBe(403)
    const esito = await assertAlunnoAnagraficaInScope(client(), EDUCATOR, ALU_B)
    expect(!esito.ok && (await esito.response.json()).codice).toBe('ANAGRAFICA_FUORI_SEDE')
  })

  it('il «fuori sede» lascia una traccia warn per bambino, e non legge le assegnazioni', async () => {
    await assertAlunnoAnagraficaInScope(client(), EDUCATOR, ALU_B)
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ tipo: 'anagrafica-fuori-sede', utente: 'ed1', alunno_id: ALU_B }),
      undefined,
      { distingui: ['alunno_id'] },
    )
    expect(tabelle).not.toContain('utenti_sezioni')
  })

  it('profilo senza sede: 403 ANAGRAFICA_SENZA_SEDE, mai «fuori sede» né un’apertura', async () => {
    // ALU_MIO e non un bambino qualunque: è quello che le sue assegnazioni aprirebbero,
    // quindi se il controllo di sede venisse saltato la risposta sarebbe 200.
    const esito = await assertAlunnoAnagraficaInScope(client(), { ...EDUCATOR, scuola_id: null }, ALU_MIO)
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.response.status).toBe(403)
    expect((await esito.response.json()).codice).toBe('ANAGRAFICA_SENZA_SEDE')
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ tipo: 'anagrafica-profilo-senza-sede', utente: 'ed1' }),
    )
  })

  it('admin multi-sede (utenti_scuole): apre anche il bambino dell’altra sede', async () => {
    db.utenti_scuole = [
      { utente_id: 'adm1', scuola_id: SEDE_A },
      { utente_id: 'adm1', scuola_id: SEDE_B },
    ]
    expect(await stato(ADMIN, ALU_B)).toBe(200)
  })

  it('admin con le sedi illeggibili: 500, mai un’apertura e mai «fuori sede»', async () => {
    db.utenti_scuole = [{ utente_id: 'adm1', scuola_id: SEDE_B }]
    opzioni = { errori: { utenti_scuole: { code: '57P01' } } }
    const esito = await assertAlunnoAnagraficaInScope(client(), ADMIN, ALU_MIO)
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.response.status).toBe(500)
    expect((await esito.response.json()).codice).toBe('ANAGRAFICA_SCOPE_NON_RISOLTO')
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'error',
      expect.objectContaining({ tipo: 'anagrafica-sedi-non-risolte', utente: 'adm1' }),
    )
  })

  it('ogni risposta del gate porta Cache-Control: no-store', async () => {
    for (const [user, id] of [
      [EDUCATOR, ALU_ALTRUI], // 403 fuori sezione
      [EDUCATOR, ALU_B], // 403 fuori sede
      [EDUCATOR, ALU_RITIRATO], // 404
      [{ ...EDUCATOR, scuola_id: null }, ALU_MIO], // 403 senza sede
    ] as const) {
      const esito = await assertAlunnoAnagraficaInScope(client(), user, id)
      expect(!esito.ok && esito.response.headers.get('Cache-Control')).toBe('no-store')
    }
    opzioni = { errori: { alunni: { code: '57P01' } } }
    const guasto = await assertAlunnoAnagraficaInScope(client(), EDUCATOR, ALU_MIO)
    expect(!guasto.ok && guasto.response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('genitore e cuoca senza assegnazioni: 403, non vedono «tutte le classi»', async () => {
    for (const user of [GENITORE, CUOCA]) {
      const esito = await assertAlunnoAnagraficaInScope(client(), user, ALU_MIO)
      expect(!esito.ok && esito.response.status).toBe(403)
      expect(!esito.ok && (await esito.response.json()).codice).toBe('ANAGRAFICA_FUORI_SEZIONE')
    }
  })

  it('docente in veste di genitore: le sue assegnazioni valgono uguale, né di più né di meno', async () => {
    expect(await stato(DOCENTE_IN_VESTE_GENITORE, ALU_MIO)).toBe(200)
    expect(await stato(DOCENTE_IN_VESTE_GENITORE, ALU_ALTRUI)).toBe(403)
  })

  it('segreteria in veste di genitore: conta la veste attiva, e senza assegnazioni non apre', async () => {
    expect(await stato(SEGRETERIA_IN_VESTE_GENITORE, ALU_ALTRUI)).toBe(403)
  })

  it('il bambino «sospeso» della sua sezione si apre: frequenta ancora', async () => {
    const esito = await assertAlunnoAnagraficaInScope(client(), EDUCATOR, ALU_SOSPESO)
    expect(esito).toEqual({ ok: true, alunno: { id: ALU_SOSPESO, sectionId: SEZ_MIA, scuolaId: SEDE_A } })
  })

  it('404 per inesistente, ritirato, stato mai deciso o vuoto, anonimizzato — prima di guardare le sezioni', async () => {
    for (const id of ['c0c0c0c0-0000-4000-8000-cccccccccccc', ALU_RITIRATO, ALU_STATO_IGNOTO, ALU_STATO_NULL, ALU_ANONIMO]) {
      tabelle = []
      expect(await stato(EDUCATOR, id)).toBe(404)
      expect(tabelle).not.toContain('utenti_sezioni')
    }
  })

  it('segreteria: ogni alunno della propria sede, nessuno delle altre', async () => {
    expect(await stato(SEGRETERIA, ALU_ALTRUI)).toBe(200)
    expect(await stato(SEGRETERIA, ALU_SENZA_SEZIONE)).toBe(200)
    expect(await stato(SEGRETERIA, ALU_B)).toBe(403)
  })

  it('500 se l’alunno non si riesce a leggere, o se le assegnazioni non si leggono', async () => {
    opzioni = { errori: { alunni: { code: '57P01' } } }
    expect(await stato(EDUCATOR, ALU_MIO)).toBe(500)
    opzioni = { errori: { utenti_sezioni: { code: '57P01' } } }
    expect(await stato(EDUCATOR, ALU_MIO)).toBe(500)
  })

  it('la lettura fallita dell’alunno lascia un log error con il codice del guasto', async () => {
    opzioni = { errori: { alunni: { code: '57P01', message: 'terminating connection' } } }
    await assertAlunnoAnagraficaInScope(client(), EDUCATOR, ALU_MIO)
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'error',
      expect.objectContaining({ tipo: 'anagrafica-alunno-non-letto', utente: 'ed1' }),
      expect.objectContaining({ code: '57P01' }),
    )
  })
})
