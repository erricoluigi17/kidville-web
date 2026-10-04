import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const SEZ_MIA = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRUI = 'aaaa2222-2222-4222-8222-aaaaaaaaaaaa'
const SEZ_MATERIA = 'aaaa3333-3333-4333-8333-aaaaaaaaaaaa'
const SEZ_B = 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  /** Il tetto dell'elenco: quello vero (1000) salvo nel test del troncamento. */
  limite: 1000,
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  opzioni: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, h.opzioni as OpzioniFinto) }
})
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))
// Un getter e non un valore: mille alunni in un fixture non dicono niente di più di due,
// e il tetto vero deve restare quello degli altri test.
vi.mock('@/lib/api/paginazione', async (originale) => ({
  ...(await originale<typeof import('@/lib/api/paginazione')>()),
  get LIMITE_ELENCO_ALUNNI() {
    return h.limite
  },
}))

import * as rotta from '@/app/api/teacher/alunni/route'

const riga = (id: string, nome: string, cognome: string, section_id: string, scuola_id: string, extra: Record<string, unknown> = {}) => ({
  id, nome, cognome, section_id, scuola_id,
  stato: 'iscritto', anonimizzato_il: null, gender: 'F', data_nascita: '2021-03-04',
  allergies: null, allergeni: [], is_bes_dsa: false, usa_pannolino: false,
  consenso_foto_sito: true, consenso_foto_social: true,
  note_mediche: 'NOTA-RISERVATA', codice_fiscale: 'TSTCFX21C44Z999Q', importo_retta_mensile: 987,
  ...extra,
})

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_MIA, scuola_id: SEDE_A, name: 'Girasoli', school_type: 'infanzia' },
    { id: SEZ_MATERIA, scuola_id: SEDE_A, name: '3A', school_type: 'primaria' },
    { id: SEZ_ALTRUI, scuola_id: SEDE_A, name: 'Tulipani', school_type: 'infanzia' },
    { id: SEZ_B, scuola_id: SEDE_B, name: 'Girasoli', school_type: 'infanzia' },
  ],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: SEZ_MIA }],
  utenti_sezioni_materie: [{ utente_id: 'ed1', section_id: SEZ_MATERIA, materia_id: 'm1' }],
  utenti_scuole: [],
  alunni: [
    // Il testo libero delle allergie non esce mai dall'elenco: ne esce solo «ha allergie».
    riga('a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', 'Alfa', 'Zeta', SEZ_MIA, SEDE_A, { allergies: 'RISERVATO fragole' }),
    riga('a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa', 'Beta', 'Alfieri', SEZ_MATERIA, SEDE_A, { allergeni: ['latte'] }),
    riga('a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa', 'Gamma', 'Altrui', SEZ_ALTRUI, SEDE_A),
    riga('b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb', 'Delta', 'Sedeb', SEZ_B, SEDE_B),
    riga('a4a4a4a4-4444-4444-8444-aaaaaaaaaaaa', 'Eta', 'Ritirato', SEZ_MIA, SEDE_A, { stato: 'ritirato' }),
    riga('a5a5a5a5-5555-4555-8555-aaaaaaaaaaaa', 'Teta', 'Anonimo', SEZ_MIA, SEDE_A, { anonimizzato_il: '2026-09-01T00:00:00Z' }),
  ],
})

const chiama = (cookie?: string) =>
  rotta.GET(new NextRequest('http://localhost/api/teacher/alunni', cookie ? { headers: { cookie } } : undefined))
const cognomi = async (res: Response) =>
  ((await res.json()).alunni as { cognome: string }[]).map((a) => a.cognome)

