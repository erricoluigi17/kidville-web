import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * CRM della segreteria · `GET /api/admin/crm/quote` — la lista «Quote dal CRM» della contabilità
 * (Compito 6 del piano «quota e disponibilità»).
 *
 * Il database è il FINTO che applica davvero i filtri, e in più si registrano i `.in(...)` messi sulla
 * lettura: «le quote di un'altra sede non si vedono» è una proprietà del filtro nella STESSA query, non di
 * un taglio fatto dopo in memoria. Il gate di ruolo è finto (decide solo chi entra); `resolveScuoleAttive`,
 * `restringiSedi` e `scuoleDiUtente` sono quelli VERI, perché sono loro a dire quale sede vale.
 *
 * Dati di prova soltanto: «Bimbo Prova», sedi da `fixtures/sedi.ts`.
 */

const h = vi.hoisted(() => ({
  ruolo: 'segreteria' as string,
  sedePropria: null as string | null,
  db: {} as Record<string, Record<string, unknown>[]>,
  letture: [] as string[],
  errori: {} as Record<string, unknown>,
  /** i filtri `.in(colonna, valori)` che la route ha messo, tabella per tabella */
  filtriIn: [] as { tabella: string; colonna: string; valori: unknown }[],
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

type Catena = Record<string, (...a: unknown[]) => unknown>

/** Registra ogni `.in(...)` messo su una lettura, comunque la catena sia composta. */
function conSpiaDeiFiltri(client: SupabaseClient): SupabaseClient {
  const avvolgi = (catena: Catena, tabella: string): Catena =>
    new Proxy(catena, {
      get(bersaglio, nome: string) {
        const valore = bersaglio[nome]
        if (typeof valore !== 'function') return valore
        return (...argomenti: unknown[]) => {
          if (nome === 'in') h.filtriIn.push({ tabella, colonna: String(argomenti[0]), valori: argomenti[1] })
          const esito = valore.apply(bersaglio, argomenti)
          return esito && typeof esito === 'object' && typeof (esito as Catena).in === 'function'
            ? avvolgi(esito as Catena, tabella)
            : esito
        }
      },
    })
  return new Proxy(client, {
    get(bersaglio, nome: string) {
      const valore = (bersaglio as unknown as Catena)[nome]
      if (nome !== 'from') return valore
      return (tabella: string) => avvolgi((valore as (t: string) => Catena).call(bersaglio, tabella), tabella)
    },
  })
}

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    return Promise.resolve({ user: { id: USER, role: h.ruolo, scuola_id: h.sedePropria } })
  },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (...a: Parameters<typeof vero.logEvento>) => {
      h.logEvento(...a)
      return vero.logEvento(...a)
    },
    logErrore: (...a: Parameters<typeof vero.logErrore>) => {
      h.logErrore(...a)
      return vero.logErrore(...a)
    },
  }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () =>
    conSpiaDeiFiltri(creaFintoSupabase(h.db as DBFinto, h.letture, { errori: h.errori as Record<string, ErrorePostgrest> })),
}))

import { GET } from '@/app/api/admin/crm/quote/route'
import { giorniDiAttesa } from '@/lib/crm/quota'

const USER = '20000000-0000-4000-8000-0000000000aa'

const SCHEDA_A = '30000000-0000-4000-8000-000000000001'
const SCHEDA_B = '30000000-0000-4000-8000-0000000000b1'
const ALUNNO = '80000000-0000-4000-8000-000000000001'

const B_ATTESA = '50000000-0000-4000-8000-0000000000a1' // sede A, in attesa, senza alunno
const B_ATTESA_COLLEGATO = '50000000-0000-4000-8000-0000000000a2' // sede A, in attesa, alunno collegato
const B_SENZA_IMPORTO = '50000000-0000-4000-8000-0000000000a3' // sede A, la vecchia spunta
const B_BLOCCATA = '50000000-0000-4000-8000-0000000000a4' // sede A, bloccata (voce già pagata)
const B_IN_CONTABILITA = '50000000-0000-4000-8000-0000000000a5' // sede A, già in contabilità
const B_SENZA_QUOTA = '50000000-0000-4000-8000-0000000000a6' // sede A, nessuna quota
const B_SEDE_B = '50000000-0000-4000-8000-0000000000b1' // sede B, in attesa

