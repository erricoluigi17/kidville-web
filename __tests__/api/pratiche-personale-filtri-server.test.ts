import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// I FILTRI DELLE PRATICHE DEL PERSONALE VIVONO SUL SERVER.
//
// 55 pratiche e un `limit` predefinito di 50: la pagina 2 esiste già oggi, e un
// filtro applicato nel browser conterebbe le 50 caricate ignorando le altre.
// Il numero è piccolo e cresce piano — il che rende il difetto PEGGIORE, non
// migliore: nessuno lo vedrebbe mai, e quando lo si vedesse sarebbe passato un
// anno di conteggi sbagliati.
//
// ⚠️ IL FILTRO CHE CONTA DI PIÙ È LA SCADENZA DEL DOCUMENTO, ed è quello che si
// può sbagliare senza accorgersene: i suoi confini si contano dal GIORNO CIVILE
// italiano (`dataCivile()`), non da `new Date().toISOString()`. Fra le 00:00 e
// le 02:00 il server è al giorno prima, e «scaduto ieri» diventa «scade oggi».
// =============================================================================

const SEDE = '11111111-1111-4111-8111-111111111111'
const ALTRA_SEDE = '22222222-2222-4222-8222-222222222222'
/** «Oggi», congelato: la scadenza si conta da qui, e da nient'altro. */
const OGGI = '2026-09-01'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  righe: [] as Record<string, unknown>[],
  ors: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/scuole/reali', () => ({ nomeSede: async () => 'Kidville Alfa', sediReali: async () => [] }))