const ADMIN = { id: 'adm1', role: 'admin', scuola_id: SEDE_A }

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.opzioni = {}
  h.limite = 1000
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/teacher/alunni', () => {
  it('educator: solo i bambini iscritti delle sue sezioni (dirette e per materia), in ordine di cognome', async () => {
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const corpo = await res.json()
    expect(corpo.alunni.map((a: { cognome: string }) => a.cognome)).toEqual(['Alfieri', 'Zeta'])
    expect(corpo.sezioni.map((s: { id: string }) => s.id).sort()).toEqual([SEZ_MIA, SEZ_MATERIA].sort())
    expect(corpo.alunni[0]).toMatchObject({ grado: 'primaria', allergeni: ['latte'], haAllergie: true })
  })

  it('niente testo sanitario, codice fiscale o economia nell’elenco', async () => {
    const testo = await (await chiama()).text()
    for (const v of ['NOTA-RISERVATA', 'TSTCFX', '987', 'RISERVATO']) expect(testo).not.toContain(v)
  })

  it('il testo libero delle allergie non esce, ma «ha allergie» sì', async () => {
    const corpo = await (await chiama()).json()
    expect(corpo.alunni.find((a: { cognome: string }) => a.cognome === 'Zeta')).toMatchObject({ haAllergie: true })
  })

  it('educator senza assegnazioni: elenco vuoto SENZA interrogare gli alunni', async () => {
    h.db.utenti_sezioni = []
    h.db.utenti_sezioni_materie = []
    const res = await chiama()
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ sezioni: [], alunni: [] })
    expect(h.tabelle).not.toContain('alunni')
  })

  it('segreteria: tutti gli iscritti della propria sede, nessuno dell’altra', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    expect(await cognomi(await chiama())).toEqual(['Alfieri', 'Altrui', 'Zeta'])
  })

  it('coordinamento: vede la sede come la segreteria', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'coo1', role: 'coordinator', scuola_id: SEDE_A } })
    expect(await cognomi(await chiama())).toEqual(['Alfieri', 'Altrui', 'Zeta'])
  })

  it('il rifiuto del gate di ruolo passa intatto e non legge niente (403 e 401)', async () => {
    for (const status of [403, 401]) {
      h.tabelle.length = 0
      h.requireDocente.mockResolvedValue({ response: new Response('{}', { status }) })
      expect((await chiama()).status).toBe(status)
      expect(h.tabelle).toEqual([])
    }
  })

  it('500 se gli alunni non si leggono, con il log del guasto e senza cache', async () => {
    h.opzioni = { errori: { alunni: { code: '57P01' } } }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await res.json()).codice).toBe('ANAGRAFICA_ELENCO_NON_LETTO')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'teacher/alunni:GET', stato: 500 }),
      expect.objectContaining({ code: '57P01' }),
    )
  })

  it('500 se le sezioni non si leggono', async () => {
    h.opzioni = { errori: { sections: { code: '57P01' } } }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ANAGRAFICA_ELENCO_NON_LETTO')
  })

  it('500 se le assegnazioni non si leggono, senza toccare gli alunni', async () => {
    h.opzioni = { errori: { utenti_sezioni: { code: '57P01' } } }
    expect((await chiama()).status).toBe(500)
    expect(h.tabelle).not.toContain('alunni')
  })

  it('sola lettura: il modulo esporta SOLO `GET`', () => {
    const metodi = Object.keys(rotta).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))
    expect(metodi).toEqual(['GET'])
  })
})

describe('sedi vuote: le stesse risposte della scheda', () => {
  it('profilo senza sede: 403 ANAGRAFICA_SENZA_SEDE, senza leggere gli alunni', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: null } })
    const res = await chiama()
    expect(res.status).toBe(403)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await res.json()).codice).toBe('ANAGRAFICA_SENZA_SEDE')
    expect(h.tabelle).not.toContain('alunni')
  })

  it('admin con le sedi illeggibili: 500, mai un elenco vuoto travestito da «nessun bambino»', async () => {
    h.requireDocente.mockResolvedValue({ user: ADMIN })
    h.db.utenti_scuole = [{ utente_id: 'adm1', scuola_id: SEDE_B }]
    h.opzioni = { errori: { utenti_scuole: { code: '57P01' } } }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ANAGRAFICA_SCOPE_NON_RISOLTO')
    expect(h.tabelle).not.toContain('alunni')
  })
})

describe('la sede, percorso per percorso', () => {
  it('educator assegnato anche a una sezione dell’altra sede: quel bambino NON compare', async () => {
    h.db.utenti_sezioni.push({ utente_id: 'ed1', section_id: SEZ_B })
    expect(await cognomi(await chiama())).toEqual(['Alfieri', 'Zeta'])
  })

  it('segreteria con il selettore sull’altra sede: elenco vuoto', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await chiama(`sedi_attive=${SEDE_B}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ sezioni: [], alunni: [] })
  })

  it('admin a due sedi: le vede entrambe, e il selettore restringe', async () => {
    h.requireDocente.mockResolvedValue({ user: ADMIN })
    h.db.utenti_scuole = [
      { utente_id: 'adm1', scuola_id: SEDE_A },
      { utente_id: 'adm1', scuola_id: SEDE_B },
    ]
    expect(await cognomi(await chiama())).toEqual(['Alfieri', 'Altrui', 'Sedeb', 'Zeta'])
    expect(await cognomi(await chiama(`sedi_attive=${SEDE_A}`))).toEqual(['Alfieri', 'Altrui', 'Zeta'])
  })
})

describe('il tetto dell’elenco', () => {
  const troncato = () =>
    h.logEvento.mock.calls.filter((c) => (c[2] as { tipo?: string } | undefined)?.tipo === 'anagrafica-elenco-troncato')

  it('elenco lungo quanto il tetto: la query si ferma lì, warn nei log, e l’elenco esce comunque', async () => {
    // La segreteria ha TRE bambini: con il tetto a 2 ne escono due solo se la query usa
    // davvero la costante (un `.limit(1000)` scritto a mano li restituirebbe tutti e tre).
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    h.limite = 2
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await cognomi(res)).toEqual(['Alfieri', 'Altrui'])
    expect(h.logEvento).toHaveBeenCalledWith(
      'anagrafica',
      'warn',
      expect.objectContaining({ tipo: 'anagrafica-elenco-troncato', righe: 2, limite: 2 }),
    )
  })

  it('sotto il tetto: nessun warn', async () => {
    h.limite = 3
    await chiama()
    expect(troncato()).toEqual([])
  })
})