/** Il momento «di adesso» dei test: il 31/10/2026, mattina. A Roma è lo stesso giorno. */
const ORA_BASE = '2026-10-31T10:00:00.000Z'

const bambino = (id: string, sede: string, scheda: string, extra: Record<string, unknown> = {}) => ({
  id,
  scuola_id: sede,
  scheda_id: scheda,
  nome: 'Bimbo Prova',
  alunno_id: null,
  quota_importo: null,
  quota_metodo: null,
  quota_anno: null,
  quota_stato: null,
  quota_blocco_motivo: null,
  quota_saldata_il: null,
  ...extra,
})

const richiesta = (query = '', cookie?: string) =>
  new NextRequest(`http://localhost/api/admin/crm/quote${query}`, cookie ? { headers: { cookie } } : undefined)

const get = (query = '', cookie?: string) => GET(richiesta(query, cookie))

const logCrm = () =>
  h.logEvento.mock.calls
    .filter((c) => c[0] === 'crm')
    .map((c) => ({ livello: c[1] as string, campi: c[2] as Record<string, unknown> }))

type Voce = { bambinoId: string; stato: string; [k: string]: unknown }
const ids = (corpo: { data: Voce[] }) => corpo.data.map((v) => v.bambinoId)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ORA_BASE))
  h.ruolo = 'segreteria'
  h.sedePropria = SEDE_A
  h.letture = []
  h.errori = {}
  h.filtriIn = []
  h.logEvento.mockClear()
  h.logErrore.mockClear()
  h.db = {
    utenti_scuole: [],
    crm_bambini: [
      bambino(B_ATTESA, SEDE_A, SCHEDA_A, {
        quota_stato: 'in_attesa',
        quota_importo: 150,
        quota_metodo: 'contanti',
        quota_anno: 2027,
        quota_saldata_il: '2026-10-28',
      }),
      bambino(B_ATTESA_COLLEGATO, SEDE_A, SCHEDA_A, {
        quota_stato: 'in_attesa',
        quota_importo: '120.50', // `numeric` arriva da PostgREST anche come stringa
        quota_metodo: 'bonifico',
        quota_anno: 2027,
        quota_saldata_il: '2026-10-30',
        alunno_id: ALUNNO,
      }),
      bambino(B_SENZA_IMPORTO, SEDE_A, SCHEDA_A, { quota_stato: 'senza_importo', quota_saldata_il: '2026-10-01' }),
      bambino(B_BLOCCATA, SEDE_A, SCHEDA_A, {
        quota_stato: 'bloccata',
        quota_blocco_motivo: 'gia_pagata',
        quota_importo: 150,
        quota_metodo: 'carta',
        quota_anno: 2027,
        quota_saldata_il: '2026-10-10',
        alunno_id: ALUNNO,
      }),
      bambino(B_IN_CONTABILITA, SEDE_A, SCHEDA_A, {
        quota_stato: 'in_contabilita',
        quota_importo: 150,
        quota_metodo: 'contanti',
        quota_anno: 2027,
        quota_saldata_il: '2026-09-01',
        alunno_id: ALUNNO,
      }),
      bambino(B_SENZA_QUOTA, SEDE_A, SCHEDA_A),
      bambino(B_SEDE_B, SEDE_B, SCHEDA_B, {
        quota_stato: 'in_attesa',
        quota_importo: 90,
        quota_metodo: 'contanti',
        quota_anno: 2027,
        quota_saldata_il: '2026-10-05',
      }),
    ],
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/admin/crm/quote · la lista delle quote non ancora in contabilità', () => {
  it('elenca solo le quote in attesa, senza importo e bloccate delle sedi dell’utente', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { data: Voce[] }

    // Dal più vecchio (aspetta da più tempo) al più recente; la vecchia spunta, con un giorno, è fra le altre.
    expect(ids(corpo)).toEqual([B_SENZA_IMPORTO, B_BLOCCATA, B_ATTESA, B_ATTESA_COLLEGATO])
    expect(corpo.data.map((v) => v.stato)).toEqual(['senza_importo', 'bloccata', 'in_attesa', 'in_attesa'])
    // Né «in contabilità», né chi non ha nessuna quota, né le famiglie di un'altra sede.
    expect(ids(corpo)).not.toContain(B_IN_CONTABILITA)
    expect(ids(corpo)).not.toContain(B_SENZA_QUOTA)
    expect(ids(corpo)).not.toContain(B_SEDE_B)
  })

  it('porta nella risposta tutto ciò che la tabella mostra, con i numeri come numeri', async () => {
    const corpo = (await (await get()).json()) as { data: Voce[] }
    const per = (id: string) => corpo.data.find((v) => v.bambinoId === id)

    expect(per(B_ATTESA)).toEqual({
      bambinoId: B_ATTESA,
      schedaId: SCHEDA_A,
      scuolaId: SEDE_A,
      nome: 'Bimbo Prova',
      anno: 2027,
      importo: 150,
      metodo: 'contanti',
      giorno: '2026-10-28',
      giorniAttesa: 3,
      stato: 'in_attesa',
      motivo: null,
      alunnoCollegato: false,
    })
    // L'importo `numeric` che arriva come stringa diventa un numero; l'alunno collegato si vede.
    expect(per(B_ATTESA_COLLEGATO)).toMatchObject({ importo: 120.5, alunnoCollegato: true, giorniAttesa: 1 })
    // Il motivo del blocco è quello del database.
    expect(per(B_BLOCCATA)).toMatchObject({ stato: 'bloccata', motivo: 'gia_pagata', metodo: 'carta', alunnoCollegato: true })
    // La vecchia spunta non ha importo, né metodo, né anno: arrivano nulli, non inventati.
    expect(per(B_SENZA_IMPORTO)).toMatchObject({
      stato: 'senza_importo',
      importo: null,
      metodo: null,
      anno: null,
      motivo: null,
      giorno: '2026-10-01',
      giorniAttesa: 30,
    })
  })

  it('una quota senza giorno resta in lista, in fondo, senza giorni di attesa; un nome nullo resta nullo', async () => {
    h.db.crm_bambini.push(
      bambino('50000000-0000-4000-8000-0000000000a7', SEDE_A, SCHEDA_A, { quota_stato: 'senza_importo', nome: null }),
    )
    const corpo = (await (await get()).json()) as { data: Voce[] }
    const ultima = corpo.data[corpo.data.length - 1]
    expect(ultima).toMatchObject({ bambinoId: '50000000-0000-4000-8000-0000000000a7', nome: null, giorno: null, giorniAttesa: null })
  })

  it('la sede sta nella STESSA query (.in su scuola_id) insieme agli stati, non in un taglio fatto dopo', async () => {
    await get()
    const sulleQuote = h.filtriIn.filter((f) => f.tabella === 'crm_bambini')
    expect(sulleQuote).toContainEqual({ tabella: 'crm_bambini', colonna: 'scuola_id', valori: [SEDE_A] })
    expect(sulleQuote).toContainEqual({
      tabella: 'crm_bambini',
      colonna: 'quota_stato',
      valori: ['senza_importo', 'in_attesa', 'bloccata'],
    })
  })

  it('l’admin con due sedi, senza indicarne una, le vede tutte; con ?scuolaId solo quella', async () => {
    h.ruolo = 'admin'
    h.db.utenti_scuole = [
      { utente_id: USER, scuola_id: SEDE_A },
      { utente_id: USER, scuola_id: SEDE_B },
    ]

    const tutte = (await (await get()).json()) as { data: Voce[] }
    expect(new Set(ids(tutte))).toEqual(new Set([B_SENZA_IMPORTO, B_BLOCCATA, B_ATTESA, B_ATTESA_COLLEGATO, B_SEDE_B]))
    expect(h.filtriIn).toContainEqual({ tabella: 'crm_bambini', colonna: 'scuola_id', valori: [SEDE_A, SEDE_B] })

    h.filtriIn = []
    const soloB = (await (await get(`?scuolaId=${SEDE_B}`)).json()) as { data: Voce[] }
    expect(ids(soloB)).toEqual([B_SEDE_B])
    expect(h.filtriIn).toContainEqual({ tabella: 'crm_bambini', colonna: 'scuola_id', valori: [SEDE_B] })
  })

  it('le sedi spuntate nel selettore (cookie) restringono l’elenco senza bisogno di ?scuolaId', async () => {
    h.ruolo = 'admin'
    h.db.utenti_scuole = [
      { utente_id: USER, scuola_id: SEDE_A },
      { utente_id: USER, scuola_id: SEDE_B },
    ]
    const corpo = (await (await get('', `sedi_attive=${SEDE_B}`)).json()) as { data: Voce[] }
    expect(ids(corpo)).toEqual([B_SEDE_B])
  })

  it('nessuna quota in attesa: elenco vuoto, 200', async () => {
    h.db.crm_bambini = [bambino(B_SENZA_QUOTA, SEDE_A, SCHEDA_A)]
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [] })
  })
})