vi.mock('@/lib/email/send', () => ({ sendEmailDetailed: async () => ({ ok: true, error: null }) }))
vi.mock('@/lib/email/contesto', () => ({ risolviContestoSede: async () => ({}) }))
vi.mock('@/lib/auth/staff-identity', () => ({ ensureStaffIdentity: vi.fn() }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE, ALTRA_SEDE],
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    from(tabella: string) {
      const condizioni: ((r: Record<string, unknown>) => boolean)[] = []
      let contaEsatto = false
      let colonne: string[] = []
      let da = 0
      let a = Number.POSITIVE_INFINITY
      const b: Record<string, unknown> = {}

      const testo = (v: unknown) => (typeof v === 'string' ? v : '')
      const ordinabile = (v: unknown) => v !== null && v !== undefined && v !== ''

      b.select = (c?: string, opts?: unknown) => {
        if ((opts as { count?: string })?.count === 'exact') contaEsatto = true
        colonne = (c ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '')
        return b
      }
      b.eq = (col: string, val: unknown) => { condizioni.push((r) => r[col] === val); return b }
      b.in = (col: string, vals: unknown[]) => { condizioni.push((r) => vals.includes(r[col])); return b }
      b.gte = (col: string, val: string) => {
        condizioni.push((r) => ordinabile(r[col]) && testo(r[col]) >= val)
        return b
      }
      b.lte = (col: string, val: string) => {
        condizioni.push((r) => ordinabile(r[col]) && testo(r[col]) <= val)
        return b
      }
      b.lt = (col: string, val: string) => {
        condizioni.push((r) => ordinabile(r[col]) && testo(r[col]) < val)
        return b
      }
      b.gt = (col: string, val: string) => {
        condizioni.push((r) => ordinabile(r[col]) && testo(r[col]) > val)
        return b
      }
      b.ilike = (col: string, pattern: string) => {
        const nucleo = pattern.replace(/^%|%$/g, '').toLowerCase()
        condizioni.push((r) => testo(r[col]).toLowerCase().includes(nucleo))
        return b
      }
      b.contains = (col: string, vals: unknown[]) => {
        condizioni.push((r) => Array.isArray(r[col]) && vals.every((x) => (r[col] as unknown[]).includes(x)))
        return b
      }
      b.or = (espressione: string) => {
        h.ors.push(espressione)
        const pezzi = espressione.split(',').map((p) => {
          const m = /^(.+?)\.ilike\.%(.*)%$/.exec(p)
          return m ? { col: m[1], nucleo: m[2].toLowerCase() } : null
        })
        condizioni.push((r) => pezzi.some((p) => p !== null && testo(r[p.col]).toLowerCase().includes(p.nucleo)))
        return b
      }
      b.order = () => b
      b.range = (x: number, y: number) => { da = x; a = y; return b }

      const filtrate = () =>
        tabella === 'pratiche_personale' ? h.righe.filter((r) => condizioni.every((c) => c(r))) : []
      const proietta = (r: Record<string, unknown>) => {
        if (colonne.length === 0) return r
        const fuori: Record<string, unknown> = {}
        for (const c of colonne) if (c in r) fuori[c] = r[c]
        return fuori
      }
      const lista = () => {
        const righe = filtrate()
        const fine = Number.isFinite(a) ? a + 1 : righe.length
        return {
          data: righe.slice(da, fine).map(proietta),
          error: null,
          count: contaEsatto ? righe.length : null,
        }
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(lista()).then(res)
      b.maybeSingle = async () => ({ data: filtrate()[0] ?? null, error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/pratiche-personale/route'

const chiedi = (qs = '') =>
  GET(new Request(`http://localhost/api/admin/pratiche-personale${qs}`) as never)

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

interface Finta {
  i: number
  sede?: string
  stato?: string
  scadenza?: string | null
  documento?: string
  nome?: string
  cognome?: string
  email?: string
  gradi?: string[]
  citta?: string
  provincia?: string
  titolo?: string
  creata?: string
}

function pratica(f: Finta): Record<string, unknown> {
  return {
    id: uuid(f.i),
    scuola_id: f.sede ?? SEDE,
    stato: f.stato ?? 'pending',
    nome: f.nome ?? `Nome${f.i}`,
    cognome: f.cognome ?? `Cognome${f.i}`,
    email: f.email ?? `p${f.i}@example.invalid`,
    document_type: f.documento ?? 'CI',
    document_expiry: f.scadenza === undefined ? '2030-01-01' : f.scadenza,
    gradi: f.gradi ?? ['infanzia'],
    residence_city: f.citta ?? 'Aversa',
    residence_province: f.provincia ?? 'CE',
    titolo_studio: f.titolo ?? 'diploma',
    creata_il: f.creata ?? '2026-08-20T10:00:00.000Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  // Le 00:30 ITALIANE del 1° settembre: a Greenwich è ancora il 31 agosto. È il
  // caso in cui un confine calcolato in UTC sbaglia giorno — e l'unico modo di
  // provare che non succede è mettercisi dentro.
  vi.setSystemTime(new Date('2026-08-31T22:30:00.000Z'))
  h.righe = []
  h.ors = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
})

async function elenco(qs: string) {
  const res = await chiedi(qs)
  const json = (await res.json()) as { data?: Record<string, unknown>[]; total?: number }
  return { res, json }
}

describe('GET /api/admin/pratiche-personale — la SCADENZA del documento', () => {
  it('«scaduto» è ieri o prima, contato sul giorno civile ITALIANO', async () => {
    h.righe = [
      pratica({ i: 1, scadenza: '2026-08-31' }), // ieri  → scaduto
      pratica({ i: 2, scadenza: OGGI }), // oggi  → NON scaduto
      pratica({ i: 3, scadenza: '2026-09-02' }), // domani → NON scaduto
      // Nessuna scadenza in tabella: non è «scaduto», è «non lo so». Resta fuori
      // da tutti e quattro i rami, ed è la risposta onesta.
      pratica({ i: 4, scadenza: null }),
    ]
    const { json } = await elenco('?scadenza=scaduto')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])
    expect(json.total).toBe(1)
  })

  it('«entro 30 giorni» comprende oggi e il trentesimo giorno, non il trentunesimo', async () => {
    h.righe = [
      pratica({ i: 1, scadenza: '2026-08-31' }), // già scaduto
      pratica({ i: 2, scadenza: OGGI }), // oggi
      pratica({ i: 3, scadenza: '2026-10-01' }), // +30
      pratica({ i: 4, scadenza: '2026-10-02' }), // +31
    ]
    const { json } = await elenco('?scadenza=entro30')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(2), uuid(3)])
  })

  it('«entro 90 giorni» comprende i 30: è una finestra più larga, non un\'altra finestra', async () => {
    h.righe = [
      pratica({ i: 2, scadenza: '2026-09-15' }), // dentro i 30
      pratica({ i: 3, scadenza: '2026-11-30' }), // +90
      pratica({ i: 4, scadenza: '2026-12-01' }), // +91
    ]
    const { json } = await elenco('?scadenza=entro90')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(2), uuid(3)])
  })

  it('«valido» è tutto ciò che NON è scaduto, e non tocca chi la scadenza non ce l\'ha', async () => {
    h.righe = [
      pratica({ i: 1, scadenza: '2026-08-31' }),
      pratica({ i: 2, scadenza: OGGI }),
      pratica({ i: 3, scadenza: '2030-01-01' }),
      pratica({ i: 4, scadenza: null }),
    ]
    const { json } = await elenco('?scadenza=valido')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(2), uuid(3)])
  })
})

