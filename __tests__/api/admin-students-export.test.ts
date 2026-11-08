import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, OpzioniFinto } from '../fixtures/finto-supabase'
import { NOME_SEDE_A, NOME_SEDE_B, SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * `GET /api/admin/students/export`: l'anagrafica che il cockpit scarica in Excel.
 *
 * Prima `ImportExportClient` la leggeva dal browser e per lo staff usciva vuota (la prova è in
 * `__tests__/db/alunni-rls-export-staff.test.ts`). La service role qui scavalca la RLS, quindi tocca
 * alla route dire chi può, di quale sede, e quali colonne escono. Dati finti.
 *
 * Il finto Supabase non proietta le colonne di `select()`: per le colonne vietate si misura che cosa
 * la route CHIEDE, e per la colonna assente la risposta di PostgREST si simula qui sotto.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logScrittura: vi.fn(async () => undefined),
  db: {} as Record<string, Record<string, unknown>[]>,
  opzioni: {} as Record<string, unknown>,
  colonneChieste: [] as string[],
  colonneAssenti: [] as string[],
  alTetto: false,
}))

// Il tetto vero sono 50.000 righe: qui si finge l'esito, per provare che cosa ne fa la route.
vi.mock('@/lib/db/leggi-a-blocchi', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/db/leggi-a-blocchi')>()
  return {
    ...vero,
    leggiABlocchi: (...argomenti: Parameters<typeof vero.leggiABlocchi>) =>
      h.alTetto
        ? Promise.resolve({ ok: false, motivo: 'tetto', blocchi: 51, n: 50000, oltre: 50000 })
        : vero.leggiABlocchi(...argomenti),
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const client = creaFintoSupabase(h.db as DBFinto, [], h.opzioni as OpzioniFinto)
      return new Proxy(client, {
        get(bersaglio, chiave, ricevente) {
          if (chiave !== 'from') return Reflect.get(bersaglio, chiave, ricevente)
          return (tabella: string) => {
            const query = bersaglio.from(tabella)
            if (tabella !== 'alunni') return query
            return {
              select: (colonne: string) => {
                h.colonneChieste.push(colonne)
                const assente = h.colonneAssenti.find((c) => colonne.split(', ').includes(c))
                if (!assente) return query.select(colonne)
                const catena = {
                  in: () => catena,
                  is: () => catena,
                  order: () => catena,
                  range: async () => ({
                    data: null,
                    error: { code: '42703', message: `column alunni.${assente} does not exist` },
                  }),
                }
                return catena
              },
            }
          }
        },
      })
    },
  }
})

import { GET } from '@/app/api/admin/students/export/route'

const DIREZIONE = 'aaaaaaaa-0000-4000-8000-000000000001'
const SEDE_ESTRANEA = 'cccccccc-0000-4000-8000-000000000009'