describe('GET /api/admin/crm/quote · chi può chiederla, e per quale sede', () => {
  it('?scuolaId di un’altra sede: 403 SEDE_NON_ACCESSIBILE, e il database non si legge', async () => {
    const res = await get(`?scuolaId=${SEDE_B}`)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { codice?: string }).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.letture).not.toContain('crm_bambini')
  })

  it('?scuolaId in maiuscolo sulla propria sede non è un rifiuto', async () => {
    const res = await get(`?scuolaId=${SEDE_A.toUpperCase()}`)
    expect(res.status).toBe(200)
    expect(h.filtriIn).toContainEqual({ tabella: 'crm_bambini', colonna: 'scuola_id', valori: [SEDE_A] })
  })

  it('docente: 403 dal gate del CRM, e il database non si legge', async () => {
    h.ruolo = 'educator'
    const res = await get()
    expect(res.status).toBe(403)
    expect(h.letture).toEqual([])
  })

  it('?scuolaId che non è un uuid: 400, e il database non si legge', async () => {
    const res = await get('?scuolaId=non-un-uuid')
    expect(res.status).toBe(400)
    expect(h.letture).toEqual([])
  })

  it('l’utente senza nessuna sede riceve l’elenco vuoto, non un errore e non le righe di tutti', async () => {
    h.sedePropria = null
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [] })
    expect(h.letture).not.toContain('crm_bambini')
  })
})