describe('GET /api/admin/pratiche-personale — gli altri filtri', () => {
  it('`?stato=` e «solo da evadere» colpiscono l\'indice `(stato, creata_il desc)`', async () => {
    h.righe = [
      pratica({ i: 1, stato: 'pending' }),
      pratica({ i: 2, stato: 'in_approvazione' }),
      pratica({ i: 3, stato: 'approvata' }),
      pratica({ i: 4, stato: 'rifiutata' }),
    ]
    expect((await elenco('?stato=approvata')).json.data?.map((r) => r.id)).toEqual([uuid(3)])
    expect((await elenco('?daEvadere=1')).json.data?.map((r) => r.id)).toEqual([uuid(1), uuid(2)])
  })

  it('`?tipo_documento=PP` tiene solo i passaporti', async () => {
    h.righe = [pratica({ i: 1, documento: 'PP' }), pratica({ i: 2, documento: 'CI' })]
    expect((await elenco('?tipo_documento=PP')).json.data?.map((r) => r.id)).toEqual([uuid(1)])
  })

  it('`?grado=`, `?provincia=`, `?citta=`, `?titolo=` filtrano senza entrare nel payload', async () => {
    h.righe = [
      pratica({ i: 1, gradi: ['nido', 'infanzia'], provincia: 'NA', citta: 'Giugliano', titolo: 'magistrale' }),
      pratica({ i: 2, gradi: ['primaria'], provincia: 'CE', citta: 'Aversa', titolo: 'diploma' }),
    ]
    expect((await elenco('?grado=nido')).json.data?.map((r) => r.id)).toEqual([uuid(1)])
    expect((await elenco('?provincia=CE')).json.data?.map((r) => r.id)).toEqual([uuid(2)])
    expect((await elenco('?citta=giugl')).json.data?.map((r) => r.id)).toEqual([uuid(1)])
    expect((await elenco('?titolo=diploma')).json.data?.map((r) => r.id)).toEqual([uuid(2)])

    // Una pratica contiene codice fiscale, residenza, estremi del documento e il
    // recapito di un TERZO: l'elenco resta povero anche quando si filtra su
    // quelle colonne.
    const corpo = await (await chiedi('?provincia=CE')).text()
    for (const fuori of ['residence_city', 'residence_province', 'titolo_studio', 'fiscal_code', 'email']) {
      expect(corpo).not.toContain(fuori)
    }
  })

  it('`?q=` cerca su nome, cognome ed email; vuota non diventa un `.or()`', async () => {
    h.righe = [
      pratica({ i: 1, nome: 'Anna', cognome: 'Verdi', email: 'anna@example.invalid' }),
      pratica({ i: 2, nome: 'Bruno', cognome: 'Bianchi', email: 'bruno@example.invalid' }),
    ]
    expect((await elenco('?q=bianchi')).json.data?.map((r) => r.id)).toEqual([uuid(2)])
    expect(h.ors[0]).toBe(
      'nome.ilike.%bianchi%,cognome.ilike.%bianchi%,email.ilike.%bianchi%,residence_city.ilike.%bianchi%',
    )

    h.ors = []
    expect((await elenco('?q=%25%2C()')).json.data).toHaveLength(2)
    expect(h.ors).toHaveLength(0)
  })

  it('il periodo su `creata_il` usa i confini del giorno civile italiano', async () => {
    h.righe = [
      pratica({ i: 1, creata: '2026-08-31T23:00:00.000Z' }), // 1/9 all'01:00 a Roma
      pratica({ i: 2, creata: '2026-08-31T21:00:00.000Z' }), // 31/8 alle 23:00 a Roma
    ]
    const { json } = await elenco('?creataDa=2026-09-01&creataA=2026-09-01')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])
  })
})

describe('GET /api/admin/pratiche-personale — la sede chiesta RESTRINGE', () => {
  it('`?scuola_id=` di una sede attiva tiene solo quella; una sede altrui è 403', async () => {
    h.righe = [pratica({ i: 1, sede: SEDE }), pratica({ i: 2, sede: ALTRA_SEDE })]
    expect((await elenco(`?scuola_id=${ALTRA_SEDE}`)).json.data?.map((r) => r.id)).toEqual([uuid(2)])

    const res = await chiedi('?scuola_id=33333333-3333-4333-8333-333333333333')
    expect(res.status).toBe(403)
    expect(((await res.json()) as { codice?: string }).codice).toBe('SEDE_NON_ACCESSIBILE')
  })
})

describe('GET /api/admin/pratiche-personale — filtro e paginazione insieme', () => {
  it('`total` è il conteggio FILTRATO e l\'offset cammina dentro quello', async () => {
    h.righe = [
      ...Array.from({ length: 12 }, (_, i) => pratica({ i, stato: 'approvata' })),
      ...Array.from({ length: 43 }, (_, i) => pratica({ i: 100 + i, stato: 'pending' })),
    ]
    const p1 = await elenco('?stato=approvata&limit=10&offset=0')
    const p2 = await elenco('?stato=approvata&limit=10&offset=10')
    expect(p1.json.total).toBe(12)
    expect(p1.json.data).toHaveLength(10)
    expect(p2.json.data).toHaveLength(2)
  })
})