const alunno = (cognome: string, scuola_id: string, altri: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${cognome.padStart(12, '0').slice(-12)}`,
  scuola_id, nome: 'Alfa', cognome, data_nascita: '2021-03-04', codice_fiscale: 'XXXXXX00X00X000X',
  classe_sezione: 'A', stato: 'iscritto', anonimizzato_il: null,
  ...altri,
})

/** Art. 9 GDPR, documenti, soldi e la sede grezza: nessuna deve stare nella proiezione. */
const COLONNE_VIETATE = [
  'note_mediche', 'allergies', 'allergeni', 'is_bes_dsa', 'note_bes', 'documento_path', 'importo_retta_mensile',
  'retta_split_config', 'intestatario_fatture', 'invoice_holder_details', 'invoice_holder_type', 'sospeso_motivo',
  'genitori_separati', 'usa_pannolino', '*',
]

function richiesta(cookie?: string[]) {
  const req = new NextRequest('http://localhost/api/admin/students/export')
  if (cookie) req.cookies.set('sedi_attive', cookie.join(','))
  return req
}

type Corpo = { righe: Record<string, unknown>[] }

beforeEach(() => {
  vi.clearAllMocks()
  h.opzioni = {}
  h.colonneChieste = []
  h.colonneAssenti = []
  h.alTetto = false
  h.requireStaff.mockResolvedValue({ user: { id: DIREZIONE, role: 'admin', scuola_id: SEDE_A } })
  h.db = {
    utenti_scuole: [
      { utente_id: DIREZIONE, scuola_id: SEDE_A },
      { utente_id: DIREZIONE, scuola_id: SEDE_B },
    ],
    schools: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }],
    alunni: [
      alunno('prima', SEDE_A),
      alunno('seconda', SEDE_B),
      alunno('estranea', SEDE_ESTRANEA),
      alunno('anonimizzato', SEDE_A, { anonimizzato_il: '2026-09-01T00:00:00Z' }),
    ],
  }
})

describe('GET /api/admin/students/export', () => {
  it('il gate decide per primo: chi non è staff non arriva al database', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    const res = await GET(richiesta())
    expect(res.status).toBe(403)
    expect(h.colonneChieste).toEqual([])
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('esce solo la sede dell’utente: una sede estranea non compare, un anonimizzato nemmeno', async () => {
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    const { righe } = (await res.json()) as Corpo
    expect(righe.map((r) => r.cognome).sort()).toEqual(['prima', 'seconda'])
  })

  it('è un backup: chi non frequenta più resta nel foglio, e la colonna `stato` lo dice', async () => {
    h.db.alunni.push(alunno('ritirata', SEDE_A, { stato: 'ritirato', classe_sezione: null }))
    const { righe } = (await (await GET(richiesta([SEDE_A]))).json()) as Corpo
    expect(righe.map((r) => [r.cognome, r.stato]).sort()).toEqual([['prima', 'iscritto'], ['ritirata', 'ritirato']])
  })

  it('il cookie del selettore restringe, e non allarga', async () => {
    const soloB = await GET(richiesta([SEDE_B]))
    expect(((await soloB.json()) as Corpo).righe.map((r) => r.cognome)).toEqual(['seconda'])
  })

  it('una sede fuori perimetro nel cookie è un 403, mai «allora eccoti tutto»', async () => {
    const res = await GET(richiesta([SEDE_ESTRANEA]))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    expect(h.colonneChieste).toEqual([])
    expect(h.logEvento).toHaveBeenCalledWith('anagrafica', 'warn', expect.objectContaining({ esito: 'scope-vuoto' }))
  })

  it('note sanitarie, BES, documenti e rette non si chiedono nemmeno', async () => {
    await GET(richiesta())
    expect(h.colonneChieste).toHaveLength(1)
    const chieste = h.colonneChieste[0].split(', ')
    for (const colonna of COLONNE_VIETATE) expect(chieste, colonna).not.toContain(colonna)
    expect(chieste).toEqual(expect.arrayContaining(['nome', 'cognome', 'codice_fiscale', 'classe_sezione', 'stato', 'id']))
  })

  it('la sede ha un nome, in prima colonna, e l’uuid della sede non esce', async () => {
    const { righe } = (await (await GET(richiesta())).json()) as Corpo
    expect(Object.keys(righe[0])[0]).toBe('sede')
    expect(righe[0]).not.toHaveProperty('scuola_id')
    expect(righe.map((r) => r.sede).sort()).toEqual([NOME_SEDE_A, NOME_SEDE_B].sort())
  })

  it('oltre `max_rows` non si tronca: PostgREST taglia senza dirlo', async () => {
    h.opzioni = { maxRighe: 1000 }
    h.db.alunni = Array.from({ length: 1205 }, (_, i) => alunno(String(i).padStart(4, '0'), SEDE_A))
    const { righe } = (await (await GET(richiesta([SEDE_A]))).json()) as Corpo
    expect(righe).toHaveLength(1205)
    expect(new Set(righe.map((r) => r.id)).size).toBe(1205)
  })

  it('una colonna che questo database non ha si toglie e la lettura riparte: il DB E2E non è migrato', async () => {
    h.colonneAssenti = ['data_iscrizione']
    const res = await GET(richiesta([SEDE_A]))
    expect(res.status).toBe(200)
    expect(((await res.json()) as Corpo).righe.map((r) => r.cognome)).toEqual(['prima'])
    expect(h.colonneChieste).toHaveLength(2)
    expect(h.colonneChieste[0].split(', ')).toContain('data_iscrizione')
    expect(h.colonneChieste[1].split(', ')).not.toContain('data_iscrizione')
  })

  it('una lettura fallita è un 500 con un log, e nessun elenco a metà', async () => {
    h.opzioni = { errori: { alunni: { code: 'XX000', message: 'guasto finto' } } }
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo).not.toHaveProperty('righe')
    expect(corpo).toMatchObject({ codice: 'ANAGRAFICA_EXPORT_NON_LETTA' })
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'admin/students/export:GET', stato: 500, evento: 'db' }),
      expect.anything(),
    )
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('al tetto dei blocchi la lettura è un guasto: mai un elenco tagliato presentato come intero', async () => {
    h.alTetto = true
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo).not.toHaveProperty('righe')
    expect(corpo).toMatchObject({ codice: 'ANAGRAFICA_EXPORT_NON_LETTA' })
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'admin/students/export:GET', stato: 500, evento: 'lettura-troncata' }),
      expect.any(Error),
    )
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('se i nomi delle sedi non si leggono è un 500: un foglio senza sede non dice di chi sono i bambini', async () => {
    h.opzioni = { errori: { schools: { code: 'XX000', message: 'guasto finto' } } }
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo).not.toHaveProperty('righe')
    expect(corpo).toMatchObject({ codice: 'ANAGRAFICA_EXPORT_NON_LETTA' })
    expect(h.logErrore).toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('«chi ha scaricato l’elenco dei bambini e quando»: una riga di audit per sede, coi soli conteggi', async () => {
    await GET(richiesta())
    expect(h.logScrittura).toHaveBeenCalledTimes(2)
    const voci = (h.logScrittura.mock.calls as unknown as [unknown, Record<string, unknown>][]).map((c) => c[1])
    const perSede = new Map(voci.map((v) => [v.scuolaId, v]))
    expect(perSede.get(SEDE_A)).toMatchObject({ entitaTipo: 'export_anagrafica_alunni', azione: 'insert', valoreDopo: { n_righe: 1 } })
    expect(perSede.get(SEDE_B)).toMatchObject({ valoreDopo: { n_righe: 1 } })
  })

  it('il successo si logga con i soli numeri, e la risposta non resta in nessuna cache', async () => {
    const res = await GET(richiesta())
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(h.logEvento).toHaveBeenCalledWith('anagrafica', 'info', expect.objectContaining({
      operazione: 'admin/students/export:GET', esito: 'export-consegnato', n: 2, sedi: 2,
    }))
    for (const chiamata of h.logEvento.mock.calls) {
      expect(JSON.stringify(chiamata)).not.toMatch(/Alfa|XXXXXX00X00X000X/)
    }
  })
})