describe('GET /api/admin/crm/quote · quando il database non c’è o si guasta', () => {
  it('tabelle assenti (PGRST205): 503 CRM_NON_INSTALLATO', async () => {
    h.errori = { crm_bambini: { code: 'PGRST205', message: 'Could not find the table' } }
    const res = await get()
    expect(res.status).toBe(503)
    expect(((await res.json()) as { codice?: string }).codice).toBe('CRM_NON_INSTALLATO')
  })

  it.each(['42P01', '42703', 'PGRST204', 'PGRST202', '42883'])(
    'schema del CRM incompleto (%s): 503 CRM_NON_INSTALLATO, non 500',
    async (code) => {
      h.errori = { crm_bambini: { code, message: 'schema' } }
      const res = await get()
      expect(res.status).toBe(503)
      expect(((await res.json()) as { codice?: string }).codice).toBe('CRM_NON_INSTALLATO')
    },
  )

  it('un guasto vero: 500 CRM_OPERAZIONE_NON_RIUSCITA, con il log di errore e senza il testo del database', async () => {
    h.errori = { crm_bambini: { code: 'XX000', message: 'relation crm_bambini colonna segreta' } }
    const res = await get()
    expect(res.status).toBe(500)
    const corpo = (await res.json()) as { codice?: string }
    expect(corpo.codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(corpo)).not.toContain('segreta')
    expect(h.logErrore).toHaveBeenCalled()
  })
})

describe('GET /api/admin/crm/quote · i giorni di attesa', () => {
  it('si contano sul giorno civile di Roma: alle 23:30 UTC del 31/10 a Roma è già il 1/11', async () => {
    vi.setSystemTime(new Date('2026-10-31T23:30:00.000Z'))
    h.db.crm_bambini = [
      bambino(B_ATTESA, SEDE_A, SCHEDA_A, { quota_stato: 'in_attesa', quota_importo: 150, quota_metodo: 'contanti', quota_anno: 2027, quota_saldata_il: '2026-10-30' }),
      bambino(B_ATTESA_COLLEGATO, SEDE_A, SCHEDA_A, { quota_stato: 'in_attesa', quota_importo: 150, quota_metodo: 'contanti', quota_anno: 2027, quota_saldata_il: '2026-11-01' }),
    ]
    const corpo = (await (await get()).json()) as { data: Voce[] }
    const per = (id: string) => corpo.data.find((v) => v.bambinoId === id)
    // Dal 30/10 al 1/11 sono DUE giorni (in UTC, dove è ancora il 31, sarebbe uno).
    expect(per(B_ATTESA)?.giorniAttesa).toBe(2)
    // Pagata «oggi» (il 1/11 di Roma): zero giorni di attesa.
    expect(per(B_ATTESA_COLLEGATO)?.giorniAttesa).toBe(0)
  })

  it('attraversa il cambio dell’ora legale (25/10/2026) senza perdere o regalare un giorno', async () => {
    vi.setSystemTime(new Date('2026-10-26T09:00:00.000Z'))
    h.db.crm_bambini = [
      bambino(B_ATTESA, SEDE_A, SCHEDA_A, { quota_stato: 'in_attesa', quota_importo: 150, quota_metodo: 'contanti', quota_anno: 2027, quota_saldata_il: '2026-10-24' }),
    ]
    const corpo = (await (await get()).json()) as { data: Voce[] }
    expect(corpo.data[0].giorniAttesa).toBe(2)
  })

  it('giorniDiAttesa: senza giorno è nullo; un giorno che sembra nel futuro non diventa negativo', () => {
    expect(giorniDiAttesa(null, '2026-10-31')).toBeNull()
    expect(giorniDiAttesa('', '2026-10-31')).toBeNull()
    expect(giorniDiAttesa('non-una-data', '2026-10-31')).toBeNull()
    expect(giorniDiAttesa('2026-10-31', '2026-10-31')).toBe(0)
    expect(giorniDiAttesa('2026-11-05', '2026-10-31')).toBe(0)
    expect(giorniDiAttesa('2026-03-01', '2026-10-31')).toBe(244)
  })
})

describe('GET /api/admin/crm/quote · nei log solo uuid e conteggi', () => {
  it('una lettura riuscita lascia una riga con i conteggi, e nessun nome di bambino', async () => {
    await get()
    const righe = logCrm().filter((r) => r.campi.operazione === 'admin/crm/quote:GET')
    expect(righe).toHaveLength(1)
    expect(righe[0].livello).toBe('info')
    expect(righe[0].campi).toMatchObject({ esito: 'quote-in-attesa-lette', totale: 4, bloccate: 1 })
    const tutto = JSON.stringify([...h.logEvento.mock.calls, ...h.logErrore.mock.calls])
    expect(tutto).not.toContain('Bimbo Prova')
  })

  it('un elenco che tocca il tetto di lettura lascia un avviso: non si tronca in silenzio', async () => {
    h.db.crm_bambini = Array.from({ length: 1000 }, (_, i) =>
      bambino(`50000000-0000-4000-8000-${String(i).padStart(12, '0')}`, SEDE_A, SCHEDA_A, {
        quota_stato: 'senza_importo',
      }),
    )
    const res = await get()
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: Voce[] }).data).toHaveLength(1000)
    expect(logCrm().some((r) => r.livello === 'warn' && r.campi.esito === 'quote-elenco-al-tetto')).toBe(true)
  })
})
